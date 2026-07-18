"""Phase D scaffold — gate off must not block anything."""
from app.core.feature_entitlements import (
    FEATURE_GATING_ENABLED,
    assert_feature,
    can_use_feature,
    normalize_plan,
)


def test_gate_off_always_allows():
    assert FEATURE_GATING_ENABLED is False
    assert can_use_feature("impo.diecut", "free") is True
    assert can_use_feature("pdf.encrypt", "free") is True
    assert_feature("impo.cnc", {"plan": "free"})  # no raise


def test_normalize_plan():
    assert normalize_plan("PRO") == "pro"
    assert normalize_plan(None) == "free"
