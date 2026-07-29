"""Lớp gia công không phải đường bế + quy ước lớp bế nằm trên cùng.

Ca thật khách báo (2026-07-28): file có kênh spot mực TRẮNG để in, bị nhận thành
đường cắt. Gốc lỗi: mọi kênh Separation không-phải-process đều được +400 điểm
("spot nào cũng có thể là bế"), nên lớp trắng thắng cả đường bế nhận theo màu (+300).

Hai cơ chế được kiểm ở đây:
  1. deny-list tên kênh lớp gia công (trắng / phủ UV / ép kim / dập nổi).
  2. [DIE-ZORDER] khi không kênh nào mang tên bế, lấy LỚP TRÊN CÙNG theo thứ tự tô
     — bế là khâu sau cùng nên thợ đặt lớp bế trên đỉnh cây đối tượng.
"""
from app.workers.die_detection import (
    DetectionConfig, _is_non_die_spot, _select_from_paths,
)
from app.workers.pdf_content_parser import parse_content_stream


class _R:
    def __init__(self, w, h, x0=0.0, y0=0.0):
        self.x0, self.y0 = x0, y0
        self.x1, self.y1 = x0 + w, y0 + h
        self.width = w
        self.height = h


def _path(w, h, *, type='s', spot=None, color=None, fill=None, width=0.8,
          close=True, paint_index=None, x0=0.0, y0=0.0):
    p = {
        'rect': _R(w, h, x0, y0), 'type': type, 'spot_name': spot,
        'color': color, 'fill': fill, 'width': width, 'closePath': close,
    }
    if paint_index is not None:
        p['paint_index'] = paint_index
    return p


PAGE = _R(239.0, 227.0)
CFG = DetectionConfig()
MAGENTA = (0.0, 1.0, 0.0, 0.0)


def _pick(paths):
    return _select_from_paths(paths, PAGE, CFG.die_channel_names,
                              CFG.die_colors, CFG.die_color_tol)


# ----------------------------------------------------------------- deny-list

def test_white_ink_spot_variants_are_not_die():
    for name in (
        'White', 'WHITE', 'White Ink', 'WhiteInk', 'White_Ink', 'Opaque White',
        'Spot White', 'White 100', 'PANTONE White', 'Trắng', 'Mực trắng',
        'Blanco', 'Weiss', 'Underprint White',
    ):
        assert _is_non_die_spot(name) is True, name


def test_other_finishing_layers_are_not_die():
    for name in (
        'Varnish', 'Gloss Varnish', 'Matt Varnish', 'Spot UV', 'SpotUV', 'UV',
        'Phủ UV', 'Hot Foil', 'ColdFoil', 'Ép nhũ', 'Metallic', 'Silver',
        'Emboss', 'Deboss', 'Primer', 'Braille',
    ):
        assert _is_non_die_spot(name) is True, name


def test_real_spot_names_are_not_denied():
    """Không loại oan: tên spot thường + tên kênh bế phải đi qua deny-list."""
    for name in (
        'Gold-Pantone', 'C=0 M=100 Y=0 K=0', 'PANTONE 877 C', 'CutContour',
        'Dieline', 'Kiss Cut', 'Crease', None, '',
    ):
        assert _is_non_die_spot(name) is False, name


def test_die_hint_survives_finishing_word():
    """'Matte Cut' có từ khoá bế → không bị deny-list loại (thà nhận hơn mất khuôn)."""
    assert _is_non_die_spot('Matte Cut') is False
    assert _is_non_die_spot('UV Dieline') is False


def test_white_spot_stroke_loses_to_magenta_die():
    """Ca khách báo: nét kênh trắng KHÔNG được thắng đường bế magenta không spot."""
    white = _path(210.0, 190.0, spot='White Ink', color=(1.0, 1.0, 1.0), paint_index=0)
    die = _path(197.2, 170.8, spot=None, color=MAGENTA, paint_index=1)
    chosen, by_spot, _ = _pick([white, die])
    assert chosen is die
    assert by_spot is False


def test_white_spot_alone_is_not_a_die():
    """Trang chỉ có artwork + lớp trắng → KHÔNG dựng khuôn giả, trả None (khổ trang)."""
    art = _path(220.0, 200.0, spot=None, color=(0.35, 0.2, 0.1), width=3.0)
    white = _path(210.0, 190.0, spot='White Ink', color=(1.0, 1.0, 1.0))
    chosen, by_spot, is_fb = _pick([art, white])
    assert chosen is None
    assert by_spot is False
    assert is_fb is False


def test_white_spot_at_zero_tint_not_rescued_by_color_match():
    """Tint 0 của kênh spot trùng 'DeviceGray đen' trong die_colors → vẫn phải loại."""
    white = _path(210.0, 190.0, spot='White Ink', color=(0.0,))
    chosen, _, _ = _pick([white])
    assert chosen is None


def test_varnish_spot_does_not_steal_from_named_die():
    """Phủ UV nằm TRÊN đường bế: tên kênh bế vẫn thắng vị trí."""
    die = _path(197.2, 170.8, spot='CutContour', color=(1, 1, 1), paint_index=0)
    varnish = _path(220.0, 200.0, spot='Spot UV', color=(1, 1, 1), paint_index=9)
    chosen, by_spot, _ = _pick([die, varnish])
    assert chosen is die
    assert by_spot is True


