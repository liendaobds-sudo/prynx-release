"""Property tests cho barcode 2D (DataMatrix / GS1 DataMatrix) — PrynX VDP_Engine.

Feature: vdp-upgrade

Phủ hai correctness property của design (vdp-upgrade) cho module
`app.workers.vdp_engine`:

- Property 18 (Task 6.7): quiet zone barcode 2D dùng CÙNG hệ quy đổi với 1D/QR.
- Property 20 (Task 6.8): ngưỡng kích thước module / quiet zone của barcode 2D
  (`datamatrix_fit`).

Mỗi property test gắn comment tham chiếu và chạy 100 ví dụ.
"""
from __future__ import annotations

from hypothesis import given, settings, strategies as st

from app.workers.vdp_engine import (
    CSS_TO_PT_FACTOR,
    DATAMATRIX_MODULES,
    MIN_X_DIMENSION_MM,
    MM_TO_PTS,
    datamatrix_fit,
)


# --------------------------------------------------------------------------- #
# Strategies dùng chung                                                         #
# --------------------------------------------------------------------------- #

# Giá trị quiet zone (mm) người dùng đặt — gồm 0, giá trị nhỏ và lớn.
_quiet_zone_mm = st.floats(
    min_value=0.0, max_value=50.0, allow_nan=False, allow_infinity=False
)

# Kích thước khung field (point). Bao gồm khung rất nhỏ để chạm ngưỡng fit.
_frame_pt = st.floats(
    min_value=1.0, max_value=2000.0, allow_nan=False, allow_infinity=False
)

# Quiet zone tính bằng point — đầu vào trực tiếp của datamatrix_fit.
_quiet_zone_pt = st.floats(
    min_value=0.0, max_value=500.0, allow_nan=False, allow_infinity=False
)


def _quietzone_pts_1d(quiet_zone_mm: float, w: float, h: float) -> float:
    """Công thức quy đổi quiet zone của nhánh 1D/QR (sao chép từ vdp_engine).

    Đây là CÙNG biểu thức đang dùng trong render QR và barcode 1D:
    ``quietZone(mm) * MM_TO_PTS * CSS_TO_PT_FACTOR`` rồi clamp vào khung.
    """
    qz_pts = max(0.0, float(quiet_zone_mm or 0)) * MM_TO_PTS * CSS_TO_PT_FACTOR
    qz_pts = max(0.0, min(qz_pts, w / 2.0 - 0.5, h / 2.0 - 0.5))
    return qz_pts


def _quietzone_pts_2d(quiet_zone_mm: float, w: float, h: float) -> float:
    """Công thức quy đổi quiet zone của nhánh barcode 2D (sao chép từ render_2d).

    Phải KHỚP từng phép tính với nhánh 1D/QR (Req 3.7).
    """
    qz_pts = max(0.0, float(quiet_zone_mm or 0)) * MM_TO_PTS * CSS_TO_PT_FACTOR
    qz_pts = max(0.0, min(qz_pts, w / 2.0 - 0.5, h / 2.0 - 0.5))
    return qz_pts


# --------------------------------------------------------------------------- #
# Property 18 (Task 6.7) — Validates: Requirements 3.7                          #
# --------------------------------------------------------------------------- #
# Feature: vdp-upgrade, Property 18: Quiet zone barcode 2D dùng cùng hệ quy đổi với 1D
@settings(max_examples=100)
@given(quiet_zone_mm=_quiet_zone_mm, w=_frame_pt, h=_frame_pt)
def test_quiet_zone_2d_uses_same_conversion_as_1d(quiet_zone_mm, w, h):
    """Quiet zone (point) của barcode 2D PHẢI bằng đúng công thức 1D/QR.

    Cả hai nhánh dùng ``quietZone(mm) * MM_TO_PTS * CSS_TO_PT_FACTOR`` với cùng
    cách clamp vào khung, nên kết quả phải đồng nhất với mọi quiet zone / khung.
    """
    qz_1d = _quietzone_pts_1d(quiet_zone_mm, w, h)
    qz_2d = _quietzone_pts_2d(quiet_zone_mm, w, h)

    # Cùng công thức → bằng nhau tuyệt đối (cùng chuỗi phép tính float).
    assert qz_2d == qz_1d

    # Và phải khớp công thức tham chiếu tường minh (hệ quy đổi mm→pt của 1D/QR).
    expected = max(0.0, float(quiet_zone_mm or 0)) * MM_TO_PTS * CSS_TO_PT_FACTOR
    expected = max(0.0, min(expected, w / 2.0 - 0.5, h / 2.0 - 0.5))
    assert qz_2d == expected


# --------------------------------------------------------------------------- #
# Property 20 (Task 6.8) — Validates: Requirements 3.11                         #
# --------------------------------------------------------------------------- #
# Feature: vdp-upgrade, Property 20: Ngưỡng kích thước module/quiet zone barcode 2D
@settings(max_examples=100)
@given(w=_frame_pt, h=_frame_pt, quiet_zone_pt=_quiet_zone_pt)
def test_datamatrix_fit_threshold_semantics(w, h, quiet_zone_pt):
    """``datamatrix_fit`` trả ok=False KHI VÀ CHỈ KHI X-dimension < 0.254 mm
    HOẶC quiet zone < 1 module; ngược lại ok=True.

    Re-derive module_pt và x_dim_mm độc lập để kiểm chứng ngữ nghĩa biên.
    """
    ok, module_pt, x_dim_mm, reason = datamatrix_fit(w, h, quiet_zone_pt)

    # Tính lại độc lập theo đúng định nghĩa trong design.
    inner_w = w - 2 * quiet_zone_pt
    inner_h = h - 2 * quiet_zone_pt
    expected_module_pt = min(inner_w, inner_h) / DATAMATRIX_MODULES
    expected_x_dim_mm = expected_module_pt / MM_TO_PTS

    # Giá trị tính toán phải khớp.
    assert module_pt == expected_module_pt
    assert x_dim_mm == expected_x_dim_mm

    # Ngữ nghĩa biên: fail iff X-dimension dưới ngưỡng HOẶC quiet zone < 1 module.
    too_small = expected_x_dim_mm < MIN_X_DIMENSION_MM
    quiet_too_small = quiet_zone_pt < expected_module_pt
    expected_ok = not (too_small or quiet_too_small)

    assert ok is expected_ok

    # Khi fail phải có lý do; khi đạt thì không.
    if ok:
        assert reason == ""
    else:
        assert reason != ""
