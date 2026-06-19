"""Test toán chia dao D1/D2/S theo cột (task 13.2). Khớp công thức script JSX. Req 4.6."""

from app.workers.cut_export.blade_routing import (
    assign_blade,
    assign_blades_for_columns,
    LEFT, RIGHT, SHARED, BLADE_SLOT,
)


def test_single_or_zero_column_is_shared():
    assert assign_blade(0, 1) == SHARED
    assert assign_blade(0, 0) == SHARED


def test_even_columns_split_half_half_no_middle():
    # numCols=4 → half=2: cột 0,1=left; 2,3=right; không có giữa.
    assert assign_blades_for_columns([0, 1, 2, 3], 4) == [LEFT, LEFT, RIGHT, RIGHT]


def test_odd_columns_has_shared_middle():
    # numCols=5 → half=2: 0,1=left; 4,3=right; 2=shared (cột giữa).
    assert assign_blades_for_columns([0, 1, 2, 3, 4], 5) == [LEFT, LEFT, SHARED, RIGHT, RIGHT]


def test_three_columns():
    # numCols=3 → half=1: 0=left; 2=right; 1=shared.
    assert assign_blades_for_columns([0, 1, 2], 3) == [LEFT, SHARED, RIGHT]


def test_two_columns():
    # numCols=2 → half=1: 0=left; 1=right.
    assert assign_blades_for_columns([0, 1], 2) == [LEFT, RIGHT]


def test_seven_columns_matches_script_formula():
    # numCols=7 → half=3: 0,1,2=left; 3=shared; 4,5,6=right.
    assert assign_blades_for_columns([0, 1, 2, 3, 4, 5, 6], 7) == [
        LEFT, LEFT, LEFT, SHARED, RIGHT, RIGHT, RIGHT
    ]


def test_blade_slot_mapping():
    assert BLADE_SLOT[SHARED] == 0
    assert BLADE_SLOT[LEFT] == 1
    assert BLADE_SLOT[RIGHT] == 2
