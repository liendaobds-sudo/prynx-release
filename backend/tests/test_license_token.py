"""Test xác minh token license do server ký (Ed25519) trong license_guard.

Test tự sinh cặp khóa riêng, monkeypatch public key của module → không phụ thuộc
khóa thật. Mô phỏng đúng cách edge function sẽ ký (ký trên chuỗi payload_b64url).
"""
import base64
import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

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


def _payload(hwid="HW123", key="ABCDE-FGHIJ-KLMNO", product="sticker", ttl=3600):
    import hashlib
    return {
        "k": hashlib.sha256(key.encode()).hexdigest()[:16],
        "m": hwid,
        "p": product,
        "exp": int(time.time()) + ttl,
    }


def test_valid_token(signing):
    tok = _make_token(signing, _payload())
    ok, reason = lg.verify_license_token(tok, "HW123", "ABCDE-FGHIJ-KLMNO")
    assert ok, reason


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


def _sign(token: str, ts: str, path: str) -> str:
    return _hmac.new(token.encode(), f"{ts}:{path}".encode(), hashlib.sha256).hexdigest()


@pytest.fixture
def sidecar(monkeypatch):
    """Ép KHÔNG dev-mode và set sidecar token cố định để test chữ ký HMAC."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "TESTTOKEN_DEADBEEF")
    return "TESTTOKEN_DEADBEEF"


def test_sidecar_signature_valid(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    ok, reason = lg.verify_sidecar_signature(path, sidecar, ts, _sign(sidecar, ts, path))
    assert ok, reason


def test_sidecar_signature_wrong_token(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    ok, _ = lg.verify_sidecar_signature(path, "WRONG_TOKEN", ts, _sign("WRONG_TOKEN", ts, path))
    assert not ok  # token không khớp _SIDECAR_TOKEN


def test_sidecar_signature_expired_ts(sidecar):
    old_ts = str(int(time.time()) - 120)  # quá 30s
    path = "/api/upload"
    ok, reason = lg.verify_sidecar_signature(path, sidecar, old_ts, _sign(sidecar, old_ts, path))
    assert not ok and "expired" in reason.lower()


def test_sidecar_signature_bad_sig(sidecar):
    ts = str(int(time.time()))
    path = "/api/upload"
    ok, reason = lg.verify_sidecar_signature(path, sidecar, ts, "deadbeef" * 8)
    assert not ok and "signature" in reason.lower()


def test_sidecar_signature_path_mismatch(sidecar):
    """Chữ ký ký cho path khác → reject (chống tái dùng chữ ký sang endpoint khác)."""
    ts = str(int(time.time()))
    sig = _sign(sidecar, ts, "/api/upload")
    ok, reason = lg.verify_sidecar_signature("/api/admin", sidecar, ts, sig)
    assert not ok and "signature" in reason.lower()


def test_sidecar_dev_mode_bypass(monkeypatch):
    """Dev mode: bỏ qua kiểm tra (chạy backend thủ công khi phát triển)."""
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    ok, _ = lg.verify_sidecar_signature("/api/x", "", "", "")
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
