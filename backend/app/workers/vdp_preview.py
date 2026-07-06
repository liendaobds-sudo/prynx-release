"""Preview_Service cho VDP_Engine của PrynX.

Sinh ảnh xem trước (PNG) cho MỘT record đơn lẻ phục vụ VDP_UI, dùng CHUNG hàm
``render_one_record`` của ``vdp_engine`` để bảo toàn parity preview ↔ output:
cùng quy đổi toạ độ ``CSS_TO_PT_FACTOR = 0.75``, cùng ``hex_to_cmyk`` (đen
``#000000`` → ``(0,0,0,1)`` pure-K), cùng phép xoay 0/90/180/270 và cùng cách
clamp khung field vào trang (Req 4.4, 6.3).

API chính:
- ``clamp_index(requested, total)``    : kẹp chỉ số record về ``[1, total]`` kèm
  cờ ``clamped`` (Req 4.5).
- ``render_record_preview(...)``        : render record (đã kẹp) → PNG + danh sách
  ``field_errors`` (MISSING/ERR) mỗi mục kèm ``rect`` theo toạ độ ảnh (Req 4.1,
  4.2, 4.6, 4.9); nguồn 0 record → trả ``empty_source`` thay vì ném (Req 4.10).

Tham chiếu: design.md mục "Preview_Service"; Requirements 4.1, 4.2, 4.4, 4.5,
4.6, 4.9, 4.10, 6.3.
"""

from __future__ import annotations

import io
import os
import tempfile
import uuid
from dataclasses import dataclass, field as dc_field
from typing import Any, List, Mapping, Optional, Sequence, Tuple, Union

from app.workers import pdf_wrapper as pdf_lib
from app.workers.vdp_engine import (
    CSS_TO_PT_FACTOR,
    MM_TO_PTS,
    _canonicalize_template_to_cropbox,
    _register_font_family,
    render_one_record,
)


@dataclass
class FieldErrorMark:
    """Một dấu hiệu lỗi field trong bản xem trước (Req 4.6).

    ``rect`` theo toạ độ ẢNH PNG (gốc trên-trái, đơn vị pixel) để UI vẽ dấu hiệu
    đúng vị trí field bị lỗi.
    """

    field: str
    kind: str  # 'MISSING' | 'ERR'
    rect: dict  # {'x','y','w','h'} pixel, gốc trên-trái
    reason: str = ""


@dataclass
class PreviewResult:
    """Kết quả xem trước một record.

    - ``image_png``    : bytes ảnh PNG (None khi nguồn rỗng).
    - ``field_errors`` : danh sách ``FieldErrorMark``.
    - ``record_index`` : chỉ số record ĐÃ kẹp (1-based) thực sự được render; 0 khi rỗng.
    - ``clamped``       : True nếu chỉ số yêu cầu nằm ngoài khoảng và đã bị kẹp (Req 4.5).
    - ``empty_source``  : True nếu nguồn có 0 record (Req 4.10).
    - ``width``/``height`` : kích thước ảnh PNG (pixel).
    - ``message``       : thông báo tiếng Việt (vd đã kẹp / nguồn rỗng).
    """

    image_png: Optional[bytes]
    field_errors: List[FieldErrorMark] = dc_field(default_factory=list)
    record_index: int = 0
    clamped: bool = False
    empty_source: bool = False
    width: int = 0
    height: int = 0
    message: str = ""


def clamp_index(requested: int, total: int) -> Tuple[int, bool]:
    """Kẹp chỉ số record xem trước về ``[1, total]`` kèm cờ ``clamped`` (Req 4.5).

    - ``requested < 1``      → về record 1, ``clamped=True``.
    - ``requested > total``  → về record cuối (``total``), ``clamped=True``.
    - trong khoảng           → giữ nguyên, ``clamped=False``.

    Khi ``total <= 0`` (nguồn rỗng) không tồn tại chỉ số hợp lệ ⇒ trả ``(0, ...)``;
    caller (``render_record_preview``) báo nguồn rỗng riêng (Req 4.10).
    """
    if total <= 0:
        return 0, (requested != 0)
    if requested < 1:
        return 1, True
    if requested > total:
        return total, True
    return requested, False


def _as_dict(field: Union[Mapping[str, Any], object]) -> dict:
    """Chuẩn hoá field (pydantic VdpField hoặc dict) về dict cho render_one_record."""
    if hasattr(field, "model_dump"):
        return field.model_dump()
    if isinstance(field, Mapping):
        return dict(field)
    # Đối tượng thường: lấy các thuộc tính công khai.
    return {k: getattr(field, k) for k in dir(field) if not k.startswith("_")}


