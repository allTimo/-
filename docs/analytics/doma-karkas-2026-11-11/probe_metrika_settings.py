# -*- coding: utf-8 -*-
"""Аудит настроек счётчика Метрики doma-karkas.ru (22595095): что реально настроено.

Только чтение. Печатает компактную сводку по доступным разделам management API.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.runtime.core import env_value, load_env_file  # noqa: E402

COUNTER = "22595095"
BASE = f"https://api-metrika.yandex.net/management/v1/counter/{COUNTER}"
load_env_file()
TOKEN = env_value("YANDEX_OAUTH_TOKEN")


def get(path: str):
    request = urllib.request.Request(
        path, headers={"Authorization": f"OAuth {TOKEN}", "Accept-Language": "ru"}, method="GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read().decode('utf-8', 'ignore')[:160]}"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


print("=== карточка счётчика ===")
data, err = get(BASE)
if err:
    print("  ошибка:", err)
else:
    counter = data.get("counter", {})
    keys = ["id", "name", "site", "status", "create_time", "time_zone_name",
            "visitor_cookie_enabled", "webvisor", "clickmap", "track_hash", "informer",
            "code_status", "accuracy", "type", "favorite", "gdpr_agreement_accepted"]
    for key in keys:
        if key in counter:
            print(f"  {key}: {counter[key]}")
    print("  все поля:", ", ".join(sorted(counter.keys()))[:400])

for label, path in (
    ("Цели", f"{BASE}/goals"),
    ("Фильтры", f"{BASE}/filters"),
    ("Операции", f"{BASE}/operations"),
    ("Доступы (grants)", f"{BASE}/grants"),
    ("Сегменты", f"{BASE}/segments"),
    ("Пользовательские параметры", f"{BASE}/user_params"),
    ("Отчёты-шаблоны", f"{BASE}/reports"),
    ("Метки", f"{BASE}/labels"),
    ("Оповещения", f"{BASE}/alerts"),
    ("Электронная коммерция (data sources)", f"{BASE}/data_sources"),
):
    data, err = get(path)
    if err:
        print(f"{label}: {err}")
        continue
    for key, value in data.items():
        if isinstance(value, list):
            print(f"{label}: {len(value)}")
            for item in value[:8]:
                if isinstance(item, dict):
                    name = item.get("name") or item.get("id") or item.get("type") or "—"
                    extra = []
                    for field in ("type", "status", "user_login", "comment", "attr", "action", "step"):
                        if field in item and item[field] not in (None, ""):
                            extra.append(f"{field}={item[field]}")
                    print(f"    - {name} {'; '.join(extra)}")
        else:
            print(f"{label}.{key}: {value}")
