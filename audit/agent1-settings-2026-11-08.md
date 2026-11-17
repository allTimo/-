# Аудит Агента 1: роль, границы, настройки, версионирование

Дата: 2026-11-08. Задача: `task-1`. Аудитор: teammate `settings-auditor`.
Метод: только чтение (`read`/`grep`/`glob`, `git`/`Get-FileHash`/`Get-Item`). Движок, панель,
`collect.mjs`, `ux-check.mjs` и планировщик **не запускались**; файлы проекта не менялись
(единственная запись — этот отчёт). Каждое утверждение — со ссылкой `путь:строка` или с цитатой.
Где факта нет — прямо написано «не предоставлено» и что запросить (§5).

Единица аудита: `marketing-agents/registry/agent-settings/agent-1-competitor-watch.yaml` (141 строка)
и код, который его читает. Полезный контекст — аудиты от 2026-11-08 в `marketing-agents/audit/`
(`agent-layer.md`, `techdebt-risks.md`, `00-architecture-audit-index-2026-11-08.md`, `verification.md`):
сверялся, факты перепроверял сам; расхождения — в §4.

---

## 1. Что фактически есть

### 1.1 Роль и границы (факты)

| Факт | Доказательство |
|---|---|
| «Агент 1» — **детерминированный Python-конвейер** на стандартной библиотеке, не LLM-агент | `registry/agents.yaml:10` (роль: «Раз в неделю собирает снимок предложения конкурентов…»); `01-competitor-watch/scripts/marketing_settings.py:32` («Standard library only»); `rg` по `temperature|max_tokens|system_prompt|chat/completions|api.deepseek|api.openai|completion(` в `01-competitor-watch/**/*.py` → **0 совпадений** (единственное совпадение во всём дереве — фраза «deterministic, no LLM» в скопированном скрипте `01-competitor-watch/data/_f10-live-20261104/registry/intake/scripts/text_to_tasks.py:9`) |
| LLM-полей у Агента 1 **нет** | ни `system prompt`, ни `temperature`, ни `max_tokens` в файле настроек и в коде; есть только оценка стоимости по символам (`01-competitor-watch/scripts/collect_clients.py:468-480`, `tokens = chars/4`) |
| Реальный триггер — задача Планировщика Windows | `install/agent1-weekly-task.xml:12` (`<DaysOfWeek><Thursday/></DaysOfWeek>`), `install/agent1-weekly.cmd:24` (`collect_clients.py --email-mode always`) |
| Услуга пилота привязана к агенту 1 | `registry/services.yaml:7-17` (`id: competitor-watch`, `agent: agent-1-competitor-watch`, `price_rub: 2900`, `status: active`) |
| Вторая услуга привязана к **тому же** агенту | `registry/services.yaml:31-41` (`id: listing-audit`, `agent: agent-1-competitor-watch` на `:34`, `status: planned`) — этой услуги нет ни в `registry/agents.yaml:18-19`, ни в движке |
| Агенты 2/3/4 — заготовки | `registry/agents.yaml:26-27,41-42,54-55` (`enabled: false`, `status: planned`) |
| Проект пилота один | `registry/projects.yaml:7-12` (`id: my-zhk-svet`, `agents: [agent-1-competitor-watch]`) |
| Клиентских конфигов два | `01-competitor-watch/config/clients/client-svet.yaml`, `.../client-granel.yaml` |

### 1.2 Таблица настроек: поле → значение → читается кодом

Значения — из `registry/agent-settings/agent-1-competitor-watch.yaml` (актуальное состояние,
SHA-256 `D8A025D26BCD7207…`). Колонка «читается кодом»: **да** — есть потребитель в движке;
**панель** — читает только интерфейс/сервер панели; **нет** — потребителя не найдено (grep/read).

