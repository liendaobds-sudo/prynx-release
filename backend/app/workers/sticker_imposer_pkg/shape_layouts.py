"""Sticker Imposer — Shape-specific layout solvers (hexagon, pentagon, triangle, trapezoid, L-shape).

Rust-accelerated via pdfcompare_native."""
import math
import logging
from typing import List, Dict, Any

try:
    import pdfcompare_native as _native
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

from .utils import MY_SCRIPT_TOLERANCE, calculate_items_bounding_box
from .grid_layouts import solve_grid_layout

logger = logging.getLogger(__name__)

def _py_solve_pointy_top_hex_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, is_rotated: bool = False) -> Dict[str, Any]:
    """Hexagon layout with pointy top. Staggered rows."""
    if item_w <= 0.05 or item_h <= 0.05:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'hex_pointy'}
        
    rx = item_w / 2.0
    ry = item_h / 2.0
    
    horizontal_step = item_w + gap_x
    vertical_step = (item_h * 0.75) + gap_y
    
    # Guard: bước nhảy ≤ 0 (gap âm bất thường) làm vòng tiling không tiến → treo.
    if horizontal_step <= 0 or vertical_step <= 0:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'hex_pointy'}
    
    items = []
    r = 0
    while True:
        cy = ry + (r * vertical_step)
        if cy - ry > usable_h + 0.001:
            break
            
        horizontal_offset = (horizontal_step / 2.0) if (r % 2 != 0) else 0.0
        
        c = 0
        while True:
            cx = rx + horizontal_offset + (c * horizontal_step)
            if cx - rx > usable_w + 0.001:
                break
                
            if cx + rx > usable_w + 0.001 or cy + ry > usable_h + 0.001:
                c += 1
                continue
                
            items.append({
                'c': c, 'r': r,
                'x': cx - rx,
                'y': cy - ry,
                'width': item_w,
                'height': item_h,
                'isRotated': is_rotated
            })
            c += 1
        r += 1
        
    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'hex_pointy'}
        
    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
        
    return {
        'totalItems': len(items),
        'items': items,
        'widthUsed': bb['width'],
        'heightUsed': bb['height'],
        'strategyUsed': 'hex_pointy'
    }

def _py_solve_flat_top_hex_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, is_rotated: bool = False) -> Dict[str, Any]:
    """Hexagon layout with flat top. Staggered columns."""
    if item_w <= 0.05 or item_h <= 0.05:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'hex_flat'}
        
    rx = item_w / 2.0
    ry = item_h / 2.0
    
    vertical_step = item_h + gap_y
    horizontal_step = (item_w * 0.75) + gap_x
    
    # Guard: bước nhảy ≤ 0 (gap âm bất thường) làm vòng tiling không tiến → treo.
    if horizontal_step <= 0 or vertical_step <= 0:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'hex_flat'}
    
    items = []
    c = 0
    while True:
        cx = rx + (c * horizontal_step)
        if cx - rx > usable_w + 0.001:
            break
            
        vertical_offset = (vertical_step / 2.0) if (c % 2 != 0) else 0.0
        
        r = 0
        while True:
            cy = ry + vertical_offset + (r * vertical_step)
            if cy - ry > usable_h + 0.001:
                break
                
            if cx + rx > usable_w + 0.001 or cy + ry > usable_h + 0.001:
                r += 1
                continue
                
            items.append({
                'c': c, 'r': r,
                'x': cx - rx,
                'y': cy - ry,
                'width': item_w,
                'height': item_h,
                'isRotated': is_rotated
            })
            r += 1
        c += 1
        
    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'hex_flat'}
        
    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
        
    return {
        'totalItems': len(items),
        'items': items,
        'widthUsed': bb['width'],
        'heightUsed': bb['height'],
        'strategyUsed': 'hex_flat'
    }

