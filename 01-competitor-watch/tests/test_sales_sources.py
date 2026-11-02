#!/usr/bin/env python3
r"""Tests for sales sources (T66): ЕИСЖС verdict, ДОМ.РФ indicators, honest nulls."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
PAGES = TESTS_DIR / "fixtures" / "pages"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import platforms            # noqa: E402
import sales_sources as ss  # noqa: E402


class DomrfTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (PAGES.parent / "domrf-analytics.sample.html").read_text(encoding="utf-8")

    def test_01_real_fixture_parses(self):
        parsed = ss.extract_domrf_indicators(self.html)
        self.assertGreaterEqual(len(parsed["indicators"]), 5)   # в фикстуре — реальный фрагмент
        titles = " ".join(item["title"] for item in parsed["indicators"])
        self.assertTrue(any(word in titles for word in ("ипотек", "цен", "продаж")))
        for item in parsed["indicators"]:
            self.assertTrue(item["title"])
            self.assertIsInstance(item["sales_related"], bool)

    def test_02_sales_related_flag(self):
        parsed = ss.extract_domrf_indicators(self.html)
        sales = [item for item in parsed["indicators"] if item["sales_related"]]
        self.assertGreaterEqual(len(sales), 1)
        mortgage = [item for item in parsed["indicators"] if "ипотек" in item["title"].lower()]
        self.assertTrue(mortgage)
        self.assertTrue(mortgage[0]["value"])

    def test_03_metrics_carry_source_and_date(self):
        parsed = ss.extract_domrf_indicators(self.html)
        parsed.update({"status": "ok", "source": "ДОМ.РФ (дом.рф/аналитика)",
                       "url": ss.DOMRF_ANALYTICS, "collected_at": "2026-11-01",
                       "news": ["Продажи новостроек выросли"]})
        metrics = ss.domrf_metrics(parsed)
        self.assertGreaterEqual(metrics["market_sales_indicators_count"]["value"], 1)
        self.assertEqual(metrics["market_sales_indicators_count"]["source"], "ДОМ.РФ (дом.рф/аналитика)")
        self.assertEqual(metrics["market_sales_indicators_count"]["collected_at"], "2026-11-01")
        self.assertIn("не по конкретному ЖК", metrics["market_sales_indicators"]["comment"])
        self.assertEqual(metrics["market_news_count"]["value"], 1)

    def test_04_empty_source_gives_nulls_not_zeros(self):
        parsed = ss.extract_domrf_indicators("<html><body>нет данных</body></html>")
        self.assertEqual(parsed["indicators"], [])
        metrics = ss.domrf_metrics({"status": "unavailable", "indicators": [], "news": [],
                                    "collected_at": "2026-11-01", "source": "ДОМ.РФ"})
        self.assertIsNone(metrics["market_sales_indicators_count"]["value"])
        self.assertIsNone(metrics["market_sales_indicators"]["value"])
        self.assertIsNone(metrics["market_news_count"]["value"])


class EiszsProbeTestCase(unittest.TestCase):
    def setUp(self):
        self.original = platforms.http_fetch

    def tearDown(self):
        platforms.http_fetch = self.original

    def test_10_503_means_service_unavailable_not_blocked(self):
        platforms.http_fetch = lambda url, **kwargs: (503, "", "HTTP 503")
        verdict = ss.probe_eiszhs(verify=False)
        self.assertEqual(verdict["status"], "недоступен")
        self.assertTrue(all(item["verdict"] == "unavailable" for item in verdict["attempts"]))
        self.assertIn("503", verdict["attempts"][0]["note"])
        self.assertEqual(verdict["tls_verification"], "отключена")

    def test_11_working_endpoint_is_reported(self):
        platforms.http_fetch = lambda url, **kwargs: (200, '{"items":[]}' + "x" * 200, None)
        verdict = ss.probe_eiszhs(verify=False)
        self.assertEqual(verdict["status"], "доступен")
        self.assertTrue(all(item["verdict"] == "ok" for item in verdict["attempts"]))

    def test_12_disabled_page_is_distinguished(self):
        platforms.http_fetch = lambda url, **kwargs: (200, "<html>Сайт отключен</html>", None)
        verdict = ss.probe_eiszhs(verify=False)
        self.assertEqual(verdict["status"], "недоступен")
        self.assertTrue(all(item["verdict"] == "disabled" for item in verdict["attempts"]))

    def test_13_network_error_does_not_crash(self):
        def boom(url, **kwargs):
            raise RuntimeError("нет соединения")

        platforms.http_fetch = boom
        verdict = ss.probe_eiszhs(verify=False)
        self.assertEqual(verdict["status"], "недоступен")
        self.assertTrue(all(item["verdict"] == "error" for item in verdict["attempts"]))


class UnverifiedFetchTestCase(unittest.TestCase):
    def test_20_unverified_opener_is_opt_in(self):
        self.assertIsNotNone(platforms.build_unverified_opener())
        import inspect
        source = inspect.getsource(platforms.http_fetch)
        self.assertIn("verify", source)

    def test_21_probe_list_covers_hosts_and_apis(self):
        labels = " ".join(label for _, label in ss.EISZHS_PROBES).lower()
        for expected in ("api", "мобильн", "http"):
            self.assertIn(expected, labels)


if __name__ == "__main__":
    unittest.main(verbosity=2)
