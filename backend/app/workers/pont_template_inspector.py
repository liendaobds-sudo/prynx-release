"""
pont_template_inspector.py — Trích xuất tự động thông số boong/ốc định vị từ file mẫu PDF / SVG.

Hỗ trợ thợ in tải file mẫu thiết kế (CorelDRAW, Illustrator, Graphtec Cutting Master, Mimaki FineCut...)
để PrynX tự động nhận diện:
1. Khổ giấy (sheet width/height mm).
2. Dấu ốc 4 góc: hình dạng (circle, l_corner, l_inverted), kích thước (size mm), độ dày nét (thickness mm).
3. 4 khoảng cách lề: marginLeft, marginRight, marginTop, marginBottom (mm).
4. Thanh canh giấy (paper guides): vị trí góc neo (TL, TR, BL, BR), chiều dài, độ dày, khoảng lệch offX/offY.
   Hỗ trợ cả thanh dẫn liên tục và vạch nét đứt/vạch định hướng của Graphtec/Mimaki.
5. Layer OCG / Graphtec: isGraphtec, layerInfoName, layerName, groupName, itemName.
"""

from __future__ import annotations

import logging
import math
import os
import re
from typing import Any
from xml.etree import ElementTree

import pikepdf
from app.workers.pdf_content_parser import extract_vector_paths
from app.workers.pdf_types import Rect

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83464567
PTS_TO_MM = 1.0 / MM_TO_PTS

_DEFAULT_GRAPH_INFO = "SA info 0 0 0 17.01 2 -16777216 -16777216 1 1 0"

# Regex tách lệnh và số trong SVG path d
_PATH_TOKEN_RE = re.compile(
    r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][-+]?\d+)?"
)


def _round1(val: float) -> float:
    """Làm tròn 1 chữ số thập phân (chuẩn kích thước mm ngành in)."""
    return round(float(val), 1)


def _round2(val: float) -> float:
    """Làm tròn 2 chữ số thập phân (chuẩn độ dày nét mm)."""
    return round(float(val), 2)


def _parse_svg_dimension(val_str: str | None, default_val: float = 0.0) -> float:
    """Chuyển đổi chuỗi kích thước SVG (mm, cm, in, pt, px) về mm."""
    if not val_str:
        return default_val
    s = val_str.strip().lower()
    m = re.match(r"^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|px)?$", s)
    if not m:
        try:
            return float(s)
        except ValueError:
            return default_val
    num = float(m.group(1))
    unit = m.group(2) or "px"
    if unit == "mm":
        return num
    if unit == "cm":
        return num * 10.0
    if unit == "in":
        return num * 25.4
    if unit == "pt":
        return num * (25.4 / 72.0)
    # px mặc định CSS 96 DPI: 1 inch = 96 px = 25.4 mm -> 1 px = 25.4 / 96 mm
    return num * (25.4 / 96.0)


class _CornerMarkCandidate:
    """Ứng viên dấu ốc định vị ở góc tờ in."""

    def __init__(
        self,
        rect: Rect,
        shape_type: str = "circle",
        thickness: float = 0.5,
        corner: str = "TL",
        vertex: tuple[float, float] | None = None,
    ):
        self.rect = rect
        self.shape_type = shape_type
        self.thickness = thickness
        self.corner = corner  # TL, TR, BL, BR
        self.vertex = vertex  # Điểm đỉnh góc vuông (cho ốc L)

    @property
    def cx(self) -> float:
        return (self.rect.x0 + self.rect.x1) / 2.0

    @property
    def cy(self) -> float:
        return (self.rect.y0 + self.rect.y1) / 2.0

    @property
    def width_pt(self) -> float:
        return abs(self.rect.x1 - self.rect.x0)

    @property
    def height_pt(self) -> float:
        return abs(self.rect.y1 - self.rect.y0)

    @property
    def size_pt(self) -> float:
        return max(self.width_pt, self.height_pt)


class _GuideCandidate:
    """Ứng viên thanh canh giấy (paper guide)."""

    def __init__(
        self,
        pos: str,
        length_mm: float,
        thickness_mm: float,
        off_x_mm: float,
        off_y_mm: float,
    ):
        self.pos = pos
        self.length_mm = length_mm
        self.thickness_mm = thickness_mm
        self.off_x_mm = off_x_mm
        self.off_y_mm = off_y_mm


def _classify_l_shape(
    corner: str,
    cx: float,
    cy: float,
    vertex: tuple[float, float] | None,
) -> str:
    """Phân biệt ốc chữ L thường (l_corner) hay L ngược (l_inverted).

    Theo quy ước PrynX (nup_marks.py):
    - l_corner: đỉnh góc vuông hướng ra NGOÀI mép tờ in (xa tâm tờ).
    - l_inverted: đỉnh góc vuông hướng vào TRONG lòng tờ in (về phía tâm tờ).
    """
    if vertex is None:
        return "l_inverted"

    vx, vy = vertex
    if corner == "TL":
        return "l_inverted" if (vx >= cx and vy >= cy) else "l_corner"
    if corner == "TR":
        return "l_inverted" if (vx <= cx and vy >= cy) else "l_corner"
    if corner == "BL":
        return "l_inverted" if (vx >= cx and vy <= cy) else "l_corner"
    if corner == "BR":
        return "l_inverted" if (vx <= cx and vy <= cy) else "l_corner"
    return "l_inverted"


