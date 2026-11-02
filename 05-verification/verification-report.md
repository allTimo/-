# T7 — Независимая проверка Агента 1 и DSH-плагина (задача на опровержение)

**Вердикт: есть находки.** Арифметика diff, XLSX, конфиг-«пульт», независимость от CWD, контракт плагина и `-DryRun` установщика сошлись полностью; найдено **2 подтверждённых дефекта** (оба не искажают отчёт 2026-10-23 → 2026-10-30, но нарушают заявленные в документах правила).

- Дата проверки: 2026-10-30
- Проверяющий: teammate `verifier` (задача `task-7`)
- Объект: `marketing-agents` (Агент 1: движок + данные + отчёты; DSH-плагин `dsh-marketing-skills`; установщик; документы)
- Все прогоны — в `%TEMP%`; боевые `data/` и `reports/` не засорялись. Изменён только этот файл.

---

## 1. Что проверено и КАК

### 1.1. Арифметика diff — независимым скриптом (без импорта `cwlib`)

Написан собственный разовый скрипт `%TEMP%\t7-verify\indep_diff.py`: сам читает оба `lots.csv`, сам считает приход/уход/изменения цен/счётчики по проектам и комнатности/медианы и средние ₽/м² по active-лотам (медиана — sorted + среднее двух центральных + `round`, т.е. половина-к-чётному; ₽/м² = сохранённое значение, иначе `price/area`).

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py "$env:TEMP\t7-verify\indep_diff.py" 0.5
```

Сверка с `01-competitor-watch\reports\.cache\diff-2026-10-30.json` — **совпало по всем 16 проверенным метрикам**:

| Метрика | JSON движка | Мой расчёт |
|---|---|---|
| Лотов всего (пред./тек.) | 9 / 10 | 9 / 10 |
| Лотов в продаже (пред./тек.) | 8 / 10 | 8 / 10 |
| Новые / ушедшие | 2 / 1 | 2 / 1 |
| Изменения цен выше порога / ниже | 2 / 1 | 2 / 1 |
| Медиана ₽/м² (тек./пред.) | 331 518 / 329 838 | 331 518 / 329 838 |
| Среднее ₽/м² (тек./пред.) | 332 361 / 337 459 | 332 361 / 337 459 |
| Δ медианы, % | +0,51 | +0,51 |
| Акции (новые/изменились/закончились) | 1 / 1 / 1 | 1 / 1 / 1 |

Таблицы `price_by_project` и `rooms_price` сверены построчно — `project_table_mismatches: []`, `rooms_table_mismatches: []`. Таблицы в `2026-10-30-competitor-watch.md` (§3, §4, §6, §7) соответствуют точным числам JSON с учётом документированного округления до 1 000 ₽ (например, JSON 331 518 → md `332 000 ₽`).

### 1.2. Потери лотов

Проверка классификации в том же скрипте: `gone(1) + common(8) = 9 = prev`, `new(2) + common(8) = 10 = curr`; `coverage.ok_prev = ok_curr = true`. Каждый лот классифицирован ровно один раз, потерь и двойного счёта нет.

### 1.3. Медиана и фильтры статистики

- Половина-к-чётному подтверждена: `median_rounded([320000,324675]) = 322338`, `([324675,335000]) = 329838`, `([2,3]) = 2` (2.5 → 2), `([4,5]) = 4` (4.5 → 4). Все три «.5» из данных округлены к чётному.
- `min_lots_for_stats = 3` (из `00-admin\config\settings.yaml:32`) работает: проект «Символ» (2 лота в продаже) помечен `stats_excluded: true` и исключён из таблицы §3 (есть строка «Ниже порога статистики … в таблицу не попали: Символ»), но остался в счётчиках §6 (`| Донстрой | Символ | 2 | 1 | +1 | 1 | 1 |`).
- **Частичное нарушение правила «только active с заполненными ценой и площадью» — см. дефект D1.**

### 1.4. XLSX

Открыт `openpyxl` из рантайма:

```powershell
& $py "$env:TEMP\t7-verify\xlsx_check.py"
```

- Имена листов: `['Сводка','Цены','Изменения','Акции','Лоты']` — 5 шт., как в документации.
- Строки: `Лоты` = 11 (шапка + 10), `Цены` = 4 (шапка + 2 проекта + «Итого по рынку»), `Изменения` = 3, `Акции` = 4.
- Числа ТОЧНЫЕ: «Медиана ₽/м²» = **331518**, среднее = **332361**, медиана неделю назад = **329838**; в строках `Цены` значения совпадают с JSON (`383333`, `324722`, `322338`), а в md те же числа напечатаны округлёнными (`383 000 ₽`, `325 000 ₽`, `322 000 ₽`). То есть округление живёт только в тексте md.
- `reports\2026-10-30-demo\...xlsx` совпадает с каноническим по листам, строкам и «Сводке»; JSON демо равен каноническому (после удаления `generated_at`); md демо отличается только путём к файлу ограничений (разные `--reports-dir`).

### 1.5. settings.yaml как пульт

Копии `settings.yaml` сделаны в `%TEMP%\t7-verify\cfg\*`; прогон `build_weekly_report.py` c `--config-dir` и `--reports-dir` в `%TEMP%`.

| Конфиг | exit | Строк в §4 | Наличие S-102 | §9 «Настройки не применены» | Примечание |
|---|---|---|---|---|---|
| `price_change_pct: 5.0` | 0 | 0 | нет | нет | порог применён |
| `price_change_pct: 0.5` | 0 | 2 | да | нет | порог применён |
| битый (`- 1` / `- 2`) | 0 | 2 | да | **да** | предупреждение в stderr/§9, значения по умолчанию |
| каталог отсутствует | 0 | 2 | да | **да** | «файл … не найден» |
| `--no-config` | 0 | 2 | да | нет | «Настройки не читались (--no-config)», округления нет (в §3 `331 518 ₽`) |

### 1.6. Независимость от CWD

`snapshot_tool.py validate 2026-10-30` и `diff_snapshots.py` прогнаны из трёх CWD: корень `тестDH`, `01-competitor-watch`, `%TEMP%` (проверено, что `Get-Location` реально равен заданному каталогу).

- stdout `validate`: SHA-256 `B7F5B276F12F61E5D58B0D371D3F103A053DA38A9737B55A9210D828BA6C0C94` — одинаков во всех трёх.
- `diff-*.json` без поля `generated_at`: SHA-256 `b813443c221998befd397c73f0aa753459229c59c35ea8ed8c53abc741575894` — одинаков во всех трёх.

### 1.7. Плагин `dsh-marketing-skills`

- `node --test marketing-agents\tests\plugin-contract.test.mjs` → **7/7 pass, 0 fail** (в т.ч. реальные 3 скила).
- Собственный разовый скрипт `%TEMP%\t7-verify\indep_plugin2.mjs` (не тест репозитория): `apply()` с фейковым `ctx` → провайдер `dsh-marketing-skills`, `injected = ['skills']`, **3 скила** (`competitor-watch`, `direct-keywords`, `newbuild-ru-glossary`); `resourceBase` — существующие каталоги; `locator` указывает на `SKILL.md`; `get(candidate).content` **байт-в-байт** равен файлу (10100 / 4513 / 8125 байт); отсутствующий каталог скилов → `[]` **без исключения** (только предупреждение в stderr).
- Байтовое сравнение `marketing-agents\plugin` и `C:\Users\Артем\.dsh\profiles\desktop\node_modules\dsh-marketing-skills`: **7 файлов, 0 расхождений**.

### 1.8. Установщик (`-DryRun`, реальная установка не запускалась)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\install\install-marketing-plugin.ps1 -DryRun
```

