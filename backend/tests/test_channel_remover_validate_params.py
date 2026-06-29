"""Unit tests for ``channel_remover.validate_params`` (task 2.3).

Bao phủ các ví dụ/edge case cụ thể của ``validate_params``:
  - Giữ cả 4 kênh → từ chối (Req 1.3).
  - Bỏ cả 4 kênh / kept rỗng → từ chối (Req 1.4).
  - TAC mặc định = 360 khi không truyền (Req 8.1).
  - spot_handling hợp lệ ("skip" | "convert") và từ chối giá trị sai (Req 7.1).

Feature: channel-remover
"""
import pytest

from app.core.channel_remover import (
    DEFAULT_GAMUT_THRESHOLD,
    DEFAULT_GRID_STEP,
    DEFAULT_MODE,
    DEFAULT_TAC_LIMIT,
    ChannelRemovalParams,
    validate_params,
)


# ---------------------------------------------------------------------------
# Req 1.3 — Giữ cả 4 kênh → từ chối ("không có kênh nào bị gỡ")
# ---------------------------------------------------------------------------

def test_keep_all_four_channels_rejected():
    params = {"kept_channels": ["C", "M", "Y", "K"], "mode": "direct"}
    with pytest.raises(ValueError) as exc:
        validate_params(params)
    # Thông báo nêu rõ không có kênh nào bị gỡ.
    assert "không có kênh nào bị gỡ" in str(exc.value).lower()


def test_keep_all_four_channels_unordered_rejected():
    # Thứ tự/độ trùng lặp không ảnh hưởng: vẫn là đủ 4 kênh → từ chối.
    params = {"kept_channels": ["k", "Y", "m", "C", "C"], "mode": "reseparate"}
    with pytest.raises(ValueError):
        validate_params(params)


# ---------------------------------------------------------------------------
# Req 1.4 — Bỏ cả 4 kênh (kept rỗng) → từ chối ("phải giữ ít nhất một kênh")
# ---------------------------------------------------------------------------

def test_drop_all_channels_empty_list_rejected():
    params = {"kept_channels": [], "mode": "direct"}
    with pytest.raises(ValueError) as exc:
        validate_params(params)
    assert "ít nhất một kênh" in str(exc.value).lower()


def test_missing_kept_channels_rejected():
    # Thiếu hẳn tham số kept_channels cũng là "bỏ cả 4" → từ chối.
    with pytest.raises(ValueError):
        validate_params({"mode": "direct"})


# ---------------------------------------------------------------------------
# Req 1.2 — Chấp nhận tập 1..3 phần tử
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "kept",
    [
        ["C"],
        ["C", "M"],
        ["C", "M", "K"],
        ["K", "Y", "M"],  # thứ tự bất kỳ
    ],
)
def test_accepts_one_to_three_channels(kept):
    result = validate_params({"kept_channels": kept, "mode": "direct"})
    assert isinstance(result, ChannelRemovalParams)
    assert set(result.kept_channels) == {c.upper() for c in kept}
    assert 1 <= len(result.kept_channels) <= 3


def test_kept_channels_accepts_comma_string():
    # Chuỗi phân tách bằng dấu phẩy cũng được chấp nhận.
    result = validate_params({"kept_channels": "C,M,K", "mode": "direct"})
    assert set(result.kept_channels) == {"C", "M", "K"}


# ---------------------------------------------------------------------------
# Req 8.1 — TAC mặc định 360 khi không truyền tac_limit
# ---------------------------------------------------------------------------

def test_default_tac_limit_is_360():
    result = validate_params({"kept_channels": ["C", "M", "K"], "mode": "direct"})
    assert result.tac_limit == DEFAULT_TAC_LIMIT == 360.0


def test_explicit_tac_limit_is_respected():
    result = validate_params(
        {"kept_channels": ["C", "K"], "mode": "direct", "tac_limit": 320}
    )
    assert result.tac_limit == 320.0


def test_default_gamut_threshold_and_grid_step():
    # Các mặc định khác cũng được áp khi không truyền.
    result = validate_params({"kept_channels": ["C"], "mode": "reseparate"})
    assert result.gamut_threshold == DEFAULT_GAMUT_THRESHOLD == 5.0
    assert result.grid_step == DEFAULT_GRID_STEP


# ---------------------------------------------------------------------------
# Req 7.1 — spot_handling hợp lệ ("skip" | "convert"); mặc định "skip"
# ---------------------------------------------------------------------------

def test_spot_handling_defaults_to_skip():
    result = validate_params({"kept_channels": ["C", "M"], "mode": "direct"})
    assert result.spot_handling == "skip"


@pytest.mark.parametrize("spot", ["skip", "convert", "SKIP", "Convert"])
def test_spot_handling_valid_values_accepted(spot):
    result = validate_params(
        {"kept_channels": ["C", "M"], "mode": "direct", "spot_handling": spot}
    )
    assert result.spot_handling == spot.strip().lower()


def test_spot_handling_invalid_value_rejected():
    with pytest.raises(ValueError) as exc:
        validate_params(
            {"kept_channels": ["C"], "mode": "direct", "spot_handling": "bogus"}
        )
    assert "màu pha" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# Bổ sung: mode mặc định + mode không hợp lệ
# ---------------------------------------------------------------------------

def test_mode_defaults_when_missing():
    result = validate_params({"kept_channels": ["C", "M"]})
    assert result.mode == DEFAULT_MODE


def test_invalid_mode_rejected():
    with pytest.raises(ValueError):
        validate_params({"kept_channels": ["C"], "mode": "nope"})