def _py_solve_advanced_pentagon_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any], is_rotated_90: bool = False, start_with_down: bool = False) -> Dict[str, Any]:
    """Pentagon staggered row layout with peak interlock."""
    if is_rotated_90:
        w_orig = item_h
        h_orig = item_w
    else:
        w_orig = item_w
        h_orig = item_h
        
    empty = {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'pentagon_advanced'}
    if w_orig <= 0 or h_orig <= 0 or usable_w < w_orig - 0.01 or usable_h < h_orig - 0.01:
        return empty
        
    peak_ratio = shape_props.get('peakHeightRatio', 0.25)
    orientation = shape_props.get('pentagonOrientation', 'up')
    
    if is_rotated_90:
        res = solve_advanced_pentagon_layout(usable_h, usable_w, item_w, item_h, gap_y, gap_x, shape_props, False, start_with_down)
        items = []
        for it in res['items']:
            items.append({
                'c': it['r'], 'r': it['c'],
                'x': it['y'], 'y': it['x'],
                'width': it['height'], 'height': it['width'],
                'isRotated': True,
                'isRotated180': it['isRotated180']
            })
        if items:
            bb = calculate_items_bounding_box(items)
            cx_off = -bb['minX']
            cy_off = -bb['minY']
            for it in items:
                it['x'] += cx_off
                it['y'] += cy_off
            return {'totalItems': len(items), 'items': items, 'widthUsed': bb['width'], 'heightUsed': bb['height'], 'strategyUsed': 'pentagon_advanced'}
        return empty

    peak_h = h_orig * max(0.0, min(peak_ratio, 1.0))
    base_h = h_orig - peak_h
    h_step = w_orig + gap_x
    
    # Guard: bước nhảy ngang/dọc ≤ 0 (gap âm) làm vòng tiling không tiến → treo.
    if h_step <= 0 or (base_h + gap_y) <= 0 or (h_orig + gap_y) <= 0:
        return empty
    
    items = []
    current_y = 0.0
    row_idx = 0
    
    while current_y + h_orig <= usable_h + 0.01:
        is_row_down = (row_idx % 2 == 0) if start_with_down else (row_idx % 2 != 0)
        is_rotated_180 = not is_row_down if orientation == 'down' else is_row_down
        
        is_stag = (row_idx % 2 != 0)
        h_off = (h_step / 2.0) if is_stag else 0.0
        
        c = 0
        while True:
            cx = w_orig / 2.0 + h_off + c * h_step
            if cx + w_orig / 2.0 > usable_w + 0.01:
                break
            items.append({
                'c': c, 'r': row_idx,
                'x': cx - w_orig / 2.0,
                'y': current_y,
                'width': w_orig, 'height': h_orig,
                'isRotated': False,
                'isRotated180': is_rotated_180
            })
            c += 1
            
        y_step = (base_h + gap_y) if is_row_down else (h_orig + gap_y)
        current_y += y_step
        row_idx += 1
        
    if not items:
        return empty
        
    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
        
    return {
        'totalItems': len(items),
        'items': items,
        'widthUsed': bb['width'],
        'heightUsed': bb['height'],
        'strategyUsed': 'pentagon_advanced'
    }

