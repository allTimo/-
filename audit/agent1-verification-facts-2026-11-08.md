# Независимая проверка фактов об Агенте 1 (task-4)

**Верификатор:** verifier (независимо от авторов `audit/*.md`).
**Дата:** 2026-11-08. **Рабочий каталог:** `C:\Users\Артем\Desktop\тестDH`.
**Метод:** только чтение кода/данных; собственные команды и цитаты. Ровно **один** запуск pytest (п. 3).
Не запускались: панель, `collect.mjs`, `ux-check.mjs`, движок (`collect_clients.py`/`run_weekly.py`),
планировщик, сеть.
**Статусы:** подтверждено / частично / опровергнуто / нет данных.

Сводка: **подтверждено 8**, **частично 2**, **опровергнуто 0**, **нет данных 0**.

---

## 1. Есть ли в контуре Агента 1 вызовы LLM — **подтверждено: «LLM-контура нет»**

Команда: `grep -i 'openai|anthropic|deepseek|llm|api_key|gpt-|chat.completions'` по `01-competitor-watch/**`,
`00-admin/**`, `dashboard/serve.mjs`; отдельный прогон по `01-competitor-watch/scripts/**` с шаблонами
`openai|anthropic|\bllm\b|chat\.completions|gpt-|claude|prompt|inference`.

Результат:
- `01-competitor-watch/scripts/**` → **0 совпадений** по LLM-шаблонам.
- `01-competitor-watch/**` → совпадения только в **данных/реестре** (`agents.yaml:13,28,43,56`,
  `agent-settings/*.yaml` — имена моделей) и в `scripts/web_search.py` (`SERPER_API_KEY` — поисковый
  API, не LLM) и `scripts/client_report.py:29-31` (пути к `node.exe`/LibreOffice Kit DSH).
- `00-admin/**` → 2 совпадения, оба в документации про `REEFAPI_KEY` (`00-admin/runbook.md:342`,
  `00-admin/research/reefapi-probe-2026-11-04.md:5`) — это ключ источника данных, не LLM.
- `dashboard/serve.mjs` → 1 совпадение: `:364` — строка подписи `'встроенный бандл DeepSeek …'`
  (текст для UI), вызова нет.

**Вердикт:** в контуре Агента 1 вызовов LLM нет. Конвейер детерминированный.
Оговорка (не входит в контур Агента 1): панель показывает использование моделей DSH в
`dashboard/public/data/usage.json` (`openai/gpt-6-luna`, `anthropic/claude-*`) — это статистика сессий
DSH, а не расход Агента 1.

## 2. Поля `registry/agent-settings/agent-1-competitor-watch.yaml`: сколько и сколько читает движок — **подтверждено (частично расходится с аудитом по полноте списка)**

Метод: `yaml.safe_load` файла → 79 листовых ключей; затем трассировка **потребителей**
(`cwlib.load_agent_settings` → `marketing_settings.py`, `analytics.resolve_toggles`,
`delivery_email.py`, `discover_competitors.py:84`, `budget_sources.py:408`) и grep каждого ключа
по `01-competitor-watch/scripts/**`.

**79 листовых полей; читает движок 44; не читает 35.**

Читаются (44): `delivery.channels/addresses/auto_send` (`delivery_email.py:60,84-85,196`);
`agent1.projects` (`discover_competitors.py:84`); `agent1.price_threshold_pct`, `min_lots`,
`compare_depth_weeks`, `top_deals_count` (`marketing_settings.py:374-410`); все 15 полей
`agent1.selection.*`; все 12 полей `agent1.watch.*`; все 8 полей `agent1.analytics.*`
(`analytics.py:56-87`); `agent1.competitor_domains` (`budget_sources.py:408` — читается карта
«домен → ключ проекта», поэтому ключ `seliger-city.ru` считаю прочитанным).

**Не читаются (35):**
- `version`, `updated` — 2;
- `schedule.enabled/days/time/frequency/timezone/only_on_new_data` — 6
  (`schedule` в `clients.py:79-84,154-159` — это расписание **клиента** из `config/clients/*.yaml`,
  не группа агента);
- `model.name/limit_rub/limit_tokens/on_limit` — 4 (модель движок берёт из `agents.yaml`:
  `collect_clients.py:483-491`);
- `priority.level/max_parallel/timeout_sec/retries` — 4;
- `report.formats/sections/language/branding` — 4 (`report` в `clients.py:87,163` — конфиг клиента;
  форматы — `settings.yaml → output.formats`, `cwlib.py:1015-1017`);
