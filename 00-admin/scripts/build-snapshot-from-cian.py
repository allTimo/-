#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Собирает снимок lots.csv из JSON, снятых cian-collect.mjs.

Данные НЕ имитируются: в снимок попадают только лоты, реально полученные с Циан,
и только те, что проходят контракт (SCHEMA.md). Отброшенные строки считаются
и печатаются — их количество идёт в раздел «Ограничения» отчёта.

Использование:
    python build-snapshot-from-cian.py --date 2026-10-31 --out <...>/data/snapshots/2026-10-31/lots.csv \
        file1.json file2.json
"""
from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path

COLUMNS = [
    "snapshot_date", "source", "competitor", "project", "lot_id", "url",
    "rooms", "area_m2", "floor", "floors_total", "building", "price_rub",
    "price_per_m2_rub", "finish", "promo_flag", "promo_text", "delivery", "status",
]

FINISH_MAP = {
    "without": "без отделки",
    "rough": "без отделки",
    "fine": "чистовая",
    "whitebox": "white box",
    "white box": "white box",
    "furnished": "с мебелью",
    "turnkey": "чистовая",
}

QUARTERS = {"first": 1, "second": 2, "third": 3, "fourth": 4}


def delivery_code(row) -> str:
    year = row.get("delivery_year")
    quarter = row.get("delivery_quarter")
    if not year or quarter not in QUARTERS:
        return ""
    return "%s-Q%d" % (year, QUARTERS[quarter])


def to_finish(value) -> str:
    if not value:
        return "unknown"
    return FINISH_MAP.get(str(value).strip().lower(), "unknown")


def build(payload: dict, date: str) -> tuple:
    rows = []
    stats = {"source_lots": 0, "kept": 0, "dropped": 0, "apartments": 0, "reasons": {}}

    def drop(reason: str) -> None:
        stats["dropped"] += 1
        stats["reasons"][reason] = stats["reasons"].get(reason, 0) + 1

    competitor = payload.get("competitor_name") or payload.get("competitor") or ""
    project = payload.get("project") or ""

    for lot in payload.get("lots", []):
        stats["source_lots"] += 1
        lot_id = str(lot.get("lot_id") or "").strip()
        if not lot_id:
            drop("нет lot_id")
            continue
        rooms = lot.get("rooms")
        if rooms is None or not (0 <= int(rooms) <= 6):
            drop("rooms вне 0..6")
            continue
        try:
            area = float(str(lot.get("area_m2")).replace(",", "."))
        except (TypeError, ValueError):
            drop("нет/битая площадь")
            continue
        if not (10.0 <= area <= 400.0):
            drop("площадь вне 10..400")
            continue
        try:
            price = int(float(lot.get("price_rub")))
        except (TypeError, ValueError):
            drop("нет цены")
            continue
        if price <= 1_000_000:
            drop("цена <= 1 000 000")
            continue
        floor = lot.get("floor")
        floors_total = lot.get("floors_total")
        if floor is not None and floors_total is not None and int(floor) > int(floors_total):
            floors_total = ""      # не публикуем противоречивую пару

        promo_flag = 0
        promo_text = ""
        if lot.get("promo_raw"):
            promo_flag, promo_text = 1, str(lot["promo_raw"])[:200]
        elif lot.get("subsidised"):
            promo_flag, promo_text = 1, "Субсидированная ставка (флаг Циан)"

        if lot.get("is_apartments"):
            stats["apartments"] += 1

        rows.append({
            "snapshot_date": date,
            "source": "cian",
            "competitor": competitor,
            "project": project,
            "lot_id": lot_id,
            "url": lot.get("url") or "",
            "rooms": int(rooms),
            "area_m2": ("%.1f" % area),
            "floor": "" if floor is None else int(floor),
            "floors_total": "" if floors_total in (None, "") else int(floors_total),
            "building": lot.get("building") or "",
            "price_rub": price,
            "price_per_m2_rub": "",     # движок досчитает
            "finish": to_finish(lot.get("decoration")),
            "promo_flag": promo_flag,
            "promo_text": promo_text,
            "delivery": delivery_code(lot),
            "status": "reserved" if lot.get("is_booked") else "active",
        })
        stats["kept"] += 1

    # дубли по ключу (source, competitor, project, lot_id)
    seen = set()
    unique = []
    for row in rows:
        key = (row["source"], row["competitor"], row["project"], row["lot_id"])
        if key in seen:
            stats["dropped"] += 1
            stats["reasons"]["дубль по ключу"] = stats["reasons"].get("дубль по ключу", 0) + 1
            continue
        seen.add(key)
        unique.append(row)
    stats["kept"] = len(unique)
    return unique, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help="дата снимка YYYY-MM-DD")
    ap.add_argument("--out", required=True, help="путь к lots.csv")
    ap.add_argument("--project", action="append", default=[], help="переопределить название проекта (по порядку файлов)")
    ap.add_argument("--competitor", action="append", default=[], help="переопределить застройщика (по порядку файлов)")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    all_rows = []
    report = []
    for i, path in enumerate(args.files):
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if i < len(args.project):
            payload["project"] = args.project[i]
        if i < len(args.competitor):
            payload["competitor_name"] = args.competitor[i]
        rows, stats = build(payload, args.date)
        all_rows.extend(rows)
        report.append({"file": path, "project": payload.get("project"), "competitor": payload.get("competitor_name") or payload.get("competitor"), **stats})
        print("[%s / %s] из источника %d, в снимок %d, отброшено %d %s" % (
            payload.get("project"), payload.get("competitor_name") or payload.get("competitor"),
            stats["source_lots"], stats["kept"], stats["dropped"], stats["reasons"] or ""))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with io.open(out_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(all_rows)
    print("Записано: %s, строк с данными: %d" % (out_path, len(all_rows)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
