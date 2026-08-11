"""
realesrgan_engine — Phóng to ảnh (super-resolution) bằng Real-ESRGAN chạy ONNX.

Thay cho Anime4K (WebGPU client-side, gốc cho VIDEO anime — làm sắc mép giả, KHÔNG
tái tạo texture). Real-ESRGAN được huấn luyện trên "suy biến ảnh thật" (nhiễu, nén
JPEG, mờ) nên phục hồi chi tiết ảnh chụp/sản phẩm in tốt hơn hẳn.

Hai model scale x4, input RGB [0,1] NCHW:
  - general: SRVGGNetCompact x4v3 (~5 MB), nhanh, phù hợp máy yếu.
  - quality: RealESRGAN_x4plus RRDBNet 23 khối (~67 MB), chi tiết tốt hơn cho ảnh
    chụp/sản phẩm; ưu tiên GPU và chậm đáng kể khi phải chạy CPU.

Model .onnx KHÔNG tải từ mạng: repo gốc (xinntao) chỉ phát hành .pth. Bản .onnx do
scripts/convert_realesrgan_onnx.py sinh ở BƯỚC BUILD (torch chỉ ở máy build, không
vào runtime). Runtime chỉ cần onnxruntime — đồng bộ triết lý với isnet/birefnet.

Có TILING (chia ô + biên đệm) để ảnh in độ phân giải cao không nổ VRAM, GPU→CPU
fallback (DirectML có thể OOM/treo) + env PRYNX_UPSCALE_FORCE_CPU=1 ép CPU.
"""
import os
import logging
import threading
import hashlib
import functools
import time
from collections.abc import Callable
from contextlib import nullcontext

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

# variant -> tên file .onnx. Giữ dạng
# dict để hàm cũ (variant not in MODELS → general) và chỗ gọi không phải đổi chữ ký.
MODELS = {
    "general": "realesr-general-x4v3.onnx",
    "quality": "realesrgan-x4plus.onnx",
}

# UPSCALE (audit 2026-07-28 §UP-05/11): khóa đúng artifact đã benchmark và khai
# trong NOTICE. File cùng tên nhưng khác trọng số không được lọt vào dev/release.
#
# UPSCALE (audit 2026-07-29 §NET.02): 'general' đã đổi trọng số — DNI alpha 1,0
# (khử nhiễu MẠNH NHẤT) → 0,5 (mặc định upstream). Đo được trên corpus audit:
# ảnh chụp độ nét +9,6% và HF% +7,7% mà PSNR/SSIM còn nhúc lên, tức lấy lại texture
# KHÔNG phải trả giá. Hash cũ: 027319ffe4f00ec2550957c0957d44969638a03d2ed2f0329af9fd6cd44a457a.
MODEL_SHA256 = {
    "general": "3ae50bb3a9131697d62ac79f934e57c2ef9cd3b8762993ca0d1fabd8a36a343f",
    "quality": "c1b85fae35947577b4c4b7d310af54546c6e7971f14a0862a769e83689ddc003",
}

_sessions: dict = {}
_session_lock = threading.Lock()
# PERF (audit 2026-07-28 §UP-14): DirectML cấm nhiều thread gọi Run đồng thời
# trên CÙNG session. Khóa tách theo model để warmup không đua với job thật, nhưng
# general/quality vẫn có thể chạy song song và CPU không bị giới hạn vô điều kiện.
_session_run_locks = {variant: threading.RLock() for variant in MODELS}
_force_cpu_by_env = os.environ.get('PRYNX_UPSCALE_FORCE_CPU', '').lower() in ('1', 'true', 'yes')
_cpu_only_variants: set[str] = set()


class UpscaleUnavailable(RuntimeError):
    """Không thể chạy cấu hình upscale này — thông điệp đã sẵn sàng cho người dùng.

    Route dịch thành HTTP 422 kèm nguyên văn `str(exc)`, khác với lỗi kỹ thuật (500).
    """


class UpscaleCancelled(RuntimeError):
    """Client đã rời tác vụ; dừng ở ranh giới tile/encode an toàn."""


def _raise_if_cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled is not None and cancelled():
        raise UpscaleCancelled("Tác vụ Upscale đã bị hủy.")


