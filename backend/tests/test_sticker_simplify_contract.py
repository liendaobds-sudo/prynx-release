"""QUALITY (audit 2026-09-09 §SIMPLIFY.1): giữ đúng sai số bổ sung qua preview/xuất."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import shutil

from fastapi import HTTPException
import pikepdf
from pydantic import ValidationError
import pytest

from app.api.routes import pdf_tools, sticker_sheet as routes
from app.schemas.sticker_sheet import (
    StickerCutlinePreviewRequest,
    StickerCutlineQualityResponse,
    StickerSheetExportRequest,
    StickerSheetPageExportRequest,
)
from app.workers import sticker_cutline_preview as preview_worker
from app.workers import sticker_engine as engine_module
from app.workers import sticker_sheet_export as exporter
from app.workers import sticker_source_pipeline as source_worker
from app.workers import cutline_cubic_simplify as simplifier
from app.workers.cutline_geometry import _linear_cubic_segment
from test_sticker_cutline_export_denoise import GEOMETRY, _ready_session
from test_sticker_cutline_preview import (
    _classic_execute_form,
    _prime_classic_preview_artifact,
    _session,
)


def _cache_options():
    return dict(page_number=1, revision=3, edits=[], cutline_denoise=None, **GEOMETRY)


def _minimal_pdf(path: Path, page_count: int = 1) -> Path:
    with pikepdf.Pdf.new() as pdf:
        for _ in range(page_count):
            pdf.add_blank_page(page_size=(100, 100))
        pdf.save(path)
    return path


def _path_groups():
    points = [(10.0, 10.0), (90.0, 10.0), (90.0, 90.0), (10.0, 90.0)]
    return [{
        "exterior": [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:] + points[:1])],
        "interiors": [],
    }]


@pytest.mark.parametrize("model", [StickerCutlinePreviewRequest, StickerSheetExportRequest, StickerSheetPageExportRequest])
@pytest.mark.parametrize("value", [-0.0001, 0.1001, "NaN", "Infinity", "-Infinity", None, "khong-hop-le"])
def test_simplify_schema_tu_choi_gia_tri_ngoai_hop_dong(model, value):
    payload = dict(base_revision=3, source_page=1, expected_revision=3, cutline_simplify_mm=value)
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize("model", [StickerCutlinePreviewRequest, StickerSheetExportRequest, StickerSheetPageExportRequest])
def test_simplify_schema_thieu_field_mac_dinh_khong(model):
    request = model.model_validate(dict(base_revision=3, source_page=1, expected_revision=3))
    assert request.cutline_simplify_mm == 0.0
    assert "cutline_simplify_mm" not in request.model_fields_set


@pytest.mark.parametrize("model", [StickerCutlinePreviewRequest, StickerSheetExportRequest, StickerSheetPageExportRequest])
@pytest.mark.parametrize("value", [0.0, 0.0125, 0.05, 0.1])
def test_simplify_schema_nhan_dung_don_vi_mm(model, value):
    request = model.model_validate(dict(
        base_revision=3, source_page=1, expected_revision=3, cutline_simplify_mm=value,
    ))
    assert request.cutline_simplify_mm == value


def test_simplify_cache_zero_giu_hash_legacy_va_muc_duong_khong_alias():
    options = _cache_options()
    legacy_payload = dict(
        page=1, revision=3, edits=[], dpi=100.0, dpi_y=100.0,
        offset_mm=0.0, bleed_mm=0.0, cut_mode="original", corner_style="preserve",
        fill_holes=True, cutline_smoothness=50.0, cutline_fidelity=50.0,
        curve_tension=50.0, min_detail_area_mm2=1.0, cutline_denoise=None,
    )
    expected = hashlib.sha256(json.dumps(
        legacy_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()
    assert exporter._cutline_export_cache_key(**options) == expected
    assert exporter._cutline_export_cache_key(**options, cutline_simplify_mm=0.0) == expected
    keys = [exporter._cutline_export_cache_key(**options, cutline_simplify_mm=value)
            for value in (0.0, 0.01, 0.02, 0.05, 0.1)]
    assert len(set(keys)) == 5


def test_simplify_doi_phien_ban_loi_chi_vo_hieu_cache_duong(monkeypatch):
    """Đổi thuật toán không được tái dùng vector dương; zero giữ hash legacy."""
    options = _cache_options()
    baseline_key = exporter._cutline_export_cache_key(**options)
    current_key = exporter._cutline_export_cache_key(**options, cutline_simplify_mm=0.1)
    monkeypatch.setattr(simplifier, "CUTLINE_SIMPLIFY_ALGORITHM", "historical-test-v0")
    assert exporter._cutline_export_cache_key(**options) == baseline_key
    assert exporter._cutline_export_cache_key(**options, cutline_simplify_mm=0.0) == baseline_key
    assert exporter._cutline_export_cache_key(**options, cutline_simplify_mm=0.1) != current_key


@pytest.mark.parametrize("simplify_mm", [0.0, 0.1], ids=["baseline", "neo-tu-do"])
def test_simplify_fingerprint_goi_phien_ban_loi_ke_ca_khi_vector_giong_nhau(
    tmp_path, monkeypatch, simplify_mm,
):
    session = _ready_session(tmp_path, monkeypatch)
    options = dict(page_number=1, base_revision=3, edits=[],
                   cutline_simplify_mm=simplify_mm, **GEOMETRY)
    current = preview_worker.build_sticker_cutline_preview(session, **options)
    current_key = session.pages[1].cutline_export_cache["key"]
    monkeypatch.setattr(simplifier, "CUTLINE_SIMPLIFY_ALGORITHM", "historical-test-v0")
    historical = preview_worker.build_sticker_cutline_preview(session, **options)
    assert current["paths"] == historical["paths"]
    assert (current["fingerprint"] != historical["fingerprint"]) is (simplify_mm > 0)
    assert (current_key != session.pages[1].cutline_export_cache["key"]) is (simplify_mm > 0)


@pytest.mark.parametrize("value", [-0.001, 0.1001, float("nan"), float("inf"), None])
def test_simplify_worker_key_khong_alias_input_sai_ve_zero(value):
    with pytest.raises(exporter.StickerSheetExportError):
        exporter._cutline_export_cache_key(**_cache_options(), cutline_simplify_mm=value)


def test_simplify_quality_response_giu_du_thong_ke():
    statistics = dict(before_segments=100, after_segments=60, maximum_error_bound_mm=0.019, changed=True)
    response = StickerCutlineQualityResponse.model_validate(dict(segment_count=60, simplification=statistics))
    assert response.model_dump()["simplification"] == statistics


@pytest.mark.parametrize("simplify_mm", [0.025, 0.1])
def test_simplify_preview_route_truyen_muc_mm(tmp_path, monkeypatch, simplify_mm):
    session = _ready_session(tmp_path, monkeypatch)
    captured = {}

    def preview(*_args, **kwargs):
        captured.update(kwargs)
        return {"segment_count": 12}

    monkeypatch.setattr(routes, "build_sticker_cutline_preview", preview)
    result = asyncio.run(routes.preview_sticker_cutline_endpoint(
        session.session_id, StickerCutlinePreviewRequest(base_revision=3, cutline_simplify_mm=simplify_mm),
    ))
    assert result["segment_count"] == 12
    assert captured["cutline_simplify_mm"] == simplify_mm


@pytest.mark.parametrize("page_value", [None, 0.0, 0.015], ids=["ke-thua", "tat", "rieng-trang"])
def test_simplify_route_page_thieu_ke_thua_nhung_zero_khong_bi_bo(tmp_path, monkeypatch, page_value):
    session = _ready_session(tmp_path, monkeypatch)
    captured = {}
    output = _minimal_pdf(tmp_path / "result.pdf")

    def export(*_args, **kwargs):
        captured.update(kwargs)
        return exporter.StickerSheetExportResult(output, "result.pdf", "application/pdf", 1)

    monkeypatch.setattr(routes, "export_sticker_sheet_document", export)
    page = dict(source_page=1, expected_revision=3, edits=[])
    if page_value is not None:
        page["cutline_simplify_mm"] = page_value
    request = StickerSheetExportRequest(
        pages=[page], page_order=[1], cutline_simplify_mm=0.03,
    )
    response = asyncio.run(routes.export_sticker_sheet_endpoint(session.session_id, request))
    assert Path(response.path).is_file()
    assert captured["cutline_simplify_mm"] == 0.03
    if page_value is None:
        assert "cutline_simplify_mm" not in captured["pages"][0]
    else:
        assert captured["pages"][0]["cutline_simplify_mm"] == page_value


def test_simplify_document_segment_giu_ke_thua_zero_va_thu_tu_lap(tmp_path, monkeypatch):
    session = _ready_session(tmp_path, monkeypatch)
    second_directory = tmp_path / "page2"
    second_directory.mkdir()
    second = _session(second_directory).pages[1]
    second.page_number = 2
    second.stage = "mask-ready"
    session.pages[2] = second
    session.page_count = 2
    monkeypatch.setattr(exporter, "_cutline_overrides_with_preview_fallback", lambda *args, **kwargs: None)
    seen = []

    def build(png_paths, work_dir, **kwargs):
        seen.append(kwargs["cutline_simplify_mm"])
        return _minimal_pdf(work_dir / f"segment_{len(seen)}.pdf", len(png_paths))

    monkeypatch.setattr(exporter, "_build_cutline_pdf_from_pngs", build)
    result = exporter.export_sticker_sheet_document(
        session,
        pages=[dict(source_page=1, expected_revision=3),
               dict(source_page=2, expected_revision=3, cutline_simplify_mm=0.0)],
        page_order=[1, 2, 1], output_format="pdf", crop_to_sticker=False,
        preserve_existing_cut=False, cutline_simplify_mm=0.03, **GEOMETRY,
    )
    assert seen == [0.03, 0.0, 0.03]
    with pikepdf.Pdf.open(result.path) as pdf:
        assert len(pdf.pages) == 3


def test_simplify_cache_rebuild_truyen_cung_muc_mm(tmp_path, monkeypatch):
    session = _ready_session(tmp_path, monkeypatch)
    reads, builds = [], []

    def read(*_args, **kwargs):
        reads.append(kwargs["cache_key"])
        return None if len(reads) == 1 else [{"path_groups": _path_groups()}]

    def build(*_args, **kwargs):
        builds.append(kwargs["cutline_simplify_mm"])

    monkeypatch.setattr(exporter, "_cutline_overrides_from_preview_cache", read)
    monkeypatch.setattr(preview_worker, "build_sticker_cutline_preview", build)
    result = exporter._cutline_overrides_with_preview_fallback(
        session, session.pages[1], page_number=1, revision=3, edits=[],
        instance_ids=[1], crop_to_sticker=False, cutline_simplify_mm=0.02, **GEOMETRY,
    )
    expected = exporter._cutline_export_cache_key(**_cache_options(), cutline_simplify_mm=0.02)
    assert result is not None
    assert reads == [expected, expected]
    assert builds == [0.02]


@pytest.mark.parametrize("cached", [False, True])
def test_simplify_png_fallback_va_engine_giu_cung_mm(tmp_path, monkeypatch, cached):
    session = _ready_session(tmp_path, monkeypatch)
    fits, processes = [], []

    def build(*_args, **kwargs):
        fits.append(kwargs["cutline_simplify_mm"])
        return {"path_groups": _path_groups()}

    class Engine:
        def __init__(self, dpi):
            self.dpi = dpi

        def process_pdf(self, **kwargs):
            processes.append(kwargs["cutline_simplify_mm"])
            _minimal_pdf(Path(kwargs["output_path"]))
            return True, {}

    monkeypatch.setattr(exporter, "build_alpha_cutline_geometry", build)
    monkeypatch.setattr(exporter, "StickerEngine", Engine)
    monkeypatch.setattr(exporter, "_png_pages_to_pdf", lambda _paths, output, *_dpi: _minimal_pdf(output))
    overrides = [{"path_groups": _path_groups()}] if cached else None
    output = exporter._build_cutline_pdf_from_pngs(
        [session.directory / "rgba.png"], tmp_path, **GEOMETRY,
        crop_to_sticker=True, bleed_color_type="solid", solid_bleed_cmyk=(0.0, 0.0, 0.0, 0.0),
        shape_mode="contour", draw_cut_contour=True, cutline_simplify_mm=0.02,
        alpha_path_override_sequence=overrides,
    )
    assert output.is_file()
    assert fits == ([] if cached else [0.02])
    assert processes == [0.02]


def test_simplify_snapshot_tu_choi_muc_moi_khi_cache_con_zero(tmp_path, monkeypatch):
    session, source, preview = _prime_classic_preview_artifact(tmp_path, monkeypatch)
    with pytest.raises(exporter.StickerCanonicalPreviewConflict, match="Thiết lập"):
        exporter.snapshot_classic_cutline_preview(
            session, source_path=source, page_number=1, expected_revision=3,
            expected_fingerprint=preview["fingerprint"], offset_mm=0.0, bleed_mm=2.0,
            cut_mode="original", corner_style="preserve", fill_holes=True,
            curve_tension=50.0, cutline_denoise=None, cutline_simplify_mm=0.02,
        )


def test_simplify_snapshot_tu_choi_cache_loi_cu_du_cung_muc_va_fingerprint(tmp_path, monkeypatch):
    """Fingerprint caller khớp cache vẫn không thay được phiên bản thuật toán."""
    session, source, preview = _prime_classic_preview_artifact(tmp_path, monkeypatch)
    with monkeypatch.context() as previous:
        previous.setattr(simplifier, "CUTLINE_SIMPLIFY_ALGORITHM", "historical-test-v0")
        session.pages[1].cutline_export_cache["key"] = exporter._cutline_export_cache_key(
            **_cache_options(), cutline_simplify_mm=0.1,
        )
    with pytest.raises(exporter.StickerCanonicalPreviewConflict, match="Thiết lập"):
        exporter.snapshot_classic_cutline_preview(
            session, source_path=source, page_number=1, expected_revision=3,
            expected_fingerprint=preview["fingerprint"], offset_mm=0.0, bleed_mm=2.0,
            cut_mode="original", corner_style="preserve", fill_holes=True,
            curve_tension=50.0, cutline_denoise=None, cutline_simplify_mm=0.1,
        )


@pytest.mark.parametrize("canonical", [False, True], ids=["legacy-helper", "snapshot"])
@pytest.mark.parametrize("simplify_mm", [0.02, 0.1])
def test_simplify_classic_route_truyen_snapshot_helper_va_engine(tmp_path, monkeypatch, canonical, simplify_mm):
    session, source, preview = _prime_classic_preview_artifact(tmp_path, monkeypatch)
    seen = {"snapshot": [], "legacy": [], "engine": []}
    if canonical:
        # Ca này kiểm routing; cache tạo với knob dương mà không phụ thuộc thuật toán giảm node.
        session.pages[1].cutline_export_cache["key"] = exporter._cutline_export_cache_key(
            **_cache_options(), cutline_simplify_mm=simplify_mm,
        )
    original_snapshot = exporter.snapshot_classic_cutline_preview

    def snapshot(*args, **kwargs):
        seen["snapshot"].append(kwargs["cutline_simplify_mm"])
        return original_snapshot(*args, **kwargs)

    def legacy(*_args, **kwargs):
        seen["legacy"].append(kwargs["cutline_simplify_mm"])
        return None

    class Engine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            seen["engine"].append(kwargs["cutline_simplify_mm"])
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    class Request:
        async def form(self):
            form = _classic_execute_form(source, preview, cutline_simplify_mm=str(simplify_mm))
            if not canonical:
                for key in list(form):
                    if key.startswith("cutline_preview_"):
                        form.pop(key)
            return form

    monkeypatch.setattr(exporter, "snapshot_classic_cutline_preview", snapshot)
    monkeypatch.setattr(source_worker, "build_legacy_single_page_approved_contour", legacy)
    monkeypatch.setattr(engine_module, "StickerEngine", Engine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args: None)
    response = asyncio.run(pdf_tools.sticker_dieline_endpoint(Request(), license_info={}))
    assert Path(response.path).is_file()
    assert seen["engine"] == [simplify_mm]
    assert seen["snapshot"] == ([simplify_mm] if canonical else [])
    assert seen["legacy"] == ([] if canonical else [simplify_mm])


@pytest.mark.parametrize("value", ["NaN", "Infinity", "khong-phai-so"])
def test_simplify_form_tu_choi_so_khong_huu_han(value):
    with pytest.raises(HTTPException) as caught:
        pdf_tools._sticker_float_param({"cutline_simplify_mm": value}, "cutline_simplify_mm", default=0.0,
                                      low=0.0, high=simplifier.CUTLINE_SIMPLIFY_MAX_MM)
    assert caught.value.status_code == 400


def test_simplify_khong_copy_cutcontour_goc_khi_nguoi_dung_chon_muc_duong(tmp_path):
    session = _session(tmp_path)
    session.source_kind = "pdf"
    session.boundary_source = "existing-cut"
    session.manifest["vector_geometry_ref"] = {"kind": "pdf-cut-contours", "preserve_original": True}
    options = dict(edits=[], output_format="pdf", cut_mode="original", offset_mm=0.0,
                   bleed_mm=0.0, corner_style="preserve", crop_to_sticker=False,
                   draw_cut_contour=True, preserve_existing_cut=True)
    assert exporter._can_preserve_existing_cut(session, **options, cutline_simplify_mm=0.0)
    with pytest.raises(exporter.StickerSheetExportError, match="CutContour có sẵn"):
        exporter.export_sticker_sheet(session, dpi=100.0, **options, cutline_simplify_mm=0.02)
