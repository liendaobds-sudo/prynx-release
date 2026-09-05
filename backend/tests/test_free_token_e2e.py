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
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
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

_BODY_CHUNK_BYTES = 1024 * 1024
_CHUNK_LEAF_DOMAIN = b"prynx-body-chunk-leaf-v1\0"
_CHUNK_ROOT_DOMAIN = b"prynx-body-chunk-root-v1\0"
_BODY_NONE_DOMAIN = b"prynx-body-none-v1\0"
_FORM_TEXT_DOMAIN = b"prynx-body-form-text-v1\0"
_FORM_FILE_PART_DOMAIN = b"prynx-body-form-file-part-v1\0"
_FORM_ROOT_DOMAIN = b"prynx-body-form-root-v1\0"


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _make_token(
    signing_key: Ed25519PrivateKey,
    *,
    plan: str = "free",
    features: list[str] | None = None,
) -> str:
    issued_at = int(time.time())
    payload = {
        "k": hashlib.sha256(LICENSE_KEY.encode()).hexdigest()[:16],
        "m": HARDWARE_ID,
        "p": "prynx",
        "exp": issued_at + 3600,
        # SEC (audit 2026-09-04 §SEC.16-A0.1): fixture production phải
        # dùng protocol v2; v1 đã sunset tại mọi authority của PrynX.
        "v": 2,
        "iat": issued_at,
        "challenge": "a" * 64,
        "plan": plan,
        "features": features,
    }
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signature = signing_key.sign(payload_b64.encode("ascii"))
    return f"{payload_b64}.{_b64url(signature)}"


def _u64(value: int) -> bytes:
    return value.to_bytes(8, "big")


def _framed(value: bytes) -> bytes:
    return _u64(len(value)) + value


def _chunk_commitment(value: bytes, source_domain: str) -> bytes:
    domain = source_domain.encode("utf-8")
    leaves: list[bytes] = []
    for index, offset in enumerate(range(0, len(value), _BODY_CHUNK_BYTES)):
        chunk = value[offset : offset + _BODY_CHUNK_BYTES]
        leaves.append(
            hashlib.sha256(
                _CHUNK_LEAF_DOMAIN
                + _framed(domain)
                + _u64(index)
                + _u64(len(chunk))
                + chunk
            ).digest()
        )
    return hashlib.sha256(
        _CHUNK_ROOT_DOMAIN
        + _framed(domain)
        + _u64(len(value))
        + _u64(len(leaves))
        + b"".join(leaves)
    ).digest()


def _normalize_form_text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")


def _form_commitment(
    entries: list[tuple[str, str | tuple[str, str, bytes]]],
) -> str:
    parts: list[bytes] = []
    for name, value in entries:
        name_bytes = name.encode("utf-8")
        if isinstance(value, str):
            parts.append(
                hashlib.sha256(
                    _FORM_TEXT_DOMAIN
                    + _framed(name_bytes)
                    + _framed(_normalize_form_text(value).encode("utf-8"))
                ).digest()
            )
            continue

        filename, content_type, file_bytes = value
        file_commitment = _chunk_commitment(file_bytes, "form-file")
        parts.append(
            hashlib.sha256(
                _FORM_FILE_PART_DOMAIN
                + _framed(name_bytes)
                + _framed(filename.encode("utf-8"))
                + _framed(content_type.encode("utf-8"))
                + _u64(len(file_bytes))
                + _framed(file_commitment)
            ).digest()
        )
    return hashlib.sha256(
        _FORM_ROOT_DOMAIN + _u64(len(parts)) + b"".join(parts)
    ).hexdigest()


