"""Render SVG (tập con an toàn) → PNG, không thêm dependency mới.

Vì sao viết thay vì cài cairosvg/svglib: hai thư viện đó là LGPL, và chính sách
dự án ưu tiên MIT/Apache cho thành phần có thể lọt vào bản phát hành. Ở đây chỉ
cần rasterize đúng **tập con SVG mà PrynX tự sinh** (path + fill), nên đường
SVG → PDF (reportlab, BSD) → raster (pypdfium2/PDFium, BSD) là đủ, và cả hai đã
được pin trong `backend/requirements.txt`.

Giới hạn phải nói rõ: bộ này chứng minh hình học của tập con ta emit, **không**
chứng minh "mở được trong browser/Inkscape". Việc đó vẫn phải kiểm tay.

Parser cố tình từ chối `script`, `foreignObject`, `image`, `use`, URL ngoài và
DOCTYPE — cùng chính sách an toàn SVG ở mục 10 báo cáo khảo sát, để công cụ đo
không trở thành đường nạp nội dung hoạt động.

Dùng như thư viện:

    from svg_raster import render_svg_to_png
    img = render_svg_to_png(svg_bytes, target_px=1200)   # PIL.Image RGBA

Hoặc chạy trực tiếp (kèm self-test hình học):

    backend\\venv\\Scripts\\python.exe tools\\logo_rebuild_spike\\svg_raster.py --self-test
"""

from __future__ import annotations

import io
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass

from PIL import Image
from reportlab.pdfgen import canvas as rl_canvas

MM_TO_PT = 72.0 / 25.4
SVG_NS = "http://www.w3.org/2000/svg"

# Thẻ bị từ chối thẳng: có thể mang nội dung hoạt động hoặc tham chiếu ngoài.
FORBIDDEN_TAGS = frozenset(
    {"script", "foreignObject", "image", "use", "iframe", "animate", "set", "style"}
)
ALLOWED_TAGS = frozenset(
    {"svg", "g", "path", "rect", "circle", "ellipse", "polygon", "polyline",
     "title", "desc", "metadata", "defs"}
)

_NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
_CMD = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]")
_LEN = re.compile(r"^\s*([-+]?[\d.eE+-]+)\s*(mm|cm|in|pt|px|)\s*$")


class SvgSubsetError(ValueError):
    """SVG dùng tính năng ngoài tập con hỗ trợ, hoặc chứa nội dung bị từ chối."""


@dataclass
class SvgDoc:
    """Tài liệu SVG đã phân tích: hình học phẳng + kích thước vật lý."""

    width_mm: float
    height_mm: float
    view_box: tuple[float, float, float, float]
    # Mỗi shape: (danh sách subpath, màu fill RGB 0..1 hoặc None, fill_opacity, even_odd)
    # Subpath: list các đoạn ('L', x, y) hoặc ('C', x1,y1,x2,y2,x3,y3), kèm điểm bắt đầu.
    shapes: list[tuple[list["SubPath"], tuple[float, float, float] | None, float, bool]]

    @property
    def node_count(self) -> int:
        return sum(len(sp.segments) for shape in self.shapes for sp in shape[0])

    @property
    def path_count(self) -> int:
        return len(self.shapes)


@dataclass
class SubPath:
    start: tuple[float, float]
    segments: list[tuple]           # ('L', x, y) | ('C', x1,y1,x2,y2,x,y)
    closed: bool


# ── Phân tích ────────────────────────────────────────────────────────────────

