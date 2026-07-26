"""
Ink Manager Engine — Quản lý kênh mực PDF (Process CMYK + Spot Colors).

Chức năng tương đương Acrobat Pro → Print Production → Ink Manager.
"""
import logging
import asyncio
import uuid
import re
from pathlib import Path

import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)


class InkManagerEngine:

    def __init__(self):
        self.gs_path = settings.GHOSTSCRIPT_PATH
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def list_inks(self, file_path: str) -> list[dict]:
        """
        Liệt kê toàn bộ kênh mực trong PDF.
        Returns: list of {name, type, cmyk_equivalent, density, pages}
        """
        doc = pikepdf.Pdf.open(file_path)
        
        # Process inks are always present
        inks = {
            "Cyan": {"name": "Cyan", "type": "process", "cmyk": [100, 0, 0, 0], "pages": []},
            "Magenta": {"name": "Magenta", "type": "process", "cmyk": [0, 100, 0, 0], "pages": []},
            "Yellow": {"name": "Yellow", "type": "process", "cmyk": [0, 0, 100, 0], "pages": []},
            "Black": {"name": "Black", "type": "process", "cmyk": [0, 0, 0, 100], "pages": []},
        }

        # Scan each page for Separation and DeviceN color spaces
        for page_idx in range(len(doc.pages)):
            page = doc.pages[page_idx]
            page_num = page_idx + 1

            # Mark all process inks as present on all pages
            for name in ["Cyan", "Magenta", "Yellow", "Black"]:
                inks[name]["pages"].append(page_num)

            # Look for Separation and DeviceN colorspaces in page resources
            try:
                page_obj = str(page.obj)
                
                # Find Separation color spaces: /Separation /SpotName ...
                sep_matches = re.findall(r'/Separation\s*/([^\s/\[\]]+)', page_obj)
                for spot_name in sep_matches:
                    # Decode PDF name encoding (#XX → char)
                    decoded = re.sub(r'#([0-9A-Fa-f]{2})', lambda m: chr(int(m.group(1), 16)), spot_name)
                    if decoded not in inks:
                        inks[decoded] = {
                            "name": decoded,
                            "type": "spot",
                            "cmyk": self._estimate_spot_cmyk(decoded),
                            "pages": [],
                        }
                    if page_num not in inks[decoded]["pages"]:
                        inks[decoded]["pages"].append(page_num)

                # Also scan all xrefs for spot colors (deeper scan)
                self._deep_scan_page(doc, page_obj, page_num, inks)

            except Exception as e:
                logger.warning(f"Error scanning page {page_num} for inks: {e}")

        doc.close()  # pikepdf close

        # Convert to list and compute density
        result = []
        for ink in inks.values():
            c, m, y, k = ink["cmyk"]
            # Neutral density approximation (ISO 5)
            density = round(0.3 * c + 0.59 * m + 0.11 * y + k, 1) / 100
            result.append({
                "name": ink["name"],
                "type": ink["type"],
                "cmyk": ink["cmyk"],
                "density": round(density, 3),
                "page_count": len(set(ink["pages"])),
            })

        return result

    def _deep_scan_page(self, doc, page_text: str, page_num: int, inks: dict):
        """Deep scan page resource tree for spot color definitions."""
        try:
            
            # Look for /ColorSpace dictionaries
            cs_refs = re.findall(r'/CS\d+\s+(\d+)\s+\d+\s+R', page_text)
            for ref in cs_refs:
                try:
                    obj_str = str(doc.get_object(int(ref)))
                    sep_names = re.findall(r'/Separation\s*/([^\s/\[\]]+)', obj_str)
                    for spot_name in sep_names:
                        decoded = re.sub(r'#([0-9A-Fa-f]{2})', lambda m: chr(int(m.group(1), 16)), spot_name)
                        if decoded not in inks and decoded not in ("All", "None"):
                            inks[decoded] = {
                                "name": decoded,
                                "type": "spot",
                                "cmyk": self._estimate_spot_cmyk(decoded),
                                "pages": [],
                            }
                        if decoded in inks and page_num not in inks[decoded]["pages"]:
                            inks[decoded]["pages"].append(page_num)
                except Exception:
                    pass
        except Exception:
            pass

    def _estimate_spot_cmyk(self, spot_name: str) -> list[int]:
        """Estimate CMYK equivalent for common Pantone names."""
        name = spot_name.upper()
        # Common Pantone approximations
        pantone_map = {
            "PANTONE 185 C": [0, 91, 76, 0],
            "PANTONE 286 C": [100, 75, 0, 0],
            "PANTONE 348 C": [100, 0, 78, 42],
            "PANTONE 021 C": [0, 53, 100, 0],
            "PANTONE WARM RED C": [0, 84, 78, 0],
            "PANTONE REFLEX BLUE C": [100, 82, 0, 2],
            "PANTONE PROCESS BLACK C": [0, 0, 0, 100],
        }
        for key, val in pantone_map.items():
            if key in name:
                return val
        # Default: dark gray
        return [0, 0, 0, 50]

    async def convert_spot_to_cmyk(self, file_path: str, spot_name: str | None = None) -> str:
        """
        Chuyển spot color → CMYK vĩnh viễn. Ưu tiên object-level, fallback GS.
        spot_name: None = convert ALL spots.

        Đường object-level thay đúng lệnh tô màu pha bằng CMYK tương đương lấy
        từ chính `tintTransform` của file (§8.6.6.4 — đúng cách spec định nghĩa
        màu pha render trên thiết bị không có kênh đó). Khác Ghostscript ở chỗ
        nó chỉ đụng vào **những spot được yêu cầu**: `spot_name` cụ thể thì các
        kênh còn lại vẫn sống, còn `pdfwrite -sColorConversionStrategy=CMYK`
        nuốt sạch mọi Separation cùng lúc — kể cả kênh bế mà người dùng đang
        muốn giữ.
        """
        if not Path(file_path).exists():
            raise RuntimeError(f"File PDF không tồn tại: {file_path}")

        output_name = f"{Path(file_path).stem}_cmyk_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)

        try:
            from app.core import icc_profiles, pdf_actions_native

            native = await asyncio.to_thread(
                pdf_actions_native.convert_spot_to_cmyk,
                file_path,
                output_path,
                spot_name,
                icc_profiles.resolve_cmyk_profile_path(),
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("convert_spot object-level lỗi, fallback GS: %s", e)
            native = None

        if native is not None and native.get("supported"):
            logger.info(
                "Converted spot→CMYK bằng pikepdf: %s (%d lệnh tô)",
                ", ".join(native.get("converted", [])) or "không có spot nào",
                native.get("ops", 0),
            )
            return output_path

        if native is not None:
            logger.info(
                "convert_spot: object-level không xử lý được (%s) → Ghostscript",
                "; ".join(native.get("blockers", [])),
            )

        if not self.gs_path or not Path(self.gs_path).exists():
            raise RuntimeError(f"Ghostscript không tìm thấy tại: {self.gs_path}")

        cmd = [
            self.gs_path,
            "-dSAFER", "-dBATCH", "-dNOPAUSE",
            "-sDEVICE=pdfwrite",
            "-sProcessColorModel=DeviceCMYK",
            "-sColorConversionStrategy=CMYK",
            "-dPDFSETTINGS=/prepress",
            "-dCompatibilityLevel=1.4",
            f"-sOutputFile={output_path}",
            file_path,
        ]

        logger.info(f"Running GS convert-spot: {' '.join(cmd)}")

        import subprocess
        from app.utils.subprocess_utils import run_hidden
        try:
            # Chạy subprocess trong thread để tránh lỗi asyncio event loop trên Windows uvicorn
            proc = await asyncio.to_thread(
                run_hidden,
                cmd,
                capture_output=True,
                timeout=300
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("Ghostscript timeout sau 300s.")
        except Exception as e:
            raise RuntimeError(f"Lỗi khi gọi Ghostscript: {e}")

        stderr_text = proc.stderr.decode(errors='replace').strip()
        if proc.returncode != 0:
            logger.error(f"GS convert spot failed (exit code {proc.returncode}):\n{stderr_text}")
            raise RuntimeError(
                f"Ghostscript thất bại (exit {proc.returncode}): "
                f"{stderr_text[:500]}"
            )

        # Verify output file exists and has content
        out = Path(output_path)
        if not out.exists() or out.stat().st_size < 100:
            raise RuntimeError(
                f"Ghostscript chạy xong nhưng file output trống hoặc không tồn tại. "
                f"GS stderr: {stderr_text[:300]}"
            )

        logger.info(f"Converted spots to CMYK → {output_path} ({out.stat().st_size} bytes)")
        return output_path
