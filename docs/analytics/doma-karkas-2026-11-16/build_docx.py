# -*- coding: utf-8 -*-
"""Сборка четырёх аудит-отчётов (Markdown) в один Word-документ.

Вход: audit-metrika, audit-direct-full, audit-deep-findings, audit-site-conversion.
Выход: audit-doma-karkas-2026-11-16.docx (A4 landscape, титул, резюме, содержание, 4 части).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

HERE = Path(__file__).resolve().parent
OUT = HERE / "audit-doma-karkas-2026-11-16.docx"
S = json.loads((HERE / "summary.json").read_text(encoding="utf-8"))

NAVY = RGBColor(0x12, 0x32, 0x4F)
ACCENT = RGBColor(0xC0, 0x39, 0x2B)
GREY = RGBColor(0x5A, 0x66, 0x72)

PARTS = [
    ("audit-metrika-2026-11-16.md", "Часть I. Аудит Яндекс.Метрики (счётчик 22595095)"),
    ("audit-direct-full-2026-11-16.md", "Часть II. Аудит аккаунта Яндекс.Директа (intel-denisov)"),
    ("audit-deep-findings-2026-11-16.md", "Часть III. Углублённые находки (каннибализация, бренд, спрос, разметка)"),
    ("audit-site-conversion-2026-11-16.md", "Часть IV. Конверсия сайта www.doma-karkas.ru"),
]

money = lambda v: f"{float(v):,.0f}".replace(",", " ") + " ₽"  # noqa: E731
num = lambda v: f"{float(v):,.0f}".replace(",", " ")  # noqa: E731


# --- документ и стили -----------------------------------------------------------
doc = Document()
section = doc.sections[0]
section.orientation = WD_ORIENT.LANDSCAPE
section.page_width, section.page_height = Cm(29.7), Cm(21.0)
for attr, value in (("left_margin", 1.6), ("right_margin", 1.6), ("top_margin", 1.4), ("bottom_margin", 1.4)):
    setattr(section, attr, Cm(value))

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(10.5)
normal.paragraph_format.space_after = Pt(4)
normal.paragraph_format.line_spacing = 1.08
rpr = normal.element.get_or_add_rPr()
rfonts = rpr.find(qn("w:rFonts"))
if rfonts is None:
    rfonts = OxmlElement("w:rFonts")
    rpr.append(rfonts)
rfonts.set(qn("w:eastAsia"), "Calibri")

for name, size, color in (("Heading 1", 20, NAVY), ("Heading 2", 14, NAVY), ("Heading 3", 12, NAVY)):
    style = styles[name]
    style.font.name = "Calibri"
    style.font.size = Pt(size)
    style.font.bold = True
    style.font.color.rgb = color
    style.paragraph_format.space_before = Pt(12 if name != "Heading 1" else 0)
    style.paragraph_format.space_after = Pt(6)
    style.paragraph_format.keep_with_next = True

for name in ("List Bullet", "List Number"):
    styles[name].font.name = "Calibri"
    styles[name].font.size = Pt(10.5)


def page_break():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def add_page_number(footer_par):
    run = footer_par.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr)
    run._r.append(fld_end)


footer = section.footer.paragraphs[0]
footer.text = "Аудит doma-karkas.ru / intel-denisov · 17.11.2026 · стр. "
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
for run in footer.runs:
    run.font.size = Pt(8)
    run.font.color.rgb = GREY
add_page_number(footer)


def add_inline(paragraph, text: str, size: float = 10.5, color=None):
    """Разбор **bold**, `code`, [text](url) внутри строки."""
    pattern = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))")
    for part in pattern.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        elif part.startswith("`") and part.endswith("`"):
            run = paragraph.add_run(part[1:-1])
            run.font.name = "Consolas"
            run.font.size = Pt(size - 0.5)
        elif part.startswith("["):
            match = re.match(r"\[([^\]]+)\]\(([^)]+)\)", part)
            if match:
                run = paragraph.add_run(f"{match.group(1)} ({match.group(2)})")
            else:
                run = paragraph.add_run(part)
        else:
            run = paragraph.add_run(part)
        run.font.size = Pt(size) if run.font.name != "Consolas" else run.font.size
        if color is not None:
            run.font.color.rgb = color


def shade(cell, hex_color: str):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tc_pr.append(shd)


def add_table(lines: list[str]):
    rows = []
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        rows.append(cells)
    if not rows:
        return
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=len(rows), cols=cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    for r, row in enumerate(rows):
        for c in range(cols):
            text = row[c] if c < len(row) else ""
            text = text if text.strip() else "—"
            cell = table.cell(r, c)
            cell.text = ""
            par = cell.paragraphs[0]
            par.paragraph_format.space_after = Pt(0)
            par.paragraph_format.line_spacing = 1.0
            add_inline(par, text, size=8.5) if "**" in text else None
            if "**" not in text:
                run = par.add_run(text)
                run.font.size = Pt(8.5)
            for run in par.runs:
                run.font.size = Pt(8.5)
                if r == 0:
                    run.bold = True
                    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            if r == 0:
                shade(cell, "12324F")
            elif r % 2 == 0:
                shade(cell, "F2F4F7")
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def render_markdown(path: Path, part_title: str, first: bool):
    if not first:
        page_break()
    doc.add_heading(part_title, level=1)
    lines = path.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        if stripped == "---":
            i += 1
            continue

        # таблица
        if stripped.startswith("|"):
            block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i])
                i += 1
            add_table(block)
            continue

        if stripped.startswith("#### "):
            doc.add_heading(stripped[5:].strip(), level=3)
            i += 1
            continue
        if stripped.startswith("### "):
            doc.add_heading(stripped[4:].strip(), level=3)
            i += 1
            continue
        if stripped.startswith("## "):
            doc.add_heading(stripped[3:].strip(), level=2)
            i += 1
            continue
        if stripped.startswith("# "):
            # внутренний H1 отчёта уже заменили названием части
            doc.add_paragraph(stripped[2:].strip(), style="Heading 3")
            i += 1
            continue

        if re.match(r"^[-*]\s+", stripped):
            par = doc.add_paragraph(style="List Bullet")
            add_inline(par, re.sub(r"^[-*]\s+", "", stripped))
            i += 1
            continue

        if re.match(r"^\d+\.\s+", stripped):
            par = doc.add_paragraph(style="List Number")
            add_inline(par, re.sub(r"^\d+\.\s+", "", stripped))
            i += 1
            continue

        par = doc.add_paragraph()
        add_inline(par, stripped)
        i += 1


# --- титул ----------------------------------------------------------------------
title_par = doc.add_paragraph()
title_par.alignment = WD_ALIGN_PARAGRAPH.LEFT
run = title_par.add_run("Аудит контекстной рекламы и аналитики")
run.font.size = Pt(32)
run.font.bold = True
run.font.color.rgb = NAVY

sub_par = doc.add_paragraph()
run = sub_par.add_run("doma-karkas.ru · кабинет Яндекс.Директа intel-denisov · счётчик Метрики 22595095")
run.font.size = Pt(15)
run.font.color.rgb = GREY

doc.add_paragraph()
meta = [
    ("Период аудита", "19.08.2026 – 16.11.2026 (90 дней), сравнение с 21.05.2026 – 18.08.2026"),
    ("Источники данных", "Яндекс.Директ API v5 (Reports, Campaigns.get, Keywords.get, Bids.get, BidModifiers.get), "
                         "Яндекс.Метрика stat/v1/data и management/v1, проба 9 страниц сайта"),
    ("Режим работы", "только чтение; изменения в рекламном кабинете и счётчике не вносились"),
    ("Состав документа", "Часть I — Метрика, Часть II — Директ, Часть III — углублённые находки, Часть IV — конверсия сайта"),
    ("Проверка по чек-листу PPC", "проверено 61 · нет данных 44 · не применимо 0 (105 пунктов)"),
]
for label, value in meta:
    par = doc.add_paragraph()
    par.paragraph_format.space_after = Pt(3)
    run = par.add_run(f"{label}: ")
    run.bold = True
    run.font.size = Pt(10.5)
    run.font.color.rgb = NAVY
    add_inline(par, value, size=10.5, color=GREY)

doc.add_paragraph()
doc.add_heading("Резюме аудита", level=2)
e = S["economics"]
cf = S["site"]["contact_funnel"]
kpi = [
    ("Расход за 90 дней", f"{money(e['spend'])} — {num(e['clicks'])} кликов, CPA по «конверсиям» Директа {money(e['cpa_direct'])}"),
    ("Продажи по целям CRM", f"{num(cf['orders'])} заказов и {num(cf['paid'])} оплат; цена заказа {money(e['cost_per_order'])}, "
                            f"цена оплаченного заказа {money(e['cost_per_paid'])}"),
    ("Кампании без оплат", f"{num(e['no_paid_spend'])} ₽ — 33 % бюджета; РСЯ-кампания 772 820 ₽ дала 1 заказ и 0 оплат"),
    ("Внутренняя конкуренция", "9 300 запросов показываются в ≥2 кампаниях — 1 053 294 ₽ расхода (39 % бюджета)"),
    ("Воронка сайта", f"{num(cf['visits'])} визитов → {num(cf['real_form_leads'])} лидов и {num(cf['calls'])} звонков → "
                      f"{num(cf['orders'])} заказов → {num(cf['paid'])} оплат; спам-заказы {cf['spam_share_pct']} %"),
    ("Метрика и цели", f"{S['metrika']['goals_total']} целей, {S['metrika']['goals_dead']} без достижений; "
                       f"«Фильтр: подобрать проекты» — {num(cf['filter'])} из {num(cf['form_all'])} «форм»"),
]
for label, value in kpi:
    par = doc.add_paragraph(style="List Bullet")
    run = par.add_run(f"{label}: ")
    run.bold = True
    add_inline(par, value)

doc.add_paragraph()
note = doc.add_paragraph()
add_inline(note, "Ограничения: стратегии кампаний и значения корректировок API v5 не отдаёт; офлайн-конверсии CRM в Метрику "
                 "не передаются; тексты объявлений через API недоступны; выручка и маржинальность клиента не предоставлены — "
                 "поэтому ДРР и ROMI в деньгах не рассчитаны.", size=9.5, color=GREY)

doc.add_heading("Содержание", level=2)
toc = [
    "Часть I. Аудит Яндекс.Метрики (счётчик 22595095)",
    "Часть II. Аудит аккаунта Яндекс.Директа (intel-denisov)",
    "Часть III. Углублённые находки (каннибализация, бренд, спрос, разметка)",
    "Часть IV. Конверсия сайта www.doma-karkas.ru",
]
for item in toc:
    par = doc.add_paragraph()
    par.paragraph_format.left_indent = Cm(0.6)
    run = par.add_run(item)
    run.font.size = Pt(11)

# --- части ----------------------------------------------------------------------
for index, (filename, title) in enumerate(PARTS):
    render_markdown(HERE / filename, title, first=(index == 0))

doc.save(OUT)
print("сохранено:", OUT)
print("параграфов:", len(doc.paragraphs), "| таблиц:", len(doc.tables))