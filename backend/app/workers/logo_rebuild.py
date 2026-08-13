"""Tiền xử lý ảnh và adapter native cho Phục hồi & Vector hóa Logo."""

from __future__ import annotations

import hashlib
import importlib
import math
import threading
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Callable, Literal
from xml.etree import ElementTree

from PIL import Image, ImageCms, ImageOps

from app.core.system_memory import read_memory_status_mb
from app.schemas.logo_rebuild import LogoPaletteSuggestion, LogoRebuildSettings


class LogoEngineUnavailable(RuntimeError):
    """Bản native hiện tại chưa chứa adapter vector hóa logo."""


class LogoJobConflict(RuntimeError):
    """Một job đang chạy đã dùng cùng mã do frontend cung cấp."""


class LogoJobCancelled(RuntimeError):
    """Người dùng đã hủy job preview."""


class LogoInputError(ValueError):
    """Đầu vào hợp lệ về định dạng nhưng không thể xử lý an toàn."""


@dataclass(frozen=True)
class PreparedLogo:
    width_px: int
    height_px: int
    rgba: bytes
    warnings: list[str]
    physical_width_mm: float | None = None
    physical_height_mm: float | None = None
    work_area_scale: float = 1.0


@dataclass(frozen=True)
class LogoPreviewResult:
    svg: str
    width_px: int
    height_px: int
    warnings: list[str]
    engine: str
    engine_version: str
    status: Literal["ready", "review", "rejected"]
    complexity: dict[str, int | float]
    review_reasons: list[str]
    review_actions: list[str]
    physical_width_mm: float | None = None
    physical_height_mm: float | None = None
    result_schema_version: int | None = None
    artifact_sha256: str | None = None
    preprocess_hash: str | None = None
    native_metrics: dict[str, int | float] | None = None


@dataclass(frozen=True)
class StructuredNativeResult:
    svg: str
    artifact_sha256: str
    width_px: int
    height_px: int
    physical_width_mm: float | None
    physical_height_mm: float | None
    engine: str
    engine_version: str
    preprocess_hash: str
    metrics: dict[str, int | float]
    warnings: list[str]


_ACTIVE_JOBS_LOCK = threading.Lock()
_ACTIVE_JOBS: dict[str, Any] = {}
_LOGO_MEMORY_LOCK = threading.Lock()
_RESERVED_LOGO_MEMORY_MB = 0.0
_PALETTE_KMEANS_LOCK = threading.Lock()
_MAX_PALETTE_SAMPLE_PIXELS = 40_000
_MIN_PALETTE_COVERAGE = 0.01
_MIN_SMALL_ACCENT_COVERAGE = 0.001
_MIN_SMALL_ACCENT_CHROMA = 48.0
_MAX_SMALL_ACCENT_RMS_RGB = 45.0
_MAX_SMALL_ACCENT_SUGGESTIONS = 4
_MERGE_PALETTE_DISTANCE_RGB = 18.0
# LOGO-REBUILD (audit 2026-08-13 §LR4.02): sàn diện tích TUYỆT ĐỐI theo px ảnh
# nguồn (8×8) cho màu nhấn liền khối — các cổng coverage đều tương đối nên dấu
# nhỏ trên scan 2–8K (coverage < 0,1%) sẽ biến mất nếu chỉ xét tỷ lệ.
_MIN_ACCENT_SOURCE_AREA_PX = 64
_MAX_ENGINE_DESPECKLE_AREA_PX = 128
_STRUCTURED_RESULT_SCHEMA_VERSION = 1


def _load_native_module() -> Any:
    try:
        native = importlib.import_module("pdfcompare_native")
    except ImportError as exc:
        raise LogoEngineUnavailable(
            "Lõi vector hóa logo chưa được cài; hãy build lại pdfcompare_native."
        ) from exc
    required = ("LogoVectorizerCancel", "logo_vectorize_rgba", "logo_vectorizer_info")
    if any(not hasattr(native, name) for name in required):
        raise LogoEngineUnavailable(
            "Bản pdfcompare_native hiện tại chưa có adapter vector hóa logo."
        )
    return native


def logo_vectorizer_capabilities() -> dict[str, Any] | None:
    """Đọc khả năng từ chính binary; thiếu engine thì trả ``None`` để UI khóa preview."""

    try:
        native = _load_native_module()
        info = dict(native.logo_vectorizer_info())
        structured_version = int(info.get("structured_result_version", 0))
        if (
            not bool(info.get("structured_result", False))
            or structured_version != _STRUCTURED_RESULT_SCHEMA_VERSION
            or not callable(getattr(native, "logo_vectorize_structured_rgba", None))
        ):
            return None
    except (LogoEngineUnavailable, RuntimeError, TypeError, ValueError, OverflowError):
        return None
    return {
        "engine": str(info.get("core_engine", "prynx-logo-core")),
        "version": str(info.get("core_engine_version", "unknown")),
        "cancellable": bool(info.get("cancellable", False)),
        "structured_result": True,
        "result_schema_version": structured_version,
        "legacy_engine": str(info.get("engine", "vtracer")),
        "legacy_version": str(info.get("version", "unknown")),
    }


def _register_job(job_id: str, token: Any) -> None:
    with _ACTIVE_JOBS_LOCK:
        if job_id in _ACTIVE_JOBS:
            raise LogoJobConflict("Mã job đang được một preview khác sử dụng.")
        _ACTIVE_JOBS[job_id] = token


def _discard_job(job_id: str, token: Any) -> None:
    with _ACTIVE_JOBS_LOCK:
        if _ACTIVE_JOBS.get(job_id) is token:
            _ACTIVE_JOBS.pop(job_id, None)


def cancel_logo_job(job_id: str) -> bool:
    """Hủy một job đang hoạt động; registry không giữ ảnh hoặc SVG."""

    with _ACTIVE_JOBS_LOCK:
        token = _ACTIVE_JOBS.get(job_id)
    if token is None:
        return False
    token.cancel()
    return True


def reserve_logo_job(job_id: str) -> Any:
    """Đăng ký cờ hủy trước khi job vào hàng đợi heavy-job scheduler."""

    native = _load_native_module()
    token = native.LogoVectorizerCancel()
    _register_job(job_id, token)
    return token


def release_logo_job(job_id: str, token: Any) -> None:
    """Dọn reservation ở route nếu worker chưa chạy hoặc thoát trước engine."""

    _discard_job(job_id, token)


def _target_dimensions(
    width: int,
    height: int,
    settings: LogoRebuildSettings,
) -> tuple[int, int]:
    if settings.crop is not None:
        return (
            max(1, round(width * settings.crop.width)),
            max(1, round(height * settings.crop.height)),
        )
    if settings.perspective_points is not None:
        points = [
            (point.x * (width - 1), point.y * (height - 1))
            for point in settings.perspective_points
        ]
        top = math.dist(points[0], points[1])
        right = math.dist(points[1], points[2])
        bottom = math.dist(points[2], points[3])
        left = math.dist(points[3], points[0])
        return max(1, round(max(top, bottom))), max(1, round(max(left, right)))
    return width, height


