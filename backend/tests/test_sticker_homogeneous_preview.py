"""Regression: thumbnail duplicates must appear across homogeneous preview sheets."""

import asyncio

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import pdf_wrapper as pdf_lib
from tests.license_helpers import PRO_LICENSE


def _make_single_mold_pdf(path: str, page_count: int = 45) -> None:
    doc = pdf_lib.open()

    master = doc.new_page(width=100.0, height=100.0)
    die = master.new_shape()
    die.draw_rect(pdf_lib.Rect(10.0, 20.0, 90.0, 80.0))
    die.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)
    die.commit()

    for _ in range(page_count - 1):
        page = doc.new_page(width=100.0, height=100.0)
        artwork = page.new_shape()
        artwork.draw_rect(pdf_lib.Rect(25.0, 30.0, 75.0, 70.0))
        artwork.finish(
            color=(0.0, 0.0, 0.0, 1.0),
            fill=(0.0, 0.0, 0.0, 1.0),
        )
        artwork.commit()

    doc.save(path)
    doc.close()


def test_45_thumbnails_fill_two_28_up_preview_sheets_in_grouped_order(tmp_path):
    """45 types on 28-up sheets fill both sheets and stay grouped by type."""
    source = str(tmp_path / "hom45.pdf")
    _make_single_mold_pdf(source)

    req = PreviewLayoutRequest(
        usable_w=400.0,
        usable_h=400.0,
        item_w=80.0,
        item_h=60.0,
        gap_x=8.0,
        gap_y=8.0,
        strategy="optimal_auto",
        shape_type="CIRCLE_ELLIPSE",
        sheet_w=400.0,
        sheet_h=400.0,
        path=source,
        task_mode="nup",
        layout_type="ratio_stack",
        is_die_cut=True,
        total_pages=45,
        detected_shapes_by_page={str(i): "CIRCLE_ELLIPSE" for i in range(45)},
        detected_shape_params_by_page={
            str(i): ({"inheritedFromPage": 0} if i else {})
            for i in range(45)
        },
    )

    result = preview_layout(req, PRO_LICENSE)

    assert result["strategyUsed"] == "homogeneous"
    assert result["totalContentItems"] == 45
    assert result["sheetsNeeded"] == 2
    assert [len(sheet["cells"]) for sheet in result["sheets"]] == [28, 28]
    assert result["totalItems"] == 28
    expected = [
        src
        for src in range(45)
        for _ in range(2 if src < 11 else 1)
    ]
    actual = [cell["pageIdx"] for sheet in result["sheets"] for cell in sheet["cells"]]
    assert actual == expected


def test_capacity_is_not_confused_with_number_of_source_samples(tmp_path):
    """45 source samples auto-fill a >45-up sheet without redefining its capacity."""
    source = str(tmp_path / "hom45-roomy.pdf")
    _make_single_mold_pdf(source)

    req = PreviewLayoutRequest(
        usable_w=700.0,
        usable_h=700.0,
        item_w=80.0,
        item_h=60.0,
        gap_x=8.0,
        gap_y=8.0,
        strategy="optimal_auto",
        shape_type="CIRCLE_ELLIPSE",
        sheet_w=700.0,
        sheet_h=700.0,
        path=source,
        task_mode="nup",
        layout_type="ratio_stack",
        is_die_cut=True,
        total_pages=45,
        detected_shapes_by_page={str(i): "CIRCLE_ELLIPSE" for i in range(45)},
        detected_shape_params_by_page={
            str(i): ({"inheritedFromPage": 0} if i else {})
            for i in range(45)
        },
    )

    result = preview_layout(req, PRO_LICENSE)

    assert result["strategyUsed"] == "homogeneous"
    assert result["totalContentItems"] == 45
    assert result["totalItems"] > 45
    assert result["sheetsNeeded"] == 1
    assert len(result["sheets"]) == 1
    assert len(result["sheets"][0]["cells"]) == result["totalItems"]
    roomy_pages = [cell["pageIdx"] for cell in result["sheets"][0]["cells"]]
    base, remainder = divmod(result["totalItems"], 45)
    expected = [
        src
        for src in range(45)
        for _ in range(base + (1 if src < remainder else 0))
    ]
    assert roomy_pages == expected


def test_live_thumbnail_count_can_exceed_physical_preview_pdf(tmp_path):
    """Preview follows 45 thumbnails even while its fallback PDF still has 28 pages."""
    source = str(tmp_path / "hom28-physical-45-live.pdf")
    _make_single_mold_pdf(source, page_count=28)

    req = PreviewLayoutRequest(
        usable_w=700.0,
        usable_h=700.0,
        item_w=80.0,
        item_h=60.0,
        gap_x=8.0,
        gap_y=8.0,
        strategy="optimal_auto",
        shape_type="CIRCLE_ELLIPSE",
        sheet_w=700.0,
        sheet_h=700.0,
        path=source,
        task_mode="nup",
        layout_type="ratio_stack",
        is_die_cut=True,
        total_pages=45,
        detected_shapes_by_page={str(i): "CIRCLE_ELLIPSE" for i in range(28)},
        detected_shape_params_by_page={
            str(i): ({"inheritedFromPage": 0} if i else {})
            for i in range(28)
        },
    )

    result = preview_layout(req, PRO_LICENSE)

    assert result["strategyUsed"] == "homogeneous"
    assert result["totalContentItems"] == 45
    assert result["sheetsNeeded"] == 1
    assert len(result["sheets"][0]["cells"]) == result["totalItems"]
    live_pages = [cell["pageIdx"] for cell in result["sheets"][0]["cells"]]
    base, remainder = divmod(result["totalItems"], 45)
    expected = [
        src
        for src in range(45)
        for _ in range(base + (1 if src < remainder else 0))
    ]
    assert live_pages == expected
