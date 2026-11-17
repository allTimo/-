# -*- coding: utf-8 -*-
"""Сборка презентации аудита doma-karkas.ru / intel-denisov (python-pptx)."""
from __future__ import annotations

import json
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
S = json.loads((HERE / "summary.json").read_text(encoding="utf-8"))
OUT = HERE / "audit-doma-karkas-2026-11-16.pptx"

NAVY = RGBColor(0x12, 0x32, 0x4F)
ACCENT = RGBColor(0xE0, 0x4A, 0x2B)
GREEN = RGBColor(0x1B, 0x7F, 0x4B)
GREY = RGBColor(0x5A, 0x66, 0x72)
LIGHT = RGBColor(0xF2, 0xF4, 0xF7)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW, SH = prs.slide_width, prs.slide_height


def txt(slide, left, top, width, height, text, size=14, bold=False, color=NAVY, align=PP_ALIGN.LEFT,
        font="Calibri", line_spacing=1.0):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    frame = box.text_frame
    frame.word_wrap = True
    first = True
    for line in str(text).split("\n"):
        para = frame.paragraphs[0] if first else frame.add_paragraph()
        first = False
        para.alignment = align
        para.line_spacing = line_spacing
        run = para.add_run()
        run.text = line
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
        run.font.name = font
    return box


