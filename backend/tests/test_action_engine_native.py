"""Đường engine nội bộ của Action Engine (gate Phase 2 — plan §5).

Điểm mấu chốt các test này khoá lại: action phải sửa ĐÚNG thứ được yêu cầu và
KHÔNG đụng vào thứ khác. Đường pikepdf sửa đúng object cần thiết, giữ nguyên
phần còn lại. Mỗi test dựng PDF trong bộ nhớ để không phụ thuộc fixture nhị phân.
"""

import asyncio
import hashlib
import io
import zlib
from pathlib import Path

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
                # RESIZE (audit 2026-08-01 §PNG-1): không chỉ kiểm metadata.
                # Stream từng bị ghi byte thô nhưng vẫn khai /FlateDecode, khiến
                # PDFium không giải mã được và toàn bộ ảnh PNG alpha thành trắng.
                assert len(obj.read_bytes()) == 300 * 300 * 3
                assert len(mask.read_bytes()) == 300 * 300
                break
        else:
            pytest.fail("không tìm thấy ảnh có SMask trong output")


def test_smask_is_not_counted_as_an_unhandled_image(tmp_path):
    """`/SMask` không bao giờ theo sau một `Do`, nên nó không có kích thước đặt.

    Nếu đếm nó là "ảnh không xử lý được" thì mọi file có ảnh mờ đều bị coi là
    đường pikepdf bất lực và từ chối cả tài liệu chỉ vì một mặt nạ. Đo trên
    corpus thật: 6/16/3 mặt nạ bị đếm oan mỗi file trước
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
    """Base-14 không cần nhúng (§9.6.2.2) — không được báo thiếu oan."""
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
    assert result.log[0].engine == "pikepdf", "phải dùng đường object-level"
    assert result.log[0].report["images_downscaled"] == 1


def test_action_log_records_engine_pikepdf_for_embed_fonts(tmp_path):
    """File đã đủ font phải được giữ nguyên bằng đường object-level."""
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


# ── CONVERT_TO_CMYK ─────────────────────────────────────────────────────────

def test_convert_grayscale_image_writes_decodable_flate_stream(tmp_path):
    """Ảnh xám đầu ra phải giải nén lại đủ đúng một mẫu cho mỗi pixel."""
    src = tmp_path / "gray_image.pdf"
    out = tmp_path / "gray_image_out.pdf"
    _one_page_pdf(src, img_w=8, img_h=8, placed_pt=72.0)

    res = pdf_actions_native.convert_to_grayscale(str(src), str(out))
    assert res["supported"] and res["images"] == 1

    with pikepdf.open(str(out)) as opened:
        image = opened.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceGray"
        assert str(image.Filter) == "/FlateDecode"
        assert len(bytes(image.read_bytes())) == 8 * 8


def _profiles():
    from app.core import icc_profiles

    return icc_profiles.resolve_cmyk_profile_path(), icc_profiles.resolve_srgb_profile_path()


def _adobe_like_calrgb(pdf: pikepdf.Pdf, **overrides):
    """CalRGB tương đương Adobe RGB 1998 để có oracle CMM độc lập."""
    params = {
        "WhitePoint": [0.950455927, 1.0, 1.08905775],
        "Gamma": [2.19921875, 2.19921875, 2.19921875],
        "Matrix": [
            0.5767309,
            0.2973769,
            0.0270343,
            0.1855540,
            0.6273491,
            0.0706872,
            0.1881852,
            0.0752741,
            0.9911085,
        ],
    }
    params.update(overrides)
    return pdf.make_indirect(
        pikepdf.Array(
            [
                pikepdf.Name("/CalRGB"),
                pikepdf.Dictionary(
                    **{key: value for key, value in params.items() if value is not None}
                ),
            ]
        )
    )


def _color_page(tmp_path, content: bytes, resources=None, name="c.pdf"):
    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100],
        Resources=resources if resources is not None else pikepdf.Dictionary(),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, content)),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    p = tmp_path / name
    pdf.save(str(p))
    pdf.close()
    return p


def _icc_range_page(tmp_path, carrier: str, declared_range, name: str):
    """Dựng ICCBased RGB ở bốn carrier mà writer màu đang hỗ trợ."""
    _cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    profile = pdf.make_stream(Path(srgb).read_bytes())
    profile["/N"] = 3
    if declared_range is not None:
        profile["/Range"] = pikepdf.Array(declared_range)
    colorspace = pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
    )
    resources = pikepdf.Dictionary()

    if carrier == "vector":
        resources["/ColorSpace"] = pikepdf.Dictionary(CS0=colorspace)
        content = b"/CS0 cs 0.25 0.5 0.75 scn 0 0 50 50 re f\n"
    else:
        image_options = dict(
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=1,
            Height=1,
            BitsPerComponent=8,
        )
        if carrier == "indexed":
            image_options["ColorSpace"] = pikepdf.Array(
                [
                    pikepdf.Name("/Indexed"),
                    colorspace,
                    1,
                    pdf.make_stream(bytes([64, 128, 192, 192, 128, 64])),
                ]
            )
            image_bytes = bytes([0])
        else:
            image_options["ColorSpace"] = colorspace
            image_bytes = bytes([64, 128, 192])
        if carrier == "alpha":
            mask = pikepdf.Stream(
                pdf,
                bytes([128]),
                Type=pikepdf.Name("/XObject"),
                Subtype=pikepdf.Name("/Image"),
                Width=1,
                Height=1,
                BitsPerComponent=8,
                ColorSpace=pikepdf.Name("/DeviceGray"),
            )
            image_options["SMask"] = pdf.make_indirect(mask)
        image = pikepdf.Stream(pdf, image_bytes, **image_options)
        resources["/XObject"] = pikepdf.Dictionary(
            Im0=pdf.make_indirect(image)
        )
        content = b"/Im0 Do\n"

    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, content)),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    source = tmp_path / name
    pdf.save(source)
    pdf.close()
    return source


def test_convert_rewrites_rgb_fill_and_stroke_operators(tmp_path):
    cmyk, srgb = _profiles()
    src = _color_page(tmp_path, b"1 0 0 rg 0 0 50 50 re f\n0 0 1 RG 2 w 0 0 m 9 9 l S\n")
    out = tmp_path / "out.pdf"

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"] and res["ops"] == 2

    with pikepdf.open(str(out)) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
    assert b" k\n" in data and b" K\n" in data, data
    assert b" rg" not in data and b" RG" not in data
    assert not pdf_actions_native.has_rgb_content(str(out))


def test_convert_preserves_rgb_black_and_attaches_selected_output_intent(tmp_path):
    """Đen RGB thuần phải thành K-only và OutputIntent phải đúng ICC đích."""
    cmyk, srgb = _profiles()
    src = _color_page(tmp_path, b"0 0 0 rg 0 0 50 50 re f\n")
    out = tmp_path / "black_output_intent.pdf"

    res = pdf_actions_native.convert_to_cmyk(
        str(src), str(out), cmyk, srgb, preserve_black=True
    )
    assert res["supported"]

    expected = Path(cmyk).read_bytes()
    with pikepdf.open(str(out)) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
        intents = pdf.Root.get("/OutputIntents")
        assert len(intents) == 1
        embedded = bytes(intents[0]["/DestOutputProfile"].read_bytes())
    assert b"0 0 0 1 k" in data
    assert hashlib.sha256(embedded).digest() == hashlib.sha256(expected).digest()

    separated = tmp_path / "black_separated.pdf"
    res = pdf_actions_native.convert_to_cmyk(
        str(src), str(separated), cmyk, srgb, preserve_black=False
    )
    assert res["supported"]
    with pikepdf.open(str(separated)) as pdf:
        separated_data = bytes(pdf.pages[0].Contents.read_bytes())
    assert b"0 0 0 1 k" not in separated_data


def test_cmyk_adjustment_zero_is_byte_identical_and_brightness_raises_proof_luma():
    """Giá trị 0 giữ byte cũ; bù L* dương phải làm proof sáng hơn thật."""
    from PIL import Image, ImageCms

    cmyk, srgb = _profiles()
    source = Image.new("RGB", (3, 1))
    source.putdata([(20, 100, 220), (60, 200, 100), (200, 220, 240)])
    baseline = pdf_actions_native._CmykTransform(srgb, cmyk)
    explicit_zero = pdf_actions_native._CmykTransform(
        srgb,
        cmyk,
        brightness_lstar=0,
        contrast_percent=0,
        vibrance_percent=0,
    )
    baseline_cmyk = baseline.image(source)
    assert explicit_zero.image(source).tobytes() == baseline_cmyk.tobytes()

    brighter_cmyk = pdf_actions_native._CmykTransform(
        srgb,
        cmyk,
        brightness_lstar=2,
        adjustment_stage="post_cmyk",
    ).image(source)
    source_stage_cmyk = pdf_actions_native._CmykTransform(
        srgb,
        cmyk,
        brightness_lstar=2,
        adjustment_stage="pre_icc",
    ).image(source)
    assert brighter_cmyk.tobytes() != baseline_cmyk.tobytes()
    assert brighter_cmyk.tobytes() != source_stage_cmyk.tobytes()

    proof = ImageCms.buildTransform(
        ImageCms.getOpenProfile(cmyk),
        ImageCms.getOpenProfile(srgb),
        "CMYK",
        "RGB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        flags=pdf_actions_native._CMS_FLAGS(black_point_compensation=True),
    )

    def mean_luma(image):
        raw = ImageCms.applyTransform(image, proof).tobytes()
        return sum(
            0.2126 * raw[offset]
            + 0.7152 * raw[offset + 1]
            + 0.0722 * raw[offset + 2]
            for offset in range(0, len(raw), 3)
        ) / (len(raw) // 3)

    assert mean_luma(brighter_cmyk) > mean_luma(baseline_cmyk)
    assert max(
        sum(brighter_cmyk.tobytes()[offset : offset + 4]) / 255.0 * 100.0
        for offset in range(0, len(brighter_cmyk.tobytes()), 4)
    ) <= 330.5


def test_convert_brightness_keeps_pure_black_and_rejects_unsafe_range(tmp_path):
    """Bù sáng không làm bẩn chữ K-only; request vượt miền không sinh artifact."""
    cmyk, srgb = _profiles()
    src = _color_page(
        tmp_path,
        b"0 0 0 rg 0 0 40 40 re f\n0.2 0.6 0.9 rg 50 0 40 40 re f\n",
        name="adjusted-vector.pdf",
    )
    out = tmp_path / "adjusted-vector-out.pdf"
    result = pdf_actions_native.convert_to_cmyk(
        str(src),
        str(out),
        cmyk,
        srgb,
        preserve_black=True,
        brightness_lstar=4,
        contrast_percent=5,
        vibrance_percent=5,
        adjustment_stage="post_cmyk",
    )
    assert result["supported"] and result["postflight"]["passed"], result
    assert result["adjustments"] == {
        "brightness_lstar": 4.0,
        "contrast_percent": 5.0,
        "vibrance_percent": 5.0,
        "stage": "post_cmyk",
    }
    with pikepdf.open(out) as opened:
        data = bytes(opened.pages[0].Contents.read_bytes())
        assert b"0 0 0 1 k" in data
        assert len(opened.Root["/OutputIntents"]) == 1

    refused = tmp_path / "unsafe-adjustment.pdf"
    invalid = pdf_actions_native.convert_to_cmyk(
        str(src), str(refused), cmyk, srgb, brightness_lstar=11
    )
    assert not invalid["supported"]
    assert any("INVALID_COLOR_ADJUSTMENT" in item for item in invalid["blockers"])
    assert not refused.exists()


def test_convert_post_cmyk_brightness_uses_the_image_lane(tmp_path):
    """Thanh bù sau CMYK phải đi qua writer ảnh, không chỉ qua vector."""
    from PIL import Image

    cmyk, srgb = _profiles()
    raw = bytes((20, 100, 220, 60, 200, 100, 200, 220, 240))
    pdf = pikepdf.Pdf.new()
    image = pikepdf.Stream(
        pdf,
        zlib.compress(raw),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=3,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"),
        Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 30, 10],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"q 30 0 0 10 0 0 cm /Im0 Do Q\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    source = tmp_path / "post-image-source.pdf"
    output = tmp_path / "post-image-output.pdf"
    pdf.save(source)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(
        str(source),
        str(output),
        cmyk,
        srgb,
        brightness_lstar=2,
        adjustment_stage="post_cmyk",
    )
    assert result["supported"] and result["images"] == 1, result
    assert result["postflight"]["passed"]
    expected = pdf_actions_native._CmykTransform(
        srgb,
        cmyk,
        brightness_lstar=2,
        adjustment_stage="post_cmyk",
    ).image(Image.frombytes("RGB", (3, 1), raw)).tobytes()
    with pikepdf.open(output) as opened:
        actual = bytes(opened.pages[0].Resources.XObject.Im0.read_bytes())
    assert actual == expected


def test_convert_replaces_stale_output_intent(tmp_path):
    """Không được giữ SWOP cũ khi số CMYK vừa sinh bằng profile khác."""
    cmyk, srgb = _profiles()
    src = _color_page(tmp_path, b"0.2 0.4 0.8 rg 0 0 50 50 re f\n")
    stale_bytes = b"stale-output-profile"
    with pikepdf.open(str(src), allow_overwriting_input=True) as pdf:
        stale = pdf.make_stream(stale_bytes)
        stale["/N"] = 4
        intent = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name("/OutputIntent"),
                S=pikepdf.Name("/GTS_PDFX"),
                OutputConditionIdentifier=pikepdf.String("SWOP OLD"),
                DestOutputProfile=stale,
            )
        )
        pdf.Root["/OutputIntents"] = pikepdf.Array([intent])
        pdf.save(str(src))
    out = tmp_path / "replaced_intent.pdf"

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"]
    with pikepdf.open(str(out)) as pdf:
        intents = pdf.Root.get("/OutputIntents")
        assert len(intents) == 1
        assert "SWOP OLD" not in str(intents[0].get("/OutputConditionIdentifier"))
        assert bytes(intents[0]["/DestOutputProfile"].read_bytes()) == Path(cmyk).read_bytes()


def test_convert_cmyk_image_writes_decodable_flate_stream_and_renders(tmp_path):
    """Ảnh CMYK đầu ra phải giải nén được và PDFium không được render trắng."""
    cmyk, srgb = _profiles()
    src = tmp_path / "cmyk_image.pdf"
    out = tmp_path / "cmyk_image_out.pdf"
    _one_page_pdf(src, img_w=8, img_h=8, placed_pt=72.0)

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"] and res["images"] == 1

    with pikepdf.open(str(out)) as opened:
        image = opened.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        assert str(image.Filter) == "/FlateDecode"
        assert len(bytes(image.read_bytes())) == 8 * 8 * 4

    try:
        import pypdfium2 as pdfium
    except ImportError:
        return

    from app.core.pdfium_lock import pdfium_guard

    with pdfium_guard():
        document = pdfium.PdfDocument(str(out))
        page = document[0]
        bitmap = page.render(scale=1)
        rendered = bitmap.to_pil().convert("RGB")
        bitmap.close()
        page.close()
        document.close()
    assert min(channel[0] for channel in rendered.getextrema()) < 250


@pytest.mark.parametrize("with_matte", [False, True])
def test_convert_flattens_isolated_rgb_smask_before_icc(tmp_path, with_matte):
    """Ảnh alpha cô lập phải composite ở RGB trước khi chạy transform ICC."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    mask = pikepdf.Stream(
        pdf,
        bytes([128]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceGray"),
        Decode=pikepdf.Array([0, 1]),
    )
    if with_matte:
        mask.Matte = pikepdf.Array([1, 1, 1])
    image = pikepdf.Stream(
        pdf,
        bytes([255, 128, 128]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"),
        Decode=pikepdf.Array([0, 1, 0, 1, 0, 1]),
        SMask=pdf.make_indirect(mask),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 100 0 0 100 0 0 cm /Im0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "matte-source.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "matte-output.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert result["supported"], result
    assert result["flattened_images"] == 1
    assert result["images"] == 1
    # Matte lưu màu đã preblend trên nền trắng; ảnh không Matte lưu màu gốc
    # unassociated. Hai phép tính phải đi qua cùng CMM sau khi composite RGB.
    expected_rgb = (255, 128, 128) if with_matte else (255, 191, 191)
    expected_tf = pdf_actions_native._CmykTransform(srgb, cmyk)
    expected_cmyk = bytes(
        int(round(channel * 255.0)) for channel in expected_tf(*[v / 255.0 for v in expected_rgb])
    )
    with pikepdf.open(str(out)) as opened:
        image = opened.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        assert image.get("/SMask") is None
        assert bytes(image.read_bytes()) == expected_cmyk


def test_convert_keeps_nonisolated_rgb_smask_fail_closed(tmp_path):
    """Có nền vector thì không được đoán backdrop để flatten ảnh alpha."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    mask = pikepdf.Stream(
        pdf,
        bytes([128]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceGray"),
    )
    image = pikepdf.Stream(
        pdf,
        bytes([255, 0, 0]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"),
        SMask=pdf.make_indirect(mask),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(
                pdf,
                b"1 1 1 rg 0 0 100 100 re f "
                b"q 100 0 0 100 0 0 cm /Im0 Do Q\n",
            )
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "nonisolated-alpha-source.pdf"
    out = tmp_path / "nonisolated-alpha-output.pdf"
    pdf.save(str(src))
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert not result["supported"], result
    assert any("LIVE_TRANSPARENCY_RGB" in blocker for blocker in result["blockers"])
    assert not out.exists()


def test_convert_does_not_flatten_rgb_smask_reused_inside_form(tmp_path):
    """Ảnh được dùng lại trong Form không được flatten theo placement cô lập."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    mask = pikepdf.Stream(
        pdf,
        bytes([128]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceGray"),
    )
    image = pdf.make_indirect(
        pikepdf.Stream(
            pdf,
            bytes([255, 0, 0]),
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=1,
            Height=1,
            BitsPerComponent=8,
            ColorSpace=pikepdf.Name("/DeviceRGB"),
            SMask=pdf.make_indirect(mask),
        )
    )
    form = pikepdf.Stream(
        pdf,
        b"q 1 0 0 1 0 0 cm /Im0 Do Q\n",
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Form"),
        BBox=[0, 0, 1, 1],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image)),
    )
    page1 = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image)),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 100 0 0 100 0 0 cm /Im0 Do Q\n")),
    )
    page2 = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/Fm0 Do\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page1)))
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page2)))
    src = tmp_path / "form-reuse-source.pdf"
    out = tmp_path / "form-reuse-output.pdf"
    pdf.save(str(src))
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert not result["supported"], result
    assert any("LIVE_TRANSPARENCY_RGB" in blocker for blocker in result["blockers"])
    assert not out.exists()


