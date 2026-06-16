"""dxf.py — Emitter DXF cho CAM máy bế/CNC.

Requirements: 3.1 (đường cắt polyline kín), 3.5 (1:1 mm).
- Đơn vị mm ($INSUNITS=4).
- Dùng LWPOLYLINE (AC1015/R2000) — KHÔNG xuất SPLINE (máy rẻ nội suy spline gây giật dao).
- Mỗi đường cắt → 1 LWPOLYLINE; cờ closed theo CutPath.closed.
- Layer cấu hình được (mặc định 'CUT'); ốc (nếu vẽ) vào layer 'REG'.
"""

from __future__ import annotations

from app.workers.cut_export.cut_model import CutModel


class DxfEmitter:
    name = "dxf"

    def __init__(self, layer: str = "CUT", reg_layer: str = "REG", draw_marks: bool = False):
        self.layer = layer
        self.reg_layer = reg_layer
        self.draw_marks = draw_marks

    def emit(self, model: CutModel) -> bytes:
        out: list[str] = []
        # ── HEADER: đơn vị mm ──
        out += ["0", "SECTION", "2", "HEADER",
                "9", "$ACADVER", "1", "AC1015",
                "9", "$INSUNITS", "70", "4",
                "0", "ENDSEC"]
        # ── TABLES: khai báo layer ──
        out += ["0", "SECTION", "2", "TABLES",
                "0", "TABLE", "2", "LAYER", "70", "2"]
        for name, color in ((self.layer, "1"), (self.reg_layer, "5")):
            out += ["0", "LAYER", "2", name, "70", "0", "62", color, "6", "CONTINUOUS"]
        out += ["0", "ENDTAB", "0", "ENDSEC"]
        # ── ENTITIES ──
        out += ["0", "SECTION", "2", "ENTITIES"]
        for path in model.paths:
            if path.is_empty:
                continue
            out += self._lwpolyline(path.points, path.closed, self.layer)
        if self.draw_marks:
            for m in model.marks:
                out += self._mark_cross(m.x, m.y)
        out += ["0", "ENDSEC", "0", "EOF"]
        return ("\n".join(out) + "\n").encode("ascii")

    def _lwpolyline(self, points, closed: bool, layer: str) -> list[str]:
        seg = ["0", "LWPOLYLINE", "8", layer,
               "90", str(len(points)),
               "70", "1" if closed else "0"]
        for x, y in points:
            seg += ["10", f"{x:.4f}", "20", f"{y:.4f}"]
        return seg

    def _mark_cross(self, cx: float, cy: float, r: float = 2.5) -> list[str]:
        # Dấu chữ thập đơn giản: 2 đoạn LINE trên layer REG.
        out: list[str] = []
        for (x1, y1, x2, y2) in (
            (cx - r, cy, cx + r, cy),
            (cx, cy - r, cx, cy + r),
        ):
            out += ["0", "LINE", "8", self.reg_layer,
                    "10", f"{x1:.4f}", "20", f"{y1:.4f}",
                    "11", f"{x2:.4f}", "21", f"{y2:.4f}"]
        return out
