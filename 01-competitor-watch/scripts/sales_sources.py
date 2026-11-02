#!/usr/bin/env python3
r"""sales_sources.py - продажи из простых маршрутов (приоритет пользователя).

Порядок попыток (от дешёвых к сложным), каждый результат фиксируется честно:
  1) альтернативные хосты/эндпоинты ЕИСЖС (наш.дом.рф): http, api, мобильная версия;
  2) открытые данные ДОМ.РФ (дом.рф/аналитика) — рыночные показатели продаж и ипотеки;
  3) сайты застройщиков (см. developer_site.py) — шахматка, если публикуется;
  4) наша косвенная оценка по уходу лотов (developer/профиль), помечается «оценка».

Чего не делаем: не подменяем официальные ДДУ своими числами; сумм из закрытых источников не выдумываем.
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

WATCH_DIR = Path(__file__).resolve().parent.parent
EISZHS_VERDICT_FILE = "sales-sources.json"
DOMRF_ANALYTICS = "https://xn--d1aqf.xn--p1ai/analytics/"
EISZHS_PROBES = [
    ("https://xn--80asehdb.xn--p1ai/", "корень ЕИСЖС"),
    ("http://xn--80asehdb.xn--p1ai/", "корень по http"),
    ("https://xn--80asehdb.xn--p1ai/api/kn/object?limit=5", "API /api/kn/object"),
    ("https://xn--80asehdb.xn--p1ai/api/v1/objects?limit=5", "API /api/v1/objects"),
    ("https://xn--80asehdb.xn--p1ai/%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81%D1%8B/api/kn/object?limit=5",
     "API сервисы/api/kn/object"),
    ("https://m.xn--80asehdb.xn--p1ai/", "мобильная версия"),
]
SALES_KEYWORDS = ("продаж", "дду", "ипотек", "ввод", "сделк", "спрос", "предложен", "цен")
DISABLED_MARKERS = ("сайт отключ", "отключен", "отключён", "service temporarily unavailable")


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# 1. альтернативные маршруты к ЕИСЖС
# --------------------------------------------------------------------------

def probe_eiszhs(verify=False, timeout=20):
    """Проверяем ЕИСЖС по нескольким хостам/эндпоинтам. Возвращает честный вердикт."""
    attempts = []
    for url, label in EISZHS_PROBES:
        entry = {"url": url, "label": label, "status": None, "bytes": 0, "verdict": "", "note": ""}
        try:
            status, body, error = platforms.http_fetch(url, timeout=timeout, verify=verify)
            entry["status"] = status
            entry["bytes"] = len(body or "")
            lowered = (body or "").lower()
            if status == 200 and body and not any(m in lowered for m in DISABLED_MARKERS):
                entry["verdict"] = "ok"
            elif status == 200 and any(m in lowered for m in DISABLED_MARKERS):
                entry["verdict"] = "disabled"
                entry["note"] = "сайт сам сообщает об отключении"
            elif status is not None and status >= 500:
                entry["verdict"] = "unavailable"
                entry["note"] = "HTTP %s: сервис недоступен (не наша блокировка)" % status
            else:
                entry["verdict"] = "blocked"
                entry["note"] = error or "HTTP %s" % status
        except Exception as exc:
            entry["verdict"] = "error"
            entry["note"] = str(exc)[:120]
        attempts.append(entry)
    reachable = [item for item in attempts if item["verdict"] == "ok"]
    return {"status": "доступен" if reachable else "недоступен",
            "detail": ("; ".join("%s: %s" % (item["label"], item["verdict"]) for item in attempts))[:400],
            "attempts": attempts, "checked_at": dt.date.today().isoformat(),
            "tls_verification": "отключена" if not verify else "включена"}


# --------------------------------------------------------------------------
# 2. открытые данные ДОМ.РФ
# --------------------------------------------------------------------------

def extract_domrf_indicators(html):
    """Показатели с дом.рф/аналитика: код, название, значение, динамика."""
    indicators, news = [], []
    seen = set()
    for blob in platforms.extract_json_objects(html, '"props"', max_length=4000):
        raw_props = blob.get("props")
        if not isinstance(raw_props, dict):
            continue                      # бывают и списки — у них другая структура
        code = blob.get("code") or ""
        props = raw_props
        title = ((props.get("title") or {}).get("value") if isinstance(props.get("title"), dict)
                 else props.get("title")) or code
        value = (props.get("value") or {}).get("value") if isinstance(props.get("value"), dict) \
            else props.get("value")
        dynamics = (props.get("dynamics") or {}).get("value") if isinstance(props.get("dynamics"), dict) \
            else None
        if not code and not title:
            continue
        key = (str(code), str(title), str(value))
        if key in seen:
            continue
        seen.add(key)
        indicators.append({"code": str(code), "title": str(title), "value": value,
                           "dynamics": dynamics,
                           "sales_related": any(word in (str(title) + str(code)).lower()
                                                for word in SALES_KEYWORDS)})
    for name in re.findall(r'"name":"([^"]{10,160})"', html or ""):
        cleaned = name.replace("\\/", "/").strip()
        if any(word in cleaned.lower() for word in ("продаж", "дду", "ипотек", "новостро", "спрос")):
            if cleaned not in news:
                news.append(cleaned)
    dates = sorted(set(re.findall(r'"date_from":"(\d{2}\.\d{2}\.20\d{2})"', html or "")))
    return {"indicators": indicators, "news": news[:6], "periods": dates[:6]}


def collect_domrf(verify=False, timeout=30):
    """Сбор рыночных показателей с дом.рф (открытый источник, наш уровень — рынок, не ЖК)."""
    collected_at = dt.date.today().isoformat()
    try:
        status, html, error = platforms.http_fetch(DOMRF_ANALYTICS, timeout=timeout, verify=verify)
    except Exception as exc:
        return {"status": "error", "note": str(exc)[:160], "indicators": [], "news": [],
                "source": "ДОМ.РФ (дом.рф/аналитика)", "collected_at": collected_at}
    if status != 200 or not html:
        return {"status": "unavailable", "note": "HTTP %s %s" % (status, error or ""),
                "indicators": [], "news": [], "source": "ДОМ.РФ (дом.рф/аналитика)",
                "collected_at": collected_at}
    parsed = extract_domrf_indicators(html)
    parsed.update({"status": "ok", "source": "ДОМ.РФ (дом.рф/аналитика)",
                   "url": DOMRF_ANALYTICS, "collected_at": collected_at,
                   "level": "рынок (не по конкретному ЖК)", "bytes": len(html)})
    return parsed


def domrf_metrics(domrf):
    """Метрики для профиля/сводки: рыночные показатели продаж ДОМ.РФ."""
    collected = domrf.get("collected_at")
    sales = [item for item in domrf.get("indicators", []) if item.get("sales_related")]
    def metric(value, unit, comment):
        return {"value": value, "unit": unit, "source": domrf.get("source") or "ДОМ.РФ",
                "collected_at": collected, "method": "http", "accuracy": "высокая",
                "comment": comment, "url": domrf.get("url")}
    return {
        "market_sales_indicators_count": metric(len(sales) or None, "показателей",
                                                "рыночные показатели, связанные с продажами"),
        "market_sales_indicators": metric("; ".join("%s: %s" % (item["title"], item["value"])
                                                    for item in sales[:6]) or None,
                                          "", "уровень: рынок/страна, не по конкретному ЖК"),
        "market_news_count": metric(len(domrf.get("news") or []) or None, "новостей",
                                    "; ".join((domrf.get("news") or [])[:2]) or "новостей нет"),
    }


def save_verdict(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def main(argv=None):
    setup_console()
    parser = argparse.ArgumentParser(prog="sales_sources.py",
                                     description="Продажи: простые маршруты к официальным данным.")
    parser.add_argument("--client", default="client-svet")
    parser.add_argument("--out", default=None, help="куда сохранить вердикт")
    parser.add_argument("--verify-tls", action="store_true", help="проверять сертификат (строгий режим)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    eiszhs = probe_eiszhs(verify=args.verify_tls)
    domrf = collect_domrf(verify=args.verify_tls)
    payload = {"checked_at": dt.date.today().isoformat(), "client": args.client,
               "eiszhs": eiszhs, "domrf": domrf,
               "note": "официальные ДДУ по конкретному ЖК: %s; ниже — что удалось получить" % eiszhs["status"]}

    print("=== ЕИСЖС (продажи по ЖК) ===")
    print("Вердикт: %s" % eiszhs["status"])
    for item in eiszhs["attempts"]:
        print("   %-46s %s %s" % (item["label"], item["status"], item["verdict"]))
    print("=== ДОМ.РФ: рыночные показатели ===")
    print("Статус: %s | показателей: %d | про продажи: %d | периодов: %s"
          % (domrf.get("status"), len(domrf.get("indicators") or []),
             len([x for x in (domrf.get("indicators") or []) if x.get("sales_related")]),
             ", ".join(domrf.get("periods") or []) or "—"))
    for item in [x for x in (domrf.get("indicators") or []) if x.get("sales_related")][:6]:
        print("   %-38s %s" % (item["title"][:38], item["value"]))
    for text in (domrf.get("news") or [])[:3]:
        print("   новость: %s" % text[:110])

    out = Path(args.out) if args.out else (WATCH_DIR / "data" / "clients" / args.client
                                          / EISZHS_VERDICT_FILE)
    path = save_verdict(out, payload)
    print("Вердикт сохранён: %s" % path)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False)[:1500])
    return 0


if __name__ == "__main__":
    sys.exit(main())
