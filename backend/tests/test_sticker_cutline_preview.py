"""Live preview phải dùng CutContour thật và tôn trọng revision/edit hiện tại."""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image
import pytest

import app.workers.sticker_cutline_preview as cutline_preview_module
from app.core.sticker_sheet_session import (
    StickerSheetPageState,
    StickerSheetSession,
    StickerSheetSessionConflict,
)
from app.workers.cutline_machine_path import (
    analyze_machine_path,
    cubic_segments_from_tuples,
)
from app.workers.sticker_engine import _alpha_live_machine_path_is_safe
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview


def _session(tmp_path, *, convex: bool = False) -> StickerSheetSession:
    width, height = 180, 140
    labels_u8 = np.zeros((height, width), dtype=np.uint8)
    points = np.array(
        (
            [
                [25, 20], [155, 20], [155, 120], [25, 120],
            ]
            if convex
            else [
                [20, 70], [48, 56], [60, 18], [90, 49], [126, 28],
                [119, 70], [158, 91], [116, 99], [104, 128], [70, 104], [30, 118],
            ]
        ),
        dtype=np.int32,
    )
    cv2.fillPoly(labels_u8, [points], 1)
    labels = labels_u8.astype(np.uint32)
    alpha = np.where(labels > 0, 255, 0).astype(np.uint8)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[:, :, :3] = (80, 160, 220)
    rgba[:, :, 3] = alpha
    source_path = tmp_path / "source.png"
    Image.fromarray(rgba[:, :, :3], "RGB").save(source_path)
    Image.fromarray(rgba, "RGBA").save(tmp_path / "rgba.png")
    np.save(tmp_path / "labels.npy", labels, allow_pickle=False)
    manifest = {
        "mask_revision": 3,
        "instances": [{"id": 1}],
    }
    page = StickerSheetPageState(
        page_number=1,
        directory=tmp_path,
        analysis_source_path=source_path,
        original_width_px=width,
        original_height_px=height,
        analysis_width_px=width,
        analysis_height_px=height,
        preview_width_px=width,
        preview_height_px=height,
        dpi=(100.0, 100.0),
        stage="mask-review",
        boundary_source="ai",
        strategy_confidence=0.9,
        needs_review=True,
        manifest=manifest,
    )
    return StickerSheetSession(
        session_id="a" * 32,
        directory=tmp_path,
        source_path=source_path,
        analysis_source_path=source_path,
        original_name="source.png",
        original_width_px=width,
        original_height_px=height,
        analysis_width_px=width,
        analysis_height_px=height,
        preview_width_px=width,
        preview_height_px=height,
        dpi=(100.0, 100.0),
        stage="mask-review",
        source_kind="raster",
        boundary_source="ai",
        strategy_confidence=0.9,
        needs_review=True,
        page_count=1,
        manifest=manifest,
        last_access=0.0,
        pages={1: page},
    )


def _preview(session: StickerSheetSession, *, tension: float) -> dict[str, object]:
    return build_sticker_cutline_preview(
        session,
        page_number=1,
        base_revision=3,
        edits=[],
        dpi=100.0,
        dpi_y=100.0,
        offset_mm=0.0,
        bleed_mm=2.0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50.0,
        cutline_fidelity=50.0,
        curve_tension=tension,
        min_detail_area_mm2=1.0,
    )


