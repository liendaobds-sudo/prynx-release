"""Áp Mask Quick Fix và xuất từng tem thành PNG/PDF có CutContour."""

from __future__ import annotations

from contextlib import ExitStack
import copy
from dataclasses import dataclass, replace
import gc
import hashlib
import json
import logging
import math
from pathlib import Path
import shutil
import uuid
import zipfile

import cv2
import numpy as np
from PIL import Image, ImageOps
import pikepdf

from app.core.sticker_cutline_policy import resolve_sticker_corner_policy
from app.core.sticker_background import detect_background
from app.core.color_provenance import embed_srgb_output_intent
from app.core.sticker_sheet_session import StickerSheetPageState, StickerSheetSession
from app.workers.sticker_engine import (
    ALPHA_CONTOUR_INSET_MM,
    StickerEngine,
    UnsafeCutlineGeometryError,
    build_alpha_cutline_geometry,
    should_presmooth_cutline_alpha,
    compute_cut_bleed_offsets,
)
from app.workers.sticker_page_canvas import restore_sticker_page_canvas


STICKER_PAGE_PADDING_MM = 0.25

logger = logging.getLogger(__name__)


class StickerSheetExportError(RuntimeError):
    """Lỗi nghiệp vụ khi mask đã sửa không thể tạo artifact."""


class StickerCanonicalPreviewConflict(RuntimeError):
    """Artifact preview classic đã mất, stale hoặc không còn khớp file nguồn."""


@dataclass(frozen=True)
class StickerSheetExportResult:
    path: Path
    filename: str
    media_type: str
    sticker_count: int


def _cutline_export_cache_key(
    *,
    page_number: int,
    revision: int,
    edits: list[dict[str, object]],
    dpi: float,
    dpi_y: float,
    offset_mm: float,
    bleed_mm: float,
    cut_mode: str,
    corner_style: str,
    fill_holes: bool,
    cutline_smoothness: float,
    cutline_fidelity: float,
    curve_tension: float,
    min_detail_area_mm2: float,
    cutline_denoise: float | None = None,
) -> str:
    """Khóa chung để preview và export chỉ chia sẻ đúng cùng một hình học."""
    normalized_cut_mode = str(cut_mode).strip().lower()
    # PERF (feedback 2026-08-11 §CUTLINE.NOREBUILD2): bleed chỉ dời CutContour
    # ở chế độ ``bleed``; các chế độ khác phải tái dùng được path đã duyệt.
    effective_bleed_mm = float(bleed_mm) if normalized_cut_mode == "bleed" else 0.0
    payload = {
        "page": int(page_number),
        "revision": int(revision),
        "edits": edits,
        "dpi": float(dpi),
        "dpi_y": float(dpi_y),
        "offset_mm": float(offset_mm),
        "bleed_mm": effective_bleed_mm,
        "cut_mode": normalized_cut_mode,
        "corner_style": str(corner_style),
        "fill_holes": bool(fill_holes),
        "cutline_smoothness": float(cutline_smoothness),
        "cutline_fidelity": float(cutline_fidelity),
        "curve_tension": float(curve_tension),
        "min_detail_area_mm2": float(min_detail_area_mm2),
        # PERF/QUALITY (audit 2026-08-21 §CANONICAL.1): denoise thay đổi chính
        # silhouette trước marching-squares. Thiếu field này từng cho phép lượt
        # Thực thi lấy nhầm Bézier của vị trí slider trước đó.
        "cutline_denoise": (
            None if cutline_denoise is None else float(cutline_denoise)
        ),
    }
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _same_source_bytes(first: Path, second: Path) -> bool:
    """So file session với file execute; đường khác nhau vẫn có thể cùng nội dung."""
    try:
        if first.resolve() == second.resolve():
            return True
        if first.stat().st_size != second.stat().st_size:
            return False
        with first.open("rb") as first_stream, second.open("rb") as second_stream:
            return (
                hashlib.file_digest(first_stream, "sha256").digest()
                == hashlib.file_digest(second_stream, "sha256").digest()
            )
    except OSError:
        return False


def _valid_cutline_path_groups(value: object) -> bool:
    """Kiểm nhẹ payload RAM trước khi trao cho engine; sai thì fit lại an toàn."""
    if not isinstance(value, list) or not value:
        return False
    for group in value:
        if not isinstance(group, dict):
            return False
        exterior = group.get("exterior")
        interiors = group.get("interiors") or []
        if not isinstance(exterior, (list, tuple)) or not exterior:
            return False
        if not isinstance(interiors, (list, tuple)):
            return False
        for ring in [exterior, *interiors]:
            if not isinstance(ring, (list, tuple)) or not ring:
                return False
            for segment in ring:
                if not isinstance(segment, (list, tuple)) or len(segment) != 4:
                    return False
                for point in segment:
                    if not isinstance(point, (list, tuple)) or len(point) != 2:
                        return False
                    try:
                        x, y = float(point[0]), float(point[1])
                    except (TypeError, ValueError, OverflowError):
                        return False
                    if not math.isfinite(x) or not math.isfinite(y):
                        return False
    return True


def _translate_cutline_path_groups(
    path_groups: list[dict[str, object]],
    *,
    offset_x_points: float,
    offset_y_points: float,
) -> list[dict[str, object]]:
    """Đưa Bézier từ crop cục bộ về hệ tọa độ ảnh nguyên tấm (trục Y hướng xuống)."""
    translated: list[dict[str, object]] = []
    for group in path_groups:
        rings = [group["exterior"], *(group.get("interiors") or [])]
        translated_rings = []
        for ring in rings:
            translated_rings.append([
                tuple(
                    (
                        float(point[0]) + offset_x_points,
                        float(point[1]) + offset_y_points,
                    )
                    for point in segment
                )
                for segment in ring
            ])
        translated.append({
            "exterior": translated_rings[0],
            "interiors": translated_rings[1:],
        })
    return translated


def _cutline_overrides_from_preview_cache(
    page: StickerSheetPageState,
    *,
    cache_key: str,
    instance_ids: list[int],
    crop_to_sticker: bool,
    dpi: float,
    dpi_y: float,
) -> list[dict[str, object]] | None:
    """Ánh xạ cache preview thành override song song với PNG xuất của một trang."""
    cached = getattr(page, "cutline_export_cache", None)
    if not isinstance(cached, dict) or cached.get("key") != cache_key:
        return None
    raw_instances = cached.get("instances")
    if not isinstance(raw_instances, list):
        return None

    by_id: dict[int, dict[str, object]] = {}
    for raw in raw_instances:
        if not isinstance(raw, dict):
            return None
        try:
            instance_id = int(raw["instance_id"])
            left = int(raw["left"])
            top = int(raw["top"])
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        path_groups = raw.get("path_groups")
        if instance_id in by_id or not _valid_cutline_path_groups(path_groups):
            return None
        by_id[instance_id] = {
            "instance_id": instance_id,
            "left": left,
            "top": top,
            "path_groups": path_groups,
        }

    ordered_ids = sorted(int(value) for value in instance_ids)
    if len(ordered_ids) != len(set(ordered_ids)) or set(ordered_ids) != set(by_id):
        return None
    if crop_to_sticker:
        return [
            {"path_groups": by_id[instance_id]["path_groups"]}
            for instance_id in ordered_ids
        ]

    combined_groups: list[dict[str, object]] = []
    for instance_id in ordered_ids:
        item = by_id[instance_id]
        combined_groups.extend(_translate_cutline_path_groups(
            item["path_groups"],
            offset_x_points=float(item["left"]) * 72.0 / float(dpi),
            offset_y_points=float(item["top"]) * 72.0 / float(dpi_y),
        ))
    return [{"path_groups": combined_groups}] if combined_groups else None


