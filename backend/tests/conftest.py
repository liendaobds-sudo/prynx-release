"""Session-wide pytest fixtures for backend tests."""
from __future__ import annotations

import os
import shutil
import sys

# PDFium / thư viện C ghi raw bytes (non-UTF-8) ra stderr → pytest capture
# crash với UnicodeDecodeError khi đọc lại. Reconfigure stderr với error
# handler 'replace' (thay ký tự lỗi bằng U+FFFD) thay vì mặc định 'strict'.
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

import tempfile
import uuid
from pathlib import Path

import pytest

from tests.license_helpers import PRO_LICENSE, clear_license_override, install_license_override

# Keep the test suite hermetic regardless of the caller's working directory or
# root .env file. Callers may opt into another isolated database explicitly.
_TEST_DATABASE_PATH: Path | None = None
_test_database_url = os.environ.get("PRYNX_TEST_DATABASE_URL")
if _test_database_url:
    os.environ["DATABASE_URL"] = _test_database_url
else:
    _TEST_DATABASE_PATH = Path(tempfile.gettempdir()) / (
        f"prynx_pytest_{os.getpid()}_{uuid.uuid4().hex}.sqlite3"
    )
    os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DATABASE_PATH.as_posix()}"

# Prevent DEV_MODE's application-level SQLite override from replacing the
# isolated URL above with a persistent ./data/pdfcompare.db.
os.environ["DEV_MODE"] = "false"
# Result artifacts are signed in enforced-mode tests with this process-local fixture secret.
os.environ["PRYNX_SIDECAR_TOKEN"] = "pytest-sidecar-token"

# TEST-ISOLATION (audit 2026-09-01 §PERF-NEST-02): các test nesting có thể pin
# source ngay trong lúc dựng/solve job. Kho mặc định ``backend/uploads/results``
# là dữ liệu runtime thật, nên toàn bộ pytest phải dùng root riêng theo process.
_TEST_ARTIFACT_ROOT = Path(
    tempfile.mkdtemp(prefix=f"prynx_pytest_artifacts_{os.getpid()}_")
)
os.environ["UPLOAD_DIR"] = str(_TEST_ARTIFACT_ROOT / "uploads")
os.environ["RESULTS_DIR"] = str(_TEST_ARTIFACT_ROOT / "results")
os.environ["PRYNX_MIXED_NESTING_DATA_DIR"] = str(
    _TEST_ARTIFACT_ROOT / "mixed_nesting"
)

# Tests that exercise the real license/token path must not get an auto Pro override.
_SKIP_AUTO_PRO = (
    "test_free_token_e2e",
    "test_license_token",
    "test_dieline_feature_gate",
    "test_feature_entitlements",
)


def _node_opts_out_of_auto_pro(nodeid: str) -> bool:
    return any(name in nodeid for name in _SKIP_AUTO_PRO)


@pytest.fixture(autouse=True)
def _isolated_sidecar_signing_secret(monkeypatch):
    """Giữ URL kết quả ở enforced mode nhưng dùng secret cục bộ của fixture.

    Production không còn nhận ``PRYNX_SIDECAR_TOKEN`` từ env khi ``DEV_MODE=false``;
    vì vậy test phải gắn secret trực tiếp vào module đã import. Test âm vẫn có thể
    monkeypatch thành ``None`` trong chính ca kiểm tra fail-closed.
    """
    from app.core import license_guard

    monkeypatch.setattr(license_guard, "_SIDECAR_TOKEN", "pytest-sidecar-token")


@pytest.fixture(scope="session", autouse=True)
def _isolated_database_schema():
    """Create and remove the schema used by DB-backed integration tests."""
    from app.database import Base, engine

    Base.metadata.create_all(bind=engine)
    try:
        yield
    finally:
        engine.dispose()
        if _TEST_DATABASE_PATH is not None:
            for suffix in ("", "-wal", "-shm"):
                try:
                    Path(f"{_TEST_DATABASE_PATH}{suffix}").unlink(missing_ok=True)
                except OSError:
                    pass
        shutil.rmtree(_TEST_ARTIFACT_ROOT, ignore_errors=True)


@pytest.fixture(autouse=True)
def _auto_pro_license(request):
    """Give most tests a Pro license when feature gating is enabled.

    Module-level ``dependency_overrides`` without ``plan`` previously leaked a
    free context across the whole suite and caused 403s on Pro-only routes.
    """
    if _node_opts_out_of_auto_pro(request.node.nodeid):
        # SECURITY-TEST ISOLATION (audit 2026-07-25): các test trong danh sách này
        # chạy ĐÚNG chuỗi license thật (HMAC + Ed25519 + entitlement). Nếu một module
        # khác gán `app.dependency_overrides[require_license]` ở MỨC MODULE thì lệnh
        # đó chạy lúc pytest COLLECT — tức TRƯỚC mọi test — và rò một license Pro vào
        # đây, khiến `test_free_token_cannot_call_pro_sidecar_endpoints` nhận 200 thay
        # vì 403 (test tự bịt mắt: pass khi chạy riêng, fail/vô nghĩa khi chạy full
        # suite). Dọn sạch override TRƯỚC khi chạy để guard thật được kiểm chứng.
        clear_license_override()
        try:
            yield
        finally:
            # Không "phục hồi" override lạ: mọi test KHÔNG opt-out đều tự cài Pro qua
            # nhánh dưới, nên trả về trạng thái sạch là đúng và ngăn rò tiếp.
            clear_license_override()
        return

    install_license_override(PRO_LICENSE)
    try:
        yield
    finally:
        clear_license_override()
