"""Regression contour page-space server-only của die detection."""

from __future__ import annotations

import pikepdf
import pytest

from app.workers import pdf_wrapper
from app.workers.die_detection import (
    DETECTED_SHAPE_JSON_SCHEMA,
    DetectionResult,
    DetectedPageContour,
    DetectedShape,
    PageDetectionStatus,
    Trim,
    _polygon_to_page_contour,
    apply_master_die_inheritance,
    detect_die_shapes,
    shape_from_dict,
    shape_to_dict,
)
from app.workers.shape_types import ShapeType


MEDIA_BOX = (0.0, 0.0, 200.0, 100.0)


def _rectangle_content(x: float, y: float, width: float, height: float) -> bytes:
    return (
        "0 1 0 0 K 0.5 w "
        f"{x} {y} m {x + width} {y} l "
        f"{x + width} {y + height} l {x} {y + height} l h S\n"
    ).encode("ascii")


def _make_pdf(
    path,
    *,
    x: float,
    y: float,
    rotate: int = 0,
    user_unit: float = 1.0,
) -> str:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(MEDIA_BOX[2], MEDIA_BOX[3]))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(MEDIA_BOX)
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        _rectangle_content(x, y, 40.0, 30.0)
    )
    if rotate:
        page.obj[pikepdf.Name("/Rotate")] = rotate
    if user_unit != 1.0:
        page.obj[pikepdf.Name("/UserUnit")] = user_unit
    pdf.save(path)
    pdf.close()
    return str(path)


def _detect(path: str) -> DetectedShape:
    doc = pdf_wrapper.open(path)
    try:
        result = detect_die_shapes(doc)
    finally:
        doc.close()
    assert len(result.shapes) == 1
    return result.shapes[0]


def _points_set(points):
    return {(round(x, 6), round(y, 6)) for x, y in points}


def test_hai_contour_cung_shape_giu_origin_page_space_khac_nhau(tmp_path) -> None:
    first = _detect(
        _make_pdf(tmp_path / "first.pdf", x=10.0, y=20.0)
    )
    second = _detect(
        _make_pdf(tmp_path / "second.pdf", x=60.0, y=10.0)
    )

    assert first.type is second.type is ShapeType.RECTANGLE
    # Contract legacy vẫn dịch contour về gốc nên hai hình trùng nhau.
    assert first.poly == second.poly
    assert first.trim == second.trim == Trim(40.0, 30.0)

    assert isinstance(first.page_contour, DetectedPageContour)
    assert isinstance(second.page_contour, DetectedPageContour)
    assert _points_set(first.page_contour.outer_top_down_user_units) == {
        (10.0, 50.0),
        (50.0, 50.0),
        (50.0, 80.0),
        (10.0, 80.0),
    }
    assert _points_set(second.page_contour.outer_top_down_user_units) == {
        (60.0, 60.0),
        (100.0, 60.0),
        (100.0, 90.0),
        (60.0, 90.0),
    }
    assert first.page_contour != second.page_contour


def test_rotate_user_unit_khong_bi_ap_hai_lan_trong_detector(tmp_path) -> None:
    plain = _detect(
        _make_pdf(tmp_path / "plain.pdf", x=10.0, y=20.0)
    )
    rotated = _detect(
        _make_pdf(
            tmp_path / "rotated.pdf",
            x=10.0,
            y=20.0,
            rotate=90,
            user_unit=2.0,
        )
    )

    # page_contour cố ý giữ hệ parser raw. Resolver production là nơi duy nhất
    # áp /Rotate + /UserUnit và sourcePageToCanonical.
    assert rotated.page_contour == plain.page_contour
    # Legacy trim vẫn giữ semantics cũ: /Rotate 90 hoán đổi rộng/cao.
    assert rotated.trim == Trim(30.0, 40.0)
    assert plain.trim == Trim(40.0, 30.0)


def test_polygon_giu_hole_va_multipolygon_fail_closed() -> None:
    shapely = pytest.importorskip("shapely.geometry")
    polygon = shapely.Polygon(
        [(10.0, 10.0), (90.0, 10.0), (90.0, 70.0), (10.0, 70.0)],
        holes=[[(30.0, 25.0), (70.0, 25.0), (70.0, 55.0), (30.0, 55.0)]],
    )
    contour = _polygon_to_page_contour(polygon, 4)
    assert contour is not None
    assert contour.page_index == 4
    assert len(contour.outer_top_down_user_units) == 4
    assert len(contour.holes_top_down_user_units) == 1
    assert _points_set(contour.holes_top_down_user_units[0]) == {
        (30.0, 25.0),
        (70.0, 25.0),
        (70.0, 55.0),
        (30.0, 55.0),
    }

    ambiguous = shapely.MultiPolygon(
        [
            shapely.Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]),
            shapely.Polygon([(20, 0), (30, 0), (30, 10), (20, 10)]),
        ]
    )
    assert _polygon_to_page_contour(ambiguous, 0) is None
    assert _polygon_to_page_contour(None, 0) is None


