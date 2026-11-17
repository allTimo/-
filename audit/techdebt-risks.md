# Аудит техдолга и рисков — marketing-agents (блок 4)

**Дата:** 2026-11-08 · **Исполнитель:** teammate `techdebt-risks` (shared task `task-4`) ·
**Права:** только чтение проекта; создан единственный файл — этот отчёт.
**Метод:** только проверяемые факты `путь:строка` и точные числа. Где данных нет — `[НЕ ХВАТАЕТ ДАННЫХ]`.
Числа получены одиночными командами PowerShell/Python; временные файлы в проект не писались.
`pytest` запускался только в режиме `--collect-only -q -p no:cacheprovider` (без побочных эффектов);
`run_weekly`/`collect`/`ux-check` не запускались.

**Среда измерения:** Python `connectors/ru-marketplace-mcp/.venv/Scripts/python.exe` (существует),
Node `C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` (существует).
Chrome и сеть недоступны → живые прогоны площадок не выполнялись.

---

## 1. Дубли «скиллы vs движок»

### 1.1 Прямой ответ на главный вопрос

**Скиллы НЕ подключены к конвейеру Агента 1. Это параллельная ветка-дубль, а не часть недельного цикла.**

Доказательства (сплошной grep по `01-competitor-watch/**`, `dashboard/**`, `plugin/**`):

| Проверка | Факт | Доказательство |
| --- | --- | --- |
| Импорты скиллов в недельном оркестраторе | **нет ни одного** | `01-competitor-watch/scripts/run_weekly.py:11-19` — только `cwlib`, `build_weekly_report`, `diff_snapshots`, `snapshot_tool`, `sources_tool` |
| Импорты скиллов в главном прогоне клиента | **нет ни одного** | `01-competitor-watch/scripts/collect_clients.py:34-41,833` — только `cwlib`, `marketing_settings`, `clients`, `client_report`, `delivery_email`, `platforms`, `log_source_run`, `sources_tool`, `diff_snapshots` |
| Единственная живая точка входа в скиллы из движка | **1 файл, операторский** | `01-competitor-watch/scripts/reefapi_deep_check.py:43-45` (`from skills.real_estate import reefapi`) — в docstring `:6` прямо: «вне недельного цикла», «разовая глубокая проверка» |
| Единственная сверка паритета движок↔скилл | **1 тест на 5 входных строк** | `01-competitor-watch/tests/test_clients.py:336-350` |
| Собственное признание проекта | **«в работу не подключены»** | `skills/README.md:152-154` |
| Использование панелью | **только отображение** | `dashboard/collector/lib/skills.mjs:7-9,25` читает `skills/registry/skills_registry.json` и `skills/logs/skill-runs.jsonl` — панель показывает скиллы, но не вызывает их |
| Режим прогонов скиллов | **всплеск, не продакшн-ритм** | `skills/logs/skill-runs.jsonl` — 2 269 записей, все в окне `2026-11-04T15:41:50+00:00` … `2026-11-04T17:54:44+00:00` (2 ч 13 мин), при недельном цикле Агента 1 |
| Реестр скиллов | 8 модулей, **все `enabled: true`** | `skills/registry/skills_registry.json` (`skills` = 8: mcp_market, reefapi, rentscout, mcp_rosreestr, apify, rentcast, zillapi, developer_pricing) |

Вывод: `docs/skills-vs-python-audit.md` подтверждается фактами на диске. Формулировка этого документа
(`:8-11`, `:28-29`) — «скилл не заменяет детерминированный код» — верна, но **есть более сильный факт,
которого в аудите нет**: скиллы не просто «не замена», они **вообще не вызываются** из недельного конвейера,
кроме одного ручного операторского скрипта.

### 1.2 Таблица дублей по функциям и данным

| # | Скилл (путь:строка) | Движок (путь:строка) | Пересечение | Оценка |
| --- | --- | --- | --- | --- |
| D1 | `skills/real_estate/developer_pricing.py:178` `pick_lot_price` | `01-competitor-watch/scripts/platforms.py:220` `pick_lot_price` | **Одна и та же функция, одно и то же поле** `price_rub` | 🔴 реальный дубль |
| D2 | `skills/real_estate/developer_pricing.py:238` `pick_lot_price_details` | `01-competitor-watch/scripts/platforms.py:261` `pick_lot_price_details` | **Одно и то же**, включая возвращаемый контракт `{"price_rub", "price_before_rub"}` (сравните `developer_pricing.py:242-243` и `platforms.py:269-270` — код идентичен) | 🔴 реальный дубль |
| D3 | `skills/real_estate/developer_pricing.py:191,202` `pick_area`, `pick_rooms` | `platforms.py` — аналогов нет (`def pick_` даёт только `pick_lot_price`, `pick_lot_price_details`, `pick_site_url:280`) | Скилл — надмножество движка | 🟠 односторонняя ветка |
| D4 | `skills/real_estate/developer_pricing.py:246` `ppm2_within_range`, коридор `PPM2_MIN=120_000`/`PPM2_MAX=1_200_000` (`:78-79`) | в движке **нет** | Скилл вводит правило, которого нет в движке → два разных «правила честной цены» | 🟠 расхождение правил |
| D5 | `skills/real_estate/reefapi.py:235` `fetch` → `make_record(...)` `:277-288` (`id,title,price,area,address,url,rooms`) | `01-competitor-watch/scripts/cian_connector.py`, `platforms.py` → `cwlib.COLUMNS` (`cwlib.py:23-28`) | **Тот же источник данных (Авито/Циан), два разных контракта записи**: у скилла `price/area/rooms/address`, у движка `price_rub/area_m2/rooms/delivery/status/promo_*` | 🔴 дубль источника + расхождение схемы |
| D6 | `skills/real_estate/{apify,rentcast,rentscout,zillapi,mcp_market,mcp_rosreestr}.py` | аналогов в движке нет | Это новые источники (US/внешние API), не дубли | 🟢 не дубль |
| D7 | `01-competitor-watch/scripts/build_report.py` (62 строки) | `build_weekly_report.py` (789 строк) | Алиас-дубль | 🟡 мёртвый код: живых ссылок в коде нет, только docs (`00-admin/runbook.md:176`, `01-competitor-watch/README.md:124`, `scripts/README.md:22`) |
| D8 | `01-competitor-watch/scripts/build_snapshot.py` (32 строки) | `snapshot_tool.py` (160 строк) | Алиас-дубль | 🟡 то же (`00-admin/runbook.md:377`) |
| D9 | `00-admin/scripts/build-snapshot-from-cian.py` (153 строки) | `cian_connector.py` | Legacy-конвейер | 🟡 живых ссылок нет; вердикт аудита — «убрать как дубль» (`docs/skills-vs-python-audit.md:90`) |

