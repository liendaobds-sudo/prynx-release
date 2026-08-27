"""Free/Pro entitlement behavior."""
import re
from pathlib import Path

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
    assert can_use_feature("prepress.paper_library", "free") is False
    assert can_use_feature("prepress.paper_library", "pro") is True
    with pytest.raises(PermissionError):
        assert_feature("impo.cnc", {"plan": "free"})


def test_all_22_pro_features_follow_free_custom_and_pro_matrix(monkeypatch):
    """SEC (audit 2026-08-04 §TEST.02): khóa toàn bộ catalog Pro phía backend."""
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)

    # 22 quyền Pro gốc + "impo.mixed_nesting" (Bình lồng ghép tự do, kế hoạch 2026-08-26 §8).
    assert len(entitlements.PRO_FEATURES) == 23
    assert entitlements.FREE_FEATURES.isdisjoint(entitlements.PRO_FEATURES)
    assert set(entitlements.FEATURE_MIN_PLAN) == (
        entitlements.FREE_FEATURES | entitlements.PRO_FEATURES
    )

    for feature_id in entitlements.PRO_FEATURES:
        assert can_use_feature(feature_id, "free") is False
        assert can_use_feature(feature_id, "free", [feature_id]) is True
        assert can_use_feature(feature_id, "free", ["unrelated.feature"]) is False
        assert can_use_feature(feature_id, "pro") is True


def test_backend_entitlement_registries_are_classified_by_catalog():
    """SEC (audit 2026-08-04 §BE.01/§TEST.02): thêm route/action phải phân quyền."""
    from app.api.routes.preflight import (
        _PREFLIGHT_ACTION_FEATURES,
        _PREFLIGHT_ROUTE_FEATURES,
    )
    from app.api.routes.vdp import VDP_EXECUTION_FEATURES
    from app.core.action_engine import AVAILABLE_ACTIONS

    assert set(_PREFLIGHT_ACTION_FEATURES) == set(AVAILABLE_ACTIONS)
    route_features = {
        feature_id
        for feature_id in _PREFLIGHT_ROUTE_FEATURES.values()
        if feature_id is not None
    }
    assert route_features <= set(entitlements.FEATURE_MIN_PLAN)
    assert set(_PREFLIGHT_ACTION_FEATURES.values()) <= entitlements.PRO_FEATURES
    assert VDP_EXECUTION_FEATURES == {
        "vdp.datamerge",
        "vdp.numbering",
        "vdp.cover_numbering",
    }

    assert _PREFLIGHT_ROUTE_FEATURES["/preflight/crop-regions"] == "pdf.crop"
    assert _PREFLIGHT_ROUTE_FEATURES["/preflight/mirror-bleed"] == "prepress.cutline"


def test_frontend_and_backend_feature_catalogs_have_exact_parity():
    """SEC (audit 2026-08-04 §TEST.03): hai catalog phải lệch là fail QA."""
    repo_root = Path(__file__).resolve().parents[2]
    frontend_source = (
        repo_root / "desktop" / "src" / "lib" / "license" / "features.ts"
    ).read_text(encoding="utf-8")
    frontend_catalog = dict(re.findall(
        r"^\s*'([^']+)'\s*:\s*\{\s*minPlan\s*:\s*'(free|pro|dev)'",
        frontend_source,
        flags=re.MULTILINE,
    ))

    assert frontend_catalog == entitlements.FEATURE_MIN_PLAN
    assert entitlements.FEATURE_MIN_PLAN["pdf.crop"] == "free"
    assert entitlements.FEATURE_MIN_PLAN["util.document_cleanup"] == "free"
    # Quyền của Bình lồng ghép tự do phải có mặt ở CẢ hai catalog trong cùng một commit.
    assert entitlements.FEATURE_MIN_PLAN["impo.mixed_nesting"] == "pro"
    assert frontend_catalog["impo.mixed_nesting"] == "pro"
    assert "pdf.optimize_advanced" not in entitlements.FEATURE_MIN_PLAN
    assert "prepress.font_tools" not in entitlements.FEATURE_MIN_PLAN


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
