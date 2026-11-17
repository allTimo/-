"""Скилл ``yandex_direct`` — Яндекс.Директ API v5 (кампании, проверка доступа, отчёты).

Источник
--------
* JSON API: ``https://api.direct.yandex.com/json/v5/{service}``;
* песочница: ``https://api-sandbox.direct.yandex.com/json/v5/{service}``
  (включается переменной ``YANDEX_DIRECT_SANDBOX``);
* Reports: ``https://api.direct.yandex.com/json/v5/reports`` — отдельный протокол:
  ответ TSV, а HTTP 201/202 означает «отчёт ещё готовится».

Контракт доступа — раздел «Доступы и API» регламента ``skills/direct-keywords/SKILL.md``.

Вход
----
:param query: ``"campaigns"`` — список кампаний аккаунта. Другие запросы модуль
    не выполняет: неизвестный ``query`` — это :class:`SkillError` с понятным текстом,
    а не молчаливый пустой ответ.
:param token: OAuth-токен; иначе ``YANDEX_DIRECT_TOKEN``.
:param client_login: логин клиента для агентских аккаунтов (заголовок ``Client-Login``);
    иначе ``YANDEX_DIRECT_CLIENT_LOGIN``; если не задан — заголовок не отправляется.
:param sandbox: ``True`` — песочница; иначе ``YANDEX_DIRECT_SANDBOX`` (``1``/``true``/``да``).
:param timeout: таймаут запроса в секундах; обрезается до 10 с (:func:`clamp_timeout`).

Выход
-----
``list[dict]`` в едином формате :func:`skills.runtime.make_record`. Дополнительно
у каждой кампании: ``name``, ``state`` (``ON``/``OFF``/``SUSPENDED``/``ARCHIVED``),
``type`` (``TEXT_CAMPAIGN`` и т. п.), ``status`` (``ACCEPTED``/``MODERATION``/…).
Поле ``price`` остаётся ``None``: это рекламный кабинет, а не лот недвижимости.

Границы
-------
Модуль **только читает**: кампании и отчёты. Изменение ставок, бюджетов,
включение/остановка кампаний не выполняются — это ручное действие человека
(см. «Границы и безопасность» регламента Агента 2).

Отдельные функции для панели:

* :func:`check_access` — сводка «есть доступ или нет» (в том числе без токена);
* :func:`get_campaigns` — кампании;
* :func:`get_report` — асинхронный отчёт: ``{"status": "pending"|"ok", ...}``.

Запуск вручную::

    python -m skills.direct_api --check --json
"""

from __future__ import annotations

import json
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from skills.runtime import (
    DEFAULT_TIMEOUT,
    STATUS_ERROR,
    STATUS_NO_KEY,
    STATUS_OK,
    SkillError,
    SkillSkipped,
    clamp_timeout,
    enable_utf8_stdout,
    env_value,
    load_env_file,
)
from skills.runtime import http as http_layer
from skills.runtime import make_record, skill

SKILL_NAME = "yandex_direct"

#: Хосты API v5.
API_HOST = "https://api.direct.yandex.com"
SANDBOX_API_HOST = "https://api-sandbox.direct.yandex.com"
API_PATH = "/json/v5"

#: Reports — всегда боевой хост: песочница сервис отчётов не поддерживает.
REPORTS_URL = f"{API_HOST}{API_PATH}/reports"

#: Переменные окружения (имена — как в ``.env.example``).
#: Основная переменная токена — ``YANDEX_OAUTH_TOKEN`` (инструкция пользователя 10.11.2026).
TOKEN_ENV = "YANDEX_OAUTH_TOKEN"
#: Устаревшее имя: читается как fallback, если основная переменная пуста.
LEGACY_TOKEN_ENV = "YANDEX_DIRECT_TOKEN"
CLIENT_LOGIN_ENV = "YANDEX_DIRECT_CLIENT_LOGIN"
SANDBOX_ENV = "YANDEX_DIRECT_SANDBOX"
METRIKA_TOKEN_ENV = "YANDEX_METRICA_TOKEN"
METRIKA_COUNTER_ENV = "YANDEX_METRICA_COUNTER_ID"

