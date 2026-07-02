import math
import copy
from typing import List, Dict, Any, Tuple
from shapely.geometry import Polygon, box

MM_TO_PTS = 2.83464567

# ── Hằng số vùng cấm boong/ốc (đơn vị: mm trừ khi ghi rõ) ──
SAFETY_PADDING_MM = 3.0   # đệm an toàn quanh dấu boong để tem không sát mép
DEFAULT_MARGIN_MM = 7.0   # lề mặc định khi pont_config KHÔNG có marginX và caller cũng không truyền margins
MIN_OVERLAP_AREA_PT2 = 1.0  # diện tích giao tối thiểu (pt²) để coi là va chạm thật — bỏ qua "chạm" cực nhỏ do sai số


def _resolve_margin_pt(pont_config: Dict[str, Any], margins: Dict[str, float],
                       cfg_key: str, margins_key: str) -> float:
    """Lề (points) cho 1 cạnh, theo thứ tự ưu tiên:
       1) pont_config[cfg_key] (đơn vị mm) — nguồn chính, dùng cho hầu hết các luồng
       2) margins[margins_key] (đơn vị points) — fallback caller truyền vào
       3) DEFAULT_MARGIN_MM — chốt cuối
    """
    v = pont_config.get(cfg_key)
    if v is not None:
        return v * MM_TO_PTS
    if margins:
        mv = margins.get(margins_key)
        if mv is not None:
            return mv  # margins đã ở points
    return DEFAULT_MARGIN_MM * MM_TO_PTS


def calculate_forbidden_zones(pont_config: Dict[str, Any], margins: Dict[str, float], sheet_w: float, sheet_h: float) -> List[box]:
    """
    Tính 4 vùng cấm ở góc dựa trên pont_config.
    Trả về danh sách shapely box (Top-Left, Top-Right, Bottom-Left, Bottom-Right).
    Toạ độ tính bằng points (gốc 0,0 ở đáy-trái).

    `margins` (points) dùng làm FALLBACK lề khi pont_config thiếu marginTop/Bottom/Left/Right.
    """
    if not pont_config or pont_config.get('disableCollision', False):
        return []
    
    pont_type = pont_config.get('shape', 'circle')
    mark_size_mm = pont_config.get('size', 5.0)
    safety_padding_mm = SAFETY_PADDING_MM
    
    radius_mm = mark_size_mm / 2.0 + safety_padding_mm
    radius_pt = radius_mm * MM_TO_PTS
    
    # Tính tâm chính xác của dấu boong. Tham chiếu nup_engine:
    #   cx_L = m_left + radius_mark; cx_R = sheet_w - m_right - radius_mark
    #   cy_T = m_top + radius_mark;  cy_B = sheet_h - m_bot - radius_mark
    
    mark_r_pt = (mark_size_mm / 2.0) * MM_TO_PTS
    
    margins = margins or {}
    m_top = _resolve_margin_pt(pont_config, margins, 'marginTop', 'top')
    m_bot = _resolve_margin_pt(pont_config, margins, 'marginBottom', 'bottom')
    m_left = _resolve_margin_pt(pont_config, margins, 'marginLeft', 'left')
    m_right = _resolve_margin_pt(pont_config, margins, 'marginRight', 'right')
    
    cx_L = m_left + mark_r_pt
    cx_R = sheet_w - m_right - mark_r_pt
    cy_T = sheet_h - (m_top + mark_r_pt)  # Note: y is bottom-up in pont_collision space!
    cy_B = m_bot + mark_r_pt
    
    from shapely.geometry import Point
    
    zones = []
    
    if pont_type == 'circle':
        # Tạo polygon hình tròn cho 4 góc
        zones.append(Point(cx_L, cy_T).buffer(radius_pt)) # Top-Left
        zones.append(Point(cx_R, cy_T).buffer(radius_pt)) # Top-Right
        zones.append(Point(cx_L, cy_B).buffer(radius_pt)) # Bottom-Left
        zones.append(Point(cx_R, cy_B).buffer(radius_pt)) # Bottom-Right
    else:
        # For L-shapes, approximate with a square box around the center
        # Since safety padding is added, a square of size (mark_size + 2*safety) is sufficient
        box_size = (mark_size_mm + 2 * safety_padding_mm) * MM_TO_PTS
        half_box = box_size / 2.0
        zones.append(box(cx_L - half_box, cy_T - half_box, cx_L + half_box, cy_T + half_box))
        zones.append(box(cx_R - half_box, cy_T - half_box, cx_R + half_box, cy_T + half_box))
        zones.append(box(cx_L - half_box, cy_B - half_box, cx_L + half_box, cy_B + half_box))
        zones.append(box(cx_R - half_box, cy_B - half_box, cx_R + half_box, cy_B + half_box))
        
    return zones

