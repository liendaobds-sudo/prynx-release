import pikepdf
import re
import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

class ImageRulesMixin:
    MIN_IMAGE_DPI = 200
    MAX_IMAGE_DPI = 600

    def _check_illustrator_hidden_links(self, doc) -> list[PreflightIssue]:
        """Check XMP metadata for Illustrator hidden links."""
        issues = []
        try:
            meta = doc.Root.get("/Metadata")
            if meta:
                xmp = meta.read_bytes().decode("utf-8", errors="ignore")
                if "action=\"linked\"" in xmp or "linkForm=\"Reference\"" in xmp or "<stEvt:action>linked</stEvt:action>" in xmp or "EmbedByReference" in xmp:
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_NOT_EMBEDDED",
                        severity="warning",
                        page=1,
                        object_ref="XMP Metadata",
                        description="Phát hiện file có cấu trúc đang ngậm Link ảo (chưa Embed ảnh thật). Nếu mở lên bằng phần mềm thiết kế sẽ bị rớt ảnh lập tức.",
                        auto_fixable=False,
                        bbox=None
                    ))
        except Exception:
            pass
        return issues

    def _get_page_images(self, page):
        """Extract image info from page Resources/XObject using pikepdf."""
        images = []
        try:
            resources = page.get("/Resources")
            if not resources:
                return images
            xobjects = resources.get("/XObject")
            if not xobjects:
                return images
            for name, ref in xobjects.items():
                try:
                    obj = ref
                    if hasattr(ref, 'resolve'):
                        obj = ref.resolve() if callable(getattr(ref, 'resolve', None)) else ref
                    subtype = str(obj.get("/Subtype", ""))
                    if subtype != "/Image":
                        continue
                    w = int(obj.get("/Width", 0))
                    h = int(obj.get("/Height", 0))
                    bpc = int(obj.get("/BitsPerComponent", 8))
                    cs = str(obj.get("/ColorSpace", ""))
                    
                    # Check for /OPI key
                    has_opi = "/OPI" in str(obj)
                    
                    # Check for /Indexed (GIF-like)
                    is_indexed = "/Indexed" in cs or "/Indexed" in str(obj.get("/ColorSpace", ""))
                    
                    images.append({
                        "name": str(name),
                        "obj": obj,
                        "width": w,
                        "height": h,
                        "bpc": bpc,
                        "colorspace": cs,
                        "has_opi": has_opi,
                        "is_indexed": is_indexed,
                    })
                except Exception:
                    pass
        except Exception:
            pass
        return images

    def _check_image_resolution(self, doc, active_rules: set, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check if any images have resolution below MIN_IMAGE_DPI and detect colorspace."""
        issues = []
        self._image_total = getattr(self, "_image_total", 0)
        self._image_low_res = getattr(self, "_image_low_res", 0)
        self._image_min_dpi = getattr(self, "_image_min_dpi", 9999)
        
        if not hasattr(self, "_has_rgb"):
            self._has_rgb = False
            self._has_spot = False

        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            
            # Get page dimensions for DPI estimation
            mb = page.get("/MediaBox")
            if not mb:
                continue
            page_w_pt = float(mb[2]) - float(mb[0])
            page_h_pt = float(mb[3]) - float(mb[1])
            
            images = self._get_page_images(page)

            for img in images:
                self._image_total += 1
                pixel_w = img["width"]
                pixel_h = img["height"]
                cs_str = img["colorspace"]
                
                if img["has_opi"] and "IMAGE_NOT_EMBEDDED" in active_rules:
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_NOT_EMBEDDED",
                        severity="error",
                        page=page_num + 1,
                        object_ref=f"Image {img['name']}",
                        description=f"Ảnh này được lưu dưới dạng Link ảo (OPI), chưa được nhúng vào file. Chắc chắn rớt ảnh khi in.",
                        auto_fixable=False,
                        bbox=None
                    ))

                if pixel_w < 1 or pixel_h < 1 or page_w_pt < 1 or page_h_pt < 1:
                    continue

                # Estimate DPI: assume image fills the entire page (rough estimate)
                # Without content stream matrix analysis, this is the best we can do
                dpi_x = pixel_w / (page_w_pt / 72.0)
                dpi_y = pixel_h / (page_h_pt / 72.0)
                effective_dpi = min(dpi_x, dpi_y)

                self._image_min_dpi = min(self._image_min_dpi, effective_dpi)

                if effective_dpi < self.MIN_IMAGE_DPI and "IMAGE_LOW_RES" in active_rules:
                    self._image_low_res += 1
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_LOW_RES",
                        severity="warning",
                        page=page_num + 1,
                        object_ref=f"Image {img['name']}",
                        description=(
                            f"Ảnh {pixel_w}×{pixel_h}px hiển thị ở ~{effective_dpi:.0f} DPI "
                            f"(tối thiểu {self.MIN_IMAGE_DPI} DPI cho in offset)."
                        ),
                        auto_fixable=False,
                        bbox=None
                    ))
                    
                if effective_dpi > self.MAX_IMAGE_DPI and "IMAGE_HIGH_DPI" in active_rules:
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_HIGH_DPI",
                        severity="info",
                        page=page_num + 1,
                        object_ref=f"Image {img['name']}",
                        description=(
                            f"Ảnh {pixel_w}×{pixel_h}px hiển thị ở ~{effective_dpi:.0f} DPI "
                            f"(vượt ngưỡng {self.MAX_IMAGE_DPI} DPI). Gây tăng dung lượng, RIP chậm."
                        ),
                        auto_fixable=True,
                        bbox=None
                    ))

                # Color check
                if "RGB" in cs_str:
                    self._has_rgb = True
                    if "COLOR_RGB_DETECTED" in active_rules:
                        issues.append(PreflightIssue(
                            rule_id="COLOR_RGB_DETECTED",
                            severity="warning",
                            page=page_num + 1,
                            object_ref=f"Image {img['name']}",
                            description=f"Ảnh đang dùng hệ màu RGB. Cần chuyển sang CMYK trước khi in offset.",
                            auto_fixable=True,
                            bbox=None
                        ))
                        
                if "Separation" in cs_str or "DeviceN" in cs_str:
                    self._has_spot = True
                    if "COLOR_SPOT_DETECTED" in active_rules:
                        issues.append(PreflightIssue(
                            rule_id="COLOR_SPOT_DETECTED",
                            severity="info",
                            page=page_num + 1,
                            object_ref=f"Image {img['name']}",
                            description=f"Ảnh chứa màu Spot/DeviceN. Kiểm tra xem nhà in có hỗ trợ không.",
                            auto_fixable=False,
                            bbox=None
                        ))

        if self._image_min_dpi == 9999:
            self._image_min_dpi = 0

        return issues

    def _check_gif_in_pdf(self, doc, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check for GIF images embedded in the PDF (lossy, limited palette — bad for print)."""
        issues = []
        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            images = self._get_page_images(page)
            for img in images:
                if img["is_indexed"] and img["bpc"] <= 8:
                    issues.append(PreflightIssue(
                        rule_id="GIF_IN_PDF",
                        severity="warning",
                        page=page_num + 1,
                        object_ref=f"Image {img['name']}",
                        description="Phát hiện ảnh Indexed (dạng GIF/palette). Ảnh chỉ có tối đa 256 màu, chất lượng in kém. Nên thay bằng TIFF/JPEG.",
                        auto_fixable=False,
                        bbox=None,
                    ))
        return issues

    def _check_progressive_jpeg(self, doc, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check for progressive JPEG encoding — some RIPs cannot handle this."""
        issues = []
        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            images = self._get_page_images(page)
            for img in images:
                try:
                    obj = img["obj"]
                    # Read raw stream bytes
                    img_bytes = obj.read_raw_bytes()
                    if not img_bytes or len(img_bytes) < 4:
                        continue
                    # JPEG SOI marker
                    if img_bytes[:2] != b'\xff\xd8':
                        continue
                    # Scan for SOF2 marker (0xFFC2 = progressive DCT)
                    pos = 2
                    is_progressive = False
                    while pos < len(img_bytes) - 1:
                        if img_bytes[pos] != 0xFF:
                            pos += 1
                            continue
                        marker = img_bytes[pos + 1]
                        if marker == 0xC2:  # SOF2 = Progressive DCT
                            is_progressive = True
                            break
                        if marker in (0xC0, 0xC1):  # Baseline/Extended sequential
                            break
                        if marker == 0xD9:  # EOI
                            break
                        # Skip to next marker
                        if pos + 3 < len(img_bytes):
                            length = (img_bytes[pos + 2] << 8) | img_bytes[pos + 3]
                            pos += 2 + length
                        else:
                            break
                    if is_progressive:
                        issues.append(PreflightIssue(
                            rule_id="PROGRESSIVE_JPEG",
                            severity="warning",
                            page=page_num + 1,
                            object_ref=f"Image {img['name']}",
                            description="Ảnh JPEG sử dụng Progressive encoding. Một số hệ thống RIP cũ không xử lý được, gây lỗi in. Nên chuyển sang Baseline JPEG.",
                            auto_fixable=False,
                            bbox=None,
                        ))
                except Exception:
                    pass
        return issues
