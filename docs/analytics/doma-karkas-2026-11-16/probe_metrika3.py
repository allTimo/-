# -*- coding: utf-8 -*-
"""Проба 3 Метрики: шаги цели «Лид», страницы по просмотрам, техметрики."""
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
HEADERS = {"Authorization": f"OAuth {env_value('YANDEX_OAUTH_TOKEN')}", "Accept-Language": "ru"}
out = {}


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read().decode('utf-8','ignore')[:180]}"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


# цель «Лид»: шаги
goals, err = get(f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}/goals")
if goals:
    for g in goals["goals"]:
        if g.get("id") in (309041787, 297819512):
            out[f"goal_{g['id']}"] = g
            print(f"=== цель {g.get('id')} {g.get('name')} ===")
            print(json.dumps(g, ensure_ascii=False)[:1200])

# страницы по просмотрам (ym:pv)
for metrics, dims in ((["ym:pv:pageviews", "ym:pv:users", "ym:pv:pageviewsPerUser"], ["ym:pv:URLPath"]),
                      (["ym:s:pageviews", "ym:s:exitRate", "ym:s:bounceRate"], ["ym:s:startURLPath"])):
    p = {"ids": COUNTER, "date1": "2026-08-19", "date2": "2026-11-16", "accuracy": "full",
         "metrics": ",".join(metrics), "dimensions": ",".join(dims), "limit": "30", "sort": "-" + metrics[0]}
    payload, err = get(f"https://api-metrika.yandex.net/stat/v1/data?{urllib.parse.urlencode(p)}")
    if err:
        print(f"\n{metrics} x {dims}: {err}")
    else:
        out["pages"] = payload
        print(f"\n=== страницы по просмотрам ({metrics[0]}) ===")
        for row in (payload.get("data") or [])[:25]:
            dim = row["dimensions"][0]
            dim = dim.get("url") or dim.get("name") or dim if isinstance(dim, dict) else dim
            print(f"  {str(dim)[:58]:58} {row['metrics']}")
    time.sleep(0.3)

# техметрики (проверяем, что доступно)
for metric in ("ym:s:pageLoadTime", "ym:pv:pageLoadTime", "ym:s:robotPercentage", "ym:s:visitDuration",
               "ym:s:exitRate", "ym:s:pageviewsPerVisit"):
    payload, err = get(f"https://api-metrika.yandex.net/stat/v1/data?ids={COUNTER}&date1=2026-08-19&date2=2026-11-16"
                       f"&metrics={metric}&limit=1")
    print(f"  метрика {metric}: {'OK ' + str(payload.get('totals')) if not err else err[:90]}")
    time.sleep(0.25)

(HERE / "metrika-probe3.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("сохранено: metrika-probe3.json")
