# scripts — движок Агента 1 «Мониторинг конкурентов»

Детерминированный Python-движок: из двух недельных снимков делает машиночитаемый diff
и готовый недельный отчёт (Markdown + XLSX) для маркетолога.

Контракт входного файла зафиксирован в SCHEMA.md — читать перед правкой данных.
Пути в этом файле записаны через прямой слэш: в PowerShell такие пути работают,
и их можно копировать как есть.

## Состав

| Файл | Назначение |
| --- | --- |
| SCHEMA.md | Контракт снимка lots.csv: колонки, типы, диапазоны, коды возврата |
| cwlib.py | Общая библиотека: схема, чтение/запись CSV, валидация, нормализация, статистика |
| snapshot_tool.py | CLI: new / validate / normalize снимка |
| diff_snapshots.py | CLI: diff двух снимков -> reports/.cache/diff-<дата>.json |
| build_weekly_report.py | CLI: отчёт reports/<дата>-competitor-watch.md и .xlsx |
| sources_tool.py | Источники мониторинга: list / enable / disable / status / record / run-cycle |
| log_source_run.py | Журнал прогонов: append в data/source-runs.jsonl, просмотр хвоста |
| run_weekly.ps1 | Обёртка полного цикла: источники -> validate -> normalize -> diff -> отчёт |
| run_weekly.py, build_snapshot.py, build_report.py | Совместимые алиасы (см. ниже) |
| ../tests/test_engine.py, ../tests/test_sources.py | unittest-наборы движка и источников (stdlib, без pytest) |

## Python

Все команды ниже используют python рантайма DSH:

~~~
$py = "$env:USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe"
~~~

Зависимости: только стандартная библиотека + openpyxl (нужен только для XLSX, уже есть в рантайме).
Устанавливать ничего не нужно.

Рабочий каталог значения не имеет: пути к снимкам, отчётам и конфигам скрипты считают
от собственного расположения (marketing-agents/01-competitor-watch/scripts), а не от текущего
каталога. Оба варианта вызова дают одинаковый результат:

~~~powershell
# вариант 1 — из корня проекта (так вызывает скил competitor-watch)
cd C:/Users/Артем/Desktop/тестDH
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py validate 2026-10-30
& $py marketing-agents/01-competitor-watch/scripts/diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30

# вариант 2 — из папки агента (так задан CWD в runbook)
cd C:/Users/Артем/Desktop/тестDH/marketing-agents/01-competitor-watch
& $py scripts/snapshot_tool.py validate 2026-10-30
& $py scripts/diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30
~~~

## Пути и настройки

| Что | По умолчанию | Флаг-переопределение |
| --- | --- | --- |
| Каталог снимков | output.snapshot_dir из settings.yaml, иначе data/snapshots | --snapshots-dir |
| Каталог отчётов | output.report_dir из settings.yaml, иначе reports | --reports-dir |
| Каталог конфигов | 00-admin/config (от расположения скрипта) | --config-dir |
| Порог значимости цены | thresholds.price_change_pct из settings.yaml, иначе 0.5 | --threshold |
| Форматы отчёта | output.formats из settings.yaml, иначе md,xlsx | --formats |

settings.yaml читается без PyYAML: если модуль yaml в рантайме есть — используется он,
иначе встроенный мини-парсер нужного подмножества. Флагами удобно уводить тестовые
прогоны во временный каталог, не засоряя боевые data/ и reports/.

### Что реально меняет settings.yaml

| Ключ в settings.yaml | Что меняет в отчёте | По умолчанию |
| --- | --- | --- |
| thresholds.price_change_pct | порог значимости изменения цены (раздел 4 и счётчик в разделе 2) | 0.5 |
| thresholds.price_change_abs_rub | абсолютный порог Δ₽: изменение значимо, если прошло по проценту ИЛИ по сумме (0 — не применять) | 0 |
| thresholds.lot_count_change_abs | приход/уход меньше этого числа лотов на проект не выносится в «Главное за неделю» | 3 |
| thresholds.min_lots_for_stats | проекты с меньшим числом лотов в продаже не попадают в медианные таблицы | 3 |
| units.price_round_to_rub | шаг округления всех сумм отчёта (0 — без округления); Δ₽ округляется, но не обнуляется | 0 |
| units.pct_decimals | знаков после запятой у процентов отчёта | 2 |
| period.compare_mode | week_over_week — снимок ровно period.days назад; previous_snapshot — предыдущий по дате; если снимка нет, раздел 9 предупреждает, отчёт без блока изменений | week_over_week |
| period.days | сколько дней назад смотреть в режиме week_over_week | 7 |
| quality.warn_if_lots_below | если лотов в снимке меньше — предупреждение в разделе 9 | 5 |
| output.formats | какие файлы собирать по умолчанию (md, xlsx) | md,xlsx |
| output.snapshot_dir, output.report_dir | каталоги снимков и отчётов | data/snapshots, reports |

