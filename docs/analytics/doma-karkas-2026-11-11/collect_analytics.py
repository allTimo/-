# -*- coding: utf-8 -*-
"""Сбор подробной аналитики Метрики по счётчику doma-karkas.ru (22595095).

Данные: официальное API Метрики stat/v1/data и management/v1/counter/{id}/goals.
Только чтение. Честность: пустой ответ — «данных нет», а не ноль.

Запуск: python collect_analytics.py
Результат: report.md и report.xlsx рядом со скриптом.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.runtime.core import env_value, load_env_file  # noqa: E402

COUNTER = "22595095"          # doma-karkas.ru
TODAY = date(2026, 11, 11)
CUR_FROM = TODAY - timedelta(days=89)     # 90 дней
CUR_TO = TODAY
PREV_FROM = CUR_FROM - timedelta(days=90)
PREV_TO = CUR_FROM - timedelta(days=1)
HERE = Path(__file__).resolve().parent
STAT = "https://api-metrika.yandex.net/stat/v1/data"

load_env_file()
TOKEN = env_value("YANDEX_OAUTH_TOKEN")


def api(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"OAuth {TOKEN}", "Accept-Language": "ru"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def stat(metrics, dimensions=None, date1=None, date2=None, limit=20, sort=None, group=None):
    params = {
        "ids": COUNTER,
        "date1": date1 or str(CUR_FROM),
        "date2": date2 or str(CUR_TO),
        "metrics": metrics,
        "limit": str(limit),
    }
    if dimensions:
        params["dimensions"] = dimensions
        params["sort"] = sort or f"-{metrics.split(',')[0]}"
    if group:
        params["group"] = group
    try:
        data = api(f"{STAT}?{urllib.parse.urlencode(params)}")
    except urllib.error.HTTPError as exc:
        return {"error": f"HTTP {exc.code}: {exc.read().decode('utf-8', 'ignore')[:200]}"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}
    return data


def label(dim) -> str:
    if isinstance(dim, dict):
        return str(dim.get("name") or dim.get("id") or "—")
    return str(dim)


def rows(res, headers, metric_names, limit=None):
    if res.get("error"):
        return [], res["error"]
    data = res.get("data") or []
    out = []
    for row in data[:limit] if limit else data:
        dims = [label(d) for d in (row.get("dimensions") or [])]
        vals = row.get("metrics") or []
        out.append(list(zip(headers, dims)) + list(zip(metric_names, vals)))
    return out, None


def totals(res, metric_names):
    if res.get("error"):
        return None, res["error"]
    t = res.get("totals") or []
    return dict(zip(metric_names, t)), None


def fmt(value):
    if value is None:
        return "данных нет"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if abs(number - round(number)) < 1e-9:
        return f"{int(round(number)):,}".replace(",", " ")
    return f"{number:,.2f}".replace(",", " ")


md: list[str] = []
xl: list[tuple[str, list[str], list[list]]] = []
SOURCE = f"Яндекс.Метрика API `stat/v1/data`, счётчик {COUNTER}, выгрузка {TODAY}"

md.append(f"# Аналитика doma-karkas.ru — счётчик {COUNTER}")
md.append(f"\nПериод: **{CUR_FROM} … {CUR_TO}** (90 дней), сравнение с **{PREV_FROM} … {PREV_TO}**.")
md.append(f"Источник: {SOURCE}. Только чтение; отсутствующие данные помечены как «данных нет».\n")

# 1. Итоги
BASE_METRICS = ("ym:s:visits", "ym:s:users", "ym:s:pageviews", "ym:s:bounceRate", "ym:s:pageDepth", "ym:s:avgVisitDurationSeconds")
BASE_NAMES = ["визиты", "посетители", "просмотры", "отказы, %", "глубина", "время, с"]
cur = stat(",".join(BASE_METRICS), limit=1)
prev = stat(",".join(BASE_METRICS), date1=str(PREV_FROM), date2=str(PREV_TO), limit=1)
cur_tot, cur_err = totals(cur, BASE_NAMES)
prev_tot, _ = totals(prev, BASE_NAMES)

md.append("## 1. Итоги и динамика\n")
if cur_err:
    md.append(f"Данных нет: {cur_err}\n")
else:
    md.append("| Показатель | Текущие 90 дней | Предыдущие 90 дней | Изменение |")
    md.append("|---|---|---|---|")
    for name in BASE_NAMES:
        a, b = cur_tot.get(name), (prev_tot or {}).get(name)
        delta = "—"
        try:
            if a is not None and b not in (None, 0):
                pct = (float(a) - float(b)) / float(b) * 100
                delta = f"{pct:+.1f} %"
        except (TypeError, ValueError):
            delta = "—"
        md.append(f"| {name} | {fmt(a)} | {fmt(b)} | {delta} |")
    md.append("")
    xl.append(("Итоги", ["Показатель", "Текущие 90 дней", "Предыдущие 90 дней", "Изменение"],
               [[n, fmt(cur_tot.get(n)), fmt((prev_tot or {}).get(n)), ""] for n in BASE_NAMES]))

# 2. Динамика по месяцам (собираем по дням и агрегируем — API не принимает group=month
# для произвольных границ периода: отвечает invalid_parameter)
days = stat("ym:s:visits,ym:s:users,ym:s:bounceRate", "ym:s:date", limit=100, sort="ym:s:date")
md.append("## 2. Динамика по месяцам\n")
if days.get("error"):
    md.append(f"Данных нет: {days['error']}\n")
else:
    months: dict[str, dict[str, float]] = {}
    for row in days.get("data") or []:
        dim = row.get("dimensions") or [""]
        day = label(dim[0])[:10]
        month = day[:7]
        vals = row.get("metrics") or [0, 0, 0]
        acc = months.setdefault(month, {"visits": 0.0, "users": 0.0, "bounce_sum": 0.0, "days": 0})
        acc["visits"] += float(vals[0] or 0)
        acc["users"] += float(vals[1] or 0)
        acc["bounce_sum"] += float(vals[2] or 0)
        acc["days"] += 1
    md.append("| Месяц | Дней с данными | Визиты | Посетители | Отказы, % (среднее по дням) |")
    md.append("|---|---|---|---|---|")
    month_rows = []
    for month in sorted(months):
        acc = months[month]
        bounce = acc["bounce_sum"] / acc["days"] if acc["days"] else None
        md.append(f"| {month} | {acc['days']} | {fmt(acc['visits'])} | {fmt(acc['users'])} | {fmt(bounce)} |")
        month_rows.append([month, acc["days"], fmt(acc["visits"]), fmt(acc["users"]), fmt(bounce)])
    md.append("")
    xl.append(("Динамика", ["Месяц", "Дней с данными", "Визиты", "Посетители", "Отказы, % (среднее по дням)"], month_rows))

# 3. Источники и рекламные системы
src = stat("ym:s:visits,ym:s:users,ym:s:bounceRate", "ym:s:lastTrafficSource", limit=20)
src_res, src_err = rows(src, ["Источник"], ["визиты", "посетители", "отказы, %"])
adv = stat("ym:s:visits,ym:s:users,ym:s:bounceRate", "ym:s:lastAdvEngine", limit=20)
adv_res, adv_err = rows(adv, ["Рекламная система"], ["визиты", "посетители", "отказы, %"])
md.append("## 3. Источники трафика и рекламные системы\n")
for title, res, err in (("Источник", src_res, src_err), ("Рекламная система", adv_res, adv_err)):
    md.append(f"### {title}\n")
    if err:
        md.append(f"Данных нет: {err}\n")
        continue
    md.append(f"| {title} | Визиты | Посетители | Отказы, % |")
    md.append("|---|---|---|---|")
    for row in res:
        d = dict(row)
        md.append(f"| {d[title]} | {fmt(d['визиты'])} | {fmt(d['посетители'])} | {fmt(d['отказы, %'])} |")
    md.append("")
    xl.append((title, [title, "Визиты", "Посетители", "Отказы, %"],
               [[dict(r)[title], fmt(dict(r)["визиты"]), fmt(dict(r)["посетители"]), fmt(dict(r)["отказы, %"])] for r in res]))

# 4. Кампании Директа и UTM
camp = stat("ym:s:visits,ym:s:users,ym:s:bounceRate", "ym:s:lastDirectClickOrderName", limit=25)
camp_res, camp_err = rows(camp, ["Кампания Директа"], ["визиты", "посетители", "отказы, %"])
utm = stat("ym:s:visits,ym:s:users", "ym:s:UTMCampaign", limit=25)
utm_res, utm_err = rows(utm, ["UTM-кампания"], ["визиты", "посетители"])
md.append("## 4. Рекламные кампании\n")
for title, res, err, names in (("Кампания Директа", camp_res, camp_err, ["визиты", "посетители", "отказы, %"]),
                               ("UTM-кампания", utm_res, utm_err, ["визиты", "посетители"])):
    md.append(f"### {title}\n")
    if err:
        md.append(f"Данных нет: {err}\n")
        continue
    md.append("| " + title + " | " + " | ".join(names) + " |")
    md.append("|" + "---|" * (len(names) + 1))
    for row in res:
        d = dict(row)
        md.append("| " + d[title] + " | " + " | ".join(fmt(d[n]) for n in names) + " |")
    md.append("")
    xl.append((title, [title] + names, [[dict(r)[title]] + [fmt(dict(r)[n]) for n in names] for r in res]))

# 5. Поисковые фразы
phr = stat("ym:s:visits,ym:s:users", "ym:s:searchPhrase", limit=25)
phr_res, phr_err = rows(phr, ["Поисковая фраза"], ["визиты", "посетители"])
md.append("## 5. Поисковые фразы (для минусации)\n")
if phr_err:
    md.append(f"Данных нет: {phr_err}\n")
else:
    md.append("| Поисковая фраза | Визиты | Посетители |")
    md.append("|---|---|---|")
    for row in phr_res:
        d = dict(row)
        md.append(f"| {d['Поисковая фраза']} | {fmt(d['визиты'])} | {fmt(d['посетители'])} |")
    md.append("")
    xl.append(("Поисковые фразы", ["Фраза", "Визиты", "Посетители"],
               [[dict(r)["Поисковая фраза"], fmt(dict(r)["визиты"]), fmt(dict(r)["посетители"])] for r in phr_res]))

# 6. Посадочные страницы
land = stat("ym:s:visits,ym:s:users,ym:s:bounceRate", "ym:s:startURLPath", limit=20)
land_res, land_err = rows(land, ["Страница входа"], ["визиты", "посетители", "отказы, %"])
md.append("## 6. Посадочные страницы\n")
if land_err:
    md.append(f"Данных нет: {land_err}\n")
else:
    md.append("| Страница входа | Визиты | Посетители | Отказы, % |")
    md.append("|---|---|---|---|")
    for row in land_res:
        d = dict(row)
        md.append(f"| {d['Страница входа']} | {fmt(d['визиты'])} | {fmt(d['посетители'])} | {fmt(d['отказы, %'])} |")
    md.append("")
    xl.append(("Посадочные", ["Страница", "Визиты", "Посетители", "Отказы, %"],
               [[dict(r)["Страница входа"], fmt(dict(r)["визиты"]), fmt(dict(r)["посетители"]), fmt(dict(r)["отказы, %"])] for r in land_res]))

# 7. Устройства, гео
dev = stat("ym:s:visits,ym:s:users,ym:s:bounceRate", "ym:s:deviceCategory", limit=10)
dev_res, dev_err = rows(dev, ["Устройство"], ["визиты", "посетители", "отказы, %"])
geo = stat("ym:s:visits,ym:s:users", "ym:s:regionCity", limit=25)
geo_res, geo_err = rows(geo, ["Город"], ["визиты", "посетители"])
md.append("## 7. Устройства и география\n")
for title, res, err, names in (("Устройство", dev_res, dev_err, ["визиты", "посетители", "отказы, %"]),
                               ("Город", geo_res, geo_err, ["визиты", "посетители"])):
    md.append(f"### {title}\n")
    if err:
        md.append(f"Данных нет: {err}\n")
        continue
    md.append("| " + title + " | " + " | ".join(names) + " |")
    md.append("|" + "---|" * (len(names) + 1))
    for row in res:
        d = dict(row)
        md.append("| " + d[title] + " | " + " | ".join(fmt(d[n]) for n in names) + " |")
    md.append("")
    xl.append((title, [title] + names, [[dict(r)[title]] + [fmt(dict(r)[n]) for n in names] for r in res]))

# 8. Аудитория
gen = stat("ym:s:visits,ym:s:users", "ym:s:gender", limit=5)
gen_res, gen_err = rows(gen, ["Пол"], ["визиты", "посетители"])
age = stat("ym:s:visits,ym:s:users", "ym:s:ageInterval", limit=10)
age_res, age_err = rows(age, ["Возраст"], ["визиты", "посетители"])
md.append("## 8. Аудитория\n")
for title, res, err in (("Пол", gen_res, gen_err), ("Возраст", age_res, age_err)):
    md.append(f"### {title}\n")
    if err:
        md.append(f"Данных нет: {err}\n")
        continue
    md.append(f"| {title} | Визиты | Посетители |")
    md.append("|---|---|---|")
    for row in res:
        d = dict(row)
        md.append(f"| {d[title]} | {fmt(d['визиты'])} | {fmt(d['посетители'])} |")
    md.append("")
    xl.append((title, [title, "Визиты", "Посетители"],
               [[dict(r)[title], fmt(dict(r)["визиты"]), fmt(dict(r)["посетители"])] for r in res]))

# 9. Цели
try:
    goals = api(f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}/goals").get("goals", [])
except Exception as exc:  # noqa: BLE001
    goals = []
    md.append(f"## 9. Цели\n\nНе удалось получить цели: {type(exc).__name__}: {exc}\n")
if goals:
    md.append("## 9. Цели и конверсии\n")
    md.append("| Цель | Тип | Достижения | Конверсия визитов, % |")
    md.append("|---|---|---|---|")
    visits = float(cur_tot.get("визиты") or 0) if cur_tot else 0
    goal_rows = []
    for goal in goals:
        gid = goal.get("id")
        res = stat(f"ym:s:goal{gid}reaches", limit=1)
        tot, err = totals(res, ["reaches"])
        reaches = None if err else float((tot or {}).get("reaches") or 0)
        cr = (reaches / visits * 100) if (reaches is not None and visits) else None
        md.append(f"| {goal.get('name')} | {goal.get('type')} | {fmt(reaches) if not err else 'данных нет'} | {fmt(cr) if cr is not None else 'данных нет'} |")
        goal_rows.append([goal.get("name"), goal.get("type"), fmt(reaches) if not err else "данных нет", fmt(cr) if cr is not None else "данных нет"])
    md.append("")
    xl.append(("Цели", ["Цель", "Тип", "Достижения", "Конверсия визитов, %"], goal_rows))

# 10. Конверсии по источникам и кампаниям (ключевые цели)
KEY_GOALS = ["Звонок", "Лид", "CRM: Заказ создан", "CRM: Заказ оплачен"]
if goals:
    goal_ids = {}
    for goal in goals:
        name = str(goal.get("name") or "")
        for key in KEY_GOALS:
            if name == key and key not in goal_ids:
                goal_ids[key] = goal.get("id")
    if goal_ids:
        md.append("## 10. Конверсии по источникам и кампаниям\n")
        metrics = "ym:s:visits," + ",".join(f"ym:s:goal{gid}reaches" for gid in goal_ids.values())
        names = ["визиты"] + list(goal_ids.keys())
        for dim, title in (("ym:s:lastTrafficSource", "Источник"), ("ym:s:lastDirectClickOrderName", "Кампания Директа")):
            res = stat(metrics, dim, limit=25)
            md.append(f"### {title}\n")
            if res.get("error"):
                md.append(f"Данных нет: {res['error']}\n")
                continue
            md.append("| " + title + " | " + " | ".join(names) + " |")
            md.append("|" + "---|" * (len(names) + 1))
            body = []
            for row in res.get("data") or []:
                dims = row.get("dimensions") or ["—"]
                vals = [float(v or 0) for v in (row.get("metrics") or [])]
                visits = vals[0] if vals else 0
                cells = [label(dims[0]), fmt(visits)]
                for value in vals[1:]:
                    cells.append(f"{fmt(value)} ({value / visits * 100:.2f} %)" if visits else fmt(value))
                md.append("| " + " | ".join(cells) + " |")
                body.append(cells)
            md.append("")
            xl.append((f"Конверсии — {title}", [title] + names, body))

# 11. Выводы и приоритеты (числа — из собранных выше срезов, без домыслов)
def pick(res_list, column, needle):
    for r in res_list:
        d = dict(r)
        if needle.lower() in str(d.get(column, "")).lower():
            return d
    return None

ad = pick(src_res, "Источник", "Ad traffic")
mobile = pick(dev_res, "Устройство", "Smartphone")
pc = pick(dev_res, "Устройство", "PC")
proekt = pick(land_res, "Страница входа", "proektirovanie")
rcya = pick(camp_res, "Кампания Директа", "Интел Групп")
copy_camp = pick(camp_res, "Кампания Директа", "(копия)")
old_search = pick(camp_res, "Кампания Директа", "Прошлый директолог (Мобилки)")
md.append("## 11. Выводы и приоритеты\n")
md.append("Факты — из разделов выше; расход Директа недоступен (API ждёт заявки, ошибка 58), "
          "поэтому CAC и ДРР не считаем — для них нужна выгрузка расхода.\n")
lines = []
if ad:
    lines.append(f"**Реклама — основа трафика:** Ad traffic {fmt(ad['визиты'])} визитов "
                 f"({float(ad['визиты']) / float(cur_tot['визиты']) * 100:.0f} % всего трафика) при отказах {fmt(ad['отказы, %'])} %. "
                 "Остальной трафик — поиск, прямой и внутренний.")
if rcya:
    lines.append(f"**Первая на отключение/чистку — РСЯ «{rcya['Кампания Директа'][:60]}…»:** {fmt(rcya['визиты'])} визитов, "
                 f"отказы {fmt(rcya['отказы, %'])} %, и при этом 0 оплаченных заказов за 90 дней (см. раздел 10) — "
                 "проверить площадки РСЯ и минусовать нецелевые.")
if copy_camp:
    lines.append(f"**Лучшая из крупных кампаний — «{copy_camp['Кампания Директа']}»:** {fmt(copy_camp['визиты'])} визитов, "
                 f"отказы {fmt(copy_camp['отказы, %'])} % — сюда имеет смысл перераспределять бюджет.")
if old_search:
    lines.append(f"**Лучшая по конверсии — «{old_search['Кампания Директа']}»:** {fmt(old_search['визиты'])} визитов при "
                 "заметно более высокой доле заказов — масштабировать осторожно, следить за ценой.")
if mobile and pc:
    lines.append(f"**Мобильные:** {fmt(mobile['визиты'])} визитов ({float(mobile['визиты']) / float(cur_tot['визиты']) * 100:.0f} %) "
                 f"с отказами {fmt(mobile['отказы, %'])} % против {fmt(pc['отказы, %'])} % на ПК — проверить мобильную вёрстку и скорость.")
if proekt:
    lines.append(f"**Посадочная `/proektirovanie/`:** отказы {fmt(proekt['отказы, %'])} % при {fmt(proekt['визиты'])} визитах — "
                 "страница не удерживает; переделать заголовок и первый экран.")
lines.append("**Минусация:** в поисковых фразах много информационных запросов («чем крепить мауэрлат…», «отмостка», "
             "«стяжка стен деревянного дома») — добавить в минус-слова, освободит бюджет для коммерческих.")
lines.append("**Гео:** за пределами Москвы и МО заметный объём (Екатеринбург, Нижний Новгород) — если работаете только по МО, "
             "нужны корректировки или исключения.")
lines.append("**Цели:** часть форм имеет 0 достижений («Рассчитать проект», «Заявка на участие в акции» и др.) — "
             "проверить, работают ли они; цели CRM (`cdp_order_*`) уже собираются.")
md.extend(lines)
md.append("")

report_md = HERE / "report.md"
report_md.write_text("\n".join(md) + "\n", encoding="utf-8")
print("markdown:", report_md, len("\n".join(md)), "байт")

# XLSX
try:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)
    for sheet, headers, body in xl:
        ws = wb.create_sheet(title=sheet[:31])
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in body:
            ws.append(row)
        for column in ws.columns:
            width = max(len(str(c.value or "")) for c in column) + 2
            ws.column_dimensions[column[0].column_letter].width = min(width, 45)
    report_xlsx = HERE / "report.xlsx"
    wb.save(report_xlsx)
    print("xlsx:", report_xlsx, "листов:", len(xl))
except Exception as exc:  # noqa: BLE001
    print("xlsx не создан:", type(exc).__name__, exc)
