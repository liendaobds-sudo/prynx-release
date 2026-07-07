"""
pdf_content_parser — Extract vector drawings from PDF content streams.

Standalone module extracted from pdf_wrapper. Parses PDF content stream operators
to reconstruct path geometry, returning drawing dicts compatible with the
format compatible with legacy page.extract_vector_paths() API.

Mở rộng cho spec die-shape-detection-ssot (R3.3, R3.4, R3.6, R3.7):
  - Theo dõi colorspace Separation/DeviceN theo TÊN kênh → gắn `spot_name` vào
    mỗi drawing (phục vụ nhận đường khuôn theo tên: CutContour, Dieline, ...).
  - Đệ quy Form XObject (toán tử `Do`) đến độ sâu tối đa cấu hình.
Các trường drawing cũ giữ nguyên (backward compatible); chỉ THÊM khoá `spot_name`.
"""
import re
import logging
import pikepdf
from app.workers.pdf_types import Point, Rect

logger = logging.getLogger(__name__)

# Độ sâu đệ quy Form XObject tối đa (R3.3, R3.4).
DEFAULT_MAX_XOBJECT_DEPTH = 10

# Tokenizer: số | toán tử (chữ) | tên PDF (/Name). Bổ sung nhánh /Name so với bản cũ.
_TOKEN_RE = re.compile(
    r'/[^\s/\[\]<>(){}]+'                                   # /Name literal
    r'|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'           # number
    r"|[a-zA-Z*]+'?\"?"                                     # operator
)

_DEVICE_SPACES = {"/DeviceRGB", "/DeviceCMYK", "/DeviceGray", "/Pattern", "/G", "/RGB", "/CMYK"}


def _resolve_spot_name(name_token, resources, pdf):
    """Tra colorspace theo tên (vd '/CS0') trong Resources/ColorSpace.

    Trả tên kênh khuôn (chuỗi, không gồm dấu '/') nếu là Separation/DeviceN,
    ngược lại None. DeviceN nhiều kênh → nối bằng '+' để matcher tách kiểm tra.
    """
    if not name_token or resources is None:
        return None
    if name_token in _DEVICE_SPACES:
        return None
    try:
        cs_dict = resources.get("/ColorSpace")
        if cs_dict is None:
            return None
        cs = cs_dict.get(name_token)
        if cs is None:
            return None
        # cs có thể là Array: [/Separation name alt tint] hoặc [/DeviceN [names] alt tint]
        if isinstance(cs, pikepdf.Array) and len(cs) >= 2:
            kind = str(cs[0])
            if kind == "/Separation":
                nm = str(cs[1])
                return nm[1:] if nm.startswith("/") else nm
            if kind == "/DeviceN":
                names = cs[1]
                out = []
                try:
                    for nm in names:
                        s = str(nm)
                        out.append(s[1:] if s.startswith("/") else s)
                except TypeError:
                    pass
                return "+".join(out) if out else None
    except Exception:
        return None
    return None


def _make_drawing(items, stroke_color, fill_color, width, draw_type, closed,
                  spot_name=None):
    """Build a drawing dict from parsed path items."""
    all_x = []
    all_y = []
    for item in items:
        if item[0] == 'l':
            all_x.extend([item[1].x, item[2].x])
            all_y.extend([item[1].y, item[2].y])
        elif item[0] == 'c':
            all_x.extend([item[1].x, item[2].x, item[3].x, item[4].x])
            all_y.extend([item[1].y, item[2].y, item[3].y, item[4].y])
        elif item[0] == 're':
            all_x.extend([item[1].x0, item[1].x1])
            all_y.extend([item[1].y0, item[1].y1])

    bbox = Rect(min(all_x), min(all_y), max(all_x), max(all_y)) if all_x else Rect(0, 0, 0, 0)

    return {
        'items': items, 'rect': bbox,
        'color': stroke_color, 'fill': fill_color,
        'width': width, 'type': draw_type, 'closePath': closed,
        'spot_name': spot_name,
    }


