"""Unit test (TASK 10.3): Preview tô đỏ ĐÚNG vùng Out_Of_Gamut.

Feature: channel-remover — Req 4.3.

Kiểm chứng hai mảnh độc lập của lớp preview trong ``app/core/channel_remover``:

  1. ``compute_oog_preview(cmyk100, mapper)``: với một raster CMYK nhỏ ở
     Re_Separation_Mode (kept set đã biết + gamut_threshold nhỏ), một số pixel
     là Out_Of_Gamut (màu sặc sỡ không tái tạo được bằng kênh-giữ) và một số
     pixel In_Gamut (màu chỉ-dùng-kênh-giữ). Khẳng định:
       - ``highlighted_image`` = PREVIEW_OOG_RGB (255,0,0) tại MỌI pixel
         ``oog_mask`` True, và = ``base_image`` tại các pixel còn lại (pixel
         không OOG KHÔNG bị đổi màu).
       - ``out_of_gamut_pixels == oog_mask.sum()``.

  2. ``highlight_oog_regions(base_rgb, oog_mask)``: chỉ pixel được mask hoá đỏ;
     các pixel khác giữ nguyên; hàm KHÔNG mutate mảng đầu vào.

Cần ICC FOGRA39 thật để dựng ColorMapper chế độ reseparate; nếu thiếu profile
thì test được skip với lý do rõ ràng (ưu tiên chạy được trên mọi môi trường).
"""
import numpy as np
import pytest

from app.core.channel_remover import (
    PREVIEW_OOG_RGB,
    ColorMapper,
    ReSeparationEngine,
    compute_oog_preview,
    highlight_oog_regions,
    validate_params,
)

# Lưới thô để dựng LUT nhanh trong unit test (không ảnh hưởng tính đúng phân loại).
_GRID_STEP = 25.0


def _make_mapper():
    """Dựng một ColorMapper THẬT (validate_params + ReSeparationEngine).

    Kept set = {K} (giữ Black, bỏ C/M/Y) với gamut_threshold rất nhỏ để màu sặc
    sỡ chắc chắn rơi vào Out_Of_Gamut. Skip nếu thiếu ICC FOGRA39.
    """
    params = validate_params(
        {
            "kept_channels": ["K"],
            "mode": "reseparate",
            "gamut_threshold": 1.0,
            "grid_step": _GRID_STEP,
        }
    )
    try:
        engine = ReSeparationEngine(
            kept_channels=params.kept_channels, grid_step=params.grid_step
        )
    except FileNotFoundError as exc:
        pytest.skip(f"ICC FOGRA39 không khả dụng, bỏ qua unit test: {exc}")
    return ColorMapper(params, engine)


def test_compute_oog_preview_highlights_only_oog_pixels():
    """highlighted_image đỏ tại oog_mask True, giữ nguyên base_image nơi khác."""
    mapper = _make_mapper()

    # Raster 2x2:
    #  - (0,0): K thuần (chỉ dùng kênh-giữ) → In_Gamut.
    #  - (0,1): màu trắng/không mực → In_Gamut (kênh-giữ tái tạo được).
    #  - (1,0): cyan sặc sỡ (C=100) → kênh-giữ {K} KHÔNG tái tạo được → OOG.
    #  - (1,1): magenta sặc sỡ (M=100) → OOG.
    cmyk100 = np.array(
        [
            [(0.0, 0.0, 0.0, 100.0), (0.0, 0.0, 0.0, 0.0)],
            [(100.0, 0.0, 0.0, 0.0), (0.0, 100.0, 0.0, 0.0)],
        ],
        dtype=np.float32,
    )

    preview = compute_oog_preview(cmyk100, mapper)

    base = np.asarray(preview.base_image)
    highlighted = np.asarray(preview.highlighted_image)
    mask = preview.oog_mask

    # Phải tồn tại CẢ pixel OOG lẫn pixel in-gamut để bài test có ý nghĩa.
    assert mask.any(), "Mong đợi ít nhất một pixel Out_Of_Gamut với kept={K}."
    assert (~mask).any(), "Mong đợi ít nhất một pixel In_Gamut (K thuần / trắng)."

    red = np.array(PREVIEW_OOG_RGB, dtype=np.uint8)

    # Tại pixel OOG: highlighted CHÍNH XÁC bằng đỏ thuần (255, 0, 0).
    assert np.all(highlighted[mask] == red), (
        "Pixel Out_Of_Gamut phải được tô đúng PREVIEW_OOG_RGB (255,0,0)."
    )

    # Tại pixel KHÔNG OOG: highlighted GIỮ NGUYÊN base_image (không bị đổi màu).
    assert np.array_equal(highlighted[~mask], base[~mask]), (
        "Pixel In_Gamut không được thay đổi so với base_image."
    )

    # out_of_gamut_pixels phải bằng số pixel True trong oog_mask.
    assert preview.out_of_gamut_pixels == int(mask.sum())
    assert preview.total_pixels == cmyk100.shape[0] * cmyk100.shape[1]


def test_highlight_oog_regions_masks_only_and_no_mutation():
    """highlight_oog_regions chỉ tô đỏ pixel được mask; không mutate đầu vào."""
    base_rgb = np.array(
        [
            [(10, 20, 30), (40, 50, 60)],
            [(70, 80, 90), (100, 110, 120)],
        ],
        dtype=np.uint8,
    )
    base_copy = base_rgb.copy()

    oog_mask = np.array(
        [
            [True, False],
            [False, True],
        ]
    )

    out = highlight_oog_regions(base_rgb, oog_mask)

    red = np.array(PREVIEW_OOG_RGB, dtype=np.uint8)

    # Pixel được mask → đỏ thuần.
    assert np.array_equal(out[0, 0], red)
    assert np.array_equal(out[1, 1], red)

    # Pixel KHÔNG mask → giữ nguyên giá trị gốc.
    assert np.array_equal(out[0, 1], base_copy[0, 1])
    assert np.array_equal(out[1, 0], base_copy[1, 0])

    # Hàm thuần: KHÔNG mutate mảng đầu vào.
    assert np.array_equal(base_rgb, base_copy), (
        "highlight_oog_regions không được sửa mảng base_rgb gốc."
    )

    # Trả mảng mới (không phải cùng đối tượng với đầu vào).
    assert out is not base_rgb


def test_highlight_oog_regions_empty_mask_returns_copy_unchanged():
    """Mask toàn False → trả bản sao y hệt base_rgb, không tô gì."""
    base_rgb = np.array(
        [[(1, 2, 3), (4, 5, 6)]],
        dtype=np.uint8,
    )
    oog_mask = np.zeros((1, 2), dtype=bool)

    out = highlight_oog_regions(base_rgb, oog_mask)

    assert np.array_equal(out, base_rgb)
    assert out is not base_rgb
