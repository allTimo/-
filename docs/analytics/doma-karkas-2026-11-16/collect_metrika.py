# -*- coding: utf-8 -*-
"""Аудит счётчика Метрики 22595095 (doma-karkas.ru): настройки + аналитика.

Только чтение (management API + stat/v1/data). Ничего не меняем.
Результат: metrika-*.json рядом со скриптом + компактная сводка в консоль.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.runtime.core import env_value, load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
COUNTER = "22595095"
MGMT = f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}"
STAT = "https://api-metrika.yandex.net/stat/v1/data"

load_env_file()
TOKEN = env_value("YANDEX_OAUTH_TOKEN")
HEADERS = {"Authorization": f"OAuth {TOKEN}", "Accept-Language": "ru"}

# период аудита: 90 дней и предыдущие 90 дней (сравнение)
D1, D2 = "2026-08-19", "2026-11-16"
P1, P2 = "2026-05-21", "2026-08-18"

errors: list[str] = []


def get_json(url: str, timeout: float = 30.0):
    req = urllib.request.Request(url, headers=HEADERS, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore")
        return None, f"HTTP {exc.code}: {body[:220]}"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def stat(metrics, dimensions=(), date1=D1, date2=D2, limit=100, sort=None, filters=None, precision="auto"):
    params = {
        "ids": COUNTER,
        "date1": date1,
        "date2": date2,
        "metrics": ",".join(metrics) if not isinstance(metrics, str) else metrics,
        "limit": str(limit),
        "accuracy": "full",
        "precision": precision,
    }
    if dimensions:
        params["dimensions"] = ",".join(dimensions) if not isinstance(dimensions, str) else dimensions
    params["sort"] = sort or (params.get("dimensions") or params["metrics"]).split(",")[0] if (dimensions or metrics) else "ym:s:visits"
    if filters:
        params["filters"] = filters
    url = f"{STAT}?{urllib.parse.urlencode(params)}"
    data, err = get_json(url)
    time.sleep(0.35)
    if err:
        errors.append(f"stat {params.get('dimensions') or params['metrics']} {date1}..{date2}: {err}")
        return {"error": err, "query": params}
    return data


def rows(payload, dims, metric_names, limit=None):
    out = []
    for row in (payload or {}).get("data") or []:
        d = row.get("dimensions") or []
        m = row.get("metrics") or []
        item = {name: (d[i] if i < len(d) else None) for i, name in enumerate(dims)}
        for i, name in enumerate(metric_names):
            item[name] = m[i] if i < len(m) else None
        out.append(item)
    return out[:limit] if limit else out


def totals(payload, metric_names):
    raw = (payload or {}).get("totals") or []
    flat = raw[0] if raw and isinstance(raw[0], list) else raw
    return {name: (flat[i] if i < len(flat) else None) for i, name in enumerate(metric_names)}


result: dict = {"counter": COUNTER, "period": {"current": [D1, D2], "previous": [P1, P2]}, "collected_at": None}

# --- 1. карточка счётчика и настройки -----------------------------------------
card, err = get_json(MGMT)
result["card"] = card.get("counter") if card else {"error": err}
if card:
    c = card.get("counter", {})
    print("=== счётчик ===")
    for key in ("id", "name", "site", "status", "time_zone_name", "create_time", "code_status",
                "webvisor", "clickmap", "ecommerce", "ecommerce_deduplicator_enabled",
                "autogoals_enabled", "filter_robots", "accuracy", "type", "visitor_cookie_enabled",
                "offline_conversion_enabled", "data_ready", "favorite", "gdpr_agreement_accepted",
                "counter_volume", "mirrors", "currency", "labels"):
        if key in c:
            print(f"  {key}: {json.dumps(c[key], ensure_ascii=False)[:200]}")
    print("  все поля:", ", ".join(sorted(c.keys())))

SECTIONS = {
    "goals": "/goals", "filters": "/filters", "operations": "/operations", "grants": "/grants",
    "segments": "/segments", "user_params": "/user_params", "alerts": "/alerts",
    "data_sources": "/data_sources", "labels": "/labels", "experiments": "/experiments",
    "annotations": "/chart_annotations", "offline_conversions": "/offline_conversions",
    "accounts": "/accounts", "tracking_params": "/tracking_params",
}
section_data: dict = {}
for name, path in SECTIONS.items():
    data, err = get_json(MGMT + path)
    if err:
        section_data[name] = {"error": err}
        errors.append(f"mgmt {name}: {err}")
        print(f"{name}: ошибка {err[:140]}")
        continue
    section_data[name] = data
    for key, value in data.items():
        if isinstance(value, list):
            print(f"{name}: {len(value)}")
        else:
            print(f"{name}.{key}: {json.dumps(value, ensure_ascii=False)[:120]}")
    time.sleep(0.2)
result["sections"] = section_data

goals = section_data.get("goals", {}).get("goals") or []
result["goals"] = goals
print("\n=== цели:", len(goals), "===")
for g in goals:
    print(f"  {g.get('id')} | {str(g.get('name'))[:48]} | type={g.get('type')} | "
          f"favorite={g.get('is_favorite')} | steps={len(g.get('steps') or [])}")

# --- 2. итоги по периодам ------------------------------------------------------
BASE_METRICS = ["ym:s:visits", "ym:s:users", "ym:s:pageviews", "ym:s:bounceRate",
                "ym:s:pageDepth", "ym:s:avgVisitDurationSeconds", "ym:s:robotPercentage"]
cur = stat(BASE_METRICS)
prev = stat(BASE_METRICS, date1=P1, date2=P2)
result["totals_current"] = totals(cur, BASE_METRICS)
result["totals_previous"] = totals(prev, BASE_METRICS)
print("\n=== итоги 90 дней ===")
print("  текущий:", result["totals_current"])
print("  прошлый:", result["totals_previous"])

# динамика по дням
daily = stat(["ym:s:visits", "ym:s:bounceRate", "ym:s:goal" + str(goals[0]["id"]) + "reaches"] if goals else ["ym:s:visits"],
             dimensions=["ym:s:date"], limit=120, sort="ym:s:date")
result["daily"] = rows(daily, ["date"], ["visits"]) if "error" not in (daily or {}) else []
# сохраняем как есть для дальнейшего анализа
result["daily_raw"] = daily

# --- 3. ключевые цели: конверсии по периодам ----------------------------------
MACRO_HINTS = ("заказ", "оплат", "звонок", "лид", "заявк", "форм", "форм")
goal_ids = [g.get("id") for g in goals if isinstance(g.get("id"), int)]
metrics_all = [f"ym:s:goal{gid}reaches" for gid in goal_ids]
metrics_conv = [f"ym:s:goal{gid}conversionRate" for gid in goal_ids]


def batched(items, size=10):
    for i in range(0, len(items), size):
        yield items[i:i + size]


goal_reaches: dict = {}
for chunk in batched(metrics_all):
    payload = stat(chunk, limit=1)
    if "error" in (payload or {}):
        continue
    t = totals(payload, chunk)
    goal_reaches.update(t)
goal_reaches_prev: dict = {}
for chunk in batched(metrics_all):
    payload = stat(chunk, limit=1, date1=P1, date2=P2)
    if "error" in (payload or {}):
        continue
    goal_reaches_prev.update(totals(payload, chunk))

conv_rate: dict = {}
for chunk in batched(metrics_conv):
    payload = stat(chunk, limit=1)
    if "error" in (payload or {}):
        continue
    conv_rate.update(totals(payload, chunk))

result["goal_reaches"] = goal_reaches
result["goal_reaches_previous"] = goal_reaches_prev
result["goal_conversion_rate"] = conv_rate

print("\n=== достижения целей (90 дней | прошлые 90) ===")
for g in goals:
    gid = g.get("id")
    key = f"ym:s:goal{gid}reaches"
    print(f"  {gid:>4} | {str(g.get('name'))[:42]:42} | {goal_reaches.get(key)} | {goal_reaches_prev.get(key)}")

# --- 4. разбивки ---------------------------------------------------------------
def dim_report(dims, metrics, limit, sort, date1=D1, date2=D2, label=""):
    payload = stat(metrics, dimensions=dims, limit=limit, sort=sort, date1=date1, date2=date2)
    data = {"dims": dims, "metrics": metrics, "rows": rows(payload, dims, metrics) if "error" not in (payload or {}) else [],
            "error": (payload or {}).get("error") if isinstance(payload, dict) else None}
    if data["error"]:
        print(f"  {label or dims[0]}: ОШИБКА {str(data['error'])[:150]}")
    return data


KEY_GOALS = result.get("key_goals") or []

splits: dict = {}
print("\n=== разбивки ===")

# источники трафика
splits["traffic_source"] = dim_report(
    ["ym:s:lastsignTrafficSource"], ["ym:s:visits", "ym:s:users", "ym:s:bounceRate", "ym:s:pageDepth"], 30, "-ym:s:visits",
    label="traffic_source")
print("  traffic_source:", [(r.get("ym:s:lastsignTrafficSource"), r.get("ym:s:visits")) for r in splits["traffic_source"]["rows"][:8]])

# поисковики/каналы
splits["search_engine"] = dim_report(
    ["ym:s:lastsignSearchEngine"], ["ym:s:visits", "ym:s:bounceRate"], 30, "-ym:s:visits", label="search_engine")

# устройства
splits["device"] = dim_report(
    ["ym:s:deviceCategory"], ["ym:s:visits", "ym:s:bounceRate", "ym:s:pageDepth", "ym:s:avgVisitDurationSeconds"],
    10, "-ym:s:visits", label="device")
print("  device:", splits["device"]["rows"])

# посадочные
splits["landing"] = dim_report(
    ["ym:s:startURL"], ["ym:s:visits", "ym:s:bounceRate", "ym:s:pageDepth"], 60, "-ym:s:visits", label="landing")
print("  top landing:", [(str(r.get("ym:s:startURL"))[-40:], r.get("ym:s:visits")) for r in splits["landing"]["rows"][:10]])

# города
splits["geo"] = dim_report(
    ["ym:s:regionCity"], ["ym:s:visits", "ym:s:bounceRate"], 40, "-ym:s:visits", label="geo")
print("  top geo:", [(r.get("ym:s:regionCity"), r.get("ym:s:visits")) for r in splits["geo"]["rows"][:12]])

# поисковые фразы
splits["search_phrase"] = dim_report(
    ["ym:s:searchPhrase"], ["ym:s:visits", "ym:s:bounceRate"], 200, "-ym:s:visits", label="search_phrase")
print("  фраз с трафиком:", len(splits["search_phrase"]["rows"]))

# кампании Директа (имя кампании в Метрике)
for dim_attr in ("ym:s:lastDirectClickOrderName", "ym:s:lastsignDirectClickOrderName", "ym:s:lastDirectClickOrder"):
    probe = stat(["ym:s:visits"], dimensions=[dim_attr], limit=3)
    if "error" not in (probe or {}):
        splits["direct_campaign"] = dim_report(
            [dim_attr], ["ym:s:visits", "ym:s:bounceRate"], 40, "-ym:s:visits", label=dim_attr)
        print("  direct_campaign по", dim_attr, ":", [(str(r.get(dim_attr))[:35], r.get("ym:s:visits")) for r in splits["direct_campaign"]["rows"][:10]])
        break
    else:
        print(f"  {dim_attr}: {str(probe.get('error'))[:120]}")

# UTM-разметка
utm_dims = ["ym:s:lastsignUTMSource", "ym:s:lastsignUTMMedium", "ym:s:lastsignUTMCampaign"]
probe = stat(["ym:s:visits"], dimensions=utm_dims, limit=30, sort="-ym:s:visits")
if "error" not in (probe or {}):
    splits["utm"] = {"dims": utm_dims, "metrics": ["ym:s:visits"],
                     "rows": rows(probe, utm_dims, ["ym:s:visits"])}
    print("  utm:", [(r.get("ym:s:lastsignUTMSource"), r.get("ym:s:lastsignUTMMedium"),
                      r.get("ym:s:lastsignUTMCampaign"), r.get("ym:s:visits"))
                     for r in splits["utm"]["rows"][:10]])
else:
    alt = ["ym:s:UTMSource", "ym:s:UTMMedium", "ym:s:UTMCampaign"]
    probe2 = stat(["ym:s:visits"], dimensions=alt, limit=30, sort="-ym:s:visits")
    if "error" not in (probe2 or {}):
        splits["utm"] = {"dims": alt, "metrics": ["ym:s:visits"], "rows": rows(probe2, alt, ["ym:s:visits"])}
        print("  utm(alt):", [tuple(list(r.values())[:4]) for r in splits["utm"]["rows"][:8]])
    else:
        splits["utm"] = {"error": str(probe.get("error"))[:200], "alt_error": str(probe2.get("error"))[:200]}
        print("  utm: ошибка", splits["utm"])

# разбивка источников по ключевым целям
macro = [g for g in goals if any(h in str(g.get("name", "")).lower() for h in MACRO_HINTS)]
result["macro_goals"] = [{"id": g.get("id"), "name": g.get("name")} for g in macro]
print("\n=== макроцели-кандидаты:", result["macro_goals"])

if macro:
    mm = [f"ym:s:goal{g['id']}reaches" for g in macro[:8]]
    splits["source_goals"] = dim_report(
        ["ym:s:lastsignTrafficSource"], ["ym:s:visits"] + mm, 20, "-ym:s:visits", label="source_goals")
    if splits["source_goals"]["rows"]:
        print("  источники × макроцели:")
        for r in splits["source_goals"]["rows"][:8]:
            print("   ", r.get("lastsignTrafficSource"), {k: v for k, v in r.items() if k.startswith("ym:s:goal")})

result["splits"] = splits
result["errors"] = errors
result["collected_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")

(HERE / "metrika-audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nошибок запросов:", len(errors), "-> metrika-audit.json")
for e in errors[:12]:
    print("  !", e[:180])
