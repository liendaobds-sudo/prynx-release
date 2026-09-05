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

@pytest.mark.parametrize(
    "quantities",
    [
        {"0": 10},
        {"0": 10, "1": 1},
    ],
)
def test_repeat_duplex_uses_front_quantity_for_both_faces(
    monkeypatch, tmp_path, quantities
):
    """Số lượng của sản phẩm hai mặt nằm ở trang chẵn và áp dụng cho cả cặp."""
    source = str(tmp_path / "repeat-duplex.pdf")
    output = str(tmp_path / "repeat-duplex-out.pdf")
    _make_pdf(source, [(100.0, 100.0), (100.0, 100.0)])
    monkeypatch.setenv("PRYNX_NUP_WORKERS", "1")

    nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            sheetWidth=300.0 / 2.83465,
            sheetHeight=300.0 / 2.83465,
            duplexFlow="double",
            targetQuantitiesByPage=quantities,
        ),
        job_id="repeat-duplex-quantity",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 4
        placed_counts = []
        for page in pdf.pages:
            instructions = pikepdf.parse_content_stream(page)
            placed_counts.append(
                sum(str(instruction.operator) == "Do" for instruction in instructions)
            )
    assert placed_counts == [9, 9, 1, 1]


def test_repeat_duplex_rejects_mismatched_face_sizes(tmp_path):
    source = str(tmp_path / "repeat-duplex-mixed.pdf")
    output = str(tmp_path / "repeat-duplex-mixed-out.pdf")
    _make_pdf(source, [(100.0, 100.0), (200.0, 200.0)])

    with pytest.raises(ValueError, match="mặt trước/sau.*cùng kích thước"):
        nup_engine.run_nup_engine(
            source,
            output,
            _settings(
                sheetWidth=300.0 / 2.83465,
                sheetHeight=300.0 / 2.83465,
                duplexFlow="double",
                targetQuantitiesByPage={"0": 10},
            ),
            job_id="repeat-duplex-mixed-size",
        )


def test_cluster_duplex_report_counts_physical_sheets(monkeypatch, tmp_path):
    """Hai trang PDF trước/sau chỉ là một tờ giấy vật lý trong report."""
    from app.workers import cluster_tile_engine, nup_report

    source = str(tmp_path / "cluster-duplex.pdf")
    output = str(tmp_path / "cluster-duplex-out.pdf")
    _make_pdf(source, [(100.0, 100.0), (100.0, 100.0)])
    monkeypatch.setenv("PRYNX_NUP_WORKERS", "1")

    placement = {
        "cluster_idx": 0,
        "cell": {
            "x": 0.0,
            "y": 0.0,
            "width": 100.0,
            "height": 100.0,
            "isRotated": False,
        },
        "src_page_idx": 0,
        "abs_x": 0.0,
        "abs_y": 0.0,
        "width": 100.0,
        "height": 100.0,
    }
    monkeypatch.setattr(
        cluster_tile_engine,
        "compute_cluster_sheets",
        lambda **_kwargs: [([placement], {"v": set(), "h": set()})],
    )
    captured = {}

    def capture_reports(_input_path, _output_path, reports, **_kwargs):
        captured.update(reports)

    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", capture_reports)

    message = nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            layoutType="sequential",
            groupingStrategy="cluster_tile",
            clusterCombineMode="replicate_mixed",
            duplexFlow="double",
            targetQuantitiesByPage={"0": 1},
            reportDisplay={"enabled": True},
        ),
        job_id="cluster-duplex-report",
    )

    assert set(captured) == {0}
    report = captured[0]
    assert "SL/tờ: 1" in report
    assert "SL thực: 1" in report
    assert "Số tờ: 1" in report
    assert "Số tờ: 2" not in report
    assert "in 1 tờ" in message
    assert "Tổng số tờ cần in: 1" in message

