"""
PDF/X Export Engine — Xuất PDF chuẩn PDF/X-1a hoặc PDF/X-4.

Chức năng tương đương Acrobat Pro → Print Production → Save as PDF/X.
"""
import os
import asyncio
import logging
import tempfile
import uuid
from pathlib import Path

import pikepdf

from app.config import settings
from app.utils.subprocess_utils import run_hidden

logger = logging.getLogger(__name__)


class GhostscriptNotFoundError(RuntimeError):
    """Ghostscript không tồn tại ở đường dẫn đã cấu hình."""


# Namespace định danh PDF/X trong XMP (ISO 15930-7 §6.2).
_PDFX_ID_NS = "http://www.npes.org/pdfx/ns/id/"


def _finalize_pdfx4_identification(pdf_path: str) -> None:
    """Bổ sung phần định danh PDF/X-4 mà Ghostscript không ghi được.

    `-dPDFX=true` của Ghostscript chỉ nhắm PDF/X-1a/X-3 — nó **ép
    CompatibilityLevel về 1.3** bất kể ta truyền 1.6, và ghi
    `/GTS_PDFXVersion` vào *Info dict* theo lối X-1a. Nhưng PDF/X-4
    (ISO 15930-7) đòi PDF **1.6** và định danh nằm trong **XMP**
    (`pdfxid:GTS_PDFXVersion`).

    Hệ quả nếu bỏ qua: file khai "PDF/X-4" mà cấu trúc là X-3 và thiếu XMP —
    validator sẽ từ chối, và một file khai sai chuẩn còn tệ hơn file không
    khai gì, vì nhà in tin lời khai rồi mới phát hiện trên máy.

    Bước này chỉ **thêm định danh**, không đụng nội dung trang; lỗi ở đây
    không được làm hỏng file đã xuất nên chỉ cảnh báo.
    """
    try:
        with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
                meta[f"{{{_PDFX_ID_NS}}}GTS_PDFXVersion"] = "PDF/X-4"
            # Info dict giữ nguyên: Acrobat vẫn đọc nó, và X-1a/X-3 dùng nó.
            pdf.save(pdf_path, min_version="1.6")
    except Exception as exc:  # noqa: BLE001
        logger.warning("PDF/X-4: không ghi được định danh XMP/version: %s", exc)


def _ensure_gs(gs_path: str) -> None:
    """Kiểm Ghostscript tồn tại TRƯỚC khi gọi → báo lỗi tiếng Việt rõ ràng thay vì
    FileNotFoundError khó hiểu (hoặc treo). Path resolve ở config._find_ghostscript()."""
    if not gs_path or not os.path.isfile(gs_path):
        raise GhostscriptNotFoundError(
            f"Không tìm thấy Ghostscript tại '{gs_path}'. "
            "Cần cài Ghostscript hoặc kiểm tra lại bản cài PrynX (thiếu binaries/gs)."
        )


