"""Тесты скилла ``yandex_direct`` (Яндекс.Директ API v5).

Сеть не используется: транспорт подменяется (``skills.runtime.http._transport``
для API и ``skills.direct_api.client._transport_status`` для Reports, которому
нужен HTTP-код). Проверяются честные режимы отказа: нет токена — ``skipped_no_key``
и ни одного запроса в сеть; HTTP-ошибка — ``error`` и пустой список;
Reports 201/202 — ``pending``, а не выдуманный отчёт; таймаут нельзя поднять ни
аргументом, ни переменной окружения (предел — 10 секунд).
"""

from __future__ import annotations

import io
import json
import os
import unittest
import urllib.request
from contextlib import redirect_stdout
from unittest import mock

import skills.runtime.http as http_mod
from skills.direct_api import client as direct
from skills.runtime import (
    MAX_TIMEOUT,
    STATUS_ERROR,
    STATUS_NO_KEY,
    STATUS_OK,
    SkillError,
    run_skill_result,
)

CAMPAIGNS_PAYLOAD = {
    "result": {
        "Campaigns": [
            {
                "Id": 12345678,
                "Name": "Новостройки Москва — поиск",
                "Type": "TEXT_CAMPAIGN",
                "State": "ON",
                "Status": "ACCEPTED",
            },
            {
                "Id": 87654321,
                "Name": "РСЯ — ретаргетинг",
                "Type": "TEXT_CAMPAIGN",
                "State": "SUSPENDED",
                "Status": "ACCEPTED",
            },
        ]
    }
}


def _patch_transport(payload: str = "", seen: list | None = None, error: Exception | None = None):
    """Подменить транспорт рантайма; при желании запомнить, что ушло в «сеть»."""

    def fake(request, timeout):
        if seen is not None:
            seen.append(
                {
                    "url": request.full_url,
                    "timeout": timeout,
                    "method": request.get_method(),
                    "headers": {key.lower(): value for key, value in request.header_items()},
                    "body": json.loads(request.data.decode("utf-8")) if request.data else None,
                }
            )
        if error is not None:
            raise error
        return payload

    return mock.patch.object(http_mod, "_transport", fake)


def _patch_status_transport(status: int, payload: str = "", seen: list | None = None):
    """Подменить транспорт Reports, отдающий HTTP-код (201/202/200)."""

    def fake(request, timeout):
        if seen is not None:
            seen.append({"url": request.full_url, "timeout": timeout, "status": status})
        return status, payload

    return mock.patch.object(direct, "_transport_status", fake)


def _no_env_file():
    """Не читать настоящий ``.env``: тест не должен зависеть от файла на машине."""
    return mock.patch.object(direct, "load_env_file", lambda path=None: 0)


