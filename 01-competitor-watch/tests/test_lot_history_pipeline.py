#!/usr/bin/env python3
r"""Tests for T71: связка HTTP-страницы проекта и истории цен коннектором."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cian_connector as cc              # noqa: E402
import lot_history_pipeline as lp        # noqa: E402
import platforms                         # noqa: E402

CARD_BLOCK = ('<div data-testid="offer-card">12 500 000 ₽ 2-комн. квартира, 56 м², 8/24 эт. '
              '<a href="/sale/flat/335180868/">подробнее</a></div>')


class OfferIdTestCase(unittest.TestCase):
    def test_01_id_and_url_from_card(self):
        offer_id, url = platforms.extract_offer_id(CARD_BLOCK, "cian")
        self.assertEqual(offer_id, "335180868")
        self.assertEqual(url, "https://www.cian.ru/sale/flat/335180868/")

    def test_02_no_id_is_none(self):
        offer_id, url = platforms.extract_offer_id("<div>цена и площадь без ссылки</div>", "cian")
        self.assertIsNone(offer_id)
        self.assertEqual(url, "")

    def test_03_cards_carry_ids(self):
        html = "<html><body>" + CARD_BLOCK * 3 + "</body></html>"
        parsed = platforms.parse_page(html, "cian")
        self.assertEqual(len(parsed["lots"]), 3)
        for lot in parsed["lots"]:
            self.assertEqual(lot["offer_id"], "335180868")
            self.assertTrue(lot["offer_url"].startswith("https://www.cian.ru/sale/flat/"))


class ProjectLotsTestCase(unittest.TestCase):
    def test_10_http_page_gives_lots_with_source(self):
        html = "<html><head><title>ЖК Тест</title></head><body><h1>ЖК Тест</h1>" + CARD_BLOCK + \
               "</body></html>"
        result = lp.project_lots("https://www.cian.ru/zhk-test/", expect_name="ЖК Тест",
                                 fetch=lambda url: (200, html, None))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["lots_with_id"], 1)
        self.assertEqual(result["lots"][0]["source"], "cian (http)")
        self.assertEqual(result["source"], lp.HTTP_SOURCE)

    def test_11_page_not_about_project(self):
        html = "<html><body><h1>Другой ЖК</h1>" + CARD_BLOCK + "</body></html>"
        result = lp.project_lots("https://www.cian.ru/x/", expect_name="ЖК Тест",
                                 fetch=lambda url: (200, html, None))
        self.assertEqual(result["status"], "страница не про этот проект")
        self.assertEqual(result["lots"], [])


class EnrichTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-pipeline-"))
        self.original_data = cc.DATA_DIR
        cc.DATA_DIR = self.tmp
        self.original_card = cc.cian_card
        self.original_sleep = lp.time.sleep
        lp.time.sleep = lambda seconds: None          # паузу в тестах не ждём
        self.calls = []

    def tearDown(self):
        cc.DATA_DIR = self.original_data
        cc.cian_card = self.original_card
        lp.time.sleep = self.original_sleep
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_card(self, status="ok", points=3, price=18000000):
        def inner(offer_id, client_id=None, save=True, project=None, extra=None, **kwargs):
            self.calls.append({"offer_id": offer_id, "project": project, "extra": extra})
            history = [{"date": "2026-09-%02d" % (index + 1), "price_rub": price - index * 100000}
                       for index in range(points)]
            saved = None
            if save and client_id:
                saved = cc.save_lot_history(client_id, offer_id, {"price_rub": price}, history,
                                            project=project)
            return {"status": status, "note": "", "card": {"price_rub": price},
                    "price_history": history, "saved": str(saved) if saved else None,
                    "source": "cian-connector", "method": "connector"}
        return inner

    def lots(self, count=5):
        return [{"offer_id": str(1000 + index), "price_rub": 18000000, "area_m2": 50.0,
                 "source": lp.HTTP_SOURCE} for index in range(count)]

    def test_20_limit_is_respected_and_project_is_bound(self):
        cc.cian_card = self.fake_card()
        result = lp.enrich_histories("zhk-test", self.lots(5), "client-svet", limit=2, pause=0)
        self.assertEqual(result["taken"], 2)
        self.assertEqual(len(result["cards"]), 2)
        for call in self.calls:
            self.assertEqual(call["project"], "zhk-test")
        saved = list((self.tmp / "client-svet" / "lot-history").glob("*.json"))
        self.assertEqual(len(saved), 2)
        payload = json.loads(saved[0].read_text(encoding="utf-8-sig"))
        self.assertEqual(payload["project"], "zhk-test")
        self.assertEqual(payload["source"], "cian-connector")

    def test_21_stops_on_connector_error(self):
        cc.cian_card = self.fake_card(status="ошибка коннектора", points=0)
        result = lp.enrich_histories("zhk-test", self.lots(5), "client-svet", limit=5, pause=0)
        self.assertEqual(result["taken"], 1, "при ошибке коннектора прогон останавливается")
        self.assertIsNotNone(result["stopped"])
        self.assertEqual(len(result["errors"]), 1)

    def test_22_daily_cache_skips_today(self):
        cc.cian_card = self.fake_card()
        first = lp.enrich_histories("zhk-test", self.lots(2), "client-svet", limit=2, pause=0)
        self.assertEqual(first["taken"], 2)
        second = lp.enrich_histories("zhk-test", self.lots(2), "client-svet", limit=2, pause=0)
        self.assertEqual(second["taken"], 0)
        self.assertEqual(second["skipped_cached"], 2)
        third = lp.enrich_histories("zhk-test", self.lots(2), "client-svet", limit=2, pause=0,
                                   cache_day=False)
        self.assertEqual(third["taken"], 2)

    def test_23_price_cross_check_and_plausibility(self):
        cc.cian_card = self.fake_card(price=10000000, points=2)
        lots = [{"offer_id": "1", "price_rub": 10000000, "area_m2": 50.0},
                {"offer_id": "2", "price_rub": 50000000, "area_m2": 37.4}]   # 1.34 млн ₽/м² — битая
        result = lp.enrich_histories("zhk-test", lots, "client-svet", limit=2, pause=0)
        first, second = result["cards"]
        self.assertEqual(first["price_diff_pct"], 0.0)
        self.assertNotIn("price_diff_pct", second)
        self.assertIn("недостоверной", second["price_check"])

    def test_24_plausibility_helpers(self):
        self.assertTrue(lp.price_is_plausible(25000000, 50.0))
        self.assertFalse(lp.price_is_plausible(50000000, 37.4))
        self.assertFalse(lp.price_is_plausible(3000000, 50.0))
        self.assertTrue(lp.price_is_plausible(None, 50.0))
        self.assertEqual(lp.price_per_m2(25000000, 50.0), 500000.0)


class MetricsByProjectTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-metrics-"))
        self.original_data = cc.DATA_DIR
        cc.DATA_DIR = self.tmp

    def tearDown(self):
        cc.DATA_DIR = self.original_data
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, lot_id, project, prices):
        cc.save_lot_history("client-svet", lot_id, {"price_rub": prices[-1]},
                            [{"date": "2026-09-%02d" % (index + 1), "price_rub": price}
                             for index, price in enumerate(prices)], project=project)

    def test_30_metrics_are_tied_to_project(self):
        self.write("1", "zhk-alpha", [20000000, 18000000])
        self.write("2", "zhk-alpha", [20000000, 17000000])
        self.write("3", "zhk-beta", [10000000, 11000000])
        result = cc.metrics_by_project("client-svet")
        self.assertEqual(result["projects_count"], 2)
        alpha = result["projects"]["zhk-alpha"]["metrics"]
        self.assertEqual(alpha["lots_with_price_history"]["value"], 2)
        self.assertEqual(alpha["lots_price_decreased"]["value"], 2)
        self.assertEqual(alpha["avg_price_decrease_pct"]["value"], 12.5)
        beta = result["projects"]["zhk-beta"]["metrics"]
        self.assertEqual(beta["lots_price_increased"]["value"], 1)
        self.assertEqual(beta["lots_price_decreased"]["value"], 0)
        self.assertEqual(result["total"]["lots_with_price_history"]["value"], 3)
        for project_metrics in (alpha, beta):
            for item in project_metrics.values():
                self.assertEqual(item["source"], "cian-connector")


class SupplementSearchTestCase(unittest.TestCase):
    def test_40_incomplete_sample_is_labelled(self):
        result = cc.search_with_newbuilding("Несуществующий ЖК", pages=1, script="нет-файла.mjs")
        self.assertIn(result["status"], ("коннектор недоступен", "node не найден"))
        self.assertTrue(result["incomplete_sample"])

    def test_41_studio_rooms_code(self):
        self.assertEqual(cc.STUDIO_ROOMS_CODE, 9)
        result = cc.cian_search(rooms=[cc.STUDIO_ROOMS_CODE], newbuilding_name=None)
        self.assertEqual(result["params"]["rooms"], [9])


if __name__ == "__main__":
    unittest.main(verbosity=2)
