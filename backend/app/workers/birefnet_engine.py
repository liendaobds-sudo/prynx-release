"""
birefnet_engine — Tách nền bằng BiRefNet (chất lượng cao). Hỗ trợ 2 biến thể:

  - 'full': BiRefNet-general (927MB) — chất lượng tối đa (tóc/lông/kính), NẶNG
            (thường OOM trên GPU yếu VRAM → tự rớt CPU ~14s).
  - 'lite': BiRefNet-general-lite swin-tiny (224MB) — gần bằng full, VỪA VRAM GPU,
            nhanh hơn nhiều (CNN/transformer nhẹ). Dùng làm mặc định "chất lượng cao".

Chạy ONNX trực tiếp (không qua rembg — rembg hỏng do pymatting→cupy). Có cơ chế
GPU→CPU fallback (DirectML có thể OOM/treo) + env PRYNX_BG_FORCE_CPU=1 ép CPU.
"""
import os
import logging
import threading

import httpx
import onnxruntime as ort
import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

_DATA_MODELS = os.path.join(os.path.dirname(__file__), "..", "..", "data", "models")
_U2NET_HOME = os.path.expanduser(os.path.join("~", ".u2net"))

# variant -> (url, local_path)
# LƯU Ý: cache model ở ~/.u2net (thư mục HOME ổn định) cho MỌI biến thể. Trước đây 'full'
# lưu vào data/models tính theo __file__ — trong bản Nuitka onefile, __file__ nằm trong thư
# mục giải nén TẠM (bị xoá khi thoát) → tải lại 927MB mỗi lần mở / ghi lỗi. Dùng HOME để bền.
MODELS = {
    "full": (
        "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx",
        os.path.join(_U2NET_HOME, "BiRefNet-general-epoch_244.onnx"),
    ),
    "lite": (
        "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
        os.path.join(_U2NET_HOME, "birefnet-general-lite.onnx"),
    ),
}

_sessions: dict = {}
_session_lock = threading.Lock()
# Ép CPU ngay từ đầu bằng env PRYNX_BG_FORCE_CPU=1 (bỏ qua GPU; tránh OOM/treo máy yếu).
_force_cpu = os.environ.get('PRYNX_BG_FORCE_CPU', '').lower() in ('1', 'true', 'yes')


def _build_providers():
    if _force_cpu:
        return ['CPUExecutionProvider']
    available = ort.get_available_providers()
    providers = []
    if 'CUDAExecutionProvider' in available:
        providers.append('CUDAExecutionProvider')
    if 'DmlExecutionProvider' in available:
        providers.append('DmlExecutionProvider')  # Windows DirectML
    providers.append('CPUExecutionProvider')
    return providers


def _download_model_if_needed(variant: str):
    url, path = MODELS[variant]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        logger.info("Downloading BiRefNet[%s] from %s ...", variant, url)
        with httpx.stream("GET", url, follow_redirects=True) as r:
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=8192):
                    f.write(chunk)
        logger.info("BiRefNet[%s] download complete.", variant)


def _get_session(variant: str = "full"):
    s = _sessions.get(variant)
    if s is not None:
        return s
    with _session_lock:
        if _sessions.get(variant) is None:
            _download_model_if_needed(variant)
            _, path = MODELS[variant]
            logger.info("Loading BiRefNet[%s] session (force_cpu=%s)...", variant, _force_cpu)
            _sessions[variant] = ort.InferenceSession(path, providers=_build_providers())
            logger.info("BiRefNet[%s] ready (providers=%s)", variant, _sessions[variant].get_providers())
    return _sessions[variant]


def _switch_to_cpu(variant: str):
    """Dựng lại session CPU sau khi GPU lỗi (OOM 8007000E / device-hung 887A0007).
    Sticky: mọi lần sau dùng CPU → tránh treo GPU lặp lại."""
    global _force_cpu
    with _session_lock:
        _force_cpu = True
        _, path = MODELS[variant]
        logger.warning("Rebuilding BiRefNet[%s] on CPU only (GPU không ổn định).", variant)
        _sessions[variant] = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    return _sessions[variant]


def preprocess(image: Image.Image, size=(1024, 1024)):
    """Resize 1024 + chuẩn hoá ImageNet (chung cho cả full & lite)."""
    image = image.convert("RGB")
    img_resized = image.resize(size, Image.BILINEAR)
    img_arr = np.array(img_resized, dtype=np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    img_arr = (img_arr - mean) / std
    img_arr = np.transpose(img_arr, (2, 0, 1))
    return np.expand_dims(img_arr, axis=0)


def remove_background(image: Image.Image, variant: str = "full") -> Image.Image:
    """Tách nền bằng BiRefNet (variant 'full' hoặc 'lite'), trả PIL RGBA."""
    if variant not in MODELS:
        variant = "full"
    orig_w, orig_h = image.size
    session = _get_session(variant)
    input_name = session.get_inputs()[0].name
    input_tensor = preprocess(image)

    try:
        outputs = session.run(None, {input_name: input_tensor})
    except Exception as e:
        if not _force_cpu:
            logger.warning("BiRefNet[%s] GPU lỗi (%s) → rớt về CPU.", variant, e)
            session = _switch_to_cpu(variant)
            input_name = session.get_inputs()[0].name
            outputs = session.run(None, {input_name: input_tensor})
        else:
            raise

    # Raw logits [1,1,1024,1024] → sigmoid → mask
    mask_logits = outputs[-1]
    mask_prob = 1.0 / (1.0 + np.exp(-mask_logits))
    mask_prob = np.squeeze(mask_prob)

    mask_img = Image.fromarray((mask_prob * 255).astype(np.uint8), mode="L")
    mask_final = mask_img.resize((orig_w, orig_h), Image.BILINEAR)
    mask_final = mask_final.filter(ImageFilter.GaussianBlur(radius=0.75))

    result_img = image.convert("RGBA")
    result_img.putalpha(mask_final)
    return result_img


def warmup(variant: str = "lite") -> bool:
    """Nạp sẵn + 1 suy luận nhỏ (tự rớt CPU nếu GPU lỗi). Mặc định warm biến thể 'lite'."""
    try:
        remove_background(Image.new("RGB", (32, 32), (255, 255, 255)), variant=variant)
        return True
    except Exception as e:
        logger.warning("BiRefNet[%s] warmup failed: %s", variant, e)
        return False
