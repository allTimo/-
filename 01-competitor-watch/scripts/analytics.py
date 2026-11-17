#!/usr/bin/env python3
r"""analytics.py - machine-readable analytics for Agent 1 (task WP2).

Standard library only.

What it produces (schema_version 1, contract fixed by the Lead):

    reports/clients/<client-id>/.cache/analytics-<YYYY-MM-DD>.json

    {
      schema_version, date, generated_at, client_id,
      toggles: {...},
      metrics: {competitorsInAnalysis, competitorsWithData,
                lotsAnalyzed, cheapestLotRub},   # contract v2 §5.3
      truth: {competitors, withData, withoutSource,
              list: [{id, name, developer, klass, site, platforms,
                      hasSource, hasData, status}]},  # contract v2 §5.1
      by_competitor: [{project, developer, lots_on_sale, cheapest_lot_rub,
                       price_per_m2: {min, median, max}, sources: [...]}],
      by_source: [{source, lots_on_sale, median_price_per_m2, min, max}],
      dynamics: [{project, lots_new, lots_gone, median_delta_pct,
                  period: {prev, curr}}],
      promos_new: [{project, text, first_seen}],
      promos_known_count: N,
      forecast: [{project, metric, method, points, weeks, values, estimate}] | null,
      email: [{to, status, sent_at, file}],
      data_status: [{source, status, reason}]
    }

Honesty rules (non-negotiable):
    * a missing number is null plus a `data_status` record with the reason,
      never a silent zero;
    * `forecast` is built only when the snapshot history has >= 3 points for a
      project, is explicitly marked estimate=true / method="trend-linear", and
      is null (with a reason) otherwise;
    * no value is ever invented: statistics come from the snapshot rows only.

Toggles come from registry/agent-settings/agent-1-competitor-watch.yaml
(agent1.analytics.*). A missing key means the safe default True.
"""
from __future__ import annotations

import datetime as _dt
import statistics
from pathlib import Path

import cwlib as cw
import marketing_settings as ms

SCHEMA_VERSION = 1
ANALYTICS_SECTION_TITLE = "Аналитика по всем лотам в продаже"
FORECAST_WEEKS = 4
FORECAST_MIN_POINTS = 3
DASH = "—"

# Toggle names exactly as they are read from agent1.analytics.
TOGGLE_KEYS = (
    "enabled",            # master switch for the whole analytics block
    "lots_all_on_sale",   # number of lots on sale
    "price_dynamics",     # new/gone lots and median delta vs the previous snapshot
    "promos",             # new promos + counter of the already known ones
    "developers_sites",   # breakdown by source / developer site
    "dedup_promos",       # show an identical promo of one project once
    "new_promos_only",    # report shows only promos absent from the previous snapshot
    "forecast",           # trend-based forecast on the snapshot history
)

_WEEK = _dt.timedelta(days=7)


def resolve_toggles(agent_settings=None):
    """Analytics toggles with the safe default True for every missing key."""
    raw = {}
    if isinstance(agent_settings, dict):
        node = agent_settings.get("agent1")
        if isinstance(node, dict):
            node = node.get("analytics")
            if isinstance(node, dict):
                raw = node
    toggles = {}
    for key in TOGGLE_KEYS:
        value = raw.get(key)
        toggles[key] = True if value is None else bool(value)
    return toggles


def analytics_enabled(toggles):
    return bool((toggles or {}).get("enabled", True))


# --------------------------------------------------------------------------
# promo cleaning: dedup + "only new"
# --------------------------------------------------------------------------

def _norm_text(value):
    return " ".join(str(value or "").split()).strip().casefold()


def dedup_promo_rows(rows):
    """Collapse an identical promo of one project+lot into a single row.

    Identity is (project, promo text, status): the same wording repeated across
    several lots of one project is shown once and carries the lot count.
    Returns (unique_rows, folded_count); folded_count is the number of rows that
    were dropped as duplicates.
    """
    unique, seen = [], {}
    folded = 0
    for row in rows or []:
        key = (str(row.get("project") or ""), _norm_text(row.get("promo_text")),
               str(row.get("status") or ""))
        if key in seen:
            seen[key]["lots"] = int(seen[key].get("lots") or 1) + 1
            folded += 1
            continue
        item = dict(row)
        item["lots"] = 1
        seen[key] = item
        unique.append(item)
    return unique, folded


