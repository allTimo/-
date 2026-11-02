#!/usr/bin/env python3
r"""budget_sources.py - маркетинговые бюджеты конкурентов: Keys.so API, SpyWords API, импорт выгрузок.

Решение пользователя: бюджеты брать из SpyWords и Keys.so.

ВАЖНО (правило честности): бюджеты этих сервисов — ОЦЕНКИ СЕРВИСА, а не фактические расходы
застройщика. Поэтому метрика всегда содержит слова «оценка сервиса» и поле accuracy, а не
подаётся как реальный расход.

Ключи: только локально — переменные окружения KEYSSO_TOKEN / SPYWORDS_TOKEN
или config/secrets.local.yaml (в репозиторий не коммитится; рядом лежит .example).
Без ключа честный статус «ключ не задан», ничего не выдумываем.

Импорт выгрузок работает СРАЗУ, без токенов: положите CSV/TSV из кабинета сервиса в
01-competitor-watch/inbox/budgets/ (utf-8-sig, cp1251 или tab-разделитель).

Keys.so (публичная документация https://apidoc.keys.so):
  хост https://api.keys.so, авторизация заголовком X-Keyso-TOKEN, лимит 10 запросов в 10 секунд;
  контекстная реклама: /report/simple/context/ads, /keywords, /concurents, /ads/links,
  архивы по месяцам (/ads/archive/months), групповые отчёты (/report/group/...).
  В ответе есть adCost/adcost — оценка затрат; стандартные параметры base, domain, current_page,
  per_page, sort (field|direction).

SpyWords (https://spywords.ru/api_start.php): доступ по токену (выдаётся по запросу в поддержку),
данные в формате TSV (разделитель tab) в кодировке Windows-1251. Официальный MCP-сервер подключается
опционально и вручную: держать его постоянно дорого (схемы инструментов висят в контексте).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import cwlib as cw

WATCH_DIR = Path(__file__).resolve().parent.parent
INBOX = WATCH_DIR / "inbox" / "budgets"
SECRETS = WATCH_DIR / "config" / "secrets.local.yaml"
OUT_FILE = "marketing-budget-estimates.json"          # внутренний артефакт (не для панели)
BUDGETS_SUBDIR = "budgets"                             # срезы для панели: budgets/<YYYY-MM-DD>.json
PROJECT_COLUMN_MARKERS = ("domain", "домен", "проект", "project", "жк", "сайт", "site")
PERIOD_COLUMN_MARKERS = ("period", "период", "месяц", "month", "дата")
STATUS_OK, STATUS_NO_KEY, STATUS_NO_DOMAIN = "ok", "no_key", "no_domain"
# имена метрик в профиле — как в карте панели (денежная метрика честно называется estimate)
METRIC_NAMES = ("marketing_budget_estimate_rub", "marketing_ads_count", "marketing_keywords_count",
                "marketing_landings_count", "marketing_period", "marketing_source",
                "marketing_method")
KEYSSO_HOST = "https://api.keys.so"
SPYWORDS_HOST = "https://spywords.ru"
KEYSSO_HEADER = "X-Keyso-TOKEN"
RATE_LIMIT_DELAY = 1.05          # Keys.so: 10 запросов в 10 секунд
DEFAULT_BASE = "msk"
KEYSSO_REPORTS = {
    "ads": "/report/simple/context/ads",
    "keywords": "/report/simple/context/keywords",
    "competitors": "/report/simple/context/concurents",
    "landings": "/report/simple/context/ads/links",
    "ads_archive": "/report/simple/context/ads/archive",
    "ads_months": "/report/simple/context/ads/archive/months",
    "group_list": "/report/group/list",
}
MONEY_KEYS = ("adcost", "cost", "budget", "spend", "затраты", "бюджет", "расход")
ADS_KEYS = ("ads", "ads_count", "adscount", "объявлен")
KEYWORD_KEYS = ("keywords", "keys", "cnt", "count", "фраз", "ключев")
LANDING_KEYS = ("links", "url", "urls", "sitepages", "посадочн")
NO_TOKEN_STATUS = "ключ не задан"


def setup_console():
    cw.setup_console()


# --------------------------------------------------------------------------
# ключи
# --------------------------------------------------------------------------

def load_secrets(env_names=("KEYSSO_TOKEN", "SPYWORDS_TOKEN")):
    """Ключи: окружение важнее файла. Файл — config/secrets.local.yaml (не коммитим)."""
    secrets = {"source": "не заданы", "values": {}}
    if SECRETS.exists():
        try:
            parsed = cw.parse_simple_yaml(SECRETS) or {}
            for name in env_names:
                value = parsed.get(name) or (parsed.get("tokens") or {}).get(name)
                if value:
                    secrets["values"][name] = str(value)
                    secrets["source"] = str(SECRETS)
        except Exception:
            pass
    for name in env_names:
        if os.environ.get(name):
            secrets["values"][name] = os.environ[name]
            secrets["source"] = "переменные окружения"
    return secrets


def token_for(name, secrets=None):
    secrets = secrets or load_secrets()
    return secrets["values"].get(name) or ""


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def http_json(url, headers=None, params=None, timeout=40):
    query = ("?" + urllib.parse.urlencode(params)) if params else ""
    request = urllib.request.Request(url + query, method="GET",
                                     headers={"User-Agent": "dsh-budget-agent/1.0",
                                              "Accept": "application/json",
                                              **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8", "replace")
    return json.loads(payload)


# --------------------------------------------------------------------------
# Keys.so
# --------------------------------------------------------------------------

def keysso_request(path, params, token, host=KEYSSO_HOST, fetch=None, pause=RATE_LIMIT_DELAY):
    """Запрос к Keys.so с токеном в заголовке X-Keyso-TOKEN."""
    if not token:
        return {"status": NO_TOKEN_STATUS, "rows": [], "url": host + path}
    url = host + path
    if fetch is None:
        time.sleep(pause)                      # вежливо: не чаще 10 запросов в 10 секунд
        try:
            payload = http_json(url, headers={KEYSSO_HEADER: token}, params=params)
        except Exception as exc:
            return {"status": "ошибка запроса", "note": str(exc)[:160], "rows": [], "url": url}
    else:
        try:
            payload = fetch(url, params, token)
        except Exception as exc:
            return {"status": "ошибка запроса", "note": str(exc)[:160], "rows": [], "url": url}
    rows = payload if isinstance(payload, list) else (
        payload.get("data") or payload.get("rows") or payload.get("items") or [])
    if isinstance(rows, dict):
        rows = [rows]
    return {"status": "ok" if rows else "пусто", "rows": rows, "url": url,
            "raw_keys": sorted(payload.keys())[:10] if isinstance(payload, dict) else []}


def keysso_domain_report(domain, token, base=DEFAULT_BASE, kinds=("ads", "keywords", "competitors",
                                                                 "landings"), fetch=None, per_page=25):
    """Контекстная реклама конкурента по домену: объявления, ключи, конкуренты, посадочные."""
    results = {}
    for kind in kinds:
        path = KEYSSO_REPORTS.get(kind)
        if not path:
            continue
        params = {"base": base, "domain": domain, "current_page": 1, "per_page": per_page}
        results[kind] = keysso_request(path, params, token, fetch=fetch)
    return results


def keysso_months(domain, token, base=DEFAULT_BASE, fetch=None):
    """Архив по месяцам — для динамики бюджетов."""
    return keysso_request(KEYSSO_REPORTS["ads_months"], {"base": base, "domain": domain},
                          token, fetch=fetch)


def pick_number(row, keys, default=None):
    for key, value in (row or {}).items():
        lowered = str(key).lower()
        if any(marker in lowered for marker in keys) and isinstance(value, (int, float, str)):
            text = str(value).replace(" ", "").replace("\u00a0", "").replace(",", ".")
            try:
                return float(text)
            except ValueError:
                continue
    return default


def summarize_rows(rows, source, method, period=None, note=""):
    """Сводка по строкам: оценка бюджета, объявления, ключи, посадочные."""
    money, ads, keywords, landings, domains = 0.0, 0, 0, set(), set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        money += pick_number(row, MONEY_KEYS, 0) or 0
        ads += int(pick_number(row, ADS_KEYS, 0) or 0)
        keywords += int(pick_number(row, KEYWORD_KEYS, 0) or 0)
        for key, value in row.items():
            lowered = str(key).lower()
            if any(marker in lowered for marker in LANDING_KEYS) and isinstance(value, str) and \
                    value.startswith("http"):
                landings.add(value)
            if "domain" in lowered and isinstance(value, str):
                domains.add(value)
    return {"budget_estimate_rub": round(money) if money else None,
            "ads_count": ads or None, "keywords_count": keywords or None,
            "landings_count": len(landings) or None, "domains_count": len(domains) or None,
            "rows": len(rows), "source": source, "method": method, "period": period, "note": note}


def mark_demo(projects):
    """Помечаем записи как демонстрационный образец (панель покажет бейдж «демо»)."""
    for item in projects:
        item["demo"] = True
        item["accuracy"] = "демо-образец: оценка сервиса (не данные аккаунта)"
    return projects


def budget_metrics(summary, collected_at=None, source_label=""):
    """Метрики профиля. ВСЕГДА «оценка сервиса», не фактический расход."""
    collected = collected_at or dt.date.today().isoformat()
    source = source_label or summary.get("source") or "Keys.so"
    accuracy = "оценка сервиса (не факт расхода)"
    def metric(value, unit, comment):
        return {"value": value, "unit": unit, "source": source, "collected_at": collected,
                "method": summary.get("method") or "api", "accuracy": accuracy,
                "comment": comment, "period": summary.get("period")}
    base_metrics = {
        "marketing_budget_estimate_rub": metric(
            summary.get("budget_estimate_rub"), "₽/период",
            "оценка сервиса по данным контекстной рекламы; НЕ фактический расход застройщика"
            if summary.get("budget_estimate_rub") is not None else
            (summary.get("note") or "сервис не отдал оценку затрат по этому домену")),
        "marketing_ads_count": metric(summary.get("ads_count"), "объявлений", "оценка сервиса"),
        "marketing_keywords_count": metric(summary.get("keywords_count"), "фраз", "оценка сервиса"),
        "marketing_landings_count": metric(summary.get("landings_count"), "посадочных",
                                           "оценка сервиса: уникальные посадочные страницы"),
        # служебные метрики контракта панели — всегда заполнены
        "marketing_period": metric(summary.get("period") or dt.date.today().strftime("%Y-%m"),
                                   "период", "период, за который собраны данные"),
        "marketing_source": metric(source, "", "источник данных о бюджете"),
        "marketing_method": metric(summary.get("method") or "api", "",
                                   "способ получения: csv | api | mcp (белый список панели)"),
    }
    return base_metrics


# --------------------------------------------------------------------------
# SpyWords
# --------------------------------------------------------------------------

def spywords_parse(text, encoding="cp1251"):
    """SpyWords отдаёт TSV в Windows-1251."""
    if isinstance(text, bytes):
        text = text.decode(encoding, "replace")
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return {"columns": [], "rows": []}
    columns = [col.strip() for col in lines[0].split("\t")]
    rows = []
    for line in lines[1:]:
        cells = line.split("\t")
        rows.append({columns[index] if index < len(columns) else "col%d" % index: value
                     for index, value in enumerate(cells)})
    return {"columns": columns, "rows": rows}


def spywords_request(method, params, token, host=SPYWORDS_HOST, fetch=None, body=None,
                     encoding="cp1251"):
    """Запрос к API SpyWords. Имена методов уточняются после выдачи токена (в песочнице)."""
    if not token:
        return {"status": NO_TOKEN_STATUS, "rows": [], "columns": [], "method": method}
    url = "%s/api/%s" % (host.rstrip("/"), method.lstrip("/"))
    if fetch is None:
        query = ("?" + urllib.parse.urlencode(params)) if params else ""
        request = urllib.request.Request(url + query, method="POST" if body else "GET",
                                         data=body, headers={
                                             "User-Agent": "dsh-budget-agent/1.0",
                                             "Authorization": "Bearer %s" % token,
                                             "Accept": "text/tab-separated-values"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode(encoding, "replace")
        except Exception as exc:
            return {"status": "ошибка запроса", "note": str(exc)[:160], "rows": [], "columns": [],
                    "method": method}
    else:
        try:
            text = fetch(url, params, token)
        except Exception as exc:
            return {"status": "ошибка запроса", "note": str(exc)[:160], "rows": [], "columns": [],
                    "method": method}
    parsed = spywords_parse(text, encoding)
    return {"status": "ok" if parsed["rows"] else "пусто", "method": method, **parsed}


# --------------------------------------------------------------------------
# импорт выгрузок из кабинета (работает без токенов)
# --------------------------------------------------------------------------

def sniff_text(raw):
    for encoding in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace"), "utf-8(replace)"


DEMO_MARKERS = ("fixtures", "sample", "образец", "demo", "тест")


def is_demo_directory(directory):
    """Демонстрационный образец (а не выгрузка из аккаунта пользователя) — помечаем ЯВНО."""
    text = str(directory or "").lower()
    return any(marker in text for marker in DEMO_MARKERS)


def csv_import(directory=None, source_label="выгрузка из кабинета", demo=None):
    """CSV/TSV из inbox/budgets: колонки распознаются по смыслу.

    demo=True — данные из демонстрационного образца: их нельзя показывать как бюджет конкурента.
    """
    directory = Path(directory) if directory else INBOX
    if not directory.is_dir():
        return {"status": "каталог не найден", "files": [], "rows": [], "source": source_label}
    files, rows = [], []
    for path in sorted(directory.glob("*")):
        if path.suffix.lower() not in (".csv", ".tsv", ".txt"):
            continue
        try:
            raw = path.read_bytes()
        except Exception:
            continue
        text, encoding = sniff_text(raw)
        delimiter = "\t" if (path.suffix.lower() == ".tsv" or text.count("\t") > text.count(";")) else \
            (";" if text.count(";") > text.count(",") else ",")
        reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
        file_rows = []
        for row in reader:
            cleaned = {str(key).strip(): (value or "").strip() for key, value in row.items()
                       if key is not None}
            if any(cleaned.values()):
                file_rows.append(cleaned)
        files.append({"file": path.name, "encoding": encoding, "delimiter": delimiter,
                      "columns": list((file_rows[0] if file_rows else {}).keys()), "rows": len(file_rows)})
        rows.extend(file_rows)
    demo_flag = is_demo_directory(directory) if demo is None else bool(demo)
    if demo_flag:
        source_label = "демо-образец выгрузки"
    return {"status": "ok" if rows else "нет данных", "files": files, "rows": rows,
            "source": source_label, "directory": str(directory), "demo": demo_flag}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def host_of(value):
    """Домен из ссылки или чистого домена."""
    text = str(value or "").strip().lower()
    if not text:
        return ""
    if "//" in text:
        text = urllib.parse.urlparse(text).netloc or text
    text = text.split("/")[0].split("?")[0]
    return text[4:] if text.startswith("www.") else text


def build_project_map(client_id):
    """Карта «домен → канонический проект»: из профилей конкурентов и конфига клиента.

    project = канонический ключ (ровно имя файла профиля, например zhk-mihalkovskiy),
    name = человеческое имя («ЖК Михалковский»).
    """
    mapping = {}
    profiles_dir = WATCH_DIR / "data" / "clients" / str(client_id) / "competitor-profiles"
    if profiles_dir.is_dir():
        for path in sorted(profiles_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8-sig"))
            except Exception:
                continue
            name = data.get("project")
            if not name:
                continue                       # служебные файлы вроде _summary.json
            host = host_of((data.get("developer_site") or {}).get("url"))
            if host:
                mapping[host] = {"project": path.stem, "name": name}
    # конфиг клиента: у конкурентов есть site — пригодится, когда профиля ещё нет
    try:
        import clients as clients_mod
        import discover_competitors as discovery
        config_file = WATCH_DIR / "config" / "clients" / ("%s.yaml" % client_id)
        if config_file.exists():
            config = clients_mod.load_client(config_file)
            for competitor in (config.get("competitors") or []):
                if not isinstance(competitor, dict):
                    continue
                host = host_of(competitor.get("site"))
                if host and host not in mapping:
                    competitor_name = str(competitor.get("name") or "")
                    mapping[host] = {"project": discovery.slugify(competitor_name),
                                     "name": competitor_name}
    except Exception:
        pass
    # явная карта из тонких настроек агента: agent1.competitor_domains: {домен: проект}
    try:
        import cwlib as _cw
        settings = WATCH_DIR.parent / "registry" / "agent-settings" / "agent-1-competitor-watch.yaml"
        if settings.exists():
            parsed = _cw.parse_simple_yaml(settings) or {}
            explicit = ((parsed.get("agent1") or {}).get("competitor_domains") or {})
            for host, project_key in explicit.items():
                if host:
                    mapping[host_of(host)] = {"project": str(project_key),
                                              "name": mapping.get(host_of(host), {}).get("name")
                                                      or str(project_key)}
    except Exception:
        pass
    return mapping


def group_projects(rows, mapping=None, default_project=None):
    """Группируем строки выгрузки по домену и сопоставляем с каноническим проектом.

    В каждой записи три поля: project (канонический ключ или null), name (или null), domain.
    Домен НИКОГДА не подставляется в project.
    """
    mapping = mapping or {}
    groups = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        domain, period = "", ""
        for key, value in row.items():
            lowered = str(key).lower()
            if not domain and any(marker in lowered for marker in PROJECT_COLUMN_MARKERS):
                domain = str(value or "").strip()
            if not period and any(marker in lowered for marker in PERIOD_COLUMN_MARKERS):
                period = str(value or "").strip()
        domain = host_of(domain) or (default_project or "")
        bucket = groups.setdefault(domain, {"rows": [], "period": period})
        bucket["rows"].append(row)
        if period and not bucket["period"]:
            bucket["period"] = period
    projects = []
    for domain, bucket in groups.items():
        summary = summarize_rows(bucket["rows"], "выгрузка/API", "csv")
        matched = mapping.get(domain) or {}
        project_key = matched.get("project")
        note = "" if project_key else ("домен не сопоставлен с проектом: добавьте домен "
                                      "в карточку конкурента")
        projects.append({"project": project_key,
                         "name": matched.get("name"),
                         "domain": domain or None,
                         "budget_rub": summary["budget_estimate_rub"],
                         # панель в разных письмах называла поле и так, и так — отдаём оба ключа
                         "budget_estimate_rub": summary["budget_estimate_rub"],
                         "period": bucket["period"] or summary.get("period") or
                                   dt.date.today().strftime("%Y-%m"),
                         "ads_count": summary["ads_count"],
                         "keywords_count": summary["keywords_count"],
                         "landings_count": summary["landings_count"],
                         "collected_at": dt.date.today().isoformat(),
                         "accuracy": "оценка сервиса (не факт расхода)",
                         "note": note})
    return sorted(projects, key=lambda item: (-(item["budget_rub"] or 0), str(item["domain"] or "")))


def build_slice(projects, source, method, status=STATUS_OK, note="", demo=False):
    """Срез для панели: budgets/<дата>.json в формате договора.

    demo=True — данные из демонстрационного образца; панель показывает бейдж «демо»,
    чтобы число из образца не приняли за бюджет реального конкурента.
    """
    payload = {"source": source, "method": method, "status": status, "note": note,
               "collected_at": dt.date.today().isoformat(), "projects": projects,
               "demo": bool(demo)}
    if demo:
        payload["note"] = ((note + " | ") if note else "") + \
            "ДЕМОНСТРАЦИОННЫЙ ОБРАЗЕЦ выгрузки, не данные аккаунта пользователя"
    return payload


def write_slice(client_id, payload, date=None):
    """Пишем срез в data/clients/<client-id>/budgets/<YYYY-MM-DD>.json (атомарно)."""
    date = date or payload.get("collected_at") or dt.date.today().isoformat()
    path = WATCH_DIR / "data" / "clients" / str(client_id) / BUDGETS_SUBDIR / ("%s.json" % date)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def collect(domain=None, sources=("csv", "keysso", "spywords"), csv_dir=None, base=DEFAULT_BASE,
            fetch=None):
    secrets = load_secrets()
    keysso_token = token_for("KEYSSO_TOKEN", secrets)
    spywords_token = token_for("SPYWORDS_TOKEN", secrets)
    result = {"checked_at": dt.date.today().isoformat(), "domain": domain,
              "secrets_source": secrets["source"],
              "tokens": {"keysso": bool(keysso_token), "spywords": bool(spywords_token)},
              "sources": {}}

    if "csv" in sources:
        imported = csv_import(csv_dir)
        summary = summarize_rows(imported["rows"], imported["source"], "csv")
        result["sources"]["csv"] = {"status": imported["status"], "files": imported["files"],
                                    "summary": summary,
                                    "metrics": budget_metrics(summary, source_label=imported["source"])}
    if "keysso" in sources:
        if not keysso_token:
            result["sources"]["keysso"] = {"status": NO_TOKEN_STATUS, "metrics": budget_metrics(
                {"note": "ключ не задан: задайте KEYSSO_TOKEN или config/secrets.local.yaml",
                 "method": "api"}, source_label="Keys.so (API)")}
        else:
            reports = keysso_domain_report(domain, keysso_token, base=base, fetch=fetch)
            all_rows = [row for data in reports.values() for row in (data.get("rows") or [])]
            summary = summarize_rows(all_rows, "Keys.so (API)", "api",
                                     note="; ".join("%s: %s" % (kind, data["status"])
                                                    for kind, data in reports.items()))
            result["sources"]["keysso"] = {"status": "ok" if all_rows else "пусто",
                                           "reports": {kind: {"status": data["status"],
                                                              "rows": len(data.get("rows") or [])}
                                                       for kind, data in reports.items()},
                                           "summary": summary,
                                           "metrics": budget_metrics(summary, source_label="Keys.so (API)")}
    if "spywords" in sources:
        if not spywords_token:
            result["sources"]["spywords"] = {"status": NO_TOKEN_STATUS, "metrics": budget_metrics(
                {"note": "ключ не задан: задайте SPYWORDS_TOKEN или config/secrets.local.yaml",
                 "method": "api"}, source_label="SpyWords (API)")}
        else:
            data = spywords_request("context/report", {"domain": domain}, spywords_token, fetch=fetch)
            summary = summarize_rows(data.get("rows") or [], "SpyWords (API)", "api")
            result["sources"]["spywords"] = {"status": data["status"], "columns": data.get("columns"),
                                             "summary": summary,
                                             "metrics": budget_metrics(summary, source_label="SpyWords (API)")}
    return result


def main(argv=None):
    setup_console()
    parser = argparse.ArgumentParser(prog="budget_sources.py",
                                     description="Бюджеты конкурентов: Keys.so, SpyWords, импорт CSV.")
    parser.add_argument("--domain", default=None, help="домен конкурента, например rg-dev.ru")
    parser.add_argument("--source", action="append", choices=["csv", "keysso", "spywords"],
                        help="какие источники использовать (по умолчанию все)")
    parser.add_argument("--csv-dir", default=None, help="каталог выгрузок (по умолчанию inbox/budgets)")
    parser.add_argument("--base", default=DEFAULT_BASE, help="регион Keys.so (msk по умолчанию)")
    parser.add_argument("--client", default="client-svet")
    parser.add_argument("--out", default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--demo", action="store_true",
                        help="пометить данные как демонстрационный образец (demo: true)")
    args = parser.parse_args(argv)

    result = collect(domain=args.domain, sources=tuple(args.source or ("csv", "keysso", "spywords")),
                     csv_dir=args.csv_dir, base=args.base)
    print("Ключи: %s | Keys.so: %s | SpyWords: %s"
          % (result["secrets_source"], "есть" if result["tokens"]["keysso"] else NO_TOKEN_STATUS,
             "есть" if result["tokens"]["spywords"] else NO_TOKEN_STATUS))
    for name, data in result["sources"].items():
        summary = data.get("summary") or {}
        print("%-9s статус: %-16s оценка бюджета: %s ₽ | объявлений: %s | фраз: %s"
              % (name, data["status"],
                 cw.fmt_int(summary.get("budget_estimate_rub")) if summary.get("budget_estimate_rub")
                 else "—", summary.get("ads_count") or "—", summary.get("keywords_count") or "—"))
        if name == "csv":
            for file_info in data["files"]:
                print("      файл: %s (%s, разделитель %r, строк %d)"
                      % (file_info["file"], file_info["encoding"], file_info["delimiter"],
                         file_info["rows"]))
    # 1) СРЕЗ ДЛЯ ПАНЕЛИ: data/clients/<client-id>/budgets/<дата>.json (контракт панели)
    imported = csv_import(args.csv_dir)
    project_map = build_project_map(args.client)
    projects = group_projects(imported["rows"], mapping=project_map, default_project=args.domain)
    has_money = any(item["budget_rub"] for item in projects)
    if has_money:
        slice_status = STATUS_OK
    elif not (result["tokens"]["keysso"] or result["tokens"]["spywords"]):
        slice_status = STATUS_NO_KEY
    elif not args.domain:
        slice_status = STATUS_NO_DOMAIN
    else:
        slice_status = STATUS_OK
    is_demo = bool(imported.get("demo")) or bool(args.demo)
    if is_demo:
        mark_demo(projects)
    slice_payload = build_slice(
        projects, "демо-образец выгрузки" if is_demo else "Keys.so / SpyWords / выгрузка из кабинета",
        "csv" if projects else "none", status=slice_status, demo=is_demo,
        note="оценка сервиса, НЕ фактический расход застройщика" if projects
             else "данных нет: нет выгрузки в inbox/budgets и не заданы токены")
    slice_path = write_slice(args.client, slice_payload)
    print("Срез для панели: %s (статус: %s, проектов: %d)" % (slice_path, slice_status, len(projects)))
    for item in projects[:5]:
        print("   %-28s %-12s ₽ за %s | объявлений %s | фраз %s | посадочных %s"
              % (item["project"][:28],
                 cw.fmt_int(item["budget_rub"]) if item["budget_rub"] else "—", item["period"],
                 item["ads_count"] if item["ads_count"] is not None else "—",
                 item["keywords_count"] if item["keywords_count"] is not None else "—",
                 item["landings_count"] if item["landings_count"] is not None else "—"))

    # 2) внутренний артефакт (панель его не читает, конфликта с срезом нет)
    out = Path(args.out) if args.out else (WATCH_DIR / "data" / "clients" / args.client / OUT_FILE)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    result["slice"] = str(slice_path)
    tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out)
    print("Внутренний артефакт: %s" % out)
    if args.json:
        print(json.dumps(result, ensure_ascii=False)[:1200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
