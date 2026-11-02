# Publish the READ-ONLY dashboard copy to the internet for phone testing.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish-dashboard.ps1 -Start
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish-dashboard.ps1 -Start -Tunnel localhostrun
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish-dashboard.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish-dashboard.ps1 -Stop
#
# Providers (-Tunnel):
#   auto          try in order: pinggy (443) -> localhost.run -> serveo.net -> lan
#   pinggy        ssh -p 443 -R0:127.0.0.1:8899 a.pinggy.io        (URL *.a.pinggy.link)
#   localhostrun  ssh -R 80:127.0.0.1:8899 nokey@localhost.run     (URL *.lhr.life)
#   serveo        ssh -R 80:127.0.0.1:8899 serveo.net              (URL *.serveo.net)
#   cloudflared   tools\cloudflared.exe tunnel --url ...          (BLOCKED from this network, kept as an option)
#   lan           no tunnel: static server on 0.0.0.0 + http://<LAN-IP>:<port>
#                 (phone on the same Wi-Fi; Windows Firewall must allow the port)
#
# Why 127.0.0.1 and not localhost in the -R forwards: on this machine "localhost"
# resolves to a dead IPv6 stack, so the remote side answered 502 until the forward
# target was pinned to 127.0.0.1.
#
# A URL reaches publish/last-url.txt and the report ONLY after a real
# Invoke-WebRequest over the public address returned 200 and the page contains the
# Russian dashboard title. Otherwise that tunnel is stopped and the next provider
# is tried.
#
# The file is UTF-8 **with BOM** (PowerShell 5.1 + Cyrillic). Keep the BOM.

