import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import feature_entitlements
from app.core.license_guard import require_license
from app.main import app
from app.api.routes import dieline


REQUEST = json.loads((Path(__file__).parents[2] / "native/tests/fixtures/dieline_default_request.json").read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _enable_feature_gate(monkeypatch):
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    yield
    app.dependency_overrides.clear()


def test_free_plan_is_rejected_before_native_engine(monkeypatch):
    called = False

    def should_not_run(*_: str) -> str:
        nonlocal called
        called = True
        return "{}"

    monkeypatch.setattr(dieline, "_generate_native", should_not_run)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "FREE", "hwid": "TEST", "verified": True,
        "plan": "free", "features": [],
    }
    with TestClient(app) as client:
        response = client.post("/api/dieline/generate", json=REQUEST)

    assert response.status_code == 403
    assert called is False


def test_pro_plan_reaches_native_engine(monkeypatch):
    expected = {
        "params": {"boxType": "rte"},
        "dieline": {"panels": []},
        "nestingResult": None,
        "sleeveNestingResult": None,
        "wasClamped": False,
    }
    monkeypatch.setattr(dieline, "_generate_native", lambda *_: json.dumps(expected))
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "PRO", "hwid": "TEST", "verified": True,
        "plan": "pro", "features": [],
    }
    with TestClient(app) as client:
        response = client.post("/api/dieline/generate", json=REQUEST)

    assert response.status_code == 200
    assert response.json() == expected


def test_double_tray_reaches_native_engine(monkeypatch):
    request = json.loads(json.dumps(REQUEST))
    request["params"]["boxType"] = "double_tray"
    expected = {
        "params": {"boxType": "double_tray"},
        "dieline": {"panels": []},
        "nestingResult": None,
        "sleeveNestingResult": None,
        "wasClamped": False,
    }
    monkeypatch.setattr(dieline, "_generate_native", lambda *_: json.dumps(expected))
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "PRO", "hwid": "TEST", "verified": True,
        "plan": "pro", "features": [],
    }
    with TestClient(app) as client:
        response = client.post("/api/dieline/generate", json=request)

    assert response.status_code == 200
    assert response.json() == expected

def test_flip_top_tuck_reaches_native_engine(monkeypatch):
    request = json.loads(json.dumps(REQUEST))
    request["params"]["boxType"] = "flip_top_tuck"
    expected = {
        "params": {"boxType": "flip_top_tuck"},
        "dieline": {"panels": []},
        "nestingResult": None,
        "sleeveNestingResult": None,
        "wasClamped": False,
    }
    monkeypatch.setattr(dieline, "_generate_native", lambda *_: json.dumps(expected))
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "PRO", "hwid": "TEST", "verified": True,
        "plan": "pro", "features": [],
    }
    with TestClient(app) as client:
        response = client.post("/api/dieline/generate", json=request)

    assert response.status_code == 200
    assert response.json() == expected



def test_native_engine_reuses_one_dedicated_worker(monkeypatch):
    expected = {
        "params": {"boxType": "rte"}, "dieline": {}, "nestingResult": None,
        "sleeveNestingResult": None, "wasClamped": False,
    }
    worker_ids: list[int] = []

    def record_worker(*_: str) -> str:
        worker_ids.append(threading.get_ident())
        return json.dumps(expected)

    monkeypatch.setattr(dieline, "_generate_native", record_worker)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "PRO", "hwid": "TEST", "verified": True,
        "plan": "pro", "features": [],
    }
    with TestClient(app) as client:
        assert client.post("/api/dieline/generate", json=REQUEST).status_code == 200
        assert client.post("/api/dieline/generate", json=REQUEST).status_code == 200

    assert len(worker_ids) == 2
    assert len(set(worker_ids)) == 1


def test_custom_free_entitlement_can_use_dieline(monkeypatch):
    expected = {
        "params": {}, "dieline": {}, "nestingResult": None,
        "sleeveNestingResult": None, "wasClamped": False,
    }
    monkeypatch.setattr(dieline, "_generate_native", lambda *_: json.dumps(expected))
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "CUSTOM", "hwid": "TEST", "verified": True,
        "plan": "free", "features": ["packaging.dieline"],
    }
    with TestClient(app) as client:
        response = client.post("/api/dieline/generate", json=REQUEST)

    assert response.status_code == 200


@pytest.mark.parametrize("mutate", [
    lambda request: request["params"].pop("L"),
    lambda request: request["params"].__setitem__("L", float("inf")),
    lambda request: request["params"].__setitem__("boxType", "unknown"),
    lambda request: request["nestingConfig"]["sheet"].__setitem__("width", 1e308),
    lambda request: request.__setitem__("includeNesting", "yes"),
])
def test_invalid_payload_is_rejected_before_native(monkeypatch, mutate):
    request = json.loads(json.dumps(REQUEST))
    mutate(request)
    called = False
    def should_not_run(*_: str) -> str:
        nonlocal called
        called = True
        return "{}"
    monkeypatch.setattr(dieline, "_generate_native", should_not_run)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "PRO", "hwid": "TEST", "license_token": "TOKEN",
        "verified": True, "plan": "pro", "features": [],
    }
    with TestClient(app) as client:
        response = client.post("/api/dieline/generate", json=request)
    assert response.status_code == 422
