"""Live preview phải dùng CutContour thật và tôn trọng revision/edit hiện tại."""

from __future__ import annotations

import asyncio
import math
import os
import shutil
import time

import cv2
import numpy as np
from PIL import Image
import pytest
from fastapi import HTTPException

import app.workers.sticker_cutline_preview as cutline_preview_module
from app.core import sticker_sheet_session as session_store
from app.core.sticker_sheet_session import (
    StickerSheetPageState,
    StickerSheetSession,
    StickerSheetSessionConflict,
)
from app.workers.cutline_machine_path import (
    analyze_machine_path,
    cubic_segments_from_tuples,
)
from app.workers.cutline_geometry import build_filleted_polygon_beziers
from app.workers.sticker_engine import (
    _analytic_fillet_short_line_count,
    _alpha_live_machine_path_is_safe,
    build_alpha_cutline_geometry,
)
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_sheet_export import (
    StickerSheetExportError,
    _translate_cutline_path_groups,
)


def _session(
    tmp_path,
    *,
    convex: bool = False,
    warnings: list[str] | None = None,
    alpha_fringe: bool = False,
) -> StickerSheetSession:
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
    if alpha_fringe:
        support = cv2.dilate(
            alpha,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        )
        fringe = (support > 0) & (labels == 0)
        alpha[fringe] = 96
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
        "warnings": list(warnings or []),
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


def _preview(
    session: StickerSheetSession,
    *,
    tension: float,
    cut_mode: str = "original",
) -> dict[str, object]:
    return build_sticker_cutline_preview(
        session,
        page_number=1,
        base_revision=3,
        edits=[],
        dpi=100.0,
        dpi_y=100.0,
        offset_mm=0.0,
        bleed_mm=2.0,
        cut_mode=cut_mode,
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50.0,
        cutline_fidelity=50.0,
        curve_tension=tension,
        min_detail_area_mm2=1.0,
    )


def test_preview_composite_drop_shadow_tu_nang_fidelity_nhung_khong_doi_cache_key(
    tmp_path,
    monkeypatch,
) -> None:
    """Bóng đã khử cần đường bám sát hơn ở cả preview, không đổi hợp đồng cache."""
    session = _session(
        tmp_path,
        convex=True,
        warnings=["simple-bg-composite-recovered", "simple-bg-drop-shadow-removed"],
        alpha_fringe=True,
    )
    original_fit = cutline_preview_module.fit_prepared_alpha_cutline_geometry
    original_prepare = cutline_preview_module.prepare_alpha_cutline_geometry
    seen: list[float] = []
    seen_tension: list[float] = []
    seen_fringe: list[int] = []

    def spy_fit(prepared, **kwargs):
        seen.append(float(kwargs["cutline_fidelity"]))
        seen_tension.append(float(kwargs["curve_tension"]))
        return original_fit(prepared, **kwargs)

    monkeypatch.setattr(
        cutline_preview_module,
        "fit_prepared_alpha_cutline_geometry",
        spy_fit,
    )

    def spy_prepare(alpha, **kwargs):
        seen_fringe.append(int(np.count_nonzero((alpha > 0) & (alpha < 128))))
        return original_prepare(alpha, **kwargs)

    monkeypatch.setattr(
        cutline_preview_module,
        "prepare_alpha_cutline_geometry",
        spy_prepare,
    )
    result = build_sticker_cutline_preview(
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
        curve_tension=50.0,
        min_detail_area_mm2=1.0,
    )

    assert result["paths"]
    assert seen == [95.0]
    assert seen_tension == [0.0]
    assert seen_fringe and seen_fringe[0] > 0
    # Cache lookup vẫn nhận fidelity người dùng gửi vào; path bên trong đã là
    # bản precision nên export fallback không bị lệch key.
    assert session.pages[1].cutline_export_cache["key"]


