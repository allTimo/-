#!/usr/bin/env python3
r"""run_weekly.py - compatibility alias for run_weekly.ps1.

Documented in the project runbook as:
    python run_weekly.py --date YYYY-MM-DD [--prev YYYY-MM-DD]
Runs the full cycle: validate -> normalize -> diff -> report (md + xlsx) and
also copies the report into reports/<date>/weekly-report.md|.xlsx.
"""
from __future__ import annotations

import argparse
import shutil
import sys

import cwlib as cw
import build_weekly_report
import diff_snapshots
import snapshot_tool
import sources_tool


def main(argv=None):
    cw.setup_console()
    parser = argparse.ArgumentParser(
        prog="run_weekly.py",
        description="Совместимый алиас: полный недельный цикл Агента 1.",
    )
    parser.add_argument("--date", required=True, help="дата текущего снимка YYYY-MM-DD")
    parser.add_argument("--prev", default=None, help="дата предыдущего снимка YYYY-MM-DD")
    parser.add_argument("--threshold", type=float, default=None,
                        help="порог значимости цены, %% (по умолчанию из settings.yaml)")
    parser.add_argument("--reports-dir", default=None, help="каталог отчётов (по умолчанию reports)")
    parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
    parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config")
    parser.add_argument("--no-config", action="store_true", help="не читать settings.yaml")
    parser.add_argument("--telegram", action="store_true", help="напечатать сводку для Telegram")
    parser.add_argument("--sources-file", default=None, help="файл источников (по умолчанию registry/sources.yaml)")
    parser.add_argument("--runs-file", default=None, help="журнал прогонов (data/source-runs.jsonl)")
    parser.add_argument("--skip-sources", action="store_true", help="не выполнять шаг источников")
    args = parser.parse_args(argv)

    common = []
    if args.snapshots_dir:
        common += ["--snapshots-dir", args.snapshots_dir]
    if args.config_dir:
        common += ["--config-dir", args.config_dir]
    if args.no_config:
        common += ["--no-config"]
    reports_dir = cw.resolve_reports_dir(args.reports_dir, args.config_dir)

    if args.skip_sources:
        print("=== источники: пропущено (--skip-sources) ===")
    else:
        print("=== источники (тумблеры, журнал прогона) ===")
        source_args = ["run-cycle", "--date", args.date,
                       "--snapshots-dir", str(cw.resolve_snapshots_dir(args.snapshots_dir, args.config_dir,
                                                                         use_config=not args.no_config))]
        if args.sources_file:
            source_args += ["--sources-file", args.sources_file]
        if args.runs_file:
            source_args += ["--runs-file", args.runs_file]
        code = sources_tool.main(source_args)
        if code != 0:
            return code

    print("=== validate ===")
    code = snapshot_tool.main(["validate", args.date] + common)
    if code != 0:
        print("validate не прошёл: diff и отчёт не строятся.", file=sys.stderr)
        return code

    print("=== normalize ===")
    code = snapshot_tool.main(["normalize", args.date] + common)
    if code != 0:
        return code

    config = cw.load_config(args.config_dir, use_config=not args.no_config)
    if args.threshold is not None:
        config["price_change_pct"] = args.threshold

    # The previous snapshot is chosen by the CLIs themselves through the single
    # cwlib.previous_snapshot_date + period.compare_mode, exactly like run_weekly.ps1.
    prev_args = ["--prev", args.prev] if args.prev else []

    print("=== diff ===")
    code = diff_snapshots.main(["--curr", args.date,
                                "--threshold", str(config["price_change_pct"]),
                                "--reports-dir", str(reports_dir)] + prev_args + common)
    if code != 0:
        return code

    print("=== отчёт ===")
    forwarded = ["--curr", args.date, "--threshold", str(config["price_change_pct"]),
                 "--reports-dir", str(reports_dir)] + prev_args + common
    if args.telegram:
        forwarded.append("--telegram")
    code = build_weekly_report.main(forwarded)
    if code != 0:
        return code

    week_dir = reports_dir / args.date
    week_dir.mkdir(parents=True, exist_ok=True)
    for suffix, target_name in (("md", "weekly-report.md"), ("xlsx", "weekly-report.xlsx")):
        source = reports_dir / ("%s-competitor-watch.%s" % (args.date, suffix))
        if source.exists():
            target = week_dir / target_name
            shutil.copyfile(source, target)
            print("Копия для runbook: %s" % target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
