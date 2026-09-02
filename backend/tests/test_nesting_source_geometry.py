from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

import pytest
from shapely.geometry import MultiPolygon, Polygon

from app.core.nesting_source_geometry import (
    NestingSourceGeometryError,
    resolve_cnc_source_geometry,
    resolve_sticker_source_geometry,
)
from app.core.nesting_source_pin import PinnedNestingSource, PinnedPageMetadata
from app.workers.die_detection import (
    DetectedPageContour,
    DetectedShape,
    Trim,
)
from app.workers.shape_types import ShapeType


_PT_TO_MM = 25.4 / 72.0
_MEDIA_BOX = (10.0, 20.0, 110.0, 70.0)


class _FakeDocument:
    def __init__(
        self,
        pages: list[Any],
        *,
        page_count: int | None = None,
        fail_index: bool = False,
    ) -> None:
        self.pages = pages
        self.page_count = len(pages) if page_count is None else page_count
        self.fail_index = fail_index
        self.closed = False

    def __len__(self) -> int:
        return len(self.pages)

    def __getitem__(self, index: int) -> Any:
        if self.fail_index:
            raise IndexError("trang hỏng")
        return self.pages[index]

    def close(self) -> None:
        self.closed = True


def _expected_affine(
    media_box: tuple[float, float, float, float],
    rotate_deg: int,
) -> tuple[float, float, float, float, float, float]:
    x0, y0, x1, y1 = media_box
    return {
        0: (1.0, 0.0, 0.0, 1.0, -x0, -y0),
        90: (0.0, -1.0, 1.0, 0.0, -y0, x1),
        180: (-1.0, 0.0, 0.0, -1.0, x1, y1),
        270: (0.0, 1.0, -1.0, 0.0, y1, -x0),
    }[rotate_deg]


def _metadata(
    page_index: int = 0,
    *,
    rotate_deg: int = 0,
    user_unit: float = 2.0,
    media_box: tuple[float, float, float, float] = _MEDIA_BOX,
) -> PinnedPageMetadata:
    boxes = {
        "mediaBox": list(media_box),
        "cropBox": list(media_box),
        "trimBox": list(media_box),
    }
    return PinnedPageMetadata(
        page_index=page_index,
        page_boxes_mm=boxes,
        user_unit=user_unit,
        rotate_deg=rotate_deg,
        source_page_to_canonical=_expected_affine(media_box, rotate_deg),
    )


def _pin(
    *pages: PinnedPageMetadata,
    snapshot_path: Path = Path("D:/pinned/nesting-source.pdf"),
    page_count: int | None = None,
) -> PinnedNestingSource:
    resolved_pages = pages or (_metadata(),)
    return PinnedNestingSource(
        locator_id="locator",
        content_hash="a" * 64,
        byte_size=123,
        page_count=len(resolved_pages) if page_count is None else page_count,
        revision="revision",
        pages=tuple(resolved_pages),
        snapshot_path=snapshot_path,
        lease_token="lease",
    )


def _raw_mm_to_top_down_user_units(
    point: tuple[float, float],
    *,
    metadata: PinnedPageMetadata,
) -> tuple[float, float]:
    scale = metadata.user_unit * _PT_TO_MM
    media_box = metadata.page_boxes_mm["mediaBox"]
    media_height_user = (media_box[3] - media_box[1]) / scale
    return (point[0] / scale, media_height_user - point[1] / scale)


def _polygon_from_raw_mm(
    metadata: PinnedPageMetadata,
    outer: tuple[tuple[float, float], ...],
    holes: tuple[tuple[tuple[float, float], ...], ...] = (),
) -> Polygon:
    return Polygon(
        [_raw_mm_to_top_down_user_units(point, metadata=metadata) for point in outer],
        [
            [_raw_mm_to_top_down_user_units(point, metadata=metadata) for point in hole]
            for hole in holes
        ],
    )


def _opener(
    *,
    pages: list[Any] | None = None,
    page_count: int | None = None,
    fail_index: bool = False,
) -> tuple[Callable[[str], _FakeDocument], _FakeDocument, list[str]]:
    document = _FakeDocument(
        pages or [object()],
        page_count=page_count,
        fail_index=fail_index,
    )
    opened_paths: list[str] = []

    def open_document(path: str) -> _FakeDocument:
        opened_paths.append(path)
        return document

    return open_document, document, opened_paths


def _assert_ring(
    actual: tuple[tuple[float, float], ...],
    expected: tuple[tuple[float, float], ...],
) -> None:
    assert len(actual) == len(expected)
    for actual_point, expected_point in zip(actual, expected):
        assert actual_point == pytest.approx(expected_point, abs=1e-9)


