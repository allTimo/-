# -*- coding: utf-8 -*-
"""Сборка промпт-бандла Агента 2: все его маркетинговые скиллы в один файл для LLM.

Правила:
* список скиллов берётся из registry/agents.yaml (поле skills у agent-2-direct-semantics);
* читаются только marketing-agents/skills/<имя>/SKILL.md (регламентные скиллы проекта);
* ничего не пишется в рекламные кабинеты, профиль DSH и реестр;
* результат: agents/agent-2-direct-semantics/prompt-bundle.md и prompt-manifest.json.

Запуск: python tools/build_agent2_prompt_bundle.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SKILLS_DIR = PROJECT / "skills"
AGENTS_FILE = PROJECT / "registry" / "agents.yaml"
OUT_DIR = PROJECT / "agents" / "agent-2-direct-semantics"
AGENT_ID = "agent-2-direct-semantics"

# Скиллы, которые относятся к Агенту 2, но не перечислены в его блоке реестра
# (обязательный чек-лист аудита): добавляем, чтобы LLM получал их вместе с ролью.
EXTRA_SKILLS = ("ppc-checklist",)


def read_agent_skills() -> list[str]:
    """Список skills у Агента 2 из registry/agents.yaml."""
    text = AGENTS_FILE.read_text(encoding="utf-8")
    block = None
    for chunk in re.split(r"\n(?=  - id: )", text):
        if re.search(r"^\s*-\s*id:\s*" + re.escape(AGENT_ID) + r"\s*$", chunk, re.M):
            block = chunk
            break
    if block is None:
        raise SystemExit(f"в {AGENTS_FILE} не найден блок агента {AGENT_ID}")
    match = re.search(r"^\s*skills:\s*\[(.*?)\]\s*$", block, re.M)
    names = re.findall(r'"([^"]+)"', match.group(1)) if match else []
    for extra in EXTRA_SKILLS:
        if extra not in names:
            names.append(extra)
    return names


def frontmatter(text: str) -> dict:
    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", text, re.S)
    data: dict[str, str] = {}
    if not match:
        return data
    for line in match.group(1).splitlines():
        parsed = re.match(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$", line)
        if parsed:
            data[parsed.group(1)] = parsed.group(2).strip().strip('"').strip("'")
    return data


def main() -> int:
    names = read_agent_skills()
    parts: list[str] = []
    manifest: list[dict] = []
    missing: list[str] = []

    for name in names:
        path = SKILLS_DIR / name / "SKILL.md"
        if not path.is_file():
            missing.append(name)
            continue
        text = path.read_text(encoding="utf-8")
        meta = frontmatter(text)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        manifest.append({
            "name": name,
            "description": meta.get("description", ""),
            "whenToUse": meta.get("whenToUse", ""),
            "path": str(path.relative_to(PROJECT)).replace("\\", "/"),
            "sha256_12": digest,
            "bytes": len(text.encode("utf-8")),
        })
        parts.append(
            "\n\n<!-- skill: {name} | sha256:{digest} | {path} -->\n\n{body}".format(
                name=name, digest=digest,
                path=str(path.relative_to(PROJECT)).replace("\\", "/"),
                body=text,
            )
        )

    header = (
        "# Промпт-бандл Агента 2 «Яндекс Директ»\n\n"
        f"Собран: {date.today().isoformat()}. Источник: `registry/agents.yaml` (поле `skills`) "
        "и `marketing-agents/skills/*/SKILL.md`.\n\n"
        "Этот файл — единый контекст ролей и регламентов Агента 2 для LLM. "
        "Порядок применения: сначала прочитать разделы нужного скилла, затем работать строго "
        "по его правилам. Запись в рекламный аккаунт — только по явному подтверждению пользователя; "
        "нет данных — писать «данных нет», а не ноль и не оценку.\n\n"
        "## Состав бандла\n\n| Скилл | О чём | Когда применять |\n|---|---|---|\n"
        + "\n".join(
            "| `{name}` | {desc} | {when} |".format(
                name=m["name"], desc=m["description"][:110], when=m["whenToUse"][:90] or "—"
            )
            for m in manifest
        )
        + "\n"
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bundle = OUT_DIR / "prompt-bundle.md"
    bundle.write_text(header + "".join(parts) + "\n", encoding="utf-8")

    manifest_doc = {
        "agent": AGENT_ID,
        "generated": date.today().isoformat(),
        "source": "registry/agents.yaml + skills/*/SKILL.md",
        "skills_total": len(manifest),
        "missing": missing,
        "skills": manifest,
        "bundle": str(bundle.relative_to(PROJECT)).replace("\\", "/"),
        "bundle_bytes": bundle.stat().st_size,
    }
    (OUT_DIR / "prompt-manifest.json").write_text(
        json.dumps(manifest_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"скиллов в бандле: {len(manifest)} из {len(names)}")
    if missing:
        print("НЕ найдены:", ", ".join(missing))
    print(f"бандл: {bundle} ({bundle.stat().st_size} байт)")
    print(f"манифест: {OUT_DIR / 'prompt-manifest.json'}")
    print("состав:", ", ".join(m["name"] for m in manifest))
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
