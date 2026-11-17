"""Скилл ``developer_pricing`` — цены с сайта застройщика по позициям каталога.

Источник
--------
Публичная страница застройщика (HTML), анонимный HTTP без ключа и без логина.
Пример: ``https://level.ru/projects/southport/``.

Зачем отдельный скилл
---------------------
Движок Агента 1 берёт цену позиции первым денежным числом в карточке. На
реальных сайтах в карточке рядом стоят суммы, которые ценой лота НЕ являются:
«первоначальный взнос», «платёж по ипотеке», «цена за м²», «скидка». Из-за этого
в снимок попадали неправдоподобные ₽/м² (дефект F10: 34 700 и 74 928 ₽/м²).
Здесь цена выбирается по правилам честности, а не «первое совпадение»:

1. берутся только денежные числа, стоящие рядом со знаком ₽ или «руб»;
2. отбрасываются числа, рядом с которыми стоят слова-обманки
   («взнос», «платёж», «ипотек», «ставка», «скидк», «кэшбэк», «трейд-ин»,
   «паркинг», «кладов», «машиноместо», «аренд», «ремонт», «мебел», «₽/м²»);
3. из оставшихся берётся самое крупное — цена квартиры на карточке больше
   любой сопутствующей суммы;
4. если площадь известна, а ``цена / площадь`` выходит за правдоподобный
   коридор :data:`PPM2_MIN` … :data:`PPM2_MAX`, цена НЕ публикуется: поле
   остаётся пустым (``None``), а причина пишется в ``raw.rejected``.

Вход
----
:param query: URL страницы застройщика (``http``/``https``)
:param timeout: таймаут запроса, не больше 10 секунд
:param max_cards: предохранитель: сколько карточек разбирать, по умолчанию 200

Выход
-----
``list[dict]`` в едином формате :func:`skills.runtime.make_record`:

* ``price`` — цена позиции в рублях или ``None``;
* ``area`` — площадь, м²;
* ``rooms`` — комнатность (``0`` — студия), или ``None``;
* ``url`` — адрес позиции, если он есть в карточке, иначе адрес страницы;
* ``raw`` — что именно нашли: ``price_text``, ``rejected``, ``granularity``.

Ограничения (честно)
--------------------
* Это цены «от» по позициям каталога (корпус + тип квартиры + площадь), а НЕ
  шахматка по каждому лоту: номера лота на странице нет.
* Только анонимный HTTP. Если сайт отдаёт каркас SPA или блокирует робота,
  скилл честно сообщает об этом статусом ``not_deployed`` и возвращает ``[]``:
  страницу в этом случае должен открыть браузер (Chrome CDP) в движке Агента 1.
* ``year_built`` и ``address`` остаются ``None``: на ценовой странице их нет,
  а додумывать нельзя.
"""

from __future__ import annotations

if __package__ in (None, ""):  # запуск файла напрямую: python skills/real_estate/developer_pricing.py <url>
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import re
from typing import Any

from skills.runtime import (
    SkillError,
    SkillUnavailable,
    http_text,
    make_record,
    skill,
)

SKILL_NAME = "developer_pricing"
DEFAULT_TIMEOUT = 10.0
MAX_CARDS = 200

#: Правдоподобный коридор ₽/м² для новостроек Москвы (тот же, что в движке,
#: ``01-competitor-watch/scripts/lot_history_pipeline.py``: PLAUSIBLE_PPM2).
PPM2_MIN = 120_000
PPM2_MAX = 1_200_000

#: Слова рядом с суммой, которые означают «это не цена лота».
MONEY_NOISE = (
    "взнос", "платёж", "платеж", "ипотек", "ставка", "скидк", "кэшбэк", "кешбэк",
    "трейд-ин", "паркинг", "кладов", "машиноместо", "аренд", "ремонт", "мебел",
    "₽/м", "руб/м", "/м²", "/м2", "за м²", "за м2", "за метр", "в месяц", "/мес",
)
#: Насколько близко к числу искать слово-обманку.
NOISE_WINDOW = 30
#: Признаки адреса, который НЕ является позицией лота: паркинг, ипотека, каталог, акции.
NON_LOT_URL_MARKERS = ("/parking", "/parkovka", "/machin", "/машином", "/mortgage", "/ipoteka",
                       "/filter", "/purchase", "/actions", "/akcii", "/promo", "/news",
                       "/contacts", "/about")

#: Метаданные скилла — попадают в реестр и в документацию.
SKILL: dict[str, Any] = {
    "name": SKILL_NAME,
    "title": "Цены с сайта застройщика",
    "kind": "HTML-страница",
    "required_env": [],
    "free_tier": "бесплатно: публичная страница, ключ не нужен",
    "docs": "—",
}

