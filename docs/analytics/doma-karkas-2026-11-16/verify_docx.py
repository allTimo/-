# -*- coding: utf-8 -*-
"""Проверка собранного Word-документа: структура, полнота четырёх частей, таблицы."""
from __future__ import annotations

import json
from pathlib import Path

from docx import Document

HERE = Path(__file__).resolve().parent
DOCX = HERE / "audit-doma-karkas-2026-11-16.docx"
doc = Document(DOCX)

heads = {"Heading 1": [], "Heading 2": [], "Heading 3": []}
for par in doc.paragraphs:
    if par.style.name in heads:
        heads[par.style.name].append(par.text.strip())

print("Heading 1:", len(heads["Heading 1"]))
for h in heads["Heading 1"]:
    print("  -", h)
print("Heading 2:", len(heads["Heading 2"]))
print("Heading 3:", len(heads["Heading 3"]))
print("таблиц:", len(doc.tables), "| строк всего:", sum(len(t.rows) for t in doc.tables))
print("параграфов:", len(doc.paragraphs))

# полнота частей: контрольные фразы из каждого отчёта
checks = {
    "Часть I (Метрика)": "Настройки счётчика",
    "Часть I (цели)": "Дубли и цели-ловушки",
    "Часть II (Директ)": "Кампании: расход → заказы → оплаты",
    "Часть II (сливы)": "Минус-слова",
    "Часть III (бренд)": "Свой бренд в минус-словах",
    "Часть III (спрос)": "Незакрытый спрос: каркасные дома",
    "Часть IV (воронка)": "Воронка за 90 дней",
    "Часть IV (сайт)": "Что делать на сайте",
    "Резюме": "Резюме аудита",
}
full_text = "\n".join(p.text for p in doc.paragraphs) + "\n" + "\n".join(
    cell.text for t in doc.tables for row in t.rows for cell in row.cells)
missing = [name for name, needle in checks.items() if needle not in full_text]
print("\nконтрольные разделы — не найдено:", missing or "нет, всё на месте")

# пустые ячейки в таблицах
empty = sum(1 for t in doc.tables for row in t.rows for cell in row.cells if not cell.text.strip())
print("пустых ячеек в таблицах:", empty)

# ширина таблиц не должна превышать ширину страницы
from docx.shared import Cm
width_cm = (doc.sections[0].page_width - doc.sections[0].left_margin - doc.sections[0].right_margin) / 360000
print(f"доступная ширина текста: {width_cm:.1f} см")

report = {"headings": {k: len(v) for k, v in heads.items()}, "tables": len(doc.tables),
          "empty_cells": empty, "missing_sections": missing, "text_width_cm": round(width_cm, 1),
          "h1_titles": heads["Heading 1"]}
(HERE / "docx-verify.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")