def _multipart_entries(
    body: bytes,
    content_type: str,
) -> list[tuple[str, str | tuple[str, str, bytes]]]:
    envelope = (
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
        + body
    )
    message = BytesParser(policy=policy.default).parsebytes(envelope)
    if not message.is_multipart():
        raise AssertionError("Fixture multipart không parse được")

    entries: list[tuple[str, str | tuple[str, str, bytes]]] = []
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not isinstance(name, str):
            raise AssertionError("Multipart fixture thiếu tên field")
        value = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        if filename is None:
            entries.append((name, value.decode("utf-8")))
        else:
            content_type_value = part.get("content-type") or "application/octet-stream"
            entries.append((name, (filename, content_type_value, value)))
    return entries


def _prepared_body_binding(request: httpx.Request) -> tuple[str, str, str]:
    """Tính binding độc lập sau khi httpx đã serialize đúng body gửi qua ASGI."""
    body = request.read()
    content_type = request.headers.get("content-type", "").strip()
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "multipart/form-data":
        commitment = _form_commitment(_multipart_entries(body, content_type))
        return "form-v1", commitment, content_type
    if media_type == "application/x-www-form-urlencoded":
        entries = [
            (name, value)
            for name, value in parse_qsl(
                body.decode("utf-8"),
                keep_blank_values=True,
            )
        ]
        return "form-v1", _form_commitment(entries), content_type
    if body or content_type:
        return "raw-v1", _chunk_commitment(body, "http-body").hex(), content_type
    return "none", hashlib.sha256(_BODY_NONE_DOMAIN).hexdigest(), content_type


def _signed_v2_headers(
    path: str,
    license_token: str,
    method: str,
    body_mode: str,
    body_commitment: str,
    content_type: str,
) -> dict[str, str]:
    """Dựng canonical v2 như native signer, không gọi implementation backend."""
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    token_hash = hashlib.sha256(license_token.encode()).hexdigest()
    values = (
        timestamp,
        nonce,
        method.upper(),
        path,
        LICENSE_KEY,
        HARDWARE_ID,
        token_hash,
        body_mode,
        body_commitment,
        content_type,
    )
    payload = b"prynx-request-v2\0" + b"".join(
        _framed(value.encode("utf-8")) for value in values
    )
    signature = hmac.new(
        SIDECAR_TOKEN.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-PrynX-Timestamp": timestamp,
        "X-PrynX-Nonce": nonce,
        "X-PrynX-Signature": signature,
        "X-License-Key": LICENSE_KEY,
        "X-Hardware-Id": HARDWARE_ID,
        "X-License-Token": license_token,
        "X-PrynX-Signature-Version": "2",
        "X-PrynX-Body-Mode": body_mode,
        "X-PrynX-Body-Commitment": body_commitment,
    }


def _sign_prepared_request(request: httpx.Request) -> None:
    # Các ca mutation/downgrade tự dựng proof cố ý; không ghi đè proof đó.
    if request.headers.get("X-PrynX-Signature"):
        return
    license_token = request.headers.get("X-License-Token", "")
    if not license_token:
        return
    body_mode, body_commitment, content_type = _prepared_body_binding(request)
    path = request.url.raw_path.decode("ascii")
    request.headers.update(
        _signed_v2_headers(
            path,
            license_token,
            request.method,
            body_mode,
            body_commitment,
            content_type,
        )
    )


def _headers(path: str, license_token: str, method: str = "POST") -> dict[str, str]:
    """Credential fixture; request hook ký v2 sau khi body được serialize."""
    del path, method
    return {
        "X-License-Key": LICENSE_KEY,
        "X-Hardware-Id": HARDWARE_ID,
        "X-License-Token": license_token,
    }


