"""
Die-cut geometry processing for N-Up imposition.

Functions for extracting die-cut polygons from PDF pages,
computing head-to-tail overlap parameters, and finding
the largest die-cut path.

Extracted from nup_engine.py for modularity.
"""

import math
import logging

logger = logging.getLogger(__name__)

def _path_items_to_polygon(path_items):

    """Convert PDF path items (lines + beziers) directly to a Shapely Polygon.

    Samples bezier curves at high resolution — no bitmap rasterization needed."""

    from shapely.geometry import Polygon

    from shapely.ops import unary_union

    subpaths = []

    current_subpath = []

    def add_point(x, y):

        if not current_subpath:

            current_subpath.append((x, y))

        else:

            last_x, last_y = current_subpath[-1]

            if abs(last_x - x) > 0.1 or abs(last_y - y) > 0.1:

                # Gap detected, start new subpath

                subpaths.append(list(current_subpath))

                current_subpath.clear()

            current_subpath.append((x, y))

    for item in path_items:

        if item[0] == 'l':

            p1, p2 = item[1], item[2]

            add_point(p1.x, p1.y)

            current_subpath.append((p2.x, p2.y))

        elif item[0] == 'c':

            p0, cp1, cp2, p3 = item[1], item[2], item[3], item[4]

            add_point(p0.x, p0.y)

            seg_len = math.sqrt((p3.x - p0.x)**2 + (p3.y - p0.y)**2)
            steps = max(2, min(20, int(math.ceil(seg_len / 4))))
            for t_i in range(1, steps):

                tt = t_i / steps

                u = 1 - tt

                bx = u**3*p0.x + 3*u**2*tt*cp1.x + 3*u*tt**2*cp2.x + tt**3*p3.x

                by = u**3*p0.y + 3*u**2*tt*cp1.y + 3*u*tt**2*cp2.y + tt**3*p3.y

                current_subpath.append((bx, by))

            current_subpath.append((p3.x, p3.y))

        elif item[0] == 're':

            if len(current_subpath) > 0:

                subpaths.append(list(current_subpath))

                current_subpath.clear()

            r = item[1]

            subpaths.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)])

    if current_subpath:

        subpaths.append(list(current_subpath))

    polys = []

    for sp in subpaths:

        if len(sp) >= 3:

            try:

                poly = Polygon(sp)

                if not poly.is_valid:

                    poly = poly.buffer(0)

                if poly.is_valid and not poly.is_empty:

                    polys.append(poly)

            except Exception:

                pass

    if not polys:

        return None

    final_poly = unary_union(polys)

    return final_poly

def extract_page_die_cut_polygon(src_page):

    """Extract page's spot color cutline polygon.

    Returns unscaled Shapely Polygon or None if not found/empty."""

    from shapely.ops import unary_union

    try:

        paths = src_page.extract_vector_paths()

        if not paths:

            return None

        valid_paths = [p for p in paths if p.get('rect') and p['rect'].width > 5 and p['rect'].height > 5]

        filtered = []

        for p in valid_paths:

            r = p['rect']

            if abs(r.width - src_page.rect.width) <= 2 and abs(r.height - src_page.rect.height) <= 2:

                continue

            filtered.append(p)

        if filtered:

            valid_paths = filtered

        if not valid_paths:

            return None

        filtered = [p for p in valid_paths if abs(p['rect'].width - src_page.rect.width) > 2 or abs(p['rect'].height - src_page.rect.height) > 2]

        if not filtered: filtered = valid_paths

        stroke_paths = [p for p in filtered if p.get('type') == 's' or (p.get('fill') is None and p.get('color') is not None)]

        target_paths = stroke_paths if stroke_paths else filtered

        if not target_paths:

            return None

        largest_path = max(target_paths, key=lambda p: p['rect'].width * p['rect'].height)

        target_color = largest_path.get('color')

        polys = []

        for p in target_paths:

            if p.get('color') == target_color:

                poly_part = _path_items_to_polygon(p.get('items', []))

                if poly_part and poly_part.is_valid and not poly_part.is_empty:

                    polys.append(poly_part)

        if not polys:

            return None

        poly = unary_union(polys)

        if poly.is_empty:

            return None

        return poly

    except Exception as e:

        import logging

        logging.getLogger(__name__).warning(f"Error extracting page die cut polygon: {e}")

        return None

