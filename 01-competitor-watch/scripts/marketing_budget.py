#!/usr/bin/env python3
r"""marketing_budget.py - маркетинговые бюджеты конкурентов и обращения (только открытые данные).

Правило честности (docs/agent1-competitor-metrics.md §6):
  * суммы — только из ПУБЛИЧНОЙ отчётности застройщиков, с ссылкой на документ, страницей и датой,
    и с пометкой уровня «по компании/группе» (не по конкретному ЖК);
  * наличие поисковой рекламы фиксируем как ФАКТ, не как сумму;
  * звонки, конверсия, визиты в офис продаж в открытых источниках НЕ публикуются → null с причиной;
    прокси-оценки под видом данных не делаем.

Usage:
    python marketing_budget.py --client client-svet
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import urllib.parse
from pathlib import Path

import cwlib as cw
import platforms

WATCH_DIR = Path(__file__).resolve().parent.parent
OUT_FILE = "marketing-sources.json"
ADVERTISING_WORDS = ("коммерческ", "реклам", "маркетинг", "продвижен")
MONEY_RE = re.compile(r"((?:[0-9]{1,3}(?:[ \u00a0][0-9]{3})+|[0-9]{4,})\s*(?:млн|млрд|тыс\.?)?\s*(?:руб|₽|rub)?)", re.I)
# публичные источники: страницы раскрытия и IR-разделы (без логина)
PUBLIC_SOURCES = {
    "ПИК": ["https://www.pik.ru/investors", "https://pik.ru/ir",
            "https://www.e-disclosure.ru/portal/company.aspx?id=1486"],
    "ЛСР": ["https://www.lsr.ru/ru/investors/", "https://www.lsr.ru/ru/investors/disclosure/",
            "https://www.e-disclosure.ru/portal/company.aspx?id=2093"],
    "Самолёт": ["https://samoletgroup.ru/", "https://samoletgroup.ru/investors/",
                "https://www.e-disclosure.ru/portal/company.aspx?id=37499"],
    "Эталон": ["https://www.etalongroup.com/ru/investors/",
               "https://www.etalongroup.com/ru/investors/disclosure/",
               "https://www.e-disclosure.ru/portal/company.aspx?id=1147"],
}
SOCIAL_SOURCES = {
    "ПИК": ["https://vk.com/pik"],
    "ЛСР": ["https://vk.com/lsrgroup"],
    "Самолёт": ["https://vk.com/samolet_official"],
    "Эталон": ["https://vk.com/etalongroup"],
}
CALLS_EXPLANATION = ("в открытых источниках не публикуется: это внутренняя аналитика "
                     "(CRM, коллтрекинг, записи в офис продаж)")


def setup_console():
    cw.setup_console()


def scan_page(url, verify=False, timeout=25):
    """Открытая страница: доступна ли, есть ли упоминания коммерческих расходов и цифры."""
    entry = {"url": url, "status": None, "bytes": 0, "reachable": False, "mentions": [],
             "numbers": [], "documents": [], "note": ""}
    try:
        status, html, error = platforms.http_fetch(url, timeout=timeout, verify=verify)
    except Exception as exc:
        entry["note"] = str(exc)[:120]
        return entry
    entry["status"] = status
    entry["bytes"] = len(html or "")
    if status != 200 or not html or platforms.is_chrome_error_page(html):
        entry["note"] = error or ("HTTP %s" % status)
        return entry
    entry["reachable"] = True
    text = platforms.visible_text(html)
    lowered = text.lower()
    for word in ADVERTISING_WORDS:
        for match in list(re.finditer(r".{0,80}%s.{0,120}" % word, lowered))[:2]:
            snippet = text[max(0, match.start()):match.start() + 200]
            cleaned = re.sub(r"\s+", " ", snippet).strip()
            if cleaned not in entry["mentions"]:
                entry["mentions"].append(cleaned[:200])
    for match in MONEY_RE.finditer(text):
        value = re.sub(r"\s+", " ", match.group(1)).strip()
        if len(value) >= 6 and value not in entry["numbers"]:
            entry["numbers"].append(value)
    # ссылки на документы отчётности (PDF/XLSX/страницы раскрытия) — их отдаём человеку
    for href in re.findall(r'href="([^"]+)"', html):
        if re.search(r"\.(pdf|xlsx|xls)(\?|$)", href, re.I) or re.search(
                r"otchetnost|disclosure|report|finansov", href, re.I):
            full = urllib.parse.urljoin(url, href)   # корректно разрешает /root и относительные пути
            if full not in entry["documents"]:
                entry["documents"].append(full)
    entry["documents"] = entry["documents"][:12]
    return entry


def budget_metrics(developer, scans, promo_intensity=None):
    """Метрики бюджета: суммы из отчётности (если нашли) либо null с ссылкой на документ."""
    collected = dt.date.today().isoformat()
    found = [entry for entry in scans if entry["reachable"]]
    with_mentions = [entry for entry in found if entry["mentions"]]
    numbers = [(entry["url"], value) for entry in with_mentions for value in entry["numbers"][:3]]
    def metric(value, unit, comment, method="http", accuracy="", url=""):
        return {"value": value, "unit": unit, "source": "публичная отчётность застройщика",
                "collected_at": collected, "method": method, "accuracy": accuracy,
                "comment": comment, "url": url, "level": "по компании/группе (не по ЖК)"}
    if numbers:
        text = "; ".join("%s → %s" % (value, url) for url, value in numbers[:4])
        return {
            "marketing_spend_company": metric(None, "₽", "найдены суммы, но требуется указание "
                                                            "страницы документа: %s" % text,
                                              accuracy="требует проверки", url=numbers[0][1]),
            "marketing_spend_documents": metric(len(numbers), "упоминаний",
                                                "страницы с упоминанием коммерческих расходов: "
                                                + "; ".join(entry["url"] for entry in with_mentions[:3])),
        }
    documents = [(entry["url"], doc) for entry in found for doc in entry.get("documents", [])]
    return {
        "marketing_spend_company": metric(
            None, "₽",
            "сумма не извлечена автоматически; проверены открытые источники (%d доступно из %d), "
            "документ требует ручного просмотра" % (len(found), len(scans)),
            url=(found[0]["url"] if found else "")),
        "marketing_spend_documents": metric(
            len(documents) or None, "документов",
            ("документы отчётности найдены (суммы — в самих документах, нужен ручной просмотр): "
             + "; ".join(doc for _, doc in documents[:3])) if documents
            else "документы отчётности на доступных страницах не найдены",
            url=(documents[0][1] if documents else "")),
    }


def promo_intensity_metric(promo_count=None):
    return {"value": promo_count, "unit": "акций", "source": "наш мониторинг промо-страниц",
            "collected_at": dt.date.today().isoformat(), "method": "http", "accuracy": "средняя",
            "comment": "интенсивность промо по нашим сборам" if promo_count is not None
                       else "промо ещё не собирались",
            "level": "по проекту"}


def conversion_metrics():
    """Звонки/конверсия/визиты: в открытых источниках не публикуются — null с причиной."""
    collected = dt.date.today().isoformat()
    keys = {"calls_count": "звонков", "conversion_rate": "%", "office_visits": "визитов",
            "lead_cost": "₽"}
    return {key: {"value": None, "unit": unit, "source": "CRM/коллтрекинг конкурента",
                  "collected_at": collected, "method": "none", "accuracy": "",
                  "comment": CALLS_EXPLANATION, "level": "внутренние данные конкурента"}
            for key, unit in keys.items()}


def social_scan(developer, verify=False):
    urls = SOCIAL_SOURCES.get(developer) or []
    results = []
    for url in urls:
        entry = scan_page(url, verify=verify)
        results.append({"url": url, "reachable": entry["reachable"], "status": entry["status"],
                        "note": entry["note"]})
    reachable = [item for item in results if item["reachable"]]
    return {"value": len(reachable) or None, "unit": "страниц", "source": "соцсети застройщика",
            "collected_at": dt.date.today().isoformat(),
            "method": "http" if reachable else "none", "accuracy": "низкая",
            "comment": ("открытые страницы найдены: " + ", ".join(item["url"] for item in reachable[:3]))
                       if reachable else
                       "страницы соцсетей недоступны из этой сети — данных нет",
            "level": "по компании"}


def search_ads_metric():
    return {"value": None, "unit": "факт", "source": "поисковая реклама (Директ)",
            "collected_at": dt.date.today().isoformat(), "method": "none", "accuracy": "",
            "comment": "факт ведения поисковой рекламы программно не проверяется: поисковые системы "
                       "не отдают выдачу автоматическим запросам. Требуется ручная проверка.",
            "level": "по проекту/бренду"}


def collect(verify=False):
    developers = {}
    for developer, urls in PUBLIC_SOURCES.items():
        scans = [scan_page(url, verify=verify) for url in urls]
        developers[developer] = {
            "sources": scans,
            "metrics": budget_metrics(developer, scans),
            "promo": promo_intensity_metric(),
            "social": social_scan(developer, verify=verify),
            "search_ads": search_ads_metric(),
            "conversion": conversion_metrics(),
        }
    return {"checked_at": dt.date.today().isoformat(),
            "tls_verification": "отключена" if not verify else "включена",
            "developers": developers, "rule": "суммы — только из публичной отчётности, уровень «по компании»; "
                                              "звонки/конверсия/визиты в открытых источниках отсутствуют"}


def main(argv=None):
    setup_console()
    parser = argparse.ArgumentParser(prog="marketing_budget.py",
                                     description="Бюджеты конкурентов и обращения: только открытые данные.")
    parser.add_argument("--client", default="client-svet")
    parser.add_argument("--out", default=None)
    parser.add_argument("--verify-tls", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    payload = collect(verify=args.verify_tls)
    for developer, data in payload["developers"].items():
        reachable = [entry for entry in data["sources"] if entry["reachable"]]
        with_mentions = [entry for entry in data["sources"] if entry["mentions"]]
        print("%-9s источников доступно: %d/%d | с упоминанием расходов: %d | соцсети: %s"
              % (developer, len(reachable), len(data["sources"]), len(with_mentions),
                 data["social"]["value"] if data["social"]["value"] else "—"))
        for entry in with_mentions[:1]:
            print("      %s" % entry["mentions"][0][:140])
    print("Звонки/конверсия/визиты: %s" % CALLS_EXPLANATION)
    out = Path(args.out) if args.out else (WATCH_DIR / "data" / "clients" / args.client / OUT_FILE)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out)
    print("Сохранено: %s" % out)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False)[:1200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
