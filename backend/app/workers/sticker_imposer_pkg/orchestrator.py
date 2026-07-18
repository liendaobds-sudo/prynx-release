"""Sticker Imposer — Main orchestrator that selects optimal layout strategy."""
import math
import logging
from typing import List, Dict, Any

from .utils import calculate_items_bounding_box
from .collision import resolve_layout_collisions
from .grid_layouts import (
    solve_grid_layout,
    calculate_staggered_hex_layout,
    calculate_staggered_vertical_layout,
    calculate_hex_tiling_row_stagger,
    calculate_hex_tiling_col_stagger,
)
from .cluster_layouts import (
    solve_cluster_grid_layout,
    solve_row_alternating_layout,
    solve_col_alternating_layout,
    _best_fill_layout,
)
from .shape_layouts import (
    solve_pointy_top_hex_layout,
    solve_flat_top_hex_layout,
    solve_advanced_pentagon_layout,
    solve_advanced_triangle_layout,
    solve_illustrator_trapezoid_layout,
    solve_illustrator_parallelogram_layout,
    solve_advanced_trapezoid_layout,
    solve_l_shape_layout,
)
from .asymmetric_layouts import (
    solve_dumbbell_pair_col_layout,
    solve_dumbbell_pair_row_layout,
    evaluate_unified_asymmetric,
    solve_illustrator_hammer_layout,
    solve_illustrator_dumbbell_layout,
)

logger = logging.getLogger(__name__)

