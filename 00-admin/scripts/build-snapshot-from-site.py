#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Собирает снимок lots.csv из JSON, снятых collect-developer-sites.mjs.

Данные — только с официальных сайтов застройщиков, без имитации.
Гранулярность источника: сайт отдаёт цены «от» по позиции каталога
(корпус + тип квартиры + площадь), а не по каждому лоту. Поэтому:
  • lot_id формируется как устойчивый хэш от (competitor, project, корпус, комнатность, площадь, цена)
    (settings.yaml -> data_contract.lot_id_fallback = hash(url); здесь url у позиции нет,
    поэтому хэшируется состав ключа — значение стабильно между неделями, пока цена не изменилась);
  • поля, которых сайт не отдаёт (этаж, отделка, срок сдачи), остаются пустыми/unknown,
    а не додумываются.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

COLUMNS = [
    "snapshot_date", "source", "competitor", "project", "lot_id", "url",
    "rooms", "area_m2", "floor", "floors_total", "building", "price_rub",
    "price_per_m2_rub", "finish", "promo_flag", "promo_text", "delivery", "status",
]


def lot_id(competitor: str, project: str, corpus: str, rooms, area: str, price: int) -> str:
    key = "|".join([competitor, project, corpus or "", str(rooms), area, str(price)])
    return "site-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    rows = []
    report = []
    for path in args.files:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        competitor = payload.get("competitor") or ""
        project = payload.get("project") or ""
        kept = 0
        skipped = 0
        for pos in payload.get("positions", []):
            if pos.get("rooms") is None or not pos.get("area_m2") or not pos.get("price_rub"):
                skipped += 1        # не хватает обязательных полей контракта — не выдумываем
                continue
            area = float(str(pos["area_m2"]).replace(",", "."))
            if not (10.0 <= area <= 400.0):
                skipped += 1
                continue
            price = int(pos["price_rub"])
            if price <= 1_000_000:
                skipped += 1
                continue
            corpus = pos.get("corpus") or ""
            rows.append({
                "snapshot_date": args.date,
                "source": "site",
                "competitor": competitor,
                "project": project,
                "lot_id": lot_id(competitor, project, corpus, pos["rooms"], ("%.1f" % area), price),
                "url": pos.get("source_url") or payload.get("site_url") or "",
                "rooms": int(pos["rooms"]),
                "area_m2": "%.1f" % area,
                "floor": "",
                "floors_total": "",
                "building": corpus,
                "price_rub": price,
                "price_per_m2_rub": "",
                "finish": "unknown",
                "promo_flag": 0,
                "promo_text": "",
                "delivery": "",
                "status": "active",
            })
            kept += 1
        report.append({"file": path, "site": payload.get("site"), "project": project,
                       "competitor": competitor, "positions": len(payload.get("positions", [])),
                       "kept": kept, "skipped": skipped, "granularity": payload.get("granularity")})
        print("[%s / %s] позиций %d, в снимок %d, пропущено %d" % (
            payload.get("site"), project, len(payload.get("positions", [])), kept, skipped))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with io.open(out_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(rows)
    print("Записано: %s, строк с данными: %d" % (out_path, len(rows)))
    print("Сводка: " + json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
