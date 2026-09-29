"""Test kiểm tra tính toàn vẹn hệ màu DeviceCMYK cho tính năng bù xén (Bleed).

Đảm bảo khi nguồn là tài liệu CMYK (chuẩn chế bản nhà in):
- Dải bù xén (bleed) được tạo ở hệ màu DeviceCMYK 4 kênh (C, M, Y, K).
- Màu mực in của kẽm Cyan/Magenta/Yellow/Black ở dải bù xén khớp 100% với mép con tem.
- Con tem vector gốc giữ nguyên Form XObject (không bao giờ bị flatten sang sRGB).
- Không nhúng sRGB OutputIntent đè lên file CMYK in ấn.
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pikepdf
import pytest

from app.workers.sticker_engine import StickerEngine


def _create_pure_cmyk_stamp_pdf(path: Path) -> None:
    """Tạo PDF vector kích thước 60x60 pt chứa 1 con tem hình vuông màu Pure Cyan (100% C, 0% M, 0% Y, 0% K)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(60, 60))
    # Nền trong suốt hoặc trắng, vẽ hình vuông Cyan 40x40 ở giữa: (10, 10) đến (50, 50)
    # 1 0 0 0 k: đặt màu CMYK (C=1, M=0, Y=0, K=0)
    content_stream = b"""
1 0 0 0 k
10 10 40 40 re
f
"""
    page.Contents = pdf.make_stream(content_stream)
    pdf.save(path)
    pdf.close()


def _create_pure_cmyk_circle_stamp_pdf(path: Path) -> None:
    """Tạo PDF vector kích thước 80x80 pt chứa hình tròn màu Pure Magenta (0% C, 100% M, 0% Y, 0% K)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(80, 80))
    # Vẽ hình chữ nhật/elip Magenta ở giữa
    content_stream = b"""
