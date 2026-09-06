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
import re
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
from app.workers.sticker_artwork_guard import assess_ai_artwork_loss
from app.workers.sticker_shadow_boundary import recover_soft_shadow_alpha
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
    _align_labels_to_reference,
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
    "page-box",
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
# QUALITY (audit 2026-08-21 §STK.PREVIEW-GATE.1): nền phẳng là cổng rất nhanh,
# nhưng mask nhị phân của JPEG có thể bám theo răng cưa/halo 1 px và làm đường bế
# preview khác hẳn đường xuất (nhánh xuất đã nâng sang Alpha AI). Đo độ lệch p99
# so với contour đã Gaussian-smooth và tỷ lệ góc gắt trên contour đã smooth; chỉ
# cần một trong hai vượt ngưỡng là nâng hình học. Đo sau smooth để các góc 45° do
# raster của một hình tròn sạch không bị coi là rác. Nhánh nhiều tem không qua cổng.
_SIMPLE_BG_PREVIEW_ROUGHNESS_SMOOTH_SIGMA_PX = 3.0
_SIMPLE_BG_PREVIEW_ROUGHNESS_DEVIATION_P99_PX = 1.20
_SIMPLE_BG_PREVIEW_ROUGHNESS_TURN_DEGREES = 45.0
_SIMPLE_BG_PREVIEW_ROUGHNESS_TURN_RATIO_MIN = 0.05
_SIMPLE_BG_AI_IOU_MIN = 0.80
_SIMPLE_BG_AI_ARTWORK_LOSS_WARNING = "simple-bg-ai-artwork-loss-rejected"
_SIMPLE_BG_AI_VALIDATION_FAILED_WARNING = "simple-bg-ai-validation-unavailable"
_COLORED_SHADOW_WARNING = "simple-bg-colored-shadow-removed"
_SIMPLE_BG_PREVIEW_DENOISE_FALLBACK_WARNING = (
    "simple-bg-preview-denoise-fallback"
)
# QUALITY (audit 2026-08-20 §CUTLINE.EDGE): silhouette composite đã loại bóng
# lệch cần fitter giữ nhiều điểm hơn để file xuất khớp đúng preview; chỉ áp dụng
# khi detector đã gắn marker, không đổi fidelity của các nguồn khác.
_COMPOSITE_CUTLINE_FIDELITY_MIN = 95.0
_COMPOSITE_CUTLINE_WARNINGS = frozenset({
    "simple-bg-composite-recovered",
    "simple-bg-drop-shadow-removed",
})

# QUALITY (feedback 2026-08-21 §FULLPAGE.1): ảnh quảng cáo/thẻ thành phẩm thường
# là MỘT nhãn chữ nhật phủ kín trang. Khi không có nền ngoài, mô hình tách nền chỉ
# chọn vài chữ/quả nổi bật và ``instances`` trở thành số mảnh nội bộ, không còn là
# số tem. Fallback dưới đây chỉ dùng cho hợp đồng một-tem (preview classic/legacy),
# có bằng chứng PDF là một ảnh phủ kín trang, mask AI quá nhỏ, bốn mép không phải
# nền gần trắng và phần bị AI bỏ vẫn còn nhiều chi tiết ảnh thật.
_FULL_PAGE_AI_MASK_MAX_RATIO = 0.35
_FULL_PAGE_BORDER_NEAR_WHITE_MAX_RATIO = 0.60
_FULL_PAGE_RESIDUAL_EDGE_MIN_RATIO = 0.08
_FULL_PAGE_RESIDUAL_LUMA_STD_MIN = 18.0
_FULL_PAGE_METRIC_MAX_EDGE_PX = 512
_FULL_PAGE_NEAR_WHITE_MIN_CHANNEL = 245
_FULL_PAGE_NEAR_WHITE_MAX_CHROMA = 18
_FULL_PAGE_WARNING = "full-page-artwork-page-box"


def _effective_composite_curve_tension(
    requested: float | int | None,
    corner_style: str,
    warnings: object,
) -> float:
    """Giữ góc gốc cho composite; chỉ bo khi người dùng chọn round."""
    try:
        value = float(requested if requested is not None else 50.0)
    except (TypeError, ValueError):
        value = 50.0
    if not math.isfinite(value):
        value = 50.0
    try:
        warning_set = {str(item) for item in (warnings or ())}
    except TypeError:
        warning_set = set()
    if (
        warning_set.intersection(_COMPOSITE_CUTLINE_WARNINGS)
        and str(corner_style).strip().lower() != "round"
    ):
        # QUALITY (audit 2026-08-20 §CUTLINE.EDGE): route classic từng gửi
        # tension mặc định dù thanh bo đã ẩn; bỏ bo ngầm để path bám mép ảnh.
        return 0.0
    return value


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

# QUALITY (audit 2026-08-20 §STICKER-COMPOSITE.1): một số tem raster có viền
# trắng/xám tách khỏi phần artwork. BiRefNet có thể coi các mảng màu sáng bên
# trong là nền và làm lõm silhouette. Chỉ phục hồi trường hợp rất hẹp có một
# vỏ ngoài bao toàn bộ các mảnh đang chồng lên nhau; không biến mask nền thô của
# tờ nhiều tem thành một đường cắt mới.
_COMPOSITE_MIN_COMPONENTS = 3
_COMPOSITE_MAX_COMPONENTS = 12
_COMPOSITE_COMPONENT_AREA_RATIO = 0.001
_COMPOSITE_SHELL_MIN_PAGE_RATIO = 0.55
_COMPOSITE_SHELL_AREA_RATIO_MIN = 0.005
_COMPOSITE_SHELL_AREA_RATIO_MAX = 0.15
_COMPOSITE_CHILD_OVERLAP_RATIO = 0.08
_COMPOSITE_CLOSE_KERNEL_RATIO = 0.035
_COMPOSITE_CLOSE_KERNEL_MIN = 9
_COMPOSITE_CLOSE_KERNEL_MAX = 41
_COMPOSITE_MAX_SEGMENTS = 240
_COMPOSITE_COLOR_COVERAGE_MIN = 0.90
# QUALITY (audit 2026-08-20 §WHITE-OFFSET-SHADOW): ảnh AI thường có một dải
# offset trắng thật rồi mới tới bóng đổ xám lệch hướng. Không được nhập dải bóng
# này vào CutContour. Các guard dưới đây cố ý chặt: không đủ bằng chứng thì giữ
# nhánh composite cũ/AI, tuyệt đối không đoán silhouette mới.
_COMPOSITE_SHADOW_NEUTRAL_MIN = 0.98
_COMPOSITE_SHADOW_MATERIAL_MAX = 0.005
_COMPOSITE_SHADOW_DIRECTION_RESULTANT_MIN = 0.35
_COMPOSITE_SHADOW_DIRECTION_HALF_MIN = 0.72
_COMPOSITE_SHADOW_DIRECTION_SHIFT_MIN = 0.45
_COMPOSITE_SHADOW_GAP_MIN_PX = 2.0
_COMPOSITE_SHADOW_GAP_SPREAD_MAX = 2.0
_COMPOSITE_SHADOW_GAP_MAX_EDGE_RATIO = 0.04
# Mỗi container có thêm một chút biên raster vì khoảng cách tới trọng tâm lõi
# thường lớn hơn đúng bề rộng bóng (các lobe ở góc làm p95 nở ra).
_COMPOSITE_MULTI_SHADOW_GAP_MAX_EDGE_RATIO = 0.06
_COMPOSITE_SHADOW_BOUNDARY_MIN = 0.88
_COMPOSITE_SHADOW_BOUNDARY_GAIN_MIN = 0.08


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
    background_rgb: tuple[int, int, int] | None = None
    background_tolerance: int = 0
    background_is_flat: bool = False


@dataclass(frozen=True)
class LegacyApprovedContour:
    """Alpha và Bézier đã duyệt để luồng cũ xuất mà không nhận diện lại."""

    alpha: np.ndarray
    dpi: tuple[float, float]
    path_groups: list[dict[str, object]]
    boundary_source: str
    instance_count: int
    source_pixel_mm: float
    edge_background_rgb: tuple[int, int, int] | None = None
    edge_background_tolerance: int = 0


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
    *,
    object_ids: list[str] | None = None,
) -> tuple[Image.Image, tuple[float, float]]:
    import pypdfium2 as pdfium

    if object_ids is not None:
        from app.workers.sticker_engine import _render_selected_objects_rgba

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
                if object_ids is not None:
                    # UIUX (audit 2026-09-06 §CUSTOM.2): cô lập trên document dùng
                    # một lần, cùng scale/trang xoay; không sửa PDF nguồn của session.
                    try:
                        selected_rgba = _render_selected_objects_rgba(page, object_ids, scale)
                    except ValueError as exc:
                        raise StickerSourcePipelineError(
                            "Lựa chọn không còn khớp đối tượng PDF. Hãy chọn lại vùng tem."
                        ) from exc
                    raw_image = None
                else:
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
    if object_ids is not None:
        image = Image.fromarray(selected_rgba, "RGBA")
    else:
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


