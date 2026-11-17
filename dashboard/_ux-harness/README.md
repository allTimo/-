# Стенды и офлайн-тесты панели (`_ux-harness`)

Зачем это здесь: `ux-check.mjs` — замороженный инструмент приёмки, и он требует Chrome
с отладочным портом. В песочнице исполнителя Chrome не запускается (выход `-36863`),
поэтому проверки панели продублированы офлайн-набором, который не требует браузера и сети.

## Запуск

    node marketing-agents/dashboard/_ux-harness/test-contract.mjs
    node marketing-agents/dashboard/_ux-harness/test-render.mjs
    node marketing-agents/dashboard/_ux-harness/test-analytics-pickup.mjs
    node marketing-agents/dashboard/_ux-harness/build-harness.mjs
    node marketing-agents/dashboard/_ux-harness/test-toggle-e2e.mjs http://127.0.0.1:8789

Все скрипты возвращают 0 при успехе и печатают строки `OK` / `FAIL`.

## Что проверяет каждый

| Скрипт | Что доказывает | Браузер |
|---|---|---|
| `test-contract.mjs` | список тумблеров аналитики совпадает в 4 местах (сборщик, сервер, валидатор, интерфейс); `validateAnalytics` ловит недопустимые и неизвестные значения | нет |
| `test-render.mjs` | код `app-views15.js` реально строит блоки: пустое состояние с причиной, таблицы только с данными, индикатор прогона, одно поле `query`, скрытые параметры ЖК | нет (DOM-заглушка) |
| `test-analytics-pickup.mjs` | подхват `analytics-<дата>.json`: лоты, медианы, динамика, новые акции, прогноз, выбор новейшего файла, битый JSON, статус почты | нет |
| `test-toggle-e2e.mjs` | запись тумблера и `query` через HTTP, `.bak`, свежее состояние в `/api/state`, список копий, откат и совпадение SHA-256 | нет (нужен сервер) |
| `test-selection-e2e.mjs` | группа «Что анализировать»: чтение 15 полей `agent1.selection`, запись числа/bool/enum/списка, запреты (диапазон, enum, мусор в списке, чужое поле), создание отсутствующего блока, откат по SHA-256 | нет (нужен сервер) |
| `test-agent1-card.mjs` | карточка Агента 1: только маркетинговые группы, заголовки «Охват и радиус»/«Что анализировать»/«Сравнение и выводы», поля watch видимы, системные группы не рендерятся, вёрстка в одну колонку, кнопка «Детали» вместо автодровера | нет (DOM-заглушка) |
| `build-harness.mjs` | собирает автономные HTML-стенды `agents.html` и `analytics.html` на реальных данных — их можно открыть в обычном браузере | — |

## Как поднять сервер для e2e-теста (не трогая `registry/**`)

    $env:DASHBOARD_PORT=8789
    $env:DASHBOARD_ACTIONS_DRY_RUN=1
    $env:DASHBOARD_AGENT_SETTINGS_DIR="<абсолютный путь к dashboard/_ux-harness/tmp/agent-settings>"
    node marketing-agents/dashboard/serve.mjs

Тест сам копирует реальные настройки агента в `tmp/` и работает только с копией:
реестр `registry/**` при прогоне не меняется. `tmp/` — временная папка, её можно удалять.

## Ограничение

Это не замена `ux-check.mjs`: здесь не проверяются вёрстка, видимость элементов и поведение
меню/модалов. Полный прогон `ux-check.mjs` на живой панели должен сделать тот, у кого Chrome
запускается (см. `dashboard/UX-CHECK-FROZEN.md`).