- `delivery.copy_to` — 1 (grep `copy_to` по scripts → 0);
- `alerts.when/price_threshold_pct/quiet_hours` — 3;
- `limits.skip_weekends/min_interval_hours/stop_switch` — 3;
- `agent1.promo_words`, `agent1.collect_mode` — 2 (встречаются только в белом списке
  `KNOWN_AGENT1`, `marketing_settings.py:82-84`, и нигде не потребляются);
- `agent1.source_modes.cian/avito/yandex-realty/domclick/developer-sites` — 5 (grep `source_modes`
  по всем `*.py` проекта → **единственное** совпадение `marketing_settings.py:84` — тот же белый
  список; реальные режимы источников живут в `config/clients/*.yaml:57-60`).

**Расхождение с аудитом (неполнота, не противоречие):** `audit/agent-layer.md:50-61` перечисляет
нечитаемыми ~10 полей (`timeout_sec`, `retries`, `limit_rub`, `limit_tokens`, `on_limit`,
`only_on_new_data`, `alerts`, `quiet_hours`, `min_interval_hours`, `skip_weekends`). Мой пересчёт даёт
**35** нечитаемых: тот же список плюс `version`, `updated`, вся группа `report` (4),
`delivery.copy_to`, `agent1.promo_words`, `agent1.collect_mode`, `agent1.source_modes` (5).
Аудит эти 13 полей не называет — **список аудита неполон**, хотя ни одно его утверждение не ложно.

## 3. Точное число тестов — **подтверждено**

Единственный разрешённый запуск:
`connectors/ru-marketplace-mcp/.venv/Scripts/python.exe -m pytest 01-competitor-watch/tests -q`
(из каталога `marketing-agents`).

Итоговая строка: **`357 passed in 52.68s`** (0 failed, 0 error, 0 skipped в выводе).

Оговорка о коде возврата: обёртка PowerShell сообщила `exit code: 1` — это артефакт
`NativeCommandError` из-за предупреждения `PytestDeprecationWarning` в stderr
(`pytest_asyncio/plugin.py:300`, опция `asyncio_default_fixture_loop_scope` не задана), а не провал
тестов. Отдельного прогона для проверки кода возврата не делал — правило «ровно один запуск pytest».

**Важно: число 357 зависит от рабочего каталога запуска.** Мой прогон выполнен из
`marketing-agents` (относительный путь `01-competitor-watch/tests`). Тест
`tests/test_clients.py:593-595` (`ArtifactPathTestCase.test_01`) сравнивает результат
`collect_clients.artifact_ref("01-competitor-watch/reports/clients/x.md")` с относительной строкой,
а `artifact_ref` (`collect_clients.py:77-81`) вызывает `Path(path).resolve()`, т.е. разрешает путь
относительно **CWD**: из корня рабочей области (`тестDH`) путь оказывается вне
`cw.PROJECT_ROOT` (`marketing-agents`) и функция честно возвращает абсолютный путь → тест падает.
Сверка: `audit/agent1-quality-2026-11-08.md:91` (A7) фиксирует `1 failed, 356 passed` при запуске из
корня. Оба наблюдения согласуются: **зелёный прогон 357/357 достижим только из каталога
`marketing-agents`**; каталог запуска нигде не зафиксирован (`pytest.ini` отсутствует).
Повторный прогон для проверки этой гипотезы я не делал (лимит «ровно один запуск pytest»);
вывод следует из кода `artifact_ref` + `test_01`.

Сверка с аудитом: `audit/verification.md:26` (V9д) — «357 движок + 108 скиллы = 465»; мои 357
совпадают. `registry/services.yaml:17` «52 теста» — по-прежнему заниженная цифра.

## 4. Как считается стоимость прогона; 120 ₽ — факт или оценка — **подтверждено (120 ₽ — смета, записанная как факт)**

Формула (код): `collect_clients.py:468-480`
```
468 def estimate_cost(model, chars_in, chars_out):
469     """Оценка в рублях по prices.yaml: токены ≈ символы/4."""
473     rub_in = float(entry.get("rub_per_1m_in") or 0)
474     rub_out = float(entry.get("rub_per_1m_out") or 0)
477     tokens_in = int(chars_in / 4)
478     tokens_out = int(chars_out / 4)
479     cost = tokens_in / 1_000_000 * rub_in + tokens_out / 1_000_000 * rub_out
```
Вход оценки (`collect_clients.py:768-770`):
```
768 chars_in  = sum(len(json.dumps(item, ensure_ascii=False)) for item in results) + len(rows) * 120
769 chars_out = sum(path.stat().st_size for path in report["files"].values() if Path(path).exists())
770 cost_rub, tokens = estimate_cost(agent_model(), chars_in, chars_out)
```
То есть: вход — JSON собранных источников + константа 120 символов на лот; выход — **размер файлов
отчёта**, а не токены модели. Модель берётся из `agents.yaml` (`:483-491`), а не из настройки агента.

