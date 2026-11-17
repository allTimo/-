# Аудит multi-agent слоя marketing-agents (задача task-1)

Дата: 2026-11-08. Аудитор: teammate `agent-layer`. Метод: только чтение + grep/read с offset.
Ничего не запускалось (collect_clients.py / run_weekly.py / ux-check.mjs / панель не вызывались),
код и `registry/**` не менялись. Каждое утверждение — с ссылкой `путь:строка`.
Где факта нет — стоит `[НЕ ХВАТАЕТ ДАННЫХ]`.

Внешние факты, принятые от Lead'а без перепроверки: в коде marketing-agents нет ни одного вызова
LLM API (`chat/completions`, `api.deepseek`, `api.openai`, `completion()` — 0 совпадений); при этом
`registry/agents.yaml:13` задаёт `model`, а `01-competitor-watch/scripts/collect_clients.py:488-491`
возвращает ярлык `deepseek/deepseek-v4.1-flash`.

---

## 0. Резюме: агентского слоя в работающем виде нет

| Контур | Состояние | Доказательство |
|---|---|---|
| «Агент 1» как LLM-агент | **отсутствует**: детерминированный конвейер на stdlib, LLM не вызывается | §3 |
| Реестр агентов как контракт | **декларация**: `inputs`/`outputs` — свободные строки без схемы и валидации | `registry/agents.yaml:18-19`, `dashboard/collector/lib/registry.mjs:41-42` |
| Системные настройки агента (модель/лимит/ретраи/таймаут/алерты/стоп-кран) | **декорация**: панель их валидирует и показывает, движок не читает ни одного | §1.3 |
| Расписание | **два источника, не связанных**: YAML ≠ фактический триггер Windows | `registry/agent-settings/agent-1-competitor-watch.yaml:9-15` × `install/agent1-weekly-task.xml:9,12` |
| Тумблер «агент включён» | **не управляет исполнением**: расписание не смотрит `enabled` | `dashboard/serve.mjs:915-946` × `install/agent1-weekly.cmd:24` |
| Стоимость прогона | **фиктивная оценка** по символам, не по токенам | `collect_clients.py:468-480,768-770` |
| Observability | нет correlation id; три несогласованных писателя журнала; лог нечитаем как UTF-8 | §2.6 |
| Версионирование | .bak/SHA-256 — только для файлов панели; VCS в дереве нет | §4 |

Топ-5 проблем (severity) — в сообщении Lead'у; ниже полный разбор с доказательствами.

---

## 1. Реестр агентов, контракты, триггеры

### 1.1 Что объявлено

- `registry/agents.yaml:4-5` — `version: 1`, `updated: "2026-10-31"`; четыре агента: `:8-21` agent-1, `:23-36` agent-2, `:38-49` agent-3, `:51-61` agent-4.
- agent-1 (`:11-21`): `enabled: true`, `status: active`, `model: "deepseek/deepseek-v4.1-flash"` (`:13`), `model_hint` (`:14`), `schedule: "weekly:thursday:11:00"` (`:17`), `inputs: [...]` (`:18`), `outputs: [...]` (`:19`), `runbook: "00-admin/runbook.md"` (`:20`).
- agent-2/3/4: `enabled: false`, `status: planned` (`:26-27,41-42,54-55`); у agent-4 `schedule: "weekly"` без дня и времени (`:59`).
- Тонкие настройки: `registry/agent-settings/agent-1-competitor-watch.yaml` — `schedule` (`:9-15`), `model` + лимиты (`:17-21`), `priority` (`:23-27`), `report` (`:29-33`), `delivery` (`:35-43`), `alerts` (`:45-48`), `limits` (`:50-53`), `agent1` (`:55-79`), `agent1.selection` (`:84-99`), `agent1.analytics` (`:106-114`), `agent1.competitor_domains` (`:120-121`), `agent1.source_modes` (`:136-141`).
- Схема тонких настроек описана в `registry/README-agents-settings.md:12-20` (общие группы), `:82-98` (типы/диапазоны `agent1.selection`), `:150-151` (агенты `status: stub` — поля неактивны, сохранять нельзя), `:155-160` (что проверяет `verify-data.mjs`).

### 1.2 Контракты входов/выходов: схемы и валидации нет

- В `agents.yaml` `inputs`/`outputs` — строковые литералы; валидатора нет. Сборщик панели просто приводит их к строкам: `dashboard/collector/lib/registry.mjs:41-42` (`inputs: asArray(raw.inputs).map(String)`, то же для `outputs`). Ни одна проверка не сверяет их с фактическими путями: `registry/agents.yaml:18` обещает `"cian-connector"`, `"avito-connector"`, `"registry/intake/inbox"`, `"01-competitor-watch/inbox"`.
- Единственный реально типизированный и валидируемый контракт в проекте — **снимок лотов (CSV)**, и он лежит в коде движка, а не в реестре: `01-competitor-watch/scripts/cwlib.py:23-28` (`COLUMNS`), `:30-36` (`KEY_COLUMNS`, `INT_COLUMNS`, `FLOAT_COLUMNS`, `REQUIRED_NON_EMPTY`), `:37-38` (`FINISH_VALUES`, `STATUS_VALUES`), `:43` (`SOURCE_VALUES`); проверка — `snapshot_tool.py:95-116` → `cwlib.validate_file`.
- Второй типизированный контракт — группы `agent1.*` тонких настроек: нормализация и диапазоны в `marketing_settings.py:208-311` (`_normalise_selection`), `:313-361` (`_normalise_watch`), `:371-417` (`_normalise_agent1`); при неизвестном ключе — warning и значение сохраняется (`marketing_settings.py:26-28,307-308`).
- Третий — схема правки настроек на стороне панели: `dashboard/serve.mjs:88-112` (`AGENT_SETTINGS_SCHEMA`: `enabled`, `only_on_new_data`, `name`, `on_limit`, `limit_rub`, `limit_tokens`, `max_parallel`, `timeout_sec`, `retries`, `auto_send`, `copy_to`, `addresses`, `price_threshold_pct`, `quiet_hours`).
- Для агентов 2-4 контрактов нет вовсе: `registry/agent-settings/agent-2-direct-semantics.yaml:5-6` — `status: stub`, «Агент 2 ещё не реализован: поля показаны для примера и остаются неактивными — сохранять нельзя».

