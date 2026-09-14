"""Test P1: chọn đường bế bằng chấm điểm đa tín hiệu (_select_from_paths).

Bám ca thật của file 'cac loai hinh.pdf': đường bế là STROKE mảnh có spot_name
'C=0 M=100 Y=0 K=0' (kênh spot, KHÔNG nằm trong list tên kênh mặc định), màu bị
parse thành trắng; nền là FILL không spot.

Nguyên tắc (2026-07): chỉ chấp nhận TÍN HIỆU MẠNH (tên kênh / spot-stroke /
màu-bế-stroke). Không đoán path/stroke lớn nhất khi thiếu tín hiệu — tránh lấy
miếng màu artwork làm khổ tem.
"""
import pytest

from app.workers.die_detection import (
    _select_from_paths, _is_genuine_spot, _color_matches_die, _match_die_channel,
    DetectionConfig,
)


class _R:
    def __init__(self, w, h):
        self.width = w
        self.height = h


def _path(w, h, *, type='s', spot=None, color=None, fill=None, width=0.8, close=True):
    return {
        'rect': _R(w, h), 'type': type, 'spot_name': spot,
        'color': color, 'fill': fill, 'width': width, 'closePath': close,
    }


PAGE = _R(239.0, 227.0)
CFG = DetectionConfig()


def test_genuine_spot_detection():
    assert _is_genuine_spot('C=0 M=100 Y=0 K=0') is True
    assert _is_genuine_spot('CutContour') is True
    assert _is_genuine_spot('Magenta') is False
    assert _is_genuine_spot('Cyan+Magenta') is False
    assert _is_genuine_spot(None) is False


