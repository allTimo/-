#!/usr/bin/env python3
r"""diff_snapshots.py - machine-readable diff between two weekly snapshots.

Usage (Windows PowerShell):
    <python> diff_snapshots.py --prev 2026-10-23 --curr 2026-10-30
    <python> diff_snapshots.py --prev tests\fixtures\week-2026-10-23\lots.csv ^
                               --curr tests\fixtures\week-2026-10-30\lots.csv --threshold 0.5

Writes reports\.cache\diff-<curr>.json (UTF-8) and prints a short summary.
--prev accepts a date (YYYY-MM-DD), a snapshot directory or a direct .csv path.

Lot identity is (source, competitor, project, lot_id) - see SCHEMA.md.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys
from pathlib import Path

import cwlib as cw

SCHEMA_VERSION = 1
# Default comes from settings.yaml (thresholds.price_change_pct) when available.
DEFAULT_THRESHOLD_PCT = cw.DEFAULT_THRESHOLD_PCT


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _ppm2_int(row):
    value = cw.ppm2_of(row)
    return None if value is None else int(round(value))


def lot_brief(row):
    """Compact machine-readable view of one lot."""
    return {
        "source": row.get("source"),
        "competitor": row.get("competitor"),
        "project": row.get("project"),
        "lot_id": row.get("lot_id"),
        "url": row.get("url"),
        "rooms": row.get("rooms"),
        "rooms_label": cw.rooms_bucket(row.get("rooms")),
        "area_m2": row.get("area_m2"),
        "floor": row.get("floor"),
        "floors_total": row.get("floors_total"),
        "building": row.get("building"),
        "price_rub": None if row.get("price_rub") is None else int(round(row["price_rub"])),
        "price_per_m2_rub": _ppm2_int(row),
        "finish": row.get("finish"),
        "promo_flag": row.get("promo_flag"),
        "promo_text": row.get("promo_text") or "",
        "delivery": row.get("delivery"),
        "status": row.get("status"),
    }


def _project_keys(*row_sets):
    keys = set()
    for rows in row_sets:
        for row in rows or []:
            keys.add((str(row.get("competitor") or ""), str(row.get("project") or "")))
    return sorted(keys)


def _round(value, digits=2):
    return None if value is None else round(float(value), digits)


# --------------------------------------------------------------------------
# core
# --------------------------------------------------------------------------

def compute_diff(prev_rows, curr_rows, threshold_pct=DEFAULT_THRESHOLD_PCT,
                 prev_date=None, curr_date=None, config=None):
    """Build the full diff payload.

    prev_rows may be None (no previous snapshot): then week-over-week parts are
    empty/None and has_prev is False.

    config (optional, from cwlib.load_config) adds the absolute price threshold
    (thresholds.price_change_abs_rub) and the minimum number of lots a project
    needs to appear in the median tables (thresholds.min_lots_for_stats).
    Without a config nothing is filtered, which keeps the engine API stable.
    """
    config = config or {}
    abs_threshold = float(config.get("price_change_abs_rub") or 0.0)
    min_lots_for_stats = int(config.get("min_lots_for_stats") or 0)
    has_prev = prev_rows is not None
    prev_rows = list(prev_rows or [])
    curr_rows = list(curr_rows or [])

    prev_map = {cw.lot_key(r): r for r in prev_rows}
    curr_map = {cw.lot_key(r): r for r in curr_rows}
    common_keys = sorted(set(prev_map) & set(curr_map))

    new_lots = [lot_brief(curr_map[key]) for key in sorted(curr_map) if key not in prev_map]
    gone_lots = [lot_brief(prev_map[key]) for key in sorted(prev_map) if key not in curr_map]
    if not has_prev:
        new_lots, gone_lots = [], []
    gone_lots_inactive = [brief for brief in gone_lots if brief["status"] != "active"]

    # ---- price changes -------------------------------------------------
    price_changes = []
    below_threshold = 0
    for key in common_keys:
        prev_row, curr_row = prev_map[key], curr_map[key]
        prev_price = prev_row.get("price_rub")
        curr_price = curr_row.get("price_rub")
        if not prev_price or not curr_price:
            continue
        delta = float(curr_price) - float(prev_price)
        pct = delta / float(prev_price) * 100.0
        matched_by = None
        if abs(pct) >= float(threshold_pct):
            matched_by = "pct"
        elif abs_threshold > 0 and abs(delta) >= abs_threshold:
            matched_by = "abs"
        if matched_by is None:
            if delta:
                below_threshold += 1
            continue
        price_changes.append({
            "matched_by": matched_by,
            "source": curr_row.get("source"),
            "competitor": curr_row.get("competitor"),
            "project": curr_row.get("project"),
            "lot_id": curr_row.get("lot_id"),
            "rooms": curr_row.get("rooms"),
            "rooms_label": cw.rooms_bucket(curr_row.get("rooms")),
            "area_m2": curr_row.get("area_m2"),
            "price_prev_rub": int(round(prev_price)),
            "price_curr_rub": int(round(curr_price)),
            "delta_rub": int(round(delta)),
            "delta_pct": _round(pct),
            "price_per_m2_prev_rub": _ppm2_int(prev_row),
            "price_per_m2_curr_rub": _ppm2_int(curr_row),
            "status_prev": prev_row.get("status"),
            "status_curr": curr_row.get("status"),
            "direction": "рост" if delta > 0 else "снижение",
        })
    price_changes.sort(key=lambda item: abs(item["delta_pct"]), reverse=True)

    # ---- promos --------------------------------------------------------
    promo_new, promo_changed, promo_ended = [], [], []
    if has_prev:
        for brief in new_lots:
            if brief["promo_flag"] == 1 and brief["promo_text"]:
                promo_new.append({
                    "competitor": brief["competitor"],
                    "project": brief["project"],
                    "lot_id": brief["lot_id"],
                    "rooms_label": brief["rooms_label"],
                    "promo_text": brief["promo_text"],
                    "promo_text_prev": "",
                    "status": "новая",
                })
        for key in common_keys:
            prev_row, curr_row = prev_map[key], curr_map[key]
            prev_on = cw.promo_is_on(prev_row)
            curr_on = cw.promo_is_on(curr_row)
            prev_text = str(prev_row.get("promo_text") or "").strip()
            curr_text = str(curr_row.get("promo_text") or "").strip()
            if curr_on and not prev_on:
                promo_new.append({
                    "competitor": curr_row.get("competitor"),
                    "project": curr_row.get("project"),
                    "lot_id": curr_row.get("lot_id"),
                    "rooms_label": cw.rooms_bucket(curr_row.get("rooms")),
                    "promo_text": curr_text,
                    "promo_text_prev": "",
                    "status": "новая",
                })
            elif prev_on and not curr_on:
                promo_ended.append({
                    "competitor": prev_row.get("competitor"),
                    "project": prev_row.get("project"),
                    "lot_id": prev_row.get("lot_id"),
                    "rooms_label": cw.rooms_bucket(prev_row.get("rooms")),
                    "promo_text": prev_text,
                    "promo_text_prev": prev_text,
                    "status": "закончилась",
                })
            elif prev_on and curr_on and prev_text != curr_text:
                promo_changed.append({
                    "competitor": curr_row.get("competitor"),
                    "project": curr_row.get("project"),
                    "lot_id": curr_row.get("lot_id"),
                    "rooms_label": cw.rooms_bucket(curr_row.get("rooms")),
                    "promo_text": curr_text,
                    "promo_text_prev": prev_text,
                    "status": "изменилась",
                })

    # ---- supply --------------------------------------------------------
    supply_by_project = []
    for competitor, project in _project_keys(prev_rows, curr_rows):
        curr_proj = [r for r in curr_rows
                     if str(r.get("competitor")) == competitor and str(r.get("project")) == project]
        prev_proj = [r for r in prev_rows
                     if str(r.get("competitor")) == competitor and str(r.get("project")) == project]
        active_curr = sum(1 for r in curr_proj if cw.is_active(r))
        active_prev = sum(1 for r in prev_proj if cw.is_active(r)) if has_prev else None
        supply_by_project.append({
            "competitor": competitor,
            "project": project,
            "lots_curr": len(curr_proj),
            "lots_prev": len(prev_proj) if has_prev else None,
            "active_curr": active_curr,
            "active_prev": active_prev,
            "delta_active": None if active_prev is None else active_curr - active_prev,
            "new_active": sum(1 for b in new_lots
                              if b["competitor"] == competitor and b["project"] == project
                              and b["status"] == "active"),
            "gone": sum(1 for b in gone_lots
                        if b["competitor"] == competitor and b["project"] == project),
        })

    supply_by_rooms = []
    for label, values in cw.ROOM_BUCKETS:
        curr_count = sum(1 for r in curr_rows
                         if cw.is_active(r) and cw.to_int(r.get("rooms")) in values)
        prev_count = (sum(1 for r in prev_rows
                          if cw.is_active(r) and cw.to_int(r.get("rooms")) in values)
                      if has_prev else None)
        supply_by_rooms.append({
            "rooms_label": label,
            "count_curr": curr_count,
            "count_prev": prev_count,
            "delta": None if prev_count is None else curr_count - prev_count,
        })

    # ---- prices by project --------------------------------------------
    price_by_project = []
    for competitor, project in _project_keys(prev_rows, curr_rows):
        curr_proj = [r for r in curr_rows if cw.is_active(r)
                     and str(r.get("competitor")) == competitor and str(r.get("project")) == project]
        prev_proj = [r for r in prev_rows if cw.is_active(r)
                     and str(r.get("competitor")) == competitor and str(r.get("project")) == project]
        curr_ppm2 = [cw.stats_ppm2(r) for r in curr_proj if cw.stats_ppm2(r)]
        prev_ppm2 = [cw.stats_ppm2(r) for r in prev_proj if cw.stats_ppm2(r)]
        median_curr = cw.median_rounded(curr_ppm2)
        median_prev = cw.median_rounded(prev_ppm2) if has_prev else None
        mean_curr = cw.mean_rounded(curr_ppm2)
        mean_prev = cw.mean_rounded(prev_ppm2) if has_prev else None
        price_by_project.append({
            "competitor": competitor,
            "project": project,
            "active_curr": len(curr_proj),
            "active_prev": len(prev_proj) if has_prev else None,
            "median_ppm2_curr": median_curr,
            "median_ppm2_prev": median_prev,
            "delta_median_pct": _round(cw.delta_pct(median_prev, median_curr)),
            "mean_ppm2_curr": mean_curr,
            "mean_ppm2_prev": mean_prev,
            "delta_mean_pct": _round(cw.delta_pct(mean_prev, mean_curr)),
            # thresholds.min_lots_for_stats: too few lots -> out of the median tables.
            "min_lots_for_stats": min_lots_for_stats,
            "stats_excluded": bool(min_lots_for_stats) and len(curr_proj) < min_lots_for_stats,
        })

    # ---- prices by room bucket ----------------------------------------
    rooms_price = []
    for label, values in cw.ROOM_BUCKETS:
        curr_rows_bucket = [r for r in curr_rows if cw.is_active(r)
                            and cw.to_int(r.get("rooms")) in values]
        prev_rows_bucket = [r for r in prev_rows if cw.is_active(r)
                            and cw.to_int(r.get("rooms")) in values]
        curr_ppm2 = [cw.stats_ppm2(r) for r in curr_rows_bucket if cw.stats_ppm2(r)]
        prev_ppm2 = [cw.stats_ppm2(r) for r in prev_rows_bucket if cw.stats_ppm2(r)]
        rooms_price.append({
            "rooms_label": label,
            "count_curr": len(curr_rows_bucket),
            "count_prev": len(prev_rows_bucket) if has_prev else None,
            "median_ppm2_curr": cw.median_rounded(curr_ppm2),
            "median_ppm2_prev": cw.median_rounded(prev_ppm2) if has_prev else None,
            "mean_ppm2_curr": cw.mean_rounded(curr_ppm2),
        })

    # ---- totals --------------------------------------------------------
    curr_active = sum(1 for r in curr_rows if cw.is_active(r))
    prev_active = sum(1 for r in prev_rows if cw.is_active(r)) if has_prev else None
    # The statistic is defined by the value source, not by whether the stored
    # column was filled: a lot with price_rub and area_m2 belongs in the market
    # median even when price_per_m2_rub was left empty (validate does not require it).
    all_curr_ppm2 = [p for p in (cw.stats_ppm2(r) for r in curr_rows if cw.is_active(r)) if p is not None]
    all_prev_ppm2 = [p for p in (cw.stats_ppm2(r) for r in prev_rows if cw.is_active(r)) if p is not None]
    median_all_curr = cw.median_rounded(all_curr_ppm2)
    median_all_prev = cw.median_rounded(all_prev_ppm2) if has_prev else None

    totals = {
        "prev_date": prev_date,
        "curr_date": curr_date,
        "has_prev": has_prev,
        "threshold_pct": float(threshold_pct),
        "threshold_abs_rub": abs_threshold,
        "min_lots_for_stats": min_lots_for_stats,
        "prev_lots": len(prev_rows) if has_prev else None,
        "curr_lots": len(curr_rows),
        "prev_active": prev_active,
        "curr_active": curr_active,
        "competitors": sorted({str(r.get("competitor") or "") for r in curr_rows}),
        "projects": sorted({str(r.get("project") or "") for r in curr_rows}),
        "new_lots": len(new_lots),
        "gone_lots": len(gone_lots),
        "gone_lots_inactive": len(gone_lots_inactive),
        "price_changes": len(price_changes),
        "price_changes_below_threshold": below_threshold,
        "promo_new": len(promo_new),
        "promo_changed": len(promo_changed),
        "promo_ended": len(promo_ended),
        "median_ppm2_curr": median_all_curr,
        "median_ppm2_prev": median_all_prev,
        "delta_median_ppm2_pct": _round(cw.delta_pct(median_all_prev, median_all_curr)),
        "mean_ppm2_curr": cw.mean_rounded(all_curr_ppm2),
        "mean_ppm2_prev": cw.mean_rounded(all_prev_ppm2) if has_prev else None,
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _dt.datetime.now().replace(microsecond=0).isoformat(),
        "threshold_pct": float(threshold_pct),
        "totals": totals,
        "new_lots": new_lots,
        "gone_lots": gone_lots,
        "gone_lots_inactive": gone_lots_inactive,
        "price_changes": price_changes,
        "promo_new": promo_new,
        "promo_changed": promo_changed,
        "promo_ended": promo_ended,
        "supply_by_project": supply_by_project,
        "supply_by_rooms": supply_by_rooms,
        "price_by_project": price_by_project,
        "rooms_price": rooms_price,
    }


def diff_cache_path(reports_dir, curr_date):
    return Path(reports_dir) / cw.CACHE_DIR_NAME / ("diff-%s.json" % curr_date)


def load_snapshot_for_ref(ref, snapshots_dir=None):
    """Resolve a date/dir/csv reference, load typed rows and the snapshot date."""
    path = cw.resolve_snapshot_ref(ref, snapshots_dir)
    if not path.exists():
        raise cw.EngineError("файл снимка не найден: %s" % path)
    rows = cw.load_snapshot_rows(path)
    date_text = cw.date_from_ref(ref)
    if not date_text and rows:
        date_text = str(rows[0].get("snapshot_date") or "")
    if not date_text:
        raise cw.EngineError("не удалось определить дату снимка: %s" % path)
    return rows, date_text, path


def print_summary(payload):
    totals = payload["totals"]
    prev_date = totals["prev_date"] or "нет"
    print("Снимок %s (%d лотов, %d в продаже) против %s (%s лотов, %s в продаже)"
          % (totals["curr_date"], totals["curr_lots"], totals["curr_active"], prev_date,
             totals["prev_lots"] if totals["prev_lots"] is not None else "—",
             totals["prev_active"] if totals["prev_active"] is not None else "—"))
    print("Новые лоты: %d; ушедшие: %d (из них не active: %d)"
          % (totals["new_lots"], totals["gone_lots"], totals["gone_lots_inactive"]))
    print("Изменения цен выше %s%%: %d (ниже порога: %d)"
          % (cw.fmt_num(totals["threshold_pct"], 2), totals["price_changes"],
             totals["price_changes_below_threshold"]))
    print("Акции: новые %d, изменились %d, закончились %d"
          % (totals["promo_new"], totals["promo_changed"], totals["promo_ended"]))
    print("Медиана ₽/м²: %s (неделю назад %s, Δ %s)"
          % (cw.fmt_money(totals["median_ppm2_curr"]),
             cw.fmt_money(totals["median_ppm2_prev"]),
             cw.fmt_pct(totals["delta_median_ppm2_pct"])))


def build_parser():
    parser = argparse.ArgumentParser(
        prog="diff_snapshots.py",
        description="Машиночитаемый diff двух недельных снимков конкурентов.",
    )
    parser.add_argument("--prev", default=None,
                        help="предыдущий снимок (дата, каталог или путь к lots.csv); "
                             "без него выбирается по period.compare_mode из settings.yaml")
    parser.add_argument("--curr", required=True, help="текущий снимок: дата, каталог или путь к lots.csv")
    parser.add_argument("--threshold", type=float, default=None,
                        help="порог значимости изменения цены, %% (по умолчанию thresholds.price_change_pct из settings.yaml, иначе 0.5)")
    parser.add_argument("--reports-dir", default=None, help="каталог отчётов (по умолчанию reports)")
    parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
    parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config (по умолчанию вычисляется от скрипта)")
    parser.add_argument("--no-config", action="store_true", help="не читать settings.yaml, работать на значениях по умолчанию")
    parser.add_argument("--quiet", action="store_true", help="не печатать сводку")
    return parser


def main(argv=None):
    cw.setup_console()
    args = build_parser().parse_args(argv)
    use_config = not args.no_config
    config = cw.load_config(args.config_dir, use_config=use_config)
    reports_dir = cw.resolve_reports_dir(args.reports_dir, args.config_dir, use_config=use_config)
    snapshots_dir = cw.resolve_snapshots_dir(args.snapshots_dir, args.config_dir, use_config=use_config)
    threshold = args.threshold if args.threshold is not None else config["price_change_pct"]
    try:
        curr_rows, curr_date, _ = load_snapshot_for_ref(args.curr, snapshots_dir)
        # One shared rule for both entry points (run_weekly.py / run_weekly.ps1):
        # cwlib.previous_snapshot_date + period.compare_mode from settings.yaml.
        prev_ref = args.prev or cw.previous_snapshot_date(
            curr_date, snapshots_dir, config["compare_mode"], config["period_days"])
        prev_rows = prev_date = None
        if prev_ref:
            prev_rows, prev_date, _ = load_snapshot_for_ref(prev_ref, snapshots_dir)
            print("Предыдущий снимок (%s): %s" % (config["compare_mode"], prev_date))
        elif config["compare_mode"] == "week_over_week":
            print("Предупреждение: режим week_over_week — снимка ровно за %s дней (%s) нет, "
                  "diff без сравнения."
                  % (config["period_days"], cw.shift_date(curr_date, config["period_days"])),
                  file=sys.stderr)
        else:
            print("Предыдущий снимок не найден: diff без сравнения.")
    except cw.EngineError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2

    payload = compute_diff(prev_rows, curr_rows, threshold, prev_date, curr_date, config=config)
    out_path = diff_cache_path(reports_dir, curr_date)
    cw.json_dump(out_path, payload)

    if not args.quiet:
        print_summary(payload)
        print("JSON: %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
