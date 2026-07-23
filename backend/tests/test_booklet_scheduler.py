import asyncio
import threading

import pytest

from app.core import heavy_job_scheduler as scheduler
from app.core.plan_executor import PlanExecutor


class _TrackingSlots:
    def __init__(self):
        self.acquires = 0
        self.releases = 0

    def acquire(self):
        self.acquires += 1
        return True

    def release(self):
        self.releases += 1


def test_plan_executor_delegates_to_booklet_heavy_threadpool(monkeypatch):
    captured = {}

    async def _fake_run(kind, function, *args, **kwargs):
        captured.update(
            kind=kind,
            function=function,
            args=args,
            kwargs=kwargs,
        )
        return "output.pdf"

    monkeypatch.setattr(scheduler, "run_scheduled_in_threadpool", _fake_run)

    result = asyncio.run(PlanExecutor.execute({"sheets": []}, "source.pdf"))

    assert result == "output.pdf"
    assert captured["kind"] == "booklet"
    assert captured["function"] is PlanExecutor._execute_sync


def test_booklet_work_runs_off_loop_and_releases_slot(monkeypatch):
    slots = _TrackingSlots()
    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", slots)
    caller_thread = threading.get_ident()

    worker_thread = asyncio.run(
        scheduler.run_scheduled_in_threadpool(
            "booklet", threading.get_ident,
        )
    )

    assert worker_thread != caller_thread
    assert slots.acquires == 1
    assert slots.releases == 1


def test_booklet_slot_is_released_after_failure(monkeypatch):
    slots = _TrackingSlots()
    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", slots)

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(
            scheduler.run_scheduled_in_threadpool(
                "booklet", lambda: (_ for _ in ()).throw(RuntimeError("boom")),
            )
        )

    assert slots.acquires == 1
    assert slots.releases == 1
