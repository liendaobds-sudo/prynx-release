"""Tìm mép thân tem sau dải bóng mềm, không suy silhouette từ nội dung AI.

Loang chỉ bắt đầu ở nền đã biết, đi qua chuyển sắc chậm và dừng ở mép màu thật.
Ứng viên phải ổn định, giữ topology/artwork và không ăn qua một vành sáng.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from app.workers.sticker_artwork_guard import assess_ai_artwork_loss


# QUALITY (audit 2026-09-05 §SHADOW.1): đây là ngưỡng hình học/màu, không phải
# giới hạn tài nguyên. Không hạ lưới nguồn, không giả định tem tròn hay viền vàng.
_REFERENCE_EDGE_PX = 600.0
_LOCAL_COLOR_STEP = 5.0
_MAX_LOCAL_COLOR_STEP = 16.0
_MIN_RETAINED_RATIO = 0.80
_MIN_REMOVED_RATIO = 0.002
_MAX_CANDIDATE_DRIFT_RATIO = 0.003
_MAX_FRAGMENT_RATIO = 0.0001
_MIN_SHADOW_COLOR_SPREAD = 12.0
_MAX_SHADOW_WIDTH_RATIO = 0.15
_REVERSE_COLOR_DISTANCE = 8.0
_MAX_REVERSED_BOUNDARY_RATIO = 0.20


def _distance_inside(mask: np.ndarray) -> np.ndarray:
    return cv2.distanceTransform(np.pad(mask.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]


def _distance_to_candidate(candidate: np.ndarray) -> np.ndarray:
    # Không padding: mép ROI không phải một phần của tem. Padding zero ở đây
    # sẽ làm tai/vùng mất chạm mép ảnh có khoảng cách giả chỉ một pixel.
    return cv2.distanceTransform((~candidate).astype(np.uint8), cv2.DIST_L2, 5)


def _border_flood(
    work: np.ndarray,
    reference: np.ndarray,
    obstacles: np.ndarray,
    step: float,
) -> np.ndarray:
    height, width = reference.shape
    flood = np.zeros((height + 2, width + 2), dtype=np.uint8)
    flood[1:-1, 1:-1][obstacles] = 1
    background = ~(reference | obstacles)
    # Gieo đủ các đoạn nền bị tem chạm mép chia cắt; tuyệt đối không gieo trên
    # artwork ở biên ảnh. Mask-only không ghi đè RGB dùng cho phép kiểm sau.
    seeds = (
        [(int(x), 0) for x in np.flatnonzero(background[0])]
        + [(int(x), height - 1) for x in np.flatnonzero(background[-1])]
        + [(0, int(y)) for y in np.flatnonzero(background[:, 0])]
        + [(width - 1, int(y)) for y in np.flatnonzero(background[:, -1])]
    )
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    for x, y in seeds:
        if flood[y + 1, x + 1] == 0:
            cv2.floodFill(work, flood, (x, y), 0, (step,) * 3, (step,) * 3, flags)
    return reference & (flood[1:-1, 1:-1] != 255)


def _main_component(candidate: np.ndarray, reference_area: int) -> np.ndarray | None:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate.astype(np.uint8), connectivity=8)
    if count <= 1:
        return None
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    area = int(stats[largest, cv2.CC_STAT_AREA])
    fragments = int(np.count_nonzero(candidate)) - area
    if area < reference_area * _MIN_RETAINED_RATIO:
        return None
    if fragments > max(4, reference_area * _MAX_FRAGMENT_RATIO):
        return None
    return labels == largest


def _hole_count(mask: np.ndarray) -> int:
    contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    # Cùng mức lỗ có ý nghĩa 64 px của _align_labels_to_reference. Các lỗ JPEG
    # 2..6 px nằm trong bóng bị bỏ không phải lỗ bế cần giữ của thân tem.
    return sum(
        1 for index, contour in enumerate(contours)
        if hierarchy is not None and hierarchy[0, index, 3] >= 0 and cv2.contourArea(contour) >= 64
    )


def _removes_crisp_reference_edge(
    rgb: np.ndarray,
    reference: np.ndarray,
    candidate: np.ndarray,
    obstacles: np.ndarray,
    edge_length: int,
) -> bool:
    """Không xóa tai/viền có mép thật chỉ vì chúng sáng và phẳng như nền.

    Mép bóng tiếp tục chuyển sắc vào trong. Mép in thật có bước nhảy từ nền,
    sau đó tương đối ổn định; đo từng cặp qua mép gốc, không chỉ texture ở lõi.
    """
    height, width = reference.shape
    source = rgb.astype(np.float32)
    strong = np.zeros(reference.shape, dtype=np.uint8)
    center = np.s_[1:height - 1, 1:width - 1]
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        outside = np.s_[1 + dy:height - 1 + dy, 1 + dx:width - 1 + dx]
        inside = np.s_[1 - dy:height - 1 - dy, 1 - dx:width - 1 - dx]
        valid = (
            reference[center] & ~candidate[center] & ~reference[outside]
            & ~obstacles[outside] & reference[inside]
        )
        outer_delta = np.max(np.abs(source[center] - source[outside]), axis=2)
        inner_delta = np.max(np.abs(source[center] - source[inside]), axis=2)
        strong[center][valid & (outer_delta >= 6) & (outer_delta > 2 * inner_delta + 4)] = 1
    if not np.any(strong):
        return False
    _count, connected = cv2.connectedComponents(
        cv2.dilate(strong, np.ones((3, 3), dtype=np.uint8)), connectivity=8,
    )
    _ids, counts = np.unique(connected[strong > 0], return_counts=True)
    return bool(counts.max() >= max(6, math.ceil(edge_length * 0.01)))


def _erases_light_rim(
    rgb: np.ndarray,
    reference: np.ndarray,
    candidate: np.ndarray,
    obstacles: np.ndarray,
    background_rgb: tuple[int, int, int],
    scale: float,
) -> bool:
    """Bóng tối dần vào trong; sáng trở lại trong vùng bị xóa có thể là viền tem."""
    removed = reference & ~candidate
    edge = (
        removed & (cv2.dilate(candidate.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        & (_distance_inside(reference) > max(2.0, 3.0 * scale))
    )
    if not np.any(edge):
        return False
    distance = np.max(np.abs(rgb.astype(np.float32) - np.asarray(background_rgb, np.float32)), axis=2)
    signed = _distance_inside(candidate) - _distance_to_candidate(candidate)
    signed = cv2.GaussianBlur(signed, (0, 0), sigmaX=max(0.7, 2.0 * scale))
    gy, gx = np.gradient(signed)
    magnitude = np.maximum(np.hypot(gx, gy), 1e-5)
    ys, xs = np.nonzero(edge)
    nx, ny = gx[edge] / magnitude[edge], gy[edge] / magnitude[edge]
    reversed_samples = np.zeros(xs.size, dtype=bool)
    for length in (max(2.0, 4 * scale), max(4.0, 8 * scale), max(6.0, 16 * scale)):
        map_x = (xs - nx * length).astype(np.float32).reshape(1, -1)
        map_y = (ys - ny * length).astype(np.float32).reshape(1, -1)
        farther = cv2.remap(distance, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT).reshape(-1)
        # Ở khe lõm hẹp, pháp tuyến có thể gặp cánh khác/tem hàng xóm: không
        # dùng màu của chúng để phán dải bóng đang kiểm bị đảo chiều.
        blocked = cv2.remap(
            (candidate | obstacles).astype(np.uint8), map_x, map_y,
            cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT,
        ).reshape(-1) > 0
        reversed_samples |= ~blocked & (farther > distance[edge] + _REVERSE_COLOR_DISTANCE)
    return bool(np.mean(reversed_samples) > _MAX_REVERSED_BOUNDARY_RATIO)


def recover_soft_shadow_alpha(
    source_rgb: np.ndarray,
    source_alpha: np.ndarray,
    labels: np.ndarray,
    background_rgb: tuple[int, int, int],
) -> np.ndarray | None:
    """Trả Alpha mềm cùng lưới nếu có tem được khử bóng đủ chắc; còn lại giữ nguyên.

    Mỗi component có ROI và vật cản riêng. Không có ứng viên an toàn thì trả None,
    để caller dùng guard Lô A/nhánh nhận diện đã có thay vì đoán một biên mới.
    """
    rgb = np.asarray(source_rgb, dtype=np.uint8)
    alpha = np.asarray(source_alpha, dtype=np.uint8)
    original_labels = np.asarray(labels)
    if rgb.ndim != 3 or rgb.shape[2] < 3 or alpha.shape != rgb.shape[:2] or original_labels.shape != alpha.shape:
        raise ValueError("Ảnh, Alpha và nhãn tem phải cùng lưới điểm ảnh.")
    count, components, stats, _ = cv2.connectedComponentsWithStats(
        (original_labels > 0).astype(np.uint8), connectivity=8,
    )
    output = None
    for component_id in range(1, count):
        x, y, width, height, area = (int(v) for v in stats[component_id])
        if min(width, height) < 8:
            continue
        scale = max(width, height) / _REFERENCE_EDGE_PX
        margin = max(4, math.ceil(max(width, height) * 0.10))
        left, top = max(0, x - margin), max(0, y - margin)
        right, bottom = min(alpha.shape[1], x + width + margin), min(alpha.shape[0], y + height + margin)
        roi = np.s_[top:bottom, left:right]
        reference = components[roi] == component_id
        obstacles = (components[roi] > 0) & ~reference
        local_rgb = rgb[roi][:, :, :3]
        work = cv2.GaussianBlur(
            local_rgb.astype(np.float32), (0, 0), sigmaX=max(0.25, 0.5 * scale),
        )
        step = min(_MAX_LOCAL_COLOR_STEP, _LOCAL_COLOR_STEP / scale)
        candidate = _main_component(_border_flood(work, reference, obstacles, step), area)
        if candidate is None:
            continue
        removed = reference & ~candidate
        if np.count_nonzero(removed) < max(16, area * _MIN_REMOVED_RATIO):
            continue
        if float(_distance_inside(removed).max()) <= max(1.5, 2.0 * scale):
            continue
        # Dải màu phẳng (offset/halo in thật) không phải bằng chứng bóng mềm.
        # JPEG hồng của test cũ chỉ trải 7 mức; bóng nâu mẫu trải hơn 100 mức.
        color_distance = np.max(np.abs(local_rgb.astype(np.float32) - np.asarray(background_rgb, np.float32)), axis=2)
        color_low, color_high = np.percentile(color_distance[removed], (10, 90))
        if color_high - color_low < _MIN_SHADOW_COLOR_SPREAD:
            continue
        # Tai dài cũng có thể rất phẳng. Phần bỏ cách quá xa thân còn lại là
        # vùng mơ hồ, không được xem là dải bóng sát mép thông thường.
        if np.percentile(_distance_to_candidate(candidate)[removed], 99) > max(3, min(width, height) * _MAX_SHADOW_WIDTH_RATIO):
            continue
        alternative = _main_component(_border_flood(work, reference, obstacles, step * 1.2), area)
        if alternative is None or np.count_nonzero(alternative ^ candidate) > area * _MAX_CANDIDATE_DRIFT_RATIO:
            continue
        if _hole_count(reference) != _hole_count(candidate):
            continue
        if _removes_crisp_reference_edge(local_rgb, reference, candidate, obstacles, max(width, height)):
            continue
        if assess_ai_artwork_loss(local_rgb, reference, candidate).rejected:
            continue
        if _erases_light_rim(local_rgb, reference, candidate, obstacles, background_rgb, scale):
            continue

        soft = cv2.GaussianBlur(candidate.astype(np.float32) * 255, (0, 0), sigmaX=max(0.6, 0.6 * scale))
        # Giữ đúng membership/topology ở ngưỡng 128, chỉ thêm dải chuyển tiếp
        # để marching-squares có nội suy subpixel; không tô lỗ/bo mất tai mảnh.
        soft[candidate] = np.maximum(soft[candidate], 128)
        soft[~candidate] = np.minimum(soft[~candidate], 127)
        soft = np.rint(soft).astype(np.uint8)
        if output is None:
            output = alpha.copy()
        target = output[roi]
        target[reference] = soft[reference]
        fringe = (components[roi] == 0) & (soft > 0)
        target[fringe] = np.maximum(target[fringe], soft[fringe])
    return output
