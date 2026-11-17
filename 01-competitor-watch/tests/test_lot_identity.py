#!/usr/bin/env python3
r"""test_lot_identity.py - инварианты стабильного ключа лота (контракт F9, §4/§6.2).

Покрыто:
  * ступени идентичности n → u → c → r и формат `<префикс>-<8hex>`;
  * идемпотентность (тот же вход дважды → те же ключи) и инвариантность к перестановке;
  * изменение цены и позиции в выдаче не меняет ключ;
  * `url` попадает в строку снимка (`url`/`link`/`offer_url`), нет — пусто;
  * коллизия ключа не теряется молча: суффикс -2/-3, счётчик `lot_id_collisions`
    и предупреждение в «Ограничениях»;
  * одноразовый перенос ключей в старые снимки (§5.2) с `.bak` и отчётом.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                      # noqa: E402
import collect_clients                  # noqa: E402
import marketing_settings as ms         # noqa: E402
import migrate_lot_ids as mig           # noqa: E402
import platforms                        # noqa: E402

DATE = "2026-11-04"
SETTINGS = ms.load(agent_settings={})

CIAN_COMPETITOR = {"name": "Селигер Сити", "developer": "MR Group", "class": "бизнес",
                   "site": "", "platforms": {"cian": "https://cian.example/seliger"}}
CIAN_CLIENT = {"client_id": "client-test", "name": "Тест",
               "sources": [{"id": "cian", "enabled": True}],
               "competitors": [CIAN_COMPETITOR]}


def lot(**overrides):
    base = {"price_rub": 16_000_000, "area_m2": 40.0, "rooms": 1, "floor": 5,
            "floors_total": 20, "building": "", "title": "Квартира", "delivery": "2026-Q4",
            "promo_text": ""}
    base.update(overrides)
    return base


def row(**overrides):
    """Полная валидная строка снимка (для файлов миграции)."""
    base = {"snapshot_date": DATE, "source": "cian", "competitor": "MR Group",
            "project": "Селигер Сити", "lot_id": "old-0001", "url": "",
            "rooms": 1, "area_m2": 40.0, "floor": 5, "floors_total": 20, "building": "",
            "price_rub": 16_000_000, "price_per_m2_rub": 400_000, "finish": "unknown",
            "promo_flag": 0, "promo_text": "", "delivery": "2026-Q4", "status": "active"}
    base.update(overrides)
    return cw.ensure_ppm2(cw.coerce_row(base))


def collect(rows_of_lots, client=None):
    """collect_client с заглушкой источника; возвращает (rows, limitations, counters)."""

    def fake_platform(url, source_id, allow_browser=True, expect_name=""):
        return {"source": source_id, "platform": source_id, "url": url, "status": "ok", "note": "",
                "lots": rows_of_lots, "granularity": "lots", "price_from_rub": None}

    counters = {}
    with mock.patch.object(platforms, "collect_platform", fake_platform):
        results, rows, limitations = collect_clients.collect_client(
            client or CIAN_CLIENT, DATE, global_sources=[], marketing_settings=SETTINGS,
            counters=counters)
    return rows, limitations, counters


class IdentityStepTestCase(unittest.TestCase):
    """§4: ступени и формат ключа."""

    def test_01_native_id_has_priority_and_ignores_price_index(self):
        first = collect_clients.lot_id_for("cian", "C", "P", lot(offer_id="123456789"), 0)
        second = collect_clients.lot_id_for("cian", "C", "P",
                                            lot(offer_id="123456789", price_rub=99_000_000), 77)
        self.assertTrue(first.startswith("n-"), first)
        self.assertEqual(first, second)
        self.assertEqual(len(first.split("-")[1]), 8)

    def test_02_url_step_normalises_and_is_stable(self):
        a = collect_clients.lot_id_for("cian", "C", "P", lot(offer_url="https://WWW.Cian.ru/sale/flat/1/?utm=1#x"))
        b = collect_clients.lot_id_for("cian", "C", "P", {"price_rub": 1, "area_m2": 1, "rooms": 1,
                                                          "link": "https://www.cian.ru/sale/flat/1"})
        self.assertTrue(a.startswith("u-"), a)
        self.assertEqual(a, b)

    def test_03_content_step_ignores_price_and_order(self):
        plain = lot(floor=7, area_m2=41.5, rooms=2)
        base = collect_clients.lot_id_for("cian", "C", "P", plain, 0)
        changed_price = collect_clients.lot_id_for("cian", "C", "P",
                                                   dict(plain, price_rub=25_000_000), 9)
        self.assertTrue(base.startswith("c-"), base)
        self.assertEqual(base, changed_price)
        self.assertNotEqual(base, collect_clients.lot_id_for("cian", "C", "P",
                                                             dict(plain, rooms=3), 0))

    def test_04_raw_snapshot_step_when_content_is_empty(self):
        identity = collect_clients.lot_identity({}, "cian", "C", "P")
        self.assertEqual(identity["step"], "raw")
        self.assertEqual(identity["prefix"], "r")
        self.assertEqual(collect_clients.lot_id_for("cian", "C", "P", {}, 0),
                         collect_clients.lot_id_for("cian", "C", "P", {}, 5))

    def test_05_url_is_written_into_the_row(self):
        rows, _limitations, _counters = collect([lot(offer_url="https://www.cian.ru/sale/flat/777/")])
        self.assertEqual(rows[0]["url"], "https://www.cian.ru/sale/flat/777/")
        self.assertTrue(rows[0]["lot_id"].startswith("u-"))
        empty, _limitations, _counters = collect([lot()])
        self.assertEqual(empty[0]["url"], "")

    def test_06_steps_are_distributed_as_expected(self):
        rows, _limitations, counters = collect([
            lot(offer_id="111111"), lot(link="https://cian.ru/sale/flat/2"),
            lot(floor=9, area_m2=33.3)])
        steps = sorted(item["lot_id"][0] for item in rows)
        self.assertEqual(steps, ["c", "n", "u"])
        self.assertEqual(counters["lot_id_steps"], {"c": 1, "n": 1, "u": 1})


class CollisionTestCase(unittest.TestCase):
    """§4: коллизия не теряется молча, суффикс детерминирован."""

    def test_10_duplicate_signature_gets_suffix_and_counter(self):
        rows, limitations, counters = collect([lot(price_rub=10_000_000, area_m2=40.0, rooms=1),
                                               lot(price_rub=12_000_000, area_m2=40.0, rooms=1)])
        self.assertEqual(len(rows), 2, "оба лота обязаны остаться в снимке")
        ids = sorted(item["lot_id"] for item in rows)
        self.assertEqual(ids[1], ids[0] + "-2")
        self.assertEqual(counters["lot_id_collisions"], 1)
        self.assertIn("lot_id_collisions=1", limitations)
        self.assertIn("одинаковыми признаками", limitations)
        keys = {(item["source"], item["competitor"], item["project"], item["lot_id"]) for item in rows}
        self.assertEqual(len(keys), 2, "ключи внутри снимка должны быть уникальны")

    def test_11_suffix_order_is_deterministic(self):
        cheap = lot(price_rub=10_000_000, area_m2=40.0, rooms=1)
        pricey = lot(price_rub=12_000_000, area_m2=40.0, rooms=1)
        forward, _limitations, _counters = collect([cheap, pricey])
        backward, _limitations, _counters = collect([pricey, cheap])
        base = collect_clients.lot_id_for("cian", CIAN_COMPETITOR["developer"], CIAN_COMPETITOR["name"],
                                          cheap)
        self.assertEqual([item["lot_id"] for item in forward],
                         [base, base + "-2"], "дешёвый лот получает базовый ключ")
        # порядок выдачи не влияет: суффиксы раскладываются детерминированно (материал, цена)
        self.assertEqual([(item["price_rub"], item["lot_id"]) for item in backward],
                         [(item["price_rub"], item["lot_id"]) for item in forward])

    def test_12_permutation_keeps_keys_of_distinct_lots(self):
        lots = [lot(offer_id="A1", area_m2=40.0), lot(offer_id="A2", area_m2=41.0),
                lot(offer_id="A3", area_m2=42.0)]
        first, _limitations, _counters = collect(lots)
        second, _limitations, _counters = collect(list(reversed(lots)))
        by_area_first = {item["area_m2"]: item["lot_id"] for item in first}
        by_area_second = {item["area_m2"]: item["lot_id"] for item in second}
        self.assertEqual(by_area_first, by_area_second)

    def test_13_collection_is_idempotent(self):
        lots = [lot(offer_id="B1"), lot(link="https://cian.ru/sale/flat/9"), lot(area_m2=35.5)]
        first, _limitations, _counters = collect(lots)
        second, _limitations, _counters = collect(lots)
        self.assertEqual([item["lot_id"] for item in first],
                         [item["lot_id"] for item in second])


class MigrationTestCase(unittest.TestCase):
    """§5.2: перенос ключей по подписи содержимого, .bak и отчёт."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-f9-mig-"))
        self.client_dir = self.tmp / "client-test"
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, date, rows):
        path = self.client_dir / "snapshots" / date / "lots.csv"
        cw.write_csv(path, rows, header=cw.COLUMNS)
        return path

    def reference(self):
        return [
            row(lot_id="n-aaaaaaaa", url="https://cian.ru/sale/flat/1", rooms=1, area_m2=40.0,
                floor=5, floors_total=20),
            row(lot_id="n-bbbbbbbb", url="https://cian.ru/sale/flat/2", rooms=2, area_m2=60.0,
                floor=8, floors_total=20),
            row(lot_id="n-cccccccc", url="https://cian.ru/sale/flat/3", rooms=3, area_m2=80.0,
                floor=9, floors_total=25),
        ]

    def test_20_matched_rows_get_new_keys_unmatched_keep_old(self):
        self.write(DATE, self.reference())
        old = self.write("2026-11-03", [
            row(lot_id="old-0001", rooms=1, area_m2=40.0, floor=5, floors_total=20),
            row(lot_id="old-0002", rooms=2, area_m2=60.0, floor=8, floors_total=20),
            row(lot_id="old-0003", rooms=6, area_m2=200.0, floor=3, floors_total=25),
        ])
        report = mig.migrate_client(self.client_dir, out=None)
        stats = report["dates"]["2026-11-03"]
        self.assertEqual((stats["matched_exact"], stats["unmatched"], stats["changed"]),
                         (2, 1, 2))
        migrated = cw.load_snapshot_rows(old)
        self.assertEqual([item["lot_id"] for item in migrated],
                         ["n-aaaaaaaa", "n-bbbbbbbb", "old-0003"])
        backups = list(old.parent.glob("lots.csv.bak-*"))
        self.assertEqual(len(backups), 1, "старый файл обязан остаться в .bak")

    def test_21_loose_signature_matches_room_mismatch(self):
        self.write(DATE, self.reference() + [
            row(lot_id="n-dddddddd", url="", rooms=1, area_m2=44.4, floor=11, floors_total=20)])
        old = self.write("2026-11-03", [
            row(lot_id="old-0001", rooms=2, area_m2=44.4, floor=11, floors_total=20)])
        report = mig.migrate_client(self.client_dir)
        self.assertEqual(report["dates"]["2026-11-03"]["matched_loose"], 1)
        self.assertEqual(cw.load_snapshot_rows(old)[0]["lot_id"], "n-dddddddd")

    def test_22_ambiguous_loose_key_is_not_used(self):
        self.write(DATE, self.reference() + [
            row(lot_id="n-dddddddd", rooms=1, area_m2=44.4, floor=11, floors_total=20,
                price_rub=11_000_000),
            row(lot_id="n-eeeeeeee", rooms=2, area_m2=44.4, floor=11, floors_total=20,
                price_rub=12_000_000)])
        old = self.write("2026-11-03", [
            row(lot_id="old-0001", rooms=3, area_m2=44.4, floor=11, floors_total=20)])
        report = mig.migrate_client(self.client_dir)
        self.assertEqual(report["dates"]["2026-11-03"]["unmatched"], 1)
        self.assertEqual(cw.load_snapshot_rows(old)[0]["lot_id"], "old-0001")

    def test_23_duplicate_old_rows_do_not_reuse_one_reference_key(self):
        self.write(DATE, self.reference())
        old = self.write("2026-11-03", [
            row(lot_id="old-0001", rooms=1, area_m2=40.0, floor=5, floors_total=20),
            row(lot_id="old-0002", rooms=1, area_m2=40.0, floor=5, floors_total=20)])
        report = mig.migrate_client(self.client_dir)
        self.assertEqual(report["dates"]["2026-11-03"]["unmatched"], 1)
        ids = [item["lot_id"] for item in cw.load_snapshot_rows(old)]
        self.assertEqual(ids, ["n-aaaaaaaa", "old-0002"])

    def test_24_dry_run_writes_nothing(self):
        self.write(DATE, self.reference())
        old = self.write("2026-11-03", [row(lot_id="old-0001", rooms=1, area_m2=40.0, floor=5,
                                            floors_total=20)])
        before = old.read_bytes()
        mig.migrate_client(self.client_dir, dry_run=True)
        self.assertEqual(old.read_bytes(), before)
        self.assertFalse(list(old.parent.glob("lots.csv.bak-*")))

    def test_25_report_file_and_missing_reference(self):
        report_dir = self.tmp / "reports"
        self.write(DATE, self.reference())
        self.write("2026-11-03", [row(lot_id="old-0001", rooms=1, area_m2=40.0, floor=5,
                                       floors_total=20)])
        report = mig.migrate_client(self.client_dir, out=None)
        self.assertEqual(report["reference_date"], DATE)
        cw.json_dump(report_dir / "mig.json", report)
        self.assertTrue((report_dir / "mig.json").exists())
        empty = mig.migrate_client(self.tmp / "no-such-client")
        self.assertEqual(empty["status"], "no_snapshots")


    def test_26_loose_then_exact_never_gives_a_duplicate_key(self):
        """D-F9-DUP: строка с точной подписью не должна получить ключ, уже взятый мягкой."""
        reference = [row(lot_id="n-KKKK0001", rooms=2, area_m2=44.4, floor=11, floors_total=20)]
        self.write(DATE, reference)
        old = self.write("2026-11-03", [
            row(lot_id="old-0001", rooms=3, area_m2=44.4, floor=11, floors_total=20),
            row(lot_id="old-0002", rooms=2, area_m2=44.4, floor=11, floors_total=20),
        ])
        report = mig.migrate_client(self.client_dir)
        stats = report["dates"]["2026-11-03"]
        migrated = cw.load_snapshot_rows(old)
        ids = [item["lot_id"] for item in migrated]
        self.assertEqual(len(migrated), 2, "число строк меняться не должно")
        self.assertEqual(len(set(ids)), 2, "lot_id внутри даты обязан быть уникален: %s" % ids)
        self.assertEqual(ids, ["old-0001", "n-KKKK0001"],
                         "точное сопоставление выигрывает у мягкого")
        self.assertEqual((stats["matched_exact"], stats["matched_loose"], stats["unmatched"]),
                         (1, 0, 1))
        self.assertEqual(stats["reverted_duplicates"], 0)

    def test_27_used_key_leaves_available_for_later_exact_rows(self):
        """Ключ, взятый мягкой ступенью, израсходован: повторно его не отдаём."""
        reference = [row(lot_id="n-KKKK0001", rooms=2, area_m2=44.4, floor=11, floors_total=20)]
        self.write(DATE, reference)
        old = self.write("2026-11-03", [
            row(lot_id="old-0001", rooms=3, area_m2=44.4, floor=11, floors_total=20),
            row(lot_id="old-0002", rooms=2, area_m2=44.4, floor=11, floors_total=20),
            row(lot_id="old-0003", rooms=2, area_m2=44.4, floor=11, floors_total=20),
        ])
        report = mig.migrate_client(self.client_dir)
        stats = report["dates"]["2026-11-03"]
        ids = [item["lot_id"] for item in cw.load_snapshot_rows(old)]
        self.assertEqual(len(set(ids)), 3, ids)
        self.assertEqual(ids.count("n-KKKK0001"), 1, "ключ эталона выдаётся ровно один раз")
        self.assertEqual(stats["reverted_duplicates"], 0)

    def test_28_migration_on_real_snapshot_copies_is_idempotent(self):
        """Проверка на копиях живых снимков: без дублей, строки/колонки целы, повтор — no-op."""
        real = PROJECT_DIR / "data" / "clients" / "client-granel" / "snapshots"
        reference_file = real / "2026-11-04" / "lots.csv"
        backups = sorted((real / "2026-11-03").glob("lots.csv.bak-*")) if (real / "2026-11-03").is_dir() else []
        if not reference_file.exists() or not backups:
            self.skipTest("живые снимки client-granel недоступны")
        snapshots = self.client_dir / "snapshots"
        (snapshots / "2026-11-04").mkdir(parents=True)
        (snapshots / "2026-11-03").mkdir(parents=True)
        shutil.copy2(reference_file, snapshots / "2026-11-04" / "lots.csv")
        shutil.copy2(backups[-1], snapshots / "2026-11-03" / "lots.csv")
        before_rows = cw.load_snapshot_rows(snapshots / "2026-11-03" / "lots.csv")

        report = mig.migrate_client(self.client_dir)
        stats = report["dates"]["2026-11-03"]
        after_rows = cw.load_snapshot_rows(snapshots / "2026-11-03" / "lots.csv")
        ids = [item["lot_id"] for item in after_rows]
        self.assertEqual(len(after_rows), len(before_rows), "число строк обязано сохраниться")
        self.assertEqual(len(set(ids)), len(ids), "дублей lot_id быть не должно")
        self.assertEqual(stats["reverted_duplicates"], 0)
        self.assertEqual(list(after_rows[0]), cw.COLUMNS, "порядок колонок сохраняется")
        for old_row, new_row in zip(before_rows, after_rows):
            for column in cw.COLUMNS:
                if column != "lot_id":
                    self.assertEqual(old_row[column], new_row[column],
                                     "колонка %s не должна меняться" % column)
        first_bytes = (snapshots / "2026-11-03" / "lots.csv").read_bytes()
        backups_after_first = list((snapshots / "2026-11-03").glob("lots.csv.bak-*"))
        self.assertEqual(len(backups_after_first), 1, "первая правка обязана оставить .bak")

        again = mig.migrate_client(self.client_dir)
        self.assertEqual(again["dates"]["2026-11-03"]["changed"], 0, "повторный прогон — no-op")
        self.assertEqual((snapshots / "2026-11-03" / "lots.csv").read_bytes(), first_bytes)
        self.assertEqual(len(list((snapshots / "2026-11-03").glob("lots.csv.bak-*"))), 1,
                         "идемпотентный повтор не создаёт второй .bak")


if __name__ == "__main__":
    unittest.main()
