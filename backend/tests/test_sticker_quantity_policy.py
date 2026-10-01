"""BE.04/05: số 0 tường minh và cách ráp không hỗ trợ được giữ đúng ở biên."""
import pytest
from fastapi import HTTPException
from app.api.routes.imposition import preview_layout
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine, nup_true_shape_nesting
from app.workers.sticker_nup_policy import sticker_order_quantities
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _source, _request, MM

@pytest.mark.parametrize("blank", [None, "", 0])
def test_blank_global_does_not_turn_explicit_zero_into_one(blank):
    assert sticker_order_quantities(range(3),{"targetQuantity":blank,"targetQuantitiesByPage":{"0":0}})=={1:1,2:1}
    with pytest.raises(ValueError,match="Không có mẫu"):
        sticker_order_quantities(range(2),{"targetQuantity":blank,"targetQuantitiesByPage":{"0":0,"1":0}})

def test_zero_preview_and_true_shape_use_same_active_types(tmp_path):
    source=_source(tmp_path/"source.pdf",3)
    req=_request(3,0).model_copy(update={"path":source,"total_pages":3,"strategy":"simple_auto","target_quantities_by_page":{"0":0}})
    result=preview_layout(req,PRO_LICENSE)
    assert result["placedByPage"]=={"1":1,"2":1}
    job=nup_true_shape_nesting.build_true_shape_nesting_job(source,settings_from_preview_request(req))
    assert [(part.page_index,part.quantity) for part in job.parts]==[(1,1),(2,1)]

@pytest.mark.parametrize("layout",["cut_stacks","ratio_stack"])
def test_sticker_backend_rejects_hidden_stack_layout(tmp_path, layout):
    source=_source(tmp_path/"source.pdf",2)
    req=_request(2,100).model_copy(update={"path":source,"layout_type":layout,"strategy":"simple_auto"})
    with pytest.raises(HTTPException,match="Nguyên tấm"):
        preview_layout(req,PRO_LICENSE)
    settings=settings_from_preview_request(req)
    settings["gridStrategy"]="simple_auto"
    with pytest.raises(ValueError,match="Nguyên tấm"):
        nup_engine.run_nup_engine(source,str(tmp_path/"out.pdf"),settings)

def test_sticker_nup_blank_quantity_gives_one_copy_per_design(tmp_path):
    """Trống SL trong Dàn nhiều mẫu = 1 mẫu mỗi loại, không nhân x2."""
    source = _source(tmp_path / "source13.pdf", 13)
    req = _request(13, 0).model_copy(update={
        "path": source,
        "total_pages": 13,
        "strategy": "simple_auto",
        "target_quantity": 0,
        "target_quantities_by_page": {},
        "grouping_strategy": "free_gang",
    })
    result = preview_layout(req, PRO_LICENSE)
    assert result["placedByPage"] == {str(i): 1 for i in range(13)}


def test_sticker_nup_blank_quantity_with_optimal_grouping_still_needs_toggle(tmp_path):
    """Preset Xếp tối ưu không được tự bật lấp đầy khi công tắc đang tắt."""
    source = _source(tmp_path / "source13_optimal.pdf", 13)
    req = _request(13, 0).model_copy(update={
        "path": source,
        "total_pages": 13,
        "strategy": "simple_auto",
        "target_quantity": 0,
        "target_quantities_by_page": {},
        "grouping_strategy": "maximize_area",
        "auto_fill": False,
    })
    result = preview_layout(req, PRO_LICENSE)
    assert result["placedByPage"] == {str(i): 1 for i in range(13)}


def test_sticker_nup_autofill_duplicates_to_fill_full_sheet(tmp_path):
    """Khi bật Tự lấp đầy và để trống SL: các mẫu tự nhân bản để lấp kín tờ in."""
    source = _source(tmp_path / "source13_af.pdf", 13)
    req = _request(13, 0).model_copy(update={
        "path": source,
        "total_pages": 13,
        "strategy": "simple_auto",
        "target_quantity": 0,
        "target_quantities_by_page": {},
        "grouping_strategy": "free_gang",
        "auto_fill": True,
    })
    result = preview_layout(req, PRO_LICENSE)
    placed_total = sum(result["placedByPage"].values())
    expected_total = result["capacity"] * result["sheetsNeeded"]
    assert placed_total == expected_total, f"Phải lấp kín mọi tờ ({expected_total} tem), nhận {placed_total}"
    assert placed_total > 13, "Phải nhân bản thêm tem so với 13 mẫu gốc"
    assert all(count >= 1 for count in result["placedByPage"].values()), "Mọi mẫu đều phải có mặt trên tờ"


def test_sticker_nup_autofill_multi_sheet_fills_last_sheet_remainder(tmp_path):
    """Khi có SL (100 tem) và tờ chứa được 8 tem: tắt tự lấp đầy thì tờ cuối 4 tem; bật thì tờ cuối đủ 8 tem."""
    source = _source(tmp_path / "source1_100.pdf", 1)
    # Tắt tự lấp đầy: 100 tem / 8 tem mỗi tờ = 12 tờ x 8 + 1 tờ x 4 tem = 13 tờ, tờ cuối 4 tem
    req_off = _request(1, 100).model_copy(update={
        "path": source,
        "total_pages": 1,
        "strategy": "simple_auto",
        "target_quantity": 100,
        "sheet_w": 200 * MM, "sheet_h": 300 * MM,
        "usable_w": 190 * MM, "usable_h": 290 * MM,
        "margin_left": 5 * MM, "margin_right": 5 * MM, "margin_top": 5 * MM, "margin_bottom": 5 * MM,
        "gap_x": 2 * MM, "gap_y": 2 * MM,
        "auto_fill": False,
    })
    result_off = preview_layout(req_off, PRO_LICENSE)
    assert result_off["capacity"] == 8
    assert result_off["sheetsNeeded"] == 13
    assert result_off["orderSummary"]["placedCount"] == 100
    last_sheet_off = len(result_off["sheets"][-1]["cells"])
    assert last_sheet_off == 4, f"Tờ 13 khi tắt tự lấp đầy phải có 4 tem, nhận {last_sheet_off}"

    # Bật tự lấp đầy: 100 tem / 8 tem mỗi tờ -> tờ 13 tự nhân bản thêm 4 tem để đủ 8 tem = 104 tem
    req_on = _request(1, 100).model_copy(update={
        "path": source,
        "total_pages": 1,
        "strategy": "simple_auto",
        "target_quantity": 100,
        "sheet_w": 200 * MM, "sheet_h": 300 * MM,
        "usable_w": 190 * MM, "usable_h": 290 * MM,
        "margin_left": 5 * MM, "margin_right": 5 * MM, "margin_top": 5 * MM, "margin_bottom": 5 * MM,
        "gap_x": 2 * MM, "gap_y": 2 * MM,
        "auto_fill": True,
    })
    result_on = preview_layout(req_on, PRO_LICENSE)
    assert result_on["capacity"] == 8
    assert result_on["sheetsNeeded"] == 13
    assert result_on["orderSummary"]["placedCount"] == 104
    last_sheet_on = len(result_on["sheets"][-1]["cells"])
    assert last_sheet_on == 8, f"Tờ 13 khi bật tự lấp đầy phải đầy 8 tem, nhận {last_sheet_on}"
