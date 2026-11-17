"""Точка входа CLI: ``python -m skills.direct_api --check --json``."""

from __future__ import annotations

from .client import main

if __name__ == "__main__":
    raise SystemExit(main())
