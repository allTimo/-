# ru-plugins-report — отчёт исполнителя по task-3 (R3, T28B+C) + добор revision 7

Исполнитель: teammate `plugins-ru`. Дата: 31.10.2026. Профиль: `C:\Users\Артем\.dsh\profiles\desktop`.
Объём: `dsh-vision-router`, `dsh-serper-search`, `dsh-git-credentials`, `dsh-scrape-webpage`, проверка `dsh-delegate-router`.
`dsh-skill-browser` (task-7) не тронут. `dshmarket`, `dsh-locale-ru`, `cordis.patch.yml` и `package.json` профиля не тронуты. DSH не перезапускался, `pnpm install` / `dsh plugin` не запускались.

## 1. Числа по плагинам

### dsh-vision-router — реестр локалей
- `lib\client.js`: добавлен `const ru` — **269 ключей** (как в `en`), регистрация стала `locale.register(NS, { zh, en, ru })`. Плюс 7 мелких правок вне словаря (полноширинные `：`/`、`/`（）`, метки типов `code（代码）` → `code (код)`).
- `index.js`: `displayName`, skill-блок (`title`/`description`/`whenToUse`/`content`), deep-tools сообщения, напоминания 1+x, followup- и auto-mount-напоминания, OCR-промпты, описание `vision_bootstrap`, фрагменты описаний инструментов. CJK: **3476 → 1477** (остаток — комментарии и маркеры-идентификаторы).
- `lib\runtime-i18n.js`: +словарь **ru (23)**, `runtimeMessageLanguage()` (ru → полоса ru). Тест: `ru => Инструменты зрения · Vision Tools`, `zh => 视觉深看工具`, `en => Vision Tools`, без предпочтения → zh.
- `lib\runtime-i18n-boundary.js` и `-core.js`: 9 гейтов `i18n.language() !== 'en'` → `=== 'zh'`.
- Prelude-патчи `next.ru`: `settings-ia` +11, `vision-turn-budget` +5, `live-model` +2 (+ветка ru в `promptText()`), `client-presentation-boundary` +6 (+словарь ru на 8 ключей для переключателя «Зрение», регистрация `{ zh, en, ru }`).

### dsh-vision-router — «третья полоса» (добор, revision 7)
Все файлы с билингвальными парами `tx('中文','English')`/`text(...)`/`['中文','English']` (8 из 8):

| Файл | Пар | ru-ключей | missing | Ремонт |
|---|---|---|---|---|
| `settings-ia-client-prelude.js` | 201 | 216 | 0 | `RU_TEXT` + `tx()` |
| `vision-capability-benchmark-client.js` | 71 | 71 | 0 | `text()` + `pairText()` ×2 |
| `vision-routing-settings-prelude.js` | 28 | 28 | 0 | `text()` + `pairText()` |
| `vision-exact-check-client.js` | 24 | 24 | 0 | `text()` |
| `v2-settings-ia-integration.js` | 13 | 13 | 0 | `tx()` |
| `settings-limit-client-prelude.js` | 8 | 8 | 0 | `tx(pair)` + `pick()` + ru-ветки `source()`/`seconds()` |
| `settings-native-card-layout.js` | — | — | — | покрыт через трансформированный прелюд settings-ia (15 строк добавлено) |
| `runtime-i18n-boundary.js` | 40 | 41 | 0 | `RU_LEGACY_TEXT` + `translateLegacyTextToRussian` + guard-строки |

Проверка **на реальном прелюде, который уходит в браузер** (импорт `transformSettingsIaToNativeCards()`):

```
{
 "transformLength": 105514,
 "pairs": 214,
 "ruKeys": 216,
 "ruBranchWired": true,
 "ruTextPresent": true,
 "txPatched": true,
 "missing": []
}
```

### dsh-serper-search
- `lib\client.js`: `const ru` — **45 ключей**, регистрация `{ zh, en, ru }`. Остаток `lib\merge.js` — 3 CJK в рабочей регулярке `CN_DATE`.

### dsh-git-credentials
- `lib\client.js`: `const ru` — **44 ключа**, регистрация `{ zh, en, ru }`.
- `lib\index.js`: 24× `Settings → Git 凭据` → `Settings → Git-доступы` (CJK в файле 0). `src\**` не менялись (рантайм — `lib\*`).

### dsh-scrape-webpage (реестра нет — литералы)
- `lib\index.js`, `analyze.js`, `fetch.js`, `html.js`: пользовательские сообщения, описание `scrape_webpage` и описания параметров, песочница/апрув, рендер результата — русские; плейсхолдеры сохранены. Остаток — комментарии и `STOP_CJK`.

### dsh-delegate-router (проверка, правок нет)
- Во **всех** `lib\*.js` CJK = **0**; 110 — `scripts\test-routing.mjs`, 24 — `README.md`, 14 — `cordis.patch.yml`.
- Наблюдение вне объёма: регистрация осталась `{ zh, en }` без `ru` (китайских символов в бандле нет).

## 2. Проверки (фактический вывод)

`node --check` по 21 правленому файлу:

```
node --check: файлов 21, провалов 0
(в т.ч. index.js, client.js, runtime-i18n.js, runtime-i18n-boundary.js, runtime-i18n-core.js,
 settings-ia-client-prelude.js, settings-limit-client-prelude.js, vision-capability-benchmark-client.js,
 vision-routing-settings-prelude.js, vision-exact-check-client.js, v2-settings-ia-integration.js,
 vision-turn-budget-client-prelude.js, live-model-client-prelude.js, client-presentation-boundary-main.js,
 serper\lib\client.js, git\lib\client.js, git\lib\index.js, scrape\lib\{index,analyze,fetch,html}.js)
```

`verify-ru.mjs` (реестры):

```
dsh-vision-router\lib\client.js   enKeys=269 ruKeys=269 orderOk=true cjkInRu=0 registered=true
dsh-serper-search\lib\client.js   enKeys=45  ruKeys=45  orderOk=true cjkInRu=0 registered=true
dsh-git-credentials\lib\client.js enKeys=44  ruKeys=44  orderOk=true cjkInRu=0 registered=true
```

`verify-ru-pairs.mjs` (третья полоса, строки, где при ru выбирался английский): 0 во всех файлах (см. таблицу §1).

`verify-boundary.mjs`:

```
{ "pairs": 40, "ruKeys": 41, "missing": [], "ruPostPassWired": true,
  "chineseToChineseLeakFixed": true, "displayNameRu": true }
```

Функциональный тест boundary (`translateLegacyRuntimeText`, ru/en/zh) — `{"leaksForNonZh":0}`; при ru все 6 легаси-текстов (guard-лимиты, динамический лимит времени с секундами, structured followup) выходят по-русски, при en — по-английски, при zh — без изменений.

Валидатор профиля:

```
node marketing-agents\install\check-profile-bundles.mjs "C:\Users\Артем\.dsh\profiles\desktop"
...
inserted entry ids across community bundles: 16

RESULT: OK
exit=0
```

## 3. Бэкапы (28 файлов, не удалялись)

`dsh-vision-router` — 21 (в т.ч. `index.js`, `lib\client.js` ×2, `runtime-i18n.js`, `runtime-i18n-boundary.js` ×4, `runtime-i18n-core.js`, `settings-ia-client-prelude.js` ×3, `settings-limit-client-prelude.js`, `vision-capability-benchmark-client.js`, `vision-routing-settings-prelude.js`, `vision-exact-check-client.js`, `v2-settings-ia-integration.js`, `vision-turn-budget-client-prelude.js`, `live-model-client-prelude.js`, `client-presentation-boundary-main.js`), `dsh-serper-search` — 1, `dsh-git-credentials` — 2, `dsh-scrape-webpage` — 4.
Откат и что слетит при обновлении — в `README-ui-ru-plugins.md`, разделы 3–4.

## 4. Добор №2: модель-фейсинг китайский — решение по факту

Закрыто через boundary (это штатное место перевода легаси-текста для не-zh локалей):
- guard-тексты лимитов из `structured-flow-hardening.js` (3 строки), метка `结构化预识别` из `structured-bootstrap.js`, динамический «Vision Router 本轮视觉时间上限（N 秒）…» из `vision-limit-diagnostics.js` — теперь zh→en→ru; функциональный тест это подтверждает.

Оставлено осознанно (не влияет на язык ответа и подписи интерфейса):
- `core-primitives.js` — сырые китайские литералы локальных промптов/заметок (14 строк). Русский приходит через i18n-путь `runtime-i18n.ru` (`localStructuredPrompt`, `localPlainPrompt`, `ocrFallbackPrompt`) и через boundary (перезапись по префиксам/regex, проверено функционально).
- `depth-guidance.js` (1034) и `mixed-router.js` (449) — таблицы zh+en; для ru берётся **английская** (не китайская) полоса. Русская полоса — отдельная задача (нужно расширять `runtimeLanguageFor` и все таблицы).
- 3 строки в `legacy-session-repair.js` / `vision-limit-diagnostics.js` — это **детекторы** старых сообщений (`GUARD_STOP_TEXTS`, `REMINDER_PREFIX`, `includes('本轮视觉总时间预算已耗尽')`); их перевод сломал бы распознавание легаси-сессий.
- Ветки boundary для заметок о вложениях/памяти — жёстко зашитый **английский** шаблон с переменными (`{name}`, память, id); статический RU-словарь неприменим, нужны ru-ветки в коде.

Не тронуто по условию: матчеры китайских подписей, маркеры ` + 自动识图` / `（视觉）`, `cordis.patch.yml`, `docs`/`README.zh`, `src/**`.

## 5. Итог

- `ru` зарегистрирован в трёх плагинах с реестром; `ru`-набор = `en`-набор; CJK в `ru` = 0.
- «Третья полоса» закрыта: во всех 8 файлах с билингвальными парами 0 строк, где при ru выбирался английский; проверено на реальном прелюде.
- Легаси-текст для ru переводится на русский (`leaksForNonZh = 0`).
- `check-profile-bundles.mjs` → `RESULT: OK`.
- **Для применения нужен перезапуск DSH** (правки в клиентских бандлах). Перезапуск не выполнялся — запрещено условиями задачи.
