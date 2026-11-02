#!/usr/bin/env python3
r"""clients.py - client configs for Agent 1 (contract fixed by the Lead).

File: marketing-agents/01-competitor-watch/config/clients/<client-id>.yaml

    client_id: client-svet
    name: "ЖК «Свет»"
    brand: { logo: "assets/logo.png", accent: "#7553ff" }
    schedule: { weekday: monday, time: "10:00" }
    report: { title: "Мониторинг конкурентов", formats: [md, xlsx, pdf] }
    recipients: [ { channel: telegram, address: "@..." } ]
    sources:
      - { id: cian, enabled: true, mode: public-pages, auth: none }
    competitors:
      - name: "Селигер Сити"
        developer: "MR Group"
        class: "бизнес"
        site: "https://..."
        platforms: { cian: "https://...", domclick: "https://..." }

A client file overrides the global registry/sources.yaml toggles; global settings
(thresholds, promo dictionary) stay global. Never uses logins: every source carries
auth: none and the collectors only read public pages.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cwlib as cw

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
CLIENTS_DIR = WATCH_DIR / "config" / "clients"
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
WEEKDAY_RU = {"monday": "понедельник", "tuesday": "вторник", "wednesday": "среда",
              "thursday": "четверг", "friday": "пятница", "saturday": "суббота",
              "sunday": "воскресенье"}
KNOWN_SOURCES = ("developer-sites", "partner-feeds", "manual-inbox", "cian", "avito",
                 "yandex-realty", "domclick")
PUBLIC_PAGE_SOURCES = ("cian", "avito", "yandex-realty", "domclick")
FORBIDDEN_AUTH = ("none", None, "")


def load_clients(clients_dir=None):
    """All client configs from the directory, sorted by file name."""
    directory = Path(clients_dir) if clients_dir else CLIENTS_DIR
    if not directory.is_dir():
        return []
    clients = []
    for path in sorted(directory.glob("*.yaml")):
        try:
            data = cw.parse_simple_yaml(path)
        except Exception as exc:
            raise ValueError("не удалось прочитать %s: %s" % (path, exc))
        if not isinstance(data, dict):
            raise ValueError("ожидался словарь в %s" % path)
        data["__file"] = str(path)
        data.setdefault("client_id", path.stem)
        clients.append(data)
    return clients


def find_client(clients_dir, client_id):
    for client in load_clients(clients_dir):
        if str(client.get("client_id")) == str(client_id):
            return client
    return None


def validate_client(client):
    """Contract checks; returns a list of problems (empty = ok)."""
    problems = []
    if not client.get("client_id"):
        problems.append("нет client_id")
    if not str(client.get("name") or "").strip():
        problems.append("нет name")
    schedule = client.get("schedule") or {}
    if schedule:
        weekday = str(schedule.get("weekday") or "").lower()
        if weekday and weekday not in WEEKDAYS:
            problems.append("schedule.weekday=%s не из списка %s" % (weekday, ", ".join(WEEKDAYS)))
        time_value = str(schedule.get("time") or "")
        if time_value and not cw.re.match(r"^[0-2][0-9]:[0-5][0-9]$", time_value):
            problems.append("schedule.time=%s не в формате HH:MM" % time_value)
    report = client.get("report") or {}
    for fmt in report.get("formats") or []:
        if str(fmt).lower() not in ("md", "xlsx", "pdf", "docx"):
            problems.append("report.formats: неизвестный формат %s" % fmt)
    for source in client.get("sources") or []:
        if not isinstance(source, dict) or not source.get("id"):
            problems.append("sources: элемент без id")
            continue
        auth = source.get("auth")
        if auth not in FORBIDDEN_AUTH:
            problems.append("sources.%s: авторизация запрещена (auth: %s), работаем только без логина"
                            % (source.get("id"), auth))
        mode = source.get("mode")
        if mode and str(mode) != "public-pages":
            problems.append("sources.%s: поддерживается только mode: public-pages" % source.get("id"))
    for competition in client.get("competitors") or []:
        if not isinstance(competition, dict) or not competition.get("name"):
            problems.append("competitors: элемент без name")
    return problems


def effective_sources(client, global_sources=None):
    """Client sources override the global registry toggles (by id)."""
    global_enabled = {}
    for item in global_sources or []:
        if isinstance(item, dict) and item.get("id"):
            global_enabled[str(item["id"])] = item.get("enabled") is True
    result = []
    for source in client.get("sources") or []:
        if not isinstance(source, dict) or not source.get("id"):
            continue
        source_id = str(source["id"])
        enabled = source.get("enabled")
        if enabled is None:
            enabled = global_enabled.get(source_id, False)
        result.append({
            "id": source_id,
            "enabled": bool(enabled),
            "mode": str(source.get("mode") or "public-pages"),
            "auth": "none",
            "declared": not (source_id in PUBLIC_PAGE_SOURCES and source.get("mode") is None),
        })
    return result


def brand_of(client, base_dir=None):
    """Brand block with an absolute logo path when the file exists."""
    brand = dict(client.get("brand") or {})
    accent = str(brand.get("accent") or "#7553ff")
    if not cw.re.match(r"^#[0-9a-fA-F]{6}$", accent):
        accent = "#7553ff"
    logo = brand.get("logo")
    logo_path = None
    if logo:
        candidate = Path(str(logo))
        roots = [Path(base_dir) if base_dir else None, Path(client.get("__file") or ".").parent, WATCH_DIR,
                 cw.PROJECT_ROOT]
        for root in roots:
            if root is None:
                continue
            candidate_path = candidate if candidate.is_absolute() else Path(root) / candidate
            if candidate_path.exists():
                logo_path = candidate_path
                break
    return {"accent": accent, "logo": logo, "logo_path": logo_path}


def schedule_of(client):
    schedule = client.get("schedule") or {}
    weekday = str(schedule.get("weekday") or "monday").lower()
    return {"weekday": weekday if weekday in WEEKDAYS else "monday",
            "weekday_ru": WEEKDAY_RU.get(weekday, weekday),
            "time": str(schedule.get("time") or "10:00")}


def report_of(client):
    report = client.get("report") or {}
    formats = [str(item).lower() for item in (report.get("formats") or ["md", "xlsx", "pdf"])]
    return {"title": str(report.get("title") or "Мониторинг конкурентов"), "formats": formats}


def platform_targets(client):
    """[(source_id, platform, url, competitor_name)] from competitors[].platforms."""
    targets = []
    for competition in client.get("competitors") or []:
        if not isinstance(competition, dict):
            continue
        platforms = competition.get("platforms") or {}
        if isinstance(platforms, dict):
            for platform, url in platforms.items():
                if url:
                    targets.append((str(platform).replace("-", "_"), str(platform),
                                    str(url), str(competition.get("name") or "")))
    return targets


def build_parser():
    parser = argparse.ArgumentParser(prog="clients.py",
                                     description="Клиентские конфиги Агента 1: список, проверка, источники.")
    parser.add_argument("--clients-dir", default=None, help="каталог конфигов клиентов")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="список клиентов")
    check = sub.add_parser("check", help="проверить конфиги по контракту")
    check.add_argument("--client", default=None, help="только один клиент")
    show = sub.add_parser("show", help="показать клиента целиком")
    show.add_argument("--client", required=True)
    return parser


def main(argv=None):
    cw.setup_console()
    args = build_parser().parse_args(argv)
    clients = load_clients(args.clients_dir)
    if not clients:
        print("Конфигов клиентов нет в %s" % (args.clients_dir or CLIENTS_DIR))
        return 0
    if args.command == "list":
        print("%-16s %-28s %-24s %s" % ("client_id", "name", "расписание", "источников"))
        for client in clients:
            schedule = schedule_of(client)
            sources = effective_sources(client)
            print("%-16s %-28s %-24s %d (вкл: %d)" % (
                client.get("client_id"), str(client.get("name"))[:28],
                "%s %s" % (schedule["weekday_ru"], schedule["time"]),
                len(sources), sum(1 for item in sources if item["enabled"])))
        return 0
    if args.command == "check":
        problems_total = 0
        for client in clients:
            if args.client and str(client.get("client_id")) != args.client:
                continue
            problems = validate_client(client)
            problems_total += len(problems)
            status = "OK" if not problems else "ПРОБЛЕМЫ"
            print("%s %s" % (status, client.get("client_id")))
            for problem in problems:
                print("   - %s" % problem)
        return 1 if problems_total else 0
    if args.command == "show":
        client = find_client(args.clients_dir, args.client)
        if client is None:
            print("Клиент не найден: %s" % args.client, file=sys.stderr)
            return 1
        for key in ("client_id", "name", "brand", "schedule", "report", "recipients", "sources",
                    "competitors", "__file"):
            if key in client:
                print("%-12s %s" % (key + ":", client.get(key)))
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
