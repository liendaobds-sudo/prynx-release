import pikepdf
import re
import math
import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

# Ngưỡng kích thước đặt tối thiểu mỗi chiều (point) — dưới mức này coi là suy biến
# và bỏ qua tính DPI để tránh giá trị vô lý (Yêu cầu 4.1).
MIN_PLACED_PT = 1.0


def _resolve_pdf_int(obj, key: str, default: int = 0) -> int:
    """Resolve indirect PDF references before casting to int."""
    val = obj.get(key, default)
    if val is None:
        return default
    if hasattr(val, "resolve") and callable(getattr(val, "resolve", None)):
        try:
            val = val.resolve()
        except Exception:
            return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _placed_size_from_matrix(matrix: list[float]) -> tuple[float, float]:
    """
    Tính (width_pt, height_pt) của ảnh đơn vị (1×1) sau biến đổi CTM.

    Ảnh PDF được vẽ trong không gian đơn vị [0,1]×[0,1]; cạnh ngang sau biến đổi là
    vector (a, b), cạnh dọc là vector (c, d). Độ dài hai vector cạnh cho kích thước
    đặt thật — đúng cả khi CTM chứa xoay (rotation) hoặc nghiêng (skew) (Yêu cầu 4.4):
        width_pt  = hypot(a, b)
        height_pt = hypot(c, d)
    """
    a, b, c, d = matrix[0], matrix[1], matrix[2], matrix[3]
    return (math.hypot(a, b), math.hypot(c, d))


def _placed_size_from_bbox(bbox: list[float]) -> tuple[float, float]:
    """Fallback khi không có matrix: dùng bề rộng/cao bbox trục (axis-aligned)."""
    return (abs(bbox[2] - bbox[0]), abs(bbox[3] - bbox[1]))


def compute_effective_dpi(
    pixel_w: int, pixel_h: int, placed_w_pt: float, placed_h_pt: float
) -> tuple[float, float, float] | None:
    """
    Tính DPI hiệu dụng theo kích thước đặt thật: DPI = pixel / (placed_pt / 72).

    Trả (dpi_x, dpi_y, effective_dpi=min(dpi_x, dpi_y)).
    Trả None cho ca suy biến: pixel < 1 mỗi chiều, hoặc kích thước đặt mỗi chiều
    nhỏ hơn MIN_PLACED_PT (Yêu cầu 1.1, 1.3, 4.1).
    """
    if pixel_w < 1 or pixel_h < 1:
        return None
    if placed_w_pt < MIN_PLACED_PT or placed_h_pt < MIN_PLACED_PT:
        return None
    dpi_x = pixel_w / (placed_w_pt / 72.0)
    dpi_y = pixel_h / (placed_h_pt / 72.0)
    return (dpi_x, dpi_y, min(dpi_x, dpi_y))


