"""
shape_types.py — Định nghĩa enum ShapeType THỐNG NHẤT (Single Source of Truth).

Đây là vị trí định nghĩa enum ShapeType DUY NHẤT trong toàn bộ mã nguồn.
Trước đây enum bị trùng lặp ở `shape_classifier.py` (11 giá trị) và
`shape_analyzer.py` (9 giá trị) với thứ tự khác nhau, gây mâu thuẫn theo nhánh.

Mọi nơi cần phân loại hình PHẢI import từ module này:
    from app.workers.shape_types import ShapeType

Spec: .kiro/specs/die-shape-detection-ssot
Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
"""

from enum import Enum
from typing import Union


class ShapeType(Enum):
    """Enum phân loại hình học đường khuôn bế — đúng 11 giá trị (R10.4).

    Giá trị (value) là nhãn hiển thị tiếng Việt, giữ nguyên như hai enum cũ để
    bảo toàn tương thích khi serialize/hiển thị.
    """
    CIRCLE_ELLIPSE = "Tròn/Elip"
    TRIANGLE = "Tam giác"
    RECTANGLE = "Vuông/Chữ nhật"
    PENTAGON = "Ngũ giác"
    HEXAGON = "Lục giác"
    DUMBBELL = "Tạ tay"
    HAMMER = "Búa"
    TRAPEZOID = "Hình thang"
    PARALLELOGRAM = "Bình hành"
    ARROW = "Mũi tên"
    CUSTOM = "Đặc biệt"


# Tập tên hợp lệ (dùng cho validate nhanh + test gộp enum — R10.4).
SHAPE_TYPE_NAMES: frozenset[str] = frozenset(m.name for m in ShapeType)

# Ánh xạ giá trị enum cũ (shape_classifier / shape_analyzer) → enum thống nhất.
# Hai enum cũ dùng chung TÊN thành viên và GIÁ TRỊ chuỗi, nên ánh xạ là theo tên.
# Giữ bảng tường minh để test ánh xạ (R10.5) và phòng khi nhãn chuỗi đổi.
_LEGACY_VALUE_TO_NAME: dict[str, str] = {m.value: m.name for m in ShapeType}


def from_legacy_name(name: str) -> ShapeType:
    """Ánh xạ TÊN thành viên enum cũ → enum thống nhất (R10.5).

    Raises:
        ValueError: nếu `name` không thuộc tập 11 giá trị hợp lệ (R10.6).
    """
    key = (name or "").strip().upper()
    try:
        return ShapeType[key]
    except KeyError as exc:
        raise ValueError(
            f"Giá trị ShapeType không hợp lệ: {name!r}. "
            f"Phải thuộc {sorted(SHAPE_TYPE_NAMES)}."
        ) from exc


def from_legacy_value(value: str) -> ShapeType:
    """Ánh xạ GIÁ TRỊ chuỗi enum cũ (nhãn tiếng Việt) → enum thống nhất (R10.5)."""
    name = _LEGACY_VALUE_TO_NAME.get(value)
    if name is None:
        raise ValueError(
            f"Nhãn ShapeType không hợp lệ: {value!r}. "
            f"Phải thuộc {[m.value for m in ShapeType]}."
        )
    return ShapeType[name]


def coerce_shape_type(value: Union[str, ShapeType]) -> ShapeType:
    """Chuẩn hoá đầu vào (ShapeType | tên | nhãn) về ShapeType thống nhất.

    Chấp nhận: chính ShapeType, tên thành viên (vd 'HAMMER'), hoặc nhãn
    tiếng Việt (vd 'Búa'). Tham chiếu giá trị ngoài tập 11 → ValueError (R10.6).
    """
    if isinstance(value, ShapeType):
        return value
    if not isinstance(value, str):
        raise ValueError(f"Không thể chuyển {value!r} thành ShapeType.")
    key = value.strip().upper()
    if key in SHAPE_TYPE_NAMES:
        return ShapeType[key]
    return from_legacy_value(value)
