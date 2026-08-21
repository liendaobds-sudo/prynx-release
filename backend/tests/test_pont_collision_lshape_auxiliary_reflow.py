"""Hồi quy né ốc cho bình tem L-shape một dao.

Khối fill L-shape mang blockId 1 (phải) hoặc 2 (đáy). Khi hở tem bằng 0,
solver vẫn phải cho resolver dịch CẢ khối phụ theo phần trống còn lại, thay vì
xóa/dồn riêng từng tem như lưới thường.

Candidate hòa sản lượng cũng phải được canh và xếp hạng giống nhau giữa Rust
và Python trên cả dải gap, không chỉ đúng tại đúng giá trị 0.
"""

from types import SimpleNamespace

import pytest
from shapely.geometry import box

from app.api.routes.imposition import apply_preview_collisions
from app.workers.imposition_finalize import finalize_placements
from app.workers.pont_collision import (
    _has_any_sticker_overlap,
    _resolve_one_orientation,
    _try_l_shape_auxiliary_block_shift,
    calculate_forbidden_zones,
    detect_collisions,
    get_item_polygon,
    get_placements_bbox,
    smart_resolve_collisions,
)
from app.workers.sticker_imposer_pkg.shape_layouts import _py_solve_l_shape_layout


SHEET_W = 300.0
SHEET_H = 300.0
MARGINS = {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0}
BASE_POLY = box(-20.0, -20.0, 20.0, 20.0)


def _placement(x, y, block_id, *, rotated):
    return {
        "cluster_idx": 0,
        "cell": {
            "x": x,
            "y": y,
            "width": 40.0,
            "height": 40.0,
            "isRotated": rotated,
            "isRotated180": False,
            "blockId": block_id,
        },
        "src_page_idx": 0,
        "abs_x": x,
        "abs_y": y,
        "width": 40.0,
        "height": 40.0,
        "original_cell_y": SHEET_H - y - 40.0,
    }


def _auxiliary_positions(placements, block_id):
    return [
        (placement["abs_x"], placement["abs_y"])
        for placement in placements
        if placement["cell"].get("blockId") == block_id
    ]


def test_finalize_preserves_explicit_lshape_block_ids():
    """Finalize không được làm rơi blockId đã phát bởi solver L-shape."""
    items = [
        {"x": 0.0, "y": 0.0, "width": 40.0, "height": 40.0, "blockId": 0},
        {"x": 40.0, "y": 0.0, "width": 40.0, "height": 40.0, "blockId": 1},
        {"x": 80.0, "y": 0.0, "width": 40.0, "height": 40.0, "blockId": 2},
        {"x": 80.0, "y": 0.0, "width": 40.0, "height": 40.0},
    ]

    placements = finalize_placements(items, 120.0, 40.0, 0.0, 0.0, 0.0)

    assert [placement["cell"].get("blockId") for placement in placements] == [0, 1, 2, None]


def test_rotated_lshape_auxiliary_uses_its_own_effective_rectangle():
    """Khối phụ xoay 90° phải dò 50×80, không dùng nhầm 80×50 của khối chính."""
    auxiliary = _placement(220.0, 220.0, 1, rotated=True)
    auxiliary["width"] = auxiliary["cell"]["width"] = 50.0
    auxiliary["height"] = auxiliary["cell"]["height"] = 80.0
    auxiliary["original_cell_y"] = SHEET_H - auxiliary["abs_y"] - auxiliary["height"]
    main_shape = box(-40.0, -25.0, 40.0, 25.0)
    top_right_zone = box(230.0, 286.0, 260.0, 295.0)

    polygon = get_item_polygon(auxiliary, main_shape)

    assert polygon.bounds == (220.0, 220.0, 270.0, 300.0)
    assert detect_collisions(
        [auxiliary], [top_right_zone], main_shape, main_shape.bounds, SHEET_H,
    ) == [0]


def test_detect_collisions_ignores_boundary_only_contact():
    """Tiếp tuyến với biên an toàn không phải là xâm lấn có diện tích."""
    placement = _placement(0.0, 0.0, 0, rotated=False)
    touching_zone = box(40.0, 0.0, 60.0, 40.0)
    # Chỉ lấn 0,01 pt (diện tích 0,4 pt²): vẫn là va chạm thật, không được
    # dùng nhầm ngưỡng đè tem-tem 1 pt² để bỏ qua.
    overlapping_zone = box(39.99, 0.0, 60.0, 40.0)

    assert detect_collisions(
        [placement], [touching_zone], BASE_POLY, BASE_POLY.bounds, SHEET_H,
    ) == []
    assert detect_collisions(
        [placement], [overlapping_zone], BASE_POLY, BASE_POLY.bounds, SHEET_H,
    ) == [0]


