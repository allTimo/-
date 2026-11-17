#!/usr/bin/env python3
r"""Тесты разбора снимка поисковой выдачи (задача E).

Проверяют то, что можно проверить без сети: агрегаторы отсеиваются, официальные
сайты застройщиков предлагаются, уверенность честная, а формат Serper и обычный
список ссылок читаются так же, как JSON движка. Всё офлайн, на фикстурах.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
PAGES = TESTS_DIR / "fixtures" / "pages"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import search_results as sr  # noqa: E402

SERP = PAGES / "serp-svet.html"
COMPETITORS = [
    {"name": "Селигер Сити", "developer": "MR Group",
     "site": "https://www.mr-group.ru/projects/zhk-seliger-siti"},
    {"name": "Дмитровское небо", "developer": "ЛСР",
     "site": "https://www.lsr.ru/msk/zhilye-kompleksy/dmitrovskoe-nebo"},
    {"name": "Level Селигерская", "developer": "Level", "site": ""},
    {"name": "Level Южнопортовая", "developer": "Level", "site": "https://level.ru/projects/southport/"},
    {"name": "Сити Бэй", "site": ""},
    {"name": "Дмитровское ш., 89", "site": ""},
    {"name": "ЖК Нарвин", "site": ""},
]


class SearchResultsTestCase(unittest.TestCase):
    def test_01_html_serp_drops_aggregators(self):
        entries = sr.load_entries(SERP)
        hosts = [entry["host"] for entry in entries]
        self.assertEqual(len(entries), 3)
        self.assertNotIn("cian.ru", hosts)
        self.assertNotIn("realty.yandex.ru", hosts)
        self.assertIn("mr-group.ru", hosts)

    def test_02_relative_links_are_ignored(self):
        entries = sr.parse_html('<a href="javascript:void(0)">Показать ещё</a>'
                                '<a href="/local">Локальная ссылка</a>')
        self.assertEqual(entries, [])

    def test_03_serper_response_is_understood(self):
        payload = {"organic": [
            {"title": "ЖК «Селигер Сити» — официальный сайт MR Group",
             "link": "https://www.mr-group.ru/projects/zhk-seliger-siti", "snippet": "Москва"},
            {"title": "Селигер Сити — Циан", "link": "https://www.cian.ru/zhk/", "snippet": "цены"},
        ]}
        entries = sr.load_entries_text(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["host"], "mr-group.ru")

    def test_04_engine_json_is_passed_through(self):
        payload = [{"name": "ЖК Тест", "url": "https://example.ru/", "source": "web-search"}]
        entries = sr.load_entries_text(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(entries[0]["name"], "ЖК Тест")

    def test_05_plain_link_list_is_understood(self):
        text = "Селигер Сити — https://www.mr-group.ru/projects/zhk-seliger-siti\n" \
               "Агрегатор — https://www.avito.ru/moskva\n"
        entries = sr.load_entries_text(text)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["host"], "mr-group.ru")

    def test_06_site_proposals_are_confident_only_when_name_matches(self):
        proposals = {item["name"]: item for item in sr.propose_sites(sr.load_entries(SERP), COMPETITORS)}
        self.assertEqual(proposals["Селигер Сити"]["confidence"], "high")
        self.assertEqual(proposals["Селигер Сити"]["proposed_host"], "mr-group.ru")
        self.assertEqual(proposals["Дмитровское небо"]["proposed_host"], "lsr.ru")
        self.assertEqual(proposals["Level Селигерская"]["proposed_host"], "level.ru")
        # «Сити Бэй»: совпало только слово «сити» из двух — уверенность честно средняя
        self.assertEqual(proposals["Сити Бэй"]["confidence"], "medium")
        # домен не подтверждён конфигом клиента: выше medium не поднимаем (агентства
        # маскируются под «официальный сайт»), поэтому авто-перенос такое не возьмёт
        self.assertFalse(proposals["Сити Бэй"]["developer_host"])
        self.assertIn("не подтверждён", proposals["Сити Бэй"]["note"])
        self.assertEqual(proposals["Дмитровское ш., 89"]["confidence"], "medium")
        self.assertIn("не подтверждён", proposals["Дмитровское ш., 89"]["note"])
        # домен застройщика известен из конфига (Level Южнопортовая -> level.ru) — здесь high
        self.assertTrue(proposals["Level Селигерская"]["developer_host"])
        self.assertEqual(proposals["Level Селигерская"]["confidence"], "high")
        # «ЖК Нарвин» в выдаче нет — предлагать нечего, и это честно сказано
        self.assertEqual(proposals["ЖК Нарвин"]["confidence"], "none")
        self.assertIsNone(proposals["ЖК Нарвин"]["proposed_site"])
        self.assertTrue(proposals["ЖК Нарвин"]["note"])

    def test_07_current_site_is_shown_next_to_proposal(self):
        proposals = {item["name"]: item for item in sr.propose_sites(sr.load_entries(SERP), COMPETITORS)}
        self.assertEqual(proposals["Селигер Сити"]["current_site"],
                         "https://www.mr-group.ru/projects/zhk-seliger-siti")

    def test_08_engine_search_results_loader_accepts_a_saved_serp(self):
        """`--search-results` принимает не только JSON движка, но и снимок выдачи."""
        import discover_competitors
        entries = discover_competitors.load_search_results(SERP)
        self.assertEqual(len(entries), 3)
        for entry in entries:
            self.assertTrue(entry.get("name"), entry)
            self.assertTrue(entry.get("url"), entry)


    def test_09_query_includes_developer_when_known(self):
        """Запрос с застройщиком: без него у половины ЖК выдача не содержит названия."""
        with_dev = sr.query_for("ЖК Нарвин", "ПИК")
        self.assertIn("ЖК Нарвин", with_dev)
        self.assertIn("ПИК", with_dev)
        without_dev = sr.query_for("ЖК Нарвин")
        self.assertEqual(without_dev, "«ЖК Нарвин» официальный сайт застройщика Москва")


    def test_10_batch_retries_and_warns_about_rate_limit(self):
        """Пакет: пустая выдача повторяется один раз, а «много пустых» — предупреждение."""
        calls = []

        def fake_search(query):
            calls.append(query)
            if len(calls) == 2:      # повтор первого запроса отдаёт результат
                return ([{"name": "Проект Нарвин", "url": "https://www.pik.ru/narvin",
                          "host": "pik.ru"}], "DuckDuckGo (HTML): 1 ссылок")
            return [], "DuckDuckGo: в выдаче не нашлось ссылок"

        entries, notes = sr.web_search_entries(["q1", "q2", "q3"], delay=0, retry_delay=0,
                                               search_fn=fake_search)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["host"], "pik.ru")
        self.assertTrue(any("после повтора" in note for note in notes), notes)
        self.assertTrue(any("ВНИМАНИЕ" in note for note in notes), notes)
        self.assertLessEqual(len(calls), 6, "повторов не больше трёх за пакет")


if __name__ == "__main__":
    unittest.main()
