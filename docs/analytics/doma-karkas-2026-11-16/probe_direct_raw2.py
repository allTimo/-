# -*- coding: utf-8 -*-
"""Проба 2: правильные имена сервисов стратегий и корректировок (только чтение)."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
load_env_file()
HEADERS = direct.build_headers()


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


out = {}

for svc in ("textcampaigns", "campaigns"):
    fields = ["Id", "Name", "BiddingStrategy", "CounterIds", "AttributionModel"] if svc == "textcampaigns" else \
             ["Id", "Name", "Type", "State"]
    res = call(svc, {"method": "get", "params": {"SelectionCriteria": {}, "FieldNames": fields, "Page": {"Limit": 50}}})
    out[svc] = res
    print(f"=== {svc} ===")
    print(json.dumps(res, ensure_ascii=False)[:900])
    print()

# кампании: пробуем поле Strategy в сервисе campaigns
res_strategy = call("campaigns", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "Name", "Strategy", "CounterIds", "AttributionModel"],
    "Page": {"Limit": 50}}})
out["campaigns_strategy"] = res_strategy
print("=== campaigns + Strategy ===")
print(json.dumps(res_strategy, ensure_ascii=False)[:1200])

# корректировки с допустимыми полями
res_mods = call("bidmodifiers", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "CampaignId", "AdGroupId", "Level", "Type"],
    "Page": {"Limit": 5000}}})
out["bidmodifiers"] = res_mods
print("\n=== bidmodifiers (Level/Type) ===")
print(json.dumps(res_mods, ensure_ascii=False)[:1200])

# аудитории с допустимыми полями
res_aud = call("audiencetargets", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": [713311426, 713935594, 714038332]},
    "FieldNames": ["Id", "AdGroupId", "CampaignId", "RetargetingListId", "State", "ContextBid", "StrategyPriority"],
    "Page": {"Limit": 500}}})
out["audiencetargets"] = res_aud
print("\n=== audiencetargets ===")
print(json.dumps(res_aud, ensure_ascii=False)[:800])

# ставки (bids)
res_bids = call("bids", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": [713935594]},
    "FieldNames": ["KeywordId", "AdGroupId", "CampaignId", "Bid", "StrategyPriority"],
    "Page": {"Limit": 50}}})
out["bids"] = res_bids
print("\n=== bids (пример кампании) ===")
print(json.dumps(res_bids, ensure_ascii=False)[:600])

(HERE / "direct-probe-raw2.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
