"""Regression: tem MŨI TÊN bất đối xứng KHÔNG được xếp đè (audit mũi tên — hướng A).

Trước fix: ARROW dùng solver Ngũ giác + 'pentagon_advanced' ∈ SKIP_COLLISION_STRATEGIES
→ khử đè bị bỏ qua → mũi tên bất đối xứng đè nhau (đo thật tới ~4% diện tích tem).
Fix: đổi nhãn chiến lược ARROW → 'arrow_advanced' (KHÔNG skip) → wrapper chạy
resolve_layout_collisions với đa giác mũi tên THẬT (base_poly) → khử đè.

Chạy: backend/venv/Scripts/python.exe -m pytest tests/test_arrow_layout_overlap.py
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pytest.importorskip("shapely")
from shapely.geometry import Polygon
from shapely import affinity

from app.workers.shape_classifier import classify_shape
from app.workers.shape_types import ShapeType
from app.workers.sticker_imposer_pkg.orchestrator import solve_optimal_sticker_layout


def _arrow_poly(w=100.0, h=120.0, head_frac=0.45, shaft_frac=0.5, asym=0.0):
    """Mũi tên hướng lên; asym = lệch trục dọc (bất đối xứng trái/phải)."""
    cx = w / 2.0
    head_h = h * head_frac
    sw = w * shaft_frac
    sx0 = cx - sw / 2.0 + asym
    sx1 = cx + sw / 2.0 + asym
    tipx = cx + asym
    p = Polygon([(tipx, 0), (w, head_h), (sx1, head_h), (sx1, h),
                 (sx0, h), (sx0, head_h), (0, head_h)])
    b = p.bounds
    return affinity.translate(p, -b[0], -b[1])


def _items_path(poly):
    from collections import namedtuple
    P = namedtuple("P", ["x", "y"])
    pts = list(poly.exterior.coords)[:-1]
    return [("l", P(*pts[i]), P(*pts[(i + 1) % len(pts)])) for i in range(len(pts))]


def _place(base, it):
    p = base
    if it.get('isRotated'):
        p = affinity.rotate(p, -90, origin=(0, 0))
        b = p.bounds
        p = affinity.translate(p, -b[0], -b[1])
    if it.get('isRotated180'):
        b = p.bounds
        p = affinity.rotate(p, 180, origin=((b[0] + b[2]) / 2, (b[1] + b[3]) / 2))
    return affinity.translate(p, it['x'], it['y'])


def _layout_and_overlap(base):
    b = base.bounds
    w0, h0 = b[2] - b[0], b[3] - b[1]
    cls = classify_shape(_items_path(base))
    assert cls['shape_type'] is ShapeType.ARROW, f"phải là ARROW, got {cls['shape_type'].name}"
    layout = solve_optimal_sticker_layout(
        500.0, 500.0, w0, h0, 5.0, 5.0, 'optimal_auto',
        None, None, None, None, None, None,
        'ARROW', cls['params'], base,  # base_poly = đa giác mũi tên thật
    )
    items = layout.get('items', [])
    polys = [_place(base, it) for it in items]
    max_ov = 0.0
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            if polys[i].is_valid and polys[j].is_valid:
                max_ov = max(max_ov, polys[i].intersection(polys[j]).area)
    return layout, items, max_ov, (w0, h0)


def _grid_count(w0, h0):
    """Số ô của LƯỚI phẳng (cận dưới năng suất mà hướng B phải đạt)."""
    from app.workers.sticker_imposer_pkg.grid_layouts import solve_grid_layout
    g1 = solve_grid_layout(500.0, 500.0, w0, h0, 5.0, 5.0)
    g2 = solve_grid_layout(500.0, 500.0, h0, w0, 5.0, 5.0)
    return max(g1.get('totalItems', 0), g2.get('totalItems', 0))


@pytest.mark.parametrize("name,kw", [
    ("symmetric", dict(asym=0.0)),
    ("asym_20", dict(asym=20.0)),
    ("asym_30", dict(asym=30.0)),
    ("asym30_wide", dict(asym=30.0, head_frac=0.6, shaft_frac=0.35)),
    ("asym25_deep", dict(asym=25.0, head_frac=0.55, shaft_frac=0.3)),
])
def test_arrow_no_overlap(name, kw):
    base = _arrow_poly(**kw)
    layout, items, max_ov, (w0, h0) = _layout_and_overlap(base)
    # Diện tích đè ~ 0 (cho phép nhiễu biên rất nhỏ).
    assert max_ov <= 0.5, f"{name}: vẫn còn đè {max_ov:.1f}pt² (mũi tên bất đối xứng phải KHÔNG đè)"
    # Hướng B: năng suất KHÔNG thấp hơn lưới phẳng (mũi tên bất đối xứng không bị
    # 'bỏ ô' xuống dưới mức lưới — lưới luôn là 1 ứng viên).
    grid_n = _grid_count(w0, h0)
    assert len(items) >= grid_n, (
        f"{name}: năng suất {len(items)} < lưới {grid_n} — hướng B phải ≥ lưới")


def test_symmetric_arrow_keeps_items():
    """Mũi tên ĐỐI XỨNG không đè → KHÔNG bị loại ô (fix không phạt ca đang đúng)."""
    base = _arrow_poly(asym=0.0)
    _, items, max_ov, _ = _layout_and_overlap(base)
    assert max_ov <= 0.5
    assert len(items) >= 12, f"mũi tên đối xứng nên giữ nhiều ô (got {len(items)})"
