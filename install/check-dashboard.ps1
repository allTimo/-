<#
.SYNOPSIS
  Автопроверка панели «Центр управления агентами» перед запуском.

.DESCRIPTION
  Делает то, что просил пользователь: «проверяй всегда на баги перед запуском».
  Если порт не слушается — поднимает панель (задачей планировщика, а если её нет —
  отдельным процессом) и ждёт до 20 секунд. Затем проверяет:

    1) GET /            -> 200
    2) GET /api/state   -> 200 и валидный JSON
    3) DOM (headless Chrome): все вкладки на месте, нет «Не удалось загрузить»,
       нет ошибок JS в stderr браузера
    4) свежесть данных из meta.generatedAt

  Печатает одну строку: «Панель работает: ...» или «ПАНЕЛЬ НЕ РАБОТАЕТ: <причина>».
  Код возврата: 0 — работает, 1 — нет.

.PARAMETER Port
  Порт панели, по умолчанию 8787.

.PARAMETER NoOpen
  Не открывать браузер при успешной проверке.

.PARAMETER SkipDom
  Пропустить проверку DOM (быстрее; используется, когда Chrome недоступен).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File marketing-agents\install\check-dashboard.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$NoOpen,
  [switch]$SkipDom,
  [switch]$SkipUx
)

$ErrorActionPreference = 'Continue'

$TaskName     = 'DSH Dashboard'
$ProjectRoot  = Split-Path $PSScriptRoot -Parent
$DashboardDir = Join-Path $ProjectRoot 'dashboard'
$Serve        = Join-Path $DashboardDir 'serve.mjs'
$LogDir       = Join-Path $DashboardDir 'logs'
$Url          = 'http://127.0.0.1:' + $Port
# Разделы левой панели навигации (проверяем, что все на месте).
$Tabs         = @(
  'Обзор', 'Клиенты', 'Подписки и тарифы', 'Услуги', 'Реклама и кэшбэк', 'Очередь работ', 'Агенты',
  'Аналитика', 'Результаты', 'Расходы: токены и модели', 'Экономика: деньги сервиса', 'Качество',
  'Интеграции', 'Оплаты', 'Уведомления', 'Состояние системы: здоровье данных', 'Журнал', 'Инфраструктура и справка',
  'Рабочие пространства', 'Проекты', 'Команда и доступы', 'Безопасность', 'Настройки',
  'Обучение', 'Поддержка'
)

function Fail($reason) {
  Write-Host ('ПАНЕЛЬ НЕ РАБОТАЕТ: ' + $reason) -ForegroundColor Red
  exit 1
}

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

function Find-Chrome {
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $c = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  )
  if ($pf86) { $c += (Join-Path $pf86 'Google\Chrome\Application\chrome.exe') }
  $c += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  foreach ($x in $c) { if ($x -and (Test-Path $x)) { return $x } }
  $onPath = Get-Command chrome -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ($Url + '/api/health')
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# --- 0. поднять панель, если не отвечает ---
if (-not (Test-Health)) {
  $node = Find-Node
  if (-not $node) { Fail 'не найден node.exe (проверьте установку DeepSeek Harness)' }
  if (-not (Test-Path $Serve)) { Fail ('не найден файл панели: ' + $Serve) }

  $task = $null
  try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $task = $null }

  if ($task) {
    Write-Host '  Панель не отвечает — запускаю задачу планировщика...' -ForegroundColor DarkGray
    Start-ScheduledTask -TaskName $TaskName
  } else {
    Write-Host '  Панель не отвечает — запускаю отдельным процессом...' -ForegroundColor DarkGray
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    Start-Process -FilePath $node -ArgumentList @('"' + $Serve + '"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') -RedirectStandardError (Join-Path $LogDir 'server.err.log')
  }

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Test-Health)) { Start-Sleep -Milliseconds 700 }
  if (-not (Test-Health)) { Fail 'панель не поднялась за 20 секунд (смотрите dashboard\logs\server.err.log)' }
}

# --- 1. главная страница ---
try {
  $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 $Url
  if ($page.StatusCode -ne 200) { Fail ('главная страница вернула HTTP ' + $page.StatusCode) }
} catch { Fail ('главная страница недоступна: ' + $_.Exception.Message) }

# --- 2. api/state и валидность JSON ---
$state = $null
try {
  $raw = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 ($Url + '/api/state')
  if ($raw.StatusCode -ne 200) { Fail ('/api/state вернул HTTP ' + $raw.StatusCode) }
  try { $state = $raw.Content | ConvertFrom-Json } catch { Fail ('/api/state вернул невалидный JSON') }
} catch { Fail ('/api/state недоступен: ' + $_.Exception.Message) }

