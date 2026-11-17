r"""marketing_settings.py - marketing settings of Agent 1 (contract v1).

Source of truth: registry/agent-settings/agent-1-competitor-watch.yaml
Contract: docs/agent-1-marketing-settings-contract.md

Why this module exists
----------------------
The marketing fields in the agent's thin settings used to be "present in the
panel, ignored by the engine" (defect D5): selection filters, top_deals_count,
price_metric and the outlier guard did not change anything in the report.
This module reads those fields, normalises them to the contract defaults and
gives the engine three things:

    1. a normalised settings object (missing key -> contract default,
       unknown key -> warning, the value itself is kept and never dropped);
    2. lot filters for the "Что анализировать" group, with a rejection reason
       per lot so the number of dropped lots is never hidden;
    3. price blocks / outlier detection for "median | mean | min_max" and the
       outlier guard, so a distorted slice is marked unreliable instead of
       being published as a real conclusion.

Honesty rules
-------------
* a missing key means the contract default, and the object records that the
  value came from the default (`present: False`) so the panel can say so;
* an unknown key is reported in `warnings` and kept in `unknown`, never
  silently dropped and never substituted;
* an invalid value is reported in `warnings`/`invalid` and the contract
  default is used;
* nothing is invented: filters only drop lots that really are in the data.

Standard library only.
"""
from __future__ import annotations

import datetime as _dt

# --------------------------------------------------------------------------
# contract defaults (docs/agent-1-marketing-settings-contract.md)
# --------------------------------------------------------------------------

DEFAULT_SELECTION = {
    "room_types": ["0", "1", "2", "3", "4", "5+"],
    "area_min_m2": 0.0,
    "area_max_m2": 0.0,
    "price_min_rub": 0,
    "price_max_rub": 0,
    "exclude_first_floor": False,
    "exclude_last_floor": False,
    "finishes": ["без отделки", "white box", "чистовая", "с мебелью", "unknown"],
    "only_active": True,
    "promo_only": False,
    "price_metric": "median",
    "outlier_guard": True,
    "outlier_same_price_min_lots": 5,
    "outlier_ppm2_min": 150000,
    "outlier_ppm2_max": 800000,
}

DEFAULT_WATCH = {
    "radius_km": 10.0,
    "klass": [],
    "max_candidates": 20,
    "sources": [],
    "price_min_per_m2": 0,
    "price_max_per_m2": 0,
}

DEFAULT_AGENT1 = {
    "price_threshold_pct": 5.0,
    "compare_depth_weeks": 2,
    "top_deals_count": 5,
    "min_lots": 10,
}

# Keys the engine knows and reads. Anything else in the same subtree is reported
# as an unknown key (warning) but kept.
KNOWN_SELECTION = tuple(DEFAULT_SELECTION)
KNOWN_WATCH = ("query", "name", "address", "url", "lat", "lon", "coords",
               "radius_km", "klass", "max_candidates", "sources",
               "price_min_per_m2", "price_max_per_m2")
KNOWN_AGENT1 = ("projects", "price_threshold_pct", "min_lots", "promo_words", "collect_mode",
                "compare_depth_weeks", "watch", "selection", "top_deals_count", "analytics",
                "competitor_domains", "source_modes", "competitors")

PRICE_METRICS = ("median", "mean", "min_max")
ROOM_TYPE_VALUES = ("0", "1", "2", "3", "4", "5+")
FINISH_VALUES = ("без отделки", "white box", "чистовая", "с мебелью", "unknown")

# Rejection reasons reported in the "Ограничения" section, in display order.
REJECTION_REASONS = (
    ("room_type", "тип квартиры вне выбранных"),
    ("area_min", "площадь меньше area_min_m2"),
    ("area_max", "площадь больше area_max_m2"),
    ("price_min", "цена меньше price_min_rub"),
    ("price_max", "цена больше price_max_rub"),
    ("first_floor", "первый этаж (exclude_first_floor)"),
    ("last_floor", "последний этаж (exclude_last_floor)"),
    ("finish", "отделка вне выбранных"),
    ("not_active", "лот не «в продаже» (only_active)"),
    ("no_promo", "лот без акции (promo_only)"),
)


# --------------------------------------------------------------------------
# small coercion helpers: never raise, always report
# --------------------------------------------------------------------------

