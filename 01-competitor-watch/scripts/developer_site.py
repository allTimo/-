#!/usr/bin/env python3
r"""developer_site.py - корпуса, шахматка, акции и ипотека с САЙТА ЗАСТРОЙЩИКА.

Источник всегда помечается как «сайт застройщика» и НИКОГДА не выдаётся за Росреестр/ЕИСЖС.
Методы: обычный HTTP; если страница отдаёт только каркас или блокирует — Chrome по CDP
(чистый профиль, без логина) + разбор JS-состояния страницы (__NUXT__, __INITIAL_STATE__,
__NEXT_DATA__, self.__next_f).

Что ищем:
  * корпуса / ход строительства — стадия (строится / введён), срок ввода, готовность;
  * выбор квартир / шахматка — всего / в продаже / продано / забронировано (если публикуется);
  * акции и ипотечные программы (тексты).

Если числа не публикуются — честно null («на сайте не публикуется»), а не ноль.

Usage:
    python developer_site.py --url https://rg-dev.ru/novostroyki/mihalkovskij/ --json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

import cwlib as cw
import platforms

SOURCE_LABEL = "сайт застройщика"
STAGE_BUILT = ("введен", "введён", "введена", "сдан", "сдана", "построен", "готов", "ключи выдаются")
STAGE_BUILDING = ("строит", "возводит", "монтаж", "котлован", "фундамент")
DEADLINE_RE = re.compile(r"(?:срок|ввод|сдача|готовность|передача)[^\d]{0,25}([0-9]{1,2}\s*кв(?:артал)?\.?\s*20[2-9][0-9]|20[2-9][0-9]\s*(?:г\.|год))", re.I)
READINESS_RE = re.compile(r"готовность[^\d]{0,12}([0-9]{1,3})\s*%", re.I)
KVARTAL_RE = re.compile(r"\b([0-9]{1,2})\s*(кв(?:артал)?\.?)?\s*(20[2-9][0-9])", re.I)
PROMO_KEYWORDS = ("скидк", "акци", "рассрочк", "подарок", "кэшбэк", "трейд-ин", "выгод")
MORTGAGE_KEYWORDS = ("ипотек", "семейная ипотека", "it-ипотека", "господдержк", "ставка от")
CHESSBOARD_KEYS = {"flatscount": "flats_total", "totalflats": "flats_total", "flatstotal": "flats_total",
                   "insale": "in_sale", "available": "in_sale", "flatsinsale": "in_sale",
                   "sold": "sold", "soldflats": "sold", "flatsold": "sold",
                   "reserved": "reserved", "booked": "reserved", "flatsreserved": "reserved"}


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# получение страницы
# --------------------------------------------------------------------------

def fetch_developer_page(url, allow_browser=True, headless=True, wait_ms=9000, ignore_cert=False,
                         port=9363):
    """HTTP, при каркасе/блокировке — Chrome по CDP. Возвращает (html, method, note)."""
    note = ""
    html = ""
    try:
        status, body, error = platforms.http_fetch(url, timeout=25)
        note = "HTTP %s" % status
        if status == 200 and body and not platforms.is_chrome_error_page(body):
            html = body
    except Exception as exc:
        note = "HTTP не удался: %s" % str(exc)[:80]
    text_length = len(platforms.visible_text(html)) if html else 0
    # каркас SPA: мало текста при непустом html либо ответ не 200
    if html and text_length > 400:
        return html, "http", note
    if not allow_browser:
        return html, "http" if html else "none", (note + "; браузер отключён").strip("; ")
    process = profile = None
    try:
        process, profile = platforms.launch_chrome(port=port, headless=headless,
                                                  ignore_cert_errors=ignore_cert)
        browser_html = platforms.cdp_html(url, port=port, wait_ms=wait_ms)
        if browser_html and not platforms.is_chrome_error_page(browser_html):
            visible = len(platforms.visible_text(browser_html))
            if visible < 400:
                # страница открылась, но это каркас/заглушка — данных нет (не выдаём за успех)
                return "", "none", (note + "; в браузере открылась заглушка (%d знаков текста)"
                                    % visible).strip("; ")
            return browser_html, "dom", (note + "; открыто в браузере без логина").strip("; ")
        if browser_html:
            return "", "none", (note + "; Chrome отдал страницу-ошибку (не данные)").strip("; ")
        return "", "none", (note + "; браузер не отдал страницу").strip("; ")
    except Exception as exc:
        return "", "none", (note + "; браузер не удался: %s" % str(exc)[:80]).strip("; ")
    finally:
        platforms.stop_chrome(process, profile)


def extract_page_state(html):
    """JS-состояние страницы: __NUXT__ / __INITIAL_STATE__ / __NEXT_DATA__ / self.__next_f."""
    state = {}
    for marker in ("__NUXT__", "__INITIAL_STATE__", "__NEXT_DATA__", "__PRELOADED_STATE__"):
        index = (html or "").find(marker)
        if index < 0:
            continue
        brace = html.find("{", index)
        parsed = platforms.balanced_json_at(html, brace) if brace > 0 else None
        if parsed is not None:
            state[marker] = parsed
    if "self.__next_f" in (html or ""):
        state["next_f"] = True
    return state


def deep_numbers(node, keys=CHESSBOARD_KEYS, found=None, path=""):
    """Рекурсивно ищем числа шахматки по известным названиям полей."""
    found = found if found is not None else {}
    if isinstance(node, dict):
        for key, value in node.items():
            lowered = str(key).lower().replace("_", "")
            if lowered in keys and isinstance(value, (int, float)) and not isinstance(value, bool):
                found.setdefault(keys[lowered], int(value))
            deep_numbers(value, keys, found, path + "/" + str(key))
    elif isinstance(node, list):
        for item in node:
            deep_numbers(item, keys, found, path)
    return found


# --------------------------------------------------------------------------
# разборы
# --------------------------------------------------------------------------

def parse_corpi(html):
    """Корпуса: название, стадия, срок ввода, готовность — из текста и JS-состояния."""
    text = platforms.visible_text(html)
    lowered = text.lower()
    names = sorted({match.group(0).strip() for match in
                    re.finditer(r"(?:Корпус|корпус|Литер|литер)\s*[№#]?\s*[0-9]{1,2}", text)})
    deadlines = sorted({"%(q)s %(label)s %(year)s" % {"q": match.group(1),
                                                      "label": (match.group(2) or "кв.").strip("."),
                                                      "year": match.group(3)}
                        for match in KVARTAL_RE.finditer(text)
                        if 1 <= int(match.group(1)) <= 4 and 2024 <= int(match.group(3)) <= 2035})
    readiness = [int(match.group(1)) for match in READINESS_RE.finditer(text)]
    built = sum(1 for marker in STAGE_BUILT if marker in lowered)
    building = sum(1 for marker in STAGE_BUILDING if marker in lowered)
    state = extract_page_state(html)
    state_corpi = 0
    if state:
        payload = json.dumps(state, ensure_ascii=False).lower()
        state_corpi = len(re.findall(r"(?:корпус|building|house)", payload))
    return {"names": names[:15], "count_named": len(names),
            "state_mentions": state_corpi,
            "deadlines": deadlines[:8], "readiness_percent": readiness[:8],
            "built_markers": built, "building_markers": building,
            "js_states": sorted(state.keys())}


def parse_chessboard(html):
    """Шахматка/выбор квартир: числа, если сайт их публикует; иначе None (не публикуется)."""
    state = extract_page_state(html)
    numbers = deep_numbers(state) if state else {}
    text = platforms.visible_text(html).lower()
    if not numbers:
        # иногда счётчики есть прямо в разметке
        for pattern, field in ((r"в продаже[^\d]{0,12}([0-9]{1,4})", "in_sale"),
                               (r"продано[^\d]{0,12}([0-9]{1,4})", "sold"),
                               (r"забронировано[^\d]{0,12}([0-9]{1,4})", "reserved"),
                               (r"всего квартир[^\d]{0,12}([0-9]{1,5})", "flats_total")):
            match = re.search(pattern, text)
            if match:
                numbers[field] = int(match.group(1))
    published = bool(numbers)
    return {"published": published,
            "flats_total": numbers.get("flats_total"),
            "in_sale": numbers.get("in_sale"),
            "sold": numbers.get("sold"),
            "reserved": numbers.get("reserved"),
            "source_note": "числа взяты с сайта застройщика" if published
                           else "сайт не публикует сводную шахматку (только подбор квартир)"}


def parse_site_promos(html):
    """Акции и ипотечные программы с сайта застройщика (уникальные тексты)."""
    text = platforms.visible_text(html)
    promos, mortgages = [], []
    for sentence in re.split(r"[.!?\n]+", text):
        lowered = sentence.lower()
        cleaned = sentence.strip()
        if len(cleaned) < 6 or len(cleaned) > 160:
            continue
        if any(word in lowered for word in MORTGAGE_KEYWORDS):
            if cleaned not in mortgages:
                mortgages.append(cleaned)
        elif any(word in lowered for word in PROMO_KEYWORDS):
            if cleaned not in promos:
                promos.append(cleaned)
    return {"promos": promos[:6], "mortgages": mortgages[:6],
            "promo_count": len(promos), "mortgage_count": len(mortgages)}


def site_metrics(parsed, collected_at=None):
    """Метрики профиля из данных сайта застройщика (source: сайт застройщика)."""
    collected = collected_at or dt.date.today().isoformat()
    corpi, chess, promos = parsed["corpi"], parsed["chessboard"], parsed["promos"]
    def metric(value, unit, method, accuracy, comment=""):
        return {"value": value, "unit": unit, "source": SOURCE_LABEL, "collected_at": collected,
                "method": method, "accuracy": accuracy, "comment": comment}
    metrics = {
        "site_corpi_named": metric(corpi["count_named"] or None, "корпусов", parsed["method"], "средняя",
                                   "названия корпусов на странице: " + ", ".join(corpi["names"][:4])
                                   if corpi["names"] else "на странице корпуса по номерам не названы"),
        "site_deadlines": metric("; ".join(corpi["deadlines"]) or None, "сроки", parsed["method"],
                                 "средняя", "сроки ввода из текста страницы"),
        "site_readiness_pct": metric(corpi["readiness_percent"][0] if corpi["readiness_percent"] else None,
                                     "%", parsed["method"], "средняя", "готовность, если указана"),
        "site_flats_total": metric(chess["flats_total"], "квартир", parsed["method"], "средняя",
                                   chess["source_note"]),
        "site_flats_in_sale": metric(chess["in_sale"], "квартир", parsed["method"], "средняя",
                                     chess["source_note"]),
        "site_flats_sold": metric(chess["sold"], "квартир", parsed["method"], "средняя",
                                  chess["source_note"]),
        "site_flats_reserved": metric(chess["reserved"], "квартир", parsed["method"], "средняя",
                                      chess["source_note"]),
        "site_promo_count": metric(promos["promo_count"] or None, "акций", parsed["method"], "средняя",
                                   "; ".join(promos["promos"][:3]) or "акций на сайте не найдено"),
        "site_mortgage_count": metric(promos["mortgage_count"] or None, "программ", parsed["method"],
                                      "средняя", "; ".join(promos["mortgages"][:3])
                                      or "ипотечных программ на сайте не найдено"),
    }
    return metrics


def sold_share_from_site(metrics):
    """Доля проданного с сайта застройщика — только если есть ОБА числа (продано и всего)."""
    sold = (metrics.get("site_flats_sold") or {}).get("value")
    total = (metrics.get("site_flats_total") or {}).get("value")
    if sold is None or not total:
        missing = "продано" if sold is None else "всего квартир"
        return {"value": None, "unit": "%", "source": SOURCE_LABEL, "method": "estimate",
                "accuracy": "", "collected_at": None,
                "comment": "доля проданного не считается: сайт не публикует %s" % missing}
    return {"value": round(sold / total * 100, 1), "unit": "%", "source": SOURCE_LABEL,
            "method": "estimate", "accuracy": "средняя", "collected_at": None,
            "comment": "продано / всего квартир по данным сайта застройщика (не Росреестр)"}


def collect(url, allow_browser=True, headless=True, ignore_cert=False):
    html, method, note = fetch_developer_page(url, allow_browser=allow_browser, headless=headless,
                                              ignore_cert=ignore_cert)
    if not html:
        return {"url": url, "method": method, "note": note, "ok": False,
                "corpi": {"names": [], "count_named": 0, "deadlines": [], "readiness_percent": [],
                          "built_markers": 0, "building_markers": 0, "js_states": []},
                "chessboard": {"published": False, "flats_total": None, "in_sale": None, "sold": None,
                               "reserved": None, "source_note": "страница недоступна: %s" % note},
                "promos": {"promos": [], "mortgages": [], "promo_count": 0, "mortgage_count": 0}}
    title = re.search(r"<title>(.*?)</title>", html, re.S)
    result = {"url": url, "method": method, "note": note, "ok": True, "size": len(html),
              "title": (title.group(1).strip()[:90] if title else ""),
              "corpi": parse_corpi(html), "chessboard": parse_chessboard(html),
              "promos": parse_site_promos(html)}
    result["js_states"] = result["corpi"].get("js_states") or []
    return result


def main(argv=None):
    setup_console()
    parser = argparse.ArgumentParser(prog="developer_site.py",
                                     description="Данные с сайта застройщика (не Росреестр).")
    parser.add_argument("--url", required=True)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--ignore-cert", action="store_true", help="игнорировать ошибку сертификата")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    data = collect(args.url, allow_browser=not args.no_browser, ignore_cert=args.ignore_cert)
    metrics = site_metrics(data)
    share = sold_share_from_site(metrics)
    print("Источник: %s | метод: %s | %s" % (SOURCE_LABEL, data["method"], data["note"]))
    print("Корпуса: названо %s | сроки: %s | готовность: %s"
          % (data["corpi"]["count_named"] or "—", "; ".join(data["corpi"]["deadlines"]) or "—",
             data["corpi"]["readiness_percent"] or "—"))
    print("Шахматка: %s" % data["chessboard"]["source_note"])
    print("Акции: %d | ипотека: %d" % (data["promos"]["promo_count"], data["promos"]["mortgage_count"]))
    print("Доля проданного: %s" % (share["value"] if share["value"] is not None else "—"))
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
