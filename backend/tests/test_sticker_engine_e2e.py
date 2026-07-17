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


def test_process_pdf_bleed_preserves_vector_artwork(src_pdf, tmp_path):
    """Khi CÓ bleed, artwork gốc phải GIỮ NGUYÊN VECTOR (Form XObject),
    KHÔNG bị raster hoá thành ảnh JPEG.

    REGRESSION cho yêu cầu 'bảo toàn hình gốc, không tự chuyển thành ảnh'.
    Trước đây bleed_mm>0 khiến artwork bị render JPEG 300 DPI DeviceRGB (mất nét
    vector + lệch màu). Nay artwork luôn vẽ lại bằng form XObject (vector), chỉ
    vành bleed là ảnh.
    """
    out = str(tmp_path / "out_vec.pdf")
    engine = StickerEngine(dpi=300)

    success, _meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=1.0, corner_style="round", bleed_mm=2.0,
        bleed_color_type="image",
    )

    assert success is True and os.path.exists(out)
    with pikepdf.Pdf.open(out) as o:
        page = o.pages[0]
        xobjs = page.obj.get("/Resources", {}).get("/XObject", {})
        subtypes = [str(xobjs[k].get("/Subtype")) for k in xobjs.keys()]
        # Phải có ÍT NHẤT 1 Form XObject = artwork gốc giữ vector.
        assert "/Form" in subtypes, (
            f"Artwork phải là Form XObject (vector), không raster hoá. Subtypes: {subtypes}"
        )
        # Vẫn có vẽ artwork lên trang (toán tử Do trong content).
        assert b" Do" in _read_all_content(page)


@pytest.mark.parametrize("bleed_color_type", ["image", "inpaint"])
def test_sampled_bleed_stays_lossless_rgb(src_pdf, tmp_path, bleed_color_type):
    """Bleed lấy mẫu từ artwork phải giữ RGB, không giả lập CMYK với K=0.

    RGB đã là kết quả render màu của artwork. Đổi ngược bằng 255-R/G/B không thể
    phục hồi CMYK gốc và gây khác màu giữa bleed với viền tem trên RIP.
    """
    out = str(tmp_path / f"out_{bleed_color_type}.pdf")
    engine = StickerEngine(dpi=150)

    success, _meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=0.0, bleed_mm=2.0,
        bleed_color_type=bleed_color_type,
    )

    assert success is True
    with pikepdf.Pdf.open(out) as o:
        xobjs = o.pages[0].obj.get("/Resources", {}).get("/XObject", {})
        images = [xobjs[k] for k in xobjs.keys() if str(xobjs[k].get("/Subtype")) == "/Image"]
        color_images = [img for img in images if str(img.get("/ColorSpace")) != "/DeviceGray"]
        assert color_images, "Phải có image XObject cho vành bù xén"
        assert all(str(img.get("/ColorSpace")) == "/DeviceRGB" for img in color_images)
        assert all(str(img.get("/Filter")) == "/FlateDecode" for img in color_images)


def test_nearest_color_fill_propagates_and_keeps_shape():
    """_nearest_color_fill: lấp màu từ vùng có màu ra nền, giữ đúng kích thước —
    cả đường thường (f=1) lẫn đường HẠ MẪU (f>1) cho ROI lớn."""
    import numpy as np
    from app.workers.sticker_engine import _nearest_color_fill, _downscale_factor

    # Nhỏ → f=1: góc nền phải lấy đúng màu ô vuông (nearest, không nội suy).
    src = np.zeros((100, 100), np.uint8); src[40:60, 40:60] = 255
    img = np.zeros((100, 100, 3), np.uint8); img[40:60, 40:60] = (10, 20, 30)
    assert _downscale_factor(100, 100) == 1
    out = _nearest_color_fill(src, img)
    assert out.shape == img.shape
    assert tuple(int(v) for v in out[0, 0]) == (10, 20, 30)

    # Lớn → f>1 (kích hoạt hạ mẫu): vẫn giữ shape & lấp màu (khác 0) ở nền.
    big_src = np.zeros((1400, 1400), np.uint8); big_src[600:800, 600:800] = 255
    big_img = np.zeros((1400, 1400, 3), np.uint8); big_img[600:800, 600:800] = (5, 60, 7)
    assert _downscale_factor(1400, 1400) > 1
    out2 = _nearest_color_fill(big_src, big_img)
    assert out2.shape == big_img.shape
    assert int(out2[0, 0].sum()) > 0