def parse_svg(data: bytes | str) -> SvgDoc:
    raw = data.decode("utf-8", errors="strict") if isinstance(data, bytes) else data
    if "<!DOCTYPE" in raw or "<!ENTITY" in raw:
        raise SvgSubsetError("SVG chứa DOCTYPE/ENTITY — từ chối (rủi ro XXE)")
    root = ET.fromstring(raw)
    if _local(root.tag) != "svg":
        raise SvgSubsetError(f"Thẻ gốc phải là <svg>, gặp <{_local(root.tag)}>")

    view_box = _parse_view_box(root)
    width_mm, height_mm = _parse_size(root, view_box)

    shapes: list[tuple[list[SubPath], tuple[float, float, float] | None, float, bool]] = []
    _walk(root, shapes, inherited_fill="#000000", inherited_opacity=1.0)
    return SvgDoc(width_mm, height_mm, view_box, shapes)


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _parse_view_box(root: ET.Element) -> tuple[float, float, float, float]:
    vb = root.get("viewBox")
    if vb:
        parts = [float(v) for v in _NUM.findall(vb)]
        if len(parts) != 4:
            raise SvgSubsetError(f"viewBox không hợp lệ: {vb!r}")
        if parts[2] <= 0 or parts[3] <= 0:
            raise SvgSubsetError(f"viewBox có chiều <= 0: {vb!r}")
        return (parts[0], parts[1], parts[2], parts[3])
    # Không có viewBox: suy từ width/height thô (VTracer luôn emit theo px).
    w = _length_px(root.get("width"))
    h = _length_px(root.get("height"))
    if w is None or h is None:
        raise SvgSubsetError("SVG thiếu cả viewBox và width/height")
    return (0.0, 0.0, w, h)


def _parse_size(root: ET.Element, vb: tuple[float, float, float, float]) -> tuple[float, float]:
    """Kích thước vật lý mm. Không khai đơn vị ⇒ coi 1 đơn vị viewBox = 1 px @96dpi."""
    w_mm = _length_mm(root.get("width"))
    h_mm = _length_mm(root.get("height"))
    if w_mm is not None and h_mm is not None:
        return w_mm, h_mm
    return vb[2] * 25.4 / 96.0, vb[3] * 25.4 / 96.0


def _length_mm(value: str | None) -> float | None:
    if not value:
        return None
    m = _LEN.match(value)
    if not m:
        return None
    num, unit = float(m.group(1)), m.group(2)
    factor = {"mm": 1.0, "cm": 10.0, "in": 25.4, "pt": 25.4 / 72.0,
              "px": 25.4 / 96.0, "": 25.4 / 96.0}[unit]
    return num * factor


def _length_px(value: str | None) -> float | None:
    mm = _length_mm(value)
    return None if mm is None else mm * 96.0 / 25.4


def _walk(node: ET.Element, out: list, inherited_fill: str | None,
          inherited_opacity: float) -> None:
    for child in node:
        tag = _local(child.tag)
        if tag in FORBIDDEN_TAGS:
            raise SvgSubsetError(f"SVG chứa <{tag}> — từ chối theo chính sách an toàn")
        if tag not in ALLOWED_TAGS:
            raise SvgSubsetError(f"Thẻ <{tag}> ngoài tập con hỗ trợ")
        if child.get("transform"):
            raise SvgSubsetError(
                "Thuộc tính transform chưa hỗ trợ — hình học phải phẳng để đo được "
                "trực tiếp. Chuẩn hoá SVG trước khi đo."
            )
        for attr, val in child.attrib.items():
            if val and ("url(" in val or val.strip().startswith(("http://", "https://"))):
                raise SvgSubsetError(f"Thuộc tính {attr} tham chiếu ngoài — từ chối")

        fill = child.get("fill", inherited_fill)
        opacity = float(child.get("fill-opacity", inherited_opacity) or 1.0)
        even_odd = (child.get("fill-rule", "nonzero") or "nonzero").strip() == "evenodd"

        if tag == "g" or tag == "defs":
            _walk(child, out, fill, opacity)
            continue
        if tag in ("title", "desc", "metadata"):
            continue

        subpaths = _shape_to_subpaths(tag, child)
        if not subpaths:
            continue
        out.append((subpaths, _parse_color(fill), opacity, even_odd))


def _parse_color(value: str | None) -> tuple[float, float, float] | None:
    if value is None:
        return (0.0, 0.0, 0.0)
    v = value.strip().lower()
    if v in ("none", "transparent"):
        return None
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]
        raise SvgSubsetError(f"Mã màu không hợp lệ: {value!r}")
    if v.startswith("rgb("):
        nums = [float(n) for n in _NUM.findall(v)]
        if len(nums) < 3:
            raise SvgSubsetError(f"rgb() không hợp lệ: {value!r}")
        return tuple(min(255.0, max(0.0, n)) / 255.0 for n in nums[:3])  # type: ignore[return-value]
    named = {"black": (0.0, 0.0, 0.0), "white": (1.0, 1.0, 1.0)}
    if v in named:
        return named[v]
    raise SvgSubsetError(f"Màu {value!r} ngoài tập con hỗ trợ (dùng #rrggbb)")