- `cordis.patch.yml`: SHA-256 до `5B72D45BE4436DC86B8854088DF9A0E46F875C8E1FCB00E0B4F1DB7FD2A2FBBD`, после — тот же; дерево `node_modules\dsh-marketing-skills` не изменилось.
- Вхождений строки `- id: marketing-skills` — **ровно 1** (и установщик сам подтверждает: «уже есть … дубль не добавляю»).
- Бэкап существует: `cordis.patch.yml.bak-marketing-20261030-221613`; `-DryRun` новый бэкап **не создал** (было 1, стало 1).
- Smoke-загрузка плагина внутри установщика: `{"plugin":"dsh-marketing-skills","provider":"dsh-marketing-skills","skills":3}`.

### 1.9. Документы против реальности

Выполнены (по возможности дословно; там, где команда пишет в боевые `data/`/`reports/`, добавлены только временные флаги `--snapshots-dir`/`--reports-dir`/`-SnapshotsDir`/`-ReportsDir`, как требует жёсткое правило T7):

| # | Команда (источник) | Результат |
|---|---|---|
| 1 | `& $py scripts/validate_config.py` (runbook §0) | exit 0, три `[OK]` |
| 2 | Node+js-yaml проверка (runbook §0, вариант B) | exit 0, `OK my-objects.yaml …`, `OK competitors.yaml …`, `OK settings.yaml …` |
| 3 | `snapshot_tool.py new 2026-10-28` → `normalize` → `validate` (runbook §1) | exit 0/0/0 |
| 4 | `diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30 --threshold 0.5` (runbook §1) | exit 0 |
| 5 | `build_weekly_report.py --curr … --prev … --threshold 0.5 --formats md,xlsx` (runbook §1) | exit 0, 9 разделов, 5 листов |
| 6 | `run_weekly.py --date 2026-10-30 --prev 2026-10-23` (runbook §1/README §5) | exit 0, копии `reports/<дата>/weekly-report.*` созданы |
| 7 | `run_weekly.ps1 -Date … -Prev …` (runbook §1) | exit 0 |
| 8 | `build_report.py --date 2026-10-30 --prev 2026-10-23` (runbook §1) | exit 0, копия создана |
| 9 | `build_snapshot.py --date 2026-11-06` (scripts/README, алиасы) | exit 0 |

Дополнительно:

- **38 относительных ссылок** в 8 документах (`runbook.md`, `README.md` проекта, `01-competitor-watch/README.md`, `scripts/README.md`, `plugin/README.md`, `START-HERE.md`, `inbox/README.md`, research) — все существуют (`missing: 0`).
- Заголовки 9 разделов совпадают **дословно** во всех четырёх источниках: `build_weekly_report.SECTIONS`, `templates\weekly-report.md`, `settings.yaml.report_sections`, фактический md-отчёт. Проверка: `%TEMP%\t7-verify\headings.py` → `template==code: True`, `md==code: True`, `settings==code: True`, `settings_raw==code: True`.
- PyYAML **не подаётся как рабочий инструмент**: в шаблоне упоминаний нет вообще; в `runbook.md:38` прямо «PyYAML в рантайме нет — внутри fallback на node+js-yaml»; `scripts/README.md:60` — «читается без PyYAML»; `cwlib.py:588,709,731` — опциональность. Импорт `yaml` в рантайме действительно падает (`ModuleNotFoundError`).
- Факты окружения из `runbook.md` подтверждены: PowerShell **5.1.26100.9711**, `ExecutionPolicy = Restricted`, `git` отсутствует, PyYAML отсутствует.

---

## 2. Находки

### 2.1. Опровергнуто (подозрение не подтвердилось)

| # | Подозрение | Проверка | Итог |
|---|---|---|---|
| 1 | diff-арифметика расходится с JSON/md | независимый пересчёт | совпало 16/16 метрик, 0 расхождений в таблицах |
| 2 | лоты теряются или считаются дважды | покрытие множеств | 9 = 1+8, 10 = 2+8 |
| 3 | медиана считается half-up | `[2,3]→2`, `[4,5]→4`, `322337.5→322338` | half-to-even |
| 4 | «Символ» исчез из счётчиков или попал в медианы | JSON + md | исключён из §3, есть в §6 |
| 5 | XLSX содержит округлённые числа | openpyxl | точные 331518/332361/329838 |
| 6 | settings.yaml не влияет на отчёт | 5.0 vs 0.5 | 0 vs 2 изменения |
| 7 | битый settings.yaml роняет движок | битый файл | exit 0 + предупреждение + §9 |
| 8 | результат зависит от CWD | 3 CWD | sha256 идентичны |
| 9 | плагин отдаёт не тот контент или падает без каталога | свой скрипт | байт-в-байт; `[]` без исключения |
| 10 | копия плагина в профиле расходится с репозиторием | sha256 по дереву | 7 файлов, 0 расхождений |
| 11 | `-DryRun` меняет `cordis.patch.yml` | хэш до/после | не меняет; бэкап не добавился |
| 12 | заголовки разделов расходятся в 4 источниках | прямой разбор | 4×9 дословно идентичны |
| 13 | PyYAML упоминается как рабочий инструмент | grep по проекту | только как отсутствующий/опциональный |
| 14 | документированные команды падают / ссылаются на несуществующее | 9 команд + 38 ссылок | все exit 0, ссылок нет |

### 2.2. Подтверждённые дефекты

#### D1. Медиана и среднее ₽/м² включают active-лоты без цены или без площади

- **Где:** `01-competitor-watch\scripts\cwlib.py:272-280` (`ppm2_of`: при заполненном `price_per_m2_rub` возвращает его, даже если `price_rub`/`area_m2` пусты), используется в `01-competitor-watch\scripts\diff_snapshots.py:243-248, 272-281, 286-289`; обещание в `01-competitor-watch\templates\weekly-report.md:90` и `reports\2026-10-30-competitor-watch.md:37`: «Медиана и среднее считаются по лотам со статусом active, у которых заполнены цена и площадь».
- **Ожидание:** active-лот с пустым `price_rub` **или** пустой `area_m2` не попадает в медиану/среднее.
- **Факт:** попадает, если у него заполнен `price_per_m2_rub`. Минимальный сценарий (active-лоты: `10`, `20`, `999` без `price_rub`, `888` без `area_m2`):

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
@'
import sys
sys.path.insert(0, r"C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\scripts")
import cwlib as cw
from diff_snapshots import compute_diff
def row(**kw):
    base = dict(snapshot_date="2026-01-01", source="cian", competitor="C", project="P", lot_id="L",
                url="https://x", rooms=2, area_m2=50.0, floor=1, floors_total=1, building="",
                price_rub=None, price_per_m2_rub=None, finish="чистовая", promo_flag=0,
                promo_text="", delivery="2027-Q1", status="active")
    base.update(kw); return base
rows = [row(lot_id="OK1", price_rub=100.0, area_m2=10.0, price_per_m2_rub=10.0),
        row(lot_id="OK2", price_rub=200.0, area_m2=10.0, price_per_m2_rub=20.0),
        row(lot_id="NOPRICE", price_rub=None,  area_m2=50.0,  price_per_m2_rub=999.0),
        row(lot_id="NOAREA",  price_rub=300.0, area_m2=None,  price_per_m2_rub=888.0)]
