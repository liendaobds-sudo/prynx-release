"""
pdf_ops — Direct pikepdf operations for PDF manipulation.

Replaces pdf_wrapper's Document, Page, Shape classes.
All operations use pikepdf directly without an intermediate compatibility layer.
"""
import itertools
import pikepdf
import math
import logging
from app.workers.pdf_types import Point, Rect

logger = logging.getLogger(__name__)

# Bộ đếm UID toàn cục cho XObject cache của show_pdf_page. KHÔNG dùng id() của
# đối tượng nguồn làm khóa cache: id() được tái dùng sau khi object bị GC, nên các
# overlay khác nhau (mỗi record VDP tạo một overlay riêng rồi bị thu hồi) có thể
# trùng id() → cache trả nhầm XObject của record cũ (lẫn nội dung giữa các trang).
# Thay vào đó gắn một UID đơn điệu, KHÔNG tái dùng lên CHÍNH đối tượng nguồn.
_PDF_UID_COUNTER = itertools.count(1)


def _stable_pdf_uid(src_pdf: pikepdf.Pdf) -> int:
    """Trả UID ổn định, duy nhất cho từng đối tượng ``src_pdf``.

    UID được lưu ngay trên đối tượng (``_pdfops_uid``) nên một đối tượng mới — kể
    cả khi tái dùng địa chỉ bộ nhớ (id) của đối tượng đã bị GC — sẽ KHÔNG có sẵn
    thuộc tính này và được cấp UID mới, loại bỏ va chạm khóa cache. Với N-up (cùng
    một ``src_pdf`` đặt nhiều lần) UID giữ nguyên nên việc nhúng-một-lần vẫn đúng.
    """
    uid = getattr(src_pdf, "_pdfops_uid", None)
    if uid is None:
        uid = next(_PDF_UID_COUNTER)
        try:
            src_pdf._pdfops_uid = uid
        except Exception:
            # Không gắn được thuộc tính → fallback id() (hành vi cũ).
            uid = id(src_pdf)
    return uid


# =========================================================================
# Shape Builder — constructs PDF content streams for vector drawings
# =========================================================================

