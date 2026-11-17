# Аудит SaaS/инженерного слоя `marketing-agents`

Задача: shared task `task-2`. Автор: teammate `saas-layer`. Дата: 2026-11-08.
Метод: только чтение файлов (read/grep/PowerShell-инвентаризация). Ничего не запускалось —
сборщик `collect.mjs`, панель `serve.mjs`, `ux-check.mjs`, `pytest` не выполнялись (запрет задачи).
Каждый факт — со ссылкой `путь:строка`. Все пути — от корня рабочего каталога
`C:\Users\Артем\Desktop\тестDH`. Где данных нет — `[НЕ ХВАТАЕТ ДАННЫХ]`.

---

## 0. Резюме: главные проблемы

| # | Sev | Проблема | Доказательство |
|---|-----|----------|----------------|
| 1 | 🔴 | **Панель — прямой control plane DSH-профиля, доступный по одному ключу.** Открытие наружу даёт удалённое управление рантаймом агентов: запись `package.json` профиля (bundle'ы), роутера моделей и выгрузку в Obsidian — вне дерева проекта, без ролей и аудита | `marketing-agents/dashboard/serve.mjs:37` (PROFILE_MANIFEST), `:38` (ROUTER_FILE), `:60` (EXPORT_VAULT_FILE), `:2075`, `:2030`, `:2332` |
| 2 | 🔴 | **Нет изоляции тенантов в API.** Один общий ключ = полный админ ко всем клиентам. Ни один маршрут не проверяет «чей клиент»: проверок прав нет, есть только проверка существования сущности | `marketing-agents/dashboard/serve.mjs:1013-1020` (единственная проверка), `:1865-1874` (проверка existence, не прав) |
| 3 | 🔴 | **Единственный источник правды — файлы, читаемые и перезаписываемые без блокировок.** `applyAtomicEdit` = read → mutate → temp → rename, без mutex/версии: два одновременных POST теряют правку (last-write-wins) | `marketing-agents/dashboard/serve.mjs:462-483` |
| 4 | 🔴 | **Панель замораживается на время каждого запуска.** Дочерние процессы запускаются `execFileSync` — синхронно, в одном потоке event loop: пока идёт Python-прогон, панель не отвечает никому | `marketing-agents/dashboard/serve.mjs:21`, `:305`, `:319`, `:342-343`; вызовы `:1188`, `:1362`, `:1891`, `:1977`, `:1993`, `:2010` |
| 5 | 🔴 | **Нет token-cost accounting на клиента.** Реальная стоимость прогона клиента — эвристика «символы/4», где выход = **размер файлов отчёта**, а не токены модели. LLM-вызовов в движке Агента 1 нет вообще | `marketing-agents/01-competitor-watch/scripts/collect_clients.py:468-480`, `:768-770` |
| 6 | 🟠 | **Две противоречивые себестоимости в одной панели:** смета прайс-листа `services.yaml` (120/450/260 ₽) против измеренного `runs.jsonl` (~1,2 ₽). Маржа считается от сметы, аналитика — от факта | `marketing-agents/registry/services.yaml:13,25,37`; `marketing-agents/registry/runs.jsonl:3-27`; `marketing-agents/dashboard/collector/lib/service.mjs:87-91`; `marketing-agents/dashboard/collector/lib/analytics2.mjs:153-170` |
| 7 | 🟠 | **Лимиты расхода декоративны.** `limit_rub` / `limit_tokens` / `on_limit` есть только в схеме панели и в YAML; ни один код их не читает и не сравнивает с расходом — остановки по лимиту не существует | `marketing-agents/dashboard/serve.mjs:94-95`; `marketing-agents/registry/agent-settings/*.yaml:19-20`; grep по `limit_rub\|limit_tokens` в `*.py/*.mjs` не находит потребителей |
| 8 | 🟠 | **Расколотый источник правды по снимкам.** Панель работает с глобальным деревом `data/snapshots` (последняя дата **2026-10-30**), реальные снимки клиентов лежат в `data/clients/<client>/snapshots` (до **2026-11-05**). Кнопки панели строят отчёт по устаревшим данным | `marketing-agents/dashboard/serve.mjs:44`, `:281-284`, `:1889-1893`, `:1991-1993`; `marketing-agents/01-competitor-watch/data/snapshots/` vs `.../data/clients/*/snapshots/`; `marketing-agents/dashboard/collector/lib/agent1-status.mjs:137-146` |
| 9 | 🟠 | **Панель не умеет собирать данные.** Её «запуск агента» идёт `run_weekly.py --skip-sources` — сбор живёт только в `collect_clients.py` (ручной `.cmd`/Планировщик). Данные в панели обновляются только внешним триггером | `marketing-agents/dashboard/serve.mjs:2010`; `marketing-agents/install/agent1-weekly.cmd:10-11,24` |
| 10 | 🟠 | **Многотенантный сбор последовательный и без очереди.** Цикл по клиентам — обычный `for`, нити/multiprocessing отсутствуют; ретраев бизнес-уровня нет | `marketing-agents/01-competitor-watch/scripts/collect_clients.py:932`, `:940`; grep `ProcessPool\|ThreadPool\|multiprocessing\|concurrent.futures\|threading.` по `*.py` движка — 0 совпадений |
| 11 | 🟠 | **SMTP: по одному TLS-соединению и логину на адрес, без ретраев, без батчинга.** Ошибки не поднимаются — превращаются в статус и `.eml` (тихий инцидент) | `marketing-agents/01-competitor-watch/scripts/delivery_email.py:310-341`, `:336-341` |
| 12 | 🟠 | **Белый список получателей fail-open.** Пустой/нечитаемый `settings.yaml` (или отсутствие списка) = «без ограничений»: письма уйдут любому адресу из конфигов | `marketing-agents/01-competitor-watch/scripts/delivery_email.py:140-143`, `:158-166`; `marketing-agents/00-admin/config/settings.yaml:105-111` |
| 13 | 🟠 | **CSRF: боковые эффекты по GET и keyless localhost.** `GET /api/collect` и `GET /api/state?collect=1` пересобирают данные на диске; локальный запрос (127.0.0.1) не требует ключа. Достаточно, чтобы любая страница в браузере той же машины дернула `<img src="...">` | `marketing-agents/dashboard/serve.mjs:1033` (POST **или GET**), `:1026-1030`, `:745-748` (keyless local) |
| 14 | 🟠 | **Ключ доступа утекает в лог.** 48-символьный ключ печатается в консоль и в файл журнала; cookie живёт год, ключ передаётся в query (история браузера, логи прокси) | `marketing-agents/dashboard/serve.mjs:2404-2408`, `:1018-1019`; `marketing-agents/dashboard/logs/server.out.log:10` |
| 15 | 🟡 | **Нет CI/CD, нет request id, нет ротации логов.** CI только у вложенного коннектора (`.github/workflows/*`), на проект — нет; логи пишутся `>>` без ротации; идентификатора запроса в панели нет | `.github` отсутствует в `marketing-agents/`; `marketing-agents/install/agent1-weekly.cmd:23-26`; grep `requestId\|traceId` в панели — 0 |
| 16 | 🟡 | **486 `.bak-*` файлов (3,0 МБ) без ротации.** Каждая правка панели плодит новую копию навсегда (159 в `registry/`, 159 в копии `_f10-live`, 60 в `00-admin/config/`). При 20 клиентах рост линейный | `marketing-agents/dashboard/serve.mjs:470-473`; подсчёт PowerShell: 486 файлов, 3,0 МБ |
| 17 | 🟡 | **Латентный близнец F13 не закрыт:** идентификатор `domclick` есть в платформенном слое и включён в клиентском конфиге, но отсутствует в enum контракта снимка | `marketing-agents/01-competitor-watch/scripts/platforms.py:73`, `:134-139`; `marketing-agents/00-admin/config/settings.yaml:168`; `marketing-agents/01-competitor-watch/scripts/cwlib.py:43`; `marketing-agents/01-competitor-watch/config/clients/client-svet.yaml:60` |
| 18 | 🟡 | **Схема данных разъехалась в 4 местах.** Один и тот же enum `source` и формат `delivery` описаны по-разному; runbook отстал от контракта | `marketing-agents/00-admin/config/settings.yaml:168,172`; `marketing-agents/01-competitor-watch/scripts/cwlib.py:43,53`; `marketing-agents/01-competitor-watch/scripts/SCHEMA.md:16,31`; **устарело:** `marketing-agents/00-admin/runbook.md:451` (нет `developer-sites`), `:454` (только `YYYY-QN`) |

---

## 1. Топология: панель → API → данные → артефакты

```
                        ┌──────────────────────────── браузер оператора ────────────────────────────┐
                        │ index.html + app.js + app-views.js…app-views15.js + sidebar.js + styles.css│
                        │            17 файлов JS, 475 КБ; рендер целиком на клиенте               │
                        └───────────────────────────────┬──────────────────────────────────────────┘
                                                        │ HTTP (без TLS), no-store
┌───────────────────────────────────────────────────────▼──────────────────────────────────────────┐
│ ПАНЕЛЬ: marketing-agents/dashboard/serve.mjs  (2413 строк, 156 КБ)                               │
│   http.createServer           serve.mjs:1008        bind HOST=127.0.0.1  serve.mjs:784           │
│   const p = url.pathname      serve.mjs:1010        PORT=8787 (env)      serve.mjs:785           │
│   ГЕЙТ: isLocalRequest || key   serve.mjs:1013-1020 (ключ: query|X-Dashboard-Key|cookie)         │
│   статика: serveStatic + защита от обхода public/   serve.mjs:980-1006                           │
│   запись: applyAtomicEdit (read→mutate→tmp→rename, .bak-<ts>)  serve.mjs:462-483                 │
│   запуск процессов: execFileSync, СИНХРОННО, timeout 60–300 с  serve.mjs:305,319,342             │
└───┬──────────────┬───────────────┬───────────────┬────────────────┬──────────────────┬───────────┘
    │              │               │               │                │                  │
    │ чтение       │ правка YAML   │ сбор данных   │ движок Агента1 │ DSH-профиль      │ внешнее
    ▼              ▼               ▼               ▼                ▼                  ▼
┌─────────┐  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  ┌─────────────┐
│public/  │  │ registry/**  │ │ collector/   │ │ 01-competitor│ │ ~/.dsh/      │  │ SMTP Яндекс │
│data/*.  │  │ agents.yaml  │ │ collect.mjs  │ │ -watch/      │ │ package.json │  │ (465/SSL)   │
│json (24)│  │ sources.yaml │ │  → public/   │ │ scripts/     │ │ router.json  │  │ Циан/Авито/ │
│489 КБ   │  │ clients.yaml │ │    data/**   │ │ collect_     │ │ (bundle'ы,   │  │ Яндекс Нед. │
│tasks.   │  │ services.yaml│ │              │ │ clients.py   │ │  роутинг)    │  │ Домклик/    │
│json     │  │ subscript…   │ │ node, 180 с  │ │ Python 3.x   │ │              │  │ сайты ЖК    │
│         │  │ invoices,    │ │              │ │ последоват.  │ │ vault/       │  │ Chrome CDP  │
│         │  │ cashback,    │ │              │ │ по клиентам  │ │ выгрузка     │  │ 9333/9344/  │
│         │  │ prices.yaml  │ │              │ │              │ │ панели       │  │ 9363/9364   │
└─────────┘  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────────────┘  └──────┬──────┘
                    │                │                │                                  │
                    │                │                ▼                                  │
                    │                │        ┌───────────────────────────────┐          │
                    │                │        │ АРТЕФАКТЫ                     │          │
                    │                │        │ 01-competitor-watch/reports/  │◄─────────┘
                    │                │        │   clients/<client>/<date>-    │   сбор лотов
                    │                │        │   competitor-watch.{md,xlsx,  │   (HTTP/браузер)
                    │                │        │   docx,pdf,eml}                │
                    │                │        │ 01-competitor-watch/data/      │
                    │                │        │   snapshots/<date>/lots.csv    │  ← «общие» (панель)
                    │                │        │   clients/<c>/snapshots/…      │  ← истина клиента
                    │                │        │ registry/runs.jsonl (журнал)   │
                    │                │        │ registry/results.yaml          │
                    │                │        └───────────────────────────────┘
                    │                │
                    ▼                ▼
     ┌──────────────────────────────────────────────────────────────┐
     │ ПРИЁМКА (запускается вручную)                                │
     │  dashboard/verify-data.mjs (706 строк) — независимый пересчёт│
     │  dashboard/ux-check.mjs + run-ux-check.ps1 — ЗАМОРОЖЕНЫ      │
     │  dashboard/_ux-harness/test-*.mjs (e2e через HTTP), pytest   │
     └──────────────────────────────────────────────────────────────┘

ПУБЛИКАЦИЯ (отдельный контур): install/publish-dashboard.ps1 → build-publish.mjs
  → статический снимок install/publish/site (6 файлов) → serveo-туннель на порт 8899.
  Туннелируется ТОЛЬКО статика (read-only), живого API наружу нет:
  install/publish-dashboard.ps1:57 (static-server.mjs), :271-275; install/publish/last-url.txt
  («режим: только чтение, без API записи, без секретов»).
```

БД нет нигде: источник правды — YAML/JSONL/CSV в `marketing-agents/registry/**` и
`marketing-agents/01-competitor-watch/data/**`; панель лишь материализует их в
`marketing-agents/dashboard/public/data/*.json` (24 файла, все от 2026-11-04 21:08).

---

## 2. Инвентаризация API панели

### 2.1 Полный список маршрутов `dashboard/serve.mjs`

Разбор — цепочка `if (p === …)` от `serve.mjs:1010`; ниже — все обработчики в порядке файла.

| Строка | Метод | Маршрут | Пишет на диск | Валидация входа |
|--------|-------|---------|---------------|-----------------|
| 1022 | GET | `/api/health` | — | — |
| 1026 | GET | `/api/state` | **да**, при `?collect=1`: `public/data/**` | нет (флаг строки) |
| 1033 | **POST и GET** | `/api/collect` | **да**: `public/data/**` | нет |
| 1042 | GET | `/api/agents` | — | — |
| 1047 | POST | `/api/agents/:id/toggle` | **да**: `registry/agents.yaml` + `.bak` + `public/data/**` | `enabled` boolean; id — из URL |
| 1069 | POST | `/api/bulk/toggle` | **да**: `registry/agents.yaml` \| `sources.yaml` + `.bak` | `target` ∈ {agents,sources} |
| 1121 | POST | `/api/service/edit` | **да**: `registry/{clients,services,subscriptions,invoices,results}.yaml` + `.bak` | белый список полей `SERVICE_EDIT:222-230`, типы number/flag/array/token/scalar, `:1131-1144` |
| 1163 | POST | `/api/agent1/discover` | **да**: `data/candidates/*.json` (через Python) | параметры из `agent1.watch`, `runProcess` 300 с `:1188` |
| 1224 | POST | `/api/agent1/competitor-list` | **да**: `01-competitor-watch/config/clients/<id>.yaml` + `.bak` `:1238`,`:1301` | имя/домен/класс, нормализация `:499-508` |
| 1344 | POST | `/api/agent1/send-report` | **да**: письмо SMTP + `runs.jsonl`; Python 300 с `:1362` | адреса из конфига, потом white-list |
| 1398 | POST | `/api/agent1/candidate` | **да**: `data/candidates/<project>.decisions.json` `:1438` | решения по кандидату |
| 1506 | POST | `/api/agent-settings/set` | **да**: `registry/agent-settings/<agent>.yaml` + `.bak` `:1569` | **schema-driven**: `AGENT_SETTINGS_SCHEMA:86-215`, `:1512` id, `:1517` группа, `:1521` поле, `:1532-1550` тип/min-max/enum/time |
| 1594 | POST | `/api/ads/act` | **да**: `registry/ad-budgets.yaml` `:1624,1638,1676`; `cashback.yaml` `:1654,1666,1693,1706`; `operators.yaml` `:1716,1725` | по видам действий, суммы числом |
| 1737 | GET | `/api/ads/export` | **да**: попутно `collect({})` → `public/data/**`; отдаёт CSV | `what` ∈ {spends,channels,clients,accruals,act,operators,platform} |
| 1800 | POST | `/api/service/add-client` | **да**: `registry/clients.yaml` + `.bak` `:1824` | обязательные поля клиента |
| 1833 | POST | `/api/service/invoice` | **да**: `registry/invoices.yaml` + `.bak` `:1856` | клиент/период/сумма |
| 1865 | POST | `/api/service/run` | **да**: `runs.jsonl` `:1885,1906`; артефакт в `reports/clients/<client>/` `:1897-1902`; `public/data/**` `:1915` | услуга существует и `enabled:true` `:1870-1871`, клиент существует `:1874` |
| 1929 | POST | `/api/client/question` | **да**: `registry/client-questions.json` `:1958-1960` | topic/comment непустые |
| 1968 | POST | `/api/actions/run` | **да**: `collect.mjs` `:1977`, `build_weekly_report.py` `:1993`, `run_weekly.py` `:2010` (180 с) + их артефакты | `action` ∈ {collect,report,agent}, агент — только `agent-1-competitor-watch` `:2005` |
| 2030 | POST | `/api/settings/routing` | **да**: `~/.dsh/dsh-delegate-router.json` + `.bak` `:2041-2059` | `field` ∈ {flashModel,proModel}, модель обязана быть в `prices.yaml` `:2039` |
| 2075 | POST | `/api/settings/plugin` | **да**: `<профиль DSH>/package.json` + `.bak` `:2106-2112` | пакет объявлен в профиле `:2088`, запись в `protectReason` запрещена `:2080-2081`, нельзя оставить 0 бандлов `:2101` |
| 2141 | POST | `/api/settings/revert` | **да**: восстановление любого `.bak` `:2169-2177` | путь/имя бэкапа |
| 2195 | GET | `/api/settings/backups` | — | — |
| 2209 | POST | `/api/settings/set` | **да**: `settings.yaml` `:2221,2232,2244`, `prices.yaml` `:2252,2263`, `agents.yaml` `:2275,2281` + `.bak` | `ALLOWED_SETTINGS_BOOLS:441`, белый список полей, цены — только числа |
| 2332 | POST | `/api/vault/export` | **да**: заметки в Obsidian-vault (динамический импорт `collector/export-vault.mjs`) `:2336-2348` | `dryRun` флаг |
| 2374 | — | любой другой `/api/*` | — | отвечает 404 JSON |
| 2378 | — | остальное | — | `serveStatic`: 403 при выходе из `public/` `:984-988` |

**Итого 25 обработчиков API**; пишут на диск прямо или косвенно (через `collect({})`, `applyAtomicEdit`
и дочерние процессы) **22**: 19 — внутри проекта (включая отправку писем и запуск сборщика/движка),
3 — за пределами проекта: `~/.dsh/dsh-delegate-router.json`, `<профиль DSH>/package.json` и заметки в
Obsidian-vault. Чистых маршрутов только для чтения — 3: `/api/health` (`:1022`),
`/api/agents` (`:1042`), `/api/settings/backups` (`:2195`); `/api/state` (`:1026`) на диске не пишет
только без `?collect=1`.

### 2.2 Аутентификация

* Проверка ровно одна и стоит на входе: `!isLocalRequest(req) && !keyOk(req, url)` → 401/страница ключа
  (`serve.mjs:1013-1020`).
* `isLocalRequest` — по `remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`} (`:745-748`).
* `keyOk` — сравнение с ключом из `dashboard/config/access.key`, `timingSafeEqual` (`:727-743`, `:758-766`).
  Ключ создаётся сам при первом старте (24 случайных байта) и лежит в файле рядом с проектом
  (`:32`, `:728-742`).
