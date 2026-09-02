"""Test 2 sửa lỗi CNC:
  1. mirror_placements_multi: mặt sau là PHẢN CHIẾU (mirror_x/mirror_y), KHÔNG toggle xoay.
  2. exclude_zones lúc packing: tem tránh boong ngay khi xếp (không xóa sau), và
     preview (build_cnc_front_layout) == output (build_cnc_gang_layout) cùng exclude.
"""
import math
import pytest

from app.workers.cnc_render import mirror_placements_multi
from app.workers.cnc_layout import (
    _resolve_safe_padding,
    build_cnc_front_layout,
    build_cnc_gang_layout,
)
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

    # build_cnc_front_layout thử căn giữa (overall = content ≤ usable); nếu phép
    # dịch chạm boong thì NEST-11 giữ lại trục/toạ độ packer an toàn.
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


def _u_coords(placement, margin_left, margin_top):
    """Đổi placement về toạ độ PACKER (gốc trên-trái vùng in, y xuống).

    ``exclude_zones`` được khai trong đúng hệ này, nên muốn kiểm va chạm thì phải
    quy placement về đây thay vì so trong hệ tờ.
    """
    u_x = placement['abs_x'] - margin_left
    u_y = placement['original_cell_y'] - margin_top
    return u_x, u_y, u_x + placement['width'], u_y + placement['height']


def _overlaps_any(rect, zones, eps=1e-6):
    x0, y0, x1, y1 = rect
    for zx, zy, zw, zh in zones:
        if not (x1 <= zx + eps or x0 >= zx + zw - eps
                or y1 <= zy + eps or y0 >= zy + zh - eps):
            return (zx, zy, zw, zh)
    return None


def test_can_giua_khong_duoc_day_tem_vao_vung_cam():
    """NEST-11: sau khi ``_materialize_sheet`` dịch về tâm, tem vẫn phải ngoài vùng cấm.

    Packer đã tránh vùng cấm lúc xếp, nhưng ``_materialize_sheet`` dịch cả cụm đi
    ``x_pad - min_x``. Khi ``x_pad < min_x`` thì phép dịch kéo nội dung NGƯỢC về phía
    góc — đúng nơi có boong. Test trước đây chỉ assert ``overall_w <= usable_w`` nên
    không thấy. Ca này dựng vùng cấm lệch (góc trái to hơn góc phải) để buộc
    ``min_x`` lớn hơn ``x_pad``.
    """
    usable_w, usable_h = 800.0, 1000.0
    # Vùng cấm LỆCH: dải trái rộng 160, dải phải chỉ 40 → packer phải bắt đầu từ
    # x≈160, trong khi khoảng dư còn lại chia đôi chỉ ra x_pad nhỏ hơn nhiều.
    zones = [
        (0.0, 0.0, 160.0, usable_h),
        (usable_w - 40.0, 0.0, 40.0, usable_h),
    ]
    page_dims_qty = [(0, 80.0, 100.0, 0), (1, 120.0, 90.0, 0)]

    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=5.0,
        margin_left=20.0, margin_bottom=30.0, margin_top=30.0,
        exclude_zones=zones,
    )
    assert res['placements'], "phải xếp được tem"

    for sheet in ([res] + list(res.get('sheets') or [])):
        for placement in sheet.get('placements', []):
            rect = _u_coords(placement, 20.0, 30.0)
            hit = _overlaps_any(rect, zones)
            assert hit is None, (
                f"tem tại packer-rect {rect} đè vùng cấm {hit} sau khi căn giữa"
            )


