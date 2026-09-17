"""
Geometry_Reader — liệt kê object hình học của một trang PDF bằng PDFium (read-only).

Vai trò trong kiến trúc `pdf-object-edit`:
- PDFium (pypdfium2.raw) = engine ĐỌC hình học. Module này CHỈ đọc: liệt kê object,
  lấy bbox/type chính xác để Object_Mapper ánh xạ về dải operator pikepdf.
- TUYỆT ĐỐI KHÔNG ghi: KHÔNG gọi `FPDFPage_GenerateContent`, KHÔNG save tài liệu.
  Mọi đường GHI đi qua pikepdf ở Stream_Editor (color-safe).

Hàm chính: `list_objects(pdf_path, page_index) -> list[ObjMeta]`.

Mapping type (PDFium → ObjMeta.type):
- FPDF_PAGEOBJ_TEXT  (1) → "text"
- FPDF_PAGEOBJ_IMAGE (3) → "image"
- FPDF_PAGEOBJ_PATH  (2) → "vector"
- Các loại khác (SHADING=4 / FORM=5 / UNKNOWN=0): xử lý an toàn — gắn nhãn "vector"
  để KHÔNG crash, vẫn liệt kê được bbox (Form/Shading là vùng vẽ vector hợp lý).

BBox lưu theo hệ tọa độ PDF (gốc bottom-left) như PDFium trả về:
[x0=left, y0=bottom, x1=right, y1=top].

_Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 13.1, 13.3_
"""
from __future__ import annotations

import ctypes
import logging

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from app.schemas.edit import ObjMeta

logger = logging.getLogger(__name__)

# ── Ngưỡng an toàn hiệu năng (Yêu cầu 13.1, 13.3) ───────────────────────────
# Trang in phức tạp có thể chứa vài nghìn object. Liệt kê là O(N) nên an toàn,
# nhưng ta vẫn áp trần cứng để tránh treo vô hạn với file bất thường.
MAX_OBJECTS_PER_PAGE: int = 50_000

# PDFium can expose whitespace/control text as a page object with a point bbox.
# Such an object paints no pixels and cannot be edited independently from its TJ run.
_POINT_TEXT_EPSILON_PT = 0.01


def _is_nonpainting_point_text(obj_type: str, bbox: list[float]) -> bool:
    return (
        obj_type == "text"
        and abs(bbox[2] - bbox[0]) <= _POINT_TEXT_EPSILON_PT
        and abs(bbox[3] - bbox[1]) <= _POINT_TEXT_EPSILON_PT
    )

# Ánh xạ hằng số type PDFium → nhãn type của ObjMeta.
_TYPE_MAP = {
    pdfium_c.FPDF_PAGEOBJ_TEXT: "text",
    pdfium_c.FPDF_PAGEOBJ_IMAGE: "image",
    pdfium_c.FPDF_PAGEOBJ_PATH: "vector",
}


def _map_type(raw_type: int) -> str:
    """
    Chuyển hằng số type PDFium sang nhãn ObjMeta.type ∈ {text, image, vector}.

    Các loại không nằm trong {TEXT, IMAGE, PATH} (SHADING/FORM/UNKNOWN) được gắn
    nhãn "vector" để xử lý an toàn (chúng đều là vùng vẽ phi-text/phi-ảnh), bảo đảm
    KHÔNG phát sinh lỗi khi gặp object lạ (Yêu cầu 1.5).
    """
    return _TYPE_MAP.get(raw_type, "vector")


def _looks_unreliable(s: str) -> bool:
    """
    Heuristic phát hiện text trích KHÔNG đáng tin (font có ToUnicode hỏng/thiếu):
    xuất hiện ký tự U+FFFD (replacement) hoặc ký tự dải MŨI TÊN/KỸ THUẬT
    (U+2190–U+23FF) — thường là dấu hiệu glyph→unicode bị ánh xạ sai (vd. dấu
    cách → '↔', 'đ' → '↑'). Khi đó KHÔNG nên điền sẵn editor bằng nội dung sai.
    """
    for ch in s:
        o = ord(ch)
        if o == 0xFFFD:
            return True
        if 0x2190 <= o <= 0x23FF:
            return True
    return False


