"""
MaxRects Bin Packing for N-Up Multi-Design Sticker Imposition.

Algorithm: MaxRects Best Short Side Fit (BSSF)
Reference: "A Greedy Algorithm with Forward-Looking Strategy" (Chen & Huang, 2007)
           Same family as DirectEnpack's corner-occupying approach.

How it works:
1. Start with 1 free rectangle = the entire sheet
2. For each item to place (sorted by area, largest first):
   - Find the free rect where the item fits with the smallest leftover on its shorter side
   - Place item at bottom-left corner of that free rect
   - Split the free rect into up to 4 new free rects (maximal rectangles)
   - Remove any free rects fully contained by another
3. Return placement list

Advantages over strip-based:
- Items of DIFFERENT sizes freely compete for all positions
- No wasted space between strips
- Gap filling is inherent (no need for Phase 3 gap scanner)
"""

from typing import List, Dict, Tuple, Optional
import logging

logger = logging.getLogger(__name__)


def _q6(v: float) -> float:
    """Làm tròn 6 chữ số (1e-6pt ≈ 3.5e-7mm — vô nghĩa thực tế) để TRIỆT TIÊU nhiễu
    dấu-phẩy-động do KHÁC THỨ TỰ phép tính usable giữa frontend ((sheet-lề)*k) và
    backend (sheet*k - lề*k). Chênh ~1e-13 từng làm packing biên lật số ô → preview
    ≠ output (cả CNC lẫn Bình Tem Bế đều dùng solver này). Xác minh thực tế."""
    try:
        return round(float(v), 6)
    except (TypeError, ValueError):
        return v


def solve_mixed_bin_pack(
    sheet_w: float,
    sheet_h: float,
    items: List[Tuple[int, float, float, int]],
    gap: float = 0.0,
    allow_rotation: bool = True,
    exclude_zones: Optional[List[Tuple[float, float, float, float]]] = None,
) -> Dict:
    """
    Pack multiple item types with specified quantities onto one sheet.

    Args:
        sheet_w:        Sheet width in points
        sheet_h:        Sheet height in points
        items:          List of (page_idx, item_w, item_h, qty)
        gap:            Gap between items in points
        allow_rotation: Allow 90° rotation
        exclude_zones:  List of (x, y, w, h) zones to exclude (e.g. pont/ốc marks)

    Returns:
        {
            'placements': [{'page_idx', 'x', 'y', 'w', 'h', 'is_rotated'}, ...],
            'total_placed': int,
            'placed_by_page': {page_idx: count, ...},
        }
    """
    if not items:
        return {'placements': [], 'total_placed': 0, 'placed_by_page': {}}

    sheet_w = _q6(sheet_w); sheet_h = _q6(sheet_h); gap = _q6(gap)

    # Build flat list of rectangles to place
    # Each rect: (page_idx, w_with_gap, h_with_gap, original_w, original_h)
    rects = []
    for page_idx, w, h, qty in items:
        for _ in range(qty):
            rects.append((page_idx, w + gap, h + gap, w, h))

    # Sort by area descending (largest first = better packing)
    rects.sort(key=lambda r: r[1] * r[2], reverse=True)

    packer = _MaxRectsPacker(sheet_w, sheet_h)
    # Pre-exclude forbidden zones so items never overlap them
    if exclude_zones:
        for zone in exclude_zones:
            packer.exclude(*zone)
    placements = []
    placed_by_page = {}

    for page_idx, w_gap, h_gap, orig_w, orig_h in rects:
        result = packer.insert(w_gap, h_gap, allow_rotation)
        if result is not None:
            rx, ry, rw, rh = result
            is_rotated = (abs(rw - w_gap) > 0.01)  # rotated if dims swapped
            # Center the actual item within its gap-padded cell
            display_w = orig_h if is_rotated else orig_w
            display_h = orig_w if is_rotated else orig_h
            placements.append({
                'page_idx': page_idx,
                'x': rx + gap / 2,
                'y': ry + gap / 2,
                'w': display_w,
                'h': display_h,
                'is_rotated': is_rotated,
            })
            placed_by_page[page_idx] = placed_by_page.get(page_idx, 0) + 1

    return {
        'placements': placements,
        'total_placed': len(placements),
        'placed_by_page': placed_by_page,
    }


