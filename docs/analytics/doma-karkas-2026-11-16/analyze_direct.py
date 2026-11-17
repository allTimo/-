# -*- coding: utf-8 -*-
"""Аудит кабинета intel-denisov: экономика, сливы, точки роста (только чтение).

Вход: direct-report-*.tsv + direct-settings.json + metrika-findings.json.
Выход: direct-findings.json, audit-direct-2026-11-16.md.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
MIN_SPEND = 3000.0
TRASH = re.compile(r"аренд|снять|сдам|работа|ваканс|резюме|отзыв|фото|своими руками|чертеж|чертёж|бесплатн|"
                   r"б/у|вторичк|обои|жкх|схема|гост|снип|норматив|расчет|расчёт|калькулятор|скачать|"
                   r"как |что |почему |чем |какой |какая |сколько|цена за куб|своими|пошагов|инструкция|видео",
                   re.IGNORECASE)

MONEY_COLS = ("Cost", "AvgCpc", "CostPerConversion")


def load(name: str) -> pd.DataFrame:
    path = HERE / f"direct-report-{name}.tsv"
    if not path.exists():
        return pd.DataFrame()
    frame = pd.read_csv(path, sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
    frame.columns = [c.strip().strip('"') for c in frame.columns]
    for col in ("Impressions", "Clicks", "Cost", "Conversions", "Ctr", "AvgCpc", "ConversionRate",
                "CostPerConversion", "AvgImpressionPosition"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce").fillna(0.0)
    # Reports отдаёт деньги в микроединицах (1 ₽ = 1 000 000)
    for col in MONEY_COLS:
        if col in frame.columns:
            frame[col] = frame[col] / 1_000_000.0
    for col in frame.columns:
        if frame[col].dtype == object:
            frame = frame[~frame[col].astype(str).str.startswith("Total rows")]
    return frame


def money(v) -> str:
    return f"{float(v):,.0f}".replace(",", " ") + " ₽"


campaigns = load("campaigns")
campaigns_daily = load("campaigns_daily")
queries = load("search_queries")
placements = load("placements")
criteria = load("criteria")
ads = load("ads")
adgroups = load("adgroups")
device = load("device")
age_gender = load("age_gender")

settings = json.loads((HERE / "direct-settings.json").read_text(encoding="utf-8")) if (HERE / "direct-settings.json").exists() else {}
findings_meta = json.loads((HERE / "metrika-findings.json").read_text(encoding="utf-8")) if (HERE / "metrika-findings.json").exists() else {}

out: dict = {"period": ["2026-08-19", "2026-11-16"], "source": "Яндекс.Директ API v5 (Reports, Campaigns.get, TextCampaign.get)"}

total_spend = float(campaigns["Cost"].sum()) if not campaigns.empty else 0.0
total_clicks = float(campaigns["Clicks"].sum()) if not campaigns.empty else 0.0
total_conv = float(campaigns["Conversions"].sum()) if not campaigns.empty else 0.0
total_impr = float(campaigns["Impressions"].sum()) if not campaigns.empty else 0.0
print(f"РАСХОД: {money(total_spend)} | клики {total_clicks:,.0f} | показы {total_impr:,.0f} | конверсии Директа {total_conv:,.0f}")
out["totals"] = {"spend": total_spend, "clicks": total_clicks, "impressions": total_impr,
                 "conversions": total_conv, "cpa_direct": total_spend / total_conv if total_conv else None}

# --- метрика: заказы/оплаты по кампаниям ---------------------------------------
meta_campaigns = {}
meta = findings_meta.get("splits", {}).get("campaign", {}).get("rows", [])
for r in meta:
    name = str(r.get("lastDirectClickOrderName") or "")
    meta_campaigns[name] = {"visits": r.get("visits"), "g_order": r.get("g_order"), "g_paid": r.get("g_paid"),
                            "g_call": r.get("g_call"), "g_lid": r.get("g_lid"), "g_spam": r.get("g_spam"),
                            "bounceRate": r.get("bounceRate")}
out["metrika_campaigns"] = meta_campaigns

# --- кампании: экономика --------------------------------------------------------
camp_rows = []
for _, row in campaigns.sort_values("Cost", ascending=False).iterrows():
    name = str(row.get("CampaignName"))
    m = meta_campaigns.get(name, {})
    orders = m.get("g_order") or 0
    paid = m.get("g_paid") or 0
    calls = m.get("g_call") or 0
    spend = float(row["Cost"])
    camp_rows.append({
        "id": str(row.get("CampaignId")), "name": name, "spend": spend, "clicks": int(row["Clicks"]),
        "impressions": int(row["Impressions"]), "ctr": float(row.get("Ctr") or 0),
        "avg_cpc": float(row.get("AvgCpc") or 0), "conversions": int(row["Conversions"]),
        "cpa": float(row.get("CostPerConversion") or 0),
        "crm_orders": orders, "crm_paid": paid, "crm_calls": calls,
        "metrika_visits": m.get("visits"),
        "cost_per_order": spend / orders if orders else None,
        "cost_per_paid": spend / paid if paid else None,
        "cpl_paid_share": (paid / orders) if orders else None,
        "bounce": m.get("bounceRate"),
        "crm_spam": m.get("g_spam"),
    })
out["campaigns"] = camp_rows
print("\n=== кампании (расход / конверсии Директа / заказы CRM / оплаты CRM) ===")
for c in camp_rows:
    cp = f"{c['cost_per_paid']:,.0f}" if c["cost_per_paid"] else "—"
    print(f"  {c['name'][:46]:46} | {money(c['spend']):>12} | клики {c['clicks']:>6} | конв. {c['conversions']:>6}"
          f" | CPA {c['cpa']:>8,.0f} | заказы {c['crm_orders']:>3} | оплаты {c['crm_paid']:>3} | ₽/оплата {cp:>10}"
          f" | отказы {c['bounce']}")

zero_paid = [c for c in camp_rows if not c["crm_paid"]]
zero_paid_spend = sum(c["spend"] for c in zero_paid if c["spend"] > 1000)
out["zero_paid"] = {"count": len(zero_paid), "spend": zero_paid_spend,
                    "list": [(c["name"], c["spend"], c["conversions"], c["crm_orders"]) for c in zero_paid]}
print(f"\nкампаний без оплат: {len(zero_paid)}, их расход: {money(zero_paid_spend)}")

# --- поисковые запросы ----------------------------------------------------------
if not queries.empty:
    q = queries.copy()
    q["is_trash"] = q["Query"].astype(str).str.contains(TRASH)
    q_no_conv = q[(q["Cost"] >= 500) & (q["Conversions"] == 0)].sort_values("Cost", ascending=False)
    q_trash = q[q["is_trash"] & (q["Cost"] >= 100)].sort_values("Cost", ascending=False)
    out["queries"] = {
        "total": len(q), "no_conv_count": len(q_no_conv), "no_conv_spend": float(q_no_conv["Cost"].sum()),
        "trash_count": len(q_trash), "trash_spend": float(q_trash["Cost"].sum()),
        "no_conv_top": [[str(r["Query"])[:80], round(float(r["Cost"]), 2), int(r["Clicks"]), str(r["CampaignName"])[:40]]
                        for _, r in q_no_conv.head(40).iterrows()],
        "trash_top": [[str(r["Query"])[:80], round(float(r["Cost"]), 2), int(r["Clicks"])]
                      for _, r in q_trash.head(60).iterrows()],
    }
    print(f"\nзапросов всего {len(q):,}; без конверсий (≥500 ₽): {len(q_no_conv)} на {money(q_no_conv['Cost'].sum())};"
          f" мусорных: {len(q_trash)} на {money(q_trash['Cost'].sum())}")

# --- площадки -------------------------------------------------------------------
if not placements.empty:
    bad_pl = placements[(placements["Cost"] >= MIN_SPEND) & (placements["Conversions"] == 0)].sort_values("Cost", ascending=False)
    top_pl = placements.sort_values("Cost", ascending=False).head(25)
    out["placements"] = {
        "total": len(placements), "bad_count": len(bad_pl), "bad_spend": float(bad_pl["Cost"].sum()),
        "bad_share_pct": float(bad_pl["Cost"].sum()) / max(total_spend, 1) * 100,
        "bad_top": [[str(r["Placement"])[:80], round(float(r["Cost"]), 2), int(r["Clicks"])] for _, r in bad_pl.head(40).iterrows()],
        "top": [[str(r["Placement"])[:80], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Conversions"]),
                 round(float(r["Cost"]) / float(r["Conversions"]), 2) if float(r["Conversions"]) else None]
                for _, r in top_pl.iterrows()],
    }
    print(f"\nплощадок {len(placements):,}; с нулём конверсий и расходом ≥{money(MIN_SPEND)}: {len(bad_pl)} "
          f"на {money(bad_pl['Cost'].sum())} ({out['placements']['bad_share_pct']:.1f}% расхода)")

# --- критерии -------------------------------------------------------------------
if not criteria.empty:
    bad_cr = criteria[(criteria["Cost"] >= MIN_SPEND) & (criteria["Conversions"] == 0)].sort_values("Cost", ascending=False)
    out["criteria"] = {
        "total": len(criteria), "bad_count": len(bad_cr), "bad_spend": float(bad_cr["Cost"].sum()),
        "bad_top": [[str(r.get("Criterion"))[:70], str(r.get("CriterionType")), round(float(r["Cost"]), 2), int(r["Clicks"])]
                    for _, r in bad_cr.head(30).iterrows()],
        "by_type": criteria.groupby("CriterionType")[["Cost", "Clicks", "Conversions"]].sum().reset_index().to_dict("records"),
    }
    print(f"фраз {len(criteria):,}; без конверсий (≥{money(MIN_SPEND)}): {len(bad_cr)} на {money(bad_cr['Cost'].sum())}")

# --- объявления и группы --------------------------------------------------------
if not ads.empty:
    top_ads = ads.sort_values("Cost", ascending=False).head(25)
    out["ads"] = {"total": len(ads),
                  "zero_conv_spend": float(ads[(ads["Cost"] >= MIN_SPEND) & (ads["Conversions"] == 0)]["Cost"].sum()),
                  "top": [[str(r.get("AdId")), str(r.get("CampaignName"))[:40], round(float(r["Cost"]), 2),
                           int(r["Clicks"]), int(r["Conversions"])] for _, r in top_ads.iterrows()]}
    print(f"объявлений в отчёте: {len(ads)}; расход объявлений с 0 конверсий: {money(out['ads']['zero_conv_spend'])}")
if not adgroups.empty:
    out["adgroups"] = {"total": len(adgroups),
                       "top": [[str(r.get("AdGroupName"))[:50], str(r.get("CampaignName"))[:30], round(float(r["Cost"]), 2),
                                int(r["Clicks"]), int(r["Conversions"])]
                               for _, r in adgroups.sort_values("Cost", ascending=False).head(25).iterrows()]}

# --- устройства / возраст / пол -------------------------------------------------
if not device.empty:
    out["device"] = device.to_dict("records")
    print("\n=== устройства (Директ) ===")
    for r in out["device"]:
        print(f"  {r.get('Device')}: расход {money(r['Cost'])}, клики {int(r['Clicks'])}, конверсии {int(r['Conversions'])}")
if not age_gender.empty:
    out["age_gender"] = age_gender.to_dict("records")
    print("=== возраст/пол (Директ) ===")
    for r in sorted(out["age_gender"], key=lambda x: -float(x["Cost"]))[:10]:
        print(f"  {r.get('Age')} / {r.get('Gender')}: расход {money(r['Cost'])}, клики {int(r['Clicks'])}, конверсии {int(r['Conversions'])}")

# --- настройки кампаний: стратегии, минус-слова, исключения ---------------------
strat_rows = []
for svc, payload in (settings.get("strategies") or {}).items():
    if not isinstance(payload, dict):
        continue
    for key, items in payload.items():
        if key in ("error", "http_error", "transport_error") or not isinstance(items, list):
            continue
        for item in items:
            bs = item.get("BiddingStrategy") or {}
            strat_rows.append({"service": svc, "id": item.get("Id"), "name": item.get("Name"),
                               "strategy": bs, "counters": item.get("CounterIds"),
                               "attribution": item.get("AttributionModel"), "report_type": item.get("ReportType")})
out["strategies"] = strat_rows
print("\n=== стратегии ===")
for s in strat_rows:
    print(f"  {s['id']} | {str(s['name'])[:40]:40} | {json.dumps(s['strategy'], ensure_ascii=False)[:300]}"
          f" | counters={json.dumps(s['counters'], ensure_ascii=False)[:60]}")

camp_settings = []
for c in settings.get("campaigns") or []:
    neg = ((c.get("NegativeKeywords") or {}).get("Items") or [])
    excl = ((c.get("ExcludedSites") or {}).get("Items") or [])
    camp_settings.append({"id": c.get("Id"), "name": c.get("Name"), "type": c.get("Type"),
                          "state": c.get("State"), "status": c.get("Status"),
                          "daily_budget": c.get("DailyBudget"), "start": c.get("StartDate"),
                          "time_targeting": c.get("TimeTargeting"), "negative_count": len(neg),
                          "negative_sample": neg[:20], "excluded_count": len(excl), "excluded_sample": excl[:10],
                          "statistics": c.get("Statistics")})
out["campaign_settings"] = camp_settings
print("\n=== настройки кампаний (минус-слова, исключённые площадки, бюджет) ===")
for c in camp_settings:
    print(f"  {str(c['name'])[:44]:44} | {c['state']}/{c['status']} | бюджет {c['daily_budget']} | минус-слов {c['negative_count']}"
          f" | исключено площадок {c['excluded_count']} | статистика {json.dumps(c['statistics'], ensure_ascii=False)[:70]}")

# корректировки
mods = settings.get("bidmodifiers") or []
mod_rows = []
for m in mods:
    for level in (m.get("Levels") or []):
        mod_rows.append({"campaign": m.get("CampaignId"), "adgroup": m.get("AdGroupId"),
                         "level": level.get("Level"), "value": level.get("BidModifier"),
                         "type": level.get("Type")})
out["bidmodifiers"] = mod_rows
out["audience_targets"] = settings.get("audience_targets") or []
out["keywords"] = [{"id": k.get("Id"), "keyword": k.get("Keyword"), "campaign": k.get("CampaignId"),
                    "state": k.get("State"), "status": k.get("Status")} for k in (settings.get("keywords") or [])]
out["keywords_stats"] = {"total": len(out["keywords"]),
                         "active": sum(1 for k in out["keywords"] if k["state"] == "ON"),
                         "by_status": pd.Series([k["status"] for k in out["keywords"]]).value_counts().to_dict() if out["keywords"] else {}}
print(f"\nкорректировок: {len(mod_rows)} | аудиторий/ретаргетинг: {len(out['audience_targets'])} | "
      f"фраз: {out['keywords_stats']}")

(HERE / "direct-findings.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nсохранено: direct-findings.json")

# --- markdown-отчёт ------------------------------------------------------------
md: list[str] = []
md.append("# Аудит кабинета intel-denisov (Яндекс.Директ) — 2026-11-16")
md.append(f"\nПериод: 2026-08-19 … 2026-11-16 (90 дней). Источник: Яндекс.Директ API v5 (Reports, Campaigns.get, "
          f"TextCampaign.get), выгрузка 2026-11-16. Только чтение.\n")
md.append(f"* Расход: **{money(total_spend)}**, клики {total_clicks:,.0f}, показы {total_impr:,.0f}, "
          f"«конверсии» Директа {total_conv:,.0f}, CPA {money(total_spend / total_conv if total_conv else 0)}.".replace(",", " "))
md.append("\n## Кампании: расход → заказы → оплаты\n")
md.append("| Кампания | ID | Расход | Клики | Конв. Директа | CPA | Заказы CRM | Оплаты CRM | ₽/оплата | Отказы |")
md.append("|---|---|---|---|---|---|---|---|---|---|")
for c in camp_rows:
    md.append(f"| {c['name'][:52]} | {c['id']} | {money(c['spend'])} | {c['clicks']} | {c['conversions']} | "
              f"{money(c['cpa']) if c['cpa'] else '—'} | {c['crm_orders']} | {c['crm_paid']} | "
              f"{money(c['cost_per_paid']) if c['cost_per_paid'] else '—'} | {c['bounce']} |")
md.append("")
if "queries" in out:
    md.append("## Сливы: поисковые запросы\n")
    md.append(f"* Запросов в отчёте: {out['queries']['total']:,}. Расход ≥500 ₽ без конверсий: "
              f"**{out['queries']['no_conv_count']}** на **{money(out['queries']['no_conv_spend'])}**.".replace(",", " "))
    md.append(f"* Мусорные интенты: **{out['queries']['trash_count']}** на **{money(out['queries']['trash_spend'])}**.\n")
    md.append("| Запрос | Расход | Клики | Кампания |")
    md.append("|---|---|---|---|")
    for q_ in out["queries"]["no_conv_top"][:25]:
        md.append(f"| {q_[0]} | {money(q_[1])} | {q_[2]} | {q_[3]} |")
    md.append("")
if "placements" in out:
    md.append("## Сливы: площадки РСЯ\n")
    md.append(f"* Площадок: {out['placements']['total']:,}. С нулём конверсий и расходом ≥{money(MIN_SPEND)}: "
              f"**{out['placements']['bad_count']}** на **{money(out['placements']['bad_spend'])}** "
              f"({out['placements']['bad_share_pct']:.1f} % расхода).\n".replace(",", " "))
    md.append("| Площадка | Расход | Клики |")
    md.append("|---|---|---|")
    for p in out["placements"]["bad_top"][:25]:
        md.append(f"| {p[0]} | {money(p[1])} | {p[2]} |")
    md.append("")
md.append("## Что не удалось проверить\n")
md.append("* Офлайн-конверсии CRM → Метрика (выгрузка статусов сделок) — данных нет.")
md.append("* Wordstat (частотность) и Яндекс.Аудитории — доступы не подключены.")
md.append("* Выручка/маржинальность по заказам — данных нет, ДРР и ROMI не считаются в деньгах выручки.")

(HERE / "audit-direct-2026-11-16.md").write_text("\n".join(md) + "\n", encoding="utf-8")
print("сохранено: audit-direct-2026-11-16.md")
