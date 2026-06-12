"""
N-Up Grid Layout Solver.

Tries Rust native module first (fast), falls back to Python implementation.
"""

import math
import logging
import os

logger = logging.getLogger(__name__)
from typing import List, Dict, Any

# ── Chính sách Rust/fallback (Req 7) ────────────────────────
# Mặc định: Rust là bắt buộc. Nếu Rust thiếu → FAIL-FAST (không âm thầm cho kết
# quả khác). Đặt IMPOSITION_ALLOW_PY_FALLBACK=1 để cho phép fallback Python
# (có log cảnh báo; KHÔNG đảm bảo parity — xem tests/parity/KNOWN_DIVERGENCES.md).
_FORCE_PY = os.environ.get('IMPOSITION_ALLOW_PY_FALLBACK', '0') == '1'
_FALLBACK_WARNED = False

# ── Try Rust native solver ──────────────────────────────────
try:
    from pdfcompare_native import (
        solve_grid as _rust_solve_grid,
        solve_optimal_layout as _rust_solve_optimal,
        get_src_page_idx as _rust_get_src_page_idx,
    )
    try:
        from pdfcompare_native import solve_manual as _rust_solve_manual
    except ImportError:
        _rust_solve_manual = None
    _RUST_AVAILABLE = True
except ImportError:
    _RUST_AVAILABLE = False
    _rust_solve_manual = None

# Dùng Rust trừ khi bị ép sang Python (để test parity).
_USE_RUST = _RUST_AVAILABLE and not _FORCE_PY


def _allow_python_path():
    """Gọi trước khi dùng nhánh Python. Fail-fast nếu Rust thiếu mà fallback tắt."""
    global _FALLBACK_WARNED
    if _FORCE_PY:
        if not _FALLBACK_WARNED:
            logger.warning(
                "[IMPOSITION] Dùng fallback Python (IMPOSITION_ALLOW_PY_FALLBACK=1) "
                "— KHÔNG đảm bảo parity với Rust. Xem KNOWN_DIVERGENCES.md."
            )
            _FALLBACK_WARNED = True
        return
    if not _RUST_AVAILABLE:
        raise RuntimeError(
            "imposition_core (Rust 'pdfcompare_native') không khả dụng và fallback đang TẮT. "
            "Build/cài module Rust, hoặc đặt IMPOSITION_ALLOW_PY_FALLBACK=1 nếu chấp nhận "
            "khác biệt parity (không khuyến nghị cho production)."
        )


# ── Python fallback implementations ────────────────────────

def _py_solve_grid(usable_w: float, usable_h: float, item_w: float, item_h: float,
                   gap_x: float, gap_y: float, is_rotated: bool = False) -> dict:
    """Calculate basic grid placement (cols × rows) for given dimensions."""
    step_x = item_w + gap_x
    step_y = item_h + gap_y

    cols = 0
    if usable_w + 0.01 >= item_w:
        cols = int((usable_w - item_w + 0.01) / step_x) + 1
    cols = max(0, cols)

    rows = 0
    if usable_h + 0.01 >= item_h:
        rows = int((usable_h - item_h + 0.01) / step_y) + 1
    rows = max(0, rows)

    logger.info(f"   [SOLVER DEBUG] _py_solve_grid: usable={usable_w:.2f}x{usable_h:.2f}, item={item_w:.2f}x{item_h:.2f}, gap={gap_x:.2f}x{gap_y:.2f} -> cols={cols}, rows={rows}")

    block_w = cols * item_w + (max(0, cols - 1) * gap_x)
    while cols > 0 and block_w > usable_w + 0.01:
        cols -= 1
        block_w = cols * item_w + (max(0, cols - 1) * gap_x)

    block_h = rows * item_h + (max(0, rows - 1) * gap_y)
    while rows > 0 and block_h > usable_h + 0.01:
        rows -= 1
        block_h = rows * item_h + (max(0, rows - 1) * gap_y)

    cells = []
    for r in range(rows):
        for c in range(cols):
            cells.append({
                'c': c, 'r': r,
                'x': c * step_x,
                'y': r * step_y,
                'width': item_w,
                'height': item_h,
                'isRotated': is_rotated,
            })

    return {
        'cols': cols, 'rows': rows,
        'width': block_w, 'height': block_h,
        'cells': cells, 'isRotated': is_rotated,
    }


