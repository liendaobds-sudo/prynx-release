"""Test xác minh token license do server ký (Ed25519) trong license_guard.

Test tự sinh cặp khóa riêng, monkeypatch public key của module → không phụ thuộc
khóa thật. Mô phỏng đúng cách edge function sẽ ký (ký trên chuỗi payload_b64url).
"""
import base64
import asyncio
import json
import os
import time
import uuid
from io import BytesIO

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from starlette.requests import Request
from starlette.datastructures import FormData, Headers, UploadFile

from app.core import license_guard as lg


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _make_token(sk: Ed25519PrivateKey, payload: dict) -> str:
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = sk.sign(payload_b64.encode("ascii"))
    return payload_b64 + "." + _b64url(sig)


@pytest.fixture
def signing(monkeypatch):
    sk = Ed25519PrivateKey.generate()
    pub_raw = sk.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setattr(lg, "_LICENSE_PUBLIC_KEY_B64", base64.b64encode(pub_raw).decode())
    return sk


def _payload(hwid="HW123", key="ABCDE-FGHIJ-KLMNO", product="prynx", ttl=3600):
    import hashlib
    now = int(time.time())
    return {
        "k": hashlib.sha256(key.encode()).hexdigest()[:16],
        "m": hwid,
        "p": product,
        "exp": now + ttl,
        "v": 2,
        "iat": now,
        "challenge": "a" * 64,
    }


def _payload_v1(hwid="HW123", key="ABCDE-FGHIJ-KLMNO", product="prynx", ttl=3600):
    payload = _payload(hwid=hwid, key=key, product=product, ttl=ttl)
    for claim in ("v", "iat", "challenge"):
        payload.pop(claim)
    return payload


def _payload_v2(
    hwid="HW123",
    key="ABCDE-FGHIJ-KLMNO",
    product="prynx",
    ttl=3600,
    challenge="a" * 64,
    **overrides,
):
    now = int(time.time())
    payload = _payload(hwid=hwid, key=key, product=product, ttl=ttl)
    payload.update({"v": 2, "iat": now, "challenge": challenge})
    payload.update(overrides)
    return payload


def _payload_v3(
    key="ABCDE-FGHIJ-KLMNO",
    product="prynx",
    ttl=900,
    iat=None,
    **overrides,
):
    import hashlib
    now = int(time.time()) if iat is None else iat
    thumbprint = "A" * 43
    device_key_id = "d3_" + thumbprint
    payload = {
        "v": 3,
        "min_v": 3,
        "iat": now,
        "exp": now + ttl,
        "cid": "018f0f5e-8d51-7f77-bbd5-f19db33c4b7a",
        "d": device_key_id,
        "cnf": {"jkt": thumbprint},
        "m": device_key_id,
        "k": hashlib.sha256(key.encode()).hexdigest()[:16],
        "p": product,
    }
    payload.update(overrides)
    return payload


def test_valid_token(signing):
    tok = _make_token(signing, _payload())
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert ok, reason


def test_valid_v2_token_and_challenge(signing):
    challenge = "a" * 64
    tok = _make_token(signing, _payload_v2(challenge=challenge))
    ok, reason = lg.verify_license_token(
        tok,
        "HW123",
        "ABCDE-FGHIJ-KLMNO",
        expected_challenge=challenge,
    )
    assert ok, reason


@pytest.mark.parametrize(
    ("overrides", "needle"),
    [
        ({"iat": None}, "iat"),
        ({"challenge": "short"}, "challenge"),
        ({"challenge": "z" * 64}, "challenge"),
    ],
)
def test_v2_missing_or_malformed_claim_rejected(signing, overrides, needle):
    tok = _make_token(signing, _payload_v2(**overrides))
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and needle in reason.lower()


def test_v2_challenge_mismatch_rejected(signing):
    tok = _make_token(signing, _payload_v2(challenge="a" * 64))
    ok, reason = lg.verify_license_token(
        tok,
        "HW123",
        "ABCDE-FGHIJ-KLMNO",
        expected_challenge="b" * 64,
    )
    assert not ok and "challenge" in reason.lower()


def test_valid_v3_token_has_legacy_short_ttl_and_device_confirmation(signing):
    """Token V3 cũ 15 phút vẫn hợp lệ trong thời gian rollout chính sách 72 giờ."""
    payload = _payload_v3()
    token = _make_token(signing, payload)

    ok, reason = lg.verify_license_token(
        token,
        payload["d"],
        "ABCDE-FGHIJ-KLMNO",
    )

    assert ok, reason
    assert lg._token_v2_issued_at_seconds(token) == payload["iat"]


@pytest.mark.parametrize(
    ("overrides", "needle"),
    [
        ({"min_v": 2}, "protocol"),
        ({"cid": "NOT-A-UUID"}, "challenge"),
        ({"cnf": {"jkt": "B" * 43}}, "confirmation"),
        ({"cnf": {"jkt": "A" * 43, "alg": "PS256"}}, "confirmation"),
        ({"m": "d3_" + "B" * 43}, "device"),
        ({"challenge": "a" * 64}, "challenge"),
    ],
)
def test_v3_downgrade_hybrid_or_binding_mismatch_rejected(signing, overrides, needle):
    payload = _payload_v3(**overrides)
    token = _make_token(signing, payload)
    ok, reason = lg.verify_license_token(
        token,
        "d3_" + "A" * 43,
        "ABCDE-FGHIJ-KLMNO",
    )
    assert not ok and needle in reason.lower()


def test_v3_claim_lifetime_at_72_hours_is_accepted(signing):
    payload = _payload_v3(ttl=lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS)
    token = _make_token(signing, payload)
    ok, reason = lg.verify_license_token(
        token,
        payload["d"],
        "ABCDE-FGHIJ-KLMNO",
    )
    assert ok, reason


