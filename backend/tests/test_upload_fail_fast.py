"""Kiểm thử fail-fast cho hai đường nhận PDF của ứng dụng."""
from __future__ import annotations

import asyncio
import io
import threading
from pathlib import Path

import httpx
import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.api.routes import upload as upload_route
from app.core.pdf_processor import PDFProcessor
from app.database import get_db
from app.main import app


class FakeDB:
    """DB tối thiểu để quan sát commit/rollback mà không ghi SQLite thật."""

    def __init__(self, *, fail_commit: bool = False):
        self.fail_commit = fail_commit
        self.row = None
        self.committed = False
        self.rolled_back = False

    def add(self, row):
        self.row = row

    def flush(self):
        pass

    def commit(self):
        if self.fail_commit:
            raise RuntimeError("database unavailable")
        self.committed = True

    def refresh(self, row):
        row.id = "upload-test-id"

    def rollback(self):
        self.rolled_back = True


def _pdf_bytes(*, page_count: int = 1, password: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with pikepdf.Pdf.new() as pdf:
        for _ in range(page_count):
            pdf.add_blank_page(page_size=(595, 842))
        encryption = (
            pikepdf.Encryption(owner="owner-secret", user=password, R=6)
            if password is not None
            else None
        )
        pdf.save(buffer, encryption=encryption)
    return buffer.getvalue()


@pytest.fixture
def upload_api(tmp_path, monkeypatch):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    db = FakeDB()

    monkeypatch.setattr(upload_route.settings, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_route.settings, "IS_DESKTOP_APP", False)
    monkeypatch.setattr(upload_route.settings, "DEV_MODE", True)
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app), db, upload_dir
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.parametrize(
    ("filename", "content", "expected_text"),
    [
        ("rong.pdf", b"", "rỗng"),
        ("doi-duoi.pdf", b"\x89PNG\r\n\x1a\nnot-a-pdf", "không phải PDF"),
        ("bi-hong.pdf", _pdf_bytes()[:-32], "bị hỏng"),
        ("khong-trang.pdf", _pdf_bytes(page_count=0), "không có trang"),
        ("co-mat-khau.pdf", _pdf_bytes(password="secret"), "mật khẩu"),
        ("ma-hoa.pdf", _pdf_bytes(password=""), "mã hóa"),
    ],
)
def test_multipart_rejects_unusable_pdf_and_removes_stored_copy(
    upload_api,
    filename,
    content,
    expected_text,
):
    client, db, upload_dir = upload_api

    response = client.post(
        "/api/upload",
        files={"file": (filename, content, "application/pdf")},
    )

    assert response.status_code in {400, 422}
    assert expected_text in response.json()["detail"]
    assert db.row is None
    assert list(upload_dir.iterdir()) == []


def test_multipart_only_accepts_pdf_extension(upload_api):
    client, db, upload_dir = upload_api

    response = client.post(
        "/api/upload",
        files={"file": ("anh.png", b"\x89PNG\r\n\x1a\n", "image/png")},
    )

    assert response.status_code == 415
    assert "PDF" in response.json()["detail"]
    assert db.row is None
    assert list(upload_dir.iterdir()) == []


def test_multipart_accepts_valid_uppercase_pdf(upload_api):
    client, db, upload_dir = upload_api
    content = _pdf_bytes()

    response = client.post(
        "/api/upload",
        files={"file": ("BAN-IN.PDF", content, "application/pdf")},
    )

    assert response.status_code == 200
    assert response.json()["page_count"] == 1
    assert response.json()["original_name"] == "BAN-IN.PDF"
    assert db.committed is True
    assert db.row is not None
    assert Path(db.row.file_path).read_bytes() == content
    assert len(list(upload_dir.iterdir())) == 1


def test_local_zero_byte_fails_without_deleting_source(upload_api, tmp_path):
    client, db, upload_dir = upload_api
    source = tmp_path / "source.pdf"
    source.write_bytes(b"")

    response = client.post("/api/upload/local", json={"file_path": str(source)})

    assert response.status_code == 400
    assert "rỗng" in response.json()["detail"]
    assert source.is_file()
    assert source.read_bytes() == b""
    assert db.row is None
    assert list(upload_dir.iterdir()) == []


def test_metadata_failure_is_500_and_removes_stored_copy(upload_api, monkeypatch):
    client, db, upload_dir = upload_api

    def fail_metadata(_self, _path):
        raise RuntimeError("metadata parser failed")

    # SEC (pentest 2026-08-28 §ATK.04): việc đọc metadata giờ chạy trong PROCESS CON, nên
    # monkeypatch ở tiến trình cha không với tới worker được. Tắt sandbox cho đúng ca này
    # để vẫn kiểm được hợp đồng thật "lỗi đọc metadata → 500 + dọn bản lưu" trên code
    # thật (thay vì giả lập kết quả). Đường cách ly có test riêng ở
    # `test_parser_sandbox.py` (gồm ca parser sập).
    monkeypatch.setenv("PRYNX_PARSER_SANDBOX", "off")
    monkeypatch.setattr(PDFProcessor, "get_metadata", fail_metadata)

    response = client.post(
        "/api/upload",
        files={"file": ("hop-le.pdf", _pdf_bytes(), "application/pdf")},
    )

    assert response.status_code == 500
    assert "thông tin PDF" in response.json()["detail"]
    assert db.row is None
    assert list(upload_dir.iterdir()) == []


def test_database_failure_rolls_back_and_removes_stored_copy(upload_api):
    client, _db, upload_dir = upload_api
    failing_db = FakeDB(fail_commit=True)
    app.dependency_overrides[get_db] = lambda: failing_db

    response = client.post(
        "/api/upload",
        files={"file": ("hop-le.pdf", _pdf_bytes(), "application/pdf")},
    )

    assert response.status_code == 500
    assert "ghi nhận file PDF" in response.json()["detail"]
    assert failing_db.rolled_back is True
    assert failing_db.row is not None
    assert not Path(failing_db.row.file_path).exists()
    assert list(upload_dir.iterdir()) == []


@pytest.mark.asyncio
async def test_multipart_pdf_inspection_does_not_block_health_endpoint(
    upload_api,
    monkeypatch,
):
    _client, _db, _upload_dir = upload_api
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def slow_inspection(_path):
        started.set()
        release.wait(timeout=2)
        finished.set()
        return {
            "page_count": 1,
            "pages": [{"page_number": 1, "width_pt": 595, "height_pt": 842}],
        }, 1

    monkeypatch.setattr(upload_route, "_validate_pdf_and_extract_metadata", slow_inspection)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        upload_task = asyncio.create_task(
            client.post(
                "/api/upload",
                files={"file": ("cham.pdf", b"%PDF-test", "application/pdf")},
            )
        )
        assert await asyncio.to_thread(started.wait, 1)
        assert finished.is_set() is False

        health = await asyncio.wait_for(client.get("/health"), timeout=0.5)
        assert health.status_code in {200, 503}
        assert finished.is_set() is False

        release.set()
        response = await asyncio.wait_for(upload_task, timeout=1)

    assert response.status_code == 200