Приоритет: флаг CLI > settings.yaml > значение по умолчанию. Флаг --no-config полностью
игнорирует файл и работает на значениях по умолчанию.

Что видно в отчёте: в шапке строка «Настройки: порог …%, округление …, минимум лотов для
статистики …» (то есть конфиг применён), а в разделе 9 — предупреждения движка: конфиг не
прочитан, снимок для сравнения не найден, лотов меньше quality.warn_if_lots_below,
расхождение report_sections с кодом.

Заголовки 9 разделов заданы в коде и не настраиваются; settings.yaml.report_sections —
справочное зеркало. Если число или нумерация разделов в конфиге разойдутся с кодом,
движок напишет предупреждение в stderr и в раздел 9.

## Быстрый старт: полный недельный цикл

~~~
& marketing-agents/01-competitor-watch/scripts/run_weekly.ps1 -Date 2026-10-30 -Prev 2026-10-23
~~~

Если -Prev не задан, снимок для сравнения выбирают сами скрипты по ЕДИНОМУ правилу
cwlib.previous_snapshot_date + period.compare_mode из settings.yaml — одинаково для
run_weekly.ps1 и python-алиаса run_weekly.py:
- week_over_week (по умолчанию) — нужен снимок ровно за period.days дней; если его нет,
  в раздел 9 попадёт предупреждение, а отчёт выйдет без блока изменений (fallback на
  ближайший снимок не делается);
- previous_snapshot — берётся ближайший предыдущий снимок по дате.

Порог значимости цены меняется через -Threshold (по умолчанию — thresholds.price_change_pct
из settings.yaml).
Путь к python можно переопределить переменной окружения CW_PYTHON.

Важно: на этой машине выполнение .ps1-сценариев запрещено политикой (ExecutionPolicy = Restricted),
поэтому запускать обёртку нужно так:

~~~
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents/01-competitor-watch/scripts/run_weekly.ps1 -Date 2026-10-30 -Prev 2026-10-23
~~~

Либо вообще без PowerShell — тем же циклом на python (алиас run_weekly.py, политика на него не влияет):

~~~
& $py marketing-agents/01-competitor-watch/scripts/run_weekly.py --date 2026-10-30 --prev 2026-10-23
~~~

## snapshot_tool.py — снимки

### Создать пустой снимок

~~~
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py new 2026-11-06
~~~

Создаёт data/snapshots/2026-11-06/lots.csv с заголовком и одной пример-строкой
(пример проходит валидацию — можно править его, а не писать файл с нуля).
Если файл уже есть, команда откажется перезаписывать (код 1); для перезаписи — флаг --force.

### Проверить снимок

~~~
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py validate 2026-11-06
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py validate tests/fixtures/week-2026-10-30/lots.csv
~~~

Вход: дата YYYY-MM-DD (тогда файл ищется в data/snapshots/<дата>/lots.csv), каталог снимка
или прямой путь к .csv.

Выход: код 0 и строка «OK: строк с данными N...», либо код 1 и список проблем вида
«строка N: проблема» (печатается в stderr). Код 2 — файл не найден или битый заголовок.

### Нормализовать снимок

~~~
& $py marketing-agents/01-competitor-watch/scripts/snapshot_tool.py normalize 2026-11-06
~~~

Приводит типы, досчитывает price_per_m2_rub, убирает дубли по ключу, сортирует
и перезаписывает файл в utf-8-sig (чтобы Excel видел кириллицу). Печатает статистику:
сколько строк было, сколько сохранено, сколько дублей и некорректных отброшено, сколько ₽/м² досчитано.

## diff_snapshots.py — изменения

~~~
& $py marketing-agents/01-competitor-watch/scripts/diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30
& $py marketing-agents/01-competitor-watch/scripts/diff_snapshots.py --prev tests/fixtures/week-2026-10-23/lots.csv --curr tests/fixtures/week-2026-10-30/lots.csv --threshold 0.5
~~~

