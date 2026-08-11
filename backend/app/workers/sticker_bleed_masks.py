"""Hình học mask và chồng mí cho bù xén tem nhãn."""

from __future__ import annotations

import math

import cv2
import numpy as np


_EDGE_COLOR_ADAPTIVE_BASE_MM = 0.60
_EDGE_COLOR_ADAPTIVE_MAX_MM = 2.50
_EDGE_COLOR_ADAPTIVE_SOURCE_PIXELS = 7.0
_SEAM_FEATHER_MM = 0.15
_SAMPLED_BLEED_OVERLAP_MM = 0.25
_SAMPLED_BLEED_FRINGE_SOURCE_PIXELS = 2.5
_SAMPLED_BLEED_FRINGE_MAX_MM = 0.8
_BLEED_JOIN_CORNER_MAX_ANGLE_DEG = 135.0
_BLEED_JOIN_CORNER_ZONE_SPAN = 2.5
_TRAJECTORY_RECT_MIN_FILL_RATIO = 0.82
_TRAJECTORY_RECT_CORE_MIN_FILL_RATIO = 0.995
_TRAJECTORY_RECT_MIN_CONVEXITY_RATIO = 0.99


def _bleed_roi_bbox(mask: np.ndarray, margin: int = 8):
    """Trả bbox ``(y0, y1, x0, x1)`` của mask, có nới và kẹp biên."""
    ys, xs = np.where(mask > 0)
    if ys.size == 0:
        return None
    height, width = mask.shape[:2]
    y0 = max(0, int(ys.min()) - margin)
    y1 = min(height, int(ys.max()) + 1 + margin)
    x0 = max(0, int(xs.min()) - margin)
    x1 = min(width, int(xs.max()) + 1 + margin)
    return y0, y1, x0, x1


def _sampled_bleed_overlap_px(
    px_per_mm: float,
    *,
    source_pixel_mm: float | None = None,
    selected_peel_px: int | None = None,
    initial_peel_px: int | None = None,
) -> int:
    """Độ chồng mí hiển thị, có bù fringe nguồn nhưng không chạy theo độ dò sâu."""
    try:
        resolved = float(px_per_mm)
    except (TypeError, ValueError):
        resolved = 0.0
    if not math.isfinite(resolved) or resolved <= 0.0:
        return 1
    base_overlap = max(1, int(round(_SAMPLED_BLEED_OVERLAP_MM * resolved)))
    try:
        source_mm = float(source_pixel_mm) if source_pixel_mm is not None else 0.0
        selected = int(selected_peel_px) if selected_peel_px is not None else 0
        initial = int(initial_peel_px) if initial_peel_px is not None else 0
    except (TypeError, ValueError, OverflowError):
        return base_overlap
    if (
        not math.isfinite(source_mm)
        or source_mm <= 0.0
        or selected <= initial
    ):
        return base_overlap
    fringe_overlap_mm = min(
        _SAMPLED_BLEED_FRINGE_MAX_MM,
        _SAMPLED_BLEED_FRINGE_SOURCE_PIXELS * source_mm,
    )
    # Trừ epsilon để 2 pixel nguồn đúng số nguyên không bị ceil thành 3 do sai số
    # float (72 DPI: 0,705555… mm × 2,834645… px/mm = 2 px).
    fringe_overlap_px = int(math.ceil(fringe_overlap_mm * resolved - 1e-9))
    return max(base_overlap, fringe_overlap_px)


def _edge_color_adaptive_max_mm(source_pixel_mm: float | None) -> float:
    """Độ sâu dò màu theo pixel nguồn, nhưng có chặn theo mm vật lý."""
    try:
        pixel_mm = float(source_pixel_mm) if source_pixel_mm is not None else 0.0
    except (TypeError, ValueError):
        pixel_mm = 0.0
    if not math.isfinite(pixel_mm) or pixel_mm <= 0.0:
        return _EDGE_COLOR_ADAPTIVE_BASE_MM
    return max(
        _EDGE_COLOR_ADAPTIVE_BASE_MM,
        min(
            _EDGE_COLOR_ADAPTIVE_MAX_MM,
            pixel_mm * _EDGE_COLOR_ADAPTIVE_SOURCE_PIXELS,
        ),
    )


