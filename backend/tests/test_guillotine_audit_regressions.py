from __future__ import annotations

import os

import pikepdf
import pytest

from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib


class _StopEngine(Exception):
    pass


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
        "layoutType": "repeat",
        "gridStrategy": "optimal_auto",
        "targetQuantity": 0,
        "targetQuantitiesByPage": {},
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


def test_mixed_size_multi_design_guillotine_is_rejected(tmp_path):
    source = str(tmp_path / "mixed.pdf")
    output = str(tmp_path / "out.pdf")
    _make_pdf(source, [(100.0, 100.0), (200.0, 200.0)])

    with pytest.raises(ValueError, match="cùng kích thước"):
        nup_engine.run_nup_engine(
            source,
            output,
            _settings(layoutType="sequential"),
            job_id="mixed-size",
        )


def test_repeat_sheet_mapping_uses_each_pages_own_capacity(monkeypatch, tmp_path):
    source = str(tmp_path / "repeat-mixed.pdf")
    output = str(tmp_path / "out.pdf")
    _make_pdf(source, [(100.0, 100.0), (200.0, 200.0)])
    captured = {}

    def capture(args):
        captured["mapping"] = list(args[36])
        raise _StopEngine()

    monkeypatch.setattr(os, "cpu_count", lambda: 2)
    monkeypatch.setattr(nup_engine, "process_chunk", capture)

    with pytest.raises(_StopEngine):
        nup_engine.run_nup_engine(
            source,
            output,
            _settings(
                sheetWidth=300.0 / 2.83465,
                sheetHeight=300.0 / 2.83465,
                targetQuantitiesByPage={"0": 10, "1": 1},
            ),
            job_id="repeat-capacity",
        )

    # 100pt page fits 3x3 => two sheets for qty 10; 200pt fits 1x1 => one sheet.
    assert captured["mapping"] == [0, 0, 1]




def test_repeat_mixed_sizes_render_with_matching_page_geometry(tmp_path):
    source = str(tmp_path / "repeat-mixed-render.pdf")
    output = str(tmp_path / "repeat-mixed-render-out.pdf")
    _make_pdf(source, [(100.0, 100.0), (200.0, 200.0)])

    nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            sheetWidth=300.0 / 2.83465,
            sheetHeight=300.0 / 2.83465,
            targetQuantitiesByPage={"0": 10, "1": 1},
        ),
        job_id="repeat-mixed-render",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 3
        placed_counts = []
        for page in pdf.pages:
            instructions = pikepdf.parse_content_stream(page)
            placed_counts.append(sum(str(instr.operator) == "Do" for instr in instructions))
    assert placed_counts == [9, 1, 1]
def test_manual_repeat_exports_exact_requested_grid(tmp_path):
    source = str(tmp_path / "manual.pdf")
    output = str(tmp_path / "manual-out.pdf")
    _make_pdf(source, [(100.0, 100.0)])

    nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            gridStrategy="manual",
            cols=2,
            rows=2,
            targetQuantity=4,
        ),
        job_id="manual-grid",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 1
        instructions = pikepdf.parse_content_stream(pdf.pages[0])
        assert sum(str(instr.operator) == "Do" for instr in instructions) == 4


def test_manual_grid_that_exceeds_sheet_is_rejected(tmp_path):
    source = str(tmp_path / "manual-overflow.pdf")
    output = str(tmp_path / "manual-overflow-out.pdf")
    _make_pdf(source, [(100.0, 100.0)])

    with pytest.raises(ValueError, match="Lưới thủ công"):
        nup_engine.run_nup_engine(
            source,
            output,
            _settings(
                sheetWidth=150.0 / 2.83465,
                sheetHeight=150.0 / 2.83465,
                gridStrategy="manual",
                cols=2,
                rows=2,
                targetQuantity=4,
            ),
            job_id="manual-overflow",
        )
