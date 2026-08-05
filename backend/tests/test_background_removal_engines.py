import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image


class _Input:
    name = "input"


class _ConcurrentUnsafeSession:
    def __init__(self, output_kind: str):
        self.output_kind = output_kind
        self.active = 0
        self.max_active = 0
        self.guard = threading.Lock()

    def get_providers(self):
        return ["DmlExecutionProvider", "CPUExecutionProvider"]

    def get_inputs(self):
        return [_Input()]

    def run(self, *_args, **_kwargs):
        with self.guard:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if self.active > 1:
                raise RuntimeError("DirectML concurrent Run")
        try:
            time.sleep(0.02)
            shape = (1, 1, 8, 8) if self.output_kind == "birefnet" else (1, 1, 8, 8)
            return [np.zeros(shape, dtype=np.float32)]
        finally:
            with self.guard:
                self.active -= 1


def _identity_refine(image, _mask):
    return image.convert("RGBA")


def test_birefnet_serializes_same_directml_session(monkeypatch):
    from app.workers import birefnet_engine as engine
    from app.workers import image_postprocessor

    session = _ConcurrentUnsafeSession("birefnet")
    monkeypatch.setattr(engine, "_get_session", lambda _variant="lite": session)
    monkeypatch.setattr(image_postprocessor, "refine_foreground_rgba", _identity_refine)
    image = Image.new("RGB", (16, 16), "white")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _i: engine.remove_background(image, "lite"), range(2)))

    assert [result.mode for result in results] == ["RGBA", "RGBA"]
    assert session.max_active == 1


def test_isnet_serializes_same_directml_session(monkeypatch):
    from app.workers import image_postprocessor
    from app.workers import isnet_engine as engine

    session = _ConcurrentUnsafeSession("isnet")
    monkeypatch.setattr(engine, "_get_session", lambda: session)
    monkeypatch.setattr(image_postprocessor, "refine_foreground_rgba", _identity_refine)
    image = Image.new("RGB", (16, 16), "white")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _i: engine.remove_background(image), range(2)))

    assert [result.mode for result in results] == ["RGBA", "RGBA"]
    assert session.max_active == 1


def test_directml_session_options_disable_unsupported_modes(monkeypatch):
    from app.workers import birefnet_engine as engine

    captured = {}

    def fake_session(path, sess_options, providers):
        captured.update(path=path, options=sess_options, providers=providers)
        return object()

    monkeypatch.setattr(engine.ort, "InferenceSession", fake_session)
    engine._create_session("model.onnx", ["DmlExecutionProvider", "CPUExecutionProvider"])

    assert captured["options"].enable_mem_pattern is False
    assert captured["options"].execution_mode == engine.ort.ExecutionMode.ORT_SEQUENTIAL


def test_birefnet_releases_failed_gpu_session_before_loading_cpu(monkeypatch):
    from app.workers import birefnet_engine as engine

    events = []

    class NativeSession:
        def __del__(self):
            events.append("native_gpu_released")

    class FailedGpuSession:
        def __init__(self):
            self._sess = NativeSession()

    failed = FailedGpuSession()
    monkeypatch.setattr(engine, "_sessions", {"lite": failed})
    monkeypatch.setattr(engine, "_force_cpu", False)
    monkeypatch.setattr(engine, "_download_model_if_needed", lambda _variant: "model.onnx")
    monkeypatch.setattr(engine.gc, "collect", lambda: events.append("gc"))

    def create_cpu(_path, providers):
        assert providers == ["CPUExecutionProvider"]
        assert "lite" not in engine._sessions
        assert events == ["native_gpu_released", "gc"]
        events.append("cpu_created")
        return object()

    monkeypatch.setattr(engine, "_create_session", create_cpu)

    assert engine._switch_to_cpu("lite") is engine._sessions["lite"]
    assert events == ["native_gpu_released", "gc", "cpu_created"]
    assert engine._force_cpu is True

def test_warmup_only_loads_sessions_without_fake_inference(monkeypatch):
    from app.workers import birefnet_engine, isnet_engine

    loaded = []
    monkeypatch.setattr(isnet_engine, "_get_session", lambda: loaded.append("isnet") or object())
    monkeypatch.setattr(birefnet_engine, "_get_session", lambda variant: loaded.append(variant) or object())
    monkeypatch.setattr(
        isnet_engine,
        "remove_background",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("không được inference giả")),
    )
    monkeypatch.setattr(
        birefnet_engine,
        "remove_background",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("không được inference giả")),
    )

    assert isnet_engine.warmup() is True
    assert birefnet_engine.warmup("lite") is True
    assert loaded == ["isnet", "lite"]
