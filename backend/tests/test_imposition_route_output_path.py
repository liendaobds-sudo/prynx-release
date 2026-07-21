import asyncio
import os

from app.api.routes.imposition import execute_plan_json
from app.core.plan_executor import PlanExecutor


def test_execute_plan_json_can_return_native_output_path(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF\n")
    output = tmp_path / "results" / "imposed.pdf"
    output.parent.mkdir()
    output.write_bytes(b"%PDF-1.4\n%%EOF\n")

    async def fake_execute(plan, source_override):
        assert source_override == os.path.abspath(source)
        return str(output)

    monkeypatch.setattr(PlanExecutor, "execute", fake_execute)
    result = asyncio.run(execute_plan_json({
        "plan": {"source_pdf_path": str(source)},
        "source_pdf_path": str(source),
        "return_output_path": True,
    }, license_info={}))

    assert result == {
        "success": True,
        "output_path": os.path.abspath(output),
        "output_filename": "imposed.pdf",
    }
