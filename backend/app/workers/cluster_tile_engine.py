"""
cluster_tile_engine.py
======================
Tính năng: Cluster Tile (Cụm Nhân Bản)

Logic:
  1. Pack tất cả loại tem vào 1 "cụm nhỏ" (kích thước cluster_w × cluster_h).
     Dùng TRUE CASCADE packing (gối đầu) bên trong cụm:
     - Tính tổng capacity của cụm theo kích thước trung bình của các loại
     - Chia đều cho n_types → quota mỗi loại
     - Chèn lần lượt: loại 1, loại 2, ..., loại n, liên tục không break row
  2. Nhân bản cụm đó lên toàn bộ tờ in (sheet_w × sheet_h).
  3. Vẽ dấu xén (guillotine marks) tại mỗi biên giữa các cụm.

Returns:
  placements: list[dict]  — mỗi item là 1 tem được đặt trên tờ in lớn
  tile_cut_lines: dict    — {'v': [x,...], 'h': [y,...]} dùng để vẽ marks
"""

import logging
from math import gcd
from typing import List, Tuple, Dict, Any, Optional

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465

MAX_ZONE_RATIO_REPS_PER_TYPE = 8


def run_cluster_tile(
    page_infos: List[Tuple[int, int, float, float]],   # (p_idx, qty, trim_w_pt, trim_h_pt)
    full_layouts: Dict[int, Any],                       # p_idx → layout from sticker engine
    sheet_w: float,                                     # usable sheet width (pts)
    sheet_h: float,                                     # usable sheet height (pts)
    cluster_w: float,                                   # cluster width (pts)
    cluster_h: float,                                   # cluster height (pts)
    gap_x: float,                                       # item gap X inside cluster (pts)
    gap_y: float,                                       # item gap Y inside cluster (pts)
    tile_gap_x: float = 0.0,                            # gap between tiles (pts, usually 0)
    tile_gap_y: float = 0.0,
    margin_left: float = 0.0,
    margin_bottom: float = 0.0,
    cluster_nesting: bool = False,
    is_die_cut: bool = False,
    doc=None,
    shape_type: str = 'CUSTOM',
    shape_props: dict = None,
    strategy: str = 'optimal_auto'
) -> Tuple[List[Dict], Dict]:
    """
    Returns (placements, tile_cut_lines).

    placements: list of dicts with keys:
        src_page_idx, abs_x, abs_y, width, height, cell (dict), original_cell_y, cluster_idx

    tile_cut_lines: {'v': set of x coords, 'h': set of y coords}
        These are the lines between tiles — used for drawing guillotine cut marks.
    """

    # ── Step 1: Build cluster layout
    cluster_placements = []
    if cluster_nesting and is_die_cut and len(page_infos) == 1:
        # Tapping into full_layouts which has ALREADY been optimized for cluster size by nup_engine!
        p_idx = page_infos[0][0]
        fl = full_layouts.get(p_idx, {})
        if fl and 'items' in fl:
            logger.info(f"[CLUSTER_TILE] Using NFy nested layout directly for 1 type ({len(fl['items'])} items)")
            for it in fl['items']:
                # NFy returns top-down coordinates in 'x' and 'y'
                cluster_placements.append((
                    p_idx,
                    it.get('x', 0.0),
                    it.get('y', 0.0),
                    it.get('width', 0.0),
                    it.get('height', 0.0),
                    it.get('isRotated', False),
                    it.get('isRotated180', False)
                ))
    
    if not cluster_placements:
        # Fallback to CASCADE pack
        cluster_placements = _cascade_pack_cluster(
            page_infos=page_infos,
            full_layouts=full_layouts,
            cluster_w=cluster_w,
            cluster_h=cluster_h,
            gap_x=gap_x,
            gap_y=gap_y,
        )

    if not cluster_placements:
        logger.warning("[CLUSTER_TILE] No items packed into cluster — aborting")
        return [], {'v': set(), 'h': set()}

    # ── Step 1.5: Center items within the cluster ──
    max_c_x = max(it[1] + it[3] for it in cluster_placements)
    max_c_y = max(it[2] + it[4] for it in cluster_placements)
    
    c_off_x = max(0.0, (cluster_w - max_c_x) / 2.0)
    c_off_y = max(0.0, (cluster_h - max_c_y) / 2.0)

    centered_placements = []
    for it in cluster_placements:
        is_rot_180 = it[6] if len(it) > 6 else False
        centered_placements.append((
            it[0],
            it[1] + c_off_x,
            it[2] + c_off_y,
            it[3],
            it[4],
            it[5],
            is_rot_180
        ))
    cluster_placements = centered_placements

    logger.info(f"[CLUSTER_TILE] Cluster packed: {len(cluster_placements)} items "
                f"in {cluster_w:.1f}×{cluster_h:.1f}pt cluster (offset: {c_off_x:.1f}, {c_off_y:.1f})")

    # ── Step 2: Tile clusters onto the full sheet
    cols_tiles = max(1, int((sheet_w + tile_gap_x) // (cluster_w + tile_gap_x)))
    rows_tiles = max(1, int((sheet_h + tile_gap_y) // (cluster_h + tile_gap_y)))

    logger.info(f"[CLUSTER_TILE] Tiling {cols_tiles}×{rows_tiles} clusters "
                f"on sheet {sheet_w:.1f}×{sheet_h:.1f}pt")

    # Center the tiled block on the usable sheet area (no margin offset — coords are already in usable space)
    total_tile_w = cols_tiles * cluster_w + (cols_tiles - 1) * tile_gap_x
    total_tile_h = rows_tiles * cluster_h + (rows_tiles - 1) * tile_gap_y
    x_origin = max(0.0, (sheet_w - total_tile_w) / 2.0)
    y_origin = max(0.0, (sheet_h - total_tile_h) / 2.0)

    all_placements: List[Dict] = []
    tile_v_cuts: set = set()   # x positions of vertical cuts between tiles
    tile_h_cuts: set = set()   # y positions of horizontal cuts between tiles

    for row in range(rows_tiles):
        for col in range(cols_tiles):
            tile_ox = x_origin + col * (cluster_w + tile_gap_x)
            tile_oy = y_origin + row * (cluster_h + tile_gap_y)

            for item in cluster_placements:
                # item: (p_idx, rel_x, rel_top_y, iw, ih, is_rot, is_rot_180)
                is_rot_180 = False
                if len(item) == 7:
                    p_idx, rel_x, rel_top_y, iw, ih, is_rot, is_rot_180 = item
                else:
                    p_idx, rel_x, rel_top_y, iw, ih, is_rot = item

                abs_x = tile_ox + rel_x
                abs_y = tile_oy + rel_top_y

                all_placements.append({
                    'cluster_idx': row * cols_tiles + col,
                    'src_page_idx': p_idx,
                    'abs_x': abs_x,
                    'abs_y': abs_y,
                    'width': iw,
                    'height': ih,
                    'cell': {
                        'x': abs_x,
                        'y': abs_y,
                        'width': iw,
                        'height': ih,
                        'isRotated': is_rot,
                        'isRotated180': is_rot_180,
                    },
                    'original_cell_y': abs_y,
                })

            # Collect cut line positions (at boundaries between tiles)
            if col < cols_tiles - 1:
                cut_x = tile_ox + cluster_w  # right edge of this tile
                tile_v_cuts.add(round(cut_x, 2))
                if tile_gap_x > 0:
                    tile_v_cuts.add(round(cut_x + tile_gap_x, 2))
            if row < rows_tiles - 1:
                cut_y = tile_oy + cluster_h  # bottom edge of this tile
                tile_h_cuts.add(round(cut_y, 2))
                if tile_gap_y > 0:
                    tile_h_cuts.add(round(cut_y + tile_gap_y, 2))

    # Add outer boundary marks
    tile_v_cuts.add(round(x_origin, 2))
    tile_v_cuts.add(round(x_origin + total_tile_w, 2))
    tile_h_cuts.add(round(y_origin, 2))
    tile_h_cuts.add(round(y_origin + total_tile_h, 2))

    total_items = len(all_placements)
    logger.info(f"[CLUSTER_TILE] DONE: {total_items} total item placements "
                f"({len(cluster_placements)} per cluster × {cols_tiles * rows_tiles} tiles)")

    tile_cut_lines = {'v': tile_v_cuts, 'h': tile_h_cuts}
    return all_placements, tile_cut_lines


def _cascade_pack_cluster(
    page_infos: List[Tuple[int, int, float, float]],
    full_layouts: Dict[int, Any],
    cluster_w: float,
    cluster_h: float,
    gap_x: float,
    gap_y: float,
) -> List[Tuple]:
    """
    TRUE CASCADE (gối đầu) packing: xếp tất cả loại tem vào cụm cluster_w × cluster_h.

    Các loại chảy liên tục trái→phải, trên→dưới (KHÔNG chia dải riêng cho từng loại).
    Mỗi loại nhận quota = floor(total_cluster_capacity / n_types).

    Returns list of (p_idx, rel_x, rel_top_y, iw, ih, is_rot)
    — top-down coordinates within the cluster.
    """

    n_types = len(page_infos)
    if n_types == 0:
        return []

    def _best_dims(p_idx: int, tw: float, th: float):
        """yick best (iw, ih, is_rotated, is_rotated_180) orientation from full_layout."""
        fl = full_layouts.get(p_idx)
        if fl and fl.get('items'):
            fi = fl['items'][0]
            if fi.get('isRotated'):
                return th, tw, True, fi.get('isRotated180', False)
            return tw, th, False, fi.get('isRotated180', False)
        return tw, th, False, False

    # ── Step 1: Estimate total cluster capacity using AVERAGE item dimensions ──
    all_dims = [_best_dims(p_idx, tw, th) for p_idx, _, tw, th in page_infos]
    avg_iw = sum(d[0] for d in all_dims) / n_types
    avg_ih = sum(d[1] for d in all_dims) / n_types

    cols_est = max(1, int((cluster_w + gap_x) / (avg_iw + gap_x)))
    rows_est = max(1, int((cluster_h + gap_y) / (avg_ih + gap_y)))
    total_cap_est = cols_est * rows_est

    # Quota per type = fair share of total cluster capacity
    quota_per_type = max(1, total_cap_est // n_types)

    logger.info(
        f"[CLUSTER_TILE] Quota calc: avg_item={avg_iw:.1f}×{avg_ih:.1f}pt "
        f"→ cluster_cap≈{total_cap_est} → quota={quota_per_type}/type × {n_types} types"
    )

    # ── Step 2: CASCADE PACK — continuous flow, no row breaks between types ──
    result: List[Tuple] = []
    cur_x = 0.0
    cur_y = 0.0   # top-down within cluster
    row_h = 0.0
    cluster_full = False

    for p_idx, _, tw, th in page_infos:
        if cluster_full:
            break

        iw, ih, is_rot, is_rot_180 = _best_dims(p_idx, tw, th)
        placed = 0

        while placed < quota_per_type:
            # Wrap to next row if item doesn't fit horizontally
            if cur_x + iw > cluster_w + 0.5:
                cur_y += row_h + gap_y
                cur_x = 0.0
                row_h = 0.0

            # Stop if no vertical space
            if cur_y + ih > cluster_h + 0.5:
                cluster_full = True
                break

            result.append((p_idx, cur_x, cur_y, iw, ih, is_rot, is_rot_180))
            cur_x += iw + gap_x
            row_h = max(row_h, ih)
            placed += 1

    # ── Step 3: Round-robin fill remaining space ──
    if not cluster_full:
        rr_order = list(range(n_types))
        made_progress = True
        while made_progress and not cluster_full:
            made_progress = False
            for idx in rr_order:
                p_idx_r, _, tw_r, th_r = page_infos[idx]
                iw2, ih2, is_rot2, is_rot2_180 = _best_dims(p_idx_r, tw_r, th_r)

                if cur_x + iw2 > cluster_w + 0.5:
                    if cur_y + row_h + gap_y + ih2 > cluster_h + 0.5:
                        continue
                    cur_y += row_h + gap_y
                    cur_x = 0.0
                    row_h = 0.0

                if cur_y + ih2 > cluster_h + 0.5:
                    continue

                result.append((p_idx_r, cur_x, cur_y, iw2, ih2, is_rot2, is_rot2_180))
                cur_x += iw2 + gap_x
                row_h = max(row_h, ih2)
                made_progress = True

    total_h = cur_y + row_h
    logger.info(
        f"[CLUSTER_TILE] Cascade result: {len(result)} items packed, "
        f"content_h={total_h:.1f}pt / {cluster_h:.1f}pt cluster_h"
    )

    # ── Step 4: CENTER the packed content within the cluster area ──
    # Compute bounding box of all packed items
    if result:
        content_max_x = max(r[1] + r[3] for r in result)  # rel_x + iw
        content_max_y = max(r[2] + r[4] for r in result)  # rel_top_y + ih

        offset_x = max(0.0, (cluster_w - content_max_x) / 2.0)
        offset_y = max(0.0, (cluster_h - content_max_y) / 2.0)

        if offset_x > 0.5 or offset_y > 0.5:
            result = [
                # INKING (audit 2026-08-12 §INK-DIE-04): tuple thứ 7 là cờ
                # 180°. Không được làm rơi khi căn giữa cụm trước khi nhân bản.
                (
                    r[0], r[1] + offset_x, r[2] + offset_y,
                    r[3], r[4], r[5], r[6] if len(r) > 6 else False,
                )
                for r in result
            ]
            logger.info(
                f"[CLUSTER_TILE] Centered content within cluster: "
                f"shift=({offset_x:.1f}, {offset_y:.1f})pt "
                f"content_bbox={content_max_x:.1f}×{content_max_y:.1f}pt"
            )

    # Log types present
    types_present = sorted(set(r[0] for r in result))
    logger.info(f"[CLUSTER_TILE] Types in cluster: {types_present} ({len(types_present)}/{n_types})")

    return result


# ══════════════════════════════════════════════════════════════════════
# ZONE PARTITION — mỗi loại một vùng chữ nhật riêng (guillotine full-span)
# ══════════════════════════════════════════════════════════════════════

def _split_sizes(total: float, weights: List[float], gap: float) -> Optional[List[float]]:
    """Chia `total` cho n phần theo weights, trừ (n-1)*gap giữa các phần.
    Trả None nếu không đủ chỗ."""
    n = len(weights)
    if n == 0:
        return None
    avail = total - (n - 1) * gap
    if avail <= 1.0:
        return None
    s = sum(weights)
    if s <= 0:
        weights = [1.0] * n
        s = float(n)
    return [avail * (w / s) for w in weights]


def _build_zone_placements(
    zones: List[Tuple[int, float, float, float, float]],
    zone_layout_fn,
) -> Tuple[List[Dict], int]:
    """zones: list of (p_idx, zone_x, zone_y, zone_w, zone_h) — top-down usable coords.
    Gọi zone_layout_fn để nest 1 loại phủ đầy mỗi vùng; căn giữa nội dung trong vùng.
    Trả (placements-cùng-shape-với-run_cluster_tile, tổng số con)."""
    placements: List[Dict] = []
    total = 0
    for zi, (p_idx, zx, zy, zw, zh) in enumerate(zones):
        if zw <= 1.0 or zh <= 1.0:
            continue
        layout = zone_layout_fn(p_idx, zw, zh) or {}
        items = layout.get('items', []) or []
        if not items:
            continue
        content_max_x = max(it.get('x', 0.0) + it.get('width', 0.0) for it in items)
        content_max_y = max(it.get('y', 0.0) + it.get('height', 0.0) for it in items)
        off_x = max(0.0, (zw - content_max_x) / 2.0)
        off_y = max(0.0, (zh - content_max_y) / 2.0)
        for it in items:
            iw = it.get('width', 0.0)
            ih = it.get('height', 0.0)
            ax = zx + off_x + it.get('x', 0.0)
            ay = zy + off_y + it.get('y', 0.0)
            placements.append({
                'cluster_idx': zi,
                'src_page_idx': p_idx,
                'abs_x': ax,
                'abs_y': ay,
                'width': iw,
                'height': ih,
                'cell': {
                    'x': ax, 'y': ay, 'width': iw, 'height': ih,
                    'isRotated': it.get('isRotated', False),
                    'isRotated180': it.get('isRotated180', False),
                },
                'original_cell_y': ay,
            })
        total += len(items)
    return placements, total


def _zone_cut_lines(zones: List[Tuple[int, float, float, float, float]],
                    sheet_used_w: float, sheet_used_h: float) -> Dict:
    """Đường xén guillotine tại biên vùng. Vì mọi vùng full-span (cột full-height
    hoặc hàng full-width hoặc lưới đều), các nét chạy edge-to-edge → hợp lệ guillotine.
    Trả {'v': set(x), 'h': set(y)} top-down (gồm cả bound ngoài)."""
    v_cuts = set()
    h_cuts = set()
    for _p, zx, zy, zw, zh in zones:
        v_cuts.add(round(zx, 2))
        v_cuts.add(round(zx + zw, 2))
        h_cuts.add(round(zy, 2))
        h_cuts.add(round(zy + zh, 2))
    v_cuts.add(round(0.0, 2))
    v_cuts.add(round(sheet_used_w, 2))
    h_cuts.add(round(0.0, 2))
    h_cuts.add(round(sheet_used_h, 2))
    return {'v': v_cuts, 'h': h_cuts}


def _zone_grid_geometry(sheet_w, sheet_h, zone_gap_x, zone_gap_y, zone_cols, zone_rows):
    """Trả list vị trí ô lưới ĐỀU NHAU [(x, y, w, h), ...] theo hàng-trước (top-down),
    hoặc None nếu lưới quá nhỏ."""
    col_w = _split_sizes(sheet_w, [1.0] * zone_cols, zone_gap_x)
    row_h = _split_sizes(sheet_h, [1.0] * zone_rows, zone_gap_y)
    if not col_w or not row_h:
        return None
    positions = []
    y = 0.0
    for r in range(zone_rows):
        x = 0.0
        for c in range(zone_cols):
            positions.append((x, y, col_w[c], row_h[r]))
            x += col_w[c] + zone_gap_x
        y += row_h[r] + zone_gap_y
    return positions


def _zone_type_slots(page_infos, mode: str) -> List[int]:
    """Danh sách INDEX loại (trong page_infos) cần rải vào các vùng, XUYÊN mọi tờ.
    - zone_per_type: mỗi loại đúng 1 slot (17 loại → 17 slot).
    - zone_ratio: mỗi loại lặp ~ tỉ lệ số lượng (loại SL gấp đôi → gấp đôi slot)."""
    n = len(page_infos)
    if n == 0:
        return []
    if mode == 'zone_ratio':
        qtys = [max(1, pi[1]) for pi in page_infos]
        common = 0
        for qty in qtys:
            common = gcd(common, int(qty))
        common = max(1, common)
        reps_by_type = [max(1, int(qty) // common) for qty in qtys]

        # Quantity là production count, không phải số unique layout cần vật hoá.
        # Giữ ratio nguyên khi nhỏ; ratio cực đoan được scale về trần hữu hạn và
        # phần số lần in được xử lý ở report/export thay vì tạo hàng nghìn tờ mẫu.
        max_reps = max(reps_by_type)
        if max_reps > MAX_ZONE_RATIO_REPS_PER_TYPE:
            reps_by_type = [
                max(1, round(rep * MAX_ZONE_RATIO_REPS_PER_TYPE / max_reps))
                for rep in reps_by_type
            ]
            logger.warning(
                "[ZONE_RATIO] raw ratio %s capped to %s (max reps/type=%d)",
                qtys, reps_by_type, MAX_ZONE_RATIO_REPS_PER_TYPE,
            )
        slots: List[int] = []
        for i, reps in enumerate(reps_by_type):
            slots.extend([i] * reps)
        return slots
    return list(range(n))


def _zone_cut_lines_from_positions(positions, sheet_used_w: float, sheet_used_h: float) -> Dict:
    """Đường xén guillotine theo lưới ĐẦY ĐỦ (vẽ cả ô trống để cắt nhất quán).
    Trả {'v': set(x), 'h': set(y)} top-down (gồm bound ngoài)."""
    v_cuts = set()
    h_cuts = set()
    for (x, y, w, h) in positions:
        v_cuts.add(round(x, 2))
        v_cuts.add(round(x + w, 2))
        h_cuts.add(round(y, 2))
        h_cuts.add(round(y + h, 2))
    v_cuts.add(round(0.0, 2))
    v_cuts.add(round(sheet_used_w, 2))
    h_cuts.add(round(0.0, 2))
    h_cuts.add(round(sheet_used_h, 2))
    return {'v': v_cuts, 'h': h_cuts}


def run_zone_partition_sheets(
    page_infos: List[Tuple[int, int, float, float]],
    zone_layout_fn,
    sheet_w: float,
    sheet_h: float,
    gap_x: float,
    gap_y: float,
    zone_gap_x: float = 0.0,
    zone_gap_y: float = 0.0,
    mode: str = 'zone_per_type',
    zone_cols: int = 2,
    zone_rows: int = 1,
) -> List[Tuple[List[Dict], Dict]]:
    """Chia các LOẠI thành NHIỀU TỜ, mỗi tờ lưới `zone_cols × zone_rows` vùng đều nhau;
    mỗi vùng 1 loại nest PHỦ ĐẦY. Rải loại tuần tự sang tờ mới khi hết vùng.

    Ví dụ: 17 loại, lưới 2×2 = 4 vùng/tờ → 5 tờ (4 tờ đủ 4 loại + 1 tờ cuối 1 loại,
    3 vùng còn lại để TRỐNG). Mỗi tờ in 1 lần (không nhân theo số lượng).

    Trả List[(placements, tile_cut_lines)] — mỗi phần tử là 1 tờ, top-down usable-space."""
    n = len(page_infos)
    if n == 0:
        return []

    zone_cols = max(1, int(zone_cols))
    zone_rows = max(1, int(zone_rows))
    n_zones = zone_cols * zone_rows

    positions = _zone_grid_geometry(sheet_w, sheet_h, zone_gap_x, zone_gap_y,
                                    zone_cols, zone_rows)
    if not positions:
        logger.warning("[ZONE_PARTITION] Lưới %dx%d quá nhỏ trên %.1f×%.1fpt",
                       zone_cols, zone_rows, sheet_w, sheet_h)
        return []

    slots = _zone_type_slots(page_infos, mode)
    cut_lines = _zone_cut_lines_from_positions(positions, sheet_w, sheet_h)

    sheets: List[Tuple[List[Dict], Dict]] = []
    for s0 in range(0, len(slots), n_zones):
        chunk = slots[s0:s0 + n_zones]   # ≤ n_zones index loại cho tờ này
        zones = []
        for zpos, ti in zip(positions, chunk):
            zx, zy, zw, zh = zpos
            zones.append((page_infos[ti][0], zx, zy, zw, zh))
        placements, _total = _build_zone_placements(zones, zone_layout_fn)
        sheets.append((placements, cut_lines))

    logger.info(
        "[ZONE_PARTITION] mode=%s lưới %dx%d=%d vùng/tờ, %d loại → %d tờ",
        mode, zone_cols, zone_rows, n_zones, n, len(sheets),
    )
    return sheets


def compute_cluster_sheets(
    page_infos: List[Tuple[int, int, float, float]],
    full_layouts: Dict[int, Any],
    zone_layout_fn,
    sheet_w: float,
    sheet_h: float,
    cluster_w: float,
    cluster_h: float,
    gap_x: float,
    gap_y: float,
    tile_gap_x: float = 0.0,
    tile_gap_y: float = 0.0,
    combine_mode: str = 'replicate_mixed',
    cluster_nesting: bool = True,
    is_die_cut: bool = False,
    doc=None,
    shape_type: str = 'CUSTOM',
    shape_props: dict = None,
    strategy: str = 'optimal_auto',
    zone_cols: int = 2,
    zone_rows: int = 1,
) -> List[Tuple[List[Dict], Dict]]:
    """SSOT dispatcher — cả preview lẫn export gọi hàm này để có DANH SÁCH TỜ
    ĐỒNG NHẤT. Mỗi phần tử = (placements, tile_cut_lines) top-down usable-space.

    - replicate_mixed → run_cluster_tile → ĐÚNG 1 tờ mẫu (nhân bản cụm; số tờ in
      tính sau theo số lượng ở nơi gọi).
    - zone_per_type / zone_ratio → run_zone_partition_sheets → NHIỀU tờ, mỗi tờ 1 bộ
      loại khác nhau (17 loại, lưới 2×2 → 5 tờ)."""
    if combine_mode in ('zone_per_type', 'zone_ratio'):
        return run_zone_partition_sheets(
            page_infos=page_infos,
            zone_layout_fn=zone_layout_fn,
            sheet_w=sheet_w,
            sheet_h=sheet_h,
            gap_x=gap_x,
            gap_y=gap_y,
            zone_gap_x=tile_gap_x,
            zone_gap_y=tile_gap_y,
            mode=combine_mode,
            zone_cols=zone_cols,
            zone_rows=zone_rows,
        )
    placements, cut_lines = run_cluster_tile(
        page_infos=page_infos,
        full_layouts=full_layouts,
        sheet_w=sheet_w,
        sheet_h=sheet_h,
        cluster_w=cluster_w,
        cluster_h=cluster_h,
        gap_x=gap_x,
        gap_y=gap_y,
        tile_gap_x=tile_gap_x,
        tile_gap_y=tile_gap_y,
        cluster_nesting=cluster_nesting,
        is_die_cut=is_die_cut,
        doc=doc,
        shape_type=shape_type,
        shape_props=shape_props,
        strategy=strategy,
    )
    return [(placements, cut_lines)] if placements else []


def draw_tile_cut_marks(
    out_page,
    tile_cut_lines: Dict,
    mark_off: float = 8.51,   # offset từ biên (pts), default 3mm
    mark_len: float = 14.17,  # chiều dài nét (pts), default 5mm
    mark_thickness: float = 0.71,  # độ dày nét (pts), default ~0.25mm
    mark_style: str = 'default',   # 'default' (nét đơn) | 'japanese' (nét đôi トンボ)
    bleed_pt: float = 0.0,         # khoảng bù xén (pts) — dùng cho khoảng cách nét đôi
):
    """
    Vẽ dấu xén guillotine tại các đường biên giữa các cụm.

    QUY TẮC:
    - 4 góc ngoài cùng (giao min_x/max_x × min_y/max_y): KHÔNG vẽ
      (vị trí này dùng để đặt ốc/boong kẹp của máy bế)
    - Cạnh biên (không phải góc): vẽ nét theo chiều vuông góc ra ngoài
    - Giao nội bộ (giữa các cụm): vẽ dấu thập (+) ngắn

    KIỂU NÉT:
    - 'default': nét đơn đúng tại đường cắt (trim).
    - 'japanese' (トンボ): nét đôi straddle đường trim ±bleed, thể hiện đồng thời
      mép xén (trim) và mép tràn (bleed). Nếu bleed_pt<=0 sẽ tự fallback về nét đơn.

    Coordinate: PDF top-left origin, y tăng xuống dưới.
    """
    from app.workers.pdf_types import Point

    v_cuts = sorted(tile_cut_lines.get('v', set()))
    h_cuts = sorted(tile_cut_lines.get('h', set()))

    if len(v_cuts) < 2 or len(h_cuts) < 2:
        logger.warning(f"[CLUSTER_TILE] draw_tile_cut_marks: insufficient cuts "
                       f"v={v_cuts} h={h_cuts} — skipping")
        return

    min_x, max_x = min(v_cuts), max(v_cuts)
    min_y, max_y = min(h_cuts), max(h_cuts)

    # Internal cuts (between tiles)
    int_v = [x for x in v_cuts if x not in (min_x, max_x)]
    int_h = [y for y in h_cuts if y not in (min_y, max_y)]

    shape = out_page.new_shape()

    is_japanese = mark_style == 'japanese' and bleed_pt > 0.01

    def is_corner(vx, hy):
        return vx in (min_x, max_x) and hy in (min_y, max_y)

    def tick_v(x, y0, y1):
        """Nét dọc tại hoành độ x (chạy theo trục y). Nét đôi straddle x ±bleed."""
        if is_japanese:
            shape.draw_line(Point(x - bleed_pt, y0), Point(x - bleed_pt, y1))
            shape.draw_line(Point(x + bleed_pt, y0), Point(x + bleed_pt, y1))
        else:
            shape.draw_line(Point(x, y0), Point(x, y1))

    def tick_h(y, x0, x1):
        """Nét ngang tại tung độ y (chạy theo trục x). Nét đôi straddle y ±bleed."""
        if is_japanese:
            shape.draw_line(Point(x0, y - bleed_pt), Point(x1, y - bleed_pt))
            shape.draw_line(Point(x0, y + bleed_pt), Point(x1, y + bleed_pt))
        else:
            shape.draw_line(Point(x0, y), Point(x1, y))

    # ── Marks along TOP outer edge (min_y) ──
    # Nét thẳng đứng, kéo LÊN TRÊN (y nhỏ hơn), bỏ qua 2 góc trái-phải
    for vx in v_cuts:
        if is_corner(vx, min_y):
            continue
        tick_v(vx, min_y - mark_off, min_y - mark_off - mark_len)

    # ── Marks along BOTTOM outer edge (max_y) ──
    for vx in v_cuts:
        if is_corner(vx, max_y):
            continue
        tick_v(vx, max_y + mark_off, max_y + mark_off + mark_len)

    # ── Marks along LEFT outer edge (min_x) ──
    # Nét nằm ngang, kéo sang TRÁI, bỏ qua 2 góc trên-dưới
    for hy in h_cuts:
        if is_corner(min_x, hy):
            continue
        tick_h(hy, min_x - mark_off, min_x - mark_off - mark_len)

    # ── Marks along RIGHT outer edge (max_x) ──
    for hy in h_cuts:
        if is_corner(max_x, hy):
            continue
        tick_h(hy, max_x + mark_off, max_x + mark_off + mark_len)

    # ── Internal vertical cuts (between tile columns) ──
    for vx in int_v:
        for hy in h_cuts:
            # Tick ngang hướng sang trái
            tick_h(hy, vx - mark_off, vx - mark_off - mark_len)
            # Tick ngang hướng sang phải
            tick_h(hy, vx + mark_off, vx + mark_off + mark_len)
        # Cũng vẽ nét dọc ra ngoài biên trên/dưới
        tick_v(vx, min_y - mark_off, min_y - mark_off - mark_len)
        tick_v(vx, max_y + mark_off, max_y + mark_off + mark_len)

    # ── Internal horizontal cuts (between tile rows) ──
    for hy in int_h:
        for vx in v_cuts:
            # Tick dọc hướng lên trên
            tick_v(vx, hy - mark_off, hy - mark_off - mark_len)
            # Tick dọc hướng xuống dưới
            tick_v(vx, hy + mark_off, hy + mark_off + mark_len)
        # Nét ngang ra ngoài biên trái/phải
        tick_h(hy, min_x - mark_off, min_x - mark_off - mark_len)
        tick_h(hy, max_x + mark_off, max_x + mark_off + mark_len)

    shape.finish(color=(1, 1, 1, 1), fill=None, width=mark_thickness)  # registration (mọi kẽm)
    shape.commit()  # commit to page

    # Đường nét đứt (dashed line) phân ranh giới xuyên suốt giữa các cụm
    if int_v or int_h:
        dash_shape = out_page.new_shape()
        for vx in int_v:
            dash_shape.draw_line(Point(vx, min_y), Point(vx, max_y))
        for hy in int_h:
            dash_shape.draw_line(Point(min_x, hy), Point(max_x, hy))
        dash_thick = max(0.2, round(mark_thickness * 0.75, 2))
        dash_shape.finish(color=(1, 1, 1, 1), fill=None, width=dash_thick, dashes=[4, 4])
        dash_shape.commit()

    logger.info(
        f"[CLUSTER_TILE] Drew tile cut marks (style={mark_style}): "
        f"{len(v_cuts)} v-lines × {len(h_cuts)} h-lines "
        f"({len(int_v)} internal v, {len(int_h)} internal h), "
        f"corners skipped"
    )

def draw_segment_cut_marks(
    out_page,
    segment_cut_lines: Dict,
    mark_off: float = 8.51,
    mark_len: float = 14.17,
    mark_thickness: float = 0.71,
    mark_style: str = 'default',
    bleed_pt: float = 0.0,
):
    """Vẽ hai dấu endpoint cho từng segment tách zone của mixed-guillotine.

    Khác ``draw_tile_cut_marks``, hàm này giữ nguyên phạm vi ``start/end`` của
    từng nhát cắt và không tạo tích Descartes giữa các toạ độ dọc/ngang.
    """
    from app.workers.pdf_types import Point

    segments = segment_cut_lines.get('segments', [])
    if not segments:
        return

    shape = out_page.new_shape()
    is_japanese = mark_style == 'japanese' and bleed_pt > 0.01
    drawn: set[tuple[float, float, float, float]] = set()

    def draw_once(x1: float, y1: float, x2: float, y2: float) -> None:
        key = tuple(round(value, 4) for value in (x1, y1, x2, y2))
        if key in drawn:
            return
        drawn.add(key)
        shape.draw_line(Point(x1, y1), Point(x2, y2))

    for segment in segments:
        axis = segment.get('axis')
        coordinate = float(segment.get('coordinate', 0.0))
        start = float(segment.get('start', 0.0))
        end = float(segment.get('end', 0.0))
        if end < start:
            start, end = end, start
        if end - start <= 0.01:
            continue

        if axis == 'x':
            x_values = (
                (coordinate - bleed_pt, coordinate + bleed_pt)
                if is_japanese
                else (coordinate,)
            )
            for x_value in x_values:
                draw_once(x_value, start - mark_off, x_value, start - mark_off - mark_len)
                draw_once(x_value, end + mark_off, x_value, end + mark_off + mark_len)
        elif axis == 'y':
            y_values = (
                (coordinate - bleed_pt, coordinate + bleed_pt)
                if is_japanese
                else (coordinate,)
            )
            for y_value in y_values:
                draw_once(start - mark_off, y_value, start - mark_off - mark_len, y_value)
                draw_once(end + mark_off, y_value, end + mark_off + mark_len, y_value)

    if not drawn:
        return
    shape.finish(color=(1, 1, 1, 1), fill=None, width=mark_thickness)
    shape.commit()

    logger.info(
        f"[MIXED_GUILLOTINE] Drew {len(drawn)} endpoint marks "
        f"for {len(segments)} zone segments (style={mark_style})"
    )
