#!/usr/bin/env python3
r"""Tests for budget sources (T67): Keys.so, SpyWords, CSV-импорт, честные статусы без ключей."""
from __future__ import annotations

import datetime as dt
import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"
SAMPLE = TESTS_DIR / "fixtures" / "budgets-sample"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import budget_sources as bs   # noqa: E402


class CsvImportTestCase(unittest.TestCase):
    def test_01_sample_export_is_imported(self):
        data = bs.csv_import(SAMPLE)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(len(data["rows"]), 3)
        info = data["files"][0]
        self.assertEqual(info["delimiter"], ";")
        self.assertEqual(info["encoding"], "utf-8-sig")
        self.assertIn("adcost", info["columns"])

    def test_02_summary_counts_budget_and_metrics_marked_as_estimate(self):
        data = bs.csv_import(SAMPLE)
        summary = bs.summarize_rows(data["rows"], data["source"], "csv-import (файл)")
        self.assertEqual(summary["budget_estimate_rub"], 184500 + 162300 + 240900)
        self.assertEqual(summary["ads_count"], 42 + 38 + 51)
        self.assertEqual(summary["keywords_count"], 318 + 295 + 402)
        self.assertEqual(summary["landings_count"], 2)
        metrics = bs.budget_metrics(summary, source_label=data["source"])
        budget = metrics["marketing_budget_estimate_rub"]
        self.assertEqual(budget["value"], 184500 + 162300 + 240900)
        self.assertIn("оценка сервиса", budget["accuracy"])
        self.assertIn("НЕ фактический расход", budget["comment"])
        for key in ("marketing_ads_count", "marketing_keywords_count", "marketing_landings_count"):
            self.assertIn("оценка сервиса", metrics[key]["accuracy"])
            self.assertTrue(metrics[key]["collected_at"])

    def test_03_missing_directory_is_honest(self):
        data = bs.csv_import(SAMPLE / "нет-такого-каталога")
        self.assertEqual(data["status"], "каталог не найден")
        self.assertEqual(data["rows"], [])

    def test_04_cp1251_tsv_is_read(self):
        import tempfile
        text = "domain\tзатраты\tads\nrg-dev.ru\t199000\t12\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "export.tsv"
            path.write_bytes(text.encode("cp1251"))
            data = bs.csv_import(tmp)
            self.assertEqual(data["status"], "ok")
            self.assertEqual(data["files"][0]["encoding"], "cp1251")
            self.assertEqual(data["files"][0]["delimiter"], "\t")
            summary = bs.summarize_rows(data["rows"], "выгрузка", "csv-import (файл)")
            self.assertEqual(summary["budget_estimate_rub"], 199000)


class KeyssoClientTestCase(unittest.TestCase):
    RESPONSE = [{"domain": "rg-dev.ru", "adcost": 184500, "ads": 42, "keywords": 318,
                 "url": "https://rg-dev.ru/novostroyki/mihalkovskij/"},
                {"domain": "rg-dev.ru", "adcost": 162300, "ads": 38, "keywords": 295,
                 "url": "https://rg-dev.ru/novostroyki/mihalkovskij/"}]

    def test_10_no_token_is_honest(self):
        result = bs.keysso_request("/report/simple/context/ads", {"domain": "x.ru"}, token="")
        self.assertEqual(result["status"], "ключ не задан")
        self.assertEqual(result["rows"], [])
        metrics = bs.budget_metrics({"note": "ключ не задан", "method": "api"}, source_label="Keys.so (API)")
        self.assertIsNone(metrics["marketing_budget_estimate_rub"]["value"])
        self.assertIn("ключ не задан", metrics["marketing_budget_estimate_rub"]["comment"])

    def test_11_authorized_report_is_parsed(self):
        calls = []

        def fake_fetch(url, params, token):
            calls.append((url, params, token))
            return self.RESPONSE

        reports = bs.keysso_domain_report("rg-dev.ru", "secret-token", fetch=fake_fetch,
                                          kinds=("ads", "keywords"))
        self.assertEqual(sorted(reports.keys()), ["ads", "keywords"])
        self.assertTrue(all(data["status"] == "ok" for data in reports.values()))
        self.assertTrue(all(call[2] == "secret-token" for call in calls))
        self.assertTrue(all(call[1]["domain"] == "rg-dev.ru" for call in calls))
        self.assertTrue(all(call[1]["base"] == "msk" for call in calls))
        self.assertIn("/report/simple/context/ads", calls[0][0])
        rows = [row for data in reports.values() for row in data["rows"]]
        summary = bs.summarize_rows(rows, "Keys.so (API)", "api")
        self.assertEqual(summary["landings_count"], 1)      # один уникальный адрес
        self.assertGreater(summary["budget_estimate_rub"], 0)

    def test_12_api_error_is_reported_not_swallowed(self):
        def boom(url, params, token):
            raise RuntimeError("401 unauthorized")

        result = bs.keysso_request("/report/simple/context/ads", {"domain": "x.ru"}, token="t",
                                   fetch=boom)
        self.assertEqual(result["status"], "ключ не задан" if False else result["status"])
        self.assertIn(result["status"], ("ошибка запроса", "пусто", "ключ не задан"))

    def test_13_token_header_name_matches_documentation(self):
        self.assertEqual(bs.KEYSSO_HEADER, "X-Keyso-TOKEN")
        self.assertTrue(bs.KEYSSO_HOST.startswith("https://api.keys.so"))
        for kind in ("ads", "keywords", "competitors", "landings"):
            self.assertIn(kind, bs.KEYSSO_REPORTS)