def test_preview_simple_bg_tho_tu_nang_khu_rang_cua_khi_ai_khong_thay_mask(
    tmp_path,
    monkeypatch,
) -> None:
    """Fallback thiếu RAM phải làm sạch quỹ đạo thay vì trả mask JPEG thô."""
    session = _session(
        tmp_path,
        warnings=["simple-bg-preview-denoise-fallback"],
    )
    original_prepare = cutline_preview_module.prepare_alpha_cutline_geometry
    seen: list[float] = []

    def spy_prepare(alpha, **kwargs):
        seen.append(float(kwargs["cutline_denoise"]))
        return original_prepare(alpha, **kwargs)

    monkeypatch.setattr(
        cutline_preview_module,
        "prepare_alpha_cutline_geometry",
        spy_prepare,
    )
    result = build_sticker_cutline_preview(
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
        curve_tension=50.0,
        min_detail_area_mm2=1.0,
        cutline_denoise=30.0,
    )

    assert result["paths"]
    assert seen == [70.0]

    # 0 là lựa chọn tắt có chủ đích; cổng tự động không được tước quyền này.
    result_off = build_sticker_cutline_preview(
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
        curve_tension=50.0,
        min_detail_area_mm2=1.0,
        cutline_denoise=0.0,
    )
    assert result_off["paths"]
    assert seen == [70.0, 0.0]


def test_preview_thuong_giu_fidelity_nguoi_dung_chon(tmp_path, monkeypatch) -> None:
    session = _session(tmp_path, convex=True)
    original_fit = cutline_preview_module.fit_prepared_alpha_cutline_geometry
    seen: list[float] = []
    seen_tension: list[float] = []

    def spy_fit(prepared, **kwargs):
        seen.append(float(kwargs["cutline_fidelity"]))
        seen_tension.append(float(kwargs["curve_tension"]))
        return original_fit(prepared, **kwargs)

    monkeypatch.setattr(
        cutline_preview_module,
        "fit_prepared_alpha_cutline_geometry",
        spy_fit,
    )
    build_sticker_cutline_preview(
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
        cutline_fidelity=61.0,
        curve_tension=50.0,
        min_detail_area_mm2=1.0,
    )

    assert seen == [61.0]
    assert seen_tension == [50.0]


def test_preview_thuong_khong_hut_dai_alpha_ngoai_nhan(tmp_path, monkeypatch) -> None:
    """Nguồn thường vẫn giữ hợp đồng mask nhị phân, không hút halo AI vào contour."""
    session = _session(tmp_path, convex=True, alpha_fringe=True)
    original_prepare = cutline_preview_module.prepare_alpha_cutline_geometry
    seen_fringe: list[int] = []

    def spy_prepare(alpha, **kwargs):
        seen_fringe.append(int(np.count_nonzero((alpha > 0) & (alpha < 128))))
        return original_prepare(alpha, **kwargs)

    monkeypatch.setattr(
        cutline_preview_module,
        "prepare_alpha_cutline_geometry",
        spy_prepare,
    )
    _preview(session, tension=50.0)

    assert seen_fringe and seen_fringe[0] == 0


def _regular_polygon(
    sides: int,
    *,
    radius: float = 25.0,
    rotation: float = 0.0,
) -> list[tuple[float, float]]:
    return [
        (
            radius * math.cos(
                -math.pi / 2.0 + rotation + index * 2.0 * math.pi / sides
            ),
            radius * math.sin(
                -math.pi / 2.0 + rotation + index * 2.0 * math.pi / sides
            ),
        )
        for index in range(sides)
    ]


