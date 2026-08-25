import asyncio
import multiprocessing
import threading
import time
from pathlib import Path

import pytest

from app.api.routes import imposition, vdp
from app.core import artifact_lease, perf_sampler


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
    output_path = tmp_path / f"nup_0000000{int(perf_on)}.pdf"
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
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(imposition.settings, "IS_DESKTOP_APP", True)
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
        assert imposition.nup_jobs[job_id]["status"] == "completed"

        status = asyncio.run(imposition.get_nup_status(job_id, {}))
        assert status["status"] == "completed"
        assert status["report"] == "ok"
        assert len(status["artifact_lease"]) == 64
        assert status["output_path"] == str(output_path)
        assert len(records) == int(perf_on)
        if perf_on:
            assert records[0]["peak_rss_mb"] == 42.0
            assert records[0]["peak_temp_mb"] == 3.0
            assert records[0]["samples"] == 4
    finally:
        token = imposition.nup_jobs.get(job_id, {}).get("artifact_lease")
        if token:
            artifact_lease.release_artifact_lease(token, "test-cleanup")
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


def test_nup_exit_zero_without_state_becomes_failed_terminal(monkeypatch, tmp_path):
    job_id = "exit-zero-no-state"
    slot = _TrackingSlot()

    class SilentProcess:
        pid = 987
        exitcode = 0

        def __init__(self, *, target, args, daemon):
            assert target is imposition._nup_process_worker
            assert daemon is False

        def start(self):
            return None

        def join(self):
            return None

    monkeypatch.setattr(multiprocessing, "Process", SilentProcess)
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", lambda _job_id: None)
    imposition.nup_jobs[job_id] = {
        "status": "queued",
        "progress": "0/1",
        "report": "",
        "error": None,
        "output_path": str(tmp_path / "output.pdf"),
    }
    try:
        imposition._spawn_nup_process("source.pdf", "output.pdf", {}, job_id)

        assert slot.releases == 1
        assert imposition.nup_jobs[job_id]["status"] == "failed"
        assert "không ghi trạng thái" in imposition.nup_jobs[job_id]["error"]
        status = asyncio.run(imposition.get_nup_status(job_id, {}))
        assert status["status"] == "failed"
        assert status["completed_at"] is not None
    finally:
        imposition.nup_jobs.pop(job_id, None)


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


@pytest.mark.parametrize(
    ("is_desktop", "expected_path"),
    [
        (True, "result.pdf"),
        (False, None),
    ],
)
def test_nup_status_exposes_timestamps_and_desktop_output_path(
    monkeypatch,
    tmp_path,
    is_desktop,
    expected_path,
):
    job_id = f"status-{int(is_desktop)}"
    result_path = tmp_path / f"nup_0000001{int(is_desktop)}.pdf"
    result_path.write_bytes(b"%PDF-test")
    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(imposition.settings, "IS_DESKTOP_APP", is_desktop)
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    token = artifact_lease.create_artifact_lease("imposition", result_path)
    imposition.nup_jobs[job_id] = {
        "status": "completed",
        "progress": "1/1",
        "report": "ok",
        "error": None,
        "output_path": str(result_path),
        "artifact_lease": token,
        "created_at": 1.0,
        "started_at": 2.0,
        "completed_at": 3.0,
    }
    try:
        status = asyncio.run(imposition.get_nup_status(job_id, {}))
        assert status["created_at"] == 1.0
        assert status["started_at"] == 2.0
        assert status["completed_at"] == 3.0
        assert status["output_path"] == (str(result_path) if expected_path else None)
        assert status["artifact_lease"] == token
    finally:
        artifact_lease.release_artifact_lease(token, "test-cleanup")
        imposition.nup_jobs.pop(job_id, None)