Параметры: --prev и --curr (дата, каталог или .csv), --threshold (по умолчанию 0.5),
--reports-dir (по умолчанию reports), --snapshots-dir (по умолчанию data/snapshots), --quiet.

Считает: новые лоты, ушедшие лоты (отдельно те, у которых статус не active), изменения цен
по общему ключу лота (было/стало, дельта в рублях и процентах) с порогом значимости,
изменения акций (новая / изменилась / закончилась), предложение по проектам и по комнатности,
медиану и среднее ₽/м² по проектам с дельтой к прошлой неделе.

Пишет JSON reports/.cache/diff-<curr>.json (UTF-8) и печатает краткую сводку в stdout.

## build_weekly_report.py — отчёт

~~~
& $py marketing-agents/01-competitor-watch/scripts/build_weekly_report.py --curr 2026-10-30 --prev 2026-10-23
& $py marketing-agents/01-competitor-watch/scripts/build_weekly_report.py --curr tests/fixtures/week-2026-10-30/lots.csv --prev tests/fixtures/week-2026-10-23/lots.csv --reports-dir reports/2026-10-30-demo --telegram
~~~

Параметры: --curr (обязателен), --prev (без него отчёт без сравнения), --threshold,
--formats md,xlsx (по умолчанию оба), --telegram, --reports-dir, --snapshots-dir.

Результат:

- reports/<дата>-competitor-watch.md — 9 разделов строго в этом порядке:
  1. Заголовок и охват
  2. Главное за неделю (3–7 пунктов)
  3. Цены: медиана ₽/м² по проектам
  4. Изменения цен по лотам
  5. Акции и промо
  6. Предложение: лоты в продаже, приход и уход
  7. Срез по комнатности
  8. Выводы и рекомендации
  9. Ограничения и что не удалось собрать
- reports/<дата>-competitor-watch.xlsx — листы Сводка, Цены, Изменения, Акции, Лоты
  (шапка жирным, автоширина, заморозка шапки, числовые форматы ₽ и %);
- reports/.cache/diff-<дата>.json — тот же машинный diff;
- с флагом --telegram — короткая сводка (до 900 символов) в stdout для копирования в Telegram.

Раздел 9 берёт ограничения недели из reports/.cache/limitations-<дата>.md, если файл есть.

## Совместимые алиасы

В документации проекта встречаются имена run_weekly.py / build_snapshot.py / build_report.py.
Это тонкие обёртки над каноническими скриптами — можно использовать любые:

~~~
& $py marketing-agents/01-competitor-watch/scripts/run_weekly.py --date 2026-10-30 --prev 2026-10-23
& $py marketing-agents/01-competitor-watch/scripts/build_snapshot.py --date 2026-11-06
& $py marketing-agents/01-competitor-watch/scripts/build_report.py --date 2026-10-30 --prev 2026-10-23
~~~

build_report.py дополнительно кладёт копию отчёта в reports/<дата>/weekly-report.md и .xlsx.

## Что делать при ошибках валидации

1. Прочитайте сообщения «строка N: проблема» — N это номер строки в файле, где 1 — заголовок.
2. Исправьте данные в lots.csv (Excel или редактор; сохранять в UTF-8).
3. Запустите validate снова. Пока код возврата не 0 — diff и отчёт строить нельзя:
   цифры будут неверными.
4. Типовые ошибки и что делать:
   - «пустое обязательное поле X» — дозаполните колонку;
   - «rooms=... вне диапазона 0..6» — студия это 0, «5 и более» это 6;
   - «area_m2=... вне диапазона 10..400» — проверьте, не перепутаны ли м² и цена;
   - «price_rub=... должен быть больше 1 000 000» — вероятно, указана цена за м² или цена «от»;
   - «price_per_m2_rub не сходится с price_rub/area_m2» — очистите колонку, движок досчитает;
   - «дубль лота по ключу» — удалите лишнюю строку (normalize оставит первое вхождение);
   - «неверный порядок колонок» — восстановите порядок из SCHEMA.md, порядок обязателен;
   - «snapshot_date не совпадает с датой снимка» — приведите дату к имени папки;
   - «source=... не из списка» — допустимы cian, avito, yandex_realty, site, other.
5. Если строк много и они битые: normalize уберёт некорректные и дубли, но не исправит
   значения — сначала validate, потом normalize.

## Тесты

~~~
cd C:\Users\Артем\Desktop\тестDH
& $py -m unittest discover -s marketing-agents/01-competitor-watch/tests -v
~~~

