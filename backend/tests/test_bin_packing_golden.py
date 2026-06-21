"""Golden / parity tests for MaxRects bin-packing (đường đi NHIỀU LOẠI TEM).

Khóa output của solve_auto_fill_mixed / solve_offset_mixed / solve_mixed_bin_pack
TRƯỚC khi tối ưu (F1 prune, F2 siết cận binary search) để bảo đảm các thay đổi
"thay động cơ, giữ nguyên kết quả": placements phải TRÙNG KHÍT từng số.

Snapshot lưu ở tests/data/bin_packing_golden.json (sinh bằng chính SCENARIOS này
trên code gốc). Nếu cố ý đổi thuật toán theo hướng khác kết quả → regenerate có chủ đích.
"""
import json
import os

import pytest

from app.workers.sticker_imposer_pkg.bin_packing import (
    solve_auto_fill_mixed,
    solve_offset_mixed,
    solve_mixed_bin_pack,
)

_GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "data", "bin_packing_golden.json")


# ── Kịch bản: cố tình đa dạng để phủ các nhánh bị sửa ──────────────────────
#  - kích thước chênh lệch lớn (tem nhỏ + tem to) → ép nhánh cận min/max_per_type
#  - có/không gap, có/không rotation
#  - exclude_zones (pont/ốc)
#  - offset theo tỉ lệ + fill_remainder
def _scenarios():
    return {
        # auto_fill: 3 loại kích thước khác nhau
        "auto_3types": lambda: solve_auto_fill_mixed(
            sheet_w=1000.0, sheet_h=700.0,
            page_dims=[(0, 120.0, 80.0), (1, 60.0, 90.0), (2, 200.0, 50.0)],
            gap=8.0, allow_rotation=True,
        ),
        # auto_fill: 1 tem TO + 1 tem TÍ HON → min(max_per_type) << max(max_per_type)
        "auto_big_plus_tiny": lambda: solve_auto_fill_mixed(
            sheet_w=900.0, sheet_h=900.0,
            page_dims=[(0, 400.0, 380.0), (1, 30.0, 28.0)],
            gap=5.0, allow_rotation=True,
        ),
        # auto_fill: không gap, không rotation
        "auto_nogap_norot": lambda: solve_auto_fill_mixed(
            sheet_w=600.0, sheet_h=400.0,
            page_dims=[(0, 100.0, 100.0), (1, 70.0, 130.0)],
            gap=0.0, allow_rotation=False,
        ),
        # auto_fill: có exclude_zones (vùng cấm pont/ốc)
        "auto_with_exclude": lambda: solve_auto_fill_mixed(
            sheet_w=800.0, sheet_h=600.0,
            page_dims=[(0, 90.0, 90.0), (1, 140.0, 60.0)],
            gap=6.0, allow_rotation=True,
            exclude_zones=[(380.0, 280.0, 40.0, 40.0), (0.0, 0.0, 50.0, 600.0)],
        ),
        # offset: 2 loại theo tỉ lệ số lượng
        "offset_ratio_2types": lambda: solve_offset_mixed(
            sheet_w=1000.0, sheet_h=700.0,
            page_dims_qty=[(0, 120.0, 80.0, 300), (1, 90.0, 110.0, 200)],
            gap=7.0, allow_rotation=True,
        ),
        # offset: 3 loại + fill_remainder
        "offset_fill_remainder": lambda: solve_offset_mixed(
            sheet_w=900.0, sheet_h=900.0,
            page_dims_qty=[(0, 150.0, 120.0, 50), (1, 80.0, 80.0, 80), (2, 60.0, 200.0, 30)],
            gap=5.0, allow_rotation=True, fill_remainder=True,
        ),
        # mixed_bin_pack: số lượng cố định mỗi loại
        "mixed_explicit_qty": lambda: solve_mixed_bin_pack(
            sheet_w=700.0, sheet_h=500.0,
            items=[(0, 110.0, 90.0, 12), (1, 60.0, 60.0, 20), (2, 180.0, 40.0, 8)],
            gap=4.0, allow_rotation=True,
        ),
        # edge: tem to hơn cả tờ → 0
        "edge_too_big": lambda: solve_auto_fill_mixed(
            sheet_w=100.0, sheet_h=100.0,
            page_dims=[(0, 200.0, 200.0)],
            gap=2.0, allow_rotation=True,
        ),
    }


def _normalize(result):
    """Chuẩn hóa để so sánh ổn định: làm tròn float 6 chữ số (khớp _q6)."""
    def r(v):
        return round(float(v), 6) if isinstance(v, (int, float)) else v

    out = {
        "total_placed": result.get("total_placed"),
        "placed_by_page": {str(k): v for k, v in sorted(result.get("placed_by_page", {}).items())},
        "placements": [
            {
                "page_idx": p["page_idx"],
                "x": r(p["x"]), "y": r(p["y"]),
                "w": r(p["w"]), "h": r(p["h"]),
                "is_rotated": bool(p["is_rotated"]),
            }
            for p in result.get("placements", [])
        ],
    }
    if "sheets_needed" in result:
        out["sheets_needed"] = result["sheets_needed"]
    return out


def _run_all():
    return {name: _normalize(fn()) for name, fn in _scenarios().items()}


@pytest.mark.skipif(not os.path.exists(_GOLDEN_PATH), reason="golden snapshot chưa được sinh")
@pytest.mark.parametrize("name", list(_scenarios().keys()))
def test_bin_packing_matches_golden(name):
    with open(_GOLDEN_PATH, "r", encoding="utf-8") as f:
        golden = json.load(f)
    assert name in golden, f"thiếu snapshot cho '{name}' — regenerate golden"
    current = _normalize(_scenarios()[name]())
    assert current == golden[name], (
        f"[{name}] output bin-packing ĐÃ THAY ĐỔI so với golden — "
        f"vi phạm cam kết giữ-nguyên-kết-quả"
    )


if __name__ == "__main__":
    # Sinh / regenerate snapshot từ code HIỆN TẠI.
    os.makedirs(os.path.dirname(_GOLDEN_PATH), exist_ok=True)
    with open(_GOLDEN_PATH, "w", encoding="utf-8") as f:
        json.dump(_run_all(), f, indent=2, ensure_ascii=False)
    print(f"Wrote golden snapshot: {_GOLDEN_PATH}")
