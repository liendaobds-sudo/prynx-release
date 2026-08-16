"""Dựng CutContour live từ đúng mask và fitter dùng khi xuất file."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
import math
import threading

import numpy as np
from PIL import Image

from app.core.system_memory import plan_worker_count
from app.core.sticker_sheet_session import (
    StickerSheetPageState,
    StickerSheetSession,
    StickerSheetSessionConflict,
)
from app.workers.sticker_engine import (
    ALPHA_CONTOUR_INSET_MM,
    UnsafeCutlineGeometryError,
    compute_cut_bleed_offsets,
    fit_prepared_alpha_cutline_geometry,
    prepare_alpha_cutline_geometry,
    should_presmooth_cutline_alpha,
)
from app.workers.sticker_sheet_export import (
    STICKER_PAGE_PADDING_MM,
    StickerSheetExportError,
    _build_edited_rgba,
    _cutline_export_cache_key,
    _page_session_view,
    apply_export_edits,
)


logger = logging.getLogger(__name__)

_PREVIEW_EXECUTOR: ThreadPoolExecutor | None = None
_PREVIEW_EXECUTOR_LOCK = threading.Lock()


def _preview_executor() -> ThreadPoolExecutor:
    """Pool dùng chung cho các tem độc lập, có RAM-gating và escape hatch."""
    global _PREVIEW_EXECUTOR
    if _PREVIEW_EXECUTOR is not None:
        return _PREVIEW_EXECUTOR
    with _PREVIEW_EXECUTOR_LOCK:
        if _PREVIEW_EXECUTOR is None:
            worker_count, reason = plan_worker_count(
                kind="cutline-preview",
                per_worker_mb=128.0,
                env_override="PRYNX_CUTLINE_PREVIEW_WORKERS",
            )
            # PERF (audit 2026-08-10 §CUTLINE.LIVE2): mỗi tem là geometry độc lập.
            # Pool dùng policy RAM chung: máy >=16 GB giữ CPU-1, máy yếu mới giảm.
            _PREVIEW_EXECUTOR = ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="cutline-preview",
            )
            logger.info("[CUTLINE_PREVIEW] %s", reason)
    return _PREVIEW_EXECUTOR


def _map_preview_jobs(function, items: list[object]) -> list[object]:
    if len(items) <= 1:
        return [function(item) for item in items]
    return list(_preview_executor().map(function, items))


def _number(value: float) -> str:
    rounded = round(float(value), 4)
    if abs(rounded) < 0.00005:
        rounded = 0.0
    return f"{rounded:.4f}".rstrip("0").rstrip(".") or "0"


_EXACT_ELLIPSE_KAPPA = 0.5522847498307936


def _exact_offset_points(
    *,
    cut_mode: str,
    offset_mm: float,
    bleed_mm: float,
) -> float | None:
    """Tính một lần vị trí dao từ đúng policy đang dùng cho contour raster."""
    if str(cut_mode or "original").strip().lower() == "none":
        return None
    try:
        offset_value = float(offset_mm)
        bleed_value = float(bleed_mm)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(offset_value) or not math.isfinite(bleed_value):
        return None
    effective_offset_mm = offset_value - (
        ALPHA_CONTOUR_INSET_MM if cut_mode == "alpha" else 0.0
    )
    total_offset_pts, _outer_offset_pts = compute_cut_bleed_offsets(
        str(cut_mode or "original").strip().lower(),
        max(0.0, bleed_value) * 72.0 / 25.4,
        effective_offset_mm * 72.0 / 25.4,
    )
    return float(total_offset_pts)


def _shape_coordinate_unit(shape: dict[str, object]) -> str:
    unit = str(shape.get("coordinate_unit", "px")).strip().lower()
    return "pt" if unit == "pt" else "px"


def _global_shape_point_to_local(
    point: object,
    *,
    unit: str,
    left_px: int,
    top_px: int,
    dpi_x: float,
    dpi_y: float,
) -> tuple[float, float] | None:
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        return None
    try:
        x, y = float(point[0]), float(point[1])
    except (TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(value) for value in (x, y)):
        return None
    if unit == "pt":
        local = (
            x - float(left_px) * 72.0 / dpi_x,
            y - float(top_px) * 72.0 / dpi_y,
        )
    else:
        local = (
            (x - float(left_px)) * 72.0 / dpi_x,
            (y - float(top_px)) * 72.0 / dpi_y,
        )
    return local if all(math.isfinite(value) for value in local) else None


def _local_shape_params(
    shape: dict[str, object],
    *,
    left_px: int,
    top_px: int,
    dpi_x: float,
    dpi_y: float,
) -> dict[str, float] | None:
    raw_params = shape.get("params")
    params = raw_params if isinstance(raw_params, dict) else {}
    unit = _shape_coordinate_unit(shape)
    try:
        if unit == "pt":
            cx = float(params["cx"])
            cy = float(params["cy"])
            local_cx = cx - float(left_px) * 72.0 / dpi_x
            local_cy = cy - float(top_px) * 72.0 / dpi_y
            result = {"cx": local_cx, "cy": local_cy}
            for key in ("r", "a", "b", "w", "h", "angle"):
                if key in params:
                    result[key] = float(params[key])
            return result
        # Tương thích manifest tạm của bản thử nghiệm trước khi schema point được chốt.
        if "center_x_px" in shape:
            result = {
                "cx": (float(shape["center_x_px"]) - left_px) * 72.0 / dpi_x,
                "cy": (float(shape["center_y_px"]) - top_px) * 72.0 / dpi_y,
                "r": float(shape["radius_px"]) * 72.0 / dpi_x,
                "radius_y": float(shape["radius_px"]) * 72.0 / dpi_y,
            }
            return result
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    return None


def _rotated_point(
    cx: float,
    cy: float,
    x: float,
    y: float,
    angle_degrees: float,
) -> tuple[float, float]:
    angle = math.radians(angle_degrees)
    cosine = math.cos(angle)
    sine = math.sin(angle)
    return (
        cx + x * cosine - y * sine,
        cy + x * sine + y * cosine,
    )


def _ellipse_path_segments(
    *,
    cx: float,
    cy: float,
    radius_x: float,
    radius_y: float,
    angle_degrees: float = 0.0,
) -> list[tuple[tuple[float, float], ...]] | None:
    if min(radius_x, radius_y) <= 0 or not all(math.isfinite(value) for value in (
        cx, cy, radius_x, radius_y, angle_degrees,
    )):
        return None

    def point(x: float, y: float) -> tuple[float, float]:
        return _rotated_point(cx, cy, x, y, angle_degrees)

    def tangent(x: float, y: float) -> tuple[float, float]:
        return _rotated_point(0.0, 0.0, x, y, angle_degrees)

    segments: list[tuple[tuple[float, float], ...]] = []
    for quadrant in range(4):
        start_angle = quadrant * math.pi / 2.0
        end_angle = start_angle + math.pi / 2.0
        start = point(radius_x * math.cos(start_angle), radius_y * math.sin(start_angle))
        end = point(radius_x * math.cos(end_angle), radius_y * math.sin(end_angle))
        start_tangent = tangent(
            -radius_x * math.sin(start_angle) * _EXACT_ELLIPSE_KAPPA,
            radius_y * math.cos(start_angle) * _EXACT_ELLIPSE_KAPPA,
        )
        end_tangent = tangent(
            -radius_x * math.sin(end_angle) * _EXACT_ELLIPSE_KAPPA,
            radius_y * math.cos(end_angle) * _EXACT_ELLIPSE_KAPPA,
        )
        segments.append((
            start,
            (start[0] + start_tangent[0], start[1] + start_tangent[1]),
            (end[0] - end_tangent[0], end[1] - end_tangent[1]),
            end,
        ))
    return segments


def _line_path_segments(points: list[tuple[float, float]]) -> list[tuple[tuple[float, float], ...]]:
    if len(points) < 3:
        return []
    return [
        (start, start, end, end)
        for index, start in enumerate(points)
        for end in [points[(index + 1) % len(points)]]
    ]


def _polygon_shape_path_groups(
    shape: dict[str, object],
    *,
    left_px: int,
    top_px: int,
    dpi: float,
    dpi_y: float,
    total_offset_pts: float,
    corner_style: str,
) -> list[dict[str, object]] | None:
    raw_coords = shape.get("coords")
    if not isinstance(raw_coords, (list, tuple)):
        return None
    unit = _shape_coordinate_unit(shape)
    dpi_x = float(dpi)
    dpi_y_resolved = float(dpi_y)
    points = []
    for raw_point in raw_coords:
        point = _global_shape_point_to_local(
            raw_point,
            unit=unit,
            left_px=left_px,
            top_px=top_px,
            dpi_x=dpi_x,
            dpi_y=dpi_y_resolved,
        )
        if point is None:
            return None
        points.append(point)
    if len(points) < 3:
        return None
    if abs(total_offset_pts) > 1e-9:
        try:
            from shapely.geometry import MultiPolygon, Polygon

            polygon = Polygon(points)
            if polygon.is_empty or not polygon.is_valid:
                polygon = polygon.buffer(0)
            join_style = 1 if str(corner_style).strip().lower() == "round" else 2
            polygon = polygon.buffer(total_offset_pts, join_style=join_style)
            if polygon.is_empty:
                return None
            if isinstance(polygon, MultiPolygon):
                polygon = max(polygon.geoms, key=lambda item: item.area)
            points = [(float(x), float(y)) for x, y in polygon.exterior.coords[:-1]]
        except (ImportError, ValueError, TypeError):
            return None
    segments = _line_path_segments(points)
    return [{"exterior": segments, "interiors": []}] if segments else None


def _exact_shape_path_groups(
    shape: dict[str, object],
    *,
    left_px: int,
    top_px: int,
    dpi: float,
    dpi_y: float,
    cut_mode: str,
    offset_mm: float,
    bleed_mm: float,
    corner_style: str,
) -> list[dict[str, object]] | None:
    """Dựng đường bế từ hình chuẩn, không quay lại contour pixel."""
    total_offset_pts = _exact_offset_points(
        cut_mode=cut_mode,
        offset_mm=offset_mm,
        bleed_mm=bleed_mm,
    )
    if total_offset_pts is None:
        return [] if str(cut_mode or "").strip().lower() == "none" else None
    try:
        dpi_x = float(dpi)
        dpi_y_resolved = float(dpi_y)
    except (TypeError, ValueError):
        return None
    if min(dpi_x, dpi_y_resolved) <= 0 or not all(
        math.isfinite(value) for value in (dpi_x, dpi_y_resolved, total_offset_pts)
    ):
        return None
    kind = str(shape.get("kind", "")).strip().lower()
    if kind in {"circle", "ellipse"}:
        params = _local_shape_params(
            shape,
            left_px=left_px,
            top_px=top_px,
            dpi_x=dpi_x,
            dpi_y=dpi_y_resolved,
        )
        if params is None:
            return None
        try:
            if kind == "circle":
                radius_x = float(params.get("r", 0.0)) + total_offset_pts
                radius_y = float(params.get("radius_y", params.get("r", 0.0))) + total_offset_pts
                angle = 0.0
            else:
                radius_x = float(params["a"]) + total_offset_pts
                radius_y = float(params["b"]) + total_offset_pts
                angle = float(params.get("angle", 0.0))
            segments = _ellipse_path_segments(
                cx=float(params["cx"]),
                cy=float(params["cy"]),
                radius_x=radius_x,
                radius_y=radius_y,
                angle_degrees=angle,
            )
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        return [{"exterior": segments, "interiors": []}] if segments else None
    if kind == "rounded_rect":
        # Rounded-rect có thể dùng polygon exact ở mọi DPI; fallback này vẫn bỏ hẳn
        # marching-squares nên không còn bậc thang của mask.
        return _polygon_shape_path_groups(
            shape,
            left_px=left_px,
            top_px=top_px,
            dpi=dpi_x,
            dpi_y=dpi_y_resolved,
            total_offset_pts=total_offset_pts,
            corner_style=corner_style,
        )
    if kind in {"rect", "triangle"}:
        return _polygon_shape_path_groups(
            shape,
            left_px=left_px,
            top_px=top_px,
            dpi=dpi_x,
            dpi_y=dpi_y_resolved,
            total_offset_pts=total_offset_pts,
            corner_style=corner_style,
        )
    return None


def _exact_shapes_by_instance(
    page: StickerSheetPageState,
    edits: list[dict[str, object]],
) -> dict[int, dict[str, object]]:
    """Lấy hình học chuẩn; sau khi sửa mask thì quay về fit theo mask."""
    if edits:
        return {}
    reference = page.manifest.get("vector_geometry_ref")
    if not isinstance(reference, dict):
        return {}
    raw_shapes = reference.get("exact_shapes")
    if not isinstance(raw_shapes, list):
        return {}
    shapes: dict[int, dict[str, object]] = {}
    for raw_shape in raw_shapes:
        if not isinstance(raw_shape, dict):
            continue
        try:
            instance_id = int(raw_shape["instance_id"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if raw_shape.get("kind") in {"circle", "ellipse", "rounded_rect", "rect", "triangle"}:
            shapes[instance_id] = raw_shape
    return shapes


def _ring_svg_path(
    segments,
    *,
    left_px: int,
    top_px: int,
    dpi: float,
    dpi_y: float,
    scale_x: float,
    scale_y: float,
) -> str:
    if not segments:
        return ""

    def transform(point) -> tuple[float, float]:
        x = (float(point[0]) * dpi / 72.0 + left_px) * scale_x
        y = (float(point[1]) * dpi_y / 72.0 + top_px) * scale_y
        return x, y

    start_x, start_y = transform(segments[0][0])
    commands = [f"M {_number(start_x)} {_number(start_y)}"]
    for _start, control1, control2, end in segments:
        c1x, c1y = transform(control1)
        c2x, c2y = transform(control2)
        end_x, end_y = transform(end)
        commands.append(
            "C "
            f"{_number(c1x)} {_number(c1y)} "
            f"{_number(c2x)} {_number(c2y)} "
            f"{_number(end_x)} {_number(end_y)}"
        )
    commands.append("Z")
    return " ".join(commands)


def _aggregate_cutline_quality(items: list[dict[str, object]]) -> dict[str, object]:
    """Gộp số đo từng tem; min/max luôn là số đo xấu nhất cần người dùng thấy."""
    if not items:
        return {
            "machine_safe": True,
            "segment_count": 0,
            "short_segment_count": 0,
            "disconnected_join_count": 0,
            "unprotected_join_count": 0,
            "protected_corner_count": 0,
            "dropped_component_count": 0,
            "minimum_segment_length_mm": None,
            "maximum_join_angle_degrees": None,
            "effective_deviation_mm": 0.0,
            "fit_mode": "disabled",
            "trajectory_cusp_count": 0,
            "unprotected_cusp_count": 0,
            "maximum_trajectory_turn_degrees": None,
            "minimum_wedge_width_mm": None,
            "cutline_hook_tolerated": False,
        }
    modes = {str(item.get("fit_mode", "unknown")) for item in items}
    minimum_lengths = [
        float(item["minimum_segment_length_mm"])
        for item in items
        if item.get("minimum_segment_length_mm") is not None
    ]
    maximum_angles = [
        float(item["maximum_join_angle_degrees"])
        for item in items
        if item.get("maximum_join_angle_degrees") is not None
    ]
    deviations = [
        float(item["effective_deviation_mm"])
        for item in items
        if item.get("effective_deviation_mm") is not None
    ]
    # §CUTHOOK.1: góc quay lấy MAX (xấu nhất), bề rộng nêm lấy MIN (hẹp nhất).
    trajectory_turns = [
        float(item["maximum_trajectory_turn_degrees"])
        for item in items
        if item.get("maximum_trajectory_turn_degrees") is not None
    ]
    wedge_widths = [
        float(item["minimum_wedge_width_mm"])
        for item in items
        if item.get("minimum_wedge_width_mm") is not None
    ]
    return {
        "machine_safe": all(bool(item.get("machine_safe")) for item in items),
        "segment_count": sum(int(item.get("segment_count", 0)) for item in items),
        "short_segment_count": sum(
            int(item.get("short_segment_count", 0)) for item in items
        ),
        "disconnected_join_count": sum(
            int(item.get("disconnected_join_count", 0)) for item in items
        ),
        "unprotected_join_count": sum(
            int(item.get("unprotected_join_count", 0)) for item in items
        ),
        "protected_corner_count": sum(
            int(item.get("protected_corner_count", 0)) for item in items
        ),
        "dropped_component_count": sum(
            int(item.get("dropped_component_count", 0)) for item in items
        ),
        "minimum_segment_length_mm": min(minimum_lengths, default=None),
        "maximum_join_angle_degrees": max(maximum_angles, default=None),
        "effective_deviation_mm": max(deviations, default=None),
        "fit_mode": next(iter(modes)) if len(modes) == 1 else "mixed",
        "trajectory_cusp_count": sum(
            int(item.get("trajectory_cusp_count", 0)) for item in items
        ),
        "unprotected_cusp_count": sum(
            int(item.get("unprotected_cusp_count", 0)) for item in items
        ),
        "maximum_trajectory_turn_degrees": max(trajectory_turns, default=None),
        "minimum_wedge_width_mm": min(wedge_widths, default=None),
        "cutline_hook_tolerated": any(
            bool(item.get("cutline_hook_tolerated")) for item in items
        ),
    }


def build_sticker_cutline_preview(
    session: StickerSheetSession,
    *,
    page_number: int,
    base_revision: int,
    edits: list[dict[str, object]],
    dpi: float,
    dpi_y: float | None,
    offset_mm: float,
    bleed_mm: float,
    cut_mode: str,
    corner_style: str,
    fill_holes: bool,
    cutline_smoothness: float,
    cutline_fidelity: float,
    curve_tension: float,
    min_detail_area_mm2: float,
    # §CUTJAG.3: None = để cổng tự động theo nguồn biên quyết định.
    cutline_denoise: float | None = None,
) -> dict[str, object]:
    """Trả SVG path theo hệ preview; không ghi hay thay revision của session."""
    page = session.pages.get(page_number)
    if page is None:
        raise StickerSheetSessionConflict("Trang nguồn để xem đường bế không tồn tại.")

    with page.operation_lock:
        if page.stage not in {"mask-review", "mask-ready"}:
            raise StickerSheetSessionConflict(
                "Vùng tem chưa sẵn sàng để xem đường bế."
            )
        revision = int(page.manifest.get("mask_revision", 0))
        if revision != int(base_revision):
            raise StickerSheetSessionConflict(
                "Bản xem trước đã thay đổi. Hãy chờ đường bế mới cập nhật."
            )
        labels_path = page.directory / "labels.npy"
        rgba_path = page.directory / "rgba.png"
        if not labels_path.is_file() or not rgba_path.is_file():
            raise StickerSheetSessionConflict(
                "Dữ liệu vùng tem không còn đầy đủ. Hãy nhận diện lại ảnh."
            )
        try:
            dpi_x = float(dpi)
            dpi_y_resolved = float(dpi_y if dpi_y is not None else dpi)
        except (TypeError, ValueError) as exc:
            raise StickerSheetExportError("Độ phân giải ảnh không hợp lệ.") from exc
        if (
            not math.isfinite(dpi_x)
            or not math.isfinite(dpi_y_resolved)
            or dpi_x <= 0
            or dpi_y_resolved <= 0
        ):
            raise StickerSheetExportError("Độ phân giải ảnh không hợp lệ.")

        preview_width = int(page.preview_width_px)
        preview_height = int(page.preview_height_px)
        exact_shapes = _exact_shapes_by_instance(page, edits)
        # QUALITY (feedback 2026-08-16 §CUTJAG.1): mask AI/dò nền là mask nhị phân
        # hoá từ điểm ảnh nên cần khử răng cưa dưới một pixel trước khi lấy contour.
        presmooth_alpha = should_presmooth_cutline_alpha(page.boundary_source)
        # §CUTJAG.3: thanh kéo thắng cổng tự động. Người dùng kéo về 0 nghĩa là TẮT
        # hẳn, nên phải phân biệt `0.0` với "không gửi field" (`None`).
        denoise_amount = 0.0
        if cutline_denoise is None:
            denoise_amount = 0.0
        else:
            try:
                denoise_amount = max(0.0, min(100.0, float(cutline_denoise)))
            except (TypeError, ValueError):
                denoise_amount = 0.0
            presmooth_alpha = False
        geometry_key_payload = {
            "page": page_number,
            "revision": revision,
            "edits": edits,
            "dpi": dpi_x,
            "dpi_y": dpi_y_resolved,
            "offset_mm": offset_mm,
            "bleed_mm": bleed_mm,
            "cut_mode": cut_mode,
            "corner_style": corner_style,
            "fill_holes": fill_holes,
            "min_detail_area_mm2": min_detail_area_mm2,
            "exact_shapes": exact_shapes,
            "presmooth_alpha": presmooth_alpha,
            "cutline_denoise": denoise_amount,
        }
        geometry_key = hashlib.sha256(json.dumps(
            geometry_key_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        with session.operation_lock:
            cached = getattr(session, "_cutline_preview_geometry_cache", None)
        if isinstance(cached, dict) and cached.get("key") == geometry_key:
            analysis_width = int(cached["analysis_width"])
            analysis_height = int(cached["analysis_height"])
            prepared_instances = list(cached["instances"])
        else:
            original_labels = np.load(labels_path, allow_pickle=False)
            valid_ids = {
                int(instance["id"])
                for instance in page.manifest.get("instances", [])
            }
            labels = apply_export_edits(original_labels, edits, valid_ids)
            page_view = _page_session_view(session, page)
            rgba = _build_edited_rgba(page_view, original_labels, labels)
            analysis_height, analysis_width = labels.shape
            padding_x = max(
                1,
                round(STICKER_PAGE_PADDING_MM * dpi_x / 25.4),
            )
            padding_y = max(
                1,
                round(STICKER_PAGE_PADDING_MM * dpi_y_resolved / 25.4),
            )
            prepare_jobs = []
            instance_ids = sorted(
                int(value) for value in np.unique(labels) if int(value) > 0
            )
            for instance_id in instance_ids:
                ys, xs = np.where(labels == instance_id)
                if xs.size == 0:
                    continue
                left = max(0, int(xs.min()) - padding_x)
                top = max(0, int(ys.min()) - padding_y)
                right = min(
                    analysis_width,
                    int(xs.max()) + padding_x + 1,
                )
                bottom = min(
                    analysis_height,
                    int(ys.max()) + padding_y + 1,
                )
                exact_shape = exact_shapes.get(instance_id)
                if exact_shape is not None:
                    prepare_jobs.append((instance_id, left, top, None, exact_shape))
                    continue
                local_mask = labels[top:bottom, left:right] == instance_id
                alpha = rgba[top:bottom, left:right, 3].copy()
                alpha[~local_mask] = 0
                prepare_jobs.append((instance_id, left, top, alpha, None))

            def prepare_instance(item):
                instance_id, left, top, alpha, exact_shape = item
                if exact_shape is not None:
                    return instance_id, left, top, {"exact_shape": exact_shape}
                prepared = prepare_alpha_cutline_geometry(
                    alpha,
                    dpi=dpi_x,
                    dpi_y=dpi_y_resolved,
                    cut_mode=cut_mode,
                    offset_mm=offset_mm,
                    bleed_mm=bleed_mm,
                    corner_style=corner_style,
                    fill_holes=fill_holes,
                    min_detail_area_mm2=min_detail_area_mm2,
                    presmooth_alpha=presmooth_alpha,
                    cutline_denoise=denoise_amount,
                )
                if prepared is None:
                    raise StickerSheetExportError(
                        f"Không chuẩn bị được đường bế xem trước cho tem {instance_id}."
                    )
                return instance_id, left, top, prepared

            prepared_instances = _map_preview_jobs(
                prepare_instance,
                prepare_jobs,
            )
            # PERF (audit 2026-08-10 §CUTLINE.LIVE3): chỉ giữ working-set mới nhất
            # của một session; đổi trang/revision/edit/offset sẽ thay cache, không
            # tích lũy vô hạn theo số lần kéo slider.
            with session.operation_lock:
                setattr(session, "_cutline_preview_geometry_cache", {
                    "key": geometry_key,
                    "analysis_width": analysis_width,
                    "analysis_height": analysis_height,
                    "instances": prepared_instances,
                })

        scale_x = preview_width / max(1, analysis_width)
        scale_y = preview_height / max(1, analysis_height)
        def fit_instance(item):
            instance_id, left, top, prepared = item
            exact_shape = prepared.get("exact_shape")
            if isinstance(exact_shape, dict):
                path_groups = _exact_shape_path_groups(
                    exact_shape,
                    left_px=left,
                    top_px=top,
                    dpi=dpi_x,
                    dpi_y=dpi_y_resolved,
                    cut_mode=cut_mode,
                    offset_mm=offset_mm,
                    bleed_mm=bleed_mm,
                    corner_style=corner_style,
                )
                if path_groups is None:
                    raise StickerSheetExportError(
                        f"Không tạo được đường bế hình học cho tem {instance_id}."
                    )
                exact_segment_count = sum(
                    len(ring)
                    for group in path_groups
                    for ring in [group["exterior"], *(group.get("interiors") or [])]
                )
                cutline = {
                    "path_groups": path_groups,
                    "quality": {
                        "machine_safe": True,
                        "segment_count": exact_segment_count,
                        "short_segment_count": 0,
                        "disconnected_join_count": 0,
                        "unprotected_join_count": 0,
                        "protected_corner_count": 0,
                        "dropped_component_count": 0,
                        "minimum_segment_length_mm": None,
                        "maximum_join_angle_degrees": 0.0,
                        "effective_deviation_mm": 0.0,
                        "fit_mode": "disabled" if not path_groups else "exact-geometry",
                    },
                }
            else:
                try:
                    cutline = fit_prepared_alpha_cutline_geometry(
                        prepared,
                        cutline_smoothness=cutline_smoothness,
                        cutline_fidelity=cutline_fidelity,
                        curve_tension=curve_tension,
                    )
                except UnsafeCutlineGeometryError as exc:
                    # QUALITY (audit 2026-08-10 §CUTSMOOTH.4): đổi lỗi hình học thành
                    # lỗi nghiệp vụ 422, không để route báo 500 khó hiểu.
                    raise StickerSheetExportError(
                        f"Tem {instance_id}: {exc}"
                    ) from exc
                if cutline is None:
                    raise StickerSheetExportError(
                        f"Không tạo được đường bế xem trước cho tem {instance_id}."
                    )
            path_groups = cutline["path_groups"]
            if not path_groups:
                return None
            path_parts = []
            segment_count = 0
            for group in path_groups:
                rings = [group["exterior"], *(group.get("interiors") or [])]
                for ring in rings:
                    path_parts.append(_ring_svg_path(
                        ring,
                        left_px=left,
                        top_px=top,
                        dpi=dpi_x,
                        dpi_y=dpi_y_resolved,
                        scale_x=scale_x,
                        scale_y=scale_y,
                    ))
                    segment_count += len(ring)
            quality = dict(cutline.get("quality") or {})
            return (
                {
                    "instance_id": instance_id,
                    "d": " ".join(part for part in path_parts if part),
                    "segment_count": segment_count,
                    "quality": quality,
                },
                {
                    "instance_id": instance_id,
                    "left": left,
                    "top": top,
                    "path_groups": path_groups,
                },
                segment_count,
                quality,
            )

        response_paths = []
        fingerprint_paths = []
        quality_items = []
        total_segments = 0
        for fitted in _map_preview_jobs(fit_instance, prepared_instances):
            if fitted is None:
                continue
            response_path, fingerprint_path, segment_count, quality = fitted
            response_paths.append(response_path)
            fingerprint_paths.append(fingerprint_path)
            quality_items.append(quality)
            total_segments += segment_count

        fingerprint_payload = {
            "page": page_number,
            "revision": revision,
            "dpi": dpi_x,
            "dpi_y": dpi_y_resolved,
            "offset_mm": offset_mm,
            "bleed_mm": bleed_mm,
            "cut_mode": cut_mode,
            "corner_style": corner_style,
            "fill_holes": fill_holes,
            "cutline_smoothness": cutline_smoothness,
            "cutline_fidelity": cutline_fidelity,
            "curve_tension": curve_tension,
            "min_detail_area_mm2": min_detail_area_mm2,
            "paths": fingerprint_paths,
        }
        fingerprint = hashlib.sha256(json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        # PERF (audit 2026-08-10 §CUTLINE.EXPORT4): export dùng đúng Bézier vừa
        # hiện trên màn hình. Cache chỉ có một bản mới nhất/trang và khóa bao phủ
        # toàn bộ revision, edit, DPI cùng các tham số quỹ đạo.
        page.cutline_export_cache = {
            "key": _cutline_export_cache_key(
                page_number=page_number,
                revision=revision,
                edits=edits,
                dpi=dpi_x,
                dpi_y=dpi_y_resolved,
                offset_mm=offset_mm,
                bleed_mm=bleed_mm,
                cut_mode=cut_mode,
                corner_style=corner_style,
                fill_holes=fill_holes,
                cutline_smoothness=cutline_smoothness,
                cutline_fidelity=cutline_fidelity,
                curve_tension=curve_tension,
                min_detail_area_mm2=min_detail_area_mm2,
            ),
            "analysis_width": analysis_width,
            "analysis_height": analysis_height,
            "instances": fingerprint_paths,
        }
        return {
            "page_number": page_number,
            "mask_revision": revision,
            "preview_width_px": preview_width,
            "preview_height_px": preview_height,
            "paths": response_paths,
            "fingerprint": fingerprint,
            "segment_count": total_segments,
            "quality": _aggregate_cutline_quality(quality_items),
        }
