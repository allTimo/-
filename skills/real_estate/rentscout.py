"""Скилл ``rentscout`` — клиент локального сервиса RentScout (аренда жилья).

Статус развёртывания
--------------------
Развёртывание **НЕ выполнено**, и канонического проекта с ожидаемым набором
источников не существует. Проверено 2026-11-04: GitHub-поиск ``rentscout`` даёт
16 репозиториев, заявленный набор ``Avito / Cian / Domofond / Yandex Realty /
DomClick`` ни в одном не подтверждён — в RU-форке ``CreatmanCEO/rentscout``
(помечен как Commercial) источники другие: Avito, Cian, Yandex Travel,
Sutochno, Ostrovok.

Поведение
---------
Модуль — только клиент: он не поднимает сервис сам. Если локальный сервис не
отвечает, ``fetch`` поднимает :class:`skills.runtime.SkillUnavailable` с явным
пояснением, как сервис поднять (docker или python-пакет) и что набор источников
не подтверждён; наружу это даёт ``[]`` и статус ``not_deployed``.

Вход
----
:param query: поисковая строка, например ``"снять однушку в Москве"``
:param sources: список источников; строка ``"avito,cian"`` или ``list[str]``.
    Пусто — берётся ``RENTSCOUT_SOURCES``; сервис отдаёт только подтверждённые им
:param timeout: таймаут запроса, не больше 10 секунд; пусто — ``RENTSCOUT_TIMEOUT``

Окружение
---------
* ``RENTSCOUT_URL`` — база сервиса, по умолчанию ``http://127.0.0.1:8000``;
* ``RENTSCOUT_SOURCES`` — источники через запятую;
* ``RENTSCOUT_TIMEOUT`` — таймаут в секундах (обрезается до 10).

Выход
-----
``list[dict]`` в едином формате :func:`skills.runtime.make_record`.
Дополнительно: ``listing_source`` — сайт-источник объявления и ``rooms`` —
комнатность. Отсутствующие данные остаются ``None``.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/rentscout.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from typing import Any

from skills.runtime import (
    SkillError,
    SkillUnavailable,
    env_value,
    http_json,
    make_record,
    skill,
)

SKILL_NAME = "rentscout"
DEFAULT_URL = "http://127.0.0.1:8000"
SEARCH_PATH = "/search"
DEFAULT_TIMEOUT = 10.0

URL_ENV = "RENTSCOUT_URL"
SOURCES_ENV = "RENTSCOUT_SOURCES"
TIMEOUT_ENV = "RENTSCOUT_TIMEOUT"

#: Признаки того, что ответ пришёл, но разобрать его нельзя (это не «сервис не поднят»).
_PARSE_MARKERS = ("не является JSON", "пустой ответ")

#: Пояснение о неразвёрнутом сервисе — единое для лога и для вызывающего агента.
DEPLOY_HINT = (
    "Локальный сервис RentScout не развёрнут: запрос к {url}{path} не удался ({reason}). "
    "Скилл — только клиент, сам сервис он не поднимает. Как поднять: "
    "1) docker-образ проекта RentScout (см. docs {docs}); "
    "2) либо локальный запуск python-пакета/uvicorn с тем же API {path}; "
    "после запуска задайте переменную окружения {url_env} (сейчас база {url}) и при необходимости {sources_env}. "
    "ВАЖНО: канонический набор источников Avito / Cian / Domofond / Yandex Realty / DomClick "
    "НЕ подтверждён — в публичных репозиториях подтверждены только Avito, Cian, Yandex Travel, "
    "Sutochno, Ostrovok, а RU-форк CreatmanCEO/rentscout помечен как Commercial. "
    "Считайте перечень источников непроверенным и сверяйте его с фактическим ответом сервиса."
)

#: Ключи-обёртки, внутри которых сервис может положить список объявлений.
ITEM_KEYS = ("items", "results", "listings", "offers", "ads", "objects", "data", "result")

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "RentScout (Open Source)",
    "kind": "локальный сервис",
    "required_env": [],
    "free_tier": "ключ не требуется — сервис разворачивается локально",
    "docs": "https://github.com/QuadDarv1ne/rentscout",
}


def _pick(item: dict, *keys: str) -> Any:
    """Первое непустое значение из перечисленных ключей (или ``None``)."""
    for key in keys:
        value = item.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _as_price(value: Any) -> Any:
    """Цена может прийти числом или конвертом ``{"value": ...}``."""
    if isinstance(value, dict):
        return _pick(value, "value", "amount", "price", "rub", "RUB")
    return value


def _items_from(node: Any) -> list[dict] | None:
    """Достать список объявлений из узла ответа; ``None`` — узел не подошёл."""
    if isinstance(node, list):
        return [element for element in node if isinstance(element, dict)]
    if isinstance(node, dict):
        for key in ("items", "results", "listings", "offers", "ads", "objects"):
            child = node.get(key)
            if isinstance(child, list):
                return [element for element in child if isinstance(element, dict)]
        for key in ("data", "result", "response", "payload"):
            if key in node:
                found = _items_from(node[key])
                if found is not None:
                    return found
    return None


def _extract_items(response: Any) -> list[dict]:
    """Список объявлений из ответа сервиса; пустой список, если их нет."""
    if isinstance(response, list):
        return [element for element in response if isinstance(element, dict)]
    if isinstance(response, dict):
        for key in ITEM_KEYS:
            if key in response:
                found = _items_from(response[key])
                if found is not None:
                    return found
    return []


def _base_url() -> str:
    """База сервиса из ``RENTSCOUT_URL`` (по умолчанию локальный порт 8000)."""
    return (env_value(URL_ENV) or DEFAULT_URL).rstrip("/")


def _sources_param(sources: Any) -> str | None:
    """Источники одной строкой: из аргумента или из ``RENTSCOUT_SOURCES``."""
    if sources is None:
        return env_value(SOURCES_ENV)
    if isinstance(sources, (list, tuple, set)):
        joined = ",".join(str(item).strip() for item in sources if str(item).strip())
        return joined or None
    text = str(sources).strip()
    return text or None


def _resolve_timeout(timeout: float | None) -> float:
    """Таймаут: аргумент, затем ``RENTSCOUT_TIMEOUT``, затем значение по умолчанию."""
    if timeout is not None:
        return timeout
    raw = env_value(TIMEOUT_ENV)
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        return float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT


def _is_parse_error(exc: SkillError) -> bool:
    """Отличить «ответ пришёл, но битый» от «сервис не отвечает»."""
    message = str(exc)
    return any(marker in message for marker in _PARSE_MARKERS)


@skill(SKILL_NAME)
def fetch(query: str, *, sources: Any = None, timeout: float | None = None) -> list[dict]:
    """Найти объявления об аренде в локальном сервисе RentScout.

    :raises SkillUnavailable: сервис не развёрнут или не отвечает — с пояснением,
        как его поднять и почему набор источников не подтверждён (наружу — ``[]``,
        статус ``not_deployed``)
    :raises SkillError: сервис ответил, но ответ не разбирается (статус ``error``)
    """
    text = (query or "").strip()
    if not text:
        return []

    base = _base_url()
    params = {"q": text, "sources": _sources_param(sources)}
    effective_timeout = _resolve_timeout(timeout)

    try:
        response = http_json(
            base + SEARCH_PATH,
            params=params,
            timeout=effective_timeout,
            skill=SKILL_NAME,
        )
    except SkillError as exc:
        if _is_parse_error(exc):
            raise  # битый JSON/пустой ответ — это сбой разбора, а не отсутствие сервиса
        raise SkillUnavailable(
            DEPLOY_HINT.format(
                url=base,
                path=SEARCH_PATH,
                reason=exc,
                docs=SKILL["docs"],
                url_env=URL_ENV,
                sources_env=SOURCES_ENV,
            )
        ) from exc

    records: list[dict] = []
    for item in _extract_items(response):
        records.append(
            make_record(
                SKILL_NAME,
                id=_pick(item, "id", "item_id", "listing_id", "uid"),
                title=_pick(item, "title", "name", "header"),
                price=_as_price(_pick(item, "price", "cost", "rent", "price_rub")),
                area=_pick(item, "area", "square", "total_area", "area_total"),
                year_built=_pick(item, "year_built", "build_year", "year", "completed_year"),
                address=_pick(item, "address", "location", "geo", "metro"),
                url=_pick(item, "url", "link", "uri"),
                listing_source=_pick(item, "source", "site", "provider", "origin"),
                rooms=_pick(item, "rooms", "rooms_count", "rooms_number"),
                description=_pick(item, "description", "snippet", "text"),
                published_at=_pick(item, "published_at", "date", "created_at", "time"),
                raw=item,
            )
        )
    return records


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/rentscout.py "запрос"
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    q = sys.argv[1] if len(sys.argv) > 1 else "снять однушку в Москве"
    print(json.dumps(fetch(q), ensure_ascii=False, indent=2))