* Ролей нет, скоупа нет, сессий нет: один ключ = полный доступ ко всем 25 маршрутам и **всем клиентам**.
* Ключ можно передать в query (`?key=`), заголовком `X-Dashboard-Key` или cookie (`:749-757`); при
  первом входе с ключом ставится cookie `dash_key`, `Max-Age=31536000`, `SameSite=Lax`, `HttpOnly`
  (`:1018-1019`). `Secure` не выставлен (сервер — plain HTTP, `http.createServer:1008`).
* Ключ печатается в консоль целиком и потому попадает в `dashboard/logs/server.out.log`
  (`serve.mjs:2404-2408`; лог — `install/dashboard-task.ps1:97`, `install/check-dashboard.ps1:111`).

### 2.3 Валидация входных данных

* Валидация **есть и местами строгая**: настройки агентов — по декларативной схеме
  (`serve.mjs:86-215`, применение `:1506-1560`); правка сервисных YAML — по таблице разрешённых полей и
  типов (`:222-230`, `:1131-1144`); запуск услуги требует существующей и включённой услуги и
  существующего клиента (`:1870-1874`); модель роутинга обязана быть в `prices.yaml` (`:2039`); пакет
  профиля — объявленным и не защищённым (`:2080-2089`).
* Тело запроса ограничено 1 МБ и парсится как JSON; при невалидном JSON возвращается `null`
  (`:963-978`), что часть обработчиков трактует как «пустой объект» (`:973`) — то есть мусорный body не
  ошибка, а пустой словарь.
