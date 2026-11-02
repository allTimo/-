#!/usr/bin/env python3
r"""discover_competitors.py - automatic competitor discovery around our own project.

Reads the watch settings (registry/agent-settings/agent-1-competitor-watch.yaml,
group agent1.watch per docs/agent1-competitor-discovery.md), determines the coordinates
of our project (settings or geocoding), searches candidates on public pages without any
login plus web search, computes straight-line distances (haversine), filters by radius,
class and price per m2, and stores the list in data/candidates/<project-id>.json.

File rules (Lead, 01.11.2026):
  * data/candidates/<project-id>.json          - written ONLY by this engine;
  * data/candidates/<project-id>.decisions.json - written ONLY by the panel; the engine
    only reads it and applies approved/rejected; rejected candidates are never offered again.

Honesty: missing coordinates or prices stay empty with the note «данных нет», never invented.

Usage:
    python discover_competitors.py --project my-zhk-svet
    python discover_competitors.py --radius 5 --search-results search.json --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import cwlib as cw
import platforms

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = cw.PROJECT_ROOT
SETTINGS_FILE = PROJECT_ROOT / "registry" / "agent-settings" / "agent-1-competitor-watch.yaml"
CANDIDATES_DIR = WATCH_DIR / "data" / "candidates"
GEOCACHE = WATCH_DIR / "data" / "geocache.json"
RUNS_FILE = PROJECT_ROOT / "registry" / "runs.jsonl"
AGENT = "agent-1-competitor-watch"
SERVICE = "competitor-watch"
RUN_KIND = "discovery"
DEFAULT_RADIUS_KM = 10.0
NOMINATIM = "https://nominatim.openstreetmap.org/search"
YANDEX_GEOCODER = "https://geocode-maps.yandex.ru/1.x/"
USER_AGENT = "dsh-marketing-agent1/1.0 (competitor discovery; contact: user)"

# Публичные каталожные страницы площадок: используются как попытка поиска (без логина).
PLATFORM_SEARCH_URLS = {
    "cian": "https://www.cian.ru/novostroyki/",
    "avito": "https://www.avito.ru/rossiya/kvartiry",
    "yandex-realty": "https://realty.yandex.ru/moskva-i-moskovskaya-oblast/kupit/kvartira/",
    "domclick": "https://domclick.ru/",
}
KLASS_SYNONYMS = {
    "бизнес": ("бизнес", "business", "комфорт+", "комфорт плюс"),
    "премиум": ("премиум", "premium", "элит", "делюкс", "deluxe"),
    "комфорт": ("комфорт", "comfort"),
    "эконом": ("эконом", "economy"),
}


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# настройки наблюдения
# --------------------------------------------------------------------------

def load_watch(settings_file=None, project_id=None, radius=None, classes=None):
    """agent1.watch из тонких настроек агента + подтверждённые конкуренты."""
    path = Path(settings_file) if settings_file else SETTINGS_FILE
    data = cw.parse_simple_yaml(path) if path.exists() else {}
    agent1 = (data or {}).get("agent1") or {}
    watch = dict(agent1.get("watch") or {})
    projects = agent1.get("projects") or []
    if not watch.get("project_id"):
        watch["project_id"] = str(project_id or (projects[0] if projects else "unknown-project"))
    if project_id:
        watch["project_id"] = str(project_id)
    watch["radius_km"] = float(radius if radius is not None else (watch.get("radius_km") or DEFAULT_RADIUS_KM))
    if classes:
        watch["klass"] = list(classes)
    if not watch.get("klass"):
        watch["klass"] = []
    if isinstance(watch.get("klass"), str):
        watch["klass"] = [watch["klass"]]
    watch["max_candidates"] = int(watch.get("max_candidates") or 20)
    watch["sources"] = list(watch.get("sources") or ["cian", "avito", "yandex-realty", "domclick", "web-search"])
    watch["confirmed"] = [item for item in (agent1.get("competitors") or []) if isinstance(item, dict)]
    watch["settings_file"] = str(path)
    return watch


def watch_coords(watch):
    """Координаты: lat/lon из настроек или из coords: [lat, lon]."""
    lat = watch.get("lat")
    lon = watch.get("lon")
    coords = watch.get("coords")
    if (lat in (None, "") or lon in (None, "")) and isinstance(coords, (list, tuple)) and len(coords) == 2:
        lat, lon = coords[0], coords[1]
    try:
        return float(lat), float(lon)
    except (TypeError, ValueError):
        return None, None


# --------------------------------------------------------------------------
# геокодирование с кэшем
# --------------------------------------------------------------------------

def load_geocache(path=None):
    path = Path(path) if path else GEOCACHE
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def save_geocache(cache, path=None):
    path = Path(path) if path else GEOCACHE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return path


def _http_json(url, timeout=20):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def looks_russian(address):
    text = str(address or "")
    return bool(re.search(r"[А-Яа-яЁё]", text)) or any(
        marker in text.lower() for marker in ("москв", "росси", "russia", "moscow"))


def geocode_nominatim(address, fetch=None):
    params = {"q": address, "format": "json", "limit": 3, "accept-language": "ru"}
    if looks_russian(address):
        params["countrycodes"] = "ru"          # иначе «Москва ... 83А» может найтись во Франции
    query = urllib.parse.urlencode(params)
    data = (fetch or _http_json)("%s?%s" % (NOMINATIM, query))
    if not data:
        return None
    # лучший результат: сначала по точности попадания, потом по importance
    precise = ("house", "building", "apartments", "address")
    ranked = sorted(data, key=lambda item: (0 if str(item.get("type") or "") in precise else 1,
                                            -float(item.get("importance") or 0)))
    item = ranked[0]
    return {"lat": float(item["lat"]), "lon": float(item["lon"]),
            "display_name": item.get("display_name") or "",
            "accuracy": (item.get("type") or "") + "/" + (item.get("class") or ""),
            "source": "osm-nominatim"}


def geocode_yandex(address, key, fetch=None):
    query = urllib.parse.urlencode({"apikey": key, "geocode": address, "format": "json", "results": 1})
    data = (fetch or _http_json)("%s?%s" % (YANDEX_GEOCODER, query))
    try:
        members = data["response"]["GeoObjectCollection"]["featureMember"]
        if not members:
            return None
        point = members[0]["GeoObject"]["Point"]["pos"].split()
        return {"lat": float(point[1]), "lon": float(point[0]),
                "display_name": members[0]["GeoObject"].get("metaDataProperty", {})
                .get("GeocoderMetaData", {}).get("text", ""),
                "accuracy": members[0]["GeoObject"]["metaDataProperty"]["GeocoderMetaData"]
                .get("precision", ""),
                "source": "yandex-geocoder"}
    except Exception:
        return None


def accuracy_grade(result):
    """precise — дом/строение; coarse — улица/район; unusable — админграница, страна, мусор."""
    precision = str((result or {}).get("accuracy") or "").lower()
    if any(marker in precision for marker in ("house", "building", "apartments", "address")):
        return "precise"
    if any(marker in precision for marker in ("street", "road", "highway", "primary", "secondary",
                                              "tertiary", "residential", "neighbourhood", "suburb",
                                              "city", "town", "village", "district", "quarter",
                                              "locality", "amenity", "construction",
                                              "landuse", "plot", "site")):
        # улица/трасса/стройплощадка: для радиуса 10 км годится, но помечаем как невысокую точность
        return "coarse"
    return "unusable"


def apply_accuracy(result, address=None):
    """Добавить оценку точности (grade) и предупреждение по факту accuracy."""
    if result.get("lat") is None:
        result.setdefault("grade", "unusable")
        result.setdefault("warning", "")
        return result
    grade = accuracy_grade(result)
    result["grade"] = grade
    if grade == "unusable":
        result["warning"] = ("геокодер вернул только «%s» — такие координаты не используем. "
                             "Уточните адрес или задайте координаты вручную."
                             % (result.get("accuracy") or "без детализации"))
    elif grade == "coarse":
        result["warning"] = ("точность геокодирования невысокая (%s) — проверьте координаты "
                             "или задайте их вручную" % (result.get("accuracy") or "неизвестно"))
    else:
        result["warning"] = ""
    if address and not re.search(r"[0-9]", str(address)):
        result["warning"] = (result["warning"] + " " if result["warning"] else "") + \
            "в адресе нет номера дома — точность ограничена"
    return result


def geocode(address, cache_path=None, yandex_key=None, fetch=None, use_cache=True):
    """Координаты по адресу с кэшем. Возвращает dict с полями и warning."""
    cache = load_geocache(cache_path) if use_cache else {}
    key = "addr:" + re.sub(r"\s+", " ", str(address or "")).strip().lower()
    if use_cache and key in cache and accuracy_grade(cache[key]) != "unusable":
        cached = dict(cache[key])
        cached["cached"] = True
        # оценку точности считаем заново из факта (accuracy), а не берём из кэша:
        # правила уточняются, а кэш хранит только ответ геокодера
        result = apply_accuracy(cached, address)
        facts = {k: v for k, v in result.items()
                 if k in ("lat", "lon", "display_name", "accuracy", "source")}
        if facts != cache[key]:          # лечим старые записи кэша, оставляя только факты
            cache[key] = facts
            save_geocache(cache, cache_path)
        return result
    # запись в кэше непригодна (например однажды нашлась админграница другой страны) —
    # игнорируем её и спрашиваем геокодер заново
    result = None
    warnings = []
    not_found = False
    if yandex_key:
        try:
            result = geocode_yandex(address, yandex_key, fetch=fetch)
        except Exception as exc:
            warnings.append("Яндекс.Геокодер недоступен: %s" % exc)
    if result is None:
        try:
            result = geocode_nominatim(address, fetch=fetch)
            not_found = result is None
        except Exception as exc:
            warnings.append("OSM/Nominatim недоступен: %s" % exc)
    if result is None:
        reason = ("геокодер не нашёл такой адрес (%s)" % address) if not_found else                  ("; ".join(warnings) or "геокодер не ответил")
        return {"lat": None, "lon": None, "accuracy": "", "source": "",
                "warning": "координаты не определены: %s. Уточните адрес или задайте координаты вручную."
                           % reason, "cached": False}
    result = apply_accuracy(result, address)
    result["cached"] = False
    if use_cache:
        # в кэш идут только факты от геокодера, без производных оценок
        cache[key] = {k: v for k, v in result.items()
                      if k in ("lat", "lon", "display_name", "accuracy", "source")}
        save_geocache(cache, cache_path)
    return result


def resolve_watch_coords(watch, cache_path=None, yandex_key=None, fetch=None):
    """Координаты своего ЖК: из настроек, иначе геокодирование по адресу."""
    lat, lon = watch_coords(watch)
    if lat is not None and lon is not None:
        return {"lat": lat, "lon": lon, "source": "settings", "accuracy": "settings",
                "warning": "", "cached": False}
    address = str(watch.get("address") or "").strip()
    if not address:
        return {"lat": None, "lon": None, "source": "", "accuracy": "",
                "warning": "не заданы ни координаты, ни адрес — подбор по радиусу невозможен",
                "cached": False}
    if set(address) <= set("? ,.-0123456789"):   # адрес из одних вопросительных знаков
        return {"lat": None, "lon": None, "source": "", "accuracy": "",
                "warning": "адрес в настройках повреждён (только «?») — перезапишите его в "
                           "registry/agent-settings/agent-1-competitor-watch.yaml", "cached": False}
    result = geocode(address, cache_path=cache_path, yandex_key=yandex_key, fetch=fetch)
    if result.get("grade") == "unusable":
        return {"lat": None, "lon": None, "source": result.get("source") or "", "accuracy": "",
                "warning": result.get("warning") or "", "cached": result.get("cached", False)}
    return result


def haversine_km(lat1, lon1, lat2, lon2):
    """Расстояние по прямой между двумя точками, км (формула гаверсинуса)."""
    radius = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------
# поиск кандидатов
# --------------------------------------------------------------------------

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(value, limit=48):
    text = str(value or "").strip().lower()
    text = "".join(TRANSLIT.get(char, char) for char in text)
    text = re.sub(r"[^0-9a-z]+", "-", text).strip("-")
    return text[:limit] or "project"


def candidate_id(name, developer=""):
    """Стабильный id кандидата: слаг «название-застройщик» (панель берёт его как ключ решения)."""
    parts = [slugify(name)]
    if developer:
        parts.append(slugify(developer, 24))
    return "-".join(parts)


def candidate_key(name, developer=""):
    material = (re.sub(r"\s+", " ", str(name or "")).strip().lower() + "|" +
                re.sub(r"\s+", " ", str(developer or "")).strip().lower())
    return hashlib.sha1(material.encode("utf-8")).hexdigest()[:12]


def class_matches(candidate_class, wanted):
    if not wanted or not candidate_class:
        return None            # неизвестно — не отбрасываем, помечаем
    lowered = str(candidate_class).lower()
    for klass in wanted:
        for synonym in KLASS_SYNONYMS.get(str(klass).lower(), (str(klass).lower(),)):
            if synonym in lowered:
                return True
    return False


def load_search_results(path):
    """Снимок поисковой выдачи (реальные результаты, сохранённые в JSON)."""
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if isinstance(data, dict):
        return list(data.get("results") or data.get("candidates") or [])
    return list(data)


def discover_via_platforms(watch, allow_browser=False):
    """Попытка поиска на публичных страницах площадок (без логина)."""
    attempts = []
    for source in watch.get("sources") or []:
        if source not in PLATFORM_SEARCH_URLS:
            continue
        url = PLATFORM_SEARCH_URLS[source]
        try:
            result = platforms.collect_platform(url, source.replace("-", "_"), allow_browser=allow_browser)
            attempts.append({"source": source, "url": url, "status": result.get("status"),
                             "note": result.get("note") or "", "found": len(result.get("lots") or [])})
        except Exception as exc:
            attempts.append({"source": source, "url": url, "status": "error",
                             "note": "площадка недоступна: %s" % exc, "found": 0})
    return attempts


def build_candidates(entries, watch, origin, geocode_cache_path=None, yandex_key=None, fetch=None,
                    polite_delay=0.0, fetch_pages=False):
    """Кандидаты из записей поиска: геокодирование, расстояние, класс, цена."""
    wanted = watch.get("klass") or []
    price_min = watch.get("price_min_per_m2")
    price_max = watch.get("price_max_per_m2")
    radius = float(watch.get("radius_km") or DEFAULT_RADIUS_KM)
    results = []
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        name = str(entry["name"]).strip()
        developer = str(entry.get("developer") or "").strip()
        klass = str(entry.get("class") or entry.get("klass") or "").strip()
        notes = []
        lat, lon = entry.get("lat"), entry.get("lon")
        if lat in (None, "") or lon in (None, ""):
            address = str(entry.get("address") or "").strip()
            if address:
                geo = geocode(address, cache_path=geocode_cache_path, yandex_key=yandex_key, fetch=fetch)
                if polite_delay and not geo.get("cached"):
                    time.sleep(polite_delay)   # политика Nominatim: не чаще 1 запроса в секунду
                if geo.get("grade") == "unusable":
                    lat, lon = None, None
                    notes.append("координаты ненадёжны (%s) — расстояние не считаем, данных нет"
                                 % (geo.get("accuracy") or "без детализации"))
                else:
                    lat, lon = geo.get("lat"), geo.get("lon")
                    if geo.get("warning"):
                        notes.append(geo["warning"])
            else:
                notes.append("нет адреса и координат — расстояние неизвестно (данных нет)")
        try:
            lat_f, lon_f = float(lat), float(lon)
        except (TypeError, ValueError):
            lat_f = lon_f = None
        distance = None
        if lat_f is not None and lon_f is not None and origin.get("lat") is not None:
            distance = round(haversine_km(origin["lat"], origin["lon"], lat_f, lon_f), 2)
        price = entry.get("price_per_m2")
        try:
            price = float(price) if price not in (None, "") else None
        except (TypeError, ValueError):
            price = None
        page_url = ""
        for source in (entry.get("sources") or []):
            if isinstance(source, dict) and source.get("url"):
                page_url = page_url or str(source["url"])
        if price is None and fetch_pages and page_url and "cian.ru" in page_url:
            # страница ЖК на Циан отдаётся обычным HTTP: берём медиану ₽/м² и адрес
            try:
                summary = platforms.cian_project_summary(page_url, expect_name=name)
                if summary.get("status") == "ok" and summary.get("price_per_m2"):
                    price = float(summary["price_per_m2"])
                    notes.append("цена ₽/м² — медиана по %d лотам страницы ЖК (Циан, HTTP без логина)"
                                 % (summary.get("complete") or 0))
                if summary.get("address") and (lat in (None, "") or lon in (None, "")):
                    entry = dict(entry, address=summary["address"])
                    notes.append("адрес со страницы ЖК: %s" % summary["address"])
            except Exception as exc:
                notes.append("страница ЖК Циан недоступна: %s" % exc)
        if price is None:
            notes.append("цена за м² не найдена на публичной странице — данных нет")
        match = class_matches(klass, wanted)
        if match is False:
            notes.append("класс «%s» не совпадает с сегментом наблюдения (%s)"
                         % (klass or "неизвестен", ", ".join(wanted)))
        in_price_range = True
        if price is not None:
            if price_min and price < float(price_min):
                in_price_range = False
            if price_max and price > float(price_max):
                in_price_range = False
        in_radius = distance is not None and distance <= radius
        if distance is None:
            notes.append("расстояние не посчитано — координаты неизвестны (данных нет)")
        elif not in_radius:
            notes.append("за пределами радиуса %.1f км" % radius)
        confidence = "high" if (distance is not None and price is not None and match is not False) else \
                     ("medium" if distance is not None else "low")
        results.append({
            "id": candidate_id(name, developer),
            "key": candidate_key(name, developer),
            "name": name,
            "developer": developer or None,
            "class": klass or None,
            "lat": lat_f, "lon": lon_f,
            "distance_km": distance,
            "price_per_m2": price,
            "sources": entry.get("sources") or [{"platform": entry.get("source") or "web-search",
                                                 "url": entry.get("url")}],
            "found_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "confidence": confidence,
            "status": "candidate",
            "notes": notes,
            "in_radius": in_radius,
            "class_match": match,
            "in_price_range": in_price_range,
        })
    return results


def filter_candidates(candidates, radius, include_outside=False):
    kept = []
    for item in candidates:
        if include_outside or item.get("in_radius"):
            kept.append(item)
    kept.sort(key=lambda item: (item.get("distance_km") is None, item.get("distance_km") or 0))
    return kept


# --------------------------------------------------------------------------
# решения пользователя и слияние
# --------------------------------------------------------------------------

def load_decisions(project_id, directory=None):
    """Решения панели: { "<ключ>": {"status": "approved"|"rejected", "at": ISO} }."""
    path = (Path(directory) if directory else CANDIDATES_DIR) / ("%s.decisions.json" % project_id)
    if not path.exists():
        return {}, path
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}, path
    return (data if isinstance(data, dict) else {}), path


def load_existing(project_id, directory=None):
    path = (Path(directory) if directory else CANDIDATES_DIR) / ("%s.json" % project_id)
    if not path.exists():
        return {}, path
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}, path
    items = data.get("candidates") if isinstance(data, dict) else data
    return {item["key"]: item for item in (items or []) if isinstance(item, dict) and item.get("key")}, path


def decision_for(item, decisions):
    """Решение панели по кандидату: ключ — id, для совместимости ещё и key."""
    for candidate_key_value in (item.get("id"), item.get("key")):
        if candidate_key_value and candidate_key_value in decisions:
            value = decisions[candidate_key_value]
            if isinstance(value, dict):
                return value.get("status")
    return None


def merge_candidates(existing, found, decisions, max_candidates):
    """Сохраняем решения пользователя (по id), не предлагаем отклонённых повторно."""
    merged = {}
    for item in found:
        decision = decision_for(item, decisions)
        if decision == "rejected":
            item["status"] = "rejected"
            item["notes"] = list(item.get("notes") or []) + [
                "отклонён пользователем — повторно не предлагается"]
        elif decision == "approved":
            item["status"] = "approved"
            item["notes"] = list(item.get("notes") or []) + [
                "подтверждён пользователем — можно переносить в конфиг клиента"]
        merged[item.get("id") or item.get("key")] = item
    for item in existing.values():
        slot = item.get("id") or item.get("key")
        if slot in merged:
            previous = item
            if previous.get("status") in ("approved", "rejected") and not decision_for(previous, decisions):
                merged[slot]["status"] = previous["status"]
            continue
        if decision_for(item, decisions) == "rejected":
            item = dict(item)
            item["status"] = "rejected"
        merged[slot] = item
    ordered = sorted(merged.values(), key=lambda item: (item.get("status") != "approved",
                                                        item.get("status") == "rejected",
                                                        item.get("distance_km") is None,
                                                        item.get("distance_km") or 0))
    return ordered[:max_candidates] if max_candidates else ordered


def summarize(candidates, radius):
    inside = [item for item in candidates if item.get("in_radius")]
    return {
        "total": len(candidates),
        "in_radius": len(inside),
        "radius_km": radius,
        "approved": len([item for item in candidates if item.get("status") == "approved"]),
        "rejected": len([item for item in candidates if item.get("status") == "rejected"]),
        "candidate": len([item for item in candidates if item.get("status") == "candidate"]),
        "without_distance": len([item for item in candidates if item.get("distance_km") is None]),
        "without_price": len([item for item in candidates if item.get("price_per_m2") is None]),
        "class_mismatch": len([item for item in candidates if item.get("class_match") is False]),
    }


def write_candidates(project_id, payload, directory=None, backup=True):
    path = (Path(directory) if directory else CANDIDATES_DIR) / ("%s.json" % project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    before = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    if backup and path.exists():
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path.with_name(path.name + ".bak-" + stamp))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    after = hashlib.sha256(path.read_bytes()).hexdigest()
    return path, before, after


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(prog="discover_competitors.py",
                                     description="Автоподбор конкурентов в радиусе вокруг своего ЖК.")
    parser.add_argument("--project", default=None, help="id проекта (по умолчанию из настроек)")
    parser.add_argument("--settings-file", default=None, help="тонкие настройки агента")
    parser.add_argument("--radius", type=float, default=None, help="радиус, км (по умолчанию из настроек)")
    parser.add_argument("--class", dest="classes", action="append", default=None,
                        help="класс сегмента (можно несколько)")
    parser.add_argument("--search-results", default=None,
                        help="JSON со снимком поисковой выдачи (реальные результаты)")
    parser.add_argument("--no-platform-catalog", action="store_true",
                        help="не брать список ЖК из каталога площадки (по умолчанию каталог Циан включён)")
    parser.add_argument("--no-page-details", action="store_true",
                        help="не ходить на страницы ЖК за ценой и адресом (быстрее, но без ₽/м²)")
    parser.add_argument("--catalog-url", default=None,
                        help="ссылка на каталог новостроек (по умолчанию общий каталог Циан; "
                             "для района укажите окружную страницу, например "
                             "https://www.cian.ru/novostroyki-moskva-sao-045/)")
    parser.add_argument("--candidates-dir", default=None, help="каталог кандидатов (для тестов)")
    parser.add_argument("--geocache", default=None, help="файл кэша геокодирования")
    parser.add_argument("--runs-file", default=None, help="журнал прогонов (registry/runs.jsonl)")
    parser.add_argument("--allow-browser", action="store_true",
                        help="для площадок разрешить Chrome по CDP (без логина)")
    parser.add_argument("--include-outside", action="store_true", help="показать и тех, кто дальше радиуса")
    parser.add_argument("--dry-run", action="store_true", help="ничего не писать")
    parser.add_argument("--json", action="store_true", help="итог в JSON")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv)
    started = dt.datetime.now()
    watch = load_watch(args.settings_file, args.project, args.radius, args.classes)
    project_id = str(watch["project_id"])
    print("=== Автоподбор конкурентов: %s (%s) ===" % (watch.get("name") or project_id, project_id))
    print("Адрес: %s | радиус: %.1f км | класс: %s | максимум кандидатов: %d"
          % (watch.get("address") or "не задан", watch["radius_km"],
             ", ".join(watch.get("klass") or []) or "не задан", watch["max_candidates"]))

    origin = resolve_watch_coords(watch, cache_path=args.geocache,
                                  yandex_key=os.environ.get("CW_YANDEX_GEOCODER_KEY"))
    if origin.get("lat") is None:
        print("Координаты своего ЖК: НЕ ОПРЕДЕЛЕНЫ")
        print("  %s" % origin.get("warning"))
    else:
        print("Координаты своего ЖК: %.5f, %.5f (источник: %s%s)"
              % (origin["lat"], origin["lon"], origin.get("source"),
                 ", из кэша" if origin.get("cached") else ""))
        if origin.get("warning"):
            print("  ВНИМАНИЕ: %s" % origin["warning"])

    platform_attempts = discover_via_platforms(watch, allow_browser=args.allow_browser)
    print("Площадки (публичные страницы, без логина):")
    for attempt in platform_attempts:
        print("  %-16s %-18s найдено: %d %s"
              % (attempt["source"], attempt["status"], attempt["found"], (attempt["note"] or "")[:60]))

    entries = []
    search_note = ""
    if not args.no_platform_catalog and "cian" in (watch.get("sources") or []):
        try:
            catalog, catalog_info = platforms.cian_catalog_entries(
                args.catalog_url or platforms.PLATFORM_SEARCH_URLS.get("cian"))
        except Exception as exc:
            catalog, catalog_info = [], {"status": "error", "note": "каталог Циан недоступен: %s" % exc}
        if catalog:
            entries.extend(catalog)
        search_note = "каталог Циан (HTTP, без логина): %s" % catalog_info["note"]
        print("Каталог Циан: %s" % catalog_info["note"])
    if args.search_results:
        extra = load_search_results(args.search_results)
        entries.extend(extra)
        search_note += "; снимок выдачи %s (%d записей)" % (Path(args.search_results).name, len(extra))
    elif os.environ.get("CW_SEARCH_ENDPOINT"):
        search_note = "веб-поиск: внешний эндпоинт %s" % os.environ["CW_SEARCH_ENDPOINT"]
        try:
            entries = load_search_results_url(os.environ["CW_SEARCH_ENDPOINT"])
        except Exception as exc:
            search_note += " — не ответил: %s" % exc
    else:
        search_note = ("веб-поиск не настроен (нужен --search-results или CW_SEARCH_ENDPOINT) — "
                       "поиск по району пропущен, данных нет")
    print(search_note)

    found = build_candidates(entries, watch, origin, geocode_cache_path=args.geocache,
                             polite_delay=1.0, fetch_pages=not args.no_page_details)
    decisions, decisions_path = load_decisions(project_id, args.candidates_dir)
    existing, existing_path = load_existing(project_id, args.candidates_dir)
    merged = merge_candidates(existing, found, decisions, watch["max_candidates"])
    visible = [item for item in merged if args.include_outside or item.get("in_radius")
               or item.get("status") in ("approved", "rejected")]
    summary = summarize(merged, watch["radius_km"])

    limitations = []
    if origin.get("warning"):
        limitations.append(origin["warning"])
    blocked = [attempt for attempt in platform_attempts if attempt["status"] != "ok"]
    if blocked:
        limitations.append("площадки без публичных данных: %s"
                           % ", ".join("%s (%s)" % (item["source"], item["status"]) for item in blocked))
    if not args.search_results and not os.environ.get("CW_SEARCH_ENDPOINT"):
        limitations.append("веб-поиск не выполнялся: нет доступа к поисковому сервису")
    if summary["without_distance"]:
        limitations.append("без расстояния: %d (нет координат — данных нет)" % summary["without_distance"])
    if summary["without_price"]:
        limitations.append("без цены за м²: %d (на публичной странице цены нет)"
                           % summary["without_price"])

    payload = {
        "project_id": project_id,
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "watch": {"name": watch.get("name"), "address": watch.get("address"), "url": watch.get("url"),
                  "lat": origin.get("lat"), "lon": origin.get("lon"),
                  "geocode_source": origin.get("source"), "geocode_warning": origin.get("warning") or ""},
        "radius_km": watch["radius_km"],
        "segment": {"classes": watch.get("klass") or [],
                    "price_per_m2_range": [watch.get("price_min_per_m2"), watch.get("price_max_per_m2")]},
        "decisions_file": str(decisions_path),
        "platform_attempts": platform_attempts,
        "search": search_note,
        "summary": summary,
        "limitations": limitations,
        "candidates": visible,
    }

    print("")
    print("Кандидаты в радиусе %.1f км: %d из %d найденных"
          % (watch["radius_km"], summary["in_radius"], summary["total"]))
    for item in visible[:12]:
        distance = "—" if item.get("distance_km") is None else "%.2f км" % item["distance_km"]
        price = "—" if item.get("price_per_m2") is None else "%s ₽/м²" % cw.fmt_int(item["price_per_m2"])
        print("  %-28s %-10s %-12s %-14s %s %s"
              % (item["name"][:28], item.get("class") or "—", distance, price, item["status"],
                 ("; ".join(item.get("notes") or []))[:60]))
    if limitations:
        print("Ограничения:")
        for item in limitations:
            print("  - %s" % item)

    path = existing_path
    before = after = None
    if not args.dry_run:
        path, before, after = write_candidates(project_id, payload, args.candidates_dir)
        duration_ms = int((dt.datetime.now() - started).total_seconds() * 1000)
        runs_file = Path(args.runs_file) if args.runs_file else RUNS_FILE
        runs_file.parent.mkdir(parents=True, exist_ok=True)
        record = {"run_id": "run-%s" % hashlib.sha1(("%s-discovery-%s" % (project_id, started)).encode())
                                                    .hexdigest()[:8],
                  "ts": dt.datetime.now().astimezone().isoformat(timespec="milliseconds"),
                  "service": SERVICE, "kind": RUN_KIND, "client": None, "agent": AGENT,
                  "status": "ok", "duration_ms": duration_ms, "cost_rub": 0.0,
                  "artifact": str(path), "error": None,
                  "sha256_before": before, "sha256_after": after,
                  "found": summary["in_radius"]}
        with open(runs_file, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        print("Кандидаты записаны: %s" % path)
        print("Прогон записан в %s (вид: %s, sha256 %s -> %s)"
              % (runs_file, RUN_KIND, (before or "нет")[:12], after[:12]))
    else:
        print("--dry-run: файлы не изменялись (кандидаты: %s)" % path)
    if args.json:
        print(json.dumps({key: payload[key] for key in ("project_id", "radius_km", "summary", "limitations")},
                         ensure_ascii=False, indent=2))
    return 0


def load_search_results_url(url):
    return list(_http_json(url).get("results") or [])


if __name__ == "__main__":
    sys.exit(main())