def _scrub_strings_and_inline_images(text: str) -> str:
    """Thay nội dung chuỗi literal ``(...)``, hex string ``<...>`` và ảnh inline
    (``BI ... ID <binary> EI``) bằng khoảng trắng TRƯỚC khi tokenize.

    Vì sao: tokenizer regex quét TOÀN BỘ stream, nên byte nằm trong chuỗi text
    (toán tử Tj/TJ) hoặc dữ liệu nhị phân ảnh inline có thể trùng dạng "số số m/l/c"
    → sinh lệnh vẽ "ma" → path rác, bbox tem lệch (audit bảo toàn nội dung 2026-07-07).
    Giữ NGUYÊN ``<<`` ``>>`` (dict) vì chỉ chứa name/number, không phải toán tử vẽ.
    Thay mỗi vùng bằng 1 space để không dính 2 toán tử kề nhau.
    """
    out = []
    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        # Chuỗi literal (...): cân bằng ngoặc, tôn trọng escape \( \) \\
        if ch == '(':
            i += 1
            depth = 1
            while i < n and depth > 0:
                c = text[i]
                if c == '\\':
                    i += 2
                    continue
                if c == '(':
                    depth += 1
                elif c == ')':
                    depth -= 1
                i += 1
            out.append(' ')
            continue
        if ch == '<':
            # Dict << >> : giữ nguyên (chỉ name/number bên trong).
            if i + 1 < n and text[i + 1] == '<':
                out.append('<<')
                i += 2
                continue
            # Hex string <...>
            j = text.find('>', i + 1)
            if j == -1:
                out.append(' ')
                break
            out.append(' ')
            i = j + 1
            continue
        if ch == '>':
            if i + 1 < n and text[i + 1] == '>':
                out.append('>>')
                i += 2
                continue
            out.append(' ')
            i += 1
            continue
        # Ảnh inline: token BI (word-boundary) ... ID <binary> EI. Bỏ toàn khối.
        if ch == 'B' and i + 1 < n and text[i + 1] == 'I' \
                and (i == 0 or not text[i - 1].isalpha()) \
                and (i + 2 >= n or not text[i + 2].isalpha()):
            # Tìm 'ID' (word-boundary) rồi bỏ nhị phân tới 'EI' (đứng giữa whitespace).
            m_id = re.search(r'(?<![A-Za-z])ID(?![A-Za-z])', text[i:])
            if m_id is not None:
                id_end = i + m_id.end()
                m_ei = re.search(r'\sEI(?![A-Za-z])', text[id_end:])
                if m_ei is not None:
                    out.append(' ')
                    i = id_end + m_ei.end()
                    continue
            # Không tìm được cấu trúc chuẩn → bỏ qua token BI như operator thường.
        out.append(ch)
        i += 1
    return ''.join(out)


def _mat_mul(m_new, m_cur):
    """Nhân ma trận PDF: m_new áp dụng trước m_cur (giống toán tử cm)."""
    a, b, c, d, e, f = m_new
    ca, cb, cc, cd, ce, cf = m_cur
    return [
        a * ca + b * cc, a * cb + b * cd,
        c * ca + d * cc, c * cb + d * cd,
        e * ca + f * cc + ce, e * cb + f * cd + cf,
    ]


