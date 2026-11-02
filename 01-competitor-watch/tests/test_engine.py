#!/usr/bin/env python3
r"""test_engine.py - unittest suite for the competitor-watch engine (task T3).

Run from the workspace root:
    <python> -m unittest discover -s marketing-agents\01-competitor-watch\tests -v

Uses the standard library only (no pytest). Fixtures:
    tests/fixtures/week-2026-10-23/lots.csv
    tests/fixtures/week-2026-10-30/lots.csv
    tests/fixtures/broken/lots.csv, header-broken.csv
    tests/fixtures/EXPECTED.md - hand-written reference for every number checked here.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Test numbering is a STABLE ID, not a strict sequence: groups keep their numbers so that
# references in marketing-agents/05-verification/verification-report.md stay valid
# (01-24 engine, 30-39 CWD/paths, 40-52 settings.yaml, 53+ fixes from the verification).
TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
FIXTURES = TESTS_DIR / "fixtures"
PREV_FIXTURE = FIXTURES / "week-2026-10-23" / "lots.csv"
CURR_FIXTURE = FIXTURES / "week-2026-10-30" / "lots.csv"
BROKEN_FIXTURE = FIXTURES / "broken" / "lots.csv"
BROKEN_HEADER_FIXTURE = FIXTURES / "broken" / "header-broken.csv"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                                    # noqa: E402
import build_weekly_report as bwr                     # noqa: E402
from diff_snapshots import compute_diff, load_snapshot_for_ref  # noqa: E402

CURR_DATE = "2026-10-30"
PREV_DATE = "2026-10-23"


def run_cli(script, *args, cwd=None):
    """Run one engine CLI with the same interpreter as the tests."""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(SCRIPTS_DIR)
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)] + [str(arg) for arg in args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(cwd or PROJECT_DIR),
    )


def section_text(markdown, number):
    """Return the body of section N of the report (between heading N and N+1)."""
    start = markdown.index("## %d. " % number)
    if number < 9:
        end = markdown.index("## %d. " % (number + 1))
    else:
        end = len(markdown)
    return markdown[start:end]


class EngineTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-engine-test-"))
        cls.reports = cls.tmp / "reports"

        cls.diff_proc = run_cli(
            "diff_snapshots.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
            "--reports-dir", cls.reports,
        )
        cls.build_proc = run_cli(
            "build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
            "--reports-dir", cls.reports, "--formats", "md,xlsx", "--telegram",
        )
        cls.validate_prev = run_cli("snapshot_tool.py", "validate", PREV_FIXTURE)
        cls.validate_curr = run_cli("snapshot_tool.py", "validate", CURR_FIXTURE)
        cls.validate_broken = run_cli("snapshot_tool.py", "validate", BROKEN_FIXTURE)
        cls.validate_broken_header = run_cli("snapshot_tool.py", "validate", BROKEN_HEADER_FIXTURE)
        cls.validate_missing = run_cli("snapshot_tool.py", "validate", cls.tmp / "no-such.csv")
        cls.normalize_broken_header = run_cli("snapshot_tool.py", "normalize", BROKEN_HEADER_FIXTURE)

        cls.cache_path = cls.reports / ".cache" / ("diff-%s.json" % CURR_DATE)
        cls.payload = json.loads(cls.cache_path.read_text(encoding="utf-8"))
        cls.md_path = cls.reports / ("%s-competitor-watch.md" % CURR_DATE)
        cls.xlsx_path = cls.reports / ("%s-competitor-watch.xlsx" % CURR_DATE)
        cls.md_text = cls.md_path.read_text(encoding="utf-8")

        cls.prev_rows, cls.prev_date, _ = load_snapshot_for_ref(str(PREV_FIXTURE))
        cls.curr_rows, cls.curr_date, _ = load_snapshot_for_ref(str(CURR_FIXTURE))
        cls.direct = compute_diff(cls.prev_rows, cls.curr_rows, 0.5, cls.prev_date, cls.curr_date)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ------------------------------------------------------------------
    # validate
    # ------------------------------------------------------------------

    def test_01_validate_good_fixtures_exit_zero(self):
        self.assertEqual(self.validate_prev.returncode, 0, self.validate_prev.stdout + self.validate_prev.stderr)
        self.assertEqual(self.validate_curr.returncode, 0, self.validate_curr.stdout + self.validate_curr.stderr)
        self.assertIn("OK: строк с данными 9", self.validate_prev.stdout)
        self.assertIn("OK: строк с данными 10", self.validate_curr.stdout)

    def test_02_validate_broken_fixture_nonzero_and_messages(self):
        output = self.validate_broken.stdout + self.validate_broken.stderr
        self.assertEqual(self.validate_broken.returncode, 1, output)
        expected_messages = [
            "строка 2: rooms=9 вне диапазона 0..6",
            "строка 3: area_m2=5 вне диапазона",
            "строка 4: price_rub=500000 должен быть больше 1 000 000",
            "строка 5: дубль лота по ключу",
            "строка 6: status=в продаже не из списка",
            "строка 7: snapshot_date не в формате YYYY-MM-DD",
            "строка 8: price_per_m2_rub=100000 не сходится",
            "строка 9: пустое обязательное поле lot_id",
            "строка 10: promo_flag=2 должен быть 0 или 1",
            "строка 11: finish=дизайнерская не из списка",
            "строка 12: delivery=2027 не в формате YYYY-QN",
            "строка 13: floor=30 больше floors_total=20",
        ]
        for message in expected_messages:
            self.assertIn(message, output)
        self.assertIn("ОШИБКИ: 12", self.validate_broken.stdout)

    def test_03_validate_broken_header_and_missing_file(self):
        output = self.validate_broken_header.stdout + self.validate_broken_header.stderr
        self.assertEqual(self.validate_broken_header.returncode, 1, output)
        self.assertIn("отсутствуют обязательные колонки", output)
        self.assertIn("лишние колонки: extra_column", output)
        self.assertEqual(self.validate_missing.returncode, 2)
        self.assertEqual(self.normalize_broken_header.returncode, 2)

    # ------------------------------------------------------------------
    # normalize
    # ------------------------------------------------------------------

    def test_04_normalize_fills_price_per_m2_and_rewrites_utf8_sig(self):
        target = self.tmp / "normalize" / "lots.csv"
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = CURR_FIXTURE.read_bytes().lstrip(b"\xef\xbb\xbf")
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        target.write_bytes(raw)

        proc = run_cli("snapshot_tool.py", "normalize", target)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("досчитано ₽/м²: 2", proc.stdout)

        self.assertTrue(target.read_bytes().startswith(b"\xef\xbb\xbf"), "нормализация должна писать utf-8-sig")
        header, rows = cw.read_table(target)
        self.assertEqual(header, cw.COLUMNS)
        filled = {row[4]: row[12] for row in rows}
        self.assertEqual(filled["M-303"], "290000")
        self.assertEqual(filled["S-105"], "330000")
        self.assertEqual(filled["S-102"], "333036")
        lot_order = [row[4] for row in rows]
        self.assertEqual(lot_order, ["C-201", "C-202", "C-203", "M-301", "M-303",
                                     "S-101", "S-102", "S-103", "S-104", "S-105"])

    def test_05_normalize_drops_duplicates(self):
        target = self.tmp / "normalize-dup" / "lots.csv"
        target.parent.mkdir(parents=True, exist_ok=True)
        header, rows = cw.read_table(CURR_FIXTURE)
        rows.append(list(rows[0]))          # exact duplicate of the first lot
        cw.write_csv(target, [dict(zip(header, row)) for row in rows], header=header)
        proc = run_cli("snapshot_tool.py", "normalize", target)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("отброшено дублей: 1", proc.stdout)
        _, rows_after = cw.read_table(target)
        self.assertEqual(len(rows_after), 10)

    def test_06_new_creates_valid_snapshot(self):
        snapshots = self.tmp / "snapshots"
        proc = run_cli("snapshot_tool.py", "new", "2026-11-06", "--snapshots-dir", snapshots)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        created = snapshots / "2026-11-06" / "lots.csv"
        self.assertTrue(created.exists())
        validate = run_cli("snapshot_tool.py", "validate", "2026-11-06", "--snapshots-dir", snapshots)
        self.assertEqual(validate.returncode, 0, validate.stdout + validate.stderr)
        self.assertTrue(created.read_bytes().startswith(b"\xef\xbb\xbf"))

    # ------------------------------------------------------------------
    # diff: lots
    # ------------------------------------------------------------------

    def test_07_new_and_gone_lots(self):
        payload = self.payload
        self.assertEqual(sorted(item["lot_id"] for item in payload["new_lots"]), ["M-303", "S-105"])
        self.assertEqual([item["lot_id"] for item in payload["gone_lots"]], ["M-302"])
        self.assertEqual(len(payload["gone_lots_inactive"]), 1)
        self.assertEqual(payload["gone_lots_inactive"][0]["lot_id"], "M-302")
        self.assertEqual(payload["gone_lots_inactive"][0]["status"], "reserved")
        self.assertEqual(payload["totals"]["new_lots"], 2)
        self.assertEqual(payload["totals"]["gone_lots"], 1)
        self.assertEqual(payload["totals"]["prev_lots"], 9)
        self.assertEqual(payload["totals"]["curr_lots"], 10)

    def test_08_price_changes_and_threshold(self):
        changes = {item["lot_id"]: item for item in self.payload["price_changes"]}
        self.assertEqual(sorted(changes), ["C-202", "S-102"])
        self.assertNotIn("S-104", changes, "изменение +0.299% ниже порога 0.5%")
        self.assertEqual(changes["S-102"]["price_prev_rub"], 17920000)
        self.assertEqual(changes["S-102"]["price_curr_rub"], 18650000)
        self.assertEqual(changes["S-102"]["delta_rub"], 730000)
        self.assertEqual(changes["S-102"]["delta_pct"], 4.07)
        self.assertEqual(changes["C-202"]["delta_rub"], -610000)
        self.assertEqual(changes["C-202"]["delta_pct"], -2.63)
        self.assertEqual(self.payload["totals"]["price_changes"], 2)
        self.assertEqual(self.payload["totals"]["price_changes_below_threshold"], 1)

    def test_09_price_per_m2_recomputed_not_inherited(self):
        changes = {item["lot_id"]: item for item in self.payload["price_changes"]}
        self.assertEqual(changes["S-102"]["price_per_m2_curr_rub"], 333036)
        self.assertEqual(changes["S-102"]["price_per_m2_prev_rub"], 320000)
        filled = {row["lot_id"]: row["price_per_m2_rub"] for row in self.curr_rows}
        self.assertEqual(filled["M-303"], 290000.0)
        self.assertEqual(filled["S-105"], 330000.0)

    def test_10_threshold_argument_is_respected(self):
        strict = compute_diff(self.prev_rows, self.curr_rows, 0.2, self.prev_date, self.curr_date)
        self.assertEqual(len(strict["price_changes"]), 3)
        self.assertIn("S-104", [item["lot_id"] for item in strict["price_changes"]])

    # ------------------------------------------------------------------
    # diff: promos / supply / medians
    # ------------------------------------------------------------------

    def test_11_promo_detection(self):
        payload = self.payload
        self.assertEqual([(item["lot_id"], item["promo_text"]) for item in payload["promo_new"]],
                         [("M-303", "Скидка 7% на старте продаж")])
        self.assertEqual(payload["promo_new"][0]["status"], "новая")
        changed = payload["promo_changed"][0]
        self.assertEqual(changed["lot_id"], "S-101")
        self.assertEqual(changed["promo_text_prev"], "Скидка 3% при 100% оплате")
        self.assertEqual(changed["promo_text"], "Скидка 5% при 100% оплате")
        self.assertEqual(changed["status"], "изменилась")
        ended = payload["promo_ended"][0]
        self.assertEqual(ended["lot_id"], "C-201")
        self.assertEqual(ended["promo_text"], "Ипотека 0,1%")
        self.assertEqual(ended["status"], "закончилась")
        self.assertEqual(payload["totals"]["promo_new"], 1)
        self.assertEqual(payload["totals"]["promo_changed"], 1)
        self.assertEqual(payload["totals"]["promo_ended"], 1)

    def test_12_supply_by_project_and_rooms(self):
        supply = {item["project"]: item for item in self.payload["supply_by_project"]}
        self.assertEqual(supply["Селигер Сити"]["active_curr"], 5)
        self.assertEqual(supply["Селигер Сити"]["active_prev"], 4)
        self.assertEqual(supply["Селигер Сити"]["delta_active"], 1)
        self.assertEqual(supply["City Bay"]["delta_active"], 0)
        self.assertEqual(supply["Символ"]["active_curr"], 2)
        self.assertEqual(supply["Символ"]["active_prev"], 1)
        self.assertEqual(supply["Символ"]["new_active"], 1)
        self.assertEqual(supply["Символ"]["gone"], 1)

        rooms = {item["rooms_label"]: item for item in self.payload["supply_by_rooms"]}
        self.assertEqual([rooms[key]["count_curr"] for key in ("студии", "1", "2", "3", "4+")],
                         [2, 3, 4, 1, 0])
        self.assertEqual(rooms["1"]["delta"], 1)
        self.assertEqual(rooms["4+"]["count_prev"], 0)
        self.assertEqual(self.payload["totals"]["curr_active"], 10)
        self.assertEqual(self.payload["totals"]["prev_active"], 8)

    def test_13_medians_by_project(self):
        prices = {item["project"]: item for item in self.payload["price_by_project"]}
        seliger = prices["Селигер Сити"]
        self.assertEqual(seliger["median_ppm2_curr"], 330000)
        self.assertEqual(seliger["median_ppm2_prev"], 322338)
        self.assertEqual(seliger["delta_median_pct"], 2.38)
        self.assertEqual(seliger["mean_ppm2_curr"], 324722)
        city = prices["City Bay"]
        self.assertEqual((city["median_ppm2_curr"], city["median_ppm2_prev"], city["delta_median_pct"]),
                         (380000, 380000, 0.0))
        symbol = prices["Символ"]
        self.assertEqual(symbol["median_ppm2_curr"], 275000)
        self.assertEqual(symbol["median_ppm2_prev"], 260000)
        self.assertEqual(symbol["delta_median_pct"], 5.77)

    def test_14_market_median_and_rounding_rule(self):
        totals = self.payload["totals"]
        self.assertEqual(totals["median_ppm2_curr"], 331518)
        self.assertEqual(totals["median_ppm2_prev"], 329838)
        self.assertEqual(totals["delta_median_ppm2_pct"], 0.51)
        self.assertEqual(totals["mean_ppm2_curr"], 332361)
        self.assertEqual(cw.median_rounded([320000, 324675]), 322338)
        self.assertEqual(cw.median_rounded([324675, 335000]), 329838)

    def test_15_rooms_price_slice(self):
        rooms = {item["rooms_label"]: item for item in self.payload["rooms_price"]}
        self.assertEqual(rooms["студии"]["count_curr"], 2)
        self.assertEqual(rooms["студии"]["median_ppm2_curr"], 357500)
        self.assertEqual(rooms["1"]["median_ppm2_curr"], 324675)
        self.assertEqual(rooms["2"]["median_ppm2_curr"], 331518)
        self.assertEqual(rooms["3"]["median_ppm2_curr"], 300897)
        self.assertEqual(rooms["4+"]["count_curr"], 0)
        self.assertIsNone(rooms["4+"]["median_ppm2_curr"])

    def test_16_no_prev_snapshot_degrades_gracefully(self):
        payload = compute_diff(None, self.curr_rows, 0.5, None, CURR_DATE)
        self.assertFalse(payload["totals"]["has_prev"])
        self.assertEqual(payload["new_lots"], [])
        self.assertEqual(payload["gone_lots"], [])
        self.assertEqual(payload["price_changes"], [])
        self.assertIsNone(payload["totals"]["prev_active"])
        self.assertIsNone(payload["price_by_project"][0]["delta_median_pct"])

    # ------------------------------------------------------------------
    # CLI diff
    # ------------------------------------------------------------------

    def test_17_diff_cli_writes_cache_and_summary(self):
        self.assertEqual(self.diff_proc.returncode, 0, self.diff_proc.stdout + self.diff_proc.stderr)
        self.assertTrue(self.cache_path.exists())
        self.assertIn("Новые лоты: 2; ушедшие: 1", self.diff_proc.stdout)
        self.assertIn("Изменения цен выше 0,5%: 2", self.diff_proc.stdout)
        cached = json.loads(self.cache_path.read_text(encoding="utf-8"))
        self.assertEqual(cached["totals"]["curr_date"], CURR_DATE)
        self.assertEqual(len(cached["new_lots"]), 2)
        missing = run_cli("diff_snapshots.py", "--prev", self.tmp / "nope.csv", "--curr", CURR_FIXTURE)
        self.assertEqual(missing.returncode, 2)

    # ------------------------------------------------------------------
    # report: markdown
    # ------------------------------------------------------------------

    def test_18_markdown_has_nine_sections_in_order(self):
        self.assertEqual(self.build_proc.returncode, 0, self.build_proc.stdout + self.build_proc.stderr)
        self.assertEqual(len(bwr.SECTIONS), 9)
        positions = []
        for title in bwr.SECTIONS:
            marker = "## " + title
            self.assertIn(marker, self.md_text)
            positions.append(self.md_text.index(marker))
        self.assertEqual(positions, sorted(positions), "разделы должны идти в заданном порядке")
        self.assertTrue(self.md_text.startswith("# Недельный обзор конкурентов — %s" % CURR_DATE))

    def test_19_markdown_sections_content(self):
        header = section_text(self.md_text, 1)
        self.assertIn("23.10.2026 → 30.10.2026", header)
        self.assertIn("Селигер Сити", header)
        self.assertIn("| Лотов в снимке | 10 (в продаже 10) |", header)

        highlights = section_text(self.md_text, 2)
        bullets = [line for line in highlights.splitlines() if line.startswith("- ")]
        self.assertGreaterEqual(len(bullets), 3)
        self.assertLessEqual(len(bullets), 7)
        self.assertIn("S-102", highlights)

        prices = section_text(self.md_text, 3)
        self.assertIn("330 000 ₽", prices)
        self.assertIn("+2,38%", prices)

        changes = section_text(self.md_text, 4)
        self.assertIn("S-102", changes)
        self.assertIn("C-202", changes)
        self.assertIn("730 000 ₽", changes)
        self.assertIn("-610 000 ₽", changes)
        self.assertNotIn("S-104", changes)

        promos = section_text(self.md_text, 5)
        self.assertIn("Скидка 7% на старте продаж", promos)
        self.assertIn("новая", promos)
        self.assertIn("изменилась", promos)
        self.assertIn("закончилась", promos)

        supply = section_text(self.md_text, 6)
        self.assertIn("Итого в продаже: **10** лотов", supply)

        rooms = section_text(self.md_text, 7)
        self.assertIn("студии", rooms)
        self.assertIn("4+", rooms)

        conclusions = section_text(self.md_text, 8)
        recs = [line for line in conclusions.splitlines() if line.startswith("- ")]
        self.assertGreaterEqual(len(recs), 3)
        self.assertLessEqual(len(recs), 6)

        limitations = section_text(self.md_text, 9)
        self.assertIn("ограничени", limitations.lower())
        self.assertIn("limitations-2026-10-30.md", limitations)

    def test_20_markdown_uses_limitations_cache_when_present(self):
        reports = self.tmp / "reports-limitations"
        cache = reports / ".cache"
        cache.mkdir(parents=True, exist_ok=True)
        (cache / ("limitations-%s.md" % CURR_DATE)).write_text(
            "- Циан отдал 403, данные по City Bay не собраны.\n", encoding="utf-8")
        proc = run_cli("build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", reports, "--formats", "md")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        text = (reports / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        self.assertIn("Циан отдал 403, данные по City Bay не собраны.", text)
        self.assertIn("Ограничения взяты из", proc.stdout)

    # ------------------------------------------------------------------
    # report: xlsx / telegram / encoding
    # ------------------------------------------------------------------

    def test_21_xlsx_sheets_and_formatting(self):
        from openpyxl import load_workbook
        workbook = load_workbook(self.xlsx_path)
        self.assertEqual(workbook.sheetnames, ["Сводка", "Цены", "Изменения", "Акции", "Лоты"])
        for sheet in workbook.worksheets:
            self.assertTrue(sheet["A1"].font.bold, "шапка листа %s должна быть жирной" % sheet.title)
            self.assertEqual(sheet.freeze_panes, "A2", "шапка листа %s должна быть заморожена" % sheet.title)
        lots = workbook["Лоты"]
        self.assertEqual(lots.max_row, 11)
        self.assertEqual(lots.max_column, 18)
        prices = workbook["Цены"]
        # min_lots_for_stats=3 from settings.yaml keeps Символ (2 lots) out of the table
        self.assertEqual(prices.max_row, 4)
        self.assertIn("₽", prices.cell(row=2, column=5).number_format)
        self.assertIn("%", prices.cell(row=2, column=8).number_format)
        changes = workbook["Изменения"]
        self.assertEqual(changes.max_row, 3)
        promos = workbook["Акции"]
        self.assertEqual(promos.max_row, 4)
        summary_labels = [summary_row[0].value for summary_row in workbook["Сводка"].iter_rows(min_row=2)]
        self.assertIn("Новых лотов", summary_labels)
        self.assertIn("Медиана ₽/м²", summary_labels)

    def test_22_telegram_summary_is_short(self):
        marker = "--- Telegram (<= 900 символов) ---"
        self.assertIn(marker, self.build_proc.stdout)
        telegram = self.build_proc.stdout.split(marker, 1)[1].strip()
        self.assertLessEqual(len(telegram), 900)
        self.assertIn("Конкуренты", telegram)
        # units.price_round_to_rub=1000 from settings.yaml
        self.assertIn("Медиана ₽/м²: 332 000 ₽", telegram)

    def test_23_all_outputs_are_utf8_with_cyrillic(self):
        raw_md = self.md_path.read_bytes()
        raw_md.decode("utf-8")
        self.assertIn("Селигер Сити".encode("utf-8"), raw_md)
        self.assertIn("₽".encode("utf-8"), raw_md)
        raw_json = self.cache_path.read_bytes()
        raw_json.decode("utf-8")
        self.assertIn("Символ".encode("utf-8"), raw_json)

        for fixture in (PREV_FIXTURE, CURR_FIXTURE, BROKEN_FIXTURE):
            raw = fixture.read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "%s должен быть utf-8-sig для Excel" % fixture.name)
            header, rows = cw.read_table(fixture)
            self.assertEqual(header[0], "snapshot_date")
            self.assertTrue(any("СЗ Гранель" in row for row in rows) or fixture == BROKEN_FIXTURE)

        from openpyxl import load_workbook
        workbook = load_workbook(self.xlsx_path)
        values = [cell.value for row in workbook["Лоты"].iter_rows() for cell in row]
        self.assertIn("Селигер Сити", values)
        self.assertIn("Ипотека 0,1%", [cell.value for row in workbook["Акции"].iter_rows() for cell in row]
                      + [cell.value for row in workbook["Лоты"].iter_rows() for cell in row])

    def test_24_report_without_prev_still_has_nine_sections(self):
        reports = self.tmp / "reports-noprev"
        empty_snapshots = self.tmp / "empty-snapshots"
        empty_snapshots.mkdir(parents=True, exist_ok=True)
        proc = run_cli("build_weekly_report.py", "--curr", CURR_FIXTURE, "--reports-dir", reports,
                       "--snapshots-dir", empty_snapshots, "--no-config")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        text = (reports / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        for title in bwr.SECTIONS:
            self.assertIn("## " + title, text)
        self.assertIn("предыдущий снимок не найден", text)
        self.assertIn("Новых лотов", text)


class CwdAndConfigTestCase(unittest.TestCase):
    """T5: paths come from __file__ (never from CWD) and settings.yaml is honoured."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-cwd-test-"))
        cls.reports = cls.tmp / "reports"
        cls.cwds = [PROJECT_DIR.parent, PROJECT_DIR, cls.tmp]   # workspace root, watch dir, %TEMP%

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_30_validate_same_output_from_three_cwds(self):
        outputs = []
        for cwd in self.cwds:
            proc = run_cli("snapshot_tool.py", "validate", CURR_FIXTURE, cwd=cwd)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            outputs.append(proc.stdout)
        self.assertEqual(len(set(outputs)), 1, "вывод validate должен совпадать при любом CWD")
        self.assertIn("OK: строк с данными 10", outputs[0])

    def test_31_diff_same_output_from_three_cwds(self):
        outputs = []
        for cwd in self.cwds:
            proc = run_cli("diff_snapshots.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                           "--reports-dir", self.reports, cwd=cwd)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            outputs.append(proc.stdout)
        self.assertEqual(len(set(outputs)), 1, "вывод diff должен совпадать при любом CWD")
        self.assertTrue((self.reports / ".cache" / ("diff-%s.json" % CURR_DATE)).exists())

    def test_32_report_builds_from_temp_cwd(self):
        reports = self.reports / "build"
        proc = run_cli("build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", reports, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        md = reports / ("%s-competitor-watch.md" % CURR_DATE)
        self.assertTrue(md.exists())
        text = md.read_text(encoding="utf-8")
        for title in bwr.SECTIONS:
            self.assertIn("## " + title, text)

    def test_33_module_paths_are_absolute_and_cwd_independent(self):
        original = os.getcwd()
        try:
            os.chdir(str(self.tmp))
            self.assertTrue(cw.SNAPSHOTS_DIR.is_absolute())
            self.assertTrue(cw.REPORTS_DIR.is_absolute())
            self.assertTrue(cw.CONFIG_DIR.is_absolute())
            self.assertEqual(cw.WATCH_DIR.name, "01-competitor-watch")
            self.assertEqual(cw.PROJECT_ROOT.name, "marketing-agents")
            self.assertEqual(cw.SNAPSHOTS_DIR, cw.WATCH_DIR / "data" / "snapshots")
            self.assertEqual(cw.CONFIG_DIR, cw.PROJECT_ROOT / "00-admin" / "config")
            self.assertEqual(cw.resolve_snapshots_dir(), cw.SNAPSHOTS_DIR)
            self.assertEqual(cw.resolve_reports_dir(), cw.REPORTS_DIR)
        finally:
            os.chdir(original)

    def test_34_explicit_dirs_override_config(self):
        override_snapshots = self.tmp / "snapshots-override"
        override_reports = self.tmp / "reports-override"
        self.assertEqual(cw.resolve_snapshots_dir(override_snapshots), override_snapshots)
        self.assertEqual(cw.resolve_reports_dir(override_reports), override_reports)
        proc = run_cli("snapshot_tool.py", "new", "2026-11-13",
                       "--snapshots-dir", override_snapshots, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue((override_snapshots / "2026-11-13" / "lots.csv").exists())

    def test_35_config_dir_controls_threshold(self):
        config = self.tmp / "config-strict"
        config.mkdir(parents=True, exist_ok=True)
        (config / "settings.yaml").write_text("thresholds:\n  price_change_pct: 0.2\n", encoding="utf-8")
        reports = self.reports / "strict"
        proc = run_cli("diff_snapshots.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", reports, "--config-dir", config, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("Изменения цен выше 0,2%: 3", proc.stdout)
        payload = json.loads((reports / ".cache" / ("diff-%s.json" % CURR_DATE)).read_text(encoding="utf-8"))
        self.assertEqual(payload["threshold_pct"], 0.2)
        self.assertEqual(len(payload["price_changes"]), 3)

        explicit = run_cli("diff_snapshots.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                           "--reports-dir", self.reports / "explicit", "--config-dir", config,
                           "--threshold", "0.5", cwd=self.tmp)
        self.assertIn("Изменения цен выше 0,5%: 2", explicit.stdout)

    def test_36_settings_yaml_matches_the_code_contract(self):
        settings = cw.load_settings()
        if not settings:
            self.skipTest("settings.yaml недоступен")
        self.assertEqual(settings["data_contract"]["columns"], cw.COLUMNS)
        self.assertEqual(settings["data_contract"]["lot_key"], list(cw.KEY_COLUMNS))
        self.assertEqual(cw.settings_threshold(), 0.5)
        self.assertEqual(cw.settings_formats(), "md,xlsx")
        self.assertEqual(cw.resolve_snapshots_dir(), cw.SNAPSHOTS_DIR)
        self.assertEqual(cw.resolve_reports_dir(), cw.REPORTS_DIR)

    def test_37_report_headings_are_the_agreed_ones(self):
        expected = [
            "1. Заголовок и охват",
            "2. Главное за неделю",
            "3. Цены: медиана ₽/м² по проектам",
            "4. Изменения цен по лотам",
            "5. Акции и промо",
            "6. Предложение: лоты в продаже, приход и уход",
            "7. Срез по комнатности",
            "8. Выводы и рекомендации",
            "9. Ограничения и что не удалось собрать",
        ]
        self.assertEqual(list(bwr.SECTIONS), expected)

    def test_38_stdout_is_utf8_without_pythonioencoding(self):
        env = dict(os.environ)
        env.pop("PYTHONIOENCODING", None)
        env["PYTHONPATH"] = str(SCRIPTS_DIR)
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "build_weekly_report.py"),
             "--curr", str(CURR_FIXTURE), "--prev", str(PREV_FIXTURE),
             "--reports-dir", str(self.reports / "encoding"), "--telegram"],
            capture_output=True, env=env, cwd=str(self.tmp),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        text = proc.stdout.decode("utf-8")          # must be valid UTF-8 bytes
        self.assertIn("Медиана ₽/м²", text)
        self.assertIn("Селигер Сити", text)
        self.assertNotIn("?", text.replace("<= 900 символов", ""))

    def test_39_no_pyyaml_dependency(self):
        proc = run_cli("diff_snapshots.py", "--help", cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        for module in ("snapshot_tool", "diff_snapshots", "build_weekly_report", "cwlib"):
            source = (SCRIPTS_DIR / (module + ".py")).read_text(encoding="utf-8")
            self.assertNotIn("import yaml", source.replace("import yaml  # optional", ""),
                             "%s не должен требовать PyYAML" % module)


class SettingsDrivenTestCase(unittest.TestCase):
    """T6: 00-admin/config/settings.yaml really drives the engine."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-settings-test-"))
        cls.reports = cls.tmp / "reports"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _config(self, name, body):
        path = self.tmp / name
        path.mkdir(parents=True, exist_ok=True)
        (path / "settings.yaml").write_text(body, encoding="utf-8")
        return path

    def _build(self, config_dir, tag, *extra):
        reports = self.reports / tag
        args = ["build_weekly_report.py", "--curr", CURR_FIXTURE, "--prev", PREV_FIXTURE,
                "--reports-dir", reports] + list(extra)
        if config_dir is not None:
            args += ["--config-dir", config_dir]
        proc = run_cli(*args, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return reports, (reports / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8"), proc

    def test_40_price_threshold_comes_from_config(self):
        strict = self._config("strict", "thresholds:\n  price_change_pct: 5.0\n")
        _, text, _ = self._build(strict, "strict")
        self.assertIn("Изменений цен выше порога 5% нет", text)
        self.assertNotIn("S-102", section_text(text, 4))
        _, text_default, _ = self._build(None, "default-threshold")
        self.assertIn("S-102", section_text(text_default, 4))
        self.assertIn("+4,07%", section_text(text_default, 4))

    def test_41_min_lots_for_stats_filters_median_tables(self):
        config = self._config("minlots", "thresholds:\n  min_lots_for_stats: 5\n")
        _, text, _ = self._build(config, "minlots")
        section = section_text(text, 3)
        self.assertNotIn("| MR Group | City Bay |", section)          # 3 lots < 5
        self.assertIn("| СЗ Гранель | Селигер Сити |", section)          # 5 lots
        self.assertIn("Ниже порога статистики", section)
        self.assertIn("в таблицу не попали: City Bay, Символ", section)                # mentioned as excluded

        permissive = self._config("minlots1", "thresholds:\n  min_lots_for_stats: 1\n")
        _, text2, _ = self._build(permissive, "minlots1")
        self.assertIn("| MR Group | City Bay |", section_text(text2, 3))
        self.assertIn("| Донстрой | Символ |", section_text(text2, 3))
        self.assertNotIn("Ниже порога статистики", text2)

    def test_42_broken_or_missing_settings_falls_back_to_defaults(self):
        broken = self._config("broken", "- 1\n- 2\n")
        _, text, proc = self._build(broken, "broken")
        self.assertIn("Настройки не применены", section_text(text, 9))
        self.assertIn("использованы значения по умолчанию", text)
        self.assertIn("Предупреждение", proc.stdout + proc.stderr)
        self.assertIn("порог 0,5%", text)               # default threshold still applied

        missing = self.tmp / "no-such-config"
        _, text_missing, proc_missing = self._build(missing, "missing")
        self.assertIn("Настройки не применены", section_text(text_missing, 9))
        self.assertIn("не найден", proc_missing.stderr + proc_missing.stdout)

    def test_43_mini_parser_reads_comments_and_quotes(self):
        body = "\n".join([
            "thresholds:",
            "  price_change_pct: 1.5      # порог из комментария",
            "  min_lots_for_stats: 2   # минимум",
            "period:",
            '  compare_mode: "previous_snapshot"   # режим сравнения',
            "units:",
            "  pct_decimals: 3",
            "  price_round_to_rub: 0",
            "quality:",
            "  warn_if_lots_below: 1",
        ]) + "\n"
        config = cw.load_config(self._config("parser", body))
        self.assertEqual(config["price_change_pct"], 1.5)
        self.assertEqual(config["min_lots_for_stats"], 2)
        self.assertEqual(config["compare_mode"], "previous_snapshot")
        self.assertEqual(config["pct_decimals"], 3)
        self.assertEqual(config["price_round_to_rub"], 0)
        self.assertEqual(config["warn_if_lots_below"], 1)

        # '#' inside quotes must survive, the trailing comment must not
        quoted = cw.load_config(self._config("parser2", 'period:\n  compare_mode: "a#b"  # хвост\n'))
        self.assertEqual(quoted["compare_mode"], "a#b")
        self.assertEqual(cw._parse_scalar("'x#y'"), "x#y")

    def test_44_rounding_and_pct_decimals_from_config(self):
        rounded = self._config("units", "units:\n  price_round_to_rub: 1000\n  pct_decimals: 1\n")
        _, text, _ = self._build(rounded, "units")
        self.assertIn("332 000 ₽", section_text(text, 3))     # 331 518 rounded to 1000
        self.assertIn("+2,4%", section_text(text, 3))         # 2.38 with 1 decimal
        self.assertIn("730 000 ₽", section_text(text, 4))     # delta is rounded but not zeroed

        exact = self._config("units2", "units:\n  price_round_to_rub: 0\n  pct_decimals: 2\n")
        _, text2, _ = self._build(exact, "units2")
        self.assertIn("331 518 ₽", section_text(text2, 3))
        self.assertIn("+2,38%", section_text(text2, 3))

    def test_45_settings_line_in_report_header(self):
        config = self._config("line", "thresholds:\n  price_change_pct: 2.5\n  min_lots_for_stats: 4\n")
        _, text, _ = self._build(config, "line")
        head = "\n".join(text.splitlines()[:6])
        self.assertIn("Настройки: порог 2,5%", head)
        self.assertIn("минимум лотов для статистики 4", head)
        self.assertIn("settings.yaml", head)
        self.assertLess(text.index("Настройки:"), text.index("## 1."))
        self.assertLess(text.index("# Недельный обзор"), text.index("Настройки:"))

    def test_46_compare_mode_previous_snapshot_finds_prev_automatically(self):
        snapshots = self.tmp / "snapshots-auto"
        for date, fixture in ((PREV_DATE, PREV_FIXTURE), (CURR_DATE, CURR_FIXTURE)):
            target = snapshots / date
            target.mkdir(parents=True, exist_ok=True)
            target.joinpath("lots.csv").write_bytes(fixture.read_bytes())
        config = self._config("auto", 'period:\n  compare_mode: "previous_snapshot"\n')
        reports = self.reports / "auto"
        proc = run_cli("build_weekly_report.py", "--curr", CURR_DATE, "--snapshots-dir", snapshots,
                       "--reports-dir", reports, "--config-dir", config, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("выбран автоматически", proc.stdout)
        text = (reports / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        self.assertIn("23.10.2026 → 30.10.2026", text)
        self.assertIn("| Лотов неделю назад | 9 (в продаже 8) |", text)
        self.assertIn("Итого в продаже: **10**", text)

    def test_47_week_over_week_without_exact_snapshot_reports_no_comparison(self):
        snapshots = self.tmp / "snapshots-week"
        for date, fixture in ((PREV_DATE, PREV_FIXTURE), (CURR_DATE, CURR_FIXTURE)):
            target = snapshots / date
            target.mkdir(parents=True, exist_ok=True)
            target.joinpath("lots.csv").write_bytes(fixture.read_bytes())
        config = self._config("week", "period:\n  compare_mode: \"week_over_week\"\n  days: 3\n")
        reports = self.reports / "week"
        proc = run_cli("build_weekly_report.py", "--curr", CURR_DATE, "--snapshots-dir", snapshots,
                       "--reports-dir", reports, "--config-dir", config, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        text = (reports / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        self.assertIn("week_over_week", section_text(text, 9))
        self.assertIn("2026-10-27", section_text(text, 9))
        self.assertIn("отчёт построен без блока изменений", text)
        self.assertIn("| Лотов неделю назад | — |", text)

    def test_48_absolute_price_threshold(self):
        config = self._config("abs", "thresholds:\n  price_change_pct: 10.0\n  price_change_abs_rub: 500000\n")
        reports = self.reports / "abs"
        proc = run_cli("diff_snapshots.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", reports, "--config-dir", config, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads((reports / ".cache" / ("diff-%s.json" % CURR_DATE)).read_text(encoding="utf-8"))
        self.assertEqual(sorted(item["lot_id"] for item in payload["price_changes"]), ["C-202", "S-102"])
        self.assertTrue(all(item["matched_by"] == "abs" for item in payload["price_changes"]))
        self.assertEqual(payload["totals"]["threshold_abs_rub"], 500000.0)

    def test_49_lots_below_quality_threshold_warns(self):
        config = self._config("quality", "quality:\n  warn_if_lots_below: 20\n")
        _, text, _ = self._build(config, "quality")
        section = section_text(text, 9)
        self.assertIn("Полнота сбора", section)
        self.assertIn("warn_if_lots_below=20", section)

        fine = self._config("quality2", "quality:\n  warn_if_lots_below: 5\n")
        _, text2, _ = self._build(fine, "quality2")
        self.assertNotIn("Полнота сбора", text2)

    def test_50_report_sections_drift_warns(self):
        config = self._config("sections", 'report_sections:\n  - key: "a"\n    title: "1. Первый"\n  - key: "b"\n    title: "2. Второй"\n')
        _, text, proc = self._build(config, "sections")
        self.assertIn("2 разделов отчёта, в движке 9", proc.stdout)
        self.assertIn("2 разделов отчёта, в движке 9", section_text(text, 9))

    def test_51_no_config_flag_ignores_settings_yaml(self):
        config = self._config("ignored", "units:\n  price_round_to_rub: 100000\n")
        _, text, _ = self._build(config, "noconfig", "--no-config")
        self.assertIn("--no-config", text)
        self.assertIn("331 518 ₽", section_text(text, 3))    # no rounding applied
        self.assertIn("без округления цен", text)

    def test_52_cli_threshold_beats_config(self):
        config = self._config("cli", "thresholds:\n  price_change_pct: 5.0\n")
        reports = self.reports / "cli"
        proc = run_cli("diff_snapshots.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", reports, "--config-dir", config, "--threshold", "0.5", cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("Изменения цен выше 0,5%: 2", proc.stdout)


class StatsContractTestCase(unittest.TestCase):
    """T8/D1: medians and averages only use lots with both price_rub and area_m2."""

    @staticmethod
    def _row(**overrides):
        base = dict(snapshot_date="2026-01-01", source="cian", competitor="C", project="P", lot_id="L",
                    url="https://x", rooms=2, area_m2=50.0, floor=1, floors_total=1, building="",
                    price_rub=None, price_per_m2_rub=None, finish="чистовая", promo_flag=0,
                    promo_text="", delivery="2027-Q1", status="active")
        base.update(overrides)
        return base

    def test_53_lots_without_price_or_area_stay_out_of_medians(self):
        rows = [
            self._row(lot_id="OK1", price_rub=100.0, area_m2=10.0, price_per_m2_rub=10.0),
            self._row(lot_id="OK2", price_rub=200.0, area_m2=10.0, price_per_m2_rub=20.0),
            self._row(lot_id="NOPRICE", price_rub=None, area_m2=50.0, price_per_m2_rub=999.0),
            self._row(lot_id="NOAREA", price_rub=300.0, area_m2=None, price_per_m2_rub=888.0),
        ]
        payload = compute_diff(None, rows, 0.5, None, "2026-01-01")
        project = payload["price_by_project"][0]
        # verifier's reproduction: 454 / 479 before the fix, 15 / 15 after
        self.assertEqual(project["median_ppm2_curr"], 15)
        self.assertEqual(project["mean_ppm2_curr"], 15)
        self.assertEqual(project["median_ppm2_curr"], cw.median_rounded([10.0, 20.0]))
        self.assertEqual(payload["totals"]["median_ppm2_curr"], 15)
        self.assertEqual(payload["totals"]["mean_ppm2_curr"], 15)

        rooms = {item["rooms_label"]: item for item in payload["rooms_price"]}
        self.assertEqual(rooms["2"]["count_curr"], 4)      # all four lots are active 2-room
        self.assertEqual(rooms["2"]["median_ppm2_curr"], 15)

    def test_53b_stats_ppm2_requires_price_and_area(self):
        self.assertEqual(cw.stats_ppm2(self._row(price_rub=100.0, area_m2=10.0, price_per_m2_rub=99.0)), 10.0)
        self.assertIsNone(cw.stats_ppm2(self._row(price_rub=None, area_m2=10.0, price_per_m2_rub=99.0)))
        self.assertIsNone(cw.stats_ppm2(self._row(price_rub=100.0, area_m2=None, price_per_m2_rub=99.0)))
        self.assertIsNone(cw.stats_ppm2(self._row(price_rub=100.0, area_m2=0.0, price_per_m2_rub=99.0)))
        # the display accessor still prefers the stored value
        self.assertEqual(cw.ppm2_of(self._row(price_rub=None, area_m2=10.0, price_per_m2_rub=99.0)), 99.0)


class PrevSelectionParityTestCase(unittest.TestCase):
    """T8/D2: run_weekly.py and run_weekly.ps1 must choose the same previous snapshot."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-prev-parity-"))
        cls.snapshots_py = cls.tmp / "snap-py"
        cls.snapshots_ps = cls.tmp / "snap-ps"
        for base in (cls.snapshots_py, cls.snapshots_ps):
            for date in ("2026-10-30", "2026-10-20"):
                target = base / date
                target.mkdir(parents=True, exist_ok=True)
                if date == "2026-10-20":
                    text = PREV_FIXTURE.read_text(encoding="utf-8-sig").replace("2026-10-23", "2026-10-20")
                    target.joinpath("lots.csv").write_text(text, encoding="utf-8-sig")
                else:
                    target.joinpath("lots.csv").write_bytes(CURR_FIXTURE.read_bytes())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run_python(self, tag, *extra):
        reports = self.tmp / ("reports-py-" + tag)
        # --skip-sources: этот тест про выбор предыдущего снимка, боевой registry/sources.yaml не трогаем
        proc = run_cli("run_weekly.py", "--date", "2026-10-30", "--reports-dir", reports,
                       "--snapshots-dir", self.snapshots_py, "--skip-sources", *extra, cwd=self.tmp)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return reports, proc

    def _run_ps1(self, tag, *extra):
        reports = self.tmp / ("reports-ps-" + tag)
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["CW_PYTHON"] = sys.executable
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(SCRIPTS_DIR / "run_weekly.ps1"),
             "-Date", "2026-10-30", "-ReportsDir", str(reports),
             "-SnapshotsDir", str(self.snapshots_ps), "-SkipSources"] + list(extra),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, cwd=str(self.tmp),
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return reports, proc

    @staticmethod
    def _period(reports):
        text = (reports / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        for line in text.splitlines():
            if line.startswith("| Период |"):
                return line
        return ""

    @staticmethod
    def _payload(reports):
        data = json.loads((reports / ".cache" / ("diff-%s.json" % CURR_DATE)).read_text(encoding="utf-8"))
        data.pop("generated_at", None)
        return data

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell для проверки run_weekly.ps1")
    def test_54_both_entry_points_agree_week_over_week(self):
        py_reports, py_proc = self._run_python("week")
        self.assertIn("2026-10-23", py_proc.stdout + py_proc.stderr)
        ps_reports, _ = self._run_ps1("week")

        self.assertEqual(self._period(py_reports), self._period(ps_reports))
        self.assertIn("предыдущий снимок не найден", self._period(py_reports))
        py_payload, ps_payload = self._payload(py_reports), self._payload(ps_reports)
        self.assertFalse(py_payload["totals"]["has_prev"])
        self.assertFalse(ps_payload["totals"]["has_prev"])
        for key in ("new_lots", "gone_lots", "price_changes", "promo_new", "supply_by_project"):
            self.assertEqual(py_payload[key], ps_payload[key], "расхождение по %s" % key)

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell для проверки run_weekly.ps1")
    def test_55_both_entry_points_agree_previous_snapshot(self):
        config = self.tmp / "cfg-prev"
        config.mkdir(parents=True, exist_ok=True)
        (config / "settings.yaml").write_text('period:\n  compare_mode: "previous_snapshot"\n', encoding="utf-8")

        py_reports, _ = self._run_python("prev", "--config-dir", config)
        ps_reports, _ = self._run_ps1("prev", "-ConfigDir", str(config))

        self.assertEqual(self._period(py_reports), self._period(ps_reports))
        self.assertIn("20.10.2026 → 30.10.2026", self._period(py_reports))
        py_payload, ps_payload = self._payload(py_reports), self._payload(ps_reports)
        self.assertTrue(py_payload["totals"]["has_prev"])
        self.assertEqual(py_payload["totals"], ps_payload["totals"])
        for key in ("new_lots", "gone_lots", "price_changes", "promo_new", "promo_changed",
                    "promo_ended", "supply_by_project", "price_by_project"):
            self.assertEqual(py_payload[key], ps_payload[key], "расхождение по %s" % key)

    def test_56_shared_helper_is_the_single_rule(self):
        snapshots = self.tmp / "snap-py"
        self.assertIsNone(cw.previous_snapshot_date("2026-10-30", snapshots, "week_over_week", 7))
        self.assertEqual(cw.previous_snapshot_date("2026-10-30", snapshots, "week_over_week", 10), "2026-10-20")
        self.assertEqual(cw.previous_snapshot_date("2026-10-30", snapshots, "previous_snapshot", 7), "2026-10-20")
        self.assertEqual(cw.shift_date("2026-10-30", 7), "2026-10-23")
        # the divergent local helper is gone from the python alias
        source = (SCRIPTS_DIR / "run_weekly.py").read_text(encoding="utf-8")
        self.assertNotIn("def previous_snapshot_date", source)
        self.assertIn("cw.previous_snapshot_date",
                      (SCRIPTS_DIR / "diff_snapshots.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