def compute_packer_exclude_zones(pont_config, sheet_w, sheet_h, usable_w, usable_h,
                                 margin_left_pt, margin_bottom_pt, gap):
    """Quy đổi vùng cấm boong (pont) sang toạ độ PACKER (gốc góc trên-trái vùng in,
    y hướng XUỐNG) để bin-pack LOẠI vùng cấm NGAY lúc xếp (thay vì xếp xong mới xóa).

    NGUỒN CHÂN LÝ DUY NHẤT — dùng CHUNG cho cả preview (/preview-layout) lẫn output
    (cnc_render) → preview luôn KHỚP output. Trả về List[(px, py, zw, zh)] (points)
    hoặc [] nếu không có boong / tắt va chạm.
    """
    if (not pont_config or pont_config.get('disableCollision', False)
            or not sheet_w or not sheet_h):
        return []
    margins = {
        'top': pont_config.get('marginTop') * MM_TO_PTS if pont_config.get('marginTop') is not None else margin_bottom_pt,
        'bottom': pont_config.get('marginBottom') * MM_TO_PTS if pont_config.get('marginBottom') is not None else margin_bottom_pt,
        'left': pont_config.get('marginLeft') * MM_TO_PTS if pont_config.get('marginLeft') is not None else margin_left_pt,
        'right': pont_config.get('marginRight') * MM_TO_PTS if pont_config.get('marginRight') is not None else margin_left_pt,
    }
    try:
        zones = calculate_forbidden_zones(pont_config, margins, sheet_w, sheet_h)
    except Exception:
        return []
    if not zones:
        return []
    gap_buf = (gap or 0) / 2.0
    out = []
    for z in zones:
        # z: Shapely box/polygon toạ độ PDF tờ (gốc đáy-trái, y lên). .bounds → (minx,miny,maxx,maxy)
        zminx, zminy, zmaxx, zmaxy = z.bounds
        zw = zmaxx - zminx
        zh = zmaxy - zminy
        # PDF tờ → packer (gốc góc trên-trái vùng in, y xuống)
        px = zminx - margin_left_pt
        py = usable_h - (zminy - margin_bottom_pt + zh)
        # Nới vùng cấm theo nửa gap để tem không sát mép boong
        px -= gap_buf
        py -= gap_buf
        zw += gap_buf * 2
        zh += gap_buf * 2
        out.append((px, py, zw, zh))
    return out


def build_shapely_polygon_from_paths(paths, page_rect=None) -> Polygon:
    """Extract a shapely Polygon from PDF paths, ignoring background rectangles."""
    valid_paths = [p for p in paths if p.get('rect') and p['rect'].width > 5 and p['rect'].height > 5]
    
    if page_rect:
        # Filter out paths that cover the entire page (backgrounds/bleeds)
        filtered = []
        for p in valid_paths:
            r = p['rect']
            if abs(r.width - page_rect.width) <= 2 and abs(r.height - page_rect.height) <= 2:
                continue # Skip background rect
            filtered.append(p)
        if filtered:
            valid_paths = filtered
            
    if not valid_paths:
        return None
        
    largest_path = max(valid_paths, key=lambda p: p['rect'].width * p['rect'].height)

    # P1 FIX: dùng bộ trích sample bezier chuẩn (_path_items_to_polygon) thay vì append
    # thẳng các điểm — bản cũ lấy CẢ điểm điều khiển bezier làm đỉnh polygon → phình ~15%
    # diện tích ở hướng chéo cho tem bo tròn (đo thật) → xóa OAN tem gần pont góc.
    # _path_items_to_polygon sample đường cong + gộp đa subpath (unary_union).
    try:
        from app.workers.nup_diecut import _path_items_to_polygon
        poly = _path_items_to_polygon(largest_path.get('items', []))
        if poly is not None and not poly.is_empty:
            if not poly.is_valid:
                poly = poly.buffer(0)
            return poly
    except Exception:
        pass
    return None

def get_item_polygon(item: Dict, base_poly: Polygon, skip_transform: bool = False) -> Polygon:
    # P4 (đã kiểm): CỐ Ý không xử lý mirror. Đường render live (nup_artwork.place_one_artwork)
    # luôn nhận mirror_x=mirror_y=False; duplex mặt sau được xử lý bằng mirror abs_x + TOGGLE
    # isRotated180 NGAY trên placement (nup_process_chunk:445-453) — cùng các cờ mà collision đọc.
    # → collision và render dùng chung cờ, không bên nào mirror thật → đã nhất quán vị trí/hướng.
    from shapely.affinity import translate, rotate
    
    # Auto-detect math-created polygons (centered at origin, symmetric bounds)
    # e.g. circle/ellipse created via Point(0,0).buffer() with scale
    f_minx, f_miny, f_maxx, f_maxy = base_poly.bounds
    base_cx = (f_minx + f_maxx) / 2.0
    base_cy = (f_miny + f_maxy) / 2.0
    is_origin_centered = abs(base_cx) < 0.01 and abs(base_cy) < 0.01
    
    if skip_transform or is_origin_centered:
        # base_poly is already centered at origin with correct dimensions (e.g. math ellipse)
        # Only translate to final position — no Y-flip, no rotation needed
        iw = item.get('width', 0)
        ih = item.get('height', 0)
        item_cx = item.get('abs_x', 0) + iw / 2.0
        item_cy = item.get('abs_y', 0) + ih / 2.0
        return translate(base_poly, xoff=item_cx, yoff=item_cy)
    
    # 1. Translate base_poly so its center is at (0, 0)
    centered_poly = translate(base_poly, xoff=-base_cx, yoff=-base_cy)
    
    # Convert from Top-Down (PDF coordinate space) to Bottom-Up (pont_collision) BEFORE rotating
    from shapely.affinity import scale
    centered_poly = scale(centered_poly, xfact=1.0, yfact=-1.0, origin=(0, 0))
    
    # 2. Apply rotation if needed
    # Note: placement dicts store rotation flags inside item['cell'], not at top level
    cell = item.get('cell', item)  # fallback to item itself if no nested cell
    angle = 0
    if cell.get('isRotated', False) or cell.get('isRotated90', False) or item.get('isRotated', False):
        angle += 90
    if cell.get('isRotated180', False) or item.get('isRotated180', False):
        angle += 180
        
    if angle != 0:
        centered_poly = rotate(centered_poly, angle, origin=(0, 0))
        
    # 3. Translate to the final center position in the layout
    iw = item.get('width', 0)
    ih = item.get('height', 0)
    item_cx = item.get('abs_x', 0) + iw / 2.0
    item_cy = item.get('abs_y', 0) + ih / 2.0
    
    final_poly = translate(centered_poly, xoff=item_cx, yoff=item_cy)
    return final_poly

