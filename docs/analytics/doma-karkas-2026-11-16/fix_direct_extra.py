# -*- coding: utf-8 -*-
"""Добор Директа: корректировки, аудитории, отчёт по группам, стратегии (только чтение)."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
import sys

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
FROM, TO = "2026-08-19", "2026-11-16"
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


extra: dict = {}

# 1. корректировки ставок
for fields in (["Id", "CampaignId", "AdGroupId", "Level", "Type", "BidModifier"],
               ["Id", "CampaignId", "AdGroupId", "Levels"]):
    res = call("bidmodifiers", {"method": "get", "params": {
        "SelectionCriteria": {}, "FieldNames": fields, "Page": {"Limit": 5000}}})
    if isinstance(res, dict) and not res.get("error") and not res.get("http_error"):
        extra["bidmodifiers"] = res.get("result", {}).get("BidModifiers", [])
        print("bidmodifiers ок, полей:", fields, "->", len(extra["bidmodifiers"]))
        break
    print("bidmodifiers ошибка:", str(res.get("error") or res.get("body") or res)[:200])

# 2. аудитории/ретаргетинг
res = call("audiencetargets", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "AdGroupId", "CampaignId", "RetargetingListId"],
    "Page": {"Limit": 5000}}})
extra["audience_targets"] = res.get("result", {}).get("AudienceTargets", []) if isinstance(res, dict) and not res.get("error") else []
print("audience_targets:", len(extra["audience_targets"]), str(res.get("error") or "")[:150])

# 3. стратегии textcampaign (полные)
res = call("textcampaign", {"method": "get", "params": {
    "SelectionCriteria": {}, "FieldNames": ["Id", "Name", "BiddingStrategy", "CounterIds",
                                            "AttributionModel", "Settings", "Statistics"],
    "Page": {"Limit": 200}}})
if isinstance(res, dict) and not res.get("error") and not res.get("http_error"):
    extra["textcampaign"] = res.get("result", {}).get("TextCampaigns", [])
    print("textcampaign ок:", len(extra["textcampaign"]))
    for c in extra["textcampaign"]:
        print("  ", c.get("Id"), "|", str(c.get("Name"))[:38], "|",
              json.dumps(c.get("BiddingStrategy"), ensure_ascii=False)[:300],
              "| counters:", json.dumps(c.get("CounterIds"), ensure_ascii=False)[:60],
              "| attribution:", c.get("AttributionModel"))
else:
    extra["textcampaign"] = []
    print("textcampaign ошибка:", str(res.get("error") or res.get("body"))[:250])

# 4. отчёт по группам объявлений
def wait_report(report_type, fields, name, tries=15, pause=20.0):
    last = None
    for i in range(1, tries + 1):
        result = direct.get_report(FROM, TO, report_type=report_type, fields=fields, name=name)
        if result.get("status") == "ok":
            return result
        last = result
        msg = str(result.get("message") or "")
        print(f"  {name}: попытка {i} — {msg[:90]}", flush=True)
        if result.get("status") == "error" and "очеред" not in msg.lower():
            return result
        time.sleep(pause if "очеред" not in msg.lower() else 60.0)
    return last or {"status": "error"}


rep = wait_report("ADGROUP_PERFORMANCE_REPORT",
                  ["AdGroupId", "AdGroupName", "CampaignId", "CampaignName", "Impressions", "Clicks",
                   "Cost", "Conversions", "Ctr"], "audit2-adgroups-v2-90d")
if rep.get("status") == "ok":
    lines = [l for l in (rep.get("tsv") or "").splitlines() if l.strip()]
    (HERE / "direct-report-adgroups.tsv").write_text(rep["tsv"], encoding="utf-8")
    print("adgroups отчёт ок, строк:", max(len(lines) - 1, 0))
    extra["adgroups_report"] = {"rows": max(len(lines) - 1, 0)}
else:
    print("adgroups отчёт не собрался:", str(rep.get("message"))[:200])
    extra["adgroups_report"] = {"error": str(rep.get("message"))[:200]}

(HERE / "direct-extra.json").write_text(json.dumps(extra, ensure_ascii=False, indent=1), encoding="utf-8")
print("сохранено: direct-extra.json")
