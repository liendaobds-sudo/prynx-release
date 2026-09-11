"""Giảm lệnh bế không vượt sai số, mất góc hoặc phá topology sau writer."""

from __future__ import annotations

from io import BytesIO
import math
from pathlib import Path
import re

import pikepdf
import pytest
from shapely.geometry import LineString, MultiPolygon, Point, Polygon

from app.workers.cutline_geometry import _bezier_point, _linear_cubic_segment
from app.workers.cutline_machine_path import MachinePathSegment, analyze_machine_path
from app.workers.cutline_polyline_reduction import (
    _continuous_paths_simple,
    _curves_disjoint,
    certify_polyline_curve,
    chord_monotone,
    reduce_cut_polyline,
    reduction_path_stream,
    split_cubic,
)
from app.workers import sticker_engine as engine
from test_sticker_engine_e2e import _parse_cut_machine_paths


UNITS = 72.0 / 25.4
ROOT = Path(__file__).resolve().parents[2]
BINDER2 = ROOT / "test" / "Binder2.pdf"


def _stats(paths):
    return [analyze_machine_path(path, mm_to_units=UNITS, smooth_join_threshold_degrees=1,
                                 short_segment_threshold_mm=0.25) for path in paths]


def _ring_from_segments(segments):
    points = []
    for segment in segments:
        if segment.kind == "line":
            points.append(segment.p0)
            continue
        curve = segment.p0, segment.p1, segment.p2, segment.p3
        points.extend(_bezier_point(curve, index / 128.0) for index in range(128))
    points.append(segments[-1].p3)
    return points


def _line_ring(points):
    return [MachinePathSegment.line(a, b) for a, b in zip(points, points[1:] + points[:1])]


def test_certificate_exact_line_and_split():
    curve = _linear_cubic_segment((0.0, 0.0), (1.0, 0.0))
    source = [(0.0, 0.0), (0.2, 0.0), (1.0, 0.0)]
    assert certify_polyline_curve(source, curve, [0.0, 0.2, 1.0], 1e-12) <= 1e-12
    a, b = split_cubic(curve, 0.2)
    assert a[-1] == b[0]
    assert a[-1] == pytest.approx(source[1], abs=1e-15)


def test_certificate_rejects_bulge_hidden_between_samples():
    # Sai số t=0/.5/1 đều bằng 0, nhưng đường vượt 0,02 ở giữa các mẫu.
    curve = ((0.0, 0.0), (1 / 3, 0.09), (2 / 3, -0.09), (1.0, 0.0))
    assert _bezier_point(curve, 0.5)[1] == pytest.approx(0.0)
    assert certify_polyline_curve([(0.0, 0.0), (1.0, 0.0)], curve, [0.0, 1.0], 0.02) is None


def test_small_loop_passes_distance_but_fails_motion_gate():
    curve = ((0.0, 0.0), (0.01, 0.01), (-0.01, 0.01), (0.001, 0.0))
    assert certify_polyline_curve([curve[0], curve[-1]], curve, [0.0, 1.0], 0.02) is not None
    assert not chord_monotone(curve)


@pytest.mark.parametrize("parameters", [[0, 0.8, 0.7], [0, 0, 1], [0.01, 0.5, 1], [0, math.nan, 1]])
def test_certificate_rejects_invalid_parameter_mapping(parameters):
    assert certify_polyline_curve([(0, 0), (0.5, 0), (1, 0)],
                                  _linear_cubic_segment((0, 0), (1, 0)), parameters, 0.02) is None


def test_topology_gate_checks_closed_path_and_nonadjacent_crossing():
    assert not _continuous_paths_simple([_line_ring([(0, 0), (2, 2), (0, 2), (2, 0)])])
    assert not _continuous_paths_simple([[MachinePathSegment.line((0, 0), (1, 0))]])
    assert _continuous_paths_simple([_line_ring([(0, 0), (2, 0), (2, 2), (0, 2)])])
    # Cặp kề giao lần nữa dù đã chung endpoint; không được bỏ cặp này.
    a = _linear_cubic_segment((0.0, 0.0), (3.0, 0.0))
    b = ((3.0, 0.0), (3.0, 2.0), (-1.0, -2.0), (-1.0, 1.0))
    assert not _curves_disjoint(a, b, True)


