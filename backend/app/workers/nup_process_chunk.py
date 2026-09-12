"""
PDF page assembly worker - process_chunk.

Takes a batch of output sheets and renders source pages onto them
at computed coordinates. Handles page placement, mark drawing,
collision detection, and die-cut overlay.

Extracted from nup_engine.py for modularity.
"""

import os
import tempfile
import math
import logging
import pikepdf
from collections import defaultdict

from app.workers import pdf_wrapper as pdf_lib
from app.workers.pdf_ops import copy_output_intents
from app.workers.nup_layout_solver import get_src_page_idx
from app.workers.nup_diecut import (
    MIN_DIE_STROKE_WIDTH_PT,
    resolve_die_stroke_width,
)
from app.workers.nup_marks import _draw_ponts_on_page
from app.workers.cluster_tile_engine import (
    draw_segment_cut_marks,
    draw_tile_cut_marks,
)
from app.workers.nup_artwork import (
    place_one_artwork,
    compute_block_bbox,
    compute_output_clips,
    draw_die_lines_for_placement,
)
from app.workers.nup_cut_border import draw_cut_borders
from app.workers.mixed_guillotine_adapter import (
    resolve_guillotine_source_clip,
    resolve_guillotine_trim,
)

MM_TO_PTS = 2.83465
logger = logging.getLogger(__name__)


def _should_recompute_repeat_layout(layout_type, precalculated_placements):
    return layout_type == 'repeat' and precalculated_placements is None


def _recenter_die_cut_placements(placements, *, sheet_w, sheet_h,
                                 sheet_usable_w, sheet_usable_h,
                                 margin_left, margin_bottom, align):
    """Căn bbox placement thực tế của cụm tem bế vào tâm vùng sử dụng.

    Tọa độ ``original_cell_y`` là top-down; ``abs_y`` là bottom-up nên hai
    trường nhận dấu dịch ngược nhau. Chỉ căn các trục được yêu cầu bởi align.
    """
    if not placements or str(align or '').lower() not in {
        'center', 'top-center', 'bottom-center', 'center-left', 'center-right',
    }:
        return (0.0, 0.0)
    _min_x = min(float(p['abs_x']) for p in placements)
    _max_x = max(float(p['abs_x']) + float(p['width']) for p in placements)
    _min_y = min(float(p['original_cell_y']) for p in placements)
    _max_y = max(float(p['original_cell_y']) + float(p['height']) for p in placements)
    _dx = (float(margin_left) + float(sheet_usable_w) / 2.0
           - (_min_x + _max_x) / 2.0
           if str(align).lower() in {'center', 'top-center', 'bottom-center'} else 0.0)
    _dy = (float(sheet_h) - float(margin_bottom) - float(sheet_usable_h) / 2.0
           - (_min_y + _max_y) / 2.0
           if str(align).lower() in {'center', 'center-left', 'center-right'} else 0.0)
    for _p in placements:
        _p['abs_x'] = float(_p['abs_x']) + _dx
        _p['original_cell_y'] = float(_p['original_cell_y']) + _dy
        if 'abs_y' in _p:
            _p['abs_y'] = float(_p['abs_y']) - _dy
    return (_dx, _dy)


def _strip_color_from_stream(page_or_xobj, target_color):
    import pikepdf
    try:
        stream = pikepdf.parse_content_stream(page_or_xobj)
    except Exception as e:
        logger.debug(f"[_strip_color] Parse stream error: {e}", flush=True)
        return False

    new_stream = []
    current_stroke_color = None
    stroke_color_stack = []
    stripped = False

    logger.debug(f"[_strip_color] Starting parse. target_color={target_color}", flush=True)

    for operands, operator in stream:
        op = str(operator)
        
        # State save/restore
        if op == 'q':
            stroke_color_stack.append(current_stroke_color)
        elif op == 'Q':
            if stroke_color_stack:
                current_stroke_color = stroke_color_stack.pop()

        # Track STROKE color space (CS, not cs)
        elif op == 'CS':
            if operands:
                cs_name = str(operands[0])
                if cs_name not in ('/DeviceRGB', '/DeviceCMYK', '/DeviceGray', '/Pattern'):
                    current_stroke_color = 'SPOT'
                    logger.debug(f"[_strip_color] Found SPOT stroke color space: {cs_name}", flush=True)
                else:
                    current_stroke_color = None
        elif op in ('SCN', 'SC'):
            pass # Keep current_stroke_color for spot
            
        # Track STROKE color values (RG, K, G)
        elif op in ('RG', 'K', 'G'):
            try:
                current_stroke_color = tuple(round(float(x), 3) for x in operands)
            except Exception:
                current_stroke_color = None
                
        # If it's a stroke operation
        if op in ('S', 's', 'B', 'B*', 'b', 'b*'):
            match = False
            if current_stroke_color == 'SPOT':
                match = True
                logger.debug(f"[_strip_color] Stripping '{op}' because of SPOT color", flush=True)
            elif current_stroke_color and target_color and current_stroke_color != 'SPOT':
                if len(current_stroke_color) == len(target_color):
                    match = True
                    for c1, c2 in zip(current_stroke_color, target_color):
                        if abs(c1 - c2) > 0.01:
                            match = False
                            break
                    if match:
                        logger.debug(f"[_strip_color] Stripping '{op}' because of CMYK/RGB match", flush=True)
            
            if match:
                stripped = True
                if op in ('S', 's'):
                    continue  # Drop operator
                elif op == 'B':
                    operator = pikepdf.Operator('f')
                elif op == 'B*':
                    operator = pikepdf.Operator('f*')
                elif op == 'b':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('f')
                elif op == 'b*':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('f*')
        
        new_stream.append((operands, operator))

    if stripped:
        logger.debug(f"[_strip_color] Stream stripped successfully.", flush=True)
        new_contents = pikepdf.unparse_content_stream(new_stream)
        if isinstance(page_or_xobj, pikepdf.Page):
            page_or_xobj.contents_coalesce()
            page_or_xobj.get('/Contents').write(new_contents)
        else:
            page_or_xobj.write(new_contents)
        return True
    return False

