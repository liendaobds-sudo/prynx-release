"""
cut_model.py — Mô hình cắt nội bộ (độc lập máy).

Mọi toạ độ ở ĐƠN VỊ MM, gốc DƯỚI-TRÁI, Y hướng lên (quy ước nội bộ thống nhất).
Các Emitter sẽ tự đổi sang hệ của máy (PLU, gốc, lật/đổi trục) theo MachineProfile.

Tham chiếu spec: .kiro/specs/gui-may-be/design.md (mục "Data Models").
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

from app.workers.cut_export.geometry import CutGeometryError, FLATTEN_TOL_MM, flatten_cubic_bezier


# Nhãn dao chuẩn hoá (dùng cho định tuyến song đạo / thứ tự cắt).
TOOL_SHARED = "shared"
TOOL_LEFT = "left"
TOOL_RIGHT = "right"

# Loại dấu định vị (ốc) hợp lệ.
MARK_KINDS = ("L", "cross", "circle", "square")


def _segment_area(segment, origin):
    """Tích phân Green chính xác theo hệ số đa thức, không lấy mẫu cubic."""
    points = [(x-origin[0], y-origin[1]) for x,y in segment]
    if len(points) == 2:
        (x0,y0),(x1,y1) = points
        return (x0*y1-y0*x1)/2
    a,b,c,d = points
    coefficients = [a, tuple(3*(b[i]-a[i]) for i in (0,1)),
                    tuple(3*(a[i]-2*b[i]+c[i]) for i in (0,1)),
                    tuple(-a[i]+3*b[i]-3*c[i]+d[i] for i in (0,1))]
    return math.fsum((p[0]*q[1]-p[1]*q[0])*j/(i+j)
                     for i,p in enumerate(coefficients)
                     for j,q in enumerate(coefficients) if j > 0)/2


@dataclass
class CutPath:
    """Một đường cắt kín/hở; giữ primitive và polyline cho protocol chỉ có line.

    points: danh sách (x, y) theo mm, gốc dưới-trái.
    closed: True nếu là contour kín (điểm cuối nối điểm đầu).
    tool_tag: nhãn dao ('shared' | 'left' | 'right' | tên tuỳ cấu hình) hoặc None.
    block_id: chỉ số cụm/loại — phục vụ thứ tự cắt và song đạo.
    """

    points: list[tuple[float, float]]
    closed: bool = True
    tool_tag: Optional[str] = None
    block_id: int = 0
    # QUALITY (audit 2026-09-24 §CUT24.D01): mỗi primitive có 2 điểm (line)
    # hoặc 4 điểm (cubic), tọa độ mm tuyệt đối. Tuple tránh sửa tay control point.
    segments: tuple[tuple[tuple[float, float], ...], ...] = ()
    flatten_tolerance_mm: float = FLATTEN_TOL_MM
    _vector_points: tuple[tuple[float, float], ...] = field(default=(), init=False, repr=False)
    _vector_segments: tuple = field(default=(), init=False, repr=False)

    def __post_init__(self) -> None:
        # Chuẩn hoá points về list[tuple[float, float]] để so sánh/đơn định ổn định.
        norm: list[tuple[float, float]] = []
        for p in self.points:
            if len(p) != 2:
                raise ValueError(f"Điểm phải có 2 toạ độ (x, y), nhận: {p!r}")
            norm.append((float(p[0]), float(p[1])))
        self.points = norm
        if self.segments:
            segments = tuple(tuple((float(p[0]), float(p[1])) for p in segment)
                             for segment in self.segments)
            if any(len(segment) not in (2, 4) for segment in segments):
                raise ValueError("Đoạn cắt phải là line 2 điểm hoặc Bézier 4 điểm")
            if any(a[-1] != b[0] for a,b in zip(segments,segments[1:])):
                raise ValueError("Các đoạn đường cắt phải nối liên tục")
            origin = segments[0][0]
            source_area = math.fsum(_segment_area(s, origin) for s in segments) if self.closed else 0.0
            tolerance = self.flatten_tolerance_mm
            while True:
                points = [origin]
                for segment in segments:
                    if len(segment) == 4:
                        points.extend(flatten_cubic_bezier(*segment, max_seg_mm=tolerance)[1:])
                    else:
                        points.append(segment[-1])
                if self.closed and points[-1] != points[0]:
                    points.append(points[0])
                area = math.fsum(_segment_area(s, origin) for s in zip(points, points[1:]))
                if not source_area or (area and math.copysign(1, area) == math.copysign(1, source_area)):
                    break
                # Một vòng/lỗ nhỏ hơn dung sai vẫn phải còn vòng và winding.
                # Giảm sai số tới khi chứng minh được, không giới hạn số bước.
                tolerance /= 2
                if tolerance == 0:
                    raise CutGeometryError("Không giữ được chiều vòng đường cắt khi làm phẳng")
            self.segments = segments
            self.points = points
            self._vector_points = tuple(points)
            self._vector_segments = segments

    def vector_segments(self):
        """Không dùng primitive cũ nếu caller legacy đã sửa trực tiếp polyline."""
        return self.segments if (self.segments is self._vector_segments
                                 and tuple(self.points) == self._vector_points) else ()

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
