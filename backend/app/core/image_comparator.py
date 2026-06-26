"""
Image Comparator — Compare two images using SSIM, pixel diff, and CMYK analysis.

Algorithm reference: Formartha/compare-pdf (cv2.absdiff, np.array_equal)
Enhanced with SSIM, contour detection, region clustering, and CMYK channel diff.
License: OpenCV (Apache 2.0), scikit-image (BSD), Pillow (MIT-like)
"""
import logging
from dataclasses import dataclass, field

import cv2
import numpy as np
from skimage.metrics import structural_similarity as ssim
from PIL import Image
import io

logger = logging.getLogger(__name__)


# ── Tolerance thresholds ────────────────────────────────
TOLERANCE_THRESHOLDS = {
    "STRICT": 0,      # Mọi pixel khác nhau đều báo
    "NORMAL": 13,     # ~5% of 255 — bỏ qua anti-aliasing nhỏ
    "LOOSE": 38,      # ~15% of 255 — chỉ báo thay đổi lớn
}


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
    gif_image: bytes | None = None
    diff_pixel_percentage: float = 0.0
    is_imposition_mode: bool = False
    total_instances: int = 0
    failed_instances: int = 0
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

        area1 = float(w1 * h1)
        area2 = float(w2 * h2)
        asp1 = (w1 / h1) if h1 else 1.0
        asp2 = (w2 / h2) if h2 else 1.0
        size_eq = (abs(w1 - w2) <= 0.02 * max(w1, w2)) and (abs(h1 - h2) <= 0.02 * max(h1, h2))
        aspect_close = abs(asp1 - asp2) <= 0.06 * max(asp1, asp2, 1e-6)
        area_ratio = (max(area1, area2) / min(area1, area2)) if min(area1, area2) > 0 else 1.0
        IMPOSITION_AREA_RATIO = 1.8

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
                return self._compare_imposition(template=img1, imposed=img2, is_packaging_mode=is_packaging)
            else:
                logger.info(f"Imposition Mode: Image 1 lớn hơn (area {area_ratio:.2f}×). Packaging: {is_packaging}")
                return self._compare_imposition(template=img2, imposed=img1, is_packaging_mode=is_packaging)

        # Step 1.5: Ensure same dimensions if standard 1:1 mode
        img1, img2 = self._normalize_dimensions(img1, img2)

        # Step 1.6: Căn chỉnh dịch chuyển (registration) — bù lệch vài px giữa A/B
        # (render khác nhau, page box lệch...) để tránh absdiff bùng viền giả.
        img2 = self._align_to(img1, img2)

        # Ngưỡng diện tích nhiễu scale theo DPI (gốc 50px² @150DPI). Ở 300DPI mật độ
        # pixel gấp 4 → ngưỡng ×4 để mức lọc nhiễu tương đương giữa các DPI.
        dpi = (config or {}).get("dpi", 150) or 150
        eff_min_area = max(1, int(min_contour_area * (dpi / 150.0) ** 2))

        # Step 2: Convert to grayscale for SSIM
        gray1 = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY) if len(img1.shape) == 3 else img1
        gray2 = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY) if len(img2.shape) == 3 else img2

        # Step 3: SSIM
        score, diff_map = ssim(gray1, gray2, full=True)
        result.similarity_score = round(score * 100, 2)

        # Step 4 & 5: Pixel difference and Thresholding
        threshold_val = TOLERANCE_THRESHOLDS.get(tolerance, 13)
        
        from app.core.gpu_accelerator import GPUAccelerator
        gpu = GPUAccelerator.get_instance()
        
        if gpu.is_available:
            # VRAM Accelerated Processing
            binary_mask = gpu.compute_diff_mask(gray1, gray2, threshold_val)
        else:
            # CPU Native Processing
            try:
                import pdfcompare_native
                # Use Rust extension for massive speedup & 50% less RAM usage (Zero-copy single-pass)
                binary_mask = pdfcompare_native.fast_diff_mask_gray(gray1, gray2, threshold_val)
            except (ImportError, AttributeError) as e:
                logger.warning(f"Rust native pixel diff failed/unavailable: {e}. Falling back to OpenCV CPU.")
                if len(img1.shape) == 3:
                    abs_diff = cv2.absdiff(img1, img2)
                    diff_gray = cv2.cvtColor(abs_diff, cv2.COLOR_RGB2GRAY)
                else:
                    diff_gray = cv2.absdiff(gray1, gray2)
                _, binary_mask = cv2.threshold(diff_gray, threshold_val, 255, cv2.THRESH_BINARY)

        # Morphological operations to reduce noise
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_OPEN, kernel, iterations=1)

        result.diff_mask = binary_mask
        # Toạ độ vùng khác biệt nằm trong KÍCH THƯỚC LÀM VIỆC (img2 sau normalize/scale)
        result.render_w = img2.shape[1]
        result.render_h = img2.shape[0]

        # Calculate diff pixel percentage
        total_pixels = binary_mask.shape[0] * binary_mask.shape[1]
        diff_pixels = np.count_nonzero(binary_mask)
        result.diff_pixel_percentage = round(diff_pixels / total_pixels * 100, 3)

        # Step 6: Find contours (diff regions)
        contours, _ = cv2.findContours(
            binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        regions = []
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < eff_min_area:
                continue
            x, y, w, h = cv2.boundingRect(contour)
            severity = self._classify_severity(area, total_pixels)
            regions.append(DiffRegion(
                x=x, y=y, width=w, height=h,
                area=area, severity=severity,
                description=f"Vùng thay đổi {w}x{h}px"
            ))

        # Cluster nearby regions
        regions = self._cluster_regions(regions, merge_distance=20)

        result.diff_regions = regions
        result.diff_count = len(regions)

        # Generate highlighted image
        result.highlighted_image = self.highlight_differences(
            img2.copy(), binary_mask, regions
        )

        # Generate animated GIF if there are differences
        if len(regions) > 0:
            frame_off, frame_on = self._create_spotlight_frames(img2, regions)
            result.gif_image = self._generate_gif(frame_off, frame_on, duration_ms=600)

        logger.info(
            f"Comparison: {result.similarity_score}% similar, "
            f"{result.diff_count} regions, {result.diff_pixel_percentage}% pixels differ"
        )

        return result

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
            score, _ = ssim(gray1, gray2, full=True)
            result.similarity_score = round(score * 100, 2)
            return result

        # STEP 2: Augment each real diff region with CMYK channel breakdown
        if len(result.diff_regions) > 0 and cmyk1.shape == cmyk2.shape:
            channel_names = ["C", "M", "Y", "K"]
            for region in result.diff_regions:
                x, y, w, h = region.x, region.y, region.width, region.height
                # Safely crop the region from both CMYK arrays
                y2 = min(y + h, cmyk1.shape[0])
                x2 = min(x + w, cmyk1.shape[1])
                patch1 = cmyk1[y:y2, x:x2].astype(np.float32)
                patch2 = cmyk2[y:y2, x:x2].astype(np.float32)
                
                if patch1.size == 0 or patch2.size == 0:
                    continue
                
                # Calculate per-channel max difference in this region
                channel_diffs = []
                for ci, cname in enumerate(channel_names):
                    ch_diff = np.abs(patch1[:, :, ci] - patch2[:, :, ci]).mean()
                    if ch_diff > 5:  # Only report channels with meaningful difference
                        channel_diffs.append(f"{cname}Δ{ch_diff:.0f}")
                
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
        
        # 1. Create the dark base frame (dim the image by 60%)
        # Convert to float for safe multiplication, then back to uint8
        dark_base = (img.astype(np.float32) * 0.4).astype(np.uint8)
        
        frame_off = dark_base.copy()
        frame_on = dark_base.copy()
        
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
        overlay = image.copy()

        severity_colors = {
            "high": (239, 68, 68),     # Red
            "medium": (251, 146, 60),  # Orange
            "low": (250, 204, 21),     # Yellow
        }

        for region in regions:
            color = severity_colors.get(region.severity, (239, 68, 68))
            x, y, w, h = region.x, region.y, region.width, region.height

            # Semi-transparent fill
            cv2.rectangle(overlay, (x, y), (x + w, y + h), color, -1)

            # Solid border
            cv2.rectangle(image, (x, y), (x + w, y + h), color, 2)

        # Blend overlay
        result = cv2.addWeighted(overlay, overlay_alpha, image, 1 - overlay_alpha, 0)
        return result

    def _align_to(self, ref: np.ndarray, mov: np.ndarray) -> np.ndarray:
        """Căn chỉnh dịch chuyển `mov` cho khớp `ref` bằng phase correlation.

        Chỉ bù DỊCH (translation) nhỏ — không xoay/co giãn — để tránh báo khác biệt
        giả khi 2 trang lệch vài pixel. An toàn: bỏ qua nếu tương quan yếu (có thể là
        2 trang khác nội dung) hoặc dịch quá lớn (vượt ngưỡng → không phải lệch nhỏ).
        Dùng BORDER_REPLICATE để không tạo viền đen gây diff mới.
        """
        try:
            g1 = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY) if ref.ndim == 3 else ref
            g2 = cv2.cvtColor(mov, cv2.COLOR_RGB2GRAY) if mov.ndim == 3 else mov
            h, w = g1.shape[:2]
            (dx, dy), resp = cv2.phaseCorrelate(np.float32(g1), np.float32(g2))
            max_shift = max(8.0, 0.02 * max(h, w))
            if resp < 0.2:
                return mov  # tương quan yếu → có thể khác nội dung, không ép dịch
            if abs(dx) > max_shift or abs(dy) > max_shift:
                return mov  # lệch quá lớn → không phải "lệch nhỏ", giữ nguyên
            if abs(dx) < 0.5 and abs(dy) < 0.5:
                return mov  # gần như không lệch
            M = np.float32([[1, 0, -dx], [0, 1, -dy]])
            return cv2.warpAffine(mov, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        except Exception as e:
            logger.warning(f"Image alignment skipped: {e}")
            return mov

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

    def _compare_imposition(self, template: np.ndarray, imposed: np.ndarray, is_packaging_mode: bool = False) -> ComparisonResult:
        """
        Advanced Imposition Verification: 
        Finds occurrences of `template` 1-up inside `imposed` N-up sheet.
        Supports 4-way rotation (0, 90, 180, 270) and Bleed Tolerance Cropping!
        """
        result = ComparisonResult()
        result.is_imposition_mode = True
        ih, iw = imposed.shape[:2]
        
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
                return [], []
            nms_thresh = 0.85 if is_packaging_mode else 0.3
            idx = cv2.dnn.NMSBoxes(boxes_n, scores_n, score_threshold=0.82, nms_threshold=nms_thresh)
            if len(idx) == 0:
                return [], []
            idx = idx.flatten()
            return [boxes_n[i] for i in idx], [angles_n[i] for i in idx]

        match_scale = 1.0
        _b, _s, _a = _scan_scale(1.0)
        matched_boxes, matched_angles = _nms(_b, _s, _a)

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
                mb, ma = _nms(_b, _s, _a)
                if mb:
                    matched_boxes, matched_angles, match_scale = mb, ma, sc
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
            result.diff_regions = [DiffRegion(
                x=0, y=0, width=iw, height=ih,
                area=iw*ih, severity="high",
                description="Không tìm thấy bản thiết kế trên tờ in này"
            )]
            result.diff_count = 1
            result.highlighted_image = imposed.copy()
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

            # Use Rust extension for massive speedup if available
            try:
                import pdfcompare_native
                clean_template_gray = cv2.cvtColor(clean_template, cv2.COLOR_RGB2GRAY) if len(clean_template.shape) == 3 else clean_template
                clean_imposed_gray = cv2.cvtColor(clean_imposed, cv2.COLOR_RGB2GRAY) if len(clean_imposed.shape) == 3 else clean_imposed
                diff_mask = pdfcompare_native.fast_diff_mask_gray(clean_template_gray, clean_imposed_gray, 30)
            except (ImportError, AttributeError):
                diff = cv2.absdiff(clean_template, clean_imposed)
                diff_gray = cv2.cvtColor(diff, cv2.COLOR_RGB2GRAY) if len(diff.shape) == 3 else diff
                _, diff_mask = cv2.threshold(diff_gray, 30, 255, cv2.THRESH_BINARY)
            
            # Apply alpha content mask for packaging interlocks (ignores neighbor box bleeds crossing corners)
            if target_alpha is not None:
                clean_alpha = target_alpha[:min_h, :min_w]
                diff_mask = cv2.bitwise_and(diff_mask, clean_alpha)
            
            # CRITICAL: For imposition, we MUST run MORPH_OPEN first to obliterate 1-pixel 
            # alignment noise lines BEFORE running MORPH_CLOSE (which would thicken them).
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
            diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_OPEN, kernel, iterations=1)
            diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
            
            contours, _ = cv2.findContours(diff_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

            instance_has_error = False
            for cnt in contours:
                area = cv2.contourArea(cnt)
                if area > 20: 
                    rx, ry, rw, rh = cv2.boundingRect(cnt)
                    gx, gy = max(0, x) + rx, max(0, y) + ry
                    
                    region = DiffRegion(
                        x=gx, y=gy, width=rw, height=rh,
                        area=area, severity="high" if area > 200 else "medium",
                        description=f"Lỗi {rw}x{rh}px trên bản in"
                    )
                    all_diff_regions.append(region)
                    total_diff_pixels += int(area)
                    instance_has_error = True
                    has_errors = True
            
            # Draw tracking boundary box (Optional: we can leave it or remove it. Let's keep the green box)
            cv2.rectangle(combined_overlay, (max(0, x), max(0, y)), (min(iw, x + w), min(ih, y + h)), (0, 255, 0), 2)
            
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
        result.render_w = iw
        result.render_h = ih
        
        # If there are errors, draw them and enable Spotlight GIF
        if has_errors:
            result.highlighted_image = combined_overlay.copy()
            for r in all_diff_regions:
                color = (255, 0, 0) if r.severity == "high" else (255, 165, 0)
                cv2.rectangle(result.highlighted_image, (r.x, r.y), (r.x + r.width, r.y + r.height), color, 4)
                
            frame_off, frame_on = self._create_spotlight_frames(combined_overlay, all_diff_regions)
            result.gif_image = self._generate_gif(frame_off, frame_on, duration_ms=600)
        else:
            result.highlighted_image = combined_overlay
            
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
