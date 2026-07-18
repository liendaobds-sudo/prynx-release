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
    ("octagon_reg",   reg_polygon(100, 100, 60, 8),                   ShapeType.CIRCLE_ELLIPSE),
    ("chamfered_rect", lines([(15, 0), (105, 0), (120, 15), (120, 65),
                              (105, 80), (15, 80), (0, 65), (0, 15)]), ShapeType.RECTANGLE),
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


def test_convex_heptagon_not_arrow():
    """Audit hình học: đa giác 7 cạnh LỒI (heptagon đều) KHÔNG được gán nhầm ARROW
    (mũi tên thật có đỉnh lõm/ngạnh). Trước đây mọi 7-cạnh → ARROW vô điều kiện."""
    hept = lines([(100 * math.cos(2 * math.pi * i / 7), 100 * math.sin(2 * math.pi * i / 7))
                  for i in range(7)])
    got = classify_shape(hept)["shape_type"]
    assert got is not ShapeType.ARROW


def test_irregular_octagon_not_circle():
    """Regression: 8 cạnh LỆCH không được ép CIRCLE_ELLIPSE (trước: mọi 8-cạnh → tròn)."""
    irreg = lines([
        (0, 20), (40, 0), (90, 5), (120, 30),
        (115, 70), (80, 100), (30, 95), (5, 60),
    ])
    got = classify_shape(irreg)["shape_type"]
    assert got is not ShapeType.CIRCLE_ELLIPSE, f"8-cạnh lệch bị nhận {got.name}"


def test_regular_octagon_still_circle():
    """Bát giác đều vẫn map CIRCLE_ELLIPSE (layout nest tròn) sau siết cổng."""
    oct_ = reg_polygon(100, 100, 60, 8)
    got = classify_shape(oct_)["shape_type"]
    assert got is ShapeType.CIRCLE_ELLIPSE


# ─── Regression búa/tạ: HÌNH ĐẶC BIỆT không được nhận nhầm thành búa/tạ ──────
# (audit búa/tạ — cổng "đầu gọn ở mút" _MAX_HEAD_EXTENT_FRAC). Đo thực nghiệm: các
# hình này có big_d_along_axis_frac 0.69–0.77 (khối phình trải dài, KHÔNG phải đầu+cán).

def _pts_circle(cx, cy, r, n=120, ysquash=1.0):
    return [(cx + r * math.cos(2 * math.pi * i / n),
             cy + r * math.sin(2 * math.pi * i / n) * ysquash) for i in range(n)]


def _plus_poly():
    c, arm, half = 100, 30, 80
    return lines([
        (c - arm, c - half), (c + arm, c - half), (c + arm, c - arm), (c + half, c - arm),
        (c + half, c + arm), (c + arm, c + arm), (c + arm, c + half), (c - arm, c + half),
        (c - arm, c + arm), (c - half, c + arm), (c - half, c - arm), (c - arm, c - arm),
    ])


def _pear_bulb_poly():
    pts = []
    for i in range(120):
        t = 2 * math.pi * i / 120
        base = 60 if math.sin(t) < 0 else 30  # to ở dưới, nhỏ ở trên → cổ thắt
        pts.append((100 + base * math.cos(t), 100 + base * math.sin(t) * 1.3))
    return lines(pts)


def _crescent_poly():
    outer = _pts_circle(100, 100, 80, 120)
    inner = list(reversed(_pts_circle(132, 100, 62, 120)))
    return lines(outer + inner)


_SPECIAL_NOT_HAMMER = [
    ("plus_cross", _plus_poly()),
    ("pear_bulb", _pear_bulb_poly()),
    ("crescent", _crescent_poly()),
]


@pytest.mark.parametrize("name,items", _SPECIAL_NOT_HAMMER, ids=[c[0] for c in _SPECIAL_NOT_HAMMER])
def test_special_shapes_not_hammer_dumbbell(name, items):
    """Hình đặc biệt (khối phình trải dài) KHÔNG được nhận thành búa/tạ — phải CUSTOM/khác."""
    got = classify_shape(items)["shape_type"]
    assert got not in (ShapeType.HAMMER, ShapeType.DUMBBELL), (
        f"{name}: bị nhận nhầm thành {got.name} (đáng lẽ KHÔNG phải búa/tạ)")


def test_true_hammer_dumbbell_still_detected():
    """Đối chứng: búa/tạ THẬT (đầu gọn ở mút) vẫn được nhận đúng sau khi thêm cổng."""
    assert classify_shape(_bar_poly(200, 60, 24, two_heads=False))["shape_type"] is ShapeType.HAMMER
    assert classify_shape(_bar_poly(200, 60, 24, two_heads=True))["shape_type"] is ShapeType.DUMBBELL


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


# ─── Hồi quy: chống nhận nhầm blob bo tròn (sao bù-xén) thành Tròn/Elip ──────
# Nhánh 0-cạnh-thẳng (đường cong trơn) trước đây chỉ dựa tỉ lệ diện tích ~π/4 →
# blob ngôi sao bù-xén (lọt dải) bị gọi CIRCLE_ELLIPSE. Thêm cổng elip-fit (PCA).
from app.workers.shape_classifier import _classify_polygon_core, _ellipse_fit_residual