def test_lshape_right_auxiliary_block_shifts_as_one_at_zero_gap():
    """Khối phụ bên phải dịch trọn khối, không bị xóa khi chạm ốc góc phải-trên."""
    placements = [
        _placement(20.0, 40.0, 0, rotated=False),
        _placement(20.0, 100.0, 0, rotated=False),
        # Khối phải chạm sát đáy nên không thể dịch dọc; chỉ còn vùng trống bên trái.
        _placement(220.0, 220.0, 1, rotated=True),
        _placement(220.0, 0.0, 1, rotated=True),
    ]
    zones = [box(250.0, 250.0, 280.0, 280.0)]

    assert detect_collisions(placements, zones, BASE_POLY, BASE_POLY.bounds, SHEET_H) == [2]
    resolved = smart_resolve_collisions(
        placements, zones, BASE_POLY, BASE_POLY.bounds, SHEET_W, SHEET_H, MARGINS,
    )

    assert len(resolved) == len(placements)
    assert detect_collisions(resolved, zones, BASE_POLY, BASE_POLY.bounds, SHEET_H) == []
    assert not _has_any_sticker_overlap(resolved, BASE_POLY)
    before = _auxiliary_positions(placements, 1)
    after = _auxiliary_positions(resolved, 1)
    shifts = {(round(ax - bx, 6), round(ay - by, 6)) for (bx, by), (ax, ay) in zip(before, after)}
    assert len(shifts) == 1
    shift_x, shift_y = shifts.pop()
    assert shift_x < 0.0
    assert shift_y == 0.0
    assert _auxiliary_positions(resolved, 0) == _auxiliary_positions(placements, 0)


def test_lshape_auxiliary_helper_rejects_a_mixed_orientation_block():
    """Block phụ trộn hướng không phải cấu trúc L-shape một dao hợp lệ."""
    placements = [
        _placement(20.0, 40.0, 0, rotated=False),
        _placement(20.0, 100.0, 0, rotated=False),
        _placement(220.0, 220.0, 1, rotated=True),
        _placement(220.0, 0.0, 1, rotated=False),
    ]
    zones = [box(250.0, 250.0, 280.0, 280.0)]
    initial = detect_collisions(
        placements, zones, BASE_POLY, BASE_POLY.bounds, SHEET_H,
    )

    assert initial == [2]
    assert _try_l_shape_auxiliary_block_shift(
        placements,
        zones,
        BASE_POLY,
        BASE_POLY.bounds,
        SHEET_W,
        SHEET_H,
        initial,
    ) is None


def test_lshape_bottom_auxiliary_block_shifts_as_one_at_zero_gap():
    """Khối phụ đáy dịch trọn khối, không bị xóa khi chạm ốc góc phải-dưới."""
    placements = [
        _placement(20.0, 160.0, 0, rotated=False),
        _placement(80.0, 160.0, 0, rotated=False),
        # Khối đáy chạm hai mép ngang nên chỉ còn vùng trống phía trên.
        _placement(220.0, 20.0, 2, rotated=True),
        _placement(0.0, 20.0, 2, rotated=True),
    ]
    zones = [box(250.0, 20.0, 280.0, 50.0)]

    assert detect_collisions(placements, zones, BASE_POLY, BASE_POLY.bounds, SHEET_H) == [2]
    resolved = smart_resolve_collisions(
        placements, zones, BASE_POLY, BASE_POLY.bounds, SHEET_W, SHEET_H, MARGINS,
    )

    assert len(resolved) == len(placements)
    assert detect_collisions(resolved, zones, BASE_POLY, BASE_POLY.bounds, SHEET_H) == []
    assert not _has_any_sticker_overlap(resolved, BASE_POLY)

    before = _auxiliary_positions(placements, 2)
    after = _auxiliary_positions(resolved, 2)
    shifts = {(round(ax - bx, 6), round(ay - by, 6)) for (bx, by), (ax, ay) in zip(before, after)}
    assert len(shifts) == 1
    shift_x, shift_y = shifts.pop()
    assert shift_x == 0.0
    assert shift_y > 0.0
    assert _auxiliary_positions(resolved, 0) == _auxiliary_positions(placements, 0)


