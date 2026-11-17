# -*- coding: utf-8 -*-
"""Страницы сайта по просмотрам (ym:pv) — топ по популярности."""
from __future__ import annotations

import json
import sys
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


def q(metrics, dims, limit=40, sort=None):
    p = {"ids": COUNTER, "date1": "2026-08-19", "date2": "2026-11-16", "accuracy": "full",
         "metrics": ",".join(metrics), "dimensions": ",".join(dims), "limit": str(limit),
         "sort": sort or "-" + metrics[0]}
    url = f"https://api-metrika.yandex.net/stat/v1/data?{urllib.parse.urlencode(p)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read().decode('utf-8','ignore')[:150]}"


out = {}
for metrics, dims in ((["ym:pv:pageviews", "ym:pv:users"], ["ym:pv:URLPath"]),
                      (["ym:s:pageviews", "ym:s:bounceRate", "ym:s:avgVisitDurationSeconds"], ["ym:s:startURLPath"])):
    payload, err = q(metrics, dims)
    if err:
        print(f"{dims}: {err}")
        continue
    key = dims[0]
    out[key] = payload
    print(f"=== {key} (топ-30 из {len(payload.get('data') or [])}) ===")
    for row in (payload.get("data") or [])[:30]:
        d = row["dimensions"][0]
        d = (d.get("url") or d.get("name") or d.get("id")) if isinstance(d, dict) else d
        print(f"  {str(d)[:62]:62} {row['metrics']}")

(HERE / "metrika-pages.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("сохранено: metrika-pages.json")
