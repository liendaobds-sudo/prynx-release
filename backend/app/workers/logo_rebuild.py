"""Tiền xử lý ảnh và adapter native cho Phục hồi & Vector hóa Logo."""

from __future__ import annotations

import importlib
from copy import deepcopy
import math
import threading
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Literal
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


_ACTIVE_JOBS_LOCK = threading.Lock()
_ACTIVE_JOBS: dict[str, Any] = {}
_PALETTE_KMEANS_LOCK = threading.Lock()
_MAX_PALETTE_SAMPLE_PIXELS = 40_000
_MIN_PALETTE_COVERAGE = 0.01
_MERGE_PALETTE_DISTANCE_RGB = 18.0
_MAX_ENGINE_DESPECKLE_AREA_PX = 128


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
    except (LogoEngineUnavailable, RuntimeError, TypeError, ValueError):
        return None
    return {
        "engine": str(info.get("engine", "vtracer")),
        "version": str(info.get("version", "unknown")),
        "cancellable": bool(info.get("cancellable", False)),
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


def _plan_work_size(width: int, height: int) -> tuple[tuple[int, int], list[str]]:
    """Lập ngân sách RAM; chỉ máy dưới 16 GB mới tự giảm kích thước."""

    if width <= 0 or height <= 0:
        raise LogoInputError("Kích thước vùng logo không hợp lệ.")
    total_mb, available_mb = read_memory_status_mb()
    if total_mb is None or available_mb is None:
        return (width, height), []

    # ColorImage + phân vùng/đường cong của VTracer có đỉnh cao hơn nhiều so với RGBA.
    estimated_mb = width * height * 112 / (1024 * 1024)
    reserve_mb = 512.0 if total_mb < 8 * 1024 else 1024.0
    usable_mb = max(0.0, available_mb - reserve_mb) * (0.55 if total_mb < 8 * 1024 else 0.65)

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

    pixels = np.asarray(image.convert("RGBA"), dtype=np.uint8).reshape(-1, 4)
    visible = pixels[:, 3] > 0
    if not bool(np.any(visible)):
        warnings.append("Ảnh không có pixel nhìn thấy để gợi ý màu.")
        return [], warnings

    colors = pixels[visible, :3]
    alpha_weights = pixels[visible, 3].astype(np.float32) / 255.0
    if len(colors) > _MAX_PALETTE_SAMPLE_PIXELS:
        indices = np.linspace(
            0,
            len(colors) - 1,
            _MAX_PALETTE_SAMPLE_PIXELS,
            dtype=np.int64,
        )
        colors = colors[indices]
        alpha_weights = alpha_weights[indices]

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
    merged: list[tuple[Any, float]] = []
    for index in np.argsort(weights)[::-1]:
        coverage = float(weights[index]) / total_weight
        if coverage < _MIN_PALETTE_COVERAGE:
            continue
        center = centers[index].astype(np.float64)
        for merged_index, (existing, existing_coverage) in enumerate(merged):
            if float(np.linalg.norm(center - existing)) < _MERGE_PALETTE_DISTANCE_RGB:
                combined = existing_coverage + coverage
                merged[merged_index] = (
                    (existing * existing_coverage + center * coverage) / combined,
                    combined,
                )
                break
        else:
            merged.append((center, coverage))

    suggestions: list[LogoPaletteSuggestion] = []
    for center, coverage in sorted(merged, key=lambda item: item[1], reverse=True)[:12]:
        red, green, blue = (
            int(np.clip(np.rint(channel), 0, 255)) for channel in center
        )
        suggestions.append(
            LogoPaletteSuggestion(
                color=f"#{red:02x}{green:02x}{blue:02x}",
                coverage_ratio=round(coverage, 6),
            )
        )
    return suggestions, warnings


def prepare_logo_image(source_bytes: bytes, settings: LogoRebuildSettings) -> PreparedLogo:
    warnings: list[str] = []
    image, source_dpi = _load_logo_image(source_bytes)
    image = _convert_to_srgb(image, warnings)
    image = _apply_perspective(image, settings)
    image = _apply_crop(image, settings)
    physical_width_mm = None
    physical_height_mm = None
    if source_dpi is not None:
        physical_width_mm = image.width * 25.4 / source_dpi[0]
        physical_height_mm = image.height * 25.4 / source_dpi[1]

    source_work_area = image.width * image.height
    requested_size = _upscale_target_dimensions(*image.size)
    planned_size, memory_warnings = _plan_work_size(*requested_size)
    warnings.extend(memory_warnings)
    if image.size != planned_size:
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
    """Gắn hệ tọa độ ổn định và kích thước vật lý khi ảnh có DPI."""

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


def process_logo_preview(
    source_bytes: bytes,
    settings: LogoRebuildSettings,
    job_id: str,
    token: Any | None = None,
) -> LogoPreviewResult:
    native = _load_native_module()
    info = dict(native.logo_vectorizer_info())
    if token is None:
        token = reserve_logo_job(job_id)
    try:
        if token.is_cancelled():
            raise LogoJobCancelled("Đã hủy preview logo.")
        prepared = prepare_logo_image(source_bytes, settings)
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
        try:
            engine_palette = list(settings.palette)
            if settings.background_color is not None:
                engine_palette.append(settings.background_color)
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
        except RuntimeError as exc:
            if token.is_cancelled() or "hủy" in str(exc).lower():
                raise LogoJobCancelled("Đã hủy preview logo.") from exc
            raise
        # LOGO-REBUILD (audit 2026-07-30 §LG.06): mọi SVG có viewBox;
        # ảnh có DPI còn giữ đúng kích thước vật lý khi mở trong phần mềm chế bản.
        svg = _apply_svg_geometry(svg, prepared)
        if "<svg" not in svg or "<script" in svg.lower():
            raise RuntimeError("Engine trả về SVG không hợp lệ.")

        # LOGO-REBUILD (audit 2026-08-03 §LR2.03): dọn từng path nhỏ chỉ khi lớp
        # nhìn thấy bên dưới đã cùng màu; không union toàn artwork nên giữ counter và lớp xen giữa.
        from app.workers.logo_svg_cleanup import (
            LogoSvgCleanupCancelled,
            LogoSvgCleanupError,
            analyze_logo_svg,
            cleanup_redundant_logo_paths,
        )

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
        if cleaned.removed_path_count:
            warnings.append(
                f"Đã dọn {cleaned.removed_path_count} mảng vector nhỏ bị lớp cùng màu phủ kín."
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
                cleaned.removed_path_count,
            )
        except LogoSvgCleanupError as exc:
            raise RuntimeError("Không thể kiểm tra chất lượng SVG đầu ra.") from exc
        warnings.extend(reason for reason in quality.reasons if reason not in warnings)
        return LogoPreviewResult(
            svg=svg,
            width_px=prepared.width_px,
            height_px=prepared.height_px,
            warnings=warnings,
            engine=str(info.get("engine", "vtracer")),
            engine_version=str(info.get("version", "unknown")),
            status=quality.status,
            complexity=quality.complexity.to_dict(),
            review_reasons=quality.reasons,
            review_actions=quality.actions,
        )
    finally:
        _discard_job(job_id, token)
