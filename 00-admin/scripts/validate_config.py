#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Validate Agent 1 configs.

Checks:
  * global configs: 00-admin/config/{my-objects,competitors,settings}.yaml
  * client configs: 01-competitor-watch/config/clients/<client-id>.yaml
    (contract fixed by the Lead: client_id, name, brand, schedule, report,
     recipients, sources, competitors)

Usage (from marketing-agents\00-admin):
    python scripts\validate_config.py

Exit code 0 = OK, 1 = errors found.
The checker never edits files; it only reads and reports.
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

# The Windows console defaults to a legacy code page (866), which turns the
# Russian report text into mojibake. Force UTF-8 for our own output so the
# checker stays readable when run from PowerShell or cmd.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent      # marketing-agents
CONFIG_DIR = PROJECT_DIR / "00-admin" / "config"
CLIENT_DIR = PROJECT_DIR / "01-competitor-watch" / "config" / "clients"

REQUIRED_FILES = ("my-objects.yaml", "competitors.yaml", "settings.yaml")

# --- клиентские конфиги (контракт Lead, task-49) ---------------------------
CLIENT_REQUIRED = ("client_id", "name", "brand", "schedule", "report",
                   "recipients", "sources", "competitors")
CLIENT_BRAND_REQUIRED = ("logo", "accent")
CLIENT_SCHEDULE_REQUIRED = ("weekday", "time")
CLIENT_REPORT_REQUIRED = ("title", "formats")
CLIENT_COMPETITOR_REQUIRED = ("name", "developer", "class", "site", "platforms")
CLIENT_PLATFORM_KEYS = ("cian", "avito", "yandex_realty", "domclick")
ALLOWED_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday",
                    "friday", "saturday", "sunday")
ALLOWED_FORMATS = ("md", "xlsx", "pdf")
ALLOWED_CHANNELS = ("telegram", "email")
KNOWN_SOURCE_IDS = ("developer-sites", "partner-feeds", "manual-inbox",
                    "cian", "avito", "yandex-realty", "domclick")
KNOWN_MODES = ("public-pages", "file", "browser")
# Источники, которые на 01.11.2026 фактически закрыты для обычного HTTP:
# включать их можно, но валидатор предупреждает (не ошибка).
BLOCKED_SOURCE_IDS = ("avito", "domclick")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

OUR_PROJECT_REQUIRED = (
    "id", "name", "developer", "class", "okrug", "location",
    "start_of_sales", "delivery", "site_url", "usp",
)
COMPETITOR_REQUIRED = (
    "id", "name", "developer", "class", "okrug", "location",
    "delivery", "cian_url", "priority",
)
ALLOWED_CLASSES = ("премиум", "бизнес")
ALLOWED_PRIORITIES = ("high", "medium", "low")
ALLOWED_OUR_CLASSES = ("премиум", "бизнес")

CONTRACT_COLUMNS = [
    "snapshot_date", "source", "competitor", "project", "lot_id", "url",
    "rooms", "area_m2", "floor", "floors_total", "building", "price_rub",
    "price_per_m2_rub", "finish", "promo_flag", "promo_text", "delivery",
    "status",
]

REPORT_SECTION_COUNT = 9
DELIVERY_RE = re.compile(r"^\d{4}-Q[1-4]$")
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
URL_RE = re.compile(r"^https?://")


def fail(errors: list, msg: str) -> None:
    errors.append(msg)
    print("  [ERROR] " + msg)


def load_yaml(path: Path):
    """Load YAML via PyYAML, or via node + js-yaml when PyYAML is absent."""
    try:
        import yaml  # type: ignore

        with io.open(path, "r", encoding="utf-8-sig") as fh:
            return yaml.safe_load(fh)
    except ImportError:
        return _load_yaml_via_node(path)


def _node_candidates():
    import os

    home = Path(os.path.expanduser("~"))
    return [
        home / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies"
        / "node" / "bin" / "node.exe",
        home / ".dsh" / "profiles" / "desktop"
        / "node_modules" / "js-yaml" / "index.js",
    ]


def _load_yaml_via_node(path: Path):
    """Fallback parser: requires node + js-yaml, both shipped with DSH."""
    import json
    import os
    import subprocess
    import tempfile

    node_exe, js_yaml = _node_candidates()
    if not node_exe.exists() or not js_yaml.exists():
        raise RuntimeError(
            "PyYAML is not installed and node/js-yaml was not found at "
            + str(node_exe)
        )
    script = (
        "const y = await import(process.argv[2]);"
        "const fs = await import('node:fs');"
        "const yaml = y.default ?? y; const f = fs.default ?? fs;"
        "process.stdout.write(JSON.stringify(yaml.load(f.readFileSync(process.argv[3],'utf8'))));"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False,
                                     encoding="utf-8") as tmp:
        tmp.write(script)
        tmp_path = tmp.name
    try:
        url = js_yaml.resolve().as_uri()
        proc = subprocess.run(
            [str(node_exe), tmp_path, url, str(path.resolve())],
            capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                "node/js-yaml failed for %s: %s" % (path.name, proc.stderr.strip())
            )
        return json.loads(proc.stdout)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def warn(warnings: list, msg: str) -> None:
    warnings.append(msg)
    print("  [WARN] " + msg)


