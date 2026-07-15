"""Test smart resize + downsample (spec: resize A1→A5 phải GIẢM dung lượng).

Nền tảng: resize kiểu XObject giữ nguyên độ phân giải ảnh → file không nhỏ đi.
resize_pages_smart bổ sung downsample theo khổ mới. Test kiểm:
  - Logic chọn mode 'auto' (thuần hàm).
  - Nhận diện text-font / ảnh non-RGB.
  - Geometry đúng khổ A5 (khi target_dpi=0 → hành vi cũ).
  - Vector downsample THỰC SỰ làm file nhỏ đi (guard theo Ghostscript).
  - Raster resize ra đúng khổ A5 và nhỏ.
"""
import os
import io
import numpy as np
import pikepdf
import pytest

from app.workers.pdf_tools_engine import (
    resize_pages_smart,
    _choose_auto_mode,
    _doc_has_text_fonts,
    _doc_has_non_rgb_images,
)

MM_TO_PTS = 2.83465
A1 = (594.0, 841.0)   # mm
A5 = (148.0, 210.0)   # mm


def _a1_text_pdf(path: str, pages: int = 2):
    """PDF khổ A1 có TEXT (embed /Font) — để test nhận diện text + đường vector."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.units import mm
    c = canvas.Canvas(path, pagesize=(A1[0] * mm, A1[1] * mm))
    for i in range(pages):
        c.setFont("Helvetica", 48)
        c.drawString(100 * mm, 400 * mm, f"Trang {i + 1} — noi dung van ban")
        c.showPage()
    c.save()


def _a1_image_pdf(path: str, pages: int = 1, px=(2200, 3100)):
    """PDF THUẦN ẢNH khổ ~A1 (ảnh nhiễu độ phân giải cao, không nén được) — mô
    phỏng poster nặng. Dùng PIL nên trang KHÔNG có /Font (khác reportlab luôn
    đính font). ``resolution`` đặt sao cho trang xấp xỉ khổ A1."""
    from PIL import Image
    rng = np.random.default_rng(42)
    imgs = []
    # resolution để trang ≈ A1: dpi = px_w / (A1_w_mm / 25.4)
    res = px[0] / (A1[0] / 25.4)
    for _ in range(pages):
        arr = rng.integers(0, 256, size=(px[1], px[0], 3), dtype=np.uint8)
        imgs.append(Image.fromarray(arr, "RGB"))
    imgs[0].save(path, format="PDF", save_all=True, append_images=imgs[1:], resolution=res)


def _page_sizes_mm(path: str):
    out = []
    with pikepdf.Pdf.open(path) as pdf:
        for pg in pdf.pages:
            mb = pg.MediaBox
            w = float(mb[2]) - float(mb[0])
            h = float(mb[3]) - float(mb[1])
            out.append((round(w / MM_TO_PTS), round(h / MM_TO_PTS)))
    return out


def _gs_available() -> bool:
    from app.config import settings
    p = getattr(settings, "GHOSTSCRIPT_PATH", None)
    return bool(p and os.path.isfile(p))


# ── Logic chọn mode (thuần hàm) ──────────────────────────────────────────────

def test_choose_auto_mode_table():
    # Raster CHỈ khi: all + không text + không ảnh non-RGB.
    assert _choose_auto_mode("all", has_text=False, has_non_rgb_images=False) == "raster"
    # Có text → giữ vector (không mất chữ).
    assert _choose_auto_mode("all", has_text=True, has_non_rgb_images=False) == "vector"
    # Có ảnh CMYK/ICC → giữ vector (không phá tách kênh in).
    assert _choose_auto_mode("all", has_text=False, has_non_rgb_images=True) == "vector"
    # Chỉ áp một phần trang → vector.
    assert _choose_auto_mode("1-3", has_text=False, has_non_rgb_images=False) == "vector"


# ── Nhận diện nội dung ───────────────────────────────────────────────────────

def test_detect_text_fonts(tmp_path):
    text_pdf = str(tmp_path / "text.pdf")
    _a1_text_pdf(text_pdf, pages=1)
    assert _doc_has_text_fonts(text_pdf) is True

    img_pdf = str(tmp_path / "img.pdf")
    _a1_image_pdf(img_pdf, pages=1)
    assert _doc_has_text_fonts(img_pdf) is False


# ── Geometry: target_dpi=0 → chỉ đổi khổ (hành vi cũ), giữ số trang ──────────

def test_geometry_only_no_downsample(tmp_path):
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _a1_text_pdf(src, pages=3)
    resize_pages_smart(src, out, A5[0], A5[1], "fit", "all", target_dpi=0, mode="auto")
    sizes = _page_sizes_mm(out)
    assert len(sizes) == 3
    assert all(w == 148 and h == 210 for (w, h) in sizes), sizes


def test_xobject_mode_ignores_dpi(tmp_path):
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _a1_text_pdf(src, pages=1)
    # mode='xobject' → bỏ qua downsample dù target_dpi>0.
    resize_pages_smart(src, out, A5[0], A5[1], "fit", "all", target_dpi=150, mode="xobject")
    assert _page_sizes_mm(out) == [(148, 210)]


# ── Raster: ra đúng A5, nhỏ ─────────────────────────────────────────────────

def test_raster_resize_shrinks_and_a5(tmp_path):
    src = str(tmp_path / "poster.pdf")
    out = str(tmp_path / "out.pdf")
    _a1_image_pdf(src, pages=1)
    src_size = os.path.getsize(src)
    resize_pages_smart(src, out, A5[0], A5[1], "fit", "all", target_dpi=150, mode="raster")
    sizes = _page_sizes_mm(out)
    assert len(sizes) == 1
    # PIL PDF làm tròn khổ theo DPI; cho dung sai ±2mm.
    w, h = sizes[0]
    assert abs(w - 148) <= 2 and abs(h - 210) <= 2, sizes
    assert os.path.getsize(out) < src_size, (os.path.getsize(out), src_size)


# ── Vector (Ghostscript) downsample: giữ khổ A5 + nhỏ hơn ───────────────────

def _bleed_pdf(path: str):
    """PDF MediaBox 200x200, nội dung ĐỎ phủ TOÀN media, CropBox nhỏ hơn
    ([20,20,180,180]) → vùng bleed = viền 20pt ngoài crop."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Contents = pdf.make_stream(b"1 0 0 rg 0 0 200 200 re f")
    page.MediaBox = [0, 0, 200, 200]
    page.CropBox = [20, 20, 180, 180]
    pdf.save(path)