def test_v3_claim_lifetime_over_72_hours_is_rejected(signing):
    payload = _payload_v3()
    payload["exp"] = payload["iat"] + lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS + 1
    token = _make_token(signing, payload)
    ok, reason = lg.verify_license_token(
        token,
        payload["d"],
        "ABCDE-FGHIJ-KLMNO",
    )
    assert not ok and "lifetime" in reason.lower()


def test_v3_72_hour_token_survives_weekend_time_advancement(signing, monkeypatch):
    """Token 72 giờ dùng được khi app chạy offline qua cuối tuần."""
    issued_at = 1_800_000_000
    payload = _payload_v3(
        iat=issued_at,
        ttl=lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS,
    )
    token = _make_token(signing, payload)

    # Sau 48 giờ (thời lượng cuối tuần thông thường), token vẫn còn hạn.
    monkeypatch.setattr(lg.time, "time", lambda: issued_at + 48 * 60 * 60)
    ok, reason = lg.verify_license_token(token, payload["d"], "ABCDE-FGHIJ-KLMNO")
    assert ok, reason

    # Gần sát mốc 72 giờ vẫn hợp lệ; đây là cận hành vi chứ không chỉ metadata.
    monkeypatch.setattr(
        lg.time,
        "time",
        lambda: issued_at + lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS - 1,
    )
    ok, reason = lg.verify_license_token(token, payload["d"], "ABCDE-FGHIJ-KLMNO")
    assert ok, reason


def test_v3_72_hour_token_expires_after_time_advancement(signing, monkeypatch):
    issued_at = 1_800_000_000
    payload = _payload_v3(
        iat=issued_at,
        ttl=lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS,
    )
    token = _make_token(signing, payload)

    monkeypatch.setattr(
        lg.time,
        "time",
        lambda: issued_at + lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS + 1,
    )
    ok, reason = lg.verify_license_token(token, payload["d"], "ABCDE-FGHIJ-KLMNO")
    assert not ok and "expired" in reason.lower()


def test_v3_72_hour_token_tampered_signature_is_rejected(signing):
    payload = _payload_v3(ttl=lg._LICENSE_TOKEN_V3_MAX_TTL_SECONDS)
    token = _make_token(signing, payload)
    payload_b64, sig_b64 = token.split(".", 1)
    tampered_sig = ("A" if sig_b64[0] != "A" else "B") + sig_b64[1:]

    ok, reason = lg.verify_license_token(
        payload_b64 + "." + tampered_sig,
        payload["d"],
        "ABCDE-FGHIJ-KLMNO",
    )
    assert not ok and "signature" in reason.lower()


def test_v3_token_copied_to_another_device_id_is_rejected(signing):
    token = _make_token(signing, _payload_v3())
    ok, reason = lg.verify_license_token(
        token,
        "d3_" + "B" * 43,
        "ABCDE-FGHIJ-KLMNO",
    )
    assert not ok and "machine" in reason.lower()


@pytest.mark.parametrize("explicit_version", [False, True])
def test_valid_legacy_v1_token_is_accepted_during_dual_stack(signing, explicit_version):
    payload = _payload_v1()
    if explicit_version:
        payload["v"] = 1
    tok = _make_token(signing, payload)

    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")

    assert ok, reason


def test_v1_cannot_satisfy_online_challenge(signing):
    tok = _make_token(signing, _payload_v1())

    ok, reason = lg.verify_license_token(
        tok,
        "HW123",
        "ABCDE-FGHIJ-KLMNO",
        expected_challenge="a" * 64,
    )

    assert not ok and "v2" in reason.lower()


@pytest.mark.parametrize("claim", ["iat", "challenge"])
def test_v1_hybrid_claims_are_rejected(signing, claim):
    payload = _payload_v1()
    payload["v"] = 1
    payload[claim] = int(time.time()) if claim == "iat" else "a" * 64
    tok = _make_token(signing, payload)

    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")

    assert not ok and "v1" in reason.lower()


@pytest.mark.parametrize("version", [None, True, "1", 0, 4])
def test_null_typed_or_unknown_token_version_is_rejected(signing, version):
    payload = _payload_v1()
    payload["v"] = version
    tok = _make_token(signing, payload)

    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")

    assert not ok and "version" in reason.lower()


def test_expired_v1_token_is_rejected(signing):
    tok = _make_token(signing, _payload_v1(ttl=-10))

    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")

    assert not ok and "expired" in reason.lower()


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [
        ("m", "OTHER_MACHINE", "machine"),
        ("k", "0000000000000000", "key"),
        ("p", "sticker", "product"),
    ],
)
def test_v1_still_enforces_credential_and_product_binding(signing, field, value, needle):
    payload = _payload_v1()
    payload[field] = value
    tok = _make_token(signing, payload)

    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")

    assert not ok and needle in reason.lower()


def test_expired_token(signing):
    tok = _make_token(signing, _payload(ttl=-10))
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "expired" in reason.lower()