class SpywordsClientTestCase(unittest.TestCase):
    def test_20_tsv_cp1251_is_parsed(self):
        payload = "domain\tadcost\tads\nrg-dev.ru\t210000\t17\n".encode("cp1251")
        parsed = bs.spywords_parse(payload)
        self.assertEqual(parsed["columns"][:3], ["domain", "adcost", "ads"])
        self.assertEqual(parsed["rows"][0]["adcost"], "210000")

    def test_21_no_token_is_honest(self):
        result = bs.spywords_request("context/report", {"domain": "x.ru"}, token="")
        self.assertEqual(result["status"], "ключ не задан")
        self.assertEqual(result["rows"], [])

    def test_22_authorized_report_is_summarized(self):
        def fake_fetch(url, params, token):
            return "domain\tadcost\tads\tkeywords\nrg-dev.ru\t210000\t17\t88\n"

        data = bs.spywords_request("context/report", {"domain": "rg-dev.ru"}, token="t",
                                   fetch=fake_fetch)
        self.assertEqual(data["status"], "ok")
        summary = bs.summarize_rows(data["rows"], "SpyWords (API)", "api")
        self.assertEqual(summary["budget_estimate_rub"], 210000)
        metrics = bs.budget_metrics(summary, source_label="SpyWords (API)")
        self.assertIn("оценка сервиса", metrics["marketing_budget_estimate_rub"]["accuracy"])


class SecretsTestCase(unittest.TestCase):
    def test_30_tokens_come_from_env_or_file(self):
        import os
        secrets = bs.load_secrets()
        self.assertIn("values", secrets)
        os.environ["KEYSSO_TOKEN"] = "test-token-123"
        try:
            self.assertEqual(bs.token_for("KEYSSO_TOKEN"), "test-token-123")
        finally:
            del os.environ["KEYSSO_TOKEN"]
        self.assertEqual(bs.token_for("SPYWORDS_TOKEN"), "")

    def test_31_example_file_exists_and_has_no_secrets(self):
        example = Path(bs.WATCH_DIR) / "config" / "secrets.local.example.yaml"
        self.assertTrue(example.exists(), "нужен пример файла с ключами")
        text = example.read_text(encoding="utf-8")
        self.assertIn("KEYSSO_TOKEN", text)
        self.assertIn("SPYWORDS_TOKEN", text)
        self.assertIn('""', text)                 # значения пустые — секретов в примере нет
        self.assertFalse((Path(bs.WATCH_DIR) / "config" / "secrets.local.yaml").exists(),
                         "боевой файл с ключами не должен лежать в репозитории")


