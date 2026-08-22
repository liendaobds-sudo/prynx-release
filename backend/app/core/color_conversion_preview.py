"""Preview định lượng RGB → CMYK, không công bố artifact tạm.

COLOR (audit 2026-08-21 §COLOR.32): mọi ứng viên dùng đúng converter production,
soft-proof PPE và plate PPE. Khi một trong hai bằng chứng PPE không đủ tin, ảnh
vẫn hữu ích để xem gần đúng nhưng preset tự động bị khóa.
"""
from __future__ import annotations

import asyncio
import base64
import io
import re
import tempfile
import threading
import zlib
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

import numpy as np
from PIL import Image, ImageCms

from app.core.system_memory import read_memory_status_mb


PROCESS_PLATE_NAMES = ("Cyan", "Magenta", "Yellow", "Black")
BALANCED_POLICY = "balanced-v1"

# Các gate là chênh lệch tối đa so với bản Relative/BPC identity cùng trang.
# Ngưỡng highlight 1,5 điểm phần trăm cho phép mức +1 thận trọng trên rgb.pdf,
# nhưng chặn +2 vốn tạo thêm vùng trắng/clip có thể nhìn thấy.
MAX_MEAN_DE00_INCREASE = 1.0
MAX_P95_DE00_INCREASE = 0.5
MAX_CHROMA_ERROR_INCREASE = 0.25
MAX_CHROMA_OVERSHOOT = 0.5
MAX_HIGHLIGHT_CLIP_INCREASE_PCT = 1.5
MAX_PAPER_WHITE_INCREASE_PCT = 0.1
MAX_SHADOW_CLIP_INCREASE_PCT = 0.1
MAX_TAC_INCREASE_PCT = 1.0
MAX_NEUTRAL_DE00_INCREASE = 0.5
MAX_SKIN_DE00_INCREASE = 0.75
MAX_LIGHTNESS_OVERSHOOT = 0.5


