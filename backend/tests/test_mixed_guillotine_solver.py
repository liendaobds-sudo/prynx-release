"""Unit/property tests cho solver Bình cắt xén nhiều kích thước."""

from __future__ import annotations

import copy
import random

import pytest

from app.workers.mixed_guillotine import (
    MixedGuillotineError,
    MixedGuillotineSettings,
    ProductSpec,
    Rect,
    build_mixed_guillotine_plan,
    compute_plan_hash,
    project_template_face,
    validate_duplex_pair_sizes,
    validate_guillotine_plan,
)


def _settings(
    width: float = 400.0,
    height: float = 300.0,
    *,
    gap_x: float = 0.0,
    gap_y: float = 0.0,
    split_gap: float | None = None,
    duplex: bool = False,
    flip_edge: str = "long",
) -> MixedGuillotineSettings:
    return MixedGuillotineSettings(
        sheet_width=width,
        sheet_height=height,
        usable_rect=Rect(0.0, 0.0, width, height),
        gap_x=gap_x,
        gap_y=gap_y,
        split_gap=split_gap,
        duplex=duplex,
        flip_edge=flip_edge,
    )


def _product(
    product_id: int,
    width: float,
    height: float,
    quantity: int = 0,
    *,
    back: bool = False,
    allow_rotate: bool = True,
) -> ProductSpec:
    front_idx = product_id * 2 if back else product_id
    return ProductSpec(
        product_id=product_id,
        front_page_idx=front_idx,
        back_page_idx=front_idx + 1 if back else None,
        trim_width=width,
        trim_height=height,
        requested_quantity=quantity,
        allow_rotate=allow_rotate,
    )


def _walk_tree(node):
    yield node
    if node["kind"] == "split":
        yield from _walk_tree(node["first"])
        yield from _walk_tree(node["second"])


def test_two_different_sizes_share_one_cut_safe_template():
    plan = build_mixed_guillotine_plan(
        [_product(0, 100, 50), _product(1, 60, 40)],
        _settings(gap_x=5, gap_y=5),
    )

    assert len(plan["templates"]) == 1
    assert {p["productId"] for p in plan["templates"][0]["placements"]} == {0, 1}
    assert plan["templates"][0]["cutTree"]["kind"] == "split"
    validate_guillotine_plan(plan)


def test_auto_fill_prioritizes_used_area_and_emits_diagnostics(caplog):
    mm_to_pt = 72.0 / 25.4
    caplog.set_level("INFO", logger="app.workers.mixed_guillotine")
    plan = build_mixed_guillotine_plan(
        [
            _product(0, 96 * mm_to_pt, 60 * mm_to_pt, back=True),
            _product(1, 100 * mm_to_pt, 100 * mm_to_pt, back=True),
        ],
        _settings(width=297 * mm_to_pt, height=420 * mm_to_pt, duplex=True),
    )

    template = plan["templates"][0]
    capacities = {
        item["productId"]: item["placedPerRun"]
        for item in template["placedByProduct"]
    }
    used_area = sum(
        placement["width"] * placement["height"]
        for placement in template["placements"]
    )
    sheet_area = plan["usableRect"]["width"] * plan["usableRect"]["height"]

    # Không nhập SL: vẫn ưu tiên diện tích, nhưng mỗi loại chỉ được có một khối.
    assert template["family"] == "horizontal_equal"
    assert capacities == {0: 9, 1: 4}
    assert used_area / sheet_area > 0.73
    zones_by_product: dict[int, set[str]] = {}
    for node in _walk_tree(template["cutTree"]):
        if node["kind"] == "zone":
            zones_by_product.setdefault(node["productId"], set()).add(node["zoneId"])
    assert set(zones_by_product) == {0, 1}
    assert all(len(zone_ids) == 1 for zone_ids in zones_by_product.values())
    validate_guillotine_plan(plan)

    back = project_template_face(
        template,
        side="back",
        sheet_width=plan["sheetWidth"],
        sheet_height=plan["sheetHeight"],
        flip_edge="long",
    )
    back_by_id = {placement["placementId"]: placement for placement in back["placements"]}
    for front in template["placements"]:
        mirrored = back_by_id[front["placementId"]]
        assert mirrored["x"] == pytest.approx(
            plan["sheetWidth"] - front["x"] - front["width"]
        )
        assert mirrored["y"] == pytest.approx(front["y"])
        assert mirrored["sourcePageIdx"] == front["backPageIdx"]

    messages = "\n".join(record.getMessage() for record in caplog.records)
    for event in ("input", "candidates", "template", "done"):
        assert f"[MIXED_GUILLOTINE] {event}" in messages
    assert '"mode":"maximize_area"' in messages
    assert '"slackMm"' in messages
    assert '"grid":{"cols":' in messages
    assert '"wastePct":' in messages
    assert '"family":"horizontal_demand"' in messages