* Чего нет: проверки типа/размера для `id` в `/api/agents/:id/toggle` (`:1047-1049`), нормализации
  URL для vault-экспорта, лимита на длину строк в свободных полях (`contact`, `note` —
  `SERVICE_EDIT:223`), схемы для `data/candidates/*`.

### 2.4 Лимиты, CSRF/Origin, TLS

* **Rate limit: отсутствует.** В `serve.mjs` нет ни счётчиков, ни throttle, ни `headersTimeout`
  (grep `limit` по файлу даёт только бизнес-поля схемы настроек).
* **Проверка Origin/Referer и CSRF-токен: отсутствуют.** grep `origin|referer|csrf` по
  `dashboard/**/*.mjs` не находит ни одной проверки в `serve.mjs` (совпадения — только про
  `origin` в данных сессий и `original` в именах переменных).
* **CSRF-поверхность реальна:** локальные запросы не требуют ключа (`:745-748`), а
  `GET /api/collect` и `GET /api/state?collect=1` перезаписывают `public/data/**` (`:1026-1040`).
  Любая веб-страница, открытая в браузере на этой машине, может дернуть их тегом `<img>`.
* **CSRF-защиты нет даже для изменяющих POST** — только `SameSite=Lax` у cookie (`:1019`), что
  блокирует cross-site POST с cookie, но не блокирует keyless-localhost сценарий выше.
