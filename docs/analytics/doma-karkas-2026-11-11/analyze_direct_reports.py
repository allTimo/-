# -*- coding: utf-8 -*-
"""Анализ отчётов Директа: сливы бюджета и точки роста.

Вход: direct-report-*.tsv (Reports API, 90 дней, кабинет intel-denisov) + CSV кабинета.
Выход: audit-direct-findings.md, audit-direct-findings.xlsx.
Только чтение.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
CSV_PATH = Path(r"C:\Users\Артем\Downloads\2026-11-11_21-24-23_intel-denisov.csv")
MIN_SPEND = 3000.0          # порог расхода для кандидатов на отключение/минусацию
TRASH = re.compile(r"аренд|снять|работа|ваканс|резюме|отзыв|фото|своими руками|чертеж|чертёж|бесплатн|"
                   r"б/у|бу |вторичк|ремонт|обои|жкх|схема|гост|снип|расчет|калькулятор|скачать|"
                   r"как |что |почему |чем |какой |сколько стоит|цена за куб|своими", re.IGNORECASE)


def load(name: str) -> pd.DataFrame:
    path = HERE / f"direct-report-{name}.tsv"
    frame = pd.read_csv(path, sep="\t", skiprows=1, dtype=str, quoting=3, engine="python")
    frame.columns = [c.strip().strip('"') for c in frame.columns]
    for col in ("Impressions", "Clicks", "Cost", "Conversions", "Ctr", "AvgCpc", "ConversionRate", "CostPerConversion"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce").fillna(0.0)
    # Reports Директа отдаёт деньги в микроединицах (1 ₽ = 1 000 000): приводим к рублям.
    for col in ("Cost", "AvgCpc", "CostPerConversion"):
        if col in frame.columns:
            frame[col] = frame[col] / 1_000_000.0
    # отбрасываем итоговые строки
    for col in frame.columns:
        if frame[col].dtype == object:
            frame = frame[~frame[col].astype(str).str.startswith("Total rows")]
    return frame


def money(value) -> str:
    return f"{value:,.0f}".replace(",", " ") + " ₽"


campaigns = load("campaigns")
queries = load("search_queries")
placements = load("placements")
criteria = load("criteria")

md: list[str] = []
xl: list[tuple[str, list[str], list[list]]] = []
md.append("# Аудит Директа по отчётам API: сливы и точки роста (doma-karkas.ru / intel-denisov)")
md.append("\nПериод: 2026-08-14 … 2026-11-11 (90 дней). Источник — Яндекс.Директ Reports API "
          "(CAMPAIGN/SEARCH_QUERY/CRITERIA/CUSTOM по площадкам), только чтение.\n")

# --- 1. Кампании
cabinet = {}
with CSV_PATH.open(encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        cid = (row.get("№ Кампании") or "").strip()
        if cid:
            cabinet[cid] = float(str(row.get("Расход, ₽") or "0").replace(" ", "") or 0)

total_spend = float(campaigns["Cost"].sum())
total_clicks = float(campaigns["Clicks"].sum())
total_conv = float(campaigns["Conversions"].sum())
md.append("## 1. Кампании (отчёт API против выгрузки кабинета)\n")
md.append(f"* Расход по API: **{money(total_spend)}**, клики {int(total_clicks):,}, конверсии {int(total_conv):,}."
          .replace(",", " "))
md.append(f"* Расход в выгрузке кабинета: {money(sum(cabinet.values()))} — "
          f"{'совпадает' if abs(sum(cabinet.values()) - total_spend) < 100 else 'расходится, уточнить'}.\n")
camp_rows = []
for _, row in campaigns.sort_values("Cost", ascending=False).iterrows():
    cid = str(row.get("CampaignId"))
    camp_rows.append([str(row.get("CampaignName"))[:60], cid, round(float(row["Cost"]), 2), int(row["Clicks"]),
                      int(row["Conversions"]), round(float(row["CostPerConversion"]), 2)])
md.append("| Кампания | ID | Расход | Клики | Конверсии | CPA |")
md.append("|---|---|---|---|---|---|")
for r in camp_rows:
    md.append(f"| {r[0]} | {r[1]} | {money(r[2])} | {r[3]} | {r[4]} | {money(r[5])} |")
md.append("")
xl.append(("Кампании", ["Кампания", "ID", "Расход, ₽", "Клики", "Конверсии", "CPA, ₽"], camp_rows))

# --- 2. Площадки РСЯ
md.append("## 2. Площадки РСЯ: где расход без конверсий\n")
bad_pl = placements[(placements["Cost"] >= MIN_SPEND) & (placements["Conversions"] == 0)].sort_values("Cost", ascending=False)
md.append(f"Площадок всего: {len(placements)}. С расходом ≥ {money(MIN_SPEND)} и **нулём конверсий**: "
          f"**{len(bad_pl)}** на сумму **{money(float(bad_pl['Cost'].sum()))}** "
          f"({float(bad_pl['Cost'].sum()) / max(total_spend, 1) * 100:.1f} % расхода).\n")
md.append("| Площадка | Расход | Клики | Конверсии |")
md.append("|---|---|---|---|")
pl_rows = []
for _, row in bad_pl.head(30).iterrows():
    name = str(row.get("Placement"))[:70]
    md.append(f"| {name} | {money(float(row['Cost']))} | {int(row['Clicks'])} | 0 |")
    pl_rows.append([name, round(float(row["Cost"]), 2), int(row["Clicks"]), 0])
md.append("")
xl.append(("Площадки без конверсий", ["Площадка", "Расход, ₽", "Клики", "Конверсии"], pl_rows))
top_pl = placements.sort_values("Cost", ascending=False).head(20)
xl.append(("Топ площадок", ["Площадка", "Расход, ₽", "Клики", "Конверсии", "CPA, ₽"],
           [[str(r["Placement"])[:70], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Conversions"]),
             round(float(r["Cost"]) / float(r["Conversions"]), 2) if float(r["Conversions"]) else None]
            for _, r in top_pl.iterrows()]))

# --- 3. Поисковые запросы
md.append("## 3. Поисковые запросы: кандидаты в минус-слова\n")
spend_q = queries[(queries["Cost"] >= 500) & (queries["Conversions"] == 0)].sort_values("Cost", ascending=False)
trash_q = queries[(queries["Cost"] >= 100) & (queries["Query"].astype(str).str.contains(TRASH))].sort_values("Cost", ascending=False)
md.append(f"* Всего запросов: {len(queries):,}. С расходом ≥ 500 ₽ и без конверсий: **{len(spend_q)}** "
          f"на **{money(float(spend_q['Cost'].sum()))}**.".replace(",", " "))
md.append(f"* Запросы с «мусорными» интентами (аренда, своими руками, чертёж, отзывы и т. п.): "
          f"**{len(trash_q)}** на **{money(float(trash_q['Cost'].sum()))}** — почти гарантированный минус-лист.\n")
md.append("| Запрос | Расход | Клики |")
md.append("|---|---|---|")
q_rows = []
for _, row in spend_q.head(30).iterrows():
    q = str(row["Query"])[:70]
    md.append(f"| {q} | {money(float(row['Cost']))} | {int(row['Clicks'])} |")
    q_rows.append([q, round(float(row["Cost"]), 2), int(row["Clicks"])])
md.append("")
xl.append(("Запросы без конверсий", ["Запрос", "Расход, ₽", "Клики"], q_rows))
xl.append(("Мусорные запросы", ["Запрос", "Расход, ₽", "Клики", "Показы"],
           [[str(r["Query"])[:70], round(float(r["Cost"]), 2), int(r["Clicks"]), int(r["Impressions"])]
            for _, r in trash_q.head(100).iterrows()]))

# --- 4. Ключевые фразы
md.append("## 4. Ключевые фразы: дорогие без конверсий\n")
bad_crit = criteria[(criteria["Cost"] >= MIN_SPEND) & (criteria["Conversions"] == 0)].sort_values("Cost", ascending=False)
md.append(f"Фраз всего: {len(criteria):,}. С расходом ≥ {money(MIN_SPEND)} и нулём конверсий: **{len(bad_crit)}** "
          f"на **{money(float(bad_crit['Cost'].sum()))}**.\n".replace(",", " "))
md.append("| Фраза | Тип | Расход | Клики |")
md.append("|---|---|---|---|")
cr_rows = []
for _, row in bad_crit.head(30).iterrows():
    c = str(row.get("Criterion"))[:70]
    md.append(f"| {c} | {row.get('CriterionType')} | {money(float(row['Cost']))} | {int(row['Clicks'])} |")
    cr_rows.append([c, str(row.get("CriterionType")), round(float(row["Cost"]), 2), int(row["Clicks"])])
md.append("")
xl.append(("Фразы без конверсий", ["Фраза", "Тип", "Расход, ₽", "Клики"], cr_rows))

# --- 5. Итог резервов
reserve_pl = float(bad_pl["Cost"].sum())
reserve_q = float(spend_q["Cost"].sum())
reserve_cr = float(bad_crit["Cost"].sum())
md.append("## 5. Резюме резервов\n")
md.append("| Источник слива | Сумма за 90 дней |")
md.append("|---|---|")
md.append(f"| Площадки РСЯ с расходом ≥ {money(MIN_SPEND)} и 0 конверсий | {money(reserve_pl)} |")
md.append(f"| Поисковые запросы с расходом ≥ 500 ₽ и 0 конверсий | {money(reserve_q)} |")
md.append(f"| Ключевые фразы с расходом ≥ {money(MIN_SPEND)} и 0 конверсий | {money(reserve_cr)} |")
md.append("")
md.append("Суммы пересекаются (запрос входит в фразу, фраза — в кампанию), поэтому это не «сложить и сэкономить», "
          "а три угла зрения на один и тот же бюджет. Порядок действий — сначала площадки и минус-слова, потом ставки.\n")

(HERE / "audit-direct-findings.md").write_text("\n".join(md) + "\n", encoding="utf-8")

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)
    for sheet, headers, body in xl:
        ws = wb.create_sheet(title=sheet[:31])
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in body:
            ws.append(row)
        for column in ws.columns:
            width = max(len(str(c.value or "")) for c in column) + 2
            ws.column_dimensions[column[0].column_letter].width = min(width, 55)
    wb.save(HERE / "audit-direct-findings.xlsx")
    print("xlsx ок")
except Exception as exc:  # noqa: BLE001
    print("xlsx не создан:", type(exc).__name__, exc)

print(f"кампаний: {len(campaigns)}, запросов: {len(queries)}, площадок: {len(placements)}, фраз: {len(criteria)}")
print(f"расход: {total_spend:,.0f} | площадки 0 конв: {reserve_pl:,.0f} | запросы 0 конв: {reserve_q:,.0f} | фразы 0 конв: {reserve_cr:,.0f}")
print(f"мусорные запросы: {len(trash_q)} на {float(trash_q['Cost'].sum()):,.0f}")
