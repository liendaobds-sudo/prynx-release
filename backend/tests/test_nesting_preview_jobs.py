"""PV-A1 — lifecycle, progress/cancel và subscriber của preview nesting."""

from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.nesting_preview_jobs import NestingPreviewJobRegistry
from app.core.nesting_preview_session import (
    NestingPreviewSessionStore,
    NestingPreviewWaitTimeout,
)


def _session(tag: str = "ok"):
    return SimpleNamespace(
        tag=tag,
        source_pins=(),
        solved=SimpleNamespace(manifest={"stats": {"placedCount": 4, "sheetCount": 1}}),
    )


def _same_identity(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.core.nesting_preview_session.job_identity_key",
        lambda _job: ("same",),
    )


def _wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Hết thời gian chờ điều kiện test.")


async def _wait_async(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Hết thời gian chờ điều kiện test.")


def test_hai_subscriber_chi_solve_mot_lan_va_huy_a_khong_giet_b(monkeypatch):
    _same_identity(monkeypatch)
    started = threading.Event()
    release = threading.Event()
    calls: list[int] = []

    def solver(_job, *, cancel_event, progress_callback):
        calls.append(1)
        started.set()
        progress_callback({"phase": "solving", "progress": 0.4})
        assert release.wait(2.0)
        assert not cancel_event.is_set(), "A rời nhưng B còn sống thì native không được hủy"
        return _session()

    store = NestingPreviewSessionStore(capacity=2, solver=solver)
    progress_b: list[float] = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        owner = executor.submit(
            store.get_or_solve, object(), subscriber_id="A"
        )
        assert started.wait(1.0)
        follower = executor.submit(
            store.get_or_solve,
            object(),
            subscriber_id="B",
            progress_callback=lambda value: progress_b.append(value["progress"]),
        )
        _wait_until(lambda: len(next(iter(store._inflight.values())).subscribers) == 2)

        assert store.cancel_subscriber("A") is True
        assert not next(iter(store._inflight.values())).shared_cancel_event.is_set()
        release.set()

        with pytest.raises(InterruptedError):
            owner.result(timeout=2.0)
        assert follower.result(timeout=2.0).session.tag == "ok"

    assert calls == [1]
    assert progress_b == [0.4]
    assert store._inflight == {}


def test_subscriber_cuoi_huy_native_va_luot_sau_retry_duoc(monkeypatch):
    _same_identity(monkeypatch)
    started = threading.Event()
    calls = 0

    def solver(_job, *, cancel_event, progress_callback):
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            assert cancel_event.wait(2.0)
            raise InterruptedError("native đã nhận cancel")
        return _session("retry")

    store = NestingPreviewSessionStore(capacity=2, solver=solver)
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(
            store.get_or_solve, object(), subscriber_id="only"
        )
        assert started.wait(1.0)
        assert store.cancel_subscriber("only") is True
        with pytest.raises(InterruptedError):
            first.result(timeout=2.0)

    assert store._inflight == {}
    retry = store.get_or_solve(object(), subscriber_id="retry")
    assert retry.session.tag == "retry"
    assert calls == 2


def test_cancel_event_rieng_tu_dong_tach_subscriber_cuoi(monkeypatch):
    _same_identity(monkeypatch)
    started = threading.Event()
    cancelled = threading.Event()

    def solver(_job, *, cancel_event, **_kwargs):
        started.set()
        assert cancel_event.wait(2.0)
        raise InterruptedError("đã hủy")

    store = NestingPreviewSessionStore(capacity=2, solver=solver)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            store.get_or_solve,
            object(),
            subscriber_id="event-only",
            cancel_event=cancelled,
        )
        assert started.wait(1.0)
        cancelled.set()
        with pytest.raises(InterruptedError):
            future.result(timeout=2.0)

    assert store._inflight == {}
    assert len(store) == 0, "cancel phải thắng chốt công bố session"


def test_peek_or_wait_co_timeout_huu_han(monkeypatch):
    _same_identity(monkeypatch)
    started = threading.Event()
    release = threading.Event()

    def solver(_job, **_kwargs):
        started.set()
        assert release.wait(2.0)
        return _session()

    store = NestingPreviewSessionStore(capacity=2, solver=solver)
    with ThreadPoolExecutor(max_workers=1) as executor:
        owner = executor.submit(store.get_or_solve, object())
        assert started.wait(1.0)
        began = time.monotonic()
        with pytest.raises(NestingPreviewWaitTimeout):
            store.peek_or_wait(object(), timeout=0.05)
        assert time.monotonic() - began < 0.5
        release.set()
        owner.result(timeout=2.0)


@pytest.mark.asyncio
async def test_registry_tra_ngay_progress_khong_giam_va_completed_co_result():
    started = threading.Event()
    release = threading.Event()
    expected = {"success": True, "cells": [{"pageIdx": 0}]}

    def runner(_request, *, progress_callback, **_kwargs):
        started.set()
        progress_callback({"phase": "solving", "progress": 0.7, "attempt": 3})
        progress_callback({"phase": "solving", "progress": 0.2, "attempt": 1})
        assert release.wait(2.0)
        return expected

    registry = NestingPreviewJobRegistry(runner=runner)
    accepted = registry.submit(owner="owner-a", request=object(), source_path="x.pdf")
    assert accepted.status == "queued"
    assert accepted.terminal is False
    assert registry.get_result(accepted.job_id, "owner-a") is None

    assert await asyncio.to_thread(started.wait, 1.0)
    await _wait_async(
        lambda: (registry.get(accepted.job_id, "owner-a").progress or {}).get("progress")
        == 0.7
    )
    running = registry.get(accepted.job_id, "owner-a")
    assert running.status == "running"
    assert running.progress["attempt"] == 3

    release.set()
    await _wait_async(lambda: registry.get(accepted.job_id, "owner-a").terminal)
    completed = registry.get(accepted.job_id, "owner-a")
    assert completed.status == "completed"
    assert completed.progress["progress"] == 1.0
    assert registry.get_result(accepted.job_id, "owner-a") == expected


