from io import BytesIO

import cv2
import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def _scan_pdf_bytes() -> bytes:
    from reportlab.pdfgen import canvas

    output = BytesIO()
    writer = canvas.Canvas(output, pagesize=(180, 120))
    writer.setFillColorRGB(0.72, 0.72, 0.72)
    writer.rect(0, 0, 180, 120, fill=1, stroke=0)
    writer.setFillColorRGB(0.1, 0.1, 0.1)
    writer.drawString(20, 60, "SCAN")
    writer.showPage()
    writer.save()
    return output.getvalue()


def _card_bytes() -> bytes:
    card = np.full((220, 350, 3), 242, dtype=np.uint8)
    cv2.rectangle(card, (20, 20), (330, 200), (205, 228, 245), -1)
    cv2.putText(card, "CARD", (105, 120), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (20, 30, 40), 3)
    source = np.float32([[0, 0], [349, 0], [349, 219], [0, 219]])
    destination = np.float32([[70, 60], [450, 30], [420, 330], [40, 300]])
    matrix = cv2.getPerspectiveTransform(source, destination)
    canvas = cv2.warpPerspective(
        card,
        matrix,
        (500, 380),
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(45, 60, 55),
    )
    output = BytesIO()
    Image.fromarray(canvas).save(output, format="PNG")
    return output.getvalue()


def _post_file(client: TestClient, path: str, data: dict[str, str] | None = None):
    return client.post(
        path,
        files={"file": ("the.png", _card_bytes(), "image/png")},
        data=data or {},
    )


def test_detect_card_returns_editable_normalized_quad(monkeypatch):
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    with TestClient(app) as client:
        response = _post_file(
            client,
            "/api/document-cleanup/detect-card",
            {"use_ai": "false"},
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["points"]) == 4
    assert payload["confidence"] >= 0.7
    assert all(0 <= point[axis] <= 1 for point in payload["points"] for axis in ("x", "y"))


def test_card_process_emits_id1_png_at_300_dpi(monkeypatch):
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    with TestClient(app) as client:
        response = _post_file(
            client,
            "/api/document-cleanup/process",
            {
                "operation": "card",
                "card_ratio": "id1",
                "output_dpi": "300",
                "use_ai": "false",
            },
        )

    assert response.status_code == 200, response.text
    assert response.headers["X-Document-Cleanup-Operation"] == "card"
    with Image.open(BytesIO(response.content)) as result:
        assert abs(result.width - round(85.6 * 300 / 25.4)) <= 1
        assert abs(result.height - round(53.98 * 300 / 25.4)) <= 1
        assert abs(result.info["dpi"][0] - 300) < 0.01


def test_scan_process_preserves_color_mode(monkeypatch):
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    with TestClient(app) as client:
        response = _post_file(
            client,
            "/api/document-cleanup/process",
            {
                "operation": "scan",
                "scan_mode": "color",
                "deskew": "false",
            },
        )

    assert response.status_code == 200, response.text
    assert response.headers["X-Document-Cleanup-Operation"] == "scan"
    with Image.open(BytesIO(response.content)) as result:
        assert result.mode == "RGB"


def test_rejects_invalid_manual_quad(monkeypatch):
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    with TestClient(app) as client:
        response = _post_file(
            client,
            "/api/document-cleanup/process",
            {"operation": "card", "points_json": '[{"x":2,"y":0}]'},
        )

    assert response.status_code == 422
    assert "Bốn góc" in response.json()["detail"]


def test_scan_process_accepts_multi_page_pdf(monkeypatch):
    import pypdfium2 as pdfium

    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    job_id = "cleanup-api-test-001"
    with TestClient(app) as client:
        response = client.post(
            "/api/document-cleanup/process",
            files={"file": ("tai_lieu.pdf", _scan_pdf_bytes(), "application/pdf")},
            data={
                "operation": "scan",
                "scan_mode": "gray",
                "deskew": "false",
                "output_dpi": "144",
                "job_id": job_id,
            },
        )
        progress_response = client.get(f"/api/document-cleanup/jobs/{job_id}")

    assert response.status_code == 200, response.text
    assert progress_response.status_code == 200, progress_response.text
    assert progress_response.json() == {
        "job_id": job_id,
        "current": 1,
        "total": 1,
        "phase": "complete",
        "terminal": True,
        "cancelled": False,
        "progress": 1.0,
    }
    assert response.headers["content-type"].startswith("application/pdf")
    result = pdfium.PdfDocument(response.content)
    try:
        assert len(result) == 1
        assert np.allclose(result[0].get_size(), (180, 120), atol=0.1)
    finally:
        result.close()


def test_cancel_unknown_cleanup_job_returns_404(monkeypatch):
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    with TestClient(app) as client:
        response = client.post("/api/document-cleanup/jobs/missing-job-001/cancel")

    assert response.status_code == 404


def test_unicode_source_name_does_not_break_download_header(monkeypatch):
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", False)
    with TestClient(app) as client:
        response = client.post(
            "/api/document-cleanup/process",
            files={"file": ("tài liệu quét.png", _card_bytes(), "image/png")},
            data={"operation": "scan", "scan_mode": "color", "deskew": "false"},
        )

    assert response.status_code == 200, response.text
    disposition = response.headers["content-disposition"]
    assert "filename*=UTF-8''" in disposition
    assert "t%C3%A0i%20li%E1%BB%87u" in disposition
