# -*- coding: utf-8 -*-
"""Разбор сети (поиск/РСЯ), последних 14 дней, площадок и минус-слов + проверка посадочных."""
from __future__ import annotations

import json
import ssl
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
TRASH = re.compile(r"аренд|снять|сдам|работа|ваканс|резюме|отзыв|фото|своими руками|чертеж|чертёж|бесплатн|"
                   r"б/у|вторичк|обои|жкх|схема|гост|снип|норматив|расчет|расчёт|калькулятор|скачать|"
                   r"как |что |почему |чем |какой |какая |сколько|своими|пошагов|инструкция|видео", re.IGNORECASE)


def load(name: str) -> pd.DataFrame:
    path = HERE / f"direct-report-{name}.tsv"
    if not path.exists():
        return pd.DataFrame()
    frame = pd.read_csv(path, sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
    frame.columns = [c.strip().strip('"') for c in frame.columns]
    for col in ("Impressions", "Clicks", "Cost", "Conversions", "Ctr", "AvgCpc", "CostPerConversion"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce").fillna(0.0)
    for col in ("Cost", "AvgCpc", "CostPerConversion"):
        if col in frame.columns:
            frame[col] = frame[col] / 1_000_000.0
    for col in frame.columns:
        if frame[col].dtype == object:
            frame = frame[~frame[col].astype(str).str.startswith("Total rows")]
    return frame


def money(v) -> str:
    return f"{float(v):,.0f}".replace(",", " ") + " ₽"


out: dict = {}
network = load("network")
if not network.empty:
    agg = network.groupby("AdNetworkType")[["Impressions", "Clicks", "Cost", "Conversions"]].sum().reset_index()
    out["network"] = agg.to_dict("records")
    print("=== поиск vs РСЯ (Директ, 90 дней) ===")
    for r in out["network"]:
        cpa = r["Cost"] / r["Conversions"] if r["Conversions"] else None
        print(f"  {r['AdNetworkType']}: расход {money(r['Cost'])}, клики {int(r['Clicks']):,}, "
              f"конверсии {int(r['Conversions']):,}, CPA {money(cpa) if cpa else '—'}".replace(",", " "))
    print("  по кампаниям:")
    for _, r in network.sort_values("Cost", ascending=False).iterrows():
        print(f"    {str(r['CampaignName'])[:44]:44} | {r['AdNetworkType']:8} | {money(r['Cost']):>12} | "
              f"клики {int(r['Clicks']):>6} | конв. {int(r['Conversions']):>6} | CTR {r['Ctr']:.2f}")
    out["network_by_campaign"] = network.to_dict("records")

last14 = load("last14")
if not last14.empty:
    agg14 = last14.groupby(["CampaignId", "CampaignName"])[["Impressions", "Clicks", "Cost", "Conversions"]].sum().reset_index()
    out["last14"] = agg14.sort_values("Cost", ascending=False).to_dict("records")
    print("\n=== последние 14 дней (2026-11-03…11-16) ===")
    for r in out["last14"]:
        print(f"  {str(r['CampaignName'])[:46]:46} | {money(r['Cost']):>12} | клики {int(r['Clicks']):>5} | конв. {int(r['Conversions'])}")

placements = load("placements")
if not placements.empty:
    pl = placements.copy()
    pl["cpa"] = pl.apply(lambda r: r["Cost"] / r["Conversions"] if r["Conversions"] else None, axis=1)
    expensive = pl[(pl["Cost"] >= 2000) & ((pl["cpa"].isna()) | (pl["cpa"] > 1000))].sort_values("Cost", ascending=False)
    out["placements_expensive"] = {"count": len(expensive), "spend": float(expensive["Cost"].sum()),
                                   "top": [[str(r["Placement"])[:70], round(float(r["Cost"]), 2), int(r["Clicks"]),
                                            int(r["Conversions"]),
                                            round(float(r["cpa"]), 0) if pd.notna(r["cpa"]) else None]
                                           for _, r in expensive.head(40).iterrows()]}
    print(f"\n=== площадки с расходом ≥2 000 ₽ и CPA >1 000 ₽ (или без конверсий): {len(expensive)} "
          f"на {money(expensive['Cost'].sum())}")
    for p in out["placements_expensive"]["top"][:12]:
        print(f"  {p[0][:60]:60} | {money(p[1]):>10} | клики {p[2]:>5} | конв. {p[3]:>4} | CPA {p[4]}")

    # площадки внутри РСЯ-кампании (по названию)
    rya_names = [n for n in placements["CampaignName"].unique() if "рся" in str(n).lower() or "товарная" in str(n).lower()]
    rya = pl[pl["CampaignName"].isin(rya_names)]
    out["rya_summary"] = {"campaigns": list(map(str, rya_names)), "spend": float(rya["Cost"].sum()),
                          "clicks": int(rya["Clicks"].sum()), "conversions": int(rya["Conversions"].sum())}
    print(f"  РСЯ-подобные кампании: {len(rya_names)}, расход {money(rya['Cost'].sum())}, "
          f"конверсии {int(rya['Conversions'].sum())}")

queries = load("search_queries")
if not queries.empty:
    q = queries.copy()
    q["trash"] = q["Query"].astype(str).str.contains(TRASH)
    minus = q[(q["Cost"] >= 300) & (q["Conversions"] == 0) & (q["Clicks"] >= 3)].sort_values("Cost", ascending=False)
    trash = q[q["trash"] & (q["Cost"] >= 100)].sort_values("Cost", ascending=False)
    out["minus_candidates"] = {"count": len(minus), "spend": float(minus["Cost"].sum()),
                               "rows": [[str(r["Query"])[:70], round(float(r["Cost"]), 2), int(r["Clicks"]),
                                         str(r["CampaignName"])[:38]] for _, r in minus.head(60).iterrows()]}
    out["trash_queries"] = {"count": len(trash), "spend": float(trash["Cost"].sum()),
                            "rows": [[str(r["Query"])[:70], round(float(r["Cost"]), 2), int(r["Clicks"])]
                                     for _, r in trash.head(80).iterrows()]}
    print(f"\n=== минус-кандидаты: {len(minus)} запросов на {money(minus['Cost'].sum())}; "
          f"мусорных {len(trash)} на {money(trash['Cost'].sum())}")
    words: dict = {}
    for txt in list(minus["Query"].astype(str)) + list(trash["Query"].astype(str)):
        for w in re.findall(r"[а-яёa-z0-9\-]{3,}", txt.lower()):
            words[w] = words.get(w, 0) + 1
    out["minus_words_freq"] = sorted(words.items(), key=lambda x: -x[1])[:60]
    print("  частые слова в минус-кандидатах:", out["minus_words_freq"][:25])

criteria = load("criteria")
if not criteria.empty:
    by_type = criteria.groupby("CriterionType")[["Cost", "Clicks", "Conversions"]].sum().reset_index()
    out["criteria_by_type"] = by_type.to_dict("records")
    print("\n=== критерии по типам ===")
    for r in out["criteria_by_type"]:
        print(f"  {r['CriterionType']}: расход {money(r['Cost'])}, клики {int(r['Clicks']):,}, конверсии {int(r['Conversions']):,}".replace(",", " "))
    bad = criteria[(criteria["Cost"] >= 2000)].copy()
    bad["cpa"] = bad.apply(lambda r: r["Cost"] / r["Conversions"] if r["Conversions"] else None, axis=1)
    worst = bad[(bad["cpa"].isna()) | (bad["cpa"] > 500)].sort_values("Cost", ascending=False)
    out["criteria_expensive"] = [[str(r.get("Criterion"))[:60], str(r.get("CriterionType")),
                                  round(float(r["Cost"]), 2), int(r["Clicks"]),
                                  round(float(r["cpa"]), 0) if pd.notna(r["cpa"]) else None]
                                 for _, r in worst.head(30).iterrows()]
    print(f"  фраз с расходом ≥2 000 ₽ и CPA >500 ₽ (или без конверсий): {len(worst)} на {money(worst['Cost'].sum())}")

# --- проверка посадочных из Метрики -------------------------------------------
findings = json.loads((HERE / "metrika-findings.json").read_text(encoding="utf-8"))
landings = [r for r in findings["splits"]["landing"]["rows"] if r.get("startURL")][:60]
ctx = ssl._create_unverified_context()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
checked = []
for r in landings:
    url = str(r["startURL"]).split("?")[0]
    item = {"url": url, "visits": r["visits"], "bounce": r["bounceRate"], "orders": r["g_order"],
            "paid": r["g_paid"], "calls": r["g_call"]}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            body = resp.read()
            item["status"] = resp.status
            item["load_s"] = round(time.perf_counter() - t0, 2)
            item["bytes"] = len(body)
            text = body.decode("utf-8", "ignore")
            item["has_metrika"] = "22595095" in text
            item["has_form"] = bool(re.search(r"<form|send-form-", text, re.I))
            item["has_quiz"] = bool(re.search(r"selectprojects|подобрать проект", text, re.I))
    except urllib.error.HTTPError as exc:
        item["status"] = exc.code
    except Exception as exc:  # noqa: BLE001
        item["status"] = f"{type(exc).__name__}"
    checked.append(item)
    time.sleep(0.25)

out["landings_checked"] = checked
broken = [c for c in checked if c.get("status") != 200]
print(f"\n=== проверка посадочных из Метрики: {len(checked)} URL, не 200: {len(broken)} ===")
for c in broken[:20]:
    print(f"  {c['status']} | визитов {c['visits']:.0f} | {c['url'][:80]}")
slow = sorted([c for c in checked if c.get("load_s")], key=lambda x: -x["load_s"])[:8]
print("  самые медленные:", [(c["url"][-40:], c["load_s"], f"{c['bytes']//1024} КБ") for c in slow])
zero_order = [c for c in checked if (c.get("orders") or 0) == 0 and c["visits"] >= 200]
print(f"  посадочных с трафиком ≥200 визитов и 0 заказами: {len(zero_order)}, суммарно визитов "
      f"{sum(c['visits'] for c in zero_order):.0f}")

(HERE / "direct-extra-analysis.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: direct-extra-analysis.json")
