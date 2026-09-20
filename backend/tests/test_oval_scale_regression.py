"""Regression tests for OVAL20.01: Oval sticker artwork scale bug fix (2026-09-20).

Bug OVAL20.01:
In homogeneous VDP die-cut mode, when subpages share the same page dimensions
as the master page but lack CutContour paths (having only small vector text/captions
and background bitmap in Form XObject), artwork_bbox mistakenly shrunk to the caption's
bounding box, causing show_pdf_page to blow up artwork by >200%.

The fix ensures:
1. Master registration inheritance: VDP pages matching master size inherit master die clip (scale 1.0).
2. Enhanced artwork_bbox: Form XObjects are included and CutContour paths are excluded.
3. Fail-safe scale clamp in nup_artwork: log warning and clamp if scale > 1.35.
"""
from __future__ import annotations

import os
import sys
import pytest
import pikepdf

from app.workers import pdf_wrapper as pdf_lib
from app.workers import nup_engine
from app.workers import sticker_homogeneous as sh
from app.workers.sticker_homogeneous import Rect


def test_oval_vdp_same_page_size_scale_one(tmp_path):
    """VDP pages with same dimensions as master page must maintain scale 1.000000."""
    src = str(tmp_path / "vdp_oval_source.pdf")
    out = str(tmp_path / "vdp_oval_imposed.pdf")

    # Tạo PDF 2 trang khổ 160x100 mm (453.54 x 283.46 pt)
    # Trang 0 (Master): đường bế oval (CutContour) + caption
    # Trang 1 (VDP): chỉ có caption nhỏ ở giữa + Form XObject nền
    pw_pt = 160.0 * 72.0 / 25.4
    ph_pt = 100.0 * 72.0 / 25.4

    doc = pdf_lib.open()
    # Trang 0: Master
    p0 = doc.new_page(width=pw_pt, height=ph_pt)
    s0 = p0.new_shape()
    # Đường bế oval / die-cut (magenta = die)
    s0.draw_rect(pdf_lib.Rect(10.0, 10.0, pw_pt - 10.0, ph_pt - 10.0))
    s0.finish(color=(0.0, 1.0, 0.0, 0.0), width=0.5)
    # Caption nhỏ ở giữa
    s0_cap = p0.new_shape()
    s0_cap.draw_rect(pdf_lib.Rect(pw_pt / 2 - 30, ph_pt / 2 - 10, pw_pt / 2 + 30, ph_pt / 2 + 10))
    s0_cap.finish(color=(0, 0, 0, 1), fill=(0, 0, 0, 1))
    s0.commit()
    s0_cap.commit()

    # Trang 1: VDP subpage (cùng khổ, chỉ có caption nhỏ)
    p1 = doc.new_page(width=pw_pt, height=ph_pt)
    s1 = p1.new_shape()
    s1.draw_rect(pdf_lib.Rect(pw_pt / 2 - 30, ph_pt / 2 - 10, pw_pt / 2 + 30, ph_pt / 2 + 10))
    s1.finish(color=(0, 0, 0, 1), fill=(0, 0, 0, 1))
    s1.commit()

    doc.save(src)
    doc.close()

    # Gắn Form XObject giả lập background vào trang 1
    with pikepdf.Pdf.open(src, allow_overwriting_input=True) as pdoc:
        form_xobj = pdoc.make_stream(b"q 0.5 0.5 0.5 rg 0 0 453.54 283.46 re f Q")
        form_xobj.Type = pikepdf.Name("/XObject")
        form_xobj.Subtype = pikepdf.Name("/Form")
        form_xobj.BBox = pikepdf.Array([0, 0, pw_pt, ph_pt])
        pdoc.pages[1].Resources.XObject = pikepdf.Dictionary({
            "/BgForm": form_xobj
        })
        pdoc.save(src)

    # Chạy N-Up sequential
    settings = {
        'taskMode': 'nup',
        'layoutType': 'sequential',
        'gridStrategy': 'optimal_auto',
        'groupingStrategy': 'none',
        'sheetWidth': 330,
        'sheetHeight': 480,
        'gapX': 2,
        'gapY': 2,
        'bleed': 0,
        'marginTop': 5,
        'marginBottom': 5,
        'marginLeft': 5,
        'marginRight': 5,
        'isDieCutMode': True,
        'pontType': 'none',
        'targetQuantity': 0,
        'targetQuantitiesByPage': {},
    }

    nup_engine.run_nup_engine(src, out, settings)

    assert os.path.exists(out), "Output PDF must be generated"
    with pikepdf.Pdf.open(out) as out_pdf:
        assert len(out_pdf.pages) >= 1
        p0_out = out_pdf.pages[0]
        ops = list(pikepdf.parse_content_stream(p0_out))
        cms = []
        for i, op in enumerate(ops):
            if str(op.operator) == 'cm' and i + 1 < len(ops) and str(ops[i + 1].operator) == 'Do':
                cms.append((round(float(op.operands[0]), 4), round(float(op.operands[3]), 4)))

        assert len(cms) > 0, "Must have placed artworks"
        for sx, sy in cms:
            assert abs(sx - 1.0) < 0.05, f"Placement scale_x {sx} must be ~1.0, not blown up"
            assert abs(sy - 1.0) < 0.05, f"Placement scale_y {sy} must be ~1.0, not blown up"