def _axis_aligned_rectangle_bbox(
    footprint: np.ndarray,
) -> tuple[int, int, int, int] | None:
    """Trả bbox khi footprint là hình chữ nhật thẳng trục, có thể bo góc."""
    if footprint is None or footprint.ndim != 2 or footprint.size == 0:
        return None
    if footprint.dtype == np.uint8 and footprint.flags.c_contiguous:
        binary = footprint
    else:
        binary = np.ascontiguousarray(footprint > 0, dtype=np.uint8)
    contours, _ = cv2.findContours(
        binary,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    if len(contours) != 1:
        return None
    contour_area = float(cv2.contourArea(contours[0]))
    convex_area = float(cv2.contourArea(cv2.convexHull(contours[0])))
    if convex_area <= 0.0 or (
        contour_area / convex_area < _TRAJECTORY_RECT_MIN_CONVEXITY_RATIO
    ):
        return None
    x, y, width, height = (int(value) for value in cv2.boundingRect(contours[0]))
    if width < 3 or height < 3:
        return None

    local = np.zeros((height, width), dtype=np.uint8)
    shifted = contours[0].copy()
    shifted[:, 0, 0] -= x
    shifted[:, 0, 1] -= y
    cv2.drawContours(local, [shifted], -1, 255, cv2.FILLED)
    fill_ratio = float(cv2.countNonZero(local)) / float(width * height)
    if fill_ratio < _TRAJECTORY_RECT_MIN_FILL_RATIO:
        return None

    inset = max(1, min(width, height) // 4)
    horizontal_core = local[inset:height - inset, :]
    vertical_core = local[:, inset:width - inset]
    if horizontal_core.size == 0 or vertical_core.size == 0:
        return None
    horizontal_fill = float(np.count_nonzero(horizontal_core)) / horizontal_core.size
    vertical_fill = float(np.count_nonzero(vertical_core)) / vertical_core.size
    if min(horizontal_fill, vertical_fill) < _TRAJECTORY_RECT_CORE_MIN_FILL_RATIO:
        return None
    return x, y, x + width, y + height


def _sharp_bleed_join_corners(
    footprint: np.ndarray,
    *,
    transition_span_px: int,
) -> list[tuple[int, int]]:
    """Tìm các đỉnh đổi hướng mạnh để bảo vệ riêng mối nối tại góc."""
    span = max(4.0, float(transition_span_px))
    epsilon = max(2.0, span * 0.75)
    contours, _ = cv2.findContours(
        np.ascontiguousarray(footprint, dtype=np.uint8),
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_NONE,
    )
    corners: list[tuple[int, int]] = []
    for contour in contours:
        simplified = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if len(simplified) < 3:
            continue
        for index, current in enumerate(simplified):
            previous = simplified[index - 1]
            following = simplified[(index + 1) % len(simplified)]
            incoming = previous.astype(np.float64) - current
            outgoing = following.astype(np.float64) - current
            incoming_length = float(np.linalg.norm(incoming))
            outgoing_length = float(np.linalg.norm(outgoing))
            if min(incoming_length, outgoing_length) < span:
                continue
            cosine = float(
                np.clip(
                    np.dot(incoming, outgoing)
                    / (incoming_length * outgoing_length),
                    -1.0,
                    1.0,
                )
            )
            angle_degrees = math.degrees(math.acos(cosine))
            if angle_degrees <= _BLEED_JOIN_CORNER_MAX_ANGLE_DEG:
                corners.append((int(current[0]), int(current[1])))
    return corners


def _apply_bleed_join_corner_guard(
    alpha: np.ndarray,
    coverage: np.ndarray,
    footprint: np.ndarray,
    *,
    solid_overlap_px: int,
    feather_px: int,
) -> None:
    """Phủ pixel chéo tại góc mà EDT tròn bỏ sót, không nới toàn bộ chu vi."""
    solid = max(0, int(solid_overlap_px))
    feather = max(1, int(feather_px))
    transition_span = solid + feather
    if solid <= 0 or transition_span <= 1:
        return

    corners = _sharp_bleed_join_corners(
        footprint,
        transition_span_px=transition_span,
    )
    if not corners:
        return

    # QUALITY (feedback 2026-08-12 §SEAM.3): fringe raster tại góc gãy đi theo
    # cả hai trục. EDT Euclid tạo cung tròn nên bỏ sót một nêm chéo; dùng khoảng
    # cách bàn cờ và đường chéo của span chỉ trong ROI quanh đỉnh để bịt nêm mà
    # không tăng overlap ở cạnh.
    zone_radius = max(
        3,
        int(math.ceil(transition_span * _BLEED_JOIN_CORNER_ZONE_SPAN)),
    )
    corner_transition_span = int(
        math.ceil(transition_span * math.sqrt(2.0))
    )
    patch_padding = zone_radius + transition_span + 2
    height, width = footprint.shape
    for corner_x, corner_y in corners:
        x0 = max(0, corner_x - patch_padding)
        x1 = min(width, corner_x + patch_padding + 1)
        y0 = max(0, corner_y - patch_padding)
        y1 = min(height, corner_y + patch_padding + 1)
        patch_footprint = np.ascontiguousarray(
            footprint[y0:y1, x0:x1],
            dtype=np.uint8,
        )
        distance_at_corner = cv2.distanceTransform(
            patch_footprint,
            cv2.DIST_C,
            3,
        )
        transition = np.clip(
            (corner_transition_span - distance_at_corner) / float(feather),
            0.0,
            1.0,
        )
        transition = transition * transition * (3.0 - 2.0 * transition)
        candidate_alpha = np.rint(transition * 255.0).astype(np.uint8)

        yy, xx = np.ogrid[y0:y1, x0:x1]
        corner_zone = (
            (xx - corner_x) * (xx - corner_x)
            + (yy - corner_y) * (yy - corner_y)
            <= zone_radius * zone_radius
        )
        eligible = (
            corner_zone
            & coverage[y0:y1, x0:x1]
            & footprint[y0:y1, x0:x1]
        )
        patch_alpha = alpha[y0:y1, x0:x1]
        patch_alpha[eligible] = np.maximum(
            patch_alpha[eligible],
            candidate_alpha[eligible],
        )


def _build_feathered_bleed_join_mask(
    bleed_mask: np.ndarray,
    sticker_footprint: np.ndarray,
    *,
    solid_overlap_px: int,
    feather_px: int,
) -> np.ndarray:
    """Tạo alpha mềm ở mép trong của lớp bleed chồng lên artwork."""
    if (
        bleed_mask is None
        or sticker_footprint is None
        or bleed_mask.shape != sticker_footprint.shape
        or np.count_nonzero(bleed_mask) == 0
        or np.count_nonzero(sticker_footprint) == 0
    ):
        return bleed_mask.copy() if bleed_mask is not None else bleed_mask

    roi = _bleed_roi_bbox(bleed_mask)
    if roi is None:
        return bleed_mask.copy()
    y0, y1, x0, x1 = roi
    coverage = bleed_mask[y0:y1, x0:x1] > 0
    footprint = sticker_footprint[y0:y1, x0:x1] > 0
    sub_alpha = np.zeros(coverage.shape, dtype=np.uint8)
    sub_alpha[coverage & ~footprint] = 255

    solid = max(0, int(solid_overlap_px))
    feather = max(1, int(feather_px))
    distance_inside = cv2.distanceTransform(
        footprint.astype(np.uint8), cv2.DIST_L2, 5
    )
    transition = np.clip(
        (solid + feather - distance_inside) / float(feather),
        0.0,
        1.0,
    )
    transition = transition * transition * (3.0 - 2.0 * transition)
    inside = coverage & footprint
    sub_alpha[inside] = np.rint(transition[inside] * 255.0).astype(np.uint8)
    _apply_bleed_join_corner_guard(
        sub_alpha,
        coverage,
        footprint,
        solid_overlap_px=solid,
        feather_px=feather,
    )

    alpha = np.zeros_like(bleed_mask, dtype=np.uint8)
    alpha[y0:y1, x0:x1] = sub_alpha
    return alpha
