#!/usr/bin/env python3
"""Разовая глубокая проверка Авито через ReefAPI (операторский режим).

ЗАЧЕМ
-----
Живой поиск Авито у ReefAPI занимает 25–280+ секунд (замеры 2026-11-04), поэтому
источник **не входит** в недельный прогон Агента 1. Этот скрипт запускает
проверку вручную — когда оператору нужно посмотреть конкретный ЖК на Авито.

ВАЖНО ЧЕСТНОСТЬ
---------------
Скрипт **не пишет** в `lots.csv` и не формирует лоты: имена полей объявления
Авито не подтверждены (см. `00-admin/research/reefapi-probe-2026-11-04.md`),
а выдумывать данные проект запрещает. Скрипт сохраняет СЫРОЙ ответ и краткую
сводку — этого достаточно, чтобы изучить схему и позже сделать маппинг.

ПРИМЕРЫ
-------
    $py = "$env:USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe"
    cd marketing-agents
    & $py 01-competitor-watch/scripts/reefapi_deep_check.py --query "Селигер Сити"
    & $py 01-competitor-watch/scripts/reefapi_deep_check.py --query "Селигер Сити" --timeout 300
    & $py 01-competitor-watch/scripts/reefapi_deep_check.py --list-recent

Ключ берётся из `marketing-agents/.env` (REEFAPI_KEY). В репозитории ключа нет.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]          # marketing-agents
OUT_DIR = PROJECT_ROOT / "01-competitor-watch" / "data" / "reefapi"

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from skills.real_estate import reefapi  # noqa: E402
from skills.runtime import (  # noqa: E402
    SkillSkipped,
    enable_utf8_stdout,
    load_env_file,
)


def _slug(text: str) -> str:
    """Безопасное имя файла из запроса."""
    keep = [ch if (ch.isalnum() or ch in "-_") else "-" for ch in text.strip().lower()]
    slug = "".join(keep).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:60] or "query"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _summary_markdown(query: str, params: dict, result: dict, raw: dict) -> str:
    """Краткая сводка рядом с сырым ответом."""
    lines = [
        "# Разовая глубокая проверка ReefAPI (Авито)",
        "",
        f"- **Дата:** {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        f"- **Запрос:** `{query}`",
        f"- **Параметры:** `{json.dumps(params, ensure_ascii=False)}`",
        "",
        "## Результат",
        "",
        "| Показатель | Значение |",
        "|---|---|",
    ]
    labels = {
        "ok": "Успех", "charged_credits": "Списано кредитов",
        "latency_ms": "Задержка сервера, мс", "stop_reason": "Причина остановки",
        "request_id": "request_id", "count": "Объявлений на странице",
        "total": "Всего найдено", "page": "Страница", "has_more": "Есть следующая",
        "listings": "Объявлений в ответе", "query_interpreted_as": "Avito понял запрос как",
        "error": "Код ошибки", "error_message": "Сообщение об ошибке",
    }
    for key, label in labels.items():
        value = result.get(key)
        if value is not None:
            lines.append(f"| {label} | `{json.dumps(value, ensure_ascii=False)}` |")
    lines += ["", "## Что дальше", ""]
    if result.get("ok") and result.get("listings"):
        lines.append(
            "Ответ содержит объявления. Маппинг полей в `lots.csv` ещё НЕ сделан — "
            "сначала посмотрите имена полей в сыром JSON ниже."
        )
    elif result.get("ok"):
        lines.append(
            "Ответ успешный, но **объявлений нет**. Скорее всего Avito не сопоставил "
            "текст запроса: попробуйте другую формулировку (как пишут в объявлении)."
        )
    else:
        lines.append(
            f"Запрос не удался: `{result.get('error')}` — {result.get('error_message')}. "
            "Успешные запросы не списывают кредиты, отказ бесплатен."
        )
    lines += [
        "",
        "## Ограничения",
        "",
        "- Источник **не входит** в недельный цикл Агента 1 (скорость 25–280+ с).",
        "- Данные Авито получены через сторонний парсер; решение о риске принято "
        "пользователем 2026-11-04.",
        "- В `lots.csv` ничего не записано: схема объявления не подтверждена.",
        "",
        "## Сырой ответ",
        "",
        f"`{raw.get('_file', '')}`",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    enable_utf8_stdout()
    load_env_file()

    parser = argparse.ArgumentParser(
        prog="reefapi_deep_check.py",
        description="Разовая глубокая проверка Авито через ReefAPI (вне недельного цикла).",
    )
    parser.add_argument("--query", help="что искать, например \"Селигер Сити\"")
    parser.add_argument("--api", default="avito", choices=["avito", "cian"],
                        help="какое API ReefAPI использовать")
    parser.add_argument("--endpoint", default=reefapi.REAL_ESTATE_ENDPOINT,
                        help="путь эндпоинта (по умолчанию real_estate/search)")
    parser.add_argument("--transaction", default="sale",
                        choices=["sale", "rent_long", "rent_daily", "rent"],
                        help="тип сделки; обязателен для real_estate/search")
    parser.add_argument("--location", default="moskva", help="слаг локации Авито")
    parser.add_argument("--property-type", default="apartment", dest="property_type",
                        choices=["apartment", "room", "house", "land", "garage", "commercial"])
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=reefapi.DEFAULT_LONG_TIMEOUT,
                        help="таймаут, с (по умолчанию 300, предел 600)")
    parser.add_argument("--list-recent", action="store_true",
                        help="показать прошлые проверки и выйти")
    args = parser.parse_args(argv)

    if args.list_recent:
        if not OUT_DIR.is_dir():
            print("прошлых проверок нет: %s" % OUT_DIR)
            return 0
        for path in sorted(OUT_DIR.glob("*.summary.md")):
            print("  %s" % path.name)
        return 0

    if not args.query:
        parser.error("нужен --query (или --list-recent)")

    params = {
        "api": args.api, "endpoint": args.endpoint, "transaction": args.transaction,
        "location": args.location, "property_type": args.property_type, "page": args.page,
    }
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    base = "%s_%s_%s" % (stamp, args.api, _slug(args.query))
    raw_path = OUT_DIR / ("%s.json" % base)
    summary_path = OUT_DIR / ("%s.summary.md" % base)

    print("Запрос: %r | %s | transaction=%s | таймаут %.0f с"
          % (args.query, args.endpoint, args.transaction, args.timeout))
    print("Ожидайте: живой поиск Авито идёт от 25 до 280+ секунд, это нормально.")

    try:
        response = reefapi.fetch_long(
            args.query,
            api=args.api,
            endpoint=args.endpoint,
            transaction=args.transaction,
            location=args.location,
            property_type=args.property_type,
            page=args.page,
            timeout=args.timeout,
        )
    except SkillSkipped as exc:
        print("ОТКАЗ: %s" % exc.reason, file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 — оператору нужен понятный текст
        print("ОШИБКА запроса: %s" % exc, file=sys.stderr)
        print("Подсказка: увеличьте --timeout; живой поиск Авито бывает > 280 с.",
              file=sys.stderr)
        return 1

    _write(raw_path, json.dumps(response, ensure_ascii=False, indent=2))

    result = reefapi.describe_response(response)
    meta = {"query": args.query, **params, "timeout": args.timeout,
            "_file": str(raw_path.relative_to(PROJECT_ROOT))}
    _write(summary_path, _summary_markdown(args.query, params, result, meta))

    print()
    print("ok=%s | объявлений=%s | всего=%s | кредитов=%s | задержка=%s мс"
          % (result.get("ok"), result.get("listings"), result.get("total"),
             result.get("charged_credits"), result.get("latency_ms")))
    if result.get("error"):
        print("ошибка: %s — %s" % (result.get("error"), result.get("error_message")))
    if result.get("query_interpreted_as"):
        print("Avito понял запрос как: %s" % json.dumps(
            result["query_interpreted_as"], ensure_ascii=False))

    listings = ((response.get("data") or {}).get("listings") or [])
    if listings and isinstance(listings[0], dict):
        print()
        print("ПОЛЯ ОБЪЯВЛЕНИЯ (%d):" % len(listings[0]))
        for key in listings[0]:
            print("   - %s" % key)

    print()
    print("Сырой ответ: %s" % raw_path.relative_to(PROJECT_ROOT))
    print("Сводка:      %s" % summary_path.relative_to(PROJECT_ROOT))
    print("В lots.csv ничего не записано: схема объявления не подтверждена.")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