### 1.3 Настройки, которые никто не читает (главный дефект реестра)

Проверка: grep по `01-competitor-watch/scripts/*.py` по `retries|timeout_sec|limit_rub|limit_tokens|only_on_new_data|on_limit|min_interval_hours|skip_weekends|stop_switch` — совпадений по существу **нет** (найдены только `log_source_run.py:96` — свои 12 попыток записи файла под локом, и `search_results.py:466-467` — 3 повтора пустой поисковой выдачи). Grep по `*.py` всего проекта по `alerts|quiet_hours` — **0 совпадений**.

| Поле | Объявлено | Валидируется панелью | Читает движок | Итог |
|---|---|---|---|---|
| `priority.timeout_sec: 900` | `agent-settings/agent-1-competitor-watch.yaml:26` | `serve.mjs:99` | нет | таймаут прогона не ограничен; панель режет по-своему — 300 с |
| `priority.retries: 2` | `:27` | `serve.mjs:99` | нет | повторов прогона/источника нет |
| `model.limit_rub: 3000`, `limit_tokens: 2000000`, `on_limit: pause` | `:19-21` | `serve.mjs:94-95`, `verify-data.mjs:189` | нет | лимит расхода не может сработать |
| `schedule.only_on_new_data: true` | `:15` | `serve.mjs:88` | нет | «только при новых данных» не реализовано |
| `limits.skip_weekends / min_interval_hours: 168 / stop_switch` | `:51-53` | схема есть | нет | стоп-крана нет |
| `alerts.when: [fail, low_data] / quiet_hours` | `:46-48` | `serve.mjs:112` | нет | алертов нет вообще (0 совпадений) |
| `report.sections: [5 пунктов]` | `:31` | — | нет | мёртвое поле (совпадает с ранее найденным D5) |
| `delivery.channels/auto_send/addresses` | `:40-42` | `serve.mjs:107` | **да** | `delivery_email.py:85-86` (`auto_send`), `:187-210` (`recipients_from`), `:138-165` (белый список) |

Важно: сами настройки в карточке агента не показываются — `registry/README-agents-settings.md:123-124` («Системные группы `schedule`, `model`, `priority`, `limits`, `source_agent` в карточке агента **не показываются**»). То есть системные поля и не видны человеку, и не действуют.

### 1.4 Триггер: что реально запускает Агента 1

- Фактический триггер — задача Планировщика Windows из `install/agent1-weekly-task.xml`: `:4` `URI \Agent1-Weekly`, `:9` `StartBoundary 2026-11-05T11:00:00`, `:12` `<DaysOfWeek><Thursday /></DaysOfWeek>`, `:24` `MultipleInstancesPolicy IgnoreNew`, `:28` `ExecutionTimeLimit PT2H`, `:33-34` Command = `…\install\agent1-weekly.cmd`, WorkingDirectory = `…\тестDH`.
- `install/agent1-weekly.cmd:16-18` — поиск Python (venv → `.venv` → `py`); `:23,26` — запись в `logs/agent1-weekly.log`; `:24` — `collect_clients.py --email-mode always`; `:29` — `exit /b %RC%`.
- **Расписание в реестре не связано с триггером.** `registry/agents.yaml:17` (`weekly:thursday:11:00`) и `registry/agent-settings/agent-1-competitor-watch.yaml:9-15` — только текст: ни один скрипт их не читает (grep по `agents.yaml` в `01-competitor-watch/*.py` даёт единственное совпадение — `collect_clients.py:485`, и оно берёт только `model`). При этом `START-HERE.md:27` утверждает: «Расписание задаётся в `registry/agent-settings/agent-1-competitor-watch.yaml`» — **неверно**.
- Тумблер `enabled` не влияет на исполнение: он только переписывается панелью (`serve.mjs:915-946`, `:1063`) и читается для отображения (`serve.mjs:903`). Проверка `enabled !== true` есть только у услуг: `serve.mjs:1871` смотрит `services.yaml`, не `agents.yaml`. Выключение Агента 1 в реестре не остановит четверговый прогон.
- Два конкурирующих описания запуска: `install/agent1-weekly.cmd` (реальный) и подсказка `collect_clients.py:866-873`, которая предлагает `schtasks /Create … run_client.ps1 -Client <id>` — другой скрипт и другая схема (по клиенту, а не общий прогон). Скрипта регистрации задачи для Агента 1 в дереве нет: `Test-Path install/agent1-weekly-task.ps1` → **False**, при том что `install/agent1-weekly.cmd:4` на него ссылается. Единственная регистрация задачи в репозитории — панельная (`install/dashboard-task.ps1:178`).
- Второй триггер — панель: `serve.mjs:1344` `POST /api/agent1/send-report` → `collect_clients.py --email-mode on-request --send-only` с таймаутом 300 000 мс (`serve.mjs:1361-1362`); подбор конкурентов — `serve.mjs:1188` (тоже 300 000 мс); «сформировать отчёт» — `serve.mjs:1889-1891` (`build_weekly_report.py`, таймаут 180 000 мс).

