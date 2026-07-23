import asyncio
import io
import json
import threading

import pytest

from app.api.routes import vdp
from app.workers import vdp_engine


def test_parse_csv_upload_preserves_header_rows_and_delimiter():
    stream = io.BytesIO("Name;Code\nAlice;A-1\nBob;B-2\n".encode("utf-8"))

    rows = vdp._parse_csv_upload(stream, has_header=True)

    assert rows == [
        {"Name": "Alice", "Code": "A-1"},
        {"Name": "Bob", "Code": "B-2"},
    ]
    assert stream.tell() == 0


def test_parse_csv_upload_assigns_positional_columns_without_header():
    stream = io.BytesIO("Alice,A-1\nBob,B-2\n".encode("utf-8"))

    rows = vdp._parse_csv_upload(stream, has_header=False)

    assert rows == [
        {"Cột 1": "Alice", "Cột 2": "A-1"},
        {"Cột 1": "Bob", "Cột 2": "B-2"},
    ]


def test_parse_csv_upload_rejects_rows_above_cap(monkeypatch):
    monkeypatch.setattr(vdp, "MAX_VDP_ROWS", 1)
    stream = io.BytesIO("Name\nAlice\nBob\n".encode("utf-8"))

    with pytest.raises(ValueError, match="Quá nhiều bản ghi"):
        vdp._parse_csv_upload(stream, has_header=True)

class _TrackingSlots:
    def __init__(self, available=True):
        self.available = available
        self.releases = 0

    def acquire(self, blocking=False):
        assert blocking is False
        return self.available

    def release(self):
        self.releases += 1


class _CapturingExecutor:
    def __init__(self):
        self.submission = None

    def submit(self, function, *args, **kwargs):
        self.submission = (function, args, kwargs)
        return object()


def _field_json():
    return json.dumps([
        {
            "id": "name",
            "name": "Name",
            "type": "text",
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
        }
    ])


def _upload(name: str, content: bytes):
    from fastapi import UploadFile

    return UploadFile(filename=name, file=io.BytesIO(content))


def test_generate_rejects_full_queue_before_inspecting_payload(monkeypatch):
    slots = _TrackingSlots(available=False)
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(vdp, "_uploaded_file_size", lambda _file: (_ for _ in ()).throw(AssertionError("parsed")))

    with pytest.raises(vdp.HTTPException) as exc:
        asyncio.run(vdp.start_vdp_job(
            fields=_field_json(),
            data_file=_upload("data.csv", b"Name\nAlice\n"),
            file=_upload("template.pdf", b"%PDF-test"),
            data_format="csv",
            license_info={},
        ))

    assert exc.value.status_code == 429
    assert slots.releases == 0


