"""
License Guard Middleware for PrynX Backend.

Security model:
1. Every API request must include headers:
   - X-PrynX-Timestamp + X-PrynX-Signature: a short-lived HMAC proof generated
     by the Tauri host. The shared secret is never exposed to the WebView.
   - X-License-Key: The user's license key (for watermarking/audit trail).
   - X-Hardware-Id: The machine's HWID (for watermarking/audit trail).

2. The shared token is generated at app startup by the Tauri host and passed
   to the sidecar through its stdin pipe.
   External callers cannot know this token.

3. For an extra layer, we can optionally verify the license key against
   Supabase RPC on first use, then cache the result for the session.
"""

import os
import logging
import hashlib
import hmac as hmac_mod
import time
import json
import base64
from typing import Optional
from app.core.feature_entitlements import assert_feature
from fastapi import Request, HTTPException, Depends

logger = logging.getLogger(__name__)


def _security_diag_enabled() -> bool:
    """Ghi security.log ra đĩa CHỈ khi dev CHỦ ĐỘNG bật để xác minh bản release.

    Mặc định TẮT trên máy khách: tránh để lại 'bản đồ trinh sát' (trạng thái enforce,
    nguồn pubkey, lý do từ chối token...) cho kẻ tấn công đọc file. Telemetry bảo mật
    thật vẫn đi qua Supabase `security_logs` (không phụ thuộc file cục bộ này).

    Bật bằng MỘT trong hai (để verify trên bản đã cài):
      - đặt biến môi trường PRYNX_SECURITY_DIAG=1 trước khi mở app, HOẶC
      - tạo file rỗng %APPDATA%\\PrynX\\logs\\.security_diag
    """
    try:
        if os.environ.get("PRYNX_SECURITY_DIAG", "").strip().lower() in ("1", "true", "yes"):
            return True
        base = os.environ.get("APPDATA") or os.environ.get("HOME") or os.path.expanduser("~")
        return os.path.isfile(os.path.join(base, "PrynX", "logs", ".security_diag"))
    except Exception:
        return False


def _security_log_to_file(msg: str) -> None:
    """Ghi 1 dòng trạng thái bảo mật ra file để DEV kiểm chứng trên bản cài (release).

    - CHỈ ghi khi diagnostic được bật (`_security_diag_enabled`) → mặc định KHÔNG để
      lại file trên máy khách (giảm rò thông tin cho kẻ trinh sát).
    - KHÔNG ghi dữ liệu nhạy cảm (license key/token thô) — chỉ cờ trạng thái + lý do generic.
    - Best-effort: mọi lỗi đều nuốt, không bao giờ ảnh hưởng luồng xử lý.
    """
    try:
        if not _security_diag_enabled():
            return
        base = os.environ.get("APPDATA") or os.environ.get("HOME") or os.path.expanduser("~")
        log_dir = os.path.join(base, "PrynX", "logs")
        os.makedirs(log_dir, exist_ok=True)
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(log_dir, "security.log"), "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass

# ── Shared sidecar token ──
# VECTOR #1 FIX: Token is loaded from a temp file (not env var).
# The Tauri host writes the token to a file in AppData, passes the path
# via PRYNX_TOKEN_FILE env var. We read it once and delete immediately.
# This prevents other processes from reading the token via env var inspection.
_SIDECAR_TOKEN: Optional[str] = None

def _is_dev_mode() -> bool:
    """Check DEV_MODE lazily — ensures .env has been loaded by pydantic.

    PRODUCTION HARDENING (fail-closed): nếu đang chạy dưới dạng BINARY ĐÃ COMPILE
    (Nuitka --onefile khi release, hoặc PyInstaller), thì TUYỆT ĐỐI KHÔNG bao giờ
    là dev mode — kể cả khi kẻ gian trích exe sidecar chạy TRỰC TIẾP (không qua
    Tauri) rồi cố set env/.env DEV_MODE=true để tắt verify chữ ký + enforce token.
    Cờ '__compiled__' do Nuitka chèn vào mọi module đã compile, không thể gỡ.
    Dev (chạy Python thông dịch) không có cờ này → vẫn đọc DEV_MODE từ .env như cũ.
    """
    import sys
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        return False
    try:
        from app.config import settings
        return settings.DEV_MODE
    except Exception:
        return os.environ.get("DEV_MODE", "false").lower() in ("true", "1", "yes")

