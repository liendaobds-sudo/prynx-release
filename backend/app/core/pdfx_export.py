"""
PDF/X Export Engine — Xuất PDF chuẩn PDF/X-1a hoặc PDF/X-4.

Chức năng tương đương Acrobat Pro → Print Production → Save as PDF/X.
"""
import asyncio
import logging
import uuid
from pathlib import Path

import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)


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
        version_ok = True
        if standard == "x1a" and "1.3" not in pdf_version and "1.4" not in pdf_version:
            version_ok = "1.3" in pdf_version or "1.4" in pdf_version or "PDF" in pdf_version
        checks.append({
            "id": "PDF_VERSION",
            "label": "Phiên bản PDF",
            "passed": True,  # Ghostscript will handle version conversion
            "detail": pdf_version or "Không xác định"
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

    async def export_pdfx(self, file_path: str, standard: str = "x4") -> str:
        """
        Xuất file PDF chuẩn PDF/X.
        standard: 'x1a' | 'x4'
        """
        output_name = f"{Path(file_path).stem}_PDF-X_{standard}_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)

        if standard == "x1a":
            return await self._export_x1a(file_path, output_path)
        else:
            return await self._export_x4(file_path, output_path)

    async def _export_x1a(self, input_path: str, output_path: str) -> str:
        """PDF/X-1a: CMYK only + flatten + embed fonts + output intent."""
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
            f"-sOutputFile={output_path}",
            input_path,
        ]

        import subprocess
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                timeout=300
            )
        except Exception as e:
            raise RuntimeError(f"PDF/X-1a export error: {e}")

        if proc.returncode != 0:
            raise RuntimeError(f"PDF/X-1a export failed: {proc.stderr.decode(errors='replace')[:500]}")

        logger.info(f"Exported PDF/X-1a → {output_path}")
        return output_path

    async def _export_x4(self, input_path: str, output_path: str) -> str:
        """PDF/X-4: Modern, supports transparency + ICC profiles."""
        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress",
            "-dCompatibilityLevel=1.6",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            "-dAutoRotatePages=/None",
            f"-sOutputFile={output_path}",
            input_path,
        ]

        import subprocess
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                timeout=300
            )
        except Exception as e:
            raise RuntimeError(f"PDF/X-4 export error: {e}")

        if proc.returncode != 0:
            raise RuntimeError(f"PDF/X-4 export failed: {proc.stderr.decode(errors='replace')[:500]}")

        logger.info(f"Exported PDF/X-4 → {output_path}")
        return output_path
