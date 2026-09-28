"""WBR28: kiểm hợp đồng xóa/phủ viền từ API, DB đến PDF tải về."""
from contextlib import closing
import io
from pathlib import Path
import uuid

from fastapi.testclient import TestClient
import numpy as np
import pikepdf
import pytest

from app.config import settings
from app.core import feature_entitlements
from app.core.pdfium_lock import pdfium_guard
from app.database import SessionLocal
from app.main import app
from app.models.job import UploadedFile
from tests.license_helpers import FREE_LICENSE, install_license_override

pdfium = pytest.importorskip("pypdfium2")
SIDES = ["left", "top", "right", "bottom"]


@pytest.fixture
def uploaded_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    records = []

    def create(*, blank_second=False, transparent_second=False):
        source = tmp_path / f"source_{uuid.uuid4().hex}.pdf"
        with pikepdf.Pdf.new() as pdf:
            for index in range(3):
                page = pdf.add_blank_page(page_size=(200, 100))
                page.CropBox = pikepdf.Array([0, 0, 200, 100])
                page.TrimBox = pikepdf.Array([5, 5, 195, 95])
                # Artwork lệch tâm để bắt cách ghép crop/resize tự căn giữa.
                content = b"0 0 1 rg 30 20 100 50 re f\n0 0 0 rg 51 33 7 13 re f\n"
                if transparent_second and index == 1:
                    page.Resources.ExtGState = pikepdf.Dictionary({
                        "/Half": pikepdf.Dictionary(ca=0.5, CA=0.5),
                    })
                    content = b"/Half gs\n" + content
                page.Contents = pikepdf.Stream(pdf, b"" if blank_second and index == 1 else content)
            pdf.save(source)
        file_id = str(uuid.uuid4())
        with SessionLocal() as db:
            db.add(UploadedFile(
                id=file_id, filename=source.name, original_name=source.name,
                file_path=str(source), file_size=source.stat().st_size, page_count=3,
            ))
            db.commit()
        records.append(file_id)
        return file_id, source

    yield create
    with SessionLocal() as db:
        for file_id in records:
            record = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
            if record:
                db.delete(record)
        db.commit()


def _rgb(data, index=0):
    with pdfium_guard("test_border_treatment_api"):
        with pdfium.PdfDocument(data) as doc:
            with closing(doc[index]) as page:
                with closing(page.render(scale=2)) as bitmap:
                    return np.array(bitmap.to_pil().convert("RGB"), copy=True)


