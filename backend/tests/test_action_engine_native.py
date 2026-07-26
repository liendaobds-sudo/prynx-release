"""Đường non-Ghostscript của Action Engine (gate Phase 2 — plan §5).

Điểm mấu chốt các test này khoá lại: action phải sửa ĐÚNG thứ được yêu cầu và
KHÔNG đụng vào thứ khác. Ghostscript dựng lại cả file nên mọi thay đổi phụ đều
"bình thường"; đường pikepdf thì không có cớ đó, và chính vì vậy nó mới đáng
dùng. Mỗi test dựng PDF trong bộ nhớ để không phụ thuộc fixture nhị phân.
"""

import asyncio
import io
import zlib

import pikepdf
import pytest

from app.core import pdf_actions_native
from app.core.action_engine import ActionEngine


def _image_stream(pdf: pikepdf.Pdf, w: int, h: int, colorspace="/DeviceRGB", n=3):
    """Image XObject Flate, dữ liệu gradient để phép nội suy có gì để làm."""
    raw = bytes(((x * 7 + y * 3) % 256) for y in range(h) for x in range(w) for _ in range(n))
    return pikepdf.Stream(
        pdf,
        zlib.compress(raw),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=w,
        Height=h,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name(colorspace),
        Filter=pikepdf.Name("/FlateDecode"),
    )


def _one_page_pdf(path, img_w=1200, img_h=1200, placed_pt=72.0, extra_content=b""):
    """Trang đặt một ảnh ở kích thước `placed_pt` → DPI = img_w / (placed_pt/72)."""
    pdf = pikepdf.Pdf.new()
    img = _image_stream(pdf, img_w, img_h)
    content = (
        f"q {placed_pt} 0 0 {placed_pt} 10 10 cm /Im0 Do Q\n".encode() + extra_content
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img))
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, content)),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(path))
    pdf.close()


def _first_image(path):
    with pikepdf.open(str(path)) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream) and str(obj.get("/Subtype", "")) == "/Image":
                return int(obj.Width), int(obj.Height)
    return None


# ── scan_image_placements: nền tảng của mọi quyết định hạ ảnh ────────────────

def test_placement_scan_uses_ctm_not_pixel_count(tmp_path):
    # 1200px trải trên 72pt = 1200 DPI; cùng ảnh đó trải 600pt chỉ 144 DPI.
    # Nếu quét bỏ qua CTM thì hai ca này không phân biệt được.
    p = tmp_path / "a.pdf"
    _one_page_pdf(p, img_w=1200, img_h=1200, placed_pt=72.0)
    with pikepdf.open(str(p)) as pdf:
        scan = pdf_actions_native.scan_image_placements(pdf)
    assert len(scan.placements) == 1
    placement = next(iter(scan.placements.values()))
    assert placement.width_pt == pytest.approx(72.0, abs=0.01)


def test_placement_scan_takes_largest_of_repeated_placements(tmp_path):
    # Một ảnh dùng lại ở hai kích thước: phải giữ đủ pixel cho chỗ TO nhất,
    # nếu không chính chỗ đó bị mờ sau khi hạ.
    p = tmp_path / "b.pdf"
    _one_page_pdf(
        p, img_w=1200, img_h=1200, placed_pt=36.0,
        extra_content=b"q 144 0 0 144 10 10 cm /Im0 Do Q\n",
    )
    with pikepdf.open(str(p)) as pdf:
        scan = pdf_actions_native.scan_image_placements(pdf)
    placement = next(iter(scan.placements.values()))
    assert placement.count == 2
    assert placement.width_pt == pytest.approx(144.0, abs=0.01)


def test_placement_scan_follows_form_xobject_matrix(tmp_path):
    """CTM của Form nhân vào ảnh bên trong; bỏ qua /Matrix là tính sai DPI."""
    pdf = pikepdf.Pdf.new()
    img = pdf.make_indirect(_image_stream(pdf, 600, 600))
    form = pikepdf.Stream(pdf, b"q 1 0 0 1 0 0 cm /Im0 Do Q\n")
    form.Type = pikepdf.Name("/XObject")
    form.Subtype = pikepdf.Name("/Form")
    form.BBox = [0, 0, 1, 1]
    form.Matrix = [50, 0, 0, 50, 0, 0]  # form phóng 50×
    form.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form))
        ),
        # Ảnh vẽ ở 1×1 trong form, form có Matrix 50 và bị cm phóng thêm 2 lần.
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 2 0 0 2 0 0 cm /Fm0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    scan = pdf_actions_native.scan_image_placements(pdf)
    placement = next(iter(scan.placements.values()))
    assert placement.width_pt == pytest.approx(100.0, abs=0.01), "50 × 2 = 100pt"


