"""
Shared comparison engine logic.
Extracted from compare.py (sync route) and compare_task.py (Celery worker)
to eliminate code duplication.

Chính sách so sánh PDF (in ấn): PIXEL-FIRST.
  - Nguồn sự thật = render trang → absdiff / SSIM / contour (ImageComparator).
  - Không OCR, không inject region từ text layer — tránh nhiễu / bỏ sót outline.
  - Text layer (nếu có) chỉ dùng phụ cho căn trang khi lệch số trang, không quyết
    định pass/fail. So chữ thuần: tool compare_text / QC riêng.
"""
import logging
import math
import multiprocessing
import os
import shutil
import tempfile
import threading
import time
from collections import deque
from concurrent.futures import (
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    TimeoutError as FutureTimeoutError,
)
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from sqlalchemy.orm import Session

from app.config import settings
from app.core.pdf_processor import PDFProcessor
from app.core.image_comparator import ImageComparator
from app.core.highlight_renderer import HighlightRenderer
from app.core.system_memory import plan_worker_count
from app.models.job import ComparisonJob, PageResult, UploadedFile

logger = logging.getLogger(__name__)

# PERF (audit 2026-08-13 §P25.1): ngưỡng an toàn NHỎ HƠN IMPOSITION_AREA_RATIO (1.8)
# của ImageComparator. Cặp trang chỉ được coi là "ghép 1:1 chắc chắn" khi tỉ lệ diện
# tích còn cách xa ngưỡng dò tờ bình — chừa biên cho sai số làm tròn điểm→pixel.
_PIPELINE_AREA_RATIO_SAFETY = 1.7
_COMPARE_CV_THREADS_LOCK = threading.Lock()

# PERF (audit 2026-08-13 §PB-2): commit PageResult theo lô nhỏ thay vì mỗi trang.
# Đo stage trên tài liệu 250 trang cho thấy fsync SQLite mỗi trang chiếm 6–9% sàn
# tuần tự main-thread của pipeline. Giới hạn trễ 1 giây giữ nhịp cập nhật tiến độ
# cho UI (local mode đọc progress qua DB); checkpoint hủy vẫn chạy MỖI TRANG.
_COMPARE_COMMIT_BATCH_PAGES = 16
_COMPARE_COMMIT_MAX_LAG_S = 1.0

# PERF (audit 2026-08-13 §PB-3): bước dò bình bài so MỌI trang nguồn với MỌI tờ
# bình (O(A×B) lượt so mini 48 DPI) — 1.000 trang nguồn × 666 tờ ≈ 666.000 lượt,
# bùng nổ hàng giờ trước khi vào pipeline. Trần mặc định đúng bằng thế giới đã
# phủ benchmark/smoke ở trần 250 trang (250×250). Đây là TRẦN SẢN PHẨM như
# PRYNX_MAX_COMPARE_PAGES, không gate theo phần cứng; người vận hành nới qua env
# khi chấp nhận thời gian dò.
_DEFAULT_MAX_IMPOSITION_MAP_CELLS = 250 * 250
_MAP_PROGRESS_MIN_INTERVAL_S = 1.0
_DEFAULT_COMPARE_FULL_FRAME_PIXELS = 40_000_000
_DEFAULT_COMPARE_TILE_SIZE = 2048
_DEFAULT_COMPARE_PROCESS_MIN_PAGES = 16
_DEFAULT_COMPARE_PROCESS_MIN_PIXELS = 8_000_000


def _comparison_size_strategy(
    size_a: tuple[int, int],
    size_b: tuple[int, int],
) -> str:
    """Phân loại khổ trang đúng thứ tự nhánh của ``ImageComparator.compare``."""
    width_a, height_a = size_a
    width_b, height_b = size_b
    if size_a == size_b:
        return "same"
    area_a = float(width_a * height_a)
    area_b = float(width_b * height_b)
    if min(area_a, area_b) <= 0:
        return "unsupported"
    aspect_a = width_a / float(height_a)
    aspect_b = width_b / float(height_b)
    size_equalish = (
        abs(width_a - width_b) <= 0.02 * max(width_a, width_b)
        and abs(height_a - height_b) <= 0.02 * max(height_a, height_b)
    )
    aspect_close = abs(aspect_a - aspect_b) <= 0.06 * max(
        aspect_a, aspect_b, 1e-6
    )
    area_ratio = max(area_a, area_b) / min(area_a, area_b)
    if not size_equalish and aspect_close and 1.02 < area_ratio < 1.8:
        return "scale"
    if not size_equalish and area_ratio >= 1.8:
        return "imposition"
    return "pad"


def _padded_region_reader(
    source_reader: Callable[[int, int, int, int], object],
    source_size: tuple[int, int],
):
    """Reader khung đích: vùng ngoài trang nguồn là trắng, gốc giữ trên-trái."""
    source_width, source_height = source_size

    def read(x: int, y: int, width: int, height: int):
        import numpy as np

        output = np.full((height, width, 3), 255, dtype=np.uint8)
        inside_width = max(0, min(x + width, source_width) - x)
        inside_height = max(0, min(y + height, source_height) - y)
        if inside_width > 0 and inside_height > 0:
            source = source_reader(x, y, inside_width, inside_height)
            output[:inside_height, :inside_width] = source
        return output

    return read