def _promo_set(rows):
    result = set()
    for row in rows or []:
        if cw.promo_is_on(row):
            result.add((str(row.get("project") or ""), _norm_text(row.get("promo_text"))))
    return result


# --------------------------------------------------------------------------
# statistics helpers
# --------------------------------------------------------------------------

def _sorted_sources(values):
    return sorted({str(value) for value in values if value not in (None, "")})


def _price_block(values, metric="median"):
    """{min, median, max} plus the configured metric (contract agent1.selection).

    With the default metric the key set stays exactly {min, median, max} so the
    analytics schema does not change; mean/min_max add metric/metric_value.
    """
    return ms.price_block(values, metric)


def _visible_rows(rows):
    """Lots that take part in the analytics: status active only."""
    return [row for row in rows or [] if cw.is_active(row)]


def _group_by_project(rows):
    groups = {}
    for row in rows:
        key = (str(row.get("competitor") or ""), str(row.get("project") or ""))
        groups.setdefault(key, []).append(row)
    return groups


def _project_key(row):
    return (str(row.get("competitor") or ""), str(row.get("project") or ""))


# --------------------------------------------------------------------------
# истина конкурентов и метрики карточки (контракт v2, §4/§5.1/§5.3)
# --------------------------------------------------------------------------

NO_SOURCE_NOTE = "без источника — в анализ не попадает"
SOURCE_KEYS = ("cian", "avito", "yandex_realty", "domclick")


def _norm_name(value):
    return " ".join(str(value or "").split()).casefold()


def _has_rows_for(rows, name, developer):
    """Есть ли в анализе лот этой записи: лоты носят project=name, competitor=developer."""
    for row in rows or []:
        if name and _norm_name(row.get("project")) == _norm_name(name):
            return True
        if not name and developer and _norm_name(row.get("competitor")) == _norm_name(developer):
            return True
    return False


def competitor_truth(competitors, rows=None):
    """Истинный список конкурентов — ровно записи `competitors[]` клиентского конфига.

    Возвращает {"competitors": N, "withData": M, "withoutSource": K, "list": [...]}
    или None, когда клиентский конфиг не передан (тогда движок честно отдаёт
    «данных нет», а не ноль). Запись без `site` и без ссылок площадок помечается
    словами «без источника — в анализ не попадает» — не молчанием.
    """
    if competitors is None:
        return None
    active = _visible_rows(rows)
    entries = []
    for item in competitors or []:
        if not isinstance(item, dict):
            continue
        platforms = item.get("platforms") if isinstance(item.get("platforms"), dict) else {}
        urls = {str(key): str(value).strip() for key, value in platforms.items()
                if str(value or "").strip()}
        site = str(item.get("site") or "").strip()
        name = str(item.get("name") or "").strip()
        developer = str(item.get("developer") or "").strip()
        has_source = bool(site or urls)
        has_data = has_source and _has_rows_for(active, name, developer)
        entries.append({
            "id": str(item.get("id") or cw.slug_id(name)),
            "name": name,
            "developer": developer,
            "klass": item.get("class") or "",
            "site": site,
            "platforms": urls,
            "hasSource": has_source,
            "hasData": has_data,
            "source": str(item.get("source") or "").strip(),
            "status": "в анализе" if has_source else NO_SOURCE_NOTE,
        })
    return {
        "competitors": sum(1 for entry in entries if entry["hasSource"]),
        "withData": sum(1 for entry in entries if entry["hasData"]),
        "withoutSource": sum(1 for entry in entries if not entry["hasSource"]),
        "list": entries,
    }


def _min_price(rows):
    """Минимум price_rub по лотам; нет лотов с ценой → None (не 0)."""
    prices = []
    for row in rows or []:
        value = cw.to_int(row.get("price_rub"))
        if value:
            prices.append(value)
    return min(prices) if prices else None


# --------------------------------------------------------------------------
# forecast: linear trend on the weekly median ₽/м² history
# --------------------------------------------------------------------------