`registry/runs.jsonl` — мой пересчёт: **27 записей**, `service` у всех `competitor-watch`,
**сумма `cost_rub` = 255,9676 ₽**, `max = 120`, записей с `cost_rub == 120` — **2**, с `0` — **8**,
в диапазоне (0; 1,27] — **17** (17 + 8 + 2 = 27). Уникальных пар (клиент, дата) — **13**.

`120 ₽` — **оценка (смета прайс-листа)**, `registry/services.yaml:13` `cost_rub: 120` (там же
`:25` 450 и `:37` 260). Панель пишет смету в журнал как факт: `dashboard/serve.mjs:1882`
`const cost = Number(svc.cost_rub) || 0`, `:1910` `cost_rub: proc.ok ? cost : 0`. Две записи ровно по
120 ₽ в `runs.jsonl` — это записи панельного прогона, а не измерение. **Фактического замера расхода
нет ни одного** (LLM не вызывается, внешние API не тарифицированы) → статус «оценка», не «факт».

Сверка с аудитом: `audit/flows-econ.md:224` (27 записей, сумма 255,97 ₽, 2×120, 8×0) — совпадает
с моим пересчётом до копеек.

## 5. Белый список получателей: fail-open или fail-closed — **подтверждено (код fail-open, текущий конфиг fail-closed)**

Код `delivery_email.py:158-166`:
```
158 def split_by_allowlist(recipients, allowlist):
160     if not allowlist:
161         return list(recipients or []), []
162     allowed = {str(item).strip().lower() for item in allowlist}
165         (kept if str(address).strip().lower() in allowed else rejected).append(address)
```
`recipients_allowlist()` (`:138-155`) возвращает `[]` при отсутствии/пустом/нечитаемом списке;
докстринг сам это фиксирует: `:141-142` «An empty/missing list means "no restriction"».

Итог: **при пустом/нечитаемом `settings.yaml` письмо уходит на любой адрес из agent-settings или
конфига клиента (fail-open)**. В текущем репозитории список **непустой** —
`00-admin/config/settings.yaml:109` `recipients_allowlist` + 2 адреса → фактически работает жёстко
(fail-closed по конфигу, fail-open по коду). Отброшенные адреса сообщаются:
`delivery_email.py:211-217`.

Сверка с аудитом: `audit/verification.md:23` (V6) и `audit/saas-layer.md:513` — совпадает полностью.

## 6. Секреты и git — **частично (файлы секретов есть, но в единственный git-репозиторий не попадают)**

Наличие файлов (значения не читались, только длина/имена ключей):
- `marketing-agents/.env` — 76 Б, ключи `REEFAPI_KEY`, `REEFAPI_API`;
- `marketing-agents/00-admin/config/.smtp-password.local` — 17 Б
  (путь объявлен в `settings.yaml:101 smtp_password_file`);
- `marketing-agents/01-competitor-watch/config/secrets.local.example.yaml` — 400 Б (шаблон);
- `marketing-agents/dashboard/logs/server.out.log` — 987 Б, `server.err.log` — 0 Б; grep по
  `password|token|api[_-]?key|Authorization|smtp` → **0 совпадений** в обоих.

Git:
- `Test-Path .git` → **False** и для `тестDH`, и для `marketing-agents`; `git rev-parse` →
  `fatal: not a git repository`. **VCS в рабочем дереве нет.**
- Единственный репозиторий — `C:\Users\Артем\Desktop\тестDH\.gh-upload\.git`
  (remote `https://github.com/allTimo/-.git`, 3 коммита, HEAD `815d8e7`), **1029 отслеживаемых файлов**.
- `git ls-files` в нём: совпадений по `^\.env|smtp-password` → **0**. `git check-ignore -v .env` →
  `.gitignore:152:.env`. На диске `.gh-upload/.env` и `.gh-upload/00-admin/config/.smtp-password.local`
  **отсутствуют**.
