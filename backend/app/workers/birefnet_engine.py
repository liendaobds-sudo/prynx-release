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
import gc
import logging
import threading

import onnxruntime as ort
import numpy as np
from PIL import Image

from app.core.system_memory import read_memory_status_mb
from app.workers.model_cache import ensure_model

logger = logging.getLogger(__name__)

_BUNDLED_MODELS = os.path.join(os.path.dirname(__file__), "..", "data", "models")
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
MODEL_SHA256 = {
    "full": "58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c",
    "lite": "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
}

_sessions: dict = {}
_session_lock = threading.Lock()
_run_locks = {variant: threading.Lock() for variant in MODELS}
# Ép CPU ngay từ đầu bằng env PRYNX_BG_FORCE_CPU=1 (bỏ qua GPU; tránh OOM/treo máy yếu).
_force_cpu = os.environ.get('PRYNX_BG_FORCE_CPU', '').lower() in ('1', 'true', 'yes')

# DirectML có thể giữ arena rất lớn sau inference dù output chỉ vài MB. Chỉ nhả
# session khi RAM khả dụng thật đã xuống vùng nguy hiểm; máy mạnh còn dư RAM vẫn
# giữ cache và tốc độ đầy đủ.
_DML_MIN_AVAILABLE_RAM_RATIO = 0.25
_DML_MIN_AVAILABLE_RAM_MB = 2048.0

# PERF/STABILITY (audit 2026-08-24 §STICKER-AI.OOM1): admission theo RAM khả dụng
# thật; không hạ kích thước input trên máy đủ bộ nhớ. Lite cần khoảng 2 lần buffer
# 822 MB đã quan sát; full dùng biên an toàn lớn hơn theo kích thước model.
_CPU_FALLBACK_MIN_AVAILABLE_RAM_MB = {
    "lite": 2048.0,
    "full": 4096.0,
}


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


def _create_session(path: str, providers: list[str]):
    """Tạo session đúng hợp đồng của DirectML."""
    options = ort.SessionOptions()
    if 'DmlExecutionProvider' in providers:
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
    return ort.InferenceSession(path, sess_options=options, providers=providers)


def _download_model_if_needed(variant: str):
    url, path = MODELS[variant]
    return ensure_model(
        filename=os.path.basename(path),
        url=url,
        expected_sha256=MODEL_SHA256[variant],
        cache_dir=_U2NET_HOME,
        bundled_dir=_BUNDLED_MODELS,
    )


def _ensure_cpu_fallback_memory(variant: str, *, fallback: bool = True) -> None:
    """Chặn sớm lượt CPU chắc chắn không vừa ngân sách RAM hiện tại."""
    _total_mb, available_mb = read_memory_status_mb()
    if available_mb is None:
        # Windows API lỗi/không có số liệu: giữ fail-open như các admission
        # khác của backend, để không biến lỗi đo RAM thành lỗi tính năng.
        return
    try:
        available_value = float(available_mb)
    except (TypeError, ValueError):
        return
    if available_value < 0:
        return
    required_mb = _CPU_FALLBACK_MIN_AVAILABLE_RAM_MB.get(variant, 2048.0)
    if available_value >= required_mb:
        return
    phase_label = "CPU fallback" if fallback else "CPU"
    logger.warning(
        "BiRefNet[%s] bỏ qua %s: RAM khả dụng %.0f MB < %.0f MB.",
        variant,
        phase_label,
        available_value,
        required_mb,
    )
    raise MemoryError(
        f"BiRefNet[{variant}] {phase_label} cần ít nhất {required_mb:.0f} MB "
        f"RAM khả dụng, hiện chỉ còn {available_value:.0f} MB."
    )


def _get_session(variant: str = "full"):
    s = _sessions.get(variant)
    if s is not None:
        return s
    with _session_lock:
        if _sessions.get(variant) is None:
            if _force_cpu:
                _ensure_cpu_fallback_memory(variant, fallback=False)
            path = _download_model_if_needed(variant)
            logger.info("Loading BiRefNet[%s] session (force_cpu=%s)...", variant, _force_cpu)
            providers = _build_providers()
            _sessions[variant] = _create_session(path, providers)
            logger.info("BiRefNet[%s] ready (providers=%s)", variant, _sessions[variant].get_providers())
    return _sessions[variant]