def test_page_contour_server_only_va_khong_ke_thua_sang_trang_khac() -> None:
    contour = DetectedPageContour(
        page_index=0,
        outer_top_down_user_units=((10.0, 10.0), (50.0, 10.0), (50.0, 30.0), (10.0, 30.0)),
    )
    master = DetectedShape(
        page=0,
        type=ShapeType.RECTANGLE,
        props={},
        trim=Trim(40.0, 20.0),
        poly=((0.0, 0.0), (40.0, 0.0), (40.0, 20.0), (0.0, 20.0)),
        source="separation",
        confidence=1.0,
        page_contour=contour,
    )
    custom = DetectedShape(
        page=1,
        type=ShapeType.CUSTOM,
        props={},
        trim=Trim(200.0, 100.0),
        poly=(),
        source="custom",
        confidence=0.0,
    )
    result = apply_master_die_inheritance(
        DetectionResult(
            shapes=[master, custom],
            statuses=[
                PageDetectionStatus(0, True, "separation"),
                PageDetectionStatus(1, True, "custom"),
            ],
            total_pages=2,
            success_pages=2,
        )
    )
    assert result.shapes[0].page_contour is contour
    assert result.shapes[1].page_contour is None

    payload = shape_to_dict(master)
    assert "page_contour" not in payload
    assert "pageContour" not in payload
    assert "page_contour" not in DETECTED_SHAPE_JSON_SCHEMA["properties"]
    assert shape_from_dict(payload).page_contour is None


@pytest.mark.parametrize(
    "override",
    [
        {"page_index": "0"},
        {"page_index": True},
        {"page_index": 1.5},
        {"page_index": -1},
        {"outer_top_down_user_units": [(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]},
        {"holes_top_down_user_units": []},
        {"outer_top_down_user_units": ([0.0, 0.0], (10.0, 0.0), (0.0, 10.0))},
        {"outer_top_down_user_units": ((0.0,), (10.0, 0.0), (0.0, 10.0))},
        {"outer_top_down_user_units": ((0.0, 0.0, 1.0), (10.0, 0.0), (0.0, 10.0))},
        {"outer_top_down_user_units": ((False, 0.0), (10.0, 0.0), (0.0, 10.0))},
        {"outer_top_down_user_units": (("0", 0.0), (10.0, 0.0), (0.0, 10.0))},
        {"outer_top_down_user_units": ((float("inf"), 0.0), (10.0, 0.0), (0.0, 10.0))},
        {"outer_top_down_user_units": ((0.0, 0.0), (0.0, 0.0), (10.0, 10.0))},
        {"holes_top_down_user_units": (((1.0, 1.0), (2.0, 1.0)),)},
    ],
)
def test_page_contour_reject_strict_type_contract(override) -> None:
    values = {
        "page_index": 0,
        "outer_top_down_user_units": (
            (0.0, 0.0),
            (10.0, 0.0),
            (0.0, 10.0),
        ),
        "holes_top_down_user_units": (),
    }
    values.update(override)
    with pytest.raises(ValueError):
        DetectedPageContour(**values)


def test_page_contour_reject_mismatch_page() -> None:
    contour = DetectedPageContour(
        page_index=2,
        outer_top_down_user_units=((0.0, 0.0), (10.0, 0.0), (0.0, 10.0)),
    )
    with pytest.raises(ValueError, match="chính trang"):
        DetectedShape(
            page=1,
            type=ShapeType.CUSTOM,
            props={},
            trim=Trim(10.0, 10.0),
            poly=(),
            source="custom",
            confidence=0.0,
            page_contour=contour,
        )


# ── §A4b-3: lỗ khuôn trong contour production của lane CNC ────────────────────

def _multi_ring_content(rings) -> bytes:
    """Nhiều vòng kín trong MỘT lệnh vẽ, đúng cách file khuôn thật được vẽ."""

    body = ["0 1 0 0 K 0.5 w "]
    for x0, y0, x1, y1 in rings:
        body.append(f"{x0} {y0} m {x1} {y0} l {x1} {y1} l {x0} {y1} l h ")
    body.append("S\n")
    return "".join(body).encode("ascii")


def _make_multi_ring_pdf(path, rings) -> str:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(MEDIA_BOX[2], MEDIA_BOX[3]))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(list(MEDIA_BOX))
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        _multi_ring_content(rings)
    )
    pdf.save(path)
    pdf.close()
    return str(path)


