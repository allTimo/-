#!/usr/bin/env python3
r"""Тесты источников веб-поиска (задача E): Serper и Chrome CDP на заглушках.

Сеть и браузер подменяются: ``post`` для Serper и ``cdp_html`` для Chrome — те же
точки подмены, что у движка. Проверяются честные отказы: без ключа, без браузера,
при HTTP-ошибке — наружу пустой список и понятная причина, без исключений.
"""
from __future__ import annotations

import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
PAGES = TESTS_DIR / "fixtures" / "pages"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import web_search as ws  # noqa: E402

SERP = PAGES / "serp-svet.html"
SERPER_PAYLOAD = {
    "organic": [
        {"title": "ЖК «Селигер Сити» — официальный сайт MR Group",
         "link": "https://www.mr-group.ru/projects/zhk-seliger-siti", "snippet": "Москва"},
        {"title": "Селигер Сити — Циан", "link": "https://www.cian.ru/zhk/", "snippet": "цены"},
    ]
}
QUERY = "ЖК Селигер Сити официальный сайт"


def fake_reader(html):
    """Заглушка чтения страницы браузером: возвращает заданный HTML."""
    def reader(url, port=None, wait_ms=None):
        reader.seen = url
        return html
    reader.seen = None
    return reader


class WebSearchTestCase(unittest.TestCase):
    def test_01_serper_without_key_is_honest(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            entries, note = ws.serper_search(QUERY, api_key="")
        self.assertEqual(entries, [])
        self.assertIn("нет ключа", note)

    def test_02_serper_parses_response_and_drops_aggregators(self):
        def fake_post(url, payload, headers, timeout):
            self.assertEqual(url, ws.SERPER_ENDPOINT)
            self.assertEqual(headers.get("X-API-KEY"), "test-key")
            self.assertEqual(payload.get("q"), QUERY)
            return json.dumps(SERPER_PAYLOAD, ensure_ascii=False)

        entries, note = ws.serper_search(QUERY, api_key="test-key", post=fake_post)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["host"], "mr-group.ru")
        self.assertIn("Serper", note)

    def test_03_serper_http_error_is_reported_not_raised(self):
        def fake_post(url, payload, headers, timeout):
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)

        entries, note = ws.serper_search(QUERY, api_key="test-key", post=fake_post)
        self.assertEqual(entries, [])
        self.assertIn("HTTP 403", note)

    def test_04_cdp_reads_a_saved_serp(self):
        reader = fake_reader(SERP.read_text(encoding="utf-8"))
        entries, note = ws.cdp_search(QUERY, cdp_html=reader)
        self.assertEqual(len(entries), 3)
        self.assertIn("CDP", note)
        self.assertIn("yandex.ru/search", reader.seen or "")

    def test_05_cdp_without_page_is_honest(self):
        entries, note = ws.cdp_search(QUERY, cdp_html=fake_reader(""))
        self.assertEqual(entries, [])
        self.assertIn("не отдал страницу", note)

    def test_05b_captcha_page_is_not_a_result(self):
        """Живой случай 04.11.2026: Яндекс отдал капчу, и её ссылки нельзя считать выдачей."""
        captcha = ('<html><body>Подтвердите, что вы не робот'
                   '<a href="https://ya.ru/">Яндекс</a>'
                   '<a href="https://yandex.cloud/ru/smartcaptcha">SmartCaptcha</a></body></html>')
        entries, note = ws.cdp_search(QUERY, cdp_html=fake_reader(captcha))
        self.assertEqual(entries, [])
        self.assertIn("капчу", note)

    def test_06_auto_prefers_serper_when_key_exists(self):
        reader = fake_reader("")
        entries, note = ws.search(
            QUERY, backend="auto", api_key="test-key",
            post=lambda *args: json.dumps(SERPER_PAYLOAD, ensure_ascii=False),
            cdp_html=reader,
        )
        self.assertIn("Serper", note)
        self.assertIsNone(reader.seen, "Chrome не должен подниматься, когда есть ключ")

    def test_07_auto_without_key_goes_to_ddg(self):
        """Без ключа Serper «auto» идёт в DuckDuckGo (без браузера), а не в Chrome."""
        ddg_html = ('<a class="result__a" '
                    'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.mr-group.ru%2Fprojects%2Fzhk-seliger-siti">'
                    'ЖК «Селигер Сити» — официальный сайт MR Group</a>')
        reader = fake_reader("")
        with mock.patch.dict("os.environ", {}, clear=True):
            entries, note = ws.search(QUERY, backend="auto", api_key="", cdp_html=reader,
                                      get=lambda url, timeout: ddg_html)
        self.assertIn("DuckDuckGo", note)
        self.assertTrue(entries)
        self.assertEqual(entries[0]["host"], "mr-group.ru")
        self.assertIsNone(reader.seen, "Chrome не должен подниматься")

    def test_08_empty_query_returns_nothing(self):
        entries, note = ws.search("   ", backend="auto", api_key="test-key")
        self.assertEqual(entries, [])
        self.assertIn("пустой", note)

    def test_09_unknown_backend_is_honest(self):
        entries, note = ws.search(QUERY, backend="нет_такого")
        self.assertEqual(entries, [])
        self.assertIn("неизвестный бэкенд", note)


    def test_10_ddg_parses_real_results(self):
        """DuckDuckGo HTML: настоящий адрес лежит в параметре uddg."""
        html = ('<h2 class="result__title"><a rel="nofollow" class="result__a" '
                'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.pik.ru%2Fnarvin&amp;rut=abc">'
                'Проект Нарвин ПИК Серия плюс</a></h2>'
                '<div class="result"><a class="result__a" href="https://www.cian.ru/narvin/">'
                'Нарвин на Циан</a></div>')
        entries, note = ws.ddg_search(QUERY, get=lambda url, timeout: html)
        self.assertEqual(len(entries), 1, "агрегатор Циан отсеивается")
        self.assertEqual(entries[0]["url"], "https://www.pik.ru/narvin")
        self.assertEqual(entries[0]["host"], "pik.ru")
        self.assertIn("DuckDuckGo", note)

    def test_11_ddg_captcha_is_honest(self):
        entries, note = ws.ddg_search(QUERY, get=lambda url, timeout: "<html>Подтвердите, что вы не робот</html>")
        self.assertEqual(entries, [])
        self.assertIn("проверки", note)

    def test_12_auto_without_key_uses_ddg_not_chrome(self):
        reader = fake_reader("")
        entries, note = ws.search(QUERY, backend="auto", api_key="", cdp_html=reader,
                                  get=lambda url, timeout: "<html>нет ссылок</html>")
        self.assertIn("DuckDuckGo", note)
        self.assertIsNone(reader.seen, "Chrome не нужен, когда есть выдача без браузера")


    def test_11b_ddg_block_page_is_named_as_block(self):
        """Живой случай 04.11.2026: строка «anomaly» без результатов — это блокировка."""
        blocked_page = "<html><body>anomaly detected, please try later</body></html>"
        entries, note = ws.ddg_search(QUERY, get=lambda url, timeout: blocked_page)
        self.assertEqual(entries, [])
        self.assertIn("заблокировал", note)

    def test_11c_word_anomaly_on_a_normal_page_does_not_break_parsing(self):
        page = ('<a class="result__a" href="https://www.pik.ru/narvin">Проект Нарвин ПИК</a>'
                '<div>anomaly в тексте сниппета</div>')
        entries, note = ws.ddg_search(QUERY, get=lambda url, timeout: page)
        self.assertEqual(len(entries), 1, "наличие слова не должно ломать разбор при REFERENCES")


if __name__ == "__main__":
    unittest.main()
