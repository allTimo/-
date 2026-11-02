# One-command rollback of the T25 UI translation (skill-browser + delegate-router).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-ui-ru.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-ui-ru.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-ui-ru.ps1 -Stamp 20261031154426
#
# Restores node_modules/<plugin>/lib/client.js from the newest client.js.bak-t25-*
# copy, then checks the syntax (node --check on a .mjs copy) and the profile
# (check-profile-bundles.mjs). The file is UTF-8 with BOM (PowerShell 5.1).

[CmdletBinding()]
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
    [string]$Stamp,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$plugins = @('dsh-skill-browser', 'dsh-delegate-router')
$nm = Join-Path $ProfileDir 'node_modules'
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

foreach ($p in $plugins) {
    $target = Join-Path $nm ($p + '\lib\client.js')
    if (-not $Stamp) {
        $newest = Get-ChildItem (Split-Path $target -Parent) -Filter 'client.js.bak-t25-*' | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $newest) { Write-Host ("  " + $p + ": бэкапов client.js.bak-t25-* нет — пропуск"); continue }
        $backup = $newest.FullName
    } else { $backup = $target + '.bak-t25-' + $Stamp }
    if (-not (Test-Path $backup)) { Write-Host ("  " + $p + ": бэкап не найден: " + $backup); continue }
    if ($DryRun) { Write-Host ("  dry run: " + $p + "\lib\client.js <- " + (Split-Path $backup -Leaf)) }
    else { Copy-Item $backup $target -Force; Write-Host ("  восстановлен: " + $p + "\lib\client.js") }
}
if ($DryRun) { return }

Write-Host '--- проверки ---'
foreach ($p in $plugins) {
    $target = Join-Path $nm ($p + '\lib\client.js')
    $copy = Join-Path $nm ($p + '\lib\client.check.mjs')
    Copy-Item $target $copy -Force
    & $node --check $copy 2>&1 | Out-Null
    Write-Host ("  " + $p + ": node --check exit=" + $LASTEXITCODE)
    Remove-Item $copy -Force -ErrorAction SilentlyContinue
}
$checker = Join-Path $PSScriptRoot 'check-profile-bundles.mjs'
if ((Test-Path $checker) -and (Test-Path $node)) {
    & $node $checker $ProfileDir 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host ("  " + $_) }
}
Write-Host 'Готово. Перезапустите DSH, чтобы вернуть китайские подписи.'
