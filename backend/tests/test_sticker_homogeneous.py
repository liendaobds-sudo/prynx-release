"""Property tests cho chế độ ĐỒNG NHẤT (sticker-homogeneous-nup) — Wave 1.

Feature: sticker-homogeneous-nup
Phủ các Property thuần (không cần PDF thật):
  - Property 1: Phát hiện chế độ đồng nhất            (Req 1.2, 1.3)
  - Property 3: Registration căn đúng tâm khuôn        (Req 3.3, 3.6)
  - Property 4: Co cho khít, giữ tỉ lệ                  (Req 4.1, 4.2)
  - Property 5: Gán ô↔nội dung tất định + cuốn chiếu   (Req 6.2, 6.3)
  - Property 9: bbox ưu tiên vector (không gọi raster) (Req 9.2)

Chạy bằng: backend/venv/Scripts/python.exe -m pytest tests/test_sticker_homogeneous.py
"""
from __future__ import annotations

import math

from hypothesis import HealthCheck, given, settings, strategies as st

from app.workers.shape_types import ShapeType
from app.workers import sticker_homogeneous as sh
from app.workers.sticker_homogeneous import Rect
from app.workers import pdf_wrapper as pdf_lib


# ─── Fakes nhẹ (duck-typed như DetectedShape / Page) ─────────────────────────

class _FakeTrim:
    def __init__(self, w: float, h: float):
        self.w = w
        self.h = h


class _FakeShape:
    """Trang nhận diện giả: có khuôn ⇔ type ≠ CUSTOM."""

    def __init__(self, has_die: bool, w: float = 50.0, h: float = 40.0):
        self.type = ShapeType.CIRCLE_ELLIPSE if has_die else ShapeType.CUSTOM
        self.trim = _FakeTrim(w, h)
        # poly = bbox khuôn quanh tâm (10,20) cho ca có khuôn; rỗng cho content
        self.poly = ((0.0, 0.0), (w, 0.0), (w, h), (0.0, h)) if has_die else ()


class _FakePage:
    """Trang PDF giả cho artwork_bbox: trả path vector từ extract_vector_paths."""

    def __init__(self, paths, page_w=200.0, page_h=200.0):
        self._paths = paths
        self.rect = Rect(0.0, 0.0, page_w, page_h)

    def extract_vector_paths(self):
        return self._paths


# ─── Property 1: Phát hiện chế độ đồng nhất (Req 1.2, 1.3) ───────────────────

@settings(max_examples=200)
@given(flags=st.lists(st.booleans(), min_size=0, max_size=8))
def test_p1_detect_homogeneous(flags):
    """Bật KHI VÀ CHỈ KHI đúng 1 trang có khuôn + ≥2 trang tổng (master cũng là nội dung)."""
    shapes = [_FakeShape(has_die=f) for f in flags]
    plan = sh.detect_homogeneous(shapes)

    die_idx = [i for i, f in enumerate(flags) if f]
    should_enable = (len(die_idx) == 1) and (len(flags) >= 2)

    if should_enable:
        assert plan is not None
        assert plan.master_page_idx == die_idx[0]
        # Mọi trang đều là nội dung — master = tem loại đầu (có artwork + khuôn).
        expected_content = tuple(range(len(flags)))
        assert plan.content_pages == expected_content
        assert plan.master_page_idx in plan.content_pages
    else:
        # 0 khuôn, ≥2 khuôn, hoặc chỉ 1 trang → None
        assert plan is None


# ─── Property 3: Registration căn đúng tâm khuôn (Req 3.3, 3.6) ──────────────

_coord = st.floats(min_value=-500, max_value=500, allow_nan=False, allow_infinity=False)
_dim = st.floats(min_value=1.0, max_value=400.0, allow_nan=False, allow_infinity=False)


@st.composite
def _rects(draw):
    x0 = draw(_coord)
    y0 = draw(_coord)
    w = draw(_dim)
    h = draw(_dim)
    return Rect(x0, y0, x0 + w, y0 + h)


