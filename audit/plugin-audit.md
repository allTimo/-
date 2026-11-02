# Аудит плагинов и скилов профиля `desktop`

**Кто:** teammate `auditor` (независимый аудитор, режим «только чтение + отчёт»), task-4.
**Когда:** окно аудита 2026-10-31 20:14:53 → 20:20:07 (Europe/Moscow).
**Профиль:** `C:\Users\Артем\.dsh\profiles\desktop` (28 бандлов + 2 пакета вне `dsh.profile.bundles`).
**Node для измерений:** `C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` (v24.21.0).
**Артефакты-доказательства:** `marketing-agents\audit\_manifest-before.json`, `_manifest-after.json`, `_probe-*.mjs`, `_office-probe.xlsx`.

> Все команды в отчёте — реально выполненные. Секреты нигде не раскрыты: фиксируется только **факт наличия** и длина, значения не читались и не выводились.

---

## 1. Выжимка (сколько чего работает)

### Плагины профиля — 30 объектов

| Вердикт | Кол-во | Объекты |
|---|---|---|
| ✅ работает | **10** | dsh-base, dsh-web-app, agent-team-profile, tool-worktree, terminal-bundle, session-search, badge-skill-bundle, ralph-bundle, dsh-scrape-webpage, dsh-locale-ru |
| ⚠️ частично | **15** | auto-review-бандл, plugin-market-бандл, session-titles-бандл, voice-input-бандл, inspector-profile, cot-translation-бандл, dsh-review, dshmarket, dsh-git-credentials, ru-marketplace-mcp-dsh, dsh-skill-browser, dsh-serper-search, superdesign-dsh, dsh-vision-router, dsh-delegate-router |
| ❌ не работает | **5** | @deepseek-ai/dsh-subagent-codex, @deepseek-ai/dsh-subagent-claude-code, @sandbaseai/dsh-skills, dsh-telegram-channel-ru, dsh-marketing-skills (проектный) |

**Загрузка профиля в целом — OK.** Валидатор профиля:

```
> node marketing-agents\install\check-profile-bundles.mjs "C:\Users\Артем\.dsh\profiles\desktop"
package.json: parses OK
bundles: 28 (0 duplicates)
js-yaml: loaded
- dsh-review  0.1.1  patch=strict  entry=ok
- dshmarket  1.73.3  patch=strict  entry=ok
- dsh-git-credentials  0.6.1  patch=strict  entry=ok
- @sandbaseai/dsh-skills  0.3.5  patch=tolerant (!!js stripped)  entry=ok
- ru-marketplace-mcp-dsh  2.6.0  patch=tolerant (!!js stripped)  entry=carrier(in-box only: ...)
- dsh-skill-browser  1.9.11  patch=strict  entry=ok
- dsh-serper-search  0.4.0  patch=strict  entry=ok
- dsh-scrape-webpage  1.0.0  patch=strict  entry=ok
- dsh-telegram-channel-ru  0.13.1  patch=strict  entry=ok
- superdesign-dsh  0.6.0  patch=strict  entry=ok
- dsh-vision-router  3.1.0  patch=tolerant (!!js stripped)  entry=ok
- dsh-delegate-router  0.4.5  patch=strict  entry=ok
inserted entry ids across community bundles: 16
RESULT: OK
```

Вывод: **битых/неразрешимых бандлов нет**, профиль стартует. Почти все проблемы ниже — не про загрузку, а про **незаданные ключи, отсутствующие внешние программы и невидимые в сессии инструменты**.

### Скилы — 8 групп, 274 файла `SKILL.md` на диске против 25 строк в каталоге сессии

| Вердикт | Группа | Файлов на диске | В каталоге сессии |
|---|---|---|---|
| ✅ работает | office (7 скилов, встроенные) | 7 | 7 |
| ✅ работает | dsh-badge (встроенный бандл) | 1 | 1 |
| ✅ работает | diagnose-windows-sandbox-acl (встроенный) | 1 | 1 |
| ⚠️ частично | ru-marketplace (`ru-marketplace-mcp-dsh`) | **15** | **14** (нет `aliexpress-connector`), инструменты не смонтированы |
| ⚠️ частично | superdesign | 1 | 1 (CLI и логин отсутствуют) |
| ⚠️ частично | adversarial-review (`dsh-review`) | 1 | 1 (скил грузится; линзы `review` не отрабатывают) |
| ❌ не работает | @sandbaseai/dsh-skills (marketing+research) | **246** | **0** |
| ❌ не работает | проектные скилы `dsh-marketing-skills` | 3 | 0 (плагин не установлен) |