# ── downscale_images ────────────────────────────────────────────────────────

def test_downscale_reduces_only_images_above_threshold(tmp_path):
    src = tmp_path / "hi.pdf"
    out = tmp_path / "hi_out.pdf"
    _one_page_pdf(src, img_w=1200, img_h=1200, placed_pt=72.0)  # 1200 DPI

    res = pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    assert res["changed"] == 1
    # 1200 DPI → 300 DPI là hạ 4 lần.
    assert _first_image(out) == (300, 300)


def test_downscale_leaves_images_below_threshold_untouched(tmp_path):
    src = tmp_path / "lo.pdf"
    out = tmp_path / "lo_out.pdf"
    _one_page_pdf(src, img_w=300, img_h=300, placed_pt=144.0)  # 150 DPI

    res = pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    assert res["changed"] == 0
    assert _first_image(out) == (300, 300), "ảnh dưới ngưỡng phải giữ nguyên pixel"


def test_downscale_keeps_smask_aligned_with_image(tmp_path):
    """Ảnh và mặt nạ phải cùng lưới — lệch là vùng trong suốt trượt khỏi hình."""
    src = tmp_path / "sm.pdf"
    out = tmp_path / "sm_out.pdf"
    pdf = pikepdf.Pdf.new()
    img = _image_stream(pdf, 1200, 1200)
    smask = _image_stream(pdf, 1200, 1200, colorspace="/DeviceGray", n=1)
    img.SMask = pdf.make_indirect(smask)
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img))
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 72 0 0 72 10 10 cm /Im0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(src))
    pdf.close()

    res = pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    assert res["changed"] == 1
    with pikepdf.open(str(out)) as opened:
        for obj in opened.objects:
            if isinstance(obj, pikepdf.Stream) and obj.get("/SMask") is not None:
                mask = obj.SMask
                assert (int(obj.Width), int(obj.Height)) == (300, 300)
                assert (int(mask.Width), int(mask.Height)) == (300, 300)
                break
        else:
            pytest.fail("không tìm thấy ảnh có SMask trong output")


def test_smask_is_not_counted_as_an_unhandled_image(tmp_path):
    """`/SMask` không bao giờ theo sau một `Do`, nên nó không có kích thước đặt.

    Nếu đếm nó là "ảnh không xử lý được" thì mọi file có ảnh mờ đều bị coi là
    đường pikepdf bất lực và bị đẩy sang Ghostscript — dựng lại cả tài liệu chỉ
    vì một mặt nạ. Đo trên corpus thật: 6/16/3 mặt nạ bị đếm oan mỗi file trước
    khi lọc.
    """
    src = tmp_path / "masked.pdf"
    out = tmp_path / "masked_out.pdf"
    pdf = pikepdf.Pdf.new()
    img = _image_stream(pdf, 300, 300)  # 150 DPI khi đặt 144pt → dưới ngưỡng
    img.SMask = pdf.make_indirect(_image_stream(pdf, 300, 300, colorspace="/DeviceGray", n=1))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 144 0 0 144 10 10 cm /Im0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(src))
    pdf.close()

    res = pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    blocked = {r: n for r, n in res["skipped"].items() if r != "đã dưới ngưỡng"}
    assert blocked == {}, f"mặt nạ bị tính nhầm là ảnh không xử lý được: {blocked}"


def test_downscale_skips_image_mask_stencil(tmp_path):
    """Stencil 1-bit hạ bằng nội suy sẽ thành xám lem — phải bỏ qua."""
    src = tmp_path / "st.pdf"
    out = tmp_path / "st_out.pdf"
    pdf = pikepdf.Pdf.new()
    packed = bytes([0b10101010] * (1200 // 8) * 1200)
    img = pikepdf.Stream(
        pdf, zlib.compress(packed),
        Type=pikepdf.Name("/XObject"), Subtype=pikepdf.Name("/Image"),
        Width=1200, Height=1200, BitsPerComponent=1,
        ImageMask=True, Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 72 0 0 72 10 10 cm /Im0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(src))
    pdf.close()

    res = pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    assert res["changed"] == 0
    assert "ảnh 1-bit / ImageMask" in res["skipped"]


def test_downscale_skips_image_with_unknown_placement(tmp_path):
    """Ảnh không được vẽ ở đâu thì không có DPI hiệu dụng — không được đoán."""
    src = tmp_path / "orphan.pdf"
    out = tmp_path / "orphan_out.pdf"
    pdf = pikepdf.Pdf.new()
    img = _image_stream(pdf, 1200, 1200)
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"")),  # không có `Do`
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(src))
    pdf.close()

    res = pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    assert res["changed"] == 0


