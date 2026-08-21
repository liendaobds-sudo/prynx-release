"""Hợp đồng geometry dùng chung giữa live preview và CutContour xuất file."""

from __future__ import annotations

import cv2
import json
import math
import numpy as np
from PIL import Image
import pikepdf
import pytest
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

import app.workers.sticker_engine as sticker_engine_module
import app.workers.sticker_sheet_export as sticker_export_module
from app.workers.sticker_engine import (
    _PT_PER_MM,
    _alpha_override_geometry,
    _cutline_fidelity_budget_scale,
    _cutline_round_radius_mm,
    _cutline_smoothness_scale,
    _cutline_tension_handle_scale,
    _fit_alpha_bezier_paths,
    _fit_alpha_bezier_paths_core,
    build_bezier_segments_path_stream,
    build_alpha_cutline_geometry,
    should_presmooth_cutline_alpha,
)
from app.workers.cutline_machine_path import (
    analyze_machine_path,
    cubic_segments_from_tuples,
)
from app.workers.sticker_sheet_export import _build_cutline_pdf_from_pngs
from app.workers.sticker_sheet_export import StickerSheetExportError


def _wavy_polygon() -> Polygon:
    return Polygon([
        (0.0, 0.0),
        (18.0, -1.0),
        (31.0, 4.0),
        (35.0, 18.0),
        (28.0, 31.0),
        (12.0, 35.0),
        (-2.0, 27.0),
        (-5.0, 12.0),
        (0.0, 0.0),
    ])


def _sharp_mask(kind: str, *, dpi: float = 300.0) -> np.ndarray:
    """Hai biên có góc thật từng làm fallback sinh đoạn dao cực ngắn."""
    scale = dpi / 25.4
    size = round(64.0 * scale)
    mask = np.zeros((size, size), dtype=np.uint8)

    def point(x_mm: float, y_mm: float) -> tuple[int, int]:
        return round(x_mm * scale), round(y_mm * scale)

    if kind == "star":
        points = []
        for index in range(10):
            angle = -math.pi / 2.0 + index * math.pi / 5.0
            radius_mm = 25.0 if index % 2 == 0 else 10.5
            points.append(point(
                32.0 + radius_mm * math.cos(angle),
                32.0 + radius_mm * math.sin(angle),
            ))
    elif kind == "notch":
        points = [
            point(x_mm, y_mm)
            for x_mm, y_mm in (
                (8, 12), (56, 12), (56, 52), (38, 52), (38, 34),
                (35, 30), (32, 34), (29, 30), (26, 34), (26, 52),
                (8, 52),
            )
        ]
    else:  # pragma: no cover - chỉ bảo vệ helper test khỏi gọi sai.
        raise ValueError(f"Hình test không hợp lệ: {kind}")
    cv2.fillPoly(mask, [np.asarray(points, dtype=np.int32)], 255, cv2.LINE_AA)
    return mask


def test_tuning_default_giu_dung_profile_cu() -> None:
    assert _cutline_smoothness_scale(50) == 1.0
    assert _cutline_fidelity_budget_scale(50) == 1.0
    assert _cutline_tension_handle_scale(50) == 1.0

    geometry = _wavy_polygon()
    common = {
        "total_offset_pts": 0.0,
        "mm_to_pts": 72.0 / 25.4,
        "corner_policy": "adaptive",
        "source_pixel_mm": 0.12,
        "allow_high_resolution_fairing": True,
    }
    tuned = _fit_alpha_bezier_paths(geometry, geometry, **common)
    legacy = _fit_alpha_bezier_paths_core(geometry, geometry, **common)

    assert tuned is not None
    assert legacy is not None
    assert tuned[1] == legacy[1]


def test_suc_cang_duoc_tu_dong_hoa_khong_lam_cung_duong_cong() -> None:
    geometry = _wavy_polygon()
    common = {
        "total_offset_pts": 0.0,
        "mm_to_pts": 72.0 / 25.4,
        "corner_policy": "adaptive",
        "source_pixel_mm": 0.12,
        "allow_high_resolution_fairing": True,
    }
    soft = _fit_alpha_bezier_paths(
        geometry,
        geometry,
        curve_tension=10,
        **common,
    )
    tight = _fit_alpha_bezier_paths(
        geometry,
        geometry,
        curve_tension=90,
        **common,
    )

    assert soft is not None
    assert tight is not None
    assert soft[0].is_valid and tight[0].is_valid
    assert soft[1] == tight[1]


def test_do_bo_cong_dieu_khien_ban_kinh_round_thuc() -> None:
    assert _cutline_round_radius_mm(0, 25.4 / 72.0) == pytest.approx(0.0)
    assert _cutline_round_radius_mm(50, 25.4 / 72.0) == pytest.approx(1.5)
    assert _cutline_round_radius_mm(50, 25.4 / 300.0) == pytest.approx(1.5)
    assert _cutline_round_radius_mm(100, 25.4 / 300.0) == pytest.approx(3.0)

    mask = np.zeros((240, 300), dtype=np.uint8)
    points = np.array([
        [18, 120], [62, 103], [76, 28], [126, 92], [192, 48],
        [180, 121], [276, 145], [187, 168], [166, 224], [112, 177], [38, 206],
    ], dtype=np.int32)
    cv2.fillPoly(mask, [points], 255, lineType=cv2.LINE_AA)

    keep_corner = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        corner_style="round",
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=0,
    )
    rounded = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        corner_style="round",
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=100,
    )

    assert keep_corner is not None and rounded is not None
    assert keep_corner["paths"] != rounded["paths"]
    assert rounded["geometry"].is_valid
    assert rounded["quality"]["machine_safe"] is True
    assert rounded["quality"]["short_segment_count"] == 0
    assert rounded["quality"]["disconnected_join_count"] == 0
    assert rounded["quality"]["unprotected_join_count"] == 0
    assert rounded["quality"]["effective_deviation_mm"] <= 1.30


def test_lọc_chi_tiet_roi_va_payload_override_dung_cung_geometry() -> None:
    mask = np.zeros((150, 210), dtype=np.uint8)
    cv2.circle(mask, (80, 75), 48, 255, thickness=-1, lineType=cv2.LINE_AA)
    cv2.circle(mask, (80, 75), 2, 0, thickness=-1, lineType=cv2.LINE_AA)
    cv2.circle(mask, (180, 20), 2, 255, thickness=-1, lineType=cv2.LINE_AA)

    keep = build_alpha_cutline_geometry(
        mask,
        dpi=100,
        min_detail_area_mm2=0.0,
    )
    filtered = build_alpha_cutline_geometry(
        mask,
        dpi=100,
        min_detail_area_mm2=1.0,
        fill_holes=False,
    )

    assert keep is not None
    assert filtered is not None
    assert len(keep["path_groups"]) == 2
    assert len(filtered["path_groups"]) == 1
    assert len(filtered["path_groups"][0]["interiors"]) == 1
    restored = _alpha_override_geometry({
        "path_groups": filtered["path_groups"],
    })
    assert restored is not None
    restored_geometry, restored_paths = restored
    assert restored_geometry.equals_exact(filtered["geometry"], tolerance=1e-6)
    assert restored_paths == filtered["paths"]


