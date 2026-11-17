# -*- coding: utf-8 -*-
"""Проверка отдельных настроек Директа для чек-листа (время, минус-слова групп, позиции)."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
settings = json.loads((HERE / "direct-settings.json").read_text(encoding="utf-8"))

print("=== TimeTargeting / DailyBudget по кампаниям ===")
for c in settings.get("campaigns") or []:
    print(f"  {str(c.get('Name'))[:40]:40} | TimeTargeting={json.dumps(c.get('TimeTargeting'), ensure_ascii=False)} "
          f"| DailyBudget={c.get('DailyBudget')} | TimeZone={c.get('TimeZone')}")

groups = settings.get("adgroups") or []
with_neg = [g for g in groups if (g.get("NegativeKeywords") or {}).get("Items")]
print(f"\nгрупп: {len(groups)}, с минус-словами: {len(with_neg)}")
regions = {}
for g in groups:
    key = tuple(sorted(g.get("RegionIds") or []))
    regions[key] = regions.get(key, 0) + 1
print("регионы групп (RegionIds):", list(regions.items())[:8])

kw = settings.get("keywords") or []
print(f"\nфраз: {len(kw)}; примеры: {[k.get('Keyword') for k in kw[:8]]}")
quoted = sum(1 for k in kw if str(k.get("Keyword", "")).startswith('"'))
bracketed = sum(1 for k in kw if str(k.get("Keyword", "")).startswith('['))
print(f"  во фразовых кавычках: {quoted}; в точном соответствии: {bracketed}")

# позиции из отчёта кампаний
p = HERE / "direct-report-campaigns.tsv"
if p.exists():
    fr = pd.read_csv(p, sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
    fr.columns = [c.strip().strip('"') for c in fr.columns]
    if "AvgImpressionPosition" in fr.columns:
        fr["Pos"] = pd.to_numeric(fr["AvgImpressionPosition"], errors="coerce")
        print("\nсредняя позиция по кампаниям:")
        for _, r in fr.iterrows():
            if pd.notna(r["Pos"]):
                print(f"  {str(r['CampaignName'])[:40]:40} {r['Pos']}")

# исключённые площадки
for c in settings.get("campaigns") or []:
    sites = ((c.get("ExcludedSites") or {}).get("Items") or [])
    if sites:
        print(f"\n{c.get('Name')[:40]}: исключено площадок {len(sites)}, примеры: {sites[:6]}")
    neg = ((c.get("NegativeKeywords") or {}).get("Items") or [])
    if neg and "РСЯ" in str(c.get("Name")):
        print(f"{c.get('Name')[:40]}: минус-слов {len(neg)}")