def _extract_text(obj, text_page) -> str | None:
    """
    Trích nội dung text gốc của MỘT text-object qua `FPDFTextObj_GetText`
    (read-only). Trả None nếu không có text-page / rỗng / lỗi / KHÔNG đáng tin.

    PDFium trả chuỗi UTF-16LE; `length` tính theo số đơn vị `unsigned short`
    (gồm ký tự kết thúc null). Gọi lần đầu với buffer=None để lấy độ dài.
    """
    if not text_page:
        return None
    try:
        n = int(pdfium_c.FPDFTextObj_GetText(obj, text_page, None, 0))
        if n <= 0:
            return None
        buf = (ctypes.c_ushort * n)()
        pdfium_c.FPDFTextObj_GetText(obj, text_page, buf, n)
        s = bytes(buf).decode("utf-16-le", errors="replace").rstrip("\x00")
        if not s:
            return None
        # Font ToUnicode hỏng → trả None để editor KHÔNG điền nội dung sai
        # (thà để trống cho người dùng tự gõ còn hơn hiện chữ rác).
        if _looks_unreliable(s):
            return None
        return s
    except Exception:  # noqa: BLE001 - trích text best-effort, lỗi → bỏ qua
        return None


def _extract_font_name(obj) -> str | None:
    """
    Lấy TÊN font gốc của text-object (BaseFont), bỏ tiền tố subset dạng 'ABCDEF+'.
    Dùng để gợi ý/khớp với font hệ thống khi sửa (auto nhận font gốc). None nếu
    không lấy được (API không hỗ trợ / lỗi).
    """
    try:
        get_font = getattr(pdfium_c, "FPDFTextObj_GetFont", None)
        if get_font is None:
            return None
        font = get_font(obj)
        if not font:
            return None
        get_name = getattr(pdfium_c, "FPDFFont_GetBaseFontName", None) or getattr(
            pdfium_c, "FPDFFont_GetFontName", None
        )
        if get_name is None:
            return None
        n = int(get_name(font, None, 0))
        if n <= 0:
            return None
        buf = ctypes.create_string_buffer(n)
        get_name(font, buf, n)
        name = buf.value.decode("ascii", errors="replace").strip()
        # Bỏ tiền tố subset 'ABCDEF+' (6 chữ in hoa + '+').
        if len(name) > 7 and name[6] == "+" and name[:6].isupper() and name[:6].isalpha():
            name = name[7:]
        return name or None
    except Exception:  # noqa: BLE001
        return None


def _extract_fill_color(obj) -> list[int] | None:
    """
    Lấy MÀU TÔ (fill) RGB của object qua `FPDFPageObj_GetFillColor` (0..255).
    Trả None nếu không lấy được. Dùng để editor inline hiển thị ĐÚNG màu chữ gốc.
    """
    try:
        r = ctypes.c_uint(0)
        g = ctypes.c_uint(0)
        b = ctypes.c_uint(0)
        a = ctypes.c_uint(0)
        ok = pdfium_c.FPDFPageObj_GetFillColor(
            obj, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)
        )
        if not ok:
            return None
        return [int(r.value), int(g.value), int(b.value)]
    except Exception:  # noqa: BLE001
        return None


def _pdfium_wide_string(call, *args) -> str | None:
    """Read a UTF-16LE string returned by a PDFium two-pass buffer API."""
    try:
        size = ctypes.c_ulong(0)
        call(*args, None, 0, ctypes.byref(size))
        if size.value <= 0:
            return None
        buffer = ctypes.create_string_buffer(size.value)
        if not call(*args, buffer, size.value, ctypes.byref(size)):
            return None
        return bytes(buffer[:size.value]).decode("utf-16-le", errors="replace").rstrip("\x00") or None
    except Exception:  # noqa: BLE001 - optional metadata only
        return None


def _extract_ocg_names(obj) -> list[str]:
    """Read public OCG names attached to a PDFium page object via /OC marks."""
    names: list[str] = []
    try:
        mark_count = int(pdfium_c.FPDFPageObj_CountMarks(obj))
        for index in range(mark_count):
            mark = pdfium_c.FPDFPageObj_GetMark(obj, index)
            if not mark:
                continue
            tag = _pdfium_wide_string(pdfium_c.FPDFPageObjMark_GetName, mark)
            if tag != "OC":
                continue
            name = _pdfium_wide_string(
                pdfium_c.FPDFPageObjMark_GetParamStringValue, mark, b"Name"
            )
            if name and name not in names:
                names.append(name)
    except Exception:  # noqa: BLE001 - membership is enriched again from pikepdf
        pass
    return names

def list_objects(pdf_path: str, page_index: int, include_text_props: bool = True) -> list[ObjMeta]:
    """Bọc `_list_objects_locked` trong `pdfium_guard` (audit 2026-07-29 §C.1).

    Toàn thân hàm là FFI PDFium thô và được gọi từ đường chạy trong thread
    (`/edit/objects`, `/preflight/objects`), nên khóa bao cả hàm thay vì bọc lẻ từng
    lời gọi. Dùng wrapper để không phải thụt lề lại thân hàm dài — dễ soi diff hơn.
    """
    from app.core.pdfium_lock import pdfium_guard

    with pdfium_guard("geometry_list_objects"):
        return _list_objects_locked(pdf_path, page_index, include_text_props)


