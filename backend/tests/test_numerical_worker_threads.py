"""Ngân sách luồng thật phải khôi phục và không sửa môi trường process."""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from app.workers import numerical_worker_threads as budget
from app.workers.cutline_preview_cancel import PreviewCancelled


def _fake_backend(monkeypatch):
    state = {"numpy": 16, "scipy": 8, "cv": 6}
    controls = []
    for name in ("numpy", "scipy"):
        controls.append(SimpleNamespace(
            get_threads=lambda name=name: state[name],
            set_threads=lambda count, name=name: state.__setitem__(name, count),
        ))
    monkeypatch.setattr(budget, "_load_numeric_libraries", lambda: None)
    monkeypatch.setattr(budget, "_native_blas_controls", lambda: controls)
    monkeypatch.setattr(budget.cv2, "getNumThreads", lambda: state["cv"])
    monkeypatch.setattr(budget.cv2, "setNumThreads", lambda count: state.__setitem__("cv", count))
    return state


@pytest.mark.parametrize("threads", [1, 4, 32])
def test_budget_controls_both_libraries_without_capping_machine_or_mutating_env(monkeypatch, threads):
    state = _fake_backend(monkeypatch)
    before = dict(state)
    environment = dict(os.environ)
    with budget.numerical_thread_budget(threads):
        assert state == {"numpy": threads, "scipy": threads, "cv": threads}
        assert dict(os.environ) == environment
    assert state == before


@pytest.mark.parametrize("error", [ValueError("x"), PreviewCancelled("hủy")])
def test_worker_wrapper_restores_after_error_and_cancellation(monkeypatch, error):
    state = _fake_backend(monkeypatch)
    before = dict(state)

    @budget.with_worker_thread_budget
    def worker(args):
        assert state == {"numpy": 2, "scipy": 2, "cv": 2}
        raise error

    with pytest.raises(type(error)):
        worker({"threads_per_worker": 2})
    assert state == before


def test_nested_scopes_restore_outer_budget_before_original(monkeypatch):
    state = _fake_backend(monkeypatch)
    before = dict(state)
    with budget.numerical_thread_budget(4):
        with budget.numerical_thread_budget(1):
            assert state["numpy"] == 1
        assert state == {"numpy": 4, "scipy": 4, "cv": 4}
    assert state == before


def test_installed_numpy_and_scipy_blas_change_and_restore():
    budget._load_numeric_libraries()
    controls = budget._native_blas_controls()
    if not controls:
        pytest.skip("Môi trường không nạp OpenBLAS/MKL được hỗ trợ.")
    before = [control.get_threads() for control in controls]
    before_cv, environment = budget.cv2.getNumThreads(), dict(os.environ)
    with budget.numerical_thread_budget(1):
        assert [control.get_threads() for control in controls] == [1] * len(controls)
        assert budget.cv2.getNumThreads() == 1
        assert dict(os.environ) == environment
    assert [control.get_threads() for control in controls] == before
    assert budget.cv2.getNumThreads() == before_cv
