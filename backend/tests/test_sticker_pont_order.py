"""BE.01: tránh boong trước khi chia tờ, writer không tự đổi danh sách mẫu."""
from collections import Counter
import pikepdf
import pytest
from app.api.routes.imposition import preview_layout
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine, pont_collision
from app.workers.nup_sheet_render import nup_sheet_plan
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _source, _request

@pytest.mark.parametrize("strategy", ["simple_auto","manual","optimal_auto"])
@pytest.mark.parametrize("layout", ["sequential","cut_stacks"])
def test_page_sheet_keeps_every_type_around_ponts(tmp_path, monkeypatch, strategy, layout):
    source = _source(tmp_path/"source.pdf",9)
    req = _request(9,1).model_copy(update={
        "path":source,"total_pages":9,"strategy":strategy,"cols":3,"rows":3,
        "layout_type":layout,"is_die_cut":False,"page_sheet_mode":True,
        "pont_type":"5mm","pont_config":{
            "shape":"circle","size":5,"thickness":.5,"disableCollision":False,
            "marginTop":7,"marginBottom":7,"marginLeft":7,"marginRight":7,
        },
    })
    settings = settings_from_preview_request(req)
    settings.update(gridStrategy=strategy,cols=3,rows=3)
    preview = preview_layout(req,PRO_LICENSE)
    sheets = preview["sheets"]
    assert [len(s["cells"]) for s in sheets] == ([5,5] if layout=="cut_stacks" else [5,4])
    with nup_sheet_plan(source,settings) as plan:
        placements=plan.build_chunk_args(0,plan.total_sheets,0)[37]
        for index,sheet in enumerate(sheets):
            for actual,expected in zip(placements[index],sheet["cells"]):
                assert actual["src_page_idx"] == expected["pageIdx"]
                assert actual["abs_x"] == pytest.approx(expected["absX"],abs=.002)
                assert actual["abs_y"] == pytest.approx(expected["absY"],abs=.002)
        counts=Counter(p["src_page_idx"] for ps in placements.values() for p in ps)
        assert set(counts)==set(range(9))
        assert sum(counts.values())==(10 if layout=="cut_stacks" else 9)
    def forbidden(*args,**kwargs):
        raise AssertionError("Không được reflow/bỏ mẫu ở writer sau khi đã chốt plan")
    monkeypatch.setattr(pont_collision,"smart_resolve_collisions",forbidden)
    output=tmp_path/"output.pdf"
    nup_engine.run_nup_engine(source,str(output),settings)
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages)==4
        assert [sum(str(op.operator)=="Do" for op in pikepdf.parse_content_stream(p))
                for p in list(pdf.pages)[::2]] == [len(s["cells"]) for s in sheets]