**Масштаб D1–D2:** дублируется ~1,7 КБ логики выбора цены (по оценке `docs/skills-vs-python-audit.md:9-11`
весь снимаемый Python-дубль = ≈11,3 КБ, из них 3 файла-алиаса D7–D9).
**Паритет D1 держится на одном тесте с 5 строками входа** (`test_clients.py:341-347`) — при правке
любого из двух `pick_lot_price` расхождение поймает только этот тест, и только на этих 5 примерах.

### 1.3 Сверка с монетизацией

`docs/monetization-stages-v2.md` (37,7 КБ) и `docs/concept-saas-2026-11-04.md` (26,1 КБ) —
**grep по `скил|skill` дал 0 совпадений** в обоих файлах. То есть в документах монетизации скиллы
**не продаются как продукт**; тезис задания в этой части документами не подтверждается.
[НЕ ХВАТАЕТ ДАННЫХ] — в каком именно документе скиллы позиционируются как товар.

---

## 2. Покрытие тестами агентских сценариев

### 2.1 Точные числа

| Набор | Файлов | `def test_` (grep) | Собрано pytest | Что это на самом деле |
| --- | --- | --- | --- | --- |
| `01-competitor-watch/tests/**` | 19 `.py` + фикстуры | 357 | **357** | Юниты движка: парсеры, CSV-контракт, diff, отчёт, CLI |
| `skills/tests/**` | 5 `.py` | 108 | **108** | Контракт рантайма и модули источников на мок-транспорте |
| **Итого** | 24 | **465** | **465** | `465 tests collected` (команда: `pytest … --collect-only -q -p no:cacheprovider`, exit 0) |
| `dashboard/verify-data.mjs` | 1 | — | 192 проверки `check(...)` | Согласованность данных **панели**, включая сверку с сырыми файлами движка |
| `dashboard/ux-check.mjs` | 1 (заморожен) | — | 21 шаг | Поведенческий тест панели через CDP/Chrome |
| `marketing-agents/tests/` | 1 | — | `plugin-contract.test.mjs` (8,5 КБ) | Контракт плагина; **не про Агента 1** |

Для сравнения: `docs/mvp-audit-2026-11-04.md:5` фиксирует исторический результат `319 passed in 30.13s`
(сейчас собирается 465 — набор вырос).

### 2.2 Известные дефекты: есть ли тесты

| Дефект | Тест есть? | Доказательство | Комментарий |
| --- | --- | --- | --- |
| **F12** — грязная колонка `delivery` | **ДА** | `tests/test_clients.py:577-587` — `test_31_delivery_year_is_honest_and_junk_is_refused`, 9 проверок: `"Срок сдачи: 2027"→"2027"`, `"Сдача: IV кв. 2027"→"2027-Q4"`, `"Ставка 13% на 2027 год"→""`, `DELIVERY_RE` на `"ставка 13"` = False | Покрыт контракт и мусор; тест закреплён в `cwlib.py:50-53` и `platforms.py:355-363` |
| **F13** — `source=developer-sites` не проходит валидатор | **НЕТ** | grep по `SOURCE_VALUES|source_values` в `01-competitor-watch/tests/**` → **0 совпадений**. `developer-sites` встречается только как id источника в клиентских конфигах (`test_clients.py:494,537`, `test_contract_v2.py:78,97,129,173`), а не как значение колонки `source` в снимке | Исправление есть (`cwlib.py:40-43`), **регрессионного теста нет**. Рекомендация аудита `docs/audit/mvp-audit-engine.md:35` («тест: каждый source из журнала проходит валидатор») **не выполнена** |
| **Положительный путь отправки (`sent`)** | **ДА, на уровне модуля** | `tests/test_analytics.py:397-436` — `test_51_smtp_send_path_reports_sent`: mock `smtplib`, проверка `records[0]["status"] == "sent"`, `sent_at is not None`, логин/сервер/адрес | Покрыт `delivery_email.deliver_report`; **через `collect_clients` цепочка до `sent` не доводится** |

### 2.3 E2E «сбор → снимок → аналитика → отчёт → отправка письма»