def rect(slide, left, top, width, height, fill, line=None):
    from pptx.enum.shapes import MSO_SHAPE
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(left), Inches(top),
                                   Inches(width), Inches(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
    shape.shadow.inherit = False
    return shape


def bullets(slide, left, top, width, height, items, size=14, color=NAVY, bullet_color=ACCENT):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    frame = box.text_frame
    frame.word_wrap = True
    first = True
    for item in items:
        para = frame.paragraphs[0] if first else frame.add_paragraph()
        first = False
        para.space_after = Pt(6)
        run = para.add_run()
        run.text = "•  " + item
        run.font.size = Pt(size)
        run.font.color.rgb = color
        run.font.name = "Calibri"
    return box


def title_slide(slide, title, subtitle, meta):
    rect(slide, 0, 0, 13.333, 7.5, NAVY)
    txt(slide, 0.9, 2.0, 11.5, 1.2, title, size=40, bold=True, color=WHITE)
    txt(slide, 0.9, 3.4, 11.5, 1.0, subtitle, size=20, color=RGBColor(0xC8, 0xD6, 0xE4))
    txt(slide, 0.9, 5.6, 11.5, 1.0, meta, size=13, color=RGBColor(0x9F, 0xB2, 0xC6))


def section_slide(title, kicker=None):
    slide = prs.slides.add_slide(BLANK)
    rect(slide, 0, 0, 0.28, 7.5, ACCENT)
    txt(slide, 0.7, 0.35, 12.0, 0.7, title, size=28, bold=True, color=NAVY)
    if kicker:
        txt(slide, 0.7, 1.05, 12.0, 0.5, kicker, size=14, color=GREY)
    return slide


def kpi_row(slide, items, top=1.7, height=1.5, left=0.7, width=11.9):
    """items: [(значение, подпись, цвет)]"""
    n = len(items)
    gap = 0.2
    card_w = (width - gap * (n - 1)) / n
    for i, (value, label, color) in enumerate(items):
        x = left + i * (card_w + gap)
        rect(slide, x, top, card_w, height, LIGHT)
        txt(slide, x + 0.15, top + 0.12, card_w - 0.3, 0.6, value, size=24 if len(str(value)) < 12 else 20,
            bold=True, color=color, align=PP_ALIGN.CENTER)
        txt(slide, x + 0.15, top + 0.78, card_w - 0.3, 0.6, label, size=11, color=GREY, align=PP_ALIGN.CENTER)


def table(slide, headers, rows, left=0.7, top=1.8, width=11.9, height=None, size=11, header_size=11,
          col_widths=None, accent_rows=()):
    row_count = len(rows) + 1
    height = height or min(0.34 * row_count, 4.9)
    shape = slide.shapes.add_table(row_count, len(headers), Inches(left), Inches(top), Inches(width), Inches(height))
    tbl = shape.table
    if col_widths:
        total = sum(col_widths)
        for idx, w in enumerate(col_widths):
            tbl.columns[idx].width = Emu(int(width * Inches(1) * w / total))
    for c, head in enumerate(headers):
        cell = tbl.cell(0, c)
        cell.text = str(head)
        para = cell.text_frame.paragraphs[0]
        para.runs[0].font.size = Pt(header_size)
        para.runs[0].font.bold = True
        para.runs[0].font.color.rgb = WHITE
        cell.fill.solid()
        cell.fill.fore_color.rgb = NAVY
    for r, row in enumerate(rows, start=1):
        for c, value in enumerate(row):
            cell = tbl.cell(r, c)
            cell.text = str(value)
            para = cell.text_frame.paragraphs[0]
            para.runs[0].font.size = Pt(size)
            para.runs[0].font.color.rgb = NAVY if r not in accent_rows else ACCENT
            cell.fill.solid()
            cell.fill.fore_color.rgb = WHITE if r % 2 else LIGHT
    return tbl


M = lambda v: f"{float(v):,.0f}".replace(",", " ")  # noqa: E731
e, mk, cf, dt = S["economics"], S["metrika"], S["site"]["contact_funnel"], S["direct"]["totals"]
net = {r["AdNetworkType"]: r for r in S["direct"]["network"]}
search, rya = net.get("SEARCH", {}), net.get("AD_NETWORK", {})
autotarget = next((r["Cost"] for r in S["direct"]["criteria_by_type"] if r["CriterionType"] == "AUTOTARGETING"), 0)
keywords_cost = next((r["Cost"] for r in S["direct"]["criteria_by_type"] if r["CriterionType"] == "KEYWORD"), 0)

# 1 — титул
title_slide(prs.slides.add_slide(BLANK),
            "Аудит контекстной рекламы и аналитики",
            "doma-karkas.ru · кабинет Яндекс.Директа intel-denisov · счётчик Метрики 22595095",
            "Период: 19.08.2026 – 16.11.2026 (90 дней) · Выгрузка: 16.11.2026\n"
            "Источники: Яндекс.Директ API v5 (Reports, Campaigns.get, Keywords.get) · Яндекс.Метрика stat/v1/data и management/v1\n"
            "Режим работы: только чтение, изменения в кабинете не вносились")

# 2 — резюме
s = section_slide("Резюме: 2,72 млн ₽ расхода дали 11 оплаченных заказов",
                  "Все цифры — расход из отчётов Директа, продажи — из целей CRM в Метрике (90 дней)")
kpi_row(s, [(f"{M(e['spend'])} ₽", "расход за 90 дней", NAVY),
            (f"{e['clicks']:,.0f}".replace(",", " "), "клики", NAVY),
            (f"{e['direct_conversions']:,.0f}".replace(",", " "), "«конверсии» Директа", GREY),
            (f"{cf['orders']:.0f} / {cf['paid']:.0f}", "заказы / оплаты CRM", ACCENT)])
kpi_row(s, [(f"{M(e['cpa_direct'])} ₽", "CPA Директа (по микроцелям)", GREY),
            (f"{M(e['cost_per_order'])} ₽", "цена заказа CRM", ACCENT),
            (f"{M(e['cost_per_paid'])} ₽", "цена оплаченного заказа", ACCENT),
            (f"{e['no_paid_spend']/e['spend']*100:.0f} %", "бюджета — в кампаниях без оплат", ACCENT)],
        top=3.5, height=1.5)
txt(s, 0.7, 5.4, 11.9, 1.4,
    "Ключевой вывод: реклама оптимизируется на дешёвые действия (фильтр подбора, скролл, время на сайте), "
    "а не на заказы. Из 2,72 млн ₽ расхода 903 720 ₽ ушло в кампании, которые не принесли ни одной оплаты.\n"
    "Одновременно в аккаунте есть рабочие связки: «2. Поиск Прошлый директолог (Мобилки)» — 140 642 ₽ за оплату, "
    "«1. Поиск (Газобетон, Керамические)» — 161 273 ₽.", size=13, color=NAVY)

# 3 — что проверено / что недоступно
s = section_slide("Что проверено и что осталось за пределами данных")
bullets(s, 0.7, 1.7, 6.0, 5.0, [
    f"Директ: 13 кампаний, 102 группы, 3 670 фраз, 141 объявление, 16 810 площадок РСЯ, 105 576 поисковых запросов.",
    f"Расход, клики, показы, позиции, ставки, расписание показов, минус-слова и исключённые площадки — из API v5.",
    f"Метрика: {mk['goals_total']} целей, фильтры, сегменты, карточка счётчика, срезы по источникам, устройствам, гео, возрасту, посадочным и страницам.",
    "Сайт: HTTP-статус, вес HTML, TTFB, наличие кода счётчика и адаптивности на 9 ключевых страницах.",
], size=13)
bullets(s, 7.0, 1.7, 5.6, 5.0, [
    "Стратегии кампаний (тип, целевое действие, недельный бюджет, статус обучения) API v5 не отдаёт — нужны скриншоты настроек.",
    "Выручка, маржа, средний чек — данных нет: ДРР и ROMI в деньгах не считаются.",
    "Офлайн-конверсии CRM → Метрика не настроены (эндпоинт offline_conversions недоступен).",
    "Тексты объявлений и креативы: API вернул пустой TextAd, нужен отчёт «Объявления» с текстами.",
    "Wordstat и Яндекс.Аудитории — доступы не подключены.",
], size=13)
txt(s, 0.7, 6.55, 11.9, 0.6,
    "Проверка по чек-листу PPC (105 пунктов): проверено 61 · нет данных 44 · не применимо 0. "
    "Ни одна рекомендация ниже не выдана по непроверенному пункту.", size=12, bold=True, color=ACCENT)

# 4 — главный разрыв
s = section_slide("Главный разрыв: конверсии ≠ продажи",
                  "Отчёт Директа и цели Метрики, один и тот же период")
kpi_row(s, [(f"{dt['conversions']:,.0f}".replace(",", " "), "«конверсий» Директа (CPA 119 ₽)", GREY),
            (f"{cf['form_all']:,.0f}".replace(",", " "), "цель «Отправка всех форм»", GREY),
            (f"{cf['filter']:,.0f}".replace(",", " "), "из них «Фильтр: подобрать проекты»", ACCENT),
            (f"{cf['real_form_leads']:.0f}", "реальных обращений (цель «Лид»)", GREEN),
            (f"{cf['paid']:.0f}", "оплаченных заказов CRM", ACCENT)])
txt(s, 0.7, 3.6, 11.9, 3.2,
    "Что произошло: в конверсии Директа попадают микроцели Метрики — «На сайте >5 минут» "
    f"({mk['goals_reaches'].get('На сайте >5 минут', 0):,.0f}), «Глубина просмотров 5 страниц» "
    f"({mk['goals_reaches'].get('Глубина просмотров (5 страниц)', 0):,.0f}), «Скролл 70%» "
    f"({mk['goals_reaches'].get('Скролл страницы на 70%', 0):,.0f}) — и цель «Фильтр: подобрать проекты» "
    f"({cf['filter']:,.0f} достижений).".replace(",", " ") + "\n"
    "Автостратегии обучаются на этих действиях: они дешёвые и массовые, поэтому «CPA 119 ₽» ничего не говорит "
    "о продажах, а бюджет уходит в трафик, который не покупает.".replace(",", " ") + "\n"
    "Что делать: перевести конверсии на макроцели — «Лид» (составная: 10 форм + чат Jivo), «CRM: Заказ создан», "
    "«CRM: Заказ оплачен»; цель «Фильтр: подобрать проекты» из конверсий Директа убрать. Дать стратегиям 2–4 недели обучения.",
    size=13)

# 5 — сеть: поиск vs РСЯ
s = section_slide("Поиск и РСЯ: где деньги, а где охват")
chart_data = CategoryChartData()
chart_data.categories = ["Поиск", "РСЯ"]
chart_data.add_series("Расход, ₽", (search.get("Cost", 0), rya.get("Cost", 0)))
slide_chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.7), Inches(1.7),
                                 Inches(6.2), Inches(4.6), chart_data)