def check_clients(errors: list) -> None:
    """Validate client configs: 01-competitor-watch/config/clients/*.yaml."""
    warnings: list = []
    print("")
    print("Клиентские конфиги: " + str(CLIENT_DIR))
    if not CLIENT_DIR.exists():
        warn(warnings, "каталог клиентских конфигов не найден: " + str(CLIENT_DIR))
        return
    files = sorted(CLIENT_DIR.glob("*.yaml"))
    if not files:
        warn(warnings, "в " + str(CLIENT_DIR) + " нет ни одного *.yaml")
        return

    for path in files:
        label = "clients/" + path.name
        try:
            doc = load_yaml(path) or {}
        except Exception as exc:  # noqa: BLE001
            fail(errors, label + ": не удалось прочитать YAML -> " + str(exc))
            continue
        if not isinstance(doc, dict):
            fail(errors, label + ": файл должен быть словарём (mapping)")
            continue

        for field in CLIENT_REQUIRED:
            if not doc.get(field):
                fail(errors, label + ": нет обязательного блока/поля " + field)
        cid = str(doc.get("client_id") or "")
        if cid and cid != path.stem:
            fail(errors, label + ": client_id '%s' не совпадает с именем файла '%s'"
                 % (cid, path.stem))

        brand = doc.get("brand") or {}
        if isinstance(brand, dict):
            for field in CLIENT_BRAND_REQUIRED:
                if not str(brand.get(field) or "").strip():
                    fail(errors, label + ": brand." + field + " пуст")
            accent = str(brand.get("accent") or "")
            if accent and not ACCENT_RE.match(accent):
                fail(errors, label + ": brand.accent должен быть в формате #RRGGBB")
        else:
            fail(errors, label + ": brand должен быть словарём {logo, accent}")

        schedule = doc.get("schedule") or {}
        if isinstance(schedule, dict):
            for field in CLIENT_SCHEDULE_REQUIRED:
                if not str(schedule.get(field) or "").strip():
                    fail(errors, label + ": schedule." + field + " пуст")
            if schedule.get("weekday") and str(schedule["weekday"]) not in ALLOWED_WEEKDAYS:
                fail(errors, label + ": schedule.weekday должен быть monday..sunday")
            if schedule.get("time") and not TIME_RE.match(str(schedule["time"])):
                fail(errors, label + ": schedule.time должен быть HH:MM (24 часа)")
        else:
            fail(errors, label + ": schedule должен быть словарём {weekday, time}")

        report = doc.get("report") or {}
        if isinstance(report, dict):
            for field in CLIENT_REPORT_REQUIRED:
                if not report.get(field):
                    fail(errors, label + ": report." + field + " пуст")
            for fmt in [str(x) for x in (report.get("formats") or [])]:
                if fmt not in ALLOWED_FORMATS:
                    fail(errors, label + ": report.formats -> '%s' не из списка %s"
                         % (fmt, ", ".join(ALLOWED_FORMATS)))
        else:
            fail(errors, label + ": report должен быть словарём {title, formats}")

        recipients = doc.get("recipients") or []
        if not isinstance(recipients, list) or not recipients:
            fail(errors, label + ": recipients должен быть непустым списком")
        else:
            for i, rcpt in enumerate(recipients, 1):
                if not isinstance(rcpt, dict):
                    fail(errors, label + ": recipients[%d] — не структура" % i)
                    continue
                channel = str(rcpt.get("channel") or "")
                if channel not in ALLOWED_CHANNELS:
                    fail(errors, label + ": recipients[%d].channel '%s' не из списка telegram, email"
                         % (i, channel))
                if not str(rcpt.get("address") or "").strip():
                    warn(warnings, label + ": recipients[%d] (%s) без address — TODO для пользователя"
                         % (i, channel or "?"))

        sources = doc.get("sources") or []
        if not isinstance(sources, list) or not sources:
            fail(errors, label + ": sources должен быть непустым списком")
        else:
            seen_ids: list = []
            for i, src in enumerate(sources, 1):
                if not isinstance(src, dict):
                    fail(errors, label + ": sources[%d] — не структура" % i)
                    continue
                sid = str(src.get("id") or "")
                if not sid:
                    fail(errors, label + ": sources[%d] без id" % i)
                    continue
                if sid not in KNOWN_SOURCE_IDS:
                    fail(errors, label + ": sources[%d].id '%s' неизвестен (см. registry/sources.yaml)"
                         % (i, sid))
                if sid in seen_ids:
                    fail(errors, label + ": источник '%s' указан дважды" % sid)
                seen_ids.append(sid)
                if not isinstance(src.get("enabled"), bool):
                    fail(errors, label + ": sources[%d] (%s).enabled должен быть true/false" % (i, sid))
                mode = src.get("mode")
                if mode is not None and str(mode) not in KNOWN_MODES:
                    fail(errors, label + ": sources[%d] (%s).mode '%s' неизвестен" % (i, sid, mode))
                auth = src.get("auth")
                if auth is not None and str(auth) != "none":
                    fail(errors, label + ": sources[%d] (%s).auth должен быть none (публичные страницы)"
                         % (i, sid))
                if sid in BLOCKED_SOURCE_IDS and src.get("enabled") is True:
                    warn(warnings, label + ": источник '%s' включён, но на 01.11.2026 закрыт для "
                                        "обычного HTTP — см. 00-admin/research/"
                                        "platforms-public-pages-2026-11-01.md" % sid)

        competitors = doc.get("competitors") or []
        if not isinstance(competitors, list) or not competitors:
            fail(errors, label + ": competitors должен быть непустым списком")
        else:
            seen_names: list = []
            for i, comp in enumerate(competitors, 1):
                if not isinstance(comp, dict):
                    fail(errors, label + ": competitors[%d] — не структура" % i)
                    continue
                cname = str(comp.get("name") or "")
                ctag = label + ": competitors[%d] (%s)" % (i, cname or "?")
                for field in CLIENT_COMPETITOR_REQUIRED:
                    if field not in comp:
                        fail(errors, ctag + ": нет поля " + field)
                if not cname:
                    fail(errors, ctag + ": пустое name")
                if cname in seen_names:
                    fail(errors, ctag + ": конкурент с таким именем уже есть в файле")
                seen_names.append(cname)
                if comp.get("class") and str(comp["class"]) not in ALLOWED_CLASSES:
                    fail(errors, ctag + ": class должен быть премиум или бизнес")
                site = str(comp.get("site") or "").strip()
                if site and not URL_RE.match(site):
                    fail(errors, ctag + ": site должен начинаться с http:// или https://")
                platforms = comp.get("platforms")
                if platforms is None:
                    fail(errors, ctag + ": нет блока platforms")
                    continue
                if not isinstance(platforms, dict):
                    fail(errors, ctag + ": platforms должен быть словарём")
                    continue
                for key in CLIENT_PLATFORM_KEYS:
                    if key not in platforms:
                        fail(errors, ctag + ": platforms." + key + " отсутствует "
                                             "(пустая строка = TODO)")
                        continue
                    value = str(platforms.get(key) or "").strip()
                    if value and not URL_RE.match(value):
                        fail(errors, ctag + ": platforms." + key + " должен начинаться с https://")
                filled = [k for k in CLIENT_PLATFORM_KEYS if str(platforms.get(k) or "").strip()]
                if not filled and not site:
                    warn(warnings, ctag + ": ни сайта, ни ссылок на площадки — проверять нечего "
                                          "(TODO для пользователя)")

        print("  [OK] %s (источников %d, конкурентов %d)"
              % (path.name, len(doc.get("sources") or []), len(doc.get("competitors") or [])))

    if warnings:
        print("")
        print("ПРЕДУПРЕЖДЕНИЙ: %d — они не блокируют запуск" % len(warnings))


