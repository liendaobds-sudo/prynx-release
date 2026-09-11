"""Dựng CutContour live từ đúng mask và fitter dùng khi xuất file."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from copy import deepcopy
import hashlib
import json
import logging
import math
import threading

import cv2
import numpy as np
from PIL import Image

from app.core.system_memory import plan_worker_count, read_memory_status_mb
from app.workers.cutline_preview_cancel import check_preview_cancelled
from app.core.sticker_sheet_session import (
    StickerSheetPageState,
    StickerSheetSession,
    StickerSheetSessionConflict,
)
from app.workers.sticker_engine import (
    ALPHA_CONTOUR_INSET_MM,
    UnsafeCutlineGeometryError,
    _analytic_fillet_short_line_count,
    _alpha_live_machine_path_summary,
    _cutline_round_radius_mm,
    compute_cut_bleed_offsets,
    fit_prepared_alpha_cutline_geometry,
    simplify_alpha_cutline_result,
    prepare_alpha_cutline_geometry,
    should_presmooth_cutline_alpha,
)
from app.workers.cutline_geometry import build_filleted_polygon_beziers
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

# QUALITY (audit 2026-08-20 §CUTLINE.EDGE): mask composite đã loại offset trắng
# và bóng lệch thì biên thật đã đủ chi tiết; fidelity mặc định 50 làm fitter giản
# lược thành các đoạn dài, nhìn thành góc gãy. Chỉ nâng cổng cho marker này để các
# nguồn thường vẫn giữ đúng thanh kéo và thời gian xử lý cũ.
_COMPOSITE_CUTLINE_FIDELITY_MIN = 95.0
_COMPOSITE_CUTLINE_WARNINGS = frozenset({
    "simple-bg-composite-recovered",
    "simple-bg-drop-shadow-removed",
})
_CUTLINE_ALPHA_FRINGE_PX = 2
# QUALITY (audit 2026-08-21 §RECOGNITION-GUARD.4): nếu preview một-tem đã
# chứng minh mask simple-bg bị răng cưa, không bắt người dùng chờ mô hình nặng.
# Mức 70 là mức đầu tiên trên file `tải xuống.jpg` đưa quỹ đạo
# từ 2–5 cusp/123–150° về 0 cusp, 82–141 đoạn và ~2,6 giây. Chỉ marker hẹp này
# mới được nâng sàn; mọi nguồn/multi-sticker và giá trị cao hơn của người dùng
# giữ nguyên.
_ROUGH_SIMPLE_BG_DENOISE_WARNING = "simple-bg-preview-denoise-fallback"
_ROUGH_SIMPLE_BG_DENOISE_MIN = 70.0


def _effective_cutline_fidelity(
    requested: float | int | None,
    warnings: object,
) -> float:
    """Tăng fidelity có điều kiện cho mask đã qua phục hồi offset/bóng."""
    try:
        value = float(requested if requested is not None else 50.0)
    except (TypeError, ValueError):
        value = 50.0
    if not math.isfinite(value):
        value = 50.0
    try:
        warning_set = {str(item) for item in (warnings or ())}
    except TypeError:
        warning_set = set()
    if warning_set.intersection(_COMPOSITE_CUTLINE_WARNINGS):
        return max(value, _COMPOSITE_CUTLINE_FIDELITY_MIN)
    return value


def _effective_composite_curve_tension(
    requested: float | int | None,
    corner_style: str,
    warnings: object,
) -> float:
    """Không bo ngầm biên composite khi người dùng đang giữ góc gốc."""
    try:
        value = float(requested if requested is not None else 50.0)
    except (TypeError, ValueError):
        value = 50.0
    if not math.isfinite(value):
        value = 50.0
    try:
        warning_set = {str(item) for item in (warnings or ())}
    except TypeError:
        warning_set = set()
    if (
        warning_set.intersection(_COMPOSITE_CUTLINE_WARNINGS)
        and str(corner_style).strip().lower() != "round"
    ):
        # QUALITY (audit 2026-08-20 §CUTLINE.EDGE): profile precision của
        # composite phải bám mép trắng thật, không tái áp bán kính 1,5 mm vào
        # mấu tự do chỉ vì route cũ gửi tension mặc định 50.
        return 0.0
    return value


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
    check_preview_cancelled()
    if len(items) <= 1:
        return [function(item) for item in items]
    # PERF (audit 2026-09-11 §PREWARM.CANCEL): mỗi task cần context riêng;
    # cùng một Context không thể chạy đồng thời. Đợi các task thực sự dừng
    # trước khi caller được phép đóng token dùng chung với process.
    futures = [_preview_executor().submit(copy_context().run, function, item) for item in items]
    try:
        return [future.result() for future in futures]
    except BaseException:
        for future in futures:
            future.cancel()
        for future in futures:
            try:
                future.result()
            except BaseException:
                pass
        raise


def _number(value: float) -> str:
    rounded = round(float(value), 4)
    if abs(rounded) < 0.00005:
        rounded = 0.0
    return f"{rounded:.4f}".rstrip("0").rstrip(".") or "0"


def _preview_fit_cache_key(
    *,
    geometry_key: str,
    cutline_smoothness: float,
    requested_cutline_fidelity: float,
    requested_curve_tension: float,
    requested_cutline_denoise: float | None,
    effective_cutline_fidelity: float,
    effective_curve_tension: float,
    cutline_simplify_mm: float,
    simplify_height: float,
    source_kind: str,
    preview_size: tuple[int, int] = (0, 0),
) -> str:
    """Khóa tầng fit/Simplify, tách khỏi contour nền đã chuẩn bị.

    PERF (audit 2026-09-11 §SIMPLIFY.CACHE): offset/bleed/denoise và mask nằm
    trong ``geometry_key``; các thanh chỉ tác động lên Bézier/Simplify dùng
    lại đúng working-set đó. Phiên bản thuật toán vẫn nằm trong khóa để không
    trộn frame cũ sau khi nâng cấp lõi.
    """
    from app.workers.cutline_cubic_simplify import CUTLINE_SIMPLIFY_ALGORITHM

    payload = {
        "geometry_key": geometry_key,
        "cutline_smoothness": float(cutline_smoothness),
        # Giữ cả giá trị người dùng gửi: composite có thể nâng fidelity/
        # hạ tension nội bộ nhưng fingerprint/export key vẫn phải phân biệt
        # hai lựa chọn khác nhau.
        "requested_cutline_fidelity": float(requested_cutline_fidelity),
        "requested_curve_tension": float(requested_curve_tension),
        "requested_cutline_denoise": (
            None if requested_cutline_denoise is None
            else float(requested_cutline_denoise)
        ),
        "effective_cutline_fidelity": float(effective_cutline_fidelity),
        "effective_curve_tension": float(effective_curve_tension),
        "cutline_simplify_mm": float(cutline_simplify_mm),
        "simplify_height": float(simplify_height),
        "source_kind": str(source_kind),
        "preview_size": preview_size,
        "algorithm": CUTLINE_SIMPLIFY_ALGORITHM,
    }
    return hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()


def _preview_cache_limit():
    """Chỉ thu hẹp baseline tùy chọn trên máy yếu; >=16 GB giữ đầy đủ."""
    total_mb, _available_mb = read_memory_status_mb()
    if total_mb is not None and total_mb < 8 * 1024:
        return 2
    if total_mb is not None and total_mb < 16 * 1024:
        return 8
    return None


def _remember_preview(entries, key, value, limit):
    """LRU theo RAM, không giảm số node, dung sai hay công suất worker."""
    entries.pop(key, None)
    entries[key] = value
    if limit is not None:
        while len(entries) > limit:
            entries.pop(next(iter(entries)))


def _preview_source_key(session, page):
    """Ràng cache với byte nguồn/mask, không tin riêng đường dẫn hoặc mtime.

    PERF (audit 2026-09-11 §SIMPLIFY.CACHE): digest dùng luồng đọc, không giữ
    thêm raster; sửa file nhưng giữ mtime/size cũng không nhận lại CUT cũ.
    """
    digests = []
    for path in (session.source_path, page.directory / "labels.npy", page.directory / "rgba.png"):
        with open(path, "rb") as stream:
            digests.append(hashlib.file_digest(stream, "sha256").hexdigest())
    return hashlib.sha256(json.dumps({
        "digests": digests, "page": page.page_number,
        "revision": page.manifest.get("mask_revision"),
        "boundary_source": page.boundary_source,
    }, sort_keys=True).encode()).hexdigest()


def restore_preview_history(session, page, fingerprint):
    """Chọn frame đã xem khi UI quay về A nhưng request B đã xong sau đó.

    Chỉ phục hồi artifact còn trong RAM, đúng nguồn/revision. Builder dùng
    lại path đã kiểm và gắn Alpha qua luồng cũ; không nhận path từ client.
    Caller vẫn kiểm toàn bộ thiết lập và fingerprint trước khi xuất.
    """
    history = getattr(page, "cutline_preview_fit_cache", None)
    if not isinstance(history, dict) or history.get("source_key") != _preview_source_key(session, page):
        return None
    for frame in list(history.get("entries", {}).values()):
        if frame.get("response", {}).get("fingerprint") == fingerprint:
            response = build_sticker_cutline_preview(session, **deepcopy(frame["options"]))
            return page.cutline_export_cache if response["fingerprint"] == fingerprint else None
    return None


def _cache_instances_without_alpha(instances):
    """Bỏ buffer Alpha lớn trước khi lưu frame phụ trong RAM."""
    return [
        deepcopy({key: value for key, value in instance.items() if key != "alpha"})
        for instance in instances
    ]


def _restore_cached_instances(instances, prepared_instances):
    """Gắn lại Alpha từ contour working-set cho cache export canonical."""
    if not isinstance(instances, (list, tuple)):
        return None
    alpha_by_id = {
        int(item[0]): item
        for item in prepared_instances
    }
    restored = []
    for raw in instances:
        if not isinstance(raw, dict):
            return None
        try:
            instance_id = int(raw["instance_id"])
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        prepared = alpha_by_id.get(instance_id)
        if prepared is None or (raw.get("left"), raw.get("top")) != (prepared[1], prepared[2]):
            return None
        alpha = np.ascontiguousarray(prepared[4], dtype=np.uint8)
        if hashlib.sha256(alpha.tobytes(order="C")).hexdigest() != raw.get("alpha_sha256"):
            return None
        item = deepcopy(raw)
        # Chỉ frame active có Alpha riêng; lịch sử không giữ raster. Consumer
        # xuất sửa buffer này cũng không được làm hỏng working-set của fitter.
        item["alpha"] = alpha.copy()
        restored.append(item)
    return restored


_EXACT_ELLIPSE_KAPPA = 0.5522847498307936
_PT_PER_MM = 72.0 / 25.4


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


def _polygon_shape_path_groups(
    shape: dict[str, object],
    *,
    left_px: int,
    top_px: int,
    dpi: float,
    dpi_y: float,
    total_offset_pts: float,
    corner_style: str,
    curve_tension: float,
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
            # Offset miter tạo đúng polygon chuẩn; fillet có bán kính chủ đích
            # được dựng bằng cubic ở dưới, không lấy 64 chord của Shapely Round.
            polygon = polygon.buffer(
                total_offset_pts,
                join_style=2,
                mitre_limit=100.0,
            )
            if polygon.is_empty:
                return None
            if isinstance(polygon, MultiPolygon):
                polygon = max(polygon.geoms, key=lambda item: item.area)
            points = [(float(x), float(y)) for x, y in polygon.exterior.coords[:-1]]
        except (ImportError, ValueError, TypeError):
            return None
    round_radius_pts = 0.0
    if str(corner_style).strip().lower() == "round":
        round_radius_pts = (
            _cutline_round_radius_mm(curve_tension) * _PT_PER_MM
        )
    segments = build_filleted_polygon_beziers(
        points,
        radius=round_radius_pts,
        minimum_straight=(
            0.25 * _PT_PER_MM if round_radius_pts > 1e-9 else 0.0
        ),
    )
    return [{"exterior": segments, "interiors": []}] if segments else None


def _rounded_rect_shape_path_groups(
    shape: dict[str, object],
    *,
    left_px: int,
    top_px: int,
    dpi_x: float,
    dpi_y: float,
    total_offset_pts: float,
    corner_style: str,
    curve_tension: float,
) -> list[dict[str, object]] | None:
    """Dựng chữ nhật bo góc từ 4 đỉnh + 4 cung, không lấy mẫu thành chord."""
    params = _local_shape_params(
        shape,
        left_px=left_px,
        top_px=top_px,
        dpi_x=dpi_x,
        dpi_y=dpi_y,
    )
    if params is None or not {"cx", "cy", "w", "h"}.issubset(params):
        # Tương thích manifest thử nghiệm cũ chỉ lưu 68 điểm mẫu mà chưa có
        # params. Fit lại MỘT lần thành rounded-rect giải tích; không tái xuất
        # chính 68 chord gây gãy như trước.
        raw_coords = shape.get("coords")
        local_points = []
        if isinstance(raw_coords, (list, tuple)):
            unit = _shape_coordinate_unit(shape)
            for raw_point in raw_coords:
                local = _global_shape_point_to_local(
                    raw_point,
                    unit=unit,
                    left_px=left_px,
                    top_px=top_px,
                    dpi_x=dpi_x,
                    dpi_y=dpi_y,
                )
                if local is None:
                    return None
                local_points.append(local)
        if len(local_points) < 8:
            return None
        from app.workers.sticker_cut_reconstruct import try_rounded_rect

        reconstructed = try_rounded_rect(
            np.asarray(local_points, dtype=np.float64),
            force=True,
        )
        if reconstructed is None:
            return None
        params = {
            key: float(value)
            for key, value in reconstructed.params.items()
            if isinstance(value, (int, float, np.integer, np.floating))
        }
    try:
        cx = float(params["cx"])
        cy = float(params["cy"])
        half_width = float(params["w"]) / 2.0 + total_offset_pts
        half_height = float(params["h"]) / 2.0 + total_offset_pts
        source_radius = max(0.0, float(params.get("r", 0.0)) + total_offset_pts)
        angle = float(params.get("angle", 0.0))
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if (
        min(half_width, half_height) <= 0.0
        or not all(math.isfinite(value) for value in (
            cx, cy, half_width, half_height, source_radius, angle,
        ))
    ):
        return None
    requested_radius = 0.0
    if str(corner_style).strip().lower() == "round":
        requested_radius = _cutline_round_radius_mm(curve_tension) * _PT_PER_MM
    radius = min(max(source_radius, requested_radius), half_width, half_height)
    points = [
        _rotated_point(cx, cy, x, y, angle)
        for x, y in (
            (-half_width, -half_height),
            (half_width, -half_height),
            (half_width, half_height),
            (-half_width, half_height),
        )
    ]
    segments = build_filleted_polygon_beziers(
        points,
        radius=radius,
        # Rounded-rect/stadium hợp lệ có thể chạm nửa cạnh ngắn; cho hai cung
        # gần gặp nhau nhưng vẫn không chồng, thay vì co sai bán kính nguồn.
        edge_cap_ratio=0.499999,
    )
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
    curve_tension: float,
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
        return _rounded_rect_shape_path_groups(
            shape,
            left_px=left_px,
            top_px=top_px,
            dpi_x=dpi_x,
            dpi_y=dpi_y_resolved,
            total_offset_pts=total_offset_pts,
            corner_style=corner_style,
            curve_tension=curve_tension,
        )
    if kind in {
        "rect", "triangle", "pentagon", "hexagon", "heptagon", "octagon",
    }:
        return _polygon_shape_path_groups(
            shape,
            left_px=left_px,
            top_px=top_px,
            dpi=dpi_x,
            dpi_y=dpi_y_resolved,
            total_offset_pts=total_offset_pts,
            corner_style=corner_style,
            curve_tension=curve_tension,
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
        if raw_shape.get("kind") in {
            "circle", "ellipse", "rounded_rect", "rect", "triangle",
            "pentagon", "hexagon", "heptagon", "octagon",
        }:
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


def _exact_path_quality(
    path_groups: list[dict[str, object]],
    *,
    expect_smooth_joins: bool,
) -> dict[str, object]:
    """Đo path exact thật; góc chủ đích chỉ được bảo vệ khi không yêu cầu bo."""
    summaries = []
    invalid_ring_count = 0
    for group in path_groups:
        for ring in [group["exterior"], *(group.get("interiors") or [])]:
            summary = _alpha_live_machine_path_summary(ring, mm_to_pts=_PT_PER_MM)
            if summary is None:
                invalid_ring_count += 1
            else:
                summaries.append(summary)
    sharp_join_count = sum(
        len(summary.get("sharp_join_points") or ()) for summary in summaries
    )
    trajectory_cusp_count = sum(
        len(summary.get("trajectory_cusp_points") or ()) for summary in summaries
    )
    protected_corner_count = 0 if expect_smooth_joins else sharp_join_count
    protected_cusp_count = 0 if expect_smooth_joins else trajectory_cusp_count
    measured_short_segment_count = sum(
        int(summary.get("short_segment_count", 0)) for summary in summaries
    )
    all_paths = [
        ring
        for group in path_groups
        for ring in [group["exterior"], *(group.get("interiors") or [])]
    ]
    if expect_smooth_joins:
        short_segment_count = _analytic_fillet_short_line_count(
            all_paths,
            mm_to_pts=_PT_PER_MM,
        )
        smooth_short_arc_count = max(
            0,
            measured_short_segment_count - short_segment_count,
        )
    else:
        short_segment_count = measured_short_segment_count
        smooth_short_arc_count = 0
    disconnected_join_count = sum(
        int(summary.get("disconnected_join_count", 0)) for summary in summaries
    )
    minimum_lengths = [
        float(summary["minimum_segment_length_mm"])
        for summary in summaries
        if summary.get("minimum_segment_length_mm") is not None
    ]
    maximum_angles = [
        float(summary["maximum_join_angle_degrees"])
        for summary in summaries
        if summary.get("maximum_join_angle_degrees") is not None
    ]
    trajectory_turns = [
        float(summary["maximum_trajectory_turn_degrees"])
        for summary in summaries
        if summary.get("maximum_trajectory_turn_degrees") is not None
    ]
    wedge_widths = [
        float(summary["minimum_wedge_width_mm"])
        for summary in summaries
        if summary.get("minimum_wedge_width_mm") is not None
    ]
    unprotected_join_count = sharp_join_count - protected_corner_count
    unprotected_cusp_count = trajectory_cusp_count - protected_cusp_count
    return {
        "machine_safe": bool(
            summaries
            and invalid_ring_count == 0
            and short_segment_count == 0
            and disconnected_join_count == 0
            and unprotected_join_count == 0
        ),
        "segment_count": sum(
            int(summary.get("segment_count", 0)) for summary in summaries
        ),
        "short_segment_count": short_segment_count,
        "smooth_short_arc_count": smooth_short_arc_count,
        "disconnected_join_count": disconnected_join_count,
        "unprotected_join_count": unprotected_join_count,
        "protected_corner_count": protected_corner_count,
        "dropped_component_count": 0,
        "minimum_segment_length_mm": min(minimum_lengths, default=None),
        "maximum_join_angle_degrees": max(maximum_angles, default=None),
        "effective_deviation_mm": None,
        "fit_mode": "disabled" if not path_groups else "exact-geometry",
        "trajectory_cusp_count": trajectory_cusp_count,
        "protected_cusp_count": protected_cusp_count,
        "unprotected_cusp_count": unprotected_cusp_count,
        "maximum_trajectory_turn_degrees": max(trajectory_turns, default=None),
        "minimum_wedge_width_mm": min(wedge_widths, default=None),
        "cutline_hook_tolerated": False,
    }


def _cutline_instance_alpha_jobs(
    labels: np.ndarray,
    alpha: np.ndarray,
    *,
    dpi: float,
    dpi_y: float,
    exact_shapes: dict[int, dict[str, object]] | None = None,
    preserve_alpha_fringe: bool = False,
) -> list[tuple[int, int, int, np.ndarray, dict[str, object] | None]]:
    """Cắt Alpha từng tem theo cùng ROI cho preview và worker PDF."""
    # QUALITY (audit 2026-09-09 §BINDER2.3): dùng chung padding và mask theo nhãn
    # để đường bế classic không fit trên biên khác với preview đã duyệt.
    analysis_height, analysis_width = labels.shape
    shapes = exact_shapes if exact_shapes is not None else {}
    fringe_padding = _CUTLINE_ALPHA_FRINGE_PX if preserve_alpha_fringe else 1
    padding_x = max(
        fringe_padding,
        round(STICKER_PAGE_PADDING_MM * dpi / 25.4),
    )
    padding_y = max(
        fringe_padding,
        round(STICKER_PAGE_PADDING_MM * dpi_y / 25.4),
    )
    jobs = []
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
        exact_shape = shapes.get(instance_id)
        local_labels = labels[top:bottom, left:right]
        local_mask = local_labels == instance_id
        if preserve_alpha_fringe:
            fringe_mask = cv2.dilate(
                local_mask.astype(np.uint8),
                cv2.getStructuringElement(
                    cv2.MORPH_ELLIPSE,
                    (
                        _CUTLINE_ALPHA_FRINGE_PX * 2 + 1,
                        _CUTLINE_ALPHA_FRINGE_PX * 2 + 1,
                    ),
                ),
            ).astype(bool)
            # Không lấy dải alpha của tem kế bên khi hai bbox gần nhau.
            fringe_mask &= (local_labels == 0) | local_mask
        else:
            fringe_mask = local_mask
        local_alpha = alpha[top:bottom, left:right].copy()
        local_alpha[~fringe_mask] = 0
        jobs.append((instance_id, left, top, local_alpha, exact_shape))
    return jobs


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
    cutline_simplify_mm: float = 0.0,
) -> dict[str, object]:
    """Trả SVG path theo hệ preview; không ghi hay thay revision của session."""
    check_preview_cancelled()
    from app.workers.cutline_cubic_simplify import (
        CUTLINE_SIMPLIFY_ALGORITHM,
        CUTLINE_SIMPLIFY_MAX_MM,
    )

    page = session.pages.get(page_number)
    cutline_simplify_mm = float(cutline_simplify_mm)
    if not math.isfinite(cutline_simplify_mm) or not 0 <= cutline_simplify_mm <= CUTLINE_SIMPLIFY_MAX_MM:
        raise StickerSheetExportError("Sai số đơn giản hóa thêm phải nằm trong 0–0,10 mm.")
    if page is None:
        raise StickerSheetSessionConflict("Trang nguồn để xem đường bế không tồn tại.")

    with page.operation_lock:
        check_preview_cancelled()
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

        # QUALITY (audit 2026-08-20 §CUTLINE.EDGE): dùng profile bám sát chỉ
        # cho mask đã được detector xác nhận đã bỏ offset trắng/bóng lệch. Giữ
        # giá trị gốc cho cache key để export fallback vẫn tìm đúng artifact.
        effective_cutline_fidelity = _effective_cutline_fidelity(
            cutline_fidelity,
            page.manifest.get("warnings", []),
        )
        effective_curve_tension = _effective_composite_curve_tension(
            curve_tension,
            corner_style,
            page.manifest.get("warnings", []),
        )
        preserve_alpha_fringe = bool(
            set(str(item) for item in (page.manifest.get("warnings", []) or ()))
            .intersection(_COMPOSITE_CUTLINE_WARNINGS)
        )

        preview_width = int(page.preview_width_px)
        preview_height = int(page.preview_height_px)
        exact_shapes = _exact_shapes_by_instance(page, edits)
        # QUALITY (feedback 2026-08-16 §CUTJAG.1): mask AI/dò nền là mask nhị phân
        # hoá từ điểm ảnh nên cần khử răng cưa dưới một pixel trước khi lấy contour.
        presmooth_alpha = should_presmooth_cutline_alpha(page.boundary_source)
        # §CUTJAG.3: thanh kéo thắng cổng tự động. Người dùng kéo về 0 nghĩa là TẮT
        # hẳn, nên phải phân biệt `0.0` với "không gửi field" (`None`).
        denoise_amount = 0.0
        requested_denoise_value: float | None = None
        explicit_denoise_off = False
        if cutline_denoise is None:
            denoise_amount = 0.0
        else:
            try:
                requested_denoise_value = max(
                    0.0,
                    min(100.0, float(cutline_denoise)),
                )
                denoise_amount = requested_denoise_value
                explicit_denoise_off = denoise_amount <= 0.0
            except (TypeError, ValueError):
                requested_denoise_value = 0.0
                denoise_amount = 0.0
            presmooth_alpha = False
        manifest_warnings = {
            str(item) for item in (page.manifest.get("warnings", []) or ())
        }
        if (
            _ROUGH_SIMPLE_BG_DENOISE_WARNING in manifest_warnings
            and not explicit_denoise_off
        ):
            denoise_amount = max(
                denoise_amount,
                _ROUGH_SIMPLE_BG_DENOISE_MIN,
            )
            presmooth_alpha = False
            logger.info(
                "[RECOGNITION-GUARD] áp khử răng cưa %.0f cho preview "
                "simple-bg thô mà không gọi mô hình nặng",
                denoise_amount,
            )
        source_key = _preview_source_key(session, page)
        geometry_key_payload = {
            "source_key": source_key,
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
            "preserve_alpha_fringe": preserve_alpha_fringe,
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
            # QUALITY (audit 2026-08-20 §CUTLINE.EDGE): với marker composite,
            # giữ dải alpha mềm 2 px quanh nhãn; nếu cắt về 0 theo labels nhị
            # phân thì marching-squares mất dữ liệu chuyển tiếp và đường bế bị
            # bậc thang dù fidelity cao.
            rgba = _build_edited_rgba(
                page_view,
                original_labels,
                labels,
                preserve_alpha_fringe=preserve_alpha_fringe,
            )
            analysis_height, analysis_width = labels.shape
            prepare_jobs = _cutline_instance_alpha_jobs(
                labels,
                rgba[:, :, 3],
                dpi=dpi_x,
                dpi_y=dpi_y_resolved,
                exact_shapes=exact_shapes,
                preserve_alpha_fringe=preserve_alpha_fringe,
            )

            def prepare_instance(item):
                check_preview_cancelled()
                instance_id, left, top, alpha, exact_shape = item
                if exact_shape is not None:
                    return instance_id, left, top, {"exact_shape": exact_shape}, alpha
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
                return instance_id, left, top, prepared, alpha

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
        simplify_height = analysis_height * 72.0 / dpi_y_resolved
        if cutline_simplify_mm > 0 and session.source_kind == "pdf":
            import pikepdf

            with pikepdf.Pdf.open(session.source_path) as source_pdf:
                box = source_pdf.pages[page_number - 1].cropbox
                simplify_height = abs(float(box[3]) - float(box[1]))

        # PERF (audit 2026-09-11 §SIMPLIFY.CACHE): giữ riêng Bézier TRƯỚC
        # Simplify và các frame SAU kiểm. Đổi dung sai không fit lại, không
        # simplify chồng lên nghiệm cũ; đổi offset vẫn có thể trở lại frame cũ.
        fit_options = dict(
            geometry_key=geometry_key,
            cutline_smoothness=cutline_smoothness,
            requested_cutline_fidelity=cutline_fidelity,
            requested_curve_tension=curve_tension,
            requested_cutline_denoise=requested_denoise_value,
            effective_cutline_fidelity=effective_cutline_fidelity,
            effective_curve_tension=effective_curve_tension,
            source_kind=session.source_kind,
        )
        fit_cache_key = _preview_fit_cache_key(
            **fit_options, cutline_simplify_mm=cutline_simplify_mm,
            simplify_height=simplify_height, preview_size=(preview_width, preview_height),
        )
        baseline_key = _preview_fit_cache_key(
            **fit_options, cutline_simplify_mm=0.0, simplify_height=0.0,
        )
        cache_limit = _preview_cache_limit()
        fit_cache = getattr(page, "cutline_preview_fit_cache", None)
        if (
            not isinstance(fit_cache, dict)
            or fit_cache.get("source_key") != source_key
            or not isinstance(fit_cache.get("entries"), dict)
        ):
            fit_cache = {"source_key": source_key, "entries": {}, "baselines": {}}
            page.cutline_preview_fit_cache = fit_cache
        cached_fit = fit_cache["entries"].get(fit_cache_key)
        if isinstance(cached_fit, dict):
            cached_export = cached_fit.get("export_cache")
            cached_instances = _restore_cached_instances(
                cached_export.get("instances") if isinstance(cached_export, dict) else None,
                prepared_instances,
            )
            cached_response = cached_fit.get("response")
            if (
                cached_instances is not None
                and isinstance(cached_response, dict)
                and isinstance(cached_export, dict)
            ):
                export_cache = deepcopy(cached_export)
                export_cache["instances"] = cached_instances
                page.cutline_export_cache = export_cache
                return deepcopy(cached_response)

        baseline_instances = dict(fit_cache["baselines"].get(baseline_key, {}))
        def fit_instance(item):
            check_preview_cancelled()
            instance_id, left, top, prepared, local_alpha = item
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
                    curve_tension=effective_curve_tension,
                )
                if path_groups is None:
                    raise StickerSheetExportError(
                        f"Không tạo được đường bế hình học cho tem {instance_id}."
                    )
                if not path_groups:
                    # cut_mode=none: giống nhánh mask disabled, không có path là
                    # kết quả hợp lệ chứ không phải lỗi chất lượng.
                    return None
                exact_kind = str(exact_shape.get("kind", "")).strip().lower()
                requested_radius_mm = _cutline_round_radius_mm(
                    effective_curve_tension
                )
                expect_smooth_joins = bool(
                    exact_kind in {"circle", "ellipse", "rounded_rect"}
                    or (
                        str(corner_style).strip().lower() == "round"
                        and requested_radius_mm > 1e-9
                    )
                )
                cutline = {
                    "path_groups": path_groups,
                    "quality": _exact_path_quality(
                        path_groups,
                        expect_smooth_joins=expect_smooth_joins,
                    ),
                }
                if not bool(cutline["quality"].get("machine_safe")):
                    quality = cutline["quality"]
                    raise StickerSheetExportError(
                        f"Tem {instance_id}: đường bế hình học chưa an toàn "
                        f"({int(quality.get('short_segment_count', 0))} đoạn ngắn, "
                        f"{int(quality.get('disconnected_join_count', 0))} khớp hở, "
                        f"{int(quality.get('unprotected_join_count', 0))} khớp gãy)."
                    )
            else:
                try:
                    if instance_id in baseline_instances:
                        cutline = deepcopy(baseline_instances[instance_id])
                    else:
                        cutline = fit_prepared_alpha_cutline_geometry(
                            prepared,
                            cutline_smoothness=cutline_smoothness,
                            cutline_fidelity=effective_cutline_fidelity,
                            curve_tension=effective_curve_tension,
                        )
                        if cutline is not None:
                            baseline_instances[instance_id] = deepcopy(cutline)
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
                cutline = simplify_alpha_cutline_result(
                    cutline, prepared, tolerance_mm=cutline_simplify_mm,
                    offset_x_points=left * 72.0 / dpi_x,
                    offset_y_points=top * 72.0 / dpi_y_resolved,
                    page_height=simplify_height,
                    preview_fast=True,
                )
            if cutline_simplify_mm > 0 and "simplification" not in cutline.get("quality", {}):
                count = sum(len(r) for g in cutline["path_groups"] for r in [g["exterior"], *g.get("interiors", [])])
                cutline["quality"] = {**cutline.get("quality", {}), "simplification": {
                    "before_segments": count, "after_segments": count,
                    "maximum_error_bound_mm": 0.0, "changed": False,
                }}
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
            alpha_value = np.ascontiguousarray(local_alpha, dtype=np.uint8)
            alpha_sha256 = hashlib.sha256(
                alpha_value.tobytes(order="C")
            ).hexdigest()
            fingerprint_instance = {
                "instance_id": instance_id,
                "left": left,
                "top": top,
                "path_groups": path_groups,
                "alpha_sha256": alpha_sha256,
            }
            return (
                {
                    "instance_id": instance_id,
                    "d": " ".join(part for part in path_parts if part),
                    "segment_count": segment_count,
                    "quality": quality,
                },
                fingerprint_instance,
                # PERF (audit 2026-09-11 §SIMPLIFY.CACHE): chỉ một Alpha cho
                # frame active; các frame lịch sử chỉ giữ hash/path. Tách copy
                # ở biên này để consumer không sửa mask trong working-set.
                {**fingerprint_instance, "alpha": alpha_value.copy()},
                segment_count,
                quality,
            )

        response_paths = []
        fingerprint_paths = []
        cache_instances = []
        quality_items = []
        total_segments = 0
        for fitted in _map_preview_jobs(fit_instance, prepared_instances):
            if fitted is None:
                continue
            (
                response_path,
                fingerprint_path,
                cache_instance,
                segment_count,
                quality,
            ) = fitted
            response_paths.append(response_path)
            fingerprint_paths.append(fingerprint_path)
            cache_instances.append(cache_instance)
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
            "requested_cutline_denoise": requested_denoise_value,
            "effective_cutline_denoise": denoise_amount,
            "paths": fingerprint_paths,
        }
        if cutline_simplify_mm > 0:
            fingerprint_payload["cutline_simplify_mm"] = cutline_simplify_mm
            # QUALITY (audit 2026-09-10 §FAIR.4): phân biệt lõi neo tự do với
            # frame cũ dù số mm và đường sau fallback có thể trùng nhau.
            fingerprint_payload["cutline_simplify_algorithm"] = CUTLINE_SIMPLIFY_ALGORITHM
        fingerprint = hashlib.sha256(json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        # PERF (audit 2026-08-10 §CUTLINE.EXPORT4): export dùng đúng Bézier vừa
        # hiện trên màn hình. Cache chỉ có một bản mới nhất/trang và khóa bao phủ
        # toàn bộ revision, edit, DPI cùng các tham số quỹ đạo.
        aggregate_quality = _aggregate_cutline_quality(quality_items)
        if cutline_simplify_mm > 0:
            summaries = [item.get("simplification") or {} for item in quality_items]
            aggregate_quality["simplification"] = {
                "before_segments": sum(int(item.get("before_segments", 0)) for item in summaries),
                "after_segments": total_segments,
                "maximum_error_bound_mm": max((float(item.get("maximum_error_bound_mm", 0.0)) for item in summaries), default=0.0),
                "changed": any(bool(item.get("changed")) for item in summaries),
            }
        check_preview_cancelled()
        page.cutline_export_cache = {
            "source_key": source_key,
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
                cutline_denoise=requested_denoise_value,
                cutline_simplify_mm=cutline_simplify_mm,
            ),
            "page_number": page_number,
            "revision": revision,
            "mask_revision": revision,
            "fingerprint": fingerprint,
            "dpi": dpi_x,
            "dpi_y": dpi_y_resolved,
            "source_pixel_mm": max(25.4 / dpi_x, 25.4 / dpi_y_resolved),
            "boundary_source": str(page.boundary_source or "approved"),
            "requested_cutline_denoise": requested_denoise_value,
            "effective_cutline_denoise": denoise_amount,
            "quality": aggregate_quality,
            "cutline_simplify_mm": cutline_simplify_mm,
            "analysis_width": analysis_width,
            "analysis_height": analysis_height,
            "instances": cache_instances,
        }
        response = {
            "page_number": page_number,
            "mask_revision": revision,
            "preview_width_px": preview_width,
            "preview_height_px": preview_height,
            "paths": response_paths,
            "fingerprint": fingerprint,
            "segment_count": total_segments,
            "quality": aggregate_quality,
        }
        # Cache phụ chỉ giữ path/metadata; Alpha được gắn lại từ
        # ``prepared_instances`` khi hit để không làm phình RAM theo số lần kéo.
        _remember_preview(fit_cache["baselines"], baseline_key, baseline_instances, cache_limit)
        # Frame cuối là artifact UI còn tham chiếu, không phải baseline có thể
        # loại tùy ý. Giữ vector nhẹ đến hết revision/session; nếu loại frame A
        # trên máy yếu, UI quay lại A sẽ bị kẹt 409 dù vẫn hiển thị đã sẵn sàng.
        fit_cache["entries"][fit_cache_key] = {
            "response": deepcopy(response),
            "export_cache": deepcopy({
                key: value for key, value in page.cutline_export_cache.items()
                if key != "instances"
            }) | {"instances": _cache_instances_without_alpha(cache_instances)},
            "options": dict(
                page_number=page_number, base_revision=revision, edits=deepcopy(edits),
                dpi=dpi_x, dpi_y=dpi_y_resolved, offset_mm=offset_mm, bleed_mm=bleed_mm,
                cut_mode=cut_mode, corner_style=corner_style, fill_holes=fill_holes,
                cutline_smoothness=cutline_smoothness, cutline_fidelity=cutline_fidelity,
                curve_tension=curve_tension, min_detail_area_mm2=min_detail_area_mm2,
                cutline_denoise=requested_denoise_value, cutline_simplify_mm=cutline_simplify_mm,
            ),
        }
        return response