@pytest.mark.parametrize(
    ("total_sheets", "available_workers", "expected"),
    [
        (2, 15, (2, 1)),
        (13, 15, (5, 1)),
        (16, 15, (2, 15)),
        (50, 15, (4, 15)),
        (500, 15, (5, 15)),
        (10, 1, (5, 1)),
    ],
)
def test_small_nup_jobs_run_inline_without_limiting_large_jobs(
    total_sheets, available_workers, expected
):
    assert nup_engine._plan_nup_chunking(total_sheets, available_workers) == expected


@pytest.mark.parametrize(
    ("split_gap_mm", "expected_capacity"),
    [(0.0, 17), (2.0, 16)],
)
def test_sr_330x480_log_capacity_matches_rendered_pdf(
    monkeypatch, tmp_path, split_gap_mm, expected_capacity
):
    """Hồi quy ảnh audit: preview/export phải cùng 17 hoặc cùng 16 theo khe phụ."""
    from app.config import settings as app_settings
    from app.utils import preview_perf_log as perf_log

    source = str(tmp_path / f"sr-{split_gap_mm}.pdf")
    output = str(tmp_path / f"sr-{split_gap_mm}-out.pdf")
    # MediaBox gồm bleed 2 mm mỗi cạnh; thành phẩm 149,1 × 53,3 mm.
    mm = 2.83465
    _make_pdf(source, [((149.1 + 4.0) * mm, (53.3 + 4.0) * mm)])

    log_path = tmp_path / "preview_perf.log"
    # SEC (audit 2026-09-05 §LOG.01): diagnostic chỉ được bật trong
    # runtime dev; test phải khai rõ authority này thay vì chỉ đặt env.
    monkeypatch.setattr(app_settings, "DEV_MODE", True)
    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setattr(perf_log, "log_paths", lambda: [log_path])
    perf_log._enabled = None
    monkeypatch.setenv("PRYNX_NUP_WORKERS", "1")

    settings = _settings(
        sheetWidth=330.0,
        sheetHeight=480.0,
        bleed=2.0,
        gapX=2.0,
        gapY=2.0,
        marginLeft=8.0,
        marginRight=8.0,
        splitGap=split_gap_mm,
        _diagnosticTraceId=f"sr-test-{int(split_gap_mm)}",
    )
    from app.workers.nup_layout_solver import solve_optimal_layout
    usable_w_pt = (330.0 - 8.0 - 8.0) * mm
    usable_h_pt = 480.0 * mm
    preview_layout = solve_optimal_layout(
        usable_w_pt,
        usable_h_pt,
        149.1 * mm,
        53.3 * mm,
        2.0 * mm,
        2.0 * mm,
        "optimal_auto",
        split_gap_mm * mm,
    )
    perf_log.log(
        "PREVIEW", "solver.result",
        trace_id=f"sr-test-{int(split_gap_mm)}",
        request_id=f"sr-test-{int(split_gap_mm)}-p1",
        split_gap_mm=split_gap_mm,
        capacity=preview_layout["totalItems"],
    )
    nup_engine.run_nup_engine(
        source,
        output,
        settings,
        job_id=f"sr-job-{int(split_gap_mm)}",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 1
        instructions = pikepdf.parse_content_stream(pdf.pages[0])
        resource_names = {
            str(name) for name in (pdf.pages[0].get("/Resources", {}).get("/XObject", {}) or {})
        }
        rendered_items = sum(
            str(instruction.operator) == "Do"
            and bool(instruction.operands)
            and str(instruction.operands[0]) in resource_names
            for instruction in instructions
        )
    assert rendered_items == expected_capacity
    assert preview_layout["totalItems"] == expected_capacity

    log_text = log_path.read_text(encoding="utf-8")
    assert f"trace_id=sr-test-{int(split_gap_mm)}" in log_text
    assert f"job_id=sr-job-{int(split_gap_mm)}" in log_text
    assert f"capacity={expected_capacity}" in log_text
    assert f"placements={expected_capacity}" in log_text
    assert "[PREVIEW] solver.result" in log_text
    assert "[EXPORT] solver.result" in log_text
    assert "[EXPORT] worker.render" in log_text
