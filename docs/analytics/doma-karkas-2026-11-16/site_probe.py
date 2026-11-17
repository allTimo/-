# -*- coding: utf-8 -*-
"""РўРµС…РЅРёС‡РµСЃРєР°СЏ Рё РєРѕРЅРІРµСЂСЃРёРѕРЅРЅР°СЏ РїСЂРѕР±Р° СЃР°Р№С‚Р° doma-karkas.ru (С‚РѕР»СЊРєРѕ С‡С‚РµРЅРёРµ)."""
from __future__ import annotations

import json
import re
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
URLS = [
    "https://doma-karkas.ru/",
    "https://doma-karkas.ru/catalog/",
    "https://doma-karkas.ru/catalog/gazobetonnye/",
    "https://doma-karkas.ru/catalog/gazobetonnye/kapri/",
    "https://doma-karkas.ru/catalog/keramicheskie/",
    "https://doma-karkas.ru/proektirovanie/",
    "https://doma-karkas.ru/articles/kreplenie-mauerlata-k-gazobetonu/",
    "https://doma-karkas.ru/kontakty/",
    "https://doma-karkas.ru/ceny/",
]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
ctx = ssl._create_unverified_context()  # локальный прокси с своим сертификатом

result = []
for url in URLS:
    for label, ua in (("desktop", UA), ("mobile", MOBILE_UA)):
        req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Language": "ru-RU,ru;q=0.9"})
        started = time.perf_counter()
        item = {"url": url, "client": label}
        try:
            with urllib.request.urlopen(req, timeout=40, context=ctx) as resp:
                body = resp.read()
                item["status"] = resp.status
                item["ttfb_s"] = round(started and (time.perf_counter() - started), 2)
                item["bytes"] = len(body)
                text = body.decode("utf-8", "ignore")
                item["metrika_code"] = bool(re.search(r"mc\.yandex\.ru|ym\(", text))
                item["metrika_id_ok"] = "22595095" in text
                item["viewport"] = bool(re.search(r'name=["\']viewport', text, re.I))
                item["forms"] = len(re.findall(r"<form", text, re.I))
                item["tel_links"] = len(re.findall(r'href=["\']tel:', text, re.I))
                item["wa_links"] = len(re.findall(r"wa\.me|whatsapp", text, re.I))
                item["tg_links"] = len(re.findall(r"t\.me/", text, re.I))
                item["h1"] = (re.findall(r"<h1[^>]*>(.*?)</h1>", text, re.S | re.I) or [""])[0]
                item["h1"] = re.sub(r"<[^>]+>", " ", item["h1"]).strip()[:120]
                item["title"] = (re.findall(r"<title[^>]*>(.*?)</title>", text, re.S | re.I) or [""])[0].strip()[:120]
                item["jquery"] = "jquery" in text.lower()
                item["bitrix"] = "bitrix" in text.lower()
                item["modal_hints"] = len(re.findall(r"modal|popup|Р·Р°РєР°Р·Р°С‚СЊ Р·РІРѕРЅРѕРє|РѕСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРє", text, re.I))
                item["webp"] = len(re.findall(r"\.webp", text, re.I))
                item["img_total"] = len(re.findall(r"<img", text, re.I))
                item["scripts"] = len(re.findall(r"<script", text, re.I))
                item["css_links"] = len(re.findall(r'rel=["\']stylesheet', text, re.I))
                item["youtube_iframe"] = len(re.findall(r"youtube\.com/embed|player\.vimeo", text, re.I))
                item["calculator"] = bool(re.search(r"РєР°Р»СЊРєСѓР»СЏС‚РѕСЂ|СЂР°СЃСЃС‡РёС‚Р°С‚СЊ СЃС‚РѕРёРјРѕСЃС‚СЊ|СЂР°СЃС‡РµС‚ СЃС‚РѕРёРјРѕСЃС‚Рё", text, re.I))
                item["price_visible"] = bool(re.search(r"РѕС‚\s?\d[\d\s]{4,}\s?(в‚Ѕ|СЂСѓР±)", text, re.I))
                item["quiz"] = bool(re.search(r"РєРІРёР·|РїРѕРґРѕР±СЂР°С‚СЊ РїСЂРѕРµРєС‚|РїРѕРґР±РѕСЂ РїСЂРѕРµРєС‚", text, re.I))
        except urllib.error.HTTPError as exc:
            item.update({"status": exc.code, "error": f"HTTP {exc.code}", "ttfb_s": round(time.perf_counter() - started, 2)})
        except Exception as exc:  # noqa: BLE001
            item.update({"status": None, "error": f"{type(exc).__name__}: {exc}", "ttfb_s": round(time.perf_counter() - started, 2)})
        result.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
        time.sleep(0.4)

(HERE / "site-probe.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nСЃРѕС…СЂР°РЅРµРЅРѕ: site-probe.json")