def test_machine_mismatch(signing):
    tok = _make_token(signing, _payload(hwid="HW123"))
    ok, reason = lg.verify_license_token(tok, "OTHER_MACHINE", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "machine" in reason.lower()


def test_key_mismatch(signing):
    tok = _make_token(signing, _payload(key="ABCDE-FGHIJ-KLMNO"))
    ok, reason = lg.verify_license_token(tok, "HW123", "WRONG-KEY-00000")
    assert not ok and "key" in reason.lower()


def test_wrong_product_rejected(signing):
    tok = _make_token(signing, _payload(product="sticker"))
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "product" in reason.lower()


def test_missing_product_rejected(signing):
    payload = _payload()
    del payload["p"]
    tok = _make_token(signing, payload)
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "product" in reason.lower()


def test_tampered_signature(signing):
    tok = _make_token(signing, _payload())
    payload_b64, sig_b64 = tok.split(".", 1)
    # Lật vài ký tự chữ ký
    bad = sig_b64[:-4] + ("AAAA" if sig_b64[-4:] != "AAAA" else "BBBB")
    ok, reason = lg.verify_license_token(payload_b64 + "." + bad, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "signature" in reason.lower()


def test_forged_token_wrong_key(signing):
    # Kẻ tấn công tự ký bằng khóa KHÁC → phải bị từ chối.
    attacker = Ed25519PrivateKey.generate()
    tok = _make_token(attacker, _payload())
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "signature" in reason.lower()


def test_malformed_token(signing):
    ok, reason = lg.verify_license_token("garbage-no-dot", "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok
    ok2, _ = lg.verify_license_token("", "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok2


# ── #5: Test verify_sidecar_signature (HMAC + cửa sổ thời gian) ───────────────
import hashlib
import hmac as _hmac


BOUND_KEY = "ABCDE-FGHIJ-KLMNO"
BOUND_HWID = "HW123"
BOUND_LICENSE_TOKEN = "SIGNED_LICENSE_TOKEN"


def _sign(
    token: str,
    ts: str,
    path: str,
    nonce: str | None = None,
    method: str = "GET",
) -> tuple[str, str]:
    """Dựng chữ ký HMAC như Rust `sign_api_request` → trả (signature, nonce).

    Payload PHẢI khớp Rust: ts:nonce:method:path:key:hwid:sha256(token).
    """
    if nonce is None:
        nonce = uuid.uuid4().hex
    token_hash = hashlib.sha256(BOUND_LICENSE_TOKEN.encode()).hexdigest()
    payload = f"{ts}:{nonce}:{method}:{path}:{BOUND_KEY}:{BOUND_HWID}:{token_hash}"
    return _hmac.new(token.encode(), payload.encode(), hashlib.sha256).hexdigest(), nonce


def _sign_v2(
    token: str,
    ts: str,
    path: str,
    body_mode: str,
    body_commitment: str,
    content_type: str,
    nonce: str | None = None,
    method: str = "POST",
) -> tuple[str, str]:
    """Dựng canonical length-prefixed của HTTP request-signing v2."""
    if nonce is None:
        nonce = uuid.uuid4().hex
    token_hash = hashlib.sha256(BOUND_LICENSE_TOKEN.encode()).hexdigest()
    payload = lg._request_signature_payload_v2(
        ts,
        nonce,
        method,
        path,
        BOUND_KEY,
        BOUND_HWID,
        token_hash,
        body_mode,
        body_commitment,
        content_type,
    )
    return _hmac.new(token.encode(), payload, hashlib.sha256).hexdigest(), nonce


@pytest.fixture
def sidecar(monkeypatch):
    """Ép KHÔNG dev-mode và set sidecar token cố định để test chữ ký HMAC."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "TESTTOKEN_DEADBEEF")
    lg._seen_nonces.clear()  # nonce dùng-một-lần: mỗi test bắt đầu từ bảng sạch
    return "TESTTOKEN_DEADBEEF"


def test_sidecar_signature_valid(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    sig, nonce = _sign(sidecar, ts, path)
    ok, reason = lg.verify_sidecar_signature(path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce)
    assert ok, reason


def test_sidecar_restart_invalidates_old_generation_signature(monkeypatch):
    """Reset bảng nonce không được làm proof generation cũ sống lại sau respawn."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    master = "00" * 32
    old_session = lg._derive_sidecar_session_token(master, 41)
    new_session = lg._derive_sidecar_session_token(master, 42)
    ts = str(int(time.time()))
    path = "/api/upload"
    signature, nonce = _sign(old_session, ts, path)

    # Mô phỏng process Python mới: nonce memory bắt đầu rỗng, nhưng generation
    # mới phải dùng session key khác nên HMAC đã bắt ở process cũ vẫn vô hiệu.
    lg._seen_nonces.clear()
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", new_session)
    ok, reason = lg.verify_sidecar_signature(
        path,
        ts,
        signature,
        BOUND_KEY,
        BOUND_HWID,
        BOUND_LICENSE_TOKEN,
        nonce,
    )

    assert old_session != new_session
    assert not ok and "signature" in reason.lower()


def test_sidecar_signature_rejects_credential_substitution(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    signature, nonce = _sign(sidecar, ts, path)
    ok, reason = lg.verify_sidecar_signature(
        path, ts, signature, "STOLEN-PRO-KEY", BOUND_HWID, BOUND_LICENSE_TOKEN, nonce
    )
    assert not ok and "signature" in reason.lower()

def test_sidecar_signature_wrong_token(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    sig, nonce = _sign("WRONG_TOKEN", ts, path)
    ok, _ = lg.verify_sidecar_signature(path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce)
    assert not ok  # token không khớp _SIDECAR_TOKEN


def test_sidecar_signature_expired_ts(sidecar):
    old_ts = str(int(time.time()) - 120)  # quá 30s
    path = "/api/upload"
    sig, nonce = _sign(sidecar, old_ts, path)
    ok, reason = lg.verify_sidecar_signature(path, old_ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce)
    assert not ok and "expired" in reason.lower()


def test_sidecar_signature_bad_sig(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    ok, reason = lg.verify_sidecar_signature(
        path, ts, "deadbeef" * 8, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, uuid.uuid4().hex
    )
    assert not ok and "signature" in reason.lower()


def test_sidecar_signature_path_mismatch(sidecar):
    """Chữ ký ký cho path khác → reject (chống tái dùng chữ ký sang endpoint khác)."""
    ts = str(int(time.time()))
    sig, nonce = _sign(sidecar, ts, "/api/upload")
    ok, reason = lg.verify_sidecar_signature("/api/admin", ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce)
    assert not ok and "signature" in reason.lower()


def test_request_signature_path_binds_raw_query_string():
    """Query phải nằm trong canonical path, không bị bỏ rơi khỏi HMAC."""
    path = "/api/upload"
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"page=2&format=pdf%20x",
            "headers": [],
        }
    )
    assert lg.request_signature_path(request) == "/api/upload?page=2&format=pdf%20x"


def test_request_signature_path_rejects_non_ascii_raw_query():
    """Raw query lỗi mã hoá không được rơi về pathname (fail-open)."""
    path = "/api/upload"
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"bad=\xff",
            "headers": [],
        }
    )
    assert lg.request_signature_path(request).startswith("\x00invalid-")


def test_sidecar_signature_method_mismatch(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    sig, nonce = _sign(sidecar, ts, path, method="POST")
    ok, reason = lg.verify_sidecar_signature(
        path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce, "DELETE"
    )
    assert not ok and "signature" in reason.lower()


def test_sidecar_signature_v2_binds_body_and_content_type(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload?target=preview"
    body_commitment = lg._raw_body_commitment(b'{"page":1}')
    signature, nonce = _sign_v2(
        sidecar,
        ts,
        path,
        "raw-v1",
        body_commitment,
        "application/json",
    )
    ok, reason = lg.verify_sidecar_signature(
        path,
        ts,
        signature,
        BOUND_KEY,
        BOUND_HWID,
        BOUND_LICENSE_TOKEN,
        nonce,
        "POST",
        "2",
        "raw-v1",
        body_commitment,
        "application/json",
    )
    assert ok, reason

    changed_signature, changed_nonce = _sign_v2(
        sidecar,
        ts,
        path,
        "raw-v1",
        body_commitment,
        "application/json",
    )
    changed_ok, changed_reason = lg.verify_sidecar_signature(
        path,
        ts,
        changed_signature,
        BOUND_KEY,
        BOUND_HWID,
        BOUND_LICENSE_TOKEN,
        changed_nonce,
        "POST",
        "2",
        "raw-v1",
        lg._raw_body_commitment(b'{"page":2}'),
        "application/json",
    )
    assert not changed_ok and "signature" in changed_reason.lower()

    type_signature, type_nonce = _sign_v2(
        sidecar,
        ts,
        path,
        "raw-v1",
        body_commitment,
        "application/json",
    )
    type_ok, type_reason = lg.verify_sidecar_signature(
        path,
        ts,
        type_signature,
        BOUND_KEY,
        BOUND_HWID,
        BOUND_LICENSE_TOKEN,
        type_nonce,
        "POST",
        "2",
        "raw-v1",
        body_commitment,
        "text/plain;charset=UTF-8",
    )
    assert not type_ok and "signature" in type_reason.lower()


def test_sidecar_signature_v2_rejects_malformed_or_unknown_binding(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    commitment = lg._raw_body_commitment(b"payload")
    signature, nonce = _sign_v2(
        sidecar, ts, path, "raw-v1", commitment, "text/plain;charset=UTF-8"
    )

    malformed, reason = lg.verify_sidecar_signature(
        path,
        ts,
        signature,
        BOUND_KEY,
        BOUND_HWID,
        BOUND_LICENSE_TOKEN,
        nonce,
        "POST",
        "2",
        "raw-v1",
        commitment.upper(),
        "text/plain;charset=UTF-8",
    )
    assert not malformed and "commitment" in reason.lower()

    unknown, reason = lg.verify_sidecar_signature(
        path,
        ts,
        signature,
        BOUND_KEY,
        BOUND_HWID,
        BOUND_LICENSE_TOKEN,
        uuid.uuid4().hex,
        "POST",
        "3",
        "raw-v1",
        commitment,
        "text/plain;charset=UTF-8",
    )
    assert not unknown and "version" in reason.lower()


def test_chunk_commitment_is_independent_of_transport_chunk_boundaries():
    body = b"a" * (lg._BODY_COMMITMENT_CHUNK_BYTES + 17)
    whole = lg._raw_body_commitment(body)
    streamed = lg._ChunkCommitment("http-body")
    streamed.update(body[:3])
    streamed.update(body[3:900_007])
    streamed.update(body[900_007:])
    assert streamed.hexdigest() == whole


def test_form_body_commitment_matches_frontend_fixture_and_rewinds_upload():
    """Canonical multipart phải giống WebView và không làm endpoint mất file."""

    async def exercise() -> None:
        upload = UploadFile(
            BytesIO(bytes([1, 2, 3])),
            filename="artwork-a.pdf",
            headers=Headers({"content-type": "application/pdf"}),
        )
        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/upload",
                "headers": [],
            }
        )
        request._form = FormData(
            [("preset", "sheet\nA"), ("artwork", upload)]
        )

        commitment = await lg._form_body_commitment(request)

        assert commitment == (
            "6dd0e364f5e4a20d3d53e816cc5a3b57"
            "c1ae253167077df60a2aa4d5ddb46387"
        )
        assert await upload.read() == bytes([1, 2, 3])

    asyncio.run(exercise())


def test_stream_body_guard_rejects_mutation_without_buffering_request():
    sent = False

    async def exercise() -> None:
        nonlocal sent
        messages = iter(
            [
                {"type": "http.request", "body": b"pay", "more_body": True},
                {"type": "http.request", "body": b"load-X", "more_body": False},
            ]
        )

        async def receive():
            nonlocal sent
            sent = True
            return next(messages)

        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/raw",
                "headers": [],
            },
            receive,
        )
        lg._install_stream_body_commitment_guard(
            request, lg._raw_body_commitment(b"payload")
        )
        with pytest.raises(lg.HTTPException) as caught:
            async for _chunk in request.stream():
                pass
        assert "commitment mismatch" in str(caught.value).lower()
        assert not hasattr(request, "_body")

    asyncio.run(exercise())
    assert sent


def test_sidecar_signature_missing_nonce(sidecar):
    """Thiếu nonce → reject. Chặn hạ cấp về định dạng payload cũ (replay được)."""
    ts = str(int(time.time()))
    path = "/api/upload"
    sig, _nonce = _sign(sidecar, ts, path)
    ok, reason = lg.verify_sidecar_signature(path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, "")
    assert not ok and "nonce" in reason.lower()


def test_sidecar_signature_nonce_single_use(sidecar):
    """Cùng một chữ ký + nonce dùng lần thứ 2 → reject (chống replay trong 30s).

    Đây chính là lỗ được bịt ở audit 2026-07-25: trước đây chữ ký bắt được vẫn hợp
    lệ trong 30s và dùng lại được cho body khác trên cùng path.
    """
    ts = str(int(time.time()))
    path = "/api/upload"
    sig, nonce = _sign(sidecar, ts, path)

    ok, reason = lg.verify_sidecar_signature(path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce)
    assert ok, reason

    replay_ok, replay_reason = lg.verify_sidecar_signature(
        path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce
    )
    assert not replay_ok and "replay" in replay_reason.lower()


def test_sidecar_nonce_not_recorded_when_signature_invalid(sidecar):
    """Nonce chỉ được tiêu SAU khi HMAC hợp lệ.

    Nếu ghi nhận trước, caller ngoài có thể (a) bơm nonce rác làm phình bảng, và
    (b) 'đốt' trước nonce của request thật để gây từ chối dịch vụ.
    """
    ts = str(int(time.time()))
    path = "/api/upload"
    sig, nonce = _sign(sidecar, ts, path)

    bad_ok, _ = lg.verify_sidecar_signature(
        path, ts, "0" * 64, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce
    )
    assert not bad_ok
    assert nonce not in lg._seen_nonces

    ok, reason = lg.verify_sidecar_signature(path, ts, sig, BOUND_KEY, BOUND_HWID, BOUND_LICENSE_TOKEN, nonce)
    assert ok, reason


def test_sidecar_dev_mode_bypass(monkeypatch):
    """Dev mode: bỏ qua kiểm tra (chạy backend thủ công khi phát triển)."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    ok, _ = lg.verify_sidecar_signature("/api/x", "", "", "", "", "")
    assert ok


def test_public_key_env_override(monkeypatch):
    """#2: public key đọc được từ env (rotate không cần sửa code).

    Mô phỏng reload module với env set → verify token ký bằng khóa env tương ứng.
    """
    sk = Ed25519PrivateKey.generate()
    pub_raw = sk.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setattr(lg, "_LICENSE_PUBLIC_KEY_B64", base64.b64encode(pub_raw).decode())
    tok = _make_token(sk, _payload())
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert ok, reason


# ── V3/V4/V7: token THIẾU field bắt buộc "m"/"k" → phải từ chối ───────────────
def test_token_missing_machine_field(signing):
    p = _payload()
    del p["m"]
    tok = _make_token(signing, p)
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "machine" in reason.lower()


def test_token_missing_key_field(signing):
    p = _payload()
    del p["k"]
    tok = _make_token(signing, p)
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert not ok and "key" in reason.lower()


# ── V1: enforce fail-CLOSED ở binary production ──────────────────────────────
def test_enforce_token_production_fail_closed(monkeypatch):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.delenv("PRYNX_ENFORCE_LICENSE_TOKEN", raising=False)
    assert lg._enforce_license_token() is True  # production: luôn enforce dù env unset


def test_enforce_token_dev_optional(monkeypatch):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    monkeypatch.delenv("PRYNX_ENFORCE_LICENSE_TOKEN", raising=False)
    assert lg._enforce_license_token() is False  # dev: theo env (mặc định tắt)


# ── V2→V4: anti-clockback (monotonic clock guard) ────────────────────────────
@pytest.fixture
def clk(monkeypatch, tmp_path):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    # Production bỏ qua PRYNX_* path override; cô lập fixture bằng APPDATA
    # (đúng đường dẫn chuẩn mà sidecar release sử dụng).
    appdata = tmp_path / "appdata"
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.delenv("PRYNX_CLK_KEY_FILE", raising=False)
    monkeypatch.delenv("PRYNX_CLOCK_GUARD_FILE", raising=False)
    # Reset cache để test không dùng key từ test khác
    monkeypatch.setattr(lg, "_cached_installation_clk_key", None)
    monkeypatch.setattr(lg, "_cached_installation_clk_key_stat", None)
    p = str(appdata / "PrynX" / ".clkguard")
    return p


def test_clock_guard_detects_rollback(clk):
    ok, reason = lg._clock_guard()
    assert ok, reason
    lg._clk_write(clk, int(time.time()) + 100_000)  # đã thấy thời gian xa hơn
    ok, reason = lg._clock_guard()                   # now lùi nhiều so với mốc
    assert not ok and "rollback" in reason.lower()


def test_clock_guard_allows_forward(clk):
    ok, reason = lg._clock_guard()
    assert ok, reason
    lg._clk_write(clk, int(time.time()) - 100)  # mốc cũ → now tiến lên: hợp lệ
    ok, _ = lg._clock_guard()
    assert ok


def test_clock_guard_first_install_bootstraps(clk):
    """Lần đầu chưa có state thì guard tạo đủ key, anchor và marker."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    assert os.path.isfile(lg._clk_key_path())
    assert os.path.isfile(clk)
    assert os.path.isfile(lg._clk_state_path())


def test_clock_guard_tamper_fails_closed(clk):
    # State đã thiết lập: chữ ký v2 sai phải khóa, không reset neo.
    ok, reason = lg._clock_guard()
    assert ok, reason
    with open(clk, "w", encoding="utf-8") as f:
        # Signature đúng hình dạng nhưng sai HMAC → tampered (khác corrupt format).
        f.write(f"v2:{int(time.time()) + 100_000}:{'0' * 64}")
    ok, reason = lg._clock_guard()
    assert not ok and "tamper" in reason.lower()


def test_clock_guard_missing_key_fails_closed(clk, monkeypatch):
    """Xoá key sau khi đã bootstrap không được tạo key mới."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    key_path = lg._clk_key_path()
    os.unlink(key_path)
    monkeypatch.setattr(lg, "_cached_installation_clk_key", None)
    monkeypatch.setattr(lg, "_cached_installation_clk_key_stat", None)
    ok, reason = lg._clock_guard()
    assert not ok and "key" in reason.lower()
    assert not os.path.exists(key_path), "Không được regen key sau khi state đã thiết lập"


def test_clock_guard_missing_anchor_fails_closed(clk):
    """Xoá anchor sau bootstrap phải buộc revalidation, không reset mốc."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    os.unlink(clk)
    ok, reason = lg._clock_guard()
    assert not ok and "anchor" in reason.lower()


def test_clock_guard_marker_tamper_fails_closed(clk):
    ok, reason = lg._clock_guard()
    assert ok, reason
    with open(lg._clk_state_path(), "w", encoding="utf-8") as f:
        f.write("v1:bad-marker")
    ok, reason = lg._clock_guard()
    assert not ok and "marker" in reason.lower()


def test_clock_guard_missing_marker_fails_closed(clk):
    """Marker bị xoá sau bootstrap không được coi là state chuyển tiếp."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    os.unlink(lg._clk_state_path())
    ok, reason = lg._clock_guard()
    assert not ok and "marker" in reason.lower()


def test_clock_state_recovers_missing_anchor_after_verified_v2_proof(clk, signing):
    """Lỗi xoá anchor hợp pháp có thể tự phục hồi sau online revalidation.

    Recovery phải giữ nguyên installation key và chỉ nhận token v2 đã ký; đây là
    đường tránh tình trạng sidecar bị brick vĩnh viễn sau antivirus/partial update.
    """
    ok, reason = lg._clock_guard()
    assert ok, reason
    key_before = lg._installation_clk_key(create=False)
    os.unlink(clk)
    token = _make_token(signing, _payload_v2())

    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )

    assert recovered, reason
    assert os.path.isfile(clk)
    assert os.path.isfile(lg._clk_state_path())
    assert lg._installation_clk_key(create=False) == key_before
    assert lg._clock_guard()[0]


def test_clock_state_recovery_rejects_v1_token_and_keeps_anchor_missing(clk, signing):
    """Token v1 không được biến thành đường bootstrap lại state đã mất."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    os.unlink(clk)
    token = _make_token(signing, _payload_v1())

    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )

    assert not recovered
    assert "v2" in reason.lower()
    assert not os.path.exists(clk)


def test_clock_state_recovery_rejects_stale_v2_token(clk, signing):
    """Token v2 còn hạn nhưng đã cũ không được dùng để dựng lại state."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    os.unlink(clk)
    now = int(time.time())
    token = _make_token(
        signing,
        _payload_v2(iat=now - lg._CLOCK_RECOVERY_MAX_AGE_SECONDS - 1, exp=now + 600),
    )

    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )

    assert not recovered
    assert "stale" in reason.lower()
    assert not os.path.exists(clk)


def test_clock_state_recovery_keeps_hmac_tamper_locked(clk, signing):
    """Anchor sai chữ ký không bị xoá dấu vết qua đường repair."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    with open(clk, "w", encoding="utf-8") as handle:
        handle.write(f"v2:{int(time.time())}:{'0' * 64}")
    token = _make_token(signing, _payload_v2())

    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )

    assert not recovered
    assert "tampered" in reason.lower()
    with open(clk, "r", encoding="utf-8") as handle:
        assert "0" * 64 in handle.read()


