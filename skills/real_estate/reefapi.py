"""Скилл ``reefapi`` — живые объявления Avito и Cian через REST API ReefAPI.

Источник
--------
Единый шаблон запроса: ``POST https://api.reefapi.com/<api>/v1/<endpoint>``.
Авторизация — заголовок ``x-api-key``. Подтверждённые данные (проверено 2026-11-04):

* ``api=avito`` -> для недвижимости нужен **``endpoint=real_estate/search``**
  (2 кредита), а не общий ``search``;
* **``transaction`` обязателен**: ``sale``, ``rent_long``, ``rent_daily``, ``rent``;
* Avito **отклоняет** ``market`` вместе с ``transaction``
  (``UPSTREAM_HTTP``: «Avito refuses this filter combination») — отобрать
  новостройки прямым фильтром нельзя, только текстом запроса;
* ``api=cian`` -> API существует, лимиты те же;
* ответ-конверт: ``{"ok": bool, "data": ..., "meta": {...}, "error": {...}}``;
* в ``meta`` приходят ``charged_credits``, ``latency_ms``, ``record_count``,
  ``stop_reason``, ``request_id``; **неуспешные вызовы бесплатны**;
* при регистрации дают 1 000 бесплатных кредитов, карта не нужна.

СКОРОСТЬ — важное ограничение
-----------------------------
Живой поиск Авито отдаёт ответ **25–280+ секунд** (замеры 2026-11-04: мелкий
ответ 0,9–1,5 с, поиск по ЖК 68,7 с и 1,36 МБ, часть поисков не уложилась
в 280 с). Поэтому:

* :func:`fetch` укладывается в общий лимит скиллов (10 с) и на реальном поиске
  Авито **упадёт в таймаут** — он годится для быстрых/служебных вызовов;
* для разовой глубокой проверки есть :func:`fetch_long` с явным длинным
  таймаутом (по умолчанию 300 с). Это операторский режим, не недельный цикл.

По этой причине источник **не подключён** к недельному прогону Агента 1.
Подробности разведки: ``00-admin/research/reefapi-probe-2026-11-04.md``.

Вход
----
:param query: поисковая строка, например ``"Селигер Сити"``
:param api: какое API вызывать — ``"avito"`` (по умолчанию) или ``"cian"``;
    пустое значение читается из ``REEFAPI_API``
:param endpoint: путь эндпоинта внутри API; по умолчанию ``"search"``,
    для недвижимости Авито — ``"real_estate/search"``
:param timeout: таймаут запроса, не больше 10 секунд
:param filters: произвольные фильтры ReefAPI (``location``, ``transaction``,
    ``price_max``, ``rooms``); уезжают в тело запроса рядом с ``query``

Выход
-----
``list[dict]`` в едином формате :func:`skills.runtime.make_record`.
Дополнительные поля:

* ``credit_cost`` — кредиты, списанные за запрос (из ``meta.credits``; ``None``,
  если сервис не сообщил — «данных нет», а не ноль);
* ``api`` — через какое API получена запись (``avito`` / ``cian``);
* ``rooms``, ``description``, ``seller``, ``published_at`` — если отданы.

Честность данных
----------------
Точная схема тела запроса и имена полей лота документацией публично не
зафиксированы: модуль перебирает известные варианты ключей (``price.value``,
``square``, ``build_year`` …), а недостающее оставляет ``None``. Ответ
целиком сохраняется в ``raw``, чтобы потерь не было.

Ограничения
-----------
Ключ обязателен: без ``REEFAPI_KEY`` скилл пишет предупреждение и возвращает
``[]`` со статусом ``skipped_no_key``. После бесплатных кредитов запросы
платные.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/reefapi.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from typing import Any

from skills.runtime import (
    MAX_LONG_TIMEOUT,
    MAX_TIMEOUT,
    SkillError,
    env_value,
    http_json,
    log,
    make_record,
    record_run,
    require_env,
    skill,
)

SKILL_NAME = "reefapi"
API_BASE = "https://api.reefapi.com"
URL_TEMPLATE = API_BASE + "/{api}/v1/{endpoint}"
DEFAULT_API = "avito"
DEFAULT_ENDPOINT = "search"
#: Для недвижимости Авито нужен профильный эндпоинт, а не общий ``search``.
REAL_ESTATE_ENDPOINT = "real_estate/search"
ALLOWED_APIS = ("avito", "cian")
DEFAULT_TIMEOUT = 10.0
#: Таймаут операторской глубокой проверки (недельный цикл её не использует).
DEFAULT_LONG_TIMEOUT = 300.0
REQUIRED_ENV = "REEFAPI_KEY"

#: Ключи-обёртки, внутри которых сервис может положить список объявлений.
ITEM_KEYS = ("items", "results", "listings", "offers", "ads", "objects", "data", "result")

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "ReefAPI (Avito / Cian)",
    "kind": "REST API + ключ",
    "required_env": [REQUIRED_ENV],
    "optional_env": ["REEFAPI_API"],
    "free_tier": "1 000 бесплатных кредитов при регистрации, без карты; один пул на все API",
    "docs": "https://reefapi.com/docs/avito",
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
    """Достать список объявлений из узла ответа; ``None`` — узла не подошёл."""
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
    """Список объявлений из ответа-конверта; пустой список, если их нет."""
    if isinstance(response, list):
        return [element for element in response if isinstance(element, dict)]
    if isinstance(response, dict):
        for key in ITEM_KEYS:
            if key in response:
                found = _items_from(response[key])
                if found is not None:
                    return found
    return []


def _error_text(response: dict) -> str:
    """Человекочитаемое описание ошибки из поля ``error``."""
    error = response.get("error")
    if isinstance(error, dict):
        code = error.get("code") or error.get("status") or "?"
        message = error.get("message") or error.get("detail") or "без описания"
        return f"{code}: {message}"
    if error:
        return str(error)
    return "сервис вернул ok=false без поля error"


def _normalize_api(api: str | None) -> str:
    """Привести имя API к допустимому значению."""
    api_name = str(api or env_value("REEFAPI_API") or DEFAULT_API).strip().lower()
    if api_name not in ALLOWED_APIS:
        raise SkillError(f"неизвестное api={api_name!r}; допустимы: {', '.join(ALLOWED_APIS)}")
    return api_name


def _call(
    api_name: str,
    body: dict[str, Any],
    *,
    endpoint: str = DEFAULT_ENDPOINT,
    timeout: float = DEFAULT_TIMEOUT,
    ceiling: float = MAX_TIMEOUT,
) -> dict[str, Any]:
    """Сделать запрос к ReefAPI и вернуть конверт ``{ok, data, meta, error}``.

    :param ceiling: предел таймаута. Обычный вызов — 10 с; операторская
        глубокая проверка передаёт явно больший предел.
    """
    key = require_env(REQUIRED_ENV, skill=SKILL_NAME)
    response = http_json(
        URL_TEMPLATE.format(api=api_name, endpoint=endpoint.strip("/")),
        method="POST",
        headers={"x-api-key": key},
        payload=body,
        timeout=timeout,
        ceiling=ceiling,
        skill=SKILL_NAME,
    )
    return response if isinstance(response, dict) else {}


def describe_response(response: dict[str, Any]) -> dict[str, Any]:
    """Краткая сводка ответа ReefAPI — для отчёта и диагностики."""
    meta = response.get("meta") if isinstance(response.get("meta"), dict) else {}
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    listings = data.get("listings") if isinstance(data.get("listings"), list) else []
    return {
        "ok": response.get("ok"),
        "charged_credits": meta.get("charged_credits"),
        "latency_ms": meta.get("latency_ms"),
        "stop_reason": meta.get("stop_reason"),
        "request_id": meta.get("request_id"),
        "count": data.get("count"),
        "total": data.get("total"),
        "page": data.get("page"),
        "has_more": data.get("has_more"),
        "listings": len(listings),
        "query_interpreted_as": data.get("query_interpreted_as"),
        "error": (response.get("error") or {}).get("code") if response.get("error") else None,
        "error_message": (response.get("error") or {}).get("message") if response.get("error") else None,
    }


@skill(SKILL_NAME)
def fetch(
    query: str,
    *,
    api: str = DEFAULT_API,
    endpoint: str = DEFAULT_ENDPOINT,
    timeout: float = DEFAULT_TIMEOUT,
    **filters: Any,
) -> list[dict]:
    """Найти объявления Avito или Cian через ReefAPI по поисковой строке.

    :param endpoint: путь эндпоинта; для недвижимости Авито —
        :data:`REAL_ESTATE_ENDPOINT` (``real_estate/search``)
    :raises SkillSkipped: не задан ``REEFAPI_KEY`` (наружу — ``[]`` и предупреждение)
    :raises SkillError: сеть, HTTP-ошибка, битый JSON, неизвестное значение ``api``
    """
    text = (query or "").strip()
    if not text:
        return []

    api_name = _normalize_api(api)

    body: dict[str, Any] = {"query": text}
    for name, value in filters.items():
        if value is not None and value != "":
            body[name] = value

    response = _call(api_name, body, endpoint=endpoint, timeout=timeout)
    if not response:
        return []

    if response.get("ok") is False:
        log.error("скилл %s: ReefAPI вернул ошибку (%s) на api=%s", SKILL_NAME, _error_text(response), api_name)
        return []

    meta = response.get("meta") if isinstance(response.get("meta"), dict) else {}
    credit_cost = meta.get("charged_credits")
    if credit_cost is None:
        credit_cost = meta.get("credits")

    records: list[dict] = []
    for item in _extract_items(response):
        records.append(
            make_record(
                SKILL_NAME,
                id=_pick(item, "id", "item_id", "listing_id", "avito_id", "cian_id"),
                title=_pick(item, "title", "name", "header"),
                price=_as_price(_pick(item, "price", "cost", "price_rub")),
                area=_pick(item, "area", "square", "total_area", "area_total"),
                year_built=_pick(item, "year_built", "build_year", "year", "completed_year"),
                address=_pick(item, "address", "location", "geo", "district"),
                url=_pick(item, "url", "link", "uri"),
                credit_cost=credit_cost,
                api=api_name,
                rooms=_pick(item, "rooms", "rooms_count", "rooms_number"),
                description=_pick(item, "description", "snippet", "text"),
                seller=_pick(item, "seller", "seller_name", "author"),
                published_at=_pick(item, "published_at", "date", "created_at", "time"),
                raw=item,
            )
        )
    return records


def fetch_long(
    query: str,
    *,
    api: str = DEFAULT_API,
    endpoint: str = REAL_ESTATE_ENDPOINT,
    transaction: str = "sale",
    location: str | None = "moskva",
    property_type: str | None = "apartment",
    page: int | None = 1,
    timeout: float = DEFAULT_LONG_TIMEOUT,
    **filters: Any,
) -> dict[str, Any]:
    """Разовая глубокая проверка: СЫРОЙ ответ ReefAPI плюс запись в журнал.

    Почему отдельно от :func:`fetch`: живой поиск Авито идёт 25–280+ секунд и не
    влезает в контракт скилла (10 с). Здесь таймаут задаётся явно (по умолчанию
    300 с, жёсткий предел ``MAX_LONG_TIMEOUT`` = 600 с).

    Возвращает конверт ``{ok, data, meta, error}`` **без** маппинга в записи:
    имена полей объявления Авито не подтверждены, а выдумывать данные проект
    запрещает. Недельный цикл эту функцию не вызывает.

    :raises SkillSkipped: не задан ``REEFAPI_KEY``
    :raises SkillError: сеть, HTTP-ошибка, битый JSON, неизвестное ``api``
    """
    import time

    text = (query or "").strip()
    api_name = _normalize_api(api)

    body: dict[str, Any] = {"transaction": transaction}
    if text:
        body["query"] = text
    if location:
        body["location"] = location
    if property_type:
        body["property_type"] = property_type
    if page is not None:
        body["page"] = page
    for name, value in filters.items():
        if value is not None and value != "":
            body[name] = value

    started = time.perf_counter()
    try:
        response = _call(api_name, body, endpoint=endpoint, timeout=timeout,
                         ceiling=MAX_LONG_TIMEOUT)
    except SkillError as exc:
        elapsed = (time.perf_counter() - started) * 1000
        log.warning("скилл %s (долгий режим): %s", SKILL_NAME, exc)
        record_run(SKILL_NAME, query, "error", elapsed, 0, error=str(exc), mode="long")
        raise
    except Exception as exc:  # noqa: BLE001 — журнал важнее типа
        elapsed = (time.perf_counter() - started) * 1000
        record_run(SKILL_NAME, query, "error", elapsed, 0, error=str(exc), mode="long")
        raise

    elapsed = (time.perf_counter() - started) * 1000
    summary = describe_response(response)
    status = "ok" if summary.get("ok") and summary.get("listings") else (
        "empty" if summary.get("ok") else "error")
    log.info(
        "скилл %s (долгий режим): ok=%s объявлений=%s кредитов=%s за %.0f мс",
        SKILL_NAME, summary.get("ok"), summary.get("listings"),
        summary.get("charged_credits"), elapsed,
    )
    record_run(SKILL_NAME, query, status, elapsed, summary.get("listings") or 0,
               mode="long", endpoint=endpoint, transaction=transaction,
               credits=summary.get("charged_credits"), error=summary.get("error"))
    return response


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/reefapi.py "запрос" [avito|cian]
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    q = sys.argv[1] if len(sys.argv) > 1 else "купить 2-к квартиру в Москве"
    api_arg = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API
    print(json.dumps(fetch(q, api=api_arg), ensure_ascii=False, indent=2))
