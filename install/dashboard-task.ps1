<#
.SYNOPSIS
  Надёжный запуск панели «Центр управления агентами» через Планировщик задач Windows.

.DESCRIPTION
  Панель запускается задачей планировщика, а не дочерним процессом DSH: поэтому она
  переживает перезапуск DeepSeek Harness и закрытие консоли.

  Задача «DSH Dashboard» создаётся БЕЗ триггера — запуск только по требованию
  (ярлык на Рабочем столе или этот скрипт с -Run). Триггер входа в систему
  добавляется ТОЛЬКО по явному запросу: -Logon on.

.PARAMETER Install
  Создать задачу и ярлык «Панель управления» на Рабочем столе.

.PARAMETER Remove
  Удалить задачу и ярлык.

.PARAMETER Status
  Показать состояние (по умолчанию).

.PARAMETER Run
  Поднять панель сейчас и открыть браузер.

.PARAMETER Logon
  on — добавить триггер входа в систему с паузой 20 секунд; off — убрать триггер.

.PARAMETER DryRun
  Показать, что было бы сделано, и ничего не менять.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File marketing-agents\install\dashboard-task.ps1 -Status
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [switch]$Run,
  [ValidateSet('on', 'off')][string]$Logon,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$TaskName     = 'DSH Dashboard'
$ProjectRoot  = Split-Path $PSScriptRoot -Parent
$DashboardDir = Join-Path $ProjectRoot 'dashboard'
$Serve        = Join-Path $DashboardDir 'serve.mjs'
$ShortcutName = 'Панель управления.lnk'
$DesktopDir   = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopDir $ShortcutName
$Port         = 8787
$Url          = 'http://127.0.0.1:' + $Port
$LogDir       = Join-Path $DashboardDir 'logs'
$Self         = $PSCommandPath

function Write-Head($text) {
  Write-Host ''
  Write-Host ('  ' + $text) -ForegroundColor Cyan
  Write-Host ('  ' + ('-' * $text.Length)) -ForegroundColor DarkGray
}
function Write-Item($label, $value, $color) {
  if (-not $color) { $color = 'Gray' }
  Write-Host ('    ' + $label.PadRight(24) + ' ') -NoNewline -ForegroundColor DarkGray
  Write-Host $value -ForegroundColor $color
}

function Find-Node {
  $candidates = @()
  $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $runtimes) {
    Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $candidates += (Join-Path $_.FullName 'dependencies\node\bin\node.exe')
    }
  }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

function Test-PanelPort {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ($Url + '/api/health')
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Get-TaskObject {
  try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Start-PanelDetached($node) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
  Start-Process -FilePath $node -ArgumentList @('"' + $Serve + '"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') -RedirectStandardError (Join-Path $LogDir 'server.err.log')
}

function Wait-Panel($seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PanelPort) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return (Test-PanelPort)
}

function Show-Status {
  Write-Head 'Панель управления — состояние'
  Write-Item 'Панель' (Join-Path $DashboardDir 'serve.mjs') $(if (Test-Path $Serve) { 'Gray' } else { 'Red' })
  $node = Find-Node
  Write-Item 'node.exe' $(if ($node) { $node } else { 'НЕ НАЙДЕН' }) $(if ($node) { 'Gray' } else { 'Red' })

  $task = Get-TaskObject
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Item 'Задача планировщика' ('есть: ' + $TaskName) 'Green'
    Write-Item '  состояние' ([string]$task.State)
    Write-Item '  триггеры' $(if ($task.Triggers -and $task.Triggers.Count -gt 0) { ($task.Triggers | ForEach-Object { [string]$_.CimClass.CimClassName }) -join ', ' } else { 'нет (запуск по требованию)' })
    if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1999) { Write-Item '  последний запуск' ([string]$info.LastRunTime) }
    if ($info -and $info.LastTaskResult -ne $null) { Write-Item '  код последнего запуска' ([string]$info.LastTaskResult) }
  } else {
    Write-Item 'Задача планировщика' 'нет — панель не переживёт перезапуск DSH' 'Yellow'
  }

  $sc = $null
  if (Test-Path -LiteralPath $ShortcutPath) {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $sc = $shell.CreateShortcut($ShortcutPath)
    } catch { $sc = $null }
  }
  if ($sc) {
    Write-Item 'Ярлык на Рабочем столе' ('есть: ' + $ShortcutName) 'Green'
    Write-Item '  ведёт на' ([string]$sc.TargetPath)
  } else {
    Write-Item 'Ярлык на Рабочем столе' 'нет' 'Yellow'
  }

  $up = Test-PanelPort
  Write-Item ('Порт ' + $Port) $(if ($up) { 'слушается, панель отвечает' } else { 'не отвечает' }) $(if ($up) { 'Green' } else { 'Red' })
  Write-Host ''
  Write-Host ('  Поставить: ' + $Self + ' -Install') -ForegroundColor DarkGray
  Write-Host ('  Поднять сейчас: ' + $Self + ' -Run') -ForegroundColor DarkGray
  Write-Host ('  Проверить всё: marketing-agents\install\check-dashboard.ps1') -ForegroundColor DarkGray
  Write-Host ''
}

