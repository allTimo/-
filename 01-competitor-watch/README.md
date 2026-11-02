# Агент 1 — Конкурентный мониторинг

Коротко: раз в неделю агент собирает данные о конкурентах (цены, акции, предложение),
сравнивает с прошлой неделей и присылает отчёт на русском:
`reports/<YYYY-MM-DD>-competitor-watch.md` + `.xlsx`.

**Прочитать за 15 минут:** сначала [00-admin/runbook.md](../00-admin/runbook.md) (регламент целиком),
затем этот файл. Заполнить нужно всего 3 файла в [00-admin/config/](../00-admin/config/).

---

## 1. Из чего состоит цикл (пайплайн)

```
сайты застройщиков (обычный HTTP)  ->  data/snapshots/<дата>/lots.csv  ->  diff  ->  reports/
(Циан и Авито ОТЛОЖЕНЫ)                (единая таблица лотов)                        <дата>-competitor-watch.md
inbox/ (скриншоты, выгрузки, PDF)      source=site                                  <дата>-competitor-watch.xlsx
                                                                                     .cache/diff-<дата>.json
```

1. **Источники.** Основной путь с 31.10.2026 — **официальные сайты застройщиков** (`site_url`
   в [competitors.yaml](../00-admin/config/competitors.yaml)), обычный HTTP без авторизации:
   скрипт [collect-developer-sites.mjs](../00-admin/scripts/collect-developer-sites.mjs)
   снимает позиции каталога, [build-snapshot-from-site.py](../00-admin/scripts/build-snapshot-from-site.py)
   собирает из них снимок с `source=site`.
   **Циан и Авито отложены** по решению пользователя (2026-10-31) — их ссылки в конфиге
   сохранены на будущее, в цикле не используются.
   Всё, что собрано руками (скриншоты, выгрузки, сохранённые страницы, PDF), по-прежнему
   кладётся в [inbox/](inbox/); правила имён — в [inbox/README.md](inbox/README.md).
2. **snapshot — снимок.** Вы переносите данные из inbox в единую таблицу лотов
   `data/snapshots/<YYYY-MM-DD>/lots.csv` по жёсткому контракту данных (см. §4).
   Движок помогает: `snapshot_tool.py new <дата>` создаёт файл-каркас с пример-строкой,
   `normalize` приводит типы, досчитывает `price_per_m2_rub`, убирает дубли и сортирует,
   `validate` проверяет схему и значения (код 0 = можно строить отчёт).
   Снимок — это «фотография» рынка на дату. Старые снимки не удаляются: без них не будет Δ.
3. **diff — сравнение.** Текущий снимок сопоставляется с прошлым по ключу лота
   `(source, competitor, project, lot_id)`. Считаются изменения цены, появление/исчезновение
   лотов, новые и закончившиеся акции. Изменения меньше порога из settings.yaml считаются шумом.
   Результат — `reports/.cache/diff-<дата>.json`.
4. **report — отчёт.** Собирается по шаблону [templates/weekly-report.md](templates/weekly-report.md)
   строго из 9 разделов, сохраняется в двух форматах: `reports/<YYYY-MM-DD>-competitor-watch.md`
   и `.xlsx` (плюс совместимая копия в `reports/<YYYY-MM-DD>/weekly-report.*`).

---

## 1.1. Работа по клиентам (с 01.11.2026)

Отчёт собирается **под конкретного клиента**. Конфиг клиента лежит рядом с агентом:

```
01-competitor-watch/config/clients/client-svet.yaml      # ЖК «Свет» (Dominanta)
01-competitor-watch/config/clients/client-granel.yaml    # СЗ «Гранель» — Селигер Сити
```

Что внутри (контракт зафиксирован Lead):

