"""M72.A: số bố cục, số lần in, đối soát SL và identity lưu/đọc."""

import copy
import json

import pytest

from app.core.nesting_order_plan import (
    NestingOrderDemand, NestingOrderError, NestingOrderPlan,
    build_order_plan, normalize_order_demand, require_fulfilled_manifest,
)


def _layouts(count=72, capacity=9):
    return [
        {"layoutId": f"sheet-{start // capacity}", "runCount": 1,
         "countsByPart": {f"p-{i}": 1 for i in range(start, min(start + capacity, count))}}
        for start in range(0, count, capacity)
    ]


@pytest.mark.parametrize("quantity,sheets", [(1, 8), (100, 800)])
def test_72_types_nine_per_layout(quantity, sheets):
    demand = normalize_order_demand({f"p-{i}": quantity for i in range(72)})
    assert demand.repeat_count == quantity
    assert dict(demand.base) == {f"p-{i}": 1 for i in range(72)}
    plan = build_order_plan(demand, _layouts(), layout_fingerprint="geometry-72")
    assert plan.template_count == 8
    assert plan.physical_sheet_count == sheets
    assert dict(plan.produced) == {f"p-{i}": quantity for i in range(72)}
    assert sum(dict(plan.produced).values()) == 72 * quantity
    assert NestingOrderPlan.from_payload(json.loads(json.dumps(plan.to_payload()))) == plan


def test_last_type_is_not_dropped():
    demand = normalize_order_demand({f"p-{i}": 1 for i in range(73)})
    plan = build_order_plan(demand, _layouts(73), layout_fingerprint="geometry-73")
    assert plan.template_count == plan.physical_sheet_count == 9
    assert dict(plan.layouts[-1].counts) == {"p-72": 1}


def test_unequal_quantities_keep_own_demands_and_tail():
    demand = normalize_order_demand({"a": 100, "b": 50, "skip": 0})
    assert demand.repeat_count == 50
    assert dict(demand.base) == {"a": 2, "b": 1}
    plan = build_order_plan(demand, [
        {"layoutId": "ab", "countsByPart": {"a": 1, "b": 1}, "runCount": 1},
        {"layoutId": "tail-a", "countsByPart": {"a": 1}, "runCount": 1},
    ], layout_fingerprint="ab-tail")
    assert plan.physical_sheet_count == 100
    assert dict(plan.produced) == {"a": 100, "b": 50, "skip": 0}


def test_no_common_factor_does_not_round_demand():
    demand = normalize_order_demand({"a": 100, "b": 101})
    assert demand.repeat_count == 1
    assert demand.base == demand.requested


def test_layout_runs_can_differ_with_a_tail():
    demand = normalize_order_demand({"a": 5, "b": 3})
    plan = build_order_plan(demand, [
        {"layoutId": "ab", "countsByPart": {"a": 1, "b": 1}, "runCount": 3},
        {"layoutId": "tail", "countsByPart": {"a": 1}, "runCount": 2},
    ], layout_fingerprint="unequal-runs")
    assert plan.template_count == 2
    assert plan.physical_sheet_count == 5
    assert [layout.run_count for layout in plan.layouts] == [3, 2]
    assert dict(plan.produced) == {"a": 5, "b": 3}
    assert NestingOrderPlan.from_payload(plan.to_payload()) == plan


@pytest.mark.parametrize("value", [True, 1.0])
@pytest.mark.parametrize("field", ["repeatCount", "baseByPart"])
def test_order_snapshot_preserves_integer_types(value, field):
    payload = normalize_order_demand({"a": 1}).to_payload()
    if field == "baseByPart":
        payload[field]["a"] = value
    else:
        payload[field] = value
    with pytest.raises(NestingOrderError):
        NestingOrderDemand.from_payload(payload)


def test_plan_snapshot_rejects_float_summary_for_integer():
    demand = normalize_order_demand({"a": 1})
    payload = build_order_plan(demand, [
        {"layoutId": "a", "countsByPart": {"a": 1}, "runCount": 1},
    ], layout_fingerprint="one").to_payload()
    payload["physicalSheetCount"] = 1.0
    with pytest.raises(NestingOrderError):
        NestingOrderPlan.from_payload(payload)