Набор проверяет фикстуры tests/fixtures (эталон ожидаемых чисел — tests/fixtures/EXPECTED.md),
все 9 разделов Markdown, 5 листов XLSX, коды возврата validate на битой фикстуре,
досчёт ₽/м², медианы, детекцию акций и кодировки.

## Источники: включение/выключение и журнал

Тумблеры вкладки «Источники мониторинга» правят поле enabled в
marketing-agents/registry/sources.yaml — том самом файле, который читает движок.
Тумблер не картинка: выключенный источник пропускается циклом, включённый попадает
в журнал и получает свежий last_run.

### Команды

~~~
& $py scripts/sources_tool.py list                 # таблица: id, enabled, status, last_run, название
& $py scripts/sources_tool.py list --json --enabled-only
& $py scripts/sources_tool.py status developer-sites
& $py scripts/sources_tool.py enable  developer-sites
& $py scripts/sources_tool.py disable developer-sites
& $py scripts/sources_tool.py record developer-sites --status ok --last-run 2026-11-07
& $py scripts/log_source_run.py --file data/source-runs.jsonl --tail 10
~~~

* правка атомарна (temp-файл + переименование), перед записью создаётся
  sources.yaml.bak-<ГГГГММДД-ЧЧММСС>; повторный enable/disable ничего не меняет и бэкап не плодит;
* комментарии, порядок строк и все прочие поля сохраняются: меняется только значение нужного поля
  (проверяется тестом на построчный diff);
* неизвестный id — понятная ошибка и код возврата 1; проблема с самим файлом — код 2.

### Как это работает в недельном цикле

run_weekly.ps1 (и алиас run_weekly.py) первым шагом выполняет:

~~~
& $py scripts/sources_tool.py run-cycle --date 2026-10-31
~~~

1. читает sources.yaml и пропускает всё, где enabled: false (в отчёте они помечены «пропущен»);
2. по каждому включённому источнику считает результат прогона по снимку:
   лоты и проекты берутся из колонки source файла data/snapshots/<дата>/lots.csv;
   для kind: manual пишется status empty с пометкой «ждём материалы», если снимка нет — blocked;
3. добавляет по записи в data/source-runs.jsonl:

~~~
{"ts":"2026-10-31T18:20:05","source":"developer-sites","status":"ok","lots":15,"projects":1,"note":"снято 15 лотов в 1 проектах"}
~~~

4. проставляет last_run и status обратно в sources.yaml тем же атомарным способом
   (включённым источникам; выключенные не трогаются вовсе).

Соответствие статусов журнала и sources.yaml: ok -> working, partial -> partial,
blocked -> blocked, empty -> status не меняется, обновляется только last_run.

### Параметры для тестов и нестандартных прогонов

run_weekly.ps1: -SourcesFile <путь>, -RunsFile <путь>, -SkipSources.
run_weekly.py: --sources-file, --runs-file, --skip-sources.
Так тесты и разовые прогоны не трогают боевые registry/sources.yaml и data/source-runs.jsonl.

### Тесты

~~~
& $py -m unittest discover -s marketing-agents/01-competitor-watch/tests -v
~~~

tests/test_sources.py проверяет: правку только поля enabled (построчное сравнение файла),
идемпотентность и единственный бэкап, неизвестный id, сохранение инлайн-комментариев,
запись и разбор журнала, параллельные записи, а также сценарий приёмки:
выключенный источник не попадает в журнал и не меняет last_run, включённый — попадает.

## Клиенты и сбор с площадок без логина

Клиентские конфиги лежат в config/clients/<client-id>.yaml (контракт фиксирует Lead).
Движок их ТОЛЬКО ЧИТАЕТ: ни enabled, ни статусы, ни last_run в клиентский файл не пишутся —
служебные отметки идут в свои файлы (data/source-runs.jsonl, registry/runs.jsonl,
registry/results.yaml).

~~~
& $py scripts/clients.py list                       # список клиентов и расписаний
& $py scripts/clients.py check                      # проверка конфигов по контракту
& $py scripts/clients.py show --client client-svet
& $py scripts/collect_clients.py --client client-svet --date 2026-11-01
& $py scripts/collect_clients.py --client client-svet --no-browser   # только анонимный HTTP
& $py scripts/collect_clients.py schedule           # план недели и команды для планировщика
~~~

