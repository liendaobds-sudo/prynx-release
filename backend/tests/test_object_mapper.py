"""
Unit tests cho Object_Mapper (app.core.object_mapper).

Phạm vi (Task 3.3 của spec `pdf-object-edit`):
- Đối khớp `ObjMeta` (PDFium / Geometry_Reader) ↔ `OpSpan` (content stream
  pikepdf) qua `map_object`, và state-machine phân đoạn `build_op_spans` /
  `segment_ops` (task 3.1) + fallback an toàn (task 3.2).

Các test case bắt buộc:
  1. Khớp DUY NHẤT cho text / image / vector.                          (Yêu cầu 1.7)
  2. q/Q lồng — CTM tích lũy / phân đoạn span đúng, không crash.       (Yêu cầu 1.4)
  3. Trả None khi đa nghĩa (2 object cùng type chồng bbox) → kích hoạt
     fallback an toàn.                                                 (Yêu cầu 4.7)

────────────────────────────────────────────────────────────────────────────
LƯU Ý QUAN TRỌNG VỀ TEXT (synthetic ObjMeta):
  Ở task 3.1, bbox của cụm text được ƯỚC LƯỢNG (~0.5em/glyph, ascent/descent
  giả định). Do đó bbox cụm text trong `OpSpan` có thể LỆCH > 1.0pt so với bbox
  chính xác mà PDFium trả về. Vì mục tiêu của task 3.3 là kiểm LOGIC đối khớp +
  state-machine (KHÔNG phải độ chính xác ước lượng bbox text), test khớp-duy-nhất
  cho TEXT KHÔNG dựa vào ObjMeta thật từ PDFium (sẽ flaky). Thay vào đó:
    - Xác nhận `build_op_spans` tạo ĐÚNG một OpSpan kind="text" cho cụm text.
    - Dựng ObjMeta SYNTHETIC với bbox = bbox của chính OpSpan đó, rồi kiểm
      `map_object` khớp đúng span — tức kiểm logic đối khớp thuần túy.
  Với IMAGE/VECTOR (bbox chính xác), test dùng ObjMeta THẬT từ geometry_reader.
────────────────────────────────────────────────────────────────────────────

PDF mẫu tạo bằng reportlab/PIL (image/text/vector) hoặc bằng pikepdf với content
stream thủ công (q/Q lồng, object chồng nhau). Đây KHÔNG phải property-based test
— chỉ các ví dụ cụ thể, xác định.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas
from PIL import Image

from app.core.geometry_reader import list_objects
from app.core.object_mapper import build_op_spans, map_object, segment_ops
from app.schemas.edit import ObjMeta, BBOX_TOLERANCE_PT

# ── Hằng số chung ───────────────────────────────────────────────────────────
PAGE_W_PT = 200.0
PAGE_H_PT = 200.0
TOLERANCE_PT = BBOX_TOLERANCE_PT  # 1.0pt

# Ảnh nhỏ đặt trên trang (hệ PDF bottom-left).
IMG_X, IMG_Y, IMG_W, IMG_H = 30.0, 60.0, 50.0, 40.0
EXPECTED_IMG_BBOX = [IMG_X, IMG_Y, IMG_X + IMG_W, IMG_Y + IMG_H]

# Rect vector đặt trên trang.
RECT_X, RECT_Y, RECT_W, RECT_H = 40.0, 50.0, 70.0, 30.0
EXPECTED_RECT_BBOX = [RECT_X, RECT_Y, RECT_X + RECT_W, RECT_Y + RECT_H]


def _bbox_within(a, b, tol=TOLERANCE_PT) -> bool:
    """True nếu hai bbox khớp nhau trong sai số tol trên TỪNG cạnh."""
    return all(abs(a[i] - b[i]) <= tol for i in range(4))


# ── Helpers tạo PDF mẫu (reportlab/PIL) ─────────────────────────────────────
def _make_image_pdf(path: str) -> None:
    """PDF 1 trang chứa DUY NHẤT một ảnh nhỏ ở vị trí xác định."""
    pil_img = Image.new("RGB", (64, 64), (220, 30, 30))
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.drawImage(ImageReader(pil_img), IMG_X, IMG_Y, width=IMG_W, height=IMG_H)
    c.showPage()
    c.save()


def _make_vector_pdf(path: str) -> None:
    """PDF 1 trang chứa một rect vector (không ảnh, không text)."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0.2, 0.4, 0.8)
    c.rect(RECT_X, RECT_Y, RECT_W, RECT_H, stroke=1, fill=1)
    c.showPage()
    c.save()