**Такого теста нет.** Цепочка разорвана на три независимых куска, и в каждом «дорогая» нога подменена:

| Нога цепочки | Как покрыта | Доказательство | Чего не хватает |
| --- | --- | --- | --- |
| Сбор | Транспорт **замокан** | `test_contract_v2.py:92-113` (`fake_site`, `fake_platform` + `mock.patch.object`) | Реального сбора нет |
| Сбор → снимок → отчёт | CLI **в `--dry-run`** | `test_clients.py:532-542` (`test_60_dry_run_reports_every_source`): проверяется stdout и наличие MD; `assertFalse((self.tmp/"registry"/"runs.jsonl").exists())` | Снимок `lots.csv` и `analytics.json` не создаются — прогон «не выполнялся» (`:539`) |
| Аналитика → отчёт | Есть, на синтетических строках | `test_engine.py` (52 теста, `test_01`…`test_56`), `test_contract_v2.py:184+` | Нет связки с реальным снимком после сбора |
| Отчёт → письмо | Тесты требуют, чтобы отправки **НЕ было** | `test_contract_v2.py:493-509` (`_forbidden` вместо транспорта, `result["sent"] == []`), `:555-568` (`report["email"] == []`) | Позитивный прогон «отчёт → `sent`» через `collect_clients` отсутствует |

**Конкретные непокрытые ветки (по именам):**

1. `collect_clients.collect_client` в режиме **не-dry-run** с реальными артефактами и статусом письма `sent` — нет теста.
2. **F13-регрессия**: `cwlib.validate` против строки `source="developer-sites"` — нет теста (см. 2.2).
3. **DOCX/PDF через LibreOffice Kit** — тест есть, но **тихо пропускается**: `test_clients.py:508-510`
   `if not client_report.LO_KIT_CLI.exists(): self.skipTest("LibreOffice Kit недоступен")`.
4. **Живой браузерный транспорт** (`platforms.cdp_html`, `launch_chrome`) — только стабы:
   `test_developer_site.py:102-144` подменяет `platforms.cdp_html` лямбдой. Живого Chrome-теста нет
   (в этой среде Chrome недоступен в принципе).
5. **10 точек тихого `skipTest`/`skipUnless`** в наборе движка — `test_clients.py:510`, `test_discovery.py:54,378`,
   `test_engine.py:570,910,924`, `test_lot_identity.py:310`, `test_sources.py:105,372,398`.
   Каждая — потенциально непроверенная ветка на чужой машине.
6. **`ux-check.mjs`**: последний прогон `dashboard/ux-report.json` → `generatedAt=2026-11-04T18:07:59Z`,
   `total=21, ok=21, fail=0, verdict="OK"`, но в нём зашито исключение известного дефекта
   `KNOWN_DEFECTS = ['analytics.modes']` (`ux-check.mjs:30`) — то есть один дефект панели
   «легализован» и не считается провалом. Тест требует Chrome и **в текущей среде не воспроизводим**.

### 2.4 Что реально проверяет панель

`verify-data.mjs` — 192 проверки, и это **не** тест движка, а проверка проекций панели.
При этом часть проверок реально сверяется с артефактами Агента 1, например:
«сумма лотов совпадает с `lots_total` движка», «метрики карточки == сырой аналитике движка»,
«последний снимок — самая свежая дата», «получатели почты перечислены по каждому адресу»,
«у каждого получателя есть статус отправки», «неподтверждённая отправка названа явно, а не пустотой».
Это ценный слой, но он валидирует **уже собранные** данные, а не воспроизводит сценарий.

---

## 3. Скрытые связи, зашитые константы и shared global state

### 3.1 Абсолютные пути в коде (полный список по проекту, кроме `connectors/**`)

| # | Путь/константа | file:line | Что сломается при переносе |
| --- | --- | --- | --- |
| A1 | `...\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe` | `01-competitor-watch/scripts/client_report.py:29` | DOCX/PDF-сборка: нет node по этому пути → отчёты без DOCX/PDF |
| A2 | `...\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js` | `01-competitor-watch/scripts/client_report.py:31` | **Тот же LO Kit CLI, что указан в задании как пример.** Проверено: путь существует на этой машине; на любой другой — DOCX/PDF отключаются |
| A3 | тот же node.exe, **второй экземпляр** | `01-competitor-watch/scripts/platforms.py:43` | Дубль A1 — править придётся в двух местах |
| A4 | `C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` | `install/force-rollback.ps1:22` | Откат/восстановление профиля DSH — не работает у другого пользователя |
| A5 | тот же `dsh.cmd` | `install/restore-profile-consistency.ps1:18` | Дубль A4 |
| A6 | `~/.dsh/dsh-runtimes/.../python/Lib/site-packages` (поиск `openpyxl`) | `01-competitor-watch/tests/conftest.py:46-49` | Тесты XLSX падают/скипаются без DSH-рантайма (в venv коннектора нет `openpyxl`) |
| A7 | `~/.dsh/profiles/desktop/node_modules/js-yaml/index.js` | `tests/test_clients.py:41`, `registry/intake/tests/test_text_to_tasks.py:32` | Тесты CLI зависят от чужого профиля DSH |
| A8 | `~/.dsh/dsh-runtimes/.../python.exe` + fallback на venv | `dashboard/serve.mjs:61-66` | Панель не запустит Python-движок на другой машине |
| A9 | `~/.dsh/profiles/desktop`, `~/.dsh/.credentials.yaml`, `~/.dsh/dsh-delegate-router.json` | `dashboard/collector/lib/profile.mjs:13-15,66`, `lib/settings.mjs:189,209-215`, `dashboard/serve.mjs:34-38` | Вкладки «Профиль/Настройки/Плагины» панели — только на машине с DSH |
| A10 | `chrome.exe` из `%LOCALAPPDATA%\Google\Chrome\Application` | `01-competitor-watch/scripts/platforms.py:668`, `install/check-dashboard.ps1:82`, `00-admin/scripts/start-chrome-cdp.ps1:141` | Браузерный транспорт и CDP-проверки |
| A11 | `C:\Program Files`, `C:\Program Files (x86)` | `dashboard/ux-check.mjs:92-93` (заморожен) | Запуск Chrome в тесте панели |

