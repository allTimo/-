#!/usr/bin/env python3
r"""Tests for the ЕИСЖС/Росреестр block (T61): parsing, matching, honest statuses, cache."""
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
PAGES = TESTS_DIR / "fixtures" / "pages"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import competitor_profile as cp   # noqa: E402
import platforms                  # noqa: E402


class ErrorPageDetectionTestCase(unittest.TestCase):
    def test_01_chrome_error_page_is_not_data(self):
        html = (PAGES / "chrome-cert-error.html").read_text(encoding="utf-8")
        self.assertTrue(platforms.is_chrome_error_page(html))
        self.assertTrue(platforms.is_chrome_error_page(""))
        normal = (PAGES / "cian-project.html").read_text(encoding="utf-8")
        self.assertFalse(platforms.is_chrome_error_page(normal))

    def test_02_disabled_source_sample(self):
        html = (PAGES / "eiszhs-disabled.html").read_text(encoding="utf-8")
        self.assertFalse(platforms.is_chrome_error_page(html))
        lowered = html.lower()
        self.assertTrue(any(marker in lowered for marker in cp.SOURCE_DISABLED_MARKERS))


class ChromeFlagTestCase(unittest.TestCase):
    """Сеть подменяет сертификат: флаг игнорирования включается явно и только по требованию."""

    def test_03_ignore_cert_flag_is_opt_in(self):
        args = platforms.chrome_launch_args(9333, "profile-dir", headless=True,
                                            ignore_cert_errors=True)
        self.assertIn("--ignore-certificate-errors", args)
        self.assertIn("--headless=new", args)
        plain = platforms.chrome_launch_args(9333, "profile-dir", headless=True)
        self.assertNotIn("--ignore-certificate-errors", plain)
        self.assertIn("--user-data-dir=profile-dir", " ".join(plain))


class EiszhsCardTestCase(unittest.TestCase):
    def setUp(self):
        self.html = (PAGES / "eiszhs-project-card.sample.html").read_text(encoding="utf-8")

    def test_10_card_parsing(self):
        card = cp.parse_eiszhs_card(self.html)
        self.assertGreaterEqual(card["blobs_found"], 1)
        self.assertEqual(len(card["corpi"]), 3)
        states = sorted(item["state"] for item in card["corpi"])
        self.assertEqual(states, ["built", "under_construction", "under_construction"])
        self.assertEqual(card["flats_total"], 624)
        self.assertEqual(card["ddu_registered"], 318)
        built = [item for item in card["corpi"] if item["state"] == "built"][0]
        self.assertEqual(built["end_date"], "2024-12-30")
        self.assertEqual(built["readiness"], 100)

    def test_11_matching_exact_partial_ambiguous(self):
        card = {"name": "ЖК Тестовый"}
        matched, status, note = cp.match_eiszhs_project([card], "ЖК «Тестовый»")
        self.assertIsNotNone(matched)
        self.assertEqual(status, "подтверждено")
        # частичное совпадение — просим подтвердить, не угадываем
        matched, status, note = cp.match_eiszhs_project([{"name": "ЖК Тестовый-2"}], "ЖК Тестовый")
        self.assertEqual(status, "требует подтверждения")   # не угадываем: просим подтвердить
        self.assertIsNotNone(matched)
        self.assertIn("подтвердить", note)
        # два одинаковых названия — тоже требует подтверждения
        matched, status, note = cp.match_eiszhs_project([{"name": "ЖК Тестовый"},
                                                         {"name": "ЖК Тестовый"}], "ЖК Тестовый")
        self.assertIsNone(matched)
        self.assertEqual(status, "требует подтверждения")
        self.assertIn("2 карточек", note)
        matched, status, note = cp.match_eiszhs_project([{"name": "Другой"}], "ЖК Тестовый")
        self.assertIsNone(matched)
        self.assertEqual(status, "не найдено")

    def test_12_metrics_and_official_absorption(self):
        card = cp.parse_eiszhs_card(self.html)
        metrics = cp.eiszhs_metrics({"status": "получилось"}, "ЖК Тестовый", card, "подтверждено")
        self.assertEqual(metrics["corpi_total"]["value"], 3)
        self.assertEqual(metrics["corpi_built"]["value"], 1)
        self.assertEqual(metrics["corpi_under_construction"]["value"], 2)
        self.assertEqual(metrics["flats_total"]["value"], 624)
        self.assertEqual(metrics["ddu_registered"]["value"], 318)
        self.assertEqual(metrics["ddu_registered"]["method"], "dom")
        self.assertEqual(metrics["ddu_registered"]["source"], "ЕИСЖС (наш.дом.рф)")
        absorption = cp.official_absorption(metrics)
        self.assertAlmostEqual(absorption["value"], 51.0, places=1)
        self.assertIn("официальные данные", absorption["comment"])

    def test_13_no_cards_means_null_with_reason(self):
        metrics = cp.eiszhs_metrics({"status": "источник отключён",
                                     "detail": "источник сам сообщает, что отключён: наш.дом.рф"},
                                    "ЖК Тестовый", None)
        for key in ("corpi_total", "corpi_built", "corpi_under_construction", "flats_total",
                    "ddu_registered"):
            self.assertIsNone(metrics[key]["value"], key)
            self.assertIn("получить нельзя", metrics[key]["comment"])
        absorption = cp.official_absorption(metrics)
        self.assertIsNone(absorption["value"])
        self.assertIn("нет данных", absorption["comment"])


class SourceStatusTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-source-test-"))
        self.cache = self.tmp / "source-status.json"
        self.original = (platforms.http_fetch, platforms.cdp_html, platforms.launch_chrome,
                         platforms.stop_chrome)

    def tearDown(self):
        (platforms.http_fetch, platforms.cdp_html, platforms.launch_chrome,
         platforms.stop_chrome) = self.original
        shutil.rmtree(self.tmp, ignore_errors=True)

    def patch(self, http_body="", browser_body="", status=200, http_error=None):
        calls = {"http": 0, "browser": 0}

        def fake_http(url, timeout=20, **kwargs):
            calls["http"] += 1
            return status, http_body, http_error

        def fake_cdp(url, **kwargs):
            calls["browser"] += 1
            return browser_body

        platforms.http_fetch = fake_http
        platforms.launch_chrome = lambda **kwargs: (object(), "profile")
        platforms.cdp_html = fake_cdp
        platforms.stop_chrome = lambda process, profile=None: None
        return calls

    def test_20_disabled_source_is_reported_honestly(self):
        html = (PAGES / "eiszhs-disabled.html").read_text(encoding="utf-8")
        self.patch(http_body="", http_error="SSL error", browser_body=html)
        payload, attempts, result = cp.rosreestr_status(allow_browser=True, cache_path=self.cache)
        self.assertEqual(result["status"], "источник отключён")
        self.assertIn("отключ", result["detail"])
        self.assertIsNone(payload)

    def test_21_error_page_is_not_success(self):
        error_html = (PAGES / "chrome-cert-error.html").read_text(encoding="utf-8") + ("x" * 6000)
        self.patch(http_body="", http_error="SSL error", browser_body=error_html)
        payload, attempts, result = cp.rosreestr_status(allow_browser=True, cache_path=self.cache)
        self.assertNotEqual(result["status"], "получилось")
        self.assertIsNone(payload)
        self.assertIn("ошибки сертификата", result["detail"])
        self.assertTrue(all(entry["verdict"] == "error_page" for entry in attempts))

    def test_22_daily_cache_avoids_extra_requests(self):
        html = "<html><body>Главная страница Росреестра</body></html>" + ("y" * 6000)
        calls = self.patch(http_body=html)
        payload, attempts, result = cp.rosreestr_status(allow_browser=True, cache_path=self.cache)
        first_http = calls["http"]
        self.assertGreaterEqual(first_http, 2)
        self.assertFalse(result["from_cache"])
        calls2 = self.patch(http_body=html)
        payload2, attempts2, result2 = cp.rosreestr_status(allow_browser=True, cache_path=self.cache)
        self.assertTrue(result2["from_cache"])
        self.assertEqual(calls2["http"], 0, "второй вызов в сутки не должен ходить в сеть")
        self.assertIn("cache_age_hours", result2)

    def test_23_request_limit_is_respected(self):
        calls = self.patch(http_body="", http_error="SSL error", browser_body="")
        cp.rosreestr_status(allow_browser=True, cache_path=None, use_cache=False, max_requests=1)
        self.assertLessEqual(calls["http"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
