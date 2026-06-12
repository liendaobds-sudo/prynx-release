"""
pdf_content_parser — Extract vector drawings from PDF content streams.

Standalone module extracted from pdf_wrapper. Parses PDF content stream operators
to reconstruct path geometry, returning drawing dicts compatible with the
format compatible with legacy page.extract_vector_paths() API.
"""
import re
import pikepdf
from app.workers.pdf_types import Point, Rect


def parse_content_stream(raw_bytes: bytes, page_height: float) -> list:
    """
    Parse PDF content stream bytes and extract drawing paths.

    Returns list of dicts, each with:
      - 'items': list of tuples ('l', p1, p2) or ('c', p0, cp1, cp2, p3) or ('re', Rect)
      - 'rect': Rect bounding box
      - 'color': stroke color tuple or None
      - 'fill': fill color tuple or None
      - 'width': stroke width
      - 'type': 's' (stroke), 'f' (fill), 'sf' (both)
      - 'closePath': bool
    """
    drawings = []
    current_path = []
    current_point = None
    subpath_start = None
    stroke_color = (0, 0, 0)
    fill_color = None
    stroke_width = 1.0

    ctm_stack = [[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]]
    current_ctm = list(ctm_stack[-1])

    def transform(px, py):
        a, b, c, d, e, f = current_ctm
        tx = px * a + py * c + e
        ty = px * b + py * d + f
        return tx, ty

    try:
        text = raw_bytes.decode('latin-1', errors='replace')
    except Exception:
        return []

    tokens = re.findall(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[a-zA-Z*]+\'?\"?', text)

    num_stack = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1

        try:
            num_stack.append(float(tok))
            continue
        except ValueError:
            pass

        if tok == 'q':
            ctm_stack.append(list(current_ctm))
            num_stack.clear()
        elif tok == 'Q':
            if len(ctm_stack) > 1:
                ctm_stack.pop()
                current_ctm = list(ctm_stack[-1])
            num_stack.clear()
        elif tok == 'cm':
            if len(num_stack) >= 6:
                a, b, c, d, e, f = num_stack[-6:]
                ca, cb, cc, cd, ce, cf = current_ctm
                current_ctm = [
                    a*ca + b*cc, a*cb + b*cd,
                    c*ca + d*cc, c*cb + d*cd,
                    e*ca + f*cc + ce, e*cb + f*cd + cf
                ]
                ctm_stack[-1] = current_ctm
            num_stack.clear()

        elif tok == 'm':
            if len(num_stack) >= 2:
                x, y = num_stack[-2], num_stack[-1]
                tx, ty = transform(x, y)
                current_point = Point(tx, page_height - ty)
                subpath_start = Point(tx, page_height - ty)
            num_stack.clear()

        elif tok == 'l':
            if len(num_stack) >= 2 and current_point:
                x, y = num_stack[-2], num_stack[-1]
                tx, ty = transform(x, y)
                new_point = Point(tx, page_height - ty)
                current_path.append(('l', Point(current_point.x, current_point.y), new_point))
                current_point = new_point
            num_stack.clear()

        elif tok == 'c':
            if len(num_stack) >= 6 and current_point:
                x1, y1, x2, y2, x3, y3 = num_stack[-6:]
                tx1, ty1 = transform(x1, y1)
                tx2, ty2 = transform(x2, y2)
                tx3, ty3 = transform(x3, y3)
                cp1 = Point(tx1, page_height - ty1)
                cp2 = Point(tx2, page_height - ty2)
                end = Point(tx3, page_height - ty3)
                current_path.append(('c', Point(current_point.x, current_point.y), cp1, cp2, end))
                current_point = end
            num_stack.clear()

        elif tok == 'v':
            if len(num_stack) >= 4 and current_point:
                x2, y2, x3, y3 = num_stack[-4:]
                tx2, ty2 = transform(x2, y2)
                tx3, ty3 = transform(x3, y3)
                cp1 = Point(current_point.x, current_point.y)
                cp2 = Point(tx2, page_height - ty2)
                end = Point(tx3, page_height - ty3)
                current_path.append(('c', Point(current_point.x, current_point.y), cp1, cp2, end))
                current_point = end
            num_stack.clear()

        elif tok == 'y':
            if len(num_stack) >= 4 and current_point:
                x1, y1, x3, y3 = num_stack[-4:]
                tx1, ty1 = transform(x1, y1)
                tx3, ty3 = transform(x3, y3)
                cp1 = Point(tx1, page_height - ty1)
                end = Point(tx3, page_height - ty3)
                cp2 = Point(end.x, end.y)
                current_path.append(('c', Point(current_point.x, current_point.y), cp1, cp2, end))
                current_point = end
            num_stack.clear()

        elif tok == 're':
            if len(num_stack) >= 4:
                x, y, w, h = num_stack[-4:]
                pts = [transform(x, y), transform(x+w, y), transform(x+w, y+h), transform(x, y+h)]
                tx_min = min(p[0] for p in pts)
                tx_max = max(p[0] for p in pts)
                ty_min = min(p[1] for p in pts)
                ty_max = max(p[1] for p in pts)
                rect_y0 = page_height - ty_max
                rect_y1 = page_height - ty_min
                r = Rect(tx_min, rect_y0, tx_max, rect_y1)
                current_path.append(('re', r))
                current_point = Point(pts[0][0], page_height - pts[0][1])
                subpath_start = Point(pts[0][0], page_height - pts[0][1])
            num_stack.clear()

        elif tok == 'h':
            if subpath_start and current_point:
                if abs(current_point.x - subpath_start.x) > 0.01 or abs(current_point.y - subpath_start.y) > 0.01:
                    current_path.append(('l', Point(current_point.x, current_point.y), Point(subpath_start.x, subpath_start.y)))
                current_point = Point(subpath_start.x, subpath_start.y)
            num_stack.clear()

        elif tok in ('S', 's'):
            if current_path:
                if tok == 's' and subpath_start and current_point:
                    if abs(current_point.x - subpath_start.x) > 0.01 or abs(current_point.y - subpath_start.y) > 0.01:
                        current_path.append(('l', Point(current_point.x, current_point.y), Point(subpath_start.x, subpath_start.y)))
                drawings.append(_make_drawing(current_path, stroke_color, None, stroke_width, 's', tok == 's'))
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok in ('f', 'F'):
            if current_path:
                drawings.append(_make_drawing(current_path, None, fill_color or (0, 0, 0), stroke_width, 'f', True))
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok == 'B' or tok == 'b':
            if current_path:
                drawings.append(_make_drawing(current_path, stroke_color, fill_color or (0, 0, 0), stroke_width, 'sf', tok == 'b'))
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok == 'n':
            current_path = []
            current_point = None
            subpath_start = None
            num_stack.clear()

        elif tok == 'w':
            if num_stack:
                stroke_width = num_stack[-1]
            num_stack.clear()

        elif tok == 'RG':
            if len(num_stack) >= 3:
                stroke_color = (num_stack[-3], num_stack[-2], num_stack[-1])
            num_stack.clear()
        elif tok == 'rg':
            if len(num_stack) >= 3:
                fill_color = (num_stack[-3], num_stack[-2], num_stack[-1])
            num_stack.clear()
        elif tok == 'K':
            if len(num_stack) >= 4:
                stroke_color = (num_stack[-4], num_stack[-3], num_stack[-2], num_stack[-1])
            num_stack.clear()
        elif tok == 'k':
            if len(num_stack) >= 4:
                fill_color = (num_stack[-4], num_stack[-3], num_stack[-2], num_stack[-1])
            num_stack.clear()
        elif tok == 'G':
            if len(num_stack) >= 1:
                g = num_stack[-1]
                stroke_color = (g, g, g)
            num_stack.clear()
        elif tok == 'g':
            if len(num_stack) >= 1:
                g = num_stack[-1]
                fill_color = (g, g, g)
            num_stack.clear()

        elif tok in ('CS', 'cs'):
            num_stack.clear()

        elif tok in ('SC', 'sc', 'SCN', 'scn'):
            if tok.isupper():
                if len(num_stack) >= 4:
                    stroke_color = tuple(num_stack[-4:])
                elif len(num_stack) >= 3:
                    stroke_color = tuple(num_stack[-3:])
                elif len(num_stack) >= 1:
                    g = num_stack[-1]
                    stroke_color = (g, g, g)
            else:
                if len(num_stack) >= 4:
                    fill_color = tuple(num_stack[-4:])
                elif len(num_stack) >= 3:
                    fill_color = tuple(num_stack[-3:])
                elif len(num_stack) >= 1:
                    g = num_stack[-1]
                    fill_color = (g, g, g)
            num_stack.clear()

        elif tok in ('q', 'Q', 'cm', 'gs', 'ri', 'i', 'J', 'j', 'M', 'd',
                      'BT', 'ET', 'Tf', 'Td', 'TD', 'Tm', 'Tj', 'TJ',
                      'T*', "Tc", "Tw", "Tz", "TL", "Ts", "Tr",
                      'Do', 'W', 'BI', 'ID', 'EI', 'BMC', 'BDC', 'EMC',
                      'MP', 'DP', 'sh'):
            num_stack.clear()
        else:
            num_stack.clear()

    return drawings


