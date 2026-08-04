"""Bù xén LẬT GƯƠNG phải giữ gốc trang tại (0,0) để bình bản đặt tem đúng chỗ.

Bug (đo được, 2026-07-28): `PageBoxesEngine.add_mirror_bleed` chỉ nở box ra ngoài
(`MediaBox = [x0-b, y0-b, x1+b, y1+b]`) mà không dịch nội dung → gốc trang ÂM.
Tầng đặt tem giả định trang bắt đầu tại (0,0): `pdf_ops.page_rect()` trả
`Rect(0, 0, w, h)` bỏ hẳn mb[0]/mb[1], `show_pdf_page` tính tâm nguồn bằng
`clip.x0 + clip_w/2`. Hệ quả: mọi tem lệch đúng một lượng bleed mỗi trục, và vì sai
số nằm TRƯỚC ma trận xoay nên ô xoay 90/180° lệch hướng khác → lệch lung tung.

Không có test nào phủ hàm này trước đó.
"""
import os

import pikepdf
import pytest

from app.core.page_boxes import PageBoxesEngine
from app.workers.pdf_ops import Rect, show_pdf_page

PT_PER_MM = 2.834645669

TRIM_W = 200.0
TRIM_H = 100.0
BLEED_MM = 3.0
BLEED_PT = BLEED_MM * PT_PER_MM


@pytest.fixture
def src_pdf(tmp_path):
    """Trang thành phẩm 200×100pt, mảng đỏ lấp góc dưới-trái (0,0)-(100,50)."""
    path = str(tmp_path / "src.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(TRIM_W, TRIM_H))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"1 0 0 rg 0 0 100 50 re f\n"
    )
    pdf.save(path)
    pdf.close()
    return path


@pytest.fixture
def mirrored(src_pdf):
    out = PageBoxesEngine().add_mirror_bleed(src_pdf, BLEED_MM, None)
    yield out
    try:
        os.remove(out)
    except OSError:
        pass


def _boxes(path):
    with pikepdf.Pdf.open(path) as pdf:
        obj = pdf.pages[0].obj
        return {
            key: [float(v) for v in obj[key]]
            for key in ("/MediaBox", "/CropBox", "/BleedBox", "/TrimBox", "/ArtBox")
            if key in obj
        }


def _raw_content(path):
    with pikepdf.Pdf.open(path) as pdf:
        contents = pdf.pages[0].obj["/Contents"]
        if isinstance(contents, pikepdf.Array):
            return b"\n".join(bytes(s.read_bytes()) for s in contents).decode("latin-1")
        return bytes(contents.read_bytes()).decode("latin-1")


def _make_user_unit_source(path, user_unit=2.0):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(TRIM_W, TRIM_H))
    page.obj[pikepdf.Name("/UserUnit")] = user_unit
    page.obj[pikepdf.Name("/TrimBox")] = pikepdf.Array([0, 0, TRIM_W, TRIM_H])
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"1 0 0 rg 0 0 100 50 re f\n",
    )
    pdf.save(str(path))
    pdf.close()


# ------------------------------------------------------------------ hình học

def test_page_origin_is_zero(mirrored):
    boxes = _boxes(mirrored)
    assert boxes["/MediaBox"][0] == pytest.approx(0.0)
    assert boxes["/MediaBox"][1] == pytest.approx(0.0)
    assert boxes["/CropBox"][:2] == pytest.approx([0.0, 0.0])
    assert boxes["/BleedBox"][:2] == pytest.approx([0.0, 0.0])


def test_page_size_is_trim_plus_two_bleed(mirrored):
    """Khổ trang không đổi so với hành vi cũ — chỉ gốc toạ độ được chuẩn hoá."""
    mb = _boxes(mirrored)["/MediaBox"]
    assert mb[2] - mb[0] == pytest.approx(TRIM_W + 2 * BLEED_PT, abs=1e-4)
    assert mb[3] - mb[1] == pytest.approx(TRIM_H + 2 * BLEED_PT, abs=1e-4)


def test_trimbox_inset_by_bleed(mirrored):
    """TrimBox phải THỤT vào đúng bleed mỗi cạnh — bình bản tự nhận bleed từ đây."""
    tb = _boxes(mirrored)["/TrimBox"]
    assert tb == pytest.approx(
        [BLEED_PT, BLEED_PT, BLEED_PT + TRIM_W, BLEED_PT + TRIM_H], abs=1e-4
    )
    assert _boxes(mirrored)["/ArtBox"] == pytest.approx(tb, abs=1e-4)


def test_imposition_reads_bleed_from_boxes(mirrored):
    """(MediaBox.width − TrimBox.width)/2 = bleed — công thức bình bản đang dùng."""
    boxes = _boxes(mirrored)
    mb, tb = boxes["/MediaBox"], boxes["/TrimBox"]
    assert ((mb[2] - mb[0]) - (tb[2] - tb[0])) / 2 == pytest.approx(BLEED_PT, abs=1e-4)
    assert ((mb[3] - mb[1]) - (tb[3] - tb[1])) / 2 == pytest.approx(BLEED_PT, abs=1e-4)


