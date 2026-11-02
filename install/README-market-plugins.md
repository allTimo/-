# Плагины из маркета DSH в профиле `desktop` (задача T10)

Дата установки: 2026-10-30 (вечер, Europe/Moscow).
CLI: `C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` (0.2.1-rc.5).
Профиль: `C:\Users\Артем\.dsh\profiles\desktop`.
Настройки установки менялись ТОЛЬКО в профиле; `cordis.patch.yml` профиля не тронут; файлы `marketing-agents\**` (кроме этого документа и хелпера) не менялись.

## Главное, что нужно знать про механизм

```text
dsh plugin --profile desktop add <spec>
```

* CLI **форвардит аргументы в pnpm** в каталоге профиля (это подтверждает `dsh plugin --help` и логи `.plugin-manager\logs\operation-*\pnpm.log`).
* **НО** после успешного выхода pnpm CLI сам сверяет пакет и **дописывает его имя в `package.json -> dsh.profile.bundles`**, если у пакета есть `dsh.bundle` (проверено на всех 7 успешных установках: до установки строки не было, после — появлялась без нашего участия; счётчик `bundles` рос 19 -> 20 -> ... -> 26).
* Дополнительно мы прогоняем идемпотентный хелпер [register-profile-bundle.mjs](register-profile-bundle.mjs) — он повторяет логику dshmarket `addProfileBundle` (`node_modules\dshmarket\lib\profile.js:1345`): атомарная запись (temp + rename), 2 пробела, перевод строки; повторный запуск даёт `changed: false`. Это страховка, если поведение CLI изменится.
* Пакет **без** `dsh.bundle` ставится как обычная зависимость и в bundles не попадает — поэтому после каждой установки мы читаем `node_modules\<pkg>\package.json` и регистрируем именно `name` из него.

Проверка после установки (read-only, выполнено):

```powershell
node C:\Users\Артем\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --version   # sanity
node "C:\...\pnpm.mjs" --dir "$env:USERPROFILE\.dsh\profiles\desktop" list --depth 0   # exit 0
```

## Что установлено (7 из 9)

| № | Спека из задания | Имя пакета | Версия | Точка входа / патч | Что даёт |
|---|---|---|---|---|---|
| 1 | `github:sandbaseai/sandbase-skills` | `@sandbaseai/dsh-skills` | 0.3.5 | `exports: ./lib/dsh-installer.mjs`, патч `dsh/cordis.patch.yml` | скилы SandBase (каталоги `marketing/`, `research/`) |
| 2 | `github:Vladimir-Human/ru-marketplace-mcp#path:/dsh` | `ru-marketplace-mcp-dsh` | 2.6.0 | carrier-bundle: своей точки входа нет, патч `cordis.patch.yml` | 15 скилов маркетплейсов + (по env) MCP `compare/decision/full` |
| 3 | `dsh-skill-browser` | `dsh-skill-browser` | 1.9.11 | `lib/index.js` + `lib/client.js` | панель-браузер скилов в UI |
| 4 | `dsh-serper-search` | `dsh-serper-search` | **0.4.0** | `lib/index.js` + клиент | веб-поиск через serper.dev |
| 5 | `dsh-scrape-webpage` | `dsh-scrape-webpage` | 1.0.0 | `lib/index.js` | инструмент `scrape_webpage` |
| 6 | `@opendsh/dsh-plugin-scheduled-tasks` | — | — | — | **НЕ установлен**, см. ниже |
| 7 | `dsh-telegram-channel-ru` | `dsh-telegram-channel-ru` | 0.13.1 | `lib/index.js` + клиент | канал Telegram |
| 8 | `https://github.com/Ylight-cpu/dsh-creative-studio/releases/latest/download/dsh-creative-studio.tgz` | — | — | — | **НЕ установлен**, см. ниже |
| 9 | `github:superdesigndev/superdesign-skill` | `superdesign-dsh` | 0.6.0 | `dsh/index.js`, патч `dsh/cordis.patch.yml` | скил `superdesign` |

Поля `capabilities` нет ни у одного из пакетов; вместо него используется `dsh.bundle` (`patch` и/или `client`).

### Почему № 6 и № 8 не установились (это решение хоста, не сбой pnpm)

* **№ 6 `@opendsh/dsh-plugin-scheduled-tasks@0.2.4`** — pnpm пакет скачал, но CLI отклонил установку и откатил её. Причина из `.plugin-manager\logs\operation-aQ9egY\pnpm.log`:
  ```text
  dsh: installation rejected: Plugin @opendsh/dsh-plugin-scheduled-tasks@0.2.4 is incompatible with dsh 0.2.1-rc.5:
  requirements {"@deepseek-ai/dsh-agent":"^0.1.0-rc.6", ... "@deepseek-ai/dsh-client-locale":"^0.1.0-rc.6"}; dsh: nothing was installed.
  ```
  Пакет требует in-box семейство `@deepseek-ai/dsh-* ^0.1.0-rc.6`, а установленный DSH — 0.2.1-rc.5 (0.2.x не подходит под `^0.1.0`).