def _py_solve_optimal_layout(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy='simple_auto', secondary_gap=None):
    """Solve optimal N-Up grid layout (mirrors NupGridSolver.ts logic)."""
    if strategy == 'simple_auto':
        p1 = _py_solve_grid(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, False)
        p2 = _py_solve_grid(usable_w, usable_h, orig_h, orig_w, gap_x, gap_y, True)
        best = p1 if len(p1['cells']) >= len(p2['cells']) else p2
        return {
            'totalItems': len(best['cells']),
            'overallWidth': best['width'],
            'overallHeight': best['height'],
            'cells': best['cells'],
            'isRotated': best['isRotated'],
            'cols': best['cols'],
            'rows': best['rows'],
        }

    # optimal_auto: try L-shape fill (main + fill blocks)
    def try_config(main_w, main_h, fill_w, fill_h, primary_rotated):
        split_gap = secondary_gap if secondary_gap is not None else max(gap_x, gap_y)
        max_grid = _py_solve_grid(usable_w, usable_h, main_w, main_h, gap_x, gap_y, primary_rotated)
        best_yield = 0
        best_cells = []
        best_w = 0
        best_h = 0

        for reduce_c in range(min(2, max_grid['cols'])):
            for reduce_r in range(min(2, max_grid['rows'])):
                if reduce_c > 0 and reduce_r > 0:
                    continue
                tc = max(0, max_grid['cols'] - reduce_c)
                tr = max(0, max_grid['rows'] - reduce_r)
                if tc == 0 or tr == 0:
                    continue

                tbw = tc * main_w + max(0, tc - 1) * gap_x
                tbh = tr * main_h + max(0, tr - 1) * gap_y

                main_block = _py_solve_grid(tbw, tbh, main_w, main_h, gap_x, gap_y, primary_rotated)
                all_cells = list(main_block['cells'])

                # Right fill
                right_x = tbw + split_gap
                right_w = usable_w - right_x
                fill_r_actual_h = tbh
                if right_w > 0.01:
                    fill_r = _py_solve_grid(right_w, usable_h, fill_w, fill_h, gap_x, gap_y, not primary_rotated)
                    if fill_r['cells']:
                        fill_r_actual_h = fill_r['height']
                        for c in fill_r['cells']:
                            c['x'] += right_x
                            c['blockId'] = 1  # cụm fill phải — dấu xén riêng
                            all_cells.append(c)

                # Bottom fill
                overall_h = max(tbh, fill_r_actual_h)
                actual_bottom_y = overall_h + split_gap
                actual_bottom_h = usable_h - actual_bottom_y
                if actual_bottom_h > 0.01:
                    fill_b = _py_solve_grid(usable_w, actual_bottom_h, fill_w, fill_h, gap_x, gap_y, not primary_rotated)
                    for c in fill_b['cells']:
                        c['y'] += actual_bottom_y
                        c['blockId'] = 2  # cụm fill đáy — dấu xén riêng
                        all_cells.append(c)

                if len(all_cells) > best_yield:
                    best_yield = len(all_cells)
                    best_cells = all_cells
                    max_right = max((c['x'] + c['width'] for c in all_cells), default=0)
                    max_bottom = max((c['y'] + c['height'] for c in all_cells), default=0)
                    best_w = max_right
                    best_h = max_bottom

        return best_yield, best_cells, best_w, best_h

    y1, c1, w1, h1 = try_config(orig_w, orig_h, orig_h, orig_w, False)
    y2, c2, w2, h2 = try_config(orig_h, orig_w, orig_w, orig_h, True)

    if y1 >= y2:
        l_yield, l_cells, l_w, l_h, l_rot = y1, c1, w1, h1, False
    else:
        l_yield, l_cells, l_w, l_h, l_rot = y2, c2, w2, h2, True

    # Ưu tiên LƯỚI ĐƠN GIẢN khi hòa số lượng (sạch, dễ cắt) — khớp Rust core.
    g1 = _py_solve_grid(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, False)
    g2 = _py_solve_grid(usable_w, usable_h, orig_h, orig_w, gap_x, gap_y, True)
    grid_best = g1 if len(g1['cells']) >= len(g2['cells']) else g2
    if len(grid_best['cells']) >= l_yield:
        return {
            'totalItems': len(grid_best['cells']),
            'cells': grid_best['cells'],
            'overallWidth': grid_best['width'],
            'overallHeight': grid_best['height'],
            'cols': grid_best['cols'],
            'rows': grid_best['rows'],
            'isRotated': grid_best['isRotated'],
        }

    return {'totalItems': l_yield, 'cells': l_cells, 'overallWidth': l_w, 'overallHeight': l_h,
            'cols': 0, 'rows': 0, 'isRotated': l_rot}


