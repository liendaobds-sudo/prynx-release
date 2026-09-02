"""Lỗ khuôn (cửa sổ, lỗ treo) trong bộ dò đường bế.

Bối cảnh: ``_path_items_to_polygon`` dựng MỖI subpath thành một ``Polygon`` đặc
rồi ``unary_union`` tất cả lại. Hợp của biên ngoài với vòng trong = biên ngoài,
nên khuôn có cửa sổ / lỗ treo bị mất lỗ. Khuôn thật vẽ biên ngoài và lỗ trong
CÙNG một path (cùng spot CutContour), nên mất lỗ = lớp CUT không có nét dao
trong lòng chi tiết, thợ bế ra sản phẩm không đục được cửa sổ.

Bản vá §A4b-2 thêm ``keep_holes``:

- ``keep_holes=False`` (mặc định) — hợp đồng CŨ, không đổi một byte. Bốn callsite
  legacy dựa vào đúng hành vi đặc này: collision tem–tem (``layout_compute``),
  pont collision, die detection CNC, và head-to-tail overlap. Với packing thì
  biên đặc là **bảo thủ và an toàn** (không xếp tem vào lòng lỗ của tem khác).
- ``keep_holes=True`` — đường manifest production, giữ lỗ cho lớp CUT.

Test khoá cả hai phía: parity cho lane legacy, và lỗ thật sự được giữ khi bật.
"""

from __future__ import annotations

import pytest

from app.workers.nup_diecut import (
    _path_items_to_polygon,
    _rings_to_polygon_with_holes,
)
from app.workers.pdf_types import Rect


def _rect_item(x0, y0, x1, y1):
    """Một subpath kín dạng lệnh ``re`` — bộ dò nạp thẳng thành vòng."""
    return ('re', Rect(x0, y0, x1, y1))