# UPSCALE (audit treo 2026-07-28 §1.1): ngưỡng phân biệt "có tăng tốc GPU thật" —
# đo trên ô 256×256, RRDBNet: DirectML ~0,49 s còn CPU ~6,40 s, cách nhau 13 lần nên
# mốc 3 s tách sạch hai ca. Không dùng tên provider để quyết định: `get_providers()`
# trả về provider ĐÃ ĐĂNG KÝ, không phải provider thực thi từng node — máy có
# DirectML luôn trả ['DmlExecutionProvider', 'CPUExecutionProvider'] kể cả khi ORT
# rơi toàn bộ node về CPU, nên phép kiểm theo tên không bao giờ bắt được ca đó.
_PROBE_SIDE = 256
_GPU_TILE_BUDGET_S = 3.0
_MAX_JOB_SECONDS = 300.0

# Ước lượng tuyến tính theo số pixel underestimate vì có overhead cố định mỗi ô.
# Đo được (RRDBNet): 256→0,49 s; 384→1,99 s; 592→4,03 s. Hệ số 1,5 cho ước lượng
# hơi bảo thủ — đủ dùng vì mục đích là cảnh báo ca hàng chục phút, không phải đo chính xác.
_ESTIMATE_SAFETY = 1.5

_probe_seconds: dict[str, float] = {}
_probe_lock = threading.Lock()

# UPSCALE (audit 2026-07-29 §NET.01/§NET.03): cường độ khuếch đại chi tiết AI theo
# chế độ UI. Đây là thang chất lượng THẬT của ba chế độ — trước đây "Chất lượng"
# không có bước hậu xử lý nào nên mềm hơn cả "Nhanh". Chốt số theo bảng đo trong
# docs/BAO_CAO_AUDIT_UPSCALE_DO_NET_2026-07-29.md; đổi số thì phải đo lại.
# Cân bằng nâng 0,12 → 0,15 sau khi model 'general' chuyển sang DNI alpha 0,5
# (§NET.02): model mới trung thực hơn nhưng bớt cứng mép, nên cần bù thêm một chút
# để độ nét cảm nhận không tụt so với cấu hình cũ. Mốc 0,15 là mốc lớn nhất còn
# giữ được khoảng cách ≥10% với chế độ Chất lượng trên ảnh chụp.
_DETAIL_BY_MODE = {
    "general": 0.0,
    "balanced": 0.15,
    "quality": 0.45,
}

# UPSCALE (audit 2026-07-29 §NET.08): §UP-06 đợt trước đo pad trên model NHẸ và
# chốt 40 cho cả hai. RRDBNet 23 khối có receptive field lớn hơn nhiều nên pad 40
# vẫn lệch tới 5 mức màu so với chạy nguyên ảnh. Đo lại trên corpus audit:
#   general: pad 16 → lệch 4 | pad 40 → 0
#   quality: pad 16 → lệch 34 | pad 40 → 5 | pad 64 → 1 | pad 96 → 1
# Chọn 64 cho quality: hết vệt nối mà chỉ tăng ~17% diện tích ô ở tile 512.
_TILE_PAD_BY_VARIANT = {
    "general": 40,
    "quality": 64,
}


def _default_tile_pad(variant: str) -> int:
    return _TILE_PAD_BY_VARIANT.get(variant, 40)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("Bỏ qua %s không hợp lệ: %s", name, raw)
        return default
    return value if value > 0 else default


def probe_tile_seconds(variant: str) -> float:
    """Đo thời gian suy luận MỘT ô 256×256 của `variant`, cache theo tiến trình.

    Lần chạy đầu bị loại khỏi phép đo: DirectML biên dịch graph ở lần đầu nên đắt
    bất thường (đo được model nhẹ: 0,63 s lần đầu rồi 0,04 s khi đã nóng).
    """
    cached = _probe_seconds.get(variant)
    if cached is not None:
        return cached
    with _probe_lock:
        cached = _probe_seconds.get(variant)
        if cached is not None:
            return cached
        session = _get_session(variant)
        run_guard = (
            _session_run_locks[variant]
            if 'DmlExecutionProvider' in session.get_providers()
            else nullcontext()
        )
        with run_guard:
            # Lấy lại session sau khi chờ khóa: lượt trước có thể vừa rớt GPU→CPU.
            session = _get_session(variant)
            input_name = session.get_inputs()[0].name
            tile = np.zeros((1, 3, _PROBE_SIDE, _PROBE_SIDE), dtype=np.float32)
            session.run(None, {input_name: tile})          # làm nóng, KHÔNG tính
            started = time.perf_counter()
            session.run(None, {input_name: tile})
            elapsed = time.perf_counter() - started
        _probe_seconds[variant] = elapsed
        logger.info(
            "Real-ESRGAN[%s] probe ô %d×%d = %.2fs (providers=%s)",
            variant, _PROBE_SIDE, _PROBE_SIDE, elapsed, session.get_providers(),
        )
        return elapsed


