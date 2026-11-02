# Регламент: недельный цикл конкурентного мониторинга (Агент 1)

**Для кого:** диджитал-маркетолог, который работает один и не обязан знать код.
**Что даёт:** каждый понедельник свежий снимок рынка, в пятницу — отчёт по конкурентам
(цены, акции, предложение) с выводами для наших кампаний.

Первая настройка занимает ~15 минут: заполнить 3 файла в [config/](config/).
Дальше цикл — это 3 коротких шага в неделю.

> **Как запускать команды.** Python рантайма удобно один раз положить в переменную:
> ```powershell
> $py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
> ```
> Рабочий каталог **не важен**: скрипты считают все пути от своего расположения
> (`marketing-agents/01-competitor-watch/scripts`), а не от текущего каталога —
> проверено запуском из корня проекта, из папки агента и из %TEMP%.
> На этой машине политика запрещает .ps1-скрипты (ExecutionPolicy = Restricted),
> поэтому PowerShell-обёртку запускаем через
> `powershell -NoProfile -ExecutionPolicy Bypass -File ...` либо берём python-алиас
> `run_weekly.py` — на него политика не влияет.

---

## 0. Разовая настройка (15 минут)

1. Заполните [config/my-objects.yaml](config/my-objects.yaml) — наши ЖК.
   В примерах есть пометка **ЗАМЕНИТЕ** — замените и уберите пометку.
2. Проверьте [config/competitors.yaml](config/competitors.yaml) — оставьте 3–5 реальных
   конкурентов, лишние примеры удалите.
3. Просмотрите [config/settings.yaml](config/settings.yaml) — обычно менять ничего не нужно.
   Проверьте период (7 дней), порог 0.5%, список слов-акций и округления.
4. Проверьте конфиги командой ниже — она должна вывести три строки `[OK]` и `exit=0`.

```powershell
cd "C:\Users\Артем\Desktop\тестDH\marketing-agents\00-admin"
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

# вариант A: штатный валидатор конфигов (PyYAML в рантайме нет — внутри fallback на node+js-yaml)
& $py scripts/validate_config.py

# вариант B: быстрая проверка именно YAML через Node + js-yaml
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
@'
const base = "file:///C:/Users/Артем/.dsh/profiles/desktop/node_modules/js-yaml/index.js";
const cfg = "C:/Users/Артем/Desktop/тестDH/marketing-agents/00-admin/config/";
const y = await import(base); const fs = await import("node:fs");
const yaml = y.default ?? y; const f = fs.default ?? fs;
for (const n of ["my-objects.yaml","competitors.yaml","settings.yaml"])
  console.log("OK", n, Object.keys(yaml.load(f.readFileSync(cfg + n,"utf8"))).join(","));
'@ | Set-Content "$env:TEMP\check.mjs" -Encoding UTF8; & $node "$env:TEMP\check.mjs"
```

> Не путайте два валидатора: `00-admin/scripts/validate_config.py` проверяет **конфиги**,
> а `01-competitor-watch/scripts/snapshot_tool.py validate` — **данные снимка** (см. §1, среда).

---

## 1. Недельный цикл: пн → ср → пт

| День | Шаг | Что делаете | Сколько времени |
|---|---|---|---|
| **Понедельник** | Сбор | собираете данные по конкурентам и кладёте файлы в `01-competitor-watch/inbox/` | 20–40 мин |
| **Среда** | Проверка | запускаете снимок, смотрите, всё ли прошло валидацию, добираете пропуски | 10–15 мин |
| **Пятница** | Отчёт | собираете отчёт md+xlsx, проверяете по чек-листу, отправляете себе/команде | 15–20 мин |

Почему так: снимок в понедельник даёт ровно 7 дней между сравнениями, а среда оставляет
запас, если источник не отдал данные. Пятничный отчёт попадает в планирование кампаний.

### Понедельник — сбор

1. Проверьте `01-competitor-watch/inbox/` — папка должна быть пустой (прошлая неделя в архиве).
2. По каждому конкуренту из [config/competitors.yaml](config/competitors.yaml) соберите:
   - выгрузку Циан (личный кабинет → выгрузка в xlsx/csv), если есть доступ;
   - сохранённую HTML-страницу (Ctrl+S) карточки ЖК/выдачи;
   - скриншот выдачи (`.png`), если по-другому не снять;
   - текстовые заметки по акциям (промо, рассрочка, скидки).