def test_declared_bleed_uses_physical_mm_with_user_unit(tmp_path):
    source = str(tmp_path / "unit2-declared.pdf")
    _make_user_unit_source(source)
    engine = PageBoxesEngine()
    engine.output_dir = tmp_path

    output = engine.add_bleed_from_trim(source, BLEED_MM)
    with pikepdf.Pdf.open(output) as pdf:
        page = pdf.pages[0].obj
        unit = float(page["/UserUnit"])
        bleed = [float(value) for value in page["/BleedBox"]]
    assert (0.0 - bleed[0]) * unit / PT_PER_MM == pytest.approx(BLEED_MM, abs=1e-4)
    assert (bleed[2] - TRIM_W) * unit / PT_PER_MM == pytest.approx(BLEED_MM, abs=1e-4)


def test_mirror_bleed_uses_physical_mm_with_user_unit(tmp_path):
    source = str(tmp_path / "unit2-mirror.pdf")
    _make_user_unit_source(source)
    engine = PageBoxesEngine()
    engine.output_dir = tmp_path

    output = engine.add_mirror_bleed(source, BLEED_MM)
    with pikepdf.Pdf.open(output) as pdf:
        page = pdf.pages[0].obj
        unit = float(page["/UserUnit"])
        media = [float(value) for value in page["/MediaBox"]]
        trim = [float(value) for value in page["/TrimBox"]]
    assert trim[0] * unit / PT_PER_MM == pytest.approx(BLEED_MM, abs=1e-4)
    assert trim[1] * unit / PT_PER_MM == pytest.approx(BLEED_MM, abs=1e-4)
    assert (
        ((media[2] - media[0]) - (trim[2] - trim[0]))
        * unit / (2 * PT_PER_MM)
    ) == pytest.approx(BLEED_MM, abs=1e-4)
    assert (
        ((media[3] - media[1]) - (trim[3] - trim[1]))
        * unit / (2 * PT_PER_MM)
    ) == pytest.approx(BLEED_MM, abs=1e-4)


def test_content_is_translated_not_just_reboxed(mirrored):
    """Nội dung phải được DỊCH; chỉ đổi box là bug gốc."""
    raw = _raw_content(mirrored)
    assert f"1 0 0 1 {BLEED_PT:.4f} {BLEED_PT:.4f} cm" in raw
    assert "/Fmx Do" in raw
    assert "-1.000000" in raw, "phải còn ma trận phản chiếu của 4 cạnh + 4 góc"


# --------------------------------------------------- đặt tem lên tờ bình

def test_placement_puts_page_origin_at_cell_origin(mirrored):
    """Hồi quy cho lỗi khách báo: show_pdf_page phải đặt tem đúng gốc ô.

    `show_pdf_page` map toạ độ nội dung 0 → mép ô. Chỉ đúng khi gốc trang = 0;
    gốc âm làm cả tem trôi ra ngoài đúng một lượng bleed.
    """
    import re

    mb = _boxes(mirrored)["/MediaBox"]
    src_w, src_h = mb[2] - mb[0], mb[3] - mb[1]
    dest_h = 400.0
    cell_x, cell_y = 100.0, 100.0

    with pikepdf.Pdf.open(mirrored) as src:
        dest = pikepdf.Pdf.new()
        dest.add_blank_page(page_size=(600, dest_h))
        dest_page = dest.pages[0]
        cell = Rect(cell_x, cell_y, cell_x + src_w, cell_y + src_h)
        show_pdf_page(dest, dest_page, cell, src, 0)
        contents = dest_page.obj["/Contents"]
        if isinstance(contents, pikepdf.Array):
            raw = b"\n".join(bytes(s.read_bytes()) for s in contents).decode("latin-1")
        else:
            raw = bytes(contents.read_bytes()).decode("latin-1")

    found = re.findall(r"([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm", raw)
    assert found, "không tìm thấy ma trận cm"
    a, _b1, _c, d, e, f = (float(v) for v in found[-1])

    # Muốn mép trái vùng bleed nằm đúng tại cell.x0 thì e = cell.x0 − mb[0]·a.
    assert e == pytest.approx(cell_x - mb[0] * a, abs=1e-3)
    assert f == pytest.approx((dest_h - cell.y1) - mb[1] * d, abs=1e-3)


# ------------------------------------------------------- nội dung lật gương

