"""Test TSP toolpath optimization, inside-out hole cutting, and overcut (audit 2026-09-30 §CNC.TSP)."""

import math
from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.geometry import optimize_cut_paths_tsp
from app.workers.cut_export.cut_model_builder import build_cut_model
from app.workers.cut_export.profile import load_builtin_profiles
from app.workers.cut_export.emitters.command_stream import CommandStreamEmitter


def _calculate_travel_distance(paths, start_pos=(0.0, 0.0)) -> float:
    """Tính tổng quãng đường chạy dao không tải (pen-up / rapid move)."""
    curr = start_pos
    total_travel = 0.0
    for p in paths:
        if not p.points:
            continue
        p0 = p.points[0]
        total_travel += math.hypot(p0[0] - curr[0], p0[1] - curr[1])
        curr = p.points[-1]
    return total_travel


def test_tsp_travel_distance_reduction_over_70_percent():
    """Xác nhận TSP giảm hơn 70% quãng đường chạy không tải so với sắp xếp centroid ngây thơ."""
    # Tạo 100 con tem trên lưới 10x10
    raw_paths = []
    for r in range(10):
        for c in range(10):
            x = 20.0 + c * 28.0 + (5.0 if r % 2 == 1 else 0.0)
            y = 20.0 + r * 40.0
            raw_paths.append(CutPath(
                points=[(x, y), (x + 20, y), (x + 20, y + 30), (x, y + 30), (x, y)],
                closed=True,
                block_id=0,
            ))

    # Thứ tự cũ: sort theo centroid
    naive_order = sorted(raw_paths, key=lambda p: (round(sum(x for x, _ in p.points) / len(p.points), 2),
                                                  round(sum(y for _, y in p.points) / len(p.points), 2)))
    naive_travel = _calculate_travel_distance(naive_order)

    # Thứ tự mới: TSP
    tsp_order = optimize_cut_paths_tsp(raw_paths, start_pos=(0.0, 0.0))
    tsp_travel = _calculate_travel_distance(tsp_order)

    reduction = (1.0 - tsp_travel / naive_travel) * 100.0
    print(f"\nNaive Travel: {naive_travel:.1f}mm, TSP Travel: {tsp_travel:.1f}mm, Reduction: {reduction:.1f}%")
    assert reduction >= 70.0, f"Kỳ vọng giảm ít nhất 70% quãng đường chạy không tải, thực tế: {reduction:.1f}%"


def test_inside_out_hole_cutting_precedence():
    """Xác nhận toàn bộ lỗ khoét bên trong (is_hole=True) luôn được cắt trước viền ngoài."""
    p_ext1 = CutPath(points=[(10, 10), (50, 10), (50, 50), (10, 50), (10, 10)], is_hole=False)
    p_hole1 = CutPath(points=[(20, 20), (30, 20), (30, 30), (20, 30), (20, 20)], is_hole=True)
    p_ext2 = CutPath(points=[(100, 10), (150, 10), (150, 50), (100, 50), (100, 10)], is_hole=False)
    p_hole2 = CutPath(points=[(110, 20), (120, 20), (120, 30), (110, 30), (110, 20)], is_hole=True)

    ordered = optimize_cut_paths_tsp([p_ext1, p_ext2, p_hole1, p_hole2])
    holes_flags = [p.is_hole for p in ordered]

    # 2 lỗ đầu tiên phải là True, 2 viền sau phải là False
    assert holes_flags == [True, True, False, False], f"Lỗ trong phải cắt trước viền ngoài, nhận được: {holes_flags}"


def test_shapely_polygon_with_interiors_marks_is_hole():
    """Xác nhận build_cut_model nhận diện interior ring và gán is_hole=True."""
    from shapely.geometry import Polygon

    # Tạo polygon có 1 lỗ thủng bên trong (hình vành khăn / tag khoét lỗ)
    exterior = [(0, 0), (100, 0), (100, 100), (0, 100), (0, 0)]
    hole = [(40, 40), (60, 40), (60, 60), (40, 60), (40, 40)]
    poly = Polygon(exterior, [hole])

    model = build_cut_model([poly], sheet_w_mm=200, sheet_h_mm=200)
    assert len(model.paths) == 2

    # Lỗ trong phải có is_hole=True, viền ngoài có is_hole=False
    hole_paths = [p for p in model.paths if p.is_hole]
    ext_paths = [p for p in model.paths if not p.is_hole]
    assert len(hole_paths) == 1
    assert len(ext_paths) == 1

    # Khi emit qua CommandStreamEmitter, lỗ trong được cắt trước
    profile = load_builtin_profiles()["yuty_a3_max"]
    emitter = CommandStreamEmitter(profile)
    ordered = emitter._ordered_paths(model)
    assert ordered[0].is_hole is True
    assert ordered[1].is_hole is False


def test_overcut_applies_when_configured():
    """Xác nhận overcut_mm kéo dài đường cắt quá điểm khép vòng."""
    profile = load_builtin_profiles()["yuty_a3_max"]
    model = CutModel(
        paths=[CutPath(points=[(10, 10), (50, 10), (50, 50), (10, 50), (10, 10)], closed=True)],
        sheet_w_mm=100, sheet_h_mm=100,
    )
    emitter_normal = CommandStreamEmitter(profile)
    out_normal = emitter_normal.emit(model).decode("ascii")

    # Bật overcut 1mm trong profile copy
    profile_overcut = load_builtin_profiles()["yuty_a3_max"]
    profile_overcut.blade["overcut_mm"] = 1.0
    emitter_overcut = CommandStreamEmitter(profile_overcut)
    out_overcut = emitter_overcut.emit(model).decode("ascii")

    # Bản overcut phải có thêm lệnh cắt quá mép
    assert len(out_overcut) > len(out_normal)