def test_each_product_uses_one_compact_block_with_centered_cluster_cut():
    mm_to_pt = 72.0 / 25.4
    item_gap = 2 * mm_to_pt
    split_gap = 16 * mm_to_pt
    plan = build_mixed_guillotine_plan(
        [
            _product(0, 96 * mm_to_pt, 60 * mm_to_pt),
            _product(1, 100 * mm_to_pt, 100 * mm_to_pt),
        ],
        _settings(
            width=297 * mm_to_pt,
            height=420 * mm_to_pt,
            gap_x=item_gap,
            gap_y=item_gap,
            split_gap=split_gap,
        ),
    )

    template = plan["templates"][0]
    capacities = {
        item["productId"]: item["placedPerRun"]
        for item in template["placedByProduct"]
    }
    assert capacities == {0: 9, 1: 4}
    assert plan["splitGap"] == pytest.approx(split_gap)

    root = template["cutTree"]
    assert root["kind"] == "split"
    assert root["first"]["kind"] == "zone"
    assert root["second"]["kind"] == "zone"
    assert root["first"]["productId"] != root["second"]["productId"]
    assert root["gapEnd"] - root["gapStart"] == pytest.approx(split_gap)

    first_content = root["first"]["grid"]["contentRect"]
    second_content = root["second"]["grid"]["contentRect"]
    if root["axis"] == "x":
        assert first_content["x"] + first_content["width"] == pytest.approx(
            root["gapStart"]
        )
        assert second_content["x"] == pytest.approx(root["gapEnd"])
    else:
        assert first_content["y"] + first_content["height"] == pytest.approx(
            root["gapStart"]
        )
        assert second_content["y"] == pytest.approx(root["gapEnd"])

    for node in (root["first"], root["second"]):
        assert node["grid"]["gapX"] == pytest.approx(item_gap)
        assert node["grid"]["gapY"] == pytest.approx(item_gap)

    zone_cuts = [line for line in template["cutLines"] if line["kind"] == "zone"]
    assert len(zone_cuts) == 1
    assert zone_cuts[0]["axis"] == root["axis"]
    assert zone_cuts[0]["coordinate"] == pytest.approx(
        (root["gapStart"] + root["gapEnd"]) / 2.0
    )
    validate_guillotine_plan(plan)

    broken = copy.deepcopy(plan)
    broken["templates"][0]["cutTree"]["second"]["productId"] = 0
    with pytest.raises(MixedGuillotineError, match="bị tách thành hai khối"):
        validate_guillotine_plan(broken)


def test_horizontal_strips_are_used_when_vertical_strips_cannot_fit():
    plan = build_mixed_guillotine_plan(
        [
            _product(0, 180, 40, allow_rotate=False),
            _product(1, 180, 40, allow_rotate=False),
        ],
        _settings(width=200, height=100, gap_y=10),
    )

    assert plan["templates"][0]["family"].startswith("horizontal")
    validate_guillotine_plan(plan)


def test_three_sizes_use_two_by_two_grid_with_waste_leaf():
    plan = build_mixed_guillotine_plan(
        [
            _product(0, 90, 90, allow_rotate=False),
            _product(1, 90, 90, allow_rotate=False),
            _product(2, 90, 90, allow_rotate=False),
        ],
        _settings(width=200, height=200, gap_x=10, gap_y=10),
    )

    template = plan["templates"][0]
    assert template["family"] == "grid_2x2"
    assert sum(node["kind"] == "waste" for node in _walk_tree(template["cutTree"])) == 1
    validate_guillotine_plan(plan)


