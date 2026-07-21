"""Session-wide pytest fixtures for backend tests."""
from __future__ import annotations

import pytest

from tests.license_helpers import PRO_LICENSE, clear_license_override, install_license_override

# Tests that exercise the real license/token path must not get an auto Pro override.
_SKIP_AUTO_PRO = (
    "test_free_token_e2e",
    "test_license_token",
    "test_dieline_feature_gate",
    "test_feature_entitlements",
)


def _node_opts_out_of_auto_pro(nodeid: str) -> bool:
    return any(name in nodeid for name in _SKIP_AUTO_PRO)


@pytest.fixture(autouse=True)
def _auto_pro_license(request):
    """Give most tests a Pro license when feature gating is enabled.

    Module-level ``dependency_overrides`` without ``plan`` previously leaked a
    free context across the whole suite and caused 403s on Pro-only routes.
    """
    if _node_opts_out_of_auto_pro(request.node.nodeid):
        yield
        return

    install_license_override(PRO_LICENSE)
    try:
        yield
    finally:
        clear_license_override()