def _apply_expected_affine(
    point: tuple[float, float],
    metadata: PinnedPageMetadata,
) -> tuple[float, float]:
    a, b, c, d, e, f = metadata.source_page_to_canonical
    x, y = point
    return (a * x + c * y + e, b * x + d * y + f)


@pytest.mark.parametrize("rotate_deg", [0, 90])
def test_sticker_doi_user_unit_va_ap_affine_dung_mot_lan(rotate_deg: int) -> None:
    metadata = _metadata(rotate_deg=rotate_deg, user_unit=2.0)
    outer_raw_mm = (
        (30.0, 30.0),
        (50.0, 30.0),
        (50.0, 50.0),
        (30.0, 50.0),
    )
    polygon = _polygon_from_raw_mm(metadata, outer_raw_mm)
    open_document, document, opened_paths = _opener()
    pin = _pin(metadata)

    result = resolve_sticker_source_geometry(
        pin,
        0,
        polygon_extractor=lambda page: polygon,
        document_opener=open_document,
    )

    expected = tuple(
        _apply_expected_affine(point, metadata) for point in outer_raw_mm
    )
    assert result.source_kind == "sticker"
    assert result.page_index == 0
    _assert_ring(result.polygon.outer, expected)
    assert result.polygon.holes == ()
    assert opened_paths == [str(pin.snapshot_path)]
    assert document.closed is True


def test_sticker_giu_nguyen_hole_trong_canonical_mm() -> None:
    metadata = _metadata(rotate_deg=90)
    outer_raw_mm = (
        (30.0, 30.0),
        (60.0, 30.0),
        (60.0, 60.0),
        (30.0, 60.0),
    )
    hole_raw_mm = (
        (40.0, 40.0),
        (40.0, 50.0),
        (50.0, 50.0),
        (50.0, 40.0),
    )
    polygon = _polygon_from_raw_mm(metadata, outer_raw_mm, (hole_raw_mm,))
    open_document, _, _ = _opener()

    result = resolve_sticker_source_geometry(
        _pin(metadata),
        0,
        polygon_extractor=lambda page: polygon,
        document_opener=open_document,
    )

    assert len(result.polygon.holes) == 1
    _assert_ring(
        result.polygon.holes[0],
        tuple(_apply_expected_affine(point, metadata) for point in hole_raw_mm),
    )


@pytest.mark.parametrize("page_index", [True, -1, 1])
def test_reject_page_index_khong_chinh_xac(page_index: Any) -> None:
    def must_not_open(path: str) -> Any:
        raise AssertionError("Không được mở snapshot khi page_index sai")

    with pytest.raises(NestingSourceGeometryError):
        resolve_sticker_source_geometry(
            _pin(),
            page_index,
            polygon_extractor=lambda page: None,
            document_opener=must_not_open,
        )


