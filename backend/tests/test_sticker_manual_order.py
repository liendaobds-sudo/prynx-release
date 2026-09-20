"""BE.03/08: lưới thủ công phải tuân theo hàng/cột và số lần in."""
import pikepdf
import pytest
from fastapi import HTTPException
from app.api.routes.imposition import preview_layout
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _source,_request

@pytest.mark.parametrize("repeat,unique,pages,quantity,counts",[
    (False,True,10,1,[4,4,2]), (True,True,1,12,[4]), (True,False,1,12,[4,4,4]),
])
def test_manual_two_by_two_preview_and_pdf(tmp_path, repeat, unique, pages, quantity, counts):
    source=_source(tmp_path/"source.pdf",pages)
    req=_request(pages,quantity).model_copy(update={
        "path":source,"total_pages":pages,"strategy":"manual","cols":2,"rows":2,
        "task_mode":"step_repeat" if repeat else "nup","layout_type":"repeat" if repeat else "sequential",
        "export_unique_sheets":unique,
    })
    preview=preview_layout(req,PRO_LICENSE)
    assert preview["strategyUsed"]=="manual"
    assert all(len(s["cells"]) <=4 for s in preview["sheets"])
    settings=settings_from_preview_request(req)
    settings.update(gridStrategy="manual",cols=2,rows=2)
    output=tmp_path/"out.pdf"
    nup_engine.run_nup_engine(source,str(output),settings)
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages)==2*len(counts)
        assert [sum(str(op.operator)=="Do" for op in pikepdf.parse_content_stream(p))
                for p in list(pdf.pages)[::2]]==counts

def test_manual_grid_cannot_silently_overflow(tmp_path):
    source=_source(tmp_path/"source.pdf",2)
    req=_request(2,1).model_copy(update={"path":source,"total_pages":2,"strategy":"manual","cols":4,"rows":2})
    with pytest.raises(HTTPException,match="vượt vùng giấy"):
        preview_layout(req,PRO_LICENSE)

def test_manual_shared_master_registers_artwork_not_just_cut(tmp_path):
    from tests.test_sticker_homogeneous_render import _make_homogeneous_pdf, _raster
    source=str(tmp_path/"shared.pdf")
    _make_homogeneous_pdf(source)
    output=tmp_path/"out.pdf"
    settings={
        "isDieCutMode":True,"taskMode":"nup","layoutType":"sequential",
        "gridStrategy":"manual","cols":2,"rows":2,"sheetWidth":200,"sheetHeight":200,
        "targetQuantity":1,"gapX":0,"gapY":0,"pontType":"none","separateCutPage":True,
    }
    nup_engine.run_nup_engine(source,str(output),settings)
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages)==2
    pixels=_raster(str(output))
    black=(pixels[:,:,:3] < 100).all(axis=2).mean()
    assert abs(black-3*80*80/(200*2.83465)**2)<.005

def test_manual_repeat_tracks_virtual_thumbnail_pages(tmp_path):
    source=_source(tmp_path/"source.pdf",1)
    req=_request(3,1).model_copy(update={
        "path":source,"total_pages":3,"strategy":"manual","cols":2,"rows":2,
        "task_mode":"step_repeat","layout_type":"repeat",
    })
    result=preview_layout(req,PRO_LICENSE)
    assert [s["cells"][0]["pageIdx"] for s in result["sheets"]]==[0,1,2]
    assert result["sheetsNeeded"]==3

def test_manual_repeat_keeps_shared_master_size_and_registration(tmp_path):
    from tests.test_sticker_homogeneous_render import _make_homogeneous_pdf, _raster
    source=str(tmp_path/"shared.pdf")
    _make_homogeneous_pdf(source)
    output=tmp_path/"out.pdf"
    nup_engine.run_nup_engine(source,str(output),{
        "isDieCutMode":True,"taskMode":"step_repeat","layoutType":"repeat",
        "gridStrategy":"manual","cols":2,"rows":2,"sheetWidth":200,"sheetHeight":200,
        "targetQuantity":4,"gapX":0,"gapY":0,"pontType":"none","separateCutPage":True,
    })
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages)==5
    pixels=_raster(str(output),1)
    black=(pixels[:,:,:3] < 100).all(axis=2).mean()
    assert abs(black-4*80*80/(200*2.83465)**2)<.005
