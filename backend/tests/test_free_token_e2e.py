"""Production-style Free-token E2E for Pro sidecar endpoints.

This uses the real FastAPI dependency chain, HMAC request signing, Ed25519
license verification, and feature enforcement. Only the signing trust anchor is
replaced with an ephemeral test key; no production secret is required.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path

import pikepdf
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.core import feature_entitlements as entitlements
from app.core import license_guard as lg
from app.main import app


SIDECAR_TOKEN = "E2E_SIDECAR_TOKEN_4f3c2a"
LICENSE_KEY = "E2E-FREE-00001"
HARDWARE_ID = "E2E-HWID-00001"


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _make_free_token(signing_key: Ed25519PrivateKey) -> str:
    payload = {
        "k": hashlib.sha256(LICENSE_KEY.encode()).hexdigest()[:16],
        "m": HARDWARE_ID,
        "p": "prynx",
        "exp": int(time.time()) + 3600,
        "plan": "free",
        "features": None,
    }
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signature = signing_key.sign(payload_b64.encode("ascii"))
    return f"{payload_b64}.{_b64url(signature)}"


def _headers(path: str, license_token: str) -> dict[str, str]:
    timestamp = str(int(time.time()))
    token_hash = hashlib.sha256(license_token.encode()).hexdigest()
    payload = f"{timestamp}:{path}:{LICENSE_KEY}:{HARDWARE_ID}:{token_hash}"
    signature = hmac.new(
        SIDECAR_TOKEN.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-PrynX-Timestamp": timestamp,
        "X-PrynX-Signature": signature,
        "X-License-Key": LICENSE_KEY,
        "X-Hardware-Id": HARDWARE_ID,
        "X-License-Token": license_token,
    }


@pytest.fixture
def production_free_client(monkeypatch, tmp_path):
    signing_key = Ed25519PrivateKey.generate()
    public_key = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )

    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", SIDECAR_TOKEN)
    monkeypatch.setattr(
        lg,
        "_LICENSE_PUBLIC_KEY_B64",
        base64.b64encode(public_key).decode("ascii"),
    )
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)
    monkeypatch.setenv("PRYNX_CLOCK_GUARD_FILE", str(tmp_path / ".e2e-clock"))
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    lg._license_cache.clear()

    pdf_path = tmp_path / "sample.pdf"
    document = pikepdf.Pdf.new()
    document.add_blank_page(page_size=(100, 100))
    document.save(pdf_path)

    yield TestClient(app), _make_free_token(signing_key), pdf_path
    lg._license_cache.clear()


def _assert_forbidden(response, feature_id: str) -> None:
    assert response.status_code == 403, response.text
    assert feature_id in response.json().get("detail", "")


def test_free_token_cannot_call_pro_sidecar_endpoints(production_free_client):
    client, token, pdf_path = production_free_client
    pdf_bytes = Path(pdf_path).read_bytes()

    # Control: the same signed Free token reaches a Free endpoint. Missing
    # multipart files should fail validation (422), not authorization (403).
    free_path = "/api/pdf-tools/merge"
    free_response = client.post(
        free_path, headers=_headers(free_path, token)
    )
    assert free_response.status_code == 422, free_response.text

    path = "/api/pdf-tools/trim-shift"
    response = client.post(
        path,
        headers=_headers(path, token),
        files={"file": ("sample.pdf", pdf_bytes, "application/pdf")},
        data={"config": "{}"},
    )
    _assert_forbidden(response, "pdf.trim_shift")

    # Nen/toi uu PDF (optimize) da chuyen thanh FREE hoan toan: bo gate
    # pdf.optimize_advanced khoi backend (moi preset + custom + grayscale deu free).
    # Khong con assert 403 cho optimize o day.

    path = "/api/pdf-tools/office-convert/file"
    response = client.post(
        path,
        headers=_headers(path, token),
        data={"batch_mode": "true"},
    )
    _assert_forbidden(response, "pdf.office_batch")

    path = "/api/pdf-tools/office-convert/resize-output"
    response = client.post(
        path,
        headers=_headers(path, token),
        data={
            "target_w": "210",
            "target_h": "297",
            "batch_mode": "true",
        },
    )
    _assert_forbidden(response, "pdf.resize_batch")

    path = "/api/imposition/execute-plan-json"
    response = client.post(path, headers=_headers(path, token), json={})
    _assert_forbidden(response, "impo.booklet")

    cases = [
        ({"imposerMode": "cnc", "isDieCutMode": True}, "impo.cnc"),
        ({"isDieCutMode": True}, "impo.diecut"),
        ({}, "impo.nup"),
    ]
    path = "/api/imposition/impose-start"
    for settings, expected_feature in cases:
        response = client.post(
            path,
            headers=_headers(path, token),
            json={"source_path": str(pdf_path), "settings": settings},
        )
        _assert_forbidden(response, expected_feature)