def _as_float(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value):
    number = _as_float(value)
    if number is None:
        return None
    try:
        return int(round(number))
    except (TypeError, ValueError, OverflowError):
        return None


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return None
    text = str(value).strip().casefold()
    if text in ("true", "1", "yes", "да", "вкл", "on"):
        return True
    if text in ("false", "0", "no", "нет", "выкл", "off"):
        return False
    return None


def _as_list(value):
    if isinstance(value, list):
        return list(value)
    if value is None or value == "":
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("[") and text.endswith("]"):
            text = text[1:-1]
        return [item.strip().strip("\"'") for item in text.split(",") if item.strip()]
    return None


def _room_type(value):
    """Normalise one room type to the contract vocabulary ('0', '1', '5+'...)."""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip().casefold().replace("студия", "0").replace("studio", "0")
    if text in ROOM_TYPE_VALUES:
        return text
    number = _as_int(text)
    if number is None:
        return None
    if number >= 5:
        return "5+"
    if number < 0:
        return None
    return str(number)


# --------------------------------------------------------------------------
# the settings object
# --------------------------------------------------------------------------

class MarketingSettings(object):
    """Normalised marketing settings of Agent 1.

    Attributes
    ----------
    selection : dict   "Что анализировать" (contract group 2) with defaults applied
    watch     : dict   "Охват и радиус" (group 1) with defaults applied
    agent1    : dict   "Сравнение и выводы" (group 3) with defaults applied
    warnings  : list   human-readable problems found while normalising
    unknown   : dict   unknown keys kept as-is ({group: {key: value}})
    present   : dict   which groups/keys really came from the YAML file
    """

    def __init__(self, raw=None):
        raw = raw if isinstance(raw, dict) else {}
        self.raw = raw
        self.warnings = []
        self.unknown = {}
        self.present = {}

        node = raw.get("agent1")
        agent1_raw = node if isinstance(node, dict) else {}
        if not isinstance(node, dict):
            self.present["agent1"] = False
        else:
            self.present["agent1"] = True

        self.selection = self._normalise_selection(agent1_raw.get("selection"), agent1_raw)
        self.watch = self._normalise_watch(agent1_raw.get("watch"))
        self.agent1 = self._normalise_agent1(agent1_raw)

    # -- groups ---------------------------------------------------------

    def _normalise_selection(self, raw, agent1_raw):
        raw = raw if isinstance(raw, dict) else {}
        self.present["selection"] = isinstance(agent1_raw.get("selection"), dict)
        values = dict(DEFAULT_SELECTION)
        invalid = []

        room_types = _as_list(raw.get("room_types"))
        if room_types is None and raw.get("room_types") is not None:
            invalid.append("room_types")
        elif room_types is not None:
            cleaned = [item for item in (_room_type(value) for value in room_types) if item]
            if cleaned:
                values["room_types"] = sorted(set(cleaned), key=_room_order)
            else:
                invalid.append("room_types")

        for key, minimum, maximum in (("area_min_m2", 0.0, 400.0),
                                      ("area_max_m2", 0.0, 400.0)):
            number = _as_float(raw.get(key))
            if raw.get(key) is not None and number is None:
                invalid.append(key)
            elif number is not None:
                if not (minimum <= number <= maximum):
                    invalid.append(key)
                    self.warnings.append("%s=%s вне диапазона %s..%s — взято %s"
                                         % (key, raw.get(key), minimum, maximum, values[key]))
                else:
                    values[key] = number

        for key in ("price_min_rub", "price_max_rub"):
            number = _as_int(raw.get(key))
            if raw.get(key) is not None and number is None:
                invalid.append(key)
            elif number is not None:
                if number < 0:
                    invalid.append(key)
                    self.warnings.append("%s=%s отрицательная — взято %s" % (key, raw.get(key), values[key]))
                else:
                    values[key] = number

        for key in ("exclude_first_floor", "exclude_last_floor", "only_active", "promo_only",
                    "outlier_guard"):
            flag = _as_bool(raw.get(key))
            if raw.get(key) is not None and flag is None:
                invalid.append(key)
            elif flag is not None:
                values[key] = flag

        finishes = _as_list(raw.get("finishes"))
        if finishes is None and raw.get("finishes") is not None:
            invalid.append("finishes")
        elif finishes is not None:
            cleaned = [str(item).strip().casefold() for item in finishes if str(item).strip()]
            unknown_finishes = [item for item in cleaned if item not in FINISH_VALUES]
            if unknown_finishes:
                self.warnings.append("finishes: неизвестные значения %s — оставлены как есть"
                                     % ", ".join(unknown_finishes))
            if cleaned:
                values["finishes"] = cleaned
            else:
                invalid.append("finishes")

        metric = str(raw.get("price_metric") or "").strip().casefold()
        if raw.get("price_metric") is not None and metric not in PRICE_METRICS:
            invalid.append("price_metric")
            self.warnings.append("price_metric=%s не из %s — взято %s"
                                 % (raw.get("price_metric"), "/".join(PRICE_METRICS), values["price_metric"]))
        elif metric:
            values["price_metric"] = metric

        lots = _as_int(raw.get("outlier_same_price_min_lots"))
        if raw.get("outlier_same_price_min_lots") is not None and lots is None:
            invalid.append("outlier_same_price_min_lots")
        elif lots is not None:
            if 2 <= lots <= 50:
                values["outlier_same_price_min_lots"] = lots
            else:
                invalid.append("outlier_same_price_min_lots")
                self.warnings.append("outlier_same_price_min_lots=%s вне диапазона 2..50 — взято %s"
                                     % (raw.get("outlier_same_price_min_lots"),
                                        values["outlier_same_price_min_lots"]))

        for key in ("outlier_ppm2_min", "outlier_ppm2_max"):
            number = _as_int(raw.get(key))
            if raw.get(key) is not None and number is None:
                invalid.append(key)
            elif number is not None:
                if number < 0:
                    invalid.append(key)
                else:
                    values[key] = number

        if values["outlier_ppm2_min"] >= values["outlier_ppm2_max"]:
            self.warnings.append("outlier_ppm2_min >= outlier_ppm2_max — границы аномалий переставлены местами")
            values["outlier_ppm2_min"], values["outlier_ppm2_max"] = (
                values["outlier_ppm2_max"], values["outlier_ppm2_min"])

        for key in raw:
            if key not in KNOWN_SELECTION:
                self.unknown.setdefault("selection", {})[key] = raw[key]
                self.warnings.append("agent1.selection: неизвестный ключ %s — оставлен без изменений" % key)
        if invalid:
            self.present["selection_invalid"] = invalid
        return values

    def _normalise_watch(self, raw):
        raw = raw if isinstance(raw, dict) else {}
        self.present["watch"] = isinstance(raw, dict)
        values = dict(DEFAULT_WATCH)

        radius = _as_float(raw.get("radius_km"))
        if raw.get("radius_km") is not None and radius is None:
            self.warnings.append("agent1.watch.radius_km не число — взято %s" % values["radius_km"])
        elif radius is not None:
            if 1 <= radius <= 100:
                values["radius_km"] = radius
            else:
                self.warnings.append("agent1.watch.radius_km=%s вне 1..100 — взято %s"
                                     % (raw.get("radius_km"), values["radius_km"]))

        klass = _as_list(raw.get("klass"))
        if klass is None and raw.get("klass") is not None:
            self.warnings.append("agent1.watch.klass не список — оставлено пусто")
        elif klass is not None:
            values["klass"] = [str(item).strip() for item in klass if str(item).strip()]

        candidates = _as_int(raw.get("max_candidates"))
        if raw.get("max_candidates") is not None and candidates is None:
            self.warnings.append("agent1.watch.max_candidates не целое — взято %s" % values["max_candidates"])
        elif candidates is not None:
            if 1 <= candidates <= 200:
                values["max_candidates"] = candidates
            else:
                self.warnings.append("agent1.watch.max_candidates=%s вне 1..200 — взято %s"
                                     % (raw.get("max_candidates"), values["max_candidates"]))

        sources = _as_list(raw.get("sources"))
        if sources is None and raw.get("sources") is not None:
            self.warnings.append("agent1.watch.sources не список — оставлено пусто")
        elif sources is not None:
            values["sources"] = [str(item).strip() for item in sources if str(item).strip()]

        for key in ("price_min_per_m2", "price_max_per_m2"):
            number = _as_int(raw.get(key))
            if raw.get(key) is not None and number is None:
                self.warnings.append("agent1.watch.%s не целое — взято %s" % (key, values[key]))
            elif number is not None:
                values[key] = max(0, number)

        for key in raw:
            if key not in KNOWN_WATCH:
                self.unknown.setdefault("watch", {})[key] = raw[key]
                self.warnings.append("agent1.watch: неизвестный ключ %s — оставлен без изменений" % key)
        # Контракт v2 (§3, группа 1): query — единственное поле в панели,
        # name/url выводятся из него, если пусты (движок и отчёт ими пользуются).
        for key in ("query", "name", "url", "address"):
            value = raw.get(key)
            if value not in (None, ""):
                values[key] = str(value).strip()
        import cwlib as cw
        cw.derive_watch_query(values)
        return values

    def _normalise_agent1(self, raw):
        values = dict(DEFAULT_AGENT1)

        number = _as_float(raw.get("price_threshold_pct"))
        if raw.get("price_threshold_pct") is not None and number is None:
            self.warnings.append("agent1.price_threshold_pct не число — взято %s"
                                 % values["price_threshold_pct"])
        elif number is not None:
            if 0 <= number <= 100:
                values["price_threshold_pct"] = number
            else:
                self.warnings.append("agent1.price_threshold_pct=%s вне 0..100 — взято %s"
                                     % (raw.get("price_threshold_pct"), values["price_threshold_pct"]))

        number = _as_int(raw.get("compare_depth_weeks"))
        if raw.get("compare_depth_weeks") is not None and number is None:
            self.warnings.append("agent1.compare_depth_weeks не целое — взято %s"
                                 % values["compare_depth_weeks"])
        elif number is not None:
            if 1 <= number <= 52:
                values["compare_depth_weeks"] = number
            else:
                self.warnings.append("agent1.compare_depth_weeks=%s вне 1..52 — взято %s"
                                     % (raw.get("compare_depth_weeks"), values["compare_depth_weeks"]))

        number = _as_int(raw.get("top_deals_count"))
        if raw.get("top_deals_count") is not None and number is None:
            self.warnings.append("agent1.top_deals_count не целое — взято %s" % values["top_deals_count"])
        elif number is not None:
            if 1 <= number <= 20:
                values["top_deals_count"] = number
            else:
                self.warnings.append("agent1.top_deals_count=%s вне 1..20 — взято %s"
                                     % (raw.get("top_deals_count"), values["top_deals_count"]))

        number = _as_int(raw.get("min_lots"))
        if raw.get("min_lots") is not None and number is None:
            self.warnings.append("agent1.min_lots не целое — взято %s" % values["min_lots"])
        elif number is not None:
            values["min_lots"] = max(0, number)

        for key in raw:
            if key not in KNOWN_AGENT1:
                self.unknown.setdefault("agent1", {})[key] = raw[key]
                self.warnings.append("agent1: неизвестный ключ %s — оставлен без изменений" % key)
        return values

    # -- convenience -----------------------------------------------------

    def selection_as_panel(self):
        """The normalisation the dashboard expects: value + present + invalid."""
        return {
            "values": dict(self.selection),
            "present": self.present.get("selection", False),
            "invalid": list(self.present.get("selection_invalid") or []),
            "unknown": list((self.unknown.get("selection") or {}).keys()),
        }

    def to_dict(self):
        return {
            "selection": dict(self.selection),
            "watch": dict(self.watch),
            "agent1": dict(self.agent1),
            "warnings": list(self.warnings),
            "unknown": {group: dict(items) for group, items in self.unknown.items()},
            "present": dict(self.present),
        }

    def __repr__(self):
        return "<MarketingSettings selection=%s watch=%s agent1=%s warnings=%d>" % (
            len(self.selection), len(self.watch), len(self.agent1), len(self.warnings))


