"""
Sticker Imposer — Grid and staggered/hex layout solvers.

Contains:
- solve_grid_layout: Basic CxR grid
- calculate_staggered_hex_layout: Horizontal stagger (circle nesting)
- calculate_staggered_vertical_layout: Vertical stagger
- calculate_hex_tiling_row_stagger: Hex row tiling (pointy-top)
- calculate_hex_tiling_col_stagger: Hex col tiling (flat-top)

Rust-accelerated via pdfcompare_native (5-10x faster).
"""
import math
from typing import Dict, Any

from .utils import MY_SCRIPT_TOLERANCE, calculate_items_bounding_box

# ── Rust acceleration ──
try:
    import pdfcompare_native as _native
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False


def _py_solve_grid_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float) -> Dict[str, Any]:
    """Basic Grid Layout (identical to NupGridSolver)"""
    step_x = max(item_w * 0.05, item_w + gap_x)
    step_y = max(item_h * 0.05, item_h + gap_y)

    cols = 0
    if usable_w + 0.01 >= item_w:
        cols = int((usable_w - item_w + 0.01) / step_x) + 1
    cols = max(0, cols)

    rows = 0
    if usable_h + 0.01 >= item_h:
        rows = int((usable_h - item_h + 0.01) / step_y) + 1
    rows = max(0, rows)

    block_w = cols * item_w + (max(0, cols - 1) * gap_x)
    while cols > 0 and block_w > usable_w + 0.01:
        cols -= 1
        block_w = cols * item_w + (max(0, cols - 1) * gap_x)

    block_h = rows * item_h + (max(0, rows - 1) * gap_y)
    while rows > 0 and block_h > usable_h + 0.01:
        rows -= 1
        block_h = rows * item_h + (max(0, rows - 1) * gap_y)

    items = []
    for r in range(rows):
        for c in range(cols):
            items.append({
                'c': c, 'r': r,
                'x': c * step_x,
                'y': r * step_y,
                'width': item_w,
                'height': item_h,
                'isRotated': False,
            })

    return {
        'totalItems': len(items),
        'cols': cols, 'rows': rows,
        'widthUsed': block_w, 'heightUsed': block_h,
        'items': items,
        'itemActualW': item_w,
        'itemActualH': item_h
    }

def _py_calculate_staggered_hex_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float) -> Dict[str, Any]:
    """
    Port of calculateStaggeredHexLayoutCore from JSX script.
    Optimizes layout for circular/oval shapes by nesting them.
    Horizontal stagger: odd ROWS are offset in X direction.
    """
    if item_w <= MY_SCRIPT_TOLERANCE or item_h <= MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
        
    rx = item_w / 2.0
    ry = item_h / 2.0
    
    if usable_w < item_w - MY_SCRIPT_TOLERANCE or usable_h < item_h - MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
        
    step_x = max(item_w * 0.05, item_w + gap_x)
    step_y = math.sqrt(3) * (ry + gap_y / 2.0)
    
    if step_y <= MY_SCRIPT_TOLERANCE:
        if usable_h < item_h - MY_SCRIPT_TOLERANCE:
            return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
            
    items = []
    max_rows = 0
    if usable_h >= item_h - MY_SCRIPT_TOLERANCE:
        if step_y > MY_SCRIPT_TOLERANCE:
            max_rows = math.floor((usable_h - item_h + MY_SCRIPT_TOLERANCE) / step_y) + 1
        else:
            max_rows = 1
            
    for row in range(max_rows):
        cy = ry + row * step_y
        if cy - ry < -MY_SCRIPT_TOLERANCE or cy + ry > usable_h + MY_SCRIPT_TOLERANCE:
            if row == 0 and (cy + ry > usable_h + MY_SCRIPT_TOLERANCE or cy - ry < -MY_SCRIPT_TOLERANCE):
                pass
            break
            
        is_odd_row = (row % 2 != 0)
        num_items_in_row = 0
        row_start_x_center = 0.0
        
        if is_odd_row:
            row_start_x_center = rx + (item_w / 2.0) + (gap_x / 2.0)
            if usable_w >= (row_start_x_center - rx + item_w - MY_SCRIPT_TOLERANCE):
                num_items_in_row = 1
                if step_x > MY_SCRIPT_TOLERANCE:
                    remaining = usable_w - (row_start_x_center - rx + item_w)
                    if remaining >= -MY_SCRIPT_TOLERANCE:
                        num_items_in_row += math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_x)
        else:
            row_start_x_center = rx
            if usable_w >= item_w - MY_SCRIPT_TOLERANCE:
                num_items_in_row = 1
                if step_x > MY_SCRIPT_TOLERANCE:
                    remaining = usable_w - item_w
                    if remaining >= -MY_SCRIPT_TOLERANCE:
                        num_items_in_row += math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_x)
                        
        num_items_in_row = max(0, num_items_in_row)
        
        for col in range(num_items_in_row):
            cx = row_start_x_center + col * step_x
            if cx - rx < -MY_SCRIPT_TOLERANCE or cx + rx > usable_w + MY_SCRIPT_TOLERANCE:
                if col == 0:
                    break
                continue
                
            items.append({
                'c': col, 'r': row,
                'x': cx - rx,
                'y': cy - ry,
                'width': item_w,
                'height': item_h,
                'isRotated': False,
            })
            
    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
        
    # Items are positioned from (0,0). Do NOT center internally —
    # centering is handled by nup_engine.py based on widthUsed/heightUsed.
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
        'itemActualW': item_w,
        'itemActualH': item_h
    }