### 3.2 Зашитые константы (порты, площадки, пути, лимиты)

| Константа | file:line | Значение | Риск |
| --- | --- | --- | --- |
| SMTP-хост/порт/ящик | `00-admin/config/settings.yaml:97-103` | `smtp.yandex.ru`, `465`, `smtp_user=art-vodnev@yandex.ru`, `from` тот же | Привязка отправки к личному ящику; смена провайдера = правка конфига + пароль |
| Площадки и хосты | `platforms.py:60-63,66-76` | `cian.ru`, `avito.ru`, `realty.yandex.ru`, `domclick.ru`, `site` | 5 записей; смена/добавление площадки — правка кода |
| Транспорт по площадке | `platforms.py:84-88` | `cian: http-only`, `avito/yandex_realty: http-then-browser` | Зашитая стратегия обхода блокировок |
| Маркеры вёрстки | `platforms.py:122-126` | regex по `data-testid="offer-card"`, `data-marker="item"`, … | Любая правка вёрстки площадки ломает парсер без теста |
| Партнёрские тексты 403 | `platforms.py:646-648` | `needs_partnership` для `PLATFORMS[...]["partnership"]` | Бизнес-логика вперемешку с парсингом |
| Порог 403 → браузер | `platforms.py:646`, `tests/test_clients.py:286-290` | `detect_block(429/403/200+captcha)` | Зашитые коды ответов |
| Коридор ₽/м² | `skills/real_estate/developer_pricing.py:78-79` | `120_000 … 1_200_000` | Правило есть только в скилле, в движке — нет (D4) |
| Enum источников | `settings.yaml:168`, `cwlib.py:43` | 6 значений (`cian, avito, yandex_realty, site, developer-sites, other`) | Два источника правды на один enum |
| Отделка/статусы/комнаты | `cwlib.py:37-38,44-45`, `settings.yaml:169-173` | `FINISH_VALUES`, `STATUS_VALUES`, `ROOMS 0..6`, `AREA 10..400`, `PRICE_MIN_EXCLUSIVE=1_000_000`, `PPM2_TOLERANCE=0.01` | Пороги валидатора зашиты в код, дублируются в YAML-контракте |
| Поисковые бэкенды | `web_search.py:42-51` | `https://google.serper.dev/search`, `SERPER_API_KEY`, `https://html.duckduckgo.com/html/`, UA-строка, `timeout=15/20` | Привязка к Serper + DDG; UA придётся менять при блокировке |
| Модель по умолчанию | `collect_clients.py:488-491` | `deepseek/deepseek-v4.1-flash` | Захардкоженный fallback модели |
| Цены моделей | `registry/prices.yaml` (9 523 Б) | **16 моделей** 6 вендоров (`deepseek/*` ×5, `z-ai/*` ×3, `google/*` ×2, `qwen/*` ×2, `openai/gpt-6-luna`, `minimax/minimax-m3`, `anthropic/*` ×2) | Ручной реестр цен, обновляется вручную |
| Модели агентов | `registry/agents.yaml:13,28,43,56`, `registry/agent-settings/*.yaml` (5 файлов) | `deepseek/deepseek-v4.1-flash` (×3), `deepseek/deepseek-v4-pro` (×1) | Смена LLM = правка 5+ YAML |

### 3.3 Общий YAML-реестр как глобальное состояние

`registry/**` — 19 YAML-файлов + `runs.jsonl` (12 765 Б) + `results.yaml` (22 556 Б) + `README*` (49,6 КБ).
Читатели (один и тот же каталог как «общая правда»):

| Читатель | file:line | Что берёт |
| --- | --- | --- |
| `collect_clients.py` | `:45` `REGISTRY_DIR = cw.PROJECT_ROOT / "registry"`; `:770,819,824` пишет `registry/runs.jsonl`, `results.yaml` | Журнал прогонов, стоимость |
| `build_weekly_report.py` | `:758-775` | `registry/agent-settings/agent-1-competitor-watch.yaml` |
| `budget_sources.py` | `:405` | тот же agent-settings |
| `client_report.py` | `:261` | `cw.load_agent_settings(registry_dir=...)` |
| `analytics.py` | `:38` (docstring) | тумблеры аналитики из agent-settings |
| `clients.py` | `:21,109` | клиентский файл перекрывает глобальные `registry/sources.yaml` |
| панель | `dashboard/collector/lib/registry.mjs`, `lib/agent-settings.mjs` | те же файлы для отображения |
| скиллы | `skills/registry/skills_registry.json` (9 357 Б) | **второй, отдельный реестр** — не связан с `registry/**` |

