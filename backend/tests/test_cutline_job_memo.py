"""Memo trong một job: chỉ dùng chung hình học/thông số giống hệt đã kiểm."""
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from copy import deepcopy
from threading import Event, Lock
import time

import pytest

from app.workers import cutline_simplify_memo as memo
from app.workers.cutline_preview_cancel import (
    PreviewCancellation, PreviewCancelled, cancellation_scope,
)


def _groups(marker="current"):
    return [{"marker": marker, "exterior": [((0., 0.), (1., 0.), (1., 1.), (0., 0.))],
             "interiors": []}]


def _solver(calls, action=None, changed=True):
    @memo.memoized_simplify
    def solve(path_groups, *, tolerance_mm=.1, mm_to_units=1., offset_x_points=0.,
              offset_y_points=0., page_height=10., prefer_conservative=False,
              preview_fast=True, max_candidate_attempts=7):
        calls.append(1)
        if action:
            action()
        return deepcopy(path_groups), {"changed": changed, "before_segments": 1,
                                  "after_segments": 1, "maximum_error_bound_mm": .01}
    return solve


def test_implicit_engine_scope_reuses_within_job_and_isolates_next_job():
    calls = []
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job():
        solve(_groups("first"))
        return solve(_groups("second"))
    assert job()[0][0]["marker"] == "second"
    assert calls == [1]
    job()
    assert calls == [1, 1]
    assert memo.current_simplify_memo() is None


def test_engine_preserves_outer_preview_memo_and_snapshot():
    calls = []
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job(**options):
        return solve(_groups(), **options)
    with memo.simplify_memo_scope() as records:
        job()
        assert records
        job()
    saved = deepcopy(records)
    job(_simplify_memo=records)
    assert calls == [1] and records == saved


@pytest.mark.parametrize("changed", [True, False])
def test_threads_single_flight_keep_caller_metadata_and_detach_outputs(changed):
    calls = []
    store = memo._JobMemoStore()
    solve = _solver(calls, lambda: time.sleep(.08), changed)
    @memo.with_simplify_memo
    def job(marker):
        source = _groups(marker)
        result = solve(source)
        if not changed:
            assert result[0] is source or len(calls) == 1
        return result
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda i: job(str(i), _shared_simplify_memo=store), range(6)))
    assert calls == [1]
    assert [r[0][0]["marker"] for r in results] == list(map(str, range(6)))
    results[0][1]["after_segments"] = 999
    assert job("later", _shared_simplify_memo=store)[1]["after_segments"] == 1
    assert store.stats()["computed"] == 1


def test_distinct_geometry_is_not_serialized_behind_other_solver():
    both_started, lock = Event(), Lock()
    count = 0
    def work():
        nonlocal count
        with lock:
            count += 1
            if count == 2:
                both_started.set()
        assert both_started.wait(2), "Hai khuôn khác nhau phải được giải song song"
    calls, store = [], memo._JobMemoStore()
    solve = _solver(calls, work)
    @memo.with_simplify_memo
    def job(height):
        return solve(_groups(), page_height=height)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(job, h, _shared_simplify_memo=store) for h in (10., 11.)]
        assert all(f.result(timeout=3) for f in results)
    assert len(calls) == 2


def test_identity_keeps_all_points_holes_units_frames_options_and_algorithm(monkeypatch):
    from app.workers import cutline_cubic_simplify as cubic
    calls, store = [], memo._JobMemoStore()
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job(groups, **options):
        return solve(groups, **options)
    options = [{}, {"tolerance_mm": .05}, {"mm_to_units": 2.},
               {"offset_x_points": 1e-12}, {"offset_y_points": 1e-12},
               {"page_height": 11.}, {"prefer_conservative": True},
               {"preview_fast": False}, {"max_candidate_attempts": 3}]
    for settings in options:
        for _ in range(2):
            job(_groups(), _shared_simplify_memo=store, **settings)
    assert len(calls) == len(options)
    changed = _groups()
    changed[0]["exterior"][0] = ((0., 0.), (1.000000000001, 0.), (1., 1.), (0., 0.))
    job(changed, _shared_simplify_memo=store)
    changed[0]["interiors"] = [deepcopy(changed[0]["exterior"])]
    job(changed, _shared_simplify_memo=store)
    monkeypatch.setattr(cubic, "CUTLINE_SIMPLIFY_ALGORITHM", "other-algorithm")
    job(_groups(), _shared_simplify_memo=store)
    assert len(calls) == len(options) + 3


def test_solver_failure_abandons_claim_without_caching_partial_result():
    calls, store = [], memo._JobMemoStore()
    def fail_once():
        if len(calls) == 1:
            raise ValueError("solver lỗi")
    solve = _solver(calls, fail_once)
    @memo.with_simplify_memo
    def job():
        return solve(_groups())
    with pytest.raises(ValueError, match="solver lỗi"):
        job(_shared_simplify_memo=store)
    assert store.stats()["pending"] == 0 and store.stats()["entries"] == 0
    job(_shared_simplify_memo=store)
    job(_shared_simplify_memo=store)
    assert calls == [1, 1]


