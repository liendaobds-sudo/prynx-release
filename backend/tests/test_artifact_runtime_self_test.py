from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest

from app.core import artifact_runtime_self_test as runtime_self_test
from app.workers import isnet_engine, realesrgan_engine


class _FakeInput:
    name = "input"

    def __init__(self, shape):
        self.shape = shape


class _FakeSession:
    created: list[tuple[str, tuple[str, ...]]] = []

    def __init__(self, path, providers):
        self.path = str(path)
        self.providers = tuple(providers)
        self.created.append((self.path, self.providers))

    def get_inputs(self):
        if self.path.endswith("isnet.onnx"):
            return [_FakeInput([1, 3, 1024, 1024])]
        return [_FakeInput(["batch", 3, "height", "width"])]

    def run(self, _outputs, inputs):
        assert list(inputs) == ["input"]
        assert inputs["input"].dtype == np.float32
        return [np.ones((1, 1, 2, 2), dtype=np.float32)]


def _install_fake_runtime(monkeypatch, providers):
    fake_ort = types.ModuleType("onnxruntime")
    fake_ort.get_available_providers = lambda: list(providers)
    fake_ort.InferenceSession = _FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)


def _prepare_models(monkeypatch, tmp_path: Path):
    names = {
        "isnet.onnx": "hash-isnet",
        "general.onnx": "hash-general",
        "quality.onnx": "hash-quality",
    }
    for name in names:
        (tmp_path / name).write_bytes(name.encode("ascii"))

    monkeypatch.setattr(isnet_engine, "_BUNDLED_MODELS", str(tmp_path))
    monkeypatch.setattr(isnet_engine, "MODEL_PATH", str(tmp_path / "isnet.onnx"))
    monkeypatch.setattr(isnet_engine, "MODEL_SHA256", names["isnet.onnx"])
    monkeypatch.setattr(realesrgan_engine, "_BUNDLED_DIR", str(tmp_path))
    monkeypatch.setattr(
        realesrgan_engine,
        "MODELS",
        {"general": "general.onnx", "quality": "quality.onnx"},
    )
    monkeypatch.setattr(
        realesrgan_engine,
        "MODEL_SHA256",
        {"general": names["general.onnx"], "quality": names["quality.onnx"]},
    )
    monkeypatch.setattr(runtime_self_test, "_sha256_file", lambda path: names[path.name])


def test_frozen_runtime_self_test_runs_all_three_bundled_models(monkeypatch, tmp_path):
    _FakeSession.created.clear()
    _install_fake_runtime(monkeypatch, ["DmlExecutionProvider", "CPUExecutionProvider"])
    _prepare_models(monkeypatch, tmp_path)

    report = runtime_self_test.run_artifact_runtime_self_test()

    assert report["status"] == "ok"
    assert set(report["models"]) == {
        "isnet",
        "realesrgan-general",
        "realesrgan-quality",
    }
    assert report["models"]["isnet"]["input_shape"] == [1, 3, 1024, 1024]
    assert report["models"]["realesrgan-general"]["input_shape"] == [1, 3, 16, 16]
    assert len(_FakeSession.created) == 3
    assert all(providers == ("CPUExecutionProvider",) for _path, providers in _FakeSession.created)


def test_frozen_runtime_self_test_requires_directml_provider(monkeypatch, tmp_path):
    _install_fake_runtime(monkeypatch, ["CPUExecutionProvider"])
    _prepare_models(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError, match="provider"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_frozen_runtime_self_test_rejects_bundle_hash_drift(monkeypatch, tmp_path):
    _install_fake_runtime(monkeypatch, ["DmlExecutionProvider", "CPUExecutionProvider"])
    _prepare_models(monkeypatch, tmp_path)
    monkeypatch.setattr(runtime_self_test, "_sha256_file", lambda _path: "wrong")

    with pytest.raises(RuntimeError, match="hash"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_main_exposes_hidden_self_test_before_app_and_server_imports():
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    branch_offset = source.index(
        'if __name__ == "__main__" and "--artifact-self-test" in sys.argv[1:]:'
    )
    fastapi_offset = source.index("from fastapi import FastAPI")
    bind_offset = source.index("_bind_ok = False")
    assert branch_offset < fastapi_offset < bind_offset
    assert "run_artifact_runtime_self_test" in source
    assert "SELF_TEST_MARKER" in source


def test_release_qa_uses_staged_native_and_models_without_dirtying_source():
    repo = Path(__file__).parents[2]
    source = (repo / "build_production.ps1").read_text(encoding="utf-8")
    wheel_install = source.index("pip install --no-deps --target $nativeSiteDir")
    staged_site = source.index("$env:PRYNX_RELEASE_NATIVE_SITE = $nativeSiteDir")
    qa_call = source.index('-File "$ROOT\\scripts\\run_release_qa.ps1"', staged_site)
    nuitka_call = source.index("& $VENV_PYTHON -m nuitka", qa_call)
    assert wheel_install < staged_site < qa_call < nuitka_call
    assert '$PACKAGED_MODELS_DIR = Join-Path $nativeStageFull "models"' in source
    assert "-Destination $SOURCE_ISNET_ONNX" not in source
    assert "Assert-ReleaseSourceState -CaptureCommit" in source
    assert source.count("Assert-ReleaseSourceState") >= 3


def test_publisher_requires_committed_version_instead_of_mutating_source():
    repo = Path(__file__).parents[2]
    source = (repo / "release_update.ps1").read_text(encoding="utf-8")
    assert "Assert-CommittedReleaseVersion -ExpectedVersion $Version" in source
    assert "publisher.config.json" in source
    assert "Da dat version=$Version" not in source