* **№ 8 `dsh-creative-studio@0.2.1`** — пакет скачался (`+ dsh-creative-studio 0.2.1`), затем откат. Причина:
  ```text
  dsh: installation rejected: Plugin dsh-creative-studio@0.2.1 is incompatible with dsh 0.2.1-rc.5:
  requirements {"engines.dsh":">=0.1.1-rc.2 <0.1.2 || >=0.1.2-rc.1 <0.2.0-0"}; dsh: nothing was installed.
  ```

* После отказа в `package.json`, `dsh.profile.bundles` и `pnpm-lock.yaml` **не осталось следов** (проверено: 0 вхождений имён и в зависимостях, и в бандлах).
* Включить их можно только явным принятием риска (это решение пользователя, мы его не принимали):
  ```powershell
  & "$cli" plugin --profile desktop allow-version @opendsh/dsh-plugin-scheduled-tasks@0.2.4
  & "$cli" plugin --profile desktop allow-version dsh-creative-studio@0.2.1
  # затем повторить add; для creative studio лучше сначала дождаться релиза под 0.2.x
  ```

### Почему у `dsh-serper-search` версия 0.4.0, хотя в реестре 0.5.0

0.5.0 опубликована 2026-10-30T03:38 (менее суток до установки), и её удержала supply-chain политика pnpm `minimumReleaseAge` (строка CLI «Lockfile passes supply-chain policies»; в pnpm это `warnMissingTimeFieldOnce(..., "minimumReleaseAge")`, в dshmarket — `heldReleaseNotice`). Установилась предыдущая зрелая 0.4.0 (2026-10-20). Подтянуть 0.5.0 после выдержки:
```powershell
& "$cli" plugin --profile desktop add dsh-serper-search@latest
```

## Отклонения от исходных спек (и почему)

| Спека из задания | Что применили | Почему |
|---|---|---|
| `github:sandbaseai/sandbase-skills` | `https://codeload.github.com/sandbaseai/sandbase-skills/tar.gz/refs/heads/main` | в системе **нет git**, pnpm падает с `ERR_PNPM_GIT_RESOLVE_FAILED: git ls-remote failed`; в npm реестре пакета нет (`pnpm view` -> 404). URL проверен HEAD-запросом (200) и совпадает с `default_branch=main` из GitHub API |
| `github:Vladimir-Human/ru-marketplace-mcp#path:/dsh` | локальный источник `.plugin-sources\ru-marketplace-mcp-dsh` + `file:` спецификация | git недоступен; `#path:` без git не резолвится; в npm пакета `ru-marketplace-mcp-dsh` нет (404). Тарболл репозитория скачан, подкаталог `/dsh` развёрнут в профиль |
| `github:superdesigndev/superdesign-skill` | `https://codeload.github.com/superdesigndev/superdesign-skill/tar.gz/refs/heads/main` | та же причина (git нет), URL проверен HEAD (200) |

Что это значит на практике:

* Записи в `package.json`: `@sandbaseai/dsh-skills` и `superdesign-dsh` — это **URL ветки main** (плавающая ветка, без commit-pin), а не `github:owner/repo`. Локфайл фиксирует интегральный хэш скачанного тарболла, так что повторная установка детерминирована, но при обновлении ветки и пересборке локфайла версия может измениться.
* `ru-marketplace-mcp-dsh` — зависимость `file:.plugin-sources/ru-marketplace-mcp-dsh`: **не удалять каталог** `<профиль>\.plugin-sources\ru-marketplace-mcp-dsh` (иначе следующий `pnpm install` не сможет её восстановить). Перенос на другую машину эту запись не переживёт.

## Точные команды (как выполнено)

Все команды — из каталога профиля, CLI форвардит в pnpm:

```powershell
$cli = "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
cd "$env:USERPROFILE\.dsh\profiles\desktop"

# 1
& $cli plugin --profile desktop add https://codeload.github.com/sandbaseai/sandbase-skills/tar.gz/refs/heads/main   # exit 0
# 2 (см. раздел «локальный источник» ниже, подготовка каталога)
& $cli plugin --profile desktop add file:.plugin-sources/ru-marketplace-mcp-dsh                                  # exit 0
# 3-5, 7
& $cli plugin --profile desktop add dsh-skill-browser        # exit 0
& $cli plugin --profile desktop add dsh-serper-search        # exit 0 (0.4.0)
& $cli plugin --profile desktop add dsh-scrape-webpage       # exit 0
& $cli plugin --profile desktop add dsh-telegram-channel-ru  # exit 0
# 6 — отклонён хостом
& $cli plugin --profile desktop add "@opendsh/dsh-plugin-scheduled-tasks"   # exit 1 (incompatible, nothing installed)
# 8 — отклонён хостом
& $cli plugin --profile desktop add https://github.com/Ylight-cpu/dsh-creative-studio/releases/latest/download/dsh-creative-studio.tgz  # exit 1 (engines.dsh)
# 9
& $cli plugin --profile desktop add github:superdesigndev/superdesign-skill  # exit 1 (нет git)
& $cli plugin --profile desktop add https://codeload.github.com/superdesigndev/superdesign-skill/tar.gz/refs/heads/main  # exit 0
```