def _py_solve_advanced_triangle_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any], is_rotated_90: bool = False) -> Dict[str, Any]:
    """Perfect interlocking for triangles in any orientation."""
    apex = shape_props.get('triangleApex', 'up')
    empty = {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'triangle_advanced'}

    def get_is180_to_point(target_dir: str, original_apex: str, is_rot90: bool) -> bool:
        if is_rot90:
            dir_map = {'up': 'right', 'right': 'down', 'down': 'left', 'left': 'up'}
            curr = dir_map.get(original_apex, 'up')
        else:
            curr = original_apex
        if curr == target_dir: return False
        opposite = {'up': 'down', 'down': 'up', 'left': 'right', 'right': 'left'}
        if curr == opposite.get(target_dir): return True
        return False

    if is_rotated_90:
        dir_map = {'up': 'right', 'right': 'down', 'down': 'left', 'left': 'up'}
        effective_apex = dir_map.get(apex, 'up')
        w_orig = item_h
        h_orig = item_w
    else:
        effective_apex = apex
        w_orig = item_w
        h_orig = item_h

    if w_orig <= 0 or h_orig <= 0 or usable_w < w_orig - 0.01 or usable_h < h_orig - 0.01:
        return empty

    if effective_apex in ('left', 'right'):
        items = []
        current_x = 0.0
        c_idx = 0
        delta_w = shape_props.get('deltaW', 0)
        gap_mult = shape_props.get('gapMultiplierH', 1.0)
        
        # effectiveGap in the parallel direction
        h_step = w_orig + gap_x
        # effectiveGap in the perpendicular/sloped direction
        v_step = h_orig + gap_y * gap_mult + delta_w * 2.0
        
        # Guard: bước nhảy ≤ 0 (gap âm) làm vòng tiling không tiến → treo.
        if h_step <= 0 or v_step <= 0:
            return empty
        
        while current_x + w_orig <= usable_w + 0.01:
            is180_0 = get_is180_to_point('right', apex, is_rotated_90)
            r = 0
            while True:
                cy = r * v_step
                if cy + h_orig > usable_h + 0.01: break
                items.append({'c': c_idx, 'r': r, 'x': current_x, 'y': cy, 'width': w_orig, 'height': h_orig, 'isRotated': is_rotated_90, 'isRotated180': is180_0})
                r += 1
                
            is180_1 = get_is180_to_point('left', apex, is_rotated_90)
            r = 0
            while True:
                cy = (v_step / 2.0) + r * v_step
                if cy + h_orig > usable_h + 0.01: break
                items.append({'c': c_idx, 'r': r, 'x': current_x, 'y': cy, 'width': w_orig, 'height': h_orig, 'isRotated': is_rotated_90, 'isRotated180': is180_1})
                r += 1
                
            current_x += h_step
            c_idx += 1
            
    else:
        items = []
        current_y = 0.0
        r_idx = 0
        delta_w = shape_props.get('deltaW', 0)
        gap_mult = shape_props.get('gapMultiplierH', 1.0)
        
        v_step = h_orig + gap_y
        h_step = w_orig + gap_x * gap_mult + delta_w * 2.0
        
        # Guard: bước nhảy ≤ 0 (gap âm) làm vòng tiling không tiến → treo.
        if h_step <= 0 or v_step <= 0:
            return empty
        
        while current_y + h_orig <= usable_h + 0.01:
            is180_0 = get_is180_to_point('down', apex, is_rotated_90)
            c = 0
            while True:
                cx = c * h_step
                if cx + w_orig > usable_w + 0.01: break
                items.append({'c': c, 'r': r_idx, 'x': cx, 'y': current_y, 'width': w_orig, 'height': h_orig, 'isRotated': is_rotated_90, 'isRotated180': is180_0})
                c += 1
                
            is180_1 = get_is180_to_point('up', apex, is_rotated_90)
            c = 0
            while True:
                cx = (h_step / 2.0) + c * h_step
                if cx + w_orig > usable_w + 0.01: break
                items.append({'c': c, 'r': r_idx, 'x': cx, 'y': current_y, 'width': w_orig, 'height': h_orig, 'isRotated': is_rotated_90, 'isRotated180': is180_1})
                c += 1
                
            current_y += v_step
            r_idx += 1

    if not items: return empty
        
    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
        
    return {'totalItems': len(items), 'items': items, 'widthUsed': bb['width'], 'heightUsed': bb['height'], 'strategyUsed': 'triangle_advanced'}

