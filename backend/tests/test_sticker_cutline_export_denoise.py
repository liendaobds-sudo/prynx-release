"""QUALITY (audit 2026-09-09 §NODE.1): PDF giữ đúng Khử răng cưa đã preview."""

from __future__ import annotations

import copy
from io import BytesIO

from fastapi.testclient import TestClient
import pikepdf
from pydantic import ValidationError
import pytest

from app.main import app
from app.api.routes import sticker_sheet as routes
from app.schemas.sticker_sheet import (
    StickerSheetExportRequest,
    StickerSheetPageExportRequest,
)
from app.workers import sticker_cutline_preview as preview_worker
from app.workers import sticker_sheet_export as exporter
from app.workers.cutline_geometry import build_bezier_segments_path_stream
from test_sticker_cutline_preview import _session


GEOMETRY = {
    "dpi": 100.0,
    "dpi_y": 100.0,
    "offset_mm": 0.0,
    "bleed_mm": 0.0,
    "cut_mode": "original",
    "corner_style": "preserve",
    "fill_holes": True,
    "cutline_smoothness": 50.0,
    "cutline_fidelity": 50.0,
    "curve_tension": 50.0,
    "min_detail_area_mm2": 1.0,
}


def _ready_session(tmp_path, monkeypatch, *, warnings=None):
    session = _session(tmp_path, warnings=warnings)
    session.stage = "mask-ready"
    session.pages[1].stage = "mask-ready"
    monkeypatch.setattr(routes, "get_session", lambda _session_id: session)
    monkeypatch.setattr(
        routes, "get_page_state", lambda _session_id, number: session.pages.get(number),
    )
    return session


def _preview(session, denoise, *, page_number=1):
    return preview_worker.build_sticker_cutline_preview(
        session,
        page_number=page_number,
        base_revision=3,
        edits=[],
        cutline_denoise=denoise,
        **GEOMETRY,
    )


def _expected_cubics(page):
    cache = page.cutline_export_cache
    overrides = exporter._cutline_overrides_from_preview_cache(
        page, cache_key=cache["key"], instance_ids=[1], crop_to_sticker=False,
        dpi=100.0, dpi_y=100.0,
    )
    assert overrides is not None
    commands = []
    for group in overrides[0]["path_groups"]:
        for ring in [group["exterior"], *group.get("interiors", [])]:
            commands.extend(build_bezier_segments_path_stream(ring, 140.0 * 72.0 / 100.0))
    return [line.strip() for line in commands if line.strip().endswith(" c")]


def _pdf_cubics(page):
    contents = page.Contents
    streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
    content = b"\n".join(stream.read_bytes() for stream in streams)
    cut = content.split(b"/CutContour CS", 1)[1]
    return [
        line.strip().decode("ascii")
        for line in cut.splitlines() if line.strip().endswith(b" c")
    ]


def _export_payload(denoise, *, document):
    payload = {
        **GEOMETRY,
        "cutline_denoise": denoise,
        "edits": [],
        "output_format": "pdf",
        "crop_to_sticker": False,
        "preserve_existing_cut": False,
        "bleed_color_type": "solid",
    }
    if document:
        # Trang bỏ field phải thừa hưởng global, không tự biến thành None.
        payload["pages"] = [{"source_page": 1, "expected_revision": 3, "edits": []}]
        payload["page_order"] = [1]
    return payload


@pytest.mark.parametrize("document", [False, True], ids=["legacy", "document"])
@pytest.mark.parametrize("denoise", [None, 0.0, 50.0, 100.0])
@pytest.mark.parametrize("cache_hit", [True, False], ids=["cache", "rebuild"])
def test_export_denoise_giu_nguyen_lenh_cubic_pdf(
    tmp_path, monkeypatch, document, denoise, cache_hit,
):
    session = _ready_session(tmp_path, monkeypatch)
    _preview(session, denoise)
    expected_cache = copy.deepcopy(session.pages[1].cutline_export_cache)
    expected_commands = _expected_cubics(session.pages[1])
    refits = []
    original_preview = preview_worker.build_sticker_cutline_preview

    def tracked_preview(*args, **kwargs):
        refits.append(kwargs.get("cutline_denoise"))
        return original_preview(*args, **kwargs)

    if not cache_hit:
        session.pages[1].cutline_export_cache = None
    monkeypatch.setattr(preview_worker, "build_sticker_cutline_preview", tracked_preview)
    with TestClient(app) as client:
        response = client.post(
            f"/api/sticker-sheet/{session.session_id}/export",
            json=_export_payload(denoise, document=document),
        )
    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(BytesIO(response.content)) as pdf:
        assert len(pdf.pages) == 1
        assert _pdf_cubics(pdf.pages[0]) == expected_commands
    actual_cache = session.pages[1].cutline_export_cache
    assert actual_cache["key"] == expected_cache["key"]
    assert actual_cache["fingerprint"] == expected_cache["fingerprint"]
    assert actual_cache["requested_cutline_denoise"] == denoise
    assert refits == ([] if cache_hit else [denoise])


@pytest.mark.parametrize("page_denoise", [None, 0.0, 100.0])
def test_denoise_theo_trang_thang_global_ke_ca_null_va_khong(
    tmp_path, monkeypatch, page_denoise,
):
    session = _ready_session(tmp_path, monkeypatch)
    _preview(session, page_denoise)
    expected = _expected_cubics(session.pages[1])
    payload = _export_payload(50.0, document=True)
    payload["pages"][0]["cutline_denoise"] = page_denoise
    with TestClient(app) as client:
        response = client.post(
            f"/api/sticker-sheet/{session.session_id}/export", json=payload,
        )
    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(BytesIO(response.content)) as pdf:
        assert _pdf_cubics(pdf.pages[0]) == expected
    assert session.pages[1].cutline_export_cache["requested_cutline_denoise"] == page_denoise