### 1.5 Точки отказа реестрового слоя

1. `enabled`/`schedule`/`status` не участвуют в решении о запуске → расхождение реестра и реальности незаметно (§1.4).
2. `agents.yaml` правит панель и читает движок без схемы: `collect_clients.py:483-491` парсит YAML мини-парсером и молча падает на дефолт (`deepseek/deepseek-v4.1-flash`) при любой ошибке (`:489-491`).
3. Модель объявлена дважды — `agents.yaml:13` и `agent-settings…yaml:18`; расчёт стоимости берёт первую (`collect_clients.py:485`), панель показывает вторую (`serve.mjs:94`, `collector/lib/agent-settings.mjs`) → расхождение не диагностируется.
4. `install/agent1-weekly.cmd:4` ссылается на несуществующий файл (реинсталляция «по комментарию» упадёт).

---

## 2. Реальное исполнение «Агента 1»

### 2.1 Границы ответственности

Движок живёт целиком в `01-competitor-watch/scripts/` (28 модулей Python, только stdlib по `snapshot_tool.py:15`); клиентские данные — `01-competitor-watch/config/clients/<client-id>.yaml`; настройки агента — `registry/agent-settings/…`; реестры — `registry/**` (пишет движок); отчёты и снимки — `01-competitor-watch/reports|data/**`. Разделение по шагам есть, но оно **внутрифункциональное**, а не агентное: нет ни «планировщика шагов», ни очереди, ни состояния задачи между шагами.

### 2.2 Шаги прогона (scheduled-путь)

`install/agent1-weekly.cmd:24` → `collect_clients.py:main` (`:910-964`):

1. загрузка клиентов `clients_mod.load_clients` (`collect_clients.py:924`) — `01-competitor-watch/scripts/clients.py`;
2. на клиента — `run_client` (`:659`): валидация конфига (`:661` → `clients_mod.validate_client`; при проблемах выход `:665-668`);
3. чтение тонких настроек `ms.load` (`:670`) и печать warnings (`:671-672`);
4. сбор источников `collect_client` (`:689`, тело `:238-403`): цикл по `clients_mod.KNOWN_SOURCES` (`:298`), сбор по конкуренту (`:317-339` → `platforms.collect_platform` `platforms.py:1018`), идентичность и дедуп лотов (`:262-296`), фильтры `agent1.selection` (`:385-388` → `ms.filter_rows`), текст ограничений (`:388` → `ms.selection_limitations`);
5. запись снимка `write_snapshot` (`:709` → `:448-453`) в `data/clients/<id>/snapshots/<date>/lots.csv`;
6. журнал источников (`:773-779` → `log_source_run.append_entry`);
7. недельное и месячное сравнение `compute_payload` (`:724,727`);
8. отчёт и аналитика `client_report.build_client_report` (`:744-751`);
9. `md/xlsx/docx/pdf`(+`.eml`) — `client_report.py` (`:206-222` конвертация docx→pdf, таймаут 180);
10. запись прогона `registry/runs.jsonl` (`:781-789`) и результата `registry/results.yaml` (`:800-818`);
11. почта — `delivery_email.py` (`:326-329` SMTP/STARTTLS, таймаут 60).

Совместимый алиас `run_weekly.py:42-108` (sources → validate → normalize → diff → отчёт) сам данные не собирает и в расписании не участвует — это прямо сказано в `install/agent1-weekly.cmd:10-11`.

### 2.3 Ретраи

Повторов прогона/шага/источника **нет**. Единственные «ретраи» в дереве:
- `search_results.py:462-478` — до 3 повторов при пустой поисковой выдаче (операторский поиск, не сбор лотов);
- `log_source_run.py:96-133` — 12 попыток записи журнала под файловым локом (`:58-94`), с fallback-записью `:124-130`.

### 2.4 Таймауты

Таймауты только на отдельные сетевые/процессные операции, не на прогон: `platforms.py:599` (`http_fetch(timeout=25)`), `platforms.py:764` (`cdp_html timeout=90`), `platforms.py:839` (`timeout=120`), `cian_connector.py:85,155,205` (240/300/120), `collect_clients.py:96` (180), `delivery_email.py:326-328` (60), `budget_sources.py:114,277` (40/60), `developer_site.py:59` (25). Объявленный `priority.timeout_sec: 900` не применяется (§1.3); при этом панель запускает движок с 300 000 мс (`serve.mjs:1188,1362`) и 180 000 мс (`:1891`) — три разных «таймаута одного и того же агента».

### 2.5 Обработка ошибок

- Сетевые ошибки локализованы: `platforms.py:616-629` — `HTTPError` и любой `Exception` превращаются в `(status, "", error)` без исключения наружу; статус источника становится честным (`no_data`/`needs_browser`/`needs_partnership` — `platforms.py:639-658`).
- Но въюконвейере клиента `try/except` почти нет: в `collect_clients.py` всего 12 вхождений `try` (`:78,93,440,470,484,935` — по grep `except|try:`), и ни один не оборачивает шаги 4-11 из §2.2. Исключение в `collect_client`/`build_client_report` не ловится: цикл `for client in clients: summaries.append(run_client(...))` (`:940-941`) рвётся, остальные клиенты не собираются, `main` не возвращает код — процесс падает трейсбеком.
- Отдельно: `collect_client` не проверяет `platforms.collect_platform` на исключение (`:331-339`) — расчёт на то, что внутри всё поймано.

### 2.6 Стоимость и учёт токенов

