"""Shared license fixtures for backend tests under Free/Pro feature gating.

Production QA runs with PRYNX_FEATURE_GATING_ENABLED=true. Tests must inject a
Pro (or free) license context instead of relying on DEV_MODE alone — module-level
dependency_overrides without a plan default to free and pollute the suite.
"""
from __future__ import annotations

from typing import Any

PRO_LICENSE: dict[str, Any] = {
    "license_key": "TEST-PRO",
    "hwid": "TEST-HWID",
    "verified": True,
    "plan": "pro",
    "features": ["*"],
}

FREE_LICENSE: dict[str, Any] = {
    "license_key": "TEST-FREE",
    "hwid": "TEST-HWID",
    "verified": True,
    "plan": "free",
    "features": [],
}

DEV_LICENSE: dict[str, Any] = {
    "license_key": "DEV_MODE",
    "hwid": "DEV_MODE",
    "verified": False,
    "plan": "dev",
    "features": ["*"],
}


def install_license_override(license_info: dict[str, Any] | None = None) -> None:
    """Override FastAPI ``require_license`` (and thus ``require_feature``)."""
    from app.core.license_guard import require_license
    from app.main import app

    info = license_info if license_info is not None else PRO_LICENSE
    app.dependency_overrides[require_license] = lambda: info


def clear_license_override() -> None:
    from app.core.license_guard import require_license
    from app.main import app

    app.dependency_overrides.pop(require_license, None)
