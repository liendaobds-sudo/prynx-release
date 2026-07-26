"""
Highlight Renderer — Generate diff overlay images for the frontend.

Reference: pdf-diff (draw_red_boxes, render_changes)
"""
import os
import logging
from pathlib import Path

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

        cv2.imwrite(str(filepath), bgr)
        logger.info(f"Saved highlight: {filepath}")

        return result_access_url(f"/results/{job_id}/{filename}")

    def save_gif_image(
        self,
        gif_bytes: bytes,
        job_id: str,
        page_number: int,
    ) -> str:
        """Save an animated GIF to results directory."""
        output_dir = Path(settings.RESULTS_DIR) / str(job_id)
        output_dir.mkdir(parents=True, exist_ok=True)

        filename = f"page_{page_number}_anim.gif"
        filepath = output_dir / filename

        with open(filepath, "wb") as f:
            f.write(gif_bytes)

        logger.info(f"Saved GIF: {filepath}")

        return result_access_url(f"/results/{job_id}/{filename}")

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