def test_clock_state_recovery_does_not_overwrite_future_anchor(clk, signing):
    """Proof online không được dùng để che một anchor tương lai (rollback)."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    future = int(time.time()) + 100_000
    assert lg._clk_write(clk, future, allow_bootstrap=False)
    os.unlink(lg._clk_state_path())
    token = _make_token(signing, _payload_v2())

    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )

    assert not recovered
    assert "rollback" in reason.lower()
    assert lg._clk_read(clk) == future


@pytest.mark.asyncio
async def test_require_license_repairs_missing_anchor_only_after_fresh_online_v2(
    clk, signing, monkeypatch
):
    """Đường HTTP thật phải bypass cache, kiểm tra server rồi mới repair state."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    os.unlink(clk)
    now = int(time.time())
    token = _make_token(signing, _payload_v2(iat=now, exp=now + 3600))
    online_calls: list[tuple[str, str]] = []

    async def online_check(license_key: str, hwid: str) -> bool:
        online_calls.append((license_key, hwid))
        return True

    monkeypatch.setattr(lg, "verify_sidecar_signature", lambda *args, **kwargs: (True, ""))
    monkeypatch.setattr(lg, "_verify_with_supabase", online_check)
    # A stale cached boolean must not be accepted as proof for state repair.
    lg._license_cache[lg._hash_credentials("ABCDE-FGHIJ-KLMNO", "HW123")] = (
        True, time.time() + 3600
    )
    path = "/api/test"

    async def receive_empty_body():
        return {"type": "http.request", "body": b"", "more_body": False}

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"x-license-key", b"ABCDE-FGHIJ-KLMNO"),
                (b"x-hardware-id", b"HW123"),
                (b"x-license-token", token.encode("ascii")),
                # SEC (audit 2026-09-03 §SEC.21 E2): fixture production HTTP
                # phải đi qua cổng v2 dù HMAC được mock để cô lập test clock repair.
                (b"x-prynx-signature-version", b"2"),
                (b"x-prynx-body-mode", b"none"),
                (
                    b"x-prynx-body-commitment",
                    lg._BODY_NONE_COMMITMENT.encode("ascii"),
                ),
            ],
        },
        receive_empty_body,
    )

    result = await lg.require_license(request)

    assert result["verified"] is True
    assert online_calls == [("ABCDE-FGHIJ-KLMNO", "HW123")]
    assert os.path.isfile(clk)
    assert lg._clock_guard()[0]