def detect_collisions(layout_items: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_h: float) -> List[int]:
    """
    Detect which layout items collide with the forbidden zones.
    Returns list of indices of collided items.
    """
    if not zones or not layout_items:
        return []
    
    collided_indices = []
    
    for i, item in enumerate(layout_items):
        item_box = box(item['abs_x'], item['abs_y'], item['abs_x'] + item['width'], item['abs_y'] + item['height'])
        
        collision_detected = False
        for z in zones:
            if item_box.intersects(z):
                if base_poly is not None:
                    poly_shifted = get_item_polygon(item, base_poly)
                    if poly_shifted.intersects(z):
                        collision_detected = True
                        break
                else:
                    collision_detected = True
                    break
        
        if collision_detected:
            collided_indices.append(i)
    
    return collided_indices

def get_placements_bbox(placements: List[Dict]) -> Tuple[float, float, float, float]:
    if not placements:
        return 0, 0, 0, 0
    min_x = min(p['abs_x'] for p in placements)
    min_y = min(p['abs_y'] for p in placements)
    max_x = max(p['abs_x'] + p['width'] for p in placements)
    max_y = max(p['abs_y'] + p['height'] for p in placements)
    return min_x, min_y, max_x, max_y

def apply_shift(placements: List[Dict], dx: float, dy: float) -> List[Dict]:
    # Shallow copy mỗi dict (chỉ đổi abs_x/abs_y/original_cell_y) thay vì deepcopy toàn
    # bộ (gồm subdict 'cell') — apply_shift bị gọi tới 961×/hàng nên deepcopy là gánh
    # nặng. 'cell' KHÔNG bị sửa ở downstream nên chia sẻ tham chiếu là an toàn (kết quả
    # y hệt). original_cell_y top-down nên cộng y (bottom-up) = trừ original_cell_y.
    new_placements = []
    for p in placements:
        np = dict(p)
        np['abs_x'] = p['abs_x'] + dx
        np['abs_y'] = p['abs_y'] + dy
        np['original_cell_y'] = p['original_cell_y'] - dy
        new_placements.append(np)
    return new_placements

def check_internal_collision(row_items: List[Dict], other_items: List[Dict], base_poly: Polygon, safety_buffer_pt: float = 0.0, other_polys: List[Polygon] = None) -> bool:
    """`other_polys`: polygon các tem hàng-khác đã DỰNG SẴN. Khi quét nhiều phép dịch
    của cùng một hàng, các tem khác KHÔNG đổi → truyền sẵn để khỏi dựng lại mỗi lần
    (trước đây dựng lại 961× gây O(N²) Shapely → 30s). Kết quả không đổi."""
    if not base_poly:
        # Fallback to AABB if no polygon
        for r_item in row_items:
            rb = box(r_item['abs_x'], r_item['abs_y'], r_item['abs_x'] + r_item['width'], r_item['abs_y'] + r_item['height'])
            if safety_buffer_pt > 0:
                rb = rb.buffer(safety_buffer_pt)
            for o_item in other_items:
                ob = box(o_item['abs_x'], o_item['abs_y'], o_item['abs_x'] + o_item['width'], o_item['abs_y'] + o_item['height'])
                if rb.intersects(ob):
                    # Shrink AABB slightly to avoid false positive touches
                    if rb.intersection(ob).area > MIN_OVERLAP_AREA_PT2:
                        return True
        return False

    r_polys = []
    for r in row_items:
        p = get_item_polygon(r, base_poly)
        if safety_buffer_pt > 0:
            p = p.buffer(safety_buffer_pt)
        r_polys.append(p)

    if other_polys is None:
        other_polys = [get_item_polygon(o, base_poly) for o in other_items]

    for rp in r_polys:
        for op in other_polys:
            if rp.intersects(op):
                if rp.intersection(op).area > MIN_OVERLAP_AREA_PT2: # Ignore tiny touches
                    return True
    return False