def _py_solve_illustrator_trapezoid_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any] = None) -> Dict[str, Any]:
    """Match TypeScript: scale overhangs by origW/bbW, compare trap vs grid, pick best count."""
    if shape_props is None:
        shape_props = {}

    # --- Scale leftOH/rightOH exactly like TypeScript ---
    # TS: const leftOH = (parsedParams.leftOH || 0) * (usableW > 0 ? origW / (parsedParams.bbW || origW) : 1);
    bbW = shape_props.get('bbW', 0)
    scale = (item_w / bbW) if (usable_w > 0 and bbW > 0) else 1.0
    scaled_props = dict(shape_props)
    scaled_props['leftOH'] = shape_props.get('leftOH', 0) * scale
    scaled_props['rightOH'] = shape_props.get('rightOH', 0) * scale

    # Trapezoid interlock (both orientations, pick best)
    tr1 = solve_advanced_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, scaled_props, False)
    tr2 = solve_advanced_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, scaled_props, True)
    trap_best = tr1 if tr1['totalItems'] >= tr2['totalItems'] else tr2
    trap_rotated = tr1['totalItems'] < tr2['totalItems']

    # Basic grid (both orientations)
    g1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    g2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)

    # Pick absolute best
    best, is_rotated, strategy = trap_best, trap_rotated, 'trapezoid_interlock'
    if g1.get('totalItems', 0) > best.get('totalItems', 0):
        best, is_rotated, strategy = g1, False, 'grid'
    if g2.get('totalItems', 0) > best.get('totalItems', 0):
        best, is_rotated, strategy = g2, True, 'grid_rot'

    if best.get('totalItems', 0) == 0:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': strategy, '_main_rotated': is_rotated}

    # grid_rot (lưới xoay 90°, dims hoán đổi) → PHẢI đánh dấu isRotated lên từng ô.
    # solve_grid_layout không tự set cờ này; với các shape khác orchestrator ép ở vòng
    # post-select, nhưng 'trapezoid_illustrator' nằm trong danh sách loại trừ của vòng đó
    # → phải set TẠI ĐÂY, nếu không render đặt artwork sai hướng + collision dò sai góc.
    if strategy == 'grid_rot':
        for it in best['items']:
            it['isRotated'] = True

    return {
        'totalItems': best['totalItems'],
        'items': best['items'],
        'widthUsed': best['widthUsed'],
        'heightUsed': best['heightUsed'],
        'strategyUsed': strategy,
        '_main_rotated': is_rotated
    }

def _py_solve_advanced_trapezoid_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any], is_rotated_90: bool = False) -> Dict[str, Any]:
    """Trapezoid layout based on parallel base overhang interlocking."""
    empty = {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'trapezoid_advanced'}
    
    if is_rotated_90:
        eff_item_w = item_h
        eff_item_h = item_w
        eff_gap_x = gap_y
        eff_gap_y = gap_x
        is_horizontal = not shape_props.get('isHorizontal', True)
        left_oh = shape_props.get('rightOH', 0)
        right_oh = shape_props.get('leftOH', 0)
    else:
        eff_item_w = item_w
        eff_item_h = item_h
        eff_gap_x = gap_x
        eff_gap_y = gap_y
        is_horizontal = shape_props.get('isHorizontal', True)
        left_oh = shape_props.get('leftOH', 0)
        right_oh = shape_props.get('rightOH', 0)
    
    half_w = eff_item_w / 2.0
    half_h = eff_item_h / 2.0
    items = []

    if is_horizontal:
        step_a = eff_item_w - right_oh + eff_gap_x
        step_b = eff_item_w - left_oh + eff_gap_x
        step_y = eff_item_h + eff_gap_y

        num_rows = 1
        if step_y > 0:
            num_rows = 1 + int((usable_h - eff_item_h + 0.01) / step_y)

        for row in range(num_rows):
            cy = half_h + row * step_y
            if cy + half_h > usable_h + 0.01:
                break

            cx = half_w
            col = 0
            while cx + half_w <= usable_w + 0.01:
                items.append({
                    'c': col, 'r': row,
                    'x': cx - half_w,
                    'y': cy - half_h,
                    'width': eff_item_w,
                    'height': eff_item_h,
                    'isRotated': is_rotated_90,
                    'isRotated180': (col % 2 != 0)
                })
                cx += step_a if col % 2 == 0 else step_b
                col += 1
    else:
        step_a = eff_item_h - right_oh + eff_gap_y
        step_b = eff_item_h - left_oh + eff_gap_y
        step_x = eff_item_w + eff_gap_x

        num_cols = 1
        if step_x > 0:
            num_cols = 1 + int((usable_w - eff_item_w + 0.01) / step_x)

        for col in range(num_cols):
            cx = half_w + col * step_x
            if cx + half_w > usable_w + 0.01:
                break

            cy = half_h
            row = 0
            while cy + half_h <= usable_h + 0.01:
                items.append({
                    'c': col, 'r': row,
                    'x': cx - half_w,
                    'y': cy - half_h,
                    'width': eff_item_w,
                    'height': eff_item_h,
                    'isRotated': is_rotated_90,
                    'isRotated180': (row % 2 != 0)
                })
                cy += step_a if row % 2 == 0 else step_b
                row += 1

    if not items:
        return empty

    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off

    return {'totalItems': len(items), 'items': items, 'widthUsed': bb['width'], 'heightUsed': bb['height'], 'strategyUsed': 'trapezoid_advanced'}

