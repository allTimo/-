# -*- coding: utf-8 -*-
"""Догон 2: где минусуется свой бренд, кто каннибализирует, кто ловит каркасный спрос."""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent


def load(name):
    frame = pd.read_csv(HERE / f"direct-report-{name}.tsv", sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
    frame.columns = [c.strip().strip('"') for c in frame.columns]
    for col in ("Cost", "Clicks", "Conversions", "Impressions"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce").fillna(0.0)
    frame["Cost"] = frame["Cost"] / 1e6
    for col in frame.columns:
        if frame[col].dtype == object:
            frame = frame[~frame[col].astype(str).str.startswith("Total rows")]
    return frame


settings = json.loads((HERE / "direct-settings.json").read_text(encoding="utf-8"))
queries = load("search_queries")
out: dict = {}

# 1. бренд в минус-словах: где именно
print("=== кампании, минусующие свой бренд ===")
brand_rows = []
for c in settings.get("campaigns") or []:
    items = [str(w) for w in ((c.get("NegativeKeywords") or {}).get("Items") or [])]
    hits = [w for w in items if re.search(r"интел|intel", w, re.I)]
    if hits:
        brand_rows.append({"campaign": c.get("Name"), "id": c.get("Id"), "hits": hits[:6], "neg_total": len(items)})
        print(f"  {str(c.get('Name'))[:46]:46} | минус-слов {len(items)} | бренд в минусах: {hits[:4]}")
out["brand_minus"] = brand_rows

# 2. брендовый спрос в отчёте запросов
brand_q = queries[queries["Query"].astype(str).str.contains(r"интел|intel", case=False, regex=True)]
out["brand_queries"] = {"count": len(brand_q), "spend": float(brand_q["Cost"].sum()),
                        "clicks": int(brand_q["Clicks"].sum()), "conversions": float(brand_q["Conversions"].sum()),
                        "top": [[str(r["Query"])[:60], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Conversions"]),
                                 str(r["CampaignName"])[:34]] for _, r in brand_q.sort_values("Cost", ascending=False).head(12).iterrows()]}
print(f"\n=== брендовые запросы в отчёте: {len(brand_q)}, расход {brand_q['Cost'].sum():,.0f} ₽, "
      f"клики {brand_q['Clicks'].sum():,.0f}, конверсии {brand_q['Conversions'].sum():,.0f} ===")
for row in out["brand_queries"]["top"][:10]:
    print("  ", row)

# 3. каркасный / деревянный / СИП спрос
FRAME_RE = re.compile(r"каркас|сип|брус|деревянн|модульн|бревн|clt", re.I)
frame_q = queries[queries["Query"].astype(str).str.contains(FRAME_RE)]
out["frame_demand"] = {"count": len(frame_q), "spend": float(frame_q["Cost"].sum()),
                       "clicks": int(frame_q["Clicks"].sum()), "conversions": float(frame_q["Conversions"].sum()),
                       "by_campaign": frame_q.groupby("CampaignName")[["Cost", "Clicks", "Conversions"]].sum()
                       .reset_index().sort_values("Cost", ascending=False).head(10).to_dict("records"),
                       "top": [[str(r["Query"])[:60], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Conversions"])]
                               for _, r in frame_q.sort_values("Cost", ascending=False).head(20).iterrows()]}
print(f"\n=== каркас/дерево/СИП: запросов {len(frame_q)}, расход {frame_q['Cost'].sum():,.0f} ₽, "
      f"конверсии Директа {frame_q['Conversions'].sum():,.0f} ===")
for row in out["frame_demand"]["by_campaign"][:6]:
    print(f"   {str(row['CampaignName'])[:44]:44} {row['Cost']:,.0f} ₽ | клики {row['Clicks']:.0f} | конв. {row['Conversions']:.0f}")

# 4. каннибализация: какие кампании делят одни запросы
per_campaign = queries.groupby("CampaignName").agg(cost=("Cost", "sum"), clicks=("Clicks", "sum"),
                                                   queries=("Query", "nunique")).reset_index()
shared = queries.groupby("Query")["CampaignId"].nunique()
queries["shared"] = queries["Query"].map(shared)
cannib = queries[queries["shared"] > 1].groupby("CampaignName").agg(
    cost=("Cost", "sum"), clicks=("Clicks", "sum"), shared_queries=("Query", "nunique")).reset_index()
out["cannibalization_by_campaign"] = cannib.sort_values("cost", ascending=False).to_dict("records")
print("\n=== расход в кампаниях по запросам, которые идут в ≥2 кампаниях ===")
for row in out["cannibalization_by_campaign"][:8]:
    print(f"   {str(row['CampaignName'])[:44]:44} {row['cost']:,.0f} ₽ | общих запросов {row['shared_queries']:.0f}")

# 5. поисковые запросы: топ по расходу с конверсиями (что реально работает)
top = queries.sort_values("Cost", ascending=False).head(15)
out["top_queries"] = [[str(r["Query"])[:60], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Conversions"]),
                       str(r["CampaignName"])[:34]] for _, r in top.iterrows()]
print("\n=== топ-15 запросов по расходу ===")
for row in out["top_queries"]:
    print("  ", row)

(HERE / "deep-review4.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: deep-review4.json")