def _ring(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


# ── Parity: lane legacy không được đổi hành vi ────────────────────────────────

def test_mac_dinh_giu_hanh_vi_cu_bien_ngoai_dac():
    """Không truyền cờ → biên ngoài đặc, KHÔNG lỗ, đúng như trước bản vá."""

    items = [
        _rect_item(0.0, 0.0, 30.0, 30.0),   # biên ngoài
        _rect_item(10.0, 10.0, 20.0, 20.0),  # cửa sổ
    ]

    poly = _path_items_to_polygon(items)

    assert poly is not None
    assert len(poly.interiors) == 0, "lane legacy phải nhận biên đặc"
    assert poly.bounds == (0.0, 0.0, 30.0, 30.0)
    assert poly.area == pytest.approx(900.0)


def test_mac_dinh_va_keep_holes_false_cho_ket_qua_giong_nhau():
    """Truyền tường minh ``False`` phải trùng khít mặc định."""

    items = [
        _rect_item(0.0, 0.0, 30.0, 30.0),
        _rect_item(10.0, 10.0, 20.0, 20.0),
    ]

    implicit = _path_items_to_polygon(items)
    explicit = _path_items_to_polygon(items, keep_holes=False)

    assert implicit.equals(explicit)


def test_khuon_khong_lo_cho_ket_qua_nhu_nhau_o_ca_hai_che_do():
    """Khuôn một vòng: bật hay tắt cờ đều phải ra cùng hình.

    Đây là ca phổ biến nhất ở xưởng (tem tròn, tem vuông không cửa sổ) — nếu hai
    chế độ lệch nhau ở đây thì bản vá đã làm hỏng chính đường đang chạy.
    """

    items = [_rect_item(0.0, 0.0, 30.0, 20.0)]

    legacy = _path_items_to_polygon(items)
    with_holes = _path_items_to_polygon(items, keep_holes=True)

    assert legacy.equals(with_holes)
    assert len(with_holes.interiors) == 0


# ── keep_holes=True: lỗ được giữ ──────────────────────────────────────────────

def test_keep_holes_giu_cua_so_lam_lo_khuon():
    """Biên ngoài + cửa sổ → polygon có đúng 1 lỗ, diện tích trừ đi phần lỗ."""

    items = [
        _rect_item(0.0, 0.0, 30.0, 30.0),
        _rect_item(10.0, 10.0, 20.0, 20.0),
    ]

    poly = _path_items_to_polygon(items, keep_holes=True)

    assert poly is not None
    assert poly.bounds == (0.0, 0.0, 30.0, 30.0), "biên ngoài không được đổi"
    assert len(poly.interiors) == 1, "cửa sổ phải thành lỗ khuôn"
    assert poly.area == pytest.approx(900.0 - 100.0)
    # Tâm cửa sổ nằm NGOÀI vật liệu — đó chính là ý nghĩa của lỗ.
    from shapely.geometry import Point as ShapelyPoint

    assert not poly.contains(ShapelyPoint(15.0, 15.0))
    assert poly.contains(ShapelyPoint(5.0, 5.0))


def test_keep_holes_giu_nhieu_lo_doc_lap():
    """Hộp quai xách: hai lỗ khoét tay riêng biệt trong cùng biên ngoài."""

    items = [
        _rect_item(0.0, 0.0, 100.0, 50.0),
        _rect_item(10.0, 20.0, 30.0, 30.0),
        _rect_item(70.0, 20.0, 90.0, 30.0),
    ]

    poly = _path_items_to_polygon(items, keep_holes=True)

    assert len(poly.interiors) == 2
    assert poly.area == pytest.approx(5000.0 - 200.0 - 200.0)


def test_keep_holes_khuon_long_nhieu_tang_dao_nguoc_vat_lieu():
    """Lồng 3 tầng: ngoài = vật liệu, tầng 2 = lỗ, tầng 3 = vật liệu trở lại.

    Quy tắc even-odd: độ sâu chẵn là vật liệu, lẻ là lỗ. Đây là hình vành khuyên
    có đảo ở giữa (ví dụ nhãn tròn có lỗ tâm lớn kèm chi tiết rời bên trong).
    """

    from shapely.geometry import Point as ShapelyPoint

    rings = [
        _ring(0.0, 0.0, 60.0, 60.0),    # tầng 0 — vật liệu
        _ring(10.0, 10.0, 50.0, 50.0),  # tầng 1 — lỗ
        _ring(20.0, 20.0, 40.0, 40.0),  # tầng 2 — đảo vật liệu
    ]

    poly = _rings_to_polygon_with_holes(rings)

    assert poly is not None
    # Vành khuyên + đảo rời nhau → tổng diện tích cộng lại.
    assert poly.area == pytest.approx((3600.0 - 1600.0) + 400.0)
    assert poly.contains(ShapelyPoint(5.0, 5.0)), "vành ngoài là vật liệu"
    assert not poly.contains(ShapelyPoint(15.0, 15.0)), "tầng 2 là lỗ"
    assert poly.contains(ShapelyPoint(30.0, 30.0)), "tầng 3 là vật liệu lại"


def test_keep_holes_hai_khuon_roi_moi_khuon_mot_lo():
    """Hai con tem rời nhau, mỗi con một cửa sổ — lỗ phải gắn đúng chủ."""

    rings = [
        _ring(0.0, 0.0, 20.0, 20.0),
        _ring(5.0, 5.0, 10.0, 10.0),
        _ring(50.0, 0.0, 70.0, 20.0),
        _ring(55.0, 5.0, 60.0, 10.0),
    ]

    poly = _rings_to_polygon_with_holes(rings)

    assert poly.geom_type == 'MultiPolygon'
    assert len(poly.geoms) == 2
    for part in poly.geoms:
        assert len(part.interiors) == 1
        assert part.area == pytest.approx(400.0 - 25.0)


# ── Biên: đầu vào rác không được ném lỗi ──────────────────────────────────────

@pytest.mark.parametrize('rings', [[], [[(0.0, 0.0), (1.0, 1.0)]]])
def test_rings_khong_du_dinh_tra_none(rings):
    """Vòng dưới 3 đỉnh không dựng được polygon → None, không ném."""

    assert _rings_to_polygon_with_holes(rings) is None


def test_keep_holes_voi_items_rong_tra_none():
    assert _path_items_to_polygon([], keep_holes=True) is None
    assert _path_items_to_polygon([]) is None


# ── Phân loại qua chỉ mục không gian (STRtree) ────────────────────────────────

def test_panel_nhieu_lo_giu_du_khong_gop():
    """Panel đục 12 lỗ: đủ 12 lỗ, đi qua nhánh STRtree.

    PERF (audit 2026-08-28 §A4b-3): nhánh này lọc ứng viên bằng chỉ mục không gian
    thay vì quét cặp đôi. Đo thật trên 400 lỗ: 26ms so với 29ms của nhánh hợp-đặc,
    tức KHÔNG chậm hơn; bản quét cặp đôi trước đó tốn 565ms.
    """

    rings = [_ring(0.0, 0.0, 130.0, 40.0)]
    for column in range(6):
        for row in range(2):
            x = 5.0 + column * 20.0
            y = 5.0 + row * 18.0
            rings.append(_ring(x, y, x + 12.0, y + 12.0))

    poly = _rings_to_polygon_with_holes(rings)

    assert poly.geom_type == 'Polygon'
    assert len(poly.interiors) == 12
    assert poly.area == pytest.approx(130.0 * 40.0 - 12 * 144.0)


def test_phan_loai_khong_phu_thuoc_thu_tu_vong_dau_vao():
    """Cùng tập vòng, khác thứ tự ⇒ cùng hình. Bộ dò không được phụ thuộc thứ tự vẽ."""

    base = [
        _ring(0.0, 0.0, 60.0, 60.0),
        _ring(5.0, 5.0, 20.0, 20.0),
        _ring(30.0, 30.0, 50.0, 50.0),
    ]
    shuffled = [base[2], base[0], base[1]]

    first = _rings_to_polygon_with_holes(base)
    second = _rings_to_polygon_with_holes(shuffled)

    assert first.equals(second)
    assert len(first.interiors) == 2


def test_long_bon_tang_dao_nguoc_dung_theo_even_odd():
    """4 tầng: vật liệu → lỗ → đảo → lỗ trong đảo."""

    from shapely.geometry import Point as ShapelyPoint

    rings = [
        _ring(0.0, 0.0, 80.0, 80.0),    # tầng 0 — vật liệu
        _ring(10.0, 10.0, 70.0, 70.0),  # tầng 1 — lỗ
        _ring(20.0, 20.0, 60.0, 60.0),  # tầng 2 — đảo
        _ring(30.0, 30.0, 50.0, 50.0),  # tầng 3 — lỗ trong đảo
    ]

    poly = _rings_to_polygon_with_holes(rings)

    assert poly.contains(ShapelyPoint(5.0, 5.0)), "tầng 0 vật liệu"
    assert not poly.contains(ShapelyPoint(15.0, 15.0)), "tầng 1 lỗ"
    assert poly.contains(ShapelyPoint(25.0, 25.0)), "tầng 2 đảo"
    assert not poly.contains(ShapelyPoint(40.0, 40.0)), "tầng 3 lỗ trong đảo"
    assert poly.area == pytest.approx(
        (80.0 * 80.0 - 60.0 * 60.0) + (40.0 * 40.0 - 20.0 * 20.0)
    )


def test_vong_giao_nhau_khong_long_deu_la_vat_lieu():
    """Hai vòng CHỒNG một phần (không lồng) ⇒ cả hai là vật liệu, không thành lỗ."""

    rings = [
        _ring(0.0, 0.0, 40.0, 40.0),
        _ring(30.0, 30.0, 70.0, 70.0),
    ]

    poly = _rings_to_polygon_with_holes(rings)

    assert len(getattr(poly, 'interiors', ())) == 0
    assert poly.area == pytest.approx(1600.0 + 1600.0 - 100.0)