def _list_objects_locked(pdf_path: str, page_index: int, include_text_props: bool = True) -> list[ObjMeta]:
    """
    Liệt kê tất cả PDF_Object của một trang kèm type + bbox chính xác (read-only).

    Args:
        pdf_path: đường dẫn file PDF cần đọc.
        page_index: chỉ số trang (0-indexed).

    Returns:
        Danh sách `ObjMeta` (id, drawIndex, type, bbox, matrix). Trả về danh sách
        rỗng nếu trang không có object nào — KHÔNG phát sinh lỗi (Yêu cầu 1.5).

    Ghi chú:
        - BBox lấy từ `FPDFPageObj_GetBounds` → bao đúng vùng hiển thị của object
          (ảnh là vùng ảnh, KHÔNG phải cả trang) (Yêu cầu 1.2).
        - `id` ổn định trong một lần liệt kê của một trang theo dạng
          "{type}-{drawIndex}", đủ để Object_Mapper ánh xạ lại (Yêu cầu 1.4).
        - CHỈ-ĐỌC: không gọi GenerateContent, không save (Yêu cầu 1.6).
    """
    pdf = None
    text_page_raw = None
    try:
        pdf = pdfium.PdfDocument(pdf_path)

        n_pages = len(pdf)
        if page_index < 0 or page_index >= n_pages:
            raise IndexError(
                f"page_index {page_index} ngoài phạm vi (0..{n_pages - 1})"
            )

        page = pdf[page_index]
        page_raw = page.raw

        # Text-page (read-only) để trích nội dung text-object cho editor sửa.
        # Chỉ nạp khi include_text_props=True (trích nội dung/màu/font). Trang CỰC
        # NHIỀU object → bỏ qua để liệt kê nhanh (props lấy lazy qua endpoint riêng).
        if include_text_props:
            try:
                text_page_raw = pdfium_c.FPDFText_LoadPage(page_raw)
            except Exception:  # noqa: BLE001
                text_page_raw = None

        # Đếm số object trên trang (O(1)); trang rỗng → trả danh sách rỗng.
        count = int(pdfium_c.FPDFPage_CountObjects(page_raw))
        if count <= 0:
            return []

        # Áp trần cứng để tránh treo vô hạn với file bất thường (Yêu cầu 13.1).
        if count > MAX_OBJECTS_PER_PAGE:
            logger.warning(
                "Trang %d có %d object > trần %d; chỉ liệt kê %d object đầu.",
                page_index,
                count,
                MAX_OBJECTS_PER_PAGE,
                MAX_OBJECTS_PER_PAGE,
            )
            count = MAX_OBJECTS_PER_PAGE

        out: list[ObjMeta] = []

        # Khởi tạo sẵn 4 c_float cho GetBounds (left, bottom, right, top) và
        # FS_MATRIX cho GetMatrix, tái dùng qua mỗi vòng lặp.
        for i in range(count):
            obj = pdfium_c.FPDFPage_GetObject(page_raw, i)
            if not obj:
                # Object không truy cập được — bỏ qua an toàn, không crash.
                continue

            raw_type = int(pdfium_c.FPDFPageObj_GetType(obj))
            obj_type = _map_type(raw_type)

            # ── BBox: c_float (left, bottom, right, top) theo hệ PDF bottom-left ──
            left = ctypes.c_float(0.0)
            bottom = ctypes.c_float(0.0)
            right = ctypes.c_float(0.0)
            top = ctypes.c_float(0.0)
            ok_bounds = pdfium_c.FPDFPageObj_GetBounds(
                obj,
                ctypes.byref(left),
                ctypes.byref(bottom),
                ctypes.byref(right),
                ctypes.byref(top),
            )
            if not ok_bounds:
                # Không lấy được bbox (object suy biến/clip lạ) → bỏ qua an toàn.
                logger.debug(
                    "Bỏ qua object #%d (type=%d): GetBounds thất bại.", i, raw_type
                )
                continue

            # bbox theo hệ PDF: [x0=left, y0=bottom, x1=right, y1=top].
            bbox = [
                float(left.value),
                float(bottom.value),
                float(right.value),
                float(top.value),
            ]

            # A zero-area text object is normally a whitespace/control glyph inside a
            # larger TJ/Tj run. Exposing it as an editable component leads to a row that
            # has no visible pixels and cannot be safely hidden on its own.
            if _is_nonpainting_point_text(obj_type, bbox):
                logger.debug("Bỏ qua text object không vẽ #%d (point bbox).", i)
                continue
            # ── Matrix (CTM) của object nếu có ─────────────────────────────
            matrix: list[float] | None = None
            fs_matrix = pdfium_c.FS_MATRIX()
            if pdfium_c.FPDFPageObj_GetMatrix(obj, ctypes.byref(fs_matrix)):
                matrix = [
                    float(fs_matrix.a),
                    float(fs_matrix.b),
                    float(fs_matrix.c),
                    float(fs_matrix.d),
                    float(fs_matrix.e),
                    float(fs_matrix.f),
                ]

            # id ổn định trong một lần liệt kê: theo type + drawIndex.
            if include_text_props and obj_type == "text":
                content = _extract_text(obj, text_page_raw)
                color = _extract_fill_color(obj)
                font_name = _extract_font_name(obj)
            else:
                content = color = font_name = None
            out.append(
                ObjMeta(
                    id=f"{obj_type}-{i}",
                    drawIndex=i,
                    type=obj_type,
                    ocgNames=_extract_ocg_names(obj),
                    bbox=bbox,
                    matrix=matrix,
                    content=content,
                    color=color,
                    fontName=font_name,
                )
            )

        return out
    finally:
        # Quản lý vòng đời document đúng cách: luôn đóng để giải phóng handle PDFium.
        if text_page_raw is not None:
            try:
                pdfium_c.FPDFText_ClosePage(text_page_raw)
            except Exception:  # pragma: no cover - dọn dẹp best-effort
                pass
        if pdf is not None:
            try:
                pdf.close()
            except Exception:  # pragma: no cover - dọn dẹp best-effort
                pass


