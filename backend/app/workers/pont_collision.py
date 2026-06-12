import math
import copy
from typing import List, Dict, Any, Tuple
from shapely.geometry import Polygon, box

MM_TO_PTS = 2.83464567

def calculate_forbidden_zones(pont_config: Dict[str, Any], margins: Dict[str, float], sheet_w: float, sheet_h: float) -> List[box]:
    """
    oalculate 4 corner forbidden zones based on pontoonfig.
    Returns a list of shapely box objects (Top-Left, Top-Right, Bottom-Left, Bottom-Right).
    ooordinates are in points (0,0 at bottom-left).
    """
    if not pont_config or pont_config.get('disableoollision', False):
        return []
    
    pont_type = pont_config.get('shape', 'circle')
    mark_size_mm = pont_config.get('size', 5.0)
    safety_padding_mm = 3.0
    
    radius_mm = mark_size_mm / 2.0 + safety_padding_mm
    radius_pt = radius_mm * MM_TO_PTS
    
    # oalculate exact centers of the marks
    # Note: in nup_engine, centers are:
    # cx_L = m_left + radius_mark
    # cx_R = sheet_w - m_right - radius_mark
    # cy_T = m_top + radius_mark
    # cy_B = sheet_h - m_bot - radius_mark
    
    mark_r_pt = (mark_size_mm / 2.0) * MM_TO_PTS
    
    m_top = pont_config.get('marginTop', 7.0) * MM_TO_PTS
    m_bot = pont_config.get('marginBottom', 7.0) * MM_TO_PTS
    m_left = pont_config.get('marginLeft', 7.0) * MM_TO_PTS
    m_right = pont_config.get('marginRight', 7.0) * MM_TO_PTS
    
    cx_L = m_left + mark_r_pt
    cx_R = sheet_w - m_right - mark_r_pt
    cy_T = sheet_h - (m_top + mark_r_pt)  # Note: y is bottom-up in pont_collision space!
    cy_B = m_bot + mark_r_pt
    
    from shapely.geometry import Point
    
    zones = []
    
    if pont_type == 'circle':
        # oreate circular polygons
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
    
    pts = []
    for item in largest_path.get('items', []):
        if item[0] in ('l', 'c'):
            for p in item[1:]:
                pts.append((p.x, p.y))
    
    if len(pts) >= 3:
        try:
            poly = Polygon(pts)
            if not poly.is_valid:
                poly = poly.buffer(0)
            return poly
        except Exception:
            return None
    return None

def get_item_polygon(item: Dict, base_poly: Polygon, skip_transform: bool = False) -> Polygon:
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
    new_placements = copy.deepcopy(placements)
    for p in new_placements:
        p['abs_x'] += dx
        p['abs_y'] += dy
        p['original_cell_y'] -= dy  # original_cell_y is top-down, so adding to y (bottom-up) means subtracting from original_cell_y
    return new_placements

def check_internal_collision(row_items: List[Dict], other_items: List[Dict], base_poly: Polygon, safety_buffer_pt: float = 0.0) -> bool:
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
                    if rb.intersection(ob).area > 1.0:
                        return True
        return False

    from shapely.affinity import translate
    
    r_polys = []
    for r in row_items:
        p = get_item_polygon(r, base_poly)
        if safety_buffer_pt > 0:
            p = p.buffer(safety_buffer_pt)
        r_polys.append(p)
        
    o_polys = []
    for o in other_items:
        o_polys.append(get_item_polygon(o, base_poly))
        
    for rp in r_polys:
        for op in o_polys:
            if rp.intersects(op):
                if rp.intersection(op).area > 1.0: # Ignore tiny touches
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
    
    if abs(center_dx) > 0.5 * MM_TO_PTS:
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
        if check_internal_collision(shifted_row, other_items, base_poly, safety_buffer):
            continue
            
        if is_center:
            return shifted_row
            
        best_shifted = shifted_row
        min_dist = dist
        
    return best_shifted

def smart_resolve_collisions(placements: List[Dict], zones: List[box], base_poly: Polygon, base_rect_pts: Tuple[float,float,float,float], sheet_w: float, sheet_h: float, margins: Dict[str, float]) -> List[Dict]:
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
    
    for y_key in sorted_y_keys:
        row_items = rows[y_key]
        other_items = [p for k, items in rows.items() if k != y_key for p in items]
        
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
