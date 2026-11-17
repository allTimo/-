#!/usr/bin/env python3
r"""qa-email-gate.py — НЕЗАВИСИМАЯ проверка почтового гейта Агента 1 (контракт v2 §5.4).

Не переиспользует тесты движка: свои фикстуры, свой транспорт-заглушка, свои границы.
Никакой реальной отправки: SMTP подменяется заглушкой, письма людям не уходят.

    python marketing-agents\dashboard\_ux-harness\qa-email-gate.py

Проверяет:
  * таблицу гейта: письмо только при режиме always|on-request + канале email
    (+ auto_send для always); причины отказа — словами;
  * прогон без --email-mode (дефолт never) НЕ создаёт записей отправки и .eml;
  * --email-mode always при auto_send true и канале email — создаёт (заглушка транспорта),
    журнал email-<дата>.json и статус в analytics-<дата>.json;
  * --dry-run на пути сбора блокирует почту;
  * границы CLI: дефолт парсера never, расписание шлёт always, кнопка send-only,
    и ОТДЕЛЬНО — не защищён ли --send-only флагом --dry-run (дефект-детектор).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from contextlib import ExitStack, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]                     # marketing-agents
SCRIPTS = PROJECT / "01-competitor-watch" / "scripts"
WORK = HERE / "tmp" / "qa-email"

sys.path.insert(0, str(SCRIPTS))

import client_report                      # noqa: E402
import collect_clients                    # noqa: E402
import cwlib as cw                        # noqa: E402
import delivery_email                     # noqa: E402
import diff_snapshots                     # noqa: E402

DATE = "2026-11-04"
OK = 0
FAIL = 0
DEFECTS: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    global OK, FAIL
    print("  " + ("OK  " if cond else "FAIL") + " " + label + ("  (%s)" % detail if detail else ""))
    if cond:
        OK += 1
    else:
        FAIL += 1


def defect(label: str, detail: str) -> None:
    global FAIL
    print("  ДЕФЕКТ " + label + "  (" + detail + ")")
    FAIL += 1
    DEFECTS.append(label + ": " + detail)


def rows_for():
    base = {"snapshot_date": DATE, "source": "cian", "competitor": "QA Developer",
            "project": "QA ЖК Сайт", "lot_id": "L-1", "url": "https://qa.example/1",
            "rooms": 1, "area_m2": 40.0, "floor": 5, "floors_total": 20, "building": "1",
            "price_rub": 12_000_000, "price_per_m2_rub": 300_000, "finish": "без отделки",
            "promo_flag": 0, "promo_text": "", "delivery": "2026-Q4", "status": "active"}
    return [cw.ensure_ppm2(cw.coerce_row(base))]


CLIENT = {
    "client_id": "client-qa", "name": "QA клиент",
    "report": {"title": "QA отчёт", "formats": ["md"]},
    "recipients": [{"channel": "email", "address": "tyurina@d-a.ru"}],
    "sources": [{"id": "cian", "enabled": False}],
    "competitors": [
        {"name": "QA ЖК Сайт", "developer": "QA Developer", "class": "бизнес",
         "site": "https://qa.example/", "platforms": {"cian": ""}},
        {"name": "QA ЖК Без источника", "developer": "QA Developer", "class": "",
         "site": "", "platforms": {"cian": "", "avito": "", "yandex_realty": "", "domclick": ""}},
    ],
}

CHANNEL_OK = {"delivery": {"channels": ["email"], "auto_send": True, "addresses": ["tyurina@d-a.ru"]}}
TRANSPORT = {"smtp_host": "smtp.qa.test", "smtp_port": 465, "smtp_user": "qa@qa.test",
             "sender": "qa@qa.test", "use_ssl": True, "password_env": "QA_SMTP_PASSWORD",
             "subject_template": "QA {date_from}–{date_to}"}


class FakeSMTP:
    """Заглушка SMTP: письмо «уходит» только в память этого процесса."""
    sent: list = []

    def __init__(self, host, port, timeout=None):
        FakeSMTP.sent.append(("server", host, port))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        FakeSMTP.sent.append(("login", user))

    def send_message(self, message):
        FakeSMTP.sent.append(("message", message["To"]))


def build(tmp: Path, client=None, **kwargs):
    target = client or CLIENT
    rows = rows_for()
    payload = diff_snapshots.compute_diff(None, rows, 0.5, None, DATE)
    return client_report.build_client_report(
        target, payload, rows, [], {"has_baseline": False}, tmp, DATE, **kwargs)


def journal_of(tmp: Path):
    return sorted(tmp.rglob("email-*.json"))


def main() -> int:
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True, exist_ok=True)

    # ---------------- 1. таблица гейта ----------------
    print("1. Таблица гейта email_allowed (§5.4):")
    a, r = delivery_email.email_allowed("never", CHANNEL_OK)
    check("never + канал email + auto_send -> не отправлять, причина словами", a is False and r.startswith("письмо не отправлено") and "never" in r, r)
    a, r = delivery_email.email_allowed("always", CHANNEL_OK)
    check("always + канал email + auto_send=true -> отправлять", a is True and r is None, str(r))
    a, r = delivery_email.email_allowed("always", {"delivery": {"channels": ["email"], "auto_send": False}})
    check("always + auto_send=false -> не отправлять, причина «автоотправка выключена»", a is False and "автоотправка выключена" in r, r)
    a, r = delivery_email.email_allowed("always", {"delivery": {"channels": ["telegram"], "auto_send": True}})
    check("always + канала email нет -> не отправлять, причина «канал email выключен»", a is False and "канал email выключен" in r, r)
    a, r = delivery_email.email_allowed("on-request", {"delivery": {"channels": ["email"], "auto_send": False}})
    check("on-request НЕ требует auto_send (кнопка «Отправить сейчас»)", a is True, str(r))
    a, r = delivery_email.email_allowed("on-request", {"delivery": {"channels": [], "auto_send": True}})
    check("on-request без канала email -> отказ", a is False and "канал email выключен" in r, r)
    a, r = delivery_email.email_allowed("always", {"delivery": {"channels": "email", "auto_send": True}})
    check("канал задан строкой «email» (терпимость к формату) -> отправлять", a is True, str(r))
    a, r = delivery_email.email_allowed("always", {"delivery": {"channels": ["Email"], "auto_send": True}})
    check("канал в другом регистре «Email» -> отправлять (регистр не важен)", a is True, str(r))
    a, r = delivery_email.email_allowed("каждый-час", CHANNEL_OK)
    check("неизвестный режим -> отказ с названием режима", a is False and "неизвестный режим" in r, r)
    a, r = delivery_email.email_allowed(None, CHANNEL_OK)
    check("режим не задан -> дефолт never (не отправлять)", a is False and "never" in r, r)
    a, r = delivery_email.email_allowed("always", {})
    check("нет блока delivery вовсе -> отказ, а не падение", a is False and "канал email выключен" in r, r)

    # ---------------- 2. матрица build_client_report ----------------
    print("2. Матрица прогона отчёта (заглушка транспорта, без сети):")
    t = WORK / "m-never"
    rep = build(t, agent_settings=CHANNEL_OK)
    check("без email_mode (дефолт never): записей отправки нет", rep["email"] == [] and rep["email_mode"] == "never", rep["email_status"])
    check("без email_mode: журнала email-*.json и .eml не создано", not journal_of(t) and not list(t.rglob("*.eml")), "файлов отправки: 0")
    check("без email_mode: статус объяснён словами", "письмо не отправлено" in rep["email_status"], rep["email_status"])

    t = WORK / "m-always-off"
    rep = build(t, email_mode="always", agent_settings={"delivery": {"channels": ["email"], "auto_send": False}})
    check("always + auto_send=false: записей и журнала нет", rep["email"] == [] and not journal_of(t), rep["email_status"])

    t = WORK / "m-always-nochannel"
    rep = build(t, email_mode="always", agent_settings={"delivery": {"channels": ["telegram"], "auto_send": True}})
    check("always + без канала email: записей и журнала нет", rep["email"] == [] and not journal_of(t), rep["email_status"])

    FakeSMTP.sent = []
    t = WORK / "m-always-on"
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", FakeSMTP):
        rep = build(t, email_mode="always", smtp_transport=TRANSPORT, environ={"QA_SMTP_PASSWORD": "qa"},
                    agent_settings=CHANNEL_OK)
    check("always + канал email + auto_send=true: запись об отправке создана", [x["status"] for x in rep["email"]] == ["sent"], json.dumps(rep["email"], ensure_ascii=False)[:120])
    check("always: письмо ушло в заглушку транспорта (реальной сети нет)", ("message", "tyurina@d-a.ru") in FakeSMTP.sent, str(FakeSMTP.sent)[:120])
    check("always: создан журнал .cache/email-<дата>.json", len(journal_of(t)) == 1, str(journal_of(t)))
    check("always: статус «отправлено: 1 адрес(ов)»", rep["email_status"] == "отправлено: 1 адрес(ов)", rep["email_status"])
    analytics = rep.get("analytics")
    doc = json.loads(Path(analytics).read_text(encoding="utf-8")) if analytics else {}
    check("always: статус отправки попал в analytics-<дата>.json (панель читает оттуда)",
          doc.get("email") and doc["email"][0]["status"] == "sent", json.dumps(doc.get("email"), ensure_ascii=False)[:120])
    check("always: движок отдал metrics контракта v2 (4 ключа)", sorted((doc.get("metrics") or {}).keys()) == ["cheapestLotRub", "competitorsInAnalysis", "competitorsWithData", "lotsAnalyzed"], json.dumps(doc.get("metrics"), ensure_ascii=False))
    check("always: metrics без источника -> null, а не 0 (не выдумываем)", doc["metrics"]["cheapestLotRub"] == 12_000_000 and doc["truth"]["withoutSource"] == 1, json.dumps(doc["truth"], ensure_ascii=False)[:140])
    md = (t / ("%s-competitor-watch.md" % DATE)).read_text(encoding="utf-8")
    check("always: в отчёте есть раздел «без источника — в анализ не попадает»", "без источника — в анализ не попадает" in md, "строка в markdown")

    FakeSMTP.sent = []
    t = WORK / "m-onrequest"
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", FakeSMTP):
        rep = build(t, email_mode="on-request", smtp_transport=TRANSPORT, environ={"QA_SMTP_PASSWORD": "qa"},
                    agent_settings={"delivery": {"channels": ["email"], "auto_send": False, "addresses": ["tyurina@d-a.ru"]}})
    check("on-request при выключенной автоотправке всё равно шлёт (это ручная кнопка)", [x["status"] for x in rep["email"]] == ["sent"], rep["email_status"])

    t = WORK / "m-dry"
    rep = build(t, email_mode="always", dry_run=True, agent_settings=CHANNEL_OK)
    check("dry-run на пути сбора: записей нет, журнала нет, сеть не трогалась",
          rep["email"] == [] and not journal_of(t) and ("сухой прогон" in rep["email_status"] or "dry-run" in rep["email_status"]),
          rep["email_status"])

    t = WORK / "m-noaddr"
    no_addr_client = dict(CLIENT, recipients=[])
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", FakeSMTP):
        rep = build(t, client=no_addr_client, email_mode="always", smtp_transport=TRANSPORT,
                    environ={"QA_SMTP_PASSWORD": "qa"},
                    agent_settings={"delivery": {"channels": ["email"], "auto_send": True, "addresses": ["@telegram_only"]}})
    check("нет почтовых адресов (только телеграм): отказано словами, а не падение",
          bool(rep["email"]) and all(x["status"] != "sent" for x in rep["email"]) and "адрес" in rep["email_status"],
          rep["email_status"] + " · " + json.dumps(rep["email"], ensure_ascii=False)[:100])

    # ---------------- 3. CLI: дефолт и расписание ----------------
    print("3. CLI: дефолт режима и плановый запуск:")
    parser = collect_clients.build_parser()
    check("дефолт парсера collect_clients.py — never", parser.parse_args([]).email_mode == "never", parser.parse_args([]).email_mode)
    weekly = (PROJECT / "install" / "agent1-weekly.cmd").read_text(encoding="utf-8", errors="replace")
    check("плановый запуск install/agent1-weekly.cmd передаёт --email-mode always", "--email-mode always" in weekly, "строка найдена")
    proc = subprocess.run([sys.executable, str(SCRIPTS / "collect_clients.py"), "schedule",
                           "--clients-dir", str(PROJECT / "01-competitor-watch" / "config" / "clients")],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(SCRIPTS)))
    check("collect_clients.py schedule печатает --email-mode always", proc.returncode == 0 and "--email-mode always" in proc.stdout, (proc.stdout or proc.stderr).strip().splitlines()[-1][:90] if (proc.stdout or proc.stderr).strip() else "нет вывода")

    # ---------------- 4. CLI-прогон на КОПИЯХ с заглушкой транспорта ----------------
    print("4. Реальный CLI на копиях (заглушка транспорта и заглушка сбора, сеть не трогается):")
    clients_dir = WORK / "clients"
    data_dir = WORK / "data"
    reports_dir = WORK / "reports"
    registry_dir = WORK / "registry"
    (registry_dir / "agent-settings").mkdir(parents=True, exist_ok=True)
    # копия реестра для append_result/append_run (реальный registry/** не трогаем)
    (registry_dir / "results.yaml").write_text("results:\n", encoding="utf-8")
    (registry_dir / "runs.jsonl").write_text("", encoding="utf-8")
    clients_dir.mkdir(parents=True, exist_ok=True)
    (clients_dir / "qa-client.yaml").write_text(
        "version: 1\n"
        "client_id: client-qa\n"
        'name: "QA клиент"\n'
        "report:\n"
        '  title: "QA отчёт"\n'
        "  formats: [md]\n"
        "recipients:\n"
        '  - { channel: email, address: "tyurina@d-a.ru" }\n'
        "sources:\n"
        "  - { id: cian, enabled: false, mode: public-pages, auth: none }\n"
        "competitors:\n"
        '  - { id: qa-one, name: "QA ЖК Сайт", developer: "QA", class: "", site: "https://qa.example/", platforms: { cian: "", avito: "", yandex_realty: "", domclick: "" } }\n',
        encoding="utf-8")
    base_settings = (
        "agent1:\n"
        "  watch:\n"
        '    query: "https://qa.example/"\n'
        "delivery:\n"
        '  channels: ["email"]\n'
        "  auto_send: true\n"
        '  addresses: ["tyurina@d-a.ru"]\n')
    settings_file = registry_dir / "agent-settings" / "agent-1-competitor-watch.yaml"

    def run_cli(args, records, patch_transport=True):
        """main() на копиях; сбор всегда подменён, транспорт — по требованию."""
        def fake_deliver(files, recipients, out_dir, date, **kwargs):
            records.append({"recipients": list(recipients), "date": date, "kwargs": dict(kwargs),
                            "files": sorted(files.keys() if isinstance(files, dict) else map(str, files))})
            return [{"to": recipients[0], "status": "sent", "sent_at": "2026-11-04T12:00:00",
                     "file": None, "reason": None}] if recipients else []

        patches = [mock.patch.object(collect_clients, "collect_client", lambda *a, **k: ([], [], None))]
        if patch_transport:
            patches.append(mock.patch.object(delivery_email, "deliver_report", fake_deliver))
        with ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            rc = collect_clients.main(args)
        return rc

    settings_file.write_text(base_settings, encoding="utf-8")
    common = ["--client", "client-qa", "--clients-dir", str(clients_dir), "--reports-dir", str(reports_dir),
              "--data-dir", str(data_dir), "--registry-dir", str(registry_dir), "--date", DATE, "--no-browser"]
    # --no-config оставляем выключенным: гейт читает настоящий settings.yaml (только чтение)
    records: list = []
    rc = run_cli(common, records)
    check("CLI без --email-mode: exit 0 и НИ ОДНОГО вызова отправки", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))
    check("CLI без --email-mode: журнала email-*.json и .eml нет", not list(reports_dir.rglob("email-*.json")) and not list(reports_dir.rglob("*.eml")), "файлов отправки: 0")

    records = []
    rc = run_cli(common + ["--email-mode", "always"], records)
    check("CLI --email-mode always при auto_send=true и канале email: отправка вызвана", rc == 0 and len(records) == 1 and records[0]["recipients"] == ["tyurina@d-a.ru"], json.dumps([r["recipients"] for r in records], ensure_ascii=False))
    check("CLI always: в отправку ушёл последний готовый отчёт (формат md передан)", bool(records) and "md" in records[0]["files"], json.dumps(records[0]["files"], ensure_ascii=False)[:120] if records else "вызова не было")

    settings_file.write_text(base_settings.replace("auto_send: true", "auto_send: false"), encoding="utf-8")
    records = []
    rc = run_cli(common + ["--email-mode", "always"], records)
    check("CLI always при auto_send=false: отправка НЕ вызвана", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))
    settings_file.write_text(base_settings.replace('channels: ["email"]', 'channels: ["telegram"]'), encoding="utf-8")
    records = []
    rc = run_cli(common + ["--email-mode", "always"], records)
    check("CLI always при выключенном канале email: отправка НЕ вызвана", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))
    settings_file.write_text(base_settings, encoding="utf-8")

    records = []
    rc = run_cli(common + ["--email-mode", "always", "--dry-run"], records)
    check("CLI always + --dry-run (путь сбора): отправка НЕ вызвана", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))

    settings_file.write_text(base_settings, encoding="utf-8")
    records = []
    rc = run_cli(["--client", "client-qa", "--clients-dir", str(clients_dir), "--reports-dir", str(reports_dir),
                  "--data-dir", str(data_dir), "--registry-dir", str(registry_dir), "--send-only",
                  "--email-mode", "on-request"], records)
    check("CLI --send-only (кнопка «Отправить сейчас») отправляет последний отчёт", rc == 0 and len(records) == 1, "вызовов транспорта: %d" % len(records))
    records = []
    rc = run_cli(["--client", "client-qa", "--clients-dir", str(clients_dir), "--reports-dir", str(reports_dir),
                  "--data-dir", str(data_dir), "--registry-dir", str(registry_dir), "--send-only",
                  "--email-mode", "never"], records)
    check("CLI --send-only с режимом never: всё равно НЕ отправляет", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))

    # ---- 4б. D-DRY (task-8): --dry-run полностью запрещает отправку на пути --send-only ----
    def send_only_args(**over):
        base = dict(reports_dir=str(reports_dir), registry_dir=str(registry_dir),
                    email_mode="on-request", dry_run=False, config_dir=None, no_config=False)
        base.update(over)
        return type("A", (), base)()

    direct = collect_clients.cmd_send_only(CLIENT, send_only_args(dry_run=True))
    check("cmd_send_only(dry_run=True): записей нет, dryRun=true и причина словами",
          direct.get("sent") == [] and direct.get("dryRun") is True and "сухой прогон" in str(direct.get("status")),
          str(direct.get("status"))[:120])
    check("cmd_send_only(dry_run=True) не создаёт записей отправки в каталоге отчётов",
          not list(reports_dir.rglob("*.eml")), "файлов .eml: %d" % len(list(reports_dir.rglob("*.eml"))))

    def recording_smtp(sink):
        """Заглушка SMTP: фиксирует попытку соединения и сразу падает (сети нет)."""
        class _SMTP:
            def __init__(self, host, port, timeout=None):
                sink.append((host, port))
                raise RuntimeError("QA: соединение с SMTP перехвачено заглушкой")
        return _SMTP

    SEND_ONLY = ["--client", "client-qa", "--clients-dir", str(clients_dir),
                 "--reports-dir", str(reports_dir), "--data-dir", str(data_dir),
                 "--registry-dir", str(registry_dir), "--send-only", "--email-mode", "on-request"]

    records = []
    rc = run_cli(SEND_ONLY + ["--dry-run"], records)
    check("CLI --send-only --dry-run: транспорт НЕ вызван", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))

    journals_before = sorted(reports_dir.rglob("email-*.json"))
    eml_before = sorted(reports_dir.rglob("*.eml"))
    sink = []
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", recording_smtp(sink)):
        rc = run_cli(SEND_ONLY + ["--dry-run"], [], patch_transport=False)
    check("CLI --send-only --dry-run (настоящий deliver_report): SMTP-соединение НЕ открывалось",
          sink == [], "попыток соединения: %d %s" % (len(sink), sink[:1]))
    check("CLI --send-only --dry-run: новых журналов и .eml нет",
          sorted(reports_dir.rglob("email-*.json")) == journals_before and sorted(reports_dir.rglob("*.eml")) == eml_before,
          "журналов было %d, стало %d" % (len(journals_before), len(list(reports_dir.rglob("email-*.json")))))

    sink = []
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", recording_smtp(sink)):
        rc = run_cli(SEND_ONLY, [], patch_transport=False)
    check("контроль: без --dry-run --send-only реально идёт открывать SMTP (проверка выше не пустая)",
          bool(sink), "попыток соединения: %d, хост %s" % (len(sink), sink[:1]))

    # D-DRY, часть 2: --config-dir / --no-config уважаются (транспорт берётся не из основного settings.yaml)
    cfg_dir = WORK / "config-empty"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "settings.yaml").write_text('delivery:\n  email:\n    smtp_host: ""\n', encoding="utf-8")
    sink = []
    out = StringIO()
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", recording_smtp(sink)), redirect_stdout(out):
        rc = run_cli(SEND_ONLY + ["--config-dir", str(cfg_dir)], [], patch_transport=False)
    check("--config-dir уважается на send-only: без smtp_host SMTP не открывается", sink == [], "попыток соединения: %d" % len(sink))
    check("--config-dir уважается: причина отказа названа словами «нет SMTP-доступа»",
          "нет SMTP-доступа" in out.getvalue(), out.getvalue().strip().splitlines()[-1][:110] if out.getvalue().strip() else "нет вывода")
    sink = []
    with mock.patch.object(delivery_email.smtplib, "SMTP_SSL", recording_smtp(sink)):
        rc = run_cli(SEND_ONLY + ["--no-config"], [], patch_transport=False)
    check("--no-config уважается на send-only: settings.yaml не читается, SMTP не открывается", sink == [], "попыток соединения: %d" % len(sink))

    # D-DRY, часть 3: DASHBOARD_ACTIONS_DRY_RUN=1 включает сухой прогон и для движка
    check("dashboard_dry_run() читает только «1»",
          collect_clients.dashboard_dry_run({"DASHBOARD_ACTIONS_DRY_RUN": "1"}) is True
          and collect_clients.dashboard_dry_run({"DASHBOARD_ACTIONS_DRY_RUN": "0"}) is False
          and collect_clients.dashboard_dry_run({}) is False, "1/0/пусто")
    records = []
    with mock.patch.dict(os.environ, {"DASHBOARD_ACTIONS_DRY_RUN": "1"}):
        rc = run_cli(SEND_ONLY, records)
    check("DASHBOARD_ACTIONS_DRY_RUN=1 на пути send-only: транспорт не вызван", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))
    sink = []
    with mock.patch.dict(os.environ, {"DASHBOARD_ACTIONS_DRY_RUN": "1"}), \
            mock.patch.object(delivery_email.smtplib, "SMTP_SSL", recording_smtp(sink)):
        rc = run_cli(SEND_ONLY, [], patch_transport=False)
    check("DASHBOARD_ACTIONS_DRY_RUN=1: настоящее SMTP-соединение не открывается", sink == [], "попыток соединения: %d" % len(sink))
    records = []
    with mock.patch.dict(os.environ, {"DASHBOARD_ACTIONS_DRY_RUN": "1"}):
        rc = run_cli(common + ["--email-mode", "always"], records)
    check("DASHBOARD_ACTIONS_DRY_RUN=1 на пути сбора: письмо не отправляется", rc == 0 and records == [], "вызовов транспорта: %d" % len(records))

    send_src = (SCRIPTS / "collect_clients.py").read_text(encoding="utf-8")
    send_only_body = send_src.split("def cmd_send_only", 1)[1].split("\ndef ", 1)[0]
    check("в cmd_send_only есть защита dry_run и учёт config_dir/no_config",
          "dry_run" in send_only_body and "config_dir" in send_only_body and "no_config" in send_only_body,
          "найдено: dry_run=%s, config_dir=%s, no_config=%s" % ("dry_run" in send_only_body, "config_dir" in send_only_body, "no_config" in send_only_body))

    # ---------------- 5. сохранение настроек / «Обновить данные» почту не шлют ----------------
    print("5. Почта вне кнопки/расписания (статическая проверка маршрутов):")
    serve_src = (PROJECT / "dashboard" / "serve.mjs").read_text(encoding="utf-8")
    calls = re.findall(r"collect_clients\.py", serve_src)
    send_regions = [m.start() for m in re.finditer(r"collect_clients\.py", serve_src)]
    handler_starts = [m.start() for m in re.finditer(r"p === '/api/[a-z0-9/_-]+'", serve_src)]
    def handler_of(pos):
        prev = [h for h in handler_starts if h < pos]
        return serve_src[prev[-1]:pos] if prev else ""
    only_send_report = all("/api/agent1/send-report" in handler_of(pos) for pos in send_regions)
    check("вызов движка отправки есть ТОЛЬКО в обработчике /api/agent1/send-report", bool(calls) and only_send_report, "вхождений collect_clients.py: %d, все в send-report: %s" % (len(calls), only_send_report))
    collector_hits = 0
    for p in (PROJECT / "dashboard" / "collector").rglob("*.mjs"):
        text = p.read_text(encoding="utf-8", errors="replace")
        if re.search(r"collect_clients|deliver_report|smtplib|send_message", text):
            collector_hits += 1
    check("коллектор панели («Обновить данные») не содержит кода отправки почты", collector_hits == 0, "файлов с отправкой: %d" % collector_hits)

    shutil.rmtree(WORK, ignore_errors=True)
    print("")
    if DEFECTS:
        print("Подтверждённые дефекты:")
        for item in DEFECTS:
            print("  * " + item)
    print("Итог: OK %d, ПРОВАЛ %d" % (OK, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