def try_row_scenario(row_items: List[Dict], indices_to_delete: List[int], other_items: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_w: float, sheet_h: float, margins: Dict[str, float], layout_bbox: Tuple[float,float,float,float] = None) -> List[Dict]:
    import copy
    new_row = [p for i, p in enumerate(row_items) if i not in indices_to_delete]
    if not new_row:
        return []
        
    safety_buffer = 0  # Solver gap already provides clearance; extra buffer causes false positives in interlock layouts
    
    # Use layout_bbox (actual bounds of all items) for OOB check instead of pont margins.
    # Pont margins define where marks sit, NOT where items can be placed.
    if layout_bbox:
        bounds_min_x, bounds_min_y, bounds_max_x, bounds_max_y = layout_bbox
    else:
        bounds_min_x = margins.get('left', 0)
        bounds_min_y = margins.get('bottom', 0)
        bounds_max_x = sheet_w - margins.get('right', 0)
        bounds_max_y = sheet_h - margins.get('top', 0)
    
    best_shifted = None
    min_dist = float('inf')

    # Polygon các tem hàng-khác bất biến qua mọi phép dịch của hàng hiện tại. Dựng
    # LAZY + nhớ kết quả: chỉ tạo ở lần ĐẦU TIÊN thực sự cần (sau khi 1 phép dịch đã
    # qua bounds+zone), tránh vừa dựng lại 961× (cũ) vừa dựng-thừa-khi-không-cần.
    _other_polys_holder = []  # [list] sau khi tính; rỗng = chưa tính
    def _get_other_polys():
        if not base_poly:
            return None
        if not _other_polys_holder:
            _other_polys_holder.append([get_item_polygon(o, base_poly) for o in other_items])
        return _other_polys_holder[0]

    # Search for shifts to clear constraints.
    # Prioritize horizontal centering if it is safe (preserves grid aesthetics).
    # Otherwise fallback to minimal Euclidean distance shift (preserves honeycomb nesting).
    shifts_to_try = []
    
    orig_min_x, _, orig_max_x, _ = get_placements_bbox(new_row)
    row_w = orig_max_x - orig_min_x
    usable_min_x = bounds_min_x
    usable_max_x = bounds_max_x
    target_min_x = usable_min_x + (usable_max_x - usable_min_x - row_w) / 2.0
    center_dx = target_min_x - orig_min_x

    # P2: chỉ căn-giữa khi đây là điều chỉnh NHỎ (hàng lưới mất 1 tem mép). Với layout SO LE
    # (tạ tay/hex) mỗi mức y là "hàng mỏng" trải ngang; căn-giữa riêng nó = teleport ngang lớn
    # → lệch canh cột với các mức y trên/dưới (phá interlock). Khi center_dx > ~1 bề rộng tem thì
    # bỏ căn-giữa → rơi xuống tìm phép dịch tối thiểu (giữ canh, thường dịch 0).
    row_ref_w = max((p['width'] for p in new_row), default=0.0)
    if 0.5 * MM_TO_PTS < abs(center_dx) <= row_ref_w + 0.5 * MM_TO_PTS:
        shifts_to_try.append((center_dx, 0.0, True))
        
    steps = [0]
    for i in range(1, 16):
        steps.append(i)
        steps.append(-i)
        
    for dx_mm in steps:
        for dy_mm in steps:
            shifts_to_try.append((dx_mm * MM_TO_PTS, dy_mm * MM_TO_PTS, False))
            
    best_shifted = None
    min_dist = float('inf')
    
    for dx, dy, is_center in shifts_to_try:
        dist = dx**2 + dy**2
        
        if not is_center and dist >= min_dist:
            continue
            
        shifted_row = apply_shift(new_row, dx, dy)
        
        # Check bounds using actual layout bbox (not pont margins)
        sm_min_x, sm_min_y, sm_max_x, sm_max_y = get_placements_bbox(shifted_row)
        if (sm_min_x < bounds_min_x - 0.5 or 
            sm_max_x > bounds_max_x + 0.5 or 
            sm_min_y < bounds_min_y - 0.5 or 
            sm_max_y > bounds_max_y + 0.5):
            continue
            
        # Check zones
        if detect_collisions(shifted_row, zones, base_poly, base_rect_pts, sheet_h):
            continue
            
        # Check internal collisions (ensuring safe gap)
        if check_internal_collision(shifted_row, other_items, base_poly, safety_buffer, other_polys=_get_other_polys()):
            continue
            
        if is_center:
            return shifted_row
            
        best_shifted = shifted_row
        min_dist = dist
        
    return best_shifted

def _try_whole_block_shift(placements: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_w: float, sheet_h: float, margins: Dict[str, float]) -> List[Dict]:
    """Dịch CẢ KHỐI (mọi tem cùng một vector) ra xa các góc va chạm để GIỮ TRỌN tem (không xóa).

    Chỉ nhận phép dịch khiến HẾT va chạm VÀ khối vẫn nằm trong vùng in. Trả phép dịch nhỏ nhất,
    hoặc None nếu không có (vd va chạm 2 góc đối nhau, hoặc khối đã kín khổ). Khôi phục logic
    'zoneSet → canh về phía đối diện, giữ nguyên N tem' của Illustrator gốc (bị lược khi port)."""
    bmin_x, bmin_y, bmax_x, bmax_y = get_placements_bbox(placements)
    lo_x = margins.get('left', 0.0); hi_x = sheet_w - margins.get('right', 0.0)
    lo_y = margins.get('bottom', 0.0); hi_y = sheet_h - margins.get('top', 0.0)
    # khoảng dịch hợp lệ để khối không tràn vùng in
    min_dx, max_dx = lo_x - bmin_x, hi_x - bmax_x
    min_dy, max_dy = lo_y - bmin_y, hi_y - bmax_y
    steps = [0] + [v for k in range(1, 21) for v in (k, -k)]  # tới ±20mm
    cands = []
    for dx_mm in steps:
        dx = dx_mm * MM_TO_PTS
        if dx < min_dx - 0.5 or dx > max_dx + 0.5:
            continue
        for dy_mm in steps:
            dy = dy_mm * MM_TO_PTS
            if dy < min_dy - 0.5 or dy > max_dy + 0.5:
                continue
            cands.append((dx * dx + dy * dy, dx, dy))
    cands.sort()  # thử phép dịch nhỏ trước
    for _, dx, dy in cands:
        if abs(dx) < 1e-6 and abs(dy) < 1e-6:
            continue  # (0,0) đã va chạm
        shifted = apply_shift(placements, dx, dy)
        if not detect_collisions(shifted, zones, base_poly, base_rect_pts, sheet_h):
            return shifted
    return None


