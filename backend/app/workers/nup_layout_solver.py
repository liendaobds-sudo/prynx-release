"""
N-Up Grid Layout Solver.

Tries Rust native module first (fast), falls back to Python implementation.
"""

import math
import logging
import os

logger = logging.getLogger(__name__)
from typing import List, Dict, Any, Optional

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
    try:
        from pdfcompare_native import solve_ratio_stack as _rust_solve_ratio_stack
    except ImportError:
        _rust_solve_ratio_stack = None
    _RUST_AVAILABLE = True
except ImportError:
    _RUST_AVAILABLE = False
    _rust_solve_manual = None
    _rust_solve_ratio_stack = None

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
        logger.debug(
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


def compute_ratio_stack_alloc(capacity: int, qtys: List[int]) -> Dict[str, Any]:
    """Phân bổ `capacity` ô của 1 tờ cho các mẫu theo TỶ LỆ số lượng (N-Up cắt xén,
    Phase 1 cùng cỡ). Trả {cellsPerPage: list[int], nSheets: int, unplaced: list[int]}.

    Rust là BẮT BUỘC (fail-fast) — nhất quán chính sách solver imposition. Không có
    fallback Python vì đây là tính năng mới, không cần parity ngược.
    """
    if _rust_solve_ratio_stack is None:
        raise RuntimeError(
            "pdfcompare_native.solve_ratio_stack không khả dụng — build lại module Rust "
            "(cd native && cargo build --release, copy .dll → .pyd trong venv)."
        )
    return _rust_solve_ratio_stack(int(capacity), [int(q) for q in qtys])


def compute_ratio_stack_templates(
    capacity: int, qtys: List[int]
) -> List[Dict[str, Any]]:
    """[RATIO-STACK FIX 2026-08-03] Lập toàn bộ tờ mẫu khi số loại vượt sức chứa.

    Bộ giải Rust :func:`compute_ratio_stack_alloc` cố ý chỉ giải *một* tờ và trả
    các loại chưa có ô trong ``unplaced``. Tầng điều phối này gọi bộ giải nhiều
    lần, nhưng mỗi loại chỉ thuộc một tờ mẫu để vị trí ô luôn cố định xuyên suốt
    chồng giấy.

    Khi mọi loại có cùng số lượng và bị tràn tờ, mỗi loại nhận đúng một ô. Các ô
    thừa ở tờ cuối được để trống vì lấp chúng bằng bản sao chỉ làm in dư, không
    giảm số lượt chạy tờ. Trường hợp tất cả loại vừa một tờ vẫn giữ nguyên cách
    chia đầy tờ hiện có để không đổi hành vi cũ.
    """
    capacity = max(0, int(capacity))
    normalized_qtys = [max(0, int(q)) for q in qtys]
    if capacity <= 0 or not normalized_qtys:
        return []

    active = [i for i, q in enumerate(normalized_qtys) if q > 0]
    auto_fill = not active
    candidates = list(range(len(normalized_qtys))) if auto_fill else active

    # Một tờ vẫn dùng nguyên bộ giải cũ: tỷ lệ và hành vi tự lấp đầy không đổi.
    if len(candidates) <= capacity:
        alloc = compute_ratio_stack_alloc(capacity, normalized_qtys)
        cells = [int(value) for value in alloc.get('cellsPerPage', [])]
        return [{
            'cellsPerPage': cells,
            'nSheets': max(1, int(alloc.get('nSheets') or 1)),
            'unplaced': list(alloc.get('unplaced', [])),
            'pageIndices': [i for i, count in enumerate(cells) if count > 0],
        }]

    templates: List[Dict[str, Any]] = []
    pending = list(candidates)
    while pending:
        pending_values = [
            (1 if auto_fill else normalized_qtys[i]) for i in pending
        ]
        equal_quantities = len(set(pending_values)) == 1

        if equal_quantities:
            # Không lấp ô thừa bằng bản sao: mọi loại vẫn cần cùng số lượt in.
            placed = pending[:capacity]
            cells = [0] * len(normalized_qtys)
            for page_idx in placed:
                cells[page_idx] = 1
            run_count = 1 if auto_fill else pending_values[0]
        else:
            pending_set = set(pending)
            masked_qtys = [
                normalized_qtys[i] if i in pending_set else 0
                for i in range(len(normalized_qtys))
            ]
            alloc = compute_ratio_stack_alloc(capacity, masked_qtys)
            cells = [int(value) for value in alloc.get('cellsPerPage', [])]
            placed = [i for i in pending if i < len(cells) and cells[i] > 0]
            run_count = max(1, int(alloc.get('nSheets') or 1))

        if not placed:
            # Phòng thủ chống vòng lặp vô hạn nếu binding native trả dữ liệu lỗi.
            raise RuntimeError("Không thể phân mẫu sang tờ ratio_stack tiếp theo.")

        templates.append({
            'cellsPerPage': cells,
            'nSheets': max(1, int(run_count)),
            'unplaced': [],
            'pageIndices': list(placed),
        })
        placed_set = set(placed)
        pending = [i for i in pending if i not in placed_set]

    return templates


def build_guillotine_preview_sheet(
    cells: List[Dict[str, Any]],
    page_indices: List[int],
    *,
    usable_w: float,
    usable_h: float,
    margin_left: float = 0.0,
    margin_right: float = 0.0,
    margin_bottom: float = 0.0,
    margin_top: float = 0.0,
    sheet_w: float = 0.0,
    sheet_h: float = 0.0,
    align: str = 'center',
    run_count: Optional[int] = None,
    physical_sheet_index: Optional[int] = None,
) -> Dict[str, Any]:
    """BUILD (audit 2026-08-03 §REL.02): dựng một tờ preview tuyệt đối.

    Hàm thuần dùng chung cho ratio-stack, sequential và cut-stacks. Tọa độ ô
    của solver có gốc trên-trái trong khối; ``absY`` được đổi sang hệ gốc dưới
    của tờ in đúng như route cũ.
    """
    used_cells = cells[:min(len(cells), len(page_indices))]
    block_w = max((c['x'] + c['width'] for c in used_cells), default=0.0)
    block_h = max((c['y'] + c['height'] for c in used_cells), default=0.0)
    align = align if isinstance(align, str) else 'center'

    if 'left' in align:
        base_x = margin_left
    elif 'right' in align and sheet_w > 0:
        base_x = sheet_w - margin_right - block_w
    else:
        base_x = margin_left + (usable_w - block_w) / 2
    if 'top' in align and sheet_h > 0:
        base_y = sheet_h - margin_top - block_h
    elif 'bottom' in align:
        base_y = margin_bottom
    else:
        base_y = margin_bottom + (usable_h - block_h) / 2

    items = []
    placed_by_page: Dict[str, int] = {}
    overall_w = 0.0
    overall_h = 0.0
    for cell, page_idx in zip(used_cells, page_indices):
        abs_x = base_x + cell['x']
        abs_y = base_y + (block_h - cell['y'] - cell['height'])
        items.append({
            'x': cell['x'], 'y': cell['y'],
            'absX': abs_x, 'absY': abs_y,
            'width': cell['width'], 'height': cell['height'],
            'isRotated': bool(cell.get('isRotated', False)),
            'isRotated180': False,
            'pageIdx': page_idx,
        })
        page_key = str(page_idx)
        placed_by_page[page_key] = placed_by_page.get(page_key, 0) + 1
        overall_w = max(overall_w, abs_x + cell['width'])
        overall_h = max(overall_h, abs_y + cell['height'])

    result = {
        'cells': items,
        'overallWidth': overall_w,
        'overallHeight': overall_h,
        'totalItems': len(items),
        'placedByPage': placed_by_page,
    }
    if run_count is not None:
        result['runCount'] = max(1, int(run_count))
    if physical_sheet_index is not None:
        result['physicalSheetIndex'] = int(physical_sheet_index)
    return result


def build_mixed_preview_response(
    sheet: Dict[str, Any],
    strategy: str,
    sheets_needed: int,
    *,
    ratio_unplaced: Optional[List[int]] = None,
    output_pages_needed: Optional[int] = None,
    template_sheets: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Bọc dữ liệu tờ thành contract API preview mà không phụ thuộc FastAPI."""
    result = {
        'success': True,
        'cells': sheet['cells'],
        'overallWidth': sheet['overallWidth'],
        'overallHeight': sheet['overallHeight'],
        'totalItems': sheet['totalItems'],
        'strategyUsed': strategy,
        'isMixedPreview': True,
        'absPlacement': True,
        'sheetsNeeded': max(1, int(sheets_needed)),
        'ratioUnplaced': list(ratio_unplaced or []),
        'placedByPage': sheet['placedByPage'],
    }
    if output_pages_needed is not None:
        result['outputPagesNeeded'] = max(1, int(output_pages_needed))
    if template_sheets is not None:
        result['templateCount'] = len(template_sheets)
        if len(template_sheets) > 1:
            result['sheets'] = template_sheets
    return result


def compute_cluster_type_alloc(
    total_lines: int, lines_cross: int, qtys: List[int]
) -> Dict[str, Any]:
    """Chia CỌC theo LOẠI (guillotine batching) cho N-Up "chia tỷ lệ + xếp chồng".

    Mỗi loại = 1 CỌC (dải cột dọc ở mode 'column', dải hàng ngang ở mode 'row') có rãnh
    dao + dấu xén riêng → xén cả chồng ra mỗi cọc một loại, khỏi phân loại lại. BỀ RỘNG
    cọc (số dòng lưới) TỶ LỆ với SL: loại SL cao chiếm nhiều dòng hơn → số tờ cân bằng,
    không dư thừa. Mọi loại nằm trên CÙNG 1 tờ mẫu (không nhân bản kiểu tờ).

    "dòng" (line) = CỘT ở mode 'column' (chia dọc), = HÀNG ở mode 'row' (chia ngang).
    Phân total_lines cho các loại theo tỷ lệ SL (largest-remainder, min 1 dòng/loại có
    SL>0) — tái dùng compute_ratio_stack_alloc ở mức DÒNG.

    Args:
      total_lines: tổng số dòng lưới đầy đủ (cols ở mode column / rows ở mode row).
      lines_cross: số ô theo chiều vuông góc (rows ở mode column / cols ở mode row) —
        để tính số ô mỗi loại = linesPerType × lines_cross → số tờ.
      qtys: SL mỗi loại (index = loại; ≤0 = không in).

    Trả:
      {
        'linesPerType': [số dòng mỗi loại]*n_types,  # 0 = loại không được cấp dòng
        'nSheets': int,                              # số tờ in (max theo loại thiếu nhất)
        'unplaced': [type có SL>0 nhưng không đủ dòng],
      }
    """
    total_lines = max(0, int(total_lines))
    lines_cross = max(0, int(lines_cross))
    qtys = [max(0, int(q)) for q in qtys]
    active = [t for t, q in enumerate(qtys) if q > 0]

    if total_lines == 0 or lines_cross == 0 or not qtys:
        return {'linesPerType': [0] * len(qtys), 'nSheets': 1, 'unplaced': list(active)}

    # SL trống (mọi loại = 0) → CHIA ĐỀU dòng cho mọi loại (lấp đầy 1 tờ mẫu), khớp
    # hành vi ratio_stack "Trống = tự động lấp đầy 1 tờ". compute_ratio_stack_alloc tự
    # xử lý cả 2 ca: có SL → theo tỷ lệ (min 1 dòng/loại SL>0); trống → chia đều.
    alloc = compute_ratio_stack_alloc(total_lines, qtys)
    lines_of = list(alloc['cellsPerPage'])  # index = loại, giá trị = số dòng
    unplaced = list(alloc.get('unplaced', []))

    # Số tờ = max theo loại có SL>0: ceil(qty / (số_dòng_loại × lines_cross)). SL trống
    # → không loại nào áp đặt → 1 tờ mẫu.
    n_sheets = 1
    for t in active:
        cells_t = int(lines_of[t]) * lines_cross
        if cells_t > 0:
            n_sheets = max(n_sheets, math.ceil(qtys[t] / cells_t))

    return {'linesPerType': lines_of, 'nSheets': n_sheets, 'unplaced': unplaced}