def test_generate_spools_inputs_before_fixed_executor_submission(monkeypatch, tmp_path):
    slots = _TrackingSlots()
    executor = _CapturingExecutor()
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(vdp, "_VDP_EXECUTOR", executor)
    monkeypatch.setattr(vdp, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(vdp, "RESULTS_DIR", str(tmp_path))

    response = asyncio.run(vdp.start_vdp_job(
        fields=_field_json(),
        data_file=_upload("data.csv", b"Name\nAlice\n"),
        file=_upload("template.pdf", b"%PDF-test"),
        file_path=None,
        data_format="csv",
        has_header=True,
        license_info={},
    ))

    job_id = response["job_id"]
    function, args, _kwargs = executor.submission
    assert function is vdp.vdp_background_task_spooled
    assert args[0] == job_id
    assert isinstance(args[2], str)
    assert isinstance(args[3], list)
    assert vdp.vdp_jobs[job_id]["status"] == "queued"
    assert vdp.vdp_jobs[job_id]["total"] == 0
    assert (tmp_path / f"vdp_data_{job_id}.dat").read_bytes() == b"Name\nAlice\n"
    assert slots.releases == 0

    vdp.vdp_jobs.pop(job_id, None)
    for path in tmp_path.iterdir():
        path.unlink()


def test_spooled_worker_parses_data_then_releases_and_cleans(monkeypatch, tmp_path):
    slots = _TrackingSlots()
    data_path = tmp_path / "data.csv"
    template_path = tmp_path / "template.pdf"
    output_path = tmp_path / "output.pdf"
    data_path.write_bytes(b"Name;Code\nAlice;A-1\n")
    template_path.write_bytes(b"%PDF-test")
    captured = {}

    def fake_background(job_id, template, fields, data, output, **kwargs):
        captured["data"] = data

    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(vdp, "vdp_background_task", fake_background)
    vdp.vdp_jobs["job"] = {"status": "queued", "total": 0}
    try:
        vdp.vdp_background_task_spooled(
            "job",
            str(template_path),
            str(data_path),
            [],
            "csv",
            True,
            str(output_path),
        )
        assert captured["data"] == [{"Name": "Alice", "Code": "A-1"}]
        assert vdp.vdp_jobs["job"]["total"] == 1
        assert slots.releases == 1
        assert not data_path.exists()
        assert not template_path.exists()
    finally:
        vdp.vdp_jobs.pop("job", None)


class _CancellableFuture:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    def cancel(self):
        self.calls += 1
        return self.result


def _cancel_job(tmp_path, future):
    job_id = "cancel-job"
    data_path = tmp_path / "data.dat"
    template_path = tmp_path / "template.pdf"
    output_path = tmp_path / "output.pdf"
    cancel_file = tmp_path / "cancel.flag"
    data_path.write_bytes(b"[]")
    template_path.write_bytes(b"%PDF-test")
    output_path.write_bytes(b"partial")
    job = {
        "status": "queued",
        "processed": 0,
        "total": 0,
        "result": None,
        "error": None,
        "cancel_requested": False,
        "cancel_event": threading.Event(),
        "cancel_file": str(cancel_file),
        "data_path": str(data_path),
        "template_path": str(template_path),
        "output_path": str(output_path),
        "future": future,
        "slot_released": False,
    }
    vdp.vdp_jobs[job_id] = job
    return job_id, job, data_path, template_path, output_path, cancel_file


def test_cancel_queued_vdp_cleans_spool_and_releases_slot_once(monkeypatch, tmp_path):
    slots = _TrackingSlots()
    future = _CancellableFuture(True)
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slots)
    job_id, job, data_path, template_path, output_path, cancel_file = _cancel_job(tmp_path, future)
    try:
        first = vdp.cancel_vdp_job(job_id, {})
        second = vdp.cancel_vdp_job(job_id, {})

        assert first["cancelled_before_start"] is True
        assert second["already_cancelled"] is True
        assert job["status"] == "cancelled"
        assert job["cancel_event"].is_set()
        assert slots.releases == 1
        assert future.calls == 2
        assert not data_path.exists()
        assert not template_path.exists()
        assert not output_path.exists()
        assert not cancel_file.exists()
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_cancel_queued_vdp_releases_even_if_future_entered_scheduler(monkeypatch, tmp_path):
    slots = _TrackingSlots()
    future = _CancellableFuture(False)
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slots)
    job_id, job, data_path, template_path, output_path, cancel_file = _cancel_job(tmp_path, future)
    try:
        response = vdp.cancel_vdp_job(job_id, {})

        assert response["cancelled_before_start"] is True
        assert job["status"] == "cancelled"
        assert slots.releases == 1
        assert not data_path.exists()
        assert not template_path.exists()
        assert not output_path.exists()
        assert not cancel_file.exists()

        # The scheduled wrapper may still enter later; its finally is release-once.
        assert vdp._release_vdp_submission_slot(job) is False
        assert slots.releases == 1
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_cancel_running_vdp_is_cooperative_then_worker_releases(monkeypatch, tmp_path):
    slots = _TrackingSlots()
    future = _CancellableFuture(False)
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slots)
    job_id, job, data_path, template_path, output_path, cancel_file = _cancel_job(tmp_path, future)
    job["status"] = "processing"
    try:
        response = vdp.cancel_vdp_job(job_id, {})

        assert response["cancelled_before_start"] is False
        assert cancel_file.exists()
        assert slots.releases == 0

        vdp.vdp_background_task_spooled(
            job_id,
            str(template_path),
            str(data_path),
            [],
            "json",
            True,
            str(output_path),
        )

        assert job["status"] == "cancelled"
        assert slots.releases == 1
        assert not data_path.exists()
        assert not template_path.exists()
        assert not output_path.exists()
        assert not cancel_file.exists()
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_vdp_engine_observes_cancel_before_opening_template(tmp_path):
    marker = tmp_path / "cancel.flag"
    marker.touch()

    result = vdp_engine.process_chunk(
        ("missing.pdf", [], [], 0, None, str(marker), "job")
    )

    assert result == ""


def test_vdp_engine_cancel_check_removes_partial_output(tmp_path):
    output_path = tmp_path / "partial.pdf"
    output_path.write_bytes(b"partial")

    with pytest.raises(vdp_engine.VdpCancelledError, match="cancelled"):
        vdp_engine.run_vdp_engine(
            "missing.pdf",
            [],
            [],
            str(output_path),
            job_id="job",
            cancel_check=lambda: True,
        )

    assert not output_path.exists()


def test_cancel_vdp_is_idempotent_for_missing_and_terminal_jobs():
    missing = vdp.cancel_vdp_job("missing", {})
    assert missing["status"] == "not_found"
    assert missing["cancelled"] is False

    vdp.vdp_jobs["done"] = {"status": "failed"}
    try:
        terminal = vdp.cancel_vdp_job("done", {})
        assert terminal["status"] == "failed"
        assert terminal["cancelled"] is False
    finally:
        vdp.vdp_jobs.pop("done", None)
