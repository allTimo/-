"""Тесты скиллов US-источников: ``apify``, ``rentcast``, ``zillapi`` (stdlib unittest).

pytest в проекте не используется. В сеть тесты не ходят: подменяется точка
``skills.runtime.http._transport`` (сигнатура ``(request, timeout) -> str``),
поэтому проверяется и сам HTTP-запрос — метод, URL, тело и заголовок
авторизации.

Запуск из каталога ``marketing-agents``::

    python -m unittest discover -s skills/tests -t . -v

Журнал скиллов на время тестов уводится во временный каталог, чтобы прогон не
писал в ``skills/logs/skill-runs.jsonl``.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from skills.real_estate import apify, rentcast, zillapi  # noqa: E402
from skills.runtime import (  # noqa: E402
    STATUS_ERROR,
    STATUS_NO_KEY,
    STATUS_NOT_DEPLOYED,
    STATUS_OK,
)

TRANSPORT = "skills.runtime.http._transport"

_patchers: list[Any] = []
_tmp_logs: Path | None = None


def setUpModule() -> None:
    """Увести журнал скиллов во временный каталог."""
    global _tmp_logs
    _tmp_logs = Path(tempfile.mkdtemp(prefix="skills-tests-"))
    _patchers.extend(
        [
            mock.patch("skills.runtime.core.LOGS_DIR", _tmp_logs),
            mock.patch("skills.runtime.core.RUN_LOG", _tmp_logs / "skill-runs.jsonl"),
        ]
    )
    for patcher in _patchers:
        patcher.start()


def tearDownModule() -> None:
    """Вернуть журнал на место и прибрать временный каталог.

    Уборка — «по возможности»: в песочнице Windows удаление каталога вне
    рабочей области может получить отказ в доступе, и тесты из-за этого
    падать не должны.
    """
    global _tmp_logs
    for patcher in _patchers:
        patcher.stop()
    _patchers.clear()
    if _tmp_logs is not None:
        try:
            shutil.rmtree(_tmp_logs, ignore_errors=True)
        except OSError:  # noqa: BLE001 — мусор в temp не повод падать
            pass
        _tmp_logs = None


class MockTransport:
    """Подмена ``_transport``: отдаёт заготовленные ответы и хранит запросы."""

    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.requests: list[Any] = []
        self.timeouts: list[float] = []

    def __call__(self, request: Any, timeout: float) -> str:
        self.requests.append(request)
        self.timeouts.append(timeout)
        if not self.responses:
            raise AssertionError("мок-транспорт вызван без заготовленного ответа")
        response = (
            self.responses[0] if len(self.responses) == 1 else self.responses.pop(0)
        )
        if isinstance(response, Exception):
            raise response
        return response

    def body(self, index: int = 0) -> Any:
        """Тело запроса, разобранное из JSON."""
        return json.loads(self.requests[index].data.decode("utf-8"))

    def header(self, name: str, index: int = 0) -> str | None:
        """Заголовок запроса без учёта регистра (urllib его нормализует)."""
        for key, value in self.requests[index].headers.items():
            if key.lower() == name.lower():
                return value
        return None

    def url(self, index: int = 0) -> str:
        """Полный URL запроса вместе с query-строкой."""
        return self.requests[index].full_url


class SkillTestCase(unittest.TestCase):
    """Общая обвязка: чистое окружение плюс мок-транспорт."""

    def call(
        self,
        func: Callable[..., list[dict]],
        *args: Any,
        env: dict[str, str] | None = None,
        responses: tuple[Any, ...] = (),
        **kwargs: Any,
    ) -> tuple[list[dict], MockTransport]:
        """Вызвать ``fetch`` с пустым окружением и подменённым транспортом."""
        transport = MockTransport(*responses)
        with (
            mock.patch.dict(os.environ, env or {}, clear=True),
            mock.patch(TRANSPORT, transport),
        ):
            records = func(*args, **kwargs)
        return records, transport

    @staticmethod
    def status(func: Callable[..., list[dict]]) -> str:
        """Статус последнего прогона, записанный декоратором ``@skill``."""
        last_run = getattr(func, "last_run", None) or {}
        return last_run.get("status", "")


class ApifyTests(SkillTestCase):
    """Скилл ``apify``: запуск актора, авторизация, разбор датасета."""

    DATASET = json.dumps(
        [
            {
                "id": "a1",
                "title": "Дом в Остине",
                "price": "$450,000",
                "address": "1 Main St, Austin, TX",
                "url": "https://example.test/a1",
                "zpid": "z-a1",
                "livingArea": 120,
                "yearBuilt": 1999,
            },
            "мусор",  # не объект — должен быть отброшен
        ],
        ensure_ascii=False,
    )
    ENV = {"APIFY_TOKEN": "tok-123", "APIFY_ACTOR": "apify~zillow-scraper"}

    def test_no_key_is_skipped(self) -> None:
        records, transport = self.call(apify.fetch, "Austin", env={})
        self.assertEqual(records, [])
        self.assertEqual(self.status(apify.fetch), STATUS_NO_KEY)
        self.assertEqual(transport.requests, [])

    def test_actor_not_configured(self) -> None:
        records, transport = self.call(
            apify.fetch, "Austin", env={"APIFY_TOKEN": "tok-123"}
        )
        self.assertEqual(records, [])
        self.assertEqual(self.status(apify.fetch), STATUS_NOT_DEPLOYED)
        self.assertEqual(transport.requests, [])

    def test_success_records_and_request(self) -> None:
        records, transport = self.call(
            apify.fetch, "Austin", env=self.ENV, responses=(self.DATASET,)
        )
        self.assertEqual(self.status(apify.fetch), STATUS_OK)
        self.assertEqual(len(records), 1)

        record = records[0]
        self.assertEqual(record["source"], "apify")
        self.assertEqual(record["id"], "a1")
        self.assertEqual(record["title"], "Дом в Остине")
        self.assertEqual(record["price"], 450000)
        self.assertEqual(record["area"], 120)
        self.assertEqual(record["year_built"], 1999)
        self.assertEqual(record["address"], "1 Main St, Austin, TX")
        self.assertEqual(record["url"], "https://example.test/a1")
        self.assertEqual(record["actor"], "apify~zillow-scraper")
        self.assertEqual(record["raw"]["zpid"], "z-a1")

        self.assertEqual(transport.requests[0].get_method(), "POST")
        self.assertEqual(transport.header("Authorization"), "Bearer tok-123")
        self.assertIn("apify~zillow-scraper", transport.url())
        self.assertTrue(transport.url().endswith("/run-sync-get-dataset-items"))
        self.assertEqual(transport.body()["search"], "Austin")
        self.assertEqual(transport.body()["query"], "Austin")

    def test_extra_input_merges_into_actor_input(self) -> None:
        _, transport = self.call(
            apify.fetch,
            "Austin",
            env=self.ENV,
            responses=(self.DATASET,),
            extra_input={"maxItems": 5},
        )
        self.assertEqual(transport.body()["maxItems"], 5)

    def test_broken_json_is_error(self) -> None:
        records, _ = self.call(
            apify.fetch,
            "Austin",
            env=self.ENV,
            responses=("<html>не json</html>",),
        )
        self.assertEqual(records, [])
        self.assertEqual(self.status(apify.fetch), STATUS_ERROR)

    def test_empty_query_returns_empty_without_request(self) -> None:
        records, transport = self.call(apify.fetch, "   ", env=self.ENV)
        self.assertEqual(records, [])
        self.assertEqual(transport.requests, [])

    def test_timeout_env_and_explicit_arg(self) -> None:
        env = {**self.ENV, "APIFY_TIMEOUT": "9.5"}
        _, transport = self.call(
            apify.fetch, "Austin", env=env, responses=(self.DATASET,)
        )
        self.assertEqual(transport.timeouts[0], 9.5)

        _, transport = self.call(
            apify.fetch, "Austin", env=env, responses=(self.DATASET,), timeout=3.0
        )
        self.assertEqual(transport.timeouts[0], 3.0)


class RentcastTests(SkillTestCase):
    """Скилл ``rentcast``: параметры запроса, ключ в заголовке, поля записи."""

    LISTINGS = json.dumps(
        [
            {
                "id": "r1",
                "formattedAddress": "2 Oak St, Austin, TX 78701",
                "price": 2100,
                "squareFootage": 85,
                "yearBuilt": 2015,
                "propertyType": "Apartment",
                "bedrooms": 2,
                "bathrooms": 1.5,
            }
        ]
    )
    ENV = {"RENTCAST_KEY": "rc-key"}

    def test_no_key_is_skipped(self) -> None:
        records, transport = self.call(rentcast.fetch, "", env={})
        self.assertEqual(records, [])
        self.assertEqual(self.status(rentcast.fetch), STATUS_NO_KEY)
        self.assertEqual(transport.requests, [])

    def test_success_records_and_query_params(self) -> None:
        records, transport = self.call(
            rentcast.fetch,
            "",
            env=self.ENV,
            responses=(self.LISTINGS,),
            city="Austin",
            state="TX",
            limit=25,
        )
        self.assertEqual(self.status(rentcast.fetch), STATUS_OK)
        self.assertEqual(len(records), 1)

        record = records[0]
        self.assertEqual(record["source"], "rentcast")
        self.assertEqual(record["id"], "r1")
        self.assertEqual(record["title"], "2 Oak St, Austin, TX 78701")
        self.assertEqual(record["price"], 2100)
        self.assertEqual(record["area"], 85)
        self.assertEqual(record["year_built"], 2015)
        self.assertEqual(record["address"], "2 Oak St, Austin, TX 78701")
        self.assertEqual(record["endpoint"], "listings/rental/long-term")
        self.assertEqual(record["bedrooms"], 2)
        self.assertEqual(record["raw"]["propertyType"], "Apartment")

        self.assertEqual(transport.header("X-Api-Key"), "rc-key")
        self.assertIn("api.rentcast.io/v1/listings/rental/long-term", transport.url())
        self.assertIn("city=Austin", transport.url())
        self.assertIn("state=TX", transport.url())
        self.assertIn("limit=25", transport.url())

    def test_query_goes_to_address_for_properties(self) -> None:
        _, transport = self.call(
            rentcast.fetch,
            "1 Main St",
            env=self.ENV,
            responses=(self.LISTINGS,),
            endpoint="properties",
        )
        self.assertIn("address=1+Main+St", transport.url())

    def test_listings_do_not_send_unsupported_address(self) -> None:
        records, transport = self.call(
            rentcast.fetch, "1 Main St", env=self.ENV, responses=(self.LISTINGS,)
        )
        self.assertEqual(self.status(rentcast.fetch), STATUS_OK)
        self.assertEqual(len(records), 1)
        self.assertNotIn("address=", transport.url())

    def test_unknown_endpoint_is_error(self) -> None:
        records, transport = self.call(
            rentcast.fetch, "", env=self.ENV, endpoint="../../secrets"
        )
        self.assertEqual(records, [])
        self.assertEqual(self.status(rentcast.fetch), STATUS_ERROR)
        self.assertEqual(transport.requests, [])

    def test_broken_json_is_error(self) -> None:
        records, _ = self.call(
            rentcast.fetch, "", env=self.ENV, responses=("не json",)
        )
        self.assertEqual(records, [])
        self.assertEqual(self.status(rentcast.fetch), STATUS_ERROR)

    def test_base_url_and_timeout_env(self) -> None:
        env = {
            **self.ENV,
            "RENTCAST_BASE_URL": "https://proxy.test/v1",
            "RENTCAST_TIMEOUT": "6.5",
        }
        _, transport = self.call(
            rentcast.fetch, "", env=env, responses=(self.LISTINGS,), state="TX"
        )
        self.assertTrue(
            transport.url().startswith(
                "https://proxy.test/v1/listings/rental/long-term"
            )
        )
        self.assertEqual(transport.timeouts[0], 6.5)


class ZillapiTests(SkillTestCase):
    """Скилл ``zillapi``: режимы search и usage, авторизация Bearer."""

    SEARCH = json.dumps(
        {
            "results": [
                {
                    "zpid": "z1",
                    "address": "3 Elm St, Austin, TX",
                    "price": 615000,
                    "livingArea": 140,
                    "yearBuilt": 2005,
                    "url": "https://zillow.test/z1",
                    "propertyType": "SINGLE_FAMILY",
                }
            ]
        }
    )
    USAGE = json.dumps({"credits": {"remaining": 87, "used": 13}, "plan": "free"})
    ENV = {"ZILLAPI_KEY": "zk_test"}

    def test_no_key_is_skipped(self) -> None:
        records, transport = self.call(zillapi.fetch, "Austin, TX", env={})
        self.assertEqual(records, [])
        self.assertEqual(self.status(zillapi.fetch), STATUS_NO_KEY)
        self.assertEqual(transport.requests, [])

    def test_search_success_records_and_request(self) -> None:
        records, transport = self.call(
            zillapi.fetch,
            "Austin, TX",
            env=self.ENV,
            responses=(self.SEARCH,),
            max_items=10,
        )
        self.assertEqual(self.status(zillapi.fetch), STATUS_OK)
        self.assertEqual(len(records), 1)

        record = records[0]
        self.assertEqual(record["source"], "zillapi")
        self.assertEqual(record["id"], "z1")
        self.assertEqual(record["zpid"], "z1")
        self.assertEqual(record["title"], "3 Elm St, Austin, TX")
        self.assertEqual(record["price"], 615000)
        self.assertEqual(record["area"], 140)
        self.assertEqual(record["year_built"], 2005)
        self.assertEqual(record["url"], "https://zillow.test/z1")
        self.assertEqual(record["raw"]["propertyType"], "SINGLE_FAMILY")

        self.assertEqual(transport.requests[0].get_method(), "POST")
        self.assertEqual(transport.header("Authorization"), "Bearer zk_test")
        self.assertTrue(transport.url().endswith("/v1/search"))
        self.assertEqual(transport.body()["filters"]["query"], "Austin, TX")
        self.assertEqual(transport.body()["limit"], 10)

    def test_usage_mode_returns_summary(self) -> None:
        records, transport = self.call(
            zillapi.fetch, "", env=self.ENV, responses=(self.USAGE,), mode="usage"
        )
        self.assertEqual(self.status(zillapi.fetch), STATUS_OK)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["source"], "zillapi")
        self.assertEqual(records[0]["credits_remaining"], 87)
        self.assertEqual(records[0]["credits_used"], 13)
        self.assertEqual(records[0]["raw"]["plan"], "free")
        self.assertEqual(transport.requests[0].get_method(), "GET")
        self.assertTrue(transport.url().endswith("/v1/usage"))
        self.assertEqual(transport.header("Authorization"), "Bearer zk_test")

    def test_unknown_mode_is_error(self) -> None:
        records, transport = self.call(
            zillapi.fetch, "Austin, TX", env=self.ENV, mode="properties"
        )
        self.assertEqual(records, [])
        self.assertEqual(self.status(zillapi.fetch), STATUS_ERROR)
        self.assertEqual(transport.requests, [])

    def test_broken_json_is_error(self) -> None:
        records, _ = self.call(
            zillapi.fetch, "Austin, TX", env=self.ENV, responses=("<html>нет</html>",)
        )
        self.assertEqual(records, [])
        self.assertEqual(self.status(zillapi.fetch), STATUS_ERROR)

    def test_empty_query_returns_empty_without_request(self) -> None:
        records, transport = self.call(zillapi.fetch, "", env=self.ENV)
        self.assertEqual(records, [])
        self.assertEqual(transport.requests, [])

    def test_base_url_and_timeout_env(self) -> None:
        env = {
            **self.ENV,
            "ZILLAPI_BASE_URL": "https://proxy.test",
            "ZILLAPI_TIMEOUT": "7.0",
        }
        _, transport = self.call(
            zillapi.fetch, "Austin, TX", env=env, responses=(self.SEARCH,)
        )
        self.assertTrue(transport.url().startswith("https://proxy.test/v1/search"))
        self.assertEqual(transport.timeouts[0], 7.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
