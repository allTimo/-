#!/usr/bin/env python3
r"""platforms.py - public project pages of the marketplaces, WITHOUT any login.

Sources: cian.ru, avito.ru, realty.yandex.ru, domclick.ru (and any futher URL given
by a client config). Order of work:
  1) plain HTTP GET of the project page with a strict header allowlist: no Cookie,
     no Authorization, no token, no session - the request is anonymous by construction;
  2) if the answer is blocked (403/429/5xx/captcha/empty), optionally open the page in
     Chrome over CDP using a FRESH temporary profile (--user-data-dir=%TEMP%\cw-cdp-*),
     i.e. a browser with no account, no cookies and no stored sessions.

Honest statuses per source:
  ok                - данные со страницы получены
  needs_browser     - HTTP заблокирован, нужен браузер (CDP)
  needs_partnership - площадка требует партнёрского доступа/API
  no_data           - страница открылась, но лотов/цен на ней нет

Nothing is invented: fields missing on the page stay empty.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import cwlib as cw

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = cw.PROJECT_ROOT
CDP_SCRIPT = PROJECT_ROOT / "00-admin" / "scripts" / "cdp-eval.mjs"
NODE_CANDIDATES = (
    Path(os.environ.get("USERPROFILE", "")) / ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe",
    Path(r"C:\Users\Артем\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"),
)

# Ровно эти заголовки уходят в запрос. Куки/токены не добавляются никогда.
SAFE_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
    "Cache-Control": "no-cache",
}
FORBIDDEN_HEADERS = ("cookie", "authorization", "x-csrf-token", "x-auth-token", "token",
                     "x-session-id", "proxy-authorization")
AUTH_MARKERS = ("авторизуйтесь", "войдите в", "sign in", "log in", "войти в аккаунт")

# Публичные каталожные/поисковые страницы площадок (используются для сбора и автоподбора).
PLATFORM_SEARCH_URLS = {
    "cian": "https://www.cian.ru/novostroyki/",
    "avito": "https://www.avito.ru/moskva/kvartiry/prodazha/novostroyki",
    "yandex-realty": "https://realty.yandex.ru/moskva_i_moskovskaya_oblast/kupit/novostrojka/",
    "domclick": "https://domclick.ru/moskva/novostroyki",
}

PLATFORMS = {
    "cian": {"name": "Циан", "host": "cian.ru", "status_column": "cian",
             "partnership": "официальный API Циан — только по договору"},
    "avito": {"name": "Авито Недвижимость", "host": "avito.ru", "status_column": "avito",
              "partnership": "массовая выгрузка Авито — только через партнёрский доступ"},
    "yandex_realty": {"name": "Яндекс Недвижимость", "host": "realty.yandex.ru",
                      "status_column": "yandex_realty", "partnership": "—"},
    "domclick": {"name": "Домклик", "host": "domclick.ru", "status_column": "domclick",
                 "partnership": "партнёрский API Домклик — по договору"},
    "site": {"name": "Сайт застройщика", "host": "", "status_column": "site", "partnership": "—"},
}
BLOCK_STATUSES = (401, 403, 405, 429, 439, 503)
# Транспорт по умолчанию для источника:
#   http-only         — только анонимный HTTP (браузер не поднимаем даже при блокировке);
#   http-then-browser — HTTP, а при блокировке Chrome по CDP с чистым профилем (без логина).
# Циан отдаёт данные ЖК обычным HTTP, а headless-браузер распознаёт как подозрительный трафик —
# поэтому для Циан браузерный режим не используется по умолчанию.
PLATFORM_TRANSPORT = {
    "cian": "http-only",
    "yandex_realty": "http-then-browser",
    "avito": "http-then-browser",
    "domclick": "http-only",
    "site": "http-then-browser",
}
CAPTCHA_MARKERS = ("captcha", "капча", "подтвердите, что вы не робот", "доступ ограничен",
                   "проверка безопасности", "cf-challenge", "cf_chl", "are you a robot",
                   "необычный трафик", "blocked by", "блокировка")
JS_ONLY_MARKERS = ("включите javascript", "enable javascript", "похоже, javascript отключён")

PRICE_RE = re.compile(r"([0-9]{1,3}(?:[ \u00a0][0-9]{3})+|[0-9]{4,})\s*(?:₽|руб)")
MLN_RE = re.compile(r"([0-9]+(?:[.,][0-9]+)?)\s*млн")
AREA_RE = re.compile(r"([0-9]+(?:[.,][0-9]+)?)\s*(?:м\s*²|м\s*2|кв\.?\s*м)")
#: Процент скидки на карточке («-35%», «скидка 20 %»).
DISCOUNT_PCT_RE = re.compile(r"(\d{1,2})\s*%")
ROOMS_RE = re.compile(r"([1-5])\s*[-\s]?\s*(?:комн|к\.|комнатн)")
STUDIO_RE = re.compile(r"студи", re.IGNORECASE)
FLOOR_RE = re.compile(r"([0-9]{1,3})\s*/\s*([0-9]{1,3})\s*(?:эт|этаж)")
DELIVERY_RE = re.compile(r"(20[2-9][0-9])\s*(?:год|г\.|кв|квартал|Q([1-4]))?", re.IGNORECASE)
PROMO_WORDS = ("скидк", "акци", "рассрочк", "ипотек", "субсидирован", "трейд-ин", "старт продаж",
               "последние лоты", "кэшбэк", "мебель в подарок", "паркинг в подарок", "промо")

#: Слова рядом с суммой, после которых это НЕ цена лота, а сопутствующая цифра
#: (взнос, платёж, ставка, цена за м²). Правило честности F10.
MONEY_NOISE = ("взнос", "платёж", "платеж", "ипотек", "ставка", "скидк", "кэшбэк", "кешбэк",
               "трейд-ин", "паркинг", "кладов", "машиноместо", "аренд", "ремонт", "мебел",
               "₽/м", "руб/м", "/м²", "/м2", "за м²", "за м2", "за метр", "в месяц", "/мес")
#: Насколько близко к числу искать слово-обманку (знаков в каждую сторону).
NOISE_WINDOW = 30
#: Правдоподобный коридор ₽/м²; тот же, что в ``lot_history_pipeline.PLAUSIBLE_PPM2``.
PLAUSIBLE_PPM2 = (120_000, 1_200_000)
#: Признаки адреса, который НЕ является карточкой лота: паркинг, ипотека, каталог, акции.
NON_LOT_URL_MARKERS = ("/parking", "/parkovka", "/machin", "/машином", "/mortgage", "/ipoteka",
                       "/filter", "/purchase", "/actions", "/akcii", "/promo", "/news",
                       "/contacts", "/about")

CARD_SPLIT = {
    "cian": r'data-testid="offer-card"|<article[^>]*class="[^"]*offer',
    "avito": r'data-marker="item"|<div[^>]*class="[^"]*item-view',
    "yandex_realty": r'data-test="offer-card"|<article[^>]*class="[^"]*OfferCard',
    "domclick": r'data-test="offer-card"|<div[^>]*class="[^"]*offer-card',
    "site": r"<article|card-flat|class=\"[^\"]*(?:flat|lot|offer)[^\"]*\"",
}


# --------------------------------------------------------------------------
# текстовые помощники: берём только то, что реально написано на странице
# --------------------------------------------------------------------------

def status_column(source_id):
    """id источника -> значение колонки source по контракту (yandex-realty -> yandex_realty)."""
    key = str(source_id or "").replace("-", "_")
    if key in PLATFORMS:
        return PLATFORMS[key]["status_column"]
    return str(source_id)


def clean_text(value):
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_price(text):
    """«12 500 000 ₽» и «12,5 млн ₽» -> цена в рублях, иначе None."""
    if not text:
        return None
    text = clean_text(text)
    millions = MLN_RE.search(text)
    if millions:
        try:
            return int(round(float(millions.group(1).replace(",", ".")) * 1_000_000))
        except ValueError:
            return None
    match = PRICE_RE.search(text)
    if match:
        digits = re.sub(r"[^0-9]", "", match.group(1))
        return int(digits) if digits else None
    return None


def money_candidates(text):
    """Все денежные числа текста: ``(начало, конец, рубли)``.

    «12 500 000 ₽» → 12 500 000; «23,18 млн» → 23 180 000.
    """
    found = []
    for match in MLN_RE.finditer(text or ""):
        try:
            value = float(match.group(1).replace(",", ".")) * 1_000_000
        except ValueError:
            continue
        found.append((match.start(), match.end(), int(round(value))))
    for match in PRICE_RE.finditer(text or ""):
        digits = re.sub(r"[^0-9]", "", match.group(1))
        if digits:
            found.append((match.start(), match.end(), int(digits)))
    found.sort()
    return found


def marked_by_noise(text, candidates):
    """Индексы чисел, к которым привязаны слова-обманки («взнос», «₽/м²», «/мес»).

    Слово относится к **ближайшему** числу. Живой level.ru: «84 903 руб./мес.
    25 364 668 руб. 16 487 034 руб. -35%» — «/мес» про первое число, и настоящая
    цена из-за него не отбрасывается.
    """
    marked = set()
    lowered = (text or "").lower()
    for noise in MONEY_NOISE:
        start = 0
        while True:
            position = lowered.find(noise, start)
            if position < 0:
                break
            start = position + 1
            best = None
            for index, (cstart, cend, _value) in enumerate(candidates):
                distance = 0 if cstart <= position <= cend else min(abs(cstart - position),
                                                                   abs(position - cend))
                if best is None or distance < best[0]:
                    best = (distance, index)
            if best is not None:
                marked.add(best[1])
    return marked


def is_lot_price(text, index, candidates):
    """Число не подписано словами-обманками («взнос», «₽/м²», «в месяц» …)."""
    return index not in marked_by_noise(text, candidates)


def pick_lot_price(text):
    """Цена лота: самое крупное «честное» денежное число карточки, иначе ``None``.

    Дефект F10: сайты застройщиков печатают в карточке «первоначальный взнос» и
    «платёж по ипотеке» рядом с ценой. Первое совпадение давало 34 700 и
    74 928 ₽/м². Здесь такие суммы отбрасываются, берётся цена квартиры.
    """
    cleaned = clean_text(text)
    candidates = money_candidates(cleaned)
    best = None
    for index, (_start, _end, value) in enumerate(candidates):
        if not is_lot_price(cleaned, index, candidates):
            continue
        if best is None or value > best:
            best = value
    return best


def discount_pair(text):
    """``(текущая цена, цена до скидки)`` — только если процент на странице сходится.

    Живой level.ru (04.11.2026) пишет в карточке «25 364 668 руб. 16 487 034 руб. -35%»:
    текущая цена — меньшая, и это подтверждается процентом на самой странице
    (1 − 16 487 034 / 25 364 668 = 35 %). Если процент не сходится, ничего не выдумываем.
    """
    cleaned = clean_text(text)
    candidates = money_candidates(cleaned)
    honest = [item for index, item in enumerate(candidates) if is_lot_price(cleaned, index, candidates)]
    for left, right in zip(honest, honest[1:]):
        larger, smaller = (left[2], right[2]) if left[2] >= right[2] else (right[2], left[2])
        if smaller <= 0 or larger == smaller:
            continue
        pct = round((1 - smaller / larger) * 100)
        if pct <= 0 or pct > 90:
            continue
        window = cleaned[left[1]:right[1] + 40]
        if any(abs(int(match.group(1)) - pct) <= 1 for match in DISCOUNT_PCT_RE.finditer(window)):
            return smaller, larger
    return None, None


def pick_lot_price_details(text):
    """Цена лота и (если подтверждено процентом) цена до скидки.

    Правило честности: сначала проверяем подтверждённую скидку, иначе берём самое
    крупное «честное» денежное число карточки.
    """
    smaller, larger = discount_pair(text)
    if smaller:
        return {"price_rub": smaller, "price_before_rub": larger}
    return {"price_rub": pick_lot_price(text), "price_before_rub": None}


def plausible_ppm2(price, area):
    """Сходится ли цена с площадью: ₽/м² внутри :data:`PLAUSIBLE_PPM2`."""
    if not price or not area:
        return True
    return PLAUSIBLE_PPM2[0] <= (price / area) <= PLAUSIBLE_PPM2[1]


def pick_site_url(block, page_url=""):
    """Адрес позиции из карточки сайта застройщика; нет ссылки — адрес страницы."""
    match = re.search(r'href="([^"#]+)"', block or "")
    if not match:
        return page_url or ""
    href = match.group(1).strip()
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        root = re.match(r"^(https?://[^/]+)", page_url or "")
        if root:
            return root.group(1) + href
    return page_url or ""


def project_slug(url):
    """Слаг проекта из адреса страницы застройщика (``/projects/<slug>/``)."""
    match = re.search(r"/projects/([^/?#]+)", str(url or ""), re.IGNORECASE)
    return match.group(1).lower() if match else ""


def is_lot_position_url(position_url, page_url=""):
    """Адрес позиции — это лот, а не паркинг/ипотека/каталог и не другой ЖК.

    Проверено на живом level.ru (04.11.2026): в выдаче каталога попадаются
    страницы ``/parking``, ``/purchase/mortgage``, ``/filter/...`` и карточки
    другого проекта (``/projects/lesnoy/`` при разборе ``/projects/southport/``).
    Их цены к нашему конкуренту отношения не имеют.
    """
    url = str(position_url or "").lower()
    if any(marker in url for marker in NON_LOT_URL_MARKERS):
        return False
    page = project_slug(page_url)
    found = project_slug(position_url)
    if page and found and page != found:
        return False
    return True


def parse_area_m2(text):
    match = AREA_RE.search(clean_text(text))
    if match:
        try:
            return round(float(match.group(1).replace(",", ".")), 1)
        except ValueError:
            return None
    return None


def parse_rooms(text):
    text = clean_text(text)
    if STUDIO_RE.search(text):
        return 0
    match = ROOMS_RE.search(text)
    if match:
        return int(match.group(1))
    if "5+" in text or "5 +" in text:
        return 6
    return None


def parse_floor(text):
    match = FLOOR_RE.search(clean_text(text))
    if match:
        return int(match.group(1)), int(match.group(2))
    return None, None


#: Квартал перед годом: «IV кв. 2027», «3 квартал 2028».
DELIVERY_QUARTER_BEFORE_RE = re.compile(
    r"\b(IV|III|II|I|[1-4])\s*(?:кв\.?|квартал[а-я]*)\s*(20[2-9][0-9])", re.IGNORECASE)
#: Римские и арабские номера кварталов.
QUARTER_NUMBERS = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "1": 1, "2": 2, "3": 3, "4": 4}
#: Признаки настоящего срока сдачи рядом с годом.
DELIVERY_DEADLINE_WORDS = ("срок", "сдач", "ввод", "готовност", "передач", "окончан", "завершен")
#: Признаки того, что год — не срок, а ипотечное/платёжное условие (дефект F12).
DELIVERY_NOISE_WORDS = ("ставк", "ипотек", "кредит", "взнос", "платёж", "платеж", "рассрочк", "процент")


def parse_delivery(text):
    """Срок сдачи: «2027-Q2», если квартал известен, иначе год «2027», иначе пусто.

    Год рядом с ипотечными или платёжными словами («ставка 13 % на 2027 год») сроком
    сдачи не считается: именно так в колонку попадал мусор (дефект F12). Если рядом
    есть прямое слово о сроке («сдача 2027») — год берём.
    """
    cleaned = clean_text(text)
    before = DELIVERY_QUARTER_BEFORE_RE.search(cleaned)
    if before:
        quarter = QUARTER_NUMBERS.get(before.group(1).lower())
        if quarter:
            return "%s-Q%d" % (before.group(2), quarter)
    for match in DELIVERY_RE.finditer(cleaned):
        window = cleaned[max(0, match.start() - 18):match.end() + 18].lower()
        deadline = any(word in window for word in DELIVERY_DEADLINE_WORDS)
        if not deadline and any(word in window for word in DELIVERY_NOISE_WORDS):
            continue
        year = match.group(1)
        quarter = match.group(2)
        return "%s-Q%s" % (year, quarter) if quarter else year
    return ""


# фрагменты вёрстки/JSON, которые не являются текстом акции
PROMO_GARBAGE_MARKERS = ('":', '":{"', '","', '&quot;', '&laquo;', chr(92) + 'u', 'window.', 'function(',
                         'по вашим параметрам', 'найдите подходящую', 'subtitle', 'пока нет',
                         'data-', '<', '>')
# Маркетинговые метки самой площадки (не акция застройщика) — общий список для всех модулей.
PLATFORM_PROMO_NOISE = ('только на циан', 'только на авито', 'найдите подходящую', 'циан', 'cian',
                        'авито', 'avito', 'подать объявление',
                        'акций жк', 'сдача гк', 'гк:', 'подходящ', 'каталог', 'выбор квартир',
                        'планировк', 'квартир от', 'жк «', 'жк "')


def looks_like_promo_text(value):
    """Настоящий текст акции: не JSON/вёрстка, есть буквы и хотя бы одно слово."""
    text = str(value or "").strip()
    if len(text) < 4 or len(text) > 160:
        return False
    lowered = text.lower()
    if any(marker in lowered for marker in PROMO_GARBAGE_MARKERS):
        return False
    if any(marker in lowered for marker in PLATFORM_PROMO_NOISE):
        return False
    words = [word for word in re.split(r"\s+", text) if re.search(r"[А-Яа-яЁёA-Za-z]{2}", word)]
    return len(words) >= 2


def clean_promo_text(value):
    """Оставляем только осмысленную формулировку акции, иначе пусто (данных нет)."""
    text = clean_text(value)
    if not text:
        return ""
    for word in PROMO_WORDS:
        index = text.lower().find(word)
        if index < 0:
            continue
        fragment = text[index:index + 90]
        for stop in (". ", "! ", "? "):
            cut = fragment.find(stop)
            if cut > 3:
                fragment = fragment[:cut]
        for cut_char in ("<", ">"):        # остатки вёрстки после разбиения на карточки
            cut = fragment.find(cut_char)
            if cut > 0:
                fragment = fragment[:cut]
        fragment = fragment.strip(" ,;:—-")
        if looks_like_promo_text(fragment):
            return fragment
    return ""


def parse_promo(text):
    """Фрагмент текста, где реально сказано про акцию (без мусора вёрстки и JSON)."""
    return clean_promo_text(text)


def price_from_page(html):
    """Цена «от X ₽», когда постраничной шахматки нет."""
    text = clean_text(html)
    match = re.search(r"(?:от|от\s)\s*([0-9][0-9 \u00a0]*(?:[.,][0-9]+)?\s*(?:млн|₽|руб)[^.]{0,20})", text)
    if match:
        return parse_price(match.group(1))
    return None


# --------------------------------------------------------------------------
# разбор страниц
# --------------------------------------------------------------------------

def parse_number(value):
    """Число из JSON-LD («12500000»): только цифры, минимум 4 знака."""
    digits = re.sub(r"[^0-9]", "", str(value or ""))
    return int(digits) if len(digits) >= 4 else None


def extract_json_ld(html):
    lots = []
    for match in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html,
                             re.DOTALL | re.IGNORECASE):
        try:
            data = json.loads(match.group(1).strip())
        except Exception:
            continue
        candidates = data if isinstance(data, list) else [data]
        for item in candidates:
            if not isinstance(item, dict):
                continue
            offers = item.get("offers") if isinstance(item.get("offers"), dict) else None
            price = None
            if offers:
                price = parse_price(str(offers.get("price") or "")) or parse_number(offers.get("price"))
            name = clean_text(item.get("name") or "")
            if price is None and not name:
                continue
            area = parse_area_m2(name) or parse_area_m2(json.dumps(item, ensure_ascii=False))
            lots.append({"name": name, "price_rub": price, "area_m2": area})
    return lots


def extract_offer_id(block, platform="cian"):
    """ID предложения и ссылка на карточку (нужны, чтобы взять историю цены коннектором).

    Для Циан лот опознаётся по ссылке /sale/flat/<id>/ — проверено на живых страницах ЖК.
    """
    if platform == "cian":
        match = re.search(r"/sale/flat/(\d{6,12})/?", block or "")
        if match:
            return match.group(1), "https://www.cian.ru/sale/flat/%s/" % match.group(1)
    match = re.search(r'data-(?:offer|item|listing)-id="(\d{6,14})"', block or "")
    if match:
        return match.group(1), ""
    return None, ""


def parse_cards(html, platform, page_url=""):
    """Карточки предложений: цена/площадь/комнатность/этаж — что есть на странице.

    Для сайта застройщика (``platform == "site"``) цена берётся правилом
    :func:`pick_lot_price`, а не первым денежным числом карточки, и ₽/м² вне
    :data:`PLAUSIBLE_PPM2` считается недостоверным — в этом случае цена не
    публикуется вовсе (дефект F10). Адрес позиции берётся из ссылки карточки,
    если она есть (раньше поле ``url`` оставалось пустым).
    """
    splitter = CARD_SPLIT.get(platform, CARD_SPLIT["site"])
    raw_blocks = re.split("(?=" + splitter + ")", html)
    if len(raw_blocks) <= 1:
        # ни одной карточки на странице: не считаем весь документ одной карточкой
        return []
    blocks = [block for block in raw_blocks if block.strip()]
    lots = []
    for block in blocks[1:] if len(blocks) > 1 else []:
        if platform == "site":
            details = pick_lot_price_details(block)
        else:
            details = {"price_rub": parse_price(block), "price_before_rub": None}
        price = details["price_rub"]
        area = parse_area_m2(block)
        rooms = parse_rooms(block)
        floor, floors_total = parse_floor(block)
        if price is not None and not plausible_ppm2(price, area):
            # цена не сходится с площадью: публикуем «данных нет», а не аномалию
            price = None
        if price is None and area is None and rooms is None:
            continue
        title_match = re.search(r">([^<>]{4,80})<", clean_text(block) or "")
        offer_id, offer_url = extract_offer_id(block, platform)
        if platform == "site":
            if not offer_url:
                offer_url = pick_site_url(block, page_url)
            if not is_lot_position_url(offer_url, page_url):
                # карточка паркинга, ипотеки, каталога или другого ЖК — это не лот
                continue
        promo_text = parse_promo(block)
        if details.get("price_before_rub"):
            discount_note = "скидка на странице: было %s ₽, сейчас %s ₽" % (
                cw.fmt_int(details["price_before_rub"]), cw.fmt_int(price))
            promo_text = ("%s; %s" % (promo_text, discount_note)) if promo_text else discount_note
        lots.append({
            "price_rub": price,
            "area_m2": area,
            "rooms": rooms,
            "floor": floor,
            "floors_total": floors_total,
            "delivery": parse_delivery(block),
            "promo_text": promo_text,
            "building": "",
            "offer_id": offer_id,
            "offer_url": offer_url,
            "title": (title_match.group(1).strip() if title_match else "") or clean_text(block)[:80],
        })
    return lots


def parse_page(html, platform, url=""):
    """Результат разбора: список лотов и признак гранулярности."""
    lots = []
    cards = parse_cards(html, platform, url) if html else []
    for card in cards:
        if card.get("price_rub") is None:
            continue
        lots.append(card)
    if lots:
        return {"lots": lots, "granularity": "lots", "price_from_rub": None}
    json_ld = extract_json_ld(html or "")
    # лотом считаем только запись с ценой И площадью; «цена без площади» — агрегат страницы
    full = [item for item in json_ld if item.get("price_rub") and item.get("area_m2")]
    aggregate = [item for item in json_ld if item.get("price_rub") and not item.get("area_m2")]
    if full:
        return {"lots": [{"price_rub": item["price_rub"], "area_m2": item["area_m2"],
                          "rooms": parse_rooms(item["name"]), "floor": None, "floors_total": None,
                          "delivery": parse_delivery(item["name"]), "promo_text": "",
                          "building": "", "title": item["name"]} for item in full],
                "granularity": "json-ld", "price_from_rub": None}
    price_from = min([item["price_rub"] for item in aggregate], default=None) or price_from_page(html or "")
    return {"lots": [], "granularity": "price-from" if price_from else "none",
            "price_from_rub": price_from}


# --------------------------------------------------------------------------
# сеть: только анонимный HTTP
# --------------------------------------------------------------------------

def request_headers():
    """Заголовки запроса как есть — тест проверяет, что тут нет куки/токенов."""
    return dict(SAFE_HEADERS)


def build_unverified_opener():
    """Опенер без проверки сертификата: часть госсайтов отдаёт самоподписанную цепочку.

    Включается ЯВНО и только для чтения публичных страниц; факт фиксируется в метрике.
    """
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=context))


def http_fetch(url, timeout=25, max_bytes=3_000_000, opener=None, verify=True):
    """Анонимный GET. Возвращает (status_code, html, error)."""
    headers = request_headers()
    if opener is None and not verify:
        opener = build_unverified_opener()
    lowered = {key.lower() for key in headers}
    forbidden = lowered & set(FORBIDDEN_HEADERS)
    if forbidden:
        raise ValueError("в заголовках есть запрещённые: %s" % ", ".join(sorted(forbidden)))
    request = urllib.request.Request(url, headers=headers, method="GET")
    def open_stream():
        if opener is None:
            return urllib.request.urlopen(request, timeout=timeout)
        # у OpenerDirector основной метод open(), у модуля — urlopen(); поддерживаем оба
        method = getattr(opener, "urlopen", None) or getattr(opener, "open")
        return method(request, timeout=timeout)

    try:
        with open_stream() as response:
            raw = response.read(max_bytes)
            charset = response.headers.get_content_charset() or "utf-8"
            return getattr(response, "status", 200), raw.decode(charset, "replace"), None
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read(max_bytes).decode("utf-8", "replace")
        except Exception:
            pass
        return exc.code, body, "HTTP %s" % exc.code
    except Exception as exc:
        return None, "", str(exc)


def visible_text(html):
    """Текст без <script>/<style>: в JS площадок встречается слово captcha и это не блокировка."""
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html or "", flags=re.S | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.S | re.IGNORECASE)
    return clean_text(text)


def detect_block(status, html, platform):
    """(verdict, reason): verdict = ok | needs_browser | needs_partnership."""
    text = visible_text(html or "").lower()
    if status in BLOCK_STATUSES:
        if status == 401:
            # доступ закрыт на уровне API: без логина не пройти, вход мы не используем
            return "needs_partnership", ("HTTP 401: площадка отдаёт данные только по договору/API "
                                         "(%s)" % PLATFORMS[platform]["partnership"])
        if status == 403 and platform in ("cian", "domclick"):
            return "needs_partnership", "HTTP 403: %s" % PLATFORMS[platform]["partnership"]
        return "needs_browser", "HTTP %s" % status
    if any(marker in text for marker in CAPTCHA_MARKERS):
        return "needs_browser", "страница отдала капчу/проверку бота"
    if any(marker in text for marker in AUTH_MARKERS) and len(text) < 400:
        return "needs_partnership", "страница просит авторизацию — доступ только по партнёрству"
    if not text.strip():
        return "needs_browser", "пустой ответ"
    if any(marker in text for marker in JS_ONLY_MARKERS) and len(text) < 600:
        return "needs_browser", "страница требует JavaScript"
    return "ok", ""


# --------------------------------------------------------------------------
# Chrome over CDP: свежий профиль БЕЗ логина
# --------------------------------------------------------------------------

def find_chrome():
    candidates = [Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
                  Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
                  Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return Path(shutil.which("chrome.exe") or shutil.which("chrome") or "")


CHROME_ERROR_MARKERS = ("ошибка нарушения конфиденциальности", "privacy error", "err_cert",
                       "loadtimedataraw", "neterror", "ваше подключение не защищено",
                       "this site can", "сайт отключен", "сайт отключён")


def is_chrome_error_page(html):
    """Chrome на ошибке сертификата отдаёт свою страницу: её нельзя принимать за данные."""
    text = (html or "").lower()
    if not text:
        return True
    return any(marker in text for marker in CHROME_ERROR_MARKERS)


def chrome_launch_args(port, profile_dir, headless=False, ignore_cert_errors=False, no_sandbox=False):
    """Аргументы запуска: отдельный временный профиль => ни одной сохранённой сессии."""
    args = [str(find_chrome()),
            "--remote-debugging-port=%d" % int(port),
            "--user-data-dir=%s" % str(profile_dir),
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--disable-sync", "--disable-background-networking", "--disable-gpu", "about:blank"]
    if headless:
        args.insert(1, "--headless=new")
    if ignore_cert_errors:
        # сеть площадки подменяет сертификат (self-signed в цепочке); включается ЯВНО и только
        # для чтения публичных страниц, факт отмечается в метрике
        args.insert(1, "--ignore-certificate-errors")
    if no_sandbox:
        # Проверено 04.11.2026: внутри песочницы DSH собственный sandbox Chrome не поднимается —
        # процесс падает сразу (код 0x80000003), порт отладки не открывается. Флаг включается
        # ТОЛЬКО как вынужденный откат, с временным профилем и для чтения публичных страниц.
        args.insert(1, "--no-sandbox")
    return args


#: Как поднялся Chrome в последнем запуске: пусто — обычным способом, иначе причина отката.
LAST_CHROME_NOTE = ""


def launch_chrome(port=9333, profile_dir=None, headless=False, timeout=25, ignore_cert_errors=False,
                  allow_no_sandbox_fallback=True):
    """Поднимает Chrome с чистым профилем. Возвращает (process, profile_path).

    Если Chrome умирает при старте (под песочницей это ожидаемо), делается одна
    повторная попытка с ``--no-sandbox``; причина отката остаётся в
    :data:`LAST_CHROME_NOTE`, чтобы её можно было показать в отчёте, а не скрыть.
    """
    global LAST_CHROME_NOTE
    chrome = find_chrome()
    if not chrome or not Path(chrome).exists():
        raise RuntimeError("chrome.exe не найден")
    LAST_CHROME_NOTE = ""
    attempts = [False] + ([True] if allow_no_sandbox_fallback else [])
    last_error = "Chrome не поднял порт %d за %d с" % (int(port), timeout)
    for no_sandbox in attempts:
        profile = Path(profile_dir) if profile_dir else Path(tempfile.mkdtemp(prefix="cw-cdp-profile-"))
        process = subprocess.Popen(chrome_launch_args(port, profile, headless, ignore_cert_errors, no_sandbox),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if process.poll() is not None:
                # процесс уже умер: ждать таймаут бессмысленно, сразу переходим к откату
                last_error = "Chrome завершился при старте (код %s)" % process.poll()
                break
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % int(port), timeout=2):
                    if no_sandbox:
                        LAST_CHROME_NOTE = ("Chrome запущен с --no-sandbox: внутри песочницы "
                                            "обычный запуск падает (код 0x80000003)")
                    return process, profile
            except Exception:
                time.sleep(0.4)
        stop_chrome(process, profile)
    raise RuntimeError(last_error)


def stop_chrome(process, profile=None):
    if process is not None:
        try:
            process.terminate()
            process.wait(timeout=10)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
    if profile:
        shutil.rmtree(str(profile), ignore_errors=True)


def cdp_html(url, port=9333, wait_ms=6000, node_exe=None, cdp_script=None, timeout=90):
    """HTML страницы из Chrome через cdp-eval.mjs (без логина — профиль пустой)."""
    node = Path(node_exe) if node_exe else next((path for path in NODE_CANDIDATES if path.exists()), None)
    if node is None:
        node = Path(shutil.which("node") or "")
    script = Path(cdp_script) if cdp_script else CDP_SCRIPT
    if not node or not Path(node).exists() or not script.exists():
        raise RuntimeError("нет node или cdp-eval.mjs")
    completed = subprocess.run(
        [str(node), str(script), "--url", url, "--port", str(port), "--wait-ms", str(wait_ms),
         "--expr", "document.documentElement.outerHTML"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if completed.returncode != 0:
        raise RuntimeError("cdp-eval вернул код %d: %s" % (completed.returncode,
                                                           (completed.stderr or "")[:200]))
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("cdp-eval вернул не JSON: %s" % exc)
    if payload.get("exception"):
        raise RuntimeError("исключение в браузере: %s" % payload["exception"])
    return payload.get("result") or ""


PROJECT_PAGE_MARKERS = ("/zhk", "/jk/", "zhk-", "/project", "/complex", "/novostroyka")


def is_project_page(url):
    """Похоже ли на страницу конкретного ЖК, а не на городскую выдачу."""
    lowered = str(url or "").lower()
    return any(marker in lowered for marker in PROJECT_PAGE_MARKERS)


def catalog_caveat(url):
    return ("" if is_project_page(url) else
            " (каталожная/поисковая страница: список лотов рыночный, привязка к конкретному ЖК условная)")


def mentions_name(html, name):
    """Есть ли на странице имя конкурента — иначе привязка лотов была бы выдумкой."""
    if not name:
        return True
    text = clean_text(html or "").lower()
    if not text:
        return False
    candidate = clean_text(name).lower()
    if candidate in text:
        return True
    words = [word for word in re.split(r"[^0-9a-zа-яё]+", candidate) if len(word) > 3]
    return any(word in text for word in words)


# Данные, которые площадки кладут не в HTML, а в JS-состояние страницы.
# Приём для Циан взят из 00-admin/scripts/probe-catalog.mjs.txt (проверен вручную).
JS_STATE_BODIES = {
    "cian": """
