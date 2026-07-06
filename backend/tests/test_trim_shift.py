"""Tests cho Trim & Shift engine (trim_shift_engine.trim_shift).

Kiểm chứng bằng ground-truth:
  - Trim: đọc lại MediaBox/CropBox → box nở (dương) / co (âm) đúng lượng mm.
  - Shift: đọc content stream → có `cm` translate đúng dx/dy (điểm đầu stream).
  - Binding: trang lẻ / chẵn dịch trái dấu.
  - Creep: trang cuối trong tập dịch nhiều hơn trang đầu.
  - apply_to even/odd/range: chỉ đụng đúng trang, trang ngoài giữ nguyên box.
"""
import os
import tempfile

import pikepdf
import pytest

from app.workers.trim_shift_engine import trim_shift, _resolve_pages

MM_TO_PTS = 72 / 25.4


# ─── Helpers ──────────────────────────────────────────────────────────────

def _make_pdf(path, n, w=300, h=400):
    """PDF n trang, mỗi trang có content stream tối thiểu (để shift có chỗ bọc)."""
    pdf = pikepdf.Pdf.new()
    for _i in range(n):
        page = pdf.add_blank_page(page_size=(w, h))
        page.contents_add(pikepdf.Stream(pdf, b"q Q"))
    pdf.save(path)
    pdf.close()


def _box(path, idx, key="/MediaBox"):
    with pikepdf.Pdf.open(path) as pdf:
        b = pdf.pages[idx].get(key)
        return [float(b[0]), float(b[1]), float(b[2]), float(b[3])]


def _raw(path, idx):
    """Đọc toàn bộ content stream của trang idx (trong khối with để Pdf không bị đóng)."""
    data = b""
    with pikepdf.Pdf.open(path) as pdf:
        contents = pdf.pages[idx].obj.get("/Contents")
        if contents is None:
            return ""
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        for s in streams:
            data += s.read_bytes()
    return data.decode("latin-1")


def _make_pdf_cropped(path, w=300, h=400, crop=(50, 60, 250, 340)):
    """PDF 1 trang MediaBox (0,0,w,h) + CropBox riêng nhỏ hơn."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(w, h))
    page.contents_add(pikepdf.Stream(pdf, b"q Q"))
    page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array([float(c) for c in crop])
    pdf.save(path)
    pdf.close()


def _make_pdf_rotated(path, rotate, w=300, h=400):
    """PDF 1 trang có /Rotate."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(w, h))
    page.contents_add(pikepdf.Stream(pdf, b"q Q"))
    page.obj[pikepdf.Name("/Rotate")] = rotate
    pdf.save(path)
    pdf.close()


@pytest.fixture
def workdir():
    d = tempfile.mkdtemp(prefix="test_trimshift_")
    yield d
    for root, _dirs, files in os.walk(d, topdown=False):
        for f in files:
            try: os.remove(os.path.join(root, f))
            except OSError: pass
        try: os.rmdir(root)
        except OSError: pass


# ═══════════════════════════════════════════════════════════════════════
#  _resolve_pages
# ═══════════════════════════════════════════════════════════════════════

def test_resolve_all():
    assert _resolve_pages("all", 4) == {0, 1, 2, 3}

def test_resolve_even_odd():
    assert _resolve_pages("even", 6) == {1, 3, 5}
    assert _resolve_pages("odd", 6) == {0, 2, 4}

def test_resolve_range():
    assert _resolve_pages("1-3,5", 8) == {0, 1, 2, 4}

def test_resolve_open_range():
    assert _resolve_pages("6-", 8) == {5, 6, 7}


# ═══════════════════════════════════════════════════════════════════════
#  TRIM (box)
# ═══════════════════════════════════════════════════════════════════════

