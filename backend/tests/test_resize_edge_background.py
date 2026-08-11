"""Regression cho pipeline dò mép → fit → kéo nền → đặt artwork vector."""

from __future__ import annotations

import json
import os
import re

import numpy as np
import pikepdf
import pytest
from PIL import Image

from app.core.pdf_actions_native import detect_transparent_pages
from app.workers.resize_background_engine import resize_pages_with_background


PT_PER_MM = 72.0 / 25.4
TARGET_W_MM = 40.0
TARGET_H_MM = 80.0


def _add_artwork_page(
    pdf: pikepdf.Pdf,
    *,
    page_size: tuple[float, float] = (240.0, 220.0),
    content_box: tuple[float, float, float, float] = (50.0, 70.0, 190.0, 150.0),
    crop_box: tuple[float, float, float, float] | None = None,
    rotate: int = 0,
):
    page = pdf.add_blank_page(page_size=page_size)
    x0, y0, x1, y1 = content_box
    marker_w = max(4.0, (x1 - x0) * 0.18)
    marker_h = max(4.0, (y1 - y0) * 0.18)
    marker_x = (x0 + x1 - marker_w) / 2.0
    marker_y = (y0 + y1 - marker_h) / 2.0
    page.Contents = pdf.make_stream(
        (
            f"0.05 0.72 0.20 rg {x0} {y0} {x1 - x0} {y1 - y0} re f\n"
            f"1 0 0 rg {marker_x} {marker_y} {marker_w} {marker_h} re f\n"
        ).encode("ascii")
    )
    if crop_box is not None:
        page.CropBox = pikepdf.Array(crop_box)
    if rotate:
        page[pikepdf.Name("/Rotate")] = rotate
    return page


def _make_artwork_pdf(
    path: str,
    *,
    page_size: tuple[float, float] = (240.0, 220.0),
    content_box: tuple[float, float, float, float] = (50.0, 70.0, 190.0, 150.0),
    crop_box: tuple[float, float, float, float] | None = None,
    rotate: int = 0,
) -> None:
    pdf = pikepdf.Pdf.new()
    _add_artwork_page(
        pdf,
        page_size=page_size,
        content_box=content_box,
        crop_box=crop_box,
        rotate=rotate,
    )
    pdf.save(path)
    pdf.close()


def _add_alpha_image_resource(
    pdf: pikepdf.Pdf,
    page,
    *,
    nested_in_form: bool = False,
) -> None:
    """Tạo ảnh RGB 2×2 có SMask như PDF do PNG alpha/ứng dụng ngoài sinh ra."""
    smask = pikepdf.Stream(pdf, bytes((0, 255, 255, 0)))
    smask.Type = pikepdf.Name.XObject
    smask.Subtype = pikepdf.Name.Image
    smask.Width = 2
    smask.Height = 2
    smask.ColorSpace = pikepdf.Name.DeviceGray
    smask.BitsPerComponent = 8

    image = pikepdf.Stream(
        pdf,
        bytes((255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0)),
    )
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = 2
    image.Height = 2
    image.ColorSpace = pikepdf.Name.DeviceRGB
    image.BitsPerComponent = 8
    image.SMask = smask

    if not nested_in_form:
        image_name = page.add_resource(image, pikepdf.Name.XObject)
        page.contents_add(
            pikepdf.Stream(pdf, f"q 100 0 0 100 0 0 cm {image_name} Do Q".encode("ascii"))
        )
        return

    form = pikepdf.Stream(pdf, b"q 1 0 0 1 0 0 cm /ImAlpha Do Q")
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array((0, 0, 100, 100))
    form.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(ImAlpha=image),
    )
    form_name = page.add_resource(form, pikepdf.Name.XObject)
    page.contents_add(
        pikepdf.Stream(pdf, f"q 1 0 0 1 0 0 cm {form_name} Do Q".encode("ascii"))
    )


def _make_mixed_transparency_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(100.0, 100.0))
    direct_page = pdf.add_blank_page(page_size=(100.0, 100.0))
    _add_alpha_image_resource(pdf, direct_page)
    nested_page = pdf.add_blank_page(page_size=(100.0, 100.0))
    _add_alpha_image_resource(pdf, nested_page, nested_in_form=True)
    pdf.save(path)
    pdf.close()


