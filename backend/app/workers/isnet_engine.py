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

import onnxruntime as ort
import numpy as np
from PIL import Image

from app.workers.model_cache import ensure_model

logger = logging.getLogger(__name__)

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
# Dùng chung cache với rembg (~/.u2net) để không tải lại nếu đã có.
MODEL_DIR = os.path.expanduser(os.path.join("~", ".u2net"))
MODEL_PATH = os.path.join(MODEL_DIR, "isnet-general-use.onnx")
MODEL_SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
_BUNDLED_MODELS = os.path.join(os.path.dirname(__file__), "..", "data", "models")

_session = None
_session_lock = threading.Lock()
_run_lock = threading.Lock()
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


def _create_session(path: str, providers: list[str]):
    """Tạo session đúng hợp đồng của DirectML."""
    options = ort.SessionOptions()
    if 'DmlExecutionProvider' in providers:
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
    return ort.InferenceSession(path, sess_options=options, providers=providers)


def _download_model_if_needed():
    return ensure_model(
        filename=os.path.basename(MODEL_PATH),
        url=MODEL_URL,
        expected_sha256=MODEL_SHA256,
        cache_dir=MODEL_DIR,
        bundled_dir=_BUNDLED_MODELS,
    )


def _get_session():
    global _session
    if _session is not None:
        return _session
    with _session_lock:
        if _session is None:
            model_path = _download_model_if_needed()
            logger.info("Loading ISNet ONNX session (force_cpu=%s)...", _force_cpu)
            providers = _build_providers()
            _session = _create_session(model_path, providers)
            logger.info("ISNet session ready (providers=%s)", _session.get_providers())
    return _session


def _switch_to_cpu():
    global _session, _force_cpu
    with _session_lock:
        _force_cpu = True
        logger.warning("Rebuilding ISNet session on CPU only (GPU không ổn định).")
        _session = _create_session(_download_model_if_needed(), ['CPUExecutionProvider'])
    return _session


def preprocess(image: Image.Image, size=(1024, 1024)) -> np.ndarray:
    im = image.convert("RGB").resize(size, Image.LANCZOS)
    arr = np.array(im).astype(np.float32)
    arr = arr / max(float(arr.max()), 1e-6)
    arr = (arr - 0.5) / 1.0  # mean=0.5, std=1.0
    arr = arr.transpose((2, 0, 1))
    return np.expand_dims(arr, 0).astype(np.float32)


def predict_alpha(image: Image.Image) -> Image.Image:
    """Chạy ISNet và chỉ trả mask Alpha; caller không cần màu foreground."""
    orig_w, orig_h = image.size
    input_tensor = preprocess(image)

    def _run_with_fallback():
        session = _get_session()
        input_name = session.get_inputs()[0].name
        try:
            return session.run(None, {input_name: input_tensor})
        except Exception as e:
            if not _force_cpu:
                logger.warning("ISNet GPU inference lỗi (%s) → rớt về CPU.", e)
                session = _switch_to_cpu()
                input_name = session.get_inputs()[0].name
                return session.run(None, {input_name: input_tensor})
            raise

    session = _get_session()
    if 'DmlExecutionProvider' in session.get_providers():
        # PERF (audit 2026-07-28 §BG.01): DirectML cấm concurrent Run trên
        # cùng session; CPU/CUDA không bị khoá nên máy mạnh vẫn chạy song song.
        with _run_lock:
            outputs = _run_with_fallback()
    else:
        outputs = _run_with_fallback()

    pred = outputs[0][:, 0, :, :]
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / (ma - mi + 1e-8)
    pred = np.squeeze(pred)

    # BILINEAR (không overshoot) thay LANCZOS: mask xác suất phóng to bằng LANCZOS bị
    # vọt lố quanh mép cứng → sinh vành alpha bán trong suốt ("viền rác"). BILINEAR êm hơn.
    return Image.fromarray((pred * 255).astype(np.uint8), mode="L").resize(
        (orig_w, orig_h),
        Image.BILINEAR,
    )


def remove_background(image: Image.Image) -> Image.Image:
    """Tách nền bằng ISNet, trả PIL RGBA (nền trong suốt)."""
    mask = predict_alpha(image)

    # refine_foreground: tẩy màu nền lẫn ở mép (thay cho GaussianBlur làm nhoè).
    from app.workers.image_postprocessor import refine_foreground_rgba
    return refine_foreground_rgba(image, mask)


def warmup() -> bool:
    """Nạp sẵn session; suy luận thật chỉ chạy khi người dùng bắt đầu xử lý."""
    try:
        # PERF (audit 2026-07-28 §BG.08): ảnh giả 32 px vẫn bị preprocess thành
        # 1024×1024, khiến lúc mở công cụ phải chờ một lượt inference đầy đủ.
        # Session lock đã bảo vệ việc khởi tạo đồng thời; request thật sẽ tự chờ
        # session này và xử lý đúng provider đã chọn.
        _get_session()
        return True
    except Exception as e:
        logger.warning("ISNet warmup failed: %s", e)
        return False
