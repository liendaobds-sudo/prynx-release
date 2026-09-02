"""Hợp đồng của `derive_packing_footprint` — footprint đóng gói cho nesting.

Kèm số đo đã trả giá ở `nesting_source_geometry.PACKING_FOOTPRINT_MAX_VERTICES`: ép số
đỉnh mạnh (24) làm mất 2 trong 46 con mỗi tờ trên file khách, nên trần chỉ là **van an
toàn** đặt cao hơn mọi giá trị thật (đo được 55–211 đỉnh ở dung sai 0,2mm).

Bất biến quan trọng nhất là **bao hàm**: footprint phải phủ đường bế gốc ở mọi bước nới
dung sai. Mất bất biến này là hai chi tiết đè nhau trên tờ in thật.
"""

from __future__ import annotations

import math

import pytest
from shapely.geometry import Polygon

from app.core.nesting_production_adapter import RenderPolygonV1
from app.core.nesting_source_geometry import (
    PACKING_FOOTPRINT_MAX_TOLERANCE_MM,
    PACKING_FOOTPRINT_MAX_VERTICES,
    PACKING_FOOTPRINT_TOLERANCE_MM,
    derive_packing_footprint,
)


def _rect(width: float, height: float) -> RenderPolygonV1:
    return RenderPolygonV1(
        outer=((0.0, 0.0), (width, 0.0), (width, height), (0.0, height)), holes=()
    )


def _chu_L() -> RenderPolygonV1:
    """Hình chữ L: có đúng MỘT đỉnh lõm, đủ để phân biệt lồi/lõm."""

    return RenderPolygonV1(
        outer=(
            (0.0, 0.0),
            (40.0, 0.0),
            (40.0, 12.0),
            (12.0, 12.0),
            (12.0, 40.0),
            (0.0, 40.0),
        ),
        holes=(),
    )


def _rang_luoc(teeth: int, *, depth: float = 1.0) -> RenderPolygonV1:
    """Biên răng lược: nhiều đỉnh lõm nhỏ — đúng loại hình làm NFP đắt."""

    points: list[tuple[float, float]] = [(0.0, 0.0)]
    for index in range(teeth):
        x = 1.0 + index * 2.0
        points.append((x, 0.0))
        points.append((x, depth))
        points.append((x + 1.0, depth))
        points.append((x + 1.0, 0.0))
    width = 1.0 + teeth * 2.0
    points.append((width, 0.0))
    points.append((width, 30.0))
    points.append((0.0, 30.0))
    return RenderPolygonV1(outer=tuple(points), holes=())


def _tron_nhieu_dinh(count: int, *, radius: float = 20.0) -> RenderPolygonV1:
    """Đường tròn đã flatten thành `count` đoạn — mô phỏng contour bệnh lý."""

    return RenderPolygonV1(
        outer=tuple(
            (
                radius * math.cos(2.0 * math.pi * index / count),
                radius * math.sin(2.0 * math.pi * index / count),
            )
            for index in range(count)
        ),
        holes=(),
    )


def _phu(footprint: RenderPolygonV1, source: RenderPolygonV1) -> bool:
    return Polygon(footprint.outer).covers(Polygon(source.outer))


# ─────────────────────────────────────────────────────────────────────────────
#  Bất biến 1: bao hàm
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "source",
    [
        _rect(45.0, 30.0),
        _chu_L(),
        _rang_luoc(8),
        _rang_luoc(40),
        _tron_nhieu_dinh(64),
        _tron_nhieu_dinh(1200),
    ],
    ids=["chunhat", "chuL", "rang8", "rang40", "tron64", "tron1200"],
)
def test_footprint_luon_phu_duong_be_goc(source: RenderPolygonV1) -> None:
    """Bất biến sống còn: không bao giờ được trả hình nhỏ hơn đường bế."""

    footprint = derive_packing_footprint(source)

    assert _phu(footprint, source)


@pytest.mark.parametrize("cap", [3, 4, 8, 16, 24, 64, 256, 10**6])
def test_bao_ham_giu_o_moi_muc_tran_dinh(cap: int) -> None:
    """Nới dung sai để đạt trần không được phá bao hàm ở bất kỳ mức nào."""

    source = _rang_luoc(30)

    footprint = derive_packing_footprint(source, max_vertices=cap)

    assert _phu(footprint, source)


@pytest.mark.parametrize("tolerance", [0.05, 0.2, 0.5, 1.0, 3.0])
def test_bao_ham_giu_o_moi_dung_sai(tolerance: float) -> None:
    source = _chu_L()

    footprint = derive_packing_footprint(
        source, tolerance_mm=tolerance, max_tolerance_mm=max(tolerance, 3.0)
    )

    assert _phu(footprint, source)


def test_footprint_khong_bao_gio_nho_hon_ve_dien_tich() -> None:
    source = _rang_luoc(20)

    footprint = derive_packing_footprint(source)

    assert Polygon(footprint.outer).area >= Polygon(source.outer).area


# ─────────────────────────────────────────────────────────────────────────────
#  Bất biến 2: trần đỉnh là VAN AN TOÀN, không phải mặc định ép
# ─────────────────────────────────────────────────────────────────────────────


