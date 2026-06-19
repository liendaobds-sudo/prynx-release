"""Test emitter vector-file: DXF + SVG (task 3.4). Requirements: 3.1, 3.3, 3.5."""

import xml.etree.ElementTree as ET

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.emitters.dxf import DxfEmitter
from app.workers.cut_export.emitters.svg import SvgEmitter


def _square_model():
    return CutModel(
        paths=[CutPath(points=[(0, 0), (10, 0), (10, 10), (0, 10)], closed=True, tool_tag="shared")],
        marks=[RegMark(0, 0), RegMark(100, 0), RegMark(0, 200), RegMark(100, 200)],
        sheet_w_mm=100,
        sheet_h_mm=200,
    )


# ── DXF ──────────────────────────────────────────────────

def test_dxf_uses_lwpolyline_not_spline():
    out = DxfEmitter().emit(_square_model()).decode("ascii")
    assert "LWPOLYLINE" in out
    assert "SPLINE" not in out


def test_dxf_units_mm_and_eof():
    out = DxfEmitter().emit(_square_model()).decode("ascii")
    # $INSUNITS = 4 (mm)
    assert "$INSUNITS" in out
    lines = out.splitlines()
    idx = lines.index("$INSUNITS")
    assert lines[idx + 2] == "4"
    assert lines[-1] == "EOF"


def test_dxf_vertex_count_and_coords():
    out = DxfEmitter().emit(_square_model()).decode("ascii")
    lines = out.splitlines()
    # 90 = số đỉnh = 4
    i = lines.index("90")
    assert lines[i + 1] == "4"
    assert "10.0000" in out and "0.0000" in out


def test_dxf_closed_flag():
    out = DxfEmitter().emit(_square_model()).decode("ascii")
    lines = out.splitlines()
    i70 = lines.index("70", lines.index("LWPOLYLINE"))
    assert lines[i70 + 1] == "1"  # closed


def test_dxf_skips_empty_paths():
    cm = CutModel(paths=[CutPath(points=[(0, 0)])], sheet_w_mm=10, sheet_h_mm=10)
    out = DxfEmitter().emit(cm).decode("ascii")
    assert "LWPOLYLINE" not in out


# ── SVG ──────────────────────────────────────────────────

def test_svg_is_valid_xml_and_has_path():
    out = SvgEmitter().emit(_square_model()).decode("utf-8")
    root = ET.fromstring(out)
    assert root.tag.endswith("svg")
    paths = root.findall(".//{http://www.w3.org/2000/svg}path")
    assert len(paths) >= 1


def test_svg_y_flip():
    # Điểm (0,0) mm (gốc dưới-trái) → svg_y = sheet_h = 200.
    out = SvgEmitter().emit(_square_model()).decode("utf-8")
    assert "M 0.0000 200.0000" in out


def test_svg_groups_by_tool_tag():
    cm = CutModel(
        paths=[
            CutPath(points=[(0, 0), (1, 1)], tool_tag="left"),
            CutPath(points=[(2, 2), (3, 3)], tool_tag="right"),
        ],
        sheet_w_mm=50, sheet_h_mm=50,
    )
    out = SvgEmitter().emit(cm).decode("utf-8")
    assert 'id="cut-left"' in out and 'id="cut-right"' in out


def test_svg_dimensions_mm():
    out = SvgEmitter().emit(_square_model()).decode("utf-8")
    assert 'width="100.0000mm"' in out
    assert 'height="200.0000mm"' in out
