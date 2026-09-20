"""BE.04/05: số 0 tường minh và cách ráp không hỗ trợ được giữ đúng ở biên."""
import pytest
from fastapi import HTTPException
from app.api.routes.imposition import preview_layout
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine, nup_true_shape_nesting
from app.workers.sticker_nup_policy import sticker_order_quantities
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _source, _request

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
