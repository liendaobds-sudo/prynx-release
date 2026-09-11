"""PERF (audit 2026-09-11 §PREWARM.CANCEL): hợp đồng hủy preview độc lập."""

from __future__ import annotations

import pickle
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from multiprocessing import shared_memory
from threading import Barrier

import pytest

from app.workers import cutline_preview_cancel as cancellation_module
from app.workers.cutline_preview_cancel import (
    PreviewCancellation,
    PreviewCancelled,
    cancellation_scope,
    check_preview_cancelled,
    current_cancellation,
)


def test_no_token_is_noop_without_allocating_shared_memory(monkeypatch):
    def unexpected_shared_memory(*args, **kwargs):
        pytest.fail("Luồng cục bộ không được tạo bộ nhớ dùng chung.")

    monkeypatch.setattr(
        cancellation_module.shared_memory, "SharedMemory", unexpected_shared_memory
    )
    assert current_cancellation() is None
    check_preview_cancelled()
    token = PreviewCancellation()
    try:
        token.check()
        with cancellation_scope(token):
            assert current_cancellation() is token
            check_preview_cancelled()
        token.cancel()
        with pytest.raises(PreviewCancelled):
            token.check()
    finally:
        token.close()
    assert current_cancellation() is None
    check_preview_cancelled()


def test_nested_scopes_restore_outer_token_after_cancel():
    outer = PreviewCancellation()
    inner = PreviewCancellation()
    try:
        with cancellation_scope(outer):
            with pytest.raises(PreviewCancelled):
                with cancellation_scope(inner):
                    assert current_cancellation() is inner
                    inner.cancel()
                    check_preview_cancelled()
            assert current_cancellation() is outer
            check_preview_cancelled()
        assert current_cancellation() is None
    finally:
        inner.close()
        outer.close()


def test_none_scope_temporarily_disables_inherited_token():
    token = PreviewCancellation()
    try:
        token.cancel()
        with cancellation_scope(token):
            with cancellation_scope(None):
                assert current_cancellation() is None
                check_preview_cancelled()
            assert current_cancellation() is token
            with pytest.raises(PreviewCancelled):
                check_preview_cancelled()
        assert current_cancellation() is None
    finally:
        token.close()


def test_scope_preserves_ordinary_exception_and_restores_context():
    token = PreviewCancellation()
    error = ValueError("Lỗi gốc phải giữ nguyên.")
    try:
        with pytest.raises(ValueError) as caught:
            with cancellation_scope(token):
                raise error
        assert caught.value is error
        assert current_cancellation() is None
    finally:
        token.close()


def test_cancel_is_not_swallowed_by_exception_fallback():
    token = PreviewCancellation()
    try:
        token.cancel()
        with pytest.raises(PreviewCancelled):
            try:
                with cancellation_scope(token):
                    check_preview_cancelled()
            except Exception:
                pytest.fail("Hủy preview không được trở thành đường dự phòng.")
        assert current_cancellation() is None
    finally:
        token.close()


def test_cancellation_exception_is_picklable():
    original = PreviewCancelled("Preview cũ đã bị hủy.")
    restored = pickle.loads(pickle.dumps(original))
    assert type(restored) is PreviewCancelled
    assert restored.args == original.args
    assert not isinstance(restored, Exception)


def test_local_close_and_cancel_are_idempotent():
    token = PreviewCancellation()
    token.close()
    token.close()
    token.check()
    token.cancel()
    token.cancel()
    token.close()
    with pytest.raises(PreviewCancelled):
        token.check()
    with pytest.raises(RuntimeError, match="đã đóng"):
        token.export_shared_name()


