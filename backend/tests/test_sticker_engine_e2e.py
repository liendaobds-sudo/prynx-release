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


def test_sticker_output_page_fits_actual_bleed_without_white_safety_margin(src_pdf, tmp_path):
    """Bế tem phải xuất trang ôm mép bleed, không cộng canvas trắng 50pt/cạnh."""
    out = str(tmp_path / "sticker_tight_page.pdf")
    bleed_mm = 2.0

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src_pdf,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="miter",
        bleed_mm=bleed_mm,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        rectangle_mode=False,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        page = result.pages[0]
        media = [float(v) for v in page.MediaBox]
        crop = [float(v) for v in page.CropBox]
        trim = [float(v) for v in page.TrimBox]

        assert media == pytest.approx(crop, abs=0.01)
        media_w = media[2] - media[0]
        media_h = media[3] - media[1]
        trim_w = trim[2] - trim[0]
        trim_h = trim[3] - trim[1]
        # 2×bleed + 2×0.55pt guard cho stroke CutContour 1pt.
        expected_extra = 2 * bleed_mm * 72.0 / 25.4 + 1.10
        assert media_w - trim_w == pytest.approx(expected_extra, abs=0.6)
        assert media_h - trim_h == pytest.approx(expected_extra, abs=0.6)
        # Fixture có trang 297.6×419.5pt nhưng tem chỉ ở giữa: trang đầu ra phải
        # ôm tem, không giữ nguyên canvas nguồn hay cộng 100pt safety.
        assert media_w < 200
        assert media_h < 240

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
def test_sampled_bleed_stays_lossless_icc_rgb(src_pdf, tmp_path, bleed_color_type):
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
        for img in color_images:
            cs = img.get("/ColorSpace")
            assert isinstance(cs, pikepdf.Array)
            assert str(cs[0]) == "/ICCBased"
            profile = cs[1]
            assert int(profile.get("/N")) == 3
            assert len(profile.read_bytes()) > 0
            import io
            from PIL import ImageCms
            profile_name = ImageCms.getProfileName(
                ImageCms.getOpenProfile(io.BytesIO(profile.read_bytes()))
            ).lower()
            assert "srgb" in profile_name
            assert "adobe" not in profile_name
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


def test_compute_cut_bleed_offsets_no_double_bleed():
    """cut_mode=bleed: cut == outer == 1×bleed (không gấp đôi; cắt không nằm giữa vành)."""
    from app.workers.sticker_engine import compute_cut_bleed_offsets

    mm = 2.834645669  # ~1mm in pts
    bleed, offset = 3 * mm, 0.0

    # Theo mép tràn lề: cắt bao lề → cut = outer = 3mm, không 6mm.
    cut, outer = compute_cut_bleed_offsets("bleed", bleed, offset)
    assert abs(cut - bleed) < 1e-9
    assert abs(outer - bleed) < 1e-9
    assert abs(outer - cut) < 1e-9

    # Theo hình gốc: cắt tại 0, bù xén ra ngoài 3mm.
    cut_o, outer_o = compute_cut_bleed_offsets("original", bleed, offset)
    assert abs(cut_o - 0.0) < 1e-9
    assert abs(outer_o - bleed) < 1e-9

    # original + co/giãn: cut = offset, outer = offset + bleed.
    cut2, outer2 = compute_cut_bleed_offsets("original", bleed, -0.5 * mm)
    assert abs(cut2 - (-0.5 * mm)) < 1e-9
    assert abs(outer2 - (bleed - 0.5 * mm)) < 1e-9

    # bleed + offset dương: cả hai dịch cùng offset.
    cut3, outer3 = compute_cut_bleed_offsets("bleed", bleed, 1.0 * mm)
    assert abs(cut3 - (bleed + mm)) < 1e-9
    assert abs(outer3 - cut3) < 1e-9


def test_edge_color_source_uses_rim_not_core():
    """Nguồn màu viền phải là shell mép (đỏ), không hút ruột (xanh).

    REGRESSION: erode cả silhouette sâu hơn viền màu → nearest kéo màu lõi ra
    bleed (lệch 'màu viền tem').
    """
    import cv2
    import numpy as np
    from app.workers.sticker_engine import (
        _build_edge_color_source_mask,
        _nearest_color_fill,
    )

    h = w = 120
    mask = np.zeros((h, w), np.uint8)
    mask[20:100, 20:100] = 255
    img = np.zeros((h, w, 3), np.uint8)
    # Viền đỏ ~6px, ruột xanh.
    img[20:100, 20:100] = (220, 30, 30)
    img[26:94, 26:94] = (20, 40, 200)

    csm = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=1, edge_bite_px=0, kernel_type=cv2.MORPH_RECT,
    )
    assert np.count_nonzero(csm) > 0
    rim = img[csm > 0]
    # Pixel nguồn: R cao, B thấp (đỏ viền, không xanh ruột).
    assert float(rim[:, 0].mean()) > 150
    assert float(rim[:, 2].mean()) < 80

    filled = _nearest_color_fill(csm, img)
    # Điểm ngoài tem, gần cạnh trái → phải nhận đỏ viền.
    sample = filled[50, 5]
    assert int(sample[0]) > 150 and int(sample[2]) < 80, f"bleed lấy sai màu: {sample}"