class TestNoKey(unittest.TestCase):
    """Нет токена — не сбой: предупреждение, пустой список, ни одного запроса."""

    def test_missing_token_skips_without_network(self):
        seen: list = []
        with mock.patch.dict(os.environ, {}, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                    result = run_skill_result("yandex_direct", "campaigns")
        self.assertEqual(result["status"], STATUS_NO_KEY)
        self.assertEqual(result["records"], [])
        self.assertEqual(seen, [], "без токена ушли в сеть")
        self.assertIn("YANDEX_OAUTH_TOKEN", result["error"] or "")

    def test_no_key_message_is_panel_ready(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with _no_env_file():
                report = direct.check_access()
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], STATUS_NO_KEY)
        self.assertEqual(report["message"], direct.NO_TOKEN_MESSAGE)
        self.assertIsNone(report["campaigns"])
        self.assertIsNone(report["campaigns_count"])
        self.assertFalse(report["sandbox"])
        self.assertIsNone(report["clientLogin"])
        self.assertGreaterEqual(report["elapsed"], 0)

    def test_blank_query_returns_empty_before_any_check(self):
        """Пустой запрос — ранний выход: даже без токена это не ошибка."""
        seen: list = []
        with mock.patch.dict(os.environ, {}, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                    result = run_skill_result("yandex_direct", "   ")
        self.assertEqual(result["records"], [])
        self.assertEqual(seen, [])


class TestCampaigns(unittest.TestCase):
    """Успешный ``Campaigns.get`` даёт записи с id/name/state и raw."""

    def test_successful_campaigns_get(self):
        seen: list = []
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                result = run_skill_result("yandex_direct", "campaigns")
        records = result["records"]
        self.assertEqual(result["status"], STATUS_OK)
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["id"], 12345678)
        self.assertEqual(records[0]["name"], "Новостройки Москва — поиск")
        self.assertEqual(records[0]["title"], "Новостройки Москва — поиск")
        self.assertEqual(records[0]["state"], "ON")
        self.assertEqual(records[1]["state"], "SUSPENDED")
        self.assertEqual(records[0]["type"], "TEXT_CAMPAIGN")
        self.assertEqual(records[0]["status"], "ACCEPTED")
        self.assertEqual(records[0]["source"], "yandex_direct")
        self.assertEqual(records[0]["raw"]["Id"], 12345678)
        self.assertIsNone(records[0]["price"], "цена лота здесь не выдумывается")

        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0]["url"].startswith("https://api.direct.yandex.com/json/v5/campaigns"))
        self.assertEqual(seen[0]["method"], "POST")
        self.assertEqual(seen[0]["body"]["method"], "get")
        self.assertIn("Id", seen[0]["body"]["params"]["FieldNames"])

    def test_unknown_query_is_error_not_silence(self):
        seen: list = []
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                result = run_skill_result("yandex_direct", "clients")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)
        self.assertIn("clients", result["error"] or "")
        self.assertEqual(seen, [], "неизвестный запрос не должен уходить в сеть")

    def test_api_error_envelope_gives_error(self):
        payload = {"error": {"error_code": "53", "error_string": "Нет прав", "error_detail": "token"}}
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(json.dumps(payload)):
                result = run_skill_result("yandex_direct", "campaigns")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)
        self.assertIn("53", result["error"] or "")

    def test_response_without_campaigns_is_error(self):
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(json.dumps({"result": {}})):
                result = run_skill_result("yandex_direct", "campaigns")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)

    def test_check_access_reports_campaign_count(self):
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD)):
                    report = direct.check_access()
        self.assertTrue(report["ok"])
        self.assertEqual(report["status"], STATUS_OK)
        self.assertEqual(report["campaigns_count"], 2)
        self.assertEqual(report["campaigns"], 2)
        self.assertIn("2", report["message"])


class TestHeaders(unittest.TestCase):
    """``Client-Login`` уходит только когда логин клиента реально задан."""

    def test_client_login_header_only_when_set(self):
        for env, expected in (
            ({direct.TOKEN_ENV: "тест-токен"}, None),
            ({direct.TOKEN_ENV: "тест-токен", direct.CLIENT_LOGIN_ENV: "client-login"}, "client-login"),
        ):
            with self.subTest(env=sorted(env)):
                seen: list = []
                with mock.patch.dict(os.environ, env, clear=True):
                    with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                        direct.fetch("campaigns")
                headers = seen[0]["headers"]
                self.assertEqual(headers.get("authorization"), "Bearer тест-токен")
                self.assertEqual(headers.get("accept-language"), "ru")
                self.assertEqual(headers.get("client-login"), expected)

    def test_blank_client_login_is_not_sent(self):
        seen: list = []
        env = {direct.TOKEN_ENV: "тест-токен", direct.CLIENT_LOGIN_ENV: "   "}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                direct.fetch("campaigns")
        self.assertNotIn("client-login", seen[0]["headers"])


class TestSandbox(unittest.TestCase):
    """Песочница меняет хост, боевой режим остаётся по умолчанию."""

    def test_sandbox_switches_host(self):
        cases = (
            ({direct.TOKEN_ENV: "тест-токен"}, "https://api.direct.yandex.com/json/v5/campaigns"),
            (
                {direct.TOKEN_ENV: "тест-токен", direct.SANDBOX_ENV: "1"},
                "https://api-sandbox.direct.yandex.com/json/v5/campaigns",
            ),
            (
                {direct.TOKEN_ENV: "тест-токен", direct.SANDBOX_ENV: "true"},
                "https://api-sandbox.direct.yandex.com/json/v5/campaigns",
            ),
        )
        for env, expected_url in cases:
            with self.subTest(sandbox=env.get(direct.SANDBOX_ENV)):
                seen: list = []
                with mock.patch.dict(os.environ, env, clear=True):
                    with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                        direct.fetch("campaigns")
                self.assertTrue(seen[0]["url"].startswith(expected_url))
        self.assertFalse(direct.is_sandbox("0"))
        self.assertTrue(direct.is_sandbox("ДА"))

    def test_sandbox_flag_is_reported_to_panel(self):
        env = {direct.TOKEN_ENV: "тест-токен", direct.SANDBOX_ENV: "1"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD)):
                    report = direct.check_access()
        self.assertTrue(report["sandbox"])
        self.assertTrue(report["ok"])


