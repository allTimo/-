# Языковой пакет ru-locale: конвейер переводов (R1 / T34 + T28A)

Документ описывает изменения в конвейере `ru-locale` от 31.10.2026 и то, как их
перепроверить. Затрагивает только пакет `dsh-locale-ru`; файлы
`README-ui-ru-translations.md`, `README-ui-ru-plugins.md`, `ru-market-report.md`,
`ru-plugins-report.md` и `marketing-agents/audit/**` ведёт другой исполнитель.

Проект пакета (вне рабочего каталога сессии):
`C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale`
Профиль: `C:\Users\Артем\.dsh\profiles\desktop`

## Что изменилось

| Файл | Изменение |
| --- | --- |
| `tools/validate-translations.js` | Не-строковые источники (`{"__raw": …}`) больше не выбрасываются: они считаются переводимым текстом, потому что клиент видит уже вычисленную строку. Значение `{"__raw": …}` в `*.ru.txt` теперь ошибка (PROBLEM). Добавлен разбор `tools/identical-allowlist.txt` и полный вывод списка допустимых совпадений с английским. Лимит в 60 предупреждений снят. |
| `tools/build-plugin.js` | Из сборки убран `continue` для не-строковых источников; значение обязано быть готовой строкой. Добавлена проверка: тип `string`, отсутствие обёртки `{"__raw": …}`, непустое значение для непустого источника. |
| `tools/identical-allowlist.txt` (новый) | Список `namespace<TAB>key<TAB>причина` для 55 совпадений ru с en, которые являются нормой (имена продуктов и протоколов, URL, разделители, шаблоны из плейсхолдеров и единиц). |
| `tools/.verify-pack.js` (новый, только чтение) | Приёмка собранного/установленного `lib/client.js`: сверка с corpus, поиск пропусков, пустых значений, обёрток `__raw`, CJK; отдельная проверка 8 guide-ключей и 2 plan-ключей. |
| `translations/settings.agentPreset.ru.txt` | 8 значений `guide*` переписаны из обёртки `{"__raw": …}` в готовый Markdown; убран CJK, исправлены артефакты машинного перевода. |
| `translations/conversation.ru.txt` | `hint.plan` и `placeholder.plan`: «ПЛАН_СЛЕДУЮЩЕГО_ДЕЙСТВИЯ» → «опишите задачу, чтобы создать план». |
| `translations/chat.ru.txt` | `message.retry.status`: `{seconds}s` → `{seconds} с`. |
| `translations/settings.models.ru.txt` | `deepSeekAccount`: `DeepSeek Account` → `Аккаунт DeepSeek`. |
| `translations/cordis.ru.txt` | `a11y.preparing` переставлен на вторую строку — порядок ключей совпал с `en.json` (последнее предупреждение валидатора). |

Сборка выросла с 2672 до **2682** ключей (добавились 10 не-строковых), `plugin/lib/client.js` — 227.8 KiB.

## Правило для `__raw`-источников и почему оно такое

В `corpus/<ns>/en.json` встречаются две формы источника:

* `"some text"` — готовая строка интерфейса;
* `{ "__raw": "<выражение>" }` — в поставке клиент вычисляет выражение, и в словаре оказывается **строка**.

Доказательства из `resources\app.asar` (инструменты `.localizer\scan-asar.js` / `.localizer\dump-asar.js`):

1. смещение 23424280 — английский словарь `settings.agentPreset` содержит
   `guideStandardExplanation: ["### How it works", …,].join("\n\n")`, то есть в рантайме это обычная строка;
2. смещение 25032150 — `const PLAN_NEXT_ACTION_EN = "describe your task to generate plan";`, а в словаре `conversation` — `"hint.plan": PLAN_NEXT_ACTION_EN` и `"placeholder.plan": PLAN_NEXT_ACTION_EN`; это пользовательский текст, а не служебный маркер;
3. смещение 25198100 — в InputBar `const translated = t(hintKey); return translated !== hintKey ? translated : rawHint;`: сравнение с самим ключом возможно только для строки;
4. смещение 23467000 — карта `guides` сопоставляет пресетам ключи `intro`/`explanation`/`usage` и рендерит их как Markdown.

