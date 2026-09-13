"""Hồi quy clip artwork khi Bình tem bế phải fallback theo khung trang."""

import pytest

from app.workers import pdf_wrapper as pdf_lib
from app.workers.nup_artwork import place_one_artwork


MM_TO_PT = 2.83465
SOURCE_W = 147.1 * MM_TO_PT
SOURCE_H = 51.3 * MM_TO_PT
SHRINK = 1.0 * MM_TO_PT
HALF_GAP = 1.0 * MM_TO_PT
HIDDEN_BLEED = 3.0 * MM_TO_PT


class _CapturePage:
    def __init__(self):
        self.calls = []

    def show_pdf_page(
        self,
        rect,
        src_doc,
        page_idx,
        rotate=0,
        clip=None,
        keep_proportion=False,
        out_clip=None,
        mirror_x=False,
        mirror_y=False,
        out_clip_path=None,
    ):
        self.calls.append({
            "rect": rect,
            "rotate": rotate,
            "clip": clip,
            "out_clip": out_clip,
            "out_clip_path": out_clip_path,
        })


class _SourceDoc:
    def __getitem__(self, _page_idx):
        return object()


def _place_rotated_page_fallback(
    *,
    is_page_fallback=True,
    hidden_bleed=HIDDEN_BLEED,
):
    """Mô phỏng đúng ca Binder162: xoay 90°, Co/Mở -1, hở 2, bleed ẩn 3."""
    trim_w = SOURCE_H - 2 * SHRINK
    trim_h = SOURCE_W - 2 * SHRINK
    abs_x = 100.0
    abs_y = 200.0
    placement = {
        "cell": {
            "width": trim_w,
            "height": trim_h,
            "isRotated": True,
            "isRotated180": False,
            "blockId": 0,
        },
        "cluster_idx": 0,
        "src_page_idx": 0,
        "abs_x": abs_x,
        "original_cell_y": abs_y,
    }

    # Ô ở mép trái, nhưng không nằm ở ba mép còn lại của khối. Logic cũ vì thế
    # nới 3 mm ở trái và 1 mm ở phải: 49,3 + 3 + 1 = 53,3 mm.
    block_bbox = {
        (0, 0): [abs_x, abs_y - 20.0, abs_x + trim_w + 100.0, abs_y + trim_h + 20.0],
    }

    sx0 = 20.0
    sy0 = 30.0
    sx1 = sx0 + SOURCE_W
    sy1 = sy0 + SOURCE_H
    tx0 = sx0 + SHRINK
    ty0 = sy0 + SHRINK
    tx1 = sx1 - SHRINK
    ty1 = sy1 - SHRINK
    cache_key = "fallback-clip_0"
    diecut_geom_cache = {
        cache_key: (sx0, sy0, sx1, sy1, tx0, ty0, tx1, ty1),
    }
    die_items_cache = {
        cache_key: {
            "items": [],
            "rect": pdf_lib.Rect(tx0, ty0, tx1, ty1),
            "is_page_fallback": is_page_fallback,
        },
    }

    out_page = _CapturePage()
    place_one_artwork(
        out_page,
        _SourceDoc(),
        placement,
        bleed_pt=hidden_bleed,
        is_die_cut=True,
        cut_type="default",
        separate_cut_page=False,
        local_stripped_pages=set(),
        job_id="fallback-clip",
        diecut_geom_cache=diecut_geom_cache,
        die_items_cache=die_items_cache,
        max_geom_cache=8,
        block_bbox=block_bbox,
        clip_off_x=min(HALF_GAP, hidden_bleed),
        clip_off_y=min(HALF_GAP, hidden_bleed),
        fallback_gap_half_x=HALF_GAP,
        fallback_gap_half_y=HALF_GAP,
        find_largest_die_path=lambda _page: None,
        die_offset_mm=-1.0,
        shape_clip=False,
    )
    return out_page.calls[0]


def test_page_fallback_clip_never_exceeds_logical_source_box():
    """Mask fallback phải dừng ở CropBox logic, không lộ MediaBox vì bleed ẩn."""
    call = _place_rotated_page_fallback()

    assert call["rotate"] == 90
    assert call["out_clip"].width == pytest.approx(SOURCE_H)
    assert call["out_clip"].height == pytest.approx(SOURCE_W)
    assert call["out_clip"].width == pytest.approx(call["rect"].width)
    assert call["out_clip"].height == pytest.approx(call["rect"].height)


def test_real_die_keeps_full_outer_bleed_clip():
    """Khuôn bế thật vẫn được giữ tràn lề đầy đủ ở mép ngoài khối."""
    call = _place_rotated_page_fallback(is_page_fallback=False)

    assert call["out_clip"].width == pytest.approx(SOURCE_H)
    assert call["out_clip"].height == pytest.approx(SOURCE_W)


def test_page_fallback_clip_is_independent_from_hidden_bleed():
    """Bleed ẩn nhỏ hơn nửa hở cũng không được âm thầm làm mask fallback co lại."""
    call = _place_rotated_page_fallback(hidden_bleed=0.25 * MM_TO_PT)

    assert call["out_clip"].width == pytest.approx(SOURCE_H)
    assert call["out_clip"].height == pytest.approx(SOURCE_W)
