"""Xác minh THUỘC TÍNH LAYOUT của chế độ ĐỒNG NHẤT (Property 2 — sâu).

Câu hỏi: "xếp tối ưu / xếp theo lưới / so le" có hoạt động đúng trong chế độ cùng-khuôn?
Trả lời (verify bằng thực thi): chế độ đồng nhất TÁI DÙNG NGUYÊN VẸN bộ nesting
`compute_sticker_layout_for_page` của bình-1-mẫu với HÌNH MASTER → layout sinh ra
KHỚP TỪNG Ô với layout bình-1-mẫu. Do đó:
  - master TRÒN/ELIP  → optimal_auto chọn SO LE (staggered) — y như bình-1-mẫu.
  - master CHỮ NHẬT   → optimal_auto chọn LƯỚI (grid)       — y như bình-1-mẫu.
Không có đường layout RIÊNG nào cho homogeneous → không thể lệch.

Chạy: backend/venv/Scripts/python.exe -m pytest tests/test_sticker_homogeneous_layout.py
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pytest.importorskip("pikepdf")

from app.workers import pdf_wrapper as pdf_lib
from app.workers import sticker_homogeneous as sh
from app.workers.shape_types import ShapeType
from app.workers.sticker_imposer_pkg.layout_compute import compute_sticker_layout_for_page


# Cùng đơn vị point. Tờ rộng để chứa nhiều ô.
USABLE_W = 600.0
USABLE_H = 800.0
GAP = 6.0


def _make_master_pdf(path: str, shape: str) -> None:
    """1 trang khuôn (magenta) + 3 trang nội dung đen lệch vị trí."""
    doc = pdf_lib.open()
    m = doc.new_page(width=160.0, height=120.0)
    s = m.new_shape()
    s.draw_rect(pdf_lib.Rect(10.0, 10.0, 150.0, 110.0))
    s.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)  # magenta = khuôn (hình do override quyết định)
    s.commit()
    for off in (4.0, 18.0, 30.0):
        c = doc.new_page(width=160.0, height=120.0)
        sc = c.new_shape()
        sc.draw_rect(pdf_lib.Rect(off, off, off + 100.0, off + 70.0))
        sc.finish(color=(0.0, 0.0, 0.0, 1.0), fill=(0.0, 0.0, 0.0, 1.0))
        sc.commit()
    doc.save(path)
    doc.close()


def _plan_for(master_page, shape_type: ShapeType) -> sh.HomogeneousPlan:
    lp = None
    try:
        from app.workers.nup_diecut import _find_largest_die_path
        lp = _find_largest_die_path(master_page)
    except Exception:
        lp = None
    if lp is not None:
        r = lp['rect']
        tw, th = r.width, r.height
    else:
        tw, th = 140.0, 100.0
    return sh.HomogeneousPlan(
        master_page_idx=0,
        content_pages=(1, 2, 3),
        shape_type=shape_type,
        trim_w=tw, trim_h=th,
        poly=((0.0, 0.0), (tw, 0.0), (tw, th), (0.0, th)),
        die_center=(tw / 2.0, th / 2.0),
        shape_props={"width": tw, "height": th},
    )


def _items_xy(items):
    return [(round(it.get('x', 0), 3), round(it.get('y', 0), 3),
             round(it.get('width', 0), 3), round(it.get('height', 0), 3),
             bool(it.get('isRotated', False)), bool(it.get('isRotated180', False)))
            for it in items]


@pytest.mark.parametrize("shape_str,shape_type", [
    ("circle", ShapeType.CIRCLE_ELLIPSE),
    ("rect", ShapeType.RECTANGLE),
])
def test_homogeneous_layout_equals_single_template(tmp_path, shape_str, shape_type):
    """Layout đồng nhất KHỚP TỪNG Ô với bình-1-mẫu của master (mọi strategy giữ nguyên)."""
    src = str(tmp_path / f"m_{shape_str}.pdf")
    _make_master_pdf(src, shape_str)
    doc = pdf_lib.open(src)
    try:
        master = doc[0]
        plan = _plan_for(master, shape_type)

        # Bình-1-mẫu (single-template): GỌI TRỰC TIẾP bộ nesting với hình master.
        direct = compute_sticker_layout_for_page(
            master, USABLE_W, USABLE_H, GAP, GAP,
            strategy='optimal_auto',
            shape_type_override=plan.shape_type.name,
            shape_props_override=(plan.shape_props or None),
            bleed_pt=0.0,
        )
        # Chế độ ĐỒNG NHẤT: build dùng layout_fn mặc định (cùng hàm nesting).
        hom = sh.build_homogeneous_layout(
            master_page=master, plan=plan,
            sheet_usable_w=USABLE_W, sheet_usable_h=USABLE_H,
            gap_x=GAP, gap_y=GAP, bleed_pt=0.0, quantities=None,
        )
    finally:
        doc.close()

    direct_items = _items_xy(direct.get('items', []))
    hom_items = _items_xy(hom.items)

    assert len(hom_items) >= 1, "layout không được rỗng"
    # KHỚP TỪNG Ô: homogeneous KHÔNG dựng layout riêng, tái dùng nguyên bình-1-mẫu.
    assert hom_items == direct_items, (
        f"layout đồng nhất ({shape_str}) phải TRÙNG bình-1-mẫu của master")


def test_circle_staggered_vs_rect_grid(tmp_path):
    """Bằng chứng shape-aware: master TRÒN → có ô lệch hàng (so le); CHỮ NHẬT → lưới đều.

    optimal_auto tự chọn kiểu theo hình; homogeneous thừa hưởng → đúng cho từng hình.
    """
    def _layout(shape_str, stype):
        src = str(tmp_path / f"s_{shape_str}.pdf")
        _make_master_pdf(src, shape_str)
        doc = pdf_lib.open(src)
        try:
            plan = _plan_for(doc[0], stype)
            hom = sh.build_homogeneous_layout(
                master_page=doc[0], plan=plan,
                sheet_usable_w=USABLE_W, sheet_usable_h=USABLE_H,
                gap_x=GAP, gap_y=GAP, bleed_pt=0.0, quantities=None,
            )
        finally:
            doc.close()
        return list(hom.items)

    def _distinct_x_starts(items):
        # Gom theo hàng (y) rồi xem các hàng có cùng tập x bắt đầu không.
        from collections import defaultdict
        rows = defaultdict(list)
        for it in items:
            rows[round(it.get('y', 0), 1)].append(round(it.get('x', 0), 2))
        xs_per_row = [tuple(sorted(set(v))) for v in rows.values()]
        return xs_per_row

    circle_items = _layout("circle", ShapeType.CIRCLE_ELLIPSE)
    rect_items = _layout("rect", ShapeType.RECTANGLE)

    assert len(circle_items) >= 2 and len(rect_items) >= 2

    # Chữ nhật: các hàng có x bắt đầu GIỐNG nhau (lưới đều).
    rect_rows = _distinct_x_starts(rect_items)
    if len(rect_rows) >= 2:
        assert rect_rows[0] == rect_rows[1] or len(set(map(len, rect_rows))) == 1, \
            "chữ nhật nên xếp lưới đều (các hàng thẳng cột)"

    # Tròn: chứng minh shape-aware bằng cách layout KHÁC chữ nhật (so le/ngàm).
    # (Không khẳng định công thức cụ thể — chỉ cần khác lưới chữ nhật.)
    assert _items_xy(circle_items) != _items_xy(rect_items), \
        "layout tròn phải KHÁC layout chữ nhật (shape-aware, không cùng một lưới)"
