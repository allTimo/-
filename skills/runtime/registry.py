"""Реестр скиллов: чтение ``skills_registry.json``, разрешение модуля, вызов.

Единая точка входа для агентов::

    from skills.runtime import run_skill, list_skills
    records = run_skill("mcp_market", "каркасные дома в спб")

``run_skill`` никогда не поднимает исключение: неизвестный или выключенный скилл
попадает в журнал со статусом ``error`` и возвращает пустой список.
"""

from __future__ import annotations

import importlib
import json
import time
from typing import Any

from .core import (
    PROJECT_DIR,
    REGISTRY_PATH,
    STATUS_ERROR,
    STATUS_OK,
    log,
    record_run,
)


def load_registry(path: Any = None) -> dict:
    """Прочитать реестр скиллов. Поднимает ``FileNotFoundError``, если файла нет."""
    target = path or REGISTRY_PATH
    with open(target, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("skills"), list):
        raise ValueError(f"реестр скиллов повреждён: {target}")
    return data


def skill_entries(include_disabled: bool = False) -> list[dict]:
    """Список записей реестра (по умолчанию только включённые)."""
    entries = load_registry().get("skills", [])
    if include_disabled:
        return list(entries)
    return [entry for entry in entries if entry.get("enabled", True)]


def list_skills(include_disabled: bool = False) -> list[str]:
    """Имена скиллов из реестра."""
    return [entry["name"] for entry in skill_entries(include_disabled)]


def get_entry(name: str) -> dict | None:
    """Запись реестра по имени скилла или ``None``."""
    for entry in load_registry().get("skills", []):
        if entry.get("name") == name:
            return entry
    return None


def get_module(name: str) -> Any:
    """Импортировать модуль скилла по записи реестра.

    :raises KeyError: скилла нет в реестре или он выключен
    """
    entry = get_entry(name)
    if entry is None:
        raise KeyError(f"скилл {name!r} не найден в реестре {REGISTRY_PATH}")
    if not entry.get("enabled", True):
        raise KeyError(f"скилл {name!r} выключен в реестре")
    module_path = entry.get("module")
    if not module_path:
        raise KeyError(f"у скилла {name!r} не указан module")
    return importlib.import_module(module_path)


def get_callable(name: str):
    """Вернуть функцию входа скилла (по умолчанию ``fetch``)."""
    entry = get_entry(name) or {}
    function_name = entry.get("entry", "fetch")
    module = get_module(name)
    function = getattr(module, function_name, None)
    if function is None:
        raise KeyError(f"в модуле скилла {name!r} нет функции {function_name!r}")
    return function


def run_skill(name: str, query: str = "", **kwargs: Any) -> list[dict]:
    """Вызвать скилл по имени. Никогда не поднимает исключение.

    Неизвестный, выключенный или сломанный скилл даёт пустой список и запись
    в журнале со статусом ``error``.
    """
    return run_skill_result(name, query, **kwargs)["records"]


def run_skill_result(name: str, query: str = "", **kwargs: Any) -> dict:
    """Как :func:`run_skill`, но возвращает ещё статус, ошибку и время выполнения."""
    started = time.perf_counter()
    try:
        function = get_callable(name)
    except Exception as exc:  # noqa: BLE001 — агент не должен падать на опечатке
        elapsed = (time.perf_counter() - started) * 1000
        message = f"{type(exc).__name__}: {exc}"
        log.error("не удалось загрузить скилл %s: %s", name, message)
        record_run(name, query, STATUS_ERROR, elapsed, 0, error=message)
        return {
            "skill": name,
            "query": query,
            "status": STATUS_ERROR,
            "records": [],
            "error": message,
            "duration_ms": round(elapsed, 1),
        }

    records = function(query, **kwargs)
    last_run = getattr(function, "last_run", None) or {}
    return {
        "skill": name,
        "query": query,
        "status": last_run.get("status", STATUS_OK if records else "empty"),
        "records": records,
        "error": last_run.get("error"),
        "duration_ms": last_run.get("duration_ms"),
    }
