"""Authority nhẹ cho mọi diagnostic chỉ dành cho vòng phát triển.

Binary Nuitka/PyInstaller luôn fail-closed: biến môi trường trên máy khách không
thể bật lại trace, ảnh debug hoặc log nội bộ. Module không import engine/route để
worker process có thể dùng mà không kéo phụ thuộc vòng.
"""

from __future__ import annotations

import os
import sys

_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def is_compiled_runtime() -> bool:
    """Trả True cho sidecar đã đóng gói bằng Nuitka/PyInstaller."""

    return "__compiled__" in globals() or bool(getattr(sys, "frozen", False))


def development_runtime_enabled(
    *,
    compiled: bool | None = None,
    configured_dev: bool | None = None,
) -> bool:
    """Chỉ runtime thông dịch + DEV_MODE chủ động mới được dùng diagnostic."""

    packaged = is_compiled_runtime() if compiled is None else bool(compiled)
    if packaged:
        return False
    if configured_dev is None:
        try:
            from app.config import settings

            configured_dev = bool(settings.DEV_MODE)
        except Exception:
            configured_dev = (
                os.environ.get("DEV_MODE", "false").strip().lower()
                in _TRUE_VALUES
            )
    return bool(configured_dev)


def development_diagnostic_enabled(
    env_name: str,
    *,
    default_in_dev: bool = False,
    compiled: bool | None = None,
    configured_dev: bool | None = None,
    raw_value: str | None = None,
) -> bool:
    """Đọc một cờ diagnostic sau khi đã kiểm authority runtime phát triển.

    Các tham số override chỉ phục vụ unit test thuần; caller runtime không truyền.
    """

    if not development_runtime_enabled(
        compiled=compiled,
        configured_dev=configured_dev,
    ):
        return False
    value = os.environ.get(env_name) if raw_value is None else raw_value
    if value is None:
        return bool(default_in_dev)
    return str(value).strip().lower() in _TRUE_VALUES
