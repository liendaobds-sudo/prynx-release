"""Chống hồi quy: khổ vừa KHÍT không được mất cột vì sai số đơn vị.

Bug gốc (audit 2026-08-06): tem 500×330mm bình vào tờ 1500×990mm, lề 0, khoảng
cách 0 → đúng 9 con và bản xuất ra 9 con, nhưng preview chỉ vẽ 7. Nguyên nhân:
preview đưa kích thước tem qua vòng pt→mm→pt (0.352778 × 2.83465 ≈ 1.0000021)
nên nở thêm ~0.003pt; ở khổ khít mức nở đó vượt dung sai EPS=0.01pt của solver
→ 3 cột sập còn 2 cột + một ô xoay (L-fill) = 7 con.
"""
import pytest

from app.workers.nup_layout_solver import solve_optimal_layout

MM = 2.83465
_SHEET_W, _SHEET_H = 1500.0 * MM, 990.0 * MM
_ITEM_W, _ITEM_H = 500.0 * MM, 330.0 * MM


def _solve(item_w, item_h, strategy='optimal_auto'):
    return solve_optimal_layout(
        usable_w=_SHEET_W, usable_h=_SHEET_H,
        orig_w=item_w, orig_h=item_h,
        gap_x=0.0, gap_y=0.0, strategy=strategy,
    )


def test_vua_khit_du_9_con():
    r = _solve(_ITEM_W, _ITEM_H)
    assert r['totalItems'] == 9, "khổ vừa khít bị mất cột"


@pytest.mark.parametrize('strategy', [
    'optimal_auto', 'grid', 'rows_first', 'columns_first',
])
def test_moi_strategy_deu_9_con(strategy):
    assert _solve(_ITEM_W, _ITEM_H, strategy)['totalItems'] == 9


def test_lam_tron_2_so_lam_sap_cot__phai_lam_tron_4_so():
    """/document-tools báo kích thước trang đã làm tròn. Làm tròn 2 số biến
    1417.325 → 1417.33, dư 0.005pt/cột và ở khổ khít là mất hẳn một cột.
    Làm tròn 4 số thì an toàn."""
    assert _solve(round(_ITEM_W, 2), round(_ITEM_H, 2))['totalItems'] < 9
    assert _solve(round(_ITEM_W, 4), round(_ITEM_H, 4))['totalItems'] == 9


def test_vong_pt_mm_pt_lam_no_kich_thuoc():
    """Nửa còn lại của lỗi: 0.352778 × 2.83465 > 1 nên vòng đổi pt→mm→pt làm
    NỞ (+0.003pt). Một mình nó chưa vượt EPS=0.01pt, nhưng cộng với làm tròn
    của trang nguồn là đủ sập cột — nên preview vẫn phải dùng pt gốc."""
    assert 0.352778 * MM > 1.0
    grown = _ITEM_W * 0.352778 * MM
    assert 0 < grown - _ITEM_W < 0.01
    # Cộng dồn: làm tròn 2 số RỒI qua vòng mm → sập cột.
    assert _solve(round(_ITEM_W, 2) * 0.352778 * MM,
                  round(_ITEM_H, 2) * 0.352778 * MM)['totalItems'] < 9
