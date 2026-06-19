"""Test dựng CutModel từ PDF đã bình (task 12.3/18 — nguồn hình học thật). Req 1.1, 6.3, 10.

Dùng fixture corel_cut_sample.pdf (file print-and-cut thật, lớp cắt PL_SR_Cutline_Combined_1).
"""

import os

import pytest

from app.workers.cut_export.pdf_source import (
    cut_model_from_polygon,
    build_cut_model_from_pdf,
    preview_svg_from_pdf,
    PT_TO_MM,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "corel_cut_sample.pdf")


def test_cut_model_from_polygon_scales_pt_to_mm():
    pytest.importorskip("shapely")
    from shapely.geometry import Polygon
    # Hình vuông 72pt = 1 inch = 25.4mm.
    poly = Polygon([(0, 0), (72, 0), (72, 72), (0, 72)])
    cm = cut_model_from_polygon(poly, sheet_w_pt=144, sheet_h_pt=216)
    assert len(cm.paths) == 1
    b = cm.paths[0].bounds()
    assert b is not None
    assert abs(b[2] - 25.4) < 0.01
    assert abs(cm.sheet_w_mm - 144 * PT_TO_MM) < 0.01


def test_build_cut_model_from_real_cut_layer():
    pytest.importorskip("pikepdf")
    cm = build_cut_model_from_pdf(FIXTURE, page_idx=0)
    # File có 75 con tem trên lớp cắt — phải ra 75 đường cắt (không phải số ốc).
    assert len([p for p in cm.paths if not p.is_empty]) == 75
    assert cm.sheet_w_mm > 0 and cm.sheet_h_mm > 0


def test_build_from_pdf_missing_cut_raises_with_hint():
    pytest.importorskip("pikepdf")
    import tempfile
    from reportlab.pdfgen import canvas

    fd = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    fd.close()
    c = canvas.Canvas(fd.name, pagesize=(200, 200), invariant=1)
    c.showPage()  # trang trống, không có lớp cắt
    c.save()
    try:
        with pytest.raises(ValueError):
            build_cut_model_from_pdf(fd.name, 0)
    finally:
        os.remove(fd.name)


def test_preview_svg_from_real_file():
    pytest.importorskip("pikepdf")
    d = preview_svg_from_pdf(FIXTURE, 0)
    assert d["total_items"] == 75
    assert d["svg"].startswith("<?xml")
    assert "<svg" in d["svg"]
    assert d["num_pages"] >= 1
    assert d["sheet_w_mm"] > 0
