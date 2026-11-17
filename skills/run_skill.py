"""CLI скиллов: единый интерфейс вызова для агента и для человека.

Примеры::

    cd marketing-agents
    $py = "$env:USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe"

    & $py -m skills.run_skill --list
    & $py -m skills.run_skill mcp_market "каркасные дома в спб"
    & $py -m skills.run_skill mcp_market "каркасные дома в спб" --json
    & $py -m skills.run_skill --all "квартира москва"

Код возврата 0, если ни один скилл не упал неожиданно; 1, если упали все вызванные
(то есть ни одного рабочего результата получить не удалось).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):  # запуск файла напрямую: python skills/run_skill.py
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skills.runtime import (  # noqa: E402
    STATUS_ERROR,
    enable_utf8_stdout,
    load_env_file,
    load_registry,
    run_skill_result,
    skill_entries,
)


def _print_human(result: dict) -> None:
    status = result.get("status")
    records = result.get("records") or []
    duration = result.get("duration_ms")
    mark = {"ok": "+", "empty": "~", "skipped_no_key": "!", "error": "x", "not_deployed": "x"}.get(
        status, "?"
    )
    line = f"[{mark}] {result['skill']:<15} статус={status:<15} записей={len(records):<4} время={duration} мс"
    print(line)
    if result.get("error"):
        print(f"      причина: {result['error']}")
    if records:
        first = records[0]
        title = first.get("title") or first.get("address") or first.get("id") or "—"
        print(f"      пример: {title}")


def main(argv: list[str] | None = None) -> int:
    enable_utf8_stdout()
    load_env_file()

    parser = argparse.ArgumentParser(
        prog="skills.run_skill",
        description="Вызов скиллов агента по единому контракту fetch(query, **kwargs) -> list[dict].",
    )
    parser.add_argument("skill", nargs="?", help="имя скилла из реестра")
    parser.add_argument("query", nargs="?", default="", help="поисковый запрос")
    parser.add_argument("--list", action="store_true", help="показать реестр скиллов и выйти")
    parser.add_argument("--all", action="store_true", help="вызвать все скиллы реестра последовательно")
    parser.add_argument("--json", action="store_true", help="вывести результат как JSON")
    parser.add_argument("--include-disabled", action="store_true", help="учитывать выключенные скиллы")
    args = parser.parse_args(argv)

    # При --all первый позиционный аргумент — это запрос, а не имя скилла:
    # argparse кладёт его в `skill`, потому что позиция идёт первой.
    if args.all and args.skill and not args.query:
        args.query = args.skill
        args.skill = None

    if args.list:
        registry = load_registry()
        print(f"Реестр скиллов v{registry.get('version')} (обновлён {registry.get('updated')})")
        for entry in skill_entries(include_disabled=True):
            marks = []
            marks.append("вкл" if entry.get("enabled", True) else "выкл")
            keys = ", ".join(entry.get("required_env") or []) or "без ключа"
            marks.append(keys)
            print(f"  {entry['name']:<15} {entry.get('title',''):<28} [{', '.join(marks)}]")
            print(f"      {entry.get('purpose','')}")
            print(f"      лимит: {entry.get('free_tier','')}")
        return 0

    if args.all:
        names = [entry["name"] for entry in skill_entries(args.include_disabled)]
        if not names:
            print("реестр скиллов пуст", file=sys.stderr)
            return 1
    elif args.skill:
        names = [args.skill]
    else:
        parser.print_help()
        return 2

    failures = 0
    payload: list[dict] = []
    for name in names:
        result = run_skill_result(name, args.query)
        payload.append(result)
        if result.get("status") == STATUS_ERROR:
            failures += 1
        if not args.json:
            _print_human(result)

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    return 1 if failures and failures == len(names) else 0


if __name__ == "__main__":
    raise SystemExit(main())
