# Передача: Агент 1 «Мониторинг конкурентов» — состояние на 03.11.2026, 22:05

Рабочий каталог: `C:\Users\Артем\Desktop\тестDH`, проект — `marketing-agents`.
Цель сессии (goal-c7e4a836-e498-4213-bf70-48ab1d6a11d4) активна, но разоружена: в новой сессии
её надо возобновить (`update_goal action resume`) после просьбы пользователя продолжить.

## Что уже сделано (не переделывать)

### WP1 — task-3, completed (исполнитель config-dev)
- Расписание: четверг 11:00 — `registry/agent-settings/agent-1-competitor-watch.yaml' (days `[4]`, time `11:00`),
  `registry/agents.yaml` (`weekly:thursday:11:00`), `registry/services.yaml`, `00-admin/runbook.md`,
  `01-competitor-watch/config/clients/client-svet.yaml` и `client-granel.yaml`.
- Доставка: `delivery.channels: [telegram, email]`, адреса `@svet_marketing`, `tyurina@d-a.ru`, `vodnev@d-a.ru`,
  `auto_send: true`; то же в recipients клиентских конфигов.
- Тумблеры аналитики `agent1.analytics.*` (8 ключей: enabled, lots_all_on_sale, price_dynamics, promos,
  new_promos_only, dedup_promos, developers_sites, forecast) и одно поле `agent1.watch.query`.
- SMTP-транспорт в `00-admin/config/settings.yaml` (`delivery.email`, `send_mode: auto`) — **пустой, нужны креды**.
- Обновлены `registry/README-agents-settings.md`, `README-services.md`.
- Проверено: `validate_config.py` OK; js-yaml парсит все 7 YAML; `verify-data.mjs` — 1 FAIL вне зоны конфигов
  («худшее расхождение по сессии 5.83%», проекция сессий/логов).

### WP2 — task-4, completed (исполнитель engine-dev)
- Новые модули (только stdlib): `01-competitor-watch/scripts/analytics.py`, `scripts/delivery_email.py`.
- `cwlib.load_agent_settings` читает `agent1.analytics` (нет ключа → true).
- JSON аналитики: `01-competitor-watch/reports/clients/<client-id>/.cache/analytics-<YYYY-MM-DD>.json`
  (ключи: schema_version, date, generated_at, client_id, toggles, by_competitor, by_source, dynamics,
  promos_new, promos_known_count, forecast, email, data_status).
- Акции: дедуп по (проект, текст, статус) + режим «только новые»; 9 нумерованных разделов отчёта сохранены,
  блок аналитики — ненумерованный; лист «Аналитика» в xlsx.
- Почта: smtplib; без SMTP-доступа письмо сохраняется как `<date>-competitor-watch.eml` + честный статус
  в `.cache/email-<date>.json`; статус пишется в журнал `registry/runs.jsonl`.
- Прогноз: МНК-тренд недельной медианы ₽/м² при ≥3 точках (`method="trend-linear"`, `estimate: true`), иначе `null` + причина.
- Тесты: `...\connectors\ru-marketplace-mcp\.venv\Scripts\python.exe -m pytest marketing-agents\01-competitor-watch\tests -q`
  → **268 passed** (было 238).

### WP4 — сделал Lead
- Плагин `dsh-marketing-skills` установлен в профиль `desktop` (node_modules + строка `marketing-skills`
  в `cordis.patch.yml`, бэкап `cordis.patch.yml.bak-marketing-20261103-214622`).
  Скилы `competitor-watch`, `direct-keywords`, `newbuild-ru-glossary` уже видны в каталоге сессии.
- Планировщик Windows: задача `Agent1-Weekly` из `install/agent1-weekly-task.xml`,
  Next Run **05.11.2026 11:00**, действие — `install/agent1-weekly.cmd` (находит Python, гонит
  `collect_clients.py` по всем клиентам, лог `marketing-agents/logs/agent1-weekly.log`).
- Исправлено расписание в `START-HERE.md` и `01-competitor-watch/inbox/README.md` (было «понедельник»).
- Важно: системного Python на машине нет. Рабочий интерпретатор —
  `marketing-agents\connectors\ru-marketplace-mcp\.venv\Scripts\python.exe` (3.12.14, PyYAML, pytest).
  Движок обязан оставаться на stdlib.

### WP3 — task-5, НЕ ЗАВЕРШЕНО (panel-dev остановлен по просьбе пользователя)
Код в основном написан, но отчёта и приёмки нет. Изменённые/новые файлы (dashboard/**):
`collector/lib/agent1-status.mjs`, `collector/lib/competitor-analytics.mjs`, `collector/lib/agent-settings.mjs`,
`collector/lib/paths.mjs`, `collector/lib/yaml.mjs`, `collector/collect.mjs`, `serve.mjs`,
`public/app-views12.js`, `public/app-views15.js`, `public/index.html`, `public/styles.css`, `verify-data.mjs`,
`public/data/*.json` (пересобраны 22:02, включая `agent1-status.json`, `competitor-analytics.json`),
`_ux-harness/*`, `screenshots/wp3-agent1-toggles-query-status.png`,
`screenshots/wp3-analytics-competitors-empty.png`, `README.md`.
Задача снята с исполнителя (released → pending), зависимая task-6 остаётся заблокированной.

## Что осталось сделать

1. **Дoвести WP3 (task-5)** и получить отчёт: тумблеры `agent1.analytics.*` на карточке Агента 1,
   одно поле «название проекта или сайт» (`agent1.watch.query`) с автозапуском подбора,
   индикатор «работа сделана / не сделана», раздел «Аналитика» из JSON движка,
   прогон `node dashboard/verify-data.mjs` и `ux-check.mjs`.
2. **WP5 (task-6)** — независимая приёмка: расписание, корректность списка конкурентов,
   почта (адреса/статусы), реальное влияние каждого тумблера, дедуп акций, прогоны.
   Отчёт: `05-verification/agent-1-acceptance-<date>.md`.
3. **Уборка инфраструктуры:** в `01-competitor-watch/tests/.tmp-run` осталось ~130 пустых каталогов
   `mkdtemp` с DACL `0o700` — из песочницы не удаляются (`icacls: Access denied`), нужен full access
   или ACL-repair. Причина уже закрыта в `tests/conftest.py`.
4. **После перезапуска DSH** убедиться, что скилы проекта и плагин в профиле на месте
   (`install/check-profile-bundles.mjs`).

## Требуется от пользователя (без этого не закрыть)

- SMTP: `smtp_host`, `smtp_user`, `from` + пароль в env `DSH_SMTP_PASSWORD` — тогда письма реально уходят;
  сейчас формируется `.eml` со статусом «не отправлено: нет SMTP-доступа».
- Подтвердить список конкурентов по client-svet (6 ЖК: Дмитровское небо, Селигер Сити, Онежский вал,
  Кинетик, Акценты, Михалковский) — верный ли состав и район/класс.
- Канал для `client-granel` (сейчас получил `@svet_marketing` по тексту контракта).
- Нужен ли Авито (сейчас `blocked 439` / `enabled:false`) — для него нужен Chrome CDP.
- Ключи Keys.so/SpyWords и геокодера (иначе бюджеты и координаты — оценка с пометкой).

## Известные несоответствия (не потерять)

- `report.sections` в настройках Агента 1 = 5, а фактический отчёт = 9 нумерованных разделов
  (контракт отчёта — 9, менять нельзя).
- Движок шлёт почту независимо от `delivery.channels` — политика гейта не утверждена.
- `verify-data.mjs`: 1 FAIL «худшее расхождение по сессии 5.83%» — существовавший до работ.
- Каталог `.gh-upload/` — зеркало для публикации, его не трогать.