def test_relative_preview_keeps_lshape_auxiliary_shift(monkeypatch):
    """Preview tương đối phải đổi ngược abs về x/y, không trả cell vị trí cũ."""
    zones = [box(250.0, 250.0, 280.0, 280.0)]
    monkeypatch.setattr(
        "app.workers.pont_collision.calculate_forbidden_zones",
        lambda *_args, **_kwargs: zones,
    )
    # x/y của preview tương đối (gốc trên-trái) tương ứng với placement ở test
    # khối phải: aux trên abs=(220,220), aux dưới abs=(220,0).
    items = [
        {"x": 20.0, "y": 220.0, "width": 40.0, "height": 40.0, "isRotated": False, "blockId": 0},
        {"x": 20.0, "y": 160.0, "width": 40.0, "height": 40.0, "isRotated": False, "blockId": 0},
        {"x": 220.0, "y": 40.0, "width": 40.0, "height": 40.0, "isRotated": True, "blockId": 1},
        {"x": 220.0, "y": 260.0, "width": 40.0, "height": 40.0, "isRotated": True, "blockId": 1},
    ]
    req = SimpleNamespace(
        pont_config={"shape": "circle", "size": 5.0},
        sheet_w=SHEET_W,
        sheet_h=SHEET_H,
        usable_w=SHEET_W,
        usable_h=SHEET_H,
        margin_left=0.0,
        margin_bottom=0.0,
    )

    resolved = apply_preview_collisions(
        items, 40.0, 40.0, req,
        overall_w=SHEET_W, overall_h=SHEET_H, base_poly=BASE_POLY,
    )

    assert len(resolved) == len(items)
    assert [item["blockId"] for item in resolved] == [0, 0, 1, 1]
    assert [(item["x"], item["y"]) for item in resolved[:2]] == [
        (item["x"], item["y"]) for item in items[:2]
    ]
    auxiliary_shifts = {
        (round(after["x"] - before["x"], 6), round(after["y"] - before["y"], 6))
        for before, after in zip(items[2:], resolved[2:])
    }
    assert len(auxiliary_shifts) == 1
    shift_x, shift_y = auxiliary_shifts.pop()
    assert shift_x < 0.0
    assert shift_y == 0.0


def test_real_lshape_solver_shifts_auxiliary_before_generic_reflow():
    """Ca solver thật: dịch khối phụ trước giúp giữ thêm tem ở hở 0 mm."""
    mm = 2.83464567
    sheet_w, sheet_h = 320.0 * mm, 430.0 * mm
    margin = 5.0 * mm
    usable_w, usable_h = sheet_w - 2.0 * margin, sheet_h - 2.0 * margin
    pont = {
        "shape": "circle",
        "size": 5.0,
        "marginTop": 7.0,
        "marginBottom": 7.0,
        "marginLeft": 7.0,
        "marginRight": 7.0,
    }
    pont_margins = {key: 7.0 * mm for key in ("left", "right", "top", "bottom")}
    zones = calculate_forbidden_zones(pont, pont_margins, sheet_w, sheet_h)
    layout = _py_solve_l_shape_layout(
        usable_w,
        usable_h,
        135.0 * mm,
        20.0 * mm,
        0.0,
        0.0,
        0.0,
    )
    placements = finalize_placements(
        layout["items"], usable_w, usable_h, margin, margin, margin,
    )
    base_poly = box(-135.0 * mm / 2.0, -20.0 * mm / 2.0, 135.0 * mm / 2.0, 20.0 * mm / 2.0)
    initial = detect_collisions(
        placements, zones, base_poly, base_poly.bounds, sheet_h,
    )
    assert len(placements) == 48
    assert any(placements[index]["cell"].get("blockId") == 1 for index in initial)

    # Baseline của nhánh dồn hàng cũ: mất 4 tem ở ca này.
    generic = _resolve_one_orientation(
        placements,
        zones,
        base_poly,
        base_poly.bounds,
        sheet_w,
        sheet_h,
        pont_margins,
    )
    assert generic is not None and len(generic) == 44

    shifted = _try_l_shape_auxiliary_block_shift(
        placements,
        zones,
        base_poly,
        base_poly.bounds,
        sheet_w,
        sheet_h,
        initial,
    )
    assert shifted is not None
    before = _auxiliary_positions(placements, 1)
    after = _auxiliary_positions(shifted, 1)
    assert len({
        (round(ax - bx, 6), round(ay - by, 6))
        for (bx, by), (ax, ay) in zip(before, after)
    }) == 1

    resolved = smart_resolve_collisions(
        placements,
        zones,
        base_poly,
        base_poly.bounds,
        sheet_w,
        sheet_h,
        pont_margins,
    )
    # Tiếp tuyến vùng an toàn không còn bị tính là xâm lấn, nên giữ thêm 1 tem
    # so với baseline trước §LS-PONT.4.
    assert len(resolved) == 46
    assert detect_collisions(
        resolved, zones, base_poly, base_poly.bounds, sheet_h,
    ) == []
    assert not _has_any_sticker_overlap(resolved, base_poly)


