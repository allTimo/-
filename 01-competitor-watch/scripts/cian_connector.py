#!/usr/bin/env python3
r"""cian_connector.py - коннектор Циан как ДОПОЛНИТЕЛЬНЫЙ источник (история цен по каждому лоту).

Зачем: коннектор даёт то, чего нет у нашего HTTP-сбора —
  * cian_search: выдача по фильтрам (region — ЧИСЛОВОЙ id Циан, Москва = 1), 28 предложений на страницу;
  * cian_card: карточка предложения с ИСТОРИЕЙ ЦЕНЫ (price_history), корпусом, адресом, метро, публикатором.
То есть видно точечные изменения: конкретная квартира подешевела, а не только сдвиг медианы.

Вызов: обёртка run-connector.ps1 (готовит plugin-dev в T69) — по одному инструменту за запуск,
без постоянного монтирования MCP (это дорого по токенам).

Честность:
  * нет обёртки/Chrome/коннектора → статус с причиной, метрики null, ничего не подменяем;
  * источник всегда помечается: «cian-connector» (method connector) либо «http» — не смешиваются;
  * если по лоту есть данные из обоих источников, показываем оба и расхождения (проверка качества).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cwlib as cw

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = WATCH_DIR.parent
DATA_DIR = WATCH_DIR / "data" / "clients"
# Единственный источник правды (свёл Lead с plugin-dev): обёртка лежит здесь.
# Переопределяется переменной окружения CW_CONNECTOR_SCRIPT.
DEFAULT_WRAPPER = PROJECT_ROOT / "connectors" / "run-connector.ps1"
MOCK_ENV = "CW_CONNECTOR_MOCK"
WRAPPER_ENV = "CW_CONNECTOR_SCRIPT"
CONNECTOR_SOURCE = "cian-connector"
MOSCOW_REGION_ID = 1
# ПОДТВЕРЖДЕНО plugin-dev: студии — это код 9 (0 невалидно), 1-6 обычные, 7 — свободная планировка.
STUDIO_ROOMS_CODE = 9
DEAL_TYPES = ("sale", "rent")
OFFER_TYPES = ("flat", "room", "house", "townhouse", "land")
REQUIRES_CONFIRMATION = "требует подтверждения"


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# запуск обёртки
# --------------------------------------------------------------------------

def wrapper_path():
    """Путь обёртки: переменная окружения авторитетна (даже если файла нет — статус скажет)."""
    override = os.environ.get(WRAPPER_ENV)
    if override:
        return Path(override)
    return DEFAULT_WRAPPER


def mock_path():
    value = os.environ.get(MOCK_ENV)
    return Path(value) if value and Path(value).exists() else None


def connector_status():
    """Доступен ли коннектор: обёртка, мок-режим или честная причина."""
    mock = mock_path()
    wrapper = wrapper_path()
    if mock:
        return {"available": True, "mode": "mock", "path": str(mock),
                "reason": "мок-режим: ответы коннектора берутся из файла (для тестов и демонстраций)"}
    if wrapper.exists():
        return {"available": True, "mode": "connector", "path": str(wrapper),
                "reason": "обёртка run-connector.ps1 найдена"}
    return {"available": False, "mode": "none", "path": str(wrapper),
            "reason": "обёртка коннектора не найдена (%s) — ожидается от задачи T69" % wrapper}


def run_connector(tool, payload=None, timeout=240, wrapper=None, mock=None):
    """Один инструмент за запуск: обёртка печатает JSON, мы его разбираем."""
    status = connector_status()
    mock = mock or mock_path()
    if mock:
        try:
            data = json.loads(Path(mock).read_text(encoding="utf-8-sig"))
        except Exception as exc:
            return {"status": "ошибка мока", "note": str(exc)[:160], "data": None,
                    "source": CONNECTOR_SOURCE, "method": "connector"}
        response = data.get(tool) if isinstance(data, dict) else None
        if response is None:
            return {"status": "нет данных в моке", "note": "в моке нет ответа для %s" % tool,
                    "data": None, "source": CONNECTOR_SOURCE, "method": "connector-mock"}
        return {"status": "ok", "data": response, "source": CONNECTOR_SOURCE,
                "method": "connector-mock", "note": "ответ из мока (не живой коннектор)"}
    wrapper_file = wrapper or wrapper_path()
    if not wrapper_file.exists():
        return {"status": "коннектор недоступен", "note": status["reason"], "data": None,
                "source": CONNECTOR_SOURCE, "method": "connector"}
    # ВАЖНО: JSON в -Args теряет кавычки, поэтому аргументы передаём файлом (-ArgsFile).
    args_file = None
    command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper_file),
               "-Tool", tool]
    if payload:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(payload, handle, ensure_ascii=False)
        handle.close()
        args_file = handle.name
        command += ["-ArgsFile", args_file]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "таймаут коннектора", "note": "обёртка не ответила за %ss" % timeout,
                "data": None, "source": CONNECTOR_SOURCE, "method": "connector"}
    except Exception as exc:
        return {"status": "ошибка запуска", "note": str(exc)[:160], "data": None,
                "source": CONNECTOR_SOURCE, "method": "connector"}
    finally:
        if args_file:
            try:
                os.unlink(args_file)
            except OSError:
                pass
    text = (completed.stdout or "").strip()
    start = text.find("{")
    envelope = {}
    if start >= 0:
        try:
            envelope = json.loads(text[start:])
        except Exception:
            envelope = {}
    if completed.returncode == 3:
        return {"status": "ошибка транспорта/аргументов",
                "note": (envelope.get("error") or completed.stderr or "")[:200], "data": None,
                "source": CONNECTOR_SOURCE, "method": "connector", "exit_code": 3}
    if completed.returncode != 0 or envelope.get("is_error") or envelope.get("ok") is False:
        # обёртка кладёт текст ошибки в поле text (проверено живьём на validation error)
        reason = (envelope.get("error") or envelope.get("text")
                  or envelope.get("server_stderr_tail") or completed.stderr or "")[:200]
        return {"status": "ошибка коннектора", "note": reason, "data": None,
                "source": CONNECTOR_SOURCE, "method": "connector",
                "exit_code": completed.returncode}
    # обёртка отдаёт уже распарсенный payload инструмента
    data = envelope.get("payload", envelope) if envelope else None
    return {"status": "ok", "data": data, "source": CONNECTOR_SOURCE, "method": "connector",
            "note": envelope.get("server_stderr_tail", "")[:120] if envelope else ""}


def search_with_newbuilding(newbuilding, pages=2, node_exe=None, script=None, timeout=300):
    """ДОПОЛНЕНИЕ: фильтр по ЖК делает обёртка .mjs (в .ps1 этих параметров пока нет).

    ВАЖНО: фильтруются только СКАЧАННЫЕ страницы (например 56 лотов из десятков тысяч по Москве),
    поэтому выборка НЕПОЛНАЯ — статус помечается как «неполная выборка».
    Основной путь для наших конкурентов — страница проекта (HTTP) + cian_card, см. T71.
    """
    mjs = Path(script) if script else (PROJECT_ROOT / "connectors" / "run-connector.mjs")
    if not mjs.exists():
        return {"status": "коннектор недоступен", "note": "нет %s" % mjs, "data": None,
                "incomplete_sample": True}
    node = Path(node_exe) if node_exe else None
    if node is None:
        candidates = [Path(os.environ.get("PROGRAMFILES", "")) / "nodejs" / "node.exe"]
        local = PROJECT_ROOT / "connectors" / "bin"
        candidates += sorted(local.glob("node*.exe")) if local.is_dir() else []
        import shutil as _shutil
        found = _shutil.which("node")
        node = next((item for item in candidates if item and Path(item).exists()),
                    Path(found) if found else None)
    if node is None or not Path(node).exists():
        return {"status": "node не найден", "note": "нужен node для .mjs-обёртки", "data": None,
                "incomplete_sample": True}
    command = [str(node), str(mjs), "--tool", "cian_search", "--newbuilding", str(newbuilding),
               "--pages", str(int(pages))]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=timeout)
    except Exception as exc:
        return {"status": "ошибка запуска", "note": str(exc)[:160], "data": None,
                "incomplete_sample": True}
    text = (completed.stdout or "").strip()
    start = text.find("{")
    if start < 0:
        return {"status": "неожиданный ответ", "note": text[:160], "data": None,
                "incomplete_sample": True}
    try:
        envelope = json.loads(text[start:])
    except Exception as exc:
        return {"status": "не разобрать ответ", "note": str(exc)[:120], "data": None,
                "incomplete_sample": True}
    items = envelope.get("payload") or envelope.get("items") or []
    lots = [normalize_lot(item) for item in items if isinstance(item, dict)]
    return {"status": "ok" if lots else "пусто", "lots": [lot for lot in lots if lot],
            "scanned": envelope.get("scanned"), "matched": envelope.get("matched"),
            "incomplete_sample": True,
            "note": "неполная выборка: фильтр по ЖК идёт по скачанным страницам, не по всему городу",
            "source": CONNECTOR_SOURCE, "method": "connector"}


def list_tools(wrapper=None, timeout=120):
    """Диагностика: какие инструменты видит обёртка (флаг -ListTools)."""
    wrapper_file = wrapper or wrapper_path()
    if not wrapper_file.exists():
        return {"status": "коннектор недоступен", "tools": [], "note": connector_status()["reason"]}
    try:
        completed = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                    "-File", str(wrapper_file), "-ListTools"],
                                   capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=timeout)
    except Exception as exc:
        return {"status": "ошибка запуска", "tools": [], "note": str(exc)[:160]}
    text = (completed.stdout or "").strip()
    start = text.find("{")
    if start < 0:
        return {"status": "неожиданный ответ", "tools": [], "note": text[:160]}
    try:
        envelope = json.loads(text[start:])
    except Exception as exc:
        return {"status": "не разобрать ответ", "tools": [], "note": str(exc)[:120]}
    tools = [item.get("name") for item in (envelope.get("tools") or [])]
    return {"status": "ok" if tools else "пусто", "tools": tools,
            "cian": [name for name in tools if name.startswith("cian")]}


# --------------------------------------------------------------------------
# cian_search
# --------------------------------------------------------------------------

def normalize_lot(raw):
    """Приводим лот коннектора к нашему виду (не теряя исходные поля)."""
    if not isinstance(raw, dict):
        return None
    def first(*names):
        for name in names:
            value = raw.get(name)
            if value not in (None, ""):
                return value
        return None
    lot_id = first("offer_id", "id", "cian_id", "offerId")
    price = first("price_rub", "price", "priceValue")
    area = first("total_area_m2", "area", "area_m2", "total_area", "totalArea")
    rooms = first("rooms", "rooms_count", "roomType")
    def number(value):
        if value is None:
            return None
        try:
            return float(str(value).replace(" ", "").replace("\u00a0", "").replace(",", "."))
        except ValueError:
            return None
    metro_raw = first("metro", "underground", "metro_name")
    metro = metro_raw.get("name") if isinstance(metro_raw, dict) else metro_raw
    floors = first("floors_total", "floors")
    return {"lot_id": str(lot_id) if lot_id is not None else None,
            "price_rub": number(price), "area_m2": number(area),
            "rooms": None if rooms is None else (int(number(rooms)) if number(rooms) is not None else None),
            "address": first("address", "geo", "location"),
            "metro": metro,
            "building": first("building", "corpus", "house", "newbuilding_name"),
            "url": first("url", "link", "offer_url"),
            "title": first("title", "name", "header"),
            "newbuilding": first("newbuilding_name", "newbuilding", "zhk", "project"),
            "floor": first("floor"),
            "floors_total": floors,
            "living_area_m2": number(first("living_area_m2")),
            "kitchen_area_m2": number(first("kitchen_area_m2")),
            "category": first("category"),
            "seller_type": first("seller_type"),
            "publisher": first("publisher", "author", "agency_name", "user"),
            "raw_keys": sorted(raw.keys())[:14],
            "source": CONNECTOR_SOURCE}


def cian_search(deal="sale", offer_type="flat", region=MOSCOW_REGION_ID, rooms=None, price_min=None,
                price_max=None, area_min=None, area_max=None, page=1, extra=None,
                newbuilding_name=None, category="newBuildingFlatSale", seller_type="developer",
                **run_kwargs):
    """Выдача по фильтрам. region — ЧИСЛОВОЙ id Циан (Москва = 1)."""
    if deal not in DEAL_TYPES:
        return {"status": "неверный фильтр", "note": "deal: %s" % deal, "lots": []}
    if offer_type not in OFFER_TYPES:
        return {"status": "неверный фильтр", "note": "offer_type: %s" % offer_type, "lots": []}
    # ГРАБЛИ коннектора: region — строка ("1"), иначе pydantic-ошибка; текстового поиска нет,
    # новостройки фильтруются категорией и именем ЖК.
    # В коннекторе НЕТ текстового поиска и параметров newbuilding_name/category/seller_type
    # (проверено живьём: pydantic отвечает "Unexpected keyword argument"). Поэтому ищем по
    # региону и фильтрам, а проект сопоставляем ЛОКАЛЬНО по полю newbuilding_name лота.
    payload = {"deal": deal, "offer_type": offer_type, "region": str(region), "page": int(page)}
    for key, value in (("price_min", price_min), ("price_max", price_max),
                       ("area_min", area_min), ("area_max", area_max)):
        if value not in (None, "", []):
            payload[key] = value
    if rooms not in (None, "", []):
        # ГРАБЛИ коннектора: rooms ожидается СПИСКОМ (pydantic list_type), иначе validation error.
        # Студии передавай как [STUDIO_ROOMS_CODE] (9): 0 коннектор отвергает.
        payload["rooms"] = list(rooms) if isinstance(rooms, (list, tuple)) else [rooms]
    if extra:
        payload.update(extra)
    result = run_connector("cian_search", payload, **run_kwargs)
    lots = []
    data = result.get("data")
    if isinstance(data, dict):
        raw_lots = data.get("offers") or data.get("items") or data.get("lots") or []
    elif isinstance(data, list):
        raw_lots = data
    else:
        raw_lots = []
    # локальная фильтрация по названию ЖК: в выдаче есть поле newbuilding_name
    if newbuilding_name:
        needle = str(newbuilding_name).strip().lower().replace("жк ", "").replace("«", "").replace("»", "")
        filtered = []
        for raw in raw_lots:
            name = str((raw or {}).get("newbuilding_name") or "").lower()
            if needle in name or name in needle and needle:
                filtered.append(raw)
        if filtered:
            raw_lots = filtered
    for raw in raw_lots:
        normalized = normalize_lot(raw)
        if normalized:
            lots.append(normalized)
    return {"status": result["status"], "note": result.get("note", ""), "lots": lots,
            "params": payload, "source": result.get("source"), "method": result.get("method"),
            "total": (data.get("total") if isinstance(data, dict) else None)}


def match_project(lots, project, address=None, metro=None):
    """Сопоставление выдачи с проектом: по названию ЖК, адресу или метро.

    При неоднозначности НЕ угадываем: статус «требует подтверждения».
    """
    wanted = cw.normalize_text(project) if hasattr(cw, "normalize_text") else str(project or "").lower()
    strong, weak = [], []
    for lot in lots:
        haystack = " ".join(str(lot.get(field) or "") for field in
                            ("newbuilding", "title", "address", "metro", "building")).lower()
        if wanted and wanted in haystack:
            strong.append(lot)
        elif address and str(address).lower()[:18] in haystack:
            weak.append(lot)
        elif metro and str(metro).lower() in haystack:
            weak.append(lot)
    if len(strong) == 1:
        return {"status": "подтверждено", "lots": strong,
                "note": "точное совпадение с проектом «%s»" % project}
    if len(strong) > 1:
        return {"status": REQUIRES_CONFIRMATION, "lots": strong,
                "note": "%d лотов содержат название проекта — нужно подтвердить связь" % len(strong)}
    if len(weak) == 1:
        return {"status": REQUIRES_CONFIRMATION, "lots": weak,
                "note": "совпадение только по адресу/метро — просим подтвердить"}
    if len(weak) > 1:
        return {"status": REQUIRES_CONFIRMATION, "lots": weak,
                "note": "%d лотов совпали по адресу/метро — нужно подтвердить связь" % len(weak)}
    return {"status": "не найдено", "lots": [], "note": "среди выдачи нет лотов этого проекта"}


# --------------------------------------------------------------------------
# cian_card + история цены
# --------------------------------------------------------------------------

def normalize_history(card):
    """История цены: список {date, price} по возрастанию даты."""
    raw = card.get("price_history") or card.get("priceHistory") or card.get("history") or []
    entries = []
    for item in raw:
        if isinstance(item, dict):
            # ЖИВОЙ ФАКТ: коннектор отдаёт [{changed_at: "ISO", price_rub: N}, ...]
            # (список идёт от новых к старым — ниже сортируем по возрастанию даты)
            date = (item.get("changed_at") or item.get("date") or item.get("dt")
                    or item.get("created_at") or item.get("created") or item.get("timestamp"))
            price = item.get("price_rub") or item.get("price") or item.get("value")
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            date, price = item[0], item[1]
        else:
            continue
        try:
            price_value = float(str(price).replace(" ", "").replace("\u00a0", ""))
        except (TypeError, ValueError):
            continue
        entries.append({"date": str(date)[:10], "price_rub": price_value})
    return sorted(entries, key=lambda item: item["date"])


def cian_card(offer_id, client_id=None, save=True, project=None, extra=None, **run_kwargs):
    """Карточка предложения с историей цены. Сохраняем историю в lot-history/<lot-id>.json."""
    # ЖИВОЙ ФАКТ: коннектор принимает именно offer_id_or_url (а не offer_id / url / id)
    result = run_connector("cian_card", {"offer_id_or_url": str(offer_id)}, **run_kwargs)
    data = result.get("data")
    card = data if isinstance(data, dict) else {}
    if isinstance(card, dict) and "offer" in card and isinstance(card["offer"], dict):
        card = card["offer"]
    history = normalize_history(card) if card else []
    saved = None
    if save and client_id and card:
        normalized = normalize_lot(card) or {}
        saved = save_lot_history(client_id, normalized.get("lot_id") or str(offer_id), card,
                                 history, project=project, extra=extra)
    return {"status": result["status"], "note": result.get("note", ""), "card": card,
            "price_history": history, "saved": str(saved) if saved else None,
            "source": result.get("source"), "method": result.get("method")}


def save_lot_history(client_id, lot_id, card, history=None, project=None, extra=None):
    path = DATA_DIR / str(client_id) / "lot-history" / ("%s.json" % lot_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"lot_id": str(lot_id), "saved_at": dt.date.today().isoformat(),
               # project = канонический ключ конкурента: метрики истории привязываются к проекту
               "project": project, "source": CONNECTOR_SOURCE, "history": history if history is not None
               else normalize_history(card), "card": {key: value for key, value in (card or {}).items()
                                                      if key not in ("price_history", "priceHistory")}}
    if extra:
        payload.update(extra)
    if path.exists():
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path.with_name(path.name + ".bak-" + stamp))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def histories_by_project(client_id):
    """Истории, сгруппированные по каноническому ключу конкурента (project)."""
    directory = DATA_DIR / str(client_id) / "lot-history"
    grouped = {}
    if not directory.is_dir():
        return grouped
    for path in sorted(directory.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        key = payload.get("project") or "не сопоставлен"
        grouped.setdefault(key, {})[payload.get("lot_id") or path.stem] = payload.get("history") or []
    return grouped


def metrics_by_project(client_id):
    """Метрики истории цен ПО КАЖДОМУ конкурентному проекту + сводка."""
    grouped = histories_by_project(client_id)
    per_project = {}
    combined = {}
    for project, histories in grouped.items():
        combined.update(histories)
        if project == "не сопоставлен":
            continue
        metrics = price_history_metrics(histories)
        per_project[project] = {"metrics": history_metrics(metrics), "raw": metrics,
                                "lots": len(histories)}
    return {"projects": per_project, "total": history_metrics(price_history_metrics(combined)),
            "projects_count": len(per_project), "lots_total": len(combined)}


def load_lot_histories(client_id):
    directory = DATA_DIR / str(client_id) / "lot-history"
    if not directory.is_dir():
        return {}
    histories = {}
    for path in sorted(directory.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        histories[payload.get("lot_id") or path.stem] = payload.get("history") or []
    return histories


def price_history_metrics(histories):
    """Метрики истории цен по лотам: снижения, средняя глубина, рост, дата изменения, давление."""
    decreased, increased, unchanged, depths, last_change = [], [], [], [], None
    for lot_id, history in (histories or {}).items():
        prices = [item for item in history if item.get("price_rub")]
        if len(prices) < 2:
            continue
        first, last = prices[0]["price_rub"], prices[-1]["price_rub"]
        last_date = prices[-1]["date"]
        if last < first:
            decreased.append(lot_id)
            depths.append((first - last) / first * 100)
            last_change = max(last_change, last_date) if last_change else last_date
        elif last > first:
            increased.append(lot_id)
            last_change = max(last_change, last_date) if last_change else last_date
        else:
            unchanged.append(lot_id)
    analysed = len(decreased) + len(increased) + len(unchanged)
    avg_depth = round(sum(depths) / len(depths), 2) if depths else None
    share = round(len(decreased) / analysed * 100, 1) if analysed else None
    pressure = round(share / 100 * avg_depth, 2) if (share is not None and avg_depth) else None
    # ВАЖНО: если история есть, то 0 снижений/ростов — это реальный ноль, а не «нет данных».
    # null отдаём только когда истории нет вовсе (см. history_metrics).
    return {
        "lots_with_history": analysed,
        "lots_decreased": len(decreased),
        "lots_increased": len(increased),
        "lots_unchanged": len(unchanged),
        "avg_decrease_depth_pct": avg_depth,
        "share_decreased_pct": share,
        "last_price_change": last_change,
        "price_pressure_pct": pressure,
    }


def history_metrics(history_metrics_result, collected_at=None):
    """Метрики профиля с явным источником cian-connector."""
    collected = collected_at or dt.date.today().isoformat()
    def metric(value, unit, comment, method="connector", accuracy="высокая"):
        return {"value": value, "unit": unit, "source": CONNECTOR_SOURCE, "collected_at": collected,
                "method": method, "accuracy": accuracy, "comment": comment}
    result = history_metrics_result or {}
    if not result.get("lots_with_history"):
        reason = "история цен по лотам недоступна: коннектор не отдал данные (см. статус источника)"
        return {key: metric(None, unit, reason, method="none", accuracy="")
                for key, unit in (("lots_with_price_history", "лотов"),
                                  ("lots_price_decreased", "лотов"),
                                  ("avg_price_decrease_pct", "%"),
                                  ("lots_price_increased", "лотов"),
                                  ("last_price_change", "дата"),
                                  ("price_pressure_pct", "%"))}
    return {
        "lots_with_price_history": metric(result["lots_with_history"], "лотов",
                                          "лоты, по которым коннектор отдал историю цены"),
        "lots_price_decreased": metric(result["lots_decreased"], "лотов",
                                       "цена снижалась (доля снижений %s%%)" % result["share_decreased_pct"]),
        "avg_price_decrease_pct": metric(result["avg_decrease_depth_pct"], "%",
                                         "средняя глубина снижения по снизившимся лотам"),
        "lots_price_increased": metric(result["lots_increased"], "лотов", "цена росла"),
        "last_price_change": metric(result["last_price_change"], "дата",
                                    "дата последнего изменения цены в сохранённой истории"),
        "price_pressure_pct": metric(result["price_pressure_pct"], "%",
                                     "оценка «давления на цену»: доля снизившихся лотов × средняя "
                                     "глубина снижения (оценка по истории цен, не факт расхода)",
                                     method="estimate", accuracy="средняя"),
    }


# --------------------------------------------------------------------------
# сверка источников и снимок
# --------------------------------------------------------------------------

def compare_lot_sources(connector_lot, http_lot, tolerance_price=0.5, tolerance_area=0.5):
    """Если лот есть в обоих источниках — показываем оба значения и расхождения."""
    fields = ("price_rub", "area_m2", "rooms", "address", "metro")
    differences = []
    for field in fields:
        first, second = (connector_lot or {}).get(field), (http_lot or {}).get(field)
        if first is None or second is None:
            continue
        if isinstance(first, (int, float)) and isinstance(second, (int, float)):
            if not second:
                continue
            delta = abs(first - second) / abs(second) * 100
            limit = tolerance_price if field == "price_rub" else tolerance_area
            if delta > limit:
                differences.append({"field": field, "connector": first, "http": second,
                                    "delta_pct": round(delta, 2)})
        elif str(first) != str(second):
            differences.append({"field": field, "connector": first, "http": second,
                                "delta_pct": None})
    return {"matched": bool(connector_lot) and bool(http_lot), "differences": differences,
            "checked_fields": list(fields),
            "source": "сверка cian-connector и http"}


def save_connector_snapshot(client_id, lots, date=None, note=""):
    """Снимок лотов из коннектора — отдельно от HTTP-снимков, с пометкой источника."""
    date = date or dt.date.today().isoformat()
    path = DATA_DIR / str(client_id) / "connector" / ("%s-lots.csv" % date)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["snapshot_date", "source", "lot_id", "url", "rooms", "area_m2", "price_rub",
              "address", "metro", "building", "project", "match_status", "note"]
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for lot in lots or []:
            row = {key: ("" if lot.get(key) is None else lot.get(key)) for key in fields}
            row.update({"snapshot_date": date, "source": lot.get("source") or CONNECTOR_SOURCE,
                        "project": lot.get("project") or "", "match_status": lot.get("match_status") or "",
                        "note": note})
            writer.writerow(row)
    return path


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    setup_console()
    parser = argparse.ArgumentParser(prog="cian_connector.py",
                                     description="Коннектор Циан: поиск по фильтрам и история цен лотов.")
    parser.add_argument("--check", action="store_true", help="только проверить доступность коннектора")
    parser.add_argument("--project", default=None, help="название ЖК для сопоставления")
    parser.add_argument("--client", default="client-svet")
    parser.add_argument("--region", type=int, default=MOSCOW_REGION_ID, help="числовой id Циан (Москва=1)")
    parser.add_argument("--rooms", default=None)
    parser.add_argument("--price-min", type=float, default=None)
    parser.add_argument("--price-max", type=float, default=None)
    parser.add_argument("--area-min", type=float, default=None)
    parser.add_argument("--area-max", type=float, default=None)
    parser.add_argument("--cards", type=int, default=0, help="сколько лотов взять карточкой (история цен)")
    parser.add_argument("--mock", default=None, help="файл с ответами коннектора (демо/тесты)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if args.mock:
        os.environ[MOCK_ENV] = args.mock
    status = connector_status()
    print("Коннектор: %s (%s)" % ("доступен" if status["available"] else "недоступен", status["reason"]))
    if args.check:
        print(json.dumps(status, ensure_ascii=False))
        return 0 if status["available"] else 0

    search = cian_search(region=args.region, rooms=args.rooms, price_min=args.price_min,
                         price_max=args.price_max, area_min=args.area_min, area_max=args.area_max)
    print("Поиск: %s | лотов: %d | параметры: %s"
          % (search["status"], len(search["lots"]), json.dumps(search["params"], ensure_ascii=False)))
    lots = search["lots"]
    match = {"status": "не проверялось", "lots": lots, "note": ""}
    if args.project:
        match = match_project(lots, args.project)
        print("Сопоставление с «%s»: %s — %s" % (args.project, match["status"], match["note"]))
    if lots:
        path = save_connector_snapshot(args.client, match["lots"], note=match["note"])
        print("Снимок коннектора: %s" % path)

    histories = {}
    for lot in (match["lots"] or [])[:args.cards]:
        card_id = lot.get("lot_id")
        if not card_id:
            continue
        result = cian_card(card_id, client_id=args.client)
        if result["price_history"]:
            histories[card_id] = result["price_history"]
        print("   карточка %s: %s | точек истории: %d" % (card_id, result["status"],
                                                          len(result["price_history"])))
    metrics = history_metrics(price_history_metrics({**load_lot_histories(args.client), **histories}))
    print("История цен: лотов с историей %s | снижений %s | средняя глубина %s%% | рост %s | "
          "последнее изменение %s | давление на цену %s%%"
          % (metrics["lots_with_price_history"]["value"], metrics["lots_price_decreased"]["value"],
             metrics["avg_price_decrease_pct"]["value"], metrics["lots_price_increased"]["value"],
             metrics["last_price_change"]["value"], metrics["price_pressure_pct"]["value"]))
    if args.json:
        print(json.dumps({"status": status, "search": {key: search[key] for key in
                                                       ("status", "params", "total") if key in search},
                          "match": {key: match[key] for key in ("status", "note")},
                          "metrics": {key: value["value"] for key, value in metrics.items()}},
                         ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
