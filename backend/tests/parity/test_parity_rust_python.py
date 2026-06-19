"""
Parity tests — Rust (pdfcompare_native) vs Python fallback (_py_*).

Mục tiêu (Task 2 / Requirements 8.3, 8.4):
  - Hợp nhất các script parity rời rạc (test_verify_rust_parity.py, test_hex.py,
    test_layout.py) thành một suite pytest chạy được trong CI.
  - So trực tiếp hai bản triển khai cùng một phép toán: Rust vs Python.

Nếu module Rust `pdfcompare_native` chưa cài → toàn bộ suite được SKIP (không fail),
vì khi đó hệ thống chạy thuần Python và không có gì để đối chiếu.

Lưu ý: chế độ "ép Python qua API công khai" (cờ IMPOSITION_ALLOW_PY_FALLBACK) sẽ
được nối ở Task 14; ở đây ta đối chiếu trực tiếp hai implementation nên không cần cờ.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# Skip toàn bộ module nếu không có Rust
pdfcompare_native = pytest.importorskip(
    "pdfcompare_native",
    reason="pdfcompare_native (Rust) chưa cài — bỏ qua parity, hệ thống chạy thuần Python.",
)

from app.workers.nup_layout_solver import _py_solve_optimal_layout, _py_solve_grid

ABS_TOL = 0.1  # pt


def _yield_of(res):
    return res.get("totalItems", len(res.get("cells", res.get("items", []))))


def _dims_of(res):
    w = res.get("overallWidth", res.get("widthUsed", 0.0))
    h = res.get("overallHeight", res.get("heightUsed", 0.0))
    return float(w), float(h)


# ─────────────────────────────────────────────────────────────────────────────
#  N-Up grid solver: Rust solve_optimal_layout vs Python _py_solve_optimal_layout
# ─────────────────────────────────────────────────────────────────────────────

NUP_SCENARIOS = [
    ("lshape_card16", 779.52875, 1128.190699, 260.7919, 158.7417, 5.6693, 5.6693, "optimal_auto", 34.0158),
    ("grid_no_secondary", 1000.0, 1000.0, 200.0, 300.0, 10.0, 10.0, "optimal_auto", None),
    ("lshape_extreme_gap", 800.0, 800.0, 250.0, 100.0, 5.0, 5.0, "optimal_auto", 150.0),
    ("simple_auto", 800.0, 800.0, 250.0, 100.0, 5.0, 5.0, "simple_auto", 10.0),
    ("sra3_business_card", 907.09, 1275.59, 255.12, 153.07, 0.0, 0.0, "optimal_auto", None),
]


@pytest.mark.parametrize("name,uw,uh,ow,oh,gx,gy,strat,sg", NUP_SCENARIOS)
def test_nup_optimal_parity(name, uw, uh, ow, oh, gx, gy, strat, sg):
    py = _py_solve_optimal_layout(uw, uh, ow, oh, gx, gy, strat, sg)
    rs = pdfcompare_native.solve_optimal_layout(uw, uh, ow, oh, gx, gy, strat, sg)

    assert _yield_of(py) == _yield_of(rs), (
        f"[{name}] Yield lệch: Py={_yield_of(py)} vs Rust={_yield_of(rs)}"
    )
    pw, ph = _dims_of(py)
    rw, rh = _dims_of(rs)
    assert math.isclose(pw, rw, abs_tol=ABS_TOL) and math.isclose(ph, rh, abs_tol=ABS_TOL), (
        f"[{name}] Kích thước lệch: Py=({pw:.3f},{ph:.3f}) vs Rust=({rw:.3f},{rh:.3f})"
    )


def test_nup_solve_grid_parity():
    py = _py_solve_grid(320.0, 450.0, 50.0, 50.0, 2.0, 2.0, False)
    rs = pdfcompare_native.solve_grid(320.0, 450.0, 50.0, 50.0, 2.0, 2.0, False)
    assert len(py.get("cells", [])) == len(rs.get("cells", []))
    assert py.get("cols") == rs.get("cols")
    assert py.get("rows") == rs.get("rows")


def test_nup_solve_manual_parity():
    from app.workers.nup_layout_solver import _py_solve_manual
    if not hasattr(pdfcompare_native, "solve_manual"):
        pytest.skip("Rust chưa có solve_manual (rebuild wheel)")
    for cols, rows in [(4, 5), (1, 1), (7, 3), (0, 5)]:
        py = _py_solve_manual(50.0, 60.0, 2.0, 3.0, cols, rows)
        rs = pdfcompare_native.solve_manual(50.0, 60.0, 2.0, 3.0, cols, rows)
        assert py["totalItems"] == rs["totalItems"], f"manual {cols}x{rows}"
        assert math.isclose(py["overallWidth"], rs["overallWidth"], abs_tol=ABS_TOL)
        assert math.isclose(py["overallHeight"], rs["overallHeight"], abs_tol=ABS_TOL)


# ─────────────────────────────────────────────────────────────────────────────
#  Sticker hex: Rust sticker_staggered_hex vs Python _py
# ─────────────────────────────────────────────────────────────────────────────

HEX_SCENARIOS = [
    (1000, 1000, 100, 100, 5, 5),
    (320, 450, 50, 50, 2, 2),
    (500, 700, 40, 60, 3, 3),
    (700, 500, 60, 40, 3, 3),
]


@pytest.mark.parametrize("uw,uh,iw,ih,gx,gy", HEX_SCENARIOS)
def test_sticker_hex_parity(uw, uh, iw, ih, gx, gy):
    try:
        from app.workers.sticker_imposer_pkg.grid_layouts import _py_calculate_staggered_hex_layout
    except ImportError:
        pytest.skip("Không import được _py_calculate_staggered_hex_layout")

    py = _py_calculate_staggered_hex_layout(uw, uh, iw, ih, gx, gy)
    rs = pdfcompare_native.sticker_staggered_hex(uw, uh, iw, ih, gx, gy)
    assert _yield_of(py) == _yield_of(rs), (
        f"Hex yield lệch ({uw}x{uh}, item {iw}x{ih}): Py={_yield_of(py)} vs Rust={_yield_of(rs)}"
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Sticker trapezoid shape solver: Rust shape_trapezoid vs Python _py
# ─────────────────────────────────────────────────────────────────────────────

def test_sticker_trapezoid_parity():
    try:
        from app.workers.sticker_imposer_pkg.shape_layouts import _py_solve_advanced_trapezoid_layout
    except ImportError:
        pytest.skip("Không import được _py_solve_advanced_trapezoid_layout")

    uw, uh, iw, ih, gx, gy = 847.56, 1145.20, 145.39, 305.88, 5.67, 5.67
    shape_props = {"leftOH": 9.35, "rightOH": 9.35, "isHorizontal": True, "bbW": 145.19, "bbH": 305.88}

    for rot in (False, True):
        py = _py_solve_advanced_trapezoid_layout(uw, uh, iw, ih, gx, gy, shape_props, rot)
        rs = pdfcompare_native.shape_trapezoid(uw, uh, iw, ih, gx, gy, shape_props, rot)
        assert _yield_of(py) == _yield_of(rs), (
            f"Trapezoid yield lệch (rot={rot}): Py={_yield_of(py)} vs Rust={_yield_of(rs)}"
        )
