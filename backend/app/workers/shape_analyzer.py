import cv2
import numpy as np
from enum import Enum
import math
import logging

logger = logging.getLogger(__name__)

class ShapeType(Enum):
    RECTANGLE = "Vuông/Chữ nhật"
    CIRCLE_ELLIPSE = "Tròn/Elip"
    TRIANGLE = "Tam giác"
    PENTAGON = "Ngũ giác"
    HEXAGON = "Lục giác"
    ARROW = "Mũi tên"
    DUMBBELL = "Tạ tay"
    HAMMER = "Búa"
    CUSTOM = "Đặc biệt"

def detect_shape(mask_img: np.ndarray) -> ShapeType:
    """
    Phân tích biên dạng từ mask ảnh để nhận diện loại hình học.
    Trả về một enum ShapeType.
    """
    if mask_img is None or mask_img.size == 0:
        return ShapeType.CUSTOM

    contours, _ = cv2.findContours(mask_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return ShapeType.CUSTOM

    # Lấy contour lớn nhất (loại bỏ nhiễu)
    cnt = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(cnt)
    
    x, y, w, h = cv2.boundingRect(cnt)
    if w == 0 or h == 0 or area == 0:
        return ShapeType.CUSTOM
        
    perimeter = cv2.arcLength(cnt, True)
    if perimeter == 0:
        return ShapeType.CUSTOM

    # 1. Hình Vuông / Chữ nhật
    rect = cv2.minAreaRect(cnt)
    min_rect_area = rect[1][0] * rect[1][1]
    if min_rect_area > 0 and area / min_rect_area > 0.95:
        logger.info(f"Shape detected: RECTANGLE (Area ratio: {area/min_rect_area:.2f})")
        return ShapeType.RECTANGLE

    # 2. Hình Tròn / Elip
    circularity = 4 * math.pi * area / (perimeter * perimeter)
    if circularity > 0.85:
        logger.info(f"Shape detected: CIRCLE_ELLIPSE (Circularity: {circularity:.2f})")
        return ShapeType.CIRCLE_ELLIPSE
            
    # Đơn giản hóa đa giác
    epsilon = 0.02 * perimeter
    approx = cv2.approxPolyDP(cnt, epsilon, True)
    vertices = len(approx)
    
    # 3. Tam giác
    if vertices == 3:
        logger.info(f"Shape detected: TRIANGLE")
        return ShapeType.TRIANGLE
        
    # 4. Lục giác
    if vertices == 6 and cv2.isContourConvex(approx) and circularity > 0.6:
        logger.info(f"Shape detected: HEXAGON")
        return ShapeType.HEXAGON

    # 5. Ngũ giác & Mũi tên (check polygon vertices TRƯỚC profile analysis)
    if vertices == 5 and cv2.isContourConvex(approx):
        logger.info(f"Shape detected: PENTAGON")
        return ShapeType.PENTAGON
    if vertices == 7:
        logger.info(f"Shape detected: ARROW")
        return ShapeType.ARROW

    # Phân tích theo hình chữ nhật (Axis-Aligned Bounding Box)
    cropped = mask_img[y:y+h, x:x+w]
    
    # Tính toán profile theo 2 trục
    col_sums = np.sum(cropped > 0, axis=0) # Profile theo chiều ngang (trục X)
    row_sums = np.sum(cropped > 0, axis=1) # Profile theo chiều dọc (trục Y)
    
    # Cần đủ dữ liệu để phân tích profile
    if w < 9 or h < 9:
        logger.info(f"Shape detected: CUSTOM (too small for profile: {w}x{h})")
        return ShapeType.CUSTOM
    
    # Phân tích trục X (tem nằm ngang)
    p_len_w = w // 3
    left_avg_x = np.mean(col_sums[:p_len_w])
    mid_avg_x = np.mean(col_sums[p_len_w:2*p_len_w])
    right_avg_x = np.mean(col_sums[2*p_len_w:])
    
    # Phân tích trục Y (tem nằm dọc)
    p_len_h = h // 3
    top_avg_y = np.mean(row_sums[:p_len_h])
    mid_avg_y = np.mean(row_sums[p_len_h:2*p_len_h])
    bot_avg_y = np.mean(row_sums[2*p_len_h:])
    
    top_max_y = np.max(row_sums[:p_len_h])
    mid_min_y = np.min(row_sums[p_len_h:2*p_len_h])
    bot_max_y = np.max(row_sums[2*p_len_h:])
    
    left_max_x = np.max(col_sums[:p_len_w])
    mid_min_x = np.min(col_sums[p_len_w:2*p_len_w])
    right_max_x = np.max(col_sums[2*p_len_w:])
    
    # Tạ tay (Dumbbell): 2 đầu to hơn đoạn giữa RÕ RÀNG (threshold 1.35)
    # Cả 2 đầu phải to hơn giữa, và giữa phải thắt lại rõ ràng
    dumbbell_thresh = 1.35
    is_dumbbell_x = (mid_min_x > 0 and left_max_x > mid_min_x * dumbbell_thresh 
                     and right_max_x > mid_min_x * dumbbell_thresh)
    is_dumbbell_y = (mid_min_y > 0 and top_max_y > mid_min_y * dumbbell_thresh 
                     and bot_max_y > mid_min_y * dumbbell_thresh)
    if is_dumbbell_x or is_dumbbell_y:
        logger.info(f"Shape detected: DUMBBELL (X: L={left_max_x:.0f} M={mid_min_x:.0f} R={right_max_x:.0f}, "
                    f"Y: T={top_max_y:.0f} M={mid_min_y:.0f} B={bot_max_y:.0f})")
        return ShapeType.DUMBBELL
    
    # Búa (Hammer): Một đầu to RÕ RÀNG, đầu kia nhỏ/phẳng
    # Threshold cao hơn (1.5) + giữa phải thắt lại + chỉ 1 đầu to
    hammer_thresh = 1.5
    # Kiểm tra trục X
    left_big_x = mid_min_x > 0 and left_max_x > mid_min_x * hammer_thresh
    right_big_x = mid_min_x > 0 and right_max_x > mid_min_x * hammer_thresh
    # Kiểm tra trục Y  
    top_big_y = mid_min_y > 0 and top_max_y > mid_min_y * hammer_thresh
    bot_big_y = mid_min_y > 0 and bot_max_y > mid_min_y * hammer_thresh
    
    # Hammer = chỉ 1 đầu to (XOR), không phải cả 2 (đó là dumbbell)
    is_hammer_x = (left_big_x != right_big_x) and (left_big_x or right_big_x)
    is_hammer_y = (top_big_y != bot_big_y) and (top_big_y or bot_big_y)
    
    if is_hammer_x or is_hammer_y:
        logger.info(f"Shape detected: HAMMER (X: L_big={left_big_x} R_big={right_big_x}, "
                    f"Y: T_big={top_big_y} B_big={bot_big_y})")
        return ShapeType.HAMMER
            
    logger.info(f"Shape detected: CUSTOM (Vertices: {vertices}, Circularity: {circularity:.2f})")
    return ShapeType.CUSTOM

def detect_dumbbell_from_path(path_items, page_rect) -> dict:
    """
    Port of Illustrator's detectDumbbellDimensions().
    Analyzes path items (from pdf_lib.extract_vector_paths) to detect dumbbell/hammer shape
    and compute bigDAlongAxisFrac by measuring distance from big head edge to handle.
    Returns dict with keys: bigDAlongAxisFrac, bodyW, bigD, smallD, shapeType, bigEndFirst, waistRatio
    or None if not a dumbbell/hammer.
    """
    
    
    if not path_items:
        return None
    
    # 1. Sample Bezier points from path items
    samples = []
    BASE_INTERP_STEPS = 10
    
    for item in path_items:
        if item[0] == 'l':  # line
            p1, p2 = item[1], item[2]
            samples.append((p1.x, p1.y))
        elif item[0] == 'c':  # bezier curve
            p0, p1, p2, p3 = item[1], item[2], item[3], item[4]
            samples.append((p0.x, p0.y))
            seg_len = math.sqrt((p3.x - p0.x)**2 + (p3.y - p0.y)**2)
            interp_steps = max(BASE_INTERP_STEPS, min(50, int(math.ceil(seg_len / 2))))
            for t_i in range(1, interp_steps):
                tt = t_i / interp_steps
                u = 1 - tt
                bx = u**3 * p0.x + 3*u**2*tt * p1.x + 3*u*tt**2 * p2.x + tt**3 * p3.x
                by = u**3 * p0.y + 3*u**2*tt * p1.y + 3*u*tt**2 * p2.y + tt**3 * p3.y
                samples.append((bx, by))
    
    if len(samples) < 10:
        return None
    
    # 2. Bounding box from samples
    xs = [s[0] for s in samples]
    ys = [s[1] for s in samples]
    s_min_x, s_max_x = min(xs), max(xs)
    s_min_y, s_max_y = min(ys), max(ys)
    total_w = s_max_x - s_min_x
    total_h = s_max_y - s_min_y
    if total_w <= 0 or total_h <= 0:
        return None
    
    is_horizontal = total_w > total_h
    long_dim = total_w if is_horizontal else total_h
    short_dim = total_h if is_horizontal else total_w
    
    # 3. Detect straight segments (handle detection)
    # Extract line segments AND near-straight Bezier curves from path items
    # (Illustrator's detectDumbbellDimensions checks if control points are near anchors)
    straight_segs = []
    STRAIGHT_TOLERANCE = long_dim * 0.005
    
    for item in path_items:
        if item[0] == 'l':
            p1, p2 = item[1], item[2]
            seg_len = math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2)
            if seg_len < long_dim * 0.05:
                continue
            angle = math.atan2(p2.y - p1.y, p2.x - p1.x)
            if is_horizontal:
                straight_segs.append({
                    'len': seg_len, 'angle': angle,
                    'axis_start': min(p1.x, p2.x), 'axis_end': max(p1.x, p2.x),
                    'cross_pos': (p1.y + p2.y) / 2
                })
            else:
                straight_segs.append({
                    'len': seg_len, 'angle': angle,
                    'axis_start': min(p1.y, p2.y), 'axis_end': max(p1.y, p2.y),
                    'cross_pos': (p1.x + p2.x) / 2
                })
        elif item[0] == 'c':
            # Check if this Bezier curve is nearly straight
            p0, cp1, cp2, p3 = item[1], item[2], item[3], item[4]
            seg_len = math.sqrt((p3.x - p0.x)**2 + (p3.y - p0.y)**2)
            if seg_len < long_dim * 0.05:
                continue
            # Distance of control points from anchor points
            cp1_dist = math.sqrt((cp1.x - p0.x)**2 + (cp1.y - p0.y)**2)
            cp2_dist = math.sqrt((cp2.x - p3.x)**2 + (cp2.y - p3.y)**2)
            # Also check deviation from the straight line p0->p3
            if seg_len > 0:
                # Cross product / seg_len = perpendicular distance
                dx, dy = p3.x - p0.x, p3.y - p0.y
                dev1 = abs(dx * (p0.y - cp1.y) - dy * (p0.x - cp1.x)) / seg_len
                dev2 = abs(dx * (p0.y - cp2.y) - dy * (p0.x - cp2.x)) / seg_len
            else:
                dev1 = dev2 = float('inf')
            
            # Consider it straight if control points are close to anchors OR 
            # deviation from line is small (< 2% of segment length)
            max_dev = max(dev1, dev2)
            if max_dev < seg_len * 0.02 or (cp1_dist < STRAIGHT_TOLERANCE and cp2_dist < STRAIGHT_TOLERANCE):
                angle = math.atan2(p3.y - p0.y, p3.x - p0.x)
                if is_horizontal:
                    straight_segs.append({
                        'len': seg_len, 'angle': angle,
                        'axis_start': min(p0.x, p3.x), 'axis_end': max(p0.x, p3.x),
                        'cross_pos': (p0.y + p3.y) / 2
                    })
                else:
                    straight_segs.append({
                        'len': seg_len, 'angle': angle,
                        'axis_start': min(p0.y, p3.y), 'axis_end': max(p0.y, p3.y),
                        'cross_pos': (p0.x + p3.x) / 2
                    })
    
    # 4. Find best parallel pair (handle edges)
    best_pair = None
    best_pair_len = 0
    ANGLE_TOLERANCE = 0.15
    
    for i in range(len(straight_segs)):
        for j in range(i + 1, len(straight_segs)):
            si, sj = straight_segs[i], straight_segs[j]
            angle_diff = abs(si['angle'] - sj['angle'])
            if angle_diff > math.pi:
                angle_diff = 2 * math.pi - angle_diff
            if angle_diff > math.pi - ANGLE_TOLERANCE:
                angle_diff = math.pi - angle_diff
            if angle_diff > ANGLE_TOLERANCE:
                continue
            
            cross_dist = abs(si['cross_pos'] - sj['cross_pos'])
            if cross_dist < short_dim * 0.05:
                continue
            
            pair_len = min(si['len'], sj['len'])
            if pair_len > best_pair_len:
                best_pair_len = pair_len
                best_pair = (si, sj)
    
    if best_pair is None:
        return None
    
    # 5. bodyW = distance between the 2 parallel straight edges
    body_w = abs(best_pair[0]['cross_pos'] - best_pair[1]['cross_pos'])
    
    # Handle must be narrower than 85% of short dimension
    if body_w >= short_dim * 0.85:
        return None
    
    # 6. Find handle position on long axis
    handle_axis_start = min(best_pair[0]['axis_start'], best_pair[1]['axis_start'])
    handle_axis_end = max(best_pair[0]['axis_end'], best_pair[1]['axis_end'])
    
    # Distance from each end to handle edge
    if is_horizontal:
        dist_to_start = handle_axis_start - s_min_x
        dist_to_end = s_max_x - handle_axis_end
    else:
        dist_to_start = handle_axis_start - s_min_y
        dist_to_end = s_max_y - handle_axis_end
    
    # 7. Measure cross-axis width of each head from sample points
    handle_mid = (handle_axis_start + handle_axis_end) / 2
    start_cross_min, start_cross_max = float('inf'), float('-inf')
    end_cross_min, end_cross_max = float('inf'), float('-inf')
    
    for sx, sy in samples:
        if is_horizontal:
            pt_cross = sy
            is_start_side = sx < handle_mid
        else:
            pt_cross = sx
            is_start_side = sy < handle_mid
        
        if is_start_side:
            start_cross_min = min(start_cross_min, pt_cross)
            start_cross_max = max(start_cross_max, pt_cross)
        else:
            end_cross_min = min(end_cross_min, pt_cross)
            end_cross_max = max(end_cross_max, pt_cross)
    
    start_width = (start_cross_max - start_cross_min) if start_cross_max > start_cross_min else 0
    end_width = (end_cross_max - end_cross_min) if end_cross_max > end_cross_min else 0
    
    # 8. Which end is bigger?
    big_end_at_start = start_width >= end_width
    big_end_extent = dist_to_start if big_end_at_start else dist_to_end
    
    # bigDAlongAxisFrac = distance from big head edge to handle / total length
    big_d_along_axis_frac = big_end_extent / long_dim if long_dim > 0 else 0.5
    
    big_d = short_dim
    small_d = body_w
    
    # 9. Classify: dumbbell vs hammer
    big_end_width = start_width if big_end_at_start else end_width
    small_end_width = end_width if big_end_at_start else start_width
    WIDE_THRESHOLD = 1.1  # Match Illustrator's _analyzeWidthProfile (1.15)
    
    logger.warning(f"[DUMBBELL_CLASSIFY] big_end_width={big_end_width:.2f}, small_end_width={small_end_width:.2f}, "
                   f"body_w={body_w:.2f}, threshold={body_w * WIDE_THRESHOLD:.2f}, "
                   f"big_passes={big_end_width > body_w * WIDE_THRESHOLD}, small_passes={small_end_width > body_w * WIDE_THRESHOLD}")
    
    if big_end_width > body_w * WIDE_THRESHOLD and small_end_width > body_w * WIDE_THRESHOLD:
        shape_type = 'dumbbell'
    else:
        shape_type = 'hammer'
    
    waist_ratio = body_w / short_dim if short_dim > 0 else 1.0
    
    logger.warning(f"[DUMBBELL_PATH_DETECT] type={shape_type}, bigDAlongAxisFrac={big_d_along_axis_frac:.4f}, "
                   f"bodyW={body_w:.1f}, bigD={big_d:.1f}, smallD={small_d:.1f}, "
                   f"bigEndFirst={'start' if big_end_at_start else 'end'}, waistRatio={waist_ratio:.3f}")
    
    return {
        'bigDAlongAxisFrac': big_d_along_axis_frac,
        'bodyW': body_w,
        'bigD': big_d,
        'smallD': small_d,
        'shapeType': shape_type,
        'bigEndFirst': not big_end_at_start,  # flip for Illustrator convention
        'waistRatio': waist_ratio
    }


