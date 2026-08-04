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
import uuid
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


def _make_token(
    signing_key: Ed25519PrivateKey,
    *,
    plan: str = "free",
    features: list[str] | None = None,
) -> str:
    payload = {
        "k": hashlib.sha256(LICENSE_KEY.encode()).hexdigest()[:16],
        "m": HARDWARE_ID,
        "p": "prynx",
        "exp": int(time.time()) + 3600,
        "plan": plan,
        "features": features,
    }
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signature = signing_key.sign(payload_b64.encode("ascii"))
    return f"{payload_b64}.{_b64url(signature)}"


def _headers(path: str, license_token: str, method: str = "POST") -> dict[str, str]:
    """Dựng bộ header y như Rust `sign_api_request`.

    Nonce mới cho MỖI request (dùng-một-lần phía sidecar, audit 2026-07-25).
    """
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    token_hash = hashlib.sha256(license_token.encode()).hexdigest()
    payload = f"{timestamp}:{nonce}:{method}:{path}:{LICENSE_KEY}:{HARDWARE_ID}:{token_hash}"
    signature = hmac.new(
        SIDECAR_TOKEN.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-PrynX-Timestamp": timestamp,
        "X-PrynX-Nonce": nonce,
        "X-PrynX-Signature": signature,
        "X-License-Key": LICENSE_KEY,
        "X-Hardware-Id": HARDWARE_ID,
        "X-License-Token": license_token,
    }


@pytest.fixture
def production_entitlement_client(monkeypatch, tmp_path):
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

    def issue_token(*, plan: str = "free", features: list[str] | None = None) -> str:
        return _make_token(signing_key, plan=plan, features=features)

    yield TestClient(app), issue_token, pdf_path
    lg._license_cache.clear()


@pytest.fixture
def production_free_client(production_entitlement_client):
    client, issue_token, pdf_path = production_entitlement_client
    yield client, issue_token(), pdf_path


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

    # Crop được chốt là Free: request thiếu body phải đi qua entitlement rồi mới
    # dừng ở validation (422), tuyệt đối không bị router Preflight chặn 403.
    crop_path = "/api/preflight/crop-regions"
    crop_response = client.post(
        crop_path,
        headers=_headers(crop_path, token),
        json={},
    )
    assert crop_response.status_code == 422, crop_response.text

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


@pytest.mark.parametrize(
    ("feature_id", "expected_status"),
    [
        ("vdp.datamerge", 400),
        ("vdp.numbering", 400),
        ("vdp.cover_numbering", 400),
    ],
)
def test_signed_custom_vdp_grant_reaches_only_its_execution_capability(
    production_entitlement_client,
    feature_id,
    expected_status,
):
    client, issue_token, _pdf_path = production_entitlement_client
    token = issue_token(features=[feature_id])
    path = "/api/vdp/generate"

    # SEC (audit 2026-08-04 §BE.01/§TEST.02): request đúng grant phải qua
    # entitlement rồi mới dừng ở validation vì fixture cố ý không gửi template.
    exact = client.post(
        path,
        headers=_headers(path, token),
        data={"feature_id": feature_id, "fields": "[]"},
        files={"data_file": ("rows.json", b"[]", "application/json")},
    )
    assert exact.status_code == expected_status, exact.text

    pro_token = issue_token(plan="pro")
    pro = client.post(
        path,
        headers=_headers(path, pro_token),
        data={"feature_id": feature_id, "fields": "[]"},
        files={"data_file": ("rows.json", b"[]", "application/json")},
    )
    assert pro.status_code == expected_status, pro.text

    sibling = next(
        candidate
        for candidate in ("vdp.datamerge", "vdp.numbering", "vdp.cover_numbering")
        if candidate != feature_id
    )
    denied = client.post(
        path,
        headers=_headers(path, token),
        data={"feature_id": sibling, "fields": "[]"},
        files={"data_file": ("rows.json", b"[]", "application/json")},
    )
    _assert_forbidden(denied, sibling)


def test_signed_vdp_execution_rejects_free_and_unknown_capability(
    production_entitlement_client,
):
    client, issue_token, _pdf_path = production_entitlement_client
    path = "/api/vdp/generate"

    free_token = issue_token()
    denied = client.post(
        path,
        headers=_headers(path, free_token),
        data={"feature_id": "vdp.numbering", "fields": "[]"},
        files={"data_file": ("rows.json", b"[]", "application/json")},
    )
    _assert_forbidden(denied, "vdp.numbering")

    pro_token = issue_token(plan="pro")
    unknown = client.post(
        path,
        headers=_headers(path, pro_token),
        data={"feature_id": "pdf.merge", "fields": "[]"},
        files={"data_file": ("rows.json", b"[]", "application/json")},
    )
    assert unknown.status_code == 400, unknown.text


