"""
imposition_layout.py — Lớp 2 (Solve/Nesting) dùng chung.

`compute_layout` là entry DÙNG CHUNG cho Tem Bế, N-up die-cut và CNC gang (R8.2):
nhận một `DetectedShape` (nguồn sự thật từ Lớp 1) + trang PDF (để lấy trim/NFP/
base_poly), rồi delegate sang solver hiện có `compute_sticker_layout_for_page`.

Bất biến (R2/R6): KHÔNG phân loại lại — `type`/`props` lấy NGUYÊN từ DetectedShape
và truyền xuống làm override; solver tin dùng (đã sửa RC-4 ở layout_compute).

Spec: .kiro/specs/die-shape-detection-ssot
Requirements: 2.2, 6.1, 6.2, 8.2, 12.1
"""

from __future__ import annotations

from typing import Any, Optional

from app.workers.imposition_rust_policy import require_rust


def _validate_layout_input(shape) -> None:
    """Validate DetectedShape trước khi tính (R2.7)."""
    if shape is None or getattr(shape, "type", None) is None:
        raise ValueError("compute_layout: thiếu DetectedShape.type (R2.7)")
    if not isinstance(getattr(shape, "props", None), dict):
        raise ValueError("compute_layout: DetectedShape.props phải là dict (R2.7)")


def compute_layout(
    shape,                       # DetectedShape (Lớp 1)
    page,                        # trang PDF (pdf_wrapper) để lấy trim/NFP/base_poly
    sheet_usable_w: float,
    sheet_usable_h: float,
    gap_x: float,
    gap_y: float,
    strategy: str = "optimal_auto",
    bleed_pt: float = 0.0,
    secondary_gap: Optional[float] = None,
) -> dict:
    """Tính bố cục nesting dùng chung, tin dùng DetectedShape (không re-classify).

    - require_rust() trước mọi phép tính (R12.1; idempotent).
    - `type`/`props` từ DetectedShape truyền làm override → solver HONOR (R6.2).
    - Đầu ra gắn lại type/props/poly == đầu vào (bất biến R6.3).
    """
    require_rust("compute_layout")
    _validate_layout_input(shape)

    # Import trong hàm để test có thể patch solver + tránh phụ thuộc vòng.
    from app.workers.nup_sticker import compute_sticker_layout_for_page

    result = compute_sticker_layout_for_page(
        page,
        sheet_usable_w,
        sheet_usable_h,
        gap_x,
        gap_y,
        strategy=strategy,
        shape_type_override=shape.type.name,
        shape_props_override=dict(shape.props) if shape.props else None,
        bleed_pt=bleed_pt,
        secondary_gap=secondary_gap,
    )

    # Bất biến: gắn lại type/props/poly y nguyên từ DetectedShape (R6.3).
    if isinstance(result, dict):
        result["type"] = shape.type
        result["props"] = shape.props
        result["poly"] = shape.poly
    return result
