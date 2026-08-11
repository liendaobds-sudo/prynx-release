"""Kiểm tra nhẹ nguồn tem trước khi chạy nhận diện hoặc tạo CutContour.

Module này chỉ đọc cấu trúc PDF/metadata ảnh và tạo preview. Nó không nạp model AI,
không tạo mask và không thay đổi hình học nguồn.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from io import BytesIO
import math
from pathlib import Path
from typing import Literal
import warnings as py_warnings

import numpy as np
import pikepdf
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from app.core.pdfium_lock import pdfium_guard
from app.core.sticker_background import has_meaningful_alpha


StickerSourceKind = Literal["pdf", "raster"]
StickerBoundarySource = Literal[
    "existing-cut",
    "vector",
    "alpha",
    "simple-bg",
    "ai",
    "manual",
]

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
_SOURCE_EXTENSIONS = _IMAGE_EXTENSIONS | {".pdf"}
_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}
_FORMAT_EXTENSIONS = {
    "PNG": {".png"},
    "JPEG": {".jpg", ".jpeg"},
    "WEBP": {".webp"},
    "BMP": {".bmp"},
    "TIFF": {".tif", ".tiff"},
}
_PREVIEW_MAX_EDGE_PX = 2000


class StickerSourceInspectionError(ValueError):
    """Nguồn không thể kiểm tra an toàn hoặc không đúng định dạng."""


@dataclass(frozen=True)
class StickerSourcePageInspection:
    page_number: int
    width_mm: float | None
    height_mm: float | None
    has_existing_cut: bool
    has_vector: bool
    has_raster: bool
    has_alpha: bool
    cut_contour_count: int

    def to_manifest(self) -> dict[str, object]:
        return {
            "page_number": self.page_number,
            "width_mm": round(self.width_mm, 4) if self.width_mm is not None else None,
            "height_mm": round(self.height_mm, 4) if self.height_mm is not None else None,
            "has_existing_cut": self.has_existing_cut,
            "has_vector": self.has_vector,
            "has_raster": self.has_raster,
            "has_alpha": self.has_alpha,
            "cut_contour_count": self.cut_contour_count,
        }


@dataclass(frozen=True)
class StickerSourceInspection:
    source_kind: StickerSourceKind
    mime_type: str
    boundary_source: StickerBoundarySource
    strategy_confidence: float
    needs_review: bool
    page_count: int
    source_width_px: int | None
    source_height_px: int | None
    dpi: tuple[float, float] | None
    physical_width_mm: float | None
    physical_height_mm: float | None
    has_existing_cut: bool
    has_vector: bool
    has_raster: bool
    has_alpha: bool
    cut_contour_count: int
    pages: tuple[StickerSourcePageInspection, ...]
    warnings: tuple[str, ...]
    preview: Image.Image

    def to_manifest(self) -> dict[str, object]:
        return {
            "source_kind": self.source_kind,
            "mime_type": self.mime_type,
            "boundary_source": self.boundary_source,
            "strategy_confidence": round(self.strategy_confidence, 4),
            "needs_review": self.needs_review,
            "page_count": self.page_count,
            "source_width_px": self.source_width_px,
            "source_height_px": self.source_height_px,
            "dpi": list(self.dpi) if self.dpi else None,
            "physical_width_mm": (
                round(self.physical_width_mm, 4)
                if self.physical_width_mm is not None
                else None
            ),
            "physical_height_mm": (
                round(self.physical_height_mm, 4)
                if self.physical_height_mm is not None
                else None
            ),
            "preview_width_px": self.preview.width,
            "preview_height_px": self.preview.height,
            "has_existing_cut": self.has_existing_cut,
            "has_vector": self.has_vector,
            "has_raster": self.has_raster,
            "has_alpha": self.has_alpha,
            "cut_contour_count": self.cut_contour_count,
            "pages": [page.to_manifest() for page in self.pages],
            "warnings": list(self.warnings),
        }


def _has_inline_raster(owner: object) -> bool:
    has_inline_raster = False
    try:
        for instruction in pikepdf.parse_content_stream(owner):
            operator = str(instruction.operator)
            if operator in {"BI", "ID", "EI", "INLINE IMAGE"}:
                has_inline_raster = True
                break
    except (TypeError, ValueError, pikepdf.PdfError):
        pass
    return has_inline_raster


def _page_size_mm(page: pikepdf.Page) -> tuple[float, float]:
    box = page.get("/CropBox", page.get("/MediaBox"))
    if not isinstance(box, pikepdf.Array) or len(box) < 4:
        raise StickerSourceInspectionError("Trang PDF không có khổ trang hợp lệ.")
    user_unit = float(page.get("/UserUnit", 1.0) or 1.0)
    width_pt = abs(float(box[2]) - float(box[0])) * user_unit
    height_pt = abs(float(box[3]) - float(box[1])) * user_unit
    rotation = int(page.get("/Rotate", 0) or 0) % 360
    if rotation in (90, 270):
        width_pt, height_pt = height_pt, width_pt
    if width_pt <= 0 or height_pt <= 0:
        raise StickerSourceInspectionError("Trang PDF có kích thước bằng 0.")
    return width_pt * 25.4 / 72.0, height_pt * 25.4 / 72.0


def _inspect_pdf_page(
    page: pikepdf.Page,
    document: pikepdf.Pdf,
    page_number: int,
) -> StickerSourcePageInspection:
    from app.core.preflight_rules.resource_walker import iter_images
    from app.workers.pdf_content_parser import extract_vector_paths

    width_mm, height_mm = _page_size_mm(page)
    vector_paths = extract_vector_paths(page, document)
    images = list(iter_images(page, document))
    image_names = [name for name, _image in images]
    has_raster = any(not name.endswith(".SMask") for name in image_names)
    has_alpha = any(name.endswith(".SMask") for name in image_names)
    inline_raster = _has_inline_raster(page)
    return StickerSourcePageInspection(
        page_number=page_number,
        width_mm=width_mm,
        height_mm=height_mm,
        has_existing_cut=False,
        has_vector=bool(vector_paths),
        has_raster=has_raster or inline_raster,
        has_alpha=has_alpha,
        cut_contour_count=0,
    )


def _render_pdf_preview(source_path: str) -> Image.Image:
    import pypdfium2 as pdfium

    # KIENTRUC (audit 2026-08-08 §UNIFIED.8): khóa chỉ bao lời gọi PDFium và
    # copy pixel; encode PNG được thực hiện sau khi đã rời khóa.
    with pdfium_guard("sticker_source_inspector_preview"):
        document = pdfium.PdfDocument(source_path)
        try:
            if len(document) < 1:
                raise StickerSourceInspectionError("PDF không có trang nào.")
            page = document[0]
            try:
                width_pt, height_pt = page.get_size()
                longest_pt = max(float(width_pt), float(height_pt), 1.0)
                scale = min(150.0 / 72.0, _PREVIEW_MAX_EDGE_PX / longest_pt)
                bitmap = page.render(scale=scale, rev_byteorder=True)
                try:
                    preview = bitmap.to_pil().convert("RGBA").copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            document.close()
    return preview


def _read_dpi(image: Image.Image) -> tuple[float, float] | None:
    raw = image.info.get("dpi")
    if not isinstance(raw, (tuple, list)) or len(raw) < 2:
        return None
    try:
        x = float(raw[0])
        y = float(raw[1])
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or not math.isfinite(y) or x <= 0 or y <= 0:
        return None
    return x, y


def _convert_raster_preview(image: Image.Image) -> tuple[Image.Image, bool, float, list[str]]:
    warnings: list[str] = []
    work = ImageOps.exif_transpose(image)
    alpha = (
        work.convert("RGBA").getchannel("A")
        if "A" in work.getbands() or "transparency" in image.info or "transparency" in work.info
        else None
    )
    source_icc = image.info.get("icc_profile")
    if source_icc:
        try:
            source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc))
            target_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
            rgb = ImageCms.profileToProfile(
                work.convert("RGB"),
                source_profile,
                target_profile,
                outputMode="RGB",
            )
            work = rgb.convert("RGBA")
            if alpha is not None:
                work.putalpha(alpha)
            warnings.append("color-converted-to-srgb")
        except Exception:
            work = work.convert("RGBA")
            warnings.append("icc-profile-discarded")
    else:
        work = work.convert("RGBA")

    has_alpha = False
    soft_alpha_ratio = 0.0
    if alpha is not None:
        probe = alpha.copy()
        probe.thumbnail((1024, 1024), Image.Resampling.NEAREST)
        values = np.asarray(probe, dtype=np.uint8)
        has_alpha = has_meaningful_alpha(values)
        if values.size:
            soft_alpha_ratio = float(np.count_nonzero((values > 5) & (values < 250))) / values.size

    work.thumbnail((_PREVIEW_MAX_EDGE_PX, _PREVIEW_MAX_EDGE_PX), Image.Resampling.LANCZOS)
    return work, has_alpha, soft_alpha_ratio, warnings


def _simple_background_confidence(preview: Image.Image) -> float:
    probe = preview.convert("RGB").copy()
    probe.thumbnail((512, 512), Image.Resampling.BILINEAR)
    values = np.asarray(probe, dtype=np.float32)
    if values.ndim != 3 or min(values.shape[:2]) < 2:
        return 0.0
    border = np.concatenate(
        (values[0], values[-1], values[1:-1, 0], values[1:-1, -1]),
        axis=0,
    )
    median = np.median(border, axis=0)
    distance = np.linalg.norm(border - median, axis=1)
    spread = float(np.percentile(distance, 95)) if distance.size else math.inf
    if spread <= 10.0:
        return 0.82
    if spread <= 24.0:
        return 0.68
    return 0.0


def _inspect_raster(source_path: str) -> StickerSourceInspection:
    try:
        with py_warnings.catch_warnings():
            py_warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source_path) as opened:
                source_format = str(opened.format or "").upper()
                extension = Path(source_path).suffix.lower()
                if extension not in _FORMAT_EXTENSIONS.get(source_format, set()):
                    raise StickerSourceInspectionError(
                        "Nội dung ảnh không khớp với phần mở rộng của file."
                    )
                if int(getattr(opened, "n_frames", 1) or 1) > 1:
                    raise StickerSourceInspectionError(
                        "Ảnh nhiều khung/trang chưa được hỗ trợ. Hãy tách từng trang rồi thử lại."
                    )
                dpi = _read_dpi(opened)
                orientation = int(opened.getexif().get(274, 1) or 1)
                opened.load()
                source_width, source_height = ImageOps.exif_transpose(opened).size
                preview, has_alpha, soft_alpha_ratio, warnings = _convert_raster_preview(opened)
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise StickerSourceInspectionError(
            "Ảnh quá lớn để tạo preview an toàn. Hãy giảm kích thước ảnh rồi thử lại."
        ) from exc

    if dpi and orientation in (5, 6, 7, 8):
        dpi = dpi[1], dpi[0]

    if has_alpha:
        boundary_source: StickerBoundarySource = "alpha"
        confidence = 0.98 if soft_alpha_ratio <= 0.02 else 0.86
        needs_review = soft_alpha_ratio > 0.02
    else:
        simple_confidence = _simple_background_confidence(preview)
        if simple_confidence > 0:
            boundary_source = "simple-bg"
            confidence = simple_confidence
        else:
            boundary_source = "ai"
            confidence = 0.4
        needs_review = True

    physical_width_mm = source_width / dpi[0] * 25.4 if dpi else None
    physical_height_mm = source_height / dpi[1] * 25.4 if dpi else None
    if dpi and abs(dpi[0] - dpi[1]) / max(dpi) > 0.01:
        warnings.append("non-square-dpi")
    if dpi is None:
        warnings.append("missing-dpi")
    page = StickerSourcePageInspection(
        page_number=1,
        width_mm=physical_width_mm,
        height_mm=physical_height_mm,
        has_existing_cut=False,
        has_vector=False,
        has_raster=True,
        has_alpha=has_alpha,
        cut_contour_count=0,
    )
    return StickerSourceInspection(
        source_kind="raster",
        mime_type=_MIME_TYPES.get(Path(source_path).suffix.lower(), "application/octet-stream"),
        boundary_source=boundary_source,
        strategy_confidence=confidence,
        needs_review=needs_review,
        page_count=1,
        source_width_px=source_width,
        source_height_px=source_height,
        dpi=dpi,
        physical_width_mm=physical_width_mm,
        physical_height_mm=physical_height_mm,
        has_existing_cut=False,
        has_vector=False,
        has_raster=True,
        has_alpha=has_alpha,
        cut_contour_count=0,
        pages=(page,),
        warnings=tuple(warnings),
        preview=preview,
    )


def _inspect_pdf(source_path: str) -> StickerSourceInspection:
    try:
        with pikepdf.Pdf.open(source_path, attempt_recovery=False) as document:
            if len(document.pages) < 1:
                raise StickerSourceInspectionError("PDF không có trang nào.")
            structural_pages = tuple(
                _inspect_pdf_page(page, document, index + 1)
                for index, page in enumerate(document.pages)
            )
    except pikepdf.PasswordError as exc:
        raise StickerSourceInspectionError(
            "PDF đang được bảo vệ bằng mật khẩu. Hãy mở khóa rồi thử lại."
        ) from exc
    except pikepdf.PdfError as exc:
        raise StickerSourceInspectionError("Không đọc được cấu trúc PDF nguồn.") from exc

    warnings: list[str] = []
    pages_list: list[StickerSourcePageInspection] = []
    from app.workers.cut_export.cut_layer_extractor import extract_cut_contours

    for index, page in enumerate(structural_pages):
        try:
            cut_count = len(extract_cut_contours(source_path, index).contours)
        except Exception:
            cut_count = 0
            warnings.append(f"cut-scan-failed-page-{index + 1}")
        pages_list.append(replace(
            page,
            has_existing_cut=cut_count > 0,
            cut_contour_count=cut_count,
        ))
    pages = tuple(pages_list)

    preview = _render_pdf_preview(source_path)
    pages_with_cut = sum(1 for page in pages if page.has_existing_cut)
    has_existing_cut = pages_with_cut > 0
    all_pages_have_cut = pages_with_cut == len(pages)
    cut_contour_count = sum(page.cut_contour_count for page in pages)
    has_vector = any(page.has_vector for page in pages)
    has_raster = any(page.has_raster for page in pages)
    has_alpha = any(page.has_alpha for page in pages)
    if all_pages_have_cut:
        boundary_source: StickerBoundarySource = "existing-cut"
        confidence = 0.96
        needs_review = False
    elif has_existing_cut:
        boundary_source = "manual"
        confidence = 0.5
        needs_review = True
        warnings.append("mixed-boundary-sources")
    elif has_vector:
        boundary_source = "vector"
        confidence = 0.72
        needs_review = True
    elif has_raster:
        boundary_source = "ai"
        confidence = 0.4
        needs_review = True
    else:
        boundary_source = "manual"
        confidence = 0.0
        needs_review = True

    if len(pages) > 1:
        warnings.append("multi-page-source")
    return StickerSourceInspection(
        source_kind="pdf",
        mime_type="application/pdf",
        boundary_source=boundary_source,
        strategy_confidence=confidence,
        needs_review=needs_review,
        page_count=len(pages),
        source_width_px=None,
        source_height_px=None,
        dpi=None,
        physical_width_mm=pages[0].width_mm,
        physical_height_mm=pages[0].height_mm,
        has_existing_cut=has_existing_cut,
        has_vector=has_vector,
        has_raster=has_raster,
        has_alpha=has_alpha,
        cut_contour_count=cut_contour_count,
        pages=pages,
        warnings=tuple(warnings),
        preview=preview,
    )


def inspect_sticker_source(source_path: str, original_name: str) -> StickerSourceInspection:
    """Inspect PDF/ảnh đồng bộ; caller phải đưa hàm này ra khỏi event loop."""
    extension = Path(original_name or source_path).suffix.lower()
    if extension not in _SOURCE_EXTENSIONS:
        raise StickerSourceInspectionError(
            "Chỉ nhận PDF, PNG, JPG, WebP, BMP hoặc TIFF."
        )
    try:
        if extension == ".pdf":
            return _inspect_pdf(source_path)
        return _inspect_raster(source_path)
    except StickerSourceInspectionError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise StickerSourceInspectionError(
            "Không đọc được file nguồn. Hãy xuất lại file rồi thử lại."
        ) from exc
