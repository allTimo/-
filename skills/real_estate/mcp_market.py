"""Скилл ``mcp_market`` — MCP Market Russia: каталог компаний строительного рынка.

Источник
--------
``GET https://mcp-market.ru/api/v1/search/companies?q=<запрос>``
Ключ не нужен: анонимный доступ работает (проверено 2026-11-04, HTTP 200).

Вход
----
:param query: поисковая строка, например ``"каркасные дома в спб"``
:param limit: размер страницы (по умолчанию отдаёт 20)
:param offset: смещение для постраничного обхода
:param timeout: таймаут запроса, не больше 10 секунд

Выход
-----
``list[dict]`` в едином формате :func:`skills.runtime.make_record`. Дополнительно:

* ``region`` — регион компании;
* ``category`` — категория (``строительство``, ``каркасные_дома``, …);
* ``rating`` — рейтинг, ``reviews_count`` — число отзывов;
* ``website``, ``phone`` — контакты;
* ``price_per_sqm_min`` / ``price_per_sqm_max`` — цена за м², если отдана.

Ограничение честности: поле ``price`` остаётся ``None`` — это каталог компаний,
а не объявления о лотах, цены объекта здесь нет. Цена за м² кладётся в отдельные
поля, чтобы её нельзя было спутать с ценой лота.

Что это не даёт
---------------
Это каталог **строительных подрядчиков**, а не база новостроек: ни лотов,
ни цен квартир, ни корпусов. Для лотов нужны ``cian`` / ``yandex-realty``.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/mcp_market.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from typing import Any

from skills.runtime import http_json, make_record, skill

SKILL_NAME = "mcp_market"
BASE_URL = "https://mcp-market.ru/api/v1"
SEARCH_URL = f"{BASE_URL}/search/companies"
DEFAULT_TIMEOUT = 10.0

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "MCP Market Russia",
    "kind": "REST API",
    "required_env": [],
    "free_tier": "полностью бесплатно, ключ не требуется",
    "docs": "https://mcp-market.ru/",
}


@skill(SKILL_NAME)
def fetch(
    query: str,
    *,
    limit: int | None = None,
    offset: int | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Найти компании строительного рынка по поисковой строке."""
    if not query or not query.strip():
        return []

    payload = http_json(
        SEARCH_URL,
        params={"q": query.strip(), "limit": limit, "offset": offset},
        timeout=timeout,
        skill=SKILL_NAME,
    )

    companies = payload.get("companies") if isinstance(payload, dict) else None
    if not isinstance(companies, list):
        return []

    records: list[dict] = []
    for company in companies:
        if not isinstance(company, dict):
            continue
        records.append(
            make_record(
                SKILL_NAME,
                id=company.get("id"),
                title=company.get("name"),
                url=company.get("website") or None,
                region=company.get("region"),
                category=company.get("category"),
                rating=company.get("rating"),
                reviews_count=company.get("reviews_count"),
                phone=company.get("phone"),
                price_per_sqm_min=company.get("price_per_sqm_min"),
                price_per_sqm_max=company.get("price_per_sqm_max"),
                description=company.get("description"),
                raw=company,
            )
        )
    return records


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/mcp_market.py "запрос"
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    q = sys.argv[1] if len(sys.argv) > 1 else "каркасные дома в спб"
    print(json.dumps(fetch(q), ensure_ascii=False, indent=2))