@settings(max_examples=300)
@given(content=_rects(), die=_rects())
def test_p3_registration_centers_on_die(content, die):
    """Tâm bbox sau biến đổi trùng tâm khuôn (≤ 1e-6), độc lập vị trí gốc."""
    placed = sh.placed_bbox(content, die)
    assert math.isclose(placed.cx, die.cx, abs_tol=1e-6)
    assert math.isclose(placed.cy, die.cy, abs_tol=1e-6)


@settings(max_examples=200)
@given(content=_rects(), die=_rects(), dx=_coord, dy=_coord)
def test_p3_center_invariant_to_source_position(content, die, dx, dy):
    """Dời bbox nguồn (lệch trên trang gốc) KHÔNG đổi tâm đặt vào khuôn."""
    shifted = Rect(content.x0 + dx, content.y0 + dy, content.x1 + dx, content.y1 + dy)
    a = sh.placed_bbox(content, die)
    b = sh.placed_bbox(shifted, die)
    assert math.isclose(a.cx, b.cx, abs_tol=1e-6)
    assert math.isclose(a.cy, b.cy, abs_tol=1e-6)
    assert math.isclose(a.width, b.width, abs_tol=1e-6)
    assert math.isclose(a.height, b.height, abs_tol=1e-6)


# ─── Property 4: Co cho khít, giữ tỉ lệ (Req 4.1, 4.2) ───────────────────────

@settings(max_examples=300)
@given(content=_rects(), die=_rects())
def test_p4_uniform_scale_and_fit(content, die):
    """Scale ĐỀU (sx==sy), vừa khít (không tràn) + ít nhất 1 chiều chạm khuôn."""
    placed = sh.placed_bbox(content, die)
    sx = placed.width / content.width
    sy = placed.height / content.height
    # scale uniform
    assert math.isclose(sx, sy, rel_tol=1e-9, abs_tol=1e-9)
    # tỉ lệ khung hình bảo toàn
    assert math.isclose(placed.width / placed.height,
                        content.width / content.height, rel_tol=1e-9)
    # không tràn khuôn
    tol = 1e-6
    assert placed.width <= die.width + tol
    assert placed.height <= die.height + tol
    # khít: ít nhất 1 chiều chạm mép khuôn
    touches = (math.isclose(placed.width, die.width, abs_tol=1e-6)
               or math.isclose(placed.height, die.height, abs_tol=1e-6))
    assert touches


# ─── Property 5: Gán ô↔nội dung tất định + cuốn chiếu (Req 6.2, 6.3) ─────────

@settings(max_examples=200)
@given(
    seq=st.lists(st.integers(min_value=0, max_value=99), min_size=0, max_size=50),
    cells=st.integers(min_value=1, max_value=12),
)
def test_p5_assign_deterministic_and_rollover(seq, cells):
    a = sh.assign_contents(seq, cells)
    b = sh.assign_contents(seq, cells)
    # tất định
    assert a == b
    assert len(a) == len(seq)
    for k, cc in enumerate(a):
        assert cc.src_page_idx == seq[k]
        assert cc.cell_index == k % cells
        assert cc.sheet_index == k // cells
        assert 0 <= cc.cell_index < cells
    # cuốn chiếu: tờ t chứa đúng các index [t*C, (t+1)*C)
    for cc in a:
        lo = cc.sheet_index * cells
        glob = cc.sheet_index * cells + cc.cell_index
        assert lo <= glob < lo + cells


def test_p5_expand_by_quantity_autofill_and_counts():
    pages = [3, 4, 5]
    # Chuỗi cơ sở auto-fill: mỗi trang 1 lần; build layout sẽ chia khối để kín tờ.
    assert sh.expand_by_quantity(pages, None) == [3, 4, 5]
    assert sh.expand_by_quantity(pages, [0, 0, 0]) == [3, 4, 5]
    # số lượng cụ thể: đúng tổng số lần xuất hiện mỗi trang
    out = sh.expand_by_quantity(pages, [2, 1, 3])
    assert out.count(3) == 2
    assert out.count(4) == 1
    assert out.count(5) == 3
    assert len(out) == 6


