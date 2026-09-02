"""Hợp đồng affine dùng chung cho nesting tự do trong Bình tem bế/CNC.

Module này chỉ làm việc trong hệ canonical mm: gốc trái-dưới, Y hướng lên và góc
dương ngược chiều kim đồng hồ. Ma trận dùng thứ tự PDF [a, b, c, d, e, f]:

    x' = a*x + c*y + e
    y' = b*x + d*y + f

Không đưa toạ độ top-down hay point của lane bình bản cũ vào đây.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence, TypeAlias


PointMm: TypeAlias = tuple[float, float]
_ISOMETRY_TOL = 1e-9
_RIGID_DETERMINANT_TOL = 1e-12


class AffineContractError(ValueError):
    """Dữ liệu pose/affine không thỏa hợp đồng renderer production."""


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AffineContractError(f"{field} phải là số hữu hạn.")
    result = float(value)
    if not math.isfinite(result):
        raise AffineContractError(f"{field} phải là số hữu hạn.")
    return 0.0 if result == 0.0 else result


def parse_finite_number(value: Any, *, field: str) -> float:
    return _finite_number(value, field)


def parse_point_mm(raw: Sequence[Any], *, field: str = "referencePointMm") -> PointMm:
    """Đọc một điểm mm; không chấp nhận chuỗi, bool, NaN hoặc Infinity."""

    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise AffineContractError(f"{field} phải có đúng hai toạ độ mm.")
    return (
        _finite_number(raw[0], f"{field}[0]"),
        _finite_number(raw[1], f"{field}[1]"),
    )


@dataclass(frozen=True, slots=True)
class PoseMm:
    """Pose authoritative của một instance trong manifest production."""

    rotation_deg: float
    translate_x_mm: float
    translate_y_mm: float

    def __post_init__(self) -> None:
        rotation = _finite_number(self.rotation_deg, "pose.rotationDeg")
        tx = _finite_number(self.translate_x_mm, "pose.translateXmm")
        ty = _finite_number(self.translate_y_mm, "pose.translateYmm")
        if rotation < 0.0 or rotation >= 360.0:
            raise AffineContractError(
                "pose.rotationDeg phải canonical trong [0, 360)."
            )
        object.__setattr__(self, "rotation_deg", rotation)
        object.__setattr__(self, "translate_x_mm", tx)
        object.__setattr__(self, "translate_y_mm", ty)


def parse_pose_mm(raw: Mapping[str, Any], *, field: str = "pose") -> PoseMm:
    """Đọc exact schema pose; field thừa cũng bị chặn để tránh contract drift."""

    if not isinstance(raw, Mapping):
        raise AffineContractError(f"{field} phải là object.")
    expected = {"rotationDeg", "translateXmm", "translateYmm"}
    if set(raw) != expected:
        raise AffineContractError(
            f"{field} phải có đúng rotationDeg/translateXmm/translateYmm."
        )
    try:
        return PoseMm(
            rotation_deg=raw["rotationDeg"],
            translate_x_mm=raw["translateXmm"],
            translate_y_mm=raw["translateYmm"],
        )
    except AffineContractError as exc:
        message = str(exc).replace("pose.", f"{field}.", 1)
        raise AffineContractError(message) from exc


@dataclass(frozen=True, slots=True)
class Affine2D:
    """Ma trận affine 2x3 theo quy ước toán tử cm của PDF."""

    a: float
    b: float
    c: float
    d: float
    e: float
    f: float

    def __post_init__(self) -> None:
        for name in ("a", "b", "c", "d", "e", "f"):
            object.__setattr__(
                self, name, _finite_number(getattr(self, name), f"affine.{name}")
            )

    @classmethod
    def from_sequence(
        cls, raw: Sequence[Any], *, field: str = "affine"
    ) -> "Affine2D":
        if not isinstance(raw, (list, tuple)) or len(raw) != 6:
            raise AffineContractError(
                f"{field} phải có đúng sáu hệ số [a, b, c, d, e, f]."
            )
        values = [
            _finite_number(value, f"{field}[{index}]")
            for index, value in enumerate(raw)
        ]
        return cls(*values)

    @property
    def determinant(self) -> float:
        return self.a * self.d - self.b * self.c

    def as_tuple(self) -> tuple[float, float, float, float, float, float]:
        return (self.a, self.b, self.c, self.d, self.e, self.f)

    def apply(self, point: Sequence[Any]) -> PointMm:
        x, y = parse_point_mm(point, field="pointMm")
        return (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )


def rigid_pose_affine_mm(
    pose: PoseMm, reference_point_mm: Sequence[Any]
) -> Affine2D:
    """Dựng G = T(tx,ty) * R(theta) * T(-referencePoint).

    G chỉ xoay/tịnh tiến, luôn có định thức +1 và không thể mirror.
    """

    if not isinstance(pose, PoseMm):
        raise AffineContractError("pose phải là PoseMm đã kiểm chứng.")
    ref_x, ref_y = parse_point_mm(reference_point_mm)
    radians = math.radians(pose.rotation_deg)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    matrix = Affine2D(
        a=cosine,
        b=sine,
        c=-sine,
        d=cosine,
        e=pose.translate_x_mm - (cosine * ref_x - sine * ref_y),
        f=pose.translate_y_mm - (sine * ref_x + cosine * ref_y),
    )
    if abs(matrix.determinant - 1.0) > _RIGID_DETERMINANT_TOL:
        raise AffineContractError("Pose instance không còn là phép rigid det=+1.")
    return matrix


def compose_affine(left: Affine2D, right: Affine2D) -> Affine2D:
    """Trả left o right: áp right trước rồi mới áp left."""

    if not isinstance(left, Affine2D) or not isinstance(right, Affine2D):
        raise AffineContractError("compose_affine chỉ nhận hai Affine2D.")
    return Affine2D(
        a=left.a * right.a + left.c * right.b,
        b=left.b * right.a + left.d * right.b,
        c=left.a * right.c + left.c * right.d,
        d=left.b * right.c + left.d * right.d,
        e=left.a * right.e + left.c * right.f + left.e,
        f=left.b * right.e + left.d * right.f + left.f,
    )


def _assert_unit_isometry(
    matrix: Affine2D,
    *,
    field: str,
    determinant_sign: int | None,
) -> None:
    """Chặn scale/shear; source giữ hướng, SheetFrame có thể phản chiếu."""

    norm_x = matrix.a * matrix.a + matrix.b * matrix.b
    norm_y = matrix.c * matrix.c + matrix.d * matrix.d
    dot = matrix.a * matrix.c + matrix.b * matrix.d
    determinant = matrix.determinant
    if determinant_sign == 1 and determinant < 0.0:
        raise AffineContractError(
            "SourcePageToCanonical phải bảo toàn hướng, không được mirror."
        )
    determinant_error = (
        abs(abs(determinant) - 1.0)
        if determinant_sign is None
        else abs(determinant - float(determinant_sign))
    )
    if (
        abs(norm_x - 1.0) > _ISOMETRY_TOL
        or abs(norm_y - 1.0) > _ISOMETRY_TOL
        or abs(dot) > _ISOMETRY_TOL
        or determinant_error > _ISOMETRY_TOL
    ):
        determinant_text = "+/-1" if determinant_sign is None else f"{determinant_sign:+d}"
        raise AffineContractError(
            f"{field} phải là phép rigid đẳng cự det={determinant_text}, "
            "không được scale/shear."
        )


def compose_render_ctm_mm(
    *,
    sheet_frame: Affine2D,
    pose: PoseMm,
    reference_point_mm: Sequence[Any],
    source_page_to_canonical: Affine2D,
) -> Affine2D:
    """Dựng CTM side đúng thứ tự SheetFrame * G * SourcePageToCanonical."""

    if not isinstance(sheet_frame, Affine2D):
        raise AffineContractError("sheet_frame phải là Affine2D.")
    if not isinstance(source_page_to_canonical, Affine2D):
        raise AffineContractError("source_page_to_canonical phải là Affine2D.")
    _assert_unit_isometry(sheet_frame, field="SheetFrame", determinant_sign=None)
    _assert_unit_isometry(
        source_page_to_canonical,
        field="SourcePageToCanonical",
        determinant_sign=1,
    )
    geometry = rigid_pose_affine_mm(pose, reference_point_mm)
    return compose_affine(
        sheet_frame,
        compose_affine(geometry, source_page_to_canonical),
    )


def angle_diff_deg(first: float, second: float) -> float:
    """Chênh lệch nhỏ nhất giữa hai góc canonical trên vòng tròn."""

    a = _finite_number(first, "firstRotationDeg")
    b = _finite_number(second, "secondRotationDeg")
    if not (0.0 <= a < 360.0) or not (0.0 <= b < 360.0):
        raise AffineContractError("Góc parity phải canonical trong [0, 360).")
    difference = abs(a - b) % 360.0
    return min(difference, 360.0 - difference)