def _rotate_pair_180(placements: List[Dict], idxs: List[int], sheet_h: float) -> List[Dict]:
    """Xoay 180° CỤC BỘ một nhóm tem (1 cặp hàng/cột) quanh tâm bbox của RIÊNG nhóm + toggle
    isRotated180. Footprint nhóm không đổi → không đè phần còn lại; chỉ đảo nội bộ cặp (đưa cạnh
    thụt / hàng thưa ra mép). Cập nhật abs_x/abs_y (collision) và original_cell_y (render)."""
    xs0 = min(placements[i]['abs_x'] for i in idxs)
    ys0 = min(placements[i]['abs_y'] for i in idxs)
    xs1 = max(placements[i]['abs_x'] + placements[i]['width'] for i in idxs)
    ys1 = max(placements[i]['abs_y'] + placements[i]['height'] for i in idxs)
    sx, sy = xs0 + xs1, ys0 + ys1
    iset = set(idxs)
    out = []
    for i, p in enumerate(placements):
        if i not in iset:
            out.append(p)
            continue
        q = dict(p)
        q['abs_x'] = sx - (p['abs_x'] + p['width'])
        q['abs_y'] = sy - (p['abs_y'] + p['height'])
        q['original_cell_y'] = sheet_h - q['abs_y'] - p['height']
        cell = p.get('cell')
        if isinstance(cell, dict):
            nc = dict(cell)
            nc['isRotated180'] = not nc.get('isRotated180', False)
            q['cell'] = nc
        if 'isRotated180' in p:
            q['isRotated180'] = not p.get('isRotated180', False)
        out.append(q)
    return out


def _creates_sticker_overlap(placements: List[Dict], base_poly: Polygon, changed_idxs: List[int]) -> bool:
    """True nếu BẤT KỲ tem trong changed_idxs ĐÈ (diện tích giao > 1pt²) lên tem khác — dùng polygon
    THẬT. Bắt buộc kiểm sau mỗi phép xoay cặp: xoay quanh tâm cặp có thể phá khớp lồng với hàng kế →
    sinh đè mà detect_collisions (chỉ đếm vùng cấm) KHÔNG thấy."""
    if base_poly is None:
        return True  # không có hình thật để kiểm an toàn → từ chối xoay (giữ nguyên, không mạo hiểm)
    boxes = [(p['abs_x'], p['abs_y'], p['abs_x'] + p['width'], p['abs_y'] + p['height']) for p in placements]
    cache: Dict[int, Any] = {}
    def _poly(i):
        if i not in cache:
            cache[i] = get_item_polygon(placements[i], base_poly)
        return cache[i]
    cset = set(changed_idxs)
    for i in changed_idxs:
        bi = boxes[i]
        for j in range(len(placements)):
            if j == i or (j in cset and j < i):
                continue
            bj = boxes[j]
            if bi[2] <= bj[0] or bi[0] >= bj[2] or bi[3] <= bj[1] or bi[1] >= bj[3]:
                continue  # AABB rời nhau
            pi, pj = _poly(i), _poly(j)
            if pi.intersects(pj) and pi.intersection(pj).area > 1.0:
                return True
    return False


def _interlocked_clusters(placements: List[Dict], axis: str, tol: float = 5.0) -> List[List[int]]:
    """Nhận diện các CẶP LỒNG thật: gom hàng (axis='row', theo y) hoặc cột (axis='col', theo x)
    thành cụm các nhóm có BBOX ĐÈ NHAU dọc trục → đó là 1 cặp lồng. Cụm tách rời (có khe) = ranh
    giới cặp. Mỗi cặp lồng rời các cặp khác nên xoay nó quanh tâm KHÔNG đụng cặp khác.
    Trả list cụm; mỗi cụm = (list index tem, số nhóm hàng/cột trong cụm)."""
    import collections as _c
    groups = _c.defaultdict(list)
    for i, p in enumerate(placements):
        key = round((p['abs_y'] if axis == 'row' else p['abs_x']) / tol) * tol
        groups[key].append(i)
    keys = sorted(groups)

    def _rng(idxs):
        if axis == 'row':
            return (min(placements[i]['abs_y'] for i in idxs),
                    max(placements[i]['abs_y'] + placements[i]['height'] for i in idxs))
        return (min(placements[i]['abs_x'] for i in idxs),
                max(placements[i]['abs_x'] + placements[i]['width'] for i in idxs))

    clusters = []  # (idxs, n_groups)
    cur_idx, cur_n, cur_hi = [], 0, None
    for k in keys:
        lo, hi = _rng(groups[k])
        if cur_idx and lo < cur_hi - 0.5:   # bbox đè nhóm trước → cùng cặp lồng
            cur_idx += groups[k]; cur_n += 1; cur_hi = max(cur_hi, hi)
        else:
            if cur_idx:
                clusters.append((cur_idx, cur_n))
            cur_idx, cur_n, cur_hi = list(groups[k]), 1, hi
    if cur_idx:
        clusters.append((cur_idx, cur_n))
    return clusters


def _cluster_unequal_groups(placements: List[Dict], idxs: List[int], axis: str = None, tol: float = 5.0) -> bool:
    """True nếu trong cụm lồng, số tem 2 HƯỚNG (isRotated180 up/down) KHÁC nhau (cả 2 đều có mặt).
    Đây là 'cặp lồng lệch số lượng' (= checkIfPentagonRowsAreEqual==false), đếm theo HƯỚNG chứ
    KHÔNG theo vị trí y/x:
      - ngũ giác: cặp 2 hàng up(4)+down(3) → 4≠3 → lệch.
      - tam giác: 1 hàng DUDUDU lẻ (6 xuôi + 5 ngược) → 6≠5 → lệch. (Hàng chẵn 3=3 → bằng.)
    Lệch → xoay 180° đổi được hướng tem ở mép vùng cấm; bằng → xoay = no-op → phải xóa."""
    n_a = sum(1 for i in idxs if (placements[i].get('cell') or {}).get('isRotated180', False))
    n_b = len(idxs) - n_a
    return n_a > 0 and n_b > 0 and n_a != n_b


