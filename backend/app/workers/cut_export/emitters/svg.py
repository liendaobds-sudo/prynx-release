"""svg.py — Emitter SVG.

Requirements: 3.3 (đường cắt là path, phân lớp theo dao), 3.5 (1:1 mm).
- viewBox theo khổ giấy (mm). Hệ SVG Y hướng XUỐNG → lật Y so với mm gốc dưới-trái.
- Nhóm <g> theo tool_tag (phân lớp dao). Stroke mảnh, không fill.
"""

from __future__ import annotations

from collections import defaultdict
from xml.sax.saxutils import quoteattr

from app.workers.cut_export.cut_model import CutModel


class SvgEmitter:
    name = "svg"

    def __init__(self, stroke: str = "#FF00FF", stroke_width_mm: float = 0.1, draw_marks: bool = False,
                 draw_frame: bool = False, frame_w_mm: float = 0.0, frame_h_mm: float = 0.0):
        self.stroke = stroke
        self.stroke_width_mm = stroke_width_mm
        self.draw_marks = draw_marks
        self.draw_frame = draw_frame
        self.frame_w_mm = frame_w_mm
        self.frame_h_mm = frame_h_mm

    def emit(self, model: CutModel) -> bytes:
        w = model.sheet_w_mm
        h = model.sheet_h_mm
        out: list[str] = []
        out.append('<?xml version="1.0" encoding="UTF-8"?>')
        out.append(
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{w:.4f}mm" height="{h:.4f}mm" '
            f'viewBox="0 0 {w:.4f} {h:.4f}">'
        )

        if self.draw_frame and w > 0 and h > 0:
            out.append(
                f'<rect x="0" y="0" width="{w:.4f}" height="{h:.4f}" '
                f'fill="none" stroke="#cbd5e1" stroke-width="{max(self.stroke_width_mm, 0.4):.4f}"/>'
            )

        groups: dict[str, list] = defaultdict(list)
        for p in model.paths:
            if p.is_empty:
                continue
            groups[p.tool_tag or "shared"].append(p)

        for tag, paths in groups.items():
            safe_id = quoteattr(f"cut-{tag}")
            safe_stroke = quoteattr(str(self.stroke))
            out.append(f'<g id={safe_id} fill="none" '
                       f'stroke={safe_stroke} stroke-width="{self.stroke_width_mm:.4f}">')
            for p in paths:
                out.append(f'<path d="{self._path_d(p.points, p.closed, h)}"/>')
            out.append("</g>")

        if self.draw_marks and model.marks:
            out.append('<g id="regmarks" fill="none" stroke="#000000" stroke-width="0.1">')
            for m in model.marks:
                cy = h - m.y
                out.append(
                    f'<path d="M {m.x - 2.5:.4f} {cy:.4f} L {m.x + 2.5:.4f} {cy:.4f} '
                    f'M {m.x:.4f} {cy - 2.5:.4f} L {m.x:.4f} {cy + 2.5:.4f}"/>'
                )
            out.append("</g>")

        out.append("</svg>")
        return ("\n".join(out) + "\n").encode("utf-8")

    def _path_d(self, points, closed: bool, sheet_h: float) -> str:
        # Lật Y: svg_y = sheet_h - y.
        d = []
        for i, (x, y) in enumerate(points):
            cmd = "M" if i == 0 else "L"
            d.append(f"{cmd} {x:.4f} {sheet_h - y:.4f}")
        if closed:
            d.append("Z")
        return " ".join(d)