def _room_order(value):
    """Sort room types in contract order: 0, 1, 2, 3, 4, 5+."""
    try:
        return ROOM_TYPE_VALUES.index(value)
    except ValueError:
        return len(ROOM_TYPE_VALUES)


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------

def load(agent_settings=None, path=None, registry_dir=None, warn=False):
    """Read + normalise the marketing settings.

    `agent_settings` may be an already loaded dict (the engine loads the YAML
    once); otherwise the file is read through cwlib.load_agent_settings so the
    engine keeps a single YAML reader. Never raises: a broken file means the
    contract defaults plus a warning.
    """
    raw = agent_settings
    if raw is None:
        import cwlib as cw
        raw = cw.load_agent_settings(registry_dir=registry_dir, path=path, warn=warn)
    settings = MarketingSettings(raw)
    if not settings.present.get("agent1"):
        settings.warnings.append(
            "в настройках агента нет группы agent1 — работают значения по умолчанию контракта")
    return settings


# --------------------------------------------------------------------------
# selection filters (group 2)
# --------------------------------------------------------------------------

def _row_float(row, key):
    value = row.get(key)
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _row_int(row, key):
    value = _row_float(row, key)
    return None if value is None else int(round(value))


def _row_bool(row, key):
    value = row.get(key)
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return False
    return str(value).strip().casefold() in ("1", "true", "yes", "да")


