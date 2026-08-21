"""Tách từng tem từ một ảnh mockup phẳng và chuẩn hóa mask để tạo CutContour.

Engine AI chỉ tạo alpha gợi ý. Quyết định instance, loại bóng alpha thấp và thứ tự
tem được xử lý xác định bằng OpenCV để kết quả có thể kiểm thử và tái lập.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import logging
from pathlib import Path
import threading
import time
from typing import Callable, Literal
import uuid

import cv2
import numpy as np
from PIL import Image

from app.config import settings


StickerSheetModel = Literal["birefnet-lite", "birefnet-full", "isnet"]
StickerShadowCleanup = Literal["off", "auto"]

DEFAULT_MODEL: StickerSheetModel = "birefnet-lite"
DEFAULT_ALPHA_THRESHOLD = 128
MIN_COMPONENT_AREA_RATIO = 0.001
MIN_COMPONENT_AREA_PX = 64
SOFT_EDGE_RADIUS_PX = 2
MAX_UNCERTAIN_ALPHA = 207
MIN_UNCERTAIN_ALPHA = 48

# PERF/STABILITY (feedback 2026-08-20 §CUTPREVIEW.MEM1): scale Alpha bằng LUT
# 256 byte thay vì dựng một bản sao float32 toàn trang. Khi model AI vừa nhả peak
# bộ nhớ, chính bản sao nhỏ này từng là cấp phát cuối làm request preview văng 500.
_SOFT_ALPHA_SCALE_LUT = np.clip(
    (np.arange(256, dtype=np.float32) - MIN_UNCERTAIN_ALPHA)
    * (255.0 / float(MAX_UNCERTAIN_ALPHA - MIN_UNCERTAIN_ALPHA)),
    0.0,
    255.0,
).astype(np.uint8)

logger = logging.getLogger(__name__)

# PERF (audit 2026-08-10 §AI-SPEED.1): cache đúng Alpha model, không cache
# CutContour hay mask đã chỉnh. Key gồm pixel RGB, model/weights và mọi tham số
# ảnh hưởng vùng bóng; cleanup chung của RESULTS_DIR tự xóa file sau 26 giờ.
_AI_ALPHA_CACHE_VERSION = "2026-08-10-v1"
_AI_ALPHA_CACHE_ROOT = Path(settings.RESULTS_DIR) / "sticker_ai_alpha_cache"
_AI_ALPHA_CACHE_LOCKS: dict[str, threading.Lock] = {}
_AI_ALPHA_CACHE_LOCKS_GUARD = threading.Lock()

# QUALITY (audit 2026-08-08 §AI-SHADOW.1): bóng đổ do ảnh mockup thường là
# một dải xám trung tính nối trực tiếp với biên ngoài của mask AI. Chỉ bóc dải
# này khi sau bóc xuất hiện một mép trắng liên tục, sạch hơn rõ rệt; như vậy
# viền trắng thật, artwork tối màu và hình không có bóng đều có đường lui an toàn.
_SHADOW_LUMA_MIN = 96
_SHADOW_LUMA_MAX = 248
_SHADOW_CHROMA_MAX = 16
_SHADOW_EXPAND_LUMA_MAX = 252
_SHADOW_EXPAND_CHROMA_MAX = 18
_SHADOW_MIN_BOUNDARY_EVIDENCE_RATIO = 0.05
_SHADOW_MIN_AREA_RATIO = 0.002
_SHADOW_MAX_AREA_RATIO = 0.35
_SHADOW_MIN_RETAINED_AREA_RATIO = 0.65
_SHADOW_CLEAN_BOUNDARY_WHITE_RATIO = 0.88
_SHADOW_BOUNDARY_WHITE_GAIN = 0.08
_SHADOW_MAX_FRAGMENT_AREA_RATIO = 0.0005
_SHADOW_ROI_MARGIN_PX = 2


class StickerSheetError(RuntimeError):
    """Lỗi nghiệp vụ có thể chuyển thành thông báo ngắn cho người dùng."""


def _is_background_model_memory_error(error: BaseException) -> bool:
    """Nhận lỗi cấp phát ONNX/DirectML mà không phụ thuộc lớp exception của runtime."""
    if isinstance(error, MemoryError):
        return True
    message = str(error).lower().replace("_", " ")
    return any(marker in message for marker in (
        "8007000e",
        "not enough memory",
        "out of memory",
        "bfc arena",
        "bfcarena",
        "bad alloc",
        "bad allocation",
        "failed to allocate",
        "unable to allocate",
        "allocate buffer with requested bytes",
        "paging file is too small",
    ))


@dataclass(frozen=True)
class StickerInstance:
    id: int
    x: int
    y: int
    width: int
    height: int
    area_px: int
    confidence: float
    uncertain_ratio: float

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return self.x, self.y, self.width, self.height


@dataclass
class StickerSheetAnalysis:
    width: int
    height: int
    model: StickerSheetModel
    rgba: np.ndarray
    alpha: np.ndarray
    labels: np.ndarray
    uncertainty: np.ndarray
    instances: list[StickerInstance]
    model_seconds: float
    postprocess_seconds: float
    warnings: list[str]
    # UIUX (audit 2026-08-09 §AI-PREVIEW.1): giữ Alpha gốc và vùng bóng đã được
    # guard chấp nhận để tinh chỉnh preview mà không phải chạy lại mô hình AI.
    raw_alpha: np.ndarray | None = None
    shadow_exclusion: np.ndarray | None = None
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD
    shadow_cleanup: StickerShadowCleanup = "auto"


BackgroundRunner = Callable[[Image.Image, StickerSheetModel], Image.Image]


def _run_background_model(image: Image.Image, model: StickerSheetModel) -> Image.Image:
    """Gọi lazy để import engine không nạp ONNX Runtime khi chỉ chạy test hình học."""
    if model == "isnet":
        from app.workers.isnet_engine import predict_alpha

        alpha = predict_alpha(image)
    else:
        from app.workers.birefnet_engine import predict_alpha

        variant = "full" if model == "birefnet-full" else "lite"
        alpha = predict_alpha(image, variant=variant)

    # PERF (audit 2026-08-10 §AI-SPEED.2): engine tem chỉ đọc Alpha rồi trả RGB
    # nguồn ở bước cuối. Không chạy refine_foreground_rgba ~0,4 s để tạo RGB model
    # rồi vứt bỏ ngay sau đó.
    result = image.convert("RGBA")
    result.putalpha(alpha)
    return result


# PERF (audit 2026-08-10 §AI-SPEED.1): nhận diện runner chuẩn để cache bền qua
# restart nhưng không nuốt model giả khi test hoặc khi caller thay engine lúc chạy.
_DEFAULT_BACKGROUND_RUNNER = _run_background_model


def _model_cache_revision(model: StickerSheetModel) -> str:
    if model == "isnet":
        from app.workers.isnet_engine import MODEL_SHA256

        return MODEL_SHA256
    from app.workers.birefnet_engine import MODEL_SHA256

    variant = "full" if model == "birefnet-full" else "lite"
    return MODEL_SHA256[variant]


def _ai_alpha_cache_key(
    source_rgb: np.ndarray,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    min_component_area_ratio: float,
) -> str:
    digest = hashlib.sha256()
    digest.update(_AI_ALPHA_CACHE_VERSION.encode("ascii"))
    digest.update(model.encode("ascii"))
    digest.update(_model_cache_revision(model).encode("ascii"))
    digest.update(str(int(alpha_threshold)).encode("ascii"))
    digest.update(f"{float(min_component_area_ratio):.12g}".encode("ascii"))
    digest.update(str(source_rgb.shape).encode("ascii"))
    digest.update(np.ascontiguousarray(source_rgb).data)
    return digest.hexdigest()


def _ai_alpha_cache_lock(cache_key: str) -> threading.Lock:
    with _AI_ALPHA_CACHE_LOCKS_GUARD:
        return _AI_ALPHA_CACHE_LOCKS.setdefault(cache_key, threading.Lock())


def _load_ai_alpha_cache(
    cache_key: str,
    expected_shape: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray] | None:
    cache_path = _AI_ALPHA_CACHE_ROOT / f"{cache_key}.npz"
    if not cache_path.is_file():
        return None
    try:
        with np.load(cache_path, allow_pickle=False) as cached:
            raw_alpha = np.asarray(cached["raw_alpha"], dtype=np.uint8).copy()
            shadow_exclusion = np.asarray(
                cached["shadow_exclusion"],
                dtype=np.uint8,
            ).copy()
        if raw_alpha.shape != expected_shape or shadow_exclusion.shape != expected_shape:
            raise ValueError("Cache Alpha khác kích thước ảnh nguồn")
        cache_path.touch()
        return raw_alpha, shadow_exclusion
    except (OSError, KeyError, ValueError):
        logger.warning("Bỏ cache Alpha tem không hợp lệ: %s", cache_path, exc_info=True)
        try:
            cache_path.unlink(missing_ok=True)
        except OSError:
            pass
        return None


def _store_ai_alpha_cache(
    cache_key: str,
    raw_alpha: np.ndarray,
    shadow_exclusion: np.ndarray,
) -> None:
    cache_path = _AI_ALPHA_CACHE_ROOT / f"{cache_key}.npz"
    temporary = _AI_ALPHA_CACHE_ROOT / f".{cache_key}.{uuid.uuid4().hex}.tmp"
    try:
        _AI_ALPHA_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        with temporary.open("wb") as stream:
            np.savez_compressed(
                stream,
                raw_alpha=np.asarray(raw_alpha, dtype=np.uint8),
                shadow_exclusion=np.asarray(shadow_exclusion, dtype=np.uint8),
            )
        temporary.replace(cache_path)
    except OSError:
        logger.warning("Không ghi được cache Alpha tem: %s", cache_path, exc_info=True)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _component_records(
    binary: np.ndarray,
    min_area: int,
) -> tuple[list[dict[str, int]], np.ndarray]:
    count, raw_labels, stats, _centroids = cv2.connectedComponentsWithStats(
        binary,
        connectivity=8,
    )
    records: list[dict[str, int]] = []
    for raw_id in range(1, count):
        area = int(stats[raw_id, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        records.append(
            {
                "raw_id": raw_id,
                "x": int(stats[raw_id, cv2.CC_STAT_LEFT]),
                "y": int(stats[raw_id, cv2.CC_STAT_TOP]),
                "width": int(stats[raw_id, cv2.CC_STAT_WIDTH]),
                "height": int(stats[raw_id, cv2.CC_STAT_HEIGHT]),
                "area": area,
            }
        )
    return records, raw_labels


def _order_components(records: list[dict[str, int]]) -> list[dict[str, int]]:
    """Đánh số theo hàng trên→dưới, trong hàng trái→phải như người dùng nhìn."""
    if len(records) < 2:
        return records

    median_height = float(np.median([record["height"] for record in records]))
    row_tolerance = max(1.0, median_height * 0.45)
    by_center = sorted(
        records,
        key=lambda record: (record["y"] + record["height"] / 2.0, record["x"]),
    )
    rows: list[list[dict[str, int]]] = []
    row_centers: list[float] = []
    for record in by_center:
        center_y = record["y"] + record["height"] / 2.0
        best_index = -1
        best_distance = float("inf")
        for index, row_center in enumerate(row_centers):
            distance = abs(center_y - row_center)
            if distance <= row_tolerance and distance < best_distance:
                best_index = index
                best_distance = distance
        if best_index < 0:
            rows.append([record])
            row_centers.append(center_y)
            continue
        rows[best_index].append(record)
        row_centers[best_index] = float(
            np.mean([
                item["y"] + item["height"] / 2.0
                for item in rows[best_index]
            ])
        )

    ordered_rows = sorted(zip(row_centers, rows), key=lambda item: item[0])
    return [
        record
        for _center, row in ordered_rows
        for record in sorted(row, key=lambda item: item["x"])
    ]


def _build_labels(
    records: list[dict[str, int]],
    raw_labels: np.ndarray,
    shape: tuple[int, int],
) -> tuple[np.ndarray, list[dict[str, int]]]:
    labels = np.zeros(shape, dtype=np.uint16)
    ordered = _order_components(records)
    if not ordered:
        return labels, ordered
    for sticker_id, record in enumerate(ordered, start=1):
        labels[raw_labels == record["raw_id"]] = sticker_id
    return labels, ordered


def _clean_alpha(raw_alpha: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """Giữ antialias sát mép nhưng loại bóng alpha thấp nằm xa silhouette."""
    accepted = np.where(labels > 0, 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (SOFT_EDGE_RADIUS_PX * 2 + 1, SOFT_EDGE_RADIUS_PX * 2 + 1),
    )
    soft_support = cv2.dilate(accepted, kernel, iterations=1) > 0
    scaled = _SOFT_ALPHA_SCALE_LUT[np.asarray(raw_alpha, dtype=np.uint8)]
    return np.where(soft_support, scaled, 0).astype(np.uint8)


def _boundary_white_ratio(source_rgb: np.ndarray, component: np.ndarray) -> float:
    """Đo phần mép trong gần-trắng; mask rỗng trả 0 để guard tự từ chối."""
    component_u8 = np.where(component, 255, 0).astype(np.uint8)
    if not np.any(component_u8):
        return 0.0
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    inner = cv2.erode(component_u8, kernel, iterations=1)
    boundary = (component_u8 > 0) & (inner == 0)
    colors = source_rgb[:, :, :3][boundary]
    if colors.size == 0:
        return 0.0
    minimum = colors.min(axis=1)
    chroma = colors.max(axis=1) - minimum
    white = (minimum >= 225) & (chroma <= 25)
    return float(np.count_nonzero(white)) / float(len(colors))


def _remove_attached_neutral_shadow(
    source_rgb: np.ndarray,
    component: np.ndarray,
    *,
    luma: np.ndarray | None = None,
    chroma: np.ndarray | None = None,
) -> np.ndarray:
    """Bóc bóng xám nối biên nhưng chỉ nhận kết quả còn nguyên một vỏ tem trắng.

    Phép flood chỉ đi qua dải xám trung tính chạm biên ngoài, nên chữ đen hoặc
    chi tiết tối nằm sau viền trắng không bị xem là bóng. Các guard diện tích,
    connectivity và chất lượng mép khiến ca mơ hồ quay về mask AI nguyên bản.
    """
    component_bool = np.asarray(component, dtype=bool)
    component_area = int(np.count_nonzero(component_bool))
    if component_area < MIN_COMPONENT_AREA_PX:
        return component_bool

    rgb = source_rgb[:, :, :3]
    if luma is None:
        luma = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if chroma is None:
        rgb_i16 = rgb.astype(np.int16, copy=False)
        chroma = rgb_i16.max(axis=2) - rgb_i16.min(axis=2)
    component_u8 = component_bool.astype(np.uint8)
    boundary = component_bool & (
        cv2.erode(component_u8, np.ones((3, 3), dtype=np.uint8)) == 0
    )
    boundary_count = int(np.count_nonzero(boundary))
    if boundary_count <= 0:
        return component_bool

    neutral_band = (
        component_bool
        & (luma >= _SHADOW_LUMA_MIN)
        & (luma <= _SHADOW_LUMA_MAX)
        & (chroma <= _SHADOW_CHROMA_MAX)
    )
    boundary_evidence = boundary & neutral_band
    if (
        float(np.count_nonzero(boundary_evidence)) / float(boundary_count)
        < _SHADOW_MIN_BOUNDARY_EVIDENCE_RATIO
    ):
        return component_bool

    count, neutral_labels = cv2.connectedComponents(
        neutral_band.astype(np.uint8),
        connectivity=8,
    )
    if count <= 1:
        return component_bool
    attached_ids = np.unique(neutral_labels[boundary_evidence])
    attached_ids = attached_ids[attached_ids > 0]
    if attached_ids.size == 0:
        return component_bool
    attached_shadow = np.isin(neutral_labels, attached_ids)

    # Nới đúng một pixel qua phần cuối của gradient xám. Dải sáng hơn 252 hoặc
    # có sắc màu là điểm dừng, nên không xuyên qua viền trắng/đường viền màu.
    expanded = cv2.dilate(
        attached_shadow.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    ) > 0
    attached_shadow = (
        expanded
        & component_bool
        & (luma <= _SHADOW_EXPAND_LUMA_MAX)
        & (chroma <= _SHADOW_EXPAND_CHROMA_MAX)
    )
    shadow_area = int(np.count_nonzero(attached_shadow))
    shadow_ratio = float(shadow_area) / float(component_area)
    if not _SHADOW_MIN_AREA_RATIO <= shadow_ratio <= _SHADOW_MAX_AREA_RATIO:
        return component_bool

    refined = component_bool & ~attached_shadow
    retained_ratio = float(np.count_nonzero(refined)) / float(component_area)
    if retained_ratio < _SHADOW_MIN_RETAINED_AREA_RATIO:
        return component_bool

    refined_count, refined_labels, refined_stats, _centroids = (
        cv2.connectedComponentsWithStats(
        refined.astype(np.uint8),
        connectivity=8,
        )
    )
    if refined_count > 2:
        main_id = 1 + int(
            np.argmax(refined_stats[1:, cv2.CC_STAT_AREA])
        )
        fragment_area = int(np.count_nonzero(refined & (refined_labels != main_id)))
        if (
            float(fragment_area) / float(component_area)
            > _SHADOW_MAX_FRAGMENT_AREA_RATIO
        ):
            return component_bool
        refined = refined_labels == main_id
        refined_count = 2
    if refined_count != 2:
        return component_bool

    before_white = _boundary_white_ratio(rgb, component_bool)
    after_white = _boundary_white_ratio(rgb, refined)
    if (
        after_white < _SHADOW_CLEAN_BOUNDARY_WHITE_RATIO
        or after_white - before_white < _SHADOW_BOUNDARY_WHITE_GAIN
    ):
        return component_bool
    return refined


def _refine_attached_shadows(
    source_rgb: np.ndarray,
    records: list[dict[str, int]],
    raw_labels: np.ndarray,
) -> tuple[np.ndarray, int]:
    """Lọc bóng độc lập từng instance; không cho một tem đổi số tem của cả tờ."""
    refined_binary = np.zeros(raw_labels.shape, dtype=np.uint8)
    refined_count = 0
    rgb = source_rgb[:, :, :3]
    luma = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    rgb_i16 = rgb.astype(np.int16, copy=False)
    chroma = rgb_i16.max(axis=2) - rgb_i16.min(axis=2)
    for record in records:
        # PERF (audit 2026-08-10 §AI-SPEED.3): trước đây mỗi tem tạo mask toàn
        # canvas rồi tính lại luma/chroma trên cả tờ. BBox connected-component đã
        # bao trọn cả tem lẫn bóng, nên xử lý ROI cho kết quả pixel tương đương.
        x = int(record["x"])
        y = int(record["y"])
        width = int(record["width"])
        height = int(record["height"])
        left = max(0, x - _SHADOW_ROI_MARGIN_PX)
        top = max(0, y - _SHADOW_ROI_MARGIN_PX)
        right = min(raw_labels.shape[1], x + width + _SHADOW_ROI_MARGIN_PX)
        bottom = min(raw_labels.shape[0], y + height + _SHADOW_ROI_MARGIN_PX)
        roi = np.s_[top:bottom, left:right]
        component = raw_labels[roi] == record["raw_id"]
        refined = _remove_attached_neutral_shadow(
            rgb[roi],
            component,
            luma=luma[roi],
            chroma=chroma[roi],
        )
        if not np.array_equal(refined, component):
            refined_count += 1
        output_roi = refined_binary[roi]
        output_roi[refined] = 255
    return refined_binary, refined_count


def _instance_quality(
    raw_alpha: np.ndarray,
    labels: np.ndarray,
    sticker_id: int,
    *,
    bounds: tuple[int, int, int, int] | None = None,
) -> tuple[float, float]:
    if bounds is not None:
        x, y, width, height = bounds
        raw_alpha = raw_alpha[y:y + height, x:x + width]
        labels = labels[y:y + height, x:x + width]
    component = labels == sticker_id
    if not np.any(component):
        return 0.0, 1.0
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    component_u8 = np.where(component, 255, 0).astype(np.uint8)
    boundary = cv2.subtract(
        cv2.dilate(component_u8, kernel, iterations=1),
        cv2.erode(component_u8, kernel, iterations=1),
    ) > 0
    uncertain = (
        boundary
        & (raw_alpha >= MIN_UNCERTAIN_ALPHA)
        & (raw_alpha <= MAX_UNCERTAIN_ALPHA)
    )
    boundary_count = max(1, int(np.count_nonzero(boundary)))
    uncertain_ratio = float(np.count_nonzero(uncertain)) / boundary_count
    confidence = max(0.0, min(1.0, 1.0 - uncertain_ratio))
    return confidence, uncertain_ratio


def _align_labels_to_reference(
    labels: np.ndarray,
    reference_labels: np.ndarray,
) -> tuple[np.ndarray, dict[int, int]]:
    """Giữ ổn định ID tem và từ chối mức tinh chỉnh làm đổi topology instance."""
    if labels.shape != reference_labels.shape:
        raise StickerSheetError("Mask xem trước không khớp kích thước kết quả hiện tại.")

    new_ids = [int(value) for value in np.unique(labels) if int(value) > 0]
    reference_ids = [
        int(value) for value in np.unique(reference_labels) if int(value) > 0
    ]
    if len(new_ids) != len(reference_ids):
        raise StickerSheetError(
            "Mức bám biên này làm thay đổi số lượng tem. Hãy chọn mức gần hơn."
        )

    mapping: dict[int, int] = {}
    claimed_reference_ids: set[int] = set()
    for new_id in new_ids:
        overlap = reference_labels[labels == new_id]
        overlap = overlap[overlap > 0]
        if overlap.size == 0:
            raise StickerSheetError(
                "Mức bám biên này làm thay đổi vùng tem. Hãy chọn mức gần hơn."
            )
        values = np.unique(overlap)
        if values.size != 1:
            raise StickerSheetError(
                "Mức bám biên này làm nhập các vùng tem. Hãy chọn mức gần hơn."
            )
        reference_id = int(values[0])
        if reference_id in claimed_reference_ids:
            raise StickerSheetError(
                "Mức bám biên này làm nhập hoặc tách vùng tem. Hãy chọn mức gần hơn."
            )
        mapping[new_id] = reference_id
        claimed_reference_ids.add(reference_id)

        new_component = np.where(labels == new_id, 255, 0).astype(np.uint8)
        reference_component = np.where(
            reference_labels == reference_id,
            255,
            0,
        ).astype(np.uint8)
        _new_contours, new_hierarchy = cv2.findContours(
            new_component,
            cv2.RETR_CCOMP,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        _reference_contours, reference_hierarchy = cv2.findContours(
            reference_component,
            cv2.RETR_CCOMP,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        # Alpha JPEG có thể tạo lỗ nhiễu vài pixel rồi tự khép khi threshold đổi.
        # Chỉ xem lỗ đủ lớn như một thay đổi topology có ý nghĩa; ngưỡng này cùng
        # baseline lọc component rời của engine và vẫn chặn lỗ artwork thật.
        new_holes = sum(
            1
            for index, contour in enumerate(_new_contours)
            if new_hierarchy is not None
            and new_hierarchy[0, index, 3] >= 0
            and abs(cv2.contourArea(contour)) >= MIN_COMPONENT_AREA_PX
        )
        reference_holes = sum(
            1
            for index, contour in enumerate(_reference_contours)
            if reference_hierarchy is not None
            and reference_hierarchy[0, index, 3] >= 0
            and abs(cv2.contourArea(contour)) >= MIN_COMPONENT_AREA_PX
        )
        if new_holes != reference_holes:
            raise StickerSheetError(
                "Mức bám biên này làm thay đổi lỗ trong vùng tem. Hãy chọn mức gần hơn."
            )

    if claimed_reference_ids != set(reference_ids):
        raise StickerSheetError(
            "Mức bám biên này làm thay đổi vùng tem. Hãy chọn mức gần hơn."
        )

    aligned = np.zeros(labels.shape, dtype=labels.dtype)
    for new_id, reference_id in mapping.items():
        aligned[labels == new_id] = reference_id
    return aligned, mapping


def _build_analysis_from_raw_alpha(
    source: Image.Image,
    raw_alpha: np.ndarray,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    min_component_area_ratio: float,
    shadow_exclusion: np.ndarray,
    shadow_cleanup: StickerShadowCleanup,
    model_seconds: float,
    post_started: float,
    reference_labels: np.ndarray | None = None,
) -> StickerSheetAnalysis:
    """Dựng mask xác định từ Alpha đã cache; đây là đường chung cho detect và refine."""
    source_rgb = np.asarray(source.convert("RGB"), dtype=np.uint8)
    expected_shape = (source.height, source.width)
    alpha = np.asarray(raw_alpha, dtype=np.uint8)
    exclusion = np.asarray(shadow_exclusion, dtype=np.uint8)
    if alpha.shape != expected_shape or exclusion.shape != expected_shape:
        raise StickerSheetError("Dữ liệu Alpha xem trước không khớp ảnh nguồn.")
    if shadow_cleanup not in ("off", "auto"):
        raise StickerSheetError("Chế độ khử bóng không được hỗ trợ.")

    binary = np.where(alpha >= int(alpha_threshold), 255, 0).astype(np.uint8)
    if shadow_cleanup == "auto":
        # Vùng loại bóng được cố định từ lần AI đầu tiên. Áp nó sau threshold giúp
        # các mức bám biên luôn lồng nhau, không lặp lại guard theo từng vị trí slider.
        binary[exclusion > 0] = 0
    min_area = max(
        MIN_COMPONENT_AREA_PX,
        int(binary.size * float(min_component_area_ratio)),
    )
    records, raw_labels = _component_records(binary, min_area)
    labels, ordered = _build_labels(records, raw_labels, binary.shape)
    if not ordered:
        raise StickerSheetError(
            "Không nhận diện được tem ở mức bám biên này. Hãy chọn mức gần hơn."
        )

    id_mapping = {sticker_id: sticker_id for sticker_id in range(1, len(ordered) + 1)}
    if reference_labels is not None:
        labels, id_mapping = _align_labels_to_reference(labels, reference_labels)

    clean_alpha = _clean_alpha(alpha, labels)
    result_array = np.dstack((source_rgb, clean_alpha)).astype(np.uint8, copy=False)
    uncertainty = np.where(
        (labels > 0)
        & (alpha >= MIN_UNCERTAIN_ALPHA)
        & (alpha <= MAX_UNCERTAIN_ALPHA),
        255,
        0,
    ).astype(np.uint8)

    instances: list[StickerInstance] = []
    for new_id, record in enumerate(ordered, start=1):
        sticker_id = id_mapping[new_id]
        confidence, uncertain_ratio = _instance_quality(
            alpha,
            labels,
            sticker_id,
            bounds=(
                record["x"],
                record["y"],
                record["width"],
                record["height"],
            ),
        )
        instances.append(
            StickerInstance(
                id=sticker_id,
                x=record["x"],
                y=record["y"],
                width=record["width"],
                height=record["height"],
                area_px=record["area"],
                confidence=round(confidence, 6),
                uncertain_ratio=round(uncertain_ratio, 6),
            )
        )
    instances.sort(key=lambda instance: instance.id)

    warnings: list[str] = []
    if model == "isnet":
        warnings.append(
            "Chế độ nhanh có thể chia một tem thành nhiều mảnh; nên dùng Chất lượng cao."
        )
    if len(instances) == 1:
        warnings.append("Chỉ nhận diện được một tem trong ảnh.")

    return StickerSheetAnalysis(
        width=source.width,
        height=source.height,
        model=model,
        rgba=result_array,
        alpha=clean_alpha,
        labels=labels,
        uncertainty=uncertainty,
        instances=instances,
        model_seconds=model_seconds,
        postprocess_seconds=time.perf_counter() - post_started,
        warnings=warnings,
        raw_alpha=alpha.copy(),
        shadow_exclusion=exclusion.copy(),
        alpha_threshold=int(alpha_threshold),
        shadow_cleanup=shadow_cleanup,
    )


def reprocess_sticker_sheet(
    image: Image.Image,
    *,
    raw_alpha: np.ndarray,
    shadow_exclusion: np.ndarray,
    model: StickerSheetModel = DEFAULT_MODEL,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
    shadow_cleanup: StickerShadowCleanup = "auto",
    min_component_area_ratio: float = MIN_COMPONENT_AREA_RATIO,
    reference_labels: np.ndarray | None = None,
) -> StickerSheetAnalysis:
    """Tinh chỉnh mask đã nhận diện mà không gọi lại mô hình AI."""
    if image.width <= 0 or image.height <= 0:
        raise StickerSheetError("Ảnh không có kích thước hợp lệ.")
    if model not in ("birefnet-lite", "birefnet-full", "isnet"):
        raise StickerSheetError("Mô hình tách tem không được hỗ trợ.")
    if not 1 <= int(alpha_threshold) <= 254:
        raise StickerSheetError("Ngưỡng Alpha phải nằm trong khoảng 1–254.")
    if not 0.0 < float(min_component_area_ratio) < 1.0:
        raise StickerSheetError("Tỷ lệ diện tích tem tối thiểu không hợp lệ.")
    return _build_analysis_from_raw_alpha(
        image.convert("RGB"),
        raw_alpha,
        model=model,
        alpha_threshold=alpha_threshold,
        min_component_area_ratio=min_component_area_ratio,
        shadow_exclusion=shadow_exclusion,
        shadow_cleanup=shadow_cleanup,
        model_seconds=0.0,
        post_started=time.perf_counter(),
        reference_labels=reference_labels,
    )


def analyze_sticker_sheet(
    image: Image.Image,
    *,
    model: StickerSheetModel = DEFAULT_MODEL,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
    min_component_area_ratio: float = MIN_COMPONENT_AREA_RATIO,
    model_runner: BackgroundRunner | None = None,
) -> StickerSheetAnalysis:
    """Phân tích ảnh nhiều tem, trả mask instance ở đúng độ phân giải nguồn."""
    if image.width <= 0 or image.height <= 0:
        raise StickerSheetError("Ảnh không có kích thước hợp lệ.")
    if model not in ("birefnet-lite", "birefnet-full", "isnet"):
        raise StickerSheetError("Mô hình tách tem không được hỗ trợ.")
    if not 1 <= int(alpha_threshold) <= 254:
        raise StickerSheetError("Ngưỡng Alpha phải nằm trong khoảng 1–254.")
    if not 0.0 < float(min_component_area_ratio) < 1.0:
        raise StickerSheetError("Tỷ lệ diện tích tem tối thiểu không hợp lệ.")

    source = image.convert("RGB")
    source_rgb = np.asarray(source, dtype=np.uint8)

    def run_uncached(runner: BackgroundRunner) -> StickerSheetAnalysis:
        model_started = time.perf_counter()
        try:
            model_result = runner(source, model).convert("RGBA")
        except StickerSheetError:
            raise
        except Exception as exc:
            if _is_background_model_memory_error(exc):
                # UIUX (feedback 2026-08-16 §WHITE-SHEET.2): giữ stack trong log/exception
                # chain nhưng không để tên lớp ONNX "RuntimeException" lọt ra giao diện.
                logger.exception("Mô hình tách nền không còn đủ bộ nhớ để nhận diện tem")
                raise StickerSheetError(
                    "Máy không còn đủ bộ nhớ để nhận diện vùng tem. "
                    "File gốc vẫn được giữ; hãy đóng bớt ứng dụng hoặc khởi động lại "
                    "PrynX rồi thử lại."
                ) from exc
            raise
        model_seconds = time.perf_counter() - model_started
        if model_result.size != source.size:
            raise StickerSheetError("Mask AI không khớp kích thước ảnh nguồn.")

        post_started = time.perf_counter()
        model_array = np.asarray(model_result, dtype=np.uint8)
        raw_alpha = model_array[:, :, 3].copy()
        # PERF/STABILITY (feedback 2026-08-20 §CUTPREVIEW.MEM3): từ đây màu
        # của output model không còn được dùng. Nhả RGBA sớm để hậu xử lý không
        # chồng thêm labels/mask lên đúng peak RAM của inference.
        del model_array
        model_result.close()
        del model_result
        binary = np.where(raw_alpha >= int(alpha_threshold), 255, 0).astype(np.uint8)
        min_area = max(
            MIN_COMPONENT_AREA_PX,
            int(binary.size * float(min_component_area_ratio)),
        )
        records, raw_labels = _component_records(binary, min_area)
        shadow_exclusion = np.zeros(binary.shape, dtype=np.uint8)
        if records:
            refined_binary, refined_shadow_count = _refine_attached_shadows(
                source_rgb,
                records,
                raw_labels,
            )
            if refined_shadow_count > 0:
                refined_records, _refined_raw_labels = _component_records(
                    refined_binary,
                    min_area,
                )
                # §AI-SHADOW.1: số instance là hợp đồng cứng. Nếu hậu xử lý làm
                # đổi số tem thì bỏ lượt bóc bóng và giữ nguyên kết quả model.
                if len(refined_records) == len(records):
                    shadow_exclusion[(binary > 0) & (refined_binary == 0)] = 255
                del _refined_raw_labels
            del refined_binary

        # `_build_analysis_from_raw_alpha` dựng lại component/labels theo mask
        # đã chốt; giữ prepass này sống trong lúc gọi hàm chỉ làm tăng peak RAM.
        del binary, raw_labels

        # COLOR (audit 2026-08-05 §AI2.COLOR1): model chỉ quyết định Alpha.
        return _build_analysis_from_raw_alpha(
            source,
            raw_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
            min_component_area_ratio=min_component_area_ratio,
            shadow_exclusion=shadow_exclusion,
            shadow_cleanup="auto",
            model_seconds=model_seconds,
            post_started=post_started,
        )

    try:
        # Runner test/custom phải luôn chạy để caller kiểm được đúng một invocation.
        if model_runner is not None:
            return run_uncached(model_runner)

        # Runner bị thay lúc runtime (chủ yếu trong test) không có cùng hợp đồng version
        # với model thật, nên phải chạy trực tiếp thay vì đọc cache persistent của app.
        if _run_background_model is not _DEFAULT_BACKGROUND_RUNNER:
            return run_uncached(_run_background_model)

        cache_key = _ai_alpha_cache_key(
            source_rgb,
            model=model,
            alpha_threshold=alpha_threshold,
            min_component_area_ratio=min_component_area_ratio,
        )
        with _ai_alpha_cache_lock(cache_key):
            cache_started = time.perf_counter()
            cached = _load_ai_alpha_cache(cache_key, (source.height, source.width))
            if cached is not None:
                raw_alpha, shadow_exclusion = cached
                return _build_analysis_from_raw_alpha(
                    source,
                    raw_alpha,
                    model=model,
                    alpha_threshold=alpha_threshold,
                    min_component_area_ratio=min_component_area_ratio,
                    shadow_exclusion=shadow_exclusion,
                    shadow_cleanup="auto",
                    model_seconds=0.0,
                    post_started=cache_started,
                )

            result = run_uncached(_run_background_model)
            if result.raw_alpha is not None and result.shadow_exclusion is not None:
                _store_ai_alpha_cache(
                    cache_key,
                    result.raw_alpha,
                    result.shadow_exclusion,
                )
            return result
    except StickerSheetError:
        raise
    except Exception as exc:
        if _is_background_model_memory_error(exc):
            # STABILITY (feedback 2026-08-20 §CUTPREVIEW.MEM4): lỗi cấp phát
            # trong hậu xử lý cũng phải thành lỗi nghiệp vụ có kiểm soát; trước
            # đây chỉ OOM bên trong ONNX được chuyển đổi, còn NumPy làm route 500.
            logger.exception("Không còn đủ bộ nhớ khi hậu xử lý vùng tem")
            raise StickerSheetError(
                "Máy không còn đủ bộ nhớ để nhận diện vùng tem. "
                "File gốc vẫn được giữ; hãy đóng bớt ứng dụng hoặc khởi động lại "
                "PrynX rồi thử lại."
            ) from exc
        raise
