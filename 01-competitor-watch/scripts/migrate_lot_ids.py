#!/usr/bin/env python3
r"""migrate_lot_ids.py - одноразовый перенос ключей F9 в старые снимки (§5.2).

Старые снимки собраны по нестабильной схеме (в ключ входили цена и позиция в
выдаче). После пересбора самого свежего снимка этот скрипт переносит в более
старые даты **новые** `lot_id` того же лота, сопоставляя строки по подписи
содержимого:

    ступень 1 (точная):  (source, competitor, project, rooms, area_m2,
                          floor, floors_total, building)   — подпись §5.2
    ступень 2 (мягкая):  (source, competitor, project, area_m2, floor,
                          floors_total)                     — только когда точная
                          не сработала, а мягкая однозначна в эталоне

Ненайденные строки сохраняют старый ключ: они действительно ушли из предложения.
Каждая правка — атомарно, с копией `.bak-<timestamp>`; после переноса печатается
отчёт «сопоставлено / не сопоставлено» и пишется машиночитаемый JSON в
`data/clients/<client>/.cache/lot-id-migration-<timestamp>.json`.

Цена и порядок в выдаче в сопоставлении не участвуют никогда.

Usage:
    python migrate_lot_ids.py --dry-run
    python migrate_lot_ids.py --client client-svet --reference-date 2026-11-04
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import sys
from pathlib import Path

import cwlib as cw
import sources_tool

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
CLIENTS_DATA_DIR = WATCH_DIR / "data" / "clients"
SIGNATURE_FIELDS = ("rooms", "area_m2", "floor", "floors_total", "building")
LOOSE_FIELDS = ("area_m2", "floor", "floors_total")


def setup_console():
    cw.setup_console()


def _row_signature(row, fields):
    """Подпись содержимого: числа нормализованы, текст сжат и приведён к нижнему регистру."""
    values = [str(row.get("source") or "").strip().lower(),
              str(row.get("competitor") or "").strip().lower(),
              str(row.get("project") or "").strip().lower()]
    for field in fields:
        if field == "area_m2":
            values.append(cw.to_float(row.get(field)))
        elif field in ("rooms", "floor", "floors_total"):
            values.append(cw.to_int(row.get(field)))
        else:
            values.append(" ".join(str(row.get(field) or "").split()).lower())
    return tuple(values)


def load_rows(path):
    return cw.load_snapshot_rows(path)


def best_reference_map(reference_rows):
    """Карты эталона: точная подпись и однозначная мягкая (только когда ключ уникален)."""
    exact, loose = {}, {}
    for row in reference_rows or []:
        lot_id = str(row.get("lot_id") or "").strip()
        if not lot_id:
            continue
        exact.setdefault(_row_signature(row, SIGNATURE_FIELDS), set()).add(lot_id)
        loose.setdefault(_row_signature(row, LOOSE_FIELDS), set()).add(lot_id)
    loose_unique = {key: sorted(value)[0] for key, value in loose.items() if len(value) == 1}
    exact_sorted = {key: sorted(value) for key, value in exact.items()}
    return exact_sorted, loose_unique


def _consume(available, target):
    """Израсходовать ключ эталона: убрать его из всех списков `available`."""
    for values in available.values():
        while target in values:
            values.remove(target)


def plan_migration(rows, exact, loose):
    """Новые строки + статистика: matched_exact / matched_loose / unmatched.

    Порядок обязателен: СНАЧАЛА все точные сопоставления, затем мягкие. Иначе
    мягкая ступень может забрать ключ, который позже возьмёт точная подпись, и в
    одной дате появятся два одинаковых `lot_id` (дефект D-F9-DUP). Ключ эталона
    расходуется ровно один раз: он уходит из `available` при любом виде
    сопоставления. Мягкая ступень применяется только к строкам без точной подписи
    и только когда мягкий ключ однозначен в эталоне.

    `reverted_duplicates` — страховка: если ключ всё же повторился внутри даты,
    строка возвращается к своему старому ключу, а не портит идентичность.
    """
    rows = list(rows or [])
    available = {key: list(value) for key, value in (exact or {}).items()}
    plan = [dict(row) for row in rows]
    used = set()
    stats = {"rows": len(rows), "matched_exact": 0, "matched_loose": 0, "unmatched": 0,
             "unmatched_list": [], "reverted_duplicates": 0}

    # 1) точные сопоставления — раньше мягких
    pending = []
    for index, row in enumerate(rows):
        candidates = available.get(_row_signature(row, SIGNATURE_FIELDS)) or []
        if not candidates:
            pending.append(index)
            continue
        target = candidates.pop(0)
        _consume(available, target)
        plan[index]["lot_id"] = target
        used.add(target)
        stats["matched_exact"] += 1

    # 2) мягкие — только оставшимся строкам, по однозначному свободному ключу
    for index in pending:
        row = rows[index]
        target = loose.get(_row_signature(row, LOOSE_FIELDS))
        if target and target not in used:
            plan[index]["lot_id"] = target
            used.add(target)
            _consume(available, target)
            stats["matched_loose"] += 1
            continue
        stats["unmatched"] += 1
        stats["unmatched_list"].append({
            "lot_id": row.get("lot_id"), "project": row.get("project"),
            "rooms": row.get("rooms"), "area_m2": row.get("area_m2"),
            "floor": row.get("floor"), "floors_total": row.get("floors_total"),
            "reason": "нет строки с такой подписью в эталонном снимке"})

    # 3) страховка: ни один lot_id не повторяется внутри одной даты
    seen = set()
    for index, new_row in enumerate(plan):
        lot_id = str(new_row.get("lot_id") or "")
        if lot_id and lot_id in seen:
            original = str(rows[index].get("lot_id") or "")
            if original and original not in seen:
                new_row["lot_id"] = original
                stats["reverted_duplicates"] += 1
                lot_id = original
            else:
                stats["reverted_duplicates"] += 1
        if lot_id:
            seen.add(lot_id)
    return plan, stats


def snapshot_dates(client_dir):
    base = Path(client_dir) / "snapshots"
    if not base.is_dir():
        return []
    return sorted(entry.name for entry in base.iterdir()
                  if entry.is_dir() and cw.DATE_RE.match(entry.name))


def rows_to_csv_text(rows):
    """UTF-8 с BOM и CRLF — тот же формат, что пишет движок (Excel-safe)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(cw.COLUMNS)
    for row in rows:
        writer.writerow([cw.format_cell(row.get(column)) for column in cw.COLUMNS])
    return "\ufeff" + buffer.getvalue()