def _add_alpha_canvas_page(pdf: pikepdf.Pdf, *, page_size=(100.0, 100.0)):
    """Trang vuông có canvas alpha toàn trang, nội dung nhìn thấy tỷ lệ 2:3 ở giữa."""
    width_px = height_px = 20
    alpha = np.zeros((height_px, width_px), dtype=np.uint8)
    alpha[4:16, 6:14] = 255
    rgb = np.zeros((height_px, width_px, 3), dtype=np.uint8)
    rgb[:, :, :] = (24, 156, 70)

    smask = pikepdf.Stream(pdf, alpha.tobytes())
    smask.Type = pikepdf.Name.XObject
    smask.Subtype = pikepdf.Name.Image
    smask.Width = width_px
    smask.Height = height_px
    smask.ColorSpace = pikepdf.Name.DeviceGray
    smask.BitsPerComponent = 8

    image = pikepdf.Stream(pdf, rgb.tobytes())
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = width_px
    image.Height = height_px
    image.ColorSpace = pikepdf.Name.DeviceRGB
    image.BitsPerComponent = 8
    image.SMask = smask

    page = pdf.add_blank_page(page_size=page_size)
    image_name = page.add_resource(image, pikepdf.Name.XObject)
    page.contents_add(
        pikepdf.Stream(
            pdf,
            (
                f"q {page_size[0]} 0 0 {page_size[1]} 0 0 cm "
                f"{image_name} Do Q"
            ).encode("ascii"),
        )
    )
    return page


def _make_mixed_resize_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    _add_artwork_page(
        pdf,
        page_size=(100.0, 100.0),
        content_box=(10.0, 40.0, 90.0, 60.0),
    )
    _add_alpha_canvas_page(pdf)
    pdf.save(path)
    pdf.close()


def _make_opaque_halo_pdf(path: str, *, portrait: bool = False) -> None:
    """Tạo artwork xanh có halo gần trắng nhưng vẫn opaque ở mép nội dung."""
    rgb = np.full((300, 600, 3), 255, dtype=np.uint8)
    rgb[60:240, 50:550] = (24, 156, 70)
    rgb[60:62, 50:550] = 245
    rgb[238:240, 50:550] = 245
    rgb[60:240, 50:52] = 245
    rgb[60:240, 548:550] = 245
    if portrait:
        rgb = np.transpose(rgb, (1, 0, 2))
    Image.fromarray(rgb, mode="RGB").save(path, "PDF", resolution=300.0)


def _make_colored_edge_pdf(path: str, *, portrait: bool = False) -> None:
    """Tạo dải mực đỏ 0,25 mm sát mép để khóa lỗi lớp lẹm ăn artwork."""
    rgb = np.full((300, 600, 3), 255, dtype=np.uint8)
    rgb[60:240, 50:550] = (24, 156, 70)
    rgb[60:63, 50:550] = (220, 24, 32)
    rgb[237:240, 50:550] = (220, 24, 32)
    rgb[60:240, 50:53] = (220, 24, 32)
    rgb[60:240, 547:550] = (220, 24, 32)
    if portrait:
        rgb = np.transpose(rgb, (1, 0, 2))
    Image.fromarray(rgb, mode="RGB").save(path, "PDF", resolution=300.0)


def _render_rgb(path: str, page_index: int = 0, scale: float = 1.5) -> np.ndarray:
    pdfium = pytest.importorskip("pypdfium2")
    document = pdfium.PdfDocument(path)
    page = bitmap = None
    try:
        page = document[page_index]
        bitmap = page.render(scale=scale)
        return np.array(bitmap.to_pil().convert("RGB"))
    finally:
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()
        document.close()


def _decoded_page_contents(page) -> bytes:
    contents = page.get("/Contents")
    if contents is None:
        return b""
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(stream.read_bytes() for stream in contents)
    return contents.read_bytes()


def _background_resources(page):
    resources = page.get("/Resources") or {}
    xobjects = resources.get("/XObject") or {}
    images = []
    forms = []
    for name, obj in xobjects.items():
        subtype = obj.get("/Subtype")
        if subtype == pikepdf.Name.Image:
            images.append((name, obj))
        elif subtype == pikepdf.Name.Form:
            forms.append((name, obj))
    return images, forms


def _assert_outer_edge_has_ink(image: np.ndarray) -> None:
    border = np.concatenate(
        (
            image[2, :, :],
            image[-3, :, :],
            image[:, 2, :],
            image[:, -3, :],
        ),
        axis=0,
    )
    white_fraction = float(np.all(border >= 245, axis=1).mean())
    assert white_fraction < 0.02, f"mép ngoài còn {white_fraction:.1%} pixel trắng"


