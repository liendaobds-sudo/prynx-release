"""
geometry.py — Tiện ích hình học cho cut_export: làm phẳng Bezier + nén RDP.

Port từ logic đã chạy thật trong script JSX (flattenCubicBezier + rdpAlgorithm),
viết lại thuần Python trong module (KHÔNG copy mã GPL, KHÔNG sửa file có sẵn).

Đơn vị: mm. Mặc định:
- Làm phẳng Bezier: sai số quỹ đạo ≤ FLATTEN_TOL_MM (0.02mm).
- Nén RDP: epsilon ~ RDP_EPS_MM (0.03mm) — loại điểm thừa, giữ hình.
"""

from __future__ import annotations

import math
from typing import Sequence

Point = tuple[float, float]

FLATTEN_TOL_MM = 0.02
RDP_EPS_MM = 0.03


class CutGeometryError(ValueError):
    """Không chứng nhận được hình học cắt; caller không được bỏ mất vòng đó."""


def _dist(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def flatten_cubic_bezier(
    p0: Point,
    p1: Point,
    p2: Point,
    p3: Point,
    max_seg_mm: float = FLATTEN_TOL_MM,
) -> list[Point]:
    """Chia de Casteljau tới khi cận sai lệch hai chiều đạt dung sai.

    QUALITY (audit 2026-09-24 §CUT24.D01): ``max_seg_mm`` giữ tên để tương
    thích caller, nay là cận sai số hình học, không phải độ dài cạnh. So cubic
    với chord cùng tham số: hai control point hiệu sai có chuẩn <= d, nên
    sai số <= 3*t*(1-t)*d <= 0.75*d trên TOÀN đoạn. Không RDP lần hai, không
    dừng theo số bước khiến đường cong lớn/CTM scale vượt ngân sách.
    """
    if not math.isfinite(max_seg_mm) or max_seg_mm <= 0:
        raise CutGeometryError("Dung sai làm phẳng phải hữu hạn và > 0 mm")
    points = tuple((float(p[0]), float(p[1])) for p in (p0, p1, p2, p3))
    if not all(math.isfinite(v) for p in points for v in p):
        raise CutGeometryError("Tọa độ đường cắt phải hữu hạn")
    result = [points[0]]
    stack = [points]
    while stack:
        a, b, c, d = stack.pop()
        q1 = (a[0]*(2/3) + d[0]/3, a[1]*(2/3) + d[1]/3)
        q2 = (a[0]/3 + d[0]*(2/3), a[1]/3 + d[1]*(2/3))
        bound = .75 * max(_dist(b, q1), _dist(c, q2))
        if bound <= max_seg_mm:
            result.append(d)
            continue
        midpoint = lambda u, v: (u[0]/2+v[0]/2, u[1]/2+v[1]/2)
        ab, bc, cd = midpoint(a, b), midpoint(b, c), midpoint(c, d)
        abc, bcd = midpoint(ab, bc), midpoint(bc, cd)
        mid = midpoint(abc, bcd)
        left, right = (a, ab, abc, mid), (mid, bcd, cd, d)
        if left == (a, b, c, d) or right == (a, b, c, d):
            raise CutGeometryError("Không chứng nhận được đường cắt ở dung sai đã chọn")
        stack.extend((right, left))
    return result


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