def _make_text_pdf(path: str) -> None:
    """PDF 1 trang chứa DUY NHẤT một cụm text."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.setFont("Helvetica", 12)
    c.drawString(40.0, 100.0, "Hello")
    c.showPage()
    c.save()


# ── Fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture
def image_pdf(tmp_path):
    p = os.path.join(str(tmp_path), "image_only.pdf")
    _make_image_pdf(p)
    return p


@pytest.fixture
def vector_pdf(tmp_path):
    p = os.path.join(str(tmp_path), "vector_only.pdf")
    _make_vector_pdf(p)
    return p


@pytest.fixture
def text_pdf(tmp_path):
    p = os.path.join(str(tmp_path), "text_only.pdf")
    _make_text_pdf(p)
    return p


# ═══════════════════════════════════════════════════════════════════════════
#  Case 1 — Khớp DUY NHẤT cho text / image / vector (Yêu cầu 1.7)
# ═══════════════════════════════════════════════════════════════════════════
def test_unique_match_text_via_synthetic_objmeta(text_pdf):
    """
    TEXT: vì bbox text ở task 3.1 chỉ là ƯỚC LƯỢNG (~0.5em/glyph), KHÔNG đối khớp
    với ObjMeta PDFium thật (dễ flaky). Ta kiểm LOGIC đối khớp thuần túy:
      - build_op_spans tạo ĐÚNG một OpSpan kind="text".
      - ObjMeta synthetic có bbox = bbox của span đó → map_object khớp duy nhất.
    """
    with pikepdf.open(text_pdf) as pdf:
        page = pdf.pages[0]
        spans = build_op_spans(page, pdf=pdf)

        text_spans = [s for s in spans if s.kind == "text"]
        assert len(text_spans) == 1, (
            f"Kỳ vọng đúng 1 OpSpan text cho cụm text, nhận: "
            f"{[(s.kind, s.bbox) for s in spans]}"
        )
        target = text_spans[0]

        # ObjMeta synthetic dựng từ chính span (bbox khớp tuyệt đối) → kiểm logic.
        meta = ObjMeta(
            id="text-0",
            drawIndex=0,
            type="text",
            bbox=list(target.bbox),
        )
        matched = map_object(page, meta, pdf=pdf)

        assert matched is not None, "map_object phải khớp duy nhất cho cụm text"
        assert matched.kind == "text"
        assert matched.start == target.start and matched.end == target.end


def test_unique_match_image_real_objmeta(image_pdf):
    """
    IMAGE: bbox chính xác → dùng ObjMeta THẬT từ geometry_reader (PDFium).
    map_object phải khớp duy nhất OpSpan kind="image".
    """
    metas = list_objects(image_pdf, 0)
    image_metas = [m for m in metas if m.type == "image"]
    assert len(image_metas) == 1, f"Kỳ vọng 1 ảnh từ geometry_reader: {metas}"
    img_meta = image_metas[0]

    with pikepdf.open(image_pdf) as pdf:
        page = pdf.pages[0]

        # Tiền đề: build_op_spans tạo đúng một span image.
        spans = build_op_spans(page, pdf=pdf)
        image_spans = [s for s in spans if s.kind == "image"]
        assert len(image_spans) == 1, (
            f"Kỳ vọng đúng 1 OpSpan image, nhận: {[(s.kind, s.bbox) for s in spans]}"
        )

        matched = map_object(page, img_meta, pdf=pdf)
        assert matched is not None, "map_object phải khớp duy nhất cho ảnh"
        assert matched.kind == "image"
        assert _bbox_within(matched.bbox, EXPECTED_IMG_BBOX), (
            f"BBox span ảnh {matched.bbox} không khớp vùng kỳ vọng {EXPECTED_IMG_BBOX}"
        )


def test_unique_match_vector_real_objmeta(vector_pdf):
    """
    VECTOR: bbox chính xác → dùng ObjMeta THẬT từ geometry_reader (PDFium).
    map_object phải khớp duy nhất OpSpan kind="vector" cho rect đã vẽ.
    """
    metas = list_objects(vector_pdf, 0)
    vector_metas = [m for m in metas if m.type == "vector"]
    assert vector_metas, f"Kỳ vọng ít nhất 1 vector từ geometry_reader: {metas}"

    # Chọn ObjMeta vector khớp nhất với rect kỳ vọng.
    vec_meta = min(
        vector_metas,
        key=lambda m: sum(abs(m.bbox[i] - EXPECTED_RECT_BBOX[i]) for i in range(4)),
    )

    with pikepdf.open(vector_pdf) as pdf:
        page = pdf.pages[0]
        matched = map_object(page, vec_meta, pdf=pdf)

        assert matched is not None, "map_object phải khớp duy nhất cho vector rect"
        assert matched.kind == "vector"
        assert _bbox_within(matched.bbox, vec_meta.bbox), (
            f"BBox span vector {matched.bbox} không khớp ObjMeta {vec_meta.bbox}"
        )


# ═══════════════════════════════════════════════════════════════════════════
#  Case 2 — q/Q lồng: CTM tích lũy / phân đoạn span đúng, không crash (Yêu cầu 1.4)
# ═══════════════════════════════════════════════════════════════════════════
#
# Content stream thủ công với graphics-state stack LỒNG nhau:
#   q
#     1 0 0 1 10 20 cm     % translate (10,20)
#     q
#       2 0 0 2 0 0 cm     % scale 2x  → CTM = [2,0,0,2,10,20]
#       10 10 30 30 re     % rect (10,10)-(40,40) trong không gian hiện tại
#       f
#     Q                    % CTM khôi phục về [1,0,0,1,10,20]
#   Q                      % CTM khôi phục về identity
#   5 5 10 10 re           % rect (5,5)-(15,15) ở CTM identity
#   f
#
# Kỳ vọng:
#   - Rect 1: điểm (10,10),(40,40) qua CTM [2,0,0,2,10,20] (x'=2x+10, y'=2y+20)
#     → bbox = [30, 40, 90, 100].
#   - Rect 2: ở CTM identity → bbox = [5, 5, 15, 15].
#   → CTM tích lũy đúng QUA q/Q lồng và được KHÔI PHỤC đúng sau mỗi Q.
NESTED_QQ_STREAM = (
    b"q\n"
    b"1 0 0 1 10 20 cm\n"
    b"q\n"
    b"2 0 0 2 0 0 cm\n"
    b"10 10 30 30 re\n"
    b"f\n"
    b"Q\n"
    b"Q\n"
    b"5 5 10 10 re\n"
    b"f\n"
)

EXPECTED_NESTED_BBOX = [30.0, 40.0, 90.0, 100.0]
EXPECTED_OUTER_BBOX = [5.0, 5.0, 15.0, 15.0]


@pytest.fixture
def nested_qq_pdf(tmp_path):
    """PDF 1 trang với content stream q/Q lồng (tạo bằng pikepdf)."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W_PT, PAGE_H_PT))
    page = pdf.pages[0]
    page.Contents = pdf.make_stream(NESTED_QQ_STREAM)
    p = os.path.join(str(tmp_path), "nested_qq.pdf")
    pdf.save(p)
    pdf.close()
    return p