### Подготовка локального источника для № 2

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$stage = "$env:TEMP\rumarket-stage"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Invoke-WebRequest -Uri "https://codeload.github.com/Vladimir-Human/ru-marketplace-mcp/tar.gz/refs/heads/main" -OutFile "$stage\src.tar.gz"
tar -xzf "$stage\src.tar.gz" -C $stage
$src = Join-Path $prof ".plugin-sources\ru-marketplace-mcp-dsh"
New-Item -ItemType Directory -Path $src -Force | Out-Null
Copy-Item -Recurse -Force "$stage\ru-marketplace-mcp-main\dsh\*" $src
cd $prof
& $cli plugin --profile desktop add file:.plugin-sources/ru-marketplace-mcp-dsh
```

### Регистрация bundle (страховка)

```powershell
node C:\...\node.exe "C:\Users\Артем\Desktop\тестDH\marketing-agents\install\register-profile-bundle.mjs" "$env:USERPROFILE\.dsh\profiles\desktop" "@sandbaseai/dsh-skills"
# то же для: ru-marketplace-mcp-dsh, dsh-skill-browser, dsh-serper-search, dsh-scrape-webpage, dsh-telegram-channel-ru, superdesign-dsh
```

## Бэкапы (обязательные, сделаны ДО любых правок)

```text
C:\Users\Артем\.dsh\profiles\desktop\package.json.bak-market-20261030-224316
C:\Users\Артем\.dsh\profiles\desktop\pnpm-lock.yaml.bak-market-20261030-224316
C:\Users\Артем\.dsh\profiles\desktop\pnpm-workspace.yaml.bak-market-20261030-224316
```

Состояние до установки: 5 зависимостей, 19 bundles. После: 12 зависимостей, 26 bundles, дублей нет, `pnpm list --depth 0` -> exit 0.

## Как откатить

Один пакет:

```powershell
$cli = "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop remove dsh-serper-search
node "...\register-profile-bundle.mjs" "$env:USERPROFILE\.dsh\profiles\desktop" dsh-serper-search --remove
```

Всё сразу (возврат к состоянию до T10):

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$prof\package.json.bak-market-20261030-224316"        "$prof\package.json" -Force
Copy-Item "$prof\pnpm-lock.yaml.bak-market-20261030-224316"      "$prof\pnpm-lock.yaml" -Force
Copy-Item "$prof\pnpm-workspace.yaml.bak-market-20261030-224316" "$prof\pnpm-workspace.yaml" -Force
& $cli plugin --profile desktop install     # приводит node_modules к восстановленному манифесту
# при желании: удалить $prof\.plugin-sources\ru-marketplace-mcp-dsh
```

Если после серии установок локфайл окажется неконсистентным — восстановить `pnpm-lock.yaml` и `package.json` из бэкапов (команды выше) и повторить `install`.

## Что требует ключей/настройки после перезапуска

| Пакет | Что нужно |
|---|---|
| `dsh-serper-search` | ключ serper.dev: переменная `SERPER_API_KEY` (в пакете `apiKeyEnv: SERPER_API_KEY`) либо ввод в UI: Настройки -> Plugins -> `dsh-serper-search` (ключ пишется в credentials, не в файл настроек) |
| `@sandbaseai/dsh-skills` | `SANDBASE_API_KEY` в окружении (по README пакета); без ключа скилы доступны, но API-часть не работает |
| `ru-marketplace-mcp-dsh` | **15 скилов работают сразу**. MCP-серверы выключены, пока не задан `RU_MARKETPLACE_MCP_DIR` (каталог Python-проекта) и не установлен `uv` (Python 3.12+); режимы: `RU_MARKETPLACE_MCP_DECISION` (compare+decision) и `RU_MARKETPLACE_MCP_FULL` (полный, ~17.5k токенов на запрос). Для скила `mpstats-connector` — аккаунт MPStats (`MPSTATS_MP_AUTH`) |
| `dsh-telegram-channel-ru` | токен бота: Настройки -> вкладка «Telegram», или `DSH_TELEGRAM_TOKEN` |
| `superdesign-dsh` | настроек при установке не требует: скил сам предложит `superdesign login` при первом использовании |
| `dsh-skill-browser`, `dsh-scrape-webpage` | ничего не требуют |

## Проверка после перезапуска DSH

