"""Điều phối nhận diện tem từ một session nguồn đã inspect.

Thứ tự tự động: CutContour thật → Alpha/clip render sạch → vector → nền đơn giản
→ AI. Mọi nhánh đều trả cùng ``StickerSheetAnalysis`` để workspace review dùng chung.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from io import BytesIO
import logging
import math
from pathlib import Path
import time
from typing import Literal

import cv2
import numpy as np
import pikepdf
from PIL import Image, ImageCms, ImageOps

from app.core.pdfium_lock import pdfium_guard
from app.core.sticker_background import (
    BackgroundInfo,
    detect_background,
    foreground_from_flat_background,
    has_meaningful_alpha,
)
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

logger = logging.getLogger(__name__)

_PDF_ANALYSIS_DPI = 300.0
_PDF_ANALYSIS_MAX_EDGE_LOW_RAM_PX = 3000
_PDF_ANALYSIS_MAX_EDGE_MID_RAM_PX = 6000
# PERF (audit 2026-08-16 §BX.P01): máy ≥16 GB trước đây KHÔNG có trần nào, nên tờ khổ
# lớn (1600 mm @300 DPI ≈ 18 900 px cạnh) nở buffer toàn khung không giới hạn ngay bên
# trong khóa PDFium toàn process.
#
# KHÔNG dùng trần px cứng ở đây: nguyên tắc của dự án là máy mạnh chạy hết công suất, và
# hạ DPI phân tích âm thầm sẽ đổi chất lượng nhận biên. Thay vào đó chặn theo RAM CÒN
# TRỐNG, cùng cách `_plan_background_work_size` đang làm: máy nào còn bộ nhớ thì vẫn giữ
# đủ 300 DPI, chỉ khi ảnh phân tích vượt ngân sách mới hạ và có log.
#
# Chi phí thực đo theo cấu trúc hàm render: bitmap PDFium (4 B/px) + `to_pil().copy()`
# (4 B/px) + bản RGBA cho pipeline (4 B/px), cộng biên an toàn cho bước phân tích phía sau.
_PDF_ANALYSIS_BYTES_PER_PX = 20.0
_PDF_ANALYSIS_RAM_FRACTION = 0.55
_AUTO_BACKGROUND_CONFIDENCE_MIN = 0.60
_AUTO_FRAGMENT_MIN_INSTANCES = 6
_AUTO_FRAGMENT_MIN_NESTED = 3
_AUTO_FRAGMENT_NESTED_RATIO = 0.18
_AUTO_WHITE_CONTAINER_MIN_PAGE_RATIO = 0.01
_AUTO_WHITE_CONTAINER_MIN_EDGE_RATIO = 0.08
_AUTO_WHITE_CONTAINER_NESTED_RATIO = 0.90
_AUTO_WHITE_CONTAINER_LARGER_RATIO = 1.05
_AUTO_WHITE_STRICT_OVERLAP_RATIO = 0.45
_AUTO_WHITE_BODY_RETAINED_RATIO_MIN = 0.65
_AUTO_WHITE_SHADOW_LUMA_MIN = 96
_AUTO_WHITE_SHADOW_LUMA_MAX = 248
_AUTO_WHITE_SHADOW_BACKGROUND_GAP = 5
_AUTO_WHITE_SHADOW_CHROMA_MAX = 20
# QUALITY (feedback 2026-08-16 §WHITE-SHADOW.1): bóng MỀM có đuôi gradient sáng hơn
# `shadow_luma_max` nhưng vẫn tối hơn nền, nên nó không bị bóc mà cũng không phải nền —
# vành đó dính lại vào thân tem và silhouette phình theo gradient. Luồng AI đã xử lý
# đúng việc này từ lâu bằng một bước nới 1 pixel qua đuôi gradient
# (`sticker_sheet_engine._SHADOW_EXPAND_LUMA_MAX`); nhánh phục hồi trắng thiếu bước đó.
_AUTO_WHITE_SHADOW_EXPAND_LUMA_MAX = 252
_AUTO_WHITE_SHADOW_EXPAND_CHROMA_MAX = 20
# QUALITY (feedback 2026-08-16 §WHITE-SHADOW.2): 0,70 quá lỏng cho một nhánh ĐƯỢC PHÉP
# ghi lại silhouette. Luồng AI đòi 0,88 kèm mức cải thiện tối thiểu, và chính hai con số
# đó mới phân biệt được viền trắng thật với bóng nhạt. Không đạt thì trả None để auto rơi
# về AI — đúng hành vi trước khi nhánh này ra đời.
_AUTO_WHITE_BOUNDARY_RATIO_MIN = 0.88
_AUTO_WHITE_BOUNDARY_GAIN_MIN = 0.08
# QUALITY (feedback 2026-08-16 §WHITE-SHADOW.3): phân biệt bóng CỨNG (mảng xám phẳng,
# mép dứt khoát — nhánh xác định xử lý đúng) với bóng MỀM (gradient tắt dần — đuôi của nó
# lẫn vào viền trắng và halo JPEG, nhánh xác định xử lý sai). Đo trên chính dải bóng dính
# biên: tỉ lệ pixel nằm ở đoạn SÁNG NHẤT của dải.
#
# Số đo thật trên hai fixture (`scratch/probe_white_soft_shadow.py`, span 8):
#     bóng cứng  0,0018     bóng mềm  0,2243
# Ngưỡng 0,10 nằm giữa và cách cả hai rất xa, nên không phải con số chỉnh tay mò.
_AUTO_WHITE_SHADOW_SOFT_TAIL_LUMA_SPAN = 8
_AUTO_WHITE_SHADOW_SOFT_TAIL_RATIO_MAX = 0.10
_EXACT_VECTOR_SHAPE_KINDS = frozenset({
    "circle",
    "ellipse",
    "rounded_rect",
    "rect",
    "triangle",
})


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
                total_ram_mb, available_ram_mb = read_memory_status_mb()
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
                # PERF (audit 2026-08-16 §BX.P01): van cuối theo RAM còn trống, áp cho MỌI
                # tier. Máy còn bộ nhớ thì không bị hạ gì; máy đang cạn RAM mới hạ và log.
                if available_ram_mb is not None and available_ram_mb > 0:
                    budget_px = (
                        available_ram_mb * _PDF_ANALYSIS_RAM_FRACTION
                        * 1024.0 * 1024.0 / _PDF_ANALYSIS_BYTES_PER_PX
                    )
                    planned_px = (logical_width * scale) * (logical_height * scale)
                    if budget_px > 0 and planned_px > budget_px:
                        ram_scale = scale * (budget_px / planned_px) ** 0.5
                        logger.info(
                            "[STICKER] hạ ảnh phân tích theo RAM còn trống: scale %.4f→%.4f "
                            "(cần %.0f Mpx, ngân sách %.0f Mpx, còn trống %.0f MB)",
                            scale, ram_scale, planned_px / 1e6, budget_px / 1e6,
                            available_ram_mb,
                        )
                        scale = ram_scale
                bitmap = page.render(
                    scale=scale,
                    rev_byteorder=True,
                    fill_color=(255, 255, 255, 0),
                )
                try:
                    # PERF (audit 2026-08-16 §BX.P01): chỉ copy MỘT lần trong vùng khóa
                    # (bitmap chết khi ra khỏi guard). `convert("RGBA")` là việc CPU thuần
                    # của PIL, không chạm PDFium → làm ngoài khóa để không giữ khóa toàn
                    # process qua thêm một lần cấp phát toàn khung.
                    raw_image = bitmap.to_pil().copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            document.close()
    image = raw_image if raw_image.mode == "RGBA" else raw_image.convert("RGBA")
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
    # §CUTJAG.3: thanh "Khử răng cưa" 0–100; 0 giữ nguyên hành vi cũ.
    cutline_denoise: float = 0.0,
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
        should_presmooth_cutline_alpha,
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
            # §CUTJAG.3: thanh kéo thắng cổng tự động; để 0 thì vẫn dùng cổng tự
            # động theo nguồn biên (mask AI là mask nhị phân hoá từ điểm ảnh).
            cutline_denoise=cutline_denoise,
            presmooth_alpha=should_presmooth_cutline_alpha("ai"),
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
    dpi: tuple[float, float] | None = None,
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
    recovered_white_body = False
    if (
        boundary_source == "simple-bg"
        and minimum_confidence > 0.0
        and _looks_like_fragmented_sticker_sheet(analysis)
    ):
        # QUALITY (audit 2026-08-08 §UNIFIED.11): nền trang và thân tem cùng
        # gần-trắng làm phép so màu chỉ giữ chữ/viền/bóng, rồi báo hàng chục
        # "tem" nằm lồng trong cùng một bbox. Confidence màu nền vẫn rất cao,
        # nên phải có guard topology riêng để auto chuyển sang AI.
        recovered = _recover_fragmented_near_white_sheet(
            source_image,
            background,
            analysis,
            model=model,
            alpha_threshold=alpha_threshold,
        )
        if recovered is None:
            return None
        analysis = recovered
        recovered_white_body = True
    exact_shapes: tuple[dict[str, object], ...] = ()
    if boundary_source == "vector":
        # QUALITY (feedback 2026-08-16 §XEPTEM.ALPHA): hình chuẩn chỉ được suy ra
        # từ silhouette đã chấp nhận. Cạnh RGB nằm BÊN TRONG artwork không có quyền
        # thay mask thành hình tròn vì sẽ cắt mất banner/tai/chi tiết nhô ra.
        exact_shapes = _detect_exact_vector_shapes(analysis, dpi=dpi)
    confidence = background.confidence if boundary_source == "simple-bg" else min(0.72, background.confidence)
    if recovered_white_body:
        confidence = min(confidence, 0.84)
    return StickerSourceDetection(
        analysis=analysis,
        source_image=source_image,
        boundary_source=boundary_source,
        strategy_confidence=confidence,
        needs_review=True,
        dpi=None,
        source_page=1,
        vector_geometry_ref=(
            {"exact_shapes": list(exact_shapes)}
            if exact_shapes
            else None
        ),
        warnings=(
            ("round-sticker-contour-inferred",)
            if any(shape.get("kind") in {"circle", "ellipse"} for shape in exact_shapes)
            else ()
        ),
    )


def _serialize_geometry_value(value: object) -> object:
    """Đưa metadata numpy về kiểu JSON nguyên thủy trước khi ghi manifest."""
    if isinstance(value, dict):
        return {str(key): _serialize_geometry_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize_geometry_value(item) for item in value]
    if isinstance(value, np.ndarray):
        return _serialize_geometry_value(value.tolist())
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    return value


def _detect_exact_vector_shapes(
    analysis: StickerSheetAnalysis,
    *,
    dpi: tuple[float, float] | None,
) -> tuple[dict[str, object], ...]:
    """Nhận hình chuẩn từ contour của từng mask, không đọc các cạnh trang trí RGB.

    `auto_safe` của luồng Sticker cũ đã có các guard residual/defect/diện tích. Dùng
    cùng classifier ở đây giúp hai tab có chung quyết định hình học, đồng thời giữ
    nguyên mask gốc để không biến một artwork chữ nhật thành hình tròn chỉ vì bên
    trong nó có một vòng tròn trang trí.
    """
    if dpi is None or analysis.labels.ndim != 2:
        return ()
    try:
        dpi_x, dpi_y = float(dpi[0]), float(dpi[1])
    except (TypeError, ValueError, IndexError):
        return ()
    if (
        not math.isfinite(dpi_x)
        or not math.isfinite(dpi_y)
        or dpi_x <= 0
        or dpi_y <= 0
    ):
        return ()

    from app.workers.sticker_cut_reconstruct import PT_PER_MM, reconstruct_cut_coords

    point_per_pixel_x = 72.0 / dpi_x
    point_per_pixel_y = 72.0 / dpi_y
    source_pixel_mm = max(point_per_pixel_x, point_per_pixel_y) / (72.0 / 25.4)
    exact_shapes: list[dict[str, object]] = []
    labels = np.asarray(analysis.labels)
    for instance in analysis.instances:
        # PERF (audit 2026-08-16 §CUTLINE-GEOMETRY): dò trong ROI của từng tem;
        # không tạo/quét một mask toàn trang lặp lại cho mỗi component.
        left = max(0, int(instance.x))
        top = max(0, int(instance.y))
        right = min(labels.shape[1], left + int(instance.width))
        bottom = min(labels.shape[0], top + int(instance.height))
        if right <= left or bottom <= top:
            continue
        component = np.ascontiguousarray(
            (labels[top:bottom, left:right] == instance.id).astype(np.uint8) * 255
        )
        contours, hierarchy = cv2.findContours(
            component,
            cv2.RETR_CCOMP,
            cv2.CHAIN_APPROX_NONE,
        )
        if not contours or hierarchy is None:
            continue
        external_indices = [
            index for index, relation in enumerate(hierarchy[0])
            if int(relation[3]) < 0
        ]
        if len(external_indices) != 1:
            continue
        outer_index = max(external_indices, key=lambda index: cv2.contourArea(contours[index]))
        # Có lỗ/đảo alpha thì không thể mô tả bằng một hình chuẩn đơn; giữ contour.
        if int(hierarchy[0][outer_index][2]) >= 0:
            continue
        points = contours[outer_index].reshape(-1, 2).astype(np.float64)
        if len(points) < 5:
            continue
        points[:, 0] = (points[:, 0] + left) * point_per_pixel_x
        points[:, 1] = (points[:, 1] + top) * point_per_pixel_y
        coords, metadata = reconstruct_cut_coords(
            points,
            "auto_safe",
            px_per_mm=PT_PER_MM,
            source_pixel_mm=source_pixel_mm,
        )
        kind = metadata.get("kind")
        if (
            coords is None
            or not metadata.get("reconstructed")
            or kind not in _EXACT_VECTOR_SHAPE_KINDS
        ):
            continue
        shape_record: dict[str, object] = {
            "instance_id": int(instance.id),
            "kind": str(kind),
            "coordinate_unit": "pt",
            "params": _serialize_geometry_value(metadata.get("params") or {}),
            "residual_mm": float(metadata.get("residual_mm", 0.0)),
            "defect_mm": float(metadata.get("defect_mm", 0.0)),
        }
        # Hình tròn/elip đã đủ tham số để dựng bằng bốn cung cubic; chỉ polygon
        # cần giữ đỉnh để áp offset mà không làm phình manifest theo 96 mẫu cung.
        if kind not in {"circle", "ellipse"}:
            shape_record["coords"] = _serialize_geometry_value(coords)
        exact_shapes.append(shape_record)
    return tuple(exact_shapes)


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


def _bbox_intersection_area(
    first: tuple[int, int, int, int],
    second: tuple[int, int, int, int],
) -> int:
    left = max(int(first[0]), int(second[0]))
    top = max(int(first[1]), int(second[1]))
    right = min(int(first[0] + first[2]), int(second[0] + second[2]))
    bottom = min(int(first[1] + first[3]), int(second[1] + second[3]))
    return max(0, right - left) * max(0, bottom - top)


def _fragment_container_instances(
    analysis: StickerSheetAnalysis,
) -> list[StickerInstance]:
    """Lấy vỏ ngoài đủ lớn, bỏ chữ/chi tiết nằm lồng trong cùng một tem."""
    page_area = max(1, int(analysis.width) * int(analysis.height))
    minimum_bbox_area = page_area * _AUTO_WHITE_CONTAINER_MIN_PAGE_RATIO
    minimum_width = analysis.width * _AUTO_WHITE_CONTAINER_MIN_EDGE_RATIO
    minimum_height = analysis.height * _AUTO_WHITE_CONTAINER_MIN_EDGE_RATIO
    candidates = [
        instance
        for instance in analysis.instances
        if instance.width * instance.height >= minimum_bbox_area
        and instance.width >= minimum_width
        and instance.height >= minimum_height
    ]
    candidates.sort(key=lambda item: item.width * item.height, reverse=True)

    containers: list[StickerInstance] = []
    for candidate in candidates:
        candidate_area = max(1, candidate.width * candidate.height)
        nested = False
        for larger in containers:
            larger_area = larger.width * larger.height
            if larger_area < candidate_area * _AUTO_WHITE_CONTAINER_LARGER_RATIO:
                continue
            covered = _bbox_intersection_area(candidate.bbox, larger.bbox)
            if covered / candidate_area >= _AUTO_WHITE_CONTAINER_NESTED_RATIO:
                nested = True
                break
        if not nested:
            containers.append(candidate)
    return containers


def _recover_white_body_component(
    source_rgb: np.ndarray,
    strict_labels: np.ndarray,
    record: dict[str, int],
    *,
    background_luma: int,
) -> np.ndarray | None:
    """Bóc dải bóng xám nối biên rồi lấp phần artwork bên trong một vỏ tem trắng."""
    x = int(record["x"])
    y = int(record["y"])
    width = int(record["width"])
    height = int(record["height"])
    raw_id = int(record["raw_id"])
    roi = np.s_[y:y + height, x:x + width]
    component = strict_labels[roi] == raw_id
    component_area = int(np.count_nonzero(component))
    if component_area < MIN_COMPONENT_AREA_PX:
        return None

    rgb = source_rgb[y:y + height, x:x + width, :3]
    luma = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    rgb_i16 = rgb.astype(np.int16, copy=False)
    chroma = rgb_i16.max(axis=2) - rgb_i16.min(axis=2)
    component_u8 = component.astype(np.uint8)
    boundary = component & (
        cv2.erode(component_u8, np.ones((3, 3), dtype=np.uint8)) == 0
    )
    shadow_luma_max = min(
        _AUTO_WHITE_SHADOW_LUMA_MAX,
        max(
            _AUTO_WHITE_SHADOW_LUMA_MIN,
            int(background_luma) - _AUTO_WHITE_SHADOW_BACKGROUND_GAP,
        ),
    )
    neutral_shadow = (
        component
        & (luma >= _AUTO_WHITE_SHADOW_LUMA_MIN)
        & (luma <= shadow_luma_max)
        & (chroma <= _AUTO_WHITE_SHADOW_CHROMA_MAX)
    )
    shadow_count, shadow_labels = cv2.connectedComponents(
        neutral_shadow.astype(np.uint8),
        connectivity=8,
    )
    if shadow_count > 1:
        attached_ids = np.unique(shadow_labels[boundary & neutral_shadow])
        attached_ids = attached_ids[attached_ids > 0]
        attached_shadow = np.isin(shadow_labels, attached_ids)
    else:
        attached_shadow = np.zeros(component.shape, dtype=bool)

    # §WHITE-SHADOW.3: bóng MỀM thì dừng ở đây, nhường cho AI. Đuôi gradient của nó lẫn
    # vào viền trắng và halo JPEG, nên mọi phép bóc/lấp bên dưới đều cho silhouette phình
    # ra ngoài viền trắng với biên chạy theo nhiễu — đúng lỗi người dùng báo 2026-08-16.
    shadow_luma_values = luma[attached_shadow]
    if shadow_luma_values.size:
        soft_tail_ratio = float(np.count_nonzero(
            shadow_luma_values
            > shadow_luma_max - _AUTO_WHITE_SHADOW_SOFT_TAIL_LUMA_SPAN
        )) / float(shadow_luma_values.size)
        if soft_tail_ratio > _AUTO_WHITE_SHADOW_SOFT_TAIL_RATIO_MAX:
            logger.info(
                "[STICKER] bỏ phục hồi thân tem trắng: bóng mềm (đuôi gradient %.1f%% "
                "> %.0f%%) — chuyển sang nhận diện AI",
                soft_tail_ratio * 100.0,
                _AUTO_WHITE_SHADOW_SOFT_TAIL_RATIO_MAX * 100.0,
            )
            return None

    # §WHITE-SHADOW.1: nới đúng MỘT pixel qua đuôi gradient bóng, chỉ tại chỗ đã dính
    # bóng. Dải sáng hơn 252 hoặc có sắc màu là điểm dừng nên không xuyên qua viền trắng
    # thật lẫn đường viền màu — cùng ràng buộc mà bộ khử bóng của luồng AI đang dùng.
    if attached_shadow.any():
        expanded = cv2.dilate(
            attached_shadow.astype(np.uint8),
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=1,
        ) > 0
        attached_shadow = attached_shadow | (
            expanded
            & component
            & (luma <= _AUTO_WHITE_SHADOW_EXPAND_LUMA_MAX)
            & (chroma <= _AUTO_WHITE_SHADOW_EXPAND_CHROMA_MAX)
        )
    removed_shadow = bool(attached_shadow.any())

    boundary_luma_min = max(225, min(255, int(background_luma) - 2))

    def _rim_white_ratio(mask: np.ndarray) -> float | None:
        """Tỉ lệ vành ngoài (2 px) của `mask` là trắng thật, theo đúng một tiêu chí."""
        mask_u8 = (mask > 0).astype(np.uint8) * 255
        eroded = cv2.erode(
            mask_u8,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
            iterations=1,
        )
        rim = (mask_u8 > 0) & (eroded == 0)
        colors = rgb[rim]
        if colors.size == 0:
            return None
        minimum = colors.min(axis=1)
        return float(np.count_nonzero(
            (minimum >= boundary_luma_min)
            & ((colors.max(axis=1) - minimum) <= 25)
        )) / float(len(colors))

    # Đo TRƯỚC khi bóc để biết việc bóc bóng có thật sự làm mép sạch hơn hay không.
    before_white = _rim_white_ratio(component)

    body_seed = (component & ~attached_shadow).astype(np.uint8)
    count, seed_labels, stats, _centroids = cv2.connectedComponentsWithStats(
        body_seed,
        connectivity=8,
    )
    if count <= 1:
        return None
    main_id = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    retained_area = int(stats[main_id, cv2.CC_STAT_AREA])
    if retained_area / component_area < _AUTO_WHITE_BODY_RETAINED_RATIO_MIN:
        return None

    seed = np.where(seed_labels == main_id, 255, 0).astype(np.uint8)
    contours, _hierarchy = cv2.findContours(
        seed,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_NONE,
    )
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    body = np.zeros(component.shape, dtype=np.uint8)
    cv2.fillPoly(body, [contour], 255, lineType=cv2.LINE_8)

    inner = cv2.erode(
        body,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        iterations=1,
    )
    body_boundary = (body > 0) & (inner == 0)
    boundary_colors = rgb[body_boundary]
    if boundary_colors.size == 0:
        return None
    boundary_minimum = boundary_colors.min(axis=1)
    boundary_chroma = boundary_colors.max(axis=1) - boundary_minimum
    white_boundary = (boundary_minimum >= boundary_luma_min) & (boundary_chroma <= 25)
    after_white = float(np.count_nonzero(white_boundary)) / float(len(boundary_colors))
    if after_white < _AUTO_WHITE_BOUNDARY_RATIO_MIN:
        return None

    # §WHITE-SHADOW.2: bóc bóng mà mép KHÔNG sạch hơn rõ rệt nghĩa là thứ vừa bóc không
    # phải bóng, hoặc bóng còn nguyên đuôi. Chỉ đòi mức cải thiện khi thực sự đã bóc —
    # tem viền trắng không có bóng thì `before` đã cao sẵn và không có gì để cải thiện.
    if removed_shadow and before_white is not None:
        if after_white - before_white < _AUTO_WHITE_BOUNDARY_GAIN_MIN:
            return None

    return body


def _recover_fragmented_near_white_sheet(
    source_image: Image.Image,
    background: BackgroundInfo,
    fragmented_analysis: StickerSheetAnalysis,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
) -> StickerSheetAnalysis | None:
    """Phục hồi thân tem trắng bị phép so màu nền xé thành viền/chữ rời.

    QUALITY (feedback 2026-08-16 §WHITE-SHEET.1): đây là nhánh có bằng chứng chặt,
    không phải phép ép bbox. Mask dung sai thấp chỉ dùng để khép đúng thân trắng; vỏ lớn
    từ lần dò đầu tiên giữ vai trò ánh xạ một-một và mọi ca mơ hồ đều quay lại AI.
    """
    if (
        not background.is_flat
        or not background.is_near_white
        or background.corner_p95 is None
        or not math.isfinite(float(background.corner_p95))
    ):
        return None
    containers = _fragment_container_instances(fragmented_analysis)
    if len(containers) < 2:
        return None

    strict_tolerance = max(1, int(round(float(background.corner_p95))))
    if strict_tolerance >= int(background.tolerance):
        return None
    source_rgb = np.array(source_image.convert("RGB"), dtype=np.uint8, copy=True)
    strict_mask = foreground_from_flat_background(
        source_rgb,
        background.color,
        strict_tolerance,
    )
    if strict_mask is None:
        return None
    min_area = max(
        MIN_COMPONENT_AREA_PX,
        int(strict_mask.size * MIN_COMPONENT_AREA_RATIO),
    )
    records, strict_labels = _component_records(strict_mask, min_area)
    if len(records) < len(containers):
        return None
    records_by_id = {int(record["raw_id"]): record for record in records}
    used_raw_ids: set[int] = set()
    mappings: list[tuple[StickerInstance, dict[str, int]]] = []
    for container in containers:
        margin = max(8, int(round(min(container.width, container.height) * 0.05)))
        left = max(0, container.x - margin)
        top = max(0, container.y - margin)
        right = min(strict_labels.shape[1], container.x + container.width + margin)
        bottom = min(strict_labels.shape[0], container.y + container.height + margin)
        values = strict_labels[top:bottom, left:right].reshape(-1)
        values = values[values > 0]
        if values.size == 0:
            return None
        raw_ids, counts = np.unique(values, return_counts=True)
        chosen_id = int(raw_ids[int(np.argmax(counts))])
        if chosen_id in used_raw_ids or chosen_id not in records_by_id:
            return None

        candidate_roi = strict_labels[
            container.y:container.y + container.height,
            container.x:container.x + container.width,
        ]
        overlap = int(np.count_nonzero(candidate_roi == chosen_id))
        candidate_area = max(1, container.width * container.height)
        if overlap / candidate_area < _AUTO_WHITE_STRICT_OVERLAP_RATIO:
            return None
        used_raw_ids.add(chosen_id)
        mappings.append((container, records_by_id[chosen_id]))

    background_pixel = np.asarray([[background.color]], dtype=np.uint8)
    background_luma = int(cv2.cvtColor(background_pixel, cv2.COLOR_RGB2GRAY)[0, 0])
    recovered_mask = np.zeros(strict_mask.shape, dtype=np.uint8)
    for container, record in mappings:
        body = _recover_white_body_component(
            source_rgb,
            strict_labels,
            record,
            background_luma=background_luma,
        )
        if body is None:
            return None
        x = int(record["x"])
        y = int(record["y"])
        width = int(record["width"])
        height = int(record["height"])
        body_points = cv2.findNonZero((body > 0).astype(np.uint8))
        if body_points is None:
            return None
        body_x, body_y, body_width, body_height = cv2.boundingRect(body_points)
        body_left = x + body_x
        body_top = y + body_y
        body_right = body_left + body_width
        body_bottom = body_top + body_height
        containment_margin = max(
            8,
            int(round(min(container.width, container.height) * 0.50)),
        )
        if (
            body_left < container.x - containment_margin
            or body_top < container.y - containment_margin
            or body_right > container.x + container.width + containment_margin
            or body_bottom > container.y + container.height + containment_margin
        ):
            return None
        overlap_left = max(container.x, x) - x
        overlap_top = max(container.y, y) - y
        overlap_right = min(container.x + container.width, x + width) - x
        overlap_bottom = min(container.y + container.height, y + height) - y
        if overlap_right <= overlap_left or overlap_bottom <= overlap_top:
            return None
        recovered_overlap = int(np.count_nonzero(
            body[overlap_top:overlap_bottom, overlap_left:overlap_right],
        ))
        container_area = max(1, container.width * container.height)
        if recovered_overlap / container_area < _AUTO_WHITE_STRICT_OVERLAP_RATIO:
            return None
        target = recovered_mask[y:y + height, x:x + width]
        if np.any((target > 0) & (body > 0)):
            return None
        target[body > 0] = 255

    try:
        recovered = _analysis_from_alpha(
            source_image,
            recovered_mask,
            model=model,
            alpha_threshold=alpha_threshold,
        )
    except StickerSourcePipelineError:
        return None
    if (
        len(recovered.instances) != len(containers)
        or _looks_like_fragmented_sticker_sheet(recovered)
    ):
        return None
    return recovered


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
                dpi=dpi,
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

    rendered_alpha = np.asarray(source_image.getchannel("A"), dtype=np.uint8)
    if (
        strategy in ("auto", "vector")
        and has_vector
        and has_meaningful_alpha(rendered_alpha, alpha_threshold)
    ):
        # QUALITY (feedback 2026-08-16 §XEPTEM.ALPHA): PDF vector/raster hỗn hợp
        # có thể cắt ảnh bằng clipping path hoặc SMask. Alpha SAU KHI render chính
        # là silhouette hợp thành của trang; đổi RGBA sang RGB trước sẽ làm lộ lại
        # pixel ảnh bị clip, biến tem có banner thành khung vuông rồi ép tròn sai.
        analysis = _analysis_from_alpha(
            source_image,
            rendered_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )
        exact_shapes = _detect_exact_vector_shapes(analysis, dpi=dpi)
        vector_geometry_ref: dict[str, object] = {
            "kind": "pdf-vector-source",
            "source_page": page_number,
            "preserve_original": True,
            "silhouette_source": "rendered-alpha",
        }
        if exact_shapes:
            vector_geometry_ref["exact_shapes"] = list(exact_shapes)
        return StickerSourceDetection(
            analysis=analysis,
            source_image=source_image,
            boundary_source="vector",
            strategy_confidence=0.96,
            needs_review=True,
            dpi=dpi,
            source_page=page_number,
            vector_geometry_ref=vector_geometry_ref,
            warnings=("vector-mask-raster-preview",),
        )

    if strategy in ("auto", "vector") and has_vector:
        detected = _background_detection(
            source_image,
            model=model,
            alpha_threshold=alpha_threshold,
            boundary_source="vector",
            dpi=dpi,
            minimum_confidence=(
                _AUTO_BACKGROUND_CONFIDENCE_MIN if strategy == "auto" else 0.0
            ),
        )
        if detected is not None:
            detected_ref = detected.vector_geometry_ref or {}
            vector_geometry_ref: dict[str, object] = {
                "kind": "pdf-vector-source",
                "source_page": page_number,
                "preserve_original": True,
            }
            exact_shapes = detected_ref.get("exact_shapes")
            if isinstance(exact_shapes, list) and exact_shapes:
                vector_geometry_ref["exact_shapes"] = exact_shapes
            return replace(
                detected,
                dpi=dpi,
                source_page=page_number,
                vector_geometry_ref=vector_geometry_ref,
                warnings=tuple(dict.fromkeys((
                    *detected.warnings,
                    "vector-mask-raster-preview",
                ))),
            )
        if strategy == "vector":
            raise StickerSourcePipelineError("Không suy ra được silhouette vector đáng tin cậy.")

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
            dpi=dpi,
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
