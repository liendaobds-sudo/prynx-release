"""
Image Comparator — Pixel-first PDF/print comparison.

Algorithm reference: Formartha/compare-pdf (cv2.absdiff, np.array_equal)
Enhanced with SSIM, contour detection, region clustering, micro-diff rescue,
and CMYK channel diff.

Chính sách: nguồn sự thật = pixel (render). Không OCR/text trong comparator.
License: OpenCV (Apache 2.0), scikit-image (BSD), Pillow (MIT-like)
"""
import logging
import tempfile
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np
from skimage.metrics import structural_similarity as ssim
from PIL import Image
import io

logger = logging.getLogger(__name__)


# ── Tolerance thresholds (grayscale absdiff, 0–255) ─────
TOLERANCE_THRESHOLDS = {
    "STRICT": 0,      # Mọi pixel khác nhau đều báo (proof nghiêm)
    "NORMAL": 13,     # ~5% of 255 — bỏ qua anti-aliasing nhỏ (mặc định in)
    "LOOSE": 38,      # ~15% of 255 — chỉ báo thay đổi tương đối lớn
}

# Base min contour area @150 DPI before dpi-scale (capped ×2 elsewhere)
TOLERANCE_MIN_AREA = {
    "STRICT": 8,      # giữ nét mỏng / 1 ký tự
    "NORMAL": 50,
    "LOOSE": 80,
}

# SSIM is an informational score only. Keep its working image bounded so a
# print-resolution page cannot create several full-page float64 buffers.
DEFAULT_SSIM_MAX_SIDE = 1200
GIF_MAX_SIDE = 1200


@dataclass
class DiffRegion:
    """A detected region of difference."""
    x: int
    y: int
    width: int
    height: int
    area: int = 0
    type: str = "image"       # text | image | layout
    severity: str = "medium"  # high | medium | low
    description: str = ""


@dataclass
class ComparisonResult:
    """Result of comparing two images."""
    similarity_score: float = 100.0
    diff_count: int = 0
    diff_regions: list[DiffRegion] = field(default_factory=list)
    diff_mask: np.ndarray = None
    highlighted_image: np.ndarray = None
    # PERF (audit 2026-08-13 §PB-2): pipeline so sánh encode PNG ngay trong worker
    # rồi đặt bytes vào đây (và giải phóng highlighted_image) để main thread chỉ
    # còn ghi file. Đường tuần tự không dùng trường này.
    highlighted_png: bytes | None = None
    gif_image: bytes | None = None
    diff_pixel_percentage: float = 0.0
    is_imposition_mode: bool = False
    total_instances: int = 0
    failed_instances: int = 0
    match_confidence: float = 0.0
    match_scale: float = 1.0
    # PERF (audit 2026-08-19 §CL.3): metadata nhẹ để engine dựng artifact theo
    # stripe từ PDF thay vì giữ highlighted raster toàn trang trong RAM.
    is_tiled: bool = False
    translation_x: float = 0.0
    translation_y: float = 0.0
    highlighted_artifact_url: str | None = None
    gif_artifact_url: str | None = None
    # Kích thước ảnh (px) mà diff_regions/highlighted_image đang nằm trong đó. Khi
    # so có CO GIÃN (Case A) hoặc bình bài, kích thước này KHÁC ảnh đầu vào gốc →
    # caller phải chuẩn hoá toạ độ theo đây, không theo ảnh gốc (tránh lệch toạ độ).
    render_w: int = 0
    render_h: int = 0


@dataclass
class CMYKComparisonResult:
    """Result of CMYK channel-by-channel comparison."""
    channel_results: dict = field(default_factory=dict)
    combined_mask: np.ndarray = None
    has_cmyk_differences: bool = False