| Поле (строка в YAML) | Значение | Читается кодом | Доказательство |
|---|---|---|---|
| `version`, `agent`, `updated` (`:5-7`) | `1`, `agent-1-competitor-watch`, `"2026-11-01"` | **нет** | `cwlib.load_agent_settings` (`cwlib.py:1038-1068`) возвращает словарь целиком; ни один потребитель не берёт `version`/`updated` (grep) |
| `schedule.enabled` (`:10`) | `true` | **панель** (не движок, не планировщик) | `dashboard/public/app-views15.js:168-174` (гейт автоподбора), `serve.mjs:86-92` (схема). В `01-competitor-watch/**` — 0 совпадений; `install/agent1-weekly.cmd:24` запускается задачей Windows, тумблер не смотрит |
| `schedule.days/time/frequency/timezone` (`:11-14`) | `[4]`, `"11:00"`, `weekly`, `Europe/Moscow` | **нет** | реальный триггер — `install/agent1-weekly-task.xml:12`; grep по движку → 0 |
| `schedule.only_on_new_data` (`:15`) | `true` | **нет** | grep по `01-competitor-watch/**` → 0 потребителей |
| `model.name` (`:18`) | `deepseek/deepseek-v4.1-flash` | **нет** | движок берёт модель из другого файла: `collect_clients.py:483-491` читает `registry/agents.yaml:13` через `cw.parse_simple_yaml` |
| `model.limit_rub` / `limit_tokens` / `on_limit` (`:19-21`) | `3000` / `2000000` / `pause` | **нет** | grep по движку → 0; панель только валидирует: `serve.mjs:94-95`, `verify-data.mjs:189` (проверка «не отрицательные») |
| `priority.level/max_parallel/timeout_sec/retries` (`:24-27`) | `normal` / `1` / `900` / `2` | **нет** | grep по движку → 0 потребителей настройки (`log_source_run.py:96,113` и `search_results.py:466-472` — свои локальные счётчики попыток, не чтение YAML); панель: `serve.mjs:99` |
| `report.formats` (`:30`) | `[md, xlsx]` | **нет** | фактический набор — `settings.yaml:69-71` → `cwlib.py:903-905` → `build_weekly_report.py:786`; для клиента — ещё и `clients.py:164` (`report_of`) → `client_report.py:255` |
| `report.sections` (`:31`) | `[summary, prices, changes, promos, limits]` (5 значений) | **нет** | движок печатает фиксированные 9 разделов: `build_weekly_report.py:32-41`; сверка структуры — только `settings.yaml:122-141` ↔ `cwlib.settings_structure_warnings` (`cwlib.py:947`) |
| `report.language` / `report.branding` (`:32-33`) | `ru` / `true` | **нет** | grep по `*.py` движка на `language`/`branding` → 0; только схема панели `serve.mjs:102` |
| `delivery.channels` (`:40`) | `[email]` | **да** | `delivery_email.py:58-64`, гейт `:81-82` |
| `delivery.addresses` (`:41`) | `["vodnev@d-a.ru", "tyurina@d-a.ru"]` | **да** | `delivery_email.py:196-202`, далее белый список `:208-218` |
| `delivery.auto_send` (`:42`) | `true` | **да** | `delivery_email.py:83-88` (для режима `always`) |
| `delivery.copy_to` (`:43`) | `""` | **нет** | grep по движку и панели на `copy_to` → только схема `serve.mjs:107` |
| `alerts.when/price_threshold_pct/quiet_hours` (`:46-48`) | `[fail, low_data]` / `5` / `22:00-08:00` | **нет** | grep по `01-competitor-watch/**` на `alerts|quiet_hours` → **0 совпадений**; схема панели `serve.mjs:110-113` |
| `limits.skip_weekends/min_interval_hours` (`:51-52`) | `true` / `168` | **нет** | grep по движку → 0 |
| `limits.stop_switch` (`:53`) | `false` | **панель** (не планировщик) | `app-views15.js:169-174`, `app-views12.js:44` («Немедленно запретить любые запуски агента»), `:254` |
| `agent1.projects` (`:56`) | `[my-zhk-svet]` | **частично (да)** | `discover_competitors.py:84-86` (только автоподбор); основной сбор идёт по клиентским конфигам (`clients.py:40`, `collect_clients.py:298-305`) |
| `agent1.price_threshold_pct` (`:57`) | `5` | **нормализуется, потребителя нет** | `marketing_settings.py:69-74` (дефолт 5.0), `:374-383` (валидация); grep `price_threshold` по движку → только эти строки. Фактический порог: `settings.yaml:32` (`0.5`) → `cwlib.py:876-878` → `build_weekly_report.py:795` |
| `agent1.min_lots` (`:58`) | `10` | **да** | `build_weekly_report.py:848` и `client_report.py:283` → `analytics.py:360-366` («мало данных») |
| `agent1.promo_words` (`:59`) | 4 слова | **нет** | `marketing_settings.py:82` (только список известных ключей); фактический словарь зашит в код: `platforms.py:104-105` (12 основ), применение `:413`. Второй мёртвый словарь — `settings.yaml:41-53` (`promo_keywords`), потребителей нет |
| `agent1.collect_mode` (`:60`) | `http` | **нет** | `marketing_settings.py:82` (known-key), потребителей нет; схема панели `serve.mjs:120` |
| `agent1.compare_depth_weeks` (`:61`) | `2` | **да** | `build_weekly_report.py:781-784` (перебивает `period_days`, пока тот равен 7) |
| `agent1.watch.query/name/url/address/lat/lon` (`:67-73`) | `https://svetdom.ru/`, «ЖК «Свет»», адрес, пустые lat/lon | **да** (автоподбор) | `discover_competitors.py:78-102` (`:81` — `cw.parse_simple_yaml`!), `cwlib.derive_watch_query:1086-1104`, геокодирование `discover_competitors.py:281-290` |
| `agent1.watch.radius_km/klass/max_candidates/sources/price_min_per_m2/price_max_per_m2` (`:74-79`) | `10` / `["бизнес"]` / `20` / 3 источника / `250000` / `450000` | **да** (только автоподбор) | `discover_competitors.py:89,91-97,344-345,365,382-385,442-445`; применение — через `POST /api/agent1/discover` (`serve.mjs:1163-1188`) |
| `agent1.selection.*` (15 полей, `:85-99`) | комнатность, площадь/цена 0, этажи false, 5 отделок, `only_active: true`, `price_metric: median`, guard + 3 границы | **да** | `marketing_settings.py:42-58` (дефолты), `:208-311` (нормализация), `:503-577` (`row_reject_reason`/`filter_rows`), `:650-772` (guard); применение: `collect_clients.py:385-388`, `analytics.py:348` |
| `agent1.top_deals_count` (`:102`) | `5` | **да** | `build_weekly_report.py:200` (`_REPORT_SETTINGS.get("top_deals_count", 5)`), `:780` |
| `agent1.analytics.*` (8 тумблеров, `:107-114`) | все `true` | **да** | `analytics.py:57-66`, `:71-84` (`resolve_toggles`), `:394-553`; применение `build_weekly_report.py:837-848` |
| `agent1.competitor_domains` (`:120-121`) | `{seliger-city.ru: zhk-seliger-siti}` | **частично (да)** | `budget_sources.py:402-408` — только в бюджетном срезе |
| `agent1.source_modes.*` (`:136-141`) | `cian: http`, `avito: browser`, `yandex-realty: http`, `domclick: off`, `developer-sites: http` | **нет** | `marketing_settings.py:84` (known-key), больше потребителей нет (подтверждает `docs/audit/audit-i1-env-2026-11-04.md:202`); фактический гейт сбора — клиентский конфиг: `clients.py:110-124`, `collect_clients.py:298-305` |
| `agent1.competitors` (**в файле отсутствует**) | — | **да** (запасной канал) | `discover_competitors.py:98` (`watch["confirmed"] = agent1.get("competitors")`), при этом `verify-data.mjs:230` требует, чтобы ключа не было |

