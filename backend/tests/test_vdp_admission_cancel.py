"""Regression cho VDP rời hàng admission khi người dùng hủy job."""

import threading
import time

import pytest

from app.core import heavy_job_scheduler as scheduler


def test_scheduled_job_queue_cancelled_factory_releases_waiting_slot(monkeypatch):
    monkeypatch.setattr(scheduler, "_HEAVY_JOB_SLOTS", threading.BoundedSemaphore(1))
    first_started = threading.Event()
    release_first = threading.Event()
    cancel_second = threading.Event()
    second_started = threading.Event()
    errors = []

    def first_worker():
        with scheduler.heavy_job_slot("vdp-cancel-test"):
            first_started.set()
            assert release_first.wait(timeout=2)

    first = threading.Thread(target=first_worker)
    first.start()
    assert first_started.wait(timeout=1)

    @scheduler.scheduled_job(
        "vdp-cancel-test",
        queue_cancelled_factory=lambda _job_id: cancel_second.is_set,
    )
    def second_worker(_job_id):
        second_started.set()

    def run_second():
        try:
            second_worker("job-2")
        except BaseException as error:  # thread boundary: assert below
            errors.append(error)

    second = threading.Thread(target=run_second)
    second.start()
    time.sleep(0.1)
    cancel_second.set()
    second.join(timeout=1)
    release_first.set()
    first.join(timeout=1)

    assert not second.is_alive()
    assert isinstance(errors[0], scheduler.HeavyJobQueueCancelled)
    assert not second_started.is_set()
    assert scheduler._WAITING_BY_KIND.get("vdp-cancel-test", 0) == 0
    assert scheduler._ACTIVE_BY_KIND.get("vdp-cancel-test", 0) == 0


def test_process_pool_admission_checks_cancel_before_env_fast_path(monkeypatch):
    monkeypatch.setenv("PRYNX_VDP_TEST_WORKERS", "4")
    with pytest.raises(scheduler.HeavyJobQueueCancelled):
        with scheduler.process_pool_admission(
            "vdp-cancel-test",
            4,
            10.0,
            env_override="PRYNX_VDP_TEST_WORKERS",
            budget_provider=lambda: 100.0,
            queue_cancelled=lambda: True,
        ):
            pytest.fail("Job đã hủy không được vào fast-path admission")


def test_process_pool_admission_checks_cancel_before_unknown_budget_fast_path():
    with pytest.raises(scheduler.HeavyJobQueueCancelled):
        with scheduler.process_pool_admission(
            "vdp-cancel-test",
            4,
            10.0,
            budget_provider=lambda: None,
            queue_cancelled=lambda: True,
        ):
            pytest.fail("Job đã hủy không được vào fast-path telemetry unknown")

