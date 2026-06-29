"""Parity test PREVIEW == OUTPUT cho chế độ ĐỒNG NHẤT (sticker-homogeneous-nup, Task 7.2).

Feature: sticker-homogeneous-nup
Property 6: Parity preview == output (gồm ca có boong).
Validates: Requirements 7.2, 7.3.

Ý tưởng (theo tasks.md 7.2): KHÔNG cần PDF thật. Cả hai đường (preview & output)
xếp tem ĐỒNG NHẤT bằng CÙNG pipeline thuần:

    build_homogeneous_layout(layout_fn=<nesting master tính 1 lần>)
        → finalize_placements(items, usable_w/h, margins, master_idx)   [SSOT căn giữa]
        → gán src_page_idx theo cell_contents (tờ 0)
        → resolve_pont_collisions_on_placements(pls, req-like, base_poly) [SSOT boong]

Khác biệt DUY NHẤT giữa 2 đường là KIỂU đối tượng "req":
  - OUTPUT  (nup_engine): một _ReqLike thuần (pont_config/sheet_w/sheet_h/margin_*).
  - PREVIEW (/preview-layout): tái dùng TRỰC TIẾP request schema (cùng các field đó).

Test dựng placements TỜ 0 bằng cả 2 đường rồi assert danh sách
(absX, absY, width, height, isRotated, isRotated180, src_page_idx) KHỚP nhau trong
dung sai ≤ 0.1mm (≈0.283pt) và cờ xoay (góc) trùng khít.

Chạy: backend/venv/Scripts/python.exe -m pytest tests/test_sticker_homogeneous_parity.py
"""
from __future__ import annotations

import os
import sys

from hypothesis import HealthCheck, given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.workers.shape_types import ShapeType
from app.workers import sticker_homogeneous as sh
from app.workers.imposition_finalize import (
    finalize_placements,
    resolve_pont_collisions_on_placements,
)

# Dung sai parity (spec): ≤ 0.1mm. 1mm = 2.83465pt.
MM_TO_PT = 2.83465
TOL_PT = 0.1 * MM_TO_PT  # ≈ 0.283pt


# ─── Fakes ───────────────────────────────────────────────────────────────────

class _FakeTrim:
    def __init__(self, w: float, h: float):
        self.w = w
        self.h = h


class _FakeShape:
    """Trang nhận diện giả: có khuôn ⇔ type ≠ CUSTOM (như adapter engine dựng)."""

    def __init__(self, has_die: bool, w: float, h: float, shape: ShapeType):
        self.type = shape if has_die else ShapeType.CUSTOM
        self.trim = _FakeTrim(w, h)
        self.poly = ((0.0, 0.0), (w, 0.0), (w, h), (0.0, h)) if has_die else ()
        self.props = {}


class _ReqLike:
    """req tối thiểu cho resolve_pont_collisions_on_placements (mô phỏng nup_engine)."""

    def __init__(self, pont_config, sheet_w, sheet_h, margin_left, margin_bottom):
        self.pont_config = pont_config
        self.sheet_w = sheet_w
        self.sheet_h = sheet_h
        self.margin_left = margin_left
        self.margin_bottom = margin_bottom


def _canned_master_layout(trim_w: float, trim_h: float, gap: float, cols: int, rows: int):
    """Nesting 'so le' giả lập (head-to-tail) cho master — dùng làm layout_fn cho cả 2 đường.

    Trả dict đúng format compute_sticker_layout_for_page (items + meta). Tính MỘT LẦN
    rồi cùng tiêm vào build_homogeneous_layout ở cả preview lẫn output → "nesting 1 lần".
    """
    items = []
    for r in range(rows):
        for c in range(cols):
            x = c * (trim_w + gap) + (trim_w / 2.0 if r % 2 else 0.0)
            y = r * (trim_h + gap)
            items.append({
                "x": x, "y": y, "width": trim_w, "height": trim_h,
                "isRotated": bool((r + c) % 2), "isRotated180": False,
            })
    return {
        "items": items,
        "shapeType": "CIRCLE_ELLIPSE",
        "shapeProps": {"width": trim_w, "height": trim_h},
        "trimW": trim_w,
        "trimH": trim_h,
        "strategyUsed": "canned",
    }


def _master_base_poly(plan):
    """base_poly master GIỐNG output: ellipse chuẩn cho CIRCLE_ELLIPSE, None cho khác."""
    if plan.shape_type != ShapeType.CIRCLE_ELLIPSE:
        return None
    try:
        from shapely.geometry import Point
        from shapely.affinity import scale
        rx = plan.trim_w / 2.0
        ry = plan.trim_h / 2.0
        if rx > 0 and ry > 0:
            return scale(Point(0, 0).buffer(1.0, resolution=64), xfact=rx, yfact=ry)
    except Exception:
        return None
    return None


