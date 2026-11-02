#!/usr/bin/env python3
r"""build_report.py - compatibility alias for build_weekly_report.py.

Documented in the project runbook as:
    python build_report.py --date YYYY-MM-DD [--prev YYYY-MM-DD]
Builds the canonical report and additionally copies it to
reports/<date>/weekly-report.md and reports/<date>/weekly-report.xlsx.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import build_weekly_report
import cwlib as cw


def main(argv=None):
    cw.setup_console()
    parser = argparse.ArgumentParser(
        prog="build_report.py",
        description="Совместимый алиас: недельный отчёт из снимка и diff.",
    )
    parser.add_argument("--date", required=True, help="дата текущего снимка YYYY-MM-DD")
    parser.add_argument("--prev", default=None, help="дата предыдущего снимка YYYY-MM-DD")
    parser.add_argument("--threshold", type=float, default=None,
                        help="порог значимости цены, %% (по умолчанию из settings.yaml)")
    parser.add_argument("--formats", default="md,xlsx", help="md,xlsx")
    parser.add_argument("--reports-dir", default=None, help="каталог отчётов (по умолчанию reports)")
    parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
    parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config")
    parser.add_argument("--no-config", action="store_true", help="не читать settings.yaml")
    args = parser.parse_args(argv)

    reports_dir = cw.resolve_reports_dir(args.reports_dir, args.config_dir)
    forwarded = ["--curr", args.date, "--formats", args.formats, "--reports-dir", str(reports_dir)]
    if args.threshold is not None:
        forwarded += ["--threshold", str(args.threshold)]
    if args.prev:
        forwarded += ["--prev", args.prev]
    if args.snapshots_dir:
        forwarded += ["--snapshots-dir", args.snapshots_dir]
    if args.config_dir:
        forwarded += ["--config-dir", args.config_dir]
    if args.no_config:
        forwarded += ["--no-config"]

    code = build_weekly_report.main(forwarded)
    if code != 0:
        return code

    # Weekly-folder layout documented in the runbook.
    week_dir = reports_dir / args.date
    week_dir.mkdir(parents=True, exist_ok=True)
    copies = []
    for suffix, target_name in (("md", "weekly-report.md"), ("xlsx", "weekly-report.xlsx")):
        if suffix not in {item.strip() for item in args.formats.split(",")}:
            continue
        source = reports_dir / ("%s-competitor-watch.%s" % (args.date, suffix))
        if source.exists():
            target = week_dir / target_name
            shutil.copyfile(source, target)
            copies.append(target)
    for target in copies:
        print("Копия для runbook: %s" % target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
