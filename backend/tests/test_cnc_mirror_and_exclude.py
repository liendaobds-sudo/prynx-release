"""Test 2 sửa lỗi CNC:
  1. mirror_placements_multi: mặt sau là PHẢN CHIẾU (mirror_x/mirror_y), KHÔNG toggle xoay.
  2. exclude_zones lúc packing: tem tránh boong ngay khi xếp (không xóa sau), và
     preview (build_cnc_front_layout) == output (build_cnc_gang_layout) cùng exclude.
"""
import math
import pytest

from app.workers.cnc_render import mirror_placements_multi
from app.workers.cnc_layout import build_cnc_front_layout, build_cnc_gang_layout
from app.workers.die_detection import DetectedShape, Trim
from app.workers.shape_types import coerce_shape_type


def _mk_front(abs_x, abs_y, w, h, src=0, is_rot=False, is_rot180=False):
    return {
        'cluster_idx': 0,
        'cell': {'x': 0, 'y': 0, 'width': w, 'height': h,
                 'isRotated': is_rot, 'isRotated180': is_rot180, 'blockId': 0},
        'src_page_idx': src,
        'abs_x': abs_x, 'abs_y': abs_y,
        'width': w, 'height': h,
        'original_cell_y': abs_y,
    }


# ───────────────────────── Mirror ─────────────────────────

def test_mirror_long_edge_sets_mirror_x_no_rotation_toggle():
    sheet_w, sheet_h = 900.0, 1200.0
    front = [_mk_front(100, 200, 50, 80, src=0, is_rot=True, is_rot180=False)]
    back = mirror_placements_multi(front, sheet_w, sheet_h, 'long', {0: 1})
    bp = back[0]
    # Mặt sau dùng trang kế (back_of)
    assert bp['src_page_idx'] == 1
    # KHÔNG dời vị trí — phản chiếu toàn tờ do show_pdf_page lo (mirror quanh tâm tờ)
    assert bp['abs_x'] == pytest.approx(100)
    # Cờ phản chiếu ngang
    assert bp['mirror_x'] is True
    assert bp['mirror_y'] is False
    # KHÔNG toggle xoay (giữ nguyên 90° của mặt trước)
    assert bp['cell']['isRotated'] is True
    assert bp['cell']['isRotated180'] is False


def test_mirror_short_edge_sets_mirror_y():
    sheet_w, sheet_h = 900.0, 1200.0
    front = [_mk_front(100, 200, 50, 80, src=0)]
    back = mirror_placements_multi(front, sheet_w, sheet_h, 'short', {0: 1})
    bp = back[0]
    assert bp['mirror_y'] is True
    assert bp['mirror_x'] is False
    # KHÔNG dời vị trí
    assert bp['abs_y'] == pytest.approx(200)


def test_mirror_keeps_position_for_whole_sheet_reflection():
    # Phản chiếu lo ở tầng render (mirror quanh tâm tờ) → vị trí placement GIỮ NGUYÊN.
    sheet_w, sheet_h = 900.0, 1200.0
    front = [_mk_front(100, 200, 50, 80, src=0)]
    back = mirror_placements_multi(front, sheet_w, sheet_h, 'long', {0: 1})
    assert back[0]['abs_x'] == pytest.approx(100)
    assert back[0]['mirror_x'] is True


# ───────────────────────── Exclude zones (packing-time) ─────────────────────────

def _zones_corners(usable_w, usable_h, size=60.0):
    """4 vùng cấm góc (toạ độ packer: gốc trên-trái, y xuống)."""
    return [
        (0, 0, size, size),                          # trên-trái
        (usable_w - size, 0, size, size),            # trên-phải
        (0, usable_h - size, size, size),            # dưới-trái
        (usable_w - size, usable_h - size, size, size),  # dưới-phải
    ]


def test_exclude_zones_no_item_overlaps_zone():
    usable_w, usable_h = 800.0, 1000.0
    zones = _zones_corners(usable_w, usable_h, 60.0)
    # Tầng solver: kiểm packer THỰC SỰ tránh vùng cấm (toạ độ packer).
    from app.workers.sticker_imposer_pkg.bin_packing import solve_auto_fill_mixed
    sol = solve_auto_fill_mixed(
        sheet_w=usable_w, sheet_h=usable_h,
        page_dims=[(0, 80.0, 100.0), (1, 120.0, 90.0)],
        gap=5.0, allow_rotation=True, exclude_zones=zones,
    )
    assert sol['placements'], "phải xếp được tem"
    for p in sol['placements']:
        px0, py0 = p['x'], p['y']
        px1, py1 = px0 + p['w'], py0 + p['h']
        for zx, zy, zw, zh in zones:
            overlap = not (px1 <= zx or px0 >= zx + zw or py1 <= zy or py0 >= zy + zh)
            assert not overlap, f"item {p} đè vùng cấm {(zx, zy, zw, zh)}"

    # build_cnc_front_layout: LUÔN căn giữa (overall = content ≤ usable), boong vẫn
    # trống vì căn giữa dịch nội dung về tâm (xa góc).
    page_dims_qty = [(0, 80.0, 100.0, 0), (1, 120.0, 90.0, 0)]
    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=5.0,
        margin_left=20.0, margin_bottom=30.0, margin_top=30.0, exclude_zones=zones,
    )
    assert res['placements']
    assert res['overall_w'] <= usable_w + 1e-3
    assert res['overall_h'] <= usable_h + 1e-3