def test_do_muot_doi_quy_dao_va_khong_sinh_lenh_dao_ngan_gay_khuc() -> None:
    mask = np.zeros((240, 300), dtype=np.uint8)
    points = np.array([
        [18, 120], [62, 103], [76, 28], [126, 92], [192, 48],
        [180, 121], [276, 145], [187, 168], [166, 224], [112, 177], [38, 206],
    ], dtype=np.int32)
    cv2.fillPoly(mask, [points], 255, lineType=cv2.LINE_AA)

    detailed = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        cutline_smoothness=15,
        cutline_fidelity=50,
    )
    smooth = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        cutline_smoothness=85,
        cutline_fidelity=50,
    )

    assert detailed is not None and smooth is not None
    json.dumps(smooth["path_groups"])
    assert detailed["path_groups"] != smooth["path_groups"]
    assert sum(len(path) for path in smooth["paths"]) < 100
    for path in smooth["paths"]:
        metrics = analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=_PT_PER_MM,
            smooth_join_threshold_degrees=1.0,
            short_segment_threshold_mm=0.25,
        )
        assert metrics.disconnected_join_count == 0
        assert metrics.discontinuous_join_count == 0
        assert metrics.short_segment_count == 0


def test_path_groups_chuyen_ndarray_thanh_so_json_truoc_khi_cache() -> None:
    """Fallback thích nghi có thể trả ndarray; cache preview chỉ nhận số thuần."""
    polygon = Polygon([(0, 0), (20, 0), (20, 10), (0, 10), (0, 0)])
    numpy_ring = np.asarray(
        sticker_engine_module._linear_bezier_ring(polygon.exterior.coords),
        dtype=np.float64,
    )

    groups = sticker_engine_module._group_alpha_paths_like(polygon, [numpy_ring])

    json.dumps(groups, allow_nan=False)
    assert isinstance(groups[0]["exterior"][0][0][0], float)


def test_tang_bo_cong_giam_nhay_do_cong_va_van_an_toan_may() -> None:
    """Đo bo độc lập ở cùng fidelity; không dùng số node làm đại diện độ mượt."""
    mask = np.zeros((240, 300), dtype=np.uint8)
    points = np.array([
        [18, 120], [62, 103], [76, 28], [126, 92], [192, 48],
        [180, 121], [276, 145], [187, 168], [166, 224], [112, 177], [38, 206],
    ], dtype=np.int32)
    cv2.fillPoly(mask, [points], 255, lineType=cv2.LINE_AA)

    unrounded = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        cutline_smoothness=50,
        cutline_fidelity=20,
        curve_tension=0,
    )
    rounded = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        cutline_smoothness=50,
        cutline_fidelity=20,
        curve_tension=100,
    )

    assert unrounded is not None and rounded is not None
    assert unrounded["paths"] != rounded["paths"]
    unrounded_metrics = [
        analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=_PT_PER_MM,
            smooth_join_threshold_degrees=1.0,
            short_segment_threshold_mm=0.25,
        )
        for path in unrounded["paths"]
    ]
    rounded_metrics = [
        analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=_PT_PER_MM,
            smooth_join_threshold_degrees=1.0,
            short_segment_threshold_mm=0.25,
        )
        for path in rounded["paths"]
    ]

    assert sum(metric.curvature_sign_flip_count for metric in rounded_metrics) <= sum(
        metric.curvature_sign_flip_count for metric in unrounded_metrics
    )
    assert max(
        float(metric.maximum_curvature_jump_per_mm or 0.0)
        for metric in rounded_metrics
    ) < max(
        float(metric.maximum_curvature_jump_per_mm or 0.0)
        for metric in unrounded_metrics
    )
    assert all(metric.short_segment_count == 0 for metric in rounded_metrics)
    assert all(metric.disconnected_join_count == 0 for metric in rounded_metrics)
    assert all(metric.discontinuous_join_count == 0 for metric in rounded_metrics)
    assert rounded["quality"]["machine_safe"] is True


@pytest.mark.parametrize("kind", ("star", "notch"))
@pytest.mark.parametrize("fidelity", (0, 20, 50, 100))
def test_truc_muot_bam_sat_khong_pha_hinh_goc_that(
    kind: str,
    fidelity: float,
) -> None:
    result = build_alpha_cutline_geometry(
        _sharp_mask(kind),
        dpi=300,
        dpi_y=300,
        corner_style="round",
        cutline_smoothness=max(50, 100 - fidelity),
        cutline_fidelity=fidelity,
        curve_tension=50,
        min_detail_area_mm2=0,
    )

    assert result is not None
    assert result["geometry"].is_valid
    assert result["quality"]["machine_safe"] is True
    assert result["quality"]["short_segment_count"] == 0
    assert result["quality"]["disconnected_join_count"] == 0
    assert result["quality"]["unprotected_join_count"] == 0


def test_bo_round_van_giu_lo_that_cua_tem() -> None:
    mask = np.zeros((240, 240), dtype=np.uint8)
    cv2.circle(mask, (120, 120), 92, 255, thickness=-1, lineType=cv2.LINE_AA)
    cv2.circle(mask, (120, 120), 24, 0, thickness=-1, lineType=cv2.LINE_AA)

    result = build_alpha_cutline_geometry(
        mask,
        dpi=72,
        dpi_y=72,
        corner_style="round",
        fill_holes=False,
        cutline_smoothness=80,
        cutline_fidelity=20,
        curve_tension=50,
    )

    assert result is not None
    assert result["quality"]["machine_safe"] is True
    assert len(result["path_groups"]) == 1
    assert len(result["path_groups"][0]["interiors"]) == 1


@pytest.mark.parametrize(
    ("kind", "minimum_protected_corners"),
    (("star", 10), ("notch", 9)),
)
def test_kiem_tra_cuoi_bao_ve_goc_that_nhung_loai_doan_dao_ngan(
    kind: str,
    minimum_protected_corners: int,
) -> None:
    result = build_alpha_cutline_geometry(
        _sharp_mask(kind),
        dpi=300,
        dpi_y=300,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=0,
    )

    assert result is not None
    quality = result["quality"]
    assert quality["machine_safe"] is True
    assert quality["short_segment_count"] == 0
    assert quality["disconnected_join_count"] == 0
    assert quality["unprotected_join_count"] == 0
    assert quality["protected_corner_count"] >= minimum_protected_corners
    assert quality["minimum_segment_length_mm"] >= 0.25
    assert quality["fit_mode"] == result["fit_mode"]


def test_khong_con_fallback_an_toan_thi_phai_dung_thay_vi_xuat_duong_xau(
    monkeypatch,
) -> None:
    prepared = sticker_engine_module.prepare_alpha_cutline_geometry(
        _sharp_mask("star"),
        dpi=300,
        dpi_y=300,
        min_detail_area_mm2=0,
    )
    assert prepared is not None
    monkeypatch.setattr(
        sticker_engine_module,
        "_fit_preserved_contour_paths",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        sticker_engine_module,
        "_fit_alpha_bezier_paths",
        lambda *args, **kwargs: None,
    )

    with pytest.raises(RuntimeError, match="an toàn"):
        sticker_engine_module.fit_prepared_alpha_cutline_geometry(prepared)


def test_offset_am_van_phai_qua_cung_cong_an_toan() -> None:
    result = build_alpha_cutline_geometry(
        _sharp_mask("star"),
        dpi=300,
        dpi_y=300,
        offset_mm=-1.0,
        min_detail_area_mm2=0,
    )

    assert result is not None
    assert result["quality"]["machine_safe"] is True
    assert result["quality"]["short_segment_count"] == 0
    assert result["quality"]["unprotected_join_count"] == 0