def test_color_match_default_die_palette():
    # Magenta / đen / xanh / vàng 100% (CMYK + RGB + gray)
    assert _color_matches_die((0.0, 1.0, 0.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((1.0, 0.0, 1.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((0.0, 0.0, 0.0, 1.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((0.0, 0.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((1.0, 0.0, 0.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((0.0, 0.0, 1.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((0.0, 1.0, 1.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((0.0, 0.0, 1.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((1.0, 1.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    # Dung sai: gần K100 vẫn khớp
    assert _color_matches_die((0.02, 0.0, 0.0, 0.98), CFG.die_colors, CFG.die_color_tol)
    # Đỏ CMYK và RGB nay đã thuộc bảng màu bế chuẩn (prepress VN)
    assert _color_matches_die((0.0, 1.0, 1.0, 0.0), CFG.die_colors, CFG.die_color_tol)  # đỏ CMYK
    assert _color_matches_die((1.0, 0.0, 0.0), CFG.die_colors, CFG.die_color_tol)  # đỏ RGB
    # Không khớp màu hỗn hợp / trắng / thiếu
    assert not _color_matches_die((1.0, 0.0, 1.0, 0.0), CFG.die_colors, CFG.die_color_tol)  # xanh lá C100 Y100
    assert not _color_matches_die((1.0, 1.0, 1.0), CFG.die_colors, CFG.die_color_tol)
    assert not _color_matches_die(None, CFG.die_colors, CFG.die_color_tol)
    # [DIE-TINT 2026-07-28] Bảng màu bế KHÔNG còn mục 1 thành phần. DeviceGray đen đi
    # qua 'G'/'g' đã là (0,0,0) nên vẫn khớp; còn tuple 1 số chỉ có thể là tint kênh
    # spot, và tint không nói gì về sắc màu.
    assert not _color_matches_die((0.0,), CFG.die_colors, CFG.die_color_tol)
    assert not _color_matches_die((1.0,), CFG.die_colors, CFG.die_color_tol)


def test_select_picks_black_yellow_or_cyan_stroke_without_spot():
    """Đường bế nét thuần đen/vàng/xanh (không spot) vẫn được chọn thay vì fill artwork."""
    bg = _path(200, 200, type='f', fill=(0.9, 0.9, 0.9), color=None)
    for color in (
        (0.0, 0.0, 0.0, 1.0),  # K100
        (0.0, 0.0, 1.0, 0.0),  # Y100
        (1.0, 0.0, 0.0, 0.0),  # C100
    ):
        die = _path(80, 80, type='s', color=color, width=0.5)
        picked, by_spot, is_fb = _select_from_paths(
            [bg, die], PAGE, CFG.die_channel_names, CFG.die_colors, CFG.die_color_tol,
        )
        assert picked is die, f"expected die color {color}"
        assert by_spot is False
        assert is_fb is False


def test_channel_name_normalized_variants():
    names = frozenset(n.strip().lower() for n in CFG.die_channel_names)
    assert _match_die_channel('CutContour', names)
    assert _match_die_channel('Cut Contour', names)
    assert _match_die_channel('cut-contour', names)
    assert _match_die_channel('Die Line', names)
    assert not _match_die_channel('Gold-Pantone', names)


def test_real_file_case_picks_spot_stroke_over_bigger_fill():
    # Giống file thật: nền fill LỚN HƠN nhưng không spot; đường bế stroke spot nhỏ hơn.
    bg = _path(207.6, 179.7, type='f', spot=None, fill=(0.0, 1.0, 1.0, 0.0), width=1.0)
    die = _path(197.2, 170.8, type='s', spot='C=0 M=100 Y=0 K=0', color=(1.0, 1.0, 1.0), width=0.9)
    chosen, by_spot, is_fb = _select_from_paths([bg, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True
    assert is_fb is False


def test_extra_artwork_stroke_does_not_steal():
    # Có thêm stroke artwork to (không spot, màu không trong palette bế) → vẫn chọn spot.
    art_stroke = _path(220.0, 200.0, type='s', spot=None, color=(0.35, 0.2, 0.1), width=3.0, close=False)
    die = _path(197.2, 170.8, type='s', spot='Dieline', color=(1, 1, 1), width=0.9)
    chosen, by_spot, _ = _select_from_paths([art_stroke, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True


def test_magenta_diecut_without_spot():
    # Đường bế magenta thuần KHÔNG spot → vẫn nhận nhờ khớp màu + stroke.
    bg = _path(207.6, 179.7, type='f', spot=None, fill=(0.1, 0.2, 0.3), width=1.0)
    die = _path(197.2, 170.8, type='s', spot=None, color=(0.0, 1.0, 0.0, 0.0), width=0.9)
    chosen, by_spot, _ = _select_from_paths([bg, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is False  # khớp màu, không phải spot


def test_magenta_fill_alone_is_not_die():
    # Mảng tô magenta (logo/artwork) KHÔNG đủ tín hiệu bế — chỉ nét palette bế mới là bế.
    # Artwork stroke dùng màu ngoài palette (nâu) — nét đen thuần giờ CŨNG là tín hiệu bế.
    fill_blob = _path(180.0, 160.0, type='f', spot=None, fill=(0.0, 1.0, 0.0, 0.0), width=1.0)
    art = _path(100.0, 90.0, type='s', spot=None, color=(0.4, 0.25, 0.1), width=1.0)
    chosen, _, _ = _select_from_paths([fill_blob, art], PAGE, CFG.die_channel_names,
                                      CFG.die_colors, CFG.die_color_tol)
    assert chosen is None


def test_stroke_plus_fill_not_die_even_with_channel_name():
    # type sf / có fill → không phải đường bế nét thuần → fallback None (khổ trang).
    sf = _path(180.0, 160.0, type='sf', spot='CutContour',
               color=(0.0, 1.0, 0.0, 0.0), fill=(0.0, 1.0, 0.0, 0.0), width=0.8)
    chosen, _, _ = _select_from_paths([sf], PAGE, CFG.die_channel_names,
                                      CFG.die_colors, CFG.die_color_tol)
    assert chosen is None


def test_stroke_with_fill_paint_not_die():
    # type 's' nhưng vẫn gắn fill paint → coi như có tô, loại.
    s_fill = _path(180.0, 160.0, type='s', spot=None,
                   color=(0.0, 1.0, 0.0, 0.0), fill=(0.0, 1.0, 0.0, 0.0), width=0.8)
    chosen, _, _ = _select_from_paths([s_fill], PAGE, CFG.die_channel_names,
                                      CFG.die_colors, CFG.die_color_tol)
    assert chosen is None


def test_named_channel_fill_only_falls_back_to_page():
    # Có "tên" CutContour nhưng chỉ là mảng tô → không nhận; không nét palette bế → None.
    fill_named = _path(180.0, 160.0, type='f', spot='CutContour',
                       fill=(0.0, 1.0, 0.0, 0.0), width=1.0)
    art = _path(100.0, 90.0, type='s', spot=None, color=(0.4, 0.25, 0.1), width=1.0)
    chosen, _, _ = _select_from_paths([fill_named, art], PAGE, CFG.die_channel_names,
                                      CFG.die_colors, CFG.die_color_tol)
    assert chosen is None


def test_no_signal_returns_none_not_largest_path():
    # Không spot, không màu bế (palette rỗng) → KHÔNG đoán path/stroke lớn nhất.
    s1 = _path(100.0, 90.0, type='s', spot=None, color=(0, 0, 0), width=1.0)
    s2 = _path(150.0, 120.0, type='s', spot=None, color=(0, 0, 0), width=1.0)
    fill = _path(180.0, 160.0, type='f', spot=None, fill=(0.2, 0.4, 0.1), width=1.0)
    chosen, by_spot, is_fb = _select_from_paths([s1, s2, fill], PAGE, (), (), 0.06)
    assert chosen is None
    assert by_spot is False
    assert is_fb is False


def test_channel_name_dominates_spot():
    # Khớp tên kênh cấu hình (+1000) phải thắng kênh spot bất kỳ (+400).
    spot_other = _path(200.0, 180.0, type='s', spot='Gold-Pantone', color=(1, 1, 1), width=0.9)
    cut = _path(150.0, 130.0, type='s', spot='CutContour', color=(1, 1, 1), width=0.9)
    chosen, by_spot, _ = _select_from_paths([spot_other, cut], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is cut
    assert by_spot is True


def test_spot_fill_does_not_become_die():
    # audit #8: mảng TÔ trên kênh spot (logo Pantone) + nét artwork ngoài palette
    # → không có tín hiệu bế thật → None (không chọn nhầm fill).
    spot_fill = _path(220.0, 200.0, type='f', spot='Gold-Pantone',
                      fill=(0.1, 0.2, 0.3, 0.0), width=1.0, close=True)
    art_stroke = _path(150.0, 130.0, type='s', spot=None, color=(0.35, 0.2, 0.15), width=0.5, close=True)
    chosen, by_spot, _ = _select_from_paths([spot_fill, art_stroke], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is None
    assert by_spot is False


def test_spot_stroke_still_wins_after_fix():
    # Bảo toàn: đường bế là NÉT trên kênh spot vẫn thắng mảng tô không-spot lớn hơn.
    bg_fill = _path(220.0, 200.0, type='f', spot=None, fill=(0.2, 0.2, 0.2), width=1.0)
    die = _path(150.0, 130.0, type='s', spot='Gold-Pantone', color=(1, 1, 1), width=0.8)
    chosen, by_spot, _ = _select_from_paths([bg_fill, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True


def test_cut_contour_spaced_name():
    # Biến thể tên kênh có khoảng trắng.
    art = _path(200.0, 180.0, type='s', spot=None, color=(0, 0, 0), width=2.0)
    die = _path(150.0, 130.0, type='s', spot='Cut Contour', color=(1, 0, 1), width=0.5)
    chosen, by_spot, _ = _select_from_paths([art, die], PAGE, CFG.die_channel_names,
                                            CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True