def row_reject_reason(row, selection):
    """Why this lot is outside the selection, or None when it stays.

    The checks run in the order of REJECTION_REASONS, so a lot gets exactly one
    reason and the counters in the report add up to the dropped lot count.
    A lot without a usable value for a filter is not dropped by that filter:
    the engine does not invent numbers.
    """
    selection = selection or DEFAULT_SELECTION

    rooms = _row_int(row, "rooms")
    wanted_rooms = selection.get("room_types") or list(ROOM_TYPE_VALUES)
    if rooms is not None:
        bucket = "5+" if rooms >= 5 else str(rooms)
        if bucket not in [str(item) for item in wanted_rooms]:
            return "room_type"

    area = _row_float(row, "area_m2")
    area_min = _as_float(selection.get("area_min_m2")) or 0.0
    area_max = _as_float(selection.get("area_max_m2")) or 0.0
    if area is not None:
        if area_min and area < area_min:
            return "area_min"
        if area_max and area > area_max:
            return "area_max"

    price = _row_float(row, "price_rub")
    price_min = _as_int(selection.get("price_min_rub")) or 0
    price_max = _as_int(selection.get("price_max_rub")) or 0
    if price is not None:
        if price_min and price < price_min:
            return "price_min"
        if price_max and price > price_max:
            return "price_max"

    floor = _row_int(row, "floor")
    floors_total = _row_int(row, "floors_total")
    if selection.get("exclude_first_floor") and floor == 1:
        return "first_floor"
    if selection.get("exclude_last_floor") and floor is not None and floors_total is not None \
            and floor >= floors_total:
        return "last_floor"

    finish = str(row.get("finish") or "").strip().casefold()
    wanted_finishes = [str(item).strip().casefold() for item in (selection.get("finishes") or [])]
    if wanted_finishes and finish and finish not in wanted_finishes:
        return "finish"

    if selection.get("only_active", True) and not _row_bool(row, "status") \
            and str(row.get("status") or "").strip().casefold() != "active":
        return "not_active"

    if selection.get("promo_only") and not (
            _row_int(row, "promo_flag") == 1 and str(row.get("promo_text") or "").strip()):
        return "no_promo"
    return None


