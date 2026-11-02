<#
.SYNOPSIS
  Автозапуск «Центра управления агентами» (по желанию).

.DESCRIPTION
  Ставит ярлык на запуск дашборда: в папку «Автозагрузка» (поднимается при входе
  в Windows) и/или на Рабочий стол. Ярлык указывает на «Открыть дашборд.cmd».

  Ничего не устанавливается само: без ключей скрипт только показывает состояние.

  ВАЖНО: -Install меняет автозагрузку пользователя. Запускайте осознанно.

.PARAMETER Install
  Поставить ярлыки (Автозагрузка + Рабочий стол).

.PARAMETER Remove
  Убрать ярлыки.

.PARAMETER Status
  Показать текущее состояние (по умолчанию, если не указан ни один ключ).

.PARAMETER DryRun
  Показать, что было бы сделано, и ничего не менять. Работает вместе с -Install/-Remove.

.PARAMETER StartupOnly
  Только Автозагрузка (без Рабочего стола).

.PARAMETER DesktopOnly
  Только Рабочий стол (без Автозагрузки).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File marketing-agents\install\dashboard-autostart.ps1 -Status

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File marketing-agents\install\dashboard-autostart.ps1 -Install -DryRun
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [switch]$DryRun,
  [switch]$StartupOnly,
  [switch]$DesktopOnly
)

$ErrorActionPreference = 'Stop'

$InstallDir   = $PSScriptRoot
$ProjectDir   = Split-Path $InstallDir -Parent
$DashboardDir = Join-Path $ProjectDir 'dashboard'
$Launcher     = Join-Path $DashboardDir 'Открыть дашборд.cmd'
$Standalone   = Join-Path $DashboardDir 'Дашборд.html'
$ShortcutName = 'Центр управления агентами.lnk'

$StartupDir = [Environment]::GetFolderPath('Startup')
$DesktopDir = [Environment]::GetFolderPath('Desktop')
$StartupLink = Join-Path $StartupDir $ShortcutName
$DesktopLink = Join-Path $DesktopDir $ShortcutName

function Write-Head($text) {
  Write-Host ''
  Write-Host ('  ' + $text) -ForegroundColor Cyan
  Write-Host ('  ' + ('-' * $text.Length)) -ForegroundColor DarkGray
}
function Write-Item($label, $value, $color) {
  if (-not $color) { $color = 'Gray' }
  Write-Host ('    ' + $label.PadRight(26) + ' ') -NoNewline -ForegroundColor DarkGray
  Write-Host $value -ForegroundColor $color
}
function Test-Server {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:8787/api/health'
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
function Get-ShortcutInfo($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $info = [ordered]@{ Path = $path; Target = $null; Exists = $true }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($path)
    $info.Target = $lnk.TargetPath
    $info.Arguments = $lnk.Arguments
    $info.WorkingDirectory = $lnk.WorkingDirectory
  } catch {
    $info.Target = '(не удалось прочитать ярлык: ' + $_.Exception.Message + ')'
  }
  return $info
}

function Show-Status {
  Write-Head 'Автозапуск дашборда — состояние'
  Write-Item 'Папка дашборда' $DashboardDir
  Write-Item 'Лаунчер' $(if (Test-Path -LiteralPath $Launcher) { 'есть' } else { 'НЕ НАЙДЕН' }) $(if (Test-Path -LiteralPath $Launcher) { 'Green' } else { 'Red' })
  Write-Item 'Автономная копия' $(if (Test-Path -LiteralPath $Standalone) { 'есть' } else { 'нет (необязательно)' }) $(if (Test-Path -LiteralPath $Standalone) { 'Green' } else { 'DarkGray' })

  Write-Host ''
  Write-Item 'Автозагрузка (папка)' $StartupDir
  $s = Get-ShortcutInfo $StartupLink
  if ($s) { Write-Item '  ярлык' 'ЕСТЬ' 'Green'; Write-Item '  ведёт на' ([string]$s.Target) }
  else { Write-Item '  ярлык' 'нет' 'DarkGray' }

  Write-Item 'Рабочий стол (папка)' $DesktopDir
  $d = Get-ShortcutInfo $DesktopLink
  if ($d) { Write-Item '  ярлык' 'ЕСТЬ' 'Green'; Write-Item '  ведёт на' ([string]$d.Target) }
  else { Write-Item '  ярлык' 'нет' 'DarkGray' }

  Write-Host ''
  $up = Test-Server
  Write-Item 'Сервер на 127.0.0.1:8787' $(if ($up) { 'работает' } else { 'не запущен' }) $(if ($up) { 'Green' } else { 'DarkGray' })

  Write-Host ''
  if ($s -or $d) {
    Write-Host '  Автозапуск включён. Убрать: -Remove' -ForegroundColor DarkGray
  } else {
    Write-Host '  Автозапуск выключен (это нормально). Включить: -Install' -ForegroundColor DarkGray
  }
  Write-Host '  Проверка без изменений: -Install -DryRun' -ForegroundColor DarkGray
  Write-Host ''
}

