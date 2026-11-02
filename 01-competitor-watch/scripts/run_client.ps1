#Requires -Version 5.1
<#
.SYNOPSIS
    Прогон Агента 1 по расписанию для одного клиента.

.DESCRIPTION
    Обёртка для планировщика Windows и ручного запуска. Вызывает collect_clients.py
    с нужным клиентом и пишет журнал прогонов (registry\runs.jsonl, registry\results.yaml).

.PARAMETER Client
    id клиента (файл config\clients\<id>.yaml). Без него обрабатываются все клиенты.

.PARAMETER NoBrowser
    Не поднимать Chrome: только анонимный HTTP (площадки, которым нужен браузер,
    получат честный статус needs_browser).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File run_client.ps1 -Client client-svet
#>
[CmdletBinding()]
param(
    [string]$Client,
    [string]$ClientsDir,
    [string]$Date,
    [switch]$NoBrowser,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
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

$arguments = @((Join-Path $ScriptDir 'collect_clients.py'))
if ($Client) { $arguments += @('--client', $Client) }
if ($ClientsDir) { $arguments += @('--clients-dir', $ClientsDir) }
if ($Date) { $arguments += @('--date', $Date) }
if ($NoBrowser) { $arguments += '--no-browser' }
if ($DryRun) { $arguments += '--dry-run' }

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $Py @arguments
    $exitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
}
exit $exitCode