def _estimated_logo_memory_mb(width: int, height: int) -> float:
    """Ước lượng đỉnh engine + reference/raster QC ở scale 4×."""

    return width * height * 112 / (1024 * 1024)


def _plan_work_size_for_budget(
    width: int,
    height: int,
    total_mb: float,
    usable_mb: float,
) -> tuple[tuple[int, int], list[str]]:
    if width <= 0 or height <= 0:
        raise LogoInputError("Kích thước vùng logo không hợp lệ.")
    estimated_mb = _estimated_logo_memory_mb(width, height)

    if total_mb >= 16 * 1024:
        if estimated_mb > usable_mb:
            raise LogoInputError(
                f"Vùng logo {width}×{height} px cần khoảng {estimated_mb / 1024:.1f} GB RAM "
                "nhưng máy hiện không còn đủ bộ nhớ. Hãy đóng bớt ứng dụng rồi thử lại."
            )
        return (width, height), []

    if estimated_mb <= usable_mb:
        return (width, height), []
    target_pixels = max(1, int(usable_mb * 1024 * 1024 / 112))
    scale = min(1.0, math.sqrt(target_pixels / float(width * height)))
    target = max(1, int(width * scale)), max(1, int(height * scale))
    return target, [
        f"Máy dưới 16 GB RAM: preview được giảm còn {target[0]}×{target[1]} px để tránh hết bộ nhớ."
    ]


def _usable_logo_memory_mb(total_mb: float, available_mb: float) -> float:
    reserve_mb = 512.0 if total_mb < 8 * 1024 else 1024.0
    return max(0.0, available_mb - reserve_mb) * (
        0.55 if total_mb < 8 * 1024 else 0.65
    )


def _plan_work_size(width: int, height: int) -> tuple[tuple[int, int], list[str]]:
    """Lập ngân sách RAM; chỉ máy dưới 16 GB mới tự giảm kích thước."""

    if width <= 0 or height <= 0:
        raise LogoInputError("Kích thước vùng logo không hợp lệ.")
    total_mb, available_mb = read_memory_status_mb()
    if total_mb is None or available_mb is None:
        return (width, height), []
    return _plan_work_size_for_budget(
        width,
        height,
        total_mb,
        _usable_logo_memory_mb(total_mb, available_mb),
    )


@contextmanager
def _reserve_logo_work_size(width: int, height: int):
    """Reserve RAM ước lượng xuyên suốt một lượt engine/QC.

    PERF (audit 2026-08-09 §LR3.01): reservation nguyên tử chặn hai job cùng
    nhìn thấy một lượng RAM trống rồi đồng thời cam kết toàn bộ. Máy mạnh vẫn
    giữ đủ kích thước khi job chạy một mình; job cạnh tranh nhận lỗi có hướng
    xử lý thay vì âm thầm hạ chất lượng.
    """

    global _RESERVED_LOGO_MEMORY_MB

    if width <= 0 or height <= 0:
        raise LogoInputError("Kích thước vùng logo không hợp lệ.")
    total_mb, available_mb = read_memory_status_mb()
    if total_mb is None or available_mb is None:
        # LOGO-REBUILD (audit 2026-08-13 §LR4.05): không đo được RAM thì không
        # lập được ngân sách — giữ NGUYÊN kích thước (không hạ chất lượng máy
        # mạnh) nhưng chỉ cho một job Logo chạy mỗi lúc, tránh hai preview song
        # song cùng cam kết toàn bộ bộ nhớ còn lại.
        estimated_mb = _estimated_logo_memory_mb(width, height)
        with _LOGO_MEMORY_LOCK:
            if _RESERVED_LOGO_MEMORY_MB > 0:
                raise LogoInputError(
                    "Không đo được RAM trống của máy; hãy đợi preview logo đang "
                    "chạy xong rồi thử lại."
                )
            _RESERVED_LOGO_MEMORY_MB += estimated_mb
        try:
            yield (width, height), []
        finally:
            with _LOGO_MEMORY_LOCK:
                _RESERVED_LOGO_MEMORY_MB = max(
                    0.0, _RESERVED_LOGO_MEMORY_MB - estimated_mb
                )
        return

    with _LOGO_MEMORY_LOCK:
        remaining_mb = max(
            0.0,
            _usable_logo_memory_mb(total_mb, available_mb)
            - _RESERVED_LOGO_MEMORY_MB,
        )
        planned_size, warnings = _plan_work_size_for_budget(
            width,
            height,
            total_mb,
            remaining_mb,
        )
        reservation_mb = _estimated_logo_memory_mb(*planned_size)
        _RESERVED_LOGO_MEMORY_MB += reservation_mb
    try:
        yield planned_size, warnings
    finally:
        with _LOGO_MEMORY_LOCK:
            _RESERVED_LOGO_MEMORY_MB = max(
                0.0,
                _RESERVED_LOGO_MEMORY_MB - reservation_mb,
            )


def _upscale_target_dimensions(width: int, height: int) -> tuple[int, int]:
    """Nâng ảnh nhỏ trước khi trace; chỉ máy yếu mới hạ mục tiêu chất lượng."""

    shortest_side = min(width, height)
    if shortest_side >= 600:
        return width, height

    total_mb, _available_mb = read_memory_status_mb()
    target_shortest_side = 1200
    # PERF (audit 2026-07-30 §LG.03): máy mạnh giữ mức chất lượng đầy đủ;
    # chỉ máy dưới 16 GB mới giảm mục tiêu để tránh tạo ảnh làm việc quá lớn.
    if total_mb is not None and total_mb < 8 * 1024:
        target_shortest_side = 600
    elif total_mb is not None and total_mb < 16 * 1024:
        target_shortest_side = 900

    scale = target_shortest_side / shortest_side
    return max(1, round(width * scale)), max(1, round(height * scale))


def _requested_logo_work_size(
    source_bytes: bytes,
    settings: LogoRebuildSettings,
) -> tuple[int, int]:
    """Đọc header để reserve RAM trước khi giải mã/warp ảnh đầy đủ."""

    try:
        with Image.open(BytesIO(source_bytes)) as image:
            width, height = image.size
            if image.getexif().get(274, 1) in (5, 6, 7, 8):
                width, height = height, width
    except (OSError, SyntaxError, ValueError) as exc:
        raise LogoInputError("File ảnh không thể giải mã.") from exc
    selected_width, selected_height = _target_dimensions(width, height, settings)
    return _upscale_target_dimensions(selected_width, selected_height)


def _read_image_dpi(raw: object) -> tuple[float, float] | None:
    if not isinstance(raw, tuple) or len(raw) < 2:
        return None
    try:
        x_dpi, y_dpi = float(raw[0]), float(raw[1])
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x_dpi) or not math.isfinite(y_dpi) or x_dpi <= 0 or y_dpi <= 0:
        return None
    return x_dpi, y_dpi


