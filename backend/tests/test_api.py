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