def test_convert_flattens_iccbased_rgb_smask_via_blend_device_rgb(tmp_path):
    """ICC RGB alpha phải đổi sang blend DeviceRGB trước khi composite."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    profile = pdf.make_stream(Path(srgb).read_bytes())
    profile["/N"] = 3
    colorspace = pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
    )
    mask = pikepdf.Stream(
        pdf,
        bytes([128]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceGray"),
    )
    image = pikepdf.Stream(
        pdf,
        bytes([60, 200, 100]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=colorspace,
        SMask=pdf.make_indirect(mask),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/Im0 Do\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "iccbased-alpha-source.pdf"
    out = tmp_path / "iccbased-alpha-output.pdf"
    pdf.save(str(src))
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert result["supported"], result
    assert result["flattened_images"] == 1
    assert result["images"] == 1
    from PIL import Image, ImageCms

    source_handle = ImageCms.getOpenProfile(srgb)
    blend = ImageCms.buildTransform(
        source_handle,
        ImageCms.getOpenProfile(srgb),
        "RGB",
        "RGB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        flags=pdf_actions_native._CMS_FLAGS(),
    )
    source_rgb = ImageCms.applyTransform(Image.new("RGB", (1, 1), (60, 200, 100)), blend)
    composite = Image.composite(
        source_rgb,
        Image.new("RGB", (1, 1), (255, 255, 255)),
        Image.new("L", (1, 1), 128),
    )
    expected = pdf_actions_native._CmykTransform(srgb, cmyk).image(composite).tobytes()
    with pikepdf.open(str(out)) as opened:
        image = opened.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        assert image.get("/SMask") is None
        assert bytes(image.read_bytes()) == expected


@pytest.mark.parametrize("carrier", ["image", "vector", "indexed", "alpha"])
def test_convert_accepts_explicit_canonical_iccbased_rgb_range(tmp_path, carrier):
    """`/Range [0 1]` tường minh phải tương đương giá trị mặc định PDF."""
    cmyk, srgb = _profiles()
    src = _icc_range_page(
        tmp_path,
        carrier,
        [0, 1, 0, 1, 0, 1],
        f"range-canonical-{carrier}.pdf",
    )
    out = tmp_path / f"range-canonical-{carrier}-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert result["supported"], result
    assert result["blockers"] == []
    assert result["postflight"]["passed"] is True
    if carrier == "alpha":
        assert result["flattened_images"] == 1
    assert out.is_file()
    assert not pdf_actions_native.has_rgb_content(str(out))


@pytest.mark.parametrize("carrier", ["image", "vector", "indexed", "alpha"])
def test_convert_rejects_custom_iccbased_rgb_range_before_rewrite(
    tmp_path, carrier
):
    """Range tùy biến cần mapping riêng; chưa có oracle thì phải fail-closed."""
    cmyk, srgb = _profiles()
    src = _icc_range_page(
        tmp_path,
        carrier,
        [0.25, 0.75, 0.25, 0.75, 0.25, 0.75],
        f"range-custom-{carrier}.pdf",
    )
    out = tmp_path / f"range-custom-{carrier}-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert not result["supported"], result
    assert any("UNSUPPORTED_ICC_RANGE" in item for item in result["blockers"])
    assert result["flattened_images"] == 0
    assert not out.exists()


@pytest.mark.parametrize(
    "declared_range",
    [
        [0, 1],
        [0, 1, 0, 1, 0, pikepdf.Name("/Bad")],
        [1, 0, 0, 1, 0, 1],
    ],
    ids=["wrong-length", "nonnumeric", "inverted"],
)
def test_convert_rejects_invalid_iccbased_rgb_range_before_alpha_flatten(
    tmp_path, declared_range
):
    """Range hỏng không được biến mất khi alpha lane xóa ICC metadata."""
    cmyk, srgb = _profiles()
    src = _icc_range_page(
        tmp_path,
        "alpha",
        declared_range,
        "range-invalid-alpha.pdf",
    )
    out = tmp_path / "range-invalid-alpha-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert not result["supported"], result
    assert any("INVALID_ICC_RANGE" in item for item in result["blockers"])
    assert result["flattened_images"] == 0
    assert not out.exists()


@pytest.mark.parametrize("decode_target", ["rgb_image", "smask"])
def test_convert_rejects_nondefault_image_decode_before_rewrite(
    tmp_path, decode_target
):
    """`/Decode` đảo kênh không được mất khi writer đổi RGB hoặc flatten alpha."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    image_options = dict(
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"),
    )
    if decode_target == "rgb_image":
        image_options["Decode"] = pikepdf.Array([1, 0, 0, 1, 0, 1])
    else:
        smask = pikepdf.Stream(
            pdf,
            bytes([128]),
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=1,
            Height=1,
            BitsPerComponent=8,
            ColorSpace=pikepdf.Name("/DeviceGray"),
            Decode=pikepdf.Array([1, 0]),
        )
        image_options["SMask"] = pdf.make_indirect(smask)
    image = pikepdf.Stream(pdf, bytes([255, 0, 0]), **image_options)
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/Im0 Do\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / f"decode-{decode_target}-source.pdf"
    out = tmp_path / f"decode-{decode_target}-output.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert not result["supported"], result
    assert any(
        "UNSUPPORTED_IMAGE_DECODE" in blocker for blocker in result["blockers"]
    )
    assert not out.exists()