def _compute_field_rects(fields_dict: Sequence[dict]) -> List[dict]:
    """Tính khung field theo point — CÙNG công thức ``process_chunk`` (Req 6.1, 6.3).

    ``real_pts = frontend_mm * MM_TO_PTS * CSS_TO_PT_FACTOR`` cho mọi loại field.
    """
    rects: List[dict] = []
    for field in fields_dict:
        rects.append({
            'x': field['x'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
            'y': field['y'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
            'w': field['width'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
            'h': field['height'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
        })
    return rects


def _register_preview_fonts(fields_dict: Sequence[dict]) -> dict:
    """Đăng ký font (gồm biến thể Bold/Italic thật) như ``process_chunk`` (#7)."""
    field_font_variants: dict = {}
    for field in fields_dict:
        if field.get('type') == 'text':
            font_file = field.get('fontFile')
            if font_file and os.path.exists(font_file):
                base_name = "f_" + str(field.get('id', 'default')).replace('-', '')
                field_font_variants[field.get('id')] = _register_font_family(font_file, base_name)
    return field_font_variants


def render_record_preview(
    template_path: str,
    fields: Sequence[Union[Mapping[str, Any], object]],
    rows: Sequence[Mapping[str, object]],
    requested_index: int,
    *,
    scale: float = 2.0,
) -> PreviewResult:
    """Render bản xem trước cho record ở ``requested_index`` (1-based) → PNG.

    Dùng CHUNG ``render_one_record`` của engine để bảo toàn parity preview ↔
    output (Req 4.4, 6.3). Trình tự:

    1. Nguồn 0 record ⇒ trả ``PreviewResult(empty_source=True)`` (Req 4.10), KHÔNG ném.
    2. Kẹp chỉ số về ``[1, total]`` + cờ ``clamped`` (Req 4.5).
    3. Trang template gán theo ``(index-1) % template_page_count`` như sinh lô (Req 7.4).
    4. Vẽ overlay dữ liệu biến đổi lên trang nền template, rasterize bằng pypdfium2.
    5. Thu ``field_errors`` (MISSING/ERR) qua ``error_sink`` của engine, quy đổi
       ``rect`` từ point (gốc trên-trái) sang pixel ảnh (Req 4.6).

    ``scale`` là số pixel trên mỗi point (``scale=1`` ⇒ 72 dpi, ``scale=2`` ⇒ 144 dpi).
    """
    total = len(rows)
    if total == 0:
        return PreviewResult(
            image_png=None,
            field_errors=[],
            record_index=0,
            clamped=False,
            empty_source=True,
            message="Nguồn dữ liệu rỗng (0 record) — không thể xem trước.",
        )

    index, clamped = clamp_index(requested_index, total)
    row = dict(rows[index - 1])
    fields_dict = [_as_dict(f) for f in fields]

    # Chuẩn hoá CropBox→MediaBox (sau Crop) để preview khớp output — CÙNG phép
    # canonical như run_vdp_engine, giữ parity preview ↔ bản in.
    template_path, _canon_tmp = _canonicalize_template_to_cropbox(template_path)

    doc_template = pdf_lib.open(template_path)
    tmp_path = None
    try:
        template_page_count = len(doc_template)
        if template_page_count == 0:
            return PreviewResult(
                image_png=None,
                field_errors=[],
                record_index=index,
                clamped=clamped,
                empty_source=False,
                message="Template không có trang nào.",
            )

        t_idx = (index - 1) % template_page_count

        # Kích thước trang theo MediaBox — CÙNG cách lấy như ``process_chunk``.
        mb = doc_template._pdf.pages[t_idx].mediabox
        pw = float(mb[2] - mb[0])
        ph = float(mb[3] - mb[1])

        field_rects = _compute_field_rects(fields_dict)
        field_font_variants = _register_preview_fonts(fields_dict)

        # Vẽ overlay dữ liệu biến đổi lên canvas ReportLab phủ toàn MediaBox.
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(pw, ph))
        error_sink: List[dict] = []
        render_one_record(
            c, fields_dict, row, field_rects, pw, ph, field_font_variants,
            error_sink=error_sink,
        )
        c.showPage()
        c.save()

        # Ghép overlay lên trang nền template (giữ nội dung tĩnh của template).
        out_doc = pdf_lib.open()
        out_doc._pdf.pages.append(doc_template._pdf.pages[t_idx])
        page = out_doc[len(out_doc) - 1]
        overlay_pdf = pdf_lib.open(stream=buf.getvalue())
        page.show_pdf_page(page.rect, overlay_pdf, 0)

        tmp_path = os.path.join(tempfile.gettempdir(), f"vdp_preview_{uuid.uuid4().hex}.pdf")
        out_doc.save(tmp_path)
        out_doc.close()

        # Rasterize trang ghép → PNG bằng pypdfium2 (scale = pixel/point).
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(tmp_path)
        try:
            page_r = pdf[0]
            bitmap = page_r.render(scale=scale)
            pil_img = bitmap.to_pil()
            img_w, img_h = pil_img.size
            png_buf = io.BytesIO()
            pil_img.save(png_buf, format="PNG")
            image_png = png_buf.getvalue()
        finally:
            pdf.close()

        # Quy đổi rect lỗi: point (gốc trên-trái) → pixel ảnh (cùng gốc trên-trái).
        field_errors: List[FieldErrorMark] = []
        for e in error_sink:
            r = e['rect']
            field_errors.append(FieldErrorMark(
                field=e.get('field', ''),
                kind=e.get('kind', 'ERR'),
                reason=e.get('reason', ''),
                rect={
                    'x': r['x'] * scale,
                    'y': r['y'] * scale,
                    'w': r['w'] * scale,
                    'h': r['h'] * scale,
                },
            ))

        message = ""
        if clamped:
            message = f"Chỉ số yêu cầu nằm ngoài khoảng — đã giới hạn về record {index}/{total}."

        return PreviewResult(
            image_png=image_png,
            field_errors=field_errors,
            record_index=index,
            clamped=clamped,
            empty_source=False,
            width=img_w,
            height=img_h,
            message=message,
        )
    finally:
        doc_template.close()
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        if _canon_tmp and os.path.exists(template_path):
            try:
                os.remove(template_path)
            except Exception:
                pass
