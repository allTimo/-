#!/usr/bin/env python3
r"""sources_tool.py - manage monitoring sources (registry/sources.yaml) and log runs.

The dashboard tab «Источники мониторинга» flips the enabled flag through this CLI:
a toggle must have consequences, so the collectors and run_weekly.ps1 call it first.

Commands:
    list [--json] [--enabled-only]      таблица id / enabled / status / last_run
    status <id> [--json]                подробности по одному источнику
    enable <id>                         включить (идемпотентно, с бэкапом)
    disable <id>                        выключить (идемпотентно, с бэкапом)
    record <id> --status <s> [--last-run <date>]     проставить status/last_run
    apply --json <file|->               пакетная правка (один бэкап на прогон)
    run-cycle --date <date>             шаг цикла: журнал + last_run/status по включённым

Editing preserves comments, order and every untouched byte: only the value of the
targeted field changes. Writes are atomic (temp file + os.replace) and preceded by
a .bak-<timestamp> backup.

Exit codes: 0 ok, 1 unknown source / bad usage, 2 problem with the sources file.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
from pathlib import Path

import cwlib as cw
import log_source_run

SOURCES_FILE = cw.PROJECT_ROOT / "registry" / "sources.yaml"
RUNS_FILE = cw.WATCH_DIR / "data" / "source-runs.jsonl"

STATUS_VALUES = ("ok", "partial", "blocked", "empty")
YAML_STATUS_FOR = {"ok": "working", "partial": "partial", "blocked": "blocked", "empty": None}
# id источника -> значения колонки source в lots.csv
CSV_SOURCE_ALIASES = {
    "developer-sites": ("site",),
    "cian": ("cian",),
    "avito": ("avito",),
    "yandex-realty": ("yandex_realty",),
    "partner-feeds": ("other",),
}
MANUAL_NOTE = "ждём материалы"


# --------------------------------------------------------------------------
# reading / editing sources.yaml
# --------------------------------------------------------------------------

def read_sources(path):
    """Parsed list of source records (via the shared mini-YAML reader)."""
    path = Path(path)
    if not path.exists():
        raise ValueError("файл источников не найден: %s" % path)
    data = cw.parse_simple_yaml(path)
    if not isinstance(data, dict):
        raise ValueError("ожидался словарь верхнего уровня в %s" % path)
    sources = data.get("sources")
    if not isinstance(sources, list):
        raise ValueError("в %s нет списка sources" % path)
    result = []
    for item in sources:
        if isinstance(item, dict) and item.get("id"):
            result.append(item)
    return result


def find_source(sources, source_id):
    for item in sources:
        if str(item.get("id")) == str(source_id):
            return item
    return None


def _split_value_comment(text):
    """Split "value   # comment" into (value, remainder).

    remainder keeps the original gap and the comment byte-for-byte, so replacing the
    value does not touch anything else on the line.
    """
    quote = None
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#" and index > 0 and text[index - 1].isspace():
            value = text[:index].rstrip()
            return value, text[len(value):]
    value = text.rstrip()
    return value, text[len(value):]


def _format_value(field, value):
    if value is None:
        return "null"
    if field == "last_run":
        return '"%s"' % value
    return str(value)


def plan_field_updates(path, updates):
    """Compute the new file text for a list of {id, field: value} updates.

    Returns (new_text_or_None, applied_list, missing_list). None means "nothing to do".
    Only the value part of the targeted lines changes; indentation, trailing comments,
    ordering and all other bytes stay exactly as they were.
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8-sig")
    lines = text.splitlines(keepends=True)
    by_id = {}
    for update in updates:
        by_id.setdefault(str(update["id"]), []).append(update)

    applied, missing = [], []
    current_id = None
    dash_indent = 0
    changed = 0
    out = []
    for raw in lines:
        stripped = raw.rstrip("\r\n")
        newline = raw[len(stripped):]

        id_match = re.match(r"^(\s*)-\s+id:\s*(\S+)\s*$", stripped)
        if id_match:
            current_id = id_match.group(2).strip("\"'")
            dash_indent = len(id_match.group(1))
            out.append(raw)
            continue

        if current_id is not None:
            field_match = re.match(r"^(\s*)([A-Za-z_]+):(\s*)(.*)$", stripped)
            if field_match and len(field_match.group(1)) > dash_indent:
                field = field_match.group(2)
                candidates = by_id.get(current_id) or []
                for update in candidates:
                    if update.get("field") == field and update.get("__done__") is not True:
                        value, remainder = _split_value_comment(field_match.group(4))
                        new_value = _format_value(field, update.get("value"))
                        current_value = value.strip().strip("\"'")
                        wanted = "" if update.get("value") is None else str(update.get("value"))
                        if current_value == wanted:
                            update["__done__"] = True
                            update["changed"] = False
                            applied.append(update)
                        else:
                            rebuilt = "%s%s:%s%s%s" % (field_match.group(1), field,
                                                       field_match.group(3), new_value, remainder)
                            raw = rebuilt + newline
                            stripped = rebuilt
                            update["__done__"] = True
                            update["changed"] = True
                            changed += 1
                            applied.append(update)
                        break
            elif field_match and len(field_match.group(1)) <= dash_indent:
                current_id = None
        out.append(raw)

    for update in updates:
        if update.get("__done__") is not True:
            missing.append(update)
    if changed == 0:
        return None, applied, missing
    return "".join(out), applied, missing


