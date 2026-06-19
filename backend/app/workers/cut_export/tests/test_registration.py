"""Test registration affine (task 8.3). Requirements: 4.8, 4.9."""

import math

import pytest

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.registration import (
    solve_affine,
    apply_affine,
    register,
    Affine2x3,
)


def _apply_known(M, pts):
    return [(M.a * x + M.b * y + M.tx, M.c * x + M.d * y + M.ty) for (x, y) in pts]


def test_solve_affine_recovers_known_transform():
    # Phép biến đổi đã biết: xoay 10°, tỉ lệ 1.02, tịnh tiến (3, -2).
    ang = math.radians(10)
    s = 1.02
    M_known = Affine2x3(
        a=s * math.cos(ang), b=-s * math.sin(ang), tx=3.0,
        c=s * math.sin(ang), d=s * math.cos(ang), ty=-2.0,
    )
    design = [(0, 0), (100, 0), (100, 200), (0, 200)]
    measured = _apply_known(M_known, design)

    M = solve_affine(design, measured)
    for k in ("a", "b", "c", "d", "tx", "ty"):
        assert math.isclose(getattr(M, k), getattr(M_known, k), abs_tol=1e-6)


def test_affine_residual_zero_at_marks():
    ang = math.radians(5)
    M_known = Affine2x3(math.cos(ang), -math.sin(ang), 1.0,
                        math.sin(ang), math.cos(ang), 2.0)
    design = [(0, 0), (50, 0), (50, 80)]
    measured = _apply_known(M_known, design)
    M = solve_affine(design, measured)
    for (dx, dy), (mx, my) in zip(design, measured):
        rx, ry = M.apply(dx, dy)
        assert math.isclose(rx, mx, abs_tol=1e-6)
        assert math.isclose(ry, my, abs_tol=1e-6)


def test_solve_affine_needs_three_points():
    with pytest.raises(ValueError):
        solve_affine([(0, 0), (1, 1)], [(0, 0), (1, 1)])


def test_solve_affine_rejects_collinear():
    with pytest.raises(ValueError):
        solve_affine([(0, 0), (1, 1), (2, 2)], [(0, 0), (1, 1), (2, 2)])


def test_apply_affine_warps_paths_and_marks():
    M = Affine2x3(1, 0, 10, 0, 1, 20)  # tịnh tiến (10, 20)
    cm = CutModel(
        paths=[CutPath(points=[(0, 0), (5, 0)])],
        marks=[RegMark(0, 0)],
        sheet_w_mm=100, sheet_h_mm=100,
    )
    out = apply_affine(cm, M)
    assert out.paths[0].points[0] == (10.0, 20.0)
    assert (out.marks[0].x, out.marks[0].y) == (10.0, 20.0)
    # Không sửa model gốc.
    assert cm.paths[0].points[0] == (0.0, 0.0)


def test_register_onboard_frame_sets_frame_no_warp():
    cm = CutModel(
        paths=[CutPath(points=[(10, 10), (20, 20)])],
        marks=[RegMark(0, 0), RegMark(100, 0), RegMark(0, 200)],
        sheet_w_mm=100, sheet_h_mm=200,
    )
    out = register(cm, "onboard_frame")
    assert out.frame == (0.0, 0.0, 100.0, 200.0)
    assert out.paths[0].points[0] == (10.0, 10.0)  # không warp


def test_register_manual_affine_requires_points():
    cm = CutModel(paths=[CutPath(points=[(0, 0), (1, 1)])])
    with pytest.raises(ValueError):
        register(cm, "manual_affine")
