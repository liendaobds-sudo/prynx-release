"""Cờ rollout backend của nesting theo đường bế — Lô F3 (audit 2026-08-28 §A4a-3).

Khoá bốn điều:

1. thiếu biến môi trường ⇒ HOLD (fail-closed);
2. dev thông dịch mở, bản đóng gói **không** mở nhờ dev;
3. cờ này TÁCH khỏi cờ Mixed Nesting standalone;
4. `build_production.ps1` nung đủ cặp cờ và có guard chặn bật lệch.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.nesting_rollout import (
    TRUE_SHAPE_NESTING_FLAG_NAME,
    TRUE_SHAPE_NESTING_FRONTEND_FLAG_NAME,
    true_shape_nesting_enabled,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = REPO_ROOT / "build_production.ps1"


def test_thieu_bien_moi_truong_la_hold() -> None:
    assert (
        true_shape_nesting_enabled(
            is_development=False, is_compiled=True, release_flag=None
        )
        is False
    )


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("true", True),
        ("TRUE", True),
        ("  true  ", True),
        ("false", False),
        ("", False),
        ("1", False),
        ("yes", False),
        ("truthy", False),
    ],
)
def test_chi_chuoi_true_moi_mo(raw, expected) -> None:
    """Không nhận `1`/`yes`: cờ release phải tường minh, không đoán ý."""

    assert (
        true_shape_nesting_enabled(
            is_development=False, is_compiled=True, release_flag=raw
        )
        is expected
    )


def test_dev_thong_dich_mo_nhung_ban_dong_goi_thi_khong() -> None:
    assert (
        true_shape_nesting_enabled(
            is_development=True, is_compiled=False, release_flag="false"
        )
        is True
    )
    # Bản Nuitka không được mở chỉ vì DEV_MODE còn sót trong env.
    assert (
        true_shape_nesting_enabled(
            is_development=True, is_compiled=True, release_flag="false"
        )
        is False
    )
    assert (
        true_shape_nesting_enabled(
            is_development=True, is_compiled=True, release_flag="true"
        )
        is True
    )


def test_doc_bien_that_tu_moi_truong(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TRUE_SHAPE_NESTING_FLAG_NAME, "true")
    assert true_shape_nesting_enabled(is_development=False, is_compiled=True) is True
    monkeypatch.setenv(TRUE_SHAPE_NESTING_FLAG_NAME, "false")
    assert true_shape_nesting_enabled(is_development=False, is_compiled=True) is False
    monkeypatch.delenv(TRUE_SHAPE_NESTING_FLAG_NAME, raising=False)
    assert true_shape_nesting_enabled(is_development=False, is_compiled=True) is False


def test_tach_khoi_co_mixed_nesting_standalone() -> None:
    """Dùng chung cờ thì kill switch một đường sẽ tắt luôn đường kia."""

    assert TRUE_SHAPE_NESTING_FLAG_NAME != "PRYNX_MIXED_NESTING_ENABLED"
    assert TRUE_SHAPE_NESTING_FLAG_NAME == "PRYNX_TRUE_SHAPE_NESTING_ENABLED"
    assert TRUE_SHAPE_NESTING_FRONTEND_FLAG_NAME == "VITE_TRUE_SHAPE_NESTING_ENABLED"


def test_build_script_nung_du_cap_co_va_co_guard() -> None:
    """Cờ không được nung thì bản phát hành phụ thuộc .env của máy build."""

    assert BUILD_SCRIPT.is_file(), "không tìm thấy build_production.ps1"
    text = BUILD_SCRIPT.read_text(encoding="utf-8", errors="replace")

    # Nung tường minh về HOLD.
    assert '$env:VITE_TRUE_SHAPE_NESTING_ENABLED = "false"' in text
    assert '$env:PRYNX_TRUE_SHAPE_NESTING_ENABLED = "false"' in text

    # Có trong snapshot env để build không làm bẩn shell của người chạy.
    assert '"VITE_TRUE_SHAPE_NESTING_ENABLED"' in text
    assert '"PRYNX_TRUE_SHAPE_NESTING_ENABLED"' in text

    # Guard phải kiểm cả hai bên ở CẢ HAI chốt: trước bundle và trước manifest.
    guard_pattern = re.compile(
        r"VITE_TRUE_SHAPE_NESTING_ENABLED -ne \"false\"", re.MULTILINE
    )
    assert len(guard_pattern.findall(text)) >= 2, (
        "thiếu guard cờ ở một trong hai chốt (trước bundle / trước manifest)"
    )
    backend_guard = re.compile(
        r"PRYNX_TRUE_SHAPE_NESTING_ENABLED -ne \"false\"", re.MULTILINE
    )
    assert len(backend_guard.findall(text)) >= 2
