# -*- coding: utf-8 -*-
"""Проверка собранной презентации: границы, состав, оценка переполнения таблиц."""
from __future__ import annotations

import json
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu, Inches

HERE = Path(__file__).resolve().parent
PPTX = HERE / "audit-doma-karkas-2026-11-16.pptx"
prs = Presentation(PPTX)
SW = prs.slide_width / 914400
SH = prs.slide_height / 914400
print(f"слайдов: {len(prs.slides)}; размер {SW:.2f}x{SH:.2f} дюйма")

problems: list[str] = []
for idx, slide in enumerate(prs.slides, start=1):
    texts = []
    for shape in slide.shapes:
        left, top = shape.left / 914400, shape.top / 914400
        width, height = shape.width / 914400, shape.height / 914400
        if shape.has_text_frame and shape.text_frame.text.strip():
            texts.append(shape.text_frame.text.strip()[:60])
        if left < -0.01 or top < -0.01 or left + width > SW + 0.01:
            problems.append(f"слайд {idx}: фигура выходит по горизонтали ({left:.2f}+{width:.2f})")
        if shape.has_table:
            table = shape.table
            needs = 0.0
            for r, row in enumerate(table.rows):
                row_need = 0.0
                for c, cell in enumerate(row.cells):
                    col_w = table.columns[c].width / 914400
                    chars_per_line = max(int(col_w * 11 / 0.075), 6)
                    lines = max(1, -(-len(cell.text) // chars_per_line))
                    size = 12
                    if cell.text_frame.paragraphs and cell.text_frame.paragraphs[0].runs:
                        size = cell.text_frame.paragraphs[0].runs[0].font.size.pt if cell.text_frame.paragraphs[0].runs[0].font.size else 12
                    need = lines * (size * 1.5 / 72) + 0.06
                    row_need = max(row_need, need)
                needs += row_need
            bottom = top + max(needs, height)
            if bottom > SH + 0.02:
                problems.append(f"слайд {idx}: таблица может переполнить слайд — низ {bottom:.2f} при {SH:.2f} "
                                f"(строк {len(table.rows)}, задано {height:.2f})")
        elif top + height > SH + 0.02 and shape.has_text_frame and shape.text_frame.text.strip():
            problems.append(f"слайд {idx}: текстовый блок ниже границы — низ {top+height:.2f}")
    if not texts:
        problems.append(f"слайд {idx}: нет текста")

print("\nсодержимое слайдов:")
for idx, slide in enumerate(prs.slides, start=1):
    head = ""
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip():
            head = shape.text_frame.text.strip().split("\n")[0]
            break
    print(f"  {idx:>2}. {head[:80]}")

print("\nпроблемы:", len(problems))
for p in problems:
    print("  !", p)

# проверка, что в таблицах есть данные и нет пустых ячеек-заглушек
empty = 0
for idx, slide in enumerate(prs.slides, start=1):
    for shape in slide.shapes:
        if shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    if not cell.text.strip():
                        empty += 1
print("пустых ячеек в таблицах:", empty)
(PPTX.parent / "pptx-verify.json").write_text(
    json.dumps({"slides": len(prs.slides), "problems": problems, "empty_cells": empty}, ensure_ascii=False, indent=1),
    encoding="utf-8")