def test_convert_rejects_rgb_with_live_extgstate_alpha(tmp_path):
    """Alpha qua ExtGState cũng phải flatten-before-ICC dù page không khai Group."""
    cmyk, srgb = _profiles()
    graphics_state = pikepdf.Dictionary(ca=0.5, CA=0.5)
    resources = pikepdf.Dictionary(
        ExtGState=pikepdf.Dictionary(GS0=graphics_state)
    )
    src = _color_page(
        tmp_path,
        b"/GS0 gs 1 0 0 rg 0 0 50 50 re f\n",
        resources=resources,
        name="live-alpha.pdf",
    )
    out = tmp_path / "live-alpha-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert not result["supported"]
    assert any("LIVE_TRANSPARENCY_RGB" in blocker for blocker in result["blockers"])
    assert not out.exists()


def _write_simple_vector_alpha_pdf(
    tmp_path,
    *,
    content: bytes = b"/GS0 gs 1 0 0 rg 0 0 50 50 re f\n",
    blend=None,
    soft_mask=None,
    group=False,
    name="vector-alpha-safe.pdf",
):
    """PDF alpha vector tối giản dùng cho gate flatten-before-ICC."""
    pdf = pikepdf.Pdf.new()
    gs_options = {"ca": 0.5, "CA": 0.5}
    if blend is not None:
        gs_options["BM"] = pikepdf.Name(blend)
    if soft_mask is not None:
        gs_options["SMask"] = soft_mask
    # PDF producer thật thường ghi ExtGState thành object gián tiếp; lane
    # positive chỉ mở khi có thể chứng minh object không dùng chung.
    gs = pdf.make_indirect(pikepdf.Dictionary(**gs_options))
    page_options = {
        "Type": pikepdf.Name("/Page"),
        "MediaBox": [0, 0, 100, 100],
        "Resources": pikepdf.Dictionary(
            ExtGState=pikepdf.Dictionary(GS0=gs)
        ),
        "Contents": pdf.make_indirect(pikepdf.Stream(pdf, content)),
    }
    if group:
        page_options["Group"] = pikepdf.Dictionary(
            S=pikepdf.Name("/Transparency"),
            CS=pikepdf.Name("/DeviceRGB"),
        )
    page = pikepdf.Dictionary(**page_options)
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    path = tmp_path / name
    pdf.save(str(path))
    pdf.close()
    return path


