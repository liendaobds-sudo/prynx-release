"""
registration.py — Khớp bản in (print-and-cut).

Requirements: 4.8, 4.9.
- onboard_frame: chỉ tính frame (FSIZE) từ tâm ốc; máy tự dò, KHÔNG biến đổi toạ độ.
- manual_affine: nhận toạ độ THIẾT KẾ của các ốc + toạ độ ĐO THỰC (thợ rê dao tới ốc),
  tính ma trận affine 2x3 (least-squares ≥3 điểm) rồi bẻ toàn bộ đường cắt cho khớp.

Ma trận affine M (2x3): [X, Y]^T = M · [x, y, 1]^T.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.workers.cut_export.cut_model import CutModel, CutPath


Point = tuple[float, float]


@dataclass
class Affine2x3:
    a: float; b: float; tx: float
    c: float; d: float; ty: float

    def apply(self, x: float, y: float) -> Point:
        return (self.a * x + self.b * y + self.tx,
                self.c * x + self.d * y + self.ty)

    def as_matrix(self) -> list[list[float]]:
        return [[self.a, self.b, self.tx], [self.c, self.d, self.ty]]


def solve_affine(design_pts: list[Point], measured_pts: list[Point]) -> Affine2x3:
    """Tìm ma trận affine khớp design_pts → measured_pts (least-squares).

    Yêu cầu ≥3 cặp điểm không thẳng hàng. Ném ValueError nếu thiếu/suy biến.
    """
    if len(design_pts) != len(measured_pts):
        raise ValueError("Số điểm thiết kế và đo thực phải bằng nhau")
    n = len(design_pts)
    if n < 3:
        raise ValueError("Cần ít nhất 3 điểm để giải affine 2D")

    A = np.array([[x, y, 1.0] for (x, y) in design_pts], dtype=float)
    X = np.array([p[0] for p in measured_pts], dtype=float)
    Y = np.array([p[1] for p in measured_pts], dtype=float)

    # Kiểm tra suy biến (điểm thẳng hàng) qua hạng ma trận.
    if np.linalg.matrix_rank(A) < 3:
        raise ValueError("Các điểm ốc thẳng hàng/suy biến — không giải được affine")

    row1, *_ = np.linalg.lstsq(A, X, rcond=None)
    row2, *_ = np.linalg.lstsq(A, Y, rcond=None)
    a, b, tx = (float(v) for v in row1)
    c, d, ty = (float(v) for v in row2)
    return Affine2x3(a, b, tx, c, d, ty)


def apply_affine(model: CutModel, M: Affine2x3) -> CutModel:
    """Trả CutModel MỚI với mọi đường cắt + ốc đã được warp theo M (Req 4.9)."""
    new_paths = [
        CutPath(
            points=[M.apply(x, y) for (x, y) in p.points],
            closed=p.closed, tool_tag=p.tool_tag, block_id=p.block_id,
        )
        for p in model.paths
    ]
    new_marks = []
    for mk in model.marks:
        nx, ny = M.apply(mk.x, mk.y)
        new_marks.append(type(mk)(nx, ny, mk.kind))

    out = CutModel(
        paths=new_paths,
        marks=new_marks,
        sheet_w_mm=model.sheet_w_mm,
        sheet_h_mm=model.sheet_h_mm,
        source_names=dict(model.source_names),
    )
    out.frame = out.compute_frame_from_marks()
    return out


def register(model: CutModel, mode: str,
             design_pts: list[Point] | None = None,
             measured_pts: list[Point] | None = None) -> CutModel:
    """Áp khớp dấu theo chế độ.

    - 'onboard_frame' | 'none': trả model với frame cập nhật, không warp.
    - 'manual_affine': cần design_pts + measured_pts → warp.
    """
    if mode in ("onboard_frame", "none"):
        if model.frame is None:
            model.frame = model.compute_frame_from_marks()
        return model
    if mode == "manual_affine":
        if not design_pts or not measured_pts:
            raise ValueError("manual_affine cần design_pts và measured_pts")
        M = solve_affine(design_pts, measured_pts)
        return apply_affine(model, M)
    raise ValueError(f"Chế độ khớp dấu không hỗ trợ: {mode!r}")