def _build_sheet0(plan, master_layout, *, usable_w, usable_h, gap_x, gap_y,
                  margin_left, margin_bottom, margin_top, req_obj):
    """Dựng placements TỜ 0 — CÙNG pipeline cho cả preview lẫn output.

    `req_obj` là đối tượng req (preview: schema; output: _ReqLike). Mọi bước khác y hệt.
    """
    hom_layout = sh.build_homogeneous_layout(
        master_page=None,
        plan=plan,
        sheet_usable_w=usable_w,
        sheet_usable_h=usable_h,
        gap_x=gap_x,
        gap_y=gap_y,
        bleed_pt=0.0,
        secondary_gap=None,
        quantities=None,  # auto-fill
        layout_fn=(lambda *_a, **_k: master_layout),
    )
    base_poly = _master_base_poly(plan)
    items = list(hom_layout.items)
    pls = finalize_placements(
        items, usable_w, usable_h, margin_left, margin_bottom, margin_top,
        plan.master_page_idx,
    )
    by_cell = {cc.cell_index: cc.src_page_idx
               for cc in hom_layout.cell_contents if cc.sheet_index == 0}
    sheet_pls = []
    for ci, pl in enumerate(pls):
        if ci in by_cell:
            pl['src_page_idx'] = by_cell[ci]
            sheet_pls.append(pl)
    sheet_pls = resolve_pont_collisions_on_placements(sheet_pls, req_obj, base_poly=base_poly)
    return sheet_pls


def _signature(placements):
    """(absX, absY, w, h, isRotated, isRotated180, src_page_idx) cho từng ô — để so khớp."""
    out = []
    for pl in placements:
        c = pl['cell']
        out.append((
            round(pl['abs_x'], 6), round(pl['abs_y'], 6),
            round(pl['width'], 6), round(pl['height'], 6),
            bool(c.get('isRotated', False)), bool(c.get('isRotated180', False)),
            int(pl['src_page_idx']),
        ))
    return out


def _assert_parity(preview_pls, output_pls):
    assert len(preview_pls) == len(output_pls), (
        f"số ô preview ({len(preview_pls)}) ≠ output ({len(output_pls)})")
    ps = _signature(preview_pls)
    os_ = _signature(output_pls)
    for i, (p, o) in enumerate(zip(ps, os_)):
        # toạ độ/kích thước ≤ 0.1mm
        for k, (pv, ov) in enumerate(zip(p[:4], o[:4])):
            assert abs(pv - ov) <= TOL_PT, (
                f"ô {i} field {k}: preview={pv} output={ov} (Δ={abs(pv-ov):.4f}pt > {TOL_PT:.4f})")
        # cờ xoay (góc) trùng khít + cùng src_page_idx mapping
        assert p[4] == o[4], f"ô {i} isRotated khác: {p[4]} vs {o[4]}"
        assert p[5] == o[5], f"ô {i} isRotated180 khác: {p[5]} vs {o[5]}"
        assert p[6] == o[6], f"ô {i} src_page_idx khác: {p[6]} vs {o[6]}"


def _make_plan(trim_w, trim_h, n_content):
    """Plan: trang 0 = master (CIRCLE_ELLIPSE có khuôn), trang 1..n_content = nội dung."""
    shapes = [_FakeShape(True, trim_w, trim_h, ShapeType.CIRCLE_ELLIPSE)]
    shapes += [_FakeShape(False, trim_w, trim_h, ShapeType.CIRCLE_ELLIPSE)
               for _ in range(n_content)]
    plan = sh.detect_homogeneous(shapes)
    assert plan is not None and plan.master_page_idx == 0
    return plan


# ─── Property 6: Parity preview == output (không boong) ──────────────────────