def test_convert_flattens_simple_vector_alpha_before_icc(tmp_path):
    """Alpha fill đơn trên nền trắng được composite rồi mới qua ICC CMYK."""
    cmyk, srgb = _profiles()
    src = _write_simple_vector_alpha_pdf(tmp_path)
    out = tmp_path / "vector-alpha-safe-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert result["supported"], result
    assert result["flattened_vectors"] == 1
    assert any("flatten 1" in warning for warning in result["warnings"])
    expected = pdf_actions_native._CmykTransform(srgb, cmyk)(1.0, 0.5, 0.5)
    with pikepdf.open(str(out)) as opened:
        instructions = pikepdf.parse_content_stream(opened.pages[0].Contents)
        color = next(
            list(instruction.operands)
            for instruction in instructions
            if str(instruction.operator) == "k"
        )
        assert all(float(actual) == pytest.approx(want, abs=2.0e-6) for actual, want in zip(color, expected))
        assert opened.pages[0].Resources.get("/ExtGState") is None
    assert result["postflight"]["passed"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"content": b"/GS0 gs 1 0 0 rg 0 0 50 50 re f 0 1 0 rg 50 0 50 50 re f\n"},
        {"content": b"q /GS0 gs Q 1 0 0 rg 0 0 50 50 re f\n"},
        {"blend": "/Multiply"},
        {"soft_mask": pikepdf.Name("/Alpha")},
        {"group": True},
    ],
)
def test_convert_keeps_complex_vector_transparency_fail_closed(tmp_path, kwargs):
    """Nhiều paint/blend/soft-mask/group không được đoán backdrop."""
    cmyk, srgb = _profiles()
    src = _write_simple_vector_alpha_pdf(tmp_path, name="vector-alpha-complex.pdf", **kwargs)
    out = tmp_path / "vector-alpha-complex-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert not result["supported"], result
    assert any("LIVE_TRANSPARENCY_RGB" in blocker for blocker in result["blockers"]), result
    assert not out.exists()


