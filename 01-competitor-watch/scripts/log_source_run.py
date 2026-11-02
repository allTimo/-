#!/usr/bin/env python3
r"""log_source_run.py - append one source-run record to data/source-runs.jsonl.

Record shape (one JSON object per line, UTF-8):
    {"ts":"<ISO>","source":"<id>","status":"ok|partial|blocked|empty",
     "lots":<N|null>,"projects":<N|null>,"note":"..."}

Append-only: the file is opened with O_APPEND and each record is written by a single
os.write call, so parallel runs do not interleave. A missing file (or folder) is not
an error - it is created on first write.

Usage:
    python log_source_run.py --source developer-sites --status ok --lots 15 --projects 1
    python log_source_run.py --tail 5
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cwlib as cw  # noqa: E402

DEFAULT_FILE = cw.WATCH_DIR / "data" / "source-runs.jsonl"
STATUS_VALUES = ("ok", "partial", "blocked", "empty")
FIELDS = ("ts", "source", "status", "lots", "projects", "note")


def setup_console():
    cw.setup_console()


def now_iso():
    return dt.datetime.now().replace(microsecond=0).isoformat()


def build_entry(source, status, lots=None, projects=None, note="", ts=None):
    """Validate and normalise one record."""
    if not source:
        raise ValueError("не указан источник (--source)")
    if status not in STATUS_VALUES:
        raise ValueError("status должен быть одним из %s" % ", ".join(STATUS_VALUES))
    return {
        "ts": ts or now_iso(),
        "source": str(source),
        "status": status,
        "lots": None if lots is None else int(lots),
        "projects": None if projects is None else int(projects),
        "note": str(note or ""),
    }


def _acquire_lock(path, timeout=10.0, stale_after=30.0):
    """Cross-process lock file; returns the open fd or None when unavailable.

    Несколько параллельных запусков сбора пишут в один журнал: без блокировки
    строки могут потеряться на Windows. Зависший lock старше stale_after снимается.
    """
    lock_path = "%s.lock" % path
    deadline = time.time() + timeout
    while True:
        try:
            return os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock_path) > stale_after:
                    os.unlink(lock_path)
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                return None
            time.sleep(0.02)
        except OSError:
            return None


def _release_lock(path, handle):
    if handle is None:
        return
    try:
        os.close(handle)
    except OSError:
        pass
    try:
        os.unlink("%s.lock" % path)
    except OSError:
        pass


def append_entries(entries, path=DEFAULT_FILE, retries=12):
    """Append records, one line each. Returns the number of records written."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(
        json.dumps({key: entry.get(key) for key in FIELDS}, ensure_ascii=False) + "\n"
        for entry in entries
    ).encode("utf-8")
    if not payload:
        return 0

    lock = _acquire_lock(str(path))
    try:
        flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        last_error = None
        for attempt in range(retries):
            try:
                handle = os.open(str(path), flags)
                try:
                    os.write(handle, payload)
                finally:
                    os.close(handle)
                return len(entries)
            except OSError as exc:   # Windows may hold the file briefly during a parallel write
                last_error = exc
                time.sleep(min(0.05 * (attempt + 1), 0.4))
        # последняя попытка другим способом: буферизованная запись в режиме append
        try:
            with open(path, "ab") as handle:
                handle.write(payload)
            return len(entries)
        except OSError as exc:
            raise OSError("не удалось записать журнал %s: %s" % (path, last_error or exc))
    finally:
        _release_lock(str(path), lock)


def append_entry(entry, path=DEFAULT_FILE):
    return append_entries([entry], path)


def read_entries(path, limit=None):
    path = Path(path)
    if not path.exists():
        return []
    entries = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries[-limit:] if limit else entries


def build_parser():
    parser = argparse.ArgumentParser(
        prog="log_source_run.py",
        description="Журнал запусков источников: добавление записей и просмотр хвоста.",
    )
    parser.add_argument("--file", default=str(DEFAULT_FILE), help="журнал (source-runs.jsonl)")
    parser.add_argument("--source", default=None, help="id источника")
    parser.add_argument("--status", default=None,
                        help="итог прогона: %s" % " | ".join(STATUS_VALUES))
    parser.add_argument("--lots", type=int, default=None, help="сколько лотов снято")
    parser.add_argument("--projects", type=int, default=None, help="сколько проектов")
    parser.add_argument("--note", default="", help="пояснение")
    parser.add_argument("--ts", default=None, help="ISO-метка времени (по умолчанию сейчас)")
    parser.add_argument("--tail", type=int, default=None, help="показать последние N записей")
    parser.add_argument("--json", action="store_true", help="вывести запись/хвост в JSON")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv)

    if args.tail is not None:
        entries = read_entries(args.file, limit=args.tail)
        if args.json:
            print(json.dumps(entries, ensure_ascii=False, indent=2))
            return 0
        if not entries:
            print("Журнал пуст: %s" % args.file)
            return 0
        print("%-20s %-16s %-8s %-6s %-9s %s" % ("ts", "source", "status", "lots", "projects", "note"))
        for entry in entries:
            print("%-20s %-16s %-8s %-6s %-9s %s" % (
                entry.get("ts"), entry.get("source"), entry.get("status"),
                "-" if entry.get("lots") is None else entry.get("lots"),
                "-" if entry.get("projects") is None else entry.get("projects"),
                entry.get("note")))
        return 0

    if not args.source or not args.status:
        print("Ошибка: нужны --source и --status (или --tail N).", file=sys.stderr)
        return 1
    try:
        entry = build_entry(args.source, args.status, args.lots, args.projects, args.note, args.ts)
        append_entry(entry, args.file)
    except ValueError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 1
    except OSError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(entry, ensure_ascii=False))
    else:
        print("Записано в %s: %s %s" % (args.file, entry["source"], entry["status"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
