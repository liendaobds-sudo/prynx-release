"""Tiền xử lý ảnh và adapter native cho Phục hồi & Vector hóa Logo."""

from __future__ import annotations

import importlib
from copy import deepcopy
import math
import threading
from dataclasses import dataclass
from io import BytesIO
from typing import Any
from xml.etree import ElementTree

from PIL import Image, ImageCms, ImageOps

from app.core.system_memory import read_memory_status_mb
from app.schemas.logo_rebuild import LogoRebuildSettings


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


@dataclass(frozen=True)
class LogoPreviewResult:
    svg: str
    width_px: int
    height_px: int
    warnings: list[str]
    engine: str
    engine_version: str


_ACTIVE_JOBS_LOCK = threading.Lock()
_ACTIVE_JOBS: dict[str, Any] = {}


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


def _convert_to_srgb(image: Image.Image, warnings: list[str]) -> Image.Image:
    has_alpha = image.mode in ("RGBA", "LA") or "transparency" in image.info
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    rgb = image.convert("RGB")
    profile_bytes = image.info.get("icc_profile")
    if profile_bytes:
        try:
            source_profile = ImageCms.ImageCmsProfile(BytesIO(profile_bytes))
            target_profile = ImageCms.createProfile("sRGB")
            rgb = ImageCms.profileToProfile(
                rgb,
                source_profile,
                target_profile,
                outputMode="RGB",
            )
        except (OSError, ValueError, ImageCms.PyCMSError):
            warnings.append("Không đọc được ICC profile; preview dùng chuyển đổi RGB mặc định.")
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


def prepare_logo_image(source_bytes: bytes, settings: LogoRebuildSettings) -> PreparedLogo:
    warnings: list[str] = []
    try:
        with Image.open(BytesIO(source_bytes)) as opened:
            opened.seek(0)
            image = ImageOps.exif_transpose(opened)
            image.load()
    except (OSError, SyntaxError, ValueError) as exc:
        raise LogoInputError("File ảnh không thể giải mã.") from exc

    image = _convert_to_srgb(image, warnings)
    image = _apply_perspective(image, settings)
    image = _apply_crop(image, settings)
    planned_size, memory_warnings = _plan_work_size(*image.size)
    warnings.extend(memory_warnings)
    if image.size != planned_size:
        image = image.resize(planned_size, Image.Resampling.LANCZOS)
    rgba = image.convert("RGBA")
    alpha_minimum, _alpha_maximum = rgba.getchannel("A").getextrema()
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

    if settings.mode == "monochrome" and has_transparency:
        # Binary frontend của VTracer chỉ đọc RGB. Ghép alpha lên trắng để pixel
        # trong suốt không bị hiểu nhầm là mực đen và vẫn giữ rìa anti-alias.
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        rgba = Image.alpha_composite(white, rgba)

    return PreparedLogo(
        width_px=rgba.width,
        height_px=rgba.height,
        rgba=rgba.tobytes(),
        warnings=warnings,
    )


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

    # VTracer stacked luôn vẽ vùng phủ nền trước. Các vùng cùng màu xuất hiện sau
    # logo là phần nền nhìn xuyên qua (counter/hole), phải KHOÉT chứ không chỉ ẩn.
    hole_shapes = [deepcopy(child) for _, child in matches[1:]]
    for parent, child in matches:
        parent.remove(child)

    if hole_shapes:
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
            ElementTree.SubElement(
                mask,
                qualified("rect"),
                {
                    "x": "0",
                    "y": "0",
                    "width": root.attrib.get("width", "100%"),
                    "height": root.attrib.get("height", "100%"),
                    "fill": "#ffffff",
                },
            )
            for shape in hole_shapes:
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
                despeckle_size_px=settings.despeckle_size_px,
                cancel=token,
            )
        except RuntimeError as exc:
            if token.is_cancelled() or "hủy" in str(exc).lower():
                raise LogoJobCancelled("Đã hủy preview logo.") from exc
            raise
        warnings = list(prepared.warnings)
        if settings.background_color is not None:
            svg, removed = _strip_svg_background(svg, settings.background_color)
            if removed == 0:
                warnings.append("Không tìm thấy vùng nền khớp màu đã xác nhận trong SVG.")
        if "<svg" not in svg or "<script" in svg.lower():
            raise RuntimeError("Engine trả về SVG không hợp lệ.")
        return LogoPreviewResult(
            svg=svg,
            width_px=prepared.width_px,
            height_px=prepared.height_px,
            warnings=warnings,
            engine=str(info.get("engine", "vtracer")),
            engine_version=str(info.get("version", "unknown")),
        )
    finally:
        _discard_job(job_id, token)