class TestFailures(unittest.TestCase):
    """Сеть и разбор упали — статус ``error`` и пустой список, без исключений наружу."""

    def test_http_500_gives_error_and_empty_list(self):
        error = SkillError("HTTP 500 Internal Server Error для https://api.direct.yandex.com; ответ: ")
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(error=error):
                result = run_skill_result("yandex_direct", "campaigns")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)
        self.assertIn("500", result["error"] or "")

    def test_broken_json_gives_error(self):
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport("<html>не json</html>"):
                result = run_skill_result("yandex_direct", "campaigns")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["status"], STATUS_ERROR)


class TestTimeout(unittest.TestCase):
    """Требование задания: таймаут не больше 10 секунд. Аргументом не поднять."""

    def test_argument_timeout_cannot_exceed_limit(self):
        for requested in (999, 10.5, 30):
            with self.subTest(timeout=requested):
                seen: list = []
                with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
                    with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                        direct.fetch("campaigns", timeout=requested)
                self.assertTrue(seen)
                self.assertLessEqual(seen[0]["timeout"], MAX_TIMEOUT)

    def test_default_and_small_timeout(self):
        seen: list = []
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                direct.fetch("campaigns")
        self.assertLessEqual(seen[0]["timeout"], MAX_TIMEOUT)

        seen.clear()
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                direct.get_campaigns(timeout=3)
        self.assertEqual(seen[0]["timeout"], 3.0)

    def test_report_timeout_cannot_exceed_limit(self):
        seen: list = []
        env = {direct.TOKEN_ENV: "тест-токен"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_status_transport(200, "Date\tClicks\n2026-11-01\t5", seen):
                direct.get_report("2026-11-01", "2026-11-07", timeout=999)
        self.assertTrue(seen)
        self.assertLessEqual(seen[0]["timeout"], MAX_TIMEOUT)


class TestReports(unittest.TestCase):
    """Reports асинхронный: 201/202 — «готовится», 200 — готовый TSV."""

    def test_report_201_is_pending(self):
        env = {direct.TOKEN_ENV: "тест-токен"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_status_transport(201, ""):
                report = direct.get_report("2026-11-01", "2026-11-07")
        self.assertEqual(report["status"], "pending")
        self.assertIn("готовится", report["message"])
        self.assertNotIn("tsv", report)

    def test_report_202_is_pending(self):
        env = {direct.TOKEN_ENV: "тест-токен"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_status_transport(202, ""):
                report = direct.get_report("2026-11-01", "2026-11-07")
        self.assertEqual(report["status"], "pending")

    def test_report_empty_body_on_mocked_transport_is_pending(self):
        """Тесты подменяют ``_transport`` (без кода): пустое тело = отчёт готовится."""

        def fake(request, timeout):
            return "   "

        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with mock.patch.object(http_mod, "_transport", fake):
                report = direct.get_report("2026-11-01", "2026-11-07")
        self.assertEqual(report["status"], "pending")

    def test_report_200_returns_tsv(self):
        tsv = "Date\tCampaignId\tClicks\n2026-11-01\t12345678\t5\n"
        env = {direct.TOKEN_ENV: "тест-токен"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_status_transport(200, tsv):
                report = direct.get_report("2026-11-01", "2026-11-07")
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["tsv"], tsv)

    def test_report_request_body_and_headers(self):
        captured: list = []

        def fake_status(request, timeout):
            captured.append(
                {
                    "url": request.full_url,
                    "headers": {key.lower(): value for key, value in request.header_items()},
                    "body": json.loads(request.data.decode("utf-8")),
                }
            )
            return 200, "header\nrow"

        env = {direct.TOKEN_ENV: "тест-токен", direct.CLIENT_LOGIN_ENV: "client-login"}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(direct, "_transport_status", fake_status):
                direct.get_report("2026-11-01", "2026-11-07")
        self.assertEqual(captured[0]["url"], direct.REPORTS_URL)
        self.assertEqual(captured[0]["headers"]["client-login"], "client-login")
        self.assertEqual(captured[0]["headers"]["authorization"], "Bearer тест-токен")
        params = captured[0]["body"]["params"]
        self.assertEqual(params["DateRangeType"], "CUSTOM_DATE")
        self.assertEqual(params["Format"], "TSV")
        self.assertEqual(params["SelectionCriteria"]["DateFrom"], "2026-11-01")
        self.assertEqual(params["SelectionCriteria"]["DateTo"], "2026-11-07")

    def test_report_in_sandbox_is_honest_error(self):
        seen: list = []
        env = {direct.TOKEN_ENV: "тест-токен", direct.SANDBOX_ENV: "1"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _patch_status_transport(200, "tsv", seen):
                report = direct.get_report("2026-11-01", "2026-11-07")
        self.assertEqual(report["status"], "error")
        self.assertIn("песочниц", report["message"])
        self.assertEqual(seen, [], "в песочнице Reports не должен уходить в сеть")

    def test_report_bad_date_is_error_without_network(self):
        seen: list = []
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _patch_status_transport(200, "tsv", seen):
                report = direct.get_report("01.11.2026", "07.11.2026")
        self.assertEqual(report["status"], "error")
        self.assertIn("ГГГГ-ММ-ДД", report["message"])
        self.assertEqual(seen, [])

    def test_transport_status_delegates_to_patched_transport(self):
        """Если транспорт подменён, код неизвестен (0) — решение по телу ответа."""
        with _patch_transport("тело"):
            status, body = direct._transport_status(
                urllib.request.Request("https://example.invalid"),
                1.0,
            )
        self.assertEqual((status, body), (0, "тело"))


class TestCli(unittest.TestCase):
    """CLI панели: один JSON-объект и честный код возврата."""

    def _run_cli(self, argv: list[str]) -> tuple[int, str]:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = direct.main(argv)
        return code, buffer.getvalue()

    def test_cli_json_without_token_exits_zero(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with _no_env_file():
                code, out = self._run_cli(["--check", "--json"])
        payload = json.loads(out.strip())
        self.assertEqual(code, 0, "отсутствие токена — не сбой")
        self.assertEqual(
            sorted(payload),
            ["campaigns", "clientLogin", "message", "ok", "sandbox", "status"],
        )
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], STATUS_NO_KEY)
        self.assertEqual(payload["message"], direct.NO_TOKEN_MESSAGE)
        self.assertIsNone(payload["campaigns"])
        self.assertIsNone(payload["clientLogin"])
        self.assertFalse(payload["sandbox"])

    def test_cli_json_ok_reports_campaigns(self):
        env = {direct.TOKEN_ENV: "тест-токен"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD)):
                    code, out = self._run_cli(["--check", "--json"])
        payload = json.loads(out.strip())
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], STATUS_OK)
        self.assertEqual(payload["campaigns"], 2)

    def test_cli_json_error_exits_one(self):
        error = SkillError("HTTP 500 Internal Server Error")
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "тест-токен"}, clear=True):
            with _no_env_file():
                with _patch_transport(error=error):
                    code, out = self._run_cli(["--check", "--json"])
        payload = json.loads(out.strip())
        self.assertEqual(code, 1)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], STATUS_ERROR)
        self.assertIn("500", payload["message"])
        self.assertIsNone(payload["campaigns"])

    def test_cli_human_output(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with _no_env_file():
                code, out = self._run_cli(["--check"])
        self.assertEqual(code, 0)
        self.assertIn("Яндекс.Директ API v5", out)
        self.assertIn(direct.NO_TOKEN_MESSAGE, out)

    def test_cli_without_arguments_prints_help(self):
        code, out = self._run_cli([])
        self.assertEqual(code, 2)
        self.assertIn("--check", out)


class TestSecretsContract(unittest.TestCase):
    """Инструкция по секретам (10.11.2026): токен — из ``YANDEX_OAUTH_TOKEN``,
    устаревшее ``YANDEX_DIRECT_TOKEN`` — только запасной вариант; Метрика — ``Authorization: OAuth``."""

    def test_oauth_token_env_is_primary(self):
        seen: list = []
        env = {direct.TOKEN_ENV: "токен-основной", direct.LEGACY_TOKEN_ENV: "токен-старый"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                    records = direct.get_campaigns()
        self.assertEqual(len(records), 2)
        self.assertEqual(seen[0]["headers"]["authorization"], "Bearer токен-основной")

    def test_legacy_token_env_is_fallback(self):
        seen: list = []
        with mock.patch.dict(os.environ, {direct.LEGACY_TOKEN_ENV: "токен-старый"}, clear=True):
            with _no_env_file():
                with _patch_transport(json.dumps(CAMPAIGNS_PAYLOAD), seen):
                    direct.get_campaigns()
        self.assertEqual(seen[0]["headers"]["authorization"], "Bearer токен-старый")

    def test_metrika_headers_use_oauth_scheme(self):
        headers = direct.build_metrika_headers("токен-метрики")
        self.assertEqual(headers["Authorization"], "OAuth токен-метрики")

    def test_metrika_headers_fall_back_to_oauth_token(self):
        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "токен-основной"}, clear=True):
            headers = direct.build_metrika_headers()
        self.assertEqual(headers["Authorization"], "OAuth токен-основной")

    def test_metrika_counter_requires_id(self):
        from skills.runtime import SkillSkipped

        with mock.patch.dict(os.environ, {direct.TOKEN_ENV: "т"}, clear=True):
            with _no_env_file():
                with self.assertRaises(SkillSkipped):
                    direct.get_metrika_counter()

    def test_metrika_counter_request_and_parsing(self):
        seen: list = []
        payload = json.dumps({"counter": {"id": 12345, "name": "Свет", "site": "svetdom.ru"}})
        env = {direct.TOKEN_ENV: "токен-основной", direct.METRIKA_COUNTER_ENV: "12345"}
        with mock.patch.dict(os.environ, env, clear=True):
            with _no_env_file():
                with _patch_transport(payload, seen):
                    counter = direct.get_metrika_counter()
        self.assertEqual(counter["id"], 12345)
        self.assertEqual(counter["name"], "Свет")
        self.assertIn("/management/v1/counter/12345", seen[0]["url"])
        self.assertTrue(seen[0]["url"].startswith("https://api-metrika.yandex.net"))
        self.assertEqual(seen[0]["headers"]["authorization"], "OAuth токен-основной")
        self.assertEqual(seen[0]["method"], "GET")


