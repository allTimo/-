# -*- coding: utf-8 -*-
"""Сбор данных кабинета Директа intel-denisov (только чтение).

Reports API (асинхронный) + Campaigns/TextCampaign/AdGroups/Ads/Keywords/BidModifiers/AudienceTargets.
Результат: direct-*.json / direct-report-*.tsv рядом со скриптом.
"""
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


def call(service: str, body: dict, timeout: float = 60.0) -> dict:
    request = urllib.request.Request(
        f"https://api.direct.yandex.com/json/v5/{service}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in HEADERS.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:400]}
    except Exception as exc:  # noqa: BLE001
        return {"transport_error": f"{type(exc).__name__}: {exc}"}


out: dict = {"period": [FROM, TO]}

# --- кампании -----------------------------------------------------------------
campaigns = call("campaigns", {"method": "get", "params": {
    "SelectionCriteria": {},
    "FieldNames": ["Id", "Name", "State", "Status", "StatusPayment", "StatusClarification",
                   "Type", "DailyBudget", "Currency", "StartDate", "EndDate", "TimeZone",
                   "TimeTargeting", "NegativeKeywords", "ExcludedSites", "BlockedIps",
                   "CreateTime", "Funds", "Statistics"],
    "Page": {"Limit": 200}}})
rows = (campaigns.get("result", {}) or {}).get("Campaigns", []) if isinstance(campaigns, dict) else []
out["campaigns"] = rows
print("кампаний:", len(rows))
for c in rows:
    neg = ((c.get("NegativeKeywords") or {}) or {}).get("Items") or []
    print(f"  {c.get('Id')} | {str(c.get('Name'))[:52]:52} | {c.get('Type')} | {c.get('State')}/{c.get('Status')}"
          f" | бюджет: {c.get('DailyBudget')} | минус-слов: {len(neg)} | исключено площадок: "
          f"{len(((c.get('ExcludedSites') or {}) or {}).get('Items') or [])} | старт: {c.get('StartDate')}"
          f" | статистика: {json.dumps(c.get('Statistics'), ensure_ascii=False)[:90]}")

CAMP_IDS = [c.get("Id") for c in rows if c.get("Id")]

# --- стратегии по типам кампаний ----------------------------------------------
STRATEGY_SERVICES = {
    "textcampaign": "TextCampaign", "dynamictextcampaign": "DynamicTextCampaign",
    "mobileappcampaign": "MobileAppCampaign", "cpmbanner": "CpmBanner",
    "smartcampaign": "SmartCampaign", "unifiedcampaign": "UnifiedCampaign",
    "cpmdeck": "CpmDeck",
}
types = sorted({str(c.get("Type")) for c in rows if c.get("Type")})
print("типы кампаний:", types)
strategies: dict = {}
for svc in types:
    key = STRATEGY_SERVICES.get(svc)
    if not key:
        continue
    fields = ["Id", "Name", "BiddingStrategy", "CounterIds", "AttributionModel", "Settings",
              "ReportType", "SearchStrategy", "NetworkStrategy"]
    result = call(svc, {"method": "get", "params": {
        "SelectionCriteria": {}, "FieldNames": fields, "Page": {"Limit": 200}}})
    if isinstance(result, dict) and result.get("error"):
        # урежем набор полей
        result = call(svc, {"method": "get", "params": {
            "SelectionCriteria": {}, "FieldNames": ["Id", "Name", "BiddingStrategy", "CounterIds"],
            "Page": {"Limit": 200}}})
    strategies[svc] = result
    got = (result.get("result", {}) or {}).get(key, []) if isinstance(result, dict) else []
    print(f"  стратегии {svc}: {len(got)}")
    for item in got[:15]:
        print(f"    {item.get('Id')} | {json.dumps(item.get('BiddingStrategy'), ensure_ascii=False)[:260]}"
              f" | counters={json.dumps(item.get('CounterIds'), ensure_ascii=False)[:80]}")
out["strategies"] = strategies

# --- группы, объявления, ключи, корректировки, аудитории -----------------------
def batched(ids, size=10):
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def collect_many(service: str, key: str, fields: list[str], limit: int = 10000,
                 criteria_field: str = "CampaignIds") -> list[dict]:
    collected: list[dict] = []
    for chunk in batched(CAMP_IDS):
        result = call(service, {"method": "get", "params": {
            "SelectionCriteria": {criteria_field: chunk},
            "FieldNames": fields, "Page": {"Limit": limit}}})
        if isinstance(result, dict) and result.get("error"):
            print(f"  {service}: {str(result['error'].get('error_detail'))[:140]}")
            break
        collected.extend((result.get("result", {}) or {}).get(key, []) if isinstance(result, dict) else [])
    return collected


adgroups = collect_many("adgroups", "AdGroups", ["Id", "Name", "CampaignId", "Status", "Type", "RegionIds", "NegativeKeywords"])
ads = collect_many("ads", "Ads", ["Id", "CampaignId", "AdGroupId", "State", "Status", "Type", "Subtype"])
keywords = collect_many("keywords", "Keywords", ["Id", "Keyword", "CampaignId", "AdGroupId", "State", "Status", "Bid", "ServingStatus"])
modifiers = collect_many("bidmodifiers", "BidModifiers", ["Id", "CampaignId", "AdGroupId", "Levels"])
audience = collect_many("audiencetargets", "AudienceTargets",
                        ["Id", "CampaignId", "AdGroupId", "State", "Status", "RetargetingListId", "InterestId", "ContextBid", "StrategyPriority"])
out.update({"adgroups": adgroups, "ads": ads, "keywords": keywords,
            "bidmodifiers": modifiers, "audience_targets": audience})
print("групп:", len(adgroups), "| объявлений:", len(ads), "| ключей:", len(keywords),
      "| корректировок:", len(modifiers), "| аудиторий/ретаргетинга:", len(audience))

# корректировки по уровням
kinds: dict = {}
for m in modifiers:
    for level in (m.get("Levels") or []):
        kinds[str(level.get("Level"))] = kinds.get(str(level.get("Level")), 0) + 1
print("  корректировки по уровням:", kinds)
for m in modifiers[:12]:
    print("   ", m.get("CampaignId"), json.dumps(m.get("Levels"), ensure_ascii=False)[:200])

# --- отчёты -------------------------------------------------------------------
REPORTS = {
    "campaigns": ("CAMPAIGN_PERFORMANCE_REPORT",
                  ["CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr", "AvgCpc",
                   "Conversions", "ConversionRate", "CostPerConversion", "AvgImpressionPosition"]),
    "campaigns_daily": ("CAMPAIGN_PERFORMANCE_REPORT",
                        ["Date", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost",
                         "Conversions", "Ctr"]),
    "search_queries": ("SEARCH_QUERY_PERFORMANCE_REPORT",
                       ["Query", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost",
                        "Conversions", "Ctr"]),
    "placements": ("CUSTOM_REPORT",
                   ["Placement", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost",
                    "Conversions", "Ctr"]),
    "criteria": ("CRITERIA_PERFORMANCE_REPORT",
                 ["Criterion", "CriterionType", "CampaignId", "AdGroupId", "Impressions", "Clicks",
                  "Cost", "Conversions", "Ctr"]),
    "ads": ("AD_PERFORMANCE_REPORT",
            ["AdId", "AdGroupId", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost",
             "Conversions", "Ctr"]),
    "adgroups": ("AD_GROUP_PERFORMANCE_REPORT",
                 ["AdGroupId", "AdGroupName", "CampaignId", "CampaignName", "Impressions", "Clicks",
                  "Cost", "Conversions", "Ctr"]),
    "device": ("CUSTOM_REPORT",
               ["Device", "CampaignId", "Impressions", "Clicks", "Cost", "Conversions", "Ctr"]),
    "age_gender": ("CUSTOM_REPORT",
                   ["Age", "Gender", "CampaignId", "Impressions", "Clicks", "Cost", "Conversions"]),
}


def wait_report(report_type: str, fields: list[str], name: str, tries: int = 20, pause: float = 20.0) -> dict:
    last = None
    for attempt in range(1, tries + 1):
        result = direct.get_report(FROM, TO, report_type=report_type, fields=fields, name=name)
        if result.get("status") == "ok":
            return result
        last = result
        message = str(result.get("message") or "")
        print(f"  {name}: попытка {attempt} — {message[:100]}", flush=True)
        if result.get("status") == "error" and "очеред" not in message.lower():
            return result
        time.sleep(pause if "очеред" not in message.lower() else 60.0)
    return last or {"status": "error", "message": "отчёт не собрался"}


summary: dict = {}
for key, (report_type, fields) in REPORTS.items():
    name = f"audit2-{key}-90d"
    print(f"=== {key} ({report_type}) ===", flush=True)
    result = wait_report(report_type, fields, name)
    if result.get("status") != "ok":
        print("  не собрался:", result.get("status"), str(result.get("message"))[:200], flush=True)
        summary[key] = {"status": result.get("status"), "message": str(result.get("message"))[:300]}
        continue
    tsv = result.get("tsv") or ""
    lines = [line for line in tsv.splitlines() if line.strip()]
    path = HERE / f"direct-report-{key}.tsv"
    path.write_text(tsv, encoding="utf-8")
    summary[key] = {"status": "ok", "rows": max(len(lines) - 1, 0), "file": path.name}
    print(f"  строк: {max(len(lines) - 1, 0)}", flush=True)

out["reports_summary"] = summary
(HERE / "direct-settings.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
(HERE / "direct-reports-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
print("ГОТОВО. отчёты:", json.dumps(summary, ensure_ascii=False))
