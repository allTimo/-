#!/usr/bin/env python3
r"""Tests for marketing budgets and calls/conversion (T65): only open sources, honest nulls."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import marketing_budget as mb   # noqa: E402
import platforms                # noqa: E402


class CallsMetricsTestCase(unittest.TestCase):
    def test_01_calls_conversion_visits_are_null_with_reason(self):
        metrics = mb.conversion_metrics()
        for key in ("calls_count", "conversion_rate", "office_visits", "lead_cost"):
            self.assertIsNone(metrics[key]["value"], key)
            self.assertIn("не публикуется", metrics[key]["comment"])
            self.assertEqual(metrics[key]["method"], "none")
            self.assertEqual(metrics[key]["source"], "CRM/коллтрекинг конкурента")

    def test_02_search_ads_is_fact_only(self):
        metric = mb.search_ads_metric()
        self.assertIsNone(metric["value"])
        self.assertEqual(metric["unit"], "факт")
        self.assertIn("ручная проверка", metric["comment"])

    def test_03_promo_intensity_comes_from_our_monitoring(self):
        metric = mb.promo_intensity_metric(3)
        self.assertEqual(metric["value"], 3)
        self.assertEqual(metric["source"], "наш мониторинг промо-страниц")
        self.assertEqual(metric["level"], "по проекту")
        self.assertIsNone(mb.promo_intensity_metric()["value"])


class BudgetMetricsTestCase(unittest.TestCase):
    def test_10_no_expenses_means_null_with_company_level(self):
        scans = [{"url": "https://lsr.ru/ir", "reachable": True, "mentions": [], "numbers": [],
                  "documents": []},
                 {"url": "https://lsr.ru/closed", "reachable": False, "mentions": [], "numbers": [],
                  "documents": []}]
        metrics = mb.budget_metrics("ЛСР", scans)
        spend = metrics["marketing_spend_company"]
        self.assertIsNone(spend["value"])
        self.assertEqual(spend["level"], "по компании/группе (не по ЖК)")
        self.assertIn("ручного просмотра", spend["comment"])
        self.assertEqual(spend["url"], "https://lsr.ru/ir")

    def test_11_document_links_are_reported_not_guessed(self):
        scans = [{"url": "https://lsr.ru/ir", "reachable": True, "mentions": [], "numbers": [],
                  "documents": ["https://lsr.ru/report-2025.pdf"]}]
        metrics = mb.budget_metrics("ЛСР", scans)
        docs = metrics["marketing_spend_documents"]
        self.assertEqual(docs["value"], 1)
        self.assertIn("report-2025.pdf", docs["comment"])
        self.assertIn("ручной просмотр", docs["comment"])

    def test_12_mentions_without_page_are_flagged_for_review(self):
        scans = [{"url": "https://x.ru/ir", "reachable": True,
                  "mentions": ["коммерческие расходы выросли"], "numbers": ["1 234 млн руб"],
                  "documents": []}]
        metrics = mb.budget_metrics("X", scans)
        self.assertIsNone(metrics["marketing_spend_company"]["value"])
        self.assertIn("требует проверки", metrics["marketing_spend_company"]["accuracy"])
        self.assertIn("1 234 млн руб", metrics["marketing_spend_company"]["comment"])


class ScanTestCase(unittest.TestCase):
    def setUp(self):
        self.original = platforms.http_fetch

    def tearDown(self):
        platforms.http_fetch = self.original

    def test_20_unreachable_source_does_not_crash(self):
        platforms.http_fetch = lambda url, **kw: (_ for _ in ()).throw(RuntimeError("нет сети"))
        entry = mb.scan_page("https://x.ru/ir")
        self.assertFalse(entry["reachable"])
        self.assertIn("нет сети", entry["note"])

    def test_21_blocked_and_error_pages_are_not_data(self):
        platforms.http_fetch = lambda url, **kw: (401, "", "HTTP 401")
        self.assertFalse(mb.scan_page("https://x.ru/ir")["reachable"])
        error_html = ('<html><head><title>Ошибка нарушения конфиденциальности</title></head>'
                      '<body><script>var loadTimeDataRaw={}</script></body></html>')
        platforms.http_fetch = lambda url, **kw: (200, error_html, None)
        self.assertFalse(mb.scan_page("https://x.ru/ir")["reachable"])

    def test_22_reachable_page_with_expenses_is_parsed(self):
        html = ('<html><body><h1>Отчётность</h1><p>Коммерческие расходы за 2025 год '
                'составили 12 345 млн руб.</p>'
                '<a href="/reports/ifrs-2025.pdf">Отчёт МСФО</a></body></html>')
        platforms.http_fetch = lambda url, **kw: (200, html, None)
        entry = mb.scan_page("https://x.ru/ir")
        self.assertTrue(entry["reachable"])
        self.assertTrue(entry["mentions"])
        self.assertIn("12 345 млн руб", entry["numbers"])
        self.assertIn("https://x.ru/reports/ifrs-2025.pdf", entry["documents"])

    def test_23_social_scan_reports_unavailable_honestly(self):
        platforms.http_fetch = lambda url, **kw: (403, "", "HTTP 403")
        social = mb.social_scan("ПИК", verify=False)
        self.assertIsNone(social["value"])
        self.assertIn("данных нет", social["comment"])

    def test_24_collect_covers_all_public_developers(self):
        platforms.http_fetch = lambda url, **kw: (403, "", "HTTP 403")
        payload = mb.collect(verify=False)
        for developer in ("ПИК", "ЛСР", "Самолёт", "Эталон"):
            self.assertIn(developer, payload["developers"])
            self.assertIn("conversion", payload["developers"][developer])
        self.assertIn("только из публичной отчётности", payload["rule"])
        self.assertIsNone(payload["developers"]["ПИК"]["conversion"]["calls_count"]["value"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