def _try_local_pair_flips(placements: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_h: float) -> List[Dict]:
    """Xoay 180° CỤC BỘ trọn CẶP LỒNG (nhận theo bbox đè nhau) CHỨA tem va chạm → đưa hàng/cột ít
    tem (cạnh thụt) ra phía pont, GIỮ TRỌN tem. Vì các cặp lồng rời nhau, xoay 1 cặp không đụng cặp
    khác. Lặp tham lam: chỉ nhận phép xoay vừa GIẢM va chạm vùng cấm VỪA không sinh tem-đè-tem."""
    if base_poly is None:
        return placements  # không có hình thật → không xoay
    cur = placements
    cols_now = detect_collisions(cur, zones, base_poly, base_rect_pts, sheet_h)
    guard = 0
    while cols_now and guard < 12:
        guard += 1
        improved = False
        for axis in ('row', 'col'):
            clusters = _interlocked_clusters(cur, axis)
            idx2cl = {}
            for ci, (idxs, _n) in enumerate(clusters):
                for i in idxs:
                    idx2cl[i] = ci
            for ci in sorted({idx2cl[i] for i in cols_now if i in idx2cl}):
                idxs, n_groups = clusters[ci]
                # CHỈ xoay khi cặp lồng có 2 hàng/cột KHÁC số lượng (checkIfPentagonRowsAreEqual==false).
                # Bằng số lượng → đối xứng → xoay 180° vẫn va chạm (no-op) → để tầng sau xóa+canh.
                if not _cluster_unequal_groups(cur, idxs, axis):
                    continue
                cand = _rotate_pair_180(cur, idxs, sheet_h)
                cand_cols = detect_collisions(cand, zones, base_poly, base_rect_pts, sheet_h)
                if len(cand_cols) < len(cols_now) and not _creates_sticker_overlap(cand, base_poly, idxs):
                    cur, cols_now, improved = cand, cand_cols, True
                    break
            if improved:
                break
        if not improved:
            break
    return cur


def _has_any_sticker_overlap(placements: List[Dict], base_poly: Polygon) -> bool:
    """True nếu BẤT KỲ cặp tem nào ĐÈ nhau (diện tích giao > 1pt²). Dùng polygon thật khi
    có base_poly, ngược lại dùng AABB (bbox). Quét toàn cục — chỉ chạy 1 lần để verify
    kết quả reflow, nên O(N²) chấp nhận được."""
    n = len(placements)
    boxes = [(p['abs_x'], p['abs_y'], p['abs_x'] + p['width'], p['abs_y'] + p['height']) for p in placements]
    cache: Dict[int, Any] = {}
    def _poly(i):
        if i not in cache:
            cache[i] = get_item_polygon(placements[i], base_poly)
        return cache[i]
    for i in range(n):
        bi = boxes[i]
        for j in range(i + 1, n):
            bj = boxes[j]
            if bi[2] <= bj[0] + 0.01 or bi[0] >= bj[2] - 0.01 or bi[3] <= bj[1] + 0.01 or bi[1] >= bj[3] - 0.01:
                continue  # AABB rời nhau
            if base_poly is None:
                ox = min(bi[2], bj[2]) - max(bi[0], bj[0])
                oy = min(bi[3], bj[3]) - max(bi[1], bj[1])
                if ox * oy > MIN_OVERLAP_AREA_PT2:
                    return True
            else:
                pi, pj = _poly(i), _poly(j)
                if pi.intersects(pj) and pi.intersection(pj).area > MIN_OVERLAP_AREA_PT2:
                    return True
    return False


def _column_free_bands(col_x0: float, col_x1: float, zones: List[box],
                       region_lo: float, region_hi: float) -> List[Tuple[float, float]]:
    """Các BĂNG TRỐNG dọc [lo,hi] trong [region_lo,region_hi] sau khi loại các vùng cấm
    có x-extent giao với cột [col_x0,col_x1]. Sắp theo y tăng dần."""
    cuts = []
    for z in zones:
        zminx, zminy, zmaxx, zmaxy = z.bounds
        if zmaxx <= col_x0 + 0.5 or zminx >= col_x1 - 0.5:
            continue  # zone không phủ x của cột → không chắn
        lo = max(zminy, region_lo)
        hi = min(zmaxy, region_hi)
        if hi > lo:
            cuts.append((lo, hi))
    cuts.sort()
    merged: List[Tuple[float, float]] = []
    for lo, hi in cuts:
        if merged and lo <= merged[-1][1] + 0.01:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    bands = []
    cursor = region_lo
    for lo, hi in merged:
        if lo - cursor > 0.5:
            bands.append((cursor, lo))
        cursor = max(cursor, hi)
    if region_hi - cursor > 0.5:
        bands.append((cursor, region_hi))
    return bands