- Локальный `marketing-agents/.gitignore:3,12-14` игнорирует `00-admin/config/.smtp-password.local`,
  `*.local`, `.env`, `.env.*` (кроме `.env.example`).

Вывод: секреты лежат в рабочем дереве (это ожидаемо и задокументировано), но **в git-отслеживаемые
файлы не попадают**. Статус «частично» — потому что защита держится на правилах `.gitignore` и на
отсутствии файлов в зеркале, а не на том, что секретов нет:

- `.gh-upload/.gitignore` игнорирует `.env`, `logs/`, `*.log`, `*.key`, `*.pem` — но правила
  `*.local` в нём **нет**, и `00-admin/config/.smtp-password.local` не покрыт ни одним правилом
  зеркала. Утечки нет только потому, что этот файл в `.gh-upload` физически не скопирован
  (`Test-Path .gh-upload/00-admin/config/.smtp-password.local` → False). При копировании проекта в
  зеркало целиком файл станет кандидатом на коммит.

Сверка с аудитом: `audit/techdebt-risks.md:286` (единственный `.git` — `.gh-upload`) — совпадает.

## 7. Расколотый источник правды по снимкам — **подтверждено**

Что читает панель:
- `dashboard/collector/lib/sources.mjs:10-13` — **только два корня**:
  `01-competitor-watch/data/snapshots` и `marketing-agents/data/snapshots`.
  Второго каталога **нет на диске** (`Test-Path marketing-agents/data/snapshots` → False).
- `dashboard/collector/lib/competitor-report.mjs:630` — тот же общий корень
  `01-competitor-watch/data/snapshots`.
- `dashboard/collector/lib/agent1-status.mjs:21,137-146` — читает **общий корень + клиентские**
  `data/clients/<client>/snapshots`.

Что реально есть на диске:
- общий корень `01-competitor-watch/data/snapshots`: `2026-10-23`, `2026-10-30`,
  `_demo-site-zilart-2026-10-31`, `_paused-cian-2026-10-31` → **свежесть максимум 2026-10-30**;
- `data/clients/client-svet/snapshots`: `2026-11-01 … 2026-11-05` (mtime последнего 05.11.2026 19:20);
- `data/clients/client-granel/snapshots`: `2026-11-02 … 2026-11-05` (mtime 05.11.2026 19:15).

Сгенерированные артефакты панели (mtime **04.11.2026 21:08**, т.е. старше свежих снимков):
- `dashboard/public/data/sources.json`: `summary.snapshots = 4`, `summary.lastSnapshot = ""`
  (пусто) — видит только общий корень;
- `dashboard/public/data/agent1-status.json`: `snapshots.count = 11`, `snapshots.last.date = 2026-11-04`,
  `sourceOfTruth = "registry/runs.jsonl"`, roots — 3 (общий + 2 клиентских).

**Раскол подтверждён:** карточка «Источники»/`sources.json` считает статистику по общему дереву
(4 снимка, максимум 30.10), тогда как свежие данные (до 05.11) лежат в клиентских каталогах и
учитываются только модулем `agent1-status`. Числа расходятся: **4 против 11** снимков.

## 8. Статус F12/F13 — **подтверждено (закрыты по коду и данным; документы противоречат друг другу)**

Код:
- F13: `cwlib.py:43` `SOURCE_VALUES = ("cian", "avito", "yandex_realty", "site", "developer-sites", "other")`
  → `developer-sites` легален; проверка — `cwlib.py:422-424`.
- F12: `cwlib.py:53` `DELIVERY_RE = re.compile(r"^\d{4}(?:-Q[1-4])?$")` → год без квартала законен;
  проверка — `cwlib.py:507`.

Данные (мой пересчёт всех 13 `lots.csv` по обоим клиентам и общему корню):
`bad_delivery = 0` и `bad_source = 0` **на всех 13 снимках**; `source=developer-sites` реально
встречается (svet 2026-11-01 — 15 лотов; svet 2026-11-03/04 — 4; svet 2026-11-05 — 14;
granel 2026-11-05 — 1).

Документы:
- `docs/open-tasks-2026-11-04.md:23-24` — F12 и F13 «**закрыто 04.11 (вечер)**»;
- `docs/roadmap.md:38` — «**F12 (новое)** … **F13 (новое)**» в таблице приоритетов (строка 2), т.е.
  в списке незакрытых;
- `docs/session-start.md:71` — оба значатся в разделе «Риски и незакрытые проверки» как «новое».

