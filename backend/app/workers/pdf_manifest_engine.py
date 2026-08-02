"""Manifest-based PDF assembly for large Combine jobs.

The manifest keeps page selection and rotation decisions out of the browser's
PDF object graph. Source PDFs are opened once and pages are appended directly
to the output document, so the request only carries files plus a small plan.
"""

from collections import Counter
from contextlib import ExitStack
from dataclasses import dataclass
import json
import logging
import math
import os
import shutil
import tempfile
import warnings
from typing import Any, Callable, Dict, List, Optional

import pikepdf
from PIL import Image, UnidentifiedImageError

from app.core.heavy_job_scheduler import max_active_heavy_jobs
from app.core.system_memory import plan_worker_count, read_memory_status_mb
from app.workers.pdf_tools_engine import save_pdf_compat


logger = logging.getLogger(__name__)

MAX_MANIFEST_ITEMS = 20_000
MAX_MANIFEST_FILES = 256
DEFAULT_BLANK_PAGE_SIZE = (595.28, 841.89)
IMAGE_SOURCE_EXTENSIONS = {".png", ".jpg", ".jpeg"}

# PERF (audit 2026-08-02 §COMB.2): đây là trần CHỈ dành cho máy yếu. Máy
# >=16 GB không có page-cap mặc định; admission của máy mạnh dựa trên RAM/đĩa
# khả dụng thực tế hoặc override do người vận hành chủ động đặt.
LOW_RAM_MAX_EXPANDED_PAGES = 4_000
MID_RAM_MAX_EXPANDED_PAGES = 10_000
MANIFEST_PAGE_OUTPUT_OVERHEAD_BYTES = 16 * 1024
MANIFEST_PAGE_RAM_OVERHEAD_BYTES = 64 * 1024
MANIFEST_BASE_RAM_BYTES = 128 * 1024 * 1024
MANIFEST_DISK_RESERVE_BYTES = 512 * 1024 * 1024
ProgressCallback = Callable[[str, int, int], None]
SourceCompletedCallback = Callable[[int], None]
CancelCheck = Callable[[], bool]


class ManifestJobCancelled(RuntimeError):
    """Job Combine đã nhận tín hiệu hủy hợp tác."""


def _raise_if_cancelled(cancel_check: Optional[CancelCheck]) -> None:
    if cancel_check is not None and cancel_check():
        raise ManifestJobCancelled("Đã hủy ghép PDF")


