"""BE.07/08: đếm bản thật, tờ bù và số lần in ở PDF cuối."""
import re
import pikepdf
import pytest
from pypdf import PdfReader
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine
from tests.test_nesting_multisheet_workflow import _source,_request
from tests.test_cut_stacks_fill_sheet import _settings as page_settings

@pytest.mark.parametrize("unique,expected_counts",[(True,[9,3]),(False,[9,9,9,3])])
def test_grid_report_matches_actual_recipes(tmp_path, unique, expected_counts):
    source=_source(tmp_path/"source.pdf",1)
    req=_request(1,30).model_copy(update={"strategy":"simple_auto","export_unique_sheets":unique})
    settings=settings_from_preview_request(req)
    settings.update(gridStrategy="simple_auto",reportDisplay={"enabled":True})
    out=tmp_path/"out.pdf"
    report=nup_engine.run_nup_engine(source,str(out),settings)
    with pikepdf.Pdf.open(out) as pdf:
        assert len(pdf.pages)==len(expected_counts)*2
        assert [sum(str(op.operator)=="Do" and str(op.operands[0]).startswith("/NupXo")
                    for op in pikepdf.parse_content_stream(p)) for p in list(pdf.pages)[::2]]==expected_counts
    texts=[p.extract_text() or "" for p in PdfReader(out).pages][::2]
    assert sum(int(re.search(r"SL thực: (\d+)",t).group(1)) for t in texts)==30
    assert "SL/tờ: 3" in texts[-1]
    assert "Yêu cầu: 30" in report and "Đã xếp: 30" in report

def test_cut_stack_ignores_stale_quantity_in_report(tmp_path):
    source=_source(tmp_path/"source.pdf",70)
    settings=page_settings()
    settings["reportDisplay"]={"enabled":True}
    out=tmp_path/"out.pdf"
    report=nup_engine.run_nup_engine(source,str(out),settings)
    assert "7000" not in report
    assert "Yêu cầu: 70" in report
    assert "Đã xếp: 80" in report
    assert "In bù: 10" in report
    texts=[p.extract_text() or "" for p in PdfReader(out).pages][::2]
    assert len(texts)==4
    assert all("SL/tờ: 20" in t for t in texts)
    assert sum(int(re.search(r"SL thực: (\d+)",t).group(1)) for t in texts)==80