chart = slide_chart.chart
chart.has_legend = False
chart.plots[0].has_data_labels = True
chart.plots[0].data_labels.number_format = '# ##0 "₽"'
chart.plots[0].data_labels.font.size = Pt(12)
bullets(s, 7.1, 1.7, 5.5, 5.0, [
    f"Поиск: {M(search.get('Cost', 0))} ₽, {search.get('Clicks', 0):,.0f} кликов, цена оплаты 140–161 тыс ₽.".replace(",", " "),
    f"РСЯ: {M(rya.get('Cost', 0))} ₽ ({rya.get('Cost', 0)/e['spend']*100:.0f} % бюджета), {rya.get('Clicks', 0):,.0f} кликов (из них 60 274 — в кампании «РСЯ / Интел Групп»), 1 заказ, 0 оплат.".replace(",", " "),
    f"Автотаргетинг: {M(autotarget)} ₽ — {autotarget/e['spend']*100:.0f} % всего бюджета; ключевые фразы {M(keywords_cost)} ₽.",
    "В РСЯ-кампании три продуктовых направления в одной кампании и 0 минус-слов — аудитория размыта.",
    "Вывод: РСЯ сейчас работает на охват, а не на продажи. Нужны разделение по продуктам, минусовка и пилотный лимит.",
], size=13)

