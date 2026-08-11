import asyncio
import threading

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


def test_memory_reservation_queues_second_job_and_releases_after_success(monkeypatch):
    """§US.04: job sau phải chờ byte reservation, không cùng hứa một ngân sách RAM."""

    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", threading.BoundedSemaphore(2))
    first_started = threading.Event()
    allow_first_finish = threading.Event()
    second_started = threading.Event()

    def first_job(**_kwargs):
        first_started.set()
        assert allow_first_finish.wait(timeout=2)

    def second_job(**_kwargs):
        second_started.set()

    async def scenario():
        first = asyncio.create_task(
            scheduler.run_scheduled_in_threadpool(
                "upscale-memory-test",
                first_job,
                memory_required_mb=70.0,
                memory_budget_provider=lambda: 100.0,
            )
        )
        while not first_started.is_set():
            await asyncio.sleep(0.01)

        second = asyncio.create_task(
            scheduler.run_scheduled_in_threadpool(
                "upscale-memory-test",
                second_job,
                memory_required_mb=40.0,
                memory_budget_provider=lambda: 100.0,
            )
        )
        await asyncio.sleep(0.12)
        assert not second_started.is_set()

        allow_first_finish.set()
        await asyncio.gather(first, second)

    asyncio.run(scenario())
    assert second_started.is_set()


def test_memory_reservation_does_not_divide_single_job_by_worker_count(monkeypatch):
    """§US.04: máy mạnh còn RAM phải cho một job lớn dùng trọn ngân sách khả dụng."""

    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", threading.BoundedSemaphore(4))
    result = asyncio.run(
        scheduler.run_scheduled_in_threadpool(
            "upscale-large-single-test",
            lambda **_kwargs: "ok",
            memory_required_mb=90.0,
            memory_budget_provider=lambda: 100.0,
        )
    )

    assert result == "ok"


def test_memory_reservation_rejects_job_larger_than_standalone_budget(monkeypatch):
    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", threading.BoundedSemaphore(2))

    with pytest.raises(scheduler.HeavyJobMemoryUnavailable):
        asyncio.run(
            scheduler.run_scheduled_in_threadpool(
                "upscale-too-large-test",
                lambda **_kwargs: None,
                memory_required_mb=101.0,
                memory_budget_provider=lambda: 100.0,
            )
        )


def test_memory_reservation_waiter_can_cancel_without_leaking(monkeypatch):
    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", threading.BoundedSemaphore(2))
    first_started = threading.Event()
    allow_first_finish = threading.Event()
    cancel_second = threading.Event()
    second_started = threading.Event()

    def first_job():
        first_started.set()
        assert allow_first_finish.wait(timeout=2)

    def second_job():
        second_started.set()

    async def scenario():
        first = asyncio.create_task(
            scheduler.run_scheduled_in_threadpool(
                "upscale-memory-cancel-test",
                first_job,
                memory_required_mb=70.0,
                memory_budget_provider=lambda: 100.0,
            )
        )
        while not first_started.is_set():
            await asyncio.sleep(0.01)
        second = asyncio.create_task(
            scheduler.run_scheduled_in_threadpool(
                "upscale-memory-cancel-test",
                second_job,
                queue_cancelled=cancel_second.is_set,
                memory_required_mb=40.0,
                memory_budget_provider=lambda: 100.0,
            )
        )
        try:
            await asyncio.sleep(0.08)
            cancel_second.set()
            with pytest.raises(scheduler.HeavyJobQueueCancelled):
                await asyncio.wait_for(second, timeout=1)
            assert not second_started.is_set()
        finally:
            allow_first_finish.set()
            await first

    asyncio.run(scenario())