class ShapeBuilder:
    """Builds PDF content stream operators for drawing lines, rects, circles, text."""

    def __init__(self, page_height: float, pdf: pikepdf.Pdf, pike_page: pikepdf.Page):
        self.page_height = page_height
        self.pdf = pdf
        self.pike_page = pike_page
        self.stream = []          # path ops đang chờ (kể từ finish() gần nhất)
        self._committed = []      # các nhóm đã hoàn tất — CHỈ append (tránh O(N²))

    def draw_line(self, p1: Point, p2: Point):
        self.stream.append(f"{p1.x:.4f} {self.page_height - p1.y:.4f} m")
        self.stream.append(f"{p2.x:.4f} {self.page_height - p2.y:.4f} l")

    def draw_polyline(self, points):
        """Vẽ 1 subpath LIỀN qua nhiều điểm: moveto điểm đầu, lineto các điểm sau.
        Khác với gọi draw_line nhiều lần (mỗi lần phát 'm' mới → cắt thành các
        subpath rời, không có line-join tại đỉnh gấp khúc như góc L)."""
        if not points or len(points) < 2:
            return
        p0 = points[0]
        self.stream.append(f"{p0.x:.4f} {self.page_height - p0.y:.4f} m")
        for p in points[1:]:
            self.stream.append(f"{p.x:.4f} {self.page_height - p.y:.4f} l")

    def draw_circle(self, center: Point, radius: float):
        cx, cy_top = center.x, self.page_height - center.y
        k = 0.5522847498
        r = radius
        self.stream.append(f"{cx:.4f} {cy_top + r:.4f} m")
        self.stream.append(f"{cx + k*r:.4f} {cy_top + r:.4f} {cx + r:.4f} {cy_top + k*r:.4f} {cx + r:.4f} {cy_top:.4f} c")
        self.stream.append(f"{cx + r:.4f} {cy_top - k*r:.4f} {cx + k*r:.4f} {cy_top - r:.4f} {cx:.4f} {cy_top - r:.4f} c")
        self.stream.append(f"{cx - k*r:.4f} {cy_top - r:.4f} {cx - r:.4f} {cy_top - k*r:.4f} {cx - r:.4f} {cy_top:.4f} c")
        self.stream.append(f"{cx - r:.4f} {cy_top + k*r:.4f} {cx - k*r:.4f} {cy_top + r:.4f} {cx:.4f} {cy_top + r:.4f} c")

    def draw_rect(self, rect: Rect):
        self.stream.append(f"{rect.x0:.4f} {self.page_height - rect.y1:.4f} {rect.width:.4f} {rect.height:.4f} re")

    def draw_bezier(self, p1: Point, c1: Point, c2: Point, p2: Point):
        self.stream.append(f"{p1.x:.4f} {self.page_height - p1.y:.4f} m")
        self.stream.append(
            f"{c1.x:.4f} {self.page_height - c1.y:.4f} "
            f"{c2.x:.4f} {self.page_height - c2.y:.4f} "
            f"{p2.x:.4f} {self.page_height - p2.y:.4f} c"
        )

    def insert_text(self, point: Point, text: str, fontsize=11, fontname="helv",
                    color=(0, 0, 0, 1), oc=None):
        if not text or fontsize <= 0:
            return
        pdf_fontname = "Helvetica"
        if fontname and "helv" in fontname.lower():
            pdf_fontname = "Helvetica"
        elif fontname and "cour" in fontname.lower():
            pdf_fontname = "Courier"
        elif fontname and "time" in fontname.lower():
            pdf_fontname = "Times-Roman"

        font_key = self._ensure_font(pdf_fontname)
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        x = point.x
        y = self.page_height - point.y
        # Hỗ trợ đủ hệ màu theo độ dài tuple: 4 = CMYK (k), 1 = Gray (g), còn lại = RGB (rg).
        # Trước đây cắt cụt về RGB → mất kênh K nếu caller truyền CMYK (lỗi hệ màu khi in).
        col = tuple(color) if color else (0, 0, 0)
        if len(col) == 4:
            color_op = f"{col[0]} {col[1]} {col[2]} {col[3]} k"
        elif len(col) == 1:
            color_op = f"{col[0]} g"
        else:
            color_op = f"{col[0]} {col[1]} {col[2]} rg"
        self.stream.append("BT")
        self.stream.append(color_op)
        self.stream.append(f"/{font_key} {fontsize:.2f} Tf")
        self.stream.append(f"{x:.4f} {y:.4f} Td")
        self.stream.append(f"({escaped}) Tj")
        self.stream.append("ET")

    def _ensure_font(self, pdf_fontname: str) -> str:
        resources = self.pike_page.get("/Resources")
        if resources is None:
            self.pike_page["/Resources"] = pikepdf.Dictionary()
            resources = self.pike_page["/Resources"]

        fonts = resources.get("/Font")
        if fonts is None:
            resources["/Font"] = pikepdf.Dictionary()
            fonts = resources["/Font"]

        for key, val in fonts.items():
            if isinstance(val, pikepdf.Dictionary):
                bn = str(val.get("/BaseFont", ""))
                if pdf_fontname in bn:
                    return str(key).lstrip("/")

        idx = len(fonts)
        font_key = f"F{idx}"
        fonts[pikepdf.Name(f"/{font_key}")] = pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Font"),
            "/Subtype": pikepdf.Name("/Type1"),
            "/BaseFont": pikepdf.Name(f"/{pdf_fontname}"),
        })
        return font_key

    def finish(self, color=(0, 0, 0, 1), width=1, closePath=False, fill=None, dashes=None, oc=None, item_name=None, line_join=None):
        # Phòng thủ: caller có thể truyền color=None (vd path chỉ-tô). Tránh len(None).
        if color is None:
            color = (0, 0, 0, 1)
        preamble = []
        # line_join: 0=miter, 1=round, 2=bevel — cho đỉnh gấp khúc (vd góc L của ốc)
        # nối liền, không hở/vát. Bỏ qua khi None (giữ mặc định PDF = miter).
        if line_join is not None:
            preamble.append(f"{int(line_join)} j")
        if fill:
            if len(fill) == 4:
                preamble.append(f"{fill[0]} {fill[1]} {fill[2]} {fill[3]} k")
            else:
                preamble.append(f"{fill[0]} {fill[1]} {fill[2]} rg")
        if len(color) == 4:
            preamble.append(f"{color[0]} {color[1]} {color[2]} {color[3]} K")
        else:
            preamble.append(f"{color[0]} {color[1]} {color[2]} RG")
        preamble.append(f"{width} w")

        if dashes:
            preamble.append(f"[{' '.join(map(str, dashes))}] 0 d")
        else:
            preamble.append("[] 0 d")

        new_part = self.stream  # toàn bộ path ops vẽ kể từ finish() trước

        draw_op = "s" if not fill else "b"
        if not closePath:
            draw_op = "S" if not fill else "f"

        wrapped = preamble + new_part + [draw_op]

        if item_name:
            wrapped = [f"/Span /NM_{item_name} BDC"] + wrapped + ["EMC"]

        if oc is not None:
            oc_name = self._register_ocg(oc)
            wrapped = [f"/OC /{oc_name} BDC"] + wrapped + ["EMC"]

        # Append-only: gộp nhóm vừa hoàn tất vào _committed (O(k)). Trước đây làm
        # `self.stream = old_part + wrapped` → nối lại TOÀN BỘ list tích lũy mỗi
        # finish() → O(N²) khi vẽ nhiều tem/đường bế. Thứ tự ops giữ nguyên y hệt.
        self._committed.extend(wrapped)
        self.stream = []

    def _register_ocg(self, ocg_ref) -> str:
        """Register OCG reference in page /Properties and return the property name."""
        resources = self.pike_page.get("/Resources")
        if resources is None:
            self.pike_page["/Resources"] = pikepdf.Dictionary()
            resources = self.pike_page["/Resources"]

        props = resources.get("/Properties")
        if props is None:
            resources["/Properties"] = pikepdf.Dictionary()
            props = resources["/Properties"]

        # Check if already registered
        for key, val in props.items():
            try:
                if hasattr(val, 'objgen') and hasattr(ocg_ref, 'objgen'):
                    if val.objgen == ocg_ref.objgen:
                        return str(key).lstrip("/")
            except Exception:
                pass

        # Create new property name
        idx = len(props)
        oc_name = f"MC{idx}"
        props[pikepdf.Name(f"/{oc_name}")] = ocg_ref
        return oc_name

    def commit(self):
        content = ("\n".join(self._committed + self.stream) + "\n").encode('latin-1', errors='replace')
        self.pike_page.contents_add(pikepdf.Stream(self.pdf, content))
        self._committed = []
        self.stream = []