def test_fast_motion_guard_khop_bo_do_day_du() -> None:
    mm_to_pts = 72.0 / 25.4
    radius = 30.0
    handle = radius * 0.5522847498307936
    circle = [
        ((radius, 0.0), (radius, handle), (handle, radius), (0.0, radius)),
        ((0.0, radius), (-handle, radius), (-radius, handle), (-radius, 0.0)),
        ((-radius, 0.0), (-radius, -handle), (-handle, -radius), (0.0, -radius)),
        ((0.0, -radius), (handle, -radius), (radius, -handle), (radius, 0.0)),
    ]

    disconnected = list(circle)
    segment = disconnected[1]
    disconnected[1] = (
        (segment[0][0] + 1.0, segment[0][1]),
        segment[1],
        segment[2],
        segment[3],
    )
    sharp = list(circle)
    segment = sharp[1]
    sharp[1] = (segment[0], (8.0, radius - 8.0), segment[2], segment[3])

    rng = np.random.default_rng(20260810)
    cases = [circle, disconnected, sharp]
    for _ in range(64):
        count = int(rng.integers(3, 14))
        nodes = rng.normal(0.0, 40.0, size=(count, 2))
        random_path = []
        for index in range(count):
            start = nodes[index]
            end = nodes[(index + 1) % count]
            delta = end - start
            control1 = start + delta * 0.3 + rng.normal(0.0, 8.0, size=2)
            control2 = start + delta * 0.7 + rng.normal(0.0, 8.0, size=2)
            random_path.append(tuple(
                tuple(float(value) for value in point)
                for point in (start, control1, control2, end)
            ))
        cases.append(random_path)

    for path in cases:
        metrics = analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=mm_to_pts,
            smooth_join_threshold_degrees=1.0,
            short_segment_threshold_mm=0.25,
        )
        expected = (
            metrics.disconnected_join_count == 0
            and metrics.discontinuous_join_count == 0
            and metrics.short_segment_count == 0
        )
        assert _alpha_live_machine_path_is_safe(path, mm_to_pts=mm_to_pts) is expected


def test_preview_tra_svg_bezier_va_tai_su_dung_geometry_khi_keo_tuning(
    tmp_path,
    monkeypatch,
) -> None:
    session = _session(tmp_path)
    prepare_calls = 0
    original_prepare = cutline_preview_module.prepare_alpha_cutline_geometry

    def counted_prepare(*args, **kwargs):
        nonlocal prepare_calls
        prepare_calls += 1
        return original_prepare(*args, **kwargs)

    monkeypatch.setattr(
        cutline_preview_module,
        "prepare_alpha_cutline_geometry",
        counted_prepare,
    )
    soft = _preview(session, tension=10.0)
    tight = _preview(session, tension=90.0)

    assert soft["mask_revision"] == 3
    assert soft["segment_count"] > 0
    assert soft["paths"][0]["d"].startswith("M ")
    assert " C " in soft["paths"][0]["d"]
    assert soft["fingerprint"] != tight["fingerprint"]
    assert soft["paths"][0]["d"] != tight["paths"][0]["d"]
    assert prepare_calls == 1


def test_do_bo_cong_phai_thay_doi_ca_tem_hinh_loi(tmp_path) -> None:
    """Closing ra–vào không bo được góc lồi nên từng làm slider chỉ đổi hash."""
    session = _session(tmp_path, convex=True)

    keep_corner = _preview(session, tension=0.0)
    rounded = _preview(session, tension=100.0)

    assert keep_corner["paths"][0]["d"] != rounded["paths"][0]["d"]
    assert rounded["quality"]["machine_safe"] is True


@pytest.mark.parametrize("tool", ["erase", "restore"])
def test_preview_ap_dung_net_sua_tren_mask_uint32_khong_loi_opencv(
    tmp_path,
    tool: str,
) -> None:
    session = _session(tmp_path)
    result = build_sticker_cutline_preview(
        session,
        page_number=1,
        base_revision=3,
        edits=[{
            "kind": "stroke",
            "id": f"stroke-{tool}",
            "tool": tool,
            "instance_id": 1,
            "radius": 0.015,
            "points": [
                {"x": 0.35, "y": 0.45},
                {"x": 0.45, "y": 0.55},
            ],
        }],
        dpi=100.0,
        dpi_y=100.0,
        offset_mm=0.0,
        bleed_mm=2.0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50.0,
        cutline_fidelity=50.0,
        curve_tension=50.0,
        min_detail_area_mm2=1.0,
    )

    assert result["mask_revision"] == 3
    assert result["segment_count"] > 0
    assert result["paths"]


def test_preview_tu_choi_revision_cu(tmp_path) -> None:
    session = _session(tmp_path)
    with pytest.raises(StickerSheetSessionConflict, match="đã thay đổi"):
        build_sticker_cutline_preview(
            session,
            page_number=1,
            base_revision=2,
            edits=[],
            dpi=100.0,
            dpi_y=100.0,
            offset_mm=0.0,
            bleed_mm=0.0,
            cut_mode="original",
            corner_style="preserve",
            fill_holes=True,
            cutline_smoothness=50.0,
            cutline_fidelity=50.0,
            curve_tension=50.0,
            min_detail_area_mm2=1.0,
        )
