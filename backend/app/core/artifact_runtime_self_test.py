"""Self-test runtime AI chi danh cho nghiem thu sidecar da dong goi.

Khong nhan duong dan hay du lieu tu ben ngoai. Moi model phai duoc nap tu thu muc
bundle ben trong sidecar, dung hash da khoa trong engine, va chay mot inference CPU
nho de chung minh ONNX Runtime/PYD/DLL/model thuc su hoat dong sau Nuitka.
"""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from typing import Any


SELF_TEST_MARKER = "PRYNX_ARTIFACT_SELF_TEST="


def _verify_entitlement_gate() -> dict[str, Any]:
    """Chứng minh gate Free/Pro của chính runtime đóng băng đang bật."""

    from app.core import feature_entitlements

    if not feature_entitlements.FEATURE_GATING_ENABLED:
        raise RuntimeError("Feature gate trong sidecar dang tat")
    if not feature_entitlements.can_use_feature("pdf.merge", plan="free"):
        raise RuntimeError("Goi Free bi tu choi capability Free")
    try:
        feature_entitlements.assert_feature(
            "prepress.preflight",
            {"plan": "free", "features": []},
        )
    except PermissionError:
        pass
    else:
        raise RuntimeError("Goi Free khong bi tu choi capability Pro")

    return {
        "enabled": True,
        "free_allowed": "pdf.merge",
        "free_denied": "prepress.preflight",
    }


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


def _run_native_merger_smoke() -> dict[str, Any]:
    """Chạy merger thật trên PNG pHYs + alpha + ICC rồi kiểm artifact PDF."""
    try:
        import pdfcompare_native
        import pikepdf
        from PIL import Image, ImageCms

        merger = getattr(pdfcompare_native, "combine_image_manifest_native", None)
        if not callable(merger):
            raise RuntimeError("pdfcompare_native thieu symbol combine_image_manifest_native")

        with tempfile.TemporaryDirectory(prefix="prynx_native_merger_smoke_") as directory:
            root = Path(directory)
            image_path = root / "rgba_icc_300dpi.png"
            output_path = root / "merged.pdf"
            profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
            Image.new("RGBA", (2, 3), (20, 40, 60, 160)).save(
                image_path,
                format="PNG",
                icc_profile=profile,
                dpi=(300, 300),
            )
            # Đi qua public pipeline để pHYs được đọc từ PNG thật; bọc loader chỉ
            # nhằm chứng minh pipeline đã gọi đúng symbol native, không fallback.
            from app.workers import pdf_manifest_engine
            native_called = False

            def tracked_merger(*args, **kwargs):
                nonlocal native_called
                native_called = True
                return merger(*args, **kwargs)

            original_loader = pdf_manifest_engine._load_native_image_merger
            pdf_manifest_engine._load_native_image_merger = lambda: tracked_merger
            try:
                pdf_manifest_engine.merge_manifest(
                    [str(image_path)],
                    [{"file_index": 0}],
                    str(output_path),
                )
            finally:
                pdf_manifest_engine._load_native_image_merger = original_loader
            if not native_called:
                raise RuntimeError("pipeline khong goi native merger")
            if not output_path.is_file() or output_path.stat().st_size <= 0:
                raise RuntimeError("native merger khong tao PDF")

            with pikepdf.open(output_path) as document:
                if len(document.pages) != 1:
                    raise RuntimeError("native merger tao sai so trang")
                page = document.pages[0]
                media_box = [float(value) for value in page.MediaBox]
                width_pt = media_box[2] - media_box[0]
                height_pt = media_box[3] - media_box[1]
                if abs(width_pt - 0.48) > 0.01 or abs(height_pt - 0.72) > 0.01:
                    raise RuntimeError("native merger khong ton trong pHYs/DPI")
                xobjects = page.Resources.get("/XObject")
                images = [] if xobjects is None else [
                    value
                    for _name, value in xobjects.items()
                    if str(value.get("/Subtype")) == "/Image"
                ]
                if len(images) != 1:
                    raise RuntimeError("native merger khong tao dung mot image XObject")
                image = images[0]
                if image.get("/SMask") is None:
                    raise RuntimeError("native merger lam mat alpha/SMask")
                color_space = image.get("/ColorSpace")
                if (
                    color_space is None
                    or len(color_space) != 2
                    or str(color_space[0]) != "/ICCBased"
                    or int(color_space[1].get("/N", 0)) != 3
                ):
                    raise RuntimeError("native merger lam mat ICCBased RGB")

            return {
                "pages": 1,
                "width_pt": round(width_pt, 6),
                "height_pt": round(height_pt, 6),
                "alpha": True,
                "icc_components": 3,
            }
    except Exception as exc:
        if isinstance(exc, RuntimeError) and str(exc).startswith("pdfcompare_native thieu symbol"):
            raise
        raise RuntimeError(f"Native merger behavior smoke that bai: {type(exc).__name__}") from exc


def run_artifact_runtime_self_test() -> dict[str, Any]:
    """Chay import/session/inference bang chinh runtime nam trong frozen sidecar."""

    # BUILD (audit 2026-08-04 §BLD.02/§TEST.02): marker phải chứng minh
    # entitlement của chính binary, không chỉ chứng minh thư viện AI nạp được.
    feature_gate = _verify_entitlement_gate()

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

    # RELEASE (audit 2026-08-11 §UP.X.09): callable chưa đủ. Chạy ABI + merger
    # thật và parse artifact để khóa pHYs, alpha và ICCBased RGB trong frozen runtime.
    native_merger_behavior = _run_native_merger_smoke()

    return {
        "status": "ok",
        "feature_gate": feature_gate,
        "providers": sorted(required),
        "models": models,
        "native_merger": True,
        "native_merger_behavior": native_merger_behavior,
    }
