#!/usr/bin/env python3
r"""Tests for the extended competitor profile (T59): metrics, analytics, honest sources."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                      # noqa: E402
import competitor_profile as cp         # noqa: E402
import platforms                        # noqa: E402


def lot(price=12000000, area=50.0, rooms=2, promo="", title="2-комн. квартира"):
    return {"price_rub": price, "area_m2": area, "rooms": rooms, "promo_text": promo,
            "title": title, "floor": None, "floors_total": None, "delivery": "",
            "building": ""}


class LotsStatsTestCase(unittest.TestCase):
    def test_01_prices_and_rooms(self):
        lots = [lot(12000000, 50.0, 2), lot(20000000, 50.0, 2), lot(8000000, 25.0, 0),
                lot(9000000, 30.0, 0), lot(30000000, 100.0, 4)]
        stats = cp.price_stats(lots)
        self.assertEqual(stats["count"], 5)
        self.assertEqual(stats["prices"]["min"], 8000000)
        self.assertEqual(stats["prices"]["median"], 12000000)
        self.assertEqual(stats["prices"]["max"], 30000000)
        # ₽/м²: 240000, 400000, 320000, 300000, 300000 → медиана 300000
        self.assertEqual(stats["ppm2"]["median"], 300000)
        self.assertEqual(stats["by_rooms"]["студии"]["count"], 2)
        self.assertEqual(stats["by_rooms"]["2"]["count"], 2)
        self.assertEqual(stats["by_rooms"]["4+"]["count"], 1)
        self.assertEqual(stats["by_rooms"]["3"]["count"], 0)
        self.assertEqual(stats["by_rooms"]["3"]["median_price"], None)
        self.assertEqual(stats["areas"]["average"], 51.0)

    def test_02_median_is_engine_style(self):
        lots = [lot(10000000, 50.0, 2), lot(20000000, 50.0, 2)]
        stats = cp.price_stats(lots)
        self.assertEqual(stats["ppm2"]["median"], 300000)      # (200000+400000)/2

    def test_03_reserved_and_sold_marks(self):
        lots = [dict(lot(), title="2-комн. квартира, забронировано"),
                dict(lot(), title="1-комн. квартира, продано"),
                dict(lot(), title="студия")]
        self.assertEqual([cp.lot_status(item["title"]) for item in lots],
                         ["reserved", "sold", "active"])
        stats = cp.price_stats(lots)
        self.assertEqual(stats["reserved"], 1)
        self.assertEqual(stats["sold_marked"], 1)

    def test_04a_json_and_layout_fragments_are_not_promos(self):
        """Мусор из вёрстки/JSON Циан не должен попадать в текст акции."""
        junk = ['"subtitle":"Найдите подходящую к',
                'скидкой по вашим параметрам пока нет',
                '","key":"offer","value":',
                'Только на Циан ЖК «Тест»']
        for fragment in junk:
            self.assertFalse(platforms.looks_like_promo_text(fragment), fragment)
            self.assertEqual(platforms.clean_promo_text(fragment), "", fragment)
        self.assertEqual(platforms.clean_promo_text("Скидка 5% при полной оплате до 30 ноября"),
                         "Скидка 5% при полной оплате до 30 ноября")
        lots = [lot(promo='"subtitle":"Найдите подходящую к'), lot(promo="")]
        self.assertEqual(cp.promos(lots)["count"], 0)

    def test_04b_absence_of_data_is_null_not_zero(self):
        """Нет признака брони на странице → null (данных нет), а не 0."""
        lots = [lot(), lot()]
        unknown = cp.price_stats(lots, markers={"reserved": False, "sold": False})
        self.assertIsNone(unknown["reserved"])
        self.assertIsNone(unknown["sold_marked"])
        marked = cp.price_stats([dict(lot(), title="2-комн. забронировано"), lot()],
                                markers={"reserved": True, "sold": True})
        self.assertEqual(marked["reserved"], 1)
        self.assertEqual(marked["sold_marked"], 0)

    def test_04c_no_promo_texts_is_null_not_zero(self):
        """Текстов акций нет — это null с причиной, а не «0 акций»."""
        html = ('<html><body><h1>ЖК Тест</h1><div data-testid="offer-card">'
                '15 000 000 ₽ 2-комн. 50 м² 8/24 эт.</div>'
                '<a>7 акций Только на Циан ЖК «Тест»</a></body></html>')
        original = platforms.http_fetch
        platforms.http_fetch = lambda url, timeout=25, **kw: (200, html, None)
        try:
            profile = cp.build_profile("ЖК Тест", "https://www.cian.ru/zhk-test/", "cian")
        finally:
            platforms.http_fetch = original
        promo = profile["metrics"]["promo_count"]
        self.assertIsNone(promo["value"])
        self.assertIn("не раскрыты", promo["comment"])
        self.assertIn("7 акций", promo["comment"])

    def test_04_platform_banners_are_not_promos(self):
        lots = [lot(promo="Только на Циан ЖК «Тест» до 30 ноября"),
                lot(promo="Скидка 10% при полной оплате"),
                lot(promo="")]
        stats = cp.promos(lots)
        self.assertEqual(stats["count"], 1)
        self.assertEqual(stats["texts"], ["Скидка 10% при полной оплате"])


class HistoryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-profile-test-"))
        self.snapshots = self.tmp / "snapshots"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_snapshot(self, date, rows):
        target = self.snapshots / date
        target.mkdir(parents=True, exist_ok=True)
        cw.write_csv(target / "lots.csv", rows)

    def row(self, lot_id, price, area=50.0, promo=0):
        return {"snapshot_date": "2026-11-01", "source": "cian", "competitor": "C",
                "project": "ЖК Тест", "lot_id": lot_id, "url": "", "rooms": 2, "area_m2": area,
                "floor": 5, "floors_total": 20, "building": "", "price_rub": price,
                "price_per_m2_rub": int(price / area), "finish": "unknown", "promo_flag": promo,
                "promo_text": "Скидка" if promo else "", "delivery": "2027-Q2", "status": "active"}

    def test_10_history_needs_two_weeks(self):
        self.write_snapshot("2026-10-25", [self.row("L1", 10000000)])
        history = cp.load_history(self.snapshots, "ЖК Тест")
        result = cp.history_metrics(history)
        self.assertFalse(result["available"])
        self.assertEqual(result["needed"], 2)
        derived = cp.derived_metrics(result, {"count": 1, "ppm2": {"median": 200000}})
        self.assertIsNone(derived["sales_speed_per_week"]["value"])
        self.assertIn("нужно минимум 2 недели", derived["sales_speed_per_week"]["comment"])
        self.assertEqual(derived["sales_speed_per_week"]["method"], "estimate")

    def test_11_dynamics_from_two_snapshots(self):
        self.write_snapshot("2026-10-25", [self.row("L1", 10000000, promo=1),
                                           self.row("L2", 12000000, promo=1),
                                           self.row("L3", 14000000)])
        self.write_snapshot("2026-11-01", [self.row("L1", 11000000, promo=1),
                                           self.row("L4", 9000000)])
        history = cp.load_history(self.snapshots, "ЖК Тест")
        result = cp.history_metrics(history)
        self.assertTrue(result["available"])
        self.assertEqual(result["gone_total"], 2)              # L2 и L3 ушли
        self.assertEqual(result["gone_per_week"], 2.0)
        self.assertEqual(result["supply_first"], 3)
        self.assertEqual(result["supply_last"], 2)
        self.assertEqual(result["entry_price_first"], 10000000)
        self.assertEqual(result["entry_price_last"], 9000000)
        self.assertEqual(result["promo_weeks"], 2)

        stats = {"count": 2, "ppm2": {"median": 300000}}
        derived = cp.derived_metrics(result, stats, district_median_ppm2=400000, our_price=250000)
        self.assertEqual(derived["sales_speed_per_week"]["value"], 2.0)
        self.assertEqual(derived["absorption_rate"]["value"], 50.0)          # 2 из (2+2)
        self.assertAlmostEqual(derived["months_to_sell_out"]["value"], 0.2, places=1)
        self.assertEqual(derived["entry_price_dynamics_pct"]["value"], -10.0)
        self.assertEqual(derived["supply_dynamics_pct"]["value"], -33.33)
        self.assertEqual(derived["promo_pressure_weeks"]["value"], 2)
        self.assertEqual(derived["price_index_vs_district"]["value"], 0.75)
        self.assertEqual(derived["gap_price_vs_us_pct"]["value"], 20.0)
        self.assertIn("не данные Росреестра", derived["sales_speed_per_week"]["comment"])

    def test_12_risk_flags(self):
        flags = cp.risk_flags({"available": True}, {
            "supply_dynamics_pct": {"value": 25.0},
            "entry_price_dynamics_pct": {"value": -6.0},
            "promo_pressure_weeks": {"value": 3}})
        codes = {flag["code"] for flag in flags}
        self.assertEqual(codes, {"supply_surge", "price_drop", "promo_pressure"})
        self.assertEqual([flag["level"] for flag in flags if flag["code"] == "price_drop"],
                         ["critical"])
        soft = cp.risk_flags({"available": True}, {"supply_dynamics_pct": {"value": 1.0},
                                                   "entry_price_dynamics_pct": {"value": 0.0},
                                                   "promo_pressure_weeks": {"value": 0}})
        self.assertEqual(soft, [])
        no_history = cp.risk_flags({"available": False}, {})
        self.assertEqual(no_history[0]["code"], "no_history")


class RosreestrTestCase(unittest.TestCase):
    def test_20_http_and_browser_failures_are_reported(self):
        original_fetch = platforms.http_fetch
        original_cdp = platforms.cdp_html
        original_launch = platforms.launch_chrome
        original_stop = platforms.stop_chrome
        platforms.http_fetch = lambda url, timeout=20, **kw: (None, "", "SSL: CERTIFICATE_VERIFY_FAILED")
        platforms.launch_chrome = lambda **kw: (object(), "profile")
        platforms.cdp_html = lambda url, **kw: (_ for _ in ()).throw(RuntimeError("нет соединения"))
        platforms.stop_chrome = lambda process, profile=None: None
        try:
            payload, attempts, result = cp.rosreestr_status(allow_browser=True, use_cache=False)
        finally:
            platforms.http_fetch = original_fetch
            platforms.cdp_html = original_cdp
            platforms.launch_chrome = original_launch
            platforms.stop_chrome = original_stop
        self.assertIsNone(payload)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(result["status"], "источник недоступен")
        for entry in attempts:
            self.assertIn("SSL", str((entry["http"] or {}).get("error")))
            self.assertIn("error", entry["browser"])

    def test_21_browser_success_is_recorded(self):
        original_fetch = platforms.http_fetch
        original_cdp = platforms.cdp_html
        original_launch = platforms.launch_chrome
        original_stop = platforms.stop_chrome
        platforms.http_fetch = lambda url, timeout=20, **kw: (None, "", "SSL error")
        platforms.launch_chrome = lambda **kw: (object(), "profile")
        platforms.cdp_html = lambda url, **kw: "<html>" + "x" * 6000 + "</html>"
        platforms.stop_chrome = lambda process, profile=None: None
        try:
            payload, attempts, result = cp.rosreestr_status(allow_browser=True, use_cache=False)
        finally:
            platforms.http_fetch = original_fetch
            platforms.cdp_html = original_cdp
            platforms.launch_chrome = original_launch
            platforms.stop_chrome = original_stop
        self.assertIsNotNone(payload)
        self.assertEqual(result["status"], "получилось")
        self.assertEqual(len(result["reachable_via_browser"]), 2)
        self.assertTrue(all(entry["verdict"] == "ok" for entry in attempts))


class ProfileBuildTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-profile-build-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_30_unreachable_page_does_not_crash(self):
        original = platforms.http_fetch
        platforms.http_fetch = lambda url, timeout=25, **kw: (403, "<html>Доступ ограничен</html>", "HTTP 403")
        try:
            profile = cp.build_profile("ЖК Тест", "https://www.cian.ru/zhk-test/", "cian")
        finally:
            platforms.http_fetch = original
        self.assertIsNone(profile["metrics"]["lots_in_sale"]["value"])
        self.assertIn("источник недоступен", profile["metrics"]["lots_in_sale"]["comment"])
        self.assertTrue(profile["limitations"])
        self.assertEqual(profile["metrics"]["sold_official_rosreestr"]["value"], None)
        self.assertIn("не подменяем", profile["metrics"]["sold_official_rosreestr"]["comment"])

    def test_31_profile_from_page(self):
        html = ('<html><head><title>ЖК Тест — Циан</title>'
                '<script>var st={"address":"Москва, Ильменский проезд"}</script></head><body>'
                '<h1>ЖК Тест</h1>'
                '<div data-testid="offer-card">15 000 000 ₽ 2-комн. квартира, 50 м², 8/24 эт. '
                'Скидка 5% до 30 ноября</div>'
                '<div data-testid="offer-card">9 000 000 ₽ Студия, 25 м², 5/24 эт. забронировано</div>'
                '</body></html>')
        original = platforms.http_fetch
        platforms.http_fetch = lambda url, timeout=25, **kw: (200, html, None)
        try:
            profile = cp.build_profile("ЖК Тест", "https://www.cian.ru/zhk-test/", "cian")
        finally:
            platforms.http_fetch = original
        self.assertEqual(profile["metrics"]["lots_in_sale"]["value"], 2)
        self.assertEqual(profile["metrics"]["price_min_rub"]["value"], 9000000)
        self.assertEqual(profile["metrics"]["reserved_lots"]["value"], 1)
        self.assertEqual(profile["metrics"]["promo_count"]["value"], 1)
        self.assertEqual(profile["metrics"]["lots_in_sale"]["method"], "http")
        self.assertIn("cian.ru", profile["metrics"]["lots_in_sale"]["source"])
        self.assertTrue(profile["metrics"]["lots_in_sale"]["collected_at"])

    def test_32_summary_aggregates(self):
        profiles = [
            {"project": "A", "metrics": {"lots_in_sale": {"value": 28}, "price_per_m2_median": {"value": 400000}},
             "risk_flags": [{"code": "supply_surge", "level": "warning", "comment": "x"}]},
            {"project": "B", "metrics": {"lots_in_sale": {"value": 30}, "price_per_m2_median": {"value": 600000}},
             "risk_flags": []},
        ]
        summary = cp.build_summary("client-svet", profiles, {"status": "источник недоступен"})
        self.assertEqual(summary["projects"], 2)
        self.assertEqual(summary["lots_total"], 58)
        self.assertEqual(summary["price_per_m2_median"], 500000)
        self.assertEqual(len(summary["risk_flags"]), 1)
        self.assertEqual(summary["risk_flags"][0]["project"], "A")
        self.assertEqual(summary["rosreestr"]["status"], "источник недоступен")

    def test_33_write_json_is_atomic(self):
        target = self.tmp / "deep" / "profile.json"
        path = cp.write_json(target, {"ok": True})
        self.assertTrue(path.exists())
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["ok"], True)
        self.assertFalse(list(target.parent.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
