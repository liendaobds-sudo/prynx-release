"""Geometry policy for whole-sheet decal imposition.

The user-entered bleed is the only bleed input. Page boxes and artwork are never
inspected to infer or correct it.
"""

from __future__ import annotations

import math
from typing import NamedTuple


class PageSheetGeometry(NamedTuple):
    source_width: float
    source_height: float
    trim_width: float
    trim_height: float
    bleed: float


def resolve_page_sheet_geometry(
    source_width_pt: float,
    source_height_pt: float,
    user_bleed_pt: float,
) -> PageSheetGeometry:
    """Return MediaBox/page.rect geometry with bleed inset exactly once."""
    try:
        source_width = float(source_width_pt)
        source_height = float(source_height_pt)
        bleed = float(user_bleed_pt)
    except (TypeError, ValueError) as exc:
        raise ValueError("Kích thước trang hoặc bleed không hợp lệ.") from exc

    if not all(math.isfinite(value) for value in (source_width, source_height, bleed)):
        raise ValueError("Kích thước trang và bleed phải là số hữu hạn.")
    if source_width <= 0 or source_height <= 0:
        raise ValueError("Kích thước trang nguồn phải lớn hơn 0.")
    if bleed < 0:
        raise ValueError("Bleed không được âm.")

    trim_width = source_width - 2.0 * bleed
    trim_height = source_height - 2.0 * bleed
    if trim_width <= 0 or trim_height <= 0:
        raise ValueError(
            "Bleed không hợp lệ: hai lần bleed phải nhỏ hơn chiều rộng và chiều cao trang."
        )

    return PageSheetGeometry(
        source_width=source_width,
        source_height=source_height,
        trim_width=trim_width,
        trim_height=trim_height,
        bleed=bleed,
    )
