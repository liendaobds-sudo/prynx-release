"""Lifecycle tests for VDP cancellation.

Mirrors tests/test_nup_job_lifecycle.py but for the VDP path, which runs in a
thread pool (not a child process) and must therefore cancel cooperatively. The
highest-risk failure here is a double slot release: both the cancel route (for a
queued job) and the worker's finally block can try to release the same
submission slot, which would raise "Semaphore released too many times" on a
BoundedSemaphore. These tests lock that behavior down.
"""
import threading

from app.api.routes import vdp


class _TrackingSlot:
    def __init__(self):
        self.releases = 0

    def release(self):
        self.releases += 1


def test_release_slot_is_idempotent(monkeypatch):
    slot = _TrackingSlot()
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slot)
    job = {}

    assert vdp._release_vdp_submission_slot(job) is True
    assert vdp._release_vdp_submission_slot(job) is False
    assert slot.releases == 1


def test_cancel_queued_vdp_releases_slot_once_and_cleans(monkeypatch, tmp_path):
    slot = _TrackingSlot()
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slot)

    job_id = "vdp-queued"
    data_path = tmp_path / "data.csv"
    template_path = tmp_path / "template.pdf"
    data_path.write_text("Name\nA\n", encoding="utf-8")
    template_path.write_bytes(b"%PDF-test")

    vdp.vdp_jobs[job_id] = {
        "status": "queued",
        "data_path": str(data_path),
        "template_path": str(template_path),
        "output_path": str(tmp_path / "out.pdf"),
    }
    try:
        response = vdp.cancel_vdp_job(job_id, {})
        assert response["status"] == "cancelled"
        assert response["cancelled"] is True
        assert response["cancelled_before_start"] is True
        # Queued cancel cleans spooled inputs and releases the reserved slot.
        assert slot.releases == 1
        assert not data_path.exists()
        assert not template_path.exists()
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_cancel_queued_then_worker_finally_never_double_releases(monkeypatch, tmp_path):
    # The critical race: a queued job is cancelled (route releases the slot), but
    # its already-submitted worker still runs its finally block. The slot must be
    # released exactly once, never twice.
    slot = _TrackingSlot()
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(
        vdp, "_load_spooled_vdp_data",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not parse a cancelled job")),
    )

    job_id = "vdp-race"
    data_path = tmp_path / "data.csv"
    template_path = tmp_path / "template.pdf"
    data_path.write_text("Name\nA\n", encoding="utf-8")
    template_path.write_bytes(b"%PDF-test")

    vdp.vdp_jobs[job_id] = {
        "status": "queued",
        "data_path": str(data_path),
        "template_path": str(template_path),
        "output_path": str(tmp_path / "out.pdf"),
    }
    try:
        cancel_response = vdp.cancel_vdp_job(job_id, {})
        assert cancel_response["cancelled_before_start"] is True
        assert slot.releases == 1

        # Worker starts anyway; it sees the cancellation and bails before parsing,
        # then runs its finally. The idempotent guard must keep releases at 1.
        vdp.vdp_background_task_spooled(
            job_id,
            str(template_path),
            str(data_path),
            [],
            "csv",
            True,
            str(tmp_path / "out.pdf"),
        )
        assert vdp.vdp_jobs[job_id]["status"] == "cancelled"
        assert slot.releases == 1
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_cooperative_cancel_stops_worker_before_render(monkeypatch, tmp_path):
    slot = _TrackingSlot()
    monkeypatch.setattr(vdp, "_VDP_SUBMISSION_SLOTS", slot)

    rendered = []
    monkeypatch.setattr(vdp, "vdp_background_task", lambda *a, **k: rendered.append(True))

    job_id = "vdp-coop"
    data_path = tmp_path / "data.csv"
    template_path = tmp_path / "template.pdf"
    output_path = tmp_path / "out.pdf"
    data_path.write_text("Name\nA\nB\n", encoding="utf-8")
    template_path.write_bytes(b"%PDF-test")

    # Parsing succeeds, but the cancel signal arrives during it; the worker must
    # observe the flag and stop before calling the (heavy) render stage.
    def fake_load(*_args, **_kwargs):
        vdp.vdp_jobs[job_id]["cancel_requested"] = True
        return [{"Name": "A"}, {"Name": "B"}]

    monkeypatch.setattr(vdp, "_load_spooled_vdp_data", fake_load)

    vdp.vdp_jobs[job_id] = {
        "status": "processing",
        "data_path": str(data_path),
        "template_path": str(template_path),
        "output_path": str(output_path),
        "cancel_requested": False,
    }
    try:
        vdp.vdp_background_task_spooled(
            job_id,
            str(template_path),
            str(data_path),
            [],
            "csv",
            True,
            str(output_path),
        )
        assert rendered == []  # render stage never reached
        assert vdp.vdp_jobs[job_id]["status"] == "cancelled"
        assert slot.releases == 1
        # Cancelled job cleans its spooled inputs.
        assert not data_path.exists()
        assert not template_path.exists()
    finally:
        vdp.vdp_jobs.pop(job_id, None)


def test_cancel_vdp_idempotent_for_missing_and_terminal_jobs():
    missing = vdp.cancel_vdp_job("vdp-missing", {})
    assert missing["status"] == "not_found"
    assert missing["cancelled"] is False

    vdp.vdp_jobs["vdp-done"] = {"status": "completed"}
    try:
        terminal = vdp.cancel_vdp_job("vdp-done", {})
        assert terminal["status"] == "completed"
        assert terminal["cancelled"] is False
    finally:
        vdp.vdp_jobs.pop("vdp-done", None)
