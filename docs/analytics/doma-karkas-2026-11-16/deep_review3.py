# -*- coding: utf-8 -*-
"""Разбор фраз и запросов: каннибализация, незакрытый спрос, дубли, операторы, бренд в минусах."""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
TOKENS = re.compile(r"[а-яёa-z0-9]{3,}")
STOP = {"для", "под", "ключ", "дом", "дома", "домов", "из", "и", "в", "на", "с", "по", "от", "до", "не", "или",
        "the", "and", "for"}


def load(name):
    frame = pd.read_csv(HERE / f"direct-report-{name}.tsv", sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
    frame.columns = [c.strip().strip('"') for c in frame.columns]
    for col in ("Cost", "Clicks", "Conversions", "Impressions"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce").fillna(0.0)
    if "Cost" in frame.columns:
        frame["Cost"] = frame["Cost"] / 1e6
    for col in frame.columns:
        if frame[col].dtype == object:
            frame = frame[~frame[col].astype(str).str.startswith("Total rows")]
    return frame


queries = load("search_queries")
criteria = load("criteria")
settings = json.loads((HERE / "direct-settings.json").read_text(encoding="utf-8"))
keywords = [str(k.get("Keyword", "")) for k in (settings.get("keywords") or [])]
out: dict = {}

# 1. каннибализация: один запрос в нескольких кампаниях
by_query = queries.groupby("Query").agg(campaigns=("CampaignId", "nunique"), cost=("Cost", "sum"),
                                        clicks=("Clicks", "sum")).reset_index()
cannib = by_query[by_query["campaigns"] > 1].sort_values("cost", ascending=False)
out["cannibalization"] = {"count": len(cannib), "spend": float(cannib["cost"].sum()),
                          "top": [[str(r["Query"])[:70], int(r["campaigns"]), round(float(r["cost"]), 2), int(r["clicks"])]
                                  for _, r in cannib.head(20).iterrows()]}
print(f"каннибализация: запросов в ≥2 кампаниях — {len(cannib)}, их расход {cannib['cost'].sum():,.0f} ₽")
for row in out["cannibalization"]["top"][:8]:
    print("  ", row)

# 2. незакрытый спрос: запросы с конверсиями/расходом, не покрытые ключами
kw_tokens = [set(TOKENS.findall(k.lower())) - STOP for k in keywords]
kw_tokens = [t for t in kw_tokens if t]
covered = set()
for t in kw_tokens:
    covered |= t


def is_covered(query: str) -> bool:
    qt = set(TOKENS.findall(str(query).lower())) - STOP
    if not qt:
        return True
    hit = sum(1 for w in qt if w in covered)
    return hit / len(qt) >= 0.6


top_q = queries[queries["Cost"] >= 200].copy()
top_q["covered"] = top_q["Query"].map(is_covered)
gaps = top_q[~top_q["covered"]].sort_values("Cost", ascending=False)
out["uncovered"] = {"count": len(gaps), "spend": float(gaps["Cost"].sum()),
                    "top": [[str(r["Query"])[:70], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Conversions"])]
                            for _, r in gaps.head(25).iterrows()]}
print(f"\nнезакрытый спрос (запросы с расходом ≥200 ₽ вне ядра): {len(gaps)}, расход {gaps['Cost'].sum():,.0f} ₽")
for row in out["uncovered"]["top"][:12]:
    print("  ", row)

# 3. дубли и операторы во фразах
norm = defaultdict(list)
for k in keywords:
    words = sorted(TOKENS.findall(k.lower()))
    norm[" ".join(words)].append(k)
dups = {k: v for k, v in norm.items() if len(v) > 1 and k}
out["duplicate_keywords"] = {"groups": len(dups), "examples": [v[:4] for v in list(dups.values())[:10]]}
quoted = sum(1 for k in keywords if '"' in k)
bracketed = sum(1 for k in keywords if "[" in k)
minus_inside = sum(1 for k in keywords if " -" in k)
out["keyword_shape"] = {"total": len(keywords), "quoted": quoted, "exact": bracketed,
                        "with_inline_minus": minus_inside, "avg_len": round(sum(len(k) for k in keywords) / max(len(keywords), 1), 1)}
print(f"\nфраз: {len(keywords)}; дублей-групп: {len(dups)}; кавычки: {quoted}; точное: {bracketed}; "
      f"с минус-словами внутри фразы: {minus_inside}")

# 4. минус-слова кампаний: свой бренд и конкуренты
neg_words = []
for c in settings.get("campaigns") or []:
    items = ((c.get("NegativeKeywords") or {}).get("Items") or [])
    neg_words += [(str(c.get("Name"))[:30], w) for w in items]
flat = [w for _, w in neg_words]
brand_hits = [w for w in flat if re.search(r"интел|intel", w, re.I)]
out["negative_keywords"] = {"total": len(flat), "unique": len(set(flat)), "brand_hits": brand_hits[:20],
                            "sample": sorted(set(flat))[:60]}
print(f"минус-слов всего: {len(flat)} (уникальных {len(set(flat))}); упоминания своего бренда в минусах: {brand_hits[:10]}")

(HERE / "deep-review3.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: deep-review3.json")
