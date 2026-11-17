"""Скилл ``mcp_rosreestr`` — кадастровые данные Росреестра/НСПД по кадастровому номеру.

Источник
--------
Локальный MCP-сервер ``yasg1988/mcp-rosreestr`` (MIT, Python, проверено
2026-11-04; есть и ``atomno-mcp/mcp-rosreestr``). Ключ не нужен, но нужна
машина с **российским IP**: сервисы Росреестра/НСПД не отвечают из-за рубежа.

Отдаёт по кадастровому номеру: кадастровую стоимость, площадь, год постройки,
адрес.

Поведение
---------
* ``MCP_ROSREESTR_URL`` задан -> обычный HTTP-запрос к локально поднятому сервису;
* переменная не задана -> :class:`skills.runtime.SkillUnavailable` с пояснением,
  что сервер не поднят, нужен российский IP и как его поставить (наружу — ``[]``
  и статус ``not_deployed``). Модуль не поднимает MCP-сервер сам.

Вход
----
:param query: кадастровый номер, например ``"77:01:0001001:1001"``
:param timeout: таймаут запроса, не больше 10 секунд (пусто -> ``MCP_ROSREESTR_TIMEOUT``)
:param cadastral_number: необязательный псевдоним ``query`` для явных вызовов

Окружение
---------
* ``MCP_ROSREESTR_URL`` — адрес локального HTTP-обёртки MCP-сервера;
* ``MCP_ROSREESTR_CMD`` — команда запуска сервера (документация/диагностика);
* ``MCP_ROSREESTR_TIMEOUT`` — таймаут в секундах (обрезается до 10).

Выход
-----
``list[dict]`` в едином формате :func:`skills.runtime.make_record`: ``price`` —
кадастровая стоимость, ``area`` — площадь, ``year_built`` — год постройки,
``address`` — адрес, ``id`` — кадастровый номер. Нормализация понимает и русские
ключи ответа (``площадь``, ``год постройки``, ``кадастровая стоимость``, ``адрес``),
и английские (``area``, ``year_built``, ``cadastral_cost``, ``address``).
Отсутствующие данные — ``None``, а не ноль.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/mcp_rosreestr.py "77:01:..."
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from typing import Any

from skills.runtime import (
    SkillUnavailable,
    env_value,
    http_json,
    make_record,
    skill,
)

SKILL_NAME = "mcp_rosreestr"
URL_ENV = "MCP_ROSREESTR_URL"
CMD_ENV = "MCP_ROSREESTR_CMD"
TIMEOUT_ENV = "MCP_ROSREESTR_TIMEOUT"
DEFAULT_TIMEOUT = 10.0

#: Как поднять сервер и почему он не работает без российского IP.
DEPLOY_HINT = (
    "MCP-сервер Росреестра не поднят: не задана переменная окружения {url_env}. "
    "Скилл сам его не запускает. Как поднять: 1) установите локальный MCP-сервер "
    "Росреестра/НСПД (open source под MIT, Python): {docs} — например "
    "`git clone https://github.com/yasg1988/mcp-rosreestr`, затем установка зависимостей "
    "и запуск командой вида {cmd_env}=`python -m mcp_rosreestr` (точная команда — "
    "в README репозитория); 2) поднимите HTTP-обёртку сервера и задайте {url_env} "
    "(например http://127.0.0.1:8765); 3) повторите запрос. "
    "ВАЖНО: нужна машина с российским IP — сервисы Росреестра/НСПД из-за рубежа не отвечают."
)

#: Ключи ответа с кадастровым номером.
_NUMBER_KEYS = ("кадастровый номер", "кадастровый_номер", "cadastral_number", "cadastre_number", "kn", "number")
#: Ключи ответа с площадью.
_AREA_KEYS = ("площадь", "площадь_кв_м", "общая площадь", "area", "square", "total_area")
#: Ключи ответа с годом постройки.
_YEAR_KEYS = ("год постройки", "год_постройки", "год завершения строительства", "year_built", "build_year", "year")
#: Ключи ответа с кадастровой стоимостью.
_PRICE_KEYS = ("кадастровая стоимость", "кадастровая_стоимость", "cadastral_cost", "cadastral_value", "price", "cost")
#: Ключи ответа с адресом.
_ADDRESS_KEYS = ("адрес", "адрес объекта", "address", "location")

#: Обёртки, внутри которых сервис может положить объект.
_WRAPPER_KEYS = ("data", "result", "response", "payload", "object", "records", "items")

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "mcp-rosreestr (Open Source)",
    "kind": "локальный MCP-сервер",
    "required_env": [],
    "free_tier": "ключ не требуется — open-source под MIT",
    "docs": "https://github.com/yasg1988/mcp-rosreestr",
}


def _pick(data: dict, *keys: str) -> Any:
    """Первое непустое значение из перечисленных ключей (или ``None``)."""
    lowered = {str(key).strip().lower(): value for key, value in data.items()}
    for key in keys:
        value = lowered.get(key.strip().lower())
        if value not in (None, "", [], {}):
            return value
    return None


def _unwrap(response: Any) -> list[dict]:
    """Привести ответ сервиса к списку словарей с данными объекта."""
    node = response
    for _ in range(6):  # ограниченная глубина: защита от самоссылки в ответе
        if isinstance(node, list):
            return [element for element in node if isinstance(element, dict)]
        if not isinstance(node, dict):
            return []
        for key in _WRAPPER_KEYS:
            child = node.get(key)
            if isinstance(child, (dict, list)):
                node = child
                break
        else:
            return [node] if node else []
    return []


def _resolve_timeout(timeout: float | None) -> float:
    """Таймаут: аргумент, затем ``MCP_ROSREESTR_TIMEOUT``, затем значение по умолчанию."""
    if timeout is not None:
        return timeout
    raw = env_value(TIMEOUT_ENV)
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        return float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT


@skill(SKILL_NAME)
def fetch(
    query: str,
    *,
    timeout: float | None = None,
    cadastral_number: str | None = None,
) -> list[dict]:
    """Получить кадастровые данные по кадастровому номеру.

    :raises SkillUnavailable: не задан ``MCP_ROSREESTR_URL`` — сервер не развёрнут
        (наружу ``[]`` и статус ``not_deployed``)
    :raises SkillError: сеть, HTTP-ошибка или битый JSON от локального сервиса
    """
    number = (cadastral_number or query or "").strip()
    if not number:
        return []

    base = env_value(URL_ENV)
    if not base:
        raise SkillUnavailable(
            DEPLOY_HINT.format(
                url_env=URL_ENV,
                cmd_env=CMD_ENV,
                docs=SKILL["docs"],
            )
        )

    response = http_json(
        base,
        params={"query": number, "cadastral_number": number},
        timeout=_resolve_timeout(timeout),
        skill=SKILL_NAME,
    )

    objects = _unwrap(response)
    if not objects:
        return []

    records: list[dict] = []
    for item in objects:
        address = _pick(item, *_ADDRESS_KEYS)
        number_in = _pick(item, *_NUMBER_KEYS) or number
        records.append(
            make_record(
                SKILL_NAME,
                id=number_in,
                title=address or f"Росреестр: {number_in}",
                price=_pick(item, *_PRICE_KEYS),
                area=_pick(item, *_AREA_KEYS),
                year_built=_pick(item, *_YEAR_KEYS),
                address=address,
                url=_pick(item, "url", "link", "ссылка"),
                cadastral_number=number_in,
                cadastral_cost=_pick(item, *_PRICE_KEYS),
                rights=_pick(item, "права", "rights", "right_type"),
                raw=item,
            )
        )
    return records


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/mcp_rosreestr.py "77:01:0001001:1001"
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    q = sys.argv[1] if len(sys.argv) > 1 else "77:01:0001001:1001"
    print(json.dumps(fetch(q), ensure_ascii=False, indent=2))
