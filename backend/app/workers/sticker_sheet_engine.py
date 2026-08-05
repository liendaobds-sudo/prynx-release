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
    raw_alpha = model_array[:, :, 3]
    binary = np.where(raw_alpha >= int(alpha_threshold), 255, 0).astype(np.uint8)
    min_area = max(
        MIN_COMPONENT_AREA_PX,
        int(binary.size * float(min_component_area_ratio)),
    )
    records, raw_labels = _component_records(binary, min_area)
    labels, ordered = _build_labels(records, raw_labels, binary.shape)
    if not ordered:
        raise StickerSheetError(
            "Không nhận diện được tem. Hãy chọn ảnh rõ hơn hoặc dùng công cụ Giữ lại."
        )

    clean_alpha = _clean_alpha(raw_alpha, labels)
    # COLOR (audit 2026-08-05 §AI2.COLOR1): model chỉ quyết định Alpha. RGB do
    # model hậu xử lý có thể khử nhiễm/đổi màu mép và không được thay artwork gốc.
    source_rgb = np.asarray(source, dtype=np.uint8)
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