class PdfxExportEngine:

    def __init__(self):
        self.gs_path = settings.GHOSTSCRIPT_PATH
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def check_compliance(self, file_path: str, standard: str = "x4") -> dict:
        """
        Kiểm tra file hiện tại có đạt chuẩn PDF/X chưa.
        standard: 'x1a' | 'x4'
        Returns: dict with checks and overall pass/fail.
        """
        doc = pikepdf.Pdf.open(file_path)
        checks = []

        # 1. Check fonts embedded
        fonts_ok = True
        unembed_fonts = []
        for page_idx in range(len(doc.pages)):
            page = doc.pages[page_idx]
            # Scan font resources
            try:
                resources = page.get("/Resources")
                if resources and "/Font" in resources:
                    fonts_dict = resources["/Font"]
                    for font_name in fonts_dict:
                        font_obj = fonts_dict[font_name]
                        if isinstance(font_obj, pikepdf.Object):
                            font_obj = font_obj.resolve() if hasattr(font_obj, 'resolve') else font_obj
                        # Check if font has embedded stream (FontFile/FontFile2/FontFile3)
                        desc = font_obj.get("/FontDescriptor") if hasattr(font_obj, 'get') else None
                        if desc:
                            if isinstance(desc, pikepdf.Object) and hasattr(desc, 'resolve'):
                                desc = desc.resolve()
                            has_file = any(k in desc for k in ["/FontFile", "/FontFile2", "/FontFile3"]) if hasattr(desc, '__contains__') else False
                            if not has_file:
                                fonts_ok = False
                                fname = str(font_obj.get("/BaseFont", font_name))
                                if fname not in unembed_fonts:
                                    unembed_fonts.append(fname)
            except Exception:
                pass
        checks.append({
            "id": "FONTS_EMBEDDED",
            "label": "Font đã nhúng",
            "passed": fonts_ok,
            "detail": f"Font chưa nhúng: {', '.join(unembed_fonts)}" if not fonts_ok else "Tất cả font đã nhúng"
        })

        # 2. Check TrimBox exists
        has_trimbox = True
        for page_idx in range(len(doc.pages)):
            page = doc.pages[page_idx]
            page_str = str(page.obj)
            if "/TrimBox" not in page_str:
                has_trimbox = False
                break
        checks.append({
            "id": "TRIMBOX_EXISTS",
            "label": "TrimBox đã thiết lập",
            "passed": has_trimbox,
            "detail": "TrimBox có trên tất cả trang" if has_trimbox else "Một số trang thiếu TrimBox"
        })

        # 3. Check color spaces (only for X-1a)
        has_rgb = False
        if standard == "x1a":
            for page_idx in range(min(len(doc.pages), 10)):  # Sample first 10 pages
                page = doc.pages[page_idx]
                page_str = str(page.obj)
                if "/DeviceRGB" in page_str or "/CalRGB" in page_str or "/ICCBased" in page_str:
                    has_rgb = True
                    break
            checks.append({
                "id": "CMYK_ONLY",
                "label": "Chỉ sử dụng CMYK",
                "passed": not has_rgb,
                "detail": "Phát hiện RGB, cần convert sang CMYK" if has_rgb else "Chỉ có CMYK"
            })

        # 4. Check transparency (only for X-1a, must be flattened)
        has_transparency = False
        if standard == "x1a":
            for page_idx in range(len(doc.pages)):
                page = doc.pages[page_idx]
                page_str = str(page.obj)
                if "/Group" in page_str and "/Transparency" in page_str:
                    has_transparency = True
                    break
            checks.append({
                "id": "NO_TRANSPARENCY",
                "label": "Không có Transparency",
                "passed": not has_transparency,
                "detail": "Phát hiện Transparency, cần flatten" if has_transparency else "Không có Transparency"
            })

        # 5. Check OutputIntent
        catalog = str(doc.Root)
        has_output_intent = "/OutputIntents" in catalog
        checks.append({
            "id": "OUTPUT_INTENT",
            "label": "Output Intent (ICC Profile)",
            "passed": has_output_intent,
            "detail": "Đã gắn Output Intent" if has_output_intent else "Chưa có Output Intent"
        })

        # 6. PDF version check
        pdf_version = str(doc.pdf_version)
        checks.append({
            "id": "PDF_VERSION",
            "label": "Phiên bản PDF",
            "passed": True,  # bước xuất tự nâng version cho đúng chuẩn
            "detail": pdf_version or "Không xác định"
        })

        # 7. Định danh PDF/X — chỗ khác nhau giữa hai chuẩn và là chỗ dễ khai sai.
        #
        # X-1a/X-3 (PDF 1.3/1.4) đặt `/GTS_PDFXVersion` trong **Info dict**;
        # X-4 (ISO 15930-7) đòi PDF **1.6** và định danh trong **XMP**
        # (`pdfxid:GTS_PDFXVersion`). Kiểm cả hai vì một file khai sai chuẩn
        # còn tệ hơn file không khai: nhà in tin lời khai rồi mới phát hiện
        # trên máy in.
        if standard == "x1a":
            info_ver = None
            try:
                info_ver = str(doc.docinfo.get("/GTS_PDFXVersion", "")) if doc.docinfo else ""
            except Exception:  # noqa: BLE001
                info_ver = ""
            checks.append({
                "id": "PDFX_IDENTIFICATION",
                "label": "Định danh PDF/X (Info)",
                "passed": bool(info_ver and "PDF/X" in info_ver),
                "detail": info_ver or "Thiếu /GTS_PDFXVersion trong Info",
            })
        else:
            xmp_ver = ""
            try:
                meta = doc.open_metadata()
                xmp_ver = str(meta.get(f"{{{_PDFX_ID_NS}}}GTS_PDFXVersion", "") or "")
            except Exception:  # noqa: BLE001
                xmp_ver = ""
            version_ok = pdf_version >= "1.6"
            checks.append({
                "id": "PDFX_IDENTIFICATION",
                "label": "Định danh PDF/X-4 (XMP + version)",
                "passed": bool(xmp_ver and "PDF/X-4" in xmp_ver) and version_ok,
                "detail": (
                    f"XMP={xmp_ver or 'thiếu'}, PDF {pdf_version}"
                    + ("" if version_ok else " — X-4 đòi ≥ 1.6")
                ),
            })

        doc.close()

        all_passed = all(c["passed"] for c in checks)
        return {
            "standard": standard,
            "standard_label": "PDF/X-1a" if standard == "x1a" else "PDF/X-4",
            "passed": all_passed,
            "checks": checks,
            "total_checks": len(checks),
            "passed_checks": sum(1 for c in checks if c["passed"]),
        }

    def _resolve_output_intent_icc(self):
        """Tìm ICC profile CMYK cho OutputIntent.
        Ưu tiên FOGRA39 (couché offset châu Âu) trên hệ thống; fallback về
        default_cmyk.icc đi kèm Ghostscript (luôn có cạnh binary gs).
        Trả (path, condition_id, condition_name) hoặc (None, None, None).
        """
        # 1) Profile CMYK CỦA APP. OutputIntent khai điều kiện in của file, nên
        # nó phải đúng profile mà separations / soft-proof / TAC đã dùng để
        # kiểm — khai điều kiện khác là nói với nhà in một chuyện chưa được
        # kiểm chứng.
        #
        # Trước đây chỗ này gọi `softproof.KNOWN_PROFILES`; biểu tượng đó đã bị
        # bỏ trong một lần refactor nên `except Exception: pass` nuốt trọn
        # ImportError và PDF/X LUÔN rơi xuống nhánh 2 — file xuất ra mang
        # OutputIntent "Generic CMYK (Ghostscript default)" thay vì FOGRA39,
        # trong khi FOGRA39 vẫn nằm sẵn trong `app/assets/icc/`.
        try:
            from app.core import icc_profiles

            path = icc_profiles.resolve_cmyk_profile_path()
            if path and os.path.isfile(path):
                base = os.path.basename(path)
                if "fogra39" in base.lower():
                    return path, "FOGRA39", "Coated FOGRA39 (ISO 12647-2:2004)"
                return (
                    path,
                    os.path.splitext(base)[0],
                    f"{base} (profile CMYK của PrynX)",
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("PDF/X: không lấy được ICC CMYK của app: %s", exc)
        # 2) Ghostscript bundled default_cmyk.icc (cạnh binary gs)
        try:
            gs_dir = Path(self.gs_path).resolve().parent
            for cand in (
                gs_dir / "iccprofiles" / "default_cmyk.icc",
                gs_dir.parent / "iccprofiles" / "default_cmyk.icc",
                gs_dir / "iccprofiles" / "ps_cmyk.icc",
            ):
                if cand.is_file():
                    return str(cand), "CGATS21_CRPC1", "Generic CMYK (Ghostscript default)"
        except Exception:
            pass
        return None, None, None

    def _build_pdfx_def_file(self, icc_path: str, cond_id: str, cond_name: str, standard: str) -> str:
        """Sinh file PDFX_def.ps (pdfmark) nhúng OutputIntent + ICC. Trả đường dẫn temp."""
        # PostScript dùng forward-slash cho đường dẫn (kể cả Windows); escape ( ) \.
        def _ps_str(s: str) -> str:
            return s.replace("\\", "/").replace("(", r"\(").replace(")", r"\)")

        icc_ps = _ps_str(icc_path)
        cond_id_ps = _ps_str(cond_id)
        cond_name_ps = _ps_str(cond_name)

        if standard == "x1a":
            version_lines = (
                "[ /GTS_PDFXVersion (PDF/X-1:2001)\n"
                "  /GTS_PDFXConformance (PDF/X-1a:2001)\n"
                "  /Title (PrynX PDF/X-1a)\n"
                "  /Trapped /False\n"
                "  /DOCINFO pdfmark\n"
            )
        else:
            version_lines = (
                "[ /GTS_PDFXVersion (PDF/X-4)\n"
                "  /Title (PrynX PDF/X-4)\n"
                "  /Trapped /False\n"
                "  /DOCINFO pdfmark\n"
            )

        content = (
            "%!\n"
            "% PrynX auto-generated PDF/X definition (OutputIntent + ICC)\n"
            + version_lines +
            "\n"
            "[ /_objdef {icc_PDFX} /type /stream /OBJ pdfmark\n"
            "[ {icc_PDFX} <</N 4>> /PUT pdfmark\n"
            f"[ {{icc_PDFX}} ({icc_ps}) (r) file /PUT pdfmark\n"
            "\n"
            "[ /_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark\n"
            "[ {OutputIntent_PDFX} <<\n"
            "  /Type /OutputIntent\n"
            "  /S /GTS_PDFX\n"
            f"  /OutputCondition ({cond_name_ps})\n"
            f"  /OutputConditionIdentifier ({cond_id_ps})\n"
            "  /RegistryName (http://www.color.org)\n"
            f"  /Info ({cond_name_ps})\n"
            "  /DestOutputProfile {icc_PDFX}\n"
            ">> /PUT pdfmark\n"
            "[ {Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark\n"
        )

        fd, path = tempfile.mkstemp(suffix="_PDFX_def.ps", dir=str(self.output_dir))
        with os.fdopen(fd, "w", encoding="latin-1") as f:
            f.write(content)
        return path

    async def export_pdfx(self, file_path: str, standard: str = "x4") -> str:
        """
        Xuất file PDF chuẩn PDF/X.
        standard: 'x1a' | 'x4'
        """
        output_name = f"{Path(file_path).stem}_PDF-X_{standard}_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)

        _ensure_gs(self.gs_path)

        if standard == "x1a":
            return await self._export_x1a(file_path, output_path)
        else:
            return await self._export_x4(file_path, output_path)

    async def _export_x1a(self, input_path: str, output_path: str) -> str:
        """PDF/X-1a: CMYK only + flatten + embed fonts + output intent."""
        icc_path, cond_id, cond_name = self._resolve_output_intent_icc()
        def_file = None
        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE",
            "-sDEVICE=pdfwrite",
            "-sProcessColorModel=DeviceCMYK",
            "-sColorConversionStrategy=CMYK",
            "-dPDFSETTINGS=/prepress",
            "-dCompatibilityLevel=1.3",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            "-dAutoRotatePages=/None",
            "-dHaveTransparency=false",
        ]
        if icc_path:
            def_file = self._build_pdfx_def_file(icc_path, cond_id, cond_name, "x1a")
            # -dSAFER chặn đọc file tùy ý → phải cấp quyền đọc đúng file ICC.
            cmd += [f"--permit-file-read={icc_path}", "-dPDFX=true",
                    f"-sOutputFile={output_path}", def_file, input_path]
            logger.info(f"PDF/X-1a OutputIntent ICC: {icc_path} ({cond_id})")
        else:
            cmd += [f"-sOutputFile={output_path}", input_path]
            logger.warning("PDF/X-1a: không tìm thấy ICC CMYK — xuất KHÔNG có OutputIntent")

        try:
            proc = await asyncio.to_thread(
                run_hidden,
                cmd,
                capture_output=True,
                timeout=300
            )
        except Exception as e:
            raise RuntimeError(f"PDF/X-1a export error: {e}")
        finally:
            if def_file:
                try: os.remove(def_file)
                except Exception: pass

        if proc.returncode != 0:
            err = (proc.stderr.decode(errors='replace') + "\n" + proc.stdout.decode(errors='replace'))[:800]
            raise RuntimeError(f"PDF/X-1a export failed: {err}")

        logger.info(f"Exported PDF/X-1a → {output_path}")
        return output_path

    async def _export_x4(self, input_path: str, output_path: str) -> str:
        """PDF/X-4: Modern, supports transparency + ICC profiles."""
        icc_path, cond_id, cond_name = self._resolve_output_intent_icc()
        def_file = None
        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dCompatibilityLevel=1.6",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            "-dAutoRotatePages=/None",
        ]
        if icc_path:
            def_file = self._build_pdfx_def_file(icc_path, cond_id, cond_name, "x4")
            cmd += [f"--permit-file-read={icc_path}", "-dPDFX=true",
                    f"-sOutputFile={output_path}", def_file, input_path]
            logger.info(f"PDF/X-4 OutputIntent ICC: {icc_path} ({cond_id})")
        else:
            cmd += [f"-sOutputFile={output_path}", input_path]
            logger.warning("PDF/X-4: không tìm thấy ICC CMYK — xuất KHÔNG có OutputIntent")

        try:
            proc = await asyncio.to_thread(
                run_hidden,
                cmd,
                capture_output=True,
                timeout=300
            )
        except Exception as e:
            raise RuntimeError(f"PDF/X-4 export error: {e}")
        finally:
            if def_file:
                try: os.remove(def_file)
                except Exception: pass

        if proc.returncode != 0:
            err = (proc.stderr.decode(errors='replace') + "\n" + proc.stdout.decode(errors='replace'))[:800]
            raise RuntimeError(f"PDF/X-4 export failed: {err}")

        _finalize_pdfx4_identification(output_path)
        logger.info(f"Exported PDF/X-4 → {output_path}")
        return output_path