function New-DashboardShortcut($linkPath, $what) {
  if ($DryRun) {
    Write-Item ('[DryRun] ' + $what) ('создал бы ярлык: ' + $linkPath) 'Yellow'
    Write-Item '  цель' $Launcher
    return
  }
  $parent = Split-Path $linkPath -Parent
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($linkPath)
  $lnk.TargetPath = $Launcher
  $lnk.WorkingDirectory = $DashboardDir
  $lnk.Description = 'Центр управления агентами — локальный дашборд'
  $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,21"
  $lnk.Save()
  Write-Item ($what) ('ярлык создан: ' + $linkPath) 'Green'
}

function Remove-DashboardShortcut($linkPath, $what) {
  if (-not (Test-Path -LiteralPath $linkPath)) {
    Write-Item ($what) 'ярлыка нет — нечего удалять' 'DarkGray'
    return
  }
  if ($DryRun) {
    Write-Item ('[DryRun] ' + $what) ('удалил бы ярлык: ' + $linkPath) 'Yellow'
    return
  }
  Remove-Item -LiteralPath $linkPath -Force
  Write-Item ($what) ('ярлык удалён: ' + $linkPath) 'Green'
}

# --- что делаем ---
$doInstall = $Install -and -not $Remove
$doRemove  = $Remove -and -not $Install

if (-not $doInstall -and -not $doRemove) { $Status = $true }

if ($Status) {
  Show-Status
  exit 0
}

if (-not (Test-Path -LiteralPath $Launcher)) {
  Write-Host ''
  Write-Host ('  ОШИБКА: не найден лаунчер ' + $Launcher) -ForegroundColor Red
  Write-Host '  Проверьте, что папка marketing-agents\dashboard на месте.' -ForegroundColor Red
  Write-Host ''
  exit 1
}

if ($doInstall) {
  Write-Head $(if ($DryRun) { 'Установка автозапуска (пробный прогон)' } else { 'Установка автозапуска' })
  if (-not $StartupOnly) { New-DashboardShortcut $DesktopLink 'Рабочий стол' }
  if (-not $DesktopOnly) { New-DashboardShortcut $StartupLink 'Автозагрузка' }
  Write-Host ''
  if ($DryRun) {
    Write-Host '  Это был пробный прогон: ничего не изменено.' -ForegroundColor Yellow
    Write-Host '  Чтобы поставить по-настоящему, уберите -DryRun.' -ForegroundColor Yellow
  } else {
    Write-Host '  Готово. Дашборд будет запускаться при входе в Windows.' -ForegroundColor Green
    Write-Host '  Убрать: dashboard-autostart.ps1 -Remove' -ForegroundColor DarkGray
  }
  Write-Host ''
  exit 0
}

if ($doRemove) {
  Write-Head $(if ($DryRun) { 'Удаление автозапуска (пробный прогон)' } else { 'Удаление автозапуска' })
  Remove-DashboardShortcut $DesktopLink 'Рабочий стол'
  Remove-DashboardShortcut $StartupLink 'Автозагрузка'
  Write-Host ''
  if ($DryRun) { Write-Host '  Это был пробный прогон: ничего не изменено.' -ForegroundColor Yellow }
  else { Write-Host '  Готово. Автозапуск выключен.' -ForegroundColor Green }
  Write-Host ''
  exit 0
}