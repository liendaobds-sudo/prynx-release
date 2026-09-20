"""Ưu tiên hướng gốc khi không tăng số tờ của Dàn nhiều mẫu (2026-09-19)."""

import pytest

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import nup_layout_solver as solver, pdf_wrapper as pdf_lib
from app.workers.nup_sheet_render import nup_sheet_plan
from tests.license_helpers import PRO_LICENSE

MM = 72 / 25.4


@pytest.mark.parametrize("python_fallback", [False, True])
@pytest.mark.parametrize("quantity,rotated", [
    (None, True), (0, True), (1, False), (11, False), (110, False),
    (121, True), (220, False), (221, True),
])
def test_rotation_must_save_sheets_for_finite_quantity(monkeypatch, python_fallback, quantity, rotated):
    if python_fallback:
        monkeypatch.setattr(solver, "_USE_RUST", False)
        monkeypatch.setattr(solver, "_FORCE_PY", True)
    layout = solver.solve_optimal_layout(
        320, 470, 30, 40, 0, 0, "optimal_auto", required_items=quantity,
    )
    assert any(cell["isRotated"] for cell in layout["cells"]) == rotated
    if not rotated:
        assert layout["totalItems"] == 110


def test_rotation_still_allowed_when_original_does_not_fit():
    layout = solver.solve_optimal_layout(
        40, 30, 30, 40, 0, 0, "optimal_auto", required_items=1,
    )
    assert layout["totalItems"] == 1
    assert layout["cells"][0]["isRotated"] is True


@pytest.mark.parametrize("page_count,quantity,overrides,duplex,expected", [
    (11, 1, {}, False, 11),
    (22, 1, {"1": 999}, True, 11),
    (3, 5, {"0": 1, 1: 0}, False, 6),
    (3, 5, {"0": 0, "1": 0, "2": 0}, False, 15),
    (11, 0, {}, False, 11),
    (1, 0, {}, False, None),
    (2, 0, {}, True, None),
])
def test_quantity_summary_matches_sequence_without_materializing_copies(
    page_count, quantity, overrides, duplex, expected,
):
    required = solver.sequential_required_items(
        page_count, quantity, overrides, duplex,
    )
    assert required == expected
    sequence = solver.build_sequential_product_sequence(
        page_count, 122, quantity, overrides, duplex,
    )
    assert len(sequence) == (122 if expected is None else expected)


def _source(path, pages):
    doc = pdf_lib.open()
    for index in range(pages):
        page = doc.new_page(width=30 * MM, height=40 * MM)
        page.insert_text(pdf_lib.Point(10, 20), str(index + 1))
    doc.save(str(path))
    doc.close()
    return str(path)


@pytest.mark.parametrize("pages,quantity,overrides,duplex,rotated,sheets", [
    (11, 1, {}, False, False, 1),
    (11, 11, {}, False, True, 1),
    (11, 20, {}, False, False, 2),
    (22, 1, {"1": 999}, True, False, 1),
    (2, 0, {"0": 1, "1": 109}, False, False, 1),
    (1, 0, {}, False, True, 1),
    (1, 11, {}, False, False, 1),
    (11, 0, {}, False, False, 1),
])
def test_preview_and_export_use_same_quantity_orientation(
    tmp_path, pages, quantity, overrides, duplex, rotated, sheets,
):
    source = _source(tmp_path / "upright.pdf", pages)
    flow = "double" if duplex else "normal"
    preview = preview_layout(PreviewLayoutRequest(
        usable_w=320 * MM, usable_h=470 * MM,
        sheet_w=330 * MM, sheet_h=480 * MM,
        margin_left=5 * MM, margin_right=5 * MM,
        margin_top=5 * MM, margin_bottom=5 * MM,
        item_w=30 * MM, item_h=40 * MM,
        gap_x=0, gap_y=0, bleed=0, split_gap=0,
        strategy="optimal_auto", shape_type="CUSTOM",
        path=source, task_mode="nup", layout_type="sequential",
        is_die_cut=False, total_pages=pages, target_quantity=quantity,
        target_quantities_by_page=overrides, duplex_flow=flow,
    ), PRO_LICENSE)
    settings = {
        "imposerMode": "guillotine", "isDieCutMode": False,
        "taskMode": "nup", "layoutType": "sequential",
        "sheetWidth": 330, "sheetHeight": 480, "gridStrategy": "optimal_auto",
        "targetQuantity": quantity, "targetQuantitiesByPage": overrides,
        "marginLeft": 5, "marginRight": 5, "marginTop": 5, "marginBottom": 5,
        "gripperMargin": 0, "gapX": 0, "gapY": 0, "bleed": 0, "splitGap": 0,
        "markType": "none", "pontType": "none", "align": "center",
        "duplexFlow": flow,
    }
    assert any(cell["isRotated"] for cell in preview["cells"]) == rotated
    with nup_sheet_plan(source, settings, job_id="orientation-policy") as plan:
        assert plan.total_sheets == sheets * (2 if duplex else 1)
        args = plan.build_chunk_args(0, 1, 0)
        assert any(cell["isRotated"] for cell in args[8]) == rotated
        placements = args[37][0]
        assert len(placements) <= len(preview["cells"])
        for actual, expected in zip(placements, preview["cells"]):
            assert actual["cell"]["isRotated"] == expected["isRotated"]
            assert actual["width"] == pytest.approx(expected["width"], abs=0.002)
            assert actual["height"] == pytest.approx(expected["height"], abs=0.002)