p = compute_diff(None, rows, 0.5, None, "2026-01-01")["price_by_project"][0]
print("median:", p["median_ppm2_curr"], "mean:", p["mean_ppm2_curr"], "expected:", cw.median_rounded([10.0,20.0]))
'@ | Set-Content -Encoding UTF8 "$env:TEMP\t7-d1.py"
& $py "$env:TEMP\t7-d1.py"
```

Вывод: `median: 454 mean: 479 expected: 15` — вместо 15 получаем 454.
- **Почему не критично сейчас:** в штатном цикле `run_weekly`/`snapshot_tool validate` блокирует такие строки (`price_rub` и `area_m2` — обязательные поля), и на данных 2026-10-23 → 2026-10-30 дефект не проявляется. Но `diff_snapshots.py` и API `compute_diff` вызываются напрямую (в т.ч. документированной командой) и правило не проверяют.

#### D2. `run_weekly.py` и `run_weekly.ps1` по-разному выбирают предыдущий снимок, хотя заявлены как полные аналоги

- **Где:** `01-competitor-watch\scripts\run_weekly.py:74-77` (использует `config["compare_mode"]`, по умолчанию `week_over_week` → берёт только снимок ровно за `period.days` = 7 дней) против `01-competitor-watch\scripts\run_weekly.ps1:102-111` (берёт **ближайший предыдущий** каталог и `compare_mode` не учитывает).
- **Что обещано:** `01-competitor-watch\README.md:135` «Без `--prev` движок сам возьмёт ближайший предыдущий снимок из `data/snapshots`»; `00-admin\runbook.md:132-133` — то же; `01-competitor-watch\scripts\README.md:98` «Без `-Prev` обёртка сама возьмёт ближайшую предыдущую дату», и там же (строка 109) python-алиас подан как тот же цикл, а `01-competitor-watch\README.md:137` называет `.ps1` «полный аналог».
- **Ожидание:** обе обёртки без `--prev`/`-Prev` дают один и тот же отчёт.
- **Факт:** при снимках `2026-10-20` и `2026-10-30` (7-дневного `2026-10-23` нет) `run_weekly.py` строит отчёт **без сравнения**, а `run_weekly.ps1` строит сравнение `20.10.2026 → 30.10.2026`. Воспроизведение:

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$st = "C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\scripts"
$snap = "$env:TEMP\t7-d2-snap"
Remove-Item -Recurse -Force $snap -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$snap\2026-10-30","$snap\2026-10-20" | Out-Null
Copy-Item 'C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\data\snapshots\2026-10-30\lots.csv' "$snap\2026-10-30\lots.csv" -Force
(Get-Content -Raw -Encoding UTF8 'C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\data\snapshots\2026-10-23\lots.csv') -replace '2026-10-23','2026-10-20' | Set-Content -Encoding UTF8 "$snap\2026-10-20\lots.csv"
& $py "$st\run_weekly.py"  --date 2026-10-30 --reports-dir "$env:TEMP\t7-d2-py"  --snapshots-dir $snap
powershell -NoProfile -ExecutionPolicy Bypass -File "$st\run_weekly.ps1" -Date 2026-10-30 -ReportsDir "$env:TEMP\t7-d2-ps1" -SnapshotsDir $snap
Select-String 'Период' "$env:TEMP\t7-d2-py\2026-10-30-competitor-watch.md"
Select-String 'Период' "$env:TEMP\t7-d2-ps1\2026-10-30-competitor-watch.md"
```

Наблюдаемый вывод:
- `run_weekly.py` → `Предыдущий снимок не найден: отчёт будет без сравнения.` и `| Период | недельный срез на 30.10.2026 (предыдущий снимок не найден) |`.
- `run_weekly.ps1` → `Предыдущий снимок определён автоматически: 2026-10-20` и `| Период | 20.10.2026 → 30.10.2026 |`.

### 2.3. Мелкие замечания (не влияют на приёмку)

- `01-competitor-watch\tests\test_engine.py`: нумерация методов имеет разрыв `test_24` → `test_30` (методов 47, все проходят); пропущенные номера 25–29 могут сбить при ссылке на тест по номеру.
- `01-competitor-watch\scripts\run_weekly.py:23-31`: локальная функция `previous_snapshot_date` не используется (строка 74 вызывает `cw.previous_snapshot_date`) — мёртвый код, который маскирует расхождение D2.

---

## 3. Приёмка: контроль неизменности файлов вне `05-verification`

Хэши всех файлов `marketing-agents` (кроме `05-verification` и `__pycache__`) сняты до начала работы и сверены после:

- было 52 файла, стало 52;
- `CHANGED: 0`, `REMOVED: 0`, `ADDED: 0`;
- единственное изменение в рабочей папке — создание этого отчёта (`05-verification\verification-report.md`), раньше каталог был пуст.

Команда проверки:

```powershell
$base='C:\Users\Артем\Desktop\тестDH\marketing-agents'
$before=@{}; Get-Content "$env:TEMP\t7-verify\hashes-before.txt" -Encoding UTF8 | ForEach-Object { if ($_ -match '^([0-9A-Fa-f]{64})\s\s(.+)$') { $before[$matches[2]]=$matches[1].ToUpper() } }
$after=@{}; Get-ChildItem -Recurse -File $base | Where-Object { $_.FullName -notlike '*05-verification*' -and $_.FullName -notlike '*__pycache__*' } | ForEach-Object { $after[$_.FullName.Substring($base.Length+1)]=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToUpper() }
($before.Keys | Where-Object { $after[$_] -ne $before[$_] })  # должно быть пусто
```

Полный список хэшей (SHA-256, 52 файла):