def test_nested_qq_ctm_accumulation_and_restore(nested_qq_pdf):
    with pikepdf.open(nested_qq_pdf) as pdf:
        page = pdf.pages[0]

        # KHÔNG được crash khi quét state-machine qua q/Q lồng.
        spans = build_op_spans(page, pdf=pdf)
        vector_spans = [s for s in spans if s.kind == "vector"]

        assert len(vector_spans) == 2, (
            f"Kỳ vọng đúng 2 vector span (rect lồng + rect ngoài), nhận: "
            f"{[(s.kind, s.bbox) for s in spans]}"
        )

        inner, outer = vector_spans[0], vector_spans[1]

        # Rect trong q/Q lồng: CTM tích lũy (translate∘scale) áp đúng.
        assert _bbox_within(inner.bbox, EXPECTED_NESTED_BBOX), (
            f"BBox rect lồng {inner.bbox} ≠ kỳ vọng {EXPECTED_NESTED_BBOX} "
            f"(CTM tích lũy qua q/Q lồng sai)"
        )
        # CTM tại span lồng phải là [2,0,0,2,10,20].
        assert _bbox_within(inner.ctm[:4] + [0, 0], [2, 0, 0, 2, 0, 0]), (
            f"CTM scale của span lồng sai: {inner.ctm}"
        )
        assert abs(inner.ctm[4] - 10.0) <= 1e-6 and abs(inner.ctm[5] - 20.0) <= 1e-6

        # Rect ngoài: sau khi POP cả hai q/Q, CTM phải về identity.
        assert _bbox_within(outer.bbox, EXPECTED_OUTER_BBOX), (
            f"BBox rect ngoài {outer.bbox} ≠ kỳ vọng {EXPECTED_OUTER_BBOX} "
            f"(CTM KHÔNG được khôi phục đúng sau Q)"
        )