def _load_logo_image(source_bytes: bytes) -> tuple[Image.Image, tuple[float, float] | None]:
    try:
        with Image.open(BytesIO(source_bytes)) as opened:
            opened.seek(0)
            source_dpi = _read_image_dpi(opened.info.get("dpi"))
            orientation = opened.getexif().get(274, 1)
            image = ImageOps.exif_transpose(opened)
            image.load()
    except (OSError, SyntaxError, ValueError) as exc:
        raise LogoInputError("File ảnh không thể giải mã.") from exc

    if source_dpi is not None and orientation in (5, 6, 7, 8):
        source_dpi = source_dpi[1], source_dpi[0]
    return image, source_dpi


def _convert_to_srgb(image: Image.Image, warnings: list[str]) -> Image.Image:
    has_alpha = image.mode in ("RGBA", "LA") or "transparency" in image.info
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    profile_bytes = image.info.get("icc_profile")
    if profile_bytes:
        try:
            source_profile = ImageCms.ImageCmsProfile(BytesIO(profile_bytes))
            target_profile = ImageCms.createProfile("sRGB")
            # LOGO-REBUILD (audit 2026-07-30 §LG.05): dựng transform từ ảnh
            # nguồn. Convert CMYK sang RGB trước bước này làm profile nguồn vô hiệu.
            color_source = image.convert("RGB") if has_alpha else image
            rgb = ImageCms.profileToProfile(
                color_source,
                source_profile,
                target_profile,
                outputMode="RGB",
                renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            )
        except (OSError, ValueError, ImageCms.PyCMSError):
            rgb = image.convert("RGB")
            warnings.append(
                "Không áp dụng được ICC profile; preview dùng chuyển đổi RGB mặc định nên màu có thể sai."
            )
    else:
        rgb = image.convert("RGB")
    if alpha is not None:
        rgb.putalpha(alpha)
    return rgb


def _apply_crop(image: Image.Image, settings: LogoRebuildSettings) -> Image.Image:
    crop = settings.crop
    if crop is None:
        return image
    width, height = image.size
    left = max(0, min(width - 1, math.floor(crop.x * width)))
    top = max(0, min(height - 1, math.floor(crop.y * height)))
    right = max(left + 1, min(width, math.ceil((crop.x + crop.width) * width)))
    bottom = max(top + 1, min(height, math.ceil((crop.y + crop.height) * height)))
    return image.crop((left, top, right, bottom))


