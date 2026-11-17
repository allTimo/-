"""Контрактные тесты рантайма скиллов.

Проверяют не источники данных, а сам контракт: реестр, таймауты, поведение без
ключа, отлов исключений, формат записи, журналирование и вызов через run_skill.
Сеть не используется: транспорт подменяется.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock
from skills.runtime import (
    DEFAULT_TIMEOUT,
    MAX_TIMEOUT,
    REGISTRY_PATH,
    STATUS_EMPTY,
    STATUS_ERROR,
    STATUS_NO_KEY,
    STATUS_NOT_DEPLOYED,
    STATUS_OK,
    SkillError,
    SkillSkipped,
    SkillUnavailable,
    clamp_timeout,
    http_json,
    make_record,
    record_run,
    require_env,
    run_skill,
    run_skill_result,
    skill,
)


class TestTimeouts(unittest.TestCase):
    """Требование задания: таймаут запроса не больше 10 секунд."""

    def test_default_timeout_within_limit(self):
        self.assertLessEqual(DEFAULT_TIMEOUT, MAX_TIMEOUT)

    def test_clamp_caps_to_max(self):
        self.assertEqual(clamp_timeout(99), MAX_TIMEOUT)
        self.assertEqual(clamp_timeout(10.5), MAX_TIMEOUT)

    def test_clamp_falls_back_on_bad_input(self):
        self.assertEqual(clamp_timeout(None), DEFAULT_TIMEOUT)
        self.assertEqual(clamp_timeout(0), DEFAULT_TIMEOUT)
        self.assertEqual(clamp_timeout(-5), DEFAULT_TIMEOUT)
        self.assertEqual(clamp_timeout("мусор"), DEFAULT_TIMEOUT)

    def test_clamp_keeps_valid_value(self):
        self.assertEqual(clamp_timeout(3), 3.0)


class TestRequireEnv(unittest.TestCase):
    """Отсутствие ключа — предупреждение, а не сбой."""

    def test_missing_key_raises_skipped(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SkillSkipped) as ctx:
                require_env("НЕТ_ТАКОЙ_ПЕРЕМЕННОЙ_X", skill="проба")
        self.assertEqual(ctx.exception.code, STATUS_NO_KEY)
        self.assertIn("НЕТ_ТАКОЙ_ПЕРЕМЕННОЙ_X", ctx.exception.reason)

    def test_present_key_returned(self):
        with mock.patch.dict(os.environ, {"ЖИВОЙ_КЛЮЧ_X": "  значение  "}, clear=True):
            self.assertEqual(require_env("ЖИВОЙ_КЛЮЧ_X"), "значение")

    def test_blank_key_is_missing(self):
        with mock.patch.dict(os.environ, {"ПУСТОЙ_КЛЮЧ_X": "   "}, clear=True):
            with self.assertRaises(SkillSkipped):
                require_env("ПУСТОЙ_КЛЮЧ_X")


class TestSkillDecorator(unittest.TestCase):
    """Декоратор обязан вернуть list[dict] и никогда не поднять исключение."""

    def test_success_returns_records(self):
        @skill("проба_ок")
        def fetch(query, **kwargs):
            return [{"source": "проба_ок", "title": query}]

        self.assertEqual(fetch("тест"), [{"source": "проба_ок", "title": "тест"}])
        self.assertEqual(fetch.last_run["status"], STATUS_OK)
        self.assertEqual(fetch.last_run["count"], 1)

    def test_records_without_data_are_dropped(self):
        """Ложный успех недопустим: мусорная запись не становится результатом."""

        @skill("проба_мусор")
        def fetch(query, **kwargs):
            return [{}, {"source": "проба_мусор"}, {"source": "проба_мусор", "api": "avito"}]

        self.assertEqual(fetch("тест"), [])
        self.assertEqual(fetch.last_run["status"], STATUS_EMPTY)
        self.assertEqual(fetch.last_run["dropped_empty"], 3)

    def test_empty_list_gives_empty_status(self):
        @skill("проба_пусто")
        def fetch(query, **kwargs):
            return []

        self.assertEqual(fetch("тест"), [])
        self.assertEqual(fetch.last_run["status"], STATUS_EMPTY)

    def test_skipped_no_key_swallowed(self):
        @skill("проба_ключ")
        def fetch(query, **kwargs):
            raise SkillSkipped("нет ключа", code=STATUS_NO_KEY)

        self.assertEqual(fetch("тест"), [])
        self.assertEqual(fetch.last_run["status"], STATUS_NO_KEY)
        self.assertIn("нет ключа", fetch.last_run["error"])

    def test_not_deployed_swallowed(self):
        @skill("проба_разворот")
        def fetch(query, **kwargs):
            raise SkillUnavailable("сервис не развёрнут")

        self.assertEqual(fetch("тест"), [])
        self.assertEqual(fetch.last_run["status"], STATUS_NOT_DEPLOYED)

    def test_unexpected_exception_swallowed(self):
        @skill("проба_сбой")
        def fetch(query, **kwargs):
            raise RuntimeError("внутренняя поломка")

        self.assertEqual(fetch("тест"), [])
        self.assertEqual(fetch.last_run["status"], STATUS_ERROR)
        self.assertIn("внутренняя поломка", fetch.last_run["error"])

    def test_none_result_treated_as_empty(self):
        @skill("проба_ничего")
        def fetch(query, **kwargs):
            return None

        self.assertEqual(fetch("тест"), [])
        self.assertEqual(fetch.last_run["status"], STATUS_EMPTY)

    def test_duration_measured(self):
        @skill("проба_время")
        def fetch(query, **kwargs):
            return [{"a": 1}]

        fetch("тест")
        self.assertGreaterEqual(fetch.last_run["duration_ms"], 0)


class TestMakeRecord(unittest.TestCase):
    """Честность данных: отсутствующее значение — None, а не 0 и не пустая строка."""

    def test_all_canonical_keys_present(self):
        record = make_record("проба")
        for key in ("id", "title", "price", "area", "year_built", "address", "url", "raw"):
            self.assertIn(key, record)
            self.assertIsNone(record[key])
        self.assertEqual(record["source"], "проба")

    def test_missing_price_is_none_not_zero(self):
        record = make_record("проба", title="Объект")
        self.assertIsNone(record["price"])
        self.assertNotEqual(record["price"], 0)

    def test_extra_fields_kept(self):
        record = make_record("проба", title="Объект", region="Москва")
        self.assertEqual(record["region"], "Москва")


class TestRecordRun(unittest.TestCase):
    """Все вызовы логируются: скилл, запрос, статус, время выполнения."""

    def test_journal_entry_has_required_fields(self):
        from skills.runtime import core as core_module

        # Пишем в рабочую папку журнала: удаление временных каталогов в песочнице запрещено.
        journal = core_module.LOGS_DIR / "_test-runs.jsonl"
        try:
            with mock.patch.object(core_module, "RUN_LOG", journal):
                entry = record_run("проба", "запрос", STATUS_OK, 12.34, 3)

            self.assertEqual(entry["skill"], "проба")
            self.assertEqual(entry["query"], "запрос")
            self.assertEqual(entry["status"], STATUS_OK)
            self.assertEqual(entry["duration_ms"], 12.3)
            self.assertEqual(entry["count"], 3)
            self.assertIn("ts", entry)

            written = json.loads(journal.read_text(encoding="utf-8").strip().splitlines()[-1])
            self.assertEqual(written["skill"], "проба")
        finally:
            journal.unlink(missing_ok=True)

    def test_journal_failure_does_not_break_skill(self):
        from skills.runtime import core as core_module

        with mock.patch.object(core_module, "RUN_LOG", Path("Z:/нет/такого/пути/runs.jsonl")):
            entry = record_run("проба", "запрос", STATUS_OK, 1.0, 0)
        self.assertEqual(entry["status"], STATUS_OK)


class TestHttpJson(unittest.TestCase):
    """HTTP-слой: разбор JSON, понятные ошибки, таймаут обрезается."""

    def test_broken_json_raises_skill_error(self):
        with mock.patch("skills.runtime.http._transport", return_value="<html>не json</html>"):
            with self.assertRaises(SkillError) as ctx:
                http_json("https://example.invalid/x")
        self.assertIn("не является JSON", str(ctx.exception))

    def test_empty_body_raises_skill_error(self):
        with mock.patch("skills.runtime.http._transport", return_value="   "):
            with self.assertRaises(SkillError):
                http_json("https://example.invalid/x")

    def test_valid_json_returned(self):
        with mock.patch("skills.runtime.http._transport", return_value='{"ok": true}'):
            self.assertEqual(http_json("https://example.invalid/x"), {"ok": True})

    def test_timeout_is_clamped_before_transport(self):
        with mock.patch("skills.runtime.http._transport", return_value="{}") as transport:
            http_json("https://example.invalid/x", timeout=99)
        self.assertEqual(transport.call_args[0][1], MAX_TIMEOUT)

    def test_query_params_encoded(self):
        with mock.patch("skills.runtime.http._transport", return_value="{}") as transport:
            http_json("https://example.invalid/x", params={"q": "дом", "skip": None})
        url = transport.call_args[0][0].full_url
        self.assertIn("q=", url)
        self.assertNotIn("skip", url)


class TestRegistry(unittest.TestCase):
    """Реестр: все 9 скиллов на месте, модули реально импортируются."""

    EXPECTED = [
        "mcp_market",
        "reefapi",
        "rentscout",
        "mcp_rosreestr",
        "apify",
        "rentcast",
        "zillapi",
        "developer_pricing",
        "yandex_direct",
    ]

    def setUp(self):
        self.assertTrue(REGISTRY_PATH.is_file(), f"нет реестра {REGISTRY_PATH}")
        self.registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))

    def test_all_nine_skills_registered(self):
        names = [entry["name"] for entry in self.registry["skills"]]
        self.assertEqual(sorted(names), sorted(self.EXPECTED))

    def test_names_unique(self):
        names = [entry["name"] for entry in self.registry["skills"]]
        self.assertEqual(len(names), len(set(names)))

    def test_every_entry_has_required_fields(self):
        for entry in self.registry["skills"]:
            for field in ("name", "title", "module", "entry", "purpose", "free_tier"):
                self.assertIn(field, entry, f"{entry.get('name')}: нет поля {field}")

    def test_every_module_importable_and_has_entry(self):
        import importlib

        for entry in self.registry["skills"]:
            module = importlib.import_module(entry["module"])
            function = getattr(module, entry.get("entry", "fetch"), None)
            self.assertTrue(callable(function), f"{entry['name']}: нет функции {entry.get('entry')}")
            self.assertTrue(hasattr(module, "SKILL"), f"{entry['name']}: нет SKILL-метаданных")

    def test_blank_query_returns_empty_without_network(self):
        for entry in self.registry["skills"]:
            result = run_skill_result(entry["name"], "")
            self.assertEqual(result["records"], [], entry["name"])
            self.assertIsInstance(result["records"], list, entry["name"])

    def test_key_skills_skip_when_env_cleared(self):
        """Требование задания: без ключа — предупреждение и пустой список, без исключений."""
        key_skills = {
            "reefapi": "REEFAPI_KEY",
            "apify": "APIFY_TOKEN",
            "rentcast": "RENTCAST_KEY",
            "zillapi": "ZILLAPI_KEY",
        }
        with mock.patch.dict(os.environ, {}, clear=True):
            for name in key_skills:
                result = run_skill_result(name, "москва")
                self.assertEqual(result["records"], [], name)
                self.assertIn(result["status"], {STATUS_NO_KEY, STATUS_NOT_DEPLOYED, STATUS_ERROR}, name)

    def test_unknown_skill_does_not_raise(self):
        result = run_skill_result("нет_такого_скилла_xyz", "тест")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)
        self.assertIn("не найден", result["error"])

    def test_run_skill_returns_list(self):
        self.assertIsInstance(run_skill("нет_такого_скилла_xyz", "тест"), list)


if __name__ == "__main__":
    unittest.main(verbosity=2)