def _solve_optimal_sticker_layout_impl(usable_w: float, usable_h: float, item_w: float, item_h: float, gap_x: float, gap_y: float, strategy: str = 'grid', p5_params: Dict[str, float] = None, p6_params: Dict[str, float] = None, p5_row_params: Dict = None, p6_row_params: Dict = None, p5_col_params: Dict = None, p6_col_params: Dict = None, shape_type: str = 'CUSTOM', shape_props: Dict[str, Any] = None, base_poly: Any = None, secondary_gap: float = None) -> Dict[str, Any]:
    """Determine best layout for stickers"""
    
    if strategy == 'optimal_auto':
        # --- SHAPE-SPECIFIC OVERRIDES (100% Illustrator Logic Port) ---
        if shape_type in ('HAMMER', 'DUMBBELL'):
            p_hammer = solve_illustrator_hammer_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)
            p_dumbbell = solve_illustrator_dumbbell_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)
            
            # Grid an toàn (không bao giờ đè)
            p_grid1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            p_grid2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)
            
            configs = [
                (p_hammer, p_hammer.get('_main_rotated', False), 'hammer_illustrator'),
                (p_dumbbell, p_dumbbell.get('_main_rotated', False), 'dumbbell_illustrator'),
                (p_grid1, False, 'grid'),
                (p_grid2, True, 'grid'),
            ]
            
            # Head-to-tail với NFP params (lồng ghép chính xác, đã tính bằng binary search)
            if p5_params and p5_params.get('dx_outer', 0) > 0:
                p5 = solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_params, False)
                configs.append((p5, False, 'head_to_tail'))
            if p6_params and p6_params.get('dx_outer', 0) > 0:
                p6 = solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_params, True)
                configs.append((p6, True, 'head_to_tail'))
            
            # Row/Col alternating nếu có params
            if p5_row_params:
                p8 = solve_row_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_row_params, False)
                configs.append((p8, False, 'row_alt'))
            if p6_row_params:
                p9 = solve_row_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_row_params, True)
                configs.append((p9, True, 'row_alt'))
            if p5_col_params:
                p10 = solve_col_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_col_params, False)
                configs.append((p10, False, 'col_alt'))
            if p6_col_params:
                p11 = solve_col_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_col_params, True)
                configs.append((p11, True, 'col_alt'))
            
            # === COLLISION VALIDATION trên TẤT CẢ candidates ===
            # Skip hex_tiling/staggered — these use deterministic geometric formulas
            # (0.75*item_w/h steps) that guarantee non-overlap by design.
            # Running collision resolver with actual rounded-corner polygons
            # causes false positives that incorrectly remove valid items.
            SKIP_COLLISION_STRATEGIES = {'hex_tiling', 'staggered', 'staggered_hex_tiling', 'triangle_advanced', 'pentagon_advanced'}
            if base_poly is not None:
                for cfg, rot, strat in configs:
                    if strat in SKIP_COLLISION_STRATEGIES:
                        continue
                    original_n = cfg['totalItems']
                    cfg['items'] = resolve_layout_collisions(cfg['items'], base_poly, max(gap_x, gap_y))
                    cfg['totalItems'] = len(cfg['items'])
                    if cfg['items']:
                        cfg['widthUsed'] = max(it['x'] + it['width'] for it in cfg['items'])
                        cfg['heightUsed'] = max(it['y'] + it['height'] for it in cfg['items'])
                    else:
                        cfg['widthUsed'] = 0
                        cfg['heightUsed'] = 0
                    if cfg['totalItems'] < original_n:
                        logger.debug(f"[COLLISION_PRE_SORT] {strat} rot={rot}: {original_n} → {cfg['totalItems']} items (loại {original_n - cfg['totalItems']})")

        elif shape_type == 'TRIANGLE':
            t1 = solve_advanced_triangle_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, False)
            t2 = solve_advanced_triangle_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, True)
            candidates = [
                (t1, False, 'triangle_advanced'),
                (t2, True, 'triangle_advanced')
            ]
            candidates.sort(key=lambda x: (x[0]['totalItems'], -x[0]['widthUsed']*x[0]['heightUsed']), reverse=True)
            configs = [candidates[0]]
        elif shape_type == 'TRAPEZOID':
            tr_opt = solve_illustrator_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)
            configs = [(tr_opt, tr_opt.get('_main_rotated', False), 'trapezoid_illustrator')]
        elif shape_type == 'PARALLELOGRAM':
            pr_opt = solve_illustrator_parallelogram_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props)
            configs = [(pr_opt, pr_opt.get('_main_rotated', False), 'parallelogram_illustrator')]
        elif shape_type in ('PENTAGON', 'ARROW'):
            # Try all 4 combinations for pentagon
            p_up1 = solve_advanced_pentagon_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, False, False)
            p_up2 = solve_advanced_pentagon_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, False, True)
            p_rot1 = solve_advanced_pentagon_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, True, False)
            p_rot2 = solve_advanced_pentagon_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, True, True)
            
            candidates = [
                (p_up1, False, 'pentagon_advanced'),
                (p_up2, False, 'pentagon_advanced'),
                (p_rot1, True, 'pentagon_advanced'),
                (p_rot2, True, 'pentagon_advanced')
            ]
            candidates.sort(key=lambda x: (x[0]['totalItems'], -x[0]['widthUsed']*x[0]['heightUsed']), reverse=True)
            configs = [candidates[0]]
            # MŨI TÊN (hướng B — tối ưu năng suất + không đè):
            # Hình mũi tên (tip + ngạnh lõm + cán) KHÁC ngũ giác (mái nhà) → công thức
            # lồng ngũ giác KHÔNG đảm bảo không đè; mũi tên BẤT ĐỐI XỨNG bị đè (đo thật ~4%).
            #  (1) Đổi nhãn 'pentagon_advanced'→'arrow_advanced' (KHÔNG nằm trong SKIP) để
            #      khử đè polygon thật được chạy.
            #  (2) KHỬ ĐÈ TRƯỚC SORT cho ứng viên lồng (như nhánh búa/tạ) → so sánh CÔNG BẰNG
            #      theo số ô SAU khử đè.
            #  (3) THÊM ứng viên LƯỚI (không bao giờ đè): với mũi tên bất đối xứng, lưới
            #      cho năng suất CAO HƠN lồng-rồi-bỏ-ô; với đối xứng, lồng vẫn có thể thắng
            #      (xếp dày hơn). Bộ chọn tự lấy phương án nhiều ô nhất.
            if shape_type == 'ARROW':
                _arrow_best = candidates[0][0]
                _arrow_best['strategyUsed'] = 'arrow_advanced'
                if base_poly is not None and _arrow_best.get('items'):
                    _arrow_best['items'] = resolve_layout_collisions(
                        _arrow_best['items'], base_poly, max(gap_x, gap_y))
                    _arrow_best['totalItems'] = len(_arrow_best['items'])
                    if _arrow_best['items']:
                        _arrow_best['widthUsed'] = max(it['x'] + it['width'] for it in _arrow_best['items'])
                        _arrow_best['heightUsed'] = max(it['y'] + it['height'] for it in _arrow_best['items'])
                    else:
                        _arrow_best['widthUsed'] = _arrow_best['heightUsed'] = 0
                _ag1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
                _ag2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)
                configs = [
                    (_arrow_best, candidates[0][1], 'arrow_advanced'),
                    (_ag1, False, 'grid'),
                    (_ag2, True, 'grid'),
                ]
        elif shape_type == 'HEXAGON':
            # Use proper hexagonal tiling (3/4 ratio) instead of circle-nesting (sqrt(3)/2)
            # to prevent bounding box overlap that causes visual item overlap
            h1 = calculate_hex_tiling_row_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            h2 = calculate_hex_tiling_row_stagger(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
            h3 = calculate_hex_tiling_col_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            h4 = calculate_hex_tiling_col_stagger(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
            
            hex_orientation = (shape_props or {}).get('hexOrientation', 'pointy-top')
            if hex_orientation == 'pointy-top':
                candidates = [
                    (h1, False, 'hex_tiling'),
                    (h4, True, 'hex_tiling')
                ]
            else:
                candidates = [
                    (h3, False, 'hex_tiling'),
                    (h2, True, 'hex_tiling')
                ]
                
            candidates.sort(key=lambda x: (x[0]['totalItems'], -x[0]['widthUsed']*x[0]['heightUsed']), reverse=True)
            configs = [candidates[0]]

        elif shape_type == 'CIRCLE_ELLIPSE':
            p1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            p2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)
            p3 = calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            p4 = calculate_staggered_hex_layout(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
            
            candidates = [
                (p1, False, 'grid'),
                (p2, True, 'grid'),
                (p3, False, 'staggered'),
                (p4, True, 'staggered'),
            ]
            candidates.sort(key=lambda x: (x[0]['totalItems'], -x[0]['widthUsed']*x[0]['heightUsed']), reverse=True)
            configs = [candidates[0]]

        elif shape_type == 'RECTANGLE':
            # Chữ nhật / 1 Dao LETA: chỉ lưới + L-shape (fill block). KHÔNG head_to_tail
            # / hex (trước rơi nhánh generic → preview 1 Dao xếp/vẽ sai).
            p1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            p2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)
            p7 = solve_l_shape_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, secondary_gap)
            configs = [
                (p1, False, 'grid'),
                (p2, True, 'grid'),
                (p7, False, 'l_shape'),
            ]
            
        else:
            # Generic shapes: compete all strategies
            p1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            p2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)
            p7 = solve_l_shape_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, secondary_gap)
            
            configs = [
                (p1, False, 'grid'),
                (p2, True, 'grid'),
                (p7, False, 'l_shape'),
            ]
            
            # If user explicitly chooses CUSTOM, they want strict straight grids (no flipping/alternating)
            if shape_type != 'CUSTOM':
                p5 = solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_params, False)
                p6 = solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_params, True)
                p8 = solve_row_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_row_params, False)
                p9 = solve_row_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_row_params, True)
                p10 = solve_col_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_col_params, False)
                p11 = solve_col_alternating_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_col_params, True)
                
                configs.extend([
                    (p5, False, 'head_to_tail'),
                    (p6, True, 'head_to_tail'),
                    (p8, False, 'row_alt'),
                    (p9, True, 'row_alt'),
                    (p10, False, 'col_alt'),
                    (p11, True, 'col_alt'),
                ])
        
