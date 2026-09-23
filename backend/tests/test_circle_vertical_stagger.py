"""Unit test kiểm chứng thuật toán So le theo CỘT (staggered_vertical) cho hình tròn/elip.

Bảo đảm khi khổ giấy có tỷ lệ kích thước mà xếp so le theo cột cho ra nhiều tem hơn
so với so le theo hàng (ví dụ: 9 con so với 8 con, hoặc 4 con so với 2 con), hệ thống
phải tự động chọn phương án so le theo cột (staggered_vertical).
"""
import math
import pytest
from app.workers.sticker_imposer_pkg.orchestrator import solve_optimal_sticker_layout
from app.workers.sticker_imposer_pkg.grid_layouts import (
    calculate_staggered_hex_layout,
    calculate_staggered_vertical_layout,
)


def test_vertical_stagger_yields_4_items_when_hex_yields_2():
    """Trường hợp khổ giấy hẹp bề ngang (như ảnh 3 vs ảnh 4 của khách hàng):
    - Tem tròn D = 100mm, gap = 2mm.
    - usable_w = 190mm, usable_h = 260mm.
    - So le hàng (hex) chỉ ra 2 con (2 hàng x 1 con).
    - So le cột (vertical) ra 4 con (2 cột x 2 con).
    - solve_optimal_sticker_layout phải tự động chọn 4 con (staggered_vertical).
    """
    item_w = item_h = 100.0
    usable_w = 190.0
    usable_h = 260.0
    gap_x = gap_y = 2.0

    hex_res = calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    vert_res = calculate_staggered_vertical_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

    assert hex_res["totalItems"] == 2, f"Hex layout mong đợi 2 con, nhưng ra {hex_res['totalItems']}"
    assert vert_res["totalItems"] == 4, f"Vertical layout mong đợi 4 con, nhưng ra {vert_res['totalItems']}"

    opt_res = solve_optimal_sticker_layout(
        usable_w, usable_h, item_w, item_h, gap_x, gap_y,
        strategy="optimal_auto", shape_type="CIRCLE_ELLIPSE",
    )
    assert opt_res["totalItems"] == 4, f"Auto-optimal phải chọn 4 con, nhưng ra {opt_res['totalItems']}"
    assert "staggered_vertical" in opt_res["strategyUsed"]


def test_vertical_stagger_yields_9_items_when_hex_yields_8():
    """Trường hợp khổ in 330 x 480mm (như ảnh 1 vs ảnh 2 của khách hàng):
    - Tem tròn D = 105mm, gap = 2mm.
    - usable_w = 310mm, usable_h = 410mm.
    - So le hàng (hex) chỉ ra 8 con (4 hàng x 2 con).
    - So le cột (vertical) ra 9 con (3 cột x 3 con).
    - solve_optimal_sticker_layout phải tự động chọn 9 con (staggered_vertical).
    """
    item_w = item_h = 105.0
    usable_w = 310.0
    usable_h = 410.0
    gap_x = gap_y = 2.0

    hex_res = calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    vert_res = calculate_staggered_vertical_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

    assert hex_res["totalItems"] == 8, f"Hex layout mong đợi 8 con, nhưng ra {hex_res['totalItems']}"
    assert vert_res["totalItems"] == 9, f"Vertical layout mong đợi 9 con, nhưng ra {vert_res['totalItems']}"

    opt_res = solve_optimal_sticker_layout(
        usable_w, usable_h, item_w, item_h, gap_x, gap_y,
        strategy="optimal_auto", shape_type="CIRCLE_ELLIPSE",
    )
    assert opt_res["totalItems"] == 9, f"Auto-optimal phải chọn 9 con, nhưng ra {opt_res['totalItems']}"
    assert "staggered_vertical" in opt_res["strategyUsed"]


def test_diagonal_stagger_yields_2_items_when_hex_yields_1():
    """Trường hợp tem tròn to trên khổ A4 (ảnh khách hàng vừa gửi):
    - Tem tròn D = 126mm, gap = 2mm.
    - usable_w = 185mm, usable_h = 245mm.
    - Lưới thẳng: chỉ 1 con (185 < 254mm).
    - So le hàng (hex): chỉ 1 con (185 < 190mm nên hàng so le bị tràn lề).
    - So le cột (vertical): chỉ 1 con (185 < 237mm).
    - So le chéo góc (diagonal): 2 con đối đỉnh có khoảng cách tâm ~132.8mm >= 128mm an toàn.
    - solve_optimal_sticker_layout phải tự động chọn 2 con (staggered_diagonal).
    """
    from app.workers.sticker_imposer_pkg.grid_layouts import calculate_diagonal_stagger_layout

    item_w = item_h = 126.0
    usable_w = 185.0
    usable_h = 245.0
    gap_x = gap_y = 2.0

    hex_res = calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    vert_res = calculate_staggered_vertical_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    diag_res = calculate_diagonal_stagger_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)

    assert hex_res["totalItems"] == 1, f"Hex layout mong đợi 1 con, nhưng ra {hex_res['totalItems']}"
    assert vert_res["totalItems"] == 1, f"Vertical layout mong đợi 1 con, nhưng ra {vert_res['totalItems']}"
    assert diag_res["totalItems"] == 2, f"Diagonal layout mong đợi 2 con, nhưng ra {diag_res['totalItems']}"

    opt_res = solve_optimal_sticker_layout(
        usable_w, usable_h, item_w, item_h, gap_x, gap_y,
        strategy="optimal_auto", shape_type="CIRCLE_ELLIPSE",
    )
    assert opt_res["totalItems"] == 2, f"Auto-optimal phải chọn 2 con, nhưng ra {opt_res['totalItems']}"
    assert "staggered_diagonal" in opt_res["strategyUsed"]


def test_circle_layout_never_produces_overlapping_items():
    """Kiểm tra toàn diện: Với bất kỳ kích thước tem tròn nào trên khổ in A4,
    khoảng cách giữa MỌI cặp tem (all pairs) LUÔN >= (D + gap).
    Tuyệt đối không bao giờ có hiện tượng tem đè lên nhau!
    """
    usable_w = 185.0
    usable_h = 245.0
    gap_x = gap_y = 2.0

    # Quét qua dải kích thước từ nhỏ đến lớn
    for d in range(40, 140, 5):
        d_val = float(d)
        res = solve_optimal_sticker_layout(
            usable_w, usable_h, d_val, d_val, gap_x, gap_y,
            strategy="optimal_auto", shape_type="CIRCLE_ELLIPSE",
        )
        items = res.get("items", [])
        min_safe = d_val + gap_x - 0.05
        min_safe_sq = min_safe * min_safe

        n = len(items)
        for i in range(n):
            xi, yi = items[i]["x"], items[i]["y"]
            for j in range(i + 1, n):
                xj, yj = items[j]["x"], items[j]["y"]
                dist_sq = (xj - xi) ** 2 + (yj - yi) ** 2
                assert dist_sq >= min_safe_sq, (
                    f"VA CHẠM TEM ở D={d_val}mm! "
                    f"Tem {i} tại ({xi:.1f}, {yi:.1f}) và Tem {j} tại ({xj:.1f}, {yj:.1f}) "
                    f"có khoảng cách={math.sqrt(dist_sq):.1f}mm < {min_safe:.1f}mm an toàn!"
                )