* **TLS: нет** (`http.createServer`). Basic-auth/прокси-заголовки не поддерживаются;
  `x-forwarded-*` не читается, поэтому за обратным прокси `isLocalRequest` никогда не сработает, и
  доступ будет требовать ключ (это скорее плюс, но означает, что за прокси панель всегда «внешняя»).

### 2.5 Что мешает выставить панель наружу (прямой ответ)

Технически наружу панель **уже выставляется** — достаточно `DASHBOARD_HOST=0.0.0.0`
(`serve.mjs:784`) и ключа. Мешают не барьеры, а отсутствие эксплуатационного слоя:

1. **Один статический ключ без ротации и аудита** — утечка ключа = полный админ; отозвать можно
   только вручную удалив `dashboard/config/access.key` (`:32`, `:730-736`), при этом в логе остаётся
   старая копия ключа (`dashboard/logs/server.out.log:10`).
2. **Ключ в query-строке** (`:1018-1019`) — попадает в историю браузера и любые логи.
3. **Нет TLS** — ключ и содержимое отчётов по сети открытым текстом.
4. **Нет rate limit и CSRF/Origin** — брутфорс ключа и drive-by с локальной машины.
5. **Нет изоляции тенантов** — один ключ открывает данные всех клиентов (см. §3).
6. **Панель пишет за пределы проекта** — `<профиль DSH>/package.json`, `~/.dsh/dsh-delegate-router.json`,
   Obsidian-vault (`:37`, `:38`, `:60`, `:2075`, `:2030`, `:2332`). Это уже не «дашборд маркетинга», а
   пульт управления рантаймом агентов: выставлять его наружу нельзя без разнесения прав.
7. **Панель замирает на 180–300 с** на каждом запуске (`execFileSync:305,319`), т.е. публичный
   сервис немедленно превратится в недоступный под нагрузкой.
8. **Нет журнала доступа**: в панели вообще нет логирования запросов (единственные записи — старт
   сервера `:2398-2411` и непойманные исключения `:2382-2387`); инцидент нельзя разобрать.
9. **Дампы данных без разграничения** — `dashboard/public/data/tasks.json` (489 КБ) и
   `service.json` (51 КБ) содержат данные всех клиентов и отдаются как статика после гейта.

---

## 3. Multi-tenancy и изоляция клиентов

### 3.1 Как разделены данные сейчас

| Слой | Файл/каталог | Содержимое |
|------|--------------|------------|
| CRM/биллинг | `marketing-agents/registry/clients.yaml` | 4 клиента, `operator_id`, план, услуги (`:6-49`) |
| Операторы | `marketing-agents/registry/operators.yaml` | 3 оператора, 3 уровня «платформа → оператор → клиент» (`:3-8`, `:18-38`) |
| Подписки | `marketing-agents/registry/subscriptions.yaml` | 5 подписок, `price_rub`, `invoiced` (`:5-59`) |
| Счета | `marketing-agents/registry/invoices.yaml` | 3 счёта, «выставляются вручную, оплата вне MVP» (`:1`) |
| Кэшбэк | `marketing-agents/registry/cashback.yaml` | начисления/выплаты клиентам и операторам (`:11-34`) |
| Конфиг сбора | `marketing-agents/01-competitor-watch/config/clients/<client>.yaml` | расписание, получатели, источники, конкуренты |
| Снимки | `.../data/clients/<client>/snapshots/<date>/lots.csv` | по клиенту (2026-11-02…11-05) |
| Снимки «общие» | `.../data/snapshots/<date>/lots.csv` | **без клиента** (2026-10-23, 2026-10-30) |
| Отчёты | `.../reports/clients/<client>/<date>-competitor-watch.*` | по клиенту |

Плюс конфиг клиента содержит персональные данные получателей
(`config/clients/client-svet.yaml:50-53`) и контакты в `registry/clients.yaml:10,21,32,43`.

### 3.2 Изоляции тенантов нет — по четырём причинам

1. **В API нет понятия «тенант».** Единственная проверка — ключ (`serve.mjs:1013`); маршруты
   оперируют либо глобальными файлами (`registry/*.yaml`), либо клиентом по `id` из тела запроса
   без проверки прав (`:1865-1874`, `:1800`, `:1224`). Оператор `op-anna` не может получить доступ
   «только к своим двум клиентам» — доступ или полный, или никакой.
2. **Глобальное дерево снимков смешивает всех.** `data/snapshots/<дата>/lots.csv` не содержит клиента
   в пути, а ключ лота — `(source, competitor, project, lot_id)`
   (`00-admin/config/settings.yaml:166`, `01-competitor-watch/scripts/cwlib.py:30`), т.е. две
   одинаковые конкурирующие ЖК у разных клиентов дадут **один и тот же lot_id** и «схлопнутся».
3. **Панель читает именно глобальное дерево.** `SNAPSHOTS_DIR` = `data/snapshots` (`:44`),
   `snapshotDates()` фильтрует `^\d{4}-\d{2}-\d{2}$` (`:281-284`) → панель видит только 2026-10-23 и
   2026-10-30, а реальные клиентские снимки (11-02…11-05) не видит вовсе. Кнопки
   `/api/actions/run` (`:1972-1974`, `:1991-1993`) и `/api/service/run` (`:1877-1879`, `:1889`)
   строят отчёт по устаревшей глобальной дате.
4. **Отчёт не client-aware.** `build_weekly_report.py` получает только `--curr/--prev`
   (`serve.mjs:1889-1890`), а клиентский снимок он не читает; в runbook это признано открытым:
   `00-admin/runbook.md:225-226` («движок, когда появится client-aware режим; сейчас — обычный
   прогон по дате»). Поэтому `/api/service/run` записывает прогон **на клиента**, а артефакт кладёт
   из общего отчёта копированием в папку клиента (`:1897-1902`).

### 3.3 Что произойдёт при 20 клиентах

| Узкое место | Механика | Доказательство |
|-------------|----------|----------------|
| Последовательный сбор | `for client in clients` без нитей: 20 клиентов = 20× время одного прогона | `collect_clients.py:932`, `:940`; grep `threading/multiprocessing/concurrent.futures` — 0 |
| Ручные правки | 20 файлов клиентских конфигов + конкурентов внутри них; добавление конкурента — правка YAML | `config/clients/*.yaml`; `dashboard/serve.mjs:1224-1340`; `00-admin/runbook.md:246-267` |
| Нет транзакций | read-modify-write без блокировки, last-write-wins; `.bak` вместо версионирования | `serve.mjs:462-483` |
| Рост `.bak` | каждая правка — новая копия навсегда; уже 486 файлов / 3,0 МБ | `serve.mjs:470-473`; подсчёт: 159 в `registry/`, 159 в `01-competitor-watch/data/_f10-live-20261104/registry`, 60 в `00-admin/config` |
| Стоимость сбора | rate limits зашиты в паузы, а не в общий планировщик: 20 клиентов × N страниц к одному домену | `platforms.py:745` (sleep 0.4), `budget_sources.py:59,135`, `discover_competitors.py:400`, `search_results.py:443-475` |
| Расписание | планировщик ОДИН на всех клиентов (`--email-mode always` по всем), без приоритетов и без параллелизма | `install/agent1-weekly.cmd:24`; `install/agent1-weekly-task.xml` (`DaysOfWeek Thursday`, 11:00) |
| SMTP | 20 клиентов × адреса, по соединению на адрес, последовательно | `delivery_email.py:310-341` |
| Браузер | один Chrome на порт 9333/9344/9363/9364, запуск на страницу | `platforms.py:1018,1072-1073`; `competitor_profile.py:366`; `developer_site.py:54`; `web_search.py:153` |
| Панель | блокирующие запуски + 180–300 с таймауты; при 20 клиентах реальный сбор не уложится | `serve.mjs:305,319,1188,1362,1891,1993,2010`; факт: один клиент уже 278,7 с (`registry/runs.jsonl:27`) |

