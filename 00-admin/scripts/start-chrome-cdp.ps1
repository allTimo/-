<#
.SYNOPSIS
    Запускает Chrome с отладочным портом (CDP) — «рабочий» браузер для сбора данных с Циан и Авито.

.DESCRIPTION
    Скилы cian-connector и avito-connector читают площадки ИЗ ВАШЕГО Chrome по протоколу CDP
    (Chrome DevTools Protocol). Для этого Chrome нужен запущенный с отладочным портом и
    ОТДЕЛЬНЫМ каталогом профиля — чтобы не мешать вашему обычному Chrome и его закладкам.

    Скрипт:
      1) находит chrome.exe;
      2) поднимает Chrome с --remote-debugging-port и отдельным профилем;
      3) ждёт, пока http://127.0.0.1:<порт>/json/version начнёт отвечать;
      4) печатает понятный итог и что делать дальше.

    В этом окне нужно ОДИН РАЗ войти в Циан и Авито — профиль запомнит сессию.
    Обычный Chrome не трогается: у отладочного свой профиль, и при -Stop закрываются
    только процессы ЭТОГО профиля.

.PARAMETER Port
    Отладочный порт. По умолчанию 9222 — именно его ищут коннекторы.

.PARAMETER ProfileDir
    Каталог профиля отладочного Chrome. По умолчанию %USERPROFILE%\.dsh-chrome-profile.

.PARAMETER ChromePath
    Путь к chrome.exe. Если не указан — ищется в стандартных местах.

.PARAMETER Url
    Страницы, которые открыть сразу. По умолчанию — пустая вкладка.

.PARAMETER Stop
    Остановить отладочный Chrome (только процессы этого профиля) и выйти.

.PARAMETER TimeoutSec
    Сколько секунд ждать ответа CDP. По умолчанию 40.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File 00-admin\scripts\start-chrome-cdp.ps1

.EXAMPLE
    # сразу открыть Циан и Авито, чтобы войти в аккаунт
    powershell -NoProfile -ExecutionPolicy Bypass -File 00-admin\scripts\start-chrome-cdp.ps1 -Url https://www.cian.ru/,https://www.avito.ru/

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File 00-admin\scripts\start-chrome-cdp.ps1 -Stop
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh-chrome-profile"),
    [string]$ChromePath,
    [string[]]$Url = @(),
    [switch]$Stop,
    [int]$TimeoutSec = 40
)

$ErrorActionPreference = "Stop"

function Write-Ok   { param($m) Write-Host $m -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host $m -ForegroundColor Yellow }
function Write-Err2 { param($m) Write-Host $m -ForegroundColor Red }

function Test-Cdp {
    param([int]$P)
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 3 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Test-PortBusy {
    param([int]$P)
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $P)
        $c.Close()
        return $true
    } catch {
        return $false
    }
}

function Get-DebugChromeProcesses {
    param([string]$ProfilePath)
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProfilePath*" }
}

# --- 0. Каталог профиля -----------------------------------------------------
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
if (-not (Test-Path -LiteralPath $ProfileDir)) {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    Write-Host "Создан каталог профиля: $ProfileDir"
}

# --- 1. Остановка по -Stop --------------------------------------------------
if ($Stop) {
    $procs = @(Get-DebugChromeProcesses -ProfilePath $ProfileDir)
    if ($procs.Count -eq 0) {
        Write-Warn2 "Отладочный Chrome с профилем $ProfileDir не запущен — останавливать нечего."
        exit 0
    }
    Write-Host "Останавливаю отладочный Chrome: процессов $($procs.Count), профиль $ProfileDir"
    foreach ($proc in $procs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    if (Test-Cdp -P $Port) {
        Write-Warn2 "Порт $Port всё ещё отвечает — возможно, это другой процесс."
        exit 0
    }
    Write-Ok "Отладочный Chrome остановлен. Ваш обычный Chrome не затронут."
    exit 0
}

# --- 2. Уже запущен? --------------------------------------------------------
$already = Test-Cdp -P $Port
if ($already) {
    Write-Ok "Chrome с отладкой уже отвечает на порту $Port — запускать заново не нужно."
    Write-Host "  Браузер:   $($already.Browser)"
    Write-Host "  Профиль:   $ProfileDir"
    Write-Host ""
    Write-Host "Дальше: убедитесь, что вы вошли в cian.ru и avito.ru в этом окне,"
    Write-Host "и попросите агента собрать данные по конкурентам."
    exit 0
}

if (Test-PortBusy -P $Port) {
    Write-Err2 "Порт $Port занят другим приложением, и это не отладочный Chrome."
    Write-Err2 "Освободите порт или запустите скрипт с другим портом: -Port 9223."
    exit 3
}

# --- 3. Ищем chrome.exe -----------------------------------------------------
if (-not $ChromePath) {
    $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
    $ChromePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath)) {
    Write-Err2 "Не найден chrome.exe. Укажите путь вручную: -ChromePath C:\путь\к\chrome.exe"
    exit 2
}
Write-Host "Chrome: $ChromePath"

# --- 4. Запуск --------------------------------------------------------------
$chromeArgs = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking"
)
if ($Url.Count -gt 0) { $chromeArgs += $Url } else { $chromeArgs += "about:blank" }

Write-Host "Запускаю Chrome с отладочным портом $Port..."
try {
    Start-Process -FilePath $ChromePath -ArgumentList $chromeArgs | Out-Null
} catch {
    Write-Err2 "Не удалось запустить Chrome: $($_.Exception.Message)"
    exit 2
}

# --- 5. Ждём CDP ------------------------------------------------------------
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$version = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $version = Test-Cdp -P $Port
    if ($version) { break }
}

if (-not $version) {
    Write-Err2 "Chrome запустился, но порт $Port не ответил за $TimeoutSec с."
    Write-Err2 "Что проверить:"
    Write-Err2 "  - Chrome уже был открыт с этим профилем — закройте его и повторите;"
    Write-Err2 "  - другой экземпляр Chrome перехватил запуск — закройте все окна Chrome и повторите;"
    Write-Err2 "  - попробуйте другой порт: -Port 9223."
    exit 4
}

Write-Ok "Готово: CDP отвечает на http://127.0.0.1:$Port/json/version"
Write-Host "  Браузер:  $($version.Browser)"
Write-Host "  Протокол: $($version.'Protocol-Version')"
Write-Host "  Профиль:  $ProfileDir"
Write-Host ""
Write-Host "Что дальше:"
Write-Host "  1) В открывшемся окне войдите в cian.ru и avito.ru (профиль запомнит сессию)."
Write-Host "  2) Попросите агента собрать данные по конкурентам — он подключится к этому порту."
Write-Host "  3) Когда закончите — закройте окно или выполните этот же скрипт с -Stop."
exit 0
