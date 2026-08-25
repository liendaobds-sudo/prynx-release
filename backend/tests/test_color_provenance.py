"""Regression cho hợp đồng màu của luồng bù xén/Tách tem."""

from __future__ import annotations

import zlib
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from app.core.color_provenance import (
    COLOR_PROFILE_MISSING_WARNING,
    describe_color_provenance,
    embed_srgb_output_intent,
)
from app.workers.sticker_engine import (
    StickerEngine,
    _enforce_rectangle_edge_continuity,
)
from app.workers.sticker_sheet_export import _merge_pdf_fragments, _png_pages_to_pdf


def _make_untagged_cmyk_pdf(path: Path) -> None:
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(20, 20))
    image = pikepdf.Stream(document, zlib.compress(bytes((0, 255, 255, 0))))
    image[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    image[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    image[pikepdf.Name("/Width")] = 1
    image[pikepdf.Name("/Height")] = 1
    image[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceCMYK")
    image[pikepdf.Name("/BitsPerComponent")] = 8
    image[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im=document.make_indirect(image)),
    )
    page.Contents = pikepdf.Stream(document, b"q 20 0 0 20 0 0 cm /Im Do Q")
    document.save(path)
    document.close()


def _make_renderable_untagged_cmyk_pdf(path: Path) -> None:
    """Fixture nhỏ có ảnh DeviceCMYK thật để chạy xuyên qua StickerEngine."""
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(100, 60))
    width, height = 32, 20
    raw = bytes((0, 255, 255, 0)) * (width * height)
    image = pikepdf.Stream(document, zlib.compress(raw))
    image[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    image[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    image[pikepdf.Name("/Width")] = width
    image[pikepdf.Name("/Height")] = height
    image[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceCMYK")
    image[pikepdf.Name("/BitsPerComponent")] = 8
    image[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im=document.make_indirect(image)),
    )
    page.Contents = document.make_stream(b"q 100 0 0 60 0 0 cm /Im Do Q")
    document.save(path)
    document.close()


def _make_renderable_mixed_devicen_pdf(path: Path) -> None:
    """Fixture mixed CMYK + Separation để khóa nhánh giữ Form/vector gốc."""
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(100, 60))
    width, height = 32, 20
    cmyk_raw = bytes((0, 255, 255, 0)) * (width * height)
    cmyk = pikepdf.Stream(document, zlib.compress(cmyk_raw))
    cmyk[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    cmyk[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    cmyk[pikepdf.Name("/Width")] = width
    cmyk[pikepdf.Name("/Height")] = height
    cmyk[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceCMYK")
    cmyk[pikepdf.Name("/BitsPerComponent")] = 8
    cmyk[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")

    tint = document.make_indirect(pikepdf.Dictionary({
        "/FunctionType": 2,
        "/Domain": [0.0, 1.0],
        "/C0": [0.0, 0.0, 0.0, 0.0],
        "/C1": [0.2, 0.0, 0.8, 0.0],
        "/N": 1.0,
    }))
    spot = pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/BrandBlue"),
        pikepdf.Name("/DeviceCMYK"),
        tint,
    ])
    spot_image = pikepdf.Stream(document, zlib.compress(bytes((255,))))
    spot_image[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    spot_image[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    spot_image[pikepdf.Name("/Width")] = 1
    spot_image[pikepdf.Name("/Height")] = 1
    spot_image[pikepdf.Name("/ColorSpace")] = spot
    spot_image[pikepdf.Name("/BitsPerComponent")] = 8
    spot_image[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(
            Im=document.make_indirect(cmyk),
            Spot=document.make_indirect(spot_image),
        ),
    )
    page.Contents = document.make_stream(
        b"q 100 0 0 60 0 0 cm /Im Do Q\nq 1 0 0 1 0 0 cm /Spot Do Q"
    )
    document.save(path)
    document.close()


def _make_embedded_cmyk_pdf(path: Path) -> None:
    """Fixture ICCBased CMYK nằm trong ảnh, không khai OutputIntent catalog."""
    profile_path = Path(__file__).parents[1] / "app" / "assets" / "icc" / "FOGRA39.icc"
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(20, 20))
    profile = document.make_stream(profile_path.read_bytes())
    profile[pikepdf.Name("/N")] = 4
    image = pikepdf.Stream(document, zlib.compress(bytes((0, 255, 255, 0))))
    image[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    image[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    image[pikepdf.Name("/Width")] = 1
    image[pikepdf.Name("/Height")] = 1
    image[pikepdf.Name("/ColorSpace")] = pikepdf.Array(
        [pikepdf.Name("/ICCBased"), profile]
    )
    image[pikepdf.Name("/BitsPerComponent")] = 8
    image[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im=document.make_indirect(image)),
    )
    page.Contents = document.make_stream(b"q 20 0 0 20 0 0 cm /Im Do Q")
    document.save(path)
    document.close()


def test_untagged_device_cmyk_is_explicitly_flagged(tmp_path: Path) -> None:
    source = tmp_path / "untagged.pdf"
    _make_untagged_cmyk_pdf(source)

    descriptor = describe_color_provenance(source)

    assert descriptor["profile_state"] == "untagged-device-cmyk"
    assert descriptor["has_device_cmyk"] is True
    assert COLOR_PROFILE_MISSING_WARNING in descriptor["warnings"]


def test_embedded_cmyk_profile_is_not_treated_as_bare_device_cmyk(
    tmp_path: Path,
) -> None:
    source = tmp_path / "embedded-cmyk.pdf"
    _make_embedded_cmyk_pdf(source)

    descriptor = describe_color_provenance(source)

    assert descriptor["profile_state"] == "tagged"
    assert descriptor["has_embedded_cmyk_profile"] is True
    assert COLOR_PROFILE_MISSING_WARNING not in descriptor["warnings"]


@pytest.mark.parametrize("bleed_color_type", ["trajectory", "solid"])
def test_engine_keeps_rendered_rgb_bleed_for_untagged_source(
    tmp_path: Path,
    bleed_color_type: str,
) -> None:
    source = tmp_path / "untagged-renderable.pdf"
    output = tmp_path / "untagged-renderable-bleed.pdf"
    _make_renderable_untagged_cmyk_pdf(source)

    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type=bleed_color_type,
       draw_cut_contour=False,
       rectangle_mode=True,
        edge_bite_mm=0.5,
   )

    assert success is True
    assert meta["color_provenance"]["profile_state"] == "untagged-device-cmyk"
    assert "COLOR_PROFILE_MISSING" in meta["color_warnings"]
    assert "COLOR_DEVICE_CMYK_FALLBACK" in meta["color_warnings"]
    if bleed_color_type == "trajectory":
        # Nguồn CMYK không có ICC không được ghép Form CMYK cạnh dải RGB:
        # engine phải flatten trên cùng lưới sRGB để PDFium/RIP không tạo seam.
        assert meta["color_render_strategy"] == "flattened-rgb"
    else:
        assert meta["color_render_strategy"] == "vector-original"
    with pikepdf.Pdf.open(output) as document:
        xobjects = document.pages[0].Resources.get("/XObject", {})
        images = [
            xobjects[name]
            for name in xobjects
            for obj in (xobjects[name],)
            if str(obj.get("/Subtype")) == "/Image"
            and str(obj.get("/ColorSpace")) != "/DeviceGray"
        ]
        assert images
        bleed_images = [
            obj
            for obj in images
            if isinstance(obj.get("/ColorSpace"), pikepdf.Array)
            and str(obj.get("/ColorSpace")[0]) == "/ICCBased"
        ]
        assert bleed_images, (
            "Bleed lấy mẫu phải giữ ICCBased sRGB để seam khớp render artwork."
        )
        if bleed_color_type == "trajectory":
            assert all(obj.get("/SMask") is None for obj in bleed_images)
            assert len(bleed_images) == 1
            intents = document.Root.get("/OutputIntents")
            assert intents and intents[0].get("/OutputConditionIdentifier") == "sRGB"
            assert not any(
                str(obj.get("/Subtype")) == "/Form"
                for _, obj in xobjects.items()
            )
        else:
            assert any(obj.get("/SMask") is not None for obj in bleed_images)


@pytest.mark.parametrize("bleed_color_type", ["trajectory", "inpaint"])
def test_mixed_devicen_cmyk_keeps_original_artwork_form(
    tmp_path: Path, bleed_color_type: str
) -> None:
    source = tmp_path / "mixed-devicen-cmyk.pdf"
    output = tmp_path / f"mixed-devicen-cmyk-{bleed_color_type}.pdf"
    _make_renderable_mixed_devicen_pdf(source)

    success, meta = StickerEngine(dpi=96).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type=bleed_color_type,
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.5,
    )

    assert success is True
    assert meta["color_render_strategy"] == "vector-original"
    assert "COLOR_DEVICEN_FALLBACK" in meta["color_warnings"]
    with pikepdf.Pdf.open(output) as document:
        xobjects = document.pages[0].Resources.get("/XObject", {})
        form_items = [
            (name, xobjects[name])
            for name in xobjects
            if str(xobjects[name].get("/Subtype")) == "/Form"
        ]
        assert len(form_items) == 1
        assert not any(
            str(xobjects[name].get("/Subtype")) == "/Image"
            for name in xobjects
        )
        form_name, source_form = form_items[0]
        assert b"/Im Do" in source_form.read_bytes()

        # QUALITY (audit 2026-08-25 §BCOLOR.09): Form gốc phải được vẽ trước,
        # rồi tám dải bù xén mới chồng mí rất hẹp vào mép. Nếu đảo thứ tự hoặc
        # bỏ overlap, PDFium/RIP có thể tạo một hairline trắng ngay ranh trim.
        page_contents = document.pages[0].Contents
        content = (
            b"\n".join(stream.read_bytes() for stream in page_contents)
            if isinstance(page_contents, pikepdf.Array)
            else page_contents.read_bytes()
        )
        assert b"None Do" not in content
        form_draw = f"{form_name} Do".encode("ascii")
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        draw_indexes = [
            index for index, line in enumerate(lines) if line == form_draw
        ]
        assert len(draw_indexes) == 9
        assert lines[draw_indexes[0] - 1].startswith(b"1 0 0 1 ")

        left_strip_clip = lines[draw_indexes[1] - 2].split()
        assert left_strip_clip[-3:] == [b"re", b"W", b"n"]
        requested_fill_pts = (2.0 + 0.5) * 2.83465
        overlap_pts = float(left_strip_clip[2]) - requested_fill_pts
        assert 0.0 < overlap_pts <= 72.0 / 96.0


def test_srgb_output_intent_round_trip(tmp_path: Path) -> None:
    source = tmp_path / "rgb.pdf"
    document = pikepdf.Pdf.new()
    document.add_blank_page(page_size=(20, 20))
    assert embed_srgb_output_intent(document) is True
    document.save(source)
    document.close()

    descriptor = describe_color_provenance(source)

    assert descriptor["profile_state"] == "tagged"
    assert descriptor["output_intent_count"] == 1
    assert descriptor["output_intent_profile_sha256"]


def test_png_bridge_is_tagged_srgb_and_merge_keeps_intent(tmp_path: Path) -> None:
    png = tmp_path / "page.png"
    Image.new("RGBA", (4, 4), (180, 120, 40, 255)).save(png)
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.pdf"
    merged = tmp_path / "merged.pdf"

    _png_pages_to_pdf([png], first, 96.0, 96.0)
    _png_pages_to_pdf([png], second, 96.0, 96.0)
    _merge_pdf_fragments([first, second], merged)

    with pikepdf.Pdf.open(merged) as document:
        intents = document.Root.get("/OutputIntents")
        assert intents is not None
        assert len(intents) == 1
        assert intents[0].get("/DestOutputProfile")
        assert len(document.pages) == 2


@pytest.mark.parametrize("extension", [".png", ".jpg"])
def test_raster_descriptor_keeps_rgb_contract(tmp_path: Path, extension: str) -> None:
    source = tmp_path / f"source{extension}"
    image = Image.new("RGB", (2, 2), (20, 30, 40))
    image.save(source)

    descriptor = describe_color_provenance(source)

    assert descriptor["source_kind"] == "raster"
    assert descriptor["profile_state"] == "rgb"
    assert descriptor["warnings"] == []

def test_unprofiled_rectangle_continuity_keeps_trim_edge_rgb() -> None:
    import numpy as np

    source = np.zeros((12, 20, 3), dtype=np.uint8)
    source[:] = (8, 92, 142)
    source[:, -1] = (18, 105, 155)
    filled = np.zeros((16, 24, 3), dtype=np.uint8)
    # Texture ở phần ngoài dải phải được giữ nguyên, không bị biến thành
    # một màu trung bình khi helper neo pixel ranh trim.
    filled[2:14, 0] = (210, 30, 70)

    result = _enforce_rectangle_edge_continuity(
        filled,
        source,
        pad_px=2,
        edge_bite_px=2,
        pads=(2, 2, 2, 2),
    )

    assert np.array_equal(result[2:14, 2:22], source)
    assert np.array_equal(result[2:14, 1], source[:, 0])
    assert np.array_equal(result[2:14, 22], source[:, -1])
    assert np.array_equal(result[2:14, 0], filled[2:14, 0])
