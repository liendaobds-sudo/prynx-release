"""Clip mask theo HÌNH khuôn: tem tròn xếp lồng không được đè nhau.

Ca gốc (lỗi thực tế): tem tròn, bbox 2 tem CHỒNG nhau khi xếp lồng/so le dù 2
đường bế còn cách đủ gap → artwork ngoài đường bế đè tem bên cạnh vì clip cũ chỉ
là bbox chữ nhật.
"""

import math

import pytest

from app.workers.nup_clip_shape import build_die_clip_rings, stitch_rings
from app.workers.pdf_types import Point, Rect

MM = 2.83465


def _circle_items(cx, cy, r, segments=64):
    """Đường bế tròn dưới dạng path items ('l', p1, p2) như file thật."""
    items = []
    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        items.append((
            'l',
            Point(cx + r * math.cos(a0), cy + r * math.sin(a0)),
            Point(cx + r * math.cos(a1), cy + r * math.sin(a1)),
        ))
    return items


def _rect_items(x0, y0, x1, y1):
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [
        ('l', Point(*corners[i]), Point(*corners[(i + 1) % 4]))
        for i in range(4)
    ]


def _polygon(rings):
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    return unary_union([Polygon(r) for r in rings])


def test_stitch_rings_noi_cac_doan_roi_thanh_ring_kin():
    """Đường bế là tập đoạn rời → phải nối lại thành 1 ring kín."""
    seg = [
        [[0.0, 0.0], [10.0, 0.0]],
        [[10.0, 10.0], [0.0, 10.0]],   # ngược chiều: phải tự đảo
        [[10.0, 0.0], [10.0, 10.0]],
        [[0.0, 10.0], [0.0, 0.0]],
    ]
    rings = stitch_rings(seg)
    assert len(rings) == 1
    assert rings[0][0] == rings[0][-1]


def test_tem_chu_nhat_bo_qua_shape_clip():
    """Tem chữ nhật: rect clip cũ đã tương đương → không phình content stream."""
    r = 20 * MM
    items = _rect_items(0, 0, 2 * r, 2 * r)
    rings = build_die_clip_rings(
        items, Rect(0, 0, 2 * r, 2 * r), 0.0, 0.0,
        offset_pt=1 * MM,
        bound_rect=Rect(-1 * MM, -1 * MM, 2 * r + 1 * MM, 2 * r + 1 * MM),
    )
    assert rings is None


def test_tem_tron_clip_theo_hinh_va_bu_xen_dung():
    """Clip = hình tròn nở đúng offset, không phải bbox."""
    r = 20 * MM
    off = 1 * MM
    die = Rect(0, 0, 2 * r, 2 * r)
    rings = build_die_clip_rings(
        _circle_items(r, r, r), die, 0.0, 0.0,
        offset_pt=off,
        bound_rect=Rect(-off, -off, 2 * r + off, 2 * r + off),
    )
    assert rings, "tem tròn phải sinh clip theo hình"

    poly = _polygon(rings)
    expected = math.pi * (r + off) ** 2
    # Sai số do lấy mẫu đa giác + simplify.
    assert poly.area == pytest.approx(expected, rel=0.02)
    # Phải NHỎ hơn hẳn bbox — bằng chứng không còn clip chữ nhật.
    assert poly.area < (2 * (r + off)) ** 2 * 0.85