# ─── Property 9: bbox ưu tiên vector — KHÔNG gọi raster (Req 9.2) ────────────

@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    x0=st.floats(20, 60), y0=st.floats(20, 60),
    w=st.floats(20, 80), h=st.floats(20, 80),
)
def test_p9_vector_first_no_raster(monkeypatch, x0, y0, w, h):
    """Trang vector hợp lệ → artwork_bbox KHÔNG gọi nhánh raster fallback."""
    calls = {"raster": 0}

    def _spy_raster(page, dpi):  # pragma: no cover - chỉ để đếm
        calls["raster"] += 1
        return None

    monkeypatch.setattr(sh, "_raster_artwork_bbox", _spy_raster)

    art = Rect(x0, y0, x0 + w, y0 + h)
    # 1 path nền phủ kín trang (phải bị loại) + 1 path artwork thật
    bg = Rect(0.0, 0.0, 200.0, 200.0)
    page = _FakePage(paths=[{"rect": bg}, {"rect": art}], page_w=200.0, page_h=200.0)

    bbox = sh.artwork_bbox(page)
    assert calls["raster"] == 0, "không được gọi raster khi đã có vector hợp lệ"
    assert bbox is not None
    # bbox = đúng path artwork (nền full-page đã loại)
    assert math.isclose(bbox.x0, art.x0, abs_tol=1e-6)
    assert math.isclose(bbox.y0, art.y0, abs_tol=1e-6)
    assert math.isclose(bbox.x1, art.x1, abs_tol=1e-6)
    assert math.isclose(bbox.y1, art.y1, abs_tol=1e-6)


def test_p9_empty_page_uses_raster_fallback(monkeypatch):
    """Không path vector hợp lệ → rơi xuống raster fallback (được gọi đúng 1 lần)."""
    calls = {"raster": 0}

    def _spy_raster(page, dpi):
        calls["raster"] += 1
        return Rect(0.0, 0.0, 10.0, 10.0)

    monkeypatch.setattr(sh, "_raster_artwork_bbox", _spy_raster)
    page = _FakePage(paths=[], page_w=200.0, page_h=200.0)
    bbox = sh.artwork_bbox(page)
    assert calls["raster"] == 1
    assert bbox == Rect(0.0, 0.0, 10.0, 10.0)


# ─── Property 2 + 8: build layout (shape-aware, nesting đúng 1 lần) ──────────

def _staggered_items(n):
    """Giả lập items so le (head-to-tail) — KHÔNG phải lưới đều."""
    out = []
    for i in range(n):
        row = i // 3
        col = i % 3
        x = col * 50.0 + (25.0 if row % 2 else 0.0)  # so le: hàng lẻ lệch nửa ô
        y = row * 40.0
        out.append({"x": x, "y": y, "w": 50.0, "h": 40.0})
    return out


def _make_plan(content_pages, shape=ShapeType.CIRCLE_ELLIPSE):
    return sh.HomogeneousPlan(
        master_page_idx=0,
        content_pages=tuple(content_pages),
        shape_type=shape,
        trim_w=50.0,
        trim_h=40.0,
        poly=((0.0, 0.0), (50.0, 0.0), (50.0, 40.0), (0.0, 40.0)),
        die_center=(25.0, 20.0),
        shape_props={"width": 50.0, "height": 40.0},
    )


