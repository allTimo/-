# -*- coding: utf-8 -*-
"""Аналитика сайта doma-karkas.ru: разделы, воронка, устройства (только чтение Метрики)."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.runtime.core import env_value, load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
COUNTER = "22595095"
STAT = "https://api-metrika.yandex.net/stat/v1/data"
D1, D2 = "2026-08-19", "2026-11-16"
load_env_file()
HEADERS = {"Authorization": f"OAuth {env_value('YANDEX_OAUTH_TOKEN')}", "Accept-Language": "ru"}

GOALS = {"call": 41224933, "lid": 309041787, "form_all": 297819512, "form_call": 309041485,
         "form_build": 309041783, "form_calc": 309041486, "filter": 585877682, "order": 595094381,
         "paid": 595094382, "spam": 595094383, "cancel": 595094384}
METRICS = ["ym:s:visits", "ym:s:users", "ym:s:bounceRate", "ym:s:pageDepth", "ym:s:avgVisitDurationSeconds"]
M_NAMES = ["visits", "users", "bounceRate", "pageDepth", "avgVisitDurationSeconds"]
G_NAMES = list(GOALS.keys())
ALL_METRICS = METRICS + [f"ym:s:goal{gid}reaches" for gid in GOALS.values()]
ALL_NAMES = M_NAMES + G_NAMES


def stat(metrics, dims=(), limit=100, sort=None, date1=D1, date2=D2):
    p = {"ids": COUNTER, "date1": date1, "date2": date2, "limit": str(limit), "accuracy": "full",
         "metrics": ",".join(metrics)}
    if dims:
        p["dimensions"] = ",".join(dims)
    p["sort"] = sort or (dims[0] if dims else metrics[0])
    url = f"{STAT}?{urllib.parse.urlencode(p)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print("HTTP error:", exc.code, exc.read().decode("utf-8", "ignore")[:150])
        return {"data": []}
    time.sleep(0.35)
    return payload


def nm(v):
    if isinstance(v, dict):
        return v.get("name") or v.get("url") or v.get("id")
    return v


def rows(payload, names):
    out = []
    for row in payload.get("data") or []:
        d = [nm(v) for v in (row.get("dimensions") or [])]
        m = row.get("metrics") or []
        item = {"dim": d[0] if d else None}
        for i, n in enumerate(names):
            item[n] = m[i] if i < len(m) else None
        out.append(item)
    return out


def section_of(url: str) -> str:
    u = str(url or "").replace("https://doma-karkas.ru", "").replace("http://doma-karkas.ru", "")
    u = u.split("?")[0]
    if u in ("", "/"):
        return "Главная"
    parts = [p for p in u.split("/") if p]
    if not parts:
        return "Главная"
    first = parts[0]
    if first == "catalog":
        return "Каталог: раздел" if len(parts) == 2 else "Каталог: карточка проекта"
    return {
        "articles": "Статьи / блог", "proektirovanie": "Проектирование", "aktsii": "Акции",
        "foto-i-video": "Фото и видео", "o-kompanii": "О компании", "kontakty": "Контакты",
        "uslugi": "Услуги", "portfolio": "Портфолио", "otzyvy": "Отзывы", "ceny": "Цены",
        "stati": "Статьи / блог", "blog": "Статьи / блог",
    }.get(first, f"Прочее: /{first}/")


all_urls = stat(ALL_METRICS, ["ym:s:startURL"], limit=5000, sort="-ym:s:visits")
url_rows = rows(all_urls, ALL_NAMES)
print("посадочных в срезе:", len(url_rows))

sections: dict = defaultdict(lambda: {"visits": 0.0, "users": 0.0, "bounce_weighted": 0.0, "pageDepth_w": 0.0,
                                      "time_w": 0.0, **{g: 0.0 for g in G_NAMES}, "urls": 0})
for r in url_rows:
    key = section_of(r["dim"])
    s = sections[key]
    v = r["visits"] or 0
    s["visits"] += v
    s["users"] += r["users"] or 0
    s["bounce_weighted"] += (r["bounceRate"] or 0) * v
    s["pageDepth_w"] += (r["pageDepth"] or 0) * v
    s["time_w"] += (r["avgVisitDurationSeconds"] or 0) * v
    for g in G_NAMES:
        s[g] += r[g] or 0
    s["urls"] += 1

section_rows = []
for name, s in sections.items():
    v = s["visits"] or 1
    section_rows.append({"section": name, "urls": s["urls"], "visits": s["visits"],
                         "bounce": round(s["bounce_weighted"] / v, 1), "depth": round(s["pageDepth_w"] / v, 2),
                         "time": round(s["time_w"] / v, 0),
                         **{g: s[g] for g in G_NAMES},
                         "cr_order_pct": round(s["order"] / v * 100, 3), "cr_contact_pct": round((s["call"] + s["lid"]) / v * 100, 3)})
section_rows.sort(key=lambda x: -x["visits"])
print("\n=== разделы сайта (90 дней) ===")
print(f"{'раздел':34} {'визиты':>8} {'отказы':>7} {'глуб':>5} {'время':>6} {'звонки':>6} {'лид':>5} {'формы':>7} {'фильтр':>7} {'заказы':>6} {'оплаты':>6}")
for s in section_rows:
    print(f"{s['section'][:34]:34} {s['visits']:>8.0f} {s['bounce']:>7.1f} {s['depth']:>5.2f} {s['time']:>6.0f} "
          f"{s['call']:>6.0f} {s['lid']:>5.0f} {s['form_all']:>7.0f} {s['filter']:>7.0f} {s['order']:>6.0f} {s['paid']:>6.0f}")

# воронка
tot = rows(stat(ALL_METRICS, limit=1), ALL_NAMES)
totals = tot[0] if tot else {}
funnel = {
    "visits": totals.get("visits"), "users": totals.get("users"),
    "form_all": totals.get("form_all"), "filter": totals.get("filter"),
    "form_call": totals.get("form_call"), "form_build": totals.get("form_build"), "form_calc": totals.get("form_calc"),
    "calls": totals.get("call"), "lids": totals.get("lid"),
    "orders": totals.get("order"), "paid": totals.get("paid"), "spam": totals.get("spam"), "cancel": totals.get("cancel"),
}
print("\n=== воронка (90 дней) ===")
print(json.dumps(funnel, ensure_ascii=False))
funnel["forms_without_filter"] = (funnel["form_all"] or 0) - (funnel["filter"] or 0)

# устройства × формы
dev = rows(stat(METRICS + [f"ym:s:goal{GOALS['form_all']}reaches", f"ym:s:goal{GOALS['form_call']}reaches",
                        f"ym:s:goal{GOALS['order']}reaches", f"ym:s:goal{GOALS['call']}reaches",
                        f"ym:s:goal{GOALS['filter']}reaches"],
                ["ym:s:deviceCategory"], limit=10, sort="-ym:s:visits"),
           M_NAMES + ["form_all", "form_call", "order", "call", "filter"])
print("\n=== устройства × формы/заказы ===")
for d in dev:
    v = d["visits"] or 1
    print(f"  {d['dim']}: визиты {v:.0f}, отказы {d['bounceRate']:.1f}%, формы {d['form_all']:.0f} "
          f"(CR {d['form_all']/v*100:.2f}%), фильтр {d['filter']:.0f}, звонки {d['call']:.0f}, заказы {d['order']:.0f}")

# источники × контакты
src = rows(stat(METRICS + [f"ym:s:goal{GOALS['form_all']}reaches", f"ym:s:goal{GOALS['call']}reaches",
                          f"ym:s:goal{GOALS['lid']}reaches", f"ym:s:goal{GOALS['order']}reaches",
                          f"ym:s:goal{GOALS['paid']}reaches"],
                ["ym:s:lastsignTrafficSource"], limit=10, sort="-ym:s:visits"),
           M_NAMES + ["form_all", "call", "lid", "order", "paid"])
print("\n=== источники × контакты ===")
for s in src:
    v = s["visits"] or 1
    print(f"  {str(s['dim'])[:26]:26} визиты {v:>7.0f} формы {s['form_all']:>6.0f} звонки {s['call']:>4.0f} "
          f"лид {s['lid']:>3.0f} заказ {s['order']:>3.0f} оплата {s['paid']:>3.0f} CR(контакт) {(s['call']+s['lid'])/v*100:.3f}%")

out = {"period": [D1, D2], "sections": section_rows, "funnel": funnel, "device": dev, "source": src,
       "urls_total": len(url_rows)}
(HERE / "site-analytics.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: site-analytics.json")
