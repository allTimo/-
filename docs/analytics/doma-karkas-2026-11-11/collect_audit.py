# -*- coding: utf-8 -*-
"""Аудит: расход Директа (CSV из кабинета) × конверсии Метрики по ID кампании.

Вход: 2026-11-11_21-24-23_intel-denisov.csv (выгрузка кабинета, период совпадает с Метрикой).
Выход: audit-report.md, audit.xlsx.
Только чтение; ничего в Директе не меняется.
"""
from __future__ import annotations

import csv
import json
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.runtime.core import env_value, load_env_file  # noqa: E402

COUNTER = "22595095"
CSV_PATH = Path(r"C:\Users\Артем\Downloads\2026-11-11_21-24-23_intel-denisov.csv")
TODAY = date(2026, 11, 11)
FROM = TODAY - timedelta(days=89)
HERE = Path(__file__).resolve().parent
STAT = "https://api-metrika.yandex.net/stat/v1/data"

load_env_file()
TOKEN = env_value("YANDEX_OAUTH_TOKEN")


def api(url: str) -> dict:
    request = urllib.request.Request(
        url, headers={"Authorization": f"OAuth {TOKEN}", "Accept-Language": "ru"}, method="GET"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def num(value) -> float:
    try:
        return float(str(value).replace(" ", "").replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def money(value) -> str:
    if value is None:
        return "данных нет"
    return f"{value:,.0f}".replace(",", " ") + " ₽"


def fmt(value) -> str:
    if value is None:
        return "данных нет"
    return f"{value:,.2f}".replace(",", " ")


# --- 1. CSV кабинета
cabinet: dict[str, dict] = {}
total_row = None
with CSV_PATH.open(encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        name = (row.get("Название кампании") or "").strip()
        cid = (row.get("№ Кампании") or "").strip()
        item = {
            "name": name,
            "spend": num(row.get("Расход, ₽")),
            "clicks": num(row.get("Клики")),
            "conv": num(row.get("Конверсии")),
            "cr": num(row.get("CR, %")),
            "cpa": num(row.get("CPA, ₽")),
        }
        if name.lower().startswith("итого") or (not cid and not name):
            total_row = item
        elif cid:
            cabinet[cid] = item

# --- 2. Метрика по ID кампании
goals = api(f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}/goals").get("goals", [])
by_name = {str(g.get("name") or ""): g.get("id") for g in goals}
KEY = {
    "Звонок": by_name.get("Звонок"),
    "Лид": by_name.get("Лид"),
    "Формы": by_name.get("Отправка всех форм"),
    "Заказ создан": by_name.get("CRM: Заказ создан"),
    "Заказ оплачен": by_name.get("CRM: Заказ оплачен"),
}
metrics = "ym:s:visits," + ",".join(f"ym:s:goal{gid}reaches" for gid in KEY.values() if gid)
params = {
    "ids": COUNTER,
    "date1": str(FROM),
    "date2": str(TODAY),
    "metrics": metrics,
    "dimensions": "ym:s:lastDirectClickOrder",
    "limit": "100",
    "sort": "-ym:s:visits",
}
metrika: dict[str, dict] = {}
raw = api(f"{STAT}?{urllib.parse.urlencode(params)}")
goal_keys = [name for name, gid in KEY.items() if gid]
for row in raw.get("data") or []:
    dims = row.get("dimensions") or []
    cid = str(dims[0].get("id") if isinstance(dims[0], dict) else dims[0])
    vals = [num(v) for v in (row.get("metrics") or [])]
    metrika[cid] = {"visits": vals[0] if vals else 0, **dict(zip(goal_keys, vals[1:]))}

# --- 3. Свод
rows = []
for cid, cab in cabinet.items():
    met = metrika.get(cid, {})
    visits = met.get("visits", 0)
    orders = met.get("Заказ создан", 0)
    paid = met.get("Заказ оплачен", 0)
    rows.append({
        "id": cid,
        "name": cab["name"],
        "spend": cab["spend"],
        "clicks": cab["clicks"],
        "dir_conv": cab["conv"],
        "visits": visits,
        "calls": met.get("Звонок", 0),
        "leads": met.get("Лид", 0),
        "forms": met.get("Формы", 0),
        "orders": orders,
        "paid": paid,
        "cpv": cab["spend"] / visits if visits else None,
        "cpo": cab["spend"] / orders if orders else None,
        "cpp": cab["spend"] / paid if paid else None,
        "dir_cpa": cab["cpa"],
    })
for cid, met in metrika.items():
    if cid not in cabinet:
        rows.append({
            "id": cid, "name": "(нет в выгрузке кабинета)", "spend": 0, "clicks": 0, "dir_conv": 0,
            "visits": met.get("visits", 0), "calls": met.get("Звонок", 0), "leads": met.get("Лид", 0),
            "forms": met.get("Формы", 0), "orders": met.get("Заказ создан", 0),
            "paid": met.get("Заказ оплачен", 0), "cpv": None, "cpo": None, "cpp": None, "dir_cpa": None,
        })
rows.sort(key=lambda r: -r["spend"])

total = {
    "spend": sum(r["spend"] for r in rows),
    "clicks": sum(r["clicks"] for r in rows),
    "dir_conv": sum(r["dir_conv"] for r in rows),
    "visits": sum(r["visits"] for r in rows),
    "calls": sum(r["calls"] for r in rows),
    "leads": sum(r["leads"] for r in rows),
    "forms": sum(r["forms"] for r in rows),
    "orders": sum(r["orders"] for r in rows),
    "paid": sum(r["paid"] for r in rows),
}

md: list[str] = []
md.append("# Аудит: расход Директа × конверсии Метрики (doma-karkas.ru)")
md.append(f"\nПериод: **{FROM} … {TODAY}** (90 дней). Расход — выгрузка кабинета Директа "
          f"(`{CSV_PATH.name}`, {TODAY}); конверсии и визиты — Яндекс.Метрика `stat/v1/data`, "
          f"счётчик {COUNTER}. Сопоставление по номеру кампании.\n")
md.append("## Сводка\n")
md.append("| Показатель | Значение |")
md.append("|---|---|")
md.append(f"| Расход | {money(total['spend'])} |")
md.append(f"| Клики (Директ) | {int(total['clicks']):,}".replace(",", " ") + " |")
md.append(f"| «Конверсии» Директа | {int(total['dir_conv']):,}".replace(",", " ") + " |")
md.append(f"| Визиты (Метрика) | {int(total['visits']):,}".replace(",", " ") + " |")
md.append(f"| Звонки | {int(total['calls'])} |")
md.append(f"| Лиды | {int(total['leads'])} |")
md.append(f"| Отправки форм | {int(total['forms']):,}".replace(",", " ") + " |")
md.append(f"| CRM: заказы созданы | {int(total['orders'])} |")
md.append(f"| CRM: заказы оплачены | **{int(total['paid'])}** |")
if total["paid"]:
    md.append(f"| Цена оплаченного заказа (расход / оплаты) | **{money(total['spend'] / total['paid'])}** |")
if total["orders"]:
    md.append(f"| Цена заказа (расход / заказы) | {money(total['spend'] / total['orders'])} |")
if total["dir_conv"]:
    md.append(f"| CPA Директа (по его «конверсиям») | {money(total['spend'] / total['dir_conv'])} |")
md.append("")

md.append("## Кампании: расход и реальные заказы\n")
md.append("| Кампания | Расход | Клики | «Конв.» Директа | Визиты | Звонки | Формы | Заказы | Оплаты | Цена заказа | Цена оплаты |")
md.append("|---|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    md.append("| {name} | {spend} | {clicks} | {conv} | {visits} | {calls} | {forms} | {orders} | {paid} | {cpo} | {cpp} |".format(
        name=r["name"][:58], spend=money(r["spend"]), clicks=int(r["clicks"]),
        conv=int(r["dir_conv"]), visits=int(r["visits"]), calls=int(r["calls"]),
        forms=int(r["forms"]), orders=int(r["orders"]), paid=int(r["paid"]),
        cpo=money(r["cpo"]) if r["cpo"] else "—", cpp=money(r["cpp"]) if r["cpp"] else "—",
    ))
md.append("")

# --- 4. Выводы
zero_paid = [r for r in rows if r["spend"] > 50000 and r["paid"] == 0]
md.append("## Выводы\n")
md.append(f"1. **Разрыв в счёте конверсий.** Директ отчитывается о {int(total['dir_conv']):,} конверсиях "
          f"(CPA {money(total['spend'] / total['dir_conv']) if total['dir_conv'] else '—'}), "
          f"а в Метрике за тот же период {int(total['orders'])} заказов и {int(total['paid'])} оплат. "
          "Значит в счётчик конверсий Директа включены микроцели — автостратегии оптимизируются на них, "
          "а не на продажи.".replace(",", " "))
if zero_paid:
    md.append("2. **Кампании с расходом и нулём оплат:**")
    for r in zero_paid:
        md.append(f"   * {r['name'][:70]} — {money(r['spend'])}, визитов {int(r['visits'])}, "
                  f"заказов {int(r['orders'])}, оплат 0.")
if total["paid"]:
    md.append(f"3. **Ориентир по экономике:** цена оплаченного заказа по аккаунту — "
              f"{money(total['spend'] / total['paid'])}; сравнивать с маржой проекта (нужны AOV и маржинальность).")
md.append("4. **Кампании с нулевым расходом, но с кликами** («Поиск-строительство», «Поиск-керамические дома», "
          "«Поиск-каменные дома», «Поиск-газобетон»): в выгрузке 0 ₽ при 33–66 кликах — уточнить, "
          "списывается ли бюджет (возможно, другой тип оплаты или неполная выгрузка).")
md.append("")

audit_md = HERE / "audit-report.md"
audit_md.write_text("\n".join(md) + "\n", encoding="utf-8")
print("markdown:", audit_md)

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Кампании"
    headers = ["Кампания", "ID", "Расход, ₽", "Клики", "Конверсии Директа", "Визиты Метрики",
               "Звонки", "Лиды", "Формы", "Заказы CRM", "Оплаты CRM", "Цена заказа, ₽", "Цена оплаты, ₽"]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for r in rows:
        ws.append([r["name"], r["id"], round(r["spend"], 2), int(r["clicks"]), int(r["dir_conv"]),
                   int(r["visits"]), int(r["calls"]), int(r["leads"]), int(r["forms"]),
                   int(r["orders"]), int(r["paid"]),
                   round(r["cpo"], 2) if r["cpo"] else None, round(r["cpp"], 2) if r["cpp"] else None])
    for column in ws.columns:
        width = max(len(str(c.value or "")) for c in column) + 2
        ws.column_dimensions[column[0].column_letter].width = min(width, 50)
    ws2 = wb.create_sheet("Итоги")
    ws2.append(["Показатель", "Значение"])
    ws2["A1"].font = Font(bold=True)
    ws2["B1"].font = Font(bold=True)
    for key, value in (("Расход, ₽", round(total["spend"], 2)), ("Клики", int(total["clicks"])),
                       ("Конверсии Директа", int(total["dir_conv"])), ("Визиты Метрики", int(total["visits"])),
                       ("Звонки", int(total["calls"])), ("Лиды", int(total["leads"])),
                       ("Формы", int(total["forms"])), ("Заказы CRM", int(total["orders"])),
                       ("Оплаты CRM", int(total["paid"])),
                       ("Цена заказа, ₽", round(total["spend"] / total["orders"], 2) if total["orders"] else None),
                       ("Цена оплаты, ₽", round(total["spend"] / total["paid"], 2) if total["paid"] else None)):
        ws2.append([key, value])
    wb.save(HERE / "audit.xlsx")
    print("xlsx:", HERE / "audit.xlsx")
except Exception as exc:  # noqa: BLE001
    print("xlsx не создан:", type(exc).__name__, exc)

print(json.dumps({"spend": round(total["spend"]), "paid": int(total["paid"]),
                  "orders": int(total["orders"]), "visits": int(total["visits"])}, ensure_ascii=False))
