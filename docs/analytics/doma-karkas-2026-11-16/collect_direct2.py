# -*- coding: utf-8 -*-
"""Добор Директа 2: тип рекламной сети, корректировки, ставки, последние дни (только чтение)."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
FROM, TO = "2026-08-19", "2026-11-16"
load_env_file()
HEADERS = direct.build_headers()
CAMP_IDS = [713311426, 713935594, 714038332, 714762514, 715702484, 715810384, 713617279]


def call(service: str, body: dict) -> dict:
    req = urllib.request.Request(f"https://api.direct.yandex.com/json/v5/{service}",
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    for k, v in HEADERS.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:300]}


def wait_report(report_type, fields, name, date_from=FROM, date_to=TO, tries=15, pause=20.0):
    last = None
    for i in range(1, tries + 1):
        result = direct.get_report(date_from, date_to, report_type=report_type, fields=fields, name=name)
        if result.get("status") == "ok":
            return result
        last = result
        msg = str(result.get("message") or "")
        print(f"  {name}: попытка {i} — {msg[:90]}", flush=True)
        if result.get("status") == "error" and "очеред" not in msg.lower():
            return result
        time.sleep(pause if "очеред" not in msg.lower() else 60.0)
    return last or {"status": "error"}


out: dict = {}

# 1. сеть: поиск vs РСЯ
rep = wait_report("CUSTOM_REPORT",
                  ["AdNetworkType", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions", "Ctr"],
                  "audit2-network-90d")
if rep.get("status") == "ok":
    (HERE / "direct-report-network.tsv").write_text(rep["tsv"], encoding="utf-8")
    print("network отчёт ок")
else:
    print("network нет:", str(rep.get("message"))[:150])
out["network"] = rep.get("status")

# 2. критерии по типу (автотаргетинг vs ключи) — отчёт по критериям с типом уже есть
# 3. корректировки с CampaignIds
res = call("bidmodifiers", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": CAMP_IDS, "Levels": ["CAMPAIGN", "AD_GROUP"]},
    "FieldNames": ["Id", "CampaignId", "AdGroupId", "Level", "Type"],
    "Page": {"Limit": 5000}}})
out["bidmodifiers"] = res.get("result", {}).get("BidModifiers", []) if isinstance(res, dict) and not res.get("error") else []
print("bidmodifiers:", len(out["bidmodifiers"]), str(res.get("error") or "")[:160])
for m in out["bidmodifiers"][:15]:
    print("   ", json.dumps(m, ensure_ascii=False)[:180])

# 4. ставки по кампаниям (ручные ставки видны по наличию Bid)
bids_by_camp: dict = {}
for cid in CAMP_IDS:
    res = call("bids", {"method": "get", "params": {
        "SelectionCriteria": {"CampaignIds": [cid]},
        "FieldNames": ["KeywordId", "AdGroupId", "CampaignId", "Bid", "StrategyPriority"],
        "Page": {"Limit": 20}}})
    got = res.get("result", {}).get("Bids", []) if isinstance(res, dict) and not res.get("error") else []
    bids_by_camp[str(cid)] = {"count_sample": len(got), "bids": got[:10]}
    print(f"bids camp {cid}: {len(got)} (пример: {json.dumps(got[:2], ensure_ascii=False)[:160]})")
out["bids"] = bids_by_camp

# 5. последние 14 дней по кампаниям (что реально крутится)
rep = wait_report("CAMPAIGN_PERFORMANCE_REPORT",
                  ["Date", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions"],
                  "audit2-last14-90d", date_from="2026-11-03", date_to="2026-11-16")
if rep.get("status") == "ok":
    (HERE / "direct-report-last14.tsv").write_text(rep["tsv"], encoding="utf-8")
    print("last14 отчёт ок")
else:
    print("last14 нет:", str(rep.get("message"))[:150])
out["last14"] = rep.get("status")

# 6. аудитории по всем кампаниям с правильным критерием
res = call("audiencetargets", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": CAMP_IDS},
    "FieldNames": ["Id", "AdGroupId", "CampaignId", "RetargetingListId", "State"],
    "Page": {"Limit": 1000}}})
out["audience_targets"] = res.get("result", {}).get("AudienceTargets", []) if isinstance(res, dict) and not res.get("error") else []
print("audience_targets:", len(out["audience_targets"]))

# 7. ретаргетинговые списки
res = call("retargetinglists", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "Name", "Type", "Rules", "Scope"], "Page": {"Limit": 200}}})
out["retargetinglists"] = res.get("result", {}).get("RetargetingLists", []) if isinstance(res, dict) and not res.get("error") else []
print("retargetinglists:", [(r.get("Id"), r.get("Name"), r.get("Type")) for r in out["retargetinglists"]])

# 8. объявления: тексты (для проверки релевантности)
res = call("ads", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": CAMP_IDS},
    "FieldNames": ["Id", "CampaignId", "AdGroupId", "State", "Status", "Type", "Subtype"],
    "Page": {"Limit": 500}}})
ads_meta = res.get("result", {}).get("Ads", []) if isinstance(res, dict) and not res.get("error") else []
out["ads_meta"] = ads_meta
print("объявлений (мета):", len(ads_meta))
sample_texts = []
for a in ads_meta[:8]:
    r2 = call("ads", {"method": "get", "params": {
        "SelectionCriteria": {"Ids": [a["Id"]]},
        "FieldNames": ["Id", "TextAd"], "Page": {"Limit": 1}}})
    rows = r2.get("result", {}).get("Ads", []) if isinstance(r2, dict) and not r2.get("error") else []
    for row in rows:
        ta = row.get("TextAd") or {}
        sample_texts.append({"id": row.get("Id"), "title": ta.get("Title"), "title2": ta.get("Title2"),
                             "text": ta.get("Text"), "href": ta.get("Href"), "sitelinks": len(ta.get("Sitelinks") or []),
                             "display_url_path": ta.get("DisplayUrlPath"), "mobile": ta.get("Mobile"),
                             "vatemplate": ta.get("VCardId")})
out["sample_ads"] = sample_texts
print("примеры объявлений:", json.dumps(sample_texts[:4], ensure_ascii=False)[:600])

(HERE / "direct-extra2.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("сохранено: direct-extra2.json")