def test_shared_memory_is_lazy_and_export_reuses_one_byte(monkeypatch):
    real_shared_memory = shared_memory.SharedMemory
    allocations = []

    def record_shared_memory(*args, **kwargs):
        allocations.append(kwargs.copy())
        return real_shared_memory(*args, **kwargs)

    monkeypatch.setattr(
        cancellation_module.shared_memory, "SharedMemory", record_shared_memory
    )
    token = PreviewCancellation()
    try:
        token.check()
        assert allocations == []
        name = token.export_shared_name()
        assert token.export_shared_name() == name
        assert allocations == [{"create": True, "size": 1}]
        attached = real_shared_memory(name=name, create=False)
        try:
            # PERF (audit 2026-09-11 §PREWARM.CANCEL): Windows làm tròn vùng
            # map theo trang; hợp đồng chỉ dùng byte đầu và yêu cầu size=1.
            assert attached.size >= 1
            assert attached.buf[0] == 0
        finally:
            attached.close()
    finally:
        token.close()
        token.close()
    with pytest.raises(FileNotFoundError):
        real_shared_memory(name=name, create=False)


def test_attached_view_sees_owner_cancel_and_close_keeps_cancellation():
    owner = PreviewCancellation()
    child = PreviewCancellation.attach(owner.export_shared_name())
    try:
        child.check()
        owner.cancel()
        owner.cancel()
        with pytest.raises(PreviewCancelled):
            child.check()
        child.close()
        child.close()
        with pytest.raises(PreviewCancelled):
            child.check()
    finally:
        child.close()
        owner.close()
        owner.close()


def test_cancel_before_export_is_visible_to_attached_view():
    owner = PreviewCancellation()
    owner.cancel()
    child = PreviewCancellation.attach(owner.export_shared_name())
    try:
        with pytest.raises(PreviewCancelled):
            child.check()
    finally:
        child.close()
        owner.close()


def test_child_close_does_not_unlink_owner_memory():
    owner = PreviewCancellation()
    name = owner.export_shared_name()
    child = PreviewCancellation.attach(name)
    child.close()
    child.close()
    try:
        second_child = PreviewCancellation.attach(name)
        try:
            owner.cancel()
            with pytest.raises(PreviewCancelled):
                second_child.check()
        finally:
            second_child.close()
    finally:
        owner.close()
    with pytest.raises(FileNotFoundError):
        PreviewCancellation.attach(name)


def test_attached_view_cancel_is_visible_to_owner():
    owner = PreviewCancellation()
    child = PreviewCancellation.attach(owner.export_shared_name())
    try:
        child.cancel()
        with pytest.raises(PreviewCancelled):
            owner.check()
    finally:
        child.close()
        owner.close()


def test_closing_attached_view_latches_unchecked_shared_cancellation():
    owner = PreviewCancellation()
    child = PreviewCancellation.attach(owner.export_shared_name())
    try:
        owner.cancel()
        child.close()
        with pytest.raises(PreviewCancelled):
            child.check()
    finally:
        child.close()
        owner.close()


def test_cancel_export_close_race_does_not_use_closed_handle():
    # PERF (audit 2026-09-11 §PREWARM.CANCEL): cùng lúc phát tên, hủy và
    # đóng phải tuyến tính hóa; đóng thắng thì export từ chối rõ ràng.
    with ThreadPoolExecutor(max_workers=3) as executor:
        for _ in range(25):
            token = PreviewCancellation()
            barrier = Barrier(3)

            def export():
                barrier.wait(timeout=5)
                try:
                    return token.export_shared_name()
                except RuntimeError as error:
                    assert "đã đóng" in str(error)
                    return None

            def cancel():
                barrier.wait(timeout=5)
                token.cancel()

            def close():
                barrier.wait(timeout=5)
                token.close()

            futures = [executor.submit(fn) for fn in (export, cancel, close)]
            try:
                for future in futures:
                    future.result(timeout=5)
                with pytest.raises(PreviewCancelled):
                    token.check()
                with pytest.raises(RuntimeError, match="đã đóng"):
                    token.export_shared_name()
            finally:
                token.close()


def test_context_can_be_copied_to_thread_without_leaking():
    token = PreviewCancellation()
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            with cancellation_scope(token):
                context = copy_context()
                assert executor.submit(current_cancellation).result(timeout=5) is None
                assert (
                    executor.submit(context.run, current_cancellation).result(timeout=5)
                    is token
                )
                token.cancel()
                with pytest.raises(PreviewCancelled):
                    executor.submit(
                        context.run, check_preview_cancelled
                    ).result(timeout=5)
                assert current_cancellation() is token
            assert current_cancellation() is None
            assert executor.submit(current_cancellation).result(timeout=5) is None
    finally:
        token.close()