def test_signed_vdp_helpers_do_not_restore_datamerge_parent_gate(
    production_entitlement_client,
):
    client, issue_token, _pdf_path = production_entitlement_client

    datasource_path = "/api/vdp/datasource"
    datamerge_token = issue_token(features=["vdp.datamerge"])
    exact = client.post(
        datasource_path,
        headers=_headers(datasource_path, datamerge_token),
    )
    assert exact.status_code == 422, exact.text

    numbering_token = issue_token(features=["vdp.numbering"])
    denied = client.post(
        datasource_path,
        headers=_headers(datasource_path, numbering_token),
    )
    _assert_forbidden(denied, "vdp.datamerge")

    # Status/download/cancel phụ thuộc job: chỉ xác thực license, capability đã
    # được khóa ở /generate. Grant Numbering không được vướng gate Datamerge cũ.
    status_path = "/api/vdp/status/missing-job"
    status = client.get(
        status_path,
        headers=_headers(status_path, numbering_token, method="GET"),
    )
    assert status.status_code == 404, status.text


@pytest.mark.parametrize(
    ("path", "feature_id"),
    [
        ("/api/preflight/inspect", "prepress.preflight"),
        ("/api/preflight/fix-hairlines", "prepress.hairlines"),
        ("/api/preflight/convert-colors", "prepress.convert_colors"),
        ("/api/preflight/set-overprint", "prepress.trapping"),
        ("/api/preflight/export-pdfx", "prepress.pdfx"),
        ("/api/preflight/mirror-bleed", "prepress.cutline"),
    ],
)
def test_signed_custom_preflight_grant_reaches_exact_route_only(
    production_entitlement_client,
    path,
    feature_id,
):
    client, issue_token, _pdf_path = production_entitlement_client
    token = issue_token(features=[feature_id])

    exact = client.post(path, headers=_headers(path, token))
    assert exact.status_code == 422, exact.text

    pro_token = issue_token(plan="pro")
    pro = client.post(path, headers=_headers(path, pro_token))
    assert pro.status_code == 422, pro.text

    sibling_path = "/api/preflight/fix-hairlines"
    sibling_feature = "prepress.hairlines"
    if feature_id == sibling_feature:
        sibling_path = "/api/preflight/set-overprint"
        sibling_feature = "prepress.trapping"
    denied = client.post(sibling_path, headers=_headers(sibling_path, token))
    _assert_forbidden(denied, sibling_feature)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/preflight/page-boxes/missing-file/1"),
        ("POST", "/api/preflight/set-page-boxes"),
        ("POST", "/api/preflight/detect-crop-regions"),
        ("POST", "/api/preflight/crop-regions"),
        ("POST", "/api/preflight/auto-trim"),
    ],
)
def test_signed_free_token_reaches_every_crop_route(
    production_free_client,
    method,
    path,
):
    client, token, _pdf_path = production_free_client
    response = client.request(method, path, headers=_headers(path, token, method=method))
    # Thiếu body/file dừng ở validation/not-found sau entitlement; 403 ở đây
    # nghĩa là một route Crop Free vừa trượt lại về gate Preflight Pro.
    assert response.status_code in {404, 422}, response.text


@pytest.mark.parametrize(
    ("action_id", "feature_id"),
    [
        ("OUTLINE_FONTS", "prepress.preflight"),
        ("EMBED_FONTS", "prepress.preflight"),
        ("FIX_HAIRLINES", "prepress.hairlines"),
        ("SET_BLACK_OVERPRINT", "prepress.trapping"),
        ("CONVERT_TO_CMYK", "prepress.convert_colors"),
        ("REMOVE_CHANNELS", "prepress.convert_colors"),
    ],
)
def test_signed_dynamic_preflight_action_requires_exact_capability(
    production_entitlement_client,
    action_id,
    feature_id,
):
    client, issue_token, _pdf_path = production_entitlement_client
    path = "/api/preflight/fix"
    body = {"file_id": "missing-file", "action_id": action_id, "params": {}}

    exact_token = issue_token(features=[feature_id])
    exact = client.post(path, headers=_headers(path, exact_token), json=body)
    assert exact.status_code == 404, exact.text

    pro_token = issue_token(plan="pro")
    pro = client.post(path, headers=_headers(path, pro_token), json=body)
    assert pro.status_code == 404, pro.text

    wrong_feature = (
        "prepress.preflight"
        if feature_id != "prepress.preflight"
        else "prepress.hairlines"
    )
    wrong_token = issue_token(features=[wrong_feature])
    denied = client.post(path, headers=_headers(path, wrong_token), json=body)
    _assert_forbidden(denied, feature_id)


def test_signed_preflight_pipeline_requires_every_action_capability(
    production_entitlement_client,
):
    client, issue_token, _pdf_path = production_entitlement_client
    path = "/api/preflight/pipeline"
    body = {
        "file_id": "missing-file",
        "actions": [
            {"id": "FIX_METADATA", "params": {}},
            {"id": "FIX_HAIRLINES", "params": {}},
        ],
    }

    parent_only = issue_token(features=["prepress.preflight"])
    denied = client.post(path, headers=_headers(path, parent_only), json=body)
    _assert_forbidden(denied, "prepress.hairlines")

    exact = issue_token(features=["prepress.preflight", "prepress.hairlines"])
    allowed = client.post(path, headers=_headers(path, exact), json=body)
    assert allowed.status_code == 404, allowed.text

    pro_token = issue_token(plan="pro")
    pro = client.post(path, headers=_headers(path, pro_token), json=body)
    assert pro.status_code == 404, pro.text