def _py_get_src_page_idx(sheet_idx, cell_on_sheet_idx, layout_type, total_capacity, page_count):
    """Calculate source page index for a given cell position."""
    if layout_type == 'repeat':
        return sheet_idx
    elif layout_type == 'cut_stacks':
        stack_depth = math.ceil(page_count / total_capacity)
        return cell_on_sheet_idx * stack_depth + sheet_idx
    else:  # sequential
        return sheet_idx * total_capacity + cell_on_sheet_idx


# ── Public API (Rust-first, Python-fallback) ────────────────

def solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated=False):
    if _USE_RUST:
        return _rust_solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated)
    _allow_python_path()
    return _py_solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated)


def solve_optimal_layout(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy='simple_auto', secondary_gap=None):
    if _USE_RUST:
        res = _rust_solve_optimal(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy, secondary_gap)
    else:
        _allow_python_path()
        res = _py_solve_optimal_layout(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy, secondary_gap)
    # ── DEBUG MARKER (Task: chẩn đoán grid-preference) ──
    try:
        cells = res.get('cells', [])
        rots = {bool(c.get('isRotated')) for c in cells}
        logger.warning(
            "[IMPOSITION_BUILD=grid-pref-v2] strategy=%s engine=%s items=%s uniform=%s",
            strategy, "rust" if _USE_RUST else "python", res.get('totalItems'), len(rots) <= 1,
        )
    except Exception:
        pass
    return res


def get_src_page_idx(sheet_idx, cell_on_sheet_idx, layout_type, total_capacity, page_count):
    if _USE_RUST:
        return _rust_get_src_page_idx(sheet_idx, cell_on_sheet_idx, layout_type, total_capacity, page_count)
    _allow_python_path()
    return _py_get_src_page_idx(sheet_idx, cell_on_sheet_idx, layout_type, total_capacity, page_count)


def _py_solve_manual(item_w, item_h, gap_x, gap_y, cols, rows):
    """Lưới thủ công đúng cols×rows (Req 4.3) — fallback Python."""
    cols = min(int(cols), 2000)
    rows = min(int(rows), 2000)
    step_x = item_w + gap_x
    step_y = item_h + gap_y
    cells = []
    for r in range(rows):
        for c in range(cols):
            cells.append({
                'c': c, 'r': r,
                'x': c * step_x, 'y': r * step_y,
                'width': item_w, 'height': item_h,
                'isRotated': False,
            })
    overall_w = cols * item_w + (cols - 1) * gap_x if cols > 0 else 0.0
    overall_h = rows * item_h + (rows - 1) * gap_y if rows > 0 else 0.0
    return {
        'totalItems': len(cells),
        'overallWidth': overall_w,
        'overallHeight': overall_h,
        'cells': cells,
        'isRotated': False,
        'cols': cols, 'rows': rows,
    }


def solve_manual(item_w, item_h, gap_x, gap_y, cols, rows):
    if _USE_RUST and _rust_solve_manual is not None:
        return _rust_solve_manual(item_w, item_h, gap_x, gap_y, int(cols), int(rows))
    _allow_python_path()
    return _py_solve_manual(item_w, item_h, gap_x, gap_y, cols, rows)
