# Install (or remove) the dsh-marketing-skills plugin for the desktop DSH profile.
#
#   pwsh -ExecutionPolicy Bypass -File install-marketing-plugin.ps1
#   pwsh -ExecutionPolicy Bypass -File install-marketing-plugin.ps1 -DryRun
#   pwsh -ExecutionPolicy Bypass -File install-marketing-plugin.ps1 -Revert
#
# What it does, in order:
#   1. syncs  <repo>\skills\*  ->  <repo>\plugin\skills\   (generated tree:
#      each skill directory that contains a SKILL.md, with its resources)
#   2. smoke-loads <repo>\plugin\lib\index.js and checks that apply() registers a
#      skills provider, so a broken plugin never reaches the profile
#   3. copies <repo>\plugin -> <profile>\node_modules\dsh-marketing-skills
#   4. appends exactly one roster row (id: marketing-skills) to
#      <profile>\cordis.patch.yml
#
# A timestamped backup of cordis.patch.yml is written before any edit, the edited
# file is parsed with the profile's own js-yaml, and a validation failure restores
# the backup and aborts. Re-running changes nothing (idempotent by id), and
# -Revert removes both the installed plugin and the roster row.
#
# The file is UTF-8 **with BOM**: Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI and mangles the Cyrillic messages. Keep the BOM when editing.

[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
    [switch]$Revert,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$LF = [string][char]10

# $PSScriptRoot is resolved in the body rather than in a parameter default:
# Windows PowerShell 5.1 does not populate it while binding defaults under -File.
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

$packageName = 'dsh-marketing-skills'
$rosterId = 'marketing-skills'
$pluginSource = Join-Path $RepoRoot 'plugin'
$skillsSource = Join-Path $RepoRoot 'skills'
$pluginSkills = Join-Path $pluginSource 'skills'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$targetDir = Join-Path $ProfileDir "node_modules\$packageName"
$jsYamlDir = Join-Path $ProfileDir 'node_modules\js-yaml'
$rosterMarker = '# --- Real-estate marketing agent skills (added by install-marketing-plugin.ps1) ---'

function Write-Step([string]$Text) { Write-Host "==> $Text" }
function Write-Note([string]$Text) { Write-Host "    $Text" }

# --- helpers ---------------------------------------------------------------

function Resolve-NodeExe {
    $candidates = @()
    if ($env:DSH_NODE) { $candidates += $env:DSH_NODE }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    $runtimeRoot = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
    if (Test-Path $runtimeRoot) {
        $candidates += @(Get-ChildItem -Path $runtimeRoot -Recurse -Filter 'node.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\dependencies\\node\\bin\\node\.exe$' } |
            Select-Object -ExpandProperty FullName)
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw 'node.exe не найден: задайте $env:DSH_NODE или проверьте установку DSH.'
}

function Read-PatchFile {
    $bytes = [System.IO.File]::ReadAllBytes($patchPath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($hasBom) { $text = $text.Substring(1) }
    return @{ Text = $text; HasBom = $hasBom }
}

function Write-PatchFile([string]$Text, [bool]$HasBom) {
    [System.IO.File]::WriteAllText($patchPath, $Text, (New-Object System.Text.UTF8Encoding($HasBom)))
}

function New-PatchBackup {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $ProfileDir ("cordis.patch.yml.bak-marketing-" + $stamp)
    $suffix = 1
    while (Test-Path $backup) {
        $backup = Join-Path $ProfileDir ("cordis.patch.yml.bak-marketing-" + $stamp + "-" + $suffix)
        $suffix++
    }
    Copy-Item $patchPath $backup -Force
    return $backup
}

# js-yaml validation runs in a throw-away CJS file so the installer does not
# need its own module resolution.
$validatorSource = @'
'use strict';
const fs = require('node:fs');
const yaml = require(process.argv[2]);
const patchPath = process.argv[3];
const rosterId = process.argv[4];

function loadTolerant(text) {
    try {
        return { doc: yaml.load(text), mode: 'strict' };
    }
    catch (error) {
        if (!/unknown tag/i.test(String(error && error.message))) throw error;
        // !!js expressions are legal in DSH patches but unknown to js-yaml; the
        // tag token is dropped for validation only (structure, not semantics).
        const stripped = text.split(/\r?\n/).map(function (line) {
            return line.replace(/(:\s*|-\s*)!!js\S*\s*/, '$1');
        }).join('\n');
        return { doc: yaml.load(stripped), mode: 'tolerant (!!js tags stripped)' };
    }
}

const text = fs.readFileSync(patchPath, 'utf8');
const result = loadTolerant(text);
const doc = result.doc;
if (!Array.isArray(doc)) throw new Error('patch root is not a YAML array: ' + patchPath);

let rosterCount = 0;
for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue;
    for (const item of (Array.isArray(entry.insert) ? entry.insert : [])) {
        if (item && typeof item === 'object' && item.id === rosterId) rosterCount += 1;
    }
}
process.stdout.write(JSON.stringify({ mode: result.mode, entries: doc.length, rosterCount: rosterCount }) + '\n');
'@

function Test-PatchDocument {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$NodeExe
    )
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-patch-validate-' + [guid]::NewGuid().ToString('N') + '.cjs')
    try {
        [System.IO.File]::WriteAllText($temp, $script:validatorSource, (New-Object System.Text.UTF8Encoding($false)))
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & $NodeExe $temp $jsYamlDir $Path $rosterId 2>&1
        $nodeExit = $LASTEXITCODE
        $ErrorActionPreference = $previousEap
        if ($nodeExit -ne 0) {
            throw ("js-yaml не смог разобрать " + $Path + ":" + $LF + ($output -join $LF))
        }
        return ($output | Select-Object -Last 1 | ConvertFrom-Json)
    }
    finally {
        Remove-Item $temp -Force -ErrorAction SilentlyContinue
    }
}

