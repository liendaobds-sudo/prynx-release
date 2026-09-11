"""PERF (audit 2026-09-11 §PREWARM): job nháp/cuối, hủy thật và vòng đời phiên."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import pytest

from app.api.routes import sticker_sheet as routes
from app.core import sticker_sheet_session as session_store
from app.core.sticker_sheet_session import StickerSheetPageState, StickerSheetSession
from app.schemas.sticker_sheet import (
    StickerCutlinePreviewJobRequest,
    StickerCutlinePreviewRequest,
)
from app.workers import sticker_cutline_jobs as jobs
from app.workers.cutline_preview_cancel import check_preview_cancelled, current_cancellation


@pytest.fixture(autouse=True)
def isolated_pool(monkeypatch):
    jobs.shutdown_preview_jobs()
    monkeypatch.setattr(jobs, "plan_worker_count", lambda **_options: (4, "test"))
    yield
    jobs.shutdown_preview_jobs()
    assert not jobs._ACTIVE


@pytest.fixture
def gates():
    events = []
    def create():
        event = threading.Event()
        events.append(event)
        return event
    yield create
    for event in events:
        event.set()


@pytest.fixture
def session_factory(tmp_path):
    def create(name="source"):
        directory = tmp_path / name
        directory.mkdir()
        source = directory / "source.pdf"
        source.write_bytes(b"source-data")
        (directory / "labels.npy").write_bytes(b"labels-data")
        (directory / "rgba.png").write_bytes(b"rgba-data")
        page = SimpleNamespace(
            page_number=1, directory=directory, stage="mask-review",
            manifest={"mask_revision": 1}, boundary_source="alpha",
            preview_width_px=600, preview_height_px=500,
            operation_lock=threading.RLock(), cutline_export_cache=None,
        )
        return SimpleNamespace(
            session_id=name, directory=directory, source_path=source,
            source_kind="pdf", operation_lock=threading.RLock(), pages={1: page},
        )
    return create


def options(**overrides):
    payload = {
        "base_revision": 1,
        "classic_whole_page": True,
        "cutline_simplify_mm": 0.1,
        **overrides,
    }
    return StickerCutlinePreviewRequest.model_validate(payload).model_dump()


def result(request, *, segments=7, changed=True):
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    quality = {"segment_count": segments, "machine_safe": True, "fit_mode": "test"}
    if request["cutline_simplify_mm"] > 0:
        quality["simplification"] = {
            "before_segments": 12 if changed else segments,
            "after_segments": segments, "changed": changed,
            "maximum_error_bound_mm": 0.09 if changed else 0.0,
        }
    return {
        "page_number": request["page_number"], "mask_revision": request["base_revision"],
        "preview_width_px": 600, "preview_height_px": 500,
        "paths": [{"instance_id": 1, "d": "M 0 0 C 0 1 1 1 0 0 Z",
                   "segment_count": segments, "quality": quality}],
        "fingerprint": fingerprint, "segment_count": segments, "quality": quality,
        "classic_whole_page": request["classic_whole_page"],
    }


def settle(session, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        with session.operation_lock:
            active = list(jobs._state(session).active.values())
        if not active:
            return
        if time.monotonic() >= deadline:
            pytest.fail("Worker xem trước không kết thúc đúng hạn")
        for record in active:
            if record.future is not None:
                record.future.result(timeout=max(0.01, deadline - time.monotonic()))
        threading.Event().wait(0.001)


def test_draft_then_final_keeps_true_tolerance_and_scope(monkeypatch, session_factory, gates):
    session = session_factory()
    entered, release = gates(), gates()
    calls, tokens = [], []
    def build(_session, request):
        calls.append(request["cutline_simplify_mm"])
        tokens.append(current_cancellation())
        if request["cutline_simplify_mm"] > 0:
            entered.set()
            assert release.wait(5)
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    created = jobs.start_preview_job(session, options(classic_whole_page=False), 1)
    assert entered.wait(5)
    middle = jobs.read_preview_job(session, created["job_id"])
    assert middle["status"] == "simplifying"
    assert middle["draft"] is not None and middle["result"] is None
    assert middle["target_simplify_mm"] == 0.1
    release.set()
    settle(session)
    final = jobs.read_preview_job(session, created["job_id"])
    assert final["status"] == "ready" and final["result"] is not None
    assert calls == [0.0, 0.1]
    assert tokens[0] is tokens[1] and tokens[0] is not None
    assert tokens[0]._closed and current_cancellation() is None


def test_whole_page_simplify_skips_unused_draft(monkeypatch, session_factory):
    session = session_factory()
    calls = []

    def build(_session, request):
        calls.append(request["cutline_simplify_mm"])
        return result(request)

    monkeypatch.setattr(jobs, "_build_preview", build)
    created = jobs.start_preview_job(session, options(), 1)
    settle(session)
    final = jobs.read_preview_job(session, created["job_id"])
    assert calls == [0.1]
    assert final["status"] == "ready" and final["draft"] is None


def test_explicit_zero_builds_once_without_background_simplify(monkeypatch, session_factory):
    session = session_factory()
    calls = []
    def build(_session, request):
        calls.append(request["cutline_simplify_mm"])
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    created = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    settle(session)
    final = jobs.read_preview_job(session, created["job_id"])
    assert calls == [0.0]
    assert final["status"] == "ready" and final["draft"] is None


def test_noop_verified_final_is_still_ready(monkeypatch, session_factory):
    session = session_factory()
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: result(request, changed=False))
    created = jobs.start_preview_job(session, options(), 1)
    settle(session)
    final = jobs.read_preview_job(session, created["job_id"])
    assert final["status"] == "ready"
    assert final["result"]["quality"]["simplification"]["changed"] is False


def test_same_generation_is_idempotent_and_different_options_conflict(monkeypatch, session_factory):
    session = session_factory()
    calls = []
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: calls.append(request) or result(request))
    first = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 4)
    settle(session)
    again = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 4)
    assert again["job_id"] == first["job_id"] and len(calls) == 1
    with pytest.raises(jobs.PreviewJobConflict):
        jobs.start_preview_job(session, options(offset_mm=2), 4)
    with pytest.raises(jobs.PreviewJobConflict):
        jobs.start_preview_job(session, options(), 3)


def test_delete_before_post_creates_tombstone(monkeypatch, session_factory):
    session = session_factory()
    calls = []
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: calls.append(request) or result(request))
    assert jobs.cancel_preview_job(session, 8)
    assert not jobs.cancel_preview_job(session, 8)
    for generation in (0, 7, 8):
        with pytest.raises(jobs.PreviewJobConflict):
            jobs.start_preview_job(session, options(), generation)
    assert not calls
    created = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 9)
    settle(session)
    assert jobs.read_preview_job(session, created["job_id"])["status"] == "ready"


@pytest.mark.parametrize("whole_page", [False, True])
def test_running_supersede_signals_solver_and_rejects_stale_completion(monkeypatch, session_factory, gates, whole_page):
    session = session_factory()
    entered, release = gates(), gates()
    calls, old_token = [], []
    original = {"fingerprint": "approved-original"}
    session.pages[1].cutline_export_cache = original
    def build(_session, request):
        calls.append((request["offset_mm"], request["cutline_simplify_mm"]))
        if request["offset_mm"] == 0 and request["cutline_simplify_mm"] > 0:
            old_token.append(current_cancellation())
            entered.set()
            assert release.wait(5)
            # Giả lập native chưa chạm checkpoint: kết quả cũ vẫn phải bị chặn.
        _session.pages[1].cutline_export_cache = {"offset": request["offset_mm"]}
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    first = jobs.start_preview_job(session, options(classic_whole_page=whole_page), 1)
    assert entered.wait(5)
    second = jobs.start_preview_job(session, options(classic_whole_page=whole_page, offset_mm=2), 2)
    assert jobs.read_preview_job(session, first["job_id"])["status"] == "cancelled"
    assert not old_token[0]._closed
    with pytest.raises(jobs.PreviewCancelled):
        old_token[0].check()
    release.set()
    settle(session)
    assert old_token[0]._closed
    assert jobs.read_preview_job(session, second["job_id"])["status"] == "ready"
    assert session.pages[1].cutline_export_cache == {"offset": 2}
    with pytest.raises(jobs.PreviewJobNotFound):
        jobs.read_preview_job(session, first["job_id"])
    expected_calls = [(0, 0.1), (2, 0.1)] if whole_page else [(0, 0), (0, 0.1), (2, 0), (2, 0.1)]
    assert calls == expected_calls


def test_queued_supersede_never_invokes_old_builder(monkeypatch, session_factory, gates):
    session = session_factory()
    entered, release = gates(), gates()
    pool = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(jobs, "_POOL", pool)
    def occupy():
        entered.set()
        assert release.wait(5)
    blocker = pool.submit(occupy)
    assert entered.wait(5)
    calls = []
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: calls.append(request["offset_mm"]) or result(request))
    jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    old = jobs._state(session).latest
    newest = jobs.start_preview_job(session, options(offset_mm=3, cutline_simplify_mm=0), 2)
    assert old.future.cancelled() and old.token._closed
    release.set()
    blocker.result(timeout=5)
    settle(session)
    assert calls == [3]
    assert jobs.read_preview_job(session, newest["job_id"])["status"] == "ready"


@pytest.mark.parametrize("change", ["revision", "source", "page", "size"])
def test_changed_source_or_revision_cannot_publish(monkeypatch, session_factory, gates, change):
    session = session_factory()
    entered, release = gates(), gates()
    original = {"approved": True}
    session.pages[1].cutline_export_cache = original
    def build(_session, request):
        entered.set()
        assert release.wait(5)
        _session.pages[1].cutline_export_cache = {"not-approved": True}
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    created = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    old_page = session.pages[1]
    assert entered.wait(5)
    if change == "revision":
        old_page.manifest["mask_revision"] = 2
    elif change == "source":
        session.source_path.write_bytes(b"changed-data")
    elif change == "page":
        session.pages[1] = deepcopy_page(old_page)
    else:
        old_page.preview_width_px = 900
    release.set()
    settle(session)
    final = jobs.read_preview_job(session, created["job_id"])
    assert final["status"] == "cancelled" and final["result"] is None
    assert old_page.cutline_export_cache is original


def deepcopy_page(page):
    copied = {key: deepcopy(value) for key, value in vars(page).items() if key != "operation_lock"}
    return SimpleNamespace(**copied, operation_lock=threading.RLock())


def test_close_defers_cleanup_until_all_superseded_workers_exit(monkeypatch, session_factory, gates):
    session = session_factory()
    entered, release, cleaned = gates(), gates(), gates()
    tokens, cleanups = [], []
    def build(_session, request):
        tokens.append(current_cancellation())
        entered.set()
        assert release.wait(5)
        assert session.source_path.exists()
        check_preview_cancelled()
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    assert entered.wait(5)
    jobs.start_preview_job(session, options(offset_mm=1), 2)
    def cleanup():
        assert all(token._closed for token in tokens)
        cleanups.append(1)
        cleaned.set()
    assert jobs.defer_preview_cleanup(session, cleanup)
    assert (session.directory / ".cutline-closing").is_file()
    assert not cleanups and not tokens[0]._closed
    assert jobs.defer_preview_cleanup(session, lambda: cleanups.append(99))
    with pytest.raises(jobs.PreviewJobConflict):
        jobs.start_preview_job(session, options(), 3)
    release.set()
    settle(session)
    assert cleaned.wait(5)
    assert cleanups == [1]


def test_close_without_jobs_does_not_defer_or_call_cleanup(session_factory):
    session = session_factory()
    cleanups = []
    assert not jobs.defer_preview_cleanup(session, lambda: cleanups.append(1))
    assert not cleanups
    assert not (session.directory / ".cutline-closing").exists()
    with pytest.raises(jobs.PreviewJobConflict):
        jobs.start_preview_job(session, options(), 1)


def test_marker_blocks_recovered_session(session_factory):
    session = session_factory()
    (session.directory / ".cutline-closing").touch()
    with pytest.raises(jobs.PreviewJobConflict):
        jobs.start_preview_job(session, options(), 1)


def test_foreign_and_missing_job_ids_are_isolated(monkeypatch, session_factory):
    first, second = session_factory("first"), session_factory("second")
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: result(request))
    created = jobs.start_preview_job(first, options(cutline_simplify_mm=0), 1)
    settle(first)
    for session, job_id in ((second, created["job_id"]), (first, "missing")):
        with pytest.raises(jobs.PreviewJobNotFound):
            jobs.read_preview_job(session, job_id)
    jobs.cancel_preview_job(second, 100)
    assert jobs.read_preview_job(first, created["job_id"])["status"] == "ready"


def test_envelope_is_independent_and_excludes_private_state(monkeypatch, session_factory):
    session = session_factory()
    def build(_session, request):
        return result(request) | {"memo": {"private": "secret"}, "source_path": "secret.pdf", "shared_name": "secret"}
    monkeypatch.setattr(jobs, "_build_preview", build)
    request = options(cutline_simplify_mm=0)
    created = jobs.start_preview_job(session, request, 1)
    request["offset_mm"] = 8
    settle(session)
    snapshot = jobs.read_preview_job(session, created["job_id"])
    assert not {"memo", "source_path", "shared_name"}.intersection(snapshot["result"])
    snapshot["result"]["paths"][0]["d"] = "corrupted"
    assert jobs.read_preview_job(session, created["job_id"])["result"]["paths"][0]["d"] != "corrupted"
    assert jobs._state(session).latest.options["offset_mm"] == 0


@pytest.mark.parametrize("whole_page", [False, True])
def test_failure_keeps_draft_noncanonical_and_does_not_expose_exception(monkeypatch, session_factory, whole_page):
    session = session_factory()
    original = {"approved": True}
    session.pages[1].cutline_export_cache = original
    def build(_session, request):
        if request["cutline_simplify_mm"] > 0:
            raise RuntimeError("D:/private/customer-source.pdf")
        _session.pages[1].cutline_export_cache = {"draft-only": True}
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    created = jobs.start_preview_job(session, options(classic_whole_page=whole_page), 1)
    settle(session)
    snapshot = jobs.read_preview_job(session, created["job_id"])
    assert snapshot["status"] == "failed" and snapshot["result"] is None
    assert (snapshot["draft"] is None) is whole_page
    assert "private" not in snapshot["error"]
    assert session.pages[1].cutline_export_cache is original


def test_malformed_builder_result_is_not_ready(monkeypatch, session_factory):
    session = session_factory()
    monkeypatch.setattr(jobs, "_build_preview", lambda *_args: {"paths": []})
    created = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    settle(session)
    assert jobs.read_preview_job(session, created["job_id"])["status"] == "failed"


def test_whole_page_final_cache_is_used_before_draft(monkeypatch, session_factory):
    from app.workers.sticker_classic_page_preview import source_digest, whole_page_key
    session = session_factory()
    request = options()
    page = session.pages[1]
    geometry = {key: request[key] for key in (
        "offset_mm", "bleed_mm", "cut_mode", "corner_style", "fill_holes",
        "cutline_smoothness", "cutline_fidelity", "curve_tension",
        "min_detail_area_mm2", "cutline_denoise", "cutline_simplify_mm")}
    geometry.update(shape_mode="auto_safe", cutline_denoise=0.0)
    digest = source_digest(session.source_path)
    key = whole_page_key(digest, 1, 1, geometry, (600, 500))
    page._classic_preview_history = {"identity": (digest, 1, 1), "entries": {key: {"preview": result(request)}}}
    calls = []
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, value: calls.append(value["cutline_simplify_mm"]) or result(value))
    created = jobs.start_preview_job(session, request, 1)
    settle(session)
    assert calls == [0.1]
    assert jobs.read_preview_job(session, created["job_id"])["draft"] is None


@pytest.mark.parametrize("mutation", [None, "source", "size", "options"])
def test_instance_final_history_matches_source_size_and_all_options(monkeypatch, session_factory, mutation):
    from app.workers.sticker_cutline_preview import _preview_source_key
    session = session_factory()
    request = options(classic_whole_page=False)
    page = session.pages[1]
    stored = jobs._builder_options(request)
    stored["dpi_y"] = stored["dpi"]
    page.cutline_preview_fit_cache = {
        "source_key": _preview_source_key(session, page),
        "entries": {"frame": {"options": stored, "response": result(request)}},
    }
    if mutation == "source":
        (page.directory / "rgba.png").write_bytes(b"changed-mask")
    elif mutation == "size":
        page.preview_width_px = 800
    elif mutation == "options":
        request["offset_mm"] = 4
    calls = []
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, value: calls.append(value["cutline_simplify_mm"]) or result(value))
    created = jobs.start_preview_job(session, request, 1)
    settle(session)
    assert calls == ([0.1] if mutation is None else [0.0, 0.1])
    assert jobs.read_preview_job(session, created["job_id"])["status"] == "ready"


@pytest.mark.parametrize("whole", [False, True])
def test_dispatch_preserves_canonical_builder_contract(monkeypatch, session_factory, whole):
    from app.workers import sticker_classic_page_preview, sticker_cutline_preview
    session = session_factory()
    request = options(classic_whole_page=whole, classic_force_contour=True, cutline_simplify_mm=0)
    calls = []
    def build(_session, **kwargs):
        calls.append(kwargs)
        return result(request)
    target = sticker_classic_page_preview if whole else sticker_cutline_preview
    name = "build_classic_page_preview" if whole else "build_sticker_cutline_preview"
    monkeypatch.setattr(target, name, build)
    created = jobs.start_preview_job(session, request, 1)
    settle(session)
    assert len(calls) == 1 and "classic_whole_page" not in calls[0]
    assert ("classic_force_contour" in calls[0]) is whole
    assert calls[0]["base_revision"] == 1 and calls[0]["cutline_simplify_mm"] == 0
    assert jobs.read_preview_job(session, created["job_id"])["status"] == "ready"


def test_pool_uses_hardware_policy_without_unconditional_ceiling(monkeypatch, session_factory):
    session = session_factory()
    calls = []
    monkeypatch.setattr(jobs, "plan_worker_count", lambda **kwargs: calls.append(kwargs) or (7, "full"))
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: result(request))
    jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    settle(session)
    assert calls == [{"kind": "cutline-prewarm", "per_worker_mb": 256.0,
                      "env_override": "PRYNX_CUTLINE_PREWARM_WORKERS"}]
    assert jobs._POOL._max_workers == 7


def test_shutdown_waits_for_actual_cooperative_cancellation(monkeypatch, session_factory, gates):
    session = session_factory()
    entered, stopped = gates(), gates()
    tokens = []
    def build(_session, request):
        token = current_cancellation()
        tokens.append(token)
        entered.set()
        try:
            assert token._event.wait(5)
            check_preview_cancelled()
        finally:
            stopped.set()
        return result(request)
    monkeypatch.setattr(jobs, "_build_preview", build)
    created = jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
    assert entered.wait(5)
    jobs.shutdown_preview_jobs()
    assert stopped.is_set() and tokens[0]._closed and jobs._POOL is None
    assert not jobs._ACTIVE
    assert jobs.read_preview_job(session, created["job_id"])["status"] == "cancelled"


def test_job_routes_start_read_and_cancel_are_session_scoped(monkeypatch, session_factory):
    session = session_factory()
    session.session_id = "a" * 32
    monkeypatch.setattr(routes, "get_session", lambda session_id: session if session_id == session.session_id else None)
    monkeypatch.setattr(jobs, "_build_preview", lambda _session, request: result(request))
    request = StickerCutlinePreviewJobRequest(
        generation=1,
        **options(cutline_simplify_mm=0),
    )

    started = asyncio.run(routes.start_sticker_cutline_preview_job_endpoint(session.session_id, request))
    assert started["generation"] == 1
    assert "generation" not in jobs._state(session).latest.options
    settle(session)

    read = asyncio.run(routes.read_sticker_cutline_preview_job_endpoint(
        session.session_id, started["job_id"],
    ))
    assert read["status"] == "ready" and read["result"]["fingerprint"]

    cancelled = asyncio.run(routes.cancel_sticker_cutline_preview_job_endpoint(
        session.session_id, 2,
    ))
    assert cancelled == {"cancelled": True}
    with pytest.raises(jobs.PreviewJobConflict):
        jobs.start_preview_job(session, options(cutline_simplify_mm=0), 2)


def test_cancel_route_is_idempotent_after_session_cleanup(monkeypatch):
    monkeypatch.setattr(routes, "get_session", lambda _session_id: None)
    assert asyncio.run(routes.cancel_sticker_cutline_preview_job_endpoint(
        "c" * 32, 5,
    )) == {"cancelled": False}


def test_close_session_waits_for_preview_worker_before_removing_artifacts(monkeypatch, tmp_path, gates):
    root = tmp_path / "sessions"
    root.mkdir()
    session_id = "b" * 32
    directory = root / session_id
    directory.mkdir()
    source = directory / "source.pdf"
    source.write_bytes(b"source-data")
    (directory / "labels.npy").write_bytes(b"labels-data")
    (directory / "rgba.png").write_bytes(b"rgba-data")
    page = StickerSheetPageState(
        page_number=1, directory=directory, analysis_source_path=None,
        original_width_px=None, original_height_px=None, analysis_width_px=None,
        analysis_height_px=None, preview_width_px=600, preview_height_px=500,
        dpi=None, stage="mask-review", boundary_source="alpha",
        strategy_confidence=1.0, needs_review=False, manifest={"mask_revision": 1},
    )
    session = StickerSheetSession(
        session_id=session_id, directory=directory, source_path=source,
        analysis_source_path=None, original_name="source.pdf", original_width_px=None,
        original_height_px=None, analysis_width_px=None, analysis_height_px=None,
        preview_width_px=600, preview_height_px=500, dpi=None, stage="mask-review",
        source_kind="pdf", boundary_source="alpha", strategy_confidence=1.0,
        needs_review=False, page_count=1, manifest=page.manifest,
        last_access=time.monotonic(), pages={1: page},
    )
    monkeypatch.setattr(session_store, "SESSION_ROOT", root)
    with session_store._STORE_LOCK:
        session_store._SESSIONS[session_id] = session
    entered, release = gates(), gates()

    def build(_session, request):
        entered.set()
        assert release.wait(5)
        assert source.exists()
        check_preview_cancelled()
        return result(request)

    monkeypatch.setattr(jobs, "_build_preview", build)
    try:
        jobs.start_preview_job(session, options(cutline_simplify_mm=0), 1)
        assert entered.wait(5)
        assert session_store.close_session(session_id) is True
        assert (directory / ".cutline-closing").is_file()
        assert source.exists()
        assert session_store.get_session(session_id) is None
        release.set()
        settle(session)
        deadline = time.monotonic() + 5
        while directory.exists() and time.monotonic() < deadline:
            threading.Event().wait(0.01)
        assert not directory.exists()
    finally:
        release.set()
        with session_store._STORE_LOCK:
            session_store._SESSIONS.pop(session_id, None)
