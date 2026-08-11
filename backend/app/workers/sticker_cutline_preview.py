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
from app.core.sticker_sheet_session import StickerSheetSession, StickerSheetSessionConflict
from app.workers.sticker_engine import (
    UnsafeCutlineGeometryError,
    fit_prepared_alpha_cutline_geometry,
    prepare_alpha_cutline_geometry,
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
                local_mask = labels[top:bottom, left:right] == instance_id
                alpha = rgba[top:bottom, left:right, 3].copy()
                alpha[~local_mask] = 0
                prepare_jobs.append((instance_id, left, top, alpha))

            def prepare_instance(item):
                instance_id, left, top, alpha = item
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
