#Requires -Version 5.1
<#
.SYNOPSIS
    Одна команда: обработать всё входящее из registry\intake\inbox и собрать задачи.

.DESCRIPTION
    Цикл: inbox\audio -> расшифровка -> inbox\text -> text_to_tasks.py -> registry\tasks\<YYYY-MM>.yaml
    и короткий отчёт в консоль: сколько файлов, сколько задач, что не удалось.

    Если локальная расшифровка невозможна (так и есть для русского на этой машине),
    скрипт не падает: он использует уже готовые расшифровки, внешний ASR (если задан)
    или честно пишет .pending.md и считает файл нерасшифрованным.

.PARAMETER Date
    Дата обработки (YYYY-MM-DD). Определяет и created, и файл месяца tasks\<YYYY-MM>.yaml.

.PARAMETER InputDir
    Каталог с текстами (по умолчанию inbox\text). Можно указать каталог тестов с фикстурой.

.PARAMETER TasksDir
    Каталог задач (по умолчанию registry\tasks).

.PARAMETER AsrCommand
    Команда внешнего ASR для аудио (см. transcribe.ps1).

.PARAMETER DryRun
    Ничего не писать в реестр, только показать, что получилось бы.

.PARAMETER NoTranscribe
    Пропустить шаг расшифровки аудио (работать только с готовыми текстами).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File run_intake.ps1 -Date 2026-10-31
#>
[CmdletBinding()]
param(
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
    [string]$InputDir,
    [string]$TasksDir,
    [string]$AsrCommand,
    [switch]$DryRun,
    [switch]$Strict,
    [switch]$NoTranscribe
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$IntakeDir = Split-Path -Parent $ScriptDir
$RegistryDir = Split-Path -Parent $IntakeDir
if (-not $InputDir) { $InputDir = Join-Path $IntakeDir 'inbox\text' }
if (-not $TasksDir) { $TasksDir = Join-Path $RegistryDir 'tasks' }
$AudioDir = Join-Path $IntakeDir 'inbox\audio'

$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

if ($env:CW_PYTHON) {
    $Py = $env:CW_PYTHON
} else {
    $Py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
}
if (-not (Test-Path -LiteralPath $Py)) {
    Write-Error "Не найден python: $Py. Укажите путь в переменной окружения CW_PYTHON."
    exit 2
}
if (-not (Test-Path -LiteralPath $InputDir)) {
    Write-Host "Каталог с текстами не найден: $InputDir — создаю."
    New-Item -ItemType Directory -Force -Path $InputDir | Out-Null
}

Write-Host ''
Write-Host '=== 1. Расшифровка аудио ===' -ForegroundColor Cyan
$audioExtensions = @('.wav', '.mp3', '.m4a', '.ogg', '.opus', '.aac', '.flac', '.wma', '.mp4', '.mkv', '.webm', '.mov')
$audioCount = @(Get-ChildItem -LiteralPath $AudioDir -File -ErrorAction SilentlyContinue |
    Where-Object { $audioExtensions -contains $_.Extension.ToLower() }).Count
if ($NoTranscribe) {
    Write-Host '  пропущено (-NoTranscribe)'
} else {
    & (Join-Path $ScriptDir 'transcribe.ps1') -AudioDir $AudioDir -Command $AsrCommand
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  расшифровка завершилась с ошибкой внешнего ASR' -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host ''
Write-Host '=== 2. Тексты -> задачи ===' -ForegroundColor Cyan
$script = Join-Path $ScriptDir 'text_to_tasks.py'
$arguments = @($script, '--input', $InputDir, '--source', 'telemost-text', '--date', $Date, '--tasks-dir', $TasksDir)
if ($DryRun) { $arguments += '--dry-run' }
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $out = & $Py @arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previous
}
Write-Host $out.Trim()
if ($code -ne 0) {
    Write-Host 'Ошибка сбора задач.' -ForegroundColor Red
    exit $code
}

$transcriptCount = @(Get-ChildItem -LiteralPath $InputDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.txt', '.md') -and $_.Name -notlike 'README*' }).Count
$pendingCount = @(Get-ChildItem -LiteralPath $AudioDir -File -Filter '*.pending.md' -ErrorAction SilentlyContinue).Count

Write-Host '=== 3. Итог ===' -ForegroundColor Cyan
Write-Host "  дата обработки: $Date"
Write-Host "  аудиофайлов в inbox\audio: $audioCount (нерасшифрованных: $pendingCount)"
Write-Host "  текстов обработано: $transcriptCount"
$created = [regex]::Match($out, 'Задач создано: (\d+)').Groups[1].Value
$skipped = [regex]::Match($out, 'Пропущено: (\d+)').Groups[1].Value
$unassigned = [regex]::Match($out, 'Требуют уточнения \(status: unassigned\): (\d+)').Groups[1].Value
Write-Host "  задач создано: $(if ($created) { $created } else { 0 })"
Write-Host "  пропущено (уже в реестре): $(if ($skipped) { $skipped } else { 0 })"
Write-Host "  требуют уточнения: $(if ($unassigned) { $unassigned } else { 0 })"
if ($DryRun) {
    Write-Host '  режим -DryRun: файлы реестра не изменялись'
} else {
    $month = $Date.Substring(0, 7)
    Write-Host "  реестр задач: $(Join-Path $TasksDir ($month + '.yaml'))"
}
if ($pendingCount -gt 0) {
    Write-Host "  ВНИМАНИЕ: $pendingCount аудиофайл(ов) без расшифровки — см. inbox\audio\*.pending.md" -ForegroundColor Yellow
    Write-Host '  Подсказка: transcribe.ps1 -Check — что нашлось на этой машине; рабочие обходы описаны в inbox\audio\*.pending.md'
}
if ($Strict -and $pendingCount -gt 0) { exit 1 }
exit 0