**Итого:** работают 3 группы скилов, частично — 3, не работают — 2. Самая дорогая потеря: **246 из 246 скилов SandBase не попадают в каталог**, хотя лежат в `node_modules` и профиль считает бандл загруженным.

---

## 2. Методика проверки и оговорки

1. **Инвентаризация по факту:** `package.json` (`dsh.profile.bundles`, `dependencies`) сверялся с реальным содержимым `node_modules`, точками входа (`main`/`exports`), собственными `cordis.patch.yml` пакетов и парсом патч-слоя профиля (`_probe-inventory.mjs`, `_probe-pluginmeta.mjs`, `_probe-patch.mjs`).
2. **Функциональная проба** = реальный вызов инструмента в этой сессии и его фактический ответ. Если инструмент в сессии не виден — фиксируется «не проверено вживую» с причиной, а не «работает».
3. **Оговорка про конкурентные правки.** Параллельно другие исполнители правят русификацию: `node_modules\{dshmarket, dsh-vision-router, dsh-skill-browser, dsh-serper-search, dsh-git-credentials, dsh-scrape-webpage, dsh-locale-ru}` и `cordis.patch.yml`. По этим путям аудитор **не делал** выводов об «изменённости» и не включал их в свой хэш-манифест. Значения в `cordis.patch.yml` (в т.ч. `web-search-serper.takeOverProvider`) приводятся как «наблюдалось в момент аудита» и могут быть изменены другими исполнителями.
4. **Оговорка про кодировку.** Вывод `pwsh` отображает кириллицу как мусор (`РџР РђР’РР›Рђ`) — это дефект консоли, а не файлов: те же файлы через инструмент чтения выглядят корректно (проверено на `00-admin\config\settings.yaml`: UTF-8, читаемый текст). Выводы о содержимом делались только по чтению файлов, а не по печати в консоль.
5. **Ограничение роли:** аудитор — субагент, ему виден не весь набор инструментов главного агента. Там, где это меняет вердикт, это указано явно.

### Факт наличия ключей (значения не читались)

Хранилище DSH: `C:\Users\Артем\.dsh\.credentials.yaml` — разобрана только **структура**:

```
records: client-connection/browser-session, deepseek-account-platform/{device,default}
refs:    ZVENOAI_API_KEY  -> строка (len=46)
         DEEPSEEK_API_KEY -> строка (len=35)
```

Переменные окружения процесса (проверено `[Environment]::GetEnvironmentVariable($n,"Process")`):

```
SERPER_API_KEY            : NOT SET     RU_MARKETPLACE_MCP_DIR    : NOT SET
ZVENOAI_API_KEY           : NOT SET     RU_MARKETPLACE_MCP_FULL   : NOT SET
DEEPSEEK_API_KEY          : NOT SET     RU_MARKETPLACE_MCP_DECISION: NOT SET
MPSTATS_MP_AUTH           : NOT SET     DSH_TELEGRAM_TOKEN        : NOT SET
```

Вывод: единственные реально настроенные секреты — `ZVENOAI_API_KEY` и `DEEPSEEK_API_KEY` (в credential-хранилище, не в env — поэтому LLM-провайдер работает, а `pwsh` их не видит). **Serper, MPStats, Telegram, SandBase, RU Marketplace — без ключей.**

---

## 3. Таблица по плагинам

Колонки: установлен = есть каталог в `node_modules`; в загрузке = есть в `dsh.profile.bundles` (или вставлен патчем) и валидатор подтвердил entry; ключ = требуется/есть.

### 3.1 Встроенные бандлы `@deepseek-ai/*` (16)