def _extract_font_size(obj) -> float | None:
    """Lấy cỡ chữ gốc (pt) của text-object qua FPDFTextObj_GetFontSize."""
    try:
        get_size = getattr(pdfium_c, "FPDFTextObj_GetFontSize", None)
        if get_size is None:
            return None
        size = ctypes.c_float(0.0)
        ok = get_size(obj, ctypes.byref(size))
        if ok and size.value > 0:
            return round(float(size.value), 2)
        return None
    except Exception:  # noqa: BLE001
        return None


def get_text_object_props(pdf_path: str, page_index: int, draw_index: int) -> dict:
    """Bọc `_get_text_object_props_locked` trong `pdfium_guard` (audit 2026-07-29 §C.1)."""
    from app.core.pdfium_lock import pdfium_guard

    with pdfium_guard("geometry_text_props"):
        return _get_text_object_props_locked(pdf_path, page_index, draw_index)


def _get_text_object_props_locked(pdf_path: str, page_index: int, draw_index: int) -> dict:
    """
    Lấy LAZY (on-demand) nội dung/màu/font của MỘT text-object theo `draw_index`
    (chỉ số thứ tự vẽ PDFium). Dùng khi mở editor sửa text — tránh trích cho MỌI
    object lúc liệt kê (nhanh trên trang cực nhiều object).

    Trả {"content": str|None, "color": [r,g,b]|None, "fontName": str|None}.
    Object không tồn tại / không phải text → các trường None.
    """
    pdf = None
    text_page_raw = None
    out = {"content": None, "color": None, "fontName": None, "fontSize": None}
    try:
        pdf = pdfium.PdfDocument(pdf_path)
        if page_index < 0 or page_index >= len(pdf):
            return out
        page = pdf[page_index]
        page_raw = page.raw
        count = int(pdfium_c.FPDFPage_CountObjects(page_raw))
        if draw_index < 0 or draw_index >= count:
            return out
        obj = pdfium_c.FPDFPage_GetObject(page_raw, draw_index)
        if not obj:
            return out
        if int(pdfium_c.FPDFPageObj_GetType(obj)) != pdfium_c.FPDF_PAGEOBJ_TEXT:
            return out
        try:
            text_page_raw = pdfium_c.FPDFText_LoadPage(page_raw)
        except Exception:  # noqa: BLE001
            text_page_raw = None
        out["content"] = _extract_text(obj, text_page_raw)
        out["color"] = _extract_fill_color(obj)
        out["fontName"] = _extract_font_name(obj)
        out["fontSize"] = _extract_font_size(obj)
        return out
    except Exception:  # noqa: BLE001 - best-effort
        return out
    finally:
        if text_page_raw is not None:
            try:
                pdfium_c.FPDFText_ClosePage(text_page_raw)
            except Exception:  # pragma: no cover
                pass
        if pdf is not None:
            try:
                pdf.close()
            except Exception:  # pragma: no cover
                pass