@settings(max_examples=80)
@given(
    n_content=st.integers(min_value=1, max_value=40),
    n_cells=st.integers(min_value=1, max_value=9),
)
def test_p8_nesting_called_exactly_once(n_content, n_cells):
    """compute layout gọi ĐÚNG 1 lần bất kể N trang nội dung (Property 8 / Req 9.1)."""
    calls = {"n": 0}

    def _spy_layout(page, uw, uh, gx, gy, **kw):
        calls["n"] += 1
        return {
            "items": _staggered_items(n_cells),
            "shapeType": "CIRCLE_ELLIPSE",
            "shapeProps": {"width": 50.0, "height": 40.0},
            "trimW": 50.0,
            "trimH": 40.0,
        }

    plan = _make_plan(range(1, n_content + 1))
    layout = sh.build_homogeneous_layout(
        master_page=object(),
        plan=plan,
        sheet_usable_w=500.0,
        sheet_usable_h=400.0,
        gap_x=0.0,
        gap_y=0.0,
        layout_fn=_spy_layout,
    )
    assert calls["n"] == 1, "nesting phải tính đúng 1 lần"
    assert layout.cells_per_sheet == n_cells
    # Auto-fill: mọi nội dung có ít nhất 1 lần và tờ cuối được lấp kín.
    import math as _m
    expected_items = _m.ceil(n_content / n_cells) * n_cells
    assert len(layout.cell_contents) == expected_items
    assert set(c.src_page_idx for c in layout.cell_contents) == set(range(1, n_content + 1))
    # cuốn chiếu đúng số tờ
    assert layout.num_sheets == _m.ceil(n_content / n_cells)


def test_p2_layout_is_master_nesting_not_grid():
    """Layout = items nesting của master (so le) — không dựng lưới riêng (Property 2)."""
    canned = _staggered_items(6)

    def _spy_layout(page, uw, uh, gx, gy, **kw):
        # honor override type của master
        assert kw.get("shape_type_override") == "CIRCLE_ELLIPSE"
        return {"items": canned, "shapeType": "CIRCLE_ELLIPSE",
                "shapeProps": {}, "trimW": 50.0, "trimH": 40.0}

    plan = _make_plan([1, 2, 3, 4, 5, 6, 7, 8])
    layout = sh.build_homogeneous_layout(
        master_page=object(), plan=plan,
        sheet_usable_w=500.0, sheet_usable_h=400.0, gap_x=0.0, gap_y=0.0,
        layout_fn=_spy_layout,
    )
    # items giữ NGUYÊN từ nesting master (không thay bằng lưới)
    assert list(layout.items) == canned
    # so le thật: tồn tại hàng lệch nửa ô (x lẻ) → khác lưới đều
    xs = sorted({it["x"] for it in layout.items})
    assert any(abs(x - 25.0) < 1e-9 for x in xs), "phải có offset so le (không lưới đều)"


# ─── Raster fallback THẬT (không monkeypatch) — xác minh API + orientation ───

def test_raster_artwork_bbox_matches_vector_branch(tmp_path):
    """_raster_artwork_bbox chạy THẬT qua get_pixmap và KHỚP nhánh vector cùng trang.

    Đây là bất biến đúng cho consumer (show_pdf_page clip): dù dò bbox bằng vector hay
    raster, cùng một trang phải cho cùng vùng (cùng QUY ƯỚC TOẠ ĐỘ — §6.1). Vẽ 1 ô,
    so bbox vector (extract_vector_paths) với bbox raster (render) trong dung sai DPI.
    """
    doc = pdf_lib.open()
    page = doc.new_page(width=200.0, height=200.0)
    shape = page.new_shape()
    shape.draw_rect(pdf_lib.Rect(50.0, 30.0, 150.0, 80.0))
    shape.finish(color=(0.0, 0.0, 0.0, 1.0), fill=(0.0, 0.0, 0.0, 1.0))
    shape.commit()
    out = tmp_path / "raster_art.pdf"
    doc.save(str(out))
    doc.close()

    doc2 = pdf_lib.open(str(out))
    try:
        page2 = doc2[0]
        vec = sh.artwork_bbox(page2, raster_dpi_fallback=72)   # nhánh vector (có path)
        ras = sh._raster_artwork_bbox(page2, 144)              # nhánh raster THẬT
    finally:
        doc2.close()

    assert vec is not None, "nhánh vector phải tìm thấy ô đã vẽ"
    assert ras is not None, "raster fallback phải trả bbox (API get_pixmap chạy thật)"
    # Hai biểu diễn phải KHỚP (cùng quy ước toạ độ) — dung sai lượng tử DPI + viền.
    tol = 4.0
    assert abs(ras.x0 - vec.x0) <= tol, f"x0 vec={vec.x0} ras={ras.x0}"
    assert abs(ras.x1 - vec.x1) <= tol, f"x1 vec={vec.x1} ras={ras.x1}"
    assert abs(ras.y0 - vec.y0) <= tol, f"y0 vec={vec.y0} ras={ras.y0}"
    assert abs(ras.y1 - vec.y1) <= tol, f"y1 vec={vec.y1} ras={ras.y1}"


