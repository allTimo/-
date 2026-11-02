#!/usr/bin/env python3
r"""Tests for registry/intake (stdlib unittest, no pytest).

Run from the workspace root:
    <python> -m unittest discover -s marketing-agents\registry\intake\tests -v
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
INTAKE_DIR = TESTS_DIR.parent
SCRIPTS_DIR = INTAKE_DIR / "scripts"
REGISTRY_DIR = INTAKE_DIR.parent
FIXTURE = TESTS_DIR / "fixture-transcript-2026-10-31.txt"
SAMPLES = TESTS_DIR / "samples"
EXPECTED_OWNERS = ["agent-1-competitor-watch", "agent-2-direct-semantics", "agent-1-competitor-watch"]

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import text_to_tasks as t3  # noqa: E402

USER_HOME = Path(os.environ.get("USERPROFILE") or Path.home())
NODE = USER_HOME / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe"
JS_YAML = USER_HOME / ".dsh" / "profiles" / "desktop" / "node_modules" / "js-yaml" / "index.js"


def run_tool(*args, tasks_dir, date="2026-10-31"):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(SCRIPTS_DIR)
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "text_to_tasks.py"),
         "--registry-dir", str(REGISTRY_DIR), "--tasks-dir", str(tasks_dir), "--date", date]
        + [str(arg) for arg in args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )


def run_powershell(script, *args):
    return subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPTS_DIR / script),
         *[str(arg) for arg in args]],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "CW_PYTHON": sys.executable},
    )


def parse_yaml_with_node(path):
    """Independent check: node + js-yaml (shipped with DSH) parses the month file."""
    code = ("const y=require(process.argv[1]),fs=require('fs');"
            "const d=y.load(fs.readFileSync(process.argv[2],'utf8'));"
            "console.log(JSON.stringify({list:Array.isArray(d),count:d.length,"
            "ids:d.map(t=>t.id),owners:d.map(t=>t.owner),statuses:d.map(t=>t.status)}));")
    return subprocess.run([str(NODE), "-e", code, str(JS_YAML), str(path)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


class TextToTasksTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="intake-test-"))
        cls.tasks_dir = cls.tmp / "tasks"
        cls.proc = run_tool("--input", FIXTURE, tasks_dir=cls.tasks_dir)
        cls.month_file = cls.tasks_dir / "2026-10.yaml"
        cls.tasks = t3.parse_yaml_file(cls.month_file)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_01_fixture_produces_exactly_three_tasks(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stdout + self.proc.stderr)
        self.assertIn("Задач создано: 3", self.proc.stdout)
        self.assertEqual(len(self.tasks), 3)
        self.assertEqual([task["id"] for task in self.tasks], ["T-1", "T-2", "T-3"])
        self.assertEqual(self.tasks[0]["subject"], "Проверить новые акции у Селигер Сити, там обещают скидку")
        # the two non-tasks and the negated phrase must not become tasks
        subjects = " ".join(task["subject"] for task in self.tasks)
        self.assertNotIn("бюджет", subjects)
        self.assertNotIn("баннер", subjects)
        self.assertNotIn("Креативы", subjects)

    def test_02_owners_come_from_agents_yaml(self):
        self.assertEqual([task["owner"] for task in self.tasks], EXPECTED_OWNERS)
        known = {agent["id"] for agent in t3.load_agents()}
        for task in self.tasks:
            self.assertIn(task["owner"], known)
        owners = t3.group_owner_map(t3.load_agents())
        self.assertEqual(owners["Конкуренты"], "agent-1-competitor-watch")
        self.assertEqual(owners["Семантика"], "agent-2-direct-semantics")
        self.assertEqual(self.tasks[0]["group"], "Конкуренты")
        self.assertEqual(self.tasks[1]["group"], "Семантика")

    def test_03_month_file_is_valid_yaml(self):
        self.assertTrue(self.month_file.exists())
        if not (NODE.exists() and JS_YAML.exists()):
            self.skipTest("node + js-yaml недоступны для независимой проверки YAML")
        parsed = parse_yaml_with_node(self.month_file)
        self.assertEqual(parsed.returncode, 0, parsed.stderr)
        data = __import__("json").loads(parsed.stdout)
        self.assertTrue(data["list"])
        self.assertEqual(data["count"], 3)
        self.assertEqual(data["ids"], ["T-1", "T-2", "T-3"])
        self.assertEqual(data["owners"], EXPECTED_OWNERS)
        self.assertEqual(data["statuses"], ["new", "new", "new"])

    def test_04_fields_follow_registry_schema(self):
        required = {"id", "subject", "group", "category", "owner", "status", "project",
                    "due", "source", "created", "quote"}
        for task in self.tasks:
            self.assertTrue(required.issubset(task.keys()), "нет полей: %s" % (required - set(task)))
            self.assertTrue(task["quote"])
            self.assertEqual(task["source"], "telemost-text")
            self.assertEqual(task["created"], "2026-10-31")
        self.assertEqual(self.tasks[1]["due"], "2026-11-05")     # «до 5 ноября»
        self.assertEqual(self.tasks[1]["project"], "my-zhk-svet")  # «ЖК Свет»
        self.assertEqual(self.tasks[0]["due"], "")
        self.assertEqual(self.tasks[0]["category"], "Акции")
        self.assertEqual(self.tasks[2]["category"], "Цены")

    def test_05_rerun_does_not_duplicate(self):
        again = run_tool("--input", FIXTURE, tasks_dir=self.tasks_dir)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("Задач создано: 0", again.stdout)
        self.assertIn("Пропущено: 3", again.stdout)
        self.assertEqual(len(t3.parse_yaml_file(self.month_file)), 3)

    def test_06_unassigned_goes_to_clarification_block(self):
        tasks_dir = self.tmp / "unassigned"
        proc = run_tool("--input", SAMPLES / "unassigned.txt", tasks_dir=tasks_dir)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("Требуют уточнения (status: unassigned): 1", proc.stdout)
        text = (tasks_dir / "2026-10.yaml").read_text(encoding="utf-8")
        self.assertIn("ТРЕБУЕТ УТОЧНЕНИЯ", text)
        self.assertIn("не найден владелец", text)
        task = t3.parse_yaml_file(tasks_dir / "2026-10.yaml")[0]
        self.assertEqual(task["status"], "unassigned")
        self.assertEqual(task["group"], "unassigned")
        self.assertEqual(task["owner"], "")
        if NODE.exists() and JS_YAML.exists():
            parsed = parse_yaml_with_node(tasks_dir / "2026-10.yaml")
            self.assertEqual(__import__("json").loads(parsed.stdout)["statuses"], ["unassigned"])

    def test_07_russian_due_dates(self):
        tasks_dir = self.tmp / "due"
        proc = run_tool("--input", SAMPLES / "due-dates.txt", tasks_dir=tasks_dir, date="2026-11-02")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        task = t3.parse_yaml_file(tasks_dir / "2026-11.yaml")[0]
        self.assertEqual(task["due"], "2026-11-06")   # понедельник 2026-11-02 -> пятница
        self.assertEqual(t3.parse_due("сделать завтра", __import__("datetime").date(2026, 11, 2)), "2026-11-03")
        self.assertEqual(t3.parse_due("до конца месяца", __import__("datetime").date(2026, 11, 2)), "2026-11-30")
        self.assertEqual(t3.parse_due("без срока", __import__("datetime").date(2026, 11, 2)), "")

    def test_08_voice_suffix_switches_source(self):
        tasks_dir = self.tmp / "voice"
        proc = run_tool("--input", SAMPLES / "meeting.voice.txt", tasks_dir=tasks_dir)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        task = t3.parse_yaml_file(tasks_dir / "2026-10.yaml")[0]
        self.assertEqual(task["source"], "telemost-voice")

    def test_09_missing_input_is_an_error(self):
        proc = run_tool("--input", self.tmp / "no-such-file.txt", tasks_dir=self.tmp / "missing")
        self.assertEqual(proc.returncode, 1)

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell")
    def test_10_run_intake_end_to_end_returns_zero(self):
        tasks_dir = self.tmp / "run-intake"
        proc = run_powershell("run_intake.ps1", "-Date", "2026-10-31",
                              "-InputDir", TESTS_DIR, "-TasksDir", tasks_dir, "-NoTranscribe")
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        self.assertIn("задач создано: 3", output)
        self.assertTrue((tasks_dir / "2026-10.yaml").exists())
        self.assertEqual(len(t3.parse_yaml_file(tasks_dir / "2026-10.yaml")), 3)

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell")
    def test_11_transcribe_check_reports_engine_facts(self):
        proc = run_powershell("transcribe.ps1", "-Check")
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        self.assertIn("auto, zh, en, yue, ja, ko", output)
        self.assertIn("Windows Speech recognizers", output)

    @unittest.skipUnless(shutil.which("powershell"), "нужен powershell")
    def test_12_external_asr_hook_works(self):
        """The documented workaround: an external ASR command prints the transcript to stdout."""
        audio_dir = self.tmp / "audio"
        text_dir = self.tmp / "text"
        audio_dir.mkdir(parents=True, exist_ok=True)
        text_dir.mkdir(parents=True, exist_ok=True)
        (audio_dir / "meeting.wav").write_bytes(b"RIFF0000WAVEfmt ")
        # External ASR stands in as a tiny python script: it prints Russian text to stdout.
        stub = self.tmp / "asr_stub.py"
        stub.write_text('import sys\nprint("Надо проверить акции у Донстроя.")\n', encoding="utf-8")
        command = '"%s" "%s" {file}' % (sys.executable, stub)
        proc = run_powershell("transcribe.ps1", "-AudioDir", audio_dir, "-TextDir", text_dir,
                              "-Command", command)
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        written = text_dir / "meeting.voice.txt"
        self.assertTrue(written.exists(), output)
        self.assertIn("Донстроя", written.read_text(encoding="utf-8"))
        # ... and the produced text is picked up by text_to_tasks
        tasks_dir = self.tmp / "asr-tasks"
        tasks = run_tool("--input", text_dir, tasks_dir=tasks_dir)
        self.assertEqual(tasks.returncode, 0, tasks.stdout + tasks.stderr)
        task = t3.parse_yaml_file(tasks_dir / "2026-10.yaml")[0]
        self.assertEqual(task["source"], "telemost-voice")
        self.assertEqual(task["owner"], "agent-1-competitor-watch")


if __name__ == "__main__":
    unittest.main(verbosity=2)
