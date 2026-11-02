#!/usr/bin/env python3
r"""client_report.py - branded report for one client (MD + XLSX + DOCX + PDF).

Header carries the client name, its logo and the accent colour from the client
config; the body reuses the engine's nine sections (build_weekly_report) and adds
an honest "sources and statuses" table plus a month-over-month block.

PDF is produced from the DOCX through the bundled LibreOffice Kit:
    node <libreoffice-kit cli> convert --input report.docx --output report.pdf
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cwlib as cw
import build_weekly_report as bwr
import clients as clients_mod

NODE_CANDIDATES = (
    Path(os.environ.get("USERPROFILE", "")) / ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe",
    Path(r"C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"),
)
LO_KIT_CLI = Path(r"C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js")

TRUTH_LABELS = {"ok": "получилось", "needs_browser": "нужен браузер",
                "needs_partnership": "требует партнёрства", "no_data": "нет данных на странице",
                "skipped": "выключен в конфиге", "blocked": "нет снимка"}


def _hex_to_rgb(value):
    value = str(value or "#7553ff").lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def brand_header(client, date, period_text, sources_summary):
    """MD-шапка: имя клиента, логотип, акцент."""
    brand = clients_mod.brand_of(client)
    lines = ["# %s — %s" % (client.get("name"), clients_mod.report_of(client)["title"]), ""]
    if brand.get("logo_path"):
        lines.append("![логотип](%s)" % Path(brand["logo_path"]).as_posix())
        lines.append("")
    lines.append("_Клиент: **%s** (%s) · отчёт за %s · акцент %s_"
                 % (client.get("name"), client.get("client_id"), period_text, brand["accent"]))
    lines.append("")
    lines.append("| Источник | Статус | Лотов | Проектов | Комментарий |")
    lines.append("| --- | --- | --- | --- | --- |")
    for item in sources_summary:
        lots = "—" if item.get("lots") is None else item["lots"]
        lines.append("| %s | %s | %s | %s | %s |"
                     % (item.get("name") or item.get("source"),
                        TRUTH_LABELS.get(item.get("status"), item.get("status") or "—"),
                        lots, "—" if item.get("projects") is None else item["projects"],
                        (item.get("note") or "").replace("|", "/")))
    lines.append("")
    return lines


def month_block(month_summary):
    """Раздел «что изменилось за месяц» (или честное «сравнивать не с чем»)."""
    lines = ["", "## Что изменилось за месяц", ""]
    if not month_summary or not month_summary.get("has_baseline"):
        lines.append("_Базового снимка месячной давности нет — сравнивать не с чем, "
                     "блок появится после накопления истории._")
        return lines
    totals = month_summary["totals"]
    lines.append("Сравнение с снимком %s (месяц назад)." % month_summary.get("prev_date"))
    lines.append("")
    lines.append("| Показатель | Месяц назад | Сейчас | Δ |")
    lines.append("| --- | --- | --- | --- |")
    lines.append("| Лотов в продаже | %s | %s | %+d |"
                 % (totals.get("prev_active"), totals.get("curr_active"),
                    (totals.get("curr_active") or 0) - (totals.get("prev_active") or 0)))
    lines.append("| Медиана ₽/м² | %s | %s | %s |"
                 % (cw.fmt_money(totals.get("median_ppm2_prev")), cw.fmt_money(totals.get("median_ppm2_curr")),
                    cw.fmt_pct(totals.get("delta_median_ppm2_pct"))))
    lines.append("| Новых лотов | — | %d | |" % (totals.get("new_lots") or 0))
    lines.append("| Ушедших лотов | — | %d | |" % (totals.get("gone_lots") or 0))
    lines.append("")
    if month_summary.get("price_changes"):
        lines.append("Изменения цен за месяц (топ-5):")
        lines.append("")
        lines.append("| Проект | Лот | Было ₽ | Стало ₽ | Δ% |")
        lines.append("| --- | --- | --- | --- | --- |")
        for change in month_summary["price_changes"][:5]:
            lines.append("| %s | %s | %s | %s | %s |"
                         % (change.get("project"), change.get("lot_id"),
                            cw.fmt_money(change.get("price_prev_rub")),
                            cw.fmt_money(change.get("price_curr_rub")),
                            cw.fmt_pct(change.get("delta_pct"))))
    if month_summary.get("promo_new"):
        lines.append("")
        lines.append("Новые акции за месяц: %d." % len(month_summary["promo_new"]))
    if month_summary.get("by_source"):
        lines.append("")
        lines.append("Динамика предложения по источникам:")
        lines.append("")
        lines.append("| Источник | Месяц назад | Сейчас | Δ |")
        lines.append("| --- | --- | --- | --- |")
        for row in month_summary["by_source"]:
            lines.append("| %s | %d | %d | %+d |"
                         % (row["source"], row["prev"], row["curr"], row["curr"] - row["prev"]))
    return lines


def _docx_document():
    from docx import Document
    return Document()


def _add_table(doc, header, rows):
    table = doc.add_table(rows=1, cols=len(header))
    table.style = "Table Grid"
    for index, title in enumerate(header):
        table.cell(0, index).text = str(title)
    for row in rows:
        cells = table.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = "" if value is None else str(value)
    return table


def build_docx(client, payload, sources_summary, month_summary, out_path):
    from docx.shared import Cm, Pt, RGBColor

    brand = clients_mod.brand_of(client)
    accent = _hex_to_rgb(brand["accent"])
    doc = _docx_document()
    heading = doc.add_heading("%s — %s" % (client.get("name"), clients_mod.report_of(client)["title"]), level=1)
    for run in heading.runs:
        run.font.color.rgb = RGBColor(*accent)
    if brand.get("logo_path"):
        try:
            doc.add_picture(str(brand["logo_path"]), width=Cm(3.5))
        except Exception:
            pass
    totals = payload["totals"]
    doc.add_paragraph("Клиент: %s (%s). Период: %s — %s."
                      % (client.get("name"), client.get("client_id"),
                         payload["totals"].get("prev_date") or "нет", totals["curr_date"]))
    doc.add_paragraph("Лотов в продаже: %d · медиана ₽/м²: %s · новых лотов: %d · ушедших: %d"
                      % (totals["curr_active"], cw.fmt_money(totals["median_ppm2_curr"]),
                         totals["new_lots"], totals["gone_lots"]))
    paragraph = doc.add_paragraph("Источники и честные статусы сбора")
    paragraph.runs[0].bold = True
    paragraph.runs[0].font.color.rgb = RGBColor(*accent)
    _add_table(doc, ["Источник", "Статус", "Лотов", "Проектов", "Комментарий"],
               [[item.get("name"), TRUTH_LABELS.get(item.get("status"), item.get("status")),
                 item.get("lots"), item.get("projects"), item.get("note")]
                for item in sources_summary])
    paragraph = doc.add_paragraph("Цены: медиана ₽/м² по проектам")
    paragraph.runs[0].bold = True
    paragraph.runs[0].font.color.rgb = RGBColor(*accent)
    _add_table(doc, ["Проект", "Лотов", "Медиана ₽/м²", "Медиана неделю назад", "Δ медианы"],
               [[row["project"], row["active_curr"], cw.fmt_money(row["median_ppm2_curr"]),
                 cw.fmt_money(row["median_ppm2_prev"]), cw.fmt_pct(row["delta_median_pct"])]
                for row in bwr.stats_rows(payload)])
    if payload.get("price_changes"):
        paragraph = doc.add_paragraph("Изменения цен по лотам")
        paragraph.runs[0].bold = True
        paragraph.runs[0].font.color.rgb = RGBColor(*accent)
        _add_table(doc, ["Проект", "Лот", "Было ₽", "Стало ₽", "Δ%"],
                   [[row["project"], row["lot_id"], cw.fmt_money(row["price_prev_rub"]),
                     cw.fmt_money(row["price_curr_rub"]), cw.fmt_pct(row["delta_pct"])]
                    for row in payload["price_changes"]])
    promo_rows = list(payload["promo_new"]) + list(payload["promo_changed"]) + list(payload["promo_ended"])
    if promo_rows:
        paragraph = doc.add_paragraph("Акции и промо")
        paragraph.runs[0].bold = True
        paragraph.runs[0].font.color.rgb = RGBColor(*accent)
        _add_table(doc, ["Проект", "Текст акции", "Статус"],
                   [[row["project"], row["promo_text"], row["status"]] for row in promo_rows])
    if month_summary:
        paragraph = doc.add_paragraph("Что изменилось за месяц")
        paragraph.runs[0].bold = True
        paragraph.runs[0].font.color.rgb = RGBColor(*accent)
        if not month_summary.get("has_baseline"):
            doc.add_paragraph("Базового снимка месячной давности нет — сравнивать не с чем.")
        else:
            month_totals = month_summary["totals"]
            doc.add_paragraph("Сравнение со снимком %s." % month_summary.get("prev_date"))
            _add_table(doc, ["Показатель", "Месяц назад", "Сейчас", "Δ"],
                       [["Лотов в продаже", month_totals.get("prev_active"), month_totals.get("curr_active"),
                         (month_totals.get("curr_active") or 0) - (month_totals.get("prev_active") or 0)],
                        ["Медиана ₽/м²", cw.fmt_money(month_totals.get("median_ppm2_prev")),
                         cw.fmt_money(month_totals.get("median_ppm2_curr")),
                         cw.fmt_pct(month_totals.get("delta_median_ppm2_pct"))]])
    doc.add_paragraph("Отчёт сгенерирован автоматически. Данные собраны с публичных страниц "
                      "без входа в аккаунты; чего нет на странице — остаётся пустым.")
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            run.font.size = Pt(10)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    return out_path


def docx_to_pdf(docx_path, pdf_path, node_exe=None, cli=None, timeout=180):
    """PDF через встроенный LibreOffice Kit (единственный поддерживаемый путь)."""
    node = Path(node_exe) if node_exe else next((path for path in NODE_CANDIDATES if path.exists()), None)
    if node is None:
        node = Path(shutil.which("node") or "")
    kit = Path(cli) if cli else LO_KIT_CLI
    if not node or not Path(node).exists() or not kit.exists():
        raise RuntimeError("нет node или libreoffice-kit cli")
    docx_path = Path(docx_path)
    pdf_path = Path(pdf_path)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    if pdf_path.exists():
        pdf_path.unlink()      # LibreOffice Kit не перезаписывает существующий файл
    completed = subprocess.run([str(node), str(kit), "convert", "--input", str(docx_path),
                                "--output", str(pdf_path)],
                               capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=timeout)
    if completed.returncode != 0 or not pdf_path.exists():
        raise RuntimeError("LibreOffice Kit вернул код %d: %s"
                           % (completed.returncode, (completed.stderr or completed.stdout or "")[:200]))
    with open(pdf_path, "rb") as handle:
        signature = handle.read(5)
    if signature != b"%PDF-":
        raise RuntimeError("файл не похож на PDF: сигнатура %r" % signature)
    return pdf_path


def build_client_report(client, payload, curr_rows, sources_summary, month_summary, out_dir, date):
    """Собирает md/xlsx/docx/pdf клиента. Возвращает пути и проблемы."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    formats = clients_mod.report_of(client)["formats"]
    written = {}
    problems = []

    body = bwr.build_markdown(payload, curr_rows, None, out_dir / ".cache" / ("limitations-%s.md" % date))
    period = payload["totals"].get("prev_date") or "нет"
    header = "\n".join(brand_header(client, date, "%s — %s" % (period, date), sources_summary))
    month = "\n".join(month_block(month_summary))
    md_path = out_dir / ("%s-competitor-watch.md" % date)
    cw.write_text(md_path, header + "\n" + body + "\n" + month + "\n")
    written["md"] = md_path

    if "xlsx" in formats:
        xlsx_path = out_dir / ("%s-competitor-watch.xlsx" % date)
        bwr.build_xlsx(payload, curr_rows, xlsx_path,
                       settings_note="собрано Агентом 1 из публичных страниц без логина")
        written["xlsx"] = xlsx_path

    if "pdf" in formats or "docx" in formats:
        docx_path = out_dir / ("%s-competitor-watch.docx" % date)
        try:
            build_docx(client, payload, sources_summary, month_summary, docx_path)
            written["docx"] = docx_path
        except Exception as exc:
            problems.append("DOCX не собран: %s" % exc)
        if "pdf" in formats and docx_path.exists():
            try:
                written["pdf"] = docx_to_pdf(docx_path, out_dir / ("%s-competitor-watch.pdf" % date))
            except Exception as exc:
                problems.append("PDF не собран: %s" % exc)
    return {"files": written, "problems": problems}