function Remove-MarketingRoster([string]$Text) {
    # Line-based removal. A single regex is not reliable here: the marker comment
    # is followed directly by our own '- insert:' line, so a lazy "up to the next
    # top-level entry" match stops before the entry itself.
    $lines = @($Text -split "\r?\n")
    $idIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^\s*-\s*id:\s*' + [regex]::Escape($rosterId) + '\s*$')) { $idIndex = $i; break }
    }
    if ($idIndex -lt 0) { return $Text }
    $insertIndex = -1
    for ($i = $idIndex - 1; $i -ge 0 -and $i -ge $idIndex - 8; $i--) {
        if ($lines[$i] -match '^\s*-\s*insert:\s*$') { $insertIndex = $i; break }
    }
    if ($insertIndex -lt 0) {
        Write-Warning ("нашёл id:" + $rosterId + ", но не нашёл его родительский '- insert:' — патч не изменён")
        return $Text
    }
    # Also drop the marker comment block directly above the entry (plus one blank line).
    $start = $insertIndex
    while ($start -gt 0 -and $lines[$start - 1] -match '^\s*#') { $start-- }
    if ($start -gt 0 -and $lines[$start - 1] -match '^\s*$') { $start-- }
    # The entry ends where the next top-level entry (column 0) begins, or at EOF.
    $end = $lines.Count
    for ($i = $insertIndex + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\S') { $end = $i; break }
    }
    $kept = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($i -lt $start -or $i -ge $end) { $kept += $lines[$i] }
    }
    return (($kept -join $LF).TrimEnd() + $LF)
}

# --- preflight -------------------------------------------------------------

Write-Step "проект:  $RepoRoot"
Write-Step "профиль: $ProfileDir"

foreach ($required in @(
        (Join-Path $pluginSource 'package.json'),
        (Join-Path $pluginSource 'lib\index.js'),
        (Join-Path $pluginSource 'cordis.patch.yml'),
        $patchPath)) {
    if (-not (Test-Path $required)) { throw "не найдено: $required" }
}
$manifest = Get-Content (Join-Path $pluginSource 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne $packageName) { throw "в package.json ожидалось имя $packageName, найдено $($manifest.name)" }
if (-not (Test-Path $jsYamlDir)) { throw "js-yaml не найден в профиле: $jsYamlDir — валидация YAML обязательна" }

$nodeExe = Resolve-NodeExe
Write-Note "node: $nodeExe"