| Блок | Зачем |
| --- | --- |
| `client_id`, `name` | идентификатор и название клиента (в шапке отчёта) |
| `brand` | логотип и акцентный цвет — блок «бренд клиента» |
| `schedule` | в какой день и во сколько присылать отчёт |
| `report` | заголовок и форматы (md / xlsx / pdf) |
| `recipients` | telegram / email получателя |
| `sources` | какие площадки включены и как (`mode: public-pages`, `auth: none`) |
| `competitors` | конкуренты: сайт застройщика + ссылки на площадках |
| `our_objects` | наш ЖК (связка с `00-admin/config/my-objects.yaml`) |

Глобальные переключатели — [registry/sources.yaml](../registry/sources.yaml); клиентский файл
их переопределяет. Глобальные конфиги (`00-admin/config/*.yaml`) остаются настройками по умолчанию.

**Источники по публичным страницам, без входа в кабинет** (решение пользователя, проверка 01.11.2026):

| Источник | Без входа | Комментарий |
| --- | --- | --- |
| cian | ✅ HTTP 200 | страница ЖК отдаёт лоты с ценами прямо в HTML (проверено на 10 ЖК) |
| yandex-realty | ✅ HTTP 200 | цена видна; часть ЖК не находится в каталоге площадки |
| avito | ❌ HTTP 439 | «Доступ ограничен: проверка безопасности» |
| domclick | ❌ HTTP 401 | закрыт для обычного HTTP |
| developer-sites | ⚠️ частично | цены часто только в JS; ПИК отвечает 401 |

Таблица проверки: [00-admin/research/platforms-public-pages-2026-11-01.md](../00-admin/research/platforms-public-pages-2026-11-01.md).
Где ссылки нет — в конфиге стоит пустая строка и комментарий `TODO` (что нужно от пользователя).

Проверка конфигов (включая клиентские) одной командой:

```powershell
& $py marketing-agents/00-admin/scripts/validate_config.py    # $py — python рантайма DSH
```

---

## 2. Что автоматизировано, а что делает человек

| Шаг | Автоматически | Нужен человек |
|---|---|---|
| Сбор данных с Циан / Авито / Яндекс Недвижимости | ❌ (антибот, капча, JS-рендер) | ✅ вручную: выгрузки, скриншоты, сохранённые страницы |
| Перенос данных из файлов inbox в `lots.csv` | ❌ автозагрузчика нет | ✅ перенести цифры в колонки контракта |
| Каркас снимка, чистка, проверка схемы | ✅ `snapshot_tool.py new / normalize / validate` | ✅ дозаполнить пропуски |
| Досчёт `price_per_m2_rub` | ✅ из `price_rub / area_m2` | — |
| Поиск акций по ключевым словам | ✅ по списку из settings.yaml | — |
| Расчёт медиан, приход/уход, срез по комнатности | ✅ `diff_snapshots.py` | — |
| Сборка отчёта md + xlsx | ✅ `build_weekly_report.py` | ✅ прочитать отчёт перед отправкой |
| Отправка в Telegram / на почту | ❌ (в этой версии `manual`) | ✅ отправить самому |
| Оценка достоверности и выводы «что делать кампаниям» | ❌ | ✅ решает маркетолог |

Полностью автоматического парсинга Циан/Авито в системе нет и не планируется —
причина и легальные альтернативы: [00-admin/research/sources-research-2026-10-30.md](../00-admin/research/sources-research-2026-10-30.md).

---

## 3. Где что лежит

