"""Chống hồi quy: nhiều mẫu hơn sức chứa MỘT tờ thì phải mở thêm TỜ MẪU.

Bug gốc (audit 2026-08-06): 50 loại tem, mỗi tờ chỉ xếp được 25 → xưởng chỉ nhận
được 1 tờ in + 1 tờ khuôn, 25 loại sau mất hẳn. Cả ba đường đi (auto-fill,
offset theo tỉ lệ, và guillotine nhánh không nhập SL) đều bỏ vòng lặp tràn tờ.
"""
from app.workers.mixed_guillotine import (
    MixedGuillotineSettings,
    ProductSpec,
    Rect,
    build_mixed_guillotine_plan,
)
from app.workers.sticker_imposer_pkg.bin_packing import (
    solve_auto_fill_mixed,
    solve_offset_mixed,
)

# Tờ 500×500, tem 100×100 → đúng 25 ô/tờ. 50 loại ⇒ phải thành 2 tờ mẫu.
_SHEET = 500.0
_DIMS = [(i, 100.0, 100.0) for i in range(50)]


def test_auto_fill_tran_sang_to_ke_tiep():
    r = solve_auto_fill_mixed(
        sheet_w=_SHEET, sheet_h=_SHEET, page_dims=_DIMS,
        gap=0.0, allow_rotation=False,
    )
    assert r['sheet_count'] == 2
    assert len(r['placed_by_page']) == 50, "có loại tem bị bỏ im lặng"
    assert r['total_placed'] == 50


def test_offset_tran_to_va_sheets_needed_theo_dat_that():
    qty = 1000
    r = solve_offset_mixed(
        sheet_w=_SHEET, sheet_h=_SHEET,
        page_dims_qty=[(i, 100.0, 100.0, qty) for i in range(50)],
        gap=0.0, allow_rotation=False,
    )
    assert r['sheet_count'] == 2
    assert len(r['placed_by_page']) == 50, "có loại tem bị bỏ im lặng"
    # Mỗi tờ mẫu là một bộ kẽm riêng ⇒ tổng lượt in là TỔNG, không phải max.
    assert r['sheets_needed'] == sum(s['sheets_needed'] for s in r['sheets'])


def test_auto_fill_it_mau_van_mot_to():
    """Không được vô cớ chẻ tờ khi mọi loại vẫn vừa một tờ."""
    r = solve_auto_fill_mixed(
        sheet_w=_SHEET, sheet_h=_SHEET,
        page_dims=[(0, 100.0, 100.0), (1, 100.0, 100.0), (2, 100.0, 100.0)],
        gap=0.0, allow_rotation=False,
    )
    assert r.get('sheet_count') in (None, 1)
    assert len(r['placed_by_page']) == 3


def _guillotine_plan(requested_quantity):
    products = [
        ProductSpec(
            product_id=i, front_page_idx=i,
            trim_width=100.0, trim_height=100.0,
            requested_quantity=requested_quantity,
        )
        for i in range(50)
    ]
    settings = MixedGuillotineSettings(
        sheet_width=_SHEET, sheet_height=_SHEET,
        usable_rect=Rect(0.0, 0.0, _SHEET, _SHEET),
    )
    return build_mixed_guillotine_plan(products, settings)


def test_guillotine_khong_nhap_sl_van_phu_het_mau():
    plan = _guillotine_plan(0)
    covered = {p['productId'] for t in plan['templates'] for p in t['placements']}
    assert len(plan['templates']) == 2
    assert len(covered) == 50, "nhánh không-SL bỏ mất mẫu"


def test_guillotine_co_sl_phu_het_mau():
    plan = _guillotine_plan(1000)
    covered = {p['productId'] for t in plan['templates'] for p in t['placements']}
    assert len(covered) == 50
