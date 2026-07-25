"""Session-wide pytest fixtures for backend tests."""
from __future__ import annotations

import os
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

# Tests that exercise the real license/token path must not get an auto Pro override.
_SKIP_AUTO_PRO = (
    "test_free_token_e2e",
    "test_license_token",
    "test_dieline_feature_gate",
    "test_feature_entitlements",
)


def _node_opts_out_of_auto_pro(nodeid: str) -> bool:
    return any(name in nodeid for name in _SKIP_AUTO_PRO)


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
