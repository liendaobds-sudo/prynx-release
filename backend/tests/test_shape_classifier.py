"""Unit test trực tiếp cho bộ phân loại hình dạng tem (audit shape-detection #5).

Phủ NGHIỆM THU heuristic của:
  - app.workers.shape_classifier.classify_shape  (đường VECTOR — chính)
  - app.workers.shape_analyzer.detect_shape       (đường RASTER — fallback)

Khoá luôn hành vi sau fix #4: tem mũi tên (7 cạnh) → ARROW (không còn HAMMER).
"""
from __future__ import annotations

import math
from collections import namedtuple

import pytest

from app.workers.shape_classifier import classify_shape
from app.workers.shape_types import ShapeType

P = namedtuple("P", ["x", "y"])


# ─── Dựng path_items tổng hợp (định dạng của extract_vector_paths) ───────────

def lines(pts):
    """List đỉnh (đa giác đóng) → list item 'l' (đoạn thẳng)."""
    return [("l", P(*pts[i]), P(*pts[(i + 1) % len(pts)])) for i in range(len(pts))]


def circle_beziers(cx, cy, rx, ry):
    """4 cung cubic Bezier xấp xỉ tròn/elip (control point lệch nhiều → KHÔNG bị
    coi là cạnh thẳng → rơi đúng nhánh area-ratio của classifier)."""
    k = 0.5522847498307936
    return [
        ("c", P(cx + rx, cy), P(cx + rx, cy + ry * k), P(cx + rx * k, cy + ry), P(cx, cy + ry)),
        ("c", P(cx, cy + ry), P(cx - rx * k, cy + ry), P(cx - rx, cy + ry * k), P(cx - rx, cy)),
        ("c", P(cx - rx, cy), P(cx - rx, cy - ry * k), P(cx - rx * k, cy - ry), P(cx, cy - ry)),
        ("c", P(cx, cy - ry), P(cx + rx * k, cy - ry), P(cx + rx, cy - ry * k), P(cx + rx, cy)),
    ]


def rounded_rect(x0, y0, x1, y1, r):
    k = 0.5522847498307936
    return [
        ("l", P(x0 + r, y0), P(x1 - r, y0)),
        ("c", P(x1 - r, y0), P(x1 - r + r * k, y0), P(x1, y0 + r - r * k), P(x1, y0 + r)),
        ("l", P(x1, y0 + r), P(x1, y1 - r)),
        ("c", P(x1, y1 - r), P(x1, y1 - r + r * k), P(x1 - r + r * k, y1), P(x1 - r, y1)),
        ("l", P(x1 - r, y1), P(x0 + r, y1)),
        ("c", P(x0 + r, y1), P(x0 + r - r * k, y1), P(x0, y1 - r + r * k), P(x0, y1 - r)),
        ("l", P(x0, y1 - r), P(x0, y0 + r)),
        ("c", P(x0, y0 + r), P(x0, y0 + r - r * k), P(x0 + r - r * k, y0), P(x0 + r, y0)),
    ]


def reg_polygon(cx, cy, r, n, rot=0.0):
    return lines([
        (cx + r * math.cos(rot + i * 2 * math.pi / n),
         cy + r * math.sin(rot + i * 2 * math.pi / n))
        for i in range(n)
    ])


def _bar_poly(L, head, neck, two_heads):
    """Đa giác hình tạ tay (2 đầu to) hoặc búa (1 đầu to) qua biên trên/dưới."""
    n = 40
    xs = [i * L / (n - 1) for i in range(n)]

    def halfw(x):
        t = x / L
        g = lambda c: math.exp(-((t - c) ** 2) / (2 * 0.10 ** 2))
        peak = max(g(0.15), g(0.85)) if two_heads else g(0.15)
        return neck / 2 + (head - neck) / 2 * peak

    top = [(x, 100 + halfw(x)) for x in xs]
    bot = [(x, 100 - halfw(x)) for x in xs]
    return lines(top + bot[::-1])


# ─── VECTOR classify_shape ───────────────────────────────────────────────────

_VECTOR_CASES = [
    ("circle",        circle_beziers(100, 100, 50, 50),               ShapeType.CIRCLE_ELLIPSE),
    ("ellipse",       circle_beziers(100, 100, 80, 40),               ShapeType.CIRCLE_ELLIPSE),
    ("rectangle",     lines([(0, 0), (120, 0), (120, 80), (0, 80)]),  ShapeType.RECTANGLE),
    ("rounded_rect",  rounded_rect(0, 0, 120, 80, 15),                ShapeType.RECTANGLE),
    ("triangle",      lines([(0, 0), (100, 0), (50, 90)]),            ShapeType.TRIANGLE),
    ("pentagon",      reg_polygon(100, 100, 60, 5, rot=math.pi / 2),  ShapeType.PENTAGON),
    ("hexagon",       reg_polygon(100, 100, 60, 6),                   ShapeType.HEXAGON),
    ("trapezoid",     lines([(0, 0), (120, 0), (90, 70), (30, 70)]),  ShapeType.TRAPEZOID),
    ("parallelogram", lines([(0, 0), (120, 0), (150, 70), (30, 70)]), ShapeType.PARALLELOGRAM),
    ("arrow7",        lines([(0, 30), (60, 30), (60, 10), (100, 50),
                             (60, 90), (60, 70), (0, 70)]),           ShapeType.ARROW),
    ("dumbbell",      _bar_poly(200, 60, 24, two_heads=True),         ShapeType.DUMBBELL),
    ("hammer",        _bar_poly(200, 60, 24, two_heads=False),        ShapeType.HAMMER),
]


@pytest.mark.parametrize("name,items,expect", _VECTOR_CASES, ids=[c[0] for c in _VECTOR_CASES])
def test_classify_shape_vector(name, items, expect):
    got = classify_shape(items)["shape_type"]
    assert got == expect, f"{name}: expect {expect.name}, got {got.name}"


def test_arrow7_not_hammer_regression():
    """Fix #4: mũi tên 7 cạnh KHÔNG được nhận nhầm thành HAMMER (trước đây bị)."""
    arrow = lines([(0, 30), (60, 30), (60, 10), (100, 50), (60, 90), (60, 70), (0, 70)])
    got = classify_shape(arrow)["shape_type"]
    assert got is ShapeType.ARROW
    assert got is not ShapeType.HAMMER


def test_empty_items_is_custom():
    assert classify_shape([])["shape_type"] is ShapeType.CUSTOM


# ─── RASTER detect_shape (OpenCV) ────────────────────────────────────────────

def test_detect_shape_raster_basic():
    import numpy as np
    import cv2
    from app.workers.shape_analyzer import detect_shape

    # Chữ nhật đặc
    m = np.zeros((200, 300), dtype=np.uint8)
    cv2.rectangle(m, (30, 30), (270, 170), 255, -1)
    assert detect_shape(m) is ShapeType.RECTANGLE

    # Tròn đặc
    m = np.zeros((240, 240), dtype=np.uint8)
    cv2.circle(m, (120, 120), 90, 255, -1)
    assert detect_shape(m) is ShapeType.CIRCLE_ELLIPSE

    # Tam giác đặc
    m = np.zeros((220, 220), dtype=np.uint8)
    cv2.fillPoly(m, [np.array([[110, 20], [20, 200], [200, 200]], dtype=np.int32)], 255)
    assert detect_shape(m) is ShapeType.TRIANGLE