def _load_token_from_file():
    """Load sidecar token from stdin pipe or temp file, then clean up."""
    global _SIDECAR_TOKEN
    
    # Method 1: stdin pipe (VECTOR #6 FIX — token never on disk)
    token_source = os.environ.get("PRYNX_TOKEN_SOURCE", "")
    if token_source == "stdin":
        try:
            import sys
            if sys.stdin and not sys.stdin.isatty():
                line = sys.stdin.readline().strip()
                if line.startswith("TOKEN:"):
                    _SIDECAR_TOKEN = line[6:]
                    logger.info("[LICENSE_GUARD] Sidecar token loaded from stdin pipe")
                    return
        except Exception as e:
            logger.error(f"[LICENSE_GUARD] Failed to read token from stdin: {e}")
    
    # Method 2: Try file-based token (legacy / fallback)
    token_file = os.environ.get("PRYNX_TOKEN_FILE", "")
    if token_file and os.path.isfile(token_file):
        try:
            with open(token_file, 'r') as f:
                _SIDECAR_TOKEN = f.read().strip()
            # Delete the file immediately after reading
            os.remove(token_file)
            logger.info("[LICENSE_GUARD] Sidecar token loaded from file and file deleted")
            return
        except Exception as e:
            logger.error(f"[LICENSE_GUARD] Failed to read token file: {e}")
    
    # Method 3: Fallback env var (legacy / dev mode)
    _SIDECAR_TOKEN = os.environ.get("PRYNX_SIDECAR_TOKEN")
    if _SIDECAR_TOKEN:
        logger.info("[LICENSE_GUARD] Sidecar token loaded from env var (legacy mode)")

# Load token at import time
_load_token_from_file()

# #1: trạng thái cưỡng chế token + nguồn token lúc khởi động — dùng logger.DEBUG để
# KHÔNG rò posture (enforce/dev_mode/pubkey) vào app.log mặc định. security.log (gated
# bởi _security_diag_enabled) là kênh xác minh khi dev bật diagnostic.
try:
    logger.debug(
        "[LICENSE_GUARD] startup: enforce_license_token=%s, dev_mode=%s, sidecar_token=%s, pubkey_source=%s",
        os.environ.get("PRYNX_ENFORCE_LICENSE_TOKEN", "false"),
        _is_dev_mode(),
        "set" if _SIDECAR_TOKEN else "MISSING",
        "env" if (_is_dev_mode() and os.environ.get("PRYNX_LICENSE_PUBLIC_KEY", "").strip()) else "embedded",
    )
    _security_log_to_file(
        "STARTUP enforce_license_token={} dev_mode={} sidecar_token={} pubkey={}".format(
            os.environ.get("PRYNX_ENFORCE_LICENSE_TOKEN", "false"),
            _is_dev_mode(),
            "set" if _SIDECAR_TOKEN else "MISSING",
            "env" if (_is_dev_mode() and os.environ.get("PRYNX_LICENSE_PUBLIC_KEY", "").strip()) else "embedded",
        )
    )
except Exception:
    pass

# ── License cache (avoid hammering Supabase on every request) ──
# key: hash(license_key + hwid), value: (is_valid, expire_timestamp)
_license_cache: dict[str, tuple[bool, float]] = {}
_CACHE_TTL_SECONDS = 30 * 60  # 30 minutes


def _hash_credentials(license_key: str, hwid: str) -> str:
    return hashlib.sha256(f"{license_key}:{hwid}".encode()).hexdigest()