def _py_solve_illustrator_parallelogram_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any] = None) -> Dict[str, Any]:
    """Match TypeScript calculateInterlockingParallelogramLayoutFn: 4-pass shift interlock, compare with grid."""
    if shape_props is None:
        shape_props = {}

    empty = {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'parallelogram', '_main_rotated': False}
    if item_w <= 0 or item_h <= 0:
        return empty

    # TS does NOT scale overhang for parallelogram (unlike trapezoid)
    oh_x = shape_props.get('overhangX', 0)
    oh_y = shape_props.get('overhangY', 0)

    best_items = []
    best_is_rotated = False

    # 4 passes: (orig/rot) × (interlock X / interlock Y)
    for pass_idx in range(4):
        is_rot = pass_idx >= 2
        interlock_x = pass_idx % 2 == 0

        cur_w = item_h if is_rot else item_w
        cur_h = item_w if is_rot else item_h
        cur_gap_h = gap_y if is_rot else gap_x
        cur_gap_v = gap_x if is_rot else gap_y
        cur_oh_x = oh_y if is_rot else oh_x
        cur_oh_y = oh_x if is_rot else oh_y

        half_w = cur_w / 2.0
        half_h = cur_h / 2.0
        items = []

        if interlock_x and cur_oh_x > 0.1:
            step_x = cur_w - cur_oh_x + cur_gap_h
            step_y = cur_h + cur_gap_v
            n_cols = 1
            if step_x > 0:
                n_cols = 1 + int((usable_w - cur_w + 0.01) / step_x)
            n_rows = 1
            if step_y > 0:
                n_rows = 1 + int((usable_h - cur_h + 0.01) / step_y)
            for row in range(n_rows):
                cy = half_h + row * step_y
                if cy + half_h > usable_h + 0.01:
                    break
                for col in range(n_cols):
                    cx = half_w + col * step_x
                    if cx + half_w > usable_w + 0.01:
                        break
                    items.append({
                        'c': col, 'r': row,
                        'x': cx - half_w, 'y': cy - half_h,
                        'width': cur_w, 'height': cur_h,
                        'isRotated': is_rot, 'isRotated180': col % 2 != 0
                    })
        elif not interlock_x and cur_oh_y > 0.1:
            step_x = cur_w + cur_gap_h
            step_y = cur_h - cur_oh_y + cur_gap_v
            n_cols = 1
            if step_x > 0:
                n_cols = 1 + int((usable_w - cur_w + 0.01) / step_x)
            n_rows = 1
            if step_y > 0:
                n_rows = 1 + int((usable_h - cur_h + 0.01) / step_y)
            for col in range(n_cols):
                cx = half_w + col * step_x
                if cx + half_w > usable_w + 0.01:
                    break
                for row in range(n_rows):
                    cy = half_h + row * step_y
                    if cy + half_h > usable_h + 0.01:
                        break
                    items.append({
                        'c': col, 'r': row,
                        'x': cx - half_w, 'y': cy - half_h,
                        'width': cur_w, 'height': cur_h,
                        'isRotated': is_rot, 'isRotated180': row % 2 != 0
                    })

        if len(items) > len(best_items):
            best_items = items
            best_is_rotated = is_rot

    # Center the interlock block (match TS: oX = (usableW - bb.width)/2 - bb.minX)
    if best_items:
        bb = calculate_items_bounding_box(best_items)
        o_x = (usable_w - bb['width']) / 2.0 - bb['minX']
        o_y = (usable_h - bb['height']) / 2.0 - bb['minY']
        for it in best_items:
            it['x'] += o_x
            it['y'] += o_y

    # Compare with basic grid (both orientations), pick best
    g1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    g2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)

    best, is_rotated, strategy = ({'totalItems': len(best_items), 'items': best_items, 'widthUsed': 0, 'heightUsed': 0} if best_items else empty), best_is_rotated, 'parallelogram_interlock'
    if best_items:
        bb_f = calculate_items_bounding_box(best_items)
        best['widthUsed'] = bb_f['width']
        best['heightUsed'] = bb_f['height']

    if g1.get('totalItems', 0) > best.get('totalItems', 0):
        best, is_rotated, strategy = g1, False, 'grid'
    if g2.get('totalItems', 0) > best.get('totalItems', 0):
        best, is_rotated, strategy = g2, True, 'grid_rot'

    if best.get('totalItems', 0) == 0:
        return empty

    return {
        'totalItems': best['totalItems'],
        'items': best['items'],
        'widthUsed': best['widthUsed'],
        'heightUsed': best['heightUsed'],
        'strategyUsed': strategy,
        '_main_rotated': is_rotated
    }