**Противоречие документов подтверждено:** 2 из 3 документов (roadmap, session-start) не обновлены;
факты (код + данные) на стороне `open-tasks`. Ранее это уже отмечено в
`audit/00-architecture-audit-index-2026-11-08.md:36` — мой пересчёт подтверждает вывод независимо.
Дополнительно: регрессионного теста на F13 нет (`SOURCE_VALUES` в `01-competitor-watch/tests/**` →
0 совпадений), у F12 тест есть (`tests/test_clients.py:577-587`).

## 9. Обработка ошибок источников (401/403/captcha/пустая выдача) — **подтверждено**

`platforms.py`:
- `:77` `BLOCK_STATUSES = (401, 403, 405, 429, 439, 503)`;
- `:90` `CAPTCHA_MARKERS = ("captcha", "капча", "подтвердите, что вы не робот", "доступ ограничен", …)`;
- `:639-658` `detect_block(status, html, platform) -> (verdict, reason)`:
  - `:643-646` `401` → `needs_partnership` («данные только по договору/API»);
  - `:647-648` `403` для `cian`/`domclick` → `needs_partnership`;
  - `:649` прочие блок-статусы → `needs_browser` («HTTP %s»);
  - `:650-651` капча → `needs_browser` («страница отдала капчу/проверку бота»);
  - `:652-653` маркеры авторизации при тексте < 400 → `needs_partnership`;
  - `:654-655` **пустой текст → `needs_browser`, «пустой ответ»**;
  - `:656-657` JS-only маркеры → `needs_browser`.
- Пустая/неполная выдача лотов: `:1008` `{"status": "ok" if lots else "no_data"}`; `:1023-1052`
  и `:1094-1103` — ветки `status = "no_data"` при отсутствии распознанных лотов.
- Капча в JS площадки не путается с блокировкой: `:633` — текст чистится от `<script>/<style>`
  («в JS площадок встречается слово captcha и это не блокировка»).

`web_search.py`: `:92-94` (DuckDuckGo: «пустой ответ» + маркеры капчи/аномалии),
`:148` (Serper: «в ответе нет результатов — квота или пустой запрос»), `:172` (CDP: Chrome не
запустился — причина в тексте), `:187,194` (капча в выдаче), `:209` (пустой запрос).

`search_results.py:465-486`: пустые выдачи считаются; при `empty >= max(1, len(queries)//2)`
добавляется предупреждение о лимите поисковика, повторов не больше трёх.

`delivery_email.py:170-179` — отдельная честная ветка «письмо не уходит» с причиной
(нет `smtp_host` / `smtp_user` / пароля). Итого: ошибки источников **не приводят к выдуманным
нулям** — статус `no_data`/`needs_browser`/`needs_partnership` с текстовой причиной.

## 10. Идемпотентность при повторном прогоне за ту же дату — **частично (данные перезаписываются, журналы дублируются)**

Код:
- Снимок: `collect_clients.py:448-453` → `cwlib.write_csv` (`:184-194`) — `open(path, "w")`,
  **перезапись без бэкапа**; повторный прогон за ту же дату молча затирает `lots.csv`.
- Отчёт: `client_report.py` пишет файлы по имени `YYYY-MM-DD-competitor-watch.<ext>` — перезапись
  тех же имён; при смене набора форматов **старые файлы остаются** (см. данные ниже).
- Кэш аналитики: `analytics.write_analytics(path, …)` → тот же путь `analytics-<date>.json`, перезапись.
- Журнал прогонов: `collect_clients.py:494-500` `append_run` — `open(path, "a")`, **дозапись**;
  `discover_competitors.py:748-749` — то же; `dashboard/serve.mjs:232-233` — `appendFileSync`.
- Журнал источников: `collect_clients.py:772-779` — дозапись в `data/source-runs.jsonl`.
- `registry/results.yaml`: `collect_clients.py:510-534` `append_result` — блок **дописывается**
  в конец; ключ `id` = `res-<date>-<client>` не проверяется на существование → дубль id.
  Запись идёт через `sources_tool.write_atomic(..., backup=True)` (`sources_tool.py:176-191`) —
  атомарно, с `.bak-<timestamp>`.

Эмпирика (данные на диске):
- `registry/runs.jsonl`: 27 записей, **13 уникальных пар (клиент, дата)**; дубли: `None|2026-11-01` ×7,
  `client-granel|2026-11-03` ×4, `client-svet|2026-11-01` ×3, `client-svet|2026-11-03` ×4.
  `run_id` уникальны (в ключ входит `time.time()`, `collect_clients.py:781-782`).
