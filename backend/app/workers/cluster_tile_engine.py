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
from typing import List, Tuple, Dict, Any, Optional

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465


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
                (r[0], r[1] + offset_x, r[2] + offset_y, r[3], r[4], r[5])
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
    # Tại mỗi h_cut (kể cả biên): vẽ dấu thập nhỏ centered tại (vx, hy)
    for vx in int_v:
        for hy in h_cuts:
            # Tick ngang (trái + phải)
            shape.draw_line(Point(vx - mark_off, hy), Point(vx + mark_off, hy))
        # Cũng vẽ nét dọc ra ngoài biên trên/dưới
        tick_v(vx, min_y - mark_off, min_y - mark_off - mark_len)
        tick_v(vx, max_y + mark_off, max_y + mark_off + mark_len)

    # ── Internal horizontal cuts (between tile rows) ──
    for hy in int_h:
        for vx in v_cuts:
            # Tick dọc (trên + dưới)
            shape.draw_line(Point(vx, hy - mark_off), Point(vx, hy + mark_off))
        # Nét ngang ra ngoài biên trái/phải
        tick_h(hy, min_x - mark_off, min_x - mark_off - mark_len)
        tick_h(hy, max_x + mark_off, max_x + mark_off + mark_len)

    shape.finish(color=(0, 0, 0), fill=None, width=mark_thickness)
    shape.commit()  # commit to page

    logger.info(
        f"[CLUSTER_TILE] Drew tile cut marks (style={mark_style}): "
        f"{len(v_cuts)} v-lines × {len(h_cuts)} h-lines "
        f"({len(int_v)} internal v, {len(int_h)} internal h), "
        f"corners skipped"
    )
