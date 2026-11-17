#!/usr/bin/env python3
r"""search_results.py - снимок поисковой выдачи -> кандидаты и предложения сайтов.

Задача E: у автоподбора нет источника веб-поиска (`web_search` недоступен, ключа
Serper нет), а руками составлять JSON из выдачи неудобно. Модуль принимает то, что
оператор реально может сохранить:

* ответ Serper (``{"organic": [{"title", "link", "snippet"}]}``);
* сохранённую страницу выдачи (HTML: пары «ссылка + заголовок»);
* обычный список ссылок (текст или markdown).

и превращает это в записи, которые понимает ``discover_competitors.build_candidates``
(``name``, ``url``, ``source``), плюс отдельно предлагает адреса сайтов для уже
известных ЖК клиента: «Селигер Сити → mr-group.ru/projects/zhk-seliger-siti».

Честность данных:
  * модуль ничего не выдумывает: берётся только то, что реально есть в снимке;
  * агрегаторы и соцсети (Циан, Авито, Домклик, Яндекс, 2ГИС, VK, Дзен и т. п.)
    в предложения не идут — нужен сайт застройщика;
  * предложение всегда помечено уверенностью (``high`` / ``medium`` / ``low``);
    окончательное решение принимает человек, автоматической записи нет.

Usage:
    python search_results.py --serp serp.html --client client-svet
    python search_results.py --serp serper.json --json
"""
from __future__ import annotations

import argparse
import datetime as dt
import html as html_mod
import json
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

