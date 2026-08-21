"""C2 — 1 Dao: resolve_one_dao_trim + force RECTANGLE policy in layout_compute."""
from __future__ import annotations

import inspect
from types import SimpleNamespace

import pikepdf
import pytest

from app.workers import imposition_rust_policy
from app.workers import pdf_wrapper as pdf_lib
from app.workers.nup_diecut import (
    MIN_DIE_STROKE_WIDTH_PT,
    resolve_default_page_die,
    resolve_die_stroke_width,
    resolve_one_dao_trim,
)
from app.workers.sticker_imposer_pkg.one_dao_cut import draw_one_dao_cuts
from app.workers.sticker_imposer_pkg import layout_compute as lc
from app.workers.sticker_imposer_pkg import orchestrator


class _Rect:
    def __init__(self, x0, y0, x1, y1):
        self.x0 = float(x0)
        self.y0 = float(y0)
        self.x1 = float(x1)
        self.y1 = float(y1)

    @property
    def width(self):
        return self.x1 - self.x0

    @property
    def height(self):
        return self.y1 - self.y0


class _Page:
    def __init__(self, width=200.0, height=100.0):
        self.rect = _Rect(0, 0, width, height)
        self.mediabox = self.rect
        self.cropbox = None
        self.trimbox = self.rect


def test_resolve_one_dao_trim_only_when_one_dao_page():
    page = SimpleNamespace(rect=SimpleNamespace(width=200.0, height=100.0))

    assert resolve_one_dao_trim(page, "multi", "page", 0) is None
    assert resolve_one_dao_trim(page, "one_dao", "die", 0) is None

    trim = resolve_one_dao_trim(page, "one_dao", "page", 0)
    assert trim is not None
    tw, th = trim
    assert abs(tw - 200.0) < 0.01
    assert abs(th - 100.0) < 0.01

    # offset +1mm expands both dimensions
    trim2 = resolve_one_dao_trim(page, "one_dao", "page", 1.0)
    assert trim2[0] > 200.0
    assert trim2[1] > 100.0


def test_layout_compute_source_forces_rectangle_for_one_dao():
    src = inspect.getsource(lc)
    assert "_is_one_dao" in src or "one_dao" in src
    assert "RECTANGLE" in src


def test_default_page_fallback_offset_changes_both_sides_and_keeps_center():
    page = _Page()

    base = resolve_default_page_die(page, 0, MM=1.0)["rect"]
    expanded = resolve_default_page_die(page, 1, MM=1.0)["rect"]
    contracted = resolve_default_page_die(page, -1, MM=1.0)["rect"]

    assert expanded.width == pytest.approx(base.width + 2)
    assert expanded.height == pytest.approx(base.height + 2)
    assert contracted.width == pytest.approx(base.width - 2)
    assert contracted.height == pytest.approx(base.height - 2)
    for rect in (expanded, contracted):
        assert (rect.x0 + rect.x1) / 2 == pytest.approx(100)
        assert (rect.y0 + rect.y1) / 2 == pytest.approx(50)


@pytest.mark.parametrize(
    ("raw_width", "expected"),
    [(None, 1.0), (0.0, 1.0), (0.5, 1.0), (1.0, 1.0), (1.5, 1.5), (float("nan"), 1.0)],
)
def test_die_stroke_width_has_one_point_minimum(raw_width, expected):
    assert resolve_die_stroke_width(raw_width) == pytest.approx(expected)


def test_one_dao_default_stroke_is_one_point_in_pdf_stream():
    doc = pdf_lib.open()
    try:
        page = doc.new_page(width=100.0, height=100.0)
        draw_one_dao_cuts(page, [{
            "type": "H",
            "start": 10.0,
            "end": 90.0,
            "fixed": 50.0,
        }])
        contents = page._page.get("/Contents")
        streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        operators = b"\n".join(stream.read_bytes() for stream in streams if stream is not None)
        assert f"{MIN_DIE_STROKE_WIDTH_PT} w".encode("ascii") in operators
    finally:
        doc.close()


def test_default_real_die_ignores_page_fallback_offset(monkeypatch):
    page = _Page()
    captured = {}

    monkeypatch.setattr(imposition_rust_policy, "require_rust", lambda _feature: None)
    monkeypatch.setattr(
        lc,
        "_find_largest_die_path",
        lambda _page: {"rect": _Rect(10, 20, 50, 45), "items": []},
    )

    def _unexpected_fallback(*_args, **_kwargs):
        raise AssertionError("Không được áp Co/Mở fallback lên CutContour thật")

    monkeypatch.setattr(lc, "resolve_default_page_die", _unexpected_fallback)

    def _solve(*args, **_kwargs):
        captured["trim"] = args[2:4]
        return {
            "items": [],
            "totalItems": 0,
            "widthUsed": 0,
            "heightUsed": 0,
            "strategyUsed": "grid",
        }

    monkeypatch.setattr(orchestrator, "solve_optimal_sticker_layout", _solve)

    result = lc.compute_sticker_layout_for_page(
        page,
        sheet_usable_w=500,
        sheet_usable_h=300,
        gap_x=0,
        gap_y=0,
        strategy="simple_auto",
        shape_type_override="RECTANGLE",
        shape_props_override={},
        cut_type="default",
        die_offset_mm=9,
    )

    assert captured["trim"] == pytest.approx((40, 25))
    assert result["trimW"] == pytest.approx(40)
    assert result["trimH"] == pytest.approx(25)
