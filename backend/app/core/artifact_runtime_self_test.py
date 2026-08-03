"""Self-test runtime AI chi danh cho nghiem thu sidecar da dong goi.

Khong nhan duong dan hay du lieu tu ben ngoai. Moi model phai duoc nap tu thu muc
bundle ben trong sidecar, dung hash da khoa trong engine, va chay mot inference CPU
nho de chung minh ONNX Runtime/PYD/DLL/model thuc su hoat dong sau Nuitka.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


SELF_TEST_MARKER = "PRYNX_ARTIFACT_SELF_TEST="


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolved_shape(shape: list[Any], fallback: tuple[int, ...]) -> tuple[int, ...]:
    if len(shape) != len(fallback):
        raise RuntimeError("ONNX input rank khong dung hop dong")
    resolved = []
    for value, default in zip(shape, fallback, strict=True):
        if isinstance(value, int) and value > 0:
            resolved.append(value)
        else:
            resolved.append(default)
    return tuple(resolved)


def _run_cpu_inference(ort, np, path: Path, fallback_shape: tuple[int, ...]) -> dict[str, Any]:
    if not path.is_file():
        raise RuntimeError("Thieu model ONNX trong sidecar")
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise RuntimeError("Model ONNX khong co dung mot input")
    model_input = inputs[0]
    shape = _resolved_shape(list(model_input.shape), fallback_shape)
    tensor = np.zeros(shape, dtype=np.float32)
    outputs = session.run(None, {model_input.name: tensor})
    if not outputs or not all(getattr(output, "size", 0) > 0 for output in outputs):
        raise RuntimeError("ONNX inference khong tra output hop le")
    if not all(bool(np.isfinite(output).all()) for output in outputs):
        raise RuntimeError("ONNX inference tra NaN/Inf")
    return {
        "input_shape": list(shape),
        "output_count": len(outputs),
    }


def run_artifact_runtime_self_test() -> dict[str, Any]:
    """Chay import/session/inference bang chinh runtime nam trong frozen sidecar."""

    import numpy as np
    import onnxruntime as ort

    from app.workers import isnet_engine, realesrgan_engine

    available = set(ort.get_available_providers())
    required = {"CPUExecutionProvider", "DmlExecutionProvider"}
    missing = sorted(required - available)
    if missing:
        raise RuntimeError("ONNX Runtime thieu provider bat buoc")

    specifications = [
        (
            "isnet",
            Path(isnet_engine._BUNDLED_MODELS) / Path(isnet_engine.MODEL_PATH).name,
            isnet_engine.MODEL_SHA256,
            (1, 3, 1024, 1024),
        ),
        (
            "realesrgan-general",
            Path(realesrgan_engine._BUNDLED_DIR) / realesrgan_engine.MODELS["general"],
            realesrgan_engine.MODEL_SHA256["general"],
            (1, 3, 16, 16),
        ),
        (
            "realesrgan-quality",
            Path(realesrgan_engine._BUNDLED_DIR) / realesrgan_engine.MODELS["quality"],
            realesrgan_engine.MODEL_SHA256["quality"],
            (1, 3, 16, 16),
        ),
    ]

    models: dict[str, dict[str, Any]] = {}
    for name, path, expected_hash, fallback_shape in specifications:
        if not path.is_file() or _sha256_file(path) != expected_hash.lower():
            raise RuntimeError("Model ONNX trong sidecar thieu hoac sai hash")
        models[name] = _run_cpu_inference(ort, np, path, fallback_shape)

    return {
        "status": "ok",
        "providers": sorted(required),
        "models": models,
    }
