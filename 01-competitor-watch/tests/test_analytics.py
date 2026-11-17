#!/usr/bin/env python3
r"""test_analytics.py - tests for WP2 (analytics, promo dedup, forecast, e-mail).

Covered:
  * promo dedup (an identical promo of one project/lot is shown once, with a lot count);
  * "only new" promos + the counter of already known promos;
  * the analytics block (schema_version 1) by competitor, by source and dynamics;
  * honest "no data": null + a data_status record with the reason, never a zero;
  * forecast: only from >= 3 history points, marked estimate / trend-linear,
    and null with a reason when the history is too short;
  * analytics JSON written to reports/clients/<client-id>/.cache/analytics-<date>.json;
  * no SMTP access -> the finished letter is saved as .eml and the journal says
    «не отправлено: нет SMTP-доступа» instead of crashing or staying silent;
  * analytics toggles read from the agent's thin settings, safe default True.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
FIXTURES = TESTS_DIR / "fixtures"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                    # noqa: E402
import analytics                      # noqa: E402
import build_weekly_report as bwr     # noqa: E402
import delivery_email                 # noqa: E402
from diff_snapshots import compute_diff, load_snapshot_for_ref  # noqa: E402

PREV_FIXTURE = FIXTURES / "week-2026-10-23" / "lots.csv"
CURR_FIXTURE = FIXTURES / "week-2026-10-30" / "lots.csv"
CURR_DATE = "2026-10-30"
PREV_DATE = "2026-10-23"


def run_cli(script, *args, env_extra=None):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (env.get("PYTHONPATH"), str(SCRIPTS_DIR)) if part)
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)] + [str(arg) for arg in args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(PROJECT_DIR))


def row(**overrides):
    """A complete, valid snapshot row with sensible defaults."""
    base = {
        "snapshot_date": CURR_DATE, "source": "cian", "competitor": "MR Group",
        "project": "City Bay", "lot_id": "L-1", "url": "https://example.test/1",
        "rooms": 1, "area_m2": 40.0, "floor": 5, "floors_total": 20, "building": "1",
        "price_rub": 16_000_000, "price_per_m2_rub": 400_000, "finish": "без отделки",
        "promo_flag": 0, "promo_text": "", "delivery": "2026-Q4", "status": "active",
    }
    base.update(overrides)
    return cw.ensure_ppm2(cw.coerce_row(base))


def write_snapshot(folder, rows, date):
    folder = Path(folder) / date
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "lots.csv"
    cw.write_csv(path, rows, header=cw.COLUMNS)
    return path


class PromoDedupTestCase(unittest.TestCase):
    def test_01_identical_promo_of_one_project_is_shown_once(self):
        rows = [
            {"project": "City Bay", "promo_text": "Скидка 5%", "status": "новая"},
            {"project": "City Bay", "promo_text": "Скидка 5%", "status": "новая"},
            {"project": "City Bay", "promo_text": " Скидка   5% ", "status": "новая"},
            {"project": "Символ", "promo_text": "Скидка 5%", "status": "новая"},
        ]
        unique, folded = analytics.dedup_promo_rows(rows)
        self.assertEqual(folded, 2)
        self.assertEqual(len(unique), 2)
        by_project = {item["project"]: item for item in unique}
        self.assertEqual(by_project["City Bay"]["lots"], 3)
        self.assertEqual(by_project["Символ"]["lots"], 1)

    def test_02_different_status_is_a_different_promo(self):
        rows = [{"project": "City Bay", "promo_text": "Скидка 5%", "status": "новая"},
                {"project": "City Bay", "promo_text": "Скидка 5%", "status": "закончилась"}]
        unique, folded = analytics.dedup_promo_rows(rows)
        self.assertEqual(folded, 0)
        self.assertEqual(len(unique), 2)

    def test_03_report_section_dedups_and_keeps_lot_count(self):
        prev_rows, _, _ = load_snapshot_for_ref(str(PREV_FIXTURE))
        curr_rows, _, _ = load_snapshot_for_ref(str(CURR_FIXTURE))
        payload = compute_diff(prev_rows, curr_rows, 0.5, PREV_DATE, CURR_DATE)
        payload["promo_new"] = [
            {"competitor": "C", "project": "P", "lot_id": "1", "promo_text": "Акция",
             "promo_text_prev": "", "status": "новая"},
            {"competitor": "C", "project": "P", "lot_id": "2", "promo_text": "Акция",
             "promo_text_prev": "", "status": "новая"},
        ]
        payload["promo_changed"] = []
        payload["promo_ended"] = []
        bwr.configure_promos({"dedup_promos": True})
        try:
            markdown = bwr.build_markdown(payload, curr_rows, "", "x")
            section = markdown.split("## 5. ")[1].split("## 6. ")[0]
            self.assertEqual(section.count("| Акция |"), 1, section)
            self.assertIn("| 2 |", section)
        finally:
            bwr.configure_promos({"dedup_promos": True})


class TogglesTestCase(unittest.TestCase):
    def test_10_missing_keys_default_to_true(self):
        toggles = analytics.resolve_toggles({})
        for key in analytics.TOGGLE_KEYS:
            self.assertTrue(toggles[key], "%s должен быть True по умолчанию" % key)

    def test_11_explicit_false_is_respected(self):
        settings = {"agent1": {"analytics": {"forecast": False, "dedup_promos": False}}}
        toggles = analytics.resolve_toggles(settings)
        self.assertFalse(toggles["forecast"])
        self.assertFalse(toggles["dedup_promos"])
        self.assertTrue(toggles["promos"])

    def test_12_load_agent_settings_reads_the_fixture(self):
        path = FIXTURES / "agent-settings-analytics-off.yaml"
        settings = cw.load_agent_settings(path=path)
        self.assertEqual(settings["agent1"]["analytics"]["enabled"], False)
        self.assertFalse(analytics.resolve_toggles(settings)["enabled"])


class AnalyticsBlockTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.curr = cw.load_snapshot_rows(CURR_FIXTURE)
        cls.prev = cw.load_snapshot_rows(PREV_FIXTURE)
        cls.payload = {"totals": {"curr_date": CURR_DATE, "prev_date": PREV_DATE, "has_prev": True}}

    def test_20_contract_keys_and_values(self):
        data = analytics.build_analytics(self.curr, self.prev, self.payload,
                                         client_id="client-svet", date=CURR_DATE, history={})
        # v2 §5.3: к контракту добавлены metrics и truth (истина конкурентов)
        self.assertEqual(sorted(data), ["by_competitor", "by_source", "client_id", "data_status",
                                        "date", "dynamics", "email", "forecast", "generated_at",
                                        "metrics", "promos_known_count", "promos_new",
                                        "schema_version", "toggles", "truth"])
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(data["client_id"], "client-svet")
        self.assertEqual(data["date"], CURR_DATE)
        self.assertEqual(data["email"], [])
        # клиентский конфиг не передан -> «данных нет», а не 0
        self.assertEqual(sorted(data["metrics"]), ["cheapestLotRub", "competitorsInAnalysis",
                                                   "competitorsWithData", "lotsAnalyzed"])
        self.assertIsNone(data["metrics"]["competitorsInAnalysis"])
        self.assertIsNone(data["truth"])
        self.assertTrue(data["by_competitor"])
        first = data["by_competitor"][0]
        self.assertEqual(sorted(first["price_per_m2"]), ["max", "median", "min"])
        self.assertEqual(sorted(first["sources"]) if first["sources"] else [], first["sources"])
        self.assertTrue(data["by_source"])
        self.assertEqual(data["by_source"][0]["source"], "cian")
        self.assertIsNotNone(data["by_source"][0]["median_price_per_m2"])

    def test_21_by_competitor_counts_only_active_lots(self):
        rows = [row(lot_id="1", status="active"), row(lot_id="2", status="reserved"),
                row(lot_id="3", status="active")]
        data = analytics.build_analytics(rows, None, {"totals": {"curr_date": CURR_DATE}},
                                         date=CURR_DATE, history={})
        entry = data["by_competitor"][0]
        self.assertEqual(entry["lots_on_sale"], 2)

    def test_22_dynamics_new_and_gone(self):
        prev = [row(lot_id="1"), row(lot_id="2")]
        curr = [row(lot_id="1"), row(lot_id="3")]
        data = analytics.build_analytics(curr, prev, self.payload, date=CURR_DATE, history={})
        entry = data["dynamics"][0]
        self.assertEqual(entry["lots_new"], 1)
        self.assertEqual(entry["lots_gone"], 1)
        self.assertEqual(entry["period"], {"prev": PREV_DATE, "curr": CURR_DATE})

    def test_23_no_prev_is_null_with_reason_not_zero(self):
        data = analytics.build_analytics(self.curr, None, {"totals": {"curr_date": CURR_DATE}},
                                         date=CURR_DATE, history={})
        self.assertEqual(data["dynamics"], [])
        self.assertEqual(data["promos_new"], [])
        reasons = " ".join(item["reason"] for item in data["data_status"])
        self.assertIn("нет предыдущего снимка", reasons)

    def test_24_new_promos_only_and_known_counter(self):
        prev = [row(lot_id="1", promo_flag=1, promo_text="Старая акция -10%")]
        curr = [row(lot_id="1", promo_flag=1, promo_text="Старая акция -10%"),
                row(lot_id="2", promo_flag=1, promo_text="Новая акция -20%"),
                row(lot_id="3", promo_flag=1, promo_text="Новая акция -20%")]
        data = analytics.build_analytics(curr, prev, self.payload, date=CURR_DATE, history={})
        self.assertEqual(data["promos_known_count"], 1)
        self.assertEqual(len(data["promos_new"]), 1)
        self.assertEqual(data["promos_new"][0]["text"], "Новая акция -20%")
        self.assertEqual(data["promos_new"][0]["first_seen"], CURR_DATE)

    def test_25_toggle_promos_off_records_reason(self):
        data = analytics.build_analytics(self.curr, self.prev, self.payload,
                                         toggles={"promos": False}, date=CURR_DATE, history={})
        self.assertEqual(data["promos_new"], [])
        self.assertTrue(any(item["status"] == "disabled" and item["source"] == "promos"
                            for item in data["data_status"]))

    def test_28_new_promos_only_off_lists_every_current_promo(self):
        prev = [row(lot_id="1", promo_flag=1, promo_text="Старая акция -10%")]
        curr = [row(lot_id="1", promo_flag=1, promo_text="Старая акция -10%"),
                row(lot_id="2", promo_flag=1, promo_text="Новая акция -20%")]
        data = analytics.build_analytics(curr, prev, self.payload,
                                         toggles={"new_promos_only": False},
                                         date=CURR_DATE, history={})
        self.assertEqual(data["promos_known_count"], 0)
        self.assertEqual(sorted(item["text"] for item in data["promos_new"]),
                         ["Новая акция -20%", "Старая акция -10%"])

    def test_26_lots_toggle_off_gives_null_not_zero(self):
        data = analytics.build_analytics(self.curr, self.prev, self.payload,
                                         toggles={"lots_all_on_sale": False},
                                         date=CURR_DATE, history={})
        self.assertIsNone(data["by_competitor"][0]["lots_on_sale"])
        self.assertTrue(any(item["source"] == "lots_all_on_sale" for item in data["data_status"]))

    def test_27_source_status_is_carried_into_data_status(self):
        data = analytics.build_analytics(self.curr, self.prev, self.payload, date=CURR_DATE,
                                         history={},
                                         source_status=[{"source": "avito", "status": "blocked",
                                                         "note": "439: проверка безопасности"}])
        avito = [item for item in data["data_status"] if item["source"] == "avito"]
        self.assertEqual(len(avito), 1)
        self.assertEqual(avito[0]["status"], "blocked")
        self.assertIn("439", avito[0]["reason"])


class ForecastTestCase(unittest.TestCase):
    def test_30_short_history_is_none(self):
        self.assertIsNone(analytics.forecast_series([{"date": "2026-10-30", "median": 300000}],
                                                    CURR_DATE))
        self.assertIsNone(analytics.forecast_series(
            [{"date": "2026-10-16", "median": 300000}, {"date": "2026-10-23", "median": 310000}],
            CURR_DATE))

    def test_31_trend_forecast_is_marked_estimate(self):
        history = [{"date": "2026-10-09", "median": 300000},
                   {"date": "2026-10-16", "median": 310000},
                   {"date": "2026-10-23", "median": 320000},
                   {"date": "2026-10-30", "median": 330000}]
        item = analytics.forecast_series(history, CURR_DATE)
        self.assertEqual(item["metric"], "median_price_per_m2")
        self.assertEqual(item["method"], "trend-linear")
        self.assertEqual(item["points"], 4)
        self.assertEqual(item["weeks"], 4)
        self.assertIs(item["estimate"], True)
        self.assertEqual(len(item["values"]), 4)
        self.assertEqual(item["values"][0]["week"], "2026-11-06")
        # +10 000 ₽ per week, so the first projected week is 340 000
        self.assertEqual(item["values"][0]["value"], 340000)

    def test_32_short_history_in_block_is_null_with_reason(self):
        history = {"City Bay": [{"date": "2026-10-30", "median": 300000}]}
        data = analytics.build_analytics([row()], None, {"totals": {"curr_date": CURR_DATE}},
                                         date=CURR_DATE, history=history)
        self.assertIsNone(data["forecast"])
        reasons = " ".join(item["reason"] for item in data["data_status"])
        self.assertIn("истории мало", reasons)

    def test_33_history_medians_reads_snapshot_folders(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-history-"))
        write_snapshot(tmp, [row(lot_id="1", price_rub=12_000_000, area_m2=40.0)],
                       "2026-10-16")
        write_snapshot(tmp, [row(lot_id="1", price_rub=13_200_000, area_m2=40.0)],
                       "2026-10-23")
        history = analytics.history_medians(tmp)
        self.assertEqual([item["median"] for item in history["City Bay"]], [300000, 330000])
        self.assertEqual([item["date"] for item in history["City Bay"]],
                         ["2026-10-16", "2026-10-23"])

    def test_34_rendered_forecast_is_explicitly_an_estimate(self):
        history = {"City Bay": [{"date": "2026-10-09", "median": 300000},
                                {"date": "2026-10-16", "median": 310000},
                                {"date": "2026-10-23", "median": 320000},
                                {"date": "2026-10-30", "median": 330000}]}
        data = analytics.build_analytics([row()], None, {"totals": {"curr_date": CURR_DATE}},
                                         client_id="client-svet", date=CURR_DATE, history=history)
        self.assertIsNotNone(data["forecast"])
        markdown = "\n".join(analytics.render_markdown(data))
        self.assertIn("trend-linear", markdown)
        self.assertIn("estimate", markdown)
        self.assertIn("340 000 ₽", markdown)      # +10 000 ₽ for the first projected week
        self.assertNotIn("?", markdown)


class AnalyticsCliTestCase(unittest.TestCase):
    def test_40_json_is_written_next_to_the_client_report(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-analytics-cli-"))
        proc = run_cli("build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", tmp, "--formats", "md,xlsx", "--client-id", "client-svet")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        path = tmp / "clients" / "client-svet" / ".cache" / ("analytics-%s.json" % CURR_DATE)
        self.assertTrue(path.exists(), proc.stdout)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(data["client_id"], "client-svet")
        self.assertIn("Аналитика: ", proc.stdout)

        markdown = (tmp / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        self.assertIn("## " + analytics.ANALYTICS_SECTION_TITLE, markdown)
        self.assertIn("### Прогноз медианы ₽/м²", markdown)
        # the fixture history has 2 points, so the honest answer is "данных мало",
        # not an invented forecast
        self.assertIn("Прогноз не строится", markdown)
        self.assertNotIn("?", markdown)
        # the 9 numbered sections stay a frozen contract
        for index, title in enumerate(bwr.SECTIONS, start=1):
            self.assertIn("## " + title, markdown)

    def test_41_xlsx_has_the_analytics_sheet(self):
        from openpyxl import load_workbook
        tmp = Path(tempfile.mkdtemp(prefix="cw-analytics-xlsx-"))
        proc = run_cli("build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", tmp, "--formats", "xlsx")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        workbook = load_workbook(tmp / ("%s-competitor-watch.xlsx" % CURR_DATE))
        self.assertIn("Аналитика", workbook.sheetnames)
        sheet = workbook["Аналитика"]
        self.assertTrue(sheet["A1"].font.bold)
        self.assertEqual(sheet.freeze_panes, "A2")
        self.assertEqual([cell.value for cell in sheet[1]], analytics.ANALYTICS_SHEET_HEADERS)

    def test_42_analytics_can_be_switched_off_from_agent_settings(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-analytics-off-"))
        proc = run_cli("build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                       "--reports-dir", tmp, "--formats", "md",
                       "--agent-settings", FIXTURES / "agent-settings-analytics-off.yaml")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertFalse(any(tmp.rglob("analytics-*.json")),
                         "при analytics.enabled=false JSON не пишется")
        markdown = (tmp / ("%s-competitor-watch.md" % CURR_DATE)).read_text(encoding="utf-8")
        self.assertIn("Аналитика отключена", markdown)

    def test_43_analytics_json_has_no_question_marks_and_is_utf8(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-analytics-enc-"))
        run_cli("build_weekly_report.py", "--prev", PREV_FIXTURE, "--curr", CURR_FIXTURE,
                "--reports-dir", tmp, "--formats", "md")
        path = tmp / ".cache" / ("analytics-%s.json" % CURR_DATE)
        raw = path.read_bytes()
        raw.decode("utf-8")                       # must be valid UTF-8
        self.assertNotIn(b"?", raw)
        self.assertIn("Символ".encode("utf-8"), raw)


class EmailDeliveryTestCase(unittest.TestCase):
    def test_50_no_smtp_saves_eml_and_records_honest_status(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-mail-"))
        report = tmp / ("%s-competitor-watch.xlsx" % CURR_DATE)
        report.write_bytes(b"fake-xlsx")
        transport = {"smtp_host": "", "smtp_port": 465, "smtp_user": "", "sender": "",
                     "use_ssl": True, "password_env": "DSH_SMTP_PASSWORD",
                     "subject_template": "Конкуренты, неделя {date_from}–{date_to}"}
        records = delivery_email.deliver_report(
            {"xlsx": report}, ["tyurina@d-a.ru", "vodnev@d-a.ru"], tmp, CURR_DATE,
            transport=transport, password="", prev_date=PREV_DATE, curr_date=CURR_DATE,
            environ={})
        self.assertEqual([record["status"] for record in records],
                         ["eml_saved", "eml_saved"])
        for record in records:
            self.assertIn("нет SMTP-доступа", record["reason"])
            self.assertIsNone(record["sent_at"])
        eml = tmp / ("%s-competitor-watch.eml" % CURR_DATE)
        self.assertTrue(eml.exists())
        body = eml.read_text(encoding="utf-8", errors="replace")
        self.assertIn("tyurina@d-a.ru", body)
        self.assertIn("competitor-watch.xlsx", body)

        journal = tmp / ".cache" / ("email-%s.json" % CURR_DATE)
        self.assertTrue(journal.exists())
        data = json.loads(journal.read_text(encoding="utf-8"))
        self.assertEqual(len(data["records"]), 2)
        self.assertIn("нет SMTP-доступа", data["records"][0]["reason"])

        self.assertEqual(delivery_email.journal_status(records),
                         "не отправлено: нет SMTP-доступа: в settings.yaml -> delivery.email "
                         "не задан smtp_host")

    def test_51_smtp_send_path_reports_sent(self):
        sent = {}

        class _FakeSMTP:
            def __init__(self, host, port, timeout=None):
                sent["server"] = (host, port)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def login(self, user, password):
                sent["login"] = (user, password)

            def send_message(self, message):
                sent["message"] = message

        import delivery_email as module
        original = module.smtplib.SMTP_SSL
        module.smtplib.SMTP_SSL = _FakeSMTP
        try:
            tmp = Path(tempfile.mkdtemp(prefix="cw-mail-sent-"))
            report = tmp / ("%s-competitor-watch.xlsx" % CURR_DATE)
            report.write_bytes(b"fake-xlsx")
            transport = {"smtp_host": "smtp.example.test", "smtp_port": 465,
                         "smtp_user": "bot@example.test", "sender": "bot@example.test",
                         "use_ssl": True, "password_env": "DSH_SMTP_PASSWORD",
                         "subject_template": "Конкуренты, неделя {date_from}–{date_to}"}
            records = delivery_email.deliver_report(
                {"xlsx": report}, ["tyurina@d-a.ru"], tmp, CURR_DATE, transport=transport,
                password="secret", prev_date=PREV_DATE, curr_date=CURR_DATE, environ={})
        finally:
            module.smtplib.SMTP_SSL = original
        self.assertEqual(records[0]["status"], "sent")
        self.assertIsNotNone(records[0]["sent_at"])
        self.assertEqual(sent["login"], ("bot@example.test", "secret"))
        self.assertEqual(sent["server"], ("smtp.example.test", 465))
        self.assertEqual(sent["message"]["To"], "tyurina@d-a.ru")
        self.assertFalse(any(tmp.rglob("*.eml")), "при успешной отправке .eml не нужен")

    def test_52_password_comes_from_the_environment(self):
        transport = {"password_env": "DSH_SMTP_PASSWORD"}
        self.assertEqual(delivery_email.smtp_password(transport,
                                                       {"DSH_SMTP_PASSWORD": " abc "}), "abc")
        self.assertEqual(delivery_email.smtp_password(transport, {}), "")

    def test_53_recipients_prefer_agent_settings_then_client(self):
        agent = {"delivery": {"addresses": ["@svet_marketing", "tyurina@d-a.ru"]}}
        client = {"recipients": [{"channel": "email", "address": "vodnev@d-a.ru"},
                                 {"channel": "telegram", "address": "@svet_marketing"}]}
        self.assertEqual(delivery_email.recipients_from(agent, client),
                         ["tyurina@d-a.ru", "vodnev@d-a.ru"])
        self.assertEqual(delivery_email.recipients_from({}, client), ["vodnev@d-a.ru"])

    def test_54_no_recipients_is_failed_not_silent(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-mail-none-"))
        records = delivery_email.deliver_report({}, [], tmp, CURR_DATE, transport={}, password="x")
        self.assertEqual(records[0]["status"], "failed")
        self.assertIn("не задан ни один адрес", records[0]["reason"])

    def test_55_missing_pdf_keeps_xlsx_and_adds_pdf_when_present(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-mail-att-"))
        xlsx = tmp / "r.xlsx"
        xlsx.write_bytes(b"x")
        pdf = tmp / "r.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        message = delivery_email.build_message("s", "b", [xlsx, pdf], "a@b.c", "d@e.f")
        names = [part.get_filename() for part in message.iter_attachments()]
        self.assertEqual(names, ["r.xlsx", "r.pdf"])
        message2 = delivery_email.build_message("s", "b", [xlsx], "a@b.c", "d@e.f")
        self.assertEqual([part.get_filename() for part in message2.iter_attachments()], ["r.xlsx"])


if __name__ == "__main__":
    unittest.main()
