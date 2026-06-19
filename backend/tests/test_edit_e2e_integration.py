"""
Integration tests luồng END-TO-END (Task 12.2 — spec `pdf-object-edit`).

Mục tiêu: kiểm chứng TOÀN luồng một thao tác sửa ở MỨC HÀM (ổn định, không cần
HTTP/DB), tái dùng đúng các thành phần thật của backend:

    LIỆT KÊ        → `geometry_reader.list_objects`            (PDFium read-only)
    SỬA + LƯU      → `edit_io.apply_and_save` + `stream_editor` (pikepdf, color-safe)
    PREVIEW        → `app.api.routes.edit._render_preview_blocking` /
                     `_apply_edit_op`                          (PDFium render bytes)
    MỞ LẠI         → `geometry_reader.list_objects` /
                     `object_mapper.build_op_spans`

Khẳng định cốt lõi:
  - **Yêu cầu 10.1**: một thao tác sửa CHỈ thay đổi đúng object MỤC TIÊU; MỌI
    Untouched_Object giữ nguyên (kind + bbox + Color_Operators) qua Round_Trip.
  - **Yêu cầu 12.3**: kết quả LƯU (pikepdf) nhất quán HÌNH HỌC với bản PREVIEW
    (so listing object của bản preview-bytes với bản lưu, tolerance ≤ 1.0pt).

ĐÂY KHÔNG PHẢI property-based test — chỉ 3 ví dụ đại diện (DELETE / MOVE / ADD),
theo lưu ý phạm vi PBT trong design (render PDFium thuộc hành vi thư viện ngoài →
kiểm bằng integration test 1–3 ví dụ).

CHIẾN LƯỢC DỮ LIỆU:
  - Dựng PDF mẫu bằng pikepdf với NHIỀU object, trong đó có màu CMYK (`k`) và
    spot (`/Separation` + `scn`) để kiểm bảo toàn màu.
  - Object MỤC TIÊU = một ảnh XObject (bbox chính xác từ CTM).
  - Untouched_Object = 2 vector rect (một CMYK, một spot) đặt cách xa nhau để
    `map_object` đối khớp DUY NHẤT.
  - targetIds dùng id THẬT lấy từ `list_objects` của PDF mẫu.
"""
import base64
import io
import os
import sys
from collections import Counter

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
from app.core.object_mapper import build_op_spans, parse_page_ops
from app.schemas.edit import (
    EditOp,
    MoveDelta,
    TextPayload,
    bbox_within_tolerance,
    normalize_bbox,
)

# ── Hằng số layout trang mẫu ─────────────────────────────────────────────────
PAGE_W = 400.0
PAGE_H = 400.0
TOL = 1.0  # tolerance ≤ 1.0pt mỗi cạnh (Yêu cầu 10.1, 12.3)

# Object MỤC TIÊU: ảnh đặt qua CTM → bbox chính xác. Chọn KHÔNG vuông để move
# nhận biết rõ thay đổi vị trí.
IMG_X, IMG_Y, IMG_W, IMG_H = 50.0, 60.0, 60.0, 40.0
IMG_BBOX = [IMG_X, IMG_Y, IMG_X + IMG_W, IMG_Y + IMG_H]  # [50, 60, 110, 100]

# Untouched_Object #1: vector rect tô CMYK (`k`) — kiểm bảo toàn màu in.
CMYK_X, CMYK_Y, CMYK_W, CMYK_H = 220.0, 60.0, 50.0, 30.0
CMYK_BBOX = [CMYK_X, CMYK_Y, CMYK_X + CMYK_W, CMYK_Y + CMYK_H]
CMYK_VALS = [0.1000, 0.2000, 0.3000, 0.4000]

# Untouched_Object #2: vector rect tô màu spot (`/Sep0 cs` + `scn`).
SPOT_X, SPOT_Y, SPOT_W, SPOT_H = 220.0, 220.0, 50.0, 30.0
SPOT_BBOX = [SPOT_X, SPOT_Y, SPOT_X + SPOT_W, SPOT_Y + SPOT_H]
SPOT_TINT = 0.5000

