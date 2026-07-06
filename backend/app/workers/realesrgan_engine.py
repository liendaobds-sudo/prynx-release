"""
realesrgan_engine — Phóng to ảnh (super-resolution) bằng Real-ESRGAN chạy ONNX.

Thay cho Anime4K (WebGPU client-side, gốc cho VIDEO anime — làm sắc mép giả, KHÔNG
tái tạo texture). Real-ESRGAN được huấn luyện trên "suy biến ảnh thật" (nhiễu, nén
JPEG, mờ) nên phục hồi chi tiết ảnh chụp/sản phẩm in tốt hơn hẳn.

MỘT model duy nhất (scale x4, input RGB [0,1] NCHW, output RGB 4x): SRVGGNetCompact
(~5MB) — nhẹ, hợp ảnh chụp/sản phẩm, chạy tốt cả GPU lẫn CPU. Bản export mặc định là
x4v3 THUẦN (giữ chi tiết tối đa; blend khử nhiễu wdn làm bệt texture ảnh in nên tắt —
xem --alpha trong convert script nếu ảnh nguồn nhiễu nặng cần khử bớt).
Biến thể RRDBNet 'plus' đã bỏ: nặng ~25× (127s/ô 512px trên CPU) → phi thực tế.

Model .onnx KHÔNG tải từ mạng: repo gốc (xinntao) chỉ phát hành .pth. Bản .onnx do
scripts/convert_realesrgan_onnx.py sinh ở BƯỚC BUILD (torch chỉ ở máy build, không
vào runtime). Runtime chỉ cần onnxruntime — đồng bộ triết lý với isnet/birefnet.

Có TILING (chia ô + biên đệm) để ảnh in độ phân giải cao không nổ VRAM, GPU→CPU
fallback (DirectML có thể OOM/treo) + env PRYNX_UPSCALE_FORCE_CPU=1 ép CPU.
"""
import os
import logging
import threading

import onnxruntime as ort
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Cache .onnx ở HOME (~/.u2net) — dùng chung thư mục với isnet/birefnet, thư mục ỔN
# ĐỊNH (không bị Nuitka onefile giải nén tạm rồi xoá). Nếu thiếu, thử fallback thư
# mục data bundle cạnh package (build_production.ps1 copy vào), rồi mới báo lỗi rõ.
_U2NET_HOME = os.path.expanduser(os.path.join("~", ".u2net"))
_BUNDLED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "models")

SCALE = 4  # model x4

# variant -> tên file .onnx. Chỉ còn 'general' (bản DNI-blend khử nhiễu). Giữ dạng
# dict để hàm cũ (variant not in MODELS → general) và chỗ gọi không phải đổi chữ ký.
MODELS = {
    "general": "realesr-general-x4v3.onnx",
}

_sessions: dict = {}
_session_lock = threading.Lock()
_force_cpu = os.environ.get('PRYNX_UPSCALE_FORCE_CPU', '').lower() in ('1', 'true', 'yes')


def _build_providers():
    if _force_cpu:
        return ['CPUExecutionProvider']
    available = ort.get_available_providers()
    providers = []
    if 'CUDAExecutionProvider' in available:
        providers.append('CUDAExecutionProvider')
    if 'DmlExecutionProvider' in available:
        providers.append('DmlExecutionProvider')  # Windows DirectML (NVIDIA/AMD/Intel)
    providers.append('CPUExecutionProvider')
    return providers


def _resolve_model_path(variant: str) -> str:
    fname = MODELS[variant]
    for base in (_U2NET_HOME, _BUNDLED_DIR):
        p = os.path.join(base, fname)
        if os.path.exists(p):
            return p
    # KHÔNG bịa URL tải: .onnx là bản tự convert ở build. Báo lỗi rõ để biết cách sửa.
    raise FileNotFoundError(
        f"Không tìm thấy model Real-ESRGAN '{fname}'. Chạy "
        f"scripts/convert_realesrgan_onnx.py (máy có torch) để sinh file, hoặc đặt "
        f"vào {_U2NET_HOME}."
    )


def _get_session(variant: str = "general"):
    s = _sessions.get(variant)
    if s is not None:
        return s
    with _session_lock:
        if _sessions.get(variant) is None:
            path = _resolve_model_path(variant)
            logger.info("Loading Real-ESRGAN[%s] session (force_cpu=%s)...", variant, _force_cpu)
            _sessions[variant] = ort.InferenceSession(path, providers=_build_providers())
            logger.info("Real-ESRGAN[%s] ready (providers=%s)", variant, _sessions[variant].get_providers())
    return _sessions[variant]