---

## 4. Биллинг и token-cost accounting

### 4.1 Что есть

* **Прайс моделей** — единственный источник: `marketing-agents/registry/prices.yaml`
  (schema `prices/v1`, 16 моделей, `rub_per_1m_in/out`, `usd_per_1m_*`, курс `rate.usd_rub`
  `:15-23`). Локальный `dashboard/config/prices.yaml` намеренно игнорируется
  (`dashboard/collector/lib/pricing.mjs:1,16,143-146`).
* **Услуги и цены** — `registry/services.yaml`: 3 услуги, `price_rub` 2900/9900/5900 и **`cost_rub`
  120/450/260** (`:13,25,37`).
* **Подписки и счета** — `subscriptions.yaml:14,25,36,47,58`, `invoices.yaml:1` («выставление вручную,
  оплата вне MVP»).
* **Кэшбэк** — `cashback.yaml:3` (формула `base × rate/100 + fixed`), три уровня доходов:
  клиент → платформа, платформа → оператор (`:23-31`), `operators.yaml:3-8,14`.
* **Журнал прогонов** — `registry/runs.jsonl` (27 записей), поля `run_id, ts, service, client,
  agent, status, duration_ms, cost_rub, artifact, error`.
* **Метрики расхода DSH-сессий** — `dashboard/collector/lib/sessions.mjs:46,160` + `aggregate.mjs:95-109`,
  результат в `dashboard/public/data/usage.json`: 2 071 724 316 токенов всего, **5 627,78 ₽**,
  `rubComplete: false` (часть моделей без цены кэша → оценка сверху,
  `pricing.mjs:207`).
* **Проверка сходимости** — `dashboard/verify-data.mjs:67-69` (маржа по услугам), `:146-147`
  (маржа платформы = комиссия − кэшбэк операторов), `:596-606` (независимый пересчёт прогонов из
  `runs.jsonl`).

### 4.2 Чего нет (ключевое)

1. **Учёт токенов на клиента отсутствует.** `usage.json` агрегирует DSH-сессии всех агентов
   (`collect.mjs:88`, `aggregate.mjs:95-109`) и не разложен по клиентам/услугам. Привязки
   «прогон → токены модели» нет ни в `runs.jsonl`, ни в `results.yaml`.
2. **Себестоимость прогона клиента — синтетическая.** `estimate_cost(model, chars_in, chars_out)`
   считает токены как `символы/4`, где `chars_in` — JSON собранных лотов (+120 знаков на строку), а
   `chars_out` — **суммарный размер файлов отчёта** (`collect_clients.py:468-480`, `:768-770`).
   Размер PDF/XLSX не имеет отношения к выходным токенам модели.
3. **LLM-вызовов в движке Агента 1 нет вообще** (grep `chat/completions|openai|anthropic|zveno` по
   `01-competitor-watch/**` — совпадений нет; единственные `Authorization` относятся к Keys.so/
   SpyWords/Serper, `budget_sources.py:274`, `web_search.py:129-131`). То есть «расход моделей» в
   отчётах клиента — это фикция оценки, а реальный расход возникает только в DSH-сессиях агентов,
   которые в биллинг клиентов не попадают.
4. **Лимиты не работают.** `model.limit_rub`, `model.limit_tokens`, `model.on_limit`
   (`serve.mjs:94-95`; `registry/agent-settings/agent-1-competitor-watch.yaml:19-20` = 3000 ₽ /
   2 000 000 токенов) не читает ни один исполняемый модуль: grep по `*.py`/`*.mjs` находит их только
   в схеме панели, в YAML и в экспорте
   (`dashboard/collector/export-vault.mjs:286`), плюс неотрицательность в приёмке
   (`verify-data.mjs:189`). Никакого `pause/stop/warn` по достижении лимита нет.
5. **Два разных правила себестоимости в одной панели.** Смета `services.yaml:13` (120 ₽) идёт в
   маржу услуги (`service.mjs:87-91`, `service.json`: `competitor-watch price=2900 cost=120
   margin=2780`), а аналитика считает доход/расход иначе — от фактических прогонов
   (`analytics2.mjs:57-90,153-170`). Фактические `cost_rub` прогонов — 0,13…1,27 ₽
   (`registry/runs.jsonl:3-27`), т.е. смета завышена примерно на два порядка.
6. **Прогон «на клиента» через API ставит сметную себестоимость, а не измеренную**:
   `cost_rub: proc.ok ? cost : 0`, где `cost = Number(svc.cost_rub)` (`serve.mjs:1882`, `:1910`).
7. **Атрибуция артефакта к клиенту формальна** (§3.2 п.4): клиентские деньги списываются за
   общий отчёт по дате.
8. **Полей под overage/лимиты в биллинге нет**: в `subscriptions.yaml` только `price_rub`,
   `invoiced`, `status` (`:13-15`), в `services.yaml` — `price_rub`/`cost_rub`; ни «включено в тариф»,
   ни «цена за превышение», ни «лимит прогонов».
9. **Сверка «доход↔подписка↔счёт» ручная**: `invoices.yaml` создаётся вручную (`:1`),
   `verify-data.mjs` сверяет только маржу, а не полноту выставления счетов по активным подпискам.

---

## 5. Схема данных, дубли и корни дефектов F12/F13

### 5.1 Контракт снимка

Зафиксирован в трёх местах, плюс четвёртое (устаревшее):

| Место | Что задаёт | Состояние |
|-------|-----------|-----------|
| `marketing-agents/00-admin/config/settings.yaml:145-178` | колонки (18), ключ лота, enum'ы, производные | канон |
| `marketing-agents/01-competitor-watch/scripts/SCHEMA.md:11-34` | тот же контракт для людей | совпадает |
| `marketing-agents/01-competitor-watch/scripts/cwlib.py:30-53` | исполняемый контракт валидатора | совпадает |
| **`marketing-agents/00-admin/runbook.md:448-454`** | шпаргалка | **устарела**: `source` без `developer-sites`, `delivery` только `YYYY-QN` |

Валидатор: `cwlib.py:412-425` (дата, source), `:427-429` (url), `:431-437` (rooms),
`REQUIRED_NON_EMPTY:33-36`, `FINISH_VALUES:37`, `STATUS_VALUES:38`, `DELIVERY_RE:53`,
`PRICE_MIN_EXCLUSIVE:46`, допуск по ₽/м² `:47`. Проверка заголовка и порядка колонок — `SCHEMA.md:75-80`.
Отдельные валидаторы: `00-admin/scripts/validate_config.py` (CLIENT_COMPETITOR_REQUIRED —
`config/clients/client-svet.yaml:19-20`) и `snapshot_tool.py:95` (`validate`).