@settings(max_examples=120, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
@given(
    trim_w=st.floats(min_value=40.0, max_value=160.0),
    trim_h=st.floats(min_value=40.0, max_value=160.0),
    gap=st.floats(min_value=0.0, max_value=20.0),
    cols=st.integers(min_value=1, max_value=4),
    rows=st.integers(min_value=1, max_value=4),
    margin_left=st.floats(min_value=0.0, max_value=40.0),
    margin_bottom=st.floats(min_value=0.0, max_value=40.0),
    margin_top=st.floats(min_value=0.0, max_value=40.0),
    n_content=st.integers(min_value=1, max_value=10),
)
def test_p6_parity_no_pont(trim_w, trim_h, gap, cols, rows,
                           margin_left, margin_bottom, margin_top, n_content):
    """Preview-tờ0 == Output-tờ0 khi KHÔNG có boong (≤ 0.1mm, cờ xoay khít)."""
    usable_w = 600.0
    usable_h = 800.0
    plan = _make_plan(trim_w, trim_h, n_content)
    master_layout = _canned_master_layout(trim_w, trim_h, gap, cols, rows)

    common = dict(usable_w=usable_w, usable_h=usable_h, gap_x=gap, gap_y=gap,
                  margin_left=margin_left, margin_bottom=margin_bottom,
                  margin_top=margin_top)

    # OUTPUT: _ReqLike thuần (pont None → resolve trả nguyên placements).
    out_req = _ReqLike(None, 0, 0, margin_left, margin_bottom)
    output_pls = _build_sheet0(plan, master_layout, req_obj=out_req, **common)

    # PREVIEW: schema request (cùng các field). pont_config None.
    from app.api.routes.imposition import PreviewLayoutRequest
    prev_req = PreviewLayoutRequest(
        usable_w=usable_w, usable_h=usable_h, item_w=trim_w, item_h=trim_h,
        gap_x=gap, gap_y=gap, strategy='optimal_auto',
        pont_config=None, sheet_w=0, sheet_h=0,
        margin_left=margin_left, margin_bottom=margin_bottom, margin_top=margin_top,
    )
    preview_pls = _build_sheet0(plan, master_layout, req_obj=prev_req, **common)

    _assert_parity(preview_pls, output_pls)


# ─── Property 6 (boong): resolve_pont_collisions chạy CÙNG ở 2 đường ─────────

@settings(max_examples=60, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
@given(
    trim_w=st.floats(min_value=60.0, max_value=140.0),
    trim_h=st.floats(min_value=60.0, max_value=140.0),
    gap=st.floats(min_value=0.0, max_value=12.0),
    mark_mm=st.floats(min_value=8.0, max_value=40.0),
    n_content=st.integers(min_value=2, max_value=8),
)
def test_p6_parity_with_pont(trim_w, trim_h, gap, mark_mm, n_content):
    """Preview-tờ0 == Output-tờ0 KHI CÓ boong → đảm bảo resolver chạy cùng tham số."""
    usable_w = 500.0
    usable_h = 650.0
    sheet_w = usable_w + 60.0
    sheet_h = usable_h + 60.0
    margin_left = 20.0
    margin_bottom = 20.0
    margin_top = 20.0
    cols, rows = 3, 3

    plan = _make_plan(trim_w, trim_h, n_content)
    master_layout = _canned_master_layout(trim_w, trim_h, gap, cols, rows)

    pont_config = {
        'shape': 'circle',
        'size': mark_mm,
        'disableCollision': False,
    }

    common = dict(usable_w=usable_w, usable_h=usable_h, gap_x=gap, gap_y=gap,
                  margin_left=margin_left, margin_bottom=margin_bottom,
                  margin_top=margin_top)

    out_req = _ReqLike(pont_config, sheet_w, sheet_h, margin_left, margin_bottom)
    output_pls = _build_sheet0(plan, master_layout, req_obj=out_req, **common)

    from app.api.routes.imposition import PreviewLayoutRequest
    prev_req = PreviewLayoutRequest(
        usable_w=usable_w, usable_h=usable_h, item_w=trim_w, item_h=trim_h,
        gap_x=gap, gap_y=gap, strategy='optimal_auto',
        pont_config=pont_config, sheet_w=sheet_w, sheet_h=sheet_h,
        margin_left=margin_left, margin_bottom=margin_bottom, margin_top=margin_top,
    )
    preview_pls = _build_sheet0(plan, master_layout, req_obj=prev_req, **common)

    _assert_parity(preview_pls, output_pls)


# ─── Ca cụ thể (không random) — boong chắc chắn kích hoạt resolver ───────────

def test_p6_parity_boong_triggers_resolver():
    """Boong lớn ở góc chồng lấn ô → resolver THỰC SỰ chạy; 2 đường vẫn khớp tuyệt đối."""
    usable_w = 300.0
    usable_h = 300.0
    sheet_w = 360.0
    sheet_h = 360.0
    margin_left = margin_bottom = margin_top = 30.0
    trim_w = trim_h = 80.0
    gap = 5.0
    cols, rows = 2, 2

    plan = _make_plan(trim_w, trim_h, 4)
    master_layout = _canned_master_layout(trim_w, trim_h, gap, cols, rows)
    pont_config = {'shape': 'circle', 'size': 50.0, 'disableCollision': False}

    common = dict(usable_w=usable_w, usable_h=usable_h, gap_x=gap, gap_y=gap,
                  margin_left=margin_left, margin_bottom=margin_bottom,
                  margin_top=margin_top)

    out_req = _ReqLike(pont_config, sheet_w, sheet_h, margin_left, margin_bottom)
    output_pls = _build_sheet0(plan, master_layout, req_obj=out_req, **common)

    from app.api.routes.imposition import PreviewLayoutRequest
    prev_req = PreviewLayoutRequest(
        usable_w=usable_w, usable_h=usable_h, item_w=trim_w, item_h=trim_h,
        gap_x=gap, gap_y=gap, strategy='optimal_auto',
        pont_config=pont_config, sheet_w=sheet_w, sheet_h=sheet_h,
        margin_left=margin_left, margin_bottom=margin_bottom, margin_top=margin_top,
    )
    preview_pls = _build_sheet0(plan, master_layout, req_obj=prev_req, **common)

    assert len(output_pls) >= 1
    _assert_parity(preview_pls, output_pls)