3. Назовите файлы строго по схеме: `<YYYY-MM-DD>_<источник>_<конкурент>.<ext>`,
   где источник — `cian | avito | yandex_realty | site | other`
   (например `2026-10-27_cian_zhk-competitor-1.xlsx`).
   Правила и примеры — в [../01-competitor-watch/inbox/README.md](../01-competitor-watch/inbox/README.md).

### Сбор цен с сайтов застройщиков (ОСНОВНОЙ путь с 31.10.2026)

По решению пользователя от 2026-10-31 основной источник — **официальные сайты застройщиков**
(`site_url` в [config/competitors.yaml](config/competitors.yaml)). Циан и Авито **отложены**.
Авторизация и Chrome/CDP для этого пути не нужны — только обычный HTTP.

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 1) проверить площадку: есть ли цены прямо в HTML (диагностика, 1 запрос)
& $node marketing-agents/00-admin/scripts/collect-developer-sites.mjs --probe https://accenty.ru/

# 2) снять позиции каталога у сайта, который отдаёт цены в HTML
& $node marketing-agents/00-admin/scripts/collect-developer-sites.mjs --site zilart --out "$env:TEMP\site-zilart.json"

# 3) собрать снимок из JSON и проверить его по контракту
& $py marketing-agents/00-admin/scripts/build-snapshot-from-site.py --date 2026-10-31 --out marketing-agents/01-competitor-watch/data/snapshots/2026-10-31/lots.csv "$env:TEMP\site-zilart.json"
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py validate 2026-10-31
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py normalize 2026-10-31
& $py marketing-agents/01-competitor-watch/scripts/build_weekly_report.py --curr 2026-10-31
```

Что нужно знать про этот источник:

- `--probe` различает три случая: **цены в HTML** (можно собирать), **цены грузятся скриптами**
  (обычным HTTP не снять), **сайт закрыт** (HTTP 401 / DNS не резолвится). Результат проверки
  фиксируйте в `site_status` у конкурента в `competitors.yaml`.
- Сайты часто публикуют **«цену от» по позиции каталога** (корпус + тип квартиры + площадь),
  а не шахматку по каждому лоту. Тогда в снимке нет номера лота, этажа и отделки —
  это обязательно пишется в §9 отчёта, а `lot_id` собирается как устойчивый хэш.
- В снимке такие лоты идут с `source=site`.
- Если сайт отдаёт цены только скриптами — не подделывайте данные: зафиксируйте это в §9
  и попросите у застройщика прайс/буклет (файл можно положить в `inbox/`).

### Среда — проверка

Если снимка ещё нет, создайте каркас (появится `lots.csv` с заголовком и пример-строкой,
которую можно править вместо того, чтобы писать файл с нуля):

```powershell
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py new 2026-10-28
```

Заполнили `lots.csv` из inbox — прогоните нормализацию и проверку:

```powershell
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py normalize 2026-10-28
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py validate  2026-10-28
```

- `normalize` приводит типы, досчитывает `price_per_m2_rub`, убирает дубли по ключу,
  сортирует и перезаписывает файл в `utf-8-sig` (чтобы Excel видел кириллицу).
- `validate` возвращает код 0 при успехе. **Код 1 или 2 = снимок не готов:**
  сначала вычистите ошибки, diff и отчёт строить нельзя — цифры будут неверными.
  Код 2 — файл не найден или битый заголовок; код 1 — ошибки в строках (печатаются в stderr).

Что смотреть после запуска:
- создался ли файл `data/snapshots/2026-10-28/lots.csv`;
- в нём есть все 18 колонок контракта в нужном порядке (см. §6);
- по каждому конкуренту из `competitors.yaml` есть хотя бы несколько строк;
- предупреждений о малом числе лотов нет (порог `quality.warn_if_lots_below` в settings.yaml).

Если чего-то не хватает — доложите файлы в inbox и повторите normalize/validate.

### Пятница — отчёт

```powershell
# 1) сравнение недель -> машинный diff (JSON)
& $py marketing-agents/01-competitor-watch/scripts/diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30 --threshold 0.5

