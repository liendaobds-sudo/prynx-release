"""
Registration mark and pont drawing for N-Up imposition.

Functions for drawing pont marks (registration marks) and
paper guides on output pages.

Extracted from nup_engine.py for modularity.
"""

from app.workers import pdf_wrapper as pdf_lib

MM_TO_PTS = 2.83465

def _draw_ponts_on_page(page, placements, pont_config, sheet_w, sheet_h, margin_left, margin_bottom, ocg_xref=None, item_name=None):
    """Draw pont marks (registration marks) on a page. Reusable for both artwork and cut pages."""
    MM_TO_PTS = 2.83465
    p_shape = pont_config.get('shape', 'circle')
    p_size = pont_config.get('size', 5.0) * MM_TO_PTS
    p_thick = pont_config.get('thickness', 0.5) * MM_TO_PTS
    radius = p_size / 2
    # Registration color (in trên MỌI kẽm) cho dấu định vị/ốc — không dùng RGB đen
    # (RGB chỉ lên kẽm K, lệch hệ màu khi in tách màu).
    color = (1, 1, 1, 1)
    
    # We do NOT use item_name from config if passed explicitly (because cut page has its own)
    if not item_name:
        item_name = pont_config.get('itemName', 'MKLINE')

    m_top = pont_config.get('marginTop', 7) * MM_TO_PTS
    m_bot = pont_config.get('marginBottom', 7) * MM_TO_PTS
    m_left_p = pont_config.get('marginLeft', 7) * MM_TO_PTS
    m_right_p = pont_config.get('marginRight', 7) * MM_TO_PTS

    cx_L = m_left_p + radius
    cx_R = sheet_w - m_right_p - radius
    cy_T = m_top + radius
    cy_B = sheet_h - m_bot - radius

    centers = [(cx_L, cy_T, 'TL'), (cx_R, cy_T, 'TR'), (cx_L, cy_B, 'BL'), (cx_R, cy_B, 'BR')]

    # Draw each pont as its own shape so they appear as individual objects in layer panel
    for idx, (cx, cy, loc) in enumerate(centers, 1):
        pont_shape = page.new_shape()
        if p_shape == 'circle':
            pont_shape.draw_circle(pdf_lib.Point(cx, cy), radius)
            pont_shape.finish(color=color, fill=color, width=0, oc=ocg_xref, item_name=item_name) if ocg_xref else pont_shape.finish(color=color, fill=color, width=0, item_name=item_name)
        elif p_shape == 'l_inverted':
            # Góc L = MỘT polyline liền (điểm-đầu → ĐỈNH → điểm-cuối) để đỉnh có
            # line join thật (miter), không phải 2 đoạn rời chạm nhau (đầu but-cap
            # chồng lên → không liền mạch khi phóng to / máy cắt chạy path).
            if loc == 'TL':
                _pts = [(cx + radius, cy - radius), (cx + radius, cy + radius), (cx - radius, cy + radius)]
            elif loc == 'TR':
                _pts = [(cx - radius, cy - radius), (cx - radius, cy + radius), (cx + radius, cy + radius)]
            elif loc == 'BL':
                _pts = [(cx + radius, cy + radius), (cx + radius, cy - radius), (cx - radius, cy - radius)]
            else:  # BR
                _pts = [(cx - radius, cy + radius), (cx - radius, cy - radius), (cx + radius, cy - radius)]
            pont_shape.draw_polyline([pdf_lib.Point(_x, _y) for _x, _y in _pts])
            pont_shape.finish(color=color, width=p_thick, line_join=0, oc=ocg_xref, item_name=item_name) if ocg_xref else pont_shape.finish(color=color, width=p_thick, line_join=0, item_name=item_name)
        elif p_shape == 'l_corner':
            if loc == 'TL':
                _pts = [(cx - radius, cy + radius), (cx - radius, cy - radius), (cx + radius, cy - radius)]
            elif loc == 'TR':
                _pts = [(cx + radius, cy + radius), (cx + radius, cy - radius), (cx - radius, cy - radius)]
            elif loc == 'BL':
                _pts = [(cx - radius, cy - radius), (cx - radius, cy + radius), (cx + radius, cy + radius)]
            else:  # BR
                _pts = [(cx + radius, cy - radius), (cx + radius, cy + radius), (cx - radius, cy + radius)]
            pont_shape.draw_polyline([pdf_lib.Point(_x, _y) for _x, _y in _pts])
            pont_shape.finish(color=color, width=p_thick, line_join=0, oc=ocg_xref, item_name=item_name) if ocg_xref else pont_shape.finish(color=color, width=p_thick, line_join=0, item_name=item_name)
        pont_shape.commit()

    # Paper guides
    def draw_guide(enabled, pos, length, thick, offX, offY):
        if not enabled:
            return
        length_pt = length * MM_TO_PTS
        thick_pt = thick * MM_TO_PTS
        offX_pt = offX * MM_TO_PTS
        offY_pt = offY * MM_TO_PTS
        if pos == 'TL':
            g_start = pdf_lib.Point(offX_pt, offY_pt)
            g_end = pdf_lib.Point(offX_pt + length_pt, offY_pt)
        elif pos == 'TR':
            g_start = pdf_lib.Point(sheet_w - offX_pt - length_pt, offY_pt)
            g_end = pdf_lib.Point(sheet_w - offX_pt, offY_pt)
        elif pos == 'BL':
            g_start = pdf_lib.Point(offX_pt, sheet_h - offY_pt)
            g_end = pdf_lib.Point(offX_pt + length_pt, sheet_h - offY_pt)
        elif pos == 'BR':
            g_start = pdf_lib.Point(sheet_w - offX_pt - length_pt, sheet_h - offY_pt)
            g_end = pdf_lib.Point(sheet_w - offX_pt, sheet_h - offY_pt)
        else:
            return
        g_shape = page.new_shape()
        g_shape.draw_line(g_start, g_end)
        g_shape.finish(
            color=color,
            width=thick_pt,
            oc=ocg_xref,
            item_name=item_name,
        )
        g_shape.commit()

    draw_guide(pont_config.get('guide1Enabled', False), pont_config.get('guide1Pos', 'BL'),
               pont_config.get('guide1Length', 20), pont_config.get('guide1Thickness', 0.5),
               pont_config.get('guide1OffX', 0), pont_config.get('guide1OffY', 0))
    draw_guide(pont_config.get('guide2Enabled', False), pont_config.get('guide2Pos', 'BR'),
               pont_config.get('guide2Length', 20), pont_config.get('guide2Thickness', 0.5),
               pont_config.get('guide2OffX', 0), pont_config.get('guide2OffY', 0))