@pytest.mark.parametrize("mode", ["mirror", "trajectory", "image", "inpaint"])
def test_dynamic_background_after_content_detection(tmp_path, mode):
    src = str(tmp_path / f"source_{mode}.pdf")
    out = str(tmp_path / f"output_{mode}.pdf")
    _make_artwork_pdf(src)

    resize_pages_with_background(
        src,
        out,
        TARGET_W_MM,
        TARGET_H_MM,
        scale_mode="fit",
        background_mode=mode,
        background_dpi=72,
    )

    with pikepdf.Pdf.open(out) as pdf:
        page = pdf.pages[0]
        media = [float(value) for value in page.MediaBox]
        assert media == pytest.approx(
            [0.0, 0.0, TARGET_W_MM * PT_PER_MM, TARGET_H_MM * PT_PER_MM],
            abs=0.02,
        )

        images, forms = _background_resources(page)
        assert len(images) == 1
        assert len(forms) == 1
        image_name, image_obj = images[0]
        form_name, form_obj = forms[0]
        assert image_obj.get("/SMask") is not None
        assert b"1 0 0 rg" in form_obj.read_bytes(), "artwork vector gốc bị mất"

        alpha = np.frombuffer(image_obj.SMask.read_bytes(), dtype=np.uint8)
        assert int(alpha.min()) == 0
        assert int(alpha.max()) == 255
        assert alpha.size == int(image_obj.Width) * int(image_obj.Height)

        # PERF §RT.9: RGB vô hình sâu trong SMask=0 phải được làm thưa.
        rgb = np.frombuffer(image_obj.read_bytes(), dtype=np.uint8).reshape(-1, 3)
        invisible = rgb[alpha == 0]
        assert invisible.size > 0
        assert float(np.all(invisible == 0, axis=1).mean()) > 0.75

        commands = _decoded_page_contents(page)
        image_do_token = f"{image_name} Do".encode("ascii")
        image_do = commands.find(image_do_token)
        form_do = commands.find(f"{form_name} Do".encode("ascii"))
        assert 0 <= image_do < form_do, "lớp nền phải nằm dưới artwork"
        assert commands.rfind(image_do_token) > form_do, (
            "lớp nền lẹm phải nằm trên artwork để che halo trắng ở ranh giới"
        )

    image = _render_rgb(out)
    _assert_outer_edge_has_ink(image)
    center = image[image.shape[0] // 2, image.shape[1] // 2]
    assert center[0] > 180 and center[1] < 100 and center[2] < 100


@pytest.mark.parametrize("mode", ["mirror", "trajectory", "image", "inpaint"])
@pytest.mark.parametrize("portrait", [False, True])
def test_dynamic_background_covers_opaque_white_halo_at_content_boundary(
    tmp_path, portrait, mode
):
    src = str(tmp_path / f"opaque_halo_{portrait}_{mode}.pdf")
    out = str(tmp_path / f"opaque_halo_{portrait}_{mode}_out.pdf")
    _make_opaque_halo_pdf(src, portrait=portrait)

    resize_pages_with_background(
        src,
        out,
        50.8,
        50.8,
        scale_mode="fit",
        background_mode=mode,
        background_dpi=300,
    )

    image = _render_rgb(out, scale=600.0 / 72.0)
    white = np.all(image >= 235, axis=2)
    internal = white[5:-5, 5:-5]
    if portrait:
        max_line = internal.mean(axis=0).max()
    else:
        max_line = internal.mean(axis=1).max()
    assert float(max_line) < 0.02, (
        "còn line trắng opaque giữa artwork và phần nền kéo ra"
    )


@pytest.mark.parametrize("portrait", [False, True])
def test_seam_cleanup_preserves_colored_artwork_at_content_boundary(tmp_path, portrait):
    src = str(tmp_path / f"colored_edge_{portrait}.pdf")
    out = str(tmp_path / f"colored_edge_{portrait}_out.pdf")
    _make_colored_edge_pdf(src, portrait=portrait)

    resize_pages_with_background(
        src,
        out,
        50.8,
        50.8,
        scale_mode="fit",
        background_mode="image",
        background_dpi=300,
    )

    image = _render_rgb(out, scale=600.0 / 72.0)
    red = (
        (image[:, :, 0] >= 160)
        & (image[:, :, 1] <= 90)
        & (image[:, :, 2] <= 90)
    )
    if portrait:
        red_lines = red[10:-10, :].mean(axis=0)
    else:
        red_lines = red[:, 10:-10].mean(axis=1)
    assert int(np.count_nonzero(red_lines >= 0.90)) >= 2, (
        "lớp lẹm seam đã phủ mất dải màu thật sát mép artwork"
    )


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_rotation_and_offset_cropbox_fill_edges(tmp_path, rotate):
    src = str(tmp_path / f"rotated_{rotate}.pdf")
    out = str(tmp_path / f"rotated_{rotate}_out.pdf")
    _make_artwork_pdf(
        src,
        page_size=(280.0, 220.0),
        crop_box=(30.0, 20.0, 250.0, 200.0),
        content_box=(60.0, 65.0, 220.0, 155.0),
        rotate=rotate,
    )

    resize_pages_with_background(
        src,
        out,
        TARGET_W_MM,
        TARGET_H_MM,
        scale_mode="fit",
        background_mode="mirror",
        background_dpi=72,
    )

    with pikepdf.Pdf.open(out) as pdf:
        assert int(pdf.pages[0].get("/Rotate", 0) or 0) == 0
        images, forms = _background_resources(pdf.pages[0])
        assert images and forms
    _assert_outer_edge_has_ink(_render_rgb(out))


def test_apply_to_subset_preserves_unselected_pages(tmp_path):
    src = str(tmp_path / "subset.pdf")
    out = str(tmp_path / "subset_out.pdf")
    pdf = pikepdf.Pdf.new()
    _add_artwork_page(pdf, page_size=(180.0, 100.0), content_box=(10.0, 10.0, 170.0, 90.0))
    _add_artwork_page(pdf, page_size=(220.0, 220.0), content_box=(50.0, 70.0, 170.0, 150.0))
    _add_artwork_page(
        pdf,
        page_size=(100.0, 180.0),
        content_box=(10.0, 10.0, 90.0, 170.0),
        rotate=90,
    )
    pdf.save(src)
    pdf.close()

    with pikepdf.Pdf.open(src) as original:
        before = [
            (
                [float(value) for value in page.MediaBox],
                int(page.get("/Rotate", 0) or 0),
            )
            for page in original.pages
        ]

    resize_pages_with_background(
        src,
        out,
        TARGET_W_MM,
        TARGET_H_MM,
        apply_to="2",
        background_mode="image",
        background_dpi=72,
    )

    with pikepdf.Pdf.open(out) as result:
        assert len(result.pages) == 3
        for index in (0, 2):
            page = result.pages[index]
            assert [float(value) for value in page.MediaBox] == pytest.approx(before[index][0])
            assert int(page.get("/Rotate", 0) or 0) == before[index][1]
            assert not _background_resources(page)[0]
        images, forms = _background_resources(result.pages[1])
        assert images and forms


@pytest.mark.parametrize("mode", ["mirror", "image", "inpaint"])
def test_blank_page_fallback_is_safe(tmp_path, mode):
    src = str(tmp_path / f"blank_{mode}.pdf")
    out = str(tmp_path / f"blank_{mode}_out.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(240.0, 180.0))
    page.CropBox = pikepdf.Array([20.0, 10.0, 220.0, 170.0])
    page[pikepdf.Name("/Rotate")] = 90
    pdf.save(src)
    pdf.close()

    resize_pages_with_background(
        src,
        out,
        TARGET_W_MM,
        TARGET_H_MM,
        background_mode=mode,
        background_dpi=72,
    )

    image = _render_rgb(out)
    assert np.all(image >= 248)


@pytest.mark.parametrize("page_size", [(200.0, 50.0), (50.0, 200.0)])
def test_center_no_scale_fills_gap_when_other_axis_overflows(tmp_path, page_size):
    src = str(tmp_path / f"overflow_{int(page_size[0])}.pdf")
    out = str(tmp_path / f"overflow_{int(page_size[0])}_out.pdf")
    _make_artwork_pdf(
        src,
        page_size=page_size,
        content_box=(0.0, 0.0, page_size[0], page_size[1]),
    )

    square_mm = 40.0
    resize_pages_with_background(
        src,
        out,
        square_mm,
        square_mm,
        scale_mode="center_no_scale",
        background_mode="image",
        background_dpi=72,
    )

    image = _render_rgb(out)
    _assert_outer_edge_has_ink(image)
    with pikepdf.Pdf.open(out) as pdf:
        commands = _decoded_page_contents(pdf.pages[0]).decode("ascii")
        assert "q 1.00000000 0 0 1.00000000" in commands


@pytest.mark.parametrize(
    ("target_dpi", "mode", "expected_background_dpi"),
    [(0, "auto", 300), (144, "raster", 144)],
)
def test_smart_resize_dispatches_dynamic_background_before_downsample(
    tmp_path,
    monkeypatch,
    target_dpi,
    mode,
    expected_background_dpi,
):
    from app.workers import pdf_tools_engine, resize_background_engine

    src = str(tmp_path / "dispatch_src.pdf")
    out = str(tmp_path / "dispatch_out.pdf")
    _make_artwork_pdf(src)
    calls: list[dict] = []

    def fake_dynamic(
        source_path,
        output_path,
        target_w_mm,
        target_h_mm,
        **kwargs,
    ):
        calls.append({"source_path": source_path, **kwargs})
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(target_w_mm * PT_PER_MM, target_h_mm * PT_PER_MM))
        pdf.save(output_path)
        pdf.close()
        return output_path

    monkeypatch.setattr(resize_background_engine, "resize_pages_with_background", fake_dynamic)
    monkeypatch.setattr(
        pdf_tools_engine,
        "_raster_resize",
        lambda *args, **kwargs: pytest.fail("dynamic mode không được raster hóa artwork"),
    )
    monkeypatch.setattr(pdf_tools_engine, "_native_downsample", lambda *args: False)

    pdf_tools_engine.resize_pages_smart(
        src,
        out,
        TARGET_W_MM,
        TARGET_H_MM,
        scale_mode="fit",
        apply_to="odd",
        target_dpi=target_dpi,
        mode=mode,
        bg_fill_mode="mirror",
    )

    assert os.path.isfile(out)
    assert len(calls) == 1
    assert calls[0]["scale_mode"] == "fit"
    assert calls[0]["apply_to"] == "odd"
    assert calls[0]["background_mode"] == "mirror"
    assert calls[0]["background_dpi"] == expected_background_dpi


def _make_ratio_pages_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    for width, height in ((200.0, 100.0), (100.0, 200.0), (150.0, 150.0)):
        _add_artwork_page(
            pdf,
            page_size=(width, height),
            content_box=(0.0, 0.0, width, height),
        )
    pdf.save(path)
    pdf.close()


def _page_sizes_mm(path: str) -> list[tuple[float, float]]:
    with pikepdf.Pdf.open(path) as pdf:
        return [
            (
                float(page.MediaBox[2] - page.MediaBox[0]) / PT_PER_MM,
                float(page.MediaBox[3] - page.MediaBox[1]) / PT_PER_MM,
            )
            for page in pdf.pages
        ]


@pytest.mark.parametrize("background_mode", ["image", "solid", "white"])
@pytest.mark.parametrize(
    ("page_size_mode", "target_w", "target_h", "expected"),
    [
        (
            "fixed_width",
            50.0,
            70.0,
            [(50.0, 25.0), (50.0, 100.0), (50.0, 50.0)],
        ),
        (
            "fixed_height",
            70.0,
            50.0,
            [(100.0, 50.0), (25.0, 50.0), (50.0, 50.0)],
        ),
    ],
)
def test_locked_axis_uses_each_page_content_ratio(
    tmp_path,
    background_mode,
    page_size_mode,
    target_w,
    target_h,
    expected,
):
    src = str(tmp_path / f"ratio_{page_size_mode}_{background_mode}.pdf")
    out = str(tmp_path / f"ratio_{page_size_mode}_{background_mode}_out.pdf")
    _make_ratio_pages_pdf(src)

    resize_pages_with_background(
        src,
        out,
        target_w,
        target_h,
        scale_mode="fit",
        background_mode=background_mode,
        background_color="#123456",
        background_dpi=72,
        page_size_mode=page_size_mode,
    )

    actual = _page_sizes_mm(out)
    for actual_size, expected_size in zip(actual, expected, strict=True):
        assert actual_size == pytest.approx(expected_size, abs=0.12)
    with pikepdf.Pdf.open(out) as pdf:
        for page in pdf.pages:
            images, forms = _background_resources(page)
            assert not images, "khóa một chiều không được sinh nền raster khi không có gap"
            assert len(forms) == 1
            assert b"1 0 0 rg" in forms[0][1].read_bytes()


def test_locked_width_uses_detected_contentbox_not_white_pagebox(tmp_path):
    src = str(tmp_path / "ratio_white_border.pdf")
    out = str(tmp_path / "ratio_white_border_out.pdf")
    _make_artwork_pdf(
        src,
        page_size=(300.0, 300.0),
        content_box=(50.0, 100.0, 250.0, 200.0),
    )

    resize_pages_with_background(
        src,
        out,
        80.0,
        80.0,
        background_mode="image",
        background_dpi=72,
        page_size_mode="fixed_width",
    )

    width_mm, height_mm = _page_sizes_mm(out)[0]
    assert width_mm == pytest.approx(80.0, abs=0.02)
    assert height_mm == pytest.approx(40.0, abs=0.5)


def test_locked_axis_center_no_scale_keeps_artwork_at_original_size(tmp_path):
    """RESIZE (audit 2026-08-06 §G.11): tem 50×100 mm đưa về chiều cao 150 mm với
    "Giữ nguyên ở giữa" → trang 75×150 mm (tỷ lệ tem gốc) nhưng tem VẪN 50×100 mm
    nằm giữa. Trước đây engine ném ValueError, ép người dùng phải dùng 'fit' làm
    tem bị phóng lên full khổ 75×150."""
    src = str(tmp_path / "tem_50x100.pdf")
    out = str(tmp_path / "tem_50x100_out.pdf")
    _make_artwork_pdf(
        src,
        page_size=(50.0 * PT_PER_MM, 100.0 * PT_PER_MM),
        content_box=(0.0, 0.0, 50.0 * PT_PER_MM, 100.0 * PT_PER_MM),
    )

    resize_pages_with_background(
        src,
        out,
        60.0,
        150.0,
        scale_mode="center_no_scale",
        background_mode="solid",
        background_color="#123456",
        background_dpi=72,
        page_size_mode="fixed_height",
    )

    width_mm, height_mm = _page_sizes_mm(out)[0]
    # Khổ trang suy theo tỷ lệ tem gốc 50:100 → 75×150, KHÔNG phải 60 mm đã nhập.
    assert height_mm == pytest.approx(150.0, abs=0.05)
    assert width_mm == pytest.approx(75.0, abs=0.5)

    # Nội dung vẽ ở scale 1.0 và canh giữa: (75-50)/2 = 12.5 mm, (150-100)/2 = 25 mm.
    with pikepdf.Pdf.open(out) as pdf:
        streams = _decoded_page_contents(pdf.pages[0])
    text = streams.decode("latin-1")
    assert "1.00000000 0 0 1.00000000" in text, f"tem phải vẽ ở scale 1.0: {text[:400]}"
    match = re.search(
        r"1\.00000000 0 0 1\.00000000 (-?[\d.]+) (-?[\d.]+) cm", text
    )
    assert match is not None
    assert float(match.group(1)) == pytest.approx(12.5 * PT_PER_MM, abs=1.5)
    assert float(match.group(2)) == pytest.approx(25.0 * PT_PER_MM, abs=1.5)


def test_locked_axis_still_rejects_fill_and_stretch(tmp_path):
    """Khổ đích đã sinh ra đúng tỷ lệ nội dung nên không còn phần dư để lấp/bóp."""
    src = str(tmp_path / "tem_reject.pdf")
    _make_artwork_pdf(
        src,
        page_size=(50.0 * PT_PER_MM, 100.0 * PT_PER_MM),
        content_box=(0.0, 0.0, 50.0 * PT_PER_MM, 100.0 * PT_PER_MM),
    )
    for scale_mode in ("fill", "stretch"):
        with pytest.raises(ValueError, match="Giữ tỷ lệ từng trang"):
            resize_pages_with_background(
                src,
                str(tmp_path / f"reject_{scale_mode}.pdf"),
                60.0,
                150.0,
                scale_mode=scale_mode,
                background_mode="solid",
                background_dpi=72,
                page_size_mode="fixed_height",
            )


def test_transparent_page_keeps_full_page_ratio_until_resize_by_content_is_enabled(
    tmp_path,
):
    src = str(tmp_path / "alpha_canvas.pdf")
    keep_out = str(tmp_path / "alpha_canvas_keep.pdf")
    crop_out = str(tmp_path / "alpha_canvas_crop.pdf")
    pdf = pikepdf.Pdf.new()
    _add_alpha_canvas_page(pdf)
    pdf.save(src)
    pdf.close()

    common = {
        "scale_mode": "fit",
        "background_mode": "white",
        "background_dpi": 72,
        "page_size_mode": "fixed_width",
    }
    resize_pages_with_background(
        src,
        keep_out,
        50.0,
        50.0,
        resize_by_content=False,
        **common,
    )
    resize_pages_with_background(
        src,
        crop_out,
        50.0,
        50.0,
        resize_by_content=True,
        **common,
    )

    assert _page_sizes_mm(keep_out)[0] == pytest.approx((50.0, 50.0), abs=0.12)
    crop_width, crop_height = _page_sizes_mm(crop_out)[0]
    assert crop_width == pytest.approx(50.0, abs=0.12)
    assert crop_height == pytest.approx(75.0, abs=1.5)
    assert detect_transparent_pages(keep_out) == [1]
    assert detect_transparent_pages(crop_out) == [1]


def test_resize_by_content_only_changes_transparent_pages_in_mixed_pdf(tmp_path):
    src = str(tmp_path / "mixed_resize.pdf")
    keep_out = str(tmp_path / "mixed_resize_keep.pdf")
    crop_out = str(tmp_path / "mixed_resize_crop.pdf")
    _make_mixed_resize_pdf(src)

    common = {
        "scale_mode": "fit",
        "background_mode": "white",
        "background_dpi": 72,
        "page_size_mode": "fixed_width",
    }
    resize_pages_with_background(
        src, keep_out, 50.0, 50.0, resize_by_content=False, **common
    )
    resize_pages_with_background(
        src, crop_out, 50.0, 50.0, resize_by_content=True, **common
    )

    keep_sizes = _page_sizes_mm(keep_out)
    crop_sizes = _page_sizes_mm(crop_out)
    assert crop_sizes[0] == pytest.approx(keep_sizes[0], abs=0.12)
    assert keep_sizes[1] == pytest.approx((50.0, 50.0), abs=0.12)
    assert crop_sizes[1][0] == pytest.approx(50.0, abs=0.12)
    assert crop_sizes[1][1] == pytest.approx(75.0, abs=1.5)


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_locked_width_uses_display_ratio_after_rotation(tmp_path, rotate):
    src = str(tmp_path / f"ratio_rotated_{rotate}.pdf")
    out = str(tmp_path / f"ratio_rotated_{rotate}_out.pdf")
    _make_artwork_pdf(
        src,
        page_size=(280.0, 220.0),
        crop_box=(30.0, 20.0, 250.0, 200.0),
        content_box=(60.0, 65.0, 220.0, 155.0),
        rotate=rotate,
    )

    resize_pages_with_background(
        src,
        out,
        40.0,
        40.0,
        background_mode="mirror",
        background_dpi=72,
        page_size_mode="fixed_width",
    )

    width_mm, height_mm = _page_sizes_mm(out)[0]
    expected_height = 40.0 * (160.0 / 90.0 if rotate in (90, 270) else 90.0 / 160.0)
    assert width_mm == pytest.approx(40.0, abs=0.02)
    assert height_mm == pytest.approx(expected_height, abs=0.7)


def test_locked_axis_subset_preserves_unselected_pages(tmp_path):
    src = str(tmp_path / "ratio_subset.pdf")
    out = str(tmp_path / "ratio_subset_out.pdf")
    _make_ratio_pages_pdf(src)
    before = _page_sizes_mm(src)

    resize_pages_with_background(
        src,
        out,
        50.0,
        50.0,
        apply_to="2",
        background_mode="image",
        background_dpi=72,
        page_size_mode="fixed_width",
    )

    after = _page_sizes_mm(out)
    assert after[0] == pytest.approx(before[0], abs=0.02)
    assert after[1] == pytest.approx((50.0, 100.0), abs=0.12)
    assert after[2] == pytest.approx(before[2], abs=0.02)


def test_locked_axis_rejects_derived_size_outside_limit(tmp_path):
    src = str(tmp_path / "ratio_too_tall.pdf")
    out = str(tmp_path / "ratio_too_tall_out.pdf")
    _make_artwork_pdf(
        src,
        page_size=(10.0, 600.0),
        content_box=(0.0, 0.0, 10.0, 600.0),
    )

    with pytest.raises(ValueError, match=r"Trang 1.*1–5000 mm"):
        resize_pages_with_background(
            src,
            out,
            100.0,
            100.0,
            background_mode="image",
            background_dpi=72,
            page_size_mode="fixed_width",
        )


def test_smart_resize_locked_axis_forces_content_aware_vector_path(tmp_path, monkeypatch):
    from app.workers import pdf_tools_engine, resize_background_engine

    src = str(tmp_path / "ratio_dispatch_src.pdf")
    out = str(tmp_path / "ratio_dispatch_out.pdf")
    _make_artwork_pdf(src)
    calls: list[dict] = []

    def fake_content_aware(source_path, output_path, target_w_mm, target_h_mm, **kwargs):
        calls.append(kwargs)
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(target_w_mm * PT_PER_MM, target_h_mm * PT_PER_MM))
        pdf.save(output_path)
        pdf.close()
        return output_path

    monkeypatch.setattr(resize_background_engine, "resize_pages_with_background", fake_content_aware)
    monkeypatch.setattr(
        pdf_tools_engine,
        "_raster_resize",
        lambda *args, **kwargs: pytest.fail("khóa một chiều không được dùng raster canvas cố định"),
    )
    monkeypatch.setattr(pdf_tools_engine, "_native_downsample", lambda *args: False)

    pdf_tools_engine.resize_pages_smart(
        src,
        out,
        50.0,
        50.0,
        scale_mode="fit",
        apply_to="all",
        target_dpi=144,
        mode="raster",
        bg_fill_mode="solid",
        bg_fill_color="#123456",
        page_size_mode="fixed_width",
    )

    assert os.path.isfile(out)
    assert len(calls) == 1
    assert calls[0]["page_size_mode"] == "fixed_width"
    assert calls[0]["background_mode"] == "solid"
    assert calls[0]["background_color"] == "#123456"


