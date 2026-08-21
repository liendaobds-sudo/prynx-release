"""Regression cho engine tách từng tem từ ảnh mockup phẳng."""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image
import pytest

import app.workers.sticker_sheet_engine as sticker_engine_module
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


def _shadowed_rectangles_fixture(
    rectangles: list[tuple[int, int, int, int]],
    *,
    size: tuple[int, int],
    shadow_offset: tuple[int, int] = (8, 7),
    shadow_alpha: int = 220,
) -> tuple[Image.Image, object]:
    """Dựng mockup có bóng Alpha cao dính liền nhưng vẫn có viền trắng thật."""
    width, height = size
    rgb = np.full((height, width, 3), 255, dtype=np.uint8)
    alpha = np.zeros((height, width), dtype=np.uint8)
    dx, dy = shadow_offset
    for x, y, rect_width, rect_height in rectangles:
        cv2.rectangle(
            rgb,
            (x + dx, y + dy),
            (x + rect_width - 1 + dx, y + rect_height - 1 + dy),
            (205, 205, 205),
            thickness=-1,
        )
        cv2.rectangle(
            alpha,
            (x + dx, y + dy),
            (x + rect_width - 1 + dx, y + rect_height - 1 + dy),
            shadow_alpha,
            thickness=-1,
        )
    for index, (x, y, rect_width, rect_height) in enumerate(rectangles):
        cv2.rectangle(
            rgb,
            (x, y),
            (x + rect_width - 1, y + rect_height - 1),
            (255, 255, 255),
            thickness=-1,
        )
        if rect_width >= 12 and rect_height >= 12:
            color = (35 + (index * 41) % 180, 80, 215)
            cv2.rectangle(
                rgb,
                (x + 5, y + 5),
                (x + rect_width - 6, y + rect_height - 6),
                color,
                thickness=-1,
            )
        cv2.rectangle(
            alpha,
            (x, y),
            (x + rect_width - 1, y + rect_height - 1),
            255,
            thickness=-1,
        )

    source = Image.fromarray(rgb, "RGB")

    def runner(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    return source, runner


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


def test_removes_attached_high_alpha_neutral_shadow_but_keeps_white_border():
    source, runner = _shadowed_rectangles_fixture(
        [(20, 18, 44, 34)],
        size=(100, 80),
    )
    source_array = np.asarray(source, dtype=np.uint8).copy()
    # Một pixel sáng sót trong vùng bóng không được làm guard từ chối cả lượt lọc.
    source_array[56, 68] = 255
    source = Image.fromarray(source_array, "RGB")

    result = analyze_sticker_sheet(source, model_runner=runner)

    assert len(result.instances) == 1
    assert result.instances[0].bbox == (20, 18, 44, 34)
    assert result.labels[50, 62] == 1, "viền trắng thật phải còn nguyên"
    assert result.labels[56, 68] == 0, "bóng Alpha cao dính component phải bị loại"
    assert result.alpha[50, 62] == 255
    assert result.alpha[56, 68] == 0


def test_attached_shadow_cleanup_keeps_nine_instances_and_row_order():
    rectangles = [
        (15, 10, 38, 24), (74, 12, 42, 22), (136, 9, 35, 27),
        (12, 55, 41, 28), (72, 58, 45, 23), (137, 54, 37, 29),
        (16, 101, 36, 25), (75, 99, 40, 28), (139, 102, 34, 24),
    ]
    source, runner = _shadowed_rectangles_fixture(
        rectangles,
        size=(190, 140),
        shadow_offset=(5, 4),
    )

    result = analyze_sticker_sheet(source, model_runner=runner)

    assert len(result.instances) == 9
    assert [instance.x for instance in result.instances[:3]] == [15, 74, 136]
    assert [instance.x for instance in result.instances[3:6]] == [12, 72, 137]
    assert [instance.x for instance in result.instances[6:]] == [16, 75, 139]
    assert [instance.bbox for instance in result.instances] == rectangles
    assert set(np.unique(result.labels)) == set(range(10))


def test_attached_shadow_cleanup_preserves_star_tips_and_concave_notches():
    width = height = 140
    center = np.array([64.0, 62.0])
    points = []
    for index in range(20):
        angle = -np.pi / 2.0 + index * np.pi / 10.0
        radius = 42.0 if index % 2 == 0 else 23.0
        points.append(center + (np.cos(angle) * radius, np.sin(angle) * radius))
    polygon = np.rint(points).astype(np.int32)
    shadow_polygon = polygon + np.array([8, 7], dtype=np.int32)
    source_rgb = np.full((height, width, 3), 255, dtype=np.uint8)
    cv2.fillPoly(source_rgb, [shadow_polygon], (205, 205, 205))
    cv2.fillPoly(source_rgb, [polygon], (255, 255, 255))
    alpha = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(alpha, [shadow_polygon], 220)
    cv2.fillPoly(alpha, [polygon], 255)

    def runner(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    result = analyze_sticker_sheet(
        Image.fromarray(source_rgb, "RGB"),
        model_runner=runner,
    )
    intended = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(intended, [polygon], 1)
    shadow_only = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(shadow_only, [shadow_polygon], 1)
    shadow_only[(intended > 0)] = 0

    assert len(result.instances) == 1
    assert np.all(result.labels[intended > 0] == 1)
    assert np.all(result.labels[shadow_only > 0] == 0)
    for x, y in polygon:
        assert result.labels[y, x] == 1


def test_neutral_artwork_without_white_shell_is_not_mistaken_for_shadow():
    source_rgb = np.full((80, 100, 3), 255, dtype=np.uint8)
    source_rgb[20:60, 18:78] = 205
    alpha = np.zeros((80, 100), dtype=np.uint8)
    alpha[20:60, 18:78] = 255

    def runner(image: Image.Image, _model: str) -> Image.Image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        rgba[:, :, 3] = alpha
        return Image.fromarray(rgba, "RGBA")

    result = analyze_sticker_sheet(
        Image.fromarray(source_rgb, "RGB"),
        model_runner=runner,
    )

    assert result.instances[0].bbox == (18, 20, 60, 40)
    assert np.all(result.labels[20:60, 18:78] == 1)


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


def test_model_memory_error_is_reported_without_runtime_exception_name():
    def out_of_memory(_image: Image.Image, _model: str) -> Image.Image:
        raise RuntimeError(
            "BFCArena failed to allocate buffer with requested bytes of 822083584"
        )

    with pytest.raises(StickerSheetError) as captured:
        analyze_sticker_sheet(
            Image.new("RGB", (100, 80)),
            model_runner=out_of_memory,
        )

    assert "không còn đủ bộ nhớ" in str(captured.value)
    assert "RuntimeException" not in str(captured.value)


def test_clean_alpha_does_not_copy_the_full_mask_to_float32():
    """Hậu xử lý phải còn chạy khi allocator từ chối bản sao float32 toàn trang."""

    class NoFloat32Copy(np.ndarray):
        def astype(self, dtype, *args, **kwargs):
            if np.dtype(dtype) == np.dtype(np.float32):
                raise MemoryError("Unable to allocate float32 mask copy")
            return super().astype(dtype, *args, **kwargs)

    raw_alpha = np.arange(256, dtype=np.uint8).reshape(16, 16).view(NoFloat32Copy)
    labels = np.ones(raw_alpha.shape, dtype=np.uint16)
    expected = np.clip(
        (np.arange(256, dtype=np.float32) - sticker_engine_module.MIN_UNCERTAIN_ALPHA)
        * (
            255.0
            / float(
                sticker_engine_module.MAX_UNCERTAIN_ALPHA
                - sticker_engine_module.MIN_UNCERTAIN_ALPHA
            )
        ),
        0.0,
        255.0,
    ).astype(np.uint8).reshape(raw_alpha.shape)

    cleaned = sticker_engine_module._clean_alpha(raw_alpha, labels)

    assert np.array_equal(cleaned, expected)


def test_postprocess_memory_error_is_reported_as_controlled_sticker_error(monkeypatch):
    """OOM sau inference không được lọt ra route dưới dạng HTTP 500 thô."""

    def postprocess_out_of_memory(*_args, **_kwargs):
        raise MemoryError("Unable to allocate 2.40 MiB for an array")

    monkeypatch.setattr(
        sticker_engine_module,
        "_build_analysis_from_raw_alpha",
        postprocess_out_of_memory,
    )

    with pytest.raises(StickerSheetError, match="không còn đủ bộ nhớ"):
        analyze_sticker_sheet(
            Image.new("RGB", (100, 80)),
            model_runner=_synthetic_runner([(20, 20, 40, 30)]),
        )


@pytest.mark.parametrize("threshold", [0, 255])
def test_rejects_invalid_alpha_threshold(threshold: int):
    with pytest.raises(StickerSheetError, match="Ngưỡng Alpha"):
        analyze_sticker_sheet(
            Image.new("RGB", (100, 80)),
            alpha_threshold=threshold,
            model_runner=_synthetic_runner([(20, 20, 40, 30)]),
        )


def test_shadow_cleanup_chi_xu_ly_roi_cua_tung_tem(monkeypatch):
    rectangles = [
        (15, 10, 38, 24), (74, 12, 42, 22), (136, 9, 35, 27),
        (12, 55, 41, 28), (72, 58, 45, 23), (137, 54, 37, 29),
        (16, 101, 36, 25), (75, 99, 40, 28), (139, 102, 34, 24),
    ]
    source, runner = _shadowed_rectangles_fixture(
        rectangles,
        size=(190, 140),
        shadow_offset=(5, 4),
    )
    original = sticker_engine_module._remove_attached_neutral_shadow
    processed_shapes: list[tuple[int, int]] = []

    def traced(source_rgb, component, **kwargs):
        processed_shapes.append(component.shape)
        return original(source_rgb, component, **kwargs)

    monkeypatch.setattr(
        sticker_engine_module,
        "_remove_attached_neutral_shadow",
        traced,
    )
    result = analyze_sticker_sheet(source, model_runner=runner)

    assert len(result.instances) == 9
    assert len(processed_shapes) == 9
    assert all(height < 140 and width < 190 for height, width in processed_shapes)


@pytest.mark.parametrize(
    ("model", "module_name"),
    (
        ("birefnet-lite", "birefnet_engine"),
        ("isnet", "isnet_engine"),
    ),
)
def test_sticker_engine_chi_lay_alpha_khong_refine_lai_mau(
    monkeypatch,
    model: str,
    module_name: str,
):
    module = __import__(f"app.workers.{module_name}", fromlist=[module_name])
    alpha = Image.new("L", (32, 24), 0)
    alpha.paste(255, (7, 5, 25, 20))
    monkeypatch.setattr(module, "predict_alpha", lambda *_args, **_kwargs: alpha, raising=False)
    monkeypatch.setattr(
        module,
        "remove_background",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Luồng tách tem không được refine RGB rồi vứt bỏ")
        ),
    )

    result = sticker_engine_module._run_background_model(
        Image.new("RGB", (32, 24), (20, 80, 160)),
        model,
    )

    assert result.mode == "RGBA"
    assert np.array_equal(np.asarray(result.getchannel("A")), np.asarray(alpha))
    assert tuple(np.asarray(result)[10, 10, :3]) == (20, 80, 160)


def test_ai_alpha_cache_tai_su_dung_dung_anh_va_dung_tham_so(
    tmp_path,
    monkeypatch,
):
    calls = 0

    def fake_model(image: Image.Image, _model: str) -> Image.Image:
        nonlocal calls
        calls += 1
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        rgba[12:66, 14:82, 3] = 255
        return Image.fromarray(rgba, "RGBA")

    monkeypatch.setattr(sticker_engine_module, "_AI_ALPHA_CACHE_ROOT", tmp_path)
    monkeypatch.setattr(sticker_engine_module, "_run_background_model", fake_model)
    monkeypatch.setattr(sticker_engine_module, "_DEFAULT_BACKGROUND_RUNNER", fake_model)
    source = Image.new("RGB", (100, 80), (248, 248, 248))

    first = analyze_sticker_sheet(source, alpha_threshold=128)
    second = analyze_sticker_sheet(source, alpha_threshold=128)
    analyze_sticker_sheet(source, alpha_threshold=150)

    assert calls == 2
    assert first.model_seconds > 0
    assert second.model_seconds == 0
    assert np.array_equal(first.alpha, second.alpha)
    assert np.array_equal(first.labels, second.labels)