const cfg = window._cianConfig || {};
const st = cfg["newbuilding-search-frontend"] || [];
const init = (st.find((e) => e && e.key === "initialState") || {}).value || {};
const nb = ((init.offersData || {}).newbuildings) || [];
return JSON.stringify({ kind: "cian-newbuildings", items: nb.map(function (x) { return {
  name: x.name || null, id: x.id || null, developers: (x.builders || []).map(function (b) { return b.name; }),
  klass: x.housingClass || x.klass || null, price_per_m2: x.pricePerMeter || x.price_per_m2 || null,
  lat: x.lat || x.latitude || null, lon: x.lng || x.lon || x.longitude || null,
  url: x.url || x.siteUrl || null }; }) });
""",
    "generic": """
const state = window.__INITIAL_STATE__ || window.__PRELOADED_STATE__ || window.__NEXT_DATA__ || null;
if (!state) { return JSON.stringify({ kind: "none", items: [] }); }
return JSON.stringify({ kind: "generic-state", items: [] });
""",
}


def cdp_eval_json(url, body, port=9333, wait_ms=6000, headless=True, node_exe=None, cdp_script=None,
                  timeout=120, ignore_cert_errors=False):
    """Выполнить JS в контексте страницы через CDP и вернуть разобранный JSON."""
    node = Path(node_exe) if node_exe else next((path for path in NODE_CANDIDATES if path.exists()), None)
    if node is None:
        node = Path(shutil.which("node") or "")
    script = Path(cdp_script) if cdp_script else CDP_SCRIPT
    if not node or not Path(node).exists() or not script.exists():
        raise RuntimeError("нет node или cdp-eval.mjs")
    completed = subprocess.run(
        [str(node), str(script), "--url", url, "--port", str(port), "--wait-ms", str(wait_ms),
         "--expr", body],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if completed.returncode != 0:
        raise RuntimeError("cdp-eval вернул код %d: %s" % (completed.returncode,
                                                           (completed.stderr or "")[:200]))
    payload = json.loads(completed.stdout)
    if payload.get("exception"):
        raise RuntimeError("исключение в браузере: %s" % payload["exception"])
    raw = payload.get("result")
    if not raw:
        return {"kind": "none", "items": []}
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {"kind": "raw", "items": [], "raw": str(raw)[:500]}


def js_state_candidates(platform, state):
    """Новостройки из JS-состояния -> кандидаты (name, developer, class, price, coords)."""
    items = (state or {}).get("items") or []
    candidates = []
    for item in items:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        developers = item.get("developers") or []
        candidates.append({
            "name": str(item["name"]),
            "developer": ", ".join(str(name) for name in developers if name) or "",
            "class": str(item.get("klass") or ""),
            "price_per_m2": item.get("price_per_m2"),
            "lat": item.get("lat"), "lon": item.get("lon"),
            "url": item.get("url"),
            "source": platform,
            "sources": [{"platform": platform, "url": item.get("url")}],
        })
    return candidates


def balanced_json_at(text, start, max_length=200000):
    """Разобрать JSON-объект, начинающийся на позиции start (балансируя скобки)."""
    if start < 0 or start >= len(text):
        return None
    depth, quote, escaped = 0, None, False
    for index in range(start, min(len(text), start + max_length)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "\"\x27":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:index + 1])
                except Exception:
                    return None
    return None


def extract_enclosing_json(text, marker, max_attempts=10):
    """Самый ВНЕШНИЙ JSON-объект, содержащий маркер (для вложенных структур вроде ЕИСЖС)."""
    index = (text or "").find(marker)
    if index < 0:
        return []
    best = None
    position = index
    for _ in range(max_attempts):
        position = text.rfind("{", 0, position)
        if position < 0:
            break
        parsed = balanced_json_at(text, position)
        if parsed is not None:
            best = parsed
    return [best] if best is not None else []


def extract_json_objects(text, marker, max_length=40000):
    """Достать JSON-объекты, содержащие маркер, балансируя скобки (страницы кладут данные в JS)."""
    objects = []
    for match in re.finditer(re.escape(marker), text or ""):
        start = text.rfind("{", 0, match.start())
        if start < 0:
            continue
        depth, quote, escaped = 0, None, False
        for index in range(start, min(len(text), start + max_length)):
            char = text[index]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
                continue
            if char in "\"\x27":
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        objects.append(json.loads(text[start:index + 1]))
                    except Exception:
                        pass
                    break
    return objects


def cian_catalog_entries(url=None, limit=30):
    """Список ЖК из каталога Циан обычным HTTP (без логина и без браузера).

    Координат в списке нет — их определяет геокодер по названию/адресу (кэш в geocache.json).
    """
    url = url or PLATFORM_SEARCH_URLS["cian"]
    status, html, error = http_fetch(url)
    if status != 200 or not html:
        return [], {"status": "error", "note": "каталог не отдался: HTTP %s %s" % (status, error or "")}
    marker = '"objectType":"JK"'
    items = extract_json_objects(html, marker)
    entries = []
    seen = set()
    for item in items:
        name = str(item.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        entries.append({"name": "ЖК " + name if not name.lower().startswith("жк") else name,
                        "developer": "", "class": "",
                        "url": url, "source": "cian", "cian_id": item.get("id"),
                        "sources": [{"platform": "cian", "url": url}]})
        if len(entries) >= limit:
            break
    return entries, {"status": "ok" if entries else "no_data",
                     "note": "каталог Циан: %d ЖК в списке" % len(entries)}


def cian_project_summary(url, timeout=25, expect_name=None):
    """Сводка по странице ЖК на Циан обычным HTTP: лоты, медиана ₽/м², адрес из JS-состояния."""
    status, html, error = http_fetch(url, timeout=timeout)
    if status != 200 or not html:
        return {"status": "error", "note": "HTTP %s" % status, "price_per_m2": None, "address": ""}
    if expect_name and not mentions_name(html, expect_name):
        return {"status": "mismatch", "note": "страница не про этого конкурента",
                "price_per_m2": None, "address": ""}
    parsed = parse_page(html, "cian", url)
    lots = parsed["lots"]
    complete = [lot for lot in lots if lot.get("price_rub") and lot.get("area_m2")]
    ppm2 = [lot["price_rub"] / lot["area_m2"] for lot in complete]
    address_match = re.search(r'"address"\s*:\s*"([^"]{5,90})"', html)
    # медиана — как в движке (половина-к-чётному), а не «верхний из двух»
    return {"status": "ok" if lots else "no_data",
            "lots": len(lots), "complete": len(complete),
            "price_per_m2": cw.median_rounded(ppm2),
            "median_price": cw.median_rounded([lot["price_rub"] for lot in complete]),
            "min_price": min((lot["price_rub"] for lot in lots if lot.get("price_rub")), default=None),
            "address": address_match.group(1) if address_match else "",
            "method": "http",
            "note": "страница ЖК Циан: %d лотов, %d с ценой и площадью" % (len(lots), len(complete))}


def collect_platform(url, platform, allow_browser=True, port=9333, wait_ms=6000, http_timeout=25,
                     expect_name=None, headless=False):
    """Собрать проектную страницу площадки. Возвращает честный статус и лоты."""
    platform = "yandex_realty" if platform in ("yandex-realty", "yandex") else platform
    result = {"source": PLATFORMS.get(platform, {}).get("status_column", platform),
              "platform": platform, "url": url, "status": "no_data", "note": "",
              "lots": [], "granularity": "none", "price_from_rub": None, "transport": "http"}
    status, html, error = http_fetch(url, timeout=http_timeout)
    parsed = parse_page(html, platform, url) if html else {"lots": [], "granularity": "none",
                                                           "price_from_rub": None}
    # Если данные реально есть — страница не заблокирована, даже если в разметке мелькают
    # слова про капчу (у Циан они есть в служебных скриптах).
    verdict, reason = ("ok", "") if parsed["lots"] else detect_block(status, html, platform)
    if verdict == "ok":
        result.update(parsed)
        if parsed["lots"] and expect_name and not mentions_name(html, expect_name):
            # страница не про этого конкурента: лоты не привязываем, чтобы не выдумывать
            result["lots"] = []
            result["status"] = "no_data"
            result["note"] = ("страница не упоминает «%s» — похоже на каталожную выдачу; "
                              "лоты не привязаны к проекту" % expect_name)
            return result
        if parsed["lots"] and expect_name and not mentions_name(html, expect_name):
            result["lots"] = []
            result["status"] = "no_data"
            result["method"] = "none"
            result["note"] = ("страница не упоминает «%s» — похоже на каталожную выдачу; "
                              "лоты не привязаны к проекту" % expect_name)
            return result
        if parsed["lots"]:
            result["status"] = "ok"
            result["method"] = "http"
            result["note"] = "получено обычным HTTP (User-Agent Chrome), без логина" + catalog_caveat(url)
            return result
        result["status"] = "no_data"
        result["method"] = "none"
        result["note"] = "страница открылась, но лотов на ней нет" + (
            " (видна только цена «от»)" if parsed["price_from_rub"] else "")
        if not allow_browser or PLATFORM_TRANSPORT.get(platform, "http-then-browser") == "http-only":
            return result
    elif not allow_browser or PLATFORM_TRANSPORT.get(platform, "http-then-browser") == "http-only":
        result["status"] = verdict
        result["method"] = "none"
        result["note"] = reason + ("" if allow_browser else " (браузер отключён флагом)")
        if allow_browser and PLATFORM_TRANSPORT.get(platform, "") == "http-only":
            result["note"] += " (для этого источника браузерный режим не используется)"
        return result
    else:
        result["note"] = reason

    # --- вторая попытка: браузер с чистым профилем (без входа в аккаунт) ---
    process = None
    profile = None
    try:
        process, profile = launch_chrome(port=port, headless=headless)
        html = cdp_html(url, port=port, wait_ms=wait_ms)
        result["transport"] = "chrome-cdp-no-login" + ("-headless" if headless else "")
        parsed = parse_page(html, platform, url)
        result.update(parsed)
        if parsed["lots"]:
            result["status"] = "ok"
            result["method"] = "dom"
            result["note"] = ("получено через Chrome (CDP, профиль без логина) из DOM; "
                              "обычный HTTP был заблокирован: %s" % (reason or "нет причины"))
        else:
            # Данные могут лежать не в разметке, а в JS-состоянии страницы (приём для Циан).
            state = {"kind": "none", "items": []}
            body = JS_STATE_BODIES.get(platform)
            if body:
                try:
                    state = cdp_eval_json(url, body, port=port, wait_ms=wait_ms, headless=headless)
                except Exception as exc:
                    state = {"kind": "error", "items": [], "error": str(exc)}
            result["js_state_kind"] = state.get("kind")
            if state.get("items"):
                result["js_state"] = state["items"]
                result["status"] = "ok" if parsed["lots"] else "no_data"
                result["method"] = "js-state"
                result["note"] = ("DOM не дал лотов; из JS-состояния страницы (%s) получено "
                                  "новостроек: %d — без логина, профиль чистый"
                                  % (state.get("kind"), len(state["items"])))
            else:
                verdict2, reason2 = detect_block(200, html, platform)
                result["method"] = "none"
                if verdict2 == "ok":
                    result["status"] = "no_data"
                    result["note"] = ("в браузере страница открылась, но ни в DOM, ни в JS-состоянии "
                                      "лотов нет" + (" (видна только цена «от»)" if parsed["price_from_rub"] else ""))
                else:
                    result["status"] = verdict2
                    result["note"] = reason2
    except Exception as exc:
        result["status"] = verdict if verdict != "ok" else "needs_browser"
        result["note"] = "%s; браузер тоже не помог: %s" % (result["note"] or "HTTP не дал данных", exc)
    finally:
        stop_chrome(process, profile)
    return result


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(prog="platforms.py",
                                     description="Публичные страницы площадок без логина: проверка и сбор.")
    parser.add_argument("url", help="адрес страницы проекта/ЖК")
    parser.add_argument("--platform", default="site", choices=sorted(PLATFORMS.keys()))
    parser.add_argument("--no-browser", action="store_true", help="не поднимать Chrome (только HTTP)")
    parser.add_argument("--headless", action="store_true", help="Chrome без окна (--headless=new)")
    parser.add_argument("--port", type=int, default=9333)
    parser.add_argument("--wait-ms", type=int, default=6000)
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv=None):
    cw.setup_console()
    args = build_parser().parse_args(argv)
    result = collect_platform(args.url, args.platform, allow_browser=not args.no_browser,
                              port=args.port, wait_ms=args.wait_ms, headless=args.headless)
    if args.json:
        print(json.dumps({key: value for key, value in result.items() if key != "lots"},
                         ensure_ascii=False, indent=2))
        print("лотов: %d" % len(result["lots"]))
        return 0
    print("Площадка: %s (%s)" % (PLATFORMS.get(args.platform, {}).get("name", args.platform), args.platform))
    print("Статус:   %s" % result["status"])
    print("Транспорт: %s" % result["transport"])
    print("Заметка:  %s" % result["note"])
    if result.get("price_from_rub"):
        print("Цена «от» на странице: %s ₽" % cw.fmt_int(result["price_from_rub"]))
    print("Лотов:    %d (%s)" % (len(result["lots"]), result["granularity"]))
    for lot in result["lots"][:5]:
        print("  - %s ₽ | %s м² | комнат: %s" % (cw.fmt_int(lot.get("price_rub")),
                                                 lot.get("area_m2"), lot.get("rooms")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

