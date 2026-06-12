from typing import Dict, Any
from ..utils import calculate_items_bounding_box

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