Итог по таблице: **читаются** — `agent1.selection` (15), `agent1.analytics` (8), `agent1.watch` (12,
только автоподбор), `delivery.channels/addresses/auto_send`, `agent1.min_lots/compare_depth_weeks/
top_deals_count/projects`, `agent1.competitor_domains` (1 место). **Мёртвые** — 24 поля, включая
все системные группы (`schedule.*`, `model.*`, `priority.*`, `limits.*`, `alerts.*`, `report.*`,
кроме ничего) и 5 маркетинговых (`price_threshold_pct`, `promo_words`, `collect_mode`,
`source_modes`, `watch.sources` как гейт).

### 1.3 Что видит оператор

| Где | Что видно | Доказательство |
|---|---|---|
| `dashboard/public/data/agent-settings.json` | все группы, включая системные: `byAgent["agent-1-competitor-watch"]` содержит `schedule, model, priority, report, delivery, alerts, limits, agent1`; `agent1` содержит `price_threshold_pct=5`, `collect_mode=http`, `source_modes` (`domclick: "off"` — строкой), `analyticsPresent=true`, `selectionPresent=true` | прочитано `Get-Content | ConvertFrom-Json`: `top keys: byAgent, files, dir, exists, counts, warnings, newestMtimeMs, analyticsContract, selectionContract`; `counts={"files":5,"agents":5,"stub":3}` |
| Карточка Агента 1 | по контракту показывает только маркетинговые группы; системные — в разделе «Настройки» | `registry/README-agents-settings.md:119-126`; `docs/agent-1-rework-2026-11-04.md:58-60`; строки UI для системных полей — `dashboard/public/app-views12.js:29,44` |
| Статус агента | `state=done`, `verdict=«Работа сделана»`, `sourceOfTruth="registry/runs.jsonl"`, последний прогон 2026-11-04 15:45:31, `costRub=1.2391`, артефакт `2026-11-04-competitor-watch.pdf` | `dashboard/public/data/agent1-status.json` (прочитано) |
| Валидация панели | проверяет формат времени/дни/неотрицательные лимиты и что «эффективное расписание == файлу», «у Агента 1 есть специфичные настройки (проекты, порог, режим сбора)» | `dashboard/verify-data.mjs:184-210` |

---

## 2. Таблица находок

Severity: **P0** — искажает клиентский результат или делает заявленное управление фиктивным;
**P1** — настройка/гарантия не действует, риск для достоверности или для клиента;
**P2** — расхождение, неоднозначность истины, ложная уверенность;
**P3** — гигиена/документация.

