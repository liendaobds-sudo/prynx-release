"""Regression: guillotine preview follows live thumbnail types, not disk PDF pages."""

import asyncio

from unittest.mock import patch

import pytest

from fastapi import HTTPException
from app.api.routes.imposition import PreviewLayoutBatchRequest, PreviewLayoutRequest, get_pdf_meta, preview_layout, preview_layouts_batch
from app.workers import pdf_wrapper as pdf_lib


def _make_one_page_pdf(path: str) -> None:
    doc = pdf_lib.open()
    doc.new_page(width=100.0, height=100.0)
    doc.save(path)
def _make_sized_pdf(path: str, sizes: list[tuple[float, float]]) -> None:
    doc = pdf_lib.open()
    for width, height in sizes:
        doc.new_page(width=width, height=height)
    doc.save(path)
    doc.close()


    doc.close()


@pytest.mark.parametrize("layout_type", ["sequential", "ratio_stack"])
def test_three_live_thumbnail_types_are_all_visible_from_one_page_pdf(
    tmp_path, layout_type
):
    """Three viewer samples must not fall back to a preview containing only type 1."""
    source = str(tmp_path / f"guillotine-{layout_type}.pdf")
    _make_one_page_pdf(source)

    req = PreviewLayoutRequest(
        usable_w=400.0,
        usable_h=400.0,
        item_w=100.0,
        item_h=100.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        shape_type="CUSTOM",
        sheet_w=400.0,
        sheet_h=400.0,
        path=source,
        task_mode="nup",
        layout_type=layout_type,
        is_die_cut=False,
        total_pages=3,
        target_quantity=0,
        target_quantities_by_page={},
    )

    result = asyncio.run(preview_layout(req, {}))

    assert result["strategyUsed"] == layout_type
    assert result["isMixedPreview"] is True
    page_indexes = [cell["pageIdx"] for cell in result["cells"]]
    assert set(page_indexes) == {0, 1, 2}
    assert len(page_indexes) == result["totalItems"]
    assert sum(result["placedByPage"].values()) == result["totalItems"]

    # Auto-fill groups each type into one contiguous block for guillotine cutting.
    transitions = sum(a != b for a, b in zip(page_indexes, page_indexes[1:]))
    assert transitions == 2


def test_step_repeat_labels_cells_as_the_selected_thumbnail_type(tmp_path):
    """Selecting live type 3 must not leave every preview cell labelled as type 1."""
    source = str(tmp_path / "guillotine-repeat.pdf")
    _make_one_page_pdf(source)

    req = PreviewLayoutRequest(
        usable_w=400.0,
        usable_h=400.0,
        item_w=100.0,
        item_h=100.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        shape_type="CUSTOM",
        sheet_w=400.0,
        sheet_h=400.0,
        path=source,
        task_mode="step_repeat",
        layout_type="repeat",
        is_die_cut=False,
        total_pages=3,
        page_idx=2,
        target_quantity=0,
    )

    result = asyncio.run(preview_layout(req, {}))

    assert result["success"] is True
    assert result["absPlacement"] is False
    assert result["cells"]
    assert {cell["pageIdx"] for cell in result["cells"]} == {2}