| Путь | Что это |
|---|---|
| [00-admin/config/my-objects.yaml](../00-admin/config/my-objects.yaml) | наши ЖК (шаблон + примеры «ЗАМЕНИТЕ») |
| [00-admin/config/competitors.yaml](../00-admin/config/competitors.yaml) | список конкурентов |
| [00-admin/config/settings.yaml](../00-admin/config/settings.yaml) | правила: период, пороги, акции, формат, разделы |
| [00-admin/runbook.md](../00-admin/runbook.md) | регламент недельного цикла |
| [00-admin/research/](../00-admin/research/) | разведка источников |
| [inbox/](inbox/) | вход: что вы положили руками |
| `data/snapshots/<YYYY-MM-DD>/lots.csv` | снимки недель (историю не удалять) |
| `reports/<YYYY-MM-DD>-competitor-watch.md` | недельный отчёт (текст) — **канонический путь** |
| `reports/<YYYY-MM-DD>-competitor-watch.xlsx` | недельный отчёт (Excel) — **канонический путь** |
| `reports/<YYYY-MM-DD>/weekly-report.md` и `.xlsx` | совместимая копия тех же отчётов (её кладёт алиас `build_report.py`) |
| `reports/.cache/diff-<YYYY-MM-DD>.json` | машинный diff (изменения в JSON) |
| `reports/.cache/limitations-<YYYY-MM-DD>.md` | ограничения недели: если файл есть, движок подставит его в §9 |
| [00-admin/scripts/validate_config.py](../00-admin/scripts/validate_config.py) | валидатор трёх конфигов |
| [00-admin/scripts/collect-developer-sites.mjs](../00-admin/scripts/collect-developer-sites.mjs) | сбор цен с сайтов застройщиков + `--probe` для диагностики площадки |
| [00-admin/scripts/build-snapshot-from-site.py](../00-admin/scripts/build-snapshot-from-site.py) | сборка `lots.csv` (source=site) из снятых позиций |
| `data/snapshots/_paused-cian-2026-10-31/` | свидетельство: снимок с Циан (270 лотов), отложен по решению пользователя |
| `data/snapshots/_demo-site-zilart-2026-10-31/` + `reports/_demo-site-zilart-2026-10-31/` | свидетельство: рабочий сбор с сайта застройщика (ЗИЛАРТ, 15 позиций, source=site) — вне текущего списка конкурентов |
| [templates/weekly-report.md](templates/weekly-report.md) | шаблон отчёта (9 разделов — дословно как в отчёте движка) |
| [scripts/](scripts/) | движок: снимок, diff, отчёт |
| [scripts/SCHEMA.md](scripts/SCHEMA.md) | контракт `lots.csv`: типы, диапазоны, коды возврата |
| [tests/](tests/) | тесты движка и фикстуры недель |

Документация по запуску движка: **[scripts/README.md](scripts/README.md)**.

---

## 4. Контракт данных (не менять)

Снимок: `01-competitor-watch/data/snapshots/<YYYY-MM-DD>/lots.csv`
Колонки **строго в этом порядке**:

```
snapshot_date,source,competitor,project,lot_id,url,rooms,area_m2,floor,floors_total,building,price_rub,price_per_m2_rub,finish,promo_flag,promo_text,delivery,status
```

- `rooms`: `0` = студия, `1..5` = число комнат, `6` = 5+
- `finish`: `без отделки | white box | чистовая | с мебелью | unknown`
- `promo_flag`: `0` / `1`
- `delivery`: `YYYY-QN`
- `status`: `active | reserved | sold`
- `lot_id` — ключ сопоставления лотов в паре `(source, competitor, project, lot_id)`
- `source`: `cian | avito | yandex_realty | site | other`
- `price_per_m2_rub` досчитывается как `price_rub / area_m2`, если пусто
- CSV для Excel сохраняется в `utf-8-sig` (иначе кракозябры)

Заголовки 9 разделов отчёта (их фиксирует движок, шаблон и `settings.yaml -> report_sections`
повторяют их дословно):

```
## 1. Заголовок и охват
## 2. Главное за неделю
## 3. Цены: медиана ₽/м² по проектам
## 4. Изменения цен по лотам
## 5. Акции и промо
## 6. Предложение: лоты в продаже, приход и уход
## 7. Срез по комнатности
## 8. Выводы и рекомендации
## 9. Ограничения и что не удалось собрать
```

---

## 5. Как запустить вручную