@pytest.mark.parametrize(
    "pin",
    [
        _pin(_metadata(), page_count=2),
        _pin(_metadata(0), _metadata(0)),
        _pin(
            replace(
                _metadata(),
                page_boxes_mm={
                    **_metadata().page_boxes_mm,
                    "bleedBox": list(_MEDIA_BOX),
                },
            )
        ),
        _pin(
            replace(
                _metadata(),
                source_page_to_canonical=(1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
            )
        ),
    ],
)
def test_reject_metadata_thieu_trung_sai_thu_tu_hoac_sai_affine(
    pin: PinnedNestingSource,
) -> None:
    with pytest.raises(NestingSourceGeometryError):
        resolve_sticker_source_geometry(
            pin,
            0,
            polygon_extractor=lambda page: None,
            document_opener=lambda path: _FakeDocument([object()]),
        )


@pytest.mark.parametrize(
    "polygon",
    [
        None,
        Polygon(),
        Polygon(((0.0, 0.0), (2.0, 2.0), (0.0, 2.0), (2.0, 0.0))),
        MultiPolygon(
            [
                Polygon(((0.0, 0.0), (1.0, 0.0), (1.0, 1.0))),
                Polygon(((3.0, 0.0), (4.0, 0.0), (4.0, 1.0))),
            ]
        ),
    ],
)
def test_sticker_fail_closed_khi_contour_thieu_rong_invalid_hoac_ambiguous(
    polygon: Any,
) -> None:
    open_document, document, _ = _opener()

    with pytest.raises(NestingSourceGeometryError):
        resolve_sticker_source_geometry(
            _pin(),
            0,
            polygon_extractor=lambda page: polygon,
            document_opener=open_document,
        )

    assert document.closed is True


def test_sticker_khong_fallback_bbox() -> None:
    page = {"bbox": (0.0, 0.0, 999.0, 999.0)}
    open_document, _, _ = _opener(pages=[page])

    with pytest.raises(
        NestingSourceGeometryError,
        match="Không tìm thấy contour bế semantic",
    ):
        resolve_sticker_source_geometry(
            _pin(),
            0,
            polygon_extractor=lambda source_page: None,
            document_opener=open_document,
        )


def test_reject_snapshot_thieu_va_page_count_khong_khop() -> None:
    def missing_snapshot(path: str) -> Any:
        raise FileNotFoundError(path)

    with pytest.raises(NestingSourceGeometryError, match="Không mở được PDF snapshot"):
        resolve_sticker_source_geometry(
            _pin(),
            0,
            polygon_extractor=lambda page: None,
            document_opener=missing_snapshot,
        )

    open_document, document, _ = _opener(page_count=2)
    with pytest.raises(NestingSourceGeometryError, match="Số trang PDF snapshot"):
        resolve_sticker_source_geometry(
            _pin(),
            0,
            polygon_extractor=lambda page: None,
            document_opener=open_document,
        )
    assert document.closed is True


def test_loi_doc_page_snapshot_duoc_wrap_va_dong_document() -> None:
    open_document, document, _ = _opener(fail_index=True)

    with pytest.raises(
        NestingSourceGeometryError,
        match="Không đọc được trang đã pin",
    ):
        resolve_sticker_source_geometry(
            _pin(),
            0,
            polygon_extractor=lambda page: None,
            document_opener=open_document,
        )

    assert document.closed is True


def _detected_shape(
    contour: DetectedPageContour | None,
    *,
    page: int = 0,
) -> DetectedShape:
    return DetectedShape(
        page=page,
        type=ShapeType.CUSTOM,
        props={},
        trim=Trim(w=100.0, h=50.0),
        poly=(),
        source="vector",
        confidence=1.0,
        page_contour=contour,
    )


def test_cnc_chi_dung_page_contour_va_giu_hole() -> None:
    metadata = _metadata(rotate_deg=90)
    outer_raw_mm = (
        (30.0, 30.0),
        (60.0, 30.0),
        (60.0, 60.0),
        (30.0, 60.0),
    )
    hole_raw_mm = (
        (40.0, 40.0),
        (40.0, 50.0),
        (50.0, 50.0),
        (50.0, 40.0),
    )
    contour = DetectedPageContour(
        page_index=0,
        outer_top_down_user_units=tuple(
            _raw_mm_to_top_down_user_units(point, metadata=metadata)
            for point in outer_raw_mm
        ),
        holes_top_down_user_units=(
            tuple(
                _raw_mm_to_top_down_user_units(point, metadata=metadata)
                for point in hole_raw_mm
            ),
        ),
    )
    open_document, document, _ = _opener()

    result = resolve_cnc_source_geometry(
        _pin(metadata),
        0,
        _detected_shape(contour),
        document_opener=open_document,
    )

    assert result.source_kind == "cnc"
    _assert_ring(
        result.polygon.outer,
        tuple(_apply_expected_affine(point, metadata) for point in outer_raw_mm),
    )
    assert len(result.polygon.holes) == 1
    _assert_ring(
        result.polygon.holes[0],
        tuple(_apply_expected_affine(point, metadata) for point in hole_raw_mm),
    )
    assert document.closed is True


def test_cnc_reject_shape_khong_co_page_contour_khong_dung_legacy_poly() -> None:
    legacy_shape = replace(
        _detected_shape(None),
        poly=((0.0, 0.0), (100.0, 0.0), (100.0, 50.0)),
    )

    with pytest.raises(
        NestingSourceGeometryError,
        match="không có page-space contour",
    ):
        resolve_cnc_source_geometry(
            _pin(),
            0,
            legacy_shape,
            document_opener=lambda path: _FakeDocument([object()]),
        )


def test_cnc_reject_shape_khac_trang_va_contour_invalid() -> None:
    metadata0 = _metadata(0)
    metadata1 = _metadata(1)
    valid_contour = DetectedPageContour(
        page_index=0,
        outer_top_down_user_units=((0.0, 0.0), (10.0, 0.0), (10.0, 10.0)),
    )
    with pytest.raises(NestingSourceGeometryError, match="không thuộc page_index"):
        resolve_cnc_source_geometry(
            _pin(metadata0, metadata1),
            1,
            _detected_shape(valid_contour),
            document_opener=lambda path: _FakeDocument([object(), object()]),
        )

    bow_tie = DetectedPageContour(
        page_index=0,
        outer_top_down_user_units=(
            (0.0, 0.0),
            (10.0, 10.0),
            (0.0, 10.0),
            (10.0, 0.0),
        ),
    )
    open_document, document, _ = _opener()
    with pytest.raises(NestingSourceGeometryError, match="tự cắt"):
        resolve_cnc_source_geometry(
            _pin(),
            0,
            _detected_shape(bow_tie),
            document_opener=open_document,
        )
    assert document.closed is True