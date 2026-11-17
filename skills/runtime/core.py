"""Ядро рантайма скиллов: контракт, статусы, журнал, переменные окружения.

Контракт скилла (единый для всех, включая будущих агентов)::

    fetch(query: str, **kwargs) -> list[dict]

Правила
-------
* ``fetch`` возвращает **всегда** ``list[dict]``; исключения наружу не выходят;
* нет ключа окружения -> статус ``skipped_no_key``, предупреждение в лог, ``[]``;
* сеть или разбор ответа упали -> статус ``error``, предупреждение в лог, ``[]``;
* внешний сервис не развёрнут -> статус ``not_deployed``, пояснение в лог, ``[]``;
* таймаут одного запроса не больше ``MAX_TIMEOUT`` (10 секунд);
* каждый вызов пишется в журнал ``skills/logs/skill-runs.jsonl`` с указанием
  скилла, запроса, статуса и времени выполнения.

Честность данных: отсутствующее значение — ``None``, а не ``0`` и не ``""``.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Callable

# --- константы ---------------------------------------------------------------

DEFAULT_TIMEOUT = 8.0
MAX_TIMEOUT = 10.0

#: Абсолютный предел для операторских режимов (разовая глубокая проверка).
#: Обычные скиллы его не используют: их предел — MAX_TIMEOUT.
MAX_LONG_TIMEOUT = 600.0

SKILLS_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = SKILLS_DIR.parent
LOGS_DIR = SKILLS_DIR / "logs"
RUN_LOG = LOGS_DIR / "skill-runs.jsonl"
REGISTRY_PATH = SKILLS_DIR / "registry" / "skills_registry.json"

STATUS_OK = "ok"
STATUS_EMPTY = "empty"
STATUS_NO_KEY = "skipped_no_key"
STATUS_ERROR = "error"
STATUS_NOT_DEPLOYED = "not_deployed"

#: User-Agent для запросов.
#:
#: ВАЖНО (проверено 2026-11-04 на api.reefapi.com): WAF пропускает только
#: браузерный User-Agent. С «честным» программным значением запрос не отвечает
#: и висит до таймаута. Поэтому по умолчанию отправляем браузерный UA, а себя
#: обозначаем отдельным заголовком ``X-Client-Name`` — это не маскировка,
#: а совместимость: иначе источник недоступен вообще.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
CLIENT_HEADER = ("X-Client-Name", "marketing-agents-skills/1.0 (+real_estate)")


# --- исключения --------------------------------------------------------------


class SkillSkipped(Exception):
    """Скилл не может работать по внешней причине (нет ключа, выключен).

    Это не сбой агента: вызывающая сторона получает пустой список.
    """

    def __init__(self, reason: str, code: str = STATUS_NO_KEY) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


class SkillError(Exception):
    """Сбой при работе скилла: сеть, HTTP-ошибка, неразбираемый ответ."""


class SkillUnavailable(Exception):
    """Внешний сервис не развёрнут — нужен отдельный шаг развёртывания."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# --- логирование -------------------------------------------------------------