def _apply_perspective(image: Image.Image, settings: LogoRebuildSettings) -> Image.Image:
    points = settings.perspective_points
    if points is None:
        return image

    # OpenCV đã là dependency đóng gói của backend; nạp lười để startup nhẹ.
    import cv2
    import numpy as np

    width, height = image.size
    source = np.float32(
        [[point.x * (width - 1), point.y * (height - 1)] for point in points]
    )
    target_width, target_height = _target_dimensions(width, height, settings)
    destination = np.float32(
        [
            [0, 0],
            [target_width - 1, 0],
            [target_width - 1, target_height - 1],
            [0, target_height - 1],
        ]
    )
    matrix = cv2.getPerspectiveTransform(source, destination)
    array = np.asarray(image)
    corrected = cv2.warpPerspective(
        array,
        matrix,
        (target_width, target_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return Image.fromarray(corrected)


def _correct_illumination(image: Image.Image) -> Image.Image:
    if min(image.size) < 32:
        return image

    import cv2
    import numpy as np

    has_alpha = image.mode == "RGBA"
    array = np.asarray(image.convert("RGBA" if has_alpha else "RGB"))
    rgb = array[:, :, :3]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    lightness = lab[:, :, 0].astype(np.float32)
    sigma = max(5.0, min(image.size) / 30.0)
    background = cv2.GaussianBlur(lightness, (0, 0), sigmaX=sigma, sigmaY=sigma)
    anchor = float(np.median(background))
    lab[:, :, 0] = np.clip(lightness - background + anchor, 0, 255).astype(np.uint8)
    corrected_rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    if has_alpha:
        corrected = np.dstack((corrected_rgb, array[:, :, 3]))
    else:
        corrected = corrected_rgb
    return Image.fromarray(corrected)


def _otsu_threshold(grayscale: Image.Image) -> int | None:
    """Tìm ngưỡng tách hai lớp sáng/tối; ảnh phẳng trả ``None`` để QC từ chối sau."""

    histogram = grayscale.histogram()[:256]
    populated = [index for index, count in enumerate(histogram) if count]
    if len(populated) < 2:
        return None
    total = sum(histogram)
    weighted_total = sum(index * count for index, count in enumerate(histogram))
    background_weight = 0
    background_sum = 0.0
    best_threshold = populated[0]
    best_variance = -1.0
    for threshold, count in enumerate(histogram):
        background_weight += count
        if background_weight == 0:
            continue
        foreground_weight = total - background_weight
        if foreground_weight == 0:
            break
        background_sum += threshold * count
        background_mean = background_sum / background_weight
        foreground_mean = (weighted_total - background_sum) / foreground_weight
        variance = (
            background_weight
            * foreground_weight
            * (background_mean - foreground_mean) ** 2
        )
        if variance > best_variance:
            best_variance = variance
            best_threshold = threshold
    return best_threshold


def _normalize_monochrome_polarity(image: Image.Image) -> tuple[Image.Image, bool]:
    """Đưa nền về trắng và mực về đen theo Otsu + lớp chiếm đa số ở khung ảnh."""

    grayscale = image.convert("L")
    threshold = _otsu_threshold(grayscale)
    if threshold is None:
        return Image.new("RGBA", image.size, (255, 255, 255, 255)), False
    pixels = grayscale.load()
    width, height = grayscale.size
    border_values = [pixels[x, 0] for x in range(width)]
    if height > 1:
        border_values.extend(pixels[x, height - 1] for x in range(width))
    if width > 1:
        border_values.extend(pixels[0, y] for y in range(1, height - 1))
        border_values.extend(pixels[width - 1, y] for y in range(1, height - 1))
    low_is_background = (
        sum(value <= threshold for value in border_values) * 2 >= len(border_values)
    )
    lookup = [
        255 if ((value <= threshold) == low_is_background) else 0
        for value in range(256)
    ]
    return grayscale.point(lookup).convert("RGBA"), True


def _accent_grid_pixel_budget() -> int:
    """Ngân sách lưới dò màu nhấn theo RAM máy.

    PERF (audit 2026-08-13 §LR4.02): máy mạnh dùng lưới lớn (full-res với scan
    tới 16 Mpx) để không mất dấu nhỏ; chỉ máy dưới 16 GB mới giảm. Không đọc
    được RAM thì dùng mức thấp nhất cho an toàn.
    """

    total_mb, _available_mb = read_memory_status_mb()
    if total_mb is None or total_mb < 8 * 1024:
        return 1_000_000
    if total_mb < 16 * 1024:
        return 4_000_000
    return 16_000_000


def suggest_logo_palette(
    source_bytes: bytes,
    settings: LogoRebuildSettings,
) -> tuple[list[LogoPaletteSuggestion], list[str]]:
    """Gợi ý màu pixel sRGB nhìn thấy; người dùng vẫn phải xác nhận trước khi trace."""

    warnings: list[str] = []
    image, _source_dpi = _load_logo_image(source_bytes)
    image = _convert_to_srgb(image, warnings)
    image = _apply_perspective(image, settings)
    image = _apply_crop(image, settings)

    # OpenCV/Numpy đã là dependency đóng gói. Nạp lười để backend khởi động nhẹ.
    import cv2
    import numpy as np

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    sample_rgba = rgba
    sample_height, sample_width = rgba.shape[:2]
    if sample_width * sample_height > _MAX_PALETTE_SAMPLE_PIXELS:
        scale = math.sqrt(
            _MAX_PALETTE_SAMPLE_PIXELS / float(sample_width * sample_height)
        )
        sample_width = max(1, int(sample_width * scale))
        sample_height = max(1, int(sample_height * scale))
        # LOGO-REBUILD (audit 2026-08-09 §LR3.02): giữ lưới không gian để
        # phân biệt dấu màu liền khối với nhiễu JPEG rải rác. NEAREST cũng
        # không kéo RGB ẩn từ pixel alpha=0 vào palette.
        sample_rgba = cv2.resize(
            rgba,
            (sample_width, sample_height),
            interpolation=cv2.INTER_NEAREST,
        )

    visible = sample_rgba[:, :, 3] > 0
    if not bool(np.any(visible)):
        warnings.append("Ảnh không có pixel nhìn thấy để gợi ý màu.")
        return [], warnings

    colors = sample_rgba[visible, :3]
    alpha_weights = sample_rgba[visible, 3].astype(np.float32) / 255.0

    unique_count = len(np.unique(colors, axis=0))
    cluster_count = min(12, unique_count, len(colors))
    samples = colors.astype(np.float32)
    if cluster_count == 1:
        centers = samples[:1]
        labels = np.zeros((len(samples), 1), dtype=np.int32)
    else:
        criteria = (
            cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER,
            30,
            0.5,
        )
        # LOGO-REBUILD (audit 2026-07-30 §LG.04): dùng k tối đa rồi lọc/gộp
        # theo coverage để không cần oracle biết trước số màu như benchmark cũ.
        with _PALETTE_KMEANS_LOCK:
            cv2.setRNGSeed(20260730)
            _compactness, labels, centers = cv2.kmeans(
                samples,
                cluster_count,
                None,
                criteria,
                5,
                cv2.KMEANS_PP_CENTERS,
            )

    weights = np.bincount(
        labels.reshape(-1),
        weights=alpha_weights,
        minlength=cluster_count,
    )
    total_weight = float(alpha_weights.sum())

    merged: list[tuple[Any, float, bool]] = []
    for index in np.argsort(weights)[::-1]:
        coverage = float(weights[index]) / total_weight
        if coverage < _MIN_PALETTE_COVERAGE:
            continue
        center = centers[index].astype(np.float64)
        for merged_index, (existing, existing_coverage, existing_small) in enumerate(
            merged
        ):
            if float(np.linalg.norm(center - existing)) < _MERGE_PALETTE_DISTANCE_RGB:
                combined = existing_coverage + coverage
                merged[merged_index] = (
                    (existing * existing_coverage + center * coverage) / combined,
                    combined,
                    existing_small,
                )
                break
        else:
            merged.append((center, coverage, False))

    # K-means có thể chia một dấu đỏ JPEG thành nhiều cụm đều dưới 0,1% rồi
    # loại hết. Bổ sung detector theo vùng hue liên kết: giữ mảng đủ lớn/sắc,
    # nhưng bỏ nhiễu rời và màu viền gần màu chủ đạo.
    # LOGO-REBUILD (audit 2026-08-13 §LR4.02): detector accent chạy trên lưới
    # RIÊNG dày hơn lưới k-means 40k px (scan lớn bị bóp về 40k làm dấu 15×15
    # chỉ còn ~2 px), kèm sàn diện tích tuyệt đối theo px nguồn vì mọi cổng
    # coverage đều tương đối — dấu rõ trên scan 2–8K vẫn có coverage < 0,1%.
    source_pixel_count = rgba.shape[0] * rgba.shape[1]
    accent_rgba = rgba
    accent_budget = _accent_grid_pixel_budget()
    if source_pixel_count > accent_budget:
        accent_scale = math.sqrt(accent_budget / float(source_pixel_count))
        accent_rgba = cv2.resize(
            rgba,
            (
                max(1, int(rgba.shape[1] * accent_scale)),
                max(1, int(rgba.shape[0] * accent_scale)),
            ),
            interpolation=cv2.INTER_NEAREST,
        )
    accent_grid_pixel_count = accent_rgba.shape[0] * accent_rgba.shape[1]
    accent_visible = accent_rgba[:, :, 3] > 0
    accent_visible_count = int(np.count_nonzero(accent_visible))
    if accent_visible_count:
        accent_rgb = accent_rgba[:, :, :3]
        hsv = cv2.cvtColor(accent_rgb, cv2.COLOR_RGB2HSV)
        hue_bins = ((hsv[:, :, 0].astype(np.int16) + 7) // 15) % 12
        saturated = accent_visible & (hsv[:, :, 1] >= 96) & (hsv[:, :, 2] >= 32)
        minimum_component_pixels = max(8, math.ceil(accent_visible_count * 0.0005))
        absolute_component_floor = max(
            4,
            math.ceil(
                _MIN_ACCENT_SOURCE_AREA_PX
                * (accent_grid_pixel_count / float(source_pixel_count))
            ),
        )
        for hue_bin in range(12):
            mask = (saturated & (hue_bins == hue_bin)).astype(np.uint8)
            if not bool(np.any(mask)):
                continue
            component_count, component_labels, stats, _centroids = (
                cv2.connectedComponentsWithStats(mask, connectivity=8)
            )
            for component_index in range(1, component_count):
                area = int(stats[component_index, cv2.CC_STAT_AREA])
                coverage = area / float(accent_visible_count)
                if coverage >= _MIN_PALETTE_COVERAGE:
                    continue
                meets_relative_floor = (
                    area >= minimum_component_pixels
                    and coverage >= _MIN_SMALL_ACCENT_COVERAGE
                )
                meets_absolute_floor = area >= absolute_component_floor
                if not (meets_relative_floor or meets_absolute_floor):
                    continue
                box_area = max(
                    1,
                    int(stats[component_index, cv2.CC_STAT_WIDTH])
                    * int(stats[component_index, cv2.CC_STAT_HEIGHT]),
                )
                if area / box_area < 0.15:
                    continue
                component_mask = component_labels == component_index
                component_colors = accent_rgb[component_mask].astype(np.float64)
                component_alpha = (
                    accent_rgba[:, :, 3][component_mask].astype(np.float64) / 255.0
                )
                center = np.average(component_colors, axis=0, weights=component_alpha)
                if float(np.max(center) - np.min(center)) < _MIN_SMALL_ACCENT_CHROMA:
                    continue
                rms_distance = math.sqrt(
                    float(
                        np.average(
                            np.sum((component_colors - center) ** 2, axis=1),
                            weights=component_alpha,
                        )
                    )
                )
                if rms_distance > _MAX_SMALL_ACCENT_RMS_RGB:
                    continue
                if any(
                    float(np.linalg.norm(center - existing)) < 48.0
                    for existing, _existing_coverage, _existing_small in merged
                ):
                    continue
                merged.append((center, coverage, True))

    suggestions: list[LogoPaletteSuggestion] = []
    dominant_candidates = sorted(
        (item for item in merged if not item[2]),
        key=lambda item: item[1],
        reverse=True,
    )
    accent_candidates = sorted(
        (item for item in merged if item[2]),
        key=lambda item: item[1],
        reverse=True,
    )[:_MAX_SMALL_ACCENT_SUGGESTIONS]
    # Màu nhấn đã vượt cổng liên kết/sắc độ phải có chỗ trong giới hạn 12 màu,
    # không lại bị top-coverage loại lần hai.
    selected = sorted(
        [
            *dominant_candidates[: 12 - len(accent_candidates)],
            *accent_candidates,
        ],
        key=lambda item: item[1],
        reverse=True,
    )
    for center, coverage, _is_small_accent in selected:
        red, green, blue = (
            int(np.clip(np.rint(channel), 0, 255)) for channel in center
        )
        suggestions.append(
            LogoPaletteSuggestion(
                color=f"#{red:02x}{green:02x}{blue:02x}",
                coverage_ratio=round(coverage, 6),
            )
        )
    small_accent_count = sum(1 for _center, _coverage, is_small in selected if is_small)
    if small_accent_count:
        warnings.append(
            f"Đã giữ {small_accent_count} màu nhấn nhỏ dưới 1% vì tạo vùng màu "
            "liên kết và có sắc độ rõ; hãy kiểm tra trước khi áp dụng palette."
        )
    return suggestions, warnings


def prepare_logo_image(
    source_bytes: bytes,
    settings: LogoRebuildSettings,
    planned_size: tuple[int, int] | None = None,
    memory_warnings: list[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> PreparedLogo:
    def _cancel_checkpoint() -> None:
        # LOGO-REBUILD (audit 2026-08-13 §LR4.04): ICC, warp phối cảnh CUBIC,
        # resize và illumination Gaussian có thể kéo dài nhiều giây trên scan
        # lớn; nút Hủy phải cắt được GIỮA các bước thay vì đợi hết prepare.
        if cancel_check is not None and cancel_check():
            raise LogoJobCancelled("Đã hủy preview logo.")

    warnings: list[str] = []
    image, source_dpi = _load_logo_image(source_bytes)
    _cancel_checkpoint()
    image = _convert_to_srgb(image, warnings)
    _cancel_checkpoint()
    image = _apply_perspective(image, settings)
    _cancel_checkpoint()
    image = _apply_crop(image, settings)
    physical_width_mm = settings.physical_width_mm
    physical_height_mm = settings.physical_height_mm
    if physical_width_mm is not None and physical_height_mm is not None:
        source_ratio = image.width / image.height
        physical_ratio = physical_width_mm / physical_height_mm
        # LOGO-ENGINE-V2 (audit 2026-08-11 Lô G2): khớp tolerance writer
        # Rust để input sai tỷ lệ bị chặn ở backend thay vì thành lỗi ABI 500.
        if not math.isclose(source_ratio, physical_ratio, rel_tol=0.0001):
            raise LogoInputError(
                "Kích thước in đã xác nhận không khớp tỷ lệ ảnh; hãy khóa tỷ lệ "
                "rộng/cao rồi nhập lại."
            )
    elif source_dpi is not None:
        suggested_width_mm = image.width * 25.4 / source_dpi[0]
        suggested_height_mm = image.height * 25.4 / source_dpi[1]
        # LOGO-REBUILD (audit 2026-08-09 §LR3.03): DPI ảnh web/JPEG chỉ là
        # gợi ý; không được âm thầm biến thành kích thước in của artifact.
        warnings.append(
            "DPI nguồn chỉ gợi ý kích thước "
            f"{suggested_width_mm:.2f}×{suggested_height_mm:.2f} mm; SVG chưa "
            "gắn kích thước in cho tới khi người dùng xác nhận rộng/cao mm."
        )
    else:
        warnings.append(
            "Chưa xác nhận kích thước in rộng/cao mm; SVG tạm dùng đơn vị pixel."
        )

    source_work_area = image.width * image.height
    requested_size = _upscale_target_dimensions(*image.size)
    if planned_size is None:
        planned_size, local_memory_warnings = _plan_work_size(*requested_size)
        warnings.extend(local_memory_warnings)
    else:
        warnings.extend(memory_warnings or [])
    if image.size != planned_size:
        _cancel_checkpoint()
        is_upscale = planned_size[0] > image.width or planned_size[1] > image.height
        image = image.resize(
            planned_size,
            Image.Resampling.NEAREST if is_upscale else Image.Resampling.LANCZOS,
        )
        if is_upscale:
            warnings.append(
                "Ảnh nhỏ đã được nâng bằng nội suy giữ biên lên "
                f"{planned_size[0]}×{planned_size[1]} px trước khi dựng nét."
            )
    _cancel_checkpoint()
    rgba = image.convert("RGBA")
    alpha_minimum, alpha_maximum = rgba.getchannel("A").getextrema()
    if alpha_maximum == 0:
        # LOGO-REBUILD (audit 2026-08-02 §LR2.02): VTracer không có cluster
        # khi toàn bộ alpha bằng 0 và dependency có thể panic trước khi trả lỗi.
        raise LogoInputError(
            "Ảnh hoặc vùng đã chọn không có pixel nhìn thấy; hãy chọn lại vùng có nội dung."
        )
    has_transparency = alpha_minimum < 255
    if settings.illumination_correction:
        if has_transparency:
            # LOGO-REBUILD (audit 2026-07-29 §VL.ALPHA): cân bằng trường sáng là
            # bộ lọc high-pass; áp lên artwork alpha sẽ xóa ruột mảng đặc, chỉ còn viền.
            warnings.append(
                "Ảnh có nền trong suốt: đã bỏ qua cân bằng ánh sáng để giữ nguyên mảng logo."
            )
        else:
            rgba = _correct_illumination(rgba).convert("RGBA")
    _cancel_checkpoint()

    if settings.mode == "monochrome":
        if has_transparency:
            # Binary frontend của VTracer chỉ đọc RGB. Ghép alpha lên trắng để
            # pixel trong suốt không bị hiểu nhầm là mực đen.
            white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            rgba = Image.alpha_composite(white, rgba)
        rgba, normalized = _normalize_monochrome_polarity(rgba)
        if normalized:
            # LOGO-REBUILD (audit 2026-08-03 §LR2.04): fixed threshold 128 làm
            # mất logo sáng hoặc nuốt nền tối. Chuẩn hóa hai lớp trước khi vào native.
            warnings.append(
                "Đã tự xác định nền sáng/tối và chuẩn hóa mực đen cho chế độ đơn sắc."
            )
        if settings.engine == "prynx_core":
            # LOGO-ENGINE-V2 (audit 2026-08-11 Lô G2): Silhouette core trace
            # alpha mask; chuyển nền trắng/mực đen đã chuẩn hóa thành alpha,
            # không để nền opaque biến thành một outer phủ toàn canvas.
            alpha_mask = ImageOps.invert(rgba.convert("L"))
            if alpha_mask.getextrema()[1] == 0:
                raise LogoInputError(
                    "Không tách được mảng logo đơn sắc khỏi nền; hãy chọn lại vùng hoặc dùng chế độ màu."
                )
            core_rgba = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
            core_rgba.putalpha(alpha_mask)
            rgba = core_rgba

    return PreparedLogo(
        width_px=rgba.width,
        height_px=rgba.height,
        rgba=rgba.tobytes(),
        warnings=warnings,
        physical_width_mm=physical_width_mm,
        physical_height_mm=physical_height_mm,
        work_area_scale=(rgba.width * rgba.height) / source_work_area,
    )


def _scaled_despeckle_size(
    source_size_px: int,
    work_area_scale: float,
) -> int:
    """Quy đổi cạnh hạt từ ảnh nguồn sang ảnh làm việc; VTracer tự bình phương cạnh."""

    if source_size_px <= 0:
        return 0
    scaled = max(1, round(source_size_px * math.sqrt(work_area_scale)))
    return min(_MAX_ENGINE_DESPECKLE_AREA_PX, scaled)


def _format_svg_number(value: float) -> str:
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _apply_svg_geometry(svg: str, prepared: PreparedLogo) -> str:
    """Gắn hệ tọa độ ổn định; mm chỉ đến từ xác nhận tường minh của người dùng."""

    try:
        root = ElementTree.fromstring(svg)
    except ElementTree.ParseError as exc:
        raise RuntimeError("Engine trả về SVG không thể phân tích.") from exc
    ElementTree.register_namespace("", "http://www.w3.org/2000/svg")
    root.set("viewBox", f"0 0 {prepared.width_px} {prepared.height_px}")
    if prepared.physical_width_mm is not None and prepared.physical_height_mm is not None:
        root.set("width", f"{_format_svg_number(prepared.physical_width_mm)}mm")
        root.set("height", f"{_format_svg_number(prepared.physical_height_mm)}mm")
    else:
        root.set("width", str(prepared.width_px))
        root.set("height", str(prepared.height_px))
    return ElementTree.tostring(root, encoding="unicode")


def _strip_svg_background(svg: str, background_color: str) -> tuple[str, int]:
    """Bỏ nền ngoài và dùng các vùng nền bên trong làm mask khoét lỗ."""

    try:
        root = ElementTree.fromstring(svg)
    except ElementTree.ParseError as exc:
        raise RuntimeError("Engine trả về SVG không thể phân tích.") from exc
    namespace = "http://www.w3.org/2000/svg"
    qualified = lambda name: f"{{{namespace}}}{name}"
    ElementTree.register_namespace("", namespace)
    normalized = background_color.lower()
    matches: list[tuple[ElementTree.Element, ElementTree.Element]] = []
    for parent in root.iter():
        for child in list(parent):
            if child.attrib.get("fill", "").lower() == normalized:
                matches.append((parent, child))
    if not matches:
        return svg, 0

    # LOGO-REBUILD (audit 2026-08-02 §LR2.01): VTracer có thể gộp nền ngoài
    # và counter/hole vào MỘT compound path. Khi đó phải dùng nguyên topology
    # path làm vùng khoét; xóa cả thẻ sẽ làm lộ layer màu phủ kín bên dưới.
    cutout_shapes = [
        deepcopy(child)
        for index, (_, child) in enumerate(matches)
        if index > 0
        or (
            child.tag == qualified("path")
            and sum(command in "Mm" for command in child.attrib.get("d", "")) > 1
        )
    ]
    for parent, child in matches:
        parent.remove(child)

    if cutout_shapes:
        drawable_tags = {qualified("path"), qualified("g")}
        drawable = [child for child in list(root) if child.tag in drawable_tags]
        if drawable:
            definitions = root.find(qualified("defs"))
            if definitions is None:
                definitions = ElementTree.Element(qualified("defs"))
                root.insert(0, definitions)
            mask_id = "prynx-background-cutout"
            mask = ElementTree.SubElement(
                definitions,
                qualified("mask"),
                {"id": mask_id, "maskUnits": "userSpaceOnUse"},
            )
            view_box = root.attrib.get("viewBox", "").split()
            if len(view_box) == 4:
                mask_x, mask_y, mask_width, mask_height = view_box
            else:
                mask_x, mask_y = "0", "0"
                mask_width = root.attrib.get("width", "100%")
                mask_height = root.attrib.get("height", "100%")
            ElementTree.SubElement(
                mask,
                qualified("rect"),
                {
                    "x": mask_x,
                    "y": mask_y,
                    "width": mask_width,
                    "height": mask_height,
                    "fill": "#ffffff",
                },
            )
            for shape in cutout_shapes:
                shape.set("fill", "#000000")
                mask.append(shape)
            group = ElementTree.Element(
                qualified("g"),
                {"mask": f"url(#{mask_id})"},
            )
            for child in drawable:
                root.remove(child)
                group.append(child)
            root.append(group)

    return ElementTree.tostring(root, encoding="unicode"), len(matches)


def _structured_mapping(value: object, field: str) -> dict[str, Any]:
    try:
        mapped = dict(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Structured result thiếu object {field} hợp lệ.") from exc
    return mapped


def _structured_int(value: object, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RuntimeError(f"Structured result có {field} không hợp lệ.")
    return value


def _structured_float(
    value: object,
    field: str,
    *,
    minimum: float = 0.0,
    maximum: float | None = None,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"Structured result có {field} không hợp lệ.")
    parsed = float(value)
    if (
        not math.isfinite(parsed)
        or parsed < minimum
        or (maximum is not None and parsed > maximum)
    ):
        raise RuntimeError(f"Structured result có {field} không hợp lệ.")
    return parsed


def _structured_hash(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise RuntimeError(f"Structured result có {field} không hợp lệ.")
    normalized = value.lower()
    if len(normalized) != 64 or any(ch not in "0123456789abcdef" for ch in normalized):
        raise RuntimeError(f"Structured result có {field} không hợp lệ.")
    return normalized


def _parse_structured_native_result(
    raw: object,
    prepared: PreparedLogo,
    settings: LogoRebuildSettings,
    info: dict[str, Any],
) -> StructuredNativeResult:
    """Fail-closed trước khi dữ liệu native đi vào response/API."""

    result = _structured_mapping(raw, "gốc")
    schema_version = _structured_int(result.get("schema_version"), "schema_version", minimum=1)
    if schema_version != _STRUCTURED_RESULT_SCHEMA_VERSION:
        raise RuntimeError("Structured result dùng schema version không được hỗ trợ.")
    if _structured_int(result.get("scene_version"), "scene_version", minimum=1) != 1:
        raise RuntimeError("Structured result dùng VectorScene version không được hỗ trợ.")
    if result.get("coordinate_system") != "pixel_top_left":
        raise RuntimeError("Structured result có hệ tọa độ không được hỗ trợ.")

    svg = result.get("svg")
    if not isinstance(svg, str) or "<svg" not in svg or "<script" in svg.lower():
        raise RuntimeError("Structured result không chứa SVG artifact hợp lệ.")
    artifact = _structured_mapping(result.get("artifact"), "artifact")
    artifact_sha256 = _structured_hash(artifact.get("sha256"), "artifact.sha256")
    if hashlib.sha256(svg.encode("utf-8")).hexdigest() != artifact_sha256:
        raise RuntimeError("Structured result có hash artifact không khớp chuỗi SVG.")
    artifact_bytes = _structured_int(artifact.get("byte_len"), "artifact.byte_len")
    if artifact_bytes != len(svg.encode("utf-8")):
        raise RuntimeError("Structured result có byte length không khớp chuỗi SVG.")
    width_px = _structured_int(artifact.get("width_px"), "artifact.width_px", minimum=1)
    height_px = _structured_int(artifact.get("height_px"), "artifact.height_px", minimum=1)
    if (width_px, height_px) != (prepared.width_px, prepared.height_px):
        raise RuntimeError("Structured result có kích thước pixel lệch ảnh làm việc.")

    actual_width_mm = artifact.get("physical_width_mm")
    actual_height_mm = artifact.get("physical_height_mm")
    if (actual_width_mm is None) != (actual_height_mm is None):
        raise RuntimeError("Structured result có cặp kích thước mm không đầy đủ.")
    parsed_width_mm = (
        None
        if actual_width_mm is None
        else _structured_float(actual_width_mm, "artifact.physical_width_mm", minimum=1e-12)
    )
    parsed_height_mm = (
        None
        if actual_height_mm is None
        else _structured_float(actual_height_mm, "artifact.physical_height_mm", minimum=1e-12)
    )
    expected_mm = (prepared.physical_width_mm, prepared.physical_height_mm)
    actual_mm = (parsed_width_mm, parsed_height_mm)
    if (expected_mm[0] is None) != (actual_mm[0] is None):
        raise RuntimeError("Structured result không giữ đúng hợp đồng kích thước mm.")
    if expected_mm[0] is not None and (
        not math.isclose(expected_mm[0], actual_mm[0], abs_tol=0.005)  # type: ignore[arg-type]
        or not math.isclose(expected_mm[1], actual_mm[1], abs_tol=0.005)  # type: ignore[arg-type]
    ):
        raise RuntimeError("Structured result không giữ đúng hợp đồng kích thước mm.")

    provenance = _structured_mapping(result.get("provenance"), "provenance")
    engine = provenance.get("engine")
    engine_version = provenance.get("engine_version")
    expected_engine = str(info.get("core_engine", "prynx-logo-core"))
    expected_version = str(info.get("core_engine_version", "unknown"))
    if engine != expected_engine or engine_version != expected_version:
        raise RuntimeError("Structured result có provenance engine lệch capabilities.")
    expected_profile = "silhouette" if settings.mode == "monochrome" else "flat_color"
    if provenance.get("profile") != expected_profile:
        raise RuntimeError("Structured result có profile lệch request.")
    _structured_hash(provenance.get("settings_hash"), "provenance.settings_hash")
    preprocess_hash = _structured_hash(result.get("preprocess_hash"), "preprocess_hash")

    raw_metrics = _structured_mapping(result.get("metrics"), "metrics")
    metrics: dict[str, int | float] = {}
    for field in (
        "layer_count",
        "component_count",
        "outer_count",
        "hole_count",
        "source_nodes",
        "output_nodes",
    ):
        metrics[field] = _structured_int(raw_metrics.get(field), f"metrics.{field}")
    metrics["max_error_px"] = _structured_float(
        raw_metrics.get("max_error_px"), "metrics.max_error_px"
    )
    metrics["raster_scale"] = _structured_int(
        raw_metrics.get("raster_scale"), "metrics.raster_scale", minimum=1
    )
    metrics["iou"] = _structured_float(
        raw_metrics.get("iou"), "metrics.iou", maximum=1.0
    )
    metrics["mae"] = _structured_float(
        raw_metrics.get("mae"), "metrics.mae", maximum=1.0
    )
    raw_warnings = result.get("warnings")
    if not isinstance(raw_warnings, list) or any(
        not isinstance(warning, str) for warning in raw_warnings
    ):
        raise RuntimeError("Structured result có warnings không hợp lệ.")

    return StructuredNativeResult(
        svg=svg,
        artifact_sha256=artifact_sha256,
        width_px=width_px,
        height_px=height_px,
        physical_width_mm=parsed_width_mm,
        physical_height_mm=parsed_height_mm,
        engine=str(engine),
        engine_version=str(engine_version),
        preprocess_hash=preprocess_hash,
        metrics=metrics,
        warnings=list(raw_warnings),
    )


def _process_logo_preview_reserved(
    source_bytes: bytes,
    settings: LogoRebuildSettings,
    token: Any,
    native: Any,
    info: dict[str, Any],
    planned_size: tuple[int, int],
    memory_warnings: list[str],
) -> LogoPreviewResult:
    if token.is_cancelled():
        raise LogoJobCancelled("Đã hủy preview logo.")
    prepared = prepare_logo_image(
        source_bytes,
        settings,
        planned_size=planned_size,
        memory_warnings=memory_warnings,
        cancel_check=token.is_cancelled,
    )
    if token.is_cancelled():
        raise LogoJobCancelled("Đã hủy preview logo.")
    warnings = list(prepared.warnings)
    effective_despeckle_size = _scaled_despeckle_size(
        settings.despeckle_size_px,
        prepared.work_area_scale,
    )
    if effective_despeckle_size != settings.despeckle_size_px:
        warnings.append(
            "Khử hạt đã quy đổi từ "
            f"{settings.despeckle_size_px} px ảnh nguồn thành "
            f"{effective_despeckle_size} px ở kích thước dựng nét."
        )
    if (
        settings.mode == "fixed_palette"
        and settings.despeckle_size_px > 0
        and prepared.work_area_scale > 1.0
    ):
        # LOGO-REBUILD (audit 2026-08-13 §LR4.01): khử hạt tính theo px ảnh
        # nguồn; với logo nhỏ đã upscale phải nói rõ chi tiết nào sẽ mất thay
        # vì chỉ báo con số quy đổi.
        source_despeckle = settings.despeckle_size_px
        warnings.append(
            "Ảnh đã được phóng to trước khi dựng nét: khử hạt "
            f"{source_despeckle} px sẽ gộp mọi chi tiết nhỏ hơn "
            f"{source_despeckle}×{source_despeckle} px ảnh nguồn "
            "(dấu, chấm, ký hiệu nhỏ) vào màu lân cận; đặt 0 nếu cần giữ các chi tiết này."
        )

    from app.workers.logo_svg_cleanup import (
        LogoSvgCleanupCancelled,
        LogoSvgCleanupError,
        analyze_logo_svg,
        cleanup_redundant_logo_paths,
    )

    engine_palette = list(settings.palette)
    background_label: int | None = None
    if settings.background_color is not None:
        background_label = len(engine_palette)
        engine_palette.append(settings.background_color)
    structured: StructuredNativeResult | None = None
    removed_path_count = 0
    try:
        if settings.engine == "prynx_core":
            if (
                not callable(getattr(native, "logo_vectorize_structured_rgba", None))
                or not bool(info.get("structured_result", False))
                or int(info.get("structured_result_version", 0))
                != _STRUCTURED_RESULT_SCHEMA_VERSION
            ):
                raise LogoEngineUnavailable(
                    "Bản pdfcompare_native hiện tại chưa có structured Logo Engine v2."
                )
            raw_result = native.logo_vectorize_structured_rgba(
                prepared.width_px,
                prepared.height_px,
                prepared.rgba,
                settings.mode,
                palette=engine_palette or None,
                smoothing=settings.smoothing,
                despeckle_size_px=effective_despeckle_size,
                background_label=background_label,
                physical_width_mm=prepared.physical_width_mm,
                physical_height_mm=prepared.physical_height_mm,
                raster_scale=4,
                cancel=token,
            )
            structured = _parse_structured_native_result(
                raw_result,
                prepared,
                settings,
                info,
            )
            svg = structured.svg
            warnings.extend(structured.warnings)
            engine = structured.engine
            engine_version = structured.engine_version
        else:
            svg = native.logo_vectorize_rgba(
                prepared.width_px,
                prepared.height_px,
                prepared.rgba,
                settings.mode,
                palette=engine_palette or None,
                smoothing=settings.smoothing,
                despeckle_size_px=effective_despeckle_size,
                cancel=token,
            )
            # SVG legacy chưa có hợp đồng writer riêng nên backend vẫn gắn
            # viewBox/mm và dọn path theo quy trình VTracer cũ.
            svg = _apply_svg_geometry(svg, prepared)
            engine = str(info.get("engine", "vtracer"))
            engine_version = str(info.get("version", "unknown"))
    except LogoInputError:
        raise
    except ValueError as exc:
        # LOGO-REBUILD (audit 2026-08-13 §LR4.03): lệch hợp đồng ở biên Rust là
        # lỗi đầu vào có hướng xử lý (route map LogoInputError → 422 kèm nguyên
        # nhân thật), không phải 500 "Không thể tạo SVG preview" mù thông tin.
        raise LogoInputError(f"Engine từ chối hợp đồng đầu vào: {exc}") from exc
    except RuntimeError as exc:
        if token.is_cancelled() or "hủy" in str(exc).lower():
            raise LogoJobCancelled("Đã hủy preview logo.") from exc
        raise
    if "<svg" not in svg or "<script" in svg.lower():
        raise RuntimeError("Engine trả về SVG không hợp lệ.")

    if structured is None:
        # LOGO-REBUILD (audit 2026-08-03 §LR2.03): cleanup chỉ áp lên legacy;
        # sửa artifact core sẽ làm hash và metrics native mất hiệu lực.
        try:
            cleaned = cleanup_redundant_logo_paths(
                svg,
                prepared.width_px,
                prepared.height_px,
                token.is_cancelled,
            )
        except LogoSvgCleanupCancelled as exc:
            raise LogoJobCancelled("Đã hủy preview logo.") from exc
        except LogoSvgCleanupError as exc:
            raise RuntimeError("Engine trả về path SVG không hợp lệ.") from exc
        svg = cleaned.svg
        removed_path_count = cleaned.removed_path_count
        if removed_path_count:
            warnings.append(
                f"Đã dọn {removed_path_count} mảng vector nhỏ bị lớp cùng màu phủ kín."
            )
        if settings.background_color is not None:
            svg, removed = _strip_svg_background(svg, settings.background_color)
            if removed == 0:
                warnings.append("Không tìm thấy vùng nền khớp màu đã xác nhận trong SVG.")
    try:
        quality = analyze_logo_svg(
            svg,
            prepared.width_px,
            prepared.height_px,
            removed_path_count,
            expected_physical_size_mm=(
                (prepared.physical_width_mm, prepared.physical_height_mm)
                if prepared.physical_width_mm is not None
                and prepared.physical_height_mm is not None
                else None
            ),
            expected_artifact_sha256=(
                structured.artifact_sha256 if structured is not None else None
            ),
            require_physical_size=True,
        )
    except LogoSvgCleanupError as exc:
        raise RuntimeError("Không thể kiểm tra chất lượng SVG đầu ra.") from exc
    warnings.extend(reason for reason in quality.reasons if reason not in warnings)
    status = quality.status
    review_reasons = list(quality.reasons)
    review_actions = list(quality.actions)
    if (
        structured is not None
        and settings.mode == "monochrome"
        and effective_despeckle_size > 0
    ):
        reason = "Profile đen trắng chưa áp dụng khử hạt đã yêu cầu."
        action = "Đặt khử hạt về 0 hoặc tiếp tục chỉnh thủ công trước khi xuất."
        if reason not in review_reasons:
            review_reasons.append(reason)
        if action not in review_actions:
            review_actions.append(action)
        if status == "ready":
            status = "review"
    return LogoPreviewResult(
        svg=svg,
        width_px=prepared.width_px,
        height_px=prepared.height_px,
        warnings=warnings,
        engine=engine,
        engine_version=engine_version,
        status=status,
        complexity=quality.complexity.to_dict(),
        review_reasons=review_reasons,
        review_actions=review_actions,
        physical_width_mm=prepared.physical_width_mm,
        physical_height_mm=prepared.physical_height_mm,
        result_schema_version=(
            _STRUCTURED_RESULT_SCHEMA_VERSION if structured is not None else None
        ),
        artifact_sha256=(structured.artifact_sha256 if structured is not None else None),
        preprocess_hash=(structured.preprocess_hash if structured is not None else None),
        native_metrics=(structured.metrics if structured is not None else None),
    )


def process_logo_preview(
    source_bytes: bytes,
    settings: LogoRebuildSettings,
    job_id: str,
    token: Any | None = None,
) -> LogoPreviewResult:
    if token is None:
        token = reserve_logo_job(job_id)
    try:
        # LOGO-REBUILD (audit 2026-08-09 §LR3.08): metadata native cũng phải nằm
        # trong lifetime đã có finally; ABI lỗi không được để UUID mắc trong registry.
        native = _load_native_module()
        info = dict(native.logo_vectorizer_info())
        if token.is_cancelled():
            raise LogoJobCancelled("Đã hủy preview logo.")
        requested_size = _requested_logo_work_size(source_bytes, settings)
        with _reserve_logo_work_size(*requested_size) as (
            planned_size,
            memory_warnings,
        ):
            return _process_logo_preview_reserved(
                source_bytes,
                settings,
                token,
                native,
                info,
                planned_size,
                memory_warnings,
            )
    finally:
        _discard_job(job_id, token)