def list_image_placements(pdf_path: str, page_index: int) -> list[dict]:
    """Bọc `_list_image_placements_locked` trong `pdfium_guard` (audit 2026-07-29 §C.1)."""
    from app.core.pdfium_lock import pdfium_guard

    with pdfium_guard("geometry_image_placements"):
        return _list_image_placements_locked(pdf_path, page_index)


def _list_image_placements_locked(pdf_path: str, page_index: int) -> list[dict]:
    """
    Liệt kê tất cả PLACEMENT ẢNH của một trang (read-only, PDFium).

    PDFium tự phẳng hóa Form XObject lồng nhau → bbox/matrix của image-object đã
    phản ánh tích CTM Form-cha × placement, nên kích thước đặt thật tính được trực
    tiếp từ matrix/bbox (Yêu cầu 1.2, 2.1, 2.4). Helper CHỈ-ĐỌC, không ghi.

    Returns: list dict, mỗi placement:
        {
          "draw_index": int,                  # thứ tự vẽ (đã phẳng hóa)
          "bbox": [x0, y0, x1, y1],           # hệ PDF bottom-left, point
          "matrix": [a, b, c, d, e, f] | None,
          "xobject_name": str | None,         # PDFium không lộ tên resource → None
          "pixel_w": int | None,              # từ FPDFImageObj metadata nếu có
          "pixel_h": int | None,
        }
    Không phát sinh lỗi; object lỗi → bỏ qua (debug log). Trang ngoài phạm vi → [].
    """
    pdf = None
    try:
        pdf = pdfium.PdfDocument(pdf_path)
        n_pages = len(pdf)
        if page_index < 0 or page_index >= n_pages:
            return []

        page = pdf[page_index]
        page_raw = page.raw

        count = int(pdfium_c.FPDFPage_CountObjects(page_raw))
        if count <= 0:
            return []
        if count > MAX_OBJECTS_PER_PAGE:
            count = MAX_OBJECTS_PER_PAGE

        out: list[dict] = []
        for i in range(count):
            obj = pdfium_c.FPDFPage_GetObject(page_raw, i)
            if not obj:
                continue
            if int(pdfium_c.FPDFPageObj_GetType(obj)) != pdfium_c.FPDF_PAGEOBJ_IMAGE:
                continue

            # ── BBox (hệ PDF bottom-left) ──
            left = ctypes.c_float(0.0)
            bottom = ctypes.c_float(0.0)
            right = ctypes.c_float(0.0)
            top = ctypes.c_float(0.0)
            if not pdfium_c.FPDFPageObj_GetBounds(
                obj,
                ctypes.byref(left),
                ctypes.byref(bottom),
                ctypes.byref(right),
                ctypes.byref(top),
            ):
                logger.debug("Bỏ qua image #%d: GetBounds thất bại.", i)
                continue
            bbox = [float(left.value), float(bottom.value), float(right.value), float(top.value)]

            # ── Matrix (CTM) ──
            matrix: list[float] | None = None
            fs_matrix = pdfium_c.FS_MATRIX()
            if pdfium_c.FPDFPageObj_GetMatrix(obj, ctypes.byref(fs_matrix)):
                matrix = [
                    float(fs_matrix.a), float(fs_matrix.b), float(fs_matrix.c),
                    float(fs_matrix.d), float(fs_matrix.e), float(fs_matrix.f),
                ]

            # ── Pixel size qua metadata (best-effort) ──
            pixel_w: int | None = None
            pixel_h: int | None = None
            try:
                get_meta = getattr(pdfium_c, "FPDFImageObj_GetImageMetadata", None)
                if get_meta is not None:
                    meta = pdfium_c.FPDF_IMAGEOBJ_METADATA()
                    if get_meta(obj, page_raw, ctypes.byref(meta)):
                        pw = int(meta.width)
                        ph = int(meta.height)
                        pixel_w = pw if pw > 0 else None
                        pixel_h = ph if ph > 0 else None
            except Exception:  # noqa: BLE001 - metadata best-effort
                pixel_w = pixel_h = None

            out.append({
                "draw_index": i,
                "bbox": bbox,
                "matrix": matrix,
                "xobject_name": None,  # PDFium không lộ tên resource /Im..
                "pixel_w": pixel_w,
                "pixel_h": pixel_h,
            })

        return out
    except Exception as exc:  # noqa: BLE001 - read-only best-effort
        logger.debug("list_image_placements lỗi (trang %s): %s", page_index, exc)
        return []
    finally:
        if pdf is not None:
            try:
                pdf.close()
            except Exception:  # pragma: no cover
                pass
