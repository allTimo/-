"""Состязательные проверки скиллов: режимы отказа и попытки ложного успеха.

Инструмент `review` в этой среде линзы не запускает (пробел в покрытии), поэтому
эти проверки написаны вручную и заменяют его: каждая проверяет конкретный способ,
которым скилл мог бы соврать или упасть.

Сеть не используется: транспорт ``skills.runtime.http._transport`` подменяется.
"""

from __future__ import annotations

import json
import os
import unittest
from unittest import mock

import skills.runtime.http as http_mod
from skills.runtime import (
    MAX_TIMEOUT,
    STATUS_EMPTY,
    STATUS_ERROR,
    STATUS_NO_KEY,
    STATUS_NOT_DEPLOYED,
    STATUS_OK,
    run_skill,
    run_skill_result,
)

#: Скиллы, требующие ключ, и их переменные.
KEY_SKILLS = {
    "reefapi": "REEFAPI_KEY",
    "apify": "APIFY_TOKEN",
    "rentcast": "RENTCAST_KEY",
    "zillapi": "ZILLAPI_KEY",
}

#: Скиллы с настраиваемым таймаутом: (имя, окружение для достижения транспорта).
TIMEOUT_CASES = [
    ("rentcast", {"RENTCAST_KEY": "тест", "RENTCAST_TIMEOUT": "999"}),
    ("zillapi", {"ZILLAPI_KEY": "тест", "ZILLAPI_TIMEOUT": "999"}),
    ("apify", {"APIFY_TOKEN": "тест", "APIFY_ACTOR": "a/b", "APIFY_TIMEOUT": "999"}),
    ("rentscout", {"RENTSCOUT_TIMEOUT": "999"}),
    (
        "mcp_rosreestr",
        {"MCP_ROSREESTR_URL": "http://127.0.0.1:9", "MCP_ROSREESTR_TIMEOUT": "999"},
    ),
]


def _patch_transport(payload: str, seen: list | None = None):
    """Подменить транспорт; при желании запомнить, что и с каким таймаутом ушло."""

    def fake(request, timeout):
        if seen is not None:
            seen.append({"url": request.full_url, "timeout": timeout, "method": request.get_method()})
        return payload

    return mock.patch.object(http_mod, "_transport", fake)