[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Stop,
    [switch]$Status,
    [switch]$Rebuild,
    [switch]$NoVerify,
    [ValidateSet('auto', 'cloudflared', 'pinggy', 'localhostrun', 'serveo', 'lan')]
    [string]$Tunnel = 'auto',
    [ValidateSet('readonly', 'live')]
    [string]$Target = 'readonly',
    [string]$Subdomain = 'dsh-agents-7f3c',
    [int]$Port = 8899,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$LF = [string][char]10
$CRLF = [string][char]13 + [string][char]10

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$installDir = $PSScriptRoot
$publishDir = Join-Path $installDir 'publish'
$siteDir = Join-Path $publishDir 'site'
$toolsDir = Join-Path $installDir 'tools'
$logsDir = Join-Path $publishDir 'logs'
$stateFile = Join-Path $publishDir 'run-state.json'
$urlFile = Join-Path $publishDir 'last-url.txt'
$builder = Join-Path $publishDir 'build-publish.mjs'
$serverScript = Join-Path $publishDir 'static-server.mjs'
$cloudflared = Join-Path $toolsDir 'cloudflared.exe'
$sshExe = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$tmpDir = Join-Path $env:USERPROFILE 'AppData\Local\Temp'
$fwdHttp = '80:127.0.0.1:' + $Port
$fwdRandom = '0:127.0.0.1:' + $Port
$script:serverPid = 0
$targetPort = $Port
if ($Target -eq 'live') { $targetPort = 8787 }
$liveKeyFile = Join-Path $RepoRoot 'dashboard\config\access.key'
$liveUrlFile = Join-Path $RepoRoot 'dashboard\config\live-url.txt'

function Write-Step([string]$Text) { Write-Host "==> $Text" }
function Write-Note([string]$Text) { Write-Host "    $Text" }

function Resolve-NodeExe {
    $candidates = @()
    if ($env:DSH_NODE) { $candidates += $env:DSH_NODE }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
    foreach ($candidate in $candidates) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
    throw 'node.exe не найден — нужен для статического сервера сборки'
}

function Get-RunState {
    if (-not (Test-Path $stateFile)) { return $null }
    try { return (Get-Content $stateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Test-PidAlive($ProcessId) {
    if (-not $ProcessId) { return $false }
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-OurServerProcess {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'static-server\.mjs' })
}

function Test-LocalPage([int]$p) {
    try {
        $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $p + '/') -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-PortOwner([int]$p) {
    foreach ($line in @(netstat -ano -p tcp | Select-String (':' + $p + '\s'))) {
        if ($line.Line -match 'LISTENING\s+(\d+)\s*$') { return [int]$Matches[1] }
    }
    return 0
}

function Get-LanIp {
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress)
    if ($ips.Count -gt 0) { return $ips[0] }
    return $null
}

function Stop-Tree($ProcessId, [string]$Label) {
    if (-not $ProcessId) { return }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { Write-Note ($Label + ': процесс ' + $ProcessId + ' уже не работает'); return }
    & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 400
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Note ($Label + ': остановлен (pid ' + $ProcessId + ')')
}

function Get-ProviderPlan([string]$Name) {
    switch ($Name) {
        'pinggy' { return @{ name = 'pinggy'; label = 'pinggy (443)'; exe = $sshExe; log = 'tunnel.pinggy'
            args = @('-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-p', '443', ('-R' + $fwdRandom), 'a.pinggy.io')
            pattern = 'https://[a-z0-9-]+\.a\.pinggy\.link'; wait = 25 } }
        'localhostrun' { return @{ name = 'localhostrun'; label = 'localhost.run'; exe = $sshExe; log = 'tunnel.lhr'
            args = @('-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', $fwdHttp, 'nokey@localhost.run')
            pattern = 'https://[a-z0-9-]+\.lhr\.life'; wait = 35 } }
        'serveo' { return @{ name = 'serveo'; label = ('serveo.net, закреплённый поддомен ' + $Subdomain); exe = $sshExe; log = 'tunnel.serveo'
            args = @('-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', ($Subdomain + ':80:127.0.0.1:' + $targetPort), 'serveo.net')
            pattern = 'https://[a-z0-9-]+\.(serveo\.net|serveousercontent\.com)'; wait = 35 } }
        'cloudflared' { return @{ name = 'cloudflared'; label = 'cloudflared quick tunnel'; exe = $cloudflared; log = 'tunnel.cloudflared'
            args = @('tunnel', '--url', ('http://127.0.0.1:' + $Port), '--no-autoupdate')
            pattern = 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com'; wait = 45 } }
    }
    return $null
}

function Start-TunnelProcess($plan) {
    $errLog = Join-Path $logsDir ($plan.log + '.err.log')
    $outLog = Join-Path $logsDir ($plan.log + '.out.log')
    Remove-Item $errLog, $outLog -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $plan.exe)) { Write-Note ('нет исполняемого файла: ' + $plan.exe); return $null }
    Write-Note ('команда: ' + $plan.exe + ' ' + ($plan.args -join ' '))
    $proc = Start-Process -FilePath $plan.exe -ArgumentList $plan.args -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $deadline = (Get-Date).AddSeconds($plan.wait); $url = $null
    while ((Get-Date) -lt $deadline) {
        foreach ($f in @($errLog, $outLog)) {
            if (Test-Path $f) {
                $text = Get-Content $f -Raw -ErrorAction SilentlyContinue
                if ($text -match $plan.pattern) { $url = $Matches[0]; break }
            }
        }
        if ($url -or $proc.HasExited) { break }
        Start-Sleep -Milliseconds 800
    }
    if (-not $url) {
        Write-Note ('адрес не появился за ' + $plan.wait + ' с (exited=' + $proc.HasExited + '); хвост лога:')
        foreach ($f in @($errLog, $outLog)) { Get-Content $f -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Note ('  ' + $_) } }
        if (-not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null }
        return $null
    }
    return @{ pid = $proc.Id; url = $url; plan = $plan }
}

function Test-PublicPage([string]$Url) {
    $tmp = Join-Path $tmpDir ('publish-check-' + [guid]::NewGuid().ToString('N') + '.html')
    $status = $null; $hasTitle = $false; $hasBanner = $false; $chars = 0
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 40 -OutFile $tmp -PassThru
        $status = [int]$resp.StatusCode
        $text = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
        $chars = $text.Length
        $hasTitle = ($text -match 'Центр управления агентами')
        $hasBanner = ($text -match 'Тестовая копия')
    } catch {
        $resp = $_.Exception.Response
        if ($resp) { $status = [int]$resp.StatusCode } else { $status = 'нет ответа: ' + $_.Exception.Message }
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return @{ status = $status; title = $hasTitle; banner = $hasBanner; chars = $chars }
}

function Test-ReadOnly([string]$Url) {
    $result = @()
    foreach ($method in @('POST', 'PUT', 'DELETE')) {
        $code = 'нет ответа'
        try {
            $r = Invoke-WebRequest -Uri ($Url + '/api/collect') -Method $method -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 25
            $code = [int]$r.StatusCode
        } catch {
            $resp = $_.Exception.Response
            if ($resp) { $code = [int]$resp.StatusCode } else { $code = $_.Exception.Message }
        }
        $result += ($method + ' -> ' + $code)
    }
    return ($result -join '; ')
}

function Save-Published($provider, $url, $startedAt, $tunnelPid) {
    $state = [ordered]@{
        provider = $provider; serverPid = $script:serverPid; tunnelPid = $tunnelPid
        url = $url; port = $Port; startedAt = $startedAt; mode = 'read-only'
    }
    [System.IO.File]::WriteAllText($stateFile, (($state | ConvertTo-Json) + $LF), (New-Object System.Text.UTF8Encoding($false)))
    $lines = @(
        'URL: ' + $url,
        'провайдер: ' + $provider,
        'запущено: ' + $startedAt,
        'локально: http://127.0.0.1:' + $Port,
        'режим: только чтение, без API записи, без секретов',
        'ссылка временная: при следующем -Start адрес будет другим',
        'виден любому, у кого есть ссылка'
    )
    [System.IO.File]::WriteAllText($urlFile, (($lines -join $CRLF) + $CRLF), (New-Object System.Text.UTF8Encoding($false)))
    $liveDir = Split-Path -Parent $liveUrlFile
    if (-not (Test-Path $liveDir)) { New-Item -ItemType Directory -Path $liveDir -Force | Out-Null }
    [System.IO.File]::WriteAllText($liveUrlFile, ($url + $CRLF), (New-Object System.Text.UTF8Encoding($false)))
    Write-Note ('адрес для Тильды: ' + $liveUrlFile)
}

function Start-Publish {
    $existing = Get-RunState
    if ($existing -and (Test-PidAlive $existing.tunnelPid) -and (Test-LocalPage $Port)) {
        Write-Step 'уже запущено'
        Write-Note ('провайдер ' + $existing.provider + ', сервер pid ' + $existing.serverPid + ', туннель pid ' + $existing.tunnelPid)
        Write-Host ''
        Write-Host ('ПУБЛИЧНЫЙ АДРЕС: ' + $existing.url)
        return
    }

    $node = Resolve-NodeExe
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

    if ($Rebuild -or -not (Test-Path (Join-Path $siteDir 'index.html'))) {
        Write-Step 'собираю публичную копию'
        & $node $builder 2>&1 | Out-String -Width 200 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw 'сборка не прошла (секреты или нет исходников) — см. publish/scan-report.json' }
    } else { Write-Note 'публичная копия уже собрана (пересобрать: -Rebuild)' }

    if ($Target -eq 'live') {
        if (-not (Test-Path $liveKeyFile)) { throw ('живой сервер 8787 нельзя публиковать без ключа: нет ' + $liveKeyFile + ' (ждём задачу T21)') }
        if (-not (Test-LocalPage 8787)) { throw 'живой сервер на 127.0.0.1:8787 не отвечает — сначала запустите dashboard/serve.mjs' }
        Write-Note 'режим live: публикую существующий сервер 127.0.0.1:8787 (со своим ключом)'
        $script:serverPid = 0
    }
    $bindHost = '127.0.0.1'
    if ($Tunnel -eq 'lan') { $bindHost = '0.0.0.0' }

    if ($Target -eq 'live') { $ours = @() } else { $ours = @(Get-OurServerProcess) }
    if ($ours.Count -gt 0 -and (Test-LocalPage $Port) -and $Tunnel -ne 'lan') {
        $script:serverPid = $ours[0].ProcessId
        Write-Note ('переиспользую уже запущенный статический сервер, pid ' + $script:serverPid)
    }
    if ($ours.Count -gt 0 -and $Tunnel -eq 'lan') {
        Stop-Tree $ours[0].ProcessId 'старый сервер (нужен bind 0.0.0.0)'
        $ours = @()
    }
    if ($script:serverPid -eq 0 -and $Target -ne 'live') {
        $owner = Get-PortOwner $Port
        if ($owner -ne 0) { throw ('порт ' + $Port + ' занят процессом ' + $owner + ' — остановите его или задайте другой -Port') }
        Write-Step ('поднимаю статический сервер (' + $bindHost + ':' + $Port + ')')
        $env:PUBLISH_HOST = $bindHost
        $srv = Start-Process -FilePath $node -ArgumentList @($serverScript, [string]$Port) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir 'server.out.log') -RedirectStandardError (Join-Path $logsDir 'server.err.log')
        Remove-Item Env:\PUBLISH_HOST -ErrorAction SilentlyContinue
        $ready = $false
        for ($i = 0; $i -lt 20; $i++) { if (Test-LocalPage $Port) { $ready = $true; break }; Start-Sleep -Milliseconds 500 }
        if (-not $ready) { Stop-Tree $srv.Id 'сервер'; throw 'статический сервер не поднялся — см. publish/logs/server.err.log' }
        $script:serverPid = $srv.Id
        Write-Note ('сервер pid ' + $script:serverPid)
    }

    $startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

    if ($Tunnel -eq 'lan') {
        $ip = Get-LanIp
        if (-not $ip) { Stop-Tree $script:serverPid 'сервер'; throw 'не нашёл локальный IPv4 — LAN-режим невозможен' }
        $url = 'http://' + $ip + ':' + $Port
        $check = Test-PublicPage $url
        Write-Note ('проверка по локальной сети: status=' + $check.status + ' заголовок=' + $check.title)
        if ($check.status -ne 200 -or -not $check.title) { throw 'LAN-адрес не отвечает — проверьте брандмауэр Windows' }
        Save-Published 'lan' $url $startedAt 0
        Write-Host ''
        Write-Host ('АДРЕС В ЛОКАЛЬНОЙ СЕТИ: ' + $url)
        Write-Note 'телефон должен быть в той же Wi-Fi; если не открывается — разрешите порт в брандмауэре Windows'
        return
    }

    $order = @()
    if ($Tunnel -eq 'auto') { $order = @('serveo', 'localhostrun', 'pinggy') } else { $order = @($Tunnel) }
    foreach ($name in $order) {
        $plan = Get-ProviderPlan $name
        if (-not $plan) { continue }
        Write-Step ('пробую ' + $plan.label)
        $tunnel = Start-TunnelProcess $plan
        if (-not $tunnel) { Write-Note ($plan.label + ': адрес не получен'); continue }
        Write-Note ('адрес: ' + $tunnel.url + ' (pid ' + $tunnel.pid + ')')
        if ($NoVerify) { Save-Published $name $tunnel.url $startedAt $tunnel.pid; Write-Host ('ПУБЛИЧНЫЙ АДРЕС (без проверки): ' + $tunnel.url); return }
        $check = Test-PublicPage $tunnel.url
        Write-Note ('проверка снаружи: status=' + $check.status + ' символов=' + $check.chars + ' заголовок=' + $check.title + ' баннер=' + $check.banner)
        if ($check.status -eq 200 -and $check.title) {
            Write-Note ('запись через публичный адрес: ' + (Test-ReadOnly $tunnel.url))
            Save-Published $name $tunnel.url $startedAt $tunnel.pid
            Write-Host ''
            Write-Host '================================================================'
            Write-Host ('  ПУБЛИЧНЫЙ АДРЕС: ' + $tunnel.url)
            Write-Host '================================================================'
            Write-Note ('провайдер ' + $plan.label + ', сервер pid ' + $script:serverPid + ', туннель pid ' + $tunnel.pid)
            Write-Note ('сохранено в ' + $urlFile)
            Write-Note 'ссылка временная; видит любой, у кого она есть; запись недоступна'
            return
        }
        Write-Note ($plan.label + ': проверка не прошла — гашу туннель и пробую следующий')
        Stop-Tree $tunnel.pid $plan.label
    }

    throw 'ни один туннель не подтвердился — запустите с -Tunnel lan (локальная сеть)'
}