def test_product_rotates_only_when_needed_to_fit():
    plan = build_mixed_guillotine_plan(
        [_product(0, 60, 90)],
        _settings(width=100, height=70),
    )

    assert {placement["rotation"] for placement in plan["templates"][0]["placements"]} == {90}
    validate_guillotine_plan(plan)


def test_equal_yield_prefers_unrotated_grid():
    plan = build_mixed_guillotine_plan(
        [_product(0, 40, 60)],
        _settings(width=120, height=120),
    )

    assert {placement["rotation"] for placement in plan["templates"][0]["placements"]} == {0}


def test_zone_gap_is_counted_once_in_split_tree():
    plan = build_mixed_guillotine_plan(
        [
            _product(0, 100, 100, allow_rotate=False),
            _product(1, 100, 100, allow_rotate=False),
        ],
        _settings(width=220, height=100, gap_x=20),
    )

    root = plan["templates"][0]["cutTree"]
    assert root["axis"] == "x"
    assert root["gapStart"] == pytest.approx(100.0)
    assert root["gapEnd"] == pytest.approx(120.0)
    validate_guillotine_plan(plan)


@pytest.mark.parametrize(
    "quantities",
    [
        (100, 50),
        (100, 33),
        (1, 10_000),
    ],
)
def test_quantities_never_underdeliver_and_auto_excess_stays_within_cap(quantities):
    plan = build_mixed_guillotine_plan(
        [
            _product(0, 50, 50, quantities[0]),
            _product(1, 40, 40, quantities[1]),
        ],
        _settings(width=300, height=200, gap_x=5, gap_y=5),
    )

    totals = {item["productId"]: item for item in plan["totalsByProduct"]}
    for product_id, requested in enumerate(quantities):
        actual = totals[product_id]["actualQuantity"]
        excess = totals[product_id]["excessQuantity"]
        assert actual >= requested
        assert excess / requested <= 0.10

    if quantities == (100, 33):
        assert len(plan["templates"]) == 1
        assert any(item["excessQuantity"] > 0 for item in totals.values())
    else:
        assert all(item["excessQuantity"] == 0 for item in totals.values())
    assert len(plan["templates"]) <= 4
    assert all(
        sum(node["kind"] == "zone" for node in _walk_tree(template["cutTree"])) <= 2
        for template in plan["templates"]
    )
    validate_guillotine_plan(plan)


def test_product_larger_than_usable_sheet_reports_page_and_size():
    with pytest.raises(MixedGuillotineError, match=r"Trang 1 .*500\.00 × 400\.00"):
        build_mixed_guillotine_plan(
            [_product(0, 500, 400)],
            _settings(width=300, height=200),
        )


def test_plan_and_hash_are_deterministic():
    products = [_product(0, 90, 50, 123), _product(1, 60, 40, 57)]
    first = build_mixed_guillotine_plan(products, _settings(gap_x=4, gap_y=7))
    second = build_mixed_guillotine_plan(products, _settings(gap_x=4, gap_y=7))

    assert first == second
    assert first["planHash"] == compute_plan_hash(first)


def test_duplex_pair_size_tolerance_and_error_message():
    validate_duplex_pair_sizes([(0, 100.0, 50.0, 1, 100.4, 50.4)])

    with pytest.raises(MixedGuillotineError, match=r"Cặp trang 1–2"):
        validate_duplex_pair_sizes([(0, 100.0, 50.0, 1, 100.6, 50.0)])


