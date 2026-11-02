# Full rollback of the T11 force-installed plugins.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File force-rollback.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File force-rollback.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File force-rollback.ps1 -KeepExemptions
#
# These two plugins were installed DESPITE the host's compatibility gate, with an
# explicit exact-version exemption (dsh plugin allow-version ... --accept-risk):
#   @opendsh/dsh-plugin-scheduled-tasks@0.2.4   (needs the ^0.1.0-rc.6 in-box family)
#   dsh-creative-studio@0.2.1                   (engines.dsh excludes 0.2.x)
# If DSH fails to start after restarting, run this script once: it restores the
# profile manifest and lockfile from the .bak-force-<stamp> backups, drops the
# two exemptions from compatibility.json (backed up first) and prunes
# node_modules through pnpm, which is exactly the pre-T11 state.
#
# The file is UTF-8 **with BOM**: Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI and mangles the Cyrillic messages. Keep the BOM when editing.

[CmdletBinding()]
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
    [string]$CliPath = "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd",
    [string]$Stamp,
    [switch]$KeepExemptions,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$LF = [string][char]10
$forced = @('@opendsh/dsh-plugin-scheduled-tasks@0.2.4', 'dsh-creative-studio@0.2.1')

if (-not (Test-Path $ProfileDir)) { throw "профиль не найден: $ProfileDir" }
if (-not (Test-Path $CliPath)) { throw "CLI не найден: $CliPath" }

if (-not $Stamp) {
    $newest = Get-ChildItem $ProfileDir -Filter 'package.json.bak-force-*' | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $newest) { throw "в $ProfileDir нет бэкапов package.json.bak-force-*" }
    $Stamp = $newest.Name -replace '^package\.json\.bak-force-', ''
}
Write-Host "==> откат к состоянию до T11, метка бэкапа: $Stamp"

$pairs = @(
    @{ name = 'package.json';        backup = "package.json.bak-force-$Stamp" },
    @{ name = 'pnpm-lock.yaml';      backup = "pnpm-lock.yaml.bak-force-$Stamp" },
    @{ name = 'pnpm-workspace.yaml'; backup = "pnpm-workspace.yaml.bak-force-$Stamp" }
)
foreach ($p in $pairs) {
    if (-not (Test-Path (Join-Path $ProfileDir $p.backup))) { throw "нет бэкапа: $($p.backup)" }
}

Write-Host '--- 1) манифест и локфайл ---'
foreach ($p in $pairs) {
    if ($DryRun) { Write-Host "    dry run: восстановил бы $($p.name) <- $($p.backup)" }
    else {
        Copy-Item (Join-Path $ProfileDir $p.backup) (Join-Path $ProfileDir $p.name) -Force
        Write-Host "    восстановлен: $($p.name)"
    }
}

Write-Host '--- 2) исключения совместимости ---'
$compatPath = Join-Path $ProfileDir 'compatibility.json'
if ($KeepExemptions) { Write-Host '    оставлены по -KeepExemptions' }
elseif (-not (Test-Path $compatPath)) { Write-Host '    compatibility.json отсутствует — нечего чистить' }
else {
    $raw = Get-Content $compatPath -Raw | ConvertFrom-Json
    foreach ($key in $forced) {
        if ($raw.PSObject.Properties.Name -contains $key) { $raw.PSObject.Properties.Remove($key); Write-Host "    снято исключение: $key" }
    }
    if ($DryRun) { Write-Host '    dry run: перезаписал бы compatibility.json без этих исключений' }
    else {
        Copy-Item $compatPath ($compatPath + ".bak-rollback-$Stamp") -Force
        [System.IO.File]::WriteAllText($compatPath, (($raw | ConvertTo-Json -Depth 6) + $LF), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "    compatibility.json обновлён (бэкап: compatibility.json.bak-rollback-$Stamp)"
    }
}

Write-Host '--- 3) node_modules через pnpm ---'
if ($DryRun) { Write-Host '    dry run: dsh plugin --profile desktop install' }
else {
    & $CliPath plugin --profile desktop install 2>&1 | Out-String -Width 200 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "pnpm install завершился с кодом $LASTEXITCODE" }
}

Write-Host '--- 4) проверка ---'
if (-not $DryRun) {
    $man = Get-Content (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json
    Write-Host ("    deps=" + $man.dependencies.PSObject.Properties.Name.Count + " bundles=" + $man.dsh.profile.bundles.Count)
    $left = 0
    foreach ($key in $forced) {
        $name = $key -replace '@[^@]+$', ''
        $inDeps = $man.dependencies.PSObject.Properties.Name -contains $name
        $inBundles = $man.dsh.profile.bundles -contains $name
        $onDisk = Test-Path (Join-Path $ProfileDir ('node_modules\' + $name))
        Write-Host ("    " + $name + ": dependency=" + $inDeps + " bundle=" + $inBundles + " dir=" + $onDisk)
        if ($inDeps -or $inBundles) { $left++ }
    }
    if ($left -gt 0) { Write-Warning 'форсированные плагины всё ещё объявлены — проверьте метку бэкапа' }
}
Write-Host ''
Write-Host 'Готово. Перезапустите DSH:'
Write-Host '  1. Полностью закройте DeepSeek Harness (в том числе значок в трее -> Выход).'
Write-Host '  2. Запустите приложение снова.'
