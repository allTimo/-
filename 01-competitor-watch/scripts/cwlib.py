"""Competitor-watch engine (Agent 1, task T3): shared constants and helpers.

Standard library only. openpyxl is imported lazily by build_weekly_report.py.

Input contract (fixed, see SCHEMA.md):
    data/snapshots/<YYYY-MM-DD>/lots.csv
    snapshot_date,source,competitor,project,lot_id,url,rooms,area_m2,floor,
    floors_total,building,price_rub,price_per_m2_rub,finish,promo_flag,
    promo_text,delivery,status

Lot identity: (source, competitor, project, lot_id).
"""
from __future__ import annotations

import csv
import datetime as _dt
import json
import re
import statistics
import sys
from pathlib import Path

COLUMNS = [
    "snapshot_date", "source", "competitor", "project", "lot_id", "url",
    "rooms", "area_m2", "floor", "floors_total", "building",
    "price_rub", "price_per_m2_rub", "finish", "promo_flag", "promo_text",
    "delivery", "status",
]

KEY_COLUMNS = ("source", "competitor", "project", "lot_id")
INT_COLUMNS = ("rooms", "floor", "floors_total", "promo_flag")
FLOAT_COLUMNS = ("area_m2", "price_rub", "price_per_m2_rub")
REQUIRED_NON_EMPTY = (
    "snapshot_date", "source", "competitor", "project", "lot_id",
    "rooms", "area_m2", "price_rub", "finish", "promo_flag", "status",
)
FINISH_VALUES = ("без отделки", "white box", "чистовая", "с мебелью", "unknown")
STATUS_VALUES = ("active", "reserved", "sold")
# Controlled vocabulary from 00-admin/config/settings.yaml (data_contract.enums.source).
SOURCE_VALUES = ("cian", "avito", "yandex_realty", "site", "other")
ROOMS_MIN, ROOMS_MAX = 0, 6
AREA_MIN, AREA_MAX = 10.0, 400.0
PRICE_MIN_EXCLUSIVE = 1_000_000.0
PPM2_TOLERANCE = 0.01

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DELIVERY_RE = re.compile(r"^\d{4}-Q[1-4]$")

# Room buckets used by the report: studios / 1 / 2 / 3 / 4+ (rooms == 6 means 5+).
ROOM_BUCKETS = (
    ("студии", (0,)),
    ("1", (1,)),
    ("2", (2,)),
    ("3", (3,)),
    ("4+", (4, 5, 6)),
)

# Every path is derived from this file, never from the current working directory,
# so each CLI works from any CWD (workspace root, the watch folder, %TEMP%).
SCRIPT_DIR = Path(__file__).resolve().parent       # .../01-competitor-watch/scripts
WATCH_DIR = SCRIPT_DIR.parent                      # .../01-competitor-watch
PROJECT_ROOT = WATCH_DIR.parent                    # .../marketing-agents
DATA_DIR = WATCH_DIR / "data"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"
REPORTS_DIR = WATCH_DIR / "reports"
CONFIG_DIR = PROJECT_ROOT / "00-admin" / "config"
CACHE_DIR_NAME = ".cache"

# Backwards-compatible alias (the report module uses cw.PROJECT_DIR).
PROJECT_DIR = WATCH_DIR


class EngineError(Exception):
    """Fatal engine problem: missing file, broken header, unusable input."""


# --------------------------------------------------------------------------
# console / io helpers
# --------------------------------------------------------------------------

def setup_console() -> None:
    """Make Cyrillic and the ruble sign readable in the Windows console.

    Russian Windows consoles usually run with codepage 866, which cannot even
    represent the ruble sign, and Python then encodes stdout with that codepage.
    Switch the console to UTF-8 (65001) and force UTF-8 on both streams, so the
    output is correct no matter which codepage the caller started with.
    """
    if sys.platform == "win32":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleOutputCP(65001)
            kernel32.SetConsoleCP(65001)
        except Exception:  # pragma: no cover - no console attached
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - non reconfigurable stream
            pass


