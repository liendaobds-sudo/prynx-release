"""Collision detection and resolution for sticker layouts.

Validates placed stickers against each other using true Shapely geometry,
removing items that overlap or violate minimum gap requirements.
"""

# ── Hằng số dò va chạm tem–tem (đơn vị points / pt² trừ khi ghi rõ) ──
# Nới lỏng ngưỡng gap để bù sai số đo Overhang tự động. ~1.5pt ≈ 0.5mm.
GAP_TOLERANCE_PT = 1.5
# Diện tích chồng lấn tối thiểu để coi là vi phạm (lọc các "chạm" cực nhỏ do sai số).
MIN_OVERLAP_AREA_PT2 = 1.0
# Ngưỡng theo tỉ lệ diện tích tem: chồng < 0.1% diện tích tem coi như hợp lệ.
OVERLAP_AREA_RATIO = 0.001


def resolve_layout_collisions(items, base_poly, gap_pt):
    """Kiểm tra và loại bỏ tem bị chồng lấn hoặc quá gần nhau.
    
    Dùng 2 tầng kiểm tra:
    1. intersects() — phát hiện chồng lấn thực sự (diện tích chung)
    2. distance() < gap — phát hiện quá gần (không đảm bảo gap)
    AABB pre-filter cho tốc độ.
    """
    from shapely.affinity import translate, scale, rotate
    import logging

    _logger = logging.getLogger(__name__)
    if not items or not base_poly:
        return items
        
    try:
        # 1. Chuẩn hóa đa giác gốc về origin
        minx, miny, maxx, maxy = base_poly.bounds
        poly_w = maxx - minx
        poly_h = maxy - miny
        
        if poly_w <= 0 or poly_h <= 0:
            return items
        
        poly_at_origin = translate(base_poly, xoff=-minx, yoff=-miny)
        sticker_area = poly_at_origin.area
        
        _logger.debug(f"[COLLISION_RESOLVER] poly_w={poly_w:.1f} poly_h={poly_h:.1f} area={sticker_area:.1f} gap={gap_pt:.1f} items={len(items)}")
        
        # 2. Tạo polygon cho mỗi item
        placed_polys = []
        placed_bounds = []
        for idx, item in enumerate(items):
            iw = item['width']
            ih = item['height']
            is_rot90 = item.get('isRotated', False)
            is_rot180 = item.get('isRotated180', False)
            
            p = poly_at_origin
            
            if is_rot90 and is_rot180:
                angle = -270
            elif is_rot180:
                angle = 180
            elif is_rot90:
                angle = -90
            else:
                angle = 0
            
            if angle != 0:
                cx = poly_w / 2.0
                cy = poly_h / 2.0
                p = rotate(p, angle, origin=(cx, cy))
                bx0, by0, _, _ = p.bounds
                p = translate(p, xoff=-bx0, yoff=-by0)
            
            # Scale cho khớp item size
            cur_bx0, cur_by0, cur_bx1, cur_by1 = p.bounds
            cur_w = cur_bx1 - cur_bx0
            cur_h = cur_by1 - cur_by0
            if cur_w > 0 and cur_h > 0 and (abs(cur_w - iw) > 0.5 or abs(cur_h - ih) > 0.5):
                p = scale(p, xfact=iw / cur_w, yfact=ih / cur_h, origin=(0, 0))
            
            p = translate(p, xoff=item['x'], yoff=item['y'])
            placed_polys.append(p)
            placed_bounds.append(p.bounds)
        
        # 3. Tìm cặp vi phạm: chồng lấn (intersects + area) HOẶC quá gần (distance < gap)
        gap_tol = max(0.0, gap_pt - GAP_TOLERANCE_PT)  # nới ~1.5pt (≈0.5mm) bù sai số đo Overhang tự động
        overlap_area_threshold = max(MIN_OVERLAP_AREA_PT2, sticker_area * OVERLAP_AREA_RATIO)
        violations = []  # (idx_i, idx_j, severity)
        n = len(placed_polys)
        
        for i in range(n):
            bi = placed_bounds[i]
            for j in range(i + 1, n):
                bj = placed_bounds[j]
                # AABB pre-filter mở rộng bởi gap
                if (bi[2] + gap_pt < bj[0] or bi[0] - gap_pt > bj[2] or
                    bi[3] + gap_pt < bj[1] or bi[1] - gap_pt > bj[3]):
                    continue
                
                pi = placed_polys[i]
                pj = placed_polys[j]
                
                # Check 1: Chồng lấn thực sự
                if pi.intersects(pj):
                    try:
                        inter_area = pi.intersection(pj).area
                    except Exception:
                        inter_area = 0
                    if inter_area > overlap_area_threshold:
                        violations.append((i, j, inter_area))  # severity = area
                        continue
                    # Nếu đè nhau cực ít (dưới ngưỡng) -> coi như hợp lệ (sai số), không kiểm tra khoảng cách nữa
                else:
                    # Check 2: Quá gần (distance < gap)
                    try:
                        dist = pi.distance(pj)
                    except Exception:
                        continue
                    if dist < gap_tol:
                        violations.append((i, j, gap_pt - dist))  # severity = how much too close
        
        if not violations:
            _logger.debug(f"[COLLISION_RESOLVER] Không phát hiện vi phạm — giữ nguyên {len(items)} tem")
            return items
        
        _logger.debug(f"[COLLISION_RESOLVER] Phát hiện {len(violations)} cặp vi phạm (overlap/too-close)")
        if _logger.isEnabledFor(logging.DEBUG):
            for idx_i, idx_j, sev in violations[:10]:
                it_i = items[idx_i]
                it_j = items[idx_j]
                _logger.debug(f"  [{idx_i}]({it_i['x']:.0f},{it_i['y']:.0f}) x [{idx_j}]({it_j['x']:.0f},{it_j['y']:.0f}) severity={sev:.2f}")
        
        # 4. Loại bỏ tham lam — ưu tiên xóa tem vi phạm nhiều nhất
        removed = set()
        while True:
            counts = {}
            active = [(i, j) for i, j, _ in violations if i not in removed and j not in removed]
            if not active:
                break
            for i, j in active:
                counts[i] = counts.get(i, 0) + 1
                counts[j] = counts.get(j, 0) + 1
            target = max(counts, key=counts.get)
            removed.add(target)
        
        valid_items = [item for idx, item in enumerate(items) if idx not in removed]
        _logger.debug(f"[COLLISION_RESOLVER] Pruned {len(removed)} items, remaining {len(valid_items)}/{len(items)}")
        return valid_items
    except Exception as e:
        # F5: dùng logger.exception thay traceback.print_exc() (không rò stacktrace ra stdout)
        _logger.exception(f"[COLLISION_RESOLVER] Error: {type(e).__name__}")
        return items

