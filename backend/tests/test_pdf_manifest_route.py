import io
import json

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.api.routes import pdf_tools
from app.core.license_guard import require_license
from app.main import app
from app.utils import file_handler


def _pdf_bytes(page_count: int) -> bytes:
    pdf = pikepdf.Pdf.new()
    for index in range(page_count):
        page = pdf.add_blank_page(page_size=(200 + index, 300 + index))
        page.obj["/Rotate"] = index * 90
    output = io.BytesIO()
    pdf.save(output)
    return output.getvalue()


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(file_handler.settings, "UPLOAD_DIR", str(tmp_path))
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "DEV_MODE",
        "hwid": "test",
        "features": ["*"],
    }
    try:
        with TestClient(app) as test_client:
            yield test_client, tmp_path
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_manifest_route_preserves_whole_file_selection_rotation_and_blank(client):
    test_client, tmp_path = client
    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        files=[
            ("files", ("first.pdf", _pdf_bytes(3), "application/pdf")),
            ("files", ("second.pdf", _pdf_bytes(2), "application/pdf")),
        ],
        data={
            "manifest": json.dumps([
                {"file_index": 0, "rotation": 90},
                {"file_index": 1, "page_index": 1, "rotation": 180},
                {"blank": True, "rotation": 270},
            ])
        },
    )

    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(io.BytesIO(response.content)) as result:
        assert len(result.pages) == 5
        assert [int(page.obj.get("/Rotate", 0)) % 360 for page in result.pages] == [90, 180, 270, 270, 270]
        assert tuple(float(value) for value in result.pages[4].mediabox) == (0.0, 0.0, 300.0, 200.0)

    # TestClient runs the response background task before returning.
    assert list(tmp_path.iterdir()) == []


def test_manifest_route_cleans_partial_output_after_validation_error(client):
    test_client, tmp_path = client
    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        files=[("files", ("source.pdf", _pdf_bytes(1), "application/pdf"))],
        data={"manifest": json.dumps([{"file_index": 0, "page_index": 99}])},
    )

    assert response.status_code == 400
    assert list(tmp_path.iterdir()) == []



def test_manifest_route_uses_native_paths_and_returns_disk_result(client):
    test_client, tmp_path = client
    source_path = tmp_path / "native-source.pdf"
    source_path.write_bytes(_pdf_bytes(2))

    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        data={
            "manifest": json.dumps([{"file_index": 0}]),
            "file_paths": json.dumps([str(source_path)]),
            "return_path": "true",
        },
    )

    assert response.status_code == 200, response.text
    result_path = response.json()["path"]
    assert source_path.exists()
    with pikepdf.Pdf.open(result_path) as result:
        assert len(result.pages) == 2

def test_pdf_tools_rejects_unsupported_extension_before_writing(client):
    test_client, tmp_path = client
    response = test_client.post(
        "/api/pdf-tools/merge",
        files=[("files", ("payload.txt", b"not a pdf", "text/plain"))],
    )

    assert response.status_code == 415
    assert list(tmp_path.iterdir()) == []