def test_smart_resize_never_uses_rgb_raster_for_transparent_page(
    tmp_path,
    monkeypatch,
):
    from app.workers import pdf_tools_engine

    src = str(tmp_path / "alpha_smart_src.pdf")
    out = str(tmp_path / "alpha_smart_out.pdf")
    pdf = pikepdf.Pdf.new()
    _add_alpha_canvas_page(pdf)
    pdf.save(src)
    pdf.close()

    monkeypatch.setattr(
        pdf_tools_engine,
        "_raster_resize",
        lambda *args, **kwargs: pytest.fail("trang alpha không được raster hóa RGB"),
    )
    monkeypatch.setattr(pdf_tools_engine, "_native_downsample", lambda *args: False)

    pdf_tools_engine.resize_pages_smart(
        src,
        out,
        50.0,
        50.0,
        scale_mode="fit",
        apply_to="all",
        target_dpi=144,
        mode="raster",
        bg_fill_mode="white",
        page_size_mode="fixed",
        resize_by_content=False,
    )

    assert os.path.isfile(out)
    assert detect_transparent_pages(out) == [1]


async def test_resize_route_forwards_page_size_mode(tmp_path, monkeypatch):
    from app.api.routes import pdf_tools

    src = str(tmp_path / "ratio_route_src.pdf")
    _make_artwork_pdf(src)
    captured: list[dict] = []

    async def fake_run_in_threadpool(func, *args, **kwargs):
        if getattr(func, "__name__", "") == "resize_pages_smart":
            captured.append(kwargs)
            pdf = pikepdf.Pdf.new()
            pdf.add_blank_page(page_size=(100.0, 100.0))
            pdf.save(args[1])
            pdf.close()
        return None

    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "run_in_threadpool", fake_run_in_threadpool)
    response = await pdf_tools.resize_pages_endpoint(
        file=None,
        file_path=src,
        target_w=50.0,
        target_h=50.0,
        scale_mode="fit",
        apply_to="all",
        target_dpi=0,
        mode="auto",
        bg_fill_mode="image",
        bg_fill_color="#ffffff",
        page_size_mode="fixed_width",
        resize_by_content=True,
        license_info={"license_key": "DEV_MODE"},
    )

    assert os.path.isfile(response.path)
    timing = json.loads(response.headers["x-prynx-resize-timing"])
    assert timing["source"] == "path"
    assert timing["input_bytes"] > 0
    assert timing["output_bytes"] > 0
    for key in ("source_ms", "engine_ms", "watermark_ms", "backend_ms"):
        assert isinstance(timing[key], (int, float))
        assert timing[key] >= 0
    assert (
        response.headers["access-control-expose-headers"]
        == "X-PrynX-Resize-Timing"
    )
    assert captured == [{"target_dpi": 0, "mode": "auto", "bg_fill_mode": "image", "bg_fill_color": "#ffffff", "page_size_mode": "fixed_width", "resize_by_content": True}]


