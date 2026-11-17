#!/usr/bin/env python3
"""qa-f9-probe.py — точечная проверка исправления D-F9-DUP.

Было: мягкая (loose) ступень забирала ключ эталона, который позже брала точная подпись,
и в одной дате появлялись два одинаковых lot_id.
Стало: сначала все точные сопоставления, затем мягкие; использованный ключ уходит из
`available` через `_consume()`. Ожидание: ключи уникальны, точная подпись выигрывает.

Фикстуры свои, в `_ux-harness/tmp/f9-probe`, реальные снимки не трогаются.

    python marketing-agents\\dashboard\\_ux-harness\\qa-f9-probe.py
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
SCRIPTS = PROJECT / "01-competitor-watch" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import cwlib as cw                       # noqa: E402
import migrate_lot_ids as mig            # noqa: E402

COLS = list(cw.COLUMNS)
WORK = HERE / "tmp" / "f9-probe"
OK = 0
FAIL = 0


def check(label, cond, detail=""):
    global OK, FAIL
    print("  " + ("OK  " if cond else "FAIL") + " " + label + ("  (%s)" % detail if detail else ""))
    if cond:
        OK += 1
    else:
        FAIL += 1


def prow(**over):
    base = {c: "" for c in COLS}
    base.update({"snapshot_date": "2026-11-03", "source": "cian", "competitor": "C",
                 "project": "P", "lot_id": "", "url": "", "rooms": "2", "area_m2": "50",
                 "floor": "5", "floors_total": "20", "building": "A", "price_rub": "10000000",
                 "price_per_m2_rub": "200000", "finish": "unknown", "promo_flag": "0",
                 "promo_text": "", "delivery": "", "status": "active"})
    base.update(over)
    return base


def run_case(name: str, ref_rows, old_rows, expect_old_key_kept: str):
    client = WORK / name / "data" / "clients" / "client-probe"
    for date, rows in (("2026-11-04", ref_rows), ("2026-11-03", old_rows)):
        path = client / "snapshots" / date / "lots.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(mig.rows_to_csv_text(rows), encoding="utf-8")
    report = mig.migrate_client(client, reference_date="2026-11-04")
    stats = report["dates"]["2026-11-03"]
    keys = [r["lot_id"] for r in mig.load_rows(client / "snapshots" / "2026-11-03" / "lots.csv")]
    print("  %s: ключи %s, matched_exact %d + matched_loose %d, unmatched %d, reverted_duplicates %d"
          % (name, keys, stats["matched_exact"], stats["matched_loose"], stats["unmatched"],
             stats.get("reverted_duplicates", 0)))
    check("%s: строк столько же и ключи УНИКАЛЬНЫ" % name,
          len(keys) == len(old_rows) and len(keys) == len(set(keys)), str(keys))
    check("%s: точное сопоставление выигрывает (ключ эталона у точной строки)" % name,
          "n-KKKK0001" in keys and stats["matched_exact"] >= 1, str(keys))
    check("%s: строка без точной подписи сохраняет свой старый ключ" % name,
          expect_old_key_kept in keys, "ожидался %s" % expect_old_key_kept)
    check("%s: страховка reverted_duplicates не понадобилась" % name,
          stats.get("reverted_duplicates", 0) == 0, str(stats.get("reverted_duplicates")))


def main() -> int:
    shutil.rmtree(WORK, ignore_errors=True)

    # Вариант 1 (исходная фикстура дефекта): мягкая строка раньше точной, отличаются комнатами.
    run_case("case-rooms-order",
             [prow(snapshot_date="2026-11-04", rooms="2", building="A", lot_id="n-KKKK0001")],
             [prow(rooms="0", building="A", lot_id="cian-old0001", price_rub="9000000",
                   price_per_m2_rub="180000"),
              prow(rooms="2", building="A", lot_id="cian-old0002")],
             "cian-old0001")

    # Вариант 2 (реалистичнее): строки различаются только корпусом, порядок тоже «мягкая раньше точной».
    run_case("case-building-order",
             [prow(snapshot_date="2026-11-04", rooms="2", building="A", lot_id="n-KKKK0001")],
             [prow(rooms="2", building="B", lot_id="cian-old0011", price_rub="9500000",
                   price_per_m2_rub="190000"),
              prow(rooms="2", building="A", lot_id="cian-old0012")],
             "cian-old0011")

    print("")
    print("Итог: OK %d, ПРОВАЛ %d" % (OK, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