Риски: (а) два независимых «реестра» (`registry/**` и `skills/registry/`) с разными схемами;
(б) модульный глобал `REGISTRY_DIR` вычисляется из `cw.PROJECT_ROOT` при импорте — тесты вынуждены
подменять его аргументами (`--registry-dir`); (в) конкурентная запись в `runs.jsonl`/`results.yaml`
без блокировок — при параллельных прогонах двух клиентов возможна потеря/перемешивание записей
(следы: 189 `.bak`-файлов в `registry/**`, см. §4).

### 3.4 `.env` и `settings.yaml`

* `.env` (76 Б) содержит **2 ключа**: `REEFAPI_KEY` (значение 40 симв.), `REEFAPI_API`. Значения не печатаю.
* `.env.example` (4 135 Б) объявляет **11 ключей**: `REEFAPI_KEY, REEFAPI_API, APIFY_TOKEN, APIFY_ACTOR,
  RENTCAST_KEY, RENTCAST_BASE_URL, ZILLAPI_KEY, ZILLAPI_BASE_URL, RENTSCOUT_URL, RENTSCOUT_SOURCES,
  MCP_ROSREESTR_URL`.
* `settings.yaml` (11 862 Б) — 100+ скалярных ключей; из чувствительных: `smtp_user`, `smtp_password_env`,
  `smtp_password_file`, `from` (`:97-103`).
* Загрузчик окружения мутирует процесс: `skills/runtime/core.py:150` `load_env_file` пишет в `os.environ`
  (глобальный сайд-эффект на весь процесс).

### 3.5 Что сломается при переносе на другую машину / в Docker

**Docker-артефактов в проекте нет:** поиск `Dockerfile*`, `docker-compose*`, `*.dockerfile`
по `marketing-agents/**` (кроме `connectors/`) — **0 файлов**. Контейнеризация — с нуля.

| Что | Почему сломается | Доказательство |
| --- | --- | --- |
| DOCX/PDF отчётов | LO Kit CLI и node зашиты абсолютным путём внутрь установки DSH | `client_report.py:29,31` (A1, A2) |
| Браузерный сбор (Авито, Яндекс Недвижимость, сайты) | нужен Chrome по `%LOCALAPPDATA%\...\chrome.exe` + CDP-порт | `platforms.py:668` (A10) |
| Панель (вкладки профиля, настроек, плагинов, скиллов) | читает `~/.dsh/profiles/desktop`, `~/.dsh/.credentials.yaml`, `dsh-delegate-router.json` | `profile.mjs:13-15,66`, `settings.mjs:189,209-215`, `serve.mjs:34-38` (A9) |
| Тесты XLSX | `openpyxl` ищется в site-packages DSH-рантайма, не в venv проекта | `tests/conftest.py:46-49` (A6) |
| Тесты CLI | зависят от `~/.dsh/profiles/desktop/node_modules/js-yaml` | `test_clients.py:41`, `test_text_to_tasks.py:32` (A7) |
| Отправка писем | SMTP-провайдер и ящик зашиты в `settings.yaml` | `settings.yaml:97-103` |
| Запуск Python-движка панелью | `serve.mjs:61-66` ищет Python в DSH-рантайме | (A8) |
| Откат/восстановление профиля | `dsh.cmd` зашит абсолютным путём с именем пользователя | `force-rollback.ps1:22`, `restore-profile-consistency.ps1:18` (A4, A5) |

Отдельно: имя пользователя `Артем` встречается в коде как часть пути в **4 файлах кода/скриптов**
(A1–A5), а также в 30+ документах (`README.md:3`, `00-admin/runbook.md:35,44-45,431`,
`05-verification/*.md`, `audit/plugin-audit.md`) — документация не переносима, но это не рантайм-риск.

---

## 4. Свалка артефактов и отсутствие VCS

### 4.1 Точные цифры по `.bak-*`

| Область | Файлов `.bak*` | Объём, байт | Объём, КиБ |
| --- | --- | --- | --- |
| `registry/**` | **189** | **949 667** | 927,4 |
| `00-admin/config/**` | **60** | **629 664** | 614,9 |
| `01-competitor-watch/data/**` | **213** | **1 243 158** | 1 214,0 |
| `dashboard/**` | **16** | **288 093** | 281,3 |
| `.gh-upload/**` | **0** | **0** | 0 |
| **Итого по 5 областям задания** | **478** | **3 110 582** | 3 037,7 |
| `01-competitor-watch/config/**` (сверх задания) | 4 | 55 370 | 54,1 |
| `landing/**` (сверх задания) | 2 | 26 312 | 25,7 |
| `install/**` (сверх задания) | 1 | 1 678 | 1,6 |
| `cw-lot-history-wdzblpyr/**` (сверх задания, temp-каталог) | 1 | 636 | 0,6 |
| **Всего по `marketing-agents/**` (без `.venv`, `node_modules`)** | **486** | **3 194 578** | **3 119,7 (3,05 МиБ)** |

Контроль сходимости: 189 (`registry`) + 60 (`00-admin/config`) + 217 (`01-competitor-watch` = 213 `data` + 4 `config`)
+ 16 (`dashboard`) + 2 (`landing`) + 1 (`install`) + 1 (`cw-lot-history-wdzblpyr`) = **486**.

