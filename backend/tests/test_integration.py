from fastapi.testclient import TestClient
import os
import sys

import pytest

# Add backend to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.main import app
from app.core.license_guard import require_license

client = TestClient(app)


# Bypass license check for tests (Pro plan — feature gating may be on in release QA).
# QUAN TRỌNG: dùng FIXTURE có teardown, KHÔNG gán ở mức module — gán mức module chạy
# lúc pytest COLLECT nên rò license Pro sang các test kiểm chứng chuỗi license thật
# (test_free_token_e2e nhận 200 thay vì 403). Xem audit 2026-07-25.
@pytest.fixture(autouse=True)
def _license_override():
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST_LICENSE",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        yield
    finally:
        app.dependency_overrides.pop(require_license, None)

def test_health_check():
    response = client.get("/")
    assert response.status_code in [200, 404]

def test_get_pdf_meta():
    """Test get_pdf_meta endpoint integration"""
    # Create a dummy PDF first to test
    import pikepdf
    import os
    dummy_pdf_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "uploads", "test_dummy.pdf"))
    doc = pikepdf.Pdf.new()
    doc.add_blank_page(page_size=(595, 842))
    doc.save(dummy_pdf_path)
    doc.close()
    
    try:
        response = client.post("/api/imposition/pdf-meta", json={"path": dummy_pdf_path})
        assert response.status_code == 200
        data = response.json()
        assert data["page_count"] == 1
        assert "max_width_pt" in data
    finally:
        if os.path.exists(dummy_pdf_path):
            os.remove(dummy_pdf_path)

def test_api_detect_shape_invalid():
    """Test detect-shape with invalid ID"""
    response = client.post("/api/imposition/detect-shape", json={"fileId": "invalid-id"})
    assert response.status_code == 200
    data = response.json()
    assert data["success"] == False
    assert "shapes" in data
    assert data["hasValidDie"] is None

def test_start_vdp_job_invalid():
    """Test vdp generation with invalid input"""
    response = client.post("/api/vdp/generate")
    assert response.status_code == 422 # Unprocessable Entity (missing form data)

def test_pdf_tools_split_invalid():
    """Test pdf tools split endpoint"""
    response = client.post("/api/pdf-tools/split")
    assert response.status_code == 422 # missing file
