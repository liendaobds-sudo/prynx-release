"""Unit test cho kiểu dữ liệu lõi CutModel (task 1.2). Requirements: 1.1, 1.3."""

import pytest

from app.workers.cut_export.cut_model import (
    CutPath,
    RegMark,
    CutModel,
    SendResult,
)


# ── CutPath ──────────────────────────────────────────────

def test_cutpath_normalizes_points_to_float_tuples():
    p = CutPath(points=[(0, 0), (10, 0), (10, 5)])
    assert p.points == [(0.0, 0.0), (10.0, 0.0), (10.0, 5.0)]
    assert all(isinstance(c, float) for pt in p.points for c in pt)


def test_cutpath_defaults():
    p = CutPath(points=[(0, 0), (1, 1)])
    assert p.closed is True
    assert p.tool_tag is None
    assert p.block_id == 0


def test_cutpath_empty_detection():
    assert CutPath(points=[(0, 0)]).is_empty is True
    assert CutPath(points=[(0, 0), (1, 1)]).is_empty is False


def test_cutpath_bounds():
    p = CutPath(points=[(1, 2), (5, 2), (5, 8), (1, 8)])
    assert p.bounds() == (1.0, 2.0, 5.0, 8.0)


def test_cutpath_rejects_malformed_point():
    with pytest.raises(ValueError):
        CutPath(points=[(0, 0), (1, 2, 3)])


# ── RegMark ──────────────────────────────────────────────

def test_regmark_basic():
    m = RegMark(x=5, y=10, kind="cross")
    assert (m.x, m.y) == (5.0, 10.0)
    assert m.kind == "cross"


def test_regmark_rejects_invalid_kind():
    with pytest.raises(ValueError):
        RegMark(x=0, y=0, kind="triangle")


# ── CutModel ─────────────────────────────────────────────

def test_cutmodel_empty_when_no_valid_path():
    assert CutModel().is_empty is True
    assert CutModel(paths=[CutPath(points=[(0, 0)])]).is_empty is True


def test_cutmodel_not_empty_with_valid_path():
    cm = CutModel(paths=[CutPath(points=[(0, 0), (1, 1)])])
    assert cm.is_empty is False


def test_cutmodel_frame_from_marks():
    cm = CutModel(
        marks=[
            RegMark(0, 0),
            RegMark(100, 0),
            RegMark(0, 200),
            RegMark(100, 200),
        ]
    )
    assert cm.compute_frame_from_marks() == (0.0, 0.0, 100.0, 200.0)


def test_cutmodel_frame_none_without_marks():
    assert CutModel().compute_frame_from_marks() is None


def test_cutmodel_source_names_default_empty():
    cm = CutModel(sheet_w_mm=320, sheet_h_mm=450)
    assert cm.source_names == {}
    assert (cm.sheet_w_mm, cm.sheet_h_mm) == (320.0, 450.0)


# ── SendResult ───────────────────────────────────────────

def test_sendresult_fields():
    r = SendResult(ok=True, channel="file", detail="/tmp/x.plt", bytes_sent=128)
    assert r.ok and r.channel == "file" and r.bytes_sent == 128