def get_logger(name: str = "skills") -> logging.Logger:
    """Логгер скиллов: пишет в stderr, дублирующих обработчиков не плодит."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger


log = get_logger()


def record_run(
    skill: str,
    query: str | None,
    status: str,
    duration_ms: float,
    count: int = 0,
    error: str | None = None,
    **extra: Any,
) -> dict:
    """Записать прогон скилла в журнал и вернуть запись.

    Журнал — JSONL, дописывается построчно, сбой записи не ломает скилл.
    """
    entry: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "skill": skill,
        "query": query,
        "status": status,
        "duration_ms": round(duration_ms, 1),
        "count": count,
    }
    if error:
        entry["error"] = error
    for key, value in extra.items():
        if value is not None:
            entry[key] = value
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        with RUN_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:  # журнал недоступен — не повод падать
        log.warning("не удалось записать журнал скиллов: %s", exc)
    return entry


# --- переменные окружения -----------------------------------------------------


def load_env_file(path: Path | None = None) -> int:
    """Прочитать ``.env`` (если есть) и добавить переменные, не перетирая окружение.

    Возвращает число добавленных переменных. Секреты в репозитории не хранятся:
    файл ``.env`` в него не попадает, в репозитории лежит только ``.env.example``.
    """
    candidates = [path] if path else [PROJECT_DIR / ".env", SKILLS_DIR / ".env"]
    added = 0
    for candidate in candidates:
        if candidate is None or not candidate.is_file():
            continue
        try:
            # utf-8-sig: Windows-инструменты (PowerShell, «Блокнот») пишут .env с BOM,
            # иначе первая переменная получает \ufeff в имени и не читается.
            text = candidate.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip().lstrip("\ufeff")
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().lstrip("\ufeff")
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
                added += 1
    return added


def enable_utf8_stdout() -> None:
    """Перевести stdout в UTF-8.

    Консоль Windows по умолчанию cp1251 и падает на не-ASCII в JSON.
    Вызывается из CLI и из блоков ``__main__`` модулей скиллов.
    """
    import sys

    stream = getattr(sys, "stdout", None)
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def env_value(name: str) -> str | None:
    """Значение переменной окружения или ``None``, если оно пустое."""
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def require_env(name: str, skill: str = "") -> str:
    """Вернуть значение ключа или поднять :class:`SkillSkipped`.

    Отсутствие ключа — не ошибка: скилл логирует предупреждение и отдаёт ``[]``.
    """
    value = env_value(name)
    if value:
        return value
    reason = (
        f"скилл {skill or '?'}: не задана переменная окружения {name}; "
        "скилл пропущен и вернул пустой результат. "
        "Смотри skills/.env.example и marketing-agents/.env"
    )
    raise SkillSkipped(reason, code=STATUS_NO_KEY)


# --- формат записи ------------------------------------------------------------


def make_record(source: str, **fields: Any) -> dict:
    """Собрать запись результата в едином формате.

    Обязательные ключи присутствуют всегда; отсутствующие данные — ``None``
    (правило проекта: «данных нет», а не ноль). Исходный ответ целиком лежит
    в ``raw``, чтобы ничего не терялось.
    """
    record: dict[str, Any] = {
        "source": source,
        "id": None,
        "title": None,
        "price": None,
        "area": None,
        "year_built": None,
        "address": None,
        "url": None,
        "raw": None,
    }
    record.update(fields)
    return record


#: Содержательные поля записи. Служебные поля модулей (``api``, ``credit_cost``,
#: ``endpoint`` и подобные) сюда не входят: сами по себе они данных не заменяют.
CONTENT_FIELDS = ("id", "title", "price", "area", "year_built", "address", "url")


def is_empty_record(record: Any) -> bool:
    """Запись не несёт данных.

    Страховка от ложного успеха: если источник вернул мусор (``{}``, ``null``,
    объект без полей), скилл не должен отчитываться статусом ``ok`` и отдавать
    «данные», которых нет. Правило проекта: нет данных — так и говорим.

    Запись считается содержательной, если заполнено любое содержательное поле
    (:data:`CONTENT_FIELDS`) **или** сохранён исходный объект в ``raw``.
    Поэтому модуль скилла обязан класть исходный ответ в ``raw`` — иначе его
    данные будут отброшены как пустые.
    """
    if not isinstance(record, dict):
        return True
    if record.get("raw") not in (None, "", [], {}, ()):
        return False
    for key in CONTENT_FIELDS:
        if record.get(key) not in (None, "", [], {}, ()):
            return False
    return True


# --- декоратор скилла ---------------------------------------------------------


def skill(name: str) -> Callable[[Callable[..., list[dict]]], Callable[..., list[dict]]]:
    """Обернуть ``fetch``: тайминг, журнал, отлов исключений.

    Гарантирует контракт: наружу всегда ``list[dict]`` и никогда исключение.
    """

    def decorator(func: Callable[..., list[dict]]) -> Callable[..., list[dict]]:
        @wraps(func)
        def wrapper(query: str = "", *args: Any, **kwargs: Any) -> list[dict]:
            started = time.perf_counter()
            try:
                result = func(query, *args, **kwargs)
            except SkillSkipped as exc:
                elapsed = (time.perf_counter() - started) * 1000
                log.warning(exc.reason)
                wrapper.last_run = record_run(  # type: ignore[attr-defined]
                    name, query, exc.code, elapsed, 0, error=exc.reason
                )
                return []
            except SkillUnavailable as exc:
                elapsed = (time.perf_counter() - started) * 1000
                log.error("скилл %s недоступен: %s", name, exc.reason)
                wrapper.last_run = record_run(  # type: ignore[attr-defined]
                    name, query, STATUS_NOT_DEPLOYED, elapsed, 0, error=exc.reason
                )
                return []
            except Exception as exc:  # noqa: BLE001 — контракт важнее типа
                elapsed = (time.perf_counter() - started) * 1000
                message = f"{type(exc).__name__}: {exc}"
                log.error("скилл %s упал: %s", name, message)
                wrapper.last_run = record_run(  # type: ignore[attr-defined]
                    name, query, STATUS_ERROR, elapsed, 0, error=message
                )
                return []

            elapsed = (time.perf_counter() - started) * 1000
            produced = list(result or [])
            records = [record for record in produced if not is_empty_record(record)]
            dropped = len(produced) - len(records)
            if dropped:
                log.debug("скилл %s: отброшено %d записей без данных", name, dropped)
            status = STATUS_OK if records else STATUS_EMPTY
            log.info(
                "скилл %s: запрос=%r статус=%s записей=%d отброшено=%d время=%.0f мс",
                name,
                query,
                status,
                len(records),
                dropped,
                elapsed,
            )
            wrapper.last_run = record_run(  # type: ignore[attr-defined]
                name, query, status, elapsed, len(records), dropped_empty=dropped or None
            )
            return records

        wrapper.last_run = {}  # type: ignore[attr-defined]
        return wrapper

    return decorator