### 5.2 Кто источник правды и где дубли

* **Источник правды:** `01-competitor-watch/data/**` (снимки, профили, бюджеты) + `registry/**`
  (клиенты, услуги, прогоны, результаты) + `config/clients/*.yaml` (состав конкурентов).
  Панель это **материализованная копия**: `dashboard/public/data/*.json` собираются `collect.mjs`
  (`dashboard/collector/collect.mjs:224`, список файлов `serve.mjs:849`).
* **Копия отстаёт.** Все 24 файла `public/data` — от `2026-11-04T18:08:43Z` (`meta.json`,
  `durationMs=3929`), а `registry/runs.jsonl` и `results.yaml` обновлены 2026-11-05 19:20. Панель
  показывает вчерашнюю картину до ручного пересбора.
* **Дубли одного и того же:**
  * себестоимость: `services.yaml:cost_rub` (смета) ↔ `runs.jsonl:cost_rub` (факт) — расходятся в ~100 раз;
  * себестоимость услуги на клиента: `service.json` (`priceRub/costRub/marginRub`) ↔
    `analytics2.json` (`byClient`/`byService`, доход от подписок, расход от прогонов);
  * состав конкурентов: `registry/clients.yaml` (`services`, `objects`) ↔ `config/clients/*.yaml`
    (`competitors`, `sources`) ↔ `registry/agent-settings/agent-1-competitor-watch.yaml` (`agent1.watch`);
  * снимки: `data/snapshots/**` ↔ `data/clients/<client>/snapshots/**`;
  * цены: `registry/prices.yaml` ↔ (игнорируемый) `dashboard/config/prices.yaml` ↔
    `dashboard/config/prices.example.yaml`;
  * enum `source`: `settings.yaml:168` ↔ `cwlib.py:43` ↔ `SCHEMA.md:16` ↔ `clients.py:40`
    (`KNOWN_SOURCES` в другом регистре дефисов: `yandex-realty`, `domclick`, `partner-feeds`,
    `manual-inbox`).
* **Мёртвые поля контракта.** Движок заполняет две обязательные колонки константами:
  `finish` всегда `"unknown"` и `status` всегда `"active"` (`collect_clients.py:229`, `:233`) —
  фильтры и срезы панели по отделке/статусу вырождены.

### 5.3 F12 «грязная колонка delivery» — корень

* Симптом: вместо срока сдачи в `delivery` попадали года и текст («ставка 13»), 105–209 строк на
  дату, `snapshot_tool validate` краснел на всех датах
  (`docs/audit/mvp-audit-engine.md:34`, `docs/session-start.md:71`).
* Корень: извлекатель `DELIVERY_RE` в `01-competitor-watch/scripts/platforms.py:103` делал суффикс
  «квартал» **необязательным** `(?:год|г\.|кв|квартал|Q([1-4]))?`, а контракт `SCHEMA.md` требовал
  строго `YYYY-QN`; проброс строки — `collect_clients.py:232` (`"delivery": lot.get("delivery") or ""`),
  проверка — `cwlib.py:53` + `settings.yaml:172`.
* Закрытие (04.11.2026): `DELIVERY_RE` принимает `YYYY` без квартала (`cwlib.py:52-53`),
  `SCHEMA.md:31`, `settings.yaml:172` расширены; `platforms.parse_delivery` берёт квартал **перед**
  годом и отбрасывает год рядом с ипотечными словами (`platforms.py:355-380`,
  `DELIVERY_NOISE_WORDS:356`).
* **Остаточный след:** ожидание теста закрепляло старый формат —
  `marketing-agents/01-competitor-watch/tests/test_clients.py:212`
  (`assertEqual(lots[0]["delivery"], "2027")`, см. `docs/audit/mvp-audit-engine.md:34`); новый
  контракт закрыт тестом `tests/test_clients.py:577-587` (год-без-квартала законен, «ставка 13% на
  2027 год» и «ипотека от 3% 2026 год» → пусто), но `runbook.md:454` по-прежнему описывает только
  `YYYY-QN`. Остаточные «года без квартала» в данных допустимы контрактом, поэтому постфактум
  не отличимы от дефекта без сырого текста страницы.
* Проверено по данным: в `data/snapshots/_paused-cian-2026-10-31/lots.csv` все 270 строк имеют
  корректный `YYYY-QN` (`2027-Q4` — 114, `2027-Q1` — 69, `2029-Q4` — 43 …), в
  `data/snapshots/_demo-site-zilart-2026-10-31/lots.csv` `delivery` пустой (16 строк).

### 5.4 F13 «source=developer-sites не проходит валидатор» — корень и незакрытый близнец

* Корень: словарь валидатора `SOURCE_VALUES` (`cwlib.py:40-43`) отставал от фактических значений,
  которые пишет движок; движок берёт идентификатор источника из клиентского конфига
  (`collect_clients.py:298`, `:319-338`) и кладёт в колонку через `platforms.status_column`
  (`collect_clients.py:217`), а `status_column` пропускает **неизвестный id как есть**
  (`platforms.py:134-139`). Симметричный дубль — маппинг платформ `platforms.py:66-76`.
* Закрытие: `developer-sites` добавлен в `SOURCE_VALUES` (`cwlib.py:43`) и уже был в
  `settings.yaml:168`; в контракт внёс пояснение комментарий `cwlib.py:40-42`. Итог —
  `docs/f12-f13-delivery-source-2026-11-04.md:29`, `docs/open-tasks-2026-11-04.md:24`.
* **Незакрытый близнец (`domclick`).** `platforms.PLATFORMS` содержит `domclick` со
  `status_column: "domclick"` (`platforms.py:73`), клиентский конфиг включает источник
  (`config/clients/client-svet.yaml:60`, «включено 04.11»), `clients.KNOWN_SOURCES` его содержит
  (`clients.py:40-41`), а в enum контракта снимка его **нет** (`settings.yaml:168`, `cwlib.py:43`) →
  как только Домклик отдаст хотя бы один лот, `cwlib.py:422-425` покрасит снимок ровно так же, как
  было с `developer-sites`. Сейчас дефект скрыт только тем, что площадка отдаёт 401
  (`client-svet.yaml:27`, `:60`).
* Проверено: в текущих снимках строк с `source=domclick` нет (в `_paused-cian-2026-10-31/lots.csv`
  все 270 строк — `cian`; в `_demo-site-zilart-2026-10-31/lots.csv` — `site`).

---

## 6. Эксплуатация

### 6.1 Установка, запуск, планировщик

* Панель: `install/dashboard-task.ps1` (регистрация задачи, `:155-158`), `:97` — запуск
  `node dashboard/serve.mjs` с логами в `dashboard/logs/server.{out,err}.log`; триггер — «при входе
  пользователя» (`:161`, `:226`), `MultipleInstances IgnoreNew`, `ExecutionTimeLimit 0`.
* Диагностика: `install/check-dashboard.ps1` (21,6 КБ) — поднимает панель при необходимости (`:111`),
  проверяет health, `api/state`, DOM, свежесть данных и запускает поведенческий `ux-check.mjs` через
  Chrome CDP (`:280-283`).