| ID | Область | Находка | Доказательство | Влияние | Sev | Рекомендация | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| F-01 | Роль/границы, безопасность настроек | **Стоп-кран и тумблер расписания не останавливают плановую рассылку.** `limits.stop_switch: false` и `schedule.enabled` читает только фронт панели для автоподбора; задача Windows запускает `collect_clients.py --email-mode always` и при `auto_send: true` шлёт письмо клиенту независимо от них. UI подписывает поле как «Немедленно запретить любые запуски агента» | `registry/agent-settings/agent-1-competitor-watch.yaml:10,53`; `dashboard/public/app-views12.js:44,254`; `dashboard/public/app-views15.js:162-174`; `install/agent1-weekly.cmd:24`; `delivery_email.py:83-88`; grep по `01-competitor-watch/**` на `stop_switch|only_on_new_data` → 0 | Оператор считает агента выключенным, а отчёт с цифрами уходит клиенту; штатного «стоп» нет | **P0** | Ввести проверку `stop_switch`/`enabled` в точку запуска (`install/agent1-weekly.cmd` и `collect_clients.py:main`) до сбора и до отправки; при `stop_switch: true` — выход с кодом 3 и записью в журнал. Пока не реализовано — убрать из UI формулировку «запретить любые запуски» и честно написать «только автоподбор из панели» | Прогон при `stop_switch: true`: писем нет (0 записей отправки), в `runs.jsonl` запись `status=skipped_stop`; UI не обещает остановку планового прогона |
| F-02 | Настройки (порог цены) | **Поле «порог значимого изменения цены» = 5 %, движок использует 0,5 %.** `agent1.price_threshold_pct` нормализуется, но потребителя нет; порог приходит из `settings.yaml thresholds.price_change_pct` — в 10 раз меньше | `agent-settings…yaml:57`; `marketing_settings.py:69-74,374-383`; grep `price_threshold` по движку → только `marketing_settings.py`; `00-admin/config/settings.yaml:32` (`0.5`); `cwlib.py:876-878`; `build_weekly_report.py:795` | Раздел «4. Изменения цен по лотам» и «Главное за неделю» показывают клиенту шум как значимые изменения; карточка и отчёт расходятся по цифре | **P0** | Прочитать `agent1.price_threshold_pct` в `build_weekly_report.py`/`collect_clients.py` как приоритетный порог (или удалить поле и оставить один порог в `settings.yaml`), при расхождении — печатать предупреждение | Изменение поля в карточке меняет число строк в разделе 4 (тест на фикстуре: порог 5 → строк меньше, чем при 0.5); в отчёте напечатан фактически применённый порог |
| F-03 | Настройки (акции) | **Оба словаря акций мертвы, работает скрытый список в коде.** `agent1.promo_words` (редактируется, есть в схеме панели) и `settings.yaml promo_keywords` (11 слов) не читаются; фактически — `PROMO_WORDS` в `platforms.py` | `agent-settings…yaml:59`; `marketing_settings.py:82`; `00-admin/config/settings.yaml:41-53`; `platforms.py:104-105,413`; grep `promo_keywords` по `*.mjs` и `*.py` движка → 0 потребителей | Раздел «5. Акции и промо» не реагирует на правку; клиент получает промо по списку, которого нет ни в панели, ни в настройках | **P1** | Передавать словарь из настроек в `platforms.clean_promo_text/looks_like_promo_text` (параметром), оставить один источник: `agent1.promo_words`; `settings.yaml promo_keywords` — либо удалить, либо сделать его значением по умолчанию с явной пометкой | Изменение списка слов меняет `promo_flag` в снимке (тест); в отчёте «Ограничения» напечатан применённый список |
| F-04 | Настройки (источники), роль | **Три «единственных» источника правды по источникам сбора и конфликт значений.** Файл агента называет `agent1.source_modes` «единственным местом, где задаётся доступ и способ сбора», README — клиентский конфиг «ГЛАВНЫМ источником правды», а фактический гейт — только клиентский конфиг. `domclick` у агента `off` и исключён из `watch.sources`, у клиента включён | `agent-settings…yaml:123-135,137-141`; `registry/README-agents-settings.md:28-35`; `clients.py:40,110-124`; `collect_clients.py:298-305`; `01-competitor-watch/config/clients/client-svet.yaml:60` (`domclick enabled: true`) | Оператор правит режимы сбора в карточке — сбор не меняется; решение «domclick выключен» противоречит конфигу клиента | **P1** | Решить: `source_modes` — либо реальный гейт (тогда читать в `collect_clients.py` как override клиентского конфига), либо справочная карта (тогда убрать из «известных ключей» и честно подписать в UI «не влияет на сбор»); устранить конфликт domclick | Grep-тест: `source_modes` имеет ровно одного потребителя в движке; `verify-data.mjs` сверяет `source_modes` с клиентскими `sources` и падает при конфликте |
| F-05 | Безопасность настроек | **Лимиты расхода декоративны.** `limit_rub: 3000`, `limit_tokens: 2000000`, `on_limit: pause` не читает никто; счётчика токенов нет, а в журнал пишется оценка `cost_rub` по «символы/4», которая с лимитом не сравнивается | `agent-settings…yaml:19-21`; grep по движку → 0; `collect_clients.py:468-480` (`tokens = chars/4`), `:768-770`; `dashboard/public/data/agent1-status.json` (`costRub: 1.2391`); `dashboard/collector/lib/analytics2.mjs:54,138` | Лимит не может сработать: при аномальном прогоне остановки не будет; оператор видит «себестоимость», не связанную с фактом | **P1** | Либо реализовать накопительный счётчик расхода прогонов и сравнивать с `limit_rub`/`limit_tokens` по `on_limit`, либо убрать поля из схемы и честно пометить «оценка, лимит не применяется» | Прогон при `limit_rub`, меньшем накопленного расхода: статус `paused`/`stopped` и запись причины; в UI подпись «оценка, не факт» |
| F-06 | Безопасность настроек | **Алертов нет вообще.** `alerts.when: [fail, low_data]`, `price_threshold_pct`, `quiet_hours` не читает ни один модуль | `agent-settings…yaml:46-48`; grep `alerts|quiet_hours` по `01-competitor-watch/**` → 0 совпадений | Если прогон упал или данных мало, клиент просто не получит отчёт — узнают случайно | **P1** | Реализовать минимальный алерт: запись в `runs.jsonl` со `status=failed` + письмо/сообщение по `alerts.when` с учётом `quiet_hours`; либо убрать группу и зафиксировать «алертов нет» в карточке статуса | Прогон с искусственной ошибкой источника и `when: [fail]`: алерт доставлен/зафиксирован с указанием причины; при `when: [never]` — ничего |
| F-07 | Настройки (исполнение) | **Таймаут/ретраи/параллельность не действуют, а панель режет по-своему.** `priority.timeout_sec: 900`, `retries: 2` не читаются; панель запускает движок с 300 000 мс и 180 000 мс | `agent-settings…yaml:24-27`; grep по движку → 0 (кроме локальных счётчиков `log_source_run.py:96`, `search_results.py:466`); `dashboard/serve.mjs:1188,1362,1891` | Упавший/зависший прогон не переигрывается; «один агент — три таймаута», поведение непредсказуемо | **P1** | Взять `timeout_sec`/`retries` из настроек в точку запуска (панель и `agent1-weekly.cmd`), печатать фактический таймаут в журнал | Значение `timeout_sec` из файла видно в логе прогона; при `retries: 2` провалившийся источник повторяется дважды (тест) |
| F-12 | Версионирование | **Последняя правка файла не откатывается и не датирована.** Текущий SHA-256 не совпадает ни с одной из 25 копий `.bak-*`; самая свежая копия — 2026-11-01 14:17:39, файл изменён 2026-11-04 00:27:45, а в шапке `updated: "2026-11-01"` | `Get-FileHash` текущего файла (`D8A025D2…`) vs 25 копий → `matches=0`; `Get-ChildItem … -Filter 'agent-1*.bak-*'` → newest `…bak-20261101-141739-515`; `(Get-Item).LastWriteTime` → `2026-11-04 00:27:45`; `agent-settings…yaml:7` | Текущее состояние настроек невосстановимо из копий; невозможно понять, что и когда изменили (а именно это обещано: «правка атомарная, обратимость по SHA-256») | **P1** | Запретить правку файла мимо панели (или делать `.bak` и при правке извне), обновлять `updated` при каждом сохранении, добавить `schema_version` и `updated_by`; хранить `sha256` текущего состояния в данных панели | `updated` в файле совпадает с mtime с точностью до дня; для текущего содержимого существует `.bak` с совпадающим SHA-256; `verify-data.mjs` падает при расхождении |
| F-13 | Версионирование/воспроизводимость | **VCS нет, копии вне VCS.** `git rev-parse` → «not a git repository» (и для `тестDH`, и для `marketing-agents`); `*.bak-*` исключены из git | `git -C … rev-parse --is-inside-work-tree` → `fatal: not a git repository`; `marketing-agents/.gitignore:5` (`*.bak-*`) | Нет истории настроек и кода: откат возможен только по живым локальным `.bak` и только для файлов, которые правит панель | **P1** | Инициализировать git (или иной VCS) для `marketing-agents/**` без секретов, с фиксацией настроек Агента 1 и кода движка; либо явно зафиксировать решение «VCS не используем» и перенести `.bak` в отдельное хранилище с TTL | Есть `git log` по `marketing-agents/registry/agent-settings/**` и `01-competitor-watch/scripts/**`; секреты отсутствуют в индексе (`git check-ignore` проходит для `.env`, `.smtp-password.local`) |
| F-20 | Безопасность настроек | **Белый список получателей fail-open.** Пустой/отсутствующий `recipients_allowlist` = «без ограничения»: письмо уйдёт на любой адрес из `delivery.addresses`/клиентского конфига. Сейчас список задан и работает | `delivery_email.py:138-155` («An empty/missing list means “no restriction”»), `:158-166`; `agent-settings…yaml:41`; `00-admin/config/settings.yaml:109-111` | Случайное удаление строк белого списка снова открывает отправку произвольному адресу; для пилота «отчёт уходит клиенту» это критично | **P1** | Сделать список fail-closed: пустой список = отказ отправки с причиной; сам список — обязательный, с тестом | При пустом `recipients_allowlist` письмо не отправляется, статус «не отправлено: белый список пуст»; существующий тест покрывает оба состояния |
| F-08 | Настройки (отчёт) | **`report.sections` не читается и не совпадает с отчётом.** В файле 5 имён секций, движок печатает 9 фиксированных заголовков | `agent-settings…yaml:31`; `build_weekly_report.py:32-41`; сверка структуры только с `settings.yaml:122-141` (`cwlib.py:947`) | Оператор не может влиять на состав отчёта; список вводит в заблуждение (5 ≠ 9) | **P2** | Убрать `report.sections` из схемы панели и файла либо заменить на честный read-only список реальных 9 разделов | Схема панели не содержит `sections`; в карточке виден read-only перечень 9 фактических заголовков |
| F-09 | Настройки (отчёт) | **Три объявления форматов с разными значениями.** `report.formats: [md, xlsx]` (агент, мёртв), `output.formats: [md, xlsx]` (settings.yaml, читается), `report.formats: [md, xlsx, pdf]` (клиент, читается для клиентского пути) | `agent-settings…yaml:30`; `00-admin/config/settings.yaml:69-71`; `cwlib.py:903-905`; `build_weekly_report.py:786`; `clients.py:164`; `client_report.py:255`; `01-competitor-watch/config/clients/client-svet.yaml:47` | Непонятно, что именно управляет форматами; правка в карточке не меняет выход | **P2** | Оставить один источник для клиентского отчёта (клиентский конфиг) и один для «внутреннего» прогона; удалить `report.formats` из файла агента и из схемы | Grep: у форматов не более двух потребителей с явным приоритетом; тест «формат из клиентского конфига побеждает» |
| F-11 | Версионирование | **У настроек нет машинной версии.** `version: 1` в файле никто не читает и ни с чем не сверяет (у `analytics`/`diff` `SCHEMA_VERSION = 1` есть) | `agent-settings…yaml:5`; grep `version` по `cwlib.load_agent_settings` — возвращается как обычный ключ, потребителей нет; для сравнения: `analytics.py:50`, `diff_snapshots.py:23` | Нельзя отличить несовместимую схему настроек от совместимой; миграции нечем запускать | **P2** | Ввести `schema_version` и проверку при загрузке: незнакомая версия → отказ работать на дефолтах + предупреждение в отчёт | Прогон с `schema_version: 99` даёт явное предупреждение и не молчит; `verify-data.mjs` проверяет совпадение версии |
| F-14 | Воспроизводимость | **Один YAML читают два разных парсера.** `cwlib.load_agent_settings` использует PyYAML, если он есть; `discover_competitors.py:81` всегда использует встроенный мини-парсер. Значения расходятся: `source_modes.domclick: off` → `False` под PyYAML и строка `'off'` под мини-парсером (по данным прошлого аудита; мной запуском не перепроверялось) | `cwlib.py:1052-1062`; `discover_competitors.py:81`; `docs/audit/audit-i1-env-2026-11-04.md:200`; наблюдение из данных панели: `agent-settings.json` → `source_modes.domclick = "off"` (строкой) | Латентный класс ошибок: при первом же реальном чтении `source_modes` агент и панель увидят разные значения; «тихое» расхождение поведения | **P2** | Один читатель YAML на весь движок (`cwlib.load_agent_settings`), запретить `parse_simple_yaml` для файла настроек; значение `off` заменить на явное `disabled`, чтобы не зависеть от YAML 1.1 | Grep: файл настроек читается ровно одним модулем; тест на равенство разбора PyYAML и мини-парсера (или мини-парсер удалён из этого пути) |
| F-15 | Роль/границы | **Один агент заявлен исполнителем двух разных услуг.** `listing-audit` («Размещение и аудит на площадках») привязан к `agent-1-competitor-watch`, хотя движка для неё нет и в `agents.yaml` таких выходов нет | `registry/services.yaml:31-41` (`agent: agent-1-competitor-watch` на `:34`); `registry/agents.yaml:18-19` (`inputs`/`outputs` — отчёты и снимки) | Размывается граница «что делает Агент 1»: услуга продаётся как агентская, исполнителя нет | **P2** | Убрать привязку `listing-audit` к агенту 1 (оставить без исполнителя/`status: planned`) до появления движка; зафиксировать в `agents.yaml` перечень услуг агента | `services.yaml`: у `listing-audit` нет `agent` либо указан новый агент; `verify-data.mjs` падает, если активная услуга ссылается на несуществующий движок |
| F-16 | Роль/границы | **Два канала истины по конкурентам.** Клиентские конфиги объявлены главным источником, но движок читает и запасной `agent1.competitors` из настроек агента, а `verify-data.mjs` требует, чтобы этого ключа в файле не было | `registry/README-agents-settings.md:28-35`; `discover_competitors.py:98`; `verify-data.mjs:229-230`; `agent-settings…yaml:62-64` (комментарий «ЗДЕСЬ НЕ ХРАНЯТСЯ») | Возврат списка конкурентов в настройки агента молча изменит состав анализа (панель этого не ловит) | **P2** | Удалить чтение `agent1.competitors` из движка (или явно запретить и падать при наличии ключа) | Grep: `agent1.competitors` не читается ни одним модулем; тест «ключ в файле → явная ошибка, а не тихое расширение списка» |
| F-18 | Роль/границы | **Расписание объявлено трижды, реальный триггер — четвёртый; проверка панели это маскирует.** `agents.yaml:17`, `settings.yaml:23`, `agent-settings…yaml:11-12` против задачи Windows; `verify-data.mjs` называет проверку «эффективное расписание Агента 1 == файлу», но сверяет только формат `ЧЧ:ММ` | `registry/agents.yaml:17`; `00-admin/config/settings.yaml:23`; `agent-settings…yaml:11-12`; `install/agent1-weekly-task.xml:12`; `verify-data.mjs:202-203` | «Эффективное расписание» подтверждается формально; расхождение файла и планировщика не диагностируется | **P2** | Сверять расписание с зарегистрированной задачей (или сделать файл источником, из которого задача создаётся) и добавить проверку `time/frequency` против XML | `verify-data.mjs` сравнивает `days/time` файла с `install/agent1-weekly-task.xml` и падает при расхождении |
| F-22 | Настройки/панель | **Панель подтверждает «эффективность» мёртвых полей.** Проверка «у Агента 1 есть специфичные настройки (проекты, порог, режим сбора)» печатает `порог 5%, режим http`, хотя `price_threshold_pct` не применяется, а `collect_mode` не читается; лимиты проверяются только на неотрицательность | `dashboard/verify-data.mjs:189,204-206`; `marketing_settings.py:82`; grep `collect_mode` по движку → `marketing_settings.py:82` | Зелёная проверка создаёт ложную уверенность, что поле действует | **P2** | Заменить проверки на проверки потребителей: для каждого поля-настройки — тест/карта «где читается»; мёртвые поля из карточки убрать (правило 2 контракта) | `verify-data.mjs` падает, если поле из схемы панели не имеет потребителя в движке (карта «поле → потребитель») |
| F-10 | Настройки (гигиена) | **Мёртвые поля-остатки:** `report.language`, `report.branding`, `delivery.copy_to`, `version/agent/updated` не читает никто | `agent-settings…yaml:5-7,32-33,43`; `serve.mjs:102,107` (только схема); grep `branding|copy_to|language` по `*.py` движка → 0 | Шум в карточке и в файле: оператор правит то, что не действует (нарушение правила 2 контракта) | **P3** | Удалить из схемы панели и файла либо пометить read-only «не применяется» | Схема панели не содержит полей без потребителя (кроме явно помеченных read-only) |
| F-17 | Роль/границы | **Дубли порогов «мало данных» и «мало лотов для статистики».** `agent1.min_lots: 10` (аналитика), `quality.warn_if_lots_below: 10` (уведомление отчёта), `thresholds.min_lots_for_stats: 3` (медианные таблицы) — три порога с разными потребителями | `agent-settings…yaml:58`; `analytics.py:360-366`; `00-admin/config/settings.yaml:182`; `cwlib.py:894-896`; `settings.yaml:36`; `diff_snapshots.py:91` | Один и тот же смысл «мало данных» живёт в трёх местах; значения могут разъехаться | **P3** | Свести к одному порогу (или явно описать три разных смысла в README настроек) | В README — таблица «порог → смысл → потребитель»; тест на согласованность значений |
| F-19 | Документы | **Контракт переработки устарел относительно кода.** `docs/agent-1-rework-2026-11-04.md:30` утверждает «`POST /api/agent1/discover` — заглушка, всегда 501 stub», фактически сервер запускает движок; `:39-40` утверждает, что `delivery.auto_send`/`channels` «движок не читает (слова `auto_send` нет вообще)» — читает | `docs/agent-1-rework-2026-11-04.md:30,39-40`; `dashboard/serve.mjs:1163-1188`; `delivery_email.py:58-64,83-88`; `docs/open-tasks-2026-11-04.md:27` (D3 закрыто) | Планирование и приёмка идут по устаревшему контракту; проверяющий может «закрыть» уже сделанное или ждать несуществующей заглушки | **P3** | Пометить в документе дату актуализации и переписать §2 по факту; ввести правило «контракт устаревает вместе с закрытием дефекта» | В `docs/agent-1-rework-2026-11-04.md` §2 соответствует коду на дату; расхождений с `serve.mjs`/`delivery_email.py` нет |
| F-21 | Код | **`watch_applied_note` объявлена и не вызывается** — отчёт никогда не сообщает, где применяется охват (`radius/klass/max_candidates/sources`), хотя docstring обещает обратное | `marketing_settings.py:824-842` (определение); grep по движку → вызовов нет | Читатель отчёта не видит, что охват конкурентов применён в автоподборе — «Ограничения» неполные | **P3** | Вызвать `watch_applied_note` в блоке «Ограничения» (или удалить функцию) | В отчёте есть строка «Охват конкурентов (agent1.watch) применяется при автоподборе…» при непустых полях; тест на наличие строки |

