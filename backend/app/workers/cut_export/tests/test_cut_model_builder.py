"""Test CutModelBuilder (task 2.4). Requirements: 1.1, 1.2, 1.4, 1.5."""

import pytest

from app.workers.cut_export.cut_model_builder import (
    build_cut_model,
    NamingContractError,
)


def test_build_from_coords_lists():
    cm = build_cut_model(
        [[(0, 0), (10, 0), (10, 10), (0, 10)]],
        marks=[(0, 0, "L"), (100, 0, "L"), (0, 200, "L"), (100, 200, "L")],
        sheet_w_mm=100, sheet_h_mm=200,
    )
    assert len(cm.paths) == 1
    assert cm.frame == (0.0, 0.0, 100.0, 200.0)
    assert len(cm.marks) == 4


def test_preserves_layout_positions():
    # Hai con ở vị trí khác nhau — builder KHÔNG được căn lại (Req 1.4).
    g1 = [(10, 10), (20, 10), (20, 20), (10, 20)]
    g2 = [(50, 50), (60, 50), (60, 60), (50, 60)]
    cm = build_cut_model([g1, g2], sheet_w_mm=100, sheet_h_mm=100)
    xs = sorted(p.points[0][0] for p in cm.paths)
    assert xs == [10.0, 50.0]


def test_rdp_simplifies_redundant_points():
    # Cạnh có điểm thừa giữa → RDP loại bỏ (Req 1.2).
    ring = [(0, 0), (5, 0), (10, 0), (10, 10), (0, 10)]
    cm = build_cut_model([ring], sheet_w_mm=20, sheet_h_mm=20)
    assert (5.0, 0.0) not in cm.paths[0].points


def test_empty_raises():
    with pytest.raises(ValueError):
        build_cut_model([], sheet_w_mm=10, sheet_h_mm=10)


def test_naming_contract_enforced():
    with pytest.raises(NamingContractError):
        build_cut_model(
            [[(0, 0), (1, 0), (1, 1)]],
            sheet_w_mm=10, sheet_h_mm=10,
            pont_config={"groupName": "", "itemName": ""},
            require_naming=True,
        )


def test_naming_contract_passes_with_names():
    cm = build_cut_model(
        [[(0, 0), (1, 0), (1, 1)]],
        sheet_w_mm=10, sheet_h_mm=10,
        pont_config={"groupName": "MarkLine", "itemName": "MKLINE", "layerName": "Cam_Khuon"},
        require_naming=True,
    )
    assert cm.source_names["group"] == "MarkLine"
    assert cm.source_names["item"] == "MKLINE"


def test_tool_tags_and_block_ids():
    cm = build_cut_model(
        [[(0, 0), (1, 0), (1, 1)], [(2, 2), (3, 2), (3, 3)]],
        sheet_w_mm=10, sheet_h_mm=10,
        tool_tags=["left", "right"], block_ids=[1, 2],
    )
    tags = {p.tool_tag for p in cm.paths}
    assert tags == {"left", "right"}


def test_accepts_shapely_polygon():
    shapely = pytest.importorskip("shapely")
    from shapely.geometry import Polygon
    poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    cm = build_cut_model([poly], sheet_w_mm=20, sheet_h_mm=20)
    assert len(cm.paths) == 1
    assert len(cm.paths[0].points) >= 4
