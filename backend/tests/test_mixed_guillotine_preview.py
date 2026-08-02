"""Preview backend cho chế độ Dàn nhiều kích thước."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import mixed_guillotine as mixed_guillotine_module
from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib
from app.workers.mixed_guillotine import (
    MixedGuillotineSettings,
    PLAN_VERSION,
    Rect,
    build_mixed_guillotine_plan,
)
from app.workers.mixed_guillotine_adapter import (
    build_product_specs,
    resolve_guillotine_trim,
)
from tests.license_helpers import PRO_LICENSE


MM_TO_PT = 2.83465
SHEET_WIDTH = 300.0
SHEET_HEIGHT = 200.0
MARGIN = 10.0
USABLE_WIDTH = SHEET_WIDTH - 2 * MARGIN
USABLE_HEIGHT = SHEET_HEIGHT - 2 * MARGIN


def _make_pdf(path: str, sizes: list[tuple[float, float]]) -> None:
    doc = pdf_lib.open()
    for width, height in sizes:
        doc.new_page(width=width, height=height)
    doc.save(path)
    doc.close()


def _request(path: str, **overrides) -> PreviewLayoutRequest:
    values = {
        "usable_w": USABLE_WIDTH,
        "usable_h": USABLE_HEIGHT,
        "item_w": 100.0,
        "item_h": 80.0,
        "gap_x": 5.0,
        "gap_y": 5.0,
        "strategy": "optimal_auto",
        "shape_type": "CUSTOM",
        "sheet_w": SHEET_WIDTH,
        "sheet_h": SHEET_HEIGHT,
        "margin_left": MARGIN,
        "margin_right": MARGIN,
        "margin_top": MARGIN,
        "margin_bottom": MARGIN,
        "path": path,
        "task_mode": "nup",
        "layout_type": "mixed_guillotine",
        "is_die_cut": False,
        "duplex_flow": "normal",
        "duplex_flip_edge": "long",
        "mixed_guillotine_strategy": "auto_zone",
        "target_quantity": 0,
        "target_quantities_by_page": {"0": 1, "1": 1},
    }
    values.update(overrides)
    return PreviewLayoutRequest(**values)


def _expected_plan(path: str, *, duplex: bool = False, flip_edge: str = "long") -> dict:
    doc = pdf_lib.open(path)
    try:
        trim_sizes = [resolve_guillotine_trim(doc[idx], 0.0) for idx in range(doc.page_count)]
    finally:
        doc.close()
    products = build_product_specs(
        trim_sizes,
        target_quantity=0,
        target_quantities_by_page={"0": 1, "2": 1} if duplex else {"0": 1, "1": 1},
        duplex=duplex,
    )
    return build_mixed_guillotine_plan(
        products,
        MixedGuillotineSettings(
            sheet_width=SHEET_WIDTH,
            sheet_height=SHEET_HEIGHT,
            usable_rect=Rect(MARGIN, MARGIN, USABLE_WIDTH, USABLE_HEIGHT),
            gap_x=5.0,
            gap_y=5.0,
            duplex=duplex,
            flip_edge=flip_edge,
        ),
    )


def test_one_sided_mixed_preview_uses_shared_plan_and_never_falls_back_to_nfp(tmp_path):
    source = str(tmp_path / "mixed-preview.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])

    with (
        patch(
            "app.workers.sticker_imposer_pkg.bin_packing.solve_auto_fill_mixed",
            side_effect=AssertionError("Không được gọi MaxRects cho mixed_guillotine"),
        ),
        patch(
            "app.workers.nup_sticker.compute_sticker_layout_for_page",
            side_effect=AssertionError("Không được gọi NFP cho mixed_guillotine"),
        ),
    ):
        first = preview_layout(_request(source), PRO_LICENSE)
        second = preview_layout(_request(source), PRO_LICENSE)

    expected = _expected_plan(source)
    assert first["success"] is True
    assert first["strategyUsed"] == "mixed_guillotine"
    assert first["isMixedPreview"] is True
    assert first["absPlacement"] is True
    assert {cell["pageIdx"] for cell in first["cells"]} == {0, 1}
    assert first["planHash"] == second["planHash"] == expected["planHash"]
    assert first["planVersion"] == first["version"] == PLAN_VERSION
    assert first["sheetsNeeded"] == 1
    assert len(first["sheets"]) == first["templateCount"] == 1
    assert first["cutTree"] is not None
    assert first["cutSegments"]
    assert all(sheet["planHash"] == first["planHash"] for sheet in first["sheets"])


def test_preview_and_export_build_the_same_plan_hash(tmp_path, monkeypatch):
    source = str(tmp_path / "mixed-plan-parity.pdf")
    output = str(tmp_path / "mixed-plan-parity-out.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])
    real_builder = mixed_guillotine_module.build_mixed_guillotine_plan
    captured_hashes: list[str] = []
    captured_split_gaps: list[float | None] = []

    def capture_plan(products, settings):
        plan = real_builder(products, settings)
        captured_hashes.append(plan["planHash"])
        captured_split_gaps.append(settings.split_gap)
        return plan

    monkeypatch.setattr(
        mixed_guillotine_module,
        "build_mixed_guillotine_plan",
        capture_plan,
    )
    preview = preview_layout(_request(source, split_gap=16 * MM_TO_PT), PRO_LICENSE)
    nup_engine.run_nup_engine(
        source,
        output,
        {
            "isDieCutMode": False,
            "sheetWidth": SHEET_WIDTH / MM_TO_PT,
            "sheetHeight": SHEET_HEIGHT / MM_TO_PT,
            "layoutType": "mixed_guillotine",
            "mixedGuillotineStrategy": "auto_zone",
            "gridStrategy": "optimal_auto",
            "duplexFlow": "normal",
            "duplexFlipEdge": "long",
            "targetQuantity": 0,
            "targetQuantitiesByPage": {"0": 1, "1": 1},
            "gapX": 5.0 / MM_TO_PT,
            "gapY": 5.0 / MM_TO_PT,
            "splitGap": 16.0,
            "bleed": 0,
            "marginTop": MARGIN / MM_TO_PT,
            "marginBottom": MARGIN / MM_TO_PT,
            "marginLeft": MARGIN / MM_TO_PT,
            "marginRight": MARGIN / MM_TO_PT,
            "markType": "none",
            "pontType": "none",
            "exportUniqueSheets": True,
        },
        job_id="mixed-plan-parity",
    )

    assert captured_hashes == [preview["planHash"], preview["planHash"]]
    assert captured_split_gaps == pytest.approx([16 * MM_TO_PT, 16 * MM_TO_PT])
    assert preview["splitGap"] == pytest.approx(16 * MM_TO_PT)


def test_preview_does_not_expand_large_template_run_count(tmp_path):
    source = str(tmp_path / "mixed-many-runs.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])

    result = preview_layout(
        _request(
            source,
            target_quantities_by_page={"0": 10_000, "1": 10_000},
        ),
        PRO_LICENSE,
    )

    front_faces = [sheet for sheet in result["sheets"] if sheet["side"] == "front"]
    assert result["sheetsNeeded"] == sum(sheet["runCount"] for sheet in front_faces)
    assert result["sheetsNeeded"] > len(result["sheets"])
    assert len(result["sheets"]) == result["templateCount"]


@pytest.mark.parametrize("flip_edge", ["long", "short"])
def test_duplex_preview_materializes_each_back_face_once(tmp_path, flip_edge):
    source = str(tmp_path / f"mixed-duplex-{flip_edge}.pdf")
    _make_pdf(
        source,
        [(100.0, 80.0), (100.0, 80.0), (60.0, 40.0), (60.0, 40.0)],
    )
    result = preview_layout(
        _request(
            source,
            duplex_flow="double",
            duplex_flip_edge=flip_edge,
            target_quantities_by_page={"0": 1, "2": 1},
        ),
        PRO_LICENSE,
    )

    assert result["planHash"] == _expected_plan(
        source, duplex=True, flip_edge=flip_edge
    )["planHash"]
    assert result["sheetsNeeded"] == 1
    assert result["outputPagesNeeded"] == 2
    assert [sheet["side"] for sheet in result["sheets"]] == ["front", "back"]
    front = {cell["blockId"]: cell for cell in result["sheets"][0]["cells"]}
    back = {cell["blockId"]: cell for cell in result["sheets"][1]["cells"]}
    assert set(front) == set(back) == {0, 1}

    front_segments = result["sheets"][0]["cutSegments"]
    back_segments = result["sheets"][1]["cutSegments"]
    if flip_edge == "long":
        front_coordinates = sorted(
            line["coordinate"] for line in front_segments if line["axis"] == "x"
        )
        back_coordinates = sorted(
            line["coordinate"] for line in back_segments if line["axis"] == "x"
        )
        assert back_coordinates == pytest.approx(
            sorted(SHEET_WIDTH - coordinate for coordinate in front_coordinates)
        )
    else:
        front_coordinates = sorted(
            line["coordinate"] for line in front_segments if line["axis"] == "y"
        )
        back_coordinates = sorted(
            line["coordinate"] for line in back_segments if line["axis"] == "y"
        )
        assert back_coordinates == pytest.approx(
            sorted(SHEET_HEIGHT - coordinate for coordinate in front_coordinates)
        )

    for product_id, front_cell in front.items():
        back_cell = back[product_id]
        assert back_cell["pageIdx"] == front_cell["pageIdx"] + 1
        assert back_cell["rotation"] == (-front_cell["rotation"]) % 360
        if flip_edge == "long":
            assert back_cell["absX"] == pytest.approx(
                SHEET_WIDTH - front_cell["absX"] - front_cell["width"]
            )
            assert back_cell["absY"] == pytest.approx(front_cell["absY"])
        else:
            assert back_cell["absX"] == pytest.approx(front_cell["absX"])
            assert back_cell["absY"] == pytest.approx(
                SHEET_HEIGHT - front_cell["absY"] - front_cell["height"]
            )


def test_duplex_preview_rejects_odd_page_count_with_vietnamese_error(tmp_path):
    source = str(tmp_path / "mixed-duplex-odd.pdf")
    _make_pdf(source, [(100.0, 80.0)] * 3)

    with pytest.raises(HTTPException) as exc_info:
        preview_layout(
            _request(
                source,
                duplex_flow="double",
                target_quantities_by_page={"0": 1, "2": 1},
            ),
            PRO_LICENSE,
        )

    assert exc_info.value.status_code == 422
    assert "từng cặp trang trước/sau" in str(exc_info.value.detail)


def test_duplex_preview_rejects_pair_mismatch_over_half_point(tmp_path):
    source = str(tmp_path / "mixed-duplex-mismatch.pdf")
    _make_pdf(source, [(100.0, 80.0), (100.6, 80.0)])

    with pytest.raises(HTTPException) as exc_info:
        preview_layout(
            _request(
                source,
                duplex_flow="double",
                target_quantities_by_page={"0": 1},
            ),
            PRO_LICENSE,
        )

    assert exc_info.value.status_code == 422
    assert "Cặp trang 1–2" in str(exc_info.value.detail)


def test_existing_guillotine_mode_still_rejects_different_sizes(tmp_path):
    source = str(tmp_path / "legacy-mixed-sizes.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])

    with pytest.raises(HTTPException) as exc_info:
        preview_layout(_request(source, layout_type="sequential"), PRO_LICENSE)

    assert exc_info.value.status_code == 422
    assert "cùng kích thước" in str(exc_info.value.detail)