# Operator được coi là Color_Operators (đồng bộ với PBT bảo toàn màu).
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G", "gs"}


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
    PDF 1 trang gồm 3 object, mỗi object bọc cô lập `q … Q`, bbox cách xa nhau để
    `map_object` đối khớp DUY NHẤT:
      1. ảnh /Img0 (mục tiêu)
      2. vector rect tô CMYK (untouched)
      3. vector rect tô spot (untouched)
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    content = (
        # (1) ảnh mục tiêu
        "q\n"
        f"{IMG_W:.4f} 0 0 {IMG_H:.4f} {IMG_X:.4f} {IMG_Y:.4f} cm\n"
        "/Img0 Do\n"
        "Q\n"
        # (2) vector CMYK (untouched)
        "q\n"
        f"{CMYK_VALS[0]:.4f} {CMYK_VALS[1]:.4f} {CMYK_VALS[2]:.4f} {CMYK_VALS[3]:.4f} k\n"
        f"{CMYK_X:.4f} {CMYK_Y:.4f} {CMYK_W:.4f} {CMYK_H:.4f} re\n"
        "f\n"
        "Q\n"
        # (3) vector spot (untouched)
        "q\n"
        "/Sep0 cs\n"
        f"{SPOT_TINT:.4f} scn\n"
        f"{SPOT_X:.4f} {SPOT_Y:.4f} {SPOT_W:.4f} {SPOT_H:.4f} re\n"
        "f\n"
        "Q\n"
    ).encode("latin-1")

    resources = pikepdf.Dictionary()

    # XObject ảnh.
    xobjects = pikepdf.Dictionary()
    xobjects[pikepdf.Name("/Img0")] = _make_image_xobject(pdf)
    resources[pikepdf.Name("/XObject")] = xobjects

    # Colorspace spot /Sep0 (Separation trên DeviceCMYK).
    func = pdf.make_indirect(
        pikepdf.Dictionary(
            FunctionType=2,
            Domain=pikepdf.Array([0, 1]),
            C0=pikepdf.Array([0, 0, 0, 0]),
            C1=pikepdf.Array([0, 0, 0, 1]),
            N=1,
        )
    )
    sep = pikepdf.Array(
        [
            pikepdf.Name("/Separation"),
            pikepdf.Name("/SpotColor0"),
            pikepdf.Name("/DeviceCMYK"),
            func,
        ]
    )
    cs_dict = pikepdf.Dictionary()
    cs_dict[pikepdf.Name("/Sep0")] = pdf.make_indirect(sep)
    resources[pikepdf.Name("/ColorSpace")] = cs_dict

    page.obj[pikepdf.Name("/Resources")] = resources
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(content)

    pdf.save(path)
    pdf.close()


# ── Helpers liệt kê / so khớp ────────────────────────────────────────────────
def _list_objs(pdf_path: str):
    """Liệt kê object trang 0 (PDFium read-only)."""
    return geometry_reader.list_objects(pdf_path, 0)


