"""HTTP-слой скиллов: только стандартная библиотека, таймаут не больше 10 секунд.

Сетевые ошибки превращаются в :class:`skills.runtime.core.SkillError`, чтобы
декоратор :func:`skills.runtime.core.skill` записал понятный статус и вернул ``[]``.
Точка подмены для тестов — :func:`_transport`.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .core import (
    CLIENT_HEADER,
    DEFAULT_TIMEOUT,
    MAX_LONG_TIMEOUT,
    MAX_TIMEOUT,
    USER_AGENT,
    SkillError,
    log,
)


def clamp_timeout(timeout: float | None, ceiling: float = MAX_TIMEOUT) -> float:
    """Таймаут в допустимом коридоре: (0, ceiling].

    По умолчанию ``ceiling`` — это ``MAX_TIMEOUT`` (10 секунд), то есть обычный
    контракт скиллов не меняется. Более высокий предел передаётся ЯВНО и только
    для операторских режимов: например разовая глубокая проверка ReefAPI, где
    живой поиск Авито занимает 69–280 секунд (замеры 2026-11-04).
    """
    if timeout is None:
        return min(DEFAULT_TIMEOUT, ceiling)
    try:
        value = float(timeout)
    except (TypeError, ValueError):
        return min(DEFAULT_TIMEOUT, ceiling)
    if value <= 0:
        return min(DEFAULT_TIMEOUT, ceiling)
    return min(value, ceiling, MAX_LONG_TIMEOUT)


def _transport(request: urllib.request.Request, timeout: float) -> str:
    """Единственное место, где реально ходим в сеть (подменяется в тестах)."""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read().decode("utf-8", errors="replace")[:200]
        except Exception:  # noqa: BLE001 — тело ошибки необязательно
            snippet = ""
        raise SkillError(f"HTTP {exc.code} {exc.reason} для {exc.url}; ответ: {snippet}") from exc
    except urllib.error.URLError as exc:
        raise SkillError(f"сеть недоступна для {request.full_url}: {exc.reason}") from exc
    except socket.timeout as exc:
        raise SkillError(f"таймаут {timeout:.1f} с для {request.full_url}") from exc
    except TimeoutError as exc:
        raise SkillError(f"таймаут {timeout:.1f} с для {request.full_url}") from exc


def http_text(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float | None = None,
    ceiling: float = MAX_TIMEOUT,
    skill: str = "",
) -> str:
    """Сделать запрос и вернуть тело ответа как текст.

    Нужна там, где источник отдаёт HTML, а не JSON (страницы сайтов
    застройщиков). Правила те же, что у :func:`http_json`: только стандартная
    библиотека, таймаут не больше ``ceiling``, сетевая ошибка — :class:`SkillError`.

    :param url: полный адрес, включая query-строку
    :param headers: дополнительные заголовки
    :param timeout: таймаут в секундах, обрезается до ``ceiling``
    :param ceiling: предел таймаута; по умолчанию 10 с
    :raises SkillError: сеть, HTTP-ошибка или пустой ответ
    """
    effective = clamp_timeout(timeout, ceiling)

    request = urllib.request.Request(url, method="GET")
    request.add_header("User-Agent", USER_AGENT)
    request.add_header(CLIENT_HEADER[0], CLIENT_HEADER[1])
    request.add_header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
    request.add_header("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.5")
    for key, value in (headers or {}).items():
        request.add_header(key, value)

    raw = _transport(request, effective)
    if not raw or not raw.strip():
        raise SkillError(f"пустой ответ от {url}")
    log.debug("скилл %s: получено %d знаков от %s", skill or "?", len(raw), url)
    return raw


def http_json(
    url: str,
    *,
    method: str = "GET",
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    payload: Any = None,
    timeout: float | None = None,
    ceiling: float = MAX_TIMEOUT,
    skill: str = "",
) -> Any:
    """Сделать запрос и вернуть разобранный JSON.

    :param url: адрес без query-строки
    :param method: ``GET`` или ``POST``
    :param params: query-параметры (``None``-значения отбрасываются)
    :param headers: дополнительные заголовки
    :param payload: тело запроса, сериализуется в JSON
    :param timeout: таймаут в секундах, обрезается до ``ceiling``
    :param ceiling: предел таймаута; по умолчанию 10 с, выше — только для
        операторских режимов (см. :data:`skills.runtime.core.MAX_LONG_TIMEOUT`)
    :raises SkillError: сеть, HTTP-ошибка или неразбираемый ответ
    """
    effective = clamp_timeout(timeout, ceiling)

    clean_params = {
        key: value
        for key, value in (params or {}).items()
        if value is not None and value != ""
    }
    full_url = url
    if clean_params:
        separator = "&" if "?" in url else "?"
        full_url = f"{url}{separator}{urllib.parse.urlencode(clean_params)}"

    body: bytes | None = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(full_url, data=body, method=method.upper())
    request.add_header("User-Agent", USER_AGENT)
    request.add_header(CLIENT_HEADER[0], CLIENT_HEADER[1])
    request.add_header("Accept", "application/json")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)

    raw = _transport(request, effective)
    if not raw or not raw.strip():
        raise SkillError(f"пустой ответ от {full_url}")
    try:
        return json.loads(raw)
    except ValueError as exc:
        preview = raw.strip()[:200]
        log.debug("скилл %s: не JSON от %s", skill or "?", full_url)
        raise SkillError(f"ответ не является JSON ({full_url}): {preview}") from exc
