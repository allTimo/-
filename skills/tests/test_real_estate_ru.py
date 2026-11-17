"""Тесты RU-источников: ``reefapi``, ``rentscout``, ``mcp_rosreestr``.

Только стандартная библиотека (unittest, без pytest). Сеть подменяется:
тесты патчат :func:`skills.runtime.http._transport` — единственную точку, где
модуль реально ходит в интернет, — и отдают заготовленный текст ответа.
Переменные окружения очищаются через ``mock.patch.dict(os.environ, {}, clear=True)``,
чтобы тесты не зависели от ключей на машине.

Запуск из каталога ``marketing-agents``::

    & $py -m unittest discover -s skills/tests -t . -v
"""

from __future__ import annotations

import json
import os
import unittest
import urllib.parse
from unittest import mock

if __package__ in (None, ""):  # прямой запуск файла: python skills/tests/test_real_estate_ru.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from skills.real_estate import mcp_rosreestr, reefapi, rentscout
from skills.runtime import (
    DEFAULT_TIMEOUT,
    STATUS_EMPTY,
    STATUS_ERROR,
    STATUS_NO_KEY,
    STATUS_NOT_DEPLOYED,
    STATUS_OK,
    SkillError,
    clamp_timeout,
)
from skills.runtime import http as runtime_http


