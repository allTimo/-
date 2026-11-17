# WP5: независимая приёмка Агента 1 «Мониторинг конкурентов» — 03.11.2026

**Приёмщик:** verifier (shared task `task-2`), не автор WP1/WP2/WP3.
**Проект:** `C:\Users\Артем\Desktop\тестDH\marketing-agents`.
**Исходное состояние:** `docs/agent-1-handoff-2026-11-03.md`; отчёты исполнителей — `docs/wp3-agent1-panel-report-2026-11-03.md` (WP3), отчёты WP1/WP2 — в handoff.
**Метод:** только первоисточники (файлы, журналы, реальные прогоны). Отчёты исполнителей использовались как список заявок, а не как доказательство.
**Зона записи:** `marketing-agents/05-verification/**`. `registry/**` и `dashboard/**` — только чтение (соблюдено; временные пробы писались в `%TEMP%`).

**Окружение прогонов**

- node: `C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` (в PATH нет).
- Python: `marketing-agents\connectors\ru-marketplace-mcp\.venv\Scripts\python.exe`.
- Оболочка — Windows PowerShell 5.1: файлы с кириллицей читаются только с `-Encoding UTF8` (иначе ложные «не найдено»).
- Обновление к handoff: каталог `01-competitor-watch\tests\.tmp-run` **больше не существует** (`Get-Item` → PathNotFound), блокировка рекурсивного обхода снята; `pytest` собирается штатно за ~29 с.

**Сводка вердиктов**

