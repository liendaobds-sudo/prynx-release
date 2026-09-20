"""BE.01/02: không công bố kế hoạch hoặc ghi tờ bị thiếu mẫu."""
from collections import Counter
import pikepdf
import pytest
from fastapi import HTTPException
from app.api.routes.imposition import preview_layout
from app.core.nesting_preview_capacity import settings_from_preview_request
from app.workers import nup_engine
from tests.license_helpers import PRO_LICENSE
from tests.test_nesting_multisheet_workflow import _request

def _oversize_source(path):
    with pikepdf.Pdf.new() as pdf:
        for w in (70, 300):
            page = pdf.add_blank_page(page_size=(w*72/25.4,70*72/25.4))
            page.Contents = pdf.make_stream(b"0 0 1 rg 0 0 100 100 re f")
        pdf.save(path)
    return str(path)

@pytest.mark.parametrize("operation", ["preview", "export"])
def test_legacy_oversize_fails_closed(tmp_path, operation):
    source = _oversize_source(tmp_path / "source.pdf")
    req = _request(2,1).model_copy(update={
        "path":source, "total_pages":2, "strategy":"optimal_auto",
        "shape_type":"RECTANGLE", "detected_shapes_by_page":{"0":"RECTANGLE","1":"RECTANGLE"},
    })
    settings = settings_from_preview_request(req)
    settings["gridStrategy"] = "optimal_auto"
    with pytest.raises((ValueError, HTTPException), match="mẫu 2"):
        if operation == "preview":
            preview_layout(req, PRO_LICENSE)
        else:
            nup_engine.run_nup_engine(source,str(tmp_path / "output.pdf"),settings)
    assert not (tmp_path / "output.pdf").exists()

def test_coverage_counts_recipe_runs_and_missing_copies():
    from app.workers.nup_order_safety import require_quantity_coverage
    require_quantity_coverage({0:2,1:1}, Counter({0:2,1:1}))
    with pytest.raises(ValueError, match="mẫu 2"):
        require_quantity_coverage({0:2,1:1}, Counter({0:2}))

def test_packer_coverage_reads_physical_runs_not_template_count():
    from app.workers.nup_order_safety import require_packer_coverage
    recipe = {"placements":[{"page_idx":0}], "sheets_needed":3}
    require_packer_coverage([(0,70,70,3)],recipe)
    with pytest.raises(ValueError, match="thiếu 1"):
        require_packer_coverage([(0,70,70,4)],recipe)