def test_downscale_preserves_page_text_and_structure(tmp_path):
    """Chỉ ảnh được đụng tới: nội dung trang phải y nguyên từng byte."""
    src = tmp_path / "keep.pdf"
    out = tmp_path / "keep_out.pdf"
    marker = b"BT /F1 12 Tf 20 20 Td (giu nguyen) Tj ET\n"
    _one_page_pdf(src, img_w=1200, img_h=1200, placed_pt=72.0, extra_content=marker)

    with pikepdf.open(str(src)) as pdf:
        before = bytes(pdf.pages[0].Contents.read_bytes())
    pdf_actions_native.downscale_images(str(src), str(out), 300.0, 600.0)
    with pikepdf.open(str(out)) as pdf:
        after = bytes(pdf.pages[0].Contents.read_bytes())
    assert before == after, "content stream không được viết lại"
    assert marker in after


# ── analyze_font_embedding ──────────────────────────────────────────────────

def test_base14_font_is_not_reported_missing(tmp_path):
    """Base-14 không cần nhúng (§9.6.2.2) — báo thiếu sẽ đẩy file qua GS vô ích."""
    p = tmp_path / "b14.pdf"
    pdf = pikepdf.Pdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"BT /F1 12 Tf (x) Tj ET\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(p))
    pdf.close()

    info = pdf_actions_native.analyze_font_embedding(str(p))
    assert info["missing"] == []
    assert "Helvetica" in info["base14"]


def test_subset_prefix_is_stripped_before_base14_match(tmp_path):
    """`ABCDEF+Helvetica` vẫn là Helvetica — tiền tố subset không đổi bản chất."""
    p = tmp_path / "subset.pdf"
    pdf = pikepdf.Pdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/ABCDEF+Helvetica"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"BT /F1 12 Tf (x) Tj ET\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(p))
    pdf.close()

    info = pdf_actions_native.analyze_font_embedding(str(p))
    assert info["missing"] == []


def test_unembedded_custom_font_is_reported_missing(tmp_path):
    p = tmp_path / "missing.pdf"
    pdf = pikepdf.Pdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/TrueType"),
        BaseFont=pikepdf.Name("/SVN-Trebuchet"),
        FontDescriptor=pikepdf.Dictionary(
            Type=pikepdf.Name("/FontDescriptor"), FontName=pikepdf.Name("/SVN-Trebuchet"),
        ),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"BT /F1 12 Tf (x) Tj ET\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(p))
    pdf.close()

    info = pdf_actions_native.analyze_font_embedding(str(p))
    assert "SVN-Trebuchet" in info["missing"]


# ── Tích hợp: engine ghi vào action log ─────────────────────────────────────

def test_action_log_records_engine_pikepdf_for_downscale(tmp_path):
    src = tmp_path / "engine.pdf"
    _one_page_pdf(src, img_w=1200, img_h=1200, placed_pt=72.0)

    engine = ActionEngine()
    result = asyncio.run(engine.execute(str(src), "DOWNSCALE_IMAGES"))
    assert result.success
    assert result.log[0].engine == "pikepdf", "không được gọi Ghostscript cho ca này"
    assert result.log[0].report["images_downscaled"] == 1


def test_action_log_records_engine_pikepdf_for_embed_fonts(tmp_path):
    """File đã đủ font: không có lý do gì để Ghostscript dựng lại cả tài liệu."""
    p = tmp_path / "fonts_ok.pdf"
    pdf = pikepdf.Pdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"BT /F1 12 Tf (x) Tj ET\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(p))
    pdf.close()

    engine = ActionEngine()
    result = asyncio.run(engine.execute(str(p), "EMBED_FONTS"))
    assert result.success
    assert result.log[0].engine == "pikepdf"
