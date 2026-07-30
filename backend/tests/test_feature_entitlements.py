"""Free/Pro entitlement behavior."""
import pytest
import app.core.feature_entitlements as entitlements
from app.core.feature_entitlements import assert_feature, can_use_feature, normalize_plan


def test_gate_off_always_allows(monkeypatch):
    # Gate may be forced on during production QA (PRYNX_FEATURE_GATING_ENABLED=true);
    # this unit test verifies the off-path regardless of process env.
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", False)
    assert can_use_feature("impo.diecut", "free") is True


def test_gate_on_free_and_pro(monkeypatch):
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)
    assert can_use_feature("pdf.merge", "free") is True
    assert can_use_feature("impo.cnc", "free") is False
    assert can_use_feature("impo.cnc", "free", ["impo.cnc"]) is True
    assert can_use_feature("impo.cnc", "pro") is True
    assert can_use_feature("util.logo_rebuild", "free") is False
    assert can_use_feature("util.logo_rebuild", "free", ["util.logo_rebuild"]) is True
    assert can_use_feature("util.logo_rebuild", "pro") is True
    with pytest.raises(PermissionError):
        assert_feature("impo.cnc", {"plan": "free"})


def test_unknown_feature_fails_closed_when_gate_on(monkeypatch):
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)
    assert can_use_feature("unknown.feature", "free") is False


def test_normalize_plan():
    assert normalize_plan("PROFESSIONAL") == "pro"
    assert normalize_plan("admin") == "dev"
    assert normalize_plan(None) == "free"


def test_compiled_sidecar_forces_gate_on(monkeypatch):
    monkeypatch.setattr(entitlements.sys, "frozen", True, raising=False)
    monkeypatch.setenv("PRYNX_FEATURE_GATING_ENABLED", "false")
    assert entitlements._feature_gating_enabled() is True