async def test_resize_route_rejects_locked_axis_with_fill_or_stretch():
    """RESIZE (audit 2026-08-06 §G.11): route chỉ còn chặn fill/stretch ở khổ khóa
    một chiều; 'center_no_scale' phải đi qua được (xem test ngay dưới)."""
    from app.api.routes import pdf_tools
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as raised:
        await pdf_tools.resize_pages_endpoint(
            file=None,
            file_path="",
            target_w=50.0,
            target_h=50.0,
            scale_mode="stretch",
            apply_to="all",
            target_dpi=0,
            mode="auto",
            bg_fill_mode="image",
            bg_fill_color="#ffffff",
            page_size_mode="fixed_width",
            license_info={"license_key": "DEV_MODE"},
        )
    assert raised.value.status_code == 422


async def test_resize_route_accepts_locked_axis_with_center_no_scale():
    """RESIZE (audit 2026-08-06 §G.11): tem 5×10 → chiều cao 15 + "Giữ nguyên ở giữa"
    không được bị chốt hợp lệ của route chặn (trước đây trả 422 ngay đầu vào)."""
    from app.api.routes import pdf_tools
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as raised:
        await pdf_tools.resize_pages_endpoint(
            file=None,
            file_path="",
            target_w=60.0,
            target_h=150.0,
            scale_mode="center_no_scale",
            apply_to="all",
            target_dpi=0,
            mode="auto",
            bg_fill_mode="image",
            bg_fill_color="#ffffff",
            page_size_mode="fixed_height",
            license_info={"license_key": "DEV_MODE"},
        )
    # Vẫn lỗi vì không truyền file, nhưng KHÔNG phải vì chốt kiểu tỷ lệ.
    assert "Giữ tỷ lệ từng trang" not in str(raised.value.detail)


def test_detect_transparent_pages_handles_direct_and_nested_png_alpha(tmp_path):

    src = str(tmp_path / "mixed_transparency.pdf")
    _make_mixed_transparency_pdf(src)

    assert detect_transparent_pages(src) == [2, 3]


async def test_resize_transparency_inspection_returns_page_level_contract(
    tmp_path,
):
    from app.api.routes import pdf_tools

    src = str(tmp_path / "inspect_transparency.pdf")
    _make_mixed_transparency_pdf(src)

    result = await pdf_tools.inspect_resize_transparency_endpoint(
        file=None,
        file_path=src,
    )

    assert result == {
        "has_transparency": True,
        "transparent_pages": [2, 3],
    }