def linear_trend(points):
    """Least-squares line through [(index, value)]. None when it is undefined."""
    points = [(float(x), float(y)) for x, y in points]
    count = len(points)
    if count < 2:
        return None
    mean_x = sum(x for x, _ in points) / count
    mean_y = sum(y for _, y in points) / count
    denominator = sum((x - mean_x) ** 2 for x, _ in points)
    if denominator == 0:
        return None
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / denominator
    return slope, mean_y - slope * mean_x


def forecast_series(history, curr_date, weeks=FORECAST_WEEKS):
    """Forecast the median ₽/м² `weeks` weeks ahead from the point history.

    history: [{"date": "YYYY-MM-DD", "median": int}, ...] ascending by date.
    Returns None when fewer than FORECAST_MIN_POINTS points are available
    (the caller records the reason in data_status).
    """
    points = [item for item in (history or []) if item.get("median") is not None]
    if len(points) < FORECAST_MIN_POINTS:
        return None
    trend = linear_trend([(index, item["median"]) for index, item in enumerate(points)])
    if trend is None:
        return None
    slope, intercept = trend
    try:
        base = _dt.datetime.strptime(str(curr_date), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        base = None
    values = []
    last_index = len(points) - 1
    for step in range(1, int(weeks) + 1):
        value = intercept + slope * (last_index + step)
        week = (base + _WEEK * step).isoformat() if base else "неделя +%d" % step
        values.append({"week": week, "value": int(round(value))})
    return {
        "metric": "median_price_per_m2",
        "method": "trend-linear",
        "points": len(points),
        "weeks": int(weeks),
        "values": values,
        "estimate": True,
    }


# --------------------------------------------------------------------------
# snapshot history (per project weekly median ₽/м²)
# --------------------------------------------------------------------------

def history_medians(snapshots_dir):
    """{project: [{"date", "median"}, ...]} from every dated snapshot folder."""
    base = Path(snapshots_dir) if snapshots_dir else cw.SNAPSHOTS_DIR
    history = {}
    if not base.is_dir():
        return history
    for folder in sorted(entry for entry in base.iterdir()
                         if entry.is_dir() and cw.DATE_RE.match(entry.name)):
        snapshot = folder / "lots.csv"
        if not snapshot.exists():
            continue
        try:
            rows = cw.load_snapshot_rows(snapshot)
        except cw.EngineError:
            continue
        for (_competitor, project), group in _group_by_project(_visible_rows(rows)).items():
            values = [cw.stats_ppm2(row) for row in group if cw.stats_ppm2(row)]
            if not values:
                continue
            history.setdefault(project, []).append(
                {"date": folder.name, "median": int(round(statistics.median(values)))})
    return history


# --------------------------------------------------------------------------
# the analytics payload
# --------------------------------------------------------------------------

def build_analytics(curr_rows, prev_rows=None, payload=None, toggles=None,
                    client_id=None, date=None, history=None, email=None,
                    source_status=None, curr_date=None, selection=None, min_lots=None,
                    competitors=None):
    """Build the analytics dict exactly as the Lead's contract defines it.

    selection — agent1.selection from the agent's thin settings (defaults when
    omitted): the price metric, the outlier guard and its limits. min_lots —
    agent1.min_lots: below it the slice gets an honest "мало данных" record.
    competitors — records of `competitors[]` from the client config: the only
    source of the competitor truth (contract v2 §5.1) and of the card metrics
    (§5.3). None means the config was not read → the numbers stay null.
    """
    toggles = resolve_toggles({"agent1": {"analytics": toggles}}) if toggles else resolve_toggles()
    payload = payload or {}
    totals = payload.get("totals") or {}
    curr_date = curr_date or totals.get("curr_date") or date
    prev_date = totals.get("prev_date")
    active = _visible_rows(curr_rows)
    selection = selection or ms.DEFAULT_SELECTION
    metric = str(selection.get("price_metric") or "median")
    # The outlier guard filters statistics only: the snapshot keeps every row,
    # but a distorted slice is marked unreliable and its price is not published.
    clean_active, outliers = ms.drop_outliers(active, selection)
    clean_ids = {id(row) for row in clean_active}
    data_status = []
    for item in source_status or []:
        if isinstance(item, dict) and item.get("source"):
            data_status.append({"source": str(item["source"]),
                                "status": str(item.get("status") or "unknown"),
                                "reason": item.get("reason") or item.get("note") or None})
    if outliers:
        data_status.append({"source": "outlier_guard", "status": "unreliable",
                            "reason": "; ".join(item["reason"] for item in outliers)})
    try:
        min_lots_value = int(min_lots) if min_lots is not None else None
    except (TypeError, ValueError):
        min_lots_value = None
    if min_lots_value and len(active) < min_lots_value:
        data_status.append({"source": "min_lots", "status": "low_data",
                            "reason": "мало данных: активных лотов %d при минимуме agent1.min_lots=%d"
                                      % (len(active), min_lots_value)})

    # ---- истина конкурентов и метрики карточки (§4/§5.3) --------------
    # Лоты «в анализе» = строки текущего снимка после фильтров селекции.
    analyzed, _rejected, _rejected_total = ms.filter_rows(active, selection)
    truth = competitor_truth(competitors, analyzed)
    metrics = {
        "competitorsInAnalysis": truth["competitors"] if truth else None,
        "competitorsWithData": truth["withData"] if truth else None,
        "lotsAnalyzed": len(analyzed) if curr_rows is not None else None,
        "cheapestLotRub": _min_price(analyzed),
    }
    if truth and truth["withoutSource"]:
        data_status.append({"source": "competitors", "status": "no_source",
                            "reason": "%s: %s" % (NO_SOURCE_NOTE, ", ".join(
                                entry["name"] or entry["id"]
                                for entry in truth["list"] if not entry["hasSource"]))})

    # ---- by_competitor / by_source -----------------------------------
    by_competitor = []
    for (competitor, project), group in sorted(_group_by_project(active).items()):
        proj_outliers = [item for item in outliers
                         if _project_key(item) == (competitor, project)]
        clean_group = [row for row in group if id(row) in clean_ids]
        values = [cw.stats_ppm2(row) for row in clean_group if cw.stats_ppm2(row)]
        item = {
            "project": project,
            "developer": competitor,
            "lots_on_sale": len(group) if toggles["lots_all_on_sale"] else None,
            "price_per_m2": _price_block(values, metric),
            "cheapest_lot_rub": _min_price(group),
            "sources": _sorted_sources([row.get("source") for row in group]),
            "reliable": ms.slice_is_reliable(proj_outliers),
        }
        if proj_outliers:
            item["outliers"] = [entry["reason"] for entry in proj_outliers]
        by_competitor.append(item)
    if not toggles["lots_all_on_sale"]:
        data_status.append({"source": "lots_all_on_sale", "status": "disabled",
                            "reason": "тумблер lots_all_on_sale выключен: число лотов в продаже не считается"})
    if not active:
        data_status.append({"source": "lots_on_sale", "status": "no_data",
                            "reason": "в снимке нет лотов со статусом active"})

    by_source = []
    if toggles["developers_sites"]:
        groups = {}
        for row in active:
            groups.setdefault(str(row.get("source") or "unknown"), []).append(row)
        for source, group in sorted(groups.items()):
            source_clean, source_outliers = ms.drop_outliers(group, selection)
            values = [cw.stats_ppm2(row) for row in source_clean if cw.stats_ppm2(row)]
            block = _price_block(values, metric)
            item = {
                "source": source,
                "lots_on_sale": len(group),
                "median_price_per_m2": block["median"],
                "min": block["min"],
                "max": block["max"],
            }
            if "metric" in block:
                item["metric"] = block["metric"]
                item["metric_value"] = block["metric_value"]
            by_source.append(item)
            if source_outliers:
                data_status.append({"source": "by_source:%s" % source, "status": "unreliable",
                                    "reason": "цены источника «%s» посчитаны без аномальных лотов: %s"
                                              % (source, "; ".join(entry["reason"] for entry in source_outliers))})
        if not groups:
            data_status.append({"source": "by_source", "status": "no_data",
                                "reason": "нет активных лотов ни по одному источнику"})
    else:
        data_status.append({"source": "developers_sites", "status": "disabled",
                            "reason": "тумблер developers_sites выключен: срез по источникам не считается"})

    # ---- dynamics ------------------------------------------------------
    dynamics = []
    if not toggles["price_dynamics"]:
        data_status.append({"source": "price_dynamics", "status": "disabled",
                            "reason": "тумблер price_dynamics выключен: динамика к предыдущему снимку не считается"})
    elif prev_rows is None:
        data_status.append({"source": "dynamics", "status": "no_data",
                            "reason": "нет предыдущего снимка — динамика к предыдущему снимку не определяется"})
    else:
        prev_active = _visible_rows(prev_rows)
        clean_prev, _prev_outliers = ms.drop_outliers(prev_active, selection)
        prev_clean_ids = {id(row) for row in clean_prev}
        prev_groups = {(str(r.get("competitor") or ""), str(r.get("project") or "")): r
                       for r in prev_active}
        curr_groups = {(str(r.get("competitor") or ""), str(r.get("project") or "")): r
                       for r in active}
        # lots are matched by the engine's identity key, not by project alone
        prev_keys = {cw.lot_key(r) for r in prev_active}
        curr_keys = {cw.lot_key(r) for r in active}
        projects = sorted(set(prev_groups) | set(curr_groups))
        for competitor, project in projects:
            proj_curr = [r for r in active if _project_key(r) == (competitor, project)]
            proj_prev = [r for r in prev_active if _project_key(r) == (competitor, project)]
            # Medians ignore anomalous lots (outlier_guard), so the delta is not
            # driven by a parsing artifact or an implausible ₽/м².
            curr_vals = [cw.stats_ppm2(r) for r in proj_curr
                         if id(r) in clean_ids and cw.stats_ppm2(r)]
            prev_vals = [cw.stats_ppm2(r) for r in proj_prev
                         if id(r) in prev_clean_ids and cw.stats_ppm2(r)]
            proj_outliers = [item for item in outliers
                             if _project_key(item) == (competitor, project)]
            median_curr = int(round(statistics.median(curr_vals))) if curr_vals else None
            median_prev = int(round(statistics.median(prev_vals))) if prev_vals else None
            delta = None
            if median_prev not in (None, 0) and median_curr is not None:
                delta = round((median_curr - median_prev) / median_prev * 100.0, 2)
            dyn = {
                "project": project,
                "lots_new": sum(1 for r in proj_curr if cw.lot_key(r) not in prev_keys),
                "lots_gone": sum(1 for r in proj_prev if cw.lot_key(r) not in curr_keys),
                "median_delta_pct": delta,
                "period": {"prev": prev_date, "curr": curr_date},
            }
            if proj_outliers:
                dyn["reliable"] = False
                dyn["outliers"] = [item["reason"] for item in proj_outliers]
                data_status.append({"source": "dynamics:%s" % project, "status": "unreliable",
                                    "reason": "медиана проекта «%s» посчитана без аномальных лотов: %s"
                                              % (project, "; ".join(dyn["outliers"]))})
            if delta is None:
                data_status.append({"source": "dynamics:%s" % project, "status": "no_data",
                                    "reason": "для проекта «%s» нет медианы ₽/м² в одном из снимков" % project})
            dynamics.append(dyn)

    # ---- promos --------------------------------------------------------
    promos_new = []
    promos_known_count = 0
    if not toggles["promos"]:
        data_status.append({"source": "promos", "status": "disabled",
                            "reason": "тумблер promos выключен: акции не разбираются"})
    elif prev_rows is None:
        data_status.append({"source": "promos", "status": "no_data",
                            "reason": "нет предыдущего снимка — новые акции не определяются"})
    else:
        prev_promos = _promo_set(prev_rows)
        curr_promos = _promo_set(active)
        if toggles["new_promos_only"]:
            shown = curr_promos - prev_promos
            promos_known_count = len(curr_promos & prev_promos)
        else:
            # toggle off: every promo currently on sale is listed, nothing is folded
            shown = curr_promos
            promos_known_count = 0
        for project, text in sorted(shown):
            original = _original_promo_text(active, project, text)
            promos_new.append({"project": project, "text": original, "first_seen": curr_date})

    # ---- forecast ------------------------------------------------------
    forecast = None
    if not toggles["forecast"]:
        data_status.append({"source": "forecast", "status": "disabled",
                            "reason": "тумблер forecast выключен: прогноз не считается"})
    else:
        history = history or {}
        series = []
        for project in sorted(history):
            item = forecast_series(history[project], curr_date)
            if item is None:
                data_status.append({
                    "source": "forecast:%s" % project, "status": "no_data",
                    "reason": "истории мало: %d точек из %d нужных — прогноз не строится"
                              % (len(history[project]), FORECAST_MIN_POINTS)})
                continue
            series.append(dict(item, project=project))
        forecast = series if series else None
        if not history:
            data_status.append({"source": "forecast", "status": "no_data",
                                "reason": "история снимков отсутствует — прогноз не с чем строить"})

    return {
        "schema_version": SCHEMA_VERSION,
        "date": curr_date,
        "generated_at": _dt.datetime.now().replace(microsecond=0).isoformat(),
        "client_id": client_id,
        "toggles": dict(toggles),
        "metrics": metrics,
        "truth": truth,
        "by_competitor": by_competitor,
        "by_source": by_source,
        "dynamics": dynamics,
        "promos_new": promos_new,
        "promos_known_count": promos_known_count,
        "forecast": forecast,
        "email": list(email or []),
        "data_status": data_status,
    }


def _original_promo_text(rows, project, normalized):
    for row in rows:
        if str(row.get("project") or "") == project and _norm_text(row.get("promo_text")) == normalized:
            return " ".join(str(row.get("promo_text") or "").split()).strip()
    return normalized


# --------------------------------------------------------------------------
# output paths
# --------------------------------------------------------------------------

def analytics_path(reports_dir, date, client_id=None):
    """reports/clients/<client-id>/.cache/analytics-<date>.json (per client),
    or reports/.cache/analytics-<date>.json when there is no client."""
    base = Path(reports_dir)
    if client_id:
        base = base / "clients" / str(client_id)
    return base / cw.CACHE_DIR_NAME / ("analytics-%s.json" % date)


def write_analytics(path, data):
    return cw.json_dump(path, data)


# --------------------------------------------------------------------------
# markdown rendering
# --------------------------------------------------------------------------

def _money(value):
    return cw.fmt_int(value) + " ₽" if isinstance(value, (int, float)) else DASH


def _cell(value):
    if value is None or value == "":
        return DASH
    return str(value).replace("|", "\\|").replace("\n", " ")


def _metric(value, money=False):
    """Число метрики: отсутствие данных — словами «данных нет», не нулём (§4)."""
    if value is None:
        return "данных нет"
    return _money(value) if money else cw.fmt_int(value)


def metrics_block(data):
    """Строки Markdown с плитками карточки и истинным списком конкурентов."""
    lines = []
    metrics = data.get("metrics") or {}
    lines += ["### Метрики Агента 1", ""]
    lines += ["| Показатель | Значение |", "| --- | --- |"]
    lines.append("| Конкурентов в анализе | %s |" % _metric(metrics.get("competitorsInAnalysis")))
    lines.append("| Из них с данными | %s |" % _metric(metrics.get("competitorsWithData")))
    lines.append("| Лотов проанализировано | %s |" % _metric(metrics.get("lotsAnalyzed")))
    lines.append("| Самый дешёвый лот | %s |" % _metric(metrics.get("cheapestLotRub"), money=True))
    lines.append("")
    truth = data.get("truth")
    if isinstance(truth, dict) and truth.get("list"):
        lines += ["### Конкуренты в анализе (истина из клиентского конфига)", ""]
        lines += ["| Конкурент | Застройщик | Источник | Статус |", "| --- | --- | --- | --- |"]
        for item in truth["list"]:
            platforms = item.get("platforms") or {}
            source_text = item.get("site") or ", ".join(platforms.values()) or DASH
            if item.get("hasSource"):
                status = "в анализе, данные есть" if item.get("hasData") \
                    else "в анализе, данных в снимке нет"
            else:
                status = NO_SOURCE_NOTE
            lines.append("| %s | %s | %s | %s |"
                         % (_cell(item.get("name")), _cell(item.get("developer")),
                            _cell(source_text), _cell(status)))
        lines += ["", "_Итого записей: %d, с источником: %d, без источника: %d._"
                  % (len(truth["list"]), truth.get("competitors") or 0,
                     truth.get("withoutSource") or 0), ""]
    return lines


def render_markdown(data):
    """Human-readable analytics block appended to the weekly report.

    Returned as a list of Markdown lines (the caller joins them). The block is
    deliberately unnumbered: the 9 numbered report sections are a frozen
    contract (settings.yaml -> report_sections).
    """
    lines = ["## " + ANALYTICS_SECTION_TITLE, ""]
    if data is None:
        lines += ["_Аналитика отключена (agent1.analytics.enabled = false)._", ""]
        return lines
    toggles = data.get("toggles") or {}
    lines.append("_Машиночитаемый блок: `analytics-%s.json` (schema_version %s). "
                 "Тумблеры: %s._"
                 % (data.get("date"), data.get("schema_version"),
                    ", ".join("%s=%s" % (key, "вкл" if toggles.get(key) else "выкл")
                              for key in TOGGLE_KEYS if key in toggles)))
    lines.append("")
    lines += metrics_block(data)

    lines += ["### Лоты в продаже и цены ₽/м² по конкурентам", ""]
    if data.get("by_competitor"):
        lines += ["| Проект | Застройщик | Лотов в продаже | min ₽/м² | медиана ₽/м² | max ₽/м² | Источники |",
                  "| --- | --- | --- | --- | --- | --- | --- |"]
        for row in data["by_competitor"]:
            price = row.get("price_per_m2") or {}
            lots = row.get("lots_on_sale")
            lines.append("| %s | %s | %s | %s | %s | %s | %s |"
                         % (_cell(row.get("project")), _cell(row.get("developer")),
                            lots if lots is not None else DASH,
                            _money(price.get("min")), _money(price.get("median")), _money(price.get("max")),
                            _cell(", ".join(row.get("sources") or []))))
    else:
        lines.append("_Нет активных лотов — таблица пуста._")
    lines.append("")

    if toggles.get("developers_sites", True):
        lines += ["### Срез по источникам (площадкам и сайтам)", ""]
        if data.get("by_source"):
            lines += ["| Источник | Лотов в продаже | Медиана ₽/м² | min ₽/м² | max ₽/м² |",
                      "| --- | --- | --- | --- | --- |"]
            for row in data["by_source"]:
                lines.append("| %s | %s | %s | %s | %s |"
                             % (_cell(row.get("source")), row.get("lots_on_sale"),
                                _money(row.get("median_price_per_m2")),
                                _money(row.get("min")), _money(row.get("max"))))
        else:
            lines.append("_Активных лотов по источникам нет._")
        lines.append("")

    if toggles.get("price_dynamics", True):
        lines += ["### Динамика к предыдущему снимку", ""]
        if data.get("dynamics"):
            lines += ["| Проект | Новых лотов | Ушедших лотов | Δ медианы | Период |",
                      "| --- | --- | --- | --- | --- |"]
            for row in data["dynamics"]:
                period = row.get("period") or {}
                delta = row.get("median_delta_pct")
                lines.append("| %s | %d | %d | %s | %s → %s |"
                             % (_cell(row.get("project")), row["lots_new"], row["lots_gone"],
                                cw.fmt_pct(delta) if delta is not None else DASH,
                                period.get("prev") or DASH, period.get("curr") or DASH))
        else:
            lines.append("_Динамика недоступна (см. статусы данных ниже)._")
        lines.append("")

    if toggles.get("promos", True):
        lines += ["### Акции: новые и уже известные", ""]
        if data.get("promos_new"):
            lines += ["| Проект | Текст акции | Впервые замечена |", "| --- | --- | --- |"]
            for row in data["promos_new"]:
                lines.append("| %s | %s | %s |" % (_cell(row.get("project")), _cell(row.get("text")),
                                                   _cell(row.get("first_seen"))))
        else:
            lines.append("_Новых акций относительно предыдущего снимка нет._")
        lines.append("")
        lines.append("_Уже известных акций (были в предыдущем снимке, свёрнуты в счётчик): %d._"
                     % (data.get("promos_known_count") or 0))
        lines.append("")

    lines += ["### Прогноз медианы ₽/м²", ""]
    if data.get("forecast"):
        lines.append("_Прогноз: оценка (estimate) по линейному тренду `trend-linear` на истории снимков._")
        lines.append("")
        lines += ["| Проект | Точек истории | Method | Горизонт | Неделя | Прогноз ₽/м² |",
                  "| --- | --- | --- | --- | --- | --- |"]
        for item in data["forecast"]:
            for value in item["values"]:
                lines.append("| %s | %d | %s | %d нед. | %s | %s |"
                             % (_cell(item.get("project")), item["points"], item["method"],
                                item["weeks"], _cell(value.get("week")), _money(value.get("value"))))
    else:
        lines.append("_Прогноз не строится: данных мало (нужно не меньше %d точек истории снимков). "
                     "Причина — в статусах данных ниже._" % FORECAST_MIN_POINTS)
    lines.append("")

    lines += ["### Статусы данных", ""]
    if data.get("data_status"):
        lines += ["| Источник / блок | Статус | Причина |", "| --- | --- | --- |"]
        for row in data["data_status"]:
            lines.append("| %s | %s | %s |" % (_cell(row.get("source")), _cell(row.get("status")),
                                               _cell(row.get("reason"))))
    else:
        lines.append("_Все данные собраны, статусов с причинами нет._")
    lines.append("")
    return lines


# --------------------------------------------------------------------------
# xlsx sheet
# --------------------------------------------------------------------------

ANALYTICS_SHEET_HEADERS = ["Блок", "Объект", "Показатель", "Значение", "Примечание"]


def sheet_rows(data):
    """Flat rows for the XLSX sheet «Аналитика» (4 data columns + note)."""
    rows = []
    if data is None:
        return [["analytics", "", "статус", "выключено", "agent1.analytics.enabled = false"]]
    metrics = data.get("metrics") or {}
    for key, label in (("competitorsInAnalysis", "конкурентов в анализе"),
                       ("competitorsWithData", "из них с данными"),
                       ("lotsAnalyzed", "лотов проанализировано"),
                       ("cheapestLotRub", "самый дешёвый лот, ₽")):
        rows.append(["метрики Агента 1", "", label, metrics.get(key),
                     "null = данных нет (не ноль)" if metrics.get(key) is None else ""])
    truth = data.get("truth")
    if isinstance(truth, dict):
        for item in truth.get("list") or []:
            rows.append(["конкуренты в анализе", item.get("name"), "статус",
                         "в анализе" if item.get("hasSource") else NO_SOURCE_NOTE,
                         "застройщик: %s" % (item.get("developer") or DASH)])
    for row in data.get("by_competitor") or []:
        price = row.get("price_per_m2") or {}
        rows.append(["лоты в продаже", row.get("project"), "лотов в продаже",
                     row.get("lots_on_sale"), "застройщик: %s" % (row.get("developer") or DASH)])
        rows.append(["цены ₽/м²", row.get("project"), "медиана", price.get("median"),
                     "min %s / max %s" % (price.get("min"), price.get("max"))])
    for row in data.get("by_source") or []:
        rows.append(["источники", row.get("source"), "лотов в продаже", row.get("lots_on_sale"), ""])
        rows.append(["источники", row.get("source"), "медиана ₽/м²", row.get("median_price_per_m2"),
                     "min %s / max %s" % (row.get("min"), row.get("max"))])
    for row in data.get("dynamics") or []:
        rows.append(["динамика", row.get("project"), "новых лотов", row.get("lots_new"), ""])
        rows.append(["динамика", row.get("project"), "ушедших лотов", row.get("lots_gone"), ""])
        rows.append(["динамика", row.get("project"), "Δ медианы, %", row.get("median_delta_pct"), ""])
    for row in data.get("promos_new") or []:
        rows.append(["акции новые", row.get("project"), row.get("text"), row.get("first_seen"), ""])
    rows.append(["акции известные", "", "свёрнуто в счётчик", data.get("promos_known_count"), ""])
    for item in data.get("forecast") or []:
        for value in item.get("values") or []:
            rows.append(["прогноз (оценка)", item.get("project"),
                         "median_price_per_m2 / %s" % item.get("method"),
                         value.get("value"), "неделя %s, точек %s" % (value.get("week"), item.get("points"))])
    if data.get("forecast") is None:
        rows.append(["прогноз (оценка)", "", "не построен", None,
                     "данных мало: нужно ≥%d точек истории" % FORECAST_MIN_POINTS])
    for row in data.get("data_status") or []:
        rows.append(["статус данных", row.get("source"), row.get("status"), row.get("reason"), ""])
    return rows
