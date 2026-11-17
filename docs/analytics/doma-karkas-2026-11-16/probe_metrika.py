# -*- coding: utf-8 -*-
"""Точечные пробы Метрики: измерения страниц, условия целей, доп. атрибуты."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.runtime.core import env_value, load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
COUNTER = "22595095"
load_env_file()
TOKEN = env_value("YANDEX_OAUTH_TOKEN")
HEADERS = {"Authorization": f"OAuth {TOKEN}", "Accept-Language": "ru"}

def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read().decode('utf-8','ignore')[:160]}"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"

def stat(metrics, dims, **kw):
    p = {"ids": COUNTER, "date1": "2026-08-19", "date2": "2026-11-16", "metrics": ",".join(metrics),
         "limit": str(kw.get("limit", 20)), "accuracy": "full", "sort": kw.get("sort", "-" + metrics[0])}
    if dims:
        p["dimensions"] = ",".join(dims)
    if kw.get("filters"):
        p["filters"] = kw["filters"]
    return get(f"https://api-metrika.yandex.net/stat/v1/data?{urllib.parse.urlencode(p)}")

print("=== проба измерений страниц ===")
for dim in ("ym:s:startURLPath", "ym:s:pagePath", "ym:pv:URLPath", "ym:s:endURL", "ym:s:startURL"):
    payload, err = stat(["ym:s:pageviews", "ym:s:bounceRate", "ym:s:avgVisitDurationSeconds"], [dim], limit=5)
    if err:
        print(f"  {dim}: {err[:110]}")
    else:
        rows = payload.get("data") or []
        print(f"  {dim}: OK, строк {len(rows)}; пример:",
              [(str((r['dimensions'][0].get('url') if isinstance(r['dimensions'][0], dict) else r['dimensions'][0]))[:40], r['metrics'][0]) for r in rows[:4]])
    time.sleep(0.3)

print("\n=== цели: условия (что реально считается) ===")
goals, err = get(f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}/goals")
if err:
    print("  ошибка:", err)
else:
    for g in goals.get("goals", []):
        cond = g.get("conditions") or []
        steps = g.get("steps") or []
        print(f"  {g.get('id')} | {str(g.get('name'))[:40]:40} | type={g.get('type')} | "
              f"cond={json.dumps(cond, ensure_ascii=False)[:150]} | steps={len(steps)}")

print("\n=== доп. проверки ===")
card, err = get(f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}")
if card:
    c = card["counter"]
    print("  clickmap:", c.get("clickmap"), "| webvisor:", bool(c.get("webvisor")),
          "| code_status:", c.get("code_status"))
    print("  code_options:", json.dumps(c.get("code_options"), ensure_ascii=False)[:400])
    print("  features:", json.dumps(c.get("features"), ensure_ascii=False)[:300])

# доля мобильных в рекламе + конверсии по времени суток
for dim, label in (("ym:s:hour", "час"), ("ym:s:dayOfWeek", "день недели")):
    payload, err = stat(["ym:s:visits", "ym:s:goal595094381reaches", "ym:s:goal41224933reaches"], [dim], limit=30, sort=dim)
    if err:
        print(f"  {dim}: {err[:100]}")
    else:
        rows = payload.get("data") or []
        top = sorted(rows, key=lambda r: -(r["metrics"][1] or 0))[:5]
        print(f"  по {label}: строк {len(rows)}; лучшие по заказам:",
              [(r["dimensions"][0], r["metrics"][1]) for r in top])
    time.sleep(0.3)

# воронка форм: конверсии ключевых форм
FORMS = {"297819512": "Отправка всех форм", "309041485": "Заказать звонок", "309041783": "Заказать строительство",
         "585877682": "Фильтр: подобрать проекты", "237818602": "На сайте >5 минут", "579404": "?"}
metrics = ["ym:s:visits"] + [f"ym:s:goal{g}reaches" for g in FORMS]
payload, err = stat(metrics, [], limit=1)
if not err:
    flat = (payload.get("totals") or [[]])[0]
    print("\n=== воронка (всего за 90 дней) ===")
    print("  визиты:", flat[0])
    for i, (gid, name) in enumerate(FORMS.items(), start=1):
        val = flat[i] if i < len(flat) else None
        print(f"  {name}: {val}")

# сколько форм на мобильных vs ПК
payload, err = stat(["ym:s:visits", "ym:s:goal297819512reaches", "ym:s:goal595094381reaches", "ym:s:goal41224933reaches"],
                    ["ym:s:deviceCategory"], limit=5)
if not err:
    print("\n=== формы/заказы по устройствам ===")
    for r in payload.get("data") or []:
        d = r["dimensions"][0]
        print("  ", d.get("name"), r["metrics"])

# реклама: доля визитов без конверсий посадочных статей
payload, err = stat(["ym:s:visits", "ym:s:goal595094381reaches"], ["ym:s:startURL"], limit=200, sort="-ym:s:visits")
if not err:
    rows = payload.get("data") or []
    total_v = sum(r["metrics"][0] or 0 for r in rows)
    art_v = sum((r["metrics"][0] or 0) for r in rows
                if "/articles/" in str(r["dimensions"][0].get("url", "") if isinstance(r["dimensions"][0], dict) else r["dimensions"][0]))
    art_o = sum((r["metrics"][1] or 0) for r in rows
                if "/articles/" in str(r["dimensions"][0].get("url", "") if isinstance(r["dimensions"][0], dict) else r["dimensions"][0]))
    print(f"\n=== статьи: визитов {art_v:.0f} из {total_v:.0f} ({art_v/total_v*100:.1f}%), заказов {art_o:.0f}")
    nonpay = [(r["dimensions"][0].get("url") if isinstance(r["dimensions"][0], dict) else r["dimensions"][0],
               r["metrics"][0]) for r in rows if (r["metrics"][0] or 0) > 200 and not (r["metrics"][1] or 0)]
    print(f"  посадочных с трафиком >200 визитов и 0 заказов: {len(nonpay)}")
    for u, v in nonpay[:12]:
        print(f"    {str(u)[:70]:70} {v:.0f}")
