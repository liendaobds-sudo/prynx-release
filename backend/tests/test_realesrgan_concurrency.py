"""Hàng rào hồi quy cho DirectML: một session chỉ được Run trên một thread."""

from __future__ import annotations

import threading
import time

import numpy as np

from app.workers import realesrgan_engine as engine


class _Input:
    name = "input"


class _RunCounter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.maximum = 0

    def enter(self) -> None:
        with self.lock:
            self.active += 1
            self.maximum = max(self.maximum, self.active)

    def leave(self) -> None:
        with self.lock:
            self.active -= 1


class _FakeSession:
    def __init__(self, counter: _RunCounter, rendezvous: threading.Barrier | None = None) -> None:
        self.counter = counter
        self.rendezvous = rendezvous

    def get_inputs(self):
        return [_Input()]

    def get_providers(self):
        return ["DmlExecutionProvider", "CPUExecutionProvider"]

    def run(self, _outputs, inputs):
        self.counter.enter()
        try:
            if self.rendezvous is not None:
                self.rendezvous.wait(timeout=2)
            time.sleep(0.05)
            return [next(iter(inputs.values()))]
        finally:
            self.counter.leave()


class _CpuSession(_FakeSession):
    def get_providers(self):
        return ["CPUExecutionProvider"]


def _run_two_workers(first, second) -> list[BaseException]:
    start = threading.Barrier(3)
    errors: list[BaseException] = []

    def execute(target) -> None:
        try:
            start.wait(timeout=2)
            target()
        except BaseException as exc:  # pragma: no cover - chỉ hiện khi test lỗi
            errors.append(exc)

    threads = [threading.Thread(target=execute, args=(target,)) for target in (first, second)]
    for thread in threads:
        thread.start()
    start.wait(timeout=2)
    for thread in threads:
        thread.join(timeout=3)
    assert all(not thread.is_alive() for thread in threads)
    return errors


def test_same_directml_session_never_runs_concurrently(monkeypatch):
    counter = _RunCounter()
    session = _FakeSession(counter)
    monkeypatch.setattr(engine, "_get_session", lambda _variant: session)
    tile = np.zeros((1, 3, 8, 8), dtype=np.float32)

    errors = _run_two_workers(
        lambda: engine._run_session("general", tile),
        lambda: engine._run_session("general", tile),
    )

    assert errors == []
    assert counter.maximum == 1


def test_different_model_sessions_are_not_globally_serialized(monkeypatch):
    counter = _RunCounter()
    rendezvous = threading.Barrier(2)
    sessions = {
        "general": _FakeSession(counter, rendezvous),
        "quality": _FakeSession(counter, rendezvous),
    }
    monkeypatch.setattr(engine, "_get_session", lambda variant: sessions[variant])
    tile = np.zeros((1, 3, 8, 8), dtype=np.float32)

    errors = _run_two_workers(
        lambda: engine._run_session("general", tile),
        lambda: engine._run_session("quality", tile),
    )

    assert errors == []
    assert counter.maximum == 2


def test_cpu_session_keeps_onnx_runtime_parallelism(monkeypatch):
    counter = _RunCounter()
    rendezvous = threading.Barrier(2)
    session = _CpuSession(counter, rendezvous)
    monkeypatch.setattr(engine, "_get_session", lambda _variant: session)
    tile = np.zeros((1, 3, 8, 8), dtype=np.float32)

    errors = _run_two_workers(
        lambda: engine._run_session("general", tile),
        lambda: engine._run_session("general", tile),
    )

    assert errors == []
    assert counter.maximum == 2
