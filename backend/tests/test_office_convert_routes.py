from __future__ import annotations

import asyncio
import io
import os
import time
import uuid

import pytest
from fastapi import HTTPException
from fastapi.responses import FileResponse

from app.api.routes import office_convert as routes
from app.core.office_job_runner import OfficeJobCancelled
from app.workers.pdf_tools_engine import PdfOperationCancelled


PDF_BYTES = b"%PDF-1.4\n" + b"0" * 64


def test_office_upload_copy_uses_bounded_chunks(tmp_path):
    class TrackingFile(io.BytesIO):
        def __init__(self, payload: bytes):
            super().__init__(payload)
            self.read_sizes: list[int] = []

        def read(self, size: int = -1) -> bytes:
            self.read_sizes.append(size)
            return super().read(size)

    payload = b"x" * (routes._UPLOAD_CHUNK_BYTES * 2 + 17)
    source = TrackingFile(payload)
    output = tmp_path / "office.docx"

    assert routes._copy_upload_stream(source, str(output)) == len(payload)
    assert output.read_bytes() == payload
    assert source.read_sizes
    assert all(size == routes._UPLOAD_CHUNK_BYTES for size in source.read_sizes)


class ConnectedRequest:
    async def is_disconnected(self):
        return False


class DisconnectedRequest:
    async def is_disconnected(self):
        return True


@pytest.fixture(autouse=True)
def clear_office_jobs():
    with routes._JOBS_LOCK:
        routes._JOBS.clear()
    yield
    with routes._JOBS_LOCK:
        routes._JOBS.clear()


def test_job_status_cancel_and_extend_are_idempotent():
    job_id = uuid.uuid4().hex
    record = routes._register_job(job_id, 60)

    status = asyncio.run(routes.office_job_status(job_id, {}))
    assert status.phase == "queued"
    assert status.terminal is False

    extended = asyncio.run(routes.extend_office_job(job_id, 30, {}))
    assert extended.extended is True
    assert extended.remaining_seconds > 60

    first = asyncio.run(routes.cancel_office_job(job_id, {}))
    second = asyncio.run(routes.cancel_office_job(job_id, {}))
    assert first.cancelled is True
    assert second.cancelled is True
    assert record.control.cancel_event.is_set()

    routes._set_job_phase(job_id, "cancelled", "Đã hủy")
    terminal = asyncio.run(routes.cancel_office_job(job_id, {}))
    assert terminal.cancelled is True
    assert terminal.terminal is True
    assert terminal.phase == "cancelled"


def test_missing_job_actions_are_terminal():
    job_id = uuid.uuid4().hex
    status = asyncio.run(routes.office_job_status(job_id, {}))
    cancel = asyncio.run(routes.cancel_office_job(job_id, {}))
    extend = asyncio.run(routes.extend_office_job(job_id, 300, {}))

    assert status.phase == "not_found" and status.terminal
    assert cancel.phase == "not_found" and cancel.terminal
    assert extend.phase == "not_found" and not extend.extended


def test_extend_rejects_invalid_range():
    job_id = uuid.uuid4().hex
    routes._register_job(job_id, 60)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(routes.extend_office_job(job_id, 5, {}))

    assert exc_info.value.status_code == 400


def test_terminal_job_ttl_is_swept(monkeypatch):
    job_id = uuid.uuid4().hex
    record = routes._register_job(job_id, 60)
    routes._set_job_phase(job_id, "completed")
    record.updated_at = time.monotonic() - routes._JOB_TTL_SECONDS - 1

    assert routes._get_job(job_id) is None


@pytest.mark.asyncio
async def test_client_disconnect_sets_cancel_and_waits_for_worker_terminal():
    job_id = uuid.uuid4().hex
    record = routes._register_job(job_id, 60)

    async def worker():
        while not record.control.cancel_event.is_set():
            await asyncio.sleep(0.01)
        raise OfficeJobCancelled("Đã hủy")

    with pytest.raises(OfficeJobCancelled):
        await routes._await_job(DisconnectedRequest(), record, worker())

    assert record.control.cancel_event.is_set()
    assert record.phase == "cancel_requested"