- Токены **не считаются**: LLM не вызывается. «Себестоимость» моделируется: `estimate_cost(model, chars_in, chars_out)` (`collect_clients.py:468-480`) берёт `rub_per_1m_in/out` из `registry/prices.yaml:26-36` и считает `tokens = chars/4`.
- Вход для оценки выдуман: `chars_in = sum(len(json.dumps(item)) for item in results) + len(rows) * 120` (`collect_clients.py:768`) — константа 120 символов на лот; `chars_out` — сумма размеров файлов отчёта (`:769`).
- Результат: `cost_rub` пишется в `runs.jsonl` (`:786`), в `results.yaml` (через `:824`), показывается в панели как «себестоимость прогонов» (`dashboard/collector/lib/analytics2.mjs:168`). В `registry/runs.jsonl` это видно: запись `run-33784740 … "cost_rub": 0.8886`, ранняя `run-mvwy9w5o … "cost_rub": 120`.
- Следствие: расход и лимит (`model.limit_rub`, `limit_tokens`, `on_limit`) — числа-оценки без связи с фактом; счётчика реальных токенов в проекте нет.

### 2.7 Логи и трейсинг

| Канал | Формат | Кто пишет | Что видно |
|---|---|---|---|
| `logs/agent1-weekly.log` | смешанный (cmd — OEM/cp866, Python — UTF-8) | `install/agent1-weekly.cmd:23,26` + stdout движка (`:24`, `2>&1`) | шаги, статусы источников, ошибки |
| `01-competitor-watch/data/source-runs.jsonl` (72 записи) | 6 полей, append под локом | `log_source_run.py:31,96-133` | `ts, source, status, lots, projects, note` |
| `registry/runs.jsonl` (27 записей) | две разные схемы | 3 писателя (см. ниже) | `run_id, ts, service, client, agent, status, duration_ms, cost_rub, artifact, error`; у 8 записей ещё `kind, sha256_before/after, found` |
| `skills/logs/skill-runs.jsonl` (2269 записей) | JSONL | `skills/runtime/core.py:43` | вызовы скиллов; к Агенту 1 не относится (§5) |

- **Лог не читается как UTF-8**: `read logs/agent1-weekly.log` → «invalid UTF-8 text»; первый невалидный байт — `0x80` на смещении 5937 (проверено `UTF8Encoding(false,true)`), т.е. в одном файле перемешаны UTF-8 (вывод Python) и cp866 (строки `echo [%DATE% %TIME%]` из `agent1-weekly.cmd:23,26`). Машинный разбор лога невозможен.
- **Correlation id отсутствует как связь.** `run_id` есть в `runs.jsonl` (`collect_clients.py:781-782` — `sha1(...)[:8]`; `discover_competitors.py:740`; `serve.mjs:1880` — `'run-' + Date.now().toString(36)`), но он не печатается ни в лог, ни в `source-runs.jsonl` (`log_source_run.py:31` — поля фиксированы и `run_id` среди них нет). Связать строку лога с записью журнала нельзя; три писателя ещё и генерируют id по разным правилам, так что «кто писал» по id не определить.
- **Три писателя `registry/runs.jsonl` без блокировки**: `collect_clients.py:494-500` (`open(path,"a")`), `discover_competitors.py:748-749` (то же), `serve.mjs:232-233` (`fs.appendFileSync`). Лок есть только у `source-runs.jsonl` (`log_source_run.py:58-94`) — и его докстрока (`:8-10`) прямо объясняет, зачем он нужен при параллельных запусках. Для `runs.jsonl` такой защиты нет при том, что панель и движок пишут туда одновременно.
- Машинная строка `EMAIL_RESULT {…}` в stdout — единственный машинный контракт доставки, панель её парсит (`serve.mjs:1365-1366`).

---

## 3. Агент 1 — это детерминированный конвейер, а не LLM-агент

**Подтверждено.** Доказательства:

1. Нет файлов промптов, относящихся к агентам: `glob **/*prompt*` даёт только `docs/start-prompt.md` (промпт для старта сессии человека в DSH, содержит инструкцию «скопируйте текст в первое сообщение новой сессии») и артефакты вне агентского слоя: `connectors/ru-marketplace-mcp/.venv/**` и `connectors/ru-marketplace-mcp/work/evals/runs/prompts-v1.json` — это промпты eval-стенда коннектора («You are the routing layer for the ru-marketplace-mcp DSH bundle…»), к движку Агента 1 отношения не имеют.
2. Весь путь — правила и математика: парсинг YAML (`cwlib.py:611-810` — PyYAML, иначе мини-парсер), схема/типы/диапазоны снимка (`cwlib.py:23-53`), фильтры отбора с причиной отбраковки (`marketing_settings.py:503-597`), статистика — медиана/среднее/guard выбросов (`marketing_settings.py:602-787`), diff неделя-к-неделе (`diff_snapshots.py`, `SCHEMA_VERSION = 1` в `:23`), аналитика (`analytics.py`, `SCHEMA_VERSION = 1` в `:50`).
3. Текст отчёта — код, а не генерация: девять разделов заданы списком `build_weekly_report.py:39` и далее; таблицы собираются форматированием (`:407-518`), экранирование `|`/переводов строк — `build_weekly_report.py:149-153`.
4. `templates/weekly-report.md` кодом **не читается** (grep: только упоминания в докблоках `cwlib.py:295`, `build_report.py:7`, `run_weekly.py:7`, `run_weekly.py:103` и в документации) — это спецификация-документ, а не рабочий шаблон.
5. Единственный модуль в дереве, который подключает LLM-подобный слой (скиллы), Агентом 1 не используется: `01-competitor-watch/scripts/reefapi_deep_check.py:43-44` (`from skills.real_estate import reefapi`, `from skills.runtime import …`) — операторский инструмент, в расписании не вызывается (`install/agent1-weekly.cmd:24` зовёт только `collect_clients.py`).

