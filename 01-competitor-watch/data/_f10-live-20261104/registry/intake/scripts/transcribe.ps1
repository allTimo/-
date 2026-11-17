#Requires -Version 5.1
<#
.SYNOPSIS
    Расшифровка аудио/видео из registry/intake/inbox/audio в текст.

.DESCRIPTION
    ИТОГ РАЗВЕДКИ ЛОКАЛЬНОГО ДВИЖКА (проверено запуском, см. -Check):
      * DSH действительно содержит локальный движок речи: sherpa-onnx + SenseVoiceSmall ONNX
        и Silero VAD, модели уже скачаны в %USERPROFILE%\.dsh\speech-to-text\sensevoice\models.
      * Но это НЕ CLI для файла: пакеты @deepseek-ai/...-speech-to-text* не имеют bin-записи,
        движок работает как host-воркер приложения и принимает записи только из браузера
        (voice-input bundle) через внутренний loopback-протокол.
      * Главное: движок принимает языки auto, zh, en, yue, ja, ko. РУССКОГО в списке нет,
        поэтому для русских встреч локальная расшифровка DSH не подходит даже теоретически.
      * Других локальных движков на машине нет: Windows Speech recognizers не установлены
        (count = 0), среди 29 python-пакетов рантайма нет ни sherpa, ни vosk, ни whisper, ffmpeg отсутствует.

    Поэтому скрипт работает по честной схеме:
      1) если расшифровка уже есть (inbox\text\<имя>.txt или inbox\text\<имя>.voice.txt,
         либо .txt рядом с аудио) — она используется, аудио не трогаем;
      2) иначе вызывается ВНЕШНИЙ ASR, заданный параметром -Command или переменной
         окружения CW_ASR_COMMAND: команда получает путь к аудио и печатает текст в stdout
         (шаблон: whisper-cli --model ... --file {file} --output-txt --print). Так пользователь
         может подключить любой установленный у него движок, включая русский;
      3) иначе создаётся <имя>.pending.md с объяснением и инструкцией, файл аудио остаётся
         на месте; в отчёте он честно считается «не расшифрован».

.PARAMETER Check
    Показать результат разведки движка (что найдено на этой машине) и выйти.

.PARAMETER Command
    Команда внешнего ASR. Если содержит {file} — подставляется путь к аудио, иначе путь
    добавляется последним аргументом.

.PARAMETER Strict
    Ненулевой код возврата, если остались нерасшифрованные файлы (по умолчанию это не ошибка).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File transcribe.ps1 -Check
.EXAMPLE
    .\transcribe.ps1 -Command 'whisper-cli --model ggml-medium.bin --output-txt --print {file}'
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [string]$Command,
    [string]$AudioDir,
    [string]$TextDir,
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$IntakeDir = Split-Path -Parent $ScriptDir
if (-not $AudioDir) { $AudioDir = Join-Path $IntakeDir 'inbox\audio' }
if (-not $TextDir) { $TextDir = Join-Path $IntakeDir 'inbox\text' }
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$AudioExtensions = @('.wav', '.mp3', '.m4a', '.ogg', '.opus', '.aac', '.flac', '.wma', '.mp4', '.mkv', '.webm', '.mov')

function Get-EngineFacts {
    $facts = [ordered]@{}
    $modelDir = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice\models'
    $onnx = Join-Path $modelDir 'sensevoice-onnx\model.int8.onnx'
    $tokens = Join-Path $modelDir 'sensevoice-onnx\tokens.txt'
    $vad = Join-Path $modelDir 'silero\silero_vad.onnx'
    $facts['Модель SenseVoice на диске'] = (Test-Path $onnx)
    $facts['tokens.txt на диске'] = (Test-Path $tokens)
    $facts['Silero VAD на диске'] = (Test-Path $vad)
    $facts['Языки движка DSH'] = 'auto, zh, en, yue, ja, ko (русского нет)'
    $facts['CLI для файла у движка DSH'] = 'нет (только host-воркер приложения)'
    try {
        Add-Type -AssemblyName System.Speech -ErrorAction Stop
        $count = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers().Count
    } catch { $count = -1 }
    $facts['Windows Speech recognizers'] = $count
    $facts['Внешний ASR задан'] = [bool]($Command -or $env:CW_ASR_COMMAND)
    return $facts
}

if ($Check) {
    Write-Host '=== Разведка локального движка речи ===' -ForegroundColor Cyan
    foreach ($item in (Get-EngineFacts).GetEnumerator()) {
        Write-Host ('  {0}: {1}' -f $item.Key, $item.Value)
    }
    Write-Host ''
    Write-Host 'Вывод: локальная расшифровка русских файлов на этой машине недоступна.'
    Write-Host 'Рабочие пути: расшифровка средствами Телемоста -> inbox\text, либо внешний ASR через -Command/CW_ASR_COMMAND.'
    exit 0
}