@pytest.mark.parametrize("prefix", ["nup", "sticker"])
def test_nup_and_sticker_publish_path_only_with_lease(
    monkeypatch,
    tmp_path,
    prefix,
):
    job_id = f"publish-{prefix}"
    output_path = tmp_path / f"{prefix}_abcdef01.pdf"
    output_path.write_bytes(b"%PDF-published")
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(imposition.settings, "IS_DESKTOP_APP", True)
    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))
    imposition.nup_jobs[job_id] = {
        "status": "running",
        "progress": "1/1",
        "report": "",
        "error": None,
        "output_path": str(output_path),
        "artifact_lease": None,
        "created_at": time.time() - 10_000,
        "completed_at": None,
    }
    token = None
    try:
        assert imposition._publish_nup_terminal_state(job_id, "completed", "ok")
        status = asyncio.run(imposition.get_nup_status(job_id, {}))
        token = status["artifact_lease"]
        assert len(token) == 64
        assert status["output_path"] == str(output_path)
        assert status["completed_at"] is not None
        assert "artifact_lease" in imposition.NupJobStatusResponse.model_fields
    finally:
        if token:
            artifact_lease.release_artifact_lease(token, "test-cleanup")
        imposition.nup_jobs.pop(job_id, None)


def test_nup_lease_failure_is_failed_and_removes_unpublished_output(
    monkeypatch,
    tmp_path,
):
    job_id = "lease-failure"
    output_path = tmp_path / "nup_deadbeef.pdf"
    output_path.write_bytes(b"%PDF-unprotected")
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(
        imposition,
        "create_artifact_lease",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk")),
    )
    imposition.nup_jobs[job_id] = {
        "status": "running",
        "output_path": str(output_path),
        "artifact_lease": None,
        "completed_at": None,
    }
    try:
        assert not imposition._publish_nup_terminal_state(job_id, "completed", "ok")
        job = imposition.nup_jobs[job_id]
        assert job["status"] == "failed"
        assert job["artifact_lease"] is None
        assert not output_path.exists()
    finally:
        imposition.nup_jobs.pop(job_id, None)


def test_nup_purge_uses_terminal_time_and_keeps_leased_file(
    monkeypatch,
    tmp_path,
):
    now = time.time()
    leased = tmp_path / "nup_11111111.pdf"
    unleased = tmp_path / "nup_22222222.pdf"
    leased.write_bytes(b"leased")
    unleased.write_bytes(b"unleased")
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(imposition, "NUP_JOB_TTL_SECONDS", 1)
    monkeypatch.setattr(imposition, "_cleanup_job_temp", lambda _job_id: None)
    token = artifact_lease.create_artifact_lease("imposition", leased)
    imposition.nup_jobs.update(
        {
            "leased-old": {
                "status": "completed",
                "output_path": str(leased),
                "artifact_lease": token,
                "created_at": now - 20_000,
                "completed_at": now - 10,
            },
            "unleased-old": {
                "status": "failed",
                "output_path": str(unleased),
                "created_at": now - 20_000,
                "completed_at": now - 10,
            },
            "legacy-terminal": {
                "status": "completed",
                "output_path": str(tmp_path / "nup_33333333.pdf"),
                "created_at": now - 20_000,
                "completed_at": None,
            },
        }
    )
    try:
        imposition._purge_old_nup_jobs()
        assert "leased-old" not in imposition.nup_jobs
        assert "unleased-old" not in imposition.nup_jobs
        assert leased.exists()
        assert not unleased.exists()
        # Job dài vừa terminal nhận mốc mới; không bị purge theo created_at cũ.
        assert imposition.nup_jobs["legacy-terminal"]["completed_at"] >= now
    finally:
        artifact_lease.release_artifact_lease(token, "test-cleanup")
        for job_id in ("leased-old", "unleased-old", "legacy-terminal"):
            imposition.nup_jobs.pop(job_id, None)


def _vdp_job(output_path: Path) -> dict:
    return {
        "status": "processing",
        "processed": 0,
        "total": 1,
        "result": None,
        "artifact_lease": None,
        "error": None,
        "cancel_requested": False,
        "cancel_event": threading.Event(),
        "cancel_file": "",
        "output_path": str(output_path),
        "created_at": time.time() - 10_000,
        "completed_at": None,
    }