$patch = Read-PatchFile
$before = Test-PatchDocument -Path $patchPath -NodeExe $nodeExe
Write-Note ("cordis.patch.yml читается: {0} записей, вхождений id:{1} = {2} ({3})" -f $before.entries, $rosterId, $before.rosterCount, $before.mode)

# --- revert ----------------------------------------------------------------

if ($Revert) {
    if (Test-Path $targetDir) {
        Write-Step "удаляю плагин: $targetDir"
        if (-not $DryRun) { Remove-Item -Recurse -Force $targetDir }
    }
    else { Write-Note "плагин не установлен: $targetDir" }

    if ($before.rosterCount -gt 0) {
        $updated = Remove-MarketingRoster $patch.Text
        if ($DryRun) { Write-Step ("dry run — строка id:" + $rosterId + " была бы удалена из " + $patchPath) }
        else {
            $backup = New-PatchBackup
            Write-Note "бэкап: $backup"
            Write-PatchFile $updated $patch.HasBom
            try {
                $after = Test-PatchDocument -Path $patchPath -NodeExe $nodeExe
                if ($after.rosterCount -ne 0) { throw ("после revert осталось вхождений id:" + $rosterId + ": " + $after.rosterCount) }
                Write-Note ("YAML ок: {0} записей, вхождений id:{1} = {2} ({3})" -f $after.entries, $rosterId, $after.rosterCount, $after.mode)
            }
            catch {
                Copy-Item $backup $patchPath -Force
                Write-Warning "валидация не прошла — восстановлен бэкап $backup"
                throw
            }
        }
    }
    else { Write-Note ("строки id:" + $rosterId + " в патче нет — править нечего") }

    Write-Host ''
    Write-Host 'Revert выполнен. Перезапустите DSH, чтобы провайдер скилов выгрузился:'
    Write-Host '  1. Полностью закройте DeepSeek Harness (в том числе значок в трее -> Выход).'
    Write-Host '  2. Запустите приложение снова.'
    return
}

# --- 1. sync skills -> plugin skills ---------------------------------------

Write-Step "копирую скилы: $skillsSource -> $pluginSkills"
if (-not (Test-Path $skillsSource)) { throw "нет папки скилов: $skillsSource" }
if (-not $DryRun) {
    if (Test-Path $pluginSkills) { Remove-Item -Recurse -Force $pluginSkills }
    New-Item -ItemType Directory -Path $pluginSkills -Force | Out-Null
}
$skillNames = @()
foreach ($dir in @(Get-ChildItem -Path $skillsSource -Directory -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path (Join-Path $dir.FullName 'SKILL.md'))) {
        Write-Warning "пропускаю $($dir.Name): в папке нет SKILL.md"
        continue
    }
    $skillNames += $dir.Name
    if (-not $DryRun) { Copy-Item -Recurse -Force $dir.FullName (Join-Path $pluginSkills $dir.Name) }
}
if ($skillNames.Count -eq 0) { Write-Warning "в $skillsSource нет ни одного скила с SKILL.md — провайдер будет отдавать пустой список" }
else { Write-Note ("скилов: {0} ({1})" -f $skillNames.Count, ($skillNames -join ', ')) }

# --- 2. smoke-load the plugin ----------------------------------------------