def _report_progress(
    callback: Optional[ProgressCallback],
    phase: str,
    completed: int,
    total: int,
    *,
    force: bool = False,
) -> None:
    if callback is None:
        return
    # FILEIO (audit 2026-08-02 §COMB.2): tối đa khoảng 100 lần cập nhật mỗi phase;
    # vẫn kiểm tra cancel ở từng trang nhưng không tranh lock registry hàng vạn lần.
    step = max(1, total // 100) if total > 0 else 1
    if force or completed == 0 or completed >= total or completed % step == 0:
        callback(phase, completed, total)


@dataclass(frozen=True)
class _ImageSourceInfo:
    width_px: int
    height_px: int
    width_pt: float
    height_pt: float
    source_bytes: int
    estimated_pdf_bytes: int
    requires_native_lossless: bool

    @property
    def pixels(self) -> int:
        return self.width_px * self.height_px


class ImageQualityGuardError(ValueError):
    """Dừng Combine khi chưa thể chứng minh nguồn ảnh được giữ nguyên chất lượng."""


@dataclass(frozen=True)
class ManifestResourceEstimate:
    """Ước lượng sau khi mở rộng whole-file và mọi lần lặp trang."""

    expanded_pages: int
    blank_pages: int
    pdf_page_occurrences: int
    image_page_occurrences: int
    unique_image_pixels: int
    expanded_image_pixels: int
    largest_image_pixels: int
    used_source_bytes: int
    estimated_output_bytes: int
    estimated_peak_ram_bytes: int
    estimated_working_disk_bytes: int


def _positive_dpi(value: Any) -> float:
    try:
        dpi = float(value)
    except (TypeError, ValueError):
        return 72.0
    return dpi if math.isfinite(dpi) and dpi > 0 else 72.0


def _png_lossless_capability(source_path: str) -> tuple[bool, str | None]:
    """Xác định nguồn phải đi native và metadata màu chưa có biểu diễn tương đương."""
    requires_native = False
    has_icc_or_srgb = False
    has_gamma = False
    has_chromaticities = False
    try:
        with open(source_path, "rb") as source:
            if source.read(8) != b"\x89PNG\r\n\x1a\n":
                return False, None
            while True:
                header = source.read(8)
                if len(header) != 8:
                    return False, None
                length = int.from_bytes(header[:4], "big", signed=False)
                chunk_type = header[4:8]
                if chunk_type == b"IHDR":
                    if length != 13:
                        return False, None
                    data = source.read(13)
                    if len(data) != 13:
                        return False, None
                    if data[8] != 8:
                        requires_native = True
                    source.seek(4, os.SEEK_CUR)
                    continue
                if chunk_type in {b"iCCP", b"sRGB"}:
                    has_icc_or_srgb = True
                    requires_native = True
                elif chunk_type == b"gAMA":
                    has_gamma = True
                elif chunk_type == b"cHRM":
                    has_chromaticities = True
                elif chunk_type == b"cICP":
                    return True, "PNG cICP/HDR chưa có không gian màu PDF tương đương"
                if chunk_type in {b"acTL", b"fcTL", b"fdAT"}:
                    return True, "APNG nhiều frame đang chờ đường tách frame lossless"
                if chunk_type == b"IEND":
                    if (has_gamma or has_chromaticities) and not has_icc_or_srgb:
                        return True, "PNG gAMA/cHRM chưa có CalRGB/CalGray tương đương"
                    return requires_native, None
                source.seek(length + 4, os.SEEK_CUR)
    except OSError:
        return False, None


def _quality_guard_message(source_path: str, reason: str) -> str:
    return (
        f"PrynX đã dừng ghép {os.path.basename(source_path)} để không làm giảm chất lượng: "
        f"{reason}. Không có file kết quả nào được tạo."
    )


def _read_png_phys_dpi(source_path: str) -> tuple[float, float] | None:
    """Đọc pHYs giống frontend; không giải mã bitmap và không tin EXIF."""
    try:
        with open(source_path, "rb") as source:
            if source.read(8) != b"\x89PNG\r\n\x1a\n":
                return None
            while True:
                header = source.read(8)
                if len(header) != 8:
                    return None
                length = int.from_bytes(header[:4], "big", signed=False)
                chunk_type = header[4:8]
                if chunk_type == b"pHYs":
                    if length != 9:
                        return None
                    data = source.read(9)
                    if len(data) != 9:
                        return None
                    pixels_per_metre_x = int.from_bytes(data[:4], "big", signed=False)
                    pixels_per_metre_y = int.from_bytes(data[4:8], "big", signed=False)
                    if data[8] == 1 and pixels_per_metre_x > 0 and pixels_per_metre_y > 0:
                        return pixels_per_metre_x * 0.0254, pixels_per_metre_y * 0.0254
                    return None
                if chunk_type in {b"IDAT", b"IEND"}:
                    return None
                source.seek(length + 4, os.SEEK_CUR)
    except OSError:
        return None


def _read_jpeg_jfif_dpi(source_path: str) -> tuple[float, float] | None:
    """Chỉ nhận APP0/JFIF ngay sau SOI để MediaBox không đổi theo nhánh xử lý."""
    try:
        with open(source_path, "rb") as source:
            header = source.read(18)
    except OSError:
        return None
    if (
        len(header) < 18
        or header[:4] != b"\xff\xd8\xff\xe0"
        or header[6:11] != b"JFIF\x00"
    ):
        return None
    units = header[13]
    density_x = int.from_bytes(header[14:16], "big", signed=False)
    density_y = int.from_bytes(header[16:18], "big", signed=False)
    if density_x <= 0 or density_y <= 0:
        return None
    if units == 1:
        return float(density_x), float(density_y)
    if units == 2:
        return density_x * 2.54, density_y * 2.54
    return None


def _read_image_dpi(source_path: str, extension: str) -> tuple[float, float]:
    parsed = (
        _read_png_phys_dpi(source_path)
        if extension == ".png"
        else _read_jpeg_jfif_dpi(source_path)
    )
    if parsed is None:
        return 72.0, 72.0
    return _positive_dpi(parsed[0]), _positive_dpi(parsed[1])


def _estimate_image_pdf_bytes(extension: str, source_bytes: int, pixels: int) -> int:
    """Ước lượng temp PDF; JPEG giữ DCT, PNG có thể cần thêm SMask/Flate."""
    overhead = 64 * 1024
    if extension in {".jpg", ".jpeg"}:
        return max(source_bytes + overhead, math.ceil(source_bytes * 1.10))
    return max(source_bytes * 2 + overhead, pixels * 5 + overhead)


def _inspect_image_source(source_path: str) -> _ImageSourceInfo:
    """Đọc kích thước/DPI một lần để admission chạy trước khi tạo PDF tạm."""
    extension = os.path.splitext(source_path)[1].lower()
    expected_format = "PNG" if extension == ".png" else "JPEG"
    requires_native_lossless = False
    if extension == ".png":
        requires_native_lossless, reason = _png_lossless_capability(source_path)
        if reason:
            raise ImageQualityGuardError(_quality_guard_message(source_path, reason))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source_path) as image:
                if image.format != expected_format or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Image extension and content do not match")
                if extension in {".jpg", ".jpeg"} and image.info.get("icc_profile"):
                    requires_native_lossless = True
                width_px, height_px = image.size
                if width_px <= 0 or height_px <= 0:
                    raise ValueError("Invalid image dimensions")
                image.verify()
        source_bytes = os.path.getsize(source_path)
        dpi_x, dpi_y = _read_image_dpi(source_path, extension)
        pixels = width_px * height_px
        return _ImageSourceInfo(
            width_px=width_px,
            height_px=height_px,
            width_pt=width_px / dpi_x * 72.0,
            height_pt=height_px / dpi_y * 72.0,
            source_bytes=source_bytes,
            estimated_pdf_bytes=_estimate_image_pdf_bytes(extension, source_bytes, pixels),
            requires_native_lossless=requires_native_lossless,
        )
    except ImageQualityGuardError:
        raise
    except (
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        raise ValueError(f"Nguồn ảnh không hợp lệ: {os.path.basename(source_path)}") from exc


def _image_to_pdf(
    source_path: str,
    output_path: str,
    image_info: _ImageSourceInfo | None = None,
) -> None:
    """Chuyển một ảnh thành PDF tạm rồi giải phóng bitmap trước ảnh kế tiếp."""
    try:
        info = image_info or _inspect_image_source(source_path)
        # Bảo vệ cả lần Pillow verify và lần ReportLab mở lại ảnh để nhúng.
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            from reportlab.lib.utils import ImageReader
            from reportlab.pdfgen import canvas

            writer = canvas.Canvas(
                output_path,
                pagesize=(info.width_pt, info.height_pt),
                pageCompression=1,
            )
            writer.drawImage(
                ImageReader(source_path),
                0,
                0,
                width=info.width_pt,
                height=info.height_pt,
                preserveAspectRatio=False,
                mask="auto",
            )
            writer.showPage()
            writer.save()
    except (
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        try:
            os.remove(output_path)
        except OSError:
            pass
        raise ValueError(f"Nguồn ảnh không hợp lệ: {os.path.basename(source_path)}") from exc


def _validate_source_extensions(file_paths: List[str]) -> None:
    for path in file_paths:
        extension = os.path.splitext(path)[1].lower()
        if extension != ".pdf" and extension not in IMAGE_SOURCE_EXTENSIONS:
            raise ValueError(f"Unsupported manifest source extension: {extension or '(none)'}")


def _prepare_source_path(
    path: str,
    index: int,
    temp_dir: str,
    image_info: _ImageSourceInfo | None = None,
) -> str:
    if os.path.splitext(path)[1].lower() == ".pdf":
        return path
    # PERF (audit 2026-08-01 §B.1): chỉ chuyển ảnh thực sự được manifest dùng,
    # tuần tự ra đĩa để không giữ cả bộ bitmap trong RAM/WebView.
    converted = os.path.join(temp_dir, f"image_{index}.pdf")
    _image_to_pdf(path, converted, image_info)
    return converted


def _positive_env_limit(name: str) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _estimate_manifest_resources(
    file_paths: List[str],
    manifest: List[Dict[str, Any]],
    sources: Dict[int, pikepdf.Pdf],
    stack: ExitStack,
    image_infos: Dict[int, _ImageSourceInfo],
    *,
    progress_callback: Optional[ProgressCallback] = None,
    cancel_check: Optional[CancelCheck] = None,
) -> ManifestResourceEstimate:
    """Mở rộng logic manifest nhưng chưa append trang hay tạo PDF ảnh tạm."""
    page_counts: Dict[int, int] = {}
    used_source_indices: set[int] = set()
    expanded_pages = 0
    blank_pages = 0
    pdf_page_occurrences = 0
    image_page_occurrences = 0
    expanded_image_pixels = 0

    def source_page_count(file_index: int) -> int:
        _raise_if_cancelled(cancel_check)
        cached = page_counts.get(file_index)
        if cached is not None:
            return cached
        path = file_paths[file_index]
        extension = os.path.splitext(path)[1].lower()
        if extension in IMAGE_SOURCE_EXTENSIONS:
            info = _inspect_image_source(path)
            image_infos[file_index] = info
            count = 1
        else:
            source = sources.get(file_index)
            if source is None:
                source = stack.enter_context(pikepdf.Pdf.open(path))
                sources[file_index] = source
            count = len(source.pages)
        page_counts[file_index] = count
        _raise_if_cancelled(cancel_check)
        return count

    _report_progress(progress_callback, "inspecting", 0, len(manifest), force=True)
    for item_index, item in enumerate(manifest):
        _raise_if_cancelled(cancel_check)
        _report_progress(progress_callback, "inspecting", item_index, len(manifest))
        if not isinstance(item, dict):
            raise ValueError("Manifest item must be an object")
        try:
            rotation = int(item.get("rotation", 0) or 0) % 360
        except (TypeError, ValueError) as exc:
            raise ValueError("Manifest rotation must be a multiple of 90") from exc
        if rotation % 90 != 0:
            raise ValueError("Manifest rotation must be a multiple of 90")

        if item.get("blank"):
            try:
                width = float(item.get("width") or DEFAULT_BLANK_PAGE_SIZE[0])
                height = float(item.get("height") or DEFAULT_BLANK_PAGE_SIZE[1])
            except (TypeError, ValueError) as exc:
                raise ValueError("Blank page dimensions are invalid") from exc
            if width <= 0 or height <= 0 or width > 20_000 or height > 20_000:
                raise ValueError("Blank page dimensions are invalid")
            blank_pages += 1
            expanded_pages += 1
            continue

        try:
            file_index = int(item["file_index"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Manifest page reference is invalid") from exc
        if not 0 <= file_index < len(file_paths):
            raise ValueError("Manifest file index is out of range")

        page_count = source_page_count(file_index)
        used_source_indices.add(file_index)
        if "page_index" not in item:
            occurrence_count = page_count
        else:
            try:
                single = int(item["page_index"])
            except (TypeError, ValueError) as exc:
                raise ValueError("Manifest page reference is invalid") from exc
            if not 0 <= single < page_count:
                raise ValueError("Manifest page index is out of range")
            occurrence_count = 1

        expanded_pages += occurrence_count
        extension = os.path.splitext(file_paths[file_index])[1].lower()
        if extension in IMAGE_SOURCE_EXTENSIONS:
            info = image_infos[file_index]
            image_page_occurrences += occurrence_count
            expanded_image_pixels += info.pixels * occurrence_count
        else:
            pdf_page_occurrences += occurrence_count

    _report_progress(
        progress_callback,
        "inspecting",
        len(manifest),
        len(manifest),
        force=True,
    )
    _raise_if_cancelled(cancel_check)

    used_source_bytes = 0
    pdf_source_bytes = 0
    image_pdf_bytes = 0
    unique_image_pixels = 0
    largest_image_pixels = 0
    for file_index in used_source_indices:
        _raise_if_cancelled(cancel_check)
        path = file_paths[file_index]
        extension = os.path.splitext(path)[1].lower()
        if extension in IMAGE_SOURCE_EXTENSIONS:
            info = image_infos[file_index]
            used_source_bytes += info.source_bytes
            image_pdf_bytes += info.estimated_pdf_bytes
            unique_image_pixels += info.pixels
            largest_image_pixels = max(largest_image_pixels, info.pixels)
        else:
            source_bytes = os.path.getsize(path)
            used_source_bytes += source_bytes
            pdf_source_bytes += source_bytes

    estimated_output_bytes = (
        1024 * 1024
        + pdf_source_bytes
        + image_pdf_bytes
        + expanded_pages * MANIFEST_PAGE_OUTPUT_OVERHEAD_BYTES
    )
    estimated_peak_ram_bytes = (
        MANIFEST_BASE_RAM_BYTES
        + used_source_bytes
        + expanded_pages * MANIFEST_PAGE_RAM_OVERHEAD_BYTES
        + largest_image_pixels * 12
    )
    estimated_working_disk_bytes = estimated_output_bytes + image_pdf_bytes
    return ManifestResourceEstimate(
        expanded_pages=expanded_pages,
        blank_pages=blank_pages,
        pdf_page_occurrences=pdf_page_occurrences,
        image_page_occurrences=image_page_occurrences,
        unique_image_pixels=unique_image_pixels,
        expanded_image_pixels=expanded_image_pixels,
        largest_image_pixels=largest_image_pixels,
        used_source_bytes=used_source_bytes,
        estimated_output_bytes=estimated_output_bytes,
        estimated_peak_ram_bytes=estimated_peak_ram_bytes,
        estimated_working_disk_bytes=estimated_working_disk_bytes,
    )


def _enforce_manifest_admission(
    estimate: ManifestResourceEstimate,
    output_path: str,
) -> None:
    """Từ chối trước append nếu expansion chắc chắn vượt ngân sách máy hiện tại."""
    total_mb, available_mb = read_memory_status_mb()
    env_page_cap = _positive_env_limit("PRYNX_MANIFEST_MAX_PAGES")
    page_cap = env_page_cap
    cap_reason = "PRYNX_MANIFEST_MAX_PAGES" if env_page_cap is not None else ""
    if page_cap is None and total_mb is not None:
        if total_mb < 8 * 1024:
            page_cap = LOW_RAM_MAX_EXPANDED_PAGES
            cap_reason = "máy dưới 8 GB RAM"
        elif total_mb < 16 * 1024:
            page_cap = MID_RAM_MAX_EXPANDED_PAGES
            cap_reason = "máy dưới 16 GB RAM"

    if page_cap is not None and estimate.expanded_pages > page_cap:
        raise ValueError(
            f"Kế hoạch ghép mở rộng thành {estimate.expanded_pages:,} trang, vượt mức "
            f"{page_cap:,} trang của {cap_reason}. Hãy chia thành nhiều lượt ghép nhỏ hơn."
        )

    env_output_mb = _positive_env_limit("PRYNX_MANIFEST_MAX_OUTPUT_MB")
    if (
        env_output_mb is not None
        and estimate.estimated_output_bytes > env_output_mb * 1024 * 1024
    ):
        raise ValueError(
            f"File ghép ước tính {estimate.estimated_output_bytes / (1024 ** 3):.2f} GB, "
            f"vượt PRYNX_MANIFEST_MAX_OUTPUT_MB={env_output_mb}."
        )

    slots = max(1, max_active_heavy_jobs())
    if available_mb is not None:
        if total_mb is not None and total_mb < 8 * 1024:
            reserve_mb, usable_fraction = 512.0, 0.55
        elif total_mb is not None and total_mb < 16 * 1024:
            reserve_mb, usable_fraction = 1024.0, 0.65
        else:
            reserve_mb, usable_fraction = 1536.0, 0.70
        usable_job_mb = max(0.0, available_mb - reserve_mb) * usable_fraction / slots
        estimated_peak_mb = estimate.estimated_peak_ram_bytes / (1024 * 1024)
        if estimated_peak_mb > usable_job_mb:
            raise ValueError(
                f"Kế hoạch ghép {estimate.expanded_pages:,} trang cần khoảng "
                f"{estimated_peak_mb / 1024:.2f} GB RAM, nhưng ngân sách còn "
                f"{usable_job_mb / 1024:.2f} GB cho mỗi job. Hãy đóng bớt ứng dụng "
                "hoặc chia thành nhiều lượt ghép nhỏ hơn."
            )

    output_dir = os.path.dirname(os.path.abspath(output_path)) or os.getcwd()
    try:
        free_disk_bytes = shutil.disk_usage(output_dir).free
    except OSError:
        free_disk_bytes = None
    if free_disk_bytes is not None:
        usable_disk_bytes = (
            max(0, free_disk_bytes - MANIFEST_DISK_RESERVE_BYTES) * 0.90 / slots
        )
        if estimate.estimated_working_disk_bytes > usable_disk_bytes:
            raise ValueError(
                f"Kế hoạch ghép cần khoảng "
                f"{estimate.estimated_working_disk_bytes / (1024 ** 3):.2f} GB đĩa tạm, "
                f"nhưng ngân sách còn {usable_disk_bytes / (1024 ** 3):.2f} GB cho mỗi job. "
                "Hãy giải phóng dung lượng hoặc chia thành nhiều lượt ghép nhỏ hơn."
            )

    logger.info(
        "Manifest admission: pages=%d pdf_pages=%d image_pages=%d image_pixels=%d "
        "output_mb=%.1f peak_ram_mb=%.1f working_disk_mb=%.1f slots=%d",
        estimate.expanded_pages,
        estimate.pdf_page_occurrences,
        estimate.image_page_occurrences,
        estimate.expanded_image_pixels,
        estimate.estimated_output_bytes / (1024 * 1024),
        estimate.estimated_peak_ram_bytes / (1024 * 1024),
        estimate.estimated_working_disk_bytes / (1024 * 1024),
        slots,
    )


def _load_native_image_merger() -> Optional[Callable[..., str]]:
    """Nạp lười extension Rust; dev chưa build native vẫn dùng fallback an toàn."""
    try:
        import pdfcompare_native
    except ImportError:
        return None
    merger = getattr(pdfcompare_native, "combine_image_manifest_native", None)
    return merger if callable(merger) else None


def _build_native_image_request(
    file_paths: List[str],
    manifest: List[Dict[str, Any]],
    image_infos: Dict[int, _ImageSourceInfo],
) -> tuple[dict[str, Any], list[int]] | None:
    used_original_indices = sorted(
        {
            int(item["file_index"])
            for item in manifest
            if isinstance(item, dict) and not item.get("blank")
        }
    )
    if not used_original_indices or any(
        os.path.splitext(file_paths[index])[1].lower() not in IMAGE_SOURCE_EXTENSIONS
        for index in used_original_indices
    ):
        return None

    original_to_native = {
        original_index: native_index
        for native_index, original_index in enumerate(used_original_indices)
    }
    sources = []
    for original_index in used_original_indices:
        info = image_infos.get(original_index)
        if info is None:
            return None
        sources.append(
            {
                "path": file_paths[original_index],
                "width_px": info.width_px,
                "height_px": info.height_px,
                "width_pt": info.width_pt,
                "height_pt": info.height_pt,
            }
        )

    pages: list[dict[str, Any]] = []
    for item in manifest:
        rotation = int(item.get("rotation", 0) or 0) % 360
        if item.get("blank"):
            page: dict[str, Any] = {"blank": True, "rotation": rotation}
            if item.get("width") is not None:
                page["width"] = float(item["width"])
            if item.get("height") is not None:
                page["height"] = float(item["height"])
            pages.append(page)
            continue
        original_index = int(item["file_index"])
        page_index = int(item.get("page_index", 0) or 0)
        if page_index != 0:
            return None
        pages.append(
            {
                "blank": False,
                "file_index": original_to_native[original_index],
                "rotation": rotation,
            }
        )
    return {"sources": sources, "pages": pages}, used_original_indices


def _try_native_image_manifest(
    file_paths: List[str],
    manifest: List[Dict[str, Any]],
    image_infos: Dict[int, _ImageSourceInfo],
    output_path: str,
    *,
    progress_callback: Optional[ProgressCallback],
    source_completed_callback: Optional[SourceCompletedCallback],
    cancel_check: Optional[CancelCheck],
) -> bool:
    merger = _load_native_image_merger()
    built = _build_native_image_request(file_paths, manifest, image_infos)
    guarded_sources = [
        index
        for index, info in image_infos.items()
        if info.requires_native_lossless
    ]
    if merger is None or built is None:
        if guarded_sources:
            names = ", ".join(os.path.basename(file_paths[index]) for index in guarded_sources[:3])
            raise ImageQualityGuardError(
                "PrynX đã dừng ghép để không làm giảm chất lượng: "
                f"{names} cần native lossless nhưng đường này chưa sẵn sàng. "
                "Không có file kết quả nào được tạo."
            )
        return False

    request, native_to_original = built
    largest_worker_mb = max(
        64.0,
        max(image_infos[index].pixels for index in native_to_original)
        * 8
        / (1024 * 1024)
        + 64,
    )
    workers, reason = plan_worker_count(
        kind="combine-images-native",
        per_worker_mb=largest_worker_mb,
        env_override="PRYNX_COMBINE_IMAGE_WORKERS",
    )
    workers = max(1, min(len(native_to_original), workers))
    logger.info(
        "Native image Combine: sources=%d pages=%d workers=%d (%s)",
        len(native_to_original),
        len(manifest),
        workers,
        reason,
    )

    completed_native_indices: set[int] = set()
    total_steps = len(native_to_original) + 1
    _report_progress(progress_callback, "merging", 0, total_steps, force=True)

    def source_completed(native_index: int) -> None:
        safe_index = int(native_index)
        if not 0 <= safe_index < len(native_to_original):
            raise ValueError("Native Combine trả source index ngoài phạm vi")
        if safe_index in completed_native_indices:
            return
        completed_native_indices.add(safe_index)
        original_index = native_to_original[safe_index]
        if source_completed_callback is not None:
            source_completed_callback(original_index)
        _report_progress(
            progress_callback,
            "merging",
            len(completed_native_indices),
            total_steps,
            force=True,
        )

    try:
        merger(
            json.dumps(request, ensure_ascii=False, separators=(",", ":")),
            output_path,
            workers,
            source_completed,
            lambda: bool(cancel_check and cancel_check()),
        )
    except NotImplementedError as exc:
        if guarded_sources:
            raise ImageQualityGuardError(
                "PrynX đã dừng ghép vì native chưa bảo toàn đầy đủ nguồn 16-bit/ICC. "
                "Không có file kết quả nào được tạo."
            ) from exc
        logger.info("Native image Combine fallback: %s", str(exc).splitlines()[0])
        return False
    except InterruptedError as exc:
        raise ManifestJobCancelled("Đã hủy ghép PDF") from exc

    _raise_if_cancelled(cancel_check)
    if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
        raise ValueError("Native Combine không tạo được PDF kết quả")
    _report_progress(
        progress_callback,
        "saving",
        total_steps,
        total_steps,
        force=True,
    )
    return True


def _visible_page_size(page) -> tuple[float, float]:
    """Return page dimensions after its effective quarter-turn rotation."""
    box = [float(value) for value in page.mediabox]
    width = box[2] - box[0]
    height = box[3] - box[1]
    rotation = int(page.obj.get("/Rotate", 0) or 0) % 360
    return (height, width) if rotation in (90, 270) else (width, height)


def merge_manifest(
    file_paths: List[str],
    manifest: List[Dict[str, Any]],
    output_path: str,
    *,
    progress_callback: Optional[ProgressCallback] = None,
    cancel_check: Optional[CancelCheck] = None,
    source_completed_callback: Optional[SourceCompletedCallback] = None,
    order_mode: str = "manifest",
) -> str:
    """Assemble a PDF from a bounded list of source-page operations.

    Each item is either ``{"blank": true, "width": ..., "height": ...}`` or
    references a source by ``file_index``. A page reference either carries a
    zero-based ``page_index`` (a single page) or omits it entirely, which means
    "append every page of the source in order". ``rotation`` is an additional
    clockwise quarter-turn value composed with each page's existing /Rotate.
    `order_mode="interleave"` round-robins whole PDF sources by page.
    """
    if not file_paths or len(file_paths) > MAX_MANIFEST_FILES:
        raise ValueError("Manifest file count is outside the allowed range")
    if not manifest or len(manifest) > MAX_MANIFEST_ITEMS:
        raise ValueError("Manifest item count is outside the allowed range")
    if order_mode not in {"manifest", "interleave"}:
        raise ValueError("Manifest order mode is invalid")

    interleave_file_indices: list[int] = []
    if order_mode == "interleave":
        if len(manifest) < 2:
            raise ValueError("Interleave requires at least 2 files")
        for item in manifest:
            if not isinstance(item, dict) or set(item) != {"file_index"}:
                raise ValueError("Interleave only accepts whole PDF sources")
            try:
                file_index = int(item["file_index"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("Interleave source reference is invalid") from exc
            if not 0 <= file_index < len(file_paths):
                raise ValueError("Interleave file index is out of range")
            if os.path.splitext(file_paths[file_index])[1].lower() != ".pdf":
                raise ValueError("Interleave only accepts PDF sources")
            interleave_file_indices.append(file_index)
    _raise_if_cancelled(cancel_check)

    out_doc = pikepdf.Pdf.new()
    # Mirror the old frontend behavior: a blank page with no explicit size takes
    # the size of the first page in the output (or A4 if the blank comes first).
    first_page_size = None
    with ExitStack() as stack:
        _validate_source_extensions(file_paths)
        temp_parent = os.path.dirname(os.path.abspath(output_path))
        temp_dir = stack.enter_context(
            tempfile.TemporaryDirectory(prefix="prynx_combine_images_", dir=temp_parent)
        )
        sources: Dict[int, pikepdf.Pdf] = {}
        image_infos: Dict[int, _ImageSourceInfo] = {}
        # PERF (audit 2026-08-02 §COMB.2): đếm trang THẬT sau whole-file
        # expansion/lặp trang và chặn theo tài nguyên trước khi append object graph.
        estimate = _estimate_manifest_resources(
            file_paths,
            manifest,
            sources,
            stack,
            image_infos,
            progress_callback=progress_callback,
            cancel_check=cancel_check,
        )
        _enforce_manifest_admission(estimate, output_path)
        _raise_if_cancelled(cancel_check)
        if order_mode == "manifest" and _try_native_image_manifest(
            file_paths,
            manifest,
            image_infos,
            output_path,
            progress_callback=progress_callback,
            source_completed_callback=source_completed_callback,
            cancel_check=cancel_check,
        ):
            return output_path

        completed_pages = 0
        _report_progress(
            progress_callback,
            "merging",
            completed_pages,
            estimate.expanded_pages,
            force=True,
        )

        if interleave_file_indices:
            def interleaved_items():
                max_pages = max(len(sources[index].pages) for index in interleave_file_indices)
                for page_index in range(max_pages):
                    for file_index in interleave_file_indices:
                        if page_index < len(sources[file_index].pages):
                            yield {"file_index": file_index, "page_index": page_index}

            ordered_items = interleaved_items()
        else:
            ordered_items = iter(manifest)

        if interleave_file_indices:
            remaining_source_items = {
                index: len(sources[index].pages) for index in interleave_file_indices
            }
        else:
            remaining_source_items = Counter(
                int(item["file_index"])
                for item in manifest
                if isinstance(item, dict) and not item.get("blank")
            )

        for item in ordered_items:
            _raise_if_cancelled(cancel_check)
            if not isinstance(item, dict):
                raise ValueError("Manifest item must be an object")

            rotation = int(item.get("rotation", 0) or 0) % 360
            if rotation % 90 != 0:
                raise ValueError("Manifest rotation must be a multiple of 90")

            item_source_index: int | None = None
            appended_pages = []
            if item.get("blank"):
                if item.get("width") is not None or item.get("height") is not None:
                    width = float(item.get("width") or DEFAULT_BLANK_PAGE_SIZE[0])
                    height = float(item.get("height") or DEFAULT_BLANK_PAGE_SIZE[1])
                elif first_page_size is not None:
                    width, height = first_page_size
                else:
                    width, height = DEFAULT_BLANK_PAGE_SIZE
                if width <= 0 or height <= 0 or width > 20_000 or height > 20_000:
                    raise ValueError("Blank page dimensions are invalid")
                out_doc.add_blank_page(page_size=(width, height))
                appended_pages.append(out_doc.pages[-1])
                completed_pages += 1
                _report_progress(
                    progress_callback,
                    "merging",
                    completed_pages,
                    estimate.expanded_pages,
                )
                _raise_if_cancelled(cancel_check)
            else:
                try:
                    file_index = int(item["file_index"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError("Manifest page reference is invalid") from exc
                if not 0 <= file_index < len(file_paths):
                    raise ValueError("Manifest file index is out of range")
                item_source_index = file_index
                source = sources.get(file_index)
                if source is None:
                    _raise_if_cancelled(cancel_check)
                    prepared_path = _prepare_source_path(
                        file_paths[file_index],
                        file_index,
                        temp_dir,
                        image_infos.get(file_index),
                    )
                    source = stack.enter_context(pikepdf.Pdf.open(prepared_path))
                    sources[file_index] = source
                    _raise_if_cancelled(cancel_check)

                # A missing page_index means "the whole file, in order". This is
                # how a non-expanded multi-page PDF node is represented — omitting
                # it previously defaulted to page 0 and silently dropped pages.
                if "page_index" not in item:
                    page_indices = range(len(source.pages))
                else:
                    try:
                        single = int(item["page_index"])
                    except (TypeError, ValueError) as exc:
                        raise ValueError("Manifest page reference is invalid") from exc
                    if not 0 <= single < len(source.pages):
                        raise ValueError("Manifest page index is out of range")
                    page_indices = [single]

                for pi in page_indices:
                    _raise_if_cancelled(cancel_check)
                    out_doc.pages.append(source.pages[pi])
                    appended_pages.append(out_doc.pages[-1])
                    completed_pages += 1
                    _report_progress(
                        progress_callback,
                        "merging",
                        completed_pages,
                        estimate.expanded_pages,
                    )
                    _raise_if_cancelled(cancel_check)

            if rotation:
                for page in appended_pages:
                    _raise_if_cancelled(cancel_check)
                    current = int(page.obj.get("/Rotate", 0) or 0) % 360
                    page.obj["/Rotate"] = (current + rotation) % 360

            if first_page_size is None and appended_pages:
                try:
                    first_page_size = _visible_page_size(appended_pages[0])
                except Exception:
                    first_page_size = None

            if item_source_index is not None:
                remaining_source_items[item_source_index] -= 1
                if (
                    remaining_source_items[item_source_index] <= 0
                    and source_completed_callback is not None
                ):
                    source_completed_callback(item_source_index)

    _report_progress(
        progress_callback,
        "saving",
        completed_pages,
        estimate.expanded_pages,
        force=True,
    )
    _raise_if_cancelled(cancel_check)
    try:
        save_pdf_compat(out_doc, output_path)
        _raise_if_cancelled(cancel_check)
    except ManifestJobCancelled:
        try:
            os.remove(output_path)
        except OSError:
            pass
        raise
    return output_path

