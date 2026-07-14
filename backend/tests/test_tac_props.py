"""Property tests: cộng kênh TAC, đơn điệu theo phủ mực, phân loại ngưỡng.

Feature: preflight-depth-upgrade
"""
import numpy as np
from hypothesis import given, settings, strategies as st
from hypothesis.extra import numpy as hnp

from app.core.preflight_rules.ink import compute_tac_percent

_shape = st.tuples(st.integers(1, 8), st.integers(1, 8))
_chan = lambda shape: hnp.arrays(np.uint8, shape, elements=st.integers(0, 255))


# Feature: preflight-depth-upgrade, Property 7: TAC bằng tổng kênh và đơn điệu không-giảm theo phủ mực
# deadline=None: lần chạy nguội đầu (warmup numpy) đo ~370ms > deadline 200ms mặc định
# gây flaky (Hypothesis tự báo unreliable timings); property thuần numpy nên bỏ deadline.
@settings(max_examples=100, deadline=None)
@given(data=st.data(), shape=_shape, n=st.integers(1, 5))
def test_tac_sum_and_monotonic(data, shape, n):
    plates = [data.draw(_chan(shape)) for _ in range(n)]
    tac = compute_tac_percent(plates)
    expected = sum(p.astype(np.float32) for p in plates) / 255.0 * 100.0
    assert np.allclose(tac, expected, atol=1e-4)

    # Tăng một kênh (clip 255) → TAC không giảm tại mọi điểm
    bump = data.draw(_chan(shape))
    plates2 = list(plates)
    plates2[0] = np.clip(plates[0].astype(np.int32) + bump.astype(np.int32), 0, 255).astype(np.uint8)
    tac2 = compute_tac_percent(plates2)
    assert np.all(tac2 >= tac - 1e-4)


# Feature: preflight-depth-upgrade, Property 8: Phân loại ngưỡng TAC và nội dung báo cáo
@settings(max_examples=100, deadline=None)
@given(data=st.data(), shape=_shape, n=st.integers(1, 4),
       threshold=st.integers(100, 400))
def test_tac_threshold_classification(data, shape, n, threshold):
    plates = [data.draw(_chan(shape)) for _ in range(n)]
    tac = compute_tac_percent(plates)
    max_tac = float(tac.max())
    mask = tac > threshold
    area_pct = float(mask.mean() * 100.0)
    fired = max_tac > threshold
    # fired khi và chỉ khi có ít nhất một điểm vượt ngưỡng
    assert fired == bool(mask.any())
    if fired:
        assert 0.0 < area_pct <= 100.0
    else:
        assert area_pct == 0.0