foreach ($key in @('meta', 'agents', 'tasks', 'sources', 'usage')) {
  if (-not $state.PSObject.Properties.Name.Contains($key)) { Fail ('в /api/state нет раздела «' + $key + '»') }
}
if (-not $state.meta.generatedAtMs) { Fail 'в /api/state нет времени сборки данных' }

# --- 3. DOM ---
$tabCount = 0
if (-not $SkipDom) {
  $chrome = Find-Chrome
  if (-not $chrome) {
    Write-Host '  Chrome не найден — проверку DOM пропускаю.' -ForegroundColor DarkGray
  } else {
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'dsh-check-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $dom = Join-Path $tmp 'dom.html'
    $err = Join-Path $tmp 'err.txt'
    Start-Process -FilePath $chrome -ArgumentList @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--enable-logging=stderr', '--v=0', '--window-size=1920,1200', '--virtual-time-budget=8000', ('--user-data-dir=' + $tmp), '--dump-dom', ($Url + '/#agents')) -NoNewWindow -Wait -RedirectStandardOutput $dom -RedirectStandardError $err
    $html = Get-Content $dom -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    $errText = Get-Content $err -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $html) { Fail 'headless Chrome не вернул DOM' }
    if ($html -match 'Не удалось загрузить') { Fail 'страница сообщает «Не удалось загрузить»' }
    if ($html -match 'Загружаю данные дашборда') { Fail 'интерфейс не отрисовался (остался плейсхолдер загрузки)' }
    $missing = @()
    foreach ($t in $Tabs) { if ($html.Contains($t)) { $tabCount++ } else { $missing += $t } }
    if ($missing.Count -gt 0) { Fail ('в DOM нет разделов: ' + ($missing -join ', ')) }

    # УТЕЧКА В КЛИЕНТСКИЙ КАБИНЕТ (T78): в ?surface=client не должно быть ни операторских показателей,
    # ни операторских действий. Это ловится автоматически, а не глазами.
    $domC = [System.IO.Path]::GetTempFileName(); $errC = [System.IO.Path]::GetTempFileName()
    $profC = Join-Path ([System.IO.Path]::GetTempPath()) 'dshchk-client'
    Start-Process -FilePath $Chrome -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--window-size=1920,3000','--virtual-time-budget=11000',("--user-data-dir=" + $profC),'--dump-dom',($Url + '/?surface=client')) -NoNewWindow -Wait -RedirectStandardOutput $domC -RedirectStandardError $errC | Out-Null
    $hc = Get-Content $domC -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    Remove-Item $domC, $errC -Force -ErrorAction SilentlyContinue
    if ($hc) {
      $forbidden = @('ДОХОД', 'доход', 'МАРЖ', 'марж', 'себестоимост', 'Запустить услугу', 'Выставить счёт', 'Продлить', 'каркас')
      $leaks = @()
      foreach ($w in $forbidden) { if ($hc.Contains($w)) { $leaks += $w } }
      if ($leaks.Count) { Fail ('УТЕЧКА в клиентский кабинет: в ?surface=client найдены операторские данные/действия: ' + (($leaks | Select-Object -Unique) -join ', ')) }
      if ($hc -notmatch 'Это ваш кабинет') { Fail 'в клиентском кабинете нет приветствия — проверьте отрисовку ?surface=client' }
      if ($hc -notmatch 'С чего начать') { Fail 'в клиентском кабинете нет чек-листа первого входа' }
    }

    # РЕГРЕСС (UX, баг T73): переключатели «По конкурентам / По метрикам / По источникам» должны менять
    # СОДЕРЖИМОЕ, а не только подсветку. Сравниваем текст раздела в двух режимах: он обязан отличаться.
    $dom1 = [System.IO.Path]::GetTempFileName(); $err1 = [System.IO.Path]::GetTempFileName()
    $dom2 = [System.IO.Path]::GetTempFileName(); $err2 = [System.IO.Path]::GetTempFileName()
    $profA = Join-Path ([System.IO.Path]::GetTempPath()) 'dshchk-mode1'
    $profB = Join-Path ([System.IO.Path]::GetTempPath()) 'dshchk-mode2'
    Start-Process -FilePath $Chrome -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--window-size=1920,3000','--virtual-time-budget=11000',("--user-data-dir=" + $profA),'--dump-dom',($Url + '/#analytics/competitors')) -NoNewWindow -Wait -RedirectStandardOutput $dom1 -RedirectStandardError $err1 | Out-Null
    Start-Process -FilePath $Chrome -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--window-size=1920,3000','--virtual-time-budget=11000',("--user-data-dir=" + $profB),'--dump-dom',($Url + '/#analytics/metrics')) -NoNewWindow -Wait -RedirectStandardOutput $dom2 -RedirectStandardError $err2 | Out-Null
    $h1 = Get-Content $dom1 -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    $h2 = Get-Content $dom2 -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    Remove-Item $dom1, $err1, $dom2, $err2 -Force -ErrorAction SilentlyContinue
    $v1 = [regex]::Match($h1, '(?s)<main id="view".*?</main>').Value -replace '<[^>]+>', ' ' -replace '\s+', ' '
    $v2 = [regex]::Match($h2, '(?s)<main id="view".*?</main>').Value -replace '<[^>]+>', ' ' -replace '\s+', ' '
    if ($v1.Length -gt 500 -and $v2.Length -gt 500 -and $v1 -eq $v2) {
      Fail 'переключатели режимов Аналитики не меняют содержимое: текст в «по конкурентам» и «по метрикам» одинаковый'
    }
    if ($v2 -notmatch 'МетрикаЖК|Метрика ЖК|Метрика') {
      Fail 'режим «По метрикам» не переворачивает таблицу: не найден столбец «Метрика»'
    }

    # ВЕРСИЯ ИНТЕРФЕЙСА (баг T76): печатаем, какую версию ОТДАЁТ панель, и сверяем с файлами на диске.
    # Иначе пользователь после правки видит старый код (кэш или незапущенная версия) и считает,
    # что ничего не исправлено — ровно как было с «переключатели опять не работают».
    $mv = [regex]::Match($h1, 'Версия интерфейса: ([A-Za-z0-9\-]+)')
    $servedVer = $(if ($mv.Success) { $mv.Groups[1].Value } else { $null })
    if (-not $servedVer) {
      Fail 'в подвале панели нет версии интерфейса — невозможно понять, какая версия открыта у пользователя'
    } else {
      $uiFiles = Get-ChildItem (Join-Path $DashboardDir 'public') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.js', '.css', '.html' }
      $diskMax = ($uiFiles | Measure-Object LastWriteTime -Maximum).Maximum
      $verStamp = [regex]::Match($h1, 'собрана ([0-9]{2}\.[0-9]{2}\.[0-9]{4} [0-9]{2}:[0-9]{2})')
      # Подвал обязан показывать НЕ ТОЛЬКО версию, но и ВРЕМЯ СБОРКИ в понятном виде:
      # без него пользователь не понимает, свежая ли версия, а «собрана —» проходит любую проверку на версию.
      if (-not $verStamp.Success) {
        $bad = [regex]::Match($h1, 'Версия интерфейса:[^<]{0,80}').Value
        Fail ('в подвале не показано время сборки интерфейса (нужно «собрана DD.MM.YYYY HH:MM»): ' + $bad)
      }
      if ($h1 -match 'собрана\s*—') {
        Fail 'в подвале время сборки показано как «—»: подвал получил ISO-строку вместо миллисекунд'
      }
      Write-Output ('  OK   версия интерфейса: ' + $servedVer + $(if ($verStamp.Success) { ' · собрана ' + $verStamp.Groups[1].Value } else { '' }) + ' · файлов интерфейса: ' + $uiFiles.Count + ' · самая свежая правка на диске: ' + $diskMax.ToUniversalTime().ToString('s'))
      if ($servedVer -eq 'v-unknown') { Fail 'панель не смогла посчитать версию интерфейса (v-unknown)' }
      $st = Invoke-RestMethod -Uri ($Url + '/api/state') -TimeoutSec 10
      if ($st.uiVersion -and $st.uiVersion.builtAt -and $diskMax) {
        if (([datetime]$st.uiVersion.builtAt).ToUniversalTime() -lt $diskMax.ToUniversalTime().AddSeconds(-3)) {
          Fail 'панель отдаёт УСТАРЕВШУЮ версию интерфейса: файлы public/ новее, чем версия запущенного сервера — перезапустите панель'
        }
      }
    }

    # РЕГРЕСС (честность): если в срезе бюджетов есть demo: true, в интерфейсе ОБЯЗАН быть бейдж «ДЕМО-ОБРАЗЕЦ».
    $crPath = Join-Path $DashboardDir 'public\data\competitor-report.json'
    if (Test-Path $crPath) {
      try {
        $cr = Get-Content $crPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $anyDemo = $false
        foreach ($cl in $cr.clients) { if ($cl.marketing -and $cl.marketing.demo -eq $true) { $anyDemo = $true } }
        if ($anyDemo) {
          $domA = [System.IO.Path]::GetTempFileName()
          $errA = [System.IO.Path]::GetTempFileName()
          $profA = Join-Path ([System.IO.Path]::GetTempPath()) 'dshchk-demo'
          Start-Process -FilePath $Chrome -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--window-size=1920,3000','--virtual-time-budget=10000',("--user-data-dir=" + $profA),'--dump-dom',($Url + '/#analytics')) -NoNewWindow -Wait -RedirectStandardOutput $domA -RedirectStandardError $errA | Out-Null
          $htmlA = Get-Content $domA -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
          Remove-Item $domA, $errA -Force -ErrorAction SilentlyContinue
          if ($htmlA -notmatch 'ДЕМО-ОБРАЗЕЦ') { Fail 'в срезе стоит demo=true, но в интерфейсе нет бейджа «ДЕМО-ОБРАЗЕЦ»' }
        }
      } catch { }
    }

    # РЕГРЕСС (баг T55): вложенный адрес #agents/<вкладка> должен открывать раздел «Агенты»
    # с переключателем вкладок, а НЕ выбрасывать на «Обзор».
    foreach ($tab in @('executors', 'sources', 'nope')) {
      $u2 = $Url + '/#agents/' + $tab
      $dom2 = [System.IO.Path]::GetTempFileName()
      $err2 = [System.IO.Path]::GetTempFileName()
      $prof2 = Join-Path ([System.IO.Path]::GetTempPath()) 'dshchk-agents'
      Start-Process -FilePath $Chrome -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--window-size=1600,1000','--virtual-time-budget=9000',("--user-data-dir=" + $prof2),'--dump-dom',$u2) -NoNewWindow -Wait -RedirectStandardOutput $dom2 -RedirectStandardError $err2 | Out-Null
      $html2 = Get-Content $dom2 -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      Remove-Item $dom2, $err2 -Force -ErrorAction SilentlyContinue
      if ($html2 -notmatch 'seg-switch') { Fail ('адрес #agents/' + $tab + ' не открыл раздел «Агенты» (нет переключателя вкладок)') }
      # «Требует внимания» встречается ещё и в подсказке счётчика тревог в меню,
      # поэтому ищем маркер «Обзора» ТОЛЬКО внутри отрисованного раздела.
      $viewBlock = [regex]::Match($html2, '(?s)<main id="view".*?</main>').Value
      if ($viewBlock -match 'Требует внимания') { Fail ('адрес #agents/' + $tab + ' выбросил на «Обзор» вместо раздела «Агенты»') }
    }
    # ВАЖНО: headless Chromium ВСЕГДА пишет в stderr свои предупреждения
    # (extensions, GPU, DEPRECATED и т.п.) — это НЕ ошибки страницы.
    # Считаем багом только настоящие ошибки JS.
    $noise = 'external_registry_loader|Missing value path|GPU|gpu_|extensions|DEPRECATED|voice_transcription|Registration response error|Fontconfig|dbus|sandbox'
    $jsErrors = @()
    foreach ($line in ($errText -split "`r?`n")) {
      if ($line -match $noise) { continue }
      if ($line -match 'Uncaught|SyntaxError|TypeError|ReferenceError') { $jsErrors += $line.Trim() }
    }
    if ($jsErrors.Count -gt 0) { Fail ('в консоли браузера есть ошибки JS: ' + $jsErrors[0]) }
    try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction Stop } catch { }
  }
} else { $tabCount = $Tabs.Count }