def test_can_giua_truc_y_khong_duoc_day_tem_vao_vung_cam():
    """NEST-11: vùng cấm lệch theo Y cũng phải được kiểm sau khi căn giữa."""
    usable_w, usable_h = 800.0, 1000.0
    # Dải trên cao hơn dải dưới buộc packer bắt đầu ở y≈180, trong khi phép căn
    # giữa cũ kéo cụm ngược lên vùng cấm.
    zones = [
        (0.0, 0.0, usable_w, 180.0),
        (0.0, usable_h - 40.0, usable_w, 40.0),
    ]
    page_dims_qty = [(0, 80.0, 100.0, 0), (1, 120.0, 90.0, 0)]

    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=5.0,
        margin_left=20.0, margin_bottom=30.0, margin_top=30.0,
        exclude_zones=zones,
    )
    assert res['placements'], "phải xếp được tem"

    for sheet in (res.get('sheets') or [res]):
        for placement in sheet.get('placements', []):
            rect = _u_coords(placement, 20.0, 30.0)
            hit = _overlaps_any(rect, zones)
            assert hit is None, (
                f"tem tại packer-rect {rect} đè vùng cấm {hit} sau khi căn giữa trục Y"
            )


def test_ratio_fill_nhieu_to_van_tranh_vung_cam_sau_khi_can_giua():
    """NEST-11: nhánh có SL và nhiều tờ phải recheck vùng cấm trên từng tờ."""
    usable_w, usable_h = 300.0, 300.0
    zones = [(0.0, 0.0, usable_w, 70.0)]
    page_dims_qty = [
        (0, 180.0, 180.0, 7),
        (1, 175.0, 185.0, 5),
        (2, 190.0, 170.0, 3),
    ]

    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=5.0,
        margin_left=11.0, margin_bottom=17.0, margin_top=13.0,
        exclude_zones=zones,
    )
    sheets = res.get('sheets') or [res]
    assert res['sheet_count'] == len(sheets) >= 2
    assert res['unplaced_pages'] == []
    assert {p['src_page_idx'] for s in sheets for p in s['placements']} == {0, 1, 2}

    for sheet in sheets:
        assert sheet['placements'], "mỗi tờ mẫu phải có placement"
        for placement in sheet['placements']:
            rect = _u_coords(placement, 11.0, 13.0)
            hit = _overlaps_any(rect, zones)
            assert hit is None, (
                f"tờ {sheet['physical_sheet_index']} có tem {rect} đè vùng cấm {hit}"
            )


def test_can_giua_van_giu_nguyen_khi_khong_co_va_cham():
    """Ca đã an toàn thì phép căn giữa phải GIỮ NGUYÊN, không được đổi output.

    Bản sửa NEST-11 chỉ được can thiệp ở ca thật sự va chạm. Vùng cấm đối xứng bốn
    góc là ca an toàn, và toạ độ ở đây phải khớp bản chưa sửa.
    """
    usable_w, usable_h = 800.0, 1000.0
    zones = _zones_corners(usable_w, usable_h, 60.0)
    page_dims_qty = [(0, 80.0, 100.0, 0), (1, 120.0, 90.0, 0)]

    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap=5.0,
        margin_left=20.0, margin_bottom=30.0, margin_top=30.0,
        exclude_zones=zones,
    )
    assert res['placements']
    # Căn giữa còn hiệu lực: cụm không dính mép trái vùng in.
    assert min(p['abs_x'] for p in res['placements']) > 20.0
    for placement in res['placements']:
        assert _overlaps_any(_u_coords(placement, 20.0, 30.0), zones) is None


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


def test_resolve_safe_padding_fails_closed_when_no_candidate_is_safe():
    """Vùng cấm bao phủ mọi candidate phải dừng, không trả padding nguy hiểm."""
    raw = [{'x': 0.0, 'y': 0.0, 'w': 100.0, 'h': 100.0}]
    zones = [(-1000.0, -1000.0, 2000.0, 2000.0)]

    with pytest.raises(RuntimeError, match='Không thể tìm phương án'):
        _resolve_safe_padding(
            raw, zones,
            min_x=0.0, min_y=0.0,
            x_pad=10.0, y_pad=10.0,
        )


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