def _page_box_detection(
    source_image: Image.Image,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    dpi: tuple[float, float] | None,
    source_page: int,
) -> StickerSourceDetection:
    """Dựng một silhouette kín đúng khổ trang, không dò nền hay chạy AI.

    UI có tùy chọn bỏ nền trắng; khi tùy chọn đó tắt, hợp đồng của luồng xuất là
    coi toàn bộ trang như một tem hình chữ nhật. Preview phải dùng đúng mask đó,
    thay vì vô tình gọi detector AI/vector rồi cho ra một silhouette khác.
    """
    # QUALITY (audit 2026-09-06 §BACKGROUND.2): mask kín trang phải hiển thị
    # nguồn trên giấy trắng. Bỏ Alpha trực tiếp sẽ làm lộ RGB đen ẩn ở pixel
    # trong suốt và làm sai cả màu mép bán trong suốt khi xuất/bù xén.
    source_image = Image.alpha_composite(
        Image.new("RGBA", source_image.size, (255, 255, 255, 255)),
        source_image.convert("RGBA"),
    )
    height, width = source_image.height, source_image.width
    full_alpha = np.full((height, width), 255, dtype=np.uint8)
    analysis = _analysis_from_alpha(
        source_image,
        full_alpha,
        model=model,
        alpha_threshold=alpha_threshold,
    )
    return StickerSourceDetection(
        analysis=analysis,
        source_image=source_image,
        boundary_source="page-box",
        strategy_confidence=1.0,
        needs_review=False,
        dpi=dpi,
        source_page=source_page,
        vector_geometry_ref=None,
        warnings=(),
    )


def _full_page_artwork_metrics(
    source_image: Image.Image,
    analysis: StickerSheetAnalysis,
    *,
    source_fills_page: bool,
) -> dict[str, float] | None:
    """Chứng minh mask AI chỉ là vài mảnh nằm trong một artwork kín trang.

    Không dùng số component làm bằng chứng vì đó chính là nguyên nhân false
    positive. Cổng này đo ba đại lượng độc lập trên thumbnail tối đa 512 px:

    - mask AI chỉ phủ một phần nhỏ trang;
    - cả bốn mép không phải vành nền gần trắng;
    - phần ngoài mask vẫn giàu biên/texture, tức là nội dung bị AI bỏ chứ không
      phải khoảng trống phẳng giữa các tem.

    Trả metrics để log/test hoặc ``None`` khi thiếu bất kỳ bằng chứng nào.
    """
    if not source_fills_page or not analysis.instances:
        return None
    labels = np.asarray(analysis.labels)
    if labels.shape != (source_image.height, source_image.width):
        return None
    mask = labels > 0
    mask_ratio = float(np.mean(mask))
    if not math.isfinite(mask_ratio) or mask_ratio > _FULL_PAGE_AI_MASK_MAX_RATIO:
        return None

    rgb = np.asarray(source_image.convert("RGB"), dtype=np.uint8)
    height, width = rgb.shape[:2]
    if min(height, width) < 16:
        return None
    scale = min(
        1.0,
        _FULL_PAGE_METRIC_MAX_EDGE_PX / float(max(height, width)),
    )
    if scale < 1.0:
        thumb_size = (
            max(8, int(round(width * scale))),
            max(8, int(round(height * scale))),
        )
        rgb = cv2.resize(rgb, thumb_size, interpolation=cv2.INTER_AREA)
        mask = cv2.resize(
            mask.astype(np.uint8),
            thumb_size,
            interpolation=cv2.INTER_NEAREST,
        ) > 0

    height, width = rgb.shape[:2]
    band = max(2, int(round(min(height, width) * 0.02)))
    edge_strips = (
        rgb[:band, :, :],
        rgb[-band:, :, :],
        rgb[:, :band, :],
        rgb[:, -band:, :],
    )
    border_near_white_ratios: list[float] = []
    for strip in edge_strips:
        minimum = np.min(strip, axis=2)
        chroma = np.max(strip, axis=2) - minimum
        near_white = (
            (minimum >= _FULL_PAGE_NEAR_WHITE_MIN_CHANNEL)
            & (chroma <= _FULL_PAGE_NEAR_WHITE_MAX_CHROMA)
        )
        border_near_white_ratios.append(float(np.mean(near_white)))
    border_near_white_max = max(border_near_white_ratios)
    if border_near_white_max > _FULL_PAGE_BORDER_NEAR_WHITE_MAX_RATIO:
        return None

    support = cv2.dilate(
        mask.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        iterations=1,
    ) > 0
    outside = ~support
    outside_count = int(np.count_nonzero(outside))
    if outside_count < max(64, int(outside.size * 0.25)):
        return None
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gradient_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(gray, cv2.CV_16S, 0, 1, ksize=3)
    gradient = np.maximum(np.abs(gradient_x), np.abs(gradient_y))
    residual_edge_ratio = float(np.mean(gradient[outside] > 40))
    residual_luma_std = float(np.std(gray[outside]))
    if (
        residual_edge_ratio < _FULL_PAGE_RESIDUAL_EDGE_MIN_RATIO
        or residual_luma_std < _FULL_PAGE_RESIDUAL_LUMA_STD_MIN
    ):
        return None
    return {
        "mask_ratio": mask_ratio,
        "border_near_white_max": border_near_white_max,
        "residual_edge_ratio": residual_edge_ratio,
        "residual_luma_std": residual_luma_std,
    }


