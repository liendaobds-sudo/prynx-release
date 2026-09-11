"""Preview toàn trang phải đọc đúng lệnh CUT, không bị giới hạn trang đầu."""
from io import BytesIO
from pathlib import Path

import pikepdf
import pytest

from app.workers.sticker_classic_page_preview import _pdf_cut_svg, _render_classic_page
from app.workers.sticker_sheet_export import StickerSheetExportError


def test_svg_uses_source_crop_coordinates_not_expanded_output_translation():
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(120, 100))
        page.Contents = pdf.make_stream(b"q 1 0 0 1 9 9 cm /CutContour CS 1 SCN 1 w 10 20 m 20 20 30 40 40 40 c 10 20 l h S Q")
        svg, count = _pdf_cut_svg(page, 100, 80, 200, 160)
    assert count == 2
    assert svg == "M 20.00000000 120.00000000 C 40.00000000 120.00000000 60.00000000 80.00000000 80.00000000 80.00000000 L 20.00000000 120.00000000 Z"


def test_unexpected_cut_transform_or_open_path_is_rejected():
    for stream in (b"/CutContour CS 1 0 0 1 10 10 cm", b"/CutContour CS 0 0 m 1 0 l S"):
        with pikepdf.Pdf.new() as pdf:
            page = pdf.add_blank_page()
            page.Contents = pdf.make_stream(stream)
            with pytest.raises(StickerSheetExportError):
                _pdf_cut_svg(page, 10, 10, 100, 100)


def test_preview_route_dispatches_whole_page_explicitly_without_changing_sheet_default(monkeypatch):
    import asyncio
    from app.api.routes import sticker_sheet as route
    from app.schemas.sticker_sheet import StickerCutlinePreviewRequest
    from app.workers import sticker_classic_page_preview as worker

    captured = []
    session = object()
    monkeypatch.setattr(route, "get_session", lambda _id: session)
    def whole(_session, **options):
        captured.append(options)
        return {"classic_whole_page": True}
    monkeypatch.setattr(worker, "build_classic_page_preview", whole)
    result = asyncio.run(route.preview_sticker_cutline_endpoint("test", StickerCutlinePreviewRequest(
        base_revision=3, page_number=12, classic_whole_page=True,
        classic_force_contour=True, cutline_simplify_mm=.1)))
    assert result["classic_whole_page"] is True
    assert captured[0]["page_number"] == 12
    assert captured[0]["classic_force_contour"] is True
    assert captured[0]["cutline_simplify_mm"] == .1
    assert StickerCutlinePreviewRequest(base_revision=1).classic_whole_page is False


@pytest.mark.parametrize("page_number", [2, 12])
def test_real_binder_later_pages_whole_path_matches_actual_pdf(page_number):
    from app.workers.sticker_engine import StickerEngine
    source = Path(__file__).resolve().parents[2] / "test/Binder2.pdf"
    if not source.exists():
        pytest.skip("Corpus Binder2 riêng")
    geometry = dict(cut_mode="original", offset_mm=2, bleed_mm=0,
                    corner_style="preserve", fill_holes=True, cutline_smoothness=50,
                    cutline_fidelity=50, curve_tension=50, cutline_denoise=30,
                    min_detail_area_mm2=1, cutline_simplify_mm=0, shape_mode="auto_safe")
    svg, count, quality = _render_classic_page(str(source), page_number, (600, 600), geometry)
    result = StickerEngine(dpi=300).process_pdf(
        str(source), "", _page_subset=[page_number-1], remove_white_bg=True,
        draw_cut_contour=True, alpha_corner_policy="adaptive", **geometry)
    with pikepdf.Pdf.open(source) as pdf:
        box = pdf.pages[page_number-1].cropbox
        width, height = float(box[2]-box[0]), float(box[3]-box[1])
    with pikepdf.Pdf.open(BytesIO(result[0])) as pdf:
        expected = _pdf_cut_svg(pdf.pages[0], width, height, 600, 600)
    assert (svg, count) == expected
    assert count > 0 and quality["fit_mode"] == "classic-whole-page"
    if page_number == 12:
        assert count == 122


def test_round_bleed_writer_runs_simplify_on_its_actual_cubics():
    from app.workers.sticker_engine import StickerEngine
    from app.workers.cutline_fair_verify import verify_fair_ring, _distance_bound
    from test_sticker_engine_e2e import _parse_cut_machine_paths
    import numpy as np

    source = Path(__file__).resolve().parents[2] / "test/Binder2.pdf"
    if not source.exists():
        pytest.skip("Corpus Binder2 riêng")
    options = dict(input_path=str(source), output_path="", _page_subset=[11],
                   cut_mode="bleed", offset_mm=0, bleed_mm=2, corner_style="round",
                   curve_tension=100, cutline_denoise=30, remove_white_bg=True,
                   shape_mode="auto_safe", alpha_corner_policy="adaptive")
    rings = []
    for tolerance in (0, .1):
        result = StickerEngine(dpi=300).process_pdf(**options, cutline_simplify_mm=tolerance)
        with pikepdf.Pdf.open(BytesIO(result[0])) as pdf:
            paths = _parse_cut_machine_paths(pdf.pages[0])
            assert len(paths) == 1
            rings.append(np.array([[s.p0,s.p1,s.p2,s.p3] for s in paths[0]]) * 25.4/72)
    assert len(rings[0]) == 364
    assert len(rings[1]) < len(rings[0]) / 2
    stats = result[1][0]["cutline_simplification"]
    assert stats["changed"] and stats["before_segments"] == len(rings[0])
    assert stats["after_segments"] == len(rings[1])
    assert stats["maximum_error_bound_mm"] <= .1
    checked = verify_fair_ring(rings[0], rings[1], tolerance_mm=.1)
    assert checked.reason in {"accepted", "distance_exceeded"}
    # Cận coarse cộng h/2 có thể vượt 0,1 dù đường còn trong band. Thu nhỏ
    # bước chứng nhận, không nới dung sai và không bỏ kiểm topology/độ cong.
    as_tuple = lambda ring: tuple(tuple(tuple(p) for p in c) for c in ring)
    measured, bound = _distance_bound(as_tuple(rings[0]), as_tuple(rings[1]), .01)
    assert measured <= bound <= .1


def test_whole_page_worker_process_handles_later_page_without_single_instance_limit():
    from types import SimpleNamespace
    from threading import RLock
    from app.workers.sticker_classic_page_preview import build_classic_page_preview

    source = Path(__file__).resolve().parents[2] / "test/Binder2.pdf"
    if not source.exists():
        pytest.skip("Corpus Binder2 riêng")
    page = SimpleNamespace(stage="mask-review", boundary_source="alpha", operation_lock=RLock(),
                           manifest={"mask_revision": 7, "instances": [{"id": x} for x in range(1,7)]},
                           preview_width_px=600, preview_height_px=600)
    session = SimpleNamespace(source_kind="pdf", source_path=source, pages={12: page})
    result = build_classic_page_preview(session, page_number=12, base_revision=7, edits=[],
        offset_mm=2, bleed_mm=0, cut_mode="original", corner_style="preserve", fill_holes=True,
        cutline_smoothness=50, cutline_fidelity=50, curve_tension=50,
        min_detail_area_mm2=1, cutline_denoise=30, cutline_simplify_mm=0)
    assert result["page_number"] == 12 and result["mask_revision"] == 7
    assert result["segment_count"] == 122
    assert result["paths"][0]["d"].count("C ") == 122
    assert result["paths"][0]["d"].count("M ") == 1
