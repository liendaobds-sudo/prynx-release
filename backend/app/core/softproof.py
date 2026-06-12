"""
ICC Soft-Proofing & Gamut Warning Engine

Uses Pillow's ImageCms (backed by LittleCMS2) to simulate how a PDF page
will look when printed on a specific device (paper/printer profile).

Supports:
- Soft-proofing with any ICC output profile (FOGRA39, GRACoL, JapanColor, etc.)
- Gamut warning overlay (highlights out-of-gamut pixels in neon green)
- Multiple rendering intents (perceptual, relative, saturation, absolute)
"""

import os
import io
import base64
import logging
import asyncio
import numpy as np

from pathlib import Path
from PIL import Image, ImageCms

logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════
#  BUNDLED ICC PROFILE REGISTRY
# ══════════════════════════════════════════════════════════════

# Standard ICC profiles that ship with most systems or can be downloaded freely.
# We check multiple known paths on Windows, Mac, and Linux.
ICC_SEARCH_PATHS = [
    # Windows
    r"C:\Windows\System32\spool\drivers\color",
    # macOS
    "/Library/ColorSync/Profiles",
    "/System/Library/ColorSync/Profiles",
    # Linux
    "/usr/share/color/icc",
    "/usr/share/ghostscript",
]

# Well-known profile filenames and their display names
KNOWN_PROFILES: dict[str, dict] = {
    "srgb": {
        "name": "sRGB IEC61966-2.1",
        "description": "Màn hình tiêu chuẩn (sRGB)",
        "category": "input",
        "filenames": ["sRGB Color Space Profile.icm", "sRGB.icc", "sRGB IEC61966-2.1.icc", "sRGB Profile.icc"],
    },
    "fogra39": {
        "name": "ISO Coated v2 (FOGRA39)",
        "description": "Giấy couché, in offset châu Âu",
        "category": "output",
        "filenames": ["CoatedFOGRA39.icc", "ISOcoated_v2_300_bas.icc", "ISOcoated_v2_300_eci.icc", "Coated FOGRA39 (ISO 12647-2_2004).icc"],
    },
    "fogra27": {
        "name": "ISO Coated (FOGRA27)",
        "description": "Giấy couché, in offset châu Âu (cũ)",
        "category": "output",
        "filenames": ["CoatedFOGRA27.icc", "ISOcoated.icc"],
    },
    "gracol": {
        "name": "GRACoL 2006",
        "description": "Giấy couché, in offset Bắc Mỹ",
        "category": "output",
        "filenames": ["GRACoL2006_Coated1v2.icc", "GRACoL2013_CRPC6.icc"],
    },
    "swop": {
        "name": "US Web Coated (SWOP) v2",
        "description": "In web offset Bắc Mỹ",
        "category": "output",
        "filenames": ["USWebCoatedSWOP.icc", "WebCoatedSWOP2006Grade3.icc", "USWebCoatedSWOP v2.icc"],
    },
    "japan_color": {
        "name": "Japan Color 2001 Coated",
        "description": "In offset Nhật Bản",
        "category": "output",
        "filenames": ["JapanColor2001Coated.icc", "JapanColor2001_Coated_bas.icc"],
    },
    "uncoated": {
        "name": "ISO Uncoated (FOGRA29)",
        "description": "Giấy không tráng phủ",
        "category": "output",
        "filenames": ["UncoatedFOGRA29.icc", "ISOuncoated.icc", "Uncoated FOGRA29 (ISO 12647-2_2004).icc"],
    },
    "newspaper": {
        "name": "ISOnewspaper26v4",
        "description": "In báo giấy newsprint",
        "category": "output",
        "filenames": ["ISOnewspaper26v4.icc", "ISOnewspaper.icc"],
    },
}

# Gamut warning alarm color (neon green — highly visible)
GAMUT_ALARM_COLOR = (0, 255, 0)

# Rendering intent map
INTENT_MAP = {
    "perceptual": ImageCms.Intent.PERCEPTUAL,
    "relative": ImageCms.Intent.RELATIVE_COLORIMETRIC,
    "saturation": ImageCms.Intent.SATURATION,
    "absolute": ImageCms.Intent.ABSOLUTE_COLORIMETRIC,
}


def _find_icc_file(filenames: list[str]) -> str | None:
    """Search known system directories for an ICC profile file."""
    for search_dir in ICC_SEARCH_PATHS:
        if not os.path.isdir(search_dir):
            continue
        for fn in filenames:
            candidate = os.path.join(search_dir, fn)
            if os.path.isfile(candidate):
                return candidate
            # Also search subdirectories one level deep
            for sub in os.listdir(search_dir):
                sub_path = os.path.join(search_dir, sub)
                if os.path.isdir(sub_path):
                    candidate = os.path.join(sub_path, fn)
                    if os.path.isfile(candidate):
                        return candidate
    return None