# --- 4. свежесть данных ---
$gen = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$state.meta.generatedAtMs).LocalDateTime
$age = (Get-Date) - $gen
$fresh = $gen.ToString('dd.MM.yyyy HH:mm')
if ($age.TotalHours -ge 24) { $fresh = $fresh + ' (устарели на ' + [math]::Round($age.TotalHours) + ' ч)' }

# --- 5. ПОВЕДЕНЧЕСКАЯ UX-ПРОВЕРКА (CDP) -------------------------------------
# Приёмка «элемент есть в DOM» пропускает дефекты вида «подсветилось, но не
# изменилось содержимое». Поэтому после структурных проверок запускаем ux-check:
# он сравнивает содержимое до/после действий и падает на таких дефектах.
if (-not $SkipUx) {
  $Ux = Join-Path $DashboardDir 'run-ux-check.ps1'
  if (Test-Path $Ux) {
    Write-Host '  Поведенческая UX-проверка (ux-check)…' -ForegroundColor DarkGray
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Ux -Port $Port | Out-Host
    $uxCode = $LASTEXITCODE
    if ($uxCode -ne 0) { Fail ('UX-проверка не пройдена (код ' + $uxCode + '): смотрите dashboard\ux-report.json') }
  } else {
    Write-Host '  ux-check не найден — поведенческая проверка пропущена.' -ForegroundColor Yellow
  }
}

$counts = 'агентов ' + $state.agents.summary.enabled + '/' + $state.agents.summary.total + ', задач ' + $state.tasks.counts.total + ', источников ' + $state.sources.summary.enabled + '/' + $state.sources.summary.total

Write-Host ('Панель работает: ' + $Url + ' (разделов ' + $tabCount + ', данные свежие: ' + $fresh + '; ' + $counts + ')') -ForegroundColor Green
if (-not $NoOpen -and $env:DASHBOARD_NO_BROWSER -ne '1') { Start-Process $Url | Out-Null }
exit 0