**Где LLM реально нужен (оценка, основана на том, что уже делает код):**

| Место | Сейчас | LLM даёт выигрыш | LLM не нужен |
|---|---|---|---|
| Состав снимка, дедуп лотов, идентичность (`collect_clients.py:169-296`) | правила + hash | — | ✔ детерминизм обязателен, иначе цифры невоспроизводимы |
| Фильтры отбора, выбросы (`marketing_settings.py:503-787`) | пороги из YAML | — | ✔ |
| Медианы, Δ цен, динамика (`analytics.py`, `diff_snapshots.py`) | статистика | — | ✔ |
| Раздел «8. Выводы и рекомендации» (`build_weekly_report.py:39`) и прогноз (`analytics.py`, тумблер `forecast` в `agent-settings:114`) | шаблонные формулировки по порогам | ✔ интерпретация «почему», приоритизация, объяснение аномалий | — |
| Отчёт клиенту (тон, объяснение ограничений) | фиксированные 9 разделов | ✔ адаптация текста под клиента | — |
| Агент 2 «Семантика и кампании» | не реализован | ✔ (`registry/agents.yaml:28-29` сам просит `deepseek-v4-pro`: «задача творческая и объёмная») | — |
| Агент 3 «Креативы», Агент 4 «Аналитика» | не реализованы | ✔ | — |

Вывод для планирования: LLM имеет смысл подключать **после** конвейера, на выходе (интерпретация готовых чисел), а не вместо него. Сейчас LLM-слоя нет вообще, и это осознанное состояние, а не недоделка: `docs/skills-vs-python-audit.md:97` фиксирует для транскриптов «deterministic, no LLM» как требование («задачи не выдумываются»).

---

## 4. Схема потока данных Агента 1 (сбор → снимок → аналитика → отчёт → доставка)

Легенда: `[F]` — точка отказа. Модули и строки — в скобках.

```text
ТРИГГЕР
  Windows Task "Agent1-Weekly" (install/agent1-weekly-task.xml:4,9,12; четверг 11:00, PT2H)
    └─> install/agent1-weekly.cmd:24  "collect_clients.py --email-mode always"
          │  (Python: venv -> .venv -> py, cmd:16-18)   [F1] нет venv => fallback "py"
          └─> logs/agent1-weekly.log (cmd:23,26 + stdout:24)   [F2] смешанная кодировка
  Панель (2-й триггер): serve.mjs:1344 send-report / :1188 discover / :1889 отчёт
          │  таймауты 300с :1188,:1362 и 180с :1891   [F3] :1891 берёт PYTHON (без PyYAML), а не CW_PYTHON

СБОР  collect_clients.py:910 main -> :940 for client -> :659 run_client
  1 validate client config ......... clients.py (run_client:661)              [F4] проблемы => клиент пропущен
  2 agent-settings ................. marketing_settings.py:456 load (run_client:670)
  3 источники ...................... collect_client:238-403
       per-source: platforms.collect_platform platforms.py:1018
                   platforms.http_fetch :599-629 (timeout 25)  ->  Chrome CDP fallback :1068+
        ретраев нет; сетевые ошибки глотаются в :616-629     [F5] капча/401 => статус источника, лотов 0
  4 идентичность/дедуп лотов ....... collect_clients.py:262-296 (коллизии => суффикс, :395-402)
  5 фильтры agent1.selection ....... marketing_settings.filter_rows:561 + limitations:580
                                                                  [F6] исключение здесь не ловится => падение всего прогона
СНИМОК
  6 data/clients/<id>/snapshots/<date>/lots.csv .. write_snapshot:709,:448-453 (cwlib.COLUMNS)
  7 журнал источников data/source-runs.jsonl ..... log_source_run.append_entry:773-779 (лок :58-94)
АНАЛИТИКА
  8 load prev/month ................ collect_clients.py:712-734 (previous_date:433, month_date:438)
  9 compute_payload ................ :832 (diff_snapshots.py, SCHEMA_VERSION :23)
 10 analytics.py (тумблеры) ........ client_report.build_client_report:744 -> .cache/analytics-<date>.json
ОТЧЁТ
 11 nine sections .................. build_weekly_report.py:39,:407-518 (cell():149-153)
 12 md/xlsx/docx/pdf ............... client_report.py (docx->pdf :206-222, timeout 180)   [F7] LibreOffice != 0 => отчёт без pdf, прогон продолжается
 13 копия в reports/<date>/ ........ run_weekly.py:101-108 (только alias-путь; в расписании не участвует)
ДОСТАВКА
 14 allowlist ...................... delivery_email.py:138-165 (settings.yaml recipients_allowlist)
 15 SMTP_SSL/STARTTLS .............. delivery_email.py:326-329 (timeout 60)               [F8] нет SMTP => письмо как .eml, статус "не отправлено"
 16 machine line EMAIL_RESULT ...... парсит serve.mjs:1365-1366
РЕЕСТРЫ (пишутся после отчёта)
 17 registry/runs.jsonl ............ append_run:781-789 (без лока)                         [F9] 3 писателя без блокировки
 18 registry/results.yaml .......... append_result:800-818 (дописывание текстового блока)  [F10] PyYAML не используется, правится текст
	          читают: agent1-status.mjs:18-19, analytics2.mjs:168-172, service.mjs:11-12, verify-data.mjs:591-604
```

Ключевые точки отказа по влиянию:
- **F6** (непойманное исключение в шаге 5-11) — самый тяжёлый: теряется весь прогон по всем клиентам и код возврата.
- **F9** (три несогласованных писателя без лока) — порча журнала, на котором строится статус Агента 1 в панели.
- **F3/F2** (разные интерпретаторы и нечитаемый лог) — «тихие» расхождения: отчёт из панели может считаться по другому прочтению YAML, чем плановый прогон.
- **F5/F8** — деградируют корректно (честные статусы, `.eml`), это сделано хорошо.

