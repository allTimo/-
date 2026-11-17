# -*- coding: utf-8 -*-
"""Углублённый разбор: связка кампаний по ID, фразы, незакрытый спрос, каннибализация, объявления."""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import env_value, load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
COUNTER = "22595095"
load_env_file()
HEADERS = {"Authorization": f"OAuth {env_value('YANDEX_OAUTH_TOKEN')}", "Accept-Language": "ru"}

out: dict = {}

# --- 1. Метрика: кампании Директа по ID ---------------------------------------
def metrika(metrics, dims, limit=200, sort=None):
    p = {"ids": COUNTER, "date1": "2026-08-19", "date2": "2026-11-16", "accuracy": "full",
         "metrics": ",".join(metrics), "dimensions": ",".join(dims), "limit": str(limit),
         "sort": sort or "-" + metrics[0]}
    req = urllib.request.Request(f"https://api-metrika.yandex.net/stat/v1/data?{urllib.parse.urlencode(p)}", headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read().decode('utf-8','ignore')[:150]}"


M = ["ym:s:visits", "ym:s:users", "ym:s:bounceRate"]
M += [f"ym:s:goal{g}reaches" for g in (41224933, 309041787, 297819512, 585877682, 595094381, 595094382, 595094383, 595094384)]
NAMES = ["visits", "users", "bounceRate", "call", "lid", "form_all", "filter", "order", "paid", "spam", "cancel"]

for dim in ("ym:s:lastDirectClickOrder", "ym:s:lastsignDirectClickOrder"):
    payload, err = metrika(M, [dim], limit=100)
    if err:
        print(f"{dim}: {err}")
        continue
    rows = []
    for row in payload.get("data") or []:
        d = row["dimensions"][0]
        cid = d.get("id") if isinstance(d, dict) else d
        item = {"campaign_id": str(cid)}
        for i, n in enumerate(NAMES):
            item[n] = row["metrics"][i]
        rows.append(item)
    out["by_campaign_id"] = rows
    print(f"=== кампании по ID ({dim}): {len(rows)} ===")
    for r in rows:
        print("  ", r["campaign_id"], f"визиты {r['visits']:.0f} отказы {r['bounceRate']:.1f} "
              f"лид {r['lid']:.0f} звонки {r['call']:.0f} формы {r['form_all']:.0f} фильтр {r['filter']:.0f} "
              f"заказ {r['order']:.0f} оплата {r['paid']:.0f} спам {r['spam']:.0f}")
    break
    time.sleep(0.3)

# --- 2. Метрика: динамика по неделям (сезонность) ------------------------------
payload, err = metrika(["ym:s:visits"] + [f"ym:s:goal{g}reaches" for g in (297819512, 595094381, 595094382, 41224933)],
                       ["ym:s:week"], limit=20, sort="ym:s:week")
if not err:
    out["weekly"] = [{"week": (r["dimensions"][0].get("name") if isinstance(r["dimensions"][0], dict) else r["dimensions"][0]),
                      **{n: r["metrics"][i] for i, n in enumerate(["visits", "form_all", "order", "paid", "call"])}}
                     for r in payload.get("data") or []]
    print("\n=== по неделям ===")
    for w in out["weekly"]:
        print("  ", w["week"], f"визиты {w['visits']:.0f} формы {w['form_all']:.0f} заказы {w['order']:.0f} оплаты {w['paid']:.0f} звонки {w['call']:.0f}")

# --- 3. Директ: тексты объявлений ----------------------------------------------
def call(service, body):
    req = urllib.request.Request(f"https://api.direct.yandex.com/json/v5/{service}",
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    for k, v in HEADERS.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:200]}


ads_meta = (json.loads((HERE / "direct-settings.json").read_text(encoding="utf-8")).get("ads") or [])
print("\n=== объявления: типы ===")
print(Counter(f"{a.get('Type')}/{a.get('Subtype')}" for a in ads_meta))
sample = [a["Id"] for a in ads_meta if a.get("Type") == "TEXT_AD"][:12] or [a["Id"] for a in ads_meta[:12]]
res = call("ads", {"method": "get", "params": {
    "SelectionCriteria": {"Ids": sample}, "FieldNames": ["Id", "TextAd"], "Page": {"Limit": 50}}})
texts = []
for row in (res.get("result", {}) or {}).get("Ads", []) if isinstance(res, dict) else []:
    ta = row.get("TextAd") or {}
    texts.append({"id": row.get("Id"), "title": ta.get("Title"), "title2": ta.get("Title2"), "text": ta.get("Text"),
                  "href": ta.get("Href"), "display": ta.get("DisplayUrlPath"), "sitelinks": len(ta.get("Sitelinks") or []),
                  "vcard": ta.get("VCardId"), "mobile": ta.get("Mobile"), "ad_extension_ids": ta.get("AdExtensionIds")})
out["ads_texts"] = texts
print(f"получено текстов объявлений: {len(texts)} (запрошено {len(sample)})")
for t in texts[:6]:
    print("  ", t["id"], "|", str(t["title"])[:60], "|", str(t["text"])[:70], "| ссылок:", t["sitelinks"])
if not texts:
    print("  ответ API:", json.dumps(res, ensure_ascii=False)[:400])

(HERE / "deep-review.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: deep-review.json")
