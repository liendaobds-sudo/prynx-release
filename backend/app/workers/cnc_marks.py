"""
Dấu canh in 2 mặt (Duplex Align Marks) cho công cụ Bình Bế Rớt (CNC).

KHÁC với boong định vị (pont) — boong dùng cho máy CẮT (chỉ ở Mặt trước + Khuôn).
Dấu canh 2 mặt dùng để CANH CHỒNG khi in lật giấy → vẽ ở CẢ Mặt trước VÀ Mặt sau.

Sao theo hàm `drawPontCanh` của script Illustrator:
  - Mỗi dấu = 1 hình tròn Ø3mm + chữ thập (2 đoạn dài 5mm), nét 0.1mm, màu đen.
  - Đặt ở 4 ĐIỂM GIỮA CẠNH (giữa-trên, giữa-dưới, giữa-trái, giữa-phải), cách mép `margin_mm` (mặc định 3mm).
"""

import logging

from app.workers import pdf_wrapper as pdf_lib

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465


def draw_duplex_marks(page, sheet_w, sheet_h, margin_mm=3.0, ocg_xref=None):
    """Vẽ dấu canh in 2 mặt lên `page`. Trả về số dấu đã vẽ (4)."""
    circle_d = 3 * MM_TO_PTS
    line_len = 5 * MM_TO_PTS
    stroke_w = 0.1 * MM_TO_PTS
    margin_pt = margin_mm * MM_TO_PTS
    radius = circle_d / 2.0
    half = line_len / 2.0
    color = (0, 0, 0)

    cx = sheet_w / 2.0
    cy = sheet_h / 2.0
    centers = [
        (cx, margin_pt),               # giữa-trên
        (cx, sheet_h - margin_pt),     # giữa-dưới
        (margin_pt, cy),               # giữa-trái
        (sheet_w - margin_pt, cy),     # giữa-phải
    ]

    for px, py in centers:
        shape = page.new_shape()
        shape.draw_circle(pdf_lib.Point(px, py), radius)
        shape.draw_line(pdf_lib.Point(px - half, py), pdf_lib.Point(px + half, py))
        shape.draw_line(pdf_lib.Point(px, py - half), pdf_lib.Point(px, py + half))
        if ocg_xref is not None:
            shape.finish(color=color, fill=None, width=stroke_w, oc=ocg_xref)
        else:
            shape.finish(color=color, fill=None, width=stroke_w)
        shape.commit()

    logger.info("[cnc_marks] vẽ dấu canh 2 mặt (4 dấu) trên tờ %.0fx%.0f", sheet_w, sheet_h)
    return len(centers)
