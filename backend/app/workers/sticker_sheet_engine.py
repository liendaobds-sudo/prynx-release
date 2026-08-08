"""Tách từng tem từ một ảnh mockup phẳng và chuẩn hóa mask để tạo CutContour.

Engine AI chỉ tạo alpha gợi ý. Quyết định instance, loại bóng alpha thấp và thứ tự
tem được xử lý xác định bằng OpenCV để kết quả có thể kiểm thử và tái lập.
"""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Callable, Literal

import cv2
import numpy as np
from PIL import Image


StickerSheetModel = Literal["birefnet-lite", "birefnet-full", "isnet"]

DEFAULT_MODEL: StickerSheetModel = "birefnet-lite"
DEFAULT_ALPHA_THRESHOLD = 128
MIN_COMPONENT_AREA_RATIO = 0.001
MIN_COMPONENT_AREA_PX = 64
SOFT_EDGE_RADIUS_PX = 2
MAX_UNCERTAIN_ALPHA = 207
MIN_UNCERTAIN_ALPHA = 48

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


class StickerSheetError(RuntimeError):
    """Lỗi nghiệp vụ có thể chuyển thành thông báo ngắn cho người dùng."""


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


BackgroundRunner = Callable[[Image.Image, StickerSheetModel], Image.Image]


def _run_background_model(image: Image.Image, model: StickerSheetModel) -> Image.Image:
    """Gọi lazy để import engine không nạp ONNX Runtime khi chỉ chạy test hình học."""
    if model == "isnet":
        from app.workers.isnet_engine import remove_background

        return remove_background(image)

    from app.workers.birefnet_engine import remove_background

    variant = "full" if model == "birefnet-full" else "lite"
    return remove_background(image, variant=variant)


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
    scaled = (
        (raw_alpha.astype(np.float32) - MIN_UNCERTAIN_ALPHA)
        * (255.0 / float(MAX_UNCERTAIN_ALPHA - MIN_UNCERTAIN_ALPHA))
    )
    scaled = np.clip(scaled, 0.0, 255.0).astype(np.uint8)
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
    luma = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
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
    for record in records:
        component = raw_labels == record["raw_id"]
        refined = _remove_attached_neutral_shadow(source_rgb, component)
        if not np.array_equal(refined, component):
            refined_count += 1
        refined_binary[refined] = 255
    return refined_binary, refined_count


def _instance_quality(
    raw_alpha: np.ndarray,
    labels: np.ndarray,
    sticker_id: int,
) -> tuple[float, float]:
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
    runner = model_runner or _run_background_model
    model_started = time.perf_counter()
    model_result = runner(source, model).convert("RGBA")
    model_seconds = time.perf_counter() - model_started
    if model_result.size != source.size:
        raise StickerSheetError("Mask AI không khớp kích thước ảnh nguồn.")

    post_started = time.perf_counter()
    model_array = np.asarray(model_result, dtype=np.uint8)
    source_rgb = np.asarray(source, dtype=np.uint8)
    raw_alpha = model_array[:, :, 3]
    binary = np.where(raw_alpha >= int(alpha_threshold), 255, 0).astype(np.uint8)
    min_area = max(
        MIN_COMPONENT_AREA_PX,
        int(binary.size * float(min_component_area_ratio)),
    )
    records, raw_labels = _component_records(binary, min_area)
    if records:
        refined_binary, _refined_shadow_count = _refine_attached_shadows(
            source_rgb,
            records,
            raw_labels,
        )
        if _refined_shadow_count > 0:
            refined_records, refined_raw_labels = _component_records(
                refined_binary,
                min_area,
            )
            # §AI-SHADOW.1: số instance là hợp đồng cứng. Nếu hậu xử lý làm đổi
            # số tem thì bỏ toàn bộ lượt bóc bóng và giữ nguyên kết quả model.
            if len(refined_records) == len(records):
                records, raw_labels = refined_records, refined_raw_labels
    labels, ordered = _build_labels(records, raw_labels, binary.shape)
    if not ordered:
        raise StickerSheetError(
            "Không nhận diện được tem. Hãy chọn ảnh rõ hơn hoặc dùng công cụ Giữ lại."
        )

    clean_alpha = _clean_alpha(raw_alpha, labels)
    # COLOR (audit 2026-08-05 §AI2.COLOR1): model chỉ quyết định Alpha. RGB do
    # model hậu xử lý có thể khử nhiễm/đổi màu mép và không được thay artwork gốc.
    result_array = np.dstack((source_rgb, clean_alpha)).astype(np.uint8, copy=False)
    uncertainty = np.where(
        (labels > 0)
        & (raw_alpha >= MIN_UNCERTAIN_ALPHA)
        & (raw_alpha <= MAX_UNCERTAIN_ALPHA),
        255,
        0,
    ).astype(np.uint8)

    instances: list[StickerInstance] = []
    for sticker_id, record in enumerate(ordered, start=1):
        confidence, uncertain_ratio = _instance_quality(raw_alpha, labels, sticker_id)
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
    )