@pytest.mark.parametrize(
    "points",
    [
        [(-30.0, -20.0), (30.0, -20.0), (30.0, 20.0), (-30.0, 20.0)],
        _regular_polygon(3),
        _regular_polygon(5),
        _regular_polygon(6),
        _regular_polygon(7),
        _regular_polygon(8),
    ],
    ids=["rectangle", "triangle", "pentagon", "hexagon", "heptagon", "octagon"],
)
def test_fillet_polygon_chuan_co_tiep_tuyen_g1_that(points) -> None:
    mm_to_pts = 72.0 / 25.4
    segments = build_filleted_polygon_beziers(
        [(x * mm_to_pts, y * mm_to_pts) for x, y in points],
        radius=0.25 * mm_to_pts,
        minimum_straight=0.25 * mm_to_pts,
    )
    metrics = analyze_machine_path(
        cubic_segments_from_tuples(segments),
        mm_to_units=mm_to_pts,
        smooth_join_threshold_degrees=0.1,
        short_segment_threshold_mm=0.25,
    )

    assert metrics.disconnected_join_count == 0
    assert metrics.discontinuous_join_count == 0
    assert (metrics.maximum_join_angle_degrees or 0.0) < 0.001
    assert _analytic_fillet_short_line_count(
        [segments],
        mm_to_pts=mm_to_pts,
    ) == 0
    assert len(segments) == len(points) * 2


@pytest.mark.parametrize("offset_mm", [0.0, 1.0])
def test_exact_rounded_rect_chi_con_bon_canh_bon_cung(offset_mm: float) -> None:
    mm_to_pts = 72.0 / 25.4
    shape = {
        "kind": "rounded_rect",
        "coordinate_unit": "pt",
        "params": {
            "cx": 35.0 * mm_to_pts,
            "cy": 25.0 * mm_to_pts,
            "w": 60.0 * mm_to_pts,
            "h": 40.0 * mm_to_pts,
            "r": 5.0 * mm_to_pts,
            "angle": 17.0,
        },
    }
    groups = cutline_preview_module._exact_shape_path_groups(
        shape,
        left_px=0,
        top_px=0,
        dpi=300.0,
        dpi_y=300.0,
        cut_mode="original",
        offset_mm=offset_mm,
        bleed_mm=0.0,
        corner_style="round",
        curve_tension=100.0,
    )

    assert groups is not None
    segments = groups[0]["exterior"]
    metrics = analyze_machine_path(
        cubic_segments_from_tuples(segments),
        mm_to_units=mm_to_pts,
        smooth_join_threshold_degrees=0.1,
        short_segment_threshold_mm=0.25,
    )
    assert len(segments) == 8
    assert metrics.discontinuous_join_count == 0
    assert (metrics.maximum_join_angle_degrees or 0.0) < 0.001


def test_exact_rounded_rect_manifest_cu_duoc_fit_lai_thanh_cung_that() -> None:
    mm_to_pts = 72.0 / 25.4
    half_width = 30.0 * mm_to_pts
    half_height = 20.0 * mm_to_pts
    radius = 5.0 * mm_to_pts
    coords = []
    for center_x, center_y, start_degrees in (
        (half_width - radius, half_height - radius, 0.0),
        (-half_width + radius, half_height - radius, 90.0),
        (-half_width + radius, -half_height + radius, 180.0),
        (half_width - radius, -half_height + radius, 270.0),
    ):
        for step in range(17):
            angle = math.radians(start_degrees + 90.0 * step / 16.0)
            coords.append((
                35.0 * mm_to_pts + center_x + radius * math.cos(angle),
                25.0 * mm_to_pts + center_y + radius * math.sin(angle),
            ))
    groups = cutline_preview_module._exact_shape_path_groups(
        {
            "kind": "rounded_rect",
            "coordinate_unit": "pt",
            "coords": coords,
        },
        left_px=0,
        top_px=0,
        dpi=300.0,
        dpi_y=300.0,
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=0.0,
        corner_style="round",
        curve_tension=100.0,
    )

    assert groups is not None
    assert len(groups[0]["exterior"]) == 8


def test_offset_tam_giac_nhon_khong_bi_miter_limit_vat_them_dinh() -> None:
    mm_to_pts = 72.0 / 25.4
    groups = cutline_preview_module._exact_shape_path_groups(
        {
            "kind": "triangle",
            "coordinate_unit": "pt",
            "coords": [
                (0.0, 100.0 * mm_to_pts),
                (10.0 * mm_to_pts, 0.0),
                (20.0 * mm_to_pts, 100.0 * mm_to_pts),
            ],
        },
        left_px=0,
        top_px=0,
        dpi=300.0,
        dpi_y=300.0,
        cut_mode="original",
        offset_mm=1.0,
        bleed_mm=0.0,
        corner_style="round",
        curve_tension=100.0,
    )

    assert groups is not None
    assert len(groups[0]["exterior"]) == 6