class TestMetrikaReport(unittest.TestCase):
    """Отчёт Метрики: цели и статистика; пустой трафик — честное «данных нет»."""

    ENV = {direct.TOKEN_ENV: "токен", direct.METRIKA_COUNTER_ENV: "123"}

    def test_goals_parsed(self):
        seen: list = []
        payload = json.dumps({"goals": [{"id": 1, "name": "Заявка", "type": "action"}]})
        with mock.patch.dict(os.environ, self.ENV, clear=True):
            with _no_env_file():
                with _patch_transport(payload, seen):
                    goals = direct.get_metrika_goals()
        self.assertEqual(goals, [{"id": 1, "name": "Заявка", "type": "action"}])
        self.assertIn("/counter/123/goals", seen[0]["url"])
        self.assertTrue(seen[0]["url"].startswith("https://api-metrika.yandex.net"))

    def test_stat_request_and_empty_data(self):
        seen: list = []
        payload = json.dumps(
            {"totals": [0, 0], "data": [], "query": {"date1": "2026-11-01", "date2": "2026-11-10"}}
        )
        with mock.patch.dict(os.environ, self.ENV, clear=True):
            with _no_env_file():
                with _patch_transport(payload, seen):
                    stat = direct.get_metrika_stat(date1="2026-11-01", date2="2026-11-10")
        url = seen[0]["url"]
        self.assertIn("/stat/v1/data?", url)
        self.assertIn("ids=123", url)
        self.assertIn("date1=2026-11-01", url)
        self.assertFalse(stat["has_data"])
        self.assertEqual(stat["rows"], [])

    def test_stat_with_data(self):
        payload = json.dumps(
            {"totals": [5, 3], "data": [{"dimensions": ["2026-11-10"], "metrics": [5, 3]}]}
        )
        with mock.patch.dict(os.environ, self.ENV, clear=True):
            with _no_env_file():
                with _patch_transport(payload):
                    stat = direct.get_metrika_stat(date1="2026-11-10", date2="2026-11-10")
        self.assertTrue(stat["has_data"])
        self.assertEqual(len(stat["rows"]), 1)
        self.assertEqual(stat["rows"][0]["dims"], ["2026-11-10"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
