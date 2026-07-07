"""
shape_classifier.py — Port of Illustrator's shape detection logic.

This module ports the following functions from '1. dev - Nô lệ bình bài.jsx':
  - _phanTichHinhHoc_Core (line 8495): Straight-edge polygon analysis (rect, triangle, hexagon, etc.)
  - _analyzeWidthProfile  (line 8913): Width profile scanning for hammer/dumbbell detection
  - detectDumbbellDimensions (line 6691): Parallel-edge handle detection for precise bigDAlongAxisFrac

Logic flow:
  1. Sample Bezier contour from PDF path items
  2. Try polygon classification via straight edges (rectangles, triangles, etc.)
  3. If unresolved, run width profile analysis to detect hammer/dumbbell
  4. Return ShapeClassification with type + geometry params
"""

import math
import logging
from enum import Enum
from typing import Optional, Dict, Any, List, Tuple

logger = logging.getLogger(__name__)


# ShapeType được định nghĩa DUY NHẤT tại shape_types.py (SSOT — R10.1/R10.3).
# Import lại để giữ tương thích cho mọi tham chiếu `ShapeType.X` trong file này.
from app.workers.shape_types import ShapeType  # noqa: E402,F401


# =========================================================================
# STEP 1: Sample Bezier contour from PDF path items
# =========================================================================

def _sample_bezier_contour(path_items) -> List[Tuple[float, float]]:
    """
    Sample points along Bezier curves and line segments from PDF path items.
    Port of JSX lines 8930-8949 (_analyzeWidthProfile sample loop).
    """
    samples = []
    for item in path_items:
        if item[0] == 'l':  # line segment
            p1, p2 = item[1], item[2]
            samples.append((p1.x, p1.y))
            seg_len = math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2)
            interp_steps = max(8, int(math.ceil(seg_len / 3)))
            for t_i in range(1, interp_steps):
                tt = t_i / interp_steps
                samples.append((p1.x + (p2.x - p1.x) * tt, p1.y + (p2.y - p1.y) * tt))
            samples.append((p2.x, p2.y))
        elif item[0] == 'c':  # cubic Bezier
            p0, cp1, cp2, p3 = item[1], item[2], item[3], item[4]
            samples.append((p0.x, p0.y))
            seg_len = math.sqrt((p3.x - p0.x)**2 + (p3.y - p0.y)**2)
            interp_steps = max(8, int(math.ceil(seg_len / 3)))
            for t_i in range(1, interp_steps):
                tt = t_i / interp_steps
                u = 1 - tt
                bx = u**3*p0.x + 3*u**2*tt*cp1.x + 3*u*tt**2*cp2.x + tt**3*p3.x
                by = u**3*p0.y + 3*u**2*tt*cp1.y + 3*u*tt**2*cp2.y + tt**3*p3.y
                samples.append((bx, by))
            samples.append((p3.x, p3.y))
        elif item[0] == 're':
            rect = item[1]
            samples.extend([
                (rect.x0, rect.y0), (rect.x1, rect.y0),
                (rect.x1, rect.y1), (rect.x0, rect.y1),
                (rect.x0, rect.y0)
            ])
        elif item[0] == 'qu':
            q = item[1]
            pts = [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)]
            for i in range(4):
                p1x, p1y = pts[i]
                p2x, p2y = pts[(i+1)%4]
                samples.append((p1x, p1y))
                seg_len = math.sqrt((p2x - p1x)**2 + (p2y - p1y)**2)
                interp_steps = max(8, int(math.ceil(seg_len / 3)))
                for t_i in range(1, interp_steps):
                    tt = t_i / interp_steps
                    samples.append((p1x + (p2x - p1x) * tt, p1y + (p2y - p1y) * tt))
    return samples


def _bounding_box(samples):
    xs = [s[0] for s in samples]
    ys = [s[1] for s in samples]
    return min(xs), max(xs), min(ys), max(ys)


# =========================================================================
# STEP 2: Extract straight edges + polygon classification
#         Port of _phanTichHinhHoc_Core (JSX line 8495)
# =========================================================================

def _extract_straight_edges(path_items, tolerance=1e-4):
    """
    Extract straight edges from path items.
    An edge is 'straight' if both control points coincide with their anchors.
    For PDF parsing, we detect this by checking if Bezier curve is nearly straight.
    """
    edges = []
    total_length = 0.0

    for item in path_items:
        if item[0] == 'l':
            p1, p2 = item[1], item[2]
            dx = p2.x - p1.x
            dy = p2.y - p1.y
            length = math.sqrt(dx*dx + dy*dy)
            if length > tolerance:
                edges.append({
                    'dx': dx, 'dy': dy, 'length': length,
                    'p1': (p1.x, p1.y), 'p2': (p2.x, p2.y)
                })
                total_length += length
        elif item[0] == 'c':
            # Check if nearly straight Bezier
            p0, cp1, cp2, p3 = item[1], item[2], item[3], item[4]
            seg_len = math.sqrt((p3.x - p0.x)**2 + (p3.y - p0.y)**2)
            if seg_len < tolerance:
                continue
            # Deviation of control points from the line p0→p3
            d1 = _point_line_dist(cp1.x, cp1.y, p0.x, p0.y, p3.x, p3.y)
            d2 = _point_line_dist(cp2.x, cp2.y, p0.x, p0.y, p3.x, p3.y)
            max_dev = max(d1, d2)
            if max_dev < seg_len * 0.08:  # ~8% deviation → straight (tolerates light corner rounding)
                dx = p3.x - p0.x
                dy = p3.y - p0.y
                edges.append({
                    'p1': (p0.x, p0.y),
                    'p2': (p3.x, p3.y),
                    'dx': dx,
                    'dy': dy,
                    'length': seg_len
                })
                total_length += seg_len
        elif item[0] == 're':
            rect = item[1]
            pts = [
                (rect.x0, rect.y0), (rect.x1, rect.y0),
                (rect.x1, rect.y1), (rect.x0, rect.y1),
                (rect.x0, rect.y0)
            ]
            for i in range(4):
                dx = pts[i+1][0] - pts[i][0]
                dy = pts[i+1][1] - pts[i][1]
                length = math.sqrt(dx*dx + dy*dy)
                if length > tolerance:
                    edges.append({
                        'p1': pts[i],
                        'p2': pts[i+1],
                        'dx': dx,
                        'dy': dy,
                        'length': length
                    })
                    total_length += length
        elif item[0] == 'qu':
            q = item[1]
            pts = [q.ul, q.ur, q.lr, q.ll]
            for i in range(4):
                p1, p2 = pts[i], pts[(i+1)%4]
                dx, dy = p2.x - p1.x, p2.y - p1.y
                length = math.sqrt(dx*dx + dy*dy)
                if length > tolerance:
                    edges.append({
                        'dx': dx, 'dy': dy, 'length': length,
                        'p1': (p1.x, p1.y), 'p2': (p2.x, p2.y)
                    })
                    total_length += length

    return edges, total_length