function Install-Everything($node) {
  Write-Head $(if ($DryRun) { 'Установка (пробный прогон)' } else { 'Установка задачи и ярлыка' })
  if (-not (Test-Path $Serve)) { throw ('Не найден ' + $Serve) }
  if (-not $node) { throw 'Не найден node.exe' }

  $action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $Serve + '"') -WorkingDirectory $ProjectRoot
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited

  $trigger = $null
  if ($Logon -eq 'on') {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\' + $env:USERNAME)
    $trigger.Delay = 'PT20S'
  }

  if ($DryRun) {
    Write-Item '[DryRun] задача' ('создал бы «' + $TaskName + '»') 'Yellow'
    Write-Item '  действие' ($node + ' "' + $Serve + '"')
    Write-Item '  рабочий каталог' $ProjectRoot
    Write-Item '  триггер' $(if ($trigger) { 'вход в систему + пауза 20 с' } else { 'нет (запуск по требованию)' })
    Write-Item '[DryRun] ярлык' ('создал бы ' + $ShortcutPath) 'Yellow'
    Write-Host ''
    Write-Host '  Это был пробный прогон: ничего не изменено.' -ForegroundColor Yellow
    Write-Host ''
    return
  }

  if ($trigger) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Item 'Задача' ('создана «' + $TaskName + '» с триггером входа (+20 с)') 'Green'
  } else {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Principal $principal -Force | Out-Null
    Write-Item 'Задача' ('создана «' + $TaskName + '» без триггера (по требованию)') 'Green'
  }

  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($ShortcutPath)
  $lnk.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Self + '" -Run'
  $lnk.WorkingDirectory = $ProjectRoot
  $lnk.Description = 'Центр управления агентами — открыть панель'
  $lnk.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll,21')
  $lnk.Save()
  Write-Item 'Ярлык' ('создан: ' + $ShortcutPath) 'Green'

  Write-Host ''
  Write-Host '  Готово. Панель запускается по требованию — в автозапуск ничего не добавлено.' -ForegroundColor Green
  Write-Host '  Проверка: marketing-agents\install\check-dashboard.ps1' -ForegroundColor DarkGray
  Write-Host ''
}

function Remove-Everything {
  Write-Head $(if ($DryRun) { 'Удаление (пробный прогон)' } else { 'Удаление задачи и ярлыка' })
  if ($DryRun) {
    Write-Item '[DryRun]' ('удалил бы задачу «' + $TaskName + '» и ярлык ' + $ShortcutName) 'Yellow'
    Write-Host ''
    return
  }
  if (Get-TaskObject) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Item 'Задача' 'удалена' 'Green' }
  else { Write-Item 'Задача' 'не найдена' 'DarkGray' }
  if (Test-Path -LiteralPath $ShortcutPath) { Remove-Item -LiteralPath $ShortcutPath -Force; Write-Item 'Ярлык' 'удалён' 'Green' }
  else { Write-Item 'Ярлык' 'не найден' 'DarkGray' }
  Write-Host ''
}

function Set-LogonTrigger($node) {
  $on = ($Logon -eq 'on')
  Write-Head $(if ($on) { 'Добавляю триггер входа в систему' } else { 'Убираю триггер входа в систему' })
  if ($DryRun) {
    Write-Item '[DryRun]' $(if ($on) { 'добавил бы триггер входа с паузой 20 с' } else { 'убрал бы триггер входа' }) 'Yellow'
    Write-Host ''
    return
  }
  $task = Get-TaskObject
  if (-not $task) { throw 'Задача не создана. Сначала: dashboard-task.ps1 -Install' }
  if ($on) {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\' + $env:USERNAME)
    $trigger.Delay = 'PT20S'
    Set-ScheduledTask -TaskName $TaskName -Trigger $trigger | Out-Null
    Write-Item 'Триггер' 'вход в систему, пауза 20 секунд' 'Green'
  } else {
    Set-ScheduledTask -TaskName $TaskName -Trigger @() | Out-Null
    Write-Item 'Триггер' 'убран — запуск только по требованию' 'Green'
  }
  Write-Host ''
}

function Invoke-Run {
  $node = Find-Node
  if (Test-PanelPort) {
    Write-Host ''
    Write-Host '  Панель уже работает.' -ForegroundColor Green
  } else {
    $task = Get-TaskObject
    if ($task) {
      Write-Host ''
      Write-Host '  Запускаю задачу планировщика...' -ForegroundColor DarkGray
      Start-ScheduledTask -TaskName $TaskName
    } else {
      Write-Host ''
      Write-Host '  Задачи нет — запускаю панель отдельным процессом.' -ForegroundColor Yellow
      Start-PanelDetached $node
    }
    if (-not (Wait-Panel 20)) {
      Write-Host ('  ПАНЕЛЬ НЕ ОТВЕТИЛА за 20 секунд. Журнал: ' + (Join-Path $LogDir 'server.err.log')) -ForegroundColor Red
      exit 1
    }
  }
  Write-Host ('  Панель работает: ' + $Url) -ForegroundColor Green
  if ($env:DASHBOARD_NO_BROWSER -ne '1') { Start-Process $Url | Out-Null }
  else { Write-Host '  Браузер не открываю: задан DASHBOARD_NO_BROWSER=1' -ForegroundColor DarkGray }
}

# --- что делаем ---
if ($Install) { Install-Everything (Find-Node); exit 0 }
if ($Remove) { Remove-Everything; exit 0 }
if ($Logon) { Set-LogonTrigger (Find-Node); exit 0 }
if ($Run) { Invoke-Run; exit 0 }
Show-Status
exit 0