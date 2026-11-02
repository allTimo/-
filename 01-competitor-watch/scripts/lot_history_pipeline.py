#!/usr/bin/env python3
r"""lot_history_pipeline.py - связка двух источников: HTTP-страница проекта + история цен коннектором.

Зачем: наш HTTP-сбор открывает страницу проекта конкурента на Циан и видит ~28 лотов. Из карточек
берём offer_id/ссылку, по каждому id вызываем cian_card и получаем ИСТОРИЮ ЦЕНЫ конкретного лота
нашего конкурента. Фильтр по новостройке в коннекторе для этого не нужен.

Источники не смешиваются:
  * лоты и цены со страницы  → source «cian (http)», method http;
  * история цены и текущая цена карточки → source «cian-connector», method connector.
Расхождения цен между источниками показываются отдельно (проверка качества).

Вежливость: лимит карточек за прогон, пауза между вызовами, кэш истории на день (повторно не
спрашиваем), остановка при первой ошибке коннектора (не «молотим» при блокировке).

Usage:
    python lot_history_pipeline.py --project-url <URL страницы ЖК на Циан> --project zhk-... --client client-svet
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import cwlib as cw
import cian_connector as cc
import platforms

SCRIPT_DIR = Path(__file__).resolve().parent
WATCH_DIR = SCRIPT_DIR.parent
HTTP_SOURCE = "cian (http)"
CONNECTOR_SOURCE = cc.CONNECTOR_SOURCE
STOP_STATUSES = ("ошибка коннектора", "ошибка транспорта/аргументов", "таймаут коннектора",
                 "ошибка запуска", "коннектор недоступен")
# Разумные рамки ₽/м² для московских новостроек: вне них цену со страницы считаем
# недостоверной (наш парсер мог взять соседнее число) — расхождение тогда не считаем.
PLAUSIBLE_PPM2 = (120_000, 1_200_000)


def price_per_m2(price, area):
    try:
        return float(price) / float(area) if price and area else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def price_is_plausible(price, area):
    ppm2 = price_per_m2(price, area)
    if ppm2 is None:
        return True
    return PLAUSIBLE_PPM2[0] <= ppm2 <= PLAUSIBLE_PPM2[1]


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# 1. лоты со страницы проекта (HTTP)
# --------------------------------------------------------------------------

def project_lots(project_url, platform="cian", expect_name=None, fetch=None):
    """Лоты страницы проекта: id/ссылка/цена/площадь/комнатность. Источник — HTTP-сбор."""
    if fetch is None:
        try:
            status, html, error = platforms.http_fetch(project_url, timeout=30)
        except Exception as exc:
            return {"status": "ошибка http", "note": str(exc)[:160], "lots": [], "source": HTTP_SOURCE}
    else:
        status, html, error = fetch(project_url)
    if status != 200 or not html:
        return {"status": "страница недоступна", "note": "HTTP %s %s" % (status, error or ""),
                "lots": [], "source": HTTP_SOURCE}
    if expect_name and not platforms.mentions_name(html, expect_name):
        return {"status": "страница не про этот проект", "note": "нет упоминания «%s»" % expect_name,
                "lots": [], "source": HTTP_SOURCE}
    parsed = platforms.parse_page(html, platform, project_url)
    lots = []
    for lot in parsed.get("lots") or []:
        lots.append({"offer_id": lot.get("offer_id"), "offer_url": lot.get("offer_url"),
                     "price_rub": lot.get("price_rub"), "area_m2": lot.get("area_m2"),
                     "rooms": lot.get("rooms"), "floor": lot.get("floor"),
                     "building": lot.get("building"), "source": HTTP_SOURCE, "method": "http"})
    with_ids = [lot for lot in lots if lot.get("offer_id")]
    return {"status": "ok" if lots else "лотов нет", "lots": lots, "lots_with_id": len(with_ids),
            "note": "на странице %d лотов, из них с id %d" % (len(lots), len(with_ids)),
            "source": HTTP_SOURCE, "url": project_url}


# --------------------------------------------------------------------------
# 2. история цены по каждому лоту (коннектор), с вежливым режимом
# --------------------------------------------------------------------------

def cached_today(client_id, offer_id):
    path = cc.DATA_DIR / str(client_id) / "lot-history" / ("%s.json" % offer_id)
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return False
    return payload.get("saved_at") == dt.date.today().isoformat()


def enrich_histories(project_key, lots, client_id, limit=5, pause=1.5, cache_day=True,
                     card_kwargs=None):
    """Карточка по каждому лоту: история цены сохраняется с привязкой к проекту."""
    cards, skipped, stopped, errors = [], 0, None, []
    taken = 0
    for lot in lots:
        offer_id = lot.get("offer_id")
        if not offer_id:
            continue
        if taken >= limit:
            break
        if cache_day and cached_today(client_id, offer_id):
            skipped += 1
            continue
        result = cc.cian_card(offer_id, client_id=client_id, project=project_key,
                              extra={"offer_url": lot.get("offer_url"),
                                     "page_price_rub": lot.get("price_rub")},
                              **(card_kwargs or {}))
        taken += 1
        entry = {"offer_id": offer_id, "status": result["status"],
                 "points": len(result["price_history"]), "saved": bool(result["saved"]),
                 "note": result.get("note", "")}
        if result["status"] in STOP_STATUSES:
            entry["stopped"] = True
            errors.append(result.get("note", ""))
            cards.append(entry)
            stopped = result["status"] + (": " + (result.get("note") or "")[:120])
            break
        cards.append(entry)
        # сверка цены страницы с ценой карточки — только если цена страницы правдоподобна
        card_price = (result.get("card") or {}).get("price_rub")
        if lot.get("price_rub") and card_price:
            ppm2 = price_per_m2(lot.get("price_rub"), lot.get("area_m2"))
            entry["page_price_per_m2"] = int(ppm2) if ppm2 else None
            if price_is_plausible(lot.get("price_rub"), lot.get("area_m2")):
                entry["price_diff_pct"] = round((card_price - lot["price_rub"]) / lot["price_rub"] * 100, 2)
            else:
                # честно: расхождение не считаем, но фиксируем, что цена со страницы выглядит битой
                entry["price_check"] = ("цена со страницы выглядит недостоверной (%s ₽/м²) — "
                                        "расхождение не считаем" % (int(ppm2) if ppm2 else "—"))
        if taken < limit:
            time.sleep(max(0.0, pause))
    return {"cards": cards, "taken": taken, "skipped_cached": skipped, "stopped": stopped,
            "errors": errors, "source": CONNECTOR_SOURCE}


# --------------------------------------------------------------------------
# 3. прогон целиком
# --------------------------------------------------------------------------

def run(project_url, project_key, client_id, limit=5, pause=1.5, cache_day=True, expect_name=None,
        fetch=None, card_kwargs=None):
    lots_result = project_lots(project_url, expect_name=expect_name, fetch=fetch)
    ids = [lot for lot in lots_result.get("lots") or [] if lot.get("offer_id")]
    history = enrich_histories(project_key, ids, client_id, limit=limit, pause=pause,
                               cache_day=cache_day, card_kwargs=card_kwargs) if ids else {
        "cards": [], "taken": 0, "skipped_cached": 0, "stopped": None, "errors": [],
        "source": CONNECTOR_SOURCE}
    metrics = cc.metrics_by_project(client_id)
    return {"project": project_key, "project_url": project_url,
            "checked_at": dt.date.today().isoformat(),
            "lots": lots_result, "history": history,
            "prices": {"http_source": HTTP_SOURCE, "history_source": CONNECTOR_SOURCE,
                       "note": "источники не смешиваются: лоты — HTTP-сбор, история — коннектор"},
            "metrics": metrics}


def main(argv=None):
    setup_console()
    parser = argparse.ArgumentParser(prog="lot_history_pipeline.py",
                                     description="Страница проекта (HTTP) + история цен по лотам (коннектор).")
    parser.add_argument("--project-url", required=True)
    parser.add_argument("--project", required=True, help="канонический ключ, например zhk-mihalkovskiy")
    parser.add_argument("--client", default="client-svet")
    parser.add_argument("--expect-name", default=None, help="имя ЖК для проверки страницы")
    parser.add_argument("--limit", type=int, default=5, help="сколько карточек брать за прогон")
    parser.add_argument("--pause", type=float, default=1.5, help="пауза между карточками, сек")
    parser.add_argument("--no-cache", action="store_true", help="не использовать дневной кэш истории")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = run(args.project_url, args.project, args.client, limit=args.limit, pause=args.pause,
                 cache_day=not args.no_cache, expect_name=args.expect_name)
    lots = result["lots"]
    print("Страница проекта: %s | лотов: %d | с id: %d" % (lots["status"], len(lots.get("lots") or []),
                                                          lots.get("lots_with_id") or 0))
    history = result["history"]
    print("Карточки: взято %d | пропущено из кэша %d | остановлено: %s"
          % (history["taken"], history["skipped_cached"], history["stopped"] or "нет"))
    for card in history["cards"]:
        diff = card.get("price_diff_pct")
        print("   лот %s: %s | точек истории %d%s"
              % (card["offer_id"], card["status"], card["points"],
                 (" | расхождение цены со страницей %+.2f%%" % diff) if diff is not None else ""))
    per_project = result["metrics"]["projects"].get(args.project)
    if per_project:
        metrics = per_project["metrics"]
        print("История по проекту %s: лотов %s | снижений %s | средняя глубина %s%% | рост %s | "
              "последнее изменение %s | давление на цену %s%%"
              % (args.project, metrics["lots_with_price_history"]["value"],
                 metrics["lots_price_decreased"]["value"], metrics["avg_price_decrease_pct"]["value"],
                 metrics["lots_price_increased"]["value"], metrics["last_price_change"]["value"],
                 metrics["price_pressure_pct"]["value"]))
    else:
        print("История по проекту %s: данных пока нет" % args.project)
    if args.json:
        print(json.dumps(result, ensure_ascii=False)[:1500])
    return 0


if __name__ == "__main__":
    sys.exit(main())
