#!/usr/bin/env python3
r"""collect_clients.py - weekly run of Agent 1 for one client or all clients.

Pipeline per client:
  1. read config/clients/<client-id>.yaml (contract fixed by the Lead);
  2. collect the enabled sources:
       developer-sites - public pages of the developer (HTTP, no login);
       cian / avito / yandex-realty / domclick - public project pages, HTTP first,
       Chrome over CDP with a FRESH profile (never a logged-in account) as fallback;
  3. write the snapshot data/clients/<client-id>/snapshots/<date>/lots.csv;
  4. diff week-over-week + month-over-month, build the branded report (md/xlsx/docx/pdf);
  5. record the run: data/source-runs.jsonl, registry/runs.jsonl, registry/results.yaml.

Nothing is invented: a lot goes to the snapshot only when the page really has price,
area and rooms; the rest is reported as a count in the source note.

Usage:
    python collect_clients.py --client client-svet
    python collect_clients.py --date 2026-11-01 --no-browser
    python collect_clients.py schedule
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import cwlib as cw
import clients as clients_mod
import client_report
import platforms
import log_source_run
import sources_tool

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
REGISTRY_DIR = cw.PROJECT_ROOT / "registry"
COLLECT_DEVELOPER_SITES = cw.PROJECT_ROOT / "00-admin" / "scripts" / "collect-developer-sites.mjs"
NODE_CANDIDATES = platforms.NODE_CANDIDATES
SERVICE = "competitor-watch"
AGENT = "agent-1-competitor-watch"
MONTH_DAYS = 30


def find_node():
    for path in NODE_CANDIDATES:
        if path.exists():
            return path
    found = shutil_which("node")
    return Path(found) if found else None


def shutil_which(name):
    import shutil
    return shutil.which(name)


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# сбор
# --------------------------------------------------------------------------

def collect_developer_site(url, allow_browser=True):
    """Сайт застройщика: проверенный адаптер для zilart, иначе общий разбор страницы."""
    if "zilart.ru" in url:
        node = find_node()
        if node and COLLECT_DEVELOPER_SITES.exists():
            try:
                completed = subprocess.run([str(node), str(COLLECT_DEVELOPER_SITES), "--site", "zilart"],
                                           capture_output=True, text=True, encoding="utf-8",
                                           errors="replace", timeout=180)
                if completed.returncode == 0:
                    payload = json.loads(completed.stdout)
                    lots = []
                    for item in (payload.get("positions") or payload.get("items")
                                 or payload.get("lots") or []):
                        area = item.get("area_m2")
                        lots.append({
                            "price_rub": item.get("price_rub") or platforms.parse_price(item.get("price_text")),
                            "area_m2": float(str(area).replace(",", ".")) if area else None,
                            "rooms": item.get("rooms"),
                            "floor": item.get("floor"),
                            "floors_total": item.get("floors_total"),
                            "building": item.get("corpus") or item.get("building") or "",
                            "delivery": item.get("delivery") or "",
                            "promo_text": item.get("promo_text") or "",
                            "title": item.get("type_text") or "",
                        })
                    if lots:
                        note = ("адаптер zilart: цены «от» по позициям каталога (HTTP, без логина). "
                                "Гранулярность: %s. Ограничения: %s"
                                % (payload.get("granularity") or "позиция каталога",
                                   payload.get("limitations") or "нет данных"))
                        return {"source": "site", "platform": "site", "url": url, "status": "ok",
                                "note": note, "lots": lots, "granularity": "price-from-positions",
                                "price_from_rub": None, "transport": "http"}
            except Exception:
                pass
    return platforms.collect_platform(url, "site", allow_browser=allow_browser)


def lot_id_for(source, competitor, project, lot, index):
    material = "|".join([source, competitor, project, str(lot.get("title") or ""),
                         str(lot.get("price_rub")), str(lot.get("area_m2")), str(index)])
    return "%s-%s" % (source, hashlib.sha1(material.encode("utf-8")).hexdigest()[:8])


def lot_to_row(lot, source, competitor, project, date, index):
    """Строка контракта: только реально найденные значения, ничего не додумываем."""
    price = lot.get("price_rub")
    area = lot.get("area_m2")
    rooms = lot.get("rooms")
    if not price or not area or rooms is None:
        return None
    row = {column: "" for column in cw.COLUMNS}
    row.update({
        "snapshot_date": date,
        "source": platforms.status_column(source),
        "competitor": competitor,
        "project": project,
        "lot_id": lot_id_for(source, competitor, project, lot, index),
        "url": "",
        "rooms": rooms,
        "area_m2": area,
        "floor": lot.get("floor") or "",
        "floors_total": lot.get("floors_total") or "",
        "building": lot.get("building") or "",
        "price_rub": price,
        "price_per_m2_rub": int(round(price / area)) if area else "",
        "finish": "unknown",
        "promo_flag": 1 if lot.get("promo_text") else 0,
        "promo_text": lot.get("promo_text") or "",
        "delivery": lot.get("delivery") or "",
        "status": "active",
    })
    return row


def collect_client(client, date, allow_browser=True, dry_run=False, global_sources=None):
    """Собрать все включённые источники клиента. Возвращает результаты и строки снимка."""
    sources = {item["id"]: item for item in clients_mod.effective_sources(client, global_sources)}
    registry_names = {str(item.get("id")): str(item.get("name") or "") for item in (global_sources or [])
                      if isinstance(item, dict)}

    def source_name(source_id):
        return (platforms.PLATFORMS.get(source_id, {}).get("name")
                or registry_names.get(source_id) or source_id)

    competitors = [item for item in (client.get("competitors") or []) if isinstance(item, dict)]
    results = []
    rows = []
    seen_keys = set()

    def add_rows(lots, source_id, competitor_name, project_name):
        for index, lot in enumerate(lots):
            row = lot_to_row(lot, source_id, competitor_name, project_name, date, index)
            if row is None:
                continue
            key = (row["source"], row["competitor"], row["project"], row["lot_id"])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            rows.append(row)

    for source_id in clients_mod.KNOWN_SOURCES:
        config = sources.get(source_id)
        if config is None or not config["enabled"]:
            results.append({"source": source_id, "name": source_name(source_id),
                            "status": "skipped", "lots": 0, "projects": 0,
                            "note": "выключен в конфиге клиента" if config else "нет в конфиге клиента",
                            "url": None})
            continue

        if source_id == "manual-inbox":
            results.append({"source": source_id, "name": "Ручные материалы", "status": "no_data",
                            "lots": 0, "projects": 0, "note": "ждём материалы в inbox", "url": None})
            continue
        if source_id == "partner-feeds":
            results.append({"source": source_id, "name": "Партнёрские прайсы",
                            "status": "needs_partnership", "lots": 0, "projects": 0,
                            "note": "нужна выгрузка от застройщика", "url": None})
            continue

        platform_results = []
        for competition in competitors:
            if source_id == "developer-sites":
                url = competition.get("site")
            else:
                url = (competition.get("platforms") or {}).get(source_id) \
                    or (competition.get("platforms") or {}).get(source_id.replace("-", "_"))
            if not url:
                continue
            if dry_run:
                platform_results.append({"source": source_id, "status": "no_data", "url": url,
                                         "note": "dry-run: сбор не выполнялся", "lots": [],
                                         "granularity": "none", "price_from_rub": None})
                continue
            if source_id == "developer-sites":
                result = collect_developer_site(url, allow_browser=allow_browser)
            elif source_id in platforms.PLATFORMS:
                result = platforms.collect_platform(url, source_id, allow_browser=allow_browser,
                                                    expect_name=str(competition.get("name") or ""))
            else:
                result = platforms.collect_platform(url, "site", allow_browser=allow_browser,
                                                    expect_name=str(competition.get("name") or ""))
            platform_results.append(result)

        if not platform_results:
            results.append({"source": source_id, "name": source_name(source_id),
                            "status": "no_data", "lots": 0, "projects": 0,
                            "note": "в конфиге клиента нет ссылок на проекты для этого источника",
                            "url": None})
            continue

        found = 0
        incomplete = 0
        projects = set()
        notes = []
        statuses = []
        for result, competition in zip(platform_results, [c for c in competitors if
                                                          (c.get("site") if source_id == "developer-sites"
                                                           else (c.get("platforms") or {}).get(source_id)
                                                           or (c.get("platforms") or {}).get(source_id.replace("-", "_")))]):
            project_name = str(competition.get("name") or "")
            for lot in result.get("lots") or []:
                if lot.get("price_rub") and lot.get("area_m2") and lot.get("rooms") is not None:
                    found += 1
                    projects.add(project_name)
                else:
                    incomplete += 1
            add_rows(result.get("lots") or [], source_id, str(competition.get("developer") or ""), project_name)
            statuses.append(result.get("status"))
            note = result.get("note") or ""
            if result.get("price_from_rub"):
                note += "; цена «от» на странице: %s ₽" % cw.fmt_int(result["price_from_rub"])
            notes.append(note)

        incomplete_total = incomplete
        if found:
            status = "ok"
        elif incomplete_total:
            # цены на странице есть, но без площади/комнатности: в снимок такое не пишем
            status = "no_data"
        else:
            status = statuses[0] if statuses else "no_data"
        note = "; ".join(sorted({item for item in notes if item}))
        if incomplete:
            note += "; ещё %d цен без площади/комнатности — в снимок не попали (не додумываем)" % incomplete
        results.append({"source": source_id, "name": source_name(source_id),
                        "status": status, "lots": found, "projects": len(projects),
                        "note": note.strip("; "), "url": platform_results[0].get("url")})
    return results, rows


# --------------------------------------------------------------------------
# снимки клиента
# --------------------------------------------------------------------------

def client_data_dir(client_id, data_dir=None):
    return (Path(data_dir) if data_dir else WATCH_DIR / "data" / "clients") / str(client_id)


def snapshot_dir(client_id, date, data_dir=None):
    return client_data_dir(client_id, data_dir) / "snapshots" / date


def snapshot_dates(client_id, data_dir=None):
    base = client_data_dir(client_id, data_dir) / "snapshots"
    if not base.is_dir():
        return []
    return sorted(entry.name for entry in base.iterdir()
                  if entry.is_dir() and cw.DATE_RE.match(entry.name))


def load_snapshot(client_id, date, data_dir=None):
    path = snapshot_dir(client_id, date, data_dir) / "lots.csv"
    if not path.exists():
        return None, None
    return cw.load_snapshot_rows(path), path


def previous_date(client_id, date, data_dir=None):
    dates = [item for item in snapshot_dates(client_id, data_dir) if item < date]
    return dates[-1] if dates else None


def month_date(client_id, date, data_dir=None):
    """Последний снимок не новее (дата - 30 дней) — база для сравнения месяц к месяцу."""
    try:
        threshold = (dt.date.fromisoformat(date) - dt.timedelta(days=MONTH_DAYS)).isoformat()
    except ValueError:
        return None
    dates = [item for item in snapshot_dates(client_id, data_dir) if item <= threshold]
    return dates[-1] if dates else None


def write_snapshot(client_id, date, rows, data_dir=None, dry_run=False):
    path = snapshot_dir(client_id, date, data_dir) / "lots.csv"
    if dry_run:
        return path
    cw.write_csv(path, rows)
    return path


def by_source_counts(rows):
    counts = {}
    for row in rows or []:
        source = str(row.get("source") or "")
        counts[source] = counts.get(source, 0) + 1
    return counts


# --------------------------------------------------------------------------
# себестоимость и записи реестра
# --------------------------------------------------------------------------

def estimate_cost(model, chars_in, chars_out):
    """Оценка в рублях по prices.yaml: токены ≈ символы/4."""
    try:
        prices = cw.parse_simple_yaml(REGISTRY_DIR / "prices.yaml")
        entry = ((prices or {}).get("models") or {}).get(model) or {}
        rub_in = float(entry.get("rub_per_1m_in") or 0)
        rub_out = float(entry.get("rub_per_1m_out") or 0)
    except Exception:
        return 0.0, 0
    tokens_in = int(chars_in / 4)
    tokens_out = int(chars_out / 4)
    cost = tokens_in / 1_000_000 * rub_in + tokens_out / 1_000_000 * rub_out
    return round(cost, 4), tokens_in + tokens_out


def agent_model(agent_id=AGENT):
    try:
        registry = cw.parse_simple_yaml(REGISTRY_DIR / "agents.yaml")
        for item in (registry or {}).get("agents") or []:
            if str(item.get("id")) == agent_id:
                return str(item.get("model") or "deepseek/deepseek-v4.1-flash")
    except Exception:
        pass
    return "deepseek/deepseek-v4.1-flash"


def append_run(record, path=None):
    path = Path(path) if path else REGISTRY_DIR / "runs.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")
    return path


def _yaml_quote(value):
    if value is None:
        return "null"
    text = str(value).replace("\\", "/").replace('"', "'")
    return '"%s"' % text


def append_result(record, path=None):
    """Дописать результат в registry/results.yaml, сохранив комментарии и формат."""
    path = Path(path) if path else REGISTRY_DIR / "results.yaml"
    text = path.read_text(encoding="utf-8-sig")
    lines = text.rstrip("\n").splitlines()
    block = ["", "  - id: %s" % record["id"],
             "    title: %s" % _yaml_quote(record.get("title")),
             "    summary: %s" % _yaml_quote(record.get("summary")),
             "    client: %s" % (record.get("client") or "null"),
             "    project: %s" % (record.get("project") or "null"),
             "    period: %s" % _yaml_quote(record.get("period")),
             "    agent: %s" % record.get("agent"),
             "    service: %s" % record.get("service"),
             "    created: %s" % _yaml_quote(record.get("created")),
             "    artifacts:"]
    for artifact in record.get("artifacts") or []:
        block.append('      - "%s"' % str(artifact).replace("\\", "/"))
    if not record.get("artifacts"):
        block.append("      - null")
    block += ["    sent_channel: %s" % (record.get("sent_channel") or "none"),
              "    sent_to: %s" % _yaml_quote(record.get("sent_to") or ""),
              "    sent_at: %s" % (record.get("sent_at") or "null"),
              "    sent_status: %s" % _yaml_quote(record.get("sent_status") or "ожидает")]
    sources_tool.write_atomic(path, "\n".join(lines + block) + "\n", backup=True)
    return path


# --------------------------------------------------------------------------
# прогон одного клиента
# --------------------------------------------------------------------------

def run_client(client, date, args, global_sources=None):
    started = time.time()
    problems = clients_mod.validate_client(client)
    client_id = str(client.get("client_id"))
    print("")
    print("=== Клиент %s (%s) ===" % (client.get("name"), client_id))
    if problems:
        for problem in problems:
            print("  ПРОБЛЕМА: %s" % problem)
        return {"client": client_id, "status": "error", "problems": problems, "artifacts": []}

    results, rows = collect_client(client, date, allow_browser=not args.no_browser,
                                   dry_run=args.dry_run, global_sources=global_sources)
    print("  Источники:")
    for item in results:
        print("    %-16s %-18s лотов: %-4s %s"
              % (item["source"], item["status"], item.get("lots"),
                 (item.get("note") or "")[:70]))

    snapshot_file = write_snapshot(client_id, date, rows, data_dir=args.data_dir, dry_run=args.dry_run)
    print("  Снимок: %s (строк: %d)" % (snapshot_file, len(rows)))

    curr_rows = cw.load_snapshot_rows(snapshot_file) if snapshot_file.exists() else []
    prev = previous_date(client_id, date, args.data_dir)
    prev_rows = None
    if prev:
        prev_rows, _ = load_snapshot(client_id, prev, args.data_dir)
    month = month_date(client_id, date, args.data_dir)
    month_rows = None
    if month:
        month_rows, _ = load_snapshot(client_id, month, args.data_dir)

    config = cw.load_config(args.config_dir, use_config=not args.no_config)
    threshold = config["price_change_pct"]
    payload = compute_payload(prev_rows, curr_rows, prev, date, threshold, config)
    month_summary = None
    if month_rows is not None:
        month_payload = compute_payload(month_rows, curr_rows, month, date, threshold, config)
        month_summary = {"has_baseline": True, "prev_date": month,
                        "totals": month_payload["totals"],
                        "price_changes": month_payload["price_changes"],
                        "promo_new": month_payload["promo_new"],
                        "by_source": source_dynamics(month_rows, curr_rows)}
    else:
        month_summary = {"has_baseline": False}

    out_dir = Path(args.reports_dir) / client_id if args.reports_dir else \
        WATCH_DIR / "reports" / "clients" / client_id
    report = client_report.build_client_report(client, payload, curr_rows, results, month_summary,
                                               out_dir, date)
    for problem in report["problems"]:
        print("  ПРЕДУПРЕЖДЕНИЕ: %s" % problem)
    for kind, path in report["files"].items():
        print("  Отчёт (%s): %s" % (kind, path))

    journal_file = Path(args.data_dir) / "source-runs.jsonl" if args.data_dir else \
        WATCH_DIR / "data" / "source-runs.jsonl"
    duration_ms = int((time.time() - started) * 1000)
    chars_in = sum(len(json.dumps(item, ensure_ascii=False)) for item in results) + len(rows) * 120
    chars_out = sum(path.stat().st_size for path in report["files"].values() if Path(path).exists())
    cost_rub, tokens = estimate_cost(agent_model(), chars_in, chars_out)

    if not args.dry_run:
        for item in results:
            if item["status"] == "skipped":
                continue
            log_source_run.append_entry({"ts": log_source_run.now_iso(), "source": item["source"],
                                         "status": {"ok": "ok", "no_data": "empty"}.get(item["status"], "partial"),
                                         "lots": item.get("lots"), "projects": item.get("projects"),
                                         "note": (item.get("note") or "")[:180]}, journal_file)
        artifact = report["files"].get("pdf") or report["files"].get("md")
        run_record = {"run_id": "run-%s" % hashlib.sha1(("%s-%s-%s" % (client_id, date, time.time()))
                                                        .encode()).hexdigest()[:8],
                      "ts": dt.datetime.now().astimezone().isoformat(timespec="milliseconds"),
                      "service": SERVICE, "client": client_id, "agent": AGENT,
                      "status": "ok" if report["files"] else "error",
                      "duration_ms": duration_ms, "cost_rub": cost_rub,
                      "artifact": str(artifact) if artifact else None,
                      "error": "; ".join(report["problems"]) or None}
        append_run(run_record, args.registry_dir and Path(args.registry_dir) / "runs.jsonl" or None)

        artifacts = [str(Path(path).relative_to(cw.PROJECT_ROOT)).replace("\\", "/")
                     for path in report["files"].values()]
        recipients = client.get("recipients") or []
        first = recipients[0] if recipients and isinstance(recipients[0], dict) else {}
        result_record = {"id": "res-%s-%s" % (date, client_id.replace("client-", "")),
                         "title": "%s: %s за %s" % (client.get("name"),
                                                    clients_mod.report_of(client)["title"], date),
                         "summary": "Собрано источников: %d, лотов в снимке: %d, статусы: %s"
                                    % (len([r for r in results if r["status"] != "skipped"]), len(rows),
                                       ", ".join("%s=%s" % (r["source"], r["status"]) for r in results
                                                 if r["status"] != "skipped")),
                         "client": client_id,
                         "project": ((client.get("competitors") or [{}])[0].get("project")
                                     if client.get("competitors") else None),
                         "period": "%s — %s" % (prev or "нет", date),
                         "agent": AGENT, "service": SERVICE,
                         "created": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                         "artifacts": artifacts,
                         "sent_channel": first.get("channel") or "none",
                         "sent_to": first.get("address") or "",
                         "sent_at": None, "sent_status": "ожидает"}
        append_result(result_record, args.registry_dir and Path(args.registry_dir) / "results.yaml" or None)
        print("  Запись прогона: registry/runs.jsonl (cost_rub=%s, ~%s токенов)" % (cost_rub, tokens))
        print("  Запись результата: registry/results.yaml (статус отправки: ожидает)")

    return {"client": client_id, "status": "ok", "rows": len(rows), "sources": results,
            "artifacts": [str(path) for path in report["files"].values()],
            "cost_rub": cost_rub, "tokens": tokens, "month": month_summary,
            "problems": report["problems"]}


def compute_payload(prev_rows, curr_rows, prev_date, curr_date, threshold, config):
    import diff_snapshots
    return diff_snapshots.compute_diff(prev_rows, curr_rows, threshold, prev_date, curr_date,
                                       config=config)


def source_dynamics(prev_rows, curr_rows):
    prev_counts = by_source_counts(prev_rows)
    curr_counts = by_source_counts(curr_rows)
    sources = sorted(set(prev_counts) | set(curr_counts))
    return [{"source": source, "prev": prev_counts.get(source, 0), "curr": curr_counts.get(source, 0)}
            for source in sources]


# --------------------------------------------------------------------------
# расписание
# --------------------------------------------------------------------------

def cmd_schedule(args):
    clients = clients_mod.load_clients(args.clients_dir)
    if args.client:
        clients = [item for item in clients if str(item.get("client_id")) == args.client]
    if not clients:
        print("Клиентов нет в %s" % (args.clients_dir or clients_mod.CLIENTS_DIR))
        return 0
    print("Расписание недельного прогона Агента 1")
    print("%-16s %-12s %-8s %s" % ("client_id", "день", "время", "команда"))
    for client in clients:
        schedule = clients_mod.schedule_of(client)
        command = ("python marketing-agents/01-competitor-watch/scripts/collect_clients.py "
                   "--client %s" % client.get("client_id"))
        print("%-16s %-12s %-8s %s" % (client.get("client_id"), schedule["weekday_ru"],
                                       schedule["time"], command))
    print("")
    print("Регистрация в планировщике Windows (выполняет человек, скрипт сам ничего не создаёт):")
    for client in clients:
        schedule = clients_mod.schedule_of(client)
        print('  schtasks /Create /TN "Agent1-%s" /SC WEEKLY /D %s /ST %s /TR "powershell -NoProfile '
              '-ExecutionPolicy Bypass -File marketing-agents/01-competitor-watch/scripts/run_client.ps1 '
              '-Client %s" /F'
              % (client.get("client_id"), schedule["weekday"].upper()[:3], schedule["time"],
                 client.get("client_id")))
    return 0


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(prog="collect_clients.py",
                                     description="Недельный прогон Агента 1 по клиентам: сбор, отчёт, записи.")
    parser.add_argument("--client", default=None, help="id клиента; без него — все клиенты")
    parser.add_argument("--clients-dir", default=None, help="каталог конфигов клиентов")
    parser.add_argument("--date", default=None, help="дата прогона YYYY-MM-DD (по умолчанию сегодня)")
    parser.add_argument("--no-browser", action="store_true", help="не поднимать Chrome (только HTTP)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не писать, только показать")
    parser.add_argument("--data-dir", default=None, help="каталог данных клиентов (по умолчанию data)")
    parser.add_argument("--reports-dir", default=None, help="каталог отчётов (по умолчанию reports/clients)")
    parser.add_argument("--registry-dir", default=None, help="каталог registry (для тестов)")
    parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config")
    parser.add_argument("--no-config", action="store_true", help="не читать settings.yaml")
    return parser


def main(argv=None):
    setup_console()
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "schedule":
        parser = build_parser()
        args = parser.parse_args(["--client", ""] + [a for a in argv[1:]])
        args.client = None
        return cmd_schedule(args)
    args = build_parser().parse_args(argv)
    date = args.date or dt.date.today().isoformat()
    clients = clients_mod.load_clients(args.clients_dir)
    if args.client:
        clients = [item for item in clients if str(item.get("client_id")) == args.client]
    if not clients:
        print("Клиентов не найдено (каталог: %s)" % (args.clients_dir or clients_mod.CLIENTS_DIR))
        return 1
    try:
        global_sources = sources_tool.read_sources(REGISTRY_DIR / "sources.yaml")
    except Exception:
        global_sources = []
    summaries = []
    for client in clients:
        summaries.append(run_client(client, date, args, global_sources))
    print("")
    print("=== Итог ===")
    for summary in summaries:
        if summary.get("status") != "ok":
            print("  %s: ОШИБКА (%s)" % (summary.get("client"), "; ".join(summary.get("problems") or [])))
            continue
        print("  %s: лотов %d, источников %d, себестоимость ~%.2f ₽, файлов %d"
              % (summary["client"], summary["rows"], len(summary["sources"]),
                 summary["cost_rub"], len(summary["artifacts"])))
    return 0 if all(item.get("status") == "ok" for item in summaries) else 1


if __name__ == "__main__":
    sys.exit(main())
