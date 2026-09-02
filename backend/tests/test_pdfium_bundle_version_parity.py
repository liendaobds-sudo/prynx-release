"""Chốt phiên bản PDFium: bản đóng gói cho PRODUCTION không được trụt hậu bản DEV.

Bối cảnh (pentest 2026-08-28 §ATK.04): có HAI file `pdfium.dll` khác nhau trong repo và
chúng **không** được build tự đồng bộ:

- `native/pdfium_lib/bin/pdfium.dll` — bản DEV/test thật sự nạp (`rust_bridge.py` đặt
  `PDFIUM_DLL_PATH` trỏ vào đây khi import).
- `native/pdfium.dll` — bản Nuitka đóng vào BẢN PHÁT HÀNH cho khách
  (`build_production.ps1`: `--include-data-files=native\\pdfium.dll=pdfium.dll`).

Đo ngày 2026-08-28: dev chạy `150.0.7857` trong khi bundle prod vẫn là `126.0.6462`
(~2 năm bản vá PDFium/Chromium bị bỏ lại) — **không test nào bắt được**, vì mọi test đều
chạy trên DLL dev. PDFium parse PDF không tin cậy và chạy IN-PROCESS trong sidecar, nên
để bundle prod cũ nghĩa là khách hứng rủi ro bộ nhớ mà đội phát triển không thấy.

Test này biến lần kiểm thủ công đó thành gate thường trực: hai file phải cùng phiên bản.
Khi nâng PDFium, nâng CẢ HAI (thường là copy `pdfium_lib/bin/pdfium.dll` → `native/`).

Cố ý so theo **phiên bản** chứ không theo hash: hai file có thể khác build flags hợp lệ
(ví dụ prod lấy bản khác từ cùng release), nhưng lệch phiên bản thì luôn là nợ bảo mật.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PROD_BUNDLE_DLL = REPO / "native" / "pdfium.dll"
DEV_DLL = REPO / "native" / "pdfium_lib" / "bin" / "pdfium.dll"
VERSION_FILE = REPO / "native" / "pdfium_lib" / "VERSION"


def _dll_file_version(path: Path) -> str:
    """Đọc FileVersion từ resource của DLL Windows (không cần nạp thư viện)."""
    try:
        import win32api  # type: ignore
    except ImportError:
        pytest.skip("Cần pywin32 để đọc version resource của DLL")

    info = win32api.GetFileVersionInfo(str(path), "\\")
    return "{}.{}.{}.{}".format(
        info["FileVersionMS"] >> 16,
        info["FileVersionMS"] & 0xFFFF,
        info["FileVersionLS"] >> 16,
        info["FileVersionLS"] & 0xFFFF,
    )


def test_prod_pdfium_bundle_matches_dev_version():
    """Bản PDFium ship cho khách phải trùng bản đang được test ở dev."""
    if not PROD_BUNDLE_DLL.is_file() or not DEV_DLL.is_file():
        pytest.skip("Thiếu một trong hai pdfium.dll (checkout không đầy đủ)")

    prod_version = _dll_file_version(PROD_BUNDLE_DLL)
    dev_version = _dll_file_version(DEV_DLL)

    assert prod_version == dev_version, (
        "Bundle PDFium cho PRODUCTION lệch bản DEV: "
        f"native/pdfium.dll = {prod_version} nhưng native/pdfium_lib/bin/pdfium.dll = "
        f"{dev_version}. Mọi test chạy trên bản dev nên lệch này KHÔNG tự lộ ra, trong khi "
        "khách lại dùng bản cũ để parse PDF không tin cậy (§ATK.04). Xử lý: copy "
        "native/pdfium_lib/bin/pdfium.dll → native/pdfium.dll rồi chạy lại test native."
    )


def test_version_marker_matches_dev_dll():
    """`pdfium_lib/VERSION` phải mô tả đúng DLL nằm cạnh nó."""
    if not DEV_DLL.is_file() or not VERSION_FILE.is_file():
        pytest.skip("Thiếu pdfium_lib/bin/pdfium.dll hoặc VERSION")

    raw = VERSION_FILE.read_text(encoding="utf-8", errors="replace")
    fields = dict(re.findall(r"^(\w+)=(\d+)$", raw, flags=re.MULTILINE))
    assert {"MAJOR", "BUILD"} <= fields.keys(), f"VERSION thiếu MAJOR/BUILD: {raw!r}"

    dev_version = _dll_file_version(DEV_DLL)
    major, _minor, build, _patch = dev_version.split(".")

    assert fields["MAJOR"] == major and fields["BUILD"] == build, (
        f"pdfium_lib/VERSION nói MAJOR={fields['MAJOR']} BUILD={fields['BUILD']} nhưng "
        f"DLL cạnh nó là {dev_version}. File VERSION là nguồn tra phiên bản khi audit "
        "nên nó sai sẽ dẫn tới kết luận sai về việc đã vá tới đâu."
    )


def test_build_script_still_bundles_the_checked_dll():
    """Nếu build đổi sang đóng gói DLL khác thì test trên mất tác dụng — chốt luôn."""
    build_script = REPO / "build_production.ps1"
    if not build_script.is_file():
        pytest.skip("Không tìm thấy build_production.ps1")

    source = build_script.read_text(encoding="utf-8", errors="replace")
    assert '$PDFIUM_DLL = "$ROOT\\native\\pdfium.dll"' in source, (
        "build_production.ps1 không còn đóng gói native/pdfium.dll — hãy cập nhật "
        "test_prod_pdfium_bundle_matches_dev_version() để chốt đúng file đang ship."
    )