| Объект | Установлен | В загрузке | Ключ | Функциональная проба (команда → вывод) | Вердикт | Что нужно |
|---|---|---|---|---|---|---|
| `@deepseek-ai/dsh-base` | в составе приложения (`app.asar`) | да | — | Ядро инструментов работает всю сессию: `read` (файл `package.json` прочитан, 55 строк), `write`/`edit` (созданы `_probe-*.mjs`), `grep`, `glob`, `pwsh` (десятки команд, exit 0) | ✅ работает | — |
| `@deepseek-ai/dsh-web-app` | в составе приложения | да | — | GUI отвечает по адресу из runtime-контекста; сессия/страница живые | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | в составе приложения | да | — | `list_agents` → 5 участников (lead, locale-core, market-ru, plugins-ru, auditor) со статусами; `team_task_get`/`team_task_update` → задача захвачена (revision 1→2) | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-tool-worktree` | в составе приложения | да | — | Инструмент `create_worktree` виден в сессии | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | в составе приложения | да | — | Инструменты `terminal_open/send/read/list/close/signal` видны в сессии | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-session-search` | в составе приложения | да | — | Инструменты `session_search`, `session_event_search/trace/read` видны в сессии | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-badge-skill-bundle` | в составе приложения | да | — | **Живая проба скила:** `skill({name:"dsh-badge"})` → вернул полный текст скила и base directory `...\app.asar\dsh\node_modules\@deepseek-ai\dsh-skill-badge\assets\` | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-ralph-bundle` | в составе приложения | да | — | Инструмент `ralph` виден в сессии | ✅ работает | — |
| `@deepseek-ai/dsh-experimental-auto-review` | в составе приложения | да | — | `review` отвечает, но линзы не отрабатывают (см. `dsh-review` ниже) — атрибуция инструмента между бандлом авто-ревью и пакетом `dsh-review` извне не различима | ⚠️ частично | Прогнать `review` на реальном diff; разобраться, почему линзы падают |
| `@deepseek-ai/dsh-experimental-plugin-market-bundle` | в составе приложения | да | — | Инструмент `plugin_market` в списке инструментов сессии отсутствует; UI-маркет работает (см. `dshmarket`) | ⚠️ частично | Проверять маркет с уровня главного агента |
| `@deepseek-ai/dsh-experimental-session-titles-bundle` | в составе приложения | да | — | Только UI-эффект (заголовки сессий), агентского инструмента нет | ⚠️ частично | Визуальная проверка в GUI |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | в составе приложения (+ `sherpa-onnx-win-x64` в `app.asar.unpacked`) | да | — | Модели распознавания реально скачаны: `C:\Users\Артем\.dsh\speech-to-text\sensevoice\models\{sensevoice-onnx,silero}`; агентского инструмента в сессии нет — это кнопка микрофона в UI | ⚠️ частично | Проверка голосом в GUI |
| `@deepseek-ai/dsh-experimental-inspector-profile` | в составе приложения | да | — | Ни инструмента, ни артефакта в сессии не обнаружено | ⚠️ частично | Уточнить ожидаемый эффект бандла |
| `@deepseek-ai/dsh-experimental-cot-translation-bundle` | в составе приложения | да | — | Влияет на отображение рассуждений в UI; в сессии не наблюдаемо | ⚠️ частично | Визуальная проверка в GUI |
| `@deepseek-ai/dsh-subagent-codex` | ✅ `node_modules\@deepseek-ai\dsh-subagent-codex` 0.2.1-rc.3 | да (`entry=ok`, свой patch вставляет `tool-subagent-codex`, `provider: codex`, `toolName: subagent_codex`) | — | `Get-Command codex` → **MISSING**; инструмента `subagent_codex` в сессии нет | ❌ не работает | Установить Codex CLI или отключить бандл |
| `@deepseek-ai/dsh-subagent-claude-code` | ✅ 0.2.1-rc.3 | да (`entry=ok`) | — | `Get-Command claude` / `claude-code` → **MISSING** | ❌ не работает | Установить Claude Code CLI или отключить бандл |

### 3.2 Установленные пакеты (14)

