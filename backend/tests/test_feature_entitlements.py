"""Free/Pro entitlement behavior."""
import pytest
import app.core.feature_entitlements as entitlements
from app.core.feature_entitlements import assert_feature, can_use_feature, normalize_plan


def test_gate_off_always_allows():
    assert entitlements.FEATURE_GATING_ENABLED is False
    assert can_use_feature("impo.diecut", "free") is True


def test_gate_on_free_and_pro(monkeypatch):
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)
    assert can_use_feature("pdf.merge", "free") is True
    assert can_use_feature("impo.cnc", "free") is False
    assert can_use_feature("impo.cnc", "free", ["impo.cnc"]) is True
    assert can_use_feature("impo.cnc", "pro") is True
    with pytest.raises(PermissionError):
        assert_feature("impo.cnc", {"plan": "free"})


def test_unknown_feature_fails_closed_when_gate_on(monkeypatch):
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)
    assert can_use_feature("unknown.feature", "free") is False


def test_normalize_plan():
    assert normalize_plan("PROFESSIONAL") == "pro"
    assert normalize_plan("admin") == "dev"
    assert normalize_plan(None) == "free"