class TestNoFalseSuccess(unittest.TestCase):
    """Скилл не должен выдавать `ok` и «данные» там, где данных нет."""

    def test_mcp_market_hostile_company_list(self):
        """Список компаний из мусора не должен превращаться в записи."""
        with _patch_transport(json.dumps({"companies": [None, 42, {}, "строка"]})):
            result = run_skill_result("mcp_market", "запрос")
        records = result["records"]
        self.assertNotEqual(result["status"], STATUS_OK, "ок при мусорном ответе")
        self.assertEqual(records, [], f"мусор стал данными: {records}")

    def test_mcp_market_companies_not_a_list(self):
        with _patch_transport(json.dumps({"companies": "мусор"})):
            result = run_skill_result("mcp_market", "запрос")
        self.assertEqual(result["records"], [])

    def test_mcp_market_real_company_survives(self):
        """Обратная проверка: настоящая запись не должна отфильтроваться."""
        payload = {"companies": [{"id": "1", "name": "Дом", "price_per_sqm_min": 100}]}
        with _patch_transport(json.dumps(payload)):
            result = run_skill_result("mcp_market", "запрос")
        self.assertEqual(len(result["records"]), 1)
        self.assertEqual(result["records"][0]["title"], "Дом")

    def test_mcp_market_list_response_does_not_crash(self):
        with _patch_transport(json.dumps([{"id": "1"}])):
            result = run_skill_result("mcp_market", "запрос")
        self.assertEqual(result["records"], [])
        self.assertIn(result["status"], {STATUS_EMPTY, STATUS_ERROR})

    def test_reefapi_ok_false_gives_nothing(self):
        payload = {"ok": False, "error": {"code": "NO_KEY", "message": "нет доступа"}}
        with mock.patch.dict(os.environ, {"REEFAPI_KEY": "тест"}):
            with _patch_transport(json.dumps(payload)):
                result = run_skill_result("reefapi", "запрос")
        self.assertEqual(result["records"], [])
        self.assertNotEqual(result["status"], STATUS_OK)

    def test_rentcast_bad_json_gives_error(self):
        with mock.patch.dict(os.environ, {"RENTCAST_KEY": "тест"}):
            with _patch_transport("<html>не json</html>"):
                result = run_skill_result("rentcast", "запрос")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)


    def test_decorator_drops_records_without_data(self):
        """Предохранитель рантайма: запись без данных не становится результатом."""
        from skills.runtime import is_empty_record, skill

        @skill("проба_пустая")
        def fetch(query, **kwargs):
            return [{}, {"source": "x"}, None, 42, "строка", {"title": "ЖК"}]

        records = fetch("запрос")
        self.assertEqual(len(records), 1, f"осталось не то: {records}")
        self.assertEqual(records[0]["title"], "ЖК")
        self.assertEqual(fetch.last_run["dropped_empty"], 5)
        self.assertEqual(fetch.last_run["status"], STATUS_OK)

    def test_is_empty_record_rules(self):
        from skills.runtime import is_empty_record

        # Пусто: ни исходного объекта, ни содержательных полей.
        self.assertTrue(is_empty_record({}))
        self.assertTrue(is_empty_record({"source": "x"}))
        self.assertTrue(is_empty_record({"source": "x", "raw": {}}))
        self.assertTrue(is_empty_record({"source": "x", "title": None, "raw": None}))
        # Служебные поля модулей данных не заменяют.
        self.assertTrue(is_empty_record({"source": "x", "api": "avito", "credit_cost": 2}))
        self.assertTrue(is_empty_record(None))
        self.assertTrue(is_empty_record(42))
        # Не пусто: есть исходный объект или содержательное поле.
        self.assertFalse(is_empty_record({"source": "x", "raw": {"любое": 1}}))
        self.assertFalse(is_empty_record({"source": "x", "title": "ЖК"}))
        self.assertFalse(is_empty_record({"source": "x", "price": 0}))
        self.assertFalse(is_empty_record({"source": "x", "area": 44.5}))

    def test_all_empty_payload_is_empty_not_ok(self):
        """Все 7 скиллов на мусорном ответе не должны рапортовать ok."""
        payloads = {
            "mcp_market": {"companies": [{}]},
            "reefapi": {"ok": True, "data": {"items": [{}]}, "meta": {}},
            "rentcast": [{}],
            "zillapi": {"data": [{}]},
            "apify": [{}],
            "rentscout": {"items": [{}]},
            "mcp_rosreestr": {},
        }
        env = {k: "тест" for k in KEY_SKILLS.values()}
        env.update({"APIFY_ACTOR": "a/b", "MCP_ROSREESTR_URL": "http://127.0.0.1:9"})
        for name, payload in payloads.items():
            with self.subTest(skill=name):
                with mock.patch.dict(os.environ, env, clear=True):
                    with _patch_transport(json.dumps(payload)):
                        result = run_skill_result(name, "запрос")
                self.assertNotEqual(result["status"], STATUS_OK, f"{name}: ложный успех")
                self.assertEqual(result["records"], [], name)


