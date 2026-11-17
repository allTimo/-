"""Тесты скилла ``developer_pricing``: цена с сайта застройщика без обманок.

Закрывают дефект F10: в карточке рядом с ценой стоят «первоначальный взнос»,
«платёж по ипотеке» и «цена за м²», из-за чего в снимок попадали ₽/м² вроде
34 700 и 74 928. Сеть подменяется: патчится ``skills.runtime.http._transport``.

Запуск из каталога ``marketing-agents``::

    & $py -m unittest discover -s skills/tests -t . -v
"""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

if __package__ in (None, ""):  # прямой запуск файла: python skills/tests/test_developer_pricing.py
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from skills.real_estate import developer_pricing as dp
from skills.runtime import (
    STATUS_EMPTY,
    STATUS_NOT_DEPLOYED,
    STATUS_OK,
    SkillError,
    run_skill_result,
)
from skills.runtime import http as runtime_http

PAGES = Path(__file__).resolve().parents[2] / "01-competitor-watch" / "tests" / "fixtures" / "pages"
FIXTURE = PAGES / "site-price-cards.html"
PAGE_URL = "https://level.ru/projects/southport/"


class FakeTransport:
    """Подмена ``skills.runtime.http._transport``: заданный ответ HTML или сбой."""

    def __init__(self, body: str = "", error: Exception | None = None) -> None:
        self.body = body
        self.error = error
        self.calls: list = []

    def __call__(self, request, timeout: float) -> str:
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return self.body


class DeveloperPricingTestCase(unittest.TestCase):
    def run_it(self, url: str = PAGE_URL, body: str = "", error: Exception | None = None):
        transport = FakeTransport(body=body, error=error)
        with mock.patch.object(runtime_http, "_transport", transport):
            return run_skill_result("developer_pricing", url), transport

    def test_01_price_is_not_the_down_payment(self):
        info, _ = self.run_it(body=FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(info["status"], STATUS_OK)
        first = info["records"][0]
        self.assertEqual(first["price"], 11000000)
        self.assertEqual(first["area"], 31.7)
        self.assertEqual(first["rooms"], 0)
        self.assertEqual(first["url"], "https://level.ru/flats/101")

    def test_02_implausible_ppm2_is_not_published(self):
        info, _ = self.run_it(body=FIXTURE.read_text(encoding="utf-8"))
        third = info["records"][2]
        self.assertIsNone(third["price"])
        self.assertIn("вне коридора", third["raw"]["rejected"])
        self.assertEqual(third["area"], 34.7)

    def test_03_blocked_site_is_reported_honestly(self):
        error = SkillError("HTTP 403 Forbidden для https://level.ru/; ответ: <html>denied")
        info, _ = self.run_it(error=error)
        self.assertEqual(info["status"], STATUS_NOT_DEPLOYED)
        self.assertEqual(info["records"], [])
        self.assertIn("Chrome CDP", info["error"])

    def test_04_not_a_url_is_empty_and_does_not_hit_network(self):
        info, transport = self.run_it(url="ЖК Свет")
        self.assertEqual(info["status"], STATUS_EMPTY)
        self.assertEqual(info["records"], [])
        self.assertEqual(transport.calls, [])

    def test_05_noise_does_not_steal_the_real_price(self):
        self.assertEqual(dp.pick_lot_price("Первоначальный взнос 1 100 000 ₽ Цена от 11 000 000 ₽"),
                         11000000)
        self.assertEqual(dp.pick_lot_price("цена за м² 300 000 ₽ цена 20 000 000 ₽"), 20000000)
        self.assertEqual(dp.pick_lot_price("23,18 млн ₽"), 23180000)
        self.assertIsNone(dp.pick_lot_price("нет цены"))

    def test_06_ppm2_gate(self):
        self.assertFalse(dp.ppm2_within_range(1100000, 31.7))
        self.assertTrue(dp.ppm2_within_range(16800000, 41))
        self.assertTrue(dp.ppm2_within_range(16800000, None))

    def test_07_lot_url_guard(self):
        """Паркинг, ипотека и чужой ЖК — не позиции конкурента (проверено на живом level.ru)."""
        html = (
            '<article class="card-flat"><a href="/parking">Паркинг 31 м2</a>'
            '<div>Цена 17 600 000 ₽</div></article>'
            '<article class="card-flat"><a href="https://level.ru/purchase/mortgage/">Ипотека</a>'
            '<div>Цена 15 000 000 ₽</div></article>'
            '<article class="card-flat"><a href="https://level.ru/projects/lesnoy/">ЖК Лесной 123.3 м2</a>'
            '<div>Цена 25 000 000 ₽</div></article>'
            '<article class="card-flat"><a href="https://level.ru/southport/flat/1room/10-195/">1-комн 41 м2</a>'
            '<div>Цена 25 364 668 ₽</div></article>'
        )
        positions = dp.parse_positions(html, PAGE_URL)
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["url"], "https://level.ru/southport/flat/1room/10-195/")
        self.assertEqual(positions[0]["price"], 25364668)


    def test_08_discount_and_area_with_space(self):
        """level.ru пишет «28.8 м 2» (пробел внутри единицы) и цену со скидкой."""
        text = "Студия-квартира, 28.8 м 2 25 364 668 руб. 16 487 034 руб. -35%"
        self.assertEqual(dp.pick_area(text), 28.8)
        details = dp.pick_lot_price_details(text)
        self.assertEqual(details["price_rub"], 16487034)
        self.assertEqual(details["price_before_rub"], 25364668)
        # процент на странице не сходится — цену не подменяем
        wrong = dp.pick_lot_price_details("цена 10 000 000 руб. 9 000 000 руб. -3%")
        self.assertEqual(wrong["price_rub"], 10000000)
        self.assertIsNone(wrong["price_before_rub"])


if __name__ == "__main__":
    unittest.main()