```
936FB9045CAEAAD65F41021CD8BB5123439CBC299459C37EC895AEF0DA94B47E  00-admin\config\competitors.yaml
F8F60B80ABED220E988B8D2749DE92610CE1927B6326B0F2CF4B0F9EE06D136D  00-admin\config\my-objects.yaml
950F8196DAF23B2EF219C109CF32855B35B8B16CA3DD5D6C3A96373E054D1249  00-admin\config\settings.yaml
B7B5C6CCBAAAB5EF4F507AFB4C6E3E87EF5E4DF47D010FF2E3D37730D5FF99FD  00-admin\research\sources-research-2026-10-30.md
4048DE38259242B3C84994CF97905FB7B807E241360E92E207C3A9CE0D0C0637  00-admin\runbook.md
2A69BAE57A844C70B0D631D094486367765068F59F790E400B791B2BEA245C71  00-admin\scripts\validate_config.py
610825A0AF369C8894D191E6E75A3E2054E37A642E339F79096FD381F2E65E3B  01-competitor-watch\data\snapshots\2026-10-23\lots.csv
A8191F666E3D16F9E21443203C1B0465F52D552F9DC752EF5CFF508CFF8CB9A2  01-competitor-watch\data\snapshots\2026-10-30\lots.csv
CC73537106478031EBD1D01459A02EC669D878126FFD875D6FDC6CFA5A286264  01-competitor-watch\inbox\README.md
918D8A42ED6438D926437007AC2169F6465D5EFD3A2471728DCE17762A2403C5  01-competitor-watch\README.md
B33B5E9873E28C195E685590E1F3971919154D766D4DCFF5F8AAD3C5D87C2D61  01-competitor-watch\reports\.cache\diff-2026-10-30.json
2CA1DCCA19DBDE2E89DFD3260A9009B43192FE638982C901DBAF69355AB9A9AB  01-competitor-watch\reports\2026-10-30-competitor-watch.md
0958F320A590212749B46DB9BE8FB5F7C840EAD595AF4CA450B48704A768D23A  01-competitor-watch\reports\2026-10-30-competitor-watch.xlsx
49155F0197B0BFC001A3FC0B58862AD2D8016B033722CF5D2BF003349575E7D0  01-competitor-watch\reports\2026-10-30-demo\.cache\diff-2026-10-30.json
4AAA2DC59473DAE017B10FB9346460B5203A7FB91437721DBAC0DA8A2B7963D7  01-competitor-watch\reports\2026-10-30-demo\2026-10-30-competitor-watch.md
E3F5E0C5AF51888D353A3D76EEC74DF4DD081C7B337B31798583CF6708F98B21  01-competitor-watch\reports\2026-10-30-demo\2026-10-30-competitor-watch.xlsx
80F72235BB42063E9E257AE0831BFA9BDF08FABCA2ACA646CEFD2BC152B2F4A3  01-competitor-watch\scripts\build_report.py
96382BB34562EB1A7365EBBCA36A8F1D46D1694225D600777C243E72545C1C52  01-competitor-watch\scripts\build_snapshot.py
124EC497F4185535F400403B8B76AE0E153EE613048E617A96A31496DC0895CF  01-competitor-watch\scripts\build_weekly_report.py
8EF35EAC02AB77E9694C4F86C74D08B7870636D39F14F0EB7F036C9FA0542827  01-competitor-watch\scripts\cwlib.py
7A1AAD8E9FDEF9E437F1B52B8549A563F329C01A2806F596D77BAFC6EF81E597  01-competitor-watch\scripts\diff_snapshots.py
41615E4C2E190F1F870BCECD5DE4787913E516A84D2161B647BE054640F22506  01-competitor-watch\scripts\README.md
5CC580EE5AE2BCE0939710938CA0F8D9C9FCDA8F24DDC8053402C9E581741AB8  01-competitor-watch\scripts\run_weekly.ps1
698A5694353A939416D8455AC0E342C4BDE12B64D4203EFC72815A444B481454  01-competitor-watch\scripts\run_weekly.py
D80975A19D1F0B34190FC5782DF1D03DAE8938F13E92B83A5AADA42EC6A4660A  01-competitor-watch\scripts\SCHEMA.md
FFA912C65B800D3773C36CBA188A1B3EF449A25261DBA7ADB63189F48ADB8809  01-competitor-watch\scripts\snapshot_tool.py
9D6347976A3152DD56A98BEDF9276E0E70BCB64D260E9007DE5CEA784D92CD72  01-competitor-watch\templates\weekly-report.md
9A40B2AC09F310E14DAA5A227754244FA4B99FAAB737B7F93D2951494112B7EE  01-competitor-watch\tests\fixtures\broken\header-broken.csv
DF8F21CD8207E73621784E41E792ECA246E4BB77D4D4D2A878503AC642277FDD  01-competitor-watch\tests\fixtures\broken\lots.csv
8582875519AA43B76D86FC32E65686A81A234C16192373E783DC76069C77A4FF  01-competitor-watch\tests\fixtures\EXPECTED.md
610825A0AF369C8894D191E6E75A3E2054E37A642E339F79096FD381F2E65E3B  01-competitor-watch\tests\fixtures\week-2026-10-23\lots.csv
0E77DDB7AAC9C389ECDB124E9646C7D2045019FC64B31A0A005E9FC06A35F82F  01-competitor-watch\tests\fixtures\week-2026-10-30\lots.csv
35FFD1EC309E0985CCA45958283D5F72AE773E75182371D5697F97326DFDC687  01-competitor-watch\tests\test_engine.py
FC9322C36C4F4755403E359B63F41B3ADDBB4DC0C35BEF57F58629AB1E8A96D5  02-keywords-direct\README.md
FFB4C6E9D400819CAB8BBB35C89059A62F6E3AB88ACF1BD6D714D092CEE3414C  install\install-marketing-plugin.ps1
B9A227E53B879C7DB42B496FF2739B0F850953F97E1F68F80C5BC981FD918976  plugin\cordis.patch.yml
0E9AE443139D4AFEAB15185BCA5022552E1FC2C1BC91D4018BD1AD90748A5E48  plugin\lib\index.js
C61B0BA6D2F2579D46EA1BE484787185CCB5BC8F6C84B5AAC3433B2E9DD6EAF2  plugin\package.json
79971E9EFED8C4A96649B2C89CA34200E556DB9C960556BC97651E7B2C327E61  plugin\README.md
56D66467EDD5F2BBA14D82E5BF7ACB442215E4861473662BCDBF66D19BE1FF23  plugin\skills\competitor-watch\SKILL.md
03750B5F1C92A07F792BD6EE4CD83EFD2A6ECBE36F58CA0FDA995A8B243D813E  plugin\skills\direct-keywords\SKILL.md
0A65C13EADD6C2C1BD71012A4B681921563377CD883D46EC99BE22ADCE71BF40  plugin\skills\newbuild-ru-glossary\SKILL.md
B9D3AE516DE694C378A906AFCEAD9B713F7753EBBCAE00EDF42EAD44F5BC764A  README.md
56D66467EDD5F2BBA14D82E5BF7ACB442215E4861473662BCDBF66D19BE1FF23  skills\competitor-watch\SKILL.md
03750B5F1C92A07F792BD6EE4CD83EFD2A6ECBE36F58CA0FDA995A8B243D813E  skills\direct-keywords\SKILL.md
0A65C13EADD6C2C1BD71012A4B681921563377CD883D46EC99BE22ADCE71BF40  skills\newbuild-ru-glossary\SKILL.md
580B944453B52A20F5D009B3E4B78236308388380922137B64457FCE196F2988  START-HERE.md
4DC831623EC2FABC94D0A3EFEA1B39D0151C8FC4FED092C3B8FBBDAFC7EF6A55  tests\fixtures\stub-skills\heading-only-skill\SKILL.md
7E146DA34A52AE3B59A79DBA83D6A30EDFD4A733F734DEF61F582DD10A67923F  tests\fixtures\stub-skills\not-a-skill\notes.md
8005A54B8291BCC02905BBF399FBE786A2A52438895D484C2B94A9CCA9060238  tests\fixtures\stub-skills\stub-marketing-skill\references\checklist.md
6B80A8365E2771B9B34008243FD287342FB4EDBEC07DC88516BC42B6F66A4CD2  tests\fixtures\stub-skills\stub-marketing-skill\SKILL.md
032D91CE16D77F7470EDD6A1C80AF7BCF03B45F45DE0B0D668B3A25632FD2116  tests\plugin-contract.test.mjs
```