@pytest.mark.parametrize("sides", [3, 4, 5, 6, 7, 8])
@pytest.mark.parametrize("rotation", [0.0, 0.17])
def test_mask_polygon_dung_fillet_va_ton_trong_do_bo_cong(
    sides: int,
    rotation: float,
) -> None:
    mask = np.zeros((520, 520), dtype=np.uint8)
    points = np.asarray(
        _regular_polygon(sides, radius=190.0, rotation=rotation)
    ) + 260.0
    cv2.fillPoly(mask, [np.round(points).astype(np.int32)], 255, lineType=cv2.LINE_AA)

    results = [
        build_alpha_cutline_geometry(
            mask,
            dpi=300.0,
            dpi_y=300.0,
            corner_style="round",
            cutline_smoothness=50.0,
            cutline_fidelity=50.0,
            curve_tension=tension,
            min_detail_area_mm2=0.0,
        )
        for tension in (50.0, 100.0)
    ]

    assert all(result is not None for result in results)
    soft, rounded = results
    assert soft["fit_mode"] == "analytic-fillet"
    assert rounded["fit_mode"] == "analytic-fillet"
    assert soft["paths"] != rounded["paths"]
    assert len(rounded["paths"][0]) == sides * 2
    assert rounded["quality"]["machine_safe"] is True
    assert rounded["quality"]["unprotected_join_count"] == 0
    assert rounded["quality"]["maximum_join_angle_degrees"] < 0.001


def test_hinh_loi_custom_khong_bi_ep_sang_fillet_da_giac() -> None:
    mask = np.zeros((520, 520), dtype=np.uint8)
    points = []
    for index in range(12):
        radius = 190.0 if index % 2 == 0 else 82.0
        angle = -math.pi / 2.0 + index * math.pi / 6.0
        points.append((
            260.0 + radius * math.cos(angle),
            260.0 + radius * math.sin(angle),
        ))
    cv2.fillPoly(
        mask,
        [np.round(np.asarray(points)).astype(np.int32)],
        255,
        lineType=cv2.LINE_AA,
    )

    result = build_alpha_cutline_geometry(
        mask,
        dpi=300.0,
        corner_style="round",
        curve_tension=100.0,
        min_detail_area_mm2=0.0,
    )

    assert result is not None
    assert result["fit_mode"] != "analytic-fillet"


def test_elip_det_khong_bi_nhan_nham_thanh_da_giac() -> None:
    mask = np.zeros((260, 360), dtype=np.uint8)
    cv2.ellipse(mask, (180, 130), (105, 48), 23.0, 0.0, 360.0, 255, -1, cv2.LINE_AA)

    result = build_alpha_cutline_geometry(
        mask,
        dpi=300.0,
        corner_style="round",
        curve_tension=100.0,
        min_detail_area_mm2=0.0,
    )

    assert result is not None
    assert result["fit_mode"] != "analytic-fillet"


def test_exact_path_khong_an_toan_phai_dung_truoc_khi_vao_cache(tmp_path) -> None:
    session = _session(tmp_path, convex=True)
    mm_to_pts = 72.0 / 25.4
    tiny_side = 0.20 * mm_to_pts
    exact_shapes = [{
        "instance_id": 1,
        "kind": "rect",
        "coordinate_unit": "pt",
        "coords": [
            (100.0, 100.0),
            (100.0 + tiny_side, 100.0),
            (100.0 + tiny_side, 100.0 + tiny_side),
            (100.0, 100.0 + tiny_side),
        ],
    }]
    session.manifest["vector_geometry_ref"] = {"exact_shapes": exact_shapes}
    session.pages[1].manifest["vector_geometry_ref"] = {
        "exact_shapes": exact_shapes,
    }

    with pytest.raises(StickerSheetExportError, match="chưa an toàn"):
        build_sticker_cutline_preview(
            session,
            page_number=1,
            base_revision=3,
            edits=[],
            dpi=100.0,
            dpi_y=100.0,
            offset_mm=0.0,
            bleed_mm=0.0,
            cut_mode="original",
            corner_style="round",
            fill_holes=True,
            cutline_smoothness=50.0,
            cutline_fidelity=50.0,
            curve_tension=100.0,
            min_detail_area_mm2=0.0,
        )