class SoftProofEngine:
    def __init__(self):
        self._profile_cache: dict[str, str] = {}  # profile_id -> file_path
        self._srgb_profile = ImageCms.createProfile("sRGB")

    def list_available_profiles(self) -> list[dict]:
        """List all ICC profiles found on this system."""
        results = []
        for profile_id, info in KNOWN_PROFILES.items():
            if info["category"] != "output":
                continue
            path = self._resolve_profile(profile_id)
            results.append({
                "id": profile_id,
                "name": info["name"],
                "description": info["description"],
                "available": path is not None,
            })
        return results

    def _resolve_profile(self, profile_id: str) -> str | None:
        """Resolve a profile ID to a file path, with caching."""
        if profile_id in self._profile_cache:
            return self._profile_cache[profile_id]

        info = KNOWN_PROFILES.get(profile_id)
        if not info:
            return None

        path = _find_icc_file(info["filenames"])
        if path:
            self._profile_cache[profile_id] = path
        return path

    async def render_softproof(
        self,
        pdf_path: str,
        page_num: int,
        profile_id: str = "fogra39",
        intent: str = "relative",
        show_gamut_warning: bool = False,
        dpi: int = 150,
    ) -> dict:
        """
        Render a PDF page with ICC soft-proofing simulation.

        Returns:
        - softproof_b64: base64 JPEG of the soft-proofed page
        - gamut_b64: base64 PNG of the gamut warning overlay (if requested)
        - out_of_gamut_pct: percentage of pixels that are out of gamut
        - profile_name: display name of the profile used
        """
        profile_path = self._resolve_profile(profile_id)
        profile_name = KNOWN_PROFILES.get(profile_id, {}).get("name", profile_id)
        cms_intent = INTENT_MAP.get(intent, ImageCms.Intent.RELATIVE_COLORIMETRIC)

        # 1. Render page to RGB image using pypdfium2
        def _render():
            import pypdfium2 as pdfium
            pdf_doc = pdfium.PdfDocument(pdf_path)
            page = pdf_doc[page_num - 1]
            scale = dpi / 72.0
            bitmap = page.render(scale=scale)
            img = bitmap.to_pil()  # RGB PIL Image
            pdf_doc.close()
            return img

        img = await asyncio.to_thread(_render)
        width, height = img.size

        if not profile_path:
            # No ICC profile found — return original image with warning
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=85)
            return {
                "softproof_b64": base64.b64encode(buf.getvalue()).decode(),
                "gamut_b64": None,
                "out_of_gamut_pct": 0,
                "profile_name": profile_name,
                "profile_available": False,
                "width": width,
                "height": height,
                "warning": f"ICC profile '{profile_name}' không tìm thấy trên hệ thống. Vui lòng cài đặt profile.",
            }

        # 2. Build soft-proof transform (sRGB → simulate output device → sRGB display)
        def _apply_softproof():
            output_profile = ImageCms.getOpenProfile(profile_path)

            # Soft-proof transform: shows how the image would look when printed
            softproof_transform = ImageCms.buildProofTransform(
                inputProfile=self._srgb_profile,
                outputProfile=self._srgb_profile,
                proofProfile=output_profile,
                inMode="RGB",
                outMode="RGB",
                renderingIntent=cms_intent,
                proofRenderingIntent=cms_intent,
                flags=ImageCms.Flags.SOFTPROOFING,
            )
            proofed = img.copy()
            ImageCms.applyTransform(proofed, softproof_transform, inPlace=True)

            # Encode soft-proofed image
            buf = io.BytesIO()
            proofed.save(buf, "JPEG", quality=85)
            softproof_b64 = base64.b64encode(buf.getvalue()).decode()

            gamut_b64 = None
            out_of_gamut_pct = 0.0

            if show_gamut_warning:
                # Gamut check transform: out-of-gamut pixels get replaced by alarm color
                # Pillow 10.x default alarm color is (0,0,0) — we detect by comparing
                # the gamut-checked output against the soft-proofed output
                gamut_transform = ImageCms.buildProofTransform(
                    inputProfile=self._srgb_profile,
                    outputProfile=self._srgb_profile,
                    proofProfile=output_profile,
                    inMode="RGB",
                    outMode="RGB",
                    renderingIntent=cms_intent,
                    proofRenderingIntent=cms_intent,
                    flags=ImageCms.Flags.SOFTPROOFING | ImageCms.Flags.GAMUTCHECK,
                )
                gamut_img = img.copy()
                ImageCms.applyTransform(gamut_img, gamut_transform, inPlace=True)

                # Compare gamut-checked image vs soft-proofed image
                # Pixels that were replaced by the alarm color (default black 0,0,0)
                # will differ significantly from the proofed version
                arr_gamut = np.array(gamut_img)
                arr_proof = np.array(proofed)

                # Detect alarm pixels: GAMUTCHECK replaces out-of-gamut with alarm (0,0,0)
                # These pixels become pure black while the proofed version has actual color
                alarm_black = np.array([0, 0, 0], dtype=np.uint8)
                is_alarm = np.all(arr_gamut == alarm_black, axis=2)
                # Exclude pixels that are naturally very dark in the original
                is_dark_original = np.all(arr_proof < 15, axis=2)
                mask = is_alarm & ~is_dark_original

                out_of_gamut_pct = round(np.sum(mask) / (width * height) * 100, 2)

                # Build RGBA overlay: out-of-gamut pixels are neon green, rest transparent
                overlay = np.zeros((height, width, 4), dtype=np.uint8)
                overlay[mask] = [0, 255, 0, 180]  # neon green, 70% opacity

                overlay_img = Image.fromarray(overlay, "RGBA")
                buf2 = io.BytesIO()
                overlay_img.save(buf2, "PNG")
                gamut_b64 = base64.b64encode(buf2.getvalue()).decode()

            return softproof_b64, gamut_b64, out_of_gamut_pct

        sp_b64, gw_b64, oog_pct = await asyncio.to_thread(_apply_softproof)

        return {
            "softproof_b64": sp_b64,
            "gamut_b64": gw_b64,
            "out_of_gamut_pct": oog_pct,
            "profile_name": profile_name,
            "profile_available": True,
            "width": width,
            "height": height,
        }