@pytest.mark.parametrize("candidate", [None, "nhịp đã gộp"])
def test_shortest_path_stops_after_candidate_requests_cancel(candidate):
    from app.workers.cutline_global_simplify import _shortest_path

    token = PreviewCancellation()
    calls = []

    def candidate_at(start, end):
        calls.append((start, end))
        token.cancel()
        return candidate

    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            _shortest_path(5, candidate_at)
        assert calls == [(3, 5)]
        assert current_cancellation() is None
    finally:
        token.close()


@pytest.mark.parametrize("callback_name", ["residual", "jacobian"])
def test_fair_solver_callback_cancel_is_not_converted_to_source_fallback(
    monkeypatch, callback_name
):
    import numpy as np
    import scipy.optimize

    from app.workers import cutline_fair_seed as seed_module
    from app.workers import cutline_fair_simplify as fair
    from app.workers import cutline_fair_verify as verify_module
    from app.workers.cutline_polyline_reduction import split_cubic

    # PERF (audit 2026-09-11 §PREWARM.CANCEL): giữ cả wrapper fallback thật
    # và callback thật; chỉ thay solver để hủy đúng lúc SciPy gọi lại chúng.
    angles = np.arange(4) * np.pi / 2
    values = np.column_stack(
        [np.cos(angles), np.sin(angles), angles + np.pi / 2,
         np.full(4, np.log(.5522847498307936)),
         np.full(4, np.log(.5522847498307936))]
    )
    seed = fair._decode(values, np.zeros(4))
    source = np.asarray([piece for curve in seed for piece in split_cubic(curve, .5)])
    saved = source.copy()
    token = PreviewCancellation()
    calls = []

    def prescribed_seeds(local_source, tolerance, **kwargs):
        return (seed - source[0, 0],)

    def cancelled_solver(residual, initial, **kwargs):
        callback = residual if callback_name == "residual" else kwargs["jac"]
        callback(initial)
        calls.append(callback_name)
        token.cancel()
        callback(initial)
        pytest.fail("Callback phải dừng solver ngay khi token bị hủy.")

    def unexpected_verifier(*args, **kwargs):
        pytest.fail("Không chứng nhận nghiệm dở sau khi optimizer đã bị hủy.")

    monkeypatch.setattr(seed_module, "build_fair_seeds", prescribed_seeds)
    monkeypatch.setattr(scipy.optimize, "least_squares", cancelled_solver)
    monkeypatch.setattr(verify_module, "verify_fair_ring", unexpected_verifier)
    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            fair.fair_refit_ring(source, .1)
        assert calls == [callback_name]
        assert np.array_equal(source, saved)
        assert current_cancellation() is None
    finally:
        token.close()


@pytest.mark.parametrize("tolerance", [0.0, 0.1])
def test_cancelled_cubic_simplify_does_not_return_or_memoize_noop_source(
    monkeypatch, tolerance
):
    from app.workers import cutline_cubic_simplify as cubic
    from app.workers.cutline_simplify_memo import simplify_memo_scope

    source = [{"exterior": [], "interiors": [], "marker": "nguồn"}]
    token = PreviewCancellation()

    def unexpected_impl(*args, **kwargs):
        pytest.fail("Token đã hủy phải dừng trước mọi nhánh trả nguồn/fallback.")

    monkeypatch.setattr(cubic, "_simplify_cubic_path_groups_impl", unexpected_impl)
    try:
        token.cancel()
        with simplify_memo_scope() as memo:
            with cancellation_scope(token), pytest.raises(PreviewCancelled):
                cubic.simplify_cubic_path_groups(source, tolerance_mm=tolerance)
            assert memo == {}
        assert source == [{"exterior": [], "interiors": [], "marker": "nguồn"}]
        assert current_cancellation() is None
    finally:
        token.close()
