from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_preview_layout_validation_error():
    # Attempt to send payload with an extra field not in the model
    # Because extra='forbid' is set, this should raise a 422
    payload = {
        "usable_w": 1000,
        "usable_h": 1000,
        "item_w": 100,
        "item_h": 100,
        "gap_x": 5,
        "gap_y": 5,
        "strategy": "simple_auto",
        "bogus_extra_field": "should_fail"
    }
    
    response = client.post("/api/imposition/preview-layout", json=payload)
    assert response.status_code == 422, "Expected 422 Unprocessable Entity due to extra='forbid'"
    assert "bogus_extra_field" in response.text
