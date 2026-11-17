#!/usr/bin/env python3
r"""measure_lot_ids.py - замер стабильности ключей: пересечение снимков и ступени §4.

Печатает по каждому клиенту:
  * строк в каждом снимке и распределение ступеней идентичности (n/u/c/r);
  * пересечение ключей (source, competitor, project, lot_id) и его долю от меньшего
    снимка; «новые» и «ушедшие»;
  * остаток: ушедшие строки, у которых нет строки-аналога в новом снимке (реальная
    ротация предложения, а не сломанный ключ), с причиной.

Usage:
    python measure_lot_ids.py --prev 2026-11-03 --curr 2026-11-04
    python measure_lot_ids.py --data-dir tests/fixtures --prev 2026-10-23 --curr 2026-10-30
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

import cwlib as cw

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
CLIENTS_DATA_DIR = WATCH_DIR / "data" / "clients"
STEP_LABELS = {"n": "родной id", "u": "url", "c": "содержимое", "r": "сырой слепок"}


def row_key(row):
    return (row.get("source"), row.get("competitor"), row.get("project"), row.get("lot_id"))


def content_key(row):
    return (row.get("source"), row.get("competitor"), row.get("project"), row.get("rooms"),
            cw.to_float(row.get("area_m2")), row.get("floor"), row.get("floors_total"),
            row.get("building"))


def measure(client_dir, prev, curr, out=None):
    out = out if out is not None else sys.stdout
    client_id = Path(client_dir).name
    snapshots = Path(client_dir) / "snapshots"
    a_path = snapshots / prev / "lots.csv"
    b_path = snapshots / curr / "lots.csv"
    if not a_path.exists() or not b_path.exists():
        out.write("%s: нет снимков %s / %s\n" % (client_id, prev, curr))
        return None
    a_rows, b_rows = cw.load_snapshot_rows(a_path), cw.load_snapshot_rows(b_path)
    a_keys, b_keys = {row_key(row) for row in a_rows}, {row_key(row) for row in b_rows}
    common = a_keys & b_keys
    smaller = min(len(a_keys), len(b_keys)) or 1
    gone = [row for row in a_rows if row_key(row) not in b_keys]
    fresh = [row for row in b_rows if row_key(row) not in a_keys]
    steps = Counter(str(row.get("lot_id") or "?")[:1] for row in b_rows)
    b_content = Counter(content_key(row) for row in b_rows)
    no_twin = [row for row in gone if b_content.get(content_key(row), 0) == 0]
    out.write("== %s: %s -> %s\n" % (client_id, prev, curr))
    out.write("   строк: %d -> %d | уникальных ключей: %d -> %d\n"
              % (len(a_rows), len(b_rows), len(a_keys), len(b_keys)))
    out.write("   ступени в %s: %s\n" % (curr, ", ".join(
        "%s (%s)=%d" % (key, STEP_LABELS.get(key, "?"), value) for key, value in sorted(steps.items()))))
    out.write("   пересечение: %d из %d = %.2f%% меньшего снимка\n"
              % (len(common), smaller, 100.0 * len(common) / smaller))
    out.write("   новые: %d, ушедшие: %d; из ушедших без аналога по содержимому: %d\n"
              % (len(fresh), len(gone), len(no_twin)))
    for row in gone:
        twin = b_content.get(content_key(row), 0)
        out.write("     ушёл: %-30s комнат %-2s площадь %-6s этаж %-3s/%-3s%s\n"
                  % (str(row.get("project"))[:30], row.get("rooms"), row.get("area_m2"),
                     row.get("floor"), row.get("floors_total"),
                     "" if twin else "  (аналога в новом снимке нет — реально ушёл)"))
    return {"client": client_id, "rows_prev": len(a_rows), "rows_curr": len(b_rows),
            "intersection": len(common), "smaller": smaller,
            "pct": round(100.0 * len(common) / smaller, 2), "new": len(fresh), "gone": len(gone),
            "steps": dict(steps), "gone_without_twin": len(no_twin)}


def build_parser():
    parser = argparse.ArgumentParser(prog="measure_lot_ids.py",
                                     description="Пересечение снимков и ступени идентичности (F9).")
    parser.add_argument("--client", default=None, help="только один клиент")
    parser.add_argument("--data-dir", default=None, help="каталог data/clients (по умолчанию data)")
    parser.add_argument("--prev", required=True, help="старый снимок YYYY-MM-DD")
    parser.add_argument("--curr", required=True, help="новый снимок YYYY-MM-DD")
    return parser


def main(argv=None):
    cw.setup_console()
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    base = Path(args.data_dir) if args.data_dir else CLIENTS_DATA_DIR
    clients = sorted(entry for entry in base.iterdir()
                     if entry.is_dir() and (entry / "snapshots").is_dir()) if base.is_dir() else []
    if args.client:
        clients = [entry for entry in clients if entry.name == args.client]
    if not clients:
        print("Клиентов со снимками не найдено: %s" % base)
        return 1
    for client_dir in clients:
        measure(client_dir, args.prev, args.curr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