def test_denoise_da_trang_khong_lan_khi_dao_va_lap_thu_tu(tmp_path, monkeypatch):
    session = _ready_session(tmp_path, monkeypatch)
    second_directory = tmp_path / "page2"
    second_directory.mkdir()
    second = _session(second_directory).pages[1]
    second.page_number = 2
    second.stage = "mask-ready"
    session.pages[2] = second
    session.page_count = 2
    _preview(session, 50.0)
    _preview(session, 0.0, page_number=2)
    expected = {number: _expected_cubics(page) for number, page in session.pages.items()}
    assert expected[1] != expected[2]
    payload = _export_payload(50.0, document=True)
    payload["pages"].append({
        "source_page": 2, "expected_revision": 3, "edits": [], "cutline_denoise": 0.0,
    })
    payload["page_order"] = [2, 1, 2]
    with TestClient(app) as client:
        response = client.post(
            f"/api/sticker-sheet/{session.session_id}/export", json=payload,
        )
    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(BytesIO(response.content)) as pdf:
        assert len(pdf.pages) == 3
        assert [_pdf_cubics(page) for page in pdf.pages] == [expected[2], expected[1], expected[2]]


@pytest.mark.parametrize("value", [-0.1, 100.1, "NaN", "Infinity", "khong-hop-le"])
@pytest.mark.parametrize("page_level", [False, True])
def test_export_tu_choi_denoise_khong_hop_le(value, page_level):
    model = StickerSheetPageExportRequest if page_level else StickerSheetExportRequest
    payload = {"cutline_denoise": value}
    if page_level:
        payload.update(source_page=1, expected_revision=3)
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize("denoise", [None, 0.0, 50.0, 100.0])
def test_png_fallback_dung_denoise_va_zero_tat_presmooth(tmp_path, monkeypatch, denoise):
    session = _ready_session(tmp_path, monkeypatch)
    seen = []
    original_builder = exporter.build_alpha_cutline_geometry

    def tracked_builder(*args, **kwargs):
        seen.append((kwargs.get("cutline_denoise", 0.0), kwargs["presmooth_alpha"]))
        return original_builder(*args, **kwargs)

    monkeypatch.setattr(exporter, "build_alpha_cutline_geometry", tracked_builder)
    output = exporter._build_cutline_pdf_from_pngs(
        [session.directory / "rgba.png"], tmp_path,
        **GEOMETRY,
        cutline_denoise=denoise,
        crop_to_sticker=False,
        bleed_color_type="solid", solid_bleed_cmyk=(0.0, 0.0, 0.0, 0.0),
        shape_mode="contour", draw_cut_contour=True,
        presmooth_alpha=True,
    )
    assert output.is_file()
    assert seen == [(0.0 if denoise is None else denoise, denoise is None)]


def test_segment_pdf_khong_gop_hai_trang_khac_denoise_khi_thieu_override(tmp_path, monkeypatch):
    session = _ready_session(tmp_path, monkeypatch)
    second_directory = tmp_path / "page2"
    second_directory.mkdir()
    second = _session(second_directory).pages[1]
    second.page_number = 2
    second.stage = "mask-ready"
    session.pages[2] = second
    session.page_count = 2
    monkeypatch.setattr(exporter, "_cutline_overrides_with_preview_fallback", lambda *a, **kw: None)
    seen = []
    original_builder = exporter._build_cutline_pdf_from_pngs

    def tracked_builder(*args, **kwargs):
        seen.append((len(args[0]), kwargs["cutline_denoise"]))
        return original_builder(*args, **kwargs)

    monkeypatch.setattr(exporter, "_build_cutline_pdf_from_pngs", tracked_builder)
    payload = _export_payload(50.0, document=True)
    payload["pages"].append({
        "source_page": 2, "expected_revision": 3, "edits": [], "cutline_denoise": 0.0,
    })
    payload["page_order"] = [1, 2]
    with TestClient(app) as client:
        response = client.post(
            f"/api/sticker-sheet/{session.session_id}/export", json=payload,
        )
    assert response.status_code == 200, response.text
    assert seen == [(1, 50.0), (1, 0.0)]
    with pikepdf.Pdf.open(BytesIO(response.content)) as pdf:
        assert len(pdf.pages) == 2


@pytest.mark.parametrize("denoise", [None, 0.0, 5.0])
def test_export_ton_trong_requested_va_effective_denoise_cua_nguon(
    tmp_path, monkeypatch, denoise,
):
    session = _ready_session(
        tmp_path, monkeypatch, warnings=["simple-bg-preview-denoise-fallback"],
    )
    _preview(session, denoise)
    expected_commands = _expected_cubics(session.pages[1])
    before = copy.deepcopy(session.pages[1].cutline_export_cache)
    if denoise == 0.0:
        assert before["effective_cutline_denoise"] == 0.0
    else:
        assert before["effective_cutline_denoise"] > (denoise or 0.0)
    session.pages[1].cutline_export_cache = None
    with TestClient(app) as client:
        response = client.post(
            f"/api/sticker-sheet/{session.session_id}/export",
            json=_export_payload(denoise, document=True),
        )
    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(BytesIO(response.content)) as pdf:
        assert _pdf_cubics(pdf.pages[0]) == expected_commands
    after = session.pages[1].cutline_export_cache
    assert after["requested_cutline_denoise"] == denoise
    assert after["effective_cutline_denoise"] == before["effective_cutline_denoise"]
