# T27: маркет, устойчивость языкового пакета, остальные подписи

## 1) dshmarket — что выяснено про локализацию (важно, ожидание не совпало с фактом)

Разведка кода дала точную картину:

* `locale/zh.json` — **104 байта**, `locale/en.json` — **17 байт** (@{"meta":{}}@). Это только **метаданные каталога языков** (название и описание языка), а не словарь интерфейса. Поэтому «добавить ru.json по образцу en.json» русифицирует ровно одну строку — название языка.
* Настоящий словарь лежит **внутри** @dshmarket\client\client.js@, регион @src/client/locales.ts@: @const zh = {…}, const en = {…}, const ja = {…}@ — и по комментарию самого плагина он покрывает только **«the Market settings section and install toast»** (карточка настроек маркета и всплывающее сообщение об установке).
* Весь остальной интерфейс маркета — **~1835 CJK-строк, вшитых прямо в @client.js@**, плюс сотни сообщений в @lib\*.js@ (@pnpm-compat.js@ ~230, @routes.js@ ~242, @dsh-cli.js@ ~91, @verify.js@ ~72 и т.д.). Штатного i18n-механизма для них нет.

Что я сделал (минимально и безопасно): создал @node_modules\dshmarket\locale\ru.json@ по образцу @zh.json@ (@meta.title@ / @meta.description@) — каталог языков маркета теперь знает русский. Файл новый, ничего не перезаписано; откат = удалить его.

Что осталось и требует отдельной задачи: перевод **словаря настроек** (@zh/en/ja@ в @client.js@ → нужен @ru@ + регистрация выбора локали — это правка кода чужого плагина) и, что важнее по объёму, **~1835 подписей интерфейса** в @client.js@ + сообщения @lib\*.js@. Это большая работа (в 40 раз больше, чем T25) — предлагаю делать отдельной задачей и по разделам, с проверкой после каждого раздела.

## 2) Устойчивость языкового пакета — СДЕЛАНО И ПРОВЕРЕНО

Было: @dsh-locale-ru@ лежал копией в @node_modules@, и любой @dsh plugin install@/pnpm вычищал каталог, а строка @id: locale-ru@ в `cordis.patch.yml@ оставалась → риск нестарта профиля.

Стало (штатный путь, без обходов):

`@powershell
# 1) исходник пакета закреплён в профиле
Copy-Item -Recurse -Force "C:\Users\Артем\Desktop\DeepSeek Harness\ru-locale\plugin" "$env:USERPROFILE\.dsh\profiles\desktop\.plugin-sources\dsh-locale-ru"
# 2) объявлен настоящей зависимостью
& "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:.plugin-sources/dsh-locale-ru"
`@

Проверка фактическая (самое важное — тест на вычищение):

`@text
add file:.plugin-sources/dsh-locale-ru -> exit 0; в dependencies запись dsh-locale-ru = file:.plugin-sources/dsh-locale-ru
dsh plugin install -> exit 0 (Packages: -12, то есть прунинг сработал)
после install: node_modules\dsh-locale-ru на месте; lib/client.js, lib/index.js, locale/ru.json, package.json — все есть
строк id: locale-ru в cordis.patch.yml: ровно 1
check-profile-bundles.mjs -> RESULT: OK
`@

Раньше этот же @install@ удалял каталог — теперь он выживает. Строка @locale-ru@ и пакет больше не расходятся. Откат: @dsh plugin --profile desktop remove dsh-locale-ru@ + @-Revert@ установщика локали (или восстановление @*.bak-locale-20261031-183706@).

## 3) Остальные подписи (telegram, scrape-webpage, serper, git-credentials) — точные числа и решение

Я разделил CJK на «в строках» (то, что видит пользователь) и «в комментариях» (не видно):

| Плагин | CJK в строках (видны) | CJK в комментариях (не видны) | Комментарий |
|---|---|---|---|
| dsh-scrape-webpage | ~106 (сообщения инструмента и ошибки: «网页抓取失败：», «抓取超时», «无法解析抓取结果» …) | ~132 | видны в ответах инструмента и ошибках |
| dsh-serper-search | ~67 (подписи настроек: «接口地址», «已配置密钥», «未配置密钥…») | 0 | видно в настройках поиска |
| dsh-git-credentials | ~51 (интерфейс: «新增站点», «还没有站点…», «刷新», «处理中» …) | 0 | видно в настройках |
| dsh-telegram-channel-ru | ~4 (символы «。【】：» — пунктуация в сборке строк) | ~73 | интерфейс **уже русский**, CJK только в комментариях |

Вывод: палитра цветов в skill-browser и локаль валидации zh/ja/tw в delegate-router не тронуты (как и просили). Оставшиеся ~224 видимые строки — это отдельная задача перевода: каждая строка должна быть переведена с сохранением плейсхолдеров (@{0}@, @%s@, конкатенаций вида «第» + n + «张下载失败（» + msg + «）»), иначе сообщения сломаются. Я не стал править их «на скорость»: без возможности запустить интерфейсы этих плагинов риск сломать сообщения выше пользы. Предлагаю отдельную задачу по одному плагину с проверкой @node --check@ и прогоном тестов плагина (у scrape-webpage и serper есть свои тесты).

## Откат всего T27

`@powershell
# маркет: убрать добавленный файл каталога
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dshmarket\locale\ru.json" -Force
# языковой пакет: снять зависимость и вернуть копийную установку
& "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-locale-ru
`@