| № | Пункт | Вердикт |
|---|---|---|
| 1 | Расписание «четверг 11:00» | ПОДТВЕРЖДЕНО (кроме задачи Windows — не проверяема из песочницы) |
| 2 | Список конкурентов client-svet | **НЕ ПОДТВЕРЖДЕНО** (совпало 3 ЖК из 6) |
| 3 | Почта: адреса, SMTP, .eml, статусы | ЧАСТИЧНО (конфиг и механизм — да, живые артефакты и журнал — нет) |
| 4 | Влияние 8 тумблеров, `watch.query`, индикатор, «Аналитика» | ПОДТВЕРЖДЕНО (автозапуск подбора — ЧАСТИЧНО) |
| 5 | Дедуп акций и «только новые» | ПОДТВЕРЖДЕНО |
| 6 | Прогоны pytest / verify-data / ux-check | ПОДТВЕРЖДЕНО (ux-check — результат Lead'а) |
| 7 | Известные несоответствия из handoff (3 шт.) | Все три ПОДТВЕРЖДЕНЫ |
| 8 | Плавающий FAIL `verify-data.mjs` (доп. пункт) | ПОДТВЕРЖДЕНО: свойство замера, severity low |

---

## 1. Расписание: четверг 11:00

**Вердикт: ПОДТВЕРЖДЕНО** (по конфигам, документации и XML задачи). Регистрация задачи в Планировщике Windows **не проверена** — см. «Что не удалось проверить».

| Что | Команда | Наблюдаемый результат |
|---|---|---|
| Тонкие настройки | `read registry\agent-settings\agent-1-competitor-watch.yaml` | `days: [4]`, `time: "11:00"`, `frequency: weekly`, `timezone: Europe/Moscow`, `enabled: true` |
| Реестр агентов | `read registry\agents.yaml` | `agent-1-competitor-watch … schedule: "weekly:thursday:11:00"` |
| Каталог услуг | `read registry\services.yaml` | услуга `competitor-watch`, `schedule: "weekly:thursday:11:00"` |
| Runbook | `grep -n "четверг\|11:00" 00-admin\runbook.md` | строки 4, 58, 62, 207–208: «каждый четверг в 11:00 (Москва)», «день 4 — четверг» |
| Клиентские конфиги | `grep client-svet.yaml / client-granel.yaml` | оба: `weekday: thursday`, `time: "11:00"` |
| Задача Windows | `schtasks /Query /TN Agent1-Weekly /V /FO LIST` | **заблокировано песочницей**: `ERROR: The system cannot find the path specified.` (падает и на `/Query /FO CSV` без фильтра, т.е. это запрет, а не отсутствие задачи) |
| XML задачи (косвенно) | `[xml](Get-Content install\agent1-weekly-task.xml -Raw)` | `URI=\Agent1-Weekly`, `ScheduleByWeek → <Thursday/>`, `WeeksInterval=1`, `StartBoundary=2026-11-05T11:00:00`, действие `…\install\agent1-weekly.cmd`, `WorkingDirectory=…\тестDH` |
| Календарь | `[datetime]::ParseExact(...)` | `2026-11-05 → Thursday` (сегодня 2026-11-03 — вторник), т.е. «Next Run 05.11.2026 11:00» из handoff согласуется с XML |
| Лог недельного прогона | `Test-Path logs\agent1-weekly.log` | каталога `logs\` нет → задача ещё ни разу не запускалась (ожидаемо: Next Run в будущем) |

**Мелкий дефект (info).** `install\agent1-weekly.cmd:4` ссылается на `install/agent1-weekly-task.ps1`, которого в `install\` нет (есть только `agent1-weekly-task.xml`). Ссылка только в комментарии, на работу не влияет.

**Мелкий дефект (info).** `registry\agents.yaml:21` и `registry\services.yaml:17` содержат устаревшее «52 теста» (фактически 268).

---

## 2. Список конкурентов по client-svet

**Вердикт: НЕ ПОДТВЕРЖДЕНО.** Заявленные 6 ЖК и профили совпадают лишь на 3 позиции из 6.

Заявлено в `01-competitor-watch\config\clients\client-svet.yaml` (6): Дмитровское небо, Селигер Сити, Онежский вал, Кинетик. Резиденции на Дмитровском, Акценты, Михалковский.

Фактически профили в `01-competitor-watch\data\clients\client-svet\competitor-profiles\` (`glob **/*.json`):

| ЖК | В клиентском конфиге | Профиль на диске |
|---|---|---|
| Дмитровское небо | да | да (`zhk-dmitrovskoe-nebo.json`) |
| Селигер Сити | да | да (`zhk-seliger-siti.json`) |
| Михалковский | да | да (`zhk-mihalkovskiy.json`) |
| Онежский вал | да | **нет** |
| Кинетик. Резиденции на Дмитровском | да | **нет** |
| Акценты | да | **нет** |
| Нарвин | **нет** | да (`zhk-narvin.json`, класс «комфорт», ПИК) |
| СОУЛ | **нет** | да (`zhk-soul.json`, «бизнес», FORMA (ПИК)) |
| Бусиновский парк | **нет** | да (`zhk-businovskiy-park.json`, «комфорт», ПИК) |

**Причина расхождения (установлена).** Профили — это результат автоподбора, а не список клиента: `01-competitor-watch\data\candidates\my-zhk-svet.json` содержит ровно те же 6 кандидатов (Дмитровское небо 1.16 км, Селигер Сити 1.88, Михалковский 3.43, Нарвин 4.28, СОУЛ 5.01, Бусиновский парк 5.15), а `_summary.json` перечисляет те же 6 файлов (`lots_total: 170`, медиана 514 844 ₽/м²). Два источника правды (ручной список в клиентском конфиге и автоподбор) не сверены между собой.

**Дефект D1, severity medium.** Панель/отчёт работают по профилям автоподбора, а клиентский конфиг обещает другой состав (в т.ч. 3 ЖК без профилей вообще). Это же — открытый вопрос к пользователю из handoff («подтвердить список конкурентов»). Без решения состава приёмка предметной части неполна.

Побочно: `validate_config.py` (`00-admin\scripts\validate_config.py`) даёт `[OK] client-svet.yaml (источников 5, конкурентов 6)` — валидатор считает только количество записей и не сверяет состав с профилями, поэтому расхождение он не ловит.

---

## 3. Почта: каналы, получатели, SMTP, .eml, честный статус

**Вердикт: ЧАСТИЧНО.** Конфигурация и механизм подтверждены, но **ни один живой артефакт почты не существует**, и статус в `registry\runs.jsonl` отсутствует.

**3.1 Конфигурация — ПОДТВЕРЖДЕНО**

- `registry\agent-settings\agent-1-competitor-watch.yaml:36-38`: `channels: [telegram, email]`, `addresses: ["@svet_marketing", "tyurina@d-a.ru", "vodnev@d-a.ru"]`, `auto_send: true`.
- `01-competitor-watch\config\clients\client-svet.yaml:34-37` и `client-granel.yaml:28-31` — те же три адреса.
- `00-admin\config\settings.yaml:89-100`: `delivery.email.enabled: false`, `smtp_host: ""`, `smtp_user: ""`, `from: ""` — кредов нет (как и заявлено).

**3.2 Живые артефакты — НЕ ПОДТВЕРЖДЕНО**

| Проверка | Команда | Результат |
|---|---|---|
| Каталоги `.cache` по клиентам | `Test-Path reports\clients\client-svet\.cache` | `False` (и для `client-granel` тоже) |
| `analytics-*.json` | `Get-ChildItem reports\clients -Recurse -Force -File` | есть только md/xlsx/docx/pdf от 01–02.11; **ни одного** `.cache\analytics-*.json` |
| `email-*.json` и `.eml` | тот же обход + `glob **/*.eml` | **нет ни одного** |
| Статус отправки в журнале | `Select-String registry\runs.jsonl -Pattern "email|delivery|smtp|.eml"` | **0 совпадений**; 14 записей, полей `sent_status`/`sent_channel` нет |

**Причина (установлена):** код WP2 моложе последнего прогона. `analytics.py` — 03.11 22:01, `delivery_email.py` — 03.11 21:55, `client_report.py` — 03.11 22:00; последние клиентские отчёты и записи журнала — 02.11 19:57 (`runs.jsonl`, `2026-11-02-competitor-watch.*`). То есть **новый код ни разу не исполнялся в реальном прогоне**, подтверждены только юнит-тесты.

**Дефект D2, severity medium.** Заявленные WP2 артефакты (`.cache\analytics-<date>.json`, `.cache\email-<date>.json`, `.eml`, статус в `runs.jsonl`) не подтверждены ни одним прогоном. Нужен прогон `collect_clients.py` (например, `install\agent1-weekly.cmd` вручную) уже на финальном коде.

**3.3 Механизм «без кредов → .eml + честный статус» — ПОДТВЕРЖДЕНО независимым прогоном**

Проба в `%TEMP%` (не в проекте): `delivery_email.deliver_report(...)` с транспортом из `settings.yaml` (пустым) и реальным вложением xlsx:

```
transport smtp_host='' user='' sender=''
records: [{"to": "tyurina@d-a.ru", "status": "eml_saved", "file": "...\\2026-11-03-competitor-watch.eml",
           "reason": "не отправлено: нет SMTP-доступа: в settings.yaml -> delivery.email не задан smtp_host"}, {... vodnev ...}]
journal_status: не отправлено: нет SMTP-доступа: в settings.yaml -> delivery.email не задан smtp_host
eml exists: True
email-json keys: ['date', 'generated_at', 'records'] ; records=2
recipients_from: ['tyurina@d-a.ru', 'vodnev@d-a.ru', 'extra@d-a.ru']   # telegram-адрес отфильтрован
```

Т.е. `.eml` формируется, `.cache\email-<date>.json` пишется, статус честный, исключение не бросается. Плюс `pytest` — `test_50_no_smtp_saves_eml_and_records_honest_status` и 5 соседних тестов почты PASSED.

**Дефект D3, severity medium (подтверждён).** `delivery.channels` / `delivery.auto_send` **не читаются движком вообще**: `grep "channels|auto_send"` по `01-competitor-watch\**` → 0 совпадений. `client_report.py:234` имеет `send_email=True` по умолчанию, а `collect_clients.py` этот аргумент не передаёт → почта формируется/шлётся независимо от того, включён ли канал `email` в настройках агента. Политика гейта не реализована.

**Дефект D4, severity low.** При нескольких получателях `.eml` один на всех: `delivery_email.py:194-198` создаёт файл только для первого адреса и переиспользует путь; в записях второго адреса указан тот же файл. Фактически в файле `To: tyurina@d-a.ru` и нет упоминания `vodnev@d-a.ru`. Вложения и тело корректны, но «сохранённое письмо» не соответствует второму получателю.

**Замечание (info).** `_write_journal` пишет только `{date, generated_at, records}`; отдельного «email-статуса в `runs.jsonl`» в живом журнале нет — поле появляется лишь при прогоне через `collect_clients.py:516` (`sent_status`).

---

## 4. Реальное влияние тумблеров `agent1.analytics.*`, `watch.query`, индикатор, раздел «Аналитика»

**Вердикт: ПОДТВЕРЖДЕНО** (8/8 тумблеров влияют; автозапуск подбора — ЧАСТИЧНО).

### 4.1 Матрица тумблеров — доказана прогоном, а не чтением кода

Прогон №1 (Python API, фикстуры `tests\fixtures\week-2026-10-23|30`, синтетическая история 4 точки для прогноза; базовый прогон: `lots_on_sale=3`, `by_source=1`, `dynamics=3`, `promos_new=2`, `forecast=series:3`):

| Тумблер = false | Изменилось против базы | Значение |
|---|---|---|
| `lots_all_on_sale` | `by_competitor`, `data_status` | `lots_on_sale` → `null` (было 3), причина в `data_status` |
| `price_dynamics` | `dynamics`, `data_status` | `dynamics` 3 → 0 + причина |
| `promos` | `promos_new`, `data_status` | `promos_new` 2 → 0 + причина |
| `developers_sites` | `by_source`, `data_status` | `by_source` 1 → 0 + причина |
| `forecast` | `forecast`, `data_status` | `forecast` `series:3` → `null` + причина |
| `enabled` | — (см. ниже) | `analytics_enabled()` = false → JSON не пишется |

Прогон №2 (синтетика с общей акцией в обоих снимках):

```
new_promos_only=True  -> promos_new=['Скидка'] known=1
new_promos_only=False -> promos_new=['Акция', 'Скидка'] known=0
```

Прогон №3 (`dedup_promos`, раздел 5 отчёта — `bwr.configure_promos` + `build_markdown`):

```
dedup_promos=True  -> section5 строк 'Акция'=1, табличных строк=3
dedup_promos=False -> section5 строк 'Акция'=2, табличных строк=4
```

Прогон №4 (CLI `build_weekly_report.py --agent-settings fixtures\agent-settings-analytics-off.yaml`, вывод в `%TEMP%`):

```
Аналитика выключена (agent1.analytics.enabled = false).
Разделов в Markdown: 9
analytics-*.json present: False
MD has 'Аналитика отключена': True        (аналитический блок остаётся, но честно помечен)
```

Базовый CLI-прогон без `--agent-settings` пишет `.cache\analytics-2026-10-30.json` с контрактными ключами:
`schema_version, date, generated_at, client_id, toggles, by_competitor, by_source, dynamics, promos_new, promos_known_count, forecast, email, data_status` — совпадает с контрактом handoff.

**Важная оговорка по `dedup_promos` (не дефект, но уточнение к ТЗ).** Этот тумблер **не меняет JSON аналитики** (в матрице `changed=[]`), он влияет только на раздел 5 Markdown/XLSX отчёта (`build_weekly_report.py:90-113`). Проверять его по `.cache\analytics-<date>.json` из формулировки task-2 нельзя — доказательство только через отчёт.

**Уточнение к пробелам WP2.** Мои прогоны закрывают отсутствие тестов: в `tests\test_analytics.py` не было тестов на эффект `price_dynamics=false`, `developers_sites=false`, `forecast=false` (был только `resolve_toggles`) — теперь влияние этих трёх доказано прогоном. Рекомендуется закрепить это регресс-тестами (severity low).

### 4.2 Одно поле `agent1.watch.query` — ПОДТВЕРЖДЕНО

- YAML: `agent1.watch.query: "https://svetdom.ru/"` — одно поле; остальные параметры ЖК на месте (`radius_km: 10`, `sources` 3 шт., `max_candidates: 20`).
- `public\app-views15.js:43-57`: в схеме карточки остаётся ровно одно видимое поле `query`; остальные помечаются `hidden`, но не удаляются (комментарий «прячем, но НЕ удаляем»).
- `verify-data.mjs`: `OK одно поле ввода agent1.watch.query заполнено (https://svetdom.ru/)`; `OK параметры по умолчанию ЖК не удалены из YAML (только скрыты) (радиус 10 км, источников 3, кандидатов 20)`.

### 4.3 Автозапуск подбора — ЧАСТИЧНО

- UI-триггер реализован и подтверждён кодом: `public\app-views15.js:154-183` перехватывает `POST /api/agent-settings/set` для `agent1.watch.query` и при `schedule.enabled && !stop_switch` вызывает `runAgent1Discover()` → `POST /api/agent1/discover` (`app-views15.js:138-152`).
- **Но движок подбора за этим вызовом — честная заглушка:** `serve.mjs:865-885` не ищет конкурентов, а перечисляет уже лежащие файлы `01-competitor-watch\data\candidates\*.json`; при их отсутствии отдаёт `501 {stub:true}`. Для `projects[0].id = my-zhk-svet` (`dashboard\public\data\projects.json`) файл есть, т.е. панель вернёт «Найдены ранее сохранённые кандидаты: файлов 1.» — это те же 6 кандидатов/профилей из п. 2.
- Ограничение приёмки: сам HTTP-вызов я не воспроизводил — запуск `serve.mjs` в моём прогоне пересобирал бы `dashboard\public\data\**`, что вне разрешённой зоны записи. Заявленный panel-dev офлайн-прогон `test-toggle-e2e.mjs` (OK 31/0) не перепрогонялся по той же причине (тест пишет в `dashboard\_ux-harness\tmp`).

**Итог по пункту:** поле и триггер есть, честная заглушка вместо поиска — известное состояние (задача T57 у data-engine), а не скрытый дефект.

### 4.4 Индикатор «работа сделана / не сделана» — ПОДТВЕРЖДЕНО

- Живые данные: `dashboard\public\data\agent1-status.json` → `state=done`, `done=true`, `verdict="Работа сделана"`, `reason="Последний прогон 2026-11-02 19:57:04 — результат ok, артефакт 2026-11-02-competitor-watch.pdf."`, `sourceOfTruth=registry/runs.jsonl`, 14 прогонов (14 ok / 0 failed), 7 снимков.
- `verify-data.mjs`: 8 шагов по статусу — все `OK`, включая сверку числа прогонов и последнего статуса с `registry\runs.jsonl` и соответствие вердикта последнему прогону.
- Негативные ветви проверены мной на синтетической копии коллектора в `%TEMP%` (копии `paths.mjs`, `agent1-status.mjs`, `yaml.mjs` + свой `registry\runs.jsonl`; оригинальный реестр не тронут):

```
A: последний прогон failed -> state=failed done=false verdict=Работа не сделана
   reason=Последний прогон 2026-11-03 10:00:00 — результат failed: SMTP недоступен.
B: журнал пуст, снимков нет -> state=never verdict=Ещё не запускался
   reason=В registry/runs.jsonl нет ни одной записи по Агенту 1 — прогон не журналировался.
```

**Замечание (D9, info).** Зелёный индикатор «Работа сделана» опирается на прогон 02.11 19:57, который не включал ни аналитику, ни почту (тот же корень, что D2). Формально вердикт честен по своему источнику (`runs.jsonl`), но не означает, что финальный код WP2 отработал.

### 4.5 Раздел «Аналитика» из JSON движка — ПОДТВЕРЖДЕНО

- Живые данные: `dashboard\public\data\competitor-analytics.json` → `totals.clientsWithData=0`, `lotsOnSale=null`, `emptyReason` верхнего уровня честная; у обоих клиентов `exists=false` и новая формулировка «Файлы аналитики движка не найдены: в .cache клиента «client-granel» нет ни одного analytics-<ГГГГ-ММ-ДД>.json …» — старого лживого текста «Файл аналитики найден, но не разобрался» больше нет.
- `verify-data.mjs`: `OK пустое состояние по каждому клиенту честное (нет файла — не «файл найден») (проверено клиентов без данных: 2)`.
- Модульная проба (env `DASHBOARD_CW_CLIENTS_REPORTS_DIR` → `%TEMP%`, три синтетических клиента, ничего в проект не пишется):

```
client-broken  | exists=false | «Файл аналитики analytics-2026-11-03.json найден, но не разобрался как JSON …»
client-nofiles | exists=false | «Файлы аналитики движка не найдены: в .cache клиента «client-nofiles» нет ни одного …»
client-ok      | exists=true  | lotsOnSale=5 | emptyReason=null          (валидный JSON подхватывается)
totals: clients=3 withData=1 lots=5
warnings=["analytics analytics-2026-11-03.json: файл не разобрался как JSON"]   (ровно один на файл, дубля нет)
```

- Рендер и контракт тумблеров: независимо перепрогнаны `test-contract.mjs` → `OK 10, ПРОВАЛ 0` и `test-render.mjs` → `OK 23, ПРОВАЛ 0` (оба только читают `dashboard\public`).

**Потенциальный дефект D10, severity low (не проявляется).** `competitor-analytics.mjs` разбирает файл движка «сырым» `JSON.parse`: файл с BOM был бы объявлен «битым» (в моей пробе BOM дал именно этот эффект). Движок пишет без BOM (`cwlib.json_dump` → `encoding="utf-8"`), поэтому на практике не срабатывает. Стоит либо снимать BOM, либо явно задокументировать требование.

---

## 5. Дедуп акций и режим «только новые»

**Вердикт: ПОДТВЕРЖДЕНО.**

- Идентичность дедупа — `(project, promo_text, status)` с нормализацией текста (`analytics.py:93-114`). Прямая проба: 3 строки с текстом «Акция»/«  Акция  » и статусами `active/active/reserved` → `unique=2, folded=1, lots=[2, 1], statuses=['active','reserved']` — схлопываются только совпадающие по всем трём полям, разные статусы остаются раздельными.
- Режим «только новые»: `analytics.py:344-365` — при `new_promos_only=true` показываются `curr − prev` и считается `promos_known_count`; при `false` — все текущие акции и счётчик 0 (см. п. 4.1, прогон №2).
- Тесты (`tests\test_analytics.py`): `test_01`, `test_02`, `test_03` (дедуп и счётчик лотов в разделе 5), `test_24`, `test_28` — PASSED в общем прогоне.

**Уточнение.** `dedup_promos` (тумблер) применяется к разделу 5 отчёта (`build_weekly_report.py:90-113`), а не к `analytics.py` JSON — это соответствует замыслу, но не формулировке task-2 (см. п. 4.1).

---

## 6. Прогоны

| Прогон | Команда | Результат |
|---|---|---|
| pytest (весь набор Агента 1) | `.venv\Scripts\python.exe -m pytest 01-competitor-watch\tests -q` | **268 passed in 28.71s** (совпадает с заявкой WP2) |
| pytest (аналитика, подробно) | `… -m pytest 01-competitor-watch\tests\test_analytics.py -v` | **30 passed** (дедуп, тумблеры, контракт JSON, прогноз, почта) |
| Приёмка данных | `node dashboard\verify-data.mjs` | **exit 0**, «Всё сошлось. Предупреждений сборщика: 1.»; аналитические шаги, статус, тумблеры, `watch.query`, честные пустые состояния — OK |
| Контракт тумблеров | `node dashboard\_ux-harness\test-contract.mjs` | OK 10 / ПРОВАЛ 0, exit 0 |
| Рендер панели | `node dashboard\_ux-harness\test-render.mjs` | OK 23 / ПРОВАЛ 0, exit 0 |
| Подхват аналитики | `node dashboard\_ux-harness\test-analytics-pickup.mjs` | **не перепрогонял** (пишет в `dashboard\_ux-harness\tmp` — вне зоны); заявка panel-dev: OK 24 / 0; логика проверена модульной пробой (п. 4.5) |
| e2e тумблер+query | `node dashboard\_ux-harness\test-toggle-e2e.mjs` | **не перепрогонял** по той же причине; заявка panel-dev: OK 31 / 0 |
| **ux-check (замороженный, живая панель)** | `node dashboard\ux-check.mjs --url http://127.0.0.1:8787 --cdp http://127.0.0.1:9222` — **выполнил Lead 03.11.2026** | **OK 21, ПРОВАЛ 0, ПРОПУСК 0, exit 0**; интерфейс `v-u33m1p` (2026-11-03T18:59:58.159Z); отчёт `dashboard\ux-report.json`. Два ранее падавших действия теперь проходят вживую: «Собрать данные сейчас» → «✓ Данные пересобраны — за 3.0 с. сессий: 62 · задач: 83 · расход: 3 916,64 ₽»; «Сформировать отчёт за неделю» → «✓ Отчёт построен за 2026-10-30 (сравнение с 2026-10-23) — за 0.5 с» (источник — сообщение Lead'а, сам не дублировал) |

**Диагноз `spawnSync … EPERM` подтверждён независимо (мой прогон в песочнице, `%TEMP%`):**

```
pipe: code=EPERM status=null msg=spawnSync C:\…\node.exe EPERM
file-stdio: ok
file content: hi-file
```

Это ровно то, что описывает `serve.mjs:231-285`: запрет piped stdio даёт EPERM на запуске (`status=null`), а вывод в файл работает. Различие «EPERM на запуске» vs «процесс упал» реализовано корректно (`spawnDenied`, повтор только при EPERM/EACCES и отсутствии `status`; при реальном ненулевом коде процесс не перезапускается).

---

## 7. Известные несоответствия из handoff

| Несоответствие | Вердикт | Доказательство |
|---|---|---|
| `report.sections` = 5, а фактических разделов 9 | **ПОДТВЕРЖДЕНО** | `registry\agent-settings\agent-1-competitor-watch.yaml:31` → `sections: [summary, prices, changes, promos, limits]` (5); `00-admin\config\settings.yaml:111-129` → `report_sections` из 9 пунктов; CLI-прогон печатает «Разделов в Markdown: 9»; `grep` по `01-competitor-watch\scripts` → поле `report.sections` из agent-settings не читается вообще (клиентский `report` читает только `clients.py:87,163`). Т.е. это мёртвое, вводящее в заблуждение поле (D5, low). |
| Движок шлёт почту независимо от `delivery.channels` | **ПОДТВЕРЖДЕНО** | `grep "channels\|auto_send"` по `01-competitor-watch\**` → 0 совпадений; `client_report.py:234` `send_email=True` по умолчанию, `collect_clients.py` его не передаёт (D3, medium). |
| `verify-data.mjs`: 1 предупреждение сборщика | **ПОДТВЕРЖДЕНО, но это не тот FAIL, что в handoff** | В `meta.json` ровно 1 warning: «prices: для 10 моделей не опубликована цена чтения из кэша … это ОЦЕНКА СВЕРХУ» — к Агенту 1/WP1–WP3 отношения не имеет. Отдельно от него живёт **плавающий FAIL** по проекции сессий (см. п. 8): в handoff он 5.83 %, сейчас прогон зелёный (2.39 %). |

---

## 8. Дополнительно: плавающий FAIL `verify-data.mjs` (по запросу Lead)

**Вердикт: ПОДТВЕРЖДЕНО — это нестабильность методики замера, а не порча данных. Severity: low.**

**Как считается.** `verify-data.mjs:522-537` берёт максимум `s.projcacheDelta` по сессиям (порог 5 %). `collector\lib\sessions.mjs:291-297`: `delta = |logTokens − projcacheTokens| / max(...)`, где `logTokens` — разбор живого zstd-лога сессии (`session.v4.jsonl.zstd`), а `projcacheTokens` — кэш проекции DSH из `~/.dsh/storages/session_projcache/sessions/<id>.json` (`paths.mjs:35-37`).

**Наблюдения (серия замеров с паузами, `dashboard\public\data\sessions.json`):**

| Момент сбора | `worst` | Кто «худший» | verify-data |
|---|---|---|---|
| 22:23:22 | 3.74 % | `66e28f95` (panel-dev) | OK 3.74 % |
| 22:24:33 | 0.00 % | — | OK 0.00 % |
| 22:24:52 | 2.53 % | `66e28f95` (panel-dev) | OK 2.53 % |
| сейчас | 2.39 % | — | OK 2.39 % |

Ряд от Lead'а и handoff (5.83 % / 0.00 % / 5.88 % / 5.32 % / 4.42 %) — та же колеблющаяся величина.

**Причина — «сессия в середине хода» на момент сбора (латч проекции).** Сопоставление mtime лога и projcache:

- закрытая `b5ebf23a`: LOG 20:20:55 = PROJ 20:20:55 → delta **0**;
- `session-a6c093a5` (Lead, «Agent 1 handoff document»): LOG 22:22:44 / PROJ 22:22:47 — на сборе 22:22:45 delta 5.32 %, после дописывания проекции → **0** (log = proj = 4 116 948);
- `66e28f95` (panel-dev): LOG 22:23:55 / PROJ 22:24:00 — на сборе 22:23:22 лог впереди → 3.74 %, позже 2.53 %.

Непустой delta появляется только у сессии, чей лог дописан после последней записи projcache, т.е. у той, что находится в середине хода во время сбора (61–62 из 62 сессий имеют delta ровно 0).

**Уточнение гипотезы Lead'а.** Привязки к идентификатору **текущей** сессии нет: в трёх замерах «худшей» была сессия panel-dev, а моя собственная имела delta 0. «Худшая» — самая свежая mid-turn сессия любого агента. Усилитель: `serve.mjs` перезапускает сборщик best-effort на многих API-вызовах (`serve.mjs:733-741, 764, 817, 860, 956…`), поэтому `sessions.json` переписывается каждые ~30–70 с, и замер каждый раз берётся в новой фазе хода. Сводная проверка «сумма по логам == проекция» при этом стабильна: 0.007–0.015 % (порог 1 %) — данных не теряется.

**Рекомендация.** В `verify-data.mjs:522-537` исключать из `worst` сессии, «открытые на момент сбора» (mtime лога > mtime projcache, либо последнее событие моложе N секунд), и фиксировать в `meta.json` число пропущенных; альтернатива — поднять порог до ~10 % с явным комментарием, что метрика измеряет лаг проекции, а не целостность. Сводную проверку суммы оставить как есть.

---

## 9. Дефекты

| ID | Severity | Дефект | Где | Доказательство |
|---|---|---|---|---|
| D1 | medium | **ЧАСТИЧНО ЗАКРЫТО 03.11.2026 22:54**: клиентский конфиг приведён к официальному списку — 19 ЖК в порядке таблицы (developer/site совпадают), «Михалковский» сохранён как ориентир вне списка (§9C.1–9C.3). Ранее: 3 из 6 заявленных без профилей, 3 профиля вне списка. Остаётся: `competitor-profiles\*` **не пересобраны** (6 файлов от 01.11), поэтому связность «профили ↔ аналитика» остаётся пустой (F4: 0 сравнённых проектов, 170 против 383 лота) | `01-competitor-watch\config\clients\client-svet.yaml` ↔ `data\clients\client-svet\competitor-profiles\*` | п. 2, §9C |
| D2 | medium | **ЗАКРЫТО 03.11.2026 22:34** реальным прогоном `collect_clients.py`: все артефакты WP2 (`.cache\analytics-*.json`, `.cache\email-*.json`, `.eml`, `md`, снимок, 2 записи в `runs.jsonl`) существуют и подтверждены (§9A). Ранее: не подтверждались ни одним прогоном | `01-competitor-watch\reports\clients\**`, `registry\runs.jsonl` | п. 3.2, §9A |
| D3 | medium | Почта отправляется независимо от `delivery.channels` / `auto_send` (гейт не реализован) | `01-competitor-watch\scripts\client_report.py:234,311` | п. 3.3, п. 7 |
| D4 | low | **ПОДТВЕРЖДЕНО НА ЖИВЫХ ДАННЫХ, остаётся открытым**: один `.eml` на всех получателей — в файле только первый адрес в `To`, записи остальных ссылаются на тот же файл | `scripts\delivery_email.py:194-198` | п. 3.3, §9A |
| D5 | low | `report.sections` = 5 против 9 фактических; поле не читается движком (мёртвое) | `registry\agent-settings\agent-1-competitor-watch.yaml:31` | п. 7 |
| D6 | low | Плавающий FAIL `verify-data.mjs` (латч проекции mid-turn сессии) | `dashboard\verify-data.mjs:522-537`, `collector\lib\sessions.mjs:291-297` | п. 8 |
| D7 | low | Нет регресс-тестов на эффект `price_dynamics=false`, `developers_sites=false`, `forecast=false` | `tests\test_analytics.py` | п. 4.1 |
| D8 | low | `JSON.parse` файла аналитики не снимает BOM (движок пишет без BOM → не проявляется) | `collector\lib\competitor-analytics.mjs:122` | п. 4.5 |
| D9 | info | **ЗАКРЫТО 03.11.2026 22:34**: индикатор «Работа сделана» теперь опирается на прогон, включающий аналитику и почту (ранее — на прогон без них) | `registry\runs.jsonl` | п. 4.4, §9A |
| D10 | info | Устаревшее «52 теста» в реестре | `registry\agents.yaml:21`, `registry\services.yaml:17` | п. 1 |
| D11 | info | `install\agent1-weekly.cmd` ссылается на несуществующий `install\agent1-weekly-task.ps1` | `install\agent1-weekly.cmd:4` | п. 1 |
| F1 | medium | **ЗАКРЫТО 03.11.2026 22:41–22:45**: в venv поставлены `openpyxl 3.1.5` и `python-docx 1.2.0` (+`lxml 6.1.3`, `et-xmlfile 2.0.0`); xlsx/docx/pdf собираются и валидны, `.eml` с вложениями xlsx+pdf; `pytest` — 268 passed. Ранее: только `md`, `.eml` без вложений | `connectors\ru-marketplace-mcp\.venv` (pyvenv.cfg: `include-system-site-packages=false`), `install\agent1-weekly.cmd` | §9A.6, §9B |
| F2 | low | `collect_clients.py:489` падает `ValueError` при `--reports-dir`/`--data-dir` вне `PROJECT_ROOT` (`Path.relative_to`) — артефакты уже созданы, exit 1 | `01-competitor-watch\scripts\collect_clients.py:489` | §9A.6 |
| F3 | info | «Статус отправки» фактически в `registry\results.yaml` (`sent_status/sent_to/sent_at`), в `runs.jsonl` этих полей нет; панель читает из `results.yaml` — контракт панели соблюдён | `registry\results.yaml`, `collect_clients.py:499-517` | §9A.5 |
| F4 | medium | Связность «профили ↔ аналитика» в панели ложно зелёная: `crossCheck.ok=true` при `comparedProjects=0` и расхождении итогов 170 против 404 лотов. Причина — разные ключи проектов (профили «ЖК Селигер Сити», движок «Селигер Сити») → пересечение пусто, «сходятся по 0 проект(ам)»; `verify-data` принимает это как OK и тоже не ловит | `dashboard\collector\lib\competitor-analytics.mjs:330-343`, `dashboard\verify-data.mjs:508` | §9A.5 |
| F5 | low | `runs.jsonl` помечает прогон `status=ok`, хотя обещанные форматы (xlsx/docx/pdf) не собраны; причина честно лежит в поле `error` | `collect_clients.py:483` | §9A.4 |
| F6 | info | `registry\results.yaml` копит дубли id при повторных прогонах в один день: за 2026-11-03 шесть записей (по три `res-2026-11-03-svet`/`-granel`). Панель берёт последнюю, видимой поломки нет, но один id соответствует нескольким записям | `registry\results.yaml`, `collect_clients.py:499-517` | §9B.6 |
| F7 | low | **ЗАКРЫТО 03.11.2026 22:56** пересборкой сборщика: `verify-data.mjs` → `OK число прогонов совпадает … (22 / 22)`, FAIL нет. Было: данные панели не пересобраны после прогонов F1/cmd → FAIL «(20 / 16)», `agent1-status.json` от 22:34:58 показывал 16 прогонов и артефакт `md` | `dashboard\public\data\agent1-status.json`, `registry\runs.jsonl` | §9B.7 |
| F8 | medium | «Михалковский»: **25 из 32 лотов с одинаковой ценой 70 000 000 ₽** при площадях 27–37 м² → ppm2 1,9–2,6 млн ₽/м² (в снимке 11-02 таких лотов 0). Следствие — в отчёте клиенту медиана 1 523 397 ₽/м² и главный вывод «+77,32 %», что является артефактом парсинга, а не движением рынка | `data\clients\client-svet\snapshots\2026-11-03\lots.csv`, отчёт §3/«Главное за неделю» | §9C.8 |
| F9 | medium | `lot_id` источника cian нестабилен между прогонами: пересечение `lot_key` 11-02↔11-03 всего **15 из 175** → отчёт печатает «Новые лоты 139 / Ушедшие 160» и рекомендацию «Ушли 160 лотов — проверьте перераспределение спроса»; при этом `settings.yaml` требует стабильный `lot_id` («хэш ссылки»), а поле `url` в снимке пустое. Ограничение честно раскрыто в §9 отчёта | `01-competitor-watch\scripts\cian_connector.py`, снимки 11-02/11-03 | §9C.8 |
| F10 | low | Лоты с сайтов застройщиков дают неправдоподобно низкий ppm2 и пустой `url`: Level Южнопортовая 34 700 ₽/м², Level Селигерская 74 928 ₽/м² (остальной рынок 170–670 тыс.); вероятно, парсер взял не цену квартиры | `data\clients\client-svet\snapshots\2026-11-03\lots.csv`, `developer_site.py` | §9C.8 |
| F11 | info | Отчёт не называет охват явно: в §9 нет «20 заявлено, 8 с данными, 12 без данных» и причин по каждому; видны только 8 проектов с данными | отчёт `2026-11-03-competitor-watch.md` §9 | §9C.8 |

Замаскированных дефектов не найдено: панель честно показывает пустые состояния и «нет подтверждения отправки», `verify-data` ловит регресс лживого `emptyReason`, тесты не ослаблены.

---

## 9A. Обновление после реального прогона (D2)

**Дата проверки:** 03.11.2026, ~22:40–22:50. **Исполнитель прогона:** engine-dev (task-3), отчёт — `docs/wp2-real-run-2026-11-03.md`. **Метод:** первоисточники — файлы артефактов, `registry\runs.jsonl`, `registry\results.yaml`, `dashboard\public\data\*.json`, повторные прогоны `verify-data.mjs` и движка на копиях настроек. Сам `collect_clients.py` повторно не запускал (ограничение task-4).

**Вердикт по D2: ПОДТВЕРЖДЕНО — дефект закрыт.** Все заявленные артефакты WP2 существуют и подтверждены живым прогоном; остаточные проблемы вынесены в F1/F4/F5.

### 9A.1 Следы прогона

| Что | Наблюдаемый результат |
|---|---|
| `registry\runs.jsonl` | **16** записей (было 14). Новые: `run-a438bb98` (client-granel, `ts=2026-11-03T22:34:29.465+03:00`, 11 774 мс, 0.1404 ₽) и `run-f03c73c9` (client-svet, `22:34:38.689`, 9 217 мс, 0.1277 ₽); `artifact` = `…\2026-11-03-competitor-watch.md` |
| Лог прогона | `logs\d2-real-run-2026-11-03.log`, 7 596 Б, 22:34:38 |
| Артефакты (Б) | `analytics-2026-11-03.json` 9 453 (granel) / 8 252 (svet); `email-2026-11-03.json` 874 / 870; `2026-11-03-competitor-watch.eml` 934 / 886; `2026-11-03-competitor-watch.md` 17 441 / 16 235 |
| Снимки | `data\clients\<id>\snapshots\2026-11-03\lots.csv`: granel 229 строк (229 active), svet 175 (175 active) |

### 9A.2 Пункт 1 task-4: контракт JSON аналитики — ПОДТВЕРЖДЕНО

Оба файла содержат ровно 13 контрактных ключей: `schema_version, date, generated_at, client_id, toggles, by_competitor, by_source, dynamics, promos_new, promos_known_count, forecast, email, data_status`; `schema_version=1`, `date=2026-11-03`, `client_id` совпадает с клиентом. Содержимое реальных данных:

| Клиент | by_source | by_competitor | dynamics | promos_new / known | forecast | email[] |
|---|---|---|---|---|---|---|
| client-svet | cian 167 лот (median 530 386 ₽/м²), yandex_realty 8 (457 768) | 6 | 6 | 1 / 6 | `null` | 2 × `eml_saved` |
| client-granel | cian 221 (500 225), yandex_realty 8 (457 768) | 8 | 8 | 1 / 7 | `null` | 2 × `eml_saved` |

Цифры совпадают с отчётом engine-dev. Заявленный handoff набор полей «`…, promos_new, forecast`» подтверждён полностью.

### 9A.3 Пункт 2 task-4: тумблеры на реальных данных — ПОДТВЕРЖДЕНО

- `toggles` в обоих реальных JSON: все 8 = `true`, ровно как в `registry\agent-settings\agent-1-competitor-watch.yaml` (сверено пофайлово).
- «Минус»-проверка на **реальных** снимках client-svet (11-02 → 11-03) через **копию файла настроек в `%TEMP%`** (реестр не тронут) и через явные `toggles`:

```
РЕАЛЬНЫЙ ФАЙЛ : by_source=[(cian,167),(yandex_realty,8)] by_competitor=6 dynamics=6 promos_new=1 known=6 forecast=null
РЕКОНСТРУКЦИЯ : by_source=[(cian,167),(yandex_realty,8)] by_competitor=6 dynamics=6 promos_new=1 known=6 forecast=null   ← 1:1
developers_sites=false -> by_source=[]            (disabled=['developers_sites'])
promos=false           -> promos_new=0 known=0    (disabled=['promos'])
price_dynamics=false   -> dynamics=0              (disabled=['price_dynamics'])
new_promos_only=false  -> promos_new=7 known=0    (было 1 / 6)
forecast=false         -> forecast=null           (disabled=['forecast'])
копия YAML: resolve_toggles -> developers_sites=False, forecast=False, promos=True
```

Реконструкция на тех же входах воспроизводит реальный файл один в один — значит «минус»-прогоны действительно показывают поведение того же JSON. `forecast` на реальных данных `null` в обоих режимах (см. 9A.7), поэтому его «минус» отличим только по записи `disabled` в `data_status`.

### 9A.4 Пункт 4 task-4: запись в `runs.jsonl` — ПОДТВЕРЖДЕНО с оговоркой (F5)

Записи за дату прогона есть, `artifact` указывает на реально созданный `md`, `status=ok`, `duration_ms`/`cost_rub` заполнены. **Оговорка:** `status=ok` выставлен при неполном комплекте форматов — в поле `error` честно записано `XLSX не собран (нет openpyxl): No module named 'openpyxl'; DOCX не собран: No module named 'docx'` (`collect_clients.py:483` → `"ok" if report["files"] else "error"`, а `files` содержит `md`). Полей `sent_status`/`sent_channel`/`sent_to`/`sent_at` в `runs.jsonl` нет.

### 9A.5 Пункты 3 и 5 task-4: почта, `results.yaml`, панель

- `email-2026-11-03.json` (870/874 Б): по записи на каждый адрес — `tyurina@d-a.ru` и `vodnev@d-a.ru`, `status="eml_saved"`, `sent_at=null`, `reason="не отправлено: нет SMTP-доступа: в settings.yaml -> delivery.email не задан smtp_host"`; тот же статус в `analytics.email[]`. `@svet_marketing` в email-записи не попал.
- `00-admin\config\settings.yaml` → `delivery.email`: `smtp_host: ""`, `smtp_user: ""`, `from: ""` — по-прежнему пусто (проверено повторно).
- **F3 подтверждён:** статус отправки живёт в `registry\results.yaml` — `res-2026-11-03-granel` / `res-2026-11-03-svet`: `sent_channel: email`, `sent_to: "tyurina@d-a.ru, vodnev@d-a.ru"`, `sent_at: null`, `sent_status` = честная строка про отсутствие SMTP. Панель читает именно оттуда (`agent1-status.json` → `sentStatus` совпадает).
- **Панель после прогона (не пустое состояние):** `dashboard\public\data\competitor-analytics.json` → `totals: clients=2, clientsWithData=2, lotsOnSale=404, competitors=14, sources=4, promosNew=2, forecasts=0`; `emptyReason` пуст; по клиентам `exists=true`, `file=analytics-2026-11-03.json`, `lotsOnSale=175/229`; `email.recipients` = `eml_saved` у обоих адресов.
- `verify-data.mjs` (после прогона): раздел аналитики собран — `OK клиентов с данными столько же, сколько заявлено (2 / 2)`, `OK сумма лотов по клиентам == итогу (404 / 404)`, `OK внутренняя связность… (все клиенты сходятся)`, `OK у каждого источника аналитики есть имя (источников: 4)`, `OK получатели почты… (2 / 2)`. Пустых состояний больше нет.
- **НО:** (а) прогон `verify-data.mjs` снова **красный** из-за плавающего FAIL — `FAIL худшее расхождение по сессии (<5%) (8.86%)`, `Проблем: 1` (механика — §8, дефект D6, не связан с прогоном); (б) **новый дефект F4:** `crossCheck.ok=true` при `comparedProjects=0`, при этом `reportLotsTotal=170` против `analyticsLotsTotal=404`, а `verify-data` печатает `OK связность с профилями конкурентов проверена (или объяснено расхождение) (сходятся по 0 проект(ам))`.
- **F4 — разбор:** `competitor-analytics.mjs:330-343` строит пересечение ключей проектов. Профили приходят из `competitor-report.json` с ключами вида `«ЖК Селигер Сити»`, а движок в `by_competitor` отдаёт `«Селигер Сити»` (без префикса) → пересечение пусто, `mismatched=[]` → `ok=true` и текст «сходятся по 0 проект(ам)». Проверка `verify-data.mjs:508` принимает ветку `crossCheck.ok === true`, поэтому регресс-защита тоже молчит. Это маскирует расхождение из D1 (170 лотов в профилях против 404 в аналитике).

### 9A.6 Пункт 6 task-4: F1, F2 и воспроизведение D4

- **F1 подтверждён (medium, среда).** `connectors\ru-marketplace-mcp\.venv\Scripts\python.exe -c "importlib.util.find_spec(...)"` → `openpyxl: False`, `docx: False`; `pip list` не содержит ни `openpyxl`, ни `python-docx`; `pyvenv.cfg` → `include-system-site-packages = false`. Следствие видно на живых файлах: за 2026-11-03 создан только `md`, а `.eml` (886/934 Б) **без вложений** — `multipart/mixed=false`, `attachment=false`, `filename=false` (в приёмочной пробе §3.3 письмо шло с реальным xlsx). Недельный `install\agent1-weekly.cmd` использует именно этот venv → будет отдавать только `md`.
- **F2 подтверждён (low) по коду:** `collect_clients.py:489` — `Path(path).relative_to(cw.PROJECT_ROOT)` (и то же на строке 492 для файла аналитики); вне `PROJECT_ROOT` это `ValueError`, и падение происходит уже после записи артефактов. Воспроизведение не делал: повторный запуск движка запрещён ограничением task-4 (у engine-dev воспроизведено в `%TEMP%`).
- **D4 воспроизведён на живых данных (low):** оба `.eml` содержат `To: tyurina@d-a.ru`, `vodnev@d-a.ru` не упомянут (0 вхождений), при этом запись `vodnev` в `email-2026-11-03.json` ссылается на тот же файл.

### 9A.7 `forecast = null` на реальных данных — корректное поведение, не регресс

`data_status` по каждому проекту даёт честную причину: `forecast:<проект> | no_data | истории мало: 2 точек из 3 нужных — прогноз не строится` (у ЗИЛАРТ — 1 точка). Причина в самих снимках:

| Снимок client-svet | Проекты |
|---|---|
| 2026-11-01 | только `ЗИЛАРТ` (демо-снимок, 15 лотов) |
| 2026-11-02 | 6 реальных ЖК (175 лотов) |
| 2026-11-03 | те же 6 ЖК (175 лотов) |

У реальных проектов ровно 2 точки истории, у ЗИЛАРТ — 1; у client-granel снимков вообще два (11-02, 11-03). Порог `FORECAST_MIN_POINTS = 3` (`analytics.py:47,189`) не достигнут, поэтому `forecast=null` и `forecasts=0` в панели — это работа контракта «≥3 точек», а не дефект. Прогноз станет доступен после третьего недельного снимка.

### 9A.8 Итог обновления

| Что | Было (03.11, вечер) | Стало после прогона |
|---|---|---|
| D2 (артефакты WP2 не подтверждены) | открыт, medium | **ЗАКРЫТ** — подтверждён живым прогоном |
| D4 (один `.eml` на всех) | заявлен по пробе в `%TEMP%` | **подтверждён на живых данных**, остаётся открытым (low) |
| D9 (индикатор опирается на прогон без аналитики/почты) | открыт, info | **ЗАКРЫТ** — индикатор опирается на прогон 03.11 22:34 с аналитикой и почтой |
| Новые дефекты | — | F1 (medium, venv без openpyxl/python-docx), F2 (low), F3 (info), F4 (medium, ложно зелёная связность), F5 (low, `status=ok` при неполных форматах) |
| Что осталось открытым | — | D1 (состав конкурентов), D3 (гейт каналов), D4, D5–D8, F1, F2, F4, F5, D10–D11; плюс D6 (плавающий FAIL `verify-data`, сейчас 8.86 %) |

---

## 9B. Обновление после F1 (форматы отчётов)

**Дата проверки:** 03.11.2026, ~22:47–22:58. **Исполнитель:** engine-dev (task-5), отчёт — `docs/f1-report-formats-2026-11-03.md`. **Метод:** первоисточники. Движок повторно **не запускал**: использованы артефакты уже выполненных прогонов — прямого `collect_clients.py --no-browser --date 2026-11-03` (22:41) и `cmd /c install\agent1-weekly.cmd` (22:42:11–22:45:40), поэтому проверены именно те файлы, что лежат на диске сейчас.

**Вердикт по F1: ПОДТВЕРЖДЕНО — дефект закрыт.** Дополнительно подтверждена и устранена вторая, более тяжёлая проблема: `.cmd` с LF-переводами строк **вообще не запускал движок** (проверено воспроизведением, §9B.8).

### 9B.1 Пакеты в venv и отсутствие поломок — ПОДТВЕРЖДЕНО

```
.venv\Scripts\python.exe -c "import openpyxl, docx, lxml, et_xmlfile, yaml; ..."
python 3.12.14 | openpyxl 3.1.5 | python-docx 1.2.0 | lxml 6.1.3 | et_xmlfile 2.0.0 | PyYAML 6.0.3
DSH-runtime python: openpyxl 3.1.5 | python-docx 1.2.0        ← версии совпадают (установка копированием)
site-packages: openpyxl-3.1.5.dist-info (22:41:07), python_docx-1.2.0.dist-info (22:41:08),
               lxml-6.1.3.dist-info, et_xmlfile-2.0.0.dist-info — PyYAML/pytest не тронуты (01.11 / 21:46)
pytest 01-competitor-watch\tests -q  →  268 passed in 26.70s
```

### 9B.2–9B.5 Форматы за 2026-11-03 — ПОДТВЕРЖДЕНО (валидность, а не размер)

Файлы на диске созданы прогоном `cmd /c` (mtime 22:44:35–22:45:41), т.е. подтверждают сразу и F1, и работоспособность `.cmd`.

| Формат | client-svet | client-granel | Проверка |
|---|---|---|---|
| xlsx | 30 231 Б | 35 468 Б | открыт `openpyxl`: **6 листов** `Сводка, Цены, Изменения, Акции, Лоты, Аналитика`; строк 23/8/1/6/176/52 и 23/10/1/7/230/63 — данные есть |
| docx | 38 752 Б | 38 985 Б | открыт `python-docx`: **9 параграфов** (все непустые) и **3 таблицы**; первый — «ЖК «Свет» — Мониторинг конкурентов» / «СЗ «Гранель» …» |
| pdf | 83 098 Б | 84 928 Б | сигнатура `%PDF-1.7`, завершается `%%EOF`, **7 страниц** (`/Type /Page`) |
| eml | 154 593 Б | 164 189 Б | `email`-парсер: `multipart=True`, 4 части, **2 вложения** — `2026-11-03-competitor-watch.xlsx` (30 231/35 468 Б, OOXML) и `…-competitor-watch.pdf` (83 098/84 928 Б, `application/pdf`); было 886/934 Б без вложений |

Замечание к числам: `eml` granel у engine-dev указан 164 161 Б, у меня 164 189 Б — потому что его измерение относится к файлу прямого прогона 22:41, а текущий файл перезаписан прогоном `cmd /c` в 22:44:37. Функционально разницы нет.

### 9B.6 Почта, `runs.jsonl`, `results.yaml` — ПОДТВЕРЖДЕНО

- `.cache\email-2026-11-03.json`: по записи на адрес, `status=eml_saved`, `sent_at=null`, причина «не отправлено: нет SMTP-доступа: в settings.yaml -> delivery.email не задан smtp_host»; SMTP в `settings.yaml` по-прежнему пуст. `.eml` сохранён, исключения нет.
- `runs.jsonl`: **20** записей. Новые четыре: 22:41:26 granel (13 382 мс), 22:41:37 svet (10 582 мс) — прямой прогон F1; 22:44:36 granel (145 158 мс) и 22:45:40 svet (63 978 мс) — прогон через `.cmd`. У всех четырёх `artifact = …2026-11-03-competitor-watch.pdf`, `error = null` — «XLSX не собран / DOCX не собран» больше нет (было в записях 22:34).
- `registry\results.yaml`: последняя запись `res-2026-11-03-svet` (created 22:45:40) перечисляет **все четыре формата** + `.cache\analytics-2026-11-03.json`; `sent_channel: email`, `sent_to: "tyurina@d-a.ru, vodnev@d-a.ru"`, `sent_at: null`, `sent_status` честный. **Новое (F6, info):** за 2026-11-03 накопилось **6 записей** — по три с одинаковым id на клиента (D2, F1-прямой, cmd). Панель читает последнюю, видимой поломки нет, но один id соответствует нескольким записям.

### 9B.7 Панель: аналитика не сломалась, но данные устарели (F7, low)

- Раздел аналитики по-прежнему собран: `OK клиентов с данными столько же, сколько заявлено (2 / 2)`, `OK сумма лотов по клиентам == итогу (404 / 404)`, `OK источников: 4`, `OK получатели почты (2 / 2, eml_saved)`.
- **Но `verify-data.mjs` теперь даёт 2 FAIL (было 1):** плавающий D6 `FAIL худшее расхождение по сессии (<5%) (8.86%)` **и новый** `FAIL число прогонов совпадает с registry/runs.jsonl (20 / 16)`.
- Причина нового FAIL — устаревший снимок панели, а не F1: `dashboard\public\data\agent1-status.json` собран в **22:34:58** (16 прогонов, артефакт `md`, вердикт «Последний прогон 2026-11-03 22:34:38»), тогда как `registry\runs.jsonl` (mtime 22:45:40) содержит 20 записей с артефактом `pdf`. Сборщик после прогонов F1/cmd не перезапускался. Лечится пересборкой (`node dashboard\collector\collect.mjs` или кнопка «Обновить данные»); сам я её не делал — `dashboard\**` в моей зоне только для чтения.

### 9B.8 Ключевое: `.cmd` не запускал движок из-за LF — ПОДТВЕРЖДЕНО

**Файл сейчас:** `install\agent1-weekly.cmd`, 1 678 Б, **CRLF=29, одиночных LF=0** (было LF-only). Содержимое не изменилось: 29 строк, построчно совпадает с тем, что я читал до правки (в т.ч. строка 4 с упоминанием `install/agent1-weekly-task.ps1` и строка 24 с вызовом `collect_clients.py`) — изменены только переводы строк.

**Воспроизведение причины (в `%TEMP%`, из копии того же содержимого, строка вызова движка заменена на `echo`):**

```
LF-версия   → 'вщиком' is not recognized…; 'т' is not recognized…; 'рает' is not recognized…; 'R' is not recognized…
              строка с движком не выполнилась вообще; exit=0
CRLF-версия → команды выполняются (echo отработал), exit=0
```

Это ровно тот класс ошибки, что зафиксировал engine-dev (`'nt1-weekly-task.ps1.' is not recognized`, exit 0 за 0.1 с): при LF-only `cmd.exe` разбирает файл блоками и теряет границы строк, поэтому **недельный прогон по расписанию не работал вообще**, при этом формально возвращая код 0 — самый опасный вид отказа (тихий).

**Подтверждение, что после правки `.cmd` реально работает (без повторного запуска):** `logs\agent1-weekly.log` (5 829 Б) содержит `[03.11.2026 22:42:11,40] --- старт недельного прогона Агента 1 (python: …\.venv\Scripts\python.exe) ---`, строки `Отчёт (xlsx/docx/pdf)` по обоим клиентам, `client-granel: лотов 229, источников 7, себестоимость ~1.25 ₽, файлов 4`, `client-svet: лотов 175, …, файлов 4` и `[03.11.2026 22:45:40,75] --- конец, код 0 ---`. В `runs.jsonl` появились ровно две соответствующие записи (22:44:36 и 22:45:40). Свой прогон `cmd /c` я не делал.

### 9B.9 Остаточное — оценка честная

| Что | Оценка |
|---|---|
| `.cmd` запускает без `--no-browser` (в файле флага нет) | Подтверждено: прогон через `.cmd` занял 209 с (145 + 64) против ~10 с с `--no-browser`. Функциональной деградации нет: источники те же (`cian ok`, `yandex-realty ok`, `developer-sites no_data HTTP 401`, `avito`/`domclick` skipped), лоты те же 229/175. В проде режим браузера и нужен. Severity: info. |
| «Кракозябры» в `agent1-weekly.log` | **Не подтверждено как дефект файла:** файл — валидный UTF-8 **без BOM** (0 символов замены; первая строка корректно читается как UTF-8). Как cp1251 та же строка даёт «СЃС‚Р°СЂС‚…» — значит «кракозябры» возникают при чтении без указания кодировки (`Get-Content` в PS 5.1 / `type` в консоли cp866), а не из-за порчи данных. Рекомендация: читать с `-Encoding UTF8` либо писать лог с BOM/в кодировке консоли. Severity: info. |
| `.tmp-f1` в корне | **Подтверждено:** `C:\Users\Артем\Desktop\тестDH\.tmp-f1` существует (mtime 22:45:52), в каталоге `marketing-agents` его нет. Из песочницы не удаляется — нужен full access/ACL-repair. Остаточное, на работу не влияет. |
| D11 (`install\agent1-weekly-task.ps1` отсутствует) | **Не тронуто:** `Test-Path` = False. Упоминание только в комментарии `.cmd`, на работу не влияет. Severity: info. |

### 9B.10 Итог обновления

| Что | Было | Стало после F1 |
|---|---|---|
| F1 (нет openpyxl/python-docx → только `md`, `.eml` без вложений) | открыт, medium | **ЗАКРЫТО** — пакеты стоят, xlsx/docx/pdf валидны, `.eml` с вложениями, pytest 268 passed |
| Недельный `.cmd` | не работал (LF-only, тихий exit 0) | **ИСПРАВЛЕНО и подтверждено**: CRLF, лог и `runs.jsonl` показывают реальный прогон, 4 файла на клиента |
| Новые дефекты | — | F6 (info, дубли id в `results.yaml`), F7 (low, устаревший снимок панели → 2-й FAIL в `verify-data`) |
| Что осталось открытым | — | D1, D3, D4, D5–D8, F2–F7, D10–D11; D6 (плавающий FAIL, сейчас 8.86 %) |

---

## 9C. Обновление после D1 (состав конкурентов)

**Дата проверки:** 03.11.2026, ~22:57–23:10. **Исполнитель:** engine-dev (task-7), отчёт — `docs/d1-competitors-list.md`, бэкап — `01-competitor-watch\config\clients\client-svet.yaml.bak-20261103-225252` (7 881 Б, 21:47:09). **Метод:** первоисточники — новый конфиг против официальной таблицы `docs\projects\svet-project-base.md` (§ «Конкуренты», 19 строк), бэкап, снимок `lots.csv`, `analytics-2026-11-03.json`, `competitor-profiles\*`, панель. Прогон не повторял, профили не правил, конфиг не менял.

**Вердикт по D1: ЧАСТИЧНО ЗАКРЫТО.** Заявленный состав конкурентов приведён в соответствие официальному списку (это подтверждено полностью), но ПРОИЗВОДНЫЕ артефакты — конкурентные профили — остались прежними, поэтому расхождение «список ↔ профили» сохраняется, а связность в панели по-прежнему ложно зелёная (F4).

### 9C.1 Состав конфига — ПОДТВЕРЖДЕНО

Новый `client-svet.yaml` (15 674 Б, mtime 22:54:39, `updated: 2026-11-03`) содержит **20 записей**: 19 официальных в порядке таблицы + «Михалковский» последним. Сверка с таблицей (скриптом, по name/developer/site):

- **все 19 официальных ЖК присутствуют и стоят в том же порядке**, что и в таблице (Селигер Сити → Дмитровское небо → Very → Mod → Level Южнопортовая → Адмирал → AFI Tower → Pride → Level Селигерская → Яркий квартал Инджой → Апсайд Тауэрс → Сити Бэй → Kinetic → Квартал МОНС → Тринити 3 → Онежский вал → Руставели 14 → Акценты → Дмитровское ш., 89);
- **`developer` совпадает с таблицей во всех 19 случаях** (MR Group, ЛСР, ГК Основа, MR Group, Level Group, Галс, AFI Development, PIONEER, Level Group, Талан, Upside Девелопмент, MR Group, UDS, Брусника, Гранель, ПИК, ПИК, Plus Development, Фонд реновации);
- **`site` совпадает во всех 18 случаях**, где в таблице есть URL; у «Дмитровское ш., 89» в таблице прочерк «—» и в конфиге пустая строка — это корректно, а не расхождение;
- одно нормализационное отличие: в таблице «Level **C**елигерская» с латинской `C` (опечатка источника), в конфиге — «Level **С**елигерская» с кириллической; по составу это тот же ЖК, остальные поля совпадают.

### 9C.2 Ссылки площадок — ПОДТВЕРЖДЕНО

- Сохранены все прежние проверенные ссылки: **5 cian** (Селигер Сити, Дмитровское небо, Kinetic, Онежский вал, Акценты) + **2 yandex_realty** (Акценты, Михалковский) = **7 ссылок у 6 записей**; ни одна не потеряна (сверка с бэкапом дала пустой список расхождений).
- **Выдуманных URL нет:** множество всех URL в `platforms` (13 значений) полностью укладывается в объединение «сайты из таблицы + ссылки старого конфига» — проверка «URL вне разрешённого набора» вернула «нет».
- У остальных 14 записей `platforms` пустые с комментарием-TODO («ссылка на площадку не подтверждена — не выдумываем»), а у 13 из них класс явно помечен как неподтверждённый (см. 9C.4).

### 9C.3 «Михалковский» сохранён и явно помечен — ПОДТВЕРЖДЕНО

Запись стоит отдельным блоком после 19-х с заголовком-комментарием «ДОПОЛНИТЕЛЬНЫЙ ОРИЕНТИР — вне официального списка застройщика», пояснением «В официальном списке (лист «СВЕТ») отсутствует, но сохранён как ориентир по сегменту» и полем `source: "дополнительный ориентир (вне списка застройщика)"`. Машинная проверка «записи вне официальной таблицы» находит только его и «Level Селигерская» (последнее — ложное срабатывание из-за латинской `C` в таблице, см. 9C.1).

### 9C.4 Вопрос приёмщику: `class: ""` — «неизвестно» или подстановка?

**Моя оценка: это честное «неизвестно», подстановки нет — для приёмки приемлемо, но с оговоркой.**

Факты:
- **7 записей** имеют `class: "бизнес"` (Селигер Сити, Дмитровское небо, Kinetic, Квартал МОНС, Онежский вал, Акценты, Михалковский) — эти значения взяты из подтверждённого источника `00-admin\config\competitors.yaml`, то есть не выдуманы;
- **13 записей** имеют `class: ""` с инлайновым комментарием «класс не подтверждён официальной таблицей» (проверено на примере «Level Селигерская»);
- **класс нигде не подставляется вместо значения:** `grep "Класс|class.*header"` по `01-competitor-watch\scripts` не находит ни одного места, где класс выводится в отчёт; поле лишь копируется в профиль (`competitor_profile.py:898 profile["class"] = item.get("class")`). В сгенерированном отчёте за 2026-11-03 слова «класс» нет вообще — то есть пустая строка не выдаётся за значение в отчёте клиенту;
- **«неизвестно» не превращается молча в целевой сегмент:** `discover_competitors.class_matches("", ["бизнес"])` возвращает `None` («неизвестно — не отбрасываем, помечаем», `discover_competitors.py:338-340`), а не `True`; в логе кандидат помечается «класс «неизвестен» не совпадает с сегментом наблюдения». То есть пустое значение не проходит фильтр по сегменту как «бизнес»;
- `validate_config.py` проходит с 13 пустыми классами (`[OK] client-svet.yaml (источников 5, конкурентов 20)`, exit 0) — значит требование `validate_config.py:43` проверяет **наличие** поля, а не его непустоту.

**Оговорка (info).** Семантика «пусто = неизвестно» нигде письменно не закреплена, и валидатор её не защищает: если позже появится код с дефолтом `item.get("class") or "бизнес"`, 13 непроверенных ЖК молча станут «бизнесом». Рекомендация: (1) дописать в `registry/README-agents-settings.md`/README клиентского конфига правило «`class: ""` = класс не подтверждён, в отчётах не показывается, в фильтр сегмента не проходит»; (2) при необходимости ужесточить `validate_config` отдельным правилом вида «`class` пуст И нет площадок → WARN» (сейчас по 13 таким записям предупреждений нет вовсе). Это не блокирует приёмку D1.

### 9C.5 Валидность конфига — ПОДТВЕРЖДЕНО

```
.venv\Scripts\python.exe -m pytest 01-competitor-watch\tests -q   →  268 passed in 27.19s
.venv\Scripts\python.exe 00-admin\scripts\validate_config.py       →  exit 0
   [OK] client-svet.yaml (источников 5, конкурентов 20)
   [WARN] clients/client-svet.yaml: competitors[19] (Дмитровское ш., 89): ни сайта, ни ссылок на площадки — проверять нечего
   ПРЕДУПРЕЖДЕНИЙ: 1 — они не блокируют запуск
```
YAML парсится (`yaml.safe_load` в моём сверочном скрипте). WARN относится ровно к одной записи и совпадает с прочерком «—» в таблице-источнике, т.е. честен.

### 9C.6 Прогон и данные — ПОДТВЕРЖДЕНО

- `registry\runs.jsonl`: **22** записи (было 20). Новые: `client-granel` 22:55:26 (13 263 мс) и `client-svet` 22:55:42 (16 014 мс); `artifact = …2026-11-03-competitor-watch.pdf`, `error = null` (4 формата собраны). Суммарно 29.3 с — совпадает с заявкой 29.5 с.
- Снимок `data\clients\client-svet\snapshots\2026-11-03\lots.csv`: **154 строки, все active**; источники `cian=142, yandex_realty=8, developer-sites=4`.
- Данные дали **8 проектов из 20**: Селигер Сити 30, Акценты 32, Дмитровское небо 28, Онежский вал 28, Михалковский 32, Level Селигерская 2, Level Южнопортовая 1, Very 1 (сумма 154). Полностью совпадает с заявкой engine-dev.
- Причины «данных нет» у 12 записей: у 13 записей `platforms` пустые (ссылка не подтверждена) и по большинству сайтов застройщиков нет структурированных цен (в отчёте: «Сайты застройщиков | получилось 4 | 3»); отдельно **Kinetic** — cian-ссылка есть, но снимок дал 0 лотов (в отчёте учтён как «ушедшие 25 лотов»).
- `analytics-2026-11-03.json`: `by_competitor=8`, `by_source=cian:142, developer-sites:4, yandex_realty:8`; в `data_status` добавлены честные `dynamics:<проект>=no_data` для новых проектов («нет медианы ₽/м² в одном из снимков» / «нет предыдущего снимка»).
- **Выдуманных лотов не появилось** (нет строк без цены и с `ppm2=0`), но в ценах нашлись аномалии — см. 9C.8.

### 9C.7 Панель и `verify-data.mjs`

- `dashboard\public\data\competitor-analytics.json` пересобран (mtime 22:56:03): `withData=2`, `lots=383`, `competitors=16` (= 8 svet + 8 granel), `sources=5`, `email` — `eml_saved`.
- `node dashboard\verify-data.mjs` → **exit 0**, «Всё сошлось. Предупреждений сборщика: 1.»; FAIL нет вовсе (плавающий D6 сейчас отсутствует: 2.36 %; F7 закрылся после пересборки — `OK число прогонов совпадает … (22 / 22)`), аналитика собрана: `2/2`, `383/383`, `источников: 5`.
- **Но связность профилей остаётся ложно зелёной (F4 не изменился):** `crossCheck.comparedProjects=0`, `ok=true`, `reportLotsTotal=170` против `analyticsLotsTotal=383`, а `verify-data` печатает `OK связность с профилями конкурентов проверена (или объяснено расхождение) (сходятся по 0 проект(ам))`. Причина та же: профили не пересобраны.
- **Профили конкурентов не пересобраны — подтверждено:** в `data\clients\client-svet\competitor-profiles\` по-прежнему **6 файлов от 01.11.2026 18:00:38** (`zhk-narvin`, `zhk-soul`, `zhk-businovskiy-park`, `zhk-dmitrovskoe-nebo`, `zhk-mihalkovskiy`, `zhk-seliger-siti`) + `_summary.json` (01.11). Ни один из 12 новых ЖК профиля не получил, а «Нарвин», «СОУЛ», «Бусиновский парк» остались в профилях, хотя в новом официальном списке их нет.

### 9C.8 Новые находки прогона (не связаны с правкой списка, но попали в отчёт клиенту)

| ID | Severity | Что найдено |
|---|---|---|
| F8 | medium | **«Михалковский»: 25 из 32 лотов имеют одинаковую цену 70 000 000 ₽** при площадях 27–37 м² → ppm2 1,9–2,6 млн ₽/м². В снимке 2026-11-02 таких лотов **0**. Из-за этого отчёт показывает медиану «Михалковский» **1 523 397 ₽/м²** и главный вывод «Сильнее всего медиана изменилась в «Михалковский»: **+77,32%**» — это артефакт парсинга цены (одна величина «от» размножена по лотам), а не движение рынка. Похоже, страница cian отдала цену уровня проекта, а коннектор присвоил её каждому лоту. Рекомендация: валидировать аномалии (одинаковая цена на N лотов, ppm2 вне коридора ~150–800 тыс. ₽/м² для бизнес-класса Москвы) и помечать срез как недостоверный, а не публиковать +77%. |
| F9 | medium | **`lot_id` источника cian нестабилен между прогонами** → ложный прирост/уход. Пересечение `lot_key` между снимками 11-02 и 11-03 — **15 из 175**; отчёт печатает «Новые лоты 139» и «Ушедшие лоты 160» и рекомендацию «Ушли 160 лотов — проверьте перераспределение спроса», хотя проекты и объёмы почти те же (175 → 154). Для «Михалковского» все 32 id различаются между двумя днями. Смягчающее обстоятельство: в §9 отчёта ограничение «переименование лота в источнике выглядит как уход + приход» **честно раскрыто**, и стабильность id никогда не была подтверждена (до 11-02 сопоставимых снимков по этим проектам не было). Тем не менее контракт `settings.yaml` (`lot_id_fallback: hash(url)`, «иначе лот не сопоставится и даст ложный приход/уход») на практике не выполняется: в снимке `url` у лотов cian пустой. Требуется проверка логики id в cian-коннекторе. |
| F10 | low | **Лоты с сайтов застройщиков дают неправдоподобно низкий ppm2 и пустой `url`**: Level Южнопортовая 1 100 000 ₽ / 31,7 м² = **34 700 ₽/м²**, Level Селигерская 2 600 000 ₽ / 34,7 м² = **74 928 ₽/м²** (остальные лоты рынка — 170–670 тыс.). Похоже, парсер взял не цену квартиры (паркинг/акция/«от»). Все 4 лота с developer-sites имеют `url=""`. |
| F11 | info | **Отчёт не называет охват явно:** в §9 нет фразы «20 заявлено, 8 с данными, 12 без данных» и причин по каждой; показаны только 8 проектов с данными и generic-ограничения. Для клиента это выглядит как «всё собрано». Рекомендация: выводить явный блок «данных нет по N конкурентам: <список> — причина (нет ссылки / нет цен на сайте / 401)». |

### 9C.9 Что осталось для полного закрытия D1

1. **Пересобрать конкурентные профили по новому конфигу** (`competitor_profile`/T57 по `data/candidates` и клиентскому списку) — иначе `competitor-profiles\*` остаются старым автоподборным набором из 6 ЖК, «Нарвин/СОУЛ/Бусиновский парк» числятся конкурентами, а 12 новых ЖК профилей не имеют.
2. **Починить F4** в `competitor-analytics.mjs`: при `comparedProjects = 0` не возвращать `ok: true` (и не писать «сходятся»), а отдавать явную причину («сравнивать нечего: пересечение ключей проектов пусто»); отдельно — согласовать ключи проектов профилей («ЖК …») и движка («…») либо сопоставлять по нормализованному имени.
3. Закрыть F8/F9 (валидация аномальных цен и стабильность `lot_id`) — иначе недельный отчёт для клиента содержит ложный «+77,32%» и ложные «ушедшие 160 лотов».
4. Закрыть F11 (явный охват «8 из 20» с причинами) и оговорку 9C.4 (закрепить семантику `class: "" = неизвестно`).

---

## 10. Что не удалось проверить и почему

1. **`schtasks /Query /TN Agent1-Weekly`** — песочница отклоняет любую команду `schtasks` («cannot find the path specified», в т.ч. на `/Query /FO CSV` без фильтра). Next Run и факт регистрации задачи подтверждены только косвенно (`install\agent1-weekly-task.xml` + дата `2026-11-05` = четверг). Нужен прогон вне песочницы.
2. **`test-toggle-e2e.mjs` (OK 31/0) и `test-analytics-pickup.mjs` (OK 24/0)** — не перепрогонял: оба пишут в `dashboard\_ux-harness\tmp`, а `dashboard\**` в моей зоне только для чтения. Логика покрыта моими модульными пробами (пп. 4.5, 8) и живым `ux-check` Lead'а.
3. **`ux-check.mjs`** — по указанию Lead'а не дублировал (Chrome в песочнице не стартует); результат включён со ссылкой на источник.
4. **Сквозной реальный прогон движка** (`collect_clients.py` / `install\agent1-weekly.cmd`) — сам не запускал: он пишет в `01-competitor-watch\reports` и `registry\**`, вне моей зоны записи, а task-4 прямо запрещает повторный запуск. Прогон выполнен engine-dev (task-3); его артефакты проверены мной по первоисточникам — см. §9A. **[Обновлено 03.11.2026, ~22:45]** Прежняя формулировка «именно поэтому D2 остаётся открытым» больше не действует: D2 закрыт прогоном 03.11 22:34, остаточные проблемы форматов вынесены в F1/F5.
5. **Кнопка «Сформировать отчёт за неделю» из панели** — проверена только Lead'ом вживую (п. 6); у panel-dev в §3.4 честно отмечен второй потенциальный барьер: `serve.mjs` по умолчанию берёт python из runtimes DSH, а не venv проекта (лечится `DSH_PYTHON=…\ru-marketplace-mcp\.venv\Scripts\python.exe`).

---

## 11. Итоговый вердикт

**WP1 (расписание, доставка, настройки) — закрыто с оговорками.** Расписание «четверг 11:00» согласовано во всех четырёх реестрах, документации, клиентских конфигах и XML задачи Windows; тумблеры и `watch.query` описаны и валидируются. Оговорки: состав конкурентов client-svet не подтверждён (D1 — нужно решение пользователя), регистрация задачи в Планировщике не проверяема из песочницы, `report.sections` вводит в заблуждение (D5).

**WP2 (движок: аналитика, дедуп, прогноз, почта) — код и тесты готовы, приёмка по артефактам НЕ закрыта.** Всё, что проверяемо прогоном и тестами, сходится: 268 тестов PASSED, все 8 тумблеров реально меняют результат, дедуп и «только новые» работают, прогноз помечен `estimate`/`trend-linear`, `.eml` и честный статус воспроизводятся. Но **ни один живой артефакт WP2 не существует** (D2), и гейт `delivery.channels` не реализован (D3) — это осознанно не закрывалось исполнителем. Для закрытия WP2 обязателен один реальный прогон `collect_clients.py` на финальном коде (лучше — сразу после появления SMTP-кредов, тогда же проверится и живая отправка).

**WP3 (панель) — закрыто.** Тумблеры на карточке, одно поле `watch.query` с автозапуском подбора (за честной заглушкой T57), индикатор «сделана / не сделана» с проверенными негативными ветвями, раздел «Аналитика» с исправленным `emptyReason`, регресс-шаг в `verify-data` — всё подтверждено независимо; `ux-check` на финальном коде зелёный (OK 21 / 0, результат Lead'а), оба ранее падавших действия проходят.

**Общий вывод.** WP1–WP3 можно считать закрытыми по коду, тестам и панели. Открытыми остаются: (1) реальный прогон движка после WP2 (D2, блокирует приёмку артефактов аналитики/почты), (2) подтверждение списка конкурентов пользователем (D1), (3) проверка задачи Windows вне песочницы, (4) SMTP-креды для живой отправки. Дефекты D3–D11 не блокируют закрытие и вынесены в бэклог с severity.

**[Обновлено 03.11.2026, ~22:45 — см. §9A]** Пункт (1) снят: реальный прогон `collect_clients.py` выполнен (task-3), все артефакты WP2 подтверждены, **D2 закрыт**, **D9 закрыт**, **D4 подтверждён на живых данных** (остаётся открытым, low). WP2 переходит из «приёмка по артефактам не закрыта» в «закрыто с открытыми дефектами форматов и связности»: F1 (venv без `openpyxl`/`python-docx` → только `md`, `.eml` без вложений, medium), F4 (ложно зелёная связность «профили ↔ аналитика», medium), F5/F2/F3 (low/info). Открытыми остаются также (2) состав конкурентов (D1), (3) задача Windows вне песочницы, (4) SMTP-креды, D3 (гейт `delivery.channels`), D4, D5–D8, D10–D11.

**[Обновлено 03.11.2026, ~22:58 — см. §9B]** **F1 закрыт**: `openpyxl 3.1.5` и `python-docx 1.2.0` стоят в venv, xlsx/docx/pdf валидны, `.eml` с вложениями xlsx+pdf, `pytest` 268 passed. Дополнительно подтверждено (и исправлено) более тяжёлое: недельный `install\agent1-weekly.cmd` до правки **не запускал движок вообще** (LF-only → `cmd.exe` разбирал файл по блокам, команда движка не выполнялась, тихий `exit 0`); после перевода в CRLF работает — лог `logs\agent1-weekly.log` и `runs.jsonl` показывают реальный прогон, 4 файла на клиента. Новые дефекты: F6 (info, дубли id в `results.yaml`), F7 (low — данные панели не пересобраны после прогонов, из-за чего `verify-data` даёт второй FAIL «20 / 16»). Открытыми остаются: D1, D3, D4, D5–D8, F2–F7, D10–D11 и D6 (плавающий FAIL).

**[Обновлено 03.11.2026, ~23:12 — см. §9C]** **D1 закрыт частично**: конфиг `client-svet.yaml` приведён к официальному списку — 19 ЖК в порядке таблицы (developer и site совпадают), «Михалковский» сохранён и помечен как ориентир вне списка, 7 проверенных ссылок (5 cian + 2 yandex) сохранены, выдуманных URL нет; `class: ""` у 13 записей — честное «неизвестно» (в отчёте класс вообще не выводится, в фильтр сегмента не проходит). **НЕ закрыто:** конкурентные профили не пересобраны (6 файлов от 01.11), поэтому связность «профили ↔ аналитика» остаётся ложно зелёной (F4: 0 сравнённых проектов, 170 против 383 лота). Новые находки прогона: **F8** (25 из 32 лотов «Михалковского» с одинаковой ценой 70 000 000 ₽ → ложный «+77,32 %» и медиана 1,52 млн ₽/м² в отчёте клиенту), **F9** (нестабильный `lot_id` cian → ложные «139 новых / 160 ушедших»), F10, F11. **F7 закрыт** пересборкой сборщика: `verify-data.mjs` → exit 0, `22 / 22`, FAIL нет.

**Приёмка task-2:** отчёт создан, по пунктам 1–7 приведены команды и наблюдаемые результаты, дефекты не замаскированы.