function Stop-Publish {
    $state = Get-RunState
    if ($state) {
        Write-Step 'останавливаю публикацию'
        Stop-Tree $state.tunnelPid 'туннель'
        Stop-Tree $state.serverPid 'сервер'
    } else { Write-Step 'состояния нет — чищу возможные осиротевшие процессы' }

    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -and $p.CommandLine -match 'trycloudflare|tunnel --url') { Stop-Tree $p.ProcessId 'осиротевший cloudflared' }
    }
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -and $p.CommandLine -match 'pinggy|lhr\.life|serveo|localhost\.run') { Stop-Tree $p.ProcessId 'осиротевший ssh-туннель' }
    }
    foreach ($p in @(Get-OurServerProcess)) { Stop-Tree $p.ProcessId 'осиротевший сервер' }

    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    Write-Note ('локальный порт ' + $Port + ' отвечает: ' + (Test-LocalPage $Port))
    Write-Note ('последний адрес остался в ' + $urlFile + ' (но сам адрес уже не работает)')
    Write-Host 'Остановлено.'
}

function Show-Status {
    $state = Get-RunState
    Write-Step 'статус публикации дашборда'
    Write-Note ('локальный сервер на порту ' + $Port + ': ' + $(if (Test-LocalPage $Port) { 'работает' } else { 'не отвечает' }))
    if ($state) {
        Write-Note ('провайдер: ' + $state.provider + '; запущено: ' + $state.startedAt)
        Write-Note ('pid сервера ' + $state.serverPid + ': ' + $(if (Test-PidAlive $state.serverPid) { 'жив' } else { 'мёртв' }))
        Write-Note ('pid туннеля ' + $state.tunnelPid + ': ' + $(if (Test-PidAlive $state.tunnelPid) { 'жив' } else { 'мёртв' }))
        Write-Note ('URL: ' + $state.url)
        if ($state.url) {
            $check = Test-PublicPage $state.url
            Write-Note ('публичная проверка: status=' + $check.status + ' заголовок=' + $check.title)
        }
    } else { Write-Note 'run-state.json нет: публикация не запущена' }
    if (Test-Path $urlFile) { Write-Host ''; Write-Host 'last-url.txt:'; Get-Content $urlFile | ForEach-Object { Write-Host ('  ' + $_) } }
}

if ($Start) { Start-Publish; return }
if ($Stop) { Stop-Publish; return }
Show-Status
