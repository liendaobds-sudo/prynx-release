import pytest
from fastapi.testclient import TestClient
import io

from app.main import app

client = TestClient(app)

def test_system_status():
    """Test the /health endpoint."""
    response = client.get("/health")
    assert response.status_code in [200, 503]
    assert "status" in response.json()

def test_missing_files_upload():
    """Test uploading without files yields 422."""
    response = client.post("/api/upload")
    assert response.status_code == 422

def test_invalid_comparison_job_payload():
    """Test that invalid payload formats are rejected by Pydantic."""
    response = client.post(
        "/api/jobs/compare",
        json={
            "file_a_id": "missing",
            "file_b_id": "missing",
            "comparison_mode": "invalid_mode_name"  # Should be 'full' or 'cmyk'
        }
    )
    assert response.status_code == 422
    assert "comparison_mode" in response.text
    
def test_valid_job_creation_fails_on_missing_db_files():
    """Test that validating file IDs prevents fake job execution."""
    response = client.post(
        "/api/jobs/compare",
        json={
            "file_a_id": "123e4567-e89b-12d3-a456-426614174000",
            "file_b_id": "123e4567-e89b-12d3-a456-426614174001",
            "comparison_mode": "cmyk",
            "tolerance": "NORMAL",
            "dpi": 150
        }
    )
    assert response.status_code == 404
    assert "Không tìm thấy file" in response.json()["detail"]


def test_compare_pixel_budget_estimate_uses_page_points_and_requested_dpi():
    from types import SimpleNamespace
    from app.api.routes.compare import _estimate_max_render_pixels

    uploaded = SimpleNamespace(
        pdf_metadata={
            "pages": [
                {"width_pt": 595.0, "height_pt": 842.0},
                {"width_pt": 300.0, "height_pt": 300.0},
            ]
        }
    )

    pixels = _estimate_max_render_pixels(uploaded, dpi=300)
    assert 8_500_000 <= pixels <= 8_800_000


def test_register_local_pdf_uses_workspace_copy_without_touching_source(tmp_path, monkeypatch):
    from pathlib import Path
    from app.api.routes import upload as upload_route
    from app.schemas.job import LocalFileUploadRequest
    from app.workers import pdf_wrapper as pdf_lib

    source = tmp_path / "large-local.pdf"
    doc = pdf_lib.open()
    doc.new_page(width=595, height=842)
    doc.save(str(source))
    doc.close()

    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(upload_route.settings, "IS_DESKTOP_APP", True)
    monkeypatch.setattr(upload_route.settings, "UPLOAD_DIR", str(upload_dir))

    class FakeDB:
        row = None

        def add(self, row):
            self.row = row

        def commit(self):
            pass

        def refresh(self, row):
            row.id = "local-file-id"

    fake_db = FakeDB()
    response = upload_route.register_local_pdf(
        LocalFileUploadRequest(file_path=str(source)),
        db=fake_db,
        license_info={},
    )

    stored = Path(fake_db.row.file_path)
    assert response.id == "local-file-id"
    assert stored.is_file()
    assert stored.parent == upload_dir
    assert source.is_file()
    assert stored.read_bytes() == source.read_bytes()