MONEY_MLN_RE = re.compile(r"([0-9]+(?:[.,][0-9]+)?)\s*млн")
MONEY_RUB_RE = re.compile(r"([0-9]{1,3}(?:[ \u00a0][0-9]{3})+|[0-9]{4,})\s*(?:₽|руб)")
AREA_RE = re.compile(r"([0-9]+(?:[.,][0-9]+)?)\s*(?:м\s*²|м\s*2|кв\.?\s*м)")
#: Процент скидки на карточке («-35%», «скидка 20 %»).
DISCOUNT_PCT_RE = re.compile(r"(\d{1,2})\s*%")
ROOMS_RE = re.compile(r"([1-5])\s*[-\s]?\s*(?:комн|к\.|комнатн)")
STUDIO_RE = re.compile(r"студи", re.IGNORECASE)
CARD_SPLIT_RE = re.compile(
    r"(?=<article|card-flat|class=\"[^\"]*(?:flat|lot|offer|premise|apartment)[^\"]*\")"
)
HREF_RE = re.compile(r'href="([^"#]+)"')
TITLE_RE = re.compile(r">([^<>]{4,80})<")


def clean_text(value: Any) -> str:
    """Убрать теги и сжать пробелы: дальше ищем по видимому тексту карточки."""
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def money_candidates(text: str) -> list[tuple[int, int, int]]:
    """Все денежные числа текста: ``(начало, конец, рубли)``.

    «12 500 000 ₽» → 12 500 000; «23,18 млн» → 23 180 000.
    """
    found: list[tuple[int, int, int]] = []
    for match in MONEY_MLN_RE.finditer(text or ""):
        try:
            value = float(match.group(1).replace(",", ".")) * 1_000_000
        except ValueError:
            continue
        found.append((match.start(), match.end(), int(round(value))))
    for match in MONEY_RUB_RE.finditer(text or ""):
        digits = re.sub(r"[^0-9]", "", match.group(1))
        if digits:
            found.append((match.start(), match.end(), int(digits)))
    found.sort()
    return found


def marked_by_noise(text: str, candidates: list[tuple[int, int, int]]) -> set[int]:
    """Индексы чисел, к которым привязаны слова-обманки («взнос», «₽/м²», «/мес»).

    Слово относится к **ближайшему** числу: «84 903 руб./мес. 25 364 668 руб.» —
    «/мес» про первое число, и настоящая цена из-за него не отбрасывается.
    """
    marked: set[int] = set()
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


def is_lot_price(text: str, index: int, candidates: list[tuple[int, int, int]]) -> bool:
    """Число не подписано словами-обманками («взнос», «₽/м²», «в месяц» …)."""
    return index not in marked_by_noise(text, candidates)


def pick_lot_price(text: str) -> int | None:
    """Цена лота: самое крупное «честное» денежное число карточки, иначе ``None``."""
    cleaned = clean_text(text)
    candidates = money_candidates(cleaned)
    best: int | None = None
    for index, (_, _, value) in enumerate(candidates):
        if not is_lot_price(cleaned, index, candidates):
            continue
        if best is None or value > best:
            best = value
    return best


def pick_area(text: str) -> float | None:
    """Площадь, м² (первое явное «N м²» / «N кв. м»)."""
    match = AREA_RE.search(clean_text(text))
    if not match:
        return None
    try:
        return round(float(match.group(1).replace(",", ".")), 1)
    except ValueError:
        return None


def pick_rooms(text: str) -> int | None:
    """Комнатность: ``0`` — студия, ``6`` — «5+», иначе ``None``."""
    text = clean_text(text)
    if STUDIO_RE.search(text):
        return 0
    match = ROOMS_RE.search(text)
    if match:
        return int(match.group(1))
    if "5+" in text or "5 +" in text:
        return 6
    return None


def discount_pair(text: str) -> tuple[int | None, int | None]:
    """``(текущая цена, цена до скидки)`` — только если процент на странице сходится.

    Живой level.ru (04.11.2026): «25 364 668 руб. 16 487 034 руб. -35%» — текущая
    цена меньшая, и это подтверждается процентом на самой странице. Не сходится —
    ничего не выдумываем.
    """
    cleaned = clean_text(text)
    candidates = money_candidates(cleaned)
    honest = [item for index, item in enumerate(candidates) if is_lot_price(cleaned, index, candidates)]
    for left, right in zip(honest, honest[1:]):
        larger, smaller = (left[2], right[2]) if left[2] >= right[2] else (right[2], left[2])
        if smaller <= 0 or larger == smaller:
            continue
        percent = round((1 - smaller / larger) * 100)
        if percent <= 0 or percent > 90:
            continue
        window = cleaned[left[1]:right[1] + 40]
        if any(abs(int(match.group(1)) - percent) <= 1 for match in DISCOUNT_PCT_RE.finditer(window)):
            return smaller, larger
    return None, None


def pick_lot_price_details(text: str) -> dict:
    """Цена лота и (если подтверждено процентом) цена до скидки."""
    smaller, larger = discount_pair(text)
    if smaller:
        return {"price_rub": smaller, "price_before_rub": larger}
    return {"price_rub": pick_lot_price(text), "price_before_rub": None}


def ppm2_within_range(price: int | None, area: float | None) -> bool:
    """Сходится ли цена с площадью: ₽/м² внутри правдоподобного коридора.

    Если площади нет, проверять нечего — возвращаем ``True`` (проверка
    выполняется там, где есть оба числа).
    """
    if not price or not area:
        return True
    return PPM2_MIN <= (price / area) <= PPM2_MAX