def test_clock_guard_dev_bypass(monkeypatch):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    ok, _ = lg._clock_guard()
    assert ok


# SEC (audit 2026-09-03 §SEC.19): test V4 — installation key sống sót qua restart
def test_clock_guard_survives_restart(clk, monkeypatch):
    """Ghi mốc, giả lập restart bằng cách reset cache → mốc vẫn hợp lệ."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    future_ts = int(time.time()) + 100_000
    lg._clk_write(clk, future_ts)

    # Giả lập restart: reset cache key (key ĐÃ trên đĩa)
    monkeypatch.setattr(lg, "_cached_installation_clk_key", None)

    stored = lg._clk_read(clk)
    assert stored == future_ts, "Mốc phải sống sót qua restart (V4 dùng installation key)"

    # Kiểm tra clock guard vẫn bắt rollback sau restart
    ok, reason = lg._clock_guard()
    assert not ok and "rollback" in reason.lower()


def test_clock_guard_v1_migration(clk, monkeypatch):
    """File v1 cũ được bootstrap một lần khi chưa có V4 installation state."""
    os.makedirs(os.path.dirname(clk), exist_ok=True)
    with open(clk, "w", encoding="utf-8") as f:
        f.write(f"{int(time.time()) + 100_000}:somesig_v1")

    stored = lg._clk_read(clk)
    assert stored is None, "File v1 phải bị coi là invalid"

    ok, _ = lg._clock_guard()
    assert ok, "Khách nâng cấp từ v1 chưa có V4 state không được bị brick"
    assert os.path.isfile(lg._clk_key_path())
    assert os.path.isfile(lg._clk_state_path())


def test_clock_guard_legacy_record_after_v4_fails_closed(clk):
    """Sau migration, record v1 không được trở thành đường repair tự động."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    with open(clk, "w", encoding="utf-8") as handle:
        handle.write(f"{int(time.time())}:legacy-record")

    ok, reason = lg._clock_guard()

    assert not ok and "legacy" in reason.lower()
    assert not lg._clock_recovery_required(reason)