| Объект | Установлен | В загрузке | Ключ | Функциональная проба (команда → вывод) | Вердикт | Что нужно |
|---|---|---|---|---|---|---|
| `dsh-scrape-webpage` 1.0.0 | ✅ | да, `patch=strict entry=ok` | не требует | `scrape_webpage({url:"https://example.com"})` → **«网页抓取成功… HTTP 200, 779 символов, 125 слов»**, вернул текст и ключевые слова | ✅ работает | — |
| `dsh-locale-ru` 1.0.0 | ✅ (`node_modules\dsh-locale-ru`, `file:.plugin-sources/dsh-locale-ru`) | **не в `bundles`**, вставлен патчем (`- id: locale-ru`), плюс `@deepseek-ai/dsh-client-locale config.preference: ru` | не требует | Патч-слой профиля содержит вставку `locale-ru`; профиль стартует (валидатор `RESULT: OK`) | ✅ работает (в части интерфейса) | Дочистить остатки непереведённого UI |
| `dsh-serper-search` 0.4.0 | ✅ | да, `patch=strict entry=ok` | **`SERPER_API_KEY` — НЕТ** | `web_search(["аудит плагинов DSH"])` → результаты **есть**, но с явной пометкой: **«Note: serper auth failed, using deepseek.»** То есть плагин подключён к поиску, но без ключа молча уходит на встроенный DeepSeek | ⚠️ частично | Задать `SERPER_API_KEY` (через `SERPER_API_KEY` или Настройки → Plugins). Иначе агент не знает о деградации поиска |
| `dsh-git-credentials` 0.6.1 | ✅ | да, `patch=strict entry=ok` | ключи Git-хостов — **НЕТ** | `github_repos({action:"list", ...})` → **«Error: git-credentials: no github site configured; add one in Settings → Git 凭据»**. Инструмент виден и отвечает, но ни один хост не настроен | ⚠️ частично | Настроить сайты в Настройках → Git 凭据 |
| `dsh-review` 0.1.1 | ✅ | да, `patch=strict entry=ok` | не требует | Два прогона `review(depth:"quick")`: **(1)** «No confirmed defects… **Lenses that failed to run (coverage gap, NOT a clean result): correctness, lifecycle**»; **(2)** с одним лонзом — «…**coverage gap: correctness**». Инструмент отвечает, но линзы не выполняются | ⚠️ частично | Разобраться, почему не стартуют линзы (модель/права/спавн детей). Пока отчёт ревью не является доказательством качества кода |
| `dsh-vision-router` 3.1.0 | ✅ (зависимости `puppeteer-core`, `potrace`, `undici`, `zod` на месте) | да, `patch=tolerant (!!js stripped) entry=ok` | не требует ключа напрямую (нужна модель с image input) | `read_image("...\dashboard\screenshots\01-overview.png")` → **«Error: cannot read … as an image: model "deepseek/deepseek-v4.1-flash" does not declare image input; switch to an image-capable model»**. Плагин грузится: `C:\Users\Артем\.dsh\logs\vision-router\vision-router.log` → «diagnostics log enabled (plugin=3.1.0 …)», «base config summary — contract=batch-attachments … localOllama=off localLmStudio=off». Инструмент `vision_screenshot` объявлен в коде (`lib\desktop-screenshot-tool.js:197`), но в сессии не виден; OCR-путь (`tesseract-exec-compat.js`) бесполезен: `Get-Command tesseract` → **MISSING** | ⚠️ частично | 1) Переключить сессию на модель с image input (`google/gemini-3.1-flash-image` и т.п.), 2) поставить tesseract, 3) выяснить, почему `vision_screenshot` не публикуется |
| `ru-marketplace-mcp-dsh` 2.6.0 | ✅ (`file:.plugin-sources\ru-marketplace-mcp-dsh`) | да, `patch=tolerant (!!js stripped) entry=carrier(in-box only)` | **`RU_MARKETPLACE_MCP_DIR` — НЕТ**, `MPSTATS_MP_AUTH` — НЕТ | Скилы: 15 каталогов на диске, в каталоге сессии — **14**; `skill({name:"aliexpress-connector"})` → **«Error: skill "aliexpress-connector" is unknown or no longer available»**. Инструментов маркетплейсов (`wb_*`, `ozon_*`, `compare_prices`, `marketplace_sources`) в сессии **нет** — это ожидаемо: по `cordis.patch.yml` пакета все MCP-строки `disabled` без env, а в `README.md` прямо: «The 15 skills appear immediately. **No MCP server starts yet**», «No MCP process survives profile restart without `RU_MARKETPLACE_MCP_DIR`». Дополнительно `Get-Command uv` → **MISSING**, а MCP-строки запускаются командой `uv run --frozen …` | ⚠️ частично | 1) Поставить `uv`, 2) склонировать сервер, 3) задать `RU_MARKETPLACE_MCP_DIR` (+ при необходимости `RU_MARKETPLACE_MCP_DECISION/FULL`), 4) перезапуск профиля (не в этой сессии). 5) Отдельно разобрать, почему пропал `aliexpress-connector` |
| `@sandbaseai/dsh-skills` 0.3.5 | ✅ (246 `SKILL.md`) | да, `patch=tolerant (!!js stripped) entry=ok` | по README пакета — `SANDBASE_API_KEY`; **НЕТ** | Подсчёт: `marketing` = 162 SKILL.md, `research` = 83, `agent-plugin` = 1 → **246 файлов**. В каталоге сессии — **0** из них. Собственный патч пакета (`dsh\cordis.patch.yml`) вставляет `customSkillDirs` на `../marketing/` и `../research/` через `!!js` | ❌ не работает | Разобрать, почему провайдер `skill-filesystem` из этого патча не отдаёт каталог (гипотезы: подмена строки с тем же `id: skill-filesystem`, что у базового провайдера; отказ вычисления `!!js`-выражений; фильтр каталога). Проверять на уровне загрузчика DSH |
| `dsh-skill-browser` 1.9.11 | ✅ | да, `patch=strict entry=ok`, `dsh.client.inject` — UI-плагин | не требует | `C:\Users\Артем\.dsh\data\dsh-skill-browser\diag.log` → две записи за 2026-10-31 16:30–16:32 `{"view":"settings-section-render", … "propsKeys":[…"renderFactorySlot","close"]}` — панель реально рендерится в web-клиенте. Агентского инструмента в сессии нет (продукт — панель UI) | ⚠️ частично | Визуальная проверка панели в GUI |
| `dshmarket` 1.73.3 | ✅ | да, `patch=strict entry=ok`, `dsh.client` — UI | не требует | Кэш маркета реально наполнен: `.dsh-market\discovery-compatibility-v1.json` — **1 238 027 байт**, `discovery-github-compatibility-v1.json` — **1 067 107 байт**, оба обновлены 31.10.2026 19:33; `state.json` = `{"disabled":[],"groups":{},"region":"global","regionAuto":true}`. Инструмент `plugin_market` в сессии не виден | ⚠️ частично | Проверять установку/поиск плагинов с уровня главного агента |
| `dsh-telegram-channel-ru` 0.13.1 | ✅ | да, `patch=strict entry=ok`, `dsh.client` — UI-вкладка | **`DSH_TELEGRAM_TOKEN` — НЕТ** | README пакета: «`token` / `DSH_TELEGRAM_TOKEN` — токен бота», «…without it polling never starts»; в credential-хранилище токена нет, в env — `NOT SET`; агентского инструмента в сессии нет | ❌ не работает | Задать токен бота (Настройки → Telegram или `DSH_TELEGRAM_TOKEN`) |
| `superdesign-dsh` 0.6.0 | ✅ | да, `patch=strict entry=ok` | вход в аккаунт Superdesign | Скил `superdesign` в каталоге есть; собственный `dsh\cordis.patch.yml` пишет: «**no MCP server, no tools**, nothing to configure at install time. The skill itself walks the user through `superdesign login` on first use». `Get-Command superdesign` → **MISSING**; продукт работает через `npx --yes @superdesign/cli@latest` — без сети/логина не работает | ⚠️ частично | `superdesign login` при первом использовании; проверить сеть/npx |
| `dsh-delegate-router` 0.4.5 | ✅ | да, `patch=strict entry=ok` | не требует | Конфигурация сохранена и непустая: `C:\Users\Артем\.dsh\dsh-delegate-router.json` = `{"flashModel":"z-ai/glm-5.3-flash","proModel":"openai/gpt-6-luna"}`. Дефолты патча — `mode: auto`, пустые модели, значит маршрутизация настроена через UI. Инструмент `subagent_router` в списке инструментов сессии **отсутствует** | ⚠️ частично | Проверить маршрутизацию с уровня главного агента + живой делегированием |
| `dsh-marketing-skills` (проектный, `marketing-agents\plugin`) | ❌ (нет `node_modules\dsh-marketing-skills`, нет строки в `dependencies`/`bundles`) | нет | — | `node_modules` не содержит пакета; в каталоге сессии нет ни `competitor-watch`, ни `direct-keywords`, ни `newbuild-ru-glossary`; `README-market-plugins.md:190` подтверждает: «На момент 2026-10-30 22:47 в профиле **нет** `node_modules\dsh-marketing-skills` и **нет** строки `id: marketing-skills` в `cordis.patch.yml`» | ❌ не работает | `install-marketing-plugin.ps1` + перезапуск профиля |

