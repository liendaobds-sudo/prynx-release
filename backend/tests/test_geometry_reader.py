"""
Unit tests cho Geometry_Reader (app.core.geometry_reader.list_objects).

Phạm vi (Task 2.2 của spec `pdf-object-edit`):
- list_objects đọc hình học bằng PDFium (read-only) và trả về list[ObjMeta]
  với type ∈ {text, image, vector} cùng BBox chính xác theo hệ PDF
  (gốc bottom-left): [x0=left, y0=bottom, x1=right, y1=top].

Các test case bắt buộc:
  1. BBox ảnh bao ĐÚNG vùng ảnh (không phải cả trang) — tolerance ≤ 1.0pt.   (Yêu cầu 1.2)
  2. Liệt kê vector với type="vector" (PDFium PATH).                          (Yêu cầu 1.3)
  3. Danh sách rỗng khi trang rỗng / thiếu loại object — không phát sinh lỗi. (Yêu cầu 1.5)
  4. Tolerance ≤ 1.0pt cho sai lệch BBox mỗi cạnh.                            (Yêu cầu 1.7)

PDF mẫu được tạo bằng reportlab (đã có sẵn trong venv) ở chế độ tối thiểu.
Đây KHÔNG phải property-based test — chỉ các ví dụ cụ thể, xác định.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas
from PIL import Image

from app.core.geometry_reader import list_objects
from app.schemas.edit import ObjMeta

# ── Hằng số chung ───────────────────────────────────────────────────────────
PAGE_W_PT = 200.0
PAGE_H_PT = 200.0

# Tolerance khớp BBox mỗi cạnh giữa PDFium và giá trị mong đợi (Yêu cầu 1.7).
TOLERANCE_PT = 1.0

# Vị trí + kích thước ảnh nhỏ đặt trên trang (hệ PDF bottom-left).
IMG_X = 30.0
IMG_Y = 60.0
IMG_W = 50.0
IMG_H = 40.0
# BBox kỳ vọng của ảnh: [x0, y0, x1, y1].
EXPECTED_IMG_BBOX = [IMG_X, IMG_Y, IMG_X + IMG_W, IMG_Y + IMG_H]

# Vị trí + kích thước rect vector đặt trên trang.
RECT_X = 40.0
RECT_Y = 50.0
RECT_W = 70.0
RECT_H = 30.0
EXPECTED_RECT_BBOX = [RECT_X, RECT_Y, RECT_X + RECT_W, RECT_Y + RECT_H]


# ── Helpers tạo PDF mẫu ─────────────────────────────────────────────────────
def _make_image_pdf(path: str) -> None:
    """Tạo PDF 1 trang chứa DUY NHẤT một ảnh nhỏ ở vị trí xác định."""
    # Ảnh 64x64 đặc màu đỏ, tạo trong bộ nhớ rồi nhúng qua ImageReader.
    pil_img = Image.new("RGB", (64, 64), (220, 30, 30))
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.drawImage(ImageReader(pil_img), IMG_X, IMG_Y, width=IMG_W, height=IMG_H)
    c.showPage()
    c.save()


def _make_vector_pdf(path: str) -> None:
    """Tạo PDF 1 trang chứa một path/rect vector (không ảnh, không text)."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0.2, 0.4, 0.8)
    c.rect(RECT_X, RECT_Y, RECT_W, RECT_H, stroke=1, fill=1)
    c.showPage()
    c.save()