0 1 0 0 k
20 20 40 40 re
f
"""
    page.Contents = pdf.make_stream(content_stream)
    pdf.save(path)
    pdf.close()


@pytest.mark.parametrize("bleed_mode", ["image", "trajectory", "inpaint"])
def test_cmyk_bleed_preserves_device_cmyk_and_pure_inks(tmp_path: Path, bleed_mode: str) -> None:
    input_pdf = tmp_path / f"pure_cmyk_{bleed_mode}.pdf"
    output_pdf = tmp_path / f"pure_cmyk_{bleed_mode}_out.pdf"
    _create_pure_cmyk_stamp_pdf(input_pdf)

    engine = StickerEngine(dpi=150)
    success, meta = engine.process_pdf(
        input_path=str(input_pdf),
        output_path=str(output_pdf),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=2.0,
        bleed_color_type=bleed_mode,
        draw_cut_contour=True,
        remove_white_bg=True,
    )

    assert success is True, "StickerEngine phải xử lý thành công"
    assert meta["color_render_strategy"] == "vector-original", "Artwork gốc phải giữ nguyên vector"

    with pikepdf.Pdf.open(output_pdf) as out_doc:
        page = out_doc.pages[0]
        xobjects = page.Resources.get("/XObject", {})

        # 1. Kiểm tra ảnh bù xén (bleed image)
        bleed_images = []
        for name, obj in xobjects.items():
            if str(obj.get("/Subtype")) == "/Image" and str(obj.get("/ColorSpace")) != "/DeviceGray":
                bleed_images.append(obj)

        assert len(bleed_images) >= 1, "Phải có ít nhất 1 ảnh bù xén"
        bleed_img = bleed_images[0]

        # Kiểm tra ColorSpace phải là /DeviceCMYK
        cs = bleed_img.get("/ColorSpace")
        assert str(cs) in {"/DeviceCMYK", "/CMYK"}, f"Ảnh bù xén phải ở hệ màu DeviceCMYK, thực tế: {cs}"

        # 2. Đọc byte dữ liệu của ảnh bù xén
        raw_bytes = bleed_img.read_bytes()
        width = int(bleed_img.Width)
        height = int(bleed_img.Height)
        assert len(raw_bytes) == width * height * 4, "Dữ liệu ảnh bù xén phải có 4 kênh (C, M, Y, K)"

        cmyk_data = np.frombuffer(raw_bytes, dtype=np.uint8).reshape((height, width, 4))
        # Kênh 0: Cyan, Kênh 1: Magenta, Kênh 2: Yellow, Kênh 3: Black
        cyan_channel = cmyk_data[:, :, 0]
        magenta_channel = cmyk_data[:, :, 1]
        yellow_channel = cmyk_data[:, :, 2]
        black_channel = cmyk_data[:, :, 3]

        # Tem gốc là Pure Cyan:
        # Trong vùng dải bù xén, kênh Cyan phải có giá trị cao (khoảng 255),
        # còn các kênh Magenta, Yellow, Black KHÔNG ĐƯỢC bị nhiễm tạp chất!
        max_cyan = int(cyan_channel.max())
        assert max_cyan >= 200, f"Dải bù xén phải chứa mực Cyan của tem gốc (max Cyan={max_cyan})"

        # Các kẽm M, Y, K ở các pixel có Cyan phải gần 0 (không bị đổi màu ngả đục như sRGB->CMYK)
        cyan_pixels = cyan_channel > 150
        assert magenta_channel[cyan_pixels].max() <= 10, "Kẽm Magenta không được nhiễm tạp chất mực"
        assert yellow_channel[cyan_pixels].max() <= 10, "Kẽm Yellow không được nhiễm tạp chất mực"
        assert black_channel[cyan_pixels].max() <= 10, "Kẽm Black không được nhiễm tạp chất mực"

        # 3. Kiểm tra artwork vector gốc vẫn tồn tại dưới dạng Form XObject
        forms = [obj for _, obj in xobjects.items() if str(obj.get("/Subtype")) == "/Form"]
        assert len(forms) >= 1, "Artwork gốc phải giữ nguyên dưới dạng Form XObject vector"

        # 4. Kiểm tra OutputIntent không bị ghi đè sRGB
        intents = out_doc.Root.get("/OutputIntents")
        if intents:
            assert intents[0].get("/OutputConditionIdentifier") != "sRGB", "Không được nhúng sRGB OutputIntent vào file in CMYK"


def test_cmyk_solid_color_bleed(tmp_path: Path) -> None:
    input_pdf = tmp_path / "cmyk_solid.pdf"
    output_pdf = tmp_path / "cmyk_solid_out.pdf"
    _create_pure_cmyk_stamp_pdf(input_pdf)

    engine = StickerEngine(dpi=150)
    # Bù xén màu đơn sắc CMYK: 100% Yellow (0, 0, 255, 0)
    success, meta = engine.process_pdf(
        input_path=str(input_pdf),
        output_path=str(output_pdf),
        cut_mode="original",
        bleed_mm=2.0,
        bleed_color_type="solid",
        solid_bleed_color=(0, 0, 255, 0),
        draw_cut_contour=True,
    )

    assert success is True
    with pikepdf.Pdf.open(output_pdf) as out_doc:
        page = out_doc.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        bleed_images = [
            obj for _, obj in xobjects.items()
            if str(obj.get("/Subtype")) == "/Image" and str(obj.get("/ColorSpace")) != "/DeviceGray"
        ]
        assert bleed_images
        bleed_img = bleed_images[0]
        assert str(bleed_img.get("/ColorSpace")) in {"/DeviceCMYK", "/CMYK"}
        raw_bytes = bleed_img.read_bytes()
        arr = np.frombuffer(raw_bytes, dtype=np.uint8).reshape((int(bleed_img.Height), int(bleed_img.Width), 4))
        # Kênh Yellow = 255, C=0, M=0, K=0
        assert arr[:, :, 2].max() == 255
        assert arr[:, :, 0].max() == 0
        assert arr[:, :, 1].max() == 0
        assert arr[:, :, 3].max() == 0


def test_cmyk_rectangle_mode_trajectory(tmp_path: Path) -> None:
    """Kiểm tra bù xén chế độ hộp/hình chữ nhật (rectangle_mode) cho tài liệu CMYK."""
    input_pdf = tmp_path / "cmyk_rect.pdf"
    output_pdf = tmp_path / "cmyk_rect_out.pdf"
    # File tràn lề toàn trang 100x100
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    page.Contents = pdf.make_stream(b"1 0 0 0 k\n0 0 100 100 re\nf\n")
    pdf.save(input_pdf)
    pdf.close()

    engine = StickerEngine(dpi=150)
    success, meta = engine.process_pdf(
        input_path=str(input_pdf),
        output_path=str(output_pdf),
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="trajectory",
        rectangle_mode=True,
        draw_cut_contour=False,
    )

    assert success is True
    assert meta["color_render_strategy"] == "vector-original"
    with pikepdf.Pdf.open(output_pdf) as out_doc:
        page = out_doc.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        bleed_images = [
            obj for _, obj in xobjects.items()
            if str(obj.get("/Subtype")) == "/Image" and str(obj.get("/ColorSpace")) != "/DeviceGray"
        ]
        assert bleed_images
        bleed_img = bleed_images[0]
        assert str(bleed_img.get("/ColorSpace")) in {"/DeviceCMYK", "/CMYK"}
        arr = np.frombuffer(bleed_img.read_bytes(), dtype=np.uint8).reshape((int(bleed_img.Height), int(bleed_img.Width), 4))
        assert arr[:, :, 0].max() >= 200, "Dải bù xén chữ nhật phải mang mực Cyan"


def test_rgb_source_preserves_rgb_bleed(tmp_path: Path) -> None:
    """Bảo đảm tài liệu nguồn là RGB thuần túy vẫn tạo ảnh bù xén sRGB như cũ (không hồi quy)."""
    input_pdf = tmp_path / "rgb_source.pdf"
    output_pdf = tmp_path / "rgb_source_out.pdf"
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(60, 60))
    # 0 0 1 rg: vẽ hình vuông Blue RGB
    page.Contents = pdf.make_stream(b"0 0 1 rg\n10 10 40 40 re\nf\n")
    pdf.save(input_pdf)
    pdf.close()

    engine = StickerEngine(dpi=150)
    success, meta = engine.process_pdf(
        input_path=str(input_pdf),
        output_path=str(output_pdf),
        cut_mode="original",
        bleed_mm=2.0,
        bleed_color_type="image",
        remove_white_bg=True,
    )

    assert success is True
    with pikepdf.Pdf.open(output_pdf) as out_doc:
        page = out_doc.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        bleed_images = [
            obj for _, obj in xobjects.items()
            if str(obj.get("/Subtype")) == "/Image" and str(obj.get("/ColorSpace")) != "/DeviceGray"
        ]
        assert bleed_images
        bleed_img = bleed_images[0]
        cs = bleed_img.get("/ColorSpace")
        # Với file RGB: ColorSpace phải là /ICCBased sRGB hoặc /DeviceRGB
        assert (
            (isinstance(cs, pikepdf.Array) and str(cs[0]) == "/ICCBased")
            or str(cs) == "/DeviceRGB"
        ), f"File nguồn RGB phải giữ ColorSpace sRGB, thực tế: {cs}"

