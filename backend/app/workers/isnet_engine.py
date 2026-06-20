"""
isnet_engine — Tách nền bằng model NHẸ ISNet (isnet-general-use, ~178MB).

Thay cho BiRefNet (927MB) ở chế độ mặc định: nhẹ hơn ~5×, hợp GPU yếu VRAM và
nhanh hơn trên CPU. Chạy ONNX TRỰC TIẾP qua onnxruntime — KHÔNG qua rembg (rembg
trong môi trường này hỏng do pymatting→cupy lỗi).

Tiền/hậu xử lý sao đúng theo rembg `dis_general_use`:
  - resize 1024×1024 LANCZOS, chia max, chuẩn hoá mean=0.5/std=1.0, NCHW.
  - mask = (pred - min)/(max - min), resize về kích thước gốc, gán alpha.

Có cơ chế GPU→CPU fallback giống birefnet_engine (DirectML có thể OOM/treo).
"""
import os
import logging
import threading

import httpx
import onnxruntime as ort
import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
# Dùng chung cache với rembg (~/.u2net) để không tải lại nếu đã có.
MODEL_DIR = os.path.expanduser(os.path.join("~", ".u2net"))
MODEL_PATH = os.path.join(MODEL_DIR, "isnet-general-use.onnx")

_session = None
_session_lock = threading.Lock()
_force_cpu = os.environ.get('PRYNX_BG_FORCE_CPU', '').lower() in ('1', 'true', 'yes')


def _build_providers():
    if _force_cpu:
        return ['CPUExecutionProvider']
    available = ort.get_available_providers()
    providers = []
    if 'CUDAExecutionProvider' in available:
        providers.append('CUDAExecutionProvider')
    if 'DmlExecutionProvider' in available:
        providers.append('DmlExecutionProvider')
    providers.append('CPUExecutionProvider')
    return providers


def _download_model_if_needed():
    os.makedirs(MODEL_DIR, exist_ok=True)
    if not os.path.exists(MODEL_PATH):
        logger.info("Downloading ISNet model from %s ...", MODEL_URL)
        with httpx.stream("GET", MODEL_URL, follow_redirects=True) as r:
            r.raise_for_status()
            with open(MODEL_PATH, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=8192):
                    f.write(chunk)
        logger.info("ISNet download complete.")


def _get_session():
    global _session
    if _session is not None:
        return _session
    with _session_lock:
        if _session is None:
            _download_model_if_needed()
            logger.info("Loading ISNet ONNX session (force_cpu=%s)...", _force_cpu)
            _session = ort.InferenceSession(MODEL_PATH, providers=_build_providers())
            logger.info("ISNet session ready (providers=%s)", _session.get_providers())
    return _session


def _switch_to_cpu():
    global _session, _force_cpu
    with _session_lock:
        _force_cpu = True
        logger.warning("Rebuilding ISNet session on CPU only (GPU không ổn định).")
        _session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    return _session


def preprocess(image: Image.Image, size=(1024, 1024)) -> np.ndarray:
    im = image.convert("RGB").resize(size, Image.LANCZOS)
    arr = np.array(im).astype(np.float32)
    arr = arr / max(float(arr.max()), 1e-6)
    arr = (arr - 0.5) / 1.0  # mean=0.5, std=1.0
    arr = arr.transpose((2, 0, 1))
    return np.expand_dims(arr, 0).astype(np.float32)


def remove_background(image: Image.Image) -> Image.Image:
    """Tách nền bằng ISNet, trả PIL RGBA (nền trong suốt)."""
    orig_w, orig_h = image.size
    session = _get_session()
    input_name = session.get_inputs()[0].name
    input_tensor = preprocess(image)

    try:
        outputs = session.run(None, {input_name: input_tensor})
    except Exception as e:
        if not _force_cpu:
            logger.warning("ISNet GPU inference lỗi (%s) → rớt về CPU.", e)
            session = _switch_to_cpu()
            input_name = session.get_inputs()[0].name
            outputs = session.run(None, {input_name: input_tensor})
        else:
            raise

    pred = outputs[0][:, 0, :, :]
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / (ma - mi + 1e-8)
    pred = np.squeeze(pred)

    mask = Image.fromarray((pred * 255).astype(np.uint8), mode="L").resize((orig_w, orig_h), Image.LANCZOS)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=0.5))  # mềm mép nhẹ

    result = image.convert("RGBA")
    result.putalpha(mask)
    return result


def warmup() -> bool:
    """Nạp sẵn + 1 suy luận nhỏ (tự rớt CPU nếu GPU lỗi)."""
    try:
        remove_background(Image.new("RGB", (32, 32), (255, 255, 255)))
        return True
    except Exception as e:
        logger.warning("ISNet warmup failed: %s", e)
        return False