def _shape_to_subpaths(tag: str, el: ET.Element) -> list[SubPath]:
    if tag == "path":
        return parse_path_d(el.get("d", ""))
    if tag == "rect":
        x, y = float(el.get("x", 0)), float(el.get("y", 0))
        w, h = float(el.get("width", 0)), float(el.get("height", 0))
        if w <= 0 or h <= 0:
            return []
        if el.get("rx") or el.get("ry"):
            raise SvgSubsetError("rect bo góc chưa hỗ trợ — chuyển sang path")
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        return [SubPath(pts[0], [("L", *p) for p in pts[1:]], True)]
    if tag in ("circle", "ellipse"):
        cx, cy = float(el.get("cx", 0)), float(el.get("cy", 0))
        if tag == "circle":
            rx = ry = float(el.get("r", 0))
        else:
            rx, ry = float(el.get("rx", 0)), float(el.get("ry", 0))
        if rx <= 0 or ry <= 0:
            return []
        return [_ellipse_subpath(cx, cy, rx, ry)]
    if tag in ("polygon", "polyline"):
        nums = [float(n) for n in _NUM.findall(el.get("points", ""))]
        pts = list(zip(nums[0::2], nums[1::2]))
        if len(pts) < 2:
            return []
        return [SubPath(pts[0], [("L", *p) for p in pts[1:]], tag == "polygon")]
    return []


