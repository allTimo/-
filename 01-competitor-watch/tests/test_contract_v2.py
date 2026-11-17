#!/usr/bin/env python3
r"""test_contract_v2.py - tests for the Agent 1 rework contract v2 (04.11.2026).

Covered (engine side only):
  * §5.1 истина конкурентов: анализ идёт ровно по `competitors[]` клиентского
    конфига — запись с site/platforms собирается, удалённая исчезает, запись без
    источника помечается словами «без источника — в анализ не попадает»;
  * §4/§5.3 метрики карточки: competitorsInAnalysis, competitorsWithData,
    lotsAnalyzed, cheapestLotRub (после фильтров селекции; нет лотов → null, не 0);
  * §3 группа 1: agent1.watch.query → name/url выводятся, если были пусты
    (в автоподборе и в сборе своего проекта);
  * §5.4 почта: --email-mode never|always|on-request, гейт канала email и
    auto_send для always, причины отказа словами; обычный прогон не шлёт писем.

Никакой реальной отправки: транспорт подменяется заглушкой.
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
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
CLIENTS_DIR = PROJECT_DIR / "config" / "clients"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw                      # noqa: E402
import analytics                        # noqa: E402
import client_report                    # noqa: E402
import collect_clients                  # noqa: E402
import delivery_email                   # noqa: E402
import diff_snapshots                   # noqa: E402
import discover_competitors as disc     # noqa: E402
import marketing_settings as ms         # noqa: E402
import platforms                        # noqa: E402

DATE = "2026-11-04"
MARK = "без источника — в анализ не попадает"


def run_cli(script, *args):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (env.get("PYTHONPATH"), str(SCRIPTS_DIR)) if part)
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)] + [str(arg) for arg in args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(PROJECT_DIR))


def row(**overrides):
    base = {
        "snapshot_date": DATE, "source": "cian", "competitor": "MR Group",
        "project": "Селигер Сити", "lot_id": "L-1", "url": "https://example.test/1",
        "rooms": 1, "area_m2": 40.0, "floor": 5, "floors_total": 20, "building": "1",
        "price_rub": 16_000_000, "price_per_m2_rub": 400_000, "finish": "без отделки",
        "promo_flag": 0, "promo_text": "", "delivery": "2026-Q4", "status": "active",
    }
    base.update(overrides)
    return cw.ensure_ppm2(cw.coerce_row(base))


CLIENT = {
    "client_id": "client-test", "name": "Тест",
    "report": {"title": "Мониторинг конкурентов", "formats": ["md", "xlsx"]},
    "recipients": [{"channel": "email", "address": "tyurina@d-a.ru"}],
    "sources": [{"id": "developer-sites", "enabled": True}, {"id": "cian", "enabled": True}],
    "competitors": [
        {"name": "Селигер Сити", "developer": "MR Group", "class": "бизнес",
         "site": "https://a.example", "platforms": {"cian": "https://cian.example/a"}},
        {"name": "Very", "developer": "ГК Основа", "class": "",
         "site": "", "platforms": {"cian": "https://cian.example/very"}},
        {"name": "Дмитровское ш., 89", "developer": "Фонд реновации", "class": "",
         "site": "", "platforms": {"cian": ""}},
    ],
}

SETTINGS = ms.load(agent_settings={})       # контрактные дефолты, без чтения реестра


def collect_with_recorder(client, dry_run=False):
    """collect_client с заглушками транспорта; возвращает (результат, вызовы)."""
    calls = []

    def fake_site(url, allow_browser=True):
        calls.append(("developer-sites", url))
        return {"source": "site", "platform": "site", "url": url, "status": "ok", "note": "",
                "lots": [{"price_rub": 9_000_000, "area_m2": 30.0, "rooms": 1, "title": "T"}],
                "granularity": "price-from-positions", "price_from_rub": None}

    def fake_platform(url, source_id, allow_browser=True, expect_name=""):
        calls.append((source_id, url))
        name = expect_name or "Селигер Сити"
        return {"source": source_id, "platform": source_id, "url": url, "status": "ok", "note": "",
                "lots": [{"price_rub": 12_000_000, "area_m2": 40.0, "rooms": 2, "title": name}],
                "granularity": "lots", "price_from_rub": None}

    with mock.patch.object(collect_clients, "collect_developer_site", fake_site), \
            mock.patch.object(platforms, "collect_platform", fake_platform):
        return collect_clients.collect_client(
            client, DATE, dry_run=dry_run, global_sources=[],
            marketing_settings=SETTINGS), calls


class TruthListTestCase(unittest.TestCase):
    """§5.1: истина конкурентов — ровно competitors[] клиентского конфига."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-v2-truth-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_10_only_entries_with_a_source_are_collected(self):
        (_results, _rows, _limitations), calls = collect_with_recorder(CLIENT)
        self.assertEqual(calls, [("developer-sites", "https://a.example"),
                                 ("cian", "https://cian.example/a"),
                                 ("cian", "https://cian.example/very")])
        self.assertEqual(len(calls), 3, "запись без источника не должна давать ни одного запроса")
        # без источника — это не молчание: причина есть в data_status и в markdown
        data = analytics.build_analytics([row()], None, {"totals": {"curr_date": DATE}},
                                         date=DATE, history={},
                                         competitors=CLIENT["competitors"])
        reasons = [item["reason"] for item in data["data_status"]
                   if item["source"] == "competitors"]
        self.assertTrue(reasons)
        self.assertIn(MARK, reasons[0])
        self.assertIn("Дмитровское ш., 89", reasons[0])
        markdown = "\n".join(analytics.render_markdown(data))
        self.assertIn(MARK, markdown)

    def test_11_removed_entry_no_longer_participates(self):
        without_very = [item for item in CLIENT["competitors"] if item["name"] != "Very"]
        client = dict(CLIENT, competitors=without_very)
        (_results, _rows, _limitations), calls = collect_with_recorder(client)
        self.assertNotIn(("cian", "https://cian.example/very"), calls)
        before = analytics.competitor_truth(CLIENT["competitors"], [row()])
        after = analytics.competitor_truth(without_very, [row()])
        self.assertEqual(before["competitors"] - after["competitors"], 1)

    def test_12_truth_marks_source_and_no_source_entries(self):
        truth = analytics.competitor_truth(CLIENT["competitors"], [row()])
        by_name = {item["name"]: item for item in truth["list"]}
        self.assertTrue(by_name["Селигер Сити"]["hasSource"])
        self.assertTrue(by_name["Селигер Сити"]["hasData"])
        self.assertFalse(by_name["Дмитровское ш., 89"]["hasSource"])
        self.assertEqual(by_name["Дмитровское ш., 89"]["status"], MARK)
        self.assertEqual(truth["competitors"], 2)
        self.assertEqual(truth["withoutSource"], 1)
        self.assertEqual(truth["withData"], 1)
        self.assertTrue(by_name["Селигер Сити"]["id"])
        self.assertIsNone(analytics.competitor_truth(None, [row()]))

    def test_13_client_config_of_the_engine_is_the_only_source(self):
        # панель дописывает запись в конфиг — движок видит её на ближайшем прогоне
        extra = {"name": "Новый ЖК", "developer": "Новый", "class": "",
                 "site": "https://new.example", "platforms": {"cian": ""}}
        client = dict(CLIENT, competitors=CLIENT["competitors"] + [extra])
        (_results, _rows, _limitations), calls = collect_with_recorder(client)
        self.assertIn(("developer-sites", "https://new.example"), calls)