def test_installation_key_created_once(clk, monkeypatch, tmp_path):
    """Installation key phải idempotent — gọi hai lần trả cùng key."""
    key1 = lg._installation_clk_key()
    assert key1 is not None and len(key1) == 32

    monkeypatch.setattr(lg, "_cached_installation_clk_key", None)
    key2 = lg._installation_clk_key()
    assert key1 == key2, "Gọi hai lần phải trả cùng key (đọc từ đĩa)"


def test_installation_key_tamper_fails_closed(clk, monkeypatch, tmp_path):
    """Key file bị sửa không được regen; state phải fail-closed."""
    ok, reason = lg._clock_guard()
    assert ok, reason
    key1 = lg._installation_clk_key()
    assert key1 is not None

    key_path = lg._clk_key_path()
    with open(key_path, "wb") as f:
        f.write(b"tampered")

    monkeypatch.setattr(lg, "_cached_installation_clk_key", None)
    monkeypatch.setattr(lg, "_cached_installation_clk_key_stat", None)
    key2 = lg._installation_clk_key()
    assert key2 is None, "Key bị tamper phải bị từ chối, không tạo key mới"

    ok, reason = lg._clock_guard()
    assert not ok and "key" in reason.lower()
    with open(key_path, "rb") as f:
        assert f.read() == b"tampered"


