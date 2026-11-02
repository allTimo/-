# Коннектор Циан/Авито для Агента 1 (ru-marketplace-mcp, «вызвал и отпустил»)

Дополнительный источник для Агента 1: Циан и Авито (плюс ещё 10 площадок того же коннектора).
Главное: MCP **не монтируется** в профиль — схемы инструментов не висят в контексте и не оплачиваются
токенами на каждом запросе. Вместо этого движок вызывает обёртку, она поднимает сервер по stdio,
делает **один** вызов инструмента и возвращает JSON.

## Что установлено

| Компонент | Где | Версия/статус |
|---|---|---|
| Python | бандл DSH @.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe@ | 3.12.14 |
| uv (standalone, без PATH) | `marketing-agents\connectors\bin\uv.exe` | 0.13.6 |
| Репозиторий коннектора | `marketing-agents\connectors\ru-marketplace-mcp` | main (скачан tarball'ом: **git в системе нет**) |
| Python-окружение | `ru-marketplace-mcp\.venv` | `uv sync --frozen` -> exit 0, коннекторы 2.7.0 |
| Chrome оператора | CDP `127.0.0.1:9222` | доступен (1 контекст) |

## Как вызвать

`@powershell
$c = "C:\Users\Артем\Desktop\тестDH\marketing-agents\connectors"

# список инструментов (диагностика)
powershell -NoProfile -ExecutionPolicy Bypass -File "$c\run-connector.ps1" -ListTools

# один вызов: аргументы из файла (рекомендуется)
#   args.json: {"deal":"sale","region":"1","rooms":[2],"page":1}
powershell -NoProfile -ExecutionPolicy Bypass -File "$c\run-connector.ps1" -Tool cian_search -ArgsFile "$c\out\cian_search.args.json"

# один вызов: аргументы строкой (только из PowerShell-переменной!)
$json = '{"deal":"sale","region":"1","rooms":[2]}'
& "$c\run-connector.ps1" -Tool cian_search -Args $json

# поиск ВНУТРИ одного ЖК (клиентский фильтр — сервер Циан такой фильтр игнорирует)
powershell -NoProfile -ExecutionPolicy Bypass -File "$c\run-connector.ps1" -Tool cian_search -ArgsFile "$c\out\cian_search.args.json" -Newbuilding "Клубный дом ОПУС" -Pages 2

# тот же вызов, но результат дополнительно пишется в файл (движку не нужно ловить stdout)
powershell -NoProfile -ExecutionPolicy Bypass -File "$c\run-connector.ps1" -Tool cian_search -ArgsFile "$c\out\cian_search.args.json" -Newbuilding "Клубный дом ОПУС" -Pages 2 -Out "$c\out\nb.json"
`@

Возврат — один JSON в stdout:

`@json
{
  "ok": true, "tool": "cian_search", "server": "marketplace-mcp", "elapsed_ms": 5441, "is_error": false,
  "payload": { "status": "success", "tier_used": "cdp", "count": 28, "total_count": 17693, "items": [ ... ] },
  "result": { "content": [ { "type": "text", "text": "{...}" } ] }
}
`@

**Режим фильтра по ЖК** (@-Newbuilding@ + @-Pages@, либо @--newbuilding@/@--pages@ у .mjs) возвращает другой конверт:
@{"mode":"newbuilding-filter (client side: Cian ignores a server-side filter)","filter":{"newbuilding":"…","pages_scanned":2},"scanned":56,"matched":4,"per_page_items":[28,28],"items":[… только этот ЖК …]}@.
Это фильтрация СКАЧАННЫХ страниц (по умолчанию 1, максимум 5).

**@--out <файл>@ (у .ps1: @-Out@)** дополнительно пишет тот же JSON в файл — удобно движку, но stdout по-прежнему содержит результат.

**Для data-engine (task-70):** берите готовое поле `payload` — это уже распарсенный JSON инструмента
(@result` оставлен как сырой ответ MCP). При `is_error: true` или `ok: false` смотрите `error` и
`server_stderr_tail`. Коды возврата: 0 — успех, 3 — ошибка транспорта/аргументов.

## Проверено фактически (01.11.2026)

CLI-канарейка всех коннекторов:

`@text
uv run --frozen --directory <клон> marketplace-mcp doctor
  7 healthy, 6 blocked/inconclusive, 0 drifted
  ok  cian           success   search:healthy, card:healthy      <-- наш источник
  ok  avito          success   search:healthy, card:healthy, seller:healthy
  ok  ozon / yandex_market / detsky_mir / lamoda / aliexpress    success
  blk wildberries / taobao / megamarket / dns / citilink / mpstats  inconclusive (свои next-шаги)
  Chrome CDP: reachable on 127.0.0.1:9222 (1 context(s)).
`@

Реальный вызов через обёртку:

`@text
run-connector.ps1 -Tool cian_search -ArgsFile out\cian_search.args.json
  wrapper exit=0, elapsed 5.4 s
  status=success  tier_used=cdp  count=28  total_count=17693   (Москва, продажа, 2 комнаты)
  примеры строк: 100 455 970 ₽ | 2к | 91.1 м² | ЖК «Клубный дом ОПУС» | Дербеневская наб., 5
                 11 100 000 ₽ | 2к | 32.6 м² | ЖК «Новые Ватутинки» | район Троицк
                 37 500 000 ₽ | 2к | 52 м²   | ул. Зацепа, 22
`@

Сырой ответ сохранён: `marketing-agents\connectors\out\cian_search.sample.json`, аргументы —
`out\cian_search.args.json`.

## Грабли, которые уже пройдены

* **`region` — строка, не число.** `{"region":1}` даёт ошибку pydantic `Input should be a valid string`;
  правильно `{"region":"1"}`. Идентификаторы: 1 Москва, 2 Санкт-Петербург, 4593 Московская обл., 4588 Ленинградская обл.
* **Нет текстового поиска.** «Двушка у метро Сокол» — это `rooms=[2]` + `region` + диапазон цен;
  фильтров по метро/улице нет, фильтруйте выданные строки сами.
* **«Новостройки» не отдельный фильтр,** но выдача это содержит: у подходящих строк есть
  `category: "newBuildingFlatSale"`, `newbuilding_name`, `seller_type: "developer"` — Агенту 1 фильтровать по ним.
* **JSON в `-Args` теряет кавычки при вызове через `powershell.exe -File`** — поэтому основной способ
  передача файлом через `-ArgsFile` (или переменной внутри уже запущенной сессии).
* В сессии DSH выполнение сценариев отключено политикой, поэтому вызов только через
  `powershell -ExecutionPolicy Bypass -File ...` (как в примерах).

## Chrome по CDP

Коннектор поднимает страницы в отладочном Chrome. Если порт не отвечает:

`@powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Артем\Desktop\тестDH\00-admin\scripts\start-chrome-cdp.ps1"
`@

Вход в аккаунты Циан/Авито не требуется. При жалобах источника на IP коннектор отвечает
`tier_used: "cdp"` (прошли через браузер) либо ошибкой с полем `server_stderr_tail` — смотрите диагностику
`marketplace-mcp doctor` (там для каждого источника прописан свой next-step).

## Почему не монтируем MCP постоянно

По документации плагина профиля схемы инструментов висят в контексте на **каждом** запросе:
~2.2k токенов для `compare-mcp`, ~2.4k для `decision-mcp`, ~17.5k для полного `marketplace-mcp`.
Поэтому строки MCP в `cordis.patch.yml` остаются **выключенными** и `RU_MARKETPLACE_MCP_DIR` в профиль
мы не прописываем: обёртка передаёт путь сама (`RU_CONNECTOR_DIR`) и поднимает сервер только на время вызова.
