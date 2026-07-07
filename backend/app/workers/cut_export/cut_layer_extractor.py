"""
cut_layer_extractor.py — Trích đường cắt MẠNH từ PDF đã bình bất kỳ (Req 10).

Hỗ trợ Prynx như "Acrobat thay thế": mở file bình sẵn (Corel/Illustrator/RIP/Prynx)
→ lấy đúng đường cắt để gửi máy, KHÔNG cần bình lại.

Cách làm:
- Đi content stream (pikepdf), theo dõi CTM (cm/q/Q), ĐỆ QUY Form XObject (Do) với
  ma trận đặt → toạ độ tuyệt đối trên tờ (Req 10.1).
- Nhận diện đường cắt theo OCG layer (BDC /OC) khớp mẫu cấu hình; loại trừ
  lớp dấu định vị (MarkLine/Marks) (Req 10.2, 10.5).
- Trả danh sách contour (điểm theo point PDF, gốc dưới-trái) — đơn định (Req 10.7).

KHÔNG đoán liều: nếu không khớp lớp cắt nào → trả rỗng để caller báo lỗi (Req 10.6).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Optional

import pikepdf

# Mẫu tên LỚP CẮT (substring, không phân biệt hoa thường).
DEFAULT_CUT_PATTERNS = (
    "result_cutline", "cutcontour", "cut_contour", "thru-cut", "thrucut",
    "kiss-cut", "kisscut", "cutline", "die", "crease", "dieline",
)
# Mẫu tên lớp LOẠI TRỪ (dấu định vị/ốc/marks).
DEFAULT_EXCLUDE_PATTERNS = ("markline", "marks", "regmark", "registration")

_PT_BEZIER_TOL = 0.5  # điểm; làm phẳng bezier


@dataclass
class ExtractConfig:
    cut_patterns: tuple = DEFAULT_CUT_PATTERNS
    exclude_patterns: tuple = DEFAULT_EXCLUDE_PATTERNS
    flatten_tol_pt: float = _PT_BEZIER_TOL
    max_depth: int = 8
    # Loại contour có bbox ≈ khổ trang (viền/limit-line) — tỉ lệ ngưỡng theo cạnh.
    page_frame_ratio: float = 0.95
    # Ép dùng MỘT lớp/spot do người dùng chọn (bỏ qua tự dò theo mẫu) — Req 10.6.
    force_layer: Optional[str] = None


@dataclass
class CutContour:
    points: list[tuple[float, float]]   # point PDF, gốc dưới-trái
    closed: bool
    layer: str = ""


@dataclass
class ExtractResult:
    contours: list[CutContour] = field(default_factory=list)
    layers_seen: set = field(default_factory=set)
    matched_layers: set = field(default_factory=set)
    spots_seen: set = field(default_factory=set)


def _is_cut_layer_name(name: str, cfg: "ExtractConfig") -> bool:
    """Quyết định một tên lớp/spot có phải đường cắt không.

    - Nếu cfg.force_layer được đặt → khớp theo lựa chọn người dùng (exact hoặc chứa nhau).
    - Ngược lại → khớp mẫu cut_patterns và không thuộc exclude_patterns.
    """
    low = (name or "").lower().lstrip("/")
    if cfg.force_layer:
        fl = cfg.force_layer.lower().lstrip("/")
        return low == fl or fl in low or low in fl
    return _name_matches(low, cfg.cut_patterns) and not _name_matches(low, cfg.exclude_patterns)


# ── Ma trận (PDF 6-tuple a,b,c,d,e,f; row-vector [x y 1]·M) ──
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _mat_mul(m_first, m_then):
    """Trả ma trận = áp m_first TRƯỚC rồi m_then (apply(result,p)=apply(m_then,apply(m_first,p)))."""
    a1, b1, c1, d1, e1, f1 = m_first
    a2, b2, c2, d2, e2, f2 = m_then
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _name_matches(name: str, patterns) -> bool:
    low = (name or "").lower()
    return any(p in low for p in patterns)


def _resolve_oc_name(operands, resources) -> Optional[str]:
    """Từ BDC operands [/OC, /PropName] → tên OCG (qua Resources/Properties)."""
    if len(operands) < 2:
        return None
    tag = operands[0]
    if str(tag) != "/OC":
        return None
    prop = operands[1]
    try:
        # prop có thể là Name (/MC0) → tra Properties; hoặc dict inline.
        oc_obj = None
        if isinstance(prop, pikepdf.Name):
            props = resources.get("/Properties")
            if props is not None and pikepdf.Name(str(prop)) in props:
                oc_obj = props[pikepdf.Name(str(prop))]
        elif isinstance(prop, pikepdf.Dictionary):
            oc_obj = prop
        if oc_obj is None:
            return None
        # OCG: /Name. OCMD: /OCGs → lấy /Name phần tử đầu.
        if "/Name" in oc_obj:
            return str(oc_obj["/Name"])
        if "/OCGs" in oc_obj:
            ocgs = oc_obj["/OCGs"]
            if isinstance(ocgs, pikepdf.Array) and len(ocgs) > 0:
                g = ocgs[0]
                if "/Name" in g:
                    return str(g["/Name"])
            elif "/Name" in ocgs:
                return str(ocgs["/Name"])
    except Exception:
        return None
    return None


def _spot_colorant_names(cs_operand, resources) -> list[str]:
    """Trả tên colorant của Separation/DeviceN (Name → Resources/ColorSpace), hoặc []."""
    try:
        cs_obj = None
        if isinstance(cs_operand, pikepdf.Name):
            csmap = resources.get("/ColorSpace")
            if csmap is not None and pikepdf.Name(str(cs_operand)) in csmap:
                cs_obj = csmap[pikepdf.Name(str(cs_operand))]
        elif isinstance(cs_operand, pikepdf.Array):
            cs_obj = cs_operand
        if not isinstance(cs_obj, pikepdf.Array) or len(cs_obj) < 2:
            return []
        kind = str(cs_obj[0])
        if kind == "/Separation":
            return [str(cs_obj[1]).lstrip("/")]
        if kind == "/DeviceN" and isinstance(cs_obj[1], pikepdf.Array):
            return [str(n).lstrip("/") for n in cs_obj[1]]
        return []
    except Exception:
        return []


class _Walker:
    def __init__(self, pdf: pikepdf.Pdf, cfg: ExtractConfig, result: ExtractResult):
        self.pdf = pdf
        self.cfg = cfg
        self.result = result

    def walk(self, stream_owner, resources, ctm, depth, mc_stack):
        """Đi 1 content stream. mc_stack: list bool (đang trong lớp cắt?) cho marked-content."""
        if depth > self.cfg.max_depth:
            return
        try:
            instructions = pikepdf.parse_content_stream(stream_owner)
        except Exception:
            return

        gs_stack = []          # lưu (ctm, stroke_spot_cut, fill_spot_cut) cho q/Q
        cur_path = []          # list subpath; subpath = list điểm (device)
        cur_sub = None
        last_pt = (0.0, 0.0)   # user-space điểm hiện tại (cho bezier)
        stroke_spot_cut = False  # stroke đang dùng spot-color CutContour?
        fill_spot_cut = False    # fill đang dùng spot-color cắt?
        # mc_stack nhân bản cục bộ (q/Q không ảnh hưởng marked-content, nhưng giữ đơn giản)
        mc = list(mc_stack)

        def in_cut() -> bool:
            return any(mc)

        def finish_subpath():
            nonlocal cur_sub
            if cur_sub and len(cur_sub) >= 2:
                cur_path.append(cur_sub)
            cur_sub = None

        for ins in instructions:
            op = str(ins.operator)
            ops = ins.operands

            if op == "cm" and len(ops) == 6:
                m = tuple(float(o) for o in ops)
                ctm = _mat_mul(m, ctm)
            elif op == "q":
                # Lưu CẢ colorspace-state (stroke/fill spot-cut) cùng ctm: PDF q/Q
                # lưu/khôi phục toàn graphics-state gồm colorspace. Trước đây chỉ stack
                # ctm → sau Q colorspace thật đã đổi lại nhưng cờ giữ giá trị trong q →
                # path sau bị gắn sai lớp cắt (thu nhầm/bỏ sót nét) (Fix H, audit
                # bảo toàn nội dung 2026-07-07).
                gs_stack.append((ctm, stroke_spot_cut, fill_spot_cut))
            elif op == "Q":
                if gs_stack:
                    ctm, stroke_spot_cut, fill_spot_cut = gs_stack.pop()
            elif op in ("BDC", "BMC"):
                name = _resolve_oc_name(ops, resources) if op == "BDC" else None
                if name:
                    self.result.layers_seen.add(name)
                is_cut = bool(name) and _is_cut_layer_name(name, self.cfg)
                if is_cut:
                    self.result.matched_layers.add(name)
                mc.append(is_cut)
            elif op == "EMC":
                if mc:
                    mc.pop()
            elif op == "CS" and len(ops) == 1:
                names = _spot_colorant_names(ops[0], resources)
                for nm in names:
                    self.result.spots_seen.add(nm)
                stroke_spot_cut = any(_is_cut_layer_name(nm, self.cfg) for nm in names)
            elif op == "cs" and len(ops) == 1:
                names = _spot_colorant_names(ops[0], resources)
                for nm in names:
                    self.result.spots_seen.add(nm)
                fill_spot_cut = any(_is_cut_layer_name(nm, self.cfg) for nm in names)
            # ── Path construction ──
            elif op == "m" and len(ops) == 2:
                finish_subpath()
                x, y = float(ops[0]), float(ops[1])
                last_pt = (x, y)
                cur_sub = [_apply(ctm, x, y)]
            elif op == "l" and len(ops) == 2:
                x, y = float(ops[0]), float(ops[1])
                last_pt = (x, y)
                if cur_sub is not None:
                    cur_sub.append(_apply(ctm, x, y))
            elif op in ("c", "v", "y"):
                pts = [float(o) for o in ops]
                if op == "c" and len(pts) == 6:
                    p1, p2, p3 = (pts[0], pts[1]), (pts[2], pts[3]), (pts[4], pts[5])
                elif op == "v" and len(pts) == 4:
                    p1, p2, p3 = last_pt, (pts[0], pts[1]), (pts[2], pts[3])
                elif op == "y" and len(pts) == 4:
                    p1 = (pts[0], pts[1]); p3 = (pts[2], pts[3]); p2 = p3
                else:
                    continue
                for fx, fy in self._flatten_bezier(last_pt, p1, p2, p3):
                    if cur_sub is not None:
                        cur_sub.append(_apply(ctm, fx, fy))
                last_pt = p3
            elif op == "re" and len(ops) == 4:
                x, y, w, h = (float(o) for o in ops)
                rect = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
                finish_subpath()
                cur_path.append([_apply(ctm, px, py) for px, py in rect])
                last_pt = (x, y)
            elif op == "h":
                if cur_sub and len(cur_sub) >= 2:
                    cur_sub.append(cur_sub[0])
            # ── Path painting ──
            elif op in ("S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"):
                finish_subpath()
                is_stroke = op in ("S", "s", "B", "B*", "b", "b*")
                is_fill = op in ("f", "F", "f*", "B", "B*", "b", "b*")
                spot_cut = (is_stroke and stroke_spot_cut) or (is_fill and fill_spot_cut)
                if (in_cut() or spot_cut) and cur_path:
                    fill_closed = op in ("s", "f", "F", "f*", "B", "B*", "b", "b*")
                    for sub in cur_path:
                        if len(sub) >= 2:
                            geo_closed = (abs(sub[0][0] - sub[-1][0]) < 0.05
                                          and abs(sub[0][1] - sub[-1][1]) < 0.05)
                            self.result.contours.append(
                                CutContour(points=sub, closed=fill_closed or geo_closed, layer="")
                            )
                cur_path = []
                cur_sub = None
            # ── XObject ──
            elif op == "Do" and len(ops) == 1:
                self._do_xobject(str(ops[0]), resources, ctm, depth, mc)

        # end-of-stream: bỏ path chưa paint.

    def _flatten_bezier(self, p0, p1, p2, p3):
        d = (math.hypot(p1[0] - p0[0], p1[1] - p0[1])
             + math.hypot(p2[0] - p1[0], p2[1] - p1[1])
             + math.hypot(p3[0] - p2[0], p3[1] - p2[1]))
        steps = max(2, min(60, int(d / max(self.cfg.flatten_tol_pt, 0.05))))
        out = []
        for i in range(1, steps + 1):
            t = i / steps
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
            y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
            out.append((x, y))
        return out

    def _do_xobject(self, name, resources, ctm, depth, mc):
        try:
            xobjs = resources.get("/XObject")
            if xobjs is None or pikepdf.Name(name) not in xobjs:
                return
            xobj = xobjs[pikepdf.Name(name)]
            if str(xobj.get("/Subtype")) != "/Form":
                return
            inner_ctm = ctm
            if "/Matrix" in xobj:
                m = tuple(float(v) for v in xobj["/Matrix"])
                inner_ctm = _mat_mul(m, ctm)
            inner_res = xobj.get("/Resources", resources)
            # XObject có thể có /OC riêng → coi như marked-content cut nếu khớp.
            inner_mc = list(mc)
            if "/OC" in xobj:
                nm = None
                ocd = xobj["/OC"]
                if "/Name" in ocd:
                    nm = str(ocd["/Name"])
                elif "/OCGs" in ocd:
                    g = ocd["/OCGs"]
                    if isinstance(g, pikepdf.Array) and len(g) > 0 and "/Name" in g[0]:
                        nm = str(g[0]["/Name"])
                if nm:
                    self.result.layers_seen.add(nm)
                    if _is_cut_layer_name(nm, self.cfg):
                        self.result.matched_layers.add(nm)
                        inner_mc.append(True)
            self.walk(xobj, inner_res, inner_ctm, depth + 1, inner_mc)
        except Exception:
            return


def extract_cut_contours(pdf_path: str, page_index: int = 0,
                         config: Optional[ExtractConfig] = None) -> ExtractResult:
    """Trích đường cắt từ trang `page_index` của PDF. Trả ExtractResult."""
    cfg = config or ExtractConfig()
    result = ExtractResult()
    pdf = pikepdf.open(pdf_path)
    try:
        page = pdf.pages[page_index]
        resources = page.get("/Resources", pikepdf.Dictionary())
        # Kích thước trang (để loại contour khung full-trang).
        mb = page.get("/MediaBox", [0, 0, 612, 792])
        pw = abs(float(mb[2]) - float(mb[0]))
        ph = abs(float(mb[3]) - float(mb[1]))
        walker = _Walker(pdf, cfg, result)
        walker.walk(page, resources, IDENTITY, 0, [])
    finally:
        pdf.close()

    # Loại contour có bbox ≈ khổ trang (viền/limit-line) — Req 10.5.
    if pw > 0 and ph > 0:
        kept = []
        for c in result.contours:
            xs = [p[0] for p in c.points]
            ys = [p[1] for p in c.points]
            bw = max(xs) - min(xs)
            bh = max(ys) - min(ys)
            if bw >= cfg.page_frame_ratio * pw and bh >= cfg.page_frame_ratio * ph:
                continue  # khung full-trang
            kept.append(c)
        result.contours = kept
    return result


def list_cut_candidates(pdf_path: str, page_index: int = 0) -> dict:
    """Liệt kê các lớp OCG + spot-color thấy trên trang (để người dùng chọn thủ công).

    Trả {"layers": [...], "spots": [...]} — đã lọc bớt lớp marks/full đã loại trừ vẫn liệt kê
    (người dùng tự quyết). Req 10.6.
    """
    cfg = ExtractConfig()  # chỉ để đi qua walker, không cần khớp
    result = ExtractResult()
    pdf = pikepdf.open(pdf_path)
    try:
        page = pdf.pages[page_index]
        resources = page.get("/Resources", pikepdf.Dictionary())
        _Walker(pdf, cfg, result).walk(page, resources, IDENTITY, 0, [])
    finally:
        pdf.close()
    return {
        "layers": sorted(result.layers_seen),
        "spots": sorted(result.spots_seen),
        "auto_matched": sorted(result.matched_layers),
    }
