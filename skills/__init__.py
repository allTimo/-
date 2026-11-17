"""Пакет скиллов агента.

Каждый скилл — это модуль с функцией ``fetch(query: str, **kwargs) -> list[dict]``
и запись в реестре ``skills/registry/skills_registry.json``.

Общие правила и служебный код — в :mod:`skills.runtime`.
"""
