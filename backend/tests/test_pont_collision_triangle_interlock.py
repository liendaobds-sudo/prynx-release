"""Hồi quy né dấu boong cho tem tam giác lồng dọc.

Ca này mô phỏng đúng trang tam giác bo góc trong ``cac loai hinh - Copy.pdf``:
solver tạo 96 ô, chỉ 2 ô góc chạm vùng cấm. Bộ dồn theo cột không được coi
chiều cao bbox là bước lồng rồi xóa oan 14 tem.
"""

import io
from pathlib import Path

import pytest
from reportlab.pdfgen import canvas
from shapely.geometry import Polygon

from app.workers import nup_engine, nup_report
from app.workers.imposition_finalize import finalize_placements
from app.workers.pont_collision import (
    _has_any_sticker_overlap,
    _resolve_by_columns,
    _resolve_one_orientation,
    calculate_forbidden_zones,
    detect_collisions,
    smart_resolve_collisions,
)
from app.workers.sticker_imposer_pkg.shape_layouts import (
    _py_solve_advanced_triangle_layout,
)


MM = 2.83465
SHEET_W = 320 * MM
SHEET_H = 450 * MM
MARGIN = 5 * MM
USABLE_W = 310 * MM
USABLE_H = 440 * MM
ITEM_W = 141.794
ITEM_H = 120.139
GAP = 1.5 * MM
SHAPE_PROPS = {
    "gapMultiplierH": 2.332,
    "deltaW": 7.972,
    "triangleApex": "left",
}
PONT = {
    "shape": "circle",
    "size": 5.0,
    "marginTop": 7.0,
    "marginBottom": 7.0,
    "marginLeft": 7.0,
    "marginRight": 7.0,
}
PONT_MARGINS = {
    "top": 7 * MM,
    "bottom": 7 * MM,
    "left": 7 * MM,
    "right": 7 * MM,
}


def _build_case():
    layout = _py_solve_advanced_triangle_layout(
        USABLE_W,
        USABLE_H,
        ITEM_W,
        ITEM_H,
        GAP,
        GAP,
        SHAPE_PROPS,
        False,
    )
    placements = finalize_placements(
        layout["items"],
        USABLE_W,
        USABLE_H,
        MARGIN,
        MARGIN,
        MARGIN,
        11,
    )
    # Tam giác hướng trái, cùng bbox với khuôn bo góc thật. Đường cong bo góc
    # không thay đổi kết luận va chạm ở bốn dấu boong.
    base_poly = Polygon(
        [(0.0, ITEM_H / 2.0), (ITEM_W, 0.0), (ITEM_W, ITEM_H)]
    )
    zones = calculate_forbidden_zones(PONT, PONT_MARGINS, SHEET_W, SHEET_H)
    return placements, base_poly, zones


def test_triangle_interlock_chooses_safe_layout_with_most_stickers():
    placements, base_poly, zones = _build_case()
    base_rect = base_poly.bounds

    assert len(placements) == 96
    assert detect_collisions(
        placements, zones, base_poly, base_rect, SHEET_H
    ) == [0, 95]

    # Chứng minh đúng hồi quy 1f69ae2: dồn cột dùng bbox-height chỉ giữ 82,
    # trong khi dồn hàng giữ an toàn 94 tem.
    by_columns = _resolve_by_columns(
        placements,
        zones,
        base_poly,
        base_rect,
        SHEET_W,
        SHEET_H,
        PONT_MARGINS,
    )
    by_rows = _resolve_one_orientation(
        placements,
        zones,
        base_poly,
        base_rect,
        SHEET_W,
        SHEET_H,
        PONT_MARGINS,
    )
    assert by_columns is not None and len(by_columns) == 82
    assert len(by_rows) == 94

    resolved = smart_resolve_collisions(
        placements,
        zones,
        base_poly,
        base_rect,
        SHEET_W,
        SHEET_H,
        PONT_MARGINS,
    )

    assert len(resolved) == 94
    assert detect_collisions(
        resolved, zones, base_poly, base_rect, SHEET_H
    ) == []
    assert not _has_any_sticker_overlap(resolved, base_poly)


