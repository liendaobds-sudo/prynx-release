"""Test xác minh token license do server ký (Ed25519) trong license_guard.

Test tự sinh cặp khóa riêng, monkeypatch public key của module → không phụ thuộc
khóa thật. Mô phỏng đúng cách edge function sẽ ký (ký trên chuỗi payload_b64url).
"""
import base64
import json
import time
import uuid

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


BOUND_KEY = "ABCDE-FGHIJ-KLMNO"
BOUND_HWID = "HW123"
BOUND_LICENSE_TOKEN = "SIGNED_LICENSE_TOKEN"


def _sign(token: str, ts: str, path: str, nonce: str | None = None) -> tuple[str, str]:
    """Dựng chữ ký HMAC như Rust `sign_api_request` → trả (signature, nonce).

    Payload PHẢI khớp Rust: ts:nonce:path:key:hwid:sha256(token) (audit 2026-07-25).
    """
    if nonce is None:
        nonce = uuid.uuid4().hex
    token_hash = hashlib.sha256(BOUND_LICENSE_TOKEN.encode()).hexdigest()
    payload = f"{ts}:{nonce}:{path}:{BOUND_KEY}:{BOUND_HWID}:{token_hash}"
    return _hmac.new(token.encode(), payload.encode(), hashlib.sha256).hexdigest(), nonce


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


# ── V2: anti-clockback (monotonic clock guard) ───────────────────────────────
@pytest.fixture
def clk(monkeypatch, tmp_path):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "CLKTOKEN_TEST")
    p = str(tmp_path / ".clkguard")
    monkeypatch.setenv("PRYNX_CLOCK_GUARD_FILE", p)
    return p


def test_clock_guard_detects_rollback(clk):
    lg._clk_write(clk, int(time.time()) + 100_000)  # đã thấy thời gian xa hơn
    ok, reason = lg._clock_guard()                   # now lùi nhiều so với mốc
    assert not ok and "rollback" in reason.lower()


def test_clock_guard_allows_forward(clk):
    lg._clk_write(clk, int(time.time()) - 100)  # mốc cũ → now tiến lên: hợp lệ
    ok, _ = lg._clock_guard()
    assert ok


def test_clock_guard_tamper_resets(clk):
    # Ghi giá trị tương lai NHƯNG chữ ký sai (tamper) → bị bỏ qua → không reject.
    with open(clk, "w", encoding="utf-8") as f:
        f.write(f"{int(time.time()) + 100_000}:badsig")
    ok, _ = lg._clock_guard()
    assert ok


def test_clock_guard_dev_bypass(monkeypatch):
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: True)
    ok, _ = lg._clock_guard()
    assert ok


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