---

## 4. Пробелы покрытия (что не смог проверить и почему)

- **Реальная установка плагина** (`install-marketing-plugin.ps1` без `-DryRun`, `-Revert`) — запрещена жёстким правилом T7; проверен только `-DryRun`.
- **Работа плагина внутри живого DSH-загрузчика** (фактическое появление 3 скилов в каталоге у агента после перезапуска) — у верификатора нет доступа к сессии загрузчика; проверен контракт провайдера (`apply`/`list`/`get`) и байтовое совпадение файлов.
- **Визуальное открытие `.xlsx` в Excel** (предупреждения, «кракозябры») — проверялось `openpyxl` (структура, значения, number_format ₽/%); рендеринг Excel/LibreOffice не запускался.
- **Агент 2** (`02-keywords-direct`) — вне объекта T7 (проверялся только Агент 1, плагин и документы, на которые ссылается T7).
- **Сбор данных с реальных источников** (Циан/Авито/Яндекс) — прямой парсинг отсутствует по дизайну проекта; проверялись только контракт, валидация и обработка уже собранных снимков.
- **Поведение при отсутствии предыдущего снимка в `week_over_week`** проверялось на данных и в тесте `test_47` (не на всех возможных конфигурациях `period.days`).
- Команды из `runbook.md`/`README.md`, записывающие в боевые `data/` и `reports/`, выполнялись с временными флагами (`--snapshots-dir`/`--reports-dir`/`-SnapshotsDir`/`-ReportsDir`) — это предписанное ограничение T7, а не дословный запуск; команды, ничего не пишущие (`validate_config.py`, node-проверка), выполнены дословно.

---

## 5. Повторная проверка T9 (после фиксов T8)

Проверка выполнена на текущем состоянии кода после закрытия T8 (data-engine). Все прогоны — снова в `%TEMP%`; боевые данные не менялись.

### 5.1. Вердикт по дефектам

| Дефект | Вердикт T9 | Доказательство |
|---|---|---|
| **D1** — медиана/среднее включают active-лоты без цены или площади | **ИСПРАВЛЕН (полностью)** | `stats_ppm2` требует `price_rub` И `area_m2>0` и считает `price_rub/area_m2`; сценарий из T7 даёт `median: 15 mean: 15 expected: 15` вместо `454/479` |
| **D2** — `.py` и `.ps1` по-разному выбирают предыдущий снимок | **ИСПРАВЛЕН (полностью)** | обе обёртки используют единое правило `cwlib.previous_snapshot_date` + `period.compare_mode`; во всех трёх контрольных случаях даты периода совпадают |

