"""Hồi quy: reflow theo CỘT khi tem CUSTOM/lưới va chạm vùng cấm ở 2 ĐẦU một cột.

Bug đã sửa (báo bởi user): cột 5 tem chạm vùng cấm boong ở cả đầu trên + đầu dưới bị
xử lý THEO HÀNG độc lập → xóa 2 (giữ 3) thay vì xóa 1 + dồn/căn giữa 4 tem còn lại
trong băng trống giữa 2 vùng cấm. Đồng thời preview (khối ở 1 vị trí) và output (khối
lệch dọc) phải cho CÙNG số tem giữ lại.

Tái hiện đúng layout từ collision_debug.log (bài 28 tem, tờ 921×992). Dùng base_poly=None
→ va chạm = bbox∩zone (đúng tập va chạm như log thật)."""
from shapely.geometry import box
from app.workers.pont_collision import (
    smart_resolve_collisions, detect_collisions, _has_any_sticker_overlap,
)

SHEET_W, SHEET_H = 921.0, 992.0
ZONES = [
    box(11.3, 949.6, 42.5, 980.8),   # top-left
    box(878.7, 949.6, 909.9, 980.8),  # top-right
    box(11.3, 11.3, 42.5, 42.5),      # bottom-left
    box(878.7, 11.3, 909.9, 42.5),    # bottom-right
]
MARGINS = {'left': 11.3, 'right': 11.3, 'top': 11.3, 'bottom': 11.3}


def _mk(x, y, w, h, rot):
    return {'abs_x': x, 'abs_y': y, 'width': w, 'height': h,
            'original_cell_y': SHEET_H - y - h,
            'cell': {'isRotated': rot, 'isRotated180': False}}


def _build(left_xs, left_ys, right_xs, right_ys):
    out = []
    for y in left_ys:
        for x in left_xs:
            out.append(_mk(x, y, 184.8, 144.9, True))
    for y in right_ys:
        for x in right_xs:
            out.append(_mk(x, y, 144.9, 184.8, False))
    return out


def _build_preview():
    return _build([18.6, 209.1, 399.7], [800.0, 649.5, 498.9, 348.3, 197.8, 47.2],
                  [607.2, 757.7], [784.7, 594.2, 403.6, 213.1, 22.6])


def _build_output():
    # khối trái lệch +24.6pt dọc, khối phải lệch -8.5pt ngang so với preview
    return _build([27.1, 217.7, 408.2], [824.6, 674.1, 523.5, 372.9, 222.4, 71.8],
                  [598.7, 749.2], [784.7, 594.2, 403.6, 213.1, 22.6])


def _right_column_counts(out):
    cols = {}
    for p in out:
        if p['abs_x'] > 600:  # khối phải
            k = round(p['abs_x'] / 5) * 5
            cols.setdefault(k, []).append(p['abs_y'])
    return cols


def test_column_reflow_keeps_four_centered_no_overdelete():
    placements = _build_preview()
    assert detect_collisions(placements, ZONES, None, None, SHEET_H) == [19, 27]
    out = smart_resolve_collisions(placements, ZONES, None, None, SHEET_W, SHEET_H, MARGINS)

    # chỉ xóa ĐÚNG 1 tem (không xóa 2)
    assert len(out) == 27, f"kỳ vọng giữ 27, được {len(out)}"
    # hết va chạm vùng cấm + không tem nào đè nhau
    assert detect_collisions(out, ZONES, None, None, SHEET_H) == []
    assert not _has_any_sticker_overlap(out, None)

    # cột phải va chạm (x≈757.7) giữ 4 tem, căn giữa trong băng trống
    rc = _right_column_counts(out)
    collided_col = [c for c in rc if c >= 755]
    assert collided_col, "không thấy cột phải chạm vùng cấm"
    assert len(rc[collided_col[0]]) == 4, f"cột phải kỳ vọng 4 tem, được {rc[collided_col[0]]}"


def test_column_reflow_preview_output_same_kept_count():
    """Parity số lượng: khối lệch vị trí (preview vs output) vẫn giữ CÙNG số tem."""
    out_prev = smart_resolve_collisions(_build_preview(), ZONES, None, None, SHEET_W, SHEET_H, MARGINS)
    out_outp = smart_resolve_collisions(_build_output(), ZONES, None, None, SHEET_W, SHEET_H, MARGINS)
    assert len(out_prev) == len(out_outp) == 27
    # cột phải cả 2 đều 4 tem, cùng toạ độ y (reflow căn giữa độc lập với offset khối)
    rc_p = _right_column_counts(out_prev)
    rc_o = _right_column_counts(out_outp)
    yp = sorted(round(y, 1) for c in rc_p for y in rc_p[c] if c >= 745)
    yo = sorted(round(y, 1) for c in rc_o for y in rc_o[c] if c >= 745)
    assert yp == yo, f"cột phải y khác nhau preview={yp} output={yo}"
