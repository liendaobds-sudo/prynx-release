"""
Highlight Renderer — Generate diff overlay images for the frontend.

Reference: pdf-diff (draw_red_boxes, render_changes)
"""
import os
import logging
import struct
import zlib
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image

from app.config import settings
from app.core.license_guard import result_access_url

logger = logging.getLogger(__name__)


class HighlightRenderer:
    """Render highlighted diff images and save to disk."""

    def save_highlighted_image(
        self,
        image: np.ndarray,
        job_id: str,
        page_number: int,
    ) -> str:
        """Save highlighted image to results directory, return relative URL."""
        output_dir = Path(settings.RESULTS_DIR) / str(job_id)
        output_dir.mkdir(parents=True, exist_ok=True)

        filename = f"page_{page_number}_diff.png"
        filepath = output_dir / filename

        # Convert RGB to BGR for OpenCV save
        if len(image.shape) == 3 and image.shape[2] == 3:
            bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        else:
            bgr = image

        if not cv2.imwrite(str(filepath), bgr):
            # OpenCV trả False (không ném exception) khi codec/đĩa ghi thất bại.
            # Nâng thành lỗi để pipeline rollback PageResult và dọn artifact dở dang.
            raise OSError(f"Không ghi được ảnh khác biệt: {filepath}")
        logger.info(f"Saved highlight: {filepath}")

        return result_access_url(f"/results/{job_id}/{filename}")

    def save_highlighted_png_bytes(
        self,
        png_bytes: bytes,
        job_id: str,
        page_number: int,
        *,
        sign_url: bool = True,
    ) -> str:
        """PERF (audit 2026-08-13 §PB-2): ghi PNG đã được worker so sánh encode sẵn.

        Encode (phần tốn CPU) chạy trong pool so-ảnh; main thread chỉ ghi bytes để
        rút ngắn sàn tuần tự của pipeline trên tài liệu dài. Lỗi ghi đĩa ném OSError
        tự nhiên — cùng đường rollback/dọn artifact với ``save_highlighted_image``.
        """
        output_dir = Path(settings.RESULTS_DIR) / str(job_id)
        output_dir.mkdir(parents=True, exist_ok=True)

        filename = f"page_{page_number}_diff.png"
        filepath = output_dir / filename

        with open(filepath, "wb") as f:
            f.write(png_bytes)
        logger.info(f"Saved highlight: {filepath}")

        path = f"/results/{job_id}/{filename}"
        return result_access_url(path) if sign_url else path

    def save_tiled_highlight_image(
        self,
        read_region: Callable[[int, int, int, int], np.ndarray],
        regions: list,
        page_width: int,
        page_height: int,
        job_id: str,
        page_number: int,
        *,
        stripe_height: int = 256,
        cancel_check: Callable[[], bool] | None = None,
        sign_url: bool = True,
        tracking_boxes: list[tuple[int, int, int, int, bool]] | None = None,
        imposition_mode: bool = False,
    ) -> str:
        """Ghi PNG highlight theo stripe, không cấp phát raster toàn trang.

        PERF (audit 2026-08-19 §CL.3): PNG được phát từng scanline RGB với filter 0.
        Mỗi stripe áp đúng thứ tự blend + rectangle của ``highlight_differences``;
        file ``.part`` chỉ được đổi tên khi đã ghi đủ để hủy/lỗi không lộ artifact dở.
        """
        page_width = int(page_width)
        page_height = int(page_height)
        stripe_height = max(16, int(stripe_height))
        if page_width <= 0 or page_height <= 0:
            raise ValueError("Kích thước ảnh highlight phải lớn hơn 0")

        output_dir = Path(settings.RESULTS_DIR) / str(job_id)
        output_dir.mkdir(parents=True, exist_ok=True)
        filename = f"page_{page_number}_diff.png"
        filepath = output_dir / filename
        partial_path = filepath.with_suffix(filepath.suffix + ".part")
        compressor = zlib.compressobj(level=6)

        def _write_chunk(stream, chunk_type: bytes, payload: bytes) -> None:
            stream.write(struct.pack(">I", len(payload)))
            stream.write(chunk_type)
            stream.write(payload)
            checksum = zlib.crc32(chunk_type)
            checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
            stream.write(struct.pack(">I", checksum))

        try:
            with open(partial_path, "wb") as stream:
                stream.write(b"\x89PNG\r\n\x1a\n")
                _write_chunk(
                    stream,
                    b"IHDR",
                    struct.pack(">IIBBBBB", page_width, page_height, 8, 2, 0, 0, 0),
                )
                for y in range(0, page_height, stripe_height):
                    if cancel_check is not None and cancel_check():
                        raise InterruptedError("Đã hủy khi đang dựng ảnh khác biệt")
                    height = min(stripe_height, page_height - y)
                    stripe = np.ascontiguousarray(
                        read_region(0, y, page_width, height)
                    )
                    if stripe.shape[:2] != (height, page_width):
                        raise ValueError(
                            "Reader highlight trả sai kích thước stripe: "
                            f"{stripe.shape[:2]} thay vì {(height, page_width)}"
                        )
                    if stripe.ndim != 3 or stripe.shape[2] != 3:
                        raise ValueError("Ảnh highlight tile phải là RGB 3 kênh")
                    self._apply_highlights_to_stripe(
                        stripe,
                        y,
                        regions,
                        tracking_boxes=tracking_boxes,
                        imposition_mode=imposition_mode,
                    )

                    raw = b"".join(
                        b"\x00" + np.ascontiguousarray(row).tobytes()
                        for row in stripe
                    )
                    encoded = compressor.compress(raw)
                    if encoded:
                        _write_chunk(stream, b"IDAT", encoded)

                tail = compressor.flush()
                if tail:
                    _write_chunk(stream, b"IDAT", tail)
                _write_chunk(stream, b"IEND", b"")
            os.replace(partial_path, filepath)
        except Exception:
            partial_path.unlink(missing_ok=True)
            raise

        logger.info("Saved tiled highlight: %s", filepath)
        path = f"/results/{job_id}/{filename}"
        return result_access_url(path) if sign_url else path

    def _apply_highlights_to_stripe(
        self,
        stripe: np.ndarray,
        stripe_y: int,
        regions: list,
        overlay_alpha: float = 0.4,
        tracking_boxes: list[tuple[int, int, int, int, bool]] | None = None,
        imposition_mode: bool = False,
    ) -> None:
        """Áp overlay theo tọa độ toàn trang lên một stripe RGB."""
        colors = {
            "high": (239, 68, 68),
            "medium": (251, 146, 60),
            "low": (250, 204, 21),
        }
        stripe_height, page_width = stripe.shape[:2]
        stripe_bottom = stripe_y + stripe_height
        if tracking_boxes:
            for x, y, width, height, failed in tracking_boxes:
                color = (255, 0, 0) if failed else (0, 255, 0)
                cv2.rectangle(
                    stripe,
                    (max(0, int(x)), int(y) - stripe_y),
                    (min(page_width, int(x + width)), int(y + height) - stripe_y),
                    color,
                    2,
                )
        if imposition_mode:
            for region in regions:
                cv2.rectangle(
                    stripe,
                    (max(0, int(region.x)), int(region.y) - stripe_y),
                    (
                        min(page_width, int(region.x + region.width)),
                        int(region.y + region.height) - stripe_y,
                    ),
                    (255, 0, 0),
                    4,
                )
            return
        for region in regions:
            color = colors.get(region.severity, (239, 68, 68))
            x1 = max(0, int(region.x))
            y1 = max(0, int(region.y))
            x2 = min(page_width, int(region.x + region.width))
            y2 = int(region.y + region.height)
            blend_y1 = max(stripe_y, y1)
            blend_y2 = min(stripe_bottom, y2)
            if x2 > x1 and blend_y2 > blend_y1:
                roi = stripe[blend_y1 - stripe_y:blend_y2 - stripe_y, x1:x2]
                tint = np.empty_like(roi)
                tint[...] = color
                cv2.addWeighted(
                    tint, overlay_alpha, roi, 1 - overlay_alpha, 0, dst=roi
                )
            # Giữ tọa độ y ngoài stripe để OpenCV chỉ clip bốn cạnh thật của
            # rectangle, không vẽ thêm đường ngang giả ở biên stripe.
            cv2.rectangle(
                stripe,
                (x1, y1 - stripe_y),
                (x2, y2 - stripe_y),
                color,
                2,
            )

    def save_gif_image(
        self,
        gif_bytes: bytes,
        job_id: str,
        page_number: int,
        *,
        sign_url: bool = True,
    ) -> str:
        """Save an animated GIF to results directory."""
        output_dir = Path(settings.RESULTS_DIR) / str(job_id)
        output_dir.mkdir(parents=True, exist_ok=True)

        filename = f"page_{page_number}_anim.gif"
        filepath = output_dir / filename

        with open(filepath, "wb") as f:
            f.write(gif_bytes)

        logger.info(f"Saved GIF: {filepath}")

        path = f"/results/{job_id}/{filename}"
        return result_access_url(path) if sign_url else path

    def save_page_image(
        self,
        image: np.ndarray,
        job_id: str,
        page_number: int,
        prefix: str = "page",
    ) -> str:
        """Save a page image (original or modified) to results directory."""
        output_dir = Path(settings.RESULTS_DIR) / str(job_id)
        output_dir.mkdir(parents=True, exist_ok=True)

        filename = f"{prefix}_{page_number}.png"
        filepath = output_dir / filename

        if len(image.shape) == 3 and image.shape[2] == 3:
            pil_img = Image.fromarray(image)
        else:
            pil_img = Image.fromarray(image)

        pil_img.save(str(filepath), "PNG", optimize=True)
        return result_access_url(f"/results/{job_id}/{filename}")

    def create_side_by_side(
        self,
        img1: np.ndarray,
        img2: np.ndarray,
        highlighted: np.ndarray,
        job_id: str,
        page_number: int,
    ) -> str:
        """
        Create side-by-side comparison image: [Original | Modified | Diff].
        Reference: compare-pdf (sidebyside mode with np.hstack).
        """
        # Normalize dimensions
        h = max(img1.shape[0], img2.shape[0], highlighted.shape[0])
        w = max(img1.shape[1], img2.shape[1], highlighted.shape[1])

        def resize_to(img, target_h, target_w):
            if img.shape[0] != target_h or img.shape[1] != target_w:
                return cv2.resize(img, (target_w, target_h))
            return img

        img1 = resize_to(img1, h, w)
        img2 = resize_to(img2, h, w)
        highlighted = resize_to(highlighted, h, w)

        # Add labels
        for img, label in [(img1, "Gốc"), (img2, "Đã sửa"), (highlighted, "Khác biệt")]:
            cv2.putText(img, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)

        combined = np.hstack([img1, img2, highlighted])
        return self.save_highlighted_image(combined, job_id, page_number)

    def generate_diff_overlay_data(
        self,
        diff_regions: list,
        page_width: int,
        page_height: int,
    ) -> list[dict]:
        """
        Convert diff regions to normalized coordinates (0-1)
        for frontend canvas overlay rendering.
        """
        normalized = []
        for region in diff_regions:
            normalized.append({
                "x": region.x / page_width,
                "y": region.y / page_height,
                "width": region.width / page_width,
                "height": region.height / page_height,
                "type": region.type,
                "severity": region.severity,
                "description": region.description,
            })
        return normalized
