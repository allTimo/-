# Wrapper: call ONE ru-marketplace-mcp tool over stdio and return JSON ("called and released").
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-connector.ps1 -Tool cian_search -Args '{"deal":"sale","region":1,"rooms":[2]}'
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-connector.ps1 -ListTools
#
# Nothing is mounted in the DSH profile: no MCP row is enabled, no tool schema
# sits in the model context. The engine (Agent 1) calls this per run and gets JSON.
#
# The file is UTF-8 with BOM (PowerShell 5.1 + Cyrillic). Keep the BOM.

[CmdletBinding()]
param(
    [string]$Tool,
    [string]$Args,
    [string]$ArgsFile,
    [string]$Newbuilding,
    [int]$Pages = 0,
    [string]$Out,
    [switch]$ListTools,
    [string]$Server = 'marketplace-mcp',
    [int]$TimeoutSec = 180,
    [string]$RepoDir,
    [string]$UvPath,
    [string]$PythonPath
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $RepoDir) { $RepoDir = Join-Path $here 'ru-marketplace-mcp' }
if (-not $UvPath) { $UvPath = Join-Path $here 'bin\uv.exe' }
if (-not $PythonPath) { $PythonPath = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' }

$nodeCandidates = @()
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) { $nodeCandidates += $onPath.Source }
$nodeCandidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
$node = $null
foreach ($candidate in $nodeCandidates) { if ($candidate -and (Test-Path $candidate)) { $node = $candidate; break } }
if (-not $node) { Write-Error 'node.exe не найден'; exit 3 }
if (-not (Test-Path $UvPath)) { Write-Error ('uv.exe не найден: ' + $UvPath); exit 3 }
if (-not (Test-Path (Join-Path $RepoDir 'pyproject.toml'))) { Write-Error ('клон репозитория не найден: ' + $RepoDir); exit 3 }
if (-not $ListTools -and -not $Tool) { Write-Error 'укажите -Tool <имя> или -ListTools'; exit 3 }

$env:RU_CONNECTOR_DIR = $RepoDir
$env:RU_CONNECTOR_UV = $UvPath
if (Test-Path $PythonPath) { $env:RU_CONNECTOR_PYTHON = $PythonPath; $env:UV_PYTHON = $PythonPath }

$runner = Join-Path $here 'run-connector.mjs'
$cliArgs = @($runner, '--repo', $RepoDir, '--uv', $UvPath, '--server', $Server, '--timeout', [string]$TimeoutSec)
if ($ListTools) { $cliArgs += '--list-tools' }
if ($Tool) { $cliArgs += @('--tool', $Tool) }
$argsTemp = $null
if ($ArgsFile) {
    if (-not (Test-Path $ArgsFile)) { Write-Error ('файл аргументов не найден: ' + $ArgsFile); exit 3 }
    $cliArgs += @('--args-file', $ArgsFile)
}
if ($Args) {
    # Inline JSON loses its quotes when PowerShell builds the argv for node, so the
    # payload goes through a temp file instead.
    $argsTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('rc-args-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($argsTemp, $Args, (New-Object System.Text.UTF8Encoding($false)))
    $cliArgs += @('--args-file', $argsTemp)
}

if ($Newbuilding) { $cliArgs += @('--newbuilding', $Newbuilding) }
if ($Pages -gt 1) { $cliArgs += @('--pages', [string]$Pages) }
if ($Out) { $cliArgs += @('--out', $Out) }

& $node @cliArgs
$code = $LASTEXITCODE
if ($argsTemp) { Remove-Item $argsTemp -Force -ErrorAction SilentlyContinue }
exit $code
