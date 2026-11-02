#Requires -Version 5.1
<#
.SYNOPSIS
    Полный недельный цикл Агента 1: validate -> normalize -> diff -> отчёт (md + xlsx).

.DESCRIPTION
    Обёртка над python-скриптами движка. Запускать можно из любого каталога:
    пути скрипты считают от собственного расположения, а не от текущего каталога.

.PARAMETER Date
    Дата текущего снимка, YYYY-MM-DD. Снимок должен существовать в <snapshots>\<дата>\lots.csv.

.PARAMETER Prev
    Дата предыдущего снимка, YYYY-MM-DD. Если не указана, снимок выбирают сами скрипты
    по единому правилу cwlib.previous_snapshot_date + period.compare_mode из settings.yaml:
    week_over_week — ровно за period.days дней (иначе предупреждение в разделе 9 и отчёт без
    блока изменений), previous_snapshot — ближайший предыдущий по дате.

.PARAMETER Threshold
    Порог значимости изменения цены в процентах. Если не указан — берётся из settings.yaml
    (thresholds.price_change_pct), а при отсутствии файла — 0.5.

.PARAMETER ConfigDir
    Каталог конфигов. По умолчанию <marketing-agents>\00-admin\config.

.PARAMETER SnapshotsDir
    Каталог снимков. По умолчанию data\snapshots или output.snapshot_dir из settings.yaml.

.PARAMETER ReportsDir
    Каталог отчётов. По умолчанию reports или output.report_dir из settings.yaml.

.PARAMETER SourcesFile
    Файл источников (по умолчанию registry/sources.yaml). Шаг «источники» читает тумблеры
    enabled: false -> источник пропускается, и пишет журнал по включённым.

.PARAMETER RunsFile
    Журнал прогонов (по умолчанию 01-competitor-watch/data/source-runs.jsonl).

.PARAMETER SkipSources
    Не выполнять шаг источников (полезно для тестов и прогонов без учёта тумблеров).

.EXAMPLE
    .\run_weekly.ps1 -Date 2026-10-30 -Prev 2026-10-23

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\run_weekly.ps1 -Date 2026-10-30
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Date,
    [string]$Prev,
    [Nullable[double]]$Threshold,
    [string]$ConfigDir,
    [string]$SnapshotsDir,
    [string]$ReportsDir,
    [switch]$NoConfig,
    [string]$SourcesFile,
    [string]$RunsFile,
    [switch]$SkipSources
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WatchDir = Split-Path -Parent $ScriptDir

# Консоль в России часто в cp866, где нет символа ₽: переключаем вывод в UTF-8.
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
try { chcp 65001 | Out-Null } catch { }

if (-not $SnapshotsDir) { $SnapshotsDir = Join-Path $WatchDir 'data\snapshots' }
if (-not $ReportsDir) { $ReportsDir = Join-Path $WatchDir 'reports' }

if ($env:CW_PYTHON) {
    $Py = $env:CW_PYTHON
} else {
    $Py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
}
if (-not (Test-Path -LiteralPath $Py)) {
    Write-Error "Не найден python: $Py. Укажите путь в переменной окружения CW_PYTHON."
    exit 2
}

function Invoke-Engine {
    param([string]$Title, [string[]]$EngineArgs)
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
    # Предупреждения python идут в stderr; при перенаправлении потоков PowerShell 5.1
    # с $ErrorActionPreference='Stop' превращает их в terminating error, поэтому здесь
    # временно переключаемся на Continue и судим по коду возврата.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Py @EngineArgs
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        Write-Host "ШАГ ЗАВЕРШИЛСЯ С ОШИБКОЙ (код $exitCode): $Title" -ForegroundColor Red
        exit $exitCode
    }
}

$snapshotArgs = @()
if ($ConfigDir) { $snapshotArgs += @('--config-dir', $ConfigDir) }
if ($SnapshotsDir) { $snapshotArgs += @('--snapshots-dir', $SnapshotsDir) }
$reportArgs = $snapshotArgs.Clone()
if ($ReportsDir) { $reportArgs += @('--reports-dir', $ReportsDir) }
if ($NoConfig) {
    $snapshotArgs += @('--no-config')
    $reportArgs += @('--no-config')
}
$thresholdArgs = @()
if ($null -ne $Threshold) { $thresholdArgs = @('--threshold', "$Threshold") }

# Источники: сначала читаем тумблеры, пропускаем enabled: false, пишем журнал и last_run/status.
$sourceArgs = @('--date', $Date, '--snapshots-dir', $SnapshotsDir)
if ($SourcesFile) { $sourceArgs += @('--sources-file', $SourcesFile) }
if ($RunsFile) { $sourceArgs += @('--runs-file', $RunsFile) }

if (-not $SkipSources) {
    Invoke-Engine 'источники (тумблеры, журнал прогона)' (@("$ScriptDir\sources_tool.py", 'run-cycle') + $sourceArgs)
} else {
    Write-Host ''
    Write-Host 'Шаг источников пропущен (-SkipSources)' -ForegroundColor Yellow
}

$currentFile = Join-Path $SnapshotsDir "$Date\lots.csv"
if (-not (Test-Path -LiteralPath $currentFile)) {
    if ($ConfigDir) {
        Write-Host "Предупреждение: файл не найден по пути $currentFile, но задан -ConfigDir — проверку отдаю скрипту validate." -ForegroundColor Yellow
    } else {
        Write-Error "Снимок не найден: $currentFile. Создайте его: snapshot_tool.py new $Date"
        exit 2
    }
}

# Предыдущий снимок выбирают сами скрипты: единое правило cwlib.previous_snapshot_date
# + period.compare_mode из settings.yaml (как в run_weekly.py). -Prev задаёт его явно.
$prevArgs = @()
if ($Prev) { $prevArgs = @('--prev', $Prev) }

Invoke-Engine 'validate (текущий снимок)' (@("$ScriptDir\snapshot_tool.py", 'validate', $Date) + $snapshotArgs)
Invoke-Engine 'normalize (типы, ₽/м², дубли, сортировка)' (@("$ScriptDir\snapshot_tool.py", 'normalize', $Date) + $snapshotArgs)
Invoke-Engine 'diff (машиночитаемые изменения)' (@("$ScriptDir\diff_snapshots.py", '--curr', $Date) + $prevArgs + $thresholdArgs + $reportArgs)
Invoke-Engine 'отчёт (Markdown + XLSX)' (@("$ScriptDir\build_weekly_report.py", '--curr', $Date) + $prevArgs + $thresholdArgs + $reportArgs)

$Md = Join-Path $ReportsDir "$Date-competitor-watch.md"
$Xlsx = Join-Path $ReportsDir "$Date-competitor-watch.xlsx"
$Diff = Join-Path $ReportsDir ".cache\diff-$Date.json"

Write-Host ''
Write-Host '=== Готово ===' -ForegroundColor Green
foreach ($path in @($Md, $Xlsx, $Diff)) {
    if (Test-Path -LiteralPath $path) {
        Write-Host "  $path"
    } else {
        Write-Host "  (нет) $path" -ForegroundColor Yellow
    }
}
exit 0
