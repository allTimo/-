r"""Pytest bootstrap for the competitor-watch engine tests.

Windows sandbox workaround (DSH, workspace-write mode).

`tempfile.mkdtemp()` creates its directory with mode 0o700. On Windows CPython
turns a non-0o777 mode into an EXPLICIT DACL on the new directory that contains
only the owner entry. The DSH sandbox runs the interpreter under a restricted
token whose access check cannot satisfy that explicit DACL, so the very first
write inside the freshly created directory fails:

    PermissionError: [WinError 5] ... \<mkdtemp-dir>\reports

Every test here builds its tree with mkdtemp, so the whole suite errored out on
directory creation before this file existed (59 failed / 35 errors).

Creating the temporary directory with the default mode (0o777) lets it inherit
the parent's permissive ACEs, so the sandbox token can write inside it.
This changes ONLY the temporary directory's own security descriptor; test logic,
the engine and production paths are untouched, and on hosts without the sandbox
restriction the behaviour is a normal temporary directory.
"""
from __future__ import annotations

import errno
import os
import sys
import tempfile
from pathlib import Path


def _ensure_openpyxl():
    """Make the XLSX dependency visible to this interpreter and its subprocesses.

    The connector venv that runs these tests has pytest but no openpyxl, while
    the DSH runtime Python ships openpyxl 3.1.5. Nothing is installed here: the
    runtime's site-packages is only put on the import path. The three test
    modules that spawn engine CLIs append the inherited PYTHONPATH instead of
    replacing it, so the child processes see openpyxl too.
    """
    try:
        import openpyxl  # noqa: F401
        return
    except ImportError:
        pass
    candidates = [
        Path(os.environ.get("USERPROFILE", "")) / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime"
        / "dependencies" / "python" / "Lib" / "site-packages",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DeepSeek Harness" / "resources"
        / "runtime" / "primary-runtime" / "dependencies" / "python" / "Lib" / "site-packages",
    ]
    for candidate in candidates:
        if (candidate / "openpyxl").is_dir():
            sys.path.insert(0, str(candidate))
            inherited = os.environ.get("PYTHONPATH", "")
            os.environ["PYTHONPATH"] = os.pathsep.join(
                part for part in (str(candidate), inherited) if part)
            return


_ensure_openpyxl()


def _mkdtemp_default_mode(suffix=None, prefix=None, dir=None):
    """tempfile.mkdtemp() without the restrictive 0o700 mode."""
    prefix, suffix, dir, _output_type = tempfile._sanitize_params(prefix, suffix, dir)
    names = tempfile._get_candidate_names()
    for _ in range(tempfile.TMP_MAX):
        path = os.path.join(dir, prefix + next(names) + suffix)
        try:
            os.mkdir(path)
            return path
        except FileExistsError:
            continue
    raise FileExistsError(errno.EEXIST, "No usable temporary directory name found", dir)


tempfile.mkdtemp = _mkdtemp_default_mode