Поэтому в `*.ru.txt` для таких ключей пишется **готовая строка**, а переносы строк — экранированными `\n` (декодируются тем же `decodeEscapes`, что и раньше).

## Как перепроверить

```powershell
$node = "C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
Set-Location "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale"

# 1. Валидатор: problems: 0, warnings: 0, 55 допустимых совпадений
& $node tools\validate-translations.js

# 2. Сборка
& $node tools\build-plugin.js

# 3. Приёмка собранного и установленного бандла
& $node tools\.verify-pack.js "plugin\lib\client.js"
& $node tools\.verify-pack.js "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-locale-ru\lib\client.js"

# 4. Профиль: ровно одна строка id: locale-ru, preference: ru, strict js-yaml
(Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern '^\s*-?\s*id:\s*locale-ru\s*$').Count   # ожидается 1
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern 'preference:'

# 5. Проверка бандлов профиля
Set-Location "C:\Users\Артем\Desktop\тестDH"
& $node marketing-agents\install\check-profile-bundles.mjs "$env:USERPROFILE\.dsh\profiles\desktop"   # ожидается RESULT: OK
```

Переустановка пакета (всегда с явным `-PluginSource`, иначе возьмётся `..\plugin` относительно скрипта):

```powershell
Set-Location "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale"
powershell -ExecutionPolicy Bypass -File install\apply-ru-locale.ps1 `
  -PluginSource "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\plugin"
```

**Перезапуск DSH обязателен.** Установщик только копирует пакет и правит `cordis.patch.yml`; уже запущенный клиент продолжает работать со старым бандлом. Пока DSH не перезапущен (полностью, включая значок в трее → «Выход»), страница «Предустановки агента» остаётся китайской.

## Как откатить

Одна детерминированная команда (бэкапы пакета от 31.10.2026, `id: locale-ru` и `preference: ru` уже были в профиле до этой правки):

```powershell
$root = "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale"
$ts = "20261031-201807"
Copy-Item "$root\tools\validate-translations.js.bak-$ts" "$root\tools\validate-translations.js" -Force
Copy-Item "$root\tools\build-plugin.js.bak-$ts"          "$root\tools\build-plugin.js" -Force
Copy-Item "$root\translations\settings.agentPreset.ru.txt.bak-$ts" "$root\translations\settings.agentPreset.ru.txt" -Force
Copy-Item "$root\translations\conversation.ru.txt.bak-$ts"        "$root\translations\conversation.ru.txt" -Force
Copy-Item "$root\translations\cordis.ru.txt.bak-20261031-202019"  "$root\translations\cordis.ru.txt" -Force
Copy-Item "$root\translations\chat.ru.txt.bak-20261031-202019"    "$root\translations\chat.ru.txt" -Force
Copy-Item "$root\translations\settings.models.ru.txt.bak-20261031-202019" "$root\translations\settings.models.ru.txt" -Force
Remove-Item "$root\tools\identical-allowlist.txt","$root\tools\.verify-pack.js" -Force
powershell -ExecutionPolicy Bypass -File "$root\install\apply-ru-locale.ps1" -PluginSource "$root\plugin"
```

Полный отказ от русского языка: `install\apply-ru-locale.ps1 -Revert` (снимает `node_modules\dsh-locale-ru` и восстанавливает `cordis.patch.yml`). Важно: `-Revert` выбирает бэкап сортировкой **по имени**, поэтому может взять `cordis.patch.yml.bak-reset-…` вместо последнего по времени; перед использованием стоит сверить выбранный файл.

## Что слетит при обновлении DSH

1. `corpus/**` собран из `resources\app.asar`; после обновления приложения corpus устаревает — нужен повторный извлечение и сверка (иначе новые ключи останутся на английском/китайском, а удалённые станут «лишними ключами»).
2. `node_modules\dsh-locale-ru` живёт внутри профиля и переживает обновление приложения, но сброс профиля (или `pnpm install` без записи пакета в `package.json`) его удалит: пакет не объявлен в зависимостях профиля намеренно.
3. `cordis.patch.yml` — обычный файл профиля; установщик DSH или «сброс профиля» могут его перезаписать, тогда строки `id: locale-ru` и `preference: ru` пропадут, и установку надо повторить.
4. `tools/**` и `translations/**` — это исходники пакета в `ru-locale`, обновление DSH их не трогает.
