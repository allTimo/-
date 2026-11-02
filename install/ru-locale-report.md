# Отчёт исполнителя: R1 (T34 + T28A) — языковой пакет ru-locale

Дата: 31.10.2026. Исполнитель: teammate `locale-core`. Задача: `task-1`.
Статус: **закрыто**, кроме фактического перезапуска DSH (запрещён условиями задачи).

Проверочные команды и их фактический вывод — ниже, дословно.

## 1. Что сделано

### 1.1 Правило для не-строковых источников (обосновано кодом)

В corpus ровно **10** не-строковых источников: 8 `settings.agentPreset.guide*` и 2 `conversation` (`hint.plan`, `placeholder.plan`). Все они в поставке вычисляются в **строку**, поэтому переводимы.

Доказательства из `C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
(`node .localizer\scan-asar.js` + `node .localizer\dump-asar.js`):

* смещение 23424280: английский словарь `settings.agentPreset` —
  `guideStandardExplanation: ["### How it works", …,].join("\n\n")` → в рантайме строка;
* смещение 25032150: `const PLAN_NEXT_ACTION_EN = "describe your task to generate plan";`,
  а в словаре `conversation` — `"hint.plan": PLAN_NEXT_ACTION_EN` и `"placeholder.plan": PLAN_NEXT_ACTION_EN`.
  Это обычный пользовательский текст, **не** служебный маркер: значение подставляется в подсказку и в placeholder;
* смещение 25198100: InputBar —
  `const translated = t(hintKey); return translated !== hintKey ? translated : rawHint;`
  — сравнение с самим ключом возможно только для строки;
* смещение 23467000: карта `guides` сопоставляет пресетам `intro` / `explanation` / `usage`, значения рендерятся как Markdown.

Вывод: в `*.ru.txt` для таких ключей нужна **готовая строка** (переносы — экранированные `\n`), а не обёртка `{"__raw": …}`.

### 1.2 Инструменты

* `tools/validate-translations.js`: `__raw`-источники стали переводимым текстом; значение `{"__raw": …}` в `*.ru.txt` → `PROBLEM`; добавлен разбор `tools/identical-allowlist.txt`; снят лимит в 60 предупреждений; выводится полный список допустимых совпадений (`same-ok … — причина`).
* `tools/build-plugin.js`: убран `continue` для не-строк; значение обязано быть `string`, без обёртки `__raw`, непустым для непустого источника.
* `tools/identical-allowlist.txt` (новый): 55 допустимых совпадений с обоснованием.
  Категории: разделители списка — 11; имена продуктов/протоколов — 14; URL — 5; плейсхолдеры с единицами измерения — 7; шаблоны из плейсхолдеров и пунктуации — 16; имя планировщика «Cron» — 2.
* `tools/.verify-pack.js` (новый, только чтение): приёмка бандла по corpus.

### 1.3 Текст

* `translations/settings.agentPreset.ru.txt` — 8 guide-значений переписаны в готовый Markdown: убран CJK («обрабатывать файлы批量» → «файлы пакетами»), исправлены артефакты («неудобные файлы» → «нечитаемые файлы», «с ссылками» → «со ссылками», «сравните»-кальки, согласование), сохранены `###`, цитаты `>` и разделители блоков `\n\n`. Имена standard/ptc/minimal/cordis и `run_code`, `read_image`, `SDK`, `configs/`, `schema.json`, `logs/` не переводились.
* `translations/conversation.ru.txt` — `hint.plan` и `placeholder.plan`: `ПЛАН_СЛЕДУЮЩЕГО_ДЕЙСТВИЯ` → `опишите задачу, чтобы создать план` (в английском оба ключа — одна и та же константа, поэтому и в ru одно значение; регистр согласован с соседним `hint.goal`).
* `translations/chat.ru.txt` — `message.retry.status`: `{seconds}s` → `{seconds} с`.
* `translations/settings.models.ru.txt` — `deepSeekAccount`: `DeepSeek Account` → `Аккаунт DeepSeek`.
* `translations/cordis.ru.txt` — `a11y.preparing` переставлен на 2-ю строку: порядок ключей совпал с `en.json` (единственное оставшееся предупреждение валидатора).

## 2. Приёмка: команды и вывод

### 2.1 Валидатор

```powershell
$node = "C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
Set-Location "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale"
& $node tools\validate-translations.js
```

```
namespaces: 59  files: 59  keys: 2682 (из них raw-источников: 10)
problems: 0  warnings: 0  identical-to-en: 0 требуют перевода + 55 допустимых
--- identical-to-en, допустимые совпадения (tools/identical-allowlist.txt) ---
same-ok  chat: "message.stepProcess.comma" — разделитель списка — пунктуация, одинакова в ru и en
… (всего 55 строк)
```

Было (до правок): `problems: 0  warnings: 68  identical-to-en: 57`, в том числе 10 × «не строковый источник». Стало: `warnings: 0`, «не строковый источник» — 0.

### 2.2 Сборка

```powershell
& $node tools\build-plugin.js
```

```
built dsh-locale-ru: 59 namespaces, 2682 keys, lib/client.js 227.8 KiB
```

### 2.3 Бандл: собранный и установленный

```powershell
& $node tools\.verify-pack.js "plugin\lib\client.js"
& $node tools\.verify-pack.js "C:\Users\Артем\.dsh\profiles\desktop\node_modules\dsh-locale-ru\lib\client.js"
```

Оба раза дословно:

