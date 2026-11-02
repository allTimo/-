# Русификация интерфейсов плагинов профиля DSH — README-ui-ru-plugins

Задача: **task-3 (R3, T28B+C)**, включая добор по «третьей полосе» (revision 7). Исполнитель: teammate `plugins-ru`. Дата: 31.10.2026.
Профиль: `C:\Users\Артем\.dsh\profiles\desktop\node_modules\`.
Node: `C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`.

## 1. Подход

1. **Реестры локалей (3 плагина).** У `dsh-vision-router`, `dsh-serper-search`, `dsh-git-credentials` есть `ctx.locale.register(NS, { zh, en })`. Китайские литералы внутри словаря `zh` — источник китайской локали, их удалять нельзя. Добавлен словарь **`ru` с тем же набором ключей, что у `en`**, и регистрация `{ zh, en, ru }`. До правки при локали `ru` эти строки показывались по-английски (цепочка ru → en).
2. **Литералы без реестра.** `dsh-scrape-webpage` — пользовательские сообщения переведены на русский напрямую (реестра нет).
3. **«Третья полоса» (добор).** В prelude-модулях vision-router пользовательские подписи заданы билингвальными парами `tx('中文','English')` / `text(...)` / `['中文','English']`, а выбор идёт через `zh()` — то есть при `ru` пользователь видел **английский**. Добавлена русская ветка: словарь `RU_TEXT` (ключ — английская строка) + `ruLang()`/`ruText()`/`pairText()`/`pick()`, а сами хелперы `tx`/`text` переведены на трёхполосный выбор. **Вызовы не менялись**, поведение zh/en/ja сохранено.
4. **Легаси-текст в boundary.** `runtime-i18n-boundary.js` переводит старые китайские тексты плагина на активный язык; для `ru` добавлена русская постобработка (`RU_LEGACY_TEXT` + `translateLegacyTextToRussian`), плюс закрыты guard-тексты лимитов и метка структурированного предраспознавания.

Соблюдено: бэкап каждого правленого файла `*.bak-ru-<timestamp>` до правки (28 шт., не удалялись; чужие бэкапы `dsh-skill-browser` не тронуты), `node --check` после каждого файла, плейсхолдеры и `${}`-подстановки сохранены, без regex-массовых замен — только пофайловые правки с проверкой точных строк.

## 2. Таблица «модуль/плагин → было → стало → проверка»

### 2.1 Реестры локалей

| Плагин / файл | Было | Стало | Проверка |
|---|---|---|---|
| `dsh-vision-router\lib\client.js` | `{ zh, en }` → при ru английский (269 ключей) | `const ru` (269) + `{ zh, en, ru }` | en=269/ru=269, orderOk, CJK в ru=0 |
| `dsh-serper-search\lib\client.js` | `{ zh, en }` (45 ключей) | `const ru` (45) + `{ zh, en, ru }` | en=45/ru=45, orderOk, CJK в ru=0 |
| `dsh-git-credentials\lib\client.js` | `{ zh, en }` (44 ключа) | `const ru` (44) + `{ zh, en, ru }` | en=44/ru=44, orderOk, CJK в ru=0 |

### 2.2 «Третья полоса»: 8 файлов с билингвальными парами — все закрыты

| Файл | Пар | ru-ключей | Ремонт | Проверка |
|---|---|---|---|---|
| `lib\settings-ia-client-prelude.js` | 201 | 216 | `RU_TEXT` + `tx()` трёхполосный | missing=0 |
| `lib\vision-capability-benchmark-client.js` | 71 | 71 | `RU_TEXT` + `text()` + 2 потребителя пар → `pairText()` | missing=0 |
| `lib\vision-routing-settings-prelude.js` | 28 | 28 | `text()` + потребитель пар | missing=0 |
| `lib\vision-exact-check-client.js` | 24 | 24 | `text()` | missing=0 |
| `lib\v2-settings-ia-integration.js` | 13 | 13 | `tx()` | missing=0 |
| `lib\settings-limit-client-prelude.js` | 8 | 8 | `tx(pair)` + `pick()` + ru-ветки в `source()`/`seconds()` | missing=0 |
| `lib\settings-native-card-layout.js` | (32 строки-сниппета) | — | рантайм использует трансформированный прелюд settings-ia; 15 недостающих строк добавлены в его `RU_TEXT` | проверка **на реальном прелюде**: pairs=214, missing=[], ruBranchWired=true, txPatched=true |
| `lib\runtime-i18n-boundary.js` | 40 | 41 | ru-постобработка + 5 guard-строк + динамический guard лимита времени | pairs=40, missing=[], ruPostPassWired=true |

Функциональный тест boundary (`translateLegacyRuntimeText`, локаль ru/en/zh):

```
--- ru ---
ok   Бюджет времени зрения на этот ход исчерпан. …
ok   Достигнут заданный предел вызовов глубокого анализа на этот ход. …
ok   Несколько подряд идущих вызовов зрения не дали пригодных доказательств. …
ok   Структурированное предраспознавание завершено, но пригодных доказательств по задаче пока нет. …
ok   Лимит времени зрения Vision Router на этот ход (30 с) исчерпан. …
ok   Общее структурированное предраспознавание изображения завершено. …
--- en ---  (все 6 — английские)
--- zh ---  (все 6 — без изменений, ранний возврат)
{"leaksForNonZh":0}
```

Заодно исправлен найденный баг boundary: одна из замен была `китайский → китайский`, из-за чего текст оставался китайским даже при en/ru.

### 2.3 Остальные правки (host-side и без реестра)

| Плагин / файл | Было | Стало | Проверка |
|---|---|---|---|
| `dsh-vision-router\index.js` | `displayName: '视觉路由（自动识图）'`, skill-блок, deep-tools сообщения, напоминания 1+x, OCR-промпты, описание `vision_bootstrap` | русские | `node --check` OK; CJK 3476 → 1477 (остаток — комментарии/маркеры) |
| `dsh-vision-router\lib\runtime-i18n.js` | словари zh/en, для ru — en | +словарь `ru` (23) + `runtimeMessageLanguage` | тест: ru→русский, zh→китайский, en→английский, без предпочтения→zh |
| `...\lib\runtime-i18n-boundary.js`, `...-core.js` | гейты `!== 'en'` пропускали ru | `=== 'zh'` (9 мест) | `node --check` OK |
| `...\lib\settings-ia-client-prelude.js`, `vision-turn-budget-client-prelude.js`, `live-model-client-prelude.js`, `client-presentation-boundary-main.js` | патчи словарей только `next.zh`/`next.en` | +`next.ru` (11/5/2/6 ключей) и словарь `ru` для переключателя «Зрение» | `node --check` OK |
| `...\lib\client.js` (вне словаря) | `'：'`, метки `code（代码）`, `、`, `（…）` | `': '`, `code (код)`, `', '`, ` (…)` | `node --check` OK |
| `dsh-git-credentials\lib\index.js` | 24× `Settings → Git 凭据` | `Settings → Git-доступы` (CJK в файле = 0) | `node --check` OK |
| `dsh-scrape-webpage\lib\index.js`, `analyze.js`, `fetch.js`, `html.js` | пользовательские сообщения и описание инструмента | русские (комментарии и `STOP_CJK` не тронуты) | `node --check` OK |
| `dsh-delegate-router` | проверка фактом | во всех `lib\*.js` CJK = **0**; 110 — только `scripts\test-routing.mjs` | `scan-cjk.mjs` |

## 3. Бэкапы и откат

Бэкапы рядом с файлами: `dsh-vision-router` — 21, `dsh-serper-search` — 1, `dsh-git-credentials` — 2, `dsh-scrape-webpage` — 4 (всего 28). Не удаляются.

Откат одного файла — скопировать `.bak-ru-*` поверх оригинала. Массовый откат (PowerShell, из корня сессии):

```powershell
$base = "C:\Users\Артем\.dsh\profiles\desktop\node_modules"
Get-ChildItem -Recurse -File -Path $base -Filter "*.bak-ru-*" |
  Where-Object { $_.DirectoryName -match 'dsh-(vision-router|serper-search|git-credentials|scrape-webpage)' } |
  ForEach-Object { $orig = $_.FullName -replace '\.bak-ru-[0-9].*$',''; Copy-Item $_.FullName $orig -Force; Write-Host "restored $orig" }