def _image_id(pdf_path: str) -> str:
    """id THẬT của object ảnh duy nhất trên trang 0 (id ổn định trong một lần liệt kê)."""
    images = [o for o in _list_objs(pdf_path) if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh trong PDF mẫu, nhận: {_list_objs(pdf_path)}"
    return images[0].id


def _count_by_type(pdf_path: str) -> Counter:
    """Đếm số object theo type trên trang 0."""
    c: Counter = Counter()
    for o in _list_objs(pdf_path):
        c[o.type] += 1
    return c


def _bbox_of_image(pdf_path: str) -> list[float]:
    """BBox của object ảnh duy nhất (sau biến đổi)."""
    images = [o for o in _list_objs(pdf_path) if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh, nhận: {_list_objs(pdf_path)}"
    return list(images[0].bbox)


def _vector_matches(pdf_path: str, expected: list[float]) -> bool:
    """True nếu có vector trên trang 0 khớp `expected` trong tolerance ≤ 1.0pt."""
    vectors = [o for o in _list_objs(pdf_path) if o.type == "vector"]
    return any(bbox_within_tolerance(v.bbox, expected, TOL) for v in vectors)


def _color_counter_path(pdf_path: str) -> Counter:
    """Đếm chữ ký Color_Operators trong content stream trang 0 của một file PDF."""
    counter: Counter = Counter()
    with pikepdf.Pdf.open(pdf_path) as pdf:
        page = pdf.pages[0]
        for instr in parse_page_ops(page):
            if str(instr.operator) in COLOR_OPS:
                canon = []
                for o in instr.operands:
                    try:
                        canon.append(("num", round(float(o), 4)))
                    except (TypeError, ValueError):
                        canon.append(("name", str(o)))
                counter[(str(instr.operator), tuple(canon))] += 1
    return counter


def _assert_listings_consistent(path_a: str, path_b: str) -> None:
    """
    Khẳng định hai PDF có listing object NHẤT QUÁN hình học: cùng số object mỗi
    type, và mỗi object của `path_a` khớp DUY NHẤT một object cùng type của
    `path_b` trong tolerance ≤ 1.0pt (Yêu cầu 12.3).
    """
    objs_a = _list_objs(path_a)
    objs_b = list(_list_objs(path_b))

    assert _count_by_type(path_a) == _count_by_type(path_b), (
        f"Số object theo type khác nhau giữa hai bản: "
        f"{_count_by_type(path_a)} vs {_count_by_type(path_b)}"
    )

    remaining = list(objs_b)
    for oa in objs_a:
        match_idx = next(
            (
                i
                for i, ob in enumerate(remaining)
                if ob.type == oa.type and bbox_within_tolerance(ob.bbox, oa.bbox, TOL)
            ),
            None,
        )
        assert match_idx is not None, (
            f"Object {oa.type} bbox={oa.bbox} ở bản A không có cặp khớp ở bản B "
            f"(tolerance ≤ {TOL}pt) — vi phạm nhất quán preview↔lưu (Yêu cầu 12.3)"
        )
        remaining.pop(match_idx)


def _assert_preview_render_valid(pv) -> None:
    """Preview là PNG hợp lệ, kích thước khớp DPI × kích thước trang, đúng trang."""
    assert pv.success is True
    assert pv.page == 0
    assert pv.image.startswith("data:image/png;base64,")

    raw = base64.b64decode(pv.image.split("base64,", 1)[1])
    img = Image.open(io.BytesIO(raw))
    img.load()  # PNG decode được → raster hợp lệ.
    assert img.format == "PNG"

    scale = PREVIEW_DPI / 72.0
    exp_w = int(round(PAGE_W * scale))
    exp_h = int(round(PAGE_H * scale))
    assert abs(pv.width - exp_w) <= 2, f"width={pv.width} != ~{exp_w}"
    assert abs(pv.height - exp_h) <= 2, f"height={pv.height} != ~{exp_h}"
    assert (img.size[0], img.size[1]) == (pv.width, pv.height)


def _save_via_apply_and_save(src: str, op: EditOp, out: str) -> str:
    """LƯU qua đường ghi pikepdf chính thức (apply_and_save + _apply_edit_op)."""
    out_path, _result = apply_and_save(
        src,
        lambda pdf: _apply_edit_op(pdf, op, src),
        suffix="e2e",
        output_path=out,
    )
    return out_path


def _materialize_preview_bytes(src: str, op: EditOp, out: str) -> str:
    """
    Vật chất hóa CHÍNH các BYTES mà đường preview render (`_apply_edit_op` →
    `pdf.save`) ra file, để so listing với bản lưu (Yêu cầu 12.3).
    """
    with pikepdf.Pdf.open(src) as pdf:
        _apply_edit_op(pdf, op, src)
        pdf.save(out)
    return out


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ 1 — DELETE: xóa ảnh mục tiêu, các object khác + màu giữ nguyên
# ═══════════════════════════════════════════════════════════════════════════
def test_e2e_delete_only_target_changes(tmp_path):
    """
    LIỆT KÊ → DELETE ảnh → PREVIEW (ảnh hợp lệ) → LƯU → MỞ LẠI:
      - đúng object ảnh mục tiêu biến mất;
      - 2 vector (CMYK + spot) giữ nguyên bbox;
      - Color_Operators (k, cs, scn) của Untouched_Object KHÔNG đổi;
      - bản preview-bytes nhất quán hình học với bản lưu (12.3).
    """
    src = os.path.join(str(tmp_path), "sample.pdf")
    _build_sample_pdf(src)

    # ── LIỆT KÊ: lấy id THẬT của ảnh + trạng thái ban đầu ───────────────────
    before_counts = _count_by_type(src)
    assert before_counts["image"] == 1
    assert before_counts["vector"] == 2
    img_id = _image_id(src)
    color_before = _color_counter_path(src)

    op = EditOp(page=0, kind="delete", targetIds=[img_id])

    # ── PREVIEW (PDFium render READ-ONLY từ bytes pikepdf) ──────────────────
    pv = _render_preview_blocking(src, op)
    _assert_preview_render_valid(pv)

    # ── LƯU (Working_File mới) ──────────────────────────────────────────────
    saved = _save_via_apply_and_save(src, op, os.path.join(str(tmp_path), "saved.pdf"))

    # ── MỞ LẠI: đúng ảnh mục tiêu biến mất, vector giữ nguyên ───────────────
    after_counts = _count_by_type(saved)
    assert after_counts["image"] == 0, "Ảnh mục tiêu phải biến mất sau khi xóa"
    assert after_counts["vector"] == 2, "Các vector Untouched_Object phải giữ nguyên"
    assert _vector_matches(saved, CMYK_BBOX), "Vector CMYK (untouched) đã đổi vị trí"
    assert _vector_matches(saved, SPOT_BBOX), "Vector spot (untouched) đã đổi vị trí"

    # ── Bảo toàn màu Untouched_Object (Yêu cầu 10.1 → Color_Operators) ──────
    color_after = _color_counter_path(saved)
    for sig in [
        ("k", tuple(("num", v) for v in CMYK_VALS)),
        ("cs", (("name", "/Sep0"),)),
        ("scn", (("num", SPOT_TINT),)),
    ]:
        assert color_before[sig] == 1, f"Tiền đề sai: chữ ký màu {sig} không có ở bản gốc"
        assert color_after[sig] == color_before[sig], (
            f"Color_Operators Untouched_Object đổi sau khi xóa: {sig} "
            f"trước={color_before[sig]} ≠ sau={color_after[sig]}"
        )

    # ── Preview ↔ lưu nhất quán hình học (Yêu cầu 12.3) ─────────────────────
    preview_bytes = _materialize_preview_bytes(
        src, op, os.path.join(str(tmp_path), "preview_bytes.pdf")
    )
    _assert_listings_consistent(saved, preview_bytes)


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ 2 — MOVE: dịch ảnh mục tiêu (dx, dy); object khác giữ nguyên
# ═══════════════════════════════════════════════════════════════════════════
def test_e2e_move_only_target_changes(tmp_path):
    """
    LIỆT KÊ → MOVE ảnh (dx, dy) → PREVIEW → LƯU → MỞ LẠI:
      - bbox ảnh mục tiêu = bbox cũ + (dx, dy) trong tolerance ≤ 1.0pt;
      - 2 vector giữ nguyên bbox + Color_Operators;
      - bản preview-bytes nhất quán hình học với bản lưu (12.3).
    """
    src = os.path.join(str(tmp_path), "sample.pdf")
    _build_sample_pdf(src)

    img_id = _image_id(src)
    color_before = _color_counter_path(src)

    dx, dy = 45.0, -30.0
    op = EditOp(page=0, kind="move", targetIds=[img_id], delta=MoveDelta(dx=dx, dy=dy))

    # ── PREVIEW ─────────────────────────────────────────────────────────────
    pv = _render_preview_blocking(src, op)
    _assert_preview_render_valid(pv)

    # ── LƯU ─────────────────────────────────────────────────────────────────
    saved = _save_via_apply_and_save(src, op, os.path.join(str(tmp_path), "saved.pdf"))

    # ── MỞ LẠI: bbox ảnh dịch đúng (dx, dy); object khác giữ nguyên ─────────
    expected_img = [
        IMG_BBOX[0] + dx,
        IMG_BBOX[1] + dy,
        IMG_BBOX[2] + dx,
        IMG_BBOX[3] + dy,
    ]
    moved_bbox = _bbox_of_image(saved)
    assert bbox_within_tolerance(moved_bbox, expected_img, TOL), (
        f"BBox ảnh sau move {moved_bbox} != kỳ vọng {expected_img} (tol ≤ {TOL}pt)"
    )
    assert _count_by_type(saved)["vector"] == 2
    assert _vector_matches(saved, CMYK_BBOX), "Vector CMYK (untouched) đã đổi vị trí"
    assert _vector_matches(saved, SPOT_BBOX), "Vector spot (untouched) đã đổi vị trí"

    # ── Bảo toàn màu Untouched_Object ───────────────────────────────────────
    color_after = _color_counter_path(saved)
    for sig in [
        ("k", tuple(("num", v) for v in CMYK_VALS)),
        ("cs", (("name", "/Sep0"),)),
        ("scn", (("num", SPOT_TINT),)),
    ]:
        assert color_after[sig] == color_before[sig] == 1, (
            f"Color_Operators Untouched_Object đổi sau move: {sig}"
        )

    # ── Preview ↔ lưu nhất quán hình học (Yêu cầu 12.3) ─────────────────────
    preview_bytes = _materialize_preview_bytes(
        src, op, os.path.join(str(tmp_path), "preview_bytes.pdf")
    )
    _assert_listings_consistent(saved, preview_bytes)
    # BBox ảnh của bản preview khớp bản lưu (so trực tiếp object ảnh).
    assert bbox_within_tolerance(_bbox_of_image(preview_bytes), moved_bbox, TOL)


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ 3 — ADD: thêm 1 text mới; object cũ + màu giữ nguyên (chỉ bổ sung)
# ═══════════════════════════════════════════════════════════════════════════
def test_e2e_add_text_adds_one_object_keeps_others(tmp_path):
    """
    LIỆT KÊ → ADD text → PREVIEW → LƯU → MỞ LẠI:
      - có thêm đúng 1 object text;
      - ảnh + 2 vector cũ giữ nguyên (kind + bbox);
      - Color_Operators Untouched_Object KHÔNG đổi;
      - bản preview-bytes nhất quán hình học với bản lưu (12.3).
    """
    src = os.path.join(str(tmp_path), "sample.pdf")
    _build_sample_pdf(src)

    before_counts = _count_by_type(src)
    assert before_counts["text"] == 0
    color_before = _color_counter_path(src)

    # Text ASCII → dùng font built-in Helvetica (không phụ thuộc file font ngoài).
    op = EditOp(
        page=0,
        kind="add",
        targetIds=[],
        text=TextPayload(content="PrynX", sizePt=14.0, bbox=[120.0, 320.0, 220.0, 340.0]),
    )

    # ── PREVIEW ─────────────────────────────────────────────────────────────
    pv = _render_preview_blocking(src, op)
    _assert_preview_render_valid(pv)

    # ── LƯU ─────────────────────────────────────────────────────────────────
    saved = _save_via_apply_and_save(src, op, os.path.join(str(tmp_path), "saved.pdf"))

    # ── MỞ LẠI: +1 text; ảnh + vector cũ giữ nguyên ────────────────────────
    after_counts = _count_by_type(saved)
    assert after_counts["text"] == 1, "Phải có thêm đúng 1 object text"
    assert after_counts["image"] == before_counts["image"], "Ảnh cũ phải giữ nguyên"
    assert after_counts["vector"] == before_counts["vector"], "Vector cũ phải giữ nguyên"
    assert bbox_within_tolerance(_bbox_of_image(saved), IMG_BBOX, TOL), (
        "Ảnh cũ (untouched) đã đổi vị trí sau khi thêm text"
    )
    assert _vector_matches(saved, CMYK_BBOX) and _vector_matches(saved, SPOT_BBOX)

    # ── Bảo toàn màu Untouched_Object (chỉ bổ sung, không sửa object cũ) ────
    color_after = _color_counter_path(saved)
    for sig in [
        ("k", tuple(("num", v) for v in CMYK_VALS)),
        ("cs", (("name", "/Sep0"),)),
        ("scn", (("num", SPOT_TINT),)),
    ]:
        assert color_after[sig] == color_before[sig] == 1, (
            f"Color_Operators Untouched_Object đổi sau khi thêm text: {sig}"
        )

    # ── build_op_spans mở lại được trang đã lưu (sanity Object_Mapper) ──────
    with pikepdf.Pdf.open(saved) as pdf:
        spans = build_op_spans(pdf.pages[0], pdf=pdf)
        assert any(s.kind == "image" for s in spans), "Span ảnh cũ phải còn"
        assert sum(1 for s in spans if s.kind == "vector") >= 2, "Span vector cũ phải còn"

    # ── Preview ↔ lưu nhất quán hình học (Yêu cầu 12.3) ─────────────────────
    preview_bytes = _materialize_preview_bytes(
        src, op, os.path.join(str(tmp_path), "preview_bytes.pdf")
    )
    _assert_listings_consistent(saved, preview_bytes)