if (-not (Test-Path -LiteralPath $AudioDir)) {
    Write-Host "Каталог аудио не найден: $AudioDir — создаю."
    New-Item -ItemType Directory -Force -Path $AudioDir | Out-Null
}
if (-not (Test-Path -LiteralPath $TextDir)) { New-Item -ItemType Directory -Force -Path $TextDir | Out-Null }

if (-not $Command) { $Command = $env:CW_ASR_COMMAND }

$audioFiles = @(Get-ChildItem -LiteralPath $AudioDir -File -ErrorAction SilentlyContinue |
    Where-Object { $AudioExtensions -contains $_.Extension.ToLower() })

Write-Host "Аудиофайлов в inbox\audio: $($audioFiles.Count)"
$transcribed = 0
$reused = 0
$pending = @()
$failed = @()

foreach ($file in $audioFiles) {
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $ourText = Join-Path $TextDir ($stem + '.voice.txt')
    $userText = Join-Path $TextDir ($stem + '.txt')
    $sidecar = Join-Path $AudioDir ($stem + '.txt')

    if (Test-Path -LiteralPath $ourText) {
        Write-Host "  [уже есть] $($file.Name) -> $ourText"
        $reused++
        continue
    }
    if (Test-Path -LiteralPath $userText) {
        Write-Host "  [готовая расшифровка] $($file.Name) -> $userText"
        $reused++
        continue
    }
    if (Test-Path -LiteralPath $sidecar) {
        Copy-Item -LiteralPath $sidecar -Destination $ourText -Force
        Write-Host "  [взял .txt рядом с аудио] $($file.Name) -> $ourText"
        $reused++
        continue
    }

    if ($Command) {
        Write-Host "  [внешний ASR] $($file.Name)"
        $arguments = @()
        if ($Command.Contains('{file}')) {
            $line = $Command.Replace('{file}', '"' + $file.FullName + '"')
        } else {
            $line = $Command + ' "' + $file.FullName + '"'
        }
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            # Путь к программе может быть в кавычках ("C:...python.exe"), а строка,
            # начинающаяся с кавычки, для PowerShell — выражение, а не команда. Поэтому
            # гарантируем оператор вызова & (если пользователь не написал его сам).
            $expression = $line
            if (-not $expression.TrimStart().StartsWith('&')) { $expression = '& ' + $expression }
            $output = Invoke-Expression $expression 2>&1 | Out-String
            $code = $LASTEXITCODE
            if ($null -eq $code) { $code = 0 }
        } finally {
            $ErrorActionPreference = $previous
        }
        if ($code -ne 0 -or -not $output.Trim()) {
            Write-Warning "  ASR вернул код $code и пустой текст для $($file.Name)"
            $failed += $file.Name
            continue
        }
        Set-Content -LiteralPath $ourText -Value $output.Trim() -Encoding utf8
        Write-Host "  [готово] $ourText"
        $transcribed++
        continue
    }

    $pendingPath = Join-Path $AudioDir ($stem + '.pending.md')
    $note = @(
        '# Расшифровка не выполнена автоматически',
        '',
        "Файл: $($file.Name)",
        '',
        'Почему: на этой машине нет локального движка для русского аудио. DSH-движок SenseVoice',
        'поддерживает только auto/zh/en/yue/ja/ko и не имеет CLI для файла; Windows Speech',
        'recognizers не установлены; python ASR-пакетов и ffmpeg в рантайме нет.',
        '',
        'Что сделать (любой из вариантов):',
        '1) Взять расшифровку в самом Телемосте: откройте запись встречи, скопируйте текст',
        "   и сохраните как inbox\text\$stem.voice.txt",
        '2) Подключить внешний ASR: transcribe.ps1 -Command "<ваша команда> {file}"',
        '   или переменная окружения CW_ASR_COMMAND (команда печатает текст в stdout).',
        '3) Пересказать ключевое вручную: inbox\text\' + $stem + '.txt',
        '',
        'После появления текста запустите run_intake.ps1 — задачи соберутся из него.'
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath $pendingPath -Value $note -Encoding utf8
    Write-Host "  [не расшифрован] $($file.Name) -> $pendingPath"
    $pending += $file.Name
}

Write-Host ''
Write-Host '=== Расшифровка: итог ===' -ForegroundColor Cyan
Write-Host "  всего аудио: $($audioFiles.Count)"
Write-Host "  готовая расшифровка использована: $reused"
Write-Host "  расшифровано внешним ASR: $transcribed"
Write-Host "  не расшифровано: $($pending.Count)"
if ($pending.Count -gt 0) {
    foreach ($name in $pending) { Write-Host "    - $name" }
    Write-Host '  Подсказка: transcribe.ps1 -Check покажет, что нашлось на этой машине; подробности в inbox\audio\<файл>.pending.md'
}
if ($failed.Count -gt 0) {
    Write-Host "  Ошибки внешнего ASR: $($failed.Count)" -ForegroundColor Red
    foreach ($name in $failed) { Write-Host "    - $name" }
    exit 1
}
if ($Strict -and $pending.Count -gt 0) { exit 1 }
exit 0
