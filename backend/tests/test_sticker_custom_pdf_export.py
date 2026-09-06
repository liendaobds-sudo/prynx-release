"""Xuất từ canvas chung phải giữ artwork PDF và đúng CUT người dùng đã duyệt."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pytest

from app.core import sticker_sheet_session as session_store
from app.core.pdfium_lock import pdfium_guard
from app.workers.cutline_geometry import build_bezier_segments_path_stream
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_sheet_export import (
    StickerCanonicalPreviewConflict,
    StickerSheetExportError,
    _cutline_overrides_from_preview_cache,
    apply_export_edits,
    export_sticker_sheet,
    export_sticker_sheet_document,
)
from app.workers.sticker_source_inspector import inspect_sticker_source
from app.workers.sticker_source_pipeline import detect_sticker_source


@pytest.fixture(autouse=True)
def isolated_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(session_store, "SESSION_ROOT", tmp_path / "sessions")
    created_before = set(session_store._SESSIONS)
    yield
    for session_id in set(session_store._SESSIONS) - created_before:
        session_store.close_session(session_id)


def _source(path: Path, *, rotation=0, user_unit=1, cut=False, cut_layer=False, hidden=False, profile=False):
    with pikepdf.Pdf.new() as document:
        page = document.add_blank_page(page_size=(260, 180))
        page.CropBox = pikepdf.Array([10, 10, 250, 170])
        page.Rotate = rotation
        page.UserUnit = user_unit
        forms = pikepdf.Dictionary()
        for name, color in (("/StickerOne", "0 0.75 0.2"), ("/StickerTwo", "0.95 0.55 0")):
            form = document.make_stream(f"{color} rg 0 0 55 65 re f".encode("ascii"))
            form.Type = pikepdf.Name.XObject
            form.Subtype = pikepdf.Name.Form
            form.BBox = pikepdf.Array([0, 0, 55, 65])
            form.Resources = pikepdf.Dictionary()
            forms[name] = form
        font = pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
        page.Resources = pikepdf.Dictionary(
            XObject=forms,
            Font=pikepdf.Dictionary(F1=font),
        )
        commands = (
            b"1 1 1 rg 0 0 260 180 re f\n"
            b"q 1 0 0 1 35 55 cm /StickerOne Do Q\n"
            b"q 1 0 0 1 150 50 cm /StickerTwo Do Q\n"
            b"0 0 1 rg 220 20 20 20 re f\n"
            b"0 0 0 rg BT /F1 9 Tf 140 150 Td (UNSELECTED TEXT) Tj ET\n"
        )
        if cut:
            function = pikepdf.Dictionary(
                FunctionType=2,
                Domain=pikepdf.Array([0, 1]),
                C0=pikepdf.Array([0, 0, 0, 0]),
                C1=pikepdf.Array([0, 1, 0, 0]),
                N=1,
            )
            page.Resources.ColorSpace = pikepdf.Dictionary(
                CutContour=pikepdf.Array([
                    pikepdf.Name.Separation,
                    pikepdf.Name.CutContour,
                    pikepdf.Name.DeviceCMYK,
                    function,
                ]),
            )
            commands += b"q /CutContour CS 1 SCN 0.5 w 32 52 61 71 re S 147 47 61 71 re S Q\n"
        if cut_layer:
            layer = document.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name="CutContour"))
            page.Resources.Properties = pikepdf.Dictionary(OldCut=layer)
            document.Root.OCProperties = pikepdf.Dictionary(
                OCGs=pikepdf.Array([layer]),
                D=pikepdf.Dictionary(Order=pikepdf.Array([layer])),
            )
            commands += b"/OC /OldCut BDC 1 0 1 RG 32 52 61 71 re S EMC\n"
        if hidden:
            layer = document.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name="Artwork ẩn"))
            page.Resources.Properties = pikepdf.Dictionary(Hidden=layer)
            document.Root.OCProperties = pikepdf.Dictionary(
                OCGs=pikepdf.Array([layer]),
                D=pikepdf.Dictionary(
                    BaseState=pikepdf.Name.ON,
                    OFF=pikepdf.Array([layer]),
                    Order=pikepdf.Array([layer]),
                ),
            )
            commands += b"/OC /Hidden BDC 0 0 0 rg 150 15 80 25 re f EMC\n"
        if profile:
            from app.core.color_provenance import embed_srgb_output_intent

            assert embed_srgb_output_intent(document)
            document.Root.OutputIntents[0].OutputConditionIdentifier = "TEST_ORIGINAL_INTENT"
        page.Contents = document.make_stream(commands)
        document.save(path)
    return commands


def _session(path: Path, *, two=False, generic=False):
    inspection = inspect_sticker_source(str(path), path.name)
    session = session_store.create_source_session(
        source_path=path, original_name=path.name, inspection=inspection,
    )
    detected = detect_sticker_source(
        session,
        object_ids=["vector-1", "vector-2"] if two else ["vector-1"],
    )
    session = session_store.promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source="simple-bg" if generic else detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        # Writer generic nhận cùng cấu trúc artifact nhưng không có object ID.
        vector_geometry_ref=None if generic else detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    assert session is not None
    confirmed = session_store.confirm_source_session(session.session_id, page_number=1)
    assert confirmed is not None
    return confirmed


def _settings(session, **overrides):
    dpi = session.pages[1].dpi
    return {
        "dpi": dpi[0], "dpi_y": dpi[1],
        "offset_mm": 0.0, "bleed_mm": 0.0,
        "cut_mode": "original", "corner_style": "preserve",
        "fill_holes": True, "cutline_smoothness": 50.0,
        "cutline_fidelity": 50.0, "curve_tension": 50.0,
        "min_detail_area_mm2": 1.0, "cutline_denoise": 70.0,
        **overrides,
    }


def _preview(session, settings, edits=None):
    return build_sticker_cutline_preview(
        session, page_number=1,
        base_revision=session.pages[1].manifest["mask_revision"],
        edits=edits or [], **settings,
    )


def _export(session, settings, fingerprint=None, edits=None, page_order=None, **options):
    return export_sticker_sheet_document(
        session,
        pages=[{
            "source_page": 1,
            "expected_revision": session.pages[1].manifest["mask_revision"],
            "expected_fingerprint": fingerprint,
            "edits": edits or [],
        }],
        page_order=page_order or [1], output_format="pdf",
        crop_to_sticker=False, preserve_existing_cut=False,
        bleed_color_type="image", **settings, **options,
    )


def _contents(page):
    contents = page.obj.get("/Contents")
    return b"\n".join(item.read_bytes() for item in contents) if isinstance(contents, pikepdf.Array) else contents.read_bytes()


def _render(path, scale=2, page_index=0):
    with pdfium_guard():
        with pdfium.PdfDocument(str(path)) as document:
            page = document[page_index]
            try:
                bitmap = page.render(scale=scale, rev_byteorder=True)
                try:
                    return np.array(bitmap.to_numpy(), copy=True)
                finally:
                    bitmap.close()
            finally:
                page.close()


def _no_refit(*_args, **_kwargs):
    raise AssertionError("Xuất phải dùng artifact đã duyệt, không nhận diện/fit/render selection lại")


@pytest.mark.parametrize("generic", [False, True])
def test_keep_sheet_giu_text_vector_va_dung_cubic_preview(tmp_path, monkeypatch, generic):
    source = tmp_path / "source.pdf"
    original = _source(source)
    session = _session(source, two=True, generic=generic)
    settings = _settings(session, offset_mm=0.7, bleed_mm=1.2)
    preview = _preview(session, settings)
    page_state = session.pages[1]
    cache = page_state.cutline_export_cache
    overrides = _cutline_overrides_from_preview_cache(
        page_state, cache_key=cache["key"], instance_ids=[1, 2],
        crop_to_sticker=False, dpi=settings["dpi"], dpi_y=settings["dpi_y"],
    )
    monkeypatch.setattr("app.workers.sticker_engine._render_selected_objects_rgba", _no_refit)
    monkeypatch.setattr("app.workers.sticker_engine._fit_alpha_bezier_paths", _no_refit)
    monkeypatch.setattr("app.workers.sticker_sheet_export.build_alpha_cutline_geometry", _no_refit)
    monkeypatch.setattr("app.workers.sticker_cutline_preview.build_sticker_cutline_preview", _no_refit)
    result = _export(session, settings, preview["fingerprint"])

    assert result.sticker_count == 2
    with pikepdf.Pdf.open(result.path) as document:
        page = document.pages[0]
        contents = _contents(page)
        assert original in contents
        assert contents.count(b"/StickerOne Do") == 1
        assert b"(UNSELECTED TEXT) Tj" in contents
        assert "/F1" in page.Resources.Font
        assert [float(value) for value in page.MediaBox] == [0, 0, 260, 180]
        assert [float(value) for value in page.CropBox] == [10, 10, 250, 170]
        assert contents.count(b"/CutContour CS") == 1
        for group in overrides[0]["path_groups"]:
            for command in build_bezier_segments_path_stream(group["exterior"], 160):
                assert command.encode("ascii") in contents


@pytest.mark.parametrize("rotation,user_unit", [(0, 1), (90, 2), (180, 1), (270, 2)])
def test_keep_sheet_bleed_va_cut_dung_vi_tri_sau_crop_rotate_userunit(
    tmp_path, rotation, user_unit,
):
    source = tmp_path / "rotated.pdf"
    _source(source, rotation=rotation, user_unit=user_unit)
    session = _session(source)
    settings = _settings(session, bleed_mm=1.5)
    preview = _preview(session, settings)
    result = _export(session, settings, preview["fingerprint"])
    source_pixels = _render(source, 2 * user_unit)
    result_pixels = _render(result.path, 2)
    assert source_pixels.shape == result_pixels.shape
    labels = np.load(session.pages[1].directory / "labels.npy", allow_pickle=False)
    selected = cv2.resize(
        (labels > 0).astype(np.uint8),
        (source_pixels.shape[1], source_pixels.shape[0]),
        interpolation=cv2.INTER_NEAREST,
    )
    # Ngoài tem + 2.5 mm quanh biên, kể cả text và trang trí, phải giống từng pixel.
    radius = int(np.ceil(2.5 * 72 / 25.4 * 2))
    allowed = cv2.dilate(selected, np.ones((2 * radius + 1, 2 * radius + 1), np.uint8)) > 0
    changed = np.any(source_pixels[:, :, :3] != result_pixels[:, :, :3], axis=2)
    assert np.count_nonzero(changed & ~allowed) == 0
    assert np.count_nonzero(changed & allowed & (selected == 0)) > 20
    with pikepdf.Pdf.open(result.path) as document:
        # /Rotate và /UserUnit được bake sang point vật lý, không bị mất scale.
        page = document.pages[0]
        assert int(page.obj.get("/Rotate", 0)) == 0
        assert float(page.obj.get("/UserUnit", 1)) == 1
        assert b"(UNSELECTED TEXT) Tj" in _contents(page)


@pytest.mark.parametrize("conflict", ["missing", "stale", "settings", "alpha"])
def test_custom_khong_xuat_neu_frame_canonical_mat_hoac_thay_doi(tmp_path, conflict):
    source = tmp_path / "source.pdf"
    _source(source)
    session = _session(source)
    settings = _settings(session)
    preview = _preview(session, settings)
    fingerprint = preview["fingerprint"]
    if conflict == "missing":
        fingerprint = None
    elif conflict == "stale":
        fingerprint = "khong-con-la-frame-hien-tai"
    elif conflict == "settings":
        settings["cutline_denoise"] = 50.0
    else:
        session.pages[1].cutline_export_cache["instances"][0]["alpha"][0, 0] ^= 1
    with pytest.raises(StickerCanonicalPreviewConflict):
        _export(session, settings, fingerprint)
    assert not list(session.directory.glob("tem_cutcontour_*.pdf"))


def test_chi_bu_xen_giu_mask_sua_tay_khong_can_dao_gia(tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    _source(source)
    session = _session(source)
    settings = _settings(session, cut_mode="none", bleed_mm=1.5)
    edits = [{
        "kind": "stroke", "tool": "erase", "instance_id": 1,
        "radius": 0.05, "points": [{"x": 0.25, "y": 0.68}],
    }]
    from app.workers.sticker_engine import StickerEngine
    real_process = StickerEngine.process_pdf
    captured = []

    def capture(engine, **kwargs):
        captured.append(kwargs["approved_contour_overrides"][0])
        return real_process(engine, **kwargs)

    monkeypatch.setattr(StickerEngine, "process_pdf", capture)
    monkeypatch.setattr("app.workers.sticker_engine._render_selected_objects_rgba", _no_refit)
    result = _export(session, settings, edits=edits)
    original_labels = np.load(session.pages[1].directory / "labels.npy", allow_pickle=False)
    edited = apply_export_edits(original_labels, edits, {1})
    assert np.count_nonzero(edited) < np.count_nonzero(original_labels)
    assert np.array_equal(captured[0]["alpha"] > 0, edited > 0)
    assert captured[0]["path_groups"] is None
    with pikepdf.Pdf.open(result.path) as document:
        contents = _contents(document.pages[0])
        assert b"/CutContour CS" not in contents
        assert b"(UNSELECTED TEXT) Tj" in contents


def test_thay_cut_spot_cu_khong_de_hai_dao_chong_nhau(tmp_path):
    source = tmp_path / "source.pdf"
    _source(source, cut=True)
    session = _session(source, generic=True)
    settings = _settings(session, offset_mm=0.8)
    preview = _preview(session, settings)
    result = _export(session, settings, preview["fingerprint"])
    from app.workers.cut_export.cut_layer_extractor import extract_cut_contours
    assert len(extract_cut_contours(str(result.path)).contours) == 1
    with pikepdf.Pdf.open(result.path) as document:
        assert b"(UNSELECTED TEXT) Tj" in _contents(document.pages[0])


def test_cut_ocg_chua_strip_duoc_phai_dung_khong_xuat_dao_trung(tmp_path):
    source = tmp_path / "source.pdf"
    _source(source, cut_layer=True)
    session = _session(source, generic=True)
    settings = _settings(session)
    preview = _preview(session, settings)
    with pytest.raises(StickerSheetExportError, match="lớp đường cắt"):
        _export(session, settings, preview["fingerprint"])
    assert not list(session.directory.glob("tem_cutcontour_*.pdf"))


def test_custom_co_hai_cut_cu_khong_duoc_xoa_dao_cua_tem_khong_chon(tmp_path):
    source = tmp_path / "existing-cuts.pdf"
    _source(source, cut=True)
    before = source.read_bytes()
    session = _session(source)
    settings = _settings(session)
    preview = _preview(session, settings)
    with pytest.raises(StickerSheetExportError, match="thay riêng đường cắt"):
        _export(session, settings, preview["fingerprint"])
    assert source.read_bytes() == before
    assert not list(session.directory.glob("tem_cutcontour_*.pdf"))


@pytest.mark.parametrize("margin", [0.0, 0.25])
def test_custom_tem_kin_hoac_gan_kin_trang_khong_bi_guard_ai_chan_oan(tmp_path, margin):
    source = tmp_path / "near-full-page.pdf"
    with pikepdf.Pdf.new() as document:
        page = document.add_blank_page(page_size=(100, 100))
        page.Contents = document.make_stream((
            "1 1 1 rg 0 0 100 100 re f\n"
            f"0 0.75 0.2 rg {margin} {margin} {100 - margin * 2} {100 - margin * 2} re f\n"
        ).encode("ascii"))
        document.save(source)
    session = _session(source)
    labels = np.load(session.pages[1].directory / "labels.npy", allow_pickle=False)
    assert np.mean(labels > 0) > 0.98
    settings = _settings(session)
    preview = _preview(session, settings)
    result = _export(session, settings, preview["fingerprint"])
    assert result.path.is_file()


def test_cau_mot_trang_cung_giu_pdf_goc(tmp_path):
    source = tmp_path / "source.pdf"
    original = _source(source)
    session = _session(source)
    settings = _settings(session)
    _preview(session, settings)
    result = export_sticker_sheet(
        session, edits=[], crop_to_sticker=False,
        output_format="pdf", **settings,
    )
    with pikepdf.Pdf.open(result.path) as document:
        assert original in _contents(document.pages[0])


@pytest.mark.parametrize("page_order", [[1], [1, 1]])
def test_catalog_giu_profile_va_layer_an_tren_moi_trang(tmp_path, page_order):
    source = tmp_path / "profile-hidden.pdf"
    _source(source, hidden=True, profile=True)
    session = _session(source, generic=True)
    settings = _settings(session, cut_mode="none")
    result = _export(session, settings, page_order=page_order)
    source_pixels = _render(source)
    for page_index in range(len(page_order)):
        assert np.array_equal(source_pixels, _render(result.path, page_index=page_index))
    with pikepdf.Pdf.open(result.path) as document:
        assert str(document.Root.OutputIntents[0].OutputConditionIdentifier) == "TEST_ORIGINAL_INTENT"
        hidden_layers = document.Root.OCProperties.D.OFF
        assert len(hidden_layers) == len(page_order)
        for page in document.pages:
            assert page.Resources.Properties.Hidden.objgen in {
                layer.objgen for layer in hidden_layers
            }


def test_pdf_khong_profile_khong_tu_gan_srgb_khi_ghep(tmp_path):
    source = tmp_path / "unprofiled.pdf"
    _source(source)
    session = _session(source, generic=True)
    result = _export(session, _settings(session, cut_mode="none"), page_order=[1, 1])
    with pikepdf.Pdf.open(result.path) as document:
        assert document.Root.get("/OutputIntents") is None