def test_clock_state_paths_ignore_environment_in_production(monkeypatch, tmp_path):
    """Không cho sidecar release trỏ clock state sang thư mục tuỳ ý."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    appdata = tmp_path / "appdata"
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.setenv("PRYNX_CLK_KEY_FILE", str(tmp_path / "attacker" / "key"))
    monkeypatch.setenv("PRYNX_CLOCK_GUARD_FILE", str(tmp_path / "attacker" / "guard"))

    assert lg._clk_key_path() == str(appdata / "PrynX" / ".clkkey")
    assert lg._clock_guard_path() == str(appdata / "PrynX" / ".clkguard")


def test_clock_state_paths_allow_fixture_override_only_in_dev(monkeypatch, tmp_path):
    """Dev vẫn có thể chỉ định file tạm để test/migrate mà không ảnh hưởng release."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    key_path = str(tmp_path / "dev-key")
    guard_path = str(tmp_path / "dev-guard")
    monkeypatch.setenv("PRYNX_CLK_KEY_FILE", key_path)
    monkeypatch.setenv("PRYNX_CLOCK_GUARD_FILE", guard_path)

    assert lg._clk_key_path() == key_path
    assert lg._clock_guard_path() == guard_path


# SEC (audit 2026-09-03 §SEC.19): state reader phải phân biệt format hỏng,
# HMAC tamper và lỗi I/O; chỉ ``corrupt``/``missing`` mới đi vào recovery.
def test_clock_state_readers_classify_corrupt_tampered_and_unavailable(tmp_path, monkeypatch):
    key = b"k" * 32
    record = tmp_path / "record"
    marker = tmp_path / "marker"

    assert lg._read_clk_record(str(record), key) == (None, "missing")
    record.write_text("v2:not-a-record", encoding="utf-8")
    assert lg._read_clk_record(str(record), key) == (None, "corrupt")
    record.write_text(f"v2:123:{'0' * 64}", encoding="utf-8")
    assert lg._read_clk_record(str(record), key) == (None, "tampered")

    marker.write_text("v1:bad", encoding="utf-8")
    assert lg._read_clk_marker(str(marker), key) == "corrupt"
    marker.write_text(f"v1:{'0' * 64}", encoding="utf-8")
    assert lg._read_clk_marker(str(marker), key) == "tampered"

    monkeypatch.setattr(lg, "_state_file_status", lambda _path: "unavailable")
    assert lg._read_clk_record(str(record), key) == (None, "unavailable")
    assert lg._read_clk_marker(str(marker), key) == "unavailable"