### 5.2. D1 — повтор ровно команды из §2.2

Скрипт `t9_d1.py` — дословно тот же сценарий T7 (active-лоты `10`, `20`, `999` без `price_rub`, `888` без `area_m2`):

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
@'
import sys
sys.path.insert(0, r"C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\scripts")
import cwlib as cw
from diff_snapshots import compute_diff
def row(**kw):
    base = dict(snapshot_date="2026-01-01", source="cian", competitor="C", project="P", lot_id="L",
                url="https://x", rooms=2, area_m2=50.0, floor=1, floors_total=1, building="",
                price_rub=None, price_per_m2_rub=None, finish="чистовая", promo_flag=0,
                promo_text="", delivery="2027-Q1", status="active")
    base.update(kw); return base
rows = [row(lot_id="OK1", price_rub=100.0, area_m2=10.0, price_per_m2_rub=10.0),
        row(lot_id="OK2", price_rub=200.0, area_m2=10.0, price_per_m2_rub=20.0),
        row(lot_id="NOPRICE", price_rub=None,  area_m2=50.0,  price_per_m2_rub=999.0),
        row(lot_id="NOAREA",  price_rub=300.0, area_m2=None,  price_per_m2_rub=888.0)]
p = compute_diff(None, rows, 0.5, None, "2026-01-01")["price_by_project"][0]
print("median:", p["median_ppm2_curr"], "mean:", p["mean_ppm2_curr"], "expected:", cw.median_rounded([10.0,20.0]))
print("stats_ppm2 NOPRICE:", cw.stats_ppm2(rows[2]), "NOAREA:", cw.stats_ppm2(rows[3]))
'@ | Set-Content -Encoding UTF8 "$env:TEMP\t7-verify\t9_d1.py"
& $py "$env:TEMP\t7-verify\t9_d1.py"
```

Фактический вывод (было `median: 454 mean: 479 expected: 15`):

```
median: 15 mean: 15 expected: 15
stats_ppm2 NOPRICE: None NOAREA: None
```

Дополнительно проверено, что статистика пересчитывает значение, а не берёт сохранённое `price_per_m2_rub` (строгий сценарий: `price_rub=100, area_m2=3, price_per_m2_rub=999`):

```
stats_ppm2: 33.333333333333336  ppm2_of: 999.0
median_rounded([stats_ppm2]): 33
```

Код: [`cwlib.py` §`stats_ppm2`](01-competitor-watch/scripts/cwlib.py#L284-L304) (новый), [`diff_snapshots.py:243-244,272-273,286-287`](01-competitor-watch/scripts/diff_snapshots.py#L243-L287) — статистика идёт через `stats_ppm2`. Регресс-тесты T8: `test_engine.py::test_53_lots_without_price_or_area_stay_out_of_medians`, `::test_53b_stats_ppm2_requires_price_and_area` — проходят.

### 5.3. D2 — три случая выбора предыдущего снимка, `.py` против `.ps1`

Снимок `2026-10-30` (боевой) + подготовленные в `%TEMP%` предыдущие снимки. Сначала ровно команда из §2.2 (снимки `2026-10-20` и `2026-10-30`, режим по умолчанию `week_over_week`):

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$st = "C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\scripts"
$snap = "$env:TEMP\t7-d2-snap"
New-Item -ItemType Directory -Force -Path "$snap\2026-10-30","$snap\2026-10-20" | Out-Null
Copy-Item 'C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\data\snapshots\2026-10-30\lots.csv' "$snap\2026-10-30\lots.csv" -Force
(Get-Content -Raw -Encoding UTF8 'C:\Users\Артем\Desktop\тестDH\marketing-agents\01-competitor-watch\data\snapshots\2026-10-23\lots.csv') -replace '2026-10-23','2026-10-20' | Set-Content -Encoding UTF8 "$snap\2026-10-20\lots.csv"
& $py "$st\run_weekly.py"  --date 2026-10-30 --reports-dir "$env:TEMP\t7-d2-py"  --snapshots-dir $snap
powershell -NoProfile -ExecutionPolicy Bypass -File "$st\run_weekly.ps1" -Date 2026-10-30 -ReportsDir "$env:TEMP\t7-d2-ps1" -SnapshotsDir $snap
Select-String 'Период' "$env:TEMP\t7-d2-py\2026-10-30-competitor-watch.md"
Select-String 'Период' "$env:TEMP\t7-d2-ps1\2026-10-30-competitor-watch.md"
```

Полная матрица (каждый случай прогнан отдельно для python-алиаса и для PowerShell-обёртки; сравнивалась строка «Период» итогового md):