def solve_auto_fill_mixed(
    sheet_w: float,
    sheet_h: float,
    page_dims: List[Tuple[int, float, float]],
    gap: float = 0.0,
    allow_rotation: bool = True,
    exclude_zones: Optional[List[Tuple[float, float, float, float]]] = None,
    uniform_if_equal: bool = False,
) -> Dict:
    """
    Auto-fill: pack as many items as possible of each type onto 1 sheet.
    Phase 1: Binary search for max balanced qty per type.
    Phase 2: Greedy fill — keep stuffing whatever fits into remaining gaps.
    
    exclude_zones: List of (x, y, w, h) zones to exclude (e.g. pont/ốc marks)
                   Items will never be placed in these areas.
    """
    if not page_dims:
        return {'placements': [], 'total_placed': 0, 'placed_by_page': {}}

    sheet_w = _q6(sheet_w); sheet_h = _q6(sheet_h); gap = _q6(gap)

    # 1 Dao + theo kích thước trang: nếu mọi mẫu cùng cỡ thì tất cả là cùng một
    # hình chữ nhật. MaxRects xoay từng mẫu độc lập sẽ tạo layout vá víu dù không
    # tăng sức chứa. Dùng một hướng duy nhất cho cả tờ và rải page_idx tuần tự.
    if uniform_if_equal and _all_page_dims_equal(page_dims):
        return _solve_uniform_auto_fill(
            sheet_w, sheet_h, page_dims, gap, allow_rotation, exclude_zones
        )

    n_types = len(page_dims)

    # Estimate max capacity per type if placed alone
    max_per_type = []
    sum_type_area = 0.0
    for page_idx, w, h in page_dims:
        w_g = w + gap
        h_g = h + gap
        c1 = max(1, int(sheet_w / w_g)) * max(1, int(sheet_h / h_g))
        c2 = max(1, int(sheet_w / h_g)) * max(1, int(sheet_h / w_g))
        max_per_type.append(max(c1, c2))
        sum_type_area += w_g * h_g

    # Phase 1: Binary search for max balanced qty per type
    best_qty = 1
    # Cận trên CHẶT mà vẫn HỢP LỆ (≥ đáp án thật) → best_qty không đổi, chỉ ít vòng hơn:
    #  • balanced cần `qty` bản của MỖI loại ⇒ qty ≤ min(sức chứa từng loại khi đứng riêng).
    #    (dùng max(max_per_type) như cũ là cận lỏng, ép binary search dò vùng vô ích.)
    #  • mỗi bộ cân bằng tốn ≥ Σ diện-tích-các-loại ⇒ qty ≤ sheet_area / Σ area.
    area_bound = int((sheet_w * sheet_h) / sum_type_area) if sum_type_area > 0 else 1
    hi = max(1, min(min(max_per_type), area_bound))
    lo = 1

    for _ in range(20):
        qty = (lo + hi) // 2
        items = [(p_idx, w, h, qty) for p_idx, w, h in page_dims]
        result = solve_mixed_bin_pack(sheet_w, sheet_h, items, gap, allow_rotation, exclude_zones)

        expected = qty * n_types
        if result['total_placed'] >= expected:
            best_qty = qty
            lo = qty + 1
        else:
            hi = qty - 1

        if lo > hi:
            break

    # Phase 2: Greedy fill — start from best balanced qty and keep adding
    # Use a fresh packer so items are placed in order
    packer = _MaxRectsPacker(sheet_w, sheet_h)
    # Pre-exclude forbidden zones
    if exclude_zones:
        for zone in exclude_zones:
            packer.exclude(*zone)
    placements = []
    placed_by_page = {}

    # First: place the balanced qty for all types
    for p_idx, w, h in page_dims:
        w_g = w + gap
        h_g = h + gap
        for _ in range(best_qty):
            result = packer.insert(w_g, h_g, allow_rotation)
            if result is not None:
                rx, ry, rw, rh = result
                is_rotated = (abs(rw - w_g) > 0.01)
                dw = h if is_rotated else w
                dh = w if is_rotated else h
                placements.append({
                    'page_idx': p_idx,
                    'x': rx + gap / 2, 'y': ry + gap / 2,
                    'w': dw, 'h': dh,
                    'is_rotated': is_rotated,
                })
                placed_by_page[p_idx] = placed_by_page.get(p_idx, 0) + 1

    # Then: greedy round-robin fill remaining gaps
    # Sort types by area (smallest first — they fit in smaller gaps)
    fill_order = sorted(range(n_types), key=lambda i: page_dims[i][1] * page_dims[i][2])
    max_greedy_rounds = 50  # safety cap
    for _ in range(max_greedy_rounds):
        any_placed = False
        for ti in fill_order:
            p_idx, w, h = page_dims[ti]
            w_g = w + gap
            h_g = h + gap
            result = packer.insert(w_g, h_g, allow_rotation)
            if result is not None:
                rx, ry, rw, rh = result
                is_rotated = (abs(rw - w_g) > 0.01)
                dw = h if is_rotated else w
                dh = w if is_rotated else h
                placements.append({
                    'page_idx': p_idx,
                    'x': rx + gap / 2, 'y': ry + gap / 2,
                    'w': dw, 'h': dh,
                    'is_rotated': is_rotated,
                })
                placed_by_page[p_idx] = placed_by_page.get(p_idx, 0) + 1
                any_placed = True
        if not any_placed:
            break

    return {
        'placements': placements,
        'total_placed': len(placements),
        'placed_by_page': placed_by_page,
    }


