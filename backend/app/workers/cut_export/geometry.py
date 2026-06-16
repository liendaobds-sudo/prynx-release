"""
geometry.py — Tiện ích hình học cho cut_export: làm phẳng Bezier + nén RDP.

Port từ logic đã chạy thật trong script JSX (flattenCubicBezier + rdpAlgorithm),
viết lại thuần Python trong module (KHÔNG copy mã GPL, KHÔNG sửa file có sẵn).

Đơn vị: mm. Mặc định:
- Làm phẳng Bezier: sai số đoạn ≤ FLATTEN_TOL_MM (0.2mm) — Requirement 1.2.
- Nén RDP: epsilon ~ RDP_EPS_MM (0.03mm) — loại điểm thừa, giữ hình.
"""

from __future__ import annotations

import math
from typing import Sequence

Point = tuple[float, float]

FLATTEN_TOL_MM = 0.2
RDP_EPS_MM = 0.03


def _dist(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def flatten_cubic_bezier(
    p0: Point,
    p1: Point,
    p2: Point,
    p3: Point,
    max_seg_mm: float = FLATTEN_TOL_MM,
) -> list[Point]:
    """Xấp xỉ Bezier bậc 3 thành polyline.

    Số đoạn thích ứng theo độ dài cung (xấp xỉ bằng tổng đa giác điều khiển),
    sao cho mỗi đoạn ~ max_seg_mm. Sau đó nén RDP để bỏ điểm thừa.
    Trả danh sách điểm GỒM cả p0 và p3.
    """
    if max_seg_mm <= 0:
        raise ValueError("max_seg_mm phải > 0")

    approx_len = _dist(p0, p1) + _dist(p1, p2) + _dist(p2, p3)
    steps = max(4, int(math.ceil(approx_len / max_seg_mm)))
    steps = min(steps, 2000)  # chặn an toàn

    raw: list[Point] = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1.0 - t
        mt2 = mt * mt
        t2 = t * t
        x = mt2 * mt * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t2 * t * p3[0]
        y = mt2 * mt * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t2 * t * p3[1]
        raw.append((x, y))

    return rdp_simplify(raw, RDP_EPS_MM)


def rdp_simplify(points: Sequence[Point], epsilon: float = RDP_EPS_MM) -> list[Point]:
    """Ramer–Douglas–Peucker: nén polyline, giữ hình trong sai số epsilon (mm).

    Lặp (không đệ quy) để an toàn với polyline rất dài.
    """
    pts = [(float(p[0]), float(p[1])) for p in points]
    n = len(pts)
    if n < 3:
        return pts

    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack: list[tuple[int, int]] = [(0, n - 1)]

    while stack:
        start, end = stack.pop()
        max_dist = 0.0
        index = -1
        for i in range(start + 1, end):
            d = _perp_distance(pts[i], pts[start], pts[end])
            if d > max_dist:
                max_dist = d
                index = i
        if index != -1 and max_dist > epsilon:
            keep[index] = True
            stack.append((start, index))
            stack.append((index, end))

    return [pts[i] for i in range(n) if keep[i]]


def _perp_distance(p: Point, a: Point, b: Point) -> float:
    """Khoảng cách vuông góc từ p tới đoạn (a, b)."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    len2 = dx * dx + dy * dy
    if len2 == 0.0:
        return _dist(p, a)
    # |cross| / |b-a|
    cross = abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy)
    return cross / math.sqrt(len2)


def max_segment_length(points: Sequence[Point]) -> float:
    """Độ dài đoạn dài nhất trong polyline (mm). Dùng để kiểm thử sai số."""
    if len(points) < 2:
        return 0.0
    return max(_dist(points[i], points[i + 1]) for i in range(len(points) - 1))