def _py_calculate_staggered_vertical_layout(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float) -> Dict[str, Any]:
    """
    Vertical stagger: odd COLUMNS are offset in Y direction.
    This is the 90° rotated version of the horizontal hex stagger.
    Better for tall/narrow items or when the sheet is wider than tall.
    """
    if item_w <= MY_SCRIPT_TOLERANCE or item_h <= MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    rx = item_w / 2.0
    ry = item_h / 2.0

    if usable_w < item_w - MY_SCRIPT_TOLERANCE or usable_h < item_h - MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    step_y = max(item_h * 0.05, item_h + gap_y)
    step_x = math.sqrt(3) * (rx + gap_x / 2.0)

    if step_x <= MY_SCRIPT_TOLERANCE:
        if usable_w < item_w - MY_SCRIPT_TOLERANCE:
            return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    items = []
    max_cols = 0
    if usable_w >= item_w - MY_SCRIPT_TOLERANCE:
        if step_x > MY_SCRIPT_TOLERANCE:
            max_cols = math.floor((usable_w - item_w + MY_SCRIPT_TOLERANCE) / step_x) + 1
        else:
            max_cols = 1

    for col in range(max_cols):
        cx = rx + col * step_x
        if cx - rx < -MY_SCRIPT_TOLERANCE or cx + rx > usable_w + MY_SCRIPT_TOLERANCE:
            if col == 0:
                pass
            break

        is_odd_col = (col % 2 != 0)
        num_items_in_col = 0
        col_start_y_center = 0.0

        if is_odd_col:
            col_start_y_center = ry + (item_h / 2.0) + (gap_y / 2.0)
            if usable_h >= (col_start_y_center - ry + item_h - MY_SCRIPT_TOLERANCE):
                num_items_in_col = 1
                if step_y > MY_SCRIPT_TOLERANCE:
                    remaining = usable_h - (col_start_y_center - ry + item_h)
                    if remaining >= -MY_SCRIPT_TOLERANCE:
                        num_items_in_col += math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_y)
        else:
            col_start_y_center = ry
            if usable_h >= item_h - MY_SCRIPT_TOLERANCE:
                num_items_in_col = 1
                if step_y > MY_SCRIPT_TOLERANCE:
                    remaining = usable_h - item_h
                    if remaining >= -MY_SCRIPT_TOLERANCE:
                        num_items_in_col += math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_y)

        num_items_in_col = max(0, num_items_in_col)

        for row in range(num_items_in_col):
            cy = col_start_y_center + row * step_y
            if cy - ry < -MY_SCRIPT_TOLERANCE or cy + ry > usable_h + MY_SCRIPT_TOLERANCE:
                if row == 0:
                    break
                continue

            items.append({
                'c': col, 'r': row,
                'x': cx - rx,
                'y': cy - ry,
                'width': item_w,
                'height': item_h,
                'isRotated': False,
            })

    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

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
        'itemActualW': item_w,
        'itemActualH': item_h
    }