def _corner_rgb(path: str):
    """Màu pixel gần góc trên-trái sau khi raster hoá (đo bleed còn hay mất)."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(path)
    try:
        img = pdf[0].render(scale=1.0).to_pil().convert("RGB")
        return list(np.array(img)[2, 2])
    finally:
        pdf.close()


def test_resize_preserves_bleed(tmp_path):
    """Regression: resize KHÔNG được làm mất bleed. as_form_xobject() lấy BBox theo
    CropBox → nội dung ngoài CropBox (bleed) bị clip thành TRẮNG. Fix: ép
    CropBox=MediaBox. Đo bằng raster: góc phải còn ĐỎ (không trắng)."""
    src = str(tmp_path / "bleed.pdf")
    out = str(tmp_path / "resized.pdf")
    _bleed_pdf(src)
    # target vuông cùng tỉ lệ (fit lấp đầy) → mọi pixel trắng ở biên = mất bleed.
    resize_pages_smart(src, out, 100 * 25.4 / 72, 100 * 25.4 / 72, "fit", "all", target_dpi=0)
    r, g, b = _corner_rgb(out)
    assert r > 200 and g < 60 and b < 60, f"góc {(r, g, b)} không đỏ → bleed bị mất"


def test_resize_preserves_trimbox(tmp_path):
    """Regression (bù xén→resize mất bleed): dieline tạo TrimBox đánh dấu vùng bleed;
    resize KHÔNG được vứt nó. Output phải còn TrimBox (đã scale) và Trim < Media
    (còn vành bleed)."""
    src = str(tmp_path / "diel.pdf")
    out = str(tmp_path / "resized.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(600.9, 853.2))
    page.Contents = pdf.make_stream(b"1 0 0 rg 0 0 600.9 853.2 re f")  # đỏ phủ kín (bleed)
    page.MediaBox = [0, 0, 600.9, 853.2]
    page[pikepdf.Name("/TrimBox")] = pikepdf.Array([5.7, 5.7, 595.3, 847.6])
    pdf.save(src)

    resize_pages_smart(src, out, 210.0, 297.0, "fill", "all", target_dpi=0)
    with pikepdf.open(out) as p:
        pg = p.pages[0]
        tb = pg.get("/TrimBox")
        assert tb is not None, "TrimBox bị mất sau resize → in cắt mất bleed"
        mb = pg.MediaBox
        trim_w = float(tb[2]) - float(tb[0])
        media_w = float(mb[2]) - float(mb[0])
        # TrimBox phải NHỎ HƠN MediaBox (còn vành bleed) nhưng không suy biến.
        assert trim_w < media_w, "TrimBox phải nhỏ hơn MediaBox (còn vành bleed)"
        assert trim_w > media_w * 0.9, "TrimBox không được teo bất thường"
    # Nội dung bleed (đỏ) vẫn phủ gần kín trang (fill) — không bị mất thành trắng.
    import pypdfium2 as pdfium
    _pdf = pdfium.PdfDocument(out)
    try:
        _a = np.array(_pdf[0].render(scale=1.0).to_pil().convert("RGB")).astype(int)
    finally:
        _pdf.close()
    red_frac = ((_a[..., 0] > 180) & (_a[..., 1] < 80) & (_a[..., 2] < 80)).mean()
    assert red_frac > 0.9, f"đỏ chỉ {red_frac:.0%} — bleed bị mất thành trắng"


def test_resize_preserves_bleed_ring(tmp_path):
    """Regression (bug thật): resize KHÔNG được clip vùng NGOÀI TrimBox. pikepdf
    as_form_xobject() lấy BBox theo box nhỏ nhất (TrimBox) → clip mất vành bleed
    → sau resize bleed thành TRẮNG. Dựng file như output bù xén (bleed ĐỎ quanh,
    ruột XANH trong trim), resize, đo VÀNH bleed phải còn ĐỎ (không trắng)."""
    import pypdfium2 as pdfium
    src = str(tmp_path / "diel.pdf")
    out = str(tmp_path / "resized.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(600.9, 853.2))
    # đỏ phủ toàn media (=bleed) + xanh phủ vùng trim (=nội dung)
    page.Contents = pdf.make_stream(
        b"1 0 0 rg 0 0 600.9 853.2 re f\n0 1 0 rg 5.7 5.7 589.6 841.9 re f"
    )
    page.MediaBox = [0, 0, 600.9, 853.2]
    page[pikepdf.Name("/TrimBox")] = pikepdf.Array([5.7, 5.7, 595.3, 847.6])
    pdf.save(src)

    resize_pages_smart(src, out, 210.0, 297.0, "fill", "all", target_dpi=0)

    with pikepdf.open(out) as p:
        pg = p.pages[0]
        mb = [float(x) for x in pg.MediaBox]
        tb = [float(x) for x in pg.get("/TrimBox")]
    d = pdfium.PdfDocument(out)
    try:
        img = np.array(d[0].render(scale=1.0).to_pil().convert("RGB"))
    finally:
        d.close()
    h, w = img.shape[:2]
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]

    def px(xpt, ypt):
        x = int((xpt - mb[0]) / mw * w)
        y = int((mb[3] - ypt) / mh * h)
        return img[max(0, min(h - 1, y)), max(0, min(w - 1, x))]

    ymid = (tb[1] + tb[3]) / 2
    ring_r = px((tb[2] + mb[2]) / 2, ymid)      # vành bleed phải
    ring_l = px((mb[0] + tb[0]) / 2, ymid)      # vành bleed trái
    for name, c in (("phải", ring_r), ("trái", ring_l)):
        assert c[0] > 180 and c[1] < 80 and c[2] < 80, f"vành bleed {name}={c.tolist()} bị trắng (mất bleed)"


def test_save_pdf_compat_no_object_streams(tmp_path):
    """save_pdf_compat phải xuất XREF CỔ ĐIỂN (không object stream) để pdf-lib đọc
    được — đây là gốc rễ lỗi 'Invalid header in flate stream'."""
    from app.workers.pdf_tools_engine import save_pdf_compat
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "compat.pdf")
    _a1_text_pdf(src, pages=2)
    with pikepdf.open(src) as pdf:
        save_pdf_compat(pdf, out)
    data = open(out, "rb").read()
    assert b"/ObjStm" not in data, "vẫn còn object stream → pdf-lib có thể không đọc được"
    assert b"xref" in data, "thiếu bảng xref cổ điển"


def test_trim_shift_output_pdflib_compatible(tmp_path):
    """Output bù xén (trim_shift) không được chứa object stream — chính là ca lỗi
    người dùng gặp: bù xén xong resize lại (frontend pdf-lib) bị flate error."""
    from app.workers.trim_shift_engine import trim_shift
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "trim.pdf")
    _a1_text_pdf(src, pages=2)
    trim_shift(src, out, apply_to="all", trim_top_mm=5, trim_bottom_mm=0,
               trim_left_mm=0, trim_right_mm=0, shift_x_mm=2, shift_y_mm=0)
    data = open(out, "rb").read()
    assert b"/ObjStm" not in data
    assert b"xref" in data


@pytest.mark.skipif(not _gs_available(), reason="Ghostscript không có sẵn")
def test_vector_downsample_shrinks(tmp_path):
    src = str(tmp_path / "poster.pdf")
    out = str(tmp_path / "out.pdf")
    _a1_image_pdf(src, pages=1)
    src_size = os.path.getsize(src)
    resize_pages_smart(src, out, A5[0], A5[1], "fit", "all", target_dpi=150, mode="vector")
    sizes = _page_sizes_mm(out)
    assert sizes == [(148, 210)], sizes
    # Ảnh A1 nhiễu độ phân giải cao đặt trên A5 → downsample 150 DPI phải nhỏ hơn hẳn.
    assert os.path.getsize(out) < src_size, (os.path.getsize(out), src_size)


# ══ scale_mode parity: stretch & center_no_scale (regression bug "ép bóp méo cắt") ══
#
# Bug gốc: backend chỉ có fit + else(=fill). stretch & center_no_scale rơi vào fill
# → phóng to giữ tỉ lệ + CẮT phần thừa. Các test dưới chứng minh hành vi ĐÚNG bằng
# cách đo pixel, và sẽ ĐỎ nếu ai đó vô tình đưa 2 mode này về fill lần nữa.
#
# Fixture: khổ vuông nền ĐỎ + 4 ô vuông XANH LÁ ở 4 góc (mỗi ô = 20% cạnh). Marker góc
# là "kim chỉ nam": stretch/fit giữ trọn nội dung → 4 góc output còn xanh; fill CẮT
# 2 mép theo trục dài → góc mất xanh.

_GREEN_FRAC = 0.20  # ô góc = 20% mỗi cạnh


def _corner_marker_vector_pdf(path: str, size: float = 200.0):
    """PDF vector 1 trang: nền đỏ phủ kín + 4 ô xanh lá ở 4 góc."""
    m = size * _GREEN_FRAC
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(size, size))
    stream = (
        f"1 0 0 rg 0 0 {size} {size} re f\n"
        f"0 1 0 rg 0 0 {m} {m} re f\n"
        f"0 1 0 rg {size - m} 0 {m} {m} re f\n"
        f"0 1 0 rg 0 {size - m} {m} {m} re f\n"
        f"0 1 0 rg {size - m} {size - m} {m} {m} re f\n"
    ).encode("ascii")
    page.Contents = pdf.make_stream(stream)
    page.MediaBox = [0, 0, size, size]
    pdf.save(path)


def _corner_marker_image_pdf(path: str, px: int = 600, res: float = 150.0):
    """PDF THUẦN ẢNH (không /Font) nền đỏ + 4 góc xanh — để 'auto' chọn raster
    (mô phỏng đúng ca người dùng: mở ẢNH → convert PDF → đổi khổ 'Tự động')."""
    from PIL import Image
    arr = np.zeros((px, px, 3), dtype=np.uint8)
    arr[..., 0] = 255  # nền đỏ
    m = int(px * _GREEN_FRAC)
    for ys in (slice(0, m), slice(px - m, px)):
        for xs in (slice(0, m), slice(px - m, px)):
            arr[ys, xs] = (0, 255, 0)
    Image.fromarray(arr, "RGB").save(path, format="PDF", resolution=res)


def _render_rgb(path: str, scale: float = 1.0):
    import pypdfium2 as pdfium
    d = pdfium.PdfDocument(path)
    try:
        return np.array(d[0].render(scale=scale).to_pil().convert("RGB")).astype(int)
    finally:
        d.close()


def _at(img, fx: float, fy: float):
    """Lấy pixel tại tọa độ chuẩn hoá (0..1) — (0,0)=góc trên-trái."""
    h, w = img.shape[:2]
    x = min(w - 1, max(0, int(fx * w)))
    y = min(h - 1, max(0, int(fy * h)))
    return img[y, x]


def _is_green(c) -> bool:
    return c[0] < 90 and c[1] > 170 and c[2] < 90


def _is_white(c) -> bool:
    return c[0] > 200 and c[1] > 200 and c[2] > 200


def _out_aspect(path: str):
    w, h = _page_sizes_mm(path)[0]
    return w, h


# Target khổ rất khác tỉ lệ nguồn (vuông) để phân biệt rõ các mode.
_TALL_W, _TALL_H = 60.0, 180.0   # mm — hẹp & cao


@pytest.mark.parametrize("mode,dpi", [("xobject", 0), ("raster", 150)])
def test_stretch_fills_and_keeps_corners(tmp_path, mode, dpi):
    """stretch (Ép bóp méo): kéo X/Y riêng LẤP ĐẦY khổ mới, KHÔNG cắt.
    → 4 góc output vẫn XANH (nội dung góc còn nguyên) và KHÔNG có viền trắng."""
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    if mode == "raster":
        _corner_marker_image_pdf(src)
    else:
        _corner_marker_vector_pdf(src)
    resize_pages_smart(src, out, _TALL_W, _TALL_H, "stretch", "all", target_dpi=dpi, mode=mode)

    # Khổ đích đúng tỉ lệ hẹp-cao (không bị ép về vuông).
    w, h = _out_aspect(out)
    assert abs(w - _TALL_W) <= 2 and abs(h - _TALL_H) <= 2, (w, h)

    img = _render_rgb(out)
    for name, (fx, fy) in {
        "TL": (0.08, 0.05), "TR": (0.92, 0.05),
        "BL": (0.08, 0.95), "BR": (0.92, 0.95),
    }.items():
        c = _at(img, fx, fy)
        assert _is_green(c), f"góc {name}={list(c)} không xanh → stretch bị cắt (rơi về fill?)"
    # Không có letterbox trắng (đã lấp đầy).
    assert not _is_white(_at(img, 0.5, 0.5)), "giữa trang trắng → không lấp đầy"


@pytest.mark.parametrize("mode,dpi", [("xobject", 0), ("raster", 150)])
def test_center_no_scale_letterboxes(tmp_path, mode, dpi):
    """center_no_scale (Giữ nguyên ở giữa): scale=1, canh giữa. Khổ đích LỚN hơn
    nguồn → phải có VIỀN TRẮNG quanh (không phóng to lấp đầy như fill)."""
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    if mode == "raster":
        _corner_marker_image_pdf(src, px=300, res=150.0)  # nguồn ~50mm
    else:
        _corner_marker_vector_pdf(src, size=140.0)         # nguồn ~49mm
    # Khổ đích lớn hơn hẳn nguồn theo cả 2 chiều.
    resize_pages_smart(src, out, 120.0, 200.0, "center_no_scale", "all", target_dpi=dpi, mode=mode)

    img = _render_rgb(out)
    # Góc ngoài cùng phải TRẮNG (nội dung không được phóng to ra tới mép).
    for name, (fx, fy) in {
        "TL": (0.03, 0.02), "TR": (0.97, 0.02),
        "BL": (0.03, 0.98), "BR": (0.97, 0.98),
    }.items():
        c = _at(img, fx, fy)
        assert _is_white(c), f"góc {name}={list(c)} không trắng → center_no_scale bị phóng to (rơi về fill?)"
    # Giữa trang vẫn có nội dung (đỏ hoặc xanh), không trắng.
    assert not _is_white(_at(img, 0.5, 0.5)), "giữa trang trắng → mất nội dung"


def test_fill_crops_corners_baseline(tmp_path):
    """Đối chứng: fill ĐÚNG là phải CẮT (mất góc theo trục dài). Bảo đảm ta không
    vô tình biến fill thành stretch khi sửa."""
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _corner_marker_vector_pdf(src, size=200.0)
    resize_pages_smart(src, out, _TALL_W, _TALL_H, "fill", "all", target_dpi=0, mode="xobject")
    img = _render_rgb(out)
    # Khổ hẹp-cao + fill (scale theo chiều cao) → 2 mép trái/phải tràn ra, bị cắt →
    # góc trái/phải KHÔNG còn xanh (đã bị crop ra ngoài).
    tl = _at(img, 0.08, 0.05)
    tr = _at(img, 0.92, 0.05)
    assert not (_is_green(tl) and _is_green(tr)), \
        f"fill lẽ ra cắt góc trái/phải nhưng vẫn xanh TL={list(tl)} TR={list(tr)} → fill hoá stretch?"
