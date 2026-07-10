"""Chế độ ĐỒNG NHẤT (homogeneous) cho Bình Tem Bế / Bế Rớt — "1 khuôn, nhiều nội dung".

Khi chỉ trang đầu có khuôn (die) và các trang còn lại chỉ có nội dung (không khuôn),
ta dùng hình học khuôn của trang master để xếp shape-aware (so le/head-to-tail) như
bình-1-mẫu, rồi căn từng nội dung về đúng tâm khuôn + co cho khít, và rải nội dung
vào các ô theo thứ tự (cuốn chiếu sang tờ).

Module này thuần logic hình học (không import ReportLab/pikepdf ở mức module). Phần
dò bbox cần truy cập trang PDF được nạp trễ; nhánh raster fallback tách riêng để
test có thể spy.

Spec: .kiro/specs/sticker-homogeneous-nup (Requirements 1–9; Design Properties 1–9).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence, Tuple

from app.workers.shape_types import ShapeType


# ─── Cấu trúc dữ liệu ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Rect:
    """Hình chữ nhật toạ độ point (gốc tuỳ ngữ cảnh). Bất biến."""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0


@dataclass(frozen=True)
class HomogeneousPlan:
    """Kế hoạch chế độ đồng nhất: 1 khuôn master + N trang nội dung (R1, R2)."""

    master_page_idx: int
    content_pages: Tuple[int, ...]
    shape_type: ShapeType
    trim_w: float
    trim_h: float
    poly: Tuple[Tuple[float, float], ...]
    die_center: Tuple[float, float]
    shape_props: dict = field(default_factory=dict)  # props master (SSOT honor — tránh tái phân loại)


@dataclass(frozen=True)
class RegTransform:
    """Tham số đặt 1 nội dung vào 1 ô: clip=bbox artwork, rect=khuôn đích, co đều."""

    clip: Rect
    rect: Rect
    keep_proportion: bool = True
    scale_warning: bool = False  # True khi lệch kích thước bất thường (vẫn co khít)


@dataclass(frozen=True)
class CellContent:
    """Ánh xạ một ô (trên một tờ) tới trang nội dung được gán."""

    cell_index: int   # chỉ số ô trong layout (ổn định, trong 1 tờ)
    sheet_index: int  # tờ thứ mấy (0-based)
    src_page_idx: int # trang nội dung gán cho ô


# ─── Adapter duck-typed cho detect_homogeneous (dựng từ tín hiệu engine) ─────


@dataclass(frozen=True)
class _TrimDims:
    w: float
    h: float


@dataclass(frozen=True)
class ShapeAdapter:
    """Object duck-typed cho ``detect_homogeneous`` (có ``.type/.poly/.trim/.props``).

    Engine dựng 1 adapter/trang từ tín hiệu tin cậy ``has_die`` (có đường bế hay
    không) + hình nhận diện của trang đó. Trang KHÔNG có khuôn → ``type=CUSTOM``.
    """

    type: ShapeType
    poly: Tuple[Tuple[float, float], ...]
    trim: _TrimDims
    props: dict
    has_die: bool = True  # trang CÓ đường bế thật (tín hiệu channel/màu — TÁCH khỏi phân loại hình)


def make_shape_adapter(shape_type: ShapeType, poly, trim_w: float, trim_h: float,
                       props: Optional[dict] = None,
                       has_die: Optional[bool] = None) -> ShapeAdapter:
    """Tạo 1 ShapeAdapter (chuẩn hoá poly/trim/props) cho detect_homogeneous.

    ``has_die`` = trang có đường bế thật hay không (tín hiệu ĐÁNG TIN từ
    select_die_path/channel-màu — KHÔNG suy từ phân loại hình). Nếu không truyền,
    suy mặc định = (shape_type ≠ CUSTOM) để tương thích ngược.
    """
    if has_die is None:
        has_die = shape_type is not ShapeType.CUSTOM
    return ShapeAdapter(
        type=shape_type,
        poly=tuple((float(x), float(y)) for (x, y) in (poly or ())),
        trim=_TrimDims(float(trim_w or 0.0), float(trim_h or 0.0)),
        props=dict(props or {}),
        has_die=bool(has_die),
    )


# ─── R1/R2: Phát hiện chế độ đồng nhất + hình học master ─────────────────────


def _has_die(shape: Any) -> bool:
    """Trang CÓ đường bế thật?

    ƯU TIÊN cờ ``has_die`` tường minh (tín hiệu channel/màu đáng tin — tách khỏi
    phân loại hình, để: (a) khuôn bất quy tắc phân-loại-CUSTOM vẫn được tính là khuôn;
    (b) trang nội dung KHÔNG bị nhầm là khuôn chỉ vì artwork có hình nhận-ra-được).
    Chỉ khi KHÔNG có cờ này mới suy theo ``type ≠ CUSTOM`` (tương thích ngược/test cũ).
    """
    hd = getattr(shape, "has_die", None)
    if hd is not None:
        return bool(hd)
    try:
        return shape.type is not ShapeType.CUSTOM
    except AttributeError:
        return False


# Ngưỡng "có đường bế THẬT": tách tín hiệu bế-đặc-thù khỏi tín hiệu hình-học generic.
# Bảng điểm _score_die_candidate: kênh khuôn +1000, spot-nét +400, màu bế +300 (đặc thù)
# vs nét +100 / hairline +60 / khép kín +30 / diện tích +20 (generic, artwork cũng có →
# tối đa ~210). Ngưỡng 250 nằm giữa ⇒ chỉ trang có đường bế đặc thù mới True.
_DIE_SCORE_MIN = 250.0


def page_has_die(page: Any, *, min_score: float = _DIE_SCORE_MIN) -> bool:
    """Trang có ĐƯỜNG BẾ THẬT (tín hiệu đặc thù) hay KHÔNG (chỉ artwork)?

    Đây là NGUỒN phân biệt đáng tin cho "dàn nhiều mẫu loại nào":
      - CÙNG khuôn (homogeneous): ĐÚNG 1 trang page_has_die=True (master) + còn lại False.
      - KHÁC khuôn (mixed): ≥2 trang page_has_die=True → đi bin-pack trộn.

    Dùng ``_score_die_candidate`` (SSOT chấm điểm của die_detection) nhưng CHỈ chấp
    nhận điểm ≥ ``min_score`` (tín hiệu kênh khuôn / spot-nét / màu bế) — LOẠI fallback
    hình học (nét/khép kín/diện tích) mà artwork nội dung cũng có → chống nhầm 2 chiều.
    Trang không path / lỗi extract → False (an toàn).
    """
    try:
        from app.workers.die_detection import _score_die_candidate, DetectionConfig
    except Exception:
        return False
    try:
        paths = page.extract_vector_paths()
    except Exception:
        return False
    if not paths:
        return False
    cfg = DetectionConfig()
    names_lower = frozenset(n.strip().lower() for n in (cfg.die_channel_names or ()))
    try:
        rect = page.rect
    except Exception:
        return False
    for p in paths:
        r = p.get("rect") if isinstance(p, dict) else None
        if r is None or r.width <= 5 or r.height <= 5:
            continue
        # Bỏ nền phủ kín trang (không phải đường bế).
        if abs(r.width - rect.width) <= 2 and abs(r.height - rect.height) <= 2:
            continue
        try:
            sc, _ = _score_die_candidate(p, rect, names_lower, cfg.die_colors, cfg.die_color_tol)
        except Exception:
            continue
        if sc >= min_score:
            return True
    return False


def detect_homogeneous(shapes: Sequence[Any]) -> Optional[HomogeneousPlan]:
    """Quyết định bật chế độ đồng nhất (R1) và trích hình học master (R2).

    Bật KHI VÀ CHỈ KHI **đúng một** trang có khuôn (master) và **mọi trang còn lại
    không có khuôn**; đồng thời ≥2 trang (master + ≥1 trang khác). Ngược lại → None.

    **content_pages GỒM CẢ master**: trang khuôn đồng thời là tem loại đầu (artwork
    + đường bế). Trước đây loại master khỏi content → 20 loại chỉ ra 19 tờ in
    (mất loại 1). Master vẫn là nguồn hình học khuôn (master_page_idx).
    """
    if not shapes:
        return None
    n = len(shapes)
    die_idx = [i for i, s in enumerate(shapes) if _has_die(s)]
    if len(die_idx) != 1:
        return None  # ≥2 khuôn hoặc 0 khuôn → không đồng nhất (R1.3, R1.4)

    master_i = die_idx[0]
    # Mọi trang đều là nội dung in (thứ tự trang nguồn). Master = loại đầu.
    if n < 2:
        return None  # 1 trang → để đường bình 1 mẫu thường, không cần homogeneous
    content = tuple(range(n))

    m = shapes[master_i]
    poly = tuple((float(x), float(y)) for (x, y) in (getattr(m, "poly", ()) or ()))
    trim = getattr(m, "trim", None)
    trim_w = float(getattr(trim, "w", 0.0) or 0.0)
    trim_h = float(getattr(trim, "h", 0.0) or 0.0)
    props = dict(getattr(m, "props", {}) or {})

    # Tâm khuôn = tâm bbox của footprint poly; fallback tâm trim.
    if poly:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        die_center = ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0)
    else:
        die_center = (trim_w / 2.0, trim_h / 2.0)

    return HomogeneousPlan(
        master_page_idx=master_i,
        content_pages=content,
        shape_type=m.type,
        trim_w=trim_w,
        trim_h=trim_h,
        poly=poly,
        die_center=die_center,
        shape_props=props,
    )


# ─── R3/R4: Dò bbox artwork + Registration (căn tâm + co khít) ────────────────


def _raster_artwork_bbox(page: Any, dpi: int) -> Optional[Rect]:
    """Nhánh raster fallback (DPI thấp) — dò bbox vùng non-white bằng pypdfium2.

    Dùng ``page.get_pixmap(dpi=…)`` (SSOT render của pdf_wrapper.Page → pypdfium2).
    Ảnh raster theo hàng TOP-DOWN; trả về Rect theo TOẠ ĐỘ PDF (y-up, gốc đáy-trái)
    để KHỚP nhánh vector + ngữ nghĩa ``show_pdf_page(clip=…)`` (clip ở hệ trang nguồn,
    y từ dưới lên). Tách riêng để test có thể spy (Property 9). Best-effort: lỗi/không
    render được → None (caller coi trang rỗng-an-toàn).
    """
    try:
        import numpy as np
        pm = page.get_pixmap(dpi=dpi)
        h, w, n = int(pm.height), int(pm.width), int(getattr(pm, "n", 3) or 3)
        if h <= 0 or w <= 0:
            return None
        arr = np.frombuffer(pm.samples, dtype=np.uint8)
        arr = arr[: h * w * n].reshape(h, w, n)
        gray = arr[:, :, :3].min(axis=2) if n >= 3 else arr[:, :, 0]
        ys, xs = np.where(gray < 250)  # pixel "có mực" = không trắng
        if len(xs) == 0:
            return None
        scale = float(dpi) / 72.0  # px / point
        x0 = float(xs.min()) / scale
        x1 = float(xs.max() + 1) / scale
        y0 = float(ys.min()) / scale
        y1 = float(ys.max() + 1) / scale
        # KHÔNG lật trục y: nhánh vector (extract_vector_paths) trả rect CÙNG quy ước
        # với hàng ảnh đã chia scale (đã xác minh bằng thực nghiệm — §6.1). Lật y sẽ
        # khiến clip lệch so với nhánh vector → consumer show_pdf_page lấy sai vùng.
        return Rect(x0, y0, x1, y1)
    except Exception:
        return None


def artwork_bbox(page: Any, *, raster_dpi_fallback: int = 72) -> Optional[Rect]:
    """bbox vùng có nội dung/mực thật của tem trên một trang (R3.1, R9.2).

    Ưu tiên VECTOR (hợp bbox các path, loại path nền phủ kín trang); chỉ raster
    fallback DPI thấp khi KHÔNG có path vector hợp lệ. Trả None nếu trang rỗng.
    """
    paths = None
    try:
        paths = page.extract_vector_paths()
    except Exception:
        paths = None

    if paths:
        try:
            pr = page.rect
            pw, ph = float(pr.width), float(pr.height)
        except Exception:
            pw = ph = None
        xs0: List[float] = []
        ys0: List[float] = []
        xs1: List[float] = []
        ys1: List[float] = []
        for p in paths:
            r = p.get("rect") if isinstance(p, dict) else None
            if r is None:
                continue
            if r.width <= 1 or r.height <= 1:
                continue
            # Loại path nền phủ kín trang (không phải nội dung tem).
            if pw is not None and abs(r.width - pw) <= 2 and abs(r.height - ph) <= 2:
                continue
            xs0.append(float(r.x0)); ys0.append(float(r.y0))
            xs1.append(float(r.x1)); ys1.append(float(r.y1))
        if xs0:
            return Rect(min(xs0), min(ys0), max(xs1), max(ys1))

    # Không có vector hợp lệ → raster fallback (DPI thấp).
    return _raster_artwork_bbox(page, raster_dpi_fallback)


def placed_bbox(content_bbox: Rect, die_rect: Rect) -> Rect:
    """bbox của nội dung SAU khi căn tâm + co ĐỀU cho khít khuôn (R3.3, R4.1, R4.2).

    Mô phỏng đúng ngữ nghĩa ``show_pdf_page(clip=content_bbox, rect=die_rect,
    keep_proportion=True)``: scale uniform = min(rect/clip theo 2 chiều), canh tâm
    vào tâm ``die_rect``. Dùng cho test parity/registration (thuần, không vẽ).
    """
    cw, ch = content_bbox.width, content_bbox.height
    if cw <= 0 or ch <= 0 or die_rect.width <= 0 or die_rect.height <= 0:
        return die_rect
    s = min(die_rect.width / cw, die_rect.height / ch)
    w, h = cw * s, ch * s
    cx, cy = die_rect.cx, die_rect.cy
    return Rect(cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0)


def registration_for(content_bbox: Rect, die_rect: Rect, *, warn_ratio: float = 0.20) -> RegTransform:
    """Đóng gói tham số đặt nội dung vào ô (R3, R4).

    Trả ``RegTransform(clip=content_bbox, rect=die_rect, keep_proportion=True)``.
    ``scale_warning=True`` khi lệch kích thước > ``warn_ratio`` (vẫn co cho khít — R4.3).
    """
    warn = False
    if (content_bbox.width > 0 and content_bbox.height > 0
            and die_rect.width > 0 and die_rect.height > 0):
        dev_w = abs(content_bbox.width - die_rect.width) / die_rect.width
        dev_h = abs(content_bbox.height - die_rect.height) / die_rect.height
        warn = max(dev_w, dev_h) > warn_ratio
    return RegTransform(clip=content_bbox, rect=die_rect, keep_proportion=True, scale_warning=warn)


# ─── R6: Ánh xạ ô ↔ trang nội dung (tất định + cuốn chiếu sang tờ) ───────────


def assign_contents(content_sequence: Sequence[int], cells_per_sheet: int) -> List[CellContent]:
    """Rải danh sách nội dung (đã giãn theo số lượng từ caller) vào các ô (R6).

    Tất định: nội dung thứ k → ô ``k % C`` ở tờ ``k // C`` (C = số ô/tờ). Cùng input
    → cùng kết quả; cuốn chiếu sang tờ mới khi vượt C.
    """
    C = max(1, int(cells_per_sheet))
    out: List[CellContent] = []
    for k, src in enumerate(content_sequence):
        out.append(CellContent(cell_index=k % C, sheet_index=k // C, src_page_idx=int(src)))
    return out


def expand_by_quantity(content_pages: Sequence[int], quantities: Optional[Sequence[int]]) -> List[int]:
    """Giãn danh sách trang theo số lượng mỗi trang (như Dàn nhiều mẫu) (R6.1).

    quantities=None hoặc tổng ≤ 0 → auto-fill: mỗi trang xuất hiện đúng 1 lần (lấp
    đầy theo thứ tự). Ngược lại → mỗi trang lặp lại theo số lượng tương ứng, xen kẽ
    để phân bố đều (round-robin) cho cân tờ.
    """
    pages = list(content_pages)
    if not pages:
        return []
    if not quantities or sum(int(q or 0) for q in quantities) <= 0:
        return pages  # auto-fill: 1 lần mỗi trang

    remaining = [max(0, int(q or 0)) for q in quantities]
    # đệm/cắt cho khớp độ dài pages
    if len(remaining) < len(pages):
        remaining += [0] * (len(pages) - len(remaining))
    seq: List[int] = []
    while any(r > 0 for r in remaining):
        for i, pg in enumerate(pages):
            if remaining[i] > 0:
                seq.append(pg)
                remaining[i] -= 1
    return seq


# ─── R5/R9.1: Build layout đồng nhất (nesting ĐÚNG 1 lần + gán nội dung) ──────


@dataclass(frozen=True)
class HomogeneousLayout:
    """Kết quả build chế độ đồng nhất: nesting 1 tờ (so le) + ánh xạ nội dung mọi tờ."""

    items: Tuple[Any, ...]                 # cells từ nesting (1 tờ) — GIỮ NGUYÊN format layout
    cells_per_sheet: int                   # C = len(items)
    shape_type: ShapeType
    shape_props: dict
    trim_w: float
    trim_h: float
    cell_contents: Tuple[CellContent, ...] # ô↔trang nội dung (mọi tờ, cuốn chiếu)
    num_sheets: int


def build_homogeneous_layout(
    master_page: Any,
    plan: HomogeneousPlan,
    *,
    sheet_usable_w: float,
    sheet_usable_h: float,
    gap_x: float,
    gap_y: float,
    strategy: str = "optimal_auto",
    bleed_pt: float = 0.0,
    secondary_gap: Optional[float] = None,
    quantities: Optional[Sequence[int]] = None,
    layout_fn: Optional[Any] = None,
) -> HomogeneousLayout:
    """Dựng layout đồng nhất: nesting shape-aware từ master ĐÚNG MỘT LẦN rồi gán nội dung.

    - Gọi ``compute_sticker_layout_for_page(master_page, ...)`` **một lần** với
      ``shape_type_override``/``shape_props_override`` = hình học master (R5.1, R9.1)
      → items so le/head-to-tail (KHÔNG lưới).
    - ``C = len(items)`` ô/tờ; rải nội dung (giãn theo số lượng / auto-fill) tuần tự,
      cuốn chiếu sang tờ (R6).
    - Trả ``HomogeneousLayout`` mang items (1 tờ) + ``cell_contents`` (mọi tờ).

    ``layout_fn`` cho phép tiêm hàm nesting (spy/test — Property 8). Mặc định nạp trễ
    ``compute_sticker_layout_for_page`` (tránh import nặng ở mức module).
    """
    if layout_fn is None:
        from app.workers.sticker_imposer_pkg.layout_compute import (
            compute_sticker_layout_for_page as layout_fn,
        )

    result = layout_fn(
        master_page,
        sheet_usable_w,
        sheet_usable_h,
        gap_x,
        gap_y,
        strategy=strategy,
        shape_type_override=plan.shape_type.name,
        shape_props_override=(plan.shape_props or None),
        bleed_pt=bleed_pt,
        secondary_gap=secondary_gap,
    )

    items = tuple(result.get("items", []) or [])
    C = len(items)
    seq = expand_by_quantity(plan.content_pages, quantities)
    cell_contents = tuple(assign_contents(seq, C if C > 0 else 1))
    num_sheets = 0 if not cell_contents else (cell_contents[-1].sheet_index + 1)

    # shapeType trả từ layout có thể là tên chuỗi — ưu tiên giữ ShapeType của plan.
    return HomogeneousLayout(
        items=items,
        cells_per_sheet=C,
        shape_type=plan.shape_type,
        shape_props=dict(result.get("shapeProps", {}) or {}),
        trim_w=float(result.get("trimW", plan.trim_w) or plan.trim_w),
        trim_h=float(result.get("trimH", plan.trim_h) or plan.trim_h),
        cell_contents=cell_contents,
        num_sheets=num_sheets,
    )