@pytest.mark.parametrize("split_contents", [False, True])
def test_convert_preserves_icc_color_state_across_q_and_contents(tmp_path, split_contents):
    """`q/Q` và ranh giới `/Contents` không được reset source ICC hiện hành."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    icc = pdf.make_stream(Path(srgb).read_bytes())
    icc["/N"] = 3
    colorspace = pikepdf.Array([pikepdf.Name("/ICCBased"), icc])
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(colorspace))
    )
    if split_contents:
        contents = pikepdf.Array(
            [
                pdf.make_indirect(pikepdf.Stream(pdf, b"/CS0 cs\n")),
                pdf.make_indirect(
                    pikepdf.Stream(pdf, b"0.1 0.2 0.3 scn 0 0 50 50 re f\n")
                ),
            ]
        )
    else:
        contents = pdf.make_indirect(
            pikepdf.Stream(
                pdf,
                b"/CS0 cs q /DeviceCMYK cs Q "
                b"0.1 0.2 0.3 scn 0 0 50 50 re f\n",
            )
        )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 50, 50],
        Resources=resources,
        Contents=contents,
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / f"state-{split_contents}.pdf"
    out = tmp_path / f"state-{split_contents}-out.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert result["supported"] and result["ops"] == 1, result
    with pikepdf.open(out) as opened:
        streams = opened.pages[0].Contents
        if not isinstance(streams, pikepdf.Array):
            streams = [streams]
        data = b"\n".join(bytes(stream.read_bytes()) for stream in streams)
    assert b"/DeviceCMYK cs" in data
    scn = next(line for line in data.splitlines() if line.endswith(b" scn"))
    assert len(scn.split()) == 5, scn


def test_convert_rejects_icc_declared_channels_mismatching_profile(tmp_path):
    """Không tin `/N=4` khi byte ICC thật là RGB."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    icc = pdf.make_stream(Path(srgb).read_bytes())
    icc["/N"] = 4
    colorspace = pikepdf.Array([pikepdf.Name("/ICCBased"), icc])
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(colorspace))
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 50, 50],
        Resources=resources,
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/CS0 cs 0.1 0.2 0.3 0.4 scn 0 0 50 50 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "icc-channel-mismatch.pdf"
    out = tmp_path / "icc-channel-mismatch-out.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert not result["supported"]
    assert any(
        "INVALID_ICC_PROFILE" in blocker and "/N=4" in blocker and "RGB" in blocker
        for blocker in result["blockers"]
    )
    assert not out.exists()


