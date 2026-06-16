"""
cut_model.py — Mô hình cắt nội bộ (độc lập máy).

Mọi toạ độ ở ĐƠN VỊ MM, gốc DƯỚI-TRÁI, Y hướng lên (quy ước nội bộ thống nhất).
Các Emitter sẽ tự đổi sang hệ của máy (PLU, gốc, lật/đổi trục) theo MachineProfile.

Tham chiếu spec: .kiro/specs/gui-may-be/design.md (mục "Data Models").
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# Nhãn dao chuẩn hoá (dùng cho định tuyến song đạo / thứ tự cắt).
TOOL_SHARED = "shared"
TOOL_LEFT = "left"
TOOL_RIGHT = "right"

# Loại dấu định vị (ốc) hợp lệ.
MARK_KINDS = ("L", "cross", "circle", "square")


@dataclass
class CutPath:
    """Một đường cắt kín/hở đã làm phẳng thành polyline.

    points: danh sách (x, y) theo mm, gốc dưới-trái.
    closed: True nếu là contour kín (điểm cuối nối điểm đầu).
    tool_tag: nhãn dao ('shared' | 'left' | 'right' | tên tuỳ cấu hình) hoặc None.
    block_id: chỉ số cụm/loại — phục vụ thứ tự cắt và song đạo.
    """

    points: list[tuple[float, float]]
    closed: bool = True
    tool_tag: Optional[str] = None
    block_id: int = 0

    def __post_init__(self) -> None:
        # Chuẩn hoá points về list[tuple[float, float]] để so sánh/đơn định ổn định.
        norm: list[tuple[float, float]] = []
        for p in self.points:
            if len(p) != 2:
                raise ValueError(f"Điểm phải có 2 toạ độ (x, y), nhận: {p!r}")
            norm.append((float(p[0]), float(p[1])))
        self.points = norm

    @property
    def is_empty(self) -> bool:
        return len(self.points) < 2

    def bounds(self) -> Optional[tuple[float, float, float, float]]:
        """Trả (min_x, min_y, max_x, max_y) theo mm, hoặc None nếu rỗng."""
        if not self.points:
            return None
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return (min(xs), min(ys), max(xs), max(ys))


@dataclass
class RegMark:
    """Một dấu định vị (ốc) — toạ độ TÂM theo mm, gốc dưới-trái."""

    x: float
    y: float
    kind: str = "L"

    def __post_init__(self) -> None:
        self.x = float(self.x)
        self.y = float(self.y)
        if self.kind not in MARK_KINDS:
            raise ValueError(
                f"Loại dấu không hợp lệ: {self.kind!r}. Hợp lệ: {MARK_KINDS}"
            )


@dataclass
class CutModel:
    """Mô hình cắt hoàn chỉnh của một tờ đã bình — độc lập máy.

    paths: các đường cắt (mm).
    marks: các dấu định vị (mm).
    sheet_w_mm, sheet_h_mm: kích thước khổ giấy (mm).
    frame: bbox tâm các ốc (min_x, min_y, max_x, max_y) — dùng cho FSIZE/khung khớp dấu.
    source_names: tên group/item/layer từ PontConfig (hợp đồng đặt tên, Requirement 1.5).
    """

    paths: list[CutPath] = field(default_factory=list)
    marks: list[RegMark] = field(default_factory=list)
    sheet_w_mm: float = 0.0
    sheet_h_mm: float = 0.0
    frame: Optional[tuple[float, float, float, float]] = None
    source_names: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.sheet_w_mm = float(self.sheet_w_mm)
        self.sheet_h_mm = float(self.sheet_h_mm)

    @property
    def is_empty(self) -> bool:
        """True nếu không có đường cắt hợp lệ nào (Requirement 1.5)."""
        return not any(not p.is_empty for p in self.paths)

    def compute_frame_from_marks(self) -> Optional[tuple[float, float, float, float]]:
        """Tính bbox tâm các ốc (frame). Trả None nếu không có ốc."""
        if not self.marks:
            return None
        xs = [m.x for m in self.marks]
        ys = [m.y for m in self.marks]
        return (min(xs), min(ys), max(xs), max(ys))


@dataclass
class SendResult:
    """Kết quả đưa dữ liệu tới máy (file/tcp/serial)."""

    ok: bool
    channel: str  # 'file' | 'tcp' | 'serial'
    detail: str = ""  # đường dẫn file hoặc thông điệp lỗi
    bytes_sent: int = 0