# =========================================================================
# Page helpers — utility functions that operate on pikepdf.Page
# =========================================================================

def page_rect(pike_page: pikepdf.Page) -> Rect:
    """Get page dimensions as a Rect(0, 0, width, height)."""
    mb = pike_page.mediabox
    return Rect(0, 0, float(mb[2] - mb[0]), float(mb[3] - mb[1]))


def page_width(pike_page: pikepdf.Page) -> float:
    mb = pike_page.mediabox
    return float(mb[2] - mb[0])


def page_height(pike_page: pikepdf.Page) -> float:
    mb = pike_page.mediabox
    return float(mb[3] - mb[1])


def get_box(pike_page: pikepdf.Page, box_name: str) -> Rect:
    """Get a named box (/TrimBox, /CropBox, etc.) with fallback cascade."""
    if box_name in pike_page:
        b = pike_page[box_name]
    elif "/CropBox" in pike_page:
        b = pike_page.CropBox
    else:
        b = pike_page.MediaBox
    return Rect(float(b[0]), float(b[1]), float(b[2]), float(b[3]))


def new_shape(pdf: pikepdf.Pdf, pike_page: pikepdf.Page) -> ShapeBuilder:
    """Create a ShapeBuilder for the given page."""
    return ShapeBuilder(page_height(pike_page), pdf, pike_page)