```
namespaces: 59  keys: 2682  missing: 0  non-string: 0
empty-for-non-empty-source: 0  raw-wrappers: 0  CJK: 0
--- agent-preset guide keys ---
OK   settings.agentPreset.guideStandardExplanation: 492 символов, блоков 4
OK   settings.agentPreset.guideStandardUsage: 531 символов, блоков 6
OK   settings.agentPreset.guidePtcExplanation: 1030 символов, блоков 6
OK   settings.agentPreset.guidePtcUsage: 856 символов, блоков 6
OK   settings.agentPreset.guideMinimalExplanation: 703 символов, блоков 4
OK   settings.agentPreset.guideMinimalUsage: 453 символов, блоков 3
OK   settings.agentPreset.guideCordisExplanation: 949 символов, блоков 6
OK   settings.agentPreset.guideCordisUsage: 1188 символов, блоков 9
--- plan hint keys ---
OK   conversation.hint.plan = "опишите задачу, чтобы создать план"
OK   conversation.placeholder.plan = "опишите задачу, чтобы создать план"
RESULT: OK (нарушений: 0)
```

`missing: 0` закрывает и п.4 задания (ключи corpus, отсутствующие в собранном словаре) — таких нет.

Собранный и установленный бандл побитово совпадают:

```
plugin\lib\client.js                                  SHA256 D4ADA3BA7316E3265B38C0BF3FA7FB81467D9F9ED114C917B930CAF87042DA5F
node_modules\dsh-locale-ru\lib\client.js              SHA256 D4ADA3BA7316E3265B38C0BF3FA7FB81467D9F9ED114C917B930CAF87042DA5F
```

До/после по 8 ключам (поиск подстроки в бандле):

```
plugin/lib/client.js.bak-20261031-201807 → guide keys present: 0/8
plugin/lib/client.js                     → guide keys present: 8/8
node_modules/dsh-locale-ru/lib/client.js → guide keys present: 8/8
```

CJK во всех `translations/*.ru.txt`: **0 строк** (было 1 — `settings.agentPreset.ru.txt:9`).

Синтаксис: `node --check` для собранного и установленного `client.js` → exit 0.

### 2.4 Установка

```powershell
powershell -ExecutionPolicy Bypass -File install\apply-ru-locale.ps1 `
  -PluginSource "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\plugin"
```

```
==> installing dsh-locale-ru -> C:\Users\Артем\.dsh\profiles\desktop\node_modules\dsh-locale-ru
==> roster row already present — left as is
==> locale preference already "ru" — left as is
==> patch file already up to date — nothing written
```

`cordis.patch.yml` не менялся: строка ростера и `preference: ru` уже были на месте, поэтому установщик новых бэкапов не писал.

### 2.5 Профиль

```powershell
(Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern '^\s*-?\s*id:\s*locale-ru\s*$').Count
```

```
1
```

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern 'preference:'
```

```
1160: preference: ru
```

js-yaml (strict, из профиля):

```
js-yaml strict parse OK; top-level type: array
occurrences of locale-ru in parsed doc: 1
locale entry: [ { "id": "locale", "name": "@deepseek-ai/dsh-client-locale", "config": { "preference": "ru" } } ]
```

### 2.6 Бандлы профиля

```powershell
Set-Location "C:\Users\Артем\Desktop\тестDH"
& $node marketing-agents\install\check-profile-bundles.mjs "C:\Users\Артем\.dsh\profiles\desktop"
```

```
package.json: parses OK
bundles: 28 (0 duplicates)
js-yaml: loaded
… (по каждой строке patch=strict|tolerant, entry=ok)
inserted entry ids across community bundles: 16

RESULT: OK
```

## 3. Осталось / не сделано

* **Перезапуск DSH не выполнялся** — прямо запрещён условиями задачи (убьёт сессию и GUI). До перезапуска страница «Предустановки агента» останется китайской: запущенный клиент держит старый бандл.
* `apply-ru-locale.ps1 -Revert` выбирает бэкап `cordis.patch.yml` сортировкой по имени, поэтому может взять `.bak-reset-…` вместо последнего по времени. Скрипт не правил (общий артефакт, вне задачи); в откат-команде это учтено.
* Оставшиеся 55 совпадений с английским не переводились осознанно — обоснование по каждому в `tools/identical-allowlist.txt`.

## 4. Бэкапы

Все — `*.bak-<timestamp>`, не удаляются.

| Файл | Бэкап |
| --- | --- |
| `tools/validate-translations.js` | `.bak-20261031-201807` |
| `tools/build-plugin.js` | `.bak-20261031-201807` |
| `translations/settings.agentPreset.ru.txt` | `.bak-20261031-201807` |
| `translations/conversation.ru.txt` | `.bak-20261031-201807` |
| `translations/cordis.ru.txt` | `.bak-20261031-202019` |
| `translations/chat.ru.txt` | `.bak-20261031-202019` (восстановленный: снят бэкап уже после правки одной строки, исходная строка возвращена, содержимое сверено) |
| `translations/settings.models.ru.txt` | `.bak-20261031-202019` (там же, восстановленный) |
| `plugin/lib/client.js` | `.bak-20261031-201807` |
| профиль: `node_modules/dsh-locale-ru/lib/client.js` | `.bak-20261031-201807` |
| профиль: `cordis.patch.yml` | `.bak-20261031-201807` (файл установщиком не менялся) |

Откат одной командой — в `README-ui-ru-locale-pipeline.md`, раздел «Как откатить».

## 5. Артефакты

* `marketing-agents\install\README-ui-ru-locale-pipeline.md` — что изменено, правило `__raw`, команды перепроверки, откат, что слетит при обновлении DSH.
* `ru-locale\tools\identical-allowlist.txt` — обоснование 55 совпадений.
* `ru-locale\tools\.verify-pack.js` — приёмка бандла.
* Временные скрипты (`$env:TEMP`) и одноразовый `tools\.fix-guides.js` удалены; в `ru-locale` мусора не осталось.
