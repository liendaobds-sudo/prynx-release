"""ICC Soft-Proofing & Gamut Warning — Acrobat-style screen proof.

Thứ tự engine, tốt nhất trước:

1. **PrynX Print Engine (PPE)** — render trong không gian mực rồi quy CMYK→sRGB
   qua ICC. Chỉ **một** lần quy đổi màu, và overprint được mô hình đúng.
2. **pypdfium2 + LittleCMS** — đường lùi cuối. Nó render ra RGB (mất overprint,
   mất mực pha), rồi RGB→CMYK bằng công thức xấp xỉ, rồi CMYK→sRGB. Ba bước, hai
   lần mất thông tin ⇒ luôn gắn nhãn `approximate`.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageCms

from app.config import settings
from app.core.icc_profiles import (
    PROFILE_REGISTRY,
    list_output_profiles,
    resolve_cmyk_profile_path,
    resolve_profile_path,
)
from app.core.print_engine import PpeUnavailable
from app.core.print_engine.facade import (
    PpeRequestSuperseded,
    PpeSoftproofSession,
)

logger = logging.getLogger(__name__)

INTENT_MAP = {
    "perceptual": ImageCms.Intent.PERCEPTUAL,
    "relative": ImageCms.Intent.RELATIVE_COLORIMETRIC,
    "saturation": ImageCms.Intent.SATURATION,
    "absolute": ImageCms.Intent.ABSOLUTE_COLORIMETRIC,
}

@dataclass(frozen=True)
class _PpeSoftProofResult:
    image: Image.Image
    degraded: bool
    ink_unsound: bool
    timings_ms: dict
    session: dict | None


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
        output_format: str = "jpeg",
        clip: tuple[int, int, int, int] | None = None,
        accurate_only: bool = False,
        ppe_session: PpeSoftproofSession | None = None,
        owner_id: str | None = None,
        request_generation: int | None = None,
        simulate_overprint: bool = True,
        output_preview_filter: str = "all",
        simulate_paper_color: bool = False,
        simulate_black_ink: bool = False,
        page_background_rgb: tuple[int, int, int] | list[int] | None = None,
    ) -> dict:
        profile_id = (profile_id or "fogra39").strip().lower()
        if profile_id in ("auto", ""):
            profile_id = "fogra39"
        profile_name = PROFILE_REGISTRY.get(profile_id, {}).get("name", profile_id)
        profile_path = self._resolve_profile(profile_id)
        cms_intent = INTENT_MAP.get(intent, ImageCms.Intent.RELATIVE_COLORIMETRIC)
        requires_exact_preview_contract = (
            (output_preview_filter or "all").strip().lower() != "all"
            or simulate_paper_color
            or simulate_black_ink
            or page_background_rgb is not None
        )

        if not profile_path:
            if accurate_only or requires_exact_preview_contract:
                raise RuntimeError(
                    f"Không tìm thấy ICC '{profile_name}' để dựng màu chính xác."
                )
            raster_started = time.perf_counter()
            img = await asyncio.to_thread(self._render_pdfium_rgb, pdf_path, page_num, dpi)
            raster_ms = (time.perf_counter() - raster_started) * 1000.0
            img = self._crop_preview_image(img, clip)
            softproof_b64, image_mime, encode_ms = await asyncio.to_thread(
                self._encode_preview_payload,
                img,
                output_format,
                jpeg_quality=88,
            )
            return {
                "success": True,
                "softproof_b64": softproof_b64,
                "image_mime": image_mime,
                "gamut_b64": None,
                "out_of_gamut_pct": 0,
                "profile_name": profile_name,
                "profile_available": False,
                "width": img.size[0],
                "height": img.size[1],
                "engine": "pdfium",
                "accuracy": "display_rgb",
                "timings_ms": {
                    "open": None,
                    "parse": None,
                    "resource": None,
                    "raster": raster_ms,
                    "color": None,
                    "encode": encode_ms,
                },
                "warning": (
                    f"ICC '{profile_name}' không tìm thấy. "
                    f"Đặt FOGRA39.icc vào {getattr(settings, 'ICC_PROFILE_DIR', 'app/assets/icc')}."
                ),
            }

        proofed = None
        engine = "pdfium+lcms"
        accuracy = "approximate"
        ppe_degraded = False
        ppe_ink_unsound = False
        ppe_quality_warning: str | None = None
        ppe_timings_ms: dict = {}
        ppe_session_metadata: dict | None = None
        fallback_render_ms: float | None = None

        if ppe_session is not None and (
            not owner_id or request_generation is None
        ):
            raise ValueError(
                "ppe_session cần owner_id và request_generation để chống response cũ"
            )

        # PPE là đường màu chính xác duy nhất. Khác với đường PDFium, PPE render
        # **trong không gian mực** rồi mới quy
        # sang sRGB, nên soft-proof là CMYK→sRGB thật thay vì RGB→CMYK→sRGB. Đường
        # pdfium đi qua RGB hai lần và mất hết thông tin overprint.
        try:
            try:
                ppe_result = await asyncio.to_thread(
                    self._render_ppe_softproof,
                    pdf_path,
                    page_num,
                    dpi,
                    profile_id,
                    intent,
                    clip,
                    ppe_session,
                    owner_id,
                    request_generation,
                    simulate_overprint,
                    output_preview_filter,
                    simulate_paper_color,
                    simulate_black_ink,
                    page_background_rgb,
                )
            except asyncio.CancelledError:
                # PERF (audit 2026-08-09 §L2B): thread Rust có thể còn chạy, nhưng
                # atomic generation được nâng ngay để native bỏ RGB trước khi trả.
                if ppe_session is not None and owner_id and request_generation is not None:
                    ppe_session.cancel(owner_id, request_generation)
                raise
            ppe_degraded = ppe_result.degraded
            ppe_ink_unsound = ppe_result.ink_unsound
            ppe_timings_ms = dict(ppe_result.timings_ms)
            ppe_session_metadata = ppe_result.session
            if ppe_degraded or ppe_ink_unsound:
                # COLOR (audit 2026-08-08 §RENDER.4): ảnh PPE thiếu object hoặc
                # sai hình học vẫn hữu ích để chẩn đoán, nhưng không được thay ảnh
                # display dưới nhãn CMYK✓. Để proofed=None nhằm hạ về bản xem gần đúng.
                ppe_quality_warning = (
                    "PPE chưa dựng đủ nội dung hoặc hình học để xác nhận màu CMYK chính xác."
                )
                logger.warning(
                    "PPE soft-proof trang %s không đủ tin cậy "
                    "(degraded=%s, ink_unsound=%s); giữ bản xem gần đúng",
                    page_num,
                    ppe_degraded,
                    ppe_ink_unsound,
                )
                if accurate_only or requires_exact_preview_contract:
                    raise RuntimeError(ppe_quality_warning)
            else:
                proofed = ppe_result.image
                engine = "ppe+lcms"
                accuracy = "rip_softproof"
        except PpeUnavailable as exc:
            if accurate_only or requires_exact_preview_contract:
                # PERF (audit 2026-08-08 §RENDER.3): Viewer đã có PDFium display
                # bên dưới; dựng lại full-page rồi crop chỉ để route loại bỏ là CPU/RAM thừa.
                raise RuntimeError(f"PPE soft-proof không khả dụng: {exc}") from exc
            logger.info("PPE soft-proof không khả dụng (%s)", exc)
        except PpeRequestSuperseded:
            # Request lỗi thời tuyệt đối không được rơi sang PDFium rồi tạo một ảnh
            # mới có cùng generation; caller/cache phải dừng request này.
            raise
        except ValueError:
            # Có session thì ValueError là lỗi hợp đồng owner/document/profile/intent.
            # Không được che lỗi lập trình bằng một ảnh PDFium của request khác.
            if ppe_session is not None:
                raise
            if accurate_only or requires_exact_preview_contract:
                raise
        except Exception as exc:
            if accurate_only or requires_exact_preview_contract:
                raise
            logger.warning("PPE soft-proof thất bại (%s); giữ bản xem gần đúng", exc)

        if proofed is None:
            if accurate_only or requires_exact_preview_contract:
                raise RuntimeError("PPE chưa trả ảnh soft-proof đủ tin cậy.")
            fallback_started = time.perf_counter()
            try:
                proofed = await asyncio.to_thread(
                    self._render_lcms_softproof,
                    pdf_path,
                    page_num,
                    dpi,
                    profile_path,
                    cms_intent,
                    clip,
                )
            except asyncio.CancelledError:
                if ppe_session is not None and owner_id and request_generation is not None:
                    ppe_session.cancel(owner_id, request_generation)
                raise
            fallback_render_ms = (time.perf_counter() - fallback_started) * 1000.0
            engine = "pdfium+lcms"
            accuracy = "approximate"

        width, height = proofed.size
        try:
            softproof_b64, image_mime, encode_ms = await asyncio.to_thread(
                self._encode_preview_payload,
                proofed,
                output_format,
                jpeg_quality=90,
            )
        except asyncio.CancelledError:
            if ppe_session is not None and owner_id and request_generation is not None:
                ppe_session.cancel(owner_id, request_generation)
            raise

        if engine == "ppe+lcms":
            timings_ms = {
                "open": None,
                "parse": None,
                "resource": None,
                "raster": None,
                "color": None,
                **ppe_timings_ms,
                "encode": encode_ms,
            }
            ppe_attempt_timings_ms = None
        else:
            # Không trộn timing của ảnh PPE đã bị loại vào timing của ảnh PDFium
            # cuối cùng. `render_color_total` là wall-time trung thực vì lane cũ
            # chưa tách riêng được parse/raster/LCMS.
            timings_ms = {
                "open": None,
                "parse": None,
                "resource": None,
                "raster": None,
                "color": None,
                "render_color_total": fallback_render_ms,
                "encode": encode_ms,
            }
            ppe_attempt_timings_ms = ppe_timings_ms or None

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
                    clip,
                )
            except asyncio.CancelledError:
                if ppe_session is not None and owner_id and request_generation is not None:
                    ppe_session.cancel(owner_id, request_generation)
                raise
            except Exception as exc:
                logger.warning("Gamut warning failed: %s", exc)

        # PERF (audit 2026-08-09 §L2B): encode/gamut có thể tốn đủ lâu để một
        # request zoom mới xuất hiện. Chặn generation cũ ngay trước biên response;
        # route/cache còn một gate interest riêng ở tầng trên.
        if ppe_session is not None and owner_id and request_generation is not None:
            ppe_session.ensure_current(owner_id, request_generation)

        warning = None
        if accuracy != "rip_softproof":
            warning = ppe_quality_warning or (
                "Soft-proof gần đúng (PDF→RGB→ICC): đường này mất overprint và mực pha."
                if engine.startswith("pdfium") else None
            )

        return {
            "success": True,
            "softproof_b64": softproof_b64,
            "image_mime": image_mime,
            "gamut_b64": gamut_b64,
            "out_of_gamut_pct": out_of_gamut_pct,
            "profile_name": profile_name,
            "profile_available": True,
            "width": width,
            "height": height,
            "engine": engine,
            "accuracy": accuracy,
            "warning": warning,
            # Hai cờ đầu mô tả ảnh cuối được chọn; hai cờ PPE giữ nguyên bằng chứng
            # của lần thử PPE kể cả khi Viewer phải giữ bản xem gần đúng.
            "degraded": ppe_degraded if engine == "ppe+lcms" else False,
            "ink_unsound": ppe_ink_unsound if engine == "ppe+lcms" else False,
            "ppe_degraded": ppe_degraded,
            "ppe_ink_unsound": ppe_ink_unsound,
            "timings_ms": timings_ms,
            "ppe_attempt_timings_ms": ppe_attempt_timings_ms,
            "ppe_session": ppe_session_metadata,
        }

    @staticmethod
    def _encode_preview_image(
        image: Image.Image,
        output_format: str,
        *,
        jpeg_quality: int,
    ) -> tuple[bytes, str]:
        """Mã hóa ảnh proof; Viewer dùng PNG để không thêm banding sau PPE."""
        normalized = (output_format or "jpeg").strip().lower()
        buf = io.BytesIO()
        if normalized == "png":
            # COLOR (audit 2026-08-07 §GV.1): accurate path phải giữ nguyên pixel
            # do PPE/ICC trả về; không nén JPEG lần nữa sau khi đã quản lý màu.
            image.save(buf, "PNG")
            return buf.getvalue(), "image/png"
        image.convert("RGB").save(buf, "JPEG", quality=jpeg_quality)
        return buf.getvalue(), "image/jpeg"

    @staticmethod
    def _encode_preview_payload(
        image: Image.Image,
        output_format: str,
        *,
        jpeg_quality: int,
    ) -> tuple[str, str, float]:
        """Nén và base64 ngoài event loop; timing bao trọn payload trả về."""
        started = time.perf_counter()
        encoded, image_mime = SoftProofEngine._encode_preview_image(
            image,
            output_format,
            jpeg_quality=jpeg_quality,
        )
        payload = base64.b64encode(encoded).decode()
        return payload, image_mime, (time.perf_counter() - started) * 1000.0

    # ── Render paths ──────────────────────────────────────────────────────

    @staticmethod
    def _crop_preview_image(
        image: Image.Image,
        clip: tuple[int, int, int, int] | None,
    ) -> Image.Image:
        if clip is None:
            return image
        x, y, width, height = clip
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise ValueError("clip soft-proof không hợp lệ")
        if x + width > image.width or y + height > image.height:
            raise ValueError("clip soft-proof nằm ngoài ảnh trang")
        return image.crop((x, y, x + width, y + height))

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
        profile_id: str,
        intent: str,
        clip: tuple[int, int, int, int] | None = None,
        ppe_session: PpeSoftproofSession | None = None,
        owner_id: str | None = None,
        request_generation: int | None = None,
        simulate_overprint: bool = True,
        output_preview_filter: str = "all",
        simulate_paper_color: bool = False,
        simulate_black_ink: bool = False,
        page_background_rgb: tuple[int, int, int] | list[int] | None = None,
    ) -> _PpeSoftProofResult:
        """Soft-proof bằng PPE: mực → sRGB, một lần quy đổi.

        Khác đường `pdfium+lcms` ở chỗ **không đi qua RGB hai lần**. Đường pdfium
        render ra RGB (mất overprint, mất mực pha), rồi RGB→CMYK bằng một công thức
        xấp xỉ, rồi CMYK→sRGB qua ICC. Ba bước, hai lần mất thông tin. PPE render
        thẳng trong không gian mực nên chỉ còn một bước quy đổi và overprint được
        mô hình đúng.

        `profile_id` được truyền nguyên vẹn cho facade để nó tự phân giải:
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

        # COLOR (audit 2026-08-08 §RENDER.3): tên file ICC không phải ID registry.
        # Ví dụ `swop` resolve thành USWebCoatedSWOP.icc; lấy stem từng biến ID hợp lệ
        # thành `uswebcoatedswop` và làm facade từ chối profile đã có trên máy.
        profile_id = (profile_id or "fogra39").strip().lower()
        if ppe_session is None:
            result = ppe_softproof(
                pdf_path,
                page_num,
                dpi=dpi,
                cmyk_profile_id=profile_id,
                render_intent=intent_code,
                simulate_overprint=simulate_overprint,
                output_preview_filter=output_preview_filter,
                simulate_paper_color=simulate_paper_color,
                simulate_black_ink=simulate_black_ink,
                page_background_rgb=page_background_rgb,
                clip=clip,
            )
        else:
            if not owner_id or request_generation is None:
                raise ValueError(
                    "ppe_session cần owner_id và request_generation"
                )
            result = ppe_session.render(
                owner_id=owner_id,
                request_generation=request_generation,
                pdf_path=pdf_path,
                cmyk_profile_id=profile_id,
                render_intent=intent_code,
                page_num=page_num,
                dpi=dpi,
                simulate_overprint=simulate_overprint,
                output_preview_filter=output_preview_filter,
                simulate_paper_color=simulate_paper_color,
                simulate_black_ink=simulate_black_ink,
                page_background_rgb=page_background_rgb,
                clip=clip,
            )
            ppe_session.ensure_current(owner_id, request_generation)
        img = Image.frombytes(
            "RGB", (result["width"], result["height"]), bytes(result["rgb"])
        )
        if ppe_session is not None and owner_id and request_generation is not None:
            ppe_session.ensure_current(owner_id, request_generation)
        # COLOR (audit 2026-08-08 §RENDER.4): không làm rơi hai cờ chất lượng ở
        # biên facade → SoftProofEngine; lớp gọi quyết định dùng ảnh hay fallback.
        return _PpeSoftProofResult(
            image=img,
            degraded=bool(result.get("degraded")),
            ink_unsound=bool(result.get("ink_unsound")),
            timings_ms=dict(result.get("timings_ms") or {}),
            session={
                "mode": result.get("session_mode", "stateless"),
                "document_identity": result.get("document_identity"),
                "session_generation": result.get("session_generation"),
                "request_generation": result.get("request_generation"),
                "resource_cache_hit": bool(result.get("resource_cache_hit")),
                "cache": dict(result.get("cache") or {}),
                "open": dict(result.get("session_open") or {}),
            },
        )

    def _render_lcms_softproof(
        self,
        pdf_path: str,
        page_num: int,
        dpi: int,
        profile_path: str,
        cms_intent,
        clip: tuple[int, int, int, int] | None = None,
    ) -> Image.Image:
        img = self._render_pdfium_rgb(pdf_path, page_num, dpi)
        img = self._crop_preview_image(img, clip)
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
        clip: tuple[int, int, int, int] | None = None,
    ) -> tuple[str | None, float]:
        """Out-of-gamut mask relative to print profile (from display RGB source)."""
        src = self._render_pdfium_rgb(pdf_path, page_num, dpi)
        src = self._crop_preview_image(src, clip)
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