**Счётчики находок: P0 — 2, P1 — 8, P2 — 8, P3 — 4. Всего 22.**

---

## 3. Scorecard (1–5)

| Критерий | Оценка | Обоснование (факты) |
|---|---|---|
| **Роль/границы** | **2 / 5** | Плюсы: роль Агента 1 описана и совпадает с движком (`agents.yaml:10` × `install/agent1-weekly.cmd:24`); зоны записи зафиксированы (`docs/agent-1-rework-2026-11-04.md:136-148`); агенты 2–4 честно `planned` (`agents.yaml:26-27,41-42,54-55`). Минусы: один агент привязан к двум услугам (F-15), два канала истины по конкурентам (F-16), расписание в четырёх местах (F-18), мёртвые лимиты/ретраи/алерты делают «агента» декорацией (F-05, F-06, F-07) |
| **Настройки** | **2 / 5** | Плюсы (сильная часть): 15/15 полей `agent1.selection` реально применяются (`marketing_settings.py:503-577,650-772`; `collect_clients.py:385-388`), 8/8 тумблеров аналитики (`analytics.py:71-84`), `watch` (12 полей) работает в автоподборе, `delivery.channels/addresses/auto_send` читаются, честные дефолты/предупреждения при неизвестных ключах (`marketing_settings.py:305-308,412-415`). Минусы: 24 мёртвых поля, из них 5 маркетинговых и видимых оператору (F-02, F-03, F-04, F-08, F-09, F-10), что прямо нарушает правило 2 контракта («поле, показанное в панели, обязано читаться движком» — `docs/agent-1-marketing-settings-contract.md:84`) |
| **Безопасность настроек** | **3 / 5** | Плюсы: белый список работает и отказы объясняются словами (`delivery_email.py:138-166,210-218`); секретов в файле настроек нет — SMTP-пароль через env/локальный файл вне репозитория (`settings.yaml:100-101`, `.gitignore:3-4`); гейт отправки «канал + `auto_send` + режим» реализован (`delivery_email.py:67-89`); снимок не переписывается guard-ом выбросов (`marketing_settings.py:727-772`). Минусы: белый список fail-open (F-20), стоп-кран не останавливает плановую рассылку (F-01), лимиты расхода и алерты не работают (F-05, F-06), адреса получателей лежат в открытом виде в файле и в его 25 копиях (`agent-settings…yaml:41`; `registry/results.yaml` — `sent_to`, по `audit/agent-layer.md:290`); prompt injection неприменим, т.к. LLM нет (подтверждено grep-ом) |
| **Версионирование/воспроизводимость** | **2 / 5** | Плюсы: механика панели есть и покрыта тестами — атомарная запись `.bak-<timestamp>`, список копий и откат по SHA-256 (`serve.mjs:470-472,807-822,2166-2184`; `_ux-harness/test-toggle-e2e.mjs:76-83`); у `analytics`/`diff` есть `SCHEMA_VERSION` (`analytics.py:50`, `diff_snapshots.py:23`). Минусы: VCS нет (F-13), последняя правка без копии и со старым `updated` (F-12), `version` настроек не проверяется (F-11), два парсера одного файла (F-14), часть кода/шаблонов вне механизма копий (`audit/agent-layer.md:251-252`) |

