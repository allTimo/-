# -*- coding: utf-8 -*-
"""Догон: тексты объявлений, недельная динамика, сверка ID кампаний Директ ↔ Метрика."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import env_value, load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
COUNTER = "22595095"
load_env_file()
METRIKA_HEADERS = {"Authorization": f"OAuth {env_value('YANDEX_OAUTH_TOKEN')}", "Accept-Language": "ru"}
DIRECT_HEADERS = direct.build_headers()
out: dict = {}


def metrika(metrics, dims, limit=100, sort=None):
    p = {"ids": COUNTER, "date1": "2026-08-19", "date2": "2026-11-16", "accuracy": "full",
         "metrics": ",".join(metrics), "dimensions": ",".join(dims), "limit": str(limit),
         "sort": sort or "-" + metrics[0]}
    req = urllib.request.Request(f"https://api-metrika.yandex.net/stat/v1/data?{urllib.parse.urlencode(p)}",
                                 headers=METRIKA_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read().decode('utf-8','ignore')[:160]}"


def dcall(service, body):
    req = urllib.request.Request(f"https://api.direct.yandex.com/json/v5/{service}",
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    for k, v in DIRECT_HEADERS.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:300]}


# 1. тексты объявлений
settings = json.loads((HERE / "direct-settings.json").read_text(encoding="utf-8"))
ads_meta = settings.get("ads") or []
text_ids = [a["Id"] for a in ads_meta if a.get("Type") == "TEXT_AD"][:20]
texts = []
for chunk_start in range(0, len(text_ids), 10):
    chunk = text_ids[chunk_start:chunk_start + 10]
    res = dcall("ads", {"method": "get", "params": {
        "SelectionCriteria": {"Ids": chunk}, "FieldNames": ["Id", "TextAd"], "Page": {"Limit": 50}}})
    for row in (res.get("result", {}) or {}).get("Ads", []):
        ta = row.get("TextAd") or {}
        texts.append({"id": row.get("Id"), "title": ta.get("Title"), "title2": ta.get("Title2"),
                      "text": ta.get("Text"), "href": ta.get("Href"), "display": ta.get("DisplayUrlPath"),
                      "sitelinks": len(ta.get("Sitelinks") or []), "vcard": ta.get("VCardId"),
                      "mobile": ta.get("Mobile"), "extensions": len(ta.get("AdExtensionIds") or [])})
    if isinstance(res, dict) and res.get("error"):
        print("ads error:", str(res["error"].get("error_detail"))[:160])
out["ads_texts"] = texts
print(f"текстов объявлений: {len(texts)} из {len(text_ids)}")
for t in texts[:8]:
    print(f"  {t['id']} | {str(t['title'])[:52]} | {str(t['text'])[:60]} | быстрых ссылок: {t['sitelinks']} | "
          f"визитка: {'да' if t['vcard'] else 'нет'} | уточнений: {t['extensions']}")

# 2. недельная динамика
payload, err = metrika(["ym:s:visits", "ym:s:goal297819512reaches", "ym:s:goal595094381reaches",
                        "ym:s:goal595094382reaches", "ym:s:goal41224933reaches"],
                       ["ym:s:week"], limit=20, sort="ym:s:week")
if err:
    print("недели ошибка:", err)
    payload, err = metrika(["ym:s:visits", "ym:s:goal297819512reaches", "ym:s:goal595094381reaches",
                            "ym:s:goal595094382reaches", "ym:s:goal41224933reaches"],
                           ["ym:s:date"], limit=120, sort="ym:s:date")
    if not err:
        rows = [{"date": (r["dimensions"][0].get("name") if isinstance(r["dimensions"][0], dict) else r["dimensions"][0]),
                 "visits": r["metrics"][0], "form_all": r["metrics"][1], "order": r["metrics"][2],
                 "paid": r["metrics"][3], "call": r["metrics"][4]} for r in payload.get("data") or []]
        df = pd.DataFrame(rows)
        df["week"] = pd.to_datetime(df["date"]).dt.to_period("W").astype(str)
        agg = df.groupby("week")[["visits", "form_all", "order", "paid", "call"]].sum().reset_index()
        out["weekly"] = agg.to_dict("records")
else:
    out["weekly"] = [{"week": (r["dimensions"][0].get("name") if isinstance(r["dimensions"][0], dict) else r["dimensions"][0]),
                      "visits": r["metrics"][0], "form_all": r["metrics"][1], "order": r["metrics"][2],
                      "paid": r["metrics"][3], "call": r["metrics"][4]} for r in payload.get("data") or []]
print("\n=== динамика по неделям ===")
for w in out.get("weekly", []):
    print(f"  {w['week']}: визиты {w['visits']:.0f}, формы {w['form_all']:.0f}, заказы {w['order']:.0f}, "
          f"оплаты {w['paid']:.0f}, звонки {w['call']:.0f}")

# 3. сверка ID кампаний
rep = pd.read_csv(HERE / "direct-report-campaigns.tsv", sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
rep.columns = [c.strip().strip('"') for c in rep.columns]
direct_ids = set(rep["CampaignId"].dropna().astype(str)) - {"nan"}
metrika_ids = {r["campaign_id"] for r in json.loads((HERE / "deep-review.json").read_text(encoding="utf-8"))["by_campaign_id"]}
out["id_diff"] = {"only_metrika": sorted(metrika_ids - direct_ids), "only_direct": sorted(direct_ids - metrika_ids)}
print("\nID только в Метрике (нет в отчёте Директа):", out["id_diff"]["only_metrika"])
print("ID только в Директе:", out["id_diff"]["only_direct"])

# расход по «потерянным» ID, если есть в дневном отчёте
daily = pd.read_csv(HERE / "direct-report-campaigns_daily.tsv", sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
daily.columns = [c.strip().strip('"') for c in daily.columns]
daily["Cost"] = pd.to_numeric(daily["Cost"], errors="coerce").fillna(0) / 1e6
lost = daily[daily["CampaignId"].astype(str).isin(out["id_diff"]["only_metrika"])]
out["lost_spend"] = float(lost["Cost"].sum())
out["lost_rows"] = lost.groupby("CampaignId")[["Cost", "Clicks"]].sum().reset_index().to_dict("records")
print(f"расход по ID, отсутствующим в текущем списке кампаний: {out['lost_spend']:,.0f} ₽")
for r in out["lost_rows"]:
    print("  ", r["CampaignId"], f"{r['Cost']:,.0f} ₽, клики {r['Clicks']:.0f}")

(HERE / "deep-review2.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: deep-review2.json")