def test_real_90x50_lshape_reflows_main_in_its_own_center_and_keeps_26():
    """File Thu Hồng: khối chính canh tâm riêng, khối phụ giữ nguyên, còn 26 tem."""
    mm = 2.83464567
    sheet_w, sheet_h = 320.0 * mm, 430.0 * mm
    margin_left = 0.0
    margin_bottom = margin_top = 5.0 * mm
    usable_w, usable_h = sheet_w, sheet_h - margin_bottom - margin_top
    pont = {
        "shape": "circle",
        "size": 5.0,
        "marginTop": 7.0,
        "marginBottom": 7.0,
        "marginLeft": 7.0,
        "marginRight": 7.0,
    }
    pont_margins = {key: 7.0 * mm for key in ("left", "right", "top", "bottom")}
    zones = calculate_forbidden_zones(pont, pont_margins, sheet_w, sheet_h)
    layout = _py_solve_l_shape_layout(
        usable_w,
        usable_h,
        90.00085 * mm,
        50.0381 * mm,
        0.0,
        0.0,
        0.0,
    )
    placements = finalize_placements(
        layout["items"], usable_w, usable_h,
        margin_left, margin_bottom, margin_top,
    )
    # Solver chọn khối chính xoay 90°: ô hiệu dụng đầu tiên là ~50×90 mm.
    base_poly = box(
        -placements[0]["width"] / 2.0,
        -placements[0]["height"] / 2.0,
        placements[0]["width"] / 2.0,
        placements[0]["height"] / 2.0,
    )

    assert len(placements) == 27
    assert sum(p["cell"].get("blockId") == 0 for p in placements) == 24
    assert sum(p["cell"].get("blockId") == 2 for p in placements) == 3
    assert detect_collisions(
        placements, zones, base_poly, base_poly.bounds, sheet_h,
    ) == [0, 5]

    auxiliary_before = _auxiliary_positions(placements, 2)
    source_order = {
        id(placement["cell"]): index
        for index, placement in enumerate(placements)
    }

    resolved = smart_resolve_collisions(
        placements,
        zones,
        base_poly,
        base_poly.bounds,
        sheet_w,
        sheet_h,
        pont_margins,
    )

    assert len(resolved) == 26
    assert detect_collisions(
        resolved, zones, base_poly, base_poly.bounds, sheet_h,
    ) == []
    assert not _has_any_sticker_overlap(resolved, base_poly)
    assert sum(p["cell"].get("blockId") == 0 for p in resolved) == 23
    assert sum(p["cell"].get("blockId") == 2 for p in resolved) == 3
    assert _auxiliary_positions(resolved, 2) == auxiliary_before
    survivor_order = [source_order[id(placement["cell"])] for placement in resolved]
    assert survivor_order == sorted(survivor_order)

    main = [p for p in resolved if p["cell"].get("blockId") == 0]
    auxiliary = [p for p in resolved if p["cell"].get("blockId") == 2]
    main_bbox = get_placements_bbox(main)
    auxiliary_bbox = get_placements_bbox(auxiliary)
    assert abs((main_bbox[0] + main_bbox[2]) / 2.0 - sheet_w / 2.0) < 0.1
    assert abs((auxiliary_bbox[0] + auxiliary_bbox[2]) / 2.0 - sheet_w / 2.0) < 0.1

    # Chỉ hàng chính giáp ốc bị co từ 6 xuống 5; các hàng chính còn lại giữ 6.
    main_rows = {}
    for placement in main:
        main_rows.setdefault(round(placement["abs_y"], 3), []).append(placement)
    assert sorted(len(row) for row in main_rows.values()) == [5, 6, 6, 6]

    short_row = next(row for row in main_rows.values() if len(row) == 5)
    short_row_min_x = min(placement["abs_x"] for placement in short_row)
    short_row_max_x = max(
        placement["abs_x"] + placement["width"] for placement in short_row
    )
    assert abs((short_row_min_x + short_row_max_x) / 2.0 - sheet_w / 2.0) < 0.1


