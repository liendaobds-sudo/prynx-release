"""M72: preview, native và writer thật cùng dùng đủ các bố cục của đơn hàng."""
from collections import Counter
from types import SimpleNamespace
from pathlib import Path

import pikepdf
import pytest

from app.api.routes.imposition import PreviewLayoutRequest
from app.core.nesting_preview_capacity import build_nesting_preview, settings_from_preview_request
from app.core.nesting_preview_session import get_preview_session_store, reset_preview_session_store
from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job, run_true_shape_nesting
from app.workers.nesting_imposition_render import production_sheet_recipes

MM = 72 / 25.4


def test_impossible_single_sheet_has_actionable_message():
    from app.core.nesting_production_pipeline import _assert_order_area_feasible
    polygon = SimpleNamespace(outer=((0, 0), (70, 0), (70, 70), (0, 70)))
    job = SimpleNamespace(
        tool="sticker_imposer", layout_intent="autofill_single_sheet",
        sheet_width_mm=320, sheet_height_mm=430,
        margin_mm={"left": 5, "right": 5, "top": 5, "bottom": 5},
        parts=list(range(72)), placement_zones=(),
    )
    footprints = {str(i): polygon for i in range(72)}
    with pytest.raises(ValueError, match="72 mẫu.*Dàn nhiều mẫu"):
        _assert_order_area_feasible(job, footprints)
    job.layout_intent = "quantity_fulfillment"
    _assert_order_area_feasible(job, footprints)


def test_impossible_equal_area_zone_suggests_free_gang():
    from app.core.nesting_production_pipeline import _assert_order_area_feasible
    job = SimpleNamespace(
        tool="sticker_imposer", layout_intent="quantity_fulfillment",
        sheet_width_mm=320, sheet_height_mm=430, margin_mm={},
        parts=[0], placement_zones=(SimpleNamespace(
            part_id="p", bounds=SimpleNamespace(min_x_mm=0, min_y_mm=0, max_x_mm=320, max_y_mm=5),
        ),),
    )
    polygon = SimpleNamespace(outer=((0, 0), (70, 0), (70, 70), (0, 70)))
    with pytest.raises(ValueError, match="Chia đều diện tích.*Xếp tự do"):
        _assert_order_area_feasible(job, {"p": polygon})


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("PRYNX_TRUE_SHAPE_NESTING_ENABLED", "true")
    reset_preview_session_store()
    yield
    reset_preview_session_store()


def _source(path: Path, count: int):
    with pikepdf.Pdf.new() as pdf:
        for _ in range(count):
            page = pdf.add_blank_page(page_size=(70 * MM, 70 * MM))
            page.Contents = pdf.make_stream(
                f"q 0.2 0.1 0 0 k 0 0 {70*MM} {70*MM} re f Q\n"
                f"q 0 1 0 0 K 0.5 w 0 0 {70*MM} {70*MM} re S Q\n".encode()
            )
        pdf.save(path)
    return str(path)


def _request(count, quantity):
    # Vùng 216 x 216: đủ 9 footprint ~70 mm có hở 2 mm, không đủ diện tích cho con thứ 10.
    return PreviewLayoutRequest(
        usable_w=216*MM, usable_h=216*MM, sheet_w=226*MM, sheet_h=226*MM,
        margin_left=5*MM, margin_right=5*MM, margin_top=5*MM, margin_bottom=5*MM,
        item_w=70*MM, item_h=70*MM, gap_x=2*MM, gap_y=2*MM, bleed=0,
        strategy="true_shape_nesting", task_mode="nup", layout_type="sequential",
        is_die_cut=True, grouping_strategy="free_gang", target_quantity=quantity,
        detected_shapes_by_page={str(i): "CUSTOM" for i in range(count)},
        pont_type="none", separate_cut_page=True, export_unique_sheets=True,
    )