def _py_solve_l_shape_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, secondary_gap: float = None) -> Dict[str, Any]:
    """
    L-shape fill: main block (original orientation) + fill blocks (rotated) in remaining
    right and bottom space. Mirrors nup_engine.py optimal_auto logic adapted for die-cut.
    Tries both orientations as primary and picks highest yield.
    """
    split_gap = secondary_gap if secondary_gap is not None else max(gap_x, gap_y)  # Use user gap directly, no forced 5mm minimum

    def try_config(main_w, main_h, fill_w, fill_h, primary_rotated):
        max_grid = solve_grid_layout(usable_w, usable_h, main_w, main_h, gap_x, gap_y)
        best_yield = 0
        best_items = []
        best_w = 0.0
        best_h = 0.0

        max_cols = max_grid.get('cols', 0)
        max_rows = max_grid.get('rows', 0)
        if max_cols < 1 or max_rows < 1:
            return 0, [], 0.0, 0.0

        for reduce_c in range(min(2, max_cols)):
            for reduce_r in range(min(2, max_rows)):
                if reduce_c > 0 and reduce_r > 0:
                    continue  # Only reduce one dimension at a time
                tc = max(0, max_cols - reduce_c)
                tr = max(0, max_rows - reduce_r)
                if tc == 0 or tr == 0:
                    continue

                tbw = tc * main_w + max(0, tc - 1) * gap_x
                tbh = tr * main_h + max(0, tr - 1) * gap_y

                # Main block
                main_items = []
                main_block = solve_grid_layout(tbw, tbh, main_w, main_h, gap_x, gap_y)
                for item in main_block['items']:
                    item['isRotated'] = primary_rotated
                    item['blockId'] = 0
                    main_items.append(item)

                # Right fill block (full height of usable area)
                right_items = []
                right_x = tbw + split_gap
                right_w = usable_w - right_x
                if right_w > fill_w - 0.01:
                    fill_r = solve_grid_layout(right_w, usable_h, fill_w, fill_h, gap_x, gap_y)
                    for item in fill_r['items']:
                        item['x'] += right_x
                        item['isRotated'] = not primary_rotated
                        item['blockId'] = 1
                        right_items.append(item)

                # Bottom fill block (full width of usable area, below main block only)
                bottom_items = []
                bottom_y = tbh + split_gap
                bottom_h = usable_h - bottom_y
                if bottom_h > fill_h - 0.01:
                    fill_b = solve_grid_layout(usable_w, bottom_h, fill_w, fill_h, gap_x, gap_y)
                    for item in fill_b['items']:
                        item['y'] += bottom_y
                        item['isRotated'] = not primary_rotated
                        item['blockId'] = 2
                        bottom_items.append(item)

                if not right_items and bottom_items:
                    fill_w_used = max((it['x'] + it['width'] for it in bottom_items), default=0)
                    if tbw < fill_w_used:
                        shift = (fill_w_used - tbw) / 2.0
                        for it in main_items: it['x'] += shift
                    elif fill_w_used < tbw:
                        shift = (tbw - fill_w_used) / 2.0
                        for it in bottom_items: it['x'] += shift
                elif not bottom_items and right_items:
                    fill_h_used = max((it['y'] + it['height'] for it in right_items), default=0)
                    if tbh < fill_h_used:
                        shift = (fill_h_used - tbh) / 2.0
                        for it in main_items: it['y'] += shift
                    elif fill_h_used < tbh:
                        shift = (tbh - fill_h_used) / 2.0
                        for it in right_items: it['y'] += shift

                all_items = main_items + right_items + bottom_items

                if len(all_items) > best_yield:
                    best_yield = len(all_items)
                    best_items = all_items
                    if all_items:
                        best_w = max(it['x'] + it['width'] for it in all_items)
                        best_h = max(it['y'] + it['height'] for it in all_items)

        return best_yield, best_items, best_w, best_h

    # Try primary=original, fill=rotated
    y1, items1, w1, h1 = try_config(item_w, item_h, item_h, item_w, False)
    # Try primary=rotated, fill=original
    y2, items2, w2, h2 = try_config(item_h, item_w, item_w, item_h, True)

    if y1 >= y2:
        best_items, best_w, best_h, best_total = items1, w1, h1, y1
    else:
        best_items, best_w, best_h, best_total = items2, w2, h2, y2

    return {
        'totalItems': best_total,
        'items': best_items,
        'widthUsed': best_w,
        'heightUsed': best_h,
        'itemActualW': item_w,
        'itemActualH': item_h,
        'strategyUsed': 'l_shape',
    }