def verify_sidecar_signature(
    url_path: str,
    ts: str,
    sig: str,
    license_key: str,
    hwid: str,
    license_token: str,
) -> tuple[bool, str]:
    """
    Nguồn chân lý duy nhất để xác thực một request đến từ Tauri host (không phải caller ngoài).
    Dùng chung cho HTTP (require_license) lẫn WebSocket (ws.py).

    Kiểm tra chữ ký HMAC-SHA256 trên timestamp, path và hash của bộ credentials
    đã được Rust xác minh (cửa sổ 30s). Shared secret chỉ tồn tại trong Rust host
    và Python sidecar; WebView không bao giờ nhận secret.
    Trả về (ok, reason). Bỏ qua hoàn toàn ở dev mode.
    """
    # Dev mode: không ép token/chữ ký (chạy backend thủ công khi phát triển).
    if _is_dev_mode():
        return True, ""

    if not _SIDECAR_TOKEN:
        logger.warning("[LICENSE_GUARD] PRYNX_SIDECAR_TOKEN not set — rejecting request")
        return False, "Server configuration error: missing sidecar token."

    if not ts or not sig:
        return False, "Missing request signature"
    if not license_key or not hwid or not license_token:
        return False, "Missing signed license credentials"

    try:
        ts_int = int(ts)
    except (TypeError, ValueError):
        return False, "Invalid timestamp"

    now = int(time.time())
    if abs(now - ts_int) > 30:  # 30-second window — chống replay
        return False, "Request expired (timestamp too old)"

    token_hash = hashlib.sha256(license_token.encode()).hexdigest()
    sign_payload = f"{ts}:{url_path}:{license_key}:{hwid}:{token_hash}"
    expected_hex = hmac_mod.new(
        _SIDECAR_TOKEN.encode(), sign_payload.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac_mod.compare_digest(sig, expected_hex):
        return False, "Invalid request signature"

    return True, ""


# ── Server-signed license token (VECTOR: bỏ tin client) ──────────────────────
# Edge function Supabase ký token bằng PRIVATE key (giữ ở server); sidecar verify bằng
# PUBLIC key dưới đây. Client bị crack KHÔNG giả được token (không có private key).
# Token ngắn hạn → buộc tái xác thực online định kỳ; thu hồi license có hiệu lực nhanh.
#
# BẢO MẬT (quan trọng): public key là TRUST ANCHOR — phải NHÚNG CỨNG trong binary và
# KHÔNG được cho phép thay lúc runtime ở production. Nếu cho đọc từ env/file lúc chạy,
# kẻ crack chỉ cần đặt PRYNX_LICENSE_PUBLIC_KEY = <key của hắn> trước khi mở app →
# tự ký token bằng private key của hắn → giả license hợp lệ. Vì vậy:
#   - PRODUCTION: LUÔN dùng giá trị nhúng cứng bên dưới (env bị BỎ QUA).
#   - DEV (DEV_MODE=true): cho phép override qua env để test với cặp khóa riêng.
_LICENSE_PUBLIC_KEY_B64 = "AxpiZnEFXady9wI01spdMRrTNtEthMD30W/90gi27Zk="

# Dev-only override (production bỏ qua hoàn toàn — chống tráo trust anchor qua env).
if _is_dev_mode():
    _dev_pubkey = os.environ.get("PRYNX_LICENSE_PUBLIC_KEY", "").strip()
    if _dev_pubkey:
        _LICENSE_PUBLIC_KEY_B64 = _dev_pubkey
        logger.warning("[LICENSE_GUARD] DEV: public key overridden via env (dev-only).")


def _enforce_license_token() -> bool:
    """Bật cưỡng chế token. V1 FIX (fail-CLOSED): khi chạy BINARY PRODUCTION
    (không phải dev — xem `_is_dev_mode`), LUÔN cưỡng chế bất kể env. Chống kẻ gian
    trích sidecar chạy trực tiếp rồi bỏ `PRYNX_ENFORCE_LICENSE_TOKEN` để tắt token check.
    Dev (Python thông dịch, DEV_MODE=true) mới đọc env (mặc định tắt để không gãy luồng cũ).
    """
    if not _is_dev_mode():
        return True
    return os.environ.get("PRYNX_ENFORCE_LICENSE_TOKEN", "false").lower() in ("true", "1", "yes")


# ── V2: chống lùi đồng hồ (anti-clockback) phía sidecar ──────────────────────
_CLOCK_SKEW_SECONDS = 300  # dung sai NTP 5 phút

# V3 (deletion-proof): cận trên tuổi thọ token. Token do edge function ký có TTL 2h;
# tuổi thọ hợp lệ (exp - now) LUÔN ≤ TTL ngay sau khi cấp và giảm dần về 0. Nếu
# (exp - now) VƯỢT cận này nghĩa là đồng hồ đã bị LÙI xa so với lúc token được cấp
# → replay token cũ bằng cách quay ngược giờ. Khác với `_clock_guard` (dựa trên file
# có thể bị XOÁ để reset mốc), kiểm tra này KHÔNG có trạng thái trên đĩa nên không
# thể vô hiệu bằng cách xoá file. Để dư 1h trên TTL nhằm không false-positive nếu
# chính sách TTL đổi nhẹ; phải LUÔN ≥ TTL token thật. Có thể chỉnh qua env (dev/test).
_MAX_TOKEN_LIFETIME_SECONDS = int(
    os.environ.get("PRYNX_MAX_TOKEN_LIFETIME_SECONDS", str(8 * 24 * 60 * 60))  # mặc định 8 ngày (TTL server 7 ngày + 1 ngày dư)
)


def _clock_guard_path() -> str:
    override = os.environ.get("PRYNX_CLOCK_GUARD_FILE", "")
    if override:
        return override
    base = os.environ.get("APPDATA") or os.environ.get("HOME") or os.path.expanduser("~")
    return os.path.join(base, "PrynX", ".clkguard")


def _clk_read(path: str) -> Optional[int]:
    """Đọc mốc thời gian lớn nhất đã thấy (ký HMAC bằng sidecar token).
    Trả None nếu thiếu/không đọc được/CHỮ KÝ SAI (tamper) → coi như chưa có mốc."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        ts_str, sig = raw.split(":", 1)
        if not _SIDECAR_TOKEN:
            return None
        expected = hmac_mod.new(_SIDECAR_TOKEN.encode(), ts_str.encode(), hashlib.sha256).hexdigest()
        if not hmac_mod.compare_digest(sig, expected):
            return None  # tamper: không cho dùng giá trị → reset (không brick)
        return int(ts_str)
    except Exception:
        return None


def _clk_write(path: str, ts: int) -> None:
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        if not _SIDECAR_TOKEN:
            return
        sig = hmac_mod.new(_SIDECAR_TOKEN.encode(), str(ts).encode(), hashlib.sha256).hexdigest()
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{ts}:{sig}")
    except Exception:
        pass


def _clock_guard() -> tuple[bool, str]:
    """Monotonic clock guard: từ chối nếu đồng hồ bị LÙI quá xa so với mốc lớn nhất
    đã thấy (chống replay token hết hạn bằng cách quay ngược giờ). Mốc ký HMAC bằng
    sidecar token nên kẻ gian KHÔNG sửa được xuống giá trị thấp. Bỏ qua ở dev.
    Thiếu/tamper file → reset (không brick), vẫn cập nhật mốc hiện tại.
    """
    if _is_dev_mode():
        return True, ""
    path = _clock_guard_path()
    now = int(time.time())
    stored = _clk_read(path)
    if stored is not None and now + _CLOCK_SKEW_SECONDS < stored:
        return False, "Clock rollback detected"
    _clk_write(path, max(stored or 0, now))
    return True, ""


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def verify_license_token(token: str, hwid: str = "", license_key: str = "") -> tuple[bool, str]:
    """Xác minh token license do server ký (Ed25519).

    Token định dạng: "<payload_b64url>.<sig_b64url>" — chữ ký ký trên CHUỖI payload_b64url.
    payload JSON: {"k": sha256(license_key)[:16], "m": machine_id, "p": product_id, "exp": unix}
    Trả (ok, reason).
    """
    if not token or "." not in token:
        return False, "Missing/malformed license token"
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        payload_b64, sig_b64 = token.split(".", 1)
        pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(_LICENSE_PUBLIC_KEY_B64))
        pub.verify(_b64url_decode(sig_b64), payload_b64.encode("ascii"))  # raise nếu sai
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return False, "Invalid license token signature"

    try:
        if int(payload.get("exp", 0)) < int(time.time()):
            return False, "License token expired"
    except (TypeError, ValueError):
        return False, "License token has invalid exp"

    # V3 (deletion-proof anti-rollback): token KHÔNG được "tươi" quá tuổi thọ tối đa.
    # Nếu exp xa hiện tại hơn _MAX_TOKEN_LIFETIME_SECONDS → đồng hồ đã bị lùi xa so với
    # lúc cấp token (replay token cũ). Không phụ thuộc file trên đĩa nên không thể bypass
    # bằng cách xoá `.clkguard`. Bỏ qua ở dev (đồng hồ/clock test không ràng buộc).
    if not _is_dev_mode():
        try:
            exp_val = int(payload.get("exp", 0))
            if exp_val - int(time.time()) > _MAX_TOKEN_LIFETIME_SECONDS + _CLOCK_SKEW_SECONDS:
                return False, "License token lifetime implausible (clock rollback?)"
        except (TypeError, ValueError):
            return False, "License token has invalid exp"

    # Ràng buộc theo máy — field "m" phải có trong token (không optional).
    token_hwid = payload.get("m")
    if not token_hwid:
        return False, "License token missing required field: machine id"
    if hwid and not hmac_mod.compare_digest(str(token_hwid), hwid):
        return False, "License token machine mismatch"

    # Ràng buộc theo license key — field "k" phải có trong token (không optional).
    token_key_hash = payload.get("k")
    if not token_key_hash:
        return False, "License token missing required field: key hash"
    if license_key:
        kh = hashlib.sha256(license_key.encode()).hexdigest()[:16]
        if not hmac_mod.compare_digest(str(token_key_hash), kh):
            return False, "License token key mismatch"

    return True, ""


def _read_verified_entitlements(token: str) -> dict:
    """Read entitlement claims only after verify_license_token returned True."""
    try:
        payload_b64 = token.split(".", 1)[0]
        payload = json.loads(_b64url_decode(payload_b64))
        plan = str(payload.get("plan") or "free").strip().lower()
        if plan not in ("free", "pro", "dev"):
            plan = "free"
        features = payload.get("features")
        if not isinstance(features, list):
            features = None
        else:
            features = [item for item in features if isinstance(item, str)]
        return {"plan": plan, "features": features}
    except Exception:
        return {"plan": "free", "features": None}


def _license_context(license_key: str, hwid: str, verified: bool, entitlements: dict | None = None) -> dict:
    rights = entitlements or {"plan": "free", "features": None}
    return {
        "license_key": license_key,
        "hwid": hwid,
        "verified": verified,
        "plan": rights.get("plan") or "free",
        "features": rights.get("features"),
    }

async def require_license(request: Request) -> dict:
    """
    FastAPI dependency that enforces license verification on every request.
    
    Usage in routes:
        from app.core.license_guard import require_license
        
        @router.post("/my-endpoint")
        async def my_endpoint(body: dict, license_info: dict = Depends(require_license)):
            # license_info contains {"license_key": "...", "hwid": "...", "verified": True}
            ...
    """
    # Read the credential binding before checking the HMAC. Rust signs these exact
    # values, so the WebView cannot swap a registered Free identity for a stolen
    # Pro token after obtaining a valid sidecar signature.
    license_key = request.headers.get("X-License-Key", "").strip()
    hwid = request.headers.get("X-Hardware-Id", "").strip()
    lic_token = request.headers.get("X-License-Token", "").strip()
    # ── Step 1: Verify credential-bound HMAC signature (skipped in dev mode) ──
    # VECTOR #1/#4 FIX: dùng nguồn chân lý duy nhất verify_sidecar_signature().
    ok, reason = verify_sidecar_signature(
        request.url.path,
        request.headers.get("X-PrynX-Timestamp", ""),
        request.headers.get("X-PrynX-Signature", ""),
        license_key,
        hwid,
        lic_token,
    )
    if not ok:
        raise HTTPException(status_code=403, detail=reason)

    # ── Step 1b: V2 anti-clockback — chống lùi đồng hồ để replay token hết hạn (skip ở dev) ──
    clk_ok, clk_reason = _clock_guard()
    if not clk_ok:
        logger.warning("[LICENSE_GUARD] %s | path=%s", clk_reason, request.url.path)
        _security_log_to_file(f"CLOCK_ROLLBACK reason={clk_reason!r} path={request.url.path}")
        raise HTTPException(status_code=403, detail="Clock manipulation detected")
    
    # ── Step 2: Extract license credentials ──
    if not license_key or not hwid:
        # In dev mode, allow requests without credentials but log a warning
        if _is_dev_mode():
            logger.debug("[LICENSE_GUARD] Dev mode: allowing request without credentials")
            return _license_context("DEV_MODE", "DEV_MODE", False, {"plan": "dev", "features": ["*"]})
        raise HTTPException(status_code=401, detail="Missing license credentials (X-License-Key, X-Hardware-Id)")
    
    # ── Step 2b: Verify server-signed license token (chống client tự phong hợp lệ) ──
    # Token do edge function Supabase ký; sidecar verify bằng public key nhúng sẵn.
    # Rollout an toàn: nếu CHƯA bật cưỡng chế thì chỉ verify-nếu-có (log), không chặn.
    token_entitlements = {"plan": "free", "features": None}
    if _enforce_license_token():
        tok_ok, tok_reason = verify_license_token(lic_token, hwid, license_key)
        if not tok_ok:
            # #6: log rõ khi token bị từ chối (telemetry chẩn đoán + phát hiện tấn công).
            logger.warning(
                "[LICENSE_GUARD] License token REJECTED (enforced): %s | path=%s | token_present=%s",
                tok_reason, request.url.path, bool(lic_token),
            )
            _security_log_to_file(
                "TOKEN_REJECTED reason={!r} path={} token_present={}".format(
                    tok_reason, request.url.path, bool(lic_token)
                )
            )
            raise HTTPException(status_code=403, detail=f"License token rejected: {tok_reason}")
        token_entitlements = _read_verified_entitlements(lic_token)
    elif lic_token:
        tok_ok, tok_reason = verify_license_token(lic_token, hwid, license_key)
        if not tok_ok:
            logger.warning(f"[LICENSE_GUARD] License token present but invalid (not enforced yet): {tok_reason}")
        else:
            token_entitlements = _read_verified_entitlements(lic_token)
    
    # ── Step 3: Check cache ──
    cache_key = _hash_credentials(license_key, hwid)
    cached = _license_cache.get(cache_key)
    if cached:
        is_valid, expire_at = cached
        if time.time() < expire_at:
            if is_valid:
                return _license_context(license_key, hwid, True, token_entitlements)
            else:
                raise HTTPException(status_code=403, detail="License key is invalid or has been revoked.")
    
    # ── Step 4: Verify with Supabase (optional, for online validation) ──
    try:
        verified = await _verify_with_supabase(license_key, hwid)
        _license_cache[cache_key] = (verified, time.time() + _CACHE_TTL_SECONDS)
        if not verified:
            raise HTTPException(status_code=403, detail="License key is invalid or has been revoked.")
    except HTTPException:
        raise
    except RuntimeError as e:
        # DNS manipulation detected — hard fail, no grace
        logger.error(f"[LICENSE_GUARD] Security violation (DNS/integrity): {e}")
        _security_log_to_file(f"SECURITY_VIOLATION reason={e}")
        raise HTTPException(status_code=403, detail="Security violation")
    except Exception as e:
        import httpx as _httpx
        if isinstance(e, (_httpx.TimeoutException, _httpx.ConnectError, _httpx.RemoteProtocolError)):
            # Genuine network unavailability — offline grace 5 phút
            logger.warning(f"[LICENSE_GUARD] Supabase unreachable (offline grace): {e}")
            _security_log_to_file(f"OFFLINE_GRACE reason={type(e).__name__}")
            _license_cache[cache_key] = (True, time.time() + 300)
        else:
            # Lỗi không xác định — fail closed
            logger.error(f"[LICENSE_GUARD] Unexpected error during license check: {e}")
            _security_log_to_file(f"LICENSE_CHECK_ERROR reason={type(e).__name__}")
            raise HTTPException(status_code=403, detail="License check unavailable")

    return _license_context(license_key, hwid, True, token_entitlements)


def enforce_feature(feature_id: str, license_info: dict) -> dict:
    """Enforce a feature when the route chooses its entitlement dynamically."""
    try:
        assert_feature(feature_id, license_info)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return license_info


def require_feature(feature_id: str):
    """FastAPI dependency enforcing a named entitlement after signed-token validation."""
    async def dependency(license_info: dict = Depends(require_license)) -> dict:
        return enforce_feature(feature_id, license_info)
    return dependency


async def _verify_with_supabase(license_key: str, hwid: str) -> bool:
    """Verify license against Supabase RPC."""
    supabase_url = os.environ.get("SUPABASE_URL", "")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    
    if not supabase_url or not supabase_key:
        # V5 FIX: KHÔNG còn "silent allow". Ở production, thiếu service key là CHỦ Ý
        # (sidecar không giữ service key — chỉ edge function có); biên giới THẬT là token
        # Ed25519 đã enforce+verify ở Step 2b (V1 ép enforce ở binary). Log rõ (không debug
        # thầm lặng) để ops thấy; vẫn trust token đã verify thay vì gọi RPC bằng service key.
        if not _is_dev_mode():
            _security_log_to_file("SUPABASE_CREDS_MISSING relying_on_signed_token")
            logger.info("[LICENSE_GUARD] No Supabase service creds — relying on verified Ed25519 token")
        else:
            logger.debug("[LICENSE_GUARD] dev: no Supabase creds — skipping online verification")
        return True  # token đã là biên giới (V1 enforce); ở dev thì bỏ qua online
    
    # ── VECTOR #2 FIX: DNS manipulation detection ──
    # Verify Supabase host resolves to a public IP, not loopback/private.
    try:
        import socket
        from urllib.parse import urlparse
        host = urlparse(supabase_url).hostname
        if host:
            resolved = socket.gethostbyname(host)
            import ipaddress
            ip = ipaddress.ip_address(resolved)
            if ip.is_loopback or ip.is_private or ip.is_reserved:
                logger.error(f"[LICENSE_GUARD] DNS manipulation detected: {host} → {resolved}")
                raise RuntimeError(f"DNS manipulation: Supabase resolved to {resolved}")
    except (socket.gaierror, ValueError) as dns_err:
        logger.warning(f"[LICENSE_GUARD] DNS resolution failed for Supabase: {dns_err}")
        raise RuntimeError(f"DNS resolution error: {dns_err}")
    
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{supabase_url}/rest/v1/rpc/verify_license",
                json={
                    "p_license_key": license_key,
                    "p_machine_id": hwid,
                    "p_product_id": "prynx"
                },
                headers={
                    "apikey": supabase_key,
                    "Authorization": f"Bearer {supabase_key}",
                    "Content-Type": "application/json"
                }
            )
        
        if resp.status_code == 200:
            data = resp.json()
            return data and data.get("status") == "VALID"
        else:
            logger.warning(f"[LICENSE_GUARD] Supabase returned {resp.status_code}")
            return False
    except Exception as e:
        raise RuntimeError(f"Supabase verification error: {e}")
