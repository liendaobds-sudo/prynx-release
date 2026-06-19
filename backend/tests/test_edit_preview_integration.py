"""
Integration tests (Task 9.3 — spec `pdf-object-edit`).

Mục tiêu: xác nhận đường PREVIEW (PDFium render từ BYTES pikepdf) và đường LƯU
(pikepdf → Working_File) NHẤT QUÁN về hình học với object đã sửa.

  - Yêu cầu 12.1: preview (PDFium render) khớp HÌNH HỌC với object đã sửa —
    vị trí / kích thước / hướng trong tolerance ≤ 1.0 point mỗi cạnh.
  - Yêu cầu 12.3: kết quả LƯU (pikepdf) nhất quán về hình học với preview đã
    hiển thị.

ĐÂY KHÔNG PHẢI property-based test — chỉ 3 ví dụ đại diện (move / resize / rotate),
theo lưu ý phạm vi PBT trong design (render PDFium thuộc hành vi thư viện ngoài →
kiểm bằng integration test 1–3 ví dụ).

CHIẾN LƯỢC (mức HÀM, không qua HTTP/DB — ổn định):
  - Dựng PDF mẫu bằng pikepdf: 1 ảnh XObject (bbox CHÍNH XÁC từ CTM) làm object
    MỤC TIÊU + 1 vector rect làm Untouched_Object.
  - PREVIEW: gọi trực tiếp `_render_preview_blocking(pdf_path, op)` → xác nhận
    raster PNG hợp lệ, kích thước khớp DPI × kích thước trang, đúng trang.
  - LƯU: gọi `apply_and_save(pdf_path, mutate)` với `mutate` = `_apply_edit_op`
    (CHÍNH cùng đường ghi pikepdf mà preview dùng) → Working_File mới.
  - Mở Working_File bằng `geometry_reader.list_objects` → bbox object MỤC TIÊU
    sau sửa, so với bbox KỲ VỌNG (suy ra từ phép biến đổi) trong tolerance
    ≤ 1.0pt (đây là 12.1: hình học khớp object đã sửa).
  - Dựng thêm BYTES theo đúng đường preview (`_apply_edit_op` → `pdf.save`) rồi
    list_objects: bbox PHẢI khớp bbox của bản LƯU trong tolerance ≤ 1.0pt
    (đây là 12.3: bản lưu nhất quán hình học với preview).
"""
import base64
import io
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from PIL import Image

from app.api.routes.edit import (
    PREVIEW_DPI,
    _apply_edit_op,
    _render_preview_blocking,
)
from app.core import geometry_reader
from app.core.edit_io import apply_and_save
from app.schemas.edit import EditOp, MoveDelta, ResizeScale, bbox_within_tolerance

# ── Hằng số layout trang mẫu ─────────────────────────────────────────────────
PAGE_W = 300.0
PAGE_H = 300.0
TOL = 1.0  # tolerance ≤ 1.0pt mỗi cạnh (Yêu cầu 12.1, 12.3)

# Object MỤC TIÊU: ảnh đặt qua CTM → bbox chính xác. Chọn KHÔNG vuông để phép
# xoay 90° đổi rõ kích thước bbox (phân biệt position/size/orientation).
IMG_X, IMG_Y, IMG_W, IMG_H = 50.0, 60.0, 60.0, 40.0
IMG_BBOX = [IMG_X, IMG_Y, IMG_X + IMG_W, IMG_Y + IMG_H]  # [50, 60, 110, 100]

# Untouched_Object: vector rect ở góc khác, KHÔNG chồng vùng ảnh.
RECT_X, RECT_Y, RECT_W, RECT_H = 180.0, 200.0, 50.0, 30.0
RECT_BBOX = [RECT_X, RECT_Y, RECT_X + RECT_W, RECT_Y + RECT_H]