def filter_rows(rows, selection):
    """Split rows into (kept, dropped_counts, dropped_total).

    dropped_counts is {reason: count} using the REJECTION_REASONS keys; reasons
    with zero dropped lots are kept in the dict so the report can say "0" and not
    look like a filter that was never applied.
    """
    selection = selection or DEFAULT_SELECTION
    counts = {key: 0 for key, _label in REJECTION_REASONS}
    kept = []
    for row in rows or []:
        reason = row_reject_reason(row, selection)
        if reason:
            counts[reason] = counts.get(reason, 0) + 1
            continue
        kept.append(row)
    return kept, counts, sum(counts.values())


def selection_limitations(dropped_counts, dropped_total, total_before, settings=None):
    """Human text for the «Ограничения» section: what the filters dropped."""
    if not dropped_total:
        return ""
    lines = ["Отбор по настройкам агента (agent1.selection): из %d лотов отброшено %d."
             % (total_before, dropped_total)]
    for key, label in REJECTION_REASONS:
        count = (dropped_counts or {}).get(key) or 0
        if count:
            lines.append("- %s: %d" % (label, count))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# price metric and the outlier guard
# --------------------------------------------------------------------------

def metric_label(metric):
    return {"median": "медиана", "mean": "среднее", "min_max": "min–max"}.get(
        str(metric or "median"), "медиана")