def test_hai_tem_tron_xep_lech_hang_khong_con_giao_nhau():
    """Ca lỗi thật: bbox 2 tem giao nhau, clip theo hình thì KHÔNG."""
    r = 25 * MM          # tem tròn Ø50mm
    gap = 2 * MM
    bleed = 3 * MM
    off = min(gap / 2.0, bleed)   # = clip_off trong place_one_artwork

    die = Rect(0, 0, 2 * r, 2 * r)
    step = 2 * r + gap
    # Xếp so le: tem 2 lệch nửa bước ngang, và dịch lên theo hàng hex
    # → bbox chồng nhau theo chiều dọc.
    dy = math.sqrt(max(0.0, step ** 2 - (step / 2) ** 2))
    cells = [(0.0, 0.0), (step / 2.0, dy)]

    bbox_a = Rect(cells[0][0], cells[0][1], cells[0][0] + 2 * r, cells[0][1] + 2 * r)
    bbox_b = Rect(cells[1][0], cells[1][1], cells[1][0] + 2 * r, cells[1][1] + 2 * r)
    assert bbox_a.intersects(bbox_b), "tiền đề: bbox 2 tem phải chồng nhau"

    polys = []
    for ax, ay in cells:
        rings = build_die_clip_rings(
            _circle_items(r, r, r), die, ax, ay,
            offset_pt=off,
            bound_rect=Rect(ax - bleed, ay - bleed, ax + 2 * r + bleed, ay + 2 * r + bleed),
        )
        assert rings
        polys.append(_polygon(rings))

    overlap = polys[0].intersection(polys[1]).area
    assert overlap <= 1e-6, f"2 vùng clip vẫn giao nhau: {overlap:.4f} pt²"


def test_clip_khong_bao_gio_rong_hon_bound_rect():
    """An toàn: shape-clip chỉ THU HẸP, không nới rộng vùng vẽ so với rect cũ."""
    from shapely.geometry import box

    r = 20 * MM
    die = Rect(0, 0, 2 * r, 2 * r)
    bound = Rect(0, 0, 2 * r, 2 * r)     # bleed = 0 → clip đúng khuôn
    rings = build_die_clip_rings(
        _circle_items(r, r, r), die, 0.0, 0.0,
        offset_pt=5 * MM,                # cố tình nở quá
        bound_rect=bound,
    )
    assert rings
    poly = _polygon(rings)
    bound_box = box(bound.x0, bound.y0, bound.x1, bound.y1)
    assert poly.difference(bound_box).area <= 1e-6


def test_giu_bleed_tran_ra_le_ngoai_block():
    """Tem ở mép block: phần bound_rect ngoài block bbox vẫn được vẽ đầy bleed."""
    from shapely.geometry import box

    r = 20 * MM
    bleed = 3 * MM
    die = Rect(0, 0, 2 * r, 2 * r)
    block = (0.0, 0.0, 2 * r, 2 * r)           # tem này là cả block
    bound = Rect(-bleed, -bleed, 2 * r + bleed, 2 * r + bleed)
    rings = build_die_clip_rings(
        _circle_items(r, r, r), die, 0.0, 0.0,
        offset_pt=0.0,
        bound_rect=bound,
        block_rect=block,
    )
    assert rings
    poly = _polygon(rings)
    # Góc ngoài block (vùng lề) phải nằm trong clip → bleed không bị cắt ở mép ngoài.
    outer_band = box(bound.x0, bound.y0, bound.x1, bound.y1).difference(box(*block))
    assert outer_band.difference(poly).area <= 1e-3


def test_tem_be_bien_khong_them_dai_chu_nhat_full_bleed():
    """Tem bế ở biên vẫn giữ contour tròn; không nối dải chữ nhật ngoài block."""
    from shapely.geometry import box

    r = 20 * MM
    bleed = 3 * MM
    die = Rect(0, 0, 2 * r, 2 * r)
    bound = Rect(-bleed, -bleed, 2 * r + bleed, 2 * r + bleed)
    rings = build_die_clip_rings(
        _circle_items(r, r, r), die, 0.0, 0.0,
        offset_pt=1 * MM,
        bound_rect=bound,
        block_rect=None,
    )
    assert rings
    poly = _polygon(rings)
    outer_band = box(bound.x0, bound.y0, bound.x1, bound.y1).difference(
        box(0.0, 0.0, 2 * r, 2 * r)
    )
    # Dải ngoài bbox không được tự động nhập vào clip (đặc biệt ở góc).
    assert outer_band.intersection(poly).area < outer_band.area * 0.2


