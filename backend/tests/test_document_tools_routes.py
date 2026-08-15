from __future__ import annotations

import io
import threading
from pathlib import Path

import pytest
import pikepdf
from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject

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


def test_pdf_meta_guillotine_footprint_uses_page_and_ignores_embedded_trimbox(tmp_path):
    source = tmp_path / "mixed-guillotine-meta.pdf"
    writer = PdfWriter()
    first = writer.add_blank_page(width=200, height=100)
    first.trimbox = RectangleObject((10, 10, 190, 90))
    second = writer.add_blank_page(width=120, height=70)
    with source.open("wb") as stream:
        writer.write(stream)

    result = routes._get_pdf_meta({"path": str(source)})

    assert [
        (page["guillotine_width_pt"], page["guillotine_height_pt"])
        for page in result["pages"]
    ] == [(200.0, 100.0), (120.0, 70.0)]


def test_pdf_meta_visible_policy_matches_cropbox_without_changing_imposition_default(tmp_path):
    """Viewer fallback dùng CropBox nhìn thấy; bình bản vẫn giữ policy MediaBox."""
    source = tmp_path / "viewer-visible-page-box.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=100)
    page.cropbox = RectangleObject((3, 3, 197, 97))
    with source.open("wb") as stream:
        writer.write(stream)

    imposition = routes._get_pdf_meta({"path": str(source)})
    visible = routes._get_pdf_meta({
        "path": str(source),
        "page_box_policy": "visible",
    })

    assert (
        imposition["pages"][0]["width_pt"],
        imposition["pages"][0]["height_pt"],
    ) == (200.0, 100.0)
    assert (
        visible["pages"][0]["width_pt"],
        visible["pages"][0]["height_pt"],
    ) == (194.0, 94.0)
    assert (visible["max_width_pt"], visible["max_height_pt"]) == (194.0, 94.0)


def test_pdf_meta_applies_user_unit_to_all_physical_measurements(tmp_path):
    """PAGEBOX (audit 2026-08-04 §W1.PB3): mọi khổ/bleed cùng hệ point vật lý."""
    source = tmp_path / "user-unit-meta.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=50)
    with source.open("wb") as stream:
        writer.write(stream)
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as pdf:
        page = pdf.pages[0].obj
        page[pikepdf.Name("/UserUnit")] = 2
        page[pikepdf.Name("/TrimBox")] = pikepdf.Array([5, 5, 95, 45])
        pdf.save(source)

    result = routes._get_pdf_meta({"path": str(source)})
    page = result["pages"][0]

    assert (page["width_pt"], page["height_pt"]) == (200.0, 100.0)
    assert (page["media_width_pt"], page["media_height_pt"]) == (200.0, 100.0)
    # BLEED-UI (audit 2026-08-12 §SRPARITY.1): footprint dùng khổ trang;
    # TrimBox chỉ giúp nhận diện bleed mặc định và không được ghi đè bleed UI.
    assert (page["guillotine_width_pt"], page["guillotine_height_pt"]) == (
        200.0,
        100.0,
    )
    assert result["detected_bleed_mm"] == pytest.approx(3.53, abs=0.01)


def test_pdf_meta_summary_reads_only_first_page_but_keeps_total_count(tmp_path):
    source = tmp_path / "summary-meta.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=100)
    writer.add_blank_page(width=300, height=200)
    writer.add_blank_page(width=400, height=300)
    with source.open("wb") as stream:
        writer.write(stream)

    result = routes._get_pdf_meta({"path": str(source), "summary_only": True})

    assert result["page_count"] == 3
    assert len(result["pages"]) == 1
    assert (result["pages"][0]["media_width_pt"], result["pages"][0]["media_height_pt"]) == (
        200.0,
        100.0,
    )


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