def test_tran_mac_dinh_khong_cham_contour_thuc_te() -> None:
    """Trần mặc định phải nằm TRÊN mọi giá trị thật đo được (55–211 đỉnh).

    Đây là test chặn hồi quy cho một quyết định đã trả giá: hạ trần xuống 24 làm mất
    4,3% con mỗi tờ trên file khách. Nếu ai hạ trần về vùng contour thật, test này đỏ.
    """

    assert PACKING_FOOTPRINT_MAX_VERTICES > 211

    # Với contour cỡ thật, kết quả phải TRÙNG bản chỉ dùng dung sai 0,2mm — tức trần
    # không can thiệp.
    source = _tron_nhieu_dinh(220)
    ep_manh = derive_packing_footprint(source, max_vertices=24)
    mac_dinh = derive_packing_footprint(source)
    khong_tran = derive_packing_footprint(source, max_vertices=10**9)

    assert mac_dinh.outer == khong_tran.outer
    assert len(ep_manh.outer) < len(mac_dinh.outer)


def test_van_an_toan_chan_contour_benh_ly() -> None:
    """Contour vài nghìn đỉnh phải bị kéo xuống dưới trần, không được thả nguyên."""

    source = _tron_nhieu_dinh(4000, radius=60.0)

    footprint = derive_packing_footprint(source)

    assert len(footprint.outer) <= PACKING_FOOTPRINT_MAX_VERTICES
    assert _phu(footprint, source)


def test_khong_noi_qua_dung_sai_toi_da() -> None:
    """Không đạt được trần thì trả bản tốt nhất, KHÔNG phình quá `max_tolerance_mm`.

    Trần 3 đỉnh là bất khả với hình lõm, nên đây là ca ép hàm phải bỏ cuộc đúng cách.
    """

    source = _rang_luoc(40)
    lon_nhat = 0.5

    footprint = derive_packing_footprint(
        source, tolerance_mm=0.2, max_vertices=3, max_tolerance_mm=lon_nhat
    )

    assert _phu(footprint, source)
    # Phình tối đa bằng buffer `lon_nhat` quanh hình gốc — không hơn. Phải so với CÙNG
    # kiểu join mà hàm dùng: `mitre` cho góc rộng hơn join tròn mặc định của shapely.
    tran = Polygon(source.outer).buffer(lon_nhat, join_style=2, mitre_limit=2.0)
    assert tran.covers(Polygon(footprint.outer))


# ─────────────────────────────────────────────────────────────────────────────
#  Hợp đồng đầu vào và fail-closed
# ─────────────────────────────────────────────────────────────────────────────


def test_dung_sai_khong_thi_tra_nguyen_duong_be() -> None:
    source = _chu_L()

    footprint = derive_packing_footprint(source, tolerance_mm=0.0)

    assert footprint.outer == source.outer
    assert footprint.holes == ()


def test_lo_bi_bo_khoi_footprint() -> None:
    """Kernel V1 coi lỗ của footprint là vật liệu đặc, nên footprint không mang lỗ."""

    source = RenderPolygonV1(
        outer=((0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)),
        holes=((((10.0, 10.0), (30.0, 10.0), (30.0, 30.0), (10.0, 30.0))),),
    )

    footprint = derive_packing_footprint(source)

    assert footprint.holes == ()


@pytest.mark.parametrize("value", [None, "poly", 3, ()])
def test_reject_polygon_sai_kieu(value: object) -> None:
    with pytest.raises(TypeError):
        derive_packing_footprint(value)  # type: ignore[arg-type]


@pytest.mark.parametrize("tolerance", [-0.1, float("nan"), float("inf")])
def test_reject_dung_sai_khong_hop_le(tolerance: float) -> None:
    with pytest.raises(ValueError):
        derive_packing_footprint(_chu_L(), tolerance_mm=tolerance)


@pytest.mark.parametrize("cap", [0, 1, 2, -5])
def test_reject_tran_dinh_duoi_ba(cap: int) -> None:
    with pytest.raises(ValueError):
        derive_packing_footprint(_chu_L(), max_vertices=cap)


@pytest.mark.parametrize("max_tolerance", [0.1, float("nan"), -1.0])
def test_reject_dung_sai_toi_da_nho_hon_dung_sai_dau(max_tolerance: float) -> None:
    with pytest.raises(ValueError):
        derive_packing_footprint(
            _chu_L(), tolerance_mm=0.2, max_tolerance_mm=max_tolerance
        )


def test_mac_dinh_dung_hai_hang_so_cong_bo() -> None:
    """Mặc định của hàm phải là chính hai hằng số module, không phải số rời."""

    source = _rang_luoc(30)

    assert derive_packing_footprint(source).outer == derive_packing_footprint(
        source,
        tolerance_mm=PACKING_FOOTPRINT_TOLERANCE_MM,
        max_vertices=PACKING_FOOTPRINT_MAX_VERTICES,
        max_tolerance_mm=PACKING_FOOTPRINT_MAX_TOLERANCE_MM,
    ).outer