@pytest.mark.parametrize("explicit_empty", [False, True])
def test_convert_handles_missing_or_empty_form_resources(tmp_path, explicit_empty):
    """Form kế thừa/`<<>>` đều không được làm resource walker tự lặp vô hạn."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    form_options = dict(
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Form"),
        BBox=[0, 0, 10, 10],
    )
    if explicit_empty:
        form_options["Resources"] = pikepdf.Dictionary()
    form = pikepdf.Stream(
        pdf,
        b"1 0 0 rg 0 0 10 10 re f\n",
        **form_options,
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 10, 10],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form))
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/Fm0 Do\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / f"form-resources-{explicit_empty}.pdf"
    out = tmp_path / f"form-resources-{explicit_empty}-out.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert result["supported"] and result["ops"] == 1, result
    assert result["postflight"]["passed"]


def test_convert_keeps_devicegray_as_k_only(tmp_path):
    """Xám in bằng K thuần. Đẩy nó thành 4 kênh chỉ tăng TAC và bẩn bản."""
    cmyk, srgb = _profiles()
    src = _color_page(tmp_path, b"0.5 g 0 0 50 50 re f\n0 G 1 w 0 0 m 9 9 l S\n")
    out = tmp_path / "gray_out.pdf"

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"]
    with pikepdf.open(str(out)) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
    assert b"0.5 g" in data and b"0 G" in data, "toán tử gray phải nguyên vẹn"


def test_convert_leaves_spot_separation_untouched(tmp_path):
    """Bất biến quan trọng nhất: kênh bế / Pantone phải sống sót.

    Đường object-level phải giữ Separation thay vì đổi thành process và làm mất
    kênh CutContour.
    """
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    tint = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=[0, 0.91, 0.76, 0], N=1,
        Range=[0, 1, 0, 1, 0, 1, 0, 1],
    )
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/CutContour"),
        pikepdf.Name("/DeviceCMYK"), pdf.make_indirect(tint),
    ])
    resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(
            pdf, b"/CS0 cs 1 scn 0 0 50 50 re f\n1 0 0 rg 10 10 20 20 re f\n"
        )),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "spot.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "spot_out.pdf"

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"]
    with pikepdf.open(str(out)) as opened:
        data = bytes(opened.pages[0].Contents.read_bytes())
        cs = opened.pages[0].Resources.ColorSpace.CS0
        assert str(cs[0]) == "/Separation", "colorspace spot bị đổi"
        assert str(cs[1]) == "/CutContour", "tên kênh bế bị đổi"
    assert b"/CS0 cs" in data and b"1 scn" in data, "lệnh tô spot bị viết lại"
    assert b" rg" not in data, "phần RGB vẫn phải được chuyển"


def test_convert_indexed_palette_keeps_pixel_indices(tmp_path):
    """Ảnh Indexed chỉ đổi BẢNG MÀU — chỉ số pixel phải nguyên vẹn từng byte.

    Đây là lý do ca này an toàn hơn hẳn ảnh RGB thường: không giải nén, không
    nội suy, không mất chi tiết (đo trên corpus: 2/13 file có RGB rơi vào đây).
    """
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    palette = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])  # 4 ô RGB
    indices = bytes([0, 1, 2, 3])
    cs = pikepdf.Array([
        pikepdf.Name("/Indexed"), pikepdf.Name("/DeviceRGB"), 3,
        pdf.make_stream(palette),
    ])
    img = pikepdf.Stream(
        pdf, zlib.compress(indices),
        Type=pikepdf.Name("/XObject"), Subtype=pikepdf.Name("/Image"),
        Width=2, Height=2, BitsPerComponent=8, ColorSpace=cs,
        Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 50 0 0 50 0 0 cm /Im0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "idx.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "idx_out.pdf"

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"] and res["images"] == 1

    with pikepdf.open(str(out)) as opened:
        for obj in opened.objects:
            if isinstance(obj, pikepdf.Stream) and str(obj.get("/Subtype", "")) == "/Image":
                cs_out = obj.ColorSpace
                assert str(cs_out[1]) == "/DeviceCMYK", "nền bảng màu phải thành CMYK"
                assert bytes(obj.read_bytes()) == indices, "chỉ số pixel bị đổi"
                table = bytes(cs_out[3].read_bytes())
                assert len(table) == 4 * 4, "bảng phải là 4 ô × 4 kênh"
                # Ô trắng (255,255,255) phải ra gần như không mực.
                assert sum(table[12:16]) < 40, table[12:16]
                break
        else:
            pytest.fail("không tìm thấy ảnh Indexed trong output")


def test_convert_declines_shading_rgb_instead_of_guessing(tmp_path):
    """Shading RGB đòi viết lại hàm nội suy — phải trả về không-hỗ-trợ."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    fn = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[1, 0, 0], C1=[0, 0, 1], N=1,
    )
    shading = pikepdf.Dictionary(
        ShadingType=2, ColorSpace=pikepdf.Name("/DeviceRGB"),
        Coords=[0, 0, 100, 0], Function=pdf.make_indirect(fn),
    )
    resources = pikepdf.Dictionary(Shading=pikepdf.Dictionary(Sh0=pdf.make_indirect(shading)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/Sh0 sh\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "sh.pdf"
    pdf.save(str(src))
    pdf.close()

    res = pdf_actions_native.convert_to_cmyk(str(src), str(tmp_path / "sh_out.pdf"), cmyk, srgb)
    assert res["supported"] is False
    assert any("shading" in b for b in res["blockers"])


def test_convert_handles_scn_under_rgb_colorspace_resource(tmp_path, monkeypatch):
    """`cs` trỏ resource ICCBased RGB rồi `scn` 3 số — cũng phải thành CMYK."""
    cmyk, srgb = _profiles()
    real_transform = pdf_actions_native._CmykTransform
    seen_sources = []

    def tracking_transform(source_profile, *args, **kwargs):
        seen_sources.append(source_profile)
        return real_transform(source_profile, *args, **kwargs)

    monkeypatch.setattr(pdf_actions_native, "_CmykTransform", tracking_transform)
    pdf = pikepdf.Pdf.new()
    icc = pikepdf.Stream(pdf, Path(srgb).read_bytes())
    icc["/N"] = 3
    cs = pikepdf.Array([pikepdf.Name("/ICCBased"), pdf.make_indirect(icc)])
    resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(cs)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/CS0 cs 1 0 0 scn 0 0 50 50 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "icc.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "icc_out.pdf"

    res = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)
    assert res["supported"] and res["ops"] == 1
    assert any(
        isinstance(source, bytes) and source == Path(srgb).read_bytes()
        for source in seen_sources
    ), "ICCBased RGB phải dùng profile nhúng, không được diễn giải cưỡng bức như sRGB"
    with pikepdf.open(str(out)) as opened:
        data = bytes(opened.pages[0].Contents.read_bytes())
    assert b"/DeviceCMYK cs" in data, data
    # 4 toán hạng cho scn sau khi đổi sang CMYK.
    scn_line = [ln for ln in data.split(b"\n") if ln.endswith(b" scn")][0]
    assert len(scn_line.split()) == 5, scn_line


def test_convert_fails_closed_on_jpx_rgb_without_publishing(tmp_path):
    """JPX RGB không được báo thành công khi object-level chưa đổi codec."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    image = pikepdf.Stream(
        pdf,
        b"not-a-decoded-jpx-payload",
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=2,
        Height=2,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"),
        Filter=pikepdf.Name("/JPXDecode"),
    )
    src = tmp_path / "jpx_rgb.pdf"
    # Ghi trang thủ công vì image còn gắn với document đang mở.
    resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"q 50 0 0 50 0 0 cm /Im0 Do Q\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "jpx_rgb_out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert result["supported"] is False
    assert any("RESIDUAL_JPX_RGB" in blocker for blocker in result["blockers"])
    assert not out.exists(), "residual JPX không được publish artifact"


def test_convert_fails_closed_on_inline_rgb(tmp_path):
    """Inline image RGB không có XObject để vòng lặp image bắt được."""
    cmyk, srgb = _profiles()
    content = b"BI /W 1 /H 1 /BPC 8 /CS /RGB ID \x80\x20\x10 EI\n"
    src = _color_page(tmp_path, content, name="inline_rgb.pdf")
    out = tmp_path / "inline_rgb_out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert result["supported"] is False
    assert any("RESIDUAL_INLINE_RGB" in blocker for blocker in result["blockers"])
    assert not out.exists()


def test_convert_calrgb_image_vector_and_indexed_use_calibration(tmp_path):
    """CalRGB Adobe-like phải khớp oracle audit, không bị diễn giải như sRGB."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    colorspace = _adobe_like_calrgb(pdf)
    sample = bytes([60, 200, 100])
    image = pikepdf.Stream(
        pdf,
        sample,
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=colorspace,
    )
    indexed = pikepdf.Stream(
        pdf,
        bytes([0]),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Array(
            [pikepdf.Name("/Indexed"), colorspace, 0, pdf.make_stream(sample)]
        ),
    )
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(CS0=colorspace),
        XObject=pikepdf.Dictionary(
            Im0=pdf.make_indirect(image), Ix0=pdf.make_indirect(indexed)
        ),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(
            pikepdf.Stream(
                pdf,
                b"/CS0 cs 0.2352941176 0.7843137255 0.3921568627 scn "
                b"0 0 50 50 re f /Im0 Do /Ix0 Do\n",
            )
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "calrgb-adobe-like.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "calrgb-adobe-like-out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert result["supported"], result
    assert result["ops"] == 1 and result["images"] == 2
    expected = bytes([222, 0, 217, 0])
    with pikepdf.open(out) as opened:
        page = opened.pages[0]
        assert bytes(page.Resources.XObject.Im0.read_bytes()) == expected
        indexed_cs = page.Resources.XObject.Ix0.ColorSpace
        assert str(indexed_cs[1]) == "/DeviceCMYK"
        assert bytes(indexed_cs[3].read_bytes()) == expected
        data = bytes(page.Contents.read_bytes())
    scn = next(line for line in data.splitlines() if line.endswith(b" scn"))
    vector = bytes(round(float(value) * 255) for value in scn.split()[:4])
    assert vector == expected
    assert not pdf_actions_native.has_rgb_content(str(out))


@pytest.mark.parametrize(
    "overrides,expected_code",
    [
        ({"WhitePoint": None}, "INVALID_CALRGB"),
        ({"BlackPoint": [0.0, 0.01, 0.0]}, "UNSUPPORTED_CALRGB"),
        ({"Matrix": [1, 0, 0, 0, 1, 0, 0, 0, 1]}, "UNSUPPORTED_CALRGB"),
        ({"Matrix": [0] * 9}, "INVALID_CALRGB"),
    ],
    ids=["missing-white", "nonzero-black", "white-mismatch", "singular"],
)
def test_convert_rejects_unproven_calrgb_calibration(
    tmp_path, overrides, expected_code
):
    """Calibration không đủ oracle phải dừng trước writer, không đoán sRGB."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    colorspace = _adobe_like_calrgb(pdf, **overrides)
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(CS0=colorspace)
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=resources,
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/CS0 cs 0.2 0.3 0.4 scn 0 0 50 50 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / f"calrgb-{expected_code}.pdf"
    out = tmp_path / f"calrgb-{expected_code}-out.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert not result["supported"], result
    assert any(expected_code in blocker for blocker in result["blockers"])
    assert not out.exists()


@pytest.mark.parametrize("carrier", ["alpha", "shading"])
def test_convert_keeps_complex_calrgb_fail_closed(tmp_path, carrier):
    """CalRGB alpha/gradient cần oracle riêng, chưa được mở theo lane phẳng."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    colorspace = _adobe_like_calrgb(pdf)
    if carrier == "alpha":
        mask = pikepdf.Stream(
            pdf,
            bytes([128]),
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=1,
            Height=1,
            BitsPerComponent=8,
            ColorSpace=pikepdf.Name("/DeviceGray"),
        )
        image = pikepdf.Stream(
            pdf,
            bytes([60, 200, 100]),
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=1,
            Height=1,
            BitsPerComponent=8,
            ColorSpace=colorspace,
            SMask=pdf.make_indirect(mask),
        )
        resources = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        )
        content = b"/Im0 Do\n"
    else:
        shading = pikepdf.Dictionary(
            ShadingType=2,
            ColorSpace=colorspace,
            Coords=[0, 0, 100, 0],
            Function=pikepdf.Dictionary(
                FunctionType=2,
                Domain=[0, 1],
                C0=[0, 0, 0],
                C1=[1, 1, 1],
                N=1,
            ),
            Extend=[True, True],
        )
        resources = pikepdf.Dictionary(
            Shading=pikepdf.Dictionary(Sh0=pdf.make_indirect(shading))
        )
        content = b"/Sh0 sh\n"
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, content)),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / f"calrgb-{carrier}.pdf"
    out = tmp_path / f"calrgb-{carrier}-out.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert not result["supported"], result
    expected = "LIVE_TRANSPARENCY_RGB" if carrier == "alpha" else "shading"
    assert any(expected in blocker for blocker in result["blockers"])
    assert not out.exists()


