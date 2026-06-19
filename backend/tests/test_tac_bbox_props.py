"""Property test: gom vùng TAC (≤50) và quy đổi pixel→point.

Feature: preflight-depth-upgrade
"""
import numpy as np
from hypothesis import given, settings, strategies as st
from hypothesis.extra import numpy as hnp

from app.core.preflight_rules.ink import (
    _cluster_mask_to_bboxes,
    _px_bbox_to_pdf_point,
    TAC_MAX_BBOXES,
    TAC_TILE_PX,
)


# Feature: preflight-depth-upgrade, Property 10: Gom vùng TAC bị giới hạn (≤50) và quy đổi pixel→point đúng
@settings(max_examples=100)
@given(
    mask=hnp.arrays(
        np.bool_, st.tuples(st.integers(1, 64), st.integers(1, 64)),
        elements=st.booleans(),
    ),
)
def test_cluster_limited_and_within_bounds(mask):
    h, w = mask.shape
    bboxes = _cluster_mask_to_bboxes(mask, TAC_TILE_PX, TAC_MAX_BBOXES)
    assert len(bboxes) <= TAC_MAX_BBOXES
    for px0, py0, px1, py1 in bboxes:
        assert 0 <= px0 < px1 <= w
        assert 0 <= py0 < py1 <= h


# Feature: preflight-depth-upgrade, Property 10 (quy đổi): pixel→point round-trip
@settings(max_examples=100)
@given(
    px0=st.integers(0, 500), extra_x=st.integers(1, 500),
    py0=st.integers(0, 500), extra_y=st.integers(1, 500),
    render_dpi=st.integers(36, 300),
    page_h_pt=st.floats(min_value=10.0, max_value=3000.0, allow_nan=False),
)
def test_px_to_point_roundtrip(px0, extra_x, py0, extra_y, render_dpi, page_h_pt):
    px1, py1 = px0 + extra_x, py0 + extra_y
    pt = _px_bbox_to_pdf_point([px0, py0, px1, py1], 1000, 1000, page_h_pt, render_dpi)
    scale = 72.0 / render_dpi
    # x quy đổi tuyến tính
    assert abs(pt[0] - px0 * scale) < 1e-6
    assert abs(pt[2] - px1 * scale) < 1e-6
    # y lật trục: y1 (top) tương ứng py0
    assert abs(pt[3] - (page_h_pt - py0 * scale)) < 1e-6
    assert abs(pt[1] - (page_h_pt - py1 * scale)) < 1e-6
    assert pt[3] >= pt[1]  # y1 >= y0
