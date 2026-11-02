#!/usr/bin/env python3
r"""build_snapshot.py - compatibility alias for snapshot_tool.py new.

Documented in the project runbook as:
    python build_snapshot.py --date YYYY-MM-DD
Canonical implementation: snapshot_tool.py (task T3).
"""
from __future__ import annotations

import argparse
import sys

import cwlib as cw
import snapshot_tool


def main(argv=None):
    cw.setup_console()
    parser = argparse.ArgumentParser(
        prog="build_snapshot.py",
        description="Совместимый алиас: создать снимок data/snapshots/<дата>/lots.csv.",
    )
    parser.add_argument("--date", required=True, help="дата снимка YYYY-MM-DD")
    parser.add_argument("--force", action="store_true", help="перезаписать существующий файл")
    parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
    parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config")
    args = parser.parse_args(argv)

    forwarded = ["new", args.date]
    if args.snapshots_dir:
        forwarded += ["--snapshots-dir", args.snapshots_dir]
    if args.config_dir:
        forwarded += ["--config-dir", args.config_dir]
    if args.force:
        forwarded.append("--force")
    return snapshot_tool.main(forwarded)


if __name__ == "__main__":
    sys.exit(main())