def test_convert_fails_closed_on_named_lab_vector(tmp_path):
    """Lab process chưa có transform phải là blocker, không false-success."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    colorspace = pikepdf.Array([
        pikepdf.Name("/Lab"),
        pikepdf.Dictionary(
            WhitePoint=[0.9505, 1.0, 1.089],
            Range=[-128, 127, -128, 127],
        ),
    ])
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(colorspace)),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/CS0 cs 50 0 0 scn 0 0 50 50 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "lab_vector.pdf"
    out = tmp_path / "lab_vector_out.pdf"
    pdf.save(src)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert not result["supported"]
    assert any("RESIDUAL_LAB" in blocker for blocker in result["blockers"])
    assert not out.exists()


def test_convert_allows_spot_alternate_lab_and_devicegray(tmp_path):
    """Spot alternate Lab và DeviceGray là invariant được phép giữ nguyên."""
    cmyk, srgb = _profiles()
    pdf = pikepdf.Pdf.new()
    lab = pikepdf.Array([
        pikepdf.Name("/Lab"),
        pikepdf.Dictionary(WhitePoint=[0.9505, 1.0, 1.089]),
    ])
    fn = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[100, 0, 0], C1=[40, 0, 0], N=1,
        Range=[0, 100, -128, 127, -128, 127],
    )
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/SpotLab"), lab,
        pdf.make_indirect(fn),
    ])
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=resources,
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/CS0 cs 1 scn 0 0 40 40 re f\n0.5 g 50 50 40 40 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "spot_lab_and_gray.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "spot_lab_and_gray_out.pdf"

    result = pdf_actions_native.convert_to_cmyk(str(src), str(out), cmyk, srgb)

    assert result["supported"] is True, result
    assert out.exists()


def test_action_engine_does_not_publish_residual_jpx(tmp_path):
    """ActionEngine phải dọn cả staged/final path khi hậu kiểm từ chối."""
    # Dùng cùng fixture JPX nhưng tạo file tối giản cho ActionEngine.
    pdf = pikepdf.Pdf.new()
    image = pikepdf.Stream(
        pdf, b"not-a-decoded-jpx-payload", Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"), Width=1, Height=1,
        BitsPerComponent=8, ColorSpace=pikepdf.Name("/DeviceRGB"),
        Filter=pikepdf.Name("/JPXDecode"),
    )
    resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 10, 10], Resources=resources,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/Im0 Do\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "engine_jpx.pdf"
    pdf.save(str(src))
    pdf.close()

    engine = ActionEngine()
    result = asyncio.run(engine.execute(str(src), "CONVERT_TO_CMYK"))

    assert result.success is False
    assert result.output_path is None
    assert result.log and result.log[0].status == "refused"
    assert "RESIDUAL_JPX_RGB" in result.error


def test_action_log_records_engine_pikepdf_for_convert_cmyk(tmp_path):
    src = _color_page(tmp_path, b"1 0 0 rg 0 0 50 50 re f\n", name="engine_cv.pdf")
    engine = ActionEngine()
    result = asyncio.run(engine.execute(str(src), "CONVERT_TO_CMYK"))
    assert result.success
    assert result.log[0].engine == "pikepdf"
    assert result.log[0].report["color_ops_converted"] == 1


def test_action_engine_forwards_post_cmyk_adjustment_stage(tmp_path):
    src = _color_page(tmp_path, b"0.2 0.6 0.9 rg 0 0 50 50 re f\n", name="engine_stage.pdf")
    engine = ActionEngine()
    result = asyncio.run(
        engine.execute(
            str(src),
            "CONVERT_TO_CMYK",
            params={"brightness_lstar": 2, "adjustment_stage": "post_cmyk"},
        )
    )
    assert result.success
    assert result.log[0].report["color_adjustments"] == {
        "brightness_lstar": 2.0,
        "contrast_percent": 0.0,
        "vibrance_percent": 0.0,
        "stage": "post_cmyk",
    }


# ── Spot → CMYK ─────────────────────────────────────────────────────────────

def _spot_pdf(tmp_path, name="spot2.pdf"):
    """Trang có HAI spot: PANTONE 485 C và CutContour (đường bế)."""
    pdf = pikepdf.Pdf.new()

    def sep(colorant, c1):
        tint = pikepdf.Dictionary(
            FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=c1, N=1,
            Range=[0, 1, 0, 1, 0, 1, 0, 1],
        )
        return pdf.make_indirect(pikepdf.Array([
            pikepdf.Name("/Separation"), pikepdf.Name(colorant),
            pikepdf.Name("/DeviceCMYK"), pdf.make_indirect(tint),
        ]))

    res = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(
        CS0=sep("/PANTONE#20485#20C", [0, 0.91, 0.76, 0]),
        CS1=sep("/CutContour", [0, 1, 0, 0]),
    ))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=res,
        Contents=pdf.make_indirect(pikepdf.Stream(
            pdf,
            b"/CS0 cs 1 scn 0 0 50 50 re f\n"
            b"/CS0 cs 0.5 scn 5 5 10 10 re f\n"
            b"/CS1 cs 1 scn 60 60 20 20 re f\n",
        )),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    p = tmp_path / name
    pdf.save(str(p))
    pdf.close()
    return p


def test_spot_to_cmyk_uses_the_files_own_tint_transform(tmp_path):
    """Màu thay vào phải lấy từ tintTransform của chính file, không phải bảng đoán."""
    src = _spot_pdf(tmp_path)
    out = tmp_path / "spot_all.pdf"

    res = pdf_actions_native.convert_spot_to_cmyk(str(src), str(out))
    assert res["supported"] and res["ops"] == 3

    with pikepdf.open(str(out)) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
    # tint 1.0 → đúng C1; tint 0.5 với N=1 → nội suy tuyến tính.
    assert b"0 0.91 0.76 0 k" in data, data
    assert b"0 0.455 0.38 0 k" in data, data
    assert b"scn" not in data and b" cs" not in data


def test_spot_to_cmyk_named_leaves_other_channels_alive(tmp_path):
    """Chỉ định một spot thì kênh bế phải SỐNG.

    Đường chuyển object-level chỉ đổi spot được chỉ định, không nuốt các
    Separation khác mà người dùng đang muốn giữ.
    """
    src = _spot_pdf(tmp_path, name="spot_named.pdf")
    out = tmp_path / "spot_one.pdf"

    res = pdf_actions_native.convert_spot_to_cmyk(str(src), str(out), "PANTONE 485 C")
    assert res["supported"]
    assert res["converted"] == ["PANTONE 485 C"], res["converted"]

    with pikepdf.open(str(out)) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
        cs1 = pdf.pages[0].Resources.ColorSpace.CS1
    assert b"/CS1 cs" in data and b"1 scn" in data, "kênh bế bị chuyển oan"
    assert str(cs1[1]) == "/CutContour"
    assert b"0 0.91 0.76 0 k" in data, "spot được chỉ định phải chuyển"


def test_spot_with_lab_alternate_matches_certified_reference(tmp_path):
    """Pantone hiện đại khai alternate Lab. Giá trị CMYK phải khớp mẫu chuẩn.

    Con số dưới đây không phải "trông hợp lý" mà là mẫu separation đã được đo
    và chốt. Little CMS cần BLACKPOINTCOMPENSATION + NOOPTIMIZE; thiếu hai cờ
    đó thì lệch 13–14/255
    ở Cyan/Magenta, đủ để một khách hàng khó tính từ chối lô hàng.
    """
    from app.core import icc_profiles

    pdf = pikepdf.Pdf.new()
    lab = pikepdf.Array([
        pikepdf.Name("/Lab"),
        pikepdf.Dictionary(
            WhitePoint=[0.964203, 1.0, 0.824905], BlackPoint=[0, 0, 0],
            Range=[-128, 127, -128, 127],
        ),
    ])
    fn = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[100, 0, 0], C1=[28.627, 8.0, -30.0],
        N=1, Range=[0, 100, -128, 127, -128, 127],
    )
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/PANTONE#20test"),
        lab, pdf.make_indirect(fn),
    ])
    res = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=res,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/CS0 cs 1 scn 0 0 100 100 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "lab_spot.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "lab_spot_out.pdf"

    res_out = pdf_actions_native.convert_spot_to_cmyk(
        str(src), str(out), None, icc_profiles.resolve_cmyk_profile_path()
    )
    assert res_out["supported"], res_out["blockers"]
    assert res_out["ops"] == 1

    with pikepdf.open(str(out)) as opened:
        data = bytes(opened.pages[0].Contents.read_bytes()).decode("latin-1")
    values = [float(v) for v in data.split(" k")[0].split()[-4:]]
    # Mẫu separation đã chốt: (226, 200, 69, 34)/255.
    expected = [226 / 255, 200 / 255, 69 / 255, 34 / 255]
    for got, want, name in zip(values, expected, "CMYK"):
        assert abs(got - want) <= 1.5 / 255, f"kênh {name}: {got:.4f} vs mẫu {want:.4f}"


def test_spot_lab_without_profile_refuses_instead_of_guessing(tmp_path):
    """Không có profile CMYK thì KHÔNG đoán — trả về không hỗ trợ."""
    pdf = pikepdf.Pdf.new()
    lab = pikepdf.Array([
        pikepdf.Name("/Lab"),
        pikepdf.Dictionary(WhitePoint=[0.9642, 1.0, 0.8249], Range=[-128, 127, -128, 127]),
    ])
    fn = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[100, 0, 0], C1=[30, 10, -20], N=1,
        Range=[0, 100, -128, 127, -128, 127],
    )
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/SpotLab"),
        lab, pdf.make_indirect(fn),
    ])
    res = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=res,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/CS0 cs 1 scn 0 0 50 50 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "lab_nop.pdf"
    pdf.save(str(src))
    pdf.close()

    res_out = pdf_actions_native.convert_spot_to_cmyk(str(src), str(tmp_path / "o.pdf"))
    assert res_out["supported"] is False
    assert any("Lab" in b for b in res_out["blockers"]), res_out["blockers"]


def test_spot_to_cmyk_declines_postscript_tint_transform(tmp_path):
    """FunctionType 4 là chương trình PostScript — không đoán, từ chối an toàn."""
    pdf = pikepdf.Pdf.new()
    fn = pikepdf.Stream(pdf, b"{ dup 0.5 mul exch 0.2 mul 0 0 }")
    fn["/FunctionType"] = 4
    fn["/Domain"] = [0, 1]
    fn["/Range"] = [0, 1, 0, 1, 0, 1, 0, 1]
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/SpotX"),
        pikepdf.Name("/DeviceCMYK"), pdf.make_indirect(fn),
    ])
    res = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=res,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/CS0 cs 1 scn 0 0 50 50 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "ps_tint.pdf"
    pdf.save(str(src))
    pdf.close()

    res_out = pdf_actions_native.convert_spot_to_cmyk(str(src), str(tmp_path / "o.pdf"))
    assert res_out["supported"] is False
    assert res_out["blockers"]


def test_spot_to_cmyk_never_touches_none_colorant(tmp_path):
    """`/None` không phải màu pha — nó nghĩa là KHÔNG vẽ gì (§8.6.6.4)."""
    pdf = pikepdf.Pdf.new()
    tint = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=[1, 1, 1, 1], N=1,
        Range=[0, 1, 0, 1, 0, 1, 0, 1],
    )
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/None"),
        pikepdf.Name("/DeviceCMYK"), pdf.make_indirect(tint),
    ])
    res = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100], Resources=res,
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"/CS0 cs 1 scn 0 0 50 50 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "none_sep.pdf"
    pdf.save(str(src))
    pdf.close()
    out = tmp_path / "none_out.pdf"

    res_out = pdf_actions_native.convert_spot_to_cmyk(str(src), str(out))
    assert res_out["supported"] and res_out["ops"] == 0
    with pikepdf.open(str(out)) as opened:
        assert b"/CS0 cs" in bytes(opened.pages[0].Contents.read_bytes())


# ── Bảo vệ thành quả: action chỉ dùng engine nội bộ ─────────────────────────

def test_four_actions_use_internal_engines(tmp_path):
    """Bốn action phổ biến phải chạy bằng pikepdf trên đầu vào được hỗ trợ."""

    # Ảnh 1200 DPI + màu RGB + font base-14 + nét đen: đủ đầu vào cho cả 4.
    pdf = pikepdf.Pdf.new()
    img = _image_stream(pdf, 1200, 1200)
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"),
    )
    content = (
        b"q 72 0 0 72 10 10 cm /Im0 Do Q\n"
        b"1 0 0 rg 0 0 20 20 re f\n"
        b"0 0 0 1 k 5 5 8 8 re f\n"
        b"BT /F1 12 Tf 20 20 Td (x) Tj ET\n"
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img)),
            Font=pikepdf.Dictionary(F1=pdf.make_indirect(font)),
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, content)),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "internal_engine.pdf"
    pdf.save(str(src))
    pdf.close()

    engine = ActionEngine()
    for action in (
        "DOWNSCALE_IMAGES",
        "EMBED_FONTS",
        "CONVERT_TO_CMYK",
        "SET_BLACK_OVERPRINT",
    ):
        result = asyncio.run(engine.execute(str(src), action))
        assert result.success, f"{action} thất bại trên đường engine nội bộ"
        assert result.log[0].engine == "pikepdf", (
            f"{action} dùng sai engine {result.log[0].engine!r}"
        )


def test_downscale_refuses_when_no_image_can_be_processed(tmp_path, monkeypatch):
    """Không sửa được ảnh nào thì từ chối, không tạo file kết quả giả."""
    src = tmp_path / "blocked.pdf"
    _one_page_pdf(src)

    monkeypatch.setattr(
        pdf_actions_native,
        "downscale_images",
        lambda *_args, **_kwargs: {
            "changed": 0,
            "skipped": {"codec chưa hỗ trợ": 1},
            "details": [],
            "warnings": [],
        },
    )

    engine = ActionEngine()
    engine.output_dir = tmp_path
    result = asyncio.run(engine.execute(str(src), "DOWNSCALE_IMAGES"))

    # GS-SUNSET (audit 2026-08-08 §GS.2): ca không hỗ trợ phải dừng ngay bằng
    # contract InternalEngineUnsupported đã được execute chuyển thành refused.
    assert result.success is False
    assert result.output_path is None
    assert result.log[0].status == "refused"
    assert result.log[0].engine == "none"
    assert "dừng an toàn" in (result.error or "")
    assert not list(tmp_path.glob("blocked_DOWNSCALE_IMAGES_*.pdf"))


def test_resize_downsample_uses_internal_engine(tmp_path):
    """Đường resize dùng chung `downscale_images` phải chạy object-level."""
    from app.workers import pdf_tools_engine

    src = tmp_path / "big.pdf"
    out = tmp_path / "small.pdf"
    _one_page_pdf(src, img_w=1200, img_h=1200, placed_pt=72.0)

    assert pdf_tools_engine._native_downsample(str(src), str(out), 300) is True
    assert out.is_file() and out.stat().st_size > 0