def _inspect_pdf(file_path: str) -> tuple[float, float, list[dict], dict[str, Any]]:
    """Đọc trang 1 file PDF mẫu, trả về (sheet_w_pt, sheet_h_pt, drawings, ocg_info)."""
    with pikepdf.open(file_path) as pdf:
        if not pdf.pages:
            raise ValueError("File PDF không có trang nào.")
        page = pdf.pages[0]
        mb = page.mediabox
        sheet_w_pt = float(mb[2] - mb[0])
        sheet_h_pt = float(mb[3] - mb[1])

        # Quét OCG / Layer
        ocg_info: dict[str, Any] = {
            "isGraphtec": False,
            "layerInfoName": _DEFAULT_GRAPH_INFO,
            "layerName": "Marks_Model_",
            "groupName": "MarkLine",
            "itemName": "MKLINE",
        }

        try:
            root = pdf.Root
            if "/OCProperties" in root and "/OCGs" in root.OCProperties:
                for ocg in root.OCProperties.OCGs:
                    name = str(ocg.get("/Name", ""))
                    if name.startswith("SA info") or "Graphtec" in name:
                        ocg_info["isGraphtec"] = True
                        ocg_info["layerInfoName"] = name
                    elif "Mark" in name or "Cut" in name:
                        ocg_info["layerName"] = name
        except Exception as e:
            logger.debug("Lỗi đọc OCG trong PDF: %s", e)

        # Trích xuất vector paths
        drawings = extract_vector_paths(page, pdf)
        return sheet_w_pt, sheet_h_pt, drawings, ocg_info


