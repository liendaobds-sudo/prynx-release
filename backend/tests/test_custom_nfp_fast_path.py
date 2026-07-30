"""Hồi quy hiệu năng cho khuôn CUSTOM trong bộ tính bố cục tem."""

from types import SimpleNamespace

import pytest

from app.workers import imposition_rust_policy
from app.workers.sticker_imposer_pkg import layout_compute, orchestrator


class _FakePage:
    def __init__(self) -> None:
        self.rect = SimpleNamespace(width=120.0, height=80.0)
        self.trimbox = SimpleNamespace(width=120.0, height=80.0)

    def extract_vector_paths(self):
        return []


@pytest.fixture
def layout_spies(monkeypatch):
    calls = {"nfp": 0, "polygon": 0}
    polygon = object()
    captured = {}

    monkeypatch.setattr(imposition_rust_policy, "require_rust", lambda _feature: None)
    monkeypatch.setattr(layout_compute, "resolve_one_dao_trim", lambda *_args: None)
    monkeypatch.setattr(
        layout_compute,
        "_find_largest_die_path",
        lambda _page: {
            "rect": SimpleNamespace(width=40.0, height=25.0),
            "items": [],
        },
    )

    def _nfp(*_args):
        calls["nfp"] += 1
        params = {"dx_outer": 20.0}
        return params, params, params, params, params, params, "CUSTOM", {}, polygon

    def _polygon(_page):
        calls["polygon"] += 1
        return polygon

    def _solve(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return {
            "items": [{"x": 0.0, "y": 0.0, "width": 40.0, "height": 25.0}],
            "totalItems": 1,
            "widthUsed": 40.0,
            "heightUsed": 25.0,
            "strategyUsed": "grid",
        }

    monkeypatch.setattr(layout_compute, "get_optimal_head_to_tail_overlap", _nfp)
    monkeypatch.setattr(layout_compute, "extract_page_die_cut_polygon", _polygon)
    monkeypatch.setattr(orchestrator, "solve_optimal_sticker_layout", _solve)
    return calls, captured, polygon


def _compute(strategy: str, shape_type_override="CUSTOM"):
    return layout_compute.compute_sticker_layout_for_page(
        page=_FakePage(),
        sheet_usable_w=500.0,
        sheet_usable_h=350.0,
        gap_x=4.0,
        gap_y=4.0,
        strategy=strategy,
        shape_type_override=shape_type_override,
        shape_props_override={"source": "test"},
    )


def test_explicit_custom_optimal_auto_skips_nfp_but_keeps_real_polygon(layout_spies):
    calls, captured, polygon = layout_spies

    result = _compute("optimal_auto")

    assert calls == {"nfp": 0, "polygon": 1}
    assert captured["args"][7:13] == (None, None, None, None, None, None)
    assert captured["kwargs"]["base_poly"] is polygon
    assert result["shapeType"] == "CUSTOM"
    assert result["totalItems"] == 1


def test_explicit_custom_head_to_tail_still_computes_nfp(layout_spies):
    calls, captured, polygon = layout_spies

    _compute("head_to_tail")

    assert calls == {"nfp": 1, "polygon": 0}
    assert captured["args"][7] == {"dx_outer": 20.0}
    assert captured["kwargs"]["base_poly"] is polygon


def test_auto_detected_custom_still_computes_nfp_for_shape_refinement(layout_spies):
    calls, _captured, _polygon = layout_spies

    _compute("optimal_auto", shape_type_override=None)

    assert calls["nfp"] == 1
