"""Sticker Imposer — Cluster, alternating, and fill layout solvers.

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
from .grid_layouts import solve_grid_layout, calculate_staggered_hex_layout, calculate_staggered_vertical_layout, calculate_hex_tiling_row_stagger, calculate_hex_tiling_col_stagger
# Explicit imports needed by _best_fill_layout() — do NOT rely on module caching from orchestrator
from .shape_layouts import (
    solve_advanced_trapezoid_layout,
    solve_advanced_pentagon_layout,
    solve_advanced_triangle_layout,
)
from .asymmetric_layouts import (
    solve_illustrator_hammer_layout,
    solve_illustrator_dumbbell_layout,
)

logger = logging.getLogger(__name__)

def _py_solve_cluster_grid_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, params: Dict[str, float] = None, is_rotated_90: bool = False) -> Dict[str, Any]:
    if is_rotated_90:
        w_orig = item_h
        h_orig = item_w
    else:
        w_orig = item_w
        h_orig = item_h

    if not params:
        params = {'dx': 0, 'dy': 0, 'dx_outer': 0, 'dy_outer': 0}

    has_nfp = params.get('dx_outer', 0) > 0
    if has_nfp:
        s_inner_x = params.get('dx', 0)
        s_inner_y = params.get('dy', 0)
        s_outer_x = params.get('dx_outer', 0)
        s_y = params.get('dy_outer', 0)
    else:
        s_inner_x = w_orig + gap_x
        s_inner_y = 0
        s_outer_x = 2 * w_orig + 2 * gap_x
        s_y = h_orig + gap_y

    min_x = min(0, s_inner_x)
    max_x = max(w_orig, s_inner_x + w_orig)
    cluster_w = max_x - min_x

    min_y = min(0, s_inner_y)
    max_y = max(h_orig, s_inner_y + h_orig)
    cluster_h = max_y - min_y

    clusters_x = 0
    if usable_w + 0.01 >= cluster_w:
        clusters_x = int((usable_w - cluster_w + 0.01) / s_outer_x) + 1
    clusters_x = max(0, clusters_x)
    
    extra_single = False
    if clusters_x * s_outer_x - min_x + w_orig <= usable_w + 0.01:
        extra_single = True

    rows = 0
    if usable_h + 0.01 >= cluster_h:
        rows = int((usable_h - cluster_h + 0.01) / s_y) + 1
    rows = max(0, rows)

    items = []
    for r in range(rows):
        row_base_y = r * s_y - min_y
        c_idx = 0
        for cx in range(clusters_x):
            cluster_base_x = cx * s_outer_x
            items.append({
                'c': c_idx, 'r': r,
                'x': cluster_base_x,
                'y': row_base_y,
                'width': w_orig,
                'height': h_orig,
                'isRotated': is_rotated_90,
                'isRotated180': False
            })
            c_idx += 1
            
            items.append({
                'c': c_idx, 'r': r,
                'x': cluster_base_x + s_inner_x,
                'y': row_base_y + s_inner_y,
                'width': w_orig,
                'height': h_orig,
                'isRotated': is_rotated_90,
                'isRotated180': True
            })
            c_idx += 1
            
        if extra_single:
            items.append({
                'c': c_idx, 'r': r,
                'x': clusters_x * s_outer_x,
                'y': row_base_y,
                'width': w_orig,
                'height': h_orig,
                'isRotated': is_rotated_90,
                'isRotated180': False
            })

    if not items:
        return {
            'totalItems': 0, 'cols': 0, 'rows': 0,
            'widthUsed': 0, 'heightUsed': 0,
            'items': [], 'itemActualW': w_orig, 'itemActualH': h_orig,
            'strategyUsed': 'head_to_tail', 'isRotated': is_rotated_90, 'isStaggered': False
        }

    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off

    return {
        'totalItems': len(items),
        'cols': c_idx + (1 if extra_single else 0) if rows > 0 else 0, 
        'rows': rows,
        'widthUsed': bb['width'], 
        'heightUsed': bb['height'],
        'items': items,
        'itemActualW': w_orig,
        'itemActualH': h_orig,
        'strategyUsed': 'head_to_tail',
        'isRotated': is_rotated_90,
        'isStaggered': False
    }

def _py_solve_row_alternating_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, row_params: Dict = None, is_rotated_90: bool = False) -> Dict[str, Any]:
    """Row-alternating layout: even rows normal, odd rows rotated 180° with offset."""
    if is_rotated_90:
        w_orig = item_h
        h_orig = item_w
    else:
        w_orig = item_w
        h_orig = item_h
    
    if not row_params:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'row_alt'}
    
    offset_x = row_params.get('offset_x', 0)
    row_h = row_params.get('row_h', h_orig + gap_y)
    step_x = row_params.get('step_x', w_orig + gap_x)
    
    if step_x <= 0.1 or row_h <= 0.1:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'row_alt'}
    
    # Even row x positions (normal)
    even_xs = []
    x = 0.0
    while x + w_orig <= usable_w + 0.1:
        even_xs.append(x)
        x += step_x
    
    # Odd row x positions (shifted by offset_x)
    odd_xs = []
    start_x = offset_x % step_x  # normalize to [0, step_x)
    if start_x > step_x / 2:
        start_x -= step_x  # allow small negative start
    x = start_x
    while x + w_orig <= usable_w + 0.1:
        if x >= -0.1:
            odd_xs.append(max(0.0, x))
        x += step_x
    
    # Row count
    num_rows = 0
    if usable_h >= h_orig - 0.1:
        num_rows = int((usable_h - h_orig + 0.1) / row_h) + 1
    
    items = []
    for r in range(num_rows):
        y = r * row_h
        if y + h_orig > usable_h + 0.5:
            break
        is_odd = (r % 2 != 0)
        xs = odd_xs if is_odd else even_xs
        for ci, xp in enumerate(xs):
            items.append({
                'c': ci, 'r': r,
                'x': xp, 'y': y,
                'width': w_orig, 'height': h_orig,
                'isRotated': is_rotated_90,
                'isRotated180': is_odd
            })
    
    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'row_alt'}
    
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
        'itemActualW': w_orig,
        'itemActualH': h_orig,
        'strategyUsed': 'row_alt',
        'isRotated': is_rotated_90,
    }

def _best_fill_layout(fill_w: float, fill_h: float, avail_w: float, avail_h: float, gap_x: float, gap_y: float, p5_params=None, p6_params=None, p5_row=None, p6_row=None, p5_col=None, p6_col=None, shape_type: str = 'CUSTOM', shape_props: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Try grid, staggered, and head-to-tail strategies for a fill area,
    return the layout with the highest item count.
    Items are normalized to origin (0,0) — no internal centering.
    """
    candidates = []

    # 1. Simple grid (both orientations)
    g1 = solve_grid_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y)
    candidates.append(g1)
    g2 = solve_grid_layout(avail_w, avail_h, fill_h, fill_w, gap_x, gap_y)
    for it in g2['items']:
        it['isRotated'] = True
    candidates.append(g2)

    # 2. Staggered hex — horizontal (both orientations)
    if shape_type not in ('TRAPEZOID', 'PARALLELOGRAM'):
        s1 = calculate_staggered_hex_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y)
        candidates.append(s1)
        s2 = calculate_staggered_hex_layout(avail_w, avail_h, fill_h, fill_w, gap_x, gap_y)
        for it in s2['items']:
            it['isRotated'] = True
        candidates.append(s2)

        # 2b. Staggered vertical (both orientations)
        sv1 = calculate_staggered_vertical_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y)
        candidates.append(sv1)
        sv2 = calculate_staggered_vertical_layout(avail_w, avail_h, fill_h, fill_w, gap_x, gap_y)
        for it in sv2['items']:
            it['isRotated'] = True
        candidates.append(sv2)

    # 3. Head-to-tail cluster (if params available)
    # Bỏ qua các layout dị dạng NFP cho Hình Thang/Bình Hành vì chúng đã có logic riêng,
    # tránh việc NFP trả về khoảng cách sai gây đè nhau, sau đó bị collision prune đi tạo ra gap lớn.
    if shape_type not in ('TRAPEZOID', 'PARALLELOGRAM'):
        if p5_params and p5_params.get('dx_outer', 0) > 0:
            h1 = solve_cluster_grid_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, p5_params, False)
            candidates.append(h1)
        if p6_params and p6_params.get('dx_outer', 0) > 0:
            h2 = solve_cluster_grid_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, p6_params, True)
            candidates.append(h2)
        
    # 4. Advanced geometric shapes
    if shape_type == 'TRAPEZOID' and shape_props:
        # User requested: "ở cụm phụ ko lồng nhau đâu nhé" -> No interlocking in fill area.
        # Grid/staggered are already added above, so we do nothing here for TRAPEZOID.
        pass
    elif shape_type == 'PENTAGON' and shape_props:
        p1 = solve_advanced_pentagon_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, shape_props, False)
        candidates.append(p1)
        p2 = solve_advanced_pentagon_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, shape_props, True)
        candidates.append(p2)
    elif shape_type == 'TRIANGLE' and shape_props:
        t1 = solve_advanced_triangle_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, shape_props, False)
        candidates.append(t1)
        t2 = solve_advanced_triangle_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, shape_props, True)
        candidates.append(t2)
    elif shape_type == 'HAMMER' and shape_props:
        hm1 = solve_illustrator_hammer_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, shape_props, disable_l_shape=True)
        candidates.append(hm1)
    elif shape_type == 'DUMBBELL' and shape_props:
        db1 = solve_illustrator_dumbbell_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, shape_props, disable_l_shape=True)
        candidates.append(db1)

    # 4. Row alternating layouts (if params available)
    if shape_type not in ('TRAPEZOID', 'PARALLELOGRAM'):
        if p5_row:
            r1 = solve_row_alternating_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, p5_row, False)
            candidates.append(r1)
        if p6_row:
            r2 = solve_row_alternating_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, p6_row, True)
            candidates.append(r2)

    # 5. Col alternating layouts (if params available)
    if shape_type not in ('TRAPEZOID', 'PARALLELOGRAM'):
        if p5_col:
            c1 = solve_col_alternating_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, p5_col, False)
            candidates.append(c1)
        if p6_col:
            c2 = solve_col_alternating_layout(avail_w, avail_h, fill_w, fill_h, gap_x, gap_y, p6_col, True)
            candidates.append(c2)

    valid_candidates = [c for c in candidates if c['items']]

    if not valid_candidates:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'none'}

    # Pick best by item count, tie-break by smaller area used
    best = max(valid_candidates, key=lambda c: (c['totalItems'], -(c['widthUsed'] * c['heightUsed'])))

    # Normalize items to origin (0,0) — undo any internal centering
    # (staggered_hex centers internally, grid starts at 0,0 already)
    if best['items']:
        bb = calculate_items_bounding_box(best['items'])
        if bb['minX'] > 0.01 or bb['minY'] > 0.01:
            for it in best['items']:
                it['x'] -= bb['minX']
                it['y'] -= bb['minY']
        best['widthUsed'] = bb['width']
        best['heightUsed'] = bb['height']

    return best


