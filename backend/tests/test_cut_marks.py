"""
Unit tests cho draw_tile_cut_marks — kiểm chứng logic vẽ dấu xén:
  - Bỏ qua 4 góc ngoài cùng (chỗ ốc kẹp)
  - Nét đôi kiểu Nhật (japanese) sinh gấp đôi số nét cạnh biên
  - Độ dày nét (mark_thickness) được truyền đúng vào shape.finish
  - bleed_pt <= 0 thì japanese tự fallback về nét đơn
  - Đường nét đứt (dashed line) phân ranh giới xuyên suốt giữa các cụm

Không cần render PDF thật: dùng mock page/shape để bắt lời gọi draw_line.
"""
import math
import pytest

from app.workers.cluster_tile_engine import draw_tile_cut_marks, draw_segment_cut_marks


def _pt(p):
    return (p.x, p.y) if hasattr(p, 'x') else (float(p[0]), float(p[1]))


class FakeShape:
    def __init__(self):
        self.lines = []          # list[((x1,y1),(x2,y2))]
        self.finish_kwargs = None
        self.committed = False

    def draw_line(self, p1, p2):
        self.lines.append((_pt(p1), _pt(p2)))

    def finish(self, **kwargs):
        self.finish_kwargs = kwargs

    def commit(self):
        self.committed = True


class FakePage:
    def __init__(self):
        self.shapes = []

    def new_shape(self):
        s = FakeShape()
        self.shapes.append(s)
        return s

    @property
    def shape(self):
        return self.shapes[0] if self.shapes else None


# Lưới 3×3 → có đúng 1 đường cắt nội bộ mỗi chiều
GRID_3x3 = {'v': {0.0, 50.0, 100.0}, 'h': {0.0, 50.0, 100.0}}
CORNERS = {(0.0, 0.0), (0.0, 100.0), (100.0, 0.0), (100.0, 100.0)}


def _run(style='default', bleed_pt=0.0, thickness=0.71):
    page = FakePage()
    draw_tile_cut_marks(
        page, GRID_3x3,
        mark_off=8.51, mark_len=14.17,
        mark_thickness=thickness,
        mark_style=style, bleed_pt=bleed_pt,
    )
    return page.shape


def test_skips_outer_corners_on_edges():
    """Nét cạnh biên không được xuất phát tại 4 góc ngoài cùng."""
    shape = _run('default')
    for (x1, y1), (x2, y2) in shape.lines:
        # nét dọc ra biên trên/dưới
        if x1 == x2 and (y1 < 0 or y2 < 0 or y1 > 100 or y2 > 100):
            assert x1 not in (0.0, 100.0), f"Nét cạnh dọc tại góc {x1} không được vẽ"
        # nét ngang ra biên trái/phải
        if y1 == y2 and (x1 < 0 or x2 < 0 or x1 > 100 or x2 > 100):
            assert y1 not in (0.0, 100.0), f"Nét cạnh ngang tại góc {y1} không được vẽ"


def test_default_line_count():
    """Đếm số nét ở kiểu nét đơn cho lưới 3×3.

    Dấu cắt nội bộ là TICK ĐÔI (hai bên điểm cắt, có khoảng hở):
      • 4 cạnh biên: 1 nét/cạnh (đã bỏ 4 góc) = 4
      • Cut dọc nội bộ (x=50): h_cuts(3)×2 tick ngang + 2 nét ra biên trên/dưới = 8
      • Cut ngang nội bộ (y=50): v_cuts(3)×2 tick dọc + 2 nét ra biên trái/phải = 8
      → tổng 4 + 8 + 8 = 20
    """
    shape = _run('default')
    assert len(shape.lines) == 20


def test_japanese_doubles_edge_marks():
    """Kiểu Nhật: MỌI nét thành nét đôi (straddle ±bleed) → gấp đôi nét đơn."""
    single = _run('default')
    double = _run('japanese', bleed_pt=8.5)
    assert len(double.lines) > len(single.lines)
    # Mỗi tick (cả biên lẫn nội bộ) sinh 2 nét → 20 × 2 = 40
    assert len(double.lines) == 40


def test_japanese_marks_straddle_trim_by_bleed():
    """Nét đôi phải nằm hai bên đường trim, cách nhau 2×bleed."""
    bleed = 8.5
    shape = _run('japanese', bleed_pt=bleed)
    # Nét cạnh trên xuất phát từ x = 50 ± bleed (cut nội bộ duy nhất là 50)
    top_xs = sorted({x1 for (x1, y1), (x2, y2) in shape.lines
                     if x1 == x2 and y1 < 0})
    assert any(math.isclose(x, 50.0 - bleed) for x in top_xs)
    assert any(math.isclose(x, 50.0 + bleed) for x in top_xs)


def test_japanese_fallback_to_single_when_no_bleed():
    """bleed_pt = 0 → japanese hành xử như nét đơn."""
    assert len(_run('japanese', bleed_pt=0.0).lines) == len(_run('default').lines)


def test_thickness_passed_through():
    """mark_thickness phải tới shape.finish (không bị hardcode)."""
    shape = _run('default', thickness=1.23)
    assert shape.finish_kwargs is not None
    assert math.isclose(shape.finish_kwargs.get('width'), 1.23)
    assert shape.committed is True


def test_insufficient_cuts_is_noop():
    """Lưới thiếu đường cắt (<2) → không vẽ gì, không lỗi."""
    page = FakePage()
    draw_tile_cut_marks(page, {'v': {0.0}, 'h': {0.0}})
    assert page.shape is None or page.shape.lines == []


def test_dashed_lines_between_tiles():
    """Vẽ đường nét đứt xuyên suốt giữa các cụm theo trục cắt dọc và ngang."""
    page = FakePage()
    draw_tile_cut_marks(page, GRID_3x3, mark_thickness=0.71)
    assert len(page.shapes) == 2, "Cần 2 shape: 1 cho tick marks, 1 cho dashed lines"
    tick_shape = page.shapes[0]
    dash_shape = page.shapes[1]

    # Kiểm tra shape nét đứt
    assert dash_shape.finish_kwargs is not None
    assert dash_shape.finish_kwargs.get('dashes') == [4, 4]
    assert dash_shape.finish_kwargs.get('color') == (1, 1, 1, 1)
    assert dash_shape.committed is True

    # Lưới 3x3 có v={0, 50, 100}, h={0, 50, 100}
    # Đường cắt nội bộ: 1 trục x=50 từ y=0 đến 100; 1 trục y=50 từ x=0 đến 100
    assert len(dash_shape.lines) == 2
    v_line = next(l for l in dash_shape.lines if l[0][0] == l[1][0])
    h_line = next(l for l in dash_shape.lines if l[0][1] == l[1][1])

    assert v_line == ((50.0, 0.0), (50.0, 100.0))
    assert h_line == ((0.0, 50.0), (100.0, 50.0))


def test_segment_cut_marks_endpoints():
    """draw_segment_cut_marks vẽ 2 endpoint ticks cho mỗi segment."""
    page = FakePage()
    segments = [
        {'axis': 'x', 'coordinate': 150.0, 'start': 20.0, 'end': 200.0},
        {'axis': 'y', 'coordinate': 110.0, 'start': 10.0, 'end': 150.0},
    ]
    draw_segment_cut_marks(page, {'segments': segments}, mark_thickness=0.8)
    assert len(page.shapes) == 1
    assert len(page.shape.lines) == 4