def _resolve_by_columns(placements: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_w: float, sheet_h: float, margins: Dict[str, float]) -> List[Dict]:
    """Giải va chạm theo CỘT (dải dọc). Với mỗi cột có tem chạm vùng cấm: tính băng trống
    dọc (giữa các vùng cấm phủ x của cột), GIỮ TỐI ĐA tem fit được, phân bố đều theo pitch
    gốc + CĂN GIỮA trong băng → xóa tối thiểu (vd cột 5 tem chạm 2 đầu: xóa 1, dồn 4 ra giữa,
    thay vì xóa 2). Cột KHÔNG va chạm giữ nguyên (bảo toàn lưới).

    Chỉ áp cho layout KHÔNG-lồng (CUSTOM/tròn/chữ nhật/lưới) — caller đã gate bằng has_flippable.
    Vì các cột tách rời theo x, dịch tem theo phương dọc trong 1 cột không thể đè cột khác; chỉ
    còn rủi ro đè nội-cột (khử bằng pitch>=h) → vẫn verify toàn cục cuối cùng.

    Trả layout mới nếu HẾT va chạm và KHÔNG sinh tem-đè; ngược lại None (caller rơi về row-based)."""
    if not placements:
        return []
    initial_cols = detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h)
    if not initial_cols:
        return placements

    layout_bbox = get_placements_bbox(placements)
    region_lo, region_hi = layout_bbox[1], layout_bbox[3]

    tol = 5.0
    col_keys: Dict[float, List[int]] = {}
    for i, p in enumerate(placements):
        key = round(p['abs_x'] / tol) * tol
        col_keys.setdefault(key, []).append(i)

    out: List[Dict] = []
    for key in sorted(col_keys):
        col_items = [placements[i] for i in col_keys[key]]
        col_items.sort(key=lambda p: p['abs_y'])

        col_collided = [k for k, p in enumerate(col_items)
                        if detect_collisions([p], zones, base_poly, base_rect_pts, sheet_h)]
        if not col_collided:
            out.extend(col_items)  # cột sạch → giữ nguyên
            continue

        col_x0 = min(p['abs_x'] for p in col_items)
        col_x1 = max(p['abs_x'] + p['width'] for p in col_items)
        h = max(p['height'] for p in col_items)
        ys = [p['abs_y'] for p in col_items]
        gaps = [ys[k + 1] - ys[k] - h for k in range(len(ys) - 1)]
        pos_gaps = [g for g in gaps if g > -0.5]
        gap = max(min(pos_gaps), 0.0) if pos_gaps else 0.0

        bands = _column_free_bands(col_x0, col_x1, zones, region_lo, region_hi)
        best = None  # (n_fit, band_lo, band_hi)
        for blo, bhi in bands:
            bh = bhi - blo
            if bh < h - 0.5:
                continue
            n_fit = int((bh + gap + 1e-6) // (h + gap)) if (h + gap) > 0 else 0
            n_fit = min(n_fit, len(col_items))
            if best is None or n_fit > best[0]:
                best = (n_fit, blo, bhi)
        if best is None or best[0] <= 0:
            return None  # cột không đặt nổi tem nào → bỏ chiến lược, để row-based xử lý
        n_fit, blo, bhi = best

        n_drop = len(col_items) - n_fit
        if n_drop > 0:
            # ưu tiên xóa tem đang va chạm; nếu còn dư xóa từ 2 đầu vào
            drop_order = list(col_collided) + [k for k in range(len(col_items)) if k not in col_collided]
            drop_set = set(drop_order[:n_drop])
            keep = [p for k, p in enumerate(col_items) if k not in drop_set]
        else:
            keep = col_items

        total = n_fit * h + (n_fit - 1) * gap
        start = blo + (bhi - blo - total) / 2.0
        for k, p in enumerate(keep):
            q = dict(p)
            new_y = start + k * (h + gap)
            q['abs_y'] = new_y
            q['original_cell_y'] = sheet_h - new_y - p['height']
            out.append(q)

    if detect_collisions(out, zones, base_poly, base_rect_pts, sheet_h):
        return None
    if _has_any_sticker_overlap(out, base_poly):
        return None
    return out


def smart_resolve_collisions(placements: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_w: float, sheet_h: float, margins: Dict[str, float]) -> List[Dict]:
    """Giải va chạm tem với VÙNG CẤM (pont/ốc 4 góc), ưu tiên GIỮ nhiều tem nhất.

    Thứ tự ưu tiên (chi tiết xem COLLISION_PLAYBOOK.md):
      1. Có CẶP LỒNG LỆCH HƯỚNG (trong cụm lồng, 2 hướng up/down khác số tem) → XOAY 180° cục bộ
         trọn cụm giáp vùng cấm → đưa hướng ít tem ra mép → giữ TRỌN tem. Chỉ nhận phép xoay vừa
         giảm va chạm vừa KHÔNG sinh tem-đè (kiểm bằng polygon thật).
      2. Xoay chưa hết → thử DỊCH CẢ KHỐI ra xa góc va chạm (giữ trọn).
      3. Còn lại (đối xứng/cân bằng/không lồng — tròn, chữ nhật, tam giác chẵn, cặp bằng nhau...)
         → xóa tối thiểu + canh giữa (_resolve_one_orientation).
    """
    if not placements:
        return []
    initial_cols = detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h)

    if not initial_cols:
        return placements

    # Chỉ xoay/dịch khi có CẶP LỒNG 2 hướng LỆCH số lượng (= checkIfPentagonRowsAreEqual==false).
    # Tròn/chữ nhật/tam giác-chẵn/cặp-bằng-nhau → không có → giữ hành vi cũ (xóa + canh giữa).
    has_flippable = any(_cluster_unequal_groups(placements, idxs, ax)
                        for ax in ('row', 'col')
                        for idxs, _n in _interlocked_clusters(placements, ax))
    # LỒNG thật = cụm có hàng/cột ĐÈ NHAU dọc trục (n_groups>=2) VÀ có XEN KẼ HƯỚNG (cả tem xuôi
    # lẫn tem lật 180° trong cùng cụm) — đặc trưng hình thang/bình hành/tam giác interlock (KỂ CẢ
    # đối xứng up=down). Bắt CẢ 2 trục → lồng NGANG lẫn lồng DỌC (hình thang xoay 90°/270°).
    # Điều kiện xen-kẽ-hướng loại được FALSE-POSITIVE: lưới CUSTOM 2 khối gần nhau theo y bị
    # _interlocked_clusters gộp chung nhưng KHÔNG có tem lật → không phải lồng.
    def _both_orientations(_idxs) -> bool:
        n_up = sum(1 for i in _idxs if (placements[i].get('cell') or {}).get('isRotated180', False))
        return 0 < n_up < len(_idxs)
    # Trục lồng: cụm theo 'col' đè nhau theo x → lồng NGANG (cột nest cột);
    #            cụm theo 'row' đè nhau theo y → lồng DỌC (hàng nest hàng).
    il_horizontal = any(_n >= 2 and _both_orientations(_idxs)
                        for _idxs, _n in _interlocked_clusters(placements, 'col'))
    il_vertical = any(_n >= 2 and _both_orientations(_idxs)
                      for _idxs, _n in _interlocked_clusters(placements, 'row'))
    has_interlock = il_horizontal or il_vertical

    # ── Layout LỒNG (hình thang/bình hành — ngang HOẶC dọc). Ưu tiên GIỮ TRỌN (xoay cụm / dịch cả
    # khối); bất khả kháng thì xóa tối thiểu + dồn-căn theo TRỤC SONG SONG với trục lồng:
    #   lồng NGANG → dồn theo HÀNG (dịch hàng theo x, giữ nest giữa các cột) — KHÔNG dồn cột dọc.
    #   lồng DỌC   → dồn theo CỘT (dịch cột theo y, giữ nest giữa các hàng) — KHÔNG dồn hàng ngang.
    # (Dồn sai trục = dịch vuông góc trục lồng → phá thế lồng đầu-to-đầu-nhỏ → tem đè nhau.)
    if has_flippable or has_interlock:
        # 1) Xoay 180° cục bộ cụm lồng lệch số lượng (chỉ hiệu quả khi up/down khác nhau).
        local = _try_local_pair_flips(placements, zones, base_poly, base_rect_pts, sheet_h)
        if not detect_collisions(local, zones, base_poly, base_rect_pts, sheet_h):
            return local
        # 2) Dịch CẢ KHỐI cứng vào vùng trống → giữ trọn tem, giữ thế lồng.
        block_shift = _try_whole_block_shift(local, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
        if block_shift is not None:
            return block_shift
        # 3) Xóa tối thiểu + dồn-căn theo TRỤC AN TOÀN (song song trục lồng).
        if il_vertical and not il_horizontal:
            out = _resolve_by_columns(local, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
            if out is None:
                out = _resolve_one_orientation(local, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
        else:
            out = _resolve_one_orientation(local, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
        return out

    # ── KHÔNG lồng (lưới/tròn/chữ nhật/CUSTOM) → hành vi cũ: dồn cột / dồn hàng + canh giữa.
    col_out = _resolve_by_columns(placements, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
    row_out = _resolve_one_orientation(placements, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
    if col_out is not None and len(col_out) >= len(row_out):
        return col_out
    return row_out


def _resolve_one_orientation(placements: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_w: float, sheet_h: float, margins: Dict[str, float]) -> List[Dict]:
    """
    Intelligently find the minimal set of deletions to resolve all collisions.
    Operates row-by-row: deletes items, centers row, and pushes vertically to avoid internal overlap.
    """
    if not placements:
        return []

    initial_cols = detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h)
    if not initial_cols:
        return placements
    
    # Compute actual layout bounds (items can legitimately extend beyond pont margins)
    layout_bbox = get_placements_bbox(placements)
        
    # Group items into rows
    rows = {}
    tolerance = 5.0
    for p in placements:
        y_key = round(p['abs_y'] / tolerance) * tolerance
        if y_key not in rows:
            rows[y_key] = []
        rows[y_key].append(p)
        
    sorted_y_keys = sorted(rows.keys())
    final_placements = []

    for yk_idx, y_key in enumerate(sorted_y_keys):
        row_items = rows[y_key]
        # P3 FIX: other_items phản ánh trạng thái HIỆN TẠI — hàng đã xử lý dùng vị trí (có thể đã
        # dịch) trong final_placements; hàng chưa xử lý dùng vị trí gốc. Trước đây luôn dùng vị trí
        # gốc cho mọi hàng → khi dịch hàng sau, check va chạm nội bộ với hàng trước ĐÃ DỊCH bị sai
        # (dùng vị trí cũ) → 2 hàng góc cùng dịch về giữa có thể đè nhau mà không phát hiện.
        future_items = [p for k in sorted_y_keys[yk_idx + 1:] for p in rows[k]]
        other_items = final_placements + future_items
        
        # Detect collisions for this row only
        row_cols = []
        for i, item in enumerate(row_items):
            if detect_collisions([item], zones, base_poly, base_rect_pts, sheet_h):
                row_cols.append(i)
                
        if not row_cols:
            final_placements.extend(row_items)
            continue
            
        # Try deleting 1 item
        resolved = False
        for idx in row_cols:
            res = try_row_scenario(row_items, [idx], other_items, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins, layout_bbox)
            if res is not None:
                final_placements.extend(res)
                resolved = True
                break
                
        if resolved:
            continue
            
        import itertools
        # Try deleting 2 items
        if len(row_cols) >= 2:
            for combo in itertools.combinations(row_cols, 2):
                res = try_row_scenario(row_items, list(combo), other_items, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins, layout_bbox)
                if res is not None:
                    final_placements.extend(res)
                    resolved = True
                    break
                    
        if resolved:
            continue
            
        # Fallback: Delete all collided items in this row
        new_row = [p for i, p in enumerate(row_items) if i not in row_cols]
        # We don't shift the fallback, to avoid messing up the honeycomb further, 
        # since deleting both corners usually clears the zones without needing shift.
        final_placements.extend(new_row)
        
    return final_placements