* Недельный цикл Агента 1: `install/agent1-weekly.cmd` → `collect_clients.py --email-mode always`,
  лог `logs/agent1-weekly.log` (`:23-26`); задача — `install/agent1-weekly-task.xml`
  (`<DaysOfWeek>Thursday`, 11:00, `StartWhenAvailable=true`, включена).
  **Состояние задачи в Планировщике прочитать не удалось** (запрос `Get-ScheduledTask` вернул
  ошибку доступа в песочнице) → `[НЕ ХВАТАЕТ ДАННЫХ]` о фактическом срабатывании.
* Ручной регламент — `00-admin/runbook.md` (467 строк): недельный цикл, действия при блокировках,
  откат, добавление клиента/конкурента, контракт данных. **Панель в runbook не описана вообще**
  (grep `8787|serve.mjs|access.key` — совпадений нет).
* Абсолютные пути зашиты: `install/agent1-weekly-task.xml` (`Command` = `C:\Users\Артем\Desktop\тестDH\...`),
  `dashboard/logs/server.out.log:3-5` — перенос машины/каталога ломает запуск.
* Деплой как таковой — ручные PowerShell-скрипты в `install/` (нет упаковки, нет версионирования
  релиза); отдельный «контур публикации» — `install/publish-dashboard.ps1` (статический снимок +
  временный serveo-URL).

### 6.2 Секреты и приоритет env vs файл

* Шаблон: `marketing-agents/.env.example` — 11 ключей (APIFY, RENTCAST, ZILLAPI, RENTSCOUT,
  MCP_ROSREESTR, REEFAPI…). Фактический `marketing-agents/.env` содержит **только 2**
  (`REEFAPI_KEY`, `REEFAPI_API`) → большинство опциональных интеграций не сконфигурировано (скиллы без
  ключа возвращают пустой список — `AGENTS.md`: «Без ключа скилл пишет предупреждение и возвращает
  пустой список»).
* SMTP-пароль: приоритет **env → файл** — `delivery_email.py:121-135` (`password_env` = 
  `DSH_SMTP_PASSWORD`, `:105`; затем `password_file`), путь задан в
  `00-admin/config/settings.yaml:100-101` → `00-admin/config/.smtp-password.local` (файл существует,
  17 байт). Транспорт: `smtp.yandex.ru:465`, `use_ssl: true`, отправитель зашит в конфиг
  (`settings.yaml:97-103`) — то есть адрес отправителя не секрет, а пароль вынесен во «внешний» файл.
* Риск: **git-репозитория нет** (`marketing-agents/.git` отсутствует), поэтому `.gitignore`
  (`marketing-agents/.gitignore`: `.env`, `.env.*`, `*.local`, `*.bak-*`, `logs/`) **ничем не
  исполняется** — секреты и бэкапы защищены только обещанием. Скрипты публикации в
  `install/**` не фильтруют `.env`/`.smtp-password.local` (grep `\.env|smtp-password|Exclude|secret`
  по `install/*.ps1` — 0 совпадений); спасение в том, что публикуется только статический снимок:
  `install/publish/site` содержит 6 файлов, и скрипт-сканер секретов отчитался `findings: []`
  (`install/publish/scan-report.json`), а в `site/data/state.js` писем/телефонов/абсолютных путей
  нет (проверено регулярками: 0 совпадений).
* Пароль от SMTP не нужен для запуска панели, но **ключ доступа панели утекает в лог** (§2.2).

### 6.3 CI/CD

* В проекте `marketing-agents/` нет ни `.github/`, ни `.gitlab-ci.yml`, ни Jenkins/Azure-пайплайнов,
  ни `.pre-commit-config.yaml` на корне (PowerShell-поиск по маскам вернул совпадения только внутри
  `marketing-agents/connectors/ru-marketplace-mcp/.github/**` — это чужой вложенный репозиторий
  коннектора). **CI/CD для самого проекта отсутствует.**
* Приёмка — ручные и полуручные гейты: `node dashboard/verify-data.mjs` (выход 0/1),
  замороженный `ux-check.mjs` (+`run-ux-check.ps1`), `install/check-dashboard.ps1`,
  e2e-скрипты `dashboard/_ux-harness/test-*.mjs`, `pytest` в `01-competitor-watch/tests` (18 файлов
  `test_*.py`) и `tests/plugin-contract.test.mjs` (единственный файл в корневом `tests/`).
  Запуск этих гейтов никем не автоматизирован (нет триггера на изменение).
* Регресс по API панели держится на `_ux-harness` (`test-toggle-e2e.mjs`, `test-selection-e2e.mjs`,
  `test-agent1-truth-e2e.mjs`), что хорошо по идее, но эти тесты не входят в `tests/` и не запускаются
  автоматически.

### 6.4 Логи, трейсинг, ротация

* Логи панели: только stdout/stderr процесса — стартовая сводка (`serve.mjs:2398-2411`) и
  непойманные исключения (`:2382-2387`). **Журнала HTTP-запросов нет вообще**, поэтому нет ни
  доступа, ни длительности, ни ошибок по маршрутам. `dashboard/logs/server.err.log` — 0 байт,
  `server.out.log` — 987 байт (от 2026-11-03).
* **Request id отсутствует**: grep `requestId|traceId|req.id|randomUUID` по панели не находит ничего
  (совпадения — только в `00-admin/scripts/cdp-eval.mjs:136` (CDP) и `landing/tools/serve.mjs:111`).
  Связать ответ API с записью в `runs.jsonl` или письмом нельзя.
* Логи движка: `logs/agent1-weekly.log` (13 КБ, 2026-11-05), `data/source-runs.jsonl` (23 КБ, журнал
  по источникам), `reports/.cache/*` — полезные, но текстовые.
* **Ротации нет**: `.cmd` дописывает лог через `>>` (`install/agent1-weekly.cmd:23-26`), файлы `.bak`
  не удаляются (`serve.mjs:470-473`), в `install/*.ps1` нет ни `Rotate`, ни ограничения размера.
* Наблюдаемость в панели — «внутренняя»: `verify-data.mjs` умеет независимо пересчитывать метрики
  (`:596-606`, `:614-622`), есть `alerts.json`, `agent1-status.json` (`agent1-status.mjs:174-189`,
  включая `sourceOfTruth`). Это сильная сторона, но она включается вручную.

---

## 7. Узкие места масштабируемости: таблица и «что упрётся первым»

