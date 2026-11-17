# -*- coding: utf-8 -*-
"""Новые находки (каннибализация, бренд, каркасный спрос, разметка) → отчёт + дополнение summary."""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
J = lambda n: json.loads((HERE / n).read_text(encoding="utf-8"))  # noqa: E731

summary = J("summary.json")
d1, d2, d3, d4 = J("deep-review.json"), J("deep-review2.json"), J("deep-review3.json"), J("deep-review4.json")
money = lambda v: f"{float(v):,.0f}".replace(",", " ") + " ₽"  # noqa: E731
num = lambda v: f"{float(v):,.0f}".replace(",", " ")  # noqa: E731

by_id = {r["campaign_id"]: r for r in d1["by_campaign_id"]}
settings = J("direct-settings.json")
camp_names = {str(c.get("Id")): c.get("Name") for c in (settings.get("campaigns") or [])}
names_by_name = {c["name"]: c for c in summary["direct"]["campaigns"]}

visits_by_id = sum(r["visits"] for r in d1["by_campaign_id"])
ra = next(r for r in summary["metrika"]["sources_rows"] if r["source"].startswith("Ad"))
ad_visits = ra["visits"]
lost_ids = d2["id_diff"]["only_metrika"]
lost_visits = sum(by_id[i]["visits"] for i in lost_ids if i in by_id)
lost_orders = sum(by_id[i]["order"] for i in lost_ids if i in by_id)
lost_paid = sum(by_id[i]["paid"] for i in lost_ids if i in by_id)

