"""
pdf_spot.py — Emitter PDF với đường cắt trên spot-color đặt tên (mặc định 'CutContour').

Requirements: 3.2 (spot-color đặt tên cấu hình, stroke-only), 3.5 (1:1 mm), 8.4 (đơn định).
Dùng cho nhánh BÀN GIAO file vào phần mềm bên thứ ba (RIP/cut software nhận diện
đường cắt qua tên spot-color). Hệ toạ độ reportlab = gốc dưới-trái, Y lên — khớp mm nội bộ.

Đơn định: Canvas(invariant=1) để không nhúng timestamp ngẫu nhiên.
"""

from __future__ import annotations

import io

from reportlab.pdfgen import canvas
from reportlab.lib.colors import CMYKColorSep

from app.workers.cut_export.cut_model import CutModel

MM_TO_PT = 72.0 / 25.4


class PdfSpotEmitter:
    name = "pdf"

    def __init__(self, spot_name: str = "CutContour", line_width_pt: float = 0.072,
                 draw_marks: bool = False, cmyk=(0.0, 1.0, 0.0, 0.0)):
        self.spot_name = spot_name
        self.line_width_pt = line_width_pt
        self.draw_marks = draw_marks
        self.cmyk = cmyk  # mặc định 100% magenta

    def emit(self, model: CutModel) -> bytes:
        buf = io.BytesIO()
        w_pt = model.sheet_w_mm * MM_TO_PT
        h_pt = model.sheet_h_mm * MM_TO_PT
        c = canvas.Canvas(buf, pagesize=(w_pt, h_pt), invariant=1)
        c.setTitle("Prynx CutContour")

        spot = CMYKColorSep(*self.cmyk, spotName=self.spot_name)
        c.setStrokeColor(spot)
        c.setLineWidth(self.line_width_pt)

        for path in model.paths:
            if path.is_empty:
                continue
            p = c.beginPath()
            segments = path.vector_segments()
            x0, y0 = segments[0][0] if segments else path.points[0]
            p.moveTo(x0 * MM_TO_PT, y0 * MM_TO_PT)
            # QUALITY (audit 2026-09-24 §CUT24.D01): PDF hỗ trợ cubic, nên
            # giữ đúng primitive; polyline chỉ dành nguồn/protocol chỉ có line.
            if segments:
                for segment in segments:
                    if len(segment) == 4:
                        p.curveTo(*(value*MM_TO_PT for point in segment[1:] for value in point))
                    else:
                        x,y = segment[-1]
                        p.lineTo(x*MM_TO_PT,y*MM_TO_PT)
            else:
                for x, y in path.points[1:]:
                    p.lineTo(x * MM_TO_PT, y * MM_TO_PT)
            if path.closed:
                p.close()
            c.drawPath(p, stroke=1, fill=0)

        if self.draw_marks:
            for m in model.marks:
                cx, cy = m.x * MM_TO_PT, m.y * MM_TO_PT
                r = 2.5 * MM_TO_PT
                c.line(cx - r, cy, cx + r, cy)
                c.line(cx, cy - r, cx, cy + r)

        c.showPage()
        c.save()
        return buf.getvalue()