class MetricsTestCase(unittest.TestCase):
    """§4/§5.3: метрики карточки; нет лотов → null, а не 0."""

    def build(self, rows, competitors=CLIENT["competitors"], selection=None):
        return analytics.build_analytics(
            rows, None, {"totals": {"curr_date": DATE}}, date=DATE, history={},
            competitors=competitors, selection=selection)

    def test_20_metrics_keys_and_values(self):
        rows = [row(lot_id="1", price_rub=16_000_000),
                row(lot_id="2", price_rub=9_500_000, project="Very")]
        data = self.build(rows)
        self.assertEqual(sorted(data["metrics"]), ["cheapestLotRub", "competitorsInAnalysis",
                                                   "competitorsWithData", "lotsAnalyzed"])
        self.assertEqual(data["metrics"]["competitorsInAnalysis"], 2)
        self.assertEqual(data["metrics"]["competitorsWithData"], 2)
        self.assertEqual(data["metrics"]["lotsAnalyzed"], 2)
        self.assertEqual(data["metrics"]["cheapestLotRub"], 9_500_000)

    def test_21_no_lots_is_null_not_zero(self):
        data = self.build([])
        self.assertEqual(data["metrics"]["lotsAnalyzed"], 0)
        self.assertIsNone(data["metrics"]["cheapestLotRub"])
        self.assertEqual(data["metrics"]["competitorsWithData"], 0)

    def test_22_config_not_read_is_no_data_not_zero(self):
        data = self.build([row()], competitors=None)
        self.assertIsNone(data["metrics"]["competitorsInAnalysis"])
        self.assertIsNone(data["metrics"]["competitorsWithData"])
        self.assertIsNone(data["truth"])

    def test_23_lots_after_selection_filters_only(self):
        selection = dict(ms.DEFAULT_SELECTION, price_max_rub=10_000_000)
        rows = [row(lot_id="1", price_rub=16_000_000), row(lot_id="2", price_rub=9_000_000)]
        data = self.build(rows, selection=selection)
        self.assertEqual(data["metrics"]["lotsAnalyzed"], 1)
        self.assertEqual(data["metrics"]["cheapestLotRub"], 9_000_000)

    def test_24_per_competitor_minimum_is_kept(self):
        rows = [row(lot_id="1", price_rub=16_000_000), row(lot_id="2", price_rub=12_000_000)]
        data = self.build(rows)
        self.assertEqual(data["by_competitor"][0]["cheapest_lot_rub"], 12_000_000)

    def test_25_metrics_reach_the_client_report_and_json(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-metrics-"))
        try:
            rows = [row(lot_id="1", price_rub=16_000_000)]
            payload = diff_snapshots.compute_diff(None, rows, 0.5, None, DATE)
            report = client_report.build_client_report(
                CLIENT, payload, rows, [], {"has_baseline": False}, tmp, DATE,
                agent_settings={"delivery": {"channels": ["email"], "auto_send": False}})
            on_disk = json.loads(report["analytics"].read_text(encoding="utf-8"))
            self.assertEqual(on_disk["metrics"]["competitorsInAnalysis"], 2)
            self.assertEqual(on_disk["metrics"]["cheapestLotRub"], 16_000_000)
            markdown = (tmp / ("%s-competitor-watch.md" % DATE)).read_text(encoding="utf-8")
            self.assertIn("### Метрики Агента 1", markdown)
            self.assertIn(MARK, markdown)
            self.assertNotIn("?", markdown)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class EmailModeTestCase(unittest.TestCase):
    """§5.4: режимы отправки; транспорт-заглушка, реальной отправки нет."""

    def test_30_gate_table(self):
        on = {"delivery": {"channels": ["email"], "auto_send": True}}
        off = {"delivery": {"channels": ["email"], "auto_send": False}}
        no_channel = {"delivery": {"channels": ["telegram"], "auto_send": True}}
        self.assertFalse(delivery_email.email_allowed("never", on)[0])
        self.assertIn("never", delivery_email.email_allowed("never", on)[1])
        self.assertTrue(delivery_email.email_allowed("always", on)[0])
        self.assertTrue(delivery_email.email_allowed("on-request", off)[0])
        allowed, reason = delivery_email.email_allowed("always", off)
        self.assertFalse(allowed)
        self.assertIn("автоотправка выключена", reason)
        allowed, reason = delivery_email.email_allowed("always", no_channel)
        self.assertFalse(allowed)
        self.assertIn("канал email выключен", reason)
        self.assertFalse(delivery_email.email_allowed("on-request", {})[0])
        self.assertFalse(delivery_email.email_allowed("каждый-час", on)[0])

    def test_31_default_mode_never_does_not_send(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-never-"))
        try:
            rows = [row()]
            payload = diff_snapshots.compute_diff(None, rows, 0.5, None, DATE)
            report = client_report.build_client_report(
                CLIENT, payload, rows, [], {"has_baseline": False}, tmp, DATE,
                agent_settings={"delivery": {"channels": ["email"], "auto_send": True}})
            self.assertEqual(report["email"], [])
            self.assertEqual(report["email_mode"], "never")
            self.assertIn("письмо не отправлено", report["email_status"])
            self.assertFalse(list(tmp.rglob("email-*.json")), "записи отправки быть не должно")
            self.assertFalse(list(tmp.rglob("*.eml")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_32_dry_run_never_sends(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-dry-"))
        try:
            rows = [row()]
            payload = diff_snapshots.compute_diff(None, rows, 0.5, None, DATE)
            report = client_report.build_client_report(
                CLIENT, payload, rows, [], {"has_baseline": False}, tmp, DATE,
                email_mode="always", dry_run=True,
                agent_settings={"delivery": {"channels": ["email"], "auto_send": True}})
            self.assertEqual(report["email"], [])
            self.assertIn("сухой прогон: письмо не отправлено", report["email_status"])
            self.assertFalse(list(tmp.rglob("email-*.json")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_33_always_with_auto_send_uses_the_transport_stub(self):
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

        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-always-"))
        original = delivery_email.smtplib.SMTP_SSL
        delivery_email.smtplib.SMTP_SSL = _FakeSMTP
        try:
            rows = [row()]
            payload = diff_snapshots.compute_diff(None, rows, 0.5, None, DATE)
            transport = {"smtp_host": "smtp.example.test", "smtp_port": 465,
                         "smtp_user": "bot@example.test", "sender": "bot@example.test",
                         "use_ssl": True, "password_env": "DSH_SMTP_PASSWORD",
                         "subject_template": "Конкуренты, неделя {date_from}–{date_to}"}
            report = client_report.build_client_report(
                CLIENT, payload, rows, [], {"has_baseline": False}, tmp, DATE,
                email_mode="always", smtp_transport=transport,
                environ={"DSH_SMTP_PASSWORD": "secret"},
                agent_settings={"delivery": {"channels": ["email"], "auto_send": True,
                                             "addresses": ["tyurina@d-a.ru"]}})
            self.assertEqual([record["status"] for record in report["email"]], ["sent"])
            self.assertEqual(report["email_status"], "отправлено: 1 адрес(ов)")
            journal = tmp / ".cache" / ("email-%s.json" % DATE)
            data = json.loads(journal.read_text(encoding="utf-8"))
            self.assertEqual(data["records"][0]["to"], "tyurina@d-a.ru")
            self.assertEqual(sent["server"], ("smtp.example.test", 465))
        finally:
            delivery_email.smtplib.SMTP_SSL = original
            shutil.rmtree(tmp, ignore_errors=True)


class SendOnlyAndCliTestCase(unittest.TestCase):
    """§5.2/§5.4: кнопка «Отправить сейчас» и обычный CLI-прогон."""

    def test_40_latest_ready_report_takes_the_newest_date(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-latest-"))
        try:
            for date in ("2026-10-28", DATE):
                (tmp / ("%s-competitor-watch.md" % date)).write_text("x", encoding="utf-8")
            (tmp / ("%s-competitor-watch.xlsx" % DATE)).write_bytes(b"x")
            self.assertEqual(collect_clients.latest_ready_report(tmp)[0], DATE)
            self.assertEqual(sorted(collect_clients.latest_ready_report(tmp)[1]),
                             ["md", "xlsx"])
            self.assertEqual(collect_clients.latest_ready_report(tmp / "нет"), (None, {}))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_41_send_only_refuses_words_not_exception(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-sendonly-"))
        try:
            args = type("A", (), {"reports_dir": str(tmp), "registry_dir": str(tmp),
                                  "email_mode": "never"})()
            result = collect_clients.cmd_send_only(CLIENT, args)
            self.assertEqual(result["sent"], [])
            self.assertIn("письмо не отправлено", result["status"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_42_send_only_uses_the_transport_stub(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-sendonly2-"))
        try:
            client_dir = tmp / "client-test"
            client_dir.mkdir(parents=True)
            (client_dir / ("%s-competitor-watch.md" % DATE)).write_text("x", encoding="utf-8")
            calls = []

            def fake_deliver(files, recipients, out_dir, date, **kwargs):
                calls.append((date, recipients, sorted(files)))
                return [{"to": recipients[0], "status": "sent", "sent_at": "2026-11-04T10:00:00",
                         "file": None, "reason": None}]

            args = type("A", (), {"reports_dir": str(tmp), "registry_dir": str(tmp),
                                  "email_mode": "on-request"})()
            with mock.patch.object(delivery_email, "deliver_report", fake_deliver), \
                    mock.patch.object(delivery_email, "recipients_from",
                                      lambda *a, **k: ["tyurina@d-a.ru"]), \
                    mock.patch.object(delivery_email, "email_allowed",
                                      lambda mode, settings: (True, None)):
                result = collect_clients.cmd_send_only(CLIENT, args)
            self.assertEqual(result["sent"], ["tyurina@d-a.ru"])
            self.assertEqual(calls[0][0], DATE)
            self.assertEqual(calls[0][2], ["md"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_44_email_result_line_is_machine_readable(self):
        records = [{"to": "tyurina@d-a.ru", "status": "sent", "sent_at": "x", "file": None,
                    "reason": None},
                   {"to": "vodnev@d-a.ru", "status": "eml_saved", "sent_at": None, "file": "f",
                    "reason": "не отправлено: нет SMTP-доступа"}]
        line = collect_clients.email_result_line("on-request", records, "отправлено частично: 1 из 2")
        self.assertTrue(line.startswith("EMAIL_RESULT "))
        payload = json.loads(line[len("EMAIL_RESULT "):])
        self.assertEqual(payload["sent"], ["tyurina@d-a.ru"])
        self.assertEqual(len(payload["records"]), 2)
        self.assertEqual(payload["message"], "отправлено частично: 1 из 2")

    def test_45_planned_schedule_passes_email_mode_always(self):
        proc = run_cli("collect_clients.py", "schedule", "--clients-dir", CLIENTS_DIR)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("--email-mode always", proc.stdout)

    def test_43_cli_run_sends_nothing_and_reports_metrics(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-cli-"))
        try:
            proc = run_cli("collect_clients.py", "--client", "client-svet",
                           "--clients-dir", CLIENTS_DIR, "--date", DATE, "--dry-run",
                           "--data-dir", tmp / "data", "--reports-dir", tmp / "reports",
                           "--registry-dir", tmp / "registry")
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("письмо не отправлено", proc.stdout)
            self.assertIn("EMAIL_RESULT", proc.stdout)
            self.assertFalse(list((tmp / "reports").rglob("email-*.json")),
                             "обычный прогон не создаёт записей отправки")
            self.assertFalse(list((tmp / "reports").rglob("*.eml")))
            markdown = (tmp / "reports" / "client-svet" / ("%s-competitor-watch.md" % DATE))
            self.assertTrue(markdown.exists())
            text = markdown.read_text(encoding="utf-8")
            self.assertIn("### Метрики Агента 1", text)
            self.assertIn("### Конкуренты в анализе", text)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class DryRunDefectTestCase(unittest.TestCase):
    """D-DRY: --dry-run запрещает любую сетевую отправку, включая --send-only.

    Живой конфиг для этих тестов указывает на 127.0.0.1:1 — тест никогда не
    выходит в сеть, даже если защита сломается; проверяем сам факт отсутствия
    транспорта/соединения и записей отправки.
    """

    def _args(self, tmp, **over):
        base = {"reports_dir": str(tmp / "reports"), "registry_dir": str(tmp / "registry"),
                "config_dir": str(tmp / "config"), "no_config": False, "dry_run": True,
                "email_mode": "always"}
        base.update(over)
        return type("A", (), base)()

    def _live_tree(self, tmp):
        """Включённый канал email + auto_send + готовый отчёт: без dry-run письмо ушло бы."""
        reg = tmp / "registry" / "agent-settings"
        reg.mkdir(parents=True, exist_ok=True)
        (reg / "agent-1-competitor-watch.yaml").write_text(
            'delivery:\n  channels: [email]\n  auto_send: true\n'
            '  addresses: ["tyurina@d-a.ru"]\n', encoding="utf-8")
        cfg = tmp / "config"
        cfg.mkdir(parents=True, exist_ok=True)
        (cfg / "settings.yaml").write_text(
            'delivery:\n  email:\n    smtp_host: "127.0.0.1"\n    smtp_port: 1\n'
            '    smtp_user: "bot@example.test"\n    from: "bot@example.test"\n'
            '    use_ssl: true\n    smtp_password_env: "DSH_SMTP_PASSWORD"\n', encoding="utf-8")
        cdir = tmp / "reports" / "client-test"
        cdir.mkdir(parents=True, exist_ok=True)
        (cdir / ("%s-competitor-watch.md" % DATE)).write_text("x", encoding="utf-8")
        (cdir / ("%s-competitor-watch.xlsx" % DATE)).write_bytes(b"x")

    def _write_client(self, tmp):
        """Минимальный клиентский конфиг рядом с деревом _live_tree."""
        clients_dir = tmp / "clients"
        clients_dir.mkdir(parents=True, exist_ok=True)
        (clients_dir / "client-test.yaml").write_text(
            'client_id: client-test\nname: "Тест"\n'
            'recipients:\n  - { channel: email, address: "tyurina@d-a.ru" }\n'
            'sources:\n  - { id: cian, enabled: true }\n'
            'competitors:\n  - { name: "A", developer: "D", site: "https://a.example" }\n',
            encoding="utf-8")
        return clients_dir

    def _run_cli(self, tmp, extra, env_extra=None):
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["DSH_SMTP_PASSWORD"] = "secret"
        env.update(env_extra or {})
        env["PYTHONPATH"] = os.pathsep.join(
            part for part in (env.get("PYTHONPATH"), str(SCRIPTS_DIR)) if part)
        return subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "collect_clients.py"),
             "--client", "client-test", "--clients-dir", str(tmp / "clients"),
             "--send-only", "--config-dir", str(tmp / "config"),
             "--registry-dir", str(tmp / "registry"), "--reports-dir", str(tmp / "reports")]
            + list(extra),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, cwd=str(PROJECT_DIR))

    @staticmethod
    def _forbidden(*args, **kwargs):
        raise AssertionError("dry-run не имеет права создавать транспорт или соединение")

    def test_60_send_only_dry_run_does_not_touch_the_network(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-sendonly-"))
        try:
            self._live_tree(tmp)
            with mock.patch.object(delivery_email, "email_transport", self._forbidden), \
                    mock.patch.object(delivery_email, "deliver_report", self._forbidden), \
                    mock.patch.object(delivery_email.smtplib, "SMTP_SSL", self._forbidden), \
                    mock.patch.object(delivery_email.smtplib, "SMTP", self._forbidden):
                result = collect_clients.cmd_send_only(CLIENT, self._args(tmp, dry_run=True))
            self.assertEqual(result["sent"], [])
            self.assertIn("сухой прогон: письмо не отправлено", result["status"])
            self.assertTrue(result["dryRun"])
            self.assertTrue(result["wouldSend"], "канал и режим разрешали отправку — она всё равно запрещена")
            self.assertFalse(list((tmp / "reports").rglob("email-*.json")))
            self.assertFalse(list((tmp / "reports").rglob("*.eml")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_61_no_dry_run_with_mode_never_sends_nothing(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-never-"))
        try:
            self._live_tree(tmp)
            with mock.patch.object(delivery_email, "email_transport", self._forbidden), \
                    mock.patch.object(delivery_email, "deliver_report", self._forbidden), \
                    mock.patch.object(delivery_email.smtplib, "SMTP_SSL", self._forbidden):
                result = collect_clients.cmd_send_only(
                    CLIENT, self._args(tmp, dry_run=False, email_mode="never"))
            self.assertEqual(result["sent"], [])
            self.assertIn("never", result["status"])
            self.assertFalse(list((tmp / "reports").rglob("email-*.json")))
            self.assertFalse(list((tmp / "reports").rglob("*.eml")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_62_send_only_honours_config_dir_and_no_config(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-cfg-"))
        try:
            self._live_tree(tmp)
            calls = []

            def fake_transport(config_dir=None, settings=None):
                calls.append((config_dir, settings))
                return {"smtp_host": "", "smtp_port": 465, "smtp_user": "", "sender": "",
                        "use_ssl": True, "password_env": "DSH_SMTP_PASSWORD",
                        "subject_template": "s"}

            def fake_deliver(files, recipients, out_dir, date, **kwargs):
                return [{"to": recipients[0], "status": "eml_saved", "sent_at": None,
                         "file": None, "reason": "не отправлено: нет SMTP-доступа"}]

            with mock.patch.object(delivery_email, "email_transport", fake_transport), \
                    mock.patch.object(delivery_email, "deliver_report", fake_deliver), \
                    mock.patch.object(delivery_email, "recipients_from",
                                      lambda *a, **k: ["tyurina@d-a.ru"]):
                collect_clients.cmd_send_only(CLIENT, self._args(tmp, dry_run=False))
                collect_clients.cmd_send_only(CLIENT, self._args(tmp, dry_run=False, no_config=True))
            self.assertEqual(calls[0], (str(tmp / "config"), None))
            self.assertEqual(calls[1][0], None)
            self.assertEqual(calls[1][1], {})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_63_normal_run_dry_run_creates_no_transport(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-normal-"))
        try:
            rows = [row()]
            payload = diff_snapshots.compute_diff(None, rows, 0.5, None, DATE)
            with mock.patch.object(delivery_email, "email_transport", self._forbidden), \
                    mock.patch.object(delivery_email.smtplib, "SMTP_SSL", self._forbidden):
                report = client_report.build_client_report(
                    CLIENT, payload, rows, [], {"has_baseline": False}, tmp, DATE,
                    email_mode="always", dry_run=True,
                    agent_settings={"delivery": {"channels": ["email"], "auto_send": True}})
            self.assertEqual(report["email"], [])
            self.assertEqual(report["email_status"], delivery_email.DRY_RUN_REASON)
            self.assertFalse(list(tmp.rglob("email-*.json")))
            self.assertFalse(list(tmp.rglob("*.eml")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_64_cli_send_only_dry_run_with_live_config_makes_no_connection(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-cli-"))
        try:
            self._live_tree(tmp)
            self._write_client(tmp)
            proc = self._run_cli(tmp, ["--dry-run", "--email-mode", "always"])
            output = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, output)
            self.assertIn("сухой прогон: письмо не отправлено", proc.stdout)
            self.assertIn("EMAIL_RESULT", proc.stdout)
            self.assertIn('"sent": []', proc.stdout)
            self.assertNotIn("ConnectionRefused", output)
            self.assertNotIn("отправлено: 1", output)
            self.assertFalse(list((tmp / "reports").rglob("email-*.json")))
            self.assertFalse(list((tmp / "reports").rglob("*.eml")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_65_dashboard_dry_run_env_blocks_sending(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-env-"))
        try:
            self._live_tree(tmp)
            self._write_client(tmp)
            # панель вызывает движок без --dry-run, но с DASHBOARD_ACTIONS_DRY_RUN=1
            proc = self._run_cli(tmp, ["--email-mode", "always"],
                                 env_extra={"DASHBOARD_ACTIONS_DRY_RUN": "1"})
            output = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, output)
            self.assertIn("DASHBOARD_ACTIONS_DRY_RUN=1", proc.stdout)
            self.assertIn("сухой прогон: письмо не отправлено", proc.stdout)
            self.assertNotIn("ConnectionRefused", output)
            self.assertFalse(list((tmp / "reports").rglob("email-*.json")))
            self.assertFalse(list((tmp / "reports").rglob("*.eml")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_66_dashboard_dry_run_env_also_guards_the_normal_run(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-dry-env2-"))
        try:
            self._live_tree(tmp)
            self._write_client(tmp)
            env = dict(os.environ)
            env.update({"PYTHONIOENCODING": "utf-8", "DASHBOARD_ACTIONS_DRY_RUN": "1"})
            env["PYTHONPATH"] = os.pathsep.join(
                part for part in (env.get("PYTHONPATH"), str(SCRIPTS_DIR)) if part)
            proc = subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "collect_clients.py"),
                 "--client", "client-test", "--clients-dir", str(tmp / "clients"),
                 "--email-mode", "always", "--date", DATE,
                 "--data-dir", str(tmp / "data"), "--reports-dir", str(tmp / "reports"),
                 "--registry-dir", str(tmp / "registry"), "--config-dir", str(tmp / "config")],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                env=env, cwd=str(PROJECT_DIR))
            output = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, output)
            self.assertIn("сухой прогон: письмо не отправлено", proc.stdout)
            self.assertFalse(list((tmp / "reports").rglob("email-*.json")))
            self.assertFalse(list((tmp / "reports").rglob("*.eml")))
            self.assertFalse((tmp / "registry" / "runs.jsonl").exists(), "сухой прогон не пишет реестр")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class WatchQueryTestCase(unittest.TestCase):
    """§3 группа 1: query — единственное поле, name/url выводятся из него."""

    def test_50_url_query_fills_url(self):
        watch = cw.derive_watch_query({"query": "https://svetdom.ru/", "name": "", "url": ""})
        self.assertEqual(watch["url"], "https://svetdom.ru/")
        self.assertEqual(watch.get("name", ""), "")

    def test_51_name_query_fills_name(self):
        self.assertEqual(cw.derive_watch_query({"query": "ЖК Свет"})["name"], "ЖК Свет")

    def test_52_filled_values_win(self):
        watch = cw.derive_watch_query({"query": "https://x.example", "name": "Мой ЖК",
                                       "url": "https://y.example"})
        self.assertEqual(watch["name"], "Мой ЖК")
        self.assertEqual(watch["url"], "https://y.example")

    def test_53_discovery_reads_the_derived_fields(self):
        tmp = Path(tempfile.mkdtemp(prefix="cw-v2-watch-"))
        try:
            path = tmp / "agent-1-competitor-watch.yaml"
            path.write_text('agent1:\n  watch:\n    query: "https://svetdom.ru/"\n',
                            encoding="utf-8")
            watch = disc.load_watch(path)
            self.assertEqual(watch["url"], "https://svetdom.ru/")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_54_collection_shows_the_own_project_from_query(self):
        settings = ms.load(agent_settings={"agent1": {"watch": {"query": "ЖК Свет"}}})
        line = collect_clients.own_watch_line(settings.watch)
        self.assertIn("ЖК Свет", line)
        self.assertEqual(collect_clients.own_watch_line({}), "")


if __name__ == "__main__":
    unittest.main()