def test_export_khong_am_tham_bo_override_roi_tu_fit_lai(
    tmp_path,
    monkeypatch,
) -> None:
    rgba = np.zeros((96, 96, 4), dtype=np.uint8)
    alpha = np.zeros((96, 96), dtype=np.uint8)
    cv2.circle(alpha, (48, 48), 34, 255, -1, cv2.LINE_AA)
    rgba[:, :, 3] = alpha
    rgba[:, :, :3] = (80, 160, 220)
    png_path = tmp_path / "tem.png"
    Image.fromarray(rgba, "RGBA").save(png_path, dpi=(300, 300))

    monkeypatch.setattr(
        sticker_export_module,
        "build_alpha_cutline_geometry",
        lambda *args, **kwargs: None,
    )

    def forbidden_refit(*args, **kwargs):
        pytest.fail("Export đã bỏ override rồi âm thầm gọi fitter thứ hai")

    monkeypatch.setattr(
        sticker_export_module.StickerEngine,
        "process_pdf",
        forbidden_refit,
    )
    with pytest.raises(StickerSheetExportError, match="đường bế an toàn"):
        _build_cutline_pdf_from_pngs(
            [png_path],
            tmp_path,
            dpi=300,
            dpi_y=300,
            offset_mm=0,
            bleed_mm=0,
            cut_mode="original",
            corner_style="preserve",
            fill_holes=True,
            crop_to_sticker=True,
            bleed_color_type="image",
            solid_bleed_cmyk=(0, 0, 0, 0),
            shape_mode="contour",
            draw_cut_contour=True,
        )


@pytest.mark.parametrize("corner_style", ["preserve", "round"])
def test_pdf_xuat_dung_chinh_so_doan_bezier_da_preview(
    tmp_path,
    corner_style: str,
) -> None:
    rgba = np.zeros((140, 180, 4), dtype=np.uint8)
    points = np.array([
        [12, 70], [42, 56], [57, 14], [88, 51], [126, 26],
        [118, 70], [166, 88], [117, 101], [103, 132], [68, 105], [24, 121],
    ], dtype=np.int32)
    alpha = np.zeros((140, 180), dtype=np.uint8)
    cv2.fillPoly(alpha, [points], 255, lineType=cv2.LINE_AA)
    rgba[:, :, 3] = alpha
    rgba[:, :, :3] = (90, 170, 220)
    png_path = tmp_path / "tem.png"
    Image.fromarray(rgba, "RGBA").save(png_path, dpi=(72, 72))
    preview_geometry = build_alpha_cutline_geometry(
        alpha,
        dpi=72,
        dpi_y=72,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        corner_style=corner_style,
    )
    assert preview_geometry is not None

    output_path = _build_cutline_pdf_from_pngs(
        [png_path],
        tmp_path,
        dpi=72,
        dpi_y=72,
        offset_mm=0,
        bleed_mm=0,
        cut_mode="original",
        corner_style=corner_style,
        fill_holes=True,
        crop_to_sticker=True,
        bleed_color_type="image",
        solid_bleed_cmyk=(0, 0, 0, 0),
        shape_mode="contour",
        draw_cut_contour=True,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=1,
    )
    with pikepdf.Pdf.open(output_path) as document:
        contents = document.pages[0].Contents
        if isinstance(contents, pikepdf.Array):
            content = "\n".join(
                stream.read_bytes().decode("latin1") for stream in contents
            )
        else:
            content = contents.read_bytes().decode("latin1")
    cut_content = content.rsplit("/CutContour CS", 1)[-1]
    exported_cubics = [
        line.strip() for line in cut_content.splitlines() if line.strip().endswith(" c")
    ]
    expected_commands = []
    for path in preview_geometry["paths"]:
        expected_commands.extend(build_bezier_segments_path_stream(path, 140.0))
    expected_cubics = [
        line.strip() for line in expected_commands if line.strip().endswith(" c")
    ]
    assert exported_cubics == expected_cubics


def _cached_rectangle_path_groups() -> list[dict[str, object]]:
    ring = [
        ((0.0, 0.0), (2.0, 0.0), (4.0, 0.0), (6.0, 0.0)),
        ((6.0, 0.0), (6.0, 2.0), (6.0, 4.0), (6.0, 6.0)),
        ((6.0, 6.0), (4.0, 6.0), (2.0, 6.0), (0.0, 6.0)),
        ((0.0, 6.0), (0.0, 4.0), (0.0, 2.0), (0.0, 0.0)),
    ]
    return [{"exterior": ring, "interiors": []}]


def test_khoa_cache_preview_phu_day_du_tham_so_xuat() -> None:
    base = {
        "page_number": 2,
        "revision": 7,
        "edits": [{"kind": "merge", "source_id": 2, "target_id": 1}],
        "dpi": 150.0,
        "dpi_y": 144.0,
        "offset_mm": 0.4,
        "bleed_mm": 2.0,
        "cut_mode": "bleed",
        "corner_style": "round",
        "fill_holes": True,
        "cutline_smoothness": 52.0,
        "cutline_fidelity": 61.0,
        "curve_tension": 48.0,
        "min_detail_area_mm2": 0.8,
        "cutline_denoise": 70.0,
    }
    original = sticker_export_module._cutline_export_cache_key(**base)
    variants = {
        "page_number": 3,
        "revision": 8,
        "edits": [],
        "dpi": 151.0,
        "dpi_y": 145.0,
        "offset_mm": 0.5,
        "bleed_mm": 2.1,
        "cut_mode": "original",
        "corner_style": "preserve",
        "fill_holes": False,
        "cutline_smoothness": 53.0,
        "cutline_fidelity": 62.0,
        "curve_tension": 49.0,
        "min_detail_area_mm2": 0.9,
        "cutline_denoise": 71.0,
    }

    changed = {
        sticker_export_module._cutline_export_cache_key(
            **{**base, field: value}
        )
        for field, value in variants.items()
    }
    assert original not in changed
    assert len(changed) == len(variants)

    # PERF (feedback 2026-08-11 §CUTLINE.NOREBUILD2): ở chế độ original,
    # bleed chỉ đổi phần ảnh bù xén chứ không đổi quỹ đạo CutContour.
    original_mode = {**base, "cut_mode": "original"}
    assert sticker_export_module._cutline_export_cache_key(
        **original_mode
    ) == sticker_export_module._cutline_export_cache_key(
        **{**original_mode, "bleed_mm": 2.1}
    )


def test_cache_preview_anh_xa_dung_tung_tem_va_dich_dung_toan_tam() -> None:
    groups = _cached_rectangle_path_groups()
    page = type("Page", (), {})()
    page.cutline_export_cache = {
        "key": "khop",
        "instances": [
            {"instance_id": 2, "left": 20, "top": 30, "path_groups": groups},
            {"instance_id": 1, "left": 10, "top": 15, "path_groups": groups},
        ],
    }

    separated = sticker_export_module._cutline_overrides_from_preview_cache(
        page,
        cache_key="khop",
        instance_ids=[1, 2],
        crop_to_sticker=True,
        dpi=144,
        dpi_y=72,
    )
    assert separated is not None
    assert len(separated) == 2
    assert separated[0]["path_groups"] == groups

    whole = sticker_export_module._cutline_overrides_from_preview_cache(
        page,
        cache_key="khop",
        instance_ids=[1, 2],
        crop_to_sticker=False,
        dpi=144,
        dpi_y=72,
    )
    assert whole is not None
    assert len(whole) == 1
    translated_groups = whole[0]["path_groups"]
    assert len(translated_groups) == 2
    first_start = translated_groups[0]["exterior"][0][0]
    second_start = translated_groups[1]["exterior"][0][0]
    assert first_start == pytest.approx((5.0, 15.0))
    assert second_start == pytest.approx((10.0, 30.0))

    assert sticker_export_module._cutline_overrides_from_preview_cache(
        page,
        cache_key="stale",
        instance_ids=[1, 2],
        crop_to_sticker=True,
        dpi=144,
        dpi_y=72,
    ) is None