#: Площадки-агрегаторы и соцсети: сайтом застройщика не являются.
AGGREGATOR_HOSTS = (
    "cian.ru", "avito.ru", "domclick.ru", "domofond.ru", "mirkvartir.ru", "restate.ru",
    "novostroy.ru", "novostroyki.org", "bn.ru", "irn.ru", "gdeetotdom.ru", "move.ru",
    "yandex.ru", "yandex.com", "google.com", "bing.com", "duckduckgo.com", "mail.ru",
    "2gis.ru", "zoon.ru", "flamp.ru", "otzovik.com", "irecommend.ru",
    "vk.com", "ok.ru", "t.me", "telegram.me", "youtube.com", "rutube.ru", "dzen.ru",
    "wikipedia.org", "wikimapia.org", "ria.ru", "rbc.ru", "kommersant.ru", "dom.mingkh.ru",
    "mos.ru", "наш.дом.рф", "нашдом.рф", "xn--80az8a.xn--d1aqf.xn--p1ai", "gkh.ru",
)
ANCHOR_RE = re.compile(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")
WORD_RE = re.compile(r"[А-Яа-яЁёA-Za-z0-9]{3,}")
STOP_WORDS = {"жилой", "комплекс", "квартал", "квартиры", "новостройки", "москва", "официальный", "сайт"}


def setup_console():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 — консоль не наша забота
        pass


def norm_url(value, base=""):
    """Полный http(s)-адрес без фрагмента; иначе пустая строка."""
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("//"):
        text = "https:" + text
    if not text.startswith("http"):
        if base and text.startswith("/"):
            root = re.match(r"^(https?://[^/]+)", base)
            if root:
                text = root.group(1) + text
        else:
            return ""
    return text.split("#", 1)[0].strip()


def host_of(url):
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def is_aggregator(url):
    """Площадка-агрегатор или соцсеть: сайтом конкурента не считается."""
    host = host_of(url)
    if not host:
        return True
    return any(host == item or host.endswith("." + item) for item in AGGREGATOR_HOSTS)


def clean_title(value):
    text = TAG_RE.sub(" ", str(value or ""))
    text = html_mod.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def make_entry(title, url, snippet="", base=""):
    url = norm_url(url, base)
    if not url:
        return None
    return {
        "name": clean_title(title) or host_of(url),
        "url": url,
        "source": "web-search",
        "host": host_of(url),
        "snippet": clean_title(snippet)[:300],
    }


#: DuckDuckGo HTML: результат — «<a class="result__a" href="//duckduckgo.com/l/?uddg=<url>">заголовок</a>».
DDG_ANCHOR_RE = re.compile(r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                           re.IGNORECASE | re.DOTALL)
#: Настоящий адрес лежит в параметре uddg (urlencoded).
UDDG_RE = re.compile(r"[?&]uddg=([^&]+)")


def parse_ddg(html):
    """Выдача DuckDuckGo (HTML-версия): заголовки + настоящие адреса из ``uddg``.

    Проверено 04.11.2026: без ключа и без браузера, капчи нет; первый результат
    запроса «ЖК Нарвин официальный сайт застройщика» — официальная страница pik.ru.
    """
    entries = []
    for match in DDG_ANCHOR_RE.finditer(html or ""):
        href = html_mod.unescape(match.group(1))
        found = UDDG_RE.search(href)
        target = unquote(found.group(1)) if found else href
        entry = make_entry(match.group(2), target)
        if entry:
            entries.append(entry)
    return entries


def parse_serper(payload):
    """Ответ Serper: organic/items/results -> записи."""
    items = []
    if isinstance(payload, dict):
        for key in ("organic", "items", "results", "news"):
            value = payload.get(key)
            if isinstance(value, list):
                items.extend(value)
    entries = []
    for item in items:
        if not isinstance(item, dict):
            continue
        entry = make_entry(item.get("title"), item.get("link") or item.get("url"),
                           item.get("snippet") or item.get("description") or "")
        if entry:
            entries.append(entry)
    return entries


def parse_html(html, base=""):
    """Сохранённая страница выдачи: пары «ссылка + видимый заголовок»."""
    entries = []
    for match in ANCHOR_RE.finditer(html or ""):
        entry = make_entry(match.group(2), match.group(1), base=base)
        if entry:
            entries.append(entry)
    return entries


def parse_text(text):
    """Список ссылок текстом/markdown: строка со ссылкой -> запись."""
    entries = []
    for line in (text or "").splitlines():
        match = URL_RE.search(line)
        if not match:
            continue
        title = URL_RE.sub(" ", line)
        title = re.sub(r"[*_`\[\]()#>|-]+", " ", title)
        entry = make_entry(title, match.group(0))
        if entry:
            entries.append(entry)
    return entries


def dedupe(entries):
    """Убрать повторы по адресу и сами агрегаторы."""
    seen = set()
    result = []
    for entry in entries:
        url = entry.get("url")
        if not url or url in seen or is_aggregator(url):
            continue
        seen.add(url)
        result.append(entry)
    return result


def load_entries_text(text):
    """Что бы ни лежало в снимке — JSON движка, ответ Serper, HTML или список ссылок."""
    raw = str(text or "").strip()
    if not raw:
        return []
    if raw[:1] in "[{":
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = None
        if payload is not None:
            if isinstance(payload, list):
                return dedupe([item for item in payload if isinstance(item, dict)])
            if isinstance(payload, dict):
                for key in ("results", "candidates"):
                    value = payload.get(key)
                    if isinstance(value, list):
                        return dedupe([item for item in value if isinstance(item, dict)])
                serper = parse_serper(payload)
                if serper:
                    return dedupe(serper)
            return []
    if "<a " in raw.lower() or "<html" in raw.lower():
        return dedupe(parse_html(raw))
    return dedupe(parse_text(raw))


def load_entries(path):
    """Снимок выдачи из файла (кодировка — utf-8 с BOM, ошибки не роняют разбор)."""
    return load_entries_text(Path(path).read_text(encoding="utf-8-sig", errors="replace"))


def name_tokens(name):
    """Значимые слова названия ЖК (без «жилой», «комплекс», «официальный сайт»)."""
    return [word.lower() for word in WORD_RE.findall(str(name or ""))
            if word.lower() not in STOP_WORDS]


def score_entry(name, entry):
    """Сколько значимых слов названия видно в заголовке найденной страницы."""
    tokens = name_tokens(name)
    if not tokens:
        return 0.0
    haystack = ("%s %s" % (entry.get("name") or "", entry.get("snippet") or "")).lower()
    hits = sum(1 for token in tokens if token.rstrip("аеиоуыэюяйь")[:5] in haystack
               or token[:5] in haystack)
    return hits / len(tokens)


def developer_hosts(competitors):
    """Домены застройщиков, уже известные из конфига клиента: «ПИК» -> {pik.ru}."""
    mapping = {}
    for item in competitors or []:
        if not isinstance(item, dict):
            continue
        developer = str(item.get("developer") or "").strip().lower()
        host = host_of(str(item.get("site") or ""))
        if developer and host:
            mapping.setdefault(developer, set()).add(host)
    return mapping


def host_matches_developer(host, known_hosts):
    """Домен совпадает с известным доменом застройщика (или это его поддомен)."""
    host = str(host or "").lower()
    for known in known_hosts or ():
        if host == known or host.endswith("." + known) or known.endswith("." + host):
            return True
    return False


def propose_sites(entries, competitors):
    """Для каждого ЖК клиента — лучший неагрегаторный результат выдачи.

    Предложение, а не запись: наружу уходит адрес, заголовок и уверенность.
    При равном совпадении по названию выигрывает домен застройщика, уже известный
    из конфига клиента («ПИК» → pik.ru), а не агентство с похожим заголовком.
    """
    clean = [entry for entry in entries if not is_aggregator(entry.get("url"))]
    known_hosts = developer_hosts(competitors)
    proposals = []
    for competitor in competitors:
        if not isinstance(competitor, dict):
            continue
        name = str(competitor.get("name") or "").strip()
        if not name:
            continue
        developer = str(competitor.get("developer") or "").strip().lower()
        allowed_hosts = known_hosts.get(developer) or set()
        scored = sorted(
            ((score_entry(name, entry),
              1 if host_matches_developer(entry.get("host"), allowed_hosts) else 0,
              entry) for entry in clean),
            key=lambda item: (-item[0], -item[1], item[2].get("host") or "")
        )
        best_score, best_prefered, best = (scored[0] if scored else (0.0, 0, None))
        if best is None or best_score <= 0:
            # ни одного совпадения по названию: предлагать «первое из списка» нельзя
            best_score, best_prefered, best = 0.0, 0, None
        confidence = "none"
        if best is not None and best_score >= 1.0:
            confidence = "high"
        elif best is not None and best_score >= 0.5:
            confidence = "medium"
        elif best is not None and best_score > 0:
            confidence = "low"
        note = ("нужен сайт застройщика — в выдаче не нашлось подходящего"
                if best is None or best_score <= 0 else "")
        if best is not None and best_score > 0:
            note = ("домен застройщика «%s» — из ваших данных" % (competitor.get("developer") or "")
                    if best_prefered else "домен не подтверждён вашими данными — проверьте сайт вручную")
        if confidence == "high" and not best_prefered:
            # Авто-перенос (--write, только high) разрешаем лишь домену, подтверждённому
            # конфигом клиента: агентства маскируются под «официальный сайт» (g-n.ru и подобные)
            confidence = "medium"
        proposals.append({
            "name": name,
            "current_site": str(competitor.get("site") or ""),
            "proposed_site": (best or {}).get("url"),
            "proposed_host": (best or {}).get("host"),
            "title": (best or {}).get("name"),
            "score": round(best_score, 2),
            "developer_host": bool(best_prefered),
            "confidence": confidence,
            "note": note,
        })
    return proposals


def client_competitors(client_id):
    """Список конкурентов клиента из его конфига (пусто — клиента нет в config/clients)."""
    import clients as clients_mod  # локально: движку этот модуль не нужен

    client = clients_mod.find_client(None, client_id)
    return list((client or {}).get("competitors") or [])


#: Строка «site: ...» в конфиге клиента.
SITE_LINE_RE = re.compile(r'^(\s*)site:\s*(.*)$')
#: Начало записи конкурента: блочная («- name:») или однострочная («- { ... }»).
RECORD_START_RE = re.compile(r'^\s*-\s+(?:name:|\{)')
#: Значение site внутри однострочной записи.
FLOW_SITE_RE = re.compile(r'site:\s*("[^"]*"|\'[^\']*\'|[^,}]+)')


def plan_site_updates(proposals, only=None, include_medium=False, force=False):
    """Что будет изменено в конфиге клиента. Ничего не пишет — только план.

    Берём только предложения с уверенностью ``high`` (``include_medium`` расширяет
    до ``medium``), только из списка ``only`` (если он задан) и только там, где сайта
    ещё нет: чужой непустой сайт перезаписывается лишь при явном ``force``.
    """
    allowed = set(only or [])
    plan = []
    for item in proposals:
        name = str(item.get("name") or "")
        url = item.get("proposed_site")
        if not name or not url:
            continue
        if allowed and name not in allowed:
            continue
        if item.get("confidence") != "high" and not include_medium:
            continue
        current = str(item.get("current_site") or "").strip()
        action = "set_site" if (force or not current) else "skip_has_site"
        plan.append({"name": name, "action": action,
                     "old": current, "new": url, "confidence": item.get("confidence")})
    return plan


def apply_site_updates(path, plan, write=False, force=False):
    """Применить план к файлу конфига. Без ``write=True`` файл не меняется.

    Возвращает ``(изменённые пункты, путь к .bak или None)``.
    """
    path = Path(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    changed = []
    for item in plan:
        if item["action"] != "set_site":
            continue
        name = item["name"]
        start = None
        for index, line in enumerate(lines):
            if RECORD_START_RE.match(line) and ('"%s"' % name) in line:
                start = index
                break
        if start is None:
            item["action"] = "not_found"
            continue
        if "{" in lines[start]:   # однострочная запись: правим значение внутри строки
            match = FLOW_SITE_RE.search(lines[start])
            current = match.group(1).strip().strip('"').strip("'") if match else ""
            if current and not force:
                item["action"] = "skip_has_site"
                continue
            lines[start] = FLOW_SITE_RE.sub('site: "%s"' % item["new"], lines[start], count=1)
            changed.append(item)
            continue
        end = len(lines)
        for index in range(start + 1, len(lines)):
            if RECORD_START_RE.match(lines[index]):
                end = index
                break
        target = None
        for index in range(start, end):
            if SITE_LINE_RE.match(lines[index]):
                target = index
                break
        if target is not None:
            current = SITE_LINE_RE.match(lines[target]).group(2).strip().strip('"').strip("'")
            if current and not force:
                item["action"] = "skip_has_site"
                continue
            indent = SITE_LINE_RE.match(lines[target]).group(1)
            lines[target] = '%ssite: "%s"' % (indent, item["new"])
        else:
            indent = re.match(r"^(\s*)", lines[start]).group(1) + "  "
            lines.insert(start + 1, '%ssite: "%s"' % (indent, item["new"]))
        changed.append(item)
    if not (write and changed):
        return changed, None
    backup = "%s.bak-%s" % (path, dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(path, backup)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return changed, backup


def client_config_path(client_id, clients_dir=None):
    """Адрес конфига клиента (по умолчанию — config/clients)."""
    directory = Path(clients_dir) if clients_dir else (Path(__file__).resolve().parent.parent / "config" / "clients")
    return directory / ("%s.yaml" % client_id)


def query_for(name, developer=""):
    """Поисковый запрос по ЖК: с застройщиком, если он известен — так попаданий больше.

    Проверено 04.11.2026: без застройщика у половины ЖК выдача не содержит названия
    проекта в заголовке, и предложение не находится вовсе.
    """
    title = str(name or "").strip()
    who = str(developer or "").strip()
    if who:
        return "«%s» %s официальный сайт" % (title, who)
    return "«%s» официальный сайт застройщика Москва" % title


def web_search_entries(queries, backend="auto", engine="yandex", delay=5.0, retry_delay=None, search_fn=None):
    """Записи из живого поиска + честные пояснения по каждой попытке.

    ``delay`` — пауза между запросами (по умолчанию 5 с), ``retry_delay`` — пауза перед
    повтором (по умолчанию тройная). Проверено 04.11.2026: пакет из 20+ быстрых запросов
    упирается в лимит поисковика и отдаёт пустоту по всем ЖК сразу, поэтому пустая выдача
    повторяется (не больше трёх раз за пакет), а если пустых больше половины — в примечания
    пишется предупреждение, а не тихое «предложений нет».

    ``search_fn`` — точка подмены для тестов: ``(query) -> (entries, note)``.
    """
    import time as time_mod

    if search_fn is None:
        import web_search as web_search_mod

        def search_fn(query):  # noqa: E731 — короткая обёртка над боевым поиском
            return web_search_mod.search(query, backend=backend, engine=engine)

    backoff = retry_delay if retry_delay is not None else delay * 3
    entries = []
    notes = []
    empty = 0
    retries = 0
    max_retries = 3
    for index, query in enumerate(queries):
        if index and delay:
            time_mod.sleep(delay)
        found, note = search_fn(query)
        if not found and retries < max_retries:
            retries += 1
            if backoff:
                time_mod.sleep(backoff)
            again, note_again = search_fn(query)
            if again:
                found, note = again, note_again + " (после повтора)"
        if not found:
            empty += 1
        notes.append("%s → %s" % (query, note))
        entries.extend(found)
    if len(queries) >= 3 and empty >= max(1, len(queries) // 2):
        notes.append("ВНИМАНИЕ: пустых выдач %d из %d — похоже на лимит поисковика; "
                     "увеличьте --delay или используйте ключ SERPER_API_KEY "
                     "(Serper рассчитан на пакетные запросы)" % (empty, len(queries)))
    return dedupe(entries), notes


def build_parser():
    parser = argparse.ArgumentParser(description="Выдача поиска (снимок или живой поиск) -> кандидаты и предложения сайтов")
    parser.add_argument("--serp", default=None, help="файл снимка: Serper JSON, HTML выдачи или список ссылок")
    parser.add_argument("--web-search", dest="web_search", default=None, choices=("auto", "serper", "ddg", "cdp"),
                        help="живой поиск: auto (Serper при ключе, иначе DuckDuckGo), serper, ddg или cdp")
    parser.add_argument("--query", action="append", default=None, help="поисковый запрос (можно несколько)")
    parser.add_argument("--engine", default="yandex", choices=("yandex", "google"), help="поисковик для CDP")
    parser.add_argument("--delay", type=float, default=5.0,
                        help="пауза между живыми запросами, секунды (по умолчанию 5)")
    parser.add_argument("--client", default=None, help="id клиента: сверить выдачу с его списком конкурентов")
    parser.add_argument("--json", action="store_true", help="итог в JSON")
    parser.add_argument("--apply", action="store_true",
                        help="показать перенос предложенных сайтов в конфиг клиента (без --write ничего не пишется)")
    parser.add_argument("--write", action="store_true", help="действительно записать конфиг (с резервной копией .bak)")
    parser.add_argument("--force", action="store_true", help="перезаписать уже заполненный site")
    parser.add_argument("--only", default=None, help="переносить только эти ЖК, через запятую")
    parser.add_argument("--include-medium", dest="include_medium", action="store_true",
                        help="переносить и предложения с уверенностью medium")
    parser.add_argument("--clients-dir", default=None, help="каталог конфигов клиентов (для тестов)")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv)
    notes = []
    entries = []
    if args.serp:
        entries = load_entries(args.serp)
        print("снимок %s: записей после отсева агрегаторов — %d" % (Path(args.serp).name, len(entries)))
    if args.web_search:
        queries = list(args.query or [])
        if not queries and args.client:
            queries = [query_for(item.get("name"), item.get("developer"))
                       for item in client_competitors(args.client)
                       if isinstance(item, dict) and item.get("name")]
        if not queries:
            print("нечего искать: задайте --query или --client с записями competitors")
            return 0
        found, notes = web_search_entries(queries, backend=args.web_search, engine=args.engine,
                                          delay=args.delay)
        entries = dedupe(entries + found)
        for note in notes:
            print(note)
        print("живой поиск: записей после отсева агрегаторов — %d" % len(entries))
    if not args.serp and not args.web_search:
        print("укажите --serp <файл> или --web-search (живой поиск)")
        return 0
    for entry in entries[:10]:
        print("  - %s — %s" % (entry.get("host") or "?", (entry.get("name") or "")[:70]))
    if args.client:
        competitors = client_competitors(args.client)
        if not competitors:
            print("у клиента %s нет записей competitors в конфиге" % args.client)
        proposals = propose_sites(entries, competitors)
        if args.json:
            print(json.dumps(proposals, ensure_ascii=False, indent=2))
        else:
            print("\nпредложения сайтов для %s (решение принимает человек):" % args.client)
            for item in proposals:
                print("  %-28s %-8s %s" % (item["name"][:28], item["confidence"],
                                           item["proposed_site"] or "—"))
        if args.apply:
            only = [part.strip() for part in (args.only or "").split(",") if part.strip()]
            plan = plan_site_updates(proposals, only=only, include_medium=args.include_medium,
                                     force=args.force)
            config_path = client_config_path(args.client, args.clients_dir)
            if not config_path.is_file():
                print("конфиг клиента не найден: %s" % config_path)
                return 1
            changed, backup = apply_site_updates(config_path, plan, write=args.write, force=args.force)
            print("\nперенос сайтов в %s (%s):" % (config_path.name,
                                                  "запись" if args.write else "только показ, без --write"))
            for item in plan:
                print("  %-28s %-16s %s" % (item["name"][:28], item["action"], item.get("new") or "—"))
            if backup:
                print("резервная копия: %s" % Path(backup).name)
            print("изменено записей: %d" % len(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
