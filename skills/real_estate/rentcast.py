"""Скилл ``rentcast`` — RentCast API: листинги, объекты и оценка аренды.

Источник
--------
Base ``https://api.rentcast.io/v1/``, авторизация заголовком
``X-Api-Key: <RENTCAST_KEY>``. Бесплатный тариф — 50 запросов в месяц
(по документации сервиса; живым запросом не проверялось — ключа нет).
Адрес можно переопределить через ``RENTCAST_BASE_URL`` (прокси, отладка).

Честные ограничения
-------------------
* Это **рынок США**: адреса, штаты, цены в долларах. К новостройкам Москвы
  скилл неприменим — нужны ``cian`` / ``yandex-realty`` / ``mcp_market``.
* Ключ обязателен, анонимного доступа нет: без ``RENTCAST_KEY`` скилл
  пропускается со статусом ``skipped_no_key``.
* Бесплатных 50 запросов мало: пагинация и массовые обходы быстро
  исчерпывают лимит, поэтому ``limit`` по умолчанию скромный (50).
* У эндпоинтов ``listings/...`` нет поля ``address``: свободный текст туда
  уходит только через ``search_field="city"`` / ``"state"`` / ``"zipCode"``.
  Если оставить ``search_field="address"`` для листингов, скилл пишет
  предупреждение и **не отправляет** неподдерживаемое поле (иначе сервис
  вернул бы HTTP 400), то есть текст запроса игнорируется.

Вход
----
:param query: свободный текст; уходит в поле ``search_field``
:param endpoint: путь от ``https://api.rentcast.io/v1/``, только из списка
    :data:`ENDPOINTS` — произвольные пути не подставляются
:param city: город (``city`` в query-строке)
:param state: штат, двухбуквенный код (``state`` в query-строке)
:param limit: размер страницы (``limit`` в query-строке)
:param search_field: куда положить ``query``: ``address`` (по умолчанию),
    ``city``, ``state`` или ``zipCode``
:param timeout: таймаут запроса: аргумент, иначе ``RENTCAST_TIMEOUT``, иначе 10 секунд

Выход
-----
``list[dict]`` в формате :func:`skills.runtime.make_record`. Дополнительно:
``endpoint``, ``property_type``, ``bedrooms``, ``bathrooms``. Если сервис
отдал не массив (например одиночный объект AVM), скилл не выдумывает лот и
возвращает пустой список.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/rentcast.py
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

SKILL_NAME = "rentcast"
BASE_URL = "https://api.rentcast.io/v1"
DEFAULT_ENDPOINT = "listings/rental/long-term"
DEFAULT_TIMEOUT = 10.0
KEY_ENV = "RENTCAST_KEY"
BASE_URL_ENV = "RENTCAST_BASE_URL"
TIMEOUT_ENV = "RENTCAST_TIMEOUT"

#: Разрешённые эндпоинты: чужие пути не подставляем в URL.
ENDPOINTS: tuple[str, ...] = (
    "listings/rental/long-term",
    "listings/rental/short-term",
    "listings/sale",
    "properties",
    "avm/value",
    "avm/rent/long-term",
    "markets",
)

#: Куда разрешено положить свободный текст запроса.
SEARCH_FIELDS: tuple[str, ...] = ("address", "city", "state", "zipCode")

#: Эндпоинты, которые не понимают ``address`` (листинги фильтруются по
#: городу/штату/типу, а не по адресу).
NO_ADDRESS_PREFIXES: tuple[str, ...] = ("listings/",)

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "RentCast (рынок США)",
    "kind": "REST API",
    "required_env": [KEY_ENV],
    "optional_env": [BASE_URL_ENV, TIMEOUT_ENV],
    "free_tier": "50 запросов в месяц",
    "docs": "https://developers.rentcast.io/reference",
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
    return None


def _base_url() -> str:
    """Base URL из ``RENTCAST_BASE_URL`` (прокси, отладка) или значение по умолчанию."""
    value = (env_value(BASE_URL_ENV) or "").strip().rstrip("/")
    return value or BASE_URL


def _resolve_timeout(seconds: float | None) -> float:
    """Таймаут: явный аргумент важнее ``RENTCAST_TIMEOUT``, иначе 10 секунд.

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


@skill(SKILL_NAME)
def fetch(
    query: str,
    *,
    endpoint: str = DEFAULT_ENDPOINT,
    city: str | None = None,
    state: str | None = None,
    limit: int | None = 50,
    search_field: str = "address",
    timeout: float | None = None,
) -> list[dict]:
    """Запросить листинги или объекты RentCast и собрать записи.

    :raises SkillSkipped: не задан ``RENTCAST_KEY`` (статус ``skipped_no_key``)
    :raises SkillError: неизвестный эндпоинт или сбой сети (``error``)
    """
    api_key = require_env(KEY_ENV, skill=SKILL_NAME)

    path = (endpoint or "").strip().strip("/") or DEFAULT_ENDPOINT
    if path not in ENDPOINTS:
        raise SkillError(
            f"скилл {SKILL_NAME}: эндпоинт {path!r} не разрешён; "
            f"доступны: {', '.join(ENDPOINTS)}"
        )

    params: dict[str, Any] = {"city": city, "state": state, "limit": limit}

    text = (query or "").strip()
    if text:
        field = (search_field or "address").strip()
        if field not in SEARCH_FIELDS:
            log.warning(
                "скилл %s: неизвестное search_field=%r, используется address",
                SKILL_NAME,
                search_field,
            )
            field = "address"
        if field == "address" and path.startswith(NO_ADDRESS_PREFIXES):
            log.warning(
                "скилл %s: эндпоинт %s не поддерживает address — "
                "свободный текст %r не отправлен, используйте city/state/zipCode",
                SKILL_NAME,
                path,
                text,
            )
        else:
            params[field] = text

    payload = http_json(
        f"{_base_url()}/{path}",
        params=params,
        headers={"X-Api-Key": api_key},
        timeout=_resolve_timeout(timeout),
        skill=SKILL_NAME,
    )

    if not isinstance(payload, list):
        log.warning(
            "скилл %s: ответ не массив (%s) — одиночные объекты лотами не считаем",
            SKILL_NAME,
            type(payload).__name__,
        )
        return []

    records: list[dict] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        address = _text(
            item.get("formattedAddress") or item.get("addressLine1")
        )
        records.append(
            make_record(
                SKILL_NAME,
                id=_text(item.get("id")),
                title=address,
                price=_number(item.get("price")),
                area=_number(item.get("squareFootage")),
                year_built=_number(item.get("yearBuilt")),
                address=address,
                url=None,  # RentCast не отдаёт ссылку на карточку объявления
                endpoint=path,
                property_type=_text(item.get("propertyType")),
                bedrooms=_number(item.get("bedrooms")),
                bathrooms=_number(item.get("bathrooms")),
                raw=item,
            )
        )
    return records


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/rentcast.py Austin TX
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    q = sys.argv[1] if len(sys.argv) > 1 else ""
    st = sys.argv[2] if len(sys.argv) > 2 else "TX"
    print(json.dumps(fetch(q, state=st), ensure_ascii=False, indent=2))