Топ-жертвы дублирования в `registry/`: `agents.yaml` — **62** бэкапа, `sources.yaml` — **31**,
`agent-1-competitor-watch.yaml` — **25**, `results.yaml` — **23**, `prices.yaml` — **22**,
`clients.yaml` — 7, `cashback.yaml` — 5, `services.yaml` — 5.
Отдельно: `registry/.backups/` — 5 файлов; **159 `.bak` лежит во вложенной копии**
`01-competitor-watch/data/_f10-live-20261104/registry/**` — то есть реестр целиком скопирован
внутрь данных движка вместе с историей бэкапов (двойной учёт: 189 в `registry/` + 159 в копии).

Динамика по датам (mtime всех 486 файлов): 2026-10-31 — 220, 2026-11-01 — 209, 2026-11-02 — 8,
2026-11-03 — 22, 2026-11-04 — 26, 2026-11-05 — 1. Диапазон: `31.10.2026 16:31:02` … `05.11.2026 19:15:31`.
**Массовое создание 429 бэкапов за 2 дня (31.10–01.11)** — следствие правок через `.bak`-механику.

### 4.2 `.gitignore`

`marketing-agents/.gitignore` — 469 Б, **10 правил** (проверено: непустых строк без `#` — 10):
`00-admin/config/.smtp-password.local`, `*.local`, `*.bak-*`, `__pycache__/`, `.pytest_cache/`, `*.pyc`,
`logs/`, `.env`, `.env.*`, `!.env.example`.

**Что покрыто:** все 486 `.bak`-файлов имеют форму `*.bak-<timestamp>` (проверено: `*.bak` без дефиса — **0**),
то есть правило `*.bak-*` их действительно закрывает; `.pytest_cache/` и `logs/` (включая вложенный
`dashboard/logs/`, где лежат `key.pem`/`cert.pem`) тоже покрыты.

**Чего в нём нет** (а файлы существуют в дереве):

| Не игнорируется | Факт на диске |
| --- | --- |
| `dashboard/config/access.key` | существует, **49 Б** (правила `*.key` нет, только `*.local`) |
| `cw-*/` временные каталоги в корне проекта | **20 каталогов**, 105 317 Б суммарно |
| `.hypothesis/` | 132 файла, 121 040 Б |
| `dashboard/public/data/**` — собранные данные панели | есть |
| `install/publish/site/**` — сгенерированная копия панели | есть (`…/site/data/state.js`, 4 КБ+) |
| `01-competitor-watch/data/**` — рабочие снимки и журналы движка | 311 файлов, 2 438 212 Б |

В `.gh-upload/.gitignore` (внешний репозиторий публикации) набор шире и правильнее: `access.key`,
`live-url.txt`, `last-url.txt`, `*.key`, `*.pem`, `*.log`, `*.bak`, `*.bak-*`, `.venv/`, `install/tools/`,
`install/publish/site/`, `.env`. То есть **в проекте два разных `.gitignore` с разными правилами**,
и рабочий (в `marketing-agents/`) слабее публикующего.

### 4.3 VCS: его нет

| Проверка | Результат |
| --- | --- |
| `C:\Users\Артем\Desktop\тестDH\.git` | **False** |
| `C:\Users\Артем\Desktop\тестDH\marketing-agents\.git` | **False** |
| Единственный `.git` в рабочей области | `C:\Users\Артем\Desktop\тестDH\.gh-upload\.git` |
| История `.gh-upload` | 3 коммита: `0f1ea2f` Initial commit, `3be7807` Выгрузка проекта, `815d8e7` Исправление .gitignore; `git status --short` — **пусто** (чисто) |
| Секреты в трекинге `.gh-upload` | `git ls-files | grep -E '\.env|smtp|password|access\.key|\.pem|credential'` → **0** |
| `git` в системе | `git version 2.56.0.windows.4` — есть, но к рабочей копии не применён |

**Риск:** рабочая копия проекта не версионируется вообще. Единственный механизм отката — 486 `.bak`-файлов
(3,05 МиБ), которые (а) создаются вручную/скриптами в 5+ разных каталогах, (б) уже сами стали свалкой,
(в) не покрывают файлы, у которых бэкапа нет, и (г) не дают diff/истории/авторства.
Публикуемая копия в `.gh-upload` — снимок без связи с рабочей (нет remote-tracking, нет общей истории).

### 4.4 Секреты в дереве и утечки

| Файл | Размер | Тип | Значение |
| --- | --- | --- | --- |
| `marketing-agents/.env` | 76 Б | API-ключ | `REEFAPI_KEY` (40 симв.) — **не печатается** |
| `00-admin/config/.smtp-password.local` | 17 Б | SMTP-пароль | **не печатается** |
| `dashboard/config/access.key` | 49 Б | Ключ доступа туннеля панели | **не печатается** |
| `logs/smtp-check/key.pem` | 1 679 Б | Приватный TLS-ключ локального теста | локальный тестовый |
| `logs/smtp-check/cert.pem` | 1 082 Б | Сертификат локального теста | локальный тестовый |

**Проверка утечек — отрицательная (хорошо):**

* Значение `REEFAPI_KEY` из `.env`: совпадений в других файлах дерева (все файлы < 2 МБ, кроме `.venv`,
  `node_modules`, `.git`) — **0**.
* Значение `.smtp-password.local`: совпадений вне самого файла — **0**.
* Grep по `password|passwd|secret|api_key|token` и `sk-[A-Za-z0-9_-]{16,}` по **2 748** текстовым файлам
  (исключены `.venv`, `node_modules`, `.git`, `__pycache__`, `logs/`, `*.pyc`): единственные совпадения
  в коде проекта — `delivery_email.py:301` (`password = smtp_password(...)` — имя переменной, не секрет)
  и `.env:1` (сам файл). **Реальных секретов в коде нет.**
