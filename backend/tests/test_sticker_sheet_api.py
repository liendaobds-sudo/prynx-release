"""Hợp đồng API/session cho chế độ Ảnh AI nhiều tem."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
import cv2
import numpy as np
from PIL import Image
import pytest
import pikepdf

from app.workers.sticker_sheet_export import (
    _extract_stickers,
    _png_pages_to_pdf,
    white_boundary_ratio,
)

from app.main import app
from app.core import sticker_sheet_session as session_store


def _png_bytes(size=(120, 80)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, "white").save(buffer, format="PNG", dpi=(300, 300))
    return buffer.getvalue()


def _fake_background(image: Image.Image, _model: str) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = np.zeros((image.height, image.width), dtype=np.uint8)
    alpha[10:40, 10:55] = 255
    alpha[35:72, 68:112] = 255
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


@pytest.fixture(autouse=True)
def isolated_sticker_sessions(tmp_path, monkeypatch):
    for session_id in list(session_store._SESSIONS):
        session_store.close_session(session_id)
    monkeypatch.setattr(session_store, "SESSION_ROOT", tmp_path / "sticker_sessions")
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        _fake_background,
    )
    yield
    for session_id in list(session_store._SESSIONS):
        session_store.close_session(session_id)


def test_analyze_returns_two_instances_and_serves_preview_assets():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["model"] == "birefnet-lite"
        assert len(payload["instances"]) == 2
        assert payload["dpi"][0] == pytest.approx(300, abs=1)
        assert payload["preview_width_px"] == 120
        assert payload["preview_height_px"] == 80

        for field in ("preview_url", "labels_url", "uncertainty_url"):
            asset = client.get(payload[field])
            assert asset.status_code == 200
            assert asset.headers["content-type"].startswith("image/png")
            with Image.open(BytesIO(asset.content)) as image:
                assert image.size == (120, 80)


def test_close_is_idempotent_and_removes_assets():
    with TestClient(app) as client:
        analyzed = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        ).json()
        session_id = analyzed["session_id"]
        assert client.delete(f"/api/sticker-sheet/{session_id}").json() == {"closed": True}
        assert client.get(analyzed["preview_url"]).status_code == 404
        assert client.delete(f"/api/sticker-sheet/{session_id}").json() == {"closed": False}


def test_rejects_non_image_upload_and_invalid_model():
    with TestClient(app) as client:
        bad_file = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("payload.pdf", b"%PDF-1.4", "application/pdf")},
        )
        assert bad_file.status_code == 415

        bad_model = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
            data={"model": "sam-cloud"},
        )
        assert bad_model.status_code == 422


def test_local_path_must_be_absolute_image(tmp_path):
    source = tmp_path / "source.png"
    source.write_bytes(_png_bytes())
    with TestClient(app) as client:
        relative = client.post(
            "/api/sticker-sheet/analyze",
            data={"file_path": "source.png"},
        )
        assert relative.status_code == 400

        response = client.post(
            "/api/sticker-sheet/analyze",
            data={"file_path": str(source)},
        )
        assert response.status_code == 200, response.text


def test_expired_session_is_removed_from_disk():
    with TestClient(app) as client:
        payload = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        ).json()
    session = session_store.get_session(payload["session_id"])
    assert session is not None
    directory = Path(session.directory)
    session.last_access = 0.0

    assert session_store.sweep_expired(now=session_store.SESSION_TTL_SECONDS + 1) == 1
    assert not directory.exists()


def test_warmup_uses_birefnet_lite(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        "app.workers.birefnet_engine.warmup",
        lambda variant: calls.append(variant) or True,
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/warmup",
            data={"model": "birefnet-lite"},
        )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "model": "birefnet-lite"}
    assert calls == ["lite"]


def test_export_pdf_contains_one_cutcontour_page_per_sticker(tmp_path, monkeypatch):
    from app.workers.sticker_engine import StickerEngine

    policies: list[str] = []
    source_pixel_sizes: list[float | None] = []
    process_pdf = StickerEngine.process_pdf

    def capture_policy(self, *args, **kwargs):
        policies.append(kwargs.get("alpha_corner_policy", "legacy"))
        source_pixel_sizes.append(kwargs.get("alpha_source_pixel_mm"))
        return process_pdf(self, *args, **kwargs)

    monkeypatch.setattr(StickerEngine, "process_pdf", capture_policy)
    with TestClient(app) as client:
        analyzed = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        )
        assert analyzed.status_code == 200, analyzed.text
        session_id = analyzed.json()["session_id"]
        response = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={"dpi": 300, "offset_mm": 0, "bleed_mm": 0, "output_format": "pdf"},
        )

    assert response.status_code == 200, response.text
    assert response.headers["X-Sticker-Sheet-Count"] == "2"
    assert policies == ["adaptive"]
    assert source_pixel_sizes == pytest.approx([25.4 / 300.0])
    output = tmp_path / "stickers.pdf"
    output.write_bytes(response.content)
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        for page in pdf.pages:
            resources = page.obj.get("/Resources") or {}
            assert "/ColorSpace" in resources
            streams = page.obj.get("/Contents")
            if isinstance(streams, pikepdf.Array):
                content = b"\n".join(stream.read_bytes() for stream in streams)
            else:
                content = streams.read_bytes()
            assert b"/CutContour CS" in content
            cut_stream = content.split(b"/CutContour CS", 1)[1]
            assert cut_stream.count(b" l\n") == 0
            assert 4 <= cut_stream.count(b" c\n") <= 16


def test_export_pdf_retries_one_transient_opencv_error(monkeypatch):
    from app.workers.sticker_engine import StickerEngine

    process_pdf = StickerEngine.process_pdf
    call_count = 0

    def fail_once(self, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise cv2.error("Lỗi OpenCV nhất thời trong ca kiểm thử")
        return process_pdf(self, *args, **kwargs)

    monkeypatch.setattr(StickerEngine, "process_pdf", fail_once)
    with TestClient(app) as client:
        analyzed = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        )
        assert analyzed.status_code == 200, analyzed.text
        response = client.post(
            f"/api/sticker-sheet/{analyzed.json()['session_id']}/export",
            json={"dpi": 300, "offset_mm": 0, "bleed_mm": 0, "output_format": "pdf"},
        )

    assert response.status_code == 200, response.text
    assert call_count == 2
    assert response.headers["X-Sticker-Sheet-Count"] == "2"


def test_white_boundary_ratio_falls_back_when_opencv_erode_fails(monkeypatch):
    rgba = np.full((20, 24, 4), 255, dtype=np.uint8)
    labels = np.zeros((20, 24), dtype=np.uint32)
    labels[3:17, 4:20] = 1

    def fail_erode(*_args, **_kwargs):
        raise cv2.error("Lỗi OpenCV nhất thời trong ca kiểm thử")

    monkeypatch.setattr(cv2, "erode", fail_erode)

    assert white_boundary_ratio(rgba, labels) == pytest.approx(1.0)


def test_export_png_zip_applies_merge_edit():
    import zipfile

    with TestClient(app) as client:
        analyzed = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        ).json()
        response = client.post(
            f"/api/sticker-sheet/{analyzed['session_id']}/export",
            json={
                "output_format": "png_zip",
                "edits": [{"kind": "merge", "id": "m1", "source_id": 2, "target_id": 1}],
            },
        )

    assert response.status_code == 200, response.text
    assert response.headers["X-Sticker-Sheet-Count"] == "1"
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        assert archive.namelist() == ["tem_001.png"]


def test_white_boundary_detection_ignores_colored_core():
    labels = np.zeros((40, 50), dtype=np.uint16)
    labels[5:35, 5:45] = 1
    rgba = np.zeros((40, 50, 4), dtype=np.uint8)
    rgba[5:35, 5:45] = (255, 255, 255, 255)
    rgba[12:28, 12:38] = (220, 30, 60, 255)
    assert white_boundary_ratio(rgba, labels) > 0.9

    rgba[5:35, 5:45, :3] = (20, 80, 180)
    assert white_boundary_ratio(rgba, labels) == 0.0


def test_non_square_dpi_and_padding_keep_physical_scale(tmp_path):
    labels = np.zeros((20, 30), dtype=np.uint16)
    labels[5:15, 5:25] = 1
    rgba = np.zeros((20, 30, 4), dtype=np.uint8)
    rgba[labels == 1] = (40, 120, 220, 255)

    png_paths = _extract_stickers(tmp_path, rgba, labels, dpi=300, dpi_y=150)
    with Image.open(png_paths[0]) as png:
        assert png.size == (26, 12)  # 0,25 mm -> 3 px ngang, 1 px dọc

    output = tmp_path / "non_square.pdf"
    _png_pages_to_pdf(png_paths, output, dpi=300, dpi_y=150)
    with pikepdf.Pdf.open(output) as pdf:
        box = [float(value) for value in pdf.pages[0].MediaBox]
        assert (box[2] - box[0]) / 72.0 * 25.4 == pytest.approx(26 / 300 * 25.4)
        assert (box[3] - box[1]) / 72.0 * 25.4 == pytest.approx(12 / 150 * 25.4)


def test_png_export_keeps_source_pixels_lossless_without_resampling(tmp_path):
    labels = np.zeros((12, 12), dtype=np.uint16)
    labels[4:8, 4:8] = 1
    rgba = np.zeros((12, 12, 4), dtype=np.uint8)
    yy, xx = np.mgrid[:12, :12]
    rgba[:, :, 0] = xx * 13
    rgba[:, :, 1] = yy * 17
    rgba[:, :, 2] = (xx + yy) * 7
    rgba[:, :, 3] = 255

    paths = _extract_stickers(tmp_path, rgba, labels, dpi=72, dpi_y=72)

    with Image.open(paths[0]) as opened:
        exported = np.asarray(opened.convert("RGBA"), dtype=np.uint8)
        assert opened.info["dpi"] == pytest.approx((72, 72), abs=0.1)
    assert exported.shape == (6, 6, 4)
    assert np.array_equal(exported[1:5, 1:5, :3], rgba[4:8, 4:8, :3])
    assert np.all(exported[1:5, 1:5, 3] == 255)
    assert np.count_nonzero(exported[:, :, 3]) == 16