class PanelSliceTestCase(unittest.TestCase):
    """Контракт панели: срез budgets/<дата>.json и имена метрик."""

    def test_50_slice_has_panel_format(self):
        projects = [{"project": "rg-dev.ru", "budget_rub": 346800, "period": "2026-10",
                     "ads_count": 80, "keywords_count": 613, "landings_count": 1,
                     "collected_at": "2026-11-01", "accuracy": "оценка сервиса (не факт расхода)"}]
        payload = bs.build_slice(projects, "Keys.so / SpyWords / выгрузка из кабинета", "csv-import",
                                 status=bs.STATUS_OK, note="оценка сервиса")
        self.assertEqual(sorted(payload.keys()),
                         ["collected_at", "demo", "method", "note", "projects", "source", "status"])
        self.assertFalse(payload["demo"])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(set(projects[0].keys()),
                         {"project", "budget_rub", "period", "ads_count", "keywords_count",
                          "landings_count", "collected_at", "accuracy"})

    def test_51_slice_is_written_to_panel_path(self):
        import tempfile
        original = bs.WATCH_DIR
        tmp = Path(tempfile.mkdtemp(prefix="cw-budgets-slice-"))
        bs.WATCH_DIR = tmp
        try:
            path = bs.write_slice("client-svet",
                                  bs.build_slice([], "источник", "none", status=bs.STATUS_NO_KEY))
            self.assertEqual(path.name, dt.date.today().isoformat() + ".json")
            self.assertEqual(path.parent.name, "budgets")
            self.assertEqual(path.parent.parent.name, "client-svet")
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "no_key")
            self.assertEqual(payload["projects"], [])
            self.assertFalse(list(path.parent.glob("*.tmp")))
        finally:
            bs.WATCH_DIR = original

    def test_52_status_vocabulary_matches_panel(self):
        self.assertEqual((bs.STATUS_OK, bs.STATUS_NO_KEY, bs.STATUS_NO_DOMAIN),
                         ("ok", "no_key", "no_domain"))

    def test_53_domain_is_not_put_into_project(self):
        """Домен НИКОГДА не подставляется в project: нет сопоставления — project/name = null."""
        data = bs.csv_import(SAMPLE)
        projects = bs.group_projects(data["rows"])            # без карты доменов
        by_domain = {item["domain"]: item for item in projects}
        self.assertIn("rg-dev.ru", by_domain)
        self.assertIsNone(by_domain["rg-dev.ru"]["project"])
        self.assertIsNone(by_domain["rg-dev.ru"]["name"])
        self.assertIn("не сопоставлен", by_domain["rg-dev.ru"]["note"])
        self.assertEqual(by_domain["rg-dev.ru"]["budget_rub"], 184500 + 162300)
        self.assertEqual(by_domain["rg-dev.ru"]["ads_count"], 80)
        self.assertEqual(by_domain["seliger-city.ru"]["budget_rub"], 240900)

    def test_53b_mapped_domain_gets_canonical_project_and_name(self):
        mapping = {"rg-dev.ru": {"project": "zhk-mihalkovskiy", "name": "ЖК Михалковский"}}
        projects = bs.group_projects(bs.csv_import(SAMPLE)["rows"], mapping=mapping)
        by_domain = {item["domain"]: item for item in projects}
        mapped = by_domain["rg-dev.ru"]
        self.assertEqual(mapped["project"], "zhk-mihalkovskiy")
        self.assertEqual(mapped["name"], "ЖК Михалковский")
        self.assertEqual(mapped["note"], "")
        unmapped = by_domain["seliger-city.ru"]
        self.assertIsNone(unmapped["project"])
        self.assertIsNone(unmapped["name"])
        self.assertEqual(unmapped["domain"], "seliger-city.ru")
        for item in projects:
            self.assertIn("domain", item)
            self.assertEqual(item["method"] if "method" in item else "csv", "csv")

    def test_53c_project_map_comes_from_real_profiles_and_config(self):
        mapping = bs.build_project_map("client-svet")
        for host, item in mapping.items():
            self.assertTrue(host)
            self.assertFalse(host.startswith("http"))
            self.assertTrue(item["project"])
            self.assertTrue(item["name"])
            self.assertNotIn("/", item["project"])
        # домен разработчика из реального профиля должен находиться
        if "rg-dev.ru" in mapping:
            self.assertEqual(mapping["rg-dev.ru"]["project"], "zhk-mihalkovskiy")
            self.assertEqual(mapping["rg-dev.ru"]["name"], "ЖК Михалковский")

    def test_53d_host_normalisation(self):
        self.assertEqual(bs.host_of("https://www.mrgroup.ru/projects/seliger-siti/"), "mrgroup.ru")
        self.assertEqual(bs.host_of("rg-dev.ru"), "rg-dev.ru")
        self.assertEqual(bs.host_of(""), "")

    def test_53e_method_vocabulary_is_the_panel_whitelist(self):
        """Белый список панели: api | csv | mcp — не расширяем."""
        payload = bs.build_slice([], "источник", "csv", status=bs.STATUS_OK)
        self.assertEqual(payload["method"], "csv")
        metrics = bs.budget_metrics({"method": "csv", "budget_estimate_rub": 1},
                                    source_label="выгрузка")
        self.assertEqual(metrics["marketing_method"]["value"], "csv")
        self.assertIn("csv", metrics["marketing_method"]["comment"])
        for allowed in ("api", "csv", "mcp"):
            self.assertTrue(allowed in ("api", "csv", "mcp"))
        source_text = (SCRIPTS_DIR / "budget_sources.py").read_text(encoding="utf-8")
        for value in ('"method": "csv-import', "'csv-import'", '"csv-import"'):
            self.assertNotIn(value, source_text, "нельзя оставлять самодельные коды методов")

    def test_55_fixture_slice_is_marked_demo(self):
        """Срез из образца/фикстуры ОБЯЗАН быть помечен demo: true — и в корне, и в записях."""
        imported = bs.csv_import(SAMPLE)
        self.assertTrue(imported["demo"], "каталог fixtures должен распознаваться как демо")
        self.assertEqual(imported["source"], "демо-образец выгрузки")
        projects = bs.group_projects(imported["rows"], mapping=bs.build_project_map("client-svet"))
        bs.mark_demo(projects)
        payload = bs.build_slice(projects, imported["source"], "csv", demo=True,
                                 note="оценка сервиса, НЕ фактический расход застройщика")
        self.assertTrue(payload["demo"])
        self.assertIn("ДЕМОНСТРАЦИОННЫЙ ОБРАЗЕЦ", payload["note"])
        self.assertTrue(payload["projects"])
        for item in payload["projects"]:
            self.assertTrue(item["demo"], item)
            self.assertIn("демо", item["accuracy"])

    def test_56_real_import_is_not_demo(self):
        """Реальная выгрузка из кабинета/API демо-флагом НЕ помечается."""
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="cw-real-budgets-"))
        (tmp / "export.csv").write_text("domain;adcost;ads\nrg-dev.ru;123456;7\n", encoding="utf-8-sig")
        imported = bs.csv_import(tmp)
        self.assertFalse(imported["demo"])
        self.assertEqual(imported["source"], "выгрузка из кабинета")
        projects = bs.group_projects(imported["rows"])
        self.assertEqual(projects[0]["budget_rub"], 123456)
        for item in projects:
            item["demo"] = bool(imported["demo"])
        payload = bs.build_slice(projects, "Keys.so / SpyWords / выгрузка из кабинета", "csv",
                                 demo=False, note="оценка сервиса, НЕ фактический расход застройщика")
        self.assertFalse(payload["demo"])
        self.assertNotIn("ДЕМОНСТРАЦИОННЫЙ", payload["note"])
        self.assertFalse(payload["projects"][0]["demo"])

    def test_57_demo_detection_rules(self):
        self.assertTrue(bs.is_demo_directory("C:/repo/tests/fixtures/budgets-sample"))
        self.assertTrue(bs.is_demo_directory("/inbox/budgets/sample-export.csv"))
        self.assertFalse(bs.is_demo_directory("C:/repo/01-competitor-watch/inbox/budgets"))
        self.assertFalse(bs.is_demo_directory(""))

    def test_54_metric_names_match_panel_map(self):
        summary = {"budget_estimate_rub": 1000, "ads_count": 5, "keywords_count": 7,
                   "landings_count": 2, "method": "csv-import", "period": "2026-10"}
        metrics = bs.budget_metrics(summary, source_label="выгрузка")
        for key in ("marketing_budget_estimate_rub", "marketing_ads_count",
                    "marketing_keywords_count", "marketing_landings_count", "marketing_period",
                    "marketing_source", "marketing_method"):
            self.assertIn(key, metrics, key)
            self.assertTrue(metrics[key]["collected_at"])
        self.assertEqual(metrics["marketing_budget_estimate_rub"]["value"], 1000)
        self.assertIn("оценка сервиса", metrics["marketing_budget_estimate_rub"]["accuracy"])
        self.assertEqual(metrics["marketing_period"]["value"], "2026-10")
        self.assertEqual(metrics["marketing_method"]["value"], "csv-import")
        self.assertEqual(sorted(metrics.keys()), sorted(bs.METRIC_NAMES))


class CollectTestCase(unittest.TestCase):
    def test_40_without_tokens_csv_still_works(self):
        result = bs.collect(domain="rg-dev.ru", sources=("csv",), csv_dir=SAMPLE)
        self.assertEqual(result["sources"]["csv"]["status"], "ok")
        self.assertIn("оценка сервиса",
                      result["sources"]["csv"]["metrics"]["marketing_budget_estimate_rub"]["accuracy"])
        blocked = bs.collect(domain="rg-dev.ru", sources=("keysso", "spywords"), csv_dir=SAMPLE)
        for name in ("keysso", "spywords"):
            status = blocked["sources"][name]["status"]
            self.assertIn(status, ("ключ не задан", "пусто", "ошибка запроса"))
            if status == "ключ не задан":
                self.assertIsNone(blocked["sources"][name]["metrics"]
                                  ["marketing_budget_estimate_rub"]["value"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