def write_atomic(path, text, backup=True):
    """temp file + os.replace, with a .bak-<timestamp> copy of the previous content."""
    path = Path(path)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = path.with_name(path.name + ".bak-" + stamp)
    if backup:
        counter = 2
        while backup_path.exists():   # две правки в одну секунду не должны затирать бэкап
            backup_path = path.with_name(path.name + ".bak-%s-%d" % (stamp, counter))
            counter += 1
        shutil.copy2(path, backup_path)
    tmp = path.with_name(path.name + ".tmp-%d" % os.getpid())
    with open(tmp, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(tmp, path)
    return backup_path if backup else None


def apply_updates(path, updates, backup=True):
    """updates: [{id, field, value}] -> (applied, missing, backup_path or None)."""
    if not updates:
        return [], [], None
    text, applied, missing = plan_field_updates(path, updates)
    if text is None:
        return applied, missing, None
    backup_path = write_atomic(path, text, backup=backup)
    return applied, missing, backup_path


def set_enabled(path, source_id, enabled):
    sources = read_sources(path)
    source = find_source(sources, source_id)
    if source is None:
        return None, "неизвестный источник: %s" % source_id
    current = source.get("enabled")
    was = bool(current)
    if was == bool(enabled):
        return {"id": source_id, "changed": False, "enabled": bool(enabled), "was": was}, None
    applied, missing, backup = apply_updates(path, [
        {"id": source_id, "field": "enabled", "value": "true" if enabled else "false"}])
    if missing:
        return None, "не удалось изменить поле enabled у %s" % source_id
    return {"id": source_id, "changed": True, "enabled": bool(enabled), "was": was,
            "backup": str(backup) if backup else None}, None


# --------------------------------------------------------------------------
# journal helpers
# --------------------------------------------------------------------------

def csv_aliases(source):
    explicit = source.get("csv_source")
    if explicit:
        if isinstance(explicit, list):
            return tuple(str(item) for item in explicit)
        return (str(explicit),)
    return CSV_SOURCE_ALIASES.get(str(source.get("id")), ())


def evaluate_source(source, rows, snapshot_label):
    """Result of one collection attempt for one source."""
    kind = str(source.get("kind") or "").strip()
    aliases = csv_aliases(source)
    if rows is None:
        return "blocked", None, None, "нет снимка %s" % snapshot_label
    if aliases:
        matched = [row for row in rows if str(row.get("source") or "").strip() in aliases]
        lots = len(matched)
        projects = len({str(row.get("project") or "") for row in matched})
        if lots:
            return "ok", lots, projects, "снято %d лотов в %d проектах" % (lots, projects)
        return "empty", 0, 0, "в снимке нет лотов от этого источника"
    if kind == "manual":
        return "empty", 0, 0, MANUAL_NOTE
    return "empty", None, None, "нет привязки к колонке source"


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_list(args):
    sources = read_sources(args.sources_file)
    if args.enabled_only:
        sources = [item for item in sources if item.get("enabled") is True]
    if args.json:
        payload = [{"id": str(item.get("id")), "name": item.get("name"),
                    "enabled": item.get("enabled") is True, "status": item.get("status"),
                    "last_run": item.get("last_run"), "kind": item.get("kind"),
                    "priority": item.get("priority")} for item in sources]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    print("%-16s %-8s %-11s %-12s %s" % ("id", "enabled", "status", "last_run", "name"))
    for item in sources:
        print("%-16s %-8s %-11s %-12s %s" % (
            item.get("id"), "вкл" if item.get("enabled") is True else "выкл",
            item.get("status") or "-", item.get("last_run") or "-", item.get("name") or ""))
    enabled = sum(1 for item in sources if item.get("enabled") is True)
    print("")
    print("Всего источников: %d, включено: %d, выключено: %d"
          % (len(sources), enabled, len(sources) - enabled))
    return 0


def cmd_status(args):
    source = find_source(read_sources(args.sources_file), args.source_id)
    if source is None:
        print("Ошибка: неизвестный источник: %s" % args.source_id, file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({k: v for k, v in source.items()}, ensure_ascii=False, indent=2))
        return 0
    for key in ("id", "name", "enabled", "status", "last_run", "kind", "auth", "priority",
                "limits", "howto", "note"):
        if key in source:
            print("%-9s %s" % (key + ":", source.get(key)))
    return 0


def _toggle(args, enabled):
    try:
        result, error = set_enabled(args.sources_file, args.source_id, enabled)
    except ValueError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2
    if error:
        print("Ошибка: %s" % error, file=sys.stderr)
        print("Подсказка: список источников — sources_tool.py list", file=sys.stderr)
        return 1
    word = "включён" if enabled else "выключен"
    if result["changed"]:
        print("Источник %s %s (было: %s)."
              % (args.source_id, word, "вкл" if result.get("was") else "выкл"))
        if result.get("backup"):
            print("Бэкап: %s" % result["backup"])
    else:
        print("Источник %s уже %s — файл не менялся." % (args.source_id, word))
    return 0


def cmd_enable(args):
    return _toggle(args, True)


def cmd_disable(args):
    return _toggle(args, False)


def cmd_record(args):
    if args.status not in STATUS_VALUES:
        print("Ошибка: status должен быть одним из %s" % ", ".join(STATUS_VALUES), file=sys.stderr)
        return 1
    try:
        sources = read_sources(args.sources_file)
    except ValueError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2
    if find_source(sources, args.source_id) is None:
        print("Ошибка: неизвестный источник: %s" % args.source_id, file=sys.stderr)
        return 1
    updates = []
    yaml_status = YAML_STATUS_FOR[args.status]
    if yaml_status:
        updates.append({"id": args.source_id, "field": "status", "value": yaml_status})
    if args.last_run:
        updates.append({"id": args.source_id, "field": "last_run", "value": args.last_run})
    applied, missing, backup = apply_updates(args.sources_file, updates)
    changed = [item for item in applied if item.get("changed")]
    print("Источник %s: status=%s%s, изменено полей: %d"
          % (args.source_id, args.status, ", last_run=%s" % args.last_run if args.last_run else "",
             len(changed)))
    if backup:
        print("Бэкап: %s" % backup)
    return 0


def cmd_apply(args):
    raw = sys.stdin.read() if args.json == "-" else Path(args.json).read_text(encoding="utf-8")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print("Ошибка: не разобрать JSON (%s)" % exc, file=sys.stderr)
        return 1
    if not isinstance(payload, list):
        print("Ошибка: ожидался список объектов {id, status, last_run}", file=sys.stderr)
        return 1
    updates = []
    for item in payload:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        status = item.get("status")
        if status:
            yaml_status = YAML_STATUS_FOR.get(str(status))
            if yaml_status:
                updates.append({"id": str(item["id"]), "field": "status", "value": yaml_status})
        if item.get("last_run"):
            updates.append({"id": str(item["id"]), "field": "last_run", "value": item["last_run"]})
    applied, missing, backup = apply_updates(args.sources_file, updates)
    changed = [item for item in applied if item.get("changed")]
    print("Обновлено источников: %d (полей изменено: %d)" % (len({i["id"] for i in applied}), len(changed)))
    if missing:
        print("Не найдены в файле: %s" % ", ".join(str(item["id"]) for item in missing), file=sys.stderr)
    if backup:
        print("Бэкап: %s" % backup)
    return 0 if not missing else 1


def cmd_run_cycle(args):
    date = args.date or dt.date.today().isoformat()
    snapshots_dir = Path(args.snapshots_dir) if args.snapshots_dir else cw.SNAPSHOTS_DIR
    snapshot_path = snapshots_dir / date / "lots.csv"
    runs_file = Path(args.runs_file) if args.runs_file else RUNS_FILE

    try:
        sources = read_sources(args.sources_file)
    except ValueError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2

    enabled = [item for item in sources if item.get("enabled") is True]
    skipped = [item for item in sources if item.get("enabled") is not True]

    rows = None
    if snapshot_path.exists():
        try:
            rows = cw.load_snapshot_rows(snapshot_path)
        except Exception as exc:
            print("Предупреждение: не удалось прочитать снимок %s (%s)" % (snapshot_path, exc),
                  file=sys.stderr)
    snapshot_label = "%s/%s/lots.csv" % (snapshots_dir.name, date)

    entries = []
    updates = []
    for source in enabled:
        source_id = str(source.get("id"))
        status, lots, projects, note = evaluate_source(source, rows, snapshot_label)
        entries.append({"ts": log_source_run.now_iso(), "source": source_id, "status": status,
                        "lots": lots, "projects": projects, "note": note})
        updates.append({"id": source_id, "status": status, "last_run": date})

    if not args.dry_run:
        for entry in entries:
            log_source_run.append_entry(entry, runs_file)
        try:
            applied, missing, backup = apply_updates(
                args.sources_file,
                [{"id": item["id"], "field": "status", "value": YAML_STATUS_FOR[item["status"]]}
                 for item in updates if YAML_STATUS_FOR.get(item["status"])] +
                [{"id": item["id"], "field": "last_run", "value": item["last_run"]} for item in updates])
        except ValueError as exc:
            print("Ошибка: %s" % exc, file=sys.stderr)
            return 2
    else:
        applied, missing, backup = [], [], None

    if args.json:
        print(json.dumps({"date": date, "snapshot": str(snapshot_path), "rows": len(rows or []),
                          "enabled": [str(item.get("id")) for item in enabled],
                          "skipped": [str(item.get("id")) for item in skipped],
                          "journal": entries, "runs_file": str(runs_file)}, ensure_ascii=False, indent=2))
        return 0

    print("=== Источники мониторинга ===")
    if rows is None:
        print("Снимок не найден: %s — статусы записаны как blocked." % snapshot_path)
    for entry in entries:
        lots = "—" if entry["lots"] is None else entry["lots"]
        print("  %-16s %-8s лотов: %-4s %s" % (entry["source"], entry["status"], lots, entry["note"]))
    for source in skipped:
        print("  %-16s пропущен (enabled: false)" % source.get("id"))
    print("Журнал: %s (записей добавлено: %d)" % (runs_file, len(entries)))
    if backup:
        print("Бэкап sources.yaml: %s" % backup)
    return 0


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="sources_tool.py",
        description="Источники мониторинга: список, включение/выключение, журнал прогонов.",
    )
    parser.add_argument("--sources-file", default=str(SOURCES_FILE),
                        help="файл источников (по умолчанию registry/sources.yaml)")
    sub = parser.add_subparsers(dest="command", required=True)

    list_parser = sub.add_parser("list", help="показать источники")
    list_parser.add_argument("--json", action="store_true", help="вывести JSON")
    list_parser.add_argument("--enabled-only", action="store_true", help="только включённые")
    list_parser.set_defaults(func=cmd_list)

    status_parser = sub.add_parser("status", help="подробности по источнику")
    status_parser.add_argument("source_id")
    status_parser.add_argument("--json", action="store_true", help="вывести JSON")
    status_parser.set_defaults(func=cmd_status)

    enable_parser = sub.add_parser("enable", help="включить источник")
    enable_parser.add_argument("source_id")
    enable_parser.set_defaults(func=cmd_enable)

    disable_parser = sub.add_parser("disable", help="выключить источник")
    disable_parser.add_argument("source_id")
    disable_parser.set_defaults(func=cmd_disable)

    record_parser = sub.add_parser("record", help="проставить status/last_run источнику")
    record_parser.add_argument("source_id")
    record_parser.add_argument("--status", required=True, choices=STATUS_VALUES)
    record_parser.add_argument("--last-run", default=None, help="дата YYYY-MM-DD")
    record_parser.set_defaults(func=cmd_record)

    apply_parser = sub.add_parser("apply", help="пакетная правка из JSON")
    apply_parser.add_argument("--json", required=True, help="путь к JSON или - для stdin")
    apply_parser.set_defaults(func=cmd_apply)

    cycle_parser = sub.add_parser("run-cycle", help="шаг недельного цикла: журнал + last_run/status")
    # Дублируем глобальный ключ здесь с SUPPRESS: так его можно писать и до, и после
    # подкоманды, и значение по умолчанию глобального ключа не перетирается.
    cycle_parser.add_argument("--sources-file", default=argparse.SUPPRESS,
                              help="файл источников (по умолчанию registry/sources.yaml)")
    cycle_parser.add_argument("--date", default=None, help="дата снимка YYYY-MM-DD")
    cycle_parser.add_argument("--snapshots-dir", default=None, help="каталог снимков")
    cycle_parser.add_argument("--runs-file", default=None, help="журнал (по умолчанию data/source-runs.jsonl)")
    cycle_parser.add_argument("--json", action="store_true", help="вывести JSON")
    cycle_parser.add_argument("--dry-run", action="store_true", help="ничего не писать")
    cycle_parser.set_defaults(func=cmd_run_cycle)
    return parser


def main(argv=None):
    cw.setup_console()
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ValueError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
