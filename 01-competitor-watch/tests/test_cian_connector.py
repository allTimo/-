#!/usr/bin/env python3
r"""Tests for the CIAN connector source (T70): search, matching, price history, cross-check."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"
MOCK = TESTS_DIR / "fixtures" / "connector" / "mock-responses.json"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cian_connector as cc   # noqa: E402


class ConnectorStatusTestCase(unittest.TestCase):
    def tearDown(self):
        os.environ.pop(cc.MOCK_ENV, None)
        os.environ.pop(cc.WRAPPER_ENV, None)

    def test_01_missing_wrapper_is_honest(self):
        os.environ[cc.WRAPPER_ENV] = str(Path(tempfile.gettempdir()) / "no-such-wrapper.ps1")
        status = cc.connector_status()
        self.assertFalse(status["available"])
        self.assertEqual(status["mode"], "none")
        self.assertIn("не найдена", status["reason"])
        result = cc.run_connector("cian_search", {"region": 1})
        self.assertEqual(result["status"], "коннектор недоступен")
        self.assertIsNone(result["data"])
        self.assertIn("T69", result["note"])

    def test_02_mock_mode_reports_itself(self):
        os.environ[cc.MOCK_ENV] = str(MOCK)
        self.assertTrue(cc.connector_status()["available"])
        self.assertEqual(cc.connector_status()["mode"], "mock")
        result = cc.run_connector("cian_search", {"region": 1})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["method"], "connector-mock")
        self.assertIn("мока", result["note"])

    def test_03_mock_without_tool_is_honest(self):
        os.environ[cc.MOCK_ENV] = str(MOCK)
        result = cc.run_connector("cian_unknown_tool", {})
        self.assertEqual(result["status"], "нет данных в моке")
        self.assertIsNone(result["data"])


class SearchTestCase(unittest.TestCase):
    def setUp(self):
        os.environ[cc.MOCK_ENV] = str(MOCK)

    def tearDown(self):
        os.environ.pop(cc.MOCK_ENV, None)

    def test_10_search_uses_numeric_region_and_filters(self):
        result = cc.cian_search(region=1, rooms=2, price_min=15000000, price_max=25000000)
        self.assertEqual(result["status"], "ok")
        # ГРАБЛИ коннектора: region передаётся СТРОКОЙ, rooms — СПИСКОМ
        self.assertEqual(result["params"]["region"], "1")
        self.assertIsInstance(result["params"]["region"], str)
        self.assertEqual(result["params"]["deal"], "sale")
        self.assertEqual(result["params"]["offer_type"], "flat")
        self.assertEqual(result["params"]["rooms"], [2])
        for forbidden in ("newbuilding_name", "category", "seller_type"):
            self.assertNotIn(forbidden, result["params"],
                             "коннектор не принимает этот параметр (проверено живьём)")
        self.assertEqual(len(result["lots"]), 3)

    def test_11_bad_filters_are_rejected(self):
        self.assertEqual(cc.cian_search(deal="buy")["status"], "неверный фильтр")
        self.assertEqual(cc.cian_search(offer_type="villa")["status"], "неверный фильтр")

    def test_12_lots_are_normalized(self):
        first = cc.cian_search()["lots"][0]
        self.assertEqual(first["lot_id"], "123456789")
        self.assertEqual(first["price_rub"], 18450000)
        self.assertEqual(first["area_m2"], 56.4)
        self.assertEqual(first["rooms"], 2)
        self.assertEqual(first["source"], "cian-connector")
        self.assertIn("Корпус 2", first["building"])

    def test_13_project_matching_and_ambiguity(self):
        lots = cc.cian_search()["lots"]
        exact = cc.match_project(lots, "Селигер Сити")
        self.assertEqual(exact["status"], "подтверждено")
        self.assertEqual(len(exact["lots"]), 1)
        ambiguous = cc.match_project(lots, "Дмитровское небо")
        self.assertEqual(ambiguous["status"], "требует подтверждения")
        self.assertEqual(len(ambiguous["lots"]), 2)
        metro = cc.match_project(lots, "Неизвестный ЖК", metro="Селигерская")
        self.assertEqual(metro["status"], "требует подтверждения")
        none = cc.match_project(lots, "ЖК Которого Нет")
        self.assertEqual(none["status"], "не найдено")
        self.assertEqual(none["lots"], [])


class PriceHistoryTestCase(unittest.TestCase):
    def setUp(self):
        os.environ[cc.MOCK_ENV] = str(MOCK)
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-lot-history-"))
        self.original_data = cc.DATA_DIR
        cc.DATA_DIR = self.tmp

    def tearDown(self):
        os.environ.pop(cc.MOCK_ENV, None)
        cc.DATA_DIR = self.original_data

    def test_20_card_history_is_sorted_and_saved(self):
        result = cc.cian_card("123456789", client_id="client-svet")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["price_history"]), 3)
        dates = [item["date"] for item in result["price_history"]]
        self.assertEqual(dates, sorted(dates))
        saved = Path(result["saved"])
        self.assertTrue(saved.exists())
        payload = json.loads(saved.read_text(encoding="utf-8-sig"))
        self.assertEqual(payload["source"], "cian-connector")
        self.assertEqual(len(payload["history"]), 3)

    def test_21_second_save_creates_backup(self):
        first = cc.cian_card("123456789", client_id="client-svet")
        cc.cian_card("123456789", client_id="client-svet")
        self.assertEqual(len(list(Path(first["saved"]).parent.glob("*.bak-*"))), 1)

    def test_22_history_metrics_are_correct(self):
        histories = {
            "A": [{"date": "2026-09-01", "price_rub": 20000000},
                  {"date": "2026-11-01", "price_rub": 18000000}],
            "B": [{"date": "2026-09-01", "price_rub": 25000000},
                  {"date": "2026-10-20", "price_rub": 20000000}],
            "C": [{"date": "2026-09-01", "price_rub": 30000000},
                  {"date": "2026-10-05", "price_rub": 31500000}],
            "D": [{"date": "2026-09-01", "price_rub": 15000000},
                  {"date": "2026-09-20", "price_rub": 15000000}],
            "E": [{"date": "2026-10-01", "price_rub": 12000000}],
        }
        metrics = cc.price_history_metrics(histories)
        self.assertEqual(metrics["lots_with_history"], 4)
        self.assertEqual(metrics["lots_decreased"], 2)
        self.assertEqual(metrics["lots_increased"], 1)
        self.assertEqual(metrics["lots_unchanged"], 1)
        self.assertEqual(metrics["avg_decrease_depth_pct"], 15.0)
        self.assertEqual(metrics["share_decreased_pct"], 50.0)
        self.assertEqual(metrics["last_price_change"], "2026-11-01")
        self.assertEqual(metrics["price_pressure_pct"], 7.5)

    def test_23_profile_metrics_marked_as_connector_source(self):
        metrics = cc.history_metrics({"lots_with_history": 4, "lots_decreased": 2,
                                      "lots_increased": 1, "lots_unchanged": 1,
                                      "avg_decrease_depth_pct": 15.0, "share_decreased_pct": 50.0,
                                      "last_price_change": "2026-11-01", "price_pressure_pct": 7.5})
        for key, item in metrics.items():
            self.assertEqual(item["source"], "cian-connector", key)
            self.assertTrue(item["collected_at"])
        self.assertEqual(metrics["price_pressure_pct"]["method"], "estimate")
        self.assertIn("оценка", metrics["price_pressure_pct"]["comment"])

    def test_24_no_history_gives_nulls_with_reason(self):
        metrics = cc.history_metrics(cc.price_history_metrics({}))
        for key, item in metrics.items():
            self.assertIsNone(item["value"], key)
            self.assertIn("коннектор", item["comment"])
            self.assertEqual(item["method"], "none")

    def test_25_snapshot_keeps_source_column(self):
        path = cc.save_connector_snapshot("client-svet", cc.cian_search()["lots"], date="2026-11-01")
        text = Path(path).read_text(encoding="utf-8-sig")
        self.assertIn("source", text.splitlines()[0])
        self.assertIn("cian-connector", text)
        self.assertEqual(path.name, "2026-11-01-lots.csv")


class CompareSourcesTestCase(unittest.TestCase):
    def test_30_discrepancies_are_shown(self):
        connector = {"lot_id": "1", "price_rub": 18000000, "area_m2": 56.4, "rooms": 2,
                     "address": "Москва, Дмитровское шоссе, 83А"}
        http = {"lot_id": "1", "price_rub": 19000000, "area_m2": 56.4, "rooms": 2,
                "address": "Москва, Дмитровское шоссе, 83"}
        result = cc.compare_lot_sources(connector, http)
        self.assertTrue(result["matched"])
        fields = [item["field"] for item in result["differences"]]
        self.assertIn("price_rub", fields)
        self.assertIn("address", fields)
        self.assertNotIn("area_m2", fields)
        price = [item for item in result["differences"] if item["field"] == "price_rub"][0]
        self.assertEqual(price["connector"], 18000000)
        self.assertEqual(price["http"], 19000000)
        self.assertAlmostEqual(price["delta_pct"], 5.26, places=1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
