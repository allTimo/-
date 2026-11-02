# One-command rollback of the T20 profile cleanup.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-profile-consistency.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-profile-consistency.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-profile-consistency.ps1 -Stamp 20261031-182558
#
# Restores package.json, pnpm-lock.yaml, pnpm-workspace.yaml, compatibility.json
# and cordis.patch.yml from the *.bak-consistency-<stamp> copies taken before the
# T20 cleanup (force pair removed, vision/delegate routers enabled), then syncs
# node_modules through pnpm. That is the pre-T20 state: the broken force pair is
# back in dependencies AND its exemptions are back in compatibility.json.
#
# The file is UTF-8 **with BOM** (PowerShell 5.1 + Cyrillic). Keep the BOM.

[CmdletBinding()]
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
    [string]$CliPath = "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd",
    [string]$Stamp,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$LF = [string][char]10
$files = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json', 'cordis.patch.yml')

if (-not (Test-Path $ProfileDir)) { throw "профиль не найден: $ProfileDir" }
if (-not $Stamp) {
    $newest = Get-ChildItem $ProfileDir -Filter 'package.json.bak-consistency-*' | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $newest) { throw "в $ProfileDir нет бэкапов *.bak-consistency-*" }
    $Stamp = $newest.Name -replace '^package\.json\.bak-consistency-', ''
}
Write-Host "==> откат профиля к состоянию до T20, метка: $Stamp"

foreach ($name in $files) {
    $backup = Join-Path $ProfileDir ($name + '.bak-consistency-' + $Stamp)
    if ((Test-Path $backup) -and (Test-Path (Join-Path $ProfileDir $name))) {
        if ($DryRun) { Write-Host ("    dry run: " + $name + " <- " + $name + ".bak-consistency-" + $Stamp) }
        else { Copy-Item $backup (Join-Path $ProfileDir $name) -Force; Write-Host ("    восстановлен: " + $name) }
    } else { Write-Host ("    пропуск (нет бэкапа или файла): " + $name) }
}

if ($DryRun) { Write-Host '    dry run: dsh plugin --profile desktop install'; return }
if (-not (Test-Path $CliPath)) { throw "CLI не найден: $CliPath" }
& $CliPath plugin --profile desktop install 2>&1 | Out-String -Width 200 | Write-Host
if ($LASTEXITCODE -ne 0) { throw "pnpm install завершился с кодом $LASTEXITCODE" }

$man = Get-Content (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json
Write-Host ("    deps=" + $man.dependencies.PSObject.Properties.Name.Count + " bundles=" + $man.dsh.profile.bundles.Count)
Write-Host ''
Write-Host 'Готово. Перезапустите DSH, чтобы профиль пересобрался.'