def test_trim_add_whitespace_each_edge(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 2, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # +10mm mỗi cạnh → box nở: llx-10, lly-10, urx+10, ury+10 (mm→pt)
    trim_shift(src, out, apply_to="all",
               trim_top_mm=10, trim_bottom_mm=10, trim_left_mm=10, trim_right_mm=10)
    mb = _box(out, 0)
    d = 10 * MM_TO_PTS
    assert abs(mb[0] - (-d)) < 0.5
    assert abs(mb[1] - (-d)) < 0.5
    assert abs(mb[2] - (300 + d)) < 0.5
    assert abs(mb[3] - (400 + d)) < 0.5
    # CropBox đồng bộ MediaBox
    assert _box(out, 0, "/CropBox") == mb


def test_trim_crop_negative(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # left=-5mm (cắt) → llx tăng 5mm
    trim_shift(src, out, apply_to="all", trim_left_mm=-5)
    mb = _box(out, 0)
    assert abs(mb[0] - 5 * MM_TO_PTS) < 0.5
    assert abs(mb[2] - 300) < 0.5  # phải giữ nguyên


# ═══════════════════════════════════════════════════════════════════════
#  SHIFT (content)
# ═══════════════════════════════════════════════════════════════════════

def test_shift_injects_cm_translate(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", shift_x_mm=5, shift_y_mm=3)
    raw = _raw(out, 0)
    dx = 5 * MM_TO_PTS
    dy = 3 * MM_TO_PTS
    assert f"1 0 0 1 {dx:.4f} {dy:.4f} cm" in raw
    assert raw.strip().startswith("q")
    assert raw.strip().endswith("Q")


def test_no_shift_no_cm(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", trim_left_mm=5)  # chỉ trim, không shift
    raw = _raw(out, 0)
    assert "cm" not in raw


# ═══════════════════════════════════════════════════════════════════════
#  BINDING (lề trong/ngoài)
# ═══════════════════════════════════════════════════════════════════════

def test_binding_odd_even_opposite(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 2, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", binding_enabled=True, binding_mm=5, binding_inward=True)
    b = 5 * MM_TO_PTS
    # trang 1 (lẻ) dx = +b ; trang 2 (chẵn) dx = -b
    raw1 = _raw(out, 0)
    raw2 = _raw(out, 1)
    assert f"1 0 0 1 {b:.4f} 0.0000 cm" in raw1
    assert f"1 0 0 1 {-b:.4f} 0.0000 cm" in raw2


# ═══════════════════════════════════════════════════════════════════════
#  CREEP
# ═══════════════════════════════════════════════════════════════════════

def test_creep_increases_last_more_than_first(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 4, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", creep_enabled=True, creep_mm=6, creep_axis="x")
    # pos 0 → frac 0 → không shift; pos 3 (max) → full 6mm
    raw_first = _raw(out, 0)
    raw_last = _raw(out, 3)
    assert "cm" not in raw_first  # frac=0, không dx/dy → không bọc
    full = 6 * MM_TO_PTS
    assert f"1 0 0 1 {full:.4f} 0.0000 cm" in raw_last


# ═══════════════════════════════════════════════════════════════════════
#  apply_to: chỉ đụng đúng trang
# ═══════════════════════════════════════════════════════════════════════

def test_apply_to_even_only(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 4, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="even", trim_right_mm=10)
    d = 10 * MM_TO_PTS
    # even → idx 1,3 nở; idx 0,2 giữ nguyên 300
    assert abs(_box(out, 0)[2] - 300) < 0.5
    assert abs(_box(out, 1)[2] - (300 + d)) < 0.5
    assert abs(_box(out, 2)[2] - 300) < 0.5
    assert abs(_box(out, 3)[2] - (300 + d)) < 0.5


# ═══════════════════════════════════════════════════════════════════════
#  F1 — giữ CropBox gốc (không ghi đè bằng MediaBox)
# ═══════════════════════════════════════════════════════════════════════

def test_trim_preserves_original_cropbox(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf_cropped(src, w=300, h=400, crop=(50, 60, 250, 340))
    out = os.path.join(workdir, "o.pdf")
    # +10mm mỗi cạnh: CropBox gốc (50,60,250,340) cũng dịch cùng delta, KHÔNG
    # bị đặt = MediaBox mới.
    trim_shift(src, out, apply_to="all",
               trim_top_mm=10, trim_bottom_mm=10, trim_left_mm=10, trim_right_mm=10)
    d = 10 * MM_TO_PTS
    cb = _box(out, 0, "/CropBox")
    mb = _box(out, 0, "/MediaBox")
    # CropBox vẫn nhỏ hơn MediaBox (không bị ghi đè)
    assert cb != mb
    assert abs(cb[0] - (50 - d)) < 0.5
    assert abs(cb[1] - (60 - d)) < 0.5
    assert abs(cb[2] - (250 + d)) < 0.5
    assert abs(cb[3] - (340 + d)) < 0.5


def test_trim_cropbox_clamped_within_mediabox(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf_cropped(src, w=300, h=400, crop=(0, 0, 300, 400))
    out = os.path.join(workdir, "o.pdf")
    # Cắt 5mm cạnh trái (âm): MediaBox llx +5mm; CropBox gốc = full → phải bị
    # kẹp lại nằm trong MediaBox mới (không thò ra ngoài).
    trim_shift(src, out, apply_to="all", trim_left_mm=-5)
    mb = _box(out, 0, "/MediaBox")
    cb = _box(out, 0, "/CropBox")
    assert cb[0] >= mb[0] - 0.01
    assert cb[2] <= mb[2] + 0.01


# ═══════════════════════════════════════════════════════════════════════
#  F2 — trang có /Rotate: trim & shift theo hướng NHÌN
# ═══════════════════════════════════════════════════════════════════════

def test_shift_respects_rotate_90(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf_rotated(src, 90, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # Người dùng nhìn trang xoay 90°, nhập dịch phải 5mm. Trong hệ nội dung
    # (chưa xoay) vector phải thành (-dy, dx) = (0, +5mm).
    trim_shift(src, out, apply_to="all", shift_x_mm=5)
    raw = _raw(out, 0)
    d = 5 * MM_TO_PTS
    assert f"1 0 0 1 0.0000 {d:.4f} cm" in raw


def test_trim_respects_rotate_90(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf_rotated(src, 90, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # Rotate 90: cạnh TOP (nhìn) = cạnh LEFT (nội dung). Nhập trim_top=+10mm →
    # nội dung nở về phía llx (mb[0] giảm), KHÔNG phải ury tăng.
    trim_shift(src, out, apply_to="all", trim_top_mm=10)
    d = 10 * MM_TO_PTS
    mb = _box(out, 0)
    assert abs(mb[0] - (-d)) < 0.5      # llx dịch ra (cạnh trái nội dung nở)
    assert abs(mb[3] - 400) < 0.5        # ury giữ nguyên


# ═══════════════════════════════════════════════════════════════════════
#  F3 — validate box không đảo ngược khi trim quá tay
# ═══════════════════════════════════════════════════════════════════════

def test_trim_over_size_does_not_invert_box(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # Cắt 200mm mỗi cạnh (>> nửa khổ) → nếu không clamp, box đảo ngược, PDF hỏng.
    trim_shift(src, out, apply_to="all", trim_left_mm=-200, trim_right_mm=-200)
    mb = _box(out, 0)
    assert mb[2] > mb[0]   # urx > llx (box hợp lệ)
    assert mb[3] > mb[1]
    # PDF vẫn mở & đọc được
    with pikepdf.Pdf.open(out) as pdf:
        assert len(pdf.pages) == 1


# ═══════════════════════════════════════════════════════════════════════
#  Mirror-fill — lấp lề trắng mới bằng nội dung lật gương
# ═══════════════════════════════════════════════════════════════════════

def test_mirror_fill_draws_reflected_content(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # Thêm 10mm mỗi cạnh + mirror_fill → content mới phải vẽ Form XObject /Fmx
    # với các cm phản chiếu (hệ số -1) để lấp 4 dải + 4 góc.
    trim_shift(src, out, apply_to="all",
               trim_top_mm=10, trim_bottom_mm=10, trim_left_mm=10, trim_right_mm=10,
               mirror_fill=True)
    raw = _raw(out, 0)
    assert "/Fmx Do" in raw           # có vẽ form snapshot
    assert "-1.000000" in raw         # có ma trận phản chiếu
    # XObject /Fmx tồn tại trong Resources
    with pikepdf.Pdf.open(out) as pdf:
        xobj = pdf.pages[0].Resources.XObject
        assert "/Fmx" in str(xobj)


def test_mirror_fill_renders_without_infinite_recursion(workdir):
    """Chống bug đệ quy vô hạn: form phải snapshot BYTES gốc, không dùng chung
    stream với page.Contents. Render bằng pypdfium2 phải trả về, không treo."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", trim_left_mm=10, mirror_fill=True)
    try:
        import pypdfium2 as pdfium
    except ImportError:
        pytest.skip("pypdfium2 không có sẵn")
    doc = pdfium.PdfDocument(out)
    try:
        page = doc[0]
        bitmap = page.render(scale=0.5)   # nếu đệ quy vô hạn → treo ở đây
        assert bitmap is not None
    finally:
        doc.close()


def test_mirror_fill_skipped_on_rotated_page(workdir):
    """Trang xoay: mirror theo trục thẳng sẽ sai → engine bỏ qua mirror, chỉ trim."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf_rotated(src, 90, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", trim_top_mm=10, mirror_fill=True)
    raw = _raw(out, 0)
    assert "/Fmx Do" not in raw   # không mirror trên trang xoay


def test_no_mirror_when_only_cutting(workdir):
    """Trim âm (cắt) không tạo lề trắng → không cần mirror dù bật cờ."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", trim_left_mm=-10, mirror_fill=True)
    raw = _raw(out, 0)
    assert "/Fmx Do" not in raw


# ═══════════════════════════════════════════════════════════════════════
#  keep_bleed — dịch TrimBox/BleedBox cùng delta để giữ lượng bleed
# ═══════════════════════════════════════════════════════════════════════

def _make_pdf_with_trimbox(path, w=300, h=400, trim=(20, 20, 280, 380)):
    """PDF 1 trang MediaBox (0,0,w,h) + TrimBox riêng (mô phỏng file có bleed)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(w, h))
    page.contents_add(pikepdf.Stream(pdf, b"q Q"))
    page.obj[pikepdf.Name("/TrimBox")] = pikepdf.Array([float(t) for t in trim])
    pdf.save(path)
    pdf.close()


def test_keep_bleed_shifts_trimbox(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf_with_trimbox(src, trim=(20, 20, 280, 380))
    out = os.path.join(workdir, "o.pdf")
    # Cắt 5mm cạnh phải + keep_bleed → TrimBox urx co 5mm theo (giữ lượng bleed).
    trim_shift(src, out, apply_to="all", trim_right_mm=-5, keep_bleed=True)
    d = 5 * MM_TO_PTS
    tb = _box(out, 0, "/TrimBox")
    assert abs(tb[2] - (280 - d)) < 0.5


def test_keep_bleed_off_leaves_trimbox(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf_with_trimbox(src, trim=(20, 20, 280, 380))
    out = os.path.join(workdir, "o.pdf")
    # keep_bleed=False (mặc định) → TrimBox giữ nguyên.
    trim_shift(src, out, apply_to="all", trim_right_mm=-5, keep_bleed=False)
    tb = _box(out, 0, "/TrimBox")
    assert abs(tb[2] - 280) < 0.5


# ═══════════════════════════════════════════════════════════════════════
#  content_mode — clip nội dung vào vùng nhìn cũ ("Improved" của Quite)
# ═══════════════════════════════════════════════════════════════════════

def test_clip_mode_wraps_content_with_clip(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    # Nới 10mm mỗi cạnh + clip → stream có clip path (re W n) theo vùng nhìn cũ (0,0,300,400).
    trim_shift(src, out, apply_to="all",
               trim_top_mm=10, trim_bottom_mm=10, trim_left_mm=10, trim_right_mm=10,
               content_mode='clip')
    raw = _raw(out, 0)
    assert "re W n" in raw
    assert "300.0000 400.0000 re W n" in raw


def test_original_mode_no_clip(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out = os.path.join(workdir, "o.pdf")
    trim_shift(src, out, apply_to="all", trim_left_mm=10, content_mode='original')
    raw = _raw(out, 0)
    assert "W n" not in raw


def test_clip_skipped_when_mirror(workdir):
    """Clip mâu thuẫn mirror-fill (mirror cố ý vẽ ra ngoài) → clip bị bỏ khi mirror.

    Cả clip lẫn mirror đều dùng 're W n' nên không phân biệt bằng chuỗi. Kiểm
    bản chất: bật mirror thì output 'clip' PHẢI GIỐNG HỆT output 'original'
    (clip không thêm lớp bọc nào) → chứng minh clip đã bị skip."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 1, w=300, h=400)
    out_clip = os.path.join(workdir, "clip.pdf")
    out_orig = os.path.join(workdir, "orig.pdf")
    trim_shift(src, out_clip, apply_to="all", trim_left_mm=10,
               content_mode='clip', mirror_fill=True)
    trim_shift(src, out_orig, apply_to="all", trim_left_mm=10,
               content_mode='original', mirror_fill=True)
    assert "/Fmx Do" in _raw(out_clip, 0)          # mirror vẫn chạy
    assert _raw(out_clip, 0) == _raw(out_orig, 0)   # clip không tác động khi mirror