def _ellipse_subpath(cx: float, cy: float, rx: float, ry: float) -> SubPath:
    """Ellipse bằng 4 cung Bézier bậc 3 (sai số ~0.027% bán kính)."""
    k = 0.5522847498307936
    return SubPath(
        (cx + rx, cy),
        [
            ("C", cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
            ("C", cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
            ("C", cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
            ("C", cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
        ],
        True,
    )


def parse_path_d(d: str) -> list[SubPath]:
    """Phân tích thuộc tính `d`. Hỗ trợ M/L/H/V/C/S/Q/T/Z (cả tương đối)."""
    tokens = _tokenize(d)
    subpaths: list[SubPath] = []
    cur: SubPath | None = None
    cx = cy = 0.0            # điểm hiện tại
    sx = sy = 0.0            # điểm bắt đầu subpath
    prev_c2: tuple[float, float] | None = None   # control point cuối của C/S
    prev_q: tuple[float, float] | None = None    # control point cuối của Q/T
    i = 0
    cmd = ""
    while i < len(tokens):
        tok = tokens[i]
        if isinstance(tok, str):
            cmd = tok
            i += 1
            if cmd in "Zz":
                if cur is not None:
                    cur.closed = True
                    subpaths.append(cur)
                    cur = None
                cx, cy = sx, sy
                prev_c2 = prev_q = None
                continue
            if cmd in "Aa":
                raise SvgSubsetError(
                    "Lệnh cung tròn A/a chưa hỗ trợ — VTracer không sinh, nếu gặp "
                    "thì nguồn SVG khác kỳ vọng, cần kiểm lại thay vì bỏ qua"
                )
        if not cmd:
            raise SvgSubsetError(f"Chuỗi path bắt đầu bằng số: {d[:40]!r}")

        rel = cmd.islower()
        up = cmd.upper()
        need = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2}[up]
        args = tokens[i:i + need]
        if len(args) < need or any(isinstance(a, str) for a in args):
            raise SvgSubsetError(f"Lệnh {cmd} thiếu tham số trong {d[:60]!r}")
        args = [float(a) for a in args]  # type: ignore[arg-type]
        i += need

        if up == "M":
            x, y = (cx + args[0], cy + args[1]) if rel else (args[0], args[1])
            if cur is not None:
                subpaths.append(cur)
            cur = SubPath((x, y), [], False)
            cx, cy = sx, sy = x, y
            cmd = "l" if rel else "L"   # M kéo theo ⇒ thành L
            prev_c2 = prev_q = None
            continue

        if cur is None:
            raise SvgSubsetError(f"Lệnh {cmd} trước khi có moveto trong {d[:60]!r}")

        if up == "L":
            x, y = (cx + args[0], cy + args[1]) if rel else (args[0], args[1])
            cur.segments.append(("L", x, y))
            prev_c2 = prev_q = None
        elif up == "H":
            x = cx + args[0] if rel else args[0]
            y = cy
            cur.segments.append(("L", x, y))
            prev_c2 = prev_q = None
        elif up == "V":
            x = cx
            y = cy + args[0] if rel else args[0]
            cur.segments.append(("L", x, y))
            prev_c2 = prev_q = None
        elif up == "C":
            pts = _abs_pairs(args, cx, cy, rel)
            cur.segments.append(("C", *pts[0], *pts[1], *pts[2]))
            prev_c2, prev_q = pts[1], None
            x, y = pts[2]
        elif up == "S":
            pts = _abs_pairs(args, cx, cy, rel)
            c1 = (2 * cx - prev_c2[0], 2 * cy - prev_c2[1]) if prev_c2 else (cx, cy)
            cur.segments.append(("C", *c1, *pts[0], *pts[1]))
            prev_c2, prev_q = pts[0], None
            x, y = pts[1]
        elif up == "Q":
            pts = _abs_pairs(args, cx, cy, rel)
            cur.segments.append(("C", *_quad_to_cubic((cx, cy), pts[0], pts[1])))
            prev_q, prev_c2 = pts[0], None
            x, y = pts[1]
        else:  # T
            pts = _abs_pairs(args, cx, cy, rel)
            q = (2 * cx - prev_q[0], 2 * cy - prev_q[1]) if prev_q else (cx, cy)
            cur.segments.append(("C", *_quad_to_cubic((cx, cy), q, pts[0])))
            prev_q, prev_c2 = q, None
            x, y = pts[0]

        cx, cy = x, y

    if cur is not None:
        subpaths.append(cur)
    return [sp for sp in subpaths if sp.segments]


def _abs_pairs(args: list[float], cx: float, cy: float,
               rel: bool) -> list[tuple[float, float]]:
    pairs = list(zip(args[0::2], args[1::2]))
    return [(cx + x, cy + y) for x, y in pairs] if rel else pairs


def _quad_to_cubic(p0, q, p2) -> tuple[float, ...]:
    c1 = (p0[0] + 2.0 / 3.0 * (q[0] - p0[0]), p0[1] + 2.0 / 3.0 * (q[1] - p0[1]))
    c2 = (p2[0] + 2.0 / 3.0 * (q[0] - p2[0]), p2[1] + 2.0 / 3.0 * (q[1] - p2[1]))
    return (*c1, *c2, *p2)


def _tokenize(d: str) -> list:
    out: list = []
    pos = 0
    while pos < len(d):
        ch = d[pos]
        if ch.isspace() or ch == ",":
            pos += 1
            continue
        if _CMD.match(ch):
            out.append(ch)
            pos += 1
            continue
        m = _NUM.match(d, pos)
        if not m:
            raise SvgSubsetError(f"Ký tự lạ trong path tại vị trí {pos}: {d[pos:pos + 12]!r}")
        out.append(float(m.group()))
        pos = m.end()
    return out


# ── Kết xuất ─────────────────────────────────────────────────────────────────

_TRANSFORM_RE = re.compile(r"(matrix|translate|scale|rotate)\s*\(([^)]*)\)")

# Affine biểu diễn như SVG: (a, b, c, d, e, f)
#   x' = a·x + c·y + e
#   y' = b·x + d·y + f
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _compose(m1: tuple, m2: tuple) -> tuple:
    """m1 ∘ m2 — áp m2 trước, rồi m1 (đúng thứ tự lồng nhau của SVG)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _apply(m: tuple, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def parse_transform(value: str) -> tuple:
    """Đọc thuộc tính `transform` thành một affine đã gộp."""
    import math

    out = IDENTITY
    found = False
    for kind, raw in _TRANSFORM_RE.findall(value or ""):
        found = True
        nums = [float(n) for n in _NUM.findall(raw)]
        if kind == "matrix":
            if len(nums) != 6:
                raise SvgSubsetError(f"matrix() cần 6 số, gặp {len(nums)}")
            m = tuple(nums)
        elif kind == "translate":
            tx = nums[0] if nums else 0.0
            ty = nums[1] if len(nums) > 1 else 0.0
            m = (1.0, 0.0, 0.0, 1.0, tx, ty)
        elif kind == "scale":
            sx = nums[0] if nums else 1.0
            sy = nums[1] if len(nums) > 1 else sx
            m = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        else:  # rotate
            ang = math.radians(nums[0] if nums else 0.0)
            cos_a, sin_a = math.cos(ang), math.sin(ang)
            m = (cos_a, sin_a, -sin_a, cos_a, 0.0, 0.0)
            if len(nums) >= 3:  # rotate(a, cx, cy)
                cx, cy = nums[1], nums[2]
                m = _compose((1.0, 0.0, 0.0, 1.0, cx, cy),
                             _compose(m, (1.0, 0.0, 0.0, 1.0, -cx, -cy)))
        out = _compose(out, m)
    if not found and (value or "").strip():
        raise SvgSubsetError(f"transform ngoài tập con hỗ trợ: {value!r}")
    return out


def normalize_svg(data: bytes | str) -> str:
    """Làm phẳng SVG: gộp `transform` vào toạ độ, mọi shape thành `<path>` tuyệt đối.

    Vì sao cần: VTracer 0.6.x gắn `transform="translate(x,y)"` lên **từng path**.
    Renderer đo cố tình từ chối `transform` để hình học luôn phẳng và so được trực
    tiếp — nên phải chuẩn hoá trước, không phải nới lỏng renderer. Bước này cũng là
    thứ sản phẩm sẽ cần: `LogoDocument` chỉ nhận subset path/fill, không nhận SVG
    thô làm nguồn chân lý.

    Đầu ra bảo đảm `parse_svg()` đọc được.
    """
    raw = data.decode("utf-8", errors="strict") if isinstance(data, bytes) else data
    if "<!DOCTYPE" in raw or "<!ENTITY" in raw:
        raise SvgSubsetError("SVG chứa DOCTYPE/ENTITY — từ chối (rủi ro XXE)")
    root = ET.fromstring(raw)
    if _local(root.tag) != "svg":
        raise SvgSubsetError(f"Thẻ gốc phải là <svg>, gặp <{_local(root.tag)}>")

    vb = _parse_view_box(root)
    width_attr = root.get("width")
    height_attr = root.get("height")

    parts: list[str] = []

    def walk(node: ET.Element, matrix: tuple, fill: str | None,
             opacity: float, fill_rule: str) -> None:
        for child in node:
            tag = _local(child.tag)
            if tag in FORBIDDEN_TAGS:
                raise SvgSubsetError(f"SVG chứa <{tag}> — từ chối theo chính sách an toàn")
            if tag not in ALLOWED_TAGS:
                raise SvgSubsetError(f"Thẻ <{tag}> ngoài tập con hỗ trợ")
            for attr, val in child.attrib.items():
                if val and ("url(" in val or val.strip().startswith(("http://", "https://"))):
                    raise SvgSubsetError(f"Thuộc tính {attr} tham chiếu ngoài — từ chối")

            local_m = matrix
            if child.get("transform"):
                local_m = _compose(matrix, parse_transform(child.get("transform", "")))
            child_fill = child.get("fill", fill)
            child_op = float(child.get("fill-opacity", opacity) or 1.0)
            child_rule = (child.get("fill-rule", fill_rule) or fill_rule).strip()

            if tag in ("g", "defs"):
                walk(child, local_m, child_fill, child_op, child_rule)
                continue
            if tag in ("title", "desc", "metadata"):
                continue

            subpaths = _shape_to_subpaths(tag, child)
            if not subpaths:
                continue
            # Xác nhận màu hợp lệ ngay ở đây để lỗi lộ ra sớm, đúng chỗ.
            if _parse_color(child_fill) is None:
                continue
            d = " ".join(_subpath_to_d(sp, local_m) for sp in subpaths)
            attrs = [f'd="{d}"', f'fill="{(child_fill or "#000000").strip()}"']
            if child_op < 1.0:
                attrs.append(f'fill-opacity="{child_op:.4f}"')
            if child_rule == "evenodd":
                attrs.append('fill-rule="evenodd"')
            parts.append("<path " + " ".join(attrs) + "/>")

    walk(root, IDENTITY, "#000000", 1.0, "nonzero")

    size = ""
    if width_attr and height_attr:
        size = f' width="{width_attr}" height="{height_attr}"'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg"'
        f'{size} viewBox="{vb[0]:.4f} {vb[1]:.4f} {vb[2]:.4f} {vb[3]:.4f}">'
        + "".join(parts)
        + "</svg>"
    )


def _subpath_to_d(sp: SubPath, m: tuple) -> str:
    x, y = _apply(m, *sp.start)
    d = [f"M {x:.4f} {y:.4f}"]
    for seg in sp.segments:
        if seg[0] == "L":
            px, py = _apply(m, seg[1], seg[2])
            d.append(f"L {px:.4f} {py:.4f}")
        else:
            c1 = _apply(m, seg[1], seg[2])
            c2 = _apply(m, seg[3], seg[4])
            p3 = _apply(m, seg[5], seg[6])
            d.append(f"C {c1[0]:.4f} {c1[1]:.4f} {c2[0]:.4f} {c2[1]:.4f} "
                     f"{p3[0]:.4f} {p3[1]:.4f}")
    if sp.closed:
        d.append("Z")
    return " ".join(d)


def svg_to_pdf(doc: SvgDoc) -> bytes:
    """Dựng PDF 1:1 theo mm. `invariant=1` để cùng đầu vào cho cùng byte đầu ra."""
    from reportlab.pdfgen.canvas import FILL_EVEN_ODD, FILL_NON_ZERO

    w_pt = doc.width_mm * MM_TO_PT
    h_pt = doc.height_mm * MM_TO_PT
    vb_x, vb_y, vb_w, vb_h = doc.view_box
    sx, sy = w_pt / vb_w, h_pt / vb_h

    def tx(x: float, y: float) -> tuple[float, float]:
        # SVG y hướng xuống, PDF y hướng lên ⇒ lật.
        return ((x - vb_x) * sx, h_pt - (y - vb_y) * sy)

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(w_pt, h_pt), invariant=1)
    c.setTitle("logo_rebuild spike raster")
    for subpaths, color, opacity, even_odd in doc.shapes:
        if color is None or opacity <= 0:
            continue
        c.saveState()
        c.setFillColorRGB(*color)
        if opacity < 1.0:
            c.setFillAlpha(opacity)
        p = c.beginPath()
        for sp in subpaths:
            p.moveTo(*tx(*sp.start))
            for seg in sp.segments:
                if seg[0] == "L":
                    p.lineTo(*tx(seg[1], seg[2]))
                else:
                    p.curveTo(*tx(seg[1], seg[2]), *tx(seg[3], seg[4]), *tx(seg[5], seg[6]))
            if sp.closed:
                p.close()
        c.drawPath(p, stroke=0, fill=1,
                   fillMode=FILL_EVEN_ODD if even_odd else FILL_NON_ZERO)
        c.restoreState()
    c.showPage()
    c.save()
    return buf.getvalue()


def render_pdf_to_png(pdf_bytes: bytes, target_px: int,
                      transparent: bool = True) -> Image.Image:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[0]
        scale = target_px / max(page.get_width(), page.get_height())
        fill = (255, 255, 255, 0) if transparent else (255, 255, 255, 255)
        bitmap = page.render(scale=scale, fill_color=fill, draw_annots=False)
        return bitmap.to_pil().convert("RGBA")
    finally:
        doc.close()


def render_svg_to_png(data: bytes | str, target_px: int = 1200,
                      transparent: bool = True) -> Image.Image:
    """SVG → PIL RGBA, cạnh dài bằng `target_px`."""
    return render_pdf_to_png(svg_to_pdf(parse_svg(data)), target_px, transparent)


# ── Self-test ────────────────────────────────────────────────────────────────

def _self_test() -> int:
    """Kiểm bằng hình học biết trước. Không tin bất kỳ số đo nào trước khi qua đây."""
    import numpy as np

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    # 1) Ô vuông chiếm đúng nửa bề rộng ⇒ diện tích tô phải ~25% ảnh.
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" '
        'viewBox="0 0 100 100">'
        '<path d="M 25 25 L 75 25 L 75 75 L 25 75 Z" fill="#ff0000"/></svg>'
    )
    img = render_svg_to_png(svg, target_px=400)
    a = np.asarray(img)
    covered = (a[..., 3] > 128).mean()
    check("diện tích ô vuông 50%×50%", abs(covered - 0.25) < 0.005, f"đo {covered:.4f}")

    # 2) Vị trí: góc trên-trái phải trống, tâm phải đỏ (kiểm cả chiều lật Y).
    check("tâm ảnh có màu đỏ", tuple(a[200, 200][:3]) == (255, 0, 0), str(tuple(a[200, 200][:3])))
    check("góc trên-trái trong suốt", a[10, 10, 3] < 10, f"alpha={a[10, 10, 3]}")

    # 3) Lật Y đúng: hình chỉ ở NỬA TRÊN của SVG phải nằm ở nửa trên ảnh.
    svg_top = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" '
        'viewBox="0 0 100 100"><path d="M 0 0 L 100 0 L 100 20 L 0 20 Z" '
        'fill="#000000"/></svg>'
    )
    at = np.asarray(render_svg_to_png(svg_top, target_px=400))
    top_cov = (at[:100, :, 3] > 128).mean()
    bot_cov = (at[300:, :, 3] > 128).mean()
    check("lật Y đúng chiều", top_cov > 0.75 and bot_cov < 0.01,
          f"trên={top_cov:.3f} dưới={bot_cov:.3f}")

    # 4) Lỗ theo nonzero winding: vành khuyên phải rỗng ở giữa.
    ring = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" '
        'viewBox="0 0 100 100"><path d="M 10 10 L 90 10 L 90 90 L 10 90 Z '
        'M 40 60 L 60 60 L 60 40 L 40 40 Z" fill="#00ff00"/></svg>'
    )
    ar = np.asarray(render_svg_to_png(ring, target_px=400))
    check("lỗ trong path (winding ngược) rỗng", ar[200, 200, 3] < 10,
          f"alpha tâm={ar[200, 200, 3]}")

    # 5) Bézier: hình tròn r=40 trong khung 100 ⇒ diện tích π*0.4² ≈ 0.5027.
    circle = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" '
        'viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#0000ff"/></svg>'
    )
    ac = np.asarray(render_svg_to_png(circle, target_px=400))
    cov = (ac[..., 3] > 128).mean()
    check("diện tích hình tròn r=0.4", abs(cov - 0.5027) < 0.01, f"đo {cov:.4f}")

    # 6) Kích thước vật lý: 180mm × 120mm phải ra tỷ lệ 1.5 và PDF đúng pt.
    doc = parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180mm" height="120mm" '
        'viewBox="0 0 1800 1200"><path d="M 0 0 L 10 0 L 10 10 Z" fill="#000"/></svg>'
    )
    check("đọc kích thước mm", abs(doc.width_mm - 180) < 1e-6 and abs(doc.height_mm - 120) < 1e-6,
          f"{doc.width_mm}×{doc.height_mm} mm")
    pdf = svg_to_pdf(doc)
    import pypdfium2 as pdfium
    pd = pdfium.PdfDocument(pdf)
    try:
        w_mm = pd[0].get_width() / MM_TO_PT
        h_mm = pd[0].get_height() / MM_TO_PT
    finally:
        pd.close()
    check("PDF giữ kích thước 1:1 (sai ≤0,05 mm)",
          abs(w_mm - 180) <= 0.05 and abs(h_mm - 120) <= 0.05,
          f"{w_mm:.4f}×{h_mm:.4f} mm")

    # 7) Chính sách an toàn phải chặn đúng.
    for bad, label in [
        ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>x</script></svg>',
         "chặn <script>"),
        ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">'
         '<image href="http://x/y.png"/></svg>', "chặn <image> URL ngoài"),
        ('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
         "chặn DOCTYPE"),
        ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">'
         '<path d="M 0 0 A 1 1 0 0 1 1 1" fill="#000"/></svg>', "báo lỗi lệnh A"),
    ]:
        try:
            parse_svg(bad)
            check(label, False, "không báo lỗi")
        except SvgSubsetError:
            check(label, True)
        except ET.ParseError:
            check(label, True)

    # 8b) Chuẩn hoá transform: hình sau khi làm phẳng phải TRÙNG KHÍT bản viết
    #     thẳng toạ độ. Đây là bước bắt buộc cho output VTracer 0.6.x
    #     (nó gắn translate() lên từng path).
    moved = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        '<path d="M 0 0 L 40 0 L 40 40 L 0 40 Z" fill="#C81414" '
        'transform="translate(30,20)"/></svg>'
    )
    plain = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" '
        'viewBox="0 0 100 100">'
        '<path d="M 30 20 L 70 20 L 70 60 L 30 60 Z" fill="#C81414"/></svg>'
    )
    try:
        parse_svg(moved)
        check("renderer vẫn từ chối transform thô", False, "không báo lỗi")
    except SvgSubsetError:
        check("renderer vẫn từ chối transform thô", True)
    n1 = np.asarray(render_svg_to_png(normalize_svg(moved), 200))
    n2 = np.asarray(render_svg_to_png(plain, 200))
    check("translate() làm phẳng trùng khít", np.array_equal(n1, n2),
          f"khác {int((n1 != n2).sum())} px")

    # 8c) Affine lồng nhau: g(translate) > path(scale) phải gộp đúng thứ tự.
    nested = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        '<g transform="translate(10,10)">'
        '<path d="M 0 0 L 20 0 L 20 20 L 0 20 Z" fill="#000000" '
        'transform="scale(2)"/></g></svg>'
    )
    expect = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" '
        'viewBox="0 0 100 100">'
        '<path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" fill="#000000"/></svg>'
    )
    n3 = np.asarray(render_svg_to_png(normalize_svg(nested), 200))
    n4 = np.asarray(render_svg_to_png(expect, 200))
    check("affine lồng nhau gộp đúng thứ tự", np.array_equal(n3, n4),
          f"khác {int((n3 != n4).sum())} px")

    # 8d) rotate(90, cx, cy) quanh tâm khung phải cho hình đối xứng biết trước.
    rot = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        '<path d="M 10 40 L 50 40 L 50 60 L 10 60 Z" fill="#000000" '
        'transform="rotate(90,50,50)"/></svg>'
    )
    rot_expect = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" '
        'viewBox="0 0 100 100">'
        '<path d="M 60 10 L 60 50 L 40 50 L 40 10 Z" fill="#000000"/></svg>'
    )
    n5 = np.asarray(render_svg_to_png(normalize_svg(rot), 200))
    n6 = np.asarray(render_svg_to_png(rot_expect, 200))
    check("rotate quanh tâm đúng", np.array_equal(n5, n6),
          f"khác {int((n5 != n6).sum())} px")

    # 8) Path tương đối và Q/T phải ra cùng hình như bản tuyệt đối.
    abs_svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
               '<path d="M 20 20 L 80 20 L 80 80 L 20 80 Z" fill="#000"/></svg>')
    rel_svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
               '<path d="m 20 20 l 60 0 l 0 60 l -60 0 z" fill="#000"/></svg>')
    d1 = np.asarray(render_svg_to_png(abs_svg, 200))[..., 3]
    d2 = np.asarray(render_svg_to_png(rel_svg, 200))[..., 3]
    check("path tương đối khớp tuyệt đối", np.array_equal(d1, d2),
          f"khác {int((d1 != d2).sum())} px")

    print()
    if failures:
        print(f"SELF-TEST THẤT BẠI: {len(failures)} mục — {', '.join(failures)}")
        return 1
    print("SELF-TEST ĐẠT — số đo từ bộ này dùng được.")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()
    if len(argv) >= 3:
        svg = Image.open  # noqa: F841  (giữ import PIL rõ ràng)
        data = open(argv[1], "rb").read()
        px = int(argv[3]) if len(argv) > 3 else 1200
        render_svg_to_png(data, px).save(argv[2])
        print(f"Đã ghi {argv[2]} ({px} px cạnh dài)")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
