#!/usr/bin/env python3
r"""snapshot_tool.py - create, validate and normalize weekly competitor snapshots.

Usage (Windows PowerShell):
    <python> snapshot_tool.py new 2026-10-30
    <python> snapshot_tool.py validate 2026-10-30
    <python> snapshot_tool.py validate tests\fixtures\broken\lots.csv
    <python> snapshot_tool.py normalize 2026-10-30

Exit codes:
    0 - success / no validation problems
    1 - validation found problems, or the operation was refused
    2 - fatal input problem (missing file, broken header)

Only the standard library is used.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cwlib as cw

EXAMPLE_ROW = {
    "snapshot_date": "2026-10-30",
    "source": "cian",
    "competitor": "Пример Девелопер",
    "project": "Пример Тауэр",
    "lot_id": "EX-001",
    "url": "https://example.com/lot/EX-001",
    "rooms": 2,
    "area_m2": 56.5,
    "floor": 10,
    "floors_total": 25,
    "building": "Корпус 1",
    "price_rub": 18900000,
    "price_per_m2_rub": 334513,
    "finish": "чистовая",
    "promo_flag": 1,
    "promo_text": "Скидка 5% при полной оплате",
    "delivery": "2027-Q2",
    "status": "active",
}


def build_parser():
    parser = argparse.ArgumentParser(
        prog="snapshot_tool.py",
        description="Снимки конкурентов: создание, проверка схемы, нормализация.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    new_parser = sub.add_parser("new", help="создать папку снимка и lots.csv с примером строки")
    new_parser.add_argument("date", help="дата снимка в формате YYYY-MM-DD")
    new_parser.add_argument("--force", action="store_true", help="перезаписать существующий файл")
    new_parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
    new_parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config (по умолчанию вычисляется от скрипта)")
    new_parser.add_argument("--no-config", action="store_true", help="не читать settings.yaml")

    for name, help_text in (
        ("validate", "проверить схему, типы, дубли и диапазоны"),
        ("normalize", "привести типы, досчитать ₽/м², убрать дубли и отсортировать"),
    ):
        sub_parser = sub.add_parser(name, help=help_text)
        sub_parser.add_argument("target", help="дата YYYY-MM-DD или путь к lots.csv")
        sub_parser.add_argument("--snapshots-dir", default=None, help="каталог снимков (по умолчанию data/snapshots)")
        sub_parser.add_argument("--config-dir", default=None, help="каталог конфигов 00-admin/config (по умолчанию вычисляется от скрипта)")
        sub_parser.add_argument("--no-config", action="store_true", help="не читать settings.yaml")
        sub_parser.add_argument("--quiet", action="store_true", help="печатать только итог")

    return parser


def cmd_new(args):
    date_text = args.date.strip()
    if not cw.DATE_RE.match(date_text):
        print("Ошибка: дата должна быть в формате YYYY-MM-DD, получено: %s" % date_text, file=sys.stderr)
        return 1
    snapshots_dir = cw.resolve_snapshots_dir(args.snapshots_dir, args.config_dir,
                                            use_config=not args.no_config)
    path = cw.resolve_snapshot_ref(date_text, snapshots_dir)
    if path.exists() and not args.force:
        print("Ошибка: файл уже существует: %s (используйте --force)" % path, file=sys.stderr)
        return 1
    row = dict(EXAMPLE_ROW)
    row["snapshot_date"] = date_text
    cw.write_csv(path, [row])
    print("Создан снимок: %s" % path)
    print("В файле заголовок и 1 пример-строка (лот %s). Замените её реальными данными." % row["lot_id"])
    print("Проверка: python snapshot_tool.py validate %s" % date_text)
    return 0


def cmd_validate(args):
    snapshots_dir = cw.resolve_snapshots_dir(args.snapshots_dir, args.config_dir,
                                            use_config=not args.no_config)
    path = cw.resolve_snapshot_ref(args.target, snapshots_dir)
    expected_date = cw.date_from_ref(args.target)
    try:
        problems, rows = cw.validate_file(path, expected_date)
    except cw.EngineError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2

    if not args.quiet:
        print("Файл: %s" % path)
    for problem in problems:
        print(problem, file=sys.stderr)

    if problems:
        print("ОШИБКИ: %d, строк с данными: %d. Исправьте строки выше и запустите validate снова." % (len(problems), rows))
        return 1

    print("OK: строк с данными %d, схема, типы, диапазоны и ключи в порядке." % rows)
    return 0


def cmd_normalize(args):
    snapshots_dir = cw.resolve_snapshots_dir(args.snapshots_dir, args.config_dir,
                                            use_config=not args.no_config)
    path = cw.resolve_snapshot_ref(args.target, snapshots_dir)
    expected_date = cw.date_from_ref(args.target)
    try:
        path, stats = cw.normalize_file(path, expected_date)
    except cw.EngineError as exc:
        print("Ошибка: %s" % exc, file=sys.stderr)
        return 2

    print("Нормализовано: %s" % path)
    print(
        "Строк на входе: %d; сохранено: %d; отброшено дублей: %d; отброшено некорректных: %d; досчитано ₽/м²: %d"
        % (
            stats["total"],
            stats["kept"],
            stats["dropped_duplicates"],
            stats["dropped_invalid"],
            stats["filled_ppm2"],
        )
    )
    print("Файл перезаписан в utf-8-sig, отсортирован по (дата, конкурент, проект, lot_id).")
    return 0


def main(argv=None):
    cw.setup_console()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "new":
        return cmd_new(args)
    if args.command == "validate":
        return cmd_validate(args)
    if args.command == "normalize":
        return cmd_normalize(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