def test_artwork_bbox_image_only_page_falls_to_raster(tmp_path):
    """Trang KHÔNG có vector path hợp lệ → artwork_bbox rơi xuống raster THẬT (≠ None)."""
    doc = pdf_lib.open()
    page = doc.new_page(width=200.0, height=200.0)
    shape = page.new_shape()
    shape.draw_rect(pdf_lib.Rect(60.0, 60.0, 140.0, 140.0))
    shape.finish(color=(0.0, 0.0, 0.0, 1.0), fill=(0.0, 0.0, 0.0, 1.0))
    shape.commit()
    out = tmp_path / "art2.pdf"
    doc.save(str(out))
    doc.close()

    doc2 = pdf_lib.open(str(out))
    try:
        # Ép rỗng nhánh vector để buộc xuống raster (mô phỏng trang ảnh thuần).
        page2 = doc2[0]
        page2.extract_vector_paths = lambda: []
        bbox = sh.artwork_bbox(page2, raster_dpi_fallback=72)
    finally:
        doc2.close()
    assert bbox is not None
    assert bbox.width > 0 and bbox.height > 0


# ─── Phân biệt ĐÚNG loại "dàn nhiều mẫu" (cùng khuôn vs khác khuôn) ──────────
# Tín hiệu has_die (channel/màu) TÁCH khỏi phân loại hình → chống nhầm 2 chiều.

def _adapter(has_die, shape=ShapeType.CIRCLE_ELLIPSE, w=50.0, h=40.0):
    """Adapter như engine dựng: có khuôn → type là hình thật; không khuôn → CUSTOM."""
    stype = shape if has_die else ShapeType.CUSTOM
    poly = ((0.0, 0.0), (w, 0.0), (w, h), (0.0, h)) if has_die else ()
    return sh.make_shape_adapter(stype, poly, w, h, {}, has_die=has_die)


def test_discriminate_homogeneous_basic():
    """1 khuôn + N nội dung → ĐỒNG NHẤT (master = trang khuôn = loại đầu)."""
    shapes = [_adapter(True), _adapter(False), _adapter(False)]
    plan = sh.detect_homogeneous(shapes)
    assert plan is not None and plan.master_page_idx == 0
    assert plan.content_pages == (0, 1, 2)  # gồm master


def test_discriminate_mixed_two_dies_not_homogeneous():
    """≥2 trang đều CÓ khuôn (khác khuôn) → KHÔNG đồng nhất → đường mixed cũ."""
    shapes = [_adapter(True), _adapter(True), _adapter(False)]
    assert sh.detect_homogeneous(shapes) is None


def test_discriminate_false_positive_irregular_second_die():
    """CHỐNG NHẦM: trang khuôn thứ 2 là khuôn BẤT QUY TẮC (hình phân-loại CUSTOM)
    nhưng VẪN có đường bế (has_die=True) → phải đếm là 2 khuôn → KHÔNG đồng nhất.

    (Trước fix: type=CUSTOM khiến _has_die=False → đếm nhầm 1 khuôn → áp nhầm khuôn.)
    """
    # Trang 1: có khuôn nhưng hình CUSTOM (khuôn dị dạng) — has_die VẪN True.
    irregular_die = sh.make_shape_adapter(
        ShapeType.CUSTOM, ((0, 0), (50, 0), (50, 40), (0, 40)), 50.0, 40.0, {},
        has_die=True)
    shapes = [_adapter(True), irregular_die, _adapter(False)]
    assert sh.detect_homogeneous(shapes) is None, \
        "2 khuôn thật (1 bất quy tắc) phải đi đường mixed, KHÔNG nhầm đồng nhất"


