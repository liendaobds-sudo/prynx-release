"""Chính sách path PDF local dùng chung cho các route imposition/document."""

from __future__ import annotations

import os
import re
import tempfile

from fastapi import HTTPException

from app.config import settings

_ALLOWED_DIRS = [
    os.path.abspath(settings.UPLOAD_DIR),
    os.path.abspath(settings.RESULTS_DIR),
    os.path.abspath(tempfile.gettempdir()),
]
for _directory in (os.environ.get("IMPOSITION_ALLOWED_DIRS", "") or "").split(
    os.pathsep
):
    if _directory.strip():
        _ALLOWED_DIRS.append(os.path.abspath(_directory.strip()))

_RESTRICT_PATHS = (
    os.environ.get("IMPOSITION_RESTRICT_PATHS", "") or ""
).strip().lower() in ("1", "true", "yes", "on")


def validate_imposition_pdf_path(path: str | None, must_exist: bool = True) -> str:
    """Chuẩn hóa path PDF local và áp allowlist khi backend chạy chế độ web."""
    if not path:
        raise HTTPException(status_code=400, detail="File path is required.")

    parts = re.split(r"[\\/]+", path)
    if any(part == ".." for part in parts):
        raise HTTPException(
            status_code=400,
            detail="Invalid path: directory traversal not allowed.",
        )

    resolved = os.path.abspath(path)
    if os.path.islink(resolved):
        raise HTTPException(
            status_code=400,
            detail="Invalid path: symbolic links not allowed.",
        )
    if _RESTRICT_PATHS and os.path.normcase(os.path.realpath(resolved)) != os.path.normcase(
        resolved
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid path: symbolic links not allowed.",
        )

    if not resolved.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    if _RESTRICT_PATHS and not any(
        os.path.commonpath([resolved, directory]) == directory
        for directory in _ALLOWED_DIRS
    ):
        raise HTTPException(
            status_code=403,
            detail="Invalid path: outside allowed directories.",
        )

    if must_exist and not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    return resolved