#: Метрика: тот же OAuth-токен, но заголовок ``Authorization: OAuth …``.
METRIKA_HOST = "https://api-metrika.yandex.net"
METRIKA_API_PATH = "/management/v1"
METRIKA_STAT_URL = f"{METRIKA_HOST}/stat/v1/data"

#: Значения ``YANDEX_DIRECT_SANDBOX``, которые считаются включением песочницы.
TRUTHY = {"1", "true", "yes", "on", "да"}

#: Точное сообщение для панели: показывается пользователю как есть.
NO_TOKEN_MESSAGE = "токен Директа не задан: YANDEX_OAUTH_TOKEN в marketing-agents/.env"

#: Поля кампаний в ответе ``Campaigns.get`` (только общие, без полей типа кампании).
CAMPAIGN_FIELDS = ("Id", "Name", "Type", "State", "Status")

#: Поля отчёта по умолчанию: минимальный набор без целей Метрики.
REPORT_TYPE = "CAMPAIGN_PERFORMANCE_REPORT"
REPORT_FIELDS = (
    "Date",
    "CampaignId",
    "CampaignName",
    "Impressions",
    "Clicks",
    "Cost",
    "Ctr",
    "AvgCpc",
)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: Оригинал транспорта рантайма: нужен, чтобы понять, подменён ли он в тестах.
_REAL_TRANSPORT = http_layer._transport

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "Яндекс.Директ API v5",
    "kind": "REST API + OAuth-токен",
    "required_env": [TOKEN_ENV],
    "optional_env": [LEGACY_TOKEN_ENV, CLIENT_LOGIN_ENV, SANDBOX_ENV, METRIKA_TOKEN_ENV, METRIKA_COUNTER_ENV],
    "free_tier": "бесплатно в рамках аккаунта",
    "docs": "https://yandex.ru/dev/direct/doc/dg/concepts/about.html",
}

__all__ = [
    "API_HOST",
    "CAMPAIGN_FIELDS",
    "CLIENT_LOGIN_ENV",
    "LEGACY_TOKEN_ENV",
    "METRIKA_COUNTER_ENV",
    "METRIKA_HOST",
    "METRIKA_TOKEN_ENV",
    "NO_TOKEN_MESSAGE",
    "REPORTS_URL",
    "SANDBOX_API_HOST",
    "SANDBOX_ENV",
    "SKILL",
    "SKILL_NAME",
    "TOKEN_ENV",
    "base_url",
    "build_headers",
    "build_metrika_headers",
    "check_access",
    "fetch",
    "get_campaigns",
    "get_metrika_counter",
    "get_metrika_goals",
    "get_metrika_stat",
    "get_report",
    "is_sandbox",
    "main",
    "metrika_url",
]


# --- транспорт ----------------------------------------------------------------


def _transport(request: urllib.request.Request, timeout: float) -> str:
    """Тело ответа. Точка подмены в тестах (та же сигнатура, что у рантайма)."""
    return http_layer._transport(request, timeout)


