"""Hồi quy quyền Pro cho API Phục hồi & Vector hóa Logo."""

from fastapi.testclient import TestClient

from app.api.routes import logo_rebuild as logo_route
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


def _set_runtime(
    monkeypatch,
    *,
    is_development: bool,
    is_compiled: bool,
    release_enabled: bool,
) -> None:
    monkeypatch.setattr(logo_route.settings, "DEV_MODE", is_development)
    monkeypatch.setattr(logo_route.sys, "frozen", is_compiled, raising=False)
    monkeypatch.setenv(
        "PRYNX_LOGO_REBUILD_ENABLED",
        "true" if release_enabled else "false",
    )


def test_pro_plan_is_rejected_while_release_is_on_hold(monkeypatch):
    _set_runtime(
        monkeypatch,
        is_development=False,
        is_compiled=True,
        release_enabled=False,
    )
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    monkeypatch.setattr(
        logo_route,
        "logo_vectorizer_capabilities",
        lambda: (_ for _ in ()).throw(AssertionError("Không được dò engine khi đang HOLD")),
    )
    app.dependency_overrides[require_license] = lambda: _license("pro")
    try:
        with TestClient(app) as client:
            response = client.get("/api/logo-rebuild/capabilities")
    finally:
        app.dependency_overrides.pop(require_license, None)

    assert response.status_code == 404
    assert "chưa được mở" in response.json()["detail"]


def test_interpreted_dev_can_read_capabilities(monkeypatch):
    _set_runtime(
        monkeypatch,
        is_development=True,
        is_compiled=False,
        release_enabled=False,
    )
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: _license("pro")
    try:
        with TestClient(app) as client:
            response = client.get("/api/logo-rebuild/capabilities")
    finally:
        app.dependency_overrides.pop(require_license, None)

    assert response.status_code == 200, response.text
    assert response.json()["modes"] == ["monochrome", "fixed_palette"]


def test_explicit_release_flag_still_requires_pro_plan(monkeypatch):
    _set_runtime(
        monkeypatch,
        is_development=False,
        is_compiled=True,
        release_enabled=True,
    )
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: _license("free")
    try:
        with TestClient(app) as client:
            response = client.get("/api/logo-rebuild/capabilities")
    finally:
        app.dependency_overrides.pop(require_license, None)

    assert response.status_code == 403
    assert "util.logo_rebuild" in response.json()["detail"]


def test_explicit_release_flag_allows_pro_plan(monkeypatch):
    _set_runtime(
        monkeypatch,
        is_development=False,
        is_compiled=True,
        release_enabled=True,
    )
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: _license("pro")
    try:
        with TestClient(app) as client:
            response = client.get("/api/logo-rebuild/capabilities")
    finally:
        app.dependency_overrides.pop(require_license, None)

    assert response.status_code == 200, response.text
