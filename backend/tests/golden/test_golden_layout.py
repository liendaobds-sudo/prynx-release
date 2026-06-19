"""
Golden tests — khóa hành vi layout-math HIỆN TẠI trước khi tái cấu trúc.

Mục tiêu (Task 1 / Requirements 8.1, 8.2):
  - Chạy các solver layout công khai với bộ input cố định.
  - So output (số ô + toạ độ từng ô) với baseline đã lưu.
  - Nếu baseline chưa tồn tại → tự sinh và đánh dấu xfail (lần đầu thiết lập mốc).

Phạm vi: lớp layout-math thuần (không cần PDF / multiprocessing), đúng phần
mà việc gộp engine (imposition_core) sẽ đụng tới. Bao gồm:
  - Cắt xén (guillotine/N-up): nup_layout_solver.solve_optimal_layout / solve_grid
  - Bế tem (die-cut): sticker_imposer.solve_* (grid, hex, cluster, l-shape, optimal_auto)

Ngưỡng: toạ độ làm tròn 2 chữ số (≈0.01pt, chặt hơn yêu cầu ≤0.5pt) để mốc ổn định.
"""
import json
import os
import sys

import pytest

# Add backend to path (theo quy ước các test khác trong thư mục này)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from app.workers.nup_layout_solver import solve_optimal_layout, solve_grid, get_src_page_idx
from app.workers import sticker_imposer as sk

BASELINE_PATH = os.path.join(os.path.dirname(__file__), "golden_baseline.json")
ROUND = 2  # số chữ số làm tròn toạ độ


# ─────────────────────────────────────────────────────────────────────────────
#  Canonicalization — biến output solver thành dạng so sánh ổn định
# ─────────────────────────────────────────────────────────────────────────────

def _canon_cells(cells, key_w="width", key_h="height"):
    """Chuẩn hóa danh sách ô thành list tuple đã làm tròn + sắp xếp ổn định."""
    out = []
    for c in cells or []:
        out.append([
            round(float(c.get("x", 0.0)), ROUND),
            round(float(c.get("y", 0.0)), ROUND),
            round(float(c.get(key_w, 0.0)), ROUND),
            round(float(c.get(key_h, 0.0)), ROUND),
            bool(c.get("isRotated", False)),
            bool(c.get("isRotated180", False)),
        ])
    out.sort()
    return out


def _canon_nup(res):
    return {
        "totalItems": int(res.get("totalItems", len(res.get("cells", [])))),
        "overallWidth": round(float(res.get("overallWidth", 0.0)), ROUND),
        "overallHeight": round(float(res.get("overallHeight", 0.0)), ROUND),
        "cells": _canon_cells(res.get("cells", [])),
    }


