"""
Action Engine — Tự động sửa lỗi PDF (giống Action Lists của Enfocus PitStop).

Sử dụng:
  - Ghostscript (CLI): Convert CMYK, Flatten Transparency, Embed Fonts, Downscale
  - pikepdf (QPDF):    Sửa Metadata, Dictionary, structural repairs

Actions:
  CONVERT_TO_CMYK       — Chuyển toàn bộ hệ màu sang CMYK + gắn ICC Profile
  FLATTEN_TRANSPARENCY  — Flatten tất cả transparency groups
  FIX_METADATA          — Xóa metadata nhạy cảm, cập nhật Producer
  EMBED_FONTS           — Nhúng toàn bộ font chưa embedded
  DOWNSCALE_IMAGES      — Giảm ảnh > 600 DPI xuống 300 DPI
"""
import asyncio
import logging
import os
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class ActionLogEntry:
    """Log entry for a single action step."""
    action_id: str
    status: str           # "success" | "failed" | "skipped"
    message: str
    duration_ms: int = 0
    # Dữ liệu báo cáo bổ sung (vd report gỡ kênh: max/avg ΔE, OOG, warnings).
    # Để None với các action không sinh report. Task 11.2 sẽ surface lên FixResponse.
    report: dict | None = None


@dataclass
class ActionResult:
    """Result of executing one or more actions."""
    success: bool
    output_path: str | None = None
    log: list[ActionLogEntry] = field(default_factory=list)
    error: str | None = None


# ── Available Actions Registry ──
AVAILABLE_ACTIONS = {
    "CONVERT_TO_CMYK": {
        "title": "Chuyển đổi sang CMYK",
        "description": "Chuyển toàn bộ Object RGB sang hệ màu CMYK với ICC Profile chuẩn in offset.",
        "engine": "ghostscript",
    },
    "FLATTEN_TRANSPARENCY": {
        "title": "Flatten Transparency",
        "description": "Xóa bỏ mọi hiệu ứng trong suốt (bóng đổ, blend mode) để máy CTP không bị lỗi.",
        "engine": "ghostscript",
    },
    "OUTLINE_FONTS": {
        "title": "Khóa Font (Outline Text)",
        "description": "Convert toàn bộ chữ thành Vector (Curves) để chống lỗi font 100% khi in.",
        "engine": "ghostscript",
    },
    "EMBED_FONTS": {
        "title": "Nhúng Font (Embed)",
        "description": "Thử nhúng các font chưa được embedded vào file PDF (kém an toàn hơn).",
        "engine": "ghostscript",
    },
    "DOWNSCALE_IMAGES": {
        "title": "Giảm độ phân giải ảnh",
        "description": "Downscale ảnh > 600 DPI xuống 300 DPI để giảm dung lượng file.",
        "engine": "ghostscript",
    },
    "FIX_METADATA": {
        "title": "Sửa Metadata",
        "description": "Xóa metadata nhạy cảm (Author, Creator, Subject) và cập nhật Producer.",
        "engine": "pikepdf",
    },
    "FIX_HAIRLINES": {
        "title": "Sửa nét mảnh (Hairlines)",
        "description": "Tăng độ dày các nét < 0.25pt để không bị mất khi in offset.",
        "engine": "pikepdf",
    },
    "SET_BLACK_OVERPRINT": {
        "title": "Overprint Text Đen",
        "description": "Đặt overprint cho text và nét đen (K>95%), tránh lỗi knockout khi in offset.",
        "engine": "ghostscript",
    },
    "REMOVE_CHANNELS": {
        "title": "Gỡ kênh màu (Channel Remover)",
        "description": (
            "Gỡ một hoặc nhiều kênh process (C/M/Y/K) để in bằng ít mực hơn. "
            "Chế độ 'reseparate' bù màu qua FOGRA39 để giữ màu gần nhất; "
            "cảnh báo và báo cáo ΔE cho vùng ngoài gamut."
        ),
        "engine": "channel_remover",
        "parameters": {
            "kept_channels": {
                "type": "array",
                "description": "Danh sách kênh GIỮ lại (1..3 phần tử), tập con của C/M/Y/K.",
                "default": ["C", "M", "Y"],
            },
            "mode": {
                "type": "string",
                "enum": ["direct", "reseparate"],
                "description": "'direct' xóa thẳng kênh; 'reseparate' bù màu qua FOGRA39.",
                "default": "reseparate",
            },
            "tac_limit": {
                "type": "number",
                "description": "Tổng phủ mực tối đa (%) cho màu kết quả.",
                "default": 360.0,
            },
            "gamut_threshold": {
                "type": "number",
                "description": "Ngưỡng ΔE phân loại màu Out-Of-Gamut.",
                "default": 5.0,
            },
            "spot_handling": {
                "type": "string",
                "enum": ["skip", "convert"],
                "description": "'skip' giữ nguyên màu pha; 'convert' chuyển sang CMYK trước khi gỡ.",
                "default": "skip",
            },
            "process_hidden_layers": {
                "type": "boolean",
                "description": "Có áp gỡ kênh cho nội dung layer ẩn (OCG) hay không.",
                "default": False,
            },
            "grid_step": {
                "type": "number",
                "description": "Bước lưới (%) khi liệt kê tổ hợp CMYK kênh-giữ cho LUT.",
                "default": 5.0,
            },
        },
    },
}