def test_clock_key_reader_classifies_corrupt_tampered_and_unavailable(tmp_path, monkeypatch):
    key_path = tmp_path / "key"
    key_path.write_bytes(b"fixture")
    monkeypatch.setattr(lg, "_state_file_status", lambda _path: "present")

    monkeypatch.setattr(lg, "_read_clk_key_from_disk", lambda _path: b"x" * 31)
    assert lg._read_installation_clk_key_state(str(key_path)) == (None, "corrupt")

    monkeypatch.setattr(lg, "_read_clk_key_from_disk", lambda _path: None)
    assert lg._read_installation_clk_key_state(str(key_path)) == (None, "tampered")

    def _deny(_path):
        raise PermissionError("fixture denied")

    monkeypatch.setattr(lg, "_read_clk_key_from_disk", _deny)
    assert lg._read_installation_clk_key_state(str(key_path)) == (None, "unavailable")


def test_clock_recovery_repairs_corrupt_marker_but_not_tampered_marker(clk, signing):
    ok, reason = lg._clock_guard()
    assert ok, reason
    marker_path = lg._clk_state_path()
    with open(marker_path, "r", encoding="utf-8") as handle:
        original_marker = handle.read()
    token = _make_token(signing, _payload_v2())

    # Corrupt format is repairable after a signed, fresh v2 proof.
    with open(marker_path, "w", encoding="utf-8") as handle:
        handle.write("v1:bad")
    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )
    assert recovered, reason
    with open(marker_path, "r", encoding="utf-8") as handle:
        assert handle.read() == original_marker

    # HMAC mismatch is tamper evidence and must remain untouched.
    with open(marker_path, "w", encoding="utf-8") as handle:
        handle.write(f"v1:{'0' * 64}")
    recovered, reason = lg._recover_clock_state_from_online_token(
        token, "ABCDE-FGHIJ-KLMNO", "HW123"
    )
    assert not recovered and "tampered" in reason.lower()
    with open(marker_path, "r", encoding="utf-8") as handle:
        assert handle.read() == f"v1:{'0' * 64}"


def test_clock_state_requires_appdata_in_production(monkeypatch, tmp_path):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.delenv("APPDATA", raising=False)
    fake_home = tmp_path / "fake-home"
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("PRYNX_CLK_KEY_FILE", str(tmp_path / "attacker-key"))
    monkeypatch.setenv("PRYNX_CLOCK_GUARD_FILE", str(tmp_path / "attacker-guard"))

    ok, reason = lg._clock_guard()
    assert not ok and "path" in reason.lower()
    assert not fake_home.exists(), "Không được fallback sang HOME ở production"
    with pytest.raises(RuntimeError, match="APPDATA"):
        lg._clk_key_path()


def test_compiled_runtime_ignores_sidecar_token_env(monkeypatch):
    monkeypatch.delenv("PRYNX_TOKEN_SOURCE", raising=False)
    monkeypatch.delenv("PRYNX_TOKEN_FILE", raising=False)
    monkeypatch.setenv("PRYNX_SIDECAR_TOKEN", "attacker-controlled-secret")
    monkeypatch.setattr(lg, "_is_compiled_runtime", lambda: True)
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "stale-value")

    lg._load_token_from_file()

    assert lg._SIDECAR_TOKEN is None


def test_dev_runtime_allows_sidecar_token_env_override(monkeypatch):
    monkeypatch.delenv("PRYNX_TOKEN_SOURCE", raising=False)
    monkeypatch.delenv("PRYNX_TOKEN_FILE", raising=False)
    monkeypatch.setenv("PRYNX_SIDECAR_TOKEN", "dev-secret")
    monkeypatch.setattr(lg, "_is_compiled_runtime", lambda: False)
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", None)

    lg._load_token_from_file()

    assert lg._SIDECAR_TOKEN == "dev-secret"


def test_missing_or_invalid_plan_falls_back_to_free(signing):
    missing = _make_token(signing, _payload())
    invalid_payload = _payload()
    invalid_payload["plan"] = "mystery"
    invalid = _make_token(signing, invalid_payload)

    assert lg._read_verified_entitlements(missing)["plan"] == "free"
    assert lg._read_verified_entitlements(invalid)["plan"] == "free"


def test_explicit_pro_plan_is_preserved(signing):
    payload = _payload()
    payload["plan"] = "pro"
    token = _make_token(signing, payload)
    assert lg._read_verified_entitlements(token)["plan"] == "pro"


def test_license_context_without_entitlements_is_free():
    context = lg._license_context("KEY", "HWID", True)
    assert context["plan"] == "free"
    assert context["features"] is None

def test_result_access_url_is_path_scoped(monkeypatch):
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "test-sidecar-secret")
    path = "/results/job-1/page.png"
    signed = lg.result_access_url(path)
    signed_path, query = signed.split("?access=", 1)

    assert signed_path == path
    assert lg.verify_result_access(path, query)
    assert not lg.verify_result_access("/results/job-2/page.png", query)
    assert not lg.verify_result_access(path, "0" * 64)


def test_result_access_fails_closed_without_sidecar_token(monkeypatch):
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", None)
    monkeypatch.setattr(lg, "_enforce_license_token", lambda: True)

    with pytest.raises(RuntimeError, match="sidecar token"):
        lg.result_access_url("/results/job-1/page.png")
    assert not lg.verify_result_access("/results/job-1/page.png", "")

def test_results_mount_requires_path_signature(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "test-sidecar-secret")
    client = TestClient(app)
    path = "/results/security-audit-does-not-exist.png"

    assert client.get(path).status_code == 403
    signed = lg.result_access_url(path)
    assert client.get(signed).status_code == 404