def show_pdf_page(pdf: pikepdf.Pdf, dest_page: pikepdf.Page,
                  rect: Rect, src_pdf: pikepdf.Pdf, page_idx: int,
                  rotate: int = 0, clip: Rect = None, keep_proportion: bool = False,
                  out_clip: Rect = None, mirror_x: bool = False, mirror_y: bool = False):
    """
    Place a source PDF page onto dest_page at the specified rect.
    Equivalent to pdf_wrapper's Page.show_pdf_page().

    out_clip: nếu có, đây là rectangle (toạ độ output, y-down giống `rect`) dùng làm
    đường CLIP trên trang đích — tách biệt với `rect` (vùng đặt/scale). Dùng để clip
    bleed ở mép trong giữa 2 tem (mỗi bên nửa gap), tránh bleed chồng nhau.

    mirror_x / mirror_y: PHẢN CHIẾU (lật gương) nội dung quanh TÂM của `rect`
    (mirror_x = lật ngang, mirror_y = lật dọc). Dùng cho Mặt sau bình bế 2 mặt:
    mặt sau die-cut phải là ẢNH PHẢN CHIẾU của mặt trước (không phải xoay), để khi
    in duplex (lật giấy) artwork mặt sau trùng khít footprint mặt trước.
    """
    dest_h = page_height(dest_page)
    src_pike = src_pdf.pages[page_idx]

    # ── Embed-once XObject cache (HIỆU NĂNG) ──────────────────────────────
    # Trước đây MỖI placement gọi as_form_xobject()+add_resource → copy TOÀN BỘ
    # nội dung trang nguồn vào output MỘT LẦN/BẢN TEM. Với N bản (nhất là nhiều
    # loại tem) output phình ~N lần và save() nghẹt. Mọi phép xoay/lật/scale/clip
    # đều nằm ở content stream từng tem nên XObject DÙNG CHUNG được → nhúng 1 lần
    # mỗi mẫu, tham chiếu rẻ N lần. Cache đặt trên pdf đích, khóa (id(src_pdf), page_idx);
    # tên resource cố định ⇒ add_resource idempotent (không nhân đôi entry).
    _cache = getattr(pdf, "_nup_xobj_cache", None)
    if _cache is None:
        _cache = {}
        try:
            pdf._nup_xobj_cache = _cache
        except Exception:
            _cache = None  # không gắn được cache → fallback hành vi cũ
    # Khóa cache theo UID ổn định (KHÔNG dùng id() — xem _stable_pdf_uid) để tránh
    # va chạm khi id() bị tái dùng sau GC giữa các overlay record của VDP.
    _key = (_stable_pdf_uid(src_pdf), page_idx)
    _cached = _cache.get(_key) if _cache is not None else None
    if _cached is not None:
        xobj, _res_name = _cached
    else:
        xobj = src_pike.as_form_xobject()
        # FIX: as_form_xobject() đặt /BBox = TrimBox → clip mất phần BLEED (ngoài trim).
        # Ép BBox = MediaBox (full page) để bleed của file được render đầy đủ.
        try:
            _mb = src_pike.mediabox
            xobj.BBox = pikepdf.Array([_mb[0], _mb[1], _mb[2], _mb[3]])
        except Exception:
            pass
        if _cache is not None:
            # Đưa XObject vào output MỘT LẦN (phần nặng = copy_foreign object graph).
            if src_pdf is not pdf:
                xobj = pdf.copy_foreign(xobj)
            _res_name = pikepdf.Name(f"/NupXo{_key[0]}_{page_idx}")
            _cache[_key] = (xobj, _res_name)
        else:
            _res_name = None

    if _res_name is not None:
        xobj_name = dest_page.add_resource(xobj, pikepdf.Name.XObject, name=_res_name)
    else:
        xobj_name = dest_page.add_resource(xobj, pikepdf.Name.XObject)

    src_w_full = float(src_pike.mediabox[2] - src_pike.mediabox[0])
    src_h_full = float(src_pike.mediabox[3] - src_pike.mediabox[1])

    dest_x = rect.x0
    dest_y = dest_h - rect.y1
    dest_w = rect.width
    dest_h_rect = rect.height

    # Đường clip trên trang đích: ưu tiên out_clip (clip mép trong), nếu không thì
    # dùng chính vùng đặt `rect` (hành vi cũ).
    def _clip_re(r: Rect) -> str:
        cx0 = r.x0
        cy0 = dest_h - r.y1
        return f"{cx0:.4f} {cy0:.4f} {r.width:.4f} {r.height:.4f} re W n\n"

    if clip:
        clip_w = clip.width
        clip_h = clip.height
        if out_clip is not None:
            clip_prefix = _clip_re(out_clip)
        else:
            clip_prefix = f"{dest_x:.4f} {dest_y:.4f} {dest_w:.4f} {dest_h_rect:.4f} re W n\n"
    else:
        clip_w = src_w_full
        clip_h = src_h_full
        clip = Rect(0, 0, src_w_full, src_h_full)
        clip_prefix = _clip_re(out_clip) if out_clip is not None else ""

    if rotate % 180 != 0:
        scale_x = dest_w / clip_h if clip_h else 1
        scale_y = dest_h_rect / clip_w if clip_w else 1
    else:
        scale_x = dest_w / clip_w if clip_w else 1
        scale_y = dest_h_rect / clip_h if clip_h else 1

    if keep_proportion:
        scale_x = scale_y = min(scale_x, scale_y)

    cx = dest_x + dest_w / 2
    cy = dest_y + dest_h_rect / 2
    cx_src = clip.x0 + clip_w / 2
    cy_src = (src_h_full - clip.y1) + clip_h / 2
    e = cx - cx_src * scale_x
    f = cy - cy_src * scale_y

    xobj_name_str = str(xobj_name)
    if not xobj_name_str.startswith("/"):
        xobj_name_str = "/" + xobj_name_str

    # Phản chiếu (mirror) TOÀN TỜ quanh TÂM TRANG ĐÍCH (không phải tâm rect): mặt
    # sau bình bế 2 mặt = ảnh phản chiếu của mặt trước quanh tâm tờ → vị trí + nội
    # dung đều lật đúng, KHÔNG phụ thuộc đường bế lệch tâm trong trang nguồn.
    if mirror_x or mirror_y:
        pivot_x = page_width(dest_page) / 2.0
        pivot_y = dest_h / 2.0
        mx = -1.0 if mirror_x else 1.0
        my = -1.0 if mirror_y else 1.0
        mirror_prefix = (
            f"1 0 0 1 {pivot_x:.4f} {pivot_y:.4f} cm\n"
            f"{mx:.1f} 0 0 {my:.1f} 0 0 cm\n"
            f"1 0 0 1 {-pivot_x:.4f} {-pivot_y:.4f} cm\n"
        )
    else:
        mirror_prefix = ""

    if rotate != 0:
        rad = math.radians(rotate)
        cos_a = math.cos(rad)
        sin_a = math.sin(rad)
        stream_str = (
            f"q\n{mirror_prefix}{clip_prefix}"
            f"1 0 0 1 {cx:.4f} {cy:.4f} cm\n"
            f"{cos_a:.6f} {sin_a:.6f} {-sin_a:.6f} {cos_a:.6f} 0 0 cm\n"
            f"1 0 0 1 {-cx:.4f} {-cy:.4f} cm\n"
            f"{scale_x:.6f} 0 0 {scale_y:.6f} {e:.4f} {f:.4f} cm\n"
            f"{xobj_name_str} Do\nQ\n"
        )
    else:
        stream_str = (
            f"q\n{mirror_prefix}{clip_prefix}"
            f"{scale_x:.6f} 0 0 {scale_y:.6f} {e:.4f} {f:.4f} cm\n"
            f"{xobj_name_str} Do\nQ\n"
        )

    dest_page.contents_add(pikepdf.Stream(pdf, stream_str.encode('ascii')))