# 2) отчёт из diff (md + xlsx)
& $py marketing-agents/01-competitor-watch/scripts/build_weekly_report.py --curr 2026-10-30 --prev 2026-10-23 --threshold 0.5 --formats md,xlsx
```

Одна команда «весь цикл сразу» (validate → normalize → diff → отчёт) — самый простой путь:

```powershell
# python-алиас: работает всегда, политика PowerShell на него не влияет
& $py marketing-agents/01-competitor-watch/scripts/run_weekly.py --date 2026-10-30 --prev 2026-10-23

# или PowerShell-обёртка: ExecutionPolicy = Restricted требует -ExecutionPolicy Bypass
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents/01-competitor-watch/scripts/run_weekly.ps1 -Date 2026-10-30 -Prev 2026-10-23
```

Если `-Prev` / `--prev` не указывать, движок сам возьмёт ближайший предыдущий снимок из
`data/snapshots`; если предыдущего нет — отчёт выйдет без сравнения неделя-к-неделе.

Результат (канонические пути):

- `01-competitor-watch/reports/2026-10-30-competitor-watch.md` — отчёт, 9 разделов;
- `01-competitor-watch/reports/2026-10-30-competitor-watch.xlsx` — те же данные, 5 листов:
  Сводка, Цены, Изменения, Акции, Лоты;
- `01-competitor-watch/reports/.cache/diff-2026-10-30.json` — машинный diff;
- алиас `build_report.py --date 2026-10-30 --prev 2026-10-23` дополнительно кладёт копию
  в `reports/2026-10-30/weekly-report.md` и `.xlsx`.

В шапке отчёта две служебные строки — по ним видно, с какими правилами посчитан отчёт.
Строка настроек (значения берутся из settings.yaml):

`_Настройки: порог 0,5%, округление 1 000 ₽, минимум лотов для статистики 3, режим сравнения week_over_week, знаков в процентах 2, разделов отчёта 9. источник: <путь к 00-admin/config/settings.yaml>._`

и строка генератора:

`_Сгенерировано автоматически: скрипт build_weekly_report.py, порог значимости цены 0,5%._`

Если движок не смог прочитать settings.yaml, вместо первой строки появится
«Настройки не применены» + значения по умолчанию — это признак, что конфиг битый
(прогоните проверку из §0).

Перешлите отчёты себе в Telegram/на почту вручную (`settings.yaml -> delivery.send_mode: manual`).
Полное описание флагов — в [../01-competitor-watch/scripts/README.md](../01-competitor-watch/scripts/README.md).

---

## 1.1. Цикл по клиенту (с 01.11.2026)

С 01.11.2026 Агент 1 работает **по клиентам**: у каждого клиента свой конфиг
`01-competitor-watch/config/clients/<client-id>.yaml` (бренд, расписание, получатели,
источники, конкуренты). Глобальные `00-admin/config/*.yaml` остаются настройками по умолчанию.

### Кто и когда

| День | Кто | Что делает |
| --- | --- | --- |
| **Понедельник, 10:00** (Europe/Moscow) | оператор/маркетолог | проверяет, что источники живы, запускает сбор и собирает отчёт по каждому активному клиенту |
| **Четверг** | маркетолог | при необходимости повторяет прогон (в тонких настройках агента дни 1 и 4) и отправляет отчёт клиенту |
| любой день | маркетолог | правит конкуренты/ссылки в клиентском конфиге (5 минут, см. ниже) |

Расписание и получатели лежат в клиентском конфиге (`schedule`, `recipients`), а также в панели:
`registry/clients.yaml` и `registry/agent-settings/agent-1-competitor-watch.yaml`.

### Запуск по клиенту

```powershell
$py   = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 1) проверить клиентские и глобальные конфиги
& $py marketing-agents/00-admin/scripts/validate_config.py

# 2) проверить, что площадка вообще отдаёт цены без входа (диагностика)
& $node marketing-agents/00-admin/scripts/collect-developer-sites.mjs --probe <url>

# 3) собрать снимок по клиенту и построить отчёт (движок, когда появится client-aware режим;
#    сейчас — обычный прогон по дате)
& $py marketing-agents/01-competitor-watch/scripts/run_weekly.py --date <YYYY-MM-DD> --prev <YYYY-MM-DD>
```

### Что делать, если площадка заблокирована

Проверено 01.11.2026 (подробности — `00-admin/research/platforms-public-pages-2026-11-01.md`):

| Площадка | Что делать |
| --- | --- |
| **Циан** — работает без входа | берём публичные страницы ЖК; id ЖК ищем в каталоге района |
| **Яндекс Недвижимость** — работает без входа | если страницы ЖК нет в каталоге — пометить TODO и запросить ссылку у пользователя |
| **Авито** — HTTP 439 | не тратить попытки: перейти на Циан/сайт застройщика, выключить источник, зафиксировать в §9 |
| **Домклик** — HTTP 401 | то же |
| **Сайт застройщика** — цены только в JS | не подделывать: попросить прайс/буклет (в `inbox/`) либо оставить источник выключенным |
| любой источник | отключён в `registry/sources.yaml` (`enabled: false`) | скрипты обязаны его пропускать; в отчёте он попадает в таблицу «источники: что заблокировано» |

Правило: **источник, который не дал данных, не исчезает из отчёта** — он попадает в §9
с причиной. Данные не додумываются.

### Как добавить нового клиента за 5 минут

1. Скопируйте `01-competitor-watch/config/clients/client-svet.yaml` в новый файл
   `config/clients/<client-id>.yaml` (имя файла = `client_id`).
2. Замените `client_id`, `name`, `brand.accent`, `recipients`, `schedule`.
3. Заполните `competitors`: имя, застройщик, класс, сайт и ссылки на площадках.
   Пустая строка `""` = TODO (так и оставляйте, если ссылки нет — валидатор предупредит).
4. Добавьте клиента в панель: `registry/clients.yaml` (панель правит файл сама).
5. Проверьте: `& $py marketing-agents/00-admin/scripts/validate_config.py` — должно быть `[OK]`.

### Как добавить конкурента клиенту за 5 минут

1. Найдите ЖК на Циан: каталог района, например https://www.cian.ru/novostroyki-moskva-sao-045/
   (в HTML есть состояние `window._cianConfig` со списком ЖК и их id).
2. Соберите ссылку вида
   `https://www.cian.ru/kupit-kvartiru-zhiloy-kompleks-<slug>-<id>-ot-zastroyschika-OTZ/`
   и проверьте её обычным HTTP (должен быть код 200 и лоты в HTML).
3. Вставьте блок конкурента в `competitors:` клиентского конфига, заполнив `site` и `platforms`.
4. Прогоните `validate_config.py` и запишите результат проверки в
   `00-admin/research/platforms-public-pages-<дата>.md`.

---

## 2. Чек-лист приёмки отчёта (7 пунктов контроля качества)

Перед отправкой отчёта пройдите по списку. Если пункт не выполняется — отчёт не отправляем.

1. **Все 9 разделов на месте и в правильном порядке** — заголовки должны совпадать дословно:
   «1. Заголовок и охват», «2. Главное за неделю», «3. Цены: медиана ₽/м² по проектам»,
   «4. Изменения цен по лотам», «5. Акции и промо», «6. Предложение: лоты в продаже, приход и уход»,
   «7. Срез по комнатности», «8. Выводы и рекомендации», «9. Ограничения и что не удалось собрать».
2. **`validate` прошёл с кодом 0** — перед построением отчёта снимок текущей недели валиден.
3. **Охват в заголовке совпадает с реальностью** — число конкурентов/проектов/лотов
   в §1 равно числу уникальных значений в снимке `lots.csv`.
4. **Сравнение именно неделя-к-неделе** — в §1 указан период из двух дат, и разница цен
   считалась с предыдущим снимком (даты в отчёте = датам из `--prev`/`--curr`).
5. **Пороги применены** — в §4 нет изменений меньше порога, а число строк «ниже порога»
   в отчёте объясняет, что отброшено как шум.
6. **Акции перепроверены глазами** — в §5 статусы «новая/изменилась/закончилась»
   соответствуют текстам `promo_text`; нет ложных срабатываний ключевых слов
   (например, «рассрочка» встретилась в отзыве клиента, а не в акции).
7. **§8 и §9 заполнены по существу** — выводы привязаны к нашим ЖК из `my-objects.yaml`,
   а в §9 честно перечислено, какие источники не отдали данные и что помечено «не проверено».

Дополнительно: `.xlsx` открывается без предупреждений, 5 листов на месте, русский текст
не «кракозябрами» (CSV в `utf-8-sig`), в отчёте нет пустых обязательных ячеек.

---

## 3. Что делать, если источник заблокирован / не отдал данные

> **Обновление 2026-10-31.** Циан и Авито **отложены** по решению пользователя: их логины и
> коннекторы в недельном цикле не используются. Основной путь сбора — официальные сайты
> застройщиков (см. §1). Раздел ниже применяется к ним в первую очередь.
> Проверка площадки одной командой:
> `node marketing-agents/00-admin/scripts/collect-developer-sites.mjs --probe <url>`

Это **штатная** ситуация: у Циан стоит Cloudflare/WAF и лимиты по IP, у Авито в `robots.txt`
запрет `Disallow: /`, у Яндекс Недвижимости — антибот и JS-рендер.
Прямого парсинга в системе нет — см. [research/sources-research-2026-10-30.md](research/sources-research-2026-10-30.md).

Порядок действий:
1. **Не боритесь с блокировкой.** Не ставьте прокси/обходы: это нарушает правила площадок
   и риски выше пользы.
2. **Возьмите тот же срез легально:** откройте сайт в обычном браузере под своей учёткой,
   сделайте выгрузку из личного кабинета Циан; сохраните страницу (Ctrl+S); сделайте скриншот выдачи.
3. **Замените источник:** официальный сайт застройщика (цены и акции от первоисточника),
   презентация/буклет, открытые данные ДОМ.РФ и наш.дом.рф (ЕИСЖС), открытые данные Москвы.
4. **Зафиксируйте пропуск в отчёте.** Движок берёт ограничения недели из файла
   `01-competitor-watch/reports/.cache/limitations-<YYYY-MM-DD>.md` — создайте его
   (обычный markdown-список) перед сборкой отчёта; если файла нет, движок напишет в §9,
   что специфичные для недели ограничения не зафиксированы.
   Параллельно положите заметку `<дата>_other_<конкурент>.md` в inbox — для истории.
5. **Если данных по конкуренту нет совсем** — не подставляйте старые цены «как свежие».
   Лучше честная дырка в данных, чем неверная рекомендация по кампании.
6. **Повторите попытку в другой день** (лучше со среды) — блокировки часто временные.

---

## 4. Как откатить изменения

Снимки и отчёты **не удаляются и не перезаписываются задним числом** — благодаря этому
откат почти всегда сводится к «собрать заново».

**Откатить конфиг (my-objects / competitors / settings)**
1. **На этой машине git не установлен** (`git` не распознаётся как команда), поэтому основной
   способ — резервная копия. Перед правкой скопируйте папку:
   ```powershell
   $d = Get-Date -Format "yyyy-MM-dd"
   Copy-Item -Recurse -Force "00-admin\config" "00-admin\config\_backup\$d"
   ```
   Восстановление — скопировать нужный .yaml обратно из `00-admin/config/_backup/<дата>/`.
   Если git у вас всё-таки появится, им тоже можно пользоваться:
   `git status`, `git diff -- 00-admin/config/competitors.yaml`,
   `git checkout -- 00-admin/config/competitors.yaml`.
   Совсем без копии — перепишите правку вручную по разделу «Как добавить конкурента/ЖК» ниже.
2. После любого отката прогоните проверку конфигов из §0 — она должна вывести `[OK]` ×3.

**Откатить снимок (`lots.csv`)**
- Создайте файл заново (венчает `--force`, чтобы перезаписать существующий):
  `& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py new <YYYY-MM-DD> --force`
  (алиас: `build_snapshot.py --date <YYYY-MM-DD> --force`).
- Если снимок испортился и данных в inbox уже нет — удалите ТОЛЬКО папку
  `data/snapshots/<YYYY-MM-DD>/` и соберите заново. Удалять папки других дат нельзя:
  на них держится Δ неделя-к-неделе.

**Откатить отчёт**
- Удалите только отчёты этой даты — `reports/<YYYY-MM-DD>-competitor-watch.md` и `.xlsx`
  (и совместимую копию в `reports/<YYYY-MM-DD>/`), затем запустите
  `& $py marketing-agents/01-competitor-watch/scripts/build_weekly_report.py --curr <YYYY-MM-DD>`
  ещё раз. Отчёты и снимки других дат не трогайте.

**Правило безопасности:** перед массовой правкой конфигов скопируйте папку
`00-admin/config/` в `00-admin/config/_backup/<YYYY-MM-DD>/`. Это дешевле любого отката.

---

## 5. Как добавить конкурента / наш ЖК

### Добавить конкурента за 1 минуту

1. Откройте [config/competitors.yaml](config/competitors.yaml).
2. Скопируйте **целиком** любой блок `- id: ...` (вместе со всеми строками до следующего `- id:`).
3. Вставьте ниже и замените значения:
   ```yaml
   - id: zhk-competitor-6            # латиница/цифры/дефис, уникальный, навсегда
     name: "Название ЖК"
     developer: "Застройщик"
     class: "бизнес"                 # премиум | бизнес
     okrug: "САО"                    # ЦАО, САО, СВАО, ВАО, ЮВАО, ЮАО, ЮЗАО, ЗАО, СЗАО, НАО, ТАО
     location: "район, улица (м. Метро)"
     delivery: "2027-Q1"             # YYYY-QN
     cian_url: "https://..."
     avito_url: ""
     yandex_realty_url: ""
     site_url: "https://..."
     priority: "medium"              # high | medium | low
     notes: "зачем следим"
   ```
4. Сохраните. Прогоните проверку конфигов из §0. Конкурент попадёт в следующий цикл.
5. Обязательные поля: `id, name, developer, class, okrug, location, delivery, cian_url, priority`.
   Отступы — только пробелы. `id` после первого запуска не меняем: он ключ истории.

### Добавить наш ЖК

1. Откройте [config/my-objects.yaml](config/my-objects.yaml), скопируйте блок из `our_projects`.
2. Заполните обязательные поля: `id, name, developer, class, okrug, location,
   start_of_sales (YYYY-MM), delivery (YYYY-QN), site_url, usp`.
3. В `key_competitors` перечислите `id` конкурентов из `competitors.yaml` —
   эти проекты маркетолог берёт за основу в §8 отчёта «Выводы и рекомендации».
4. Сохраните и прогоните проверку конфигов из §0.

### Проверка после правки конфигов

```powershell
cd "C:\Users\Артем\Desktop\тестDH\marketing-agents\00-admin"
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py scripts/validate_config.py          # ждём три строки [OK] и exit=0
```

Валидатор проверяет: обязательные поля ЖК и конкурентов, `class`/`priority`/`delivery`,
ссылки `key_competitors` на существующие `id`, `period.days=7`,
`thresholds.price_change_pct=0.5`, `report_sections=9`, `data_contract.columns=18`.

---

## 6. Контракт данных и пути (шпаргалка)

Снимок: `01-competitor-watch/data/snapshots/<YYYY-MM-DD>/lots.csv`,
колонки строго в этом порядке:

```
snapshot_date,source,competitor,project,lot_id,url,rooms,area_m2,floor,floors_total,building,price_rub,price_per_m2_rub,finish,promo_flag,promo_text,delivery,status
```

- `source`: `cian | avito | yandex_realty | site | other`
- `rooms`: `0` = студия, `1..5` = комнат, `6` = 5+
- `finish`: `без отделки | white box | чистовая | с мебелью | unknown`
- `promo_flag`: `0/1`; `delivery`: `YYYY-QN`; `status`: `active | reserved | sold`
- ключ сопоставления лота: `(source, competitor, project, lot_id)`
- `price_per_m2_rub` досчитывается как `price_rub / area_m2`, если пусто
- CSV — `utf-8-sig` (иначе Excel покажет кракозябры)
- заголовки 9 разделов отчёта и список `report_sections` в settings.yaml —
  **справочное зеркало**: их фиксирует движок, правка списка отчёт не меняет.

## 7. Быстрые ссылки

- Как устроен Агент 1: [../01-competitor-watch/README.md](../01-competitor-watch/README.md)
- Полное описание CLI движка: [../01-competitor-watch/scripts/README.md](../01-competitor-watch/scripts/README.md)
- Правила складывания в inbox: [../01-competitor-watch/inbox/README.md](../01-competitor-watch/inbox/README.md)
- Шаблон отчёта (9 разделов): [../01-competitor-watch/templates/weekly-report.md](../01-competitor-watch/templates/weekly-report.md)
- Разведка источников: [research/sources-research-2026-10-30.md](research/sources-research-2026-10-30.md)