def check_configs() -> int:
    errors: list = []
    data: dict = {}

    print("Проверка конфигов: " + str(CONFIG_DIR))
    print("")

    for name in REQUIRED_FILES:
        path = CONFIG_DIR / name
        if not path.exists():
            fail(errors, "не найден файл " + name)
            continue
        try:
            data[name] = load_yaml(path)
        except Exception as exc:  # noqa: BLE001
            fail(errors, name + ": не удалось прочитать YAML -> " + str(exc))
            continue
        print("  [OK] " + name + " — YAML корректен")

    # --- my-objects.yaml -------------------------------------------------
    if "my-objects.yaml" in data:
        doc = data["my-objects.yaml"] or {}
        projects = doc.get("our_projects") or []
        if not projects:
            fail(errors, "my-objects.yaml: список our_projects пуст")
        ids = []
        for i, p in enumerate(projects, 1):
            label = "my-objects.yaml: ЖК #%d" % i
            if not isinstance(p, dict):
                fail(errors, label + " — это не структура (проверьте отступы)")
                continue
            label = "my-objects.yaml: %s" % (p.get("id") or ("ЖК #%d" % i))
            for field in OUR_PROJECT_REQUIRED:
                if not str(p.get(field) or "").strip():
                    fail(errors, label + ": нет обязательного поля " + field)
            if p.get("class") not in ALLOWED_OUR_CLASSES:
                fail(errors, label + ": class должен быть премиум или бизнес")
            if p.get("start_of_sales") and not MONTH_RE.match(str(p["start_of_sales"])):
                fail(errors, label + ": start_of_sales должен быть YYYY-MM")
            if p.get("delivery") and not DELIVERY_RE.match(str(p["delivery"])):
                fail(errors, label + ": delivery должен быть YYYY-QN")
            if p.get("site_url") and not URL_RE.match(str(p["site_url"])):
                fail(errors, label + ": site_url должен начинаться с http:// или https://")
            pid = str(p.get("id") or "")
            if pid in ids:
                fail(errors, label + ": повторяющийся id")
            ids.append(pid)

    # --- competitors.yaml ------------------------------------------------
    comp_ids = []
    if "competitors.yaml" in data:
        doc = data["competitors.yaml"] or {}
        comps = doc.get("competitors") or []
        if not comps:
            fail(errors, "competitors.yaml: список competitors пуст")
        for i, c in enumerate(comps, 1):
            if not isinstance(c, dict):
                fail(errors, "competitors.yaml: конкурент #%d — не структура" % i)
                continue
            label = "competitors.yaml: %s" % (c.get("id") or ("конкурент #%d" % i))
            for field in COMPETITOR_REQUIRED:
                if not str(c.get(field) or "").strip():
                    fail(errors, label + ": нет обязательного поля " + field)
            if c.get("class") not in ALLOWED_CLASSES:
                fail(errors, label + ": class должен быть премиум или бизнес")
            if c.get("priority") not in ALLOWED_PRIORITIES:
                fail(errors, label + ": priority должен быть high, medium или low")
            if c.get("delivery") and not DELIVERY_RE.match(str(c["delivery"])):
                fail(errors, label + ": delivery должен быть YYYY-QN")
            for url_field in ("cian_url", "avito_url", "yandex_realty_url", "site_url"):
                value = str(c.get(url_field) or "").strip()
                if value and not URL_RE.match(value):
                    fail(errors, label + ": " + url_field + " должен начинаться с https://")
            cid = str(c.get("id") or "")
            if cid in comp_ids:
                fail(errors, label + ": повторяющийся id")
            comp_ids.append(cid)

    # cross-file: key_competitors must reference existing competitor ids
    if "my-objects.yaml" in data and comp_ids:
        for p in (data["my-objects.yaml"] or {}).get("our_projects") or []:
            if not isinstance(p, dict):
                continue
            for ref in p.get("key_competitors") or []:
                if str(ref) not in comp_ids:
                    fail(errors, "my-objects.yaml: %s.key_competitors -> id '%s' "
                                 "отсутствует в competitors.yaml" % (p.get("id"), ref))

    # --- settings.yaml ---------------------------------------------------
    if "settings.yaml" in data:
        doc = data["settings.yaml"] or {}
        period = doc.get("period") or {}
        if period.get("days") != 7:
            fail(errors, "settings.yaml: period.days должен быть 7")
        thresholds = doc.get("thresholds") or {}
        if thresholds.get("price_change_pct") != 0.5:
            fail(errors, "settings.yaml: thresholds.price_change_pct должен быть 0.5")
        keywords = doc.get("promo_keywords") or []
        if not keywords:
            fail(errors, "settings.yaml: promo_keywords пуст")
        sections = doc.get("report_sections") or []
        if len(sections) != REPORT_SECTION_COUNT:
            fail(errors, "settings.yaml: report_sections должен содержать ровно %d разделов, "
                         "найдено %d" % (REPORT_SECTION_COUNT, len(sections)))
        contract = doc.get("data_contract") or {}
        columns = [str(x) for x in (contract.get("columns") or [])]
        if columns != CONTRACT_COLUMNS:
            fail(errors, "settings.yaml: data_contract.columns не совпадает с контрактом "
                         "(18 колонок в фиксированном порядке)")

    check_clients(errors)

    print("")
    if errors:
        print("НАЙДЕНО ОШИБОК: %d" % len(errors))
        return 1
    print("OK: 3 глобальных конфига и клиентские конфиги валидны.")
    return 0


if __name__ == "__main__":
    sys.exit(check_configs())
