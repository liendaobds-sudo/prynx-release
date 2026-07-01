# Token Lifecycle — Security Audit Findings

> ## ⚠️ TRẠNG THÁI: ĐÃ KHẮC PHỤC (cập nhật 2026-06-26) — ĐỌC PHẦN NÀY TRƯỚC
>
> **Toàn bộ 4 lỗi 🔴 CRITICAL + các 🟠 liệt kê BÊN DƯỚI đã được vá.** Bản gốc dưới đây
> phản ánh trạng thái code TẠI THỜI ĐIỂM phát hiện, GIỮ LẠI để truy vết lịch sử.
> Đừng dùng nó để đánh giá rủi ro hiện tại. Đối chiếu chéo: `SECURITY_AUDIT_2026-06-20.md`
> (đợt vá chính) + `SECURITY_ARCHITECTURE.md` Mục 8–10.
>
> | # gốc | Phát hiện | Trạng thái hiện tại (đã VERIFIED bằng code/chạy) |
> |---|---|---|
> | V#1 | Fail-open khi `PRYNX_ENFORCE_LICENSE_TOKEN` unset | ✅ VÁ. `_enforce_license_token()` trả **True bất kể env** khi không phải dev (`license_guard.py`). Chạy thật `DEV_MODE=false` → `enforce=True`. |
> | V#2 | Replay bằng lùi đồng hồ client | ✅ VÁ (2 lớp). `_clock_guard()` (mốc đơn điệu ký HMAC) + **V3 cận trên tuổi thọ token** (deletion-proof, `_MAX_TOKEN_LIFETIME_SECONDS`) — chặn replay token cũ khi lùi giờ. |
> | V#3 | Bypass ràng HWID bằng chuỗi rỗng | ✅ VÁ. `require_license` raise **401** nếu thiếu `X-Hardware-Id` ở production (chuỗi rỗng không lọt) + token bắt buộc field `m`. |
> | V#4 | Bypass ràng key bằng chuỗi rỗng | ✅ VÁ. Tương tự V#3: thiếu `X-License-Key` → 401; token bắt buộc field `k`. |
> | V#5 | Thiếu Supabase creds = silent allow | ✅ THEO THIẾT KẾ (không còn silent). Sidecar không giữ service key; biên giới THẬT là token Ed25519 đã enforce. Log rõ `SUPABASE_CREDS_MISSING relying_on_signed_token`. |
> | V#6 | DNS fail → grace 5' | 🟢 Chấp nhận (Ring-3 ceiling). Grace ngắn + token Ed25519 vẫn enforce. |
> | V#7 | Field HWID/key optional trong token | ✅ VÁ. `verify_license_token` nay **bắt buộc** `m` và `k` (token thiếu → từ chối). |
>
> **Residual (cố hữu, không phải bug):** `_clock_guard` dựa trên file `.clkguard` có thể bị
> XOÁ để reset mốc → cho phép một lần lùi đồng hồ NHỎ (chỉ kéo dài token 2h đã cấp; đòi
> quyền local admin). Đã giảm thiểu bằng V3 (cận trên tuổi thọ, không state trên đĩa, bắt
> được lùi giờ lớn). Triệt để cần nguồn thời gian tin cậy từ server — đánh đổi luồng offline.

---

## (LỊCH SỬ) Architecture Trace (Entry → Sink)

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