# 6 — карта кампаний
s = section_slide("Карта кампаний: расход → заказы → оплаты", "Расход — Директ API, заказы и оплаты — цели CRM в Метрике")
order = sorted(S["economics"]["best_campaigns"] + [c for c in S["economics"]["no_paid_campaigns"]],
               key=lambda c: -c["spend"])
rows = [[c["name"][:44], M(c["spend"]), (c.get("paid") or 0), (c.get("orders") or 0),
         M(c["cost_per_paid"]) if c.get("cost_per_paid") else "—"] for c in order[:10]]
table(s, ["Кампания", "Расход, ₽", "Оплаты", "Заказы", "₽ за оплату"], rows,
      top=1.75, width=11.9, size=11, col_widths=[5.2, 1.7, 1.1, 1.1, 1.6],
      accent_rows=tuple(i for i, c in enumerate(order[:10]) if not c.get("paid")))
txt(s, 0.7, 6.5, 11.9, 0.7,
    f"Кампании без оплат: {len(S['economics']['no_paid_campaigns'])} с расходом выше 1 000 ₽ — "
    f"{M(S['economics']['no_paid_spend'])} ₽ (33 % бюджета). Лучшая цена оплаты — у поисковых кампаний.",
    size=12, bold=True, color=ACCENT)

# 7 — сливы: минус-слова и кампании без оплат
s = section_slide("Где теряется бюджет прямо сейчас")
kpi_row(s, [(f"{M(S['direct']['minus']['spend'])} ₽", f"запросы с расходом без конверсий ({S['direct']['minus']['count']})", ACCENT),
            (f"{M(S['direct']['trash']['spend'])} ₽", f"«мусорные» интенты ({S['direct']['trash']['count']} запросов)", ACCENT),
            (f"{M(S['economics']['no_paid_spend'])} ₽", "кампании без оплат (4 крупные)", ACCENT),
            (f"{M(rya.get('Cost', 0))} ₽", "РСЯ-кампания с 1 заказом и 0 оплат", ACCENT)])
rows = [[q[0][:56], M(q[1]), q[2]] for q in S["direct"]["minus"]["rows"][:8]]
table(s, ["Поисковый запрос с расходом и без конверсий", "Расход, ₽", "Клики"], rows,
      top=3.5, width=11.9, size=11, col_widths=[8.3, 1.8, 1.2])
txt(s, 0.7, 6.6, 11.9, 0.7,
    "Минус-лист готовится из отчёта «Поисковые запросы»: 31 запрос с расходом без конверсий и 142 запроса "
    "с нецелевыми интентами (аренда, «своими руками», чертежи, расчёты).", size=12, color=GREY)

# 7b — каннибализация и бренд
s = section_slide("Внутренняя конкуренция и потерянный бренд",
                  "Отчёт по поисковым запросам: один запрос показывается из нескольких кампаний")
deep = S.get("deep", {})
cannib = deep.get("cannibalization", {"count": 0, "spend": 0})
kpi_row(s, [(f"{cannib.get('count', 0):,}".replace(",", " "), "запросов в ≥2 кампаниях", ACCENT),
            (f"{M(cannib.get('spend', 0))} ₽", "расхода в этих запросах (39 % бюджета)", ACCENT),
            ("104 689 ₽", "один запрос «строительная компания»", ACCENT),
            ("6", "кампаний минусуют свой бренд «Интел»", ACCENT)])
