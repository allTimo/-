# -*- coding: utf-8 -*-
"""Настройки кампаний кабинета intel-denisov через API v5 (только чтение).

Собирает: кампании (бюджет, даты, статусы, минус-слова, запрещённые площадки),
группы, корректировки ставок, объявления (образец по кампаниям).
Результат: direct-settings.json + краткая сводка в консоль.
"""
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
    request = urllib.request.Request(
        f"https://api.direct.yandex.com/json/v5/{service}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in HEADERS.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:300]}


out: dict = {}

campaigns = call("campaigns", {"method": "get", "params": {
    "SelectionCriteria": {},
    "FieldNames": ["Id", "Name", "State", "Status", "StatusPayment", "StatusClarification",
                   "Type", "DailyBudget", "Currency", "StartDate", "EndDate", "TimeZone",
                   "TimeTargeting", "NegativeKeywords", "ExcludedSites", "BlockedIps",
                   "CreateTime", "Funds"],
    "Page": {"Limit": 200}}})
out["campaigns"] = campaigns
rows = campaigns.get("result", {}).get("Campaigns", []) if isinstance(campaigns, dict) else []
print("кампаний:", len(rows))
for c in rows[:15]:
    neg = c.get("NegativeKeywords") or {}
    neg_items = neg.get("Items") if isinstance(neg, dict) else None
    print(f"  {c.get('Id')} | {str(c.get('Name'))[:45]} | {c.get('State')}/{c.get('Status')} | "
          f"бюджет: {c.get('DailyBudget')} | минус-слов: {len(neg_items) if neg_items else 0} | "
          f"исключено площадок: {len((c.get('ExcludedSites') or {}).get('Items') or [])}")

CAMP_IDS = [c.get("Id") for c in rows if c.get("Id")]


def batched(ids: list, size: int = 10):
    for start in range(0, len(ids), size):
        yield ids[start:start + size]


def collect_many(service: str, key: str, fields: list[str], limit: int = 5000) -> list[dict]:
    """API принимает не больше 10 кампаний в SelectionCriteria.CampaignIds — идём батчами."""
    collected: list[dict] = []
    for chunk in batched(CAMP_IDS):
        result = call(service, {"method": "get", "params": {
            "SelectionCriteria": {"CampaignIds": chunk},
            "FieldNames": fields,
            "Page": {"Limit": limit}}})
        if isinstance(result, dict) and result.get("error"):
            print(f"  {service}: ошибка — {str(result['error'].get('error_detail'))[:120]}")
            break
        collected.extend(result.get("result", {}).get(key, []) if isinstance(result, dict) else [])
    return collected


group_rows = collect_many("adgroups", "AdGroups", ["Id", "Name", "CampaignId", "Status", "Type"])
out["adgroups"] = group_rows
print("групп:", len(group_rows))

ad_rows = collect_many("ads", "Ads", ["Id", "CampaignId", "AdGroupId", "State", "Status", "Type"])
out["ads"] = ad_rows
print("объявлений:", len(ad_rows))

kw_rows = collect_many("keywords", "Keywords",
                       ["Id", "Keyword", "CampaignId", "AdGroupId", "State", "Status"])
out["keywords"] = kw_rows
print("ключевых фраз:", len(kw_rows))

modifiers = call("bidmodifiers", {"method": "get", "params": {
    "SelectionCriteria": {"CampaignIds": CAMP_IDS[:10]},
    "FieldNames": ["Id", "CampaignId", "Levels"],
    "Page": {"Limit": 1000}}})
if isinstance(modifiers, dict) and modifiers.get("error"):
    out["bidmodifiers"] = {"error": modifiers["error"]}
    print("корректировки: ошибка —", str(modifiers["error"].get("error_detail"))[:150])
else:
    mod_rows = modifiers.get("result", {}).get("BidModifiers", [])
    out["bidmodifiers"] = mod_rows
    print("корректировок:", len(mod_rows))
    kinds: dict[str, int] = {}
    for m in mod_rows:
        for level in (m.get("Levels") or []):
            key = str(level.get("Level"))
            kinds[key] = kinds.get(key, 0) + 1
    print("  по уровням:", kinds)

(HERE / "direct-settings.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("сохранено: direct-settings.json")
