<#
.SYNOPSIS
  Поведенческая UX-проверка панели (Chrome DevTools Protocol) — обёртка для приёмки.

.DESCRIPTION
  Запускает dashboard\ux-check.mjs: проверяет ПОВЕДЕНИЕ (меняется ли содержимое,
  сужаются ли строки, закрываются ли модалы), а не наличие элементов в DOM.
  Возвращает код ux-check: 0 — ок, 1 — есть провалы, 2 — не удалось подключиться.

.PARAMETER Port
  Порт панели (по умолчанию 8787).

.PARAMETER Cdp
  Адрес отладочного Chrome (по умолчанию http://127.0.0.1:9222).
  Если порт не отвечает, ux-check сам поднимет headless Chrome.

.PARAMETER AllowKnown
  Не считать провалом известные дефекты из ux-check.mjs (KNOWN_DEFECTS).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\dashboard\run-ux-check.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Cdp = 'http://127.0.0.1:9222',
  [switch]$AllowKnown,
  [switch]$VerboseOutput
)

$ErrorActionPreference = 'Continue'
$DashboardDir = $PSScriptRoot
$Script = Join-Path $DashboardDir 'ux-check.mjs'
$Report = Join-Path $DashboardDir 'ux-report.json'

function Find-Node {
  $c = @()
  $c += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $runtimes) {
    Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $c += (Join-Path $_.FullName 'dependencies\node\bin\node.exe')
    }
  }
  foreach ($x in $c) { if (Test-Path $x) { return $x } }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

if (-not (Test-Path $Script)) { Write-Host ('UX-ПРОВЕРКА НЕ ЗАПУЩЕНА: нет файла ' + $Script) -ForegroundColor Red; exit 2 }
$node = Find-Node
if (-not $node) { Write-Host 'UX-ПРОВЕРКА НЕ ЗАПУЩЕНА: не найден node.exe' -ForegroundColor Red; exit 2 }

$arguments = @($Script, '--url', ('http://127.0.0.1:' + $Port), '--cdp', $Cdp)
if ($AllowKnown) { $arguments += '--allow-known' }
if ($VerboseOutput) { $arguments += '--verbose' }

& $node @arguments
$code = $LASTEXITCODE
if ($code -eq 0) {
  Write-Host ('UX-проверка пройдена. Отчёт: ' + $Report) -ForegroundColor Green
} else {
  Write-Host ('UX-ПРОВЕРКА НЕ ПРОЙДЕНА (код ' + $code + '). Отчёт: ' + $Report) -ForegroundColor Red
}
exit $code