rows = [[f"{str(r['CampaignName'])[:40]}", f"{M(r['cost'])}", f"{r['shared_queries']:.0f}"]
        for r in (deep.get("cannibalization_by_campaign") or [])[:5]]
table(s, ["Кампания", "Расход по «общим» запросам", "Таких запросов"], rows,
      top=3.5, width=11.9, size=11, col_widths=[6.0, 3.4, 2.5])
txt(s, 0.7, 6.2, 11.9, 1.2,
    "Кампании перебивают друг друга в аукционе: клиент дороже, а атрибуция заказов размазана между кампаниями. "
    "Плюс свой бренд стоит в минус-словах — брендовый поиск в Директе дал 2 клика за 90 дней, хотя в органике "
    "брендовые запросы конвертят в заказ с CR ≈ 1,4 % против 0,06 % по всему трафику.", size=12)

# 7c — незакрытый спрос и разметка
s = section_slide("Спрос, который аккаунт уже получает, но не развивает")
deep2 = deep.get("frame_demand", {})
lost = deep.get("lost_campaign_ids", {})
kpi_row(s, [(f"{deep2.get('count', 0):,}".replace(",", " "), "запросов про каркас, дерево, СИП", NAVY),
            (f"{M(deep2.get('spend', 0))} ₽", "расхода на этот спрос", NAVY),
            (f"{deep2.get('conversions', 0):.0f}", "«конверсий» Директа по ним", GREY),
            (f"{lost.get('share_of_ad_traffic_pct', 0)} %", "рекламного трафика с ID вне кабинета", ACCENT)])
rows = [[q[0][:52], M(q[1]), f"{q[2]}", f"{q[3]}"] for q in (deep2.get("top") or [])[:7]]
table(s, ["Запрос", "Расход, ₽", "Клики", "Конв. Директа"], rows,
      top=3.5, width=11.9, size=11, col_widths=[6.4, 2.0, 1.5, 2.0])
txt(s, 0.7, 6.2, 11.9, 1.2,
    "Направление уже работает: страница /catalog/karkasnye-doma/ даёт CR в контакт 0,97 % против 0,17 % у газобетона. "
    f"Отдельно: {lost.get('visits', 0):,.0f} визитов (9,4 % рекламного трафика) размечены 6 ID кампаний, которых нет "
    "в отчётах кабинета — расход по ним в экономике не учитывается.".replace(",", " "), size=12)

# 8 — Метрика: настройки
s = section_slide("Метрика 22595095: настройки — 8 находок")
bullets(s, 0.7, 1.7, 6.0, 5.0, [
    f"{mk['goals_total']} цели, из них {mk['goals_dead']} не сработали ни разу за 90 дней (сломанные формы по xpath).",
    "Пять целей по звонкам дублируют друг друга — «Звонок», «Уникальный звонок», «Уникально-целевой», «Целевой», «первичный >60 сек».",
    "Микроцели-ловушки: >5 минут, глубина 5 и 10 страниц, скролл 70 % — 57 тыс. достижений против 93 лидов.",
    "code_status = CS_ERR_UNKNOWN: код на сайте стоит (ID совпадает на всех проверенных страницах), но статус в Метрике не подтверждён.",
], size=13)
bullets(s, 7.0, 1.7, 5.6, 5.0, [
    f"Автоцели выключены, дубликатор ecommerce выключен, при этом ecommerce помечен как «ручной» — сегменты «Покупатели» и «Брошенные корзины» не наполняются.",
    f"UTM: utm_source = yandex, ya_direct и **ay_direct** (6 885 визитов — опечатка), плюс ya, dzen, domclick.",
    f"Внутренний трафик {mk['internal_traffic']['visits']:.0f} визитов ({mk['internal_traffic']['visits']/mk['visits']*100:.1f} %) не отфильтрован: в фильтрах один IP.",
    "Офлайн-конверсии CRM в Метрику не передаются — сквозной ДРР посчитать нельзя.",
], size=13)

# 9 — Метрика: аудитория
s = section_slide("Кто приходит: устройства, возраст, гео", f"Метрика, 90 дней: {mk['visits']:,.0f} визитов, отказы {mk['bounce']} %".replace(",", " "))
rows = []
for d in mk["device_rows"][:3]:
    extra = (d["form_all"] or 0) - (d["filter"] or 0)
    rows.append([d["dim"], f"{d['visits']:,.0f}".replace(",", " "), f"{d['bounceRate']:.1f}",
                 f"{extra:.0f}", f"{extra/(d['visits'] or 1)*100:.2f}", f"{d['call']:.0f}", f"{d['order']:.0f}"])
