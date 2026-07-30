"""Khóa hành vi Bình cắt xén cũ trước khi thêm mode nhiều kích thước."""

from __future__ import annotations

import pikepdf

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib
from tests.license_helpers import PRO_LICENSE


def _make_pdf(path: str, sizes: list[tuple[float, float]]) -> None:
    doc = pdf_lib.open()
    for width, height in sizes:
        page = doc.new_page(width=width, height=height)
        page.insert_text(pdf_lib.Point(10, 20), f"{width}x{height}")
    doc.save(path)
    doc.close()


def _settings(**overrides):
    settings = {
        "isDieCutMode": False,
        "sheetWidth": 400.0 / 2.83465,
        "sheetHeight": 400.0 / 2.83465,
        "layoutType": "sequential",
        "gridStrategy": "optimal_auto",
        "targetQuantity": 0,
        "targetQuantitiesByPage": {"0": 1, "1": 1},
        "gapX": 0,
        "gapY": 0,
        "marginTop": 0,
        "marginBottom": 0,
        "marginLeft": 0,
        "marginRight": 0,
        "markType": "none",
        "pontType": "none",
    }
    settings.update(overrides)
    return settings


def test_same_size_sequential_multi_design_output_remains_supported(tmp_path):
    """Mode cũ vẫn ghép đủ nhiều mẫu cùng kích thước trên một tờ."""
    source = str(tmp_path / "same-size-sequential.pdf")
    output = str(tmp_path / "same-size-sequential-out.pdf")
    _make_pdf(source, [(100.0, 100.0), (100.0, 100.0)])

    nup_engine.run_nup_engine(
        source,
        output,
        _settings(),
        job_id="same-size-sequential-characterization",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 1
        instructions = pikepdf.parse_content_stream(pdf.pages[0])
        assert sum(str(instruction.operator) == "Do" for instruction in instructions) == 2


def test_same_size_sequential_preview_keeps_every_physical_page(tmp_path):
    """Preview mode cũ không làm mất mẫu khi các trang cùng khổ."""
    source = str(tmp_path / "guillotine-same-sizes.pdf")
    _make_pdf(source, [(100.0, 100.0), (100.0, 100.0)])
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
        target_quantities_by_page={"0": 1, "1": 1},
    )

    result = preview_layout(req, PRO_LICENSE)

    assert result["success"] is True
    assert {cell["pageIdx"] for cell in result["cells"]} == {0, 1}