Средняя: **2,25 / 5**. Наиболее дешёвый прирост дают F-01, F-02, F-03 (правки в 2–3 модулях закрывают
оба P0 и главный P1 по достоверности отчёта).

---

## 4. Сверка с аудитами от 2026-11-08 и расхождения документов

Подтверждено мной независимо: настройки `schedule/model/priority/limits/alerts/report`, а также
`agent1.promo_words/collect_mode/source_modes`, не имеют потребителей в движке (совпадает с
`audit/agent-layer.md:52-65`, `audit/00-architecture-audit-index-2026-11-08.md:27`,
`audit/verification.md:18`, `audit/techdebt-risks.md:360`). `delivery.channels/auto_send/addresses`
читаются (совпадает с `agent-layer.md:63`). Уточнения и расхождения, найденные при этой проверке:

| # | Расхождение | Доказательство |
|---|---|---|
| D-1 | `audit/agent-layer.md:47` цитирует `AGENT_SETTINGS_SCHEMA` как `dashboard/serve.mjs:88-112`; фактически объект занимает `:86-179` (`const AGENT_SETTINGS_SCHEMA = {` на `:86`, закрывающая `};` на `:179`). Уже отмечалось в `audit/verification.md:33` — подтверждаю | `dashboard/serve.mjs:86,179` |
| D-2 | `docs/agent-1-rework-2026-11-04.md:30`: «`POST /api/agent1/discover` — заглушка, всегда 501 stub» — **неверно сейчас**: сервер запускает `discover_competitors.py` с `--settings-file` | `dashboard/serve.mjs:1163-1188` |
| D-3 | `docs/agent-1-rework-2026-11-04.md:39-40`: «`delivery.auto_send` и `delivery.channels` движок **не читает** (в Python-коде слова `auto_send` нет вообще)» — **неверно**: `auto_send` читается; D3 закрыт (`docs/open-tasks-2026-11-04.md:27`, `docs/roadmap.md:37`), а контракт остался старым | `delivery_email.py:58-64,83-88` |
| D-4 | Число тестов расходится минимум в четырёх местах: `registry/agents.yaml:21` и `registry/services.yaml:17` — «52 теста»; `docs/agent-1-rework-2026-11-04.md:152` — «базлайн 268 passed»; `audit/00-architecture-audit-index-2026-11-08.md:36` — «465». Мой замер (grep, без запуска): **357 методов `def test_` в 19 файлах** `01-competitor-watch/tests/` | `agents.yaml:21`; `services.yaml:17`; `docs/agent-1-rework-2026-11-04.md:152`; `audit/00-architecture-audit-index-2026-11-08.md:36`; замер `Select-String '^\s*def test_'` |
| D-5 | Два «единственных» источника правды в одном проекте: `registry/README-agents-settings.md:30` (клиентский конфиг — «ГЛАВНЫЙ источник правды») и `agent-settings…yaml:123-135` (`source_modes` — «единственное место, где задаётся доступ и способ сбора») | `README-agents-settings.md:28-35`; `agent-settings…yaml:123-135` |
| D-6 | `registry/README-agents-settings.md:79-80` утверждает: «Все 15 полей правимы из панели **и читаются движком**» — для `agent1.selection` это верно (проверено), но README в том же разделе не помечает мёртвые поля соседних групп; правило 2 контракта (`agent-1-marketing-settings-contract.md:84`) нарушено 5 маркетинговыми полями | `README-agents-settings.md:79-80`; таблица §1.2 настоящего отчёта |
| D-7 | `audit/00-architecture-audit-index-2026-11-08.md:27` перечисляет `schedule`, `enabled`, `limits`, `retries`, `timeout_sec`, `alerts` как «не читает ни один модуль». Для **движка** верно, но `schedule.enabled` и `limits.stop_switch` читает интерфейс панели — для автоподбора по сохранению `agent1.watch.query` | `dashboard/public/app-views15.js:168-174`; `app-views12.js:254` |