@pytest.mark.parametrize(
    ("dpi", "dpi_y", "expected"),
    [
        (36.0, 36.0, 72),
        (72.0, 72.0, 72),
        (150.0, 144.0, 150),
        (144.0, 150.0, 150),
        (300.0, 300.0, 300),
        (600.0, 600.0, 300),
    ],
)
def test_dpi_engine_thich_ung_khong_noi_suy_vo_ich(
    dpi: float,
    dpi_y: float,
    expected: int,
) -> None:
    assert sticker_export_module._sticker_engine_dpi(dpi, dpi_y) == expected


def test_export_chi_fit_lai_trang_thieu_override(tmp_path, monkeypatch) -> None:
    rgba = np.zeros((64, 64, 4), dtype=np.uint8)
    alpha = np.zeros((64, 64), dtype=np.uint8)
    cv2.circle(alpha, (32, 32), 22, 255, -1, cv2.LINE_AA)
    rgba[:, :, 3] = alpha
    rgba[:, :, :3] = (80, 160, 220)
    png_paths = []
    for index in range(2):
        path = tmp_path / f"tem_{index}.png"
        Image.fromarray(rgba, "RGBA").save(path, dpi=(72, 72))
        png_paths.append(path)

    geometry = build_alpha_cutline_geometry(alpha, dpi=72, dpi_y=72)
    assert geometry is not None
    fit_calls = 0
    original_build = sticker_export_module.build_alpha_cutline_geometry

    def count_build(*args, **kwargs):
        nonlocal fit_calls
        fit_calls += 1
        return original_build(*args, **kwargs)

    captured: dict[int, dict[str, object]] = {}

    def copy_input(self, *, input_path: str, output_path: str, **kwargs):
        captured.update(kwargs.get("alpha_path_overrides") or {})
        with open(input_path, "rb") as source, open(output_path, "wb") as target:
            target.write(source.read())
        return True, {}

    monkeypatch.setattr(sticker_export_module, "build_alpha_cutline_geometry", count_build)
    monkeypatch.setattr(sticker_export_module.StickerEngine, "process_pdf", copy_input)
    _build_cutline_pdf_from_pngs(
        png_paths,
        tmp_path,
        dpi=72,
        dpi_y=72,
        offset_mm=0,
        bleed_mm=0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        crop_to_sticker=True,
        bleed_color_type="image",
        solid_bleed_cmyk=(0, 0, 0, 0),
        shape_mode="contour",
        draw_cut_contour=True,
        alpha_path_override_sequence=[
            {"path_groups": geometry["path_groups"]},
            None,
        ],
    )

    assert fit_calls == 1
    assert sorted(captured) == [0, 1]


def test_png_pdf_tam_nen_nhanh_nhung_png_zip_van_toi_uu(tmp_path, monkeypatch) -> None:
    rgba = np.zeros((40, 60, 4), dtype=np.uint8)
    rgba[5:35, 8:52] = (40, 120, 220, 255)
    labels = np.zeros((40, 60), dtype=np.int32)
    labels[5:35, 8:52] = 1
    save_options: list[dict[str, object]] = []
    original_save = Image.Image.save

    def capture_save(self, fp, *args, **kwargs):
        save_options.append(dict(kwargs))
        return original_save(self, fp, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "save", capture_save)
    pdf_dir = tmp_path / "pdf"
    zip_dir = tmp_path / "zip"
    pdf_dir.mkdir()
    zip_dir.mkdir()
    pdf_paths, _ = sticker_export_module._prepare_output_pngs(
        pdf_dir,
        rgba,
        labels,
        72,
        72,
        output_format="pdf",
        crop_to_sticker=True,
    )
    zip_paths, _ = sticker_export_module._prepare_output_pngs(
        zip_dir,
        rgba,
        labels,
        72,
        72,
        output_format="png_zip",
        crop_to_sticker=True,
    )

    assert save_options[0].get("compress_level") == 1
    assert "optimize" not in save_options[0]
    assert save_options[1].get("optimize") is True
    assert "compress_level" not in save_options[1]
    with Image.open(pdf_paths[0]) as pdf_png, Image.open(zip_paths[0]) as zip_png:
        assert np.array_equal(np.asarray(pdf_png), np.asarray(zip_png))


# ---------------------------------------------------------------------------
# §CUTJAG.1 — khử răng cưa Alpha trước marching-squares, cổng theo nguồn biên
# ---------------------------------------------------------------------------


def _jagged_circle_mask(*, dpi: float = 300.0, speck: bool = False) -> np.ndarray:
    """Tem tròn với biên nhiễu ±1 px từng pixel, giống mask mô hình AI.

    Mask của mô hình gần như nhị phân (đo trên ảnh nhiều tem thật: chỉ 2,06% pixel
    là trung gian) nên biên chỉ còn bậc thang pixel cộng nhiễu. Nhiễu ở đây là
    nhiễu TỪNG PIXEL có seed cố định, không phải sóng tuần hoàn — sóng tuần hoàn bị
    fitter làm mượt sẵn nên không tái tạo được lỗi người dùng gặp.
    """
    scale = dpi / 25.4
    size = round(40.0 * scale)
    center = size / 2.0
    radius = 15.0 * scale
    yy, xx = np.mgrid[0:size, 0:size]
    distance = np.hypot(xx - center, yy - center)
    generator = np.random.default_rng(20260816)
    noise = generator.uniform(-1.0, 1.0, size=(size, size))
    mask = np.where(distance <= radius + noise, 255, 0).astype(np.uint8)
    if speck:
        # "Rác nhận diện": vệt 2 px rời khỏi thân tem, dưới ngưỡng chi tiết 1 mm².
        offset = round(radius) + round(4.0 * scale)
        mask[
            round(center) - 1:round(center) + 1,
            round(center) + offset:round(center) + offset + 2,
        ] = 255
    return mask


def _contour_turn_variation(mask: np.ndarray) -> float:
    """Tổng biến thiên góc quay / 360 của biên mask. Vòng tròn mượt ≈ 1,0."""
    from skimage import measure

    contours = measure.find_contours(
        np.pad(mask.astype(np.float32), 1, mode="constant"),
        127.5,
    )
    assert contours
    points = max(contours, key=len)
    total = 0.0
    count = len(points)
    for index in range(count):
        first = points[index] - points[index - 1]
        second = points[(index + 1) % count] - points[index]
        norm_first = float(np.hypot(*first))
        norm_second = float(np.hypot(*second))
        if norm_first < 1e-9 or norm_second < 1e-9:
            continue
        cosine = float(np.clip(
            np.dot(first, second) / (norm_first * norm_second),
            -1.0,
            1.0,
        ))
        total += math.degrees(math.acos(cosine))
    return total / 360.0


