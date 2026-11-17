# -*- coding: utf-8 -*-
"""Корректировки ставок Директа с обязательным SelectionCriteria.Levels (только чтение)."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\Users\Артем\Desktop\тестDH\marketing-agents")
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client as direct  # noqa: E402
from skills.runtime.core import load_env_file  # noqa: E402

HERE = Path(__file__).resolve().parent
load_env_file()
HEADERS = direct.build_headers()


def call(service: str, body: dict) -> dict:
    req = urllib.request.Request(f"https://api.direct.yandex.com/json/v5/{service}",
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    for k, v in HEADERS.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read().decode("utf-8", "ignore")[:300]}


out: dict = {}
for level in ("CAMPAIGN", "AD_GROUP"):
    res = call("bidmodifiers", {"method": "get", "params": {
        "SelectionCriteria": {"Levels": [level]},
        "FieldNames": ["Id", "CampaignId", "AdGroupId", "Level", "Type"],
        "Page": {"Limit": 5000}}})
    got = (res.get("result", {}) or {}).get("BidModifiers", []) if isinstance(res, dict) else []
    out[level] = got
    print(f"{level}: {len(got)} | ошибка: {str(res.get('error') or res.get('body') or '')[:160]}")
    for m in got[:10]:
        print("   ", json.dumps(m, ensure_ascii=False)[:220])

(HERE / "direct-bidmodifiers.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("сохранено: direct-bidmodifiers.json")