@pytest.mark.parametrize("requested", [
    {}, {"a": 0}, {"a": -1}, {"a": True}, {"a": 1.5}, {"a": "100"},
    {"": 1}, {1: 1}, {"a": None},
])
def test_invalid_quantities_fail_closed(requested):
    with pytest.raises(NestingOrderError):
        normalize_order_demand(requested)


def test_reordering_is_stable_but_demand_and_geometry_are_not_aliases():
    first = normalize_order_demand({"a": 100, "b": 100})
    assert first == normalize_order_demand({"b": 100, "a": 100})
    assert first.fingerprint != normalize_order_demand({"a": 200, "b": 200}).fingerprint
    layouts = [{"layoutId": "ab", "countsByPart": {"a": 1, "b": 1}, "runCount": 1}]
    plan = build_order_plan(first, layouts, layout_fingerprint="geometry-a")
    other = build_order_plan(first, layouts, layout_fingerprint="geometry-b")
    assert plan.to_payload()["planFingerprint"] != other.to_payload()["planFingerprint"]
    layouts[0]["countsByPart"]["a"] = 999
    payload = plan.to_payload()
    payload["layouts"][0]["countsByPart"]["a"] = 999
    assert dict(plan.layouts[0].counts)["a"] == 1


@pytest.mark.parametrize("change", ["repeat", "count", "summary", "identity", "extra"])
def test_stored_plan_cannot_drift_from_order(change):
    demand = normalize_order_demand({f"p-{i}": 100 for i in range(72)})
    payload = build_order_plan(demand, _layouts(), layout_fingerprint="geometry").to_payload()
    if change == "repeat":
        payload["layouts"][0]["runCount"] = 99
    elif change == "count":
        payload["layouts"][0]["countsByPart"]["p-0"] = 2
    elif change == "summary":
        payload["physicalSheetCount"] = 8
    elif change == "identity":
        payload["layoutFingerprint"] = "other"
    else:
        payload["untrusted"] = True
    with pytest.raises(NestingOrderError):
        NestingOrderPlan.from_payload(payload)


@pytest.mark.parametrize("change", ["missing", "extra", "unknown", "duplicate", "zero_runs"])
def test_layout_plan_must_match_each_type(change):
    demand = normalize_order_demand({f"p-{i}": 1 for i in range(72)})
    layouts = _layouts()
    if change == "missing":
        layouts.pop()
    elif change == "extra":
        layouts[0]["countsByPart"]["p-0"] = 2
    elif change == "unknown":
        layouts[0]["countsByPart"]["stranger"] = 1
    elif change == "duplicate":
        layouts[1]["layoutId"] = layouts[0]["layoutId"]
    else:
        layouts[0]["runCount"] = 0
    with pytest.raises(NestingOrderError):
        build_order_plan(demand, layouts, layout_fingerprint="geometry")


def test_manifest_gate_counts_placements_not_valid_flag_or_stats():
    requested = {f"p-{i}": 1 for i in range(72)}
    manifest = {
        "validation": {"valid": True},
        "placements": [{"instanceId": f"i-{i}", "partId": f"p-{i}"} for i in range(6)],
        "unplaced": [],
        "stats": {"placedCount": 72},
    }
    with pytest.raises(NestingOrderError, match="6/72"):
        require_fulfilled_manifest(requested, manifest)


@pytest.mark.parametrize("change", ["duplicate", "wrong_part", "unplaced", "stats"])
def test_complete_claim_with_bad_ledger_is_rejected(change):
    manifest = {
        "placements": [{"instanceId": "a-1", "partId": "a"}, {"instanceId": "b-1", "partId": "b"}],
        "unplaced": [], "stats": {"placedCount": 2, "unplacedCount": 0},
    }
    require_fulfilled_manifest({"a": 1, "b": 1}, manifest)
    broken = copy.deepcopy(manifest)
    if change == "duplicate":
        broken["placements"][1]["instanceId"] = "a-1"
    elif change == "wrong_part":
        broken["placements"][1]["partId"] = "a"
    elif change == "unplaced":
        broken["unplaced"] = [{"partId": "b"}]
    else:
        broken["stats"]["placedCount"] = 99
    with pytest.raises(NestingOrderError):
        require_fulfilled_manifest({"a": 1, "b": 1}, broken)
