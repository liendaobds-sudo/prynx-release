"""Regression cho engine tách từng tem từ ảnh mockup phẳng."""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image
import pytest

from app.workers.sticker_sheet_engine import (
    DEFAULT_MODEL,
    StickerSheetError,
    analyze_sticker_sheet,
)


def _synthetic_runner(
    rectangles: list[tuple[int, int, int, int]],
    *,
    shadow_offset: tuple[int, int] = (8, 7),
    shadow_alpha: int = 72,
):
    def run(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        alpha = np.zeros((image.height, image.width), dtype=np.uint8)
        dx, dy = shadow_offset
        for x, y, width, height in rectangles:
            cv2.rectangle(
                alpha,
                (x + dx, y + dy),
                (x + width - 1 + dx, y + height - 1 + dy),
                shadow_alpha,
                thickness=-1,
            )
        for x, y, width, height in rectangles:
            cv2.rectangle(
                alpha,
                (x, y),
                (x + width - 1, y + height - 1),
                255,
                thickness=-1,
            )
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    return run


def test_default_model_uses_birefnet_lite():
    assert DEFAULT_MODEL == "birefnet-lite"


def test_detects_nine_stickers_and_orders_by_rows():
    rectangles = [
        (15, 10, 38, 24), (74, 12, 42, 22), (136, 9, 35, 27),
        (12, 55, 41, 28), (72, 58, 45, 23), (137, 54, 37, 29),
        (16, 101, 36, 25), (75, 99, 40, 28), (139, 102, 34, 24),
    ]
    source = Image.new("RGB", (190, 140), "white")

    result = analyze_sticker_sheet(
        source,
        model_runner=_synthetic_runner(rectangles),
    )

    assert len(result.instances) == 9
    assert [instance.id for instance in result.instances] == list(range(1, 10))
    assert [instance.x for instance in result.instances[:3]] == [15, 74, 136]
    assert [instance.x for instance in result.instances[3:6]] == [12, 72, 137]
    assert [instance.x for instance in result.instances[6:]] == [16, 75, 139]
    assert set(np.unique(result.labels)) == set(range(10))


def test_removes_low_alpha_shadow_outside_two_pixel_soft_edge():
    source = Image.new("RGB", (100, 80), "white")
    result = analyze_sticker_sheet(
        source,
        model_runner=_synthetic_runner([(20, 20, 40, 30)]),
    )

    assert len(result.instances) == 1
    assert result.alpha[25, 25] == 255
    assert result.alpha[54, 64] == 0, "bóng xa silhouette phải bị loại"
    assert result.labels[54, 64] == 0


def test_model_only_controls_alpha_and_never_recolors_source():
    source = Image.new("RGB", (80, 60), (17, 93, 201))

    def recoloring_runner(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.zeros((image.height, image.width, 4), dtype=np.uint8)
        rgba[:, :, :3] = (240, 15, 25)
        rgba[10:50, 12:68, 3] = 255
        return Image.fromarray(rgba, "RGBA")

    result = analyze_sticker_sheet(source, model_runner=recoloring_runner)

    assert tuple(result.rgba[25, 30, :3]) == (17, 93, 201)
    assert result.rgba[25, 30, 3] == 255


def test_ignores_small_dust_component():
    def runner(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.zeros((image.height, image.width, 4), dtype=np.uint8)
        rgba[:, :, :3] = 255
        rgba[20:80, 20:90, 3] = 255
        rgba[2:5, 2:5, 3] = 255
        return Image.fromarray(rgba, "RGBA")

    result = analyze_sticker_sheet(
        Image.new("RGB", (120, 100), "white"),
        model_runner=runner,
    )

    assert len(result.instances) == 1
    assert result.instances[0].bbox == (20, 20, 70, 60)
    assert result.labels[3, 3] == 0


def test_reports_isnet_quality_warning():
    result = analyze_sticker_sheet(
        Image.new("RGB", (100, 80), "white"),
        model="isnet",
        model_runner=_synthetic_runner([(20, 20, 40, 30)]),
    )
    assert any("nhiều mảnh" in warning for warning in result.warnings)


def test_rejects_empty_mask():
    def empty(image: Image.Image, _model: str) -> Image.Image:
        return Image.new("RGBA", image.size, (255, 255, 255, 0))

    with pytest.raises(StickerSheetError, match="Không nhận diện được tem"):
        analyze_sticker_sheet(Image.new("RGB", (100, 80)), model_runner=empty)


@pytest.mark.parametrize("threshold", [0, 255])
def test_rejects_invalid_alpha_threshold(threshold: int):
    with pytest.raises(StickerSheetError, match="Ngưỡng Alpha"):
        analyze_sticker_sheet(
            Image.new("RGB", (100, 80)),
            alpha_threshold=threshold,
            model_runner=_synthetic_runner([(20, 20, 40, 30)]),
        )