def _point_line_dist(px, py, x1, y1, x2, y2):
    """Distance from point (px,py) to line through (x1,y1)-(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    length_sq = dx*dx + dy*dy
    if length_sq < 1e-12:
        return math.sqrt((px-x1)**2 + (py-y1)**2)
    cross = abs(dx*(y1-py) - dy*(x1-px))
    return cross / math.sqrt(length_sq)


def _build_edges_from_vertices(approx_contour):
    """Build edge list from OpenCV approxPolyDP vertices for polygon classification."""
    edges = []
    n = len(approx_contour)
    for i in range(n):
        p1 = approx_contour[i][0]
        p2 = approx_contour[(i + 1) % n][0]
        dx = float(p2[0] - p1[0])
        dy = float(p2[1] - p1[1])
        length = math.sqrt(dx * dx + dy * dy)
        if length > 1e-4:
            edges.append({
                'dx': dx, 'dy': dy, 'length': length,
                'p1': (float(p1[0]), float(p1[1])),
                'p2': (float(p2[0]), float(p2[1]))
            })
    return edges

def _merge_collinear_edges(edges):
    """
    Merge collinear consecutive edges (JSX lines 8565-8611).
    Handles die-cut templates with extra anchor points on straight edges.
    """
    if len(edges) <= 4:
        return edges

    merged = [edges[0].copy()]
    for i in range(1, len(edges)):
        prev = merged[-1]
        curr = edges[i]
        # Normalize direction
        p_nx = prev['dx'] / prev['length']
        p_ny = prev['dy'] / prev['length']
        c_nx = curr['dx'] / curr['length']
        c_ny = curr['dy'] / curr['length']
        dot = p_nx * c_nx + p_ny * c_ny
        if abs(abs(dot) - 1) < 0.01:
            # Merge: extend prev to curr's end
            new_dx = curr['p2'][0] - prev['p1'][0]
            new_dy = curr['p2'][1] - prev['p1'][1]
            new_len = math.sqrt(new_dx*new_dx + new_dy*new_dy)
            merged[-1] = {
                'dx': new_dx, 'dy': new_dy, 'length': new_len,
                'p1': prev['p1'], 'p2': curr['p2']
            }
        else:
            merged.append(curr.copy())

    # Check wrap-around (last → first)
    if len(merged) > 1:
        last = merged[-1]
        first = merged[0]
        l_nx = last['dx'] / last['length']
        l_ny = last['dy'] / last['length']
        f_nx = first['dx'] / first['length']
        f_ny = first['dy'] / first['length']
        dot_lf = l_nx * f_nx + l_ny * f_ny
        if abs(abs(dot_lf) - 1) < 0.01:
            new_dx = first['p2'][0] - last['p1'][0]
            new_dy = first['p2'][1] - last['p1'][1]
            new_len = math.sqrt(new_dx*new_dx + new_dy*new_dy)
            merged[0] = {
                'dx': new_dx, 'dy': new_dy, 'length': new_len,
                'p1': last['p1'], 'p2': first['p2']
            }
            merged.pop()

    return merged


def _find_parallel_groups(edges, tolerance=1e-4):
    """
    Find pairs of parallel edges (JSX lines 9239-9258).
    Uses normalized cross product < 0.035 (~2° tolerance).
    """
    groups = []
    used = set()
    for i in range(len(edges)):
        if i in used:
            continue
        for j in range(i+1, len(edges)):
            if j in used:
                continue
            v1, v2 = edges[i], edges[j]
            cross = abs(v1['dx']*v2['dy'] - v1['dy']*v2['dx'])
            normalized_cross = cross / (v1['length'] * v2['length'] + 1e-10)
            if normalized_cross < 0.035:
                groups.append((v1, v2))
                used.add(i)
                used.add(j)
                break
    return groups


def _ellipse_fit_residual(samples) -> float:
    """Độ lệch của biên so với ELIP KHỚP (bất biến xoay/tịnh tiến).

    Xoay điểm về TRỤC CHÍNH (PCA closed-form 2×2) rồi tính e_i=((u/ax)²+(v/ay)²)
    với ax,ay = nửa-bề-rộng theo trục chính. Elip/tròn THẬT (mọi góc xoay) → e_i≈1
    ở mọi điểm → std≈0. Blob bo tròn (sao bù-xén, dấu +, lưỡi liềm bo...) tuy có thể
    lọt dải tỉ lệ π/4 nhưng cánh/lõm làm e_i dao động → std lớn (≥~0.06).

    Trả std(e_i); càng nhỏ càng giống elip. Trả inf nếu không đủ dữ liệu.
    """
    n = len(samples)
    if n < 8:
        return float('inf')
    mx = sum(p[0] for p in samples) / n
    my = sum(p[1] for p in samples) / n
    sxx = sxy = syy = 0.0
    for x, y in samples:
        dx = x - mx; dy = y - my
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy
    sxx /= n; sxy /= n; syy /= n
    theta = 0.5 * math.atan2(2.0 * sxy, sxx - syy)  # góc trục chính
    ct, st_ = math.cos(theta), math.sin(theta)
    us = [(x - mx) * ct + (y - my) * st_ for x, y in samples]
    vs = [-(x - mx) * st_ + (y - my) * ct for x, y in samples]
    ax = (max(us) - min(us)) / 2.0
    ay = (max(vs) - min(vs)) / 2.0
    if ax <= 1e-9 or ay <= 1e-9:
        return float('inf')
    uc = (max(us) + min(us)) / 2.0
    vc = (max(vs) + min(vs)) / 2.0
    es = [((u - uc) / ax) ** 2 + ((v - vc) / ay) ** 2 for u, v in zip(us, vs)]
    me = sum(es) / len(es)
    return (sum((e - me) ** 2 for e in es) / len(es)) ** 0.5


# Ngưỡng std elip-fit: elip thật (kể cả xoay/egg) ~0–0.003; blob bù-xén bo mạnh ≥0.03.
# 0.02 tách sạch (giữa 0.003 egg vs 0.030 blob trơn nhất gặp thực tế).
_ELLIPSE_FIT_MAX_STD = 0.02

# Tỉ lệ TỐI THIỂU (cạnh thẳng / chu vi) để được xét là ĐA GIÁC. Đa giác thật (tam giác,
# CN, ngũ/lục/bát giác, CN bo góc) phủ ≥~0.55; contour cong phức tạp (bù-xén) chỉ ~0.2–0.4.
# Dưới ngưỡng → cong chiếm ưu thế → không ép vào đa giác (chống "octagon giả").
_MIN_STRAIGHT_COVERAGE = 0.5


def _edges_have_reflex(edges) -> bool:
    """True nếu đa giác (theo list cạnh đã merge) có đỉnh LÕM (reflex) — tức KHÔNG lồi.
    Dùng dấu tích có hướng giữa cạnh liên tiếp: lồi → mọi dấu giống nhau."""
    n = len(edges)
    if n < 3:
        return False
    first = 0.0
    for ci in range(n):
        nx = (ci + 1) % n
        cv = edges[ci]['dx'] * edges[nx]['dy'] - edges[ci]['dy'] * edges[nx]['dx']
        if ci == 0:
            first = cv
        elif (first > 0 and cv < -1e-4) or (first < 0 and cv > 1e-4):
            return True
    return False


def _classify_polygon_core(edges, samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h,
                           *, _n_curve_segments: int = 0):
    """
    Port of _phanTichHinhHoc_Core polygon classification (JSX lines 8495-8898).
    Returns (ShapeType, extra_data) or (None, None) if unresolved.
    """
    merged = _merge_collinear_edges(edges)
    n_edges = len(merged)

    # ── GATE COVERAGE CẠNH THẲNG (gốc rễ "octagon giả" — đo từ file thật) ─────────
    # Contour cong phức tạp (vd đường bù-xén ngôi sao = 41 Bezier) bị _extract_straight_edges
    # lọc nhầm vài đoạn cong-nhẹ thành "cạnh thẳng" (vd 8 đoạn) → ÉP nhầm vào nhánh đa
    # giác (octagon→CIRCLE_ELLIPSE, hoặc pentagon/hexagon...). Đa giác THẬT có cạnh thẳng
    # phủ gần hết chu vi (octagon ~100%); blob cong chỉ phủ ~28%. Khi coverage thấp →
    # cạnh thẳng là NHIỄU, KHÔNG đại diện hình → CHỈ cho kết luận tròn/elip qua ellipse-fit
    # (bất biến, đáng tin), KHÔNG ép vào đa giác. Tròn/elip thật: 0 cạnh thẳng (coverage 0)
    # cũng đi đúng nhánh này.
    _perim = 0.0
    _ns = len(samples)
    for _i in range(_ns):
        _x1, _y1 = samples[_i]
        _x2, _y2 = samples[(_i + 1) % _ns]
        _perim += math.hypot(_x2 - _x1, _y2 - _y1)
    _straight_len = sum(e['length'] for e in merged)
    _coverage = (_straight_len / _perim) if _perim > 0 else 0.0

    if _coverage < _MIN_STRAIGHT_COVERAGE and len(samples) >= 8:
        # Cong chiếm ưu thế: chỉ nhận TRÒN/ELIP nếu thực sự khớp elip; còn lại → None
        # (để width-profile / fallback → CUSTOM). KHÔNG chạm các nhánh đa giác.
        bbox_area = total_w * total_h
        ratio = 0.0
        if bbox_area > 0:
            _ra = 0.0
            for _i in range(_ns):
                _x1, _y1 = samples[_i]
                _x2, _y2 = samples[(_i + 1) % _ns]
                _ra += _x1 * _y2 - _x2 * _y1
            ratio = abs(_ra) / 2.0 / bbox_area
        if _ellipse_fit_residual(samples) < _ELLIPSE_FIT_MAX_STD:
            return ShapeType.CIRCLE_ELLIPSE, {'area_ratio': ratio}
        return None, None

    # Count horizontal edges (normalized tolerance ~2 deg)
    h_count = sum(1 for e in merged if abs(e['dy'] / e['length']) < 0.035)

    # 0 straight edges → circle/ellipse via area ratio
    if n_edges == 0 and len(samples) >= 4:
        # Compute area via Shoelace formula
        real_area = 0.0
        n = len(samples)
        for i in range(n):
            x1, y1 = samples[i]
            x2, y2 = samples[(i+1) % n]
            real_area += x1*y2 - x2*y1
        real_area = abs(real_area) / 2.0
        bbox_area = total_w * total_h
        if bbox_area > 0:
            ratio = real_area / bbox_area
            # Tròn/elip (kể cả XOAY/dẹt): dùng độ KHỚP ELIP bất biến xoay làm tiêu chí
            # CHÍNH. Trước đây chỉ dựa dải tỉ lệ diện tích ~π/4 (0.73–0.84) nên BỎ SÓT
            # elip xoay/dẹt (bbox nở to → tỉ lệ rớt khỏi dải dù vẫn là elip thật). Đo
            # residual PCA: elip thật (mọi góc) ~0; blob/lens/pill/sao ≥0.058. <0.02 ⇔ elip.
            #
            # CỔNG CẤU TRÚC BỔ SUNG (chống contour bù-xén bo CỰC mạnh nhầm elip):
            # Elip chuẩn PDF = ĐÚNG 4 cubic Bezier (kappa 4-arc). Có thể tách thêm →
            # 5-6 max. Contour bù-xén (outline sticker) LUÔN ≥ 8 segments (biểu diễn
            # hình phức tạp). Kết hợp: residual < 0.02 VÀ ≤ 6 curve-segments → elip.
            # Khi caller KHÔNG truyền segment count (_n_curve_segments=0) → chỉ dùng
            # residual (tương thích test gọi trực tiếp không path_items).
            residual_ok = _ellipse_fit_residual(samples) < _ELLIPSE_FIT_MAX_STD
            structure_ok = (_n_curve_segments == 0 or _n_curve_segments <= 6)
            if residual_ok and structure_ok:
                return ShapeType.CIRCLE_ELLIPSE, {'area_ratio': ratio}
        # Don't return CUSTOM here — let width profile try trapezoid ramp detection
        return None, None

    # 3 edges → triangle
    if n_edges == 3:
        par = _find_parallel_groups(merged)
        if len(par) > 0:
            return ShapeType.CUSTOM, {'reason': '3_edges_with_parallel'}
        tri_params = _analyze_triangle_params(merged, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h)
        return ShapeType.TRIANGLE, tri_params

    # 4 edges
    if n_edges == 4:
        par = _find_parallel_groups(merged)
        n_par = len(par)
        if n_par == 2:
            g1_v, g2_v = par[0][0], par[1][0]
            # CHUẨN HOÁ vector cạnh trước khi so vuông góc: dx/dy là vector THÔ (độ
            # lớn = chiều dài cạnh, hàng trăm pt). Tích thô = L1·L2·cos(góc), nên
            # ngưỡng 1e-4 cũ đòi vuông góc TUYỆT ĐỐI — góc lệch nửa độ (làm tròn toạ
            # độ / lấy mẫu bezier) đã cho dot≈vài trăm → chữ nhật thật rơi nhầm thành
            # bình hành. Chia length → |cos(góc)|, dung sai 0.08 (~4.6°) khớp nhánh
            # chữ nhật vát góc bên dưới (audit hình học 2026-07-07).
            n1x, n1y = g1_v['dx'] / g1_v['length'], g1_v['dy'] / g1_v['length']
            n2x, n2y = g2_v['dx'] / g2_v['length'], g2_v['dy'] / g2_v['length']
            if abs(n1x*n2x + n1y*n2y) < 0.08:
                # Perpendicular parallel pairs → rectangle
                return ShapeType.RECTANGLE, {}
            else:
                # Non-perpendicular → parallelogram
                para_params = _analyze_parallelogram_params(merged, total_w, total_h)
                return ShapeType.PARALLELOGRAM, para_params
        elif n_par == 1:
            # 1 parallel pair → trapezoid
            trap_params = _analyze_trapezoid_params(merged, par[0], total_w, total_h)
            return ShapeType.TRAPEZOID, trap_params
        else:
            # 0 parallel pairs → irregular quadrilateral (JSX lines 8815-8822)
            # Must return CUSTOM so it uses Bounding Box or Grid layout safely.
            return ShapeType.CUSTOM, {'reason': '4_edge_no_parallel'}

    # 5 edges
    if n_edges == 5 and h_count < 2:
        par = _find_parallel_groups(merged)
        if len(par) >= 2:
            return ShapeType.CUSTOM, {'reason': 'pentagon_variant'}
        # Convexity check
        is_convex = True
        first_cross = 0.0
        for ci in range(len(merged)):
            c_next = (ci + 1) % len(merged)
            cross_val = merged[ci]['dx'] * merged[c_next]['dy'] - merged[ci]['dy'] * merged[c_next]['dx']
            if ci == 0:
                first_cross = cross_val
            elif (first_cross > 0 and cross_val < -1e-4) or (first_cross < 0 and cross_val > 1e-4):
                is_convex = False
                break
        if not is_convex:
            return ShapeType.CUSTOM, {'reason': '5_edge_concave'}
        pent_params = _analyze_pentagon_params(merged, s_min_y, s_max_y, total_h)
        return ShapeType.PENTAGON, pent_params

    # 6 edges
    if n_edges == 6:
        par = _find_parallel_groups(merged)
        if len(par) == 3:
            hex_params = _analyze_hexagon_params(merged, total_w, total_h)
            return ShapeType.HEXAGON, hex_params
        return ShapeType.CUSTOM, {'reason': '6_edge_non_hex'}

    # 7 edges → arrow (heptagon điển hình của tem mũi tên). Khớp nhánh raster
    # (vertices==7 → ARROW) và CHẶN rơi xuống width-profile bị nhận nhầm thành
    # HAMMER (audit shape-detection: arrow7 → HAMMER). Hammer/dumbbell thực tế là
    # đường cong trơn (0 cạnh thẳng) nên không chạm nhánh này.
    if n_edges == 7:
        # Mũi tên THẬT có đỉnh LÕM (reflex) nơi thân gặp ngạnh đầu. Đa giác 7 cạnh LỒI
        # (heptagon đều, hình tròn-hoá 7 cạnh...) KHÔNG phải mũi tên → tránh gán nhầm
        # ARROW rồi xếp theo giả định mũi tên (audit hình học — chống 7-cạnh→ARROW vô điều kiện).
        if _edges_have_reflex(merged):
            return ShapeType.ARROW, {'note': 'heptagon_arrow'}
        return ShapeType.CUSTOM, {'reason': '7_edge_convex'}

    # 8 edges → bát giác (≈ tròn cho layout) HOẶC chữ nhật vát góc.
    # Phân biệt: chữ nhật vát góc có 4 cạnh DÀI (2 cặp song song ⊥) + 4 vát NGẮN
    # (bimodal độ dài). Bát giác đều có 8 cạnh xấp xỉ bằng nhau. Tránh xếp nhầm
    # nhãn vát góc theo kiểu tròn (audit shape-detection).
    if n_edges == 8:
        lengths = sorted((e['length'] for e in merged), reverse=True)
        avg_long = sum(lengths[:4]) / 4.0
        avg_short = sum(lengths[4:]) / 4.0
        if avg_short > 1e-6 and (avg_long / avg_short) > 2.0:
            long_edges = sorted(merged, key=lambda e: e['length'], reverse=True)[:4]
            par = _find_parallel_groups(long_edges)
            if len(par) == 2:
                g1, g2 = par[0][0], par[1][0]
                n1x, n1y = g1['dx'] / g1['length'], g1['dy'] / g1['length']
                n2x, n2y = g2['dx'] / g2['length'], g2['dy'] / g2['length']
                if abs(n1x * n2x + n1y * n2y) < 0.08:  # 2 cặp song song ~vuông góc
                    return ShapeType.RECTANGLE, {'note': 'chamfered_rect'}
        return ShapeType.CIRCLE_ELLIPSE, {'note': 'octagon'}

    return None, None  # Unresolved → need width profile


def _classify_polygon(edges, samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h,
                      *, _n_curve_segments: int = 0):
    """Wrapper to guarantee hexOrientation is always present for manual overrides."""
    shape_type, extra_data = _classify_polygon_core(edges, samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h,
                                                    _n_curve_segments=_n_curve_segments)
    
    if shape_type is not None or extra_data is not None:
        if extra_data is None:
            extra_data = {}
        if 'hexOrientation' not in extra_data:
            merged = _merge_collinear_edges(edges)
            hex_params = _analyze_hexagon_params(merged, total_w, total_h)
            extra_data['hexOrientation'] = hex_params['hexOrientation']
            
    return shape_type, extra_data


# =========================================================================
# STEP 2b: Shape-specific parameter analysis
# =========================================================================

def _analyze_hexagon_params(edges, total_w, total_h):
    """Detect hexagon orientation: flat-top vs pointy-top via horizontal edge analysis."""
    # Check horizontal edges
    h_edges = [e for e in edges if abs(e['dy'] / e['length']) < 0.035]
    # Check vertical edges
    v_edges = [e for e in edges if abs(e['dx'] / e['length']) < 0.035]
    
    unique_h_ys = set()
    for e in h_edges:
        # Group by Y coordinate (tolerance 2 units)
        unique_h_ys.add(round(e['p1'][1] / 2.0) * 2.0)
        
    unique_v_xs = set()
    for e in v_edges:
        # Group by X coordinate (tolerance 2 units)
        unique_v_xs.add(round(e['p1'][0] / 2.0) * 2.0)
        
    # flat-top: 2+ horizontal edges at different Y
    # pointy-top: 2+ vertical edges at different X
    if len(unique_h_ys) >= 2:
        return {'hexOrientation': 'flat-top'}
    if len(unique_v_xs) >= 2:
        return {'hexOrientation': 'pointy-top'}
        
    # Fallback: wider than tall -> flat-top
    return {'hexOrientation': 'flat-top' if total_w > total_h else 'pointy-top'}


def _analyze_triangle_params(edges, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h):
    """Detect triangle apex direction and compute gapMultiplierH + deltaW for layout."""
    params = {'gapMultiplierH': 2.0, 'deltaW': 0}
    if not edges:
        return params
    # Find horizontal and vertical edges
    h_edge = None
    v_edge = None
    for e in edges:
        if abs(e['dy'] / e['length']) < 0.035:
            h_edge = e
        if abs(e['dx'] / e['length']) < 0.035:
            v_edge = e
    # Determine apex direction
    if h_edge:
        # Find vertex not on horizontal edge
        all_pts = set()
        for e in edges:
            all_pts.add((round(e['p1'][0], 2), round(e['p1'][1], 2)))
            all_pts.add((round(e['p2'][0], 2), round(e['p2'][1], 2)))
        edge_pts = {(round(h_edge['p1'][0], 2), round(h_edge['p1'][1], 2)),
                    (round(h_edge['p2'][0], 2), round(h_edge['p2'][1], 2))}
        other_pts = all_pts - edge_pts
        if other_pts:
            apex = list(other_pts)[0]
            edge_y = h_edge['p1'][1]
            params['triangleApex'] = 'up' if apex[1] < edge_y else 'down'
        else:
            params['triangleApex'] = 'up'
            
        sloped_edges = [e for e in edges if e != h_edge and abs(e['dy']) > 0.1 and abs(e['dx']) > 0.1]
        sloped_edges.sort(key=lambda e: e['length'], reverse=True)
        if len(sloped_edges) >= 2:
            e1, e2 = sloped_edges[0], sloped_edges[1]
            y_base = h_edge['p1'][1]
            x_int1 = (y_base - e1['p1'][1]) * (e1['dx'] / e1['dy']) + e1['p1'][0]
            x_int2 = (y_base - e2['p1'][1]) * (e2['dx'] / e2['dy']) + e2['p1'][0]
            virtual_w = abs(x_int1 - x_int2)
            params['deltaW'] = max(0, virtual_w - total_w)
    elif v_edge:
        all_pts = set()
        for e in edges:
            all_pts.add((round(e['p1'][0], 2), round(e['p1'][1], 2)))
            all_pts.add((round(e['p2'][0], 2), round(e['p2'][1], 2)))
        edge_pts = {(round(v_edge['p1'][0], 2), round(v_edge['p1'][1], 2)),
                    (round(v_edge['p2'][0], 2), round(v_edge['p2'][1], 2))}
        other_pts = all_pts - edge_pts
        if other_pts:
            apex = list(other_pts)[0]
            edge_x = v_edge['p1'][0]
            params['triangleApex'] = 'right' if apex[0] > edge_x else 'left'
        else:
            params['triangleApex'] = 'rotated'
            
        sloped_edges = [e for e in edges if e != v_edge and abs(e['dy']) > 0.1 and abs(e['dx']) > 0.1]
        sloped_edges.sort(key=lambda e: e['length'], reverse=True)
        if len(sloped_edges) >= 2:
            e1, e2 = sloped_edges[0], sloped_edges[1]
            x_base = v_edge['p1'][0]
            y_int1 = (x_base - e1['p1'][0]) * (e1['dy'] / e1['dx']) + e1['p1'][1]
            y_int2 = (x_base - e2['p1'][0]) * (e2['dy'] / e2['dx']) + e2['p1'][1]
            virtual_h = abs(y_int1 - y_int2)
            params['deltaW'] = max(0, virtual_h - total_h)
    else:
        params['triangleApex'] = 'rotated'
    # Compute slope angle for gapMultiplierH
    # Perpendicular gap between interlocked edges = h*(h_step - w) / (2*L)
    # where L = sqrt(h² + (w/2)²). For this to equal gap_x, we need:
    # h_step = w + 2*L/h * gap_x = w + 2/sin(angle) * gap_x
    slope_angle = math.atan2(total_h, total_w / 2)
    sin_angle = math.sin(slope_angle)
    if sin_angle > 0.1:
        params['gapMultiplierH'] = 2.0 / sin_angle
    return params


def _analyze_pentagon_params(edges, s_min_y, s_max_y, total_h):
    """Detect pentagon orientation and peak height ratio."""
    if not edges or total_h <= 0:
        return {'peakHeightRatio': 0.25, 'pentagonOrientation': 'up'}
    # Get all Y coordinates
    all_ys = set()
    for e in edges:
        all_ys.add(e['p1'][1])
        all_ys.add(e['p2'][1])
    sorted_ys = sorted(all_ys)
    unique_ys = [sorted_ys[0]]
    for y in sorted_ys[1:]:
        if abs(y - unique_ys[-1]) > 0.5:
            unique_ys.append(y)
    if len(unique_ys) < 3:
        return {'peakHeightRatio': 0.25, 'pentagonOrientation': 'up'}
    # Check if top edge is horizontal (flat top = pointing down)
    h_edges = [e for e in edges if abs(e['dy'] / e['length']) < 0.035]
    has_top_h = any(abs(e['p1'][1] - s_min_y) < 1.0 for e in h_edges)
    has_bottom_h = any(abs(e['p1'][1] - s_max_y) < 1.0 for e in h_edges)
    if has_top_h and not has_bottom_h:
        orientation = 'down'
        peak_h = abs(unique_ys[-1] - unique_ys[-2]) / total_h
    elif has_bottom_h and not has_top_h:
        orientation = 'up'
        peak_h = abs(unique_ys[1] - unique_ys[0]) / total_h
    else:
        orientation = 'up'
        peak_h = abs(unique_ys[1] - unique_ys[0]) / total_h
    return {'peakHeightRatio': round(peak_h, 4), 'pentagonOrientation': orientation}


def _analyze_trapezoid_params(edges, parallel_pair, total_w, total_h):
    """Detect trapezoid overhang dimensions from parallel edge pair."""
    base1, base2 = parallel_pair
    len1 = base1['length']
    len2 = base2['length']
    long_base = max(len1, len2)
    short_base = min(len1, len2)
    # Determine if horizontal trapezoid using the PARALLEL BASES (not a random edge)
    # If bases are ~horizontal (small dy/length), it's a horizontal trapezoid
    is_horizontal = abs(base1['dy'] / base1['length']) < 0.035
    is_vertical = abs(base1['dx'] / base1['length']) < 0.035
    
    # Find the two non-parallel sides (exclude the parallel bases)
    side_edges = [e for e in edges if e != base1 and e != base2]
    
    left_oh_val = (long_base - short_base) / 2.0
    right_oh_val = (long_base - short_base) / 2.0
    
    if len(side_edges) == 2:
        if is_horizontal:
            s0avg = (side_edges[0]['p1'][0] + side_edges[0]['p2'][0]) / 2.0
            s1avg = (side_edges[1]['p1'][0] + side_edges[1]['p2'][0]) / 2.0
            left_side = side_edges[0] if s0avg <= s1avg else side_edges[1]
            right_side = side_edges[1] if s0avg <= s1avg else side_edges[0]
            left_oh_val = abs(left_side['dx'])
            right_oh_val = abs(right_side['dx'])
        elif is_vertical:
            s0avg = (side_edges[0]['p1'][1] + side_edges[0]['p2'][1]) / 2.0
            s1avg = (side_edges[1]['p1'][1] + side_edges[1]['p2'][1]) / 2.0
            bot_side = side_edges[0] if s0avg <= s1avg else side_edges[1]
            top_side = side_edges[1] if s0avg <= s1avg else side_edges[0]
            left_oh_val = abs(bot_side['dy'])
            right_oh_val = abs(top_side['dy'])

    return {
        'leftOH': round(left_oh_val, 2), 'rightOH': round(right_oh_val, 2),
        'isHorizontal': is_horizontal, 'isVertical': is_vertical,
        'longBase': round(long_base, 2), 'shortBase': round(short_base, 2),
        'bbW': round(total_w, 2), 'bbH': round(total_h, 2)
    }


def _analyze_parallelogram_params(edges, total_w, total_h):
    """Detect parallelogram skew overhang from edge analysis."""
    if len(edges) < 4:
        return {'overhangX': 0, 'overhangY': 0}
    # Find all vertices
    all_pts = []
    for e in edges:
        all_pts.append(e['p1'])
        all_pts.append(e['p2'])
    # Unique vertices
    unique_pts = []
    for pt in all_pts:
        is_dup = False
        for up in unique_pts:
            if abs(pt[0] - up[0]) < 0.5 and abs(pt[1] - up[1]) < 0.5:
                is_dup = True
                break
        if not is_dup:
            unique_pts.append(pt)
    if len(unique_pts) < 4:
        return {'overhangX': 0, 'overhangY': 0}
    # Sort by Y then X
    sorted_by_y = sorted(unique_pts, key=lambda p: p[1])
    top_pts = sorted(sorted_by_y[:2], key=lambda p: p[0])
    bot_pts = sorted(sorted_by_y[2:], key=lambda p: p[0])
    # overhangX: horizontal shift between top-left and bottom-left
    overhang_x = abs(top_pts[0][0] - bot_pts[0][0])
    # overhangY: vertical shift between top-left and top-right at the same X
    sorted_by_x = sorted(unique_pts, key=lambda p: p[0])
    left_pts = sorted(sorted_by_x[:2], key=lambda p: p[1])
    overhang_y = abs(left_pts[0][1] - left_pts[1][1]) if len(left_pts) >= 2 else 0
    # overhangY is distance from parallelogram lean, not full height
    overhang_y = min(overhang_y, total_h * 0.5)
    return {'overhangX': round(overhang_x, 2), 'overhangY': round(overhang_y, 2)}


# =========================================================================
# STEP 3: Width Profile Analysis — Hammer/Dumbbell detection
#         Port of _analyzeWidthProfile (JSX line 8913)
# =========================================================================

# Ngưỡng "đầu gọn ở mút" cho búa/tạ (audit búa/tạ — chống nhận nhầm hình đặc biệt).
# big_d_along_axis_frac = phần ĐẦU chiếm bao nhiêu dọc trục dài. Búa/tạ THẬT: đầu gọn
# ở mút (~0.2–0.45), phần còn lại là CÁN. Hình đặc biệt có khối phình trải dài (dấu +,
# quả lê, lưỡi liềm: 0.69–0.77) → KHÔNG phải đầu+cán. Ngưỡng 0.6 tách sạch (biên rộng).
_MAX_HEAD_EXTENT_FRAC = 0.6

# Ngưỡng "thuôn về MŨI NHỌN" (chống tam giác/nón bo tròn bị nhận nhầm búa/tạ).
# Búa/tạ THẬT có CÁN bề rộng hữu hạn (min_w/max_w ~0.28–0.4). Tam giác/nón bo tròn
# thu gần về MỘT ĐIỂM ở mút (min_w/max_w ~0.02–0.03). Khi tỉ lệ này quá nhỏ → hình
# thuôn nhọn (tam giác/giọt nước/contour bù-xén ngôi sao+chữ), KHÔNG phải đầu+cán.
_MIN_TIP_WIDTH_FRAC = 0.15


def _analyze_width_profile(samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h, edges=None, force=False):
    """
    Port of _analyzeWidthProfile (JSX lines 8913-9158).
    Scans cross-sections along the long axis to detect waist (narrow handle)
    and classify as hammer (1 wide head) or dumbbell (2 wide heads).

    Returns dict with:
      shapeType: 'hammer' | 'dumbbell'
      bigD, smallD, bodyW, waistFrac, bigEndFirst, bigDAlongAxisFrac, waistRatio
    or None if not hammer/dumbbell.
    """
    is_horizontal = total_w > total_h
    long_dim = total_w if is_horizontal else total_h
    short_dim = total_h if is_horizontal else total_w


    # Build width profile: 50 slices
    NUM_SLICES = 50
    width_profile = []

    for s in range(NUM_SLICES):
        frac = (s + 0.5) / NUM_SLICES
        if is_horizontal:
            slice_pos = s_min_x + frac * total_w
        else:
            # PDF: Y increases downward (0 at top), unlike AI where Y increases upward
            slice_pos = s_min_y + frac * total_h

        tolerance = long_dim / (NUM_SLICES * 1.5)
        cross_min, cross_max = float('inf'), float('-inf')
        found = False

        for sx, sy in samples:
            axis_val = sx if is_horizontal else sy
            cross_val = sy if is_horizontal else sx

            if abs(axis_val - slice_pos) <= tolerance:
                cross_min = min(cross_min, cross_val)
                cross_max = max(cross_max, cross_val)
                found = True

        if found and cross_max > cross_min:
            width_profile.append({
                'pos': frac,
                'width': cross_max - cross_min,
                'center': (cross_max + cross_min) / 2
            })

    if len(width_profile) < 10:
        return None

    # Find global max width
    global_max_width = max(wp['width'] for wp in width_profile)
    if global_max_width <= 0:
        return None

    # Find waist (narrowest point in middle region)
    EDGE_MARGIN = 0.10
    waist_width = float('inf')
    waist_pos = 0.5
    waist_center = 0.0

    for wp in width_profile:
        if EDGE_MARGIN < wp['pos'] < (1 - EDGE_MARGIN):
            if wp['width'] < waist_width:
                waist_width = wp['width']
                waist_pos = wp['pos']
                waist_center = wp['center']

    if waist_width == float('inf'):
        return None

    # Measure peak width in each half (split at waist)
    head_start_peak = 0.0
    head_end_peak = 0.0
    head_start_center = 0.0
    head_end_center = 0.0

    for wp in width_profile:
        if wp['pos'] < waist_pos:
            if wp['width'] > head_start_peak:
                head_start_peak = wp['width']
                head_start_center = wp['center']
        elif wp['pos'] > waist_pos:
            if wp['width'] > head_end_peak:
                head_end_peak = wp['width']
                head_end_center = wp['center']

    # JSX ramp detection: monotonic width change → trapezoid (before hammer/dumbbell checks)
    widths = [wp['width'] for wp in width_profile]
    first_w = widths[0]
    last_w = widths[-1]
    max_w = max(widths)
    min_w = min(widths)
    ramp_ratio = abs(last_w - first_w) / max_w if max_w > 0 else 0

    # CỔNG "THUÔN VỀ MŨI NHỌN" (audit tam giác bo tròn → HAMMER): nếu hình thu gần về
    # MỘT ĐIỂM ở mút (min_w/max_w rất nhỏ) thì đây là tam giác/nón/giọt nước (contour
    # bù-xén ngôi sao + chữ cũng vào đây), KHÔNG phải búa/tạ (cán có bề rộng hữu hạn).
    # → trả None (→ CUSTOM). Contour bo tròn không có 3 cạnh thẳng nên không vào nhánh
    # TRIANGLE; CUSTOM là an toàn (dùng layout contour/bbox). Bỏ qua khi force.
    if not force and max_w > 0 and (min_w / max_w) < _MIN_TIP_WIDTH_FRAC:
        return None

    # Compute max peak width early (needed for both ramp and hammer detection)
    max_peak_width = max(head_start_peak, head_end_peak)

    if ramp_ratio > 0.3 and min_w > max_w * 0.2:
        # Before concluding trapezoid, check if there's a clear waist (= hammer).
        # A true trapezoid ramps smoothly; a hammer has a sudden narrow section.
        # If waist_width / max_peak is < 0.85, it's hammer territory — skip ramp.
        has_waist = waist_width < float('inf') and max_peak_width > 0 and (waist_width / max_peak_width) < 0.85
        if not has_waist:
            # Width ramps steadily → trapezoid (not triangle, which has min near 0)
            # Compute overhang from width profile
            is_horizontal_trap = is_horizontal
            long_base = max_w
            short_base = min_w
            diff = long_base - short_base
            # For rounded trapezoids without edges, use symmetric overhang as default
            left_oh = diff / 2.0
            right_oh = diff / 2.0
            return {
                'shapeType': 'trapezoid',
                'isHorizontal': is_horizontal_trap,
                'leftOH': round(left_oh, 2),
                'rightOH': round(right_oh, 2),
                'longBase': round(long_base, 2),
                'shortBase': round(short_base, 2),
                'rampRatio': round(ramp_ratio, 4),
            }
        # else: has waist → fall through to hammer/dumbbell detection below

    # Validation: waist must be clearly narrower than peaks
    if max_peak_width <= 0:
        return None
    waist_ratio = waist_width / max_peak_width

    # Revert back to original Illustrator thresholds (0.85 and 1.15)
    # The tightened thresholds (0.70) caused false negatives for thick-waisted hammers.
    if not force and waist_ratio >= 0.85:
        return None  # No clear waist
    if not force and max_peak_width / waist_width < 1.15:
        return None  # Head not wide enough relative to waist

    # Classify: hammer vs dumbbell (JSX lines 9063-9082)
    WIDE_THRESHOLD = 1.15
    start_is_wide = head_start_peak > waist_width * WIDE_THRESHOLD
    end_is_wide = head_end_peak > waist_width * WIDE_THRESHOLD

    if start_is_wide and end_is_wide:
        peak_ratio = min(head_start_peak, head_end_peak) / max(head_start_peak, head_end_peak)
        if peak_ratio < 0.6:
            shape_type = 'hammer'
        else:
            shape_type = 'dumbbell'
    elif start_is_wide or end_is_wide:
        shape_type = 'hammer'
    else:
        return None

    # Determine which end is big
    big_end_first = head_start_peak >= head_end_peak
    big_d = max(head_start_peak, head_end_peak)
    small_d = min(head_start_peak, head_end_peak)

    # Find transition point (where head meets handle)
    # Scan FROM waist TOWARD the big head edge
    transition_threshold = (big_d + waist_width) / 2
    big_head_edge_pos = waist_pos

    if big_end_first:
        # Big head is at start (low frac) → scan from waist backward toward frac=0
        for wp in reversed(width_profile):
            if wp['pos'] < waist_pos and wp['pos'] > 0.05:
                if wp['width'] >= transition_threshold:
                    big_head_edge_pos = wp['pos']
                    break
    else:
        # Big head is at end (high frac) → scan from waist forward toward frac=1
        for wp in width_profile:
            if wp['pos'] > waist_pos and wp['pos'] < 0.95:
                if wp['width'] >= transition_threshold:
                    big_head_edge_pos = 1 - wp['pos']
                    break

    big_d_along_axis_frac = big_head_edge_pos

    # CỔNG "ĐẦU GỌN Ở MÚT" (audit búa/tạ — chống nhận nhầm hình đặc biệt thành búa/tạ).
    # Búa/tạ thật: đầu chiếm phần NHỎ ở mút, phần còn lại là CÁN dài → big_d_along_axis_frac
    # nhỏ (đo thực nghiệm: 0.29–0.33). Hình đặc biệt (dấu +, quả lê, lưỡi liềm) là khối
    # phình rồi thắt, "đầu" trải >0.6 trục (0.69–0.77) → KHÔNG phải đầu+cán → trả None
    # (→ CUSTOM). Bỏ qua khi force=True (chế độ TRÍCH tham số sau khi type đã chốt).
    if not force and big_d_along_axis_frac > _MAX_HEAD_EXTENT_FRAC:
        return None

    # Find small head transition
    small_transition_threshold = (small_d + waist_width) / 2
    small_head_frac = 0.0

    if big_end_first:
        for wp in reversed(width_profile):
            if wp['pos'] < 0.95 and wp['width'] < small_transition_threshold:
                small_head_frac = 1 - wp['pos']
                break
    else:
        for wp in width_profile:
            if wp['pos'] > 0.05 and wp['width'] < small_transition_threshold:
                small_head_frac = wp['pos']
                break

    if small_head_frac < 0.05:
        small_head_frac = 0.15

    # Asymmetry offset
    big_center = head_start_center if big_end_first else head_end_center
    small_center = head_end_center if big_end_first else head_start_center
    asymm_offset = abs(big_center - waist_center)
    small_asymm_offset = abs(small_center - waist_center)

    safe_interlock_pitch = 0.0
    for wpA in width_profile:
        target_posB = 1.0 - wpA['pos']
        closest_wp = min(width_profile, key=lambda wp: abs(wp['pos'] - target_posB))
        combined_half_width = (wpA['width'] + closest_wp['width']) / 2.0
        if combined_half_width > safe_interlock_pitch:
            safe_interlock_pitch = combined_half_width

    # KIỂM TRA ĐỐI XỨNG TRỤC (BILATERAL SYMMETRY) - BẢN GỐC JSX (Lines 9595-9607)
    # Loại bỏ các hình Búa/Tạ nhưng bị lệch trục cầm quá 15% (bất đối xứng lớn).
    if waist_width > 0:
        asym_ratio = asymm_offset / waist_width
        if asym_ratio > 0.15:
            return None # Trả về None để fallback thành tem Đặc Biệt

    return {
        'shapeType': shape_type,
        'bigD': big_d,
        'smallD': small_d,
        'bodyW': waist_width,
        'waistFrac': waist_pos,
        'bigEndFirst': big_end_first,
        'bigDAlongAxisFrac': big_d_along_axis_frac,
        'smallHeadFrac': small_head_frac,
        'isHorizontal': is_horizontal,
        'waistRatio': waist_ratio,
        'asymmOffset': asymm_offset,
        'smallAsymmOffset': small_asymm_offset,
        'safeInterlockPitch': safe_interlock_pitch,
    }


# =========================================================================
# MAIN ENTRY POINT: classify_shape
# =========================================================================

def classify_shape(path_items, page_rect=None) -> Dict[str, Any]:
    """
    Main shape classification function. Port of Illustrator's combined logic:
      1. _phanTichHinhHoc_Core → polygon classification via straight edges
      2. _analyzeWidthProfile  → width profile for hammer/dumbbell

    Args:
        path_items: list of path items from page.extract_vector_paths() → drawing['items']
        page_rect: pdf_lib.Rect of the page (optional, for context)

    Returns:
        dict with keys:
          - 'shape_type': ShapeType enum
          - 'shape_name': str (Vietnamese name)
          - 'params': dict with geometry parameters (bigDAlongAxisFrac, waistRatio, etc.)
          - 'source': 'polygon' | 'width_profile' | 'fallback'
    """
    if not path_items:
        return _result(ShapeType.CUSTOM, {}, 'fallback')

    # Step 1: Sample Bezier contour
    samples = _sample_bezier_contour(path_items)
    if len(samples) < 3:
        return _result(ShapeType.CUSTOM, {}, 'fallback')

    s_min_x, s_max_x, s_min_y, s_max_y = _bounding_box(samples)
    total_w = s_max_x - s_min_x
    total_h = s_max_y - s_min_y
    if total_w <= 0 or total_h <= 0:
        return _result(ShapeType.CUSTOM, {}, 'fallback')

    # Step 2: Extract straight edges and try polygon classification
    edges, total_edge_len = _extract_straight_edges(path_items)
    # Đếm Bezier curves (cấu trúc path): elip PDF = 4 arcs; contour bù-xén = 8+ curves.
    _n_curves = sum(1 for it in path_items if it[0] == 'c')
    poly_type, poly_data = _classify_polygon(
        edges, samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h,
        _n_curve_segments=_n_curves,
    )

    if poly_type is not None:
        # Known polygon type — still run width profile for CUSTOM shapes
        if poly_type not in (ShapeType.CUSTOM, None):
            logger.info(f"[SHAPE_CLASSIFIER] Polygon: {poly_type.name} ({poly_type.value})")
            return _result(poly_type, poly_data or {}, 'polygon')

    # Step 3: Width profile analysis for hammer/dumbbell
    wp_result = _analyze_width_profile(
        samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h, edges
    )

    if wp_result:
        if wp_result['shapeType'] == 'trapezoid':
            trap_params = {
                'leftOH': wp_result['leftOH'],
                'rightOH': wp_result['rightOH'],
                'isHorizontal': wp_result['isHorizontal'],
                'longBase': wp_result['longBase'],
                'shortBase': wp_result['shortBase'],
            }
            logger.info(f"[SHAPE_CLASSIFIER] Width profile: TRAPEZOID (ramp), "
                        f"leftOH={trap_params['leftOH']}, rightOH={trap_params['rightOH']}")
            return _result(ShapeType.TRAPEZOID, trap_params, 'width_profile_ramp')
        elif wp_result['shapeType'] == 'dumbbell':
            shape_type = ShapeType.DUMBBELL
        else:
            shape_type = ShapeType.HAMMER

        params = {
            'bigDAlongAxisFrac': wp_result['bigDAlongAxisFrac'],
            'bigEndAxisFrac': wp_result['bigDAlongAxisFrac'],  # alias
            'waistRatio': wp_result['waistRatio'],
            'bigEndFirst': wp_result['bigEndFirst'],
            'bodyW': wp_result['bodyW'],
            'bigD': wp_result['bigD'],
            'smallD': wp_result['smallD'],
            'smallHeadFrac': wp_result['smallHeadFrac'],
            'asymmOffset': wp_result['asymmOffset'],
            'isHorizontal': wp_result['isHorizontal'],
            'safeInterlockPitch': wp_result.get('safeInterlockPitch', 0),
        }

        logger.info(f"[SHAPE_CLASSIFIER] Width profile: {shape_type.name}, "
                     f"bigDAlongAxisFrac={wp_result['bigDAlongAxisFrac']:.4f}, "
                     f"waistRatio={wp_result['waistRatio']:.4f}, "
                     f"bigD={wp_result['bigD']:.1f}, bodyW={wp_result['bodyW']:.1f}")
        return _result(shape_type, params, 'width_profile')

    reason = (poly_data or {}).get('reason', 'unresolved')
    logger.info(f"[SHAPE_CLASSIFIER] CUSTOM (reason: {reason})")
    return _result(ShapeType.CUSTOM, poly_data or {}, 'fallback')


def _result(shape_type: ShapeType, params: dict, source: str) -> Dict[str, Any]:
    return {
        'shape_type': shape_type,
        'shape_name': shape_type.value,
        'params': params,
        'source': source,
    }

def get_dumbbell_geometry_from_path(path_items, force=False) -> Optional[Dict[str, Any]]:
    """
    Extracts dumbbell/hammer geometry from a path using width profile analysis.
    This is meant to be called AFTER a mask-based classification confirms the shape type.
    """
    if not path_items:
        return None
    samples = _sample_bezier_contour(path_items)
    if len(samples) < 4:
        return None
    s_min_x, s_max_x, s_min_y, s_max_y = _bounding_box(samples)
    total_w = s_max_x - s_min_x
    total_h = s_max_y - s_min_y
    if total_w <= 0 or total_h <= 0:
        return None
    return _analyze_width_profile(samples, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h, force=force)

def force_extract_shape_params(shape_type_str: str, path_items: list) -> dict:
    """
    Forcibly extracts geometry parameters for a specific shape type, ignoring normal classification.
    Used when the user manually overrides the shape type in the UI.
    """
    if not path_items:
        return {}
    if shape_type_str in ('HAMMER', 'DUMBBELL'):
        res = get_dumbbell_geometry_from_path(path_items, force=True)
        if res:
            return {
                'bigDAlongAxisFrac': res.get('bigDAlongAxisFrac', 0),
                'bigEndAxisFrac': res.get('bigDAlongAxisFrac', 0),
                'waistRatio': res.get('waistRatio', 0.5),
                'bigEndFirst': res.get('bigEndFirst', True),
                'bodyW': res.get('bodyW', 0),
                'bigD': res.get('bigD', 0),
                'smallD': res.get('smallD', 0),
                'smallHeadFrac': res.get('smallHeadFrac', 0),
                'asymmOffset': res.get('asymmOffset', 0),
                'smallAsymmOffset': res.get('smallAsymmOffset', 0),
                'isHorizontal': res.get('isHorizontal', True),
                'safeInterlockPitch': res.get('safeInterlockPitch', 0),
            }
    if shape_type_str in ('TRAPEZOID', 'PARALLELOGRAM'):
        edges, total_length = _extract_straight_edges(path_items)
        if not edges:
            return {}
        merged = _merge_collinear_edges(edges)
        # Compute bounding box
        all_pts = []
        for e in merged:
            all_pts.append(e['p1'])
            all_pts.append(e['p2'])
        if not all_pts:
            return {}
        xs = [p[0] for p in all_pts]
        ys = [p[1] for p in all_pts]
        total_w = max(xs) - min(xs)
        total_h = max(ys) - min(ys)
        if shape_type_str == 'TRAPEZOID':
            par = _find_parallel_groups(merged)
            if par:
                return _analyze_trapezoid_params(merged, par[0], total_w, total_h)
            # Fallback: symmetric overhang
            return {'leftOH': 0, 'rightOH': 0, 'isHorizontal': True, 'bbW': round(total_w, 2), 'bbH': round(total_h, 2)}
        else:  # PARALLELOGRAM
            return _analyze_parallelogram_params(merged, total_w, total_h)
    if shape_type_str in ('TRIANGLE', 'PENTAGON'):
        edges, total_length = _extract_straight_edges(path_items)
        if not edges:
            return {}
        merged = _merge_collinear_edges(edges)
        all_pts = []
        for e in merged:
            all_pts.append(e['p1'])
            all_pts.append(e['p2'])
        if not all_pts:
            return {}
        xs = [p[0] for p in all_pts]
        ys = [p[1] for p in all_pts]
        s_min_x, s_max_x = min(xs), max(xs)
        s_min_y, s_max_y = min(ys), max(ys)
        total_w = s_max_x - s_min_x
        total_h = s_max_y - s_min_y
        if shape_type_str == 'TRIANGLE':
            return _analyze_triangle_params(merged, s_min_x, s_max_x, s_min_y, s_max_y, total_w, total_h)
        else:  # PENTAGON
            return _analyze_pentagon_params(merged, s_min_y, s_max_y, total_h)
    return {}