table(s, ["Устройство", "Визиты", "Отказы, %", "Заявки с форм", "CR заявки, %", "Звонки", "Заказы"], rows,
      top=1.75, width=11.9, size=11, col_widths=[2.2, 1.8, 1.4, 2.2, 1.8, 1.3, 1.2])
rows2 = [[r["ageInterval"], f"{r['visits']:,.0f}".replace(",", " "), f"{r['g_order']:.0f}", f"{r['g_paid']:.0f}",
          f"{r['cr_order_pct']}"] for r in mk["age_rows"][:5]]
table(s, ["Возраст", "Визиты", "Заказы", "Оплаты", "CR заказа, %"], rows2,
      top=3.9, width=11.9, size=11, col_widths=[2.4, 2.4, 1.4, 1.4, 1.8])
txt(s, 0.7, 6.4, 11.9, 0.8,
    "Мобильные: 67 % трафика, отказы 31,8 % против 17,8 % на ПК, CR в заявку в 1,7 раза ниже. "
    "Аудитория 55+: 38 % трафика и 3 заказа против 26 заказов у 35–44 лет — при корректировке ставок это первый резерв.",
    size=12, color=ACCENT)

# 10 — Сайт: воронка
s = section_slide("Конверсия сайта: воронка от визита до оплаты")
kpi_row(s, [(f"{cf['visits']:,.0f}".replace(",", " "), "визиты", NAVY),
            (f"{cf['form_all']:,.0f}".replace(",", " "), "«формы» (вкл. подбор проектов)", GREY),
            (f"{cf['real_form_leads']:.0f}", "лид: формы + чат Jivo", GREEN),
            (f"{cf['calls']:.0f}", "звонки (коллтрекинг)", GREEN),
            (f"{cf['orders']:.0f} / {cf['paid']:.0f}", "заказы / оплаты CRM", ACCENT)])
bullets(s, 0.7, 3.6, 11.9, 3.2, [
    f"Конверсия визит → лид: {cf['visit_to_lead_pct']} % ({cf['real_form_leads']:.0f} лидов). Визит → контакт (лид + звонок): {cf['visit_to_contact_pct']} %.",
    f"Лид → заказ: {cf['lead_to_order_pct']} %. Заказ → оплата: {cf['order_to_paid_pct']} %. Спам-заказы: {cf['spam']:.0f} ({cf['spam_share_pct']} % созданных заказов) — лиды не квалифицируются.",
    f"Из 9 305 «форм» {cf['filter']:,.0f} — подбор проектов, а не заявка: цифра в отчётах завышает результат в 100 раз.".replace(",", " "),
    f"Реклама даёт 124 852 визита и 20 лидов (CR 0,016 %); поиск — 15 372 визита и 28 лидов (CR 0,18 %): платный трафик в 10 раз холоднее.",
], size=13)

# 11 — Сайт: разделы
s = section_slide("Где трафик и где деньги: разделы сайта", "Метрика, посадочные страницы, 90 дней")
rows = [[r["section"], f"{r['visits']:,.0f}".replace(",", " "), f"{r['bounce']}", f"{r['form_all']:.0f}",
         f"{r['lid']:.0f}", f"{r['order']:.0f}", f"{r['paid']:.0f}"] for r in S["site"]["sections"][:8]]
table(s, ["Раздел", "Визиты", "Отказы, %", "Формы", "Лиды", "Заказы", "Оплаты"], rows,
      top=1.75, width=11.9, size=11, col_widths=[3.6, 1.7, 1.3, 1.4, 1.2, 1.3, 1.4])
txt(s, 0.7, 5.3, 11.9, 1.8,
    "Карточки проектов — 31 090 визитов и только 11 заказов; статьи — 6 122 визита и 0 заказов: "
    "контент приводит людей, но не переводит их в заявку.\n"
    "Главная страница конвертит лучше всех (20 заказов, 8 оплат на 10 124 визита), но она не получает и четверти трафика.\n"
    "Отдельная боль: страница /proektirovanie/ — 4 481 просмотр при отказах 52,8 % и заголовке «Проектирование» без оффера.",
    size=12)

