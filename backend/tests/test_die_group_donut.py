"""Test gộp layer bế: khuôn nhiều vòng (chữ O / donut) → 1 khuôn đủ nét.

Phủ 2 cách PDF mã hóa:
  TH-A: 1 compound path (cả 2 vòng trong items của 1 drawing).
  TH-B: 2 drawing riêng cùng spot → phải GỘP, không mất vòng trong.
"""
import pytest

from app.workers.die_detection import (
    _collect_die_group, _merge_die_paths, _select_from_paths, DetectionConfig,
)


class _R:
    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
        self.width = x1 - x0
        self.height = y1 - y0


def _ring_items(n):
    # n item giả lập (mỗi vòng vài đoạn 'c') — chỉ cần đếm được.
    return [('c', None, None, None, None)] * n


def _path(x0, y0, x1, y1, *, type='s', spot=None, color=None, fill=None,
          width=0.8, close=True, nitems=6):
    return {
        'rect': _R(x0, y0, x1, y1), 'type': type, 'spot_name': spot,
        'color': color, 'fill': fill, 'width': width, 'closePath': close,
        'items': _ring_items(nitems),
    }


PAGE = _R(0, 0, 239.0, 227.0)
CFG = DetectionConfig()
SPOT = 'C=0 M=100 Y=0 K=0'


def test_th_a_single_compound_path_kept_whole():
    # 1 drawing chứa cả 2 vòng (12 items). Nền fill riêng.
    bg = _path(5, 5, 220, 200, type='f', spot=None, fill=(0.0, 1.0, 1.0, 0.0), nitems=4)
    donut = _path(20, 20, 200, 190, type='s', spot=SPOT, color=(1, 1, 1), nitems=12)
    anchor, _, _ = _select_from_paths([bg, donut], PAGE, CFG.die_channel_names,
                                      CFG.die_colors, CFG.die_color_tol)
    assert anchor is donut
    members = _collect_die_group([bg, donut], anchor, PAGE, CFG.die_colors, CFG.die_color_tol)
    merged = _merge_die_paths(members)
    assert len(merged['items']) == 12  # nguyên vẹn


def test_th_b_two_separate_rings_are_merged():
    # Vòng ngoài + vòng trong là 2 drawing RIÊNG cùng spot bế.
    bg = _path(5, 5, 220, 200, type='f', spot=None, fill=(0.0, 1.0, 1.0, 0.0), nitems=4)
    outer = _path(20, 20, 200, 190, type='s', spot=SPOT, color=(1, 1, 1), nitems=8)
    inner = _path(70, 70, 150, 140, type='s', spot=SPOT, color=(1, 1, 1), nitems=8)
    paths = [bg, outer, inner]
    anchor, by_spot, _ = _select_from_paths(paths, PAGE, CFG.die_channel_names,
                                            CFG.die_colors, CFG.die_color_tol)
    assert anchor is outer  # vòng ngoài điểm cao nhất (diện tích lớn hơn)
    assert by_spot is True
    members = _collect_die_group(paths, anchor, PAGE, CFG.die_colors, CFG.die_color_tol)
    assert outer in members and inner in members and bg not in members
    merged = _merge_die_paths(members)
    # Cả 2 vòng được vẽ (16 items), KHÔNG mất lỗ.
    assert len(merged['items']) == 16
    # bbox bao trọn vòng ngoài.
    assert merged['rect'].x0 == 20 and merged['rect'].x1 == 200


def test_no_die_signal_does_not_overgroup():
    # Không spot, không màu bế → không chọn path nào (không đoán nét artwork).
    s1 = _path(10, 10, 120, 110, type='s', spot=None, color=(0, 0, 0), nitems=6)
    s2 = _path(10, 10, 150, 120, type='s', spot=None, color=(0, 0, 0), nitems=6)
    paths = [s1, s2]
    anchor, by_spot, is_fb = _select_from_paths(paths, PAGE, (), (), 0.06)
    assert anchor is None
    assert by_spot is False
    assert is_fb is False


def test_magenta_no_spot_donut_merged_by_color():
    # Donut magenta thuần KHÔNG spot → gộp theo màu bế.
    outer = _path(20, 20, 200, 190, type='s', spot=None, color=(0.0, 1.0, 0.0, 0.0), nitems=8)
    inner = _path(70, 70, 150, 140, type='s', spot=None, color=(0.0, 1.0, 0.0, 0.0), nitems=8)
    bg = _path(5, 5, 220, 200, type='f', spot=None, fill=(0.1, 0.2, 0.3), nitems=4)
    paths = [outer, inner, bg]
    anchor, _, _ = _select_from_paths(paths, PAGE, CFG.die_channel_names, CFG.die_colors, CFG.die_color_tol)
    members = _collect_die_group(paths, anchor, PAGE, CFG.die_colors, CFG.die_color_tol)
    assert outer in members and inner in members and bg not in members
    assert len(_merge_die_paths(members)['items']) == 16
