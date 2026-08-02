import io
import json

import pikepdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import pdf_tools
from app.core.license_guard import require_license
from app.main import app
from app.utils import file_handler
from app.workers import pdf_manifest_engine as manifest_engine


def _pdf_bytes(page_count: int) -> bytes:
    pdf = pikepdf.Pdf.new()
    for index in range(page_count):
        page = pdf.add_blank_page(page_size=(200 + index, 300 + index))
        page.obj["/Rotate"] = index * 90
    output = io.BytesIO()
    pdf.save(output)
    return output.getvalue()


def _png_bytes(size: tuple[int, int] = (20, 30), dpi: tuple[int, int] = (30, 30)) -> bytes:
    output = io.BytesIO()
    Image.new('RGB', size, 'white').save(output, format='PNG', dpi=dpi)
    return output.getvalue()


def _jpeg_bytes(size: tuple[int, int] = (30, 20), dpi: tuple[int, int] = (150, 150)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, format="JPEG", dpi=dpi)
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

def test_manifest_route_accepts_uploaded_png(client):
    test_client, tmp_path = client
    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        files=[("files", ("source.png", _png_bytes(), "image/png"))],
        data={"manifest": json.dumps([{"file_index": 0, "rotation": 90}])},
    )

    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(io.BytesIO(response.content)) as result:
        assert len(result.pages) == 1
        assert int(result.pages[0].obj.get("/Rotate", 0)) % 360 == 90
        assert float(result.pages[0].mediabox[2]) == pytest.approx(48, abs=0.1)
        assert float(result.pages[0].mediabox[3]) == pytest.approx(72, abs=0.1)

    assert list(tmp_path.iterdir()) == []


def test_manifest_route_accepts_native_png_path(client):
    test_client, tmp_path = client
    source_path = tmp_path / "native-source.png"
    source_path.write_bytes(_png_bytes())

    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        data={
            "manifest": json.dumps([{"file_index": 0}]),
            "file_paths": json.dumps([str(source_path)]),
            "return_path": "true",
        },
    )

    assert response.status_code == 200, response.text
    assert source_path.exists()
    with pikepdf.Pdf.open(response.json()["path"]) as result:
        assert len(result.pages) == 1

def test_manifest_route_accepts_uploaded_jpeg(client):
    test_client, tmp_path = client
    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        files=[("files", ("source.JPEG", _jpeg_bytes(), "image/jpeg"))],
        data={"manifest": json.dumps([{"file_index": 0}])},
    )

    assert response.status_code == 200, response.text
    with pikepdf.Pdf.open(io.BytesIO(response.content)) as result:
        assert len(result.pages) == 1
        assert float(result.pages[0].mediabox[2]) == pytest.approx(14.4, abs=0.1)
        assert float(result.pages[0].mediabox[3]) == pytest.approx(9.6, abs=0.1)

    assert list(tmp_path.iterdir()) == []


def test_manifest_route_rejects_unsupported_image_extension_before_writing(client):
    test_client, tmp_path = client
    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        files=[("files", ("source.webp", b"RIFF-not-a-supported-source", "image/webp"))],
        data={"manifest": json.dumps([{"file_index": 0}])},
    )

    assert response.status_code == 415
    assert list(tmp_path.iterdir()) == []


def test_manifest_route_rejects_native_extension_content_mismatch(client):
    test_client, tmp_path = client
    source_path = tmp_path / "spoofed.png"
    source_path.write_bytes(_jpeg_bytes())

    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        data={
            "manifest": json.dumps([{"file_index": 0}]),
            "file_paths": json.dumps([str(source_path)]),
            "return_path": "true",
        },
    )

    assert response.status_code == 400
    assert source_path.exists()
    assert not any(path.name.startswith("merged_manifest_") for path in tmp_path.iterdir())
def test_manifest_route_rejects_low_ram_expansion_and_cleans_all_artifacts(
    client,
    monkeypatch,
):
    test_client, tmp_path = client
    monkeypatch.delenv("PRYNX_MANIFEST_MAX_PAGES", raising=False)
    monkeypatch.setattr(
        manifest_engine,
        "read_memory_status_mb",
        lambda: (6 * 1024.0, 5 * 1024.0),
    )
    manifest = [{"blank": True}] * (manifest_engine.LOW_RAM_MAX_EXPANDED_PAGES + 1)

    response = test_client.post(
        "/api/pdf-tools/merge-manifest",
        files=[("files", ("source.pdf", _pdf_bytes(1), "application/pdf"))],
        data={"manifest": json.dumps(manifest)},
    )

    assert response.status_code == 400
    assert "4,000" in response.json()["detail"]
    assert list(tmp_path.iterdir()) == []
