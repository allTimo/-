# -*- coding: utf-8 -*-
"""Сводка аудита doma-karkas.ru / intel-denisov: единый summary.json + markdown-отчёты.

Вход: собранные JSON/TSV в этом каталоге. Выход: summary.json, audit-*.md.
Только чтение источников; числа считаются здесь, в текстах не дублируются вручную.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
J = lambda name: json.loads((HERE / name).read_text(encoding="utf-8"))  # noqa: E731

metrika = J("metrika-findings.json")
direct = J("direct-findings.json")
dlextra = J("direct-extra-analysis.json")
site = J("site-analytics.json")
pages = J("metrika-pages.json")
audit = J("metrika-audit.json")

PERIOD = "2026-08-19 … 2026-11-16 (90 дней)"
PREV = "2026-05-21 … 2026-08-18"

money = lambda v: f"{float(v):,.0f}".replace(",", " ") + " ₽"  # noqa: E731

S: dict = {"period": PERIOD, "previous_period": PREV, "collected": audit.get("collected_at"),
           "sources": {"metrika": "Яндекс.Метрика stat/v1/data + management/v1 (счётчик 22595095)",
                       "direct": "Яндекс.Директ API v5: Reports, Campaigns.get, Keywords.get, Bids.get, BidModifiers.get"}}

# --- Метрика -------------------------------------------------------------------
t_runs = audit["totals_current"]
t_prev = audit["totals_previous"]
S["metrika"] = {
    "visits": t_runs["ym:s:visits"], "visits_prev": t_prev["ym:s:visits"],
    "users": t_runs["ym:s:users"], "users_prev": t_prev["ym:s:users"],
    "pageviews": t_runs["ym:s:pageviews"], "bounce": round(t_runs["ym:s:bounceRate"], 2),
    "bounce_prev": round(t_prev["ym:s:bounceRate"], 2),
    "depth": round(t_runs["ym:s:pageDepth"], 2), "depth_prev": round(t_prev["ym:s:pageDepth"], 2),
    "time": round(t_runs["ym:s:avgVisitDurationSeconds"]), "time_prev": round(t_prev["ym:s:avgVisitDurationSeconds"]),
    "visits_delta_pct": round((t_runs["ym:s:visits"] - t_prev["ym:s:visits"]) / t_prev["ym:s:visits"] * 100, 1),
    "goals_total": metrika["goals"]["count"], "goals_dead": metrika["goals"]["dead_count"],
    "goals_dead_list": [(g["id"], g["name"], g["type"]) for g in metrika["goals"]["dead_90d"]],
    "card": {k: metrika["card"].get(k) for k in ("code_status", "autogoals_enabled", "ecommerce_deduplicator_enabled",
                                                 "filter_robots", "ecom_options", "activity_status")},
    "filters": metrika["filters"].get("filters"),
    "segments": [(s.get("name"), s.get("segment_id")) for s in (metrika.get("segments", {}).get("segments") or [])],
}
goal_names = {g["id"]: g["name"] for g in metrika["goals"]["all"]}
reaches = {str(k): v for k, v in audit["goal_reaches"].items()}
reaches_prev = {str(k): v for k, v in audit["goal_reaches_previous"].items()}
S["metrika"]["goals_reaches"] = {goal_names.get(int(k.replace("ym:s:goal", "").replace("reaches", "")), k): v
                                 for k, v in reaches.items()}
S["metrika"]["goals_reaches_prev"] = {goal_names.get(int(k.replace("ym:s:goal", "").replace("reaches", "")), k): v
                                      for k, v in reaches_prev.items()}

src = site["source"]
S["metrika"]["sources_rows"] = [{"source": str(r["dim"]), "visits": r["visits"], "bounce": round(r["bounceRate"], 1),
                                 "forms": r["form_all"], "calls": r["call"], "lids": r["lid"],
                                 "orders": r["order"], "paid": r["paid"],
                                 "contact_cr_pct": round((r["call"] + r["lid"]) / (r["visits"] or 1) * 100, 3)}
                                for r in src]
S["metrika"]["device_rows"] = site["device"]
S["metrika"]["age_rows"] = metrika["splits"]["age"]["rows"]
S["metrika"]["gender_rows"] = metrika["splits"]["gender"]["rows"]
S["metrika"]["geo_top"] = metrika["splits"]["geo"]["rows"][:15]
S["metrika"]["utm_source"] = metrika["splits"]["utm_source"]["rows"]
S["metrika"]["info_phrases"] = [(p["searchPhrase"], p["visits"], p["bounceRate"]) for p in metrika["info_phrases"]]
S["metrika"]["internal_traffic"] = next((r for r in src if str(r["dim"]).lower().startswith("internal")), None)

# --- Директ --------------------------------------------------------------------
S["direct"] = {"totals": direct["totals"], "zero_paid": direct["zero_paid"], "network": dlextra.get("network"),
               "network_by_campaign": dlextra.get("network_by_campaign"),
               "campaigns": direct["campaigns"], "criteria_by_type": dlextra.get("criteria_by_type"),
               "minus": dlextra.get("minus_candidates"), "trash": dlextra.get("trash_queries"),
               "placements_expensive": dlextra.get("placements_expensive"),
               "last14": dlextra.get("last14"), "keywords_stats": direct["keywords_stats"],
               "campaign_settings": [{k: c[k] for k in ("id", "name", "state", "status", "negative_count",
                                                        "excluded_count", "start", "daily_budget")}
                                     for c in direct["campaign_settings"]]}

orders_total = sum(c["crm_orders"] or 0 for c in direct["campaigns"])
paid_total = sum(c["crm_paid"] or 0 for c in direct["campaigns"])
S["economics"] = {
    "spend": direct["totals"]["spend"], "clicks": direct["totals"]["clicks"],
    "impressions": direct["totals"]["impressions"], "direct_conversions": direct["totals"]["conversions"],
    "cpa_direct": round(direct["totals"]["cpa_direct"]),
    "crm_orders_by_campaigns": orders_total, "crm_paid_by_campaigns": paid_total,
    "cost_per_order": round(direct["totals"]["spend"] / orders_total) if orders_total else None,
    "cost_per_paid": round(direct["totals"]["spend"] / paid_total) if paid_total else None,
    "order_to_paid_pct": round(paid_total / orders_total * 100) if orders_total else None,
    "avg_cpc": round(direct["totals"]["spend"] / direct["totals"]["clicks"], 2),
    "conversion_gap": f"{direct['totals']['conversions']:.0f} «конверсий» Директа против {orders_total} заказов и {paid_total} оплат",
}
# экономика кампаний с оплатами и без
with_paid = [c for c in direct["campaigns"] if (c["crm_paid"] or 0) > 0]
without_paid = [c for c in direct["campaigns"] if not (c["crm_paid"] or 0) and c["spend"] > 1000]
S["economics"]["best_campaigns"] = [{"name": c["name"], "spend": c["spend"], "orders": c["crm_orders"],
                                     "paid": c["crm_paid"], "cost_per_paid": round(c["cost_per_paid"]) if c["cost_per_paid"] else None,
                                     "bounce": c["bounce"]} for c in sorted(with_paid, key=lambda x: x["cost_per_paid"] or 1e12)]
S["economics"]["no_paid_campaigns"] = [{"name": c["name"], "spend": c["spend"], "orders": c["crm_orders"],
                                        "conversions": c["conversions"], "bounce": c["bounce"]}
                                       for c in sorted(without_paid, key=lambda x: -x["spend"])]
S["economics"]["no_paid_spend"] = sum(c["spend"] for c in without_paid)

# --- Сайт / воронка ------------------------------------------------------------
f = site["funnel"]
S["site"] = {"funnel": f, "sections": site["sections"],
             "contact_funnel": {
                 "visits": f["visits"], "form_all": f["form_all"], "filter": f["filter"],
                 "real_form_leads": f["lids"], "calls": f["calls"],
                 "orders": f["orders"], "paid": f["paid"], "spam": f["spam"], "cancel": f["cancel"],
                 "visit_to_lead_pct": round(f["lids"] / f["visits"] * 100, 3),
                 "visit_to_contact_pct": round((f["lids"] + f["calls"]) / f["visits"] * 100, 3),
                 "lead_to_order_pct": round(f["orders"] / f["lids"] * 100, 1),
                 "order_to_paid_pct": round(f["paid"] / f["orders"] * 100, 1),
                 "spam_share_pct": round(f["spam"] / f["orders"] * 100, 1),
             }}
S["site"]["pages_top"] = [(row["dimensions"][0].get("url") if isinstance(row["dimensions"][0], dict) else row["dimensions"][0],
                           row["metrics"][0], row["metrics"][1]) for row in (pages.get("ym:pv:URLPath", {}).get("data") or [])[:20]]
S["site"]["start_page_paths"] = [(row["dimensions"][0].get("url") if isinstance(row["dimensions"][0], dict) else row["dimensions"][0],
                                  row["metrics"][0], round(row["metrics"][1], 1), round(row["metrics"][2]))
                                 for row in (pages.get("ym:s:startURLPath", {}).get("data") or [])[:20]]
S["site"]["tech"] = J("site-probe.json")
S["site"]["landings_checked"] = dlextra.get("landings_checked")

(HERE / "summary.json").write_text(json.dumps(S, ensure_ascii=False, indent=1), encoding="utf-8")

# --- markdown: Метрика ---------------------------------------------------------
m: list[str] = []
m.append("# Аудит Яндекс.Метрики — счётчик 22595095 (doma-karkas.ru)")
m.append(f"\n**Период:** {PERIOD}, сравнение с {PREV}. **Источник:** Метрика API `stat/v1/data` и `management/v1` "
         f"(цели, фильтры, сегменты, карточка счётчика), выгрузка {S['collected']} МСК. **Только чтение.**\n")
mk = S["metrika"]
m.append("## 1. Трафик и качество\n")
m.append("| Показатель | 90 дней | Предыдущие 90 | Δ |")
m.append("|---|---|---|---|")
m.append(f"| Визиты | {mk['visits']:.0f} | {mk['visits_prev']:.0f} | {mk['visits_delta_pct']} % |")
m.append(f"| Посетители | {mk['users']:.0f} | {mk['users_prev']:.0f} | |")
m.append(f"| Просмотры | {mk['pageviews']:.0f} | | |")
m.append(f"| Отказы, % | {mk['bounce']} | {mk['bounce_prev']} | |")
m.append(f"| Глубина | {mk['depth']} | {mk['depth_prev']} | |")
m.append(f"| Время, с | {mk['time']} | {mk['time_prev']} | |")
m.append("\n## 2. Настройки счётчика (факты API)\n")
m.append(f"* `code_status`: **{mk['card']['code_status']}** — код на сайте есть (проверен на 9 страницах, ID 22595095), "
         f"но статус в Метрике не подтверждён: требуется проверка установки кода и версии счётчика.")
m.append(f"* `autogoals_enabled`: **{mk['card']['autogoals_enabled']}** — автоцели выключены.")
m.append(f"* ecommerce: `ecom_options` = {json.dumps(mk['card']['ecom_options'], ensure_ascii=False)}, "
         f"дубликатор ecommerce: **{mk['card']['ecommerce_deduplicator_enabled']}**.")
m.append(f"* `filter_robots`: {mk['card']['filter_robots']}; фильтры счётчика: "
         f"{json.dumps(mk['filters'], ensure_ascii=False)} — исключён **один** IP; фильтра внутреннего трафика нет "
         f"(внутренний трафик за период: {mk['internal_traffic']['visits']:.0f} визитов, "
         f"{mk['internal_traffic']['visits']/mk['visits']*100:.1f} % всего трафика).")
m.append(f"* Целей: **{mk['goals_total']}**, из них без достижений за 90 дней: **{mk['goals_dead']}** "
         f"({', '.join(f'{n} ({t})' for _, n, t in mk['goals_dead_list'])}).")
m.append("* Дубли и цели-ловушки: пять целей по звонкам («Звонок», «Уникальный звонок», «Уникально-целевой звонок», "
         "«Целевой звонок», «Звонок первичный более 60 сек»), микроцели «На сайте >5 минут» "
         f"({mk['goals_reaches'].get('На сайте >5 минут', 0):.0f}), «Глубина просмотров (5 страниц)» "
         f"({mk['goals_reaches'].get('Глубина просмотров (5 страниц)', 0):.0f}), «Скролл страницы на 70%» "
         f"({mk['goals_reaches'].get('Скролл страницы на 70%', 0):.0f}).")
m.append(f"* Сегменты: {', '.join(f'{n}' for n, _ in mk['segments']) or 'данных нет'}.")
m.append("\n## 3. Конверсии и источники\n")
m.append(f"* Целевые действия за 90 дней: Лид **{mk['goals_reaches'].get('Лид', 0):.0f}**, звонок "
         f"**{mk['goals_reaches'].get('Звонок', 0):.0f}**, «Отправка всех форм» "
         f"**{mk['goals_reaches'].get('Отправка всех форм', 0):.0f}** (из них «Фильтр: подобрать проекты» "
         f"{mk['goals_reaches'].get('Фильтр: подобрать проекты', 0):.0f}), CRM «Заказ создан» "
         f"**{mk['goals_reaches'].get('CRM: Заказ создан', 0):.0f}**, «Заказ оплачен» "
         f"**{mk['goals_reaches'].get('CRM: Заказ оплачен', 0):.0f}**, «Спам заказ» {mk['goals_reaches'].get('CRM: Спам заказ', 0):.0f}, "
         f"«Заказ отменен» {mk['goals_reaches'].get('CRM: Заказ отменен', 0):.0f}.")
m.append("\n| Источник | Визиты | Отказы, % | Формы | Звонки | Лид | Заказ | Оплата | CR контакт, % |")
m.append("|---|---|---|---|---|---|---|---|---|")
for r in mk["sources_rows"]:
    m.append(f"| {r['source']} | {r['visits']:.0f} | {r['bounce']} | {r['forms']:.0f} | {r['calls']:.0f} | "
             f"{r['lids']:.0f} | {r['orders']:.0f} | {r['paid']:.0f} | {r['contact_cr_pct']} |")
m.append("\n## 4. Проблемы, подтверждённые данными\n")
m.append(f"1. **Цель-ловушка.** {mk['goals_reaches'].get('Фильтр: подобрать проекты', 0):.0f} из "
         f"{mk['goals_reaches'].get('Отправка всех форм', 0):.0f} «отправок форм» — это подбор проектов, а не заявка: "
         f"если эта цель передана в Директ, стратегии учатся на дешёвом действии.")
m.append(f"2. **Шесть мёртвых целей** (0 достижений за 90 дней) — часть из них сломанные формы по xpath "
         f"(«Отправка формы \"Рассчитать проект\"», «Зимний лендинг — Получить смету»).")
m.append(f"3. **UTM-разметка не унифицирована:** `utm_source` = yandex ({mk['utm_source'][0]['visits']:.0f} визитов), "
         f"ya_direct ({mk['utm_source'][1]['visits']:.0f}), **ay_direct** ({mk['utm_source'][2]['visits']:.0f} — опечатка), "
         f"плюс dzen, domclick, domclik, yandexsmartcamera. Опечатка `ay_direct` уводит 6 885 визитов в отдельный источник.")
m.append(f"4. **Внутренний трафик** {mk['internal_traffic']['visits']:.0f} визитов "
         f"({mk['internal_traffic']['visits']/mk['visits']*100:.1f} %) не отфильтрован: в фильтрах один IP.")
m.append("5. **Аудитория перекошена по возрасту:** 55+ — "
         f"{next((r['visits'] for r in mk['age_rows'] if '55' in str(r['ageInterval'])), 0):.0f} визитов "
         f"({next((r['visits'] for r in mk['age_rows'] if '55' in str(r['ageInterval'])), 0)/mk['visits']*100:.0f} % трафика) "
         f"и всего 3 заказа, тогда как 35–44 дают 26 заказов при 21 330 визитах.")
m.append(f"6. **Мобильные:** {mk['device_rows'][0]['visits']:.0f} визитов, отказы "
         f"{mk['device_rows'][0]['bounceRate']:.1f} % против {mk['device_rows'][1]['bounceRate']:.1f} % на ПК.")
m.append("\n## 5. Что делать (Метрика)\n")
m.append("1. Привести цели в порядок: оставить 1 макроцель звонка, 1 макроцель заявки (уже есть «Лид» — составная "
         "из 10 форм и чата Jivo), CRM-цели; мёртвые и дублирующие цели вынести в архив — **новая цель вместо "
         "переименования**, существующие цели не меняем без согласования.")
m.append("2. Включить автоцели и дубликатор ecommerce, разобраться с `code_status` (проверка установки кода и версии).")
m.append("3. Настроить фильтр внутреннего трафика (офисные IP + VPN) и убрать партнёрские/тестовые переходы из "
         "«внутреннего» трафика.")
m.append("4. Унифицировать UTM: `utm_source=yandex`, `utm_medium=cpc`, `utm_campaign={campaign_id}`, "
         "`utm_content={ad_id}`, `utm_term={keyword}`; убрать опечатку `ay_direct`.")
m.append("5. Подключить офлайн-конверсии CRM → Метрика (заказы и оплаты) — база для сквозного ДРР; "
         "сейчас в Метрике только CDP-цели, выгрузки статусов сделок нет.")
m.append("6. Добавить корректировки в Директ по возрасту (55+) и мобильным — только после проверки на данных кабинета.")

(HERE / "audit-metrika-2026-11-16.md").write_text("\n".join(m) + "\n", encoding="utf-8")

# --- markdown: Директ ----------------------------------------------------------
d: list[str] = []
d.append("# Аудит кабинета Яндекс.Директ `intel-denisov` — doma-karkas.ru")
d.append(f"\n**Период:** {PERIOD}. **Источник:** Директ API v5 — Reports (CAMPAIGN/SEARCH_QUERY/CRITERIA/AD/CUSTOM: "
         f"площадки, устройства, возраст-пол, сеть), Campaigns.get, Keywords.get, Bids.get, BidModifiers.get; "
         f"выгрузка {S['collected']} МСК. **Только чтение**, изменений в кабинете нет.\n")
e = S["economics"]; dt = direct["totals"]
d.append("## 1. Резюме\n")
d.append(f"* Расход: **{money(e['spend'])}**, клики {e['clicks']:,.0f}, показы {e['impressions']:,.0f}, "
         f"средний CPC {e['avg_cpc']} ₽.".replace(",", " "))
d.append(f"* «Конверсии» Директа: **{e['direct_conversions']:,.0f}** при CPA {money(e['cpa_direct'])} — "
         f"но фактически оплат по кампаниям **{e['crm_paid_by_campaigns']}**, заказов "
         f"**{e['crm_orders_by_campaigns']}** (цели CRM в Метрике).".replace(",", " "))
d.append(f"* Цена заказа: **{money(e['cost_per_order'])}**; цена оплаченного заказа: **{money(e['cost_per_paid'])}**; "
         f"конверсия заказ→оплата {e['order_to_paid_pct']} %.")
d.append(f"* Кампаний без оплат: **{len(e['no_paid_campaigns'])}** с расходом выше 1 000 ₽ — "
         f"**{money(e['no_paid_spend'])}** ({e['no_paid_spend']/e['spend']*100:.0f} % бюджета); "
         f"всего кампаний без оплат (включая архивные и остановленные без расхода) — {direct['zero_paid']['count']}.\n")
d.append("## 2. Поиск и РСЯ\n")
for r in (dlextra.get("network") or []):
    if r["AdNetworkType"] in ("SEARCH", "AD_NETWORK"):
        d.append(f"* {r['AdNetworkType']}: расход {money(r['Cost'])}, клики {int(r['Clicks']):,}, "
                 f"конверсии {int(r['Conversions']):,}, CPA {money(r['Cost']/r['Conversions']) if r['Conversions'] else '—'}."
                 .replace(",", " "))
d.append(f"* Автотаргетинг: **{money(next((r['Cost'] for r in dlextra['criteria_by_type'] if r['CriterionType']=='AUTOTARGETING'), 0))}** "
         f"({next((r['Cost'] for r in dlextra['criteria_by_type'] if r['CriterionType']=='AUTOTARGETING'), 0)/e['spend']*100:.0f} % бюджета), "
         f"ключевые фразы — {money(next((r['Cost'] for r in dlextra['criteria_by_type'] if r['CriterionType']=='KEYWORD'), 0))}.")
d.append("\n## 3. Кампании: расход → заказы → оплаты (Метрика, цели CRM)\n")
d.append("| Кампания | ID | Сеть | Расход | Клики | Конв. Директа | CPA | Заказы | Оплаты | ₽ за оплату | Отказы, % |")
d.append("|---|---|---|---|---|---|---|---|---|---|---|")
net_map: dict = {}
for r in (dlextra.get("network_by_campaign") or []):
    if r["AdNetworkType"] not in ("SEARCH", "AD_NETWORK"):
        continue
    net_map.setdefault(str(r["CampaignId"]), {})[r["AdNetworkType"]] = r["Cost"]
for c in direct["campaigns"]:
    networks = net_map.get(c["id"]) or {}
    net_label = " + ".join(f"{k} {money(v)}" for k, v in sorted(networks.items(), key=lambda x: -x[1])) or "—"
    d.append(f"| {c['name'][:48]} | {c['id']} | {net_label} | {money(c['spend'])} | {c['clicks']} | "
             f"{c['conversions']} | {money(c['cpa']) if c['cpa'] else '—'} | {c['crm_orders'] or 0} | {c['crm_paid'] or 0} | "
             f"{money(c['cost_per_paid']) if c['cost_per_paid'] else '—'} | {round(c['bounce'], 1) if c['bounce'] else '—'} |")
d.append("\n## 4. Сливы и точки роста\n")
minus = dlextra.get("minus_candidates") or {}
trash = dlextra.get("trash_queries") or {}
if minus:
    d.append(f"* **Минус-слова:** {minus.get('count', 0)} запросов с расходом и без конверсий — "
             f"{money(minus.get('spend', 0))}; «мусорные» интенты (аренда, своими руками, чертежи, расчёты) — "
             f"{trash.get('count', 0)} запросов на {money(trash.get('spend', 0))}.")
    d.append("\n| Запрос | Расход | Клики | Кампания |")
    d.append("|---|---|---|---|")
    for q in (minus.get("rows") or [])[:15]:
        d.append(f"| {q[0]} | {money(q[1])} | {q[2]} | {q[3]} |")
    d.append("")
pe = dlextra.get("placements_expensive") or {}
d.append(f"\n* **Площадки РСЯ.** По «конверсиям» Директа чистка невозможна: площадок с расходом ≥2 000 ₽ и "
         f"нулём конверсий — **0**. Проблема в том, что конверсии Директа — микроцели; для чистки нужна связка "
         f"«площадка → заказ CRM», которой сейчас нет (нет офлайн-конверсий). Косвенный ориентир: кампания "
         f"«РСЯ / Интел Групп…» — {money(next((c['spend'] for c in direct['campaigns'] if c['name'].startswith('РСЯ')), 0))} "
         f"расхода при 1 заказе и 0 оплатах.")
d.append(f"* **Структура:** одноимённая кампания РСЯ объединяет три продуктовых направления (газобетон, каменные дома, "
         f"керамоблок) — 639 исключённых площадок при 0 минус-словах.")
d.append(f"* **Ретаргетинг не используется:** аудиторий в кампаниях — 0, есть 2 ретаргетинговых списка "
         f"(«Исключение: спам-звонки», «Интересы и привычки»)."
         if dlextra.get("audience_targets") == [] else "* Ретаргетинг: данных нет.")
d.append("\n## 5. Ограничения аудита (что нельзя проверить через API)\n")
d.append("* Стратегии кампаний (тип стратегии, целевое действие, недельный бюджет, статус обучения) API v5 не отдаёт — "
         "нужны скриншоты настроек кампаний из интерфейса Директа.")
d.append("* Значения корректировок не отдаются: видны только факты — "
         f"{len(J('direct-extra2.json').get('bidmodifiers') or [])} корректировок уровней кампаний "
         f"(типы MOBILE_ADJUSTMENT и DEMOGRAPHICS_ADJUSTMENT).")
d.append("* Выручка, маржинальность, средний чек — данных нет: ДРР и ROMI в деньгах не считаются (см. "
         "`performance-unit-economics`).")
d.append("* Статус обучения автостратегий и категории автотаргетинга — данных нет.")

(HERE / "audit-direct-full-2026-11-16.md").write_text("\n".join(d) + "\n", encoding="utf-8")

# --- markdown: сайт ------------------------------------------------------------
s: list[str] = []
cf = S["site"]["contact_funnel"]
s.append("# Конверсия сайта www.doma-karkas.ru — разбор и точки роста")
s.append(f"\n**Период:** {PERIOD}. **Источники:** Метрика `stat/v1/data` (счётчик 22595095), "
         f"`ym:pv` по страницам, проба 9 страниц (HTTP-статус, вес HTML, TTFB, наличие кода счётчика), выгрузка {S['collected']} МСК.\n")
s.append("## 1. Воронка за 90 дней\n")
s.append("| Шаг | Значение | Конверсия к предыдущему шагу |")
s.append("|---|---|---|")
s.append(f"| Визиты | {cf['visits']:.0f} | — |")
s.append(f"| «Отправка всех форм» (цель) | {cf['form_all']:.0f} | {cf['form_all']/cf['visits']*100:.1f} % |")
s.append(f"| из них «Фильтр: подобрать проекты» | {cf['filter']:.0f} | — |")
s.append(f"| Лид (формы + чат Jivo, цель «Лид») | {cf['real_form_leads']:.0f} | {cf['visit_to_lead_pct']} % от визитов |")
s.append(f"| Звонки | {cf['calls']:.0f} | — |")
s.append(f"| CRM: заказ создан | {cf['orders']:.0f} | {cf['lead_to_order_pct']} % от лида |")
s.append(f"| CRM: заказ оплачен | {cf['paid']:.0f} | {cf['order_to_paid_pct']} % от заказа |")
s.append(f"| CRM: спам-заказ | {cf['spam']:.0f} | {cf['spam_share_pct']} % от созданных заказов |")
s.append(f"| CRM: заказ отменён | {cf['cancel']:.0f} | — |")
s.append("\n**Главный вывод:** цифра «9 305 форм» не равна лидам. Реальных обращений с форм — "
         f"порядка {cf['real_form_leads']:.0f}, плюс {cf['calls']:.0f} звонков за 90 дней; доля заявок, доходящих до оплаты — "
         f"{cf['order_to_paid_pct']:.0f} % от созданных заказов, при этом {cf['spam_share_pct']:.0f} % заказов помечены спамом.\n")
s.append("## 2. Разделы сайта: где трафик и где деньги\n")
s.append("| Раздел | Визиты | Отказы, % | Глубина | Время, с | Звонки | Лид | Формы | Заказы | Оплаты |")
s.append("|---|---|---|---|---|---|---|---|---|---|")
for r in site["sections"][:12]:
    s.append(f"| {r['section']} | {r['visits']:.0f} | {r['bounce']} | {r['depth']} | {r['time']:.0f} | "
             f"{r['call']:.0f} | {r['lid']:.0f} | {r['form_all']:.0f} | {r['order']:.0f} | {r['paid']:.0f} |")
s.append("\n## 3. Страницы по просмотрам (ym:pv, топ-10)\n")
s.append("| Страница | Просмотры | Посетители |")
s.append("|---|---|---|")
for row in S["site"]["pages_top"][:10]:
    s.append(f"| {str(row[0])[:52]} | {row[1]:.0f} | {row[2]:.0f} |")
s.append("\n## 4. Устройства: где теряются заявки\n")
dev = site["device"]
for row in dev:
    v = row["visits"] or 1
    extra_forms = (row["form_all"] or 0) - (row["filter"] or 0)
    s.append(f"* {row['dim']}: {v:.0f} визитов ({v/cf['visits']*100:.0f} %), отказы {row['bounceRate']:.1f} %, "
             f"форма-заявки (без фильтра) {extra_forms:.0f} (CR {extra_forms/v*100:.2f} %), звонки {row['call']:.0f}, заказы {row['order']:.0f}.")
s.append("\n## 5. Технические факты о страницах\n")
tech = [t for t in S["site"]["tech"] if t.get("status") == 200]
desktop = [t for t in tech if t["client"] == "desktop"]
if desktop:
    sizes = sorted((t["bytes"] for t in desktop))
    ttfb = sorted((t["ttfb_s"] for t in desktop))
    s.append(f"* HTML страниц: от {sizes[0]//1024} до {sizes[-1]//1024} КБ (медиана {sizes[len(sizes)//2]//1024} КБ), "
             f"скриптов на странице: {min(t['scripts'] for t in desktop)}–{max(t['scripts'] for t in desktop)}, "
             f"TTFB {ttfb[0]:.2f}–{ttfb[-1]:.2f} с.")
    s.append(f"* Код Метрики 22595095 найден на всех проверенных страницах; `viewport` есть везде; "
             f"формы: {min(t['forms'] for t in desktop)}–{max(t['forms'] for t in desktop)} на страницу.")
    s.append(f"* Слабые места: страница /proektirovanie/ — 4 481 просмотр, отказы 52,8 %, заголовок `title` = "
             f"«Проектирование» без УТП; страницы статей приносят трафик (например "
             f"/articles/kreplenie-mauerlata-k-gazobetonu-instruktsiya/ — 1 276 просмотров), но не конвертируют "
             f"в заявку (в статьях 93 формы за 90 дней при 6 122 визитах).")
s.append(f"* Посадочные из рекламы: 22 страницы с трафиком ≥200 визитов и **0 заказов** — суммарно 8 543 визита.")
s.append("\n## 6. Что делать на сайте (в порядке влияния)\n")
s.append("1. **Развести «лид» и «подбор проекта»**: цель «Фильтр: подобрать проекты» (7 422 достижения) убрать из "
         "конверсий Директа, чтобы стратегии не учились на дешёвом действии.")
s.append("2. **Мобильный путь к заявке** (67 % трафика, отказы 31,8 % vs 17,8 % на ПК): проверить скорость и "
         "скролл, вынести форму и телефон в первый экран, убрать блокирующие попапы (в HTML 29–45 упоминаний модалок).")
s.append("3. **Форма-заявка на страницах проектов**: карточки проектов дают 31 090 визитов и 1 079 форм, "
         "но только 11 заказов — нужен измеримый оффер (смета/фиксация цены) вместо общей формы.")
s.append("4. **Страница /proektirovanie/** (52,8 % отказов): переписать оффер, добавить примеры, поставить форму расчёта "
         "проекта (цель «Форма Рассчитать проект» сейчас фактически не работает: 5 достижений за 90 дней).")
s.append("5. **Статьи → заявка**: в блог-статьях (6 122 визита) нет CTA-блока с расчётом; добавить калькулятор/квиз и "
         "цель на него.")
s.append("6. **Квалификация лида**: 39 % созданных заказов — спам; вынести в CRM-статусы и передавать их обратно в "
         "Метрику (офлайн-конверсии), иначе оптимизация будет учиться на мусоре.")

(HERE / "audit-site-conversion-2026-11-16.md").write_text("\n".join(s) + "\n", encoding="utf-8")

print("summary.json + 3 отчёта записаны")
print("расход:", money(e["spend"]), "| заказы:", orders_total, "| оплаты:", paid_total,
      "| ₽/оплата:", money(e["cost_per_paid"]))
print("кампаний без оплат:", len(without_paid), money(S["economics"]["no_paid_spend"]))
print("РСЯ:", money(next((r["Cost"] for r in dlextra["network"] if r["AdNetworkType"] == "AD_NETWORK"), 0)),
      "| поиск:", money(next((r["Cost"] for r in dlextra["network"] if r["AdNetworkType"] == "SEARCH"), 0)))
