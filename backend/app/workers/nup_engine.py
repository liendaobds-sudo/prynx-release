"""

High-Performance N-Up Imposition Engine (pikepdf).

Replaces the JavaScript pdf-lib based N-Up renderer for large files (>1000 pages).

pikepdf uses C++/QPDF under the hood → 10-50x faster than pdf-lib for bulk page operations.

Architecture:

  Frontend (TypeScript) computes the grid layout (NupGridSolver) and sends a lightweight

  JSON "plan" to this engine. This engine then executes the plan using pikepdf,

  placing source pages onto output sheets at the computed coordinates.

"""

import os

import io

from app.workers import pdf_wrapper as pdf_lib

import tempfile

import uuid

import math

from typing import List, Dict, Any, Optional

from app.workers.cluster_tile_engine import run_cluster_tile, draw_tile_cut_marks
import logging

MM_TO_PTS = 2.83465

logger = logging.getLogger(__name__)

# Layout solver functions extracted to nup_layout_solver.py for modularity & testability

from app.workers.nup_layout_solver import solve_grid, solve_optimal_layout, get_src_page_idx, solve_manual


# Extracted modules
from app.workers.nup_diecut import (
    _path_items_to_polygon,
    extract_page_die_cut_polygon,
    get_optimal_head_to_tail_overlap,
    _find_largest_die_path,
)
from app.workers.nup_marks import _draw_ponts_on_page
from app.workers.nup_sticker import compute_sticker_layout_for_page

from app.workers.nup_process_chunk import process_chunk