def metric_value(values, metric="median"):
    """The price metric the contract asks to print: median | mean | min_max.

    min_max returns the midpoint of the min–max range; the report also prints the
    range itself. None when there is nothing to compute — never a zero.
    """
    numbers = sorted(float(value) for value in values or [] if value is not None)
    if not numbers:
        return None
    metric = str(metric or "median").strip().casefold()
    if metric == "mean":
        return int(round(sum(numbers) / len(numbers)))
    if metric == "min_max":
        return int(round((numbers[0] + numbers[-1]) / 2.0))
    return int(round(statistics_median(numbers)))


def statistics_median(numbers):
    """Median of an already sorted non-empty list (no statistics import needed)."""
    count = len(numbers)
    middle = count // 2
    if count % 2:
        return numbers[middle]
    return (numbers[middle - 1] + numbers[middle]) / 2.0


def price_block(values, metric="median"):
    """{min, median, max} plus the configured metric value.

    The default metric keeps the historical key set exactly ({min, median, max}),
    so the existing analytics contract does not change; mean and min_max add
    `metric`/`metric_value` keys so the caller can print the honest number.
    """
    numbers = sorted(float(value) for value in values or [] if value is not None)
    if not numbers:
        return {"min": None, "median": None, "max": None}
    block = {
        "min": int(round(numbers[0])),
        "median": int(round(statistics_median(numbers))),
        "max": int(round(numbers[-1])),
    }
    metric = str(metric or "median").strip().casefold()
    if metric in ("mean", "min_max"):
        block["metric"] = metric
        block["metric_value"] = metric_value(numbers, metric)
    return block


def detect_outliers(rows, selection):
    """Anomalies that make a slice unreliable (contract group 2, outlier_guard).

    Two rules, both straight from the contract:
      * the same price repeated on >= outlier_same_price_min_lots lots is a
        parsing artifact, not a market price;
      * a ₽/м² outside [outlier_ppm2_min, outlier_ppm2_max] is implausible.

    Returns a list of {"kind", "reason", "count", "values"} records. An empty
    list means the slice passed the guard. Nothing is dropped here: the caller
    decides how to mark the slice.
    """
    selection = selection or DEFAULT_SELECTION
    if not selection.get("outlier_guard", True):
        return []

    found = []
    min_same = _as_int(selection.get("outlier_same_price_min_lots")) or 5
    prices = {}
    for row in rows or []:
        price = _row_float(row, "price_rub")
        if price is None:
            continue
        key = int(round(price))
        prices[key] = prices.get(key, 0) + 1
    repeated = sorted(((price, count) for price, count in prices.items() if count >= min_same),
                      key=lambda item: (-item[1], item[0]))
    for price, count in repeated:
        found.append({
            "kind": "same_price",
            "reason": "одинаковая цена %s ₽ на %d лотах (>= %d) — артефакт парсинга"
                      % (format_money(price), count, min_same),
            "count": count,
            "values": [price],
        })

    ppm2_min = _as_int(selection.get("outlier_ppm2_min"))
    ppm2_max = _as_int(selection.get("outlier_ppm2_max"))
    below, above = [], []
    for row in rows or []:
        value = _row_float(row, "price_per_m2_rub")
        if value is None:
            price = _row_float(row, "price_rub")
            area = _row_float(row, "area_m2")
            if price and area and area > 0:
                value = price / area
        if value is None:
            continue
        if ppm2_min and value < ppm2_min:
            below.append(value)
        elif ppm2_max and value > ppm2_max:
            above.append(value)
    if below:
        found.append({"kind": "ppm2_low",
                      "reason": "₽/м² ниже правдоподобной границы %s: %d лотов"
                                % (format_money(ppm2_min), len(below)),
                      "count": len(below), "values": sorted(below)[:5]})
    if above:
        found.append({"kind": "ppm2_high",
                      "reason": "₽/м² выше правдоподобной границы %s: %d лотов"
                                % (format_money(ppm2_max), len(above)),
                      "count": len(above), "values": sorted(above)[-5:]})
    return found


def format_money(value):
    try:
        return "{:,}".format(int(round(float(value)))).replace(",", " ")
    except (TypeError, ValueError):
        return "—"


def slice_is_reliable(outliers):
    """False when the outlier guard found an anomaly in the slice."""
    return not bool(outliers)