| Узкое место | Механика | Оценка «когда» | Доказательство |
|-------------|----------|----------------|----------------|
| **Синхронные запуски в панели** | `execFileSync` в одном потоке; пока идёт прогон, панель мертва; таймауты 60/180/300 с | немедленно: 2+ оператора или прогон > 180 с | `serve.mjs:21,305,319,342`, вызовы `:1188,1362,1891,1977,1993,2010` |
| **Последовательный сбор по клиентам** | `for client in clients` без параллелизма; время линейно по числу клиентов | 5–10 клиентов (один клиент уже до 278,7 с) | `collect_clients.py:932,940`; `registry/runs.jsonl:27` |
| **Расколотый источник правды снимков** | панель читает глобальное дерево (последнее 2026-10-30), факты клиентов в другом дереве | уже сейчас: панель строит отчёты по устаревшим датам | `serve.mjs:44,281-284,1889,1991-1993`; `data/snapshots/` vs `data/clients/*/snapshots/` |
| **Нет очереди и ретраев** | `max_parallel`/`retries` — только YAML+схема, потребителей нет; упавший прогон не переигрывается | первый же сетевой сбой недельного цикла | grep `max_parallel|retries` → только `serve.mjs:99` и YAML; `install/agent1-weekly.cmd` — один проход |
| **Rate limits площадок** | паузы зашиты в код (0,4 с; 1,05 с; 1 с; 5 с), общего планировщика запросов нет | 20 клиентов × страницы к одному домену → 439/401/капча | `platforms.py:745`, `budget_sources.py:59,135`, `discover_competitors.py:400`, `search_results.py:443-475`; факты блокировок: `config/clients/client-svet.yaml:24-27` (Авито 439, Домклик 401) |
| **Chrome CDP для Авито/сайтов** | фиксированные порты 9333/9344/9363/9364, запуск браузера на страницу, ручной `start-chrome-cdp.ps1` | второй параллельный клиент → конфликт портов; ручной шаг в недельном SLA | `platforms.py:1018,1072-1073`; `competitor_profile.py:366`; `developer_site.py:54`; `web_search.py:153`; `00-admin/scripts/start-chrome-cdp.ps1` |
| **SMTP как транспорт** | соединение+login на каждого получателя, без пула, без ретраев; ошибка → `.eml` и статус | 20 клиентов × адреса в один четверг; лимиты провайдера не проверялись | `delivery_email.py:310-341` |
| **Fail-open белый список** | нет/нечитаем список → рассылка без ограничений | при потере `settings.yaml` | `delivery_email.py:140-143,158-166` |
| **Панель как монолит** | 24 JSON, `tasks.json` 489 КБ, клиентский JS 475 КБ / 17 файлов, рендер целиком в браузере | заметное замедление интерфейса при росте реестра | `dashboard/public/data/tasks.json`, `dashboard/public/*.js`; `serve.mjs:849` |
| **Рост `.bak` и мусор в дереве** | копия на каждую правку, без TTL; уже 3,0 МБ и 486 файлов | линейно от числа правок при 20 клиентах | `serve.mjs:470-473`; подсчёт `.bak-*` = 486 |
| **Панель не собирает данные** | «запуск агента» = `run_weekly.py --skip-sources`; сбор только через `.cmd`/Планировщик | владелец продукта жмёт «Запустить» и не получает свежих данных | `serve.mjs:2010`; `install/agent1-weekly.cmd:10-11` |
| **Биллинг без метеринга** | расход на клиента не измеряется (эвристика), лимиты не работают | первый клиент с превышением/возвратом по факту расхода | §4.2 п.1–4; `collect_clients.py:468-480`; `serve.mjs:94-95` |

### Где упрётся первым (обоснование)

**Первым упрётся связка «блокирующие запуски в панели + последовательный сбор», а не SMTP и не
площадки.** Основания:

1. Уже сегодня один реальный прогон по одному клиенту занял **278,7 с** (`registry/runs.jsonl:27`),
   что **больше** таймаута запуска процессов в панели (180 с — `serve.mjs:1993`, `:2010`; 300 с —
   `:1188`, `:1362`). То есть при первом же реальном сборе через панель запрос будет оборван по
   таймауту, а прогон помечен неуспешным.
2. Запуски синхронные (`execFileSync`, `serve.mjs:305`), поэтому на всё время прогона панель не
   отвечает: с одним оператором это «подвисание», с двумя — отказ обслуживания.
3. Это наступает на клиентах «пятого-десятого», тогда как лимиты площадок и SMTP начинают болеть
   при полной 20-клиентской нагрузке — и то лишь если сбор вообще уложится в таймаут.
4. Второй по срочности — **расколотый источник правды снимков** (панель уже сейчас строит отчёты по
   2026-10-30, пока реальные данные — за 2026-11-05): это не «упрётся потом», это неверные цифры
   в интерфейсе сейчас.

---

## 8. Открытые вопросы без данных

1. **Фактическое срабатывание планировщика** Agent1-Weekly: XML есть
   (`install/agent1-weekly-task.xml`), но прочитать состояние задачи в Планировщике из песочницы не
   удалось (ошибка доступа) → `[НЕ ХВАТАЕТ ДАННЫХ]`: когда был последний автозапуск, не отключена ли
   задача, не настроен ли другой пользователь.
2. **Лимиты SMTP-провайдера** (Яндекс 360) на число соединений/писем в сутки и санкции за
   превышение: в конфиге только хост/порт/логин (`settings.yaml:97-103`), требований провайдера в
   проекте нет → `[НЕ ХВАТАЕТ ДАННЫХ]`.
3. **Реальные токены моделей на клиента/прогон**: метеринга нет (§4.2). Даже знак величины
   себестоимости прогона не подтверждён ничем, кроме эвристики «символы/4» →
   `[НЕ ХВАТАЕТ ДАННЫХ]`, нужно решение о том, где будет учёт (панель, DSH-профиль или внешний биллинг).
4. **Договорные лимиты площадок и платных API** (Циан API, Авито партнёрский доступ, Keys.so,
   SpyWords, Serper): в коде только паузы и ключи; квот/RPS/цен по договорам нет →
   `[НЕ ХВАТАЕТ ДАННЫХ]`.
5. **Профиль нагрузки на панель**: сколько одновременных операторов/клиентов ожидается, какой SLA по
   времени ответа — не зафиксировано ни в `docs/**`, ни в `00-admin/**` → `[НЕ ХВАТАЕТ ДАННЫХ]`;
   без него нельзя выбрать между «поднять HOST + ключ» и разделением сервисов.
6. **Замер объёма данных при 20 клиентах**: сколько будет весить `registry/**`,
   `public/data/**`, дерево `data/clients/**` и время сборки — замеров нет (есть только 4 клиента и
   2 клиентских дерева снимков) → `[НЕ ХВАТАЕТ ДАННЫХ]`.
7. **Резервное копирование/DR вне машины**: `.bak-*` рядом с исходником — это не бэкап; скриптов
   выгрузки/восстановления копий (вне `install/force-rollback.ps1` для профиля) и политики хранения не
   найдено → `[НЕ ХВАТАЕТ ДАННЫХ]`.
8. **История дефектов по API панели**: отчёты `ux-report.json` и
   `dashboard/ux-report-known-defect-T73.md` есть, но систематического журнала инцидентов
   (когда панель была недоступна, кто дергал API) нет из-за отсутствия журнала запросов (§6.4) →
   `[НЕ ХВАТАЕТ ДАННЫХ]`.
9. **Юридический статус платформы и налоговая схема** (`operators.yaml:15`: `ipo_registered: false`,
   режим «через сервис» заблокирован) — в этом аудите не разбирался, есть отдельные документы
   (`docs/hosting-legal.md`, `docs/decisions-monetization-v2.md`); вопрос о влиянии на биллинг
   остаётся открытым.
10. **Временные каталоги прогонов в корне проекта** — 20 каталогов `cw-*` рядом с кодом
    (`cw-analytics-*` ×4, `cw-lot-history-*` ×6, `cw-mail-*` ×4, `cw-cdp-profile-*` ×3,
    `cw-budgets-*`, `cw-history-*`, `cw-real-budgets-*`), плюс `01-competitor-watch/data/_f10-live-20261104/**`
    (235 файлов, включая полную копию `registry/` со 159 `.bak-*`). Это артефакты прогонов, но они
    лежат в рабочем дереве и попадают в любые обходы (`glob`, подсчёты, публикацию) →
    `[НЕ ХВАТАЕТ ДАННЫХ]` о политике очистки и о том, нужны ли старые `cw-cdp-profile-*` (профили
    Chrome могут содержать cookies сессий).