### 3.3 Патч-слой профиля

`cordis.patch.yml` содержит **10 строк**, все парсятся (собственный пробник `_probe-patch.mjs`, секреты маскируются):

```
TOTAL PATCH ENTRIES: 10
@deepseek-ai/dsh-client-ui-settings-account, @deepseek-ai/dsh-client-ui-chat,
@deepseek-ai/dsh-client-ui-settings, @deepseek-ai/dsh-llm-pi-ai (configKeys=[providers]),
@deepseek-ai/dsh-web (configKeys=[searchProvider, fetchProvider]), dsh-serper-search,
dsh-vision-router, @deepseek-ai/dsh-agent-default-model,
dsh-locale-ru (insert), @deepseek-ai/dsh-client-locale (preference: ru)
```

Наблюдения:

* `@deepseek-ai/dsh-web`: `searchProvider: serper`, `fetchProvider: deepseek-fetch-api`.
* `dsh-serper-search`: `takeOverProvider` — **наблюдалось `false`**, тогда как шапка того же файла декларирует «3. web-search-serper.takeOverProvider: false → true (Serper реально используется)». **Расхождение шапки и тела файла** (и напоминание: файл правится другими исполнителями).
* `@deepseek-ai/dsh-agent-default-model`: `provider: zvenoai`, `model: deepseek/deepseek-v4.1-flash` — это и есть причина отказа `read_image` (модель без image input).
* Собственные `cordis.patch.yml` пакетов: у 8 пакетов — тривиальный `- insert: [- id …]`, у трёх (`@sandbaseai/dsh-skills`, `ru-marketplace-mcp-dsh`, `dsh-vision-router`) применяется тег `!!js`; **строгий `js-yaml` на них падает** (`unknown tag !<tag:yaml.org,2002:js>`), их читает только терпимый загрузчик DSH.

