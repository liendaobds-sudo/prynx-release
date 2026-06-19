"""
End-to-end tests cho StickerEngine.process_pdf — tính năng "Tạo viền bế (Cutline)".

Khác với test_cutline_contour.py (chỉ test hàm hình học thuần), file này chạy
TOÀN BỘ đường dẫn engine: rasterize → tìm contour → buffer offset/bleed →
xuất PDF có spot color CutContour + TrimBox.

Mục đích chính: chặn các lỗi tích hợp toàn-luồng (vd `NameError: settings`
ở bước "Save Output PDF") mà unit test hình học không thể phát hiện.

Cần deps nặng (cv2, pypdfium2, pikepdf, shapely, skimage) → đánh dấu để có thể
bỏ qua khi môi trường thiếu, nhưng KHÔNG nuốt lỗi crash thật.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pikepdf = pytest.importorskip("pikepdf")
pytest.importorskip("cv2")
pytest.importorskip("pypdfium2")
pytest.importorskip("shapely")
pytest.importorskip("skimage")

from app.workers.sticker_engine import StickerEngine


def _make_simple_pdf(path: str) -> None:
    """Tạo 1 trang ~105x148mm: nền trắng + 1 hình chữ nhật đen ở giữa."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(297.6, 419.5))
    content = (
        b"1 1 1 rg 0 0 297.6 419.5 re f\n"   # nền trắng
        b"0 0 0 rg 80 120 140 180 re f\n"     # khối đen
    )
    page.Contents = pdf.make_stream(content)
    pdf.save(path)


def _read_all_content(page) -> bytes:
    raw = page.obj.get("/Contents")
    if isinstance(raw, pikepdf.Array):
        return b"\n".join(bytes(s.read_bytes()) for s in raw)
    return bytes(page.Contents.read_bytes())


@pytest.fixture()
def src_pdf(tmp_path):
    p = tmp_path / "src.pdf"
    _make_simple_pdf(str(p))
    return str(p)


def test_process_pdf_original_round_succeeds(src_pdf, tmp_path):
    """Ca cơ bản: cắt theo hình gốc, góc tròn, offset dương.

    Đây là REGRESSION TEST cho lỗi crash ở bước 'Save Output PDF'
    (`NameError: name 'settings' is not defined`) khiến tính năng luôn trả 500.
    """
    out = str(tmp_path / "out.pdf")
    engine = StickerEngine(dpi=300)

    success, meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=1.0, corner_style="round", bleed_mm=0.0,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    assert meta.get("width_mm", 0) > 0 and meta.get("height_mm", 0) > 0
    assert "pages" in meta

    with pikepdf.Pdf.open(out) as o:
        page = o.pages[0]
        cs = page.obj.get("/Resources", {}).get("/ColorSpace", {})
        assert "/CutContour" in cs, "Phải đăng ký spot color CutContour"
        assert b"/CutContour CS" in _read_all_content(page), "Phải vẽ đường cắt CutContour"
        assert "/TrimBox" in page.obj, "Phải gắn TrimBox theo viền cắt"


@pytest.mark.parametrize(
    "corner_style,offset_mm,bleed_mm,bleed_color_type",
    [
        ("round", 1.0, 0.0, "image"),
        ("miter", -0.5, 2.0, "image"),
        ("round", 0.0, 2.0, "inpaint"),
    ],
)
def test_process_pdf_modes_succeed(src_pdf, tmp_path, corner_style, offset_mm, bleed_mm, bleed_color_type):
    """Nhiều tổ hợp tham số đều phải xuất file hợp lệ, không crash."""
    out = str(tmp_path / "out.pdf")
    engine = StickerEngine(dpi=300)

    success, meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=offset_mm, corner_style=corner_style,
        bleed_mm=bleed_mm, bleed_color_type=bleed_color_type,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    with pikepdf.Pdf.open(out) as o:
        assert b"/CutContour CS" in _read_all_content(o.pages[0])


def test_process_pdf_none_mode_no_cutline(src_pdf, tmp_path):
    """cut_mode='none' + draw_cut_contour=False: chỉ tràn màu, KHÔNG vẽ đường cắt."""
    out = str(tmp_path / "out.pdf")
    engine = StickerEngine(dpi=300)

    success, meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="none", offset_mm=0.0, bleed_mm=2.0,
        bleed_color_type="solid", solid_bleed_color=(255, 0, 0, 0),
        draw_cut_contour=False,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    with pikepdf.Pdf.open(out) as o:
        assert b"/CutContour CS" not in _read_all_content(o.pages[0])