def _all_page_dims_equal(
    page_dims: List[Tuple[int, float, float]],
    tolerance: float = 0.1,
) -> bool:
    if not page_dims:
        return False
    _, base_w, base_h = page_dims[0]
    return all(
        abs(float(w) - float(base_w)) <= tolerance
        and abs(float(h) - float(base_h)) <= tolerance
        for _, w, h in page_dims[1:]
    )


def _solve_uniform_auto_fill(
    sheet_w: float,
    sheet_h: float,
    page_dims: List[Tuple[int, float, float]],
    gap: float,
    allow_rotation: bool,
    exclude_zones: Optional[List[Tuple[float, float, float, float]]],
) -> Dict:
    """Build one regular grid, then assign designs round-robin to its cells."""
    _, item_w, item_h = page_dims[0]

    def _overlaps_zone(x, y, w, h):
        for zx, zy, zw, zh in (exclude_zones or []):
            if x < zx + zw and x + w > zx and y < zy + zh and y + h > zy:
                return True
        return False

    def _candidate(rotated):
        cell_w, cell_h = (item_h, item_w) if rotated else (item_w, item_h)
        if cell_w <= 0 or cell_h <= 0:
            return [], cell_w, cell_h
        cols = max(0, int((sheet_w + gap) / (cell_w + gap)))
        rows = max(0, int((sheet_h + gap) / (cell_h + gap)))
        used_w = cols * cell_w + max(0, cols - 1) * gap
        used_h = rows * cell_h + max(0, rows - 1) * gap
        centered_x = max(0.0, (sheet_w - used_w) / 2.0)
        centered_y = max(0.0, (sheet_h - used_h) / 2.0)
        cells = []
        # Packer Y is top-down.  The preview/export finalizer flips it to PDF Y,
        # therefore row 0 is the visual TOP row.  Enumerating from row 0 keeps
        # designs in reading order: left-to-right, then top-to-bottom.
        for row in range(rows):
            y = row * (cell_h + gap)
            for col in range(cols):
                x = col * (cell_w + gap)
                # The finalizer centers the whole grid in the usable area.  Test
                # pont/bolt zones at that FINAL position, not at the temporary
                # origin (0, 0); otherwise a safe corner cell is removed before
                # the grid is shifted inward.
                if not _overlaps_zone(
                    x + centered_x, y + centered_y, cell_w, cell_h
                ):
                    cells.append((x, y))
        return cells, cell_w, cell_h

    normal = _candidate(False)
    chosen = normal
    rotated = False
    if allow_rotation and abs(item_w - item_h) > 0.1:
        rotated_candidate = _candidate(True)
        if len(rotated_candidate[0]) > len(normal[0]):
            chosen = rotated_candidate
            rotated = True

    cells, display_w, display_h = chosen
    # Chia sức chứa cân bằng, nhưng gom các bản cùng mẫu cạnh nhau. Ví dụ
    # 21 ô / 14 mẫu => 1,1,2,2,...,7,7,8,9,...,14; không rải vòng
    # 1..14 rồi 1..7 vì người dùng khó kiểm đếm và thành phẩm bị tách cụm.
    copies_per_design, extra_designs = divmod(len(cells), len(page_dims))
    page_assignment = []
    for design_index, (page_idx, _w, _h) in enumerate(page_dims):
        copies = copies_per_design + (1 if design_index < extra_designs else 0)
        page_assignment.extend([page_idx] * copies)

    placements = []
    placed_by_page = {}
    for index, (x, y) in enumerate(cells):
        page_idx = page_assignment[index]
        placements.append({
            'page_idx': page_idx,
            'x': x,
            'y': y,
            'w': display_w,
            'h': display_h,
            'is_rotated': rotated,
        })
        placed_by_page[page_idx] = placed_by_page.get(page_idx, 0) + 1

    return {
        'placements': placements,
        'total_placed': len(placements),
        'placed_by_page': placed_by_page,
        'uniform_grid': True,
    }