def test_khu_rang_cua_alpha_lam_muot_bien_mask_ai() -> None:
    """Bộ khử răng cưa phải hạ hẳn dao động biên, không chỉ dịch vài pixel."""
    mask = _jagged_circle_mask()
    muot = sticker_engine_module._presmooth_cutline_alpha(mask, dpi_x=300.0, dpi_y=300.0)

    thang_do = _contour_turn_variation(mask)
    muot_do = _contour_turn_variation(muot)

    # Số đo trên mask AI thật của người dùng: góc gấp trung bình 15,7° → 3,7°.
    # Ngưỡng để dư biên an toàn cho khác biệt nền tảng.
    assert thang_do > 4.0
    assert muot_do < thang_do * 0.5


def test_khu_rang_cua_khong_lam_lech_silhouette_qua_mot_pixel() -> None:
    """Đây là bộ khử nhiễu dưới một pixel, không phải phép bo hình."""
    mask = _jagged_circle_mask()
    muot = sticker_engine_module._presmooth_cutline_alpha(mask, dpi_x=300.0, dpi_y=300.0)

    giao = np.count_nonzero((mask >= 128) & (muot >= 128))
    hop = np.count_nonzero((mask >= 128) | (muot >= 128))
    assert giao / max(1, hop) > 0.99


def test_khu_rang_cua_bo_luon_rac_nhan_dien_nho() -> None:
    """Vệt rác 2 px cạnh tem phải biến mất, đúng như đo trên file thật (15 → 1)."""
    thang = build_alpha_cutline_geometry(
        _jagged_circle_mask(speck=True),
        dpi=300,
        dpi_y=300,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=1.0,
    )
    muot = build_alpha_cutline_geometry(
        _jagged_circle_mask(speck=True),
        dpi=300,
        dpi_y=300,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=1.0,
        presmooth_alpha=True,
    )

    assert thang is not None and muot is not None
    assert int(thang["quality"]["dropped_component_count"]) >= 1
    assert int(muot["quality"]["dropped_component_count"]) == 0


def test_khu_rang_cua_tat_mac_dinh_de_giu_goc_that() -> None:
    """Mặc định TẮT: mask sạch có góc thật không được đi qua bộ làm mượt.

    Đo được: với fixture `notch`, Gaussian 1,2 px làm `protected_corner_count`
    rơi 11 → 0. Không bộ lọc dùng chung nào vừa giữ góc vừa khử răng cưa
    (median 3/5, morph open+close, bilateral đều đã thử), nên cổng theo nguồn biên.
    """
    tat = build_alpha_cutline_geometry(
        _sharp_mask("notch"),
        dpi=300,
        dpi_y=300,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=0,
    )
    bat = build_alpha_cutline_geometry(
        _sharp_mask("notch"),
        dpi=300,
        dpi_y=300,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=0,
        presmooth_alpha=True,
    )

    assert tat is not None and bat is not None
    assert int(tat["quality"]["protected_corner_count"]) >= 9
    assert int(bat["quality"]["protected_corner_count"]) < int(
        tat["quality"]["protected_corner_count"]
    )


@pytest.mark.parametrize(
    ("boundary_source", "mong_doi"),
    (
        ("ai", True),
        ("simple-bg", True),
        ("vector", False),
        ("existing-cut", False),
        ("alpha", False),
        (None, False),
        ("", False),
    ),
)
def test_cong_khu_rang_cua_chi_mo_cho_mask_tu_diem_anh(
    boundary_source: object,
    mong_doi: bool,
) -> None:
    assert should_presmooth_cutline_alpha(boundary_source) is mong_doi


# ---------------------------------------------------------------------------
# §CUTHOOK.1 — đo gai/móc trên quỹ đạo được vẽ ra, không chỉ tại anchor
# ---------------------------------------------------------------------------


def _hook_cubic_path() -> list[tuple[tuple[float, float], ...]]:
    """Path đóng có một cusp nằm HẲN BÊN TRONG một cubic.

    Đoạn giữa có `p1`/`p2` ngược chiều nhau nên đạo hàm theo x triệt tiêu tại
    t ≈ 0,211 trong khi đạo hàm theo y chỉ còn ~0,008: vận tốc gần như dừng rồi đảo
    hướng — đúng dạng móc mà người dùng gặp. Tiếp tuyến tại hai đầu đoạn vẫn là
    (1, 0), nên `maximum_join_angle_degrees` (chỉ đo tại anchor) không thấy gì.
    """
    return [
        ((-20.0, 0.0), (-13.0, 0.0), (-7.0, 0.0), (0.0, 0.0)),
        ((0.0, 0.0), (12.0, 0.0), (-12.0, 0.02), (0.0, 0.04)),
        ((0.0, 0.04), (7.0, 0.04), (-13.0, 0.0), (-20.0, 0.0)),
    ]


def _clean_cubic_path() -> list[tuple[tuple[float, float], ...]]:
    """Đường tròn xấp xỉ bằng bốn cubic — mốc đối chứng âm, không có cusp."""
    radius = 30.0
    handle = radius * 0.5523
    return [
        ((radius, 0.0), (radius, handle), (handle, radius), (0.0, radius)),
        ((0.0, radius), (-handle, radius), (-radius, handle), (-radius, 0.0)),
        ((-radius, 0.0), (-radius, -handle), (-handle, -radius), (0.0, -radius)),
        ((0.0, -radius), (handle, -radius), (radius, -handle), (radius, 0.0)),
    ]


def test_phep_do_quy_dao_bat_duoc_cusp_ben_trong_cubic() -> None:
    summary = sticker_engine_module._alpha_live_machine_path_summary(
        _hook_cubic_path(),
        mm_to_pts=_PT_PER_MM,
    )
    assert summary is not None

    cusp_points = summary["trajectory_cusp_points"]
    assert len(cusp_points) >= 1
    assert float(summary["maximum_trajectory_turn_degrees"]) > 120.0

    # Bằng chứng phép đo tại anchor mù: có cusp nằm HẲN trong lòng cubic, cách mọi
    # anchor một khoảng thật. Path này cũng có khớp gãy tại anchor, nên chỉ cần một
    # cusp nội bộ là đủ chứng minh vùng mà `maximum_join_angle_degrees` không phủ.
    anchors = [segment[3] for segment in _hook_cubic_path()]
    assert any(
        all(
            math.hypot(point[0] - anchor[0], point[1] - anchor[1]) > 0.5
            for anchor in anchors
        )
        for point in cusp_points
    )

    # Nêm hẹp: hai điểm cách đỉnh 0,35 mm theo cung gần như trùng nhau.
    assert float(summary["minimum_wedge_width_mm"]) < 0.30


def test_phep_do_quy_dao_khong_bao_dong_gia_tren_duong_muot() -> None:
    summary = sticker_engine_module._alpha_live_machine_path_summary(
        _clean_cubic_path(),
        mm_to_pts=_PT_PER_MM,
    )
    assert summary is not None
    assert summary["trajectory_cusp_points"] == []
    assert summary["minimum_wedge_width_mm"] is None
    assert float(summary["maximum_trajectory_turn_degrees"]) < 20.0