def test_edge_color_source_skips_near_white_aa():
    """Pixel AA gần trắng trên mép không được làm nguồn → tránh bleed nhạt."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _build_edge_color_source_mask

    mask = np.zeros((80, 80), np.uint8)
    mask[20:60, 20:60] = 255
    img = np.zeros((80, 80, 3), np.uint8)
    img[20:60, 20:60] = (180, 40, 40)
    # 1px viền ngoài cùng = gần trắng (giả AA).
    img[20, 20:60] = (252, 250, 250)
    img[59, 20:60] = (252, 250, 250)
    img[20:60, 20] = (252, 250, 250)
    img[20:60, 59] = (252, 250, 250)

    csm = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=0, edge_bite_px=0, kernel_type=cv2.MORPH_RECT,
    )
    assert np.count_nonzero(csm) > 0
    rim = img[csm > 0]
    assert float(rim.min(axis=1).mean()) < 240, "nguồn vẫn toàn pixel trắng/AA"
    assert float(rim[:, 0].mean()) > 100


def _make_rectangle_white_edge_pdf(path: str, *, output_intent: bool = False):
    """Vector page with legitimate white trim edges and green artwork inside."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 60))
    page.Contents = pdf.make_stream(
        b"1 1 1 rg 0 0 100 60 re f\n"
        b"0 0.6 0 rg 12 10 76 40 re f\n"
    )
    profile_bytes = None
    if output_intent:
        profile_path = os.path.join(
            os.path.dirname(__file__), "..", "app", "assets", "icc", "FOGRA39.icc"
        )
        with open(profile_path, "rb") as fh:
            profile_bytes = fh.read()
        profile = pdf.make_stream(profile_bytes)
        profile[pikepdf.Name("/N")] = 4
        intent = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OutputIntent"),
            "/S": pikepdf.Name("/GTS_PDFX"),
            "/OutputConditionIdentifier": "FOGRA39",
            "/DestOutputProfile": profile,
        }))
        pdf.Root[pikepdf.Name("/OutputIntents")] = pikepdf.Array([intent])
    pdf.save(path)
    return profile_bytes