# ------------------------------------------------------------------- z-order

def test_topmost_unknown_spot_layer_wins():
    """Hai kênh spot lạ: lớp TÔ SAU (trên cùng) là lớp bế."""
    lower = _path(215.0, 195.0, spot='Layer-A', color=(1, 1, 1), paint_index=0)
    upper = _path(197.2, 170.8, spot='Layer-B', color=(1, 1, 1), paint_index=1)
    chosen, by_spot, _ = _pick([lower, upper])
    assert chosen is upper
    assert by_spot is True


def test_topmost_wins_even_when_lower_layer_is_bigger():
    """Diện tích KHÔNG được vượt vị trí khi hai lớp khác nhau."""
    big_lower = _path(230.0, 215.0, spot='Layer-A', color=(1, 1, 1), paint_index=0)
    small_upper = _path(120.0, 100.0, spot='Layer-B', color=(1, 1, 1), paint_index=1)
    chosen, _, _ = _pick([big_lower, small_upper])
    assert chosen is small_upper


def test_paint_index_overrides_list_position():
    """Xếp hạng theo 'paint_index' của parser, không theo thứ tự list truyền vào."""
    a = _path(197.2, 170.8, spot='Layer-A', color=(1, 1, 1), paint_index=5)
    b = _path(215.0, 195.0, spot='Layer-B', color=(1, 1, 1), paint_index=2)
    chosen, _, _ = _pick([b, a])   # list đảo ngược so với thứ tự tô
    assert chosen is a


def test_same_layer_keeps_area_ranking_for_donut():
    """Trong CÙNG lớp bế, vòng ngoài (diện tích lớn) vẫn là khổ thành phẩm.

    Bảo vệ khuôn nhiều vòng: vòng trong tô SAU, nếu vị trí thắng diện tích trong
    cùng lớp thì trim bị lấy theo lỗ giữa.
    """
    spot = 'C=0 M=100 Y=0 K=0'
    outer = _path(180.0, 170.0, spot=spot, color=(1, 1, 1), paint_index=0, x0=20, y0=20)
    inner = _path(80.0, 70.0, spot=spot, color=(1, 1, 1), paint_index=1, x0=70, y0=70)
    chosen, _, _ = _pick([outer, inner])
    assert chosen is outer


# -------------------------------------------------------------- parser wiring

def test_parser_assigns_sequential_paint_index():
    """parse_content_stream gắn paint_index tăng dần theo thứ tự tô."""
    stream = b"0 0 1 RG 10 10 50 50 re S 20 20 30 30 re S 40 40 20 20 re S"
    drawings = parse_content_stream(stream, 200.0)
    assert len(drawings) == 3
    assert [d['paint_index'] for d in drawings] == [0, 1, 2]


# ------------------------------------------------------- tint kênh spot ≠ màu

def test_process_separation_at_zero_tint_is_not_die():
    """Separation /Black ở tint 0 (0% mực) không được tính là 'nét đen = bế'.

    Parser nhân tint một thành phần thành (t,t,t) để giữ hợp đồng màu 3 thành phần,
    nên tint 0 ra đúng (0,0,0) = đen RGB — trùng một màu bế quy ước.
    """
    art = _path(200.0, 180.0, spot='Black', color=(0.0, 0.0, 0.0))
    chosen, _, _ = _pick([art])
    assert chosen is None


def test_devicegray_black_stroke_without_spot_still_die():
    """Đối chứng: nét đen DeviceGray thật (không spot) vẫn là tín hiệu bế."""
    die = _path(197.2, 170.8, spot=None, color=(0.0, 0.0, 0.0))
    chosen, by_spot, _ = _pick([die])
    assert chosen is die
    assert by_spot is False


def test_spot_die_not_ranked_by_tint_colour():
    """Hai nét cùng kênh spot, tint khác nhau → điểm bằng nhau, diện tích quyết định.

    Trước đây nét ở tint 0 được +300 'màu bế' nên vòng TRONG có thể vượt vòng ngoài
    và bị lấy làm khổ thành phẩm.
    """
    spot = 'C=0 M=100 Y=0 K=0'
    outer = _path(180.0, 170.0, spot=spot, color=(1.0, 1.0, 1.0), paint_index=0, x0=20, y0=20)
    inner = _path(80.0, 70.0, spot=spot, color=(0.0, 0.0, 0.0), paint_index=1, x0=70, y0=70)
    chosen, _, _ = _pick([outer, inner])
    assert chosen is outer


def test_die_color_group_ignores_spot_tint_stroke():
    """Gộp nhóm theo màu không được hút nét kênh spot ở tint 0 (trùng đen)."""
    from app.workers.die_detection import _collect_die_group

    die = _path(180.0, 170.0, spot=None, color=MAGENTA, x0=20, y0=20)
    spot_zero = _path(60.0, 50.0, spot='White Ink', color=MAGENTA, x0=40, y0=40)
    members = _collect_die_group([die, spot_zero], die, PAGE,
                                 CFG.die_colors, CFG.die_color_tol)
    assert die in members and spot_zero not in members
