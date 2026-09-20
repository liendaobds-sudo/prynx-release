"""BE.06: N-Up một loại dùng cùng lượng và hình học ở preview/PDF."""
import pikepdf
import pytest
from app.api.routes.imposition import preview_layout
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine
from app.workers.nup_sheet_render import nup_sheet_plan
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _source,_request

@pytest.mark.parametrize("quantity",[0,1,2,30])
def test_single_optimal_nup_preserves_exact_quantity(tmp_path, quantity):
    source=_source(tmp_path/"source.pdf",1)
    req=_request(1,quantity).model_copy(update={
        "path":source,"total_pages":1,"strategy":"optimal_auto","shape_type":"RECTANGLE",
        "detected_shapes_by_page":{"0":"RECTANGLE"},
    })
    preview=preview_layout(req,PRO_LICENSE)
    assert preview["strategyUsed"]=="optimal_auto"
    assert sum(len(s["cells"])*s["runCount"] for s in preview["sheets"])==(quantity or 1)
    settings=settings_from_preview_request(req)
    settings["gridStrategy"]="optimal_auto"
    with nup_sheet_plan(source,settings) as plan:
        placed=plan.build_chunk_args(0,plan.total_sheets,0)[37]
        assert len(placed)==len(preview["sheets"])
        for i,sheet in enumerate(preview["sheets"]):
            for actual,expected in zip(placed[i],sheet["cells"]):
                assert actual["abs_x"]==pytest.approx(expected["absX"],abs=.002)
                assert actual["abs_y"]==pytest.approx(expected["absY"],abs=.002)
    output=tmp_path/"output.pdf"
    nup_engine.run_nup_engine(source,str(output),settings)
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages)==len(preview["sheets"])*2
        assert [sum(str(op.operator)=="Do" for op in pikepdf.parse_content_stream(p))
                for p in list(pdf.pages)[::2]]==[len(s["cells"]) for s in preview["sheets"]]