---

## 5. Не предоставлено / запросить

1. **LLM-слой — «не предоставлено (LLM в контуре нет)».** Ни `system prompt`, ни `temperature`,
   ни `max_tokens`, ни `retries` для модели в проекте нет; grep по `01-competitor-watch/**/*.py`
   на `temperature|max_tokens|system_prompt|chat/completions|api.deepseek|api.openai|completion(` → 0.
   Запрашивать нечего **до** решения о включении LLM; при включении потребуется артефакт
   «файл промпта + версия промпта + бюджет токенов».
2. **Продуктовое решение по `alerts`** (кому, когда, в каком канале сообщать о сбое/малых данных) —
   не предоставлено. Запросить: правила алертов и получателя.
3. **Решение по `model.limit_rub/limit_tokens/on_limit`** — не предоставлено: считать ли лимит
   по накопленной оценке `cost_rub` из `registry/runs.jsonl` или вводить реальный счётчик токенов.
4. **Кто и как правит файл настроек вне панели** — не предоставлено: файл изменён 2026-11-04 00:27:45
   без соответствующего `.bak` (`matches=0`), то есть последняя правка шла мимо панели. Запросить
   регламент (только панель / только Lead / допустимо вручную) и признак «правка извне».
5. **Назначение `agent1.source_modes`** — не предоставлено: справочная карта или реальный гейт
   сбора (D-5, F-04). Запросить решение, иначе поле останется мёртвым с противоречивой
   документацией.