def test_cancelled_producer_does_not_publish_or_strand_waiters():
    calls, store, token = [], memo._JobMemoStore(), PreviewCancellation()
    solve = _solver(calls, token.cancel)
    @memo.with_simplify_memo
    def job():
        return solve(_groups())
    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            job(_shared_simplify_memo=store)
    finally:
        token.close()
    assert store.stats()["pending"] == 0 and store.stats()["entries"] == 0


def test_waiter_can_cancel_without_removing_producer_claim():
    calls, store, token = [], memo._JobMemoStore(), PreviewCancellation()
    started, release = Event(), Event()
    def work():
        started.set()
        assert release.wait(3)
    solve = _solver(calls, work)
    @memo.with_simplify_memo
    def job():
        return solve(_groups())
    def waiting():
        with cancellation_scope(token):
            return job(_shared_simplify_memo=store)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            producer = pool.submit(job, _shared_simplify_memo=store)
            assert started.wait(2)
            consumer = pool.submit(waiting)
            deadline = time.monotonic() + 2
            while store.stats()["waits"] == 0 and time.monotonic() < deadline:
                time.sleep(.01)
            token.cancel()
            with pytest.raises(PreviewCancelled):
                consumer.result(timeout=2)
            assert store.stats()["pending"] == 1
            release.set()
            producer.result(timeout=2)
    finally:
        release.set()
        token.close()
    assert calls == [1] and store.stats()["entries"] == 1


def test_broker_failure_falls_back_to_same_solver_with_local_reuse():
    class Broken:
        def claim(self, *args):
            raise BrokenPipeError("broker đã đóng")
        def abandon(self, *args):
            raise BrokenPipeError("broker đã đóng")
    calls = []
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job():
        solve(_groups())
        return solve(_groups())
    assert job(_shared_simplify_memo=Broken())[1]["changed"]
    assert calls == [1]


def test_lost_claim_response_releases_server_reservation_before_fallback():
    store, calls = memo._JobMemoStore(), []
    class LostResponse:
        def claim(self, *args):
            store.claim(*args)
            raise EOFError("Mất response sau khi server đã nhận claim")
        def abandon(self, *args):
            store.abandon(*args)
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job():
        return solve(_groups())
    assert job(_shared_simplify_memo=LostResponse())[1]["changed"]
    assert store.stats()["pending"] == 0
    job(_shared_simplify_memo=store)
    assert len(calls) == 2


def test_orphaned_claim_wait_falls_back_without_capping_solver(monkeypatch):
    class Busy:
        def claim(self, *_):
            return "wait", None
        def abandon(self, *_):
            pytest.fail("Không được xóa claim thuộc producer khác")
    monkeypatch.setattr(memo, "_SHARED_WAIT_TIMEOUT_S", 0.)
    calls = []
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job():
        solve(_groups())
        return solve(_groups())
    assert job(_shared_simplify_memo=Busy())[1]["changed"]
    assert calls == [1]


@pytest.mark.parametrize("ram,expected", [(4096,16), (12288,64), (16384,None), (32768,None), (None,None)])
def test_only_low_ram_has_memo_budget(ram, expected):
    assert memo._memo_budget_bytes(ram) == (None if expected is None else expected * 1024 * 1024)


def test_full_low_ram_cache_never_replaces_solver_or_drops_geometry():
    calls, store = [], memo._JobMemoStore(max_bytes=1)
    solve = _solver(calls)
    @memo.with_simplify_memo
    def job():
        return solve(_groups())
    assert job(_shared_simplify_memo=store) == job(_shared_simplify_memo=store)
    assert len(calls) == 2 and store.stats()["entries"] == 0
    assert store.stats()["pending"] == 0


def _spawn_job(payload):
    proxy, marker = payload
    calls = []
    solve = _solver(calls, lambda: time.sleep(.1))
    @memo.with_simplify_memo
    def job():
        return solve(_groups(marker))
    return job(_shared_simplify_memo=proxy), len(calls)


def test_windows_spawn_pool_computes_one_key_once_and_closes_job():
    with memo.shared_simplify_job(enabled=True, total_ram_mb=32768) as proxy:
        assert proxy is not None
        with ProcessPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(_spawn_job, [(proxy, str(i)) for i in range(9)]))
        assert sum(count for _, count in results) == 1
        assert [row[0][0]["marker"] for row, _ in results] == list(map(str, range(9)))
        assert proxy.stats()["computed"] == 1 and proxy.stats()["pending"] == 0
    with memo.shared_simplify_job(enabled=True, total_ram_mb=32768) as fresh:
        assert fresh.stats()["entries"] == 0