def _post_and_download(client, file_id, **options):
    response = client.post("/api/preflight/auto-trim", json={
        "file_id": file_id, "trim_sides": SIDES, **options,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is True
    assert body["mode"] == options.get("mode", "trim")
    downloaded = client.get(f'/api/preflight/download/{body["output_filename"]}')
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content.startswith(b"%PDF-")
    return downloaded.content


def _outputs():
    return list((Path(settings.RESULTS_DIR) / "preflight_output").glob("*.pdf"))


def test_legacy_request_defaults_to_trim(uploaded_pdf):
    file_id, source = uploaded_pdf()
    source_bytes = source.read_bytes()
    with closing(TestClient(app)) as client:
        legacy = _post_and_download(client, file_id)
        explicit = _post_and_download(client, file_id, mode="trim")
    for result in (legacy, explicit):
        with pikepdf.Pdf.open(io.BytesIO(result)) as pdf:
            assert list(pdf.pages[0].MediaBox) == pytest.approx([30, 20, 130, 70], abs=0.6)
    np.testing.assert_array_equal(_rgb(legacy), _rgb(explicit))
    assert source.read_bytes() == source_bytes


@pytest.mark.parametrize("mode", ["", "mirror", None, 1, []])
def test_invalid_mode_rejected_without_artifact(uploaded_pdf, mode):
    file_id, source = uploaded_pdf()
    source_bytes = source.read_bytes()
    with closing(TestClient(app)) as client:
        response = client.post("/api/preflight/auto-trim", json={"file_id": file_id, "mode": mode})
    assert response.status_code == 422
    assert _outputs() == []
    assert source.read_bytes() == source_bytes


def test_fill_preserves_size_artwork_and_unequal_borders(uploaded_pdf):
    file_id, source = uploaded_pdf()
    source_bytes = source.read_bytes()
    with closing(TestClient(app)) as client:
        result = _post_and_download(client, file_id, mode="fill")
    with pikepdf.Pdf.open(io.BytesIO(result)) as pdf:
        assert len(pdf.pages) == 3
        assert list(pdf.pages[0].MediaBox) == [0, 0, 200, 100]
        assert list(pdf.pages[0].CropBox) == [0, 0, 200, 100]
        assert list(pdf.pages[0].TrimBox) == [5, 5, 195, 95]
    before, after = _rgb(source_bytes), _rgb(result)
    assert after.shape == before.shape == (200, 400, 3)
    np.testing.assert_array_equal(after[65:155, 65:255], before[65:155, 65:255])
    # Bốn vùng viền lấy màu xanh; marker đen lệch tâm trong artwork không dịch.
    for y, x in ((10, 100), (190, 100), (90, 10), (90, 390)):
        assert after[y, x, 2] > 240 and after[y, x, 0] < 10
    np.testing.assert_array_equal(np.all(after < 20, axis=2), np.all(before < 20, axis=2))
    assert source.read_bytes() == source_bytes


def test_fill_only_requested_page_and_edge(uploaded_pdf):
    file_id, source = uploaded_pdf()
    original = source.read_bytes()
    with closing(TestClient(app)) as client:
        result = _post_and_download(client, file_id, mode="fill", pages=[2], trim_sides=["right"])
    for index in (0, 2):
        np.testing.assert_array_equal(_rgb(result, index), _rgb(original, index))
    before, after = _rgb(original, 1), _rgb(result, 1)
    # Phần không thuộc viền phải phải giữ đúng ảnh nguồn.
    np.testing.assert_array_equal(after[:, :255], before[:, :255])
    assert np.all(after[75:150, 280:390, 2] > 240)
    assert np.all(after[75:150, 280:390, 0] < 10)


@pytest.mark.parametrize("mode", ["trim", "fill"])
def test_required_edge_failure_is_atomic_and_actionable(uploaded_pdf, mode):
    file_id, source = uploaded_pdf(blank_second=True)
    source_bytes = source.read_bytes()
    with closing(TestClient(app)) as client:
        response = client.post("/api/preflight/auto-trim", json={
            "file_id": file_id, "mode": mode, "trim_sides": SIDES,
        })
    assert response.status_code == 422, response.text
    assert "Trang 2" in response.json()["detail"]
    assert _outputs() == []
    assert source.read_bytes() == source_bytes


def test_fill_rejects_trim_margin(uploaded_pdf):
    file_id, _source = uploaded_pdf()
    with closing(TestClient(app)) as client:
        response = client.post("/api/preflight/auto-trim", json={
            "file_id": file_id, "mode": "fill", "margin_mm": 1,
        })
    assert response.status_code == 422, response.text
    assert _outputs() == []


def test_unknown_file_id_stays_not_found(uploaded_pdf):
    uploaded_pdf()
    with closing(TestClient(app)) as client:
        response = client.post("/api/preflight/auto-trim", json={
            "file_id": str(uuid.uuid4()), "mode": "fill",
        })
    assert response.status_code == 404
    assert _outputs() == []


@pytest.mark.parametrize("mode", ["trim", "fill"])
def test_border_treatment_keeps_crop_entitlement(uploaded_pdf, monkeypatch, mode):
    file_id, _source = uploaded_pdf()
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    install_license_override(FREE_LICENSE)
    with closing(TestClient(app)) as client:
        _post_and_download(client, file_id, mode=mode)


def test_unexpected_engine_error_stays_server_error(uploaded_pdf, monkeypatch):
    from app.core.page_boxes import PageBoxesEngine

    file_id, source = uploaded_pdf()
    source_bytes = source.read_bytes()

    def fail(*_args, **_kwargs):
        raise RuntimeError("Không ghi được PDF kiểm thử.")

    monkeypatch.setattr(PageBoxesEngine, "auto_trim", fail)
    with closing(TestClient(app)) as client:
        response = client.post("/api/preflight/auto-trim", json={
            "file_id": file_id, "mode": "fill", "trim_sides": SIDES,
        })
    assert response.status_code == 500
    assert _outputs() == []
    assert source.read_bytes() == source_bytes


def test_fill_transparency_failure_is_atomic(uploaded_pdf):
    file_id, source = uploaded_pdf(transparent_second=True)
    original = source.read_bytes()
    with closing(TestClient(app)) as client:
        response = client.post("/api/preflight/auto-trim", json={
            "file_id": file_id, "mode": "fill", "trim_sides": SIDES,
        })
    assert response.status_code == 422, response.text
    assert "Trang 2" in response.json()["detail"]
    assert "trong suốt" in response.json()["detail"]
    assert _outputs() == []
    assert source.read_bytes() == original