- `registry/results.yaml`: 20 записей, **12 уникальных id**, дубли:
  `res-2026-11-01-svet`, `res-2026-11-03-granel`, `res-2026-11-03-svet`.
- `01-competitor-watch/data/source-runs.jsonl`: 72 строки, дозапись по датам
  (31.10 — 2, 01.11 — 18, 02.11 — 6, 03.11 — 24, 04.11 — 12, 05.11 — 10); ключа «дата+источник»
  для дедупликации нет.
- Каталоги отчётов: у `client-svet` на `2026-11-03` — 5 файлов, на `2026-11-05` — 3; у `client-granel`
  на `2026-11-03` — 5, на `2026-11-04` — 4. Разный набор файлов на разные даты подтверждает, что
  артефакты не удаляются и не сводятся к одному набору.

**Вердикт:** идемпотентности нет. Данные снимка/отчёта/кэша перезаписываются «как есть»,
а журналы (`runs.jsonl`, `source-runs.jsonl`, `results.yaml`) накапливают дубли за одну дату.

---

## Слабые места собственного доказательства

1. **Число «44 читает / 35 не читает»** получено трассировкой потребителей, а не формальным
   анализатором: ключи с родовыми именами (`name`, `url`, `enabled`, `sources`, `promos`) дают
   ложные срабатывания при grep, поэтому я разбирал их вручную по конкретным строкам кода.
   Границы «читает/не читает» для `agent1.watch.name/url` (выводятся из `query` через
   `cwlib.derive_watch_query`, `cwlib.py:1087`) я считаю прочитанными, хотя в YAML они заполнены
   явно — это трактовка.
2. **Код возврата pytest не подтверждён** (`exit code: 1` от обёртки при `357 passed`). Второй
   запуск запрещён условием задачи, поэтому причину (`PytestDeprecationWarning` в stderr) я
   установил по тексту вывода, а не отдельным прогоном.
3. **`sources.json`/`agent1-status.json` — сгенерированные артефакты** (mtime 04.11.2026 21:08).
   Я использую их как свидетельство о том, что панель видит, но не проверял, что они
   перегенерируются именно так при следующем запуске панели (панель не запускалась).
4. **Fail-open белого списка** проверен чтением кода и конфига; поведение при реально
   повреждённом `settings.yaml` не воспроизводилось (нельзя писать/ломать конфиг).

## Итоговая таблица

| № | Утверждение | Статус | Ключевое доказательство |
|---|---|---|---|
| 1 | LLM-контура в Агенте 1 нет | подтверждено | grep по `scripts/**` → 0; `serve.mjs:364` — только текст |
| 2 | В настройках агента 79 полей, движок читает 44, не читает 35 | подтверждено | `yaml.safe_load` + трассировка потребителей; список из 35 |
| 3 | Тестов ровно 357, все проходят | подтверждено | `357 passed in 52.68s` |
| 4 | 120 ₽ — смета `services.yaml:13`, а не факт; сумма журнала 255,9676 ₽ | подтверждено | `collect_clients.py:468-480,768-770`; `runs.jsonl` 27/2×120/8×0 |
| 5 | Белый список: код fail-open, текущий конфиг fail-closed | подтверждено | `delivery_email.py:158-166`; `settings.yaml:109` |
| 6 | Секреты есть в дереве, в git не попадают; `.git` в проекте нет | частично | `.env` 76 Б, `.smtp-password.local` 17 Б; `.gh-upload/.git` 1029 файлов, 0 совпадений; но `*.local` в `.gh-upload/.gitignore` не покрыт |
| 7 | Источник правды по снимкам расколот: панель-«Источники» видит 4 снимка (до 30.10), свежие (до 05.11) — в клиентских каталогах | подтверждено | `sources.mjs:10-13`; `sources.json` 4 / `agent1-status.json` 11 |
| 8 | F12/F13 закрыты по коду и данным, но 2 из 3 документов считают их открытыми | подтверждено | `cwlib.py:43,53`; 13 снимков — 0 нарушений; `roadmap:38`, `session-start:71` против `open-tasks:23-24` |
| 9 | Ошибки источников разведены по ветвям 401/403/капча/пусто, без выдуманных нулей | подтверждено | `platforms.py:77,90,639-658,1008,1023-1103` |
| 10 | Идемпотентности нет: снимок/отчёт перезаписываются, журналы дублируются | частично | `cwlib.py:184-194` (`"w"`), `append_run`; 27 записей → 13 уникальных дат, 20 id → 12 уникальных |
