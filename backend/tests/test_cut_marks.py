"""
Unit tests cho draw_tile_cut_marks — kiểm chứng logic vẽ dấu xén:
  - Bỏ qua 4 góc ngoài cùng (chỗ ốc kẹp)
  - Nét đôi kiểu Nhật (japanese) sinh gấp đôi số nét cạnh biên
  - Độ dày nét (mark_thickness) được truyền đúng vào shape.finish
  - bleed_pt <= 0 thì japanese tự fallback về nét đơn

Không cần render PDF thật: dùng mock page/shape để bắt lời gọi draw_line.
"""
import math
import pytest

from app.workers.cluster_tile_engine import draw_tile_cut_marks


class FakeShape:
    def __init__(self):
        self.lines = []          # list[((x1,y1),(x2,y2))]
        self.finish_kwargs = None
        self.committed = False

    def draw_line(self, p1, p2):
        self.lines.append(((p1.x, p1.y), (p2.x, p2.y)))

    def finish(self, **kwargs):
        self.finish_kwargs = kwargs

    def commit(self):
        self.committed = True


class FakePage:
    def __init__(self):
        self.shape = FakeShape()

    def new_shape(self):
        return self.shape


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
    # Nét cạnh trên (y < 0) và dưới (y > 100) tại x là góc → không tồn tại
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
    assert page.shape.lines == []