def run_nup_engine(

    source_path: str,

    output_path: str,

    settings: Dict[str, Any],

    job_id: str = None,

    progress_callback=None,

) -> str:

    from concurrent.futures import ProcessPoolExecutor

    import math

    import pypdfium2 as pdfium

    # ── Định tuyến công cụ Bình Bế Rớt (CNC): renderer riêng, không đụng luồng repeat ──
    if settings.get('imposerMode') == 'cnc':
        from app.workers.cnc_render import run_cnc_two_sided
        return run_cnc_two_sided(source_path, output_path, settings, job_id, progress_callback)

    src_doc = pdf_lib.open(source_path)

    page_count = src_doc.page_count

    if page_count == 0:

        raise ValueError("Source PDF has no pages")

    first_page = src_doc[0]

    geom_rect = None

    if settings.get('isDieCutMode', False):

        paths = first_page.extract_vector_paths()

        if paths:

            valid_paths = [p for p in paths if p['rect'].width > 5 and p['rect'].height > 5]

            if valid_paths:

                filtered = [p for p in valid_paths if abs(p['rect'].width - first_page.rect.width) > 2 or abs(p['rect'].height - first_page.rect.height) > 2]

                if not filtered: filtered = valid_paths

                stroke_paths = [p for p in filtered if p.get('type') == 's' or (p.get('fill') is None and p.get('color') is not None)]

                target_paths = stroke_paths if stroke_paths else filtered

                largest_path = max(target_paths, key=lambda p: p['rect'].width * p['rect'].height)

                r = largest_path['rect']

                geom_rect = (r.x0, r.y0, r.x1, r.y1)

    # Dùng MediaBox (page.rect) = đúng kích thước file (gồm bleed). trim = page - 2*bleed(UI).
    src_w = first_page.rect.width

    src_h = first_page.rect.height

    MM_TO_PTS = 2.83465

    strategy = settings.get('gridStrategy', 'simple_auto')

    is_die_cut = settings.get('isDieCutMode', False)

    # Shape override from frontend dropdown

    detected_shapes_by_page = settings.get('detectedShapesByPage', {})

    detected_shape_params_by_page = settings.get('detectedShapeParamsByPage', {})

    frontend_shape = detected_shapes_by_page.get("0") or detected_shapes_by_page.get(0)

    frontend_shape_props = detected_shape_params_by_page.get("0") or detected_shape_params_by_page.get(0) or {}

    # Variables needed later for process_chunk (kept for backward compat)

    shape_type = "CUSTOM"

    shape_props = {}

    base_poly = None

    p5_params = p6_params = p5_row_params = p6_row_params = p5_col_params = p6_col_params = None

    src_doc.close()

    bleed_mm = settings.get('bleed', 0)

    bleed_pt = bleed_mm * MM_TO_PTS

    if geom_rect:

        trim_w = geom_rect[2] - geom_rect[0]

        trim_h = geom_rect[3] - geom_rect[1]

    else:

        trim_w = src_w - 2 * bleed_pt

        trim_h = src_h - 2 * bleed_pt

    sheet_w = settings.get('sheetWidth', 320) * MM_TO_PTS

    sheet_h = settings.get('sheetHeight', 450) * MM_TO_PTS

    gap_x = settings.get('gapX', 0) * MM_TO_PTS

    gap_y = settings.get('gapY', 0) * MM_TO_PTS

    margin_top = settings.get('marginTop', 0) * MM_TO_PTS

    margin_bottom = settings.get('marginBottom', 0) * MM_TO_PTS

    margin_left = settings.get('marginLeft', 0) * MM_TO_PTS

    margin_right = settings.get('marginRight', 0) * MM_TO_PTS

    mark_type = settings.get('markType', 'none')

    mark_len = settings.get('markLength', 5.0) * MM_TO_PTS

    mark_off = settings.get('markOffset', 3.0) * MM_TO_PTS

    # Độ dày nét dấu xén (mm → pts). Mặc định 0.25mm khớp DEFAULT_MARKS_CONFIG ở frontend.
    mark_thick = settings.get('markThickness', 0.25) * MM_TO_PTS

    # Kiểu dấu xén: 'default' (nét đơn) | 'japanese' (nét đôi trim+bleed / トンボ)
    mark_style = settings.get('markStyle', 'default')

    if settings.get('marginMode') == 'include_marks' and mark_type != 'none':

        mark_space = mark_len + mark_off

        margin_top += mark_space

        margin_bottom += mark_space

        margin_left += mark_space

        margin_right += mark_space

    usable_w = sheet_w - margin_left - margin_right

    usable_h = sheet_h - margin_top - margin_bottom

    sheet_usable_w = usable_w

    sheet_usable_h = usable_h

    # --- CLUSTERING LOGIC ---

    cluster_mode = settings.get('clusterMode', 'none')

    cluster_count = max(2, settings.get('clusterCount', 2))

    cluster_gap = settings.get('clusterGap', 0) * MM_TO_PTS

    cx_count = 1

    cy_count = 1

    # Khởi tạo mặc định: nhánh zone/auto-fill (bế tem dàn nhiều mẫu) không gán
    # secondary_gap nhưng args tuple vẫn dùng → tránh UnboundLocalError.
    secondary_gap = None

    if cluster_mode == 'column' and cluster_count >= 2:

        usable_w = (usable_w - cluster_gap * (cluster_count - 1)) / cluster_count

        cx_count = cluster_count

    elif cluster_mode == 'row' and cluster_count >= 2:

        usable_h = (usable_h - cluster_gap * (cluster_count - 1)) / cluster_count

        cy_count = cluster_count

    strategy = settings.get('gridStrategy', 'simple_auto')

    grouping_strategy = settings.get('groupingStrategy', 'maximize_area')
    logger.info("   ZONE-DEBUG grouping_strategy=%r" % grouping_strategy)
    cluster_tile_w_mm = settings.get('clusterTileW', 148.0)   # mm, default A5 width
    cluster_tile_h_mm = settings.get('clusterTileH', 210.0)   # mm, default A5 height

    layout_type = settings.get('layoutType', 'sequential')

    is_die_cut = settings.get('isDieCutMode', False)

    precalculated_placements = None
    cluster_tile_cuts = {}

    # Report state (spec: binh-tem-be-report) — luôn tồn tại để khối finalize đọc được.
    _reports_by_sheet = {}
    _report_rows = []

    target_quantity = settings.get('targetQuantity', 0)


    target_quantities_by_page = settings.get('targetQuantitiesByPage', {})

    # Check if all targets are 0 (Auto-Fill 1 Sheet mode)

    is_auto_fill = (target_quantity == 0 and not any(v > 0 for v in target_quantities_by_page.values()))

    if is_die_cut:

        logger.info(f"\n🚀 [NUP_ENGINE] Running ZONE-BASED N-UP with INTERLOCKING per type")

        logger.info(f"   target_quantity={target_quantity}, is_auto_fill={is_auto_fill}")

        logger.info(f"   target_quantities_by_page={target_quantities_by_page}")

        # ── Step 1: Build per-page info ──

        tmp_doc = pdf_lib.open(source_path)

        page_infos = []  # [(p_idx, qty, trim_w, trim_h), ...]

        for p_idx in range(page_count):

            p_str = str(p_idx)

            if p_str in target_quantities_by_page:

                qty = target_quantities_by_page[p_str]

            elif p_idx in target_quantities_by_page:

                qty = target_quantities_by_page[p_idx]

            else:

                qty = target_quantity

            if qty <= 0:

                qty = 1

            src_page = tmp_doc[p_idx]

            largest_path = _find_largest_die_path(src_page)

            if largest_path:

                r = largest_path['rect']

                cur_trim_w = r.width

                cur_trim_h = r.height

            else:

                if abs(src_page.trimbox.width - src_page.rect.width) > 1.0:

                    cur_trim_w = src_page.trimbox.width

                    cur_trim_h = src_page.trimbox.height

                else:

                    cur_trim_w = src_page.rect.width

                    cur_trim_h = src_page.rect.height

                cur_trim_w -= 2 * bleed_pt

                cur_trim_h -= 2 * bleed_pt

            page_infos.append((p_idx, qty, cur_trim_w, cur_trim_h))

            logger.info(f"   [ZONE] Page {p_idx}: qty={qty} trim={cur_trim_w:.1f}x{cur_trim_h:.1f}")

        # Sort page_infos by size ONLY when mixing multiple types on same sheet
        # (e.g. maximize_area, strict_ratio, cluster_tile).
        # For 'none' grouping or 'repeat' layout, preserve original page order.
        if grouping_strategy != 'none' and layout_type != 'repeat':
            page_infos.sort(key=lambda x: min(x[2], x[3]), reverse=True)

        # ── Step 2: Calculate strip heights ──

        # maximize_area → chia đều diện tích: mỗi loại được usable_h / số_loại

        # strict_ratio  → chia đều số lượng: mỗi loại được không gian tỉ lệ với qty của nó

        n_types = len(page_infos)

        total_qty_all = sum(qty for _, qty, _, _ in page_infos)

        total_weighted = sum(qty * h for _, qty, _, h in page_infos)

        strip_allocations = []

        remaining_h = usable_h

        for p_idx, qty, tw, th in page_infos:

            if grouping_strategy == 'maximize_area':

                # Chia đều diện tích: mỗi loại được đúng 1/N tổng chiều cao

                alloc_h = usable_h / n_types

            else:

                # strict_ratio — chia đều số lượng:

                # Tỉ lệ = qty_loại / tổng_qty → loại nhiều hơn được nhiều không gian hơn

                # (số_hàng_cần × chiều_cao_tem ≈ qty / items_per_row × th)

                # Công thức đơn giản: weight thuần theo qty

                weight = qty / total_qty_all if total_qty_all > 0 else 1.0 / n_types

                alloc_h = usable_h * weight

            # Đảm bảo ít nhất 1 hàng tem vừa vào strip

            alloc_h = max(alloc_h, th + gap_y)

            # Không vượt quá không gian còn lại

            alloc_h = min(alloc_h, remaining_h)

            strip_allocations.append((p_idx, qty, tw, th, alloc_h))

            remaining_h -= alloc_h

            logger.info(f"   [ZONE] Page {p_idx}: alloc_h={alloc_h:.1f}pt "

                  f"(item_h={th:.1f}, qty={qty}, strategy={grouping_strategy})")

        # ── Step 3: Compute FULL-SHEET layout per type, then slice items ──

        # Key insight: compute interlocking at full sheet height (for correct pattern),

        # then take only the needed qty. Y-offset stacks types vertically.

        # First: pre-compute full-sheet layout for each type (once)

        full_layouts = {}  # p_idx -> layout_result

        # Reuse tmp_doc from Step 1 (still open)

        for p_idx, qty, tw, th in page_infos:

            page_obj = tmp_doc[p_idx]

            p_shape = None

            if detected_shapes_by_page:

                p_shape = (detected_shapes_by_page.get(str(p_idx)) 

                          or detected_shapes_by_page.get(p_idx))

            p_shape_props = {}

            if detected_shape_params_by_page:

                p_shape_props = (detected_shape_params_by_page.get(str(p_idx)) 

                                or detected_shape_params_by_page.get(p_idx) or {})

            try:
                w_for_nfp = usable_w
                h_for_nfp = usable_h
                if grouping_strategy == 'cluster_tile' and settings.get('clusterNesting', True):
                    cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                    MM = 2.83465
                    tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                    tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
                    if cluster_sizing_mode == 'grid':
                        cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                        cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                        w_for_nfp = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                        h_for_nfp = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                    else:
                        w_for_nfp = float(settings.get('clusterTileW', 148.0)) * MM
                        h_for_nfp = float(settings.get('clusterTileH', 210.0)) * MM

                # Compute secondary_gap from fillBlockGap for 1-Dao mode
                fill_block_gap_mm = settings.get('fillBlockGap', 0)
                cut_type = settings.get('cutType', 'default')
                if cut_type == 'one_dao' and fill_block_gap_mm > 0:
                    _secondary_gap = fill_block_gap_mm * MM_TO_PTS
                else:
                    _secondary_gap = None

                logger.error(f"   [ZONE DEBUG] w_for_nfp={w_for_nfp} h_for_nfp={h_for_nfp} gap_x={gap_x} gap_y={gap_y} bleed_pt={bleed_pt} secondary_gap={_secondary_gap}")
                layout_result = compute_sticker_layout_for_page(
                    page_obj,
                    w_for_nfp,
                    h_for_nfp,
                    gap_x, gap_y,

                    strategy='optimal_auto',

                    shape_type_override=p_shape if p_shape else None,

                    shape_props_override=p_shape_props if p_shape_props else None,

                    bleed_pt=bleed_pt,

                    secondary_gap=_secondary_gap,

                )

                full_layouts[p_idx] = layout_result

                capacity = len(layout_result.get('items', []))

                logger.info(f"   [ZONE] Page {p_idx}: full-sheet layout -> {capacity} items "

                      f"(strategy={layout_result.get('strategyUsed','?')})")

            except Exception as e:

                logger.info(f"   [ZONE] Layout engine failed for page {p_idx}: {e}")

                full_layouts[p_idx] = None

        tmp_doc.close()  # Close after both Step 1 and Step 3 are done

        # Step 3b: Calculate proportional items-per-sheet for each type

        # Based on full-sheet capacity and requested quantities

        total_qty = sum(qty for _, qty, _, _ in page_infos)

        # Calculate how many items of each type fit on a full sheet

        items_per_sheet_type = {}

        for p_idx, qty, tw, th in page_infos:

            fl = full_layouts.get(p_idx)

            if fl and fl.get('items'):

                items_per_sheet_type[p_idx] = len(fl['items'])

            else:

                # Grid fallback capacity

                cols = max(1, int(usable_w / (tw + gap_x)))

                rows = max(1, int(usable_h / (th + gap_y)))

                items_per_sheet_type[p_idx] = cols * rows

        if layout_type != 'repeat':
            if is_auto_fill:
                sum_inv_c = sum(1.0 / items_per_sheet_type[p_idx] for p_idx, _, _, _ in page_infos)
                N = max(1, int(1.0 / sum_inv_c)) if sum_inv_c > 0 else 1
                logger.info(f"   [ZONE] AUTO-FILL MODE: Calculated N={N} items per type to fill 1 sheet")
                page_infos = [(p_idx, N, tw, th) for p_idx, _, tw, th in page_infos]
                remaining_by_page = {p_idx: N for p_idx, _, _, _ in page_infos}
            else:
                remaining_by_page = {p_idx: qty for p_idx, qty, _, _ in page_infos}

        precalculated_placements = {}
        cluster_tile_cuts = {}  # sheet_idx -> tile_cut_lines for cluster_tile mode

        total_items_placed = 0

        # Track how many items from the full layout we have already placed

        items_used_by_page = {p_idx: 0 for p_idx, _, _, _ in page_infos}

        # y_offset and placed_on_sheet are mutable state used by _place_items_from_layout

        y_offset = 0.0

        placed_on_sheet = 0

        # Helper: place up to qty_limit items from a layout into the sheet at current y_offset

        def _place_items_from_layout(fl, p_idx, tw, th, max_h, qty_limit):

            nonlocal y_offset, placed_on_sheet

            if not fl or not fl.get('items'):

                return 0

            if 'items_sorted' not in fl:

                fl['items_sorted'] = sorted(fl['items'], key=lambda x: (x.get('y', 0), x.get('x', 0)))

            full_items = fl['items_sorted']

            start_idx = items_used_by_page.get(p_idx, 0) % len(full_items)

            available_items = full_items[start_idx:]

            if not available_items and full_items:

                items_used_by_page[p_idx] = 0

                start_idx = 0

                available_items = full_items

            if not available_items:

                return 0

            items_to_use = []

            min_y = available_items[0].get('y', 0)

            for it in available_items:

                rel_y = it.get('y', 0) - min_y

                bottom = rel_y + it.get('height', th)

                if bottom > max_h + 0.5:

                    break

                items_to_use.append(it)

                if len(items_to_use) >= qty_limit:

                    break

            if not items_to_use:

                return 0

            max_item_bottom_rel = max(it.get('y', 0) - min_y + it.get('height', th) for it in items_to_use)

            block_min_x = min(it.get('x', 0) for it in items_to_use)

            block_max_x = max(it.get('x', 0) + it.get('width', tw) for it in items_to_use)

            block_w = block_max_x - block_min_x

            x_shift = (usable_w - block_w) / 2 - block_min_x

            for item in items_to_use:

                item_x = item.get('x', 0) + x_shift

                item_w = item.get('width', tw)

                item_h = item.get('height', th)

                is_rotated = item.get('isRotated', False)

                is_rotated_180 = item.get('isRotated180', False)

                rel_y = item.get('y', 0) - min_y

                # Use raw relative Y so PDF matches preview vertically
                adjusted_y = rel_y + y_offset

                cell = {

                    'x': item_x,

                    'y': adjusted_y,

                    'width': item_w,

                    'height': item_h,

                    'isRotated': is_rotated,

                    'isRotated180': is_rotated_180,

                }

                precalculated_placements[sheet_idx].append({

                    'cluster_idx': 0,

                    'cell': cell,

                    'src_page_idx': p_idx,

                    'abs_x': 0,  # placeholder, set after centering

                    'abs_y': 0,

                    'width': item_w,

                    'height': item_h,

                    'original_cell_y': 0,

                })

                placed_on_sheet += 1

            items_used_by_page[p_idx] = start_idx + len(items_to_use)

            y_offset += max_item_bottom_rel + gap_y

            return len(items_to_use)

        def _finalize_sheet_centering(s_idx):

            """Apply centering offsets to all placements on a sheet."""

            if s_idx not in precalculated_placements or not precalculated_placements[s_idx]:

                return

            # Compute content bounds

            all_bottoms = [p['cell']['y'] + p['cell']['height'] for p in precalculated_placements[s_idx]]

            total_content_h_s = max(all_bottoms) if all_bottoms else 0.0


            max_x_used_s = 0.0

            for p in precalculated_placements[s_idx]:

                right = p['cell']['x'] + p['cell']['width']

                if right > max_x_used_s:

                    max_x_used_s = right

            x_off = margin_left + (usable_w - max_x_used_s) / 2 if max_x_used_s < usable_w else margin_left

            y_off = margin_bottom + (usable_h - total_content_h_s) / 2 if total_content_h_s < usable_h else margin_bottom

            for p in precalculated_placements[s_idx]:
                cell = p['cell']
                p['abs_x'] = x_off + cell['x']
                p['abs_y'] = y_off + (total_content_h_s - cell['y'] - cell['height'])
                p['original_cell_y'] = usable_h + margin_bottom + margin_top - p['abs_y'] - cell['height']

        if layout_type == 'repeat':
            logger.info(f"   [ZONE] STICKER IMPOSER -> processing pages independently without mixing")
            sheet_idx = 0

            # ── REPORT & XUẤT TỜ DUY NHẤT (spec: binh-tem-be-report) ──
            from app.workers import nup_report as _nr
            _report_cfg = settings.get('reportDisplay') or {}
            _report_enabled = bool(_report_cfg.get('enabled'))
            _export_unique = settings.get('exportUniqueSheets', True)
            _rep_material = settings.get('reportMaterial', '')
            _rep_lam = settings.get('reportLamination', 0)
            _rep_lam_sides = settings.get('reportLaminationSides', 1)
            _rep_order = settings.get('reportOrderCode', '')
            _rep_paper = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
            _PT_MM = 1.0 / MM_TO_PTS

            def _make_type_report(p_idx, tw, th, items_per_sheet, qty):
                """Tính + build chuỗi report cho 1 loại tem (1 tờ duy nhất)."""
                label = _report_cfg.get('labelNameText') or f"Trang {p_idx + 1}"
                data = _nr.compute_report_data(
                    label_name=label,
                    width_mm=tw * _PT_MM, height_mm=th * _PT_MM,
                    paper_size=_rep_paper,
                    items_per_sheet=items_per_sheet, requested_qty=qty,
                    material=_rep_material,
                    lamination_type=_rep_lam, lamination_sides=_rep_lam_sides,
                    mode_label='Bế tem', order_code=_rep_order,
                    identifier=str(p_idx + 1),
                )
                _report_rows.append({
                    'label': label, 'items_per_sheet': items_per_sheet,
                    'requested_qty': qty, 'sheet_count': data['raw']['sheet_count'],
                })
                return _nr.build_report_string(_report_cfg, data)

            for p_idx, qty, tw, th in page_infos:
                fl = full_layouts.get(p_idx)
                if not fl or not fl.get('items'):
                    continue
                
                if grouping_strategy == 'cluster_tile' and settings.get('clusterNesting', True):
                    MM = 2.83465
                    cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                    tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                    tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
                    cluster_nesting = settings.get('clusterNesting', True)

                    if cluster_sizing_mode in ('grid', 'split_cols', 'split_rows'):
                        if cluster_sizing_mode == 'split_cols':
                            cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                            cluster_rows = 1
                        elif cluster_sizing_mode == 'split_rows':
                            cluster_cols = 1
                            cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                        else:
                            cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                            cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                            
                        cw_pt = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                        ch_pt = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                    else:
                        cw_pt = float(settings.get('clusterTileW', 148.0)) * MM
                        ch_pt = float(settings.get('clusterTileH', 210.0)) * MM

                    ct_placements, tile_cut_lines = run_cluster_tile(
                        page_infos=[(p_idx, 1, tw, th)],
                        full_layouts=full_layouts,
                        sheet_w=usable_w,
                        sheet_h=usable_h,
                        cluster_w=cw_pt,
                        cluster_h=ch_pt,
                        gap_x=gap_x,
                        gap_y=gap_y,
                        tile_gap_x=tile_gap_x_pt,
                        tile_gap_y=tile_gap_y_pt,
                        cluster_nesting=cluster_nesting,
                        is_die_cut=is_die_cut,
                        doc=tmp_doc if is_die_cut else None,
                        shape_type=fl.get('shapeType', 'CUSTOM') if is_die_cut else 'CUSTOM',
                        shape_props=fl.get('shapeProps', {}) if is_die_cut else {},
                        strategy=strategy
                    )
                    
                    if ct_placements:
                        items_per_sheet = len(ct_placements)
                        sheets_needed = math.ceil(qty / items_per_sheet) if items_per_sheet > 0 else 1
                        repeat_count = 1 if _export_unique else sheets_needed
                        _type_report_str = _make_type_report(p_idx, tw, th, items_per_sheet, qty) if _report_enabled else None

                        ct_offset_x = margin_left
                        ct_offset_y = sheet_h - margin_bottom - sheet_usable_h
                        
                        for _ in range(repeat_count):
                            precalculated_placements[sheet_idx] = []
                            for p_item in ct_placements:
                                ox = p_item['abs_x'] + ct_offset_x
                                oy = p_item['abs_y'] + ct_offset_y
                                shifted = dict(p_item)
                                shifted['abs_x'] = ox
                                shifted['abs_y'] = usable_h + margin_bottom + margin_top - oy - p_item['height']
                                shifted['original_cell_y'] = oy
                                shifted['cell'] = dict(p_item['cell'])
                                shifted['cell']['x'] = ox
                                shifted['cell']['y'] = oy
                                precalculated_placements[sheet_idx].append(shifted)
                            
                            if tile_cut_lines:
                                tile_cut_lines_shifted = {'v': set(), 'h': set()}
                                for v in tile_cut_lines.get('v', []):
                                    tile_cut_lines_shifted['v'].add(v + ct_offset_x)
                                for h in tile_cut_lines.get('h', []):
                                    tile_cut_lines_shifted['h'].add(h + ct_offset_y)
                                cluster_tile_cuts[sheet_idx] = tile_cut_lines_shifted
                                
                            if _type_report_str:
                                _reports_by_sheet[sheet_idx] = _type_report_str
                            sheet_idx += 1
                        continue

                items_per_sheet = len(fl['items'])
                sheets_needed = math.ceil(qty / items_per_sheet) if items_per_sheet > 0 else 1
                repeat_count = 1 if _export_unique else sheets_needed
                _type_report_str = _make_type_report(p_idx, tw, th, items_per_sheet, qty) if _report_enabled else None

                all_bottoms = [it.get('y', 0) + it.get('height', th) for it in fl['items']]
                total_content_h = max(all_bottoms) if all_bottoms else 0.0
                max_x_used = max([it.get('x', 0) + it.get('width', tw) for it in fl['items']], default=0.0)
                
                x_off = margin_left + (usable_w - max_x_used) / 2 if max_x_used < usable_w else margin_left
                y_off = margin_bottom + (usable_h - total_content_h) / 2 if total_content_h < usable_h else margin_bottom
                
                for _ in range(repeat_count):
                    precalculated_placements[sheet_idx] = []
                    for item in fl['items']:
                        rx = item.get('x', 0)
                        ry = item.get('y', 0)
                        iw = item.get('width', tw)
                        ih = item.get('height', th)
                        abs_x = x_off + rx
                        abs_y = y_off + ry
                        precalculated_placements[sheet_idx].append({
                            'cluster_idx': 0,
                            'cell': {'x': rx, 'y': ry, 'width': iw, 'height': ih, 
                                     'isRotated': item.get('isRotated', False), 
                                     'isRotated180': item.get('isRotated180', False)},
                            'src_page_idx': p_idx,
                            'abs_x': abs_x, 'abs_y': y_off + (total_content_h - ry - ih),
                            'width': iw, 'height': ih,
                            'original_cell_y': usable_h + margin_bottom + margin_top - (y_off + (total_content_h - ry - ih)) - ih,
                        })
                    if _type_report_str:
                        _reports_by_sheet[sheet_idx] = _type_report_str
                    sheet_idx += 1
            total_items_placed = sum(len(p) for p in precalculated_placements.values())

        elif is_auto_fill:
            # ── AUTO-FILL: Pack all types onto 1 sheet using MaxRects bin-packing ──
            from app.workers.sticker_imposer_pkg.bin_packing import solve_auto_fill_mixed

            if grouping_strategy == 'cluster_tile':
                # -- CLUSTER TILE (gom cum nho roi nhan ban len to lon) --
                MM = 2.83465
                cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
                cluster_nesting = settings.get('clusterNesting', True)

                if cluster_sizing_mode == 'grid':
                    cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                    cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                    cw_pt = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                    ch_pt = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                else:
                    cw_pt = float(settings.get('clusterTileW', 148.0)) * MM
                    ch_pt = float(settings.get('clusterTileH', 210.0)) * MM

                ct_placements, tile_cut_lines = run_cluster_tile(
                    page_infos=page_infos,
                    full_layouts=full_layouts,
                    sheet_w=usable_w,
                    sheet_h=usable_h,
                    cluster_w=cw_pt,
                    cluster_h=ch_pt,
                    gap_x=gap_x,
                    gap_y=gap_y,
                    tile_gap_x=tile_gap_x_pt,
                    tile_gap_y=tile_gap_y_pt,
                    cluster_nesting=cluster_nesting,
                    is_die_cut=is_die_cut,
                    doc=tmp_doc if is_die_cut else None,
                    shape_type=full_layouts[page_infos[0][0]].get('shapeType', 'CUSTOM') if is_die_cut and full_layouts else 'CUSTOM',
                    shape_props=full_layouts[page_infos[0][0]].get('shapeProps', {}) if is_die_cut and full_layouts else {},
                    strategy=strategy
                )
                ct_offset_x = margin_left
                ct_offset_y = sheet_h - margin_bottom - sheet_usable_h

                sheet_idx = 0
                precalculated_placements[sheet_idx] = []
                placed_on_sheet = 0
                for p_item in ct_placements:
                    ox = p_item['abs_x'] + ct_offset_x
                    oy = p_item['abs_y'] + ct_offset_y
                    shifted = dict(p_item)
                    shifted['abs_x'] = ox
                    shifted['abs_y'] = usable_h + margin_bottom + margin_top - oy - p_item['height']
                    shifted['original_cell_y'] = oy
                    shifted['cell'] = dict(p_item['cell'])
                    shifted['cell']['x'] = ox
                    shifted['cell']['y'] = oy
                    precalculated_placements[sheet_idx].append(shifted)
                    placed_on_sheet += 1

                if tile_cut_lines:
                    v_shifted = {round(x + ct_offset_x, 2) for x in tile_cut_lines.get('v', set())}
                    h_shifted = {round(y + ct_offset_y, 2) for y in tile_cut_lines.get('h', set())}
                    cluster_tile_cuts[sheet_idx] = {'v': v_shifted, 'h': h_shifted}

                logger.info(f'   [ZONE] CLUSTER_TILE DONE: {placed_on_sheet} items')

            else:
                # ── MaxRects BIN-PACKING: all types compete freely for space ──
                
                # Pre-compute forbidden zones from pont/ốc marks
                engine_exclude_zones = []
                pont_cfg = settings.get('pontConfig') if settings.get('pontType', 'none') != 'none' else None
                if pont_cfg and not pont_cfg.get('disableCollision', False):
                    try:
                        from app.workers.pont_collision import calculate_forbidden_zones, MM_TO_PTS as PC_MM
                        pc_margins = {
                            'top': pont_cfg.get('marginTop') * PC_MM if pont_cfg.get('marginTop') is not None else margin_top,
                            'bottom': pont_cfg.get('marginBottom') * PC_MM if pont_cfg.get('marginBottom') is not None else margin_bottom,
                            'left': pont_cfg.get('marginLeft') * PC_MM if pont_cfg.get('marginLeft') is not None else margin_left,
                            'right': pont_cfg.get('marginRight') * PC_MM if pont_cfg.get('marginRight') is not None else margin_right,
                        }
                        pc_zones = calculate_forbidden_zones(pont_cfg, pc_margins, sheet_w, sheet_h)
                        if pc_zones:
                            for z in pc_zones:
                                zminx, zminy, zmaxx, zmaxy = z.bounds
                                zw = zmaxx - zminx
                                zh = zmaxy - zminy
                                px = zminx - margin_left
                                py = usable_h - (zminy - margin_bottom + zh)
                                gap_buf = max(gap_x, gap_y) / 2
                                px -= gap_buf; py -= gap_buf
                                zw += gap_buf * 2; zh += gap_buf * 2
                                engine_exclude_zones.append((px, py, zw, zh))
                            logger.info(f"   [ZONE] BIN-PACK: {len(engine_exclude_zones)} exclude zones from pont/oc")
                    except Exception as e:
                        logger.warning(f"   [ZONE] BIN-PACK: pont zone calc failed: {e}")
                        engine_exclude_zones = []
                
                page_dims = [(p_idx, tw, th) for p_idx, _, tw, th in page_infos]
                bp_result = solve_auto_fill_mixed(
                    sheet_w=usable_w,
                    sheet_h=usable_h,
                    page_dims=page_dims,
                    gap=max(gap_x, gap_y),
                    allow_rotation=True,
                    exclude_zones=engine_exclude_zones if engine_exclude_zones else None,
                )

                sheet_idx = 0
                precalculated_placements[sheet_idx] = []
                placed_on_sheet = 0

                for p in bp_result['placements']:
                    rx = p['x']
                    ry = p['y']
                    iw = p['w']
                    ih = p['h']
                    p_idx = p['page_idx']
                    is_rot = p['is_rotated']

                    precalculated_placements[sheet_idx].append({
                        'cluster_idx': 0,
                        'cell': {
                            'x': rx, 'y': ry, 'width': iw, 'height': ih,
                            'isRotated': is_rot, 'isRotated180': False,
                        },
                        'src_page_idx': p_idx,
                        'abs_x': 0,  # set by _finalize_sheet_centering
                        'abs_y': 0,
                        'width': iw,
                        'height': ih,
                        'original_cell_y': 0,
                    })
                    placed_on_sheet += 1

                _finalize_sheet_centering(sheet_idx)
                logger.info(f"   [ZONE] BIN-PACK AUTO-FILL DONE: {placed_on_sheet} items on 1 sheet")

            total_items_placed = placed_on_sheet

        else:

            # ── MULTI-SHEET with quantities: MaxRects bin-packing per sheet ──
            from app.workers.sticker_imposer_pkg.bin_packing import solve_offset_mixed

            page_dims_qty = [(p_idx, tw, th, remaining_by_page[p_idx])
                             for p_idx, _, tw, th in page_infos
                             if remaining_by_page.get(p_idx, 0) > 0]

            bp_result = solve_offset_mixed(
                sheet_w=usable_w,
                sheet_h=usable_h,
                page_dims_qty=page_dims_qty,
                gap=max(gap_x, gap_y),
                allow_rotation=True,
            )

            # bp_result gives us the layout for ONE sheet + sheets_needed count
            one_sheet_placements = bp_result['placements']
            sheets_needed = bp_result.get('sheets_needed', 1)

            for sheet_idx in range(sheets_needed):
                precalculated_placements[sheet_idx] = []
                for p in one_sheet_placements:
                    rx = p['x']
                    ry = p['y']
                    iw = p['w']
                    ih = p['h']
                    p_idx = p['page_idx']
                    is_rot = p['is_rotated']

                    precalculated_placements[sheet_idx].append({
                        'cluster_idx': 0,
                        'cell': {
                            'x': rx, 'y': ry, 'width': iw, 'height': ih,
                            'isRotated': is_rot, 'isRotated180': False,
                        },
                        'src_page_idx': p_idx,
                        'abs_x': 0,
                        'abs_y': 0,
                        'width': iw,
                        'height': ih,
                        'original_cell_y': 0,
                    })

                _finalize_sheet_centering(sheet_idx)

            total_items_placed = len(one_sheet_placements) * sheets_needed
            logger.info(f"   [ZONE] BIN-PACK OFFSET DONE: {len(one_sheet_placements)} items/sheet × {sheets_needed} sheets = {total_items_placed} total")

        layout = {

            'totalItems': total_items_placed,

            'overallWidth': usable_w,

            'overallHeight': usable_h,

            'cells': [],

            'strategyUsed': 'Zone-Based N-Up with Interlocking'

        }

        capacity = 1

        total_items_needed = sum(qty for _, qty, _, _ in page_infos)

        logger.info(f"   [ZONE] DONE: {total_items_placed}/{total_items_needed} items on 1 sheet")

        layout = {

            'totalItems': total_items_placed,

            'overallWidth': usable_w,

            'overallHeight': usable_h,

            'cells': [],

            'strategyUsed': 'Zone-Based N-Up with Interlocking'

        }

        capacity = 1


    else:

        # Use fillBlockGap (KC cụm phụ) as secondary_gap between main & fill blocks
        # when 1 Dao mode is active; otherwise dùng splitGap do frontend tính (đã gồm
        # khoảng chừa mark cắt) để output KHỚP preview; cuối cùng mới fallback cluster_gap.
        fill_block_gap_mm = settings.get('fillBlockGap', 0)
        cut_type = settings.get('cutType', 'default')
        split_gap_mm = settings.get('splitGap', None)
        if cut_type == 'one_dao' and fill_block_gap_mm > 0:
            secondary_gap = fill_block_gap_mm * MM_TO_PTS
        elif split_gap_mm is not None and split_gap_mm > 0:
            # split_gap_mm: cùng giá trị (mm) preview gửi tới /preview-layout → preview==output
            secondary_gap = split_gap_mm * MM_TO_PTS
        else:
            secondary_gap = cluster_gap if cluster_gap > 0 else None

        # Req 4.3: gridStrategy 'manual' → dùng đúng cols/rows người dùng nhập.
        cols_manual = int(settings.get('cols', 0) or 0)
        rows_manual = int(settings.get('rows', 0) or 0)
        if strategy == 'manual' and cols_manual > 0 and rows_manual > 0:
            layout = solve_manual(trim_w, trim_h, gap_x, gap_y, cols_manual, rows_manual)
        else:
            layout = solve_optimal_layout(usable_w, usable_h, trim_w, trim_h, gap_x, gap_y, strategy, secondary_gap)

    capacity = layout['totalItems']

    total_capacity = capacity * cx_count * cy_count

    if total_capacity < 1:

        raise ValueError(f"Sheet too small for source pages. Cannot fit any items.")

    sheet_mapping = []

    if precalculated_placements is not None:

        total_sheets = max(precalculated_placements.keys()) + 1 if precalculated_placements else 1

    elif layout_type == 'repeat':

        for p in range(page_count):

            str_p = str(p)

            if str_p in target_quantities_by_page:

                qty = target_quantities_by_page[str_p]

            elif p in target_quantities_by_page:

                qty = target_quantities_by_page[p]

            else:

                qty = target_quantity

            if qty > 0:

                sheets = math.ceil(qty / total_capacity)

            else:

                sheets = 1

            sheet_mapping.extend([p] * sheets)

        total_sheets = len(sheet_mapping)

    else:

        if target_quantity > 0:

            total_sheets = math.ceil(target_quantity / total_capacity)

        else:

            total_sheets = math.ceil(page_count / total_capacity)

    align = settings.get('align', 'center')

    active_grid_w = layout['overallWidth']

    active_grid_h = layout['overallHeight']

    super_grid_w = cx_count * active_grid_w + max(0, cx_count - 1) * cluster_gap

    super_grid_h = cy_count * active_grid_h + max(0, cy_count - 1) * cluster_gap

    cells = layout['cells']

    prog_file = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt") if job_id else None

    available_cores = max(1, os.cpu_count() - 1)

    # Adaptive chunk sizing: distribute work evenly across cores

    # For small jobs: ensure at least 2 chunks if possible to utilize multiprocessing

    # For large jobs: cap at 5 sheets/chunk to avoid O(N^2) XObject resource deduplication freeze
    if total_sheets <= available_cores:
        CHUNK_SIZE = 1  # 1 sheet per core for very small jobs
    else:
        CHUNK_SIZE = min(5, max(1, math.ceil(total_sheets / available_cores)))

    args_list = []

    chunk_idx = 0

    for start_sheet in range(0, total_sheets, CHUNK_SIZE):

        end_sheet = min(start_sheet + CHUNK_SIZE, total_sheets)

        args = (

            source_path, job_id, chunk_idx, start_sheet, end_sheet, 

            sheet_w, sheet_h, capacity, cells, bleed_pt, gap_x, gap_y, 

            mark_type, mark_len, mark_off, margin_left, margin_bottom, 

            sheet_usable_w, sheet_usable_h, align, cx_count, cy_count, cluster_gap,

            active_grid_w, active_grid_h, super_grid_w, super_grid_h,

            prog_file, page_count, layout_type, is_die_cut,

            settings.get('pontConfig') if settings.get('pontType', 'none') != 'none' else None,

            strategy, detected_shapes_by_page, target_quantity, detected_shape_params_by_page, sheet_mapping,

            {s: precalculated_placements.get(s, []) for s in range(start_sheet, end_sheet)} if precalculated_placements is not None else None,

            settings.get('cutType', 'default'),  # G3: one_dao support

            grouping_strategy,  # cluster_tile: cascade grouping strategy

            {s: cluster_tile_cuts[s] for s in range(start_sheet, end_sheet) if s in cluster_tile_cuts},  # cluster_tile cut lines

            settings.get('separateCutPage', False),  # separate cut page flag

            settings.get('pontsOnCutFile', True),  # draw ponts on cut page

            float(settings.get('fillBlockGap', 0)),  # fillBlockGap in mm for secondary_gap

            total_sheets,  # global total sheets count for unique OCG naming

            secondary_gap,  # KC cụm phụ (pt) — phải dùng lại khi re-solve trong process_chunk (preview==output)

            mark_thick,  # Độ dày nét dấu xén (pt) — luồn từ markThickness của frontend

            mark_style,  # Kiểu dấu xén: 'default' | 'japanese' (nét đôi)

        )

        args_list.append(args)

        chunk_idx += 1

    chunk_bytes = []

    if len(args_list) > 0:

        if len(args_list) == 1:

            # Sequential for small jobs

            for args in args_list:

                chunk_bytes.append(process_chunk(args))

        else:

            # Parallel processing across multiple CPU cores

            num_workers = min(len(args_list), available_cores)

            with ProcessPoolExecutor(max_workers=num_workers) as pool:

                chunk_bytes = list(pool.map(process_chunk, args_list))

    # Mốc tiến trình finalize (để chẩn đoán nếu kẹt ở bước nào)
    def _stage(msg):
        if prog_file:
            try:
                with open(prog_file, 'w', encoding='utf-8') as f:
                    f.write(msg)
            except OSError:
                pass

    _stage("Đang gộp các tờ in...")

    # --- FAST ASSEMBLY ---

    if len(chunk_bytes) == 1:
        # Optimization: no merge needed, preserves all layers perfectly
        with open(output_path, 'wb') as f:
            f.write(chunk_bytes[0])
    elif is_die_cut:
        # PDFium import_pages strips Document Catalog /OCProperties (layers).
        # We must use pikepdf to merge chunks to preserve layers.
        # This is slightly slower but die-cut jobs rarely exceed 100 pages.
        import pikepdf
        import io
        final_doc = pikepdf.Pdf.open(io.BytesIO(chunk_bytes[0]))
        for cb in chunk_bytes[1:]:
            src_pdf = pikepdf.Pdf.open(io.BytesIO(cb))
            
            # Merge OCGs and /Order structure from source chunk into final document
            src_oc_props = src_pdf.Root.get("/OCProperties")
            if src_oc_props:
                final_oc_props = final_doc.Root.get("/OCProperties")
                if final_oc_props:
                    # Import all OCGs from source into /OCGs and /ON
                    ocg_remap = {}  # src objgen -> final ocg ref (for remapping /Order)
                    chunk_ocg_map = {} # name -> final ocg ref (for remapping Properties of pages in this chunk)
                    for src_ocg in src_oc_props.get("/OCGs", []):
                        try:
                            new_ocg = final_doc.copy_foreign(src_ocg)
                            final_oc_props["/OCGs"].append(new_ocg)
                            d = final_oc_props.get("/D", {})
                            if "/ON" in d:
                                d["/ON"].append(new_ocg)
                            if hasattr(src_ocg, 'objgen'):
                                ocg_remap[src_ocg.objgen] = new_ocg
                            name = str(src_ocg.get("/Name", ""))
                            if name:
                                chunk_ocg_map[name] = new_ocg
                        except Exception:
                            pass
                    
                    # Copy /Order items (preserving nested groups)
                    src_d = src_oc_props.get("/D", {})
                    src_order = src_d.get("/Order", [])
                    final_d = final_oc_props.get("/D", {})
                    if "/Order" in final_d and src_order:
                        def _copy_order_item(item):
                            if isinstance(item, pikepdf.Array):
                                return pikepdf.Array([_copy_order_item(sub) for sub in item])
                            elif hasattr(item, 'objgen') and item.objgen in ocg_remap:
                                return ocg_remap[item.objgen]
                            else:
                                return final_doc.copy_foreign(item)
                        
                        for item in src_order:
                            try:
                                final_d["/Order"].append(_copy_order_item(item))
                            except Exception:
                                pass
            
            start_idx = len(final_doc.pages)
            final_doc.pages.extend(src_pdf.pages)
            
            # Remap orphaned OCGs for the newly appended pages using chunk_ocg_map
            if src_oc_props:
                for page in final_doc.pages[start_idx:]:
                    try:
                        if "/Resources" in page and "/Properties" in page.Resources:
                            props = page.Resources["/Properties"]
                            for key in list(props.keys()):
                                val = props[key]
                                if isinstance(val, pikepdf.Dictionary) and val.get("/Type") == "/OCG":
                                    name = str(val.get("/Name", ""))
                                    if name in chunk_ocg_map:
                                        props[key] = chunk_ocg_map[name]
                    except Exception:
                        pass
                        
            src_pdf.close()
            
        final_doc.save(output_path)
        final_doc.close()
    else:
        # Merge chunks using C++ PDFium (avoids O(N^2) resource deduplication freeze for huge jobs)
        final_doc = pdfium.PdfDocument.new()
        for cb in chunk_bytes:
            src_pdf = pdfium.PdfDocument(cb)
            final_doc.import_pages(src_pdf)
            src_pdf.close()
        final_doc.save(output_path)
        final_doc.close()

    # ══════════════════════════════════════════════════════════════
    # SECURITY: Stealth watermark — hashed license trace in XMP + invisible text
    # ══════════════════════════════════════════════════════════════
    _wm_license = settings.get('_license_key', '') or settings.get('watermarkKey', '')
    _wm_hwid = settings.get('_hwid', '')
    if _wm_license:
        _stage("Đang đóng dấu bản quyền...")
        try:
            import pikepdf
            from app.core.watermark import embed_watermark
            with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as pdf:
                embed_watermark(pdf, _wm_license, _wm_hwid)
                pdf.save(output_path)
        except Exception as e:
            logger.error(f"Failed to write watermark: {e}")

    if prog_file:

        try:

            with open(prog_file, 'w') as f:

                f.write(f"{page_count}/{page_count}")

        except OSError: pass

    # ── Stamp report lên từng tờ + bảng tổng hợp (spec: binh-tem-be-report) ──
    if _reports_by_sheet:
        _stage("Đang ghi report lên tờ...")
        try:
            from app.workers import nup_report as _nr
            _rd = settings.get('reportDisplay') or {}
            _nr.stamp_reports_on_pdf(
                output_path, output_path, _reports_by_sheet,
                position=_rd.get('position', 'top'),
                offset_x_mm=float(_rd.get('offsetX', 5.0)),
                offset_y_mm=float(_rd.get('offsetY', 5.0)),
                font_size=float(_rd.get('fontSize', 8.0)),
                centered=bool(_rd.get('centered', True)),
            )
        except Exception as e:
            logger.warning(f"[REPORT] stamp lỗi: {e}")

    if progress_callback:

        progress_callback(page_count, page_count, "Hoàn tất")

    out_sheets = len(args_list) if args_list else 0

    report_lines = [f"✅ Hoàn tất! Xuất thành công file kẽm."]

    # Bảng tổng hợp lệnh in (spec: binh-tem-be-report, Yêu cầu 5)
    if _report_rows:
        _total_sheets = sum(r['sheet_count'] for r in _report_rows)
        report_lines.append("")
        report_lines.append("📋 LỆNH IN (tổng hợp):")
        for r in _report_rows:
            report_lines.append(
                f"  • {r['label']}: {r['requested_qty']} tem — SL/tờ {r['items_per_sheet']} → in {r['sheet_count']} tờ"
            )
        report_lines.append(f"  ⇒ Tổng số tờ cần in: {_total_sheets}")


    if is_die_cut and 'strategyUsed' in layout:

        strategy_used = layout['strategyUsed']

        s_map = {

            'dumbbell_illustrator': 'Khuôn tạ (Đầu đuôi xen kẽ)',

            'hammer_illustrator': 'Khuôn búa (Chữ T xen kẽ)',

            'grid': 'Lưới đơn giản',

            'staggered': 'So le (Tổ ong)',

            'head_to_tail': 'Đầu đuôi (Ghép ngàm)',

            'l_shape': 'Ghép L-Shape',

            'row_alt': 'Xoay xen kẽ dòng',

            'col_alt': 'Xoay xen kẽ cột',

            'pentagon_advanced': 'Ghép Ngũ Giác (Đầu đuôi ngàm)',

        }

        vn_strategy = strategy_used

        for k, v in s_map.items():

            if k in strategy_used:

                vn_strategy = strategy_used.replace(k, v)

                break

        if strategy == 'optimal_auto':

            report_lines.append(f"🤖 Máy tính đã tự động tối ưu và chọn kiểu: {vn_strategy}")

        else:

            report_lines.append(f"Chiến lược dàn: {vn_strategy}")

        report_lines.append(f"Hiệu suất: {total_capacity} tem / tấm kẽm.")

    return "\n".join(report_lines)
