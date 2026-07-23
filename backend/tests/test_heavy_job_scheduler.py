import pytest

from app.core import heavy_job_scheduler as scheduler


class TrackingSlots:
    def __init__(self):
        self.acquires = 0
        self.releases = 0

    def acquire(self):
        self.acquires += 1
        return True

    def release(self):
        self.releases += 1


def test_scheduled_job_releases_global_slot_after_failure(monkeypatch):
    slots = TrackingSlots()
    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", slots)

    @scheduler.scheduled_job("test")
    def fail():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        fail()

    assert slots.acquires == 1
    assert slots.releases == 1