def extract_shape_properties(mask_img: np.ndarray) -> dict:
    """
    Extracts geometric properties mimicking Illustrator's _analyzeWidthProfile:
    - bigEndAxisFrac: position of the big head transition relative to the long axis
    - waistRatio: ratio of the waist width to the maximum width
    """
    props = {'bigEndAxisFrac': 0.5, 'waistRatio': 1.0}
    try:
        x, y, w, h = cv2.boundingRect(mask_img)
        cropped = mask_img[y:y+h, x:x+w]
        
        is_horizontal = w > h
        
        # Calculate outer width profile (distance between first and last non-zero pixel)
        profile = []
        if is_horizontal:
            for c in range(w):
                nz = np.nonzero(cropped[:, c])[0]
                if len(nz) > 0:
                    profile.append(nz[-1] - nz[0] + 1)
                else:
                    profile.append(0)
        else:
            for r in range(h):
                nz = np.nonzero(cropped[r, :])[0]
                if len(nz) > 0:
                    profile.append(nz[-1] - nz[0] + 1)
                else:
                    profile.append(0)
                    
        profile = np.array(profile)
        
        nonzero_indices = np.nonzero(profile)[0]
        if len(nonzero_indices) == 0:
            return props
            
        start_idx = nonzero_indices[0]
        end_idx = nonzero_indices[-1]
        actual_len = end_idx - start_idx + 1
        
        if actual_len < 10:
            return props
            
        actual_profile = profile[start_idx:end_idx+1]
        
        edge_margin = int(actual_len * 0.10)
        waist_width = float('inf')
        waist_pos_idx = actual_len // 2
        
        for i in range(edge_margin, actual_len - edge_margin):
            if actual_profile[i] < waist_width:
                waist_width = actual_profile[i]
                waist_pos_idx = i
                
        if waist_width == float('inf'):
            waist_width = np.min(actual_profile)
            
        head_start_peak = np.max(actual_profile[:waist_pos_idx]) if waist_pos_idx > 0 else 0
        head_end_peak = np.max(actual_profile[waist_pos_idx:]) if waist_pos_idx < actual_len else 0
        
        big_end_first = head_start_peak >= head_end_peak
        big_d = max(head_start_peak, head_end_peak)
        
        if big_d > 0:
            props['waistRatio'] = waist_width / float(big_d)
            
        transition_threshold = waist_width * 1.05
        big_head_edge_pos = waist_pos_idx
        
        if big_end_first:
            for i in range(waist_pos_idx, -1, -1):
                if actual_profile[i] > transition_threshold:
                    big_head_edge_pos = i
                    break
        else:
            for i in range(waist_pos_idx, actual_len):
                if actual_profile[i] > transition_threshold:
                    big_head_edge_pos = actual_len - i
                    break
                    
        props['bigEndAxisFrac'] = big_head_edge_pos / float(actual_len)
        props['bigEndFirst'] = bool(big_end_first)
        
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Error extracting shape properties: {e}")
        
    return props