---

## 4. Скилы

### 4.1 Полный каталог сессии (25 строк) и происхождение

| # | Скил | Провайдер | Вердикт |
|---|---|---|---|
| 1 | adversarial-review | `dsh-review` | ⚠️ грузится, но `review`-линзы не отрабатывают |
| 2 | superdesign | `superdesign-dsh` | ⚠️ нужен CLI + `login` |
| 3 | diagnose-windows-sandbox-acl | встроенный | ✅ работает |
| 4 | dsh-badge | встроенный бандл | ✅ проверен живой загрузкой |
| 5–11 | office, office-docx, office-export-pdf, office-pptx, office-recalculate, office-render, office-xlsx | встроенные (`resources\runtime\office-skills`) | ✅ работают; инструментарий на месте: `libreoffice-kit.exe` распакован, Python 3.12.14 c `openpyxl 3.1.5`, `pandas 3.0.1`, `Pillow 12.3.0`, `python-docx 1.2.0`, `python-pptx 1.0.2`, `XlsxWriter 3.2.9` |
| 12–25 | avito, cian, citilink, compare-prices, detmir, dns, lamoda, marketplace, megamarket, mpstats, ozon, taobao, wb, yandex | `ru-marketplace-mcp-dsh` | ⚠️ документы доступны, **инструменты не смонтированы** |

Живая проверка механизма скилов: `skill({name:"dsh-badge"})` → успешно; `skill({name:"aliexpress-connector"})` → ошибка (см. ниже).

### 4.2 Скилы, которые есть в файлах, но не видны в каталоге

| Скил / группа | Файл | Факт | Почему, насколько удалось установить |
|---|---|---|---|
| `aliexpress-connector` | `node_modules\ru-marketplace-mcp-dsh\skills\aliexpress-connector\SKILL.md` (5112 б) | Файл валиден: UTF-8 без BOM, `fatal`-декодер ошибок не дал, frontmatter закрыт, ключи строго `[name, description]` — как у остальных 14. Тем не менее `skill("aliexpress-connector")` → «unknown or no longer available» | **Причина не установлена.** Ожидание проекта (`README-market-plugins.md:179`) прямо требует 15 скилов `ru-marketplace`, включая `aliexpress`. Требуется разбор на уровне провайдера скилов |
| Скилы SandBase (162 marketing + 83 research + 1 agent-plugin) | `node_modules\@sandbaseai\dsh-skills\...` | **246 файлов `SKILL.md`** и **0 строк** в каталоге | Гипотезы (не доказаны): подмена строки с тем же `id: skill-filesystem`, что у базового провайдера; молчаливый отказ `!!js`-выражений в `customSkillDirs`; фильтр каталога |
| `competitor-watch`, `direct-keywords`, `newbuild-ru-glossary` | `marketing-agents\skills\**` и `marketing-agents\plugin\skills\**` | Файлы есть, в каталоге нет | Плагин `dsh-marketing-skills` не установлен в профиль |

### 4.3 Обратный случай (в каталоге есть, в файлах не нашлось)

Не обнаружено: все 25 строк каталога имеют файловый источник (`app.asar` / `resources\runtime\office-skills` / `node_modules`) либо соответствуют `SKILL.md` соответствующего пакета.

### 4.4 Разделение «по настройке»

* **Работают без настройки:** `office*` (7), `dsh-badge`, `diagnose-windows-sandbox-acl`, `adversarial-review` (как текст).
* **Требуют авторизации/ключа:** `superdesign` (аккаунт Superdesign, `superdesign login`), `mpstats-connector` (**`MPSTATS_MP_AUTH`**), прочие `*-connector` (нужен **управляемый Chrome по CDP** — Chrome установлен: `C:\Program Files\Google\Chrome\Application\chrome.exe`), `aliexpress-connector` (только CDP, без анонимного уровня).
* **Недоступны:** 246 скилов SandBase, 3 проектных скила, `aliexpress-connector`.
* **Доступны как текст, но без инструментов:** 14 `ru-marketplace`-скилов — их инструменты (`wb_*`, `ozon_*`, `compare_prices`, `marketplace_sources`) не смонтированы, потому что MCP-серверы выключены без `RU_MARKETPLACE_MCP_DIR`, а `uv` в системе отсутствует.