def _py_solve_col_alternating_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, col_params: Dict = None, is_rotated_90: bool = False) -> Dict[str, Any]:
    """Column-alternating layout: even cols normal, odd cols rotated 180° with offset."""
    if is_rotated_90:
        w_orig = item_h
        h_orig = item_w
    else:
        w_orig = item_w
        h_orig = item_h
    
    if not col_params:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'col_alt'}
    
    offset_y = col_params.get('offset_y', 0)
    col_w = col_params.get('col_w', w_orig + gap_x)
    step_y = col_params.get('step_y', h_orig + gap_y)
    
    if step_y <= 0.1 or col_w <= 0.1:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'col_alt'}
    
    # Even col y positions (normal)
    even_ys = []
    y = 0.0
    while y + h_orig <= usable_h + 0.1:
        even_ys.append(y)
        y += step_y
    
    # Odd col y positions (shifted by offset_y)
    odd_ys = []
    start_y = offset_y % step_y  # normalize to [0, step_y)
    if start_y > step_y / 2:
        start_y -= step_y  # allow small negative start
    y = start_y
    while y + h_orig <= usable_h + 0.1:
        if y >= -0.1:
            odd_ys.append(max(0.0, y))
        y += step_y
    
    # Col count
    num_cols = 0
    if usable_w >= w_orig - 0.1:
        num_cols = int((usable_w - w_orig + 0.1) / col_w) + 1
    
    items = []
    for c in range(num_cols):
        x = c * col_w
        if x + w_orig > usable_w + 0.5:
            break
        is_odd = (c % 2 != 0)
        ys = odd_ys if is_odd else even_ys
        for ri, yp in enumerate(ys):
            items.append({
                'c': c, 'r': ri,
                'x': x, 'y': yp,
                'width': w_orig, 'height': h_orig,
                'isRotated': is_rotated_90,
                'isRotated180': is_odd
            })
            
    best = {
        'totalItems': len(items),
        'cols': num_cols,
        'rows': max([len(even_ys), len(odd_ys)]) if items else 0,
        'items': items,
        'itemActualW': w_orig,
        'itemActualH': h_orig,
        'widthUsed': 0, 'heightUsed': 0,
        'strategyUsed': 'col_alt'
    }
    
    if best['items']:
        bb = calculate_items_bounding_box(best['items'])
        if bb['minX'] > 0.01 or bb['minY'] > 0.01:
            for it in best['items']:
                it['x'] -= bb['minX']
                it['y'] -= bb['minY']
        best['widthUsed'] = bb['width']
        best['heightUsed'] = bb['height']
            
    return best


# ══════════════════════════════════════════════════════════════════════
# Rust-first wrappers
# ══════════════════════════════════════════════════════════════════════

def solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, params=None, is_rotated_90=False):
    if _HAS_RUST:
        try:
            return _native.sticker_cluster_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, params, is_rotated_90)
        except Exception:
            pass
    return _py_solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, params, is_rotated_90)

def solve_row_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, row_params=None, is_rotated_90=False):
    if _HAS_RUST:
        try:
            return _native.sticker_row_alternating(usable_w, usable_h, item_w, item_h, gap_x, gap_y, row_params, is_rotated_90)
        except Exception:
            pass
    return _py_solve_row_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, row_params, is_rotated_90)

def solve_col_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, col_params=None, is_rotated_90=False):
    if _HAS_RUST:
        try:
            return _native.sticker_col_alternating(usable_w, usable_h, item_w, item_h, gap_x, gap_y, col_params, is_rotated_90)
        except Exception:
            pass
    return _py_solve_col_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, col_params, is_rotated_90)

