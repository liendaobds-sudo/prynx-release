"""
NFP-based Bottom-Left-Fill placement engine for sticker imposition.

Thuật toán:
1. Lấy polygon cutline thực tế của sticker
2. Đặt tem TỪNG CÁI MỘT: quét bottom-left
3. Collision check: Shapely distance() trên polygon THẬT
4. Đảm bảo KHÔNG BAO GIỜ chồng lấn

Tối ưu tốc độ — COARSE-TO-FINE 2 pha:
- Pha 1 (Coarse): Quét grid thô (step = item_size/3) → tìm vùng hợp lệ nhanh
- Pha 2 (Fine): Tinh chỉnh quanh best coarse (step = gap/2) → vị trí chính xác
- AABB pre-filter loại trừ 99% trường hợp không cần Shapely
"""

from shapely.geometry import Polygon, box as shapely_box
from shapely.affinity import translate as s_translate, rotate as s_rotate
import logging
import time

_logger = logging.getLogger(__name__)


def solve_nfp_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, base_poly):
    """NFP-guided Bottom-Left-Fill placement cho sticker irregular shapes."""
    if not base_poly or base_poly.is_empty:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
    
    gap = max(gap_x, gap_y)
    t0 = time.time()
    
    # 1. Chuẩn hóa polygon gốc về origin
    bx0, by0, bx1, by1 = base_poly.bounds
    base = s_translate(base_poly, xoff=-bx0, yoff=-by0)
    pw = bx1 - bx0
    ph = by1 - by0
    
    if pw <= 0 or ph <= 0:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
    
    _logger.warning(f"[NFP_PLACER] sheet={usable_w:.0f}x{usable_h:.0f} poly={pw:.1f}x{ph:.1f} gap={gap:.1f}")
    
    # 2. Chuẩn bị variants (UNDILATED polygon)
    variants = _prepare_variants(base, pw, ph, usable_w, usable_h)
    
    if not variants:
        return {'totalItems': 0, 'items': [], 'widthUsed': 0, 'heightUsed': 0}
    
    # 3. Scan steps: COARSE-TO-FINE
    min_dim = min(pw, ph)
    coarse_step = max(gap, min_dim / 3.0)   # ~30-40pt cho item 100pt
    fine_step = max(1.0, gap / 2.0)          # ~2-3pt
    fine_radius = coarse_step + fine_step     # vùng tinh chỉnh quanh best coarse
    max_items = 500
    
    _logger.warning(f"[NFP_PLACER] {len(variants)} variants, coarse={coarse_step:.1f}pt fine={fine_step:.1f}pt")
    
    # 4. Đặt từng tem một (Bottom-Left-Fill)
    placed_polys = []
    placed_bounds = []
    placed_items = []
    
    for idx in range(max_items):
        # Pha 1: Coarse scan
        best = _find_best_position(variants, placed_polys, placed_bounds,
                                   usable_w, usable_h, coarse_step, gap)
        
        if best is None:
            break
        
        # Pha 2: Fine scan quanh best coarse position
        best_fine = _refine_position(best['var'], best['x'], best['y'],
                                     placed_polys, placed_bounds,
                                     usable_w, usable_h, fine_step, fine_radius, gap)
        if best_fine is not None:
            best = best_fine
        
        x, y, var = best['x'], best['y'], best['var']
        
        cand_poly = s_translate(var['poly'], xoff=x, yoff=y)
        placed_polys.append(cand_poly)
        placed_bounds.append(cand_poly.bounds)
        
        placed_items.append({
            'x': x,
            'y': y,
            'width': var['ow'],
            'height': var['oh'],
            'isRotated': var['isRotated'],
            'isRotated180': var['isRotated180'],
        })
        
        if idx < 5 or idx % 25 == 0:
            _logger.warning(
                f"[NFP_PLACER] item[{idx}] ({x:.1f},{y:.1f}) "
                f"rot90={var['isRotated']} rot180={var['isRotated180']}"
            )
    
    dt = time.time() - t0
    wu = max((i['x'] + i['width'] for i in placed_items), default=0)
    hu = max((i['y'] + i['height'] for i in placed_items), default=0)
    
    _logger.warning(f"[NFP_PLACER] Kết quả: {len(placed_items)} tem trong {dt:.1f}s, used={wu:.0f}x{hu:.0f}")
    
    return {
        'totalItems': len(placed_items),
        'items': placed_items,
        'widthUsed': wu,
        'heightUsed': hu,
        'cols': 0,
        'rows': 0,
    }


