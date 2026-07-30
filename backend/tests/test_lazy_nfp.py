"""Hồi quy lazy NFP cho solver bình tem hình học."""

from copy import deepcopy
from types import SimpleNamespace

from shapely.geometry import box

from app.workers import imposition_rust_policy
from app.workers.sticker_imposer_pkg import cluster_layouts, layout_compute, orchestrator


def _layout(width=100.0, height=100.0, strategy="grid"):
    return {
        "items": [{"x": 0.0, "y": 0.0, "width": width, "height": height}],
        "totalItems": 1,
        "widthUsed": width,
        "heightUsed": height,
        "strategyUsed": strategy,
    }


def _nfp_values(overlap_poly=None):
    params = {"dx": 0.0, "dy": 0.0, "dx_outer": 100.0, "dy_outer": 100.0}
    return params, params, None, None, None, None, "HAMMER", {}, overlap_poly


def test_lazy_nfp_context_loads_only_once():
    calls = []
    context = orchestrator.LazyNfpParams(lambda: calls.append("load") or _nfp_values())

    assert context.peek() is None
    assert context.get() == _nfp_values()
    assert context.get() == _nfp_values()
    assert calls == ["load"]


def test_circle_without_fill_does_not_load_nfp():
    calls = []
    context = orchestrator.LazyNfpParams(lambda: calls.append("load") or _nfp_values())

    result = orchestrator._solve_optimal_sticker_layout_impl(
        100.0,
        100.0,
        100.0,
        100.0,
        0.0,
        0.0,
        strategy="optimal_auto",
        shape_type="CIRCLE_ELLIPSE",
        shape_props={"width": 100.0, "height": 100.0},
        nfp_context=context,
    )

    assert result["totalItems"] == 1
    assert calls == []
    assert context.peek() is None


def test_hammer_main_candidates_load_nfp_once(monkeypatch):
    calls = []
    context = orchestrator.LazyNfpParams(lambda: calls.append("load") or _nfp_values())

    monkeypatch.setattr(
        orchestrator,
        "solve_illustrator_hammer_layout",
        lambda *_args, **_kwargs: deepcopy(_layout(strategy="hammer_illustrator")),
    )
    monkeypatch.setattr(
        orchestrator,
        "solve_illustrator_dumbbell_layout",
        lambda *_args, **_kwargs: deepcopy(_layout(strategy="dumbbell_illustrator")),
    )
    monkeypatch.setattr(
        orchestrator,
        "solve_grid_layout",
        lambda *_args, **_kwargs: deepcopy(_layout()),
    )
    monkeypatch.setattr(
        orchestrator,
        "solve_cluster_grid_layout",
        lambda *_args, **_kwargs: deepcopy(_layout(strategy="head_to_tail")),
    )

    result = orchestrator._solve_optimal_sticker_layout_impl(
        100.0,
        100.0,
        100.0,
        100.0,
        0.0,
        0.0,
        strategy="optimal_auto",
        shape_type="HAMMER",
        shape_props={},
        nfp_context=context,
    )

    assert result["totalItems"] == 1
    assert calls == ["load"]


def test_fill_loads_nfp_once_only_for_supported_shape():
    supported_calls = []
    excluded_calls = []

    cluster_layouts._best_fill_layout(
        20.0,
        20.0,
        100.0,
        100.0,
        2.0,
        2.0,
        shape_type="CIRCLE_ELLIPSE",
        shape_props={"width": 20.0, "height": 20.0},
        nfp_provider=lambda: supported_calls.append("load") or (None,) * 6,
    )
    cluster_layouts._best_fill_layout(
        20.0,
        20.0,
        100.0,
        100.0,
        2.0,
        2.0,
        shape_type="TRAPEZOID",
        shape_props={"leftOH": 2.0},
        nfp_provider=lambda: excluded_calls.append("load") or (None,) * 6,
    )

    assert supported_calls == ["load"]
    assert excluded_calls == []


class _FakePage:
    def __init__(self):
        self.rect = SimpleNamespace(width=40.0, height=25.0)
        self.trimbox = SimpleNamespace(width=40.0, height=25.0)

    def extract_vector_paths(self):
        return []


def test_explicit_circle_defers_nfp_through_layout_compute(monkeypatch):
    calls = []
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
    monkeypatch.setattr(
        layout_compute,
        "extract_page_die_cut_polygon",
        lambda _page: box(0.0, 0.0, 40.0, 25.0),
    )
    monkeypatch.setattr(
        layout_compute,
        "get_optimal_head_to_tail_overlap",
        lambda *_args: calls.append("load") or _nfp_values(box(0.0, 0.0, 40.0, 25.0)),
    )

    result = layout_compute.compute_sticker_layout_for_page(
        page=_FakePage(),
        sheet_usable_w=40.0,
        sheet_usable_h=25.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        shape_type_override="CIRCLE_ELLIPSE",
        shape_props_override={"width": 40.0, "height": 25.0},
    )

    assert result["totalItems"] == 1
    assert calls == []