# ── Dựng PDF mẫu bằng pikepdf ────────────────────────────────────────────────
def _make_image_xobject(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """XObject ảnh 2x2 RGB tối thiểu (uncompressed)."""
    data = bytes([200, 30, 30] * 4)
    stream = pikepdf.Stream(pdf, data)
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = 2
    stream[pikepdf.Name("/Height")] = 2
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceRGB")
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    return pdf.make_indirect(stream)


def _build_sample_pdf(path: str) -> None:
    """
    PDF 1 trang: một ảnh /Img0 (mục tiêu) + một vector rect (untouched), mỗi
    object bọc cô lập `q … Q`. BBox cách xa nhau để map_object đối khớp duy nhất.
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    # Ảnh trước, vector sau (thứ tự vẽ rõ ràng).
    content = (
        "q\n"
        f"{IMG_W:.4f} 0 0 {IMG_H:.4f} {IMG_X:.4f} {IMG_Y:.4f} cm\n"
        "/Img0 Do\n"
        "Q\n"
        "q\n"
        "0.2000 0.4000 0.8000 rg\n"
        f"{RECT_X:.4f} {RECT_Y:.4f} {RECT_W:.4f} {RECT_H:.4f} re\n"
        "f\n"
        "Q\n"
    ).encode("latin-1")

    resources = pikepdf.Dictionary()
    xobjects = pikepdf.Dictionary()
    xobjects[pikepdf.Name("/Img0")] = _make_image_xobject(pdf)
    resources[pikepdf.Name("/XObject")] = xobjects
    page.obj[pikepdf.Name("/Resources")] = resources
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(content)

    pdf.save(path)
    pdf.close()


# ── Helpers ──────────────────────────────────────────────────────────────────
def _image_bbox_after(pdf_path: str) -> list[float]:
    """BBox của object ảnh duy nhất trên trang 0 của `pdf_path` (sau biến đổi)."""
    objs = geometry_reader.list_objects(pdf_path, 0)
    images = [o for o in objs if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh trên trang, nhận: {objs}"
    return list(images[0].bbox)


def _vector_bbox_matching(pdf_path: str, expected: list[float]) -> bool:
    """True nếu có vector trên trang 0 khớp `expected` trong tolerance ≤ 1.0pt."""
    objs = geometry_reader.list_objects(pdf_path, 0)
    vectors = [o for o in objs if o.type == "vector"]
    return any(bbox_within_tolerance(v.bbox, expected, TOL) for v in vectors)


def _save_via_preview_path(pdf_path: str, op: EditOp, out_path: str) -> None:
    """
    Vật chất hóa CHÍNH các BYTES mà đường preview render: mở pikepdf, áp `op` qua
    `_apply_edit_op` (giống hệt `_render_preview_blocking`), rồi `pdf.save(out)`.

    Dùng để so HÌNH HỌC của bản preview với bản LƯU (Yêu cầu 12.3).
    """
    with pikepdf.Pdf.open(pdf_path) as pdf:
        _apply_edit_op(pdf, op, pdf_path)
        pdf.save(out_path)


def _assert_preview_render_valid(pv) -> None:
    """Preview là PNG hợp lệ, kích thước khớp DPI × kích thước trang, đúng trang."""
    assert pv.success is True
    assert pv.page == 0
    assert pv.image.startswith("data:image/png;base64,")

    b64 = pv.image.split("base64,", 1)[1]
    raw = base64.b64decode(b64)
    img = Image.open(io.BytesIO(raw))
    img.load()  # PNG decode được → raster hợp lệ.
    assert img.format == "PNG"

    # Kích thước raster khớp DPI × kích thước trang (scale = DPI/72), ±2px sai số
    # làm tròn của PDFium.
    scale = PREVIEW_DPI / 72.0
    exp_w = int(round(PAGE_W * scale))
    exp_h = int(round(PAGE_H * scale))
    assert abs(pv.width - exp_w) <= 2, f"width={pv.width} != ~{exp_w}"
    assert abs(pv.height - exp_h) <= 2, f"height={pv.height} != ~{exp_h}"
    assert (img.size[0], img.size[1]) == (pv.width, pv.height)


def _run_example(tmp_path, op: EditOp, expected_img_bbox: list[float]):
    """
    Chạy một ví dụ end-to-end:
      1. Dựng PDF mẫu.
      2. PREVIEW → raster hợp lệ (12.1: PDFium render từ bytes pikepdf).
      3. LƯU qua apply_and_save → bbox ảnh sau sửa khớp KỲ VỌNG ≤ 1.0pt (12.1).
      4. Bản preview-bytes nhất quán hình học với bản lưu ≤ 1.0pt (12.3).
      5. Untouched_Object (vector) giữ nguyên vị trí.
    """
    src = os.path.join(str(tmp_path), "sample.pdf")
    _build_sample_pdf(src)

    # ── 2) PREVIEW: PDFium render READ-ONLY từ bytes pikepdf ────────────────
    pv = _render_preview_blocking(src, op)
    _assert_preview_render_valid(pv)

    # ── 3) LƯU qua pikepdf (Working_File mới) — cùng đường ghi với preview ───
    out_path, _result = apply_and_save(
        src,
        lambda pdf: _apply_edit_op(pdf, op, src),
        suffix="preview_it",
        output_path=os.path.join(str(tmp_path), "saved.pdf"),
    )
    saved_bbox = _image_bbox_after(out_path)
    assert bbox_within_tolerance(saved_bbox, expected_img_bbox, TOL), (
        f"BBox ảnh trong bản LƯU {saved_bbox} không khớp kỳ vọng "
        f"{expected_img_bbox} (tolerance ≤ {TOL}pt)"
    )

    # Untouched_Object giữ nguyên trong bản lưu.
    assert _vector_bbox_matching(out_path, RECT_BBOX), (
        "Untouched_Object (vector) đã đổi vị trí trong bản lưu"
    )

    # ── 4) Bản PREVIEW-bytes nhất quán hình học với bản LƯU (Yêu cầu 12.3) ──
    preview_bytes_path = os.path.join(str(tmp_path), "preview_bytes.pdf")
    _save_via_preview_path(src, op, preview_bytes_path)
    preview_bbox = _image_bbox_after(preview_bytes_path)
    assert bbox_within_tolerance(preview_bbox, saved_bbox, TOL), (
        f"BBox ảnh của PREVIEW {preview_bbox} không nhất quán với bản LƯU "
        f"{saved_bbox} (tolerance ≤ {TOL}pt) — vi phạm Yêu cầu 12.3"
    )

    return saved_bbox, preview_bbox


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ 1 — MOVE: vị trí object đã sửa khớp preview/bản lưu (12.1, 12.3)
# ═══════════════════════════════════════════════════════════════════════════
def test_preview_matches_save_geometry_move(tmp_path):
    dx, dy = 40.0, -25.0
    objs = geometry_reader_list_image_id(tmp_path)
    op = EditOp(
        page=0,
        kind="move",
        targetIds=[objs],
        delta=MoveDelta(dx=dx, dy=dy),
    )
    # Move trong hệ PDF (mặc định) → bbox dịch (dx, dy) mỗi tọa độ.
    expected = [IMG_BBOX[0] + dx, IMG_BBOX[1] + dy, IMG_BBOX[2] + dx, IMG_BBOX[3] + dy]
    _run_example(tmp_path, op, expected)


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ 2 — RESIZE: kích thước object đã sửa khớp preview/bản lưu (12.1, 12.3)
# ═══════════════════════════════════════════════════════════════════════════
def test_preview_matches_save_geometry_resize(tmp_path):
    sx, sy = 1.5, 0.8
    img_id = geometry_reader_list_image_id(tmp_path)
    op = EditOp(
        page=0,
        kind="resize",
        targetIds=[img_id],
        scale=ResizeScale(sx=sx, sy=sy, anchor="sw"),
    )
    # anchor='sw' (góc dưới-trái CỐ ĐỊNH) → x0/y0 giữ nguyên, cạnh xa giãn theo sx/sy.
    x0, y0, x1, y1 = IMG_BBOX
    expected = [x0, y0, x0 + (x1 - x0) * sx, y0 + (y1 - y0) * sy]
    _run_example(tmp_path, op, expected)


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ 3 — ROTATE: hướng/kích thước bbox object đã sửa khớp (12.1, 12.3)
# ═══════════════════════════════════════════════════════════════════════════
def test_preview_matches_save_geometry_rotate(tmp_path):
    deg = 90.0
    img_id = geometry_reader_list_image_id(tmp_path)
    op = EditOp(
        page=0,
        kind="rotate",
        targetIds=[img_id],
        rotateDeg=deg,
    )
    # Xoay 90° quanh tâm bbox: tâm giữ nguyên, w↔h hoán đổi.
    x0, y0, x1, y1 = IMG_BBOX
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    w, h = x1 - x0, y1 - y0
    expected = [cx - h / 2.0, cy - w / 2.0, cx + h / 2.0, cy + w / 2.0]
    _run_example(tmp_path, op, expected)


# ── Tiện ích lấy id object ảnh từ PDF mẫu (id ổn định trong một lần liệt kê) ──
def geometry_reader_list_image_id(tmp_path) -> str:
    """Dựng PDF mẫu (nếu cần) và trả id của object ảnh do Geometry_Reader gán."""
    src = os.path.join(str(tmp_path), "sample.pdf")
    if not os.path.exists(src):
        _build_sample_pdf(src)
    objs = geometry_reader.list_objects(src, 0)
    images = [o for o in objs if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh trong PDF mẫu, nhận: {objs}"
    return images[0].id
