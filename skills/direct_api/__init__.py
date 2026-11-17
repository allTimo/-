"""Скилл ``yandex_direct``: Яндекс.Директ API v5 по контракту скиллов проекта.

Контракт рантайма — ``fetch(query, **kwargs) -> list[dict]`` (см. ``skills/runtime``).
Реализация — в :mod:`skills.direct_api.client`::

    from skills.direct_api import check_access, fetch, get_campaigns, get_report

    fetch("campaigns")                     # кампании аккаунта, list[dict]
    check_access()                         # сводка доступа для панели
    get_report("2026-11-01", "2026-11-07") # отчёт: ok или pending

CLI панели::

    python -m skills.direct_api --check --json

Модуль только читает аккаунт: ставки, бюджеты и включение кампаний он НЕ меняет.
"""

from __future__ import annotations

from .client import (
    API_HOST,
    CAMPAIGN_FIELDS,
    CLIENT_LOGIN_ENV,
    NO_TOKEN_MESSAGE,
    REPORTS_URL,
    SANDBOX_API_HOST,
    SANDBOX_ENV,
    SKILL,
    SKILL_NAME,
    TOKEN_ENV,
    base_url,
    build_headers,
    campaigns_payload,
    check_access,
    fetch,
    get_campaigns,
    get_report,
    is_sandbox,
    main,
)

__all__ = [
    "API_HOST",
    "CAMPAIGN_FIELDS",
    "CLIENT_LOGIN_ENV",
    "NO_TOKEN_MESSAGE",
    "REPORTS_URL",
    "SANDBOX_API_HOST",
    "SANDBOX_ENV",
    "SKILL",
    "SKILL_NAME",
    "TOKEN_ENV",
    "base_url",
    "build_headers",
    "campaigns_payload",
    "check_access",
    "fetch",
    "get_campaigns",
    "get_report",
    "is_sandbox",
    "main",
]