def _switch_to_cpu(variant: str):
    """Dựng lại session CPU sau khi GPU lỗi (OOM/device-hung). Sticky để tránh treo lặp."""
    global _force_cpu
    with _session_lock:
        _force_cpu = True
        path = _resolve_model_path(variant)
        logger.warning("Rebuilding Real-ESRGAN[%s] on CPU only (GPU không ổn định).", variant)
        _sessions[variant] = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    return _sessions[variant]


def _run_session(variant: str, tile_nchw: np.ndarray) -> np.ndarray:
    """Chạy 1 ô qua model; nếu GPU lỗi thì rớt CPU rồi chạy lại (giống isnet/birefnet)."""
    session = _get_session(variant)
    input_name = session.get_inputs()[0].name
    try:
        out = session.run(None, {input_name: tile_nchw})[0]
    except Exception as e:
        if not _force_cpu:
            logger.warning("Real-ESRGAN[%s] GPU lỗi (%s) → rớt về CPU.", variant, e)
            session = _switch_to_cpu(variant)
            input_name = session.get_inputs()[0].name
            out = session.run(None, {input_name: tile_nchw})[0]
        else:
            raise
    return out


def _upscale_rgb(rgb: np.ndarray, variant: str, tile: int, tile_pad: int) -> np.ndarray:
    """Phóng to mảng RGB HxWx3 float32 [0,1] lên 4x bằng tiling.

    Chia ảnh thành ô `tile`×`tile` với biên đệm `tile_pad` (chồng mép để tránh vệt
    nối), chạy từng ô qua model, ghép lại theo toạ độ ×4. tile<=0 → chạy nguyên ảnh.
    """
    h, w, _ = rgb.shape
    out_h, out_w = h * SCALE, w * SCALE
    output = np.zeros((out_h, out_w, 3), dtype=np.float32)

    if tile is None or tile <= 0:
        tiles_x = tiles_y = 1
        tile = max(h, w)
    else:
        tiles_x = (w + tile - 1) // tile
        tiles_y = (h + tile - 1) // tile

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            # Vùng ô (chưa đệm) trong ảnh gốc.
            x0, y0 = tx * tile, ty * tile
            x1, y1 = min(x0 + tile, w), min(y0 + tile, h)
            # Vùng có biên đệm để lấy ngữ cảnh, tránh vệt nối.
            px0, py0 = max(x0 - tile_pad, 0), max(y0 - tile_pad, 0)
            px1, py1 = min(x1 + tile_pad, w), min(y1 + tile_pad, h)

            patch = rgb[py0:py1, px0:px1, :]
            inp = np.transpose(patch, (2, 0, 1))[None, ...].astype(np.float32)
            sr = _run_session(variant, inp)  # [1,3,ph*4,pw*4]
            sr = np.clip(np.squeeze(sr, 0).transpose(1, 2, 0), 0.0, 1.0)

            # Cắt bỏ phần đệm (đã ×4) để lấy đúng ô lõi, rồi dán vào output.
            crop_x0 = (x0 - px0) * SCALE
            crop_y0 = (y0 - py0) * SCALE
            crop_x1 = crop_x0 + (x1 - x0) * SCALE
            crop_y1 = crop_y0 + (y1 - y0) * SCALE
            output[y0 * SCALE:y1 * SCALE, x0 * SCALE:x1 * SCALE, :] = sr[crop_y0:crop_y1, crop_x0:crop_x1, :]

    return output


def upscale(image: Image.Image, variant: str = "general", tile: int = 512, tile_pad: int = 16) -> Image.Image:
    """Phóng to ảnh 4x bằng Real-ESRGAN. Giữ alpha (nếu có) bằng resize chất lượng cao.

    Alpha KHÔNG chạy qua model SR (model huấn luyện cho RGB): alpha thường là mask
    tách nền, phóng to bằng LANCZOS đủ mượt và không sinh artefact màu.
    """
    if variant not in MODELS:
        variant = "general"

    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    src = image.convert("RGBA") if has_alpha else image.convert("RGB")

    rgb = np.asarray(src.convert("RGB"), dtype=np.float32) / 255.0
    out_rgb = _upscale_rgb(rgb, variant, tile, tile_pad)
    out_u8 = (out_rgb * 255.0 + 0.5).astype(np.uint8)
    result = Image.fromarray(out_u8, "RGB")

    if has_alpha:
        alpha = src.split()[-1]
        alpha_up = alpha.resize((result.width, result.height), Image.LANCZOS)
        result = result.convert("RGBA")
        result.putalpha(alpha_up)

    return result


def warmup(variant: str = "general") -> bool:
    """Nạp sẵn + 1 suy luận nhỏ (tự rớt CPU nếu GPU lỗi)."""
    try:
        upscale(Image.new("RGB", (16, 16), (127, 127, 127)), variant=variant, tile=0)
        return True
    except Exception as e:
        logger.warning("Real-ESRGAN[%s] warmup failed: %s", variant, e)
        return False
