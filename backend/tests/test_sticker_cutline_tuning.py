"""Hợp đồng geometry dùng chung giữa live preview và CutContour xuất file."""

from __future__ import annotations

import cv2
import json
import math
import numpy as np
from PIL import Image
import pikepdf
import pytest
from shapely.geometry import Polygon

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
    assert _cutline_round_radius_mm(50, 25.4 / 72.0) == pytest.approx(0.35)
    assert _cutline_round_radius_mm(100, 25.4 / 300.0) == pytest.approx(0.25)

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