def test_preview_equals_output_with_exclude_zones():
    """build_cnc_gang_layout (output) và build_cnc_front_layout (preview) cùng
    exclude_zones → cells trùng nhau (preview == output)."""
    usable_w, usable_h = 800.0, 1000.0
    zones = _zones_corners(usable_w, usable_h, 50.0)
    gap = 6.0

    page_dims_qty = [(0, 90.0, 110.0, 0), (1, 130.0, 80.0, 0)]
    preview = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=gap,
        margin_left=15.0, margin_bottom=25.0, exclude_zones=zones,
    )

    shapes = [
        (DetectedShape(page=0, type=coerce_shape_type('RECTANGLE'), props={},
                       trim=Trim(90.0, 110.0), poly=(), source='vector', confidence=1.0), 0),
        (DetectedShape(page=1, type=coerce_shape_type('RECTANGLE'), props={},
                       trim=Trim(130.0, 80.0), poly=(), source='vector', confidence=1.0), 0),
    ]
    output = build_cnc_gang_layout(
        shapes, usable_w, usable_h, gap,
        margin_left=15.0, margin_bottom=25.0, exclude_zones=zones,
    )

    assert len(preview['cells']) == len(output['cells'])
    for cp, co in zip(preview['cells'], output['cells']):
        assert cp['x'] == pytest.approx(co['x'])
        assert cp['y'] == pytest.approx(co['y'])
        assert cp['width'] == pytest.approx(co['width'])
        assert cp['height'] == pytest.approx(co['height'])


def test_no_exclude_keeps_centering_behavior():
    """Không vùng cấm → giữ hành vi căn giữa cũ (overall = content, có thể < usable)."""
    usable_w, usable_h = 800.0, 1000.0
    page_dims_qty = [(0, 80.0, 100.0, 2)]
    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=5.0,
        margin_left=20.0, margin_bottom=30.0,
    )
    assert res['placements']
    # content nhỏ hơn usable → overall phản ánh content, không phải usable
    assert res['overall_w'] <= usable_w


# ───────────────── Render-level: mặt sau ĐỐI XỨNG mặt trước qua tâm tờ ─────────────────

def _matmul(m, n):
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return [a*a2 + b*c2, a*b2 + b*d2, c*a2 + d*c2, c*b2 + d*d2,
            e*a2 + f*c2 + e2, e*b2 + f*d2 + f2]


def _page_do_centers(pike_page):
    """Tâm X (điểm) nơi tâm trang nguồn ĐÁP xuống mỗi 'Do', + có dùng mirror không."""
    import pikepdf
    c = pike_page.Contents
    data = (b''.join(s.read_bytes() for s in c) if isinstance(c, pikepdf.Array)
            else c.read_bytes()).decode('latin-1')
    toks = data.split()
    centers, stack, cur, nums = [], [], [1, 0, 0, 1, 0, 0], []
    mirror_used = False
    src_cx, src_cy = 100.0, 150.0  # tâm trang nguồn 200x300
    for t in toks:
        try:
            nums.append(float(t)); continue
        except ValueError:
            pass
        if t == 'q':
            stack.append(list(cur))
        elif t == 'Q':
            if stack: cur = stack.pop()
        elif t == 'cm':
            if len(nums) >= 6:
                m = nums[-6:]
                if abs(m[0] + 1.0) < 1e-6 or abs(m[3] + 1.0) < 1e-6:
                    mirror_used = True
                cur = _matmul(m, cur)
            nums = []
        elif t == 'Do':
            centers.append(round(src_cx * cur[0] + src_cy * cur[2] + cur[4], 1))
            nums = []
        else:
            nums = []
    return centers, mirror_used


def test_render_back_is_mirror_of_front(tmp_path):
    import io, pikepdf
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.cnc_render import run_cnc_two_sided

    MM = 2.83465
    SW = 200.0  # mm
    src = pdf_lib.open()
    for _ in range(2):
        pg = src.new_page(width=200, height=300)
        sh = pg.new_shape()
        sh.draw_rect(pdf_lib.Rect(20, 20, 70, 80))  # ô lệch tâm rõ rệt
        sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
        sh.commit()
    sp = str(tmp_path / "src.pdf")
    buf = io.BytesIO(); src.save(buf); src.close()
    open(sp, 'wb').write(buf.getvalue())
    op = str(tmp_path / "out.pdf")

    run_cnc_two_sided(sp, op, {
        'cncTwoSided': True, 'cncFlipEdge': 'long',
        'sheetWidth': SW, 'sheetHeight': 300.0,
        'layoutType': 'sequential', 'targetQuantity': 0,
    })

    p = pikepdf.open(op)
    sheet_w_pt = SW * MM
    fc, fm = _page_do_centers(p.pages[0])
    bc, bm = _page_do_centers(p.pages[1])
    p.close()

    assert fm is False, "Mặt trước KHÔNG được mirror"
    assert bm is True, "Mặt sau PHẢI mirror"
    assert len(fc) == len(bc) and len(fc) > 0
    # Mặt sau = sheet_w - mặt trước (đối xứng qua tâm tờ), dung sai làm tròn.
    expected = sorted(sheet_w_pt - x for x in fc)
    got = sorted(bc)
    for e, g in zip(expected, got):
        assert abs(e - g) < 0.5, f"không đối xứng: expected {e}, got {g}"
