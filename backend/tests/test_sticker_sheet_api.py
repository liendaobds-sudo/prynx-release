"""Hợp đồng API/session cho chế độ Ảnh AI nhiều tem."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
import threading

from fastapi import UploadFile
from fastapi.testclient import TestClient
import cv2
import numpy as np
from PIL import Image, ImageDraw
import pytest
import pikepdf

from app.workers.sticker_sheet_export import (
    _extract_stickers,
    _png_pages_to_pdf,
    white_boundary_ratio,
)

from app.main import app
from app.core import sticker_sheet_session as session_store
from app.api.routes import sticker_sheet as sticker_sheet_route
from app.api.routes.sticker_sheet import detect_sticker_source_endpoint
from app.schemas.sticker_sheet import StickerSourceDetectRequest


def _png_bytes(size=(120, 80)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, "white").save(buffer, format="PNG", dpi=(300, 300))
    return buffer.getvalue()


def _alpha_png_bytes(size=(120, 80), dpi=(300, 150)) -> bytes:
    rgba = Image.new("RGBA", size, (0, 0, 0, 0))
    rgba.paste((30, 120, 220, 255), (10, 8, size[0] - 10, size[1] - 8))
    buffer = BytesIO()
    rgba.save(buffer, format="PNG", dpi=dpi)
    return buffer.getvalue()


def _complex_png_bytes(size=(120, 80)) -> bytes:
    yy, xx = np.mgrid[: size[1], : size[0]]
    rgb = np.dstack((
        (xx * 5 + yy * 3) % 256,
        (xx * 2 + yy * 7) % 256,
        (xx * 11 + yy) % 256,
    )).astype(np.uint8)
    buffer = BytesIO()
    Image.fromarray(rgb, "RGB").save(buffer, format="PNG")
    return buffer.getvalue()


def _pdf_bytes(
    *,
    pages: int = 1,
    cut_contour: bool = False,
    cut_pages: set[int] | None = None,
    paint_cut: bool = True,
) -> bytes:
    document = pikepdf.Pdf.new()
    for page_index in range(pages):
        page = document.add_blank_page(page_size=(144, 72))
        resources = pikepdf.Dictionary()
        content = b"0 0 1 RG 10 10 124 52 re S\n"
        page_has_cut = cut_contour if cut_pages is None else page_index in cut_pages
        if page_has_cut:
            tint = pikepdf.Dictionary({
                "/FunctionType": 2,
                "/Domain": pikepdf.Array([0, 1]),
                "/C0": pikepdf.Array([0, 0, 0, 0]),
                "/C1": pikepdf.Array([0, 1, 0, 0]),
                "/N": 1,
            })
            color_spaces = pikepdf.Dictionary()
            color_spaces["/CSCut"] = pikepdf.Array([
                pikepdf.Name.Separation,
                pikepdf.Name.CutContour,
                pikepdf.Name.DeviceCMYK,
                tint,
            ])
            resources["/ColorSpace"] = color_spaces
            if paint_cut:
                content = b"/CSCut CS 1 SCN 10 10 124 52 re S\n"
        page.obj["/Resources"] = resources
        page.obj["/Contents"] = document.make_stream(content)
    buffer = BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()


def _pdf_circle_path(center_x: float, center_y: float, radius: float) -> str:
    handle = radius * 0.5522847498
    return (
        f"{center_x + radius} {center_y} m "
        f"{center_x + radius} {center_y + handle} "
        f"{center_x + handle} {center_y + radius} {center_x} {center_y + radius} c "
        f"{center_x - handle} {center_y + radius} "
        f"{center_x - radius} {center_y + handle} {center_x - radius} {center_y} c "
        f"{center_x - radius} {center_y - handle} "
        f"{center_x - handle} {center_y - radius} {center_x} {center_y - radius} c "
        f"{center_x + handle} {center_y - radius} "
        f"{center_x + radius} {center_y - handle} {center_x + radius} {center_y} c h"
    )


def _multi_artwork_vector_pdf_bytes() -> bytes:
    """Tạo tờ PDF vector năm artwork rời, không có CutContour."""
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(600, 400))
    rectangles = (
        (35, 245, 120, 105, "0.86 0.12 0.18"),
        (175, 245, 120, 105, "0.12 0.42 0.86"),
        (315, 245, 120, 105, "0.12 0.68 0.42"),
        (105, 55, 120, 105, "0.88 0.56 0.08"),
        (375, 55, 120, 105, "0.48 0.18 0.78"),
    )
    commands = ["1 1 1 rg 0 0 600 400 re f"]
    for index, (x, y, width, height, color) in enumerate(rectangles, start=1):
        if index in {1, 3, 5}:
            commands.append(
                f"{color} rg "
                + _pdf_circle_path(
                    x + width / 2.0,
                    y + height / 2.0,
                    min(width, height) * 0.47,
                )
                + " f"
            )
        else:
            commands.append(f"{color} rg {x} {y} {width} {height} re f")
    page.obj["/Resources"] = pikepdf.Dictionary()
    page.obj["/Contents"] = document.make_stream(
        ("\n".join(commands) + "\n").encode("ascii")
    )
    buffer = BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()


def _palette_alpha_png_bytes() -> bytes:
    image = Image.new("P", (40, 30), 0)
    palette = [255, 255, 255, 20, 100, 220] + [0, 0, 0] * 254
    image.putpalette(palette)
    image.paste(1, (5, 4, 35, 26))
    buffer = BytesIO()
    image.save(buffer, format="PNG", transparency=0)
    return buffer.getvalue()


def _rotated_jpeg_bytes() -> bytes:
    image = Image.new("RGB", (40, 20), (220, 40, 80))
    exif = Image.Exif()
    exif[274] = 6
    buffer = BytesIO()
    image.save(buffer, format="JPEG", dpi=(200, 100), exif=exif)
    return buffer.getvalue()


def _form_image_pdf_bytes() -> bytes:
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(72, 72))
    image = pikepdf.Stream(document, b"\xff\xff\xff" * 4)
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = 2
    image.Height = 2
    image.BitsPerComponent = 8
    image.ColorSpace = pikepdf.Name.DeviceRGB
    form = pikepdf.Stream(document, b"q 36 0 0 36 0 0 cm /Im0 Do Q")
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([0, 0, 72, 72])
    form.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=document.make_indirect(image)),
    )
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Fm0=document.make_indirect(form)),
    )
    page.Contents = document.make_stream(b"/Fm0 Do")
    buffer = BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()


COREL_CUT_FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "app" / "workers" / "cut_export" / "tests" / "fixtures" / "corel_cut_sample.pdf"
)


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


def test_export_tai_su_dung_bezier_vua_preview_thay_vi_fit_lai(monkeypatch):
    with TestClient(app) as client:
        analyzed = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        )
        assert analyzed.status_code == 200, analyzed.text
        session_id = analyzed.json()["session_id"]
        previewed = client.post(
            f"/api/sticker-sheet/{session_id}/cutline-preview",
            json={
                "base_revision": 1,
                "page_number": 1,
                "edits": [],
                "dpi": 300,
                "dpi_y": 300,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": True,
                "cutline_smoothness": 50,
                "cutline_fidelity": 50,
                "curve_tension": 50,
                "min_detail_area_mm2": 1,
            },
        )
        assert previewed.status_code == 200, previewed.text
        assert len(previewed.json()["paths"]) == 2

        def forbidden_refit(*_args, **_kwargs):
            pytest.fail("Export đã fit lại dù cache Bézier preview khớp tuyệt đối")

        monkeypatch.setattr(
            "app.workers.sticker_sheet_export.build_alpha_cutline_geometry",
            forbidden_refit,
        )
        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={
                "dpi": 300,
                "dpi_y": 300,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": True,
                "cutline_smoothness": 50,
                "cutline_fidelity": 50,
                "curve_tension": 50,
                "min_detail_area_mm2": 1,
                "crop_to_sticker": True,
                "preserve_existing_cut": False,
                "output_format": "pdf",
            },
        )

    assert exported.status_code == 200, exported.text
    assert exported.headers["X-Sticker-Sheet-Count"] == "2"


def test_cutline_preview_chi_tra_svg_khong_chay_xuat_pdf(monkeypatch):
    """Realtime preview không được gọi StickerEngine hoặc sinh artifact PDF."""
    def forbidden_process_pdf(*_args, **_kwargs):
        pytest.fail("Preview SVG đã gọi nhầm luồng xuất PDF đầy đủ")

    monkeypatch.setattr(
        "app.workers.sticker_engine.StickerEngine.process_pdf",
        forbidden_process_pdf,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "alpha", "page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        response = client.post(
            f"/api/sticker-sheet/{session_id}/cutline-preview",
            json={
                "base_revision": 1,
                "page_number": 1,
                "edits": [],
                "dpi": 300,
                "dpi_y": 150,
                "corner_style": "round",
                "curve_tension": 80,
            },
        )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["paths"][0]["d"].startswith("M ")
    assert not list(session_store.SESSION_ROOT.rglob("*.pdf"))


def test_detect_preview_only_truyen_hop_dong_fast_path_den_pipeline(monkeypatch):
    """API preview classic không được vô tình bỏ cờ rồi nạp AI nâng hình học."""
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    ImageDraw.Draw(image).ellipse((38, 28, 282, 212), fill=(78, 12, 10))
    source = BytesIO()
    image.save(source, format="PNG")

    def forbidden_ai(*_args, **_kwargs):
        raise AssertionError("API đã làm mất cờ preview_only")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        forbidden_ai,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("fast-preview.png", source.getvalue(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        detected = client.post(
            f"/api/sticker-sheet/{inspected.json()['session_id']}/detect",
            json={
                "strategy": "auto",
                "page_number": 1,
                "preview_only": True,
            },
        )

    assert detected.status_code == 200, detected.text
    assert detected.json()["boundary_source"] == "simple-bg"
    assert len(detected.json()["instances"]) == 1


def test_detect_custom_pdf_cung_session_khong_ai_va_retry_phai_khop_lua_chon(monkeypatch):
    def forbidden_ai(*_args, **_kwargs):
        raise AssertionError("Chọn đối tượng không dùng AI hoặc hàng đợi heavy")

    monkeypatch.setattr(sticker_sheet_route, "run_heavy_in_threadpool", forbidden_ai)
    monkeypatch.setattr("app.workers.sticker_source_pipeline.analyze_sticker_sheet", forbidden_ai)
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("custom.pdf", _multi_artwork_vector_pdf_bytes(), "application/pdf")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        endpoint = f"/api/sticker-sheet/{session_id}/detect"
        detected = client.post(endpoint, json={"strategy": "ai", "object_ids": ["vector-1", "vector-3"]})
        assert detected.status_code == 200, detected.text
        payload = detected.json()
        assert payload["session_id"] == session_id
        assert payload["boundary_source"] == "manual"
        assert payload["vector_geometry_ref"] == {
            "kind": "pdf-object-selection", "source_page": 1,
            "object_ids": ["vector-1", "vector-3"], "preserve_original": True,
        }
        assert len(payload["instances"]) == 2
        for field in ("preview_url", "labels_url", "uncertainty_url"):
            assert client.get(payload[field]).status_code == 200
        repeated = client.post(endpoint, json={"object_ids": ["vector-3", "vector-1", "vector-1"]})
        assert repeated.status_code == 200, repeated.text
        assert repeated.json()["mask_revision"] == payload["mask_revision"]
        assert client.post(endpoint, json={"object_ids": ["vector-2"]}).status_code == 409
        assert client.post(endpoint, json={}).status_code == 409


@pytest.mark.parametrize("object_ids", [[], [1], [None], ["vector-1", "bad-id"], "vector-1"])
def test_detect_custom_pdf_payload_sai_khong_chay_nhan_dien(object_ids):
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("custom.pdf", _pdf_bytes(), "application/pdf")},
        )
        session_id = inspected.json()["session_id"]
        detected = client.post(f"/api/sticker-sheet/{session_id}/detect", json={"object_ids": object_ids})
        assert detected.status_code == 422, detected.text
        assert session_store.get_session(session_id).stage == "inspected"


def test_detect_custom_pdf_id_mat_tra422_va_cho_phep_chon_lai():
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("custom.pdf", _pdf_bytes(), "application/pdf")},
        )
        session_id = inspected.json()["session_id"]
        endpoint = f"/api/sticker-sheet/{session_id}/detect"
        missing = client.post(endpoint, json={"object_ids": ["vector-99"]})
        assert missing.status_code == 422, missing.text
        assert session_store.get_session(session_id).stage == "inspected"
        assert client.post(endpoint, json={"object_ids": ["vector-0"]}).status_code == 200


def test_detect_auto_roi_custom_khong_duoc_tra_cache_auto():
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("custom.pdf", _pdf_bytes(), "application/pdf")},
        )
        endpoint = f"/api/sticker-sheet/{inspected.json()['session_id']}/detect"
        assert client.post(endpoint, json={"strategy": "vector"}).status_code == 200
        assert client.post(endpoint, json={"object_ids": ["vector-0"]}).status_code == 409


def test_redetect_custom_pdf_tang_revision_va_khong_thay_trang_khac():
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("two-pages.pdf", _pdf_bytes(pages=2), "application/pdf")},
        )
        session_id = inspected.json()["session_id"]
        endpoint = f"/api/sticker-sheet/{session_id}/detect"
        for page_number in (1, 2):
            assert client.post(endpoint, json={"page_number": page_number, "strategy": "vector"}).status_code == 200
            assert client.post(
                f"/api/sticker-sheet/{session_id}/confirm", json={"page_number": page_number},
            ).status_code == 200
        session = session_store.get_session(session_id)
        sibling, target = session.pages[1], session.pages[2]
        sibling_manifest = dict(sibling.manifest)
        sibling_files = {path.name: path.read_bytes() for path in sibling.directory.iterdir() if path.is_file()}
        sibling.cutline_export_cache = {"fingerprint": "sibling-preview"}
        target.cutline_export_cache = {"fingerprint": "old-target-preview"}
        changed = client.post(endpoint, json={
            "page_number": 2, "object_ids": ["vector-0"], "base_revision": 1,
        })
        assert changed.status_code == 200, changed.text
        assert changed.json()["mask_revision"] == 2
        assert changed.json()["boundary_source"] == "manual"
        assert not target.manifest["mask_confirmed"]
        assert target.cutline_export_cache is None
        assert sibling.manifest == sibling_manifest
        assert sibling.cutline_export_cache == {"fingerprint": "sibling-preview"}
        assert {path.name: path.read_bytes() for path in sibling.directory.iterdir() if path.is_file()} == sibling_files
        assert client.post(endpoint, json={
            "page_number": 2, "object_ids": ["vector-0"], "base_revision": 1,
        }).status_code == 409
        automatic = client.post(endpoint, json={
            "page_number": 2, "strategy": "vector", "base_revision": 2,
        })
        assert automatic.status_code == 200, automatic.text
        assert automatic.json()["boundary_source"] == "vector"
        assert automatic.json()["mask_revision"] == 3
        assert client.get(changed.json()["preview_url"]).status_code == 409


def test_redetect_custom_pdf_id_sai_giu_mask_artifact_da_duyet():
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("custom.pdf", _pdf_bytes(), "application/pdf")},
        )
        session_id = inspected.json()["session_id"]
        endpoint = f"/api/sticker-sheet/{session_id}/detect"
        initial = client.post(endpoint, json={"object_ids": ["vector-0"]})
        assert initial.status_code == 200, initial.text
        assert client.post(f"/api/sticker-sheet/{session_id}/confirm").status_code == 200
        page = session_store.get_page_state(session_id)
        previous_manifest = dict(page.manifest)
        preview = client.get(initial.json()["preview_url"]).content
        page.cutline_export_cache = {"fingerprint": "approved"}
        failed = client.post(endpoint, json={"object_ids": ["vector-99"], "base_revision": 1})
        assert failed.status_code == 422, failed.text
        assert page.manifest == previous_manifest
        assert page.stage == "mask-ready"
        assert page.cutline_export_cache == {"fingerprint": "approved"}
        assert client.get(initial.json()["preview_url"]).content == preview
        assert page.detection_token is None


def test_redetect_custom_pdf_huy_request_khoi_phuc_trang_da_duyet(monkeypatch):
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("custom.pdf", _pdf_bytes(), "application/pdf")},
        )
        session_id = inspected.json()["session_id"]
        assert client.post(
            f"/api/sticker-sheet/{session_id}/detect", json={"object_ids": ["vector-0"]},
        ).status_code == 200
    page = session_store.get_page_state(session_id)
    previous_manifest = dict(page.manifest)

    async def cancelled(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(sticker_sheet_route, "run_in_threadpool", cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(detect_sticker_source_endpoint(session_id, StickerSourceDetectRequest(
            object_ids=["vector-0"], base_revision=1,
        )))
    assert page.stage == "mask-review"
    assert page.manifest == previous_manifest
    assert page.detection_token is None


def test_export_theo_thumbnail_dung_cache_preview_cua_dung_trang(monkeypatch):
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        previewed = client.post(
            f"/api/sticker-sheet/{session_id}/cutline-preview",
            json={
                "base_revision": 1,
                "page_number": 1,
                "edits": [],
                "dpi": 300,
                "dpi_y": 150,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": True,
                "cutline_smoothness": 50,
                "cutline_fidelity": 50,
                "curve_tension": 50,
                "min_detail_area_mm2": 1,
                "cutline_denoise": 70,
            },
        )
        assert previewed.status_code == 200, previewed.text
        assert client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 1},
        ).status_code == 200

        def forbidden_refit(*_args, **_kwargs):
            pytest.fail("Export thumbnail đã bỏ cache preview của trang rồi fit lại")

        monkeypatch.setattr(
            "app.workers.sticker_sheet_export.build_alpha_cutline_geometry",
            forbidden_refit,
        )
        # Cache miss sẽ gọi lại preview worker trước cả bước fit Alpha. Chặn
        # luôn nhánh đó để chứng minh export dùng đúng artifact preview đã duyệt.
        monkeypatch.setattr(
            "app.workers.sticker_cutline_preview.build_sticker_cutline_preview",
            forbidden_refit,
        )
        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={
                "pages": [{
                    "source_page": 1,
                    "expected_revision": 1,
                    "edits": [],
                    "dpi": 300,
                    "dpi_y": 150,
                    "cutline_smoothness": 50,
                    "cutline_fidelity": 50,
                    "curve_tension": 50,
                    "min_detail_area_mm2": 1,
                    "cutline_denoise": 70,
                    "expected_fingerprint": previewed.json()["fingerprint"],
                }],
                "page_order": [1],
                "dpi": 300,
                "dpi_y": 150,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": True,
                "crop_to_sticker": True,
                "preserve_existing_cut": False,
                "output_format": "pdf",
            },
        )

    assert exported.status_code == 200, exported.text
    assert exported.headers["X-Sticker-Sheet-Count"] == "1"


def test_export_tu_choi_fingerprint_khi_cache_preview_thieu(tmp_path):
    """Có yêu cầu frame canonical nhưng session chưa có preview thì trả 409."""
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "alpha", "page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        assert client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 1},
        ).status_code == 200
        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={
                "pages": [{
                    "source_page": 1,
                    "expected_revision": 1,
                    "expected_fingerprint": "a" * 64,
                    "edits": [],
                    "dpi": 300,
                    "dpi_y": 150,
                }],
                "page_order": [1],
                "dpi": 300,
                "dpi_y": 150,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "preserve_existing_cut": False,
                "output_format": "pdf",
            },
        )

    assert exported.status_code == 409, exported.text
    assert "xem trước" in exported.json()["detail"].lower()
    session = session_store.get_session(session_id)
    assert session is not None
    assert not list(session.directory.glob("tem_cutcontour_*.pdf"))


def test_export_tu_choi_fingerprint_khi_denoise_da_doi(tmp_path):
    """Đổi denoise sau preview làm cache key lệch và không công bố PDF mới."""
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "alpha", "page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        previewed = client.post(
            f"/api/sticker-sheet/{session_id}/cutline-preview",
            json={
                "base_revision": 1,
                "page_number": 1,
                "edits": [],
                "dpi": 300,
                "dpi_y": 150,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": True,
                "cutline_smoothness": 50,
                "cutline_fidelity": 50,
                "curve_tension": 50,
                "min_detail_area_mm2": 1,
                "cutline_denoise": 70,
            },
        )
        assert previewed.status_code == 200, previewed.text
        assert client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 1},
        ).status_code == 200
        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={
                "pages": [{
                    "source_page": 1,
                    "expected_revision": 1,
                    "expected_fingerprint": previewed.json()["fingerprint"],
                    "edits": [],
                    "dpi": 300,
                    "dpi_y": 150,
                    "cutline_denoise": 71,
                }],
                "page_order": [1],
                "dpi": 300,
                "dpi_y": 150,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": True,
                "crop_to_sticker": True,
                "preserve_existing_cut": False,
                "output_format": "pdf",
            },
        )

    assert exported.status_code == 409, exported.text
    assert "preview" in exported.json()["detail"].lower()
    session = session_store.get_session(session_id)
    assert session is not None
    assert not list(session.directory.glob("tem_cutcontour_*.pdf"))


def test_detected_session_recovers_assets_after_backend_reload():
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("reload.png", _complex_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai", "page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        payload = detected.json()
        active = session_store.get_session(session_id)
        assert active is not None
        directory = active.directory

        # Mô phỏng worker uvicorn --reload: RAM mất nhưng artifact vẫn còn nguyên trên đĩa.
        session_store._SESSIONS.clear()
        assert directory.is_dir()

        for field in ("preview_url", "labels_url", "uncertainty_url"):
            asset = client.get(payload[field])
            assert asset.status_code == 200, asset.text
            assert asset.headers["content-type"].startswith("image/png")

        cutline = client.post(
            f"/api/sticker-sheet/{session_id}/cutline-preview",
            json={"base_revision": 1, "page_number": 1, "edits": []},
        )
        assert cutline.status_code == 200, cutline.text
        assert len(cutline.json()["paths"]) == 2

        retry = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai", "page_number": 1},
        )
        assert retry.status_code == 200, retry.text
        assert retry.json()["session_id"] == session_id
        restored = session_store.get_session(session_id)
        assert restored is not None
        assert restored.stage == "mask-review"


def test_inspect_alpha_image_is_lightweight_and_keeps_non_square_dpi(monkeypatch):
    def fail_if_ai_runs(*_args, **_kwargs):
        raise AssertionError("Inspector không được chạy model AI")

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fail_if_ai_runs,
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["stage"] == "inspected"
        assert payload["source_kind"] == "raster"
        assert payload["boundary_source"] == "alpha"
        assert payload["has_alpha"] is True
        assert payload["dpi"][0] == pytest.approx(300, abs=1)
        assert payload["dpi"][1] == pytest.approx(150, abs=1)
        assert "non-square-dpi" in payload["warnings"]
        assert payload["physical_width_mm"] == pytest.approx(120 / 300 * 25.4, abs=0.02)
        assert payload["physical_height_mm"] == pytest.approx(80 / 150 * 25.4, abs=0.02)
        preview = client.get(payload["preview_url"])
        assert preview.status_code == 200
        assert preview.headers["content-type"].startswith("image/png")
        blocked_export = client.post(
            f"/api/sticker-sheet/{payload['session_id']}/export",
            json={"output_format": "pdf"},
        )
        assert blocked_export.status_code == 409


def test_inspect_detect_confirm_keeps_session_and_requires_confirmation(monkeypatch):
    def fail_if_ai_runs(*_args, **_kwargs):
        raise AssertionError("Ảnh Alpha sạch không được chạy model AI")

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fail_if_ai_runs,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        inspected_payload = inspected.json()

        detected = client.post(
            f"/api/sticker-sheet/{inspected_payload['session_id']}/detect",
            json={},
        )
        assert detected.status_code == 200, detected.text
        payload = detected.json()
        assert payload["session_id"] == inspected_payload["session_id"]
        assert payload["stage"] == "mask-review"
        assert payload["boundary_source"] == "alpha"
        assert payload["refinement_available"] is False
        assert payload["source_page"] == 1
        assert len(payload["instances"]) == 1
        for field in ("preview_url", "labels_url", "uncertainty_url"):
            assert client.get(payload[field]).status_code == 200

        assert client.post(
            f"/api/sticker-sheet/{payload['session_id']}/export",
            json={"output_format": "pdf"},
        ).status_code == 409
        repeated = client.post(
            f"/api/sticker-sheet/{payload['session_id']}/detect",
            json={},
        )
        assert repeated.status_code == 200
        assert repeated.json()["mask_revision"] == payload["mask_revision"]
        assert client.post(
            f"/api/sticker-sheet/{payload['session_id']}/refine",
            json={
                "alpha_threshold": 128,
                "shadow_cleanup": "auto",
                "base_revision": 1,
            },
        ).status_code == 409

        confirmed = client.post(
            f"/api/sticker-sheet/{payload['session_id']}/confirm",
        )
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json() == {
            "session_id": payload["session_id"],
            "stage": "mask-ready",
            "mask_confirmed": True,
            "source_page": 1,
        }


def test_auto_multi_artwork_pdf_detects_confirms_and_exports_five_stickers(
    monkeypatch,
):
    """Luồng API mặc định phải giữ đủ năm artwork và không nạp AI."""
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Auto không được chạy AI")
        ),
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 16 * 1024),
    )
    source_bytes = _multi_artwork_vector_pdf_bytes()

    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("multi-artwork.pdf", source_bytes, "application/pdf")},
        )
        assert inspected.status_code == 200, inspected.text
        source = inspected.json()
        assert source["cut_contour_count"] == 0
        assert source["has_vector"] is True

        detected = client.post(
            f"/api/sticker-sheet/{source['session_id']}/detect",
            json={"strategy": "auto", "page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        manifest = detected.json()
        assert manifest["boundary_source"] == "vector"
        assert manifest["strategy_confidence"] == pytest.approx(0.72)
        assert manifest["needs_review"] is True
        assert len(manifest["instances"]) == 5
        fill_ratios = [
            item["area_px"] / (item["width"] * item["height"])
            for item in manifest["instances"]
        ]
        assert fill_ratios[0] < 0.86
        assert fill_ratios[1] > 0.94
        assert fill_ratios[2] < 0.86
        assert fill_ratios[3] > 0.94
        assert fill_ratios[4] < 0.86
        exact_shapes = manifest["vector_geometry_ref"]["exact_shapes"]
        assert {
            int(shape["instance_id"]): shape["kind"]
            for shape in exact_shapes
        } == {
            1: "circle",
            2: "rect",
            3: "circle",
            4: "rect",
            5: "circle",
        }
        assert "round-sticker-contour-inferred" in manifest["warnings"]
        assert "vector-mask-raster-preview" in manifest["warnings"]

        confirmed = client.post(
            f"/api/sticker-sheet/{source['session_id']}/confirm",
            json={"page_number": 1},
        )
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["stage"] == "mask-ready"

        exported = client.post(
            f"/api/sticker-sheet/{source['session_id']}/export",
            json={
                "dpi": 300,
                "offset_mm": 0,
                "bleed_mm": 0,
                "crop_to_sticker": True,
                "preserve_existing_cut": False,
                "output_format": "pdf",
            },
        )

    assert exported.status_code == 200, exported.text
    assert exported.headers["X-Sticker-Sheet-Count"] == "5"
    with pikepdf.Pdf.open(BytesIO(exported.content)) as output:
        assert len(output.pages) == 5
        for page in output.pages:
            streams = page.obj.get("/Contents")
            if isinstance(streams, pikepdf.Array):
                content = b"\n".join(stream.read_bytes() for stream in streams)
            else:
                content = streams.read_bytes()
            assert b"/CutContour CS" in content
            assert content.count(b" c\n") == 4


def test_detect_refine_assets_and_confirm_are_qualified_by_source_page():
    source_bytes = _pdf_bytes(pages=2, cut_pages={0, 1})
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("two-cut-pages.pdf", source_bytes, "application/pdf")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]

        page_one = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "existing-cut", "page_number": 1},
        )
        page_two = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "existing-cut", "page_number": 2},
        )

        assert page_one.status_code == 200, page_one.text
        assert page_two.status_code == 200, page_two.text
        first_payload = page_one.json()
        second_payload = page_two.json()
        assert first_payload["source_page"] == 1
        assert second_payload["source_page"] == 2
        assert "page=1" in first_payload["labels_url"]
        assert "page=2" in second_payload["labels_url"]
        assert first_payload["labels_url"] != second_payload["labels_url"]
        # Reload giữa luồng phải phục hồi đủ từng trang, không chỉ artifact trang 1.
        session_store._SESSIONS.clear()
        assert client.get(first_payload["labels_url"]).status_code == 200
        assert client.get(second_payload["labels_url"]).status_code == 200

        confirmed_one = client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 1},
        )
        confirmed_two = client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 2},
        )
        assert confirmed_one.status_code == 200, confirmed_one.text
        assert confirmed_two.status_code == 200, confirmed_two.text
        assert confirmed_one.json()["source_page"] == 1
        assert confirmed_two.json()["source_page"] == 2

        session = session_store.get_session(session_id)
        assert session is not None
        assert session.pages[1].stage == "mask-ready"
        assert session.pages[2].stage == "mask-ready"


def test_detect_real_corel_pdf_preserves_vector_geometry(monkeypatch):
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("CutContour thật không được chạy model AI")
        ),
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            data={"file_path": str(COREL_CUT_FIXTURE)},
        )
        assert inspected.status_code == 200, inspected.text
        source = inspected.json()
        detected = client.post(
            f"/api/sticker-sheet/{source['session_id']}/detect",
            json={"page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        assert client.post(
            f"/api/sticker-sheet/{source['session_id']}/confirm",
        ).status_code == 200
        exported = client.post(
            f"/api/sticker-sheet/{source['session_id']}/export",
            json={
                "cut_mode": "original",
                "offset_mm": 0,
                "bleed_mm": 0,
                "corner_style": "preserve",
                "crop_to_sticker": False,
                "preserve_existing_cut": True,
            },
        )
    assert detected.status_code == 200, detected.text
    payload = detected.json()
    assert payload["session_id"] == source["session_id"]
    assert payload["boundary_source"] == "existing-cut"
    assert len(payload["instances"]) == 75
    assert payload["vector_geometry_ref"] == {
        "kind": "pdf-cut-contours",
        "source_page": 1,
        "contour_count": 75,
        "preserve_original": True,
    }
    assert exported.status_code == 200, exported.text
    assert exported.headers["X-Sticker-Sheet-Count"] == "75"
    # QUALITY (audit 2026-08-08 §UNIFIED.7): file một trang phải đi fast path
    # byte-for-byte; như vậy 300 lệnh cubic Corel, OCG và spot không bị làm phẳng.
    assert exported.content == COREL_CUT_FIXTURE.read_bytes()


def test_detect_forced_ai_calls_model_once(monkeypatch):
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (12, 10, image.width - 12, image.height - 10))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_source_pipeline.detect_background", lambda _rgb: None)
    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("complex.png", _complex_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        detected = client.post(
            f"/api/sticker-sheet/{inspected.json()['session_id']}/detect",
            json={"strategy": "ai"},
        )
    assert detected.status_code == 200, detected.text
    assert detected.json()["boundary_source"] == "ai"
    assert calls == ["ai"]


def test_refine_ai_preview_reuses_model_and_keeps_baseline_identity(monkeypatch):
    calls: list[str] = []

    def soft_edge_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        alpha = np.zeros((image.height, image.width), dtype=np.uint8)
        alpha[8:36, 8:56] = 144
        alpha[12:32, 12:52] = 224
        alpha[42:74, 66:114] = 148
        alpha[46:70, 70:110] = 228
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: None,
    )
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        soft_edge_ai,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("complex.png", _complex_png_bytes(), "image/png")},
        )
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai"},
        )
        assert detected.status_code == 200, detected.text
        detected_payload = detected.json()
        assert detected_payload["refinement_available"] is True
        assert detected_payload["mask_revision"] == 1
        assert detected_payload["alpha_threshold"] == 128
        assert detected_payload["shadow_cleanup"] == "auto"
        assert "?v=1" in detected_payload["labels_url"]

        session = session_store.get_session(session_id)
        assert session is not None
        baseline = np.load(
            session.directory / "reference_labels.npy",
            allow_pickle=False,
        )
        assert (session.directory / "raw_alpha.png").is_file()
        assert (session.directory / "shadow_exclusion.png").is_file()

        same = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 128,
                "shadow_cleanup": "auto",
                "base_revision": 1,
            },
        )
        assert same.status_code == 200, same.text
        assert same.json()["mask_revision"] == 2
        assert same.json()["model_seconds"] == detected_payload["model_seconds"]
        assert client.get(detected_payload["labels_url"]).status_code == 409
        assert client.get(same.json()["labels_url"]).status_code == 200
        assert np.array_equal(
            np.load(session.directory / "labels.npy", allow_pickle=False),
            baseline,
        )

        tightened = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 176,
                "shadow_cleanup": "auto",
                "base_revision": 2,
            },
        )
        assert tightened.status_code == 200, tightened.text
        assert tightened.json()["mask_revision"] == 3
        tightened_labels = np.load(
            session.directory / "labels.npy",
            allow_pickle=False,
        )
        assert np.count_nonzero(tightened_labels) < np.count_nonzero(baseline)
        assert np.all((tightened_labels > 0) <= (baseline > 0))
        assert [item["id"] for item in tightened.json()["instances"]] == [1, 2]

        restored = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 128,
                "shadow_cleanup": "auto",
                "base_revision": 3,
            },
        )
        assert restored.status_code == 200, restored.text
        assert restored.json()["mask_revision"] == 4
        assert np.array_equal(
            np.load(session.directory / "labels.npy", allow_pickle=False),
            baseline,
        )

        stale = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 160,
                "shadow_cleanup": "auto",
                "base_revision": 1,
            },
        )
        assert stale.status_code == 409
        assert client.post(f"/api/sticker-sheet/{session_id}/confirm").status_code == 200
        after_confirm = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 160,
                "shadow_cleanup": "auto",
                "base_revision": 4,
            },
        )
        assert after_confirm.status_code == 409

    assert calls == ["ai"]


def test_refine_rejects_threshold_that_splits_an_instance(monkeypatch):
    calls: list[str] = []

    def bridged_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        alpha = np.zeros((image.height, image.width), dtype=np.uint8)
        alpha[14:58, 12:42] = 230
        alpha[14:58, 74:104] = 230
        alpha[32:40, 42:74] = 140
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: None,
    )
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        bridged_ai,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("complex.png", _complex_png_bytes(), "image/png")},
        )
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai"},
        )
        assert detected.status_code == 200, detected.text
        session = session_store.get_session(session_id)
        assert session is not None
        baseline = np.load(session.directory / "labels.npy", allow_pickle=False)

        rejected = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 176,
                "shadow_cleanup": "auto",
                "base_revision": 1,
            },
        )
        assert rejected.status_code == 422
        assert "thay đổi số lượng tem" in rejected.json()["detail"]
        assert np.array_equal(
            np.load(session.directory / "labels.npy", allow_pickle=False),
            baseline,
        )
        assert session.stage == "mask-review"
        assert session.manifest["mask_revision"] == 1

    assert calls == ["ai"]


def test_refine_rejects_threshold_that_changes_sticker_holes(monkeypatch):
    def ring_ai(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        alpha = np.zeros((image.height, image.width), dtype=np.uint8)
        alpha[10:70, 20:100] = 230
        alpha[30:50, 45:75] = 140
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: None,
    )
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        ring_ai,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("complex.png", _complex_png_bytes(), "image/png")},
        )
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai"},
        )
        assert detected.status_code == 200, detected.text

        rejected = client.post(
            f"/api/sticker-sheet/{session_id}/refine",
            json={
                "alpha_threshold": 176,
                "shadow_cleanup": "auto",
                "base_revision": 1,
            },
        )

    assert rejected.status_code == 422
    assert "thay đổi lỗ" in rejected.json()["detail"]


def test_confirm_is_blocked_while_refine_is_committing(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    original_reprocess = session_store.reprocess_sticker_sheet

    def blocking_reprocess(*args, **kwargs):
        started.set()
        assert release.wait(timeout=10)
        return original_reprocess(*args, **kwargs)

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: None,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("complex.png", _complex_png_bytes(), "image/png")},
        )
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai"},
        )
        assert detected.status_code == 200, detected.text
        labels_url = detected.json()["labels_url"]
        monkeypatch.setattr(session_store, "reprocess_sticker_sheet", blocking_reprocess)

        with ThreadPoolExecutor(max_workers=3) as executor:
            refining = executor.submit(
                client.post,
                f"/api/sticker-sheet/{session_id}/refine",
                json={
                    "alpha_threshold": 128,
                    "shadow_cleanup": "auto",
                    "base_revision": 1,
                },
            )
            assert started.wait(timeout=10)
            stale_asset = executor.submit(client.get, labels_url)
            confirm = client.post(f"/api/sticker-sheet/{session_id}/confirm")
            release.set()
            refined = refining.result(timeout=20)
            stale_asset_response = stale_asset.result(timeout=20)

    assert confirm.status_code == 409
    assert refined.status_code == 200, refined.text
    assert refined.json()["mask_revision"] == 2
    assert stale_asset_response.status_code == 409


def test_concurrent_detect_reserves_session_before_running_ai(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def blocking_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        started.set()
        assert release.wait(timeout=10)
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (12, 10, image.width - 12, image.height - 10))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_source_pipeline.detect_background", lambda _rgb: None)
    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", blocking_ai)
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("complex.png", _complex_png_bytes(), "image/png")},
        )
        session_id = inspected.json()["session_id"]
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(
                client.post,
                f"/api/sticker-sheet/{session_id}/detect",
                json={"strategy": "ai"},
            )
            assert started.wait(timeout=10)
            duplicate = client.post(
                f"/api/sticker-sheet/{session_id}/detect",
                json={"strategy": "ai"},
            )
            release.set()
            completed = first.result(timeout=20)

    assert duplicate.status_code == 409
    assert completed.status_code == 200, completed.text
    assert calls == ["ai"]


def test_cancelled_detect_releases_session_reservation(monkeypatch):
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("source.png", _alpha_png_bytes(), "image/png")},
        )
    session_id = inspected.json()["session_id"]

    async def cancel_job(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(
        "app.api.routes.sticker_sheet.run_heavy_in_threadpool",
        cancel_job,
    )
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(detect_sticker_source_endpoint(
            session_id,
            StickerSourceDetectRequest(),
        ))

    session = session_store.get_session(session_id)
    assert session is not None
    assert session.stage == "inspected"


def test_cancelled_inspect_don_upload_va_session_sau_khi_worker_xong(monkeypatch):
    """Client hủy không được xóa file dưới chân worker hoặc rò session."""
    started = threading.Event()
    release = threading.Event()
    closed = threading.Event()
    closed_sessions: list[tuple[str, bool]] = []
    original_inspect = sticker_sheet_route.inspect_sticker_source
    original_close = sticker_sheet_route.close_session

    def blocking_inspect(source_path: str, original_name: str):
        started.set()
        assert release.wait(timeout=10)
        return original_inspect(source_path, original_name)

    def recording_close(session_id: str) -> bool:
        try:
            result = original_close(session_id)
            closed_sessions.append((session_id, result))
            return result
        finally:
            closed.set()

    monkeypatch.setattr(sticker_sheet_route, "inspect_sticker_source", blocking_inspect)
    monkeypatch.setattr(sticker_sheet_route, "close_session", recording_close)

    async def cancel_pending_inspect() -> tuple[Path, bool]:
        upload = UploadFile(
            BytesIO(_alpha_png_bytes()),
            filename="cancelled-inspect.png",
        )
        request_task = asyncio.create_task(
            sticker_sheet_route.inspect_sticker_source_endpoint(
                file=upload,
                file_path=None,
            )
        )
        try:
            worker_started = await asyncio.wait_for(
                asyncio.to_thread(started.wait, 10),
                timeout=11,
            )
            assert worker_started
            upload_path = Path(getattr(upload, "_prynx_partial_path"))
            assert upload_path.is_file()

            request_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request_task
            # File phải còn nguyên trong lúc worker đang bị chặn. Bản cũ xóa
            # nó ngay trong finally của request và tạo race FileNotFoundError.
            worker_still_owns_upload = upload_path.is_file()
        finally:
            release.set()

        session_closed = await asyncio.wait_for(
            asyncio.to_thread(closed.wait, 10),
            timeout=11,
        )
        await upload.close()
        assert session_closed
        return upload_path, worker_still_owns_upload

    upload_path, worker_still_owns_upload = asyncio.run(cancel_pending_inspect())

    assert worker_still_owns_upload is True
    assert closed_sessions and closed_sessions[0][1] is True
    assert session_store.get_session(closed_sessions[0][0]) is None
    assert not upload_path.exists()
    assert not any(session_store.SESSION_ROOT.iterdir())


def test_detect_alpha_preview_khong_chiem_hang_doi_heavy(monkeypatch):
    """Nguồn đã có Alpha chỉ chuẩn bị mask trong thread thường cho preview line-only."""
    async def forbidden_heavy(*_args, **_kwargs):
        pytest.fail("Detect Alpha không được chiếm hàng đợi heavy")

    monkeypatch.setattr(
        "app.api.routes.sticker_sheet.run_heavy_in_threadpool",
        forbidden_heavy,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("alpha.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        detected = client.post(
            f"/api/sticker-sheet/{inspected.json()['session_id']}/detect",
            json={"strategy": "alpha", "page_number": 1},
        )

    assert detected.status_code == 200, detected.text
    assert detected.json()["boundary_source"] == "alpha"


def test_detect_page_box_preview_khong_chiem_hang_doi_heavy(monkeypatch):
    """page-box là mask deterministic nên chạy thread thường, không chiếm heavy."""
    async def forbidden_heavy(*_args, **_kwargs):
        pytest.fail("Detect page-box không được chiếm hàng đợi heavy")

    monkeypatch.setattr(
        "app.api.routes.sticker_sheet.run_heavy_in_threadpool",
        forbidden_heavy,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("page-box.png", _alpha_png_bytes(), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        detected = client.post(
            f"/api/sticker-sheet/{inspected.json()['session_id']}/detect",
            json={"strategy": "page-box", "page_number": 1},
        )

    assert detected.status_code == 200, detected.text
    payload = detected.json()
    assert payload["boundary_source"] == "page-box"
    assert payload["needs_review"] is False
    assert len(payload["instances"]) == 1
    assert payload["instances"][0]["x"] == 0
    assert payload["instances"][0]["y"] == 0


def test_detected_pdf_exports_after_confirmation(monkeypatch):
    source_bytes = _pdf_bytes(cut_contour=True)

    def fail_if_rebuilt(*_args, **_kwargs):
        raise AssertionError("CutContour nguyên bản không được raster hóa rồi fit lại")

    monkeypatch.setattr(
        "app.workers.sticker_sheet_export.StickerEngine.process_pdf",
        fail_if_rebuilt,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("cut.pdf", source_bytes, "application/pdf")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={},
        )
        assert detected.status_code == 200, detected.text
        assert client.post(f"/api/sticker-sheet/{session_id}/confirm").status_code == 200

        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={
                "output_format": "pdf",
                "offset_mm": 0,
                "bleed_mm": 0,
                "dpi": 300,
                "crop_to_sticker": False,
                "preserve_existing_cut": True,
            },
        )
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"].startswith("application/pdf")
    assert exported.headers["X-Sticker-Sheet-Count"] == "1"
    assert exported.content == source_bytes
    with pikepdf.Pdf.open(BytesIO(exported.content)) as document:
        assert len(document.pages) == 1


def test_preserved_multi_page_pdf_exports_only_detected_page_with_page_contract():
    source_buffer = BytesIO(_pdf_bytes(pages=2, cut_pages={1}))
    rewritten = BytesIO()
    with pikepdf.Pdf.open(source_buffer) as document:
        selected = document.pages[1].obj
        selected["/MediaBox"] = pikepdf.Array([10, 20, 154, 92])
        selected["/CropBox"] = pikepdf.Array([12, 22, 152, 90])
        selected["/Rotate"] = 90
        selected["/UserUnit"] = 2
        document.save(rewritten)
    source_bytes = rewritten.getvalue()

    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("mixed.pdf", source_bytes, "application/pdf")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "existing-cut", "page_number": 2},
        )
        assert detected.status_code == 200, detected.text
        assert client.post(f"/api/sticker-sheet/{session_id}/confirm").status_code == 200
        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={
                "cut_mode": "original",
                "offset_mm": 0,
                "bleed_mm": 0,
                "corner_style": "preserve",
                "crop_to_sticker": False,
                "preserve_existing_cut": True,
            },
        )

    assert exported.status_code == 200, exported.text
    with (
        pikepdf.Pdf.open(BytesIO(source_bytes)) as source,
        pikepdf.Pdf.open(BytesIO(exported.content)) as output,
    ):
        assert len(output.pages) == 1
        source_page = source.pages[1].obj
        output_page = output.pages[0].obj
        for key in ("/MediaBox", "/CropBox"):
            assert [float(value) for value in output_page[key]] == [
                float(value) for value in source_page[key]
            ]
        assert int(output_page["/Rotate"]) == 90
        assert float(output_page["/UserUnit"]) == 2
        assert output_page["/Contents"].read_bytes() == source_page["/Contents"].read_bytes()


def test_multi_page_export_blocks_incomplete_or_stale_and_follows_page_order():
    source_buffer = BytesIO(_pdf_bytes(pages=2, cut_pages={0, 1}))
    rewritten = BytesIO()
    with pikepdf.Pdf.open(source_buffer) as document:
        document.pages[0].obj["/UserUnit"] = 1
        document.pages[1].obj["/UserUnit"] = 2
        document.save(rewritten)

    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("ordered.pdf", rewritten.getvalue(), "application/pdf")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        for page_number in (1, 2):
            detected = client.post(
                f"/api/sticker-sheet/{session_id}/detect",
                json={"strategy": "existing-cut", "page_number": page_number},
            )
            assert detected.status_code == 200, detected.text
        assert client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 1},
        ).status_code == 200

        request = {
            "pages": [
                {"source_page": 1, "expected_revision": 1, "edits": []},
                {"source_page": 2, "expected_revision": 1, "edits": []},
            ],
            "page_order": [2, 1],
            "cut_mode": "original",
            "offset_mm": 0,
            "bleed_mm": 0,
            "corner_style": "preserve",
            "crop_to_sticker": False,
            "preserve_existing_cut": True,
            "output_format": "pdf",
        }
        incomplete = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json=request,
        )
        assert incomplete.status_code == 409
        assert "trang 2" in incomplete.text

        assert client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 2},
        ).status_code == 200
        stale_request = {
            **request,
            "pages": [
                {"source_page": 1, "expected_revision": 2, "edits": []},
                request["pages"][1],
            ],
        }
        stale = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json=stale_request,
        )
        assert stale.status_code == 409
        assert "trang 1" in stale.text

        exported = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json=request,
        )

    assert exported.status_code == 200, exported.text
    assert exported.headers["X-Sticker-Sheet-Count"] == "2"
    with pikepdf.Pdf.open(BytesIO(exported.content)) as output:
        assert len(output.pages) == 2
        assert [float(page.obj["/UserUnit"]) for page in output.pages] == [2.0, 1.0]


def test_multi_page_export_groups_split_rasters_and_preserves_original_pdf_sheets(monkeypatch):
    calls: list[tuple[str, int, list[int]]] = []

    def copy_cutline_input(_engine, *, input_path: str, output_path: str, **kwargs):
        approved = kwargs.get("approved_contour_overrides")
        overrides = approved or kwargs.get("alpha_path_overrides") or {}
        calls.append((
            "original" if approved else "raster",
            len(overrides),
            [
                len(payload.get("path_groups") or [])
                for _page_index, payload in sorted(overrides.items())
            ],
        ))
        Path(output_path).write_bytes(Path(input_path).read_bytes())
        return True, {}

    monkeypatch.setattr(
        "app.workers.sticker_sheet_export.StickerEngine.process_pdf",
        copy_cutline_input,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("two-ai-pages.pdf", _pdf_bytes(pages=2), "application/pdf")},
        )
        session_id = inspected.json()["session_id"]
        for page_number in (1, 2):
            detected = client.post(
                f"/api/sticker-sheet/{session_id}/detect",
                json={"strategy": "ai", "page_number": page_number},
            )
            assert detected.status_code == 200, detected.text
            assert client.post(
                f"/api/sticker-sheet/{session_id}/confirm",
                json={"page_number": page_number},
            ).status_code == 200

        request = {
            "pages": [
                {"source_page": 1, "expected_revision": 1, "edits": [], "dpi": 300},
                {"source_page": 2, "expected_revision": 1, "edits": [], "dpi": 300},
            ],
            "page_order": [2, 1],
            "bleed_color_type": "image",
            "preserve_existing_cut": False,
            "output_format": "pdf",
        }
        separated = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={**request, "crop_to_sticker": True},
        )
        # Giữ PDF gốc không được tự fit lại lúc xuất; dùng đúng artifact đã tạo
        # ở cùng settings (crop chỉ đóng trang, không đổi hình học preview).
        session = session_store.get_session(session_id)
        assert session is not None
        for page_config in request["pages"]:
            page_config["expected_fingerprint"] = session.pages[
                page_config["source_page"]
            ].cutline_export_cache["fingerprint"]
        whole_sheets = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={**request, "crop_to_sticker": False},
        )

    assert separated.status_code == 200, separated.text
    assert whole_sheets.status_code == 200, whole_sheets.text
    assert calls == [
        ("raster", 4, [1, 1, 1, 1]),
        ("original", 1, [2]),
        ("original", 1, [2]),
    ]
    assert separated.headers["X-Sticker-Sheet-Count"] == "4"
    assert whole_sheets.headers["X-Sticker-Sheet-Count"] == "4"
    with (
        pikepdf.Pdf.open(BytesIO(separated.content)) as separated_pdf,
        pikepdf.Pdf.open(BytesIO(whole_sheets.content)) as whole_sheets_pdf,
    ):
        assert len(separated_pdf.pages) == 4
        assert len(whole_sheets_pdf.pages) == 2


def test_inspect_pdf_detects_existing_cutcontour_without_ai(monkeypatch):
    def fail_if_ai_runs(*_args, **_kwargs):
        raise AssertionError("Inspector PDF không được chạy model AI")

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fail_if_ai_runs,
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("cut.pdf", _pdf_bytes(cut_contour=True), "application/pdf")},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["source_kind"] == "pdf"
        assert payload["page_count"] == 1
        assert payload["has_existing_cut"] is True
        assert payload["cut_contour_count"] == 1
        assert payload["boundary_source"] == "existing-cut"
        assert payload["needs_review"] is False
        assert payload["physical_width_mm"] == pytest.approx(50.8)
        assert payload["physical_height_mm"] == pytest.approx(25.4)
        assert client.get(payload["preview_url"]).status_code == 200


def test_inspect_multi_page_vector_pdf_reports_every_page():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("vector.pdf", _pdf_bytes(pages=2), "application/pdf")},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["page_count"] == 2
    assert len(payload["pages"]) == 2
    assert payload["has_vector"] is True
    assert payload["boundary_source"] == "vector"
    assert payload["needs_review"] is True
    assert "multi-page-source" in payload["warnings"]


def test_inspect_form_containing_only_image_is_raster_not_vector():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("form-image.pdf", _form_image_pdf_bytes(), "application/pdf")},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["has_raster"] is True
    assert payload["has_vector"] is False
    assert payload["boundary_source"] == "ai"


def test_inspect_real_corel_fixture_uses_painted_cutcontours():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            data={"file_path": str(COREL_CUT_FIXTURE)},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["boundary_source"] == "existing-cut"
    assert payload["cut_contour_count"] == 75
    assert payload["pages"][0]["cut_contour_count"] == 75


def test_inspect_does_not_accept_unused_cutcontour_resource():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={
                "file": (
                    "unused-cut.pdf",
                    _pdf_bytes(cut_contour=True, paint_cut=False),
                    "application/pdf",
                )
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["has_existing_cut"] is False
    assert payload["cut_contour_count"] == 0
    assert payload["boundary_source"] == "vector"


def test_inspect_mixed_cut_pages_requires_review():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={
                "file": (
                    "mixed.pdf",
                    _pdf_bytes(pages=2, cut_pages={0}),
                    "application/pdf",
                )
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["has_existing_cut"] is True
    assert payload["boundary_source"] == "manual"
    assert payload["needs_review"] is True
    assert [page["cut_contour_count"] for page in payload["pages"]] == [1, 0]
    assert "mixed-boundary-sources" in payload["warnings"]


def test_inspect_palette_transparency_is_alpha():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("palette.png", _palette_alpha_png_bytes(), "image/png")},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["has_alpha"] is True
    assert payload["boundary_source"] == "alpha"


def test_inspect_rotated_image_swaps_dpi_axes():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("rotated.jpg", _rotated_jpeg_bytes(), "image/jpeg")},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source_width_px"] == 20
    assert payload["source_height_px"] == 40
    assert payload["dpi"][0] == pytest.approx(100, abs=1)
    assert payload["dpi"][1] == pytest.approx(200, abs=1)
    assert payload["physical_width_mm"] == pytest.approx(5.08, abs=0.08)
    assert payload["physical_height_mm"] == pytest.approx(5.08, abs=0.08)


def test_inspect_missing_dpi_keeps_physical_size_unknown():
    buffer = BytesIO()
    Image.new("RGB", (30, 20), "white").save(buffer, format="PNG")
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("no-dpi.png", buffer.getvalue(), "image/png")},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["physical_width_mm"] is None
    assert payload["physical_height_mm"] is None
    assert payload["pages"][0]["width_mm"] is None
    assert payload["pages"][0]["height_mm"] is None


def test_inspect_rejects_mime_extension_mismatch():
    jpeg = BytesIO()
    Image.new("RGB", (20, 20), "white").save(jpeg, format="JPEG")
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("fake.png", jpeg.getvalue(), "image/png")},
        )
    assert response.status_code == 415


def test_inspect_does_not_treat_uniform_semitransparency_as_clean_alpha():
    buffer = BytesIO()
    Image.new("RGBA", (30, 20), (80, 120, 220, 128)).save(buffer, format="PNG")
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("soft.png", buffer.getvalue(), "image/png")},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["has_alpha"] is False
    assert payload["boundary_source"] != "alpha"


def test_inspect_rejects_multi_frame_raster_instead_of_silently_using_first():
    buffer = BytesIO()
    first = Image.new("RGB", (20, 20), "white")
    second = Image.new("RGB", (20, 20), "black")
    first.save(buffer, format="TIFF", save_all=True, append_images=[second])
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("multi.tiff", buffer.getvalue(), "image/tiff")},
        )
    assert response.status_code == 415
    assert "nhiều khung" in response.text


def test_inspected_session_expires_and_removes_preview():
    with TestClient(app) as client:
        payload = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("source.png", _png_bytes(), "image/png")},
        ).json()
    session = session_store.get_session(payload["session_id"])
    assert session is not None
    directory = Path(session.directory)
    session.last_access = 0.0

    assert session_store.sweep_expired(now=session_store.SESSION_TTL_SECONDS + 1) == 1
    assert not directory.exists()


def test_inspect_accepts_local_pdf_and_rejects_traversal(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf_bytes())
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            data={"file_path": str(source)},
        )
        assert inspected.status_code == 200, inspected.text
        traversal = client.post(
            "/api/sticker-sheet/inspect",
            data={"file_path": f"{tmp_path}{Path('/../source.pdf')}"},
        )
        assert traversal.status_code == 400


def test_inspect_rejects_local_symlink(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf_bytes())
    link = tmp_path / "linked.pdf"
    try:
        link.symlink_to(source)
    except OSError:
        pytest.skip("Windows chưa cho phép tạo symlink trong môi trường test")
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            data={"file_path": str(link)},
        )
    assert response.status_code == 400


def test_inspect_rejects_corrupt_pdf():
    with TestClient(app) as client:
        response = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("broken.pdf", b"%PDF-not-valid", "application/pdf")},
        )
    assert response.status_code == 415


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
    forwarded: list[dict[str, object]] = []
    process_pdf = StickerEngine.process_pdf

    def capture_policy(self, *args, **kwargs):
        policies.append(kwargs.get("alpha_corner_policy", "legacy"))
        source_pixel_sizes.append(kwargs.get("alpha_source_pixel_mm"))
        forwarded.append(dict(kwargs))
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
            json={
                "dpi": 300,
                "offset_mm": 0,
                "bleed_mm": 0,
                "cut_mode": "original",
                "corner_style": "preserve",
                "fill_holes": False,
                "bleed_color_type": "solid",
                "solid_bleed_cmyk": [100, 0, 0, 0],
                "shape_mode": "contour",
                "output_format": "pdf",
            },
        )

    assert response.status_code == 200, response.text
    assert response.headers["X-Sticker-Sheet-Count"] == "2"
    assert policies == ["adaptive"]
    assert source_pixel_sizes == pytest.approx([25.4 / 300.0])
    assert forwarded[0]["cut_mode"] == "original"
    assert forwarded[0]["offset_mm"] == 0
    assert forwarded[0]["corner_style"] == "preserve"
    assert forwarded[0]["fill_holes"] is False
    assert forwarded[0]["bleed_color_type"] == "solid"
    assert forwarded[0]["solid_bleed_color"] == (0, 255, 255)
    assert forwarded[0]["shape_mode"] == "contour"
    assert forwarded[0]["alpha_source_mode"] is True
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
            # Hai fixture là hình chữ nhật: đoạn thẳng là hình học đúng, không
            # được ép thành cubic chỉ để làm đẹp số đếm. Vẫn khóa số node hữu hạn.
            segment_count = cut_stream.count(b" l\n") + cut_stream.count(b" c\n")
            assert 4 <= segment_count <= 16


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


def test_crop_false_keeps_whole_sheet_with_one_cutline_per_sticker():
    with TestClient(app) as client:
        analyzed = client.post(
            "/api/sticker-sheet/analyze",
            files={"file": ("mockup.png", _png_bytes(), "image/png")},
        )
        assert analyzed.status_code == 200, analyzed.text
        session_id = analyzed.json()["session_id"]
        tight = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={"dpi": 300, "bleed_mm": 0, "crop_to_sticker": True},
        )
        full = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            json={"dpi": 300, "bleed_mm": 0, "crop_to_sticker": False},
        )

    assert tight.status_code == 200, tight.text
    assert full.status_code == 200, full.text
    assert "tem_tach_cutcontour.pdf" in tight.headers["content-disposition"]
    assert "tem_giu_nguyen_cutcontour.pdf" in full.headers["content-disposition"]
    with (
        pikepdf.Pdf.open(BytesIO(tight.content)) as tight_pdf,
        pikepdf.Pdf.open(BytesIO(full.content)) as full_pdf,
    ):
        assert len(tight_pdf.pages) == 2
        assert len(full_pdf.pages) == 1
        expected_width = 120 / 300 * 72
        expected_height = 80 / 300 * 72
        full_page = full_pdf.pages[0]
        full_box = [float(value) for value in full_page.MediaBox]
        assert full_box[2] - full_box[0] == pytest.approx(expected_width, abs=0.02)
        assert full_box[3] - full_box[1] == pytest.approx(expected_height, abs=0.02)
        for tight_page in tight_pdf.pages:
            tight_box = [float(value) for value in tight_page.MediaBox]
            assert (
                tight_box[2] - tight_box[0] < full_box[2] - full_box[0]
                or tight_box[3] - tight_box[1] < full_box[3] - full_box[1]
            )
        streams = full_page.obj.get("/Contents")
        if isinstance(streams, pikepdf.Array):
            content = b"\n".join(stream.read_bytes() for stream in streams)
        else:
            content = streams.read_bytes()
        cut_stream = content.split(b"/CutContour CS", 1)[1]
        assert cut_stream.count(b" m\n") == 2


def test_crop_true_keeps_nine_stickers_as_nine_pdf_pages(monkeypatch):
    """Ca 9 tem phải giữ hợp đồng tách trang cả khi engine bật fan-out."""

    def fake_nine_stickers(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        alpha = np.zeros((image.height, image.width), dtype=np.uint8)
        for row in range(3):
            for column in range(3):
                left = 10 + column * 55
                top = 10 + row * 55
                alpha[top:top + 35, left:left + 35] = 255
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_nine_stickers,
    )
    with TestClient(app) as client:
        inspected = client.post(
            "/api/sticker-sheet/inspect",
            files={"file": ("nine-stickers.png", _png_bytes((180, 180)), "image/png")},
        )
        assert inspected.status_code == 200, inspected.text
        session_id = inspected.json()["session_id"]
        detected = client.post(
            f"/api/sticker-sheet/{session_id}/detect",
            json={"strategy": "ai", "page_number": 1},
        )
        assert detected.status_code == 200, detected.text
        assert len(detected.json()["instances"]) == 9
        assert client.post(
            f"/api/sticker-sheet/{session_id}/confirm",
            json={"page_number": 1},
        ).status_code == 200
        separated = client.post(
            f"/api/sticker-sheet/{session_id}/export",
            headers={"Origin": "http://localhost:5173"},
            json={
                "pages": [{
                    "source_page": 1,
                    "expected_revision": detected.json()["mask_revision"],
                    "edits": [],
                }],
                "page_order": [1],
                "dpi": 300,
                "offset_mm": 0,
                "bleed_mm": 0,
                "crop_to_sticker": True,
                "preserve_existing_cut": False,
            },
        )

    assert separated.status_code == 200, separated.text
    assert separated.headers["X-Sticker-Sheet-Count"] == "9"
    exposed_headers = {
        value.strip().lower()
        for value in separated.headers["access-control-expose-headers"].split(",")
    }
    assert "content-disposition" in exposed_headers
    assert "x-sticker-sheet-count" in exposed_headers
    with pikepdf.Pdf.open(BytesIO(separated.content)) as output:
        assert len(output.pages) == 9


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