def estimate_seconds(width: int, height: int, variant: str,
                     tile: int | None = None, tile_pad: int | None = None) -> float:
    """Ước lượng thời gian chạy cả ảnh, dựa trên phép đo một ô."""
    if variant == "balanced":
        variant = "general"
    if tile is None:
        tile = _default_tile_size()
    if tile_pad is None:
        tile_pad = _default_tile_pad(variant)
    per_tile = probe_tile_seconds(variant)
    if tile <= 0:
        tiles = 1
        side_px = max(width, height) ** 2
    else:
        tiles = ((width + tile - 1) // tile) * ((height + tile - 1) // tile)
        side_px = (min(tile, width) + 2 * tile_pad) * (min(tile, height) + 2 * tile_pad)
    scale = max(1.0, side_px / float(_PROBE_SIDE * _PROBE_SIDE))
    return tiles * per_tile * scale * _ESTIMATE_SAFETY


def _format_seconds(seconds: float) -> str:
    """Giây, không bao giờ hiện '0s' cho một giá trị dương."""
    if seconds >= 10:
        return f"{seconds:.0f}s"
    if seconds >= 1:
        return f"{seconds:.1f}s"
    return f"{seconds:.3g}s"


def _format_duration(seconds: float) -> str:
    """Thời lượng cho người đọc. UPSCALE (audit 2026-07-29 §NET.04): bản cũ luôn
    chia 60 rồi `.0f` nên mọi giá trị dưới 30 giây đều ra 'khoảng 0 phút'."""
    if seconds < 90:
        return _format_seconds(seconds)
    return f"{seconds / 60:.0f} phút"


def guard_runtime(width: int, height: int, variant: str,
                  tile: int | None = None, tile_pad: int | None = None) -> None:
    """Chặn TRƯỚC khi chạy nếu cấu hình sẽ mất hàng chục phút (§1.1, §1.2).

    UPSCALE (audit 2026-07-29 §NET.04): trước đây hàm này tên `_guard_runtime` và
    KHÔNG chỗ nào gọi — code chết, nên hai fix trên thực tế không có hiệu lực. Nay
    đổi thành API công khai và do route `/pdf-tools/upscale` gọi ở tầng policy,
    cạnh `_validate_upscale_memory`. Cố tình KHÔNG gọi trong `upscale()` để warmup
    và smoke test lúc build (ảnh 16×16) không bị chặn.

    Người vận hành vẫn ép được bằng PRYNX_UPSCALE_FORCE_CPU=1 (bỏ kiểm GPU) và
    PRYNX_UPSCALE_MAX_SECONDS (nới trần thời gian).
    """
    if variant == "quality" and not _force_cpu_by_env:
        budget = _env_float("PRYNX_UPSCALE_GPU_TILE_BUDGET_S", _GPU_TILE_BUDGET_S)
        measured = probe_tile_seconds(variant)
        if measured > budget:
            raise UpscaleUnavailable(
                f"Máy này không có tăng tốc GPU dùng được cho chế độ Chất lượng "
                f"(đo {measured:.1f}s cho một ô {_PROBE_SIDE}×{_PROBE_SIDE}, cần dưới "
                f"{_format_seconds(budget)}). Chạy bằng CPU sẽ mất hàng chục phút mỗi "
                f"ảnh — hãy chọn chế độ Nhanh."
            )

    limit = _env_float("PRYNX_UPSCALE_MAX_SECONDS", _MAX_JOB_SECONDS)
    predicted = estimate_seconds(width, height, variant, tile, tile_pad)
    if predicted > limit:
        raise UpscaleUnavailable(
            f"Ảnh {width}×{height} px ở chế độ này cần khoảng {_format_duration(predicted)} "
            f"(trần hiện tại {_format_duration(limit)}). Hãy chọn chế độ Nhanh, giảm kích "
            f"thước ảnh, hoặc nới trần bằng biến môi trường PRYNX_UPSCALE_MAX_SECONDS."
        )


def _build_providers(variant: str):
    if _force_cpu_by_env or variant in _cpu_only_variants:
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
            digest = hashlib.sha256()
            with open(path, "rb") as model_file:
                for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
                    digest.update(chunk)
            actual_hash = digest.hexdigest()
            if actual_hash != MODEL_SHA256[variant]:
                raise RuntimeError(
                    f"Model Real-ESRGAN '{os.path.basename(path)}' sai SHA-256 "
                    f"(nhận {actual_hash}, cần {MODEL_SHA256[variant]})."
                )
            logger.info(
                "Loading Real-ESRGAN[%s] session (force_cpu=%s)...",
                variant,
                _force_cpu_by_env or variant in _cpu_only_variants,
            )
            _sessions[variant] = ort.InferenceSession(path, providers=_build_providers(variant))
            logger.info("Real-ESRGAN[%s] ready (providers=%s)", variant, _sessions[variant].get_providers())
    return _sessions[variant]


def _switch_to_cpu(variant: str):
    """Dựng lại session CPU sau khi GPU lỗi (OOM/device-hung). Sticky để tránh treo lặp."""
    with _session_lock:
        _cpu_only_variants.add(variant)
        path = _resolve_model_path(variant)
        logger.warning("Rebuilding Real-ESRGAN[%s] on CPU only (GPU không ổn định).", variant)
        _sessions[variant] = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    return _sessions[variant]


def _serialize_directml_run(function):
    """Tuần tự hóa Run trên cùng DirectML session theo hợp đồng ONNX Runtime."""
    @functools.wraps(function)
    def wrapped(variant: str, *args, **kwargs):
        session = _get_session(variant)
        run_guard = (
            _session_run_locks[variant]
            if 'DmlExecutionProvider' in session.get_providers()
            else nullcontext()
        )
        with run_guard:
            return function(variant, *args, **kwargs)

    return wrapped


@_serialize_directml_run
def _run_session(variant: str, tile_nchw: np.ndarray) -> np.ndarray:
    """Chạy 1 ô qua model; nếu GPU lỗi thì rớt CPU rồi chạy lại (giống isnet/birefnet)."""
    session = _get_session(variant)
    input_name = session.get_inputs()[0].name
    # PERF (audit 2026-07-28 §UP-12): RRDBNet trên CPU có thể mất hàng phút cho
    # mỗi ô. Không âm thầm biến một job GPU thành job CPU kéo dài không kiểm soát.
    # Người vận hành vẫn có thể chủ động ép CPU bằng PRYNX_UPSCALE_FORCE_CPU=1.
    if (
        variant == "quality"
        and not _force_cpu_by_env
        and session.get_providers() == ["CPUExecutionProvider"]
    ):
        # UPSCALE (audit 2026-07-29 §NET.04): dùng UpscaleUnavailable để route trả
        # 422 kèm nguyên văn, thay vì 500 chung không nói được lý do.
        raise UpscaleUnavailable(
            "Chế độ Chất lượng cần GPU DirectML/CUDA tương thích. "
            "Hãy chọn chế độ Nhanh để xử lý bằng CPU."
        )
    try:
        out = session.run(None, {input_name: tile_nchw})[0]
    except Exception as e:
        if variant == "quality" and not _force_cpu_by_env:
            # Xóa session lỗi để lần sau có thể thử lại GPU sau khi giải phóng VRAM.
            with _session_lock:
                _sessions.pop(variant, None)
            raise UpscaleUnavailable(
                "GPU không xử lý được chế độ Chất lượng. "
                "Hãy đóng ứng dụng dùng GPU hoặc chọn chế độ Nhanh."
            ) from e
        if not (_force_cpu_by_env or variant in _cpu_only_variants):
            logger.warning("Real-ESRGAN[%s] GPU lỗi (%s) → rớt về CPU.", variant, e)
            session = _switch_to_cpu(variant)
            input_name = session.get_inputs()[0].name
            out = session.run(None, {input_name: tile_nchw})[0]
        else:
            raise
    return out


def _amplify_ai_detail(sr: np.ndarray, patch: np.ndarray, strength: float) -> np.ndarray:
    """Khuếch đại ĐÚNG phần chi tiết mà model đã suy ra, so với nền Lanczos.

    UPSCALE (audit 2026-07-29 §NET.03): bước cũ (`_restore_source_texture`) lấy tần
    số cao của ảnh NGUỒN đã Lanczos lên, với bán kính Gauss 1,2 px tính ở độ phân
    giải ĐẦU RA — ở ×4 tương đương 0,3 px nguồn, dưới Nyquist. Nó khuếch đại gợn
    resample chứ không phải chi tiết, đo được chỉ +0,5…2,7% độ nét và HF% không tăng.

    Cách này lấy `sr - lanczos(nguồn)` = phần model THÊM VÀO, rồi cộng thêm
    `strength` lần. Đo trên corpus audit (chế độ Chất lượng, strength=0,3): độ nét
    +58%, HF% 30,7 → 34,3, chỉ mất 0,44 dB PSNR và 0,003 SSIM.

    Chạy theo TỪNG Ô nên đỉnh RAM không tăng theo kích thước ảnh; `tile_pad` (40 px
    = ~160 px đầu ra) rộng hơn nhiều lần support của kernel Lanczos nên nền dựng
    trong vùng lõi không bị ảnh hưởng bởi mép ô.
    """
    ph, pw, _ = patch.shape
    patch_u8 = (np.clip(patch, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    baseline = np.asarray(
        Image.fromarray(patch_u8, "RGB").resize(
            (pw * SCALE, ph * SCALE), Image.Resampling.LANCZOS
        ),
        dtype=np.float32,
    ) / 255.0
    return np.clip(sr + strength * (sr - baseline), 0.0, 1.0)


def _upscale_rgb(
    rgb: np.ndarray,
    variant: str,
    tile: int,
    tile_pad: int,
    detail: float = 0.0,
    cancelled: Callable[[], bool] | None = None,
) -> np.ndarray:
    """Phóng to mảng RGB HxWx3 float32 [0,1] lên 4x bằng tiling.

    Chia ảnh thành ô `tile`×`tile` với biên đệm `tile_pad` (chồng mép để tránh vệt
    nối), chạy từng ô qua model, ghép lại theo toạ độ ×4. tile<=0 → chạy nguyên ảnh.
    `detail` > 0 thì khuếch đại chi tiết AI ngay trên từng ô (xem `_amplify_ai_detail`).
    """
    _raise_if_cancelled(cancelled)
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
            # LIFECYCLE (audit 2026-08-11 §UP.X.07): không cố ngắt giữa một
            # session.run DirectML; chỉ dừng trước/sau mỗi tile để giữ provider ổn định.
            _raise_if_cancelled(cancelled)
            # Vùng ô (chưa đệm) trong ảnh gốc.
            x0, y0 = tx * tile, ty * tile
            x1, y1 = min(x0 + tile, w), min(y0 + tile, h)
            # Vùng có biên đệm để lấy ngữ cảnh, tránh vệt nối.
            px0, py0 = max(x0 - tile_pad, 0), max(y0 - tile_pad, 0)
            px1, py1 = min(x1 + tile_pad, w), min(y1 + tile_pad, h)

            patch = rgb[py0:py1, px0:px1, :]
            inp = np.transpose(patch, (2, 0, 1))[None, ...].astype(np.float32)
            sr = _run_session(variant, inp)  # [1,3,ph*4,pw*4]
            _raise_if_cancelled(cancelled)
            sr = np.clip(np.squeeze(sr, 0).transpose(1, 2, 0), 0.0, 1.0)
            if detail > 0.0:
                sr = _amplify_ai_detail(sr, patch, detail)

            # Cắt bỏ phần đệm (đã ×4) để lấy đúng ô lõi, rồi dán vào output.
            crop_x0 = (x0 - px0) * SCALE
            crop_y0 = (y0 - py0) * SCALE
            crop_x1 = crop_x0 + (x1 - x0) * SCALE
            crop_y1 = crop_y0 + (y1 - y0) * SCALE
            output[y0 * SCALE:y1 * SCALE, x0 * SCALE:x1 * SCALE, :] = sr[crop_y0:crop_y1, crop_x0:crop_x1, :]

    return output


def _default_tile_size() -> int:
    """Chọn tile theo RAM; máy mạnh giữ nguyên 512, máy yếu mới giảm."""
    override = os.environ.get("PRYNX_UPSCALE_TILE", "").strip()
    if override:
        try:
            return max(64, int(override))
        except ValueError:
            logger.warning("Bỏ qua PRYNX_UPSCALE_TILE không hợp lệ: %s", override)
    from app.core.system_memory import read_memory_status_mb
    total_mb, _available_mb = read_memory_status_mb()
    if total_mb is not None and total_mb < 8 * 1024:
        return 256
    if total_mb is not None and total_mb < 16 * 1024:
        return 384
    return 512


def _detail_strength(mode: str) -> float:
    """Cường độ khuếch đại chi tiết AI theo chế độ UI (§NET.01/§NET.03).

    Số đo trên corpus audit 2026-07-29 (line-art + ảnh dày chi tiết) cho thang:
      - Nhanh: 0 — chế độ nhanh, không hậu xử lý, giữ nguyên hành vi cũ.
      - Cân bằng: nhẹ — thay bước unsharp vô tác dụng bằng chi tiết AI thật.
      - Chất lượng: mạnh nhất — RRDBNet tái tạo nhiều HF nhưng tương phản cục bộ
        thấp nên trước đây MỀM HƠN cả chế độ Nhanh (đo được −11…−14% độ nét).
    Nới/khoá bằng PRYNX_UPSCALE_DETAIL_<MODE> nếu cần thử nghiệm trên máy khách.
    Không dùng `_env_float` vì hàm đó coi 0 là "không hợp lệ", còn ở đây 0 là giá
    trị hợp lệ (tắt hẳn bước khuếch đại).
    """
    default = _DETAIL_BY_MODE.get(mode, 0.0)
    raw = os.environ.get(f"PRYNX_UPSCALE_DETAIL_{mode.upper()}", "").strip()
    if raw:
        try:
            default = float(raw)
        except ValueError:
            logger.warning("Bỏ qua PRYNX_UPSCALE_DETAIL_%s không hợp lệ: %s", mode.upper(), raw)
    return max(0.0, min(2.0, default))


def upscale(
    image: Image.Image,
    variant: str = "general",
    tile: int | None = None,
    tile_pad: int | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> Image.Image:
    """Phóng to ảnh 4x bằng Real-ESRGAN. Giữ alpha (nếu có) bằng resize chất lượng cao.

    Alpha KHÔNG chạy qua model SR (model huấn luyện cho RGB): alpha thường là mask
    tách nền, phóng to bằng LANCZOS đủ mượt và không sinh artefact màu.

    Chốt thời gian/GPU (`guard_runtime`) do TẦNG ROUTE gọi, không gọi ở đây: warmup
    và smoke test lúc build cố tình chạy ảnh 16×16 để nạp session và không được bị chặn.
    """
    _raise_if_cancelled(cancelled)
    # `mode` = lựa chọn UI (quyết định cường độ chi tiết), `variant` = model .onnx.
    # Cân bằng dùng chung model với Nhanh nhưng khác cường độ khuếch đại chi tiết.
    mode = variant if variant in _DETAIL_BY_MODE else "general"
    if variant == "balanced" or variant not in MODELS:
        variant = "general"
    detail = _detail_strength(mode)

    # PERF (audit 2026-07-28 §UP-06/07): tile chỉ giảm trên máy <16 GB, máy mạnh
    # giữ 512. Pad theo model (§NET.08) — RRDBNet cần rộng hơn model nhẹ.
    if tile is None:
        tile = _default_tile_size()
    if tile_pad is None:
        tile_pad = _default_tile_pad(variant)

    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    src = image.convert("RGBA") if has_alpha else image.convert("RGB")

    rgb = np.asarray(src.convert("RGB"), dtype=np.float32) / 255.0
    # UPSCALE (audit 2026-07-29 §NET.03): khuếch đại chi tiết chạy TRONG vòng lặp ô
    # để đỉnh RAM không tăng theo kích thước ảnh (bước cũ dựng thêm một ảnh full ×4).
    out_rgb = _upscale_rgb(rgb, variant, tile, tile_pad, detail, cancelled)
    _raise_if_cancelled(cancelled)
    out_u8 = (out_rgb * 255.0 + 0.5).astype(np.uint8)
    result = Image.fromarray(out_u8, "RGB")

    if has_alpha:
        _raise_if_cancelled(cancelled)
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
