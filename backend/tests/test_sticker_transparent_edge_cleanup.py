"""Hồi quy khử pixel mờ nhiều màu ở mép trong suốt PNG, không có bù xén."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("cv2")
pytest.importorskip("pikepdf")
pytest.importorskip("pypdfium2")
pytest.importorskip("reportlab")

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.workers.sticker_alpha_cleanup import (
    clean_alpha_exterior_fringe,
    clean_rgba_exterior_fringe,
    cleaned_alpha_page_bytes,
)
from app.workers.sticker_engine import StickerEngine
from app.workers.sticker_sheet_export import _png_pages_to_pdf
from app.workers.sticker_source_pipeline import (
    _analysis_from_alpha,
    _render_pdf_page,
    _source_image_with_clean_alpha,
)


def _multicolor_fringe() -> tuple[np.ndarray, np.ndarray]:
    """Tạo lõi đục và sáu vòng Alpha mờ với màu RGB thay đổi liên tục."""
    size = 160
    rgb = np.full((size, size, 3), 255, dtype=np.uint8)
    alpha = np.zeros((size, size), dtype=np.uint8)
    rgb[55:105, 55:105] = (220, 30, 40)
    alpha[55:105, 55:105] = 255
    colors = (
        (255, 255, 255),
        (80, 210, 245),
        (255, 140, 40),
        (0, 0, 0),
        (30, 220, 80),
        (180, 20, 220),
    )
    for index, (distance, value) in enumerate(
        ((1, 220), (2, 180), (3, 140), (4, 100), (5, 60), (6, 20))
    ):
        y0, y1 = 55 - distance, 105 + distance
        x0, x1 = 55 - distance, 105 + distance
        ring = np.zeros((size, size), dtype=bool)
        ring[y0:y1, x0:x1] = True
        ring[y0 + 1:y1 - 1, x0 + 1:x1 - 1] = False
        rgb[ring] = colors[index]
        alpha[ring] = value
    return rgb, alpha


def _expected_alpha(alpha: np.ndarray) -> np.ndarray:
    expected = np.zeros_like(alpha)
    expected[55:105, 55:105] = 255
    return expected


def _iter_images(resources):
    """Duyệt XObject qua Form lồng nhau mà không lặp vòng tài nguyên."""
    seen: set[tuple[int, int]] = set()
    pending = [resources]
    while pending:
        current = pending.pop()
        if not current:
            continue
        for name, value in current.get("/XObject", {}).items():
            identity = value.objgen
            if identity in seen:
                continue
            seen.add(identity)
            subtype = str(value.get("/Subtype"))
            if subtype == "/Form":
                pending.append(value.get("/Resources", {}))
            elif subtype == "/Image":
                yield str(name), value


def _pdf_image_masks(pdf_path: Path) -> list[np.ndarray]:
    import pikepdf

    with pikepdf.Pdf.open(pdf_path) as document:
        result: list[np.ndarray] = []
        for _name, image in _iter_images(document.pages[0].get("/Resources", {})):
            mask = image.get("/SMask")
            if mask is None:
                continue
            result.append(
                np.asarray(
                    pikepdf.PdfImage(mask).as_pil_image().convert("L"),
                    dtype=np.uint8,
                ).copy()
            )
        return result


def test_alpha_cleanup_ignores_rgb_and_keeps_enclosed_transparency():
    rgb, alpha = _multicolor_fringe()
    # Một vùng bán trong suốt kín trong lõi là nội dung thật, không phải halo.
    alpha[70:76, 70:76] = 120
    before = alpha.copy()

    cleaned, removed = clean_alpha_exterior_fringe(alpha)

    expected = _expected_alpha(alpha)
    expected[70:76, 70:76] = 120
    np.testing.assert_array_equal(cleaned, expected)
    assert removed == int(np.count_nonzero(before != cleaned))
    # Hàm không sửa mảng nguồn; màu RGB không hề tham gia quyết định.
    np.testing.assert_array_equal(alpha, before)
    for color in ((255, 255, 255), (0, 0, 0), (180, 20, 220)):
        candidate = np.dstack((np.full_like(rgb, color), alpha))
        other, _ = clean_rgba_exterior_fringe(candidate)
        np.testing.assert_array_equal(other[:, :, 3], cleaned)


def test_clean_rgba_pads_only_invisible_samples_and_is_idempotent():
    rgb, alpha = _multicolor_fringe()
    rgba = np.dstack((rgb, alpha))
    cleaned, removed = clean_rgba_exterior_fringe(rgba)
    expected_alpha = _expected_alpha(alpha)

    assert removed > 0
    np.testing.assert_array_equal(cleaned[:, :, 3], expected_alpha)
    # Màu nhìn thấy giữ nguyên; chỉ byte nằm dưới Alpha=0 mới được đệm để PDF
    # không nội suy lại màu bóng khi phóng to.
    visible = expected_alpha > 0
    np.testing.assert_array_equal(cleaned[:, :, :3][visible], rgb[visible])
    assert np.all(cleaned[:, :, :3][~visible] == (220, 30, 40))
    again, second_removed = clean_rgba_exterior_fringe(cleaned)
    assert second_removed == 0
    np.testing.assert_array_equal(again, cleaned)


def test_fully_transparent_colored_pixels_are_removed_even_without_soft_alpha():
    rgb, alpha = _multicolor_fringe()
    alpha[(alpha > 0) & (alpha < 255)] = 0
    rgb[alpha == 0] = (0, 230, 255)
    rgba = np.dstack((rgb, alpha))

    cleaned, removed = clean_rgba_exterior_fringe(rgba)

    assert removed == 0
    np.testing.assert_array_equal(cleaned[:, :, 3], alpha)
    assert np.all(cleaned[:, :, :3][alpha == 0] == (220, 30, 40))


def test_alpha_preview_and_pdf_render_share_clean_alpha(tmp_path: Path):
    rgb, alpha = _multicolor_fringe()
    rgba = np.dstack((rgb, alpha))
    png_path = tmp_path / "fringe.png"
    pdf_path = tmp_path / "fringe.pdf"
    Image.fromarray(rgba, "RGBA").save(png_path)
    _png_pages_to_pdf([png_path], pdf_path, 300.0, 300.0)

    source = Image.fromarray(rgba, "RGBA")
    analysis = _analysis_from_alpha(
        source,
        alpha,
        model="birefnet-lite",
        alpha_threshold=128,
        shadow_cleanup="auto",
        clean_transparent_edges=True,
    )
    clean_source = _source_image_with_clean_alpha(source, analysis)
    np.testing.assert_array_equal(np.asarray(clean_source)[:, :, 3], _expected_alpha(alpha))
    disabled_shadow_option = _analysis_from_alpha(
        source,
        alpha,
        model="birefnet-lite",
        alpha_threshold=128,
        shadow_cleanup="off",
        clean_transparent_edges=True,
    )
    np.testing.assert_array_equal(disabled_shadow_option.raw_alpha, _expected_alpha(alpha))

    rendered, _dpi = _render_pdf_page(
        str(pdf_path),
        0,
        (160 * 25.4 / 300.0, 160 * 25.4 / 300.0),
        clean_transparent_edges=True,
    )
    rendered_alpha = np.asarray(rendered.getchannel("A"), dtype=np.uint8)
    assert rendered_alpha.shape == alpha.shape
    # Ở đúng tỉ lệ pixel, preview không còn dải Alpha mờ sáu màu ở ngoài lõi.
    assert np.count_nonzero((rendered_alpha > 0) & (rendered_alpha < 248)) == 0
    np.testing.assert_array_equal(rendered_alpha, _expected_alpha(alpha))


def test_alpha_export_replaces_original_smask_when_bleed_is_zero(tmp_path: Path):
    rgb, alpha = _multicolor_fringe()
    rgba = np.dstack((rgb, alpha))
    png_path = tmp_path / "fringe.png"
    source_pdf = tmp_path / "source.pdf"
    output_pdf = tmp_path / "output.pdf"
    Image.fromarray(rgba, "RGBA").save(png_path)
    _png_pages_to_pdf([png_path], source_pdf, 300.0, 300.0)
    source_hash = hashlib.sha256(source_pdf.read_bytes()).hexdigest()

    success, metadata = StickerEngine(dpi=300).process_pdf(
        input_path=str(source_pdf),
        output_path=str(output_pdf),
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="contour",
    )
    assert success is True, metadata
    assert hashlib.sha256(source_pdf.read_bytes()).hexdigest() == source_hash

    masks = _pdf_image_masks(output_pdf)
    assert masks, "PDF xuất phải còn ảnh RGBA có SMask"
    expected = _expected_alpha(alpha)
    # Không được chép lại SMask gốc có sáu dải Alpha mờ; bù xén bằng 0 không
    # tạo thêm ảnh viền.
    assert all(np.array_equal(mask, expected) for mask in masks)
    assert all(not np.any((mask > 0) & (mask < 248)) for mask in masks)

    import pikepdf

    with pikepdf.Pdf.open(output_pdf) as output:
        visible_colors = []
        for _name, image in _iter_images(output.pages[0].get("/Resources", {})):
            if image.get("/SMask") is None:
                continue
            output_rgb = np.asarray(
                pikepdf.PdfImage(image).as_pil_image().convert("RGB"),
                dtype=np.uint8,
            )
            output_mask = np.asarray(
                pikepdf.PdfImage(image.SMask).as_pil_image().convert("L"),
                dtype=np.uint8,
            )
            visible_colors.append(output_rgb[output_mask > 0])
            assert np.all(output_rgb[output_mask == 0] == (220, 30, 40))
        assert visible_colors
        np.testing.assert_array_equal(visible_colors[0], np.broadcast_to(
            np.asarray((220, 30, 40), dtype=np.uint8), visible_colors[0].shape
        ))

    with pikepdf.Pdf.open(source_pdf) as source:
        original_masks = [
            np.asarray(pikepdf.PdfImage(obj.SMask).as_pil_image().convert("L"), dtype=np.uint8)
            for _name, obj in _iter_images(source.pages[0].get("/Resources", {}))
            if obj.get("/SMask") is not None
        ]
    assert original_masks and any(
        np.any((mask > 0) & (mask < 248)) for mask in original_masks
    )


def test_alpha_export_cleans_fully_transparent_rgb_edge(tmp_path: Path):
    rgb, alpha = _multicolor_fringe()
    alpha[(alpha > 0) & (alpha < 255)] = 0
    rgb[alpha == 0] = (0, 230, 255)
    png_path = tmp_path / "hidden-rgb.png"
    source_pdf = tmp_path / "hidden-rgb-source.pdf"
    output_pdf = tmp_path / "hidden-rgb-output.pdf"
    Image.fromarray(np.dstack((rgb, alpha)), "RGBA").save(png_path)
    _png_pages_to_pdf([png_path], source_pdf, 300.0, 300.0)

    success, metadata = StickerEngine(dpi=300).process_pdf(
        input_path=str(source_pdf),
        output_path=str(output_pdf),
        cut_mode="alpha",
        offset_mm=0.0,
        bleed_mm=0.0,
        draw_cut_contour=False,
        shape_mode="contour",
    )
    assert success is True, metadata

    import pikepdf

    with pikepdf.Pdf.open(output_pdf) as output:
        images = [
            image for _name, image in _iter_images(output.pages[0].get("/Resources", {}))
            if image.get("/SMask") is not None
        ]
        assert images
        image = images[0]
        output_rgb = np.asarray(
            pikepdf.PdfImage(image).as_pil_image().convert("RGB"),
            dtype=np.uint8,
        )
        output_alpha = np.asarray(
            pikepdf.PdfImage(image.SMask).as_pil_image().convert("L"),
            dtype=np.uint8,
        )
        np.testing.assert_array_equal(output_alpha, alpha)
        assert np.all(output_rgb[output_alpha == 0] == (220, 30, 40))


def test_cleaned_alpha_page_does_not_mutate_shared_source_resources(tmp_path: Path):
    rgb, alpha = _multicolor_fringe()
    rgba = np.dstack((rgb, alpha))
    png_path = tmp_path / "fringe.png"
    source_pdf = tmp_path / "source.pdf"
    Image.fromarray(rgba, "RGBA").save(png_path)
    _png_pages_to_pdf([png_path, png_path], source_pdf, 300.0, 300.0)

    import pikepdf

    with pikepdf.Pdf.open(source_pdf) as source:
        cleaned_bytes, removed = cleaned_alpha_page_bytes(source.pages[0])
        assert cleaned_bytes is not None and removed > 0
        # Bản làm sạch độc lập; trang nguồn thứ hai vẫn còn SMask mờ.
        untouched = [
            np.asarray(pikepdf.PdfImage(obj.SMask).as_pil_image().convert("L"), dtype=np.uint8)
            for _name, obj in _iter_images(source.pages[1].get("/Resources", {}))
            if obj.get("/SMask") is not None
        ]
        assert untouched and any(np.any((mask > 0) & (mask < 248)) for mask in untouched)