def test_discriminate_false_negative_irregular_master():
    """CHỐNG SÓT: master là khuôn BẤT QUY TẮC (hình CUSTOM) + còn lại không khuôn
    → VẪN nhận đúng là đồng nhất (master = trang khuôn dị dạng).

    (Trước fix: type=CUSTOM khiến master không được tính là khuôn → rơi về lưới.)
    """
    irregular_master = sh.make_shape_adapter(
        ShapeType.CUSTOM, ((0, 0), (60, 0), (60, 30), (0, 30)), 60.0, 30.0, {},
        has_die=True)
    shapes = [irregular_master, _adapter(False), _adapter(False)]
    plan = sh.detect_homogeneous(shapes)
    assert plan is not None and plan.master_page_idx == 0
    assert plan.shape_type == ShapeType.CUSTOM


def test_discriminate_content_artwork_not_mistaken_as_die():
    """CHỐNG NHẦM: trang nội dung có artwork hình tròn (nhận-ra-được) NHƯNG KHÔNG
    có đường bế (has_die=False) → KHÔNG bị tính là khuôn.

    Mô phỏng: nội dung mang shape=CIRCLE nhưng has_die=False (không có channel bế).
    """
    content_with_shape = sh.make_shape_adapter(
        ShapeType.CIRCLE_ELLIPSE, (), 50.0, 40.0, {}, has_die=False)
    shapes = [_adapter(True), content_with_shape, _adapter(False)]
    plan = sh.detect_homogeneous(shapes)
    assert plan is not None and plan.master_page_idx == 0
    assert plan.content_pages == (0, 1, 2)  # master + 2 trang sau


def test_discriminate_zero_die_not_homogeneous():
    """0 khuôn (vd bình bài xén thường) → KHÔNG đồng nhất."""
    shapes = [_adapter(False), _adapter(False)]
    assert sh.detect_homogeneous(shapes) is None


# ─── page_has_die: tín hiệu bế THẬT (kênh/màu) ≠ artwork generic ─────────────

def test_page_has_die_magenta_vs_black_content(tmp_path):
    """Trang khuôn MAGENTA (màu bế) → True; trang artwork ĐEN (nội dung) → False.

    Đây là nguồn phân biệt đáng tin: chống nhầm artwork nội dung (nét/khép kín đen)
    thành 'có khuôn'.
    """
    doc = pdf_lib.open()
    # Trang 0: đường bế MAGENTA CMYK (0,1,0,0) — màu bế của DetectionConfig.
    p0 = doc.new_page(width=100.0, height=100.0)
    s0 = p0.new_shape()
    s0.draw_rect(pdf_lib.Rect(10.0, 10.0, 90.0, 90.0))
    s0.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)  # stroke magenta
    s0.commit()
    # Trang 1: artwork ĐEN khép kín (nội dung) — KHÔNG phải đường bế.
    p1 = doc.new_page(width=100.0, height=100.0)
    s1 = p1.new_shape()
    s1.draw_rect(pdf_lib.Rect(20.0, 20.0, 70.0, 70.0))
    s1.finish(color=(0.0, 0.0, 0.0, 1.0), fill=(0.0, 0.0, 0.0, 1.0))
    s1.commit()
    out = tmp_path / "diecheck.pdf"
    doc.save(str(out))
    doc.close()

    d2 = pdf_lib.open(str(out))
    try:
        die_master = sh.page_has_die(d2[0])
        die_content = sh.page_has_die(d2[1])
    finally:
        d2.close()

    assert die_master is True, "trang khuôn magenta phải được nhận là CÓ đường bế"
    assert die_content is False, "trang artwork đen KHÔNG được nhầm là có đường bế"