---

## 5. Версионирование

### 5.1 Промпты

Файлов промптов Агента 1 нет (§3). Версионировать нечего; при включении LLM понадобится отдельный слой (сейчас его нет — `[НЕ ХВАТАЕТ ДАННЫХ]`, какой формат предполагается).

### 5.2 Версии контрактов

| Контракт | Версия | Где | Сверяется автоматически |
|---|---|---|---|
| Реестр агентов | `version: 1` | `registry/agents.yaml:4` | нет |
| Тонкие настройки | `version: 1` | `agent-settings/agent-1-competitor-watch.yaml:5` | нет (версия не читается) |
| Цены моделей | `schema: prices/v1` | `registry/prices.yaml:15` | нет |
| Снимок лотов | нет явной версии, есть `COLUMNS`/`REQUIRED_NON_EMPTY` | `cwlib.py:23-36` | да: `snapshot_tool.py:95-116`, тесты |
| Аналитика / diff | `SCHEMA_VERSION = 1` | `analytics.py:50`, `diff_snapshots.py:23` | частично (пишется в JSON) |
| 9 разделов отчёта | «frozen contract» | `build_weekly_report.py:560-561` + `00-admin/config/settings.yaml → report_sections` + `templates/weekly-report.md` + литерал в `tests/test_engine.py:576-590` | только код ↔ settings.yaml: `cwlib.py:947-967`; шаблон и тест-литерал — нет |

Итог: «контракт» разделов отчёта существует в **четырёх** копиях, автоматически сверяются две (`cwlib.settings_structure_warnings`), шаблон `templates/weekly-report.md` сверяется только руками (в `docs/audit/mvp-audit-engine.md:48` это уже зафиксировано как D5-родственный дефект).

### 5.3 Механика `.bak-<timestamp>` и SHA-256

- Копия делается панелью при каждой правке: `dashboard/serve.mjs:470-472` (имя `<файл>.bak-<stamp>` с суффиксом при коллизии), `:934-936`, `:1099-1101`, `:2166-2168`; для клиентских конфигов — `:1493`+; навигация по копиям — `collector/lib/history.mjs:11`, `collector/lib/settings.mjs:43`.
- Обратимость побайтовая: `sha256Of` `serve.mjs:807-808`; список копий с SHA `:814-822`; откат `:2184` (`sha256` текущего и `sha256Restored` копии), описание API `:2202-2204`. Тесты: `dashboard/_ux-harness/test-toggle-e2e.mjs:76-83`, `test-selection-e2e.mjs:109`, `test-agent1-truth-e2e.mjs:136`.
- Масштаб: в `registry/**` **189** файлов `.bak-*` (из них 57 у `agents.yaml`, 25 в `agent-settings/`), многочисленные дубли с интервалом в секунды — например `registry/agent-settings/…bak-20261101-135447-096/-138/-144/-151` (одна и та же правка, четыре копии).
- Ограничения обратимости:
  - Восстанавливаются только те файлы, которые правит панель (`serve.mjs:793-822` — путь обязан лежать в `agent-settings/` или среди известных файлов). Код движка (`01-competitor-watch/scripts/*.py`), `templates/weekly-report.md`, `install/*.cmd|xml` копий не имеют.
  - **VCS в дереве отсутствует**: `Test-Path .git` → False и для `тестDH`, и для `marketing-agents`. То есть откат поведения агента возможен только для YAML-настроек, и только если панель жива; отката кода/шаблонов и истории правок кода нет вообще (только доккументы вида `registry/agents.yaml.bak-*`).
  - Системные группы настроек (`model`, `priority`, `limits`, `alerts`) через карточку не редактируются (`README-agents-settings.md:123-124`), поэтому их `.bak`-история образуется только правками извне; и они всё равно не действуют (§1.3) — откат не влияет на поведение.
- Вывод: «откатить поведение агента без деплоя всего» можно **только** по маркетинговым группам (`agent1.watch`, `agent1.selection`, `agent1.analytics`, `delivery`) — потому что только они реально читаются кодом.

---

## 6. Память и состояние

### 6.1 Кто пишет / кто читает

| Хранилище | Пишет | Читает |
|---|---|---|
| `01-competitor-watch/data/clients/<id>/snapshots/<date>/lots.csv` | `collect_clients.py:448-453` (`write_snapshot`), нормализация — `cwlib.normalize_file` через `snapshot_tool.py:119-142` | `collect_clients.py:426,712` (`load_snapshot`), `dashboard/collector/lib/sources.mjs`, `agent1-status.mjs` |
| `data/**/candidates/<project>.json` | `discover_competitors.py:736` (`write_candidates`, считает SHA до/после) | панель: `serve.mjs:674-681` (исключает `*.decisions.json` и `*.bak-*`) |
| `data/source-runs.jsonl` (72) | `log_source_run.py:96-133` (лок, `O_APPEND`, один `os.write`) | `collector/lib/sources.mjs:16-19` (перебирает 4 возможных пути!), панель |
| `registry/runs.jsonl` (27) | **3 писателя**: `collect_clients.py:494-500`, `discover_competitors.py:748-749`, `serve.mjs:232-233` — все без лока | `agent1-status.mjs:18`, `analytics2.mjs:172`, `service.mjs:11,39`, `verify-data.mjs:591-604` |
| `registry/results.yaml` | `collect_clients.py:510-535` (`append_result`: чтение текста, дописывание блока, кавычки вручную `:503-507`); правится и панелью (`serve.mjs:229`) | `agent1-status.mjs:19`, `competitor-analytics.mjs:245,650`, `service.mjs:12,51` |
| `registry/prices.yaml` | не движком (описание — `registry/README.md:11`) | `collect_clients.py:471` (себестоимость), панель |
| `registry/agent-settings/*.yaml` | панель (`serve.mjs:1569`), человек | движок: `cwlib.py:1038-1068`, `marketing_settings.py:456`, `discover_competitors.py:43` |
| `registry/agents.yaml` | панель `serve.mjs:915-946` | движок — **только `model`** (`collect_clients.py:485`); приём задач — `registry/intake/scripts/text_to_tasks.py:192` (`load_agents`) |
| `skills/logs/skill-runs.jsonl` (2269) | `skills/runtime/core.py:43` (контракт `fetch(query, **kwargs) -> list[dict]`, `:9-15`) | `dashboard/collector/lib/skills.mjs:9` |
| `logs/agent1-weekly.log` | `install/agent1-weekly.cmd:23,24,26` | человек (машинно нечитаем, §2.7) |

