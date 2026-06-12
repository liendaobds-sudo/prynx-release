"""Sticker Imposer — Asymmetric/dumbbell/hammer layout solvers (Illustrator JSX port).

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

def _py_solve_dumbbell_pair_col_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, big_end_axis_frac: float = 0.65, is_rotated_90: bool = False) -> Dict[str, Any]:
    """Dumbbell pair-column layout (TEM NGANG → CẶP CỘT).
    Exact port of Illustrator calculateInterlockingDumbbellLayout (curW >= curH branch).
    Col A and Col B form a pair. Col B is rotated 180° and staggered vertically.
    """
    if is_rotated_90:
        w_orig = item_h
        h_orig = item_w
    else:
        w_orig = item_w
        h_orig = item_h

    empty = {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'dumbbell_pair_col'}
    if w_orig <= 0 or h_orig <= 0 or usable_w < w_orig - 0.01 or usable_h < h_orig - 0.01:
        return empty

    # --- Illustrator formulas ---
    row_pitch = h_orig + gap_y * 2.0          # double gap between rows in same column
    half_v_offset = row_pitch / 2.0           # vertical stagger for Col B
    h_shift = big_end_axis_frac * w_orig + gap_x  # horizontal offset within pair
    pair_width = w_orig + h_shift             # total width of one A+B pair
    pair_pitch = pair_width + gap_x           # distance between pair starts

    # Number of pairs
    num_pairs = 0
    if usable_w >= pair_width - 0.01:
        num_pairs = int((usable_w - pair_width + 0.01) / pair_pitch) + 1
    
    # Number of rows for Col A (normal) and Col B (staggered)
    num_rows_a = 0
    if usable_h >= h_orig - 0.01:
        num_rows_a = int((usable_h - h_orig + 0.01) / row_pitch) + 1
    num_rows_b = 0
    if usable_h >= h_orig + half_v_offset - 0.01:
        num_rows_b = int((usable_h - h_orig - half_v_offset + 0.01) / row_pitch) + 1

    items = []
    for p in range(num_pairs):
        base_x = p * pair_pitch

        # Col A (left side of pair): normal orientation
        col_a_x = base_x
        if col_a_x + w_orig <= usable_w + 0.01:
            for r in range(num_rows_a):
                cy = r * row_pitch
                if cy + h_orig <= usable_h + 0.01:
                    items.append({
                        'c': p * 2, 'r': r,
                        'x': col_a_x, 'y': cy,
                        'width': w_orig, 'height': h_orig,
                        'isRotated': is_rotated_90,
                        'isRotated180': not shape_props.get('bigEndFirst', True) if 'shape_props' in locals() and shape_props else False
                    })

        # Col B (right side of pair, shifted by h_shift): rotated 180°, staggered vertically
        col_b_x = base_x + h_shift
        if col_b_x + w_orig <= usable_w + 0.01:
            for r in range(num_rows_b):
                cy = half_v_offset + r * row_pitch
                if cy + h_orig <= usable_h + 0.01:
                    items.append({
                        'c': p * 2 + 1, 'r': r,
                        'x': col_b_x, 'y': cy,
                        'width': w_orig, 'height': h_orig,
                        'isRotated': is_rotated_90,
                        'isRotated180': True
                    })

    # Fallback: single column if no pair fits
    if num_pairs == 0 and usable_w >= w_orig - 0.01:
        for r in range(num_rows_a):
            cy = r * row_pitch
            if cy + h_orig <= usable_h + 0.01:
                items.append({
                    'c': 0, 'r': r,
                    'x': 0, 'y': cy,
                    'width': w_orig, 'height': h_orig,
                    'isRotated': is_rotated_90,
                    'isRotated180': False
                })

    if not items:
        return empty

    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
    # NORMALIZE TO ORIGIN (0,0) - Do NOT center to usable_w/usable_h!
    # nup_engine.py applies global centering using widthUsed/heightUsed

    return {
        'totalItems': len(items),
        'cols': num_pairs * 2,
        'rows': num_rows_a,
        'items': items,
        'itemActualW': w_orig,
        'itemActualH': h_orig,
        'widthUsed': bb['width'],
        'heightUsed': bb['height'],
        'strategyUsed': 'dumbbell_pair_col'
    }


def _py_solve_dumbbell_pair_row_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, big_end_axis_frac: float = 0.65, is_rotated_90: bool = False) -> Dict[str, Any]:
    """Dumbbell pair-row layout (TEM ĐỨNG → CẶP HÀNG).
    Exact port of Illustrator calculateInterlockingDumbbellLayout (curH > curW branch).
    Row A and Row B form a pair. Row B is rotated 180° and staggered horizontally.
    """
    if is_rotated_90:
        w_orig = item_h
        h_orig = item_w
    else:
        w_orig = item_w
        h_orig = item_h

    empty = {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'dumbbell_pair_row'}
    if w_orig <= 0 or h_orig <= 0 or usable_w < w_orig - 0.01 or usable_h < h_orig - 0.01:
        return empty

    # --- Illustrator formulas ---
    col_pitch = w_orig + gap_x * 2.0          # double gap between cols in same row
    half_h_offset = col_pitch / 2.0           # horizontal stagger for Row B
    v_shift = big_end_axis_frac * h_orig + gap_y  # vertical offset within pair
    pair_height = h_orig + v_shift            # total height of one A+B pair
    pair_v_pitch = pair_height + gap_y        # distance between pair starts

    # Number of pairs
    num_pairs = 0
    if usable_h >= pair_height - 0.01:
        num_pairs = int((usable_h - pair_height + 0.01) / pair_v_pitch) + 1

    # Number of cols for Row A (normal) and Row B (staggered)
    num_cols_a = 0
    if usable_w >= w_orig - 0.01:
        num_cols_a = int((usable_w - w_orig + 0.01) / col_pitch) + 1
    num_cols_b = 0
    if usable_w >= w_orig + half_h_offset - 0.01:
        num_cols_b = int((usable_w - w_orig - half_h_offset + 0.01) / col_pitch) + 1

    items = []
    for p in range(num_pairs):
        base_y = p * pair_v_pitch

        # Row A (top of pair): normal orientation
        row_a_y = base_y
        if row_a_y + h_orig <= usable_h + 0.01:
            for c in range(num_cols_a):
                cx = c * col_pitch
                if cx + w_orig <= usable_w + 0.01:
                    items.append({
                        'c': c, 'r': p * 2,
                        'x': cx, 'y': row_a_y,
                        'width': w_orig, 'height': h_orig,
                        'isRotated': is_rotated_90,
                        'isRotated180': False
                    })

        # Row B (bottom of pair, shifted by v_shift): rotated 180°, staggered horizontally
        row_b_y = base_y + v_shift
        if row_b_y + h_orig <= usable_h + 0.01:
            for c in range(num_cols_b):
                cx = half_h_offset + c * col_pitch
                if cx + w_orig <= usable_w + 0.01:
                    items.append({
                        'c': c, 'r': p * 2 + 1,
                        'x': cx, 'y': row_b_y,
                        'width': w_orig, 'height': h_orig,
                        'isRotated': is_rotated_90,
                        'isRotated180': True
                    })

    # Fallback: single row if no pair fits
    if num_pairs == 0 and usable_h >= h_orig - 0.01:
        for c in range(num_cols_a):
            cx = c * col_pitch
            if cx + w_orig <= usable_w + 0.01:
                items.append({
                    'c': c, 'r': 0,
                    'x': cx, 'y': 0,
                    'width': w_orig, 'height': h_orig,
                    'isRotated': is_rotated_90,
                    'isRotated180': False
                })

    if not items:
        return empty

    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
    # NORMALIZE TO ORIGIN (0,0) - Do NOT center to usable_w/usable_h!

    return {
        'totalItems': len(items),
        'cols': num_cols_a,
        'rows': num_pairs * 2,
        'items': items,
        'itemActualW': w_orig,
        'itemActualH': h_orig,
        'widthUsed': bb['width'],
        'heightUsed': bb['height'],
        'strategyUsed': 'dumbbell_pair_row'
    }


def evaluate_unified_asymmetric(usable_w: float, usable_h: float, bb_w: float, bb_h: float, gap_h: float, gap_v: float, shape_props: Dict[str, Any], is_rotated: bool) -> Dict[str, Any]:
    # Determine the bounding box to pass (if is_rotated, we swap bb_w and bb_h to simulate forced rotation)
    eval_w = bb_h if is_rotated else bb_w
    eval_h = bb_w if is_rotated else bb_h
    
    # We must also swap dimensions inside shape_props if rotated? No, shape_props is orientation-invariant!
    # Wait, shape_props dimensions like bigD, smallD are relative to the shape's unrotated coordinate system!
    # If we pass eval_w and eval_h, the algorithm will naturally try Pass 0 (eval_w, eval_h) and Pass 1 (eval_h, eval_w).
    # Since we want to FORCE it to be rotated 90 degrees compared to the MAIN block, we should only accept the pass that matches the forced rotation!
    
    res_hm = solve_illustrator_hammer_layout(usable_w, usable_h, eval_w, eval_h, gap_h, gap_v, shape_props, disable_l_shape=True)
    res_db = solve_illustrator_dumbbell_layout(usable_w, usable_h, eval_w, eval_h, gap_h, gap_v, shape_props, disable_l_shape=True)
    
    best_res = res_db if res_db.get('totalItems', 0) > res_hm.get('totalItems', 0) else res_hm
    
    # best_res might have isRotated90 based on eval_w, eval_h.
    # Because we passed eval_w = bb_h (swapped), Pass 0 inside means it IS rotated 90 relative to the original!
    # So we just take best_res and correct the isRotated flag.
    for item in best_res.get('items', []):
        # If it was isRotated relative to eval_w/eval_h, then its true rotation is XOR with is_rotated
        item['isRotated'] = (not item.get('isRotated', False)) if is_rotated else item.get('isRotated', False)
        
    return best_res

def _py_solve_illustrator_hammer_layout(usable_w: float, usable_h: float, bb_w: float, bb_h: float, gap_h: float, gap_v: float, shape_props: Dict[str, Any] = None, disable_l_shape: bool = False) -> Dict[str, Any]:
    if shape_props is None:
        shape_props = {}
    best_items = []
    best_pass = 0
    best_w_used = 0
    best_h_used = 0
    
    waist_ratio = shape_props.get('waistRatio', 0.7)
    big_end_first = shape_props.get('bigEndFirst', True)
    
    for pass_idx in range(2):
        cur_w, cur_h, cur_gap_h, cur_gap_v = (bb_w, bb_h, gap_h, gap_v) if pass_idx == 0 else (bb_h, bb_w, gap_v, gap_h)
        items = []
        is_rotated_90 = (pass_idx == 1)
        half_w = cur_w / 2.0
        half_h = cur_h / 2.0
        effective_body_w = shape_props.get('bodyW', 0)
        if effective_body_w <= 0:
            effective_body_w = min(cur_w, cur_h) * 0.5
            
        small_d = shape_props.get('smallD', 0)
        small_asymm = shape_props.get('smallAsymmOffset', 0)
        effective_tail_w = max(effective_body_w, small_d + 2 * small_asymm)
        
        safe_asymm_buffer = shape_props.get('asymmOffset', 0)
        if safe_asymm_buffer <= 1:
            safe_asymm_buffer = 0
        
        if cur_h >= cur_w:
            col_pitch = (cur_w + effective_tail_w) / 2.0 + safe_asymm_buffer + cur_gap_h
            safe_pitch = shape_props.get('safeInterlockPitch', 0)
            if safe_pitch > 0:
                profile_based_pitch = safe_pitch + cur_gap_h
                if profile_based_pitch > col_pitch:
                    col_pitch = profile_based_pitch
                    
            row_pitch = cur_h + cur_gap_v
            num_cols = int((usable_w - cur_w + 0.01) / col_pitch) + 1 if usable_w >= cur_w - 0.01 else 0
            num_rows = int((usable_h - cur_h + 0.01) / row_pitch) + 1 if usable_h >= cur_h - 0.01 else 0
            for col in range(num_cols):
                cx = half_w + col * col_pitch
                if cx + half_w > usable_w + 0.01: continue
                for row in range(num_rows):
                    cy = half_h + row * row_pitch
                    if cy + half_h <= usable_h + 0.01:
                        items.append({
                            'c': col, 'r': row,
                            'x': cx - half_w, 'y': cy - half_h,
                            'width': cur_w, 'height': cur_h,
                            'isRotated': is_rotated_90,
                            'isRotated180': (col % 2 != 0) if big_end_first else (col % 2 == 0)
                        })
        else:
            row_pitch = (cur_h + effective_tail_w) / 2.0 + safe_asymm_buffer + cur_gap_v
            safe_pitch = shape_props.get('safeInterlockPitch', 0)
            if safe_pitch > 0:
                profile_based_pitch = safe_pitch + cur_gap_v
                if profile_based_pitch > row_pitch:
                    row_pitch = profile_based_pitch
                    
            col_pitch = cur_w + cur_gap_h
            num_rows = int((usable_h - cur_h + 0.01) / row_pitch) + 1 if usable_h >= cur_h - 0.01 else 0
            num_cols = int((usable_w - cur_w + 0.01) / col_pitch) + 1 if usable_w >= cur_w - 0.01 else 0
            for row in range(num_rows):
                cy = half_h + row * row_pitch
                if cy + half_h > usable_h + 0.01: continue
                for col in range(num_cols):
                    cx = half_w + col * col_pitch
                    if cx + half_w <= usable_w + 0.01:
                        items.append({
                            'c': col, 'r': row,
                            'x': cx - half_w, 'y': cy - half_h,
                            'width': cur_w, 'height': cur_h,
                            'isRotated': is_rotated_90,
                            'isRotated180': (row % 2 != 0) if big_end_first else (row % 2 == 0)
                        })
                        
        if len(items) > len(best_items):
            best_items = items
            best_pass = pass_idx
            bb = calculate_items_bounding_box(items)
            cx_off = -bb['minX']
            cy_off = -bb['minY']
            for it in items:
                it['x'] += cx_off
                it['y'] += cy_off
            best_w_used = bb['width'] if bb['width'] > 0 else 0
            best_h_used = bb['height'] if bb['height'] > 0 else 0

    if not best_items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'illustrator_hammer'}
        
    main_items = best_items
    main_is_rotated = (best_pass == 1)
    fill_is_rotated = not main_is_rotated
    fill_w = bb_h if not main_is_rotated else bb_w
    fill_h = bb_w if not main_is_rotated else bb_h
    
    space_right = usable_w - best_w_used - gap_h
    space_bottom = usable_h - best_h_used - gap_v
    
    if disable_l_shape:
        bb_final = calculate_items_bounding_box(main_items)
        for it in main_items:
            it['x'] -= bb_final['minX']
            it['y'] -= bb_final['minY']
        return {'totalItems': len(main_items), 'items': main_items, 'widthUsed': bb_final['width'], 'heightUsed': bb_final['height'], 'strategyUsed': 'illustrator_hammer'}

    fill_items = []
    
    # We force the fill area to use rotated geometry relative to main
    # Wait, the best pass for the fill area might be ANY pass!
    # But to fit the long edge, we typically force \fill_is_rotated.
    # Let's just let the unified evaluator pick the best!
    
    if space_right >= fill_w - 0.01:
        res_right = evaluate_unified_asymmetric(space_right, usable_h, bb_w, bb_h, gap_h, gap_v, shape_props, fill_is_rotated)
        if res_right.get('totalItems', 0) > 0:
            off_x = best_w_used + gap_h
            off_y = (usable_h - res_right['heightUsed']) / 2.0
            for it in res_right['items']:
                it['x'] += off_x
                it['y'] += off_y
                fill_items.append(it)
                
    if space_bottom >= fill_h - 0.01:
        res_bottom = evaluate_unified_asymmetric(usable_w, space_bottom, bb_w, bb_h, gap_h, gap_v, shape_props, fill_is_rotated)
        if res_bottom.get('totalItems', 0) > 0:
            off_x = (usable_w - res_bottom['widthUsed']) / 2.0
            off_y = best_h_used + gap_v
            for it in res_bottom['items']:
                it['x'] += off_x
                it['y'] += off_y
                # If space_right was populated, we shouldn't overlap!
                if space_right >= fill_w - 0.01 and (it['x'] + it['width'] > best_w_used + 0.01):
                    continue
                fill_items.append(it)

    all_items = main_items + fill_items
    bb_final = calculate_items_bounding_box(all_items)
    for it in all_items:
        it['x'] -= bb_final['minX']
        it['y'] -= bb_final['minY']
        
    return {
        'totalItems': len(all_items),
        'cols': 0, 'rows': 0,
        'items': all_items,
        'widthUsed': bb_final['width'],
        'heightUsed': bb_final['height'],
        'strategyUsed': 'illustrator_hammer',
        '_main_rotated': main_is_rotated
    }

def _py_solve_illustrator_dumbbell_layout(usable_w: float, usable_h: float, bb_w: float, bb_h: float, gap_h: float, gap_v: float, shape_props: Dict[str, Any] = None, disable_l_shape: bool = False) -> Dict[str, Any]:
    if shape_props is None:
        shape_props = {}
    best_items = []
    best_pass = 0
    best_w_used = 0
    best_h_used = 0
    
    big_end_axis_frac = shape_props.get('bigEndAxisFrac', 0.65)
    # Illustrator passes smallEndFirst (= !bigEndFirst) as flipOrientation
    # so that small heads face each other in the interlock gap
    flip_orientation = not shape_props.get('bigEndFirst', True)
    
    for pass_idx in range(2):
        cur_w, cur_h, cur_gap_h, cur_gap_v = (bb_w, bb_h, gap_h, gap_v) if pass_idx == 0 else (bb_h, bb_w, gap_v, gap_h)
        items = []
        is_rotated_90 = (pass_idx == 1)
        half_w = cur_w / 2.0
        half_h = cur_h / 2.0
        
        # To prevent big heads from colliding in the middle, they must point OUTWARD.
        # If flip_orientation is False (bigEndFirst=True, big head is naturally on LEFT):
        # Col B (Left) should be Normal (rot=False) -> big head on LEFT.
        # Col A (Right) should be Rotated (rot=True) -> big head on RIGHT.
        rot_180_a = False if flip_orientation else True
        rot_180_b = True if flip_orientation else False
        waist_ratio = shape_props.get('waistRatio', 0.7)
        
        small_d = shape_props.get('smallD', 0)
        body_w = shape_props.get('bodyW', 0)
        small_asymm = shape_props.get('smallAsymmOffset', 0)
        effective_small_d = small_d + 2 * small_asymm
        

        if cur_w >= cur_h:
            pitch_big_heads = cur_h + cur_gap_v
            pitch_handles = cur_gap_v
            if small_d > 0 and body_w > 0:
                pitch_handles = effective_small_d + body_w + cur_gap_v * 2.0
            
            # Khôi phục logic va chạm giữa phần đầu tạ to và tay cầm tạ nhỏ (hình tròn và đường thẳng)
            import math
            r = cur_h / 2.0
            h_shift = big_end_axis_frac * cur_w + cur_gap_h
            safe_pitch = shape_props.get('safeInterlockPitch', 0)
            if safe_pitch > 0:
                min_shift = safe_pitch + cur_gap_h
                if h_shift < min_shift:
                    h_shift = min_shift
                    
            small_len = shape_props.get('smallHeadFrac', 0.15) * cur_w
            
            dx = 0
            if r < h_shift:
                dx = h_shift - r
            elif r > h_shift + small_len:
                dx = r - (h_shift + small_len)
                
            y_circle = math.sqrt(max(0, r**2 - dx**2))
            min_row_pitch_head = 2 * y_circle + effective_small_d + cur_gap_v * 2.0
            
            row_pitch = max(pitch_big_heads, pitch_handles, min_row_pitch_head)
            v_shift = row_pitch / 2.0
            
            pair_width = cur_w + h_shift
            pair_pitch = pair_width + cur_gap_h
            
            min_dx = math.sqrt(max(0, (cur_h + cur_gap_h)**2 - (row_pitch / 2.0)**2))
            min_pair_pitch_head = min_dx + h_shift + cur_w - cur_h
            min_pair_pitch_handle = h_shift + cur_w - cur_h + cur_gap_h
            min_pair_pitch_small_heads = 0
            if v_shift < effective_small_d + cur_gap_v:
                min_pair_pitch_small_heads = h_shift + cur_w + cur_gap_h
            new_pair_pitch = max(min_pair_pitch_head, min_pair_pitch_handle, min_pair_pitch_small_heads)
            if new_pair_pitch < pair_pitch:
                pair_pitch = new_pair_pitch
                
            num_pairs = int((usable_w - pair_width + 0.01) / pair_pitch) + 1 if usable_w >= pair_width - 0.01 else 0
            num_rows_a = int((usable_h - cur_h + 0.01) / row_pitch) + 1 if usable_h >= cur_h - 0.01 else 0
            num_rows_b = int((usable_h - cur_h - v_shift + 0.01) / row_pitch) + 1 if usable_h >= cur_h + v_shift - 0.01 else 0
            
            for p in range(num_pairs):
                base_x = p * pair_pitch
                col_a_cx = base_x + half_w + h_shift
                for r_idx in range(num_rows_a):
                    cy = half_h + r_idx * row_pitch
                    if col_a_cx + half_w <= usable_w + 0.01 and cy + half_h <= usable_h + 0.01:
                        items.append({'c': p*2+1, 'r': r_idx, 'x': col_a_cx - half_w, 'y': cy - half_h, 'width': cur_w, 'height': cur_h, 'isRotated': is_rotated_90, 'isRotated180': rot_180_a})
                col_b_cx = base_x + half_w
                for r_idx in range(num_rows_b):
                    cy = half_h + v_shift + r_idx * row_pitch
                    if col_b_cx + half_w <= usable_w + 0.01 and cy + half_h <= usable_h + 0.01:
                        items.append({'c': p*2, 'r': r_idx, 'x': col_b_cx - half_w, 'y': cy - half_h, 'width': cur_w, 'height': cur_h, 'isRotated': is_rotated_90, 'isRotated180': rot_180_b})
            
            if num_pairs == 0 and usable_w >= cur_w - 0.01:
                for r_idx in range(num_rows_a):
                    cy = half_h + r_idx * row_pitch
                    if cy + half_h <= usable_h + 0.01:
                        items.append({'c': 0, 'r': r_idx, 'x': 0, 'y': cy - half_h, 'width': cur_w, 'height': cur_h, 'isRotated': is_rotated_90, 'isRotated180': rot_180_a})
        else:
            col_pitch_big_heads = cur_w + cur_gap_h
            col_pitch_handles = cur_gap_h
            if small_d > 0 and body_w > 0:
                col_pitch_handles = effective_small_d + body_w + cur_gap_h * 2.0
            
            import math
            r = cur_w / 2.0
            v_shift = big_end_axis_frac * cur_h + cur_gap_v
            safe_pitch = shape_props.get('safeInterlockPitch', 0)
            if safe_pitch > 0:
                min_shift = safe_pitch + cur_gap_v
                if v_shift < min_shift:
                    v_shift = min_shift
                    
            small_len = shape_props.get('smallHeadFrac', 0.15) * cur_h
            
            dy = 0
            if r < v_shift:
                dy = v_shift - r
            elif r > v_shift + small_len:
                dy = r - (v_shift + small_len)
                
            x_circle = math.sqrt(max(0, r**2 - dy**2))
            min_col_pitch_head = 2 * x_circle + effective_small_d + cur_gap_h * 2.0
            
            col_pitch = max(col_pitch_big_heads, col_pitch_handles, min_col_pitch_head)
            h_shift = col_pitch / 2.0
            
            row_pitch = cur_h + cur_gap_v
            pair_height = cur_h + v_shift
            pair_v_pitch = pair_height + cur_gap_v
            
            min_dy = math.sqrt(max(0, (cur_w + cur_gap_v)**2 - (col_pitch / 2.0)**2))
            min_pair_v_pitch_head = min_dy + v_shift + cur_h - cur_w
            min_pair_v_pitch_handle = v_shift + cur_h - cur_w + cur_gap_v
            min_pair_v_pitch_small_heads = 0
            if h_shift < effective_small_d + cur_gap_h:
                min_pair_v_pitch_small_heads = v_shift + cur_h + cur_gap_v
            new_pair_v_pitch = max(min_pair_v_pitch_head, min_pair_v_pitch_handle, min_pair_v_pitch_small_heads)
            if new_pair_v_pitch < pair_v_pitch:
                pair_v_pitch = new_pair_v_pitch
                
            num_pairs = int((usable_h - pair_height + 0.01) / pair_v_pitch) + 1 if usable_h >= pair_height - 0.01 else 0
            num_cols_a = int((usable_w - cur_w + 0.01) / col_pitch) + 1 if usable_w >= cur_w - 0.01 else 0
            num_cols_b = int((usable_w - cur_w - h_shift + 0.01) / col_pitch) + 1 if usable_w >= cur_w + h_shift - 0.01 else 0
            
            for p in range(num_pairs):
                base_y = p * pair_v_pitch
                row_a_cy = base_y + half_h + v_shift
                for c in range(num_cols_a):
                    cx = half_w + c * col_pitch
                    if cx + half_w <= usable_w + 0.01 and row_a_cy + half_h <= usable_h + 0.01:
                        items.append({'c': c, 'r': p*2+1, 'x': cx - half_w, 'y': row_a_cy - half_h, 'width': cur_w, 'height': cur_h, 'isRotated': is_rotated_90, 'isRotated180': rot_180_a})
                row_b_cy = base_y + half_h
                for c in range(num_cols_b):
                    cx = half_w + h_shift + c * col_pitch
                    if cx + half_w <= usable_w + 0.01 and row_b_cy + half_h <= usable_h + 0.01:
                        items.append({'c': c, 'r': p*2, 'x': cx - half_w, 'y': row_b_cy - half_h, 'width': cur_w, 'height': cur_h, 'isRotated': is_rotated_90, 'isRotated180': rot_180_b})
            
            if num_pairs == 0 and usable_h >= cur_h - 0.01:
                for c in range(num_cols_a):
                    cx = half_w + c * col_pitch
                    if cx + half_w <= usable_w + 0.01:
                        items.append({'c': c, 'r': 0, 'x': cx - half_w, 'y': 0, 'width': cur_w, 'height': cur_h, 'isRotated': is_rotated_90, 'isRotated180': rot_180_a})
        
        if len(items) > len(best_items):
            best_items = items
            best_pass = pass_idx
            bb = calculate_items_bounding_box(items)
            cx_off = -bb['minX']
            cy_off = -bb['minY']
            for it in items:
                it['x'] += cx_off
                it['y'] += cy_off
            best_w_used = bb['width'] if bb['width'] > 0 else 0
            best_h_used = bb['height'] if bb['height'] > 0 else 0

    if not best_items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0, 'strategyUsed': 'illustrator_dumbbell'}
        
    main_items = best_items
    main_is_rotated = (best_pass == 1)
    fill_is_rotated = not main_is_rotated
    fill_w = bb_h if not main_is_rotated else bb_w
    fill_h = bb_w if not main_is_rotated else bb_h
    
    space_right = usable_w - best_w_used - gap_h
    space_bottom = usable_h - best_h_used - gap_v
    
    if disable_l_shape:
        bb_final = calculate_items_bounding_box(main_items)
        for it in main_items:
            it['x'] -= bb_final['minX']
            it['y'] -= bb_final['minY']
        return {'totalItems': len(main_items), 'items': main_items, 'widthUsed': bb_final['width'], 'heightUsed': bb_final['height'], 'strategyUsed': 'illustrator_hammer'}

    fill_items = []
    
    # We force the fill area to use rotated geometry relative to main
    # Wait, the best pass for the fill area might be ANY pass!
    # But to fit the long edge, we typically force ill_is_rotated.
    # Let's just let the unified evaluator pick the best!
    
    if space_right >= fill_w - 0.01:
        res_right = evaluate_unified_asymmetric(space_right, usable_h, bb_w, bb_h, gap_h, gap_v, shape_props, fill_is_rotated)
        if res_right.get('totalItems', 0) > 0:
            off_x = best_w_used + gap_h
            off_y = (usable_h - res_right['heightUsed']) / 2.0
            for it in res_right['items']:
                it['x'] += off_x
                it['y'] += off_y
                fill_items.append(it)
                
    if space_bottom >= fill_h - 0.01:
        res_bottom = evaluate_unified_asymmetric(usable_w, space_bottom, bb_w, bb_h, gap_h, gap_v, shape_props, fill_is_rotated)
        if res_bottom.get('totalItems', 0) > 0:
            off_x = (usable_w - res_bottom['widthUsed']) / 2.0
            off_y = best_h_used + gap_v
            for it in res_bottom['items']:
                it['x'] += off_x
                it['y'] += off_y
                # If space_right was populated, we shouldn't overlap!
                if space_right >= fill_w - 0.01 and (it['x'] + it['width'] > best_w_used + 0.01):
                    continue
                fill_items.append(it)

    all_items = main_items + fill_items
    bb_final = calculate_items_bounding_box(all_items)
    for it in all_items:
        it['x'] -= bb_final['minX']
        it['y'] -= bb_final['minY']
        
    return {
        'totalItems': len(all_items),
        'cols': 0, 'rows': 0,
        'items': all_items,
        'widthUsed': bb_final['width'],
        'heightUsed': bb_final['height'],
        'strategyUsed': 'illustrator_dumbbell',
        '_main_rotated': main_is_rotated
    }


# ══════════════════════════════════════════════════════════════════════
# Rust-first wrappers
# ══════════════════════════════════════════════════════════════════════

def solve_dumbbell_pair_col_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, big_end_axis_frac: float = 0.65, is_rotated_90: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_dumbbell_pair_col(usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac, is_rotated_90)
        except Exception:
            pass
    return _py_solve_dumbbell_pair_col_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac, is_rotated_90)

def solve_dumbbell_pair_row_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, big_end_axis_frac: float = 0.65, is_rotated_90: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            return _native.shape_dumbbell_pair_row(usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac, is_rotated_90)
        except Exception:
            pass
    return _py_solve_dumbbell_pair_row_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac, is_rotated_90)

def solve_illustrator_hammer_layout(usable_w: float, usable_h: float, bb_w: float, bb_h: float, gap_h: float, gap_v: float, shape_props: Dict[str, Any] = None, disable_l_shape: bool = False) -> Dict[str, Any]:
    if _HAS_RUST:
        try:
            # Our shape_hammer function in rust mimics the Python solve_illustrator_hammer_layout logic
            return _native.shape_hammer(usable_w, usable_h, bb_w, bb_h, gap_h, gap_v, shape_props, disable_l_shape)
        except Exception:
            pass
    return _py_solve_illustrator_hammer_layout(usable_w, usable_h, bb_w, bb_h, gap_h, gap_v, shape_props, disable_l_shape)

def solve_illustrator_dumbbell_layout(usable_w: float, usable_h: float, bb_w: float, bb_h: float, gap_h: float, gap_v: float, shape_props: Dict[str, Any] = None, disable_l_shape: bool = False) -> Dict[str, Any]:
    # We did not fully port solve_illustrator_dumbbell_layout because it recursively relies on solve_illustrator_hammer_layout and itself via evaluate_unified_asymmetric,
    # and has a very complex circle intersection fallback logic.
    # We keep the python implementation, but since it calls evaluate_unified_asymmetric -> which calls solve_illustrator_hammer_layout, it will still get some acceleration from the hammer rust port!
    return _py_solve_illustrator_dumbbell_layout(usable_w, usable_h, bb_w, bb_h, gap_h, gap_v, shape_props, disable_l_shape)

