#!/usr/bin/env python3
r"""web_search.py - источники веб-поиска для автоподбора конкурентов (задача E).

Два бэкенда, оба возвращают записи в формате ``search_results`` (``name``, ``url``,
``source``), которые дальше понимает ``discover_competitors.build_candidates``:

* ``serper`` — POST ``https://google.serper.dev/search``, ключ ``SERPER_API_KEY``
  (переменная окружения или ``marketing-agents/.env``);
* ``cdp`` — поиск операторским Chrome: страница выдачи открывается через
  ``platforms.cdp_html`` и разбирается ``search_results.parse_html``.

Честность (как в остальном проекте):

* нет ключа, Chrome не поднялся, выдача пустая — бэкенд **сообщает причину** и
  возвращает пустой список; наружу исключение не выходит;
* агрегаторы и соцсети отсеиваются на общем слое ``search_results``;
* ничего не додумывается: только то, что реально вернул поиск.

Точки подмены для тестов — параметры ``post`` (HTTP POST) и ``cdp_html``
(чтение страницы браузером): без них тесты ходили бы в сеть.

Usage:
    python web_search.py --query "ЖК Селигер Сити официальный сайт" --backend auto
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import platforms  # noqa: E402
import search_results  # noqa: E402

SERPER_ENDPOINT = "https://google.serper.dev/search"
SERPER_KEY_ENV = "SERPER_API_KEY"
#: DuckDuckGo в HTML-виде: без ключа и без браузера, капчи не отдаёт (проверено 04.11.2026).
DDG_ENDPOINT = "https://html.duckduckgo.com/html/"
SEARCH_ENGINES = {
    "yandex": "https://yandex.ru/search/?text={query}",
    "google": "https://www.google.com/search?q={query}",
}
BACKENDS = ("auto", "serper", "ddg", "cdp")
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def setup_console():
    platforms.cw.setup_console()


def _post_json(url, payload, headers, timeout=15.0):
    """POST JSON стандартной библиотекой. Отдельная функция — точка подмены в тестах."""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("User-Agent", USER_AGENT)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def _get_text(url, timeout=20.0):
    """GET HTML стандартной библиотекой. Отдельная функция — точка подмены в тестах."""
    request = urllib.request.Request(url, method="GET")
    request.add_header("User-Agent", USER_AGENT)
    request.add_header("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.5")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def ddg_search(query, *, timeout=20.0, get=None):
    """Поиск через HTML-версию DuckDuckGo: без ключа и без браузера.

    Возвращает ``(entries, note)``. Капча/страница проверки результатами не считается.
    """
    fetcher = get or _get_text
    url = DDG_ENDPOINT + "?" + urllib.parse.urlencode({"q": query})
    try:
        html = fetcher(url, timeout)
    except Exception as exc:  # noqa: BLE001 — контракт важнее типа исключения
        return [], "DuckDuckGo: запрос не удался — %s" % str(exc)[:120]
    if not html:
        return [], "DuckDuckGo: пустой ответ"
    lowered = html.lower()
    blocked = ("подтвердите, что вы не робот", "captcha", "are you a robot", "anomaly", "необычный трафик")
    if "result__a" not in lowered and any(marker in lowered for marker in blocked):
        # Проверено 04.11.2026: после серии пакетных запросов DDG отдаёт страницу-аномалию
        # (0 результатов при 14 тыс. знаков). Это блокировка, а не «нет результатов».
        return [], ("DuckDuckGo: заблокировал запросы (страница проверки/аномалии) — "
                    "нужен ключ SERPER_API_KEY или пауза перед повтором")
    entries = search_results.dedupe(search_results.parse_ddg(html))
    if not entries:
        return [], "DuckDuckGo: в выдаче не нашлось ссылок"
    return entries, "DuckDuckGo (HTML): %d ссылок после отсева агрегаторов" % len(entries)


def _env_file_value(name):
    """Значение переменной из ``marketing-agents/.env`` (простой разбор KEY=VALUE)."""
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if not env_file.is_file():
        return ""
    for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def serper_key():
    """Ключ Serper: переменная окружения или ``marketing-agents/.env``."""
    value = os.environ.get(SERPER_KEY_ENV)
    if value:
        return value.strip()
    return _env_file_value(SERPER_KEY_ENV)


def serper_search(query, *, api_key=None, num=10, timeout=15.0, post=None, gl="ru", hl="ru"):
    """Поиск через Serper. Возвращает ``(entries, note)``; без ключа — пусто и причина."""
    key = api_key if api_key is not None else serper_key()
    if not key:
        return [], "Serper: нет ключа %s — поиск не выполнялся" % SERPER_KEY_ENV
    payload = {"q": query, "num": int(num), "gl": gl, "hl": hl}
    poster = post or _post_json
    try:
        raw = poster(SERPER_ENDPOINT, payload, {"X-API-KEY": key}, timeout)
    except urllib.error.HTTPError as exc:
        return [], "Serper: HTTP %s %s (ключ отклонён или кончилась квота)" % (exc.code, exc.reason)
    except Exception as exc:  # noqa: BLE001 — контракт важнее типа исключения
        return [], "Serper: запрос не удался — %s" % str(exc)[:120]
    try:
        data = json.loads(raw)
    except ValueError:
        return [], "Serper: ответ не JSON (первые 100 знаков: %s)" % str(raw)[:100]
    entries = search_results.dedupe(search_results.parse_serper(data))
    if not entries:
        return [], "Serper: в ответе нет результатов (квота или пустой запрос)"
    return entries, "Serper: %d результатов, осталось %d после отсева агрегаторов" % (
        len(data.get("organic") or []), len(entries))


def cdp_search(query, *, engine="yandex", port=9364, wait_ms=9000, headless=True,
               cdp_html=None, launch=None, stop=None):
    """Поиск операторским Chrome. Возвращает ``(entries, note)``.

    ``cdp_html`` — точка подмены в тестах: ``(url, port=..., wait_ms=...) -> html``.
    """
    template = SEARCH_ENGINES.get(engine)
    if not template:
        return [], "CDP: неизвестная поисковая система «%s» (есть: %s)" % (
            engine, ", ".join(sorted(SEARCH_ENGINES)))
    url = template.format(query=urllib.parse.quote_plus(query))
    reader = cdp_html or platforms.cdp_html
    process = profile = None
    if cdp_html is None:
        launcher = launch or platforms.launch_chrome
        stopper = stop or platforms.stop_chrome
        try:
            process, profile = launcher(port=port, headless=headless)
        except Exception as exc:  # noqa: BLE001 — браузера может не быть
            return [], ("CDP: Chrome не запустился — %s (в песочнице это ожидаемо; "
                        "нужен запуск с полными правами)" % str(exc)[:120])
    try:
        html = reader(url, port=port, wait_ms=wait_ms)
    except Exception as exc:  # noqa: BLE001
        return [], "CDP: страница выдачи не открылась — %s" % str(exc)[:120]
    finally:
        if cdp_html is None and process is not None:
            try:
                (stop or platforms.stop_chrome)(process, profile)
            except Exception:  # noqa: BLE001 — закрытие браузера не влияет на результат
                pass
    if not html:
        return [], "CDP: браузер не отдал страницу выдачи"
    lowered = html.lower()
    if any(marker in lowered for marker in platforms.CAPTCHA_MARKERS):
        # Ложный успех: страница капчи — это не выдача, ссылки с неё результатами не считаем
        return [], ("CDP (%s): поисковик отдал капчу или страницу проверки — результатов нет "
                    "(нужен вход/иная поисковая система)" % engine)
    entries = search_results.parse_html(html)
    entries = search_results.dedupe(entries)
    if not entries:
        return [], "CDP: в выдаче не нашлось ссылок (возможно, капча или пустой результат)"
    note = "CDP (%s): %d ссылок после отсева агрегаторов" % (engine, len(entries))
    if getattr(platforms, "LAST_CHROME_NOTE", ""):
        note += "; " + platforms.LAST_CHROME_NOTE
    return entries, note


def search(query, *, backend="auto", api_key=None, engine="yandex", post=None, cdp_html=None,
           launch=None, stop=None, port=9364, wait_ms=9000, get=None):
    """Поиск с выбором бэкенда. Возвращает ``(entries, note)``.

    ``auto``: есть ключ Serper — идём в Serper; иначе DuckDuckGo HTML (без браузера).
    Chrome по CDP остаётся явным выбором (``backend="cdp"``).
    """
    if not str(query or "").strip():
        return [], "пустой поисковый запрос"
    chosen = backend
    if backend == "auto":
        chosen = "serper" if (api_key or serper_key()) else "ddg"
    if chosen == "serper":
        return serper_search(query, api_key=api_key, post=post)
    if chosen == "ddg":
        return ddg_search(query, get=get)
    if chosen == "cdp":
        return cdp_search(query, engine=engine, port=port, wait_ms=wait_ms,
                          cdp_html=cdp_html, launch=launch, stop=stop)
    return [], "неизвестный бэкенд «%s» (есть: %s)" % (backend, ", ".join(BACKENDS))


def build_parser():
    parser = argparse.ArgumentParser(description="Веб-поиск для автоподбора конкурентов")
    parser.add_argument("--query", required=True, help="поисковый запрос")
    parser.add_argument("--backend", default="auto", choices=BACKENDS)
    parser.add_argument("--engine", default="yandex", choices=sorted(SEARCH_ENGINES))
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv)
    entries, note = search(args.query, backend=args.backend, engine=args.engine)
    print(note)
    if args.json:
        print(json.dumps(entries, ensure_ascii=False, indent=2))
    else:
        for entry in entries[:10]:
            print("  - %s — %s" % (entry.get("host") or "?", (entry.get("name") or "")[:70]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