def get_optimal_head_to_tail_overlap(src_page, gap_pt=0.0):

    import numpy as np

    from app.workers import pdf_wrapper as pdf_lib

    from shapely.geometry import Polygon

    from shapely import affinity

    import logging

    logger = logging.getLogger(__name__)

    try:

        zoom = 2.0 

        paths = src_page.extract_vector_paths()

        logger.debug(f"[HEAD_TO_TAIL_DEBUG] page_rect={src_page.rect}, gap_pt={gap_pt}")

        logger.debug(f"[HEAD_TO_TAIL_DEBUG] total paths={len(paths) if paths else 0}")

        if not paths:

            return ({'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, {'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, None, None, None, None, "CUSTOM", {}, None)

        valid_paths = [p for p in paths if p['rect'].width > 5 and p['rect'].height > 5]

        logger.debug(f"[HEAD_TO_TAIL_DEBUG] valid_paths count={len(valid_paths)}")

        for i, p in enumerate(valid_paths[:10]):

            logger.debug(f"[HEAD_TO_TAIL_DEBUG]   path[{i}] rect={p['rect']} items_count={len(p.get('items',[]))} item_types={[it[0] for it in p.get('items',[])][:5]}")

        # Filter out paths that cover the entire page (backgrounds/bleeds)

        filtered = []

        for p in valid_paths:

            r = p['rect']

            if abs(r.width - src_page.rect.width) <= 2 and abs(r.height - src_page.rect.height) <= 2:

                logger.debug(f"[HEAD_TO_TAIL_DEBUG] SKIPPING bg rect: {r}")

                continue # Skip background rect

            filtered.append(p)

        if filtered:

            valid_paths = filtered

        logger.debug(f"[HEAD_TO_TAIL_DEBUG] after filter: {len(valid_paths)} paths")

        if not valid_paths:

            return ({'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, {'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, None, None, None, None, "CUSTOM", {}, None)

        filtered = [p for p in valid_paths if abs(p['rect'].width - src_page.rect.width) > 2 or abs(p['rect'].height - src_page.rect.height) > 2]

        if not filtered: filtered = valid_paths

        # SSOT (die-shape-detection-ssot — R3.2): dùng CHUNG bộ chọn đường khuôn
        # `_select_from_paths` (chấm điểm kênh spot / màu bế / nét) như Detection,
        # THAY VÌ chỉ chọn path diện tích lớn nhất. Trước đây max-area chọn nhầm
        # mảng artwork khi nó lớn hơn đường khuôn → head-to-tail tính nesting theo
        # artwork (preview≠output). Nay bám đúng đường bế như UI/preview.
        from app.workers.die_detection import _select_from_paths, DetectionConfig

        _cfg = DetectionConfig()

        largest_path, _matched_by_spot, _matched_by_area = _select_from_paths(
            paths, src_page.rect, _cfg.die_channel_names, _cfg.die_colors, _cfg.die_color_tol
        )

        # Fallback an toàn: SSOT không có ứng viên → giữ hành vi cũ (path lớn nhất).
        if largest_path is None:
            largest_path = max(filtered, key=lambda p: p['rect'].width * p['rect'].height)

        logger.debug(f"[HEAD_TO_TAIL_DEBUG] largest_path rect={largest_path['rect']} items={len(largest_path.get('items',[]))}")

        # === VECTOR-ONLY PIPELINE ===

        # The cutline might be split across multiple paths (e.g. flower contour + text contour).

        # We group all paths that share the same stroke color as the largest path to capture the FULL cutline.

        target_color = largest_path.get('color')

        from shapely.ops import unary_union

        polys = []

        # Gộp mọi path KHÔNG-nền cùng màu với đường khuôn đã chọn (SSOT) để bắt
        # TRỌN cutline (contour + chi tiết). 'filtered' = paths đã loại nền full-page.
        # (Trước dùng 'target_paths'; biến đó đã bỏ khi chuyển sang _select_from_paths
        # — fix regression NameError khiến head-to-tail luôn rơi về CUSTOM.)
        for p in filtered:

            if p.get('color') == target_color:

                poly_part = _path_items_to_polygon(p.get('items', []))

                if poly_part and poly_part.is_valid and not poly_part.is_empty:

                    polys.append(poly_part)

        if not polys:

            return ({'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, {'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, None, None, None, None, "CUSTOM", {}, None)            

        poly = unary_union(polys)

        if poly.is_empty:

            return ({'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, {'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, None, None, None, None, "CUSTOM", {}, None)

        # Cần simplify sớm để chống nghẽn CPU cho các phép buffer/intersects sau này.
        poly = poly.simplify(2.0, preserve_topology=True)

        # Lưu polygon GỐC (chưa zoom) để trả về cho collision resolver

        poly_unscaled = poly

        # Scale polygon to match zoom factor for consistency with downstream calcs

        from shapely import affinity as _aff

        poly = _aff.scale(poly, xfact=zoom, yfact=zoom, origin=(0, 0))

        minx, miny, maxx, maxy = poly.bounds

        logger.debug(f"[HEAD_TO_TAIL] poly bounds=({minx:.1f},{miny:.1f},{maxx:.1f},{maxy:.1f}) w={maxx-minx:.1f} h={maxy-miny:.1f}")

        gap_px = gap_pt * zoom

        poly_dilated = poly.buffer(gap_px / 2.0, join_style=2)

        center = ((minx + maxx) / 2.0, (miny + maxy) / 2.0)

        # Shape classification — vector-based, port of Illustrator logic

        from app.workers.shape_classifier import classify_shape, ShapeType

        class_result = classify_shape(largest_path.get('items', []))

        shape_type = class_result['shape_type']

        shape_props = class_result['params']

        logger.debug(f"[HEAD_TO_TAIL] classify_shape: {shape_type.name} ({shape_type.value}), source={class_result['source']}, params={shape_props}")

        def calc_params(base_poly, base_dilated, rotated_dilated):

            """Tính tham số lồng ghép head-to-tail dùng thuật toán NFP chính xác.

            Thuật toán:

            1. Normalize cả 2 polygon (gốc + xoay 180°) về origin (0,0)

            2. Tại mỗi mức dy, dùng binary search tìm dx nhỏ nhất sao cho 2 tem KHÔNG giao nhau

            3. Tính dx_outer/dy_outer bằng cách kiểm tra lưới 2x2 thực tế

            """

            # Normalize base polygon (dilated) về origin

            b_minx, b_miny, b_maxx, b_maxy = base_dilated.bounds

            base_at_origin = affinity.translate(base_dilated, xoff=-b_minx, yoff=-b_miny)

            # Simplify để giảm số vertices → tăng tốc Shapely intersects() trong binary search

            # tolerance=2.0pt đủ an toàn cho in ấn và giảm số đỉnh mạnh tay
            base_at_origin = base_at_origin.simplify(2.0, preserve_topology=True)

            bw = b_maxx - b_minx

            bh = b_maxy - b_miny

            # Normalize rotated polygon (dilated) về origin

            r_minx, r_miny, r_maxx, r_maxy = rotated_dilated.bounds

            rot_at_origin = affinity.translate(rotated_dilated, xoff=-r_minx, yoff=-r_miny)

            rot_at_origin = rot_at_origin.simplify(2.0, preserve_topology=True)

            rw = r_maxx - r_minx

            step = 5.0  # Bước nhảy dọc ~ 1.7mm (tăng tốc độ x3.3 mà không làm mất độ chính xác cần thiết)
            best_area = float('inf')

            best_dx = bw + gap_px  # Fallback: không overlap

            best_dy = 0.0

            best_dx_outer = bw + gap_px

            best_dy_outer = bh + gap_px

            # Phase 1: Tại mỗi mức dy, tìm dx nhỏ nhất sao cho tem gốc + tem xoay 180° KHÔNG giao nhau

            candidates = []

            dy_range = np.arange(-bh + step, bh, step)

            for dy in dy_range:

                # Tem xoay 180° đặt tại (dx, dy) - cần tìm dx nhỏ nhất

                # Binary search: lo = overlap chắc chắn, hi = không overlap chắc chắn

                lo = -rw

                hi = bw + gap_px

                # Tìm dx nhỏ nhất sao cho không giao nhau
                safe_dx = hi
                for _ in range(12):
                    mid = (lo + hi) / 2.0
                    shifted = affinity.translate(rot_at_origin, xoff=mid, yoff=dy)
                    if base_at_origin.intersects(shifted):

                        lo = mid  # Vẫn giao → tăng dx

                    else:

                        safe_dx = mid

                        hi = mid  # Không giao → thử giảm dx

                if safe_dx < bw + gap_px:  # Chỉ giữ nếu thực sự overlap-saving

                    candidates.append((safe_dx, dy))

            if not candidates:

                logger.debug("[CALC_PARAMS] Không tìm được candidate nào — dùng grid thường")

                return {

                    'dx': bw / zoom,

                    'dy': 0,

                    'dx_outer': (bw + gap_px) / zoom,

                    'dy_outer': (bh + gap_px) / zoom

                }

            # Phase 2: Với mỗi candidate (dx, dy), xây cluster 2 tem và tính bước lặp

            sampled = candidates[::max(1, len(candidates)//40)]  # Lấy mẫu ~40 candidates

            all_results = []

            for dx, dy in sampled:

                # Tạo cluster: tem gốc + tem xoay tại (dx, dy)

                rot_placed = affinity.translate(rot_at_origin, xoff=dx, yoff=dy)

                cluster = base_at_origin.union(rot_placed)

                c_minx, c_miny, c_maxx, c_maxy = cluster.bounds

                c_w = c_maxx - c_minx

                c_h = c_maxy - c_miny

                # Tính dx_outer: khoảng cách tối thiểu giữa 2 cluster liền ngang

                # Binary search cho dx_step

                lo_dx = 0

                hi_dx = c_w + gap_px

                dx_step = hi_dx

                for _ in range(12):

                    mid = (lo_dx + hi_dx) / 2.0

                    shifted_cluster = affinity.translate(cluster, xoff=mid, yoff=0)

                    if cluster.intersects(shifted_cluster):

                        lo_dx = mid

                    else:

                        dx_step = mid

                        hi_dx = mid

                # Tính dy_outer: khoảng cách tối thiểu giữa 2 cluster liền dọc

                lo_dy = 0

                hi_dy = c_h + gap_px

                dy_step = hi_dy

                for _ in range(12):

                    mid = (lo_dy + hi_dy) / 2.0

                    shifted_cluster = affinity.translate(cluster, xoff=0, yoff=mid)

                    if cluster.intersects(shifted_cluster):

                        lo_dy = mid

                    else:

                        dy_step = mid

                        hi_dy = mid

                # Xác minh an toàn: Dựng lưới 2x2 và check TẤT CẢ các cặp tem

                test_polys = [

                    base_at_origin,

                    rot_placed,

                    affinity.translate(base_at_origin, xoff=dx_step, yoff=0),

                    affinity.translate(rot_placed, xoff=dx_step, yoff=0),

                    affinity.translate(base_at_origin, xoff=0, yoff=dy_step),

                    affinity.translate(rot_placed, xoff=0, yoff=dy_step),

                ]

                grid_safe = True

                for ti in range(len(test_polys)):

                    for tj in range(ti + 1, len(test_polys)):

                        try:

                            if test_polys[ti].intersects(test_polys[tj]):

                                inter = test_polys[ti].intersection(test_polys[tj])

                                if inter.area > 0.5:

                                    grid_safe = False

                                    break

                        except Exception:

                            pass

                    if not grid_safe:

                        break

                if not grid_safe:

                    # Nếu lưới 2x2 vẫn đè → tăng step thêm gap

                    dx_step += gap_px

                    dy_step += gap_px

                area = dx_step * dy_step

                all_results.append((area, dx, dy, dx_step, dy_step))

                if area < best_area:

                    best_area = area

                    best_dx = dx

                    best_dy = dy

                    best_dx_outer = dx_step

                    best_dy_outer = dy_step

            # Log top 5 candidates

            all_results.sort(key=lambda x: x[0])

            if logger.isEnabledFor(logging.DEBUG):
                for i, (a, dx, dy, dxs, dys) in enumerate(all_results[:5]):
                    logger.debug(f"[CALC_NFP] #{i+1} area={a:.0f} dx={dx/zoom:.1f} dy={dy/zoom:.1f} dx_step={dxs/zoom:.1f} dy_step={dys/zoom:.1f}")
            logger.debug(f"[CALC_NFP] WINNER: dx={best_dx/zoom:.1f} dy={best_dy/zoom:.1f} dx_outer={best_dx_outer/zoom:.1f} dy_outer={best_dy_outer/zoom:.1f}")

            return {

                'dx': best_dx / zoom,

                'dy': best_dy / zoom,

                'dx_outer': best_dx_outer / zoom,

                'dy_outer': best_dy_outer / zoom

            }

        # --- Shapely polygon for calc_params (cluster approach) ---

        poly_rotated = affinity.rotate(poly, 180, origin=center)

        poly_rotated_dilated = poly_rotated.buffer(gap_px / 2.0, join_style=2)

        p5_params = calc_params(poly, poly_dilated, poly_rotated_dilated)

        logger.debug(f"[HEAD_TO_TAIL] p5_params={p5_params}")

        b_minx, b_miny, b_maxx, b_maxy = poly.bounds

        w_px = b_maxx - b_minx

        h_px = b_maxy - b_miny

        # --- Specialized Math Layouts ---

        # We only use hardcoded row/col alternating math for perfect geometric shapes.

        # For irregular/auto-detected shapes (Hammer, Dumbbell, Custom, etc), we set these to None.

        # This forces the orchestrator to use the Shapely NFP 'head_to_tail' cluster, which guarantees zero overlap.

        p5_row_params = None

        p5_col_params = None

        if shape_type == ShapeType.RECTANGLE:

            p5_row_params = {

                'offset_x': 0,

                'row_h': (h_px + gap_px) / zoom,

                'step_x': (w_px + gap_px) / zoom

            }

        elif shape_type == ShapeType.CIRCLE_ELLIPSE:

            p5_row_params = {

                'offset_x': (w_px + gap_px) / 2.0 / zoom,

                'row_h': ((h_px + gap_px) / 2.0 * 1.732) / zoom,

                'step_x': (w_px + gap_px) / zoom

            }

        elif shape_type == ShapeType.HEXAGON:

            hex_ori = shape_props.get('hexOrientation', 'pointy-top' if w_px < h_px else 'flat-top')

            if hex_ori == 'flat-top':

                p5_col_params = {

                    'offset_y': (h_px + gap_px) / 2.0 / zoom,

                    'col_w': (w_px * 0.75 + gap_px) / zoom,

                    'step_y': (h_px + gap_px) / zoom

                }

            else:

                p5_row_params = {

                    'offset_x': (w_px + gap_px) / 2.0 / zoom,

                    'row_h': (h_px * 0.75 + gap_px) / zoom,

                    'step_x': (w_px + gap_px) / zoom

                }

        # 90° rotated versions

        poly90 = affinity.rotate(poly, -90, origin=center)

        poly90_dilated = poly90.buffer(gap_px / 2.0, join_style=2)

        # Xoay 180° quanh center của poly90 (không phải center gốc!)

        poly90_center = ((poly90.bounds[0] + poly90.bounds[2]) / 2.0, (poly90.bounds[1] + poly90.bounds[3]) / 2.0)

        poly90_rotated = affinity.rotate(poly90, 180, origin=poly90_center)

        poly90_rotated_dilated = poly90_rotated.buffer(gap_px / 2.0, join_style=2)

        p6_params = calc_params(poly90, poly90_dilated, poly90_rotated_dilated)

        logger.debug(f"[HEAD_TO_TAIL] p6_params={p6_params}")

        b90_minx, b90_miny, b90_maxx, b90_maxy = poly90.bounds

        w90_px = b90_maxx - b90_minx

        h90_px = b90_maxy - b90_miny

        p6_row_params = None

        p6_col_params = None

        if shape_type == ShapeType.RECTANGLE:

            p6_col_params = {

                'offset_y': 0,

                'col_w': (w90_px + gap_px) / zoom,

                'step_y': (h90_px + gap_px) / zoom

            }

        elif shape_type == ShapeType.CIRCLE_ELLIPSE:

            p6_col_params = {

                'offset_y': (h90_px + gap_px) / 2.0 / zoom,

                'col_w': ((w90_px + gap_px) / 2.0 * 1.732) / zoom,

                'step_y': (h90_px + gap_px) / zoom

            }

        elif shape_type == ShapeType.HEXAGON:

            hex_ori = shape_props.get('hexOrientation', 'pointy-top' if w90_px < h90_px else 'flat-top')

            if hex_ori == 'flat-top':

                p6_col_params = {

                    'offset_y': (h90_px + gap_px) / 2.0 / zoom,

                    'col_w': (w90_px * 0.75 + gap_px) / zoom,

                    'step_y': (h90_px + gap_px) / zoom

                }

            else:

                p6_row_params = {

                    'offset_x': (w90_px + gap_px) / 2.0 / zoom,

                    'row_h': (h90_px * 0.75 + gap_px) / zoom,

                    'step_x': (w90_px + gap_px) / zoom

                }

        else:

            p6_row_params = None

            p6_col_params = None

        return (p5_params, p6_params, p5_row_params, p6_row_params, p5_col_params, p6_col_params, shape_type.name, shape_props, poly_unscaled)

    except Exception as e:

        logger.warning(f"Error in true shape nesting overlap: {e}")

        return ({'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, {'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}, None, None, None, None, "CUSTOM", {}, None)




def _find_largest_die_path(page):

    """Extract the largest die-cut path from a page (shared helper).

    Ủy quyền sang die_detection.select_die_path (NGUỒN DUY NHẤT chọn-path — R3.1)
    để layout và detection chọn CÙNG một đường khuôn (kèm ưu tiên tên kênh khuôn).
    Import trễ để tránh phụ thuộc vòng.
    """

    try:

        from app.workers.die_detection import select_die_path, DetectionConfig

        return select_die_path(page, DetectionConfig().die_channel_names)

    except Exception:

        # Fallback an toàn: heuristic cũ nội bộ (giữ layout không sập nếu import lỗi).

        try:

            paths = page.extract_vector_paths()

        except Exception:

            return None

        if not paths:

            return None

        valid = [p for p in paths if p['rect'].width > 5 and p['rect'].height > 5]

        if not valid:

            return None

        filtered = [p for p in valid

                    if not (abs(p['rect'].width - page.rect.width) <= 2

                            and abs(p['rect'].height - page.rect.height) <= 2)]

        if filtered:

            valid = filtered

        stroke = [p for p in valid if p.get('type') == 's' or (p.get('fill') is None and p.get('color') is not None)]

        target = stroke if stroke else valid

        return max(target, key=lambda p: p['rect'].width * p['rect'].height)