def test_two_rings_cannot_cross_or_touch():
    a = _line_ring([(0, 0), (4, 0), (4, 4), (0, 4)])
    b = _line_ring([(3, 1), (5, 1), (5, 3), (3, 3)])
    assert not _continuous_paths_simple([a, b])


@pytest.mark.parametrize("scale", [1.0, UNITS, 10.0])
def test_circle_reduces_with_independent_dense_distance(scale):
    source = Point(20 * scale, 20 * scale).buffer(10 * scale, quad_segs=90)
    original = list(source.exterior.coords)
    result = reduce_cut_polyline(source, mm_to_units=scale)
    assert result is not None
    assert result.reduced_segments < result.original_segments
    assert result.maximum_error_mm <= 0.02
    curve = LineString(_ring_from_segments(result.paths[0]))
    reference = LineString(original).segmentize(0.002 * scale)
    assert curve.hausdorff_distance(reference) / scale < 0.02
    assert Polygon(curve).is_valid
    assert list(source.exterior.coords) == original


def test_keep_real_corners_hole_and_small_neighbour():
    circle = Point(20 * UNITS, 20 * UNITS).buffer(8 * UNITS, quad_segs=64)
    outer = circle.union(Polygon([(20 * UNITS, 15 * UNITS), (34 * UNITS, 20 * UNITS), (20 * UNITS, 25 * UNITS)]))
    hole = Point(20 * UNITS, 20 * UNITS).buffer(2 * UNITS, quad_segs=32)
    first = outer.difference(hole)
    second = Point(37 * UNITS, 20 * UNITS).buffer(0.3 * UNITS, quad_segs=12)
    geometry = MultiPolygon([first, second])
    result = reduce_cut_polyline(geometry, mm_to_units=UNITS)
    assert result is not None
    assert len(result.paths) == 3
    candidate = MultiPolygon([
        Polygon(_ring_from_segments(result.paths[0]), [_ring_from_segments(result.paths[1])]),
        Polygon(_ring_from_segments(result.paths[2])),
    ])
    assert candidate.is_valid
    assert len(candidate.geoms[0].interiors) == 1
    assert candidate.geoms[1].area > 0
    assert (34 * UNITS, 20 * UNITS) in [segment.p0 for segment in result.paths[0]]


def test_no_reduction_for_zero_tolerance_or_invalid_geometry():
    source = Point(0, 0).buffer(10, quad_segs=32)
    assert reduce_cut_polyline(source, mm_to_units=1, tolerance_mm=0) is None
    assert reduce_cut_polyline(Polygon([(0, 0), (2, 2), (0, 2), (2, 0)]), mm_to_units=1) is None
    for bad in (math.nan, math.inf, -1):
        with pytest.raises(ValueError):
            reduce_cut_polyline(source, mm_to_units=1, tolerance_mm=bad)


def test_writer_quantized_topology_and_bound():
    source = Point(20 * UNITS, 20 * UNITS).buffer(10 * UNITS, quad_segs=90)
    height = 123.45678
    result = reduce_cut_polyline(source, mm_to_units=UNITS, page_height=height)
    assert result is not None
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(150, height))
        commands = ["/CutContour CS", *reduction_path_stream(result.paths[0], height), "S"]
        page.Contents = pdf.make_stream("\n".join(commands).encode("ascii"))
        payload = BytesIO()
        pdf.save(payload)
    with pikepdf.Pdf.open(BytesIO(payload.getvalue())) as pdf:
        paths = _parse_cut_machine_paths(pdf.pages[0])
    points = [(x, height - y) for x, y in _ring_from_segments(paths[0])]
    assert Polygon(points).is_valid
    assert LineString(points).hausdorff_distance(source.boundary.segmentize(0.002 * UNITS)) / UNITS < 0.02


