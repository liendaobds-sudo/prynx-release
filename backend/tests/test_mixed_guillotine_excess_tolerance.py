"""Gom bản kẽm theo ngưỡng in dư + cảnh báo lề bất đối xứng.

MIXED-GUILLOTINE (audit 2026-07-30 §MG-A2, §MG-B2).
"""

from __future__ import annotations

import pytest

from app.workers.mixed_guillotine import (
    MixedGuillotineError,
    MixedGuillotineSettings,
    ProductSpec,
    Rect,
    build_mixed_guillotine_plan,
    validate_guillotine_plan,
)

MM = 72.0 / 25.4


def _mm(value: float) -> float:
    return value * MM


def _settings(
    *,
    excess_tolerance: float = 0.0,
    gap: float = 0.0,
    duplex: bool = False,
    flip_edge: str = "long",
    margin_left: float = 10.0,
    margin_right: float = 10.0,
    margin_top: float = 10.0,
    margin_bottom: float = 12.0,
    sheet_w: float = 790.0,
    sheet_h: float = 1090.0,
) -> MixedGuillotineSettings:
    """Tờ 79×109cm, lề đáy = gripper 12mm — cấu hình thật của nhà in VN."""
    return MixedGuillotineSettings(
        sheet_width=_mm(sheet_w),
        sheet_height=_mm(sheet_h),
        usable_rect=Rect(
            _mm(margin_left),
            _mm(margin_top),
            _mm(sheet_w - margin_left - margin_right),
            _mm(sheet_h - margin_top - margin_bottom),
        ),
        gap_x=_mm(gap),
        gap_y=_mm(gap),
        duplex=duplex,
        flip_edge=flip_edge,  # type: ignore[arg-type]
        excess_tolerance=excess_tolerance,
    )


def _cards(*quantities: int) -> list[ProductSpec]:
    """3 loại name card khác kích thước — ca đo trong báo cáo audit."""
    sizes = [(90.0, 54.0), (85.0, 55.0), (90.0, 50.0)]
    return [
        ProductSpec(
            product_id=index,
            front_page_idx=index,
            trim_width=_mm(sizes[index][0]),
            trim_height=_mm(sizes[index][1]),
            requested_quantity=quantity,
        )
        for index, quantity in enumerate(quantities)
    ]


def _plate_count(plan: dict) -> int:
    return len(plan["templates"])


def _sheet_count(plan: dict) -> int:
    return sum(int(template["runCount"]) for template in plan["templates"])


def _worst_excess_ratio(plan: dict) -> float:
    worst = 0.0
    for row in plan["totalsByProduct"]:
        requested = int(row["requestedQuantity"])
        if requested > 0:
            worst = max(worst, int(row["excessQuantity"]) / requested)
    return worst


# ── §MG-A2: gom bản kẽm ──────────────────────────────────────────────────────


def test_automatic_policy_keeps_exact_plan_when_ten_percent_cannot_reduce_plates():
    """SL lệch nhiều: tự động 10% vẫn giữ phương án chính xác, không ép in dư."""
    plan = build_mixed_guillotine_plan(_cards(5000, 1000, 200), _settings())

    assert _worst_excess_ratio(plan) == 0.0
    assert _plate_count(plan) == 6  # số đo trong báo cáo audit
    assert plan["excessTolerance"] == pytest.approx(0.10)
    validate_guillotine_plan(plan)


def test_automatic_policy_collapses_equal_quantities_to_one_plate():
    """SL đều nhau: tự gom về 1 bản kẽm với dư rất nhỏ (đo: +1,2%)."""
    products = _cards(1000, 1000, 1000)
    plan = build_mixed_guillotine_plan(products, _settings(gap=6.0))

    assert _plate_count(plan) == 1
    assert 0.0 < _worst_excess_ratio(plan) <= 0.10
    validate_guillotine_plan(plan)


def test_tolerance_too_small_falls_back_to_multi_plate():
    """SL lệch nhiều cần dư ~80% để về 1 kẽm → ngưỡng 10% phải từ chối, không ép."""
    products = _cards(5000, 1000, 200)
    plan = build_mixed_guillotine_plan(products, _settings(excess_tolerance=0.10))

    assert _plate_count(plan) > 1
    assert _worst_excess_ratio(plan) <= 0.10
    validate_guillotine_plan(plan)


def test_legacy_generous_tolerance_cannot_override_automatic_safety_cap():
    """Giá trị cũ 100% bị bỏ qua; ca cần dư ~80% vẫn không được ép về 1 kẽm."""
    products = _cards(5000, 1000, 200)
    plan = build_mixed_guillotine_plan(products, _settings(excess_tolerance=1.0))

    assert _plate_count(plan) > 1
    assert _worst_excess_ratio(plan) <= 0.10
    for row in plan["totalsByProduct"]:
        # Bất biến quan trọng nhất: không bao giờ in thiếu.
        assert int(row["actualQuantity"]) >= int(row["requestedQuantity"])
    validate_guillotine_plan(plan)


def test_automatic_policy_does_not_print_excess_when_plate_count_cannot_drop():
    """Đã chỉ có 1 kẽm thì giữ đúng SL, không dùng 10% chỉ vì được phép."""
    plan = build_mixed_guillotine_plan(
        _cards(20, 20, 70), _settings(gap=6.0, excess_tolerance=1.0)
    )

    assert _plate_count(plan) == 1
    assert _worst_excess_ratio(plan) == 0.0
    validate_guillotine_plan(plan)


