"""Скилл ``zillapi`` — ZillAPI: прокси-доступ к данным Zillow.

Источник
--------
Base ``https://api.zillapi.com``, авторизация ``Authorization: Bearer zk_…``.
Адрес можно переопределить через ``ZILLAPI_BASE_URL`` (прокси, отладка).

Проверенные факты из документации:

* ``POST /v1/search`` — поиск объектов;
* ``GET /v1/properties/{zpid}`` — карточка объекта;
* ``GET /v1/listings`` — листинги;
* ``GET /v1/usage`` — расход кредитов;
* бесплатно 100 кредитов без карты, 1 кредит = 1 запись объекта,
  неуспешные вызовы кредиты не тратят.

Здесь подключены два режима из четырёх: ``search`` и ``usage``.
Карточка по ``zpid`` и ``listings`` в модуле не реализованы — чтобы не
обещать того, чего нет; добавлять их нужно вместе с реальной проверкой схемы
ответа.

Честные ограничения
-------------------
* Это **рынок США** (Zillow): цены в долларах, адреса США. К новостройкам
  Москвы скилл неприменим.
* Ключ обязателен: без ``ZILLAPI_KEY`` скилл пропускается со статусом
  ``skipped_no_key``.
* Схема тела ``POST /v1/search`` в публичной документации не зафиксирована
  дословно. Модуль отправляет ``{"filters": {"query": <запрос>}, "limit": n}``
  как наиболее вероятный вариант; если у сервиса другое имя поля, тело можно
  переопределить через ``extra_body``. Альтернатива по документации —
  ``searchUrls`` со ссылками вида ``https://www.zillow.com/homes/...``.
* Лимит записей ограничен ``max_items``: каждая запись стоит 1 кредит, а
  бесплатных всего 100.

Вход
----
:param query: поисковая строка (адрес, город, штат)
:param mode: ``search`` (поиск) или ``usage`` (расход кредитов)
:param max_items: сколько записей просить (по умолчанию 50)
:param extra_body: дополнительные поля тела для ``mode="search"``
:param timeout: таймаут запроса: аргумент, иначе ``ZILLAPI_TIMEOUT``, иначе 10 секунд

Выход
-----
``list[dict]`` в формате :func:`skills.runtime.make_record`. Для ``usage``
возвращается одна запись со сводкой кредитов; для ``search`` дополнительно
``zpid`` и ``property_type``.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/zillapi.py "Austin, TX"
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from typing import Any

from skills.runtime import (
    SkillError,
    env_value,
    http_json,
    log,
    make_record,
    require_env,
    skill,
)

SKILL_NAME = "zillapi"
BASE_URL = "https://api.zillapi.com"
SEARCH_PATH = "/v1/search"
USAGE_PATH = "/v1/usage"
DEFAULT_TIMEOUT = 10.0
KEY_ENV = "ZILLAPI_KEY"
BASE_URL_ENV = "ZILLAPI_BASE_URL"
TIMEOUT_ENV = "ZILLAPI_TIMEOUT"

#: Режимы, которые реально реализованы и проверены тестами.
MODES: tuple[str, ...] = ("search", "usage")

DEFAULT_MAX_ITEMS = 50
HARD_MAX_ITEMS = 200  # страховка от случайного расхода кредитов

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "ZillAPI (Zillow, рынок США)",
    "kind": "REST API",
    "required_env": [KEY_ENV],
    "optional_env": [BASE_URL_ENV, TIMEOUT_ENV],
    "free_tier": "100 кредитов без карты, 1 кредит = 1 запись",
    "docs": "https://docs.zillapi.com/",
}


def _text(value: Any) -> str | None:
    """Привести значение к строке; пустое и нестроковое -> ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _number(value: Any) -> int | float | None:
    """Число из значения; «нет данных» -> ``None``, а не ноль."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("$", "").strip()
        try:
            number = float(cleaned)
        except ValueError:
            return None
        return int(number) if number.is_integer() else number
    if isinstance(value, dict):
        for key in ("value", "amount", "price", "min", "max"):
            if key in value:
                number = _number(value[key])
                if number is not None:
                    return number
    return None


def _base_url() -> str:
    """Base URL из ``ZILLAPI_BASE_URL`` (прокси, отладка) или значение по умолчанию."""
    value = (env_value(BASE_URL_ENV) or "").strip().rstrip("/")
    return value or BASE_URL


def _resolve_timeout(seconds: float | None) -> float:
    """Таймаут: явный аргумент важнее ``ZILLAPI_TIMEOUT``, иначе 10 секунд.

    Верхнюю границу всё равно срезает ``clamp_timeout`` из рантайма.
    """
    if seconds is not None:
        return seconds
    raw = env_value(TIMEOUT_ENV)
    if raw:
        try:
            return float(raw)
        except ValueError:
            log.warning(
                "скилл %s: %s=%r не число, беру %.0f с",
                SKILL_NAME,
                TIMEOUT_ENV,
                raw,
                DEFAULT_TIMEOUT,
            )
    return DEFAULT_TIMEOUT


def _limit(max_items: Any) -> int:
    """Аккуратный размер выборки: мусор -> 50, 0 и меньше -> 50, потолок 200."""
    try:
        value = int(max_items)
    except (TypeError, ValueError):
        return DEFAULT_MAX_ITEMS
    if value <= 0:
        return DEFAULT_MAX_ITEMS
    return min(value, HARD_MAX_ITEMS)


def _search_items(payload: Any) -> list[dict]:
    """Записи поиска из ответа; всё неподходящее -> пустой список."""
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("results", "data", "items", "properties", "listings"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def _usage_record(payload: Any) -> list[dict]:
    """Сводка расхода кредитов одной записью; без данных -> пустой список."""
    if not isinstance(payload, dict) or not payload:
        return []

    credits = payload.get("credits")
    if not isinstance(credits, dict):
        credits = {}

    def _metric(*keys: str) -> Any:
        for key in keys:
            if payload.get(key) is not None:
                return payload.get(key)
            if credits.get(key) is not None:
                return credits.get(key)
        return None

    return [
        make_record(
            SKILL_NAME,
            id="usage",
            title="расход кредитов ZillAPI",
            credits_remaining=_number(_metric("remaining", "credits_remaining")),
            credits_used=_number(_metric("used", "credits_used")),
            plan=_text(_metric("plan")),
            raw=payload,
        )
    ]


@skill(SKILL_NAME)
def fetch(
    query: str,
    *,
    mode: str = "search",
    max_items: int = DEFAULT_MAX_ITEMS,
    extra_body: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> list[dict]:
    """Найти объекты Zillow (``search``) или посмотреть расход кредитов (``usage``).

    :raises SkillSkipped: не задан ``ZILLAPI_KEY`` (статус ``skipped_no_key``)
    :raises SkillError: неизвестный режим или сбой сети (``error``)
    """
    api_key = require_env(KEY_ENV, skill=SKILL_NAME)

    selected = (mode or "").strip().lower()
    if selected not in MODES:
        raise SkillError(
            f"скилл {SKILL_NAME}: режим {mode!r} не поддерживается; "
            f"доступны: {', '.join(MODES)}"
        )

    headers = {"Authorization": f"Bearer {api_key}"}

    if selected == "usage":
        payload = http_json(
            f"{_base_url()}{USAGE_PATH}",
            headers=headers,
            timeout=_resolve_timeout(timeout),
            skill=SKILL_NAME,
        )
        return _usage_record(payload)

    text = (query or "").strip()
    if not text:
        return []

    body: dict[str, Any] = {"filters": {"query": text}, "limit": _limit(max_items)}
    if isinstance(extra_body, dict):
        body.update(extra_body)

    payload = http_json(
        f"{_base_url()}{SEARCH_PATH}",
        method="POST",
        headers=headers,
        payload=body,
        timeout=_resolve_timeout(timeout),
        skill=SKILL_NAME,
    )

    records: list[dict] = []
    for item in _search_items(payload):
        records.append(
            make_record(
                SKILL_NAME,
                id=_text(item.get("zpid") or item.get("id")),
                title=_text(
                    item.get("address")
                    or item.get("formattedAddress")
                    or item.get("streetAddress")
                ),
                price=_number(
                    item.get("price")
                    or item.get("listPrice")
                    or item.get("unformattedPrice")
                ),
                area=_number(
                    item.get("livingArea") or item.get("area") or item.get("lotArea")
                ),
                year_built=_number(item.get("yearBuilt")),
                address=_text(
                    item.get("address")
                    or item.get("formattedAddress")
                    or item.get("streetAddress")
                ),
                url=_text(item.get("url") or item.get("zillowUrl") or item.get("link")),
                zpid=_text(item.get("zpid")),
                property_type=_text(item.get("propertyType") or item.get("homeType")),
                raw=item,
            )
        )
    return records


if __name__ == "__main__":  # python skills/real_estate/zillapi.py "Austin, TX" | usage
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    arg = sys.argv[1] if len(sys.argv) > 1 else "Austin, TX"
    if arg == "usage":
        print(json.dumps(fetch("", mode="usage"), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(fetch(arg), ensure_ascii=False, indent=2))