# 12 — Сайт: техника
s = section_slide("Технические и UX-находки на сайте")
bullets(s, 0.7, 1.7, 6.0, 5.0, [
    "HTML-страницы 200–340 КБ, 62–83 подключённых скрипта, jQuery и 1С-Битрикс: на мобильных это заметная задержка отрисовки.",
    "TTFB 0,07–0,73 с — сервер отвечает быстро, узкое место на клиенте и в фронтенде.",
    "Дубли title: «Проектирование», «Контакты» без УТП; у карточек проектов title уже с оффером и сметой.",
    "Модальных окон и попапов 19–45 упоминаний в HTML — риск перекрытия контента на мобильных.",
], size=13)
bullets(s, 7.0, 1.7, 5.6, 5.0, [
    f"22 посадочные страницы с трафиком ≥200 визитов не принесли ни одного заказа — суммарно 8 543 визита.",
    "На главной и в карточках нет калькулятора стоимости, хотя спрос на него виден в запросах («калькулятор», «сколько стоит»).",
    "Цель «Форма Рассчитать проект» сработала 5 раз за 90 дней, две формы-цели мертвы — часть форм на сайте не работает или не размечена.",
    "Код Метрики 22595095 есть на всех проверенных страницах, viewport присутствует — база для аналитики и адаптива в порядке.",
], size=13)

# 13 — Экономика
s = section_slide("Экономика: какие цифры есть, а каких не хватает")
rows = [["Расход за 90 дней", f"{M(e['spend'])} ₽", "Директ API, отчёт по кампаниям"],
        ["Клики / показы", f"{e['clicks']:,.0f} / {e['impressions']:,.0f}".replace(",", " "), "Директ API"],
        ["Средний CPC", f"{e['avg_cpc']} ₽", "расход / клики"],
        ["CPA по «конверсиям» Директа", f"{M(e['cpa_direct'])} ₽", "микроцели — для продаж не показатель"],
        ["Цена заказа CRM", f"{M(e['cost_per_order'])} ₽", f"{cf['orders']:.0f} заказов по кампаниям"],
        ["Цена оплаченного заказа", f"{M(e['cost_per_paid'])} ₽", f"{cf['paid']:.0f} оплат CRM"],
        ["Конверсия заказ → оплата", f"{e['order_to_paid_pct']} %", "цели CRM в Метрике"],
        ["Цена лида через сайт (реклама)", f"{M(e['spend'] / max(cf['real_form_leads'], 1))} ₽", "лид по всем источникам"],
        ["ДРР / ROMI", "данных нет", "нужны выручка и маржа по заказам"],
        ["Break-even CPA", "данных нет", "нужны маржа, средний чек, LTV"]]
table(s, ["Показатель", "Значение", "Источник / комментарий"], rows, top=1.65, width=11.9, size=11,
      col_widths=[3.6, 2.6, 5.7])
txt(s, 0.7, 6.75, 11.9, 0.6,
    "Без выручки и маржи по заказам нельзя сказать, окупается ли реклама: при цене оплаты 247 246 ₽ "
    "решение зависит от маржи дома. Это первый запрос к клиенту.", size=12, bold=True, color=ACCENT)