def _discard_cached_session_locked(variant: str) -> None:
    """Bỏ session dưới `_session_lock` và cắt tham chiếu native ngay lập tức."""
    failed_session = _sessions.pop(variant, None)
    close = getattr(failed_session, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            logger.debug(
                "BiRefNet[%s] không đóng được session.",
                variant,
                exc_info=True,
            )
    # onnxruntime.InferenceSession không công khai close(); tài nguyên DirectML
    # thật nằm trong `_sess`. Cắt tham chiếu native trước khi gc để arena được hủy.
    native_session = getattr(failed_session, "_sess", None)
    if native_session is not None:
        try:
            failed_session._sess = None
        except Exception:
            logger.debug(
                "BiRefNet[%s] không tháo được native session.",
                variant,
                exc_info=True,
            )
        native_session = None
    failed_session = None
    gc.collect()


def _discard_dml_session_if_memory_pressure(variant: str) -> bool:
    """Nhả arena DML khi nó vừa đẩy RAM hệ thống xuống vùng nguy hiểm.

    PERF/STABILITY (feedback 2026-08-20 §CUTPREVIEW.DML1): đây không phải trần
    chất lượng hay worker. Chỉ khi RAM khả dụng sau inference thấp hơn 25% tổng
    RAM (tối thiểu 2 GB), session DML mới bị bỏ và những lượt sau chuyển CPU
    cùng model. Máy còn dư RAM vẫn giữ nguyên fast path DirectML.
    """
    total_mb, available_mb = read_memory_status_mb()
    if (
        total_mb is None
        or available_mb is None
        or total_mb <= 0
        or available_mb < 0
    ):
        return False
    minimum_available_mb = max(
        _DML_MIN_AVAILABLE_RAM_MB,
        float(total_mb) * _DML_MIN_AVAILABLE_RAM_RATIO,
    )
    if float(available_mb) >= minimum_available_mb:
        return False

    global _force_cpu
    with _session_lock:
        session = _sessions.get(variant)
        providers = session.get_providers() if session is not None else ()
        if "DmlExecutionProvider" not in providers:
            return False
        _force_cpu = True
        _discard_cached_session_locked(variant)
    logger.warning(
        "BiRefNet[%s] nhả DirectML arena vì RAM khả dụng %.0f MB < %.0f MB; "
        "các lượt sau dùng CPU.",
        variant,
        available_mb,
        minimum_available_mb,
    )
    return True


def _switch_to_cpu(variant: str):
    """Dựng lại session CPU sau khi GPU lỗi (OOM 8007000E / device-hung 887A0007).
    Sticky: mọi lần sau dùng CPU → tránh treo GPU lặp lại."""
    global _force_cpu
    with _session_lock:
        _force_cpu = True
        # STABILITY (audit 2026-08-05 §AI2.RUNTIME1): phải tháo session GPU lỗi
        # khỏi cache và giải phóng tài nguyên trước khi nạp thêm model CPU. Nếu giữ
        # đồng thời hai session, DirectML OOM thường nối tiếp bằng bad allocation.
        _discard_cached_session_locked(variant)
        # Kiểm tra sau khi nhả native DML để không dựng CPU session vô ích.
        _ensure_cpu_fallback_memory(variant)
        path = _download_model_if_needed(variant)
        logger.warning("Rebuilding BiRefNet[%s] on CPU only (GPU không ổn định).", variant)
        _sessions[variant] = _create_session(path, ['CPUExecutionProvider'])
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


def predict_alpha(image: Image.Image, variant: str = "full") -> Image.Image:
    """Chạy BiRefNet và chỉ trả mask Alpha; caller không cần màu foreground."""
    if variant not in MODELS:
        variant = "full"
    orig_w, orig_h = image.size
    input_tensor = preprocess(image)

    def _run_with_fallback():
        session = _get_session(variant)
        input_name = session.get_inputs()[0].name
        try:
            return session.run(None, {input_name: input_tensor})
        except Exception as e:
            if not _force_cpu:
                logger.warning("BiRefNet[%s] GPU lỗi (%s) → rớt về CPU.", variant, e)
                # Không giữ thêm một tham chiếu local tới session GPU trong lúc
                # _switch_to_cpu() giải phóng cache và dựng session CPU.
                session = None
                session = _switch_to_cpu(variant)
                input_name = session.get_inputs()[0].name
                return session.run(None, {input_name: input_tensor})
            raise

    if 'DmlExecutionProvider' in _get_session(variant).get_providers():
        # PERF (audit 2026-07-28 §BG.01): chỉ tuần tự hoá cùng một DirectML
        # session. Variant khác và CPU/CUDA vẫn chạy song song trên máy mạnh.
        with _run_locks[variant]:
            outputs = _run_with_fallback()
            _discard_dml_session_if_memory_pressure(variant)
    else:
        outputs = _run_with_fallback()

    # Raw logits [1,1,1024,1024] → sigmoid → mask
    mask_logits = outputs[-1]
    mask_prob = 1.0 / (1.0 + np.exp(-mask_logits))
    mask_prob = np.squeeze(mask_prob)

    # BILINEAR (không overshoot) thay BICUBIC: mask xác suất phóng to bằng BICUBIC bị
    # vọt lố quanh mép cứng → sinh vành alpha bán trong suốt ("viền rác"). BILINEAR êm hơn.
    mask_img = Image.fromarray((mask_prob * 255).astype(np.uint8), mode="L")
    return mask_img.resize((orig_w, orig_h), Image.BILINEAR)


def remove_background(image: Image.Image, variant: str = "full") -> Image.Image:
    """Tách nền bằng BiRefNet (variant 'full' hoặc 'lite'), trả PIL RGBA."""
    mask_final = predict_alpha(image, variant=variant)

    # refine_foreground: tẩy màu nền lẫn ở mép (thay cho GaussianBlur làm nhoè).
    from app.workers.image_postprocessor import refine_foreground_rgba
    return refine_foreground_rgba(image, mask_final)


def warmup(variant: str = "lite") -> bool:
    """Nạp sẵn session của biến thể; không chạy inference giả khi mở công cụ."""
    try:
        # PERF (audit 2026-07-28 §BG.08): warmup cũ resize ảnh giả lên
        # 1024×1024 rồi chạy trọn model, làm UI chờ lâu trước cả khi bấm xử lý.
        _get_session(variant)
        return True
    except Exception as e:
        logger.warning("BiRefNet[%s] warmup failed: %s", variant, e)
        return False