Рабочий каталог **не важен**: скрипты считают пути от своего расположения, а не от текущего
каталога — можно запускать из корня проекта `тестDH`, из этой папки или откуда угодно.
Команды ниже проверены на фикстурах 2026-10-23 / 2026-10-30 (все завершились кодом 0).

```powershell
# интерпретаторы рантайма (один раз за сессию)
$py   = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# --- ОСНОВНОЙ путь: цены с сайтов застройщиков (без авторизации и без Chrome) ---
& $node marketing-agents/00-admin/scripts/collect-developer-sites.mjs --probe https://accenty.ru/
& $node marketing-agents/00-admin/scripts/collect-developer-sites.mjs --site zilart --out "$env:TEMP\site-zilart.json"
& $py   marketing-agents/00-admin/scripts/build-snapshot-from-site.py --date 2026-10-31 --out marketing-agents/01-competitor-watch/data/snapshots/2026-10-31/lots.csv "$env:TEMP\site-zilart.json"

# --- движок: проверка снимка и отчёт ---

# вариант «весь цикл одной командой»: validate -> normalize -> diff -> отчёт (md + xlsx)
& $py marketing-agents/01-competitor-watch/scripts/run_weekly.py --date 2026-10-30 --prev 2026-10-23
```

Без `--prev` движок сам возьмёт ближайший предыдущий снимок из `data/snapshots`.

PowerShell-обёртка (полный аналог), если хочется видеть шаги по отдельности:

```powershell
# ExecutionPolicy на этой машине = Restricted, поэтому -ExecutionPolicy Bypass обязателен
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents/01-competitor-watch/scripts/run_weekly.ps1 -Date 2026-10-30 -Prev 2026-10-23
```

По шагам — те же действия вручную:

```powershell
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py normalize 2026-10-30
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py validate  2026-10-30   # код 0 = ок
& $py marketing-agents/01-competitor-watch/scripts/diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30 --threshold 0.5
& $py marketing-agents/01-competitor-watch/scripts/build_weekly_report.py --curr 2026-10-30 --prev 2026-10-23 --threshold 0.5 --formats md,xlsx
```

Что должно получиться:

```
reports/2026-10-30-competitor-watch.md     — отчёт, 9 разделов
reports/2026-10-30-competitor-watch.xlsx   — 5 листов: Сводка, Цены, Изменения, Акции, Лоты
reports/.cache/diff-2026-10-30.json        — машинный diff
```

В шапке отчёта движок печатает, с какими настройками он посчитан, например:
`_Настройки: порог 0,5%, округление 1 000 ₽, минимум лотов для статистики 3, режим сравнения week_over_week, знаков в процентах 2, разделов отчёта 9. источник: ...settings.yaml._`

Полное описание флагов (`--threshold`, `--formats`, `--reports-dir`, `--snapshots-dir`,
`--config-dir`, `--telegram`, `--quiet`) — в [scripts/README.md](scripts/README.md).
Регламент недели целиком — в [00-admin/runbook.md](../00-admin/runbook.md).

---

## 6. Частые вопросы

**Почему отчёт говорит «данных мало»?**
В inbox попал только один источник или мало лотов. Порог предупреждения задан в
`settings.yaml -> quality.warn_if_lots_below`.

**Почему изменения цены меньше 0.5% не попали в отчёт?**
Это порог значимости: `settings.yaml -> thresholds.price_change_pct`. Меньшие колебания
считаются шумом.

**Можно ли парсить Циан автоматически?**
Нет. У Циан Cloudflare/WAF и лимиты по IP, у Авито в `robots.txt` стоит `Disallow: /`.
Легальные способы: выгрузка Циан в личном кабинете, фиды и буклеты Авито, открытые данные
ДОМ.РФ/наш.дом.рф, сохранённые страницы и скриншоты. Подробнее — в research-файле.

**Как добавить конкурента?**
`00-admin/config/competitors.yaml`, скопировать блок и заменить значения — 1 минута.
Пошагово: [00-admin/runbook.md](../00-admin/runbook.md).
