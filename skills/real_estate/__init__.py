"""Скиллы источников данных о недвижимости.

Каждый модуль реализует контракт ``fetch(query: str, **kwargs) -> list[dict]``
и содержит словарь ``SKILL`` с метаданными. Модули перечислены в
``skills/registry/skills_registry.json``.
"""