def test_cum_tem_be_duoc_can_theo_bbox_thuc_te():
    from app.workers.nup_process_chunk import _recenter_die_cut_placements

    placements = [
        {'abs_x': 10.0, 'original_cell_y': 20.0, 'abs_y': 80.0, 'width': 20.0, 'height': 20.0},
        {'abs_x': 32.0, 'original_cell_y': 45.0, 'abs_y': 55.0, 'width': 20.0, 'height': 20.0},
    ]
    dx, dy = _recenter_die_cut_placements(
        placements, sheet_w=100.0, sheet_h=100.0,
        sheet_usable_w=100.0, sheet_usable_h=100.0,
        margin_left=0.0, margin_bottom=0.0, align='center',
    )
    assert dx == pytest.approx(19.0)
    assert dy == pytest.approx(7.5)
    assert (min(p['abs_x'] for p in placements) + max(p['abs_x'] + p['width'] for p in placements)) / 2 == pytest.approx(50.0)
    assert (min(p['original_cell_y'] for p in placements) + max(p['original_cell_y'] + p['height'] for p in placements)) / 2 == pytest.approx(50.0)


# ─── Chế độ ĐỒNG NHẤT (bình tem chung khuôn) ─────────────────────────────────


class _FakeOutPage:
    def __init__(self):
        self.calls = []

    def show_pdf_page(self, rect, src_doc, page_idx, rotate=0, clip=None,
                      keep_proportion=False, out_clip=None, mirror_x=False,
                      mirror_y=False, out_clip_path=None):
        self.calls.append({"rect": rect, "rotate": rotate,
                           "out_clip_path": out_clip_path})


class _FakeSrcDoc:
    def __getitem__(self, _idx):
        return object()


def _place_homogeneous(die_items, die_rect, *, clip_off):
    from app.workers.nup_artwork import place_one_artwork

    out_page = _FakeOutPage()
    p = {
        "cell": {"width": die_rect.width, "height": die_rect.height,
                 "isRotated": False, "isRotated180": False, "blockId": 0},
        "cluster_idx": 0,
        "src_page_idx": 0,
        "abs_x": 30.0,
        "original_cell_y": 40.0,
    }
    place_one_artwork(
        out_page, _FakeSrcDoc(), p,
        bleed_pt=0.0, is_die_cut=True, cut_type="default",
        separate_cut_page=False, local_stripped_pages=set(),
        job_id="hom", diecut_geom_cache={},
        die_items_cache={"hom_0": {"items": die_items, "rect": die_rect,
                                   "color": (0, 0, 0), "width": 0.5,
                                   "spot_name": None}},
        max_geom_cache=8, block_bbox={},
        clip_off_x=clip_off, clip_off_y=clip_off,
        find_largest_die_path=lambda _p: None,
        homogeneous_clip=Rect(0.0, 0.0, die_rect.width, die_rect.height),
    )
    assert len(out_page.calls) == 1
    return out_page.calls[0]


def test_dong_nhat_tem_tron_duoc_clip_theo_hinh():
    """Chế độ ĐỒNG NHẤT với khuôn tròn phải clip theo hình, không phải rect ô."""
    r = 20 * MM
    die = Rect(0, 0, 2 * r, 2 * r)
    call = _place_homogeneous(_circle_items(r, r, r), die, clip_off=1 * MM)

    rings = call["out_clip_path"]
    assert rings, "nhánh đồng nhất vẫn clip bằng rect ô"

    poly = _polygon(rings)
    # Nằm gọn trong ô (không vẽ rộng hơn hành vi cũ) và nhỏ hơn hẳn diện tích ô.
    from shapely.geometry import box
    cell_box = box(30.0, 40.0, 30.0 + 2 * r, 40.0 + 2 * r)
    assert poly.difference(cell_box).area <= 1e-6
    assert poly.area < cell_box.area * 0.85


def test_dong_nhat_tem_chu_nhat_giu_nguyen_hanh_vi_cu():
    """Khuôn chữ nhật → không truyền out_clip_path (luồng cũ bất biến)."""
    r = 20 * MM
    die = Rect(0, 0, 2 * r, 2 * r)
    call = _place_homogeneous(_rect_items(0, 0, 2 * r, 2 * r), die, clip_off=1 * MM)
    assert call["out_clip_path"] is None
