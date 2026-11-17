# -*- coding: utf-8 -*-
"""Печать ключевых срезов Метрики для аудита (читает metrika-findings.json)."""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
d = json.loads((HERE / "metrika-findings.json").read_text(encoding="utf-8"))
s = d["splits"]

print("ERRORS:", d.get("errors"))
print("CARDS:", json.dumps({k: v for k, v in (d.get("card") or {}).items()
                            if k in ("code_status", "autogoals_enabled", "ecommerce_deduplicator_enabled",
                                     "filter_robots", "webvisor", "clickmap", "ecommerce", "ecom_options",
                                     "activity_status", "visit_threshold", "mirrors")}, ensure_ascii=False)[:700])
print("FILTERS:", json.dumps(d.get("filters"), ensure_ascii=False)[:900])
print("SEGMENTS:", json.dumps(d.get("segments"), ensure_ascii=False)[:700])

def line(*parts):
    print(" | ".join(str(p) for p in parts))

print("\n--- SOURCE ---")
line("source", "visits", "bounce", "call", "lid", "order", "paid", "spam")
for r in s["source"]["rows"]:
    line(str(r["lastsignTrafficSource"])[:26], f"{r['visits']:.0f}", f"{r['bounceRate']:.1f}",
         r["g_call"], r["g_lid"], r["g_order"], r["g_paid"], r["g_spam"])

print("\n--- CHANNEL (source x engine) top 16 ---")
for r in s["channel"]["rows"][:16]:
    line(str(r["lastsignTrafficSource"])[:20], str(r["lastsignSearchEngine"])[:22], f"{r['visits']:.0f}",
         "order", r["g_order"], "paid", r["g_paid"])

print("\n--- DIRECT CAMPAIGN (Metrika) ---")
line("campaign", "visits", "bounce", "call", "lid", "order", "paid", "spam", "cr_order%")
for r in s["campaign"]["rows"]:
    line(str(r["lastDirectClickOrderName"])[:44], f"{r['visits']:.0f}", f"{r['bounceRate']:.1f}",
         r["g_call"], r["g_lid"], r["g_order"], r["g_paid"], r["g_spam"], r["cr_order_pct"])

print("\n--- UTM SOURCE ---")
for r in s["utm_source"]["rows"]:
    line(str(r["lastsignUTMSource"])[:30], f"{r['visits']:.0f}", "order", r["g_order"], "paid", r["g_paid"])
print("--- UTM MEDIUM ---")
for r in s["utm_medium"]["rows"]:
    line(str(r["lastsignUTMMedium"])[:30], f"{r['visits']:.0f}", "order", r["g_order"])

print("\n--- DEVICE ---")
line("device", "visits", "bounce", "depth", "call", "lid", "order", "paid", "cr_order%")
for r in s["device"]["rows"]:
    line(str(r["deviceCategory"])[:10], f"{r['visits']:.0f}", f"{r['bounceRate']:.1f}", f"{r['pageDepth']:.2f}",
         r["g_call"], r["g_lid"], r["g_order"], r["g_paid"], r["cr_order_pct"])

print("\n--- LANDING top 25 ---")
line("landing", "visits", "bounce", "order", "paid", "call")
for r in s["landing"]["rows"][:25]:
    line(str(r["startURL"])[:62], f"{r['visits']:.0f}", f"{r['bounceRate']:.1f}", r["g_order"], r["g_paid"], r["g_call"])

print("\n--- PHRASES top 25 (traffic) ---")
line("phrase", "visits", "bounce", "order", "paid")
for r in s["phrase"]["rows"][:25]:
    line(str(r["searchPhrase"])[:58], f"{r['visits']:.0f}", f"{r['bounceRate']:.0f}", r["g_order"], r["g_paid"])

print("\n--- PHRASES with orders/paid ---")
for r in s["phrase"]["rows"]:
    if (r["g_order"] or 0) > 0 or (r["g_paid"] or 0) > 0:
        line(str(r["searchPhrase"])[:58], f"visits={r['visits']:.0f}", "order", r["g_order"], "paid", r["g_paid"])

print("\n--- GEO top 25 ---")
line("city", "visits", "bounce", "order", "paid")
for r in s["geo"]["rows"][:25]:
    line(str(r["regionCity"])[:26], f"{r['visits']:.0f}", f"{r['bounceRate']:.1f}", r["g_order"], r["g_paid"])

print("\n--- AGE ---")
for r in s["age"]["rows"]:
    line(str(r["ageInterval"])[:12], f"visits={r['visits']:.0f}", "order", r["g_order"], "paid", r["g_paid"], "cr%", r["cr_order_pct"])
print("--- GENDER ---")
for r in s["gender"]["rows"]:
    line(str(r["gender"])[:10], f"visits={r['visits']:.0f}", "order", r["g_order"], "paid", r["g_paid"])

print("\n--- DEAD GOALS ---")
for g in d["goals"]["dead_90d"]:
    line(g["id"], g["name"][:50], g["type"], "prev:", g["reaches_prev90"])