# ═══════════════════════════════════════════════════════════════════════════
#  Case 3 — Trả None khi đa nghĩa (2 object cùng type chồng bbox) → fallback (4.7)
# ═══════════════════════════════════════════════════════════════════════════
#
# Hai rect vector vẽ ở CÙNG vị trí → hai OpSpan vector cùng bbox. Không có cách
# phân biệt duy nhất bằng hình học → map_object phải trả None để caller HỦY thao
# tác (an toàn màu, Yêu cầu 4.7).
AMBIGUOUS_STREAM = (
    b"10 10 20 20 re\n"   # rect (10,10)-(30,30)
    b"f\n"
    b"10 10 20 20 re\n"   # rect (10,10)-(30,30) — CHỒNG bbox hoàn toàn
    b"S\n"
)
AMBIGUOUS_BBOX = [10.0, 10.0, 30.0, 30.0]


@pytest.fixture
def ambiguous_pdf(tmp_path):
    """PDF 1 trang với 2 vector cùng type CHỒNG bbox (đa nghĩa)."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W_PT, PAGE_H_PT))
    page = pdf.pages[0]
    page.Contents = pdf.make_stream(AMBIGUOUS_STREAM)
    p = os.path.join(str(tmp_path), "ambiguous.pdf")
    pdf.save(p)
    pdf.close()
    return p


def test_ambiguous_returns_none_without_drawindex(ambiguous_pdf):
    """Đa nghĩa + thiếu drawIndex để phân giải → None (fallback an toàn)."""
    with pikepdf.open(ambiguous_pdf) as pdf:
        page = pdf.pages[0]

        # Tiền đề: thực sự có 2 span vector cùng bbox.
        spans = build_op_spans(page, pdf=pdf)
        vector_spans = [s for s in spans if s.kind == "vector"]
        assert len(vector_spans) == 2, (
            f"Cần 2 vector span chồng bbox để kiểm đa nghĩa: "
            f"{[(s.kind, s.bbox) for s in spans]}"
        )
        assert _bbox_within(vector_spans[0].bbox, vector_spans[1].bbox)

        meta = ObjMeta(id="vector-x", drawIndex=0, type="vector", bbox=AMBIGUOUS_BBOX)
        # drawIndex=0 nhưng hai span chồng bbox → geometry không phân biệt được.
        assert map_object(page, meta, pdf=pdf) is None, (
            "map_object phải trả None khi 2 object cùng type chồng bbox (đa nghĩa)"
        )


def test_ambiguous_returns_none_drawindex_cannot_disambiguate(ambiguous_pdf):
    """
    Ngay cả khi drawIndex tách được ứng viên gần nhất theo thứ tự vẽ, hai span
    vẫn CHỒNG bbox (trong tolerance) → không phân biệt chắc chắn bằng hình học →
    map_object trả None (an toàn màu, Yêu cầu 4.7).
    """
    with pikepdf.open(ambiguous_pdf) as pdf:
        page = pdf.pages[0]
        meta = ObjMeta(id="vector-y", drawIndex=1, type="vector", bbox=AMBIGUOUS_BBOX)
        assert map_object(page, meta, pdf=pdf) is None


def test_segment_ops_does_not_crash_on_empty_instructions():
    """segment_ops trên danh sách rỗng → trả [] (không crash)."""
    assert segment_ops([], page=None) == []
