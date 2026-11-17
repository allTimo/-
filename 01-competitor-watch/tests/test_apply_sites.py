#!/usr/bin/env python3
r"""Тесты переноса предложенных сайтов в конфиг клиента (пункт 5 плана).

Проверяется главное свойство: без ``--write`` файл не меняется вовсе, а с записью
появляется резервная копия ``.bak`` и конфиг остаётся разбираемым для движка.
Ничего боевого не трогается — работаем на временном каталоге.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw            # noqa: E402
import search_results as sr   # noqa: E402

CONFIG = '''client_id: client-test
name: "Тестовый клиент"
sources:
  - { id: developer-sites, enabled: true }
competitors:
  - name: "ЖК Сайт Есть"
    developer: "A"
    site: "https://old.example/"
    platforms:
      cian: ""
  - name: "ЖК Без Сайта"
    developer: "B"
    site: ""
    platforms:
      cian: ""
  - { id: жк-строчный, name: "ЖК Строчный", developer: "C", site: "", platforms: { cian: "" } }
'''


class ApplySitesTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw-apply-"))
        self.path = self.tmp / "client-test.yaml"
        self.path.write_text(CONFIG, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def proposals(self):
        return [
            {"name": "ЖК Сайт Есть", "current_site": "https://old.example/",
             "proposed_site": "https://new.example/", "confidence": "high"},
            {"name": "ЖК Без Сайта", "current_site": "",
             "proposed_site": "https://fresh.example/", "confidence": "high"},
            {"name": "ЖК Строчный", "current_site": "",
             "proposed_site": "https://flow.example/", "confidence": "high"},
            {"name": "ЖК Средняя", "current_site": "",
             "proposed_site": "https://medium.example/", "confidence": "medium"},
        ]

    def test_01_dry_run_changes_nothing(self):
        before = self.path.read_text(encoding="utf-8")
        plan = sr.plan_site_updates(self.proposals())
        changed, backup = sr.apply_site_updates(self.path, plan, write=False)
        self.assertIsNone(backup, "без --write резервной копии быть не должно")
        self.assertEqual(len(changed), 2, "план показывает, что было бы изменено")
        self.assertEqual(self.path.read_text(encoding="utf-8"), before, "файл не менялся")
        actions = {item["name"]: item["action"] for item in plan}
        self.assertEqual(actions["ЖК Сайт Есть"], "skip_has_site")
        self.assertEqual(actions["ЖК Без Сайта"], "set_site")
        self.assertNotIn("ЖК Средняя", actions)      # medium без флага не берём

    def test_02_write_sets_block_and_flow_records(self):
        plan = sr.plan_site_updates(self.proposals())
        changed, backup = sr.apply_site_updates(self.path, plan, write=True)
        self.assertIsNotNone(backup)
        self.assertTrue(Path(backup).is_file())
        self.assertEqual(len(changed), 2)
        text = self.path.read_text(encoding="utf-8")
        self.assertIn('site: "https://fresh.example/"', text)
        self.assertIn('site: "https://flow.example/"', text)
        self.assertIn('site: "https://old.example/"', text)   # чужой сайт не тронут
        parsed = cw.parse_simple_yaml(self.path)
        records = {item["name"]: item for item in parsed["competitors"]}
        self.assertEqual(records["ЖК Без Сайта"]["site"], "https://fresh.example/")
        self.assertEqual(records["ЖК Строчный"]["site"], "https://flow.example/")
        self.assertEqual(records["ЖК Сайт Есть"]["site"], "https://old.example/")

    def test_03_unknown_name_is_reported_not_written(self):
        plan = sr.plan_site_updates([{"name": "ЖК Неизвестная", "current_site": "",
                                      "proposed_site": "https://nope.example/", "confidence": "high"}])
        changed, backup = sr.apply_site_updates(self.path, plan, write=True)
        self.assertEqual(changed, [])
        self.assertIsNone(backup)
        self.assertEqual(plan[0]["action"], "not_found")

    def test_04_only_filter_limits_the_plan(self):
        plan = sr.plan_site_updates(self.proposals(), only=["ЖК Без Сайта"])
        self.assertEqual([item["name"] for item in plan], ["ЖК Без Сайта"])

    def test_05_force_rewrites_existing_site(self):
        plan = sr.plan_site_updates(self.proposals(), only=["ЖК Сайт Есть"], force=True)
        self.assertEqual(plan[0]["action"], "set_site")
        changed, backup = sr.apply_site_updates(self.path, plan, write=True, force=True)
        self.assertEqual(len(changed), 1)
        parsed = cw.parse_simple_yaml(self.path)
        records = {item["name"]: item for item in parsed["competitors"]}
        self.assertEqual(records["ЖК Сайт Есть"]["site"], "https://new.example/")
        self.assertTrue(Path(backup).is_file())

    def test_06_medium_is_included_with_the_flag(self):
        plan = sr.plan_site_updates(self.proposals(), include_medium=True)
        self.assertIn("ЖК Средняя", [item["name"] for item in plan])


if __name__ == "__main__":
    unittest.main()