def test_multi_design_preview_rejects_mixed_page_sizes(tmp_path):
    source = str(tmp_path / "guillotine-mixed-sizes.pdf")
    _make_sized_pdf(source, [(100.0, 100.0), (200.0, 200.0)])
    req = PreviewLayoutRequest(
        usable_w=400.0,
        usable_h=400.0,
        item_w=100.0,
        item_h=100.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        shape_type="CUSTOM",
        path=source,
        task_mode="nup",
        layout_type="sequential",
        is_die_cut=False,
        total_pages=2,
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(preview_layout(req, {}))
    assert exc.value.status_code == 422
    assert "c\u00f9ng k\u00edch th\u01b0\u1edbc" in str(exc.value.detail)


def test_manual_preview_returns_exact_grid(tmp_path):
    source = str(tmp_path / "guillotine-manual.pdf")
    _make_one_page_pdf(source)
    req = PreviewLayoutRequest(
        usable_w=400.0,
        usable_h=400.0,
        item_w=100.0,
        item_h=100.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="manual",
        cols=2,
        rows=2,
        shape_type="CUSTOM",
        path=source,
        task_mode="step_repeat",
        layout_type="repeat",
        is_die_cut=False,
    )

    result = asyncio.run(preview_layout(req, {}))
    assert result["totalItems"] == 4
    assert len(result["cells"]) == 4


def test_guillotine_cluster_forwards_nesting_and_cut_mode(tmp_path):
    source = str(tmp_path / "guillotine-cluster.pdf")
    _make_sized_pdf(source, [(100.0, 100.0), (100.0, 100.0)])
    req = PreviewLayoutRequest(
        usable_w=400.0,
        usable_h=400.0,
        item_w=100.0,
        item_h=100.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        shape_type="CUSTOM",
        path=source,
        task_mode="nup",
        layout_type="sequential",
        is_die_cut=False,
        grouping_strategy="cluster_tile",
        cluster_nesting=False,
        cluster_w=200.0,
        cluster_h=200.0,
        total_pages=2,
    )
    captured = {}

    def fake_cluster(**kwargs):
        captured.update(kwargs)
        return [([], {"v": set(), "h": set()})]

    with patch(
        "app.workers.cluster_tile_engine.compute_cluster_sheets",
        side_effect=fake_cluster,
    ):
        result = asyncio.run(preview_layout(req, {}))

    assert result["success"] is True
    assert captured["cluster_nesting"] is False
    assert captured["is_die_cut"] is False


def test_pdf_meta_returns_dimensions_for_every_large_document_page(tmp_path):
    source = str(tmp_path / "large-metadata.pdf")
    sizes = [(100.0, 100.0)] * 204 + [(250.0, 300.0)]
    _make_sized_pdf(source, sizes)

    result = asyncio.run(get_pdf_meta({"path": source}))

    assert result["page_count"] == 205
    assert len(result["pages"]) == 205
    assert result["pages"][-1]["width_pt"] == 250.0


def test_batch_preview_rejects_zero_page_dimensions(tmp_path):
    source = str(tmp_path / "batch-zero.pdf")
    _make_one_page_pdf(source)
    req = PreviewLayoutBatchRequest(
        usable_w=400.0,
        usable_h=400.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        pages=[{"page_idx": 0, "item_w": 0.0, "item_h": 0.0}],
        path=source,
        task_mode="nup",
        is_die_cut=False,
    )

    with pytest.raises(HTTPException) as exc:
        preview_layouts_batch(req, {})
    assert exc.value.status_code == 422


def test_batch_manual_capacity_matches_requested_grid(tmp_path):
    source = str(tmp_path / "batch-manual.pdf")
    _make_one_page_pdf(source)
    req = PreviewLayoutBatchRequest(
        usable_w=400.0,
        usable_h=400.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="manual",
        cols=2,
        rows=2,
        pages=[{"page_idx": 0, "item_w": 100.0, "item_h": 100.0}],
        path=source,
        task_mode="nup",
        is_die_cut=False,
    )

    result = preview_layouts_batch(req, {})
    assert result["capacities"] == {0: 4}


def test_batch_manual_overflow_does_not_report_capacity(tmp_path):
    source = str(tmp_path / "batch-manual-overflow.pdf")
    _make_one_page_pdf(source)
    req = PreviewLayoutBatchRequest(
        usable_w=150.0,
        usable_h=150.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="manual",
        cols=2,
        rows=2,
        pages=[{"page_idx": 0, "item_w": 100.0, "item_h": 100.0}],
        path=source,
        task_mode="nup",
        is_die_cut=False,
    )

    result = preview_layouts_batch(req, {})
    assert result["capacities"] == {0: 0}
