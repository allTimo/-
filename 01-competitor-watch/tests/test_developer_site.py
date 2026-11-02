#!/usr/bin/env python3
r"""Tests for developer-site collection (T62): корпуса, шахматка, акции, честные статусы."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
PAGES = TESTS_DIR / "fixtures" / "pages"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import developer_site as dev     # noqa: E402
import platforms                 # noqa: E402


class ParserTestCase(unittest.TestCase):
    """Разбор реального фрагмента страницы РГ-Девелопмент (ЖК Михалковский)."""

    @classmethod
    def setUpClass(cls):
        cls.html = (PAGES / "developer-site-mihalkovsky.html").read_text(encoding="utf-8")

    def test_01_corpi_from_real_page(self):
        corpi = dev.parse_corpi(self.html)
        self.assertEqual(corpi["count_named"], 7)
        self.assertIn("Корпус 1", corpi["names"])
        self.assertIn("Корпус 7", corpi["names"])

    def test_02_deadlines_are_validated(self):
        corpi = dev.parse_corpi(self.html)
        self.assertTrue(any("2027" in item for item in corpi["deadlines"]))
        # мусорные «кварталы» (8, 2057) не должны попадать
        for item in corpi["deadlines"]:
            quarter = int(item.split()[0])
            year = int(item.split()[2])
            self.assertTrue(1 <= quarter <= 4, item)
            self.assertTrue(2024 <= year <= 2035, item)

    def test_03_promos_from_real_page(self):
        promos = dev.parse_site_promos(self.html)
        joined = " ".join(promos["promos"]).upper()
        self.assertIn("СКИДКА", joined)
        self.assertIn("РАССРОЧКА", joined)
        self.assertGreaterEqual(promos["promo_count"], 1)

    def test_04_chessboard_not_published_is_none(self):
        chess = dev.parse_chessboard(self.html)
        self.assertFalse(chess["published"])
        for key in ("flats_total", "in_sale", "sold", "reserved"):
            self.assertIsNone(chess[key], key)
        self.assertIn("не публикует", chess["source_note"])

    def test_05_chessboard_from_js_state(self):
        html = ('<html><body><script>window.__INITIAL_STATE__ = '
                '{"project":{"flatsTotal":624,"sold":318,"reserved":26,"inSale":280}};</script>'
                '</body></html>')
        chess = dev.parse_chessboard(html)
        self.assertTrue(chess["published"])
        self.assertEqual(chess["flats_total"], 624)
        self.assertEqual(chess["sold"], 318)
        self.assertEqual(chess["reserved"], 26)
        self.assertEqual(chess["in_sale"], 280)

    def test_06_metrics_and_sold_share(self):
        parsed = {"corpi": dev.parse_corpi(self.html), "chessboard": dev.parse_chessboard(self.html),
                  "promos": dev.parse_site_promos(self.html), "method": "dom"}
        metrics = dev.site_metrics(parsed)
        self.assertEqual(metrics["site_corpi_named"]["value"], 7)
        self.assertEqual(metrics["site_corpi_named"]["source"], dev.SOURCE_LABEL)
        self.assertEqual(metrics["site_corpi_named"]["method"], "dom")
        self.assertIn("корпус", metrics["site_corpi_named"]["comment"])
        # шахматки нет — null и honest-комментарий, а не нули
        self.assertIsNone(metrics["site_flats_sold"]["value"])
        share = dev.sold_share_from_site(metrics)
        self.assertIsNone(share["value"])
        self.assertIn("не публикует", share["comment"])
        # когда оба числа есть — доля считается
        parsed2 = dict(parsed, chessboard={"published": True, "flats_total": 624, "sold": 318,
                                           "reserved": 26, "in_sale": 280, "source_note": "с сайта"})
        metrics2 = dev.site_metrics(parsed2)
        share2 = dev.sold_share_from_site(metrics2)
        self.assertAlmostEqual(share2["value"], 51.0, places=1)
        self.assertIn("не Росреестр", share2["comment"])

    def test_07_source_is_never_rosreestr(self):
        parsed = {"corpi": dev.parse_corpi(self.html), "chessboard": dev.parse_chessboard(self.html),
                  "promos": dev.parse_site_promos(self.html), "method": "http"}
        for item in dev.site_metrics(parsed).values():
            self.assertEqual(item["source"], "сайт застройщика")
            self.assertNotIn("Росреестр", item["source"])
            self.assertNotIn("ЕИСЖС", item["source"])


class FetchPolicyTestCase(unittest.TestCase):
    def setUp(self):
        self.original = (platforms.http_fetch, platforms.cdp_html, platforms.launch_chrome,
                         platforms.stop_chrome)

    def tearDown(self):
        (platforms.http_fetch, platforms.cdp_html, platforms.launch_chrome,
         platforms.stop_chrome) = self.original

    def test_10_http_page_is_used_without_browser(self):
        body = "<html><title>ЖК</title><body>" + ("Корпус 1 сдан. " * 60) + "</body></html>"
        platforms.http_fetch = lambda url, timeout=25, **kw: (200, body, None)
        platforms.launch_chrome = lambda **kw: (_ for _ in ()).throw(
            AssertionError("браузер не нужен, если HTTP отдал текст"))
        html, method, note = dev.fetch_developer_page("https://example.ru/zhk/")
        self.assertEqual(method, "http")
        self.assertIn("Корпус 1", html)

    def test_11_spa_skeleton_falls_back_to_browser(self):
        skeleton = "<html><body><div id=app></div><script src=/app.js></script></body></html>"
        rich = "<html><title>ЖК</title><body>" + ("Корпус 2 строится. " * 80) + "</body></html>"
        platforms.http_fetch = lambda url, timeout=25, **kw: (200, skeleton, None)
        platforms.launch_chrome = lambda **kw: (object(), "profile")
        platforms.cdp_html = lambda url, **kw: rich
        platforms.stop_chrome = lambda process, profile=None: None
        html, method, note = dev.fetch_developer_page("https://example.ru/zhk/")
        self.assertEqual(method, "dom")
        self.assertIn("Корпус 2", html)

    def test_12_browser_error_page_is_not_data(self):
        error_html = (PAGES / "chrome-cert-error.html").read_text(encoding="utf-8") + ("x" * 6000)
        platforms.http_fetch = lambda url, timeout=25, **kw: (None, "", "SSL error")
        platforms.launch_chrome = lambda **kw: (object(), "profile")
        platforms.cdp_html = lambda url, **kw: error_html
        platforms.stop_chrome = lambda process, profile=None: None
        html, method, note = dev.fetch_developer_page("https://example.ru/zhk/")
        self.assertEqual(html, "")
        self.assertEqual(method, "none")
        self.assertIn("страницу-ошибку", note)

    def test_13_thin_page_is_reported_as_no_data(self):
        thin = "<html><body><div id=root>Загрузка…</div></body></html>"
        platforms.http_fetch = lambda url, timeout=25, **kw: (200, thin, None)
        platforms.launch_chrome = lambda **kw: (object(), "profile")
        platforms.cdp_html = lambda url, **kw: thin
        platforms.stop_chrome = lambda process, profile=None: None
        html, method, note = dev.fetch_developer_page("https://example.ru/zhk/")
        self.assertEqual(html, "")
        self.assertEqual(method, "none")
        self.assertIn("заглушка", note)

    def test_14_collect_handles_unavailable_source(self):
        platforms.http_fetch = lambda url, timeout=25, **kw: (403, "", "HTTP 403")
        platforms.launch_chrome = lambda **kw: (_ for _ in ()).throw(RuntimeError("нет chrome"))
        data = dev.collect("https://example.ru/zhk/", allow_browser=True)
        self.assertFalse(data["ok"])
        self.assertEqual(data["method"], "none")
        metrics = dev.site_metrics(data)
        self.assertIsNone(metrics["site_corpi_named"]["value"])
        self.assertIsNone(metrics["site_flats_sold"]["value"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