def resolve_snapshot_ref(ref, snapshots_dir=None):
    """Accept a date (YYYY-MM-DD), a snapshot directory or a direct .csv path."""
    base = Path(snapshots_dir) if snapshots_dir else SNAPSHOTS_DIR
    text = str(ref)
    if DATE_RE.match(text):
        return base / text / "lots.csv"
    path = Path(text)
    if path.suffix.lower() == ".csv":
        return path
    if path.is_dir():
        return path / "lots.csv"
    return base / text / "lots.csv"


def date_from_ref(ref):
    text = str(ref)
    return text if DATE_RE.match(text) else None


def read_table(path):
    """Read a CSV file. Returns (header, rows); rows are raw string lists."""
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        try:
            header = next(reader)
        except StopIteration:
            return None, []
        header = [cell.strip() for cell in header]
        rows = [list(row) for row in reader]
    return header, rows


def to_int(value):
    """Strict integer conversion; returns None when empty or not an integer."""
    text = "" if value is None else str(value).strip()
    if not text:
        return None
    text = text.replace(" ", "").replace("\u00a0", "").replace(",", ".")
    try:
        number = float(text)
    except ValueError:
        return None
    if number != int(number):
        return None
    return int(number)


def to_float(value):
    """Lenient float conversion; returns None when empty or unparseable."""
    text = "" if value is None else str(value).strip()
    if not text:
        return None
    text = text.replace(" ", "").replace("\u00a0", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def format_cell(value):
    """Render a typed value back into a CSV cell."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value == int(value):
            return str(int(value))
        return ("%.2f" % value).rstrip("0").rstrip(".")
    return str(value)


def write_csv(path, rows, header=None):
    """Write rows (dicts) as utf-8-sig CSV with CRLF line endings (Excel-safe)."""
    header = list(header or COLUMNS)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\r\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow([format_cell(row.get(col)) for col in header])
    return path


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return path


def json_dump(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return path


def json_load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------
# row helpers
# --------------------------------------------------------------------------

def coerce_row(raw):
    """Return a dict with typed numeric columns; text columns stay strings."""
    row = {}
    for col in COLUMNS:
        value = raw.get(col)
        row[col] = "" if value is None else str(value).strip()
    for col in INT_COLUMNS:
        row[col] = to_int(row[col])
    for col in FLOAT_COLUMNS:
        row[col] = to_float(row[col])
    return row


def lot_key(row):
    return tuple(str(row.get(col) or "").strip() for col in KEY_COLUMNS)


def lot_key_text(row):
    key = lot_key(row)
    return " | ".join(key)


def ensure_ppm2(row):
    """Fill price_per_m2_rub = price_rub / area_m2 when it is empty."""
    if row.get("price_per_m2_rub") is None:
        price = row.get("price_rub")
        area = row.get("area_m2")
        if price and area and area > 0:
            row["price_per_m2_rub"] = float(round(price / area))
    return row


def load_snapshot_rows(path):
    """Read a snapshot and return typed rows (no validation, ppm2 filled)."""
    header, raw_rows = read_table(path)
    if header is None:
        raise EngineError("файл снимка пуст: %s" % path)
    rows = []
    for raw in raw_rows:
        if not raw or all(not str(cell).strip() for cell in raw):
            continue
        if len(raw) != len(header):
            continue
        rows.append(ensure_ppm2(coerce_row(dict(zip(header, raw)))))
    return rows


def is_active(row):
    return str(row.get("status") or "").strip() == "active"


def promo_is_on(row):
    return to_int(row.get("promo_flag")) == 1 and bool(str(row.get("promo_text") or "").strip())


def ppm2_of(row):
    """₽/м² for display: the stored value when present, else price_rub / area_m2."""
    value = row.get("price_per_m2_rub")
    if value:
        return float(value)
    price = row.get("price_rub")
    area = row.get("area_m2")
    if price and area and area > 0:
        return price / area
    return None


def stats_ppm2(row):
    """₽/м² for medians and averages (documented contract).

    Only lots with BOTH price_rub and area_m2 (> 0) take part, and the value is
    price_rub / area_m2. A lot that has only price_per_m2_rub filled is NOT part
    of the statistics - see templates/weekly-report.md and the report note
    «медиана и среднее считаются по лотам со статусом active, у которых
    заполнены цена и площадь».
    """
    price = row.get("price_rub")
    area = row.get("area_m2")
    if not price or not area:
        return None
    try:
        area_value = float(area)
        price_value = float(price)
    except (TypeError, ValueError):
        return None
    if area_value <= 0 or price_value <= 0:
        return None
    return price_value / area_value


def rooms_bucket(rooms):
    value = to_int(rooms)
    for label, values in ROOM_BUCKETS:
        if value in values:
            return label
    return "unknown"


# --------------------------------------------------------------------------
# statistics / formatting
# --------------------------------------------------------------------------

def median_rounded(values):
    values = [float(v) for v in values if v is not None]
    if not values:
        return None
    return int(round(statistics.median(values)))


def mean_rounded(values):
    values = [float(v) for v in values if v is not None]
    if not values:
        return None
    return int(round(sum(values) / len(values)))


def delta_pct(old, new):
    if old in (None, 0) or new is None:
        return None
    return (float(new) - float(old)) / float(old) * 100.0


def fmt_int(value):
    if value is None:
        return "—"
    return "{:,}".format(int(round(value))).replace(",", " ")


def round_money(value, round_to=None):
    """Round a money value to the configured step (units.price_round_to_rub)."""
    if value is None or not round_to:
        return value
    step = float(round_to)
    return int(round(float(value) / step) * step)


def fmt_money(value, round_to=None):
    if value is None:
        return "—"
    return fmt_int(round_money(value, round_to)) + " ₽"


def fmt_pct(value, digits=2, signed=True):
    if value is None:
        return "—"
    template = "%+." + str(digits) + "f%%" if signed else "%." + str(digits) + "f%%"
    return (template % float(value)).replace(".", ",")


def fmt_num(value, digits=1):
    if value is None:
        return "—"
    text = ("%." + str(digits) + "f") % float(value)
    return text.rstrip("0").rstrip(".").replace(".", ",") if "." in text else text


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def validate_header(header):
    """Return (problems, fatal). Fatal means rows cannot be mapped reliably."""
    if header is None:
        return ["строка 1: файл пуст, строка заголовка отсутствует"], True
    missing = [col for col in COLUMNS if col not in header]
    extra = [col for col in header if col not in COLUMNS]
    problems = []
    if missing:
        problems.append("строка 1: отсутствуют обязательные колонки: " + ", ".join(missing))
    if extra:
        problems.append("строка 1: лишние колонки: " + ", ".join(extra))
    if missing or extra:
        return problems, True
    if header != COLUMNS:
        problems.append("строка 1: неверный порядок колонок (ожидается: " + ",".join(COLUMNS) + ")")
    return problems, False


def validate_row(raw, line_no, expected_date=None):
    """Validate one raw row; returns a list of «строка N: проблема» strings."""
    problems = []

    def get(col):
        return str(raw.get(col) or "").strip()

    for col in REQUIRED_NON_EMPTY:
        if not get(col):
            problems.append("строка %d: пустое обязательное поле %s" % (line_no, col))

    date_value = get("snapshot_date")
    if date_value and not DATE_RE.match(date_value):
        problems.append("строка %d: snapshot_date не в формате YYYY-MM-DD: %s" % (line_no, date_value))
    elif date_value and expected_date and date_value != expected_date:
        problems.append(
            "строка %d: snapshot_date=%s не совпадает с датой снимка %s"
            % (line_no, date_value, expected_date)
        )

    source = get("source")
    if source and source not in SOURCE_VALUES:
        problems.append(
            "строка %d: source=%s не из списка (%s)" % (line_no, source, ", ".join(SOURCE_VALUES))
        )

    url = get("url")
    if url and not url.lower().startswith(("http://", "https://")):
        problems.append("строка %d: url должен начинаться с http:// или https://: %s" % (line_no, url))

    rooms_text = get("rooms")
    if rooms_text:
        rooms = to_int(rooms_text)
        if rooms is None:
            problems.append("строка %d: rooms не целое число: %s" % (line_no, rooms_text))
        elif not (ROOMS_MIN <= rooms <= ROOMS_MAX):
            problems.append("строка %d: rooms=%s вне диапазона %d..%d" % (line_no, rooms, ROOMS_MIN, ROOMS_MAX))

    area_text = get("area_m2")
    area = None
    if area_text:
        area = to_float(area_text)
        if area is None:
            problems.append("строка %d: area_m2 не число: %s" % (line_no, area_text))
        elif not (AREA_MIN <= area <= AREA_MAX):
            problems.append(
                "строка %d: area_m2=%s вне диапазона %s..%s" % (line_no, area_text, AREA_MIN, AREA_MAX)
            )

    price_text = get("price_rub")
    price = None
    if price_text:
        price = to_float(price_text)
        if price is None:
            problems.append("строка %d: price_rub не число: %s" % (line_no, price_text))
        elif price <= PRICE_MIN_EXCLUSIVE:
            problems.append(
                "строка %d: price_rub=%s должен быть больше %s"
                % (line_no, price_text, fmt_int(PRICE_MIN_EXCLUSIVE))
            )

    ppm2_text = get("price_per_m2_rub")
    if ppm2_text:
        ppm2 = to_float(ppm2_text)
        if ppm2 is None:
            problems.append("строка %d: price_per_m2_rub не число: %s" % (line_no, ppm2_text))
        elif ppm2 <= 0:
            problems.append("строка %d: price_per_m2_rub должен быть больше нуля: %s" % (line_no, ppm2_text))
        elif price and area and area > 0:
            computed = price / area
            if abs(ppm2 - computed) / computed > PPM2_TOLERANCE:
                problems.append(
                    "строка %d: price_per_m2_rub=%s не сходится с price_rub/area_m2=%s"
                    % (line_no, ppm2_text, fmt_int(computed))
                )

    for col in ("floor", "floors_total"):
        text = get(col)
        if text and to_int(text) is None:
            problems.append("строка %d: %s не целое число: %s" % (line_no, col, text))
    floor = to_int(get("floor"))
    floors_total = to_int(get("floors_total"))
    if floor is not None and floors_total is not None and floor > floors_total:
        problems.append(
            "строка %d: floor=%d больше floors_total=%d" % (line_no, floor, floors_total)
        )

    promo_text_value = get("promo_flag")
    if promo_text_value:
        promo_flag = to_int(promo_text_value)
        if promo_flag is None:
            problems.append("строка %d: promo_flag не целое число: %s" % (line_no, promo_text_value))
        elif promo_flag not in (0, 1):
            problems.append("строка %d: promo_flag=%s должен быть 0 или 1" % (line_no, promo_flag))
        elif promo_flag == 1 and not get("promo_text"):
            problems.append("строка %d: promo_flag=1, но promo_text пуст" % line_no)
        elif promo_flag == 0 and get("promo_text"):
            problems.append("строка %d: promo_flag=0, но promo_text заполнен" % line_no)

    finish = get("finish")
    if finish and finish not in FINISH_VALUES:
        problems.append(
            "строка %d: finish=%s не из списка (%s)" % (line_no, finish, ", ".join(FINISH_VALUES))
        )

    delivery = get("delivery")
    if delivery and not DELIVERY_RE.match(delivery):
        problems.append("строка %d: delivery=%s не в формате YYYY-QN" % (line_no, delivery))

    status = get("status")
    if status and status not in STATUS_VALUES:
        problems.append(
            "строка %d: status=%s не из списка (%s)" % (line_no, status, ", ".join(STATUS_VALUES))
        )

    return problems


def validate_file(path, expected_date=None):
    """Validate a snapshot file. Returns (problems, data_row_count)."""
    path = Path(path)
    if not path.exists():
        raise EngineError("файл снимка не найден: %s" % path)
    header, raw_rows = read_table(path)
    problems, fatal = validate_header(header)
    if fatal:
        return problems, 0

    seen = {}
    data_rows = 0
    for index, raw in enumerate(raw_rows, start=2):
        if not raw or all(not str(cell).strip() for cell in raw):
            problems.append("строка %d: пустая строка" % index)
            continue
        if len(raw) != len(header):
            problems.append(
                "строка %d: ожидается %d колонок, получено %d" % (index, len(header), len(raw))
            )
            continue
        raw_dict = dict(zip(header, raw))
        data_rows += 1
        problems.extend(validate_row(raw_dict, index, expected_date))
        key = lot_key(raw_dict)
        if all(key):
            if key in seen:
                problems.append(
                    "строка %d: дубль лота по ключу (source, competitor, project, lot_id) = %s, первая строка %d"
                    % (index, " | ".join(key), seen[key])
                )
            else:
                seen[key] = index

    if data_rows == 0:
        problems.append("строка 1: в файле нет строк с данными")
    return problems, data_rows


# --------------------------------------------------------------------------
# normalization
# --------------------------------------------------------------------------

def normalize_rows(header, raw_rows):
    """Coerce, fill ppm2, drop duplicates and unusable rows, then sort."""
    stats = {"total": 0, "dropped_invalid": 0, "dropped_duplicates": 0, "filled_ppm2": 0}
    rows = []
    seen = set()
    for raw in raw_rows:
        if not raw or all(not str(cell).strip() for cell in raw):
            continue
        stats["total"] += 1
        if len(raw) != len(header):
            stats["dropped_invalid"] += 1
            continue
        row = coerce_row(dict(zip(header, raw)))
        if not all(lot_key(row)):
            stats["dropped_invalid"] += 1
            continue
        if row["rooms"] is None or row["area_m2"] is None or row["price_rub"] is None:
            stats["dropped_invalid"] += 1
            continue
        key = lot_key(row)
        if key in seen:
            stats["dropped_duplicates"] += 1
            continue
        seen.add(key)
        if row["price_per_m2_rub"] is None:
            ensure_ppm2(row)
            if row["price_per_m2_rub"] is not None:
                stats["filled_ppm2"] += 1
        rows.append(row)

    rows.sort(
        key=lambda r: (
            str(r.get("snapshot_date") or ""),
            str(r.get("competitor") or ""),
            str(r.get("project") or ""),
            str(r.get("lot_id") or ""),
        )
    )
    stats["kept"] = len(rows)
    return rows, stats


def normalize_file(path, expected_date=None):
    """Normalize a snapshot in place (utf-8-sig). Returns (path, stats)."""
    path = Path(path)
    if not path.exists():
        raise EngineError("файл снимка не найден: %s" % path)
    header, raw_rows = read_table(path)
    problems, fatal = validate_header(header)
    if fatal:
        raise EngineError("нельзя нормализовать файл: " + "; ".join(problems))
    rows, stats = normalize_rows(header, raw_rows)
    write_csv(path, rows, header=COLUMNS)
    return path, stats

# --------------------------------------------------------------------------
# 00-admin/config/settings.yaml - read without a hard PyYAML dependency
# --------------------------------------------------------------------------

DEFAULT_THRESHOLD_PCT = 0.5
DEFAULT_FORMATS = "md,xlsx"

_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


def _strip_comment(text):
    """Drop a trailing YAML comment, respecting quoted strings."""
    out = []
    quote = None
    for char in text:
        if quote:
            out.append(char)
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
            out.append(char)
        elif char == "#":
            break
        else:
            out.append(char)
    return "".join(out).strip()


def _split_top_level(text):
    """Split on commas that are outside quotes and outside {}, [] and ()."""
    parts, depth, quote, current = [], 0, None, []
    for char in text:
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            current.append(char)
            continue
        if char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(char)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return [part.strip() for part in parts]


def _parse_scalar(text):
    text = text.strip()
    if not text:
        return None
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        try:
            return json.loads(text)
        except Exception:
            return [_parse_scalar(part) for part in _split_top_level(inner)]
    if text.startswith("{") and text.endswith("}"):
        # инлайн-словарь: schedule: { weekday: monday, time: "10:00" }
        inner = text[1:-1].strip()
        if not inner:
            return {}
        result = {}
        for part in _split_top_level(inner):
            key, separator, value = part.partition(":")
            if not separator:
                continue
            result[key.strip().strip("\"'")] = _parse_scalar(value)
        return result
    if len(text) >= 2 and text[0] in "\"'" and text[-1] == text[0]:
        return text[1:-1]
    lowered = text.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    if lowered in ("null", "~", "none"):
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def _is_mapping_entry(text):
    key, separator, _ = text.partition(":")
    return bool(separator) and bool(_KEY_RE.match(key.strip()))


def _parse_block(lines, index, indent):
    """Recursive-descent reader for the simple YAML subset used in this project."""
    if index >= len(lines):
        return {}, index

    if lines[index][1].startswith("- "):
        items = []
        while index < len(lines) and lines[index][0] == indent and lines[index][1].startswith("- "):
            content = lines[index][1][2:].strip()
            index += 1
            if _is_mapping_entry(content):
                key, _, rest = content.partition(":")
                item = {key.strip(): _parse_scalar(rest.strip()) if rest.strip() else None}
                if index < len(lines) and lines[index][0] > indent:
                    deeper, index = _parse_block(lines, index, lines[index][0])
                    if isinstance(deeper, dict):
                        item.update(deeper)
                items.append(item)
            else:
                items.append(_parse_scalar(content))
        return items, index

    mapping = {}
    while index < len(lines) and lines[index][0] == indent and not lines[index][1].startswith("- "):
        key, _, rest = lines[index][1].partition(":")
        key = key.strip()
        rest = rest.strip()
        if rest:
            mapping[key] = _parse_scalar(rest)
            index += 1
        else:
            child_indent = lines[index + 1][0] if index + 1 < len(lines) else indent
            value, index = _parse_block(lines, index + 1, child_indent)
            mapping[key] = value
    return mapping, index


def parse_simple_yaml(path):
    """Minimal YAML reader: scalars, nesting by indentation, '- ' lists, inline [..] lists."""
    text = Path(path).read_text(encoding="utf-8-sig")
    lines = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        content = _strip_comment(raw)
        if not content:
            continue
        lines.append((len(raw) - len(raw.lstrip(" ")), content))
    if not lines:
        return {}
    value, _ = _parse_block(lines, 0, lines[0][0])
    return value


_SETTINGS_CACHE = {}


def load_settings(config_dir=None, warn=False):
    """Load settings.yaml. PyYAML when available, otherwise the built-in mini parser.

    Never raises: a missing or broken file yields {} (plus a stderr warning when
    warn=True) and the engine keeps working on its defaults.
    """
    path = Path(config_dir or CONFIG_DIR) / "settings.yaml"
    if not path.exists():
        if warn:
            print("Предупреждение: %s не найден — используются значения по умолчанию." % path,
                  file=sys.stderr)
        return {}
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        stamp = 0
    cache_key = (str(path), stamp)
    if cache_key in _SETTINGS_CACHE:
        return _SETTINGS_CACHE[cache_key]

    data = {}
    problem = None
    try:
        import yaml  # optional: PyYAML is NOT part of the DSH runtime
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                loaded = yaml.safe_load(handle)
            data = loaded if isinstance(loaded, dict) else {}
        except Exception as exc:
            problem = exc
    else:
        try:
            loaded = parse_simple_yaml(path)
            data = loaded if isinstance(loaded, dict) else {}
        except Exception as exc:
            problem = exc

    if problem is None and not isinstance(data, dict):
        problem = "верхний уровень не является словарём"
        data = {}
    if problem is None and not data:
        problem = "файл пуст или не содержит распознанных настроек"
    if problem is not None:
        if warn:
            print("Предупреждение: не удалось прочитать %s (%s) — используются значения по умолчанию."
                  % (path, problem), file=sys.stderr)
        data = {}
    _SETTINGS_CACHE[cache_key] = data
    return data


def _dig(data, keys, default=None):
    node = data
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


# Engine defaults used when settings.yaml is absent or a key is missing.
DEFAULTS = {
    "price_change_pct": DEFAULT_THRESHOLD_PCT,
    "price_change_abs_rub": 0.0,
    "lot_count_change_abs": 3,
    "min_lots_for_stats": 3,
    "price_round_to_rub": 0,
    "pct_decimals": 2,
    "compare_mode": "week_over_week",
    "period_days": 7,
    "formats": DEFAULT_FORMATS,
    "warn_if_lots_below": 5,
}


def load_config(config_dir=None, use_config=True):
    """All engine settings in one dict: settings.yaml over defaults.

    CLI arguments take precedence over this dict, this dict over the defaults.
    """
    config = dict(DEFAULTS)
    path = Path(config_dir or CONFIG_DIR) / "settings.yaml"
    config["config_dir"] = str(config_dir or CONFIG_DIR)
    config["config_path"] = None
    config["config_source"] = "defaults"
    if not use_config:
        config["config_source"] = "no-config"
        return config

    settings = load_settings(config_dir, warn=True)
    if not settings:
        return config
    config["config_path"] = str(path)
    config["config_source"] = "settings.yaml"

    number = _dig(settings, ("thresholds", "price_change_pct"))
    if isinstance(number, (int, float)) and not isinstance(number, bool):
        config["price_change_pct"] = float(number)
    number = _dig(settings, ("thresholds", "price_change_abs_rub"))
    if isinstance(number, (int, float)) and not isinstance(number, bool):
        config["price_change_abs_rub"] = float(number)
    number = _dig(settings, ("thresholds", "lot_count_change_abs"))
    if isinstance(number, int) and not isinstance(number, bool):
        config["lot_count_change_abs"] = int(number)
    number = _dig(settings, ("thresholds", "min_lots_for_stats"))
    if isinstance(number, int) and not isinstance(number, bool):
        config["min_lots_for_stats"] = int(number)
    number = _dig(settings, ("units", "price_round_to_rub"))
    if isinstance(number, (int, float)) and not isinstance(number, bool):
        config["price_round_to_rub"] = int(number)
    number = _dig(settings, ("units", "pct_decimals"))
    if isinstance(number, int) and not isinstance(number, bool):
        config["pct_decimals"] = int(number)
    number = _dig(settings, ("quality", "warn_if_lots_below"))
    if isinstance(number, int) and not isinstance(number, bool):
        config["warn_if_lots_below"] = int(number)
    text = _dig(settings, ("period", "compare_mode"))
    if isinstance(text, str) and text.strip():
        config["compare_mode"] = text.strip()
    number = _dig(settings, ("period", "days"))
    if isinstance(number, int) and not isinstance(number, bool):
        config["period_days"] = int(number)
    formats = _dig(settings, ("output", "formats"))
    if isinstance(formats, list) and formats:
        config["formats"] = ",".join(str(item) for item in formats)
    return config


def shift_date(date_text, days):
    """date_text minus N days, as YYYY-MM-DD (week_over_week lookups)."""
    try:
        return (_dt.datetime.strptime(str(date_text), "%Y-%m-%d")
                - _dt.timedelta(days=int(days))).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return "?"


def snapshot_dates(snapshots_dir=None):
    """All date-named snapshot folders, ascending."""
    base = Path(snapshots_dir) if snapshots_dir else SNAPSHOTS_DIR
    if not base.is_dir():
        return []
    return sorted(entry.name for entry in base.iterdir()
                  if entry.is_dir() and DATE_RE.match(entry.name))


def previous_snapshot_date(curr_date, snapshots_dir=None, compare_mode="previous_snapshot",
                           period_days=7):
    """Pick the comparison snapshot when --prev is not given.

    previous_snapshot - the latest snapshot before curr_date;
    week_over_week    - exactly period_days before curr_date, otherwise None (no comparison).
    """
    dates = [item for item in snapshot_dates(snapshots_dir) if item < str(curr_date)]
    if not dates:
        return None
    if str(compare_mode).strip() == "week_over_week":
        try:
            target = (_dt.datetime.strptime(str(curr_date), "%Y-%m-%d")
                      - _dt.timedelta(days=int(period_days))).strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            return None
        return target if target in dates else None
    return dates[-1]


def settings_structure_warnings(config_dir=None, expected_sections=9):
    """Compare settings.yaml report_sections with the code contract (count and order)."""
    warnings = []
    settings = load_settings(config_dir)
    if not settings:
        return warnings
    sections = settings.get("report_sections")
    if not isinstance(sections, list):
        warnings.append("report_sections в settings.yaml отсутствует или не является списком")
        return warnings
    if len(sections) != int(expected_sections):
        warnings.append("в settings.yaml %d разделов отчёта, в движке %d"
                        % (len(sections), expected_sections))
    prefixes = []
    for item in sections:
        title = item.get("title") if isinstance(item, dict) else None
        match = re.match(r"^\s*(\d+)\s*\.", str(title or ""))
        prefixes.append(int(match.group(1)) if match else None)
    if prefixes != list(range(1, int(expected_sections) + 1)):
        warnings.append("нумерация разделов в settings.yaml не совпадает с порядком 1..%d"
                        % expected_sections)
    return warnings


def settings_value(keys, config_dir=None, default=None):
    """Read a nested settings value by key path, e.g. ('thresholds', 'price_change_pct')."""
    node = load_settings(config_dir)
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


def _configured_dir(value, fallback):
    if not value:
        return fallback
    candidate = Path(str(value))
    return candidate if candidate.is_absolute() else (PROJECT_ROOT / candidate)


def resolve_snapshots_dir(explicit=None, config_dir=None, use_config=True):
    """Snapshot folder: --snapshots-dir, else output.snapshot_dir, else data/snapshots."""
    if explicit:
        return Path(explicit)
    if not use_config:
        return SNAPSHOTS_DIR
    return _configured_dir(settings_value(("output", "snapshot_dir"), config_dir), SNAPSHOTS_DIR)


def resolve_reports_dir(explicit=None, config_dir=None, use_config=True):
    """Reports folder: --reports-dir, else output.report_dir, else reports."""
    if explicit:
        return Path(explicit)
    if not use_config:
        return REPORTS_DIR
    return _configured_dir(settings_value(("output", "report_dir"), config_dir), REPORTS_DIR)


def settings_threshold(config_dir=None, default=DEFAULT_THRESHOLD_PCT):
    """thresholds.price_change_pct from settings.yaml, else the given default."""
    value = settings_value(("thresholds", "price_change_pct"), config_dir)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def settings_formats(config_dir=None, default=DEFAULT_FORMATS):
    """output.formats from settings.yaml as a 'md,xlsx' string."""
    value = settings_value(("output", "formats"), config_dir)
    if isinstance(value, list) and value:
        return ",".join(str(item) for item in value)
    return default

