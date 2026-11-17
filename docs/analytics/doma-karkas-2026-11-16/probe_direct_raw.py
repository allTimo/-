# -*- coding: utf-8 -*-
"""Пробы Директа: стратегии кампаний, корректировки, аудитории (только чтение)."""
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
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:600]}


print("=== textcampaign: сырой ответ (первые 800 символов) ===")
res = call("textcampaign", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "Name", "BiddingStrategy", "CounterIds"],
    "Page": {"Limit": 20}}})
print(json.dumps(res, ensure_ascii=False)[:800])

print("\n=== textcampaign: только Id, Name, BiddingStrategy ===")
res2 = call("textcampaign", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "BiddingStrategy"], "Page": {"Limit": 20}}})
print(json.dumps(res2, ensure_ascii=False)[:1200])

print("\n=== bidmodifiers: SelectionCriteria.Levels ===")
res3 = call("bidmodifiers", {"method": "get", "params": {
    "SelectionCriteria": {"Levels": ["CAMPAIGN", "AD_GROUP"]},
    "FieldNames": ["Id", "CampaignId", "AdGroupId", "Level", "Type", "BidModifier"],
    "Page": {"Limit": 200}}})
print(json.dumps(res3, ensure_ascii=False)[:900])

print("\n=== audiencetargets: SelectionCriteria.CampaignIds ===")
res4 = call("audiencetargets", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": [713311426, 713935594]},
    "FieldNames": ["Id", "CampaignId", "AdGroupId", "RetargetingListId", "State", "Status"],
    "Page": {"Limit": 200}}})
print(json.dumps(res4, ensure_ascii=False)[:600])

print("\n=== retargetinglists ===")
res5 = call("retargetinglists", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "Name", "Type", "Rules", "Scope"],
    "Page": {"Limit": 200}}})
print(json.dumps(res5, ensure_ascii=False)[:800])

(HERE / "direct-probe-raw.json").write_text(
    json.dumps({"textcampaign": res, "textcampaign2": res2, "bidmodifiers": res3,
                "audiencetargets": res4, "retargetinglists": res5}, ensure_ascii=False, indent=1),
    encoding="utf-8")