def test_without_quantities_disables_automatic_excess():
    plan = build_mixed_guillotine_plan(_cards(0, 0, 0), _settings(gap=6.0))

    assert plan["excessTolerance"] == 0.0
    assert _worst_excess_ratio(plan) == 0.0
    validate_guillotine_plan(plan)


def test_tolerance_never_underdelivers():
    """Bất biến quan trọng nhất: gom kẽm không được thiếu hàng."""
    for tolerance in (0.0, 0.05, 0.10, 0.5, 2.0):
        for quantities in [(1000, 1000, 1000), (5000, 1000, 200), (997, 991, 983)]:
            plan = build_mixed_guillotine_plan(
                _cards(*quantities), _settings(excess_tolerance=tolerance)
            )
            for row, requested in zip(plan["totalsByProduct"], quantities):
                assert int(row["actualQuantity"]) >= requested, (
                    tolerance,
                    quantities,
                )
            validate_guillotine_plan(plan)


def test_tolerance_is_deterministic():
    products = _cards(1000, 1000, 1000)
    settings = _settings(gap=6.0, excess_tolerance=0.10)

    first = build_mixed_guillotine_plan(products, settings)
    second = build_mixed_guillotine_plan(products, settings)

    assert first == second


def test_plan_reports_tolerance_used():
    plan = build_mixed_guillotine_plan(
        _cards(1000, 1000, 1000), _settings(gap=6.0, excess_tolerance=0.10)
    )
    assert plan["excessTolerance"] == pytest.approx(0.10)


def test_validator_rejects_excess_over_declared_tolerance():
    """Bug ở khâu gom kẽm phải bị validator bắt, không lọt ra file."""
    plan = build_mixed_guillotine_plan(
        _cards(1000, 1000, 1000), _settings(gap=6.0, excess_tolerance=0.10)
    )
    broken = dict(plan)
    broken.pop("planHash")
    broken["excessTolerance"] = 0.0  # khai 0% nhưng plan đang có dư

    if _worst_excess_ratio(plan) > 0:
        with pytest.raises(MixedGuillotineError, match="vượt ngưỡng cho phép"):
            validate_guillotine_plan(broken)


@pytest.mark.parametrize("bad", [-0.01, 10.5])
def test_invalid_tolerance_reports_vietnamese_error(bad):
    with pytest.raises(MixedGuillotineError, match="Tỉ lệ in dư"):
        build_mixed_guillotine_plan(_cards(100, 100, 100), _settings(excess_tolerance=bad))


# ── §MG-B2: cảnh báo lề bất đối xứng ─────────────────────────────────────────


def _duplex_products() -> list[ProductSpec]:
    return [
        ProductSpec(0, 0, _mm(90), _mm(54), 0, back_page_idx=1),
        ProductSpec(1, 2, _mm(85), _mm(55), 0, back_page_idx=3),
    ]


def test_no_warning_when_one_sided():
    plan = build_mixed_guillotine_plan(
        _cards(0, 0, 0), _settings(margin_top=10.0, margin_bottom=25.0)
    )
    assert plan["warnings"] == []


def test_no_warning_when_flip_axis_margins_are_symmetric():
    """Lật cạnh dài chỉ quan tâm lề trái/phải — lề trên/dưới lệch không sao."""
    plan = build_mixed_guillotine_plan(
        _duplex_products(),
        _settings(duplex=True, flip_edge="long", margin_top=10.0, margin_bottom=25.0),
    )
    assert plan["warnings"] == []


def test_warns_when_long_edge_flip_has_asymmetric_side_margins():
    plan = build_mixed_guillotine_plan(
        _duplex_products(),
        _settings(duplex=True, flip_edge="long", margin_left=10.0, margin_right=30.0),
    )

    assert len(plan["warnings"]) == 1
    warning = plan["warnings"][0]
    assert "ĐỔI CHỖ" in warning
    assert "10.0mm" in warning and "30.0mm" in warning
    # Gợi ý phải là lề lớn hơn trong hai lề.
    assert "30.0mm" in warning.split("hãy đặt cả hai lề bằng")[-1]


def test_warns_when_short_edge_flip_has_asymmetric_gripper_margin():
    """Lật cạnh ngắn + lề đáy = gripper là ca hay gặp nhất."""
    plan = build_mixed_guillotine_plan(
        _duplex_products(),
        _settings(duplex=True, flip_edge="short", margin_top=10.0, margin_bottom=25.0),
    )

    assert len(plan["warnings"]) == 1
    assert "trên" in plan["warnings"][0] and "dưới" in plan["warnings"][0]


def test_warning_does_not_change_geometry():
    """Cảnh báo là cảnh báo — KHÔNG được âm thầm thu hẹp vùng in."""
    asymmetric = _settings(
        duplex=True, flip_edge="long", margin_left=10.0, margin_right=30.0
    )
    plan = build_mixed_guillotine_plan(_duplex_products(), asymmetric)

    assert plan["usableRect"]["x"] == pytest.approx(_mm(10.0))
    assert plan["usableRect"]["width"] == pytest.approx(_mm(750.0))
    assert plan["warnings"]
    validate_guillotine_plan(plan)