# Give a slight bonus to head_to_tail if total items are the same
        def sort_key(x):
            strategy = x[2]
            is_rotated = x[1]
            items = x[0]['totalItems']
            area = x[0]['widthUsed'] * x[0]['heightUsed']
            
            # Bonus factor: favor grid for ties so we don't unnecessarily flip items upside down
            bonus = 0
            if shape_type in ('HAMMER', 'DUMBBELL') and strategy in ('hammer_illustrator', 'dumbbell_illustrator'):
                bonus = 0.2
            elif strategy == 'grid':
                bonus = 0.1
            elif strategy == 'head_to_tail':
                if is_rotated and p6_params:
                    eff_w = p6_params.get('dx_outer', 0) / 2
                    base_w = item_h + gap_x
                    if eff_w > 0 and eff_w < base_w * 0.98:
                        bonus = ((base_w - eff_w) / base_w) * 0.05
                elif not is_rotated and p5_params:
                    eff_w = p5_params.get('dx_outer', 0) / 2
                    base_w = item_w + gap_x
                    if eff_w > 0 and eff_w < base_w * 0.98:
                        bonus = ((base_w - eff_w) / base_w) * 0.05
            elif strategy in ('staggered', 'hex_tiling', 'row_alt', 'col_alt'):
                bonus = 0.05
                
            score = (items, bonus, -area)
            x[0]['_debug_score'] = score
            return score


        configs.sort(key=sort_key, reverse=True)
        best_config, is_rotated, best_strategy = configs[0]
        
        # Debug: log all strategies and their item counts
        import logging
        _logger = logging.getLogger(__name__)
        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug("========== LAYOUT SELECTION (Shape: %s) ==========", shape_type)
            for cfg, rot, strat in configs:
                score = cfg.get('_debug_score', (0, 0, 0))
                msg = "[LAYOUT_CANDIDATES] %20s rot=%-5s items=%3d | score_items=%s bonus=%.4f area=%.1f" % (strat, rot, cfg['totalItems'], score[0], score[1], -score[2])
                _logger.debug(msg)

        winner_msg = "[LAYOUT_WINNER] >>> %s (rot=%s) items=%d shape=%s" % (best_strategy, is_rotated, best_config['totalItems'], shape_type)
        _logger.debug(winner_msg)
        
        if is_rotated and best_strategy not in ('head_to_tail', 'l_shape', 'hammer_illustrator', 'dumbbell_illustrator', 'trapezoid_illustrator'):
            for item in best_config['items']:
                item['isRotated'] = True
        
        # TRAPEZOID/PARALLELOGRAM: interlock strategies can still benefit from L-shape filler
        if shape_type in ('TRAPEZOID', 'PARALLELOGRAM'):
            pass # Continue to L-shape fill
            
        # --- POST-PROCESSING: L-shape fill on remaining space ---
        # After selecting best single-block strategy, fill remaining right/bottom
        # space with additional items. This runs BEFORE centering (which happens at render time).
        best_w = best_config['widthUsed']
        best_h = best_config['heightUsed']
        split_gap = secondary_gap if secondary_gap is not None else max(gap_x, gap_y, 14.17)  # secondary_gap from fillBlockGap, or default ~5mm
        
        best_extra = 0
        best_extra_items = []
        
        # Try fill items using ALL strategies (grid + staggered + head-to-tail)
        right_x = best_w + split_gap
        right_avail_w = usable_w - right_x
        bottom_y = best_h + split_gap
        bottom_avail_h = usable_h - bottom_y

        # Config A: right fill spans full usable height, bottom fill spans only main block width
        right_items_a = []
        _logger.debug(f"[FILL_DEBUG] right_avail_w={right_avail_w:.1f} bottom_avail_h={bottom_avail_h:.1f} min_dim={min(item_w, item_h):.1f}")
        if right_avail_w >= min(item_w, item_h) - 0.01:
            fr = _best_fill_layout(item_w, item_h, right_avail_w, usable_h, gap_x, gap_y, p5_params, p6_params, p5_row_params, p6_row_params, p5_col_params, p6_col_params, shape_type, shape_props)
            _logger.debug(f"[FILL_DEBUG] right_items_a generated: {fr['totalItems']} items, rot={fr.get('items', [{}])[0].get('isRotated') if fr['items'] else None}")
            for it in fr['items']:
                right_items_a.append({**it, 'x': it['x'] + right_x})
        bottom_items_a = []
        if bottom_avail_h >= min(item_w, item_h) - 0.01:
            fb = _best_fill_layout(item_w, item_h, best_w, bottom_avail_h, gap_x, gap_y, p5_params, p6_params, p5_row_params, p6_row_params, p5_col_params, p6_col_params, shape_type, shape_props)
            for it in fb['items']:
                bottom_items_a.append({**it, 'y': it['y'] + bottom_y})
        config_a = right_items_a + bottom_items_a

        # Config B: bottom fill spans full usable width, right fill spans only main block height
        bottom_items_b = []
        if bottom_avail_h >= min(item_w, item_h) - 0.01:
            fb = _best_fill_layout(item_w, item_h, usable_w, bottom_avail_h, gap_x, gap_y, p5_params, p6_params, p5_row_params, p6_row_params, p5_col_params, p6_col_params, shape_type, shape_props)
            for it in fb['items']:
                bottom_items_b.append({**it, 'y': it['y'] + bottom_y})
        right_items_b = []
        if right_avail_w >= min(item_w, item_h) - 0.01:
            fr = _best_fill_layout(item_w, item_h, right_avail_w, best_h, gap_x, gap_y, p5_params, p6_params, p5_row_params, p6_row_params, p5_col_params, p6_col_params, shape_type, shape_props)
            for it in fr['items']:
                right_items_b.append({**it, 'x': it['x'] + right_x})
        config_b = right_items_b + bottom_items_b

        best_of_ab = config_a if len(config_a) >= len(config_b) else config_b
        if len(best_of_ab) > best_extra:
            best_extra = len(best_of_ab)
            best_extra_items = best_of_ab
            
            # Determine if we should center the blocks (pure vertical or pure horizontal stack)
            is_config_a = (best_of_ab is config_a)
            r_items = right_items_a if is_config_a else right_items_b
            b_items = bottom_items_a if is_config_a else bottom_items_b
            
            if not r_items and b_items:
                fill_w = max((it['x'] + it['width'] for it in b_items), default=0)
                if best_w < fill_w:
                    shift = (fill_w - best_w) / 2.0
                    for it in best_config['items']: it['x'] += shift
                elif fill_w < best_w:
                    shift = (best_w - fill_w) / 2.0
                    for it in b_items: it['x'] += shift
            elif not b_items and r_items:
                fill_h = max((it['y'] + it['height'] for it in r_items), default=0)
                if best_h < fill_h:
                    shift = (fill_h - best_h) / 2.0
                    for it in best_config['items']: it['y'] += shift
                elif fill_h < best_h:
                    shift = (best_h - fill_h) / 2.0
                    for it in r_items: it['y'] += shift
        
        # Apply fill items if any were found
        if best_extra_items:
            best_config['items'].extend(best_extra_items)
            best_config['totalItems'] = len(best_config['items'])
            all_items = best_config['items']
            best_config['widthUsed'] = max(it['x'] + it['width'] for it in all_items)
            best_config['heightUsed'] = max(it['y'] + it['height'] for it in all_items)
            best_config['strategyUsed'] = best_strategy + '+l_fill'
        else:
            best_config['strategyUsed'] = best_strategy
        
        return best_config

    elif strategy == 'head_to_tail':
        p1 = solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p5_params, False)
        p2 = solve_cluster_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, p6_params, True)
        best = p1 if p1['totalItems'] >= p2['totalItems'] else p2
        return best

    elif strategy == 'staggered':
        if shape_type == 'HEXAGON':
            logger.info(f"[sticker_imposer] Explicit staggered strategy selected for HEXAGON, redirecting to hex_tiling")
            h1 = calculate_hex_tiling_row_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            h2 = calculate_hex_tiling_row_stagger(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
            h3 = calculate_hex_tiling_col_stagger(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
            h4 = calculate_hex_tiling_col_stagger(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
            
            hex_orientation = (shape_props or {}).get('hexOrientation', 'pointy-top')
            if hex_orientation == 'pointy-top':
                candidates = [(h1, False), (h4, True)]
            else:
                candidates = [(h3, False), (h2, True)]
                
            candidates.sort(key=lambda x: (x[0]['totalItems'], -x[0]['widthUsed']*x[0]['heightUsed']), reverse=True)
            best, is_rotated = candidates[0]
            best['strategyUsed'] = 'staggered_hex_tiling'
            return best

        p1 = calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        p2 = calculate_staggered_hex_layout(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
        p3 = calculate_staggered_vertical_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        p4 = calculate_staggered_vertical_layout(usable_w, usable_h, item_h, item_w, gap_y, gap_x)
        
        candidates = [
            (p1, False),
            (p2, True),
            (p3, False),
            (p4, True)
        ]
        candidates.sort(key=lambda x: (x[0]['totalItems'], -x[0]['widthUsed']*x[0]['heightUsed']), reverse=True)
        best, is_rotated = candidates[0]
        
        if is_rotated:
            for item in best['items']:
                item['isRotated'] = True
        return best
    else: # grid
        p1 = solve_grid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
        p2 = solve_grid_layout(usable_w, usable_h, item_h, item_w, gap_x, gap_y)
        
        best = p1 if p1['totalItems'] >= p2['totalItems'] else p2
        
        if best is p2:
            for item in best['items']:
                item['isRotated'] = True
                
        return best


def solve_optimal_sticker_layout(*args, **kwargs) -> Dict[str, Any]:
    # Chính sách Rust/fallback (Task 13-ext / Req 7): fail-fast nếu thiếu Rust & tắt cờ
    from app.workers.imposition_rust_policy import require_rust
    require_rust("sticker layout")
    # Extract base_poly from kwargs if present, otherwise try positional arguments (which is the 16th argument)
    base_poly = kwargs.get('base_poly', None)
    if base_poly is None and len(args) >= 16:
        base_poly = args[15]
        
    gap_x = kwargs.get('gap_x') or (args[4] if len(args) >= 5 else 0.0)
    gap_y = kwargs.get('gap_y') or (args[5] if len(args) >= 6 else 0.0)
    
    # Extract secondary_gap from kwargs
    secondary_gap = kwargs.pop('secondary_gap', None)
    
    # Run the original solver implementation
    best_config = _solve_optimal_sticker_layout_impl(*args, secondary_gap=secondary_gap, **kwargs)
    
    # Clean up collisions one final time using true shape geometry
    # Skip for hex_tiling/staggered — deterministic formulas guarantee non-overlap
    strategy_used = best_config.get('strategyUsed', '') if best_config else ''
    SKIP_COLLISION_STRATEGIES = {'hex_tiling', 'staggered', 'staggered_hex_tiling', 'triangle_advanced', 'pentagon_advanced'}
    skip_collision = any(s in strategy_used for s in SKIP_COLLISION_STRATEGIES)
    # base_poly thiếu (không dò được khuôn): dùng bbox ô tem để vẫn prune chồng/gap.
    if base_poly is None and best_config and best_config.get('items'):
        try:
            from shapely.geometry import box as _box
            _iw = float(args[2]) if len(args) >= 3 else 0.0  # item_w
            _ih = float(args[3]) if len(args) >= 4 else 0.0  # item_h
            if _iw > 0 and _ih > 0:
                base_poly = _box(0, 0, _iw, _ih)
        except Exception:
            pass
    if base_poly is not None and best_config and 'items' in best_config and best_config['items'] and not skip_collision:
        best_config['items'] = resolve_layout_collisions(best_config['items'], base_poly, max(gap_x, gap_y))
        best_config['totalItems'] = len(best_config['items'])
        if best_config['items']:
            best_config['widthUsed'] = max(it['x'] + it['width'] for it in best_config['items'])
            best_config['heightUsed'] = max(it['y'] + it['height'] for it in best_config['items'])
        else:
            best_config['widthUsed'] = 0
            best_config['heightUsed'] = 0
            
    return best_config