class FakeTransport:
    """Подмена ``skills.runtime.http._transport``: заранее заданный ответ или сбой."""

    def __init__(self, body: str = "", error: Exception | None = None) -> None:
        self.body = body
        self.error = error
        self.calls: list[dict] = []

    def __call__(self, request, timeout: float) -> str:
        self.calls.append({"request": request, "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.body

    @property
    def last_request(self):
        """Последний запрос, который увидел транспорт."""
        return self.calls[-1]["request"]

    @property
    def last_timeout(self) -> float:
        """Таймаут последнего запроса."""
        return self.calls[-1]["timeout"]

    def url(self) -> str:
        """URL последнего запроса в раскодированном виде."""
        return urllib.parse.unquote(self.last_request.full_url)

    def headers(self) -> dict:
        """Заголовки последнего запроса в нижнем регистре."""
        return {str(key).lower(): value for key, value in self.last_request.headers.items()}


class TransportTestCase(unittest.TestCase):
    """Общая обвязка: очистка окружения и подмена транспорта."""

    def patch_transport(self, transport: FakeTransport) -> FakeTransport:
        """Заменить сетевой транспорт на ``transport`` до конца теста."""
        patcher = mock.patch.object(runtime_http, "_transport", transport)
        patcher.start()
        self.addCleanup(patcher.stop)
        return transport

    def clear_env(self, **values: str):
        """Очистить окружение и выставить только перечисленные переменные."""
        patcher = mock.patch.dict(os.environ, values, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        return patcher


# --- reefapi -----------------------------------------------------------------

REEFAPI_OK = json.dumps(
    {
        "ok": True,
        "data": {
            "items": [
                {
                    "id": "av-1",
                    "title": "2-к квартира, 54,3 м²",
                    "price": {"value": 12500000, "currency": "RUB"},
                    "area": 54.3,
                    "year_built": 2021,
                    "address": "Москва, ул. Тестовая, 1",
                    "url": "https://www.avito.ru/1",
                    "rooms": 2,
                }
            ]
        },
        "meta": {"credits": 2, "credits_left": 998},
        "error": None,
    },
    ensure_ascii=False,
)

REEFAPI_ERROR = json.dumps(
    {
        "ok": False,
        "data": None,
        "meta": {"credits": 0},
        "error": {"code": "insufficient_credits", "message": "кредиты закончились"},
    },
    ensure_ascii=False,
)

BROKEN_BODY = "{это не json"


class TestClampTimeout(unittest.TestCase):
    """Таймаут жёстко обрезается до 10 секунд — на уровне рантайма."""

    def test_clamp_above_max(self):
        self.assertEqual(clamp_timeout(99), 10.0)

    def test_clamp_none_uses_default(self):
        self.assertEqual(clamp_timeout(None), DEFAULT_TIMEOUT)

    def test_clamp_non_positive_uses_default(self):
        self.assertEqual(clamp_timeout(-5), DEFAULT_TIMEOUT)

    def test_clamp_keeps_small_value(self):
        self.assertEqual(clamp_timeout(2.5), 2.5)


class TestSkillMetadata(unittest.TestCase):
    """У каждого модуля есть SKILL с обязательными полями и декоратор на fetch."""

    REQUIRED = ("name", "title", "kind", "required_env", "free_tier", "docs")

    def test_modules_declare_skill_metadata(self):
        for module in (reefapi, rentscout, mcp_rosreestr):
            with self.subTest(module=module.SKILL_NAME):
                self.assertIsInstance(module.SKILL, dict)
                for key in self.REQUIRED:
                    self.assertIn(key, module.SKILL)
                self.assertEqual(module.SKILL["name"], module.SKILL_NAME)
                self.assertTrue(callable(module.fetch))
                self.assertTrue(hasattr(module.fetch, "last_run"))

    def test_default_timeouts_are_within_limit(self):
        for module in (reefapi, rentscout, mcp_rosreestr):
            with self.subTest(module=module.SKILL_NAME):
                self.assertLessEqual(module.DEFAULT_TIMEOUT, 10.0)


class TestReefApi(TransportTestCase):
    """ReefAPI: ключ, конверт ``ok``, кредиты, битый JSON."""

    def test_no_key_gives_empty_list_and_skipped_status(self):
        transport = self.patch_transport(FakeTransport("{}"))
        self.clear_env()  # REEFAPI_KEY отсутствует

        records = reefapi.fetch("2-к квартира в Москве")

        self.assertEqual(records, [])
        self.assertEqual(reefapi.fetch.last_run["status"], STATUS_NO_KEY)
        self.assertEqual(transport.calls, [], "без ключа запрос в сеть не уходит")

    def test_empty_query_short_circuits(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_OK))
        self.clear_env(REEFAPI_KEY="test-key")

        self.assertEqual(reefapi.fetch("   "), [])
        self.assertEqual(transport.calls, [])

    def test_success_parses_fields_and_credits(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_OK))
        self.clear_env(REEFAPI_KEY="test-key")

        records = reefapi.fetch("2-к квартира в Москве")

        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["source"], "reefapi")
        self.assertEqual(record["id"], "av-1")
        self.assertEqual(record["price"], 12500000)
        self.assertEqual(record["area"], 54.3)
        self.assertEqual(record["year_built"], 2021)
        self.assertEqual(record["address"], "Москва, ул. Тестовая, 1")
        self.assertEqual(record["url"], "https://www.avito.ru/1")
        self.assertEqual(record["credit_cost"], 2)
        self.assertEqual(record["api"], "avito")
        self.assertEqual(reefapi.fetch.last_run["status"], STATUS_OK)

        # запрос: POST на avito-эндпоинт, ключ в заголовке x-api-key
        self.assertEqual(transport.last_request.get_method(), "POST")
        self.assertIn("https://api.reefapi.com/avito/v1/search", transport.url())
        self.assertEqual(transport.headers().get("x-api-key"), "test-key")
        self.assertEqual(json.loads(transport.last_request.data.decode("utf-8"))["query"], "2-к квартира в Москве")

    def test_cian_api_switches_endpoint(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_OK))
        self.clear_env(REEFAPI_KEY="test-key")

        records = reefapi.fetch("новостройка", api="cian")

        self.assertEqual(len(records), 1)
        self.assertIn("https://api.reefapi.com/cian/v1/search", transport.url())
        self.assertEqual(records[0]["api"], "cian")

    def test_env_api_is_used_when_argument_empty(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_OK))
        self.clear_env(REEFAPI_KEY="test-key", REEFAPI_API="cian")

        reefapi.fetch("новостройка", api=None)

        self.assertIn("/cian/v1/search", transport.url())

    def test_unknown_api_gives_error_status(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_OK))
        self.clear_env(REEFAPI_KEY="test-key")

        records = reefapi.fetch("что-то", api="zillow")

        self.assertEqual(records, [])
        self.assertEqual(reefapi.fetch.last_run["status"], STATUS_ERROR)
        self.assertEqual(transport.calls, [])

    def test_ok_false_gives_empty_list(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_ERROR))
        self.clear_env(REEFAPI_KEY="test-key")

        records = reefapi.fetch("2-к квартира")

        self.assertEqual(records, [])
        self.assertEqual(reefapi.fetch.last_run["status"], STATUS_EMPTY)
        self.assertEqual(len(transport.calls), 1)

    def test_broken_json_gives_empty_list_and_error_status(self):
        self.patch_transport(FakeTransport(BROKEN_BODY))
        self.clear_env(REEFAPI_KEY="test-key")

        records = reefapi.fetch("2-к квартира")

        self.assertEqual(records, [])
        self.assertEqual(reefapi.fetch.last_run["status"], STATUS_ERROR)
        self.assertIn("JSON", reefapi.fetch.last_run.get("error", ""))

    def test_timeout_is_clamped_in_request(self):
        transport = self.patch_transport(FakeTransport(REEFAPI_OK))
        self.clear_env(REEFAPI_KEY="test-key")

        reefapi.fetch("2-к квартира", timeout=99)

        self.assertEqual(transport.last_timeout, 10.0)