@pytest.mark.parametrize(
    ("quality", "expected"),
    (
        ({
            "unprotected_cusp_count": 2,
            "maximum_trajectory_turn_degrees": 73.0,
            "minimum_wedge_width_mm": 0.30,
        }, True),
        ({
            "unprotected_cusp_count": 1,
            "maximum_trajectory_turn_degrees": 91.0,
            "minimum_wedge_width_mm": 0.40,
        }, True),
        ({
            "unprotected_cusp_count": 1,
            "maximum_trajectory_turn_degrees": 55.0,
            "minimum_wedge_width_mm": 0.30,
        }, False),
    ),
)
def test_cua_nhan_dien_tu_choi_moc_nghiem_trong(
    quality: dict[str, object],
    expected: bool,
) -> None:
    """Không coi machine_safe là đủ khi cubic còn quay ngược thành móc."""
    assert sticker_engine_module._cutline_hook_is_severe(quality) is expected


def test_gom_dai_mau_lien_nhau_thanh_mot_cusp() -> None:
    """Một cái móc trải 1–3 mẫu; không gom thì đếm sai và so khớp góc chạy thừa."""
    turns = np.zeros(20, dtype=np.float64)
    turns[[4, 5, 6]] = (70.0, 175.0, 80.0)
    turns[12] = 130.0
    # Dải bắc qua chỗ nối của polyline đóng.
    turns[[19, 0]] = (90.0, 140.0)

    collapsed = sticker_engine_module._collapse_cusp_runs(
        np.flatnonzero(turns > 60.0),
        turns,
        20,
    )

    assert sorted(int(value) for value in collapsed) == [0, 5, 12]


def test_chat_luong_cuoi_phat_ra_so_do_quy_dao() -> None:
    """Bốn field mới phải có mặt trong `quality`, kể cả khi đường sạch."""
    result = build_alpha_cutline_geometry(
        _sharp_mask("star"),
        dpi=300,
        dpi_y=300,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=0,
    )

    assert result is not None
    quality = result["quality"]
    for key in (
        "trajectory_cusp_count",
        "protected_cusp_count",
        "unprotected_cusp_count",
        "maximum_trajectory_turn_degrees",
        "minimum_wedge_width_mm",
    ):
        assert key in quality
    # Đầu nhọn của hình sao LÀ cusp thật và có trên reference, nên phải được bảo vệ,
    # không được biến thành gai chưa khớp — đây là ca dễ báo động giả nhất.
    assert int(quality["unprotected_cusp_count"]) == 0


# ---------------------------------------------------------------------------
# §CUTJAG.2 — van an toàn cho mask mảnh
# ---------------------------------------------------------------------------


def test_khu_rang_cua_bo_qua_mask_mong_nhu_soi() -> None:
    """Mask hairline không được biến thành rỗng.

    Đo được trên `test/1785209372799_..._a00b34db...jpg`: nhận diện AI sinh "tem" là
    dải cao 8 px, rộng 1315 px, Alpha đỉnh 235. Gaussian làm dải đó rơi xuống 0 px và
    `prepare_alpha_cutline_geometry` trả None → preview 422.
    """
    soi = np.zeros((8, 400), dtype=np.uint8)
    soi[4, 20:380] = 235

    ket_qua = sticker_engine_module._presmooth_cutline_alpha(
        soi,
        dpi_x=300.0,
        dpi_y=300.0,
    )

    # Van an toàn phải trả nguyên mask, không phải trả một mask rỗng.
    assert np.array_equal(ket_qua, soi)
    assert int(np.count_nonzero(ket_qua >= 128)) == int(
        np.count_nonzero(soi >= 128)
    )

    prepared = sticker_engine_module.prepare_alpha_cutline_geometry(
        soi,
        dpi=300,
        dpi_y=300,
        min_detail_area_mm2=1.0,
        presmooth_alpha=True,
    )
    assert prepared is not None


def test_khu_rang_cua_van_chay_tren_mask_day_binh_thuong() -> None:
    """Đối chứng âm: van §CUTJAG.2 không được chặn oan tem thật."""
    mask = _jagged_circle_mask()
    ket_qua = sticker_engine_module._presmooth_cutline_alpha(
        mask,
        dpi_x=300.0,
        dpi_y=300.0,
    )
    assert not np.array_equal(ket_qua, mask)


# ---------------------------------------------------------------------------
# §CUTJAG.3 — thanh kéo "Khử răng cưa" của công cụ Bù xén
# ---------------------------------------------------------------------------


def test_thanh_khu_rang_cua_mac_dinh_tat_giu_nguyen_mask() -> None:
    """0 phải trả nguyên mask: mọi caller cũ không đổi kết quả một byte nào."""
    mask = _jagged_circle_mask()
    for amount in (0, 0.0, None, "khong-phai-so", float("nan")):
        assert np.array_equal(
            sticker_engine_module.denoise_cutline_mask(
                mask,
                amount=amount,
                px_per_mm=300.0 / 25.4,
            ),
            mask,
        )


def test_thanh_khu_rang_cua_keo_cao_thi_muot_hon() -> None:
    """Kéo cao phải mượt hơn kéo thấp — đơn điệu, không phải núm giả."""
    mask = _jagged_circle_mask()
    px_per_mm = 300.0 / 25.4

    do_gon = [
        _contour_turn_variation(
            sticker_engine_module.denoise_cutline_mask(
                mask,
                amount=amount,
                px_per_mm=px_per_mm,
            )
        )
        for amount in (0, 30, 60, 100)
    ]

    assert do_gon == sorted(do_gon, reverse=True)
    assert do_gon[-1] < do_gon[0] * 0.5


def test_thanh_khu_rang_cua_bi_kep_theo_mm_khi_dpi_thap() -> None:
    """Ở DPI thấp một pixel đã lớn hơn ngân sách mm nên thanh kéo phải tự tắt.

    Nếu không kẹp, kéo 100 ở 72 DPI tương đương 0,88 mm — bào mất chi tiết thật.
    """
    mask = _jagged_circle_mask()
    assert np.array_equal(
        sticker_engine_module.denoise_cutline_mask(
            mask,
            amount=100,
            px_per_mm=25.0 / 25.4,
        ),
        mask,
    )


def test_thanh_khu_rang_cua_72dpi_khong_bi_bao_hoa_tu_muc_70() -> None:
    """72 DPI vẫn đủ lưới để 70/100 khác nhau; không khóa cả hai ở 0,85 px.

    Đây là hồi quy của wrapper `tải xuống.jpg`: cap 0,30 mm nhỏ hơn một pixel
    nguồn làm slider 70, 85 và 100 sinh cùng mask, fitter phải ôm hàng trăm node.
    """
    mask = _jagged_circle_mask()
    px_per_mm = 72.0 / 25.4
    medium = sticker_engine_module.denoise_cutline_mask(
        mask,
        amount=70,
        px_per_mm=px_per_mm,
    )
    maximum = sticker_engine_module.denoise_cutline_mask(
        mask,
        amount=100,
        px_per_mm=px_per_mm,
    )

    assert not np.array_equal(medium, maximum)
    assert _contour_turn_variation(maximum) < _contour_turn_variation(medium)
    assert np.count_nonzero(maximum >= 128) >= np.count_nonzero(mask >= 128) * 0.9


def test_thanh_khu_rang_cua_dung_chung_van_mask_mong() -> None:
    """Thanh kéo cũng phải chịu van §CUTJAG.2, không được bào mask thành rỗng."""
    soi = np.zeros((8, 400), dtype=np.uint8)
    soi[4, 20:380] = 235

    ket_qua = sticker_engine_module.denoise_cutline_mask(
        soi,
        amount=100,
        px_per_mm=300.0 / 25.4,
    )

    assert np.array_equal(ket_qua, soi)


