"""
Unit test kiểm chứng tính năng đường cắt chia cụm (CMYK tuỳ chỉnh + cắt đứt hết khổ giấy CNC).
"""
import pytest
from app.workers.cluster_tile_engine import draw_tile_cut_marks


def _pt(p):
    return (p.x, p.y) if hasattr(p, 'x') else (float(p[0]), float(p[1]))


class FakeShape:
    def __init__(self):
        self.lines = []
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


GRID_3x3 = {
    'v': {50.0, 150.0, 250.0},
    'h': {50.0, 150.0, 250.0},
}


def test_default_cluster_cut_marks():
    """Mặc định khi không có cmyk_color và full_sheet: nét đứt [4, 4], registration (1, 1, 1, 1), trong phạm vi cụm."""
    page = FakePage()
    draw_tile_cut_marks(page, GRID_3x3, mark_thickness=0.71)
    assert len(page.shapes) == 2
    dash_shape = page.shapes[1]
    assert dash_shape.finish_kwargs.get('color') == (1, 1, 1, 1)
    assert dash_shape.finish_kwargs.get('dashes') == [4, 4]
    assert len(dash_shape.lines) == 2
    # Nằm trong phạm vi min..max cụm (50..250)
    assert ((150.0, 50.0), (150.0, 250.0)) in dash_shape.lines
    assert ((50.0, 150.0), (250.0, 150.0)) in dash_shape.lines


def test_cmyk_color_cluster_cut_marks():
    """Người dùng nhập thông số CMYK (ví dụ Đỏ ThruCut: C0 M100 Y100 K0)."""
    page = FakePage()
    draw_tile_cut_marks(
        page, GRID_3x3,
        cmyk_color=[0, 100, 100, 0],
        mark_thickness=0.71,
    )
    assert len(page.shapes) == 2
    dash_shape = page.shapes[1]
    assert dash_shape.finish_kwargs.get('color') == (0.0, 1.0, 1.0, 0.0)


def test_cmyk_color_0_to_1_range():
    """Hỗ trợ cả định dạng 0..1 chuẩn CMYK."""
    page = FakePage()
    draw_tile_cut_marks(
        page, GRID_3x3,
        cmyk_color=(0.0, 0.0, 0.0, 1.0),  # Black K100
        mark_thickness=0.71,
    )
    dash_shape = page.shapes[1]
    assert dash_shape.finish_kwargs.get('color') == (0.0, 0.0, 0.0, 1.0)


def test_full_sheet_cnc_cut_marks():
    """Cắt đứt hết khổ giấy khi tắt dấu xén: chỉ có 1 shape đường cắt CNC."""
    sheet_w = 600.0
    sheet_h = 800.0
    page = FakePage()
    draw_tile_cut_marks(
        page, GRID_3x3,
        cmyk_color=[0, 100, 100, 0],
        full_sheet=True,
        sheet_w=sheet_w,
        sheet_h=sheet_h,
        oc=999,
        post_die_cut_marks=False,
    )
    assert len(page.shapes) == 1  # Chỉ có đường cắt CNC
    dash_shape = page.shapes[0]
    # Nét liền, không có dashes
    assert dash_shape.finish_kwargs.get('dashes') is None
    # Màu CMYK đỏ
    assert dash_shape.finish_kwargs.get('color') == (0.0, 1.0, 1.0, 0.0)
    # Gắn vào OCG xref
    assert dash_shape.finish_kwargs.get('oc') == 999
    # Đường cắt chạy xuyên suốt từ 0 đến sheet_h / sheet_w
    v_cut = next(l for l in dash_shape.lines if l[0][0] == l[1][0])
    h_cut = next(l for l in dash_shape.lines if l[0][1] == l[1][1])
    assert v_cut == ((150.0, 0.0), (150.0, sheet_h))
    assert h_cut == ((0.0, 150.0), (sheet_w, 150.0))


def test_full_sheet_with_post_die_cut_marks():
    """Khi bật cả Cắt đứt CNC lẫn Dấu bế xong xén: có cả 2 shapes."""
    sheet_w = 600.0
    sheet_h = 800.0
    page = FakePage()
    draw_tile_cut_marks(
        page, GRID_3x3,
        cmyk_color=[0, 100, 100, 0],
        full_sheet=True,
        sheet_w=sheet_w,
        sheet_h=sheet_h,
        post_die_cut_marks=True,
    )
    assert len(page.shapes) == 2  # Shape 0: Dấu bế xong xén (tick marks), Shape 1: Đường cắt CNC


def test_no_cut_marks_when_both_disabled():
    """Khi tắt cả Dấu bế xong xén lẫn Cắt đứt CNC: không vẽ shape nào."""
    page = FakePage()
    draw_tile_cut_marks(
        page, GRID_3x3,
        full_sheet=False,
        post_die_cut_marks=False,
    )
    assert len(page.shapes) == 0


def test_contract_be_xong_xen_tren_trang_in_va_cat_dut_tren_trang_be():
    """
    Hợp đồng:
    - 'nếu là bế xong xén thì đường đó sẽ nằm ở trang in' (post_die_cut_marks=True, full_sheet=False)
    - 'nếu cắt đứt hết khổ thì đường đó sẽ nằm ở trang bế' (post_die_cut_marks=False, full_sheet=True)
    """
    sheet_w, sheet_h = 600.0, 800.0

    # 1. Trang in (out_page): Chỉ bật bế xong xén
    out_page = FakePage()
    draw_tile_cut_marks(
        out_page, GRID_3x3,
        cmyk_color=[0, 100, 100, 0],
        full_sheet=False,  # Trên trang in không vẽ cắt đứt hết khổ khi có trang bế riêng
        post_die_cut_marks=True,  # Dấu bế xong xén nằm ở trang in
        sheet_w=sheet_w,
        sheet_h=sheet_h,
    )
    # Trang in có dấu xén (tick marks ở biên và nét đứt giữa các cụm)
    assert len(out_page.shapes) == 2
    # Không có đường nào cắt xuyên suốt từ 0 đến sheet_h / sheet_w
    all_lines = out_page.shapes[0].lines + out_page.shapes[1].lines
    assert not any(l[0][1] == 0.0 and l[1][1] == sheet_h for l in all_lines)

    # 2. Trang bế (out_page_cut): Chỉ bật cắt đứt hết khổ CNC
    out_page_cut = FakePage()
    draw_tile_cut_marks(
        out_page_cut, GRID_3x3,
        cmyk_color=[0, 100, 100, 0],
        full_sheet=True,  # Cắt đứt hết khổ nằm ở trang bế
        post_die_cut_marks=False,  # Không vẽ dấu xén trên trang bế
        sheet_w=sheet_w,
        sheet_h=sheet_h,
    )
    # Trang bế chỉ có đúng 1 shape là đường cắt CNC
    assert len(out_page_cut.shapes) == 1
    cnc_lines = out_page_cut.shapes[0].lines
    # Có đường cắt xuyên suốt từ mép này sang mép kia khổ giấy
    assert any(l[0][1] == 0.0 and l[1][1] == sheet_h for l in cnc_lines)
    assert any(l[0][0] == 0.0 and l[1][0] == sheet_w for l in cnc_lines)