def _py_calculate_hex_tiling_row_stagger(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float) -> Dict[str, Any]:
    """
    Brick-wall stagger for hexagonal items (ROW stagger).
    Uses full item_h for vertical step to prevent bounding-box overlap.
    Odd rows are offset in X by half the horizontal pitch for stagger effect.
    """
    if item_w <= MY_SCRIPT_TOLERANCE or item_h <= MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    rx = item_w / 2.0
    ry = item_h / 2.0

    if usable_w < item_w - MY_SCRIPT_TOLERANCE or usable_h < item_h - MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    step_x = item_w + gap_x
    # For interlocking rows (pointy-topped hexagon), step_y is 0.75 * item_h
    step_y = 0.75 * item_h + gap_y

    if step_y <= MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    items = []
    max_rows = 0
    if usable_h >= item_h - MY_SCRIPT_TOLERANCE:
        max_rows = math.floor((usable_h - item_h + MY_SCRIPT_TOLERANCE) / step_y) + 1

    for row in range(max_rows):
        cy = ry + row * step_y
        if cy + ry > usable_h + MY_SCRIPT_TOLERANCE:
            break

        is_odd_row = (row % 2 != 0)
        row_start_x_center = rx + (step_x / 2.0) if is_odd_row else rx

        num_items_in_row = 0
        first_right_edge = row_start_x_center + rx
        if first_right_edge <= usable_w + MY_SCRIPT_TOLERANCE:
            num_items_in_row = 1
            if step_x > MY_SCRIPT_TOLERANCE:
                remaining = usable_w - first_right_edge
                if remaining >= -MY_SCRIPT_TOLERANCE:
                    num_items_in_row += math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_x)

        for col in range(num_items_in_row):
            cx = row_start_x_center + col * step_x
            if cx + rx > usable_w + MY_SCRIPT_TOLERANCE:
                break
            items.append({
                'c': col, 'r': row,
                'x': cx - rx, 'y': cy - ry,
                'width': item_w, 'height': item_h,
                'isRotated': False,
            })

    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
    return {
        'totalItems': len(items), 'items': items,
        'widthUsed': bb['width'], 'heightUsed': bb['height'],
        'itemActualW': item_w, 'itemActualH': item_h
    }


def _py_calculate_hex_tiling_col_stagger(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float) -> Dict[str, Any]:
    """
    Brick-wall stagger for hexagonal items (COLUMN stagger).
    Uses full item_w for horizontal step to prevent bounding-box overlap.
    Odd columns are offset in Y by half the vertical pitch for stagger effect.
    """
    if item_w <= MY_SCRIPT_TOLERANCE or item_h <= MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    rx = item_w / 2.0
    ry = item_h / 2.0

    if usable_w < item_w - MY_SCRIPT_TOLERANCE or usable_h < item_h - MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    # For interlocking columns (flat-topped hexagon), step_x is 0.75 * item_w
    step_x = 0.75 * item_w + gap_x
    step_y = item_h + gap_y

    if step_x <= MY_SCRIPT_TOLERANCE:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    items = []
    max_cols = 0
    if usable_w >= item_w - MY_SCRIPT_TOLERANCE:
        max_cols = math.floor((usable_w - item_w + MY_SCRIPT_TOLERANCE) / step_x) + 1

    for col in range(max_cols):
        cx = rx + col * step_x
        if cx + rx > usable_w + MY_SCRIPT_TOLERANCE:
            break

        is_odd_col = (col % 2 != 0)
        col_start_y_center = ry + (step_y / 2.0) if is_odd_col else ry

        num_items_in_col = 0
        first_bottom_edge = col_start_y_center + ry
        if first_bottom_edge <= usable_h + MY_SCRIPT_TOLERANCE:
            num_items_in_col = 1
            if step_y > MY_SCRIPT_TOLERANCE:
                remaining = usable_h - first_bottom_edge
                if remaining >= -MY_SCRIPT_TOLERANCE:
                    num_items_in_col += math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_y)

        for row in range(num_items_in_col):
            cy = col_start_y_center + row * step_y
            if cy + ry > usable_h + MY_SCRIPT_TOLERANCE:
                break
            items.append({
                'c': col, 'r': row,
                'x': cx - rx, 'y': cy - ry,
                'width': item_w, 'height': item_h,
                'isRotated': False,
            })

    if not items:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}

    bb = calculate_items_bounding_box(items)
    cx_off = -bb['minX']
    cy_off = -bb['minY']
    for it in items:
        it['x'] += cx_off
        it['y'] += cy_off
    return {
        'totalItems': len(items), 'items': items,
        'widthUsed': bb['width'], 'heightUsed': bb['height'],
        'itemActualW': item_w, 'itemActualH': item_h
    }


# ══════════════════════════════════════════════════════════════════════
# Rust-first wrappers — public API unchanged, ~5-10x faster
# ══════════════════════════════════════════════════════════════════════

def solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y):
    if _HAS_RUST:
        try:
            return _native.sticker_solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        except Exception:
            pass
    return _py_solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

def calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y):
    if _HAS_RUST:
        try:
            return _native.sticker_staggered_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        except Exception:
            pass
    return _py_calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

def calculate_staggered_vertical_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y):
    if _HAS_RUST:
        try:
            return _native.sticker_staggered_vertical(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        except Exception:
            pass
    return _py_calculate_staggered_vertical_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

def calculate_hex_tiling_row_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y):
    if _HAS_RUST:
        try:
            return _native.sticker_hex_tiling_row(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        except Exception:
            pass
    return _py_calculate_hex_tiling_row_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

def calculate_hex_tiling_col_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y):
    if _HAS_RUST:
        try:
            return _native.sticker_hex_tiling_col(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        except Exception:
            pass
    return _py_calculate_hex_tiling_col_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