def split_cards(html: str) -> list[str]:
    """Карточки предложений на странице; нет ни одной — пустой список."""
    if not html:
        return []
    parts = [part for part in CARD_SPLIT_RE.split(html) if part.strip()]
    return parts[1:] if len(parts) > 1 else []


def pick_position_url(card: str, page_url: str) -> str:
    """Адрес позиции из карточки; нет ссылки — адрес самой страницы."""
    match = HREF_RE.search(card or "")
    if not match:
        return page_url
    href = match.group(1).strip()
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        root = re.match(r"^(https?://[^/]+)", page_url or "")
        if root:
            return root.group(1) + href
    return page_url


def project_slug(url: str) -> str:
    """Слаг проекта из адреса страницы застройщика (``/projects/<slug>/``)."""
    match = re.search(r"/projects/([^/?#]+)", str(url or ""), re.IGNORECASE)
    return match.group(1).lower() if match else ""


def is_lot_position_url(position_url: str, page_url: str = "") -> bool:
    """Адрес позиции — это лот, а не паркинг/ипотека/каталог и не другой ЖК.

    Проверено на живом ``level.ru`` (04.11.2026): в выдаче попадаются страницы
    ``/parking``, ``/purchase/mortgage``, ``/filter/...`` и карточки другого
    проекта (``/projects/lesnoy/`` при разборе ``/projects/southport/``).
    """
    url = str(position_url or "").lower()
    if any(marker in url for marker in NON_LOT_URL_MARKERS):
        return False
    page = project_slug(page_url)
    found = project_slug(position_url)
    return not (page and found and page != found)


def parse_positions(html: str, page_url: str, max_cards: int = MAX_CARDS) -> list[dict]:
    """Разобрать страницу: позиции каталога с честной ценой и отметкой причин."""
    positions: list[dict] = []
    for card in split_cards(html)[:max_cards]:
        area = pick_area(card)
        rooms = pick_rooms(card)
        details = pick_lot_price_details(card)
        price = details["price_rub"]
        position_url = pick_position_url(card, page_url)
        if not is_lot_position_url(position_url, page_url):
            # паркинг, ипотека, каталог или другой ЖК — не позиция нашего конкурента
            continue
        rejected = None
        if price is not None and not ppm2_within_range(price, area):
            rejected = (
                "цена не публикуется: %d ₽ / %s м² = %d ₽/м² вне коридора %d…%d"
                % (price, area, int(round(price / area)), PPM2_MIN, PPM2_MAX)
            )
            price = None
        title_match = TITLE_RE.search(clean_text(card))
        if price is None and area is None and rooms is None:
            continue
        positions.append({
            "price": price,
            "price_before": details["price_before_rub"],
            "area": area,
            "rooms": rooms,
            "url": position_url,
            "title": (title_match.group(1).strip() if title_match else "") or clean_text(card)[:80],
            "rejected": rejected,
        })
    return positions


@skill(SKILL_NAME)
def fetch(query: str, *, timeout: float = DEFAULT_TIMEOUT, max_cards: int = MAX_CARDS) -> list[dict]:
    """Прочитать цены позиций со страницы застройщика по её URL."""
    url = str(query or "").strip()
    if not url:
        return []
    if not url.lower().startswith(("http://", "https://")):
        return []

    try:
        html = http_text(url, timeout=timeout, skill=SKILL_NAME)
    except SkillError as exc:
        message = str(exc)
        if re.search(r"HTTP (401|403|405|429|439|503)", message):
            raise SkillUnavailable(
                "сайт не отдал страницу анонимному HTTP (%s) — нужен браузер (Chrome CDP) "
                "в движке Агента 1" % message[:120]
            ) from exc
        raise

    positions = parse_positions(html, url, max_cards=max_cards)
    records: list[dict] = []
    for index, position in enumerate(positions, start=1):
        records.append(
            make_record(
                SKILL_NAME,
                id=index,
                title=position["title"],
                price=position["price"],
                price_before_rub=position.get("price_before"),
                area=position["area"],
                year_built=None,
                address=None,
                url=position["url"],
                rooms=position["rooms"],
                granularity="цена «от» по позиции каталога (корпус + тип квартиры + площадь)",
                limitations="номера лота, этажа и срока сдачи на ценовой странице может не быть",
                rejected=position["rejected"],
                raw={
                    "page_url": url,
                    "position": index,
                    "price_rub": position["price"],
                    "area_m2": position["area"],
                    "rooms": position["rooms"],
                    "url": position["url"],
                    "title": position["title"],
                    "rejected": position["rejected"],
                },
            )
        )
    return records


if __name__ == "__main__":  # ручная проверка: python skills/real_estate/developer_pricing.py <url>
    import json
    import sys

    from skills.runtime import enable_utf8_stdout

    enable_utf8_stdout()
    target = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps(fetch(target), ensure_ascii=False, indent=2))