class _DiskBackedResizeReader:
    """Resize RGB full-frame bằng OpenCV nhưng giữ nguồn/đích trên staging đĩa."""

    def __init__(
        self,
        source_reader: Callable[[int, int, int, int], object],
        source_size: tuple[int, int],
        target_size: tuple[int, int],
        *,
        tile_size: int,
        staging_dir: str | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ):
        import cv2
        import numpy as np

        source_width, source_height = source_size
        target_width, target_height = target_size
        self._files = []
        self._maps = []
        self._closed = False
        try:
            source_file = tempfile.TemporaryFile(
                prefix="prynx_compare_resize_src_", dir=staging_dir
            )
            self._files.append(source_file)
            source_file.truncate(source_width * source_height * 3)
            source_map = np.memmap(
                source_file,
                dtype=np.uint8,
                mode="r+",
                shape=(source_height, source_width, 3),
            )
            self._maps.append(source_map)
            for y in range(0, source_height, tile_size):
                read_height = min(tile_size, source_height - y)
                for x in range(0, source_width, tile_size):
                    if cancel_check is not None and cancel_check():
                        raise InterruptedError("Đã hủy khi đang tạo staging resize")
                    read_width = min(tile_size, source_width - x)
                    source_map[y:y + read_height, x:x + read_width] = source_reader(
                        x, y, read_width, read_height
                    )
            source_map.flush()

            target_file = tempfile.TemporaryFile(
                prefix="prynx_compare_resize_dst_", dir=staging_dir
            )
            self._files.append(target_file)
            target_file.truncate(target_width * target_height * 3)
            target_map = np.memmap(
                target_file,
                dtype=np.uint8,
                mode="r+",
                shape=(target_height, target_width, 3),
            )
            self._maps.append(target_map)
            resized = cv2.resize(
                source_map,
                (target_width, target_height),
                dst=target_map,
                interpolation=cv2.INTER_AREA,
            )
            if not np.shares_memory(resized, target_map):
                raise RuntimeError("OpenCV không ghi resize trực tiếp vào staging đích")
            target_map.flush()
            self._target = target_map
        except Exception:
            self.close()
            raise

    def read(self, x: int, y: int, width: int, height: int):
        import numpy as np

        if self._closed:
            raise RuntimeError("Staging resize đã đóng")
        return np.ascontiguousarray(
            self._target[y:y + height, x:x + width]
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._target = None
        for mapping in reversed(self._maps):
            try:
                mapping.flush()
                mapping._mmap.close()
            except Exception:
                logger.exception("Không đóng sạch được memmap resize Compare")
        self._maps.clear()
        for file_handle in reversed(self._files):
            try:
                file_handle.close()
            except Exception:
                logger.exception("Không đóng sạch được file staging resize Compare")
        self._files.clear()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


class _DiskBackedRGBRasterReader:
    """Dựng một raster RGB theo tile vào memmap để làm template lớn."""

    def __init__(
        self,
        source_reader: Callable[[int, int, int, int], object],
        size: tuple[int, int],
        *,
        tile_size: int,
        staging_dir: str | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ):
        import numpy as np

        width, height = size
        self._file = tempfile.TemporaryFile(
            prefix="prynx_compare_template_", dir=staging_dir
        )
        self._map = None
        self._closed = False
        try:
            self._file.truncate(width * height * 3)
            self._map = np.memmap(
                self._file,
                dtype=np.uint8,
                mode="r+",
                shape=(height, width, 3),
            )
            for y in range(0, height, tile_size):
                tile_height = min(tile_size, height - y)
                for x in range(0, width, tile_size):
                    if cancel_check is not None and cancel_check():
                        raise InterruptedError("Đã hủy khi dựng template staging")
                    tile_width = min(tile_size, width - x)
                    self._map[y:y + tile_height, x:x + tile_width] = source_reader(
                        x, y, tile_width, tile_height
                    )
            self._map.flush()
        except Exception:
            self.close()
            raise

    @property
    def array(self):
        if self._closed:
            raise RuntimeError("Template staging đã đóng")
        return self._map

    def read(self, x: int, y: int, width: int, height: int):
        import numpy as np

        return np.ascontiguousarray(self.array[y:y + height, x:x + width])

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._map is not None:
            try:
                self._map.flush()
                self._map._mmap.close()
            except Exception:
                logger.exception("Không đóng sạch được template memmap Compare")
            self._map = None
        try:
            self._file.close()
        except Exception:
            logger.exception("Không đóng sạch được file template Compare")

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def _prepare_tiled_size_readers(
    read_a_source: Callable[[int, int, int, int], object],
    read_b_source: Callable[[int, int, int, int], object],
    size_a: tuple[int, int],
    size_b: tuple[int, int],
    strategy: str,
    *,
    tile_size: int,
    staging_dir: str | None = None,
    cancel_check: Callable[[], bool] | None = None,
):
    """Chuẩn bị reader A/B trên cùng lưới đích và callback dọn staging."""
    staging: list[_DiskBackedResizeReader] = []

    def close() -> None:
        for item in reversed(staging):
            item.close()
        staging.clear()

    try:
        if strategy == "same":
            return size_a, read_a_source, read_b_source, read_b_source, close
        if strategy == "pad":
            target_size = (
                max(size_a[0], size_b[0]),
                max(size_a[1], size_b[1]),
            )
            read_a = _padded_region_reader(read_a_source, size_a)
            read_b = _padded_region_reader(read_b_source, size_b)
            return target_size, read_a, read_b, read_b, close
        if strategy == "scale":
            area_a = size_a[0] * size_a[1]
            area_b = size_b[0] * size_b[1]
            if area_a >= area_b:
                target_size = size_a
                resized_b = _DiskBackedResizeReader(
                    read_b_source,
                    size_b,
                    target_size,
                    tile_size=tile_size,
                    staging_dir=staging_dir,
                    cancel_check=cancel_check,
                )
                staging.append(resized_b)
                return target_size, read_a_source, resized_b.read, resized_b.read, close
            target_size = size_b
            resized_a = _DiskBackedResizeReader(
                read_a_source,
                size_a,
                target_size,
                tile_size=tile_size,
                staging_dir=staging_dir,
                cancel_check=cancel_check,
            )
            staging.append(resized_a)
            return target_size, resized_a.read, read_b_source, read_b_source, close
        raise ValueError(f"Chiến lược kích thước chưa hỗ trợ tile: {strategy}")
    except Exception:
        close()
        raise


def _normalize_tiled_previews(preview_a, preview_b, strategy: str):
    """Đưa preview về đúng semantics scale/pad trước khi ước lượng translation."""
    if strategy != "scale":
        return preview_a, preview_b
    import cv2

    area_a = preview_a.shape[0] * preview_a.shape[1]
    area_b = preview_b.shape[0] * preview_b.shape[1]
    if area_a >= area_b:
        preview_b = cv2.resize(
            preview_b,
            (preview_a.shape[1], preview_a.shape[0]),
            interpolation=cv2.INTER_AREA,
        )
    else:
        preview_a = cv2.resize(
            preview_a,
            (preview_b.shape[1], preview_b.shape[0]),
            interpolation=cv2.INTER_AREA,
        )
    return preview_a, preview_b


def _aligned_tiled_reader(
    base_reader: Callable[[int, int, int, int], object],
    comparator: ImageComparator,
    page_size: tuple[int, int],
    dx: float,
    dy: float,
):
    """Bọc reader nền bằng cùng phép translation mà comparator đã áp."""
    page_width, page_height = page_size

    def read(x: int, y: int, width: int, height: int):
        guard = int(math.ceil(max(abs(dx), abs(dy)))) + 2
        read_x = max(0, x - guard)
        read_y = max(0, y - guard)
        read_right = min(page_width, x + width + guard)
        read_bottom = min(page_height, y + height + guard)
        image = base_reader(
            read_x,
            read_y,
            read_right - read_x,
            read_bottom - read_y,
        )
        image = comparator._apply_translation(image, dx, dy)
        return image[
            y - read_y:y - read_y + height,
            x - read_x:x - read_x + width,
        ]

    return read


def _max_imposition_map_cells() -> int:
    """Trần số lượt dò bình bài; đọc mỗi lần chạy để override không cần reload."""
    raw = os.environ.get("PRYNX_MAX_IMPOSITION_MAP_CELLS", "")
    try:
        value = int(raw) if raw else _DEFAULT_MAX_IMPOSITION_MAP_CELLS
    except (TypeError, ValueError):
        logger.warning(
            "PRYNX_MAX_IMPOSITION_MAP_CELLS không hợp lệ (%r); dùng mặc định %d.",
            raw,
            _DEFAULT_MAX_IMPOSITION_MAP_CELLS,
        )
        return _DEFAULT_MAX_IMPOSITION_MAP_CELLS
    return max(1, value)


def _compare_full_frame_pixel_threshold() -> int:
    """Ngưỡng chọn chiến lược, không phải trần từ chối trang lớn."""
    raw = os.environ.get("PRYNX_MAX_COMPARE_PAGE_PIXELS", "")
    try:
        value = int(raw) if raw else _DEFAULT_COMPARE_FULL_FRAME_PIXELS
    except (TypeError, ValueError):
        value = _DEFAULT_COMPARE_FULL_FRAME_PIXELS
    return max(1, value)


def _compare_tile_size() -> int:
    """Tile mặc định gate theo RAM: máy yếu giảm, máy mạnh giữ 2048 px."""
    raw = os.environ.get("PRYNX_COMPARE_TILE_SIZE", "")
    try:
        configured = int(raw) if raw else 0
    except (TypeError, ValueError):
        configured = 0
    if configured > 0:
        return max(256, min(configured, 4096))

    from app.core.system_memory import read_memory_status_mb

    total_mb, _available_mb = read_memory_status_mb()
    if total_mb is not None and total_mb < 8 * 1024:
        return 1024
    if total_mb is not None and total_mb < 16 * 1024:
        return 1536
    return _DEFAULT_COMPARE_TILE_SIZE


def _compare_process_min_pages() -> int:
    """Ngưỡng bù startup spawn Windows; env có thể ép xuống để benchmark/test."""
    raw = os.environ.get("PRYNX_COMPARE_PROCESS_MIN_PAGES", "")
    try:
        value = int(raw) if raw else _DEFAULT_COMPARE_PROCESS_MIN_PAGES
    except (TypeError, ValueError):
        value = _DEFAULT_COMPARE_PROCESS_MIN_PAGES
    return max(2, value)


def _compare_process_min_pixels() -> int:
    """Chỉ trả phí spawn khi mỗi trang đủ nặng; đây là gate theo workload."""
    raw = os.environ.get("PRYNX_COMPARE_PROCESS_MIN_PIXELS", "")
    try:
        value = int(raw) if raw else _DEFAULT_COMPARE_PROCESS_MIN_PIXELS
    except (TypeError, ValueError):
        value = _DEFAULT_COMPARE_PROCESS_MIN_PIXELS
    return max(1, value)


def _compare_page_process_worker(payload: dict):
    """Worker process độc lập cho cặp trang 1:1 đã chốt trước.

    Mỗi process mở PDF A/B riêng nên có PDFium riêng; không truyền bitmap qua IPC.
    Artifact được encode/ghi trong worker, process chính chỉ nhận result nhẹ để commit
    DB theo thứ tự. Hàm phải top-level để Windows ``spawn``/Nuitka pickle được.
    """
    import cv2

    from app.config import settings as worker_settings

    worker_settings.RESULTS_DIR = payload["results_dir"]
    cv2.setNumThreads(max(1, int(payload.get("cv_threads", 1))))
    processor = PDFProcessor()
    comparator = ImageComparator()
    renderer = HighlightRenderer()
    dpi = int(payload["dpi"])
    a_idx = int(payload["a_idx"])
    b_idx = int(payload["b_idx"])
    page_number = int(payload["page_number"])
    job_id = str(payload["job_id"])

    with processor.open_document(payload["file_a_path"], dpi=dpi) as doc_a, \
         processor.open_document(payload["file_b_path"], dpi=dpi) as doc_b:
        is_cmyk_mode = str(
            (payload.get("config") or {}).get("comparison_mode", "full")
        ).lower() == "cmyk"
        size_a = doc_a.page_pixel_size(a_idx)
        size_b = doc_b.page_pixel_size(b_idx)
        size_strategy = _comparison_size_strategy(size_a, size_b)
        target_size = (
            max(size_a[0], size_b[0]),
            max(size_a[1], size_b[1]),
        )
        if size_strategy == "scale":
            target_size = size_a if size_a[0] * size_a[1] >= size_b[0] * size_b[1] else size_b
        width, height = target_size

        if (
            width * height > int(payload["full_frame_pixels"])
            and size_strategy != "imposition"
        ):
            preview_dpi = max(
                18,
                min(dpi, int(dpi * 1200 / float(max(width, height)))),
            )
            with processor.open_document(
                payload["file_a_path"], dpi=preview_dpi
            ) as preview_a_doc, processor.open_document(
                payload["file_b_path"], dpi=preview_dpi
            ) as preview_b_doc:
                preview_a = preview_a_doc.render_page(a_idx)
                preview_b = preview_b_doc.render_page(b_idx)
            preview_a, preview_b = _normalize_tiled_previews(
                preview_a, preview_b, size_strategy
            )

            def read_a(x: int, y: int, tile_width: int, tile_height: int):
                return doc_a.render_page_region(
                    a_idx,
                    x_px=x,
                    y_px=y,
                    width_px=tile_width,
                    height_px=tile_height,
                )[0]

            def read_b(x: int, y: int, tile_width: int, tile_height: int):
                return doc_b.render_page_region(
                    b_idx,
                    x_px=x,
                    y_px=y,
                    width_px=tile_width,
                    height_px=tile_height,
                )[0]

            tile_size = int(payload["tile_size"])
            target_size, read_a_grid, read_b_grid, read_base_b, close_staging = (
                _prepare_tiled_size_readers(
                    read_a,
                    read_b,
                    size_a,
                    size_b,
                    size_strategy,
                    tile_size=tile_size,
                    staging_dir=(payload.get("config") or {}).get("_tile_staging_dir"),
                )
            )
            width, height = target_size
            try:
                result = comparator.compare_tiled(
                    read_a_grid,
                    read_b_grid,
                    width,
                    height,
                    tolerance=payload["tolerance"],
                    config=payload["config"],
                    tile_size=tile_size,
                    preview_img1=preview_a,
                    preview_img2=preview_b,
                    collect_diff_mask=False,
                )
                if is_cmyk_mode and size_strategy == "same" and result.diff_regions:
                    def read_cmyk_a(x: int, y: int, tile_width: int, tile_height: int):
                        cmyk = doc_a.render_page_region(
                            a_idx,
                            x_px=x,
                            y_px=y,
                            width_px=tile_width,
                            height_px=tile_height,
                            include_cmyk=True,
                        )[1]
                        assert cmyk is not None
                        return cmyk

                    def read_cmyk_b(x: int, y: int, tile_width: int, tile_height: int):
                        cmyk = doc_b.render_page_region(
                            b_idx,
                            x_px=x,
                            y_px=y,
                            width_px=tile_width,
                            height_px=tile_height,
                            include_cmyk=True,
                        )[1]
                        assert cmyk is not None
                        return cmyk

                    comparator.augment_cmyk_regions(
                        result,
                        read_cmyk_a,
                        read_cmyk_b,
                        width,
                        height,
                    )
                if result.diff_regions:
                    read_aligned_b = _aligned_tiled_reader(
                        read_base_b,
                        comparator,
                        target_size,
                        float(result.translation_x),
                        float(result.translation_y),
                    )
                    result.highlighted_artifact_url = renderer.save_tiled_highlight_image(
                        read_aligned_b,
                        result.diff_regions,
                        width,
                        height,
                        job_id,
                        page_number,
                        stripe_height=256,
                        sign_url=False,
                    )
            finally:
                close_staging()
        else:
            if is_cmyk_mode:
                image_a, cmyk_a = doc_a.render_page_bundle(a_idx, include_cmyk=True)
                image_b, cmyk_b = doc_b.render_page_bundle(b_idx, include_cmyk=True)
                assert cmyk_a is not None and cmyk_b is not None
                result = comparator.compare_cmyk(
                    cmyk_a,
                    cmyk_b,
                    tolerance=payload["tolerance"],
                    rgb_a=image_a,
                    rgb_b=image_b,
                    config=payload["config"],
                )
            else:
                image_a = doc_a.render_page(a_idx)
                image_b = doc_b.render_page(b_idx)
                result = comparator.compare(
                    image_a,
                    image_b,
                    tolerance=payload["tolerance"],
                    config=payload["config"],
                )
            result = _encode_highlight_to_png(result)
            if result.highlighted_png is not None:
                result.highlighted_artifact_url = renderer.save_highlighted_png_bytes(
                    result.highlighted_png,
                    job_id,
                    page_number,
                    sign_url=False,
                )
                result.highlighted_png = None

        if result.gif_image is not None:
            result.gif_artifact_url = renderer.save_gif_image(
                result.gif_image,
                job_id,
                page_number,
                sign_url=False,
            )
            result.gif_image = None
        result.diff_mask = None
        result.highlighted_image = None
        return result


@contextmanager
def _compare_cv_thread_budget(threads: int):
    """Tránh nested parallelism của OpenCV rồi khôi phục cấu hình process."""
    import cv2

    # cv2.setNumThreads là thiết lập toàn process. Serialize đoạn đổi/khôi phục để
    # hai lời gọi Compare trực tiếp ngoài scheduler cũng không giẫm cấu hình nhau.
    with _COMPARE_CV_THREADS_LOCK:
        previous = cv2.getNumThreads()
        cv2.setNumThreads(max(1, int(threads)))
        try:
            yield
        finally:
            cv2.setNumThreads(previous)


def _encode_highlight_to_png(result):
    """PERF (audit 2026-08-13 §PB-2): encode PNG ảnh khác biệt NGAY TRONG worker.

    Đo stage cho thấy encode+ghi PNG chiếm 15–16% sàn tuần tự main-thread của
    pipeline trên tài liệu dài; phần encode (CPU) chuyển sang worker so-ảnh, main
    thread chỉ còn ghi bytes. Byte đầu ra PHẢI trùng ``cv2.imwrite`` của đường
    tuần tự (cùng encoder libpng, cùng tham số mặc định) — bất biến này được test
    bằng SHA-256 ở test_compare_parallel_parity. Raster gốc được giải phóng ngay
    để cửa sổ inflight giữ bytes PNG nhỏ thay vì ảnh thô (giảm đỉnh RAM).
    """
    if result is None or result.highlighted_image is None:
        return result
    import cv2

    image = result.highlighted_image
    if len(image.shape) == 3 and image.shape[2] == 3:
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        # Cùng semantics với cv2.imwrite trả False ở đường tuần tự: nâng thành
        # OSError để pipeline rollback PageResult và dọn artifact dở dang.
        raise OSError("Không encode được ảnh khác biệt PNG trong worker so sánh")
    result.highlighted_png = encoded.tobytes()
    result.highlighted_image = None
    return result


class ComparisonCancelled(InterruptedError):
    """Job Compare đã nhận yêu cầu hủy cooperative."""


def _is_cancelled(cancel_check: Callable[[], bool] | None) -> bool:
    if cancel_check is None:
        return False
    try:
        return bool(cancel_check())
    except Exception:
        # Không biến lỗi ở kênh kiểm tra hủy thành kết quả Compare sai/failed.
        logger.exception("Không đọc được trạng thái hủy của job Compare")
        return False


def _raise_if_cancelled(cancel_check: Callable[[], bool] | None) -> None:
    if _is_cancelled(cancel_check):
        raise ComparisonCancelled("Đã hủy so sánh theo yêu cầu của người dùng.")


def _remove_job_artifacts(job_id: str) -> None:
    """Xóa đúng thư mục artifact của một job, không cho phép thoát RESULTS_DIR."""
    results_root = Path(settings.RESULTS_DIR).resolve()
    output_dir = (results_root / str(job_id)).resolve()
    if output_dir.parent != results_root:
        raise ValueError("Đường dẫn kết quả Compare không hợp lệ")
    if output_dir.exists():
        shutil.rmtree(output_dir)


def _prepare_clean_run(job: ComparisonJob, db: Session) -> None:
    """Retry/rerun luôn bắt đầu sạch, không nhân đôi row hoặc dùng artifact cũ."""
    db.query(PageResult).filter(PageResult.job_id == job.id).delete(
        synchronize_session=False
    )
    _remove_job_artifacts(str(job.id))
    job.progress = 0
    job.current_page = 0
    job.total_pages = None
    job.result_summary = None
    job.error_message = None
    job.status_message = None
    job.completed_at = None


def _finalize_interrupted_job(
    job_id: str,
    db: Session,
    *,
    status: str,
    message: str,
    preserve_cancelled: bool = True,
) -> ComparisonJob | None:
    """Rollback rồi dọn toàn bộ output dở dang; hàm an toàn khi gọi lặp lại."""
    try:
        db.rollback()
        db.query(PageResult).filter(PageResult.job_id == job_id).delete(
            synchronize_session=False
        )
        try:
            _remove_job_artifacts(job_id)
        except Exception:
            # Antivirus/file lock không được ngăn DB đi vào trạng thái terminal.
            # Artifact mồ côi sẽ được retry cleanup ở lần chạy lại cùng job.
            logger.exception("Chưa xóa được artifact của job Compare %s", job_id)
        job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
        if job:
            effective_status = (
                "cancelled"
                if preserve_cancelled and job.status == "cancelled"
                else status
            )
            job.status = effective_status
            job.result_summary = None
            effective_message = (
                "Đã hủy so sánh theo yêu cầu của người dùng."
                if effective_status == "cancelled"
                else message
            )
            job.status_message = effective_message
            job.error_message = message if effective_status == "failed" else None
            job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return job
    except Exception:
        db.rollback()
        logger.exception("Không dọn sạch được output dở dang của job Compare %s", job_id)
        return None


def _looks_like_document_imposition(
    doc_a,
    doc_b,
    pages_a: int,
    pages_b: int,
    config: dict,
    is_cmyk_mode: bool,
) -> bool:
    """Detect source-pages -> imposed-sheets comparison without using page order."""
    requested = str((config or {}).get("page_matching_mode", "auto") or "auto").lower()
    if requested == "imposition":
        return not is_cmyk_mode and pages_a > 0 and pages_b > 0
    if requested == "sequential" or is_cmyk_mode or pages_a < 2 or pages_b < 1:
        return False

    # Booklet output normally has fewer sheet-side pages and either more page
    # area (2-up) or a clearly different aspect (portrait pages on landscape).
    if pages_a / pages_b < 1.5:
        return False
    try:
        aw, ah = doc_a.page_size(0)
        bw, bh = doc_b.page_size(0)
        if min(aw, ah, bw, bh) <= 0:
            return False
        area_ratio = (bw * bh) / (aw * ah)
        aspect_a = aw / ah
        aspect_b = bw / bh
        aspect_ratio = max(aspect_a, aspect_b) / min(aspect_a, aspect_b)
        return area_ratio >= 1.35 or aspect_ratio >= 1.25
    except Exception as exc:
        logger.warning("Could not auto-detect imposed document: %s", exc)
        return False


def _map_source_pages_to_sheets(
    processor: PDFProcessor,
    comparator: ImageComparator,
    file_a_path: str,
    file_b_path: str,
    pages_a: int,
    pages_b: int,
    tolerance: str,
    config: dict,
    trim_insets: list,
    cancel_check: Callable[[], bool] | None = None,
    on_source_page: Callable[[int], None] | None = None,
) -> dict[int, int]:
    """Locate every source page on any imposed sheet using cheap low-DPI scans."""
    preview_dpi = max(36, min(72, int((config or {}).get("imposition_map_dpi", 48) or 48)))
    preview_config = dict(config or {})
    preview_config.update({
        "dpi": preview_dpi,
        "document_imposition_mode": True,
        "_analysis_only": True,
    })
    page_map: dict[int, int] = {}

    with processor.open_document(file_a_path, dpi=preview_dpi) as preview_a, \
         processor.open_document(file_b_path, dpi=preview_dpi) as preview_b:
        sheet_previews = []
        for i in range(pages_b):
            _raise_if_cancelled(cancel_check)
            sheet_previews.append(preview_b.render_page(i))
        for a_idx in range(pages_a):
            _raise_if_cancelled(cancel_check)
            if on_source_page is not None:
                on_source_page(a_idx)
            source_preview = preview_a.render_page(a_idx)
            page_config = dict(preview_config)
            if a_idx < len(trim_insets) and trim_insets[a_idx] is not None:
                page_config["template_trim_insets"] = trim_insets[a_idx]

            best_sheet = None
            best_rank = (-1.0, -1.0, -1)
            for b_idx, sheet_preview in enumerate(sheet_previews):
                _raise_if_cancelled(cancel_check)
                candidate = comparator.compare(
                    source_preview,
                    sheet_preview,
                    tolerance=tolerance,
                    config=page_config,
                )
                if not candidate.is_imposition_mode or candidate.total_instances <= 0:
                    continue
                rank = (
                    float(getattr(candidate, "match_confidence", 0.0)),
                    float(candidate.similarity_score),
                    int(candidate.total_instances),
                )
                if rank > best_rank:
                    best_rank = rank
                    best_sheet = b_idx

            if best_sheet is not None:
                page_map[a_idx] = best_sheet

    return page_map


def _plan_pipeline_pairs(
    doc_a,
    doc_b,
    pages_a: int,
    pages_b: int,
    work_seq: list,
    *,
    document_imposition: bool,
    use_alignment: bool,
    is_cmyk_mode: bool,
):
    """Cặp trang xác định TRƯỚC cho pipeline so-ảnh song song (§P25.1).

    Trả list ``(a_idx, b_idx_hiệu_dụng, found_b, cần_so)`` khi thứ tự ghép trang
    KHÔNG phụ thuộc kết quả so của trang trước; trả ``None`` khi phải giữ vòng
    tuần tự cũ (vòng dò tờ bình theo diện tích có thể dời con trỏ trang B).

    ``found_b`` được đóng băng đúng theo semantics của vòng tuần tự hiện hữu —
    kể cả các giá trị quirk cho trang thiếu — để kết quả parity tuyệt đối.
    """
    if document_imposition or use_alignment:
        # Cặp đã chốt sẵn từ page map / căn trang; mỗi phần tử độc lập hoàn toàn.
        pairs = []
        for a_idx, b_idx in work_seq:
            if a_idx is not None and b_idx is not None:
                pairs.append((a_idx, b_idx, b_idx, True))
            elif b_idx is not None:
                pairs.append((a_idx, b_idx, b_idx, False))
            elif document_imposition:
                pairs.append((a_idx, None, -1, False))
            else:
                # Nhánh căn trang không bao giờ dời current_b_idx (bất biến cũ = 0).
                pairs.append((a_idx, None, 0, False))
        return pairs

    if pages_b <= 0:
        return None

    if is_cmyk_mode:
        # compare_cmyk không có chế độ dò tờ bình; con trỏ B luôn tiến +1 sau mỗi
        # trang có A → tính trước được, kể cả kiểu bão hòa min(i, pages_b-1).
        pairs = []
        counter = 0
        for a_idx, _unused in work_seq:
            if a_idx is not None and a_idx < pages_a:
                eff_b = min(counter, pages_b - 1)
                pairs.append((a_idx, eff_b, eff_b, True))
                counter = eff_b + 1
            else:
                pairs.append((a_idx, None, counter, False))
        return pairs

    if pages_a != pages_b:
        # Nhánh hiếm: căn trang thất bại + lệch số trang → giữ nguyên đường cũ.
        return None

    # Nhánh thường 1:1: chỉ an toàn khi KHÔNG cặp nào có thể kích hoạt chế độ dò
    # tờ bình theo tỉ lệ diện tích (ImageComparator Case B, ngưỡng 1.8) — vì khi đó
    # con trỏ B ngừng tiến và cặp trang phụ thuộc kết quả so của trang trước.
    try:
        for i in range(pages_a):
            aw, ah = doc_a.page_size(i)
            bw, bh = doc_b.page_size(i)
            area_a = float(aw) * float(ah)
            area_b = float(bw) * float(bh)
            if area_a <= 0 or area_b <= 0:
                return None
            ratio = max(area_a, area_b) / min(area_a, area_b)
            if ratio >= _PIPELINE_AREA_RATIO_SAFETY:
                return None
    except Exception as exc:
        logger.warning("Không đọc được kích thước trang để lập pipeline: %s", exc)
        return None
    return [(i, i, i, True) for i in range(pages_a)]


def _run_comparison_pipeline_impl(
    job_id: str,
    db: Session,
    on_progress: callable = None,
    cancel_check: Callable[[], bool] | None = None,
):
    """
    Core comparison pipeline shared by both sync (DEV_MODE) and Celery (production).

    Pass/fail dựa hoàn toàn trên so pixel (ImageComparator). Không OCR / text-inject.

    Args:
        job_id: The comparison job ID.
        db: SQLAlchemy session.
        on_progress: Optional callback(job_id, progress, status, current_page, total_pages, message)
                     for real-time notifications (e.g. Redis pub/sub in production).
    """
    processor = PDFProcessor()
    comparator = ImageComparator()
    renderer = HighlightRenderer()

    def notify(progress: int, message: str = "", status: str = "processing",
               current_page: int = 0, total_pages: int = 0):
        if on_progress:
            on_progress(job_id, progress, status, current_page, total_pages, message)

    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    if not job:
        logger.error(f"Job not found: {job_id}")
        return

    if job.status == "cancelled":
        raise ComparisonCancelled("Job đã bị hủy trước khi bắt đầu.")
    _raise_if_cancelled(cancel_check)

    external_cancel_check = cancel_check
    last_db_cancel_probe = 0.0

    def cancel_requested() -> bool:
        nonlocal last_db_cancel_probe
        if _is_cancelled(external_cancel_check):
            return True
        if external_cancel_check is not None:
            return False
        # Nhánh Celery chạy khác process với API nên không dùng được registry RAM;
        # đọc riêng cột status để nhận yêu cầu hủy đã ghi vào DB, không lấy object
        # ComparisonJob đang nằm trong identity-map của session.
        import time

        now = time.monotonic()
        if now - last_db_cancel_probe < 0.1:
            return False
        last_db_cancel_probe = now
        return bool(
            db.query(ComparisonJob.status)
            .filter(ComparisonJob.id == job_id)
            .scalar()
            == "cancelled"
        )

    cancel_check = cancel_requested

    # Chuyển trạng thái bằng UPDATE có điều kiện để yêu cầu hủy từ process Celery
    # khác không bị một object SQLAlchemy cũ ghi đè ngược thành processing.
    admitted = (
        db.query(ComparisonJob)
        .filter(
            ComparisonJob.id == job_id,
            ComparisonJob.status != "cancelled",
        )
        .update(
            {
                ComparisonJob.status: "processing",
                ComparisonJob.started_at: datetime.now(timezone.utc),
            },
            synchronize_session=False,
        )
    )
    db.commit()
    if not admitted:
        raise ComparisonCancelled("Job đã bị hủy trước khi bắt đầu.")
    db.refresh(job)
    _raise_if_cancelled(cancel_check)

    # PERF (audit 2026-08-13 §PA.R3): retry/lỗi cũ không được để lại row/artifact
    # rồi trộn với lần chạy mới của cùng job.
    _prepare_clean_run(job, db)
    db.commit()
    _raise_if_cancelled(cancel_check)

    notify(0, message="Bắt đầu xử lý...")

    file_a = db.query(UploadedFile).filter(UploadedFile.id == job.file_a_id).first()
    file_b = db.query(UploadedFile).filter(UploadedFile.id == job.file_b_id).first()

    if not file_a or not file_b:
        raise ValueError("Không tìm thấy file PDF. Vui lòng upload lại.")

    config = job.config or {}
    dpi = config.get("dpi", settings.DEFAULT_DPI)
    tolerance = config.get("tolerance", "NORMAL")
    comparison_mode = config.get("comparison_mode", "full")
    is_cmyk_mode = comparison_mode == "cmyk"

    # ── Open PDF documents (no bulk conversion — memory efficient) ──
    job.progress = 5
    job.status_message = "Đang mở file PDF..."
    db.commit()
    notify(5, message="Đang mở file PDF...")
    _raise_if_cancelled(cancel_check)

    with processor.open_document(file_a.file_path, dpi=dpi) as doc_a, \
         processor.open_document(file_b.file_path, dpi=dpi) as doc_b:

        _raise_if_cancelled(cancel_check)

        pages_a = doc_a.page_count
        pages_b = doc_b.page_count
        document_imposition = _looks_like_document_imposition(
            doc_a, doc_b, pages_a, pages_b, config, is_cmyk_mode
        )
        comparison_config = dict(config)
        trim_insets_a = [None] * pages_a
        if document_imposition:
            comparison_config["document_imposition_mode"] = True
            # If TrimBox exists, use it exactly. Otherwise ignore only a small
            # outer band so MediaBox/bleed changes do not become fake artwork diffs.
            comparison_config.setdefault("imposition_bleed_ignore_ratio", 0.025)
            try:
                trim_insets_a = processor.get_trim_insets(file_a.file_path)
            except Exception as exc:
                logger.warning("Could not load source TrimBox data: %s", exc)

        total_pages = pages_a if document_imposition else max(pages_a, pages_b)
        job.total_pages = total_pages
        job.progress = 10
        job.status_message = None
        db.commit()

        notify(10, message=f"Đang so sánh {total_pages} trang...", total_pages=total_pages)
        logger.info(
            "Job %s: PDF A=%s pages, PDF B=%s pages, mode=%s",
            job_id, pages_a, pages_b,
            "document-imposition" if document_imposition else "sequential",
        )

        def _page_tile_eligible(a_idx: int, b_idx: int):
            """Lập kế hoạch tile cho 1:1 same/pad/scale; bình bài sang lô riêng."""
            if document_imposition:
                return None
            if a_idx is None or b_idx is None:
                return None
            try:
                size_a = doc_a.page_pixel_size(a_idx)
                size_b = doc_b.page_pixel_size(b_idx)
            except Exception as exc:
                logger.warning("Không đọc được kích thước raster để chọn tile: %s", exc)
                return None
            strategy = _comparison_size_strategy(size_a, size_b)
            if strategy in {"imposition", "unsupported"}:
                return None
            if strategy == "scale":
                target_size = (
                    size_a
                    if size_a[0] * size_a[1] >= size_b[0] * size_b[1]
                    else size_b
                )
            else:
                target_size = (
                    max(size_a[0], size_b[0]),
                    max(size_a[1], size_b[1]),
                )
            width, height = target_size
            if width * height <= _compare_full_frame_pixel_threshold():
                return None
            return width, height, strategy, size_a, size_b

        def _raise_if_large_page_not_tiled(a_idx: int, b_idx: int) -> None:
            """Không cho ca ngoài hợp đồng tile âm thầm quay lại full-frame rồi OOM."""
            if document_imposition:
                return
            size_a = doc_a.page_pixel_size(a_idx)
            size_b = doc_b.page_pixel_size(b_idx)
            largest = max(size_a[0] * size_a[1], size_b[0] * size_b[1])
            threshold = _compare_full_frame_pixel_threshold()
            if largest <= threshold or _page_tile_eligible(a_idx, b_idx) is not None:
                return
            raise ValueError(
                "Trang lớn vượt ngưỡng full-frame nhưng cặp hiện tại không hỗ trợ "
                "đối chiếu theo tile (bình bài/diện tích chênh từ 1,8×). "
                "Hãy chọn đúng chế độ ghép trang hoặc giảm DPI."
            )

        def _run_tiled_page(
            a_idx: int,
            b_idx: int,
            page_config: dict,
            *,
            tile_cancel_check: Callable[[], bool] | None = None,
        ):
            """Render preview + tile vùng cho một cặp 1:1 trang lớn RGB/CMYK."""
            dimensions = _page_tile_eligible(a_idx, b_idx)
            if dimensions is None:
                raise ValueError("Cặp trang không đủ điều kiện cho comparator tile")
            width, height, size_strategy, size_a, size_b = dimensions
            max_side = max(width, height)
            full_dpi = max(1, int(dpi))
            preview_dpi = max(
                18,
                min(full_dpi, int(full_dpi * 1200 / float(max_side))),
            )
            _raise_if_cancelled(cancel_check)
            with processor.open_document(file_a.file_path, dpi=preview_dpi) as preview_a_doc, \
                 processor.open_document(file_b.file_path, dpi=preview_dpi) as preview_b_doc:
                preview_a = preview_a_doc.render_page(a_idx)
                preview_b = preview_b_doc.render_page(b_idx)
            preview_a, preview_b = _normalize_tiled_previews(
                preview_a, preview_b, size_strategy
            )

            def read_a(x: int, y: int, tile_width: int, tile_height: int):
                return doc_a.render_page_region(
                    a_idx,
                    x_px=x,
                    y_px=y,
                    width_px=tile_width,
                    height_px=tile_height,
                )[0]

            def read_b(x: int, y: int, tile_width: int, tile_height: int):
                return doc_b.render_page_region(
                    b_idx,
                    x_px=x,
                    y_px=y,
                    width_px=tile_width,
                    height_px=tile_height,
                )[0]

            close_staging = lambda: None
            try:
                target_size, read_a_grid, read_b_grid, read_base_b, close_staging = (
                    _prepare_tiled_size_readers(
                        read_a,
                        read_b,
                        size_a,
                        size_b,
                        size_strategy,
                        tile_size=_compare_tile_size(),
                        staging_dir=page_config.get("_tile_staging_dir"),
                        cancel_check=tile_cancel_check,
                    )
                )
                result = comparator.compare_tiled(
                    read_a_grid,
                    read_b_grid,
                    width,
                    height,
                    tolerance=tolerance,
                    config=page_config,
                    tile_size=_compare_tile_size(),
                    preview_img1=preview_a,
                    preview_img2=preview_b,
                    collect_diff_mask=False,
                    cancel_check=tile_cancel_check,
                )
                if (
                    is_cmyk_mode
                    and size_strategy == "same"
                    and result.diff_regions
                ):
                    def read_cmyk_a(x: int, y: int, tile_width: int, tile_height: int):
                        cmyk = doc_a.render_page_region(
                            a_idx,
                            x_px=x,
                            y_px=y,
                            width_px=tile_width,
                            height_px=tile_height,
                            include_cmyk=True,
                        )[1]
                        assert cmyk is not None
                        return cmyk

                    def read_cmyk_b(x: int, y: int, tile_width: int, tile_height: int):
                        cmyk = doc_b.render_page_region(
                            b_idx,
                            x_px=x,
                            y_px=y,
                            width_px=tile_width,
                            height_px=tile_height,
                            include_cmyk=True,
                        )[1]
                        assert cmyk is not None
                        return cmyk

                    comparator.augment_cmyk_regions(
                        result,
                        read_cmyk_a,
                        read_cmyk_b,
                        width,
                        height,
                    )
                if result.diff_regions:
                    result._tile_base_reader = read_base_b
                    result._tile_cleanup = close_staging
                else:
                    close_staging()
                return result
            except InterruptedError as exc:
                close_staging()
                raise ComparisonCancelled(str(exc)) from exc
            except Exception:
                close_staging()
                raise

        def _imposition_tile_eligible(a_idx: int, b_idx: int):
            if a_idx is None or b_idx is None:
                return None
            requested_matching = str(
                (config or {}).get("page_matching_mode", "auto") or "auto"
            ).lower()
            if not document_imposition and requested_matching == "sequential":
                return None
            if not document_imposition:
                size_a = doc_a.page_pixel_size(a_idx)
                size_b = doc_b.page_pixel_size(b_idx)
                if _comparison_size_strategy(size_a, size_b) != "imposition":
                    return None
            imposed_size = doc_b.page_pixel_size(b_idx)
            if imposed_size[0] * imposed_size[1] <= _compare_full_frame_pixel_threshold():
                return None
            return imposed_size

        def _run_tiled_imposition_page(
            a_idx: int,
            b_idx: int,
            page_config: dict,
            *,
            tile_cancel_check: Callable[[], bool] | None = None,
        ):
            """Dò tờ trên preview, verify từng bản bằng ROI tờ imposed full DPI."""
            import numpy as np

            imposed_width, imposed_height = doc_b.page_pixel_size(b_idx)
            template_width, template_height = doc_a.page_pixel_size(a_idx)
            full_dpi = max(1, int(dpi))
            preview_dpi = max(
                18,
                min(
                    full_dpi,
                    int(
                        full_dpi
                        * 1200
                        / float(max(imposed_width, imposed_height))
                    ),
                ),
            )
            _raise_if_cancelled(cancel_check)
            with processor.open_document(
                file_a.file_path, dpi=preview_dpi
            ) as preview_a_doc, processor.open_document(
                file_b.file_path, dpi=preview_dpi
            ) as preview_b_doc:
                preview_template = preview_a_doc.render_page(a_idx)
                preview_imposed = preview_b_doc.render_page(b_idx)

            def read_imposed(x: int, y: int, width: int, height: int):
                return doc_b.render_page_region(
                    b_idx,
                    x_px=x,
                    y_px=y,
                    width_px=width,
                    height_px=height,
                )[0]

            cleanup = lambda: None
            template_stage = None
            try:
                if template_width * template_height > _compare_full_frame_pixel_threshold():
                    template_stage = _DiskBackedRGBRasterReader(
                        lambda x, y, width, height: doc_a.render_page_region(
                            a_idx,
                            x_px=x,
                            y_px=y,
                            width_px=width,
                            height_px=height,
                        )[0],
                        (template_width, template_height),
                        tile_size=_compare_tile_size(),
                        staging_dir=page_config.get("_tile_staging_dir"),
                        cancel_check=tile_cancel_check,
                    )
                    template = template_stage.array
                    cleanup = template_stage.close
                else:
                    template = doc_a.render_page(a_idx)

                result = comparator.compare_imposition_tiled(
                    template,
                    read_imposed,
                    imposed_width,
                    imposed_height,
                    preview_template=preview_template,
                    preview_imposed=preview_imposed,
                    tolerance=tolerance,
                    is_packaging_mode=bool(page_config.get("is_packaging_mode", False)),
                    config=page_config,
                    cancel_check=tile_cancel_check,
                )
                result._tile_base_reader = read_imposed
                result._tile_cleanup = cleanup
                return result
            except InterruptedError as exc:
                cleanup()
                raise ComparisonCancelled(str(exc)) from exc
            except Exception:
                cleanup()
                raise

        imposition_page_map: dict[int, int] = {}
        if document_imposition:
            # PERF (audit 2026-08-13 §PB-3): chặn bùng nổ O(A×B) của bước dò bình bài
            # TRƯỚC khi render preview. Job vượt trần fail ngay với hướng dẫn rõ thay
            # vì chạy hàng giờ không tiến triển (watchdog UI sẽ hủy oan giữa chừng).
            map_cells = pages_a * pages_b
            max_map_cells = _max_imposition_map_cells()
            if map_cells > max_map_cells:
                raise ValueError(
                    f"Tài liệu quá dài cho chế độ so bình bài: {pages_a} trang nguồn × "
                    f"{pages_b} tờ bình = {map_cells} lượt dò, vượt trần {max_map_cells}. "
                    "Vui lòng chia nhỏ file theo từng bộ bình, hoặc chọn chế độ ghép "
                    "trang tuần tự nếu hai file cùng thứ tự trang. Người vận hành có "
                    "thể nới trần qua biến môi trường PRYNX_MAX_IMPOSITION_MAP_CELLS."
                )

            # PERF (audit 2026-08-13 §PB-3): bước dò có thể chạy nhiều phút mà không
            # chạm DB → UI local (đọc tiến độ qua DB) và watchdog theo tiến độ sẽ
            # tưởng job treo. Cập nhật status_message theo nhịp ≤1 s giữ tín hiệu sống.
            map_message = "Đang nhận diện thứ tự trang trên các tờ bình..."
            job.status_message = map_message
            db.commit()
            notify(10, message=map_message, total_pages=pages_a)
            last_map_report = time.monotonic()

            def _report_map_progress(source_idx: int) -> None:
                nonlocal last_map_report
                now = time.monotonic()
                if now - last_map_report < _MAP_PROGRESS_MIN_INTERVAL_S:
                    return
                last_map_report = now
                message = f"Đang định vị trang nguồn {source_idx + 1}/{pages_a} trên các tờ bình..."
                job.status_message = message
                db.commit()
                notify(10, message=message, total_pages=pages_a)

            imposition_page_map = _map_source_pages_to_sheets(
                processor,
                comparator,
                file_a.file_path,
                file_b.file_path,
                pages_a,
                pages_b,
                tolerance,
                comparison_config,
                trim_insets_a,
                cancel_check,
                on_source_page=_report_map_progress,
            )
            # Dò xong: trả status_message về rỗng để UI quay lại hiển thị
            # "Đang so sánh trang X/Y" theo current_page như đường thường.
            job.status_message = None
            db.commit()
            logger.info(
                "Job %s: mapped %s/%s source pages to imposed sheets",
                job_id, len(imposition_page_map), pages_a,
            )

        # ── Compare page by page (10-90%) ──
        # Each iteration: render 1 page from A + 1 page from B → compare → save → discard
        # RAM KHÔNG tích luỹ tuyến tính theo SỐ TRANG (page A/B được giải phóng mỗi
        # vòng), NHƯNG đỉnh per-page CAO và tỉ lệ với render DPI × kích thước trang:
        # đo thực tế trang ảnh 1500px @150dpi (full RGB + CMYK + SSIM + diff) đạt đỉnh
        # ~0.5–0.7GB và ~0.5s/trang. PERF (audit 2026-08-13 §PB-1/§PB-3): route compare
        # giữ trần trang (mặc định 1.000, env PRYNX_MAX_COMPARE_PAGES) + admission đĩa
        # artifact; hai guard đó chặn bùng nổ theo số trang nhưng KHÔNG giảm đỉnh
        # per-page → máy RAM thấp cần cân nhắc DPI.
        pages_pass = pages_fail = pages_warning = 0
        total_diff_count = 0
        total_similarity = 0.0

        total_imposition_instances = 0
        failed_imposition_instances = 0

        # ── Căn trang theo NỘI DUNG khi 2 file LỆCH SỐ TRANG (chèn/xoá) ──
        # An toàn: CHỈ bật khi pages_a != pages_b và KHÔNG phải CMYK. Số trang bằng
        # nhau → giữ nguyên ghép tuần tự + hunting imposition như cũ (không đổi hành
        # vi đường phổ biến). Lỗi bất kỳ ở bước căn → fallback ghép tuần tự.
        use_alignment = (not document_imposition) and (pages_a != pages_b) and (not is_cmyk_mode) and pages_a > 0 and pages_b > 0
        align_pairs = None
        if use_alignment:
            try:
                import numpy as _np
                import cv2 as _cv2
                from app.core.page_aligner import (
                    align_pages, thumbnail_similarity, text_similarity, normalize_text,
                )

                def _fingerprints(path, n):
                    sigs = []
                    for p in range(1, n + 1):
                        _raise_if_cancelled(cancel_check)
                        im = processor.convert_single_page(path, p, dpi=36)
                        if im is None:
                            sigs.append(_np.zeros((32, 32), dtype=_np.uint8))
                            continue
                        g = _cv2.cvtColor(im, _cv2.COLOR_RGB2GRAY) if getattr(im, "ndim", 2) == 3 else im
                        sigs.append(_cv2.resize(g, (32, 32), interpolation=_cv2.INTER_AREA))
                    return sigs

                def _page_texts(path, n):
                    """Text chuẩn hoá mỗi trang (rỗng nếu trang ảnh/không có text)."""
                    out = []
                    for p in range(1, n + 1):
                        _raise_if_cancelled(cancel_check)
                        try:
                            blocks = processor.extract_text_blocks(path, p)
                            t = " ".join(b.get("text", "") for b in blocks)
                        except Exception:
                            t = ""
                        out.append(normalize_text(t))
                    return out

                _sig_a = _fingerprints(file_a.file_path, pages_a)
                _sig_b = _fingerprints(file_b.file_path, pages_b)
                _txt_a = _page_texts(file_a.file_path, pages_a)
                _txt_b = _page_texts(file_b.file_path, pages_b)

                def _sim(i, j):
                    # Hình thu nhỏ + (nếu CẢ HAI trang đủ chữ) text-hash. Tài liệu nhiều
                    # chữ trông na ná nhau → text giúp ghép đúng; trang ảnh → chỉ dùng hình.
                    vis = thumbnail_similarity(_sig_a[i], _sig_b[j])
                    ta, tb = _txt_a[i], _txt_b[j]
                    if len(ta) >= 20 and len(tb) >= 20:
                        return 0.5 * vis + 0.5 * text_similarity(ta, tb)
                    return vis

                align_pairs = align_pages(pages_a, pages_b, _sim)
                logger.info(f"Job {job_id}: căn trang BẬT ({pages_a}≠{pages_b} trang) → {len(align_pairs)} mục")
            except Exception as e:
                logger.warning(f"Job {job_id}: căn trang lỗi, fallback ghép tuần tự: {e}")
                align_pairs = None
                use_alignment = False

        if document_imposition:
            use_alignment = False
            work_seq = [(i, imposition_page_map.get(i)) for i in range(pages_a)]
        elif use_alignment and align_pairs is not None:
            work_seq = align_pairs
        else:
            use_alignment = False
            work_seq = [(i, None) for i in range(total_pages)]
        total_work = len(work_seq) or 1
        page_mapping: list[int | None] = [None] * pages_a

        # PERF (audit 2026-08-13 §P25.1): render giữ khóa PDFium nên buộc tuần tự
        # trong một process, nhưng so ảnh + encode kết quả (OpenCV/NumPy — đo được
        # ~66% + 4,8% thời gian job) không cần khóa. Khi cặp trang xác định được
        # TRƯỚC, phần so ảnh được đẩy sang pool thread; máy <8 GB (planner trả
        # 1 worker) giữ nguyên đường tuần tự cũ — đúng rule "máy yếu mới giảm,
        # máy mạnh chạy hết công suất". `PRYNX_COMPARE_WORKERS` ghi đè được.
        compare_workers, compare_workers_reason = plan_worker_count(
            kind="compare-pages",
            per_worker_mb=640.0,
            env_override="PRYNX_COMPARE_WORKERS",
        )
        process_worker_env = (
            "PRYNX_COMPARE_PROCESS_WORKERS"
            if os.environ.get("PRYNX_COMPARE_PROCESS_WORKERS", "")
            else "PRYNX_COMPARE_WORKERS"
        )
        process_workers, process_workers_reason = plan_worker_count(
            kind="compare-render-processes",
            per_worker_mb=640.0,
            env_override=process_worker_env,
        )
        pipeline_pairs = None
        if max(compare_workers, process_workers) >= 2 and len(work_seq) >= 2:
            pipeline_pairs = _plan_pipeline_pairs(
                doc_a, doc_b, pages_a, pages_b, work_seq,
                document_imposition=document_imposition,
                use_alignment=use_alignment,
                is_cmyk_mode=is_cmyk_mode,
            )
            if pipeline_pairs is not None:
                logger.info(
                    "Job %s: pipeline so sánh %d trang với %d worker so-ảnh (%s)",
                    job_id, len(work_seq), compare_workers, compare_workers_reason,
                )
        use_process_pipeline = bool(
            pipeline_pairs is not None
            and process_workers >= 2
            and len(pipeline_pairs) >= _compare_process_min_pages()
            and not document_imposition
            and not use_alignment
            and pages_a == pages_b
        )
        if use_process_pipeline:
            try:
                process_pixels = 0
                for a_idx, b_idx, _found_b, needs_compare in pipeline_pairs:
                    if not needs_compare or a_idx is None or b_idx is None:
                        use_process_pipeline = False
                        break
                    size_a = doc_a.page_pixel_size(a_idx)
                    size_b = doc_b.page_pixel_size(b_idx)
                    size_strategy = _comparison_size_strategy(size_a, size_b)
                    if size_strategy in {"imposition", "unsupported"}:
                        use_process_pipeline = False
                        break
                    if size_strategy == "scale":
                        target_size = (
                            size_a
                            if size_a[0] * size_a[1] >= size_b[0] * size_b[1]
                            else size_b
                        )
                    else:
                        target_size = (
                            max(size_a[0], size_b[0]),
                            max(size_a[1], size_b[1]),
                        )
                    process_pixels = max(
                        process_pixels,
                        target_size[0] * target_size[1],
                    )
            except Exception as exc:
                logger.warning(
                    "Không đọc được pixel trang để admission process Compare: %s",
                    exc,
                )
                process_pixels = 0
            use_process_pipeline = (
                use_process_pipeline
                and process_pixels >= _compare_process_min_pixels()
            )
        if use_process_pipeline:
            logger.info(
                "Job %s: render + compare 1:1 đa tiến trình với %d worker (%s)",
                job_id,
                min(process_workers, len(pipeline_pairs)),
                process_workers_reason,
            )

        def _sequential_outcomes():
            """Đường tuần tự NGUYÊN BẢN — dùng cho máy yếu và các ca ghép trang
            phụ thuộc kết quả so của trang trước (vòng dò tờ bình theo diện tích)."""
            current_b_idx = 0
            for out_idx, (a_idx, b_idx) in enumerate(work_seq):
                _raise_if_cancelled(cancel_check)
                tile_b_idx = b_idx if b_idx is not None else current_b_idx
                tile_page_config = dict(comparison_config)
                if document_imposition and a_idx is not None and a_idx < len(trim_insets_a):
                    if trim_insets_a[a_idx] is not None:
                        tile_page_config["template_trim_insets"] = trim_insets_a[a_idx]
                imposition_dimensions = (
                    _imposition_tile_eligible(a_idx, tile_b_idx)
                    if a_idx is not None and 0 <= a_idx < pages_a
                    and 0 <= tile_b_idx < pages_b
                    else None
                )
                if imposition_dimensions is not None:
                    result = _run_tiled_imposition_page(
                        a_idx,
                        tile_b_idx,
                        tile_page_config,
                        tile_cancel_check=cancel_check,
                    )
                    found_b_idx = tile_b_idx
                    yield out_idx, a_idx, b_idx, found_b_idx, result
                    continue
                tile_dimensions = (
                    _page_tile_eligible(a_idx, tile_b_idx)
                    if a_idx is not None and 0 <= a_idx < pages_a
                    and 0 <= tile_b_idx < pages_b
                    else None
                )
                if tile_dimensions is not None:
                    result = _run_tiled_page(
                        a_idx,
                        tile_b_idx,
                        tile_page_config,
                        tile_cancel_check=cancel_check,
                    )
                    found_b_idx = tile_b_idx
                    if not use_alignment:
                        current_b_idx = found_b_idx + 1
                    yield out_idx, a_idx, b_idx, found_b_idx, result
                    continue
                if (
                    a_idx is not None and 0 <= a_idx < pages_a
                    and 0 <= tile_b_idx < pages_b
                ):
                    _raise_if_large_page_not_tiled(a_idx, tile_b_idx)

                # Render page A (None nếu không có A — vd trang chỉ được THÊM ở B)
                cmyk_a = None
                if a_idx is not None and a_idx < pages_a:
                    if is_cmyk_mode:
                        img_a, cmyk_a = doc_a.render_page_bundle(a_idx, include_cmyk=True)
                    else:
                        img_a = doc_a.render_page(a_idx)
                else:
                    img_a = None

                img_b = None
                found_b_idx = b_idx if b_idx is not None else (-1 if document_imposition else current_b_idx)
                result = None
                page_config = dict(comparison_config)
                if document_imposition and a_idx is not None and a_idx < len(trim_insets_a):
                    if trim_insets_a[a_idx] is not None:
                        page_config["template_trim_insets"] = trim_insets_a[a_idx]

                if document_imposition:
                    # Booklet/N-up order is non-linear: compare the source page with
                    # the sheet found by the low-DPI global search, never by index.
                    if a_idx is not None and b_idx is not None:
                        _raise_if_cancelled(cancel_check)
                        img_b = doc_b.render_page(b_idx)
                        result = comparator.compare(
                            img_a, img_b, tolerance=tolerance, config=page_config
                        )
                elif use_alignment:
                    # Cặp trang đã được căn theo nội dung → so 1:1 đúng cặp. Trang thêm/xoá
                    # (a_idx hoặc b_idx = None) rơi vào nhánh "missing" với nhãn rõ ràng.
                    if a_idx is not None and b_idx is not None:
                        _raise_if_cancelled(cancel_check)
                        img_b = doc_b.render_page(b_idx)
                        result = comparator.compare(img_a, img_b, tolerance=tolerance, config=page_config)
                elif is_cmyk_mode and img_a is not None and pages_b > 0:
                    _raise_if_cancelled(cancel_check)
                    # ── CMYK Channel-by-Channel Comparison ──
                    b_idx = min(current_b_idx, pages_b - 1)
                    img_b, cmyk_b = doc_b.render_page_bundle(b_idx, include_cmyk=True)
                    found_b_idx = b_idx
                    result = comparator.compare_cmyk(
                        cmyk_a, cmyk_b, tolerance=tolerance,
                        rgb_a=img_a, rgb_b=img_b, config=page_config,
                    )
                    # CĂN TRANG 1:1: tiến con trỏ B sang trang kế (giống nhánh thường) —
                    # CMYK luôn so theo cặp trang, không có chế độ imposition.
                    current_b_idx = found_b_idx + 1
                elif img_a is not None and pages_b > 0:
                    for b_idx in range(current_b_idx, pages_b):
                        _raise_if_cancelled(cancel_check)
                        test_b = doc_b.render_page(b_idx)
                        temp_result = comparator.compare(img_a, test_b, tolerance=tolerance, config=page_config)

                        if getattr(temp_result, "is_imposition_mode", False):
                            if temp_result.similarity_score > 0.0:
                                img_b = test_b
                                found_b_idx = b_idx
                                result = temp_result
                                break
                        else:
                            img_b = test_b
                            found_b_idx = b_idx
                            result = temp_result
                            break

                    if img_b is None:
                        img_b = doc_b.render_page(current_b_idx)
                        result = comparator.compare(img_a, img_b, tolerance=tolerance, config=page_config)
                    else:
                        # CĂN TRANG 1:1 (sửa lỗi pin-về-B[0]): chế độ thường so A[i] với B[i],
                        # nên sau khi khớp phải TIẾN con trỏ sang trang B kế tiếp. Trước đây
                        # `current_b_idx = found_b_idx` (thiếu +1) khiến mọi trang A đều so với
                        # cùng một trang B (B[0]) → báo khác biệt giả ở mọi trang sau trang 1.
                        # Chế độ imposition (1 mẫu ↔ tờ N-up) GIỮ NGUYÊN: không tiến con trỏ vì
                        # nhiều mẫu có thể nằm trên cùng một tờ.
                        if getattr(result, "is_imposition_mode", False):
                            current_b_idx = found_b_idx
                        else:
                            current_b_idx = found_b_idx + 1

                yield out_idx, a_idx, b_idx, found_b_idx, result

        def _pipelined_outcomes(pairs):
            """Render tuần tự (khóa PDFium) trên thread này; so ảnh chạy trong pool.

            Kết quả được trả ĐÚNG THỨ TỰ trang. Mỗi future tự giữ ảnh đầu vào trong
            closure và giải phóng chúng ngay khi compare xong; hàng đợi ngoài chỉ giữ
            future. Cửa sổ không vượt số worker và drain ngay trang đầu để UI/RAM không
            bị độ trễ nạp trước `workers + 2` trang như phiên bản P-A ban đầu.
            """
            from app.core.gpu_accelerator import GPUAccelerator

            # Khởi tạo singleton trên thread chính — tránh race khởi tạo khi
            # nhiều worker cùng gọi get_instance() lần đầu.
            GPUAccelerator.get_instance()

            # PERF (audit 2026-08-13 §PA-2): OpenCV mặc định tự mở toàn bộ 16
            # thread CHO MỖI phép so, trong khi pipeline đã có tới CPU-1 phép so
            # đồng thời → oversubscribe hàng trăm native thread, gây dao động/treo.
            # Chỉ chỉnh khi pipeline đa worker; đường tuần tự giữ nguyên OpenCV full.
            raw_cv_threads = os.environ.get("PRYNX_COMPARE_CV_THREADS", "")
            try:
                pipeline_cv_threads = max(1, int(raw_cv_threads)) if raw_cv_threads else 1
            except (TypeError, ValueError):
                pipeline_cv_threads = 1
            inflight_limit = compare_workers
            startup_window = min(inflight_limit, 4)
            pending: deque = deque()
            first_page_reported = False

            def _submit(pool, a_idx, eff_b_idx):
                _raise_if_cancelled(cancel_check)
                page_config = dict(comparison_config)
                if document_imposition and a_idx < len(trim_insets_a):
                    if trim_insets_a[a_idx] is not None:
                        page_config["template_trim_insets"] = trim_insets_a[a_idx]
                if (
                    a_idx is not None
                    and eff_b_idx is not None
                    and _page_tile_eligible(a_idx, eff_b_idx) is not None
                ):
                    # PDFium calls remain guarded inside render_page_region. The
                    # worker receives only page indexes/paths through the closure;
                    # no full bitmap is copied into the pool.
                    return pool.submit(
                        _run_tiled_page,
                        a_idx,
                        eff_b_idx,
                        page_config,
                        tile_cancel_check=external_cancel_check,
                    )
                _raise_if_large_page_not_tiled(a_idx, eff_b_idx)
                if is_cmyk_mode:
                    img_a, cmyk_a = doc_a.render_page_bundle(a_idx, include_cmyk=True)
                    img_b, cmyk_b = doc_b.render_page_bundle(eff_b_idx, include_cmyk=True)
                    def compare_page():
                        return _encode_highlight_to_png(comparator.compare_cmyk(
                            cmyk_a, cmyk_b, tolerance=tolerance,
                            rgb_a=img_a, rgb_b=img_b, config=page_config,
                        ))
                else:
                    img_a = doc_a.render_page(a_idx)
                    img_b = doc_b.render_page(eff_b_idx)
                    def compare_page():
                        return _encode_highlight_to_png(comparator.compare(
                            img_a, img_b, tolerance=tolerance, config=page_config
                        ))

                future = pool.submit(compare_page)
                return future

            def _drain():
                out_idx, a_idx, b_idx, found_b, future = pending.popleft()
                if future is None:
                    return out_idx, a_idx, b_idx, found_b, None
                while True:
                    _raise_if_cancelled(cancel_check)
                    try:
                        result = future.result(timeout=0.05)
                        return out_idx, a_idx, b_idx, found_b, result
                    except FutureTimeoutError:
                        continue

            resources = ExitStack()
            pool = None
            try:
                resources.enter_context(
                    _compare_cv_thread_budget(pipeline_cv_threads)
                )
                pool = ThreadPoolExecutor(
                    max_workers=compare_workers, thread_name_prefix="prynx-cmp-page"
                )
                for out_idx, (a_idx, eff_b_idx, found_b, needs_compare) in enumerate(pairs):
                    _raise_if_cancelled(cancel_check)
                    orig_a, orig_b = work_seq[out_idx]
                    future = _submit(pool, a_idx, eff_b_idx) if needs_compare else None
                    pending.append((out_idx, orig_a, orig_b, found_b, future))

                    # PERF (audit 2026-08-13 §PA.R1/PA-2): trong lúc trang 1 đang so,
                    # render trước một cửa sổ NHỎ (tối đa 4) rồi drain ngay khi future
                    # đầu đã xong. Cách này giữ first-page thấp nhưng không làm pipeline
                    # khởi động tuần tự. Sau trang đầu, cửa sổ tối đa đúng `workers`.
                    first_future = pending[0][-1]
                    first_ready = first_future is None or first_future.done()
                    should_drain_startup = (
                        not first_page_reported
                        and (first_ready or len(pending) >= startup_window)
                    )
                    if should_drain_startup or len(pending) >= inflight_limit:
                        yield _drain()
                        first_page_reported = True
                while pending:
                    yield _drain()
            except ComparisonCancelled:
                _finalize_interrupted_job(
                    job_id,
                    db,
                    status="cancelled",
                    message="Đã hủy so sánh theo yêu cầu của người dùng.",
                )
                raise
            except Exception as exc:
                # Ghi trạng thái lỗi trước khi chờ các phép OpenCV đang chạy tự kết
                # thúc; UI không phải đợi cả cửa sổ worker mới biết job đã hỏng.
                _finalize_interrupted_job(
                    job_id, db, status="failed", message=str(exc),
                )
                raise
            finally:
                for item in pending:
                    if item[-1] is not None:
                        item[-1].cancel()
                # Task OpenCV đang chạy không thể kill an toàn giữa hàm. Giữ slot job
                # tới khi chúng tự kết thúc để không cho retry/job kế tiếp chồng thêm
                # một pool mới; task chưa chạy bị hủy ngay.
                if pool is not None:
                    pool.shutdown(wait=True, cancel_futures=True)
                resources.close()

        def _multiprocess_outcomes(pairs):
            """Render + compare + encode trong process; trả kết quả đúng thứ tự."""
            raw_cv_threads = os.environ.get("PRYNX_COMPARE_CV_THREADS", "")
            try:
                process_cv_threads = max(1, int(raw_cv_threads)) if raw_cv_threads else 1
            except (TypeError, ValueError):
                process_cv_threads = 1
            worker_count = min(process_workers, len(pairs))
            pending: deque = deque()
            pool = None

            def _drain():
                out_idx, orig_a, orig_b, found_b, future = pending.popleft()
                while True:
                    _raise_if_cancelled(cancel_check)
                    try:
                        result = future.result(timeout=0.05)
                        return out_idx, orig_a, orig_b, found_b, result
                    except FutureTimeoutError:
                        continue

            try:
                pool = ProcessPoolExecutor(
                    max_workers=worker_count,
                    mp_context=multiprocessing.get_context("spawn"),
                )
                for out_idx, (a_idx, eff_b_idx, found_b, needs_compare) in enumerate(pairs):
                    _raise_if_cancelled(cancel_check)
                    if not needs_compare or a_idx is None or eff_b_idx is None:
                        raise ValueError("Pipeline process 1:1 nhận cặp trang không hợp lệ")
                    payload = {
                        "file_a_path": file_a.file_path,
                        "file_b_path": file_b.file_path,
                        "a_idx": a_idx,
                        "b_idx": eff_b_idx,
                        "dpi": dpi,
                        "tolerance": tolerance,
                        "config": dict(comparison_config),
                        "full_frame_pixels": _compare_full_frame_pixel_threshold(),
                        "tile_size": _compare_tile_size(),
                        "cv_threads": process_cv_threads,
                        "results_dir": str(Path(settings.RESULTS_DIR).resolve()),
                        "job_id": str(job_id),
                        "page_number": out_idx + 1,
                    }
                    future = pool.submit(_compare_page_process_worker, payload)
                    orig_a, orig_b = work_seq[out_idx]
                    pending.append((out_idx, orig_a, orig_b, found_b, future))
                    if len(pending) >= worker_count:
                        yield _drain()
                while pending:
                    yield _drain()
            finally:
                for item in pending:
                    item[-1].cancel()
                if pool is not None:
                    pool.shutdown(wait=True, cancel_futures=True)

        if use_process_pipeline:
            outcomes = _multiprocess_outcomes(pipeline_pairs)
        elif pipeline_pairs is not None and compare_workers >= 2:
            outcomes = _pipelined_outcomes(pipeline_pairs)
        else:
            outcomes = _sequential_outcomes()

        # PERF (audit 2026-08-13 §PB-2): gộp commit theo lô nhỏ. Hủy/lỗi giữa lô
        # an toàn: phần chưa commit bị rollback trong _finalize_interrupted_job,
        # artifact đã ghi được dọn cùng chỗ (job hủy/lỗi luôn xóa toàn bộ output).
        pages_since_commit = 0
        last_commit_at = time.perf_counter()

        def _commit_page_batch(force: bool = False) -> None:
            nonlocal pages_since_commit, last_commit_at
            if pages_since_commit == 0:
                return
            if (
                not force
                and pages_since_commit < _COMPARE_COMMIT_BATCH_PAGES
                and time.perf_counter() - last_commit_at < _COMPARE_COMMIT_MAX_LAG_S
            ):
                return
            db.commit()
            pages_since_commit = 0
            last_commit_at = time.perf_counter()

        for out_idx, a_idx, b_idx, found_b_idx, result in outcomes:
            _raise_if_cancelled(cancel_check)
            page_num = out_idx + 1
            progress = 10 + int((out_idx / total_work) * 80)

            notify(progress, current_page=page_num, total_pages=total_work,
                   message=f"Đang so sánh trang {page_num}/{total_work}...")

            # PIXEL-ONLY: không OCR / không text-inject. Pass/fail = ImageComparator.

            # Handle missing pages (out-of-range positional, hoặc trang thêm/xoá khi căn trang)
            if result is None:
                if document_imposition and a_idx is not None:
                    miss_desc = (
                        f"Kh\u00f4ng t\u00ecm th\u1ea5y trang ngu\u1ed3n {a_idx + 1} tr\u00ean b\u1ea5t k\u1ef3 t\u1edd b\u00ecnh n\u00e0o"
                    )
                elif use_alignment and a_idx is None and b_idx is not None:
                    miss_desc = f"Trang được THÊM (chỉ có ở bản sửa — trang {b_idx + 1})"
                elif use_alignment and b_idx is None and a_idx is not None:
                    miss_desc = f"Trang bị XOÁ (chỉ có ở bản gốc — trang {a_idx + 1})"
                else:
                    miss_desc = "Trang bị thiếu"
                page_result = PageResult(
                    job_id=job.id, page_number=page_num, status="fail",
                    similarity_score=0.0, diff_count=1,
                    diff_regions=[{
                        "description": miss_desc, "severity": "high",
                        "type": "layout", "x": 0, "y": 0,
                        "width": 1, "height": 1, "b_page": (found_b_idx + 1) if found_b_idx >= 0 else None,
                        "nx": 0, "ny": 0, "nw": 1, "nh": 1,
                    }],
                    highlighted_image_path=None,
                    gif_image_path=None,
                    is_imposition_mode=document_imposition,
                )
                db.add(page_result)
                pages_fail += 1
                total_diff_count += 1
                job.current_page = page_num
                job.progress = progress
                _raise_if_cancelled(cancel_check)
                pages_since_commit += 1
                _commit_page_batch()
                continue

            if a_idx is not None and 0 <= a_idx < len(page_mapping) and found_b_idx >= 0:
                page_mapping[a_idx] = found_b_idx + 1

            # Save highlighted image and GIF
            highlighted_url = None
            gif_url = None

            if getattr(result, "highlighted_artifact_url", None) is not None:
                # Worker process không có sidecar token; chỉ process chính ký URL.
                from app.core.license_guard import result_access_url

                highlighted_url = result_access_url(result.highlighted_artifact_url)
            elif (
                getattr(result, "is_tiled", False)
                and (
                    result.diff_regions
                    or getattr(result, "_imposition_tracking_boxes", None)
                )
                and found_b_idx >= 0
            ):
                _raise_if_cancelled(cancel_check)
                tile_cleanup = getattr(result, "_tile_cleanup", None)
                try:
                    base_reader = getattr(result, "_tile_base_reader", None)
                    if base_reader is None:
                        base_reader = lambda x, y, tile_width, tile_height: (
                            doc_b.render_page_region(
                                found_b_idx,
                                x_px=x,
                                y_px=y,
                                width_px=tile_width,
                                height_px=tile_height,
                            )[0]
                        )
                    aligned_reader = _aligned_tiled_reader(
                        base_reader,
                        comparator,
                        (int(result.render_w), int(result.render_h)),
                        float(getattr(result, "translation_x", 0.0)),
                        float(getattr(result, "translation_y", 0.0)),
                    )
                    highlighted_url = renderer.save_tiled_highlight_image(
                        aligned_reader,
                        result.diff_regions,
                        int(result.render_w),
                        int(result.render_h),
                        str(job_id),
                        page_num,
                        stripe_height=256,
                        cancel_check=cancel_check,
                        tracking_boxes=getattr(
                            result, "_imposition_tracking_boxes", None
                        ),
                        imposition_mode=bool(
                            getattr(result, "is_imposition_mode", False)
                        ),
                    )
                except InterruptedError as exc:
                    raise ComparisonCancelled(str(exc)) from exc
                finally:
                    if callable(tile_cleanup):
                        tile_cleanup()
                        result._tile_cleanup = None
                        result._tile_base_reader = None
            elif getattr(result, "highlighted_png", None) is not None:
                # PERF (audit 2026-08-13 §PB-2): pipeline đã encode PNG trong
                # worker — main thread chỉ ghi bytes (nhanh hơn ~10× encode).
                _raise_if_cancelled(cancel_check)
                highlighted_url = renderer.save_highlighted_png_bytes(
                    result.highlighted_png, str(job_id), page_num
                )
            elif result.highlighted_image is not None:
                _raise_if_cancelled(cancel_check)
                highlighted_url = renderer.save_highlighted_image(
                    result.highlighted_image, str(job_id), page_num
                )
            if getattr(result, "gif_artifact_url", None) is not None:
                from app.core.license_guard import result_access_url

                gif_url = result_access_url(result.gif_artifact_url)
            elif result.gif_image is not None:
                _raise_if_cancelled(cancel_check)
                gif_url = renderer.save_gif_image(
                    result.gif_image, str(job_id), page_num
                )

            # Determine page status — chuẩn IN ẤN, không chuẩn "giống % pixel".
            # SSIM/px% chỉ mô tả mức giống HÌNH toàn trang (tham khảo). Sai 1 chữ
            # trên nhãn vẫn SSIM ~99.9% nhưng là LỖI NGHIÊM TRỌNG → luôn FAIL khi
            # đã có vùng khác (sau lọc nhiễu). Không còn hạ severity xuống warning
            # chỉ vì vùng nhỏ / SSIM cao.
            if result.diff_count == 0:
                status = "pass"
                pages_pass += 1
            else:
                for region in result.diff_regions:
                    # Mọi khác biệt nội dung thật đều high cho QA in (kể cả micro-glyph).
                    if region.severity == "low":
                        region.severity = "high"
                    if region.type in ("image", "") and (
                        (region.description or "").startswith("Thay đổi nhỏ")
                        or (region.description or "").startswith("Vùng thay đổi")
                    ):
                        # Không có nhãn text: vẫn coi là lỗi in cần xử lý.
                        region.severity = "high"
                status = "fail"
                pages_fail += 1

            # Normalize diff regions for frontend
            # Dùng KÍCH THƯỚC RENDER của kết quả (có thể khác img_b gốc khi đã co giãn
            # Case A) để toạ độ chuẩn hoá luôn khớp vùng khác biệt (tránh lệch toạ độ).
            h = int(result.render_h)
            w = int(result.render_w)
            if h <= 0 or w <= 0:
                raise ValueError("Kết quả so sánh không có kích thước render hợp lệ")
            diff_regions_normalized = renderer.generate_diff_overlay_data(
                result.diff_regions, w, h
            )
            diff_regions_data = []
            for i, region in enumerate(result.diff_regions):
                nx = diff_regions_normalized[i]["x"]
                ny = diff_regions_normalized[i]["y"]

                vertical = "Góc trên" if ny < 0.33 else "Góc dưới" if ny > 0.67 else "Giữa"
                horizontal = "bên trái" if nx < 0.33 else "bên phải" if nx > 0.67 else "trung tâm"
                spatial_desc = f"{vertical} {horizontal}"

                # Use the region's existing description if it's meaningful (Text/CMYK), 
                # otherwise fall back to the spatial heuristic.
                has_custom_desc = region.description and not region.description.startswith("Lỗi kênh màu CMYK") and region.description != "Phát hiện khác biệt"
                final_desc = region.description if has_custom_desc else spatial_desc

                diff_regions_data.append({
                    "x": region.x, "y": region.y,
                    "width": region.width, "height": region.height,
                    "type": region.type, "severity": region.severity,
                    "description": final_desc,
                    "nx": nx, "ny": ny,
                    "nw": diff_regions_normalized[i]["width"],
                    "nh": diff_regions_normalized[i]["height"],
                    "b_page": (found_b_idx + 1) if found_b_idx >= 0 else None,
                })

            total_diff_count += result.diff_count
            total_similarity += result.similarity_score
            total_imposition_instances += getattr(result, "total_instances", 0)
            failed_imposition_instances += getattr(result, "failed_instances", 0)

            # Save page result
            page_result = PageResult(
                job_id=job.id, page_number=page_num, status=status,
                similarity_score=result.similarity_score,
                diff_count=result.diff_count,
                diff_regions=diff_regions_data,
                highlighted_image_path=highlighted_url,
                gif_image_path=gif_url,
                is_imposition_mode=getattr(result, "is_imposition_mode", False),
            )
            db.add(page_result)

            job.current_page = page_num
            job.progress = progress
            _raise_if_cancelled(cancel_check)
            pages_since_commit += 1
            _commit_page_batch()

            # result được ghi xong rồi giải phóng ở vòng kế; raster đầu vào đã được
            # closure trong worker giải phóng ngay khi future hoàn tất.

        # Chốt lô cuối để mọi PageResult bền vững trước khi sang giai đoạn tổng hợp.
        _commit_page_batch(force=True)

    # ── Generate summary (90-100%) ──
    _raise_if_cancelled(cancel_check)
    notify(92, message="Đang tạo báo cáo tổng hợp...")

    llm_warnings = []
    # Legacy LLM integration removed. QC is now handled by the standalone /qc/check-text endpoint.

    avg_similarity = total_similarity / total_pages if total_pages > 0 else 100.0
    # SSIM = độ giống HÌNH (tham khảo). Verdict in ấn = có/không lỗi.
    print_ok = (pages_fail == 0 and pages_warning == 0 and total_diff_count == 0)
    if print_ok:
        verdict_detail = "Không phát hiện khác biệt pixel — ĐẠT kiểm in."
    elif total_diff_count == 1:
        verdict_detail = (
            "1 vùng pixel khác — KHÔNG ĐẠT. "
            "So sánh theo pixel (an toàn in ấn): mọi lệch hiển thị đều là lỗi."
        )
    else:
        verdict_detail = (
            f"{total_diff_count} vùng pixel khác — KHÔNG ĐẠT. "
            "So sánh theo pixel: mọi lệch hiển thị đều cần xử lý trước khi in."
        )

    result_summary = {
        "total_pages": total_pages,
        "pages_pass": pages_pass,
        "pages_fail": pages_fail,
        "pages_warning": pages_warning,
        "total_diff_count": total_diff_count,
        # Giữ average_similarity = SSIM visual (tương thích API/UI cũ).
        "average_similarity": round(avg_similarity, 2),
        "visual_similarity": round(avg_similarity, 2),
        "compare_method": "pixel",
        "page_matching_mode": "imposition" if document_imposition else "sequential",
        "page_mapping": page_mapping,
        "print_verdict": "ĐẠT" if print_ok else "KHÔNG ĐẠT",
        "verdict_detail": verdict_detail,
        "total_instances": total_imposition_instances,
        "failed_instances": failed_imposition_instances,
        "overall_status": "PASS" if print_ok
                         else ("WARNING" if pages_fail == 0 and pages_warning > 0 else "FAIL"),
        "llm_warnings": llm_warnings,
    }
    _raise_if_cancelled(cancel_check)
    completed_at = datetime.now(timezone.utc)
    completed = (
        db.query(ComparisonJob)
        .filter(
            ComparisonJob.id == job_id,
            ComparisonJob.status == "processing",
        )
        .update(
            {
                ComparisonJob.result_summary: result_summary,
                ComparisonJob.status: "completed",
                ComparisonJob.progress: 100,
                ComparisonJob.completed_at: completed_at,
            },
            synchronize_session=False,
        )
    )
    if not completed:
        db.rollback()
        raise ComparisonCancelled("Job đã bị hủy trước khi hoàn tất.")
    db.commit()
    db.refresh(job)

    notify(100, status="completed",
           message=f"Hoàn thành! {pages_pass} trang OK, "
                   f"{pages_fail} trang lỗi, {pages_warning} cảnh báo.")

    logger.info(f"Job {job_id} completed: {result_summary}")


def run_comparison_pipeline(
    job_id: str,
    db: Session,
    on_progress: callable = None,
    cancel_check: Callable[[], bool] | None = None,
    raise_on_cancel: bool = False,
):
    """Chạy Compare và đảm bảo hủy/lỗi không để lại DB/artifact dở dang."""
    try:
        return _run_comparison_pipeline_impl(
            job_id,
            db,
            on_progress=on_progress,
            cancel_check=cancel_check,
        )
    except ComparisonCancelled:
        message = "Đã hủy so sánh theo yêu cầu của người dùng."
        _finalize_interrupted_job(
            job_id, db, status="cancelled", message=message,
        )
        if on_progress:
            on_progress(job_id, 0, "cancelled", 0, 0, message)
        if raise_on_cancel:
            raise
        return None
    except Exception as exc:
        _finalize_interrupted_job(
            job_id, db, status="failed", message=str(exc),
        )
        raise