```

## 4. Что слетит при обновлении плагинов

Любое обновление/переустановка (`pnpm install`, `dsh plugin`, маркетплейс) перезапишет `lib\*` и `index.js` — все правки (ru-словари, `RU_TEXT`, ru-ветки, русские литералы) пропадут. `cordis.patch.yml` и `package.json` профиля намеренно не менялись. После правок требуется **перезапуск DSH** (в рамках задачи не выполнялся).

## 5. Что осталось непереведённым и почему (осознанный остаток)

| Остаток | Объём / факт | Видимость и обоснование |
|---|---|---|
| Словари `zh` в реестрах (`vision-router\lib\client.js`, `runtime-i18n.js`, `serper\lib\client.js`, `git\lib\client.js`) | ~7700 CJK | **Не видно**: это источник китайской локали; удаление сломало бы zh. Рядом лежат `ru`-словари. |
| Матчеры китайских подписей в `vision-router\lib\client.js` (`[aria-label^="选择模型"]`, `label.startsWith('设置')`, regex `图片识别`) | 3 строки | **Намеренно**: это селекторы навигации, ищут и старые китайские подписи; перевод сломал бы поиск. |
| Маркеры авто-обёртки ` + 自动识图`, `（视觉）`, `REMINDER_PREFIX` | несколько файлов | **Намеренно**: идентификаторы маршрутов/дедупликации. Отображаемые имена локализуются в рантайме; для ru `（视觉）` → ` (зрение)`. |
| `lib\core-primitives.js` — китайские литералы локальных промптов/заметок (14 строк не покрыты точным совпадением) | 1868 CJK | **Косвенно**: это инструкции локальному бэкенду зрения и легаси-заметки. Русский приходит через i18n-путь (`runtime-i18n.ru`: `localStructuredPrompt`, `localPlainPrompt`, `ocrFallbackPrompt`) и через boundary (перезапись по префиксам/regex — проверено функционально: заметки вида `[图片「…」已由本地视觉识别…]` → `[Image “…” recognized by local vision…]`). Сырые литералы остаются как fallback. |
| `lib\depth-guidance.js` (1034), `lib\mixed-router.js` (449) | zh+en таблицы | Для ru `runtimeLanguageFor` возвращает `en` → подсказки **английские, не китайские**. Русская полоса потребовала бы расширить `runtimeLanguageFor` и все три таблицы — отдельная задача. |
| `lib\structured-flow-hardening.js`, `legacy-session-repair.js`, `vision-limit-diagnostics.js`, `structured-bootstrap.js` | 9 строк, из них 3 — только детекторы (`GUARD_STOP_TEXTS`, `REMINDER_PREFIX`, `includes('本轮视觉总时间预算已耗尽')`) | Эмитируемые тексты (guard-лимиты, метка `结构化预识别`) **закрыты** через boundary. Детекторы должны остаться китайскими — иначе перестанут узнавать старые сообщения. |
| `lib\runtime-i18n-boundary.js` — ветки заметок о вложениях/памяти: жёстко зашитый **английский** шаблон с переменными | ~4 шаблона | Для ru — английский (не китайский). Статический RU-словарь неприменим из-за подстановок (`{name}`, память, id); нужны ru-ветки в коде. |
| `cordis.patch.yml` плагинов (~1100 CJK), `README*`, `CHANGELOG.md`, `docs\**`, `README.zh.md` | тысячи CJK | Конфиг бандла и документация, не интерфейс. Не тронуто, чтобы не ломать merge/установку. |
| `dsh-git-credentials\src\**` (~300 CJK), `dsh-serper-search\lib\merge.js` (`CN_DATE`), `dsh-scrape-webpage\lib\analyze.js` (`STOP_CJK`), `dsh-delegate-router\scripts\test-routing.mjs` (110) | — | TS-исходники (рантайм — `lib\*`), рабочие регулярки/словари, тестовый скрипт. |

## 6. Приёмка

- `ru` зарегистрирован в трёх плагинах с реестром; `ru`-набор = `en`-набор; CJK в `ru` = 0 ✅
- «Третья полоса»: во всех 8 файлах с билингвальными парами `missing = 0`; проверка на реальном прелюде, который уходит в браузер, — `pairs=214, missing=[]` ✅
- Легаси-текст: функциональный тест ru/en/zh — `leaksForNonZh = 0` ✅
- `node --check` по 21 правленому JS-файлу — 0 провалов ✅
- `check-profile-bundles.mjs` → **RESULT: OK** ✅
- Бэкапы на месте (28 шт.) ✅
- Нужен **перезапуск DSH** ✅ (не выполнялся)