---

## 5. Пробелы возможностей: чего не хватает, чтобы работать «как человек»

Приоритеты: **P0** — блокирует уже заявленные бизнес-сценарии (мониторинг конкурентов, сравнение цен); **P1** — блокирует расширение; **P2** — удобство.

### P0

| # | Пробел | Чем доказан | Что нужно |
|---|---|---|---|
| 1 | **Агент не может «видеть»: чтение изображений и скриншотов недоступно** | `read_image(...01-overview.png)` → «model `deepseek/deepseek-v4.1-flash` does not declare image input». `vision_screenshot` в сессии не виден. `tesseract` не установлен → OCR-путь мёртв. `localOllama=off`, `localLmStudio=off` в логе vision-router | Дать модели с image-input в маршрут vision-router (в каталоге провайдера есть `google/gemini-3.1-flash-image`, `openai/gpt-6-luna`, `anthropic/claude-opus-5.5`); поставить tesseract; выяснить, почему `vision_screenshot` не публикуется. **Без этого агент не читает ни картинки с ценами, ни скриншоты объявлений** |
| 2 | **Инструменты маркетплейсов не подключены** — 14 скилов бесполезны как инструкции | Инструментов `wb_*`, `ozon_*`, `compare_prices`, `marketplace_sources` в сессии нет; `cordis.patch.yml` пакета: все MCP-строки `disabled: !!js "!process.env.RU_MARKETPLACE_MCP_DIR …"`; `RU_MARKETPLACE_MCP_DIR` NOT SET | Поставить `uv`, склонировать `ru-marketplace-mcp`, задать `RU_MARKETPLACE_MCP_DIR` (и `…_DECISION`/`…_FULL` по вкусу), перезапустить профиль |
| 3 | **Поиск в интернете деградировал молча** | `web_search` → «Note: **serper auth failed, using deepseek**» | Задать `SERPER_API_KEY`. Дополнительно стоит добиться, чтобы деградация была видна агенту в явном виде, а не тонула в примечании |

### P1

| # | Пробел | Чем доказан | Что нужно |
|---|---|---|---|
| 4 | **Нет управляемого браузера (клики, ввод, навигация)** — все `*-connector` без него не работают | Скилы прямо требуют «the operator's Chrome over CDP»; Chrome **есть** (`C:\Program Files\Google\Chrome\Application\chrome.exe`), но инструмента управления браузером в сессии нет; `puppeteer-core` и `chromium-bidi` лежат в `node_modules` (транзитивно, через vision-router) | Инструмент «браузер по CDP»: открыть страницу, кликнуть, ввести текст, снять DOM/скриншот, решить капчу с показом оператору |
| 5 | **Нет управления рабочим столом** (мышь/клавиатура/экран) | Единственный намёк — `vision_screenshot` в `dsh-vision-router`, и тот не виден в сессии; инструментов `click`/`type`/`screenshot`/`ocr` нет | Набор desktop-инструментов + OCR: снимок экрана, клик по координатам, ввод текста, ожидание окна |
| 6 | **Нет работы с почтой** и нет мессенджеров, кроме неработающего Telegram | Инструментов SMTP/IMAP нет вовсе; `dsh-telegram-channel-ru` без токена | IMAP/SMTP-инструмент (отправка/чтение писем), плюс токен Telegram |
| 7 | **Git-хосты не настроены** — нельзя читать репозитории | `github_repos(...)` → «no github site configured» | Настроить сайты в Настройках → Git 凭据 (токены) |
| 8 | **`SANDBASE_API_KEY` отсутствует**, и по факту не работает даже файловая часть | Env NOT SET; 0 из 246 скилов в каталоге | Ключ + разбор провайдера скилов |

### P2