def insert_text(pdf: pikepdf.Pdf, pike_page: pikepdf.Page,
                point: Point = None, text: str = "", fontsize: float = 11,
                fontname: str = "helv", color=(0, 0, 0, 1), render_mode: int = 0, oc=None):
    """Insert text into the page."""
    if not text:
        return 0
    ph = page_height(pike_page)
    shape = ShapeBuilder(ph, pdf, pike_page)

    if render_mode == 3:
        font_key = shape._ensure_font("Helvetica")
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        x = point.x if point else 0
        y = ph - (point.y if point else 0)
        stream_ops = []
        if oc is not None:
            oc_name = shape._register_ocg(oc)
            stream_ops.append(f"/OC /{oc_name} BDC")
            
        stream_ops.extend([
            "BT", "3 Tr",
            f"/{font_key} {fontsize:.2f} Tf",
            f"{x:.4f} {y:.4f} Td",
            f"({escaped}) Tj", "ET"
        ])
        
        if oc is not None:
            stream_ops.append("EMC")
            
        content = ("\n".join(stream_ops) + "\n").encode('latin-1', errors='replace')
        pike_page.contents_add(pikepdf.Stream(pdf, content))
    else:
        shape.insert_text(point or Point(0, 0), text, fontsize=fontsize, fontname=fontname, color=color)
        shape.commit()
    return len(text)