def _full_page_artwork_page_box_detection(
    source_image: Image.Image,
    analysis: StickerSheetAnalysis,
    *,
    source_fills_page: bool,
    model: StickerSheetModel,
    alpha_threshold: int,
    dpi: tuple[float, float] | None,
    source_page: int,
) -> StickerSourceDetection | None:
    """Đổi salient fragments thành khung trang trong luồng một-tem duy nhất."""
    metrics = _full_page_artwork_metrics(
        source_image,
        analysis,
        source_fills_page=source_fills_page,
    )
    if metrics is None:
        return None
    logger.info(
        "[STICKER_FULL_PAGE] dùng khung trang thay %d mảnh AI: "
        "mask=%.1f%% border_white_max=%.1f%% residual_edge=%.1f%% "
        "residual_std=%.1f",
        len(analysis.instances),
        metrics["mask_ratio"] * 100.0,
        metrics["border_near_white_max"] * 100.0,
        metrics["residual_edge_ratio"] * 100.0,
        metrics["residual_luma_std"],
    )
    return replace(
        _page_box_detection(
            source_image,
            model=model,
            alpha_threshold=alpha_threshold,
            dpi=dpi,
            source_page=source_page,
        ),
        strategy_confidence=0.90,
        needs_review=True,
        warnings=(_FULL_PAGE_WARNING,),
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
    # §CUTJAG.PARITY1: None = cổng tự động cũ; 0 = người dùng tắt hẳn.
    cutline_denoise: float | None = None,
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
    source_fills_page = _full_page_raster_scale_limit(source_path, 0) is not None
    detection_started = time.perf_counter()
    edge_background_rgb: tuple[int, int, int] | None = None
    edge_background_tolerance = 0
    try:
        effective_cutline_fidelity = float(
            cutline_fidelity if cutline_fidelity is not None else 50.0
        )
    except (TypeError, ValueError):
        effective_cutline_fidelity = 50.0
    if not math.isfinite(effective_cutline_fidelity):
        effective_cutline_fidelity = 50.0
    effective_curve_tension = _effective_composite_curve_tension(
        curve_tension,
        corner_style,
        (),
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
        # PERF/QUALITY (audit 2026-08-19 §STK.MEM02/EDGE01): cầu nối legacy
        # trước đây gọi BiRefNet ngay cả khi bốn góc chứng minh được nền phẳng.
        # Dùng đúng cổng deterministic của workspace trước; ngoài việc nhanh hơn,
        # kết quả này còn giữ màu nền thật để bước lấy màu viền không hút halo AA.
        detected = _background_detection(
            source_image,
            model=model,
            alpha_threshold=alpha_threshold,
            boundary_source="simple-bg",
            dpi=dpi,
            minimum_confidence=_AUTO_BACKGROUND_CONFIDENCE_MIN,
        )
        if detected is not None and detected.background_is_flat:
            edge_background_rgb = detected.background_rgb
            edge_background_tolerance = max(
                0,
                int(detected.background_tolerance),
            )
        if detected is not None and set(detected.warnings).intersection(
            _COMPOSITE_CUTLINE_WARNINGS
        ):
            # QUALITY (audit 2026-08-20 §CUTLINE.EDGE): giữ cùng profile precision
            # với preview workspace; key/cache vẫn dùng giá trị caller gửi.
            effective_cutline_fidelity = max(
                effective_cutline_fidelity,
                _COMPOSITE_CUTLINE_FIDELITY_MIN,
            )
            effective_curve_tension = _effective_composite_curve_tension(
                curve_tension,
                corner_style,
                detected.warnings,
            )
        if (
            detected is not None
            and "simple-bg-composite-recovered" in detected.warnings
        ):
            # QUALITY (audit 2026-08-20 §STICKER-COMPOSITE.3): đây là artifact
            # đã qua cổng topology + fitter ở trên, nên legacy phải dùng đúng
            # Alpha đó. Nếu gọi AI lại tại đây preview và file xuất sẽ lệch nhau.
            analysis = detected.analysis
            boundary_source = "simple-bg"
        elif detected is not None and len(detected.analysis.instances) == 1:
            # QUALITY (audit 2026-09-05 §SHADOW.2): legacy không có canonical
            # preview cũng phải qua cùng chốt bảo vệ thân tem, không gọi AI rồi
            # tin Alpha trực tiếp và mở lại lỗi đã chặn ở workspace.
            resolved = _upgrade_single_simple_background_geometry(
                replace(detected, dpi=dpi), source_image,
                model=model, alpha_threshold=alpha_threshold,
            )
            analysis = resolved.analysis
            boundary_source = resolved.boundary_source
        else:
            # QUALITY (feedback 2026-08-19 §STK.CUTJAG04): deterministic chỉ cấp
            # ngữ cảnh MÀU nền; các ca simple-bg một component vẫn giữ Alpha hình
            # học của AI để tránh mask nhị phân sinh đường rác.
            try:
                analysis = analyze_sticker_sheet(
                    source_image.convert("RGB"),
                    model=model,
                    alpha_threshold=alpha_threshold,
                )
            except StickerSheetError as exc:
                raise StickerSourcePipelineError(str(exc)) from exc
            boundary_source = "ai"

    if boundary_source == "ai":
        page_box = _full_page_artwork_page_box_detection(
            source_image,
            analysis,
            source_fills_page=source_fills_page,
            model=model,
            alpha_threshold=alpha_threshold,
            dpi=dpi,
            source_page=1,
        )
        if page_box is not None:
            analysis = page_box.analysis
            boundary_source = page_box.boundary_source

    logger.info(
        "[STICKER_STAGE] stage=legacy_contour_detection boundary=%s "
        "instances=%d raster_px=%dx%d seconds=%.3f",
        boundary_source,
        len(analysis.instances),
        source_image.width,
        source_image.height,
        time.perf_counter() - detection_started,
    )

    # Chế độ cũ là một tem trên một trang. Không biến cầu nối parity này thành
    # bộ tách nhiều tem; ca đó vẫn thuộc workspace AI có bước review riêng.
    if len(analysis.instances) != 1:
        return None

    # QUALITY (feedback 2026-08-19 §CUTJAG.PARITY1): `0` là một lựa chọn
    # có chủ đích, không phải sentinel cho cổng tự động. Chỉ caller cũ
    # thiếu field/None mới được presmooth theo loại biên.
    use_automatic_presmooth = cutline_denoise is None
    resolved_cutline_denoise = (
        0.0 if cutline_denoise is None else cutline_denoise
    )
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
            cutline_fidelity=effective_cutline_fidelity,
            curve_tension=effective_curve_tension,
            min_detail_area_mm2=min_detail_area_mm2,
            cutline_denoise=resolved_cutline_denoise,
            presmooth_alpha=(
                use_automatic_presmooth
                and should_presmooth_cutline_alpha(boundary_source)
            ),
        )
    except UnsafeCutlineGeometryError as exc:
        raise StickerSourcePipelineError(str(exc)) from exc
    if cutline is None or not cutline.get("path_groups"):
        raise StickerSourcePipelineError(
            "Không tạo được đường bế an toàn từ vùng tem đã nhận diện."
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
        edge_background_rgb=edge_background_rgb,
        edge_background_tolerance=edge_background_tolerance,
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
    recovered_composite = False
    if boundary_source == "simple-bg" and minimum_confidence > 0.0:
        fragmented = _looks_like_fragmented_sticker_sheet(analysis)
        # QUALITY (audit 2026-08-20 §WHITE-OFFSET-SHADOW): tờ nhiều tem có thể
        # chỉ còn vỏ + một mảng lõi cho mỗi tem (chưa đạt ngưỡng ``fragmented``),
        # nhưng vẫn cần đi qua cổng bóng lệch theo từng container. Guard bên
        # trong cổng này sẽ trả None cho ảnh nhiều tem bình thường.
        containers = _fragment_container_instances(analysis)
        recovered_multi = None
        if len(containers) >= 2:
            recovered_multi = _recover_multi_composite_shadow_sheet(
                source_image,
                background,
                analysis,
                model=model,
                alpha_threshold=alpha_threshold,
                dpi=dpi,
            )
        if recovered_multi is not None:
            analysis = recovered_multi
            recovered_composite = True
        elif fragmented:
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
                composite = _recover_single_composite_background(
                    source_image,
                    background,
                    model=model,
                    alpha_threshold=alpha_threshold,
                    dpi=dpi,
                )
                if composite is None:
                    return None
                analysis = composite
                recovered_composite = True
            else:
                analysis = recovered
                recovered_white_body = True
    # QUALITY (audit 2026-09-05 §SHADOW.1): dùng chung biên thân/bóng ở hai chế
    # độ, chỉ sau các nhánh offset/viền trắng đã được kiểm riêng. Không thay bộ
    # dò nền dùng chung hoặc biến RGB chưa có biên chắc chắn thành shape đoán.
    if (
        boundary_source == "simple-bg" and minimum_confidence > 0.0
        and background.is_flat and not recovered_composite and not recovered_white_body
    ):
        try:
            shadow_alpha = recover_soft_shadow_alpha(
                rgb, analysis.alpha, analysis.labels, tuple(int(v) for v in background.color),
            )
            if shadow_alpha is not None:
                shadow_analysis = _analysis_from_alpha(
                    source_image, shadow_alpha, model=model, alpha_threshold=alpha_threshold,
                )
                if len(shadow_analysis.instances) == len(analysis.instances):
                    # BBox/centroid đổi khi bỏ bóng không được đổi ID/thứ tự
                    # tem. Đối chiếu overlap với labels gốc như nhánh Refine.
                    aligned, mapping = _align_labels_to_reference(shadow_analysis.labels, analysis.labels)
                    shadow_analysis.labels = aligned
                    shadow_analysis.instances = sorted(
                        (replace(item, id=mapping[item.id]) for item in shadow_analysis.instances),
                        key=lambda item: item.id,
                    )
                    analysis = shadow_analysis
                    analysis.warnings.extend((_COLORED_SHADOW_WARNING, "simple-bg-drop-shadow-removed"))
        except (cv2.error, MemoryError, ValueError, StickerSheetError):
            logger.warning("Không xác minh được biên bóng mềm; giữ nhận diện hiện có", exc_info=True)

    exact_shapes: tuple[dict[str, object], ...] = ()
    if boundary_source == "vector":
        # QUALITY (feedback 2026-08-16 §XEPTEM.ALPHA): hình chuẩn chỉ được suy ra
        # từ silhouette đã chấp nhận. Cạnh RGB nằm BÊN TRONG artwork không có quyền
        # thay mask thành hình tròn vì sẽ cắt mất banner/tai/chi tiết nhô ra.
        exact_shapes = _detect_exact_vector_shapes(analysis, dpi=dpi)
    confidence = background.confidence if boundary_source == "simple-bg" else min(0.72, background.confidence)
    if recovered_white_body:
        confidence = min(confidence, 0.84)
    detection_warnings: list[str] = []
    if any(shape.get("kind") in {"circle", "ellipse"} for shape in exact_shapes):
        detection_warnings.append("round-sticker-contour-inferred")
    if recovered_composite:
        detection_warnings.append("simple-bg-composite-recovered")
    if "simple-bg-drop-shadow-removed" in analysis.warnings:
        detection_warnings.append("simple-bg-drop-shadow-removed")
    if _COLORED_SHADOW_WARNING in analysis.warnings:
        detection_warnings.append(_COLORED_SHADOW_WARNING)

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
        warnings=tuple(detection_warnings),
        background_rgb=tuple(int(value) for value in background.color),
        background_tolerance=max(0, int(background.tolerance)),
        background_is_flat=bool(background.is_flat),
    )


def _simple_bg_preview_needs_geometry_upgrade(
    analysis: StickerSheetAnalysis,
) -> bool:
    """Đo nhanh răng cưa của mask nền phẳng trước khi preview gọi AI.

    ``preview_only`` trước đây luôn giữ nguyên mask `simple-bg`, trong khi luồng
    xuất tự nâng ca một-tem sang Alpha AI. Với ảnh JPEG có halo, hai mask này có
    thể cùng một bbox nhưng quỹ đạo khác nhau vài pixel quanh toàn bộ viền. Hàm
    này chỉ là cổng quyết định (không sửa mask): contour được Gaussian-smooth
    theo vòng kín rồi đo p99 độ lệch và tỷ lệ góc quay gắt. Một trong hai vượt
    ngưỡng là đủ gọi AI; hình tròn sạch sau smooth không còn các góc raster giả.

    Chỉ nhận một instance; tờ nhiều tem vẫn giữ fast path deterministic như hợp
    đồng của chế độ ``Tách nhiều tem``.
    """
    if (
        _COLORED_SHADOW_WARNING in analysis.warnings
        or len(analysis.instances) != 1
        or not isinstance(analysis.labels, np.ndarray)
        or analysis.labels.ndim != 2
    ):
        return False
    instance = analysis.instances[0]
    labels = np.asarray(analysis.labels)
    left = max(0, int(instance.x))
    top = max(0, int(instance.y))
    right = min(labels.shape[1], left + int(instance.width))
    bottom = min(labels.shape[0], top + int(instance.height))
    if right <= left or bottom <= top:
        return False
    component = np.ascontiguousarray(
        (labels[top:bottom, left:right] == int(instance.id)).astype(np.uint8)
    )
    contours, _hierarchy = cv2.findContours(
        component,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_NONE,
    )
    if not contours:
        return False
    contour = max(contours, key=cv2.contourArea)
    points = contour.reshape(-1, 2).astype(np.float64, copy=False)
    point_count = int(len(points))
    if point_count < 8:
        return False
    sigma = float(_SIMPLE_BG_PREVIEW_ROUGHNESS_SMOOTH_SIGMA_PX)
    padding = max(8, int(round(sigma * 5.0)))
    padded = np.vstack((points[-padding:], points, points[:padding]))
    smoothed = cv2.GaussianBlur(
        padded.reshape(-1, 1, 2),
        (0, 0),
        sigmaX=sigma,
    ).reshape(-1, 2)[padding:-padding]
    deviation = np.linalg.norm(points - smoothed, axis=1)
    p99_deviation = float(np.percentile(deviation, 99.0))

    previous = np.roll(smoothed, 1, axis=0)
    following = np.roll(smoothed, -1, axis=0)
    incoming = smoothed - previous
    outgoing = following - smoothed
    denominator = np.linalg.norm(incoming, axis=1) * np.linalg.norm(outgoing, axis=1)
    cosine = np.divide(
        np.sum(incoming * outgoing, axis=1),
        denominator,
        out=np.ones_like(denominator),
        where=denominator > 1e-9,
    )
    turns = np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))
    turn_ratio = float(np.mean(
        turns > float(_SIMPLE_BG_PREVIEW_ROUGHNESS_TURN_DEGREES)
    ))
    rough_by_deviation = (
        math.isfinite(p99_deviation)
        and p99_deviation > _SIMPLE_BG_PREVIEW_ROUGHNESS_DEVIATION_P99_PX
    )
    rough_by_turn = (
        math.isfinite(turn_ratio)
        and turn_ratio > _SIMPLE_BG_PREVIEW_ROUGHNESS_TURN_RATIO_MIN
    )
    if not (rough_by_deviation or rough_by_turn):
        return False
    logger.info(
        "[STICKER_PREVIEW_GATE] simple-bg contour thô: points=%d "
        "p99_deviation=%.3fpx turn_ratio=%.3f; nâng hình học sang AI",
        point_count,
        p99_deviation,
        turn_ratio,
    )
    return True