def test_rectangle_image_bleed_preserves_true_white_edge_and_stays_vector(tmp_path):
    """Rectangle edge stretch must not discard legitimate white page-edge pixels."""
    import numpy as np
    import pypdfium2 as pdfium

    src = str(tmp_path / "rect_white.pdf")
    out = str(tmp_path / "rect_white_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=3.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as pdf:
        page = pdf.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        assert xobjects
        assert all(str(xobjects[name].get("/Subtype")) == "/Form" for name in xobjects)
        assert _read_all_content(page).count(b" Do") >= 9  # 8 edge/corner strips + artwork

    rendered = pdfium.PdfDocument(out)
    pixels = rendered[0].render(scale=4, rev_byteorder=True).to_numpy()
    mid_y, mid_x = pixels.shape[0] // 2, pixels.shape[1] // 2
    # Far inside the left bleed: exact source edge is white, not green from the core.
    assert np.all(pixels[mid_y, 5, :3] >= 250), pixels[mid_y, 5, :3]
    # Original center artwork remains green and vector-sharp.
    center = pixels[mid_y, mid_x, :3]
    assert int(center[1]) > 120 and int(center[0]) < 20 and int(center[2]) < 20


@pytest.mark.parametrize("edge_bite_mm", [0.0, 0.6, 2.0])
def test_rectangle_edge_bite_never_changes_finished_size(tmp_path, edge_bite_mm):
    """Edge inset may replace only the configured inner strip; it must never crop the page."""
    pt_per_mm = 72.0 / 25.4
    src = str(tmp_path / f"card_{edge_bite_mm}.pdf")
    out = str(tmp_path / f"card_bleed_{edge_bite_mm}.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(89.0 * pt_per_mm, 51.0 * pt_per_mm))
    page.Contents = pdf.make_stream(
        b"1 1 1 rg 0 0 252.283 144.567 re f\n"
        b"0 0.6 0 rg 126.142 0 126.142 144.567 re f\n"
    )
    pdf.save(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=edge_bite_mm,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        media = [float(v) for v in result.pages[0].MediaBox]
        width_mm = (media[2] - media[0]) / pt_per_mm
        height_mm = (media[3] - media[1]) / pt_per_mm
        assert width_mm == pytest.approx(93.0, abs=0.02)
        assert height_mm == pytest.approx(55.0, abs=0.02)

def test_rectangle_source_mask_can_preserve_legitimate_white():
    """White suppression is sticker-only; rectangle raster modes keep true white."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _build_edge_color_source_mask

    mask = np.zeros((40, 40), np.uint8)
    mask[5:35, 5:35] = 255
    img = np.full((40, 40, 3), 255, np.uint8)
    img[5:8, 10:15] = (20, 150, 30)  # ensure white-filtered shell is not empty

    keep_white = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=0, kernel_type=cv2.MORPH_RECT,
        exclude_near_white=False,
    )
    strip_white = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=0, kernel_type=cv2.MORPH_RECT,
        exclude_near_white=True,
    )
    assert keep_white[5, 20] > 0
    assert strip_white[5, 20] == 0


def test_rectangle_vector_bleed_preserves_output_intent(tmp_path):
    """Rebuilding the PDF must retain the source printing/output ICC profile."""
    src = str(tmp_path / "rect_output_intent.pdf")
    out = str(tmp_path / "rect_output_intent_bleed.pdf")
    expected_profile = _make_rectangle_white_edge_pdf(src, output_intent=True)

    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as pdf:
        intents = pdf.Root.get("/OutputIntents")
        assert intents and len(intents) == 1
        assert str(intents[0].get("/OutputConditionIdentifier")) == "FOGRA39"
        assert intents[0].get("/DestOutputProfile").read_bytes() == expected_profile


def test_rectangle_vector_bleed_keeps_spot_colorspace(tmp_path):
    """Vector edge strips must retain Separation/spot resources without RGB flattening."""
    src = str(tmp_path / "rect_spot.pdf")
    out = str(tmp_path / "rect_spot_bleed.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 60))
    tint = pdf.make_indirect(pikepdf.Dictionary({
        "/FunctionType": 2,
        "/Domain": [0.0, 1.0],
        "/C0": [0.0, 0.0, 0.0, 0.0],
        "/C1": [0.8, 0.0, 0.9, 0.1],
        "/N": 1.0,
    }))
    spot = pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/BrandGreen"),
        pikepdf.Name("/DeviceCMYK"),
        tint,
    ])
    page.Resources = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({"/SpotEdge": spot}),
    })
    page.Contents = pdf.make_stream(b"/SpotEdge cs 1 scn 0 0 100 60 re f\n")
    pdf.save(src)

    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        forms = [xobjects[name] for name in xobjects if str(xobjects[name].get("/Subtype")) == "/Form"]
        assert len(forms) == 1
        source_form = forms[0]
        spot_out = source_form.Resources.get("/ColorSpace").get("/SpotEdge")
        assert str(spot_out[0]) == "/Separation"
        assert str(spot_out[1]) == "/BrandGreen"
        assert str(spot_out[2]) == "/DeviceCMYK"
        assert b"/SpotEdge cs 1 scn" in source_form.read_bytes()


def test_rectangle_smooth_fill_is_bounded_and_preserves_page_size():
    """Smart smoothing must not invent saturated colors outside the source gamut."""
    import numpy as np
    from app.workers.sticker_engine import _rectangle_smooth_color_fill

    img = np.full((24, 40, 3), 255, dtype=np.uint8)
    img[4:20, 6:34] = (82, 169, 51)
    img[:, -4:] = (44, 132, 16)
    pad = 7
    out = _rectangle_smooth_color_fill(
        img, pad_px=pad, edge_bite_px=2, px_per_mm=12.0
    )

    assert out.shape == (img.shape[0] + 2 * pad, img.shape[1] + 2 * pad, 3)
    src_min = img.reshape(-1, 3).min(axis=0)
    src_max = img.reshape(-1, 3).max(axis=0)
    assert np.all(out.reshape(-1, 3).min(axis=0) >= src_min)
    assert np.all(out.reshape(-1, 3).max(axis=0) <= src_max)
    # A real white trim edge remains white instead of being replaced by core color.
    assert np.all(out[out.shape[0] // 2, 0] == 255)


def test_rectangle_smooth_fill_continues_diagonal_color_trajectory():
    """Smart smoothing should follow an oblique band better than edge extrusion."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _rectangle_smooth_color_fill

    h, w, pad = 120, 180, 30
    yy, xx = np.mgrid[-pad:h + pad, -pad:w + pad]
    phase = (xx + 0.65 * yy) / 18.0
    ideal = np.stack([
        128 + 100 * np.sin(phase),
        128 + 95 * np.sin(phase + 2.1),
        128 + 90 * np.sin(phase + 4.2),
    ], axis=2).clip(0, 255).astype(np.uint8)
    core = ideal[pad:pad + h, pad:pad + w]

    smart = _rectangle_smooth_color_fill(core, pad, 0, 12.0)
    stretched = cv2.copyMakeBorder(core, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    ring = np.ones(ideal.shape[:2], dtype=bool)
    ring[pad:pad + h, pad:pad + w] = False
    smart_error = np.abs(smart.astype(np.int16) - ideal.astype(np.int16))[ring].mean()
    stretch_error = np.abs(stretched.astype(np.int16) - ideal.astype(np.int16))[ring].mean()
    assert smart_error < stretch_error * 0.60, (smart_error, stretch_error)


def test_rectangle_inpaint_uses_true_srgb_and_keeps_white_edge(tmp_path):
    """Rectangle smart smoothing should render predictably without Adobe-RGB cast."""
    import io
    import numpy as np
    import pypdfium2 as pdfium
    from PIL import ImageCms

    src = str(tmp_path / "rect_smooth.pdf")
    out = str(tmp_path / "rect_smooth_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=3.0,
        bleed_color_type="inpaint",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        color_images = [
            xobjects[name]
            for name in xobjects
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
        ]
        assert color_images
        cs = color_images[0].get("/ColorSpace")
        assert isinstance(cs, pikepdf.Array) and str(cs[0]) == "/ICCBased"
        profile_name = ImageCms.getProfileName(
            ImageCms.getOpenProfile(io.BytesIO(cs[1].read_bytes()))
        ).lower()
        assert "srgb" in profile_name
        assert "adobe" not in profile_name

    rendered = pdfium.PdfDocument(out)
    pixels = rendered[0].render(scale=4, rev_byteorder=True).to_numpy()
    mid_y, mid_x = pixels.shape[0] // 2, pixels.shape[1] // 2
    assert np.all(pixels[mid_y, 5, :3] >= 250), pixels[mid_y, 5, :3]
    center = pixels[mid_y, mid_x, :3]
    assert int(center[1]) > 120 and int(center[0]) < 20 and int(center[2]) < 20


def test_rectangle_inpaint_uses_color_managed_page_renderer(monkeypatch, tmp_path):
    """The smart rectangle path must sample the composited page, not PDFium RGB."""
    import numpy as np
    import app.workers.sticker_engine as sticker_module

    src = str(tmp_path / "rect_renderer.pdf")
    out = str(tmp_path / "rect_renderer_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)
    sampled_rgb = np.array([23, 101, 207], dtype=np.uint8)
    calls = []

    def fake_renderer(input_path, page_index, scale, expected_width, expected_height):
        calls.append((input_path, page_index, scale, expected_width, expected_height))
        return np.full(
            (expected_height, expected_width, 3), sampled_rgb, dtype=np.uint8
        )

    monkeypatch.setattr(
        sticker_module, "_render_page_rgb_ghostscript", fake_renderer
    )
    success, _meta = sticker_module.StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="inpaint",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True
    assert calls and calls[0][1] == 0
    assert calls[0][3] > 0 and calls[0][4] > 0

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        color_images = [
            xobjects[name]
            for name in xobjects
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
        ]
        assert color_images
        image = color_images[0]
        pixels = np.frombuffer(image.read_bytes(), dtype=np.uint8).reshape(
            int(image.get("/Height")), int(image.get("/Width")), 3
        )
        assert np.all(pixels[0, 0] == sampled_rgb)
        assert np.all(pixels[-1, -1] == sampled_rgb)


def test_rectangle_inpaint_falls_back_when_ghostscript_is_unavailable(
    monkeypatch, tmp_path
):
    """Missing Ghostscript must degrade to PDFium instead of failing the job."""
    import app.workers.sticker_engine as sticker_module

    src = str(tmp_path / "rect_fallback.pdf")
    out = str(tmp_path / "rect_fallback_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)
    monkeypatch.setattr(
        sticker_module,
        "_render_page_rgb_ghostscript",
        lambda *_args, **_kwargs: None,
    )

    success, _meta = sticker_module.StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="inpaint",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True
    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        assert any(
            str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
            for name in xobjects
        )