def outlier_rows(rows, selection):
    """Rows the guard considers anomalous: repeated identical price or implausible ₽/м².

    A repeated identical price is an artifact only when it covers >= N lots, so
    every lot of that group is excluded from the statistics (the report shows the
    reason instead of a false market conclusion). A lot with an implausible ₽/м²
    is excluded for the same reason. The snapshot itself is never rewritten: the
    guard filters statistics only, so the raw data stays honest.
    """
    selection = selection or DEFAULT_SELECTION
    if not selection.get("outlier_guard", True):
        return []
    min_same = _as_int(selection.get("outlier_same_price_min_lots")) or 5
    ppm2_min = _as_int(selection.get("outlier_ppm2_min"))
    ppm2_max = _as_int(selection.get("outlier_ppm2_max"))

    prices = {}
    for row in rows or []:
        price = _row_float(row, "price_rub")
        if price is not None:
            key = int(round(price))
            prices[key] = prices.get(key, 0) + 1
    artifacts = {price for price, count in prices.items() if count >= min_same}

    excluded = []
    for row in rows or []:
        price = _row_float(row, "price_rub")
        if price is not None and int(round(price)) in artifacts:
            excluded.append(row)
            continue
        value = _row_float(row, "price_per_m2_rub")
        if value is None:
            area = _row_float(row, "area_m2")
            if price and area and area > 0:
                value = price / area
        if value is not None and ((ppm2_min and value < ppm2_min) or (ppm2_max and value > ppm2_max)):
            excluded.append(row)
    return excluded


def drop_outliers(rows, selection):
    """(clean_rows, outliers) — statistics run on clean_rows only."""
    excluded = outlier_rows(rows, selection)
    excluded_ids = {id(row) for row in excluded}
    clean = [row for row in rows or [] if id(row) not in excluded_ids]
    return clean, detect_outliers(rows, selection)


def outlier_limitations(outliers):
    """Human text for the «Ограничения» section: why the slice is unreliable."""
    if not outliers:
        return ""
    lines = ["Проверка аномалий (agent1.selection.outlier_guard): срез помечен недостоверным."]
    for item in outliers:
        lines.append("- %s" % item.get("reason"))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# comparison depth / top deals / min lots (group 3)
# --------------------------------------------------------------------------

def compare_since(date_text, weeks):
    """Date N weeks before `date_text` (YYYY-MM-DD) or None when unparsable."""
    try:
        base = _dt.date.fromisoformat(str(date_text))
    except (TypeError, ValueError):
        return None
    try:
        return (base - _dt.timedelta(weeks=int(weeks))).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def top_deals(rows, count):
    """The N rows with the biggest absolute delta_pct (stable order)."""
    rows = [row for row in rows or [] if isinstance(row, dict)]
    try:
        limit = max(0, int(count))
    except (TypeError, ValueError):
        limit = 5
    ordered = sorted(rows, key=lambda row: abs(float(row.get("delta_pct") or 0.0)), reverse=True)
    return ordered[:limit] if limit else []


def min_lots_notice(lot_count, min_lots):
    """Honest «мало данных» notice when the snapshot has fewer lots than allowed."""
    try:
        threshold = int(min_lots)
    except (TypeError, ValueError):
        return None
    if threshold and lot_count is not None and int(lot_count) < threshold:
        return ("мало данных: в снимке %d лотов при минимуме agent1.min_lots=%d — "
                "выводы по срезу могут быть неполными" % (int(lot_count), threshold))
    return None


def watch_applied_note(watch):
    """Fix the fact that radius/klass/max_candidates/sources are already applied.

    discover_competitors.py reads the same group and filters candidates by it, so
    the engine does not apply it a second time; the report states where it works.
    """
    parts = []
    if watch.get("radius_km"):
        parts.append("радиус %s км" % _fmt_num(watch.get("radius_km")))
    if watch.get("klass"):
        parts.append("сегмент %s" % ", ".join(str(item) for item in watch.get("klass")))
    if watch.get("max_candidates"):
        parts.append("до %d конкурентов" % int(watch.get("max_candidates")))
    if watch.get("sources"):
        parts.append("источники %s" % ", ".join(str(item) for item in watch.get("sources")))
    if not parts:
        return ""
    return ("Охват конкурентов (agent1.watch) применяется при автоподборе в "
            "discover_competitors.py: %s." % "; ".join(parts))


def _fmt_num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    text = "%.2f" % number
    return text.rstrip("0").rstrip(".").replace(".", ",")