def _upgrade_single_simple_background_geometry(
    detected: StickerSourceDetection,
    source_image: Image.Image,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
) -> StickerSourceDetection:
    """Dùng Alpha AI cho hình học khi auto chỉ tìm được một tem nền phẳng.

    QUALITY (feedback 2026-08-19 §STK.MULTI-CUT01): chế độ Tách nhiều tem phải
    giữ fast path deterministic khi nó thật sự tách nhiều tem. Riêng ca chỉ có
    một tem, Alpha `simple-bg` nhị phân đã xuất 11 CutContour/905 cubic trên file
    thật. Chạy AI đúng một lần và chỉ nhận khi silhouette AI vẫn là đúng một tem,
    chồng khít với mask chắc chắn ban đầu.
    Màu nền scalar của `detected` được giữ nguyên cho bước sinh bù xén.
    """
    if (
        detected.boundary_source != "simple-bg"
        or len(detected.analysis.instances) != 1
        or "simple-bg-composite-recovered" in detected.warnings
        or _COLORED_SHADOW_WARNING in detected.warnings
    ):
        return detected

    try:
        ai_analysis = analyze_sticker_sheet(
            source_image.convert("RGB"),
            model=model,
            alpha_threshold=alpha_threshold,
        )
    except (StickerSheetError, MemoryError):
        # PERF/STABILITY (feedback 2026-08-20 §CUTPREVIEW.MEM2): đây chỉ là
        # bước nâng hình học tùy chọn. Mask nền phẳng đã hợp lệ phải tiếp tục
        # cấp preview nếu allocator hết chỗ sau inference, không được biến thành
        # HTTP 500 rồi khiến WebView đóng session.
        logger.warning(
            "Không nâng được hình học simple-bg sang AI; giữ mask đã nhận diện",
            exc_info=True,
        )
        return detected
    if len(ai_analysis.instances) != 1:
        logger.info(
            "Giữ simple-bg vì AI đổi số tem: deterministic=1 ai=%d",
            len(ai_analysis.instances),
        )
        return detected

    deterministic_mask = detected.analysis.labels > 0
    ai_mask = ai_analysis.labels > 0
    intersection = int(np.count_nonzero(deterministic_mask & ai_mask))
    union = int(np.count_nonzero(deterministic_mask | ai_mask))
    overlap = float(intersection) / float(max(1, union))
    if overlap < _SIMPLE_BG_AI_IOU_MIN:
        logger.info(
            "Giữ simple-bg vì Alpha AI lệch silhouette (IoU=%.3f)",
            overlap,
        )
        return detected

    # QUALITY (audit 2026-09-05 §SHADOW.2): một mảng artwork bị bỏ vẫn có thể
    # đạt IoU 0,89. So vùng mất cục bộ với RGB; từ chối thì giữ nguyên analysis
    # simple-bg để Refine không nạp lại raw Alpha nguy hiểm từ ứng viên AI.
    try:
        loss = assess_ai_artwork_loss(
            np.asarray(source_image.convert("RGB"), dtype=np.uint8),
            deterministic_mask, ai_mask,
        )
    except (cv2.error, MemoryError, ValueError):
        logger.warning("Không kiểm được phần artwork AI bỏ; giữ mask nguồn", exc_info=True)
        return replace(
            detected, needs_review=True,
            warnings=tuple(dict.fromkeys((*detected.warnings, _SIMPLE_BG_AI_VALIDATION_FAILED_WARNING))),
        )
    if loss.rejected:
        logger.info(
            "Giữ simple-bg vì AI bỏ artwork: reason=%s area=%d detail_ratio=%.3f unsupported_run=%d",
            loss.reason, loss.lost_area_px, loss.detail_ratio, loss.unsupported_run_px,
        )
        return replace(
            detected, needs_review=True,
            warnings=tuple(dict.fromkeys((*detected.warnings, _SIMPLE_BG_AI_ARTWORK_LOSS_WARNING))),
        )

    logger.info(
        "[STICKER_GEOMETRY] simple-bg→ai instances=1 iou=%.3f",
        overlap,
    )
    return replace(
        detected,
        analysis=ai_analysis,
        boundary_source="ai",
        strategy_confidence=min(
            float(detected.strategy_confidence),
            float(np.mean([item.confidence for item in ai_analysis.instances])),
        ),
        needs_review=True,
        warnings=tuple(dict.fromkeys((
            *detected.warnings,
            *ai_analysis.warnings,
            "simple-bg-color-ai-geometry",
        ))),
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


def _recover_composite_white_offset_from_shadow(
    source_rgb: np.ndarray,
    raw_labels: np.ndarray,
    components: list[dict[str, int]],
    shell_id: int,
    *,
    background_rgb: tuple[int, int, int],
    baseline_mask: np.ndarray,
    gap_edge_limit_px: float | None = None,
) -> np.ndarray | None:
    """Dựng mép offset trắng ở phía *trong* một vỏ bóng xám lệch hướng.

    Khi nền ảnh cũng là trắng, ``foreground_from_flat_background`` làm mất dải
    offset trắng và chỉ để lại artwork màu cùng drop shadow. Nhánh composite cũ
    khép toàn bộ các component, vì vậy đường bế chạy theo mép ngoài bóng. Ở đây
    chỉ nhận một vỏ trung tính, mảnh, có hướng rõ ràng; lấy các component màu làm
    lõi, đo khoảng hở tới vỏ và nới lõi tới đúng mép trong của bóng. Mọi guard
    thất bại đều trả ``None`` để caller dùng đường cũ.
    """
    if (
        source_rgb.ndim != 3
        or source_rgb.shape[2] < 3
        or raw_labels.shape != source_rgb.shape[:2]
        or len(components) < _COMPOSITE_MIN_COMPONENTS
    ):
        return None

    # Chỉ xử lý ROI bao các component đã chọn. Với PDF có lề lớn, cách này
    # tránh dựng luma/chroma/distance-transform trên toàn trang trong lúc
    # preview; mask trả về vẫn giữ nguyên kích thước ảnh nguồn.
    left = max(0, min(int(item["x"]) for item in components))
    top = max(0, min(int(item["y"]) for item in components))
    right = min(
        source_rgb.shape[1],
        max(int(item["x"]) + int(item["width"]) for item in components),
    )
    bottom = min(
        source_rgb.shape[0],
        max(int(item["y"]) + int(item["height"]) for item in components),
    )
    if right <= left or bottom <= top:
        return None
    rgb = source_rgb[top:bottom, left:right, :3]
    labels = raw_labels[top:bottom, left:right]
    baseline = baseline_mask[top:bottom, left:right]
    rgb_i16 = rgb.astype(np.int16, copy=False)
    luma = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    chroma = rgb_i16.max(axis=2) - rgb_i16.min(axis=2)
    bg_pixel = np.asarray([[background_rgb]], dtype=np.uint8)
    background_luma = int(cv2.cvtColor(bg_pixel, cv2.COLOR_RGB2GRAY)[0, 0])
    neutral = (
        (luma >= _AUTO_WHITE_SHADOW_LUMA_MIN)
        & (luma <= max(
            _AUTO_WHITE_SHADOW_LUMA_MIN,
            background_luma - _AUTO_WHITE_SHADOW_BACKGROUND_GAP,
        ))
        & (chroma <= 18)
    )
    material = (luma <= _AUTO_WHITE_SHADOW_LUMA_MIN) | (chroma >= 30)

    shadow_ids: list[int] = []
    core_ids: list[int] = []
    for component in components:
        raw_id = int(component["raw_id"])
        pixels = labels == raw_id
        area = int(np.count_nonzero(pixels))
        if area <= 0:
            continue
        neutral_ratio = float(np.count_nonzero(neutral & pixels)) / float(area)
        material_ratio = float(np.count_nonzero(material & pixels)) / float(area)
        if (
            neutral_ratio >= _COMPOSITE_SHADOW_NEUTRAL_MIN
            and material_ratio <= _COMPOSITE_SHADOW_MATERIAL_MAX
        ):
            shadow_ids.append(raw_id)
        else:
            core_ids.append(raw_id)

    # Component được chọn làm vỏ phải thực sự là bóng; nếu là khung xám/viền
    # in thì không được phép chuyển sang phép nới offset.
    if shell_id not in shadow_ids or not core_ids:
        return None
    shadow_mask = np.isin(labels, shadow_ids)
    core_mask = np.isin(labels, core_ids)
    shadow_area = int(np.count_nonzero(shadow_mask))
    core_area = int(np.count_nonzero(core_mask))
    if shadow_area <= 0 or core_area < MIN_COMPONENT_AREA_PX:
        return None

    # Bóng đổ phải có hướng; khung xám đều quanh tem có resultant gần 0 và bị
    # từ chối. Đo theo trọng tâm artwork để không phụ thuộc hướng cụ thể của ảnh.
    core_y, core_x = np.nonzero(core_mask)
    shadow_y, shadow_x = np.nonzero(shadow_mask)
    if core_x.size == 0 or shadow_x.size == 0:
        return None
    center = np.asarray((float(core_x.mean()), float(core_y.mean())))
    vectors = np.column_stack((shadow_x, shadow_y)).astype(np.float64) - center
    radii = np.linalg.norm(vectors, axis=1)
    valid = radii > 1e-6
    if not np.any(valid):
        return None
    resultant = float(np.linalg.norm((vectors[valid] / radii[valid, None]).mean(axis=0)))
    shadow_center = np.asarray((float(shadow_x.mean()), float(shadow_y.mean())))
    direction = shadow_center - center
    direction_norm = float(np.linalg.norm(direction))
    if direction_norm <= 1e-6:
        return None
    direction_unit = direction / direction_norm
    positive_half = float(np.count_nonzero(vectors @ direction_unit > 0)) / float(len(vectors))
    core_radius = float(np.mean(
        np.linalg.norm(
            np.column_stack((core_x, core_y)).astype(np.float64) - center,
            axis=1,
        )
    ))
    shift_ratio = direction_norm / max(1e-6, core_radius)
    if (
        resultant < _COMPOSITE_SHADOW_DIRECTION_RESULTANT_MIN
        or positive_half < _COMPOSITE_SHADOW_DIRECTION_HALF_MIN
        or shift_ratio < _COMPOSITE_SHADOW_DIRECTION_SHIFT_MIN
    ):
        return None

    # Khoảng cách từ bóng tới lõi cho biết bề rộng offset trắng. Phân vị thấp
    # là mép trong của bóng; trừ một pixel để không ăn vào dải xám do raster.
    distance_to_core = cv2.distanceTransform(
        (~core_mask).astype(np.uint8),
        cv2.DIST_L2,
        5,
    )
    shadow_distances = distance_to_core[shadow_mask]
    if shadow_distances.size == 0:
        return None
    gap_p05, gap_p95 = np.percentile(shadow_distances, (5, 95))
    if gap_edge_limit_px is None:
        resolved_gap_edge_limit = (
            min(source_rgb.shape[:2]) * _COMPOSITE_SHADOW_GAP_MAX_EDGE_RATIO
        )
    else:
        try:
            resolved_gap_edge_limit = float(gap_edge_limit_px)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(resolved_gap_edge_limit) or resolved_gap_edge_limit <= 0:
            return None
    if (
        gap_p05 < _COMPOSITE_SHADOW_GAP_MIN_PX
        or gap_p95 / max(1e-6, gap_p05) > _COMPOSITE_SHADOW_GAP_SPREAD_MAX
        or gap_p95 > resolved_gap_edge_limit
    ):
        return None
    radius = max(1, int(math.floor(float(gap_p05))) - 1)
    candidate = (
        (distance_to_core <= float(radius))
        & ~shadow_mask
    ).astype(np.uint8) * 255
    candidate[core_mask] = 255
    if not np.any(candidate):
        return None
    candidate_count, _candidate_labels, _stats, _centroids = (
        cv2.connectedComponentsWithStats(candidate, connectivity=8)
    )
    if candidate_count != 2:
        return None

    def boundary_white_ratio(mask: np.ndarray) -> float:
        mask_u8 = (mask > 0).astype(np.uint8) * 255
        inner = cv2.erode(
            mask_u8,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
            iterations=1,
        )
        rim = (mask_u8 > 0) & (inner == 0)
        colors = rgb[rim]
        if colors.size == 0:
            return 0.0
        minimum = colors.min(axis=1)
        colors_chroma = colors.max(axis=1) - minimum
        return float(np.count_nonzero(
            (minimum >= max(225, background_luma - 2))
            & (colors_chroma <= 25)
        )) / float(len(colors))

    before_white = boundary_white_ratio(baseline)
    after_white = boundary_white_ratio(candidate)
    if (
        after_white < _COMPOSITE_SHADOW_BOUNDARY_MIN
        or after_white - before_white < _COMPOSITE_SHADOW_BOUNDARY_GAIN_MIN
    ):
        return None
    logger.info(
        "[STICKER_SHADOW] bỏ bóng lệch khỏi offset trắng: shadow=%d core=%d "
        "resultant=%.3f half=%.3f shift=%.3f gap=%.1f..%.1f radius=%d "
        "white=%.1f%%→%.1f%%",
        len(shadow_ids),
        len(core_ids),
        resultant,
        positive_half,
        shift_ratio,
        gap_p05,
        gap_p95,
        radius,
        before_white * 100.0,
        after_white * 100.0,
    )
    full_candidate = np.zeros(raw_labels.shape, dtype=np.uint8)
    full_candidate[top:bottom, left:right] = candidate
    return full_candidate


def _recover_single_composite_background(
    source_image: Image.Image,
    background: BackgroundInfo,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    dpi: tuple[float, float] | None = None,
) -> StickerSheetAnalysis | None:
    """Khép một tem có vỏ ngoài và nhiều mảng artwork bị tách bởi nền sáng.

    Đây là cổng chất lượng cho đúng dạng ảnh user đang gặp, không phải phép
    ``close`` áp dụng đại trà. Mặt nạ chỉ được nhận khi có đúng một component
    mỏng bao các mảnh lớn, ít nhất hai mảnh có bbox chồng nhau, màu sặc được giữ
    lại, và fitter đường bế xác nhận một quỹ đạo kín an toàn. Mọi ca không đủ
    bằng chứng đều trả ``None`` để luồng AI hiện hành tiếp quản.
    """
    if (
        not background.is_flat
        or not background.is_near_white
        or source_image.width <= 0
        or source_image.height <= 0
    ):
        return None

    raw_mask = np.asarray(background.foreground_mask, dtype=np.uint8)
    expected_shape = (source_image.height, source_image.width)
    if raw_mask.shape != expected_shape:
        return None
    raw_binary = np.where(raw_mask > 0, 255, 0).astype(np.uint8)
    if not np.any(raw_binary):
        return None

    page_area = max(1, int(raw_binary.size))
    minimum_area = max(
        MIN_COMPONENT_AREA_PX,
        int(math.ceil(page_area * _COMPOSITE_COMPONENT_AREA_RATIO)),
    )
    count, raw_labels, stats, _centroids = cv2.connectedComponentsWithStats(
        raw_binary,
        connectivity=8,
    )
    components: list[dict[str, int]] = []
    for raw_id in range(1, count):
        area = int(stats[raw_id, cv2.CC_STAT_AREA])
        if area < minimum_area:
            continue
        components.append({
            "raw_id": int(raw_id),
            "x": int(stats[raw_id, cv2.CC_STAT_LEFT]),
            "y": int(stats[raw_id, cv2.CC_STAT_TOP]),
            "width": int(stats[raw_id, cv2.CC_STAT_WIDTH]),
            "height": int(stats[raw_id, cv2.CC_STAT_HEIGHT]),
            "area": area,
        })
    if not (
        _COMPOSITE_MIN_COMPONENTS
        <= len(components)
        <= _COMPOSITE_MAX_COMPONENTS
    ):
        return None

    def contains(container: dict[str, int], child: dict[str, int]) -> bool:
        return bool(
            container["x"] <= child["x"]
            and container["y"] <= child["y"]
            and container["x"] + container["width"]
            >= child["x"] + child["width"]
            and container["y"] + container["height"]
            >= child["y"] + child["height"]
        )

    shell_candidates: list[
        tuple[dict[str, int], list[dict[str, int]], float]
    ] = []
    for candidate in components:
        if (
            candidate["width"] < source_image.width * _COMPOSITE_SHELL_MIN_PAGE_RATIO
            or candidate["height"] < source_image.height * _COMPOSITE_SHELL_MIN_PAGE_RATIO
        ):
            continue
        children = [
            item
            for item in components
            if item is not candidate and contains(candidate, item)
        ]
        if len(children) < 2:
            continue
        child_area = sum(int(item["area"]) for item in children)
        shell_ratio = float(candidate["area"]) / float(max(1, child_area))
        if not (
            _COMPOSITE_SHELL_AREA_RATIO_MIN
            <= shell_ratio
            <= _COMPOSITE_SHELL_AREA_RATIO_MAX
        ):
            continue
        shell_candidates.append((candidate, children, shell_ratio))
    if len(shell_candidates) != 1:
        return None

    _shell, children, shell_ratio = shell_candidates[0]
    overlapping_children = False
    for index, first in enumerate(children):
        for second in children[index + 1:]:
            intersection = _bbox_intersection_area(
                (
                    first["x"], first["y"], first["width"], first["height"]
                ),
                (
                    second["x"], second["y"], second["width"], second["height"]
                ),
            )
            smaller_bbox = min(
                first["width"] * first["height"],
                second["width"] * second["height"],
            )
            if intersection / float(max(1, smaller_bbox)) >= _COMPOSITE_CHILD_OVERLAP_RATIO:
                overlapping_children = True
                break
        if overlapping_children:
            break
    if not overlapping_children:
        return None

    candidate_binary = np.zeros_like(raw_binary)
    for component in components:
        candidate_binary[raw_labels == component["raw_id"]] = 255

    source_rgb = np.asarray(source_image.convert("RGB"), dtype=np.uint8)

    kernel_size = int(round(
        min(source_image.width, source_image.height)
        * _COMPOSITE_CLOSE_KERNEL_RATIO
    ))
    kernel_size = max(
        _COMPOSITE_CLOSE_KERNEL_MIN,
        min(_COMPOSITE_CLOSE_KERNEL_MAX, kernel_size),
    )
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (kernel_size, kernel_size),
    )
    closed = cv2.morphologyEx(
        candidate_binary,
        cv2.MORPH_CLOSE,
        kernel,
    )
    # QUALITY (audit 2026-08-20 §WHITE-OFFSET-SHADOW): component vỏ trung tính
    # có thể là drop shadow tách rời, không phải mép cắt. Chỉ thay mask khi
    # helper chứng minh được hướng bóng, khoảng offset và mép trắng; nếu không
    # thì giữ nguyên hành vi composite đã có.
    try:
        shadow_recovered = _recover_composite_white_offset_from_shadow(
            source_rgb,
            raw_labels,
            components,
            int(_shell["raw_id"]),
            background_rgb=background.color,
            baseline_mask=closed,
        )
    except (MemoryError, cv2.error, ValueError, TypeError) as exc:
        # Đây là nhánh phục hồi tùy chọn; không để thiếu một buffer/ảnh lỗi làm
        # hỏng toàn bộ preview. AI/nhánh composite cũ sẽ tiếp quản bên dưới.
        logger.info(
            "[STICKER_SHADOW] bỏ phục hồi vì lỗi tài nguyên: %s",
            type(exc).__name__,
        )
        shadow_recovered = None
    if shadow_recovered is not None:
        candidate_binary = shadow_recovered
        closed = shadow_recovered
    closed_area = int(np.count_nonzero(closed))
    source_area = int(np.count_nonzero(candidate_binary))
    if (
        closed_area <= 0
        or closed_area / float(max(1, source_area)) > 1.25
    ):
        return None
    closed_count, _closed_labels, _closed_stats, _closed_centroids = (
        cv2.connectedComponentsWithStats(closed, connectivity=8)
    )
    if closed_count != 2:
        # Một silhouette duy nhất là điều kiện bắt buộc; nếu còn nhiều vùng,
        # đây rất có thể là tờ nhiều tem hoặc artwork rời.
        return None

    hsv = cv2.cvtColor(source_rgb, cv2.COLOR_RGB2HSV)
    colorful = (hsv[:, :, 1] >= 45) & (hsv[:, :, 2] >= 45)
    colorful_source = colorful & (candidate_binary > 0)
    colorful_count = int(np.count_nonzero(colorful_source))
    colorful_kept = 0
    if colorful_count >= 100:
        colorful_kept = int(np.count_nonzero(colorful_source & (closed > 0)))
        if colorful_kept / float(colorful_count) < _COMPOSITE_COLOR_COVERAGE_MIN:
            return None

    # Giữ dải chuyển tiếp cho marching-squares; alpha nhị phân thuần làm đường
    # bế bậc thang và quay lại đúng hồi quy 905 đoạn trước đây.
    transition_sigma = max(0.5, kernel_size / 8.0)
    candidate_alpha = cv2.GaussianBlur(
        closed,
        (0, 0),
        sigmaX=transition_sigma,
        sigmaY=transition_sigma,
    )
    try:
        analysis = _analysis_from_alpha(
            source_image,
            candidate_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )
    except Exception as exc:
        logger.info(
            "[STICKER_COMPOSITE] bỏ ứng viên vì không dựng được mask: %s",
            type(exc).__name__,
        )
        return None
    if len(analysis.instances) != 1:
        return None

    # QUALITY (audit 2026-08-20 §STICKER-COMPOSITE.2): dùng chính oracle của
    # CutContour để loại mask khép được bằng ảnh nhưng sinh quỹ đạo rác.
    try:
        from app.workers.sticker_engine import build_alpha_cutline_geometry

        dpi_x = float(dpi[0]) if dpi is not None else 300.0
        dpi_y = float(dpi[1]) if dpi is not None else dpi_x
        if (
            not math.isfinite(dpi_x)
            or not math.isfinite(dpi_y)
            or dpi_x <= 0.0
            or dpi_y <= 0.0
        ):
            dpi_x = dpi_y = 300.0
        geometry = build_alpha_cutline_geometry(
            analysis.alpha,
            dpi=dpi_x,
            dpi_y=dpi_y,
            cut_mode="original",
            offset_mm=0.0,
            bleed_mm=2.0,
            corner_style="round",
            fill_holes=True,
            cutline_smoothness=50.0,
            cutline_fidelity=50.0,
            curve_tension=50.0,
            min_detail_area_mm2=1.0,
            presmooth_alpha=False,
        )
    except Exception as exc:
        # Cổng này chỉ là nhánh phục hồi tùy chọn; lỗi fitter/GEOS/OOM phải
        # nhường lại cho AI hiện hành, không được làm route detect 500.
        logger.info(
            "[STICKER_COMPOSITE] bỏ ứng viên vì fitter không chấp nhận: %s",
            type(exc).__name__,
        )
        return None
    if not geometry:
        return None
    path_groups = geometry.get("path_groups")
    quality = geometry.get("quality")
    if not isinstance(path_groups, list) or len(path_groups) != 1:
        return None
    if not isinstance(quality, dict) or not bool(quality.get("machine_safe")):
        return None
    segment_count = sum(
        len(group.get("exterior", ()))
        + sum(len(interior) for interior in group.get("interiors", ()))
        for group in path_groups
        if isinstance(group, dict)
    )
    if segment_count <= 0 or segment_count > _COMPOSITE_MAX_SEGMENTS:
        return None

    analysis.warnings.append("simple-bg-composite-recovered")
    if shadow_recovered is not None:
        analysis.warnings.append("simple-bg-drop-shadow-removed")
    logger.info(
        "[STICKER_COMPOSITE] khôi phục một silhouette từ vỏ ngoài: "
        "components=%d shell_ratio=%.3f kernel=%d segments=%d colorful=%.1f%%",
        len(components),
        shell_ratio,
        kernel_size,
        segment_count,
        100.0
        if colorful_count <= 0
        else colorful_kept / float(colorful_count) * 100.0,
    )
    return analysis