def _make_drawing(items, stroke_color, fill_color, width, draw_type, closed):
    """Build a drawing dict from parsed path items."""
    all_x = []
    all_y = []
    for item in items:
        if item[0] == 'l':
            all_x.extend([item[1].x, item[2].x])
            all_y.extend([item[1].y, item[2].y])
        elif item[0] == 'c':
            all_x.extend([item[1].x, item[2].x, item[3].x, item[4].x])
            all_y.extend([item[1].y, item[2].y, item[3].y, item[4].y])
        elif item[0] == 're':
            all_x.extend([item[1].x0, item[1].x1])
            all_y.extend([item[1].y0, item[1].y1])

    bbox = Rect(min(all_x), min(all_y), max(all_x), max(all_y)) if all_x else Rect(0, 0, 0, 0)

    return {
        'items': items, 'rect': bbox,
        'color': stroke_color, 'fill': fill_color,
        'width': width, 'type': draw_type, 'closePath': closed,
    }


def extract_vector_paths(pike_page: pikepdf.Page, pdf: pikepdf.Pdf) -> list:
    """
    Extract vector drawings from a pikepdf page.
    Equivalent to the old pdf_wrapper Page.extract_vector_paths().
    """
    mb = pike_page.mediabox
    page_h = float(mb[3] - mb[1])
    raw_bytes = b""

    try:
        contents = pike_page.get("/Contents")
        if contents is None:
            return []
        if isinstance(contents, pikepdf.Array):
            for ref in contents:
                try:
                    stream_obj = pdf.get_object(ref.objgen)
                    raw_bytes += stream_obj.read_bytes()
                except Exception:
                    pass
        else:
            try:
                raw_bytes = contents.read_bytes()
            except Exception:
                pass
    except Exception:
        return []

    if not raw_bytes:
        return []

    return parse_content_stream(raw_bytes, page_h)