Write-Step 'проверяю, что плагин загружается и регистрирует провайдер'
$smokeSource = @'
import { pathToFileURL } from 'node:url';
const entry = process.argv[2];
const skillsDir = process.argv[3];
const mod = await import(pathToFileURL(entry).href);
let provider = null;
mod.apply({ inject: (services, callback) => callback({ skills: { registerProvider: (factory) => { provider = factory(); } } }) }, skillsDir ? { skillsDir } : {});
if (!provider) throw new Error('apply() did not register a skills provider');
const skills = await provider.list();
process.stdout.write(JSON.stringify({ plugin: mod.name, provider: provider.name, skills: skills.length }) + '\n');
'@
$smokeSkillsDir = $skillsSource
if (Test-Path $pluginSkills) { $smokeSkillsDir = $pluginSkills }
$smokeTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-marketing-smoke-' + [guid]::NewGuid().ToString('N') + '.mjs')
try {
    [System.IO.File]::WriteAllText($smokeTemp, $smokeSource, (New-Object System.Text.UTF8Encoding($false)))
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $smokeOutput = & $nodeExe $smokeTemp (Join-Path $pluginSource 'lib\index.js') $smokeSkillsDir 2>&1
    $smokeExit = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($smokeExit -ne 0) { throw ("плагин не загрузился:" + $LF + ($smokeOutput -join $LF)) }
    $smoke = $smokeOutput | Select-Object -Last 1 | ConvertFrom-Json
    if ($skillNames.Count -gt 0 -and [int]$smoke.skills -lt 1) { throw ("плагин загрузился, но не увидел ни одного скила в " + $smokeSkillsDir) }
    Write-Note ("плагин ок: " + ($smokeOutput | Select-Object -Last 1))
}
finally { Remove-Item $smokeTemp -Force -ErrorAction SilentlyContinue }

# --- 3. install into the profile -------------------------------------------

Write-Step "устанавливаю $packageName -> $targetDir"
if ($DryRun) { Write-Note 'dry run — копирование пропущено' }
else {
    if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir }
    Copy-Item -Recurse -Force $pluginSource $targetDir
    foreach ($required in @('package.json', 'lib\index.js', 'cordis.patch.yml')) {
        if (-not (Test-Path (Join-Path $targetDir $required))) { throw "установка неполная: нет $required в $targetDir" }
    }
}

# --- 4. exactly one roster row ---------------------------------------------

if ($before.rosterCount -gt 0) {
    Write-Step ("строка id:" + $rosterId + " уже есть в cordis.patch.yml — дубль не добавляю")
    if ($before.rosterCount -gt 1) { Write-Warning ("в патче " + $before.rosterCount + " вхождений id:" + $rosterId + " — проверьте файл вручную") }
}
else {
    Write-Step ("добавляю строку id:" + $rosterId + " в " + $patchPath)
    $rosterRow = @"

$rosterMarker
# Serves every SKILL.md bundled under marketing-agents\skills through the
# dsh-marketing-skills provider. Remove this row (or run the installer with
# -Revert) to unload the provider.
- insert:
    - id: marketing-skills
      name: dsh-marketing-skills
      config: {}
"@
    if ($DryRun) {
        Write-Note 'dry run — правка не записана; были бы добавлены строки:'
        $rosterRow.Trim().Split([char]10) | ForEach-Object { Write-Note ("  | " + $_) }
    }
    else {
        $updated = $patch.Text.TrimEnd() + $LF + $rosterRow + $LF
        $backup = New-PatchBackup
        Write-Note "бэкап: $backup"
        Write-PatchFile $updated $patch.HasBom
        try {
            $after = Test-PatchDocument -Path $patchPath -NodeExe $nodeExe
            if ($after.rosterCount -ne 1) { throw ("в патче должно быть ровно одно вхождение id:" + $rosterId + ", найдено " + $after.rosterCount) }
            Write-Note ("YAML ок: {0} записей, вхождений id:{1} = {2} ({3})" -f $after.entries, $rosterId, $after.rosterCount, $after.mode)
            Write-Note 'добавленные строки:'
            $rosterRow.Trim().Split([char]10) | ForEach-Object { Write-Note ("  | " + $_) }
        }
        catch {
            Copy-Item $backup $patchPath -Force
            Write-Warning "валидация не прошла — восстановлен бэкап $backup"
            throw
        }
    }
}

# --- done ------------------------------------------------------------------

Write-Host ''
if ($DryRun) {
    Write-Host 'Dry run: изменения не вносились.'
    Write-Host 'Для реальной установки запустите тот же скрипт без -DryRun, затем перезапустите DSH.'
    return
}
Write-Host 'Готово. Осталось перезапустить DSH:'
Write-Host '  1. Полностью закройте DeepSeek Harness (в том числе значок в трее -> Выход).'
Write-Host '  2. Запустите приложение снова.'
Write-Host ('  3. В новом чате агент должен видеть скилы: ' + (($skillNames | Sort-Object) -join ', '))