def test_exact_shape_khi_tat_duong_cat_la_ket_qua_hop_le(tmp_path) -> None:
    session = _session(tmp_path, convex=True)
    exact_shapes = [{
        "instance_id": 1,
        "kind": "rect",
        "coordinate_unit": "pt",
        "coords": [
            (20.0, 20.0),
            (120.0, 20.0),
            (120.0, 90.0),
            (20.0, 90.0),
        ],
    }]
    session.manifest["vector_geometry_ref"] = {"exact_shapes": exact_shapes}
    session.pages[1].manifest["vector_geometry_ref"] = {
        "exact_shapes": exact_shapes,
    }

    result = build_sticker_cutline_preview(
        session,
        page_number=1,
        base_revision=3,
        edits=[],
        dpi=100.0,
        dpi_y=100.0,
        offset_mm=0.0,
        bleed_mm=2.0,
        cut_mode="none",
        corner_style="round",
        fill_holes=True,
        cutline_smoothness=50.0,
        cutline_fidelity=50.0,
        curve_tension=100.0,
        min_detail_area_mm2=0.0,
    )

    assert result["paths"] == []
    assert result["segment_count"] == 0
    assert result["quality"]["machine_safe"] is True


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


def _prime_classic_preview_artifact(
    tmp_path,
    monkeypatch,
    *,
    cut_mode: str = "original",
):
    """Tạo session một-tem có cache Bézier đúng như preview classic vừa duyệt."""
    session = _session(tmp_path)
    source_pdf = tmp_path / "source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n% classic preview fixture\n")
    session.source_path = source_pdf
    session.original_name = source_pdf.name
    session.source_kind = "pdf"
    session.last_access = time.monotonic()
    preview = _preview(session, tension=50.0, cut_mode=cut_mode)
    monkeypatch.setitem(session_store._SESSIONS, session.session_id, session)
    return session, source_pdf, preview


def _classic_execute_form(source_pdf, preview, **overrides):
    form = {
        "file_path": str(source_pdf),
        "cut_mode": "original",
        "offset_mm": "0",
        "bleed_mm": "2",
        "corner_style": "preserve",
        "curve_tension": "50",
        "fill_holes": "true",
        "remove_white_bg": "true",
        "shape_mode": "auto_safe",
        "crop_to_sticker": "true",
        "cutline_preview_session_id": "a" * 32,
        "cutline_preview_revision": "3",
        "cutline_preview_fingerprint": preview["fingerprint"],
    }
    form.update(overrides)
    return form


