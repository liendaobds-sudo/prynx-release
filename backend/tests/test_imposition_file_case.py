import asyncio
import io

from fastapi import UploadFile
from starlette.responses import FileResponse

from app.api.routes import imposition
from app.core.plan_executor import PlanExecutor


def test_execute_plan_accepts_uppercase_pdf_extension(monkeypatch, tmp_path):
    output_path = tmp_path / "output.pdf"
    output_path.write_bytes(b"%PDF-test")

    async def fake_execute(_plan, source_path):
        assert source_path.lower().endswith("_plan_input.pdf")
        return str(output_path)

    monkeypatch.setattr(imposition, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(PlanExecutor, "execute", fake_execute)
    upload = UploadFile(filename="FILE.PDF", file=io.BytesIO(b"%PDF-source"))

    response = asyncio.run(imposition.execute_plan_imposition(upload, "{}", {}))

    assert isinstance(response, FileResponse)
    assert response.filename == "imposed_FILE.PDF"
