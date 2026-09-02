"""Cách ly process cho parse file không tin cậy (pentest 2026-08-28 §ATK.04).

Điều cần chứng minh KHÔNG phải "hàm chạy được", mà là: **parser sập thì sidecar vẫn
sống**. Lỗi bộ nhớ trong PDFium/qpdf không raise exception Python — nó giết tiến trình.
Nên các test dưới đây cố tình làm process con chết cứng (`os.abort()`) và đòi rằng tiến
trình test (đóng vai sidecar) vẫn tiếp tục chạy, còn caller nhận lỗi có phân loại.

Các hàm `_worker_*` phải ở CẤP MODULE: `spawn` pickle hàm theo tên nên process con phải
import lại được chúng.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.routes import upload as upload_route
from app.core import parser_sandbox
from app.core.parser_sandbox import (
    IsolatedParseCrashed,
    IsolatedParseTimeout,
    run_isolated,
)
from app.database import get_db
from app.main import app


# ── worker cấp module cho process con ───────────────────────────────────────


def _worker_echo(value):
    return {"echoed": value, "pid": os.getpid()}


def _worker_hard_crash(_ignored=None):
    """Mô phỏng lỗi bộ nhớ của parser C/C++: tiến trình chết, không có exception."""
    os.abort()


def _worker_business_error(_ignored=None):
    raise ValueError("file không hợp lệ theo nghiệp vụ")


def _worker_sleep(seconds):
    time.sleep(seconds)
    return "không bao giờ tới đây"


# ── tầng sandbox ────────────────────────────────────────────────────────────


def test_runs_in_a_different_process():
    """Nếu vẫn cùng PID thì mọi lời hứa cách ly là vô nghĩa — chốt trước tiên."""
    parser_sandbox.reset_pool()
    result = run_isolated(_worker_echo, "xin chào")
    assert result["echoed"] == "xin chào"
    assert result["pid"] != os.getpid(), "worker phải chạy ở process KHÁC"


def test_parser_crash_does_not_kill_the_caller():
    """Ca quan trọng nhất: worker chết cứng → caller sống và nhận lỗi phân loại được."""
    parser_sandbox.reset_pool()
    marker = os.getpid()

    with pytest.raises(IsolatedParseCrashed):
        run_isolated(_worker_hard_crash)

    # Tiến trình test (đóng vai sidecar) vẫn còn đây.
    assert os.getpid() == marker

    # Và pool tự phục hồi: lần gọi sau vẫn dùng được, không cần restart sidecar.
    assert run_isolated(_worker_echo, "sau khi sập")["echoed"] == "sau khi sập"


def test_repeated_crashes_keep_recovering():
    """File độc gửi liên tiếp không được làm treo vĩnh viễn đường mở file."""
    parser_sandbox.reset_pool()
    for _ in range(3):
        with pytest.raises(IsolatedParseCrashed):
            run_isolated(_worker_hard_crash)
    assert run_isolated(_worker_echo, "vẫn sống")["echoed"] == "vẫn sống"


def test_business_exception_passes_through_unchanged():
    """Lỗi nghiệp vụ (PdfError…) phải về nguyên dạng, không bị bọc thành lỗi hạ tầng."""
    parser_sandbox.reset_pool()
    with pytest.raises(ValueError, match="nghiệp vụ"):
        run_isolated(_worker_business_error)


def test_timeout_reclaims_the_worker():
    """Parse treo bị cắt theo trần thời gian và worker được thu hồi."""
    parser_sandbox.reset_pool()
    with pytest.raises(IsolatedParseTimeout):
        run_isolated(_worker_sleep, 30, timeout=1.0)
    # Worker treo đã bị diệt nên pool mới phục vụ được ngay.
    assert run_isolated(_worker_echo, "sau timeout")["echoed"] == "sau timeout"


def test_env_switch_falls_back_to_in_process(monkeypatch):
    """Tắt bằng env thì chạy thẳng trong process hiện tại (đường gỡ lỗi)."""
    parser_sandbox.reset_pool()
    monkeypatch.setenv("PRYNX_PARSER_SANDBOX", "off")
    assert parser_sandbox.sandbox_enabled() is False
    assert run_isolated(_worker_echo, "cùng process")["pid"] == os.getpid()


def test_sandbox_is_on_by_default(monkeypatch):
    """Mặc định phải BẬT: quên đặt env không được âm thầm bỏ cách ly."""
    monkeypatch.delenv("PRYNX_PARSER_SANDBOX", raising=False)
    assert parser_sandbox.sandbox_enabled() is True


# ── nối vào /upload ─────────────────────────────────────────────────────────


class _FakeDB:
    def __init__(self):
        self.row = None
        self.committed = False

    def add(self, row):
        self.row = row

    def flush(self):
        pass

    def commit(self):
        self.committed = True

    def refresh(self, row):
        row.id = "sandbox-test-id"

    def rollback(self):
        pass


@pytest.fixture
def upload_client(tmp_path, monkeypatch):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    db = _FakeDB()
    monkeypatch.setattr(upload_route.settings, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_route.settings, "IS_DESKTOP_APP", False)
    monkeypatch.setattr(upload_route.settings, "DEV_MODE", True)
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app), db, upload_dir
    finally:
        app.dependency_overrides.pop(get_db, None)


def _minimal_pdf() -> bytes:
    import pikepdf

    import io

    buffer = io.BytesIO()
    with pikepdf.Pdf.new() as pdf:
        pdf.add_blank_page(page_size=(595, 842))
        pdf.save(buffer)
    return buffer.getvalue()


def test_upload_survives_parser_crash_and_cleans_up(upload_client, monkeypatch):
    """Parser sập giữa lúc khám file → 400 + không rò file, sidecar vẫn phục vụ tiếp."""
    client, db, upload_dir = upload_client

    def crashing_isolated(_function, *_args, **_kwargs):
        raise IsolatedParseCrashed("worker chết")

    monkeypatch.setattr(upload_route, "run_isolated", crashing_isolated)

    response = client.post(
        "/api/upload",
        files={"file": ("doc-hai.pdf", _minimal_pdf(), "application/pdf")},
    )

    assert response.status_code == 400
    assert "hỏng" in response.json()["detail"]
    assert db.row is None
    # Không để lại bản lưu dở của file gây sập.
    assert list(Path(upload_dir).iterdir()) == []

    # Endpoint khác vẫn sống ngay sau đó (sidecar không bị hạ).
    assert client.get("/health").status_code in {200, 503}


def test_upload_maps_parse_timeout_to_504(upload_client, monkeypatch):
    client, db, upload_dir = upload_client

    def timing_out(_function, *_args, **_kwargs):
        raise IsolatedParseTimeout("Đọc file vượt quá 120 giây và đã được dừng an toàn.")

    monkeypatch.setattr(upload_route, "run_isolated", timing_out)

    response = client.post(
        "/api/upload",
        files={"file": ("cham.pdf", _minimal_pdf(), "application/pdf")},
    )

    assert response.status_code == 504
    assert db.row is None
    assert list(Path(upload_dir).iterdir()) == []


def test_upload_rejects_unknown_intake_status(upload_client, monkeypatch):
    """Hợp đồng lệch giữa hai module phải fail-closed, không ghi nhận upload mù."""
    client, db, upload_dir = upload_client

    monkeypatch.setattr(
        upload_route,
        "run_isolated",
        lambda _function, *_args, **_kwargs: {"status": "trang_thai_la"},
    )

    response = client.post(
        "/api/upload",
        files={"file": ("la.pdf", _minimal_pdf(), "application/pdf")},
    )

    assert response.status_code == 500
    assert db.row is None
    assert list(Path(upload_dir).iterdir()) == []


def test_upload_still_works_end_to_end_through_the_sandbox(upload_client):
    """Đường thật (KHÔNG patch): PDF hợp lệ vẫn đi qua process con và được ghi nhận."""
    client, db, upload_dir = upload_client
    parser_sandbox.reset_pool()

    response = client.post(
        "/api/upload",
        files={"file": ("that.pdf", _minimal_pdf(), "application/pdf")},
    )

    assert response.status_code == 200, response.text
    assert response.json()["page_count"] == 1
    assert db.committed is True
    assert len(list(Path(upload_dir).iterdir())) == 1
