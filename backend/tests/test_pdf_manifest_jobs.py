"""Lifecycle job cho Combine manifest: progress, hủy, kết quả và cleanup."""
from __future__ import annotations

import io
import json
import threading
import time
from contextlib import nullcontext
from pathlib import Path

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.api.routes import combine_jobs as combine_route
from app.api.routes import pdf_tools
from app.core.combine_jobs import CombineJobQueueFull, CombineJobRegistry
from app.core.license_guard import require_license
from app.main import app
from app.utils import file_handler
from app.workers import pdf_manifest_engine as manifest_engine


def _pdf_bytes(page_count: int = 2, *, width_base: int = 200) -> bytes:
    output = io.BytesIO()
    with pikepdf.Pdf.new() as pdf:
        for index in range(page_count):
            pdf.add_blank_page(page_size=(width_base + index, 300 + index))
        pdf.save(output)
    return output.getvalue()


def _wait_for_status(client: TestClient, job_id: str, expected: set[str], timeout: float = 2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in expected:
            return payload
        time.sleep(0.01)
    raise AssertionError(f"Job {job_id} không tới trạng thái {expected}")


@pytest.fixture
def job_client(monkeypatch, tmp_path):
    registry = CombineJobRegistry(
        max_workers=1,
        max_queued=3,
        ttl_seconds=60,
        slot_factory=lambda: nullcontext(),
    )
    monkeypatch.setattr(combine_route, "combine_jobs", registry)
    monkeypatch.setattr(combine_route, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(file_handler.settings, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args, **_kwargs: None)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "DEV_MODE",
        "hwid": "test",
        "features": ["*"],
    }
    try:
        with TestClient(app) as client:
            yield client, registry, tmp_path
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def _start_uploaded_job(client: TestClient, *, return_path: bool = False):
    return client.post(
        "/api/pdf-tools/merge-manifest/jobs",
        files=[("files", ("source.pdf", _pdf_bytes(), "application/pdf"))],
        data={
            "manifest": json.dumps([{"file_index": 0}]),
            "return_path": str(return_path).lower(),
        },
    )

@pytest.mark.parametrize(
    ("mode", "expected_widths"),
    [
        ("merge_files", [100.0, 101.0, 102.0, 400.0, 401.0]),
        ("interleave", [100.0, 400.0, 101.0, 401.0, 102.0]),
    ],
)
def test_legacy_job_modes_keep_order_and_return_native_path(
    job_client,
    mode,
    expected_widths,
):
    client, _registry, _tmp_path = job_client
    response = client.post(
        "/api/pdf-tools/merge-manifest/jobs",
        files=[
            ("files", ("a.pdf", _pdf_bytes(3, width_base=100), "application/pdf")),
            ("files", ("b.pdf", _pdf_bytes(2, width_base=400), "application/pdf")),
        ],
        data={"mode": mode, "return_path": "true"},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    assert _wait_for_status(client, job_id, {"completed"})["terminal"] is True

    result = client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/result")
    assert result.status_code == 200, result.text
    with pikepdf.Pdf.open(result.json()["path"]) as pdf:
        widths = [float(page.mediabox[2] - page.mediabox[0]) for page in pdf.pages]
    assert widths == expected_widths


def test_legacy_job_mode_rejects_image_and_cleans_upload(job_client):
    client, _registry, tmp_path = job_client
    response = client.post(
        "/api/pdf-tools/merge-manifest/jobs",
        files=[("files", ("image.png", b"\x89PNG\r\n\x1a\nfixture", "image/png"))],
        data={"mode": "merge_files"},
    )
    assert response.status_code == 415
    assert list(tmp_path.iterdir()) == []

def test_job_reports_progress_keeps_health_responsive_and_cancels_cleanly(
    job_client,
    monkeypatch,
):
    client, _registry, tmp_path = job_client
    started = threading.Event()
    release = threading.Event()

    def blocking_merge(
        _file_paths,
        _manifest,
        _output_path,
        *,
        progress_callback=None,
        cancel_check=None,
        source_completed_callback=None,
    ):
        progress_callback("merging", 1, 4)
        source_completed_callback(0)
        started.set()
        while not release.wait(0.01):
            if cancel_check():
                raise manifest_engine.ManifestJobCancelled("Đã hủy ghép PDF")

    monkeypatch.setattr(manifest_engine, "merge_manifest", blocking_merge)

    before = time.monotonic()
    response = _start_uploaded_job(client)
    assert response.status_code == 202, response.text
    assert time.monotonic() - before < 0.5
    job_id = response.json()["job_id"]
    assert started.wait(1)

    status = _wait_for_status(client, job_id, {"merging"})
    assert status["progress"] == 25
    assert status["completed"] == 1
    assert status["total"] == 4
    assert status["completed_source_indices"] == [0]
    assert client.get("/health").status_code in {200, 503}
    assert client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/result").status_code == 409

    cancelled = client.post(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["cancelled"] is True
    terminal = _wait_for_status(client, job_id, {"cancelled"})
    assert terminal["terminal"] is True
    assert terminal["cancel_requested"] is True
    assert terminal["completed_source_indices"] == [0]
    assert list(tmp_path.iterdir()) == []

    repeated = client.post(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/cancel")
    assert repeated.json()["already_cancelled"] is True
    release.set()


def test_queued_job_can_be_cancelled_before_worker_starts_and_cleans_upload(
    job_client,
    monkeypatch,
):
    client, _registry, tmp_path = job_client
    first_started = threading.Event()
    release_first = threading.Event()
    calls = 0

    def queued_merge(
        _file_paths,
        _manifest,
        output_path,
        *,
        progress_callback=None,
        cancel_check=None,
        source_completed_callback=None,
    ):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_started.set()
            release_first.wait(2)
        if cancel_check():
            raise manifest_engine.ManifestJobCancelled("Đã hủy ghép PDF")
        Path(output_path).write_bytes(_pdf_bytes(1))

    monkeypatch.setattr(manifest_engine, "merge_manifest", queued_merge)

    first = _start_uploaded_job(client)
    assert first.status_code == 202
    assert first_started.wait(1)
    second = _start_uploaded_job(client)
    assert second.status_code == 202
    second_id = second.json()["job_id"]

    cancelled = client.post(f"/api/pdf-tools/merge-manifest/jobs/{second_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["terminal"] is True
    assert _wait_for_status(client, second_id, {"cancelled"})["terminal"] is True
    assert calls == 1

    release_first.set()
    first_id = first.json()["job_id"]
    _wait_for_status(client, first_id, {"completed"})
    artifacts = list(tmp_path.iterdir())
    assert [path.name for path in artifacts] == [f"merged_manifest_{first_id}.pdf"]


def test_completed_job_returns_disk_result_and_preserves_native_source(
    job_client,
):
    client, _registry, tmp_path = job_client
    source = tmp_path / "native.pdf"
    source.write_bytes(_pdf_bytes(2))
    response = client.post(
        "/api/pdf-tools/merge-manifest/jobs",
        data={
            "manifest": json.dumps([{"file_index": 0}]),
            "file_paths": json.dumps([str(source)]),
            "return_path": "true",
        },
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]

    status = _wait_for_status(client, job_id, {"completed"})
    assert status["terminal"] is True
    assert status["progress"] == 100
    assert status["completed_source_indices"] == [0]
    result = client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/result")
    assert result.status_code == 200
    result_path = Path(result.json()["path"])
    assert result_path.is_file()
    assert source.is_file()
    with pikepdf.Pdf.open(result_path) as pdf:
        assert len(pdf.pages) == 2


def test_mixed_native_and_uploaded_sources_keep_order_without_copying_native(job_client):
    client, _registry, tmp_path = job_client
    native_source = tmp_path / "native.pdf"
    native_source.write_bytes(_pdf_bytes(1))
    response = client.post(
        "/api/pdf-tools/merge-manifest/jobs",
        files=[("files", ("upload.pdf", _pdf_bytes(2), "application/pdf"))],
        data={
            "manifest": json.dumps([{"file_index": 0}, {"file_index": 1}]),
            "source_paths": json.dumps([str(native_source), None]),
            "return_path": "true",
        },
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]

    assert _wait_for_status(client, job_id, {"completed"})["terminal"] is True
    result = client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/result")
    assert result.status_code == 200, result.text
    result_path = Path(result.json()["path"])
    assert native_source.is_file()
    with pikepdf.Pdf.open(result_path) as pdf:
        assert len(pdf.pages) == 3

    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        leftovers = {path.name for path in tmp_path.iterdir()}
        if leftovers == {native_source.name, result_path.name}:
            break
        time.sleep(0.01)
    assert {path.name for path in tmp_path.iterdir()} == {
        native_source.name,
        result_path.name,
    }


def test_mixed_source_descriptor_rejects_upload_count_mismatch(job_client):
    client, _registry, _tmp_path = job_client
    response = client.post(
        "/api/pdf-tools/merge-manifest/jobs",
        files=[("files", ("upload.pdf", _pdf_bytes(1), "application/pdf"))],
        data={
            "manifest": json.dumps([{"file_index": 0}]),
            "source_paths": json.dumps([None, None]),
        },
    )
    assert response.status_code == 400
    assert "không khớp" in response.json()["detail"]

def test_completed_job_downloads_pdf_when_return_path_is_false(job_client):
    client, _registry, _tmp_path = job_client
    response = _start_uploaded_job(client, return_path=False)
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    assert _wait_for_status(client, job_id, {"completed"})["terminal"] is True
    result = client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/result")
    assert result.status_code == 200
    assert result.headers["content-type"].startswith("application/pdf")
    with pikepdf.Pdf.open(io.BytesIO(result.content)) as pdf:
        assert len(pdf.pages) == 2

def test_failed_job_has_terminal_message_and_removes_partial_and_upload(
    job_client,
    monkeypatch,
):
    client, _registry, tmp_path = job_client

    def failing_merge(
        _file_paths,
        _manifest,
        output_path,
        *,
        progress_callback=None,
        cancel_check=None,
        source_completed_callback=None,
    ):
        Path(output_path).write_bytes(b"partial")
        raise ValueError("Kế hoạch ghép không hợp lệ")

    monkeypatch.setattr(manifest_engine, "merge_manifest", failing_merge)
    response = _start_uploaded_job(client)
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    status = _wait_for_status(client, job_id, {"failed"})
    assert status["terminal"] is True
    assert "Kế hoạch ghép" in status["message"]
    assert client.get(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/result").status_code == 409
    assert list(tmp_path.iterdir()) == []


def test_job_endpoints_report_not_found(job_client):
    client, _registry, _tmp_path = job_client
    missing = "a" * 32

    assert client.get(f"/api/pdf-tools/merge-manifest/jobs/{missing}").status_code == 404
    assert client.get(f"/api/pdf-tools/merge-manifest/jobs/{missing}/result").status_code == 404
    cancel = client.post(f"/api/pdf-tools/merge-manifest/jobs/{missing}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "not_found"
    assert cancel.json()["cancelled"] is False


def test_engine_progress_and_cooperative_cancel_stop_before_save(tmp_path):
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    source.write_bytes(_pdf_bytes(5))
    cancel = threading.Event()
    updates = []

    def on_progress(phase: str, completed: int, total: int):
        updates.append((phase, completed, total))
        if phase == "merging" and completed >= 2:
            cancel.set()

    with pytest.raises(manifest_engine.ManifestJobCancelled):
        manifest_engine.merge_manifest(
            [str(source)],
            [{"file_index": 0}],
            str(output),
            progress_callback=on_progress,
            cancel_check=cancel.is_set,
        )

    assert any(phase == "inspecting" for phase, _done, _total in updates)
    assert any(phase == "merging" and done == 2 for phase, done, _total in updates)
    assert output.exists() is False

def test_registry_sweeper_removes_expired_result_without_new_request(tmp_path):
    registry = CombineJobRegistry(
        max_workers=1,
        max_queued=0,
        ttl_seconds=0.05,
        slot_factory=lambda: nullcontext(),
    )
    result_path = tmp_path / "result.pdf"
    partial_path = tmp_path / "result.partial.pdf"

    try:
        registry.submit(
            job_id="ttl-job",
            result_path=str(result_path),
            partial_path=str(partial_path),
            owned_paths=[],
            return_path=False,
            worker=lambda: result_path.write_bytes(_pdf_bytes(1)),
        )
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            snapshot = registry.get("ttl-job")
            if snapshot is not None and snapshot.status == "completed":
                break
            time.sleep(0.01)
        else:
            raise AssertionError("Job TTL không hoàn tất")
        assert result_path.is_file()

        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and result_path.exists():
            time.sleep(0.01)
        assert result_path.exists() is False
        assert registry.get("ttl-job") is None
    finally:
        registry.close()

def test_cancel_during_watermark_removes_partial_and_never_publishes_result(
    job_client,
    monkeypatch,
):
    client, _registry, tmp_path = job_client
    watermark_started = threading.Event()
    release_watermark = threading.Event()

    def assembled_merge(
        _file_paths,
        _manifest,
        output_path,
        *,
        progress_callback=None,
        cancel_check=None,
        source_completed_callback=None,
    ):
        progress_callback("merging", 1, 1)
        Path(output_path).write_bytes(_pdf_bytes(1))

    def blocking_watermark(*_args, **_kwargs):
        watermark_started.set()
        release_watermark.wait(2)

    monkeypatch.setattr(manifest_engine, "merge_manifest", assembled_merge)
    monkeypatch.setattr(pdf_tools, "_safe_watermark", blocking_watermark)
    response = _start_uploaded_job(client)
    assert response.status_code == 202
    job_id = response.json()["job_id"]
    assert watermark_started.wait(1)

    cancelled = client.post(f"/api/pdf-tools/merge-manifest/jobs/{job_id}/cancel")
    assert cancelled.json()["cancelled"] is True
    release_watermark.set()
    status = _wait_for_status(client, job_id, {"cancelled"})
    assert status["terminal"] is True
    assert list(tmp_path.iterdir()) == []


def test_registry_rejects_full_queue_and_cleans_rejected_owned_file(tmp_path):
    registry = CombineJobRegistry(
        max_workers=1,
        max_queued=0,
        ttl_seconds=60,
        slot_factory=lambda: nullcontext(),
    )
    started = threading.Event()
    release = threading.Event()
    rejected_upload = tmp_path / "rejected.pdf"
    rejected_upload.write_bytes(_pdf_bytes(1))

    def blocking_worker():
        started.set()
        release.wait(2)

    try:
        registry.submit(
            job_id="running",
            result_path=str(tmp_path / "running.pdf"),
            partial_path=str(tmp_path / "running.partial.pdf"),
            owned_paths=[],
            return_path=False,
            worker=blocking_worker,
        )
        assert started.wait(1)
        with pytest.raises(CombineJobQueueFull):
            registry.submit(
                job_id="rejected",
                result_path=str(tmp_path / "rejected-result.pdf"),
                partial_path=str(tmp_path / "rejected.partial.pdf"),
                owned_paths=[str(rejected_upload)],
                return_path=False,
                worker=lambda: None,
            )
        assert rejected_upload.exists() is False
    finally:
        release.set()
        registry.close()

def test_registry_ttl_preserves_return_path_for_workspace_cleanup(tmp_path):
    registry = CombineJobRegistry(
        max_workers=1,
        max_queued=0,
        ttl_seconds=0.05,
        slot_factory=lambda: nullcontext(),
    )
    result_path = tmp_path / "workspace-result.pdf"

    try:
        registry.submit(
            job_id="workspace-path",
            result_path=str(result_path),
            partial_path=str(tmp_path / "workspace-result.partial.pdf"),
            owned_paths=[],
            return_path=True,
            worker=lambda: result_path.write_bytes(_pdf_bytes(1)),
        )
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and registry.get("workspace-path") is not None:
            time.sleep(0.01)
        assert registry.get("workspace-path") is None
        assert result_path.is_file()
    finally:
        registry.close()
    assert result_path.is_file()
