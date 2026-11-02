#!/usr/bin/env python3
r"""competitor_profile.py - расширенный профиль конкурента (метрики + аналитика).

Собирает по каждому конкуренту метрики с полями «значение · единица · источник · дата · метод ·
точность · комментарий» и складывает их в
    data/clients/<client-id>/competitor-profiles/<project>.json
    data/clients/<client-id>/competitor-profiles/_summary.json

Источники и честность (см. docs/agent1-competitor-metrics.md):
  * лоты, цены, акции, комнатность — публичные страницы площадок БЕЗ логина (method: http|dom);
  * Росреестр/ЕИСЖС — пробуем обычный HTTP, затем Chrome по CDP; если недоступно, пишем
    «источник недоступен» и НИКОГДА не подменяем своими цифрами;
  * продажи по уходу лотов между неделями — method: estimate (это оценка, а не данные Росреестра);
  * производные метрики (§3 документа) — по накопленной истории снимков; если истории мало,
    честно пишем «нужно N недель наблюдений».

Usage:
    python competitor_profile.py --client client-svet --candidates data/candidates/my-zhk-svet.json
    python competitor_profile.py --project my-zhk-svet --limit 3 --no-browser
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import statistics
import sys
from pathlib import Path

import cwlib as cw
import clients as clients_mod
import developer_site as dev_site
import platforms
import discover_competitors as discovery

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
CANDIDATES_DIR = WATCH_DIR / "data" / "candidates"
PROFILES_SUBDIR = "competitor-profiles"
ROSREESTR_URLS = {
    "наш.дом.рф (ЕИСЖС)": "https://xn--80asehdb.xn--p1ai/",   # punycode: кириллический домен
    "росреестр": "https://rosreestr.gov.ru/",
}
# ЕИСЖС может сообщать «Сайт отключён» — это состояние источника, а не сбой парсера.
SOURCE_DISABLED_MARKERS = ("сайт отключ", "отключен", "отключён", "site is disabled",
                           "сайт недоступен", "сервис недоступен", "технические работы")
SOURCE_CACHE_FILE = "source-status.json"
DAILY_CACHE_SECONDS = 24 * 60 * 60
# Метки самой площадки — это не акция застройщика.
PLATFORM_PROMO_NOISE = ("только на циан", "циан", "cian", "подать объявление")
# признаки СОСТОЯНИЯ лота (а не кнопки «забронировать»)
RESERVED_MARKERS = ("забронирован", "забронировано", "в брони", "под бронью", "reserved")
SOLD_MARKERS = ("продано", "продана", "продана ", "sold")
ROOM_LABELS = (("студии", (0,)), ("1", (1,)), ("2", (2,)), ("3", (3,)), ("4+", (4, 5, 6)))
MIN_WEEKS_FOR_DYNAMICS = 2
SALES_HORIZON_WEEKS = 12


def setup_console():
    cw.setup_console()


def metric(value, unit="", source="", method="", accuracy="", comment="", collected_at=None):
    """Одна метрика: значение + источник + дата + метод + точность + комментарий."""
    if value is None:
        return {"value": None, "unit": unit, "source": source or "",
                "collected_at": collected_at, "method": method or "none", "accuracy": "",
                "comment": comment or "данных нет"}
    return {"value": value, "unit": unit, "source": source, "collected_at": collected_at,
            "method": method or "http", "accuracy": accuracy, "comment": comment or ""}


# --------------------------------------------------------------------------
# лоты со страницы площадки
# --------------------------------------------------------------------------

def lot_status(card_text):
    lowered = str(card_text or "").lower()
    if any(marker in lowered for marker in RESERVED_MARKERS):
        return "reserved"
    if any(marker in lowered for marker in SOLD_MARKERS):
        return "sold"
    return "active"


def lots_from_page(url, platform="cian", expect_name=None):
    """Лоты со страницы ЖК: значения + источник + метод. Без логина."""
    collected_at = dt.date.today().isoformat()
    try:
        status, html, error = platforms.http_fetch(url)
    except Exception as exc:
        return None, "HTTP не удался: %s" % exc
    if status != 200 or not html:
        return None, "HTTP %s" % status
    if expect_name and not platforms.mentions_name(html, expect_name):
        return None, "страница не упоминает «%s»" % expect_name
    parsed = platforms.parse_page(html, platform, url)
    lots = parsed.get("lots") or []
    for lot in lots:
        lot["status"] = lot_status(lot.get("title") or "")
    # помечает ли источник бронь/продажу вообще: если нет — это отсутствие данных, а не ноль
    page_text = platforms.visible_text(html).lower()
    markers = {"reserved": any(marker in page_text for marker in RESERVED_MARKERS),
               "sold": any(marker in page_text for marker in SOLD_MARKERS)}
    promo_counter = re.search(r"(\d{1,3})\s+акци", page_text)
    markers["promo_counter"] = int(promo_counter.group(1)) if promo_counter else None
    return {"lots": lots, "collected_at": collected_at, "method": "http",
            "granularity": parsed.get("granularity"), "url": url,
            "page_size": len(html), "markers": markers}, ""


def price_stats(lots, markers=None):
    prices = [lot["price_rub"] for lot in lots if lot.get("price_rub")]
    ppm2 = [lot["price_rub"] / lot["area_m2"] for lot in lots
            if lot.get("price_rub") and lot.get("area_m2")]
    areas = [lot["area_m2"] for lot in lots if lot.get("area_m2")]
    return {
        "count": len(lots),
        "prices": {"min": min(prices) if prices else None,
                   "median": cw.median_rounded(prices), "max": max(prices) if prices else None},
        "ppm2": {"min": int(round(min(ppm2))) if ppm2 else None,
                 "median": cw.median_rounded(ppm2),
                 "max": int(round(max(ppm2))) if ppm2 else None},
        "areas": {"average": round(sum(areas) / len(areas), 1) if areas else None,
                  "median": cw.median_rounded(areas)},
        "by_rooms": by_rooms(lots),
        "promos": promos(lots),
        # None = источник бронь не помечает вообще (отсутствие данных), 0 = помечает, но брони нет
        "reserved": (len([lot for lot in lots
                          if (lot.get("status") or lot_status(lot.get("title"))) == "reserved"])
                     if (markers or {}).get("reserved", True) else None),
        "sold_marked": (len([lot for lot in lots
                             if (lot.get("status") or lot_status(lot.get("title"))) == "sold"])
                        if (markers or {}).get("sold", True) else None),
        "with_price": len(prices),
        "with_area": len(areas),
    }


def by_rooms(lots):
    result = {}
    for label, values in ROOM_LABELS:
        bucket = [lot for lot in lots if cw.to_int(lot.get("rooms")) in values]
        ppm2 = [lot["price_rub"] / lot["area_m2"] for lot in bucket
                if lot.get("price_rub") and lot.get("area_m2")]
        prices = [lot["price_rub"] for lot in bucket if lot.get("price_rub")]
        result[label] = {"count": len(bucket),
                         "median_price": cw.median_rounded(prices),
                         "median_price_per_m2": cw.median_rounded(ppm2),
                         "median_area": cw.median_rounded([lot["area_m2"] for lot in bucket
                                                           if lot.get("area_m2")])}
    return result


def developer_promo_text(text):
    """Текст акции застройщика: чистим мусор вёрстки и маркетинговые метки площадки."""
    return platforms.clean_promo_text(text)


def promos(lots):
    texts = []
    count = 0
    for lot in lots:
        text = developer_promo_text(lot.get("promo_text"))
        if not text:
            continue
        count += 1
        if text not in texts:
            texts.append(text)
    return {"count": count, "texts": texts[:5]}


def corpi_from_site(url, expect_name=None):
    """Корпуса с сайта застройщика: ищем публичные упоминания корпусов/очередей."""
    try:
        status, html, error = platforms.http_fetch(url)
    except Exception as exc:
        return None, "сайт недоступен: %s" % exc
    if status != 200 or not html:
        return None, "HTTP %s" % status
    text = platforms.visible_text(html)
    found = sorted({match.group(0) for match in
                    re.finditer(r"(?:Корпус|корпус|очеред[ьи])\s*[№#]?\s*[0-9]{1,2}", text)})
    delivery = sorted({match.group(0) for match in re.finditer(r"20[2-9][0-9]\s*(?:год|г\.)", text)})
    return {"corpi": found[:10], "deliveries": delivery[:5], "page_size": len(html)}, ""


# --------------------------------------------------------------------------
# история снимков: динамика и косвенные продажи
# --------------------------------------------------------------------------

def load_history(snapshots_dir, project=None):
    """История лотов по недельным снимкам клиента."""
    base = Path(snapshots_dir)
    if not base.is_dir():
        return []
    history = []
    for date_dir in sorted(entry for entry in base.iterdir()
                           if entry.is_dir() and cw.DATE_RE.match(entry.name)):
        path = date_dir / "lots.csv"
        if not path.exists():
            continue
        rows = cw.load_snapshot_rows(path)
        if project:
            rows = [row for row in rows if str(row.get("project") or "") == str(project)]
        history.append({"date": date_dir.name, "rows": rows,
                        "keys": {cw.lot_key(row) for row in rows}})
    return history


def history_metrics(history):
    """Метрики по истории: уход лотов (оценка продаж), предложение, цена входа, акции."""
    if len(history) < MIN_WEEKS_FOR_DYNAMICS:
        return {"weeks": len(history), "needed": MIN_WEEKS_FOR_DYNAMICS, "available": False}
    first, last = history[0], history[-1]
    gone_total = 0
    weekly_gone = []
    for previous, current in zip(history, history[1:]):
        gone = len(previous["keys"] - current["keys"])
        weekly_gone.append(gone)
        gone_total += gone
    entry_first = min((row.get("price_rub") for row in first["rows"] if row.get("price_rub")),
                      default=None)
    entry_last = min((row.get("price_rub") for row in last["rows"] if row.get("price_rub")),
                     default=None)
    supply = [len(item["keys"]) for item in history]
    promo_weeks = sum(1 for item in history
                      if any(str(row.get("promo_flag") or "") == "1" for row in item["rows"]))
    return {
        "weeks": len(history), "available": True,
        "first_date": first["date"], "last_date": last["date"],
        "gone_total": gone_total,
        "gone_per_week": round(sum(weekly_gone) / len(weekly_gone), 2) if weekly_gone else None,
        "supply_first": supply[0], "supply_last": supply[-1],
        "supply_change": supply[-1] - supply[0],
        "entry_price_first": entry_first, "entry_price_last": entry_last,
        "promo_weeks": promo_weeks,
    }


def derived_metrics(history_metrics_result, stats, district_median_ppm2=None, our_price=None):
    """Расчёты из §3 документа. Всё, что требует истории, честно помечается."""
    result = {}
    if not history_metrics_result or not history_metrics_result.get("available"):
        weeks = (history_metrics_result or {}).get("weeks", 0)
        needed = (history_metrics_result or {}).get("needed", MIN_WEEKS_FOR_DYNAMICS)
        note = "нужно минимум %d недели наблюдений (накоплено %d)" % (needed, weeks)
        for key in ("sales_speed_per_week", "absorption_rate", "months_to_sell_out",
                    "entry_price_dynamics_pct", "supply_dynamics_pct", "promo_pressure_weeks"):
            result[key] = metric(None, comment=note, method="estimate")
    else:
        speed = history_metrics_result.get("gone_per_week")
        result["sales_speed_per_week"] = metric(
            speed, "лотов/нед", "наш недельный мониторинг", "estimate", "низкая",
            "оценка по уходу лотов из продажи, не данные Росреестра")
        sold = history_metrics_result.get("gone_total") or 0
        offer = stats["count"] if stats else None
        total = (sold + offer) if (offer is not None) else None
        result["absorption_rate"] = metric(
            round(sold / total * 100, 1) if total else None, "%", "наш недельный мониторинг",
            "estimate", "низкая", "доля ушедших лотов от (ушедшие + текущее предложение)")
        if speed and offer:
            result["months_to_sell_out"] = metric(
                round(offer / speed / 4.33, 1) if speed else None, "мес", "расчёт",
                "estimate", "низкая", "при текущем темпе ухода лотов")
        else:
            result["months_to_sell_out"] = metric(None, "мес", "расчёт", "estimate",
                                                  comment="нет скорости продаж или предложения")
        entry_first = history_metrics_result.get("entry_price_first")
        entry_last = history_metrics_result.get("entry_price_last")
        delta = cw.delta_pct(entry_first, entry_last)
        result["entry_price_dynamics_pct"] = metric(
            round(delta, 2) if delta is not None else None, "%", "наш недельный мониторинг",
            "estimate", "средняя", "минимальная цена входа")
        supply_first = history_metrics_result.get("supply_first")
        supply_last = history_metrics_result.get("supply_last")
        supply_delta = cw.delta_pct(supply_first, supply_last)
        result["supply_dynamics_pct"] = metric(
            round(supply_delta, 2) if supply_delta is not None else None, "%",
            "наш недельный мониторинг", "estimate", "средняя", "изменение числа лотов в продаже")
        result["promo_pressure_weeks"] = metric(
            history_metrics_result.get("promo_weeks"), "нед", "наш недельный мониторинг",
            "estimate", "средняя", "сколько недель подряд идут акции")
    median_ppm2 = (stats or {}).get("ppm2", {}).get("median")
    if median_ppm2 and district_median_ppm2:
        result["price_index_vs_district"] = metric(
            round(median_ppm2 / district_median_ppm2, 3), "×", "расчёт по нашим данным", "estimate",
            "средняя", "медиана ₽/м² конкурента к медиане района")
    else:
        result["price_index_vs_district"] = metric(
            None, "×", "расчёт по нашим данным", "estimate",
            comment="нет медианы ₽/м² конкурента или района")
    if median_ppm2 and our_price:
        result["gap_price_vs_us_pct"] = metric(
            round((median_ppm2 - our_price) / our_price * 100, 2), "%", "расчёт", "estimate",
            "средняя", "разрыв: медиана конкурента против нашей цены входа (%s ₽/м²)"
                       % cw.fmt_int(our_price))
    else:
        result["gap_price_vs_us_pct"] = metric(None, "%", "расчёт", "estimate",
                                               comment="нет нашей цены для сравнения")
    return result


def risk_flags(history_metrics_result, derived):
    flags = []
    supply = derived.get("supply_dynamics_pct", {}).get("value")
    if supply is not None and supply >= 20:
        flags.append({"code": "supply_surge", "level": "warning",
                      "comment": "резкий рост предложения конкурента: %+.1f%%" % supply})
    entry = derived.get("entry_price_dynamics_pct", {}).get("value")
    if entry is not None and entry <= -5:
        flags.append({"code": "price_drop", "level": "critical",
                      "comment": "сброс цены входа: %+.1f%%" % entry})
    promos = derived.get("promo_pressure_weeks", {}).get("value")
    if promos is not None and promos >= MIN_WEEKS_FOR_DYNAMICS:
        flags.append({"code": "promo_pressure", "level": "warning",
                      "comment": "акции идут %d недель подряд" % promos})
    if not flags and history_metrics_result and not history_metrics_result.get("available"):
        flags.append({"code": "no_history", "level": "info",
                      "comment": "истории мало: динамика и риски появятся после %d недель"
                                 % MIN_WEEKS_FOR_DYNAMICS})
    return flags


# --------------------------------------------------------------------------
# Росреестр / ЕИСЖС: честная попытка
# --------------------------------------------------------------------------

def source_note(entry):
    """Человекочитаемая причина по источнику: что именно произошло."""
    verdict = entry.get("verdict")
    browser = entry.get("browser") or {}
    http = entry.get("http") or {}
    if verdict == "ok":
        transport = browser.get("transport") if browser.get("bytes") else "http"
        return "страница открылась (%s), обычный HTTP был заблокирован: %s" % (
            transport or "http", (http.get("error") or "HTTP %s" % http.get("status") or "")[:60])
    if verdict == "error_page":
        return "Chrome отдал страницу ошибки сертификата — это не данные"
    if verdict == "disabled":
        return "источник сам сообщает, что отключён"
    return (browser.get("error") or http.get("error") or "источник не ответил")[:120]


def load_source_cache(cache_path):
    if cache_path and Path(cache_path).exists():
        try:
            return json.loads(Path(cache_path).read_text(encoding="utf-8-sig"))
        except Exception:
            return {}
    return {}


def save_source_cache(cache_path, cache):
    if not cache_path:
        return
    path = Path(cache_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def rosreestr_status(allow_browser=False, port=9344, wait_ms=8000, cache_path=None,
                     use_cache=True, ignore_cert_errors=True, max_requests=4):
    """Честный статус официальных источников: HTTP, затем Chrome (чистый профиль, без логина).

    Chrome на ошибке сертификата отдаёт СВОЮ страницу — её нельзя принимать за данные;
    ЕИСЖС может ответить «Сайт отключён» — это состояние источника, а не наш сбой.
    Режим вежливый: кэш на сутки и лимит обращений за прогон.
    """
    cache = load_source_cache(cache_path) if use_cache else {}
    cached = cache.get("official_sources")
    if cached:
        age = dt.datetime.now().timestamp() - float(cached.get("checked_ts") or 0)
        if age < DAILY_CACHE_SECONDS:
            summary = dict(cached.get("summary") or {})
            summary["from_cache"] = True
            summary["cache_age_hours"] = round(age / 3600, 1)
            return None, cached.get("attempts", []), summary

    attempts = []
    requests_made = 0
    process = profile = None
    try:
        for name, url in ROSREESTR_URLS.items():
            entry = {"source": name, "url": url, "http": None, "browser": None, "verdict": ""}
            html = ""
            if requests_made < max_requests:
                requests_made += 1
                try:
                    status, body, error = platforms.http_fetch(url, timeout=20)
                    entry["http"] = {"status": status, "bytes": len(body or ""), "error": error}
                    if status == 200 and body and not platforms.is_chrome_error_page(body):
                        html = body
                except Exception as exc:
                    entry["http"] = {"status": None, "error": str(exc)}
            if not html and allow_browser and requests_made < max_requests:
                requests_made += 1
                try:
                    if process is None:
                        process, profile = platforms.launch_chrome(
                            port=port, headless=True, ignore_cert_errors=ignore_cert_errors)
                    body = platforms.cdp_html(url, port=port, wait_ms=wait_ms)
                    entry["browser"] = {"bytes": len(body or ""),
                                        "transport": "chrome-cdp-no-login-headless",
                                        "ignore_cert_errors": bool(ignore_cert_errors)}
                    if body and platforms.is_chrome_error_page(body):
                        entry["browser"]["note"] = "Chrome отдал страницу ошибки сертификата — это не данные"
                        entry["verdict"] = "error_page"
                    else:
                        html = body
                except Exception as exc:
                    entry["browser"] = {"error": str(exc)[:200]}
            if html and not entry["verdict"]:
                lowered = html.lower()
                entry["verdict"] = "disabled" if any(marker in lowered
                                                     for marker in SOURCE_DISABLED_MARKERS) else "ok"
            entry["verdict"] = entry["verdict"] or "unreachable"
            attempts.append(entry)
    finally:
        platforms.stop_chrome(process, profile)

    reachable = [entry["source"] for entry in attempts if entry.get("verdict") == "ok"]
    disabled = [entry["source"] for entry in attempts if entry.get("verdict") == "disabled"]
    error_pages = [entry["source"] for entry in attempts if entry.get("verdict") == "error_page"]
    # "не получилось" — это ошибка сертификата/недоступность, но не «источник сам отключён»
    failed = [entry["source"] for entry in attempts
              if entry.get("verdict") not in ("ok", "disabled")]
    if reachable and not failed:
        status_text = "получилось"
    elif reachable:
        status_text = "частично доступен"
    elif disabled and not failed:
        status_text = "источник отключён"
    elif disabled:
        status_text = "источник отключён (частично)"
    else:
        status_text = "источник недоступен"
    parts = []
    if disabled:
        parts.append("источник сам сообщает, что отключён: %s" % ", ".join(disabled))
    if reachable:
        parts.append("страница открывается через браузер без логина: %s" % ", ".join(reachable))
    if error_pages:
        parts.append("Chrome отдал страницу ошибки сертификата: %s" % ", ".join(error_pages))
    result = {"status": status_text, "detail": "; ".join(parts) or "источники недоступны (TLS/фильтр)",
              "reachable_via_browser": reachable, "disabled": disabled, "attempts": attempts,
              "per_source": [{"source": entry["source"], "verdict": entry.get("verdict"),
                              "note": source_note(entry)} for entry in attempts],
              "requests_made": requests_made, "checked_at": dt.date.today().isoformat(),
              "from_cache": False}
    if use_cache and cache_path:
        cache["official_sources"] = {"checked_ts": dt.datetime.now().timestamp(),
                                     "attempts": attempts, "summary": result}
        save_source_cache(cache_path, cache)
    return ({"source": reachable[0]} if reachable else None), attempts, result


# --------------------------------------------------------------------------
# ЕИСЖС: корпуса, квартиры, ДДУ (официальные данные)
# --------------------------------------------------------------------------

EISZHS_CARD_MARKERS = ('"houses"', '"buildings"', '"objects"', '"flatsCount"', '"dduCount"',
                       '"apartments"', '"contracts"', 'objectType":"JK')
CORPUS_DONE_MARKERS = ("введен", "введён", "введена", "эксплуатац", "построен", "сдан", "completed")
CORPUS_BUILD_MARKERS = ("строит", "возвед", "монтаж", "construction", "building")


def normalize_name(value):
    text = str(value or "").lower()
    text = re.sub(r"[«»\"()]", " ", text)
    text = re.sub(r"\bжк\b|жилой комплекс", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_eiszhs_card(html):
    """Достать из карточки ЕИСЖС корпуса, квартиры и ДДУ. Ключи ищем по нескольким вариантам."""
    blobs, seen = [], set()
    for marker in EISZHS_CARD_MARKERS:
        # для вложенных структур берём самый внешний объект, иначе находим внутренний
        for blob in (platforms.extract_enclosing_json(html, marker) +
                     platforms.extract_json_objects(html, marker)):
            key = json.dumps(blob, ensure_ascii=False, sort_keys=True)[:400]
            if key in seen:
                continue
            seen.add(key)
            blobs.append(blob)
    # вложенные объекты не нужны: их данные уже есть внутри внешнего
    serialized = [json.dumps(blob, ensure_ascii=False) for blob in blobs]
    blobs = [blob for index, blob in enumerate(blobs)
             if not any(index != other and serialized[index] in serialized[other]
                        for other in range(len(blobs)))]
    corpi, flats_total, ddu_registered = [], None, None
    for blob in blobs:
        stack = [blob]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                for key, value in node.items():
                    lowered = str(key).lower()
                    if isinstance(value, list) and lowered in ("houses", "buildings", "objects",
                                                               "corpi", "corpus"):
                        for item in value:
                            if isinstance(item, dict):
                                corpi.append(item)
                    if isinstance(value, (int, float)):
                        if lowered in ("flatscount", "flats", "apartmentscount", "apartments",
                                       "totalflats", "flatsnumber"):
                            flats_total = flats_total or int(value)
                        elif lowered in ("dducount", "ddu", "contractscount", "contracts",
                                         "dduregistered"):
                            ddu_registered = ddu_registered or int(value)
                    if isinstance(value, (dict, list)):
                        stack.append(value)
    normalized = []
    for item in corpi:
        text = json.dumps(item, ensure_ascii=False).lower()
        state = "built" if any(marker in text for marker in CORPUS_DONE_MARKERS) else (
            "under_construction" if any(marker in text for marker in CORPUS_BUILD_MARKERS) else "unknown")
        address = ""
        end_date = None
        readiness = None
        for key, value in item.items():
            lowered = str(key).lower()
            if lowered in ("address", "addr", "location") and isinstance(value, str):
                address = value
            elif lowered in ("enddate", "completiondate", "deliverydate", "finishdate", "end_date"):
                end_date = str(value)[:10]
            elif lowered in ("readiness", "percent", "progress", "readypercent"):
                readiness = value
        normalized.append({"address": address, "state": state, "end_date": end_date,
                           "readiness": readiness, "raw_keys": sorted(item.keys())[:8]})
    unique, seen_corpi = [], set()
    for item in normalized:
        key = (item.get("address") or "", item.get("end_date") or "", item.get("state") or "")
        if key in seen_corpi:
            continue
        seen_corpi.add(key)
        unique.append(item)
    normalized = unique
    return {"corpi": normalized, "flats_total": flats_total, "ddu_registered": ddu_registered,
            "blobs_found": len(blobs)}


def match_eiszhs_project(cards, name, developer="", address=""):
    """Сопоставление нашего ЖК с карточкой ЕИСЖС: по названию (+застройщик/адрес).

    При неоднозначности — «требует подтверждения» (не угадываем).
    """
    wanted = normalize_name(name)
    if not wanted:
        return None, "не найдено", "нет названия проекта для сопоставления"
    strong, weak = [], []
    for card in cards:
        card_name = normalize_name(card.get("name") or card.get("title") or "")
        if not card_name:
            continue
        if card_name == wanted:
            strong.append(card)
        elif wanted in card_name or card_name in wanted:
            weak.append(card)
    if len(strong) == 1:
        return strong[0], "подтверждено", "точное совпадение названия"
    if len(strong) > 1:
        return None, "требует подтверждения", ("найдено %d карточек с таким названием — "
                                               "нужно подтвердить связь" % len(strong))
    if len(weak) == 1:
        return weak[0], "требует подтверждения", ("совпадение по части названия (%s) — "
                                                  "просим подтвердить" % (weak[0].get("name") or ""))
    if len(weak) > 1:
        return None, "требует подтверждения", ("найдено %d похожих карточек — нужно подтвердить "
                                               "связь" % len(weak))
    return None, "не найдено", "карточка проекта в ЕИСЖС не найдена"


def eiszhs_metrics(source_status, project, cards=None, match_note=""):
    """Метрики ЕИСЖС для профиля. Нет данных — null с причиной, без выдуманных чисел."""
    collected = dt.date.today().isoformat()
    status_text = (source_status or {}).get("status") or "не проверялся"
    reason = ("ЕИСЖС (наш.дом.рф): %s — %s" % (status_text, (source_status or {}).get("detail") or ""))[:220]
    keys = {"corpi_total": "корпусов всего", "corpi_built": "корпусов введено",
            "corpi_under_construction": "корпусов строится", "flats_total": "квартир в проекте",
            "ddu_registered": "ДДУ зарегистрировано"}
    if cards is None:
        return {key: metric(None, unit, "ЕИСЖС (наш.дом.рф)", "dom",
                            comment="официальные данные получить нельзя: %s" % reason)
                for key, unit in keys.items()}
    built = len([item for item in cards["corpi"] if item["state"] == "built"])
    building = len([item for item in cards["corpi"] if item["state"] == "under_construction"])
    unknown = len(cards["corpi"]) - built - building
    note = ("сопоставление проекта: %s" % (match_note or "подтверждено")) if match_note else ""
    return {
        "corpi_total": metric(len(cards["corpi"]), keys["corpi_total"], "ЕИСЖС (наш.дом.рф)", "dom",
                              "высокая", note),
        "corpi_built": metric(built, keys["corpi_built"], "ЕИСЖС (наш.дом.рф)", "dom", "высокая",
                              note + ("; стадия не определена у %d" % unknown if unknown else "")),
        "corpi_under_construction": metric(building, keys["corpi_under_construction"],
                                           "ЕИСЖС (наш.дом.рф)", "dom", "высокая", note),
        "flats_total": metric(cards["flats_total"], keys["flats_total"], "ЕИСЖС (наш.дом.рф)", "dom",
                              "высокая", note or "количество квартир из карточки проекта"),
        "ddu_registered": metric(cards["ddu_registered"], keys["ddu_registered"],
                                 "ЕИСЖС (наш.дом.рф)", "dom", "высокая",
                                 note or "зарегистрированные ДДУ (срез — дата сбора)"),
    }


def official_absorption(metrics):
    """Официальная доля проданного = ДДУ / всего квартир."""
    ddu = (metrics.get("ddu_registered") or {}).get("value")
    flats = (metrics.get("flats_total") or {}).get("value")
    if ddu is None or not flats:
        missing = "ДДУ" if ddu is None else "количество квартир"
        return metric(None, "%", "ЕИСЖС (наш.дом.рф)", "estimate",
                      comment="официальная доля проданного не считается: нет данных (%s)" % missing)
    return metric(round(ddu / flats * 100, 1), "%", "ЕИСЖС (наш.дом.рф)", "estimate", "высокая",
                  "ДДУ / всего квартир (официальные данные)")


# --------------------------------------------------------------------------
# профиль
# --------------------------------------------------------------------------

def build_profile(project, url, source_platform="cian", history_dir=None, district_median_ppm2=None,
                  our_price=None, allow_browser=False, site_url=None, eiszhs_status=None,
                  eiszhs_cards=None, eiszhs_match_note="", developer_site_url=None,
                  developer_site_data=None):
    collected_at = dt.date.today().isoformat()
    page, error = lots_from_page(url, source_platform, expect_name=project)
    profile = {"project": project, "source_url": url, "source_platform": source_platform,
               "collected_at": collected_at, "metrics": {}, "derived": {}, "risk_flags": [],
               "limitations": []}
    stats = None
    if page is None:
        profile["limitations"].append("страница конкурента недоступна: %s" % error)
        for key in ("lots_in_sale", "price_min_rub", "price_median_rub", "price_max_rub",
                    "price_per_m2_median", "average_area_m2", "reserved_lots", "promo_count"):
            profile["metrics"][key] = metric(None, comment="источник недоступен: %s" % error)
    else:
        stats = price_stats(page["lots"])
        source_label = "%s (%s)" % (source_platform, url)
        profile["metrics"]["lots_in_sale"] = metric(stats["count"], "лотов", source_label, "http",
                                                   "высокая", "лоты на публичной странице проекта")
        profile["metrics"]["price_min_rub"] = metric(stats["prices"]["min"], "₽", source_label, "http")
        profile["metrics"]["price_median_rub"] = metric(stats["prices"]["median"], "₽", source_label, "http")
        profile["metrics"]["price_max_rub"] = metric(stats["prices"]["max"], "₽", source_label, "http")
        profile["metrics"]["price_per_m2_median"] = metric(stats["ppm2"]["median"], "₽/м²",
                                                           source_label, "http")
        profile["metrics"]["average_area_m2"] = metric(stats["areas"]["average"], "м²", source_label, "http")
        profile["metrics"]["median_area_m2"] = metric(stats["areas"]["median"], "м²", source_label, "http")
        if stats["reserved"] is None:
            profile["metrics"]["reserved_lots"] = metric(
                None, "лотов", source_label, "http", "средняя",
                "источник бронь не помечает — данных нет (это не ноль)")
            profile["limitations"].append("брони: источник не помечает бронь — данных нет")
        else:
            profile["metrics"]["reserved_lots"] = metric(
                stats["reserved"], "лотов", source_label, "http", "средняя",
                "источник помечает бронь: помечено %d лотов" % stats["reserved"]
                if stats["reserved"] else
                "источник помечает бронь, но ни один лот не отмечен забронированным (реальный ноль)")
        promo_counter = (page.get("markers") or {}).get("promo_counter")
        if stats["promos"]["count"]:
            profile["metrics"]["promo_count"] = metric(
                stats["promos"]["count"], "лотов с акцией", source_label, "http", "средняя",
                "; ".join(stats["promos"]["texts"][:3]))
        else:
            # текстов акций нет: это отсутствие данных, а не ноль акций
            profile["metrics"]["promo_count"] = metric(
                None, "лотов с акцией", source_label, "http",
                comment=("тексты акций на странице не раскрыты (видна ссылка «%d акций»)"
                         % promo_counter) if promo_counter else
                        (page.get("markers") or {}).get("promo_note") or
                        "акций и промо на странице нет — данных нет")
        profile["by_rooms"] = stats["by_rooms"]
    if site_url:
        corpi, corpi_error = corpi_from_site(site_url)
        if corpi:
            profile["metrics"]["corpi_found"] = metric(len(corpi["corpi"]), "корпусов",
                                                       "сайт застройщика (%s)" % site_url, "http",
                                                       "средняя", "; ".join(corpi["corpi"][:4]))
            profile["corpi"] = corpi
        else:
            profile["metrics"]["corpi_found"] = metric(
                None, "корпусов", "сайт застройщика", "http",
                comment="на сайте не нашлось публичного раздела корпусов: %s" % corpi_error)
    # сайт застройщика: корпуса, шахматка, акции (источник НЕ Росреестр)
    if developer_site_data is None and developer_site_url:
        developer_site_data = dev_site.collect(
            developer_site_url, allow_browser=allow_browser, headless=True,
            ignore_cert=bool(os.environ.get("CW_DEV_SITE_IGNORE_CERT")))
    if developer_site_data is not None:
        site_metrics = dev_site.site_metrics(developer_site_data)
        profile["metrics"].update(site_metrics)
        profile["derived"]["sold_share_developer_pct"] = dev_site.sold_share_from_site(site_metrics)
        profile["developer_site"] = {"url": developer_site_data.get("url"),
                                     "method": developer_site_data.get("method"),
                                     "note": developer_site_data.get("note"),
                                     "title": developer_site_data.get("title"),
                                     "corpi": developer_site_data.get("corpi", {}).get("names"),
                                     "ok": developer_site_data.get("ok")}
        if not developer_site_data.get("ok"):
            profile["limitations"].append("сайт застройщика: %s"
                                          % developer_site_data.get("note"))
    history = load_history(history_dir, project) if history_dir else []
    history_result = history_metrics(history)
    profile["history"] = history_result
    # официальный источник (ЕИСЖС): корпуса, квартиры, ДДУ — отдельно от нашей оценки
    profile["metrics"].update(eiszhs_metrics(eiszhs_status, project, eiszhs_cards, eiszhs_match_note))
    if eiszhs_cards is None:
        profile["limitations"].append(
            "ЕИСЖС: официальные корпуса/квартиры/ДДУ недоступны — %s"
            % ((eiszhs_status or {}).get("status") or "источник не проверялся"))
    else:
        profile["eiszhs"] = {"match": eiszhs_match_note or "подтверждено",
                             "corpi": eiszhs_cards.get("corpi")}
    ddu_value = profile["metrics"]["ddu_registered"]["value"]
    profile["metrics"]["sold_official_rosreestr"] = metric(
        ddu_value, "ДДУ", "ЕИСЖС (наш.дом.рф) / Росреестр", "dom" if ddu_value is not None else "none",
        "высокая" if ddu_value is not None else "",
        "зарегистрированные ДДУ из ЕИСЖС (срез — дата сбора)"
        if ddu_value is not None else
        "официальные ДДУ недоступны: %s — своими цифрами не подменяем"
        % ((eiszhs_status or {}).get("status") or "источник не проверялся"))
    profile["metrics"]["sold_estimate_by_gone_lots"] = metric(
        (history_result or {}).get("gone_total") if (history_result or {}).get("available") else None,
        "лотов", "наш недельный мониторинг", "estimate", "низкая",
        "оценка по уходу лотов из продажи, не данные Росреестра"
        if (history_result or {}).get("available")
        else "нужно минимум %d недели наблюдений" % MIN_WEEKS_FOR_DYNAMICS)
    profile["derived"] = derived_metrics(history_result, stats, district_median_ppm2, our_price)
    profile["derived"]["sold_share_official_pct"] = official_absorption(profile["metrics"])
    profile["risk_flags"] = risk_flags(history_result, profile["derived"])
    # каждая метрика знает дату сбора — даже та, где данных не оказалось (дата проверки)
    for item in list(profile["metrics"].values()) + list(profile["derived"].values()):
        if not item.get("collected_at"):
            item["collected_at"] = collected_at
    return profile


def district_median(profiles):
    values = [item["metrics"]["price_per_m2_median"]["value"] for item in profiles
              if item.get("metrics", {}).get("price_per_m2_median", {}).get("value")]
    return cw.median_rounded(values) if values else None


def build_summary(client_id, profiles, rosreestr):
    inside = [item for item in profiles if item.get("metrics", {}).get("lots_in_sale", {}).get("value")]
    return {
        "client": client_id,
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "projects": len(profiles),
        "projects_with_lots": len(inside),
        "lots_total": sum(item["metrics"]["lots_in_sale"]["value"] or 0 for item in profiles),
        "price_per_m2_median": district_median(profiles),
        "risk_flags": [{"project": item["project"], **flag}
                       for item in profiles for flag in (item.get("risk_flags") or [])],
        "rosreestr": rosreestr,
        "official": {
            "source": "ЕИСЖС (наш.дом.рф) / Росреестр",
            "status": rosreestr.get("status"),
            "projects_with_official_data": len([item for item in profiles
                                                if (item["metrics"].get("ddu_registered") or {})
                                                .get("value") is not None]),
            "corpi_total": sum((item["metrics"].get("corpi_total") or {}).get("value") or 0
                               for item in profiles) or None,
            "flats_total": sum((item["metrics"].get("flats_total") or {}).get("value") or 0
                               for item in profiles) or None,
            "ddu_registered": sum((item["metrics"].get("ddu_registered") or {}).get("value") or 0
                                  for item in profiles) or None,
            "comment": "нули здесь означают, что официальные данные недоступны, а не что их нет"
                       if rosreestr.get("status") != "получилось" else "",
        },
        "files": [item["project"] for item in profiles],
    }


def write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def slug(value):
    return discovery.slugify(value)


def build_parser():
    parser = argparse.ArgumentParser(prog="competitor_profile.py",
                                     description="Расширенный профиль конкурентов: метрики и динамика.")
    parser.add_argument("--client", default="client-svet", help="id клиента")
    parser.add_argument("--project", default=None, help="один проект (по умолчанию все кандидаты)")
    parser.add_argument("--candidates", default=None, help="файл кандидатов (по умолчанию data/candidates)")
    parser.add_argument("--limit", type=int, default=10, help="сколько конкурентов обработать")
    parser.add_argument("--out-dir", default=None, help="каталог профилей (по умолчанию data/clients)")
    parser.add_argument("--history-dir", default=None, help="каталог недельных снимков клиента")
    parser.add_argument("--no-browser", action="store_true", help="не пробовать Chrome для Росреестра")
    parser.add_argument("--developer-sites", default=None,
                        help="JSON-карта «имя конкурента → сайт застройщика» "
                             "(иначе берём поле site из конкурентов клиентского конфига)")
    parser.add_argument("--dry-run", action="store_true", help="не писать файлы")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv)
    candidates_path = Path(args.candidates) if args.candidates else CANDIDATES_DIR / "my-zhk-svet.json"
    if not candidates_path.exists():
        print("Файл кандидатов не найден: %s" % candidates_path, file=sys.stderr)
        return 1
    payload = json.loads(candidates_path.read_text(encoding="utf-8-sig"))
    candidates = payload.get("candidates") or []
    if args.project:
        candidates = [item for item in candidates if item.get("name") == args.project]
    candidates = [item for item in candidates if item.get("distance_km") is not None][:args.limit]
    if not candidates:
        print("Нет кандидатов с координатами для профилирования.")
        return 1

    our_price = None
    try:
        watch = discovery.load_watch()
        our_price = watch.get("price_min_per_m2")   # наша цена входа для разрывов «мы vs конкурент»
    except Exception:
        our_price = None

    data_dir = WATCH_DIR / "data" / "clients"
    history_dir = Path(args.history_dir) if args.history_dir else data_dir / args.client / "snapshots"
    out_dir = Path(args.out_dir) if args.out_dir else data_dir / args.client / PROFILES_SUBDIR

    source_cache = out_dir / SOURCE_CACHE_FILE
    payload_ros, attempts, rosreestr = rosreestr_status(
        allow_browser=not args.no_browser, cache_path=source_cache)
    print("Официальные источники: %s%s"
          % (rosreestr.get("status"), " (из кэша, %.1f ч)" % rosreestr["cache_age_hours"]
             if rosreestr.get("from_cache") else ""))
    print("   %s" % rosreestr.get("detail"))
    eiszhs_attempts = [entry for entry in rosreestr.get("attempts", [])
                       if "ЕИСЖС" in str(entry.get("source"))]
    eiszhs_verdict = eiszhs_attempts[0].get("verdict") if eiszhs_attempts else "unreachable"
    eiszhs_note = ((eiszhs_attempts[0].get("browser") or {}).get("note")
                   or (eiszhs_attempts[0].get("http") or {}).get("error") or "") if eiszhs_attempts else ""
    eiszhs_status = {
        "status": {"ok": "получилось", "disabled": "источник отключён (сайт сам так отвечает)",
                   "error_page": "Chrome отдал страницу ошибки сертификата"}.get(
                       eiszhs_verdict, "источник недоступен"),
        "verdict": eiszhs_verdict, "detail": eiszhs_note or rosreestr.get("detail"),
        "disabled": rosreestr.get("disabled") or [], "checked_at": rosreestr.get("checked_at")}

    site_map = {}
    if args.developer_sites and Path(args.developer_sites).exists():
        try:
            site_map = {str(k).lower(): str(v) for k, v in
                        json.loads(Path(args.developer_sites).read_text(encoding="utf-8-sig")).items()}
        except Exception as exc:
            print("карта сайтов не прочитана: %s" % exc)
    else:
        client_file = WATCH_DIR / "config" / "clients" / ("%s.yaml" % args.client)
        if client_file.exists():
            try:
                config = clients_mod.load_client(client_file)
                for competitor in (config.get("competitors") or []):
                    if isinstance(competitor, dict) and competitor.get("site"):
                        site_map[str(competitor.get("name") or "").lower()] = str(competitor["site"])
            except Exception as exc:
                print("конфиг клиента не прочитан (%s) — сайты застройщиков пропускаю" % exc)

    def site_for(name):
        key = str(name or "").lower()
        if key in site_map:
            return site_map[key]
        for candidate_name, url in site_map.items():
            if candidate_name and (candidate_name in key or key in candidate_name):
                return url
        return None

    profiles = []
    for item in candidates:
        url = ""
        for source in (item.get("sources") or []):
            if isinstance(source, dict) and "cian.ru" in str(source.get("url") or ""):
                url = source["url"]
                break
        if not url:
            url = str(item.get("url") or "")
        print("Профиль: %s (%s)" % (item.get("name"), url or "нет ссылки"))
        profile = build_profile(str(item.get("name")), url, "cian", history_dir=history_dir,
                                district_median_ppm2=None, our_price=our_price,
                                allow_browser=not args.no_browser, eiszhs_status=eiszhs_status,
                                developer_site_url=site_for(item.get("name")))
        profile["distance_km"] = item.get("distance_km")
        profile["class"] = item.get("class")
        profile["developer"] = item.get("developer")
        profiles.append(profile)
        lots = profile["metrics"].get("lots_in_sale", {}).get("value")
        ppm2 = profile["metrics"].get("price_per_m2_median", {}).get("value")
        site = profile.get("developer_site") or {}
        print("   лотов: %s | медиана ₽/м²: %s | сайт застройщика: %s | ограничений: %d"
              % (lots, cw.fmt_int(ppm2) if ppm2 else "—",
                 ("%s, корпусов: %s" % (site.get("method"), len(site.get("corpi") or [])))
                 if site else "не подключён", len(profile["limitations"])))

    district = district_median(profiles)
    for profile in profiles:
        profile["derived"]["price_index_vs_district"] = metric(
            round(profile["metrics"]["price_per_m2_median"]["value"] / district, 3)
            if (district and profile["metrics"].get("price_per_m2_median", {}).get("value")) else None,
            "×", "расчёт по нашим данным", "estimate", "средняя",
            "медиана ₽/м² конкурента к медиане района (%s ₽/м²)" % (cw.fmt_int(district) if district else "—"))
    summary = build_summary(args.client, profiles, rosreestr)

    if not args.dry_run:
        for profile in profiles:
            path = write_json(out_dir / ("%s.json" % discovery.slugify(profile["project"])), profile)
            print("   записан профиль: %s" % path)
        summary_path = write_json(out_dir / "_summary.json", summary)
        print("Сводка: %s" % summary_path)
    else:
        print("--dry-run: файлы не писались")
    print("")
    print("Итог: конкурентов %d, с лотами %d, лотов всего %d, медиана района %s ₽/м²"
          % (summary["projects"], summary["projects_with_lots"], summary["lots_total"],
             cw.fmt_int(summary["price_per_m2_median"]) if summary["price_per_m2_median"] else "—"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