def _curve_samples(modulate, n=400, lobes=5, amp=0.0, bulge=0.0, rx=100.0, ry=100.0,
                   rot_deg=0.0):
    ca, sa = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        r = 1.0 + (amp * math.cos(lobes * t) if modulate else 0.0)
        r += bulge * max(0.0, -math.sin(t)) ** 2  # bướu dưới (mô phỏng vùng chữ)
        x0, y0 = rx * r * math.cos(t), ry * r * math.sin(t)
        pts.append((x0 * ca - y0 * sa, x0 * sa + y0 * ca))
    return pts


def _classify_curve(samples):
    xs = [p[0] for p in samples]; ys = [p[1] for p in samples]
    mnx, mxx, mny, mxy = min(xs), max(xs), min(ys), max(ys)
    return _classify_polygon_core([], samples, mnx, mxx, mny, mxy, mxx - mnx, mxy - mny)


@pytest.mark.parametrize("rx,ry,rot", [
    (100, 100, 0),    # tròn
    (150, 70, 0),     # elip dẹt
    (110, 100, 30),   # elip xoay 30°
    (130, 90, 45),    # elip dẹt xoay 45°
    (180, 60, 45),    # elip RẤT dẹt (3:1) xoay 45° — trước đây rớt khỏi dải tỉ lệ → CUSTOM
    (160, 80, 30),    # elip 2:1 xoay 30°
])
def test_true_ellipse_still_circle_ellipse(rx, ry, rot):
    """Elip/tròn thật (kể cả XOAY/DẸT) vẫn phải nhận CIRCLE_ELLIPSE — fit residual ~0.
    Bao gồm elip xoay-dẹt mà tiêu chí cũ (dải tỉ lệ diện tích) BỎ SÓT."""
    samples = _curve_samples(False, rx=rx, ry=ry, rot_deg=rot)
    assert _ellipse_fit_residual(samples) < 0.02
    st, _ = _classify_curve(samples)
    assert st == ShapeType.CIRCLE_ELLIPSE


@pytest.mark.parametrize("amp,bulge", [
    (0.05, 0.0), (0.07, 0.0), (0.10, 0.0),
    (0.07, 0.12), (0.05, 0.10),  # sao + bướu = contour bù-xén ngôi sao + chữ
])
def test_rounded_star_blob_not_ellipse(amp, bulge):
    """Blob ngôi sao bo tròn (đường bế bù-xén) KHÔNG được nhận là Tròn/Elip."""
    samples = _curve_samples(True, lobes=5, amp=amp, bulge=bulge, rx=100, ry=100)
    assert _ellipse_fit_residual(samples) >= 0.02
    st, _ = _classify_curve(samples)
    assert st != ShapeType.CIRCLE_ELLIPSE  # → None (CUSTOM qua fallback)


# ─── Hồi quy: tam giác bo tròn (contour bù-xén) KHÔNG được nhận nhầm thành búa ──
# Contour bo tròn 0 cạnh thẳng → rơi xuống width-profile; trước đây profile "thuôn
# về điểm" (đỉnh tam giác) bị đọc là "cán mảnh + 1 đầu to" = HAMMER. Cổng
# _MIN_TIP_WIDTH_FRAC chặn: hình thu về mũi nhọn (min/max rất nhỏ) → None (CUSTOM).
from app.workers.shape_classifier import _analyze_width_profile


def _tri_bulge_samples(text_w_frac=0.78, Htext=90.0, neck=0.04, W=200.0, Htri=240.0, n=600):
    Htot = Htri + Htext
    pts = []
    steps = n // 4
    for i in range(steps + 1):
        t = i / steps
        pts.append(((W / 2.0) * t, t * Htri))
    tw = W * text_w_frac
    for i in range(1, steps + 1):
        t = i / steps
        x = (W / 2.0) * (1 - t) + (tw / 2.0) * t
        x -= neck * W * math.sin(math.pi * min(t * 3, 1))
        pts.append((x, Htri + t * Htext))
    for i in range(1, steps + 1):
        t = i / steps
        pts.append((tw / 2.0 - tw * t, Htot))
    for i in range(1, steps + 1):
        t = i / steps
        x = -((tw / 2.0) * (1 - t) + (W / 2.0) * t)
        x += neck * W * math.sin(math.pi * min((1 - t) * 3, 1))
        pts.append((x, Htot - t * Htext))
    for i in range(1, steps):
        t = i / steps
        pts.append((-(W / 2.0) * (1 - t), Htri * (1 - t)))
    return pts


def _wp(samples):
    xs = [p[0] for p in samples]; ys = [p[1] for p in samples]
    mnx, mxx, mny, mxy = min(xs), max(xs), min(ys), max(ys)
    return _analyze_width_profile(samples, mnx, mxx, mny, mxy, mxx - mnx, mxy - mny, edges=[])


@pytest.mark.parametrize("text_w,Htext", [(0.78, 90.0), (0.65, 90.0), (0.0, 1.0)])
def test_rounded_triangle_not_hammer(text_w, Htext):
    """Tam giác bo tròn (± băng chữ) → width-profile KHÔNG ra búa/tạ (None → CUSTOM)."""
    wp = _wp(_tri_bulge_samples(text_w_frac=text_w, Htext=Htext))
    assert wp is None or wp.get('shapeType') not in ('hammer', 'dumbbell')


def test_real_hammer_dumbbell_still_detected_after_tip_gate():
    """Cổng mũi-nhọn KHÔNG được phá búa/tạ thật (cán bề rộng hữu hạn)."""
    assert classify_shape(_bar_poly(200, 60, 24, two_heads=False))["shape_type"] is ShapeType.HAMMER
    assert classify_shape(_bar_poly(200, 60, 24, two_heads=True))["shape_type"] is ShapeType.DUMBBELL
