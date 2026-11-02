#!/usr/bin/env python3
r"""Tests for the client pipeline of Agent 1 (T50): configs, no-login collection,
platform parsers, month comparison, registry records and the branded report.

Everything runs offline on saved page samples and temporary directories.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
REGISTRY_DIR = PROJECT_DIR.parent / "registry"
PAGES = TESTS_DIR / "fixtures" / "pages"
CLIENTS_DIR = TESTS_DIR / "fixtures" / "clients"
CURR_FIXTURE = TESTS_DIR / "fixtures" / "week-2026-10-30" / "lots.csv"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                 # noqa: E402
import clients as clients_mod      # noqa: E402
import client_report               # noqa: E402
import collect_clients             # noqa: E402
import diff_snapshots              # noqa: E402
import platforms                   # noqa: E402
import sources_tool                # noqa: E402

USER_HOME = Path(os.environ.get("USERPROFILE") or Path.home())
_ORIGINAL_HTTP_FETCH = platforms.http_fetch
NODE = USER_HOME / ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
JS_YAML = USER_HOME / ".dsh/profiles/desktop/node_modules/js-yaml/index.js"
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")


def run_cli(script, *args):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(SCRIPTS_DIR)
    return subprocess.run([sys.executable, str(SCRIPTS_DIR / script)] + [str(a) for a in args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=env, cwd=str(PROJECT_DIR))


class ClientConfigTestCase(unittest.TestCase):
    def test_01_loads_and_validates_contract(self):
        clients = clients_mod.load_clients(CLIENTS_DIR)
        self.assertEqual(len(clients), 1)
        client = clients[0]
        self.assertEqual(client["client_id"], "client-svet")
        self.assertEqual(client["name"], "ЖК «Свет»")
        self.assertEqual(clients_mod.validate_client(client), [])
        schedule = clients_mod.schedule_of(client)
        self.assertEqual(schedule["weekday"], "monday")
        self.assertEqual(schedule["time"], "10:00")
        self.assertIn("pdf", clients_mod.report_of(client)["formats"])
        self.assertEqual(clients_mod.brand_of(client)["accent"], "#7553ff")

    def test_02_problems_are_reported(self):
        client = {
            "client_id": "bad", "name": "", "schedule": {"weekday": "someday", "time": "25:99"},
            "report": {"formats": ["md", "docx", "zzz"]},
            "sources": [{"id": "cian", "auth": "login", "mode": "cabinet"}, {"id": "avito"}],
            "competitors": [{"developer": "без имени"}],
        }
        problems = clients_mod.validate_client(client)
        text = " | ".join(problems)
        self.assertIn("нет name", text)
        self.assertIn("schedule.weekday", text)
        self.assertIn("schedule.time", text)
        self.assertIn("неизвестный формат zzz", text)
        self.assertIn("авторизация запрещена", text)
        self.assertIn("public-pages", text)
        self.assertIn("competitors: элемент без name", text)

    def test_03_client_overrides_global_toggles(self):
        client = clients_mod.load_clients(CLIENTS_DIR)[0]
        global_sources = [{"id": "cian", "enabled": False}, {"id": "avito", "enabled": True}]
        effective = {item["id"]: item for item in clients_mod.effective_sources(client, global_sources)}
        self.assertTrue(effective["cian"]["enabled"])      # клиент переопределил глобальный выключатель
        self.assertTrue(effective["avito"]["enabled"])
        self.assertEqual(effective["cian"]["auth"], "none")
        permissive = [dict(item, enabled=None) for item in client["sources"] if item.get("id") == "cian"]
        self.assertFalse(clients_mod.effective_sources({"client_id": "x", "sources": permissive},
                                                      global_sources)[0]["enabled"])
        self.assertEqual(run_cli("clients.py", "--clients-dir", CLIENTS_DIR, "check").returncode, 0)


class NoLoginTestCase(unittest.TestCase):
    """Главное требование: площадки читаются БЕЗ логина, куки и токены не применяются."""

    def test_10_request_headers_have_no_cookies_or_tokens(self):
        headers = platforms.request_headers()
        lowered = {key.lower() for key in headers}
        self.assertEqual(lowered & set(platforms.FORBIDDEN_HEADERS), set())
        for forbidden in platforms.FORBIDDEN_HEADERS:
            self.assertNotIn(forbidden, lowered)

    def test_11_http_fetch_sends_only_the_allowlist(self):
        captured = {}

        class FakeResponse:
            status = 200
            headers = type("H", (), {"get_content_charset": staticmethod(lambda: "utf-8")})()

            def read(self, size=None):
                return b"<html></html>"

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        class FakeOpener:
            def urlopen(self, request, timeout=None):
                captured["headers"] = {key.lower(): value for key, value in request.header_items()}
                captured["method"] = request.get_method()
                return FakeResponse()

        status, html, error = platforms.http_fetch("https://example.com/", opener=FakeOpener())
        self.assertEqual(status, 200)
        self.assertEqual(captured["method"], "GET")
        self.assertEqual(set(captured["headers"]) & set(platforms.FORBIDDEN_HEADERS), set())
        self.assertEqual(set(captured["headers"]), {key.lower() for key in platforms.SAFE_HEADERS})

    def test_12_chrome_uses_a_fresh_profile(self):
        args = platforms.chrome_launch_args(9333, Path(r"C:\Temp\cw-cdp-profile-test"))
        joined = " ".join(str(item) for item in args)
        self.assertIn("--remote-debugging-port=9333", joined)
        self.assertIn("--user-data-dir=C:\\Temp\\cw-cdp-profile-test", joined)
        self.assertNotIn("--profile-directory", joined)          # чужой профиль не подключаем
        self.assertNotIn("--headless", joined)
        self.assertTrue(platforms.chrome_launch_args(9333, "P", headless=True)[1] == "--headless=new")

    def test_13_lots_are_not_attributed_to_a_foreign_page(self):
        html = (PAGES / "yandex-project.html").read_text(encoding="utf-8")
        self.assertTrue(platforms.mentions_name(html, "Сити Бэй"))
        self.assertTrue(platforms.mentions_name(html, "сити бэй"))
        self.assertFalse(platforms.mentions_name(html, "ЗИЛАРТ"))
        self.assertFalse(platforms.mentions_name("", "ЗИЛАРТ") is True)

    def test_14_catalog_page_gets_a_caveat(self):
        self.assertTrue(platforms.is_project_page("https://realty.yandex.ru/zhk-zilart/"))
        self.assertFalse(platforms.is_project_page("https://realty.yandex.ru/moskva/kupit/kvartira/"))
        self.assertIn("каталожная", platforms.catalog_caveat("https://realty.yandex.ru/moskva/kupit/kvartira/"))


class PlatformParserTestCase(unittest.TestCase):
    def parse(self, name, platform):
        return platforms.parse_page((PAGES / name).read_text(encoding="utf-8"), platform)


    def test_15_captcha_word_in_scripts_is_not_a_block(self):
        """У Циан слово captcha есть в служебных скриптах — это не блокировка."""
        html = ('<html><head><title>ЖК СВЕТ</title><script>var captchaWidget = "smart-captcha";</script>'
                '</head><body><div data-testid="offer-card">12 500 000 ₽ 2-комн. 56 м² 8/24 эт.</div>'
                '</body></html>')
        self.assertEqual(platforms.detect_block(200, html, "cian")[0], "ok")
        parsed = platforms.parse_page(html, "cian")
        self.assertEqual(len(parsed["lots"]), 1)
        captcha_page = (PAGES / "captcha.html").read_text(encoding="utf-8")
        self.assertEqual(platforms.detect_block(200, captcha_page, "cian")[0], "needs_browser")

    def test_16_cian_never_uses_the_browser_by_default(self):
        """Для Циан транспорт http-only: браузер не поднимаем даже при блокировке."""
        self.assertEqual(platforms.PLATFORM_TRANSPORT["cian"], "http-only")
        self.assertEqual(platforms.PLATFORM_TRANSPORT["avito"], "http-then-browser")
        self.assertIn(439, platforms.BLOCK_STATUSES)
        calls = {"browser": 0}
        original = platforms.launch_chrome

        def fake_launch(*args, **kwargs):
            calls["browser"] += 1
            raise AssertionError("браузер не должен запускаться для cian")

        def fake_fetch(url, timeout=25, max_bytes=3000000, opener=None):
            return 403, "<html>Доступ ограничен</html>", "HTTP 403"

        platforms.launch_chrome = fake_launch
        platforms.http_fetch = fake_fetch
        try:
            result = platforms.collect_platform("https://www.cian.ru/zhk-x/", "cian", allow_browser=True)
        finally:
            platforms.launch_chrome = original
            platforms.http_fetch = _ORIGINAL_HTTP_FETCH
        self.assertEqual(calls["browser"], 0)
        self.assertIn(result["status"], ("needs_browser", "needs_partnership"))
        self.assertEqual(result["method"], "none")
        self.assertIn("браузерный режим не используется", result["note"])

    def test_20_cian_cards(self):
        parsed = self.parse("cian-project.html", "cian")
        lots = parsed["lots"]
        self.assertEqual(len(lots), 2)
        self.assertEqual(lots[0]["price_rub"], 12500000)
        self.assertEqual(lots[0]["area_m2"], 56.0)
        self.assertEqual(lots[0]["rooms"], 2)
        self.assertEqual(lots[0]["floor"], 8)
        self.assertEqual(lots[0]["floors_total"], 24)
        self.assertEqual(lots[0]["delivery"], "2027")
        self.assertIn("Скидка", lots[0]["promo_text"])
        self.assertEqual(lots[1]["rooms"], 0)               # студия
        self.assertEqual(lots[1]["price_rub"], 8040000)

    def test_21_avito_cards(self):
        lots = self.parse("avito-project.html", "avito")["lots"]
        self.assertEqual(len(lots), 2)
        self.assertEqual(lots[0]["price_rub"], 18650000)
        self.assertEqual(lots[0]["rooms"], 3)
        self.assertEqual(lots[0]["area_m2"], 78.0)
        self.assertIn("Ипотека", lots[0]["promo_text"])

    def test_22_yandex_millions_and_domclick(self):
        yandex = self.parse("yandex-project.html", "yandex_realty")["lots"]
        self.assertEqual(yandex[0]["price_rub"], 23180000)   # 23,18 млн ₽
        self.assertEqual(yandex[0]["rooms"], 2)
        domclick = self.parse("domclick-project.html", "domclick")["lots"]
        self.assertEqual([lot["rooms"] for lot in domclick], [2, 4])
        self.assertEqual(domclick[1]["area_m2"], 92.0)

    def test_23_price_without_cards_is_not_a_lot(self):
        parsed = self.parse("price-from-only.html", "cian")
        self.assertEqual(parsed["lots"], [])
        self.assertEqual(parsed["granularity"], "price-from")
        self.assertEqual(parsed["price_from_rub"], 12500000)

    def test_24_json_ld_needs_area_to_be_a_lot(self):
        # цена без площади — агрегат страницы, а не лот
        parsed = self.parse("jsonld.html", "domclick")
        self.assertEqual(parsed["lots"], [])
        self.assertEqual(parsed["granularity"], "price-from")
        self.assertEqual(parsed["price_from_rub"], 12500000)
        # цена и площадь в имени лота — можно считать лотом
        with_area = self.parse("jsonld-lots.html", "domclick")
        self.assertEqual(len(with_area["lots"]), 2)
        self.assertEqual(with_area["granularity"], "json-ld")
        self.assertEqual(with_area["lots"][0]["area_m2"], 56.0)
        self.assertEqual(with_area["lots"][1]["rooms"], 0)

    def test_24b_cian_project_summary_from_saved_page(self):
        """Сводка по странице ЖК: лоты, медиана ₽/м² и адрес — обычным HTTP."""
        html = ('<html><body><script>var st = {"address":"Москва, Ильменский проезд"};</script>'
                '<div data-testid="offer-card">10 000 000 ₽ 2-комн. 50 м² 8/24 эт.</div>'
                '<div data-testid="offer-card">20 000 000 ₽ 2-комн. 50 м² 9/24 эт.</div>'
                '</body></html>')
        original = platforms.http_fetch
        platforms.http_fetch = lambda url, timeout=25, max_bytes=3000000, opener=None: (200, html, None)
        try:
            summary = platforms.cian_project_summary("https://www.cian.ru/zhk-test/")
        finally:
            platforms.http_fetch = original
        self.assertEqual(summary["status"], "ok")
        self.assertEqual(summary["lots"], 2)
        self.assertEqual(summary["complete"], 2)
        self.assertEqual(summary["price_per_m2"], 300000)      # медиана 200000 и 400000
        self.assertEqual(summary["min_price"], 10000000)
        self.assertEqual(summary["address"], "Москва, Ильменский проезд")
        self.assertEqual(summary["method"], "http")

    def test_24c_cian_project_summary_reports_foreign_page(self):
        original = platforms.http_fetch
        platforms.http_fetch = lambda url, timeout=25, max_bytes=3000000, opener=None: (
            200, '<html><div data-testid="offer-card">10 000 000 ₽ 2-комн. 50 м²</div></html>', None)
        try:
            summary = platforms.cian_project_summary("https://www.cian.ru/zhk-other/", expect_name="Другой ЖК")
        finally:
            platforms.http_fetch = original
        self.assertEqual(summary["status"], "mismatch")
        self.assertIsNone(summary["price_per_m2"])

    def test_25_block_detection(self):
        captcha = (PAGES / "captcha.html").read_text(encoding="utf-8")
        self.assertEqual(platforms.detect_block(200, captcha, "cian")[0], "needs_browser")
        self.assertEqual(platforms.detect_block(429, "", "avito")[0], "needs_browser")
        self.assertEqual(platforms.detect_block(401, "", "domclick")[0], "needs_partnership")
        self.assertEqual(platforms.detect_block(403, "", "cian")[0], "needs_partnership")
        self.assertEqual(platforms.detect_block(403, "", "avito")[0], "needs_browser")
        self.assertEqual(platforms.detect_block(200, "", "cian")[0], "needs_browser")
        self.assertEqual(platforms.detect_block(200, "<html>ok</html>", "cian")[0], "ok")

    def test_26_price_and_area_formats(self):
        self.assertEqual(platforms.parse_price("от 12 500 000 ₽"), 12500000)
        self.assertEqual(platforms.parse_price("23,18 млн ₽"), 23180000)
        self.assertEqual(platforms.parse_price("нет цены"), None)
        self.assertEqual(platforms.parse_area_m2("56,5 м²"), 56.5)
        self.assertEqual(platforms.parse_rooms("Студия"), 0)
        self.assertEqual(platforms.parse_rooms("4-комнатная"), 4)
        self.assertEqual(platforms.parse_floor("15/24 эт."), (15, 24))
        self.assertIsNone(platforms.parse_number("123"))


class SnapshotAndMonthTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-clients-test-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def row(self, **overrides):
        base = dict(snapshot_date="2026-11-01", source="cian", competitor="C", project="P", lot_id="L1",
                    url="", rooms=2, area_m2=50.0, floor=8, floors_total=24, building="",
                    price_rub=12500000, price_per_m2_rub=250000, finish="unknown", promo_flag=0,
                    promo_text="", delivery="2027-Q2", status="active")
        base.update(overrides)
        return base

    def test_30_incomplete_lots_do_not_enter_the_snapshot(self):
        full = {"price_rub": 1000000, "area_m2": 50.0, "rooms": 2}
        self.assertIsNotNone(collect_clients.lot_to_row(full, "cian", "C", "P", "2026-11-01", 0))
        self.assertIsNone(collect_clients.lot_to_row(dict(full, rooms=None), "cian", "C", "P", "2026-11-01", 0))
        self.assertIsNone(collect_clients.lot_to_row(dict(full, area_m2=None), "cian", "C", "P", "2026-11-01", 0))
        self.assertIsNone(collect_clients.lot_to_row(dict(full, price_rub=None), "cian", "C", "P", "2026-11-01", 0))
        row = collect_clients.lot_to_row(full, "yandex-realty", "C", "P", "2026-11-01", 0)
        self.assertEqual(row["source"], "yandex_realty")     # колонка контракта, не id источника
        self.assertEqual(row["price_per_m2_rub"], 20000)

    def test_31_month_comparison(self):
        data_dir = self.tmp / "data"
        client_id = "client-month"
        old = self.tmp / "old.csv"
        new = self.tmp / "new.csv"
        cw.write_csv(old, [self.row(lot_id="L1", price_rub=10000000, price_per_m2_rub=200000),
                           self.row(lot_id="L2", price_rub=12000000, price_per_m2_rub=240000)])
        cw.write_csv(new, [self.row(lot_id="L1", price_rub=11000000, price_per_m2_rub=220000,
                                    snapshot_date="2026-11-01"),
                           self.row(lot_id="L3", price_rub=9000000, price_per_m2_rub=180000)])
        for date, source in (("2026-09-25", old), ("2026-11-01", new)):
            target = collect_clients.snapshot_dir(client_id, date, data_dir)
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target / "lots.csv")
        self.assertEqual(collect_clients.month_date(client_id, "2026-11-01", data_dir), "2026-09-25")
        self.assertEqual(collect_clients.previous_date(client_id, "2026-11-01", data_dir), "2026-09-25")
        old_rows, _ = collect_clients.load_snapshot(client_id, "2026-09-25", data_dir)
        new_rows, _ = collect_clients.load_snapshot(client_id, "2026-11-01", data_dir)
        dynamics = collect_clients.source_dynamics(old_rows, new_rows)
        self.assertEqual(dynamics[0]["source"], "cian")
        self.assertEqual((dynamics[0]["prev"], dynamics[0]["curr"]), (2, 2))
        payload = diff_snapshots.compute_diff(old_rows, new_rows, 0.5, "2026-09-25", "2026-11-01")
        summary = {"has_baseline": True, "prev_date": "2026-09-25", "totals": payload["totals"],
                   "price_changes": payload["price_changes"], "promo_new": payload["promo_new"],
                   "by_source": dynamics}
        text = "\n".join(client_report.month_block(summary))
        self.assertIn("Что изменилось за месяц", text)
        self.assertIn("2026-09-25", text)
        self.assertIn("| Лотов в продаже |", text)
        self.assertIn("| Новых лотов | — | 1 |", text)
        empty = "\n".join(client_report.month_block({"has_baseline": False}))
        self.assertIn("сравнивать не с чем", empty)


class RegistryRecordsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-registry-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_40_run_and_result_records(self):
        runs = self.tmp / "runs.jsonl"
        collect_clients.append_run({"run_id": "run-1", "ts": "2026-11-01T10:00:00.000+03:00",
                                    "service": "competitor-watch", "client": "client-svet",
                                    "agent": "agent-1-competitor-watch", "status": "ok",
                                    "duration_ms": 1000, "cost_rub": 0.9, "artifact": "a.pdf",
                                    "error": None}, runs)
        collect_clients.append_run({"run_id": "run-2", "status": "ok"}, runs)
        lines = [json.loads(line) for line in runs.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual([item["run_id"] for item in lines], ["run-1", "run-2"])
        self.assertEqual(lines[0]["cost_rub"], 0.9)

        results = self.tmp / "results.yaml"
        results.write_text("version: 1\n\nresults:\n  - id: res-old\n    title: \"Старый\"\n",
                           encoding="utf-8")
        collect_clients.append_result({"id": "res-new", "title": "Отчёт: ЖК «Свет»",
                                       "summary": "собрано 15 лотов", "client": "client-svet",
                                       "project": None, "period": "нет — 2026-11-01",
                                       "agent": "agent-1-competitor-watch", "service": "competitor-watch",
                                       "created": "2026-11-01T10:00:00+03:00",
                                       "artifacts": ["01-competitor-watch/reports/clients/client-svet/a.pdf"],
                                       "sent_channel": "telegram", "sent_to": "@x", "sent_at": None,
                                       "sent_status": "ожидает"}, results)
        text = results.read_text(encoding="utf-8")
        self.assertIn("res-old", text)
        self.assertIn("res-new", text)
        self.assertIn("@x", text)
        parsed = cw.parse_simple_yaml(results)
        self.assertEqual(len(parsed["results"]), 2)
        self.assertEqual(parsed["results"][1]["id"], "res-new")
        self.assertEqual(parsed["results"][1]["sent_status"], "ожидает")
        if NODE.exists() and JS_YAML.exists():
            code = ("const y=require(process.argv[1]),fs=require('fs');"
                    "const d=y.load(fs.readFileSync(process.argv[2],'utf8'));"
                    "console.log(d.results.length, d.results[1].id)")
            check = subprocess.run([str(NODE), "-e", code, str(JS_YAML), str(results)],
                                   capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(check.returncode, 0, check.stderr)
            self.assertIn("2 res-new", check.stdout)
        self.assertEqual(len(list(self.tmp.glob("results.yaml.bak-*"))), 1)

    def test_41_cost_estimate_uses_model_prices(self):
        cost, tokens = collect_clients.estimate_cost("deepseek/deepseek-v4.1-flash", 400000, 40000)
        self.assertGreater(cost, 0)
        self.assertEqual(tokens, 110000)
        self.assertEqual(collect_clients.estimate_cost("no/such-model", 400000, 40000)[0], 0.0)


class BrandedReportTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-brand-test-"))
        cls.client = clients_mod.load_clients(CLIENTS_DIR)[0]
        logo = cls.tmp / "logo.png"
        logo.write_bytes(PNG_1PX)
        cls.client["brand"] = {"logo": str(logo), "accent": "#7553ff"}
        cls.client["__file"] = str(cls.tmp / "client.yaml")
        rows = lambda **kw: dict(snapshot_date="2026-11-01", source="site", competitor="ЛСР",
                                 project="ЗИЛАРТ", lot_id="L1", url="", rooms=2, area_m2=50.0,
                                 floor=8, floors_total=24, building="", price_rub=12000000,
                                 price_per_m2_rub=240000, finish="unknown", promo_flag=0,
                                 promo_text="", delivery="2027-Q2", status="active", **kw)
        cls.curr = cw.write_csv(cls.tmp / "curr.csv", [rows()])
        cls.curr_rows = cw.load_snapshot_rows(cls.curr)
        cls.payload = diff_snapshots.compute_diff(None, cls.curr_rows, 0.5, None, "2026-11-01")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_50_markdown_has_client_brand(self):
        report = client_report.build_client_report(
            self.client, self.payload, self.curr_rows,
            [{"source": "developer-sites", "name": "Сайты застройщиков", "status": "ok", "lots": 1,
              "projects": 1, "note": "HTTP без логина"},
             {"source": "cian", "name": "Циан", "status": "needs_browser", "lots": 0, "projects": 0,
              "note": "капча"}],
            {"has_baseline": False}, self.tmp / "out", "2026-11-01")
        text = (self.tmp / "out" / "2026-11-01-competitor-watch.md").read_text(encoding="utf-8")
        self.assertIn("ЖК «Свет»", text)
        self.assertIn("#7553ff", text)
        self.assertIn("![логотип]", text)
        self.assertIn("нужен браузер", text)
        self.assertIn("## 9. Ограничения и что не удалось собрать", text)
        self.assertIn("сравнивать не с чем", text)
        self.assertTrue(report["files"]["xlsx"].exists())

    def test_51_docx_and_pdf_are_built(self):
        if not client_report.LO_KIT_CLI.exists():
            self.skipTest("LibreOffice Kit недоступен")
        report = client_report.build_client_report(
            self.client, self.payload, self.curr_rows, [], {"has_baseline": False},
            self.tmp / "out2", "2026-11-01")
        docx = report["files"].get("docx")
        pdf = report["files"].get("pdf")
        self.assertTrue(docx and docx.exists())
        self.assertTrue(pdf and pdf.exists(), report["problems"])
        with open(pdf, "rb") as handle:
            self.assertEqual(handle.read(5), b"%PDF-")
        self.assertGreater(pdf.stat().st_size, 5000)


class CollectionFlowTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-flow-test-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_60_dry_run_reports_every_source(self):
        proc = run_cli("collect_clients.py", "--client", "client-svet", "--clients-dir", CLIENTS_DIR,
                       "--date", "2026-11-01", "--dry-run", "--data-dir", self.tmp / "data",
                       "--reports-dir", self.tmp / "reports", "--registry-dir", self.tmp / "registry")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        for source in ("developer-sites", "cian", "avito", "yandex-realty", "domclick", "manual-inbox"):
            self.assertIn(source, proc.stdout)
        self.assertIn("не выполнялся", proc.stdout)
        md = (self.tmp / "reports" / "client-svet" / "2026-11-01-competitor-watch.md")
        self.assertTrue(md.exists())
        self.assertFalse((self.tmp / "registry" / "runs.jsonl").exists(), "dry-run не пишет реестр")

    def test_61_clients_cli_lists_and_checks(self):
        listed = run_cli("clients.py", "--clients-dir", CLIENTS_DIR, "list")
        self.assertEqual(listed.returncode, 0, listed.stdout)
        self.assertIn("client-svet", listed.stdout)
        self.assertIn("понедельник 10:00", listed.stdout)
        bad_dir = self.tmp / "bad-clients"
        bad_dir.mkdir(parents=True, exist_ok=True)
        (bad_dir / "bad.yaml").write_text("client_id: bad\nname: \"\"\n", encoding="utf-8")
        checked = run_cli("clients.py", "--clients-dir", bad_dir, "check")
        self.assertEqual(checked.returncode, 1)
        self.assertIn("ПРОБЛЕМЫ", checked.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