Что делает прогон: собирает включённые источники -> пишет снимок
data/clients/<client-id>/snapshots/<дата>/lots.csv -> считает неделю-к-неделе и месяц-к-месяцу ->
собирает брендированный отчёт reports/clients/<client-id>/<дата>-competitor-watch.{md,xlsx,docx,pdf} ->
пишет журналы (data/source-runs.jsonl, registry/runs.jsonl) и результат (registry/results.yaml).

### Как собираются площадки (без логина, это важно)

1. Обычный анонимный HTTP: в запрос уходят только User-Agent, Accept, Accept-Language,
   Cache-Control. Куки, токены, сессии и заголовки авторизации не добавляются никогда
   (тест это проверяет).
2. Если страница отдала капчу/403/429 — вторая попытка через Chrome по CDP, но с ЧИСТЫМ
   временным профилем (--user-data-dir в %TEMP%), то есть без единого входа в аккаунт.
   Профиль удаляется после прогона.
3. Честные статусы: получилось / нужен браузер / требует партнёрства / нет данных на странице.
4. Лот попадает в снимок, только если на странице реально есть цена, площадь и комнатность.
   Цены без площади или комнатности считаются в примечании («ещё N цен без площади») — данные
   не додумываются.
5. Лоты с площадки привязываются к конкуренту, только если страница упоминает его имя. Для
   городской выдачи статус будет «нет данных на странице», а не выдуманная привязка; в заметке
   добавляется «каталожная/поисковая страница».

### Расписание

Дата и время берутся из schedule клиента (weekday/time). Регистрация в планировщике Windows
печатается командой collect_clients.py schedule (скрипт сам задач не создаёт), ручной запуск —
run_client.ps1 -Client <id> или run_client.ps1 без параметров (все клиенты).

## Расширенный профиль конкурента (метрики и аналитика)

Профили: data/clients/<client-id>/competitor-profiles/<project>.json и _summary.json.
Каждая метрика хранит «значение · единица · источник · дата сбора · метод (http|dom|js-state|estimate) ·
точность · комментарий», поэтому в панели видно, откуда число и когда оно собрано.

~~~
& $py scripts/competitor_profile.py --client client-svet --limit 6
& $py scripts/competitor_profile.py --client client-svet --no-browser      # без попытки официальных источников
~~~

Что собирается: лоты в реализации; цены мин/медиана/макс в ₽ и ₽/м²; цены по типам
(студии / 1 / 2 / 3 / 4+); акции застройщика (метки самой площадки, вроде «Только на Циан»,
акциями не считаются); средняя и медианная площадь; брони — если страница помечает; корпуса —
с сайта застройщика, если раздел публичный.

Официальные источники (Росреестр / ЕИСЖС): сначала обычный HTTP, затем Chrome по CDP с чистым
профилем без логина. Факт на 01.11.2026: наш.дом.рф и rosreestr.gov.ru через HTTP недоступны
(TLS), а через браузер страницы открываются — это фиксируется в _summary.json в блоке rosreestr
(reachable_via_browser). Данные ДДУ своими цифрами никогда не подменяются: пока структурированные
ДДУ не разобраны, в профиле стоит «источник недоступен / следующий шаг».

Оценка продаж: уход лотов между неделями (method: estimate, точность низкая) — это оценка по
нашему мониторингу, а не данные Росреестра.

Производные метрики: скорость продаж (лотов/нед), absorption rate, прогноз месяцев до распродажи,
динамика цены входа, индекс ₽/м² к району, динамика предложения, промо-давление (недель с акциями),
структура по комнатности, средняя площадь, разрыв «мы vs конкурент», риск-флаги
(резкий рост предложения, сброс цены, давление акциями). Там, где нужна история, а её меньше
двух недель, честно пишется «нужно минимум 2 недели наблюдений».

## Кодировки и форматы

- lots.csv — UTF-8 с BOM (utf-8-sig), CRLF: так Excel открывает кириллицу без «кракозябр».
- .md и .json — UTF-8 без BOM.
- .xlsx — openpyxl, числовые форматы ₽ и %.
- Консоль: скрипты принудительно переводят stdout/stderr в UTF-8 и переключают кодовую
  страницу консоли на 65001 (UTF-8). Без этого русский текст и символ ₽ в консоли Windows
  с cp866 превращаются в кракозябры — особенно важно для --telegram, где сводка копируется
  из консоли вручную. run_weekly.ps1 дополнительно выставляет $env:PYTHONIOENCODING = 'utf-8'
  и [Console]::OutputEncoding.