* Единственная «утечка» — сами секретные файлы лежат в рабочем дереве рядом с проектом, а не вне его
  (правило проекта «секреты — вне репозитория» соблюдено формально: они в `.gitignore`, но `.git` отсутствует,
  поэтому защита держится только на честном слове).

---

## 5. Vendor lock-in

### 5.1 Привязки к площадкам и внешним API

| Вендор | Где зашита привязка | Точка отказа | Цена замены |
| --- | --- | --- | --- |
| **Циан** | `platforms.py:60,67-69,84,122`; `cian_connector.py` (598 строк); `lot_history_pipeline.py` | Блокировка/капча → `needs_browser`/`needs_partnership` (`platforms.py:646-648`); Циан по умолчанию `http-only` (`:84`) | Переписать парсер + историю цен (598+190 строк) |
| **Авито** | `platforms.py:61,69,85,123` | `http-then-browser`, 403 → `needs_partnership` (`test_clients.py:286-290`) | Парсер + браузерный транспорт |
| **Яндекс Недвижимость** | `platforms.py:62,71,85,124` | тот же браузерный фолбэк | Парсер |
| **Домклик** | `platforms.py:63,73,87,125` | `http-only` | Парсер (латентный близнец F13: `platforms.py:73` даёт `domclick`, которого нет в enum — `docs/audit/mvp-audit-engine.md:35`) |
| **Chrome/CDP** | `platforms.py:668`, `launch_chrome`, `cdp_html`; `install/check-dashboard.ps1:82`; `00-admin/scripts/start-chrome-cdp.ps1:141` | Chrome недоступен → `needs_browser`, сбор частичный | Транспорт-абстракция (сейчас браузер — побочный путь) |
| **DSH (DeepSeek Harness)** | `dashboard/serve.mjs:34-66`; `collector/lib/profile.mjs:13-15,66`; `lib/settings.mjs:189,209-215`; `install/*.ps1` (8 файлов); `registry/agents.yaml`, `agent-settings/*.yaml` (5 файлов) | Нет `~/.dsh` → панель теряет профиль/настройки/скиллы; нет `dsh.cmd` → откат не работает | Перенос панели на собственный конфиг — самая дорогая часть (serve.mjs 155 КБ + collector 400+ КБ) |
| **LibreOffice Kit** | `client_report.py:29-31` | Нет LO Kit → нет DOCX/PDF (тест скипается, `test_clients.py:508-510`) | Альтернатива: `python-docx` + отдельный PDF-движок |
| **Serper** | `web_search.py:42-43`; `registry/integrations-catalog.yaml:29-36` (`dsh-serper-search`) | Нет `SERPER_API_KEY` → падение на DDG (`web_search.py:45`, `search_results.py:493-494`) | Есть фолбэк DDG — деградация, не отказ |
| **DuckDuckGo HTML** | `web_search.py:45`, `search_results.py:115-131` | Смена разметки DDG ломает парсер (`DDG_ANCHOR_RE`) | Парсер на regex, хрупкий |
| **ReefAPI / Apify / Rentcast / Zillapi / Rentscout / MCP** | `skills/real_estate/*.py` (8 модулей), ключи в `.env.example` | Не подключены к конвейеру (§1) → отказ вендора сегодня ничего не ломает | Пока не подключены — риск отложенный |

### 5.2 Смена LLM-провайдера: что придётся строить с нуля

**Факт: вызовов LLM в коде НЕТ.** Grep по `api.deepseek|chat/completions|/v1/messages|api.openai|generativelanguage|anthropic.com|api.zveno`
по коду проекта (без `connectors/`, `.gh-upload/`, `data/`, `logs/`) → **0 совпадений**.
LLM фигурирует только как (а) строки-имена моделей в YAML, (б) оценка стоимости.

**Что уже есть (переиспользуемо):**

| Есть | file:line | Ограничение |
| --- | --- | --- |
| Учёт токенов и стоимости | `collect_clients.py:468-480` `estimate_cost(model, chars_in, chars_out)`; вызывается `:770`, пишется в `registry/runs.jsonl` (`:819,824`) | Токены считаются как `символы / 4` — грубая оценка, не реальный usage |
| Реестр цен по моделям | `registry/prices.yaml` (9 523 Б, **16 моделей** + блоки `alternative`/`avoid`) | Ручное обновление; нет валюты/даты актуальности в рантайме |
| Лимиты агента | `registry/agent-settings/agent-3-creative.yaml:7` `model: {name, limit_rub: 0, limit_tokens: 0, on_limit: warn}` | Лимиты объявлены, но в коде **не применяются** (нет потребителя) |
| Дневной кэш | `lot_history_pipeline.py` (219 строк) | Кэш карточек Циан, не промптов |
| Абстракция источника данных | `skills/runtime/core.py` — контракт `fetch(query, **kwargs) -> list[dict]`, статусы (`skipped_no_key`, `not_deployed`, `error`, `empty`), журнал | Это абстракция **данных**, не LLM; как образец подходит, как решение — нет |

**Что придётся построить с нуля (7 блоков, ни одного нет в коде):**