class TestHonestFailures(unittest.TestCase):
    """Нет ключа и нет сервиса — это разные, честно названные состояния."""

    def test_no_key_never_reaches_network(self):
        for name, variable in KEY_SKILLS.items():
            with self.subTest(skill=name):
                env = {k: v for k, v in os.environ.items() if k != variable}
                seen: list = []
                with mock.patch.dict(os.environ, env, clear=True):
                    with _patch_transport("{}", seen):
                        result = run_skill_result(name, "москва")
                self.assertEqual(result["status"], STATUS_NO_KEY, name)
                self.assertEqual(result["records"], [], name)
                self.assertEqual(seen, [], f"{name}: ушёл в сеть без ключа")
                self.assertIn(variable, result["error"] or "", name)

    def test_apify_without_actor_is_not_deployed(self):
        with mock.patch.dict(os.environ, {"APIFY_TOKEN": "тест"}, clear=True):
            with _patch_transport("[]"):
                result = run_skill_result("apify", "запрос")
        self.assertEqual(result["status"], STATUS_NOT_DEPLOYED)
        self.assertEqual(result["records"], [])

    def test_mcp_rosreestr_without_url_is_not_deployed(self):
        env = {k: v for k, v in os.environ.items() if k != "MCP_ROSREESTR_URL"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_transport("{}"):
                result = run_skill_result("mcp_rosreestr", "77:01:0001001:1234")
        self.assertEqual(result["status"], STATUS_NOT_DEPLOYED)
        self.assertEqual(result["records"], [])
        self.assertIn("российск", (result["error"] or "").lower())

    def test_empty_query_returns_nothing(self):
        for name in ("mcp_market", "reefapi", "rentscout", "mcp_rosreestr", "apify", "rentcast", "zillapi"):
            with self.subTest(skill=name):
                seen: list = []
                with _patch_transport("{}", seen):
                    result = run_skill_result(name, "   ")
                self.assertEqual(result["records"], [], name)
                self.assertEqual(seen, [], f"{name}: ушёл в сеть на пустом запросе")


class TestTimeoutCeiling(unittest.TestCase):
    """Требование задания: таймаут не больше 10 секунд. Обойти нельзя ни env, ни аргументом."""

    def test_env_timeout_cannot_exceed_limit(self):
        for name, env in TIMEOUT_CASES:
            with self.subTest(skill=name):
                seen: list = []
                with mock.patch.dict(os.environ, env, clear=True):
                    with _patch_transport("{}", seen):
                        run_skill(name, "запрос")
                self.assertTrue(seen, f"{name}: запрос не дошёл до транспорта")
                self.assertLessEqual(max(item["timeout"] for item in seen), MAX_TIMEOUT, name)

    def test_argument_timeout_cannot_exceed_limit(self):
        for name in ("mcp_market", "reefapi", "rentscout", "mcp_rosreestr", "apify", "rentcast", "zillapi"):
            with self.subTest(skill=name):
                seen: list = []
                env = {k: "тест" for k in KEY_SKILLS.values()}
                env.update({"APIFY_ACTOR": "a/b", "MCP_ROSREESTR_URL": "http://127.0.0.1:9"})
                with mock.patch.dict(os.environ, env, clear=True):
                    with _patch_transport("{}", seen):
                        run_skill(name, "запрос", timeout=999)
                if seen:
                    self.assertLessEqual(max(item["timeout"] for item in seen), MAX_TIMEOUT, name)


class TestJournalAndResultShape(unittest.TestCase):
    """Журнал и форма ответа не должны зависеть от того, как упал скилл."""

    def test_journal_written_for_every_outcome(self):
        from skills.runtime import core as core_module

        journal = core_module.LOGS_DIR / "_test-adversarial.jsonl"
        try:
            with mock.patch.object(core_module, "RUN_LOG", journal):
                with _patch_transport("{}"):
                    run_skill("mcp_market", "запрос")
                with mock.patch.dict(os.environ, {}, clear=True):
                    with _patch_transport("{}"):
                        run_skill("reefapi", "запрос")
            lines = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(lines), 2)
            for entry in lines:
                for field in ("skill", "query", "status", "duration_ms", "count"):
                    self.assertIn(field, entry, entry)
        finally:
            journal.unlink(missing_ok=True)

    def test_result_shape_always_complete(self):
        for name in list(KEY_SKILLS) + ["mcp_market", "rentscout", "mcp_rosreestr"]:
            with self.subTest(skill=name):
                with mock.patch.dict(os.environ, {}, clear=True):
                    with _patch_transport("{}"):
                        result = run_skill_result(name, "запрос")
                for field in ("skill", "query", "status", "records", "error", "duration_ms"):
                    self.assertIn(field, result, name)
                self.assertIsInstance(result["records"], list, name)

    def test_undecorated_entry_does_not_break_run_skill(self):
        """Если в реестр попадёт функция без декоратора, агент всё равно не падает."""
        with mock.patch(
            "skills.runtime.registry.get_callable",
            return_value=lambda query, **kwargs: [{"source": "проба", "title": query}],
        ):
            result = run_skill_result("mcp_market", "запрос")
        self.assertEqual(len(result["records"]), 1)
        self.assertIn(result["status"], {STATUS_OK, STATUS_EMPTY})


if __name__ == "__main__":
    unittest.main(verbosity=2)
