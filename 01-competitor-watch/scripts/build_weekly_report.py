#!/usr/bin/env python3
r"""build_weekly_report.py - weekly competitor report (Markdown + XLSX).

Usage (Windows PowerShell):
    <python> build_weekly_report.py --curr 2026-10-30 --prev 2026-10-23
    <python> build_weekly_report.py --curr 2026-10-30 --prev 2026-10-23 --formats md,xlsx --telegram
    <python> build_weekly_report.py --curr tests\fixtures\week-2026-10-30\lots.csv ^
                                    --prev tests\fixtures\week-2026-10-23\lots.csv ^
                                    --reports-dir reports\2026-10-30-demo

Outputs:
    reports\<curr>-competitor-watch.md    - 9 fixed sections (see SECTIONS)
    reports\<curr>-competitor-watch.xlsx  - sheets: Сводка, Цены, Изменения, Акции, Лоты
    reports\.cache\diff-<curr>.json       - same machine-readable diff as diff_snapshots.py

--prev is optional: without it the report is built without week-over-week columns.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys
from collections import Counter
from pathlib import Path

import cwlib as cw
from diff_snapshots import compute_diff, diff_cache_path, load_snapshot_for_ref, lot_brief

SECTIONS = (
    "1. Заголовок и охват",
    "2. Главное за неделю",
    "3. Цены: медиана ₽/м² по проектам",
    "4. Изменения цен по лотам",
    "5. Акции и промо",
    "6. Предложение: лоты в продаже, приход и уход",
    "7. Срез по комнатности",
    "8. Выводы и рекомендации",
    "9. Ограничения и что не удалось собрать",
)

MONEY_FMT = '#,##0" ₽"'
PCT_FMT = '0.00"%"'
AREA_FMT = "0.0"
DASH = "—"

LOT_HEADERS_RU = [
    "Дата снимка", "Источник", "Конкурент", "Проект", "ID лота", "Ссылка",
    "Комнат", "Площадь, м²", "Этаж", "Этажей", "Корпус", "Цена, ₽", "₽/м²",
    "Отделка", "Акция", "Текст акции", "Сдача", "Статус",
]

# Effective settings for this run: settings.yaml (or defaults) drive the report text.
_REPORT_SETTINGS = {
    "price_round_to_rub": 0,
    "pct_decimals": 2,
    "lot_count_change_abs": 1,
}
_fmt_money_raw = cw.fmt_money
_fmt_pct_raw = cw.fmt_pct


def configure_report(config):
    """Apply settings.yaml values to the report formatting."""
    config = config or {}
    _REPORT_SETTINGS["price_round_to_rub"] = int(config.get("price_round_to_rub") or 0)
    digits = config.get("pct_decimals")
    _REPORT_SETTINGS["pct_decimals"] = 2 if digits is None else int(digits)
    _REPORT_SETTINGS["lot_count_change_abs"] = int(config.get("lot_count_change_abs") or 1)
    return _REPORT_SETTINGS


def money(value):
    """Money formatted with units.price_round_to_rub."""
    return _fmt_money_raw(value, _REPORT_SETTINGS["price_round_to_rub"])


def pct(value, digits=None):
    """Percent formatted with units.pct_decimals."""
    if digits is None:
        digits = _REPORT_SETTINGS["pct_decimals"]
    return _fmt_pct_raw(value, digits)


def stats_rows(payload):
    """Projects that pass thresholds.min_lots_for_stats."""
    return [row for row in payload["price_by_project"] if not row.get("stats_excluded")]


def settings_line(config, sections_expected):
    """«Настройки: ...» line for the top of the report."""
    round_to = config.get("price_round_to_rub") or 0
    rounding = ("округление %s ₽" % cw.fmt_int(round_to)) if round_to else "без округления цен"
    source = config.get("config_source")
    if source == "settings.yaml":
        origin = "источник: %s" % rel_path(config.get("config_path"))
    elif source == "no-config":
        origin = "источник: значения по умолчанию (--no-config)"
    else:
        origin = "источник: значения по умолчанию (settings.yaml не прочитан)"
    return ("_Настройки: порог %s%%, %s, минимум лотов для статистики %s, режим сравнения %s, "
            "знаков в процентах %s, разделов отчёта %d. %s._"
            % (cw.fmt_num(config.get("price_change_pct"), 2), rounding,
               config.get("min_lots_for_stats"), config.get("compare_mode"),
               config.get("pct_decimals"), sections_expected, origin))


# --------------------------------------------------------------------------
# small formatting helpers
# --------------------------------------------------------------------------

def ru_date(iso_date):
    if not iso_date:
        return DASH
    parts = str(iso_date).split("-")
    if len(parts) == 3:
        return "%s.%s.%s" % (parts[2], parts[1], parts[0])
    return str(iso_date)


def cell(value):
    """Markdown-safe table cell."""
    if value is None or value == "":
        return DASH
    return str(value).replace("|", "\\|").replace("\n", " ")


def period_text(payload):
    totals = payload["totals"]
    if not totals["has_prev"]:
        return "недельный срез на %s (предыдущий снимок не найден)" % ru_date(totals["curr_date"])
    return "%s → %s" % (ru_date(totals["prev_date"]), ru_date(totals["curr_date"]))


def _group_counts(items, key):
    counter = Counter()
    for item in items:
        counter[item.get(key) or DASH] += 1
    return counter


def plural(count, one, few, many):
    """Russian plural form: 1 лот / 2 лота / 5 лотов."""
    count = int(count)
    if count % 10 == 1 and count % 100 != 11:
        return one
    if count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14):
        return few
    return many


def rel_path(path):
    """Path relative to the project folder when possible (nicer inside the report)."""
    try:
        return Path(path).resolve().relative_to(cw.PROJECT_DIR).as_posix()
    except ValueError:
        return str(path)


# --------------------------------------------------------------------------
# narrative parts
# --------------------------------------------------------------------------

def build_highlights(payload):
    """3-7 bullet points for section 2, generated from the numbers."""
    totals = payload["totals"]
    threshold = cw.fmt_num(totals["threshold_pct"], 2)
    items = []

    changes = payload["price_changes"]
    if changes:
        top_up = max(changes, key=lambda c: c["delta_pct"])
        items.append(
            "Рост цены: %s, лот %s — %s → %s (%s, %s)."
            % (cell(top_up["project"]), cell(top_up["lot_id"]),
               money(top_up["price_prev_rub"]), money(top_up["price_curr_rub"]),
               money(top_up["delta_rub"]), pct(top_up["delta_pct"]))
        )
        top_down = min(changes, key=lambda c: c["delta_pct"])
        if top_down["delta_pct"] < 0:
            items.append(
                "Снижение цены: %s, лот %s — %s → %s (%s, %s)."
                % (cell(top_down["project"]), cell(top_down["lot_id"]),
                   money(top_down["price_prev_rub"]), money(top_down["price_curr_rub"]),
                   money(top_down["delta_rub"]), pct(top_down["delta_pct"]))
            )
    else:
        items.append(
            "Изменений цен выше порога %s%% не зафиксировано — прайс-листы конкурентов стабильны."
            % threshold
        )

    min_change = int(_REPORT_SETTINGS.get("lot_count_change_abs") or 1)
    if totals["new_lots"]:
        by_project = _group_counts(payload["new_lots"], "project")
        notable = {name: count for name, count in by_project.items() if count >= min_change}
        if notable:
            detail = ", ".join("%s — %d" % (name, count) for name, count in sorted(notable.items()))
            items.append("Новые лоты в продаже: %d (%s)." % (sum(notable.values()), detail))
        else:
            items.append("Новые лоты: %d, но приход меньше порога внимания (%d на проект) — подробности в разделе 6."
                         % (totals["new_lots"], min_change))
    else:
        items.append("Новых лотов за неделю не появилось.")

    if totals["gone_lots"]:
        by_project = _group_counts(payload["gone_lots"], "project")
        notable = {name: count for name, count in by_project.items() if count >= min_change}
        suffix = ""
        if totals["gone_lots_inactive"]:
            suffix = "; из них со статусом не active: %d" % totals["gone_lots_inactive"]
        if notable:
            detail = ", ".join("%s — %d" % (name, count) for name, count in sorted(notable.items()))
            items.append("Ушедшие лоты: %d (%s)%s." % (sum(notable.values()), detail, suffix))
        else:
            items.append("Ушедшие лоты: %d, но уход меньше порога внимания (%d на проект)%s."
                         % (totals["gone_lots"], min_change, suffix))
    else:
        items.append("Ушедших лотов за неделю нет.")

    if totals["promo_new"] or totals["promo_changed"] or totals["promo_ended"]:
        items.append(
            "Акции: новых %d, изменился текст у %d, закончились %d."
            % (totals["promo_new"], totals["promo_changed"], totals["promo_ended"])
        )
    else:
        items.append("Акции и промо без изменений.")

    if totals["delta_median_ppm2_pct"] is not None:
        items.append(
            "Медиана ₽/м² по рынку: %s (%s к прошлой неделе)."
            % (money(totals["median_ppm2_curr"]), pct(totals["delta_median_ppm2_pct"]))
        )
    else:
        items.append("Медиана ₽/м² по рынку: %s." % money(totals["median_ppm2_curr"]))

    moved = [p for p in stats_rows(payload) if p["delta_median_pct"] is not None]
    if moved:
        leader = max(moved, key=lambda p: abs(p["delta_median_pct"]))
        if abs(leader["delta_median_pct"]) >= 0.5:
            items.append(
                "Сильнее всего медиана изменилась в «%s»: %s."
                % (cell(leader["project"]), pct(leader["delta_median_pct"]))
            )

    if totals["prev_active"] is not None:
        items.append(
            "В продаже %d лотов в %d проектах (неделю назад %d, Δ %+d)."
            % (totals["curr_active"], len(totals["projects"]), totals["prev_active"],
               totals["curr_active"] - totals["prev_active"])
        )

    prices = [r.get("price_rub") for r in payload.get("_curr_rows", []) if r.get("price_rub")]
    if prices:
        items.append("Диапазон цен в снимке: %s — %s."
                     % (money(min(prices)), money(max(prices))))

    return items[:7]


def build_recommendations(payload):
    """3-6 template recommendations for section 8."""
    totals = payload["totals"]
    threshold = cw.fmt_num(totals["threshold_pct"], 2)
    recs = []

    grew = sorted([p for p in stats_rows(payload) if (p["delta_median_pct"] or 0) > 0],
                  key=lambda p: p["delta_median_pct"], reverse=True)
    if grew:
        top = grew[0]
        recs.append(
            "«%s»: медиана ₽/м² %s за неделю. Сверьте наши цены и офферы с рынком по этому проекту — "
            "если мы дешевле медианы, есть запас для повышения ставки."
            % (cell(top["project"]), pct(top["delta_median_pct"]))
        )

    fell = sorted([p for p in stats_rows(payload) if (p["delta_median_pct"] or 0) < 0],
                  key=lambda p: p["delta_median_pct"])
    if fell:
        top = fell[0]
        recs.append(
            "«%s»: медиана ₽/м² %s. Возможен демпинг — проверьте акции конкурента и подготовьте "
            "контр-оффер или усильте УТП в объявлениях."
            % (cell(top["project"]), pct(top["delta_median_pct"]))
        )

    if totals["promo_new"] or totals["promo_changed"]:
        recs.append(
            "Акции: %d новых или обновлённых. Обновите тексты объявлений и добавьте в кампании "
            "сообщение про скидку/ипотеку по этим проектам."
            % (totals["promo_new"] + totals["promo_changed"])
        )
    if totals["promo_ended"]:
        recs.append(
            (plural(totals["promo_ended"], "Закончилась %d акция", "Закончились %d акции",
                    "Закончилось %d акций")
             + " — окно для нашей промо-активности, пока конкуренты не вернули скидки.")
            % totals["promo_ended"]
        )
    if totals["new_lots"]:
        projects = ", ".join(sorted(_group_counts(payload["new_lots"], "project")))
        recs.append(
            (plural(totals["new_lots"], "Пришёл %d новый лот", "Пришли %d новых лота",
                    "Пришли %d новых лотов")
             + " (%s). Расширьте семантику и объявления по этим проектам, проверьте пересечения по ключам.")
            % (totals["new_lots"], projects)
        )
    if totals["gone_lots"]:
        recs.append(
            (plural(totals["gone_lots"], "Ушёл %d лот", "Ушли %d лота", "Ушли %d лотов")
             + " — проверьте перераспределение спроса и усильте кампании по освободившимся "
               "проектам, пока конкуренты не перестроили предложение.") % totals["gone_lots"]
        )

    empty_buckets = [r["rooms_label"] for r in payload["rooms_price"] if r["count_curr"] == 0]
    if empty_buckets:
        recs.append(
            "В срезе нет лотов по комнатности: %s. Либо сегмент не представлен у конкурентов, "
            "либо данные не собраны — проверьте источники." % ", ".join(empty_buckets)
        )
    if totals["price_changes_below_threshold"]:
        recs.append(
            (plural(totals["price_changes_below_threshold"], "Есть %d изменение цены",
                    "Есть %d изменения цены", "Есть %d изменений цены")
             + " ниже порога %s%% — держите на контроле: на следующей неделе возможен выход за порог.")
            % (totals["price_changes_below_threshold"], threshold)
        )

    padding = [
        "Сверьте наши цены с медианой ₽/м² по каждому проекту: отклонение больше 5% — повод пересмотреть ставку.",
        "Держите ритм мониторинга: снимайте снимок в один и тот же день недели, иначе diff несопоставим.",
        "Проверьте, что в кампаниях по проектам с новыми акциями конкурента есть отдельный оффер и он виден в объявлении.",
    ]
    for extra in padding:
        if len(recs) >= 3:
            break
        recs.append(extra)
    return recs[:6]


def read_limitations(reports_dir, curr_date):
    path = Path(reports_dir) / cw.CACHE_DIR_NAME / ("limitations-%s.md" % curr_date)
    if path.exists():
        text = path.read_text(encoding="utf-8").strip()
        if text:
            return text, path
    return None, path


# --------------------------------------------------------------------------
# markdown
# --------------------------------------------------------------------------

def build_markdown(payload, curr_rows, limitations_text, limitations_path,
                   settings_text=None, notices=None):
    totals = payload["totals"]
    lines = []
    add = lines.append

    add("# Недельный обзор конкурентов — %s" % totals["curr_date"])
    add("")
    if settings_text:
        add(settings_text)
        add("")
    add("_Сгенерировано автоматически: скрипт build_weekly_report.py, порог значимости цены %s%%._"
        % cw.fmt_num(totals["threshold_pct"], 2))
    add("")

    # 1 ---------------------------------------------------------------
    add("## " + SECTIONS[0])
    add("")
    add("| Параметр | Значение |")
    add("| --- | --- |")
    add("| Период | %s |" % period_text(payload))
    add("| Дата отчёта | %s |" % ru_date(totals["curr_date"]))
    add("| Конкуренты | %d: %s |" % (len(totals["competitors"]), cell(", ".join(totals["competitors"]))))
    add("| Проекты | %d: %s |" % (len(totals["projects"]), cell(", ".join(totals["projects"]))))
    add("| Лотов в снимке | %d (в продаже %d) |" % (totals["curr_lots"], totals["curr_active"]))
    if totals["has_prev"]:
        add("| Лотов неделю назад | %d (в продаже %d) |" % (totals["prev_lots"], totals["prev_active"]))
    else:
        add("| Лотов неделю назад | %s |" % DASH)
    add("| Порог значимости цены | %s%% |" % cw.fmt_num(totals["threshold_pct"], 2))
    add("")

    # 2 ---------------------------------------------------------------
    add("## " + SECTIONS[1])
    add("")
    for item in build_highlights(payload):
        add("- %s" % item)
    add("")

    # 3 ---------------------------------------------------------------
    add("## " + SECTIONS[2])
    add("")
    add("| Конкурент | Проект | Лотов в продаже | Медиана ₽/м² | Среднее ₽/м² | Медиана неделю назад | Δ медианы |")
    add("| --- | --- | --- | --- | --- | --- | --- |")
    for row in stats_rows(payload):
        add("| %s | %s | %d | %s | %s | %s | %s |" % (
            cell(row["competitor"]), cell(row["project"]), row["active_curr"],
            money(row["median_ppm2_curr"]), money(row["mean_ppm2_curr"]),
            money(row["median_ppm2_prev"]), pct(row["delta_median_pct"])))
    add("| **Итого по рынку** |  | **%d** | **%s** | **%s** | **%s** | **%s** |" % (
        totals["curr_active"], money(totals["median_ppm2_curr"]), money(totals["mean_ppm2_curr"]),
        money(totals["median_ppm2_prev"]), pct(totals["delta_median_ppm2_pct"])))
    add("")
    add("_Медиана и среднее считаются по лотам со статусом active, у которых заполнены цена и площадь._")
    excluded = [row["project"] for row in payload["price_by_project"] if row.get("stats_excluded")]
    if excluded:
        add("")
        add("_Ниже порога статистики (минимум %s лотов, thresholds.min_lots_for_stats) в таблицу не попали: %s._"
            % (totals.get("min_lots_for_stats"), ", ".join(cell(name) for name in excluded)))
    add("")

    # 4 ---------------------------------------------------------------
    add("## " + SECTIONS[3])
    add("")
    if payload["price_changes"]:
        # Columns 1-7 are fixed by the report contract; the lot id is appended so the
        # marketer can tell apart lots with the same project, rooms and area.
        add("| Проект | Комнатность | Площадь, м² | Было ₽ | Стало ₽ | Δ₽ | Δ% | ID лота |")
        add("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for row in payload["price_changes"]:
            add("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
                cell(row["project"]), cell(row["rooms_label"]), cw.fmt_num(row["area_m2"], 1),
                money(row["price_prev_rub"]), money(row["price_curr_rub"]),
                money(row["delta_rub"]), pct(row["delta_pct"]), cell(row["lot_id"])))
    else:
        add("_Изменений цен выше порога %s%% нет._" % cw.fmt_num(totals["threshold_pct"], 2))
    if totals["price_changes_below_threshold"]:
        add("")
        add("_Ниже порога (в таблицу не попали): %s._"
            % (plural(totals["price_changes_below_threshold"], "%d изменение", "%d изменения",
                      "%d изменений") % totals["price_changes_below_threshold"]))
    add("")

    # 5 ---------------------------------------------------------------
    add("## " + SECTIONS[4])
    add("")
    promo_rows = list(payload["promo_new"]) + list(payload["promo_changed"]) + list(payload["promo_ended"])
    if promo_rows:
        add("| Проект | Текст акции | Статус |")
        add("| --- | --- | --- |")
        for row in promo_rows:
            text = cell(row["promo_text"])
            if row["status"] == "изменилась" and row.get("promo_text_prev"):
                text = "%s (было: «%s»)" % (text, cell(row["promo_text_prev"]))
            add("| %s | %s | %s |" % (cell(row["project"]), text, cell(row["status"])))
    else:
        add("_Изменений по акциям и промо нет._")
    add("")

    # 6 ---------------------------------------------------------------
    add("## " + SECTIONS[5])
    add("")
    add("| Конкурент | Проект | Лотов в продаже | Неделю назад | Δ | Новые | Ушедшие |")
    add("| --- | --- | --- | --- | --- | --- | --- |")
    for row in payload["supply_by_project"]:
        delta = DASH if row["delta_active"] is None else "%+d" % row["delta_active"]
        add("| %s | %s | %d | %s | %s | %d | %d |" % (
            cell(row["competitor"]), cell(row["project"]), row["active_curr"],
            DASH if row["active_prev"] is None else row["active_prev"], delta,
            row["new_active"], row["gone"]))
    add("")
    if totals["prev_active"] is not None:
        add("Итого в продаже: **%d** %s (неделю назад %d, Δ %+d)."
            % (totals["curr_active"],
               plural(totals["curr_active"], "лот", "лота", "лотов"),
               totals["prev_active"], totals["curr_active"] - totals["prev_active"]))
    else:
        add("Итого в продаже: **%d** %s."
            % (totals["curr_active"], plural(totals["curr_active"], "лот", "лота", "лотов")))
    add("")

    # 7 ---------------------------------------------------------------
    add("## " + SECTIONS[6])
    add("")
    add("| Комнатность | Лотов в продаже | Медиана ₽/м² | Среднее ₽/м² | Медиана неделю назад |")
    add("| --- | --- | --- | --- | --- |")
    for row in payload["rooms_price"]:
        add("| %s | %d | %s | %s | %s |" % (
            cell(row["rooms_label"]), row["count_curr"], money(row["median_ppm2_curr"]),
            money(row["mean_ppm2_curr"]), money(row["median_ppm2_prev"])))
    add("")

    # 8 ---------------------------------------------------------------
    add("## " + SECTIONS[7])
    add("")
    for item in build_recommendations(payload):
        add("- %s" % item)
    add("")

    # 9 ---------------------------------------------------------------
    add("## " + SECTIONS[8])
    add("")
    add("Стандартные ограничения этого среза:")
    add("")
    add("- данные собраны из открытых источников (сайты застройщиков и агрегаторы), без доступа к закрытым прайс-листам;")
    add("- цены без учёта индивидуальных скидок, рассрочек и стоимости отделки;")
    add("- лот сопоставляется по ключу (source, competitor, project, lot_id); переименование лота в источнике выглядит как уход + приход;")
    add("- медианы и средние считаются по лотам со статусом active.")
    add("")
    if limitations_text:
        add("Из файла ограничений недели:")
        add("")
        for line in limitations_text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            add(stripped if stripped.startswith(("-", "*", "#")) else "- " + stripped)
    else:
        add("Файл ограничений недели (%s) не найден — специфичные для недели ограничения не зафиксированы."
            % rel_path(limitations_path))
    if notices:
        add("")
        add("Предупреждения движка:")
        add("")
        for notice in notices:
            add("- %s" % notice)
    add("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# telegram
# --------------------------------------------------------------------------

def build_telegram(payload, limit=900):
    totals = payload["totals"]
    parts = []
    parts.append("📊 Конкуренты, %s" % period_text(payload))
    parts.append("В продаже: %d %s, %d %s%s" % (
        totals["curr_active"], plural(totals["curr_active"], "лот", "лота", "лотов"),
        len(totals["projects"]), plural(len(totals["projects"]), "проект", "проекта", "проектов"),
        "" if totals["prev_active"] is None else " (было %d)" % totals["prev_active"]))
    parts.append("Новые: %d | Ушедшие: %d" % (totals["new_lots"], totals["gone_lots"]))
    parts.append("Цены: изменений выше %s%% — %d"
                 % (cw.fmt_num(totals["threshold_pct"], 2), totals["price_changes"]))
    parts.append("Медиана ₽/м²: %s (%s)" % (
        money(totals["median_ppm2_curr"]), pct(totals["delta_median_ppm2_pct"])))
    parts.append("Акции: новых %d, изменилось %d, закончилось %d"
                 % (totals["promo_new"], totals["promo_changed"], totals["promo_ended"]))
    highlights = build_highlights(payload)[:3]
    if highlights:
        parts.append("Главное:")
        for item in highlights:
            parts.append("• " + item)
    text = "\n".join(parts)
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


# --------------------------------------------------------------------------
# xlsx
# --------------------------------------------------------------------------

def _write_sheet(ws, headers, rows, number_formats=None):
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    ws.append(list(headers))
    for cell_obj in ws[1]:
        cell_obj.font = Font(bold=True)
        cell_obj.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for row in rows:
        ws.append(list(row))
    if number_formats:
        for column, fmt in number_formats.items():
            for row_index in range(2, ws.max_row + 1):
                ws.cell(row=row_index, column=column).number_format = fmt
    ws.freeze_panes = "A2"
    for column_cells in ws.columns:
        width = 8
        for cell_obj in column_cells:
            if cell_obj.value is None:
                continue
            width = max(width, len(str(cell_obj.value)))
        ws.column_dimensions[get_column_letter(column_cells[0].column)].width = min(width + 2, 42)


def build_xlsx(payload, curr_rows, path, settings_note=""):
    from openpyxl import Workbook

    totals = payload["totals"]
    workbook = Workbook()

    # --- Сводка --------------------------------------------------------
    summary = workbook.active
    summary.title = "Сводка"
    summary_rows = [
        ("Период", period_text(payload)),
        ("Дата отчёта", totals["curr_date"]),
        ("Конкуренты", len(totals["competitors"])),
        ("Проекты", len(totals["projects"])),
        ("Лотов в снимке", totals["curr_lots"]),
        ("Лотов в продаже", totals["curr_active"]),
        ("Лотов в продаже неделю назад", totals["prev_active"]),
        ("Новых лотов", totals["new_lots"]),
        ("Ушедших лотов", totals["gone_lots"]),
        ("Ушедших лотов со статусом не active", totals["gone_lots_inactive"]),
        ("Изменений цен выше порога", totals["price_changes"]),
        ("Изменений цен ниже порога", totals["price_changes_below_threshold"]),
        ("Новых акций", totals["promo_new"]),
        ("Акций изменилось", totals["promo_changed"]),
        ("Акций закончилось", totals["promo_ended"]),
        ("Медиана ₽/м²", totals["median_ppm2_curr"]),
        ("Медиана ₽/м² неделю назад", totals["median_ppm2_prev"]),
        ("Δ медианы, %", totals["delta_median_ppm2_pct"]),
        ("Среднее ₽/м²", totals["mean_ppm2_curr"]),
        ("Порог значимости, %", totals["threshold_pct"]),
        ("Минимум лотов для статистики", totals.get("min_lots_for_stats")),
        ("Настройки", settings_note),
    ]
    _write_sheet(summary, ["Показатель", "Значение"], summary_rows)
    for row_index in range(2, summary.max_row + 1):
        label = str(summary.cell(row=row_index, column=1).value)
        if "₽/м²" in label and "Δ" not in label:
            summary.cell(row=row_index, column=2).number_format = MONEY_FMT

    # --- Цены ----------------------------------------------------------
    prices = workbook.create_sheet("Цены")
    price_rows = [
        [row["competitor"], row["project"], row["active_curr"],
         row["active_prev"], row["median_ppm2_curr"], row["mean_ppm2_curr"],
         row["median_ppm2_prev"], row["delta_median_pct"]]
        for row in stats_rows(payload)
    ]
    price_rows.append(["Итого по рынку", "", totals["curr_active"], totals["prev_active"],
                       totals["median_ppm2_curr"], totals["mean_ppm2_curr"],
                       totals["median_ppm2_prev"], totals["delta_median_ppm2_pct"]])
    _write_sheet(
        prices,
        ["Конкурент", "Проект", "Лотов в продаже", "Лотов неделю назад",
         "Медиана ₽/м²", "Среднее ₽/м²", "Медиана неделю назад", "Δ медианы, %"],
        price_rows,
        {5: MONEY_FMT, 6: MONEY_FMT, 7: MONEY_FMT, 8: PCT_FMT},
    )

    # --- Изменения -----------------------------------------------------
    changes = workbook.create_sheet("Изменения")
    change_rows = [
        [row["competitor"], row["project"], row["lot_id"], row["rooms_label"], row["area_m2"],
         row["price_prev_rub"], row["price_curr_rub"], row["delta_rub"], row["delta_pct"],
         row["price_per_m2_prev_rub"], row["price_per_m2_curr_rub"]]
        for row in payload["price_changes"]
    ]
    _write_sheet(
        changes,
        ["Конкурент", "Проект", "ID лота", "Комнатность", "Площадь, м²", "Было, ₽", "Стало, ₽",
         "Δ, ₽", "Δ, %", "₽/м² было", "₽/м² стало"],
        change_rows,
        {5: AREA_FMT, 6: MONEY_FMT, 7: MONEY_FMT, 8: MONEY_FMT, 9: PCT_FMT, 10: MONEY_FMT, 11: MONEY_FMT},
    )

    # --- Акции ---------------------------------------------------------
    promos = workbook.create_sheet("Акции")
    promo_rows = [
        [row["competitor"], row["project"], row["lot_id"], row["promo_text"],
         row.get("promo_text_prev") or "", row["status"]]
        for row in (list(payload["promo_new"]) + list(payload["promo_changed"]) + list(payload["promo_ended"]))
    ]
    _write_sheet(promos, ["Конкурент", "Проект", "ID лота", "Текст акции", "Было", "Статус"], promo_rows)

    # --- Лоты ----------------------------------------------------------
    lots = workbook.create_sheet("Лоты")
    lot_rows = []
    for row in sorted(curr_rows, key=lambda r: (str(r.get("competitor") or ""), str(r.get("project") or ""),
                                                str(r.get("lot_id") or ""))):
        brief = lot_brief(row)
        lot_rows.append([
            row.get("snapshot_date"),
            brief["source"], brief["competitor"], brief["project"], brief["lot_id"], brief["url"],
            brief["rooms"], brief["area_m2"], brief["floor"], brief["floors_total"], brief["building"],
            brief["price_rub"], brief["price_per_m2_rub"], brief["finish"], brief["promo_flag"],
            brief["promo_text"], brief["delivery"], brief["status"],
        ])
    _write_sheet(lots, LOT_HEADERS_RU, lot_rows,
                 {8: AREA_FMT, 12: MONEY_FMT, 13: MONEY_FMT})

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)
    return path


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="build_weekly_report.py",
        description="Недельный отчёт по конкурентам: Markdown + XLSX из двух снимков.",
    )
    parser.add_argument("--curr", required=True, help="текущий снимок: дата, каталог или путь к lots.csv")
    parser.add_argument("--prev", default=None, help="предыдущий снимок (без него отчёт без сравнения)")
    parser.add_argument("--threshold", type=float, default=None,
                        help="порог значимости изменения цены, %% (по умолчанию thresholds.price_change_pct из settings.yaml, иначе 0.5)")
    parser.add_argument("--formats", default=None, help="что собрать: md,xlsx (по умолчанию output.formats из settings.yaml)")
    parser.add_argument("--telegram", action="store_true", help="напечатать короткую сводку для Telegram")
    parser.add_argument("--reports-dir", default=None, help="каталог отчётов (по умолчанию reports)")
    parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
    parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config (по умолчанию вычисляется от скрипта)")
    parser.add_argument("--no-config", action="store_true",
                        help="не читать settings.yaml, работать на значениях по умолчанию")
    return parser


def main(argv=None):
    cw.setup_console()
    args = build_parser().parse_args(argv)
    use_config = not args.no_config
    config = cw.load_config(args.config_dir, use_config=use_config)
    configure_report(config)

    formats_text = args.formats if args.formats else config["formats"]
    formats = {item.strip().lower() for item in str(formats_text).split(",") if item.strip()}
    unknown = formats - {"md", "xlsx"}
    if unknown:
        print("Ошибка: неизвестные форматы: %s (доступны md,xlsx)" % ", ".join(sorted(unknown)), file=sys.stderr)
        return 2

    reports_dir = cw.resolve_reports_dir(args.reports_dir, args.config_dir, use_config=use_config)
    snapshots_dir = cw.resolve_snapshots_dir(args.snapshots_dir, args.config_dir, use_config=use_config)
    threshold = args.threshold if args.threshold is not None else config["price_change_pct"]

    notices = []
    prev_rows = prev_date = prev_path = None
    try:
        curr_rows, curr_date, curr_path = load_snapshot_for_ref(args.curr, snapshots_dir)
        if args.prev:
            prev_rows, prev_date, prev_path = load_snapshot_for_ref(args.prev, snapshots_dir)
        else:
            auto_prev = cw.previous_snapshot_date(curr_date, snapshots_dir,
                                                  config["compare_mode"], config["period_days"])
            if auto_prev:
                prev_rows, prev_date, prev_path = load_snapshot_for_ref(auto_prev, snapshots_dir)
                print("Предыдущий снимок выбран автоматически (%s): %s"
                      % (config["compare_mode"], prev_date))
            elif config["compare_mode"] == "week_over_week":
                notices.append(
                    "Режим сравнения week_over_week: снимок ровно %s дней назад (%s) не найден — "
                    "отчёт построен без блока изменений."
                    % (config["period_days"], cw.shift_date(curr_date, config["period_days"])))
    except cw.EngineError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2

    if config["config_source"] == "defaults":
        notices.append("Настройки не применены (файл settings.yaml не прочитан), "
                       "использованы значения по умолчанию.")
    elif config["config_source"] == "no-config":
        notices.append("Настройки не читались (--no-config), использованы значения по умолчанию.")
    if use_config:
        for warning in cw.settings_structure_warnings(args.config_dir, len(SECTIONS)):
            notices.append("settings.yaml: %s" % warning)
    warn_below = config.get("warn_if_lots_below")
    if warn_below and len(curr_rows) < int(warn_below):
        notices.append("Полнота сбора: в снимке %d лотов — меньше порога "
                       "quality.warn_if_lots_below=%s." % (len(curr_rows), warn_below))

    payload = compute_diff(prev_rows, curr_rows, threshold, prev_date, curr_date, config=config)
    cw.json_dump(diff_cache_path(reports_dir, curr_date), payload)
    payload["_curr_rows"] = curr_rows

    print("Снимок: %s" % curr_path)
    if prev_path:
        print("Предыдущий снимок: %s" % prev_path)
    else:
        print("Предыдущий снимок не найден: отчёт без сравнения неделя-к-неделе.")

    limitations_text, limitations_path = read_limitations(reports_dir, curr_date)
    settings_text = settings_line(config, len(SECTIONS))
    settings_note = settings_text.strip("_").rstrip(".")
    print(settings_note)
    for notice in notices:
        print("Предупреждение: %s" % notice)

    written = []
    if "md" in formats:
        md_path = Path(reports_dir) / ("%s-competitor-watch.md" % curr_date)
        cw.write_text(md_path, build_markdown(payload, curr_rows, limitations_text, limitations_path,
                                              settings_text=settings_text, notices=notices))
        written.append(md_path)
    if "xlsx" in formats:
        xlsx_path = Path(reports_dir) / ("%s-competitor-watch.xlsx" % curr_date)
        try:
            build_xlsx(payload, curr_rows, xlsx_path, settings_note=settings_note)
        except ImportError:
            print("Ошибка: для XLSX нужен openpyxl (установлен в runtime).", file=sys.stderr)
            return 2
        written.append(xlsx_path)

    for path in written:
        print("Отчёт: %s" % path)
    if limitations_text:
        print("Ограничения взяты из: %s" % limitations_path)
    print("Разделов в Markdown: %d" % len(SECTIONS))
    print("Листов в XLSX: Сводка, Цены, Изменения, Акции, Лоты")

    if args.telegram:
        print("")
        print("--- Telegram (<= 900 символов) ---")
        print(build_telegram(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