# ══════════════════════════════════════════════════════════════════════
# Rust-first wrappers
# ══════════════════════════════════════════════════════════════════════

def solve_pointy_top_hex_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, is_rotated: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_pointy_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated)
        except Exception:
            pass
    return _py_solve_pointy_top_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated)

def solve_flat_top_hex_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, is_rotated: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_flat_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated)
        except Exception:
            pass
    return _py_solve_flat_top_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated)

def solve_advanced_pentagon_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any], is_rotated_90: bool = False, start_with_down: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_pentagon(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90, start_with_down)
        except Exception:
            pass
    return _py_solve_advanced_pentagon_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90, start_with_down)

def solve_advanced_triangle_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any], is_rotated_90: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_triangle(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90)
        except Exception:
            pass
    return _py_solve_advanced_triangle_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90)

def solve_illustrator_trapezoid_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any] = None) -> Dict[str, Any]:
    # Delegates to _py_ which calls solve_advanced_trapezoid_layout (Rust-accelerated)
    return _py_solve_illustrator_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)

def solve_advanced_trapezoid_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any], is_rotated_90: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_trapezoid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90)
        except Exception:
            pass
    return _py_solve_advanced_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90)

def solve_illustrator_parallelogram_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, shape_props: Dict[str, Any] = None) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_parallelogram(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)
        except Exception:
            pass
    return _py_solve_illustrator_parallelogram_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)

def solve_l_shape_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, secondary_gap: float = None) -> Dict[str, Any]:
    # Rust native doesn't support secondary_gap — skip when it's set
    if _HAS_RUST and secondary_gap is None:
        try:
            result = _native.shape_l_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            items = list(result.get('items') or [])
            # INKING (audit 2026-08-12 §INK-DIE-05): extension Rust cũ có thể
            # chưa phát blockId 1/2. Suy cụm từ việc c/r của fill restart về 0:
            # main là prefix cùng hướng, fill phải có c=0; fill đáy restart r=0.
            # Lớp tương thích này giúp bản dev hiện tại đúng ngay trước khi rebuild native.
            if (
                result.get('strategyUsed') == 'l_shape'
                and items
                and not any(int(item.get('blockId', 0) or 0) != 0 for item in items)
            ):
                main_rotated = bool(items[0].get('isRotated', False))
                main_items = [
                    item for item in items
                    if bool(item.get('isRotated', False)) == main_rotated
                ]
                main_max_x = max(
                    float(item.get('x', 0.0)) + float(item.get('width', 0.0))
                    for item in main_items
                )
                main_max_y = max(
                    float(item.get('y', 0.0)) + float(item.get('height', 0.0))
                    for item in main_items
                )
                for item in items:
                    if bool(item.get('isRotated', False)) == main_rotated:
                        item['blockId'] = 0
                    elif float(item.get('y', 0.0)) >= main_max_y - 0.01:
                        item['blockId'] = 2
                    elif float(item.get('x', 0.0)) >= main_max_x - 0.01:
                        item['blockId'] = 1
                    else:
                        # Không suy đoán ngoài hai vùng L-shape chuẩn.
                        item['blockId'] = 0
            return result
        except Exception:
            pass
    return _py_solve_l_shape_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, secondary_gap)

