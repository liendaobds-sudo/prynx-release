import re
import pikepdf

import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

class ColorRulesMixin:
    def _check_page_colorspaces(self, pdf: pikepdf.Pdf, active_rules: set) -> list[PreflightIssue]:
        issues = []
        if not hasattr(self, "_has_rgb"):
            self._has_rgb = False
            self._has_spot = False

        for page_num, page in enumerate(pdf.pages, 1):
            resources = page.get("/Resources", {})
            if not resources:
                continue
                
            cs_dict = resources.get("/ColorSpace", {})
            if not cs_dict:
                continue
                
            for name, cs_ref in cs_dict.items():
                try:
                    cs_obj = cs_ref if isinstance(cs_ref, (pikepdf.Array, pikepdf.Name, pikepdf.Stream)) else pdf.get_object(cs_ref)
                    cs_str = self._resolve_colorspace(cs_obj, pdf)
                    
                    if "DeviceRGB" in cs_str or "CalRGB" in cs_str:
                        self._has_rgb = True
                        if "COLOR_RGB_DETECTED" in active_rules:
                            issues.append(PreflightIssue(
                                rule_id="COLOR_RGB_DETECTED",
                                severity="warning",
                                page=page_num,
                                object_ref=f"ColorSpace {name}",
                                description=f"Phát hiện ColorSpace RGB ({name}) được nhúng trên trang.",
                                auto_fixable=True,
                            ))
                            
                    if "Separation" in cs_str or "DeviceN" in cs_str:
                        self._has_spot = True
                        if "COLOR_SPOT_DETECTED" in active_rules:
                            issues.append(PreflightIssue(
                                rule_id="COLOR_SPOT_DETECTED",
                                severity="info",
                                page=page_num,
                                object_ref=f"Spot Color {name}",
                                description=f"Trang chứa màu Spot/DeviceN ({name}). Kiểm tra xem nhà in có hỗ trợ không.",
                                auto_fixable=False,
                            ))
                except Exception as e:
                    logger.debug(f"ColorSpace check failed for {name}: {e}")
                    pass
        return issues

    def _check_content_stream_colors(self, doc, active_rules: set, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check content streams for RGB color operators. Works with pikepdf.Pdf."""
        issues = []
        if not hasattr(self, "_has_rgb"):
            self._has_rgb = False
            self._has_spot = False
            
        rgb_pattern = re.compile(rb'(?:^|[\s\r\n])[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+(rg|RG)(?:[\s\r\n]|$)')
        
        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            try:
                # Read content stream bytes from pikepdf
                contents = page.get("/Contents")
                if contents is None:
                    continue
                if isinstance(contents, pikepdf.Array):
                    stream = b""
                    for item in contents:
                        stream += item.read_bytes()
                else:
                    stream = contents.read_bytes()
                if not stream:
                    continue
                    
                if "COLOR_RGB_DETECTED" in active_rules:
                    if rgb_pattern.search(stream):
                        issues.append(PreflightIssue(
                            rule_id="COLOR_RGB_DETECTED",
                            severity="warning",
                            page=page_num + 1,
                            object_ref="Text/Vector",
                            description="Phát hiện Chữ hoặc Hình vẽ (Vector) sử dụng hệ màu RGB (DeviceRGB). Cần Convert CMYK.",
                            auto_fixable=True,
                        ))
                        self._has_rgb = True
            except Exception as e:
                logger.debug(f"Stream color parsing failed for page {page_num}: {e}")
                    
        return issues

    def _resolve_colorspace(self, cs, pdf: pikepdf.Pdf) -> str:
        """Resolve a ColorSpace entry to a readable string."""
        if isinstance(cs, pikepdf.Name):
            return str(cs)
        if isinstance(cs, pikepdf.Array):
            parts = []
            for item in cs:
                if isinstance(item, pikepdf.Name):
                    parts.append(str(item))
            return " ".join(parts)
        if isinstance(cs, pikepdf.Stream):
            return str(cs.get("/N", "Unknown"))
        return str(cs)