class ImageComparator:
    """
    Compare two images using multiple methods.
    Reference: compare-pdf uses np.array_equal + cv2.absdiff.
    We add SSIM, contour detection, clustering, and CMYK support.
    """

    def compare(
        self,
        img1: np.ndarray,
        img2: np.ndarray,
        tolerance: str = "NORMAL",
        min_contour_area: int = 50,
        config: dict = None,
    ) -> ComparisonResult:
        """
        Full image comparison pipeline:
        1. Resize if different dimensions
        2. Convert to grayscale
        3. SSIM for structural similarity score
        4. Absolute difference for pixel-level diff
        5. Threshold + contour detection for diff regions
        6. Cluster nearby regions
        """
        result = ComparisonResult()

        # Step 1: Detect Imposition Mode (theo tỉ lệ DIỆN TÍCH, không phải 1 chiều)
        h1, w1 = img1.shape[:2]
        h2, w2 = img2.shape[:2]
        
        is_packaging = config.get("is_packaging_mode", False) if config else False
        document_imposition = bool((config or {}).get("document_imposition_mode", False))

        area1 = float(w1 * h1)
        area2 = float(w2 * h2)
        asp1 = (w1 / h1) if h1 else 1.0
        asp2 = (w2 / h2) if h2 else 1.0
        size_eq = (abs(w1 - w2) <= 0.02 * max(w1, w2)) and (abs(h1 - h2) <= 0.02 * max(h1, h2))
        aspect_close = abs(asp1 - asp2) <= 0.06 * max(asp1, asp2, 1e-6)
        area_ratio = (max(area1, area2) / min(area1, area2)) if min(area1, area2) > 0 else 1.0
        IMPOSITION_AREA_RATIO = 1.8

        # A multi-page booklet can have the same physical sheet area as one
        # source page (for example A4 portrait pages imposed on A4 landscape).
        # The document pipeline knows the roles, so do not rely on area alone.
        if document_imposition:
            return self._compare_imposition(
                template=img1, imposed=img2, is_packaging_mode=is_packaging,
                tolerance=tolerance, config=config,
            )

        # ── Case A: CÙNG tỉ lệ khung, KHÁC cỡ, diện tích chênh < ngưỡng N-up ──
        # Khi chênh diện tích < 1.8× thì KHÔNG thể là lưới ≥2 bản → chắc chắn là MỘT
        # thiết kế đổi cỡ (vd A4 ↔ ~A4 thu nhỏ). Co giãn ĐỀU rồi so 1:1 (cùng aspect →
        # không méo). Trường hợp chênh ≥1.8× (mơ hồ: 1 bản phóng to HAY lưới N-up giữ
        # tỉ lệ) để chế độ bình bài đa tỉ lệ tự đếm số bản mà xử lý.
        if not size_eq and aspect_close and 1.02 < area_ratio < IMPOSITION_AREA_RATIO:
            res_a = self._compare_scaled(img1, img2, tolerance, config)
            if res_a is not None:
                return res_a

        # ── Case B: tờ N-up / 1 bản phóng to (diện tích lớn vượt trội) → dò mẫu ĐA TỈ LỆ ──
        if not size_eq and area_ratio >= IMPOSITION_AREA_RATIO:
            if area2 >= area1:
                logger.info(f"Imposition Mode: Image 2 lớn hơn (area {area_ratio:.2f}×). Packaging: {is_packaging}")
                return self._compare_imposition(
                    template=img1, imposed=img2, is_packaging_mode=is_packaging,
                    tolerance=tolerance, config=config,
                )
            else:
                logger.info(f"Imposition Mode: Image 1 lớn hơn (area {area_ratio:.2f}×). Packaging: {is_packaging}")
                return self._compare_imposition(
                    template=img2, imposed=img1, is_packaging_mode=is_packaging,
                    tolerance=tolerance, config=config,
                )

        # Step 1.5: Ensure same dimensions if standard 1:1 mode
        img1, img2 = self._normalize_dimensions(img1, img2)

        # Exact pages are common in version checks. This safe shortcut avoids
        # registration, SSIM, mask morphology, and result image generation.
        if np.array_equal(img1, img2):
            return self._identical_result(img2)

        # Step 1.6: Registration — bù lệch render nhỏ (NORMAL/LOOSE).
        # STRICT: KHÔNG align — lệch 1–2px cố ý (cắt xén/trim) vẫn phải báo.
        if (tolerance or "NORMAL").upper() != "STRICT":
            img2 = self._align_to(img1, img2)
            if np.array_equal(img1, img2):
                return self._identical_result(img2)

        tol_key, threshold_val, eff_min_area, micro_min_area = (
            self._resolve_diff_settings(tolerance, min_contour_area, config)
        )

        # Step 2: Convert to grayscale for SSIM
        gray1 = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY) if len(img1.shape) == 3 else img1
        gray2 = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY) if len(img2.shape) == 3 else img2

        # Step 3: SSIM (tham khảo — không quyết định pass/fail)
        result.similarity_score = self._compute_visual_similarity(
            gray1, gray2, config=config
        )

        # Step 4 & 5: Pixel difference and Thresholding
        binary_mask = self._build_diff_mask(gray1, gray2, img1, img2, threshold_val)

        # Morph: STRICT bỏ OPEN (giữ nét 1px); NORMAL/LOOSE lọc nhiễu AA.
        binary_mask = self._morph_diff_mask(binary_mask, tol_key)

        result.diff_mask = binary_mask
        result.render_w = img2.shape[1]
        result.render_h = img2.shape[0]

        total_pixels = binary_mask.shape[0] * binary_mask.shape[1]
        diff_pixels = int(np.count_nonzero(binary_mask))
        result.diff_pixel_percentage = round(diff_pixels / total_pixels * 100, 3)

        # Step 6: Contours + micro-diff rescue
        regions = self._extract_diff_regions(
            binary_mask, eff_min_area, micro_min_area, total_pixels, tol_key
        )
        regions = self._cluster_regions(regions, merge_distance=20)

        result.diff_regions = regions
        result.diff_count = len(regions)

        if regions:
            result.highlighted_image = self.highlight_differences(
                img2, binary_mask, regions
            )
            frame_off, frame_on = self._create_spotlight_frames(img2, regions)
            result.gif_image = self._generate_gif(frame_off, frame_on, duration_ms=600)

        logger.info(
            f"Comparison [{tol_key}]: {result.similarity_score}% similar, "
            f"{result.diff_count} regions, {result.diff_pixel_percentage}% pixels differ"
        )
        return result

    def _resolve_diff_settings(
        self,
        tolerance: str,
        min_contour_area: int,
        config: dict | None,
    ) -> tuple[str, int, int, int]:
        """Dùng chung ngưỡng pixel/diện tích cho full-frame và tile."""
        dpi = (config or {}).get("dpi", 150) or 150
        tol_key = (tolerance or "NORMAL").upper()
        threshold_val = TOLERANCE_THRESHOLDS.get(tol_key, 13)
        base_min = TOLERANCE_MIN_AREA.get(tol_key, min_contour_area)
        # Caller có thể override min_contour_area thấp hơn (tests).
        base_min = min(base_min, min_contour_area) if min_contour_area < 50 else base_min
        if tol_key == "STRICT":
            base_min = min(base_min, TOLERANCE_MIN_AREA["STRICT"])
        dpi_area_scale = min((float(dpi) / 150.0) ** 2, 2.0)
        eff_min_area = max(1, int(base_min * dpi_area_scale))
        micro_min_area = max(
            2 if tol_key == "STRICT" else 4,
            int(eff_min_area * 0.15),
        )
        return tol_key, threshold_val, eff_min_area, micro_min_area

    def _identical_result(self, image: np.ndarray) -> ComparisonResult:
        '''Return a zero-diff result without allocating full-page artifacts.'''
        result = ComparisonResult()
        result.similarity_score = 100.0
        result.diff_mask = np.zeros(image.shape[:2], dtype=np.uint8)
        result.render_w = image.shape[1]
        result.render_h = image.shape[0]
        return result

    def compare_tiled(
        self,
        read_img1: Callable[[int, int, int, int], np.ndarray],
        read_img2: Callable[[int, int, int, int], np.ndarray],
        width: int,
        height: int,
        *,
        tolerance: str = "NORMAL",
        min_contour_area: int = 50,
        config: dict | None = None,
        tile_size: int = 2048,
        preview_img1: np.ndarray | None = None,
        preview_img2: np.ndarray | None = None,
        translation: tuple[float, float] | None = None,
        collect_diff_mask: bool = False,
        cancel_check: Callable[[], bool] | None = None,
    ) -> ComparisonResult:
        """So sánh 1:1 theo tile, không giữ hai raster toàn trang trong RAM.

        Hai reader dùng tọa độ pixel gốc trên-trái. Registration chỉ được tính một
        lần từ preview rồi áp cùng một translation cho mọi tile. Core mask được ghép
        component xuyên biên; overlap chỉ phục vụ warp/morphology và bị loại trước
        khi cộng số pixel, vì vậy không đếm trùng.

        Đây là primitive cho nhánh 1:1. Bình bài/co giãn vẫn đi ``compare()``.
        Artifact được dựng ở tầng engine; mask toàn trang mặc định nằm trên staging
        disk-backed, không thành ndarray resident trong RAM.
        """
        width = int(width)
        height = int(height)
        tile_size = int(tile_size)
        if width <= 0 or height <= 0:
            raise ValueError("Kích thước trang tile phải lớn hơn 0")
        if tile_size < 64:
            raise ValueError("tile_size phải từ 64 px trở lên")

        tol_key, threshold_val, eff_min_area, micro_min_area = (
            self._resolve_diff_settings(tolerance, min_contour_area, config)
        )
        if tol_key == "STRICT":
            translation = (0.0, 0.0)
        elif translation is None and preview_img1 is not None and preview_img2 is not None:
            translation = self.estimate_translation(
                preview_img1,
                preview_img2,
                full_size=(width, height),
            )
        elif translation is None:
            translation = (0.0, 0.0)
        dx, dy = float(translation[0]), float(translation[1])

        # CLOSE/OPEN 3×3 cần tối đa 6 px ngữ cảnh; cộng nội suy và translation.
        morph_guard = 2 if tol_key == "STRICT" else 6
        guard = morph_guard + int(np.ceil(max(abs(dx), abs(dy)))) + 2

        result = ComparisonResult(
            render_w=width,
            render_h=height,
            is_tiled=True,
            translation_x=dx,
            translation_y=dy,
        )
        aligned_preview = None
        if preview_img1 is not None and preview_img2 is not None:
            preview_img1, preview_img2 = self._normalize_dimensions(
                preview_img1, preview_img2
            )
            preview_h, preview_w = preview_img1.shape[:2]
            preview_translation = (
                dx * preview_w / float(width),
                dy * preview_h / float(height),
            )
            aligned_preview = self._apply_translation(
                preview_img2, *preview_translation
            )
            gray1 = (
                cv2.cvtColor(preview_img1, cv2.COLOR_RGB2GRAY)
                if preview_img1.ndim == 3 else preview_img1
            )
            gray2 = (
                cv2.cvtColor(aligned_preview, cv2.COLOR_RGB2GRAY)
                if aligned_preview.ndim == 3 else aligned_preview
            )
            result.similarity_score = self._compute_visual_similarity(
                gray1, gray2, config=config
            )

        total_pixels = width * height
        mask_file = None
        if collect_diff_mask:
            mask_store = np.zeros((height, width), dtype=np.uint8)
        else:
            staging_dir = (config or {}).get("_tile_staging_dir") or None
            mask_file = tempfile.TemporaryFile(
                prefix="prynx_compare_mask_",
                dir=staging_dir,
            )
            mask_file.truncate(total_pixels)
            mask_store = np.memmap(
                mask_file,
                dtype=np.uint8,
                mode="r+",
                shape=(height, width),
            )
        try:
            diff_pixels = self._fill_tiled_mask(
                mask_store,
                read_img1,
                read_img2,
                width,
                height,
                tile_size,
                guard,
                dx,
                dy,
                threshold_val,
                tol_key,
                cancel_check,
            )
            regions = self._extract_diff_regions(
                mask_store,
                eff_min_area,
                micro_min_area,
                total_pixels,
                tol_key,
            )
            if collect_diff_mask:
                result.diff_mask = mask_store
        finally:
            if mask_file is not None:
                mask_store.flush()
                del mask_store
                mask_file.close()

        result.diff_pixel_percentage = round(
            diff_pixels / total_pixels * 100, 3
        )
        result.diff_regions = self._cluster_regions(regions, merge_distance=20)
        result.diff_count = len(result.diff_regions)

        if result.diff_regions and aligned_preview is not None:
            preview_h, preview_w = aligned_preview.shape[:2]
            scale_x = preview_w / float(width)
            scale_y = preview_h / float(height)
            preview_regions = [
                DiffRegion(
                    x=int(round(region.x * scale_x)),
                    y=int(round(region.y * scale_y)),
                    width=max(1, int(round(region.width * scale_x))),
                    height=max(1, int(round(region.height * scale_y))),
                    area=float(region.area) * scale_x * scale_y,
                    type=region.type,
                    severity=region.severity,
                    description=region.description,
                )
                for region in result.diff_regions
            ]
            frame_off, frame_on = self._create_spotlight_frames(
                aligned_preview, preview_regions
            )
            result.gif_image = self._generate_gif(
                frame_off, frame_on, duration_ms=600
            )

        logger.info(
            "Comparison tile [%s]: %s%% similar, %d regions, %s%% pixels differ, "
            "tile=%d, guard=%d, shift=(%.2f, %.2f)",
            tol_key,
            result.similarity_score,
            result.diff_count,
            result.diff_pixel_percentage,
            tile_size,
            guard,
            dx,
            dy,
        )
        return result

    def _fill_tiled_mask(
        self,
        mask_store: np.ndarray,
        read_img1: Callable[[int, int, int, int], np.ndarray],
        read_img2: Callable[[int, int, int, int], np.ndarray],
        width: int,
        height: int,
        tile_size: int,
        guard: int,
        dx: float,
        dy: float,
        threshold_val: int,
        tol_key: str,
        cancel_check: Callable[[], bool] | None,
    ) -> int:
        """Điền mask disk-backed theo core tile và trả tổng pixel khác biệt."""
        diff_pixels = 0
        for y in range(0, height, tile_size):
            core_height = min(tile_size, height - y)
            for x in range(0, width, tile_size):
                if cancel_check is not None and cancel_check():
                    raise InterruptedError("Đã hủy khi đang so sánh các tile")
                core_width = min(tile_size, width - x)
                read_x = max(0, x - guard)
                read_y = max(0, y - guard)
                read_right = min(width, x + core_width + guard)
                read_bottom = min(height, y + core_height + guard)
                read_width = read_right - read_x
                read_height = read_bottom - read_y

                tile1 = np.ascontiguousarray(
                    read_img1(read_x, read_y, read_width, read_height)
                )
                tile2 = np.ascontiguousarray(
                    read_img2(read_x, read_y, read_width, read_height)
                )
                expected_shape = (read_height, read_width)
                if tile1.shape[:2] != expected_shape or tile2.shape[:2] != expected_shape:
                    raise ValueError(
                        "Reader tile trả sai kích thước: "
                        f"cần {expected_shape}, nhận {tile1.shape[:2]} và {tile2.shape[:2]}"
                    )
                if tile1.ndim != tile2.ndim:
                    raise ValueError("Hai reader tile phải trả ảnh cùng số chiều")

                if dx or dy:
                    tile2 = self._apply_translation(tile2, dx, dy)

                if np.array_equal(tile1, tile2):
                    expanded_mask = np.zeros(expected_shape, dtype=np.uint8)
                else:
                    gray1 = (
                        cv2.cvtColor(tile1, cv2.COLOR_RGB2GRAY)
                        if tile1.ndim == 3 else tile1
                    )
                    gray2 = (
                        cv2.cvtColor(tile2, cv2.COLOR_RGB2GRAY)
                        if tile2.ndim == 3 else tile2
                    )
                    expanded_mask = self._build_diff_mask(
                        gray1, gray2, tile1, tile2, threshold_val
                    )
                    expanded_mask = self._morph_diff_mask(expanded_mask, tol_key)

                core_x = x - read_x
                core_y = y - read_y
                core_mask = np.ascontiguousarray(
                    expanded_mask[
                        core_y:core_y + core_height,
                        core_x:core_x + core_width,
                    ]
                )
                diff_pixels += int(np.count_nonzero(core_mask))
                mask_store[
                    y:y + core_height,
                    x:x + core_width,
                ] = core_mask
        return diff_pixels

    def _compute_visual_similarity(
        self,
        gray1: np.ndarray,
        gray2: np.ndarray,
        config: dict = None,
    ) -> float:
        '''Compute informational SSIM on a bounded preview.

        Pass/fail remains based on the full-resolution pixel mask. Downscaling
        here only changes the UI's advisory visual-similarity percentage.
        '''
        configured = (config or {}).get("ssim_max_side", DEFAULT_SSIM_MAX_SIDE)
        try:
            max_side = int(configured or DEFAULT_SSIM_MAX_SIDE)
        except (TypeError, ValueError):
            max_side = DEFAULT_SSIM_MAX_SIDE
        max_side = max(64, min(max_side, 4096))

        h, w = gray1.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / float(max(h, w))
            target = (
                max(1, int(round(w * scale))),
                max(1, int(round(h * scale))),
            )
            gray1 = cv2.resize(gray1, target, interpolation=cv2.INTER_AREA)
            gray2 = cv2.resize(gray2, target, interpolation=cv2.INTER_AREA)

        score = ssim(gray1, gray2, full=False)
        return round(float(score) * 100, 2)

    def _build_diff_mask(
        self,
        gray1: np.ndarray,
        gray2: np.ndarray,
        img1: np.ndarray,
        img2: np.ndarray,
        threshold_val: int,
    ) -> np.ndarray:
        """Binary mask of differing pixels (GPU → Rust → OpenCV)."""
        from app.core.gpu_accelerator import GPUAccelerator
        gpu = GPUAccelerator.get_instance()
        if gpu.is_available:
            return gpu.compute_diff_mask(gray1, gray2, threshold_val)
        try:
            import pdfcompare_native
            return pdfcompare_native.fast_diff_mask_gray(gray1, gray2, threshold_val)
        except (ImportError, AttributeError) as e:
            logger.warning(f"Rust native pixel diff failed/unavailable: {e}. Falling back to OpenCV CPU.")
            if len(img1.shape) == 3:
                abs_diff = cv2.absdiff(img1, img2)
                diff_gray = cv2.cvtColor(abs_diff, cv2.COLOR_RGB2GRAY)
            else:
                diff_gray = cv2.absdiff(gray1, gray2)
            _, binary_mask = cv2.threshold(diff_gray, threshold_val, 255, cv2.THRESH_BINARY)
            return binary_mask

    def _morph_diff_mask(self, binary_mask: np.ndarray, tol_key: str) -> np.ndarray:
        """Noise reduction; STRICT skips OPEN to preserve thin strokes."""
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        if tol_key == "STRICT":
            # Chỉ CLOSE 1 lần — nối nét đứt nhẹ, không xóa stroke 1px.
            return cv2.morphologyEx(binary_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_OPEN, kernel, iterations=1)
        return binary_mask

    def _extract_diff_regions(
        self,
        binary_mask: np.ndarray,
        eff_min_area: float,
        micro_min_area: float,
        total_pixels: int,
        tol_key: str,
    ) -> list:
        """Contours above min area + micro-diff rescue when mask has pixels but all filtered."""
        contours, _ = cv2.findContours(
            binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        diff_pixels = int(np.count_nonzero(binary_mask))

        def _from_contours(min_area: float, micro: bool = False) -> list:
            out = []
            for contour in contours:
                area = cv2.contourArea(contour)
                if area < min_area:
                    continue
                x, y, w, h = cv2.boundingRect(contour)
                severity = self._classify_severity(area, total_pixels)
                out.append(DiffRegion(
                    x=x, y=y, width=w, height=h,
                    area=area, severity=severity,
                    description=(
                        f"Thay đổi nhỏ {w}x{h}px" if micro
                        else f"Vùng thay đổi {w}x{h}px"
                    ),
                ))
            return out

        regions = _from_contours(eff_min_area, micro=False)
        if not regions and diff_pixels > 0:
            regions = _from_contours(micro_min_area, micro=True)
            bbox_floor = 4 if tol_key == "STRICT" else 12
            if not regions and diff_pixels >= bbox_floor:
                ys, xs = np.where(binary_mask > 0)
                if len(xs) > 0:
                    x0, x1 = int(xs.min()), int(xs.max())
                    y0, y1 = int(ys.min()), int(ys.max())
                    w, h = max(1, x1 - x0 + 1), max(1, y1 - y0 + 1)
                    regions = [DiffRegion(
                        x=x0, y=y0, width=w, height=h,
                        area=float(diff_pixels),
                        severity=self._classify_severity(int(diff_pixels), total_pixels),
                        description=f"Thay đổi nhỏ {w}x{h}px",
                    )]
                    logger.info(
                        f"Micro-diff bbox rescue [{tol_key}]: {diff_pixels} px → "
                        f"{w}x{h} @({x0},{y0})"
                    )
            elif regions:
                logger.info(
                    f"Micro-diff contour rescue [{tol_key}]: {len(regions)} region(s) "
                    f"(micro_min={micro_min_area}, eff_min={eff_min_area})"
                )
        return regions

    def compare_cmyk(
        self,
        cmyk1: np.ndarray,
        cmyk2: np.ndarray,
        tolerance: str = "NORMAL",
        rgb_a: np.ndarray = None,
        rgb_b: np.ndarray = None,
        config: dict = None,
    ) -> ComparisonResult:
        """
        CMYK-aware comparison for printing QA.
        
        Strategy: Use the proven RGB comparison pipeline to find real diff regions first,
        then augment descriptions with per-channel CMYK breakdown.
        This avoids false-positives from PIL's RGB→CMYK conversion noise.
        """
        # STEP 1: Use the battle-tested RGB pipeline as truth source
        if rgb_a is not None and rgb_b is not None:
            result = self.compare(rgb_a, rgb_b, tolerance=tolerance, config=config)
        else:
            # Fallback: convert CMYK back to grayscale for structural comparison
            result = ComparisonResult()
            gray1 = cv2.cvtColor(cmyk1[:, :, :3], cv2.COLOR_RGB2GRAY) if cmyk1.shape[2] >= 3 else cmyk1[:, :, 3]
            gray2 = cv2.cvtColor(cmyk2[:, :, :3], cv2.COLOR_RGB2GRAY) if cmyk2.shape[2] >= 3 else cmyk2[:, :, 3]
            result.similarity_score = self._compute_visual_similarity(
                gray1, gray2, config=config
            )
            return result

        # STEP 2: Augment each real diff region with CMYK channel breakdown.
        # Dùng chung primitive reader với đường tile để hai chiến lược không trôi
        # hợp đồng tính mean/channel threshold theo thời gian.
        if len(result.diff_regions) > 0 and cmyk1.shape == cmyk2.shape:
            self.augment_cmyk_regions(
                result,
                lambda x, y, width, height: cmyk1[y:y + height, x:x + width],
                lambda x, y, width, height: cmyk2[y:y + height, x:x + width],
                cmyk1.shape[1],
                cmyk1.shape[0],
            )

        return result

    def augment_cmyk_regions(
        self,
        result: ComparisonResult,
        read_cmyk1: Callable[[int, int, int, int], np.ndarray],
        read_cmyk2: Callable[[int, int, int, int], np.ndarray],
        width: int,
        height: int,
    ) -> ComparisonResult:
        """Bổ sung sai lệch C/M/Y/K bằng cách chỉ đọc ROI của vùng đã phát hiện.

        PERF (audit 2026-08-20 §CMYK.TILE): RGB full-DPI theo tile vẫn là nguồn
        pass/fail. CMYK chỉ là metadata mô tả, vì vậy không cần giữ hai raster CMYK
        toàn trang trong RAM. Reader dùng tọa độ gốc, cố ý giữ parity với đường cũ:
        RGB có thể đã align nhưng số liệu CMYK được đo trên hai vùng chưa align.
        """
        width = int(width)
        height = int(height)
        if width <= 0 or height <= 0 or not result.diff_regions:
            return result

        channel_names = ("C", "M", "Y", "K")
        for region in result.diff_regions:
            x1 = max(0, int(region.x))
            y1 = max(0, int(region.y))
            x2 = min(width, int(region.x + region.width))
            y2 = min(height, int(region.y + region.height))
            if x2 <= x1 or y2 <= y1:
                continue

            patch1 = np.asarray(
                read_cmyk1(x1, y1, x2 - x1, y2 - y1)
            )
            patch2 = np.asarray(
                read_cmyk2(x1, y1, x2 - x1, y2 - y1)
            )
            expected_shape = (y2 - y1, x2 - x1)
            if patch1.shape[:2] != expected_shape or patch2.shape[:2] != expected_shape:
                raise ValueError(
                    "Reader CMYK trả sai kích thước ROI: "
                    f"cần {expected_shape}, nhận {patch1.shape[:2]} và {patch2.shape[:2]}"
                )
            if (
                patch1.ndim != 3
                or patch2.ndim != 3
                or patch1.shape[2] < 4
                or patch2.shape[2] < 4
            ):
                raise ValueError("Reader CMYK phải trả ảnh có đủ bốn kênh C/M/Y/K")

            patch1 = patch1.astype(np.float32)
            patch2 = patch2.astype(np.float32)
            channel_diffs = []
            for channel_index, channel_name in enumerate(channel_names):
                channel_diff = np.abs(
                    patch1[:, :, channel_index] - patch2[:, :, channel_index]
                ).mean()
                if channel_diff > 5:
                    channel_diffs.append(f"{channel_name}Δ{channel_diff:.0f}")

            if channel_diffs:
                region.type = "cmyk"
                region.description = f"Lệch kênh: {', '.join(channel_diffs)}"

        return result

    def _create_spotlight_frames(self, img: np.ndarray, regions: list[DiffRegion]) -> tuple[np.ndarray, np.ndarray]:
        """
        Creates exactly two frames for the spotlight GIF animation:
        1. A dark, dimmed version of the image (frame_off)
        2. A version where only the diff regions are fully bright & highlighted (frame_on)
        """
        h_img, w_img = img.shape[:2]
        if max(h_img, w_img) > GIF_MAX_SIDE:
            scale = GIF_MAX_SIDE / float(max(h_img, w_img))
            target = (
                max(1, int(round(w_img * scale))),
                max(1, int(round(h_img * scale))),
            )
            img = cv2.resize(img, target, interpolation=cv2.INTER_AREA)
            regions = [
                DiffRegion(
                    x=int(round(region.x * scale)),
                    y=int(round(region.y * scale)),
                    width=max(1, int(round(region.width * scale))),
                    height=max(1, int(round(region.height * scale))),
                    area=int(round(region.area * scale * scale)),
                    type=region.type,
                    severity=region.severity,
                    description=region.description,
                )
                for region in regions
            ]
            h_img, w_img = img.shape[:2]

        # Allocate only the two bounded GIF frames. convertScaleAbs avoids a
        # temporary full-frame float32 array.
        frame_off = cv2.convertScaleAbs(img, alpha=0.4, beta=0)
        frame_on = frame_off.copy()
        
        padding = 15  # Expand the spotlight box by 15px in all directions
        
        # 2. Process each region to make it Pop!
        for region in regions:
            x1 = max(0, region.x - padding)
            y1 = max(0, region.y - padding)
            x2 = min(w_img, region.x + region.width + padding)
            y2 = min(h_img, region.y + region.height + padding)
            
            rw_new = x2 - x1
            rh_new = y2 - y1
            
            # Extract the raw, bright original pixels for this bounding box
            bright_crop = img[y1:y2, x1:x2].copy()
            
            # Draw a thick highlight border on the bright crop
            # RGB Format since convert_from_path outputs RGB arrays
            color = (255, 0, 0) # Red for high severity
            if region.severity == "medium":
                color = (255, 165, 0) # Orange
            elif region.severity == "low":
                color = (255, 255, 0) # Yellow
                
            # Draw the bright bounding box inside the crop margins
            cv2.rectangle(bright_crop, (0, 0), (rw_new - 1, rh_new - 1), color, 4)
            
            # Overlay the bright crop onto frame_on so it pierces through the darkness
            frame_on[y1:y2, x1:x2] = bright_crop
            
        return frame_off, frame_on

    def _generate_gif(self, img1: np.ndarray, img2: np.ndarray, duration_ms: int = 700) -> bytes:
        """
        Generate an animated GIF that transitions between image 1 and image 2.
        Images are downscaled to max width 1200px to improve performance.
        """
        max_w = 1200
        h, w = img1.shape[:2]
        if w > max_w:
            scale = max_w / w
            new_w, new_h = int(w * scale), int(h * scale)
            img1 = cv2.resize(img1, (new_w, new_h), interpolation=cv2.INTER_AREA)
            img2 = cv2.resize(img2, (new_w, new_h), interpolation=cv2.INTER_AREA)

        # Arrays are already in RGB format from pdf_processor
        pil_img1 = Image.fromarray(img1)
        pil_img2 = Image.fromarray(img2)

        # Save to memory buffer
        buf = io.BytesIO()
        pil_img1.save(
            buf,
            format='GIF',
            save_all=True,
            append_images=[pil_img2],
            duration=duration_ms,
            loop=0  # 0 means infinite loop
        )
        return buf.getvalue()

    def highlight_differences(
        self,
        image: np.ndarray,
        diff_mask: np.ndarray,
        regions: list[DiffRegion],
        overlay_alpha: float = 0.4,
    ) -> np.ndarray:
        """
        Draw semi-transparent highlight overlay on diff regions.
        Reference: pdf-diff (draw_red_boxes), enhanced with severity colors.
        """
        result = image.copy()

        severity_colors = {
            "high": (239, 68, 68),
            "medium": (251, 146, 60),
            "low": (250, 204, 21),
        }

        h_img, w_img = result.shape[:2]
        for region in regions:
            color = severity_colors.get(region.severity, (239, 68, 68))
            x1 = max(0, region.x)
            y1 = max(0, region.y)
            x2 = min(w_img, region.x + region.width)
            y2 = min(h_img, region.y + region.height)
            if x2 <= x1 or y2 <= y1:
                continue

            # Blend only the changed ROI instead of allocating an overlay for
            # the entire render-sized page.
            roi = result[y1:y2, x1:x2]
            tint = np.empty_like(roi)
            tint[...] = color
            cv2.addWeighted(
                tint, overlay_alpha, roi, 1 - overlay_alpha, 0, dst=roi
            )
            cv2.rectangle(result, (x1, y1), (x2, y2), color, 2)

        return result

    def estimate_translation(
        self,
        ref: np.ndarray,
        mov: np.ndarray,
        *,
        full_size: tuple[int, int] | None = None,
    ) -> tuple[float, float]:
        """Ước lượng translation một lần; có thể quy đổi preview về full-size."""
        try:
            ref, mov = self._normalize_dimensions(ref, mov)
            g1 = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY) if ref.ndim == 3 else ref
            g2 = cv2.cvtColor(mov, cv2.COLOR_RGB2GRAY) if mov.ndim == 3 else mov
            preview_h, preview_w = g1.shape[:2]
            (dx, dy), response = cv2.phaseCorrelate(
                np.float32(g1), np.float32(g2)
            )
            full_w, full_h = full_size or (preview_w, preview_h)
            dx *= full_w / float(preview_w)
            dy *= full_h / float(preview_h)
            max_shift = max(8.0, 0.02 * max(full_h, full_w))
            if response < 0.2:
                return 0.0, 0.0
            if abs(dx) > max_shift or abs(dy) > max_shift:
                return 0.0, 0.0
            if abs(dx) < 0.5 and abs(dy) < 0.5:
                return 0.0, 0.0
            return self._refine_translation(
                ref,
                mov,
                float(dx),
                float(dy),
                full_size=(full_w, full_h),
            )
        except Exception as exc:
            logger.warning("Image alignment skipped: %s", exc)
            return 0.0, 0.0

    def _refine_translation(
        self,
        ref: np.ndarray,
        mov: np.ndarray,
        dx: float,
        dy: float,
        *,
        full_size: tuple[int, int],
    ) -> tuple[float, float]:
        """Chọn ứng viên translation cho sai số thấp nhất trên preview.

        Phase correlation trên preview nhỏ có thể lệch vài phần mười pixel khi quy
        đổi về full-size. Thử thêm ứng viên nguyên/0,25 px quanh nghiệm phase giúp
        full-frame và tile dùng cùng phép dịch mà vẫn giữ được dịch subpixel thật.
        """
        preview_h, preview_w = ref.shape[:2]
        full_w, full_h = full_size
        scale_x = preview_w / float(full_w)
        scale_y = preview_h / float(full_h)

        def _axis_candidates(value: float) -> list[float]:
            candidates = {
                float(value),
                float(round(value)),
                float(np.floor(value)),
                float(np.ceil(value)),
                round(value * 4.0) / 4.0,
            }
            return sorted(
                candidate
                for candidate in candidates
                if abs(candidate - value) <= 0.75
            )

        gray_ref = (
            cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY) if ref.ndim == 3 else ref
        )
        gray_mov = (
            cv2.cvtColor(mov, cv2.COLOR_RGB2GRAY) if mov.ndim == 3 else mov
        )
        margin_x = min(preview_w // 4, int(np.ceil(abs(dx) * scale_x)) + 3)
        margin_y = min(preview_h // 4, int(np.ceil(abs(dy) * scale_y)) + 3)
        x_slice = slice(margin_x, preview_w - margin_x or None)
        y_slice = slice(margin_y, preview_h - margin_y or None)

        best = (float("inf"), float(dx), float(dy))
        for candidate_dx in _axis_candidates(dx):
            for candidate_dy in _axis_candidates(dy):
                aligned = self._apply_translation(
                    gray_mov,
                    candidate_dx * scale_x,
                    candidate_dy * scale_y,
                )
                delta = cv2.absdiff(
                    gray_ref[y_slice, x_slice],
                    aligned[y_slice, x_slice],
                )
                score = float(np.mean(delta)) if delta.size else float("inf")
                rank = (score, abs(candidate_dx - dx) + abs(candidate_dy - dy))
                if rank < (best[0], abs(best[1] - dx) + abs(best[2] - dy)):
                    best = (score, candidate_dx, candidate_dy)
        return best[1], best[2]

    def _apply_translation(
        self,
        image: np.ndarray,
        dx: float,
        dy: float,
    ) -> np.ndarray:
        """Áp translation theo đúng quy ước phase correlation của comparator."""
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            return image
        height, width = image.shape[:2]
        matrix = np.float32([[1, 0, -dx], [0, 1, -dy]])
        return cv2.warpAffine(
            image,
            matrix,
            (width, height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )

    def _align_to(self, ref: np.ndarray, mov: np.ndarray) -> np.ndarray:
        """Căn chỉnh dịch chuyển `mov` cho khớp `ref` bằng phase correlation.

        Chỉ bù DỊCH (translation) nhỏ — không xoay/co giãn — để tránh báo khác biệt
        giả khi 2 trang lệch vài pixel. An toàn: bỏ qua nếu tương quan yếu (có thể là
        2 trang khác nội dung) hoặc dịch quá lớn (vượt ngưỡng → không phải lệch nhỏ).
        Dùng BORDER_REPLICATE để không tạo viền đen gây diff mới.
        """
        dx, dy = self.estimate_translation(ref, mov)
        return self._apply_translation(mov, dx, dy)

    def _compare_scaled(self, img1, img2, tolerance, config):
        """Case A: 2 ảnh CÙNG tỉ lệ khung, KHÁC cỡ → co giãn ĐỀU bên nhỏ về đúng cỡ
        bên lớn rồi so 1:1. Giữ NGUYÊN thứ tự tham số (img2 vẫn là nền highlight).

        Gọi lại self.compare() trên 2 ảnh đã CÙNG cỡ → đi thẳng nhánh 1:1 (không đệ
        quy vô hạn vì size_eq=True). render_w/h trong kết quả phản ánh cỡ đã co giãn.
        """
        h1, w1 = img1.shape[:2]
        h2, w2 = img2.shape[:2]
        if w1 * h1 >= w2 * h2:
            img2r = cv2.resize(img2, (w1, h1), interpolation=cv2.INTER_AREA)
            return self.compare(img1, img2r, tolerance=tolerance, config=config)
        else:
            img1r = cv2.resize(img1, (w2, h2), interpolation=cv2.INTER_AREA)
            return self.compare(img1r, img2, tolerance=tolerance, config=config)

    def _normalize_dimensions(
        self, img1: np.ndarray, img2: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Đưa 2 ảnh về cùng kích thước để absdiff/SSIM.

        PAD thêm viền TRẮNG giữ NGUYÊN tỉ lệ, KHÔNG resize-ép. Resize phi tuyến (khi
        2 trang lệch tỉ lệ/kích thước) làm méo toàn bộ nội dung → báo khác biệt giả
        cả trang (audit so-sánh #2). Pad ở mép phải/dưới (gốc trên-trái); `_align_to`
        bù dịch nhỏ sau đó. Vùng pad là trắng ở CẢ HAI ảnh tại phần chung nên không
        tự sinh diff; chỉ phần một ảnh thực sự có nội dung dài/rộng hơn mới bị bắt.
        """
        h1, w1 = img1.shape[:2]
        h2, w2 = img2.shape[:2]
        if (h1, w1) == (h2, w2):
            return img1, img2

        H, W = max(h1, h2), max(w1, w2)

        def _pad(img: np.ndarray) -> np.ndarray:
            h, w = img.shape[:2]
            if h == H and w == W:
                return img
            val = (255, 255, 255) if img.ndim == 3 else 255
            return cv2.copyMakeBorder(img, 0, H - h, 0, W - w, cv2.BORDER_CONSTANT, value=val)

        return _pad(img1), _pad(img2)

    def _classify_severity(self, area: int, total_pixels: int) -> str:
        """Classify severity based on region area relative to page."""
        ratio = area / total_pixels
        if ratio > 0.01:  # > 1% of page
            return "high"
        elif ratio > 0.001:  # > 0.1% of page
            return "medium"
        return "low"

    def _compare_imposition(
        self,
        template: np.ndarray,
        imposed: np.ndarray,
        is_packaging_mode: bool = False,
        tolerance: str = "NORMAL",
        config: dict = None,
    ) -> ComparisonResult:
        """
        Advanced Imposition Verification:
        Finds occurrences of `template` 1-up inside `imposed` N-up sheet,
        then pixel-compares EACH instance (print-safe).
        Supports 4-way rotation (0, 90, 180, 270) and bleed crop.
        """
        result = ComparisonResult()
        result.is_imposition_mode = True
        analysis_only = bool((config or {}).get("_analysis_only", False))
        ih, iw = imposed.shape[:2]
        tol_key = (tolerance or "NORMAL").upper()

        # For source-page -> booklet-sheet verification compare the finished
        # TrimBox, not the outer bleed. If the PDF has no TrimBox, an explicit
        # small fallback ratio may be supplied by the document pipeline.
        trim_insets = (config or {}).get("template_trim_insets")
        if trim_insets is None:
            edge = float((config or {}).get("imposition_bleed_ignore_ratio", 0.0) or 0.0)
            if edge > 0:
                trim_insets = (edge, edge, edge, edge)
        if trim_insets is not None:
            try:
                left, top, right, bottom = [max(0.0, min(0.45, float(v))) for v in trim_insets]
                src_h, src_w = template.shape[:2]
                x0 = int(round(src_w * left))
                y0 = int(round(src_h * top))
                x1 = int(round(src_w * (1.0 - right)))
                y1 = int(round(src_h * (1.0 - bottom)))
                if x1 - x0 >= 16 and y1 - y0 >= 16:
                    template = template[y0:y1, x0:x1]
            except (TypeError, ValueError):
                logger.warning("Invalid template_trim_insets ignored: %r", trim_insets)
        thr = TOLERANCE_THRESHOLDS.get(tol_key, 13)
        # Imposition: slightly higher floor than 1:1 to absorb match-align noise,
        # but STRICT still catches small content edits on one label.
        inst_min_area = 8 if tol_key == "STRICT" else (20 if tol_key == "NORMAL" else 40)
        dpi = (config or {}).get("dpi", 150) or 150
        dpi_area_scale = min((float(dpi) / 150.0) ** 2, 2.0)
        inst_min_area = max(4, int(inst_min_area * min(dpi_area_scale, 2.0)))
        
        # 1. Prepare base grayscales
        gray_template = cv2.cvtColor(template, cv2.COLOR_RGB2GRAY) if len(template.shape) == 3 else template
        gray_imposed = cv2.cvtColor(imposed, cv2.COLOR_RGB2GRAY) if len(imposed.shape) == 3 else imposed
        
        # 2. Bleed Tolerance Cropping (Remove 4% of margins)
        th, tw = template.shape[:2]
        margin_x = int(tw * 0.04)
        margin_y = int(th * 0.04)
        
        core_gray = gray_template[margin_y:th-margin_y, margin_x:tw-margin_x]
        
        # 2.5 Compute Content Alpha Mask for Packaging Interlocks
        alpha_mask = None
        if is_packaging_mode:
            ff_mask = np.zeros((th + 2, tw + 2), np.uint8)
            fill_image = gray_template.copy()
            corners = [(0, 0), (tw - 1, 0), (0, th - 1), (tw - 1, th - 1)]
            for pt in corners:
                # If corner is bright enough, treat as background
                if fill_image[pt[1], pt[0]] >= 240:
                    cv2.floodFill(fill_image, ff_mask, pt, 0, loDiff=10, upDiff=10)
            
            # ff_mask marks background as 1. We want content as 255.
            alpha_mask = (1 - ff_mask[1:-1, 1:-1]) * 255
        
        # 3. Multi-Angle + Multi-Scale Scanning
        # Quét 4 góc xoay (0/90/180/270). ĐA TỈ LỆ: thử cỡ GỐC (scale 1.0) TRƯỚC để
        # GIỮ NGUYÊN hành vi bình tem hiện tại; CHỈ khi cỡ gốc không tìm thấy mẫu nào
        # mới thử các cỡ khác (vd thiết kế bị BÓP A4→A5 khi bình) → hỗ trợ scale mà
        # không gây nhiễu cho luồng cùng-cỡ đang chạy tốt. Giả định scale ĐỒNG NHẤT
        # trên cả tờ (đúng với bình bài thực tế).
        angles = [
            (0, None),
            (90, cv2.ROTATE_90_CLOCKWISE),
            (180, cv2.ROTATE_180),
            (270, cv2.ROTATE_90_COUNTERCLOCKWISE),
        ]

        def _scan_scale(scale):
            boxes_s, scores_s, angles_s = [], [], []
            cw = max(1, int(round(core_gray.shape[1] * scale)))
            ch = max(1, int(round(core_gray.shape[0] * scale)))
            scaled_core = core_gray if scale == 1.0 else cv2.resize(core_gray, (cw, ch), interpolation=cv2.INTER_AREA)
            fw = max(1, int(round(tw * scale)))
            fh = max(1, int(round(th * scale)))
            mx = int(round(margin_x * scale))
            my = int(round(margin_y * scale))
            for angle, rot_code in angles:
                if rot_code is not None:
                    rc = cv2.rotate(scaled_core, rot_code)
                    if angle in (90, 270):
                        full_w, full_h = fh, fw
                        ox, oy = my, mx
                    else:
                        full_w, full_h = fw, fh
                        ox, oy = mx, my
                else:
                    rc = scaled_core
                    full_w, full_h = fw, fh
                    ox, oy = mx, my
                if rc.shape[0] > gray_imposed.shape[0] or rc.shape[1] > gray_imposed.shape[1]:
                    continue  # template (đã scale) lớn hơn tờ → matchTemplate không chạy được
                res = cv2.matchTemplate(gray_imposed, rc, cv2.TM_CCOEFF_NORMED)
                loc = np.where(res >= 0.82)  # ngưỡng nới vì đã cắt mép
                for pt in zip(*loc[::-1]):
                    boxes_s.append([int(pt[0] - ox), int(pt[1] - oy), int(full_w), int(full_h)])
                    scores_s.append(float(res[pt[1], pt[0]]))
                    angles_s.append(angle)
            return boxes_s, scores_s, angles_s

        def _nms(boxes_n, scores_n, angles_n):
            if not boxes_n:
                return [], [], []
            nms_thresh = 0.85 if is_packaging_mode else 0.3
            idx = cv2.dnn.NMSBoxes(boxes_n, scores_n, score_threshold=0.82, nms_threshold=nms_thresh)
            if len(idx) == 0:
                return [], [], []
            idx = idx.flatten()
            return (
                [boxes_n[i] for i in idx],
                [angles_n[i] for i in idx],
                [scores_n[i] for i in idx],
            )

        match_scale = 1.0
        _b, _s, _a = _scan_scale(1.0)
        matched_boxes, matched_angles, matched_scores = _nms(_b, _s, _a)

        if len(matched_boxes) == 0:
            # Cỡ gốc không thấy → thử các cỡ mà k bản (k=1..6) vừa khít mỗi chiều của tờ.
            cand = set()
            for k in range(1, 7):
                cand.add(round(iw / (tw * k), 3))
                cand.add(round(ih / (th * k), 3))
            cand = sorted(
                (c for c in cand if 0.15 <= c <= 3.0 and abs(c - 1.0) > 0.02),
                key=lambda c: abs(c - 1.0),
            )
            for sc in cand:
                _b, _s, _a = _scan_scale(sc)
                mb, ma, ms = _nms(_b, _s, _a)
                if mb:
                    matched_boxes, matched_angles, matched_scores, match_scale = mb, ma, ms, sc
                    logger.info(f"Imposition: tìm thấy mẫu ở tỉ lệ {sc:.3f}× ({len(mb)} bản)")
                    break

        # Nếu khớp ở tỉ lệ khác cỡ gốc → co giãn template (và alpha) về đúng tỉ lệ đó
        # để bước so pixel từng bản khớp đúng (template gốc ≠ cỡ bản trên tờ).
        if match_scale != 1.0:
            new_w = max(1, int(round(template.shape[1] * match_scale)))
            new_h = max(1, int(round(template.shape[0] * match_scale)))
            template = cv2.resize(template, (new_w, new_h), interpolation=cv2.INTER_AREA)
            if alpha_mask is not None:
                alpha_mask = cv2.resize(alpha_mask, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
            th, tw = template.shape[:2]

        # Short-circuit if template is entirely missing from this N-up sheet
        if len(matched_boxes) == 0:
            result.similarity_score = 0.0
            result.match_confidence = 0.0
            result.match_scale = match_scale
            result.diff_regions = [DiffRegion(
                x=0, y=0, width=iw, height=ih,
                area=iw*ih, severity="high",
                description="Không tìm thấy bản thiết kế trên tờ in này"
            )]
            result.diff_count = 1
            result.highlighted_image = None if analysis_only else imposed.copy()
            result.render_w = iw
            result.render_h = ih
            return result

        if (config or {}).get("_detect_only"):
            # Primitive cho bình bài tile: chỉ trả metadata dò trên preview; bước
            # verify full DPI ở ``compare_imposition_tiled`` sẽ đọc ROI từng bản.
            result._matched_boxes = matched_boxes
            result._matched_angles = matched_angles
            result._matched_scores = matched_scores
            result.match_scale = match_scale
            result.total_instances = len(matched_boxes)
            result.match_confidence = round(max(matched_scores), 6) if matched_scores else 0.0
            result.render_w = iw
            result.render_h = ih
            return result

        # 4. Micro-Comparison Process
        all_diff_regions = []
        total_diff_pixels = 0
        has_errors = False
        combined_overlay = imposed.copy()

        total_instances = len(matched_boxes)
        failed_instances = 0

        for idx, (x, y, w, h) in enumerate(matched_boxes):
            angle = matched_angles[idx]
            
            # Prepare correctly rotated template for pixel diffing
            if angle == 90:
                target_template = cv2.rotate(template, cv2.ROTATE_90_CLOCKWISE)
                target_alpha = cv2.rotate(alpha_mask, cv2.ROTATE_90_CLOCKWISE) if alpha_mask is not None else None
            elif angle == 180:
                target_template = cv2.rotate(template, cv2.ROTATE_180)
                target_alpha = cv2.rotate(alpha_mask, cv2.ROTATE_180) if alpha_mask is not None else None
            elif angle == 270:
                target_template = cv2.rotate(template, cv2.ROTATE_90_COUNTERCLOCKWISE)
                target_alpha = cv2.rotate(alpha_mask, cv2.ROTATE_90_COUNTERCLOCKWISE) if alpha_mask is not None else None
            else:
                target_template = template
                target_alpha = alpha_mask

            # Safely crop the instance from the imposed sheet
            y_start, y_end = max(0, y), min(ih, y + h)
            x_start, x_end = max(0, x), min(iw, x + w)
            sub_imposed = imposed[y_start:y_end, x_start:x_end]

            # NEVER use cv2.resize for absdiff as interpolation alters anti-aliasing pixels.
            # Instead, crop both to the exact minimum bounding intersection.
            min_h = min(sub_imposed.shape[0], target_template.shape[0])
            min_w = min(sub_imposed.shape[1], target_template.shape[1])
            
            clean_imposed = sub_imposed[:min_h, :min_w]
            clean_template = target_template[:min_h, :min_w]
            if tol_key != "STRICT":
                clean_imposed = self._align_to(clean_template, clean_imposed)

            # Pixel compare instance vs template — cùng threshold tolerance như 1:1
            clean_template_gray = cv2.cvtColor(clean_template, cv2.COLOR_RGB2GRAY) if len(clean_template.shape) == 3 else clean_template
            clean_imposed_gray = cv2.cvtColor(clean_imposed, cv2.COLOR_RGB2GRAY) if len(clean_imposed.shape) == 3 else clean_imposed
            try:
                import pdfcompare_native
                diff_mask = pdfcompare_native.fast_diff_mask_gray(clean_template_gray, clean_imposed_gray, thr)
            except (ImportError, AttributeError):
                diff_gray = cv2.absdiff(clean_template_gray, clean_imposed_gray)
                _, diff_mask = cv2.threshold(diff_gray, thr, 255, cv2.THRESH_BINARY)

            # Apply alpha content mask for packaging interlocks (ignores neighbor box bleeds crossing corners)
            if target_alpha is not None:
                clean_alpha = target_alpha[:min_h, :min_w]
                diff_mask = cv2.bitwise_and(diff_mask, clean_alpha)

            # Imposition noise: OPEN first (trừ STRICT — giữ nét mỏng trên 1 nhãn).
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
            if tol_key == "STRICT":
                diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
            else:
                diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_OPEN, kernel, iterations=1)
                diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_CLOSE, kernel, iterations=2)

            contours, _ = cv2.findContours(diff_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            instance_has_error = False
            instance_regions = []
            for cnt in contours:
                area = cv2.contourArea(cnt)
                rx, ry, rw, rh = cv2.boundingRect(cnt)
                if (config or {}).get("document_imposition_mode") and tol_key != "STRICT":
                    # Rendering an unchanged PDF page as a Form XObject can
                    # change a very thin glyph edge by subpixels. Ignore only
                    # tiny narrow contours in booklet mode; STRICT still reports
                    # them and substantive artwork changes remain above this cap.
                    dpi_scale = max(1.0, float(dpi) / 100.0)
                    aa_thin_px = max(4, int(round(4 * dpi_scale)))
                    aa_area_cap = max(60.0, 60.0 * dpi_scale * dpi_scale)
                    if min(rw, rh) <= aa_thin_px and area <= aa_area_cap:
                        cv2.drawContours(diff_mask, [cnt], -1, 0, thickness=-1)
                        continue
                if area < inst_min_area:
                    continue
                gx, gy = max(0, x) + rx, max(0, y) + ry
                region = DiffRegion(
                    x=gx, y=gy, width=rw, height=rh,
                    area=area,
                    severity="high",
                    description=f"Lỗi pixel {rw}x{rh}px trên bản #{idx + 1}",
                )
                instance_regions.append(region)
                total_diff_pixels += int(area)
                instance_has_error = True
                has_errors = True

            # Micro-rescue trên từng bản: mask còn pixel nhưng contour dưới sàn
            if not instance_has_error:
                nz = int(np.count_nonzero(diff_mask))
                micro_floor = 4 if tol_key == "STRICT" else 12
                if nz >= micro_floor:
                    ys, xs = np.where(diff_mask > 0)
                    if len(xs) > 0:
                        rx0, rx1 = int(xs.min()), int(xs.max())
                        ry0, ry1 = int(ys.min()), int(ys.max())
                        rw, rh = max(1, rx1 - rx0 + 1), max(1, ry1 - ry0 + 1)
                        region = DiffRegion(
                            x=max(0, x) + rx0, y=max(0, y) + ry0,
                            width=rw, height=rh, area=float(nz),
                            severity="high",
                            description=f"Lỗi pixel nhỏ trên bản #{idx + 1}",
                        )
                        instance_regions.append(region)
                        total_diff_pixels += nz
                        instance_has_error = True
                        has_errors = True

            all_diff_regions.extend(instance_regions)

            # Tracking box: xanh = OK, đỏ = lỗi trên bản
            box_color = (255, 0, 0) if instance_has_error else (0, 255, 0)
            if not analysis_only:
                cv2.rectangle(
                    combined_overlay,
                    (max(0, x), max(0, y)),
                    (min(iw, x + w), min(ih, y + h)),
                    box_color, 2,
                )

            if instance_has_error:
                failed_instances += 1

        # 5. Cluster nearby localized errors before finalizing
        if len(all_diff_regions) > 0:
            all_diff_regions = self._cluster_regions(all_diff_regions, merge_distance=25)

        # 6. Compile the final Imposition Verification Result
        result.diff_regions = all_diff_regions
        result.diff_count = len(all_diff_regions)
        result.similarity_score = round(100.0 - (total_diff_pixels / (iw * ih) * 100), 2)
        result.total_instances = total_instances
        result.failed_instances = failed_instances
        result.match_confidence = round(max(matched_scores), 6) if matched_scores else 0.0
        result.match_scale = match_scale
        result.render_w = iw
        result.render_h = ih
        
        # If there are errors, draw them and enable Spotlight GIF
        if analysis_only:
            result.highlighted_image = None
        elif has_errors:
            result.highlighted_image = combined_overlay.copy()
            for r in all_diff_regions:
                color = (255, 0, 0) if r.severity == "high" else (255, 165, 0)
                cv2.rectangle(result.highlighted_image, (r.x, r.y), (r.x + r.width, r.y + r.height), color, 4)
                
            frame_off, frame_on = self._create_spotlight_frames(combined_overlay, all_diff_regions)
            result.gif_image = self._generate_gif(frame_off, frame_on, duration_ms=600)
        else:
            result.highlighted_image = combined_overlay
            
        return result

    def compare_imposition_tiled(
        self,
        template: np.ndarray,
        read_imposed: Callable[[int, int, int, int], np.ndarray],
        imposed_width: int,
        imposed_height: int,
        *,
        preview_template: np.ndarray,
        preview_imposed: np.ndarray,
        tolerance: str = "NORMAL",
        is_packaging_mode: bool = False,
        config: dict | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> ComparisonResult:
        """Dò bình bài trên preview, verify từng bản bằng ROI full DPI.

        PERF (audit 2026-08-20 §IMPOSITION.TILE): ``matchTemplate`` không còn nhận
        raster tờ bình full DPI. Hợp đồng morphology/thống kê được giữ nguyên với
        ``_compare_imposition``; khác biệt duy nhất là nguồn ``sub_imposed`` đến từ
        reader ROI và artifact có thể được dựng theo stripe ở tầng engine.
        """
        import cv2

        imposed_width = int(imposed_width)
        imposed_height = int(imposed_height)
        detection_config = dict(config or {})
        detection_config["_detect_only"] = True
        detection_config["_analysis_only"] = True
        detected = self._compare_imposition(
            preview_template,
            preview_imposed,
            is_packaging_mode=is_packaging_mode,
            tolerance=tolerance,
            config=detection_config,
        )
        result = ComparisonResult(is_imposition_mode=True, is_tiled=True)
        result.render_w = imposed_width
        result.render_h = imposed_height
        result.match_scale = float(getattr(detected, "match_scale", 1.0))
        result.match_confidence = float(getattr(detected, "match_confidence", 0.0))
        boxes_preview = list(getattr(detected, "_matched_boxes", []))
        angles = list(getattr(detected, "_matched_angles", []))
        scores = list(getattr(detected, "_matched_scores", []))
        if not boxes_preview:
            result.similarity_score = 0.0
            result.diff_regions = [DiffRegion(
                x=0,
                y=0,
                width=imposed_width,
                height=imposed_height,
                area=imposed_width * imposed_height,
                severity="high",
                description="Không tìm thấy bản thiết kế trên tờ in này",
            )]
            result.diff_count = 1
            result.total_instances = 0
            return result

        preview_height, preview_width = preview_imposed.shape[:2]
        scale_x = imposed_width / float(preview_width)
        scale_y = imposed_height / float(preview_height)
        matched_boxes = [
            [
                int(round(box[0] * scale_x)),
                int(round(box[1] * scale_y)),
                max(1, int(round(box[2] * scale_x))),
                max(1, int(round(box[3] * scale_y))),
            ]
            for box in boxes_preview
        ]

        # Áp TrimBox/bleed lên template full DPI đúng như detector preview.
        template_for_compare = template
        trim_insets = (config or {}).get("template_trim_insets")
        if trim_insets is None:
            edge = float((config or {}).get("imposition_bleed_ignore_ratio", 0.0) or 0.0)
            if edge > 0:
                trim_insets = (edge, edge, edge, edge)
        if trim_insets is not None:
            try:
                left, top, right, bottom = [
                    max(0.0, min(0.45, float(v))) for v in trim_insets
                ]
                source_height, source_width = template.shape[:2]
                x0 = int(round(source_width * left))
                y0 = int(round(source_height * top))
                x1 = int(round(source_width * (1.0 - right)))
                y1 = int(round(source_height * (1.0 - bottom)))
                if x1 - x0 >= 16 and y1 - y0 >= 16:
                    template_for_compare = template[y0:y1, x0:x1]
            except (TypeError, ValueError):
                logger.warning("Invalid template_trim_insets ignored: %r", trim_insets)

        match_scale = result.match_scale
        if match_scale != 1.0:
            new_width = max(1, int(round(template_for_compare.shape[1] * match_scale)))
            new_height = max(1, int(round(template_for_compare.shape[0] * match_scale)))
            template_for_compare = cv2.resize(
                template_for_compare,
                (new_width, new_height),
                interpolation=cv2.INTER_AREA,
            )

        template_height, template_width = template_for_compare.shape[:2]
        alpha_mask = None
        if is_packaging_mode:
            gray_template = cv2.cvtColor(
                template_for_compare, cv2.COLOR_RGB2GRAY
            ) if template_for_compare.ndim == 3 else template_for_compare
            ff_mask = np.zeros((template_height + 2, template_width + 2), np.uint8)
            fill_image = gray_template.copy()
            corners = [
                (0, 0),
                (template_width - 1, 0),
                (0, template_height - 1),
                (template_width - 1, template_height - 1),
            ]
            for point in corners:
                if fill_image[point[1], point[0]] >= 240:
                    cv2.floodFill(fill_image, ff_mask, point, 0, loDiff=10, upDiff=10)
            alpha_mask = (1 - ff_mask[1:-1, 1:-1]) * 255

        tol_key = (tolerance or "NORMAL").upper()
        threshold = TOLERANCE_THRESHOLDS.get(tol_key, 13)
        dpi = (config or {}).get("dpi", 150) or 150
        min_area = 8 if tol_key == "STRICT" else (20 if tol_key == "NORMAL" else 40)
        min_area = max(4, int(min_area * min((float(dpi) / 150.0) ** 2, 2.0)))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        all_diff_regions = []
        total_diff_pixels = 0
        failed_instances = 0
        tracking_boxes = []

        def read_padded(x: int, y: int, width: int, height: int):
            output = np.full((height, width, 3), 255, dtype=np.uint8)
            inside_x0 = max(0, x)
            inside_y0 = max(0, y)
            inside_x1 = min(imposed_width, x + width)
            inside_y1 = min(imposed_height, y + height)
            if inside_x1 > inside_x0 and inside_y1 > inside_y0:
                patch = read_imposed(
                    inside_x0,
                    inside_y0,
                    inside_x1 - inside_x0,
                    inside_y1 - inside_y0,
                )
                output[
                    inside_y0 - y:inside_y1 - y,
                    inside_x0 - x:inside_x1 - x,
                ] = patch
            return output

        for index, (box, angle) in enumerate(zip(matched_boxes, angles)):
            if cancel_check is not None and cancel_check():
                raise InterruptedError("Đã hủy khi verify các bản bình bài")
            x, y, width, height = box
            if angle == 90:
                target_template = cv2.rotate(template_for_compare, cv2.ROTATE_90_CLOCKWISE)
                target_alpha = cv2.rotate(alpha_mask, cv2.ROTATE_90_CLOCKWISE) if alpha_mask is not None else None
            elif angle == 180:
                target_template = cv2.rotate(template_for_compare, cv2.ROTATE_180)
                target_alpha = cv2.rotate(alpha_mask, cv2.ROTATE_180) if alpha_mask is not None else None
            elif angle == 270:
                target_template = cv2.rotate(template_for_compare, cv2.ROTATE_90_COUNTERCLOCKWISE)
                target_alpha = cv2.rotate(alpha_mask, cv2.ROTATE_90_COUNTERCLOCKWISE) if alpha_mask is not None else None
            else:
                target_template = template_for_compare
                target_alpha = alpha_mask

            sub_imposed = read_padded(x, y, width, height)
            min_height = min(sub_imposed.shape[0], target_template.shape[0])
            min_width = min(sub_imposed.shape[1], target_template.shape[1])
            clean_imposed = sub_imposed[:min_height, :min_width]
            clean_template = target_template[:min_height, :min_width]
            if tol_key != "STRICT":
                clean_imposed = self._align_to(clean_template, clean_imposed)
            gray_template = cv2.cvtColor(clean_template, cv2.COLOR_RGB2GRAY) if clean_template.ndim == 3 else clean_template
            gray_imposed = cv2.cvtColor(clean_imposed, cv2.COLOR_RGB2GRAY) if clean_imposed.ndim == 3 else clean_imposed
            try:
                import pdfcompare_native
                diff_mask = pdfcompare_native.fast_diff_mask_gray(gray_template, gray_imposed, threshold)
            except (ImportError, AttributeError):
                diff_gray = cv2.absdiff(gray_template, gray_imposed)
                _, diff_mask = cv2.threshold(diff_gray, threshold, 255, cv2.THRESH_BINARY)
            if target_alpha is not None:
                diff_mask = cv2.bitwise_and(diff_mask, target_alpha[:min_height, :min_width])
            if tol_key == "STRICT":
                diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
            else:
                diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_OPEN, kernel, iterations=1)
                diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_CLOSE, kernel, iterations=2)

            contours, _ = cv2.findContours(diff_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            instance_regions = []
            instance_has_error = False
            for contour in contours:
                area = cv2.contourArea(contour)
                rx, ry, rw, rh = cv2.boundingRect(contour)
                if (config or {}).get("document_imposition_mode") and tol_key != "STRICT":
                    dpi_scale = max(1.0, float(dpi) / 100.0)
                    if min(rw, rh) <= max(4, int(round(4 * dpi_scale))) and area <= max(60.0, 60.0 * dpi_scale * dpi_scale):
                        cv2.drawContours(diff_mask, [contour], -1, 0, thickness=-1)
                        continue
                if area < min_area:
                    continue
                region = DiffRegion(
                    x=max(0, x) + rx,
                    y=max(0, y) + ry,
                    width=rw,
                    height=rh,
                    area=area,
                    severity="high",
                    description=f"Lỗi pixel {rw}x{rh}px trên bản #{index + 1}",
                )
                instance_regions.append(region)
                total_diff_pixels += int(area)
                instance_has_error = True
            if not instance_has_error:
                nonzero = int(np.count_nonzero(diff_mask))
                if nonzero >= (4 if tol_key == "STRICT" else 12):
                    ys, xs = np.where(diff_mask > 0)
                    if len(xs) > 0:
                        rx0, rx1 = int(xs.min()), int(xs.max())
                        ry0, ry1 = int(ys.min()), int(ys.max())
                        rw, rh = max(1, rx1 - rx0 + 1), max(1, ry1 - ry0 + 1)
                        instance_regions.append(DiffRegion(
                            x=max(0, x) + rx0,
                            y=max(0, y) + ry0,
                            width=rw,
                            height=rh,
                            area=float(nonzero),
                            severity="high",
                            description=f"Lỗi pixel nhỏ trên bản #{index + 1}",
                        ))
                        total_diff_pixels += nonzero
                        instance_has_error = True
            all_diff_regions.extend(instance_regions)
            tracking_boxes.append((x, y, width, height, instance_has_error))
            if instance_has_error:
                failed_instances += 1

        result.diff_regions = self._cluster_regions(all_diff_regions, merge_distance=25) if all_diff_regions else []
        result.diff_count = len(result.diff_regions)
        result.similarity_score = round(100.0 - (total_diff_pixels / (imposed_width * imposed_height) * 100), 2)
        result.total_instances = len(matched_boxes)
        result.failed_instances = failed_instances
        result.match_confidence = round(max(scores), 6) if scores else result.match_confidence
        result._imposition_tracking_boxes = tracking_boxes
        result._imposition_read_region = read_imposed
        if result.diff_regions:
            preview_regions = [
                DiffRegion(
                    x=int(round(region.x / scale_x)),
                    y=int(round(region.y / scale_y)),
                    width=max(1, int(round(region.width / scale_x))),
                    height=max(1, int(round(region.height / scale_y))),
                    area=region.area / (scale_x * scale_y),
                    severity=region.severity,
                    description=region.description,
                )
                for region in result.diff_regions
            ]
            frame_off, frame_on = self._create_spotlight_frames(
                preview_imposed, preview_regions
            )
            result.gif_image = self._generate_gif(frame_off, frame_on, duration_ms=600)
        return result

    def _cluster_regions(
        self, regions: list[DiffRegion], merge_distance: int = 20
    ) -> list[DiffRegion]:
        """
        Merge nearby regions to avoid fragmented detection.
        Uses simple bounding box expansion + overlap detection.
        """
        if len(regions) <= 1:
            return regions

        # Convert to rectangles with padding
        rects = []
        for r in regions:
            rects.append([
                r.x - merge_distance,
                r.y - merge_distance,
                r.x + r.width + merge_distance,
                r.y + r.height + merge_distance,
                r.area,
            ])

        # Simple greedy merge
        merged = True
        while merged:
            merged = False
            new_rects = []
            used = set()

            for i in range(len(rects)):
                if i in used:
                    continue
                current = list(rects[i])

                for j in range(i + 1, len(rects)):
                    if j in used:
                        continue
                    other = rects[j]

                    # Check overlap
                    if (current[0] <= other[2] and current[2] >= other[0] and
                            current[1] <= other[3] and current[3] >= other[1]):
                        # Merge
                        current[0] = min(current[0], other[0])
                        current[1] = min(current[1], other[1])
                        current[2] = max(current[2], other[2])
                        current[3] = max(current[3], other[3])
                        current[4] += other[4]
                        used.add(j)
                        merged = True

                new_rects.append(current)
            rects = new_rects

        # Convert back to DiffRegion
        result_regions = []
        for r in rects:
            x = max(0, r[0] + merge_distance)
            y = max(0, r[1] + merge_distance)
            w = (r[2] - merge_distance) - x
            h = (r[3] - merge_distance) - y
            area = r[4]

            if w > 0 and h > 0:
                severity = "high" if area > 5000 else ("medium" if area > 500 else "low")
                result_regions.append(DiffRegion(
                    x=x, y=y, width=w, height=h,
                    area=area, severity=severity,
                    description=f"Vùng thay đổi {w}x{h}px"
                ))

        return result_regions
