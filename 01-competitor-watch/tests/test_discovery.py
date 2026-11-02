#!/usr/bin/env python3
r"""Tests for automatic competitor discovery (task-57): haversine, filters, decisions, cache.

Run:
    <python> -m unittest discover -s marketing-agents\01-competitor-watch\tests -v
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
REGISTRY_DIR = PROJECT_DIR.parent / "registry"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                    # noqa: E402
import discover_competitors as disc   # noqa: E402
import platforms                      # noqa: E402

WATCH_SETTINGS = REGISTRY_DIR / "agent-settings" / "agent-1-competitor-watch.yaml"
KHAMOVNIKI = (55.7172705, 37.5739989)


class HaversineTestCase(unittest.TestCase):
    def test_01_known_distances(self):
        self.assertEqual(disc.haversine_km(*KHAMOVNIKI, *KHAMOVNIKI), 0.0)
        # 1 градус долготы на экваторе ≈ 111.19 км
        self.assertAlmostEqual(disc.haversine_km(0.0, 0.0, 0.0, 1.0), 111.19, places=1)
        # Хамовнический вал -> Barrin House (Ефремова, 10) ≈ 0.98 км
        self.assertAlmostEqual(disc.haversine_km(*KHAMOVNIKI, 55.725995, 37.5756655), 0.98, places=1)
        # Хамовнический вал -> Селигер Сити (Ильменский проезд) ≈ 16 км
        self.assertAlmostEqual(disc.haversine_km(*KHAMOVNIKI, 55.8606578, 37.5452889), 16.0, places=0)

    def test_02_candidate_id_is_stable_slug(self):
        self.assertEqual(disc.candidate_id("ЖК «Свет»", "Dominanta"), "zhk-svet-dominanta")
        self.assertEqual(disc.candidate_id("ЖК «Свет»", "Dominanta"),
                         disc.candidate_id("  жк «свет» ", "dominanta"))
        self.assertNotEqual(disc.candidate_id("ЖК Свет", "A"), disc.candidate_id("ЖК Свет", "B"))
        self.assertEqual(disc.candidate_id("", ""), "project")


class WatchSettingsTestCase(unittest.TestCase):
    def test_10_watch_group_is_read(self):
        if not WATCH_SETTINGS.exists():
            self.skipTest("настройки агента недоступны")
        watch = disc.load_watch(WATCH_SETTINGS)
        self.assertTrue(watch["project_id"])
        self.assertGreater(watch["radius_km"], 0)
        self.assertIsInstance(watch["sources"], list)
        self.assertGreaterEqual(watch["max_candidates"], 1)

    def test_11_coords_from_lat_lon_or_coords_pair(self):
        self.assertEqual(disc.watch_coords({"lat": "55.7", "lon": "37.6"}), (55.7, 37.6))
        self.assertEqual(disc.watch_coords({"coords": [55.7, 37.6]}), (55.7, 37.6))
        self.assertEqual(disc.watch_coords({}), (None, None))
        self.assertEqual(disc.watch_coords({"lat": "", "lon": ""}), (None, None))

    def test_12_cli_overrides(self):
        watch = disc.load_watch(WATCH_SETTINGS, project_id="demo", radius=3, classes=["премиум"])
        self.assertEqual(watch["project_id"], "demo")
        self.assertEqual(watch["radius_km"], 3.0)
        self.assertEqual(watch["klass"], ["премиум"])


class GeocodeCacheTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-geocode-test-"))
        self.cache = self.tmp / "geocache.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_20_cache_avoids_second_request(self):
        calls = {"count": 0}

        def fake_fetch(url):
            calls["count"] += 1
            return [{"lat": "55.7172705", "lon": "37.5739989", "display_name": "улица Хамовнический Вал, 10",
                     "type": "house", "class": "place"}]

        first = disc.geocode("Москва, Хамовнический вал, 10", cache_path=self.cache, fetch=fake_fetch)
        self.assertFalse(first["cached"])
        self.assertEqual((first["lat"], first["lon"]), KHAMOVNIKI)
        self.assertEqual(first["warning"], "")
        second = disc.geocode("Москва, Хамовнический вал, 10", cache_path=self.cache, fetch=fake_fetch)
        self.assertTrue(second["cached"])
        self.assertEqual(calls["count"], 1, "второй вызов должен идти из кэша")
        self.assertTrue(self.cache.exists())

    def test_21_low_accuracy_and_failures_are_reported(self):
        def street_level(url):
            return [{"lat": "55.75", "lon": "37.61", "display_name": "Москва", "type": "city", "class": "place"}]

        geo = disc.geocode("Москва, ул. Примерная, 1", cache_path=self.cache, fetch=street_level)
        self.assertIn("точность", geo.get("warning", ""))

        def broken(url):
            raise RuntimeError("сервис недоступен")

        failed = disc.geocode("Москва, неизвестный адрес", cache_path=self.cache, fetch=broken)
        self.assertIsNone(failed["lat"])
        self.assertIn("не определены", failed["warning"])

    def test_22_origin_resolution(self):
        origin = disc.resolve_watch_coords({"lat": 55.7, "lon": 37.6})
        self.assertEqual(origin["source"], "settings")
        self.assertEqual(origin["warning"], "")
        none_origin = disc.resolve_watch_coords({"address": ""})
        self.assertIsNone(none_origin["lat"])
        self.assertIn("невозможен", none_origin["warning"])


class GeocodeAccuracyTestCase(unittest.TestCase):
    """Оценка точности геокодирования и кэш только фактов."""

    def test_23_accuracy_grades(self):
        self.assertEqual(disc.accuracy_grade({"accuracy": "house/place"}), "precise")
        self.assertEqual(disc.accuracy_grade({"accuracy": "building/place"}), "precise")
        self.assertEqual(disc.accuracy_grade({"accuracy": "primary/highway"}), "coarse")
        self.assertEqual(disc.accuracy_grade({"accuracy": "neighbourhood/place"}), "coarse")
        self.assertEqual(disc.accuracy_grade({"accuracy": "construction/landuse"}), "coarse")
        self.assertEqual(disc.accuracy_grade({"accuracy": "administrative/boundary"}), "unusable")
        self.assertEqual(disc.accuracy_grade({"accuracy": "country/place"}), "unusable")
        self.assertEqual(disc.accuracy_grade({}), "unusable")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-geocache-case-"))
        self.cache = self.tmp / "geocache.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_24_unusable_coords_are_refused_for_the_watch_object(self):
        origin = disc.resolve_watch_coords(
            {"address": "Москва, Дмитровское шоссе, 83А",
             "lat": None, "lon": None}, cache_path=self.cache,
            fetch=lambda url: [{"lat": "43.4", "lon": "6.2", "type": "administrative",
                                "class": "boundary", "importance": "0.9"}])
        self.assertIsNone(origin["lat"])
        self.assertIn("не используем", origin["warning"])

    def test_25_coarse_coords_are_used_with_a_warning(self):
        origin = disc.resolve_watch_coords(
            {"address": "Москва, Дмитровское шоссе, 83А"}, cache_path=self.cache,
            fetch=lambda url: [{"lat": "55.8504471", "lon": "37.5660167", "type": "primary",
                                "class": "highway", "importance": "0.5"}])
        self.assertAlmostEqual(origin["lat"], 55.8504471, places=4)
        self.assertIn("невысокая", origin["warning"])

    def test_26_broken_address_is_reported(self):
        origin = disc.resolve_watch_coords({"address": "??????, ???????? ????????, 83?"},
                                           cache_path=self.cache)
        self.assertIsNone(origin["lat"])
        self.assertIn("повреждён", origin["warning"])

    def test_27_cache_keeps_facts_and_recomputes_grade(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-geocache-"))
        try:
            cache_file = tmp / "geocache.json"
            cache_file.write_text(json.dumps({
                "addr:москва, хамовнический вал, 10": {
                    "lat": 55.7172705, "lon": 37.5739989, "accuracy": "primary/highway",
                    "source": "osm-nominatim", "grade": "unusable", "warning": "устаревшая оценка"},
            }, ensure_ascii=False), encoding="utf-8")
            result = disc.geocode("Москва, Хамовнический вал, 10", cache_path=cache_file)
            self.assertTrue(result["cached"])
            self.assertEqual(result["grade"], "coarse")          # пересчитано по факту
            self.assertIn("невысокая", result["warning"])
            saved = json.loads(cache_file.read_text(encoding="utf-8"))
            self.assertNotIn("warning", saved["addr:москва, хамовнический вал, 10"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class CachePoisonRecoveryTestCase(unittest.TestCase):
    """Непригодная запись кэша (чужая страна/админграница) не должна держать нас в заложниках."""

    def test_29_unusable_cache_entry_is_requeried(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-cache-poison-"))
        try:
            cache_file = tmp / "geocache.json"
            cache_file.write_text(json.dumps({
                "addr:москва, дмитровское шоссе, 83а": {
                    "lat": 43.41736, "lon": 6.26646, "accuracy": "administrative/boundary",
                    "source": "osm-nominatim"},
            }, ensure_ascii=False), encoding="utf-8")
            calls = {"count": 0}

            def fresh(url):
                calls["count"] += 1
                return [{"lat": "55.8504471", "lon": "37.5660167", "type": "primary",
                         "class": "highway", "importance": "0.5"}]

            result = disc.geocode("Москва, Дмитровское шоссе, 83А", cache_path=cache_file, fetch=fresh)
            self.assertEqual(calls["count"], 1, "непригодную запись кэша нужно перезапросить")
            self.assertAlmostEqual(result["lat"], 55.8504471, places=4)
            self.assertEqual(result["grade"], "coarse")
            saved = json.loads(cache_file.read_text(encoding="utf-8"))
            self.assertEqual(saved["addr:москва, дмитровское шоссе, 83а"]["lat"], 55.8504471)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TransportPolicyTestCase(unittest.TestCase):
    def test_28_transport_policy_table(self):
        self.assertEqual(platforms.PLATFORM_TRANSPORT.get("cian"), "http-only")
        self.assertEqual(platforms.PLATFORM_TRANSPORT.get("domclick"), "http-only")
        self.assertEqual(platforms.PLATFORM_TRANSPORT.get("avito"), "http-then-browser")
        self.assertIn(439, platforms.BLOCK_STATUSES)
        self.assertIn(401, platforms.BLOCK_STATUSES)

class CandidateFilterTestCase(unittest.TestCase):
    def setUp(self):
        self.watch = {"klass": ["бизнес", "премиум"], "radius_km": 10, "price_min_per_m2": 250000,
                      "price_max_per_m2": 900000}
        self.origin = {"lat": KHAMOVNIKI[0], "lon": KHAMOVNIKI[1]}
        self.entries = [
            {"name": "Близкий ЖК", "class": "бизнес", "lat": 55.725995, "lon": 37.5756655,
             "price_per_m2": 400000, "sources": [{"platform": "web-search", "url": "https://a"}]},
            {"name": "Далёкий ЖК", "class": "бизнес", "lat": 55.8606578, "lon": 37.5452889,
             "price_per_m2": 300000},
            {"name": "Дорогой ЖК", "class": "премиум", "lat": 55.7402042, "lon": 37.6049144,
             "price_per_m2": 1200000},
            {"name": "Не тот класс", "class": "комфорт", "lat": 55.7427981, "lon": 37.5989308,
             "price_per_m2": 200000},
            {"name": "Без координат", "class": "бизнес", "price_per_m2": None},
        ]

    def build(self, **overrides):
        watch = dict(self.watch, **overrides)
        return disc.build_candidates(self.entries, watch, self.origin, fetch=None)

    def test_30_radius_filter(self):
        candidates = self.build()
        inside = [item["name"] for item in disc.filter_candidates(candidates, 10)]
        self.assertIn("Близкий ЖК", inside)
        self.assertIn("Дорогой ЖК", inside)
        self.assertNotIn("Далёкий ЖК", inside)            # ~16 км
        for radius in (5, 1):
            names = [item["name"] for item in disc.filter_candidates(self.build(), radius)]
            self.assertIn("Близкий ЖК", names)
        self.assertNotIn("Не тот класс", [item["name"] for item in disc.filter_candidates(
            [item for item in self.build() if item["class_match"] is not False], 10)])

    def test_31_class_and_price_notes(self):
        candidates = {item["name"]: item for item in self.build()}
        self.assertIs(candidates["Близкий ЖК"]["class_match"], True)
        self.assertIs(candidates["Не тот класс"]["class_match"], False)
        self.assertIn("не совпадает", "; ".join(candidates["Не тот класс"]["notes"]))
        self.assertFalse(candidates["Дорогой ЖК"]["in_price_range"])
        self.assertTrue(candidates["Дорогой ЖК"]["in_radius"])

    def test_32_missing_data_is_not_invented(self):
        candidates = {item["name"]: item for item in self.build()}
        without = candidates["Без координат"]
        self.assertIsNone(without["distance_km"])
        self.assertIsNone(without["price_per_m2"])
        self.assertEqual(without["confidence"], "low")
        notes = " ".join(without["notes"])
        self.assertIn("данных нет", notes)
        far = candidates["Далёкий ЖК"]
        self.assertIn("за пределами радиуса", " ".join(far["notes"]))

    def test_33_candidates_have_stable_ids(self):
        for item in self.build():
            self.assertTrue(item["id"])
            self.assertNotIn(" ", item["id"])
            self.assertTrue(item["found_at"])
            self.assertEqual(item["status"], "candidate")


class DecisionsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-decisions-test-"))
        self.origin = {"lat": KHAMOVNIKI[0], "lon": KHAMOVNIKI[1]}
        self.watch = {"klass": ["бизнес"], "radius_km": 10}
        self.entries = [
            {"name": "ЖК Альфа", "class": "бизнес", "lat": 55.725995, "lon": 37.5756655},
            {"name": "ЖК Бета", "class": "бизнес", "lat": 55.7402042, "lon": 37.6049144},
        ]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def found(self):
        return disc.build_candidates(self.entries, self.watch, self.origin, fetch=None)

    def test_40_decisions_are_applied_by_id(self):
        found = self.found()
        decisions = {found[0]["id"]: {"status": "approved", "at": "2026-11-01T10:00:00+03:00"},
                     found[1]["id"]: {"status": "rejected", "at": "2026-11-01T10:00:00+03:00"}}
        merged = disc.merge_candidates({}, found, decisions, 20)
        by_id = {item["id"]: item for item in merged}
        self.assertEqual(by_id[found[0]["id"]]["status"], "approved")
        self.assertEqual(by_id[found[1]["id"]]["status"], "rejected")
        self.assertIn("подтверждён пользователем", " ".join(by_id[found[0]["id"]]["notes"]))
        self.assertIn("повторно не предлагается", " ".join(by_id[found[1]["id"]]["notes"]))

    def test_41_repeat_run_keeps_decisions_and_does_not_reoffer(self):
        found = self.found()
        decisions = {found[0]["id"]: {"status": "approved", "at": "x"},
                     found[1]["id"]: {"status": "rejected", "at": "x"}}
        first = disc.merge_candidates({}, found, decisions, 20)
        # повторный прогон: решения пришли снова (файл панели), новых кандидатов нет
        second = disc.merge_candidates({item["id"]: item for item in first}, self.found(), decisions, 20)
        by_id = {item["id"]: item for item in second}
        self.assertEqual(by_id[found[0]["id"]]["status"], "approved")
        self.assertEqual(by_id[found[1]["id"]]["status"], "rejected")
        # панель удалила решения -> статусы из файла кандидатов сохраняются
        third = disc.merge_candidates({item["id"]: item for item in first}, self.found(), {}, 20)
        by_id3 = {item["id"]: item for item in third}
        self.assertEqual(by_id3[found[1]["id"]]["status"], "rejected")

    def test_42_decisions_file_is_only_read(self):
        path = self.tmp / "my-zhk-svet.decisions.json"
        payload = {disc.candidate_id("ЖК Альфа"): {"status": "rejected", "at": "2026-11-01T10:00:00+03:00"}}
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        before = path.read_bytes()
        decisions, read_path = disc.load_decisions("my-zhk-svet", self.tmp)
        self.assertEqual(read_path, path)
        self.assertEqual(decisions, payload)
        # движок не пишет решения: файл не изменился ни при записи кандидатов, ни при слиянии
        disc.write_candidates("my-zhk-svet", {"candidates": []}, directory=self.tmp, backup=False)
        disc.merge_candidates({}, self.found(), decisions, 20)
        self.assertEqual(path.read_bytes(), before)

    def test_43_payload_shape_and_atomic_write(self):
        found = self.found()
        merged = disc.merge_candidates({}, found, {}, 20)
        payload = {"project_id": "my-zhk-svet", "radius_km": 10,
                   "summary": disc.summarize(merged, 10), "candidates": merged}
        first_path, before, after = disc.write_candidates("my-zhk-svet", payload, directory=self.tmp)
        self.assertIsNone(before)
        self.assertEqual(len(after), 64)
        second_path, before2, after2 = disc.write_candidates("my-zhk-svet", payload, directory=self.tmp)
        self.assertEqual(before2, after2 if before2 == after else after)
        self.assertEqual(len(list(self.tmp.glob("my-zhk-svet.json.bak-*"))), 1)
        data = json.loads(first_path.read_text(encoding="utf-8"))
        self.assertEqual(data["summary"]["total"], 2)
        self.assertIn("id", data["candidates"][0])
        self.assertEqual(disc.summarize(merged, 10)["in_radius"], 2)


class PlatformAttemptsTestCase(unittest.TestCase):
    def test_50_unreachable_platform_does_not_crash(self):
        attempts = disc.discover_via_platforms({"sources": ["cian", "nonexistent"]}, allow_browser=False)
        self.assertEqual(len(attempts), 1)               # неизвестный источник пропущен
        attempt = attempts[0]
        self.assertIn(attempt["status"], ("ok", "needs_browser", "needs_partnership", "no_data", "error"))
        self.assertIn("url", attempt)

    def test_51_js_state_candidates_from_cian_shape(self):
        state = {"kind": "cian-newbuildings", "items": [
            {"name": "ЖК Тест", "developers": ["СЗ Тест"], "klass": "бизнес", "price_per_m2": 300000,
             "lat": 55.72, "lon": 37.58, "url": "https://www.cian.ru/zhk-test/"},
        ]}
        candidates = platforms.js_state_candidates("cian", state)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["name"], "ЖК Тест")
        self.assertEqual(candidates[0]["developer"], "СЗ Тест")
        self.assertEqual(candidates[0]["sources"][0]["platform"], "cian")
        built = disc.build_candidates(candidates, {"klass": ["бизнес"], "radius_km": 10},
                                      {"lat": KHAMOVNIKI[0], "lon": KHAMOVNIKI[1]}, fetch=None)
        self.assertLess(built[0]["distance_km"], 1.0)

    def test_52_search_results_fixture_is_real_and_parsable(self):
        fixture = TESTS_DIR / "fixtures" / "search-results-2026-11-01.json"
        if not fixture.exists():
            self.skipTest("снимок поиска отсутствует")
        entries = disc.load_search_results(fixture)
        self.assertGreaterEqual(len(entries), 3)
        for entry in entries:
            self.assertTrue(entry.get("name"))
            self.assertTrue(entry.get("sources") or entry.get("url"))
        # геокодирование в фикстуре непустое, иначе расстояния не посчитать
        geocoded = [entry for entry in entries if entry.get("lat") and entry.get("lon")]
        self.assertGreaterEqual(len(geocoded), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
