"""Hồi quy preview duplex với lề bất đối xứng."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import pdf_wrapper as pdf_lib
from app.workers.mixed_guillotine_adapter import full_span_cut_coordinates
from tests.license_helpers import PRO_LICENSE


def _make_duplex_pdf(path: str) -> None:
    doc = pdf_lib.open()
    doc.new_page(width=60.0, height=40.0)
    doc.new_page(width=60.0, height=40.0)
    doc.save(path)
    doc.close()


@pytest.mark.parametrize(
    ("flip_edge", "axis", "front_origin", "back_origin"),
    [
        ("long", "x", 10.0, 20.0),
        ("short", "y", 5.0, 25.0),
    ],
)
def test_preview_projects_cut_bounds_with_each_materialized_face(
    tmp_path, flip_edge, axis, front_origin, back_origin
):
    source = str(tmp_path / f"asymmetric-{flip_edge}.pdf")
    _make_duplex_pdf(source)
    request = PreviewLayoutRequest(
        usable_w=270.0,
        usable_h=170.0,
        item_w=60.0,
        item_h=40.0,
        gap_x=5.0,
        gap_y=5.0,
        strategy="optimal_auto",
        sheet_w=300.0,
        sheet_h=200.0,
        margin_left=10.0,
        margin_right=20.0,
        margin_top=5.0,
        margin_bottom=25.0,
        path=source,
        task_mode="nup",
        layout_type="mixed_guillotine",
        duplex_flow="double",
        duplex_flip_edge=flip_edge,
        target_quantities_by_page={"0": 1},
    )
    captured_bounds: list[dict] = []

    def capture(metadata, **kwargs):
        captured_bounds.append(dict(kwargs["usable_rect"]))
        return full_span_cut_coordinates(metadata, **kwargs)

    with patch(
        "app.workers.mixed_guillotine_adapter.full_span_cut_coordinates",
        side_effect=capture,
    ):
        result = preview_layout(request, PRO_LICENSE)

    assert captured_bounds == [sheet["cutTree"]["rect"] for sheet in result["sheets"]]
    assert captured_bounds[0][axis] == pytest.approx(front_origin)
    assert captured_bounds[1][axis] == pytest.approx(back_origin)