@pytest.mark.parametrize(
    ("cut_mode", "remove_white_bg"),
    (("original", "true"), ("alpha", "false")),
)
def test_execute_classic_tai_dung_artifact_preview_khong_detect_hoac_fit_lan_hai(
    tmp_path,
    monkeypatch,
    cut_mode,
    remove_white_bg,
) -> None:
    """Nút Thực thi phải chuyển thẳng cache đã xem, không dựng một quỹ đạo khác."""
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine, sticker_source_pipeline

    session, source_pdf, preview = _prime_classic_preview_artifact(
        tmp_path,
        monkeypatch,
        cut_mode=cut_mode,
    )
    cached_paths = session.pages[1].cutline_export_cache["instances"]
    captured = {}

    def forbidden_detect(*_args, **_kwargs):
        pytest.fail("Execute classic đã nhận diện lại thay vì dùng artifact preview")

    def forbidden_fit(*_args, **_kwargs):
        pytest.fail("Execute classic đã fit lại thay vì dùng Bézier preview")

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    class FakeRequest:
        async def form(self):
            return _classic_execute_form(
                source_pdf,
                preview,
                cut_mode=cut_mode,
                remove_white_bg=remove_white_bg,
            )

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(
        sticker_source_pipeline,
        "build_legacy_single_page_approved_contour",
        forbidden_detect,
    )
    monkeypatch.setattr(
        cutline_preview_module,
        "fit_prepared_alpha_cutline_geometry",
        forbidden_fit,
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    overrides = captured["approved_contour_overrides"]
    assert list(overrides) == [0]
    # Cache preview giữ ring trong crop cục bộ; engine classic làm việc trên toàn
    # trang nên snapshot phải chỉ tịnh tiến đúng origin crop, không fit lại.
    expected_paths = _translate_cutline_path_groups(
        cached_paths[0]["path_groups"],
        offset_x_points=float(cached_paths[0]["left"]) * 72.0 / 100.0,
        offset_y_points=float(cached_paths[0]["top"]) * 72.0 / 100.0,
    )
    assert overrides[0]["path_groups"] == expected_paths
    assert overrides[0]["alpha"].shape == (140, 180)
    assert os.path.exists(response.path)


@pytest.mark.parametrize(
    "stale_field,stale_value",
    [
        ("cutline_preview_revision", "2"),
        ("cutline_preview_fingerprint", "b" * 64),
    ],
)
def test_execute_classic_tu_choi_artifact_preview_cu(
    tmp_path,
    monkeypatch,
    stale_field,
    stale_value,
) -> None:
    """Revision/hash lệch phải dừng trước detect, fit và trước khi chạy engine."""
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine, sticker_source_pipeline

    _session_value, source_pdf, preview = _prime_classic_preview_artifact(
        tmp_path,
        monkeypatch,
    )

    def forbidden_work(*_args, **_kwargs):
        pytest.fail("Artifact stale vẫn lọt vào detect/fit/engine")

    class ForbiddenEngine:
        def __init__(self, dpi=300):
            forbidden_work(dpi)

    class FakeRequest:
        async def form(self):
            return _classic_execute_form(
                source_pdf,
                preview,
                **{stale_field: stale_value},
            )

    monkeypatch.setattr(sticker_engine, "StickerEngine", ForbiddenEngine)
    monkeypatch.setattr(
        sticker_source_pipeline,
        "build_legacy_single_page_approved_contour",
        forbidden_work,
    )
    monkeypatch.setattr(
        cutline_preview_module,
        "fit_prepared_alpha_cutline_geometry",
        forbidden_work,
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args: None)

    with pytest.raises(HTTPException) as raised:
        asyncio.run(pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={}))

    assert raised.value.status_code == 409
    assert "preview" in str(raised.value.detail).lower()


def test_execute_tach_nhieu_tem_khong_doc_artifact_preview_classic(
    tmp_path,
    monkeypatch,
) -> None:
    """Selection/multi giữ pipeline riêng dù request có metadata classic dư thừa."""
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine, sticker_source_pipeline

    source_pdf = tmp_path / "multi.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n% multi fixture\n")
    captured = {}

    def forbidden_classic_detect(*_args, **_kwargs):
        pytest.fail("Nhánh nhiều tem đã rơi vào detector classic một-tem")

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}], "selection_count": 1}

    class FakeRequest:
        async def form(self):
            return {
                "file_path": str(source_pdf),
                "cut_mode": "original",
                "remove_white_bg": "true",
                "shape_mode": "auto_safe",
                "crop_to_sticker": "true",
                "selection_json": (
                    '{"pages":[{"page":0,"object_ids":["image-1"]}]}'
                ),
                # Metadata dư không được kéo selection vào contract một-tem.
                "cutline_preview_session_id": "f" * 32,
                "cutline_preview_revision": "999",
                "cutline_preview_fingerprint": "b" * 64,
            }

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(
        sticker_source_pipeline,
        "build_legacy_single_page_approved_contour",
        forbidden_classic_detect,
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    assert captured["selected_objects_by_page"] == {0: ["image-1"]}
    assert captured["approved_contour_overrides"] is None
    assert os.path.exists(response.path)