def _transport_status(request: urllib.request.Request, timeout: float) -> tuple[int, str]:
    """HTTP-запрос с кодом ответа: ``(код, тело)``. Точка подмены для Reports.

    Обычный ``_transport`` возвращает только текст, а сервису Reports нужен код:
    200 — отчёт готов, 201/202 — отчёт ещё формируется. Если транспорт подменён
    (тесты, песочные прогоны), код считается неизвестным (``0``), и решение
    принимается по телу ответа: пустое тело — отчёт готовится.
    """
    if http_layer._transport is not _REAL_TRANSPORT:
        return 0, _transport(request, timeout)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            return int(getattr(response, "status", 200) or 200), body
    except urllib.error.HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read().decode("utf-8", errors="replace")[:200]
        except Exception:  # noqa: BLE001 — тело ошибки необязательно
            snippet = ""
        raise SkillError(f"HTTP {exc.code} {exc.reason} для {exc.url}; ответ: {snippet}") from exc
    except urllib.error.URLError as exc:
        raise SkillError(f"сеть недоступна для {request.full_url}: {exc.reason}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise SkillError(f"таймаут {timeout:.1f} с для {request.full_url}") from exc


# --- настройки ----------------------------------------------------------------


def _text(value: Any) -> str | None:
    """Строка без пробелов по краям; пустое и нестроковое -> ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        return value.strip() or None
    return None


def is_sandbox(explicit: Any = None) -> bool:
    """Включена ли песочница: аргумент, иначе ``YANDEX_DIRECT_SANDBOX``."""
    raw = env_value(SANDBOX_ENV) if explicit is None else str(explicit)
    return (raw or "").strip().lower() in TRUTHY


def base_url(service: str, sandbox: Any = None) -> str:
    """Адрес сервиса API v5: боевой хост или песочница."""
    host = SANDBOX_API_HOST if is_sandbox(sandbox) else API_HOST
    return f"{host}{API_PATH}/{service}"


def _token_from_env() -> str:
    """Токен из окружения: сначала ``YANDEX_OAUTH_TOKEN``, затем устаревшее имя."""
    return _text(env_value(TOKEN_ENV)) or _text(env_value(LEGACY_TOKEN_ENV)) or ""


def build_headers(
    token: str | None = None,
    client_login: str | None = None,
) -> dict[str, str]:
    """Заголовки запроса к API.

    ``Authorization: Bearer …`` и ``Accept-Language: ru`` — всегда;
    ``Client-Login`` — только когда логин клиента реально задан (для своего
    аккаунта заголовок не отправляется: агентский режим отличается от личного).
    Хост задаётся в :func:`base_url` и на заголовки не влияет.
    """
    resolved_token = _text(token) or _token_from_env()
    if not resolved_token:
        raise SkillSkipped(NO_TOKEN_MESSAGE, code=STATUS_NO_KEY)
    headers = {
        "Authorization": f"Bearer {resolved_token}",
        "Accept-Language": "ru",
    }
    login = _text(client_login) or env_value(CLIENT_LOGIN_ENV)
    if login:
        headers["Client-Login"] = login
    return headers


def _require_token(token: str | None = None) -> str:
    """Токен или :class:`SkillSkipped` с сообщением для панели."""
    value = _text(token) or _token_from_env()
    if not value:
        raise SkillSkipped(NO_TOKEN_MESSAGE, code=STATUS_NO_KEY)
    return value


# --- кампании -----------------------------------------------------------------


def campaigns_payload(fields: tuple[str, ...] = CAMPAIGN_FIELDS) -> dict[str, Any]:
    """Тело запроса ``Campaigns.get``: все кампании аккаунта, общие поля."""
    return {
        "method": "get",
        "params": {"SelectionCriteria": {}, "FieldNames": list(fields)},
    }


def _parse_api_error(payload: Any, service: str) -> None:
    """Поднять :class:`SkillError`, если API вернул конверт с ошибкой."""
    if not isinstance(payload, dict):
        raise SkillError(f"{service}: ответ не является объектом JSON: {str(payload)[:200]}")
    error = payload.get("error")
    if not error:
        return
    if isinstance(error, dict):
        code = error.get("error_code") or "?"
        text = error.get("error_string") or error.get("error_detail") or "без описания"
        detail = error.get("error_detail")
        message = f"{service}: ошибка API {code}: {text}"
        if detail and detail != text:
            message = f"{message} ({detail})"
    else:
        message = f"{service}: ошибка API: {error}"
    raise SkillError(message)


def get_campaigns(
    *,
    token: str | None = None,
    client_login: str | None = None,
    sandbox: Any = None,
    timeout: float | None = None,
) -> list[dict]:
    """Список кампаний аккаунта: ``Campaigns.get``.

    :raises SkillSkipped: не задан ``YANDEX_DIRECT_TOKEN``
    :raises SkillError: сеть, HTTP-ошибка, разбор ответа или ошибка API
    """
    headers = build_headers(token, client_login)
    effective = clamp_timeout(timeout if timeout is not None else DEFAULT_TIMEOUT)
    payload = http_layer.http_json(
        base_url("campaigns", sandbox),
        method="POST",
        headers=headers,
        payload=campaigns_payload(),
        timeout=effective,
        skill=SKILL_NAME,
    )
    _parse_api_error(payload, "Campaigns.get")

    result = payload.get("result")
    campaigns = result.get("Campaigns") if isinstance(result, dict) else None
    if not isinstance(campaigns, list):
        raise SkillError(f"Campaigns.get: в ответе нет списка Campaigns: {str(payload)[:200]}")

    records: list[dict] = []
    for campaign in campaigns:
        if not isinstance(campaign, dict):
            continue
        records.append(
            make_record(
                SKILL_NAME,
                id=campaign.get("Id"),
                title=_text(campaign.get("Name")),
                name=_text(campaign.get("Name")),
                state=_text(campaign.get("State")),
                type=_text(campaign.get("Type")),
                status=_text(campaign.get("Status")),
                raw=campaign,
            )
        )
    return records


# --- Метрика ------------------------------------------------------------------
# Метрика живёт на отдельном хосте и требует заголовок ``Authorization: OAuth …``
# (не Bearer). Номер счётчика — ``YANDEX_METRICA_COUNTER_ID``.


def metrika_url(path: str, counter_id: str | None = None) -> str:
    """URL Management API Метрики; ``{counter}`` в пути заменяется на номер счётчика."""
    tail = path if path.startswith("/") else "/" + path
    cid = _text(counter_id) or _text(env_value(METRIKA_COUNTER_ENV))
    if cid and "{counter}" in tail:
        tail = tail.replace("{counter}", cid)
    return f"{METRIKA_HOST}{METRIKA_API_PATH}{tail}"


def build_metrika_headers(token: str | None = None) -> dict[str, str]:
    """Заголовки Метрики: ``Authorization: OAuth …`` (не Bearer).

    Токен: явный аргумент → ``YANDEX_METRICA_TOKEN`` → основной ``YANDEX_OAUTH_TOKEN``.
    """
    resolved = _text(token) or _text(env_value(METRIKA_TOKEN_ENV)) or _token_from_env()
    if not resolved:
        load_env_file()
        resolved = _text(token) or _text(env_value(METRIKA_TOKEN_ENV)) or _token_from_env()
    if not resolved:
        raise SkillSkipped(
            "токен Метрики не задан: YANDEX_OAUTH_TOKEN (или YANDEX_METRIKA_TOKEN) в marketing-agents/.env",
            code=STATUS_NO_KEY,
        )
    return {"Authorization": f"OAuth {resolved}", "Accept-Language": "ru"}


def get_metrika_counter(
    counter_id: str | None = None,
    *,
    token: str | None = None,
    timeout: float | None = None,
) -> dict:
    """Карточка счётчика Метрики: ``GET /management/v1/counter/{id}``.

    :return: ``{"id", "name", "site"}`` — отсутствующее поле остаётся ``None``.
    :raises SkillSkipped: не задан номер счётчика или токен.
    :raises SkillError: HTTP-ошибка, не-JSON или ответ с ``errors``.
    """
    cid = _text(counter_id) or _text(env_value(METRIKA_COUNTER_ENV))
    if not cid:
        load_env_file()
        cid = _text(counter_id) or _text(env_value(METRIKA_COUNTER_ENV))
    if not cid:
        raise SkillSkipped(
            "номер счётчика Метрики не задан: YANDEX_METRICA_COUNTER_ID в marketing-agents/.env",
            code=STATUS_NO_KEY,
        )
    request = urllib.request.Request(
        metrika_url(f"/counter/{cid}", cid),
        headers=build_metrika_headers(token),
        method="GET",
    )
    body = http_layer._transport(request, clamp_timeout(timeout))
    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise SkillError(f"Метрика: ответ не JSON: {str(exc)[:120]}") from exc
    if isinstance(payload, dict) and payload.get("errors"):
        raise SkillError(f"Метрика: в ответе ошибки: {str(payload['errors'])[:200]}")
    counter = payload.get("counter") if isinstance(payload, dict) else None
    if not isinstance(counter, dict):
        raise SkillError("Метрика: в ответе нет объекта counter")
    return {"id": counter.get("id"), "name": counter.get("name"), "site": counter.get("site")}


def _metrika_counter(counter_id: str | None) -> str:
    """Номер счётчика: аргумент → ``YANDEX_METRICA_COUNTER_ID`` (с подгрузкой ``.env``)."""
    cid = _text(counter_id) or _text(env_value(METRIKA_COUNTER_ENV))
    if not cid:
        load_env_file()
        cid = _text(counter_id) or _text(env_value(METRIKA_COUNTER_ENV))
    if not cid:
        raise SkillSkipped(
            "номер счётчика Метрики не задан: YANDEX_METRICA_COUNTER_ID в marketing-agents/.env",
            code=STATUS_NO_KEY,
        )
    return cid


def _metrika_json(url: str, token: str | None, timeout: float | None, what: str) -> dict:
    """GET к Метрике и разбор JSON с понятной ошибкой."""
    request = urllib.request.Request(
        url, headers=build_metrika_headers(token), method="GET"
    )
    body = http_layer._transport(request, clamp_timeout(timeout))
    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise SkillError(f"Метрика ({what}): ответ не JSON: {str(exc)[:120]}") from exc
    if isinstance(payload, dict) and payload.get("errors"):
        raise SkillError(f"Метрика ({what}): {str(payload['errors'])[:200]}")
    if not isinstance(payload, dict):
        raise SkillError(f"Метрика ({what}): ответ не объект JSON")
    return payload


def get_metrika_goals(
    counter_id: str | None = None,
    *,
    token: str | None = None,
    timeout: float | None = None,
) -> list[dict]:
    """Цели счётчика: ``id``, ``name``, ``type`` (без выдуманных полей)."""
    cid = _metrika_counter(counter_id)
    payload = _metrika_json(
        metrika_url(f"/counter/{cid}/goals", cid), token, timeout, "цели"
    )
    goals = payload.get("goals")
    if not isinstance(goals, list):
        raise SkillError("Метрика (цели): в ответе нет списка goals")
    return [
        {"id": g.get("id"), "name": g.get("name"), "type": g.get("type")}
        for g in goals
        if isinstance(g, dict)
    ]


def get_metrika_stat(
    counter_id: str | None = None,
    date1: str | None = None,
    date2: str | None = None,
    *,
    metrics: tuple[str, ...] = ("ym:s:visits", "ym:s:users"),
    dimensions: tuple[str, ...] = ("ym:s:date",),
    token: str | None = None,
    timeout: float | None = None,
    limit: int = 1000,
) -> dict:
    """Отчёт Метрики ``stat/v1/data``: строки и итоги.

    Пустой ответ — это ``has_data: False`` и пустые списки: ноль трафика не
    подменяется придуманными строками. Даты по умолчанию — последние 7 дней.
    """
    cid = _metrika_counter(counter_id)
    params = {
        "ids": cid,
        "date1": date1 or "7daysAgo",
        "date2": date2 or "today",
        "metrics": ",".join(metrics),
        "dimensions": ",".join(dimensions),
        "limit": str(int(limit)),
        "sort": dimensions[0] if dimensions else metrics[0],
    }
    url = f"{METRIKA_STAT_URL}?{urllib.parse.urlencode(params)}"
    payload = _metrika_json(url, token, timeout, "отчёт")
    totals = payload.get("totals") or []
    rows = payload.get("data") or []
    numeric = 0.0
    for total in totals:
        values = total if isinstance(total, list) else [total]
        for value in values:
            try:
                numeric += float(value or 0)
            except (TypeError, ValueError):
                continue
    query = payload.get("query") if isinstance(payload.get("query"), dict) else {}
    return {
        "counter": cid,
        "date1": query.get("date1", params["date1"]),
        "date2": query.get("date2", params["date2"]),
        "metrics": list(metrics),
        "dimensions": list(dimensions),
        "totals": list(totals),
        "rows": [
            {"dims": r.get("dimensions"), "metrics": r.get("metrics")}
            for r in rows
            if isinstance(r, dict)
        ],
        "has_data": bool(rows) and numeric != 0.0,
    }


# --- отчёты -------------------------------------------------------------------


def get_report(
    date_from: str,
    date_to: str,
    *,
    token: str | None = None,
    client_login: str | None = None,
    sandbox: Any = None,
    timeout: float | None = None,
    fields: tuple[str, ...] | list[str] | None = None,
    report_type: str = REPORT_TYPE,
    name: str | None = None,
) -> dict:
    """Запросить отчёт за период. Возвращает словарь с честным статусом.

    * ``{"status": "ok", "tsv": "<тело отчёта>"}`` — Reports ответил 200;
    * ``{"status": "pending", "message": …}`` — Reports ответил 201/202
      («отчёт ещё готовится») либо тело пустое; запрос нужно повторить позже;
    * ``{"status": "error", "message": …}`` — сбой; наружу исключение не выходит.

    Песочница сервис Reports не поддерживает: при ``sandbox=True`` возвращается
    честный ``error``, а не молчаливый запрос в боевой аккаунт.
    """
    try:
        if is_sandbox(sandbox):
            raise SkillError(
                "Reports в песочнице Яндекс.Директа не поддерживается: "
                "отключите YANDEX_DIRECT_SANDBOX или работайте с боевым API"
            )
        for label, value in (("date_from", date_from), ("date_to", date_to)):
            if not _DATE_RE.match((value or "").strip()):
                raise SkillError(f"{label}: дата {(value or '').strip()!r} не в формате ГГГГ-ММ-ДД")

        headers = build_headers(token, client_login)
        headers["processingMode"] = "auto"
        effective = clamp_timeout(timeout if timeout is not None else DEFAULT_TIMEOUT)

        body = {
            "params": {
                "SelectionCriteria": {
                    "DateFrom": date_from.strip(),
                    "DateTo": date_to.strip(),
                },
                "FieldNames": list(fields or REPORT_FIELDS),
                "ReportName": name or f"marketing-agents-{uuid.uuid4().hex[:8]}",
                "ReportType": report_type,
                "DateRangeType": "CUSTOM_DATE",
                "Format": "TSV",
                "IncludeVAT": "YES",
                "IncludeDiscount": "NO",
            }
        }
        request = urllib.request.Request(
            REPORTS_URL,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
        )
        request.add_header("Content-Type", "application/json")
        for key, value in headers.items():
            request.add_header(key, value)

        status, raw = _transport_status(request, effective)
        text = (raw or "").strip()
        if status in (201, 202):
            return {
                "status": "pending",
                "message": (
                    f"отчёт ещё готовится (Reports ответил {status}); "
                    "повторите запрос позже, отчёт хранится 30 дней"
                ),
            }
        if status not in (0, 200):
            raise SkillError(f"Reports: неожиданный HTTP-код {status}")
        if not text:
            # Код неизвестен (транспорт подменён) или 200 с пустым телом: данных нет,
            # но это не «готовый отчёт» — рапортуем pending, а не выдуманный TSV.
            return {
                "status": "pending",
                "message": "Reports не отдал тело отчёта: отчёт ещё готовится, повторите запрос позже",
            }
        return {"status": "ok", "tsv": raw}
    except (SkillError, SkillSkipped) as exc:
        return {"status": "error", "message": str(exc)}


# --- контракт рантайма и проверка доступа -------------------------------------


@skill(SKILL_NAME)
def fetch(query: str, **kwargs: Any) -> list[dict]:
    """``fetch("campaigns")`` — список кампаний аккаунта; иначе :class:`SkillError`."""
    if not query or not query.strip():
        return []
    normalized = query.strip().lower()
    if normalized == "campaigns":
        return get_campaigns(**kwargs)
    raise SkillError(
        f"скилл {SKILL_NAME}: неизвестный запрос {query!r}; "
        "поддерживается только \"campaigns\" (кампании аккаунта)"
    )


def check_access(**kwargs: Any) -> dict:
    """Проверить доступ к API Директа и вернуть сводку для панели.

    Читает ``.env`` (``load_env_file``), поэтому работает и когда токен задан
    только в файле. Сеть вызывается, лишь если токен найден. Никогда не поднимает
    исключение: сбой попадает в ``status``/``message``.

    :return: ``{"ok", "status", "message", "sandbox", "clientLogin",
        "campaigns_count", "campaigns", "elapsed"}``.
        ``status`` — ``ok`` (доступ есть) | ``skipped_no_key`` | ``error``;
        ``campaigns_count`` — число кампаний или ``None``, если запрос не удался
        (честность: «данных нет» — это ``None``, а не ноль); ``campaigns`` — тот же
        счётчик под именем, которое ждёт CLI/панель; ``elapsed`` — секунды.
    """
    started = time.perf_counter()
    load_env_file()
    sandbox = is_sandbox(kwargs.pop("sandbox", None))
    login = _text(kwargs.pop("client_login", None)) or env_value(CLIENT_LOGIN_ENV)
    timeout = kwargs.pop("timeout", None)

    report: dict[str, Any] = {
        "ok": False,
        "status": STATUS_NO_KEY,
        "message": NO_TOKEN_MESSAGE,
        "sandbox": sandbox,
        "clientLogin": login,
        "campaigns_count": None,
        "campaigns": None,
        "elapsed": 0.0,
    }

    try:
        token = _require_token(kwargs.pop("token", None))
    except SkillSkipped as exc:
        report["message"] = exc.reason
        report["elapsed"] = round(time.perf_counter() - started, 3)
        return report

    try:
        records = get_campaigns(
            token=token, client_login=login, sandbox=sandbox, timeout=timeout
        )
    except SkillError as exc:
        report["status"] = STATUS_ERROR
        report["message"] = str(exc)
    else:
        count = len(records)
        report["ok"] = True
        report["status"] = STATUS_OK
        report["campaigns_count"] = count
        report["campaigns"] = count
        if count:
            report["message"] = f"доступ есть: кампаний {count}"
        else:
            report["message"] = "доступ есть, но кампаний в аккаунте нет (0 — это не сбой)"
    # Метрика — только если задан номер счётчика: без него это не ошибка Директа.
    counter_env = _text(env_value(METRIKA_COUNTER_ENV))
    if counter_env:
        try:
            counter = get_metrika_counter(counter_env, token=token, timeout=timeout)
        except SkillSkipped as exc:
            report["metrika"] = {"status": STATUS_NO_KEY, "message": exc.reason}
        except SkillError as exc:
            report["metrika"] = {"status": STATUS_ERROR, "message": str(exc)}
        else:
            report["metrika"] = {
                "status": STATUS_OK,
                "counter": counter,
                "message": "счётчик Метрики доступен: " + str(counter.get("name") or counter.get("id")),
            }
    report["elapsed"] = round(time.perf_counter() - started, 3)
    return report


# --- CLI ----------------------------------------------------------------------


def _print_human(report: dict) -> None:
    """Человекочитаемый вывод проверки доступа."""
    login = report.get("clientLogin") or "не задан"
    sandbox = "да" if report.get("sandbox") else "нет"
    campaigns = report.get("campaigns")
    campaigns_text = "нет данных" if campaigns is None else str(campaigns)
    print(f"Яндекс.Директ API v5: {report.get('status')}")
    print(f"  песочница:    {sandbox}")
    print(f"  Client-Login: {login}")
    print(f"  кампаний:     {campaigns_text}")
    print(f"  время:        {report.get('elapsed')} с")
    print(f"  сообщение:    {report.get('message')}")
    metrika = report.get("metrika")
    if metrika:
        print(f"  Метрика:      {metrika.get('status')} — {metrika.get('message')}")


def get_metrika_counters(
    *,
    token: str | None = None,
    timeout: float | None = None,
) -> list[dict]:
    """Счётчики, доступные токену: ``id``, ``name``, ``site``, ``status``.

    Нужны, чтобы не гадать, какой номер вписывать в ``YANDEX_METRICA_COUNTER_ID``.
    """
    payload = _metrika_json(
        f"{METRIKA_HOST}{METRIKA_API_PATH}/counters", token, timeout, "счётчики"
    )
    counters = payload.get("counters")
    if not isinstance(counters, list):
        raise SkillError("Метрика (счётчики): в ответе нет списка counters")
    return [
        {
            "id": c.get("id"),
            "name": c.get("name"),
            "site": c.get("site"),
            "status": c.get("status"),
        }
        for c in counters
        if isinstance(c, dict)
    ]


def _print_metrika(payload: dict) -> None:
    """Человекочитаемый отчёт Метрики."""
    if not payload.get("ok"):
        print(f"Метрика: {payload.get('status')} — {payload.get('message')}")
        return
    period = payload.get("period") or ["", ""]
    print(f"Метрика: счётчик {payload.get('counter')}, период {period[0]}..{period[1]}")
    print(f"  трафик:      {'есть' if payload.get('has_data') else 'данных нет (0 визитов за период)'}")
    print(f"  итоги:       {payload.get('totals')}")
    print(f"  целей:       {len(payload.get('goals') or [])}")
    for row in (payload.get("rows") or [])[:30]:
        print(f"  {row.get('dims')}: {row.get('metrics')}")


def main(argv: list[str] | None = None) -> int:
    """CLI панели: ``python -m skills.direct_api --check --json``.

    Код возврата: 0 — доступ есть (``ok``) или токен не задан (``skipped_no_key``,
    это не сбой, панель показывает сообщение как есть); 1 — ``error``.
    """
    import argparse

    enable_utf8_stdout()
    parser = argparse.ArgumentParser(
        prog="skills.direct_api",
        description="Яндекс.Директ API v5: проверка доступа к аккаунту (только чтение).",
    )
    parser.add_argument("--check", action="store_true", help="проверить доступ к API Директа")
    parser.add_argument("--metrika-report", action="store_true", help="отчёт Метрики за период (по умолчанию 7 дней)")
    parser.add_argument("--metrika-counters", action="store_true", help="список счётчиков, доступных токену")
    parser.add_argument("--from", dest="date_from", default=None, help="начало периода, YYYY-MM-DD")
    parser.add_argument("--to", dest="date_to", default=None, help="конец периода, YYYY-MM-DD")
    parser.add_argument("--json", action="store_true", help="вывести один JSON-объект")
    args = parser.parse_args(argv)

    if not args.check and not args.metrika_report and not args.metrika_counters and not args.json:
        parser.print_help()
        return 2

    if args.metrika_counters:
        try:
            counters = get_metrika_counters()
            payload = {"ok": True, "counters": counters}
        except SkillSkipped as exc:
            payload = {"ok": False, "status": STATUS_NO_KEY, "message": exc.reason}
        except SkillError as exc:
            payload = {"ok": False, "status": STATUS_ERROR, "message": str(exc)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            if payload.get("ok"):
                print(f"Счётчики Метрики: {len(payload['counters'])}")
                for c in payload["counters"]:
                    print(f"  {c.get('id')} — {c.get('name')} ({c.get('site')}), {c.get('status')}")
            else:
                print(f"Метрика: {payload.get('status')} — {payload.get('message')}")
        return 0 if payload.get("ok") else 1

    if args.metrika_report:
        try:
            goals = get_metrika_goals()
            stat = get_metrika_stat(date1=args.date_from, date2=args.date_to)
            payload = {
                "ok": True,
                "counter": stat["counter"],
                "period": [stat["date1"], stat["date2"]],
                "has_data": stat["has_data"],
                "totals": stat["totals"],
                "metrics": stat["metrics"],
                "goals": goals,
                "rows": stat["rows"],
            }
        except SkillSkipped as exc:
            payload = {"ok": False, "status": STATUS_NO_KEY, "message": exc.reason}
        except SkillError as exc:
            payload = {"ok": False, "status": STATUS_ERROR, "message": str(exc)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            _print_metrika(payload)
        return 0 if payload.get("ok") else 1

    try:
        report = check_access()
    except Exception as exc:  # noqa: BLE001 — CLI не должен падать стеком в панель
        report = {
            "ok": False,
            "status": STATUS_ERROR,
            "message": f"{type(exc).__name__}: {exc}",
            "sandbox": is_sandbox(),
            "clientLogin": env_value(CLIENT_LOGIN_ENV),
            "campaigns_count": None,
            "campaigns": None,
            "elapsed": 0.0,
        }

    if args.json:
        payload = {
            "ok": bool(report["ok"]),
            "status": report["status"],
            "message": report["message"],
            "sandbox": bool(report["sandbox"]),
            "clientLogin": report["clientLogin"],
            "campaigns": report["campaigns"],
        }
        if "metrika" in report:
            payload["metrika"] = report["metrika"]
        print(json.dumps(payload, ensure_ascii=False))
    else:
        _print_human(report)
    return 1 if report["status"] == STATUS_ERROR else 0


if __name__ == "__main__":  # ручная проверка
    raise SystemExit(main())