1. Полностью закрыть DeepSeek Harness (включая значок в трее -> Выход) и запустить снова — bundle-слой читается только при старте.
2. В каталоге скилов должны появиться: 15 скилов `ru-marketplace` (aliexpress/citilink/dns/lamoda/megamarket/ozon/taobao/wb/yandex-connector, avito/cian/detmir, compare-prices, marketplace, mpstats), скил `superdesign` и скилы SandBase.
3. В UI: панель «браузер скилов» от `dsh-skill-browser`, страница настроек `dsh-serper-search` и вкладка «Telegram».
4. Если профиль не стартует — убрать подозрительный bundle-строку хелпером с `--remove` и/или восстановить `package.json`/`pnpm-lock.yaml` из бэкапов (см. выше). `cordis.patch.yml` для этого не нужен.

## Важное побочное наблюдение: pnpm удаляет «лишние» каталоги node_modules

При hoisted-linker (наш `pnpm-workspace.yaml` -> `nodeLinker: hoisted`) и `pnpm install`, и `dsh plugin ... add` **удаляют из node_modules всё, что не объявлено зависимостью** профиля (в выводе — `Packages: -12` / `-13`). Проверено зондом: созданный вручную каталог `node_modules\dsh-prune-probe` исчез после обоих вызовов (exit 0), при этом `package.json`/**`pnpm-lock.yaml` не менялись.

Следствия для проекта:

* Плагин T1 `dsh-marketing-skills` ставится **копированием** (см. [install-marketing-plugin.ps1](install-marketing-plugin.ps1)), а не через pnpm, поэтому он уязвим для такого прунинга.
* На момент 2026-10-30 22:47 в профиле **нет** `node_modules\dsh-marketing-skills` и **нет** строки `id: marketing-skills` в `cordis.patch.yml`: установку сняли в 22:34:18 (тогда же создан бэкап `cordis.patch.yml.bak-marketing-20261030-223418` — это состояние С установленной строкой, 46139 байт; текущий файл 45781 байт — исходный). Автоматика T10 этот файл не трогала.
* Чтобы вернуть плагин T1 (идемпотентно, восстановит и строку, и каталог):
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Артем\Desktop\тестDH\marketing-agents\install\install-marketing-plugin.ps1"
  ```
  Запускать **повторно после каждой операции pnpm** (любой `dsh plugin add/remove/install`), иначе каталог снова будет удалён.
* Не оставляйте рассогласование: если строка `id: marketing-skills` в `cordis.patch.yml` есть, а каталога `node_modules\dsh-marketing-skills` нет — профиль может не стартовать (загрузчик падает на неразрешимом имени).
* По той же причине сейчас отсутствует и `node_modules\dsh-locale-ru` (ru-locale-пак, если он ставился копированием).

## Известные ограничения / риски

* `github:-спеки` без git не работают в принципе — любой плагин из маркета с git-спекой потребует либо установленного git, либо tarball-URL/локального источника (как здесь).
* Два плагина требуют явного `allow-version` (решение пользователя, риск падения/порчи данных по формулировке CLI).
* `file:`-зависимость № 2 привязана к этой машине (каталог `.plugin-sources`).
* Обновление плагинов — только через CLI/маркет; автоподтягивания нет.


## T11: форс-установка 2 плагинов, картинки/скриншоты, дешёвые модели

### Форс-установка: официальный механизм обхода

Хитростей не потребовалось — CLI сам документирует точный вызов:

```powershell
$cli = "C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop allow-version "@opendsh/dsh-plugin-scheduled-tasks@0.2.4" --dsh-version 0.2.1-rc.5 --accept-risk
& $cli plugin --profile desktop add "@opendsh/dsh-plugin-scheduled-tasks@0.2.4"                                              # exit 0
& $cli plugin --profile desktop allow-version "dsh-creative-studio@0.2.1" --dsh-version 0.2.1-rc.5 --accept-risk
& $cli plugin --profile desktop add "https://github.com/Ylight-cpu/dsh-creative-studio/releases/download/v0.2.1/dsh-creative-studio.tgz"  # exit 0
```

* Исключения пишутся в `<профиль>\compatibility.json`: ключ `<пакет>@<версия>` -> массив версий DSH. Действует только для точной пары пакет+версия.
* creative-studio поставлен по **пинованному** URL релиза v0.2.1 (не `releases/latest`), чтобы версия не «уехала» при следующей установке.
* Бэкапы до правок: `package.json.bak-force-20261031-170634`, `pnpm-lock.yaml.bak-force-20261031-170634`, `pnpm-workspace.yaml.bak-force-20261031-170634`.
* Состав профиля проверен без запуска DSH: `node marketing-agents\install\check-profile-bundles.mjs "%USERPROFILE%\.dsh\profiles\desktop"` -> `RESULT: OK` (30 бандлов, 0 дублей, все патчи парсятся, у каждого бандла есть точка входа или in-box carrier).
* Живое подтверждение: в каталоге скилов текущей сессии появились `image-studio` и `video-studio` — их даёт creative-studio.

### ОДНА команда полного отката T11

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Артем\Desktop\тестDH\marketing-agents\install\force-rollback.ps1"
```

Восстанавливает `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` из самых свежих `.bak-force-*`, снимает оба исключения из `compatibility.json` (с бэкапом `compatibility.json.bak-rollback-<stamp>`), прогоняет `dsh plugin --profile desktop install` (pnpm сам вычистит лишние каталоги) и печатает проверку. Ключи: `-DryRun` (примерка), `-KeepExemptions`, `-Stamp <метка>`.

### Если DSH не стартует после перезапуска

Признаки: приложение не поднимается / ошибка загрузки бандлов / упоминание `scheduled-tasks` или `creative-studio` / сообщение о дубле id. План:

1. `force-rollback.ps1` (команда выше), затем полный перезапуск DSH.
2. Если не помогло — откат на состояние до T10: положить в каталог профиля `package.json.bak-market-20261030-224316`, `pnpm-lock.yaml.bak-market-20261030-224316`, `pnpm-workspace.yaml.bak-market-20261030-224316` (переименовав в рабочие имена) и выполнить `dsh plugin --profile desktop install` — вернёт 19 бандлов и 5 зависимостей.
3. Крайний случай: `dsh rescue --from-default-profile desktop` пересоздаёт профиль из шаблона (ручные настройки и маркет-плагины потеряются).

Причина риска: обе версии приняты через `--accept-risk` — они объявляют требования к in-box семейству DSH, которых у 0.2.1-rc.5 нет.

### Картинки и скриншоты (dsh-vision-router 3.1.0)

1. Скопировать скриншот (Win+Shift+S) или картинку-файл.
2. Включить «👁 Vision» возле поля ввода — переключатель должен показывать `👁 Vision ✓`. **Вставка картинки НЕ включает Vision автоматически.**
3. Вставить в чат (Ctrl+V) или прикрепить файл и отправить.
4. Текстовая модель остаётся «мозгом»: пиксели уходят в vision-модель, а в чат возвращаются результаты инструментов — `vision_describe` (описание/JSON), `vision_ground` (координаты элемента), `vision_crop`, `vision_ocr`, `vision_colors`, `vision_pixel_diff`, `vision_html_screenshot` и др. В UI изображения остаются изображениями.
5. По умолчанию работает встроенная бесплатная цепочка без ключа: `vision-http` / `ovh/Qwen2.5-VL-72B-Instruct`, лимит ≈2 запроса/мин на модель на IP (≈8 RPM суммарно). Это **не офлайн**: картинка анонимно уходит на `oai.endpoints.kepler.ai.cloud.ovh.net`.
6. Лимиты: хостовый `attachments.imageLimits.maxImageDimension` (в контракте плагина 2000 px для ветки rc8 и 8192 px для alpha; точное значение печатает диагностика плагина), своя пред-обработка `downscaleMaxPixels = 4000000` px, кэш ответов `cacheTtlSeconds: 3600` / `cacheMaxEntries: 200`, таймаут вызова `timeoutMs: 120000`.
7. Автоскриншот экрана: инструмент `vision_screenshot` выключен по умолчанию (`desktopScreenshot: false`) — включается осознанно в Settings -> Vision Router.
8. Своя vision-модель задаётся в Settings -> Vision Router (`provider`/`model`, `providers[]`, `httpProviders[]`); для собственной модели в DSH Settings -> Models -> Input types -> Image.
9. Ограничение хоста: если в сессии уже есть изображения, DSH может не дать переключиться обратно на чисто текстовый маршрут; плагин покажет ошибку и сохранит рабочую модель.

Какие модели Zveno принимают изображения (таблица характеристик на страницах zveno.ai, 31.10.2026):

| Принимают изображения | Только текст — картинки нельзя |
|---|---|
| `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-flash-vision-exp`, `z-ai/glm-5.3-flash`, `z-ai/glm-4.6v`, `google/gemini-3.8-flash`, `google/gemini-3-flash-preview`, `qwen/qwen3.8-flash`, `qwen/qwen3-vl-30b-a3b-instruct`, `openai/gpt-6-luna`, `minimax/minimax-m3`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5` | `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-0731`, **`deepseek/deepseek-v4-pro`**, `z-ai/glm-5.3` |

Рекомендация для скриншотов: рядовые — бесплатная цепочка OVH (0 ₽, 2 запроса/мин); если нужен лучший разбор русского UI и текста без лимита — поставить vision-бэкендом `z-ai/glm-5.3-flash` (3,15/6,86 ₽ за 1M, принимает изображения и видео). Не ставить на поток `google/gemini-3-flash-preview` (96,66/579,95 ₽) и `google/gemini-3.8-flash` (144,99/724,94 ₽) — в 30–100 раз дороже за ту же задачу «посмотреть картинку».

### Дешёвые модели: рекомендация с числами

Курс ЦБ на 31.10.2026 — 80,5573 ₽/$. «Типовой ход» = 100k токенов на входе + 20k на выходе (порядок агентской задачи).

| Модель | ₽/1M вход | ₽/1M выход | $/1M вход | $/1M выход | Типовой ход | Картинки |
|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 3,15 | 6,86 | 0,0391 | 0,0852 | **0,45 ₽** | да |
| `deepseek/deepseek-v4.1-flash` | 2,59 | 27,84 | 0,0322 | 0,3456 | 0,82 ₽ | да |
| `deepseek/deepseek-v4-flash-0731` | 11,21 | 27,06 | 0,1392 | 0,3359 | 1,66 ₽ | нет |
| `openai/gpt-6-luna` | 19,33 | 96,66 | 0,2399 | 1,1999 | 3,87 ₽ | да |
| `qwen/qwen3.8-flash` | 29,00 | 90,86 | 0,3600 | 1,1279 | 4,72 ₽ | да |
| `z-ai/glm-5.3` | 13,51 | 270,64 | 0,1677 | 3,3596 | 6,76 ₽ | нет |
| `deepseek/deepseek-v4-pro` | 173,99 | 289,98 | 2,1598 | 3,5997 | 23,20 ₽ | нет |
| `google/gemini-3.8-flash` | 144,99 | 724,94 | 1,7998 | 8,9991 | 29,00 ₽ | да |
| `anthropic/claude-sonnet-5.5` | 386,63 | 1933,17 | 4,7998 | 23,9994 | 77,33 ₽ | да |
| `anthropic/claude-opus-5.5` | 773,27 | 3866,35 | 9,5992 | 47,9959 | 154,65 ₽ | да |

* **Агент по умолчанию** — оставить `deepseek/deepseek-v4.1-flash` (уже модель профиля): 0,82 ₽ за типовой ход, принимает изображения, контекст 1M.
* **Подагенты и лёгкие задачи** — `z-ai/glm-5.3-flash`: 0,45 ₽ за типовой ход, в 1,8 раза дешевле v4.1-flash и в 51 раз дешевле v4-pro, при этом мультимодальна. Это значение для `flashModel` в `dsh-delegate-router`.
* **Сложный анализ** — `openai/gpt-6-luna` (3,87 ₽) как ступень выше Flash; `deepseek/deepseek-v4-pro` (23,20 ₽) держать для действительно трудных задач, помня, что он НЕ принимает картинки.
* **Не тратить** на рутину Claude Sonnet/Opus (77–155 ₽ за ход) и Gemini 3.8 Flash (29 ₽) — та же работа в 35–190 раз дороже, чем у glm-5.3-flash.
* Скидка подписки ZvenoAI (−45% на часть моделей) в расчёте не учтена — она только улучшает эти числа.

Настройка `dsh-delegate-router` 0.4.5 (файл `%USERPROFILE%\.dsh\dsh-delegate-router.json`, сейчас отсутствует — работают дефолты; ключ режима — `/delegate status`):

```json
{
  "flashProvider": "zvenoai",
  "flashModel": "z-ai/glm-5.3-flash",
  "proProvider": "zvenoai",
  "proModel": "openai/gpt-6-luna"
}
```

### prices.yaml

`marketing-agents/registry/prices.yaml` (schema `prices/v1`): 16 моделей — `rub_per_1m_in/out`, `rub_per_1m_cache_read`, `usd_per_1m_in/out`, `usd_per_1m_cache_read`, `accepts_images`, `context_tokens`, `rub_per_typical_turn_100k_in_20k_out`, `source`; плюс `rate.usd_rub` и дата курса. Файл проверен js-yaml из профиля: `schema=prices/v1, models=16, rate=80.5573`. Цены — минимальные среди провайдеров модели (на странице это «от N ₽ за 1M»), источник — страницы `https://zveno.ai/models/<id>`.


## T17: публичная тестовая копия дашборда (только чтение)

* Сборка: `marketing-agents/install/publish/build-publish.mjs` -> `publish/site/` (статика + @data/state.json@ + @data/state.js@), баннер «Тестовая копия • только просмотр • данные на …» в @index.html`.
* Секреты: сборка заканчивается шлюзом (значения ключей, @sk-…@, @Bearer …@, @.credentials.yaml@, JSON-поля @apiKey/token/secret@) -> `ResULT: OK`, отчёт в @publish/scan-report.json@.
* Записи нет by design: приложение в режиме STANDALONE отключает правку реестра и пересборку, а статический сервер отдаёт только GET/HEAD; @POST/PUT/DELETE@ -> 405, @/api/*@ -> 404 (проверено локально и снаружи).
* **cloudflared quick tunnel заблокирован сетью**: @Post https://api.trycloudflare.com/tunnel: context deadline exceeded@ (DNS и TCP открыты, HTTPS-запрос к API не проходит). Вариант оставлен как @-Tunnel cloudflared@.
* **Рабочий вариант — localhost.run** (SSH, порт 22 открыт): @ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:8899 nokey@localhost.run@ -> ссылка вида @https://<random>.lhr.life@. Проверено фактически снаружи: 200 + русский заголовок дашборда + баннер. Живая ссылка на момент отчёта: `https://f0acbdbca90edf.lhr.life`.
* pinggy через 443: SSH-соединение устанавливается, но адрес в выводе не появляется за 45 с — как рабочий не подтверждён.
* Важно: IPv6 на этой машине не работает, поэтому в проброс идёт @127.0.0.1:8899@, а не @localhost:8899@ (с @localhost@ было 502).
* Ошибка, которую я допустил и исправил: в @last-url.txt@ однажды попал служебный @api.trycloudflare.com@ (жадный шаблон поймал строку из лога cloudflared). Теперь шаблон строгий (@https://(?!api\.)[a-z0-9-]+\.(a\.pinggy\.link|lhr\.life|localhost\.run|serveo\.net|trycloudflare\.com)@) и адрес пишется в файл только после проверки 200 + заголовка.
* Команды: @-Start@ (по умолчанию @-Tunnel auto@: pinggy -> localhost.run -> serveo -> lan), @-Start -Tunnel localhostrun@, @-Status@, @-Stop@ (гасит и сервер, и туннель), @-Start -Rebuild@.
* LAN-режим: @-Start -Tunnel lan@ (сервер на @0.0.0.0:8899@, адрес @http://<локальный-IP>:8899@) + при необходимости правило брандмауэра: @New-NetFirewallRule -DisplayName "Dashboard 8899 (LAN test)" -Direction Inbound -Protocol TCP -LocalPort 8899 -Action Allow@.
* Решение пользователя: постоянную панель публикуем через Тильду; туннель — только для живого просмотра. Ссылка временная и меняется при каждом @-Start@, авторизации нет (видит любой, у кого она есть).
* Подробности и инструкции: `marketing-agents/install/README-publish-dashboard.md`.



## Согласованность профиля (T20, 31.10.2026)

**Что было сломано.** В `dsh.profile.bundles` не было `dsh-vision-router` и `dsh-delegate-router`, хотя оба стояли в `dependencies` — то есть не загружались: картинки через vision-router не работали, дешёвый роутинг подагентов тоже. Рядом висела форс-пара `@opendsh/dsh-plugin-scheduled-tasks` и `dsh-creative-studio`: в `dependencies` есть, в `bundles` нет, а исключения совместимости остались в `compatibility.json`. Такое расхождение и считается вероятной причиной того, что при холодном старте список бандлов срезался (30 -> 26).

**Что сделано.**
1. Бэкапы до правок: `package.json.bak-consistency-20261031-182558`, `pnpm-lock.yaml.bak-consistency-20261031-182558`, `pnpm-workspace.yaml.bak-consistency-20261031-182558`, `compatibility.json.bak-consistency-20261031-182558`, `cordis.patch.yml.bak-consistency-20261031-182558` (в каталоге профиля).
2. Форс-пара удалена: `dsh plugin --profile desktop remove @opendsh/dsh-plugin-scheduled-tasks dsh-creative-studio` -> exit 0. Каталогов в `node_modules` нет, в `dependencies` нет, в `bundles` не было; `compatibility.json` очищен (сейчас `{}`).
   Важно: `remove` принимает ИМЕНА пакетов, а не `pkg@version` — с версиями pnpm отвечает `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`.
3. Включены в `dsh.profile.bundles` (идемпотентным `register-profile-bundle.mjs`): `dsh-vision-router` (changed: true) и `dsh-delegate-router` (changed: true). Оба лежат в `node_modules`, у обоих есть точка входа и @dsh.bundle.patch@.
4. Проверка согласованности: `node marketing-agents\install\check-profile-bundles.mjs "%USERPROFILE%\.dsh\profiles\desktop"` -> **RESULT: OK**, 0 дублей, 16 вставленных id без конфликтов.

**Числа до/после.**

| Показатель | До T20 | После T20 |
|---|---|---|
| dependencies | 16 | **14** |
| dsh.profile.bundles | 26 | **28** |
| дубликатов в bundles | 0 | **0** |
| форс-пара в deps / node_modules / compatibility.json | да / да / да | **нет / нет / нет** |
| vision-router и delegate-router в bundles | нет | **да** |

Сверка «каждая запись dependencies либо в bundles, либо объяснена»: все 14 записей `dependencies` присутствуют в `bundles`; 14 записей `bundles` без dependency — это in-box бандлы `@deepseek-ai/*` из поставки DSH (объяснены, ставятся приложением).

**ОДНА команда откатa к состоянию до T20** (вернёт и форс-пару, и исключения):

powershell```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Артем\Desktop\тестDH\marketing-agents\install\restore-profile-consistency.ps1"
```

(есть `-DryRun` для примерки и `-Stamp <метка>`; после отката нужен перезапуск DSH)

**Проверить при следующем перезапуске:** профиль должен подняться, `bundles` остаться 28 (или больше, но не меньше), а vision/delegate — загрузиться. Если список снова срежется: восстановить `*.bak-market-20261030-224316` (состояние до T10) либо `*.bak-consistency-20261031-182558` и сообщить.


## T22: стабильная внешняя ссылка для панели (итог 31.10.2026)

**Сейчас работает** (только read-only копия, потому что ключа из T21 ещё нет):
@https://de29a718b72b7af1-109-252-128-47.serveousercontent.com@ — serveo.net, проверено снаружи: 200, русский заголовок и баннер на месте, POST/PUT/DELETE -> 405 (записи нет). Адрес записан в @install/publish/last-url.txt@ и @dashboard/config/live-url.txt@.

**Почему адрес не закреплён.** serveo.net на бесплатном тарифе сам отвечает на попытку закрепить имя:
@Tip (1): Add your SSH key to reserve names and keep URLs stable@ — то есть закреплённый поддомен требует ЗАРЕГИСТРИРОВАННОГО SSH-КЛЮЧА в аккаунте serveo. Без него сервис выдаёт случайное имя вида @<hash>-<ip>.serveousercontent.com@ (проверено дважды: @dsh-agents-7f3c@ проигнорирован). Скрипт уже передаёт поддомен и понимает оба вида адреса, поэтому после регистрации ключа имя станет постоянным без правок.

**Что нужно от пользователя для СТАБИЛЬНОЙ ссылки (любой из вариантов):**

1. serveo.net с закреплённым именем (бесплатно, рекомендуем):
   `@powershell
   ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519_serveo" -N '""'   # если ключа ещё нет
   Get-Content "$env:USERPROFILE\.ssh\id_ed25519_serveo.pub"                    # публичный ключ -> вставить на https://console.serveo.net
   # после регистрации ключа:
   ssh -i "$env:USERPROFILE\.ssh\id_ed25519_serveo" -o StrictHostKeyChecking=no -R dsh-agents-7f3c:80:127.0.0.1:8787 serveo.net
   `@
   Ожидаемый постоянный адрес: @https://dsh-agents-7f3c.serveo.net@ (имя можно поменять параметром @-Subdomain@).
2. tuna.am — платформа с аккаунтом (вход/токен) и клиентом для Windows; на бесплатном тарифе даёт фиксированный поддомен. Нужен аккаунт пользователя: скачать клиент с tuna.am, войти, затем команда туннелирования из их документации (@tuna http 8787@). Сам аккаунт я не создавал.
3. ngrok free — статический домен выдаётся бесплатному аккаунту, но нужен authtoken ПОЛЬЗОВАТЕЛЯ:
   `@powershell
   # 1) зарегистрироваться на ngrok.com, скопировать authtoken из Dashboard -> Your Authtoken
   # 2) после установки клиента:
   ngrok config add-authtoken <AUTHTOKEN>
   ngrok http 8787 --domain=<ваш-статический-домен>.ngrok-free.app
   `@
   Аккаунт и токен — только пользователь; я их не создавал и не запрашивал.

**Как обновлять адрес (вариант без стабильного имени, уже работает).** Каждый @-Start@ пишет свежий адрес в два файла: @marketing-agents/install/publish/last-url.txt@ (для человека) и @marketing-agents/dashboard/config/live-url.txt@ (машиночитаемо, для дашборда/Тильды). После перезапуска достаточно перечитать @live-url.txt@ — витрина на Тильде подставит новый адрес.

**Живая панель 8787 (тумблеры) — когда включать.** Публиковать 8787 наружу можно только после T21, когда появится @marketing-agents/dashboard/config/access.key@. Скрипт это проверяет и отказывается:

`@powershell
# read-only копия (безопасно всегда):
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\install\publish-dashboard.ps1 -Start -Tunnel serveo
# живая панель 8787 (только после появления access.key):
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\install\publish-dashboard.ps1 -Start -Target live -Tunnel serveo
`@

Если ключа нет, @-Target live@ падает с сообщением «живой сервер 8787 нельзя публиковать без ключа». Это намеренная защита: @dashboard/serve.mjs@ сейчас отдаёт тумблеры без авторизации, поэтому наружу его выставлять нельзя.

**Проверка 401 без ключа.** Сделать её пока невозможно: файла @access.key@ нет (задача T21 не завершена), а значит и защищать нечего — живой сервер наружу не публикуется. Эквивалентная проверка для read-only копии пройдена: POST/PUT/DELETE по публичному адресу -> 405. Как только появится @access.key@: @-Start -Target live@ и проверка @POST /api/agents/<id>/toggle@ без ключа (ожидаем 401).

**Провайдеры в @publish-dashboard.ps1@:** @-Tunnel serveo|localhostrun|pinggy|cloudflared|lan|auto@ (по умолчанию @auto@: serveo -> localhost.run -> pinggy), @-Target readonly|live@, @-Subdomain <имя>@, @-Stop@ гасит и сервер, и туннель. cloudflared остаётся заблокированным (api.trycloudflare.com), localhost.run работает со случайным @*.lhr.life@.
