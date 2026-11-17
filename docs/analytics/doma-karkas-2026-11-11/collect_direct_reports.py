# -*- coding: utf-8 -*-
"""Сбор отчётов Директа после одобрения заявки на API.

Только чтение: Reports (TSV) и Campaigns.get. Ничего в аккаунте не меняем.
Результат: direct-campaigns.json, direct-report-*.tsv рядом со скриптом.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
TODAY = date(2026, 11, 11)
FROM = TODAY - timedelta(days=89)

REPORTS = {
    "campaigns": (
        "CAMPAIGN_PERFORMANCE_REPORT",
        ["CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr", "AvgCpc",
         "Conversions", "ConversionRate", "CostPerConversion"],
    ),
    "search_queries": (
        "SEARCH_QUERY_PERFORMANCE_REPORT",
        ["Query", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions", "Ctr"],
    ),
    "placements": (
        "CUSTOM_REPORT",
        ["Placement", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions", "Ctr"],
    ),
    "criteria": (
        "CRITERIA_PERFORMANCE_REPORT",
        ["Criterion", "CriterionType", "CampaignId", "AdGroupId", "Impressions", "Clicks", "Cost", "Conversions", "Ctr"],
    ),
}


def wait_report(report_type: str, fields: list[str], name: str, tries: int = 12, pause: float = 15.0) -> dict:
    """Reports асинхронный: 201 = «готовится», повторяем запрос С ТЕМ ЖЕ именем.

    Имя отчёта фиксированное: Reports кэширует результат по имени+параметрам, поэтому
    повтор с новым именем создавал бы новый отчёт и упирался в лимит «5 отчётов в очереди».
    """
    last = None
    for attempt in range(1, tries + 1):
        result = direct.get_report(str(FROM), str(TODAY), report_type=report_type, fields=fields, name=name)
        if result.get("status") == "ok":
            return result
        last = result
        message = str(result.get("message") or "")
        print(f"  {report_type} [{name}]: попытка {attempt} — {message[:110]}")
        if "9000" in message or "очеред" in message.lower():
            print("    очередь отчётов занята, ждём 60 с")
            time.sleep(60)
            continue
        if result.get("status") == "error":
            return result
        time.sleep(pause)
    return last or {"status": "error", "message": "отчёт не собрался"}


load_env_file()

campaigns = direct.get_campaigns()
print("кампаний:", len(campaigns))
(HERE / "direct-campaigns.json").write_text(
    json.dumps(campaigns, ensure_ascii=False, indent=2), encoding="utf-8")

summary = {}
for key, (report_type, fields) in REPORTS.items():
    name = f"audit-{key}-90d"
    print(f"=== {key} ({report_type}, имя {name}) ===")
    result = wait_report(report_type, fields, name)
    if result.get("status") != "ok":
        print("  не собрался:", result.get("status"), str(result.get("message"))[:200])
        summary[key] = {"status": result.get("status"), "message": result.get("message")}
        continue
    tsv = result.get("tsv") or ""
    lines = [line for line in tsv.splitlines() if line.strip()]
    path = HERE / f"direct-report-{key}.tsv"
    path.write_text(tsv, encoding="utf-8")
    summary[key] = {"status": "ok", "rows": max(len(lines) - 1, 0), "file": path.name}
    print(f"  строк: {max(len(lines) - 1, 0)}, файл: {path.name}")
    print("  заголовок:", lines[1][:150] if len(lines) > 1 else (lines[0][:150] if lines else "—"))

(HERE / "direct-reports-summary.json").write_text(
    json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False))