def test_vdp_publishes_token_after_output_exists(monkeypatch, tmp_path):
    job_id = "a" * 32
    output_path = tmp_path / f"vdp_{job_id}.pdf"
    monkeypatch.setattr(vdp.settings, "RESULTS_DIR", str(tmp_path))

    def fake_engine(_template, _fields, _data, output, **_kwargs):
        Path(output).write_bytes(b"%PDF-vdp")

    monkeypatch.setattr(vdp, "run_vdp_engine", fake_engine)
    vdp.vdp_jobs[job_id] = _vdp_job(output_path)
    token = None
    try:
        vdp.vdp_background_task(job_id, "template.pdf", [], [{}], str(output_path))
        status = vdp.get_vdp_status(job_id, {})
        token = status["artifact_lease"]
        assert status["status"] == "completed"
        assert status["result"] == str(output_path)
        assert len(token) == 64
        assert vdp.vdp_jobs[job_id]["completed_at"] is not None
        assert "artifact_lease" in vdp.VdpJobStatusResponse.model_fields
        vdp.vdp_jobs[job_id]["artifact_lease"] = None
        hidden = vdp.get_vdp_status(job_id, {})
        assert hidden["result"] is None
        assert hidden["artifact_lease"] is None
        vdp.vdp_jobs[job_id]["artifact_lease"] = token
    finally:
        if token:
            artifact_lease.release_artifact_lease(token, "test-cleanup")
        vdp.vdp_jobs.pop(job_id, None)


def test_vdp_lease_failure_is_failed_and_removes_output(monkeypatch, tmp_path):
    job_id = "b" * 32
    output_path = tmp_path / f"vdp_{job_id}.pdf"
    monkeypatch.setattr(vdp.settings, "RESULTS_DIR", str(tmp_path))

    def fake_engine(_template, _fields, _data, output, **_kwargs):
        Path(output).write_bytes(b"%PDF-vdp-unprotected")

    monkeypatch.setattr(vdp, "run_vdp_engine", fake_engine)
    monkeypatch.setattr(
        vdp,
        "create_artifact_lease",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk")),
    )
    vdp.vdp_jobs[job_id] = _vdp_job(output_path)
    try:
        vdp.vdp_background_task(job_id, "template.pdf", [], [{}], str(output_path))
        job = vdp.vdp_jobs[job_id]
        assert job["status"] == "failed"
        assert job["result"] is None
        assert job["artifact_lease"] is None
        assert not output_path.exists()
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_vdp_purge_uses_terminal_time_and_keeps_leased_file(
    monkeypatch,
    tmp_path,
):
    now = time.time()
    leased_id = "c" * 32
    unleased_id = "d" * 32
    leased = tmp_path / f"vdp_{leased_id}.pdf"
    unleased = tmp_path / f"vdp_{unleased_id}.pdf"
    leased.write_bytes(b"leased")
    unleased.write_bytes(b"unleased")
    monkeypatch.setattr(vdp.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(vdp, "VDP_JOB_TTL_SECONDS", 1)
    token = artifact_lease.create_artifact_lease("vdp", leased)
    vdp.vdp_jobs.update(
        {
            "vdp-leased-old": {
                "status": "completed",
                "result": str(leased),
                "output_path": str(leased),
                "artifact_lease": token,
                "created_at": now - 20_000,
                "completed_at": now - 10,
            },
            "vdp-unleased-old": {
                "status": "failed",
                "result": None,
                "output_path": str(unleased),
                "created_at": now - 20_000,
                "completed_at": now - 10,
            },
            "vdp-legacy-terminal": {
                "status": "completed",
                "result": None,
                "output_path": str(tmp_path / f"vdp_{'e' * 32}.pdf"),
                "created_at": now - 20_000,
                "completed_at": None,
            },
        }
    )
    try:
        vdp._purge_old_jobs()
        assert "vdp-leased-old" not in vdp.vdp_jobs
        assert "vdp-unleased-old" not in vdp.vdp_jobs
        assert leased.exists()
        assert not unleased.exists()
        assert vdp.vdp_jobs["vdp-legacy-terminal"]["completed_at"] >= now
    finally:
        artifact_lease.release_artifact_lease(token, "test-cleanup")
        for job_id in (
            "vdp-leased-old",
            "vdp-unleased-old",
            "vdp-legacy-terminal",
        ):
            vdp.vdp_jobs.pop(job_id, None)