@pytest.mark.asyncio
async def test_cancel_idempotent_va_publication_fence_khong_giu_result():
    started = threading.Event()

    def runner(_request, *, cancel_event, **_kwargs):
        started.set()
        assert cancel_event.wait(2.0)
        # Mô phỏng native trả muộn dù cancel: registry vẫn phải bỏ kết quả.
        return {"success": True, "late": True}

    registry = NestingPreviewJobRegistry(runner=runner)
    accepted = registry.submit(owner="owner-a", request=object(), source_path="x.pdf")
    assert await asyncio.to_thread(started.wait, 1.0)

    first = registry.cancel(accepted.job_id, "owner-a")
    second = registry.cancel(accepted.job_id, "owner-a")
    assert first.cancelled is True and first.already_cancelled is False
    assert second.cancelled is True and second.already_cancelled is True
    await _wait_async(lambda: registry.get(accepted.job_id, "owner-a").terminal)
    assert registry.get(accepted.job_id, "owner-a").status == "cancelled"
    assert registry.get_result(accepted.job_id, "owner-a") is None


@pytest.mark.asyncio
async def test_cancel_khi_con_queued_khong_chay_solver():
    calls: list[int] = []

    def runner(_request, **_kwargs):
        calls.append(1)
        return {"success": True}

    registry = NestingPreviewJobRegistry(runner=runner)
    accepted = registry.submit(owner="owner-a", request=object(), source_path="x.pdf")
    outcome = registry.cancel(accepted.job_id, "owner-a")
    assert outcome.status == "cancelled"
    await asyncio.sleep(0)
    assert calls == []
    assert registry.get_result(accepted.job_id, "owner-a") is None


@pytest.mark.asyncio
async def test_route_202_result_409_owner_isolation_va_sync_cu_van_chay(monkeypatch):
    from app.api.routes import imposition as route
    from app.core import nesting_preview_jobs as jobs_module

    started = threading.Event()
    release = threading.Event()
    result = {"success": True, "strategyUsed": "true_shape_nesting", "cells": []}

    def runner(_request, **_kwargs):
        started.set()
        assert release.wait(2.0)
        return result

    registry = NestingPreviewJobRegistry(runner=runner)
    monkeypatch.setattr(jobs_module, "nesting_preview_jobs", registry)
    monkeypatch.setattr(route, "enforce_feature", lambda *_args, **_kwargs: None)
    req = route.PreviewLayoutRequest(
        usable_w=100,
        usable_h=100,
        item_w=10,
        item_h=10,
        gap_x=1,
        gap_y=1,
        strategy="true_shape_nesting",
        is_die_cut=True,
        task_mode="nup",
        sheet_w=100,
        sheet_h=100,
        path="x.pdf",
    )
    owner_a = {"license_key": "A", "hwid": "machine"}
    owner_b = {"license_key": "B", "hwid": "machine"}

    accepted = await route.create_nesting_preview_job(req, owner_a)
    assert accepted["status"] == "queued"
    assert len(accepted["job_id"]) == 32
    assert await asyncio.to_thread(started.wait, 1.0)

    with pytest.raises(HTTPException) as pending:
        route.get_nesting_preview_job_result(accepted["job_id"], owner_a)
    assert pending.value.status_code == 409
    with pytest.raises(HTTPException) as hidden:
        route.get_nesting_preview_job(accepted["job_id"], owner_b)
    assert hidden.value.status_code == 404

    release.set()
    await _wait_async(
        lambda: route.get_nesting_preview_job(accepted["job_id"], owner_a)["terminal"]
    )
    assert route.get_nesting_preview_job_result(accepted["job_id"], owner_a) == result

    # Endpoint sync cũ vẫn đi đúng hàm projection, không bị buộc qua lifecycle job.
    monkeypatch.setattr(
        "app.core.nesting_preview_capacity.build_nesting_preview",
        lambda *_args, **_kwargs: result,
    )
    assert route.preview_layout(req, owner_a) == result


def test_true_shape_projection_gan_kind_ring_cho_contour_11_diem(monkeypatch):
    from app.core import nesting_preview_capacity as preview_capacity

    ring = [[float(index), float(index % 3)] for index in range(11)]
    monkeypatch.setattr(
        preview_capacity,
        "_placed_rings_mm",
        lambda *_args, **_kwargs: [ring],
    )
    job = SimpleNamespace(
        sheet_height_mm=100.0,
        parts=(SimpleNamespace(part_id="part-1", page_index=0),),
    )
    session = SimpleNamespace(
        solved=SimpleNamespace(
            production_request=SimpleNamespace(
                render_bundle={
                    "parts": [{"partId": "part-1"}],
                    "sheetFrames": {"cut": [0.0, 0.0, 100.0, 100.0]},
                },
                render_bundle_hash="bundle-hash",
            ),
            manifest={
                "placements": [{"sheetIndex": 0, "partId": "part-1"}],
            },
        ),
    )

    cells = preview_capacity._project_sheet_cells(job, session, sheet_index=0)

    assert len(cells) == 1
    assert len(cells[0]["diePolylines"][0]) == 11
    assert cells[0]["diePolylineKinds"] == ["ring"]