def _canon_sticker(res):
    return {
        "totalItems": int(res.get("totalItems", len(res.get("items", [])))),
        "widthUsed": round(float(res.get("widthUsed", 0.0)), ROUND),
        "heightUsed": round(float(res.get("heightUsed", 0.0)), ROUND),
        "items": _canon_cells(res.get("items", [])),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Scenarios — bộ input cố định
# ─────────────────────────────────────────────────────────────────────────────

def _build_actual():
    """Tính toàn bộ scenario qua engine hiện tại → dict {name: canonical}."""
    actual = {}

    # ── Cắt xén (N-up / guillotine) ──
    nup_scenarios = [
        ("nup_lshape_card16", dict(usable_w=779.52875, usable_h=1128.190699,
                                   orig_w=260.7919, orig_h=158.7417,
                                   gap_x=5.6693, gap_y=5.6693,
                                   strategy="optimal_auto", secondary_gap=34.0158)),
        ("nup_grid_no_secondary", dict(usable_w=1000.0, usable_h=1000.0,
                                       orig_w=200.0, orig_h=300.0,
                                       gap_x=10.0, gap_y=10.0,
                                       strategy="optimal_auto", secondary_gap=None)),
        ("nup_lshape_extreme_gap", dict(usable_w=800.0, usable_h=800.0,
                                        orig_w=250.0, orig_h=100.0,
                                        gap_x=5.0, gap_y=5.0,
                                        strategy="optimal_auto", secondary_gap=150.0)),
        ("nup_simple_auto", dict(usable_w=800.0, usable_h=800.0,
                                 orig_w=250.0, orig_h=100.0,
                                 gap_x=5.0, gap_y=5.0,
                                 strategy="simple_auto", secondary_gap=10.0)),
        ("nup_sra3_business_card", dict(usable_w=907.09, usable_h=1275.59,
                                        orig_w=255.12, orig_h=153.07,
                                        gap_x=0.0, gap_y=0.0,
                                        strategy="optimal_auto", secondary_gap=None)),
    ]
    for name, p in nup_scenarios:
        res = solve_optimal_layout(p["usable_w"], p["usable_h"], p["orig_w"], p["orig_h"],
                                   p["gap_x"], p["gap_y"], p["strategy"], p["secondary_gap"])
        actual[name] = _canon_nup(res)

    # solve_grid trực tiếp (lưới đơn)
    grid = solve_grid(320.0, 450.0, 50.0, 50.0, 2.0, 2.0, False)
    actual["nup_solve_grid_basic"] = _canon_nup({
        "totalItems": len(grid.get("cells", [])),
        "overallWidth": grid.get("width", 0.0),
        "overallHeight": grid.get("height", 0.0),
        "cells": grid.get("cells", []),
    })

    # get_src_page_idx — khóa logic ánh xạ trang
    actual["nup_src_page_idx"] = {
        "sequential": [get_src_page_idx(s, c, "sequential", 6, 20) for s in range(3) for c in range(6)],
        "repeat": [get_src_page_idx(s, c, "repeat", 6, 20) for s in range(3) for c in range(6)],
        "cut_stacks": [get_src_page_idx(s, c, "cut_stacks", 6, 20) for s in range(3) for c in range(6)],
    }

    # ── Bế tem (die-cut) ──
    sticker_scenarios = [
        ("stk_grid_50", dict(fn="grid", w=320, h=450, iw=50, ih=50, gx=2, gy=2)),
        ("stk_hex_40", dict(fn="hex", w=320, h=450, iw=40, ih=40, gx=2, gy=2)),
        ("stk_lshape_80x50", dict(fn="lshape", w=320, h=450, iw=80, ih=50, gx=2, gy=2)),
        ("stk_cluster_80x50", dict(fn="cluster", w=320, h=450, iw=80, ih=50, gx=2, gy=2)),
        ("stk_optimal_70x40", dict(fn="optimal", w=320, h=450, iw=70, ih=40, gx=2, gy=2)),
        ("stk_optimal_25x40", dict(fn="optimal", w=350, h=500, iw=25, ih=40, gx=1, gy=1)),
    ]
    for name, p in sticker_scenarios:
        fn = p["fn"]
        if fn == "grid":
            res = sk.solve_grid_layout(p["w"], p["h"], p["iw"], p["ih"], p["gx"], p["gy"])
        elif fn == "hex":
            res = sk.calculate_staggered_hex_layout(p["w"], p["h"], p["iw"], p["ih"], p["gx"], p["gy"])
        elif fn == "lshape":
            res = sk.solve_l_shape_layout(p["w"], p["h"], p["iw"], p["ih"], p["gx"], p["gy"])
        elif fn == "cluster":
            res = sk.solve_cluster_grid_layout(p["w"], p["h"], p["iw"], p["ih"], p["gx"], p["gy"])
        else:  # optimal
            res = sk.solve_optimal_sticker_layout(p["w"], p["h"], p["iw"], p["ih"], p["gx"], p["gy"], "optimal_auto")
        actual[name] = _canon_sticker(res)

    return actual


# ─────────────────────────────────────────────────────────────────────────────
#  Baseline I/O
# ─────────────────────────────────────────────────────────────────────────────

def _load_baseline():
    if not os.path.exists(BASELINE_PATH):
        return None
    with open(BASELINE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_baseline(data):
    with open(BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_golden_baseline_exists_or_create():
    """Tạo baseline nếu chưa có (lần đầu). Khi đã có thì test này luôn pass."""
    actual = _build_actual()
    baseline = _load_baseline()
    if baseline is None:
        _save_baseline(actual)
        pytest.xfail("Baseline chưa tồn tại — đã sinh golden_baseline.json. Chạy lại để khóa.")
    # baseline đã có → không làm gì ở đây (các test dưới so từng scenario)


def test_golden_scenarios_match():
    """So toàn bộ scenario với baseline đã lưu."""
    baseline = _load_baseline()
    if baseline is None:
        pytest.skip("Chưa có baseline — chạy test_golden_baseline_exists_or_create trước.")

    actual = _build_actual()

    # Phát hiện scenario mới chưa có trong baseline
    new_keys = set(actual) - set(baseline)
    assert not new_keys, (
        f"Scenario mới chưa có baseline: {sorted(new_keys)}. "
        f"Xóa golden_baseline.json để sinh lại nếu đây là chủ đích."
    )

    mismatches = []
    for name, exp in baseline.items():
        got = actual.get(name)
        if got is None:
            mismatches.append(f"  - {name}: THIẾU trong output hiện tại")
        elif got != exp:
            exp_n = exp.get("totalItems") if isinstance(exp, dict) else "?"
            got_n = got.get("totalItems") if isinstance(got, dict) else "?"
            mismatches.append(f"  - {name}: khác baseline (totalItems baseline={exp_n}, hiện tại={got_n})")

    assert not mismatches, "Golden mismatch:\n" + "\n".join(mismatches)