def _make_empty_pdf(path: str) -> None:
    """Tạo PDF 1 trang HOÀN TOÀN rỗng (không vẽ object nào)."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
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
def empty_pdf(tmp_path):
    p = os.path.join(str(tmp_path), "empty.pdf")
    _make_empty_pdf(p)
    return p


def _bbox_edges_within(a, b, tol=TOLERANCE_PT) -> bool:
    """True nếu hai bbox khớp nhau trong sai số tol trên TỪNG cạnh."""
    return all(abs(a[i] - b[i]) <= tol for i in range(4))


# ═══════════════════════════════════════════════════════════════════════════
#  Case 1 — BBox ảnh bao đúng vùng ảnh (KHÔNG phải cả trang) — Yêu cầu 1.2
# ═══════════════════════════════════════════════════════════════════════════
def test_image_bbox_matches_image_region_not_full_page(image_pdf):
    objs = list_objects(image_pdf, 0)

    images = [o for o in objs if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh, nhận được: {objs}"

    img = images[0]
    assert isinstance(img, ObjMeta)

    # BBox phải bao đúng vùng ảnh, khớp giá trị kỳ vọng trong tolerance.
    assert _bbox_edges_within(img.bbox, EXPECTED_IMG_BBOX), (
        f"BBox ảnh {img.bbox} không khớp vùng ảnh kỳ vọng {EXPECTED_IMG_BBOX}"
    )

    # BBox KHÔNG được bằng cả trang: chiều rộng/cao phải nhỏ hơn rõ rệt.
    width = img.bbox[2] - img.bbox[0]
    height = img.bbox[3] - img.bbox[1]
    assert width < PAGE_W_PT, "BBox ảnh không được rộng bằng cả trang"
    assert height < PAGE_H_PT, "BBox ảnh không được cao bằng cả trang"
    assert abs(width - IMG_W) <= TOLERANCE_PT
    assert abs(height - IMG_H) <= TOLERANCE_PT


# ═══════════════════════════════════════════════════════════════════════════
#  Case 2 — Liệt kê vector với type="vector" (PDFium PATH) — Yêu cầu 1.3
# ═══════════════════════════════════════════════════════════════════════════
def test_vector_listed_with_type_vector(vector_pdf):
    objs = list_objects(vector_pdf, 0)

    vectors = [o for o in objs if o.type == "vector"]
    assert len(vectors) >= 1, f"Kỳ vọng ít nhất 1 vector, nhận được: {objs}"

    # Có một vector khớp vùng rect đã vẽ (trong tolerance).
    assert any(
        _bbox_edges_within(v.bbox, EXPECTED_RECT_BBOX) for v in vectors
    ), f"Không tìm thấy vector khớp rect kỳ vọng {EXPECTED_RECT_BBOX}: {[v.bbox for v in vectors]}"

    # Không có object nào bị phân loại nhầm thành image cho PDF chỉ-vector.
    assert all(o.type != "image" for o in objs)


# ═══════════════════════════════════════════════════════════════════════════
#  Case 3 — Danh sách rỗng khi trang rỗng / thiếu loại — Yêu cầu 1.5
# ═══════════════════════════════════════════════════════════════════════════
def test_empty_page_returns_empty_list_without_error(empty_pdf):
    # Không được phát sinh lỗi với trang rỗng.
    objs = list_objects(empty_pdf, 0)
    assert objs == [], f"Trang rỗng phải trả danh sách rỗng, nhận được: {objs}"


def test_vector_pdf_has_no_image_objects(vector_pdf):
    # Thiếu loại 'image' → không có ObjMeta type=image, không lỗi.
    objs = list_objects(vector_pdf, 0)
    assert [o for o in objs if o.type == "image"] == []


# ═══════════════════════════════════════════════════════════════════════════
#  Case 4 — Tolerance ≤ 1.0pt cho sai lệch BBox mỗi cạnh — Yêu cầu 1.7
# ═══════════════════════════════════════════════════════════════════════════
def test_image_bbox_within_one_point_tolerance(image_pdf):
    objs = list_objects(image_pdf, 0)
    images = [o for o in objs if o.type == "image"]
    assert len(images) == 1

    bbox = images[0].bbox
    for idx, edge_name in enumerate(["x0", "y0", "x1", "y1"]):
        delta = abs(bbox[idx] - EXPECTED_IMG_BBOX[idx])
        assert delta <= TOLERANCE_PT, (
            f"Sai lệch cạnh {edge_name} = {delta:.4f}pt vượt tolerance "
            f"{TOLERANCE_PT}pt (kết quả={bbox[idx]}, kỳ vọng={EXPECTED_IMG_BBOX[idx]})"
        )


def test_vector_bbox_within_one_point_tolerance(vector_pdf):
    objs = list_objects(vector_pdf, 0)
    vectors = [o for o in objs if o.type == "vector"]
    assert vectors, "Cần ít nhất một vector để kiểm tolerance"

    # Chọn vector khớp nhất với rect kỳ vọng để kiểm sai lệch từng cạnh.
    best = min(
        vectors,
        key=lambda v: sum(abs(v.bbox[i] - EXPECTED_RECT_BBOX[i]) for i in range(4)),
    )
    for idx, edge_name in enumerate(["x0", "y0", "x1", "y1"]):
        delta = abs(best.bbox[idx] - EXPECTED_RECT_BBOX[idx])
        assert delta <= TOLERANCE_PT, (
            f"Sai lệch cạnh {edge_name} = {delta:.4f}pt vượt tolerance {TOLERANCE_PT}pt "
            f"(kết quả={best.bbox[idx]}, kỳ vọng={EXPECTED_RECT_BBOX[idx]})"
        )