6. **Смысл `version: 1`** в файле настроек (формат, кто повышает, что считается несовместимым) —
   не предоставлено (F-11).
7. **Владение и ротация `.bak`** — не предоставлено: 25 копий только по Агенту 1 в
   `registry/agent-settings/`, TTL/архивации нет; `*.bak-*` вне git (`.gitignore:5`). Нужен владелец
   и политика хранения.
8. **Фактическое состояние задачи `Agent1-Weekly`** (зарегистрирована ли, `Last Run Result`,
   `Next Run Time`) — из песочницы недоступно; запросить `schtasks /Query /TN \Agent1-Weekly /V /FO LIST`
   (косвенно: `audit/agent-layer.md:315`).
9. **Запуск тестов как доказательство**: тесты не запускались (запрет на запуск скриптов движка),
   поэтому «52 / 268 / 357 / 465» — это заявления и grep, а не результат прогона. Запросить прогон
   `python -m pytest marketing-agents/01-competitor-watch/tests -q` у того, кому разрешён запуск.
10. **Позитивный путь отправки письма живым SMTP** после новой логики — не предоставлено
    (совпадает с `docs/agent-1-rework-2026-11-04-result.md:47`); фактический `sent` на живые адреса
    не проверялся, а плановый прогон шлёт с `--email-mode always`.
11. **Аутентификация панели и доступность порта** — не проверялось мной (вне границ этой задачи);
    в `audit/agent-layer.md:309` зафиксировано отсутствие проверки доступа в `serve.mjs`. Запросить
    модель угроз панели, если она доступна вне localhost.

---

## Приложение. Как проверялось

- Чтение: `read` с `offset`/`limit` (файл настроек целиком; `marketing_settings.py` целиком;
  `build_weekly_report.py:33-102,740-859`; `delivery_email.py:40-279`; `cwlib.py:430-549,790-919,1020-1112`;
  `analytics.py:30-159`; `discover_competitors.py:60-119`; `collect_clients.py:296-345,478-507`;
  `serve.mjs:80-189,1160-1204`; `verify-data.mjs:180-249`; `settings.yaml`; `README-agents-settings.md`;
  контракт, `working-rules.md`, `agent-1-rework-2026-11-04.md`, `client-svet.yaml`, `services.yaml`,
  `projects.yaml`, `agents.yaml`, `audit/agent-layer.md`, `audit/00-architecture-audit-index-2026-11-08.md`).
- Поиск: `grep` по `01-competitor-watch/**`, `dashboard/**`, `registry/**`, `docs/**` по ключам
  `limit_rub|limit_tokens|on_limit|max_parallel|timeout_sec|retries|only_on_new_data|min_interval_hours|stop_switch|skip_weekends|quiet_hours|copy_to|promo_words|collect_mode|source_modes|price_threshold|branding|language|promo_keywords|watch_applied_note|min_lots|top_deals|compare_depth_weeks|competitor_domains`.
  Копии `*.bak-*` и каталог `01-competitor-watch/data/_f10-live-20261104/**` из выводов исключались.
- Хеши и даты: `Get-FileHash -Algorithm SHA256` текущего файла настроек и 25 копий
  (`matches=0`); `Get-Item.LastWriteTime` (2026-11-04 00:27:45); список копий по имени.
- Данные панели: `Get-Content | ConvertFrom-Json` для `agent-settings.json` и `agent1-status.json`
  (выведены только имена ключей и агрегаты, без дампов).
- VCS: `git -C <root> rev-parse --is-inside-work-tree` → `fatal: not a git repository`.
- **Не выполнялось:** запуск Python-движка, `collect.mjs`, `verify-data.mjs`, `ux-check.mjs`,
  панели, планировщика, pytest, любых скиллов; никаких записей в файлы проекта, кроме этого отчёта.
