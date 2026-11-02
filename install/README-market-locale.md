# T23: русский языковой пакет DSH (@dsh-locale-ru@)

## Что установлено

* Пакет `dsh-locale-ru 1.0.0` из проекта `C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale`.
* Куда: `<профиль>\node_modules\dsh-locale-ru` — файлы `lib\client.js`, `lib\index.js`, `locale\ru.json`, `locale\en.json`, `package.json` на месте.
* В `cordis.patch.yml` профиля добавлены: ровно одна roster-строка `id: locale-ru` (внутри `- insert:`) и `preference: ru` у записи `locale`.
* Бэкапы до правок: `package.json.bak-locale-20261031-183706`, `pnpm-lock.yaml.bak-locale-20261031-183706`, `pnpm-workspace.yaml.bak-locale-20261031-183706`, `cordis.patch.yml.bak-locale-20261031-183706`, `compatibility.json.bak-locale-20261031-183706`; плюс собственный бэкап установщика `cordis.patch.yml.bak-20261031-184534`.

## Как устанавливалось

Сначала `-DryRun` (показал: копирование в node_modules, roster-строка, preference ru), затем реальная установка — exit 0.

`@powershell
$src = "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\plugin"
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$script = "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\install\apply-ru-locale.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $script -PluginSource $src -ProfileDir $prof -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File $script -PluginSource $src -ProfileDir $prof
`@

Грабли: без явного `-PluginSource` установщик падает с `Join-Path: Cannot bind argument to parameter 'Path' because it is an empty string` — в Windows PowerShell 5.1 `$PSScriptRoot` не заполняется при вычислении значений по умолчанию для параметров при запуске через `-File`. Источник передаём явно.

## Проверки (выполнены)

`@text
package.json профиля:      парсится
cordis.patch.yml:          js-yaml strict OK; записей 10; locale-ru внутри insert = 1; preference у locale = 1
check-profile-bundles.mjs: RESULT: OK (0 дублей, все патчи парсятся, 16 inserted id без конфликтов)
файлы локали:              lib/client.js, lib/index.js, locale/ru.json, locale/en.json — на месте
`@

## Что изменится и когда

* Пакет **клиентский**: видно **только после полного перезапуска DSH** (закрыть приложение вместе со значком в трее и открыть заново).
* Появится «Русский» в `Настройки -> Общие -> Язык`; интерфейс самого DSH (меню, настройки, диалоги) станет русским.
* Подписи сторонних плагинов языковой пакет не покрывает — их переводили отдельно (см. `README-ui-ru-translations.md`).

## ОТКАТ

Штатный откат установщика (снимает roster-строку и preference, удаляет пакет):

`@powershell
$src = "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\plugin"
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\install\apply-ru-locale.ps1" -PluginSource $src -ProfileDir $prof -Revert
`@

Полный откат профиля к состоянию до T23:

`@powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml','compatibility.json')) { Copy-Item "$p\$f.bak-locale-20261031-183706" "$p\$f" -Force }
& "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install
`@

## ВАЖНО: пакет вычистит pnpm

`dsh-locale-ru` установлен **копированием**, а не как зависимость профиля. Любой `dsh plugin add/remove/install` или `pnpm install` удалит `node_modules\dsh-locale-ru` (pnpm вычищает каталоги, не объявленные в `dependencies` — проверено зондом). Строка `id: locale-ru` в `cordis.patch.yml` при этом останется и будет ссылаться на отсутствующий пакет, что может помешать старту. Поэтому **после каждой операции с плагинами повторяйте установку локали** (идемпотентна); если профиль не стартует — снимите строку через `-Revert`.

## Разведка по чужим подписям

Полная таблица — в `README-ui-ru-translations.md` (раздел «Разведка: где ещё есть CJK»). Коротко: крупнейший чужой китайский интерфейс — `dshmarket` (~2868 CJK в `client/client.js@), и у него есть штатный механизм локалей (`locale/zh.json`, `locale/en.json`), поэтому добавление `locale/ru.json` — самый выгодный следующий шаг (правка чужого плагина только по вашему разрешению). У `dsh-skill-browser` остались китайские группы/ключевые слова и палитра цветов, у `dsh-delegate-router` — ~119 строк локали валидации. Чужие плагины не патчились.
