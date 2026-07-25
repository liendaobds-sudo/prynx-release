"""Bảo đảm bộ PDF fixture tồn tại trước khi chạy golden test preflight.

VẤN ĐỀ (audit 2026-07-25): `.gitignore` chặn `*.pdf` nên 18 file trong
`tests/preflight_fixtures/pdfs/` CHƯA BAO GIỜ được commit. Chúng chỉ tồn tại trên máy
đã từng chạy `generate_fixtures.py` bằng tay. Hệ quả: trên MỌI clone mới — kể cả runner
CI (`.github/workflows/ci.yml` chạy `python -m pytest tests/`) — cả 17 golden test
preflight đều FAIL vì thiếu file. Suite đỏ mặc định = không ai còn nhìn tín hiệu CI nữa
(audit-rules §12.5: "CI chỉ trang trí").

CÁCH VÁ: sinh lại các PDF THIẾU ngay trước khi chạy, thay vì commit blob nhị phân
(giữ đúng ý định `*.pdf` trong .gitignore, và fixture vốn đã sinh được tất định).

QUAN TRỌNG — không gọi `generate_all()`: hàm đó ghi đè luôn
`tests/preflight_fixtures/expected_rules.json`, vốn LÀ FILE ĐÃ TRACK. Chạy test sẽ làm
bẩn working tree và có thể âm thầm đổi kỳ vọng golden (mất luôn tác dụng khoá hành vi).
Ở đây chỉ gọi từng generator cho đúng file còn thiếu; manifest giữ nguyên như trong git.

Sinh thất bại thì FAIL RÕ, không skip: golden test preflight phải thực sự chạy trong CI.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_FIXTURES_ROOT = Path(__file__).parent.parent / "preflight_fixtures"
_PDF_DIR = _FIXTURES_ROOT / "pdfs"
_GENERATOR_PATH = _FIXTURES_ROOT / "generate_fixtures.py"


def _load_generator_module():
    """Nạp generate_fixtures.py theo đường dẫn (thư mục fixture không phải package)."""
    spec = importlib.util.spec_from_file_location(
        "preflight_generate_fixtures", _GENERATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Không nạp được generator tại {_GENERATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session", autouse=True)
def ensure_preflight_fixture_pdfs():
    """Sinh các PDF fixture còn thiếu (no-op khi đã có đủ)."""
    if not _GENERATOR_PATH.is_file():
        pytest.fail(
            f"Thiếu generator fixture: {_GENERATOR_PATH}. "
            "Golden test preflight không thể chạy."
        )

    module = _load_generator_module()
    generators: dict = getattr(module, "GENERATORS", {})
    if not generators:
        pytest.fail(
            f"{_GENERATOR_PATH.name} không expose GENERATORS — "
            "cấu trúc generator đã đổi, cập nhật conftest này."
        )

    _PDF_DIR.mkdir(parents=True, exist_ok=True)
    missing = {name: fn for name, fn in generators.items() if not (_PDF_DIR / name).is_file()}
    if not missing:
        return

    failures: list[str] = []
    for name, generate in missing.items():
        try:
            generate(_PDF_DIR / name)
        except Exception as exc:  # noqa: BLE001 - gom hết để báo một lần, dễ chẩn đoán
            failures.append(f"{name}: {type(exc).__name__}: {exc}")

    if failures:
        pytest.fail(
            "Không sinh được PDF fixture preflight (thiếu dependency? xem lỗi dưới):\n  "
            + "\n  ".join(failures)
        )