# 14 — план
s = section_slide("План улучшений: 30 / 60 / 90 дней")
rows = [
    ["1–14", "Конверсии Директа перевести на макроцели (Лид, CRM-заказ, CRM-оплата); «Фильтр: подобрать проекты» убрать", "Обучение на продажах, а не на кликах", "гипотеза: −20…35 % к цене оплаты"],
    ["1–14", "Минус-слова: 31 запрос без конверсий + 142 мусорных интента", "Отсечь мусорный трафик", f"{M(S['direct']['minus']['spend'] + S['direct']['trash']['spend'])} ₽ за квартал"],
    ["1–30", "РСЯ-кампанию (772 820 ₽) разделить по продуктам, добавить минус-слова и пилотный лимит", "Убрать охват без продаж", "до 400 тыс ₽/квартал под перераспределение"],
    ["15–45", "Корректировки по возрасту 55+ и мобильным после проверки на данных", "Перенаправить бюджет на 35–44", "до 150 тыс ₽/квартал"],
    ["15–45", "Пауза/перезапуск кампаний без оплат (2.1 Поиск, 1.1 Поиск, MAX № 13)", "Не платить за нулевой результат", f"{M(74900 + 31215 + 25294)} ₽ под перераспределение"],
    ["15–45", "Снять свой бренд из минус-слов 6 кампаний и запустить брендовую кампанию на точном соответствии", "Вернуть горячий спрос", "брендовый CR в заказ ≈ 1,4 % против 0,06 %"],
    ["15–45", "Собрать ядро и кампании под каркас/дерево/СИП/модульные дома (спрос уже идёт: 107 784 ₽)", "Новое направление с лучшей конверсией", "CR страницы каркаса 0,97 % против 0,17 %"],
    ["30–60", "Дедупликация ядра: 9 300 общих запросов на 1 053 294 ₽ развести по кампаниям", "Прекратить внутренний аукцион", "снижение CPC и рост доли показов"],
    ["30–60", "Сайт: мобильный путь к заявке, форма-оффер на карточках проектов, CTA в статьях", "Рост конверсии 67 % трафика", "гипотеза: +20…40 % заявок с мобильных"],
    ["45–90", "Офлайн-конверсии CRM → Метрика, сквозной ДРР по площадкам и кампаниям", "Управление по оплатам", "основа для оптимизации по ROMI"],
    ["45–90", "Чистка целей Метрики: 6 мёртвых, 5 дублей звонков, UTM-разнобой, автоцели и ecommerce", "Чистая аналитика", "корректность отчётности"],
]
table(s, ["Дни", "Действие", "Что даёт", "Эффект / резерв"], rows, top=1.65, width=11.9, size=10,
      col_widths=[0.9, 5.0, 2.8, 3.2])
txt(s, 0.7, 6.85, 11.9, 0.6,
    "Резервы за квартал: 903 720 ₽ — кампании без оплат, 56 217 ₽ — минус-слова, до 1 053 294 ₽ — расход по "
    "запросам с внутренней конкуренцией (39 % бюджета). Оценки роста — гипотезы: фиксируем базовую линию и "
    "проверяем на данных 2–4 недели.",
    size=11, bold=True, color=ACCENT)

# 15 — что нужно от клиента
s = section_slide("Что нужно, чтобы считать деньги, а не клики")
rows = [["Доступ к CRM (статусы сделок, суммы)", "Сквозной ДРР, доля оплат, качество лидов", "выгрузка или API"],
        ["Выручка и маржа по заказам, средний чек", "Break-even CPA/CPL, ROMI, целевой ДРР", "таблица или выгрузка"],
        ["Скриншоты стратегий кампаний", "Проверка целевого действия, недельного бюджета и обучения", "интерфейс Директа"],
        ["Отчёт «Объявления» с текстами и креативами", "Проверка заголовков, УТП, A/B-тестов", "интерфейс или API-выгрузка"],
        ["Доступ к Wordstat", "Оценка спроса, новые кластеры, сезонность", "подключение Wordstat API"],
        ["Подтверждение действий по кабинету", "Правки (минус-слова, ставки, бюджеты) вносятся только после согласования", "письменное подтверждение"]]
table(s, ["Что нужно", "Зачем", "Формат"], rows, top=1.75, width=11.9, size=11, col_widths=[4.4, 4.6, 2.9])

# 16 — итог
s = section_slide("Что дальше")
bullets(s, 0.7, 1.8, 11.9, 4.6, [
    "Аудит сделан в режиме чтения: в кабинете intel-denisov и счётчике Метрики ничего не менялось.",
    "Готовы артефакты: отчёты по Метрике, Директу и сайту, прогон чек-листа на 105 пунктов, сводные таблицы по кампаниям, площадкам и запросам.",
    "Первые шаги с максимальным эффектом: конверсии на макроцели, минус-лист, разделение РСЯ-кампании, корректировки по возрасту 55+.",
    "Всё, что требует записи в кабинет (минус-слова, ставки, бюджеты, стратегии), выполняется отдельным change-set после подтверждения.",
], size=14)
txt(s, 0.7, 6.5, 11.9, 0.7, "Вопросы и приоритеты — согласуем на следующем шаге.", size=13, bold=True, color=ACCENT)

prs.save(OUT)
print("сохранено:", OUT, "| слайдов:", len(prs.slides.__iter__.__self__._sldIdLst))