def test_mirror_ink_fills_bleed_around_content(mirrored):
    """Dải bleed quanh mảng đỏ phải CÓ MỰC (đó là mục đích của lật gương)."""
    pdfium = pytest.importorskip("pypdfium2")

    doc = pdfium.PdfDocument(mirrored)
    try:
        img = doc[0].render(scale=2.0).to_pil().convert("RGB")
    finally:
        doc.close()

    w, h = img.size

    def is_red(px_x, px_y):
        r, g, b = img.getpixel((px_x, px_y))
        return r > 150 and g < 120 and b < 120

    # Mảng đỏ nằm ở góc dưới-trái vùng thành phẩm → sau chuẩn hoá, vùng bleed ở
    # dưới và bên trái góc đó cũng phải đỏ nhờ dải/góc phản chiếu.
    inside_x = int((BLEED_PT + 40.0) / (TRIM_W + 2 * BLEED_PT) * w)
    bleed_band_y = h - int((BLEED_PT * 0.4) / (TRIM_H + 2 * BLEED_PT) * h) - 1
    assert is_red(inside_x, bleed_band_y), "dải bleed dưới phải có mực phản chiếu"

    inside_y = h - int((BLEED_PT + 25.0) / (TRIM_H + 2 * BLEED_PT) * h) - 1
    bleed_band_x = int((BLEED_PT * 0.4) / (TRIM_W + 2 * BLEED_PT) * w)
    assert is_red(bleed_band_x, inside_y), "dải bleed trái phải có mực phản chiếu"

    # Góc trên-phải nằm ngoài mảng đỏ → phải là giấy trắng (không tô tràn cả trang).
    assert not is_red(w - 3, 2), "không được tô tràn ra vùng không có nội dung"


def test_render_does_not_recurse(mirrored):
    """Form snapshot phải tách khỏi page.Contents — nếu không pdfium treo."""
    pdfium = pytest.importorskip("pypdfium2")
    doc = pdfium.PdfDocument(mirrored)
    try:
        assert doc[0].render(scale=0.5) is not None
    finally:
        doc.close()


@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_rotated_page_mirror_fills_bleed_instead_of_only_expanding_box(tmp_path, rotate):
    """RESIZE (audit 2026-07-31 §A.1): trang xoay phải có mực ở vùng mirror.

    Hồi quy cũ chỉ nới MediaBox/CropBox rồi tiếp tục nên dải vừa nới là giấy
    trắng. Dùng nền đỏ kín trang để bốn cạnh sau mirror đều phải còn đỏ.
    """
    pdfium = pytest.importorskip("pypdfium2")
    src = str(tmp_path / f"rotated_{rotate}.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(TRIM_W, TRIM_H))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        f"1 0 0 rg 0 0 {TRIM_W} {TRIM_H} re f\n".encode("ascii")
    )
    page.obj[pikepdf.Name("/Rotate")] = rotate
    pdf.save(src)
    pdf.close()

    out = PageBoxesEngine().add_mirror_bleed(src, BLEED_MM, None)
    try:
        with pikepdf.Pdf.open(out) as result:
            assert int(result.pages[0].get("/Rotate", 0) or 0) == 0

        doc = pdfium.PdfDocument(out)
        try:
            image = doc[0].render(scale=2.0).to_pil().convert("RGB")
        finally:
            doc.close()

        width, height = image.size
        samples = (
            image.getpixel((1, height // 2)),
            image.getpixel((width - 2, height // 2)),
            image.getpixel((width // 2, 1)),
            image.getpixel((width // 2, height - 2)),
        )
        assert all(r > 180 and g < 80 and b < 80 for r, g, b in samples)
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


# ------------------------------------------------------------- ca biên

def test_zero_bleed_keeps_page(src_pdf):
    """bleed = 0 → nhánh fallback, không sinh khổ trang lạ, không crash."""
    out = PageBoxesEngine().add_mirror_bleed(src_pdf, 0.0, None)
    try:
        mb = _boxes(out)["/MediaBox"]
        assert mb[2] - mb[0] == pytest.approx(TRIM_W, abs=1e-4)
        assert mb[3] - mb[1] == pytest.approx(TRIM_H, abs=1e-4)
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_zero_bleed_preserves_rotated_page_without_rewriting(tmp_path, rotate):
    """RESIZE (audit 2026-07-31 §A.1): bleed 0 không được bake trang xoay."""
    src = str(tmp_path / f"zero_bleed_rotated_{rotate}.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(TRIM_W, TRIM_H))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"0 0 1 rg 10 20 30 40 re f\n"
    )
    page.obj[pikepdf.Name("/Rotate")] = rotate
    pdf.save(src)
    pdf.close()

    original_content = _raw_content(src)
    original_media_box = _boxes(src)["/MediaBox"]
    out = PageBoxesEngine().add_mirror_bleed(src, 0.0, None)
    try:
        with pikepdf.Pdf.open(out) as result:
            assert int(result.pages[0].get("/Rotate", 0) or 0) == rotate
        assert _raw_content(out) == original_content
        assert _boxes(out)["/MediaBox"] == pytest.approx(original_media_box)
    finally:
        try:
            os.remove(out)
        except OSError:
            pass