class ColorConversionPreviewError(RuntimeError):
    """Lỗi nghiệp vụ preview có mã HTTP công khai, không kèm path nội bộ."""

    def __init__(self, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class _Candidate:
    adjustments: dict[str, Any]
    pdf_path: Path
    proof: dict[str, Any]
    metrics: dict[str, Any]
    trusted: bool


def effective_preview_dpi(
    requested_dpi: int,
    memory_reader: Callable[[], tuple[float | None, float | None]] = read_memory_status_mb,
) -> int:
    """Chỉ hạ DPI trên máy yếu; máy từ 16 GB giữ nguyên yêu cầu."""

    total_mb, _available_mb = memory_reader()
    if total_mb is not None and 0 < total_mb < 8 * 1024:
        return min(int(requested_dpi), 72)
    if total_mb is not None and total_mb < 16 * 1024:
        return min(int(requested_dpi), 100)
    return int(requested_dpi)


async def _await_cleanup_safe(
    awaitable: Awaitable[Any],
    *,
    cancel_event: threading.Event | None = None,
) -> Any:
    """Chờ worker thật dừng trước khi TemporaryDirectory bị xóa khi cancel."""

    task = asyncio.create_task(awaitable)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        if cancel_event is not None:
            cancel_event.set()
        with suppress(Exception):
            await asyncio.shield(task)
        raise


async def _run_blocking(
    func: Callable[..., Any],
    *args: Any,
    cancel_event: threading.Event | None = None,
    **kwargs: Any,
) -> Any:
    return await _await_cleanup_safe(
        asyncio.to_thread(func, *args, **kwargs),
        cancel_event=cancel_event,
    )


def _public_detail(items: Any, fallback: str) -> str:
    if not isinstance(items, list):
        return fallback
    clean: list[str] = []
    for item in items:
        if not isinstance(item, str) or not item.strip():
            continue
        value = re.sub(
            r"(?i)(?:[a-z]:[\\/]|\\\\)[^;\r\n]*",
            "[đường dẫn đã ẩn]",
            item.strip().replace("\r", " ").replace("\n", " "),
        )
        clean.append(value[:240])
        if len(clean) == 3:
            break
    return "; ".join(clean) or fallback


def _encode_png(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _decode_preview_image(payload: str) -> Image.Image:
    try:
        with Image.open(io.BytesIO(base64.b64decode(payload))) as image:
            return image.convert("RGB")
    except Exception as exc:
        raise ColorConversionPreviewError(
            "Không giải mã được ảnh soft-proof của trang."
        ) from exc


def _rgb_to_lab_d50(image: Image.Image) -> np.ndarray:
    """Đổi sRGB sang Lab D50 với representation signed giống acceptance test."""

    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    lab_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("LAB"))
    transform = ImageCms.buildTransform(
        srgb,
        lab_profile,
        "RGB",
        "LAB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    converted = ImageCms.applyTransform(image.convert("RGB"), transform)
    raw = np.asarray(converted, dtype=np.uint8).astype(np.float64)
    ab = np.where(raw[..., 1:] > 127.0, raw[..., 1:] - 256.0, raw[..., 1:])
    return np.concatenate(
        (raw[..., :1] * (100.0 / 255.0), ab),
        axis=-1,
    )


def delta_e_ciede2000(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 NumPy thuần để release Nuitka không phụ thuộc scikit-image."""

    first = np.asarray(lab1, dtype=np.float64)
    second = np.asarray(lab2, dtype=np.float64)
    l1, a1, b1 = np.moveaxis(first, -1, 0)
    l2, a2, b2 = np.moveaxis(second, -1, 0)

    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    c_bar = (c1 + c2) / 2.0
    c_bar7 = np.power(c_bar, 7)
    g = 0.5 * (1.0 - np.sqrt(c_bar7 / (c_bar7 + 25.0**7)))

    a1p = (1.0 + g) * a1
    a2p = (1.0 + g) * a2
    c1p = np.hypot(a1p, b1)
    c2p = np.hypot(a2p, b2)
    h1p = np.mod(np.degrees(np.arctan2(b1, a1p)), 360.0)
    h2p = np.mod(np.degrees(np.arctan2(b2, a2p)), 360.0)

    delta_lp = l2 - l1
    delta_cp = c2p - c1p
    hue_delta = h2p - h1p
    zero_chroma = (c1p * c2p) == 0
    hue_delta = np.where(zero_chroma, 0.0, hue_delta)
    hue_delta = np.where(hue_delta > 180.0, hue_delta - 360.0, hue_delta)
    hue_delta = np.where(hue_delta < -180.0, hue_delta + 360.0, hue_delta)
    delta_hp = 2.0 * np.sqrt(c1p * c2p) * np.sin(np.radians(hue_delta / 2.0))

    l_bar = (l1 + l2) / 2.0
    cp_bar = (c1p + c2p) / 2.0
    hue_sum = h1p + h2p
    hue_diff = np.abs(h1p - h2p)
    hp_bar = np.where(zero_chroma, hue_sum, hue_sum / 2.0)
    hp_bar = np.where(
        (~zero_chroma) & (hue_diff > 180.0) & (hue_sum < 360.0),
        (hue_sum + 360.0) / 2.0,
        hp_bar,
    )
    hp_bar = np.where(
        (~zero_chroma) & (hue_diff > 180.0) & (hue_sum >= 360.0),
        (hue_sum - 360.0) / 2.0,
        hp_bar,
    )

    t = (
        1.0
        - 0.17 * np.cos(np.radians(hp_bar - 30.0))
        + 0.24 * np.cos(np.radians(2.0 * hp_bar))
        + 0.32 * np.cos(np.radians(3.0 * hp_bar + 6.0))
        - 0.20 * np.cos(np.radians(4.0 * hp_bar - 63.0))
    )
    delta_theta = 30.0 * np.exp(-np.square((hp_bar - 275.0) / 25.0))
    rc = 2.0 * np.sqrt(np.power(cp_bar, 7) / (np.power(cp_bar, 7) + 25.0**7))
    sl = 1.0 + (0.015 * np.square(l_bar - 50.0)) / np.sqrt(
        20.0 + np.square(l_bar - 50.0)
    )
    sc = 1.0 + 0.045 * cp_bar
    sh = 1.0 + 0.015 * cp_bar * t
    rt = -np.sin(np.radians(2.0 * delta_theta)) * rc

    lp_term = delta_lp / sl
    cp_term = delta_cp / sc
    hp_term = delta_hp / sh
    return np.sqrt(
        np.maximum(
            0.0,
            np.square(lp_term)
            + np.square(cp_term)
            + np.square(hp_term)
            + rt * cp_term * hp_term,
        )
    )


def _optional_mean(values: np.ndarray, mask: np.ndarray) -> float | None:
    if not np.any(mask):
        return None
    return round(float(np.mean(values[mask])), 4)


def measure_appearance(source: Image.Image, output: Image.Image) -> dict[str, Any]:
    """Đo đúng pixel nội dung; lề trắng không được làm đẹp trung bình."""

    source_rgb = source.convert("RGB")
    output_rgb = output.convert("RGB")
    if source_rgb.size != output_rgb.size:
        source_width, source_height = source_rgb.size
        output_width, output_height = output_rgb.size
        source_ratio = source_width / max(1, source_height)
        output_ratio = output_width / max(1, output_height)
        ratio_error = abs(source_ratio - output_ratio) / max(
            source_ratio,
            output_ratio,
        )
        if ratio_error > 0.005:
            raise ColorConversionPreviewError(
                "Ảnh nguồn và soft-proof khác tỷ lệ; không thể đo tin cậy."
            )
        # COLOR (audit 2026-08-21 §COLOR.32): PDFium/PPE có thể làm tròn cạnh
        # trang khác một pixel (rgb.pdf: 388×221 và 388×220 ở 150 DPI). Resize
        # toàn khung giữ hai raster cùng hệ tọa độ; crop một hàng sẽ làm lệch dần
        # artwork theo trục Y và báo clip trắng giả ở cạnh đối tượng.
        source_rgb = source_rgb.resize(
            output_rgb.size,
            Image.Resampling.LANCZOS,
        )

    source_lab = _rgb_to_lab_d50(source_rgb)
    output_lab = _rgb_to_lab_d50(output_rgb)
    source_l = source_lab[..., 0]
    output_l = output_lab[..., 0]
    source_chroma = np.hypot(source_lab[..., 1], source_lab[..., 2])
    output_chroma = np.hypot(output_lab[..., 1], output_lab[..., 2])
    content = (source_l < 99.0) | (output_l < 99.0)
    if not np.any(content):
        content = np.ones(source_l.shape, dtype=bool)

    delta_e = delta_e_ciede2000(source_lab, output_lab)
    sample_pixels = int(np.count_nonzero(content))
    denominator = float(sample_pixels)
    source_bytes = np.asarray(source_rgb, dtype=np.uint8)
    output_bytes = np.asarray(output_rgb, dtype=np.uint8)

    new_highlight = content & (source_l < 99.0) & (output_l >= 99.0)
    new_shadow = content & (source_l > 1.0) & (output_l <= 1.0)
    source_paper = np.all(source_bytes >= 254, axis=-1)
    output_paper = np.all(output_bytes >= 254, axis=-1)
    new_paper = content & ~source_paper & output_paper

    neutral = content & (source_chroma < 5.0)
    skin = (
        content
        & (source_l >= 25.0)
        & (source_l <= 90.0)
        & (source_lab[..., 1] >= 5.0)
        & (source_lab[..., 1] <= 35.0)
        & (source_lab[..., 2] >= 5.0)
        & (source_lab[..., 2] <= 40.0)
    )
    selected_delta_e = delta_e[content]
    return {
        "sample_pixels": sample_pixels,
        "delta_lstar_mean": round(float(np.mean((output_l - source_l)[content])), 4),
        "delta_chroma_mean": round(
            float(np.mean((output_chroma - source_chroma)[content])), 4
        ),
        "delta_e00_mean": round(float(np.mean(selected_delta_e)), 4),
        "delta_e00_p95": round(float(np.percentile(selected_delta_e, 95)), 4),
        "new_highlight_clip_pct": round(
            float(np.count_nonzero(new_highlight) / denominator * 100.0), 4
        ),
        "new_paper_white_pct": round(
            float(np.count_nonzero(new_paper) / denominator * 100.0), 4
        ),
        "new_shadow_clip_pct": round(
            float(np.count_nonzero(new_shadow) / denominator * 100.0), 4
        ),
        "neutral_delta_e00_mean": _optional_mean(delta_e, neutral),
        "skin_delta_e00_mean": _optional_mean(delta_e, skin),
    }


def measure_tac(separations: dict[str, Any]) -> dict[str, Any]:
    """Chỉ cộng C/M/Y/K thật; Spot báo riêng và không làm đổi gate process TAC."""

    engine = str(separations.get("engine") or "unknown")
    plates = separations.get("plates")
    width = int(separations.get("width") or 0)
    height = int(separations.get("height") or 0)
    if not isinstance(plates, list):
        plates = []
    spot_count = sum(1 for plate in plates if bool(plate.get("is_spot")))

    process: dict[str, np.ndarray] = {}
    try:
        for plate in plates:
            if bool(plate.get("is_spot")):
                continue
            name = str(plate.get("name") or "")
            if name not in PROCESS_PLATE_NAMES or name in process:
                continue
            compressed = base64.b64decode(
                str(plate["alpha_data"]),
                validate=True,
            )
            inflater = zlib.decompressobj()
            raw = inflater.decompress(compressed, width * height + 1)
            if (
                len(raw) != width * height
                or not inflater.eof
                or inflater.unconsumed_tail
                or inflater.unused_data
            ):
                raise ValueError("plate grid mismatch")
            process[name] = np.frombuffer(raw, dtype=np.uint8).reshape(height, width)
    except Exception:
        process = {}

    available = (
        engine == "ppe"
        and width > 0
        and height > 0
        and set(process) == set(PROCESS_PLATE_NAMES)
    )
    if not available:
        return {
            "available": False,
            "mean_pct": None,
            "p95_pct": None,
            "max_pct": None,
            "engine": engine,
            "spot_excluded": True,
            "spot_plate_count": spot_count,
        }

    tac = np.zeros((height, width), dtype=np.float32)
    for name in PROCESS_PLATE_NAMES:
        tac += process[name].astype(np.float32)
    tac *= 100.0 / 255.0
    return {
        "available": True,
        "mean_pct": round(float(np.mean(tac)), 4),
        "p95_pct": round(float(np.percentile(tac, 95)), 4),
        "max_pct": round(float(np.max(tac)), 4),
        "engine": engine,
        "spot_excluded": True,
        "spot_plate_count": spot_count,
    }


def candidate_gate_reasons(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
) -> list[str]:
    """Trả mã gate không đạt; danh sách rỗng nghĩa là candidate an toàn hơn."""

    reasons: list[str] = []
    bm = baseline["metrics"]
    cm = candidate["metrics"]
    if not baseline.get("trusted") or not candidate.get("trusted"):
        return ["PROOF_OR_TAC_UNTRUSTED"]
    if cm["delta_e00_mean"] > bm["delta_e00_mean"] + MAX_MEAN_DE00_INCREASE:
        reasons.append("DELTA_E00_MEAN")
    if cm["delta_e00_p95"] > bm["delta_e00_p95"] + MAX_P95_DE00_INCREASE:
        reasons.append("DELTA_E00_P95")
    if abs(cm["delta_chroma_mean"]) > (
        abs(bm["delta_chroma_mean"]) + MAX_CHROMA_ERROR_INCREASE
    ):
        reasons.append("CHROMA_REGRESSION")
    if cm["delta_chroma_mean"] > MAX_CHROMA_OVERSHOOT:
        reasons.append("CHROMA_OVERSHOOT")
    if cm["new_highlight_clip_pct"] > (
        bm["new_highlight_clip_pct"] + MAX_HIGHLIGHT_CLIP_INCREASE_PCT
    ):
        reasons.append("HIGHLIGHT_CLIP")
    if cm["new_paper_white_pct"] > (
        bm["new_paper_white_pct"] + MAX_PAPER_WHITE_INCREASE_PCT
    ):
        reasons.append("PAPER_WHITE")
    if cm["new_shadow_clip_pct"] > (
        bm["new_shadow_clip_pct"] + MAX_SHADOW_CLIP_INCREASE_PCT
    ):
        reasons.append("SHADOW_CLIP")
    if cm["delta_lstar_mean"] > MAX_LIGHTNESS_OVERSHOOT:
        reasons.append("LIGHTNESS_OVERSHOOT")

    baseline_tac = bm["tac"]
    candidate_tac = cm["tac"]
    if not baseline_tac.get("available") or not candidate_tac.get("available"):
        reasons.append("TAC_UNAVAILABLE")
    else:
        for field in ("p95_pct", "max_pct"):
            if float(candidate_tac[field]) > (
                float(baseline_tac[field]) + MAX_TAC_INCREASE_PCT
            ):
                reasons.append("TAC_INCREASE")
                break

    for field, limit, code in (
        ("neutral_delta_e00_mean", MAX_NEUTRAL_DE00_INCREASE, "NEUTRAL_DRIFT"),
        ("skin_delta_e00_mean", MAX_SKIN_DE00_INCREASE, "SKIN_DRIFT"),
    ):
        before = bm.get(field)
        after = cm.get(field)
        if before is not None and after is not None and after > before + limit:
            reasons.append(code)
    return list(dict.fromkeys(reasons))


def choose_balanced_candidate(
    baseline: dict[str, Any],
    brightness_candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    """Chọn mức sáng giảm |ΔL*|, không chọn chỉ vì số L* lớn hơn."""

    best = baseline
    rejected: list[str] = []
    for candidate in brightness_candidates:
        reasons = candidate_gate_reasons(baseline, candidate)
        if reasons:
            rejected.extend(reasons)
            continue
        if abs(candidate["metrics"]["delta_lstar_mean"]) + 1e-6 < abs(
            best["metrics"]["delta_lstar_mean"]
        ):
            best = candidate
    return best, list(dict.fromkeys(rejected))


async def _convert_candidate(
    source_path: str,
    temp_dir: Path,
    *,
    key: str,
    cmyk_profile_path: str,
    rgb_profile_path: str,
    rendering_intent: str,
    preserve_black: bool,
    black_point_compensation: bool,
    gamut_mapping: str,
    adjustment_stage: str,
    brightness_lstar: int,
    contrast_percent: int,
    vibrance_percent: int,
    include_spot: bool,
) -> Path:
    from app.core import pdf_actions_native

    cancel_event = threading.Event()
    rgb_output = temp_dir / f"{key}.pdf"

    def convert() -> Path:
        result = pdf_actions_native.convert_to_cmyk(
            source_path,
            str(rgb_output),
            cmyk_profile_path,
            rgb_profile_path,
            cancel_check=cancel_event.is_set,
            rendering_intent=rendering_intent,
            preserve_black=preserve_black,
            black_point_compensation=black_point_compensation,
            gamut_mapping=gamut_mapping,
            adjustment_stage=adjustment_stage,
            brightness_lstar=brightness_lstar,
            contrast_percent=contrast_percent,
            vibrance_percent=vibrance_percent,
        )
        if not isinstance(result, dict) or not result.get("supported"):
            raise ColorConversionPreviewError(
                _public_detail(
                    (result or {}).get("blockers") if isinstance(result, dict) else None,
                    "Engine chưa chuyển được PDF này một cách chắc chắn.",
                )
            )
        final_output = rgb_output
        if include_spot:
            if cancel_event.is_set():
                raise asyncio.CancelledError
            spot_output = temp_dir / f"{key}_spot.pdf"
            spot = pdf_actions_native.convert_spot_to_cmyk(
                str(rgb_output),
                str(spot_output),
                None,
                cmyk_profile_path,
            )
            if not isinstance(spot, dict) or not spot.get("supported"):
                raise ColorConversionPreviewError(
                    _public_detail(
                        (spot or {}).get("blockers") if isinstance(spot, dict) else None,
                        "Preview chưa chuyển được màu pha một cách chắc chắn.",
                    )
                )
            final_output = spot_output
        if not final_output.is_file():
            raise ColorConversionPreviewError(
                "Engine không tạo được PDF tạm để phân tích."
            )
        return final_output

    return await _run_blocking(convert, cancel_event=cancel_event)


async def _analyze_candidate(
    candidate_path: Path,
    source_image: Image.Image,
    *,
    page: int,
    dpi: int,
    profile_id: str,
    rendering_intent: str,
    source_gamut_b64: str | None,
    source_out_of_gamut_pct: float,
    adjustments: dict[str, Any],
) -> _Candidate:
    from app.core.separations import SeparationEngine
    from app.core.softproof import SoftProofEngine

    proof_engine = SoftProofEngine()
    proof = await _await_cleanup_safe(
        proof_engine.render_softproof(
            str(candidate_path),
            page,
            profile_id=profile_id,
            intent=rendering_intent,
            show_gamut_warning=False,
            dpi=dpi,
            output_format="png",
            accurate_only=False,
            simulate_overprint=True,
        )
    )
    if not isinstance(proof, dict) or not proof.get("success"):
        raise ColorConversionPreviewError("Không dựng được soft-proof cho PDF tạm.")
    proof["gamut_b64"] = source_gamut_b64
    output_image = await _run_blocking(
        _decode_preview_image,
        str(proof.get("softproof_b64") or ""),
    )
    appearance = await _run_blocking(measure_appearance, source_image, output_image)

    separation_engine = SeparationEngine()
    separations = await _await_cleanup_safe(
        separation_engine.extract_separations(
            str(candidate_path),
            page,
            dpi=dpi,
            cmyk_profile_id=profile_id,
            rendering_intent=rendering_intent,
            render_mode="accurate",
            ink_accurate=True,
            use_ppe=True,
        )
    )
    tac = await _run_blocking(measure_tac, separations)
    appearance["tac"] = tac
    appearance["out_of_gamut_pct"] = round(
        float(source_out_of_gamut_pct), 4
    )
    trusted = (
        proof.get("accuracy") == "rip_softproof"
        and not bool(proof.get("degraded"))
        and not bool(proof.get("ink_unsound"))
        and not bool(proof.get("ppe_degraded"))
        and not bool(proof.get("ppe_ink_unsound"))
        and tac["available"]
    )
    return _Candidate(
        adjustments=adjustments,
        pdf_path=candidate_path,
        proof=proof,
        metrics=appearance,
        trusted=trusted,
    )


def _candidate_view(candidate: _Candidate) -> dict[str, Any]:
    return {
        "adjustments": candidate.adjustments,
        "metrics": candidate.metrics,
        "trusted": candidate.trusted,
    }


async def create_color_conversion_preview(
    source_path: str,
    *,
    page: int,
    conversions: list[str],
    icc_profile: str,
    rendering_intent: str,
    preserve_black: bool,
    black_point_compensation: bool,
    gamut_mapping: str,
    adjustment_stage: str,
    brightness_lstar: int,
    contrast_percent: int,
    vibrance_percent: int,
    preview_policy: str,
    dpi: int,
    request_id: str,
) -> dict[str, Any]:
    """Dựng preview trang đang xem; mọi PDF/PNG trung gian bị xóa trước return."""

    from app.core import icc_profiles
    from app.core.softproof import SoftProofEngine

    path = Path(source_path)
    if not path.is_file():
        raise ColorConversionPreviewError("File PDF không còn tồn tại.", status_code=404)

    cmyk_profile_path = icc_profiles.resolve_cmyk_profile_path(icc_profile)
    if not cmyk_profile_path:
        status = 503 if icc_profile == "auto" else 422
        raise ColorConversionPreviewError(
            "Không tìm thấy hồ sơ CMYK đã chọn trên máy.",
            status_code=status,
        )
    rgb_profile_path = icc_profiles.resolve_srgb_profile_path()
    if not rgb_profile_path:
        raise ColorConversionPreviewError(
            "Không tìm thấy hồ sơ sRGB nguồn trên máy.",
            status_code=503,
        )

    effective_dpi = effective_preview_dpi(dpi)
    proof_profile_id = "fogra39" if icc_profile in ("", "auto") else icc_profile
    include_spot = "spot_to_cmyk" in conversions
    warnings = [
        (
            f"Số đo chỉ áp dụng cho trang {page}; hãy kiểm thêm các trang đại diện "
            "trước khi chuyển toàn bộ tài liệu."
        )
    ]
    if effective_dpi != dpi:
        warnings.append(
            f"Máy ít RAM: preview giảm từ {dpi} xuống {effective_dpi} DPI."
        )

    with tempfile.TemporaryDirectory(prefix="prynx-color-preview-") as temp_name:
        temp_dir = Path(temp_name)
        source_renderer = SoftProofEngine()
        try:
            source_image = await _run_blocking(
                source_renderer._render_pdfium_rgb,
                str(path),
                page,
                effective_dpi,
            )
        except Exception as exc:
            if isinstance(exc, ColorConversionPreviewError):
                raise
            raise ColorConversionPreviewError(
                f"Không dựng được trang {page}; hãy kiểm tra số trang."
            ) from exc
        try:
            source_gamut_b64, source_out_of_gamut_pct = await _run_blocking(
                source_renderer.render_gamut_warning,
                source_image,
                profile_id=proof_profile_id,
                intent=rendering_intent,
            )
        except Exception as exc:
            raise ColorConversionPreviewError(
                "Không đo được gamut của ảnh RGB nguồn theo hồ sơ CMYK đã chọn."
            ) from exc

        async def build(
            brightness: int,
            contrast: int,
            vibrance: int,
        ) -> _Candidate:
            adjustments = {
                "brightness_lstar": int(brightness),
                "contrast_percent": int(contrast),
                "vibrance_percent": int(vibrance),
                "adjustment_stage": adjustment_stage,
            }
            key = (
                f"b{brightness:+d}_c{contrast:+d}_v{vibrance:+d}"
                .replace("+", "p")
                .replace("-", "m")
            )
            candidate_path = await _convert_candidate(
                str(path),
                temp_dir,
                key=key,
                cmyk_profile_path=str(cmyk_profile_path),
                rgb_profile_path=str(rgb_profile_path),
                rendering_intent=rendering_intent,
                preserve_black=preserve_black,
                black_point_compensation=black_point_compensation,
                gamut_mapping=gamut_mapping,
                adjustment_stage=adjustment_stage,
                brightness_lstar=brightness,
                contrast_percent=contrast,
                vibrance_percent=vibrance,
                include_spot=include_spot,
            )
            return await _analyze_candidate(
                candidate_path,
                source_image,
                page=page,
                dpi=effective_dpi,
                profile_id=proof_profile_id,
                rendering_intent=rendering_intent,
                source_gamut_b64=source_gamut_b64,
                source_out_of_gamut_pct=source_out_of_gamut_pct,
                adjustments=adjustments,
            )

        if preview_policy == "manual":
            selected = await build(
                brightness_lstar,
                contrast_percent,
                vibrance_percent,
            )
            recommendation = {
                "policy": "manual",
                "status": "manual",
                "gates_passed": False,
                "reason_codes": ["MANUAL_SETTINGS_NOT_RANKED"],
            }
        else:
            baseline = await build(0, 0, 0)
            if not baseline.trusted:
                selected = baseline
                recommendation = {
                    "policy": BALANCED_POLICY,
                    "status": "unavailable",
                    "gates_passed": False,
                    "reason_codes": ["PROOF_OR_TAC_UNTRUSTED"],
                }
            else:
                brightness_candidates: list[_Candidate] = []
                rejected: list[str] = []
                for candidate_brightness in (1, 2):
                    try:
                        brightness_candidates.append(
                            await build(candidate_brightness, 0, 0)
                        )
                    except ColorConversionPreviewError as exc:
                        warnings.append(
                            f"Không phân tích được mức +{candidate_brightness} L*: {exc}"
                        )
                        rejected.append(f"BRIGHTNESS_{candidate_brightness}_UNAVAILABLE")
                selected_view, gate_rejections = choose_balanced_candidate(
                    _candidate_view(baseline),
                    [_candidate_view(item) for item in brightness_candidates],
                )
                rejected.extend(gate_rejections)
                selected = baseline
                for item in brightness_candidates:
                    if item.adjustments == selected_view["adjustments"]:
                        selected = item
                        break

                try:
                    vivid = await build(
                        int(selected.adjustments["brightness_lstar"]),
                        0,
                        4,
                    )
                    vivid_reasons = candidate_gate_reasons(
                        _candidate_view(baseline),
                        _candidate_view(vivid),
                    )
                    if vivid_reasons:
                        rejected.extend(vivid_reasons)
                    elif abs(vivid.metrics["delta_chroma_mean"]) + 0.02 < abs(
                        selected.metrics["delta_chroma_mean"]
                    ):
                        selected = vivid
                except ColorConversionPreviewError as exc:
                    warnings.append(f"Không phân tích được mức rực nhẹ: {exc}")
                    rejected.append("VIBRANCE_4_UNAVAILABLE")

                changed = any(
                    int(selected.adjustments[key]) != 0
                    for key in (
                        "brightness_lstar",
                        "contrast_percent",
                        "vibrance_percent",
                    )
                )
                recommendation = {
                    "policy": BALANCED_POLICY,
                    "status": "recommended" if changed else "identity",
                    "gates_passed": True,
                    "reason_codes": [] if changed else list(dict.fromkeys(rejected)),
                }

        if not selected.trusted:
            warnings.append(
                "PPE hoặc số TAC chưa đủ tin cậy; không tự áp gợi ý cân bằng."
            )
        proof = selected.proof
        output_b64 = str(proof.get("softproof_b64") or "")
        if not output_b64:
            raise ColorConversionPreviewError("Soft-proof không có dữ liệu ảnh.")
        output_width = int(proof.get("width") or source_image.width)
        output_height = int(proof.get("height") or source_image.height)
        source_preview = source_image
        if source_preview.size != (output_width, output_height):
            source_preview = source_preview.resize(
                (output_width, output_height),
                Image.Resampling.LANCZOS,
            )
        source_b64 = await _run_blocking(_encode_png, source_preview)

        return {
            "success": True,
            "request_id": request_id,
            "page": page,
            "requested_dpi": dpi,
            "effective_dpi": effective_dpi,
            "effective_options": {"gamut_mapping": gamut_mapping},
            "effective_adjustments": selected.adjustments,
            "preview": {
                "source_b64": source_b64,
                "output_b64": output_b64,
                "gamut_b64": proof.get("gamut_b64"),
                "mime": str(proof.get("image_mime") or "image/png"),
                "width": output_width,
                "height": output_height,
                "proof_accuracy": str(proof.get("accuracy") or "unknown"),
                "proof_engine": str(proof.get("engine") or "unknown"),
                "measurement_basis": (
                    "display_rgb_vs_rip_softproof"
                    if selected.trusted
                    else "display_rgb_vs_approximate_softproof"
                ),
            },
            "metrics": selected.metrics,
            "recommendation": recommendation,
            "warnings": list(dict.fromkeys(warnings)),
        }