def test_thanh_khu_rang_cua_thang_cong_tu_dong() -> None:
    """`cutline_denoise` > 0 phải thắng cổng tự động theo nguồn biên."""
    mask = _jagged_circle_mask()

    def silhouette(**extra):
        prepared = sticker_engine_module.prepare_alpha_cutline_geometry(
            mask,
            dpi=300,
            dpi_y=300,
            min_detail_area_mm2=1.0,
            presmooth_alpha=True,
            **extra,
        )
        assert prepared is not None
        return prepared["base_geometry"]

    tu_dong = silhouette()
    thanh_keo = silhouette(cutline_denoise=100)
    tat_han = silhouette(cutline_denoise=0)

    # Kéo 0 nghĩa là "để cổng tự động lo", nên phải trùng nhánh tự động.
    assert abs(tat_han.area - tu_dong.area) < 1e-9
    # Kéo 100 (2,5 px) mượt hơn cổng tự động (1,2 px) → silhouette khác đo được.
    assert abs(thanh_keo.area - tu_dong.area) / tu_dong.area > 1e-4
    # Nhưng vẫn là khử nhiễu, không phải bo hình: lệch diện tích dưới 2%.
    assert abs(thanh_keo.area - tu_dong.area) / tu_dong.area < 0.02


# ---------------------------------------------------------------------------
# §CUTHYBRID.1 — chuẩn hóa cục bộ line/arc, không nuốt đoạn contour tự do
# ---------------------------------------------------------------------------


_HYBRID_DPI = 300.0
_HYBRID_PT_PER_PX = 72.0 / _HYBRID_DPI


def _hybrid_rounded_rect(
    left: float,
    top: float,
    right: float,
    bottom: float,
    radius: float,
):
    return box(
        left + radius,
        top + radius,
        right - radius,
        bottom - radius,
    ).buffer(radius, quad_segs=32)


