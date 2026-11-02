#!/usr/bin/env python3
r"""Tests for sources_tool.py / log_source_run.py / the weekly sources step (T18).

Everything runs on temporary copies: the real registry/sources.yaml, the real
data/source-runs.jsonl and the real snapshots are never modified.

Run:
    <python> -m unittest discover -s marketing-agents\01-competitor-watch\tests -v
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
# Тесты работают на СВОЕЙ фикстуре источников: боевой registry/sources.yaml
# правит пользователь и другие агенты, поэтому его содержимое здесь не проверяем.
REGISTRY_SOURCES = TESTS_DIR / "fixtures" / "sources.yaml"
LIVE_SOURCES = PROJECT_DIR.parent / "registry" / "sources.yaml"
CURR_FIXTURE = TESTS_DIR / "fixtures" / "week-2026-10-30" / "lots.csv"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import cwlib as cw            # noqa: E402
import log_source_run         # noqa: E402
import sources_tool           # noqa: E402


def run_cli(script, *args, cwd=None):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(SCRIPTS_DIR)
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)] + [str(arg) for arg in args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(cwd or PROJECT_DIR),
    )


def run_ps1(args, cwd=None):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["CW_PYTHON"] = sys.executable
    return subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         str(SCRIPTS_DIR / "run_weekly.ps1")] + [str(arg) for arg in args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(cwd or PROJECT_DIR),
    )


class SourcesToolTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-sources-test-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh_sources(self, name="sources.yaml"):
        target = self.tmp / name
        shutil.copy2(REGISTRY_SOURCES, target)
        return target

    # ---- list / status -------------------------------------------------

    def test_01_list_json_and_table(self):
        path = self.fresh_sources("list.yaml")
        proc = run_cli("sources_tool.py", "--sources-file", path, "list", "--json")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        data = json.loads(proc.stdout)
        ids = [item["id"] for item in data]
        self.assertIn("developer-sites", ids)
        self.assertIn("manual-inbox", ids)
        entry = [item for item in data if item["id"] == "developer-sites"][0]
        self.assertTrue(entry["enabled"])
        self.assertEqual(entry["status"], "partial")
        self.assertEqual(entry["last_run"], "2026-10-31")

        table = run_cli("sources_tool.py", "--sources-file", path, "list")
        self.assertEqual(table.returncode, 0)
        self.assertIn("developer-sites", table.stdout)
        self.assertIn("Всего источников: 3", table.stdout)

        enabled_only = run_cli("sources_tool.py", "--sources-file", path, "list", "--json", "--enabled-only")
        enabled_ids = [item["id"] for item in json.loads(enabled_only.stdout)]
        self.assertEqual(sorted(enabled_ids), ["developer-sites", "manual-inbox"])

    def test_01b_live_registry_is_readable(self):
        """Реальный registry/sources.yaml просто читается (его содержимое меняют люди)."""
        if not LIVE_SOURCES.exists():
            self.skipTest("реестр источников недоступен")
        sources = sources_tool.read_sources(LIVE_SOURCES)
        self.assertGreaterEqual(len(sources), 4)
        for item in sources:
            self.assertTrue(item.get("id"))
        listed = run_cli("sources_tool.py", "--sources-file", LIVE_SOURCES, "list", "--json")
        self.assertEqual(listed.returncode, 0, listed.stdout + listed.stderr)
        self.assertGreaterEqual(len(json.loads(listed.stdout)), 4)

    def test_02_status_unknown_id_is_error(self):
        path = self.fresh_sources("status.yaml")
        ok = run_cli("sources_tool.py", "--sources-file", path, "status", "cian")
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        self.assertIn("Циан", ok.stdout)
        bad = run_cli("sources_tool.py", "--sources-file", path, "status", "nope")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("неизвестный источник", bad.stderr)

    # ---- enable / disable ---------------------------------------------

    def test_03_toggle_changes_only_the_enabled_field(self):
        path = self.fresh_sources("toggle.yaml")
        before = path.read_text(encoding="utf-8")

        proc = run_cli("sources_tool.py", "--sources-file", path, "disable", "developer-sites")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        after = path.read_text(encoding="utf-8")
        self.assertEqual(len(before.splitlines()), len(after.splitlines()), "число строк изменилось")

        changed = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
        self.assertEqual(len(changed), 1, "должна измениться ровно одна строка: %s" % changed)
        self.assertEqual(changed[0][0].strip(), "enabled: true")
        self.assertEqual(changed[0][1].strip(), "enabled: false")
        # комментарии, порядок и прочие поля на месте
        for marker in ("# http | browser | feed | manual", "# Фикстура источников для тестов",
                       "  - id: developer-sites", "  - id: manual-inbox", "    note: "):
            self.assertIn(marker, after)
        self.assertTrue(after.startswith(before.splitlines()[0]))

    def test_04_toggle_is_idempotent_and_creates_one_backup(self):
        path = self.fresh_sources("idempotent.yaml")
        # cian в контракте выключен -> первый enable действительно меняет файл
        first = run_cli("sources_tool.py", "--sources-file", path, "enable", "cian")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("было: выкл", first.stdout)
        hash_after_first = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(len(sorted(path.parent.glob(path.name + ".bak-*"))), 1)

        second = run_cli("sources_tool.py", "--sources-file", path, "enable", "cian")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("уже включён", second.stdout)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), hash_after_first)
        self.assertEqual(len(sorted(path.parent.glob(path.name + ".bak-*"))), 1)

        disable = run_cli("sources_tool.py", "--sources-file", path, "disable", "cian")
        self.assertEqual(disable.returncode, 0, disable.stdout + disable.stderr)
        self.assertIn("было: вкл", disable.stdout)
        data = json.loads(run_cli("sources_tool.py", "--sources-file", path, "list", "--json").stdout)
        self.assertFalse([item for item in data if item["id"] == "cian"][0]["enabled"])

    def test_05_backup_keeps_previous_content(self):
        path = self.fresh_sources("backup.yaml")
        before = path.read_bytes()
        run_cli("sources_tool.py", "--sources-file", path, "disable", "developer-sites")
        backups = sorted(path.parent.glob(path.name + ".bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)

    def test_06_unknown_id_returns_one(self):
        path = self.fresh_sources("unknown.yaml")
        before = path.read_bytes()
        proc = run_cli("sources_tool.py", "--sources-file", path, "disable", "no-such-source")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("неизвестный источник", proc.stderr)
        self.assertEqual(path.read_bytes(), before, "файл не должен меняться")
        self.assertEqual(list(path.parent.glob(path.name + ".bak-*")), [])

    def test_07_record_keeps_inline_comment(self):
        path = self.fresh_sources("record.yaml")
        proc = run_cli("sources_tool.py", "--sources-file", path, "record", "developer-sites",
                       "--status", "ok", "--last-run", "2026-11-07")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        text = path.read_text(encoding="utf-8")
        self.assertIn("status: working       # working | partial | blocked | paused | not-tested", text)
        self.assertIn('last_run: "2026-11-07"', text)
        # число источников и все поля сохранились
        self.assertEqual(len(cw.parse_simple_yaml(path)["sources"]), 3)

    def test_08_missing_sources_file_is_exit_two(self):
        proc = run_cli("sources_tool.py", "--sources-file", self.tmp / "nope.yaml", "list")
        self.assertEqual(proc.returncode, 2)


class SourceRunLogTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-runlog-test-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_10_append_creates_file_and_parses(self):
        path = self.tmp / "nested" / "runs.jsonl"
        proc = run_cli("log_source_run.py", "--file", path, "--source", "developer-sites",
                       "--status", "ok", "--lots", "15", "--projects", "1", "--note", "тест")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue(path.exists())
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 1)
        entry = json.loads(lines[0])
        self.assertEqual(set(entry.keys()), {"ts", "source", "status", "lots", "projects", "note"})
        self.assertEqual(entry["source"], "developer-sites")
        self.assertEqual(entry["lots"], 15)
        self.assertEqual(entry["note"], "тест")
        self.assertIsInstance(entry["ts"], str)

    def test_11_missing_file_is_not_an_error(self):
        path = self.tmp / "absent" / "fresh.jsonl"
        self.assertFalse(path.exists())
        proc = run_cli("log_source_run.py", "--file", path, "--source", "avito", "--status", "empty",
                       "--lots", "0", "--projects", "0")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue(path.exists())

    def test_12_invalid_status_is_exit_one(self):
        path = self.tmp / "bad.jsonl"
        proc = run_cli("log_source_run.py", "--file", path, "--source", "cian", "--status", "wrong")
        self.assertEqual(proc.returncode, 1)
        self.assertFalse(path.exists())

    def test_13_parallel_appends_do_not_interleave(self):
        path = self.tmp / "parallel.jsonl"
        workers = [sys.executable, str(SCRIPTS_DIR / "log_source_run.py"), "--file", str(path),
                   "--source", "X", "--status", "ok", "--lots", "1"]
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        procs = []
        for index in range(12):
            procs.append(subprocess.Popen(workers, env=env,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            if index % 3 == 2:
                time.sleep(0.01)      # небольшая раскачка: записи всё равно перекрываются
        codes = [proc.wait() for proc in procs]
        self.assertEqual(codes, [0] * 12, "часть процессов записи журнала упала: %s" % codes)
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(lines), 12)
        for line in lines:
            json.loads(line)          # каждая строка — целый JSON
        self.assertEqual({json.loads(line)["source"] for line in lines}, {"X"})

    def test_14_tail_reads_last_entries(self):
        path = self.tmp / "tail.jsonl"
        for index in range(3):
            run_cli("log_source_run.py", "--file", path, "--source", "s%d" % index, "--status", "ok")
        proc = run_cli("log_source_run.py", "--file", path, "--tail", "2", "--json")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual([item["source"] for item in data], ["s1", "s2"])


class WeeklySourcesStepTestCase(unittest.TestCase):
    """The acceptance scenario: the toggle really changes the journal and last_run."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cw-cycle-test-"))
        cls.snapshots = cls.tmp / "snapshots"
        (cls.snapshots / "2026-11-07").mkdir(parents=True, exist_ok=True)
        header = ",".join(cw.COLUMNS)
        rows = [
            "2026-11-07,site,ПИК,Саларьево,L-1,https://x/1,2,56,8,24,К1,18000000,321429,чистовая,0,,2027-Q2,active",
            "2026-11-07,site,ПИК,Саларьево,L-2,https://x/2,1,38,12,24,К1,12000000,315789,white box,0,,2027-Q2,active",
            "2026-11-07,cian,Донстрой,Символ,M-1,https://x/3,3,78,5,17,К5,23000000,294872,чистовая,0,,2026-Q4,active",
        ]
        (cls.snapshots / "2026-11-07" / "lots.csv").write_text(
            header + "\n" + "\n".join(rows) + "\n", encoding="utf-8-sig")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _cycle(self, sources_path, runs_path, tag):
        return run_cli("sources_tool.py", "--sources-file", sources_path, "run-cycle",
                       "--date", "2026-11-07", "--snapshots-dir", self.snapshots,
                       "--runs-file", runs_path)

    @staticmethod
    def _entries(path):
        if not Path(path).exists():
            return []
        return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]

    def test_20_disabled_source_is_skipped_then_enabled_is_logged(self):
        sources = self.tmp / "cycle.yaml"
        shutil.copy2(REGISTRY_SOURCES, sources)
        runs = self.tmp / "cycle.jsonl"

        # 1. выключаем developer-sites -> прогон -> записи нет, last_run не менялся
        run_cli("sources_tool.py", "--sources-file", sources, "disable", "developer-sites")
        last_run_before = self._last_run(sources, "developer-sites")
        cycle = self._cycle(sources, runs, "off")
        self.assertEqual(cycle.returncode, 0, cycle.stdout + cycle.stderr)
        entries = self._entries(runs)
        self.assertNotIn("developer-sites", [entry["source"] for entry in entries])
        self.assertEqual(self._last_run(sources, "developer-sites"), last_run_before)
        self.assertIn("developer-sites", cycle.stdout)     # в отчёте показан как пропущенный
        self.assertIn("пропущен (enabled: false)", cycle.stdout)

        # 2. включаем -> прогон -> запись есть, last_run обновлён
        run_cli("sources_tool.py", "--sources-file", sources, "enable", "developer-sites")
        cycle_on = self._cycle(sources, runs, "on")
        self.assertEqual(cycle_on.returncode, 0, cycle_on.stdout + cycle_on.stderr)
        entries = self._entries(runs)
        developer = [entry for entry in entries if entry["source"] == "developer-sites"]
        self.assertEqual(len(developer), 1)
        self.assertEqual(developer[0]["status"], "ok")
        self.assertEqual(developer[0]["lots"], 2)
        self.assertEqual(developer[0]["projects"], 1)
        self.assertEqual(self._last_run(sources, "developer-sites"), "2026-11-07")
        # журнал накопительный: первый прогон дал manual-inbox, второй — developer-sites + manual-inbox
        self.assertEqual([entry["source"] for entry in entries].count("developer-sites"), 1)
        self.assertEqual([entry["source"] for entry in entries].count("manual-inbox"), 2)
        self.assertEqual(len(entries), 3)

    def test_21_manual_source_waits_for_materials(self):
        sources = self.tmp / "manual.yaml"
        shutil.copy2(REGISTRY_SOURCES, sources)
        runs = self.tmp / "manual.jsonl"
        cycle = self._cycle(sources, runs, "manual")
        self.assertEqual(cycle.returncode, 0, cycle.stdout + cycle.stderr)
        entry = [item for item in self._entries(runs) if item["source"] == "manual-inbox"][0]
        self.assertEqual(entry["status"], "empty")
        self.assertEqual(entry["note"], "ждём материалы")

    def test_22_missing_snapshot_is_blocked(self):
        sources = self.tmp / "blocked.yaml"
        shutil.copy2(REGISTRY_SOURCES, sources)
        runs = self.tmp / "blocked.jsonl"
        proc = run_cli("sources_tool.py", "--sources-file", sources, "run-cycle",
                       "--date", "2020-01-01", "--snapshots-dir", self.snapshots, "--runs-file", runs)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        statuses = {entry["source"]: entry["status"] for entry in self._entries(runs)}
        self.assertEqual(statuses["developer-sites"], "blocked")

    def test_23_run_cycle_json_mode(self):
        sources = self.tmp / "json.yaml"
        shutil.copy2(REGISTRY_SOURCES, sources)
        runs = self.tmp / "json.jsonl"
        proc = run_cli("sources_tool.py", "--sources-file", sources, "run-cycle",
                       "--date", "2026-11-07", "--snapshots-dir", self.snapshots,
                       "--runs-file", runs, "--json")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["date"], "2026-11-07")
        self.assertIn("developer-sites", payload["enabled"])
        self.assertIn("cian", payload["skipped"])

    @staticmethod
    def _last_run(sources_path, source_id):
        for item in cw.parse_simple_yaml(sources_path)["sources"]:
            if str(item.get("id")) == source_id:
                return item.get("last_run")
        return None

    # ---- integration with run_weekly.ps1 -------------------------------

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell")
    def test_24_run_weekly_ps1_skips_disabled_and_updates_last_run(self):
        sources = self.tmp / "weekly.yaml"
        shutil.copy2(REGISTRY_SOURCES, sources)
        runs = self.tmp / "weekly.jsonl"
        reports = self.tmp / "reports"

        run_cli("sources_tool.py", "--sources-file", sources, "disable", "developer-sites")
        proc = run_ps1(["-Date", "2026-11-07", "-SnapshotsDir", self.snapshots, "-ReportsDir", reports,
                        "-SourcesFile", sources, "-RunsFile", runs])
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        self.assertIn("источники (тумблеры, журнал прогона)", output)
        entries = self._entries(runs)
        self.assertNotIn("developer-sites", [entry["source"] for entry in entries])
        self.assertEqual(self._last_run(sources, "developer-sites"), "2026-10-31")
        self.assertTrue((reports / "2026-11-07-competitor-watch.md").exists())

        run_cli("sources_tool.py", "--sources-file", sources, "enable", "developer-sites")
        proc_on = run_ps1(["-Date", "2026-11-07", "-SnapshotsDir", self.snapshots, "-ReportsDir", reports,
                           "-SourcesFile", sources, "-RunsFile", runs])
        self.assertEqual(proc_on.returncode, 0, proc_on.stdout + proc_on.stderr)
        sources_logged = [entry["source"] for entry in self._entries(runs)]
        self.assertIn("developer-sites", sources_logged)
        self.assertEqual(self._last_run(sources, "developer-sites"), "2026-11-07")

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell")
    def test_25_run_weekly_ps1_can_skip_the_step(self):
        sources = self.tmp / "skipped.yaml"
        shutil.copy2(REGISTRY_SOURCES, sources)
        runs = self.tmp / "skipped.jsonl"
        before = sources.read_bytes()
        proc = run_ps1(["-Date", "2026-11-07", "-SnapshotsDir", self.snapshots,
                        "-ReportsDir", self.tmp / "reports-skip",
                        "-SourcesFile", sources, "-RunsFile", runs, "-SkipSources"])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("Шаг источников пропущен", proc.stdout)
        self.assertFalse(Path(runs).exists())
        self.assertEqual(sources.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