deep = {
    "cannibalization": d3["cannibalization"],
    "cannibalization_by_campaign": d4["cannibalization_by_campaign"],
    "uncovered_demand": d3["uncovered"],
    "duplicate_keywords": d3["duplicate_keywords"],
    "keyword_shape": d3["keyword_shape"],
    "brand_minus_campaigns": d4["brand_minus"],
    "brand_queries_direct": d4["brand_queries"],
    "frame_demand": d4["frame_demand"],
    "lost_campaign_ids": {"ids": lost_ids, "visits": lost_visits, "orders": lost_orders, "paid": lost_paid,
                          "share_of_ad_traffic_pct": round(lost_visits / ad_visits * 100, 1)},
    "weekly": d2.get("weekly") or [],
    "ads_texts_available": bool(d2.get("ads_texts")),
    "visits_by_campaign_id": d1["by_campaign_id"],
}
summary["deep"] = deep
(HERE / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")

md: list[str] = []
md.append("# Углублённый разбор: каннибализация, бренд, незакрытый спрос, разметка")
md.append(f"\n**Дата:** 2026-11-16. **Период:** 19.08–16.11.2026. **Источники:** Директ Reports API "
          f"(SEARCH_QUERY, CRITERIA), Campaigns.get, Keywords.get, NegativeKeywords; Метрика stat/v1/data. Только чтение.\n")

md.append("## 1. Каннибализация: кампании конкурируют друг с другом\n")
md.append(f"* Запросов, которые показываются в **двух и более** кампаниях: **{num(d3['cannibalization']['count'])}** "
          f"({num(d3['cannibalization']['spend'])} ₽ расхода, 39 % бюджета).")
md.append("\n| Кампания | Расход по «общим» запросам | Таких запросов |")
md.append("|---|---|---|")
for row in d4["cannibalization_by_campaign"][:6]:
    md.append(f"| {str(row['CampaignName'])[:46]} | {money(row['cost'])} | {row['shared_queries']:.0f} |")
md.append("\nПримеры дублирования:\n")
md.append("| Запрос | В скольких кампаниях | Расход | Клики |")
md.append("|---|---|---|---|")
for q in d3["cannibalization"]["top"][:8]:
    md.append(f"| {q[0]} | {q[1]} | {money(q[2])} | {q[3]} |")
md.append("\n**Первый кандидат на минусацию:** запрос *«строительная компания»* — 104 689 ₽ расхода, 186 кликов "
          "и 82 «конверсии» Директа в товарной кампании (микроцели: скролл/время на сайте).\n")

md.append("## 2. Свой бренд в минус-словах\n")
md.append("В шести кампаниях в минус-словах стоит свой бренд, из-за чего брендовый спрос почти не получает показов:\n")
md.append("| Кампания | Минус-слов | Что минусуется |")
md.append("|---|---|---|")
for row in d4["brand_minus"]:
    md.append(f"| {str(row['campaign'])[:42]} | {row['neg_total']} | {', '.join(row['hits'][:3])} |")
md.append(f"\n* Брендовые запросы в отчёте Директа: {d4['brand_queries']['count']} запросов, "
          f"{d4['brand_queries']['clicks']} кликов, {money(d4['brand_queries']['spend'])}, "
          f"{d4['brand_queries']['conversions']:.0f} конверсии — то есть брендовый поиск в Директе практически не работает.")
md.append("* В Метрике брендовые запросы дают 350 визитов и 5 заказов (в т.ч. «интел групп строительная компания» — "
          "2 заказа и 2 оплаты), CR в заказ ≈ 1,4 % против 0,06 % по всему трафику.")
md.append("* **Вывод:** бренд нужно вынести в отдельную кампанию с точным соответствием, ставки снимать невысоко, "
          "чтобы не платить за органика, но и не терять дешёвый горячий спрос.\n")

md.append("## 3. Незакрытый спрос: каркасные дома\n")
md.append(f"* Запросов с расходом ≥200 ₽, не покрытых текущим ядром: **{d3['uncovered']['count']}** "
          f"на **{money(d3['uncovered']['spend'])}**.")
md.append(f"* Спрос по каркасу, дереву, СИП и модульным домам: **{num(d4['frame_demand']['count'])} запросов**, "
          f"{money(d4['frame_demand']['spend'])}, {d4['frame_demand']['conversions']:.0f} конверсий Директа — "
          f"ловятся автотаргетингом и товарной кампанией, отдельного ядра нет.")
md.append("\n| Запрос | Расход | Клики | Конв. Директа |")
md.append("|---|---|---|---|")
for q in d4["frame_demand"]["top"][:10]:
    md.append(f"| {q[0]} | {money(q[1])} | {q[2]} | {q[3]} |")
md.append("\n* На сайте есть страница `/catalog/karkasnye-doma/`: 513 визитов, 1 заказ, 4 звонка — "
          "CR в контакт 0,97 % против 0,17 % у страницы газобетона. Направление работает, но рекламой не поддержано.\n")

md.append("## 4. Разметка: 6 ID кампаний вне текущего кабинета\n")
md.append(f"* В Метрике визиты размечены по {len(d1['by_campaign_id'])} ID кампаний, в отчётах кабинета `intel-denisov` — 13.")
md.append(f"* ID, которых нет в отчётах кабинета: {', '.join(lost_ids)} — "
          f"это **{num(lost_visits)} визитов ({deep['lost_campaign_ids']['share_of_ad_traffic_pct']:.1f} % рекламного трафика)**, "
          f"{lost_orders:.0f} заказ(ов), {lost_paid:.0f} оплат(ы). Расход по ним в кабинете отсутствует.")
md.append("* Среди этих ID — источник `ay_direct` (6 885 визитов, опечатка в UTM): часть трафика приходит из другой "
          "системы или из другого кабинета, и его расход не учитывается в текущей экономике.\n")
md.append("## 5. Структура фраз\n")
md.append(f"* Фраз: {num(d3['keyword_shape']['total'])}; групп-дублей (по составу слов): **{num(d3['duplicate_keywords']['groups'])}**; "
          f"в кавычках — {d3['keyword_shape']['quoted']}, в точном соответствии — {d3['keyword_shape']['exact']}, "
          f"с минус-словами внутри фразы — {num(d3['keyword_shape']['with_inline_minus'])}.")
md.append("* Средняя длина фразы — {:.0f} символов: длинные «простыни» с внутренними минусами плохо управляемы, "
          "их место — минус-лист кампании, а не тело фразы.\n".format(d3["keyword_shape"]["avg_len"]))
md.append("## 6. Что делать по этим находкам\n")
md.append("1. Дедуплицировать ядро и развести интенты по кампаниям: 1 053 294 ₽ расхода идёт по запросам, "
          "которые «тянут» несколько кампаний сразу.")
md.append("2. Создать брендовую кампанию; из минус-слов шести кампаний убрать «Интел», «интел групп», «интелгрупп».")
md.append("3. Собрать отдельное ядро и кампании под каркасные/деревянные/СИП/модульные дома — спрос уже приходит "
          "(107 784 ₽ расхода) и конвертит лучше газобетона.")
md.append("4. Найти источник трафика по 6 «потерянным» ID кампаний и привести разметку к одному кабинету.")
md.append("5. Разобрать 949 групп фраз-дублей и вынести внутренние минус-слова в минус-лист кампании.")

(HERE / "audit-deep-findings-2026-11-16.md").write_text("\n".join(md) + "\n", encoding="utf-8")
print("записано: audit-deep-findings-2026-11-16.md")
print("каннибализация:", d3["cannibalization"]["count"], "запросов,", money(d3["cannibalization"]["spend"]))
print("утерянные ID:", lost_visits, "визитов,", deep["lost_campaign_ids"]["share_of_ad_traffic_pct"], "%")
print("каркасный спрос:", money(d4["frame_demand"]["spend"]), "| бренд в минусах:", len(d4["brand_minus"]), "кампаний")
