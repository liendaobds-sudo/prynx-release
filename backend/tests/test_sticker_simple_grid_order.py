"""Hồi quy N-Up trống SL / lưới đơn giản không gọi nesting."""
from collections import Counter
import pikepdf
import pytest

from app.api.routes.imposition import preview_layout
from app.workers import nup_engine, nup_true_shape_nesting
from app.workers.nup_sheet_render import nup_sheet_plan
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.core.mixed_nesting_service import MixedNestingRunHandle
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _source, _request


@pytest.mark.parametrize("quantity,count", [(0,72),(1,72),(2,144)])
def test_simple_grid_is_sequential_and_uses_no_nesting(tmp_path, monkeypatch, quantity, count):
    source = _source(tmp_path / "72.pdf", 72)
    request = _request(72, quantity).model_copy(update={"strategy":"simple_auto", "path":source})
    def forbidden(*args, **kwargs):
        raise AssertionError("Lưới đơn giản không được chạy nesting")
    monkeypatch.setattr(MixedNestingRunHandle, "_solve_native", forbidden)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", forbidden)
    monkeypatch.setattr(nup_true_shape_nesting, "run_true_shape_nesting", forbidden)
    preview = preview_layout(request, PRO_LICENSE)
    assert preview["strategyUsed"] == "simple_auto"
    assert preview["orderSummary"]["placedCount"] == count
    assert preview["sheetsNeeded"] == count // 9
    settings = settings_from_preview_request(request)
    settings["gridStrategy"] = "simple_auto"
    with nup_sheet_plan(source, settings) as plan:
        assert plan.capacity == 9
        assert plan.total_sheets == count // 9
        placements = plan.build_chunk_args(0, plan.total_sheets, 0)[37]
        sequence = [p["src_page_idx"] for sheet in placements.values() for p in sheet]
        assert sequence == [i for i in range(72) for _ in range(quantity or 1)]
        first = placements[0]
        for actual, expected in zip(first, preview["cells"]):
            assert actual["abs_x"] == pytest.approx(expected["absX"], abs=.002)
            assert actual["abs_y"] == pytest.approx(expected["absY"], abs=.002)
    output = tmp_path / "out.pdf"
    nup_engine.run_nup_engine(source, str(output), settings)
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2 * count // 9
        assert sum(
            sum(str(op.operator) == "Do" for op in pikepdf.parse_content_stream(pdf.pages[i]))
            for i in range(0, len(pdf.pages), 2)
        ) == count


def test_nup_empty_quantity_builds_all_types_not_one_sheet(tmp_path):
    source = _source(tmp_path / "72.pdf", 72)
    settings = settings_from_preview_request(_request(72, 0))
    job = nup_true_shape_nesting.build_true_shape_nesting_job(source, settings)
    assert job.layout_intent == "quantity_fulfillment"
    assert len(job.parts) == 72
    assert all(part.quantity == 1 for part in job.parts)
    assert job.max_sheets >= 8


def test_simple_grid_respects_per_type_zero_and_gripper(tmp_path):
    source = _source(tmp_path / "three.pdf", 3)
    request = _request(3, 0).model_copy(update={
        "path":source, "strategy":"simple_auto", "target_quantities_by_page":{"0":2,"1":0},
    })
    result = preview_layout(request, PRO_LICENSE)
    assert result["placedByPage"] == {"0":2,"2":1}
    settings = settings_from_preview_request(request)
    settings.update(gridStrategy="simple_auto", gripperMargin=20)
    with nup_sheet_plan(source, settings) as plan:
        placements = plan.build_chunk_args(0, plan.total_sheets, 0)[37]
        assert min(p["abs_y"] for values in placements.values() for p in values) >= 20 * 72 / 25.4 - .002

def test_optimal_named_shapes_also_consume_all_requested_types(tmp_path):
    source = _source(tmp_path / "named72.pdf", 72)
    request = _request(72, 0).model_copy(update={
        "path":source, "strategy":"optimal_auto", "shape_type":"RECTANGLE",
        "detected_shapes_by_page":{str(i):"RECTANGLE" for i in range(72)},
    })
    settings = settings_from_preview_request(request)
    settings["gridStrategy"] = "optimal_auto"
    with nup_sheet_plan(source, settings) as plan:
        values = plan.build_chunk_args(0, plan.total_sheets, 0)[37]
        count = Counter(p["src_page_idx"] for sheet in values.values() for p in sheet)
        assert count == {i:1 for i in range(72)}
    preview = preview_layout(request, PRO_LICENSE)
    assert preview["sheetsNeeded"] >= 8