| Случай | Снимки в каталоге | Режим | `.py` (`run_weekly.py`) | `.ps1` (`run_weekly.ps1`) | Совпадение |
|---|---|---|---|---|---|
| 1. ровно 7 дней | `2026-10-23` + `2026-10-30` | `week_over_week` (default) | `23.10.2026 → 30.10.2026` | `23.10.2026 → 30.10.2026` | **да** |
| 2. только ближайший (8 дней) | `2026-10-20` + `2026-10-30` | `week_over_week` (default) | `недельный срез на 30.10.2026 (предыдущий снимок не найден)` | то же | **да** |
| 3. предыдущего нет | только `2026-10-30` | `week_over_week` (default) | `недельный срез на 30.10.2026 (предыдущий снимок не найден)` | то же | **да** |
| 4. только ближайший, бонус | `2026-10-20` + `2026-10-30` | `previous_snapshot` | `20.10.2026 → 30.10.2026` | `20.10.2026 → 30.10.2026` | **да** |
| 5. явный `--prev`/`-Prev` перекрывает режим | `2026-10-20` + `2026-10-30` | явно `2026-10-20` | `20.10.2026 → 30.10.2026` | `20.10.2026 → 30.10.2026` | **да** |

Во всех случаях `exit=0`; строки логов совпадают: `Предыдущий снимок (week_over_week): 2026-10-23` / `Предыдущий снимок (previous_snapshot): 2026-10-20` / `Предыдущий снимок не найден: отчёт без сравнения неделя-к-неделе.` Пункт 2 отличается от T7: раньше `.py` строил отчёт без сравнения, а `.ps1` — сравнение `20.10 → 30.10`; теперь обе обёртки ведут себя одинаково.

Дополнительно: `diff_snapshots.py` без `--prev` стал допустимым — `has_prev=false`, `prev_date=null`, `exit=0`, предупреждение о `week_over_week` в stderr.

### 5.4. Регресс-контроль отчёта 2026-10-23 → 2026-10-30

- **Тесты движка:** `python -m unittest discover -s marketing-agents/01-competitor-watch/tests -v` → **Ran 52 tests … OK** (в T7 было 47; T8 добавил 5 тестов, включая `test_53`, `test_53b`, `test_54`, `test_55`, `test_56`).
- **Независимая арифметика** (`indep_diff.py`, без `cwlib`) против нового `reports\.cache\diff-2026-10-30.json`: совпало **16/16** метрик; `project_table_mismatches: 0`, `rooms_table_mismatches: 0`.
- **Числа не разъехались:** `price_changes=2`, `below_threshold=1`, `median_ppm2_curr/prev = 331518 / 329838`, `mean = 332361 / 337459`, `delta_median = +0.51`; по проектам `City Bay 380000/380000`, `Селигер Сити 330000/322338`, `Символ 275000/260000` (по-прежнему `stats_excluded=true`); `min_lots_for_stats=3`; «Символ» остаётся в счётчиках §6.
- **md-отчёт не изменился:** SHA-256 `2CA1DCCA19DBDE2E89DFD3260A9009B43192FE638982C901DBAF69355AB9A9AB` — тот же, что в T7 (файл не входил в список изменённых T8). Пересборка в `%TEMP%` даёт md, отличающийся от боевого **только** строкой пути к файлу ограничений (`…reports/.cache/limitations-…` против временного `--reports-dir`); все числа и разделы идентичны.
- **XLSX:** «Сводка» и все ячейки совпадают с боевым (сравнение cell-by-cell: **0 расхождений**); точные значения `331518 / 332361 / 329838` и округление только в md сохранены. Байтовый SHA-256 `.xlsx` изменился (`0958F320…` → `7458E56E…`), но это метаданные архива openpyxl: по значениям ячеек различий нет.
- **JSON diff:** равен прежнему по всем полям, кроме `generated_at`.

### 5.5. Новые дефекты

**Не найдено.** Прогон не выявил регрессий и новых дефектов в исправленных путях.

Мелкие замечания (не дефекты):

- [`diff_snapshots.py:286-287`](01-competitor-watch/scripts/diff_snapshots.py#L286-L287): в фильтре используется `cw.ppm2_of(r)`, а значением берётся `cw.stats_ppm2(r)`. На результат не влияет (`median_rounded`/`mean_rounded` отбрасывают `None`), но условие стоило бы привести к `cw.stats_ppm2(r)` для единообразия.
- Разрыв нумерации тестов `test_24` → `test_30` (пропущены 25–29) сохранился; методы 53/53b/54/55/56 добавлены корректно и проходят.

### 5.6. Неизменность файлов вне `05-verification` (T9)

Хэши файлов вне `05-verification` сняты до начала T9 (53 файла) и сверены после прогонов:

- `CHANGED=0`, `REMOVED=0` — ни один существовавший файл не изменён и не удалён;
- `ADDED=1` — `install\register-profile-bundle.mjs` (создан 30.10.2026 22:44:22, т.е. уже во время T9, размер 2856 байт). **Это не моя запись:** все мои команды писали только в `%TEMP%` и в этот отчёт, файл появился параллельно от другого участника в общем рабочем каталоге; я его не создавал и не редактировал;
- из моих изменений — только раздел 5, дописанный в `marketing-agents\05-verification\verification-report.md`.

Справочно, что изменил T8 (сверка хэшей T7 → T9): `cwlib.py`, `diff_snapshots.py`, `build_weekly_report.py`, `run_weekly.py`, `run_weekly.ps1`, `scripts/README.md`, `tests/test_engine.py`, `tests/fixtures/EXPECTED.md`, корневой `README.md`, боевые `reports\.cache\diff-*.json` и `.xlsx` (обновлены движком), добавлен `skills\README.md`.


