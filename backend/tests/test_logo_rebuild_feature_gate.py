"""Hồi quy quyền Pro cho API Phục hồi & Vector hóa Logo."""

from fastapi.testclient import TestClient

from app.core import feature_entitlements
from app.core.license_guard import require_license
from app.main import app


def _license(plan: str, features: list[str] | None = None) -> dict:
    return {
        "license_key": plan.upper(),
        "hwid": "TEST",
        "verified": True,
        "plan": plan,
        "features": features or [],
    }


def test_free_plan_is_rejected_before_capability_probe(monkeypatch):
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: _license("free")
    try:
        with TestClient(app) as client:
            response = client.get("/api/logo-rebuild/capabilities")
    finally:
        app.dependency_overrides.pop(require_license, None)

    assert response.status_code == 403
    assert "util.logo_rebuild" in response.json()["detail"]


def test_pro_plan_can_read_capabilities(monkeypatch):
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: _license("pro")
    try:
        with TestClient(app) as client:
            response = client.get("/api/logo-rebuild/capabilities")
    finally:
        app.dependency_overrides.pop(require_license, None)

    assert response.status_code == 200, response.text
    assert response.json()["modes"] == ["monochrome", "fixed_palette"]
