"""Kiểm vùng artwork bị AI bỏ trước khi chấp nhận một biên tem thay thế.

Đây là chốt bảo toàn nội dung, không phải bộ phân đoạn bóng. Khi không đủ căn cứ
cho việc bỏ một mảng, caller giữ nguyên mask nguồn và yêu cầu kiểm tra lại.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

import cv2
import numpy as np


# QUALITY (audit 2026-09-05 §SHADOW.2): IoU toàn hình 0,893 vẫn lọt một mảng
# artwork lớn. Đo từng cụm mất; bỏ collar để mép thân/bóng không thành "chi tiết
# trong bóng". Trên ca thật collar 3 px tách 58% chi tiết ở mảng phải khỏi 0% ở bóng.
_MIN_LOST_AREA_PX = 16
_MIN_LOST_AREA_RATIO = 0.0005
_COLLAR_MIN_PX = 2
_COLLAR_EDGE_RATIO = 0.005
_DETAIL_GRADIENT_MIN = 12.0
_DETAIL_RATIO_MIN = 0.05
_DETAIL_COUNT_MIN = 8
_DEEP_INSET_MIN_PX = 3.0
_DEEP_INSET_EDGE_RATIO = 0.04
# Mép thân gần trắng trên bóng nhạt vẫn có contrast 3..6; ngưỡng 6 từng từ chối
# nhầm ca đó. Đoạn cắt xuyên mảng đặc không có mép nguồn thì vẫn dưới ngưỡng 3.
_BOUNDARY_GRADIENT_MIN = 3.0
_UNSUPPORTED_RUN_MIN_PX = 8
_UNSUPPORTED_RUN_EDGE_RATIO = 0.03
# Chuẩn hóa độ dốc theo độ phóng của ảnh, không hạ độ phân giải hay đổi mask.
_GRADIENT_REFERENCE_EDGE_PX = 600.0


@dataclass(frozen=True)
class ArtworkLossAssessment:
    rejected: bool
    reason: str = ""
    lost_area_px: int = 0
    detail_ratio: float = 0.0
    unsupported_run_px: int = 0


def _inside_distance(mask: np.ndarray) -> np.ndarray:
    """Padding tránh coi vùng chạm mép ảnh là có chiều dày vô hạn."""
    padded = np.pad(np.asarray(mask, dtype=np.uint8), 1)
    return cv2.distanceTransform(padded, cv2.DIST_L2, 5)[1:-1, 1:-1]


def _source_gradient(rgb: np.ndarray, scale: float) -> np.ndarray:
    """Đọc từng kênh để nhận cả chi tiết khác sắc nhưng cùng độ sáng."""
    gradient = np.zeros(rgb.shape[:2], dtype=np.float32)
    for channel in range(3):
        smooth = cv2.GaussianBlur(
            rgb[:, :, channel].astype(np.float32), (0, 0), sigmaX=0.8 * scale,
        )
        dx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)
        dy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)
        np.maximum(gradient, cv2.magnitude(dx, dy) * (scale / 8.0), out=gradient)
    return gradient


def assess_ai_artwork_loss(
    source_rgb: np.ndarray,
    reference_mask: np.ndarray,
    candidate_mask: np.ndarray,
) -> ArtworkLossAssessment:
    """Từ chối mất chi tiết hoặc biên lùi sâu không có căn cứ trong ảnh nguồn.

    Chỉ quyết định nhận/từ chối cả ứng viên; không union, tô lỗ hoặc nhị phân hóa
    Alpha. Nhờ vậy Alpha mềm của AI tốt và mask gốc khi fallback đều được giữ.
    """
    rgb = np.asarray(source_rgb)
    reference = np.asarray(reference_mask, dtype=bool)
    candidate = np.asarray(candidate_mask, dtype=bool)
    if (
        reference.ndim != 2 or candidate.shape != reference.shape
        or rgb.ndim != 3 or rgb.shape[:2] != reference.shape or rgb.shape[2] < 3
    ):
        raise ValueError("Ảnh và hai mask tem phải cùng một lưới điểm ảnh.")
    reference_area = int(np.count_nonzero(reference))
    if reference_area == 0:
        raise ValueError("Mask tham chiếu của tem không được rỗng.")
    lost = (reference & ~candidate).astype(np.uint8)
    minimum_area = max(_MIN_LOST_AREA_PX, math.ceil(reference_area * _MIN_LOST_AREA_RATIO))
    if int(np.count_nonzero(lost)) < minimum_area:
        return ArtworkLossAssessment(False)

    _x, _y, width, height = cv2.boundingRect(reference.astype(np.uint8))
    short_edge = min(width, height)
    collar = max(_COLLAR_MIN_PX, math.ceil(short_edge * _COLLAR_EDGE_RATIO))
    scale = max(1.0, short_edge / _GRADIENT_REFERENCE_EDGE_PX)
    detail_gain = min(1.0, short_edge / _GRADIENT_REFERENCE_EDGE_PX)
    support_radius = max(2, round(2 * scale))
    margin = math.ceil(3 * 0.8 * scale) + support_radius + 1
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(lost, connectivity=8)
    reference_depth = None
    for region_id in range(1, count):
        area = int(stats[region_id, cv2.CC_STAT_AREA])
        if area < minimum_area:
            continue
        x, y, region_width, region_height = (int(v) for v in stats[region_id, :4])
        left, top = max(0, x - margin), max(0, y - margin)
        right = min(reference.shape[1], x + region_width + margin)
        bottom = min(reference.shape[0], y + region_height + margin)
        roi = np.s_[top:bottom, left:right]
        component = (labels[roi] == region_id).astype(np.uint8)
        interior = _inside_distance(component) > collar
        interior_area = int(np.count_nonzero(interior))
        if interior_area < minimum_area:
            continue

        gradient = _source_gradient(rgb[roi], scale)
        # Cùng dải bóng khi thu nhỏ ảnh có độ dốc/pixel lớn hơn. Chuẩn hóa
        # texture cả chiều thu nhỏ, nhưng giữ contrast quan sát được cho bước
        # kiểm mép bên dưới để không phủ nhận mép thân trắng/bóng rất nhạt.
        detail_count = int(np.count_nonzero(
            interior & (gradient * detail_gain > _DETAIL_GRADIENT_MIN)
        ))
        detail_ratio = detail_count / interior_area
        if detail_count >= _DETAIL_COUNT_MIN and detail_ratio >= _DETAIL_RATIO_MIN:
            return ArtworkLossAssessment(True, "lost-source-detail", area, detail_ratio)

        # Mảng màu đặc không có texture. Một đoạn biên mới cắt sâu qua vùng
        # phẳng cũng không có căn cứ; bóng thật có mép thân tương ứng để đối chiếu.
        if reference_depth is None:
            reference_depth = _inside_distance(reference)
        interface = (cv2.dilate(component, np.ones((3, 3), dtype=np.uint8)) > 0) & candidate[roi]
        deep = interface & (
            reference_depth[roi] > max(_DEEP_INSET_MIN_PX, short_edge * _DEEP_INSET_EDGE_RATIO)
        )
        if not np.any(deep):
            continue
        support = cv2.dilate(
            gradient, np.ones((2 * support_radius + 1, 2 * support_radius + 1), dtype=np.uint8),
        )
        unsupported = (deep & (support < _BOUNDARY_GRADIENT_MIN)).astype(np.uint8)
        run_count, _run_labels, run_stats, _ = cv2.connectedComponentsWithStats(unsupported, connectivity=8)
        longest_run = int(run_stats[1:, cv2.CC_STAT_AREA].max()) if run_count > 1 else 0
        if longest_run >= max(_UNSUPPORTED_RUN_MIN_PX, math.ceil(short_edge * _UNSUPPORTED_RUN_EDGE_RATIO)):
            return ArtworkLossAssessment(True, "unsupported-interior-boundary", area, detail_ratio, longest_run)
    return ArtworkLossAssessment(False)