def migrate_client(client_dir, reference_date=None, dates=None, dry_run=False, out=None):
    """Перенести ключи по одному клиенту. Возвращает отчёт (dict)."""
    client_dir = Path(client_dir)
    client_id = client_dir.name
    known = snapshot_dates(client_dir)
    if not known:
        return {"client": client_id, "status": "no_snapshots", "dates": {}}
    reference_date = str(reference_date or known[-1])
    if reference_date not in known:
        return {"client": client_id, "status": "no_reference", "reference_date": reference_date,
                "dates": {}}
    targets = [date for date in (dates or known) if date < reference_date and date in known]
    reference_rows = load_rows(client_dir / "snapshots" / reference_date / "lots.csv")
    exact, loose = best_reference_map(reference_rows)
    report = {"client": client_id, "status": "ok", "reference_date": reference_date,
              "reference_rows": len(reference_rows), "dates": {}, "dry_run": bool(dry_run)}
    for date in targets:
        path = client_dir / "snapshots" / date / "lots.csv"
        rows = load_rows(path)
        plan, stats = plan_migration(rows, exact, loose)
        changed = sum(1 for before, after in zip(rows, plan)
                      if str(before.get("lot_id")) != str(after.get("lot_id")))
        backup = None
        if changed and not dry_run:
            backup = sources_tool.write_atomic(path, rows_to_csv_text(plan), backup=True)
        stats.update({"changed": changed, "backup": str(backup) if backup else None})
        report["dates"][date] = stats
        if out is not None:
            out.write("  %s: строк %d, сопоставлено %d (точно %d, мягко %d), не сопоставлено %d%s\n"
                      % (date, stats["rows"], stats["matched_exact"] + stats["matched_loose"],
                         stats["matched_exact"], stats["matched_loose"], stats["unmatched"],
                         "" if dry_run else ", .bak: %s" % (backup.name if backup else "не нужен")))
    return report


def find_clients(data_dir=None, client_id=None):
    base = Path(data_dir) if data_dir else CLIENTS_DATA_DIR
    if not base.is_dir():
        return []
    found = [entry for entry in sorted(base.iterdir())
             if entry.is_dir() and (entry / "snapshots").is_dir()]
    if client_id:
        found = [entry for entry in found if entry.name == client_id]
    return found


def build_parser():
    parser = argparse.ArgumentParser(
        prog="migrate_lot_ids.py",
        description="Перенос ключей F9 в старые снимки по подписи содержимого (§5.2).")
    parser.add_argument("--client", default=None, help="только один клиент (id)")
    parser.add_argument("--data-dir", default=None, help="каталог data/clients (для тестов)")
    parser.add_argument("--reference-date", default=None, help="эталонный снимок (по умолчанию самый свежий)")
    parser.add_argument("--dates", default=None, help="список дат через запятую (по умолчанию все старше эталона)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не писать, только отчёт")
    parser.add_argument("--report-dir", default=None, help="куда положить JSON-отчёт (по умолчанию .cache клиента)")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    clients = find_clients(args.data_dir, args.client)
    if not clients:
        print("Клиентов со снимками не найдено (каталог: %s)" % (args.data_dir or CLIENTS_DATA_DIR))
        return 1
    dates = [item.strip() for item in str(args.dates or "").split(",") if item.strip()] or None
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    total_changed = 0
    reports = []
    for client_dir in clients:
        print("=== Перенос ключей F9: %s ===" % client_dir.name)
        report = migrate_client(client_dir, reference_date=args.reference_date, dates=dates,
                                dry_run=args.dry_run, out=sys.stdout)
        reports.append(report)
        total_changed += sum(item.get("changed") or 0 for item in report.get("dates", {}).values())
        report_dir = Path(args.report_dir) if args.report_dir else client_dir / cw.CACHE_DIR_NAME
        if report_dates := report.get("dates"):
            if not args.dry_run:
                report["checked_at"] = stamp
                path = cw.json_dump(report_dir / ("lot-id-migration-%s.json" % stamp), report)
                print("  Отчёт: %s" % path)
        unmatched = sum(item.get("unmatched") or 0 for item in report_dates.values())
        print("  Итог: сопоставлено %d, не сопоставлено %d (остались со старым ключом)"
              % (sum((item.get("matched_exact") or 0) + (item.get("matched_loose") or 0)
                     for item in report_dates.values()), unmatched))
    print("Всего перенесено ключей: %d%s" % (total_changed, " (dry-run)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
