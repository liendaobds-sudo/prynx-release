"""Giữ chất lượng khi cubic được chia dư hoặc đổi vị trí bắt đầu."""

from copy import deepcopy
import math

import numpy as np
import pytest

from app.workers.cutline_cubic_simplify import simplify_cubic_path_groups
from app.workers.cutline_exact_coalesce import coalesce_exact_subdivisions
from app.workers.cutline_geometry import _linear_cubic_segment
from app.workers.cutline_global_simplify import _shortest_path
from app.workers.cutline_polyline_reduction import split_cubic
from test_cutline_cubic_simplify import _circle, _split_ring, _metric, _sample, _dense_distance


@pytest.mark.parametrize("shift, expected", [(0, 4), (1, 5), (3, 5), (5, 5)])
def test_subdivision_recovery_keeps_seam_and_c2(shift, expected):
    source = _split_ring(_circle(), 3)
    source = source[shift:] + source[:shift]
    saved = deepcopy(source)
    result, bound = coalesce_exact_subdivisions(source)
    assert source == saved
    assert len(result) == expected and result[0][0] == source[0][0]
    assert result[-1][3] == source[0][0]
    assert 0 <= bound < 1e-8
    before, after = _metric(source), _metric(result)
    assert after.maximum_curvature_jump_per_mm <= before.maximum_curvature_jump_per_mm + 1e-6
    final, stats = simplify_cubic_path_groups([{"exterior": source}], tolerance_mm=.05)
    assert stats["changed"] and stats["after_segments"] <= expected
    assert stats["maximum_error_bound_mm"] < .05
    assert final[0]["exterior"][0][0] == source[0][0]


def test_exact_recovery_rejects_small_shape_change_and_true_corner():
    source = list(split_cubic(_circle()[0], .5))
    altered = list(source[1])
    altered[1] = (altered[1][0] + .00001, altered[1][1])
    source[1] = tuple(altered)
    result, _ = coalesce_exact_subdivisions(source)
    assert len(result) == 2
    corner = [_linear_cubic_segment((0., 0.), (1., 0.)),
              _linear_cubic_segment((1., 0.), (1., 1.))]
    assert coalesce_exact_subdivisions(corner)[0] == tuple(corner)


def test_shortest_path_has_no_source_segment_cap():
    calls = []
    def candidate(start, end):
        calls.append((start, end))
        return "whole" if (start, end) == (0, 128) else None
    choices, count = _shortest_path(128, candidate)
    assert count == 1 and choices[0] == (128, "whole")


def test_dense_round_polyline_can_use_spans_longer_than_twelve():
    angles = np.linspace(0., 2.*math.pi, 128, endpoint=False)
    points = [(30.*math.cos(a), 30.*math.sin(a)) for a in angles]
    points.append(points[0])
    source = [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:])]
    result, stats = simplify_cubic_path_groups([{"exterior": source}], tolerance_mm=.05,
                                               mm_to_units=1., preview_fast=True)
    assert stats["changed"] and stats["after_segments"] <= 5
    assert stats["maximum_error_bound_mm"] <= .05
    assert result[0]["exterior"][0][0] == source[0][0]