### 6.2 Общее состояние между агентами и со скиллами

- Агенты 2-4 не реализованы (`registry/agents.yaml:27,42,55` `status: planned`; `agent-settings/agent-2…yaml:5-6` `status: stub`), поэтому **общего изменяемого состояния между агентами нет** — есть только общие файлы `registry/**`, которые правит либо панель, либо движок.
- Агент 1 и скиллы состояние **не делят**: в недельном пути скиллы не вызываются (единственный импорт — `reefapi_deep_check.py:43-44`, операторский инструмент), а `skills/logs/skill-runs.jsonl` только читается панелью. Общей памяти (векторов/кэша/истории диалога) у агентского слоя нет вообще — вся «память» это CSV-снимки + JSONL-журналы.
- Реальная точка пересечения — `registry/runs.jsonl` и `registry/results.yaml`: их пишут и движок, и панель (`serve.mjs:233,1906`); защита от одновременной записи есть только у `source-runs.jsonl`.

---

## 7. Безопасность агентского слоя

### 7.1 PII

- В снимках и отчётах персональных данных нет по составу: колонки снимка — `cwlib.py:23-28` (дата, источник, конкурент, проект, id лота, url, комнатность, площади, этаж, корпус, цены, отделка, промо, срок сдачи, статус). Контактов покупателей/сотрудников нет.
- **Но адреса получателей лежат в открытом виде** и не все места исключены из версионирования:
  - `logs/agent1-weekly.log` — 20 вхождений `tyurina@d-a.ru`, `vodnev@d-a.ru` (проверено регуляркой по всему файлу); `logs/` в `.gitignore:9`, т.е. git эта утечка не затрагивает;
  - `registry/results.yaml:185,202,222,242,262,282,302,322,342,362,381,400` — `sent_to: "…@d-a.ru"`; `registry/` **не** в `.gitignore` (`.gitignore:1-14`: исключены только `.smtp-password.local`, `*.local`, `*.bak-*`, `__pycache__`, `.pytest_cache`, `*.pyc`, `logs/`, `.env`, `.env.*`);
  - `registry/agent-settings/agent-1-competitor-watch.yaml:41` — `addresses: ["vodnev@d-a.ru", "tyurina@d-a.ru"]`, файл тоже не исключён.
  - Публичная копия панели чистая: grep по `install/publish/**` на `d-a.ru|tyurina|vodnev` — **0 совпадений**.
- Итого: PII ограничена служебными адресами заказчика; риск — попадание в git через `registry/results.yaml` и `registry/agent-settings/*.yaml`, а не через отчёты.

### 7.2 Куда уходят данные

- Исходящие запросы — анонимный HTTP/Chrome CDP к сайтам конкурентов: заголовки с жёстким allowlist, Cookie запрещён (`platforms.py:6` — «no Cookie», `:604-607` — `FORBIDDEN_HEADERS` бросает `ValueError`), лимит ответа 3 МБ (`platforms.py:599`). Логин нигде не используется (то же в `agent-settings…yaml:123-131`, `README-agents-settings.md:42-48`).
- Единственный внешний получатель данных — SMTP: транспорт из `00-admin/config/settings.yaml → delivery.email` (`delivery_email.py:167-178`), пароль — из переменной окружения `DSH_SMTP_PASSWORD` (`:45`), в файлах не хранится (`README-agents-settings.md:139-140`). Получатели жёстко ограничены белым списком (`delivery_email.py:138-165`, `split_by_allowlist:158-165`), чужие адреса отбрасываются с причиной (`:210-214`). При отсутствии SMTP письмо сохраняется как `.eml` со статусом «не отправлено: нет SMTP-доступа» (`:22-25,44`).
- Есть заметный операционный риск, зафиксированный ранее: расписание шлёт с `--email-mode always` (`install/agent1-weekly.cmd:24`) на живые адреса, «положительный путь sent» до 05.11.2026 не проверялся (`docs/audit/mvp-audit-product.md:31` — high).

### 7.3 Prompt injection