# --- rentscout ----------------------------------------------------------------

RENTSCOUT_OK = json.dumps(
    {
        "items": [
            {
                "id": 7,
                "title": "Сдам 1-к квартиру, 38,5 м²",
                "price": 65000,
                "area": 38.5,
                "year_built": 2019,
                "address": "Москва, Ленинский пр-т, 10",
                "url": "http://127.0.0.1:8000/items/7",
                "source": "avito",
                "rooms": 1,
            }
        ]
    },
    ensure_ascii=False,
)


class TestRentScout(TransportTestCase):
    """RentScout: локальный сервис, отсутствие развёртывания, битый JSON."""

    def test_success_parses_fields(self):
        transport = self.patch_transport(FakeTransport(RENTSCOUT_OK))
        self.clear_env()

        records = rentscout.fetch("снять однушку в Москве")

        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["source"], "rentscout")
        self.assertEqual(record["price"], 65000)
        self.assertEqual(record["area"], 38.5)
        self.assertEqual(record["year_built"], 2019)
        self.assertEqual(record["address"], "Москва, Ленинский пр-т, 10")
        self.assertEqual(record["listing_source"], "avito")
        self.assertEqual(rentscout.fetch.last_run["status"], STATUS_OK)

        # база по умолчанию — локальный порт, запрос GET с q и sources
        self.assertIn("http://127.0.0.1:8000/search", transport.url())
        self.assertIn("q=", transport.url())
        self.assertEqual(transport.last_request.get_method(), "GET")

    def test_sources_come_from_env_and_argument(self):
        transport = self.patch_transport(FakeTransport(RENTSCOUT_OK))
        self.clear_env(RENTSCOUT_SOURCES="avito,cian")

        rentscout.fetch("снять квартиру")
        self.assertIn("sources=avito,cian", transport.url())

        rentscout.fetch("снять квартиру", sources=["domclick"])
        self.assertIn("sources=domclick", transport.url())

    def test_base_url_from_env(self):
        transport = self.patch_transport(FakeTransport(RENTSCOUT_OK))
        self.clear_env(RENTSCOUT_URL="http://127.0.0.1:9001/")

        rentscout.fetch("снять квартиру")

        self.assertIn("http://127.0.0.1:9001/search", transport.url())

    def test_service_down_gives_not_deployed_with_explanation(self):
        error = SkillError("сеть недоступна для http://127.0.0.1:8000/search: [Errno 61] Connection refused")
        self.patch_transport(FakeTransport(error=error))
        self.clear_env()

        records = rentscout.fetch("снять однушку в Москве")

        self.assertEqual(records, [])
        self.assertEqual(rentscout.fetch.last_run["status"], STATUS_NOT_DEPLOYED)
        reason = rentscout.fetch.last_run.get("error", "")
        self.assertIn("RentScout не развёрнут", reason)
        self.assertIn("RENTSCOUT_URL", reason)  # как поднять
        self.assertIn("не подтверждён", reason.lower())  # источники не подтверждены

    def test_broken_json_gives_error_status(self):
        self.patch_transport(FakeTransport(BROKEN_BODY))
        self.clear_env()

        records = rentscout.fetch("снять однушку")

        self.assertEqual(records, [])
        self.assertEqual(rentscout.fetch.last_run["status"], STATUS_ERROR)

    def test_empty_query_short_circuits(self):
        transport = self.patch_transport(FakeTransport(RENTSCOUT_OK))
        self.clear_env()

        self.assertEqual(rentscout.fetch(""), [])
        self.assertEqual(transport.calls, [])

    def test_timeout_from_env_is_clamped(self):
        transport = self.patch_transport(FakeTransport(RENTSCOUT_OK))
        self.clear_env(RENTSCOUT_TIMEOUT="99")

        rentscout.fetch("снять квартиру")

        self.assertEqual(transport.last_timeout, 10.0)


# --- mcp_rosreestr ------------------------------------------------------------