def _hybrid_rasterize(geometry, shape: tuple[int, int]) -> np.ndarray:
    mask = np.zeros(shape, dtype=np.uint8)
    parts = [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
    for part in parts:
        cv2.fillPoly(
            mask,
            [np.rint(np.asarray(part.exterior.coords)).astype(np.int32)],
            255,
            lineType=cv2.LINE_8,
        )
        for interior in part.interiors:
            cv2.fillPoly(
                mask,
                [np.rint(np.asarray(interior.coords)).astype(np.int32)],
                0,
                lineType=cv2.LINE_8,
            )
    return cv2.GaussianBlur(mask, (0, 0), sigmaX=0.65, sigmaY=0.65)


def _hybrid_prepare(mask: np.ndarray):
    prepared = sticker_engine_module.prepare_alpha_cutline_geometry(
        mask,
        dpi=_HYBRID_DPI,
        dpi_y=_HYBRID_DPI,
        min_detail_area_mm2=0,
        fill_holes=False,
        cutline_denoise=30,
    )
    assert prepared is not None
    return prepared


def _hybrid_fit(mask: np.ndarray):
    result = build_alpha_cutline_geometry(
        mask,
        dpi=_HYBRID_DPI,
        dpi_y=_HYBRID_DPI,
        min_detail_area_mm2=0,
        fill_holes=False,
        cutline_smoothness=50,
        cutline_fidelity=95,
        curve_tension=0,
        cutline_denoise=30,
    )
    assert result is not None
    return result


def _hybrid_topology(geometry) -> tuple[int, tuple[int, ...]]:
    parts = [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
    return len(parts), tuple(sorted(len(part.interiors) for part in parts))


def _hybrid_assert_machine_safe(result) -> None:
    quality = result["quality"]
    assert quality["machine_safe"] is True
    assert int(quality["short_segment_count"]) == 0
    assert int(quality["disconnected_join_count"]) == 0
    assert int(quality["unprotected_join_count"]) == 0
    # G1 ở mối nối primitive ↔ contour tự do; dung sai 2° rộng hơn nhiễu số.
    assert float(quality["maximum_join_angle_degrees"] or 0.0) <= 2.0


def _partial_rounded_rect_with_free_protrusion() -> tuple[np.ndarray, np.ndarray]:
    """Nửa trái là chữ nhật bo; bên phải là nhánh hữu cơ phải giữ nguyên."""
    body = _hybrid_rounded_rect(130, 70, 650, 970, 72)
    arm = LineString([(620, 575), (715, 535), (790, 600)]).buffer(
        29,
        cap_style=1,
        join_style=1,
        quad_segs=24,
    )
    hand = Point(800, 610).buffer(43, quad_segs=32)
    lower_lobe = LineString([(635, 730), (700, 780)]).buffer(
        20,
        cap_style=1,
        join_style=1,
        quad_segs=20,
    )
    ideal = unary_union((body, arm, hand, lower_lobe)).buffer(0)
    clean = _hybrid_rasterize(ideal, (1050, 900))
    noisy = (clean >= 128).astype(np.uint8) * 255
    rng = np.random.default_rng(20260820)
    random_jitter = rng.choice((-1, 0, 1), size=691, p=(0.28, 0.44, 0.28))
    for offset, y in enumerate(range(175, 866)):
        xs = np.flatnonzero(noisy[y] > 0)
        assert xs.size
        old_x = int(xs[0])
        wave = 1.35 * math.sin(offset * 0.31) + 0.80 * math.sin(offset * 0.83)
        new_x = old_x + int(round(wave + random_jitter[offset]))
        if new_x > old_x:
            noisy[y, old_x:new_x] = 0
        elif new_x < old_x:
            noisy[y, new_x:old_x] = 255
    noisy = cv2.GaussianBlur(noisy, (0, 0), sigmaX=0.65, sigmaY=0.65)
    return clean, noisy


def test_hybrid_chuan_hoa_canh_thang_bo_goc_nhung_giu_mau_nho_huu_co() -> None:
    """Ca dương: lọc rung dưới pixel, không biến cả tem thành rounded-rect."""
    clean, noisy = _partial_rounded_rect_with_free_protrusion()
    expected = _hybrid_prepare(clean)["ideal_geometry"]
    source = _hybrid_prepare(noisy)["ideal_geometry"]
    result = _hybrid_fit(noisy)
    fitted = result["geometry"]

    assert _hybrid_topology(fitted) == _hybrid_topology(expected)
    assert source.hausdorff_distance(fitted) / _PT_PER_MM <= 0.35
    # Guard toan cuc rong hon primitive cục bộ: phan nhô huu co vẫn được phép
    # bám raster trong 0,30 mm; riêng cạnh thẳng bị khóa chặt ở phép đo bên dưới.
    assert expected.hausdorff_distance(fitted) / _PT_PER_MM <= 0.30

    # Vùng nhô bên phải không được classifier rounded-rect nuốt hoặc kéo thẳng.
    body_right_pts = 650.0 * _HYBRID_PT_PER_PX
    protrusion = expected.difference(box(-1e6, -1e6, body_right_pts, 1e6))
    assert fitted.intersection(protrusion).area / protrusion.area >= 0.985
    assert abs(fitted.bounds[2] - expected.bounds[2]) / _PT_PER_MM <= 0.15

    # Đo đúng phần cạnh thẳng người dùng nhìn thấy, tránh hai cung bo ở đầu.
    points = np.asarray(fitted.exterior.coords[:-1], dtype=np.float64)
    y0, y1 = 190.0 * _HYBRID_PT_PER_PX, 850.0 * _HYBRID_PT_PER_PX
    expected_x = 130.0 * _HYBRID_PT_PER_PX
    side = points[
        (points[:, 1] >= y0)
        & (points[:, 1] <= y1)
        & (points[:, 0] <= expected_x + 2.0 * _PT_PER_MM)
    ]
    assert len(side) >= 4
    residual_mm = np.abs(side[:, 0] - expected_x) / _PT_PER_MM
    # Baseline 2026-08-20: p95=0,2045 mm, peak=0,2506 mm — test phải đỏ
    # cho tới khi có primitive line cục bộ thay vì spline bám mọi răng pixel.
    assert float(np.quantile(residual_mm, 0.95)) <= 0.06
    assert float(np.max(residual_mm)) <= 0.12

    # Không chỉ nhìn thẳng bằng raster: rail dài phải thật sự được rút gọn còn
    # một cubic chính và tối đa hai đoạn chuyển tiếp ở hai cung bo. Điều này
    # khóa hồi quy "thẳng bằng mắt nhưng đầy node rác" khi mở trong Illustrator.
    side_segments = []
    for segment in result["paths"][0]:
        start = np.asarray(segment[0], dtype=np.float64)
        end = np.asarray(segment[3], dtype=np.float64)
        delta = np.abs(end - start)
        if (
            max(float(start[0]), float(end[0]))
            <= expected_x + 2.0 * _PT_PER_MM
            and float(delta[1]) > float(delta[0]) * 4.0
        ):
            side_segments.append(segment)
    chord_lengths_mm = [
        float(
            np.linalg.norm(
                np.asarray(segment[3], dtype=np.float64)
                - np.asarray(segment[0], dtype=np.float64)
            )
            / _PT_PER_MM
        )
        for segment in side_segments
    ]
    assert len(side_segments) <= 3
    assert max(chord_lengths_mm, default=0.0) >= 50.0
    _hybrid_assert_machine_safe(result)


def test_hybrid_khong_nhan_dien_lai_quy_dao_khi_keo_thanh_preview(
    monkeypatch,
) -> None:
    """Tuning đổi liên tục phải tái fit, nhưng không phân tích lại cùng contour."""
    _clean, noisy = _partial_rounded_rect_with_free_protrusion()
    prepared = _hybrid_prepare(noisy)
    original = sticker_engine_module._regularize_partial_straight_reference
    call_count = 0

    def counting_regularizer(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(
        sticker_engine_module,
        "_regularize_partial_straight_reference",
        counting_regularizer,
    )
    first = sticker_engine_module.fit_prepared_alpha_cutline_geometry(
        prepared,
        cutline_smoothness=45,
        cutline_fidelity=90,
        curve_tension=0,
    )
    second = sticker_engine_module.fit_prepared_alpha_cutline_geometry(
        prepared,
        cutline_smoothness=55,
        cutline_fidelity=95,
        curve_tension=0,
    )

    assert first is not None
    assert second is not None
    assert first["paths"] != second["paths"]
    assert call_count == 1
    assert "_hybrid_reference_cache" in prepared


def _hybrid_negative_cases():
    angles = np.linspace(0.0, 2.0 * math.pi, 540, endpoint=False)
    radius = 285.0 + 44.0 * np.cos(3 * angles + 0.35) + 21.0 * np.sin(7 * angles)
    organic = Polygon(np.column_stack((
        450.0 + radius * np.cos(angles),
        500.0 + radius * np.sin(angles),
    ))).buffer(0)

    gear_points = []
    for index in range(18 * 4):
        angle = index * 2.0 * math.pi / (18 * 4)
        tooth_radius = 305.0 if index % 4 in (1, 2) else 255.0
        gear_points.append((
            440.0 + tooth_radius * math.cos(angle),
            440.0 + tooth_radius * math.sin(angle),
        ))
    gear = Polygon(gear_points).buffer(0)

    notched = _hybrid_rounded_rect(100, 100, 780, 750, 65)
    for y in (260, 440, 620):
        notched = notched.difference(Point(100, y).buffer(34, quad_segs=20))
    notched = notched.union(Point(780, 360).buffer(52, quad_segs=24)).buffer(0)

    text_mask = np.zeros((900, 900), dtype=np.uint8)
    cv2.putText(
        text_mask,
        "A",
        (105, 760),
        cv2.FONT_HERSHEY_SIMPLEX,
        8.5,
        255,
        thickness=74,
        lineType=cv2.LINE_AA,
    )

    first = _hybrid_rounded_rect(70, 120, 420, 760, 55)
    second = _hybrid_rounded_rect(438, 110, 810, 770, 62)
    close_mask = _hybrid_rasterize(first.union(second), (880, 880))

    y_values = np.linspace(160.0, 880.0, 180)
    left = 135.0 + 15.0 * np.sin((y_values - 80.0) * 2.0 * math.pi / 108.0)
    wavy = Polygon([
        (215, 80), (625, 80), (700, 155), (700, 885), (625, 960), (215, 960),
        *reversed(list(zip(left, y_values))),
    ]).buffer(18, join_style=1, quad_segs=20).buffer(
        -18,
        join_style=1,
        quad_segs=20,
    )
    return (
        ("organic", _hybrid_rasterize(organic, (1000, 900)), 0.18),
        ("gear", _hybrid_rasterize(gear, (880, 880)), 0.20),
        ("notches", _hybrid_rasterize(notched, (850, 900)), 0.20),
        ("text", text_mask, 0.28),
        ("multiple_close", close_mask, 0.16),
        ("genuine_wavy", _hybrid_rasterize(wavy, (1050, 850)), 0.35),
    )


@pytest.mark.parametrize(
    ("case_name", "mask", "hausdorff_limit_mm"),
    _hybrid_negative_cases(),
    ids=("organic", "gear", "notches", "text", "multiple_close", "genuine_wavy"),
)
def test_hybrid_khong_bao_mat_chi_tiet_that(
    case_name: str,
    mask: np.ndarray,
    hausdorff_limit_mm: float,
) -> None:
    """Ca âm: blob/răng/khấc/chữ/nhiều tem/sóng thật không được sửa thành rác."""
    reference = _hybrid_prepare(mask)["ideal_geometry"]
    result = _hybrid_fit(mask)
    fitted = result["geometry"]

    assert _hybrid_topology(fitted) == _hybrid_topology(reference)
    assert reference.hausdorff_distance(fitted) / _PT_PER_MM <= hausdorff_limit_mm
    if case_name == "multiple_close":
        parts = list(fitted.geoms)
        assert len(parts) == 2
        assert parts[0].distance(parts[1]) / _PT_PER_MM >= 1.30
    elif case_name == "genuine_wavy":
        points = np.asarray(fitted.exterior.coords[:-1], dtype=np.float64)
        y0, y1 = 230.0 * _HYBRID_PT_PER_PX, 810.0 * _HYBRID_PT_PER_PX
        side = points[
            (points[:, 1] >= y0)
            & (points[:, 1] <= y1)
            & (points[:, 0] <= np.quantile(points[:, 0], 0.35))
        ]
        # Biên lượn thật có biên độ ~2,5 mm đỉnh-đỉnh, không được ép thành line.
        assert float(np.ptp(side[:, 0]) / _PT_PER_MM) >= 1.80
    _hybrid_assert_machine_safe(result)
