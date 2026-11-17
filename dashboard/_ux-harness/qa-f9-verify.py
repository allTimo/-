#!/usr/bin/env python3
r"""qa-f9-verify.py — НЕЗАВИСИМАЯ проверка F9 (стабильный ключ лота, контракт §6).

Своими средствами: CSV читаю сам (stdlib csv), пересечение считаю сам, остаток
классифицирую сам по подписи §5.2. Код движка использую только там, где проверяю
его поведение (инварианты идентичности и повторный прогон переноса).

    python marketing-agents\dashboard\_ux-harness\qa-f9-verify.py

Разделы:
  A) пересечение снимков по всем парам + разбор остатка (реально ушёл / дубли-излишек /
     подозрение на потерю идентичности), распределение ступеней n/u/c/r, заполненность url;
  B) инварианты идентичности на своих фикстурах (идемпотентность, перестановка, цена,
     url, коллизия с суффиксом -2 и счётчиком, ступени n/u/c, отсутствие выдуманных ключей);
  C) безопасность переноса на КОПИИ: только колонка lot_id изменилась, число строк то же,
     повторный прогон ничего не меняет (идемпотентность), .bak на месте;
  D) предсуществующие ошибки `snapshot_tool validate` до и после переноса (пер client/date).
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]                       # marketing-agents
SCRIPTS = PROJECT / "01-competitor-watch" / "scripts"
DATA = PROJECT / "01-competitor-watch" / "data" / "clients"
WORK = HERE / "tmp" / "f9"
PY = sys.executable

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

OK = 0
FAIL = 0
FINDINGS: list[str] = []
SUMMARY: dict = {}


def check(label: str, cond: bool, detail: str = "") -> None:
    global OK, FAIL
    print("  " + ("OK  " if cond else "FAIL") + " " + label + ("  (%s)" % detail if detail else ""))
    if cond:
        OK += 1
    else:
        FAIL += 1


def note(label: str, detail: str) -> None:
    print("  ЗАМЕЧАНИЕ " + label + "  (" + detail + ")")


def defect(label: str, detail: str) -> None:
    global FAIL
    print("  ДЕФЕКТ " + label + "  (" + detail + ")")
    FAIL += 1
    FINDINGS.append(label + ": " + detail)


# --- своё чтение снимка: без cwlib -------------------------------------------------
def read_snapshot(path: Path):
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        header = list(reader.fieldnames or [])
        rows = []
        for raw in reader:
            if raw is None:
                continue
            if not any(str(v or "").strip() for v in raw.values()):
                continue
            rows.append({k: (raw.get(k) if raw.get(k) is not None else "") for k in header})
    return header, rows


def key_of(row) -> tuple:
    return (row.get("source"), row.get("competitor"), row.get("project"), row.get("lot_id"))


def _text(v) -> str:
    return " ".join(str(v or "").split()).lower()


def _num(v):
    t = str(v or "").strip()
    if t == "":
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _int(v):
    n = _num(v)
    return None if n is None else int(n)


def sig_of(row) -> tuple:
    """Подпись содержимого §5.2 (без цены и без позиции)."""
    return (_text(row.get("source")), _text(row.get("competitor")), _text(row.get("project")),
            _int(row.get("rooms")), _num(row.get("area_m2")), _int(row.get("floor")),
            _int(row.get("floors_total")), _text(row.get("building")))


def step_of(row) -> str:
    lid = str(row.get("lot_id") or "")
    return lid[:1] if re.match(r"^[nucr]-", lid) else "old"


def url_state(row) -> str:
    return "filled" if str(row.get("url") or "").strip() else "empty"


# ---------------------------------------------------------------- A. пересечения
def measure_pair(client: str, prev: str, curr: str, out: dict) -> dict:
    a_path = DATA / client / "snapshots" / prev / "lots.csv"
    b_path = DATA / client / "snapshots" / curr / "lots.csv"
    if not a_path.exists() or not b_path.exists():
        print("  нет пары %s %s/%s" % (client, prev, curr))
        return {}
    _, a_rows = read_snapshot(a_path)
    _, b_rows = read_snapshot(b_path)
    a_keys = {key_of(r) for r in a_rows}
    b_keys = {key_of(r) for r in b_rows}
    common = a_keys & b_keys
    smaller = min(len(a_keys), len(b_keys)) or 1
    gone = [r for r in a_rows if key_of(r) not in b_keys]
    fresh = [r for r in b_rows if key_of(r) not in a_keys]
    pct = round(100.0 * len(common) / smaller, 2)

    ref_path = DATA / client / "snapshots" / "2026-11-04" / "lots.csv"
    _, ref_rows = read_snapshot(ref_path) if ref_path.exists() else ([], [])
    ref_sig = Counter(sig_of(r) for r in ref_rows)
    b_sig = Counter(sig_of(r) for r in b_rows)
    a_sig = Counter(sig_of(r) for r in a_rows)
    real_gone, surplus, suspicious, no_ref = [], [], [], []
    for row in gone:
        sig = sig_of(row)
        if b_sig.get(sig, 0) == 0:
            real_gone.append(row)
        elif ref_sig.get(sig, 0) == 0:
            # аналога в эталонном снимке 11-04 нет -> перенос физически не мог дать новый ключ
            no_ref.append(row)
        elif a_sig.get(sig, 0) > b_sig.get(sig, 0):
            surplus.append(row)
        else:
            suspicious.append(row)

    steps_prev = Counter(step_of(r) for r in a_rows)
    steps_curr = Counter(step_of(r) for r in b_rows)
    url_prev = Counter(url_state(r) for r in a_rows)
    url_curr = Counter(url_state(r) for r in b_rows)
    # url обязан быть заполнен ровно у строк ступеней n/u (url — материал ступени или сосед по лоту)
    bad_url = [r for r in b_rows if step_of(r) in ("n", "u") and url_state(r) == "empty"]
    bad_url_c = [r for r in b_rows if step_of(r) == "c" and url_state(r) == "filled"]

    result = {
        "client": client, "prev": prev, "curr": curr,
        "rows_prev": len(a_rows), "rows_curr": len(b_rows),
        "keys_prev": len(a_keys), "keys_curr": len(b_keys),
        "common": len(common), "smaller": smaller, "pct": pct,
        "new": len(fresh), "gone": len(gone),
        "real_gone": len(real_gone), "dup_surplus": len(surplus), "suspicious": len(suspicious),
        "no_ref_key": len(no_ref),
        "no_ref_examples": [{"project": r.get("project"), "rooms": r.get("rooms"),
                             "area": r.get("area_m2"), "lot_id": r.get("lot_id")} for r in no_ref[:12]],
        "steps_prev": dict(steps_prev), "steps_curr": dict(steps_curr),
        "url_prev": dict(url_prev), "url_curr": dict(url_curr),
        "n_or_u_without_url": len(bad_url), "c_step_with_url": len(bad_url_c),
        "gone_with_new_prefix": sum(1 for r in gone if step_of(r) != "old"),
        "real_gone_examples": [{"project": r.get("project"), "rooms": r.get("rooms"),
                                "area": r.get("area_m2"), "floor": r.get("floor"),
                                "lot_id": r.get("lot_id")} for r in real_gone[:12]],
        "suspicious_examples": [{"project": r.get("project"), "rooms": r.get("rooms"),
                                 "area": r.get("area_m2"), "lot_id": r.get("lot_id")} for r in suspicious[:12]],
        "dup_surplus_examples": [{"project": r.get("project"), "area": r.get("area_m2"),
                                  "lot_id": r.get("lot_id")} for r in surplus[:12]],
    }
    out["%s:%s>%s" % (client, prev, curr)] = result

    print("  == %s %s -> %s" % (client, prev, curr))
    print("     строк %d -> %d | уникальных ключей %d -> %d | пересечение %d из %d = %.2f%%"
          % (len(a_rows), len(b_rows), len(a_keys), len(b_keys), len(common), smaller, pct))
    print("     ступени %s: %s | url: %s" % (curr, dict(sorted(steps_curr.items())), dict(sorted(url_curr.items()))))
    print("     новые %d, ушедшие %d -> реально ушли %d, нет эталонного ключа %d, дубли-излишек %d, подозрительных %d"
          % (len(fresh), len(gone), len(real_gone), len(no_ref), len(surplus), len(suspicious)))
    for row in real_gone[:12]:
        print("        реально ушёл: %-34s комнат %-3s площадь %-8s этаж %-4s id %s"
              % (str(row.get("project"))[:34], row.get("rooms"), row.get("area_m2"),
                 row.get("floor"), row.get("lot_id")))
    for row in suspicious[:12]:
        print("        ПОДОЗРЕНИЕ: %-34s комнат %-3s площадь %-8s id %s (аналог в новом снимке есть!)"
              % (str(row.get("project"))[:34], row.get("rooms"), row.get("area_m2"), row.get("lot_id")))
    return result


def section_a(out: dict) -> None:
    print("A. Пересечение снимков своими средствами (CSV читаю сам):")
    pairs = [("client-svet", "2026-11-01", "2026-11-02"),
             ("client-svet", "2026-11-02", "2026-11-03"),
             ("client-svet", "2026-11-03", "2026-11-04"),
             ("client-granel", "2026-11-02", "2026-11-03"),
             ("client-granel", "2026-11-03", "2026-11-04")]
    for client, prev, curr in pairs:
        measure_pair(client, prev, curr, out)
    return None


# ---------------------------------------------------------------- B. инварианты
def section_a2(pairs: dict) -> None:
    """Разбор строк, у которых ключ не совпал, хотя подпись в другом снимке есть."""
    print("A2. Разбор несовпавших строк, у которых подпись в новом снимке есть:")
    for key, pair in pairs.items():
        if not (pair.get("suspicious") or pair.get("no_ref_key")):
            continue
        client, rest = key.split(":")
        prev, curr = rest.split(">")
        ref_date = "2026-11-04"
        _, a_rows = read_snapshot(DATA / client / "snapshots" / prev / "lots.csv")
        _, b_rows = read_snapshot(DATA / client / "snapshots" / curr / "lots.csv")
        ref_path = DATA / client / "snapshots" / ref_date / "lots.csv"
        _, r_rows = read_snapshot(ref_path) if ref_path.exists() else ([], [])
        b_keys = {key_of(r) for r in b_rows}
        b_sig = Counter(sig_of(r) for r in b_rows)
        a_sig = Counter(sig_of(r) for r in a_rows)
        ref_sig = Counter(sig_of(r) for r in r_rows)
        printed = 0
        for row in a_rows:
            if key_of(row) in b_keys:
                continue
            sig = sig_of(row)
            if b_sig.get(sig, 0) == 0:
                continue                       # реально ушёл: аналога нет вовсе
            refs = [r for r in r_rows if sig_of(r) == sig]
            twins = [r for r in b_rows if sig_of(r) == sig]
            if ref_sig.get(sig, 0) == 0:
                kind = "НЕТ ЭТАЛОННОГО КЛЮЧА (в 11-04 такого лота нет — перенос не мог дать новый id)"
            elif a_sig.get(sig, 0) > b_sig.get(sig, 0):
                kind = "ДУБЛЬ-ИЗЛИШЕК (в старом снимке таких строк больше, чем в новом)"
            else:
                kind = "ПОДОЗРЕНИЕ: потеря идентичности"
            print("     %s %s->%s %s: %s | id %s | строк в %s: %d, в %s: %d (ключи %s), в 11-04: %d (ключи %s)"
                  % (client, prev, curr, kind, str(row.get("project"))[:26], row.get("lot_id"),
                     prev, a_sig.get(sig, 0), curr, len(twins),
                     ",".join(str(t.get("lot_id")) for t in twins),
                     len(refs), ",".join(str(t.get("lot_id")) for t in refs)))
            printed += 1
        if printed:
            print("     всего таких строк в паре: %d (нет эталонного ключа %d, дублей-излишков %d, подозрительных %d)"
                  % (pair.get("no_ref_key", 0) + pair.get("dup_surplus", 0) + pair.get("suspicious", 0),
                     pair.get("no_ref_key", 0), pair.get("dup_surplus", 0), pair.get("suspicious", 0)))


def section_b9() -> None:
    """D-F9-DUP после исправления (task-11): мягкая ступень не забирает ключ у точной,
    ключи уникальны, точная подпись выигрывает. Фикстуры свои, реальные данные не трогаю."""
    print("B9. Зонд переноса (D-F9-DUP): мягкая ступень «занимает» ключ точной?")
    import migrate_lot_ids as mig
    probe = WORK / "probe"
    shutil.rmtree(probe, ignore_errors=True)
    cols = list(__import__("cwlib").COLUMNS)

    def prow(**over):
        base = {c: "" for c in cols}
        base.update({"snapshot_date": "2026-11-03", "source": "cian", "competitor": "C",
                     "project": "P", "lot_id": "", "url": "", "rooms": "2", "area_m2": "50",
                     "floor": "5", "floors_total": "20", "building": "A", "price_rub": "10000000",
                     "price_per_m2_rub": "200000", "finish": "unknown", "promo_flag": "0",
                     "promo_text": "", "delivery": "", "status": "active"})
        base.update(over)
        return base

    def case(name, old_rows, expect_kept):
        client = probe / name / "data" / "clients" / "client-probe"
        ref = [prow(snapshot_date="2026-11-04", rooms="2", building="A", lot_id="n-KKKK0001")]
        for date, rows in (("2026-11-04", ref), ("2026-11-03", old_rows)):
            path = client / "snapshots" / date / "lots.csv"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(mig.rows_to_csv_text(rows), encoding="utf-8")
        report = mig.migrate_client(client, reference_date="2026-11-04")
        stats = report["dates"]["2026-11-03"]
        keys = [r["lot_id"] for r in mig.load_rows(client / "snapshots" / "2026-11-03" / "lots.csv")]
        return stats, keys, expect_kept

    # вариант 1 — исходная фикстура дефекта: «мягкая» строка идёт раньше «точной»
    stats, keys, kept = case("case-rooms-order",
                             [prow(rooms="0", building="A", lot_id="cian-old0001",
                                   price_rub="9000000", price_per_m2_rub="180000"),
                              prow(rooms="2", building="A", lot_id="cian-old0002")],
                             "cian-old0001")
    check("B9. D-F9-DUP: строк 2, ключи уникальны, точная подпись выигрывает, «мягкая» строка сохранила свой ключ",
          len(keys) == 2 and len(set(keys)) == 2 and "n-KKKK0001" in keys and kept in keys
          and stats["matched_exact"] == 1 and stats["matched_loose"] == 0
          and stats.get("reverted_duplicates", 0) == 0,
          "%s · matched_exact %d + matched_loose %d, unmatched %d, reverted %d"
          % (keys, stats["matched_exact"], stats["matched_loose"], stats["unmatched"],
             stats.get("reverted_duplicates", 0)))

    # вариант 2 — реалистичнее: строки различаются только корпусом, порядок тот же
    stats2, keys2, kept2 = case("case-building-order",
                                [prow(rooms="2", building="B", lot_id="cian-old0011",
                                      price_rub="9500000", price_per_m2_rub="190000"),
                                 prow(rooms="2", building="A", lot_id="cian-old0012")],
                                "cian-old0011")
    check("B9b. то же при различии только по корпусу: ключи уникальны, точная выигрывает",
          len(keys2) == 2 and len(set(keys2)) == 2 and "n-KKKK0001" in keys2 and kept2 in keys2
          and stats2["matched_exact"] == 1 and stats2.get("reverted_duplicates", 0) == 0,
          "%s · matched_exact %d + matched_loose %d" % (keys2, stats2["matched_exact"], stats2["matched_loose"]))


def section_a3() -> None:
    """Нет ли дублей lot_id внутри каждой живой даты (7 снимков) и совпадает ли число ключей с числом строк."""
    print("A3. Дубли lot_id внутри каждой живой даты (7 снимков):")
    total = 0
    problems = []
    for client in ("client-svet", "client-granel"):
        for date_dir in sorted((DATA / client / "snapshots").iterdir()):
            path = date_dir / "lots.csv"
            if not path.exists():
                continue
            _, rows = read_snapshot(path)
            keys = [str(r.get("lot_id") or "") for r in rows]
            total += 1
            dupes = [k for k, n in Counter(keys).items() if n > 1]
            print("     %-14s %s: строк %d, уникальных ключей %d%s"
                  % (client, date_dir.name, len(rows), len(set(keys)),
                     "" if not dupes else ", ДУБЛИ: %s" % dupes[:5]))
            if dupes or len(rows) != len(set(keys)):
                problems.append("%s:%s -> %s" % (client, date_dir.name, dupes[:5]))
    check("A3. ни в одном из %d живых снимков нет повторяющегося lot_id" % total,
          total == 7 and not problems, "проблем: %d %s" % (len(problems), problems))


def section_b() -> None:
    print("B. Инварианты идентичности (§4/§6.2), свои фикстуры и мок коллекторов:")
    import collect_clients as cc
    import marketing_settings as ms
    import platforms
    from unittest import mock

    SETTINGS = ms.load(agent_settings={})
    CLIENTS = [{"name": "QA ЖК", "developer": "QA Дев", "platforms": {"cian": "https://cian.qa/1"}}]
    CLIENT = {"client_id": "client-qa", "name": "QA", "competitors": CLIENTS,
              "sources": [{"id": "cian", "enabled": True, "auth": "none", "mode": "public-pages"}],
              "report": {"title": "QA", "formats": ["md"]}}

    def lot(**over):
        base = {"price_rub": 10_000_000, "area_m2": 40.0, "rooms": 1, "floor": 5,
                "floors_total": 20, "building": "1", "title": "QA", "status": "active"}
        base.update(over)
        return base

    def run(lots, counters=None):
        counters = counters if counters is not None else {}
        def fake_platform(url, source_id, allow_browser=True, expect_name=""):
            return {"source": source_id, "platform": source_id, "url": url, "status": "ok",
                    "note": "", "lots": list(lots), "granularity": "lots", "price_from_rub": None}
        with mock.patch.object(platforms, "collect_platform", fake_platform):
            _, rows, _ = cc.collect_client(CLIENT, "2026-11-04", allow_browser=False,
                                           global_sources=[], marketing_settings=SETTINGS,
                                           counters=counters)
        return rows, counters

    ids = lambda rows: sorted(str(r.get("lot_id")) for r in rows)

    # (1) тот же вход дважды -> те же ключи
    rows1, _ = run([lot(offer_id="A-1"), lot(offer_id="A-2", price_rub=11_000_000)])
    rows2, _ = run([lot(offer_id="A-1"), lot(offer_id="A-2", price_rub=11_000_000)])
    check("B1. тот же вход дважды -> те же ключи", ids(rows1) == ids(rows2), str(ids(rows1)))

    # (2) перестановка лотов -> те же ключи
    rows3, _ = run([lot(offer_id="A-2", price_rub=11_000_000), lot(offer_id="A-1")])
    check("B2. перестановка лотов -> те же ключи (зависимости от позиции нет)",
          ids(rows3) == ids(rows1), "%s vs %s" % (ids(rows3), ids(rows1)))

    # (3) изменение цены -> ключ не меняется
    base_id = [str(r.get("lot_id")) for r in rows1 if str(r.get("project")) == "QA ЖК"][0]
    rows4, _ = run([lot(offer_id="A-1", price_rub=99_000_000)])
    check("B3. изменение цены -> ключ не меняется",
          ids(rows4) == [base_id] and base_id.startswith("n-"),
          "%s -> %s" % (base_id, ids(rows4)))

    # (4) url попадает в строку
    rows5, _ = run([lot(offer_id="A-1", url="https://cian.qa/lot/1?utm=1")])
    check("B4. url попадает в строку снимка", rows5 and rows5[0].get("url") == "https://cian.qa/lot/1?utm=1",
          str(rows5[0].get("url")) if rows5 else "нет строк")

    # (5) ступени: n / u / c
    rows_n, _ = run([lot(offer_id="N-1", url="https://cian.qa/n/1")])
    rows_u, _ = run([lot(url="https://cian.qa/u/1?x=1#y")])
    rows_c, _ = run([lot(area_m2=55.5, rooms=2, floor=7, floors_total=25, building="2")])
    check("B5. родной id -> ступень n-", rows_n and str(rows_n[0]["lot_id"]).startswith("n-"), ids(rows_n))
    check("B5b. без родного id, но с url -> ступень u- (hash(url), query/фрагмент срезаны)",
          rows_u and str(rows_u[0]["lot_id"]).startswith("u-"), ids(rows_u))
    check("B5c. без id и без url, но с содержимым -> ступень c-",
          rows_c and str(rows_c[0]["lot_id"]).startswith("c-"), ids(rows_c))
    # ступень r недостижима для строк снимка: lot_to_row требует rooms и area (оба входят в c-материал)
    rows_min, _ = run([lot(rooms=0, area_m2=1.0, floor="", floors_total="", building="")])
    note("ступень r- для строк снимка недостижима",
         "lot_to_row требует rooms+area, а они входят в материал c-: получено %s" % ids(rows_min))

    # (6) нет выдуманных ключей: свой пересчёт по §4 совпадает с тем, что записал движок
    def my_id(lots_list, source, competitor, project):
        expect = []
        for l in lots_list:
            native = ""
            for k in ("lot_id", "offer_id", "offerId", "cian_id"):
                if str(l.get(k) or "").strip():
                    native = str(l[k]).strip()
                    break
            if native:
                prefix, material = "n", native
            else:
                url = str(l.get("url") or l.get("link") or l.get("offer_url") or "").strip()
                norm = url.split("#", 1)[0].split("?", 1)[0].strip().lower().rstrip("/")
                if norm:
                    prefix, material = "u", norm
                else:
                    prefix = "c"
                    material = "|".join([source, competitor, project,
                                         str(int(l["rooms"])) if l.get("rooms") is not None else "",
                                         ("%.2f" % float(l["area_m2"])).rstrip("0").rstrip(".") if l.get("area_m2") else "",
                                         str(int(l["floor"])) if l.get("floor") not in (None, "") else "",
                                         str(int(l["floors_total"])) if l.get("floors_total") not in (None, "") else "",
                                         " ".join(str(l.get("building") or "").split())])
            expect.append((prefix, material, float(l.get("price_rub") or 0), float(l.get("area_m2") or 0)))
        expect.sort(key=lambda x: (x[1], x[2], x[3], x[0]))
        used = {}
        out = []
        for prefix, material, _p, _a in expect:
            base = "%s-%s" % (prefix, hashlib.sha1(material.encode("utf-8")).hexdigest()[:8])
            n = 1
            key = base
            while key in used:
                n += 1
                key = "%s-%d" % (base, n)
            used[key] = True
            out.append(key)
        return sorted(out)

    fixture = [lot(offer_id="M-1"), lot(offer_id="M-2", url="https://cian.qa/m/2"),
               lot(area_m2=33.0, rooms=0, floor=3, floors_total=9, building="A"),
               lot(area_m2=44.4, rooms=2, floor=8, floors_total=18, building="B")]
    rows_mine, _ = run(fixture)
    check("B6. свои ключи совпадают с ключами движка (нет выдуманных id)",
          ids(rows_mine) == my_id(fixture, "cian", "QA Дев", "QA ЖК"),
          "%s vs %s" % (ids(rows_mine), my_id(fixture, "cian", "QA Дев", "QA ЖК")))

    # (7) коллизия: два лота с одинаковым родным id -> суффикс -2, счётчик, строки не теряются
    dup_lots = [lot(offer_id="DUP", price_rub=10_000_000), lot(offer_id="DUP", price_rub=12_000_000)]
    rows_dup, counters = run(dup_lots)
    base_dup = str(rows_dup[0]["lot_id"]) if rows_dup else ""
    check("B7. коллизия -> суффикс -2, обе строки сохранены",
          len(rows_dup) == 2 and sorted(str(r["lot_id"]) for r in rows_dup)
          == sorted([base_dup, base_dup + "-2"]) and base_dup.startswith("n-"),
          ids(rows_dup))
    check("B7b. коллизия посчитана: lot_id_collisions=1 и предупреждение словами",
          counters.get("lot_id_collisions") == 1 and "проверьте" in str(counters.get("lot_id_note")),
          json.dumps({k: v for k, v in counters.items() if k != "lot_id_suffixed"}, ensure_ascii=False)[:160])

    # (8) коллизия по ступени c (одинаковое содержимое, разная цена)
    same = dict(area_m2=50.0, rooms=2, floor=4, floors_total=16, building="3")
    rows_c2, counters2 = run([lot(price_rub=9_000_000, **same), lot(price_rub=9_500_000, **same)])
    check("B8. коллизия ступени c: суффикс и счётчик, строки не теряются",
          len(rows_c2) == 2 and counters2.get("lot_id_collisions") == 1
          and all(str(r["lot_id"]).startswith("c-") for r in rows_c2),
          "%s · collisions=%s" % (ids(rows_c2), counters2.get("lot_id_collisions")))

    SUMMARY["invariants"] = {"ok": True}


# ---------------------------------------------------------------- C. перенос на копии
def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def section_c() -> None:
    print("C. Безопасность переноса (на КОПИИ, реальные снимки не трогаю):")
    shutil.rmtree(WORK, ignore_errors=True)
    tmp = WORK / "data" / "clients"
    for client in ("client-svet", "client-granel"):
        src = DATA / client / "snapshots"
        dst = tmp / client / "snapshots"
        shutil.copytree(src, dst)

    # C1: текущий файл против .bak переноса — отличается ТОЛЬКО колонка lot_id
    for client in ("client-svet", "client-granel"):
        for date_dir in sorted((tmp / client / "snapshots").iterdir()):
            cur = date_dir / "lots.csv"
            baks = sorted(date_dir.glob("lots.csv.bak-20261104-164726"))
            if not baks:
                note("%s/%s: .bak переноса нет" % (client, date_dir.name),
                     "эталонный снимок — перенос его не трогал" if date_dir.name == "2026-11-04"
                     else "перенос не менял файл (changed=0)")
                continue
            header_c, rows_c = read_snapshot(cur)
            header_b, rows_b = read_snapshot(baks[0])
            same_header = header_c == header_b
            same_count = len(rows_c) == len(rows_b)
            diffs = {}
            for i, (rc, rb) in enumerate(zip(rows_c, rows_b)):
                for col in header_c:
                    if str(rc.get(col)) != str(rb.get(col)):
                        diffs.setdefault(col, 0)
                        diffs[col] += 1
            check("C1. %s %s: строк %d->%d, заголовок тот же, изменена только lot_id"
                  % (client, date_dir.name, len(rows_b), len(rows_c)),
                  same_header and same_count and set(diffs.keys()) <= {"lot_id"},
                  "колонки с различиями: " + (json.dumps(diffs, ensure_ascii=False) if diffs else "нет"))
            if diffs.get("lot_id"):
                SUMMARY.setdefault("migrated_rows", {})["%s:%s" % (client, date_dir.name)] = diffs["lot_id"]

    # C2: идемпотентность — повторный прогон на копии ничего не меняет
    before = {str(p.relative_to(tmp)): sha(p) for p in sorted(tmp.rglob("lots.csv"))}
    baks_before = {str(p.relative_to(tmp)) for p in tmp.rglob("lots.csv.bak-*")}
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(SCRIPTS))
    proc = subprocess.run([PY, str(SCRIPTS / "migrate_lot_ids.py"), "--data-dir", str(tmp)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=env, cwd=str(PROJECT))
    after = {str(p.relative_to(tmp)): sha(p) for p in sorted(tmp.rglob("lots.csv"))}
    baks_after = {str(p.relative_to(tmp)) for p in tmp.rglob("lots.csv.bak-*")}
    check("C2. повторный прогон переноса: exit 0", proc.returncode == 0, (proc.stdout or proc.stderr).strip().splitlines()[-1][:110] if (proc.stdout or proc.stderr).strip() else "нет вывода")
    check("C2b. повторный прогон ничего не изменил (идемпотентность, sha совпали)",
          before == after, "изменились: " + (", ".join(k for k in before if before.get(k) != after.get(k)) or "нет"))
    changed_report = re.findall(r"Всего перенесено ключей: (\d+)", proc.stdout or "")
    check("C2c. отчёт повторного прогона: перенесено 0 ключей",
          bool(changed_report) and changed_report[0] == "0", "«%s»" % (changed_report[0] if changed_report else "нет строки"))
    extra = sorted(baks_after - baks_before)
    check("C2d. у неизменённых файлов новых .bak не появилось", not extra, "лишних копий: %d" % len(extra))

    # C3: .bak у каждого ИЗМЕНЁННОГО снимка в реальных данных + число строк совпадает с отчётом переноса
    print("  -- реальные .bak переноса и число строк --")
    for client in ("client-svet", "client-granel"):
        for date_dir in sorted((DATA / client / "snapshots").iterdir()):
            cur = date_dir / "lots.csv"
            _, rows = read_snapshot(cur)
            baks = sorted(date_dir.glob("lots.csv.bak-20261104-164726"))
            print("     %-14s %s: строк %d, .bak переноса: %s"
                  % (client, date_dir.name, len(rows), baks[0].name if baks else "нет"))


# ---------------------------------------------------------------- D. validate до/после
def validate_counts(path: Path) -> dict:
    """Прогон snapshot_tool validate. Инструмент принимает только путь с расширением .csv,
    поэтому .bak-копию кладу рядом как временный .csv (read-only по отношению к снимкам)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(SCRIPTS))
    target = Path(path)
    temp = None
    if target.suffix.lower() != ".csv":
        temp_dir = WORK / "validate-tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp = temp_dir / (target.name.replace(".bak-", "-predate-") + ".csv")
        shutil.copyfile(target, temp)
        target = temp
    proc = subprocess.run([PY, str(SCRIPTS / "snapshot_tool.py"), "validate", str(target), "--quiet"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=env, cwd=str(PROJECT))
    text = (proc.stdout or "") + (proc.stderr or "")
    total = int((re.search(r"ОШИБКИ: (\d+),", text) or [None, "0"])[1]) if "ОШИБКИ:" in text else 0
    return {
        "exit": proc.returncode,
        "total": total,
        "delivery": len(re.findall(r"delivery=\S+ не в формате YYYY-QN", text)),
        "source_developer_sites": len(re.findall(r"source=developer-sites не из списка", text)),
        "rows_line": (re.search(r"строк с данными: (\d+)", text).group(1) if re.search(r"строк с данными: (\d+)", text) else
                      (re.search(r"строк с данными (\d+)", text).group(1) if re.search(r"строк с данными (\d+)", text) else "?")),
        "ok_line": bool(re.search(r"OK: строк с данными", text)),
    }


def section_d() -> None:
    print("D. Предсуществующие ошибки валидатора ДО и ПОСЛЕ переноса (одинаковые числа = не регресс F9):")
    table = {}
    compared = 0
    for client in ("client-svet", "client-granel"):
        for date_dir in sorted((DATA / client / "snapshots").iterdir()):
            cur = date_dir / "lots.csv"
            baks = sorted(date_dir.glob("lots.csv.bak-20261104-164726"))
            after = validate_counts(cur)
            before = validate_counts(baks[0]) if baks else None
            if before is not None:
                compared += 1
            table["%s:%s" % (client, date_dir.name)] = {"before": before, "after": after}
            print("     %-14s %s: до %s | после %s"
                  % (client, date_dir.name,
                     ("ошибок %d (delivery %d, source=developer-sites %d)" % (before["total"], before["delivery"], before["source_developer_sites"])) if before else "нет .bak переноса",
                     "ошибок %d (delivery %d, source=developer-sites %d)" % (after["total"], after["delivery"], after["source_developer_sites"])))
            if not baks:
                pre = sorted(date_dir.glob("lots.csv.bak-20261104-164648"))
                if pre:
                    info = validate_counts(pre[0])
                    print("        (информационно: %s — снимок ДО пересбора 11-04, другая выборка, не сравнение переноса: ошибок %d, delivery %d, source=developer-sites %d)"
                          % (pre[0].name, info["total"], info["delivery"], info["source_developer_sites"]))
    same = all((v["before"] is None or (v["before"]["total"], v["before"]["delivery"], v["before"]["source_developer_sites"])
                == (v["after"]["total"], v["after"]["delivery"], v["after"]["source_developer_sites"]))
               for v in table.values())
    check("D1. ошибки до и после переноса совпадают везде, где есть .bak переноса",
          same and compared >= 4, "сравнено дат с .bak переноса: %d из %d" % (compared, len(table)))
    SUMMARY["validate"] = table


# ---------------------------------------------------------------- main
def section_e() -> None:
    print("E. Общие прогоны (pytest, verify-data, аналитика «новые/ушедшие»):")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(SCRIPTS))
    proc = subprocess.run([PY, "-m", "pytest", str(PROJECT / "01-competitor-watch" / "tests"), "-q"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=env, cwd=str(PROJECT))
    tail = (proc.stdout or "").strip().splitlines()[-1] if (proc.stdout or "").strip() else ""
    check("E1. pytest: без падений", " failed" not in tail and proc.returncode == 0, tail[:110])
    try:
        doc = json.loads((PROJECT / "dashboard" / "public" / "data" / "competitor-analytics.json")
                         .read_text(encoding="utf-8"))
    except Exception as exc:                                  # noqa: BLE001
        check("E2. competitor-analytics.json читается", False, str(exc))
        return
    for client in ("client-svet", "client-granel"):
        cl = next((c for c in doc.get("clients", []) if c.get("clientId") == client), None)
        if not cl:
            continue
        new = sum(int(d.get("lotsNew") or 0) for d in cl.get("dynamics") or [])
        gone = sum(int(d.get("lotsGone") or 0) for d in cl.get("dynamics") or [])
        lots = cl.get("lotsOnSale")
        pair = SUMMARY.get("pairs", {}).get("%s:2026-11-03>2026-11-04" % client) or {}
        check("E2. %s: «новые/ушедшие» в аналитике не сотни и совпадают с моим замером" % client,
              new < (lots or 0) * 0.25 and gone < (lots or 0) * 0.25
              and new == pair.get("new") and gone == pair.get("gone"),
              "аналитика: новые %d / ушедшие %d, лотов %s | мой замер: новые %s / ушедшие %s"
              % (new, gone, lots, pair.get("new"), pair.get("gone")))
        SUMMARY.setdefault("analytics", {})[client] = {"lotsOnSale": lots, "new": new, "gone": gone}
    print("  verify-data.mjs выполняет Lead/приёмка; здесь проверяю только аналитику и pytest.")


def main() -> int:
    print("QA F9: независимая проверка стабильности ключа и переноса ключей")
    pairs: dict = {}
    SECTION_A = pairs
    section_a(pairs)
    SUMMARY["pairs"] = pairs
    # сверка с числами движка
    def pct(client, prev, curr):
        return (pairs.get("%s:%s>%s" % (client, prev, curr)) or {}).get("pct")
    check("A0. svet 11-03->11-04 = 90.26% и пересечение 139 (как заявил движок)",
          pct("client-svet", "2026-11-03", "2026-11-04") == 90.26
          and pairs["client-svet:2026-11-03>2026-11-04"]["common"] == 139,
          "получено %.2f%%, common %s" % (pct("client-svet", "2026-11-03", "2026-11-04") or -1,
                                          pairs["client-svet:2026-11-03>2026-11-04"]["common"]))
    check("A0b. granel 11-03->11-04 = 89.96% и пересечение 206",
          pct("client-granel", "2026-11-03", "2026-11-04") == 89.96
          and pairs["client-granel:2026-11-03>2026-11-04"]["common"] == 206,
          "получено %.2f%%, common %s" % (pct("client-granel", "2026-11-03", "2026-11-04") or -1,
                                          pairs["client-granel:2026-11-03>2026-11-04"]["common"]))
    for key, pair in pairs.items():
        check("A. %s: у всех ушедших нет аналога по подписи (или излишек-дубль), подозрительных нет" % key,
              pair["suspicious"] == 0,
              "реально ушли %d, дубли-излишек %d, подозрительных %d" % (pair["real_gone"], pair["dup_surplus"], pair["suspicious"]))
        if pair["curr"] == "2026-11-04":
            check("A. %s: в пересобранном снимке url заполнен ровно у ступеней n/u (c- без url)" % key,
                  pair["n_or_u_without_url"] == 0 and pair["c_step_with_url"] == 0,
                  "n/u без url: %d, c- с url: %d" % (pair["n_or_u_without_url"], pair["c_step_with_url"]))
        else:
            check("A. %s: старый снимок url не выдумывает (все пустые, как было до F9)" % key,
                  pair["url_curr"].get("filled", 0) == 0,
                  "url в %s: %s" % (pair["curr"], pair["url_curr"]))
    section_a2(pairs)
    section_a3()
    section_b()
    section_b9()
    section_c()
    section_d()
    section_e()

    print("")
    print("Итог: OK %d, ПРОВАЛ %d" % (OK, FAIL))
    (WORK / "summary.json").parent.mkdir(parents=True, exist_ok=True)
    (WORK / "summary.json").write_text(json.dumps(SUMMARY, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Сводка: %s" % (WORK / "summary.json"))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
