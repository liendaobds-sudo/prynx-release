"""
imposition_parity.py — Parity guard cho preview == output (R7).

Cung cấp `assert_parity` để so sánh bố cục giữa đường dẫn preview và đường dẫn
output theo dung sai cấu hình. Được dùng làm "lưới an toàn" cho các phase sau:
mọi thay đổi layout phải giữ preview khớp output.

Spec: .kiro/specs/die-shape-detection-ssot
Requirements: 7.1, 7.3, 7.4, 7.5
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Sequence

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465

# Dung sai mặc định (R7.3): vị trí/kích thước 0.1mm, góc 0.01 độ.
DEFAULT_POS_TOL_MM = 0.1
DEFAULT_ROT_TOL_DEG = 0.01

# Khoảng hợp lệ cho cấu hình dung sai (ngoài khoảng → dùng mặc định + cảnh báo, R7.5).
_POS_TOL_RANGE_MM = (0.0, 5.0)
_ROT_TOL_RANGE_DEG = (0.0, 5.0)


class ParityError(AssertionError):
    """Sai lệch parity vượt dung sai (R7.4)."""


@dataclass(frozen=True)
class ParityTolerance:
    pos_tol_pt: float
    rot_tol_deg: float


def resolve_tolerance(
    pos_tol_mm: float | None = None,
    rot_tol_deg: float | None = None,
) -> ParityTolerance:
    """Chuẩn hoá cấu hình dung sai; thiếu/ngoài khoảng → mặc định + log cảnh báo (R7.5)."""
    p_mm = pos_tol_mm
    if p_mm is None or not (_POS_TOL_RANGE_MM[0] <= p_mm <= _POS_TOL_RANGE_MM[1]):
        if p_mm is not None:
            logger.warning(
                "[PARITY] pos_tol_mm=%s ngoài %s → dùng mặc định %s mm.",
                p_mm, _POS_TOL_RANGE_MM, DEFAULT_POS_TOL_MM,
            )
        p_mm = DEFAULT_POS_TOL_MM

    r_deg = rot_tol_deg
    if r_deg is None or not (_ROT_TOL_RANGE_DEG[0] <= r_deg <= _ROT_TOL_RANGE_DEG[1]):
        if r_deg is not None:
            logger.warning(
                "[PARITY] rot_tol_deg=%s ngoài %s → dùng mặc định %s độ.",
                r_deg, _ROT_TOL_RANGE_DEG, DEFAULT_ROT_TOL_DEG,
            )
        r_deg = DEFAULT_ROT_TOL_DEG

    return ParityTolerance(pos_tol_pt=p_mm * MM_TO_PTS, rot_tol_deg=r_deg)


def _rotation_deg(item: dict[str, Any]) -> float:
    """Suy ra góc xoay (độ) từ một item layout (hỗ trợ isRotated/isRotated180/rotation)."""
    if "rotation" in item:
        try:
            return float(item["rotation"]) % 360.0
        except (TypeError, ValueError):
            return 0.0
    deg = 0.0
    if item.get("isRotated"):
        deg += 90.0
    if item.get("isRotated180"):
        deg += 180.0
    return deg % 360.0


def _angle_diff(a: float, b: float) -> float:
    """Chênh lệch góc nhỏ nhất (độ) trên vòng tròn."""
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def assert_parity(
    preview_items: Sequence[dict[str, Any]],
    output_items: Sequence[dict[str, Any]],
    pos_tol_mm: float | None = None,
    rot_tol_deg: float | None = None,
) -> bool:
    """So bố cục preview vs output từng phần tử theo dung sai (R7.1, R7.3).

    Trả True nếu ĐẠT. Vượt dung sai → raise ParityError nêu rõ phần tử và loại
    sai lệch (R7.4). Thiếu/ngoài khoảng cấu hình → dùng mặc định + cảnh báo (R7.5).
    """
    tol = resolve_tolerance(pos_tol_mm, rot_tol_deg)

    if len(preview_items) != len(output_items):
        raise ParityError(
            f"Số phần tử lệch: preview={len(preview_items)} vs output={len(output_items)}"
        )

    for idx, (pv, ov) in enumerate(zip(preview_items, output_items)):
        for attr in ("x", "y", "width", "height"):
            pv_val = float(pv.get(attr, 0.0))
            ov_val = float(ov.get(attr, 0.0))
            if abs(pv_val - ov_val) > tol.pos_tol_pt:
                raise ParityError(
                    f"Phần tử #{idx}: '{attr}' lệch {abs(pv_val - ov_val):.4f}pt "
                    f"> dung sai {tol.pos_tol_pt:.4f}pt "
                    f"(preview={pv_val:.4f}, output={ov_val:.4f})"
                )
        rot_diff = _angle_diff(_rotation_deg(pv), _rotation_deg(ov))
        if rot_diff > tol.rot_tol_deg:
            raise ParityError(
                f"Phần tử #{idx}: góc xoay lệch {rot_diff:.4f}° "
                f"> dung sai {tol.rot_tol_deg:.4f}°"
            )
    return True