def solve_offset_mixed(
    sheet_w: float,
    sheet_h: float,
    page_dims_qty: List[Tuple[int, float, float, int]],
    gap: float = 0.0,
    allow_rotation: bool = True,
    fill_remainder: bool = False,
) -> Dict:
    """
    Offset mode: pack items respecting quantity ratios.
    Goal: minimize number of sheets while maintaining ratio.

    Args:
        sheet_w:        Sheet width in points
        sheet_h:        Sheet height in points
        page_dims_qty:  List of (page_idx, trim_w, trim_h, qty_needed)
        gap:            Gap between items in points

    Returns:
        {
            'placements': [...],       # layout for ONE sheet
            'total_placed': int,
            'placed_by_page': {page_idx: count, ...},
            'sheets_needed': int,      # how many sheets to print
        }
    """
    if not page_dims_qty:
        return {'placements': [], 'total_placed': 0, 'placed_by_page': {}, 'sheets_needed': 0}

    sheet_w = _q6(sheet_w); sheet_h = _q6(sheet_h); gap = _q6(gap)

    # Find the GCD-reduced ratio
    quantities = [qty for _, _, _, qty in page_dims_qty]
    from math import gcd
    from functools import reduce
    ratio_gcd = reduce(gcd, quantities)
    base_ratios = [qty // ratio_gcd for _, _, _, qty in page_dims_qty]

    # Scale up the ratio to fill the sheet as much as possible
    # Binary search for the largest multiplier that still fits
    best_result = None
    best_multiplier = 1
    # Cận trên CHẶT mà vẫn HỢP LỆ (≥ mult thật, vốn đã bị chặn bởi max(quantities)):
    #  • mỗi đơn-vị-mult đặt base_ratio[i] bản loại i ⇒ mult ≤ min(cap_i / base_ratio[i]).
    #  • mỗi đơn-vị-mult tốn ≥ Σ(base_ratio[i]·area_i) ⇒ mult ≤ sheet_area / Σ.
    cap_bound = None
    area_per_unit = 0.0
    for (p_idx, w, h, _), r in zip(page_dims_qty, base_ratios):
        w_g = w + gap
        h_g = h + gap
        c1 = max(1, int(sheet_w / w_g)) * max(1, int(sheet_h / h_g))
        c2 = max(1, int(sheet_w / h_g)) * max(1, int(sheet_h / w_g))
        cap_i = max(c1, c2) // r if r > 0 else max(c1, c2)
        cap_bound = cap_i if cap_bound is None else min(cap_bound, cap_i)
        area_per_unit += r * w_g * h_g
    area_bound = int((sheet_w * sheet_h) / area_per_unit) if area_per_unit > 0 else 1
    hi = max(1, min(max(quantities), cap_bound if cap_bound is not None else 1, area_bound))
    lo = 1

    for _ in range(20):
        mult = (lo + hi) // 2
        items = [(p_idx, w, h, r * mult) for (p_idx, w, h, _), r in zip(page_dims_qty, base_ratios)]
        result = solve_mixed_bin_pack(sheet_w, sheet_h, items, gap, allow_rotation)

        expected = sum(r * mult for r in base_ratios)
        if result['total_placed'] >= expected:
            best_result = result
            best_multiplier = mult
            lo = mult + 1
        else:
            hi = mult - 1

        if lo > hi:
            break

    if best_result is None:
        # Fallback: just use base ratio
        items = [(p_idx, w, h, r) for (p_idx, w, h, _), r in zip(page_dims_qty, base_ratios)]
        best_result = solve_mixed_bin_pack(sheet_w, sheet_h, items, gap, allow_rotation)
        best_multiplier = 1

    # ── Lấp đầy phần dư (tuỳ chọn): xếp đúng tỉ lệ trước, rồi greedy lấp khoảng
    #    trống còn lại để KHÔNG chừa rỗng tờ. Số tờ vẫn tính theo tỉ lệ cân bằng. ──
    if fill_remainder and best_result is not None:
        balanced = []
        for (p_idx, w, h, _), r in zip(page_dims_qty, base_ratios):
            for _ in range(r * best_multiplier):
                balanced.append((p_idx, w, h))
        balanced.sort(key=lambda t: t[1] * t[2], reverse=True)

        packer = _MaxRectsPacker(sheet_w, sheet_h)
        fill_placements = []
        fill_by_page = {}

        def _try_place(p_idx, w, h):
            res = packer.insert(w + gap, h + gap, allow_rotation)
            if res is None:
                return False
            rx, ry, rw, rh = res
            is_rotated = (abs(rw - (w + gap)) > 0.01)
            dw = h if is_rotated else w
            dh = w if is_rotated else h
            fill_placements.append({
                'page_idx': p_idx, 'x': rx + gap / 2, 'y': ry + gap / 2,
                'w': dw, 'h': dh, 'is_rotated': is_rotated,
            })
            fill_by_page[p_idx] = fill_by_page.get(p_idx, 0) + 1
            return True

        for p_idx, w, h in balanced:
            _try_place(p_idx, w, h)

        n_types = len(page_dims_qty)
        fill_order = sorted(range(n_types), key=lambda i: page_dims_qty[i][1] * page_dims_qty[i][2])
        for _ in range(50):
            any_placed = False
            for ti in fill_order:
                p_idx, w, h, _ = page_dims_qty[ti]
                if _try_place(p_idx, w, h):
                    any_placed = True
            if not any_placed:
                break

        best_result = {
            'placements': fill_placements,
            'total_placed': len(fill_placements),
            'placed_by_page': dict(fill_by_page),
        }

    # Calculate sheets needed
    items_per_sheet = {p_idx: r * best_multiplier for (p_idx, _, _, _), r in zip(page_dims_qty, base_ratios)}
    sheets_needed = 1
    for p_idx, _, _, qty in page_dims_qty:
        per_sheet = items_per_sheet.get(p_idx, 1)
        if per_sheet > 0:
            sheets_needed = max(sheets_needed, -(-qty // per_sheet))  # ceil division

    best_result['sheets_needed'] = sheets_needed
    return best_result


# ═══════════════════════════════════════════════════════════════
#  MaxRects Packer — Core Algorithm
# ═══════════════════════════════════════════════════════════════

class _MaxRectsPacker:
    """
    MaxRects packer with Best Short Side Fit (BSSF) heuristic.

    Maintains a list of free rectangles (maximal empty spaces).
    When an item is placed, free rects are split and pruned.
    """

    def __init__(self, width: float, height: float):
        self.bin_w = width
        self.bin_h = height
        # Start with one free rect = the entire bin
        self.free_rects: List[Tuple[float, float, float, float]] = [
            (0.0, 0.0, width, height)
        ]

    def exclude(self, x: float, y: float, w: float, h: float):
        """
        Mark a region as occupied (e.g., forbidden zone from ốc/pont marks).
        Items will never be placed overlapping this region.
        Works by treating the zone as a pre-placed rectangle.
        """
        # Clip to bin bounds
        x0 = max(0.0, x)
        y0 = max(0.0, y)
        x1 = min(self.bin_w, x + w)
        y1 = min(self.bin_h, y + h)
        if x1 <= x0 or y1 <= y0:
            return  # zone outside bin
        self._split_free_rects((x0, y0, x1 - x0, y1 - y0))
        self._prune_free_rects()

    def insert(self, w: float, h: float, allow_rotation: bool = True) -> Optional[Tuple[float, float, float, float]]:
        """
        Try to insert a rectangle of size (w, h).
        Returns (x, y, placed_w, placed_h) or None if it doesn't fit.
        """
        best_idx = -1
        best_x = 0.0
        best_y = 0.0
        best_w = w
        best_h = h
        best_short_side = float('inf')

        EPS = 0.001  # tiny tolerance for floating point only

        for i, (fx, fy, fw, fh) in enumerate(self.free_rects):
            # Try original orientation
            if w <= fw + EPS and h <= fh + EPS:
                leftover_short = min(fw - w, fh - h)
                if leftover_short < best_short_side:
                    best_short_side = leftover_short
                    best_idx = i
                    best_x = fx
                    best_y = fy
                    best_w = w
                    best_h = h

            # Try rotated
            if allow_rotation and h <= fw + EPS and w <= fh + EPS:
                leftover_short = min(fw - h, fh - w)
                if leftover_short < best_short_side:
                    best_short_side = leftover_short
                    best_idx = i
                    best_x = fx
                    best_y = fy
                    best_w = h
                    best_h = w

        if best_idx < 0:
            return None

        # Place the rectangle — clamp to free rect bounds to prevent floating-point overshoot
        fx, fy, fw, fh = self.free_rects[best_idx]
        pw = min(best_w, fw)
        ph = min(best_h, fh)

        placed = (best_x, best_y, pw, ph)
        self._split_free_rects(placed)
        self._prune_free_rects()

        return placed

    def _split_free_rects(self, placed: Tuple[float, float, float, float]):
        """
        Split all free rects that overlap with the placed rect
        into maximal non-overlapping sub-rects.

        Build the new list in the SAME interleaved order as a naive split
        (per old rect: itself if untouched, else its ≤4 children) and record
        which entries are freshly-created children via ``self._is_child``.
        Order is preserved so BSSF tie-breaking in insert() is unchanged.
        """
        px, py, pw, ph = placed
        pr = px + pw  # right edge
        pt = py + ph  # top edge

        new_free = []
        is_child = []  # True ⇔ entry is a freshly-split child (prune candidate)

        for fx, fy, fw, fh in self.free_rects:
            fr = fx + fw
            ft = fy + fh

            # No overlap → keep as is (untouched rects can never become
            # contained in a child — see _prune_free_rects).
            if px >= fr or pr <= fx or py >= ft or pt <= fy:
                new_free.append((fx, fy, fw, fh))
                is_child.append(False)
                continue

            # Overlap exists → split into up to 4 maximal sub-rects

            # Left side
            if px > fx:
                new_free.append((fx, fy, px - fx, fh)); is_child.append(True)

            # Right side
            if pr < fr:
                new_free.append((pr, fy, fr - pr, fh)); is_child.append(True)

            # Bottom side
            if py > fy:
                new_free.append((fx, fy, fw, py - fy)); is_child.append(True)

            # Top side
            if pt < ft:
                new_free.append((fx, pt, fw, ft - pt)); is_child.append(True)

        self.free_rects = new_free
        self._is_child = is_child

    def _prune_free_rects(self):
        """
        Remove any free rect that is fully contained by another free rect.

        Optimization (output-identical): by the maintained invariant that
        ``self.free_rects`` is always mutually non-contained BEFORE a split,
        an untouched rect can never end up contained in a freshly-created
        child (a child ⊆ a rect that overlapped the placed item; if an
        untouched rect were ⊆ that child it would have been ⊆ that overlapping
        rect too, contradicting the invariant). So only CHILD entries need a
        containment test — against the full pre-prune list, exactly as the
        naive O(F²) version, but skipping the untouched rows. Iteration order
        is preserved, so the surviving list is byte-identical to the naive one.
        """
        is_child = getattr(self, "_is_child", None)
        if is_child is None:
            # Fallback: naive O(F²) over the whole list (safety; not expected).
            rects = self.free_rects
            n = len(rects)
            pruned = []
            for i in range(n):
                ax, ay, aw, ah = rects[i]
                if not any(
                    j != i and ax >= rects[j][0] and ay >= rects[j][1]
                    and ax + aw <= rects[j][0] + rects[j][2]
                    and ay + ah <= rects[j][1] + rects[j][3]
                    for j in range(n)
                ):
                    pruned.append(rects[i])
            self.free_rects = pruned
            return

        rects = self.free_rects
        n = len(rects)
        pruned = []
        for i in range(n):
            if not is_child[i]:
                pruned.append(rects[i])  # untouched → always survives
                continue
            ax, ay, aw, ah = rects[i]
            ar = ax + aw
            at = ay + ah
            contained = False
            for j in range(n):
                if j == i:
                    continue
                bx, by, bw, bh = rects[j]
                if ax >= bx and ay >= by and ar <= bx + bw and at <= by + bh:
                    contained = True
                    break
            if not contained:
                pruned.append(rects[i])

        self.free_rects = pruned
        self._is_child = None


# ═══════════════════════════════════════════════════════════════
#  Legacy API — backward compatibility
# ═══════════════════════════════════════════════════════════════

def solve_nup_bin_packing(items: list, sheet_w: float, sheet_h: float) -> list:
    """
    Legacy API wrapper. Converts old format to new MaxRects solver.
    """
    if not items:
        return []

    # Group items by type
    type_map = {}
    for item in items:
        tid = item['id']
        if tid not in type_map:
            type_map[tid] = {'w': item['w'], 'h': item['h'], 'count': 0}
        type_map[tid]['count'] += 1

    remaining = {tid: info['count'] for tid, info in type_map.items()}
    result_items = []
    sheet_idx = 0
    max_sheets = 500

    while any(v > 0 for v in remaining.values()) and sheet_idx < max_sheets:
        pack_items = [(tid, info['w'], info['h'], remaining[tid])
                      for tid, info in type_map.items() if remaining[tid] > 0]

        pack_result = solve_mixed_bin_pack(sheet_w, sheet_h, pack_items)

        if pack_result['total_placed'] == 0:
            break

        for p in pack_result['placements']:
            result_items.append({
                'id': p['page_idx'],
                'x': p['x'],
                'y': p['y'],
                'w': p['w'],
                'h': p['h'],
                'rotated': p['is_rotated'],
                'sheet_idx': sheet_idx,
            })

        for tid, count in pack_result['placed_by_page'].items():
            remaining[tid] -= count

        sheet_idx += 1

    return result_items