def process_chunk(args):


    """Worker function to process a subset of output sheets."""

    from app.workers import pdf_wrapper as pdf_lib

    import os, tempfile, math

    from app.workers.nup_layout_solver import (
        get_src_page_idx,
        normalize_alternate_rotation,
        rectangle_inking_is_allowed,
        solve_manual,
        solve_optimal_layout,
    )

    from app.workers.nup_engine import compute_sticker_layout_for_page, _find_largest_die_path
    from app.workers.nup_diecut import resolve_default_page_die, resolve_one_dao_trim

    diagnostic_meta = {}
    worker_options = {}

    has_repeat_metadata_slot = (
        len(args) > 56
        and (args[54] is None or isinstance(args[54], dict))
    )
    if has_repeat_metadata_slot:
        raw_worker_metadata = args[54]
        if raw_worker_metadata and raw_worker_metadata.get("_nup_worker_metadata"):
            chunk_repeat_metadata = raw_worker_metadata.get("repeat")
            worker_options = raw_worker_metadata.get("options") or {}
            diagnostic_meta = raw_worker_metadata.get("diagnostic") or {}
        else:
            chunk_repeat_metadata = raw_worker_metadata
        base_args = args[:54] + args[55:]
    else:
        chunk_repeat_metadata, base_args = None, args

    from app.utils.preview_perf_log import log as _diag_log, sanitize_diagnostic_id
    diagnostic_trace_id = sanitize_diagnostic_id(
        diagnostic_meta.get("_diagnostic_trace_id")
    )
    diagnostic_job_id = sanitize_diagnostic_id(
        diagnostic_meta.get("_diagnostic_job_id")
    )

    # Engine mới nối page_sheet_mode và cut_border_config sau tuple legacy 56 giá trị.
    # Keep direct/older process_chunk callers compatible.
    page_sheet_mode = bool(base_args[56]) if len(base_args) > 56 else False
    cut_border_config = (
        base_args[57]
        if len(base_args) > 57 and isinstance(base_args[57], dict)
        else None
    )
    base_args = base_args[:56]

    (source_path, job_id, chunk_idx, start_sheet, end_sheet, 

     sheet_w, sheet_h, capacity, cells, bleed_pt, gap_x, gap_y, 

     mark_type, mark_len, mark_off, margin_left, margin_bottom, 

     sheet_usable_w, sheet_usable_h, align, cx_count, cy_count, cluster_gap,
     active_grid_w, active_grid_h, super_grid_w, super_grid_h,
     prog_file, total_page_count, layout_type, is_die_cut, pont_config, strategy, detected_shapes_by_page, target_quantity, detected_shape_params_by_page, sheet_mapping, chunk_precalc_placements,
     cut_type, grouping_strategy, chunk_cluster_tile_cuts, separate_cut_page, ponts_on_cut_file, fill_block_gap_mm, global_total_sheets, main_secondary_gap, mark_thick, mark_style, duplex_flow, die_size_mode, die_offset_mm, target_quantities_by_page, manual_cols, manual_rows, homogeneous_mode, homogeneous_master_idx) = base_args

    alternate_rotation = normalize_alternate_rotation(
        worker_options.get("alternate_rotation", "none")
    )
    _chunk_diecut_inking = rectangle_inking_is_allowed(
        is_die_cut=bool(is_die_cut),
        page_sheet_mode=bool(page_sheet_mode),
        layout_type=str(layout_type or ''),
        cut_type=str(cut_type or 'default'),
        shapes_by_page=detected_shapes_by_page,
    )
    if page_sheet_mode or layout_type == 'mixed_guillotine' or (is_die_cut and not _chunk_diecut_inking):
        alternate_rotation = 'none'

    src_doc = pdf_lib.open(source_path)
    # Geometry must remain immutable while the print copy is stripped. Shared
    # Form XObjects can be referenced by more than one source page.
    geometry_doc = pdf_lib.open(source_path) if page_sheet_mode else None

    local_stripped_pages = set()

    page_count = src_doc.page_count

    # [GUILLOTINE-BOX FIX 2026-08-04 / PAGE-SHEET 2026-08-13] Solver và renderer
    # phải cùng dùng hộp trang hiệu dụng. Cache một lần mỗi trang trong worker để
    # không đọc PageBox lại cho từng ô khi một tờ có hàng trăm sản phẩm.
    guillotine_source_clips = {}
    if not is_die_cut:
        for source_page_idx in range(page_count):
            clip_values = resolve_guillotine_source_clip(
                src_doc[source_page_idx], bleed_pt,
            )
            guillotine_source_clips[source_page_idx] = (
                pdf_lib.Rect(*clip_values) if clip_values is not None else None
            )

    out_doc = pdf_lib.open()
    # [BLEED-COLOR FIX 2026-08-18] Bù xén lấy mẫu đã có ICCBased riêng, còn artwork
    # CMYK Device* dựa vào OutputIntent ở catalog. Giữ profile này trên mọi chunk
    # để sau khi bình hai lớp vẫn được RIP/viewer diễn giải cùng một quản lý màu.
    copy_output_intents(src_doc._pdf, out_doc._pdf)

    sheets_per_page = 1

    total_capacity = capacity * cx_count * cy_count
    # Build only the mapping needed by this chunk. Previously the full S-sheet
    # mapping was rebuilt inside every sheet iteration, producing O(S^2) work.
    if chunk_repeat_metadata:
        _rust_sheet_mapping = {
            index: int(value[0]) for index, value in chunk_repeat_metadata.items()
        }
    elif isinstance(sheet_mapping, dict):
        _rust_sheet_mapping = sheet_mapping
    elif isinstance(sheet_mapping, (list, tuple)):
        _rust_sheet_mapping = {
            index: sheet_mapping[index]
            for index in range(start_sheet, min(end_sheet, len(sheet_mapping)))
        }
    else:
        _rust_sheet_mapping = None

    if layout_type == 'repeat' and target_quantity > 0:

        sheets_per_page = math.ceil(target_quantity / total_capacity)

    # Cache die-cut geometry per source page to avoid redundant extract_vector_paths() calls

    # Key: src_page_idx, Value: (sx0, sy0, sx1, sy1, tx0, ty0, tx1, ty1) or None

    _diecut_geom_cache = {}
    _die_items_cache = {}
    _die_path_cache = {}    # Cache _find_largest_die_path result per src_page_idx
    _layout_cache = {}      # Cache compute_sticker_layout_for_page result per src_page_idx
    _base_poly_cache = {}   # Cache (base_poly, base_rect_pts) cho collision theo src_page_idx (mẫu)

    # ── Khuôn master (homogeneous trộn mẫu HOẶC single-mold Bình trang) ──
    # Seed đường bế master để: (1) vẽ cutline trên trang nội dung không path bế,
    # (2) map artwork theo rect khuôn master thay vì MediaBox cả trang.
    # Registration clip+co-khít (artwork_bbox) CHỈ khi homogeneous_mode=True.
    _artwork_bbox_cache = {}
    _hom_master_die = None  # (items, rect, color, width) của khuôn master → vẽ đường bế mỗi ô
    _sh_mod = None
    if homogeneous_master_idx is not None:
        try:
            if homogeneous_mode:
                from app.workers import sticker_homogeneous as _sh_mod
            _mp = src_doc[homogeneous_master_idx]
            _m_path = _find_largest_die_path(_mp)
            if _m_path:
                _hom_master_die = {
                    'items': _m_path.get('items', []),
                    'rect': _m_path['rect'],
                    'color': _m_path.get('color', (0, 1, 1, 0)),
                    'width': _m_path.get('width', 0.5),
                    'spot_name': _m_path.get('spot_name'),
                }
                # Pre-seed cache cho trang KHÔNG có path bế THẬT: geom + items = master.
                # page_has_die (kênh/spot) đáng tin hơn _find_largest_die_path (dễ dính artwork).
                # place_one_artwork / vẽ cutline dùng cache này → không rơi về trimbox trang.
                try:
                    from app.workers.sticker_homogeneous import page_has_die as _page_has_die
                except Exception:
                    _page_has_die = None
                _mr = _m_path['rect']
                _seeded_n = 0
                for _pi in range(page_count):
                    if _pi == homogeneous_master_idx:
                        continue
                    _sp = src_doc[_pi]
                    _has_own = False
                    if _page_has_die is not None:
                        try:
                            _has_own = bool(_page_has_die(_sp))
                        except Exception:
                            _has_own = _find_largest_die_path(_sp) is not None
                    else:
                        _has_own = _find_largest_die_path(_sp) is not None
                    if _has_own:
                        continue  # trang có khuôn riêng — giữ path của nó
                    _ck = f"{job_id}_{_pi}"
                    _sx0, _sy0, _sx1, _sy1 = _sp.rect
                    # Cùng hệ toạ độ với master (file 1 khuôn multi-art thường cùng MediaBox).
                    _diecut_geom_cache[_ck] = (
                        _sx0, _sy0, _sx1, _sy1,
                        _mr.x0, _mr.y0, _mr.x1, _mr.y1,
                    )
                    _die_items_cache[_ck] = dict(_hom_master_die)
                    _die_path_cache[_pi] = _m_path
                    _seeded_n += 1
                logger.debug(
                    "[SINGLE-MOLD/HOM] seed master die p=%s → %d content page(s)",
                    homogeneous_master_idx, _seeded_n,
                )
        except Exception as _e_hm:
            logger.debug(f"[MASTER-DIE] seed master die failed: {_e_hm}", flush=True)
            _hom_master_die = None
            if not homogeneous_mode:
                _sh_mod = None

    _MAX_GEOM_CACHE = 200  # Giới hạn để tránh memory leak

    total_capacity = capacity * cx_count * cy_count

    super_base_x = margin_left

    if 'center' in align:

        super_base_x = margin_left + (sheet_usable_w - super_grid_w) / 2

    elif 'right' in align:

        super_base_x = sheet_w - (sheet_w - margin_left - sheet_usable_w) - super_grid_w

    super_base_y = margin_bottom

    if 'center' in align:

        super_base_y = margin_bottom + (sheet_usable_h - super_grid_h) / 2

    elif 'top' in align:

        super_base_y = sheet_h - (sheet_h - margin_bottom - sheet_usable_h) - super_grid_h


    for sheet_idx in range(start_sheet, end_sheet):


        out_page = out_doc.new_page(width=sheet_w, height=sheet_h)

        # Store cuts per cluster and per blockId

        # dict structure: { cluster_idx: { block_id: {'v': set(), 'h': set()} } }

        block_cuts = {}

        cur_cells = cells

        cur_capacity = capacity

        cur_active_grid_w = active_grid_w

        cur_active_grid_h = active_grid_h

        cur_super_base_x = super_base_x

        cur_super_base_y = super_base_y

        if _should_recompute_repeat_layout(layout_type, chunk_precalc_placements):

            # Repeat sheets are not uniformly distributed when each page has its
            # own size/quantity. sheet_mapping is the source of truth built by
            # nup_engine; deriving from sheet_idx selects another page's geometry.
            if sheet_mapping and sheet_idx < len(sheet_mapping):
                src_page_idx = int(sheet_mapping[sheet_idx])
            else:
                src_page_idx = sheet_idx // sheets_per_page if sheets_per_page > 0 else sheet_idx

            if src_page_idx < page_count:

                src_page = src_doc[src_page_idx]
                cur_geom_rect = None

                if is_die_cut:
                    # ── CACHE: _find_largest_die_path per source page ──
                    if src_page_idx in _die_path_cache:
                        largest_path = _die_path_cache[src_page_idx]
                    else:
                        largest_path = _find_largest_die_path(src_page)
                        _die_path_cache[src_page_idx] = largest_path

                    if largest_path is None and cut_type == 'default':
                        # UIUX (audit 2026-08-14 §DIE-FALLBACK-03): chỉ bù Co/Mở
                        # khung trang fallback; CutContour thật ở nhánh trên bất biến.
                        largest_path = resolve_default_page_die(
                            src_page, die_offset_mm,
                        )

                    if largest_path:

                        cur_geom_rect = (largest_path['rect'].x0, largest_path['rect'].y0, largest_path['rect'].x1, largest_path['rect'].y1)

                # 1 Dao + "theo kích thước trang": trim = mediabox ± offset (nguồn chân
                # lý dùng chung export/preview). Trả None → giữ logic cũ (khuôn/rect-bleed).
                _one_dao_trim = resolve_one_dao_trim(
                    src_page, cut_type, die_size_mode, die_offset_mm,
                )

                if _one_dao_trim is not None:

                    cur_trim_w, cur_trim_h = _one_dao_trim

                elif cur_geom_rect:

                    cur_trim_w = cur_geom_rect[2] - cur_geom_rect[0]

                    cur_trim_h = cur_geom_rect[3] - cur_geom_rect[1]

                elif not is_die_cut:

                    # Nhánh repeat tự solve lại trong worker nên phải dùng cùng
                    # PageBox với engine/preview. Điều này cũng áp dụng cho Nguyên
                    # tấm decal có CropBox logic trên MediaBox lớn.
                    cur_trim_w, cur_trim_h = resolve_guillotine_trim(
                        src_page, bleed_pt,
                    )

                else:

                    # Nhánh die-cut cũ: giữ hình học trang hiện hành.
                    cur_trim_w = src_page.rect.width

                    cur_trim_h = src_page.rect.height

                    cur_trim_w -= 2 * bleed_pt

                    cur_trim_h -= 2 * bleed_pt

                if is_die_cut and strategy in ('simple_auto', 'optimal_auto', 'staggered', 'grid', 'head_to_tail'):

                    # ── CACHE: compute_sticker_layout_for_page per source page ──
                    if src_page_idx in _layout_cache:
                        sticker_layout = _layout_cache[src_page_idx]
                    else:
                        frontend_shape = None

                        if detected_shapes_by_page:

                            frontend_shape = detected_shapes_by_page.get(str(src_page_idx)) or detected_shapes_by_page.get(src_page_idx)

                        frontend_shape_props = {}

                        if detected_shape_params_by_page:

                            frontend_shape_props = detected_shape_params_by_page.get(str(src_page_idx)) or detected_shape_params_by_page.get(src_page_idx) or {}

                        # Compute secondary_gap for fillBlockGap
                        _chunk_secondary_gap = main_secondary_gap
                        if cut_type == 'one_dao' and fill_block_gap_mm > 0:
                            _chunk_secondary_gap = fill_block_gap_mm * 2.83465

                        sticker_layout = compute_sticker_layout_for_page(
                            page=src_page,

                            sheet_usable_w=sheet_usable_w,

                            sheet_usable_h=sheet_usable_h,

                            gap_x=gap_x,

                            gap_y=gap_y,

                            strategy=strategy,

                            shape_type_override=frontend_shape if frontend_shape else None,

                            shape_props_override=frontend_shape_props if frontend_shape_props else None,

                            bleed_pt=bleed_pt,

                            secondary_gap=_chunk_secondary_gap,

                            cut_type=cut_type,
                            die_size_mode=die_size_mode,
                            die_offset_mm=die_offset_mm,
                            alternate_rotation=alternate_rotation,

                        )
                        _layout_cache[src_page_idx] = sticker_layout

                    cur_cells = sticker_layout.get('items', [])

                    cur_capacity = sticker_layout.get('totalItems', 0)

                    cur_active_grid_w = sticker_layout.get('widthUsed', 0)

                    cur_active_grid_h = sticker_layout.get('heightUsed', 0)

                else:

                    # CHIA CỌC (chia đều): mỗi cọc chỉ chiếm usable ĐÃ CHIA theo cx/cy,
                    # KHÔNG phải cả tờ. Mirror nup_engine (usable_w/h chia trước solve).
                    # Trước đây solve bằng sheet_usable (đầy đủ) → mỗi cọc cao/rộng bằng
                    # cả tờ, nhân cx/cy → super_grid vượt khổ → tràn mép (super_base âm).
                    _uw_solve = sheet_usable_w
                    _uh_solve = sheet_usable_h
                    if cx_count >= 2:
                        _uw_solve = (sheet_usable_w - cluster_gap * (cx_count - 1)) / cx_count
                    if cy_count >= 2:
                        _uh_solve = (sheet_usable_h - cluster_gap * (cy_count - 1)) / cy_count
                    if strategy == 'manual' and manual_cols > 0 and manual_rows > 0:
                        cur_layout = solve_manual(
                            cur_trim_w, cur_trim_h, gap_x, gap_y,
                            manual_cols, manual_rows, alternate_rotation,
                        )
                    else:
                        cur_layout = solve_optimal_layout(
                            _uw_solve, _uh_solve, cur_trim_w, cur_trim_h,
                            gap_x, gap_y, strategy, main_secondary_gap,
                            alternate_rotation,
                        )

                    cur_cells = cur_layout['cells']

                    cur_capacity = cur_layout['totalItems']

                    cur_active_grid_w = cur_layout['overallWidth']

                    cur_active_grid_h = cur_layout['overallHeight']

                cur_super_grid_w = cx_count * cur_active_grid_w + max(0, cx_count - 1) * cluster_gap

                cur_super_grid_h = cy_count * cur_active_grid_h + max(0, cy_count - 1) * cluster_gap

                cur_super_base_x = margin_left

                if 'center' in align:

                    cur_super_base_x = margin_left + (sheet_usable_w - cur_super_grid_w) / 2

                elif 'right' in align:

                    cur_super_base_x = sheet_w - (sheet_w - margin_left - sheet_usable_w) - cur_super_grid_w

                cur_super_base_y = margin_bottom

                if 'center' in align:

                    cur_super_base_y = margin_bottom + (sheet_usable_h - cur_super_grid_h) / 2

                elif 'top' in align:

                    cur_super_base_y = sheet_h - (sheet_h - margin_bottom - sheet_usable_h) - cur_super_grid_h

        # --- Phase 1: Collect all absolute placements ---

        if chunk_precalc_placements is not None:

            placements = chunk_precalc_placements.get(sheet_idx, [])

            # Convert dict keys from string to int if necessary (JSON serialization might change it)

            if not placements and str(sheet_idx) in chunk_precalc_placements:

                placements = chunk_precalc_placements[str(sheet_idx)]

            logger.debug(
                "[ROT-AUDIT][phase1][sheet=%d] source=PRECALC n=%d layout=%s",
                sheet_idx, len(placements), layout_type,
            )
            try:
                from app.workers.rot_audit_log import get_logger as _rot_get_logger
                _rot_get_logger().warning(
                    "[ROT-AUDIT][phase1][sheet=%d] source=PRECALC n=%d layout=%s",
                    sheet_idx, len(placements), layout_type,
                )
            except Exception:
                pass

        else:

            # Try Rust fast path for placement calculation
            try:
                import pdfcompare_native as _native
                # Rust binding expects PyDict; this chunk-local map is O(chunk).
                _sm = _rust_sheet_mapping
                placements = _native.compute_placements(
                    
                    sheet_idx=sheet_idx,
                    cells=cur_cells,
                    capacity=cur_capacity,
                    cx_count=cx_count,
                    cy_count=cy_count,
                    cluster_gap=cluster_gap,
                    active_grid_w=cur_active_grid_w,
                    active_grid_h=cur_active_grid_h,
                    super_base_x=cur_super_base_x,
                    super_base_y=cur_super_base_y,
                    sheet_w=sheet_w,
                    sheet_h=sheet_h,
                    layout_type=layout_type,
                    total_capacity=total_capacity,
                    page_count=page_count,
                    sheet_mapping=_sm,
                )
                logger.debug(
                    "[ROT-AUDIT][phase1][sheet=%d] source=RUST_COMPUTE_PLACEMENTS n=%d "
                    "layout=%s cx=%d cy=%d active_grid=%.1fx%.1f super_base=(%.1f,%.1f)",
                    sheet_idx, len(placements), layout_type, cx_count, cy_count,
                    cur_active_grid_w, cur_active_grid_h, cur_super_base_x, cur_super_base_y,
                )
                try:
                    from app.workers.rot_audit_log import get_logger as _rot_get_logger
                    _rot_get_logger().warning(
                        "[ROT-AUDIT][phase1][sheet=%d] source=RUST_COMPUTE_PLACEMENTS n=%d "
                        "layout=%s cx=%d cy=%d active_grid=%.1fx%.1f super_base=(%.1f,%.1f)",
                        sheet_idx, len(placements), layout_type, cx_count, cy_count,
                        cur_active_grid_w, cur_active_grid_h, cur_super_base_x, cur_super_base_y,
                    )
                except Exception:
                    pass
            except ImportError:
                # Python fallback — chỉ khi Rust module thiếu
                placements = []

                for cy in range(cy_count):

                    for cx in range(cx_count):

                        cluster_base_x = cur_super_base_x + cx * (cur_active_grid_w + cluster_gap)

                        visual_cy = cy_count - 1 - cy

                        cluster_base_y = cur_super_base_y + visual_cy * (cur_active_grid_h + cluster_gap)

                        for cell_idx, cell in enumerate(cur_cells):

                            cluster_idx = cy * cx_count + cx

                            cell_on_sheet_idx = cluster_idx * cur_capacity + cell_idx

                            if sheet_mapping and layout_type == 'repeat':

                                src_page_idx = sheet_mapping[sheet_idx]

                            else:

                                src_page_idx = get_src_page_idx(sheet_idx, cell_on_sheet_idx, layout_type, total_capacity, page_count)


                            if src_page_idx >= total_page_count:

                                continue # Allow other cells on sheet to process if non-sequential

                            cell_x = cluster_base_x + cell['x']

                            cell_y_from_bottom = cluster_base_y + (cur_active_grid_h - cell['y'] - cell['height'])

                            cell_y = sheet_h - cell_y_from_bottom - cell['height']

                            placements.append({

                                'cluster_idx': cluster_idx,

                                'cell': cell,

                                'src_page_idx': src_page_idx,

                                'abs_x': cell_x,

                                'abs_y': cell_y_from_bottom,

                                'width': cell['width'],

                                'height': cell['height'],

                                'original_cell_y': cell_y

                            })

        # Repeat quantities are exact. The final sheet for a page may only need
        # part of the geometric capacity; trim the generated full-grid placement
        # list using the same per-page quantity that built sheet_mapping.
        if layout_type == 'repeat' and sheet_mapping and placements:
            try:
                _repeat_meta = (chunk_repeat_metadata or {}).get(sheet_idx)
                if _repeat_meta is not None:
                    _repeat_src_idx = int(_repeat_meta[0])
                    _page_sheet_ordinal = int(_repeat_meta[1])
                else:
                    if isinstance(sheet_mapping, dict):
                        _mapping_value = lambda _idx: sheet_mapping.get(_idx, sheet_mapping.get(str(_idx)))
                    else:
                        _mapping_value = lambda _idx: sheet_mapping[_idx]
                    _repeat_src_idx = int(_mapping_value(sheet_idx))
                    # Backward compatibility for legacy direct process_chunk callers.
                    _page_sheet_ordinal = sum(
                        1 for _idx in range(sheet_idx)
                        if int(_mapping_value(_idx)) == _repeat_src_idx
                    )
                _repeat_qty_raw = (target_quantities_by_page or {}).get(
                    str(_repeat_src_idx),
                    (target_quantities_by_page or {}).get(_repeat_src_idx, target_quantity),
                )
                _repeat_qty = int(_repeat_qty_raw or 0)
                if _repeat_qty > 0:
                    _sheet_capacity = max(1, int(cur_capacity) * int(cx_count) * int(cy_count))
                    _remaining = _repeat_qty - _page_sheet_ordinal * _sheet_capacity
                    placements = placements[:max(0, min(len(placements), _remaining))]
            except (KeyError, IndexError, TypeError, ValueError):
                # Invalid legacy mapping: preserve the old full-sheet behavior.
                pass

        # [IMPOSE FIX 2026-09-13 §CENTER.1] Với tem bế, số lượng thực tế trên
        # tờ cuối hoặc layout sole có thể làm bbox placement nhỏ/lệch so với
        # ``widthUsed/heightUsed`` danh nghĩa của solver. Căn theo bbox THỰC
        # sau khi cắt số lượng, thay vì căn theo grid lý thuyết; giữ đồng nhất
        # giữa preview và PDF xuất vì đây là tọa độ cuối cùng writer sử dụng.
        if is_die_cut and placements:
            try:
                _dx, _dy = _recenter_die_cut_placements(
                    placements, sheet_w=sheet_w, sheet_h=sheet_h,
                    sheet_usable_w=sheet_usable_w, sheet_usable_h=sheet_usable_h,
                    margin_left=margin_left, margin_bottom=margin_bottom, align=align,
                )
                if abs(_dx) > 1e-7 or abs(_dy) > 1e-7:
                    logger.debug(
                        "[CENTER] die-cut sheet=%d shift=(%.3f,%.3f)", sheet_idx, _dx, _dy,
                    )
            except (KeyError, TypeError, ValueError):
                logger.debug("[CENTER] die-cut recenter bỏ qua placement không hợp lệ")

        if sheet_idx == start_sheet:
            # Đây là danh sách thật sẽ đi qua collision rồi dựng PDF, không phải
            # capacity ước lượng ở route/engine.
            _diag_log(
                "EXPORT", "worker.placements",
                trace_id=diagnostic_trace_id,
                job_id=diagnostic_job_id or job_id,
                chunk=chunk_idx,
                sheet=sheet_idx,
                layout_type=layout_type,
                source="precalculated" if chunk_precalc_placements is not None else "solver",
                solver_capacity=cur_capacity * cx_count * cy_count,
                placements_before_collision=len(placements),
                split_gap_pt=main_secondary_gap,
            )
            # SEC (audit 2026-09-05 §LOG.06): không nhân đôi payload
            # diagnostic sang logger chuẩn; `_diag_log` đã fail-closed ngoài dev.

        # --- Duplex Mirroring ---
        # MIXED-GUILLOTINE (audit 2026-07-30 §MG.5): mặt sau mode mới đã được
        # planner phản chiếu cả vị trí lẫn góc xoay. Chỉ dùng phép mirror X legacy
        # khi placements chưa đồng loạt mang marker đó.
        _duplex_transform_materialized = (
            bool(placements)
            and all(p.get('_duplex_transform_applied', False) for p in placements)
        )
        if (duplex_flow == 'double' and sheet_idx % 2 == 1
                and not _duplex_transform_materialized):
            for p in placements:
                # Mirror X coordinate across the sheet width
                p['abs_x'] = sheet_w - (p['abs_x'] + p['width'])
                # If the item is rotated 90 degrees CCW (isRotated=True), its top edge was pointing to the left.
                # After mirroring horizontally, its top edge points to the right. 
                # Pointing to the right means it needs an additional 180 degree rotation (90 CW = 270 CCW).
                if p['cell'].get('isRotated', False):
                    p['cell']['isRotated180'] = not p['cell'].get('isRotated180', False)

        
        # --- Phase 2: Collision Detection ---
        

        # Mặt sau duplex đã bị mirror ngay phía trên nên marker từ parent không còn
        # chứng minh hình học hiện tại an toàn; bắt buộc kiểm tra lại trên tờ lẻ.
        _pont_already_resolved = (
            bool(placements)
            and not (duplex_flow == 'double' and sheet_idx % 2 == 1)
            and all(p.get('_pont_collision_resolved', False) for p in placements)
        )
        if (
            (is_die_cut or page_sheet_mode)
            and pont_config
            and not pont_config.get('disableCollision', False)
            and not _pont_already_resolved
        ):

            from app.workers.pont_collision import (
                MM_TO_PTS,
                build_collision_base_polygon,
                calculate_forbidden_zones,
                detect_collisions,
                smart_resolve_collisions,
            )

            # Determine margins - use pont_config values (which are in MM) if available, otherwise default to margin_bottom/margin_left (which are in PT)

            margins = {

                'top': pont_config.get('marginTop') * MM_TO_PTS if pont_config.get('marginTop') is not None else margin_bottom,

                'bottom': pont_config.get('marginBottom') * MM_TO_PTS if pont_config.get('marginBottom') is not None else margin_bottom,

                'left': pont_config.get('marginLeft') * MM_TO_PTS if pont_config.get('marginLeft') is not None else margin_left,

                'right': pont_config.get('marginRight') * MM_TO_PTS if pont_config.get('marginRight') is not None else margin_left

            }

            zones = calculate_forbidden_zones(pont_config, margins, sheet_w, sheet_h)

            if zones and placements:

                # Try to extract shape from the first valid source page
                first_src_idx = placements[0]['src_page_idx']

                # ── CACHE base_poly theo MẪU (first_src_idx) ───────────────────────────
                # base_poly là HÌNH của một con tem (bất biến giữa các tờ). Trước đây khối
                # này gọi extract_vector_paths() + build_shapely_polygon_from_paths() LẠI
                # MỖI TỜ (check cache cũ lệch kiểu key int↔str nên luôn miss) → mẫu phức
                # tạp tốn ~1,4s × số tờ (đo thật: 1 chunk 7,27s). Cache kết quả theo mẫu ⇒
                # extract 1 lần/mẫu/chunk; collision result KHÔNG đổi (cùng polygon, zones).
                _bp_key = (first_src_idx, placements[0]['width'], placements[0]['height'])
                if _bp_key in _base_poly_cache:
                    base_poly, base_rect_pts = _base_poly_cache[_bp_key]
                else:
                    _iw0 = float(placements[0]['width'])
                    _ih0 = float(placements[0]['height'])
                    src_page = src_doc[first_src_idx]

                    # Use mathematically perfect polygon for Circle/Ellipse
                    shape_type = (detected_shapes_by_page.get(str(first_src_idx)) or detected_shapes_by_page.get(first_src_idx, 'CUSTOM')) if is_die_cut else 'CUSTOM'
                    # 1 Dao / chữ nhật: KHÔNG extract path artwork (mảng màu) làm base_poly
                    # — scale sai → boong "không va chạm". Dùng đúng chữ nhật ô tem.
                    # (cut_type lấy từ args process_chunk — không có dict `settings` ở đây.)
                    _is_rect_cell = (
                        page_sheet_mode
                        or cut_type == 'one_dao'
                        or bool((_layout_cache.get(first_src_idx) or {}).get('isPageFallback'))
                        or str(shape_type).upper() == 'RECTANGLE'
                    )
                    base_poly, base_rect_pts = build_collision_base_polygon(
                        src_page,
                        shape_type,
                        _iw0,
                        _ih0,
                        is_rect_cell=_is_rect_cell,
                    )

                    _base_poly_cache[_bp_key] = (base_poly, base_rect_pts)

                initial_cols = detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h)

                try:
                    from app.workers.rot_audit_log import get_logger as _rot_get_logger
                    _rot_get_logger().warning(
                        "[ROT-AUDIT][COLLISION][RENDER sheet=%d] n_in=%d zones=%s base_poly_bounds=%s "
                        "base_rect=%s sheet=%.1fx%.1f margins=%s collide=%d absXY_in=%s",
                        sheet_idx, len(placements),
                        [tuple(round(z, 1) for z in zz) for zz in zones],
                        (tuple(round(b, 1) for b in base_poly.bounds) if base_poly is not None else None),
                        tuple(round(b, 1) for b in base_rect_pts), sheet_w, sheet_h,
                        {k: round(v, 1) for k, v in margins.items()}, len(initial_cols),
                        [(round(p['abs_x'], 1), round(p['abs_y'], 1)) for p in placements],
                    )
                except Exception:
                    pass

                if initial_cols:
                    placements = smart_resolve_collisions(placements, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
                    try:
                        from app.workers.rot_audit_log import get_logger as _rot_get_logger
                        _rot_get_logger().warning(
                            "[ROT-AUDIT][COLLISION][RENDER sheet=%d] n_out=%d absXY_out=%s",
                            sheet_idx, len(placements),
                            [(round(p['abs_x'], 1), round(p['abs_y'], 1)) for p in placements],
                        )
                    except Exception:
                        pass

        # --- Phase 3: Render ---
        if sheet_idx == start_sheet:
            _diag_log(
                "EXPORT", "worker.render",
                trace_id=diagnostic_trace_id,
                job_id=diagnostic_job_id or job_id,
                chunk=chunk_idx,
                sheet=sheet_idx,
                placements=len(placements),
            )

        # IMPOSE (audit 2026-09-01 §CLIPOWN.1): Bình cắt xén thường chia quyền
        # clip theo láng giềng hình học toàn tờ. Tem bế/CNC/page-sheet vẫn giữ bbox
        # block vì bbox đó còn là hợp đồng của clip theo hình khuôn.
        _output_clips = None
        if not is_die_cut and not page_sheet_mode:
            _output_clips = compute_output_clips(placements, bleed_pt)
        _block_bbox = (
            compute_block_bbox(placements)
            if is_die_cut or page_sheet_mode
            else {}
        )
        _clip_off_x = min(gap_x / 2.0, bleed_pt) if gap_x > 0 else 0.0
        _clip_off_y = min(gap_y / 2.0, bleed_pt) if gap_y > 0 else 0.0
        # Fallback khung trang không có đường bế thật nên không phụ thuộc bleed
        # đang lưu ẩn trên UI; chỉ nửa khoảng hở thật mới giới hạn va chạm artwork.
        _fallback_gap_half_x = max(0.0, gap_x / 2.0)
        _fallback_gap_half_y = max(0.0, gap_y / 2.0)


        cut_border_trim_rects = []
        for p in placements:

            cell = p['cell']

            cluster_idx = p['cluster_idx']

            # ── Chế độ ĐỒNG NHẤT: registration nội dung vào khuôn (clip+co-khít+căn-tâm) ──
            _hom_clip = None
            if homogeneous_mode and is_die_cut:
                _src_idx = p['src_page_idx']
                if _src_idx not in _artwork_bbox_cache:
                    _bb = None
                    try:
                        if _sh_mod is not None:
                            _bb = _sh_mod.artwork_bbox(src_doc[_src_idx])
                    except Exception as _e_bb:
                        logger.debug(f"[HOMOGENEOUS] artwork_bbox page={_src_idx} lỗi: {_e_bb}", flush=True)
                        _bb = None
                    _artwork_bbox_cache[_src_idx] = _bb
                _bb = _artwork_bbox_cache[_src_idx]
                if _bb is None:
                    # Trang nội dung rỗng → bỏ ô an toàn (không render, không sập).
                    continue
                _hom_clip = pdf_lib.Rect(_bb.x0, _bb.y0, _bb.x1, _bb.y1)
                # Seed đường bế MASTER cho ô này để Phase die-overlay vẽ khuôn ở mỗi ô.
                if _hom_master_die is not None:
                    _ck = f"{job_id}_{_src_idx}"
                    if _ck not in _die_items_cache:
                        _die_items_cache[_ck] = dict(_hom_master_die)

            # Đặt artwork qua hàm DÙNG CHUNG (nguồn chân lý duy nhất — xem nup_artwork.py)
            _output_clip_kw = {}
            if _output_clips is not None:
                _output_clip_kw['output_clip'] = _output_clips[id(p)]

            trim_rect, src_page_idx = place_one_artwork(
                out_page, src_doc, p,
                bleed_pt=bleed_pt, is_die_cut=is_die_cut, cut_type=cut_type,
                separate_cut_page=separate_cut_page, local_stripped_pages=local_stripped_pages,
                job_id=job_id, diecut_geom_cache=_diecut_geom_cache, die_items_cache=_die_items_cache,
                max_geom_cache=_MAX_GEOM_CACHE, block_bbox=_block_bbox,
                clip_off_x=_clip_off_x, clip_off_y=_clip_off_y,
                find_largest_die_path=_find_largest_die_path,
                homogeneous_clip=_hom_clip,
                die_size_mode=die_size_mode, die_offset_mm=die_offset_mm,
                page_sheet_mode=page_sheet_mode,
                geometry_doc=geometry_doc,
                guillotine_source_clip=guillotine_source_clips.get(
                    p['src_page_idx']
                ),
                fallback_gap_half_x=_fallback_gap_half_x,
                fallback_gap_half_y=_fallback_gap_half_y,
                **_output_clip_kw,
            )
            cut_border_trim_rects.append(trim_rect)

            block_id = cell.get('blockId', 0)

            if cluster_idx not in block_cuts:

                block_cuts[cluster_idx] = {}

            if block_id not in block_cuts[cluster_idx]:

                block_cuts[cluster_idx][block_id] = {'v': set(), 'h': set()}

            block_cuts[cluster_idx][block_id]['v'].add(round(trim_rect.x0, 2))

            block_cuts[cluster_idx][block_id]['v'].add(round(trim_rect.x1, 2))

            block_cuts[cluster_idx][block_id]['h'].add(round(trim_rect.y0, 2))

            block_cuts[cluster_idx][block_id]['h'].add(round(trim_rect.y1, 2))

        if page_sheet_mode and separate_cut_page and placements:
            missing_cut_pages = sorted({
                int(p.get('cell', {}).get(
                    'pageIdx',
                    p.get('src_page_idx', 0),
                ))
                for p in placements
                if not (
                    _die_items_cache.get(
                        f"{job_id}_{int(p.get('cell', {}).get('pageIdx', p.get('src_page_idx', 0)))}"
                    )
                    or {}
                ).get('items')
            })
            if missing_cut_pages:
                missing_labels = ", ".join(
                    str(index + 1) for index in missing_cut_pages
                )
                out_doc.close()
                if geometry_doc is not None:
                    geometry_doc.close()
                src_doc.close()
                raise ValueError(
                    "Không tìm thấy đường khuôn bế trên trang nguồn: "
                    f"{missing_labels}."
                )

        # CUT-BORDER (audit 2026-08-04 §CB.4): vẽ SAU toàn bộ artwork để bleed
        # của ô đặt sau không che mất nét cắt của ô trước. Trim/Bleed đều dùng
        # trim_rect trả từ placement thật nên tự đúng cho xoay và mixed-size.
        if cut_border_config and not is_die_cut and not page_sheet_mode:
            draw_cut_borders(
                out_page,
                cut_border_trim_rects,
                cut_border_config,
                bleed_pt=float(bleed_pt),
            )

        # Draw guillotine marks exactly around the cut lines

        # Draw guillotine marks exactly around the cut lines per block per cluster

        if not is_die_cut and (mark_type == 'guillotine' or mark_type == 'corners'):

            shape = out_page.new_shape()

            # Rust-only: compute mark coordinates (Japanese double-line supported via bleed_offset)
            bleed_for_marks = float(bleed_pt) if mark_style == 'japanese' else 0.0
            import pdfcompare_native as _native
            mark_segs = _native.compute_mark_coords(placements, mark_type, float(mark_off), float(mark_len), bleed_for_marks)
            for seg in mark_segs:
                shape.draw_line(pdf_lib.Point(seg['x1'], seg['y1']), pdf_lib.Point(seg['x2'], seg['y2']))

            shape.finish(color=(1, 1, 1, 1), width=mark_thick)  # registration (mọi kẽm)

            shape.commit()
        # MARKS (audit 2026-08-01 §DXM.1/§DXM.2): `none` phải tắt mọi dấu.
        # Mixed dùng segment tách zone thật; cluster_tile cũ vẫn dùng lưới {v,h}.
        if mark_type != 'none' and sheet_idx in chunk_cluster_tile_cuts:
            _ctcl = chunk_cluster_tile_cuts[sheet_idx]
            _draw_cluster_marks = (
                draw_segment_cut_marks
                if 'segments' in _ctcl
                else draw_tile_cut_marks
            )
            _draw_cluster_marks(
                out_page, _ctcl,
                mark_off=float(mark_off),
                mark_len=float(mark_len),
                mark_thickness=float(mark_thick),
                mark_style=mark_style,
                bleed_pt=float(bleed_pt),
            )

        # Create OCG layer on the main page if we are drawing marks directly on it
        main_ocg_xref = None
        sheet_num_label = f'_{sheet_idx + 1}' if global_total_sheets > 1 else ''
        sheet_suffix = f' #{sheet_idx + 1}' if global_total_sheets > 1 else ''
        if is_die_cut and not separate_cut_page:
            cut_page_parent = out_doc.add_ocg(f'cut_page{sheet_num_label}', on=True, add_to_order=False)
            
            cut_page_children = []

            # Graphtec SA info OCG
            if pont_config and pont_config.get('isGraphtec', False):
                layer_info = pont_config.get('layerInfoName', '')
                if layer_info:
                    try:
                        sa_ocg = out_doc.add_ocg(layer_info, on=True, add_to_order=False)
                        cut_page_children.append(sa_ocg)
                    except Exception:
                        pass

            die_cut_layer_name = f'Result_Cutline_Model_{sheet_idx + 1}'
            main_ocg_xref = out_doc.add_ocg(die_cut_layer_name, on=True, add_to_order=False)
            cut_page_children.append(main_ocg_xref)

            if pont_config:
                pont_parent_name = pont_config.get('layerName', 'Marks_Model_')
                boong_group_name = pont_config.get('groupName', 'MarkLine')
                boong_item_name = pont_config.get('itemName', 'MKLINE')
                
                pont_parent_ocg = out_doc.add_ocg(pont_parent_name, on=True, add_to_order=False)
                boong_group_ocg = out_doc.add_ocg(boong_group_name, on=True, add_to_order=False)
                
                cut_page_children.append(pont_parent_ocg)
                # Adding an array right after pont_parent_ocg makes its contents children of pont_parent_ocg
                cut_page_children.append(pikepdf.Array([boong_group_ocg]))
                
                _draw_ponts_on_page(out_page, placements, pont_config, sheet_w, sheet_h, margin_left, margin_bottom, ocg_xref=boong_group_ocg, item_name=boong_item_name)

            # Append the full tree to /Order
            try:
                d = out_doc._pdf.Root["/OCProperties"]["/D"]
                if "/Order" not in d:
                    d["/Order"] = pikepdf.Array()
                
                tree = [cut_page_parent]
                if cut_page_children:
                    tree.append(pikepdf.Array(cut_page_children))
                
                d["/Order"].extend(tree)
            except Exception:
                pass

        if (is_die_cut or page_sheet_mode) and pont_config and separate_cut_page:
            # If separate_cut_page is TRUE, we still MUST draw the marks on the printed artwork page!
            # But we draw them directly without an OCG layer, so they just print.
            _draw_ponts_on_page(out_page, placements, pont_config, sheet_w, sheet_h, margin_left, margin_bottom, ocg_xref=None)

        # Extract default die_color and die_width from first available cache for 1-dao
        global_die_color = (0, 1, 1, 0)  # Default to Red (CMYK, không dùng RGB)
        global_die_width = MIN_DIE_STROKE_WIDTH_PT

        for p in placements:
            idx = p.get('cell', {}).get('pageIdx', p.get('src_page_idx', 0))
            cache_key = f"{job_id}_{idx}"
            cached = _die_items_cache.get(cache_key)
            if cached:
                c = cached.get('color')
                if c:
                    is_invisible = False
                    if len(c) == 4: # CMYK
                        if (c[0] < 0.1 and c[1] < 0.1 and c[2] < 0.1 and c[3] < 0.1) or (c[3] > 0.9):
                            is_invisible = True
                    elif len(c) == 3: # RGB
                        if (c[0] < 0.1 and c[1] < 0.1 and c[2] < 0.1) or (c[0] > 0.9 and c[1] > 0.9 and c[2] > 0.9):
                            is_invisible = True
                    elif len(c) == 1: # Grayscale
                        if c[0] < 0.1 or c[0] > 0.9:
                            is_invisible = True
                    
                    if not is_invisible:
                        global_die_color = c
                        global_die_width = resolve_die_stroke_width(cached.get('width'))
                        break
                    else:
                        global_die_color = (0, 1, 1, 0) # Fallback to red (CMYK) if black/white
                        global_die_width = resolve_die_stroke_width(cached.get('width'))
                        break

        # 1 Dao cut lines (duong cat 1 Dao LETA)
        if cut_type == 'one_dao' and placements:
            from app.workers.sticker_imposer_pkg.one_dao_cut import (
                generate_one_dao_cut_segments, draw_one_dao_cuts
            )
            one_dao_placements = [
                {'abs_x': p['abs_x'], 'abs_y': p['original_cell_y'],
                 'width': p['width'], 'height': p['height']}
                for p in placements
            ]
            cut_segs = generate_one_dao_cut_segments(
                one_dao_placements, gap_x, gap_y, 2.835 # ONE_DAO_SAFETY_BLEED_PT (1mm)
            )
            if not separate_cut_page:
                draw_one_dao_cuts(out_page, cut_segs, color=global_die_color, stroke_width=global_die_width, oc=main_ocg_xref)

        # Redraw original die-cut lines on the main page inside the OCG layer
        if is_die_cut and cut_type != 'one_dao' and not separate_cut_page and placements:
            cut_shape_main = out_page.new_shape()
            for p_idx_d, p in enumerate(placements):
                cell = p['cell']
                src_page_idx_c = cell.get('pageIdx', p.get('src_page_idx', 0))
                if src_page_idx_c >= page_count:
                    continue
                
                cache_key = f"{job_id}_{src_page_idx_c}"
                cached = _die_items_cache.get(cache_key)
                if not cached:
                    continue

                die_items = cached['items']
                die_rect = cached['rect']
                die_color = cached.get('color')
                if not die_color:
                    die_color = (0, 1, 1, 0)  # CMYK đỏ (không RGB)
                else:
                    is_invisible = False
                    if len(die_color) == 4:
                        if (die_color[0] < 0.1 and die_color[1] < 0.1 and die_color[2] < 0.1 and die_color[3] < 0.1) or (die_color[3] > 0.9):
                            is_invisible = True
                    elif len(die_color) == 3:
                        if (die_color[0] < 0.1 and die_color[1] < 0.1 and die_color[2] < 0.1) or (die_color[0] > 0.9 and die_color[1] > 0.9 and die_color[2] > 0.9):
                            is_invisible = True
                    elif len(die_color) == 1:
                        if die_color[0] < 0.1 or die_color[0] > 0.9:
                            is_invisible = True
                            
                    if is_invisible:
                        die_color = (0, 1, 1, 0)
                die_width = resolve_die_stroke_width(cached.get('width'))

                abs_x = p['abs_x']
                abs_y = p['original_cell_y']
                is_rotated = cell.get('isRotated', False)
                is_rotated_180 = cell.get('isRotated180', False)

                for item in die_items:
                    cmd = item[0]

                    if cmd == 'l':
                        p1 = pdf_lib.Point(item[1])
                        p2 = pdf_lib.Point(item[2])
                        if is_rotated and is_rotated_180:
                            t1 = pdf_lib.Point(abs_x + (die_rect.y1 - p1.y), abs_y + p1.x - die_rect.x0)
                            t2 = pdf_lib.Point(abs_x + (die_rect.y1 - p2.y), abs_y + p2.x - die_rect.x0)
                        elif is_rotated_180:
                            t1 = pdf_lib.Point(abs_x + (die_rect.x1 - p1.x), abs_y + (die_rect.y1 - p1.y))
                            t2 = pdf_lib.Point(abs_x + (die_rect.x1 - p2.x), abs_y + (die_rect.y1 - p2.y))
                        elif is_rotated:
                            t1 = pdf_lib.Point(abs_x + (p1.y - die_rect.y0), abs_y + (die_rect.x1 - p1.x))
                            t2 = pdf_lib.Point(abs_x + (p2.y - die_rect.y0), abs_y + (die_rect.x1 - p2.x))
                        else:
                            t1 = pdf_lib.Point(abs_x + (p1.x - die_rect.x0), abs_y + (p1.y - die_rect.y0))
                            t2 = pdf_lib.Point(abs_x + (p2.x - die_rect.x0), abs_y + (p2.y - die_rect.y0))
                        cut_shape_main.draw_line(t1, t2)

                    elif cmd == 'c':
                        pts = [pdf_lib.Point(item[i]) for i in range(1, 5)]
                        transformed = []
                        for pt in pts:
                            if is_rotated and is_rotated_180:
                                transformed.append(pdf_lib.Point(abs_x + (die_rect.y1 - pt.y), abs_y + pt.x - die_rect.x0))
                            elif is_rotated_180:
                                transformed.append(pdf_lib.Point(abs_x + (die_rect.x1 - pt.x), abs_y + (die_rect.y1 - pt.y)))
                            elif is_rotated:
                                transformed.append(pdf_lib.Point(abs_x + (pt.y - die_rect.y0), abs_y + (die_rect.x1 - pt.x)))
                            else:
                                transformed.append(pdf_lib.Point(abs_x + (pt.x - die_rect.x0), abs_y + (pt.y - die_rect.y0)))
                        cut_shape_main.draw_bezier(transformed[0], transformed[1], transformed[2], transformed[3])

                    elif cmd == 're':
                        r = pdf_lib.Rect(item[1])
                        if is_rotated and is_rotated_180:
                            nr = pdf_lib.Rect(
                                abs_x + (die_rect.y1 - r.y1), abs_y + r.x0 - die_rect.x0,
                                abs_x + (die_rect.y1 - r.y0), abs_y + r.x1 - die_rect.x0
                            )
                        elif is_rotated_180:
                            nr = pdf_lib.Rect(
                                abs_x + (die_rect.x1 - r.x1), abs_y + (die_rect.y1 - r.y1),
                                abs_x + (die_rect.x1 - r.x0), abs_y + (die_rect.y1 - r.y0)
                            )
                        elif is_rotated:
                            nr = pdf_lib.Rect(
                                abs_x + (r.y0 - die_rect.y0), abs_y + (die_rect.x1 - r.x1),
                                abs_x + (r.y1 - die_rect.y0), abs_y + (die_rect.x1 - r.x0)
                            )
                        else:
                            nr = pdf_lib.Rect(
                                abs_x + (r.x0 - die_rect.x0), abs_y + (r.y0 - die_rect.y0),
                                abs_x + (r.x1 - die_rect.x0), abs_y + (r.y1 - die_rect.y0)
                            )
                        cut_shape_main.draw_rect(nr)

                    elif cmd == 'qu':
                        quad = item[1]
                        quad_pts = [pdf_lib.Point(quad.ul), pdf_lib.Point(quad.ur),
                                    pdf_lib.Point(quad.lr), pdf_lib.Point(quad.ll)]
                        transformed = []
                        for pt in quad_pts:
                            if is_rotated and is_rotated_180:
                                transformed.append(pdf_lib.Point(abs_x + (die_rect.y1 - pt.y), abs_y + pt.x - die_rect.x0))
                            elif is_rotated_180:
                                transformed.append(pdf_lib.Point(abs_x + (die_rect.x1 - pt.x), abs_y + (die_rect.y1 - pt.y)))
                            elif is_rotated:
                                transformed.append(pdf_lib.Point(abs_x + (pt.y - die_rect.y0), abs_y + (die_rect.x1 - pt.x)))
                            else:
                                transformed.append(pdf_lib.Point(abs_x + (pt.x - die_rect.x0), abs_y + (pt.y - die_rect.y0)))
                        for qi in range(4):
                            cut_shape_main.draw_line(transformed[qi], transformed[(qi + 1) % 4])

                cut_shape_main.finish(color=die_color, width=die_width, closePath=False, oc=main_ocg_xref)

            cut_shape_main.commit()

        # ═══ SEPARATE CUT PAGE ═══
        # After rendering the artwork page, generate a second page with only die-cut paths.
        # Multi-mold: 1 trang khuôn / tờ (GIỮ NGUYÊN).
        # Shared master (homogeneous mixed HOẶC single-mold Bình trang): mọi tờ dùng
        # CÙNG khuôn + CÙNG vị trí ô →
        # các trang khuôn giống hệt nhau. Tờ ĐẦU (sheet 0) luôn ĐẦY ĐỦ ô (nội dung rải
        # round-robin lấp tờ đầu trước); tờ cuối có thể thiếu ô. → CHỈ sinh trang khuôn
        # cho tờ 0, gắn marker /PSHomogCut để nup_engine chuyển xuống CUỐI file sau ghép
        # (kết quả: đúng 1 trang khuôn duy nhất, đầy đủ mọi ô, ở cuối file).
        _shared_master_cut = homogeneous_mode or (
            layout_type == 'repeat' and homogeneous_master_idx is not None
        )
        _emit_cut = (
            separate_cut_page
            and (is_die_cut or page_sheet_mode)
            and placements
        )
        if _emit_cut and _shared_master_cut and sheet_idx != 0:
            _emit_cut = False
        if _emit_cut:
            out_page_cut = out_doc.new_page(width=sheet_w, height=sheet_h)
            if _shared_master_cut:
                # Marker để nup_engine nhận diện + dời xuống cuối file (xoá marker sau đó).
                out_page_cut._page.obj['/PSHomogCut'] = True

            # --- Create parent group OCG: cut_page_N ---
            cut_num_label = f'_{sheet_idx + 1}' if global_total_sheets > 1 else ''
            cut_suffix = f' #{sheet_idx + 1}' if global_total_sheets > 1 else ''
            cut_page_parent = out_doc.add_ocg(f'cut_page{cut_num_label}', on=True, add_to_order=False)
            cut_child_ocgs = []

            # --- Graphtec SA info OCG (child, empty layer) ---
            layer_info = pont_config.get('layerInfoName', '') if pont_config else ''
            if layer_info and pont_config and pont_config.get('isGraphtec', False):
                try:
                    sa_ocg = out_doc.add_ocg(layer_info, on=True, add_to_order=False)
                    cut_child_ocgs.append(sa_ocg)
                except Exception:
                    pass

            # --- Result_Cutline_Model_ OCG (child, contains die-cut paths) ---
            die_cut_layer_name = f'Result_Cutline_Model_{sheet_idx + 1}'
            ocg_xref = out_doc.add_ocg(die_cut_layer_name, on=True, add_to_order=False)
            cut_child_ocgs.append(ocg_xref)

            cut_shape = out_page_cut.new_shape()

            # When cut_type is 'one_dao', skip original die-cut shapes — only draw 1 Dao lines below
            if cut_type != 'one_dao':
                # _die_items_cache was already populated in the earlier layout placement loop
                for p_idx_d, p in enumerate(placements):
                    cell = p['cell']
                    src_page_idx_c = cell.get('pageIdx', p.get('src_page_idx', 0))
                    if src_page_idx_c >= page_count:
                        continue
                    
                    cache_key = f"{job_id}_{src_page_idx_c}"
                    cached = _die_items_cache.get(cache_key)
                    if not cached:
                        continue

                    die_items = cached['items']
                    die_rect = cached['rect']
                    die_color = cached.get('color')
                    # Fallback to Red for invisible colors (black, white, near-black, near-white)
                    # Spot colors often get parsed as white (1,1,1) or black (0,0,0)
                    if not die_color:
                        die_color = (0, 1, 1, 0)
                    else:
                        is_invisible = False
                        if len(die_color) == 4: # CMYK
                            if (die_color[0] < 0.1 and die_color[1] < 0.1 and die_color[2] < 0.1 and die_color[3] < 0.1) or (die_color[3] > 0.9):
                                is_invisible = True
                        elif len(die_color) == 3: # RGB
                            if (die_color[0] < 0.1 and die_color[1] < 0.1 and die_color[2] < 0.1) or (die_color[0] > 0.9 and die_color[1] > 0.9 and die_color[2] > 0.9):
                                is_invisible = True
                        elif len(die_color) == 1: # Grayscale
                            if die_color[0] < 0.1 or die_color[0] > 0.9:
                                is_invisible = True
                                
                        if is_invisible:
                            die_color = (0, 1, 1, 0)  # Red (CMYK) for visibility
                    die_width = resolve_die_stroke_width(cached.get('width'))

                    # Calculate offset: where this placement's trim rect is on the output page
                    abs_x = p['abs_x']
                    abs_y = p['original_cell_y']
                    item_w = p.get('width', cell.get('width', 0))
                    item_h = p.get('height', cell.get('height', 0))

                    # The die_rect is relative to the source page. 
                    # We need to map it to the output page position.
                    is_rotated = cell.get('isRotated', False)
                    is_rotated_180 = cell.get('isRotated180', False)

                    if page_sheet_mode:
                        # The cell represents the page trim, not the union bbox
                        # of its sticker paths. Map cut geometry from the same
                        # effective source box used to clip the artwork.
                        source_rect = (
                            guillotine_source_clips.get(src_page_idx_c)
                            or src_doc[src_page_idx_c].rect
                        )
                        draw_die_lines_for_placement(
                            cut_shape,
                            die_items,
                            source_rect,
                            abs_x - bleed_pt,
                            abs_y - bleed_pt,
                            is_rotated=is_rotated,
                            is_rotated_180=is_rotated_180,
                        )
                        cut_shape.finish(
                            color=die_color,
                            width=die_width,
                            closePath=False,
                            oc=ocg_xref,
                        )
                        continue

                    for item in die_items:
                        cmd = item[0]  # 'l' (line), 'c' (curve), 're' (rect), 'qu' (quad)

                        if cmd == 'l':  # line: (cmd, p1, p2)
                            p1 = pdf_lib.Point(item[1])
                            p2 = pdf_lib.Point(item[2])
                            if is_rotated and is_rotated_180:
                                t1 = pdf_lib.Point(abs_x + (die_rect.y1 - p1.y), abs_y + p1.x - die_rect.x0)
                                t2 = pdf_lib.Point(abs_x + (die_rect.y1 - p2.y), abs_y + p2.x - die_rect.x0)
                            elif is_rotated_180:
                                t1 = pdf_lib.Point(abs_x + (die_rect.x1 - p1.x), abs_y + (die_rect.y1 - p1.y))
                                t2 = pdf_lib.Point(abs_x + (die_rect.x1 - p2.x), abs_y + (die_rect.y1 - p2.y))
                            elif is_rotated:
                                t1 = pdf_lib.Point(abs_x + (p1.y - die_rect.y0), abs_y + (die_rect.x1 - p1.x))
                                t2 = pdf_lib.Point(abs_x + (p2.y - die_rect.y0), abs_y + (die_rect.x1 - p2.x))
                            else:
                                t1 = pdf_lib.Point(abs_x + (p1.x - die_rect.x0), abs_y + (p1.y - die_rect.y0))
                                t2 = pdf_lib.Point(abs_x + (p2.x - die_rect.x0), abs_y + (p2.y - die_rect.y0))
                            cut_shape.draw_line(t1, t2)

                        elif cmd == 'c':  # cubic bezier: (cmd, p1, p2, p3, p4)
                            pts = [pdf_lib.Point(item[i]) for i in range(1, 5)]
                            transformed = []
                            for pt in pts:
                                if is_rotated and is_rotated_180:
                                    transformed.append(pdf_lib.Point(abs_x + (die_rect.y1 - pt.y), abs_y + pt.x - die_rect.x0))
                                elif is_rotated_180:
                                    transformed.append(pdf_lib.Point(abs_x + (die_rect.x1 - pt.x), abs_y + (die_rect.y1 - pt.y)))
                                elif is_rotated:
                                    transformed.append(pdf_lib.Point(abs_x + (pt.y - die_rect.y0), abs_y + (die_rect.x1 - pt.x)))
                                else:
                                    transformed.append(pdf_lib.Point(abs_x + (pt.x - die_rect.x0), abs_y + (pt.y - die_rect.y0)))
                            cut_shape.draw_bezier(transformed[0], transformed[1], transformed[2], transformed[3])

                        elif cmd == 're':  # rect: (cmd, rect)
                            r = pdf_lib.Rect(item[1])
                            if is_rotated and is_rotated_180:
                                nr = pdf_lib.Rect(
                                    abs_x + (die_rect.y1 - r.y1), abs_y + r.x0 - die_rect.x0,
                                    abs_x + (die_rect.y1 - r.y0), abs_y + r.x1 - die_rect.x0
                                )
                            elif is_rotated_180:
                                nr = pdf_lib.Rect(
                                    abs_x + (die_rect.x1 - r.x1), abs_y + (die_rect.y1 - r.y1),
                                    abs_x + (die_rect.x1 - r.x0), abs_y + (die_rect.y1 - r.y0)
                                )
                            elif is_rotated:
                                nr = pdf_lib.Rect(
                                    abs_x + (r.y0 - die_rect.y0), abs_y + (die_rect.x1 - r.x1),
                                    abs_x + (r.y1 - die_rect.y0), abs_y + (die_rect.x1 - r.x0)
                                )
                            else:
                                nr = pdf_lib.Rect(
                                    abs_x + (r.x0 - die_rect.x0), abs_y + (r.y0 - die_rect.y0),
                                    abs_x + (r.x1 - die_rect.x0), abs_y + (r.y1 - die_rect.y0)
                                )
                            cut_shape.draw_rect(nr)

                        elif cmd == 'qu':  # quad: (cmd, Quad(ul, ur, ll, lr))
                            quad = item[1]
                            # Quad has 4 points: upper_left, upper_right, lower_left, lower_right
                            quad_pts = [pdf_lib.Point(quad.ul), pdf_lib.Point(quad.ur),
                                        pdf_lib.Point(quad.lr), pdf_lib.Point(quad.ll)]
                            transformed = []
                            for pt in quad_pts:
                                if is_rotated and is_rotated_180:
                                    transformed.append(pdf_lib.Point(abs_x + (die_rect.y1 - pt.y), abs_y + pt.x - die_rect.x0))
                                elif is_rotated_180:
                                    transformed.append(pdf_lib.Point(abs_x + (die_rect.x1 - pt.x), abs_y + (die_rect.y1 - pt.y)))
                                elif is_rotated:
                                    transformed.append(pdf_lib.Point(abs_x + (pt.y - die_rect.y0), abs_y + (die_rect.x1 - pt.x)))
                                else:
                                    transformed.append(pdf_lib.Point(abs_x + (pt.x - die_rect.x0), abs_y + (pt.y - die_rect.y0)))
                            # Draw quad as closed polygon (4 edges)
                            for qi in range(4):
                                cut_shape.draw_line(transformed[qi], transformed[(qi + 1) % 4])

                    # Finish the complete die-cut path for this placement with stroke (no fill), assign to OCG layer
                    cut_shape.finish(color=die_color, width=die_width, closePath=False, oc=ocg_xref)

                cut_shape.commit()

            # 1 Dao on separate cut page: draw straight cut lines REPLACING the original die-cut paths
            if cut_type == 'one_dao' and placements:
                from app.workers.sticker_imposer_pkg.one_dao_cut import (
                    generate_one_dao_cut_segments, draw_one_dao_cuts
                )
                one_dao_placements_cut = [
                    {'abs_x': p['abs_x'], 'abs_y': p['original_cell_y'],
                     'width': p['width'], 'height': p['height']}
                    for p in placements
                ]
                cut_segs_cut = generate_one_dao_cut_segments(
                    one_dao_placements_cut, gap_x, gap_y, 2.835 # ONE_DAO_SAFETY_BLEED_PT (1mm)
                )
                
                draw_one_dao_cuts(out_page_cut, cut_segs_cut, color=global_die_color, stroke_width=global_die_width, oc=ocg_xref)

            # Draw pont marks on the cut page with SEPARATE OCG (child of Marks_Model_ group)
            if pont_config and ponts_on_cut_file:
                pont_parent_name = pont_config.get('layerName', 'Marks_Model_')
                boong_group_name = pont_config.get('groupName', 'MarkLine')
                boong_item_name = pont_config.get('itemName', 'MKLINE')
                
                pont_parent_ocg = out_doc.add_ocg(pont_parent_name, on=True, add_to_order=False)
                boong_group_ocg = out_doc.add_ocg(boong_group_name, on=True, add_to_order=False)
                
                cut_child_ocgs.append(pont_parent_ocg)
                # Adding an array right after pont_parent_ocg makes its contents children of pont_parent_ocg
                cut_child_ocgs.append(pikepdf.Array([boong_group_ocg]))
                
                _draw_ponts_on_page(out_page_cut, placements, pont_config, sheet_w, sheet_h, margin_left, margin_bottom, ocg_xref=boong_group_ocg, item_name=boong_item_name)

            # Append the full tree to /Order
            try:
                d = out_doc._pdf.Root["/OCProperties"]["/D"]
                if "/Order" not in d:
                    d["/Order"] = pikepdf.Array()
                
                tree = [cut_page_parent]
                if cut_child_ocgs:
                    tree.append(pikepdf.Array(cut_child_ocgs))
                
                d["/Order"].extend(tree)
            except Exception:
                pass


        # Progress tracking

        if prog_file and sheet_idx % 5 == 0:

            completed = min((sheet_idx + 1) * total_capacity, total_page_count)

            try:

                with open(prog_file, 'w') as f:

                    f.write(f"{completed}/{total_page_count}")

            except OSError: pass

    chunk_path = os.path.join(
        tempfile.gettempdir(),
        f"prynx_nup_{job_id}_{chunk_idx}_{os.getpid()}.pdf",
    )
    try:
        out_doc.save(chunk_path, garbage=0, deflate=True)
        return chunk_path
    except Exception:
        try:
            os.remove(chunk_path)
        except OSError:
            pass
        raise
    finally:
        out_doc.close()
        if geometry_doc is not None:
            geometry_doc.close()
        src_doc.close()
