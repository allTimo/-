"""Скилл ``apify`` — синхронный запуск готовых акторов Apify Store.

Источник
--------
``POST https://api.apify.com/v2/acts/{actorId}/run-sync-get-dataset-items``

* авторизация: ``Authorization: Bearer <APIFY_TOKEN>``;
* тело: JSON-вход актора, запрос кладётся сразу как ``search`` и ``query``;
* ответ: список объектов датасета (то, что актор положил в dataset).

Бесплатный тариф Apify — $5 кредитов в месяц (по документации платформы;
живым запросом не проверялось — рабочего ключа нет).

Идентификатор актора
--------------------
Берётся из ``APIFY_ACTOR`` (например ``apify~zillow-scraper``) или из
необязательного аргумента ``actor_id``. Если он не задан, скилл не выдумывает
актора, а поднимает :class:`SkillUnavailable`: статус ``not_deployed``,
пояснение в журнале и пустой результат.

Честные ограничения
-------------------
* Готовый актор под Cian **дублирует существующий коннектор**
  ``cian-connector``: смысл появляется только там, где нужен обход блокировок
  через прокси Apify, а не как замена уже работающего коннектора.
* Zillow, Realtor.com, Redfin и большинство акторов Store — **рынок США**;
  к новостройкам Москвы это неприменимо.
* Схема входа у каждого актора своя: поля ``search``/``query`` понимают не все.
  Точный набор полей можно задать через ``extra_input``.
* Режим ``run-sync`` держит соединение до конца прогона актора, а таймаут
  скилла ограничен 10 секундами, поэтому долгие акторы до результата не
  доживут. Для них нужен асинхронный сценарий (``/runs`` + опрос статуса),
  которого здесь нет.

Вход
----
:param query: поисковая строка, уходит в тело входа актора
:param actor_id: переопределить ``APIFY_ACTOR``
:param extra_input: дополнительные поля входа актора
:param timeout: таймаут запроса: аргумент, иначе ``APIFY_TIMEOUT``, иначе 10 секунд

Выход
-----
``list[dict]`` в формате :func:`skills.runtime.make_record`: ``id``, ``title``,
``price``, ``area``, ``year_built``, ``address``, ``url`` достаются из типовых
ключей разных акторов, весь объект целиком лежит в ``raw``. Дополнительно
``actor`` — идентификатор актора.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/apify.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import re
import urllib.parse
from typing import Any

from skills.runtime import (
    SkillUnavailable,
    env_value,
    http_json,
    log,
    make_record,
    require_env,
    skill,
)

SKILL_NAME = "apify"
BASE_URL = "https://api.apify.com/v2"
DEFAULT_TIMEOUT = 10.0
TOKEN_ENV = "APIFY_TOKEN"
ACTOR_ENV = "APIFY_ACTOR"
TIMEOUT_ENV = "APIFY_TIMEOUT"

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "Apify (готовые акторы Store)",
    "kind": "REST API (run-sync)",
    "required_env": [TOKEN_ENV],
    "optional_env": [ACTOR_ENV, TIMEOUT_ENV],
    "free_tier": "$5 кредитов в месяц, карта не обязательна",
    "docs": "https://docs.apify.com/api/v2",
}


def _pick(item: dict, keys: tuple[str, ...]) -> Any:
    """Первое непустое значение из типовых ключей разных акторов."""
    for key in keys:
        value = item.get(key)
        if value not in (None, ""):
            return value
    return None


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
    """Число из значения; «нет данных» -> ``None``, а не ноль.

    Понимает и числа, и строки вида ``"$1,200,000"``, и словари вида
    ``{"value": 350000}``, которыми часть акторов отдаёт Zillow-цены.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        cleaned = re.sub(r"[^0-9.]", "", value.replace(",", ""))
        if not cleaned:
            return None
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


def _resolve_timeout(seconds: float | None) -> float:
    """Таймаут: явный аргумент важнее ``APIFY_TIMEOUT``, иначе 10 секунд.

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


def _dataset_items(payload: Any) -> list[dict]:
    """Объекты датасета из ответа Apify; всё неподходящее -> пустой список."""
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("items", "data", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


@skill(SKILL_NAME)
def fetch(
    query: str,
    *,
    actor_id: str | None = None,
    extra_input: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> list[dict]:
    """Запустить актор Apify и вернуть объекты его датасета.

    :raises SkillSkipped: не задан ``APIFY_TOKEN`` (статус ``skipped_no_key``)
    :raises SkillUnavailable: не задан идентификатор актора (``not_deployed``)
    :raises SkillError: сеть, HTTP-ошибка или неразбираемый ответ (``error``)
    """
    token = require_env(TOKEN_ENV, skill=SKILL_NAME)

    actor = (actor_id or env_value(ACTOR_ENV) or "").strip()
    if not actor:
        raise SkillUnavailable(
            f"скилл {SKILL_NAME}: не задан идентификатор актора — заполните "
            f"{ACTOR_ENV} в marketing-agents/.env (например "
            "apify~zillow-scraper) или передайте actor_id; скилл вернул []"
        )

    text = (query or "").strip()
    if not text:
        return []

    # ``~`` в идентификаторах акторов (apify~actor-name) оставляем как есть.
    safe_actor = urllib.parse.quote(actor, safe="~")
    url = f"{BASE_URL}/acts/{safe_actor}/run-sync-get-dataset-items"

    body: dict[str, Any] = {"search": text, "query": text}
    if isinstance(extra_input, dict):
        body.update(extra_input)

    payload = http_json(
        url,
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
        payload=body,
        timeout=_resolve_timeout(timeout),
        skill=SKILL_NAME,
    )

    records: list[dict] = []
    for item in _dataset_items(payload):
        records.append(
            make_record(
                SKILL_NAME,
                id=_text(
                    _pick(item, ("id", "zpid", "itemId", "listingId", "property_id"))
                ),
                title=_text(_pick(item, ("title", "name", "headline", "address"))),
                price=_number(
                    _pick(
                        item,
                        (
                            "price",
                            "listPrice",
                            "unformattedPrice",
                            "priceValue",
                            "priceUsd",
                        ),
                    )
                ),
                area=_number(
                    _pick(
                        item,
                        ("area", "livingArea", "areaSize", "squareFootage", "size"),
                    )
                ),
                year_built=_number(_pick(item, ("yearBuilt", "year_built"))),
                address=_text(_pick(item, ("address", "formattedAddress", "location"))),
                url=_text(_pick(item, ("url", "link", "detailUrl", "zillowUrl"))),
                actor=actor,
                raw=item,
            )
        )
    return records


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/apify.py "запрос"
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    q = sys.argv[1] if len(sys.argv) > 1 else "Austin, TX"
    print(json.dumps(fetch(q), ensure_ascii=False, indent=2))
