"""Điều phối nhận diện tem từ một session nguồn đã inspect.

Thứ tự tự động: CutContour thật → vector → Alpha sạch → nền đơn giản → AI. Mọi
nhánh đều trả cùng ``StickerSheetAnalysis`` để workspace review dùng chung.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from io import BytesIO
import math
from pathlib import Path
import time
from typing import Literal

import cv2
import numpy as np
import pikepdf
from PIL import Image, ImageCms, ImageOps

from app.core.pdfium_lock import pdfium_guard
from app.core.sticker_background import detect_background, has_meaningful_alpha
from app.core.sticker_sheet_session import StickerSheetSession
from app.core.system_memory import read_memory_status_mb
from app.workers.cut_export.cut_layer_extractor import extract_cut_contours
from app.workers.sticker_sheet_engine import (
    DEFAULT_ALPHA_THRESHOLD,
    DEFAULT_MODEL,
    MAX_UNCERTAIN_ALPHA,
    MIN_COMPONENT_AREA_PX,
    MIN_COMPONENT_AREA_RATIO,
    MIN_UNCERTAIN_ALPHA,
    StickerInstance,
    StickerSheetAnalysis,
    StickerSheetError,
    StickerSheetModel,
    _build_labels,
    _component_records,
    _instance_quality,
    analyze_sticker_sheet,
)


StickerDetectionStrategy = Literal[
    "auto",
    "existing-cut",
    "vector",
    "alpha",
    "simple-bg",
    "ai",
]

_PDF_ANALYSIS_DPI = 300.0
_PDF_ANALYSIS_MAX_EDGE_LOW_RAM_PX = 3000
_PDF_ANALYSIS_MAX_EDGE_MID_RAM_PX = 6000
_AUTO_BACKGROUND_CONFIDENCE_MIN = 0.60
_AUTO_FRAGMENT_MIN_INSTANCES = 6
_AUTO_FRAGMENT_MIN_NESTED = 3
_AUTO_FRAGMENT_NESTED_RATIO = 0.18


class StickerSourcePipelineError(ValueError):
    """Không thể tạo mask đáng tin cậy bằng chiến lược được yêu cầu."""


@dataclass(frozen=True)
class StickerSourceDetection:
    analysis: StickerSheetAnalysis
    source_image: Image.Image
    boundary_source: str
    strategy_confidence: float
    needs_review: bool
    dpi: tuple[float, float] | None
    source_page: int
    vector_geometry_ref: dict[str, object] | None
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class LegacyApprovedContour:
    """Alpha và Bézier đã duyệt để luồng cũ xuất mà không nhận diện lại."""

    alpha: np.ndarray
    dpi: tuple[float, float]
    path_groups: list[dict[str, object]]
    boundary_source: str
    instance_count: int
    source_pixel_mm: float


def _convert_to_srgb(image: Image.Image) -> Image.Image:
    has_alpha = image.mode in ("RGBA", "LA") or "A" in image.getbands() or "transparency" in image.info
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    profile_bytes = image.info.get("icc_profile")
    if profile_bytes:
        try:
            source_profile = ImageCms.ImageCmsProfile(BytesIO(profile_bytes))
            target_profile = ImageCms.createProfile("sRGB")
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
    else:
        rgb = image.convert("RGB")
    if alpha is not None:
        rgb.putalpha(alpha)
    return rgb


def _load_raster_source(session: StickerSheetSession) -> Image.Image:
    with Image.open(session.source_path) as opened:
        opened.seek(0)
        image = ImageOps.exif_transpose(opened)
        image.load()
    return _convert_to_srgb(image).convert("RGBA")


def _concat_pdf_matrix(
    current: tuple[float, float, float, float, float, float],
    update: tuple[float, float, float, float, float, float],
) -> tuple[float, float, float, float, float, float]:
    """Nối ma trận ``cm`` theo thứ tự hệ tọa độ nội dung PDF."""
    ca, cb, cc, cd, ce, cf = current
    ua, ub, uc, ud, ue, uf = update
    return (
        ca * ua + cc * ub,
        cb * ua + cd * ub,
        ca * uc + cc * ud,
        cb * uc + cd * ud,
        ca * ue + cc * uf + ce,
        cb * ue + cd * uf + cf,
    )


def _full_page_raster_scale_limit(source_path: str, page_index: int) -> float | None:
    """Trả mật độ pixel gốc khi trang chỉ là một ảnh phủ kín trang.

    Ảnh mở trong Viewer được bọc thành PDF để dùng chung thumbnail. Với ảnh không có
    DPI, khổ PDF giữ quy ước ``px == pt``; dựng lại ở 300 DPI sẽ nội suy mỗi chiều hơn
    bốn lần dù ảnh nhúng không có thêm chi tiết. Chỉ nhận dạng mẫu PDF rất chặt
    (một lệnh vẽ ảnh, không text/vector, ảnh phủ kín CropBox) để PDF thật vẫn giữ 300 DPI.
    """
    try:
        with pikepdf.Pdf.open(source_path, attempt_recovery=False) as document:
            if page_index < 0 or page_index >= len(document.pages):
                return None
            page = document.pages[page_index]
            if int(page.get("/Rotate", 0) or 0) % 360 != 0:
                return None
            if not math.isclose(float(page.get("/UserUnit", 1.0) or 1.0), 1.0):
                return None

            box = page.get("/CropBox", page.get("/MediaBox"))
            if not isinstance(box, pikepdf.Array) or len(box) < 4:
                return None
            page_left = min(float(box[0]), float(box[2]))
            page_right = max(float(box[0]), float(box[2]))
            page_bottom = min(float(box[1]), float(box[3]))
            page_top = max(float(box[1]), float(box[3]))
            page_width = page_right - page_left
            page_height = page_top - page_bottom
            if page_width <= 0 or page_height <= 0:
                return None

            resources = page.get("/Resources")
            xobjects = resources.get("/XObject") if isinstance(resources, pikepdf.Dictionary) else None
            if not isinstance(xobjects, pikepdf.Dictionary):
                return None

            identity = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
            transform = identity
            stack: list[tuple[float, float, float, float, float, float]] = []
            drawn_image: pikepdf.Object | None = None
            drawn_transform: tuple[float, float, float, float, float, float] | None = None
            for instruction in pikepdf.parse_content_stream(page):
                operator = str(instruction.operator)
                operands = list(instruction.operands)
                if operator == "q":
                    stack.append(transform)
                elif operator == "Q":
                    if not stack:
                        return None
                    transform = stack.pop()
                elif operator == "cm":
                    if len(operands) != 6:
                        return None
                    matrix = tuple(float(value) for value in operands)
                    transform = _concat_pdf_matrix(transform, matrix)  # type: ignore[arg-type]
                elif operator == "Do":
                    if drawn_image is not None or len(operands) != 1:
                        return None
                    candidate = xobjects.get(str(operands[0]))
                    if not isinstance(candidate, (pikepdf.Stream, pikepdf.Dictionary)):
                        return None
                    if str(candidate.get("/Subtype", "")) != "/Image":
                        return None
                    drawn_image = candidate
                    drawn_transform = transform
                else:
                    # QUALITY (feedback 2026-08-09 §AI.THUMBNAIL): có bất kỳ lệnh
                    # vẽ text/vector/ảnh khác thì giữ nguyên render 300 DPI.
                    return None
            if stack or drawn_image is None or drawn_transform is None:
                return None

            image_width = int(drawn_image.get("/Width", 0) or 0)
            image_height = int(drawn_image.get("/Height", 0) or 0)
            if image_width <= 0 or image_height <= 0:
                return None

            a, b, c, d, e, f = drawn_transform
            # Luồng ảnh do Viewer tạo không xoay/nghiêng. Giữ điều kiện hẹp để không
            # suy diễn sai mật độ của PDF dàn trang phức tạp.
            axis_tolerance = max(page_width, page_height) * 1e-7
            if abs(b) > axis_tolerance or abs(c) > axis_tolerance:
                return None
            image_left = min(e, a + e)
            image_right = max(e, a + e)
            image_bottom = min(f, d + f)
            image_top = max(f, d + f)
            placement_tolerance = max(0.5, max(page_width, page_height) * 0.001)
            if any((
                abs(image_left - page_left) > placement_tolerance,
                abs(image_right - page_right) > placement_tolerance,
                abs(image_bottom - page_bottom) > placement_tolerance,
                abs(image_top - page_top) > placement_tolerance,
            )):
                return None
            placed_width = image_right - image_left
            placed_height = image_top - image_bottom
            if placed_width <= 0 or placed_height <= 0:
                return None
            scale_limit = min(image_width / placed_width, image_height / placed_height)
            return scale_limit if math.isfinite(scale_limit) and scale_limit > 0 else None
    except (IndexError, OSError, TypeError, ValueError, pikepdf.PdfError):
        return None


def _render_pdf_page(
    source_path: str,
    page_index: int,
    physical_size_mm: tuple[float, float],
) -> tuple[Image.Image, tuple[float, float]]:
    import pypdfium2 as pdfium

    raster_scale_limit = _full_page_raster_scale_limit(source_path, page_index)
    with pdfium_guard("sticker_source_pipeline_render"):
        document = pdfium.PdfDocument(source_path)
        try:
            if page_index < 0 or page_index >= len(document):
                raise StickerSourcePipelineError("Trang PDF cần nhận diện không tồn tại.")
            page = document[page_index]
            try:
                width_pt, height_pt = page.get_size()
                logical_width = max(float(width_pt), 1.0)
                logical_height = max(float(height_pt), 1.0)
                physical_width_mm, physical_height_mm = physical_size_mm
                desired_width_px = physical_width_mm / 25.4 * _PDF_ANALYSIS_DPI
                desired_height_px = physical_height_mm / 25.4 * _PDF_ANALYSIS_DPI
                scale = min(
                    desired_width_px / logical_width,
                    desired_height_px / logical_height,
                )
                if raster_scale_limit is not None:
                    scale = min(scale, raster_scale_limit)
                total_ram_mb, _available_ram_mb = read_memory_status_mb()
                if total_ram_mb is not None and total_ram_mb < 8 * 1024:
                    max_edge_px: int | None = _PDF_ANALYSIS_MAX_EDGE_LOW_RAM_PX
                elif total_ram_mb is not None and total_ram_mb < 16 * 1024:
                    max_edge_px = _PDF_ANALYSIS_MAX_EDGE_MID_RAM_PX
                else:
                    # PERF (audit 2026-08-08 §UNIFIED.8): máy >=16 GB hoặc không đọc
                    # được RAM giữ đủ 300 DPI; chỉ máy yếu mới hạ kích thước phân tích.
                    max_edge_px = None
                if max_edge_px is not None:
                    scale = min(scale, max_edge_px / max(logical_width, logical_height))
                bitmap = page.render(
                    scale=scale,
                    rev_byteorder=True,
                    fill_color=(255, 255, 255, 0),
                )
                try:
                    image = bitmap.to_pil().convert("RGBA").copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            document.close()
    dpi_x = image.width / max(physical_size_mm[0], 1e-9) * 25.4
    dpi_y = image.height / max(physical_size_mm[1], 1e-9) * 25.4
    return image, (dpi_x, dpi_y)


def _analysis_from_alpha(
    source_image: Image.Image,
    raw_alpha: np.ndarray,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    warning: str | None = None,
) -> StickerSheetAnalysis:
    if raw_alpha.shape != (source_image.height, source_image.width):
        raise StickerSourcePipelineError("Mask không khớp kích thước nguồn.")
    post_started = time.perf_counter()
    raw_alpha = np.asarray(raw_alpha, dtype=np.uint8)
    binary = np.where(raw_alpha >= int(alpha_threshold), 255, 0).astype(np.uint8)
    min_area = max(MIN_COMPONENT_AREA_PX, int(binary.size * MIN_COMPONENT_AREA_RATIO))
    records, raw_labels = _component_records(binary, min_area)
    labels, ordered = _build_labels(records, raw_labels, binary.shape)
    if not ordered:
        raise StickerSourcePipelineError(
            "Không tìm thấy vùng tem đủ lớn. Hãy sửa vùng giữ lại hoặc chọn nhận diện bằng AI."
        )

    support = cv2.dilate(
        np.where(labels > 0, 255, 0).astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        iterations=1,
    ) > 0
    clean_alpha = np.where(support, raw_alpha, 0).astype(np.uint8)
    source_rgb = np.asarray(source_image.convert("RGB"), dtype=np.uint8)
    rgba = np.dstack((source_rgb, clean_alpha)).astype(np.uint8, copy=False)
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
        instances.append(StickerInstance(
            id=sticker_id,
            x=record["x"],
            y=record["y"],
            width=record["width"],
            height=record["height"],
            area_px=record["area"],
            confidence=round(confidence, 6),
            uncertain_ratio=round(uncertain_ratio, 6),
        ))
    warnings = [warning] if warning else []
    if len(instances) == 1:
        warnings.append("Chỉ nhận diện được một tem trong nguồn.")
    return StickerSheetAnalysis(
        width=source_image.width,
        height=source_image.height,
        model=model,
        rgba=rgba,
        alpha=clean_alpha,
        labels=labels,
        uncertainty=uncertainty,
        instances=instances,
        model_seconds=0.0,
        postprocess_seconds=time.perf_counter() - post_started,
        warnings=warnings,
    )


def build_legacy_single_page_approved_contour(
    source_path: str,
    *,
    cut_mode: str,
    offset_mm: float,
    bleed_mm: float,
    corner_style: str,
    fill_holes: bool,
    model: StickerSheetModel = DEFAULT_MODEL,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
    cutline_smoothness: float = 50.0,
    cutline_fidelity: float = 50.0,
    curve_tension: float = 50.0,
    min_detail_area_mm2: float = 1.0,
) -> LegacyApprovedContour | None:
    """Dùng cùng Alpha/path của chế độ AI cho đúng một tem raster trong PDF.

    QUALITY (feedback 2026-08-11 §LEGACY-AI.1): luồng cũ từng tự dựng lại
    silhouette từ ngưỡng nền trắng, trong khi workspace AI đã duyệt một Alpha
    khác rồi fit Bézier đúng một lần. Hàm này chỉ nối hai hợp đồng đó cho PDF
    một trang thuần raster; CutContour/vector thật vẫn đi nguyên luồng cũ.

    ``None`` nghĩa là tài liệu không thuộc ca một-tem an toàn hoặc AI nhận ra
    nhiều vùng. Caller phải giữ hành vi legacy, không được tách từng tem ngầm.
    """
    from app.workers.sticker_engine import (
        UnsafeCutlineGeometryError,
        _infer_full_page_image_pixel_mm,
        build_alpha_cutline_geometry,
    )
    from app.workers.sticker_source_inspector import inspect_sticker_source

    inspection = inspect_sticker_source(source_path, Path(source_path).name)
    if (
        inspection.source_kind != "pdf"
        or inspection.page_count != 1
        or inspection.has_existing_cut
        or inspection.has_vector
        or not inspection.has_raster
        or len(inspection.pages) != 1
    ):
        return None

    page = inspection.pages[0]
    if page.width_mm is None or page.height_mm is None:
        return None
    source_image, dpi = _render_pdf_page(
        source_path,
        0,
        (float(page.width_mm), float(page.height_mm)),
    )
    rendered_alpha = np.asarray(source_image.getchannel("A"), dtype=np.uint8)
    if page.has_alpha and has_meaningful_alpha(rendered_alpha, alpha_threshold):
        analysis = _analysis_from_alpha(
            source_image,
            rendered_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )
        boundary_source = "alpha"
    else:
        try:
            analysis = analyze_sticker_sheet(
                source_image.convert("RGB"),
                model=model,
                alpha_threshold=alpha_threshold,
            )
        except StickerSheetError as exc:
            raise StickerSourcePipelineError(str(exc)) from exc
        boundary_source = "ai"

    # Chế độ cũ là một tem trên một trang. Không biến cầu nối parity này thành
    # bộ tách nhiều tem; ca đó vẫn thuộc workspace AI có bước review riêng.
    if len(analysis.instances) != 1:
        return None

    try:
        cutline = build_alpha_cutline_geometry(
            analysis.alpha,
            dpi=float(dpi[0]),
            dpi_y=float(dpi[1]),
            cut_mode=cut_mode,
            offset_mm=offset_mm,
            bleed_mm=bleed_mm,
            corner_style=corner_style,
            fill_holes=fill_holes,
            cutline_smoothness=cutline_smoothness,
            cutline_fidelity=cutline_fidelity,
            curve_tension=curve_tension,
            min_detail_area_mm2=min_detail_area_mm2,
        )
    except UnsafeCutlineGeometryError as exc:
        raise StickerSourcePipelineError(str(exc)) from exc
    if cutline is None or not cutline.get("path_groups"):
        raise StickerSourcePipelineError(
            "Không tạo được đường bế an toàn từ vùng tem AI đã nhận diện."
        )

    # QUALITY (feedback 2026-08-12 §SEAM.2): DPI render AI chỉ là lưới phân tích,
    # không phải mật độ pixel artwork. PDF producer có thể thêm toán tử text rỗng
    # khiến trang 72 DPI bị render phân tích ở 300 DPI; dùng số đó làm mm/pixel sẽ
    # lấy màu ngay trong fringe trắng và tạo dải mờ giữa tem với bù xén.
    source_pixel_mm = max(25.4 / float(dpi[0]), 25.4 / float(dpi[1]))
    try:
        with pikepdf.Pdf.open(source_path, attempt_recovery=False) as document:
            inferred_pixel_mm = _infer_full_page_image_pixel_mm(document.pages[0])
        if (
            inferred_pixel_mm is not None
            and math.isfinite(float(inferred_pixel_mm))
            and float(inferred_pixel_mm) > 0.0
        ):
            source_pixel_mm = float(inferred_pixel_mm)
    except (IndexError, OSError, TypeError, ValueError, pikepdf.PdfError):
        pass

    return LegacyApprovedContour(
        alpha=np.asarray(analysis.alpha, dtype=np.uint8).copy(),
        dpi=(float(dpi[0]), float(dpi[1])),
        path_groups=list(cutline["path_groups"]),
        boundary_source=boundary_source,
        instance_count=1,
        source_pixel_mm=source_pixel_mm,
    )


def _pdf_page_box(source_path: str, page_index: int) -> tuple[float, float, float, float, int]:
    with pikepdf.Pdf.open(source_path, attempt_recovery=False) as document:
        page = document.pages[page_index]
        box = page.get("/CropBox", page.get("/MediaBox"))
        if not isinstance(box, pikepdf.Array) or len(box) < 4:
            raise StickerSourcePipelineError("Trang PDF không có CropBox/MediaBox hợp lệ.")
        rotation = int(page.get("/Rotate", 0) or 0) % 360
        return float(box[0]), float(box[1]), float(box[2]), float(box[3]), rotation


def _pdf_point_to_pixel(
    point: tuple[float, float],
    box: tuple[float, float, float, float, int],
    width_px: int,
    height_px: int,
) -> tuple[int, int]:
    x0, y0, x1, y1, rotation = box
    width_pt = max(abs(x1 - x0), 1e-9)
    height_pt = max(abs(y1 - y0), 1e-9)
    u = (point[0] - min(x0, x1)) / width_pt
    v = (point[1] - min(y0, y1)) / height_pt
    if rotation == 90:
        display_u, display_v = v, 1.0 - u
    elif rotation == 180:
        display_u, display_v = 1.0 - u, 1.0 - v
    elif rotation == 270:
        display_u, display_v = 1.0 - v, u
    else:
        display_u, display_v = u, v
    return (
        int(round(np.clip(display_u, 0.0, 1.0) * max(0, width_px - 1))),
        int(round((1.0 - np.clip(display_v, 0.0, 1.0)) * max(0, height_px - 1))),
    )


def _cut_contour_alpha(
    source_path: str,
    page_index: int,
    image_size: tuple[int, int],
) -> tuple[np.ndarray, int]:
    result = extract_cut_contours(source_path, page_index)
    if not result.contours:
        raise StickerSourcePipelineError("Trang đã chọn không có CutContour thực sự được vẽ.")
    width_px, height_px = image_size
    alpha = np.zeros((height_px, width_px), dtype=np.uint8)
    box = _pdf_page_box(source_path, page_index)
    closed_contours: list[np.ndarray] = []
    for contour in result.contours:
        if len(contour.points) < 3:
            continue
        points = np.asarray([
            _pdf_point_to_pixel(point, box, width_px, height_px)
            for point in contour.points
        ], dtype=np.int32)
        if contour.closed:
            closed_contours.append(points)
        else:
            cv2.polylines(alpha, [points], False, 255, thickness=2, lineType=cv2.LINE_8)
    if closed_contours:
        # QUALITY (audit 2026-08-08 §UNIFIED.8): fill một lần để OpenCV áp quy tắc
        # chẵn-lẻ cho contour lồng nhau; fill từng vòng sẽ lấp mất lỗ thật của tem.
        cv2.fillPoly(alpha, closed_contours, 255, lineType=cv2.LINE_8)
    if not np.any(alpha):
        raise StickerSourcePipelineError("CutContour không tạo được vùng tem kín để review.")
    return alpha, len(result.contours)


def _background_detection(
    source_image: Image.Image,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    boundary_source: str,
    minimum_confidence: float = 0.0,
) -> StickerSourceDetection | None:
    # OpenCV floodFill cần mảng writable; np.asarray(PIL) có thể trả view chỉ đọc.
    rgb = np.array(source_image.convert("RGB"), dtype=np.uint8, copy=True)
    try:
        background = detect_background(rgb)
    except cv2.error:
        return None
    if background is None or background.confidence < minimum_confidence:
        return None
    try:
        analysis = _analysis_from_alpha(
            source_image,
            background.foreground_mask,
            model=model,
            alpha_threshold=alpha_threshold,
            warning=(
                "Nền gradient được tách theo phép loang; cần kiểm tra kỹ vùng tem."
                if not background.is_flat
                else None
            ),
        )
    except StickerSourcePipelineError:
        # Mask deterministic không còn component hợp lệ thì auto phải đi tiếp tới AI.
        return None
    if (
        boundary_source == "simple-bg"
        and minimum_confidence > 0.0
        and _looks_like_fragmented_sticker_sheet(analysis)
    ):
        # QUALITY (audit 2026-08-08 §UNIFIED.11): nền trang và thân tem cùng
        # gần-trắng làm phép so màu chỉ giữ chữ/viền/bóng, rồi báo hàng chục
        # "tem" nằm lồng trong cùng một bbox. Confidence màu nền vẫn rất cao,
        # nên phải có guard topology riêng để auto chuyển sang AI.
        return None
    confidence = background.confidence if boundary_source == "simple-bg" else min(0.72, background.confidence)
    return StickerSourceDetection(
        analysis=analysis,
        source_image=source_image,
        boundary_source=boundary_source,
        strategy_confidence=confidence,
        needs_review=True,
        dpi=None,
        source_page=1,
        vector_geometry_ref=None,
        warnings=(),
    )


def _looks_like_fragmented_sticker_sheet(analysis: StickerSheetAnalysis) -> bool:
    """Nhận mask bị vỡ qua các component nhỏ nằm trong bbox component lớn."""
    instances = analysis.instances
    count = len(instances)
    if count < _AUTO_FRAGMENT_MIN_INSTANCES:
        return False

    nested = 0
    for fragment in instances:
        center_x = fragment.x + fragment.width / 2.0
        center_y = fragment.y + fragment.height / 2.0
        for container in instances:
            if fragment.id == container.id:
                continue
            if container.area_px < fragment.area_px * 1.25:
                continue
            if (
                container.x <= center_x <= container.x + container.width
                and container.y <= center_y <= container.y + container.height
            ):
                nested += 1
                break

    required = max(
        _AUTO_FRAGMENT_MIN_NESTED,
        int(np.ceil(count * _AUTO_FRAGMENT_NESTED_RATIO)),
    )
    return nested >= required


def detect_sticker_source(
    session: StickerSheetSession,
    *,
    strategy: StickerDetectionStrategy = "auto",
    model: StickerSheetModel = DEFAULT_MODEL,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
    page_number: int = 1,
) -> StickerSourceDetection:
    """Nhận diện một trang/ảnh từ session inspected, không ghi session."""
    # UIUX (audit 2026-08-09 §MP.2): stage thuộc trang nguồn. Dùng stage toàn
    # session khiến trang đầu vừa promote đã chặn mọi trang còn lại trong tài liệu.
    page_state = session.pages.get(page_number)
    stage = page_state.stage if page_state is not None else session.stage
    if stage not in ("inspected", "detecting"):
        raise StickerSourcePipelineError("Nguồn tem không còn ở trạng thái chờ nhận diện.")
    if strategy not in ("auto", "existing-cut", "vector", "alpha", "simple-bg", "ai"):
        raise StickerSourcePipelineError("Chiến lược nhận diện không được hỗ trợ.")
    if not 1 <= page_number <= session.page_count:
        raise StickerSourcePipelineError("Trang cần nhận diện không tồn tại trong file nguồn.")

    page_index = page_number - 1
    if session.source_kind == "raster":
        source_image = _load_raster_source(session)
        dpi = session.dpi
        rgba = np.asarray(source_image, dtype=np.uint8)
        raw_alpha = rgba[:, :, 3]
        has_clean_alpha = has_meaningful_alpha(raw_alpha, alpha_threshold)
        if strategy in ("auto", "alpha") and has_clean_alpha:
            analysis = _analysis_from_alpha(
                source_image,
                raw_alpha,
                model=model,
                alpha_threshold=alpha_threshold,
            )
            return StickerSourceDetection(
                analysis=analysis,
                source_image=source_image,
                boundary_source="alpha",
                strategy_confidence=0.98,
                needs_review=bool(session.needs_review),
                dpi=dpi,
                source_page=1,
                vector_geometry_ref=None,
                warnings=(),
            )
        if strategy == "alpha":
            raise StickerSourcePipelineError("Ảnh không có kênh Alpha sạch để sử dụng.")

        if strategy in ("auto", "simple-bg"):
            detected = _background_detection(
                source_image,
                model=model,
                alpha_threshold=alpha_threshold,
                boundary_source="simple-bg",
                minimum_confidence=(
                    _AUTO_BACKGROUND_CONFIDENCE_MIN if strategy == "auto" else 0.0
                ),
            )
            if detected is not None:
                return replace(detected, dpi=dpi, source_page=1)
            if strategy == "simple-bg":
                raise StickerSourcePipelineError("Nền ảnh không đủ đồng nhất để tách an toàn.")

        if strategy not in ("auto", "ai"):
            raise StickerSourcePipelineError("Chiến lược đã chọn không phù hợp với ảnh nguồn.")
        try:
            analysis = analyze_sticker_sheet(
                source_image.convert("RGB"),
                model=model,
                alpha_threshold=alpha_threshold,
            )
        except StickerSheetError as exc:
            raise StickerSourcePipelineError(str(exc)) from exc
        return StickerSourceDetection(
            analysis=analysis,
            source_image=source_image,
            boundary_source="ai",
            strategy_confidence=float(np.mean([item.confidence for item in analysis.instances])),
            needs_review=True,
            dpi=dpi,
            source_page=1,
            vector_geometry_ref=None,
            warnings=(),
        )

    page_manifest = list(session.manifest.get("pages", []))[page_index]
    width_mm = page_manifest.get("width_mm")
    height_mm = page_manifest.get("height_mm")
    if not isinstance(width_mm, (int, float)) or not isinstance(height_mm, (int, float)):
        raise StickerSourcePipelineError("Không xác định được kích thước vật lý của trang PDF.")
    source_image, dpi = _render_pdf_page(
        str(session.source_path),
        page_index,
        (float(width_mm), float(height_mm)),
    )
    cut_count = int(page_manifest.get("cut_contour_count", 0))
    has_vector = bool(page_manifest.get("has_vector", False))
    has_alpha = bool(page_manifest.get("has_alpha", False))
    if strategy in ("auto", "existing-cut") and cut_count > 0:
        raw_alpha, actual_count = _cut_contour_alpha(
            str(session.source_path),
            page_index,
            source_image.size,
        )
        analysis = _analysis_from_alpha(
            source_image,
            raw_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )
        return StickerSourceDetection(
            analysis=analysis,
            source_image=source_image,
            boundary_source="existing-cut",
            strategy_confidence=0.99,
            needs_review=False,
            dpi=dpi,
            source_page=page_number,
            vector_geometry_ref={
                "kind": "pdf-cut-contours",
                "source_page": page_number,
                "contour_count": actual_count,
                "preserve_original": True,
            },
            warnings=(),
        )
    if strategy == "existing-cut":
        raise StickerSourcePipelineError("Trang đã chọn không có CutContour.")

    if strategy in ("auto", "vector") and has_vector:
        detected = _background_detection(
            source_image,
            model=model,
            alpha_threshold=alpha_threshold,
            boundary_source="vector",
            minimum_confidence=(
                _AUTO_BACKGROUND_CONFIDENCE_MIN if strategy == "auto" else 0.0
            ),
        )
        if detected is not None:
            return replace(
                detected,
                dpi=dpi,
                source_page=page_number,
                vector_geometry_ref={
                    "kind": "pdf-vector-source",
                    "source_page": page_number,
                    "preserve_original": True,
                },
                warnings=("vector-mask-raster-preview",),
            )
        if strategy == "vector":
            raise StickerSourcePipelineError("Không suy ra được silhouette vector đáng tin cậy.")

    rendered_alpha = np.asarray(source_image.getchannel("A"), dtype=np.uint8)
    if (
        strategy in ("auto", "alpha")
        and has_alpha
        and has_meaningful_alpha(rendered_alpha, alpha_threshold)
    ):
        analysis = _analysis_from_alpha(
            source_image,
            rendered_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )
        return StickerSourceDetection(
            analysis=analysis,
            source_image=source_image,
            boundary_source="alpha",
            strategy_confidence=0.96,
            needs_review=True,
            dpi=dpi,
            source_page=page_number,
            vector_geometry_ref=None,
            warnings=("pdf-soft-mask-review",),
        )
    if strategy == "alpha":
        raise StickerSourcePipelineError("Trang PDF không có kênh Alpha/SMask đủ tin cậy.")

    if strategy in ("auto", "simple-bg"):
        detected = _background_detection(
            source_image,
            model=model,
            alpha_threshold=alpha_threshold,
            boundary_source="simple-bg",
            minimum_confidence=(
                _AUTO_BACKGROUND_CONFIDENCE_MIN if strategy == "auto" else 0.0
            ),
        )
        if detected is not None:
            return replace(detected, dpi=dpi, source_page=page_number)
        if strategy == "simple-bg":
            raise StickerSourcePipelineError("Nền trang PDF không đủ đồng nhất để tách an toàn.")

    if strategy not in ("auto", "ai"):
        raise StickerSourcePipelineError("Chiến lược đã chọn không phù hợp với trang PDF.")
    try:
        analysis = analyze_sticker_sheet(
            source_image.convert("RGB"),
            model=model,
            alpha_threshold=alpha_threshold,
        )
    except StickerSheetError as exc:
        raise StickerSourcePipelineError(str(exc)) from exc
    return StickerSourceDetection(
        analysis=analysis,
        source_image=source_image,
        boundary_source="ai",
        strategy_confidence=float(np.mean([item.confidence for item in analysis.instances])),
        needs_review=True,
        dpi=dpi,
        source_page=page_number,
        vector_geometry_ref=None,
        warnings=("pdf-raster-review",),
    )