def _recover_multi_composite_shadow_sheet(
    source_image: Image.Image,
    background: BackgroundInfo,
    fragmented_analysis: StickerSheetAnalysis,
    *,
    model: StickerSheetModel,
    alpha_threshold: int,
    dpi: tuple[float, float] | None = None,
) -> StickerSheetAnalysis | None:
    """Khôi phục nhiều tem có offset trắng và bóng đổ lệch hướng.

    ``_recover_single_composite_background`` chỉ nhận một vỏ lớn trên toàn
    trang. Với chế độ *Tách nhiều tem*, mỗi tem có một vỏ riêng nên phải chạy
    cùng cổng chất lượng theo từng container rồi ghép lại. Chỉ cần một tem
    không qua đủ guard là trả ``None`` để giữ nhánh nhận diện cũ/AI; không ghép
    một phần kết quả vì điều đó làm số tem và thứ tự trên tờ bị sai.
    """
    if (
        not background.is_flat
        or not background.is_near_white
        or source_image.width <= 0
        or source_image.height <= 0
    ):
        return None
    containers = _fragment_container_instances(fragmented_analysis)
    if len(containers) < 2:
        return None

    labels = np.asarray(fragmented_analysis.labels)
    expected_shape = (source_image.height, source_image.width)
    if labels.shape != expected_shape or labels.ndim != 2:
        return None
    # Chỉ đọc RGB; giữ view PIL để không nhân đôi bitmap lớn trong mỗi mode.
    source_rgb = np.asarray(source_image.convert("RGB"), dtype=np.uint8)

    def _record(instance: StickerInstance) -> dict[str, int]:
        return {
            "raw_id": int(instance.id),
            "x": int(instance.x),
            "y": int(instance.y),
            "width": int(instance.width),
            "height": int(instance.height),
            "area": int(instance.area_px),
        }

    def _contains(
        container: StickerInstance,
        child: StickerInstance,
    ) -> bool:
        return bool(
            container.x <= child.x
            and container.y <= child.y
            and container.x + container.width >= child.x + child.width
            and container.y + container.height >= child.y + child.height
        )

    # Dùng cùng kích thước kernel với nhánh một tem. Helper nhận toàn bộ tờ nên
    # guard khoảng cách bóng vẫn dựa trên cạnh ngắn của nguồn, không bị crop
    # nhỏ của từng tem làm từ chối một bóng hợp lệ.
    kernel_size = int(round(
        min(source_image.width, source_image.height)
        * _COMPOSITE_CLOSE_KERNEL_RATIO
    ))
    kernel_size = max(
        _COMPOSITE_CLOSE_KERNEL_MIN,
        min(_COMPOSITE_CLOSE_KERNEL_MAX, kernel_size),
    )
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (kernel_size, kernel_size),
    )

    recovered_mask = np.zeros(labels.shape, dtype=np.uint8)
    # Helper tự cắt ROI khi đo màu/khoảng cách. Baseline dùng một buffer toàn tờ
    # duy nhất nhưng phép close chỉ chạy trên ROI của từng container, tránh nở
    # một kernel morphology toàn khung lặp lại cho sáu/giấy nhiều tem.
    baseline_full = np.zeros(labels.shape, dtype=np.uint8)
    used_ids: set[int] = set()
    recovered_count = 0
    for container in containers:
        children = [
            item
            for item in fragmented_analysis.instances
            if item.id == container.id or _contains(container, item)
        ]
        # Vỏ + ít nhất hai mảng artwork là bằng chứng tối thiểu của composite;
        # ảnh nhiều tem thông thường sẽ rơi qua guard này và không bị đổi mask.
        if len(children) < _COMPOSITE_MIN_COMPONENTS:
            return None
        records = [_record(item) for item in children]
        ids = {int(item["raw_id"]) for item in records}
        if len(ids) != len(records) or used_ids.intersection(ids):
            return None
        used_ids.update(ids)
        artwork_children = [item for item in children if item.id != container.id]
        overlapping_children = False
        for index, first in enumerate(artwork_children):
            for second in artwork_children[index + 1:]:
                intersection = _bbox_intersection_area(first.bbox, second.bbox)
                smaller_bbox = min(
                    first.width * first.height,
                    second.width * second.height,
                )
                if intersection / float(max(1, smaller_bbox)) >= (
                    _COMPOSITE_CHILD_OVERLAP_RATIO
                ):
                    overlapping_children = True
                    break
            if overlapping_children:
                break
        if not overlapping_children:
            return None

        region_left = min(int(item["x"]) for item in records)
        region_top = min(int(item["y"]) for item in records)
        region_right = min(
            labels.shape[1],
            max(int(item["x"]) + int(item["width"]) for item in records),
        )
        region_bottom = min(
            labels.shape[0],
            max(int(item["y"]) + int(item["height"]) for item in records),
        )
        if (
            region_right <= region_left
            or region_bottom <= region_top
        ):
            return None
        selected_binary_roi = np.where(
            np.isin(labels[region_top:region_bottom, region_left:region_right], list(ids)),
            255,
            0,
        ).astype(np.uint8)
        baseline_roi = cv2.morphologyEx(
            selected_binary_roi,
            cv2.MORPH_CLOSE,
            kernel,
        )
        baseline_full[region_top:region_bottom, region_left:region_right] = baseline_roi
        try:
            candidate = _recover_composite_white_offset_from_shadow(
                source_rgb,
                labels,
                records,
                int(container.id),
                background_rgb=background.color,
                baseline_mask=baseline_full,
                gap_edge_limit_px=min(
                    min(source_rgb.shape[:2])
                    * _COMPOSITE_SHADOW_GAP_MAX_EDGE_RATIO,
                    min(container.width, container.height)
                    * _COMPOSITE_MULTI_SHADOW_GAP_MAX_EDGE_RATIO,
                ),
            )
        except (MemoryError, cv2.error, ValueError, TypeError) as exc:
            logger.info(
                "[STICKER_SHADOW] bỏ phục hồi tem nhiều vì lỗi tài nguyên: %s",
                type(exc).__name__,
            )
            return None
        if candidate is None:
            return None

        # Mép offset hợp lệ phải nằm trong vỏ đã nhận diện; nếu candidate vượt
        # ra ngoài thì đây là component lẫn giữa hai tem hoặc guard bị đánh lừa.
        left = max(0, int(container.x))
        top = max(0, int(container.y))
        right = min(candidate.shape[1], left + int(container.width))
        bottom = min(candidate.shape[0], top + int(container.height))
        if right <= left or bottom <= top:
            return None
        if (
            np.any(candidate[:top] > 0)
            or np.any(candidate[bottom:] > 0)
            or np.any(candidate[top:bottom, :left] > 0)
            or np.any(candidate[top:bottom, right:] > 0)
        ):
            return None
        candidate_roi = candidate[top:bottom, left:right]
        recovered_roi = recovered_mask[top:bottom, left:right]
        if np.any((recovered_roi > 0) & (candidate_roi > 0)):
            return None
        recovered_mask[top:bottom, left:right] = np.maximum(
            recovered_roi,
            candidate_roi,
        )
        recovered_count += 1

    if recovered_count != len(containers) or not np.any(recovered_mask):
        return None

    # Giữ dải chuyển tiếp cho marching-squares giống nhánh một tem; mỗi
    # candidate đã qua fitter riêng nên blur này chỉ nối lại alpha ở cấp tờ.
    transition_sigma = max(0.5, kernel_size / 8.0)
    candidate_alpha = cv2.GaussianBlur(
        recovered_mask,
        (0, 0),
        sigmaX=transition_sigma,
        sigmaY=transition_sigma,
    )
    try:
        recovered = _analysis_from_alpha(
            source_image,
            candidate_alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )
    except (StickerSourcePipelineError, MemoryError, cv2.error, ValueError):
        return None
    if (
        len(recovered.instances) != len(containers)
        or _looks_like_fragmented_sticker_sheet(recovered)
    ):
        return None
    recovered.warnings.append("simple-bg-composite-recovered")
    recovered.warnings.append("simple-bg-drop-shadow-removed")
    logger.info(
        "[STICKER_COMPOSITE] khôi phục %d tem từ offset trắng, đã bỏ bóng lệch "
        "kernel=%d",
        recovered_count,
        kernel_size,
    )
    return recovered


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
    preview_only: bool = False,
    object_ids: list[str] | None = None,
) -> StickerSourceDetection:
    """Nhận diện một trang/ảnh từ session inspected, không ghi session.

    ``preview_only`` giữ fast path ``simple-bg`` khi contour đã sạch. Nếu cổng
    hình học phát hiện răng cưa/halo thì preview vẫn nâng đúng một lần sang Alpha
    AI; artifact đã promote sau đó được cả preview và bước xuất tái sử dụng.
    Nhánh mặc định vẫn nâng mọi ca ``simple-bg`` một-tem như trước.
    """
    # UIUX (audit 2026-08-09 §MP.2): stage thuộc trang nguồn. Dùng stage toàn
    # session khiến trang đầu vừa promote đã chặn mọi trang còn lại trong tài liệu.
    page_state = session.pages.get(page_number)
    stage = page_state.stage if page_state is not None else session.stage
    if stage not in ("inspected", "detecting"):
        raise StickerSourcePipelineError("Nguồn tem không còn ở trạng thái chờ nhận diện.")
    if strategy not in (
        "auto", "existing-cut", "vector", "alpha", "simple-bg", "page-box", "ai"
    ):
        raise StickerSourcePipelineError("Chiến lược nhận diện không được hỗ trợ.")
    if not 1 <= page_number <= session.page_count:
        raise StickerSourcePipelineError("Trang cần nhận diện không tồn tại trong file nguồn.")
    if object_ids is not None:
        if session.source_kind != "pdf":
            raise StickerSourcePipelineError("Chọn đối tượng chỉ áp dụng cho tài liệu PDF.")
        if not isinstance(object_ids, list) or not object_ids or any(
            not isinstance(object_id, str)
            or re.fullmatch(r"(?:text|image|vector)-(?:0|[1-9][0-9]*)", object_id) is None
            for object_id in object_ids
        ):
            raise StickerSourcePipelineError("Hãy chọn ít nhất một đối tượng PDF hợp lệ.")
        object_ids = list(dict.fromkeys(object_ids))

    page_index = page_number - 1
    if session.source_kind == "raster":
        source_image = _load_raster_source(session)
        dpi = session.dpi
        if strategy == "page-box":
            # QUALITY (feedback 2026-08-19 §CUTPREVIEW.PAGEBOX1): giữ nền trắng
            # tắt thì không được rơi qua nhánh Alpha/nền phẳng/AI.
            return _page_box_detection(
                source_image,
                model=model,
                alpha_threshold=alpha_threshold,
                dpi=dpi,
                source_page=1,
            )
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
                resolved = replace(detected, dpi=dpi, source_page=1)
                rough_preview = bool(
                    strategy == "auto"
                    and preview_only
                    and _simple_bg_preview_needs_geometry_upgrade(
                        resolved.analysis,
                    )
                )
                if strategy == "auto" and (not preview_only or rough_preview):
                    resolved = _upgrade_single_simple_background_geometry(
                        resolved,
                        source_image,
                        model=model,
                        alpha_threshold=alpha_threshold,
                    )
                if rough_preview and resolved.boundary_source == "simple-bg":
                    # AI thiếu RAM/không đủ parity: vẫn cho preview xác định,
                    # nhưng buộc worker dùng profile khử răng cưa an toàn.
                    resolved = replace(
                        resolved,
                        needs_review=True,
                        warnings=tuple(dict.fromkeys((
                            *resolved.warnings,
                            _SIMPLE_BG_PREVIEW_DENOISE_FALLBACK_WARNING,
                        ))),
                    )
                return resolved
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
        if strategy == "auto" and preview_only:
            page_box = _full_page_artwork_page_box_detection(
                source_image,
                analysis,
                source_fills_page=True,
                model=model,
                alpha_threshold=alpha_threshold,
                dpi=dpi,
                source_page=1,
            )
            if page_box is not None:
                return page_box
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
    if object_ids is not None:
        # UIUX (audit 2026-09-06 §CUSTOM.2): người dùng xác định vùng tem;
        # Alpha PDF giữ nguyên mép/viền trắng, không qua dò nền hoặc AI lần nữa.
        source_image, dpi = _render_pdf_page(
            str(session.source_path),
            page_index,
            (float(width_mm), float(height_mm)),
            object_ids=object_ids,
        )
        analysis = _analysis_from_alpha(
            source_image,
            np.asarray(source_image.getchannel("A"), dtype=np.uint8),
            model=model,
            alpha_threshold=alpha_threshold,
        )
        return StickerSourceDetection(
            analysis=analysis,
            source_image=source_image,
            boundary_source="manual",
            strategy_confidence=1.0,
            needs_review=False,
            dpi=dpi,
            source_page=page_number,
            vector_geometry_ref={
                "kind": "pdf-object-selection",
                "source_page": page_number,
                "object_ids": object_ids,
                "preserve_original": True,
            },
            warnings=(),
        )
    source_image, dpi = _render_pdf_page(
        str(session.source_path),
        page_index,
        (float(width_mm), float(height_mm)),
    )
    if strategy == "page-box":
        # QUALITY (feedback 2026-08-19 §CUTPREVIEW.PAGEBOX1): render chỉ để có
        # đúng kích thước hiển thị; hình học là full-page mask, không đọc
        # CutContour/vector/nền và không nạp detector AI.
        return _page_box_detection(
            source_image,
            model=model,
            alpha_threshold=alpha_threshold,
            dpi=dpi,
            source_page=page_number,
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
            resolved = replace(
                detected,
                dpi=dpi,
                source_page=page_number,
            )
            rough_preview = bool(
                strategy == "auto"
                and preview_only
                and _simple_bg_preview_needs_geometry_upgrade(
                    resolved.analysis,
                )
            )
            if strategy == "auto" and (not preview_only or rough_preview):
                resolved = _upgrade_single_simple_background_geometry(
                    resolved,
                    source_image,
                    model=model,
                    alpha_threshold=alpha_threshold,
                )
            if rough_preview and resolved.boundary_source == "simple-bg":
                resolved = replace(
                    resolved,
                    needs_review=True,
                    warnings=tuple(dict.fromkeys((
                        *resolved.warnings,
                        _SIMPLE_BG_PREVIEW_DENOISE_FALLBACK_WARNING,
                    ))),
                )
            return resolved
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
    if strategy == "auto" and preview_only:
        page_box = _full_page_artwork_page_box_detection(
            source_image,
            analysis,
            source_fills_page=(
                _full_page_raster_scale_limit(str(session.source_path), page_index)
                is not None
            ),
            model=model,
            alpha_threshold=alpha_threshold,
            dpi=dpi,
            source_page=page_number,
        )
        if page_box is not None:
            return page_box
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
