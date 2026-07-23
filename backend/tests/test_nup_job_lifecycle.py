import asyncio
import multiprocessing
import threading

import pytest

from app.api.routes import imposition
from app.core import perf_sampler


class _TrackingSlot:
    def __init__(self):
        self.releases = 0

    def release(self):
        self.releases += 1


class _Sampler:
    def __init__(self, _pid, interval_ms=250, temp_patterns=()):
        self.interval_ms = interval_ms
        self.temp_patterns = temp_patterns
        self.peak_mb = 42.0
        self.peak_temp_mb = 3.0
        self.sample_count = 4

    def start(self):
        return None

    def stop(self):
        return None


@pytest.mark.parametrize("perf_on", [False, True])
def test_nup_lifecycle_reaches_terminal_and_releases_slot(monkeypatch, tmp_path, perf_on):
    job_id = f"job-{int(perf_on)}"
    output_path = tmp_path / "output.pdf"
    state_path = tmp_path / f"nup_state_{job_id}.txt"
    slot = _TrackingSlot()
    records = []

    class FakeProcess:
        pid = 321
        exitcode = 0

        def __init__(self, *, target, args, daemon):
            assert target is imposition._nup_process_worker
            assert daemon is False
            self.args = args

        def start(self):
            assert imposition.nup_jobs[job_id]["status"] == "running"

        def join(self):
            output_path.write_bytes(b"%PDF-test")
            state_path.write_text("completed|||ok", encoding="utf-8")

    monkeypatch.setattr(multiprocessing, "Process", FakeProcess)
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", lambda _job_id: None)
    monkeypatch.setattr(perf_sampler, "ProcessRssSampler", _Sampler)
    monkeypatch.setattr(perf_sampler, "write_job_perf", records.append)
    if perf_on:
        monkeypatch.setenv("PRYNX_PERF", "1")
    else:
        monkeypatch.delenv("PRYNX_PERF", raising=False)

    imposition.nup_jobs[job_id] = {
        "status": "queued",
        "progress": "0/1",
        "report": "",
        "error": None,
        "output_path": str(output_path),
    }
    try:
        imposition._spawn_nup_process("source.pdf", str(output_path), {}, job_id)
        assert slot.releases == 1
        assert imposition.nup_jobs[job_id]["status"] == "running"

        status = asyncio.run(imposition.get_nup_status(job_id, {}))
        assert status["status"] == "completed"
        assert status["report"] == "ok"
        assert len(records) == int(perf_on)
        if perf_on:
            assert records[0]["peak_rss_mb"] == 42.0
            assert records[0]["peak_temp_mb"] == 3.0
            assert records[0]["samples"] == 4
    finally:
        imposition.nup_jobs.pop(job_id, None)


def test_nup_instrumentation_failure_cannot_leak_slot(monkeypatch):
    job_id = "instrumentation-failure"
    slot = _TrackingSlot()
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", lambda _job_id: None)
    monkeypatch.setattr(perf_sampler, "perf_enabled", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    imposition.nup_jobs.pop(job_id, None)

    imposition._spawn_nup_process("source.pdf", "output.pdf", {}, job_id)

    assert slot.releases == 1


def test_cancel_queued_nup_skips_process_and_preserves_finally(monkeypatch):
    job_id = "queued-cancel"
    slot = _TrackingSlot()
    cleaned = []

    class ProcessMustNotStart:
        def __init__(self, **_kwargs):
            raise AssertionError("cancelled queued job spawned a process")

    monkeypatch.setattr(multiprocessing, "Process", ProcessMustNotStart)
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", cleaned.append)
    imposition.nup_jobs[job_id] = {
        "status": "queued",
        "progress": "0/0",
        "report": "",
        "error": None,
        "output_path": "output.pdf",
        "cancel_requested": False,
        "process": None,
        "pid": None,
    }
    try:
        response = asyncio.run(imposition.cancel_nup_job(job_id, {}))
        assert response["status"] == "cancelled"
        assert response["cancelled"] is True

        imposition._spawn_nup_process("source.pdf", "output.pdf", {}, job_id)

        assert imposition.nup_jobs[job_id]["status"] == "cancelled"
        assert slot.releases == 1
        assert cleaned == [job_id]
    finally:
        imposition.nup_jobs.pop(job_id, None)


def test_cancel_running_nup_terminates_then_kills_if_needed():
    job_id = "running-cancel"

    class StubbornProcess:
        def __init__(self):
            self.alive = True
            self.terminate_calls = 0
            self.kill_calls = 0
            self.join_timeouts = []

        def is_alive(self):
            return self.alive

        def terminate(self):
            self.terminate_calls += 1

        def join(self, timeout=None):
            self.join_timeouts.append(timeout)

        def kill(self):
            self.kill_calls += 1
            self.alive = False

    proc = StubbornProcess()
    imposition.nup_jobs[job_id] = {
        "status": "running",
        "error": "old",
        "cancel_requested": False,
        "process": proc,
    }
    try:
        response = asyncio.run(imposition.cancel_nup_job(job_id, {}))

        assert response["process_stopped"] is True
        assert imposition.nup_jobs[job_id]["status"] == "cancelled"
        assert proc.terminate_calls == 1
        assert proc.kill_calls == 1
        assert proc.join_timeouts == [1.0, 1.0]
    finally:
        imposition.nup_jobs.pop(job_id, None)


def test_cancel_running_nup_unblocks_spawn_finally(monkeypatch, tmp_path):
    job_id = "running-finally"
    slot = _TrackingSlot()
    started = threading.Event()
    terminated = threading.Event()
    cleaned = []

    class BlockingProcess:
        pid = 654

        def __init__(self, *, target, args, daemon):
            self.exitcode = None

        def start(self):
            started.set()

        def join(self, timeout=None):
            if timeout is None:
                assert terminated.wait(2)
            self.exitcode = -15

        def is_alive(self):
            return not terminated.is_set()

        def terminate(self):
            terminated.set()

        def kill(self):
            terminated.set()

    monkeypatch.setattr(multiprocessing, "Process", BlockingProcess)
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", cleaned.append)
    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))
    imposition.nup_jobs[job_id] = {
        "status": "queued",
        "progress": "0/0",
        "report": "",
        "error": None,
        "output_path": str(tmp_path / "output.pdf"),
        "cancel_requested": False,
        "process": None,
        "pid": None,
    }
    worker = threading.Thread(
        target=imposition._spawn_nup_process,
        args=("source.pdf", str(tmp_path / "output.pdf"), {}, job_id),
    )
    try:
        worker.start()
        assert started.wait(2)

        response = asyncio.run(imposition.cancel_nup_job(job_id, {}))
        worker.join(2)

        assert response["status"] == "cancelled"
        assert not worker.is_alive()
        assert imposition.nup_jobs[job_id]["status"] == "cancelled"
        assert slot.releases == 1
        assert cleaned == [job_id]
        assert not (tmp_path / f"nup_state_{job_id}.txt").exists()
    finally:
        terminated.set()
        worker.join(2)
        imposition.nup_jobs.pop(job_id, None)


def test_cancel_nup_is_idempotent_for_missing_and_terminal_jobs():
    missing = asyncio.run(imposition.cancel_nup_job("missing", {}))
    assert missing == {
        "job_id": "missing",
        "status": "not_found",
        "cancelled": False,
        "message": "Job not found",
    }

    imposition.nup_jobs["done"] = {"status": "completed"}
    try:
        terminal = asyncio.run(imposition.cancel_nup_job("done", {}))
        assert terminal["status"] == "completed"
        assert terminal["cancelled"] is False
    finally:
        imposition.nup_jobs.pop("done", None)