| # | Пробел | Чем доказан | Что нужно |
|---|---|---|---|
| 9 | **Загрузка файлов из интернета** — есть разбор страницы, нет «скачать файл по ссылке» | `scrape_webpage` умеет `images>0` (скачивает картинки в `.scrape-images`), но общего «download URL → файл» нет | Явный инструмент загрузки файлов (pdf/xlsx/zip) с проверкой типа и размера |
| 10 | **Нет PDF-инструмента и локального OCR** | Office-скилы покрывают docx/xlsx/pptx, PDF — только экспорт; `tesseract` отсутствует | PDF-конвертер/парсер + tesseract |
| 11 | **Голосовой ввод недоступен агенту** | Модели `sensevoice-onnx`/`silero` скачаны, инструмента нет | Оставить как UI-функцию либо дать инструмент транскрипции |
| 12 | **`review` не даёт покрытия** | Два прогона: «Lenses that failed to run (coverage gap)» | Починить запуск линз — иначе автопроверка кода не работает |
| 13 | **Скилы невидимы без внешней диагностики**: нет способа из агента понять, почему скил не в каталоге | Расхождение «246 на диске / 0 в каталоге» и «15 на диске / 14 в каталоге» обнаружены только ручным подсчётом | Инструмент самодиагностики каталога скилов (что отдал каждый провайдер и почему пропустил) |

---

## 6. Доказательство, что аудитор ничего не изменил

**1. Хэш-манифест до/после по нетронутым путям.** Область: `marketing-agents\registry\**`, `marketing-agents\00-admin\config\**`, `node_modules\@sandbaseai\**`, `node_modules\dsh-review\**`, `node_modules\superdesign-dsh\**`, `node_modules\ru-marketplace-mcp-dsh\**`, `node_modules\dsh-telegram-channel-ru\**`, `.plugin-sources\dsh-locale-ru\**`, `.plugin-sources\ru-marketplace-mcp-dsh\**` — **1218 файлов**, SHA-256 каждого.

```
> node marketing-agents\audit\_probe-diff.mjs _manifest-before.json _manifest-after.json
BEFORE files=1218  AFTER files=1218
ADDED=0 REMOVED=0 CHANGED=0
```

Дополнительно сами файлы манифестов **побайтово идентичны**:

```
_manifest-before.json  404274 bytes  sha256=FA1ACF68BC02660B…
_manifest-after.json   404274 bytes  sha256=FA1ACF68BC02660B…
```

Окно между снимками: `2026-10-31T20:14:53+03:00` → `2026-10-31T20:19:33+03:00`.

**1б. Третий снимок — уже после написания отчёта** (`_manifest-final.json`, `2026-10-31T20:20:42+03:00`), тот же diff:

```
BEFORE files=1218  AFTER files=1218
ADDED=0 REMOVED=0 CHANGED=0
```

Итог: за всё время аудита (20:14:53 → 20:20:42) в 1218 отслеживаемых файлах — **ни одного добавления, удаления или изменения**. Проверка «что вообще менялось в рабочем каталоге за последние 15 минут» показала только мои файлы в `marketing-agents\audit\**` и файлы других исполнителей в `.dsh-dump\**` / `.localizer\**`.

**2. Что было исключено из манифеста и почему.** Правки других исполнителей по русификации идут по путям `node_modules\{dshmarket, dsh-vision-router, dsh-skill-browser, dsh-serper-search, dsh-git-credentials, dsh-scrape-webpage, dsh-locale-ru}` и `cordis.patch.yml`. Эти пути в манифест **не входили**, поэтому любые изменения там не относятся к аудитору — и наоборот, аудитор по ним не делает вывода об «изменённости».

**3. Что аудитор реально писал на диск** (всё — внутри `marketing-agents\audit\**`, как разрешено):

```
_manifest-before.json, _manifest-after.json   — снимки хэшей
_probe-inventory.mjs, _probe-patch.mjs, _probe-pluginmeta.mjs, _probe-diff.mjs — измерительные скрипты
_office-probe.xlsx                            — побочный файл пробы Office-цепочки
plugin-audit.md                               — этот отчёт
```

**4. Запреты соблюдены:** DSH не перезапускался; `pnpm install`, `dsh plugin add/remove/install` и любые установки не выполнялись; в профиль (`package.json`, `cordis.patch.yml`, `node_modules`, `compatibility.json`) не вносилось ни одного изменения; секреты не читались и не печатались — только факт наличия и длина строки.

**5. Ограничение достоверности.** Два вердикта вынесены без живой пробы и помечены как таковые: `dsh-delegate-router` (инструмент `subagent_router` не виден в сессии субагента) и UI-часть `dshmarket`/`dsh-skill-browser`/`telegram` (проверяемо только из GUI главного агента). Причина отсутствия `aliexpress-connector` в каталоге и провал 246 скилов SandBase — **не установлены**, приведены только гипотезы; для их закрытия нужен разбор загрузчика скилов DSH.