@pytest.mark.asyncio
async def test_file_endpoint_returns_pdf_and_terminal_job(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    source.write_bytes(b"docx")
    job_id = uuid.uuid4().hex
    monkeypatch.setattr(routes, "RESULTS_DIR", str(tmp_path))

    def fake_runner(_source, output, _layout, *, control, phase_callback):
        assert control.cancel_event.is_set() is False
        phase_callback("starting")
        phase_callback("running")
        with open(output, "wb") as pdf_file:
            pdf_file.write(PDF_BYTES)
        phase_callback("completed")
        return output

    async def run_scheduled(_kind, function, *args):
        return function(*args)

    async def run_heavy(function, *args):
        return function(*args)

    monkeypatch.setattr(routes, "run_office_job", fake_runner)
    monkeypatch.setattr(routes, "run_scheduled_in_threadpool", run_scheduled)
    monkeypatch.setattr(routes, "run_heavy_in_threadpool", run_heavy)

    response = await routes.office_convert_file_endpoint(
        ConnectedRequest(),
        file=None,
        file_path=str(source),
        excel_layout="preserve",
        batch_mode=False,
        job_id=job_id,
        license_info={"license_key": "DEV_MODE"},
    )

    assert isinstance(response, FileResponse)
    assert response.headers["x-prynx-job-id"] == uuid.UUID(job_id).hex
    record = routes._get_job(job_id)
    assert record is not None and record.phase == "completed" and record.terminal
    assert os.path.isfile(response.path)
    await response.background()
    assert not os.path.exists(response.path)


@pytest.mark.asyncio
async def test_file_endpoint_disconnect_kills_current_job(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    source.write_bytes(b"docx")
    job_id = uuid.uuid4().hex
    monkeypatch.setattr(routes, "RESULTS_DIR", str(tmp_path))

    def blocking_runner(_source, _output, _layout, *, control, phase_callback):
        phase_callback("running")
        while not control.cancel_event.wait(0.01):
            pass
        phase_callback("cancelled")
        raise OfficeJobCancelled("Đã hủy chuyển Office → PDF.")

    async def run_scheduled(_kind, function, *args):
        return await asyncio.to_thread(function, *args)

    monkeypatch.setattr(routes, "run_office_job", blocking_runner)
    monkeypatch.setattr(routes, "run_scheduled_in_threadpool", run_scheduled)

    with pytest.raises(HTTPException) as exc_info:
        await routes.office_convert_file_endpoint(
            DisconnectedRequest(),
            file=None,
            file_path=str(source),
            excel_layout="preserve",
            batch_mode=False,
            job_id=job_id,
            license_info={"license_key": "DEV_MODE"},
        )

    assert exc_info.value.status_code == 409
    record = routes._get_job(job_id)
    assert record is not None and record.phase == "cancelled" and record.terminal
    assert not list(tmp_path.glob("converted_*.pdf"))

@pytest.mark.asyncio
async def test_resize_endpoint_reports_progress_and_returns_terminal_pdf(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(PDF_BYTES)
    job_id = uuid.uuid4().hex
    monkeypatch.setattr(routes, "RESULTS_DIR", str(tmp_path))

    def fake_resize(_source, output, *_args):
        cancel_signal = _args[-2]
        progress_callback = _args[-1]
        assert cancel_signal.is_set() is False
        progress_callback(1, 1)
        with open(output, "wb") as pdf_file:
            pdf_file.write(PDF_BYTES)
        return output

    async def run_scheduled(_kind, function, *args):
        return function(*args)

    monkeypatch.setattr(routes, "resize_pages", fake_resize)
    monkeypatch.setattr(routes, "run_scheduled_in_threadpool", run_scheduled)

    response = await routes.office_convert_resize_output(
        ConnectedRequest(),
        file=None,
        file_path=str(source),
        target_w=210,
        target_h=297,
        auto_orientation=True,
        batch_mode=False,
        job_id=job_id,
        license_info={"license_key": "DEV_MODE"},
    )

    assert isinstance(response, FileResponse)
    assert response.headers["x-prynx-job-id"] == uuid.UUID(job_id).hex
    record = routes._get_job(job_id)
    assert record is not None and record.phase == "completed" and record.terminal
    assert record.message == "1/1"
    await response.background()


@pytest.mark.asyncio
async def test_resize_endpoint_disconnect_cancels_current_page_loop(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(PDF_BYTES)
    job_id = uuid.uuid4().hex
    monkeypatch.setattr(routes, "RESULTS_DIR", str(tmp_path))

    def blocking_resize(_source, _output, *_args):
        cancel_signal = _args[-2]
        while not cancel_signal.is_set():
            time.sleep(0.01)
        raise PdfOperationCancelled("Đã hủy chuẩn hóa khổ PDF.")

    async def run_scheduled(_kind, function, *args):
        return await asyncio.to_thread(function, *args)

    monkeypatch.setattr(routes, "resize_pages", blocking_resize)
    monkeypatch.setattr(routes, "run_scheduled_in_threadpool", run_scheduled)

    with pytest.raises(HTTPException) as exc_info:
        await routes.office_convert_resize_output(
            DisconnectedRequest(),
            file=None,
            file_path=str(source),
            target_w=210,
            target_h=297,
            auto_orientation=True,
            batch_mode=False,
            job_id=job_id,
            license_info={"license_key": "DEV_MODE"},
        )

    assert exc_info.value.status_code == 409
    record = routes._get_job(job_id)
    assert record is not None and record.phase == "cancelled" and record.terminal
    assert not list(tmp_path.glob("batch_resized_*.pdf"))

@pytest.mark.asyncio
async def test_file_endpoint_native_path_response_keeps_result(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    source.write_bytes(b"docx")
    job_id = uuid.uuid4().hex
    monkeypatch.setattr(routes, "RESULTS_DIR", str(tmp_path))

    def fake_runner(_source, output, _layout, *, control, phase_callback):
        phase_callback("running")
        with open(output, "wb") as pdf_file:
            pdf_file.write(PDF_BYTES)
        phase_callback("completed")
        return output

    async def run_scheduled(_kind, function, *args):
        return function(*args)

    async def run_heavy(function, *args):
        return function(*args)

    monkeypatch.setattr(routes, "run_office_job", fake_runner)
    monkeypatch.setattr(routes, "run_scheduled_in_threadpool", run_scheduled)
    monkeypatch.setattr(routes, "run_heavy_in_threadpool", run_heavy)

    response = await routes.office_convert_file_endpoint(
        ConnectedRequest(),
        file=None,
        file_path=str(source),
        excel_layout="preserve",
        batch_mode=False,
        job_id=job_id,
        return_path=True,
        license_info={"license_key": "DEV_MODE"},
    )

    assert isinstance(response, dict)
    assert response["job_id"] == uuid.UUID(job_id).hex
    assert response["filename"] == "converted_source.pdf"
    assert os.path.isfile(response["path"])
    routes._cleanup_file(response["path"])


def test_consume_source_only_accepts_managed_results(monkeypatch, tmp_path):
    results = tmp_path / "results"
    results.mkdir()
    managed = results / "converted.pdf"
    outside = tmp_path / "user.pdf"
    managed.write_bytes(PDF_BYTES)
    outside.write_bytes(PDF_BYTES)
    monkeypatch.setattr(routes, "RESULTS_DIR", str(results))

    assert routes._is_managed_result_path(str(managed)) is True
    assert routes._is_managed_result_path(str(outside)) is False