def test_engine_does_not_reduce_nested_form_cutcontour(tmp_path, monkeypatch):
    from test_sticker_classic_binder2 import _synthetic_pdf

    source = _synthetic_pdf(tmp_path / "alpha.pdf")
    nested = tmp_path / "nested.pdf"
    with pikepdf.Pdf.open(source) as pdf:
        for page in pdf.pages:
            form = pdf.make_stream(page.Contents.read_bytes())
            form.Type = pikepdf.Name.XObject
            form.Subtype = pikepdf.Name.Form
            form.BBox = pikepdf.Array(page.MediaBox)
            form.Resources = pikepdf.Dictionary(page.Resources)
            form.Resources.ColorSpace = pikepdf.Dictionary(
                Cut=pikepdf.Array([
                    pikepdf.Name.Separation, pikepdf.Name.CutContour, pikepdf.Name.DeviceCMYK,
                    pikepdf.Dictionary(FunctionType=2, Domain=pikepdf.Array([0, 1]),
                        C0=pikepdf.Array([0, 0, 0, 0]), C1=pikepdf.Array([0, 1, 0, 0]), N=1),
                ])
            )
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm=pdf.make_indirect(form)))
            page.Contents = pdf.make_stream(b"q /Fm Do Q")
        pdf.save(nested)

    def forbidden(*args, **kwargs):
        raise AssertionError("B2 không được thay PDF Form có CutContour lồng")

    monkeypatch.setattr("app.workers.cutline_polyline_reduction.reduce_cut_polyline", forbidden)
    monkeypatch.setattr(engine, "_fit_preserved_contour_paths", lambda *a, **kw: None)
    success, meta = engine.StickerEngine(dpi=300).process_pdf(
        input_path=str(nested), output_path=str(tmp_path / "nested_result.pdf"),
        cut_mode="original", corner_style="preserve", shape_mode="contour",
        alpha_corner_policy="adaptive", remove_white_bg=True,
    )
    assert success, meta


@pytest.mark.skipif(not BINDER2.is_file(), reason="Corpus khách không có trên máy này")
def test_binder2_tree_reduction_uses_live_writer_and_preserves_artwork(tmp_path, monkeypatch):
    import app.workers.cutline_polyline_reduction as reducer

    original_reduce = reducer.reduce_cut_polyline
    outputs = []
    for enabled in (False, True):
        monkeypatch.setattr(reducer, "reduce_cut_polyline", original_reduce if enabled else lambda *a, **kw: None)
        result = engine.StickerEngine(dpi=300).process_pdf(
            input_path=str(BINDER2), output_path="", _page_subset=[3],
            cut_mode="original", offset_mm=0, bleed_mm=0, corner_style="preserve",
            shape_mode="auto_safe", alpha_corner_policy="adaptive", remove_white_bg=True,
            cutline_denoise=30,
        )
        outputs.append(result)
    before, after = [], []
    prefixes = []
    source_forms = []
    for index, result in enumerate(outputs):
        with pikepdf.Pdf.open(BytesIO(result[0])) as pdf:
            paths = _parse_cut_machine_paths(pdf.pages[0])
            (before if index == 0 else after).extend(paths)
            content = pdf.pages[0].Contents
            streams = list(content) if isinstance(content, pikepdf.Array) else [content]
            prefix = b"\n".join(s.read_bytes() for s in streams).split(b"/CutContour CS", 1)[0]
            # Pikepdf đặt tên Form khác nhau mỗi lần copy; so lệnh + dữ liệu
            # artwork, không coi tên tài nguyên ngẫu nhiên là đổi nội dung.
            prefixes.append(re.sub(rb"/[^\s]+\s+Do", b"/SOURCE Do", prefix))
            source_forms.append(sorted(
                obj.read_bytes() for obj in pdf.pages[0].Resources.XObject.values()
                if str(obj.get("/Subtype")) == "/Form"
            ))
    assert len(before) == len(after) == 15
    assert sum(len(path) for path in after) < sum(len(path) for path in before)
    assert sum(m.short_segment_count for m in _stats(after)) < sum(m.short_segment_count for m in _stats(before))
    assert prefixes[0] == prefixes[1]
    assert source_forms[0] == source_forms[1]
    reduction = outputs[1][1][0]["cutline_reduction"]
    assert reduction["maximum_error_bound_mm"] <= 0.02
    for original, candidate in zip(before, after):
        a = LineString(_ring_from_segments(original))
        b = LineString(_ring_from_segments(candidate))
        # Bao phủ hai chiều trên polyline lấy mẫu; certificate liên tục của
        # cubic được kiểm riêng ở trên. Tránh GEOS Hausdorff O(N²) với >30k mẫu.
        assert a.buffer(0.02 * UNITS, quad_segs=32).covers(b)
        assert b.buffer(0.02 * UNITS, quad_segs=32).covers(a)
        assert Polygon(b).is_valid
