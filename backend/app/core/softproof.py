"""ICC Soft-Proofing & Gamut Warning — Acrobat-style screen proof.

Thứ tự engine, tốt nhất trước:

1. **PrynX Print Engine (PPE)** — render trong không gian mực rồi quy CMYK→sRGB
   qua ICC. Chỉ **một** lần quy đổi màu, và overprint được mô hình đúng.
2. **Ghostscript** — cùng ý tưởng nhưng qua tiến trình con và bundle AGPL.
3. **pypdfium2 + LittleCMS** — đường lùi cuối. Nó render ra RGB (mất overprint,
   mất mực pha), rồi RGB→CMYK bằng công thức xấp xỉ, rồi CMYK→sRGB. Ba bước, hai
   lần mất thông tin ⇒ luôn gắn nhãn `approximate`.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

from app.config import settings
from app.core.icc_profiles import (
    PROFILE_REGISTRY,
    list_output_profiles,
    resolve_cmyk_profile_path,
    resolve_profile_path,
    resolve_srgb_profile_path,
)
from app.core.print_engine import PpeUnavailable
from app.utils.subprocess_utils import run_hidden

logger = logging.getLogger(__name__)

INTENT_MAP = {
    "perceptual": ImageCms.Intent.PERCEPTUAL,
    "relative": ImageCms.Intent.RELATIVE_COLORIMETRIC,
    "saturation": ImageCms.Intent.SATURATION,
    "absolute": ImageCms.Intent.ABSOLUTE_COLORIMETRIC,
}

# Ghostscript RenderIntent: 0=Perceptual 1=Relative 2=Saturation 3=Absolute
GS_INTENT = {
    "perceptual": "0",
    "relative": "1",
    "saturation": "2",
    "absolute": "3",
}


class SoftProofEngine:
    def __init__(self):
        self._srgb_profile = ImageCms.createProfile("sRGB")

    def list_available_profiles(self) -> list[dict]:
        return [
            {
                "id": p["id"],
                "name": p["name"],
                "description": p["description"],
                "available": p["available"],
            }
            for p in list_output_profiles()
        ]

    def _resolve_profile(self, profile_id: str) -> str | None:
        return resolve_profile_path(profile_id)

    async def render_softproof(
        self,
        pdf_path: str,
        page_num: int,
        profile_id: str = "fogra39",
        intent: str = "relative",
        show_gamut_warning: bool = False,
        dpi: int = 150,
    ) -> dict:
        profile_id = (profile_id or "fogra39").strip().lower()
        if profile_id in ("auto", ""):
            profile_id = "fogra39"
        profile_name = PROFILE_REGISTRY.get(profile_id, {}).get("name", profile_id)
        profile_path = self._resolve_profile(profile_id)
        cms_intent = INTENT_MAP.get(intent, ImageCms.Intent.RELATIVE_COLORIMETRIC)

        if not profile_path:
            img = await asyncio.to_thread(self._render_pdfium_rgb, pdf_path, page_num, dpi)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=88)
            return {
                "success": True,
                "softproof_b64": base64.b64encode(buf.getvalue()).decode(),
                "gamut_b64": None,
                "out_of_gamut_pct": 0,
                "profile_name": profile_name,
                "profile_available": False,
                "width": img.size[0],
                "height": img.size[1],
                "engine": "pdfium",
                "accuracy": "display_rgb",
                "warning": (
                    f"ICC '{profile_name}' không tìm thấy. "
                    f"Đặt FOGRA39.icc vào {getattr(settings, 'ICC_PROFILE_DIR', 'app/assets/icc')}."
                ),
            }

        gs_path = getattr(settings, "GHOSTSCRIPT_PATH", None) or ""
        proofed = None
        engine = "pdfium+lcms"
        accuracy = "approximate"

        # PPE trước, Ghostscript sau. Khác với đường tách kẽm, ở đây PPE có một lợi
        # thế mà pdfium không thể có: nó render **trong không gian mực** rồi mới quy
        # sang sRGB, nên soft-proof là CMYK→sRGB thật thay vì RGB→CMYK→sRGB. Đường
        # pdfium đi qua RGB hai lần và mất hết thông tin overprint.
        try:
            proofed = await asyncio.to_thread(
                self._render_ppe_softproof,
                pdf_path,
                page_num,
                dpi,
                profile_path,
                intent,
            )
            engine = "ppe+lcms"
            accuracy = "rip_softproof"
        except PpeUnavailable as exc:
            logger.info("PPE soft-proof không khả dụng (%s)", exc)
        except Exception as exc:
            logger.warning("PPE soft-proof thất bại (%s); thử Ghostscript", exc)

        if proofed is None and gs_path and os.path.isfile(gs_path):
            try:
                proofed = await asyncio.to_thread(
                    self._render_gs_softproof,
                    gs_path,
                    pdf_path,
                    page_num,
                    dpi,
                    profile_path,
                    intent,
                )
                engine = "ghostscript+icc"
                accuracy = "rip_softproof"
            except Exception as exc:
                logger.warning("GS soft-proof failed (%s); LCMS fallback", exc)

        if proofed is None:
            proofed = await asyncio.to_thread(
                self._render_lcms_softproof,
                pdf_path,
                page_num,
                dpi,
                profile_path,
                cms_intent,
            )
            engine = "pdfium+lcms"
            accuracy = "approximate"

        width, height = proofed.size
        buf = io.BytesIO()
        proofed.save(buf, "JPEG", quality=90)
        softproof_b64 = base64.b64encode(buf.getvalue()).decode()

        gamut_b64 = None
        out_of_gamut_pct = 0.0
        if show_gamut_warning:
            try:
                gamut_b64, out_of_gamut_pct = await asyncio.to_thread(
                    self._gamut_overlay,
                    pdf_path,
                    page_num,
                    dpi,
                    profile_path,
                    cms_intent,
                    proofed,
                )
            except Exception as exc:
                logger.warning("Gamut warning failed: %s", exc)

        return {
            "success": True,
            "softproof_b64": softproof_b64,
            "gamut_b64": gamut_b64,
            "out_of_gamut_pct": out_of_gamut_pct,
            "profile_name": profile_name,
            "profile_available": True,
            "width": width,
            "height": height,
            "engine": engine,
            "accuracy": accuracy,
            "warning": None if accuracy == "rip_softproof" else (
                "Soft-proof gần đúng (PDF→RGB→ICC): đường này mất overprint và mực pha."
                if engine.startswith("pdfium") else None
            ),
        }

    # ── Render paths ──────────────────────────────────────────────────────

    def _render_pdfium_rgb(self, pdf_path: str, page_num: int, dpi: int) -> Image.Image:
        # KIENTRUC (audit 2026-07-29 §C.1): hàm này được gọi qua `asyncio.to_thread`
        # (xem `softproof.py` nhánh không có ICC) → 2 request soft-proof đồng thời là 2
        # thread cùng gọi PDFium. Bọc guard; toàn thân là lời gọi PDFium nên khóa bao cả.
        import pypdfium2 as pdfium
        from app.core.pdfium_lock import pdfium_guard
        with pdfium_guard("softproof_render_rgb"):
            doc = pdfium.PdfDocument(pdf_path)
            try:
                page = doc[page_num - 1]
                bitmap = page.render(scale=dpi / 72.0)
                return bitmap.to_pil().convert("RGB")
            finally:
                doc.close()

    def _render_ppe_softproof(
        self,
        pdf_path: str,
        page_num: int,
        dpi: int,
        profile_path: str,
        intent: str,
    ) -> Image.Image:
        """Soft-proof bằng PPE: mực → sRGB, một lần quy đổi.

        Khác đường `pdfium+lcms` ở chỗ **không đi qua RGB hai lần**. Đường pdfium
        render ra RGB (mất overprint, mất mực pha), rồi RGB→CMYK bằng một công thức
        xấp xỉ, rồi CMYK→sRGB qua ICC. Ba bước, hai lần mất thông tin. PPE render
        thẳng trong không gian mực nên chỉ còn một bước quy đổi và overprint được
        mô hình đúng.

        `profile_path` được truyền dưới dạng **id** cho facade để nó tự phân giải:
        facade dùng cùng bảng profile với phần còn lại của backend, nên không có cơ
        hội hai nơi trỏ hai file khác nhau.
        """
        from app.core.print_engine import softproof as ppe_softproof

        # `intent` của PDF: 0 perceptual, 1 relative, 2 saturation, 3 absolute.
        intent_code = {
            "perceptual": 0,
            "relative": 1,
            "saturation": 2,
            "absolute": 3,
        }.get((intent or "relative").strip().lower(), 1)

        profile_id = Path(profile_path).stem.lower() if profile_path else "fogra39"
        result = ppe_softproof(
            pdf_path,
            page_num,
            dpi=dpi,
            cmyk_profile_id=profile_id,
            render_intent=intent_code,
        )
        img = Image.frombytes(
            "RGB", (result["width"], result["height"]), bytes(result["rgb"])
        )
        if result.get("ink_unsound"):
            # Ảnh vẫn dùng được để xem, nhưng có nội dung engine chưa vẽ đủ. Ghi log
            # thay vì im lặng: người dùng cần biết vì sao bản proof thiếu chi tiết.
            logger.warning(
                "PPE soft-proof: trang %s có nội dung chưa dựng đủ (ink_unsound)",
                page_num,
            )
        return img

    def _render_gs_softproof(
        self,
        gs_exe: str,
        pdf_path: str,
        page_num: int,
        dpi: int,
        cmyk_profile: str,
        intent: str,
    ) -> Image.Image:
        """Acrobat-like: interpret PDF colors with CMYK print profile → sRGB PNG."""
        srgb = resolve_srgb_profile_path()
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            out_png = tmp.name
        try:
            # -dNOSAFER: GS 10 SAFER blocks reading bundled ICC outside cwd.
            cmd = [
                gs_exe,
                "-dBATCH", "-dNOPAUSE", "-dNOSAFER", "-dQUIET",
                "-sDEVICE=png16m",
                f"-r{dpi}",
                f"-dFirstPage={page_num}",
                f"-dLastPage={page_num}",
                "-dTextAlphaBits=4",
                "-dGraphicsAlphaBits=4",
                "-dSimulateOverprint=true",
                f"-sDefaultCMYKProfile={cmyk_profile}",
                f"-dRenderIntent={GS_INTENT.get(intent, '1')}",
                "-dOverrideICC=true",
                "-dUseFastColor=false",
            ]
            if srgb:
                cmd.append(f"-sOutputICCProfile={srgb}")
                cmd.append(f"-sDefaultRGBProfile={srgb}")
            cmd.extend([f"-sOutputFile={out_png}", pdf_path])

            res = run_hidden(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=180,
            )
            if res.returncode != 0 or not os.path.isfile(out_png):
                err = (res.stderr or b"").decode("utf-8", errors="replace")[:400]
                raise RuntimeError(f"GS softproof exit {res.returncode}: {err}")
            img = Image.open(out_png).convert("RGB")
            # Load fully before deleting temp
            img.load()
            return img.copy()
        finally:
            try:
                os.unlink(out_png)
            except OSError:
                pass

    def _render_lcms_softproof(
        self,
        pdf_path: str,
        page_num: int,
        dpi: int,
        profile_path: str,
        cms_intent,
    ) -> Image.Image:
        img = self._render_pdfium_rgb(pdf_path, page_num, dpi)
        output_profile = ImageCms.getOpenProfile(profile_path)
        transform = ImageCms.buildProofTransform(
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
        ImageCms.applyTransform(proofed, transform, inPlace=True)
        return proofed

    def _gamut_overlay(
        self,
        pdf_path: str,
        page_num: int,
        dpi: int,
        profile_path: str,
        cms_intent,
        proofed: Image.Image,
    ) -> tuple[str | None, float]:
        """Out-of-gamut mask relative to print profile (from display RGB source)."""
        src = self._render_pdfium_rgb(pdf_path, page_num, dpi)
        output_profile = ImageCms.getOpenProfile(profile_path)
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
        gamut_img = src.copy()
        ImageCms.applyTransform(gamut_img, gamut_transform, inPlace=True)
        arr_gamut = np.array(gamut_img)
        arr_proof = np.array(proofed.resize(gamut_img.size) if proofed.size != gamut_img.size else proofed)
        is_alarm = np.all(arr_gamut == 0, axis=2)
        is_dark = np.all(arr_proof < 15, axis=2)
        mask = is_alarm & ~is_dark
        h, w = mask.shape
        pct = round(float(np.sum(mask)) / max(1, w * h) * 100, 2)
        overlay = np.zeros((h, w, 4), dtype=np.uint8)
        overlay[mask] = [0, 255, 0, 180]
        buf = io.BytesIO()
        Image.fromarray(overlay, "RGBA").save(buf, "PNG")
        return base64.b64encode(buf.getvalue()).decode(), pct