@pytest.mark.parametrize(
    ("edge", "expected_x", "expected_y", "expected_rotation"),
    [
        ("long", 289.0, 47.0, 270),
        ("short", 31.0, 203.0, 270),
    ],
)
def test_back_face_is_materialized_once(edge, expected_x, expected_y, expected_rotation):
    template = {
        "templateId": "T001",
        "runCount": 1,
        "placements": [
            {
                "placementId": "T001-P0001",
                "productId": 0,
                "zoneId": "Z001",
                "frontPageIdx": 0,
                "backPageIdx": 1,
                "sourcePageIdx": 0,
                "x": 31.0,
                "y": 47.0,
                "width": 80.0,
                "height": 50.0,
                "rotation": 90,
                "gridSlot": 0,
            }
        ],
        "cutTree": {
            "kind": "waste",
            "rect": {"x": 0.0, "y": 0.0, "width": 400.0, "height": 300.0},
            "zoneId": "Z001",
            "productId": None,
        },
        "cutLines": [
            {"axis": "x", "coordinate": 10.0, "start": 20.0, "end": 260.0, "order": 0, "kind": "zone"},
            {"axis": "y", "coordinate": 90.0, "start": 10.0, "end": 380.0, "order": 1, "kind": "zone"},
        ],
        "placedByProduct": [{"productId": 0, "placedPerRun": 1}],
    }
    original = copy.deepcopy(template)

    back = project_template_face(
        template,
        side="back",
        sheet_width=400.0,
        sheet_height=300.0,
        flip_edge=edge,
    )

    placement = back["placements"][0]
    assert placement["x"] == expected_x
    assert placement["y"] == expected_y
    assert placement["rotation"] == expected_rotation
    assert placement["sourcePageIdx"] == 1
    assert template == original  # planner không được mutate mặt trước


def test_long_and_short_edges_mirror_cut_lines_with_the_same_axis():
    plan = build_mixed_guillotine_plan(
        [_product(0, 80, 50, back=True)],
        _settings(width=400, height=300, duplex=True),
    )
    template = plan["templates"][0]

    long_face = project_template_face(
        template, side="back", sheet_width=400, sheet_height=300, flip_edge="long"
    )
    short_face = project_template_face(
        template, side="back", sheet_width=400, sheet_height=300, flip_edge="short"
    )

    front_x = sorted(line["coordinate"] for line in template["cutLines"] if line["axis"] == "x")
    front_y = sorted(line["coordinate"] for line in template["cutLines"] if line["axis"] == "y")
    long_x = sorted(line["coordinate"] for line in long_face["cutLines"] if line["axis"] == "x")
    short_y = sorted(line["coordinate"] for line in short_face["cutLines"] if line["axis"] == "y")
    assert long_x == pytest.approx(sorted(400 - value for value in front_x))
    assert short_y == pytest.approx(sorted(300 - value for value in front_y))


def test_validator_rejects_out_of_zone_placement():
    plan = build_mixed_guillotine_plan([_product(0, 80, 50)], _settings())
    broken = copy.deepcopy(plan)
    broken.pop("planHash")
    broken["templates"][0]["placements"][0]["x"] = -1.0

    with pytest.raises(MixedGuillotineError, match="ngoài zone"):
        validate_guillotine_plan(broken)


def test_validator_rejects_cut_lines_not_derived_from_tree():
    plan = build_mixed_guillotine_plan([_product(0, 80, 50)], _settings())
    broken = copy.deepcopy(plan)
    broken.pop("planHash")
    broken["templates"][0]["cutLines"][0]["coordinate"] += 1.0

    with pytest.raises(MixedGuillotineError, match="không khớp cây cắt"):
        validate_guillotine_plan(broken)


def test_seeded_geometry_sweep_keeps_all_invariants():
    rng = random.Random(20260730)
    for _case in range(20):
        products = [
            _product(
                product_id,
                rng.randint(20, 80),
                rng.randint(20, 80),
                rng.randint(1, 500),
            )
            for product_id in range(rng.randint(1, 5))
        ]
        settings = _settings(
            width=300,
            height=220,
            gap_x=rng.randint(0, 8),
            gap_y=rng.randint(0, 8),
        )

        first = build_mixed_guillotine_plan(products, settings)
        second = build_mixed_guillotine_plan(products, settings)

        validate_guillotine_plan(first)
        assert first == second
        totals = {item["productId"]: item for item in first["totalsByProduct"]}
        assert all(
            totals[product.product_id]["actualQuantity"] == product.requested_quantity
            for product in products
        )