def _legacy_v1_headers(
    path: str,
    license_token: str,
    method: str = "POST",
) -> dict[str, str]:
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    token_hash = hashlib.sha256(license_token.encode()).hexdigest()
    payload = (
        f"{timestamp}:{nonce}:{method}:{path}:"
        f"{LICENSE_KEY}:{HARDWARE_ID}:{token_hash}"
    )
    signature = hmac.new(
        SIDECAR_TOKEN.encode(), payload.encode(), hashlib.sha256
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
    # Production sidecar bỏ qua PRYNX_* path override; cô lập bằng APPDATA
    # để test đi đúng đường dẫn chuẩn của bản cài.
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.delenv("PRYNX_CLK_KEY_FILE", raising=False)
    monkeypatch.delenv("PRYNX_CLOCK_GUARD_FILE", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    lg._license_cache.clear()

    pdf_path = tmp_path / "sample.pdf"
    document = pikepdf.Pdf.new()
    document.add_blank_page(page_size=(100, 100))
    document.save(pdf_path)

    def issue_token(*, plan: str = "free", features: list[str] | None = None) -> str:
        return _make_token(signing_key, plan=plan, features=features)

    client = TestClient(app)
    # SEC (audit 2026-09-03 §SEC.21 E2): event hook chạy sau bước serialize,
    # nên chữ ký bind đúng JSON bytes, multipart boundary và file bytes thực gửi.
    client.event_hooks["request"].append(_sign_prepared_request)
    yield client, issue_token, pdf_path
    client.close()
    lg._license_cache.clear()


@pytest.fixture
def production_free_client(production_entitlement_client):
    client, issue_token, pdf_path = production_entitlement_client
    yield client, issue_token(), pdf_path


def _assert_forbidden(response, feature_id: str) -> None:
    assert response.status_code == 403, response.text
    assert feature_id in response.json().get("detail", "")


@pytest.mark.parametrize("explicit_version", [None, "1"])
def test_production_http_rejects_missing_or_v1_signature_version(
    production_entitlement_client,
    explicit_version,
):
    client, issue_token, _pdf_path = production_entitlement_client
    token = issue_token()
    path = "/api/vdp/status/missing-job"
    headers = _legacy_v1_headers(path, token, method="GET")
    if explicit_version is not None:
        headers["X-PrynX-Signature-Version"] = explicit_version

    response = client.get(path, headers=headers)

    assert response.status_code == 403, response.text
    assert "v2 required" in response.json().get("detail", "").lower()


def test_dev_http_keeps_unsigned_compatibility(
    production_entitlement_client,
    monkeypatch,
):
    client, _issue_token, _pdf_path = production_entitlement_client
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)

    response = client.get("/api/vdp/status/missing-job")

    assert response.status_code == 404, response.text


def test_http_v2_json_rejects_body_and_content_type_mutation(
    production_entitlement_client,
):
    client, issue_token, _pdf_path = production_entitlement_client
    token = issue_token()
    path = "/api/preflight/crop-regions"

    # Control đi qua HMAC + body commitment rồi mới dừng ở schema route.
    control = client.post(path, headers=_headers(path, token), json={})
    assert control.status_code == 422, control.text

    expected_body = b'{}'
    expected_commitment = _chunk_commitment(expected_body, "http-body").hex()
    headers = _signed_v2_headers(
        path,
        token,
        "POST",
        "raw-v1",
        expected_commitment,
        "application/json",
    )
    headers["Content-Type"] = "application/json"
    mutated = client.post(path, headers=headers, content=b'{"page":2}')
    assert mutated.status_code == 403, mutated.text
    assert "commitment mismatch" in mutated.json().get("detail", "").lower()

    type_headers = _signed_v2_headers(
        path,
        token,
        "POST",
        "raw-v1",
        expected_commitment,
        "application/json",
    )
    type_headers["Content-Type"] = "text/plain"
    changed_type = client.post(path, headers=type_headers, content=expected_body)
    assert changed_type.status_code == 403, changed_type.text
    assert "signature" in changed_type.json().get("detail", "").lower()


def test_http_v2_multipart_rejects_file_byte_mutation(
    production_entitlement_client,
):
    client, issue_token, pdf_path = production_entitlement_client
    token = issue_token()
    path = "/api/pdf-tools/trim-shift"

    # Control multipart phải qua body check và bị chặn đúng ở entitlement.
    control = client.post(
        path,
        headers=_headers(path, token),
        data={"config": "{}"},
        files={"file": ("sample.pdf", Path(pdf_path).read_bytes(), "application/pdf")},
    )
    _assert_forbidden(control, "pdf.trim_shift")

    request = client.build_request(
        "POST",
        path,
        data={"config": "{}"},
        files={"file": ("sample.pdf", b"PDF-BBBB", "application/pdf")},
    )
    request.read()
    content_type = request.headers["content-type"].strip()
    expected_commitment = _form_commitment(
        [
            ("config", "{}"),
            ("file", ("sample.pdf", "application/pdf", b"PDF-AAAA")),
        ]
    )
    request.headers.update(
        _signed_v2_headers(
            path,
            token,
            "POST",
            "form-v1",
            expected_commitment,
            content_type,
        )
    )

    mutated = client.send(request)

    assert mutated.status_code == 403, mutated.text
    assert "commitment mismatch" in mutated.json().get("detail", "").lower()


def test_http_v2_raw_stream_is_checked_at_eof(
    production_entitlement_client,
    monkeypatch,
):
    from app.api.routes import mixed_nesting

    client, issue_token, _pdf_path = production_entitlement_client
    monkeypatch.setattr(mixed_nesting, "_runtime_enabled", lambda: True)
    token = issue_token(features=["impo.mixed_nesting"])
    path = "/api/mixed-nesting/jobs"

    # Endpoint này tự đọc request.stream(); body `{}` hợp lệ về commitment nhưng
    # thiếu schema, nên phải tới 422 thay vì bị auth chặn.
    control = client.post(path, headers=_headers(path, token), content=b"{}")
    assert control.status_code == 422, control.text

    expected_commitment = _chunk_commitment(b"{}", "http-body").hex()
    headers = _signed_v2_headers(
        path,
        token,
        "POST",
        "raw-v1",
        expected_commitment,
        "",
    )
    mutated = client.post(
        path,
        headers=headers,
        content=b'{"unexpected":true}',
    )

    assert mutated.status_code == 403, mutated.text
    assert "commitment mismatch" in mutated.json().get("detail", "").lower()

    # Không được hạ mode xuống `none` rồi giấu body trong transfer chunked không
    # có Content-Length. Guard phải reject byte đầu tiên, không gom body vào RAM.
    none_headers = _signed_v2_headers(
        path,
        token,
        "POST",
        "none",
        hashlib.sha256(_BODY_NONE_DOMAIN).hexdigest(),
        "",
    )
    disguised_body = client.post(
        path,
        headers=none_headers,
        content=iter([b'{"unexpected":', b"true}"]),
    )
    assert disguised_body.status_code == 403, disguised_body.text
    assert "unexpected request body" in disguised_body.json().get("detail", "").lower()


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

    # SEC (audit 2026-08-28 §SEC.01): router cut_export TỪNG chỉ có `require_license`
    # nên chính token Free này xuất được luồng cắt và đẩy tới máy bế. Ba đường dưới đây
    # là ba mặt của cùng một lỗ: dựng model từ payload, dựng từ file PDF đã bình, và đọc
    # danh sách máy. Giữ cả ba để một lần vá lẻ ở decorator không làm test xanh giả.
    path = "/api/imposition/cut-export"
    response = client.post(
        path,
        headers=_headers(path, token),
        json={"profile_id": "generic_hpgl", "sheet_w_mm": 100, "sheet_h_mm": 100},
    )
    _assert_forbidden(response, "impo.cnc")

    path = "/api/imposition/cut-export-from-file"
    response = client.post(
        path,
        headers=_headers(path, token),
        json={"profile_id": "generic_hpgl", "path": str(pdf_path)},
    )
    _assert_forbidden(response, "impo.cnc")

    path = "/api/imposition/cut-profiles"
    response = client.get(path, headers=_headers(path, token, method="GET"))
    _assert_forbidden(response, "impo.cnc")


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
