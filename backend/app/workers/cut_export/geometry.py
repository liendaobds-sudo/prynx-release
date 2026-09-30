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


def optimize_cut_paths_tsp(
    paths: Sequence[Any],
    start_pos: Point = (0.0, 0.0),
    rotate_closed_start: bool = True,
) -> list[Any]:
    """PERF (audit 2026-09-30 §CNC.TSP): Tối ưu hóa thứ tự đường dao cắt CNC.

    1. Inside-Out Hierarchy: Bắt buộc cắt toàn bộ các lỗ khoét bên trong (is_hole == True)
       trước khi cắt đường viền bao ngoài (is_hole == False) để bảo toàn lực hút chân không
       và chống nhăn xê dịch tem.
    2. TSP Nearest Neighbor: Chọn đường cắt kế tiếp có điểm bắt đầu gần nhất với vị trí
       đầu dao hiện tại, giảm tối đa quãng đường chạy dao không tải (Pen-Up / Rapid move).
    3. Closed Loop Alignment: Với đường cắt khép kín, chọn đỉnh xuất phát gần nhất với đầu dao.
    4. Open Path Direction: Với đường cắt hở, tự động chọn hướng đi thuận (xuất phát từ đầu mút gần hơn).
    5. Đơn định tuyệt đối: Giữ thứ tự ổn định qua tie-breaking bằng chỉ số gốc.
    """
    if not paths or len(paths) <= 1:
        return list(paths)

    from app.workers.cut_export.cut_model import CutPath

    blocks: dict[tuple[int, str | None], list[tuple[int, Any]]] = {}
    for idx, p in enumerate(paths):
        key = (getattr(p, 'block_id', 0), getattr(p, 'tool_tag', None))
        blocks.setdefault(key, []).append((idx, p))

    optimized_all: list[Any] = []
    curr_x, curr_y = start_pos

    for key in sorted(blocks.keys(), key=lambda k: (k[0], str(k[1]))):
        indexed_block_paths = blocks[key]
        holes = [(idx, p) for idx, p in indexed_block_paths if getattr(p, 'is_hole', False)]
        exteriors = [(idx, p) for idx, p in indexed_block_paths if not getattr(p, 'is_hole', False)]

        for group in (holes, exteriors):
            unvisited = list(group)
            while unvisited:
                best_i = 0
                best_dist_sq = float('inf')
                best_new_path = unvisited[0][1]

                for i, (orig_idx, p) in enumerate(unvisited):
                    pts = p.points
                    if not pts:
                        if float('inf') < best_dist_sq:
                            best_dist_sq = float('inf')
                            best_i = i
                            best_new_path = p
                        continue

                    if getattr(p, 'closed', True) and len(pts) >= 2:
                        raw_pts = pts[:-1] if (len(pts) > 1 and pts[-1] == pts[0]) else pts
                        if rotate_closed_start and len(raw_pts) > 1 and not getattr(p, 'segments', None):
                            closest_vi = 0
                            min_d = float('inf')
                            for vi, (vx, vy) in enumerate(raw_pts):
                                d = (vx - curr_x) ** 2 + (vy - curr_y) ** 2
                                if d < min_d:
                                    min_d = d
                                    closest_vi = vi
                            if min_d < best_dist_sq:
                                best_dist_sq = min_d
                                best_i = i
                                rot = raw_pts[closest_vi:] + raw_pts[:closest_vi]
                                best_new_path = CutPath(
                                    points=rot + [rot[0]],
                                    closed=True,
                                    tool_tag=p.tool_tag,
                                    block_id=p.block_id,
                                    is_hole=getattr(p, 'is_hole', False),
                                )
                        elif rotate_closed_start and len(raw_pts) > 1 and getattr(p, 'segments', None):
                            closest_si = 0
                            min_d = float('inf')
                            for si, seg in enumerate(p.segments):
                                vx, vy = seg[0]
                                d = (vx - curr_x) ** 2 + (vy - curr_y) ** 2
                                if d < min_d:
                                    min_d = d
                                    closest_si = si
                            if min_d < best_dist_sq:
                                best_dist_sq = min_d
                                best_i = i
                                rot_seg = p.segments[closest_si:] + p.segments[:closest_si]
                                best_new_path = CutPath(
                                    points=[],
                                    closed=True,
                                    tool_tag=p.tool_tag,
                                    block_id=p.block_id,
                                    segments=rot_seg,
                                    is_hole=getattr(p, 'is_hole', False),
                                )
                        else:
                            d = (pts[0][0] - curr_x) ** 2 + (pts[0][1] - curr_y) ** 2
                            if d < best_dist_sq:
                                best_dist_sq = d
                                best_i = i
                                best_new_path = p
                    else:
                        d0 = (pts[0][0] - curr_x) ** 2 + (pts[0][1] - curr_y) ** 2
                        d1 = (pts[-1][0] - curr_x) ** 2 + (pts[-1][1] - curr_y) ** 2
                        if d0 <= d1:
                            if d0 < best_dist_sq:
                                best_dist_sq = d0
                                best_i = i
                                best_new_path = p
                        else:
                            if d1 < best_dist_sq:
                                best_dist_sq = d1
                                best_i = i
                                best_new_path = CutPath(
                                    points=list(reversed(pts)),
                                    closed=False,
                                    tool_tag=p.tool_tag,
                                    block_id=p.block_id,
                                    is_hole=getattr(p, 'is_hole', False),
                                )

                unvisited.pop(best_i)
                optimized_all.append(best_new_path)
                if best_new_path.points:
                    curr_x, curr_y = best_new_path.points[-1]

    return optimized_all
