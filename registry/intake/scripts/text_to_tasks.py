#!/usr/bin/env python3
r"""text_to_tasks.py - turn Russian meeting transcripts into registry tasks.

Reads a transcript (or a folder of transcripts) and appends tasks to
marketing-agents/registry/tasks/<YYYY-MM>.yaml following the schema documented in
marketing-agents/registry/README.md. Task owners come from registry/agents.yaml,
projects from registry/projects.yaml.

Rules (deterministic, no LLM):
  * only phrases that really contain a task marker become tasks - nothing is invented;
  * a phrase with no recognised owner gets group: unassigned, status: unassigned and is
    repeated in the trailing "ТРЕБУЕТ УТОЧНЕНИЯ" block at the end of the month file;
  * duplicates (same subject already in the month file) are skipped.

Usage:
    python text_to_tasks.py --input inbox/text --source telemost-text
    python text_to_tasks.py --input transcript.txt --dry-run --print

Exit codes: 0 - ok, 1 - input problem, 2 - registry problem.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
INTAKE_DIR = SCRIPT_DIR.parent
REGISTRY_DIR = INTAKE_DIR.parent
TASKS_DIR = REGISTRY_DIR / "tasks"
AGENTS_FILE = REGISTRY_DIR / "agents.yaml"
PROJECTS_FILE = REGISTRY_DIR / "projects.yaml"

SOURCE_VALUES = ("telemost-voice", "telemost-text", "manual", "agent")
TEXT_SUFFIXES = (".txt", ".md", ".text")
MONTH_HEADER = "# Задачи за %s. Формат элемента: marketing-agents/registry/README.md"
GENERATED_BY = "# Файл собран автоматически: registry/intake/scripts/text_to_tasks.py"
CLARIFY_HEADER = "ТРЕБУЕТ УТОЧНЕНИЯ (status: unassigned) — разбирает человек"

# A phrase becomes a task only when it carries one of these markers.
TASK_MARKERS = (
    "надо", "нужно", "необходимо", "требуется", "сделай", "сделать", "проверь", "проверить",
    "подготовь", "подготовить", "собери", "собрать", "запроси", "запросить", "настрой",
    "настроить", "добавь", "добавить", "обнови", "обновить", "посмотри", "посмотреть",
    "посчитай", "посчитать", "запусти", "запустить", "напиши", "написать", "уточни",
    "уточнить", "согласуй", "согласовать", "разберись", "разобраться", "поставь",
    "поставить", "проконтролируй", "проконтролировать", "договорись", "договориться",
    "выясни", "выяснить", "скинь", "скинуть", "подключи", "подключить", "передай",
    "передать", "заполни", "заполнить", "сверь", "сверить", "пересчитай", "пересчитать",
)
# Phrases with these markers are not tasks.
NEGATIVE_MARKERS = (
    "не надо", "не нужно", "не будем", "не трогаем", "не срочно", "не требуется",
    "отложили", "отложим", "решили не", "не делаем", "пока не",
)
# stem -> (category, group); first match wins.
CATEGORY_RULES = (
    (("акци", "скидк", "промо", "распродаж", "спецпредлож"), "Акции", "Конкуренты"),
    (("цен", "прайс", "подешев", "подорож", "стоимост"), "Цены", "Конкуренты"),
    (("снимок", "лот", "предложени", "мониторинг", "выгрузк", "конкурент", "застройщик"),
     "Предложение", "Конкуренты"),
    (("семантик", "ключев", "кластер", "минус-слов", "минусовк", "поисковых фраз"),
     "Семантика", "Семантика"),
    (("объявлени", "заголовк", "утп", "быстрые ссылки"), "Объявления", "Директ"),
    (("кампани", "группы объявлений", "директ"), "Кампании", "Директ"),
    (("бюджет", "ставк", "расход"), "Бюджет", "Директ"),
    (("баннер", "креатив", "макет", "дизайн", "график", "картинк", "обложк"), "Креативы", "Креативы"),
    (("аналитик", "конверси", "cpl", "cpa", "метрик", "сводк", "эффективност"), "Аналитика", "Аналитика"),
)
WEEKDAYS = (("понедельник", 0), ("вторник", 1), ("сред", 2), ("четверг", 3),
            ("пятниц", 4), ("суббот", 5), ("воскресен", 6))
MONTHS = (("январ", 1), ("феврал", 2), ("март", 3), ("апрел", 4), ("май", 5), ("мая", 5),
          ("июн", 6), ("июл", 7), ("август", 8), ("сентябр", 9), ("октябр", 10),
          ("ноябр", 11), ("декабр", 12))
DATE_DOTTED = re.compile(r"([0-9]{1,2})\.([0-9]{1,2})(?:\.([0-9]{4}))?")
DATE_DAY_MONTH = re.compile(r"([0-9]{1,2})\s+([а-яё]+)")
WEEKDAY_NAMES = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")
FILLER_PREFIXES = ("надо", "нужно", "необходимо", "требуется", "давай", "давайте", "ещё", "еще")


def setup_console():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# --------------------------------------------------------------------------
# tiny YAML reader for the registry files (no PyYAML in the runtime)
# --------------------------------------------------------------------------

def _strip_comment(text):
    out, quote = [], None
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


def _scalar(text):
    text = text.strip()
    if not text:
        return None
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        return [_scalar(part) for part in inner.split(",")] if inner else []
    if len(text) >= 2 and text[0] in "\"'" and text[-1] == text[0]:
        return text[1:-1]
    low = text.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "~", "none", '""'):
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


def _is_entry(text):
    key, sep, _ = text.partition(":")
    return bool(sep) and bool(re.match(r"^[A-Za-z_][A-Za-z0-9_-]*$", key.strip()))


def _parse_block(lines, index, indent):
    if index >= len(lines):
        return {}, index
    if lines[index][1].startswith("- "):
        items = []
        while index < len(lines) and lines[index][0] == indent and lines[index][1].startswith("- "):
            content = lines[index][1][2:].strip()
            index += 1
            if _is_entry(content):
                key, _, rest = content.partition(":")
                item = {key.strip(): _scalar(rest.strip()) if rest.strip() else None}
                if index < len(lines) and lines[index][0] > indent:
                    deeper, index = _parse_block(lines, index, lines[index][0])
                    if isinstance(deeper, dict):
                        item.update(deeper)
                items.append(item)
            else:
                items.append(_scalar(content))
        return items, index
    mapping = {}
    while index < len(lines) and lines[index][0] == indent and not lines[index][1].startswith("- "):
        key, _, rest = lines[index][1].partition(":")
        key, rest = key.strip(), rest.strip()
        if rest:
            mapping[key] = _scalar(rest)
            index += 1
        else:
            child = lines[index + 1][0] if index + 1 < len(lines) else indent
            mapping[key], index = _parse_block(lines, index + 1, child)
    return mapping, index


def parse_yaml_text(text):
    lines = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        content = _strip_comment(raw)
        if content:
            lines.append((len(raw) - len(raw.lstrip(" ")), content))
    if not lines:
        return []
    value, _ = _parse_block(lines, 0, lines[0][0])
    return value


def parse_yaml_file(path):
    return parse_yaml_text(Path(path).read_text(encoding="utf-8-sig"))


def load_agents(path=AGENTS_FILE):
    data = parse_yaml_file(path)
    agents = []
    for item in (data.get("agents") if isinstance(data, dict) else None) or []:
        if isinstance(item, dict) and item.get("id"):
            agents.append({
                "id": str(item["id"]),
                "name": str(item.get("name") or ""),
                "groups": [str(group) for group in (item.get("groups") or [])],
                "enabled": bool(item.get("enabled")),
            })
    return agents


def load_projects(path=PROJECTS_FILE):
    data = parse_yaml_file(path)
    projects = []
    for item in (data.get("projects") if isinstance(data, dict) else None) or []:
        if isinstance(item, dict) and item.get("id"):
            projects.append({"id": str(item["id"]), "name": str(item.get("name") or "")})
    return projects


def group_owner_map(agents):
    """group name -> agent id (enabled agents win)."""
    mapping = {}
    for agent in agents:
        for group in agent["groups"]:
            if group not in mapping or agent["enabled"]:
                mapping[group] = agent["id"]
    return mapping


# --------------------------------------------------------------------------
# transcript parsing
# --------------------------------------------------------------------------

def split_phrases(text):
    """Split a transcript into phrases, keeping the original wording for quotes."""
    phrases = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^[-*•]\s+", "", line)
        line = re.sub(r"^[0-9]+[.)]\s+", "", line)
        for part in re.split(r"(?<=[.!?])\s+", line):
            part = part.strip()
            if part:
                phrases.append(part)
    return phrases


def is_task_phrase(phrase):
    low = phrase.lower()
    if any(marker in low for marker in NEGATIVE_MARKERS):
        return False
    return any(marker in low for marker in TASK_MARKERS)


def make_subject(phrase):
    text = phrase.strip().rstrip(".")
    low = text.lower()
    for prefix in FILLER_PREFIXES:
        if low.startswith(prefix + " "):
            text = text[len(prefix):].strip()
            low = text.lower()
            break
    text = re.sub(r"\s+", " ", text)
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    if len(text) > 140:
        text = text[:137].rstrip() + "..."
    return text


def detect_category(phrase):
    low = phrase.lower()
    for stems, category, group in CATEGORY_RULES:
        if any(stem in low for stem in stems):
            return category, group
    return None, None


def detect_project(phrase, projects):
    low = phrase.lower()
    for project in projects:
        name = project["name"].lower()
        if name and name in low:
            return project["id"]
        if project["id"].lower() in low:
            return project["id"]
    return ""


def parse_due(phrase, today):
    """Deterministic Russian date hints -> YYYY-MM-DD, else empty string."""
    low = phrase.lower()
    if "послезавтра" in low:
        return (today + dt.timedelta(days=2)).isoformat()
    if "завтра" in low:
        return (today + dt.timedelta(days=1)).isoformat()
    if "сегодня" in low:
        return today.isoformat()
    match = re.search(r"через\s+([0-9]+)\s+(?:день|дня|дней)", low)
    if match:
        return (today + dt.timedelta(days=int(match.group(1)))).isoformat()
    match = DATE_DOTTED.search(low)
    if match:
        day, month = int(match.group(1)), int(match.group(2))
        year = int(match.group(3)) if match.group(3) else today.year
        try:
            candidate = dt.date(year, month, day)
        except ValueError:
            return ""
        if not match.group(3) and candidate < today:
            candidate = candidate.replace(year=year + 1)
        return candidate.isoformat()
    match = DATE_DAY_MONTH.search(low)
    if match:
        day = int(match.group(1))
        for stem, month in MONTHS:
            if match.group(2).startswith(stem):
                try:
                    candidate = dt.date(today.year, month, day)
                except ValueError:
                    return ""
                if candidate < today:
                    candidate = dt.date(today.year + 1, month, day)
                return candidate.isoformat()
    if "конца недели" in low or "этой неделе" in low or "концу недели" in low:
        days_ahead = (4 - today.weekday()) % 7
        return (today + dt.timedelta(days=days_ahead)).isoformat()
    if "конца месяца" in low or "концу месяца" in low:
        next_month = (today.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        return (next_month - dt.timedelta(days=1)).isoformat()
    for stem, weekday in WEEKDAYS:
        if stem in low:
            days_ahead = (weekday - today.weekday()) % 7
            if days_ahead == 0:
                days_ahead = 7
            return (today + dt.timedelta(days=days_ahead)).isoformat()
    return ""


# --------------------------------------------------------------------------
# month file
# --------------------------------------------------------------------------

def month_path(month, tasks_dir=None):
    """Path of the month file; the default is read late so --tasks-dir works."""
    base = TASKS_DIR if tasks_dir is None else tasks_dir
    return Path(base) / ("%s.yaml" % month)


def load_month_tasks(path):
    if not Path(path).exists():
        return []
    data = parse_yaml_file(path)
    if not isinstance(data, list):
        return []
    tasks = []
    for item in data:
        if isinstance(item, dict) and item.get("id"):
            tasks.append({key: ("" if value is None else value) for key, value in item.items()})
    return tasks


def next_task_number(tasks):
    highest = 0
    for task in tasks:
        match = re.match(r"^T-([0-9]+)$", str(task.get("id") or ""))
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def _quote(value):
    text = "" if value is None else str(value)
    text = text.replace("\\", "/").replace('"', "'")
    return '"%s"' % text


def render_month_file(month, tasks, sources=None):
    lines = [MONTH_HEADER % month, GENERATED_BY]
    if sources:
        lines.append("# Источники: %s" % ", ".join(str(name) for name in sources))
    lines.append("")
    for task in tasks:
        lines.append("- id: %s" % task["id"])
        lines.append("  subject: %s" % _quote(task["subject"]))
        lines.append("  group: %s" % _quote(task["group"]))
        lines.append("  category: %s" % _quote(task["category"]))
        lines.append("  owner: %s" % _quote(task["owner"]))
        lines.append("  status: %s" % _quote(task["status"]))
        lines.append("  project: %s" % _quote(task["project"]))
        lines.append("  due: %s" % _quote(task["due"]))
        lines.append("  source: %s" % _quote(task["source"]))
        lines.append("  created: %s" % _quote(task["created"]))
        lines.append("  quote: %s" % _quote(task["quote"]))
    pending = [task for task in tasks if task["status"] == "unassigned"]
    if pending:
        lines.append("")
        lines.append("# " + "=" * 74)
        lines.append("# " + CLARIFY_HEADER)
        lines.append("# Задачам ниже не нашёлся владелец: проверьте формулировку и укажите")
        lines.append("# owner/group/status вручную. Машиночитаемо это поле status: unassigned.")
        lines.append("# " + "=" * 74)
        for task in pending:
            lines.append("# - id: %s" % task["id"])
            lines.append("#   subject: %s" % _quote(task["subject"]))
            lines.append("#   quote: %s" % _quote(task["quote"]))
            lines.append("#   почему: не найден владелец по ключевым словам")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def collect_input_files(target, recursive=False):
    """Text files to process: one file, or the top level of a folder (optionally recursive)."""
    path = Path(target)
    if path.is_file():
        return [path]
    if not path.is_dir():
        return []
    candidates = sorted(path.rglob("*")) if recursive else sorted(path.glob("*"))
    files = []
    for candidate in candidates:
        if not candidate.is_file() or candidate.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if candidate.name.lower().startswith("readme"):
            continue
        if candidate.name.lower().endswith((".pending.md", ".pending.txt")):
            continue
        files.append(candidate)
    return files


def build_tasks(texts, month, today, source, agents, projects):
    owners = group_owner_map(agents)
    known_projects = [project["id"] for project in projects]
    existing = load_month_tasks(month_path(month))
    seen = {str(task.get("subject") or "").strip().lower() for task in existing}
    number = next_task_number(existing)
    created = []
    skipped = []
    for path, text in texts:
        file_source = "telemost-voice" if path and path.name.lower().endswith(".voice.txt") else source
        for phrase in split_phrases(text):
            if not is_task_phrase(phrase):
                continue
            subject = make_subject(phrase)
            if not subject or subject.lower() in seen:
                skipped.append((subject, "уже есть в реестре"))
                continue
            seen.add(subject.lower())
            category, group = detect_category(phrase)
            owner = owners.get(group)
            if not owner:
                group = "unassigned"
                category = category or "Прочее"
                status = "unassigned"
            else:
                status = "new"
            if owner and owner not in [agent["id"] for agent in agents]:
                owner = ""
                group, status = "unassigned", "unassigned"
            created.append({
                "id": "T-%d" % number,
                "subject": subject,
                "group": group,
                "category": category or "Прочее",
                "owner": owner or "",
                "status": status,
                "project": detect_project(phrase, projects),
                "due": parse_due(phrase, today),
                "source": file_source,
                "created": today.isoformat(),
                "quote": phrase.strip(),
            })
            number += 1
    return existing + created, created, skipped


def build_parser():
    parser = argparse.ArgumentParser(
        prog="text_to_tasks.py",
        description="Русский транскрипт встречи -> задачи в registry/tasks/<YYYY-MM>.yaml.",
    )
    parser.add_argument("--input", required=True, help="файл транскрипта или каталог с ними")
    parser.add_argument("--source", default="telemost-text", choices=SOURCE_VALUES,
                        help="источник задач (по умолчанию telemost-text)")
    parser.add_argument("--date", default=None, help="дата обработки YYYY-MM-DD (по умолчанию сегодня)")
    parser.add_argument("--registry-dir", default=None, help="каталог registry (по умолчанию вычисляется от скрипта)")
    parser.add_argument("--tasks-dir", default=None, help="каталог задач (по умолчанию registry/tasks)")
    parser.add_argument("--recursive", action="store_true",
                        help="обойти каталог рекурсивно (по умолчанию только верхний уровень)")
    parser.add_argument("--dry-run", action="store_true", help="не писать файл, только показать результат")
    parser.add_argument("--print", dest="show", action="store_true", help="напечатать готовый YAML")
    return parser


def main(argv=None):
    setup_console()
    args = build_parser().parse_args(argv)

    global REGISTRY_DIR, TASKS_DIR, AGENTS_FILE, PROJECTS_FILE
    if args.registry_dir:
        REGISTRY_DIR = Path(args.registry_dir)
        AGENTS_FILE = REGISTRY_DIR / "agents.yaml"
        PROJECTS_FILE = REGISTRY_DIR / "projects.yaml"
        TASKS_DIR = REGISTRY_DIR / "tasks"
    if args.tasks_dir:
        TASKS_DIR = Path(args.tasks_dir)

    target = Path(args.input)
    if not target.exists():
        print("Не найдено: %s" % args.input, file=sys.stderr)
        return 1
    files = collect_input_files(args.input, recursive=args.recursive)
    if not files:
        # Пустой inbox — это норма, а не ошибка: обрабатывать нечего.
        print("Файлов для обработки нет в %s — задачи не менялись." % args.input)
        return 0

    try:
        agents = load_agents(AGENTS_FILE)
        projects = load_projects(PROJECTS_FILE)
    except Exception as exc:
        print("Ошибка чтения реестра: %s" % exc, file=sys.stderr)
        return 2
    if not agents:
        print("В %s не найдено ни одного агента — владельцев взять негде." % AGENTS_FILE, file=sys.stderr)
        return 2

    today = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
    month = today.strftime("%Y-%m")
    texts = [(path, path.read_text(encoding="utf-8-sig", errors="replace")) for path in files]

    tasks, created, skipped = build_tasks(texts, month, today, args.source, agents, projects)
    payload = render_month_file(month, tasks, sources=[path.name for path in files])

    print("Файлов обработано: %d" % len(files))
    for path in files:
        print("  - %s" % path)
    print("Задач создано: %d" % len(created))
    for task in created:
        print("  - %s | %s | %s | %s | срок: %s | %s"
              % (task["id"], task["group"], task["category"], task["owner"] or "без владельца",
                 task["due"] or "не указан", task["subject"]))
    unassigned = [task for task in created if task["status"] == "unassigned"]
    if unassigned:
        print("Требуют уточнения (status: unassigned): %d" % len(unassigned))
    if skipped:
        print("Пропущено: %d" % len(skipped))

    if args.show or args.dry_run:
        print("")
        print(payload)
    if args.dry_run:
        print("--dry-run: файл не изменён (%s)" % month_path(month, TASKS_DIR))
        return 0

    target = month_path(month, TASKS_DIR)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload, encoding="utf-8")
    print("Реестр задач: %s" % target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
