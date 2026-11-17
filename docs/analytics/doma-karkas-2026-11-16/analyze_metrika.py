# -*- coding: utf-8 -*-
"""Анализ Метрики 22595095: срезы под аудит конверсии и находки (только чтение).

Читает metrika-audit.json (настройки, цели, итоги) и добирает срезы stat/v1/data
с конверсиями в макроцели. Результат: metrika-findings.json + сводка в консоль.
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
STAT = "https://api-metrika.yandex.net/stat/v1/data"
D1, D2 = "2026-08-19", "2026-11-16"
P1, P2 = "2026-05-21", "2026-08-18"

load_env_file()
TOKEN = env_value("YANDEX_OAUTH_TOKEN")
HEADERS = {"Authorization": f"OAuth {TOKEN}", "Accept-Language": "ru"}

GOAL_LEAD, GOAL_LID = 41224933, 309041787          # Звонок, Лид
GOAL_ORDER, GOAL_PAID, GOAL_CANCEL, GOAL_SPAM = 595094381, 595094382, 595094384, 595094383
GOAL_ORDERFORM, GOAL_FORMS = 309041783, 297819512  # Форма Заказать строительство, Отправка всех форм

METRIC_NAMES = ["visits", "users", "bounceRate", "pageDepth",
                "g_call", "g_lid", "g_order", "g_paid", "g_cancel", "g_spam"]
METRICS = ["ym:s:visits", "ym:s:users", "ym:s:bounceRate", "ym:s:pageDepth",
           f"ym:s:goal{GOAL_LEAD}reaches", f"ym:s:goal{GOAL_LID}reaches",
           f"ym:s:goal{GOAL_ORDER}reaches", f"ym:s:goal{GOAL_PAID}reaches",
           f"ym:s:goal{GOAL_CANCEL}reaches", f"ym:s:goal{GOAL_SPAM}reaches"]
errors: list[str] = []


def nm(value):
    if isinstance(value, dict):
        return value.get("name") or value.get("url") or value.get("id")
    return value


def stat(metrics, dimensions=(), date1=D1, date2=D2, limit=100, sort=None, filters=None):
    params = {"ids": COUNTER, "date1": date1, "date2": date2, "limit": str(limit), "accuracy": "full"}
    if dimensions:
        params["dimensions"] = ",".join(dimensions)
    params["metrics"] = ",".join(metrics)
    params["sort"] = sort or (dimensions[0] if dimensions else metrics[0])
    if filters:
        params["filters"] = filters
    url = f"{STAT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err = f"HTTP {exc.code}: {exc.read().decode('utf-8','ignore')[:200]}"
        errors.append(f"{dimensions or metrics} :: {err}")
        return {"error": err, "data": []}
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{dimensions or metrics} :: {exc}")
        return {"error": str(exc), "data": []}
    time.sleep(0.35)
    return payload


def to_rows(payload, dims, names):
    out = []
    for row in payload.get("data") or []:
        d = [nm(v) for v in (row.get("dimensions") or [])]
        m = row.get("metrics") or []
        item = {n: (d[i] if i < len(d) else None) for i, n in enumerate(dims)}
        for i, n in enumerate(names):
            item[n] = m[i] if i < len(m) else None
        out.append(item)
    return out


def tot(payload, names):
    raw = payload.get("totals") or []
    flat = raw[0] if raw and isinstance(raw[0], list) else raw
    return {n: (flat[i] if i < len(flat) else None) for i, n in enumerate(names)}


audit = json.loads((HERE / "metrika-audit.json").read_text(encoding="utf-8"))
findings: dict = {"period": [D1, D2], "previous": [P1, P2]}

goals = audit.get("goals") or []
reaches = {int(k.replace("ym:s:goal", "").replace("reaches", "")): v
           for k, v in (audit.get("goal_reaches") or {}).items() if isinstance(k, str) and "reaches" in k}
reaches_prev = {int(k.replace("ym:s:goal", "").replace("reaches", "")): v
                for k, v in (audit.get("goal_reaches_previous") or {}).items() if isinstance(k, str) and "reaches" in k}

# --- цели: макро/микро, мертвые, дубли ----------------------------------------
MICRO_TYPES = {"number", "action", "social"}
dead, macro, micro = [], [], []
for g in goals:
    gid, name, gtype = g.get("id"), str(g.get("name")), str(g.get("type"))
    reach = reaches.get(gid)
    item = {"id": gid, "name": name, "type": gtype, "reaches_90d": reach,
            "reaches_prev90": reaches_prev.get(gid), "favorite": g.get("is_favorite")}
    if gtype in MICRO_TYPES:
        micro.append(item)
    else:
        macro.append(item)
    if not reach:
        dead.append(item)

findings["goals"] = {"all": [{"id": g.get("id"), "name": g.get("name"), "type": g.get("type")} for g in goals],
                     "macro": macro, "micro": micro, "dead_90d": dead,
                     "count": len(goals), "dead_count": len(dead)}
print(f"=== цели: всего {len(goals)}, макро {len(macro)}, микро {len(micro)}, без достижений за 90 дней: {len(dead)}")
print("  мертвые:", [(d['id'], d['name'][:38], d['type']) for d in dead])
print("  макро с достижениями:", [(m['id'], m['name'][:32], m['reaches_90d']) for m in macro if m['reaches_90d']])

# --- срезы с CRM-целями --------------------------------------------------------
SPLITS = {
    "source": ["ym:s:lastsignTrafficSource"],
    "channel": ["ym:s:lastsignTrafficSource", "ym:s:lastsignSearchEngine"],
    "campaign": ["ym:s:lastDirectClickOrderName"],
    "device": ["ym:s:deviceCategory"],
    "geo": ["ym:s:regionCity"],
    "landing": ["ym:s:startURL"],
    "phrase": ["ym:s:searchPhrase"],
    "utm_source": ["ym:s:lastsignUTMSource"],
    "utm_medium": ["ym:s:lastsignUTMMedium"],
    "utm_campaign": ["ym:s:lastsignUTMCampaign"],
    "age": ["ym:s:ageInterval"],
    "gender": ["ym:s:gender"],
}
LIMITS = {"source": 20, "channel": 25, "campaign": 40, "device": 6, "geo": 40, "landing": 60,
          "phrase": 60, "utm_source": 25, "utm_medium": 15, "utm_campaign": 40, "age": 10, "gender": 5}
SORT = {"geo": "-g_order", "landing": "-ym:s:visits", "phrase": "-ym:s:visits",
        "utm_campaign": "-ym:s:visits", "campaign": "-ym:s:visits"}

splits: dict = {}
for key, dims in SPLITS.items():
    sort = SORT.get(key, "-" + METRICS[0])
    if key in ("geo", "landing", "phrase"):
        sort = "-ym:s:visits"
    payload = stat(METRICS, dims, limit=LIMITS.get(key, 30), sort=sort)
    if payload.get("error"):
        print(f"  {key}: ОШИБКА {payload['error'][:120]}")
        splits[key] = {"error": payload["error"], "rows": []}
        continue
    rows = to_rows(payload, [d.split(":")[-1] for d in dims], METRIC_NAMES)
    for r in rows:
        r["order_per_1000"] = round((r.get("g_order") or 0) / r["visits"] * 1000, 2) if r.get("visits") else None
        r["cr_order_pct"] = round((r.get("g_order") or 0) / r["visits"] * 100, 3) if r.get("visits") else None
    splits[key] = {"dims": dims, "rows": rows, "totals": tot(payload, METRIC_NAMES)}
    print(f"  {key}: строк {len(rows)}; итог: {splits[key]['totals']}")

findings["splits"] = splits

# --- страницы: отказы и воронка по путям ---------------------------------------
paths = stat(["ym:s:pageviews", "ym:s:users", "ym:s:bounceRate", "ym:s:avgVisitDurationSeconds"],
             ["ym:s:pagePath"], limit=40, sort="-ym:s:pageviews")
findings["pages"] = {"rows": to_rows(paths, ["pagePath"], ["pageviews", "users", "bounceRate", "avgVisitDurationSeconds"])}
print("\n=== страницы (топ-15 по просмотрам) ===")
for r in findings["pages"]["rows"][:15]:
    print(f"  {r['pagePath'][:52]:52} | просмотры {r['pageviews']:>7} | отказы {r['bounceRate']:.1f}% | время {r['avgVisitDurationSeconds']:.0f} c")

# --- устройства × посадочные (мобильная проблема) ------------------------------
dev_landing = stat(METRICS, ["ym:s:deviceCategory", "ym:s:startURL"], limit=40, sort="-ym:s:visits")
findings["device_landing"] = {"rows": to_rows(dev_landing, ["device", "startURL"], METRIC_NAMES)}

# --- информационные запросы (кандидаты в минус) --------------------------------
INFO_HINTS = ("как ", "чем ", "какой ", "что такое", "своими руками", "схема", "чертеж", "чертёж",
              "расчет", "расчёт", "калькулятор", "гост", "снип", "спнп", "отмостка", "стяжка", "утеплитель",
              "мауэрлат", "технология", "инструкция", "фото", "видео", "бесплатно", "работа", "вакансия",
              "своими", "пошагов", "ошибки", "отзывы", "форум", "сравнение", "или ")
phrases = splits.get("phrase", {}).get("rows") or []
info = [p for p in phrases if any(h in str(p.get("searchPhrase", "")).lower() for h in INFO_HINTS)]
findings["info_phrases"] = info
print(f"\n=== информационные запросы среди топ-{len(phrases)}: {len(info)} ===")
for p in info[:15]:
    print(f"  {str(p.get('searchPhrase'))[:60]:60} | визиты {p['visits']:.0f} | отказы {p['bounceRate']:.0f}% | заказы {p.get('g_order')}")

# --- фильтры / сегменты / операции (настройки) ---------------------------------
findings["filters"] = audit.get("sections", {}).get("filters", {})
findings["segments"] = audit.get("sections", {}).get("segments", {})
findings["card"] = audit.get("card")
findings["errors"] = errors
findings["meta"] = {"collected_at": audit.get("collected_at"), "source": "Яндекс.Метрика stat/v1/data + management/v1"}

(HERE / "metrika-findings.json").write_text(json.dumps(findings, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nошибок:", len(errors), "-> metrika-findings.json")