1. **Абстракция провайдера** — единый клиент с `base_url`/`model`/`api_key` из конфига; сейчас в коде нет ни одного HTTP-вызова к LLM.
2. **Ретраи, таймауты, идемпотентность** — в проекте есть ретраи только для скрейпинга (`skills/runtime/http.py`), к LLM неприменимы напрямую.
3. **Реальный учёт токенов** — заменить `символы/4` (`collect_clients.py:477-478`) на usage из ответа; иначе `cost_rub` в `registry/runs.jsonl` систематически врёт.
4. **Кэш промптов** — сейчас нет вообще; есть только `prices.yaml` и дневной кэш карточек.
5. **Бюджетный контроль в рантайме** — `limit_rub`/`limit_tokens` из agent-settings (`on_limit: warn`) не читаются ни одним модулем.
6. **Логирование запросов/ответов и трассировка** — есть `skills/logs/skill-runs.jsonl` (2 269 записей) для скиллов и `registry/runs.jsonl` для прогонов, но не для LLM-вызовов.
7. **Обработка отказов провайдера/деградация** — ни fallback-модели, ни circuit breaker; `registry/prices.yaml:214-219` лишь перечисляет `alternative` и `avoid` текстом.

**Смена провайдера сегодня стоит:** правка 5 YAML с моделями + `collect_clients.py:488-491` (fallback модели) +
`registry/prices.yaml` (цены). Это дёшево ровно потому, что LLM-вызовов нет — как только они появятся,
все 7 блоков выше станут обязательными до первого продакшн-запуска.

---

## 6. Топ техдолг-рисков (сводка)

| # | Severity | Риск | Точные числа / доказательство |
| --- | --- | --- | --- |
| 1 | 🔴 | **Проект без VCS**: откат только 486 `.bak`-файлами | `.git` отсутствует в `тестDH` и `marketing-agents`; единственный git — `.gh-upload/.git` (3 коммита); 486 `.bak` = 3 194 578 Б; 429 из них созданы 31.10–01.11 |
| 2 | 🔴 | **Скиллы — параллельная ветка-дубль**, не подключены к конвейеру | `run_weekly.py:11-19`, `collect_clients.py:34-41` — 0 импортов скиллов; единственная точка — `reefapi_deep_check.py:43`; `skills/README.md:152-154`; 2 269 прогонов скиллов за 2 ч 13 мин (`skill-runs.jsonl`) |
| 3 | 🟠 | **F13 без регрессионного теста** + 465 тестов не покрывают e2e «сбор→снимок→аналитика→отчёт→письмо» | grep `SOURCE_VALUES` в тестах → 0; `test_contract_v2.py:493-509,555-568` требуют отсутствия отправки; `test_clients.py:532-542` — только `--dry-run`; 10 точек `skipTest` |
| 4 | 🟠 | **Переносимость**: зашитые абсолютные пути с именем пользователя + отсутствие Docker | `client_report.py:29,31`, `platforms.py:43`, `force-rollback.ps1:22`, `restore-profile-consistency.ps1:18`; 0 `Dockerfile`/`docker-compose` в проекте; панель читает `~/.dsh` (`profile.mjs:13-15`, `serve.mjs:34-66`) |
| 5 | 🟡 | **`pick_lot_price` задублирован** движок↔скилл, паритет держится 1 тестом на 5 строк | `platforms.py:220,261` vs `developer_pricing.py:178,238`; `test_clients.py:336-350`; скилл добавляет коридор ₽/м² (`developer_pricing.py:78-79`), которого нет в движке |

---

## Открытые вопросы без данных

1. **Реальные показатели живых прогонов** (сколько лотов/источников проходит при живом сборе, как часто
   срабатывает `needs_browser`/`needs_partnership`) — Chrome и сеть в этой среде недоступны. `[НЕ ХВАТАЕТ ДАННЫХ]`
2. **Тарифы и лимиты Serper / ReefAPI / Apify / Rentcast / Zillapi** — в репозитории есть только имена
   переменных окружения (`.env.example`) и текст в `registry/integrations-catalog.yaml:29-36`. `[НЕ ХВАТАЕТ ДАННЫХ]`
3. **Есть ли внешняя копия проекта** (GitHub/иной remote) и что именно в неё уехало — локально виден
   только `.gh-upload` без remote-конфигурации. `[НЕ ХВАТАЕТ ДАННЫХ]`
4. **Где скиллы позиционируются как продаваемый продукт** — в `monetization-stages-v2.md` и
   `concept-saas-2026-11-04.md` слово «скилл/skill» не встречается (0 совпадений). `[НЕ ХВАТАЕТ ДАННЫХ]`
5. **Планируется ли контейнеризация** и на какой ОС будет прод — от этого зависит, какие из A1–A11
   критичны, а какие нет. `[НЕ ХВАТАЕТ ДАННЫХ]`
6. **Кто владелец `.bak`-механики** (панель, движок или ручные операции): распределение 189/60/213/16
   по каталогам не объясняет, какой код создаёт бэкапы в `dashboard/**` и `landing/**`. `[НЕ ХВАТАЕТ ДАННЫХ]`
7. **Реальный `usage` токенов LLM** — вызовов нет, поэтому фактических цифр расхода не существует;
   `cost_rub` в `registry/runs.jsonl` посчитан как `символы/4` (`collect_clients.py:477-478`). `[НЕ ХВАТАЕТ ДАННЫХ]`
8. **Почему `dashboard/config/access.key` и `logs/smtp-check/*.pem` не в `.gitignore`** рабочей копии,
   хотя в `.gh-upload/.gitignore` они исключены — требуется решение владельца. `[НЕ ХВАТАЕТ ДАННЫХ]`
