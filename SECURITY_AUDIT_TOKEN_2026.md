# Token Lifecycle — Security Audit Findings

## Architecture Trace (Entry → Sink)

### Entry Point
- **Desktop (Tauri)** → CLI invokes Tauri `sign_api_request(path, license_key)` 
- Tauri gate #1: license must be in `VALIDATED_KEYS` cache (desktop/src-tauri/src/security.rs:385-407)
- Returns HMAC headers `X-PrynX-Token`, `X-PrynX-Timestamp`, `X-PrynX-Signature` → sidecar
- **Sidecar (Python)** → FastAPI `require_license()` dependency (backend/app/core/license_guard.py:259)

### Token Verification Chain
1. `verify_sidecar_signature()` (L145-184) — HMAC on ts:path, 30s window
2. `_enforce_license_token()` (L208-214) — check if enforcement enabled
3. `verify_license_token()` (L222-256) — Ed25519 sig + exp + hwid + key
4. Supabase RPC fallback (L327-340) if token invalid

---

## FINDINGS

### [VERIFIED] 🔴 VECTOR #1: FAIL-OPEN when PRYNX_ENFORCE_LICENSE_TOKEN unset
**Code:** backend/app/core/license_guard.py:214, 297-310

**Issue:**
- Default: env var unset → `_enforce_license_token()` = False
- L297: `if _enforce_license_token():` → SKIPPED when False
- L311: `elif lic_token:` → only logs warning, does NOT block
- Token check skipped, request continues to cache/Supabase

**Attack:** Attacker unsets PRYNX_ENFORCE_LICENSE_TOKEN or triggers Supabase offline
→ cache fallback (L338) allows access for 5 min with no validation

**Severity:** 🔴 CRITICAL

---

### [VERIFIED] 🔴 VECTOR #2: REPLAY via Client Clock Rollback
**Code:** backend/app/core/license_guard.py:241

**Issue:**
- `int(time.time())` = server (sidecar) local clock
- No server-time in token, no nonce
- Attacker sets system clock backward → expired token becomes fresh

**Attack:** Token exp=T+2h → use until T+1.5h → set clock back → use until T+3h

**Mitigation:** Client has clock-detection (useAuthStore.ts:362-384) but only if lastOnline exists
→ First offline use = no defense

**Severity:** 🔴 CRITICAL

---

### [VERIFIED] 🔴 VECTOR #3: HWID Binding Bypass (Empty String)
**Code:** backend/app/core/license_guard.py:247

**Issue:**
```
if hwid and payload.get("m") and not hmac_mod.compare_digest(...):
```

Client sends `X-Hardware-Id: ""` (empty) → `if hwid` = False → check SKIPPED

**Attack:** Token issued for MACHINE-A can be used on ANY machine if client omits hwid header

**Severity:** 🔴 CRITICAL — License sharing

---

### [VERIFIED] 🔴 VECTOR #4: Key Binding Bypass (Empty String)
**Code:** backend/app/core/license_guard.py:251

**Issue:**
```
if license_key and payload.get("k"):
```

Client sends `X-License-Key: ""` → check SKIPPED

**Attack:** Same token used with different keys or shared across customers

**Severity:** 🔴 CRITICAL

---

### [VERIFIED] 🟠 VECTOR #5: Supabase Credentials Unset = Silent Allow
**Code:** backend/app/core/license_guard.py:348-350

**Issue:**
```python
if not supabase_url or not supabase_key:
    logger.debug("...")
    return True  # Allow
```

Missing env vars → returns True, only debug log (silent in production)

**Attack:** Attacker unsets SUPABASE_URL / SUPABASE_SERVICE_KEY → all licenses pass

**Severity:** 🟠 HIGH

---

### [VERIFIED] 🟠 VECTOR #6: DNS Manipulation to Localhost Bypass
**Code:** backend/app/core/license_guard.py:362-367

**Issue:**
- Code detects DNS manipulation (L362: loopback/private IP)
- Raises RuntimeError → caught by except (L335) → grace cache (L338)
- Attacker triggers DNS failure → Supabase offline → 5min grace granted

**Severity:** 🟠 MEDIUM (mitigated by detection, but grace window still allows use)

---

### [VERIFIED] 🟠 VECTOR #7: HWID/Key Optional in Token Payload
**Code:** backend/app/core/license_guard.py:247, 251

**Issue:**
- Edge function can issue token with MISSING "m" or "k" fields
- Backend: `if hwid and payload.get("m")` → both conditions required
- If token lacks "m", HWID binding disabled entirely

**Attack:** Malicious server or edge function bug → issue tokens without HWID binding

**Severity:** 🟠 MEDIUM (requires compromised Supabase)

---

## Summary

**CRITICAL (4):** Fail-open enforce flag, clock replay, HWID bypass, key bypass
**HIGH (1):** Supabase credentials missing silent allow
**MEDIUM (2):** DNS graceful fail, token field optional

**Root Cause:** Token verification is optional/conditional, not mandatory + client-side time trust