def snapshot_classic_cutline_preview(
    session: StickerSheetSession,
    *,
    source_path: str | Path,
    page_number: int,
    expected_revision: int,
    expected_fingerprint: str,
    offset_mm: float,
    bleed_mm: float,
    cut_mode: str,
    corner_style: str,
    fill_holes: bool,
    curve_tension: float,
    cutline_denoise: float | None,
    cutline_smoothness: float = 50.0,
    cutline_fidelity: float = 50.0,
    min_detail_area_mm2: float = 1.0,
) -> dict[str, object]:
    """Chụp nguyên tử Alpha + Bézier đang hiển thị cho execute classic.

    Không dựng fallback ở đây. Client đã gửi reference nghĩa là người dùng đã
    duyệt đúng frame đó; stale phải dừng rõ ràng thay vì âm thầm detect/fit lại.
    """
    if not _same_source_bytes(Path(session.source_path), Path(source_path)):
        raise StickerCanonicalPreviewConflict(
            "Preview đường bế không còn thuộc file đang mở. Hãy chờ nhận diện lại."
        )
    page = session.pages.get(int(page_number))
    if page is None:
        raise StickerCanonicalPreviewConflict(
            "Trang của preview đường bế không còn tồn tại."
        )

    with page.operation_lock:
        if page.stage not in {"mask-review", "mask-ready"}:
            raise StickerCanonicalPreviewConflict(
                "Preview đường bế chưa sẵn sàng để Thực thi."
            )
        revision = int(page.manifest.get("mask_revision", 0))
        if revision != int(expected_revision):
            raise StickerCanonicalPreviewConflict(
                "Preview đường bế đã thay đổi revision. Hãy chờ đường mới cập nhật."
            )
        cache = page.cutline_export_cache
        if not isinstance(cache, dict):
            raise StickerCanonicalPreviewConflict(
                "Artifact preview đường bế đã hết hạn. Hãy cập nhật preview rồi thử lại."
            )
        if (
            int(cache.get("page_number", -1)) != int(page_number)
            or int(cache.get("revision", -1)) != revision
            or str(cache.get("fingerprint", "")) != str(expected_fingerprint)
        ):
            raise StickerCanonicalPreviewConflict(
                "Preview đường bế đã cũ hoặc fingerprint không khớp."
            )
        try:
            dpi_x = float(cache["dpi"])
            dpi_y = float(cache["dpi_y"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise StickerSheetExportError(
                "Artifact preview thiếu độ phân giải hình học."
            ) from exc
        if (
            not math.isfinite(dpi_x)
            or not math.isfinite(dpi_y)
            or dpi_x <= 0.0
            or dpi_y <= 0.0
        ):
            raise StickerSheetExportError(
                "Artifact preview có độ phân giải không hợp lệ."
            )
        expected_key = _cutline_export_cache_key(
            page_number=page_number,
            revision=revision,
            edits=[],
            dpi=dpi_x,
            dpi_y=dpi_y,
            offset_mm=offset_mm,
            bleed_mm=bleed_mm,
            cut_mode=cut_mode,
            corner_style=corner_style,
            fill_holes=fill_holes,
            cutline_smoothness=cutline_smoothness,
            cutline_fidelity=cutline_fidelity,
            curve_tension=curve_tension,
            min_detail_area_mm2=min_detail_area_mm2,
            cutline_denoise=cutline_denoise,
        )
        if str(cache.get("key", "")) != expected_key:
            raise StickerCanonicalPreviewConflict(
                "Thiết lập đường bế đã đổi sau preview. Hãy chờ đường mới cập nhật."
            )
        quality = cache.get("quality")
        if not isinstance(quality, dict) or quality.get("machine_safe") is not True:
            raise StickerSheetExportError(
                "Artifact preview chưa vượt kiểm tra quỹ đạo máy bế."
            )
        raw_instances = cache.get("instances")
        manifest_instances = page.manifest.get("instances")
        if (
            not isinstance(raw_instances, list)
            or len(raw_instances) != 1
            or not isinstance(manifest_instances, list)
            or len(manifest_instances) != 1
        ):
            raise StickerSheetExportError(
                "Preview classic chỉ được snapshot đúng một vùng tem."
            )
        raw_instance = raw_instances[0]
        if not isinstance(raw_instance, dict):
            raise StickerSheetExportError("Artifact preview vùng tem không hợp lệ.")
        try:
            instance_id = int(raw_instance["instance_id"])
            manifest_instance_id = int(manifest_instances[0]["id"])
            left = int(raw_instance["left"])
            top = int(raw_instance["top"])
            analysis_width = int(cache["analysis_width"])
            analysis_height = int(cache["analysis_height"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise StickerSheetExportError(
                "Artifact preview thiếu tọa độ vùng tem."
            ) from exc
        if instance_id != manifest_instance_id:
            raise StickerCanonicalPreviewConflict(
                "Vùng tem trong preview đã thay đổi."
            )
        local_alpha = raw_instance.get("alpha")
        if not isinstance(local_alpha, np.ndarray) or local_alpha.ndim != 2:
            raise StickerSheetExportError(
                "Artifact preview thiếu Alpha canonical."
            )
        local_alpha = np.ascontiguousarray(local_alpha, dtype=np.uint8)
        bottom = top + int(local_alpha.shape[0])
        right = left + int(local_alpha.shape[1])
        if (
            analysis_width <= 0
            or analysis_height <= 0
            or left < 0
            or top < 0
            or right > analysis_width
            or bottom > analysis_height
        ):
            raise StickerSheetExportError(
                "Alpha canonical nằm ngoài kích thước trang phân tích."
            )
        alpha_sha256 = hashlib.sha256(local_alpha.tobytes(order="C")).hexdigest()
        if alpha_sha256 != str(raw_instance.get("alpha_sha256", "")):
            raise StickerSheetExportError(
                "Alpha canonical không còn khớp fingerprint preview."
            )
        full_alpha = np.zeros((analysis_height, analysis_width), dtype=np.uint8)
        full_alpha[top:bottom, left:right] = local_alpha
        translated = _cutline_overrides_from_preview_cache(
            page,
            cache_key=expected_key,
            instance_ids=[instance_id],
            crop_to_sticker=False,
            dpi=dpi_x,
            dpi_y=dpi_y,
        )
        if not translated or not _valid_cutline_path_groups(
            translated[0].get("path_groups")
        ):
            raise StickerSheetExportError(
                "Bézier canonical trong preview không hợp lệ."
            )

        edge_background_rgb = page.manifest.get("edge_background_rgb")
        if not (
            isinstance(edge_background_rgb, (list, tuple))
            and len(edge_background_rgb) == 3
        ):
            edge_background_rgb = None
        else:
            try:
                edge_background_rgb = tuple(
                    max(0, min(255, int(value))) for value in edge_background_rgb
                )
            except (TypeError, ValueError, OverflowError):
                edge_background_rgb = None
        try:
            edge_background_tolerance = max(
                0,
                min(255, int(page.manifest.get("edge_background_tolerance", 0))),
            )
        except (TypeError, ValueError, OverflowError):
            edge_background_tolerance = 0

        # Deep-copy trước khi nhả lock: request preview kế tiếp được phép thay cache
        # ngay sau snapshot nhưng job PDF vẫn phải dùng đúng frame người dùng đã thấy.
        return {
            "alpha": full_alpha.copy(),
            "dpi": (dpi_x, dpi_y),
            "source_pixel_mm": max(25.4 / dpi_x, 25.4 / dpi_y),
            "boundary_source": str(page.boundary_source or "approved"),
            "path_groups": copy.deepcopy(translated[0]["path_groups"]),
            "edge_background_rgb": edge_background_rgb,
            "edge_background_tolerance": edge_background_tolerance,
            "preview_fingerprint": str(expected_fingerprint),
        }


def _sticker_engine_dpi(dpi: float, dpi_y: float) -> int:
    """Không nội suy raster nguồn thấp; nguồn ≥300 DPI vẫn giữ trần chất lượng cũ."""
    resolved = max(float(dpi), float(dpi_y))
    if not math.isfinite(resolved) or resolved <= 0:
        raise StickerSheetExportError("Độ phân giải ảnh không hợp lệ.")
    return min(300, max(72, round(resolved)))


def _paint_stroke(
    labels: np.ndarray,
    edit: dict[str, object],
    valid_ids: set[int],
) -> None:
    height, width = labels.shape
    tool = str(edit.get("tool", ""))
    instance_id = int(edit.get("instance_id", 0))
    if instance_id not in valid_ids:
        raise StickerSheetExportError("Nét sửa tham chiếu tem không tồn tại.")
    radius = float(edit.get("radius", 0.0))
    radius_px = max(1, round(radius * max(width, height)))
    value = instance_id if tool == "restore" else 0
    raw_points = edit.get("points") or []
    points = [
        (
            max(0, min(width - 1, round(float(point["x"]) * width))),
            max(0, min(height - 1, round(float(point["y"]) * height))),
        )
        for point in raw_points
    ]
    if not points:
        return
    thickness = radius_px * 2 + 1
    for start, end in zip(points, points[1:]):
        cv2.line(labels, start, end, color=value, thickness=thickness, lineType=cv2.LINE_8)
    for point in (points[0], points[-1]):
        cv2.circle(labels, point, radius_px, color=value, thickness=-1, lineType=cv2.LINE_8)


def apply_export_edits(
    original_labels: np.ndarray,
    edits: list[dict[str, object]],
    valid_ids: set[int],
) -> np.ndarray:
    # STABILITY (audit 2026-08-09 §PV.4): OpenCV không hỗ trợ vẽ line/circle lên
    # ``uint32``. Giữ nhãn ở ``int32`` — cũng là kiểu mà connectedComponents sinh
    # ra — để nét xóa/khôi phục dùng được cho cả live preview lẫn lúc xuất file.
    labels = original_labels.astype(np.int32, copy=True)
    for edit in edits:
        kind = str(edit.get("kind", ""))
        if kind == "stroke":
            _paint_stroke(labels, edit, valid_ids)
            continue
        if kind != "merge":
            raise StickerSheetExportError("Lệnh sửa mask không được hỗ trợ.")
        source_id = int(edit.get("source_id", 0))
        target_id = int(edit.get("target_id", 0))
        if source_id not in valid_ids or target_id not in valid_ids or source_id == target_id:
            raise StickerSheetExportError("Lệnh gộp tem không hợp lệ.")
        labels[labels == source_id] = target_id
    return labels


def _load_source_rgb(session: StickerSheetSession, target_size: tuple[int, int]) -> np.ndarray:
    source_path = session.analysis_source_path or session.source_path
    with Image.open(source_path) as opened:
        opened.load()
        source = ImageOps.exif_transpose(opened).convert("RGB")
    if source.size != target_size:
        source = source.resize(target_size, Image.Resampling.LANCZOS)
    return np.asarray(source, dtype=np.uint8)


def _build_edited_rgba(
    session: StickerSheetSession,
    original_labels: np.ndarray,
    labels: np.ndarray,
    *,
    preserve_alpha_fringe: bool = False,
) -> np.ndarray:
    with Image.open(session.directory / "rgba.png") as opened:
        rgba = np.asarray(opened.convert("RGBA"), dtype=np.uint8).copy()
    if rgba.shape[:2] != labels.shape:
        raise StickerSheetExportError("Mask và ảnh session không cùng kích thước.")

    source_rgb = _load_source_rgb(session, (rgba.shape[1], rgba.shape[0]))
    restored = (labels > 0) & (original_labels == 0)
    rgba[restored, :3] = source_rgb[restored]
    if preserve_alpha_fringe:
        # Preview cần giữ dải alpha chuyển tiếp mà detector đã tạo quanh nhãn;
        # chỉ xoá vùng tem bị erase, còn nền ngoài nhãn để caller clip theo ROI.
        rgba[(labels == 0) & (original_labels > 0), 3] = 0
    else:
        rgba[labels == 0, 3] = 0
    rgba[restored, 3] = 255
    return rgba


def _extract_stickers(
    directory: Path,
    rgba: np.ndarray,
    labels: np.ndarray,
    dpi: float,
    dpi_y: float | None = None,
    filename_prefix: str = "tem",
    optimize_for_archive: bool = True,
) -> list[Path]:
    output_paths: list[Path] = []
    height, width = labels.shape
    resolved_dpi_y = float(dpi_y if dpi_y is not None else dpi)
    png_options = (
        {"optimize": True}
        if optimize_for_archive
        else {"compress_level": 1}
    )
    padding_x_px = max(1, round(STICKER_PAGE_PADDING_MM * float(dpi) / 25.4))
    padding_y_px = max(1, round(STICKER_PAGE_PADDING_MM * resolved_dpi_y / 25.4))
    for sequence, instance_id in enumerate(sorted(int(value) for value in np.unique(labels) if value > 0), start=1):
        ys, xs = np.where(labels == instance_id)
        if xs.size == 0:
            continue
        left = max(0, int(xs.min()) - padding_x_px)
        top = max(0, int(ys.min()) - padding_y_px)
        right = min(width, int(xs.max()) + padding_x_px + 1)
        bottom = min(height, int(ys.max()) + padding_y_px + 1)
        crop = rgba[top:bottom, left:right].copy()
        local_mask = labels[top:bottom, left:right] == instance_id
        crop[~local_mask, 3] = 0
        path = directory / f"{filename_prefix}_{sequence:03d}.png"
        Image.fromarray(crop, "RGBA").save(
            path,
            format="PNG",
            dpi=(dpi, resolved_dpi_y),
            **png_options,
        )
        output_paths.append(path)
    if not output_paths:
        raise StickerSheetExportError("Mọi tem đã bị xóa khỏi mask; không có gì để xuất.")
    return output_paths


def _prepare_output_pngs(
    directory: Path,
    rgba: np.ndarray,
    labels: np.ndarray,
    dpi: float,
    dpi_y: float,
    *,
    output_format: str,
    crop_to_sticker: bool,
    filename_prefix: str = "tem",
) -> tuple[list[Path], int]:
    """Chuẩn bị raster đúng với cách đóng trang PDF mà người dùng chọn."""
    sticker_count = sum(1 for value in np.unique(labels) if value > 0)
    if sticker_count == 0:
        raise StickerSheetExportError("Mọi tem đã bị xóa khỏi mask; không có gì để xuất.")

    # UIUX (audit 2026-08-10 §SHEETEXPORT.1): ZIP luôn là bộ PNG từng tem.
    # Lựa chọn giữ nguyên tấm chỉ đổi cách đóng trang của PDF CutContour.
    if output_format == "png_zip" or crop_to_sticker:
        return (
            _extract_stickers(
                directory,
                rgba,
                labels,
                dpi,
                dpi_y,
                filename_prefix=filename_prefix,
                optimize_for_archive=(output_format == "png_zip"),
            ),
            sticker_count,
        )

    whole_sheet = rgba.copy()
    whole_sheet[labels == 0, 3] = 0
    path = directory / f"{filename_prefix}_tam.png"
    Image.fromarray(whole_sheet, "RGBA").save(
        path,
        format="PNG",
        dpi=(dpi, dpi_y),
        # PERF (audit 2026-08-10 §CUTLINE.EXPORT2): PNG này chỉ là nguồn PDF
        # ngắn hạn. Nén level 1 giữ nguyên pixel nhưng tránh CPU optimize đắt.
        compress_level=1,
    )
    return [path], sticker_count


def white_boundary_ratio(rgba: np.ndarray, labels: np.ndarray) -> float:
    """Đo tỷ lệ pixel gần-trắng ở mép trong để chọn bleed trắng sạch."""
    occupied = np.where(labels > 0, 255, 0).astype(np.uint8)
    try:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        inner = cv2.erode(occupied, kernel, iterations=1)
        boundary = (occupied > 0) & (inner == 0)
    except cv2.error:
        # STABILITY (audit 2026-08-05 §AI2.EXPORT3): đây chỉ là phép đo màu mép,
        # không được phép làm hỏng cả export khi OpenCV lỗi cấp phát nhất thời.
        # Erode boolean 5×5 tương đương được thực hiện tuần tự để giữ peak RAM thấp.
        logger.warning("OpenCV lỗi khi đo mép trắng; dùng fallback NumPy", exc_info=True)
        source = occupied > 0
        height, width = source.shape
        padded = np.pad(source, 2, mode="constant", constant_values=False)
        inner_bool = np.ones_like(source, dtype=bool)
        for row, column in (
            (0, 2),
            (1, 0), (1, 1), (1, 2), (1, 3), (1, 4),
            (2, 0), (2, 1), (2, 2), (2, 3), (2, 4),
            (3, 0), (3, 1), (3, 2), (3, 3), (3, 4),
            (4, 2),
        ):
            inner_bool &= padded[row:row + height, column:column + width]
        boundary = source & ~inner_bool
    colors = rgba[:, :, :3][boundary]
    if colors.size == 0:
        return 0.0
    minimum = colors.min(axis=1)
    chroma = colors.max(axis=1) - minimum
    white = (minimum >= 225) & (chroma <= 25)
    return float(np.count_nonzero(white)) / float(len(colors))


def _flat_edge_background_override(rgba: np.ndarray) -> dict[str, object]:
    """Lấy metadata nền nhỏ gọn cho sampler màu của PDF Alpha trung gian.

    QUALITY (feedback 2026-08-19 §STK.MULTI-EDGE01): chế độ nhiều tem đã làm
    trong suốt nền trước khi gọi StickerEngine, nên engine không thể tự suy lại
    màu nền gây halo. Dò trên RGB nguyên tấm tại đây; chỉ truyền nền phẳng, không
    áp một màu đại diện cho nền gradient/hoạ tiết.
    """
    if rgba.ndim != 3 or rgba.shape[2] < 3:
        return {}
    try:
        background = detect_background(
            np.ascontiguousarray(rgba[:, :, :3], dtype=np.uint8)
        )
    except cv2.error:
        logger.warning("Không dò được màu nền khi xuất nhiều tem", exc_info=True)
        return {}
    if background is None or not background.is_flat:
        return {}
    return {
        "edge_background_rgb": tuple(int(value) for value in background.color),
        "edge_background_tolerance": max(0, int(background.tolerance)),
    }


def _merge_edge_background_override(
    override: dict[str, object] | None,
    background: dict[str, object],
) -> dict[str, object] | None:
    """Ghép scalar nền mà không làm mất Bézier preview đã duyệt."""
    merged = dict(background)
    if isinstance(override, dict):
        merged.update(override)
    return merged or None


def _png_pages_to_pdf(
    png_paths: list[Path],
    output_path: Path,
    dpi: float,
    dpi_y: float | None = None,
) -> None:
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    resolved_dpi_y = float(dpi_y if dpi_y is not None else dpi)
    first_size = Image.open(png_paths[0]).size
    writer = canvas.Canvas(
        str(output_path),
        pagesize=(first_size[0] / dpi * 72.0, first_size[1] / resolved_dpi_y * 72.0),
        pageCompression=1,
    )
    for path in png_paths:
        with Image.open(path) as image:
            width_px, height_px = image.size
        width_pt = width_px / dpi * 72.0
        height_pt = height_px / resolved_dpi_y * 72.0
        writer.setPageSize((width_pt, height_pt))
        writer.drawImage(
            ImageReader(str(path)),
            0,
            0,
            width=width_pt,
            height=height_pt,
            preserveAspectRatio=False,
            mask="auto",
        )
        writer.showPage()
    writer.save()
    # COLOR (audit 2026-08-24 §BCOLOR.03): PNG bridge đã là RGB sRGB. Gắn
    # OutputIntent cho PDF trung gian để PDFium/StickerEngine/RIP dùng cùng
    # diễn giải màu; không gán profile này lên artwork CMYK gốc.
    tagged_path = output_path.with_name(output_path.name + ".srgb.tmp")
    try:
        with pikepdf.Pdf.open(output_path) as intermediate:
            if not embed_srgb_output_intent(intermediate, replace_existing=True):
                raise StickerSheetExportError(
                    "Không gắn được profile sRGB cho PDF trung gian của preview."
                )
            intermediate.save(tagged_path)
        tagged_path.replace(output_path)
    finally:
        tagged_path.unlink(missing_ok=True)


def _zip_pngs(png_paths: list[Path], output_path: Path) -> None:
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in png_paths:
            archive.write(path, arcname=path.name)


def _solid_cmyk_to_rgb(cmyk: tuple[float, float, float, float]) -> tuple[int, int, int]:
    """Đổi CMYK 0–100 sang RGB 8-bit cho phần raster bù xén."""
    c, m, y, k = (max(0.0, min(100.0, float(value))) / 100.0 for value in cmyk)
    return (
        round(255.0 * (1.0 - c) * (1.0 - k)),
        round(255.0 * (1.0 - m) * (1.0 - k)),
        round(255.0 * (1.0 - y) * (1.0 - k)),
    )


def _can_preserve_existing_cut(
    session: StickerSheetSession,
    *,
    edits: list[dict[str, object]],
    output_format: str,
    cut_mode: str,
    offset_mm: float,
    bleed_mm: float,
    corner_style: str,
    crop_to_sticker: bool,
    draw_cut_contour: bool,
    preserve_existing_cut: bool,
) -> bool:
    reference = session.manifest.get("vector_geometry_ref")
    return bool(
        preserve_existing_cut
        and output_format == "pdf"
        and session.source_kind == "pdf"
        and session.boundary_source == "existing-cut"
        and isinstance(reference, dict)
        and reference.get("kind") == "pdf-cut-contours"
        and reference.get("preserve_original") is True
        and not edits
        and cut_mode == "original"
        and abs(float(offset_mm)) <= 1e-9
        and abs(float(bleed_mm)) <= 1e-9
        and corner_style in {"preserve", "original"}
        and not crop_to_sticker
        and draw_cut_contour
    )


def _copy_preserved_pdf_page(
    session: StickerSheetSession,
    output_path: Path,
) -> None:
    """Giữ nguyên content stream CutContour; không đi qua extractor/polyline."""
    source_path = Path(session.source_path)
    source_page = int(session.manifest.get("source_page", 1)) - 1
    with pikepdf.Pdf.open(source_path) as document:
        if source_page < 0 or source_page >= len(document.pages):
            raise StickerSheetExportError("Trang PDF nguồn để giữ CutContour không còn hợp lệ.")
        if len(document.pages) == 1:
            # File một trang được sao chép byte-for-byte, giữ cả OCG, OutputIntent,
            # page box và cubic gốc của khách hàng.
            shutil.copyfile(source_path, output_path)
            return
        del document.pages[source_page + 1:]
        del document.pages[:source_page]
        document.save(output_path)


def _page_expansion_points(cut_mode: str, offset_mm: float, bleed_mm: float) -> float:
    mm_to_points = 2.83465
    bleed_points = float(bleed_mm) * mm_to_points
    effective_offset_mm = float(offset_mm) - (
        ALPHA_CONTOUR_INSET_MM if cut_mode == "alpha" else 0.0
    )
    if cut_mode == "none":
        return max(0.0, bleed_points)
    cut_edge, outer_edge = compute_cut_bleed_offsets(
        cut_mode,
        bleed_points,
        effective_offset_mm * mm_to_points,
    )
    return max(0.0, cut_edge, outer_edge)


def _page_session_view(
    session: StickerSheetSession,
    page: StickerSheetPageState,
) -> StickerSheetSession:
    """Tạo view tương thích cho helper export một trang, không đổi session gốc."""
    return replace(
        session,
        directory=page.directory,
        analysis_source_path=page.analysis_source_path,
        original_width_px=page.original_width_px,
        original_height_px=page.original_height_px,
        analysis_width_px=page.analysis_width_px,
        analysis_height_px=page.analysis_height_px,
        preview_width_px=page.preview_width_px,
        preview_height_px=page.preview_height_px,
        dpi=page.dpi,
        stage=page.stage,
        boundary_source=page.boundary_source,
        strategy_confidence=page.strategy_confidence,
        needs_review=page.needs_review,
        manifest=page.manifest,
        legacy_active_page=page.page_number,
        pages={page.page_number: page},
    )


def _cutline_overrides_with_preview_fallback(
    session: StickerSheetSession,
    page: StickerSheetPageState,
    *,
    page_number: int,
    revision: int,
    edits: list[dict[str, object]],
    instance_ids: list[int],
    crop_to_sticker: bool,
    dpi: float,
    dpi_y: float,
    offset_mm: float,
    bleed_mm: float,
    cut_mode: str,
    corner_style: str,
    fill_holes: bool,
    cutline_smoothness: float,
    cutline_fidelity: float,
    curve_tension: float,
    min_detail_area_mm2: float,
) -> list[dict[str, object]] | None:
    """Bảo đảm export trực tiếp cũng dùng đúng preview exact-geometry.

    Frontend thường tạo cache trước khi bật nút xuất. API vẫn phải an toàn khi bị
    gọi trực tiếp hoặc cache bị dọn; khi đó dựng cùng preview worker một lần rồi
    đọc lại cache, tránh âm thầm fit lại từ PNG điểm ảnh.
    """
    cache_key = _cutline_export_cache_key(
        page_number=page_number,
        revision=revision,
        edits=edits,
        dpi=dpi,
        dpi_y=dpi_y,
        offset_mm=offset_mm,
        bleed_mm=bleed_mm,
        cut_mode=cut_mode,
        corner_style=corner_style,
        fill_holes=fill_holes,
        cutline_smoothness=cutline_smoothness,
        cutline_fidelity=cutline_fidelity,
        curve_tension=curve_tension,
        min_detail_area_mm2=min_detail_area_mm2,
    )
    overrides = _cutline_overrides_from_preview_cache(
        page,
        cache_key=cache_key,
        instance_ids=instance_ids,
        crop_to_sticker=crop_to_sticker,
        dpi=dpi,
        dpi_y=dpi_y,
    )
    if overrides is not None:
        return overrides

    # Import trễ để giữ module phụ thuộc hai chiều ở mức runtime, không tạo vòng
    # import khi endpoint preview nạp các helper export dùng chung.
    from app.workers.sticker_cutline_preview import build_sticker_cutline_preview

    build_sticker_cutline_preview(
        _page_session_view(session, page),
        page_number=page_number,
        base_revision=revision,
        edits=edits,
        dpi=dpi,
        dpi_y=dpi_y,
        offset_mm=offset_mm,
        bleed_mm=bleed_mm,
        cut_mode=cut_mode,
        corner_style=corner_style,
        fill_holes=fill_holes,
        cutline_smoothness=cutline_smoothness,
        cutline_fidelity=cutline_fidelity,
        curve_tension=curve_tension,
        min_detail_area_mm2=min_detail_area_mm2,
    )
    return _cutline_overrides_from_preview_cache(
        page,
        cache_key=cache_key,
        instance_ids=instance_ids,
        crop_to_sticker=crop_to_sticker,
        dpi=dpi,
        dpi_y=dpi_y,
    )


def _build_cutline_pdf_from_pngs(
    png_paths: list[Path],
    work_dir: Path,
    *,
    dpi: float,
    dpi_y: float,
    offset_mm: float,
    bleed_mm: float,
    cut_mode: str,
    corner_style: str,
    fill_holes: bool,
    crop_to_sticker: bool,
    bleed_color_type: str,
    solid_bleed_cmyk: tuple[float, float, float, float],
    shape_mode: str,
    draw_cut_contour: bool,
    cutline_smoothness: float = 50.0,
    cutline_fidelity: float = 50.0,
    curve_tension: float = 50.0,
    min_detail_area_mm2: float = 1.0,
    presmooth_alpha: bool = False,
    alpha_path_override_sequence: list[dict[str, object] | None] | None = None,
) -> Path:
    source_pdf = work_dir / f"tem_alpha_{uuid.uuid4().hex[:8]}.pdf"
    output_path = work_dir / f"tem_cutcontour_{uuid.uuid4().hex[:8]}.pdf"
    _png_pages_to_pdf(png_paths, source_pdf, dpi, dpi_y)
    alpha_corner_policy = resolve_sticker_corner_policy(
        cut_mode,
        False,
        False,
        shape_mode,
        corner_style,
    )
    alpha_path_overrides: dict[int, dict] = {}
    if (
        alpha_path_override_sequence is not None
        and len(alpha_path_override_sequence) != len(png_paths)
    ):
        raise StickerSheetExportError(
            "Dữ liệu đường bế xem trước không khớp số trang cần xuất."
        )
    # Metadata màu nền vẫn cần khi người dùng chỉ tạo bleed mà không vẽ dao cắt.
    for page_index in range(len(png_paths)):
        cached_override = (
            alpha_path_override_sequence[page_index]
            if alpha_path_override_sequence is not None
            else None
        )
        if isinstance(cached_override, dict):
            scalar_payload = {
                key: cached_override[key]
                for key in (
                    "edge_background_rgb",
                    "edge_background_tolerance",
                )
                if key in cached_override
            }
            if scalar_payload:
                alpha_path_overrides[page_index] = scalar_payload
    if cut_mode != "none" and draw_cut_contour:
        for page_index, png_path in enumerate(png_paths):
            cached_override = (
                alpha_path_override_sequence[page_index]
                if alpha_path_override_sequence is not None
                else None
            )
            if (
                isinstance(cached_override, dict)
                and _valid_cutline_path_groups(cached_override.get("path_groups"))
            ):
                # PERF (audit 2026-08-10 §CUTLINE.EXPORT3): dùng chính Bézier
                # người dùng vừa xem; chỉ fit những PNG không có cache hợp lệ.
                alpha_path_overrides.setdefault(page_index, {})[
                    "path_groups"
                ] = cached_override["path_groups"]
                continue
            with Image.open(png_path) as opened:
                alpha = np.asarray(opened.convert("RGBA"), dtype=np.uint8)[:, :, 3]
            try:
                cutline = build_alpha_cutline_geometry(
                    alpha,
                    dpi=dpi,
                    dpi_y=dpi_y,
                    cut_mode=cut_mode,
                    offset_mm=offset_mm,
                    bleed_mm=bleed_mm,
                    corner_style=corner_style,
                    fill_holes=fill_holes,
                    cutline_smoothness=cutline_smoothness,
                    cutline_fidelity=cutline_fidelity,
                    curve_tension=curve_tension,
                    min_detail_area_mm2=min_detail_area_mm2,
                    presmooth_alpha=presmooth_alpha,
                )
            except UnsafeCutlineGeometryError as exc:
                raise StickerSheetExportError(str(exc)) from exc
            if cutline is None or not cutline["path_groups"]:
                # QUALITY (audit 2026-08-10 §CUTSMOOTH.3): thiếu override phải
                # dừng xuất; nếu đi tiếp, StickerEngine sẽ âm thầm fit lần hai.
                raise StickerSheetExportError(
                    f"Không tạo được đường bế an toàn cho tem {page_index + 1}."
                )
            alpha_path_overrides.setdefault(page_index, {})[
                "path_groups"
            ] = cutline["path_groups"]

    def _process_cutline() -> tuple[bool, dict]:
        return StickerEngine(dpi=_sticker_engine_dpi(dpi, dpi_y)).process_pdf(
            input_path=str(source_pdf),
            output_path=str(output_path),
            cut_mode=cut_mode,
            offset_mm=offset_mm,
            corner_style=corner_style,
            bleed_mm=bleed_mm,
            fill_holes=fill_holes,
            remove_white_bg=False,
            bleed_color_type=bleed_color_type,
            solid_bleed_color=_solid_cmyk_to_rgb(solid_bleed_cmyk),
            draw_cut_contour=draw_cut_contour,
            rectangle_mode=False,
            shape_mode=shape_mode,
            alpha_corner_policy=alpha_corner_policy,
            alpha_source_pixel_mm=max(25.4 / float(dpi), 25.4 / float(dpi_y)),
            alpha_source_mode=True,
            cutline_smoothness=cutline_smoothness,
            cutline_fidelity=cutline_fidelity,
            curve_tension=curve_tension,
            min_detail_area_mm2=min_detail_area_mm2,
            alpha_path_overrides=alpha_path_overrides,
        )

    try:
        success, meta = _process_cutline()
    except cv2.error:
        logger.warning("OpenCV lỗi khi xuất tem; dọn bộ nhớ và thử lại một lần", exc_info=True)
        output_path.unlink(missing_ok=True)
        gc.collect()
        try:
            success, meta = _process_cutline()
        except cv2.error as retry_error:
            raise StickerSheetExportError(
                "Không tạo được đường cắt vì bộ nhớ xử lý đang bận. "
                "Hãy đóng bớt tài liệu lớn rồi thử lại."
            ) from retry_error
    if not success or not output_path.is_file():
        detail = meta.get("error") if isinstance(meta, dict) else None
        raise StickerSheetExportError(str(detail or "Không tạo được PDF CutContour."))
    if not crop_to_sticker:
        restore_sticker_page_canvas(
            str(source_pdf),
            str(output_path),
            expansion_pts=_page_expansion_points(cut_mode, offset_mm, bleed_mm),
        )
    return output_path


def _merge_pdf_fragments(fragments: list[Path], output_path: Path) -> None:
    if not fragments:
        raise StickerSheetExportError("Không có trang tem nào để ghép vào PDF kết quả.")
    if len(fragments) == 1:
        shutil.copyfile(fragments[0], output_path)
        return
    document = pikepdf.Pdf.new()
    try:
        for fragment in fragments:
            with pikepdf.Pdf.open(fragment) as source:
                document.pages.extend(source.pages)
        # Các fragment của cầu PNG đều RGB sRGB; giữ một OutputIntent chung
        # sau khi ghép để preview/export không đổi cách diễn giải màu ở seam.
        if not document.Root.get("/OutputIntents") and not embed_srgb_output_intent(
            document,
            replace_existing=False,
        ):
            raise StickerSheetExportError(
                "Không gắn được profile sRGB cho PDF ghép nhiều trang."
            )
        document.save(output_path)
    finally:
        document.close()


def export_sticker_sheet_document(
    session: StickerSheetSession,
    *,
    pages: list[dict[str, object]],
    page_order: list[int],
    dpi: float,
    dpi_y: float | None = None,
    offset_mm: float,
    bleed_mm: float,
    output_format: str,
    cut_mode: str = "original",
    corner_style: str = "preserve",
    fill_holes: bool = True,
    crop_to_sticker: bool = True,
    bleed_color_type: str = "auto",
    solid_bleed_cmyk: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0),
    shape_mode: str = "contour",
    draw_cut_contour: bool = True,
    preserve_existing_cut: bool = True,
    cutline_smoothness: float = 50.0,
    cutline_fidelity: float = 50.0,
    curve_tension: float = 50.0,
    min_detail_area_mm2: float = 1.0,
) -> StickerSheetExportResult:
    """Xuất nhiều trang atomically; mask keyed theo trang, thứ tự có thể lặp/đổi."""
    configs = {int(item["source_page"]): item for item in pages}
    if not configs:
        raise StickerSheetExportError("Chưa có trang nào được chọn để xuất.")
    ordered_pages = page_order or list(configs)
    unknown = sorted(set(ordered_pages) - set(configs))
    if unknown:
        raise StickerSheetExportError(
            "Thiếu dữ liệu vùng tem cho trang " + ", ".join(str(page) for page in unknown)
        )

    unique_pages: dict[int, StickerSheetPageState] = {}
    for page_number, config in configs.items():
        page = session.pages.get(page_number)
        if page is None:
            raise StickerSheetExportError(f"Trang {page_number} không tồn tại trong tài liệu nguồn.")
        unique_pages[page_number] = page

    # UIUX (audit 2026-08-09 §MP.3-5): khóa theo thứ tự số trang để snapshot
    # revision/artifact của toàn lần xuất nhất quán mà không tạo deadlock.
    with ExitStack() as locks:
        for page_number in sorted(unique_pages):
            locks.enter_context(unique_pages[page_number].operation_lock)
        for page_number, page in unique_pages.items():
            expected_revision = int(configs[page_number].get("expected_revision", 0))
            actual_revision = int(page.manifest.get("mask_revision", 0))
            if page.stage != "mask-ready":
                raise StickerSheetExportError(
                    f"Trang {page_number} chưa được xác nhận vùng tem."
                )
            if expected_revision != actual_revision:
                raise StickerSheetExportError(
                    f"Bản xem trước trang {page_number} đã thay đổi. Hãy kiểm tra lại trước khi xuất."
                )

        export_dir = session.directory / f"export_document_{uuid.uuid4().hex[:12]}"
        export_dir.mkdir(parents=True, exist_ok=False)
        final_path: Path | None = None
        try:
            fragments: list[Path] = []
            all_png_paths: list[Path] = []
            segment_paths: list[Path] = []
            segment_overrides: list[dict[str, object] | None] = []
            segment_key: tuple[
                str, float, float, float, float, float, float, bool,
            ] | None = None
            sticker_count = 0

            def flush_raster_segment() -> None:
                nonlocal segment_paths, segment_overrides, segment_key
                if not segment_paths or segment_key is None:
                    return
                (
                    resolved_bleed_type,
                    segment_dpi,
                    segment_dpi_y,
                    segment_smoothness,
                    segment_fidelity,
                    segment_tension,
                    segment_min_detail,
                    segment_presmooth,
                ) = segment_key
                fragments.append(_build_cutline_pdf_from_pngs(
                    segment_paths,
                    export_dir,
                    dpi=segment_dpi,
                    dpi_y=segment_dpi_y,
                    offset_mm=offset_mm,
                    bleed_mm=bleed_mm,
                    cut_mode=cut_mode,
                    corner_style=corner_style,
                    fill_holes=fill_holes,
                    crop_to_sticker=crop_to_sticker,
                    bleed_color_type=resolved_bleed_type,
                    solid_bleed_cmyk=solid_bleed_cmyk,
                    shape_mode=shape_mode,
                    draw_cut_contour=draw_cut_contour,
                    cutline_smoothness=segment_smoothness,
                    cutline_fidelity=segment_fidelity,
                    curve_tension=segment_tension,
                    min_detail_area_mm2=segment_min_detail,
                    presmooth_alpha=segment_presmooth,
                    alpha_path_override_sequence=segment_overrides,
                ))
                segment_paths = []
                segment_overrides = []
                segment_key = None

            for logical_index, page_number in enumerate(ordered_pages, start=1):
                page = unique_pages[page_number]
                config = configs[page_number]
                edits = list(config.get("edits") or [])
                page_view = _page_session_view(session, page)
                can_preserve = _can_preserve_existing_cut(
                    page_view,
                    edits=edits,
                    output_format=output_format,
                    cut_mode=cut_mode,
                    offset_mm=offset_mm,
                    bleed_mm=bleed_mm,
                    corner_style=corner_style,
                    crop_to_sticker=crop_to_sticker,
                    draw_cut_contour=draw_cut_contour,
                    preserve_existing_cut=preserve_existing_cut,
                )
                if can_preserve:
                    flush_raster_segment()
                    preserved_path = export_dir / f"trang_{logical_index:04d}_goc.pdf"
                    _copy_preserved_pdf_page(page_view, preserved_path)
                    fragments.append(preserved_path)
                    sticker_count += len(page.manifest.get("instances", []))
                    continue

                original_labels = np.load(page.directory / "labels.npy", allow_pickle=False)
                valid_ids = {
                    int(instance["id"])
                    for instance in page.manifest.get("instances", [])
                }
                labels = apply_export_edits(original_labels, edits, valid_ids)
                rgba = _build_edited_rgba(page_view, original_labels, labels)
                edge_background_override = _flat_edge_background_override(rgba)
                page_dpi = float(config.get("dpi") or dpi)
                page_dpi_y = float(config.get("dpi_y") or dpi_y or page_dpi)
                png_paths, page_sticker_count = _prepare_output_pngs(
                    export_dir,
                    rgba,
                    labels,
                    page_dpi,
                    page_dpi_y,
                    output_format=output_format,
                    crop_to_sticker=crop_to_sticker,
                    filename_prefix=f"trang_{logical_index:03d}_tem",
                )
                sticker_count += page_sticker_count
                all_png_paths.extend(png_paths)
                if output_format == "png_zip":
                    continue
                resolved_bleed_type = bleed_color_type
                if resolved_bleed_type == "auto":
                    resolved_bleed_type = (
                        "solid" if white_boundary_ratio(rgba, labels) >= 0.70 else "image"
                    )
                page_smoothness = float(
                    config.get("cutline_smoothness", cutline_smoothness)
                )
                page_fidelity = float(
                    config.get("cutline_fidelity", cutline_fidelity)
                )
                page_tension = float(
                    config.get("curve_tension", curve_tension)
                )
                page_min_detail = float(
                    config.get("min_detail_area_mm2", min_detail_area_mm2)
                )
                instance_ids = sorted(
                    int(value) for value in np.unique(labels) if int(value) > 0
                )
                page_overrides = None
                if cut_mode != "none" and draw_cut_contour:
                    page_overrides = _cutline_overrides_with_preview_fallback(
                        session,
                        page,
                        page_number=page_number,
                        revision=int(page.manifest.get("mask_revision", 0)),
                        edits=edits,
                        instance_ids=instance_ids,
                        crop_to_sticker=crop_to_sticker,
                        dpi=page_dpi,
                        dpi_y=page_dpi_y,
                        offset_mm=offset_mm,
                        bleed_mm=bleed_mm,
                        cut_mode=cut_mode,
                        corner_style=corner_style,
                        fill_holes=fill_holes,
                        cutline_smoothness=page_smoothness,
                        cutline_fidelity=page_fidelity,
                        curve_tension=page_tension,
                        min_detail_area_mm2=page_min_detail,
                    )
                if page_overrides is None or len(page_overrides) != len(png_paths):
                    page_overrides = [None] * len(png_paths)
                page_overrides = [
                    _merge_edge_background_override(
                        override,
                        edge_background_override,
                    )
                    for override in page_overrides
                ]
                key = (
                    resolved_bleed_type,
                    page_dpi,
                    page_dpi_y,
                    page_smoothness,
                    page_fidelity,
                    page_tension,
                    page_min_detail,
                    # §CUTJAG.1: nguồn biên quyết định có khử răng cưa Alpha hay
                    # không, nên hai trang khác nguồn KHÔNG được gộp cùng segment.
                    should_presmooth_cutline_alpha(page.boundary_source),
                )
                if segment_key is not None and segment_key != key:
                    flush_raster_segment()
                segment_key = key
                segment_paths.extend(png_paths)
                segment_overrides.extend(page_overrides)

            if output_format == "png_zip":
                temporary = export_dir / "tem_tach_nhieu_trang.zip"
                _zip_pngs(all_png_paths, temporary)
                final_path = session.directory / f"tem_tach_{uuid.uuid4().hex[:8]}.zip"
                temporary.replace(final_path)
                return StickerSheetExportResult(
                    path=final_path,
                    filename="tem_tach.png.zip",
                    media_type="application/zip",
                    sticker_count=sticker_count,
                )

            flush_raster_segment()
            temporary = export_dir / "tem_cutcontour_nhieu_trang.pdf"
            _merge_pdf_fragments(fragments, temporary)
            final_path = session.directory / f"tem_cutcontour_{uuid.uuid4().hex[:8]}.pdf"
            temporary.replace(final_path)
            return StickerSheetExportResult(
                path=final_path,
                filename=(
                    "tem_tach_cutcontour.pdf"
                    if crop_to_sticker
                    else "tem_giu_nguyen_cutcontour.pdf"
                ),
                media_type="application/pdf",
                sticker_count=sticker_count,
            )
        finally:
            shutil.rmtree(export_dir, ignore_errors=True)


def export_sticker_sheet(
    session: StickerSheetSession,
    *,
    edits: list[dict[str, object]],
    dpi: float,
    dpi_y: float | None = None,
    offset_mm: float,
    bleed_mm: float,
    output_format: str,
    cut_mode: str = "original",
    corner_style: str = "preserve",
    fill_holes: bool = True,
    crop_to_sticker: bool = True,
    bleed_color_type: str = "auto",
    solid_bleed_cmyk: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0),
    shape_mode: str = "contour",
    draw_cut_contour: bool = True,
    preserve_existing_cut: bool = True,
    cutline_smoothness: float = 50.0,
    cutline_fidelity: float = 50.0,
    curve_tension: float = 50.0,
    min_detail_area_mm2: float = 1.0,
) -> StickerSheetExportResult:
    """Xuất artifact vào session; caller chịu trách nhiệm phục vụ file."""
    if _can_preserve_existing_cut(
        session,
        edits=edits,
        output_format=output_format,
        cut_mode=cut_mode,
        offset_mm=offset_mm,
        bleed_mm=bleed_mm,
        corner_style=corner_style,
        crop_to_sticker=crop_to_sticker,
        draw_cut_contour=draw_cut_contour,
        preserve_existing_cut=preserve_existing_cut,
    ):
        output_path = session.directory / f"tem_cutcontour_goc_{uuid.uuid4().hex[:8]}.pdf"
        _copy_preserved_pdf_page(session, output_path)
        return StickerSheetExportResult(
            path=output_path,
            filename="tem_giu_nguyen_cutcontour.pdf",
            media_type="application/pdf",
            sticker_count=len(session.manifest.get("instances", [])),
        )

    original_labels = np.load(session.directory / "labels.npy", allow_pickle=False)
    valid_ids = {
        int(instance["id"])
        for instance in session.manifest.get("instances", [])
    }
    labels = apply_export_edits(original_labels, edits, valid_ids)
    rgba = _build_edited_rgba(session, original_labels, labels)
    edge_background_override = _flat_edge_background_override(rgba)
    use_white_bleed = white_boundary_ratio(rgba, labels) >= 0.70

    export_dir = session.directory / f"export_{uuid.uuid4().hex[:12]}"
    export_dir.mkdir(parents=True, exist_ok=False)
    try:
        resolved_dpi_y = float(dpi_y if dpi_y is not None else dpi)
        png_paths, sticker_count = _prepare_output_pngs(
            export_dir,
            rgba,
            labels,
            dpi,
            resolved_dpi_y,
            output_format=output_format,
            crop_to_sticker=crop_to_sticker,
        )
        if output_format == "png_zip":
            output_path = session.directory / f"tem_tach_{uuid.uuid4().hex[:8]}.zip"
            _zip_pngs(png_paths, output_path)
            return StickerSheetExportResult(
                path=output_path,
                filename="tem_tach.png.zip",
                media_type="application/zip",
                sticker_count=sticker_count,
            )

        source_pdf = export_dir / "tem_alpha.pdf"
        output_path = session.directory / f"tem_cutcontour_{uuid.uuid4().hex[:8]}.pdf"
        _png_pages_to_pdf(png_paths, source_pdf, dpi, resolved_dpi_y)
        resolved_bleed_color_type = bleed_color_type
        if resolved_bleed_color_type == "auto":
            resolved_bleed_color_type = "solid" if use_white_bleed else "image"
        alpha_corner_policy = resolve_sticker_corner_policy(
            cut_mode,
            False,
            False,
            shape_mode,
            corner_style,
        )
        alpha_path_overrides: dict[int, dict] = {}
        preview_override_sequence: list[dict[str, object]] | None = None
        page = session.pages.get(session.legacy_active_page)
        if page is not None and cut_mode != "none" and draw_cut_contour:
            preview_override_sequence = _cutline_overrides_with_preview_fallback(
                session,
                page,
                page_number=page.page_number,
                revision=int(page.manifest.get("mask_revision", 0)),
                edits=edits,
                instance_ids=sorted(
                    int(value) for value in np.unique(labels) if int(value) > 0
                ),
                crop_to_sticker=crop_to_sticker,
                dpi=dpi,
                dpi_y=resolved_dpi_y,
                offset_mm=offset_mm,
                bleed_mm=bleed_mm,
                cut_mode=cut_mode,
                corner_style=corner_style,
                fill_holes=fill_holes,
                cutline_smoothness=cutline_smoothness,
                cutline_fidelity=cutline_fidelity,
                curve_tension=curve_tension,
                min_detail_area_mm2=min_detail_area_mm2,
            )
            if (
                preview_override_sequence is not None
                and len(preview_override_sequence) != len(png_paths)
            ):
                preview_override_sequence = None
        if preview_override_sequence is None:
            preview_override_sequence = [None] * len(png_paths)
        preview_override_sequence = [
            _merge_edge_background_override(
                override,
                edge_background_override,
            )
            for override in preview_override_sequence
        ]
        for page_index, override in enumerate(preview_override_sequence):
            if isinstance(override, dict):
                scalar_payload = {
                    key: override[key]
                    for key in (
                        "edge_background_rgb",
                        "edge_background_tolerance",
                    )
                    if key in override
                }
                if scalar_payload:
                    alpha_path_overrides[page_index] = scalar_payload
        if cut_mode != "none" and draw_cut_contour:
            for page_index, png_path in enumerate(png_paths):
                cached_override = (
                    preview_override_sequence[page_index]
                    if preview_override_sequence is not None
                    else None
                )
                if (
                    isinstance(cached_override, dict)
                    and _valid_cutline_path_groups(cached_override.get("path_groups"))
                ):
                    alpha_path_overrides.setdefault(page_index, {})[
                        "path_groups"
                    ] = cached_override["path_groups"]
                    continue
                with Image.open(png_path) as opened:
                    alpha = np.asarray(
                        opened.convert("RGBA"),
                        dtype=np.uint8,
                    )[:, :, 3]
                try:
                    cutline = build_alpha_cutline_geometry(
                        alpha,
                        dpi=dpi,
                        dpi_y=resolved_dpi_y,
                        cut_mode=cut_mode,
                        offset_mm=offset_mm,
                        bleed_mm=bleed_mm,
                        corner_style=corner_style,
                        fill_holes=fill_holes,
                        cutline_smoothness=cutline_smoothness,
                        cutline_fidelity=cutline_fidelity,
                        curve_tension=curve_tension,
                        min_detail_area_mm2=min_detail_area_mm2,
                        presmooth_alpha=should_presmooth_cutline_alpha(
                            page.boundary_source if page is not None else None
                        ),
                    )
                except UnsafeCutlineGeometryError as exc:
                    raise StickerSheetExportError(str(exc)) from exc
                if cutline is None or not cutline["path_groups"]:
                    # QUALITY (audit 2026-08-10 §CUTSMOOTH.3): export legacy
                    # cũng không được bỏ override rồi tự fit đường khác.
                    raise StickerSheetExportError(
                        f"Không tạo được đường bế an toàn cho tem {page_index + 1}."
                    )
                alpha_path_overrides.setdefault(page_index, {})[
                    "path_groups"
                ] = cutline["path_groups"]

        def _process_cutline() -> tuple[bool, dict]:
            return StickerEngine(
                dpi=_sticker_engine_dpi(dpi, resolved_dpi_y)
            ).process_pdf(
                input_path=str(source_pdf),
                output_path=str(output_path),
                cut_mode=cut_mode,
                offset_mm=offset_mm,
                corner_style=corner_style,
                bleed_mm=bleed_mm,
                fill_holes=fill_holes,
                remove_white_bg=False,
                bleed_color_type=resolved_bleed_color_type,
                solid_bleed_color=_solid_cmyk_to_rgb(solid_bleed_cmyk),
                draw_cut_contour=draw_cut_contour,
                rectangle_mode=False,
                shape_mode=shape_mode,
                # QUALITY (audit 2026-08-08 §UNIFIED.7): cùng policy C2 với engine
                # chính; kiểu góc do người dùng chọn, không còn hardcode theo nguồn AI.
                alpha_corner_policy=alpha_corner_policy,
                # QUALITY (audit 2026-08-05 §AI2.CUT2): ngưỡng làm mượt không được
                # nhỏ hơn chi tiết một pixel nguồn, nhất là ảnh không DPI đang giữ 72 DPI.
                alpha_source_pixel_mm=max(25.4 / float(dpi), 25.4 / resolved_dpi_y),
                # QUALITY (audit 2026-08-08 §UNIFIED.ALPHA1): mọi trang trung gian
                # đều là PNG RGBA đã chốt mask. Đọc chính Alpha này cho contour;
                # ``cut_mode`` chỉ quyết định vị trí dao/bleed, không sở hữu nguồn biên.
                alpha_source_mode=True,
                cutline_smoothness=cutline_smoothness,
                cutline_fidelity=cutline_fidelity,
                curve_tension=curve_tension,
                min_detail_area_mm2=min_detail_area_mm2,
                alpha_path_overrides=alpha_path_overrides,
            )

        try:
            success, meta = _process_cutline()
        except cv2.error:
            # STABILITY (audit 2026-08-05 §AI2.EXPORT2): cv2 có thể lỗi cấp phát nhất
            # thời khi worker vừa giải phóng raster. Dọn artifact dở và thử đúng một lần;
            # lần hai vẫn lỗi thì trả thông báo nghiệp vụ thay vì HTTP 500 `(error)`.
            logger.warning("OpenCV lỗi khi xuất tem; dọn bộ nhớ và thử lại một lần", exc_info=True)
            output_path.unlink(missing_ok=True)
            gc.collect()
            try:
                success, meta = _process_cutline()
            except cv2.error as retry_error:
                raise StickerSheetExportError(
                    "Không tạo được đường cắt vì bộ nhớ xử lý đang bận. "
                    "Hãy đóng bớt tài liệu lớn rồi thử lại."
                ) from retry_error
        if not success or not output_path.is_file():
            detail = meta.get("error") if isinstance(meta, dict) else None
            raise StickerSheetExportError(str(detail or "Không tạo được PDF CutContour."))
        if not crop_to_sticker:
            restore_sticker_page_canvas(
                str(source_pdf),
                str(output_path),
                expansion_pts=_page_expansion_points(cut_mode, offset_mm, bleed_mm),
            )
        return StickerSheetExportResult(
            path=output_path,
            filename=(
                "tem_tach_cutcontour.pdf"
                if crop_to_sticker
                else "tem_giu_nguyen_cutcontour.pdf"
            ),
            media_type="application/pdf",
            sticker_count=sticker_count,
        )
    except BaseException:
        # Chỉ dọn thư mục trung gian của lần export; session và artifact cũ vẫn giữ.
        if export_dir.exists():
            shutil.rmtree(export_dir)
        raise
    finally:
        if export_dir.exists():
            shutil.rmtree(export_dir)