class _StopBeforeRender(Exception):
    pass


def _make_triangle_pdf(path):
    """PDF một trang có đường bế tam giác thật để chạy bộ trích contour."""
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=(ITEM_W, ITEM_H))
    die = pdf.beginPath()
    die.moveTo(0.0, ITEM_H / 2.0)
    die.lineTo(ITEM_W, 0.0)
    die.lineTo(ITEM_W, ITEM_H)
    die.close()
    pdf.drawPath(die, stroke=1, fill=0)
    pdf.save()
    Path(path).write_bytes(buf.getvalue())


def test_repeat_report_uses_capacity_after_pont_resolution(tmp_path, monkeypatch):
    """Nhánh repeat phải chốt 94 trước khi tính report và số tờ cho SL=95."""
    source = str(tmp_path / "triangle.pdf")
    output = str(tmp_path / "unused.pdf")
    _make_triangle_pdf(source)

    def _triangle_layout(*_args, **_kwargs):
        return _py_solve_advanced_triangle_layout(
            USABLE_W,
            USABLE_H,
            ITEM_W,
            ITEM_H,
            GAP,
            GAP,
            SHAPE_PROPS,
            False,
        )

    monkeypatch.setattr(
        nup_engine,
        "compute_sticker_layout_for_page",
        _triangle_layout,
    )

    # Hai tờ nằm chung một chunk, không tạo process con trong test.
    from app.core import system_memory

    monkeypatch.setattr(
        system_memory,
        "plan_worker_count",
        lambda **_kwargs: (1, "test"),
    )

    captured = {}
    original_build_report = nup_report.build_report_string

    def _capture_report(config, data):
        text = original_build_report(config, data)
        captured["report_raw"] = dict(data["raw"])
        captured["report_text"] = text
        return text

    monkeypatch.setattr(nup_report, "build_report_string", _capture_report)

    def _capture_chunk(args):
        captured["precalc"] = args[37]
        captured["total_sheets"] = args[44]
        raise _StopBeforeRender()

    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    settings = {
        "isDieCutMode": True,
        "layoutType": "repeat",
        "sheetWidth": 320,
        "sheetHeight": 450,
        "marginTop": 5,
        "marginBottom": 5,
        "marginLeft": 5,
        "marginRight": 5,
        "gapX": 1.5,
        "gapY": 1.5,
        "bleed": 0,
        "targetQuantity": 95,
        "targetQuantitiesByPage": {"0": 95},
        "exportUniqueSheets": False,
        "detectedShapesByPage": {"0": "TRIANGLE"},
        "detectedShapeParamsByPage": {"0": dict(SHAPE_PROPS)},
        "gridStrategy": "optimal_auto",
        "groupingStrategy": "none",
        "pontType": "5mm",
        "pontConfig": dict(PONT),
        "reportDisplay": {
            "enabled": True,
            "fieldOrder": ["labelsPerSheet", "sheetCount"],
            "showLabelsPerSheet": True,
            "showSheetCount": True,
        },
    }

    with pytest.raises(_StopBeforeRender):
        nup_engine.run_nup_engine(
            source, output, settings, job_id="triangle-report"
        )

    assert captured["report_raw"] == {
        "items_per_sheet": 94,
        "sheet_count": 2,
        "actual_qty": 188,
        "requested_qty": 95,
    }
    assert "SL/tờ: 94" in captured["report_text"]
    assert "Số tờ: 2" in captured["report_text"]
    assert captured["total_sheets"] == 2
    assert set(captured["precalc"]) == {0, 1}
    assert all(len(sheet) == 94 for sheet in captured["precalc"].values())
    assert all(
        placement.get("_pont_collision_resolved") is True
        for sheet in captured["precalc"].values()
        for placement in sheet
    )