def _match_placements_to_images(placements: list[dict], images: list[dict]) -> list[dict]:
    """
    Ghép mỗi placement (từ list_image_placements) với một image XObject (pikepdf).

    Chiến lược ưu tiên giảm dần (Yêu cầu 2.1, 2.2):
      1) Theo xobject_name nếu placement.xobject_name khớp images[].name.
      2) Theo (pixel_w, pixel_h) khớp (width, height) pikepdf.
      3) Greedy theo thứ tự draw_index với các image còn lại.

    Trả list dict gộp: {"placement": <placement>, "image": <image|None>}.
    Placement không ghép được → image=None (vẫn giữ; có thể vẫn tính DPI nếu
    placement có pixel_w/pixel_h từ PDFium).
    """
    results: list[dict] = []
    remaining = list(images)

    def _take(pred):
        for idx, im in enumerate(remaining):
            if pred(im):
                return remaining.pop(idx)
        return None

    ordered = sorted(placements, key=lambda p: p.get("draw_index", 0))
    for pl in ordered:
        match = None
        name = pl.get("xobject_name")
        if name:
            match = _take(lambda im: im.get("name") == name)
        if match is None and pl.get("pixel_w") and pl.get("pixel_h"):
            pw, ph = pl["pixel_w"], pl["pixel_h"]
            match = _take(lambda im: im.get("width") == pw and im.get("height") == ph)
        if match is None and remaining:
            match = remaining.pop(0)
        results.append({"placement": pl, "image": match})
    return results


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
                    w = _resolve_pdf_int(obj, "/Width", 0)
                    h = _resolve_pdf_int(obj, "/Height", 0)
                    bpc = _resolve_pdf_int(obj, "/BitsPerComponent", 8)
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
        """Check image DPI (per placement, real CTM) + colorspace (per XObject).

        DPI dùng kích thước đặt thật từ placement (geometry_reader/PDFium) thay cho
        giả định "ảnh phủ kín trang". Kiểm màu/OPI vẫn theo từng image XObject như cũ.
        """
        from app.core import geometry_reader

        issues = []
        self._image_total = getattr(self, "_image_total", 0)
        self._image_low_res = getattr(self, "_image_low_res", 0)
        self._image_min_dpi = getattr(self, "_image_min_dpi", 9999)

        if not hasattr(self, "_has_rgb"):
            self._has_rgb = False
            self._has_spot = False

        pdf_path = getattr(doc, "_path", None)
        want_dpi = ("IMAGE_LOW_RES" in active_rules) or ("IMAGE_HIGH_DPI" in active_rules)
        want_opi = "IMAGE_NOT_EMBEDDED" in active_rules

        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]

            mb = page.get("/MediaBox")
            if not mb:
                continue  # trang thiếu MediaBox → bỏ qua (Yêu cầu 4.3)

            images = self._get_page_images(page)

            # ── Kiểm màu + OPI: theo từng image XObject (giữ nguyên hành vi) ──
            for img in images:
                cs_str = img["colorspace"]
                if want_opi and img["has_opi"]:
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_NOT_EMBEDDED",
                        severity="error",
                        page=page_num + 1,
                        object_ref=f"Image {img['name']}",
                        description="Ảnh này được lưu dưới dạng Link ảo (OPI), chưa được nhúng vào file. Chắc chắn rớt ảnh khi in.",
                        auto_fixable=False,
                        bbox=None,
                    ))
                if "RGB" in cs_str:
                    self._has_rgb = True
                    if "COLOR_RGB_DETECTED" in active_rules:
                        issues.append(PreflightIssue(
                            rule_id="COLOR_RGB_DETECTED",
                            severity="warning",
                            page=page_num + 1,
                            object_ref=f"Image {img['name']}",
                            description="Ảnh đang dùng hệ màu RGB. Cần chuyển sang CMYK trước khi in offset.",
                            auto_fixable=True,
                            bbox=None,
                        ))
                if "Separation" in cs_str or "DeviceN" in cs_str:
                    self._has_spot = True
                    if "COLOR_SPOT_DETECTED" in active_rules:
                        issues.append(PreflightIssue(
                            rule_id="COLOR_SPOT_DETECTED",
                            severity="info",
                            page=page_num + 1,
                            object_ref=f"Image {img['name']}",
                            description="Ảnh chứa màu Spot/DeviceN. Kiểm tra xem nhà in có hỗ trợ không.",
                            auto_fixable=False,
                            bbox=None,
                        ))

            # ── Kiểm DPI: theo từng placement thật ──
            if not (want_dpi and pdf_path):
                continue
            try:
                placements = geometry_reader.list_image_placements(pdf_path, page_num)
            except Exception as exc:  # noqa: BLE001
                logger.debug("list_image_placements lỗi trang %d: %s", page_num, exc)
                placements = []

            for m in _match_placements_to_images(placements, images):
                pl = m["placement"]
                im = m["image"]
                pixel_w = pl.get("pixel_w") or (im["width"] if im else 0) or 0
                pixel_h = pl.get("pixel_h") or (im["height"] if im else 0) or 0

                # Kích thước đặt thật: ưu tiên matrix (đúng cả xoay/nghiêng), fallback bbox.
                if pl.get("matrix"):
                    placed_w_pt, placed_h_pt = _placed_size_from_matrix(pl["matrix"])
                elif pl.get("bbox"):
                    placed_w_pt, placed_h_pt = _placed_size_from_bbox(pl["bbox"])
                else:
                    # Không có dữ liệu placement → guard: KHÔNG phát cảnh báo (Yêu cầu 4.2, 5.4)
                    continue

                res = compute_effective_dpi(pixel_w, pixel_h, placed_w_pt, placed_h_pt)
                if res is None:
                    continue  # placement suy biến (Yêu cầu 4.1)

                _dpi_x, _dpi_y, effective_dpi = res
                self._image_total += 1
                self._image_min_dpi = min(self._image_min_dpi, effective_dpi)
                bbox = pl.get("bbox")
                ref = f"Image {im['name']}" if im else f"Image @draw{pl.get('draw_index')}"

                if effective_dpi < self.MIN_IMAGE_DPI and "IMAGE_LOW_RES" in active_rules:
                    self._image_low_res += 1
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_LOW_RES",
                        severity="warning",
                        page=page_num + 1,
                        object_ref=ref,
                        description=(
                            f"Ảnh {pixel_w}×{pixel_h}px hiển thị ở ~{effective_dpi:.0f} DPI "
                            f"(tối thiểu {self.MIN_IMAGE_DPI} DPI cho in offset)."
                        ),
                        auto_fixable=False,
                        bbox=bbox,
                    ))

                if effective_dpi > self.MAX_IMAGE_DPI and "IMAGE_HIGH_DPI" in active_rules:
                    issues.append(PreflightIssue(
                        rule_id="IMAGE_HIGH_DPI",
                        severity="info",
                        page=page_num + 1,
                        object_ref=ref,
                        description=(
                            f"Ảnh {pixel_w}×{pixel_h}px hiển thị ở ~{effective_dpi:.0f} DPI "
                            f"(vượt ngưỡng {self.MAX_IMAGE_DPI} DPI). Gây tăng dung lượng, RIP chậm."
                        ),
                        auto_fixable=True,
                        bbox=bbox,
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