@pytest.mark.parametrize("count,quantity,templates,physical", [(72,1,8,8),(72,100,8,800),(73,1,9,9)])
def test_all_designs_preview_unique_export_and_repeat_counts(tmp_path, count, quantity, templates, physical):
    source = _source(tmp_path / "72-khuon.pdf", count)
    request = _request(count, quantity)
    preview = build_nesting_preview(request, source_path=source)
    assert preview["orderSummary"] == {
        "templateCount": templates, "physicalSheetCount": physical,
        "requestedCount": count*quantity, "placedCount": count*quantity,
    }
    assert len(preview["sheets"]) == templates
    assert preview["sheetsNeeded"] == physical
    assert preview["totalItems"] == len(preview["cells"]) == 9
    produced = Counter()
    for sheet in preview["sheets"]:
        for cell in sheet["cells"]:
            produced[cell["pageIdx"]] += sheet["runCount"]
    assert produced == {i: quantity for i in range(count)}

    settings = settings_from_preview_request(request)
    job = build_true_shape_nesting_job(source, settings)
    session = get_preview_session_store().peek(job)
    assert session is not None
    manifest = session.solved.manifest
    assert not manifest["unplaced"]
    assert manifest["validation"]["valid"] is True
    recipes = production_sheet_recipes(
        manifest, render_bundle=session.solved.production_request.render_bundle,
        render_bundle_hash=session.solved.production_request.render_bundle_hash,
    )
    assert len(recipes) == templates
    assert sum(runs for _, runs in recipes) == physical

    output = tmp_path / "print-cut.pdf"
    report = run_true_shape_nesting(source, str(output), settings)
    assert f"Số bố cục khác nhau: {templates}" in report
    assert f"Số tờ cần in: {physical}" in report
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == templates * 2
    assert get_preview_session_store().peek(job).solved.manifest["manifestId"] == manifest["manifestId"]

def test_expanded_pdf_matches_physical_sheet_count(tmp_path):
    source = _source(tmp_path / "18-khuon.pdf", 18)
    request = _request(18, 2).model_copy(update={"export_unique_sheets": False})
    preview = build_nesting_preview(request, source_path=source)
    # Bộ tối ưu có thể chọn các pose khác nhau trên 4 tờ. Ca này kiểm chế độ
    # expanded, không ép số recipe; ca 72 x 100 bên trên khóa 8 recipe x 100.
    assert 2 <= preview["orderSummary"]["templateCount"] <= 4
    assert preview["orderSummary"]["physicalSheetCount"] == 4
    assert sum(sheet["runCount"] for sheet in preview["sheets"]) == 4
    output = tmp_path / "all-physical-sheets.pdf"
    run_true_shape_nesting(source, str(output), settings_from_preview_request(request))
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 8
        print_counts = [
            sum(str(op.operator) == "Do" for op in pikepdf.parse_content_stream(pdf.pages[i]))
            for i in range(0, 8, 2)
        ]
    assert print_counts == [9, 9, 9, 9]


def test_unequal_design_quantities_are_not_overprinted(tmp_path):
    source = _source(tmp_path / "unequal.pdf", 3)
    request = _request(3, 0).model_copy(update={
        "target_quantities_by_page": {"0": 10, "1": 20, "2": 30},
    })
    preview = build_nesting_preview(request, source_path=source)
    produced = Counter()
    for sheet in preview["sheets"]:
        for cell in sheet["cells"]:
            produced[cell["pageIdx"]] += sheet["runCount"]
    assert produced == {0: 10, 1: 20, 2: 30}
    assert preview["orderSummary"]["placedCount"] == 60
    assert preview["orderSummary"]["physicalSheetCount"] == 7


def test_zero_overrides_do_not_switch_fulfillment_into_autofill(tmp_path):
    source = _source(tmp_path / "zero.pdf", 2)
    request = _request(2, 1).model_copy(update={"target_quantities_by_page": {"0": 0, "1": 0}})
    with pytest.raises(ValueError, match="Không có mẫu nào"):
        build_nesting_preview(request, source_path=source)