- **Сейчас риск нулевой**: промптов нет, LLM не вызывается (§3), внешний текст обрабатывается только парсерами и регулярками.
- При включении LLM появятся конкретные недоверенные входы (перечислены с текущими ограничителями):
  1. `promo_text` со страниц конкурентов — внешний текст, попадает в отчёт: `client_report.py:179`, `build_weekly_report.py:481-484,704`; длина ограничена 160 символами, мусор вёрстки отсекается (`platforms.py:394-405 looks_like_promo_text`, `:408-429 clean_promo_text`), но это фильтр вида, а не защиты от инструкций;
  2. сырой HTML страниц (до 3 МБ, `platforms.py:599`) — сейчас в модель не уходит, но это готовый канал, если кто-то подаст страницу в контекст;
  3. транскрипты Телемоста → `registry/tasks/*.yaml` (`registry/tasks/2026-10.yaml:15,26,37` — поле `quote` со свободным текстом; конвейер `registry/intake/scripts/text_to_tasks.py`, по `docs/skills-vs-python-audit.md:97` — «deterministic, no LLM»). Это самый «инъекционный» вход в проекте: чужой текст превращается в задачи с исполнителем и сроком;
  4. `registry/results.yaml`/`runs.jsonl` — свободные `error`/`note` (например, многострочная ошибка LibreOffice в `registry/runs.jsonl:4`), т.е. текст ошибки внешней программы тоже попадает в «память» агента.
- Дополнительно: у панели нет аутентификации в просмотренном коде — grep по `serve.mjs` (`authorization|Authorization|токен|basicAuth|парол`) не находит проверки доступа, при этом панель умеет запускать движок (`serve.mjs:1188,1362,1891`) и править `registry/**`. `[НЕ ХВАТАЕТ ДАННЫХ]`: слушает ли панель только localhost и есть ли внешний туннель в проде — из песочницы не проверял (Chrome/сеть недоступны).

---

## 8. Открытые вопросы без данных

1. Зарегистрирована ли задача `Agent1-Weekly` **сейчас** и каковы её `Last Run Result`/`Next Run Time` — из песочницы `schtasks`/`Get-ScheduledTask` недоступны (`docs/audit/audit-i1-env-2026-11-04.md:33`); подтверждён только XML в репозитории. `[НЕ ХВАТАЕТ ДАННЫХ]`
2. Реальный расход токенов и рублей: LLM не вызывается, поэтому фактический расход = 0, но в `registry/runs.jsonl` лежит ненулевой `cost_rub` — какой из двух цифр должен верить заказчик, не зафиксировано нигде. `[НЕ ХВАТАЕТ ДАННЫХ]`
3. Доля записей `registry/runs.jsonl`, созданных панелью, а не движком: форматы `run_id` несопоставимы (`serve.mjs:1880` — base36 от времени, Python — `sha1[:8]`), надёжно разделить нельзя. `[НЕ ХВАТАЕТ ДАННЫХ]`
4. Соответствие `agents.yaml:18-19` (`inputs`/`outputs`) фактическим путям нигде не проверяется; папки из `inputs` существуют (`01-competitor-watch/inbox` — `Test-Path` True; `registry/intake/inbox/audio|text` — из обзора `registry/**`), но какой путь считается «каноничным» для `"cian-connector"`/`"avito-connector"` (это имена скиллов, а не пути) — не установлено. `[НЕ ХВАТАЕТ ДАННЫХ]`
5. Политики хранения/ротации нет: `logs/` (13 КБ лог + стенды), 189 `.bak` в `registry/`, 72+27+2269 строк JSONL, снимки за много дат — ни TTL, ни сжатия, ни архивации в коде не найдено. Требуется решение владельца. `[НЕ ХВАТАЕТ ДАННЫХ]`
6. Предполагаемый формат промптов и место их версионирования при включении LLM (файлы/БД/реестр) — не определено ни в `docs/**`, ни в `registry/**`. `[НЕ ХВАТАЕТ ДАННЫХ]`
7. Кто и как читает `registry/runs.jsonl` вне панели (Obsidian-vault export, `.gsheet`, внешние потребители) — экспорт `collector/export-vault.mjs:281-291` читает `agent-settings.json`, но полный список потребителей не проверялся. `[НЕ ХВАТАЕТ ДАННЫХ]`
8. `connectors/ru-marketplace-mcp/work/evals/runs/prompts-v1.json` — настоящие промпты вне агентского слоя; принадлежность/использование не оценивались (вне границ task-1). `[НЕ ХВАТАЕТ ДАННЫХ]`
9. Проверка «52 теста» из `registry/agents.yaml:21` не выполнялась: тесты не запускались (запрет на запуск скриптов движка, часть тестов пишет данные). `[НЕ ХВАТАЕТ ДАННЫХ]`

---

## Приложение. Как проверялось

- Чтение файлов `read` (с `offset`/`limit`), поиск — `grep`/`glob`; тяжёлые каталоги (`_f10-live-20261104/**`, `install/publish/**`, `connectors/**/.venv/**`) исключались из выдачи.
- Кодировка лога: `read logs/agent1-weekly.log` → invalid UTF-8; `System.Text.UTF8Encoding($false,$true).GetString(bytes)` → ошибка на байте `0x80` со смещением 5937; `Encoding.GetEncoding(866)` → читаемые строки `echo [%DATE% %TIME%]`.
- PII: регулярка `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` по декодированному логу → 20 вхождений, уникальные `tyurina@d-a.ru`, `vodnev@d-a.ru`; grep по `install/publish/**` → 0.
- Интерпретаторы: `Test-Path` — venv и DSH-runtime python существуют; `import yaml` → venv 6.0.3 OK, DSH-runtime `ModuleNotFoundError: No module named 'yaml'`.
- Счётчики: 189 файлов `.bak-*` в `registry/**`; 27 строк `registry/runs.jsonl` (8 с `kind`/`sha256_after`); 72 строки `data/source-runs.jsonl`; 2269 строк `skills/logs/skill-runs.jsonl`.
- Не запускались: `collect_clients.py`, `run_weekly.py`, `ux-check.mjs`, `verify-data.mjs`, панель, Chrome, тесты. Ничего, кроме этого файла, не записано.