def _parse_stream(raw_bytes: bytes, page_height: float, drawings: list,
                  resources=None, pdf=None, ctm0=None,
                  depth: int = 0, max_depth: int = DEFAULT_MAX_XOBJECT_DEPTH):
    """Phân tích một content stream, append drawings vào `drawings`.

    Hỗ trợ đệ quy Form XObject (R3.3/R3.4) và theo dõi spot name (R3.6/R3.7).
    `ctm0` là ma trận khởi tạo (cho form XObject); mặc định identity.
    """
    current_path = []
    current_point = None
    subpath_start = None
    stroke_color = (0, 0, 0)
    fill_color = None
    stroke_width = 1.0
    stroke_spot = None       # tên kênh khuôn cho nét (R3.6)
    fill_spot = None         # tên kênh khuôn cho vùng tô
    last_name = None         # token /Name gần nhất (toán hạng cho cs/CS/Do)

    base_ctm = list(ctm0) if ctm0 else [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    ctm_stack = [list(base_ctm)]
    spot_stack = []          # lưu (stroke_spot, fill_spot) cho q/Q (Fix H)
    current_ctm = list(base_ctm)

    def transform(px, py):
        a, b, c, d, e, f = current_ctm
        tx = px * a + py * c + e
        ty = px * b + py * d + f
        return tx, ty

    try:
        text = raw_bytes.decode('latin-1', errors='replace')
    except Exception:
        return

    text = _scrub_strings_and_inline_images(text)
    tokens = _TOKEN_RE.findall(text)

    num_stack = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1

        if tok.startswith('/'):
            last_name = tok
            continue

        try:
            num_stack.append(float(tok))
            continue
        except ValueError:
            pass

        if tok == 'q':
            ctm_stack.append(list(current_ctm))
            # Lưu CẢ spot-state (stroke/fill) cùng ctm: PDF q/Q lưu/khôi phục toàn
            # graphics-state gồm colorspace. Trước đây chỉ stack ctm → sau Q colorspace
            # thật đã đổi lại nhưng stroke_spot/fill_spot giữ giá trị trong q → path sau
            # gắn sai spot_name → phân loại nhầm die (Fix H, audit bảo toàn nội dung 2026-07-07).
            spot_stack.append((stroke_spot, fill_spot))
            num_stack.clear()
        elif tok == 'Q':
            if len(ctm_stack) > 1:
                ctm_stack.pop()
                current_ctm = list(ctm_stack[-1])
            if spot_stack:
                stroke_spot, fill_spot = spot_stack.pop()
            num_stack.clear()
        elif tok == 'cm':
            if len(num_stack) >= 6:
                a, b, c, d, e, f = num_stack[-6:]
                current_ctm = _mat_mul([a, b, c, d, e, f], current_ctm)
                ctm_stack[-1] = current_ctm
            num_stack.clear()

        elif tok == 'm':
            if len(num_stack) >= 2:
                x, y = num_stack[-2], num_stack[-1]
                tx, ty = transform(x, y)
                current_point = Point(tx, page_height - ty)
                subpath_start = Point(tx, page_height - ty)
            num_stack.clear()

        elif tok == 'l':
            if len(num_stack) >= 2 and current_point:
                x, y = num_stack[-2], num_stack[-1]
                tx, ty = transform(x, y)
                new_point = Point(tx, page_height - ty)
                current_path.append(('l', Point(current_point.x, current_point.y), new_point))
                current_point = new_point
            num_stack.clear()

        elif tok == 'c':
            if len(num_stack) >= 6 and current_point:
                x1, y1, x2, y2, x3, y3 = num_stack[-6:]
                tx1, ty1 = transform(x1, y1)
                tx2, ty2 = transform(x2, y2)
                tx3, ty3 = transform(x3, y3)
                cp1 = Point(tx1, page_height - ty1)
                cp2 = Point(tx2, page_height - ty2)
                end = Point(tx3, page_height - ty3)
                current_path.append(('c', Point(current_point.x, current_point.y), cp1, cp2, end))
                current_point = end
            num_stack.clear()

        elif tok == 'v':
            if len(num_stack) >= 4 and current_point:
                x2, y2, x3, y3 = num_stack[-4:]
                tx2, ty2 = transform(x2, y2)
                tx3, ty3 = transform(x3, y3)
                cp1 = Point(current_point.x, current_point.y)
                cp2 = Point(tx2, page_height - ty2)
                end = Point(tx3, page_height - ty3)
                current_path.append(('c', Point(current_point.x, current_point.y), cp1, cp2, end))
                current_point = end
            num_stack.clear()

        elif tok == 'y':
            if len(num_stack) >= 4 and current_point:
                x1, y1, x3, y3 = num_stack[-4:]
                tx1, ty1 = transform(x1, y1)
                tx3, ty3 = transform(x3, y3)
                cp1 = Point(tx1, page_height - ty1)
                end = Point(tx3, page_height - ty3)
                cp2 = Point(end.x, end.y)
                current_path.append(('c', Point(current_point.x, current_point.y), cp1, cp2, end))
                current_point = end
            num_stack.clear()

        elif tok == 're':
            if len(num_stack) >= 4:
                x, y, w, h = num_stack[-4:]
                pts = [transform(x, y), transform(x+w, y), transform(x+w, y+h), transform(x, y+h)]
                tx_min = min(p[0] for p in pts)
                tx_max = max(p[0] for p in pts)
                ty_min = min(p[1] for p in pts)
                ty_max = max(p[1] for p in pts)
                rect_y0 = page_height - ty_max
                rect_y1 = page_height - ty_min
                r = Rect(tx_min, rect_y0, tx_max, rect_y1)
                current_path.append(('re', r))
                current_point = Point(pts[0][0], page_height - pts[0][1])
                subpath_start = Point(pts[0][0], page_height - pts[0][1])
            num_stack.clear()

        elif tok == 'h':
            if subpath_start and current_point:
                if abs(current_point.x - subpath_start.x) > 0.01 or abs(current_point.y - subpath_start.y) > 0.01:
                    current_path.append(('l', Point(current_point.x, current_point.y), Point(subpath_start.x, subpath_start.y)))
                current_point = Point(subpath_start.x, subpath_start.y)
            num_stack.clear()

        elif tok in ('S', 's'):
            if current_path:
                if tok == 's' and subpath_start and current_point:
                    if abs(current_point.x - subpath_start.x) > 0.01 or abs(current_point.y - subpath_start.y) > 0.01:
                        current_path.append(('l', Point(current_point.x, current_point.y), Point(subpath_start.x, subpath_start.y)))
                drawings.append(_make_drawing(current_path, stroke_color, None, stroke_width, 's', tok == 's', spot_name=stroke_spot))
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok in ('f', 'F', 'f*'):
            if current_path:
                drawings.append(_make_drawing(current_path, None, fill_color or (0, 0, 0), stroke_width, 'f', True, spot_name=fill_spot))
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok in ('B', 'b', 'B*', 'b*'):
            if current_path:
                drawings.append(_make_drawing(current_path, stroke_color, fill_color or (0, 0, 0), stroke_width, 'sf', tok in ('b', 'b*'), spot_name=stroke_spot or fill_spot))
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok == 'n':
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok == 'w':
            if num_stack:
                stroke_width = num_stack[-1]
            num_stack.clear()

        elif tok == 'RG':
            if len(num_stack) >= 3:
                stroke_color = (num_stack[-3], num_stack[-2], num_stack[-1])
            stroke_spot = None
            num_stack.clear()
        elif tok == 'rg':
            if len(num_stack) >= 3:
                fill_color = (num_stack[-3], num_stack[-2], num_stack[-1])
            fill_spot = None
            num_stack.clear()
        elif tok == 'K':
            if len(num_stack) >= 4:
                stroke_color = (num_stack[-4], num_stack[-3], num_stack[-2], num_stack[-1])
            stroke_spot = None
            num_stack.clear()
        elif tok == 'k':
            if len(num_stack) >= 4:
                fill_color = (num_stack[-4], num_stack[-3], num_stack[-2], num_stack[-1])
            fill_spot = None
            num_stack.clear()
        elif tok == 'G':
            if len(num_stack) >= 1:
                g = num_stack[-1]
                stroke_color = (g, g, g)
            stroke_spot = None
            num_stack.clear()
        elif tok == 'g':
            if len(num_stack) >= 1:
                g = num_stack[-1]
                fill_color = (g, g, g)
            fill_spot = None
            num_stack.clear()

        elif tok == 'CS':
            stroke_spot = _resolve_spot_name(last_name, resources, pdf)
            num_stack.clear()
        elif tok == 'cs':
            fill_spot = _resolve_spot_name(last_name, resources, pdf)
            num_stack.clear()

        elif tok in ('SC', 'SCN'):
            if len(num_stack) >= 4:
                stroke_color = tuple(num_stack[-4:])
            elif len(num_stack) >= 3:
                stroke_color = tuple(num_stack[-3:])
            elif len(num_stack) >= 1:
                g = num_stack[-1]
                stroke_color = (g, g, g)
            num_stack.clear()
        elif tok in ('sc', 'scn'):
            if len(num_stack) >= 4:
                fill_color = tuple(num_stack[-4:])
            elif len(num_stack) >= 3:
                fill_color = tuple(num_stack[-3:])
            elif len(num_stack) >= 1:
                g = num_stack[-1]
                fill_color = (g, g, g)
            num_stack.clear()

        elif tok == 'Do':
            # Đệ quy Form XObject (R3.3, R3.4).
            if last_name and resources is not None and depth < max_depth:
                _recurse_xobject(last_name, resources, pdf, page_height,
                                  current_ctm, drawings, depth, max_depth)
            elif last_name and depth >= max_depth:
                logger.warning(
                    "[PARSE] Đạt giới hạn đệ quy XObject (%d) tại '%s' — dừng đệ quy.",
                    max_depth, last_name,
                )
            num_stack.clear()

        else:
            num_stack.clear()


def _recurse_xobject(name_token, resources, pdf, page_height, current_ctm,
                     drawings, depth, max_depth):
    """Giải Form XObject theo tên + đệ quy parse nội dung với CTM kết hợp."""
    try:
        xobj_dict = resources.get("/XObject")
        if xobj_dict is None:
            return
        xobj = xobj_dict.get(name_token)
        if xobj is None:
            return
        subtype = str(xobj.get("/Subtype", ""))
        if subtype != "/Form":
            return  # chỉ đệ quy Form XObject (bỏ qua Image)
        try:
            form_bytes = xobj.read_bytes()
        except Exception:
            return
        # Ma trận của form (mặc định identity).
        form_matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        try:
            m = xobj.get("/Matrix")
            if m is not None and len(m) == 6:
                form_matrix = [float(v) for v in m]
        except Exception:
            pass
        combined = _mat_mul(form_matrix, current_ctm)
        form_res = xobj.get("/Resources")
        if form_res is None:
            form_res = resources  # kế thừa Resources của parent
        _parse_stream(form_bytes, page_height, drawings,
                      resources=form_res, pdf=pdf, ctm0=combined,
                      depth=depth + 1, max_depth=max_depth)
    except Exception as e:
        logger.debug("[PARSE] Đệ quy XObject '%s' lỗi: %s", name_token, e)


def parse_content_stream(raw_bytes: bytes, page_height: float,
                         resources=None, pdf=None,
                         max_depth: int = DEFAULT_MAX_XOBJECT_DEPTH) -> list:
    """
    Parse PDF content stream bytes and extract drawing paths.

    Returns list of dicts, each with:
      - 'items': list of tuples ('l', p1, p2) or ('c', p0, cp1, cp2, p3) or ('re', Rect)
      - 'rect': Rect bounding box
      - 'color': stroke color tuple or None
      - 'fill': fill color tuple or None
      - 'width': stroke width
      - 'type': 's' (stroke), 'f' (fill), 'sf' (both)
      - 'closePath': bool
      - 'spot_name': tên kênh Separation/DeviceN nếu có, ngược lại None

    `resources`/`pdf` (tuỳ chọn) cho phép nhận spot name + đệ quy Form XObject.
    Khi không truyền (gọi cũ), hành vi tương thích ngược (không spot, không đệ quy).
    """
    drawings: list = []
    _parse_stream(raw_bytes, page_height, drawings,
                  resources=resources, pdf=pdf, ctm0=None,
                  depth=0, max_depth=max_depth)
    return drawings


def extract_vector_paths(pike_page: pikepdf.Page, pdf: pikepdf.Pdf) -> list:
    """
    Extract vector drawings from a pikepdf page.
    Equivalent to the old pdf_wrapper Page.extract_vector_paths().
    """
    mb = pike_page.mediabox
    page_h = float(mb[3] - mb[1])
    raw_bytes = b""

    try:
        contents = pike_page.get("/Contents")
        if contents is None:
            return []
        if isinstance(contents, pikepdf.Array):
            for ref in contents:
                try:
                    stream_obj = pdf.get_object(ref.objgen)
                    chunk = stream_obj.read_bytes()
                    if b"PX_" in chunk and b"Tj" in chunk:
                        continue
                    raw_bytes += chunk
                except Exception:
                    pass
        else:
            try:
                chunk = contents.read_bytes()
                if b"PX_" not in chunk or b"Tj" not in chunk:
                    raw_bytes = chunk
            except Exception:
                pass
    except Exception:
        return []

    if not raw_bytes:
        return []

    resources = None
    try:
        resources = pike_page.get("/Resources")
    except Exception:
        resources = None

    return parse_content_stream(raw_bytes, page_h, resources=resources, pdf=pdf)
