import re
import pikepdf

import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

class ColorRulesMixin:
    def _check_page_colorspaces(self, pdf: pikepdf.Pdf, active_rules: set, page_nums: list[int] = None) -> list[PreflightIssue]:
        issues = []
        if not hasattr(self, "_has_rgb"):
            self._has_rgb = False
            self._has_spot = False
        if not hasattr(self, "_has_cmyk"):
            self._has_cmyk = False

        page_count = len(pdf.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_idx in target_pages:
            page = pdf.pages[page_idx]
            page_num = page_idx + 1
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

                    if "DeviceCMYK" in cs_str:
                        self._has_cmyk = True

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
        """Quét content stream tìm màu RGB. Works with pikepdf.Pdf.

        Bắt ba dạng:
          - Toán tử trực tiếp ``r g b rg/RG`` (DeviceRGB inline).
          - ``/Name cs``/``CS`` + ``scn/SCN`` trỏ tới ColorSpace RGB/CalRGB khai báo
            trong ``/Resources/ColorSpace`` (dạng named colorspace — code cũ bỏ sót).
          - Content stream của Form XObject lồng (đệ quy qua resource walker), không
            chỉ ``page/Contents``.
        """
        from app.core.preflight_rules.resource_walker import iter_resource_dicts

        issues = []
        if not hasattr(self, "_has_rgb"):
            self._has_rgb = False
            self._has_spot = False

        if "COLOR_RGB_DETECTED" not in active_rules:
            return issues

        rgb_pattern = re.compile(rb'(?:^|[\s\r\n])[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+(rg|RG)(?:[\s\r\n]|$)')
        # Tên colorspace được set qua "/CS0 cs" / "/CS0 CS".
        cs_set_pattern = re.compile(rb'/([^\s/<>\[\]]+)\s+(?:cs|CS)(?:[\s\r\n]|$)')

        def _resolve(o):
            try:
                if hasattr(o, "resolve") and callable(getattr(o, "resolve", None)):
                    return o.resolve()
            except Exception:
                pass
            return o

        def _rgb_named_colorspaces(page) -> set[bytes]:
            """Tên colorspace (bytes) là RGB/CalRGB khai báo ở mọi resource của trang."""
            names: set[bytes] = set()
            try:
                for res in iter_resource_dicts(page, doc):
                    cs_dict = _resolve(res.get("/ColorSpace"))
                    if not isinstance(cs_dict, pikepdf.Dictionary):
                        continue
                    for nm, cs_ref in cs_dict.items():
                        try:
                            cs_str = self._resolve_colorspace(_resolve(cs_ref), doc)
                        except Exception:
                            continue
                        if "DeviceRGB" in cs_str or "CalRGB" in cs_str:
                            names.add(str(nm).lstrip("/").encode("latin-1", "ignore"))
            except Exception:
                pass
            return names

        def _iter_content_streams(page):
            """Content stream của trang + của mọi Form XObject lồng (bytes)."""
            seen = set()
            contents = page.get("/Contents")
            if contents is not None:
                try:
                    if isinstance(contents, pikepdf.Array):
                        for item in contents:
                            yield item.read_bytes()
                    else:
                        yield contents.read_bytes()
                except Exception:
                    pass
            # Form XObject streams (chính là stream chứa lệnh vẽ).
            try:
                for res in iter_resource_dicts(page, doc):
                    xobjs = _resolve(res.get("/XObject"))
                    if not isinstance(xobjs, pikepdf.Dictionary):
                        continue
                    for _n, xref in xobjs.items():
                        xo = _resolve(xref)
                        if not isinstance(xo, pikepdf.Stream):
                            continue
                        if str(xo.get("/Subtype", "")) != "/Form":
                            continue
                        key = getattr(xo, "objgen", None)
                        if key and key in seen:
                            continue
                        if key:
                            seen.add(key)
                        try:
                            yield xo.read_bytes()
                        except Exception:
                            pass
            except Exception:
                pass

        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            try:
                rgb_names = _rgb_named_colorspaces(page)
                detected = False
                for stream in _iter_content_streams(page):
                    if not stream:
                        continue
                    if rgb_pattern.search(stream):
                        detected = True
                        break
                    if rgb_names:
                        for m in cs_set_pattern.finditer(stream):
                            if m.group(1) in rgb_names:
                                detected = True
                                break
                    if detected:
                        break
                if detected:
                    issues.append(PreflightIssue(
                        rule_id="COLOR_RGB_DETECTED",
                        severity="warning",
                        page=page_num + 1,
                        object_ref="Text/Vector",
                        description="Phát hiện Chữ hoặc Hình vẽ (Vector) sử dụng hệ màu RGB (DeviceRGB/CalRGB). Cần Convert CMYK.",
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