def test_artwork_bbox_form_xobject_and_die_exclusion():
    """artwork_bbox must include Form XObject BBox and ignore CutContour die paths."""
    pw, ph = 400.0, 300.0
    doc = pdf_lib.open()
    p = doc.new_page(width=pw, height=ph)
    s = p.new_shape()
    # Đường bế CutContour
    s.draw_rect(pdf_lib.Rect(10, 10, 390, 290))
    s.finish(color=(0, 1, 0, 0), width=1.0)
    # Caption nhỏ
    s_cap = p.new_shape()
    s_cap.draw_rect(pdf_lib.Rect(150, 130, 250, 170))
    s_cap.finish(color=(0, 0, 0, 1))
    s.commit()
    s_cap.commit()

    # Form XObject bao trọn trang
    pike_page = p._page
    form_stream = doc._pdf.make_stream(b"")
    form_stream.Type = pikepdf.Name("/XObject")
    form_stream.Subtype = pikepdf.Name("/Form")
    form_stream.BBox = pikepdf.Array([0, 0, pw, ph])
    if "/Resources" not in pike_page:
        pike_page.Resources = pikepdf.Dictionary()
    pike_page.Resources.XObject = pikepdf.Dictionary({"/F1": form_stream})

    bbox = sh.artwork_bbox(p)
    assert bbox is not None
    # BBox phải bao trọn Form XObject (0, 0, 400, 300), không bị co lại 150..250 của caption
    assert abs(bbox.x0 - 0.0) < 1.0
    assert abs(bbox.y0 - 0.0) < 1.0
    assert abs(bbox.x1 - pw) < 1.0
    assert abs(bbox.y1 - ph) < 1.0


def test_customer_oval_artifact_scale_one(tmp_path):
    """Real customer file sticker_6419bca2.pdf must have scale == (1.0, 1.0) on all placements."""
    fixture_path = os.path.join(os.path.dirname(__file__), 'sticker_6419bca2.pdf')
    if not os.path.exists(fixture_path):
        pytest.skip("Customer artifact sticker_6419bca2.pdf not in tests directory")

    out = str(tmp_path / "customer_out.pdf")
    settings = {
        'taskMode': 'nup',
        'layoutType': 'sequential',
        'gridStrategy': 'optimal_auto',
        'groupingStrategy': 'none',
        'sheetWidth': 330,
        'sheetHeight': 480,
        'gapX': 2,
        'gapY': 2,
        'bleed': 0,
        'marginTop': 5,
        'marginBottom': 5,
        'marginLeft': 5,
        'marginRight': 5,
        'isDieCutMode': True,
        'pontType': 'none',
        'targetQuantity': 0,
        'targetQuantitiesByPage': {},
    }
    nup_engine.run_nup_engine(fixture_path, out, settings)
    with pikepdf.Pdf.open(out) as out_pdf:
        assert len(out_pdf.pages) == 16
        total_placements = 0
        for p in out_pdf.pages:
            ops = list(pikepdf.parse_content_stream(p))
            for i, op in enumerate(ops):
                if str(op.operator) == 'cm' and i + 1 < len(ops) and str(ops[i + 1].operator) == 'Do':
                    sx = round(float(op.operands[0]), 4)
                    sy = round(float(op.operands[3]), 4)
                    assert (sx, sy) == (1.0, 1.0), f"Placement scale must be 1.0, got ({sx}, {sy})"
                    total_placements += 1
        assert total_placements == 128, f"Expected 128 placements, got {total_placements}"

