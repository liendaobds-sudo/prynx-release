import cv2
import numpy as np
from enum import Enum
import math
import logging

logger = logging.getLogger(__name__)

# ShapeType được định nghĩa DUY NHẤT tại shape_types.py (SSOT — R10.1/R10.3).
# Import lại để giữ tương thích cho mọi tham chiếu `ShapeType.X` trong file này.
from app.workers.shape_types import ShapeType  # noqa: E402,F401

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