ROSREESTR_RU = json.dumps(
    {
        "ok": True,
        "data": {
            "кадастровый номер": "77:01:0001001:1001",
            "адрес": "г. Москва, ул. Примерная, д. 5",
            "площадь": 72.4,
            "год постройки": 2005,
            "кадастровая стоимость": 15340000.5,
        },
    },
    ensure_ascii=False,
)

ROSREESTR_EN = json.dumps(
    {
        "result": {
            "cadastral_number": "50:20:0010338:1234",
            "address": "Московская обл., г. Одинцово, ул. Садовая, 3",
            "area": 91.7,
            "year_built": 1998,
            "cadastral_cost": 8900000,
        }
    },
    ensure_ascii=False,
)


class TestMcpRosreestr(TransportTestCase):
    """Росреестр: нет URL -> not_deployed, есть URL -> нормализация полей."""

    def test_no_url_gives_not_deployed_with_explanation(self):
        transport = self.patch_transport(FakeTransport(ROSREESTR_RU))
        self.clear_env()  # MCP_ROSREESTR_URL отсутствует

        records = mcp_rosreestr.fetch("77:01:0001001:1001")

        self.assertEqual(records, [])
        self.assertEqual(mcp_rosreestr.fetch.last_run["status"], STATUS_NOT_DEPLOYED)
        reason = mcp_rosreestr.fetch.last_run.get("error", "")
        self.assertIn("MCP_ROSREESTR_URL", reason)
        self.assertIn("российским IP", reason)
        self.assertIn("MIT", reason)  # команда установки описана
        self.assertEqual(transport.calls, [])

    def test_success_normalizes_russian_keys(self):
        transport = self.patch_transport(FakeTransport(ROSREESTR_RU))
        self.clear_env(MCP_ROSREESTR_URL="http://127.0.0.1:8765")

        records = mcp_rosreestr.fetch("77:01:0001001:1001")

        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["source"], "mcp_rosreestr")
        self.assertEqual(record["id"], "77:01:0001001:1001")
        self.assertEqual(record["address"], "г. Москва, ул. Примерная, д. 5")
        self.assertEqual(record["area"], 72.4)
        self.assertEqual(record["year_built"], 2005)
        self.assertEqual(record["price"], 15340000.5)
        self.assertEqual(record["cadastral_cost"], 15340000.5)
        self.assertEqual(mcp_rosreestr.fetch.last_run["status"], STATUS_OK)

        self.assertIn("http://127.0.0.1:8765", transport.url())
        self.assertIn("77:01:0001001:1001", transport.url())

    def test_success_normalizes_english_keys(self):
        self.patch_transport(FakeTransport(ROSREESTR_EN))
        self.clear_env(MCP_ROSREESTR_URL="http://127.0.0.1:8765")

        records = mcp_rosreestr.fetch("50:20:0010338:1234")

        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["id"], "50:20:0010338:1234")
        self.assertEqual(record["area"], 91.7)
        self.assertEqual(record["year_built"], 1998)
        self.assertEqual(record["price"], 8900000)
        self.assertEqual(record["address"], "Московская обл., г. Одинцово, ул. Садовая, 3")

    def test_missing_fields_stay_none(self):
        body = json.dumps({"data": {"кадастровый номер": "77:01:0001001:1001"}}, ensure_ascii=False)
        self.patch_transport(FakeTransport(body))
        self.clear_env(MCP_ROSREESTR_URL="http://127.0.0.1:8765")

        record = mcp_rosreestr.fetch("77:01:0001001:1001")[0]

        self.assertIsNone(record["area"])
        self.assertIsNone(record["year_built"])
        self.assertIsNone(record["price"])
        self.assertIsNone(record["address"])

    def test_broken_json_gives_error_status(self):
        self.patch_transport(FakeTransport(BROKEN_BODY))
        self.clear_env(MCP_ROSREESTR_URL="http://127.0.0.1:8765")

        records = mcp_rosreestr.fetch("77:01:0001001:1001")

        self.assertEqual(records, [])
        self.assertEqual(mcp_rosreestr.fetch.last_run["status"], STATUS_ERROR)

    def test_empty_query_short_circuits(self):
        transport = self.patch_transport(FakeTransport(ROSREESTR_RU))
        self.clear_env(MCP_ROSREESTR_URL="http://127.0.0.1:8765")

        self.assertEqual(mcp_rosreestr.fetch(""), [])
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":  # прямой запуск: python skills/tests/test_real_estate_ru.py
    unittest.main(verbosity=2)