def test_broker_start_failure_does_not_block_job(monkeypatch):
    def unavailable(self):
        raise OSError("Không cấp được process broker")
    monkeypatch.setattr(memo._JobMemoManager, "start", unavailable)
    with memo.shared_simplify_job(enabled=True, total_ram_mb=32768) as proxy:
        assert proxy is None


def test_local_low_ram_memo_stops_admitting_without_dropping_solver(monkeypatch):
    calls = []
    solve = _solver(calls)
    monkeypatch.setattr(memo, "_memo_budget_bytes", lambda *_: 1)
    @memo.with_simplify_memo
    def job():
        first = solve(_groups())
        second = solve(_groups())
        assert first == second
        assert memo.current_simplify_memo() == {}
    job()
    assert calls == [1, 1]
    job(_simplify_memo={})
    assert calls == [1, 1, 1, 1]


def test_low_ram_budget_keeps_approved_snapshot_but_not_new_entries(monkeypatch):
    calls = []
    solve = _solver(calls)
    with memo.simplify_memo_scope() as records:
        solve(_groups())
    saved = deepcopy(records)
    monkeypatch.setattr(memo, "_memo_budget_bytes", lambda *_: 1)
    @memo.with_simplify_memo
    def job():
        solve(_groups())
        solve(_groups(), tolerance_mm=.05)
        solve(_groups(), tolerance_mm=.05)
    job(_simplify_memo=records)
    assert calls == [1, 1, 1] and records == saved


def test_shared_preview_seed_is_detached_and_reused():
    calls = []
    solve = _solver(calls)
    with memo.simplify_memo_scope() as records:
        solve(_groups("preview"))
    saved = deepcopy(records)
    store = memo._JobMemoStore(records)
    records.clear()
    @memo.with_simplify_memo
    def job():
        return solve(_groups("output"))
    result = job(_shared_simplify_memo=store)
    assert calls == [1] and result[0][0]["marker"] == "output"
    result[1]["after_segments"] = 999
    assert job(_shared_simplify_memo=store)[1] == next(iter(saved.values()))["stats"]


def _crash_claimed_worker(proxy):
    import os
    proxy.claim("orphan-key", "worker-owner")
    os._exit(17)


def test_crashed_worker_pool_does_not_keep_broker_or_claim_in_next_job():
    from concurrent.futures.process import BrokenProcessPool
    with memo.shared_simplify_job(enabled=True, total_ram_mb=32768) as proxy:
        with ProcessPoolExecutor(max_workers=2) as pool:
            failed = pool.submit(_crash_claimed_worker, proxy)
            with pytest.raises(BrokenProcessPool):
                failed.result(timeout=10)
        assert proxy.stats()["pending"] == 1
    with memo.shared_simplify_job(enabled=True, total_ram_mb=32768) as fresh:
        assert fresh.stats()["pending"] == 0 and fresh.stats()["entries"] == 0


def test_engine_pool_retry_uses_new_broker_without_poisoned_claim(tmp_path, monkeypatch):
    import io
    import pikepdf
    from concurrent.futures.process import BrokenProcessPool
    from app.workers import sticker_engine as engine
    source = tmp_path / "six.pdf"
    with pikepdf.Pdf.new() as pdf:
        for _ in range(6):
            pdf.add_blank_page(page_size=(72, 72))
        pdf.save(source)
    calls = []
    worker = engine.StickerEngine()
    monkeypatch.setattr(engine, "_cap_sticker_workers", lambda *_a, **_k: 4)
    def run(args_list, n_workers, use_pool, spill_dir=None):
        proxy = args_list[0]["shared_simplify_memo"]
        assert proxy is not None
        assert proxy.stats()["pending"] == 0
        calls.append(n_workers)
        if len(calls) == 1:
            proxy.claim("orphan-key", "crashed-worker")
            raise BrokenProcessPool("Mô phỏng pool lỗi sau claim")
        results = []
        for index, args in enumerate(args_list):
            with pikepdf.Pdf.new() as pdf:
                for _ in args["page_indices"]:
                    pdf.add_blank_page(page_size=(72, 72))
                buffer = io.BytesIO()
                pdf.save(buffer)
            results.append((index, (buffer.getvalue(), [{} for _ in args["page_indices"]], [], True)))
        return results
    monkeypatch.setattr(worker, "_run_sticker_chunks", run)
    success, _ = worker._process_parallel(
        input_path=str(source), output_path=str(tmp_path / "result.pdf"),
        cut_mode="original", offset_mm=0., corner_style="preserve", cut_color=(0,1,0,0),
        bleed_mm=0., fill_holes=True, remove_white_bg=False, bleed_color_type="solid",
        solid_bleed_color=(255,255,255), draw_cut_contour=True, rectangle_mode=False,
        edge_bite_mm=0., cut_first_page_only=False, cutline_simplify_auto=True,
    )
    assert success and calls == [4, 2]