def _inspect_svg(file_path: str) -> tuple[float, float, list[dict], dict[str, Any]]:
    """Phân tích file SVG mẫu, chuyển đổi sang đơn vị points thống nhất."""
    tree = ElementTree.parse(file_path)
    root = tree.getroot()

    # Xử lý khổ trang
    viewbox = root.attrib.get("viewBox")
    width_attr = root.attrib.get("width")
    height_attr = root.attrib.get("height")

    vb_x0 = vb_y0 = 0.0
    vb_w = vb_h = 0.0
    if viewbox:
        parts = [float(p) for p in re.split(r"[\s,]+", viewbox.strip()) if p]
        if len(parts) >= 4:
            vb_x0, vb_y0, vb_w, vb_h = parts[:4]

    # Tính sheet_w_mm, sheet_h_mm
    sheet_w_mm = _parse_svg_dimension(width_attr, default_val=vb_w)
    sheet_h_mm = _parse_svg_dimension(height_attr, default_val=vb_h)

    if sheet_w_mm == 0.0 and vb_w > 0:
        sheet_w_mm = vb_w
        sheet_h_mm = vb_h

    scale_x = 1.0
    scale_y = 1.0
    if vb_w > 0 and sheet_w_mm > 0:
        scale_x = sheet_w_mm / vb_w
        scale_y = sheet_h_mm / vb_h if vb_h > 0 else scale_x

    sheet_w_pt = sheet_w_mm * MM_TO_PTS
    sheet_h_pt = sheet_h_mm * MM_TO_PTS

    ocg_info = {
        "isGraphtec": False,
        "layerInfoName": _DEFAULT_GRAPH_INFO,
        "layerName": "Marks_Model_",
        "groupName": "MarkLine",
        "itemName": "MKLINE",
    }

    drawings: list[dict] = []

    def to_pt(x_val: float, y_val: float) -> tuple[float, float]:
        x_mm = (x_val - vb_x0) * scale_x
        y_mm = (y_val - vb_y0) * scale_y
        return x_mm * MM_TO_PTS, y_mm * MM_TO_PTS

    for elem in root.iter():
        tag = elem.tag.rsplit("}", 1)[-1].lower()

        elem_id = elem.attrib.get("id", "") or elem.attrib.get("{http://www.inkscape.org/namespaces/inkscape}label", "")
        if "SA info" in elem_id or "Graphtec" in elem_id:
            ocg_info["isGraphtec"] = True
            ocg_info["layerInfoName"] = elem_id

        stroke_w = _parse_svg_dimension(elem.attrib.get("stroke-width"), default_val=0.5) * MM_TO_PTS

        if tag in ("circle", "ellipse"):
            try:
                cx_raw = float(elem.attrib.get("cx", 0))
                cy_raw = float(elem.attrib.get("cy", 0))
                if tag == "circle":
                    r_raw = float(elem.attrib.get("r", 0))
                    r_pt = r_raw * scale_x * MM_TO_PTS
                else:
                    rx_raw = float(elem.attrib.get("rx", 0))
                    ry_raw = float(elem.attrib.get("ry", 0))
                    r_pt = max(rx_raw * scale_x, ry_raw * scale_y) * MM_TO_PTS
                cx_pt, cy_pt = to_pt(cx_raw, cy_raw)
                drawings.append({
                    "type": "circle",
                    "rect": Rect(cx_pt - r_pt, cy_pt - r_pt, cx_pt + r_pt, cy_pt + r_pt),
                    "width": stroke_w,
                    "items": [],
                    "radius": r_pt,
                })
            except Exception:
                continue

        elif tag == "rect":
            try:
                x_raw = float(elem.attrib.get("x", 0))
                y_raw = float(elem.attrib.get("y", 0))
                w_raw = float(elem.attrib.get("width", 0))
                h_raw = float(elem.attrib.get("height", 0))
                x0_pt, y0_pt = to_pt(x_raw, y_raw)
                x1_pt, y1_pt = to_pt(x_raw + w_raw, y_raw + h_raw)
                drawings.append({
                    "type": "rect",
                    "rect": Rect(min(x0_pt, x1_pt), min(y0_pt, y1_pt), max(x0_pt, x1_pt), max(y0_pt, y1_pt)),
                    "width": stroke_w,
                    "items": [],
                })
            except Exception:
                continue

        elif tag == "line":
            try:
                x1_raw = float(elem.attrib.get("x1", 0))
                y1_raw = float(elem.attrib.get("y1", 0))
                x2_raw = float(elem.attrib.get("x2", 0))
                y2_raw = float(elem.attrib.get("y2", 0))
                p1_pt = to_pt(x1_raw, y1_raw)
                p2_pt = to_pt(x2_raw, y2_raw)
                drawings.append({
                    "type": "line",
                    "rect": Rect(min(p1_pt[0], p2_pt[0]), min(p1_pt[1], p2_pt[1]), max(p1_pt[0], p2_pt[0]), max(p1_pt[1], p2_pt[1])),
                    "width": stroke_w,
                    "items": [("l", p1_pt, p2_pt)],
                })
            except Exception:
                continue

        elif tag in ("polyline", "polygon"):
            pts_str = elem.attrib.get("points", "")
            nums = [float(v) for v in re.split(r"[\s,]+", pts_str.strip()) if v]
            if len(nums) >= 4:
                pts_pt = [to_pt(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
                xs = [p[0] for p in pts_pt]
                ys = [p[1] for p in pts_pt]
                items = [("l", pts_pt[i], pts_pt[i + 1]) for i in range(len(pts_pt) - 1)]
                drawings.append({
                    "type": "polyline",
                    "rect": Rect(min(xs), min(ys), max(xs), max(ys)),
                    "width": stroke_w,
                    "items": items,
                    "points": pts_pt,
                })

        elif tag == "path":
            d_str = elem.attrib.get("d", "")
            if not d_str:
                continue
            tokens = _PATH_TOKEN_RE.findall(d_str)
            coords: list[tuple[float, float]] = []
            curr_cmd = ""
            curr_x = 0.0
            curr_y = 0.0
            idx = 0
            while idx < len(tokens):
                tok = tokens[idx]
                if tok.isalpha():
                    curr_cmd = tok
                    idx += 1
                    continue
                if curr_cmd in ("M", "L", "C", "S", "Q"):
                    try:
                        curr_x = float(tok)
                        curr_y = float(tokens[idx + 1])
                        coords.append(to_pt(curr_x, curr_y))
                        idx += 2
                        continue
                    except Exception:
                        pass
                elif curr_cmd in ("m", "l", "c", "s", "q"):
                    try:
                        curr_x += float(tok)
                        curr_y += float(tokens[idx + 1])
                        coords.append(to_pt(curr_x, curr_y))
                        idx += 2
                        continue
                    except Exception:
                        pass
                elif curr_cmd == "H":
                    try:
                        curr_x = float(tok)
                        coords.append(to_pt(curr_x, curr_y))
                        idx += 1
                        continue
                    except Exception:
                        pass
                elif curr_cmd == "h":
                    try:
                        curr_x += float(tok)
                        coords.append(to_pt(curr_x, curr_y))
                        idx += 1
                        continue
                    except Exception:
                        pass
                elif curr_cmd == "V":
                    try:
                        curr_y = float(tok)
                        coords.append(to_pt(curr_x, curr_y))
                        idx += 1
                        continue
                    except Exception:
                        pass
                elif curr_cmd == "v":
                    try:
                        curr_y += float(tok)
                        coords.append(to_pt(curr_x, curr_y))
                        idx += 1
                        continue
                    except Exception:
                        pass
                idx += 1

            if coords:
                xs = [p[0] for p in coords]
                ys = [p[1] for p in coords]
                items = [("l", coords[i], coords[i + 1]) for i in range(len(coords) - 1)]
                drawings.append({
                    "type": "path",
                    "rect": Rect(min(xs), min(ys), max(xs), max(ys)),
                    "width": stroke_w,
                    "items": items,
                    "points": coords,
                })

    return sheet_w_pt, sheet_h_pt, drawings, ocg_info


def _get_coord(p: Any) -> tuple[float, float]:
    """Lấy toạ độ (x, y) từ Point hoặc tuple/list."""
    if hasattr(p, "x") and hasattr(p, "y"):
        return float(p.x), float(p.y)
    return float(p[0]), float(p[1])


def _analyze_drawings_for_ponts(
    drawings: list[dict],
    sheet_w_pt: float,
    sheet_h_pt: float,
) -> tuple[dict[str, _CornerMarkCandidate], list[_GuideCandidate]]:
    """Phân tích danh sách drawing vector, phân loại dấu ốc 4 góc và thanh canh giấy."""
    sheet_w_mm = sheet_w_pt * PTS_TO_MM
    sheet_h_mm = sheet_h_pt * PTS_TO_MM

    # 1. Lọc bỏ các khối knockout nền trắng lớn (>= 15x15mm fill)
    filtered: list[dict] = []
    for d in drawings:
        r = d.get("rect")
        if not r:
            continue
        w_mm = abs(r.x1 - r.x0) * PTS_TO_MM
        h_mm = abs(r.y1 - r.y0) * PTS_TO_MM
        if d.get("type") == "f" and w_mm >= 15.0 and h_mm >= 15.0:
            continue
        filtered.append(d)

    # 2. Tự động ghép các cặp đoạn thẳng vuông góc chạm nhau ở góc tờ in thành ốc chữ L
    # (Hỗ trợ file từ Corel/AutoCAD xuất các cạnh của ốc L thành 2 line độc lập)
    unpaired_lines: list[tuple[int, dict, tuple]] = []
    paired_l_drawings: list[dict] = []
    used_line_indices: set[int] = set()

    min_mark_pt = 1.5 * MM_TO_PTS
    max_mark_pt = 25.0 * MM_TO_PTS

    for i, d in enumerate(filtered):
        items = d.get("items", [])
        line_items = [it for it in items if it[0] == "l"]
        if len(line_items) == 1 and d.get("type") in ("line", "s", "path"):
            unpaired_lines.append((i, d, line_items[0]))

    for idx_a, (i_a, d_a, l_a) in enumerate(unpaired_lines):
        if i_a in used_line_indices:
            continue
        p1_a, p2_a = _get_coord(l_a[1]), _get_coord(l_a[2])
        len_a = math.hypot(p1_a[0] - p2_a[0], p1_a[1] - p2_a[1])
        if len_a < min_mark_pt or len_a > max_mark_pt:
            continue

        for idx_b in range(idx_a + 1, len(unpaired_lines)):
            i_b, d_b, l_b = unpaired_lines[idx_b]
            if i_b in used_line_indices:
                continue
            p1_b, p2_b = _get_coord(l_b[1]), _get_coord(l_b[2])
            len_b = math.hypot(p1_b[0] - p2_b[0], p1_b[1] - p2_b[1])
            if len_b < min_mark_pt or len_b > max_mark_pt:
                continue

            if abs(len_a - len_b) / max(len_a, len_b) > 0.35:
                continue

            common_pairs = [
                (p1_a, p2_a, p1_b, p2_b),
                (p1_a, p2_a, p2_b, p1_b),
                (p2_a, p1_a, p1_b, p2_b),
                (p2_a, p1_a, p2_b, p1_b),
            ]
            for start_a, end_a, start_b, end_b in common_pairs:
                if math.hypot(end_a[0] - start_b[0], end_a[1] - start_b[1]) <= 2.5:
                    v_a = (start_a[0] - end_a[0], start_a[1] - end_a[1])
                    v_b = (end_b[0] - start_b[0], end_b[1] - start_b[1])
                    dot = v_a[0] * v_b[0] + v_a[1] * v_b[1]
                    cos_angle = dot / (len_a * len_b) if (len_a * len_b) > 0 else 1.0
                    if abs(cos_angle) <= 0.25:
                        xs = [start_a[0], end_a[0], end_b[0]]
                        ys = [start_a[1], end_a[1], end_b[1]]
                        paired_l_drawings.append({
                            "type": "polyline",
                            "rect": Rect(min(xs), min(ys), max(xs), max(ys)),
                            "width": max(d_a.get("width", 0.5 * MM_TO_PTS), d_b.get("width", 0.5 * MM_TO_PTS)),
                            "items": [("l", start_a, end_a), ("l", start_b, end_b)],
                            "points": [start_a, end_a, end_b],
                        })
                        used_line_indices.add(i_a)
                        used_line_indices.add(i_b)
                        break
            if i_a in used_line_indices:
                break

    drawings_for_marks = [d for i, d in enumerate(filtered) if i not in used_line_indices] + paired_l_drawings

    # Tìm ứng viên dấu ốc ở 4 góc tờ in (vùng biên 35%)
    limit_x_left = sheet_w_pt * 0.35
    limit_x_right = sheet_w_pt * 0.65
    limit_y_top = sheet_h_pt * 0.35
    limit_y_bottom = sheet_h_pt * 0.65

    mark_candidates: list[_CornerMarkCandidate] = []

    for d in drawings_for_marks:
        rect = d.get("rect")
        if not rect:
            continue
        w_pt = abs(rect.x1 - rect.x0)
        h_pt = abs(rect.y1 - rect.y0)
        cx = (rect.x0 + rect.x1) / 2.0
        cy = (rect.y0 + rect.y1) / 2.0

        is_left = cx <= limit_x_left
        is_right = cx >= limit_x_right
        is_top = cy <= limit_y_top
        is_bottom = cy >= limit_y_bottom

        if not ((is_left or is_right) and (is_top or is_bottom)):
            continue

        corner = "TL"
        if is_left and is_top:
            corner = "TL"
        elif is_right and is_top:
            corner = "TR"
        elif is_left and is_bottom:
            corner = "BL"
        elif is_right and is_bottom:
            corner = "BR"

        max_dim = max(w_pt, h_pt)
        min_dim = min(w_pt, h_pt)
        if max_dim < min_mark_pt or max_dim > max_mark_pt:
            continue

        aspect_ratio = min_dim / max_dim if max_dim > 0 else 0.0
        # Ốc định vị phải có tỉ lệ tương đối cân xứng (>= 0.45)
        if aspect_ratio < 0.45:
            continue

        shape_type = "circle"
        vertex = None
        items = d.get("items", [])
        points = d.get("points", [])

        bezier_count = sum(1 for it in items if it[0] == "c")
        is_svg_circle = d.get("type") == "circle"

        if is_svg_circle or bezier_count >= 3 or (aspect_ratio >= 0.85 and bezier_count >= 1):
            shape_type = "circle"
        else:
            line_items = [it for it in items if it[0] == "l"]
            if len(points) == 3:
                p1_c = _get_coord(points[1])
                vertex = p1_c
                shape_type = _classify_l_shape(corner, cx, cy, vertex)
            elif len(line_items) == 2:
                l1, l2 = line_items[0], line_items[1]
                p1_start = _get_coord(l1[1])
                p1_end = _get_coord(l1[2])
                p2_start = _get_coord(l2[1])
                p2_end = _get_coord(l2[2])
                candidates_v = [
                    (p1_end, p2_start),
                    (p1_start, p2_start),
                    (p1_end, p2_end),
                    (p1_start, p2_end),
                ]
                min_dist = float("inf")
                best_vertex = None
                for pt_a, pt_b in candidates_v:
                    dist = math.hypot(pt_a[0] - pt_b[0], pt_a[1] - pt_b[1])
                    if dist < min_dist:
                        min_dist = dist
                        best_vertex = ((pt_a[0] + pt_b[0]) / 2.0, (pt_a[1] + pt_b[1]) / 2.0)
                if best_vertex and min_dist <= 2.5:
                    vertex = best_vertex
                    shape_type = _classify_l_shape(corner, cx, cy, vertex)
                else:
                    shape_type = "l_corner" if aspect_ratio >= 0.7 else "circle"
            else:
                shape_type = "circle" if aspect_ratio >= 0.7 else "l_corner"

        thick_mm = _round2(max(d.get("width", 0.5 * MM_TO_PTS) * PTS_TO_MM, 0.2))

        mark_candidates.append(
            _CornerMarkCandidate(
                rect=rect,
                shape_type=shape_type,
                thickness=thick_mm,
                corner=corner,
                vertex=vertex,
            )
        )

    # Chọn ốc tốt nhất cho mỗi góc (sát mép ngoài nhất)
    best_corner_marks: dict[str, _CornerMarkCandidate] = {}
    for cand in mark_candidates:
        c = cand.corner
        if c not in best_corner_marks:
            best_corner_marks[c] = cand
            continue
        existing = best_corner_marks[c]
        if c == "TL":
            if (cand.rect.x0 + cand.rect.y0) < (existing.rect.x0 + existing.rect.y0):
                best_corner_marks[c] = cand
        elif c == "TR":
            if (sheet_w_pt - cand.rect.x1 + cand.rect.y0) < (sheet_w_pt - existing.rect.x1 + existing.rect.y0):
                best_corner_marks[c] = cand
        elif c == "BL":
            if (cand.rect.x0 + sheet_h_pt - cand.rect.y1) < (existing.rect.x0 + sheet_h_pt - existing.rect.y1):
                best_corner_marks[c] = cand
        elif c == "BR":
            if (sheet_w_pt - cand.rect.x1 + sheet_h_pt - cand.rect.y1) < (sheet_w_pt - existing.rect.x1 + sheet_h_pt - existing.rect.y1):
                best_corner_marks[c] = cand

    # 3. Tìm các thanh canh giấy (Paper guides) gần mép tờ in (trong vòng 50mm từ mép)
    edge_thresh_mm = 50.0
    mark_rects = [m.rect for m in best_corner_marks.values()]

    # Không xét lại các line đã dùng để ghép thành ốc L
    filtered_for_guides = [d for i, d in enumerate(filtered) if i not in used_line_indices]

    raw_guides: list[dict] = []
    for d in filtered_for_guides:
        r = d.get("rect")
        if not r:
            continue
        w_mm = abs(r.x1 - r.x0) * PTS_TO_MM
        h_mm = abs(r.y1 - r.y0) * PTS_TO_MM
        x0_mm = r.x0 * PTS_TO_MM
        y0_mm = r.y0 * PTS_TO_MM
        x1_mm = r.x1 * PTS_TO_MM
        y1_mm = r.y1 * PTS_TO_MM
        cx_mm = (x0_mm + x1_mm) / 2.0
        cy_mm = (y0_mm + y1_mm) / 2.0

        # Bỏ qua nếu trùng hoàn toàn với ốc định vị đã nhận diện
        is_mark = False
        for mr in mark_rects:
            mr_x0 = mr.x0 * PTS_TO_MM
            mr_y0 = mr.y0 * PTS_TO_MM
            mr_w = abs(mr.x1 - mr.x0) * PTS_TO_MM
            mr_h = abs(mr.y1 - mr.y0) * PTS_TO_MM
            if abs(x0_mm - mr_x0) < 1.0 and abs(y0_mm - mr_y0) < 1.0 and abs(w_mm - mr_w) < 1.0 and abs(h_mm - mr_h) < 1.0:
                is_mark = True
                break
        if is_mark:
            continue

        # Kiểm tra nằm sát mép (trong vòng 50mm từ 1 trong 4 mép)
        near_top = cy_mm <= edge_thresh_mm
        near_bottom = cy_mm >= (sheet_h_mm - edge_thresh_mm)
        near_left = cx_mm <= edge_thresh_mm
        near_right = cx_mm >= (sheet_w_mm - edge_thresh_mm)

        if not (near_top or near_bottom or near_left or near_right):
            continue

        # Kiểm tra dạng đường thẳng / vạch canh / nét đứt
        # Mảnh: chiều dài phải lớn hơn chiều dày ít nhất 1.5 lần, độ dày nét <= 2.0mm
        is_slender = max(w_mm, h_mm) / max(min(w_mm, h_mm), 0.05) >= 1.5
        is_horiz = h_mm <= 2.0 and w_mm >= 0.3 and is_slender
        is_vert = w_mm <= 2.0 and h_mm >= 0.3 and is_slender

        if not (is_horiz or is_vert):
            continue

        thick_mm = _round2(max(d.get("width", 0.5 * MM_TO_PTS) * PTS_TO_MM, 0.2))
        raw_guides.append({
            "is_horiz": is_horiz,
            "x0": x0_mm,
            "y0": y0_mm,
            "x1": x1_mm,
            "y1": y1_mm,
            "w": w_mm,
            "h": h_mm,
            "cx": cx_mm,
            "cy": cy_mm,
            "thick": thick_mm,
        })

    # 4. Gom cụm hoặc giữ riêng từng thanh canh giấy
    clusters: list[list[dict]] = []
    if len(raw_guides) <= 2:
        # Khi có 1 hoặc 2 thanh dẫn (ví dụ 2 vạch định hướng nhỏ của Graphtec), giữ nguyên độc lập từng thanh
        clusters = [[g] for g in raw_guides]
    else:
        # Gom cụm collinear chỉ khi có >= 3 nét đứt liên tiếp thẳng hàng (tạo thành vạch dài ngắt quãng)
        used: set[int] = set()
        for i, g in enumerate(raw_guides):
            if i in used:
                continue
            cluster = [g]
            used.add(i)
            for j, other in enumerate(raw_guides):
                if j in used:
                    continue
                if g["is_horiz"] and other["is_horiz"]:
                    if abs(g["cy"] - other["cy"]) <= 1.2:
                        min_gap = max(0.0, max(g["x0"], other["x0"]) - min(g["x1"], other["x1"]))
                        if min_gap <= 5.0:
                            cluster.append(other)
                            used.add(j)
                elif (not g["is_horiz"]) and (not other["is_horiz"]):
                    if abs(g["cx"] - other["cx"]) <= 1.2:
                        min_gap = max(0.0, max(g["y0"], other["y0"]) - min(g["y1"], other["y1"]))
                        if min_gap <= 5.0:
                            cluster.append(other)
                            used.add(j)
            clusters.append(cluster)

    # 5. Tính toán thông số cho từng thanh canh giấy
    guide_candidates: list[_GuideCandidate] = []
    for cl in clusters:
        is_horiz = cl[0]["is_horiz"]
        thick = max(c["thick"] for c in cl)
        min_x = min(c["x0"] for c in cl)
        max_x = max(c["x1"] for c in cl)
        min_y = min(c["y0"] for c in cl)
        max_y = max(c["y1"] for c in cl)
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0

        if cy >= sheet_h_mm / 2.0:
            if cx < sheet_w_mm / 2.0:
                pos = "BL"
                off_x = _round1(min_x)
                off_y = _round1(sheet_h_mm - cy)
            else:
                pos = "BR"
                off_x = _round1(sheet_w_mm - max_x)
                off_y = _round1(sheet_h_mm - cy)
        else:
            if cx < sheet_w_mm / 2.0:
                pos = "TL"
                off_x = _round1(min_x)
                off_y = _round1(cy)
            else:
                pos = "TR"
                off_x = _round1(sheet_w_mm - max_x)
                off_y = _round1(cy)

        length_mm = _round1(max_x - min_x if is_horiz else max_y - min_y)

        guide_candidates.append(
            _GuideCandidate(
                pos=pos,
                length_mm=max(length_mm, 0.1),
                thickness_mm=thick,
                off_x_mm=max(off_x, 0.0),
                off_y_mm=max(off_y, 0.0),
            )
        )

    # Sắp xếp các thanh dẫn: ưu tiên theo góc neo, sau đó theo khoảng cách mép
    guide_candidates.sort(key=lambda g: (g.pos, g.off_x_mm, g.off_y_mm))

    return best_corner_marks, guide_candidates


def inspect_pont_template(file_path: str, filename: str | None = None) -> dict[str, Any]:
    """Phân tích file mẫu PDF hoặc SVG và trích xuất cấu hình boong định vị hoàn chỉnh.

    Trả về dict sẵn sàng đổ vào PontConfig của frontend:
    - success: bool
    - suggestedName: str
    - sheet: { widthMm, heightMm }
    - detected: chi tiết các dấu ốc đã tìm thấy
    - config: PontConfig hợp lệ
    - message: thông báo thân thiện
    """
    fn = (filename or os.path.basename(file_path)).lower()
    is_svg = fn.endswith(".svg")
    is_pdf = fn.endswith(".pdf")

    if not (is_svg or is_pdf):
        raise ValueError("Chỉ hỗ trợ file mẫu định dạng PDF (.pdf) hoặc SVG (.svg).")

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Không tìm thấy file: {file_path}")

    if is_pdf:
        sheet_w_pt, sheet_h_pt, drawings, ocg_info = _inspect_pdf(file_path)
    else:
        sheet_w_pt, sheet_h_pt, drawings, ocg_info = _inspect_svg(file_path)

    sheet_w_mm = _round1(sheet_w_pt * PTS_TO_MM)
    sheet_h_mm = _round1(sheet_h_pt * PTS_TO_MM)

    # Phân tích các drawing vector để tìm dấu ốc và thanh canh giấy
    best_marks, guides = _analyze_drawings_for_ponts(drawings, sheet_w_pt, sheet_h_pt)

    # Cấu hình mặc định
    cfg: dict[str, Any] = {
        "shape": "circle",
        "size": 5.0,
        "thickness": 0.5,
        "marginTop": 7.0,
        "marginBottom": 7.0,
        "marginLeft": 7.0,
        "marginRight": 7.0,
        "isGraphtec": ocg_info["isGraphtec"],
        "layerInfoName": ocg_info["layerInfoName"],
        "layerName": ocg_info["layerName"],
        "groupName": ocg_info["groupName"],
        "itemName": ocg_info["itemName"],
        "guide1Enabled": False,
        "guide1Pos": "BL",
        "guide1Length": 20.0,
        "guide1Thickness": 0.5,
        "guide1OffX": 0.0,
        "guide1OffY": 0.0,
        "guide2Enabled": False,
        "guide2Pos": "BR",
        "guide2Length": 20.0,
        "guide2Thickness": 0.5,
        "guide2OffX": 0.0,
        "guide2OffY": 0.0,
        "disableCollision": False,
    }

    marks_found = len(best_marks)
    detected_details: dict[str, Any] = {
        "marksFound": marks_found,
        "corners": list(best_marks.keys()),
        "guidesFound": len(guides),
    }

    if marks_found > 0:
        # Gom kích thước và hình dạng phổ biến nhất
        shapes = [m.shape_type for m in best_marks.values()]
        sizes = [m.size_pt * PTS_TO_MM for m in best_marks.values()]
        thicks = [m.thickness for m in best_marks.values()]

        # Lấy hình dạng xuất hiện nhiều nhất
        dominant_shape = max(set(shapes), key=shapes.count)
        avg_size = _round1(sum(sizes) / len(sizes))
        avg_thick = _round2(sum(thicks) / len(thicks))

        cfg["shape"] = dominant_shape
        cfg["size"] = max(avg_size, 1.0)
        cfg["thickness"] = max(avg_thick, 0.1)

        # Tính 4 lề khoảng cách từ các góc tương ứng
        m_left_list = []
        m_right_list = []
        m_top_list = []
        m_bottom_list = []

        if "TL" in best_marks:
            tl = best_marks["TL"]
            m_left_list.append(tl.rect.x0 * PTS_TO_MM)
            m_top_list.append(tl.rect.y0 * PTS_TO_MM)

        if "TR" in best_marks:
            tr = best_marks["TR"]
            m_right_list.append((sheet_w_pt - tr.rect.x1) * PTS_TO_MM)
            m_top_list.append(tr.rect.y0 * PTS_TO_MM)

        if "BL" in best_marks:
            bl = best_marks["BL"]
            m_left_list.append(bl.rect.x0 * PTS_TO_MM)
            m_bottom_list.append((sheet_h_pt - bl.rect.y1) * PTS_TO_MM)

        if "BR" in best_marks:
            br = best_marks["BR"]
            m_right_list.append((sheet_w_pt - br.rect.x1) * PTS_TO_MM)
            m_bottom_list.append((sheet_h_pt - br.rect.y1) * PTS_TO_MM)

        if m_left_list:
            cfg["marginLeft"] = max(_round1(sum(m_left_list) / len(m_left_list)), 0.0)
        if m_right_list:
            cfg["marginRight"] = max(_round1(sum(m_right_list) / len(m_right_list)), 0.0)
        if m_top_list:
            cfg["marginTop"] = max(_round1(sum(m_top_list) / len(m_top_list)), 0.0)
        if m_bottom_list:
            cfg["marginBottom"] = max(_round1(sum(m_bottom_list) / len(m_bottom_list)), 0.0)

        detected_details.update({
            "shape": dominant_shape,
            "size": cfg["size"],
            "thickness": cfg["thickness"],
            "marginLeft": cfg["marginLeft"],
            "marginRight": cfg["marginRight"],
            "marginTop": cfg["marginTop"],
            "marginBottom": cfg["marginBottom"],
        })

    # Cập nhật thanh canh giấy (guides)
    if guides:
        g1 = guides[0]
        cfg["guide1Enabled"] = True
        cfg["guide1Pos"] = g1.pos
        cfg["guide1Length"] = g1.length_mm
        cfg["guide1Thickness"] = g1.thickness_mm
        cfg["guide1OffX"] = g1.off_x_mm
        cfg["guide1OffY"] = g1.off_y_mm

        if len(guides) > 1:
            g2 = guides[1]
            cfg["guide2Enabled"] = True
            cfg["guide2Pos"] = g2.pos
            cfg["guide2Length"] = g2.length_mm
            cfg["guide2Thickness"] = g2.thickness_mm
            cfg["guide2OffX"] = g2.off_x_mm
            cfg["guide2OffY"] = g2.off_y_mm

    # Tạo tên gợi ý cho preset
    base_name = os.path.splitext(filename or os.path.basename(file_path))[0]
    clean_name = re.sub(r"^[_\-\s]+|[_\-\s]+$", "", base_name)
    shape_vn = {
        "circle": "Ốc tròn",
        "l_corner": "Ốc chữ L",
        "l_inverted": "Ốc L ngược",
    }.get(cfg["shape"], "Boong")

    suggested_name = f"{shape_vn} {cfg['size']}mm ({clean_name})"

    parts_msg = []
    if marks_found >= 3:
        parts_msg.append(f"Đã nhận diện {marks_found} ốc định vị {shape_vn.lower()} {cfg['size']}mm, lề {cfg['marginLeft']}x{cfg['marginTop']}mm")
    elif marks_found > 0:
        parts_msg.append(f"Tìm thấy {marks_found} ốc định vị ở góc")
    else:
        parts_msg.append("Không phát hiện dấu ốc định vị ở 4 góc")

    if guides:
        guide_descs = [f"{g.pos} {g.length_mm}mm" for g in guides[:2]]
        parts_msg.append(f"kèm {len(guides)} thanh canh giấy ({', '.join(guide_descs)})")

    msg = " ".join(parts_msg) + " từ file mẫu."

    return {
        "success": True,
        "filename": filename or os.path.basename(file_path),
        "suggestedName": suggested_name,
        "sheet": {
            "widthMm": sheet_w_mm,
            "heightMm": sheet_h_mm,
        },
        "detected": detected_details,
        "config": cfg,
        "message": msg,
    }