def set_trimbox(pike_page: pikepdf.Page, rect: Rect):
    pike_page.TrimBox = pikepdf.Array([rect.x0, rect.y0, rect.x1, rect.y1])


def set_artbox(pike_page: pikepdf.Page, rect: Rect):
    pike_page.ArtBox = pikepdf.Array([rect.x0, rect.y0, rect.x1, rect.y1])


def add_ocg(pdf: pikepdf.Pdf, name: str, on: bool = True, add_to_order: bool = True):
    """Create an Optional Content Group (layer).
    
    Args:
        add_to_order: If False, OCG is added to /OCGs and /ON but NOT to /Order.
                      Use this for child OCGs that will be nested via add_ocg_group.
    """
    try:
        ocg_dict = pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OCG"),
            "/Name": pikepdf.String(name),
            "/Intent": pikepdf.Array([pikepdf.Name("/View"), pikepdf.Name("/Design")]),
            "/Usage": pikepdf.Dictionary({
                "/CreatorInfo": pikepdf.Dictionary({
                    "/Creator": pikepdf.String("Adobe Illustrator 29.8"),
                    "/Subtype": pikepdf.Name("/Artwork")
                })
            })
        })
        ocg_ref = pdf.make_indirect(ocg_dict)

        catalog = pdf.Root
        if "/OCProperties" not in catalog:
            catalog["/OCProperties"] = pikepdf.Dictionary({
                "/OCGs": pikepdf.Array([ocg_ref]),
                "/D": pikepdf.Dictionary({
                    "/Order": pikepdf.Array([ocg_ref]) if add_to_order else pikepdf.Array([]),
                    "/ON": pikepdf.Array([ocg_ref]) if on else pikepdf.Array([]),
                    "/OFF": pikepdf.Array([]) if on else pikepdf.Array([ocg_ref]),
                }),
            })
        else:
            oc_props = catalog["/OCProperties"]
            if "/OCGs" in oc_props:
                oc_props["/OCGs"].append(ocg_ref)
            else:
                oc_props["/OCGs"] = pikepdf.Array([ocg_ref])
            if "/D" in oc_props:
                d = oc_props["/D"]
                if add_to_order and "/Order" in d:
                    d["/Order"].append(ocg_ref)
                if on and "/ON" in d:
                    d["/ON"].append(ocg_ref)
                elif not on and "/OFF" in d:
                    d["/OFF"].append(ocg_ref)
        return ocg_ref
    except Exception as e:
        logger.warning(f"add_ocg failed: {e}")
        return 0


def get_pixmap(pike_page: pikepdf.Page, pdf_path: str, page_idx: int,
               scale: float = 1.0):
    """Render a page to pixel buffer using pypdfium2."""
    import pypdfium2 as pdfium
    import numpy as np

    pdf = pdfium.PdfDocument(pdf_path)
    page = pdf[page_idx]
    bitmap = page.render(scale=scale, rotation=0)
    pil_img = bitmap.to_pil().convert('RGB')
    img_array = np.array(pil_img)
    pdf.close()

    class _Pixmap:
        def __init__(self, arr):
            self.samples = arr.tobytes()
            self.height = arr.shape[0]
            self.width = arr.shape[1]
            self.n = arr.shape[2] if len(arr.shape) > 2 else 1

    return _Pixmap(img_array)
