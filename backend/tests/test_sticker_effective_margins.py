"""Hồi quy 72 loại: preview nhận lề hiệu dụng, export nhận lề gốc + dấu xén."""
from collections import Counter
from copy import deepcopy

import pikepdf
import pytest

from app.api.routes.imposition import preview_layout
from app.workers import nup_engine
from app.workers.nup_sheet_render import nup_sheet_plan
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _request, _source

MM = 72 / 25.4
PONT = {
    "shape": "circle", "size": 5, "thickness": .5, "disableCollision": False,
    "marginTop": 7, "marginBottom": 7, "marginLeft": 7, "marginRight": 7,
}


def _case(source, *, strategy="optimal_auto", layout="sequential",
          effective=(8, 8, 8, 8), **overrides):
    # Không suy settings xuất từ preview: làm vậy sẽ che lỗi mất phần lề dấu xén.
    left, right, top, bottom = effective
    settings = {
        "page_sheet_mode": True, "isDieCutMode": False, "taskMode": "nup",
        "layoutType": layout, "gridStrategy": strategy, "groupingStrategy": "none",
        "sheetWidth": 320, "sheetHeight": 430,
        "marginLeft": 0, "marginRight": 0, "marginTop": 0, "marginBottom": 0,
        "marginMode": "include_marks", "markType": "guillotine",
        "markLength": 5, "markOffset": 3, "gapX": 0, "gapY": 0, "bleed": 0,
        "targetQuantity": 0, "pontType": "5mm", "pontConfig": deepcopy(PONT),
        "cols": 4, "rows": 5, "align": "center", "separateCutPage": True,
        "exportUniqueSheets": True,
        **overrides,
    }
    request = _request(72, 0).model_copy(update={
        "path": source, "total_pages": 72, "page_sheet_mode": True,
        "is_die_cut": False, "detected_shapes_by_page": {}, "shape_type": "RECTANGLE",
        "strategy": strategy, "layout_type": layout, "grouping_strategy": "none",
        "sheet_w": 320*MM, "sheet_h": 430*MM,
        "usable_w": (320-left-right)*MM, "usable_h": (430-top-bottom)*MM,
        "margin_left": left*MM, "margin_right": right*MM,
        "margin_top": top*MM, "margin_bottom": bottom*MM,
        "gap_x": 0, "gap_y": 0, "pont_type": "5mm", "pont_config": deepcopy(PONT),
        "cols": settings["cols"], "rows": settings["rows"],
    })
    return request, settings


def _assert_parity(source, request, settings, counts):
    before = deepcopy(settings)
    preview = preview_layout(request, PRO_LICENSE)
    assert [len(sheet["cells"]) for sheet in preview["sheets"]] == counts
    with nup_sheet_plan(source, settings) as plan:
        assert plan.total_sheets == preview["sheetsNeeded"] == len(counts)
        assert plan.capacity == preview["capacity"]
        placements = plan.build_chunk_args(0, plan.total_sheets, 0)[37]
        assert [len(values) for values in placements.values()] == counts
        for index, sheet in enumerate(preview["sheets"]):
            for actual, expected in zip(placements[index], sheet["cells"], strict=True):
                assert actual["src_page_idx"] == expected["pageIdx"]
                assert actual["abs_x"] == pytest.approx(expected["absX"], abs=.002)
                assert actual["abs_y"] == pytest.approx(expected["absY"], abs=.002)
                assert actual["width"] == pytest.approx(expected["width"], abs=.002)
                assert actual["height"] == pytest.approx(expected["height"], abs=.002)
                assert actual["abs_x"] >= request.margin_left - .002
                assert actual["abs_y"] >= request.margin_bottom - .002
                assert actual["abs_x"] + actual["width"] <= request.sheet_w - request.margin_right + .002
                assert actual["abs_y"] + actual["height"] <= request.sheet_h - request.margin_top + .002
        produced = Counter(p["src_page_idx"] for values in placements.values() for p in values)
        assert set(produced) == set(range(72))
        if settings["layoutType"] == "sequential":
            assert produced == {i: 1 for i in range(72)}
        else:
            assert sum(produced.values()) == 80
    assert settings == before
    return preview


@pytest.mark.parametrize("strategy", ["simple_auto", "optimal_auto", "manual"])
@pytest.mark.parametrize("layout", ["sequential", "cut_stacks"])
def test_72_types_with_marks_match_preview_on_every_sheet(tmp_path, strategy, layout):
    source = _source(tmp_path / "72-types.pdf", 72)
    request, settings = _case(source, strategy=strategy, layout=layout)
    counts = [20, 20, 20, 12] if layout == "sequential" else [20]*4
    _assert_parity(source, request, settings, counts)


@pytest.mark.parametrize("effective,overrides,counts", [
    ((0, 0, 0, 0), {"markType": "none"}, [24]*3),
    ((0, 0, 0, 0), {"marginMode": "labels_only"}, [24]*3),
    ((8, 8, 8, 8), {
        "marginMode": "labels_only",
        "marginLeft": 8, "marginRight": 8, "marginTop": 8, "marginBottom": 8,
    }, [20, 20, 20, 12]),
])
def test_marks_off_or_already_effective_margins_are_not_added_twice(tmp_path, effective, overrides, counts):
    source = _source(tmp_path / "72-types.pdf", 72)
    request, settings = _case(source, effective=effective, **overrides)
    _assert_parity(source, request, settings, counts)


def test_asymmetric_margins_apply_gripper_before_mark_space(tmp_path):
    source = _source(tmp_path / "72-types.pdf", 72)
    request, settings = _case(
        source, effective=(11, 17, 12, 26),
        marginLeft=3, marginRight=9, marginTop=4, marginBottom=2, gripperMargin=18,
    )
    _assert_parity(source, request, settings, [20, 20, 20, 12])


def test_manual_sixth_row_cannot_use_space_reserved_for_marks(tmp_path):
    source = _source(tmp_path / "72-types.pdf", 72)
    _request_unused, settings = _case(source, strategy="manual", rows=6)
    with pytest.raises(ValueError, match="vượt vùng giấy"):
        with nup_sheet_plan(source, settings):
            pass


@pytest.mark.parametrize("mark_type", ["guillotine", "corners"])
def test_export_pdf_contains_four_print_cut_pairs_and_all_72_types(tmp_path, mark_type):
    source = _source(tmp_path / "72-types.pdf", 72)
    request, settings = _case(source, markType=mark_type)
    _assert_parity(source, request, settings, [20, 20, 20, 12])
    output = tmp_path / "four-sheets.pdf"
    nup_engine.run_nup_engine(source, str(output), settings)
    sequences = []
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 8  # 4 tờ IN và 4 trang khuôn CUT.
        for index, page in enumerate(pdf.pages):
            names = [
                str(op.operands[0]) for op in pikepdf.parse_content_stream(page)
                if str(op.operator) == "Do" and str(op.operands[0]).startswith("/NupXo")
            ]
            if index % 2:
                assert names == []
            else:
                sequences.append([int(name.rsplit("_", 1)[1]) for name in names])
    assert [len(seq) for seq in sequences] == [20, 20, 20, 12]
    assert [i for seq in sequences for i in seq] == list(range(72))
    assert sequences[-1] == list(range(60, 72))