def _prepare_variants(base, pw, ph, usable_w, usable_h):
    """Chuẩn bị các biến thể xoay — chỉ dùng polygon UNDILATED."""
    variants = []
    
    rotations = [
        (0,    False, False),
        (180,  False, True),
        (-90,  True,  False),
    ]
    
    for angle, is_rot90, is_rot180 in rotations:
        if angle == 0:
            p = base
        else:
            cx, cy = pw / 2.0, ph / 2.0
            p = s_rotate(base, angle, origin=(cx, cy))
            rx0, ry0, _, _ = p.bounds
            p = s_translate(p, xoff=-rx0, yoff=-ry0)
        
        if not p.is_valid:
            p = p.buffer(0)
        
        _, _, rx1, ry1 = p.bounds
        ow = rx1
        oh = ry1
        
        if ow > usable_w + 0.1 or oh > usable_h + 0.1:
            continue
        
        variants.append({
            'poly': p,
            'ow': ow,
            'oh': oh,
            'isRotated': is_rot90,
            'isRotated180': is_rot180,
        })
    
    return variants


def _check_collision(var, x, y, placed_polys, placed_bounds, gap):
    """Kiểm tra va chạm tại vị trí (x, y). Trả về True nếu có collision."""
    pb = var['poly'].bounds
    ax0 = x + pb[0] - gap
    ay0 = y + pb[1] - gap
    ax1 = x + pb[2] + gap
    ay1 = y + pb[3] + gap
    
    gap_tol = gap - 0.01
    cand_poly = None
    
    for i in range(len(placed_polys)):
        pbb = placed_bounds[i]
        # AABB pre-filter
        if ax1 < pbb[0] or ax0 > pbb[2] or ay1 < pbb[1] or ay0 > pbb[3]:
            continue
        # Exact distance check
        if cand_poly is None:
            cand_poly = s_translate(var['poly'], xoff=x, yoff=y)
        if cand_poly.distance(placed_polys[i]) < gap_tol:
            return True
    
    return False


def _find_best_position(variants, placed_polys, placed_bounds,
                        usable_w, usable_h, step, gap):
    """Pha 1: Coarse scan — tìm vị trí BL hợp lệ đầu tiên."""
    best = None
    best_metric = (float('inf'), float('inf'))
    
    for var in variants:
        max_x = usable_w - var['ow']
        max_y = usable_h - var['oh']
        if max_x < -0.01 or max_y < -0.01:
            continue
        max_x = max(0, max_x)
        max_y = max(0, max_y)
        
        y = 0.0
        found = False
        while y <= max_y + 0.01 and not found:
            if y > best_metric[0] + 0.01:
                break
            x = 0.0
            while x <= max_x + 0.01:
                if not _check_collision(var, x, y, placed_polys, placed_bounds, gap):
                    metric = (y, x)
                    if metric < best_metric:
                        best = {'x': x, 'y': y, 'var': var}
                        best_metric = metric
                    found = True
                    break
                x += step
            y += step
    
    return best


def _refine_position(var, cx, cy, placed_polys, placed_bounds,
                     usable_w, usable_h, step, radius, gap):
    """Pha 2: Fine scan — tinh chỉnh quanh vị trí coarse để tìm BL tốt hơn.
    
    Quét vùng [cy-radius, cy] x [cx-radius, cx+radius] với step nhỏ.
    Chỉ cần tìm vị trí có y thấp hơn hoặc x thấp hơn tại cùng y.
    """
    max_x = usable_w - var['ow']
    max_y = usable_h - var['oh']
    
    # Quét từ y thấp hơn coarse, x từ 0
    best = None
    best_metric = (cy, cx)  # phải tốt hơn coarse
    
    y_start = max(0, cy - radius)
    y_end = min(cy + 0.01, max_y + 0.01)
    x_start = max(0, cx - radius)
    x_end = min(cx + radius, max_x + 0.01)
    
    y = y_start
    while y <= y_end:
        if y > best_metric[0] + 0.01:
            break
        x = x_start
        while x <= x_end:
            if not _check_collision(var, x, y, placed_polys, placed_bounds, gap):
                metric = (y, x)
                if metric < best_metric:
                    best = {'x': x, 'y': y, 'var': var}
                    best_metric = metric
                break  # Tìm được x nhỏ nhất → break, thử y tiếp
            x += step
        y += step
    
    return best