class ActionEngine:
    """
    Executes auto-fix actions on PDF files.
    
    Usage:
        engine = ActionEngine()
        result = await engine.execute("input.pdf", "CONVERT_TO_CMYK")
        result = await engine.execute_batch("input.pdf", [
            {"id": "CONVERT_TO_CMYK"},
            {"id": "FLATTEN_TRANSPARENCY"},
        ])
    """

    def __init__(self):
        self.gs_path = settings.GHOSTSCRIPT_PATH
        self.icc_dir = settings.ICC_PROFILE_DIR
        self.default_profile = settings.DEFAULT_CMYK_PROFILE
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        # Buffer chứa report bổ sung của handler gần nhất (vd REMOVE_CHANNELS).
        self._last_report: dict | None = None

    async def execute(
        self, pdf_path: str, action_id: str, params: dict | None = None, original_name: str | None = None
    ) -> ActionResult:
        """Execute a single action on a PDF."""
        if action_id not in AVAILABLE_ACTIONS:
            return ActionResult(
                success=False,
                error=f"Action '{action_id}' không tồn tại.",
            )

        stem = Path(original_name).stem if original_name else Path(pdf_path).stem
        output_name = f"{stem}_{action_id}_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        params = params or {}

        start = datetime.now()
        try:
            handler = getattr(self, f"_action_{action_id.lower()}", None)
            logger.debug(f"action_id={action_id}, handler={handler}, handler_name=_action_{action_id.lower()}")
            if handler is None:
                return ActionResult(success=False, error=f"Handler cho '{action_id}' chưa được triển khai.")

            # Reset report buffer; handlers sinh report (vd REMOVE_CHANNELS) sẽ
            # gán self._last_report để execute đính vào ActionLogEntry.report.
            self._last_report = None

            logger.debug(f"Calling handler for {action_id}...")
            success = await handler(pdf_path, output_path, params)
            logger.debug(f"Handler returned: {success}")

            # GS có thể trả returncode 0 mà KHÔNG ghi output (input hỏng, filter
            # lỗi im lặng). Nếu handler báo success nhưng file không tồn tại / rỗng
            # → coi là thất bại, tránh trả success rồi /download 404.
            if success and (not os.path.exists(output_path) or os.path.getsize(output_path) == 0):
                success = False
                logger.error("Action %s: handler báo success nhưng output không hợp lệ: %s", action_id, output_path)

            duration = int((datetime.now() - start).total_seconds() * 1000)

            base_msg = (
                f"{AVAILABLE_ACTIONS[action_id]['title']} "
                f"{'thành công' if success else 'thất bại'}."
            )
            report = self._last_report
            if report:
                if report.get("max_delta_e") is not None:
                    base_msg += (
                        f" ΔE max={report.get('max_delta_e', 0):.2f}, "
                        f"avg={report.get('avg_delta_e', 0):.2f}, "
                        f"OOG={report.get('out_of_gamut_count', 0)}."
                    )
                for warn in report.get("warnings", []):
                    base_msg += f" ⚠ {warn}"

            log_entry = ActionLogEntry(
                action_id=action_id,
                status="success" if success else "failed",
                message=base_msg,
                duration_ms=duration,
                report=report,
            )

            return ActionResult(
                success=success,
                output_path=output_path if success else None,
                log=[log_entry],
            )

        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            duration = int((datetime.now() - start).total_seconds() * 1000)
            logger.error(f"Action {action_id} failed: {tb}")
            return ActionResult(
                success=False,
                error=repr(e),
                log=[ActionLogEntry(
                    action_id=action_id, status="failed",
                    message=repr(e), duration_ms=duration,
                )],
            )

    async def execute_batch(
        self, pdf_path: str, actions: list[dict], original_name: str | None = None
    ) -> ActionResult:
        """
        Execute a chain of actions sequentially (pipeline).
        Each action's output becomes the next action's input.
        """
        all_logs: list[ActionLogEntry] = []
        current_input = pdf_path
        final_output = None

        for action_spec in actions:
            action_id = action_spec.get("id", "")
            params = action_spec.get("params", {})

            result = await self.execute(current_input, action_id, params, original_name=original_name if current_input == pdf_path else None)
            all_logs.extend(result.log)

            if not result.success:
                return ActionResult(
                    success=False,
                    output_path=None,
                    log=all_logs,
                    error=f"Pipeline dừng tại '{action_id}': {result.error}",
                )

            # Clean up intermediate files (keep only final output)
            if final_output and os.path.exists(final_output) and final_output != pdf_path:
                try:
                    os.remove(final_output)
                except OSError:
                    pass

            final_output = result.output_path
            current_input = result.output_path

        return ActionResult(
            success=True,
            output_path=final_output,
            log=all_logs,
        )

    # ────────────────────────────────────────────────────────
    #  ACTION HANDLERS
    # ────────────────────────────────────────────────────────

    @staticmethod
    def _detect_spot_names(pdf_path: str) -> list[str]:
        """Liệt kê tên màu Spot/Separation/DeviceN trong file (best-effort).

        Dùng để cảnh báo trước khi CONVERT_TO_CMYK: GS ``ColorConversionStrategy=
        CMYK`` có thể chuyển các kênh này thành process → mất kênh bế/khắc (Dieline,
        CutContour) và màu pha (Pantone). Chỉ đọc, không sửa file.
        """
        names: set[str] = set()
        try:
            with pikepdf.open(pdf_path) as pdf:
                for page in pdf.pages:
                    res = page.get("/Resources")
                    if not res:
                        continue
                    cs_dict = res.get("/ColorSpace")
                    if not cs_dict:
                        continue
                    try:
                        items = list(cs_dict.items())
                    except Exception:
                        continue
                    for _n, ref in items:
                        try:
                            cs = ref.resolve() if hasattr(ref, "resolve") and callable(getattr(ref, "resolve", None)) else ref
                            if not isinstance(cs, pikepdf.Array) or len(cs) < 2:
                                continue
                            head = str(cs[0])
                            if head == "/Separation":
                                names.add(str(cs[1]).lstrip("/"))
                            elif head == "/DeviceN":
                                comp = cs[1]
                                comp = comp.resolve() if hasattr(comp, "resolve") and callable(getattr(comp, "resolve", None)) else comp
                                if isinstance(comp, pikepdf.Array):
                                    for c in comp:
                                        names.add(str(c).lstrip("/"))
                        except Exception:
                            continue
        except Exception:
            pass
        return sorted(names)

    async def _action_convert_to_cmyk(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Convert all RGB objects to CMYK using Ghostscript + ICC profile.

        An toàn màu (khác GS thô):
          - Pre-pass GIỮ ĐEN 100%K: GS biến RGB(0,0,0) thành rich-black 4 màu (lệch
            chồng màu chữ đen). Đổi RGB-đen-thuần → DeviceGray trước để GS map K-only.
          - ``-dConvertCMYKImagesToProcess=false``: giữ ảnh vốn đã CMYK, không re-sep.
          - Cảnh báo spot/dieline: GS có thể chuyển Separation/DeviceN → process, mất
            kênh bế (CutContour/Dieline) và màu pha (Pantone). ``skip_black_prepass``
            để bỏ pre-pass giữ đen.
        """
        import os
        import tempfile

        profile_name = params.get("icc_profile", self.default_profile)
        icc_path = os.path.join(self.icc_dir, profile_name)

        if not os.path.exists(icc_path):
            raise FileNotFoundError(f"ICC Profile không tìm thấy: {icc_path}")

        warnings: list[str] = []

        # ── Cảnh báo spot/dieline trước khi chuyển ──
        try:
            spots = await asyncio.to_thread(self._detect_spot_names, input_path)
            if spots:
                shown = ", ".join(spots[:6])
                more = f" (+{len(spots) - 6})" if len(spots) > 6 else ""
                warnings.append(
                    f"File có màu Spot/Separation: {shown}{more}. Convert CMYK có thể "
                    "chuyển các kênh này thành process → MẤT kênh bế (CutContour/"
                    "Dieline) hoặc màu pha (Pantone). Kiểm tra kỹ trước khi in."
                )
        except Exception as e:
            logger.debug("detect spot names failed: %s", e)

        # ── Pre-pass giữ đen 100%K ──
        gs_input = input_path
        tmp_pb: str | None = None
        if not params.get("skip_black_prepass"):
            from app.core.preserve_black import force_pure_black_to_gray
            fd, tmp_pb = tempfile.mkstemp(suffix="_pb.pdf", dir=str(self.output_dir))
            os.close(fd)
            try:
                await asyncio.to_thread(force_pure_black_to_gray, input_path, tmp_pb)
                gs_input = tmp_pb
            except Exception as pe:
                logger.warning("Pre-pass giữ đen thất bại (%s) — tiếp tục không pre-pass.", pe)
                if os.path.exists(tmp_pb):
                    os.remove(tmp_pb)
                tmp_pb = None
                gs_input = input_path

        cmd = [
            self.gs_path,
            # NOSAFER: CONVERT_TO_CMYK phải đọc file ICC bundle ngoài (GS 10 mặc
            # định SAFER chặn). Các action GS khác dùng SAFER (không đọc file ngoài).
            "-dNOSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dAutoRotatePages=/None",
            "-sColorConversionStrategy=CMYK",
            "-sProcessColorModel=DeviceCMYK",
            "-dConvertCMYKImagesToProcess=false",
            f"-sOutputICCProfile={icc_path}",
            "-dOverrideICC=true",
            f"-sOutputFile={output_path}",
            gs_input,
        ]
        try:
            ok = await self._run_gs(cmd, "CONVERT_TO_CMYK")
        finally:
            if tmp_pb and os.path.exists(tmp_pb):
                try:
                    os.remove(tmp_pb)
                except OSError:
                    pass

        if ok and warnings:
            self._last_report = {"warnings": warnings}
        return ok

    async def _action_flatten_transparency(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Flatten all transparency in the PDF using Ghostscript.

        Ép ``-dCompatibilityLevel=1.3`` (PDF 1.3 không hỗ trợ trong suốt nên GS
        buộc phải flatten thật). Nhưng hạ xuống 1.3 cũng ĐÁNH MẤT OCG (layer) và
        có thể chuyển spot→process ở vùng chồng lấp. Đây là đánh đổi cố hữu, không
        sửa được bằng cờ khác → dò trước và CẢNH BÁO để người dùng biết.
        """
        warnings: list[str] = []
        try:
            has_ocg, has_spot = await asyncio.to_thread(
                self._detect_ocg_and_spot, input_path
            )
            if has_ocg:
                warnings.append(
                    "File có Layer (OCG). Flatten hạ PDF về 1.3 sẽ GỘP/MẤT layer — "
                    "không thể tách lại. Cân nhắc giữ bản gốc."
                )
            if has_spot:
                warnings.append(
                    "File có màu Spot/Separation (Pantone/dieline). Flatten vùng chồng "
                    "lấp trong suốt có thể chuyển spot sang process (sai màu pha). "
                    "Kiểm tra kênh màu sau khi flatten."
                )
        except Exception as e:
            logger.debug("detect OCG/spot trước flatten thất bại: %s", e)

        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dAutoRotatePages=/None",
            "-dCompatibilityLevel=1.3",  # Force PDF 1.3 (physically flattens transparency)
            "-dBackgroundColor=16#ffffff", # Fallback for alpha channels
            f"-sOutputFile={output_path}",
            input_path,
        ]
        ok = await self._run_gs(cmd, "FLATTEN_TRANSPARENCY")
        if ok and warnings:
            self._last_report = {"warnings": warnings}
        return ok

    @staticmethod
    def _detect_ocg_and_spot(pdf_path: str) -> tuple[bool, bool]:
        """Dò nhanh (cấu trúc, không render) file có OCG (layer) và/hoặc màu Spot.

        - OCG: ``/Root/OCProperties`` tồn tại.
        - Spot: bất kỳ ColorSpace ``/Separation`` hoặc ``/DeviceN`` nào trong
          resource của trang (đệ quy Form XObject qua resource_walker).
        """
        has_ocg = False
        has_spot = False
        try:
            with pikepdf.open(pdf_path) as pdf:
                try:
                    root = pdf.Root
                    if root.get("/OCProperties") is not None:
                        has_ocg = True
                except Exception:
                    pass

                from app.core.preflight_rules.resource_walker import iter_resource_dicts

                for page in pdf.pages:
                    if has_spot:
                        break
                    try:
                        for res in iter_resource_dicts(page, pdf):
                            cs_dict = res.get("/ColorSpace")
                            if cs_dict is None:
                                continue
                            if hasattr(cs_dict, "resolve"):
                                cs_dict = cs_dict.resolve()
                            if not isinstance(cs_dict, pikepdf.Dictionary):
                                continue
                            for _n, cs in cs_dict.items():
                                s = str(cs)
                                if "Separation" in s or "DeviceN" in s:
                                    has_spot = True
                                    break
                            if has_spot:
                                break
                    except Exception:
                        continue
        except Exception:
            pass
        return has_ocg, has_spot

    async def _action_embed_fonts(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Force-embed all fonts using Ghostscript."""
        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dAutoRotatePages=/None",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            f"-sOutputFile={output_path}",
            input_path,
        ]
        return await self._run_gs(cmd, "EMBED_FONTS")

    async def _action_outline_fonts(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Convert all text to outlines (curves) — triệt để hơn GS đơn thuần.

        GS ``-dNoOutputFonts`` chỉ outline text trong content stream trang; nó BỎ
        SÓT text trong annotation / AcroForm field, và với font CHƯA nhúng thì mượn
        font hệ thống → dễ rơi ký tự (tiếng Việt có dấu). Pipeline:

          1. Embed font chưa nhúng (GS ``-dEmbedAllFonts``) để outline dùng đúng
             glyph gốc; dò lại để cảnh báo font GS KHÔNG nhúng được (thật sự thiếu).
          2. Flatten annotation + form field vào content stream (bake text ẩn).
          3. GS ``-dNoOutputFonts`` outline toàn bộ content stream.
          4. Verify: đếm text còn sót, cảnh báo nếu chưa triệt để.

        Params:
          - ``skip_embed=True``   bỏ bước embed (khi caller đã tự embed).
          - ``skip_flatten=True`` bỏ bước flatten (khi caller đã tự flatten).
        """
        import os
        import tempfile

        from app.core.outline_fonts import (
            count_live_text,
            detect_unembedded_fonts,
            flatten_annotations_and_forms,
        )

        warnings: list[str] = []
        # File tạm trung gian cần dọn ở cuối (embed / flatten output).
        temps: list[str] = []

        def _mk_temp(suffix: str) -> str:
            fd, path = tempfile.mkstemp(suffix=suffix, dir=str(self.output_dir))
            os.close(fd)
            temps.append(path)
            return path

        current_input = input_path

        # ── (1) Embed font chưa nhúng TRƯỚC khi outline ──
        # Outline (GS -dNoOutputFonts) vẽ glyph theo font mà GS phân giải được. Nếu
        # font chưa nhúng, GS mượn font hệ thống → sai mặt chữ / rơi ký tự có dấu.
        # Embed trước (GS tự tìm & nhúng nếu có) giúp outline dùng đúng glyph gốc.
        try:
            unembedded_before = await asyncio.to_thread(
                detect_unembedded_fonts, current_input
            )
        except Exception as e:
            logger.debug("detect_unembedded_fonts (pre) failed: %s", e)
            unembedded_before = []

        if unembedded_before and not params.get("skip_embed"):
            tmp_embed = _mk_temp("_embed.pdf")
            embed_cmd = [
                self.gs_path,
                "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                "-sDEVICE=pdfwrite",
                "-dPDFSETTINGS=/prepress",
                "-dAutoRotatePages=/None",
                "-dEmbedAllFonts=true",
                "-dSubsetFonts=true",
                f"-sOutputFile={tmp_embed}",
                current_input,
            ]
            try:
                if await self._run_gs(embed_cmd, "OUTLINE_FONTS(embed)"):
                    current_input = tmp_embed
                    logger.info("OUTLINE_FONTS: embed font trước outline")
            except Exception as e:
                logger.warning("OUTLINE_FONTS embed skipped: %s", e)

            # Dò lại: font còn chưa nhúng SAU embed = GS không tìm được (thật sự
            # thiếu) → outline sẽ dùng font thay thế cho chính các font này.
            try:
                still = await asyncio.to_thread(detect_unembedded_fonts, current_input)
            except Exception:
                still = unembedded_before
            if still:
                shown = ", ".join(still[:5])
                more = f" (+{len(still) - 5})" if len(still) > 5 else ""
                warnings.append(
                    f"Không nhúng được font: {shown}{more} (không có sẵn trong hệ "
                    "thống). Outline các font này dùng font thay thế → có thể SAI mặt "
                    "chữ hoặc RƠI ký tự có dấu. Cần bản có nhúng font gốc."
                )
        elif unembedded_before:
            # skip_embed: chỉ cảnh báo, không tự embed.
            shown = ", ".join(unembedded_before[:5])
            more = f" (+{len(unembedded_before) - 5})" if len(unembedded_before) > 5 else ""
            warnings.append(
                f"Font chưa nhúng: {shown}{more}. Khi outline, GS phải mượn font "
                "thay thế → có thể SAI mặt chữ hoặc RƠI ký tự (đặc biệt chữ có dấu)."
            )

        # ── (2) Flatten annotation / form field ──
        if not params.get("skip_flatten"):
            tmp_flat = _mk_temp("_flat.pdf")
            try:
                flattened = await asyncio.to_thread(
                    flatten_annotations_and_forms, current_input, tmp_flat
                )
                if flattened > 0:
                    current_input = tmp_flat
                    logger.info("OUTLINE_FONTS: flatten %d trang trước outline", flattened)
            except Exception as e:
                logger.warning("OUTLINE_FONTS flatten skipped: %s", e)

        # ── (3) GS outline ──
        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dAutoRotatePages=/None",
            "-dNoOutputFonts",
            f"-sOutputFile={output_path}",
            current_input,
        ]
        try:
            ok = await self._run_gs(cmd, "OUTLINE_FONTS")
        finally:
            for p in temps:
                if os.path.exists(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass

        if not ok:
            return False

        # ── (4) Verify text còn sót ──
        try:
            live = await asyncio.to_thread(count_live_text, output_path)
            if live.get("content_chars", 0) > 0:
                warnings.append(
                    f"Còn {live['content_chars']} ký tự text SỐNG sau outline "
                    "(có thể Type3 font hoặc text GS không outline được). "
                    "Kiểm tra thủ công trước khi in."
                )
            if live.get("annot_text_pages"):
                pages = ", ".join(str(p) for p in live["annot_text_pages"][:10])
                warnings.append(
                    f"Còn annotation mang text ở trang: {pages}. "
                    "Phần này không được outline."
                )
        except Exception as e:
            logger.debug("count_live_text verify failed: %s", e)

        if warnings:
            self._last_report = {"warnings": warnings}

        return True

    async def _action_downscale_images(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Downscale high-res images to 300 DPI using Ghostscript."""
        target_dpi = params.get("target_dpi", 300)
        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dAutoRotatePages=/None",
            f"-dDownsampleColorImages=true",
            f"-dColorImageResolution={target_dpi}",
            f"-dDownsampleGrayImages=true",
            f"-dGrayImageResolution={target_dpi}",
            f"-dDownsampleMonoImages=true",
            f"-dMonoImageResolution={target_dpi}",
            f"-sOutputFile={output_path}",
            input_path,
        ]
        return await self._run_gs(cmd, "DOWNSCALE_IMAGES")

    async def _action_fix_metadata(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Clean sensitive metadata and update Producer using pikepdf."""
        try:
            with pikepdf.open(input_path) as pdf:
                # Clear sensitive metadata fields
                with pdf.open_metadata() as meta:
                    # Remove common sensitive fields
                    sensitive_keys = [
                        '{http://purl.org/dc/elements/1.1/}creator',
                        '{http://ns.adobe.com/xap/1.0/}CreatorTool',
                        '{http://ns.adobe.com/pdf/1.3/}Producer',
                    ]
                    for key in sensitive_keys:
                        try:
                            del meta[key]
                        except (KeyError, TypeError):
                            pass

                    # Set our own producer
                    meta['{http://ns.adobe.com/pdf/1.3/}Producer'] = 'PDF Inspector — PrintSolutions.vn'

                # Also update the Info dictionary
                if pdf.docinfo:
                    pdf.docinfo[pikepdf.Name.Author] = pikepdf.String("")
                    pdf.docinfo[pikepdf.Name.Creator] = pikepdf.String("PDF Inspector")
                    pdf.docinfo[pikepdf.Name.Producer] = pikepdf.String("PDF Inspector — PrintSolutions.vn")

                pdf.save(output_path)
                logger.info(f"FIX_METADATA: Cleaned metadata → {output_path}")
                return True

        except Exception as e:
            logger.error(f"FIX_METADATA failed: {e}")
            raise

    # ────────────────────────────────────────────────────────
    #  FIX HAIRLINES (pikepdf)
    # ────────────────────────────────────────────────────────

    async def _action_fix_hairlines(self, pdf_path: str, output_path: str, params: dict) -> bool:
        """Phát hiện & tăng độ dày các NÉT (stroke) mảnh hơn ngưỡng.

        An toàn màu / đường khuôn:
          - CHỈ xử lý path có nét (``color`` khác ``None``). Path chỉ-tô (fill) không
            mang khái niệm "độ dày nét" nên không phải hairline; bỏ qua chúng cũng
            đồng thời tránh lỗi ``len(None)`` khi ``finish(color=None)``.
          - Bao gồm cả nét ``width == 0`` (toán tử ``0 w`` — hairline kinh điển, mảnh
            nhất, dễ biến mất khi in offset nhất).
          - BỎ QUA path dùng màu Spot/Separation (vd đường bế CutContour/Dieline):
            vẽ đè bằng DeviceRGB/CMYK sẽ làm sai màu, sai khổ và mất kênh spot.
        """
        from app.workers.pdf_ops import new_shape
        from app.workers.pdf_content_parser import extract_vector_paths

        threshold = params.get("threshold_pt", 0.1)
        replace_with = params.get("replace_pt", 0.25)

        try:
            pdf = pikepdf.Pdf.open(pdf_path)
            total_fixed = 0

            for pike_page in pdf.pages:
                drawings = extract_vector_paths(pike_page, pdf)
                shape = new_shape(pdf, pike_page)
                fixed_on_page = 0

                for path in drawings:
                    color = path.get("color")
                    # Chỉ NÉT mới có độ dày để sửa; bỏ path chỉ-tô (color=None).
                    if color is None:
                        continue
                    # Giữ nguyên nét màu Spot/Separation (đường bế, vạch kỹ thuật).
                    if path.get("spot_name"):
                        continue
                    width = path.get("width", 0)
                    # Gồm cả width == 0 (hairline '0 w'); loại width > threshold.
                    if not (0 <= width <= threshold):
                        continue

                    fill = path.get("fill")
                    items = path.get("items", [])
                    closePath = path.get("closePath", False)

                    for item in items:
                        if item[0] == "l":      # line
                            shape.draw_line(item[1], item[2])
                        elif item[0] == "re":   # rect
                            shape.draw_rect(item[1])
                        elif item[0] == "c":    # curve (bezier)
                            shape.draw_bezier(item[1], item[2], item[3], item[4])

                    if items:
                        shape.finish(
                            color=color,
                            fill=fill,
                            width=replace_with,
                            closePath=closePath,
                        )
                        fixed_on_page += 1

                if fixed_on_page > 0:
                    shape.commit()
                    total_fixed += fixed_on_page

            pdf.save(output_path)
            pdf.close()

            logger.info(f"FIX_HAIRLINES: Fixed {total_fixed} hairlines (<= {threshold}pt -> {replace_with}pt)")
            return True

        except Exception as e:
            logger.error(f"FIX_HAIRLINES failed: {e}")
            raise

    # ────────────────────────────────────────────────────────
    #  SET BLACK OVERPRINT (Ghostscript)
    # ────────────────────────────────────────────────────────

    async def _action_set_black_overprint(self, pdf_path: str, output_path: str, params: dict) -> bool:
        """Bật overprint THỰC SỰ cho text/nét đen (K>95%) bằng pikepdf.

        Trước đây dùng Ghostscript ``-dOverprint=/enable -dOPM=1`` — nhưng pdfwrite
        chỉ ghi ``/OPM`` (mode) chứ KHÔNG ghi cờ ``/OP``/``/op`` true, nên object đen
        vẫn knockout (lỗi viền trắng không được khắc phục). Nay chèn ExtGState
        overprint vào đúng object đen (xem app.core.overprint_black).

        Tôn trọng tham số: ``overprint_black`` (công tắc), ``preserve_overprint``.
        (``trap_width``/``black_trap_width`` là trapping spread/choke ở mức RIP —
        ngoài phạm vi công cụ này; xem cảnh báo trên UI.)
        """
        from app.core.overprint_black import apply_black_overprint

        def _work():
            return apply_black_overprint(pdf_path, output_path, params or {})

        count = await asyncio.to_thread(_work)
        logger.info(f"SET_BLACK_OVERPRINT: bật overprint cho {count} thao tác vẽ object đen")
        return True

    # ────────────────────────────────────────────────────────
    #  REMOVE CHANNELS (channel_remover)
    # ────────────────────────────────────────────────────────

    async def _action_remove_channels(self, pdf_path: str, output_path: str, params: dict) -> bool:
        """Gỡ kênh process (C/M/Y/K) khỏi PDF, có bù màu re-separation.

        Theo mẫu ``_action_set_black_overprint``: hàm lõi đồng bộ
        ``remove_channels`` (app.core.channel_remover) được chạy qua
        ``asyncio.to_thread`` để không chặn event loop. ``output_path`` do
        ``execute`` dựng sẵn nằm dưới ``RESULTS_DIR/preflight_output`` (Req 9.1),
        nên file kết quả tải được qua Download_Endpoint và ``output_filename`` =
        ``Path(output_path).name`` (Req 9.2).

        Báo cáo (max/avg ΔE, OOG count, warnings) được đính vào
        ``self._last_report`` để ``execute`` gắn vào ``ActionLogEntry.report`` và
        tóm tắt vào message — không cần đổi ``FixResponse`` (task 11.2 surface sau).
        (Req 9.1, 9.2, 9.3)
        """
        from app.core.channel_remover import remove_channels

        def _work():
            return remove_channels(pdf_path, output_path, params or {})

        report = await asyncio.to_thread(_work)

        self._last_report = {
            "output_filename": report.output_filename,
            "max_delta_e": report.max_delta_e,
            "avg_delta_e": report.avg_delta_e,
            "out_of_gamut_count": report.out_of_gamut_count,
            "total_colors": report.total_colors,
            "warnings": list(report.warnings),
            "identical_to_original": report.identical_to_original,
        }

        logger.info(
            "REMOVE_CHANNELS: colors=%d oog=%d ΔEmax=%.2f ΔEavg=%.2f warnings=%d -> %s",
            report.total_colors, report.out_of_gamut_count,
            report.max_delta_e, report.avg_delta_e,
            len(report.warnings), output_path,
        )
        return True

    # ────────────────────────────────────────────────────────
    #  GHOSTSCRIPT SUBPROCESS RUNNER
    # ────────────────────────────────────────────────────────

    async def _run_gs(self, cmd: list[str], action_name: str) -> bool:
        """Run a Ghostscript command asynchronously (Windows-compatible)."""
        import subprocess
        from app.utils.subprocess_utils import run_hidden
        logger.info(f"GS [{action_name}]: {' '.join(cmd[:6])}...")

        def _run_sync():
            return run_hidden(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=300,  # 5 min max
            )

        try:
            result = await asyncio.to_thread(_run_sync)

            if result.returncode != 0:
                err = result.stderr.decode("utf-8", errors="ignore").strip()
                if not err:
                    err = result.stdout.decode("utf-8", errors="ignore").strip()
                raise RuntimeError(f"Lỗi hệ thống khi xử lý (mã {result.returncode}): {err[:500]}")

            logger.info(f"GS [{action_name}]: Success")
            return True

        except FileNotFoundError:
            raise RuntimeError(
                f"Lỗi: Không tìm thấy module xử lý đồ họa lõi. "
                "Vui lòng liên hệ kỹ thuật viên để cài đặt bổ sung thư viện nền tảng."
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Hệ thống xử lý quá hạn (>5 phút) cho thao tác {action_name}")

    @staticmethod
    def get_available_actions() -> dict:
        """Return metadata for all available actions (for UI rendering)."""
        return AVAILABLE_ACTIONS
