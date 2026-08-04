"""Chuẩn hóa và vẽ đường viền cắt thủ công cho N-Up và Bình trang."""

from __future__ import annotations

import math
import re
from typing import Any, Mapping, Sequence

from app.workers import pdf_wrapper as pdf_lib


MM_TO_PTS = 2.83465
MIN_BORDER_THICKNESS_MM = 0.1
MAX_BORDER_THICKNESS_MM = 2.0
DEFAULT_BORDER_THICKNESS_MM = 0.3
DEFAULT_BORDER_COLOR = "#000000"
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _hex_to_cmyk(color_hex: str) -> tuple[float, float, float, float]:
    """Đổi HEX sang process CMYK; #000000 luôn là đen K100 thuần."""
    raw = color_hex[1:]
    red, green, blue = (int(raw[index:index + 2], 16) / 255.0 for index in (0, 2, 4))
    black = 1.0 - max(red, green, blue)
    if black >= 1.0 - 1e-9:
        return (0.0, 0.0, 0.0, 1.0)
    denominator = 1.0 - black
    return (
        (1.0 - red - black) / denominator,
        (1.0 - green - black) / denominator,
        (1.0 - blue - black) / denominator,
        black,
    )


def normalize_cut_border_settings(
    settings: Mapping[str, Any],
    *,
    strict: bool = False,
) -> dict[str, Any] | None:
    """Chuẩn hóa cấu hình public (mm/HEX) thành cấu hình renderer (pt/CMYK)."""
    raw_enabled = settings.get("cutBorderEnabled", False)
    if strict and type(raw_enabled) is not bool:
        raise ValueError("cutBorderEnabled phải là boolean.")
    if raw_enabled is not True:
        return None

    position = settings.get("cutBorderPosition", "trim")
    if position not in ("trim", "bleed"):
        if strict:
            raise ValueError("Vị trí đường viền cắt phải là 'trim' hoặc 'bleed'.")
        position = "trim"

    color_hex = str(settings.get("cutBorderColor", DEFAULT_BORDER_COLOR) or "")
    if not _HEX_COLOR_RE.fullmatch(color_hex):
        if strict:
            raise ValueError("Màu đường viền cắt phải có dạng #RRGGBB.")
        color_hex = DEFAULT_BORDER_COLOR
    color_hex = color_hex.upper()

    raw_thickness = settings.get("cutBorderThickness", DEFAULT_BORDER_THICKNESS_MM)
    if strict and type(raw_thickness) not in (int, float):
        raise ValueError("Độ dày đường viền cắt phải là một số hữu hạn.")
    try:
        thickness_mm = float(raw_thickness)
    except (TypeError, ValueError):
        if strict:
            raise ValueError("Độ dày đường viền cắt phải là một số hữu hạn.") from None
        thickness_mm = DEFAULT_BORDER_THICKNESS_MM
    if not math.isfinite(thickness_mm):
        if strict:
            raise ValueError("Độ dày đường viền cắt phải là một số hữu hạn.")
        thickness_mm = DEFAULT_BORDER_THICKNESS_MM
    if not MIN_BORDER_THICKNESS_MM <= thickness_mm <= MAX_BORDER_THICKNESS_MM:
        if strict:
            raise ValueError("Độ dày đường viền cắt phải nằm trong khoảng 0,1–2,0 mm.")
        thickness_mm = min(MAX_BORDER_THICKNESS_MM, max(MIN_BORDER_THICKNESS_MM, thickness_mm))

    return {
        "position": position,
        "color_hex": color_hex,
        "color_cmyk": _hex_to_cmyk(color_hex),
        "thickness_mm": thickness_mm,
        "thickness_pt": thickness_mm * MM_TO_PTS,
    }


def resolve_cut_border_config(
    settings: Mapping[str, Any],
    *,
    is_die_cut: bool,
    page_sheet_mode: bool,
) -> dict[str, Any] | None:
    """Đường viền chỉ thuộc các luồng Bình bài cắt xén hình chữ nhật."""
    if not cut_border_is_applicable(
        settings,
        is_die_cut=is_die_cut,
        page_sheet_mode=page_sheet_mode,
    ):
        return None
    return normalize_cut_border_settings(settings)


def cut_border_is_applicable(
    settings: Mapping[str, Any],
    *,
    is_die_cut: bool,
    page_sheet_mode: bool,
) -> bool:
    """Chặn state/payload cũ rò sang các workflow không phải bình cắt xén."""
    if is_die_cut or page_sheet_mode:
        return False
    imposer_mode = str(settings.get("imposerMode", "") or "").strip().lower()
    task_mode = str(settings.get("taskMode", "") or "").strip().lower()
    # CUT-BORDER (audit 2026-08-04 §CB.6): Bình trang (`step_repeat`/`repeat`)
    # vẫn là bình cắt xén hình chữ nhật, nên dùng cùng renderer đường viền với N-Up.
    return (
        imposer_mode not in {"cnc", "diecut"}
        and task_mode not in {
            "booklet",
            "sticker",
            "sticker_imposer",
            "cnc",
            "cnc_imposer",
        }
    )


def cut_border_rect(trim_rect: Any, bleed_pt: float, position: str):
    """Trả hình chữ nhật nét cắt trong cùng hệ tọa độ với placement thật."""
    offset = max(0.0, float(bleed_pt or 0.0)) if position == "bleed" else 0.0
    return pdf_lib.Rect(
        trim_rect.x0 - offset,
        trim_rect.y0 - offset,
        trim_rect.x1 + offset,
        trim_rect.y1 + offset,
    )


def draw_cut_borders(
    out_page: Any,
    trim_rects: Sequence[Any],
    config: Mapping[str, Any] | None,
    *,
    bleed_pt: float,
) -> int:
    """Vẽ mọi viền trong một shape vector sau artwork; trả số viền đã vẽ."""
    if not config or not trim_rects:
        return 0
    shape = out_page.new_shape()
    for trim_rect in trim_rects:
        shape.draw_rect(cut_border_rect(trim_rect, bleed_pt, str(config["position"])))
    shape.finish(
        color=tuple(config["color_cmyk"]),
        fill=None,
        width=float(config["thickness_pt"]),
        line_join=0,
    )
    shape.commit()
    return len(trim_rects)