def test_contour_cnc_giu_cua_so_lam_lo_khuon(tmp_path) -> None:
    """Khuôn CNC có cửa sổ ⇒ ``page_contour`` phải mang đúng 1 lỗ.

    NEST (audit 2026-08-28 §A4b-3). `_same_color_group_poly` hợp mọi subpath thành
    hình ĐẶC, nên contour production của lane CNC mất cửa sổ y như lane tem trước
    §A4b-2. Bản vá chạy lượt riêng có giữ lỗ cho contour.
    """

    shape = _detect(
        _make_multi_ring_pdf(
            tmp_path / "cua-so.pdf",
            [(20.0, 20.0, 120.0, 80.0), (50.0, 40.0, 90.0, 60.0)],
        )
    )

    contour = shape.page_contour
    assert contour is not None
    assert len(contour.holes_top_down_user_units) == 1

    hole = contour.holes_top_down_user_units[0]
    xs = [x for x, _ in hole]
    assert min(xs) == pytest.approx(50.0, abs=0.01)
    assert max(xs) == pytest.approx(90.0, abs=0.01)


def test_contour_cnc_giu_nhieu_lo(tmp_path) -> None:
    """Panel đục 4 lỗ ⇒ đủ 4 lỗ, không gộp, không mất."""

    shape = _detect(
        _make_multi_ring_pdf(
            tmp_path / "panel.pdf",
            [
                (10.0, 10.0, 180.0, 90.0),
                (20.0, 20.0, 40.0, 40.0),
                (60.0, 20.0, 80.0, 40.0),
                (100.0, 20.0, 120.0, 40.0),
                (140.0, 20.0, 160.0, 40.0),
            ],
        )
    )

    contour = shape.page_contour
    assert contour is not None
    assert len(contour.holes_top_down_user_units) == 4


def test_lo_khuon_khong_doi_poly_legacy_cua_detected_shape(tmp_path) -> None:
    """Bất biến quan trọng nhất của lô: ``DetectedShape.poly`` KHÔNG được đổi.

    `poly` là hình học lane legacy dùng cho collision/nesting CNC và được
    serialize qua schema. Đo thật cho thấy nếu bật cờ giữ lỗ trên CÙNG một lượt
    thì `poly` đổi từ 5 sang 8 điểm (cùng hình, khác biểu diễn đỉnh) — đủ để đổi
    fingerprint và phá golden. Vì vậy contour đi lượt riêng.
    """

    rings = [(20.0, 20.0, 120.0, 80.0), (50.0, 40.0, 90.0, 60.0)]
    shape = _detect(_make_multi_ring_pdf(tmp_path / "poly.pdf", rings))

    # Hợp của biên ngoài với cửa sổ = biên ngoài, GEOS chuẩn hoá về 5 điểm.
    assert len(shape.poly) == 5
    assert _points_set(shape.poly) == {
        (0.0, 0.0), (100.0, 0.0), (100.0, 60.0), (0.0, 60.0),
    }
    # Nhưng contour production vẫn có lỗ.
    assert len(shape.page_contour.holes_top_down_user_units) == 1


def test_khuon_long_nhieu_tang_lui_ve_hinh_dac_khong_fail_closed(tmp_path) -> None:
    """Lồng 3 tầng ⇒ MultiPolygon ⇒ contour lùi về hình đặc, KHÔNG mất contour.

    `_polygon_to_page_contour` fail-closed với MultiPolygon là chủ đích. Nếu để
    lượt giữ lỗ quyết một mình thì ca này mất contour hoàn toàn — hồi quy so với
    trước bản vá. Nhánh lùi giữ đúng hành vi cũ và ghi nhận đây là giới hạn.
    """

    shape = _detect(
        _make_multi_ring_pdf(
            tmp_path / "long.pdf",
            [
                (20.0, 20.0, 140.0, 90.0),
                (40.0, 35.0, 120.0, 75.0),
                (60.0, 45.0, 100.0, 65.0),
            ],
        )
    )

    contour = shape.page_contour
    assert contour is not None, "không được mất contour vì khuôn lồng nhiều tầng"
    assert contour.holes_top_down_user_units == ()


def test_khuon_khong_lo_giu_nguyen_ca_contour_va_poly(tmp_path) -> None:
    """Ca phổ biến nhất: khuôn một vòng, cả contour lẫn poly không đổi."""

    shape = _detect(
        _make_multi_ring_pdf(tmp_path / "tron.pdf", [(20.0, 20.0, 120.0, 80.0)])
    )

    assert shape.page_contour is not None
    assert shape.page_contour.holes_top_down_user_units == ()
    assert len(shape.poly) == 8
