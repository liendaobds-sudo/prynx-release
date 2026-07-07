"""Test P1: chọn đường bế bằng chấm điểm đa tín hiệu (_select_from_paths).

Bám ca thật của file 'cac loai hinh.pdf': đường bế là STROKE mảnh có spot_name
'C=0 M=100 Y=0 K=0' (kênh spot, KHÔNG nằm trong list tên kênh mặc định), màu bị
parse thành trắng; nền là FILL không spot. Trước đây chỉ đúng nhờ "đúng 1 stroke".
"""
import pytest

from app.workers.die_detection import (
    _select_from_paths, _is_genuine_spot, _color_matches_die, DetectionConfig,
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


def test_color_match_magenta():
    assert _color_matches_die((0.0, 1.0, 0.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    assert _color_matches_die((1.0, 0.0, 1.0), CFG.die_colors, CFG.die_color_tol)
    assert not _color_matches_die((0.0, 1.0, 1.0, 0.0), CFG.die_colors, CFG.die_color_tol)
    assert not _color_matches_die(None, CFG.die_colors, CFG.die_color_tol)


def test_real_file_case_picks_spot_stroke_over_bigger_fill():
    # Giống file thật: nền fill LỚN HƠN nhưng không spot; đường bế stroke spot nhỏ hơn.
    bg = _path(207.6, 179.7, type='f', spot=None, fill=(0.0, 1.0, 1.0, 0.0), width=1.0)
    die = _path(197.2, 170.8, type='s', spot='C=0 M=100 Y=0 K=0', color=(1.0, 1.0, 1.0), width=0.9)
    chosen, by_spot, _ = _select_from_paths([bg, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True


def test_extra_artwork_stroke_does_not_steal():
    # Có thêm stroke artwork to (không spot) → vẫn phải chọn đường bế spot.
    art_stroke = _path(220.0, 200.0, type='s', spot=None, color=(0, 0, 0), width=3.0, close=False)
    die = _path(197.2, 170.8, type='s', spot='Dieline', color=(1, 1, 1), width=0.9)
    chosen, by_spot, _ = _select_from_paths([art_stroke, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True


def test_magenta_diecut_without_spot():
    # Đường bế magenta thuần KHÔNG spot → vẫn nhận nhờ khớp màu.
    bg = _path(207.6, 179.7, type='f', spot=None, fill=(0.1, 0.2, 0.3), width=1.0)
    die = _path(197.2, 170.8, type='s', spot=None, color=(0.0, 1.0, 0.0, 0.0), width=0.9)
    chosen, by_spot, _ = _select_from_paths([bg, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is False  # khớp màu, không phải spot


def test_no_signal_falls_back_to_largest_stroke():
    # Không spot, không màu bế → fallback: stroke lớn nhất.
    s1 = _path(100.0, 90.0, type='s', spot=None, color=(0, 0, 0), width=1.0)
    s2 = _path(150.0, 120.0, type='s', spot=None, color=(0, 0, 0), width=1.0)
    chosen, by_spot, _ = _select_from_paths([s1, s2], PAGE, (), (), 0.06)
    # cùng tín hiệu stroke/hairline → tie-break theo diện tích → s2
    assert chosen is s2
    assert by_spot is False


def test_channel_name_dominates_spot():
    # Khớp tên kênh cấu hình (+1000) phải thắng kênh spot bất kỳ (+400).
    spot_other = _path(200.0, 180.0, type='s', spot='Gold-Pantone', color=(1, 1, 1), width=0.9)
    cut = _path(150.0, 130.0, type='s', spot='CutContour', color=(1, 1, 1), width=0.9)
    chosen, by_spot, _ = _select_from_paths([spot_other, cut], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is cut
    assert by_spot is True


def test_spot_fill_does_not_steal_from_die_stroke():
    # audit #8: mảng TÔ trên kênh spot (vd logo Pantone) KHÔNG được nuốt đường bế.
    # Đường bế là NÉT mảnh, không trùng tên-kênh/màu cấu hình; mảng tô spot lớn hơn.
    # Trước khi vá: fill-spot (+400) > stroke (~190) → chọn nhầm. Sau vá: fill-spot
    # chỉ +80 (không phải nét) → đường bế thắng.
    spot_fill = _path(220.0, 200.0, type='f', spot='Gold-Pantone',
                      fill=(0.1, 0.2, 0.3, 0.0), width=1.0, close=True)
    die = _path(150.0, 130.0, type='s', spot=None, color=(0.0, 0.0, 0.0), width=0.5, close=True)
    chosen, by_spot, _ = _select_from_paths([spot_fill, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is False


def test_spot_stroke_still_wins_after_fix():
    # Bảo toàn: đường bế là NÉT trên kênh spot vẫn thắng mảng tô không-spot lớn hơn.
    bg_fill = _path(220.0, 200.0, type='f', spot=None, fill=(0.2, 0.2, 0.2), width=1.0)
    die = _path(150.0, 130.0, type='s', spot='Gold-Pantone', color=(1, 1, 1), width=0.8)
    chosen, by_spot, _ = _select_from_paths([bg_fill, die], PAGE, CFG.die_channel_names,
                                         CFG.die_colors, CFG.die_color_tol)
    assert chosen is die
    assert by_spot is True