def test_a3_zero_gap_tie_chooses_the_compact_collision_free_27_layout():
    """A3 lỡ: hở 0 không được chọn phương án hòa cao sát ốc rồi xóa tem."""
    mm = 2.83464567
    sheet_w, sheet_h = 320.0 * mm, 450.0 * mm
    margin = 3.0 * mm
    usable_w, usable_h = sheet_w - 2.0 * margin, sheet_h - 2.0 * margin
    item_w, item_h = 90.00085 * mm, 50.0381 * mm
    pont = {
        "shape": "circle",
        "size": 5.0,
        "marginTop": 7.0,
        "marginBottom": 7.0,
        "marginLeft": 7.0,
        "marginRight": 7.0,
    }
    pont_margins = {key: 7.0 * mm for key in ("left", "right", "top", "bottom")}
    zones = calculate_forbidden_zones(pont, pont_margins, sheet_w, sheet_h)

    layout = _py_solve_l_shape_layout(
        usable_w, usable_h, item_w, item_h, 0.0, 0.0, 0.0,
    )

    assert layout["totalItems"] == 27
    assert sum(item.get("blockId") == 0 for item in layout["items"]) == 24
    assert sum(item.get("blockId") == 2 for item in layout["items"]) == 3
    assert layout["heightUsed"] / mm < 420.0

    placements = finalize_placements(
        layout["items"], usable_w, usable_h, margin, margin, margin,
    )
    # Contour theo hệ PDF thật (gốc dưới-trái), không dùng box tâm giả lập.
    base_poly = box(0.0, 0.0, item_w, item_h)
    assert detect_collisions(
        placements, zones, base_poly, base_poly.bounds, sheet_h,
    ) == []

    resolved = smart_resolve_collisions(
        placements,
        zones,
        base_poly,
        base_poly.bounds,
        sheet_w,
        sheet_h,
        pont_margins,
    )
    assert len(resolved) == 27
    assert detect_collisions(
        resolved, zones, base_poly, base_poly.bounds, sheet_h,
    ) == []
    assert not _has_any_sticker_overlap(resolved, base_poly)


@pytest.mark.parametrize("gap_mm", [0.0, 0.5, 1.0, 2.0])
def test_native_lshape_matches_python_for_a3_gap_candidates(gap_mm):
    """Rust/Python phải phá hòa/canh khối giống nhau trên dải gap thực tế."""
    native = pytest.importorskip("pdfcompare_native")
    mm = 2.83464567
    usable_w, usable_h = (320.0 - 6.0) * mm, (450.0 - 6.0) * mm
    item_w, item_h = 90.00085 * mm, 50.0381 * mm
    gap = gap_mm * mm

    python_layout = _py_solve_l_shape_layout(
        usable_w, usable_h, item_w, item_h, gap, gap,
    )
    native_layout = native.shape_l_layout(
        usable_w, usable_h, item_w, item_h, gap, gap,
    )

    def signature(layout):
        return [
            (
                round(item["x"], 6),
                round(item["y"], 6),
                round(item["width"], 6),
                round(item["height"], 6),
                bool(item.get("isRotated", False)),
                int(item.get("blockId", 0)),
            )
            for item in layout["items"]
        ]

    assert native_layout["totalItems"] == python_layout["totalItems"] == 27
    assert native_layout["heightUsed"] / mm < 420.0
    assert round(native_layout["widthUsed"], 6) == round(python_layout["widthUsed"], 6)
    assert round(native_layout["heightUsed"], 6) == round(python_layout["heightUsed"], 6)
    assert signature(native_layout) == signature(python_layout)
