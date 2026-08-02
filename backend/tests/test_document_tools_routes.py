from __future__ import annotations

import io
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse
from pypdf import PdfReader, PdfWriter

from app.api.routes import document_tools as routes


def _pdf_bytes() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=144, height=144)
    writer.write(output)
    return output.getvalue()


@pytest.fixture
def isolated_result_dirs(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    results = tmp_path / "results"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(routes.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(routes.settings, "RESULTS_DIR", str(results))
    return uploads, results


def test_copy_upload_file_uses_bounded_chunks(tmp_path):
    class TrackingFile(io.BytesIO):
        def __init__(self, data: bytes):
            super().__init__(data)
            self.read_sizes: list[int] = []

        def read(self, size: int = -1) -> bytes:
            self.read_sizes.append(size)
            return super().read(size)

    payload = b"x" * (routes._UPLOAD_CHUNK_BYTES * 2 + 17)
    source = TrackingFile(payload)
    target = tmp_path / "upload.pdf"

    assert routes._copy_upload_file(source, str(target)) == len(payload)
    assert target.read_bytes() == payload
    assert source.read_sizes
    assert all(size == routes._UPLOAD_CHUNK_BYTES for size in source.read_sizes)


def test_unlock_worker_writes_valid_pdf_to_path(tmp_path):
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    source.write_bytes(_pdf_bytes())

    assert routes._unlock_pdf_to_path(str(source), str(output)) == str(output)
    assert output.read_bytes().startswith(b"%PDF-")
    assert len(PdfReader(str(output)).pages) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("route_name", "helper_name"),
    [
        ("quick_color_space", "_quick_color_space"),
        ("get_pdf_layers", "_get_pdf_layers"),
        ("preview_pdf_layers", "_preview_pdf_layers"),
        ("get_pdf_text", "_get_pdf_text"),
        ("get_pdf_meta", "_get_pdf_meta"),
    ],
)
async def test_document_path_routes_run_sync_work_off_event_loop(
    monkeypatch, route_name, helper_name
):
    caller_thread = threading.get_ident()

    def report_thread(_body: dict) -> int:
        return threading.get_ident()

    monkeypatch.setattr(routes, helper_name, report_thread)

    worker_thread = await getattr(routes, route_name)({})

    assert worker_thread != caller_thread


@pytest.mark.asyncio
async def test_unlock_route_offloads_worker_and_cleans_after_response(
    monkeypatch, isolated_result_dirs
):
    caller_thread = threading.get_ident()
    worker_threads: list[int] = []
    payload = _pdf_bytes()

    def fake_unlock(_source_path: str, output_path: str) -> str:
        worker_threads.append(threading.get_ident())
        Path(output_path).write_bytes(payload)
        return output_path

    monkeypatch.setattr(routes, "_unlock_pdf_to_path", fake_unlock)
    upload = UploadFile(filename="TEST.PDF", file=io.BytesIO(payload))

    response = await routes.unlock_pdf(upload, {})

    assert isinstance(response, FileResponse)
    assert Path(response.path).read_bytes() == payload
    assert worker_threads and worker_threads[0] != caller_thread
    assert response.background is not None
    await response.background()
    uploads, results = isolated_result_dirs
    assert list(uploads.iterdir()) == []
    assert list(results.iterdir()) == []


@pytest.mark.asyncio
async def test_unlock_route_rejects_zero_byte_and_cleans(isolated_result_dirs):
    upload = UploadFile(filename="empty.pdf", file=io.BytesIO())

    with pytest.raises(HTTPException) as exc_info:
        await routes.unlock_pdf(upload, {})

    assert exc_info.value.status_code == 400
    uploads, results = isolated_result_dirs
    assert list(uploads.iterdir()) == []
    assert list(results.iterdir()) == []


@pytest.mark.asyncio
async def test_unlock_route_failure_is_terminal_and_cleans(
    monkeypatch, isolated_result_dirs
):
    def fail_unlock(_source_path: str, _output_path: str) -> str:
        raise ValueError("corrupt fixture")

    monkeypatch.setattr(routes, "_unlock_pdf_to_path", fail_unlock)
    upload = UploadFile(filename="corrupt.pdf", file=io.BytesIO(b"not-a-pdf"))

    with pytest.raises(HTTPException):
        await routes.unlock_pdf(upload, {})

    uploads, results = isolated_result_dirs
    assert list(uploads.iterdir()) == []
    assert list(results.iterdir()) == []
