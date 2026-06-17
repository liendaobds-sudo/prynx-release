# PrynX Security Architecture — Tài liệu tổng kết

> **Phiên bản:** 3.1 — Sau re-audit & hardening 2026-06-17 (xem **Mục 9**)
> **Cập nhật:** 2026-06-17
> **Mục đích:** Đọc 1 lần hiểu hết, phục vụ tham chiếu lâu dài
>
> ⚠️ **Đọc Mục 9 trước (mới nhất),** rồi Mục 8. Bản 2.0 mô tả thiết kế *dự kiến*; audit
> 2026-06-12 (Mục 8) phát hiện nhiều lớp release-only **chưa từng chạy** + lỗ hổng server.
> Re-audit 2026-06-17 (Mục 9) trace lại toàn bộ sau khi vá, bổ sung các hardening mới
> (watermark phủ toàn bộ output, fs deny, token persist offline, DEV_MODE fail-closed,
> public-key trust-anchor, security.log) và **làm rõ biên giới bảo mật thật**.
>
> **Phạm vi 2 repo:** phần client/sidecar ở `d:\pdfcompare`; phần **quản lý license + DB +
> edge function** ở repo riêng `d:\printsolutions-main` (Supabase project `ryvyuxjgdcvoxujqmggm`,
> dùng CHUNG cho mọi sản phẩm: prynx, các script .jsx, PrintMonitorApp...).

---

## 1. Kiến trúc tổng quan

```mermaid
graph TB
    subgraph "Ring 3 — User Mode"
        subgraph "Tauri Desktop App"
            FE["Frontend (WebView2)<br/>React + TypeScript"]
            RS["Rust Core<br/>(security.rs, lib.rs)"]
        end
        SC["Python Sidecar<br/>(FastAPI trên port 8321)"]
        SB["Supabase Cloud<br/>(PostgreSQL + Edge Functions)"]
    end

    FE -->|"invoke() qua IPC"| RS
    RS -->|"stdin pipe (token)"| SC
    FE -->|"HTTPS + RPC"| SB
    SC -->|"HTTPS + DNS check"| SB

    style RS fill:#2d5016,color:#fff
    style SC fill:#1a3a5c,color:#fff
    style SB fill:#4a1a5c,color:#fff
```

### Thành phần

| Thành phần | Ngôn ngữ | Vai trò bảo mật |
|---|---|---|
| **Rust Core** (`security.rs`, `lib.rs`) | Rust (compiled) | Token management, HMAC signing, DPAPI, anti-debug, process mitigation |
| **Frontend** (`main.tsx`, `api.ts`, `useAuthStore.ts`) | TypeScript (bundled) | License UI, invoke freeze, clock checks |
| **Python Sidecar** (`license_guard.py`) | Python (Nuitka compiled) | Request validation, DNS check, API gating |
| **Supabase** | PostgreSQL | License storage, HWID tracking, rate limiting |
| **Build Pipeline** (`build_production.ps1`) | PowerShell | Integrity hash generation |

---

## 2. Luồng xác thực (Authentication Flow)

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend
    participant RS as Rust Core
    participant SC as Sidecar
    participant SB as Supabase

    Note over U,SB: === KHỞI ĐỘNG ===
    RS->>RS: 1. remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
    RS->>RS: 2. SetProcessMitigationPolicy (block DLL + dynamic code)
    RS->>RS: 3. start_anti_debug_monitor (mỗi 5s)
    RS->>RS: 4. verify_frontend_integrity (hash toàn bộ dist/)
    RS->>RS: 5. Generate CSPRNG token (32 bytes)
    RS->>RS: 6. XOR-encrypt token in memory
    RS->>SC: 7. Spawn sidecar + gửi token qua stdin pipe
    SC->>SC: 8. Đọc TOKEN:xxx từ stdin, lưu vào RAM
    RS->>FE: 9. WebView2: SetAreDevToolsEnabled(false)
    FE->>FE: 10. Capture invoke → __PRYNX_INVOKE__ (frozen)

    Note over U,SB: === ĐĂNG NHẬP ===
    U->>FE: Nhập license key
    FE->>SB: supabase.rpc('verify_license', {key, hwid, product})
    SB->>SB: Rate limit check (10 req/min/IP)
    SB->>SB: HWID device limit (max 2 máy/key)
    SB-->>FE: {status: "VALID"}
    FE->>RS: invoke('register_validated_key', {key})
    FE->>RS: invoke('store_last_online', {timestampMs})
    RS->>RS: Anti-clockback check (backward + forward >25h)
    RS->>RS: DPAPI encrypt timestamp

    Note over U,SB: === MỖI API REQUEST ===
    FE->>RS: invoke('sign_api_request', {url, licenseKey})
    RS->>RS: Decrypt token (XOR), compute HMAC-SHA256
    RS-->>FE: {X-PrynX-Token, X-PrynX-Timestamp, X-PrynX-Signature}
    FE->>SC: fetch(url, {headers})
    SC->>SC: Verify token + timestamp (±30s) + HMAC signature
    SC->>SC: DNS check Supabase (reject private/loopback IP)
    SC-->>FE: Response + stealth watermark on PDF output
```

---

## 3. Bảng 15 lớp phòng thủ

### Layer 1 — Giao tiếp (Communication Security)

| # | Tấn công | Phòng thủ | File | Dòng | Chi tiết |
|---|---|---|---|---|---|
| **1** | Gọi API từ bên ngoài | CSPRNG token (32 bytes) mỗi phiên | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L221+ | Token sinh bằng `rand::thread_rng()`, truyền qua stdin |
| **2** | Replay request cũ | HMAC-SHA256 + timestamp ±30s | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L210-220 | `sign_payload = "{timestamp}:{url_path}"` |
| **3** | Đọc token từ env var | Stdin pipe, không file/env | [lib.rs](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs) | L615-640 | `child.write("TOKEN:xxx\n")` |

### Layer 2 — License Validation

| # | Tấn công | Phòng thủ | File | Dòng | Chi tiết |
|---|---|---|---|---|---|
| **4** | MITM Supabase response | DNS check: reject loopback/private IP | [license_guard.py](file:///d:/pdfcompare/backend/app/core/license_guard.py) | L170-185 | `ipaddress.ip_address(resolved).is_loopback` |
| **5** | Hosts file redirect | DNS check (vector 4 covers) + public IP required | [license_guard.py](file:///d:/pdfcompare/backend/app/core/license_guard.py) | L170-185 | VPS public IP vẫn cần valid TLS cert |
| **6** | Chia sẻ key nhiều máy | HWID device limit (max 2) | [supabase_migration.sql](file:///d:/pdfcompare/backend/supabase_security_migration.sql) | L50-120 | `COUNT(DISTINCT machine_id) >= max_devices` |
| **7** | Brute-force Supabase RPC | Rate limit 10 req/min/IP | [supabase_migration.sql](file:///d:/pdfcompare/backend/supabase_security_migration.sql) | L70-80 | + `REVOKE ALL ON licenses FROM anon` |
| **21** | Client tự phong "đã hợp lệ" | **Token ký Ed25519 do server cấp** (xem Mục 8.3) | [license_guard.py](file:///d:/pdfcompare/backend/app/core/license_guard.py) `verify_license_token()` | — | Edge function ký bằng private key (Supabase secret); sidecar verify bằng public key nhúng. Client crack không giả được. |

### Layer 3 — Offline / Clock Manipulation

| # | Tấn công | Phòng thủ | File | Dòng | Chi tiết |
|---|---|---|---|---|---|
| **8** | Lùi clock bypass grace | Anti-clockback: `new_ts + 5min < old_ts` → reject | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L320-325 | DPAPI encrypted timestamp |
| **9** | Tiến clock dần dần | Anti-forward-jump: `delta > 25h` → force online | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L330-340 | + [useAuthStore.ts](file:///d:/pdfcompare/desktop/src/stores/useAuthStore.ts) L307-320 |
| | | | [useAuthStore.ts](file:///d:/pdfcompare/desktop/src/stores/useAuthStore.ts) | L297-305 | `lastOnline > now + 60_000` = backward detected |

### Layer 4 — Code Integrity

| # | Tấn công | Phòng thủ | File | Dòng | Chi tiết |
|---|---|---|---|---|---|
| **10** | Sửa sidecar binary | SHA-256 hash at build time | [lib.rs](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs) | L476-502 | `option_env!("PRYNX_SIDECAR_HASH")` |
| **11** | Sửa frontend JS/CSS | SHA-256 recursive hash toàn bộ `dist/` | [lib.rs](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs) | L505-595 | `sha256_directory()` hash mọi file + relative path |
| **12** | Python source reverse | Nuitka compile → native C binary | [build_production.ps1](file:///d:/pdfcompare/build_production.ps1) | L60-84 | `python -m nuitka --standalone --onefile` |

### Layer 5 — Runtime Protection (Anti-Tamper)

| # | Tấn công | Phòng thủ | File | Dòng | Chi tiết |
|---|---|---|---|---|---|
| **13** | WebView2 DevTools mở | `SetAreDevToolsEnabled(false)` + kill env var | [lib.rs](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs) | L588-596, L645-665 | `remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")` |
| **14** | Ghi đè `invoke()` qua JS | Freeze `__TAURI__` + capture `__PRYNX_INVOKE__` | [main.tsx](file:///d:/pdfcompare/desktop/src/main.tsx) | L8-38 | `Object.freeze()` + `Object.defineProperty(writable:false)` |
| **15** | DLL injection (Frida) | `SetProcessMitigationPolicy` MicrosoftSignedOnly | [lib.rs](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs) | L640-685 | `ProcessSignaturePolicy` + `ProcessDynamicCodePolicy` |
| **16** | Debugger attach (x64dbg) | Anti-debug monitor mỗi 5s | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L130-220 | `IsDebuggerPresent` + `NtQueryInformationProcess(ProcessDebugPort)` |
| **17** | Hook DPAPI (Detours) | IAT hook detection | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L195-220 | Check `CryptUnprotectData` first byte ≠ `0xE9`/`0xFF`/`0xCC` |
| **18** | Scan RAM tìm token | XOR-masked token in memory | [security.rs](file:///d:/pdfcompare/desktop/src-tauri/src/security.rs) | L228-270 | `EncryptedToken { cipher, mask }`, decrypt chỉ khi `sign_api_request()` |

### Layer 6 — Truy vết (Forensics)

| # | Tấn công | Phòng thủ | File | Dòng | Chi tiết |
|---|---|---|---|---|---|
| **19** | Phát tán PDF crack | Stealth watermark: XMP + invisible text | [watermark.py](file:///d:/pdfcompare/backend/app/core/watermark.py) | L1-80 | Render mode 3 (invisible) + XMP prynx namespace |
| **20** | Hành vi đáng ngờ | Silent telemetry → Supabase `security_logs` | [useAuthStore.ts](file:///d:/pdfcompare/desktop/src/stores/useAuthStore.ts) | L121-140 | `logSecurityEvent('clock_manipulation', ...)` |

---

## 4. Ma trận tấn công → phòng thủ

```
Hacker biết dùng Fiddler (10 phút)
  └→ Chặn bởi: DNS check (#4) + cert mismatch

Hacker sửa hosts file (15 phút)
  └→ Chặn bởi: DNS check reject private IP (#5)

Hacker chỉnh clock lùi (2 phút)
  └→ Chặn bởi: Anti-clockback DPAPI (#8) + frontend check

Hacker chỉnh clock tiến (5 phút)
  └→ Chặn bởi: Forward-jump >25h → force online (#9)

Hacker mở DevTools (5 phút)
  └→ Chặn bởi: SetAreDevToolsEnabled(false) (#13) + env var killed (#13)

Hacker set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (2 phút)
  └→ Chặn bởi: remove_var() trước WebView2 init (#13)

Hacker inject JS ghi đè invoke (10 phút)
  └→ Chặn bởi: Object.freeze + __PRYNX_INVOKE__ (#14)

Hacker sửa file JS trong dist/ (20 phút)
  └→ Chặn bởi: SHA-256 recursive hash toàn bộ dist/ (#11)

Hacker share key trên forum (0 phút)
  └→ Chặn bởi: HWID limit 2 máy/key (#6)

Hacker gọi Supabase RPC trực tiếp (15 phút)
  └→ Chặn bởi: Rate limit + REVOKE table access (#7)

Hacker dùng Process Monitor bắt token (30 phút)
  └→ Chặn bởi: Stdin pipe, token không chạm disk (#3)

Hacker dùng Cheat Engine scan RAM (30 phút)
  └→ Chặn bởi: ProhibitDynamicCode policy (#15) + XOR token (#18)

Hacker dùng Frida hook (2 giờ)
  └→ Chặn bởi: MicrosoftSignedOnly DLL policy (#15)

Hacker dùng x64dbg (1 giờ)
  └→ Chặn bởi: Anti-debug monitor 5s (#16) + ProcessDebugPort

Hacker hook DPAPI (2 giờ)
  └→ Chặn bởi: IAT hook detection (#17)

Hacker ReadProcessMemory (1 giờ)
  └→ Chặn bởi: XOR-masked token (#18), phải reverse XOR logic

Hacker viết kernel driver (10+ giờ)
  └→ ⚠️ KHÔNG CHẶN ĐƯỢC — giới hạn vật lý Ring 3
```

---

## 5. File map

```
d:\pdfcompare\
├── desktop\
│   ├── src\
│   │   ├── main.tsx                    ← __TAURI__ freeze + __PRYNX_INVOKE__
│   │   ├── lib\
│   │   │   ├── api.ts                  ← authenticatedFetch + captured invoke
│   │   │   └── supabase.ts             ← Supabase client (env-based URL)
│   │   └── stores\
│   │       └── useAuthStore.ts         ← License flow + clock checks + telemetry
│   └── src-tauri\
│       └── src\
│           ├── lib.rs                  ← Setup: env cleanup, mitigation, integrity, sidecar
│           └── security.rs             ← Token (XOR), HMAC, DPAPI, anti-debug, IAT check
├── backend\
│   ├── app\
│   │   ├── core\
│   │   │   ├── license_guard.py        ← Request validation + DNS check
│   │   │   └── watermark.py            ← Stealth PDF watermark
│   │   ├── workers\
│   │   │   ├── nup_engine.py           ← Watermark integration
│   │   │   ├── vdp_engine.py           ← Watermark integration
│   │   │   └── sticker_engine.py       ← Watermark integration
│   │   └── api\routes\
│   │       ├── imposition.py           ← License info passthrough
│   │       └── vdp.py                  ← License info passthrough
│   └── supabase_security_migration.sql ← Device limit + RLS + rate limit
└── build_production.ps1                ← Nuitka + integrity hash pipeline
```

---

## 6. Giới hạn đã biết

| Giới hạn | Lý do | Giải pháp lý thuyết |
|---|---|---|
| Kernel driver bypass | App chạy ở Ring 3, driver ở Ring 0 | Viết anti-cheat kernel driver (cần MS ký, $$$) |
| VPS + public IP giả Supabase | DNS check chỉ reject private IP | TLS certificate pinning trong Rust (cần `reqwest` crate) |
| ES module deep patch | `__PRYNX_INVOKE__` chỉ bảo vệ `invoke`, không bảo vệ toàn bộ Tauri API surface | Compile-time inline tất cả IPC calls |

---

## 7. So sánh với industry

| Tính năng | PrynX | Adobe CC | JetBrains | Game (Valorant) |
|---|---|---|---|---|
| Token-based auth | ✅ CSPRNG+HMAC | ✅ | ✅ | ✅ |
| Code integrity check | ✅ SHA-256 | ✅ | ✅ | ✅ |
| Anti-debug | ✅ Ring 3 | ✅ Ring 3 | ❌ | ✅ Ring 0 |
| DLL injection block | ✅ Mitigation Policy | ✅ | ❌ | ✅ Kernel driver |
| Memory encryption | ✅ XOR mask | ✅ VMProtect | ❌ | ✅ |
| Offline grace | ✅ 24h + clock check | ✅ 30 ngày | ✅ | N/A |
| Device limit | ✅ HWID | ✅ 2 máy | ✅ | N/A |
| Stealth watermark | ✅ XMP + invisible | ✅ | ❌ | N/A |
| Kernel driver | ❌ | ❌ | ❌ | ✅ |

**Kết luận (cập nhật 3.0):** Thiết kế đạt tầm sản phẩm thương mại. **Nhưng điểm thực tế = điểm thực thi.** Audit 2026-06-12 cho thấy nhiều lớp ở bảng trên là *thiết kế đúng nhưng từng không chạy* (release build lỗi `webview2_com` → toàn bộ lớp release-only chưa kích hoạt) và một lỗ server phá vỡ toàn bộ mục tiêu. Sau khi vá (Mục 8): **client-side ~7.5/10, server-side ~7/10 (sau khi vá RLS), tổng thể ~6.5–7/10.** Trần cố hữu của license cài máy khách là ~8 (kẻ có binary luôn lách được); cột "ngang Adobe/JetBrains" ở bảng so sánh là *về ý tưởng tính năng*, không phải mức kháng-crack thực tế.

---

## 8. Audit toàn diện 2026-06-12 — Phát hiện, bản vá & lớp mới

> Audit theo `.kiro/steering/audit-rules.md` (verify-to-ground-truth). Mọi mục dưới đây
> đều đã kiểm chứng bằng đọc code / chạy thử / test, không phỏng đoán.

### 8.1. Phát hiện nghiêm trọng (đã vá)

| # | Mức | Phát hiện (đã VERIFIED) | Bằng chứng | Trạng thái |
|---|---|---|---|---|
| A | 🔴 | **Release build KHÔNG biên dịch** — `lib.rs` dùng `webview2_com::...` nhưng crate không khai báo trong `Cargo.toml`. Hệ quả: TẤT CẢ lớp release-only (#10,#11,#13,#15,#16,#17,#18) **chưa từng chạy** trên bản đóng gói. | `cargo check --release` → `E0433 unresolved crate webview2_com` | ✅ Vá: thêm `webview2-com = "=0.38.2"` vào `[target.'cfg(windows)'.dependencies]`; build release sạch. |
| B | 🔴 | **Server: anon đọc được TOÀN BỘ bảng `licenses`** (mọi key + email khách của MỌI sản phẩm). RLS policy `"Anyone can verify licenses" USING(true)`. Xác nhận live: 45 dòng đọc được bằng anon key. | `GET /rest/v1/licenses` → `Content-Range: */45` | ✅ Vá: migration `20260212_fix_licenses_rls_critical.sql` (printsolutions-main). Sau vá: `*/0`. |
| C | 🟠 | **WebSocket không xác thực** — `ws.py` check biến env `_PRYNX_SIDECAR_TOKEN` không bao giờ được set → chấp nhận mọi kết nối. | `routes/ws.py` | ✅ Vá: dùng chung `verify_sidecar_signature()` (token + HMAC) qua query param. |
| D | 🟠 | **`write_debug_log` ghi file tuỳ ý** (vượt phạm vi capability fs); **shell `allow-execute`** cấp dư. | `lib.rs`, `capabilities/default.json` | ✅ Vá: confine vào `%APPDATA%\PrynX\logs`; gỡ `shell:allow-execute`, thêm `shell:allow-open`. |
| E | 🟠 | **Integrity checks vô hiệu**: `verify_sidecar_integrity` định nghĩa nhưng KHÔNG được gọi; cả 2 check no-op nếu không set hash lúc build. | `lib.rs` | ✅ Vá: wire `verify_sidecar_integrity` (an toàn, chỉ chặn khi hash lệch) + `build.rs` thêm `rerun-if-env-changed`. |
| F | 🟠 | **Edge function `license-verify` hỏng trên live** (gọi `verify_license` bản 5 tham số không tồn tại → HTTP 500). Ảnh hưởng PrintMonitorApp (sản phẩm dùng edge function này). | `PGRST202` khi gọi RPC 5-param | ✅ Vá: sửa edge function gọi RPC 3 tham số (đang tồn tại). Live: 500 → 200. |
| G | 🟢 | `DEV_MODE` tắt token/chữ ký (chỉ dev; bản đóng gói Tauri ép `DEV_MODE=false`). Dead code Rust (`generate_watermark`, `validate_license_local`). | `config.py`, `security.rs` | ✅ Vá: thêm cảnh báo khởi động backend; gỡ dead code. |

### 8.2. Đính chính (rút lại theo audit-rules)
- Ban đầu nghi bảng `orders` cũng lộ qua `USING(true)` → **SAI**: migration `021/002` đã thay bằng `"Owner or admin can read orders"`. Rút lại.
- `product_id='prynx'` nghi không tồn tại → **SAI**: `license_products` có `{"id":"prynx"}`. Rút lại.

### 8.3. Lớp mới #21 — Token license ký Ed25519 (server-authoritative)

**Vấn đề gốc:** trước đây client tự quyết hợp lệ (`register_validated_key` tin lời frontend; sidecar không re-verify vì không có Supabase creds). Patch JS là qua.

**Giải pháp (không đổi kiến trúc, dùng Supabase sẵn có, $0 hạ tầng):**
```
Frontend → edge function license-verify (Supabase)
            → RPC verify_license (3-param) → nếu VALID:
            → ký token Ed25519 bằng PRIVATE key (secret LICENSE_SIGNING_KEY)
            → trả {status, token}
Frontend lưu token → gắn header X-License-Token mỗi request
Sidecar (require_license) → verify_license_token():
            verify chữ ký bằng PUBLIC key NHÚNG SẴN + exp + ràng buộc machine/key
```
- **Token:** `<payload_b64url>.<sig_b64url>`; payload `{k:sha256(key)[:16], m:hwid, p:product, exp}`; ký trên chuỗi `payload_b64url`. TTL 2 giờ.
- **Bất khả giả:** private key chỉ ở Supabase secret; client chỉ có public key (verify). Client crack bỏ qua validate Supabase → không có token hợp lệ.
- **Files:** `backend/app/core/license_guard.py` (`verify_license_token`, `_LICENSE_PUBLIC_KEY_B64`, cờ `PRYNX_ENFORCE_LICENSE_TOKEN`); `desktop/src/stores/useAuthStore.ts` (lưu `licenseToken`); `desktop/src/lib/api.ts` (gắn header); `printsolutions-main/supabase/functions/license-verify/index.ts` (ký, noble ed25519).
- **Rollout 2 pha:** mặc định cờ TẮT → verify-nếu-có, KHÔNG chặn (client cũ không gãy). Sau khi ship client mới + thấy token chạy, đặt `PRYNX_ENFORCE_LICENSE_TOKEN=true` trong spawn sidecar (`lib.rs`) → bắt buộc.
- **Test:** 7 unit test (`tests/test_license_token.py`) + kiểm tra liên thông khóa thật (ký bằng private thật → verify bằng public nhúng) đều PASS. Token giả mạo (ký bằng khóa khác) bị từ chối.

### 8.4. Server-side (repo printsolutions-main) — đã kiểm chứng
- Mọi sản phẩm verify qua **RPC `verify_license` (SECURITY DEFINER, 3-param)** — script .jsx + LicenseBridge.ps1 + prynx gọi RPC trực tiếp; PrintMonitorApp gọi edge function. **Không sản phẩm nào đọc bảng `licenses` trực tiếp** → bản vá RLS an toàn cho tất cả.
- `verify_license` ký SECURITY DEFINER + chỉ `GRANT EXECUTE TO anon` (không cho đọc bảng) — mẫu đúng. Tự ghi `license_logs` trong context definer (không cần anon-insert policy).
- **KHÔNG** lộ `service_role` key ở client/repo (chỉ dùng trong edge function qua `Deno.env`). ✅

### 8.5. Trạng thái đã kiểm chứng (live + test)

| Hạng mục | Kết quả |
|---|---|
| RLS bảng licenses (anon) | 🔒 `*/0` (trước `*/45`) |
| RPC verify_license 3-param | ✅ chạy (`INVALID` cho key giả) |
| Edge function license-verify | ✅ HTTP 200 (trước 500); secret + deploy xong |
| Sidecar verify token Ed25519 | ✅ 7 test + liên thông khóa thật pass |
| Frontend gắn X-License-Token | ✅ typecheck sạch (best-effort, không gãy) |
| Backend test suite | ✅ 154 passed |
| `cargo check` release | ✅ sạch (sau vá webview2-com) |

### 8.6. Việc còn lại để token "có răng"
1. Đóng gói bản desktop mới (`build_production.ps1` — đã thêm `externalBin` để nhồi sidecar + tính 2 hash integrity) → ship cho khách.
2. Sau khi xác nhận token chạy: thêm `("PRYNX_ENFORCE_LICENSE_TOKEN","true")` vào spawn sidecar trong `lib.rs` → đóng gói lại.
3. **Rotate 45 key** đã từng phơi nhiễm (trong thời gian lỗ RLS mở).
4. (Tùy chọn, tốn phí) Code signing Authenticode (~$10/tháng Azure) để hết cảnh báo SmartScreen.
5. CI chặn `USING(true)` trên bảng nhạy cảm (ngăn lỗ RLS tái diễn).

### 8.7. Lưu ý vận hành
- **Private key** `LICENSE_SIGNING_KEY` chỉ nằm trong Supabase secret; file `.SECRET.txt` đã xóa. Mất secret này → phải sinh lại cặp khóa + cập nhật public key trong `license_guard.py` + deploy lại.
- Anon key bị hardcode trong mọi script (.jsx/PS1/Python) — bình thường với anon key public, **nhưng** đó là lý do bản vá RLS tối quan trọng: anon key ở khắp nơi.
- Tự động hóa triển khai: `printsolutions-main/TRIEN_KHAI_TOKEN.bat` (set secret + deploy + xóa file khóa).


---

## 9. Re-audit & Hardening 2026-06-17

> Trace lại ground-truth toàn bộ luồng sau các bản vá ở Mục 8, bổ sung hardening và
> **làm rõ biên giới bảo mật thật**. Mọi mục đều verify bằng đọc code + test (14/14 token
> test pass, `cargo check` sạch, `npm run typecheck` sạch, py_compile sạch).

### 9.1. Làm rõ QUAN TRỌNG: đâu là biên giới bảo mật THẬT

Trace `sign_api_request` (security.rs) + `register_validated_key`:

- "Rust license gate" (Gate 1 trong `sign_api_request`: kiểm key có trong `VALIDATED_KEYS`)
  **KHÔNG phải biên giới bảo mật**. Cache đó do **chính frontend nạp** qua
  `register_validated_key(key)`; Rust **không** tự re-verify với Supabase. Một client bị
  crack chỉ cần gọi `register_validated_key("bất_kỳ")` → `sign_api_request` ký HMAC hợp lệ.
- Tương tự, `X-PrynX-Token` (token sidecar) được trả về cho JS và gửi plaintext qua
  loopback → một local attacker xem được. XOR-mask chỉ chống scan RAM thô.

➡️ **Biên giới bảo mật THẬT DUY NHẤT = token Ed25519 verify ở sidecar** (`verify_license_token`,
Layer #21). Server ký bằng private key (Supabase secret), client không có private key nên
**không giả được token**. Mọi lớp client-side khác (Rust cache gate, HMAC token, XOR, anti-debug,
integrity) là **defense-in-depth** làm chậm/khó kẻ tấn công, KHÔNG phải lớp chặn tuyệt đối.

➡️ Do đó **toàn bộ độ kháng-crack rốt cuộc phụ thuộc vào: edge function `license-verify`
cấp token Ed25519 đều đặn + `PRYNX_ENFORCE_LICENSE_TOKEN=true`.** Cả hai điều kiện này
hiện ĐÃ có (xem 9.3). Đây là điều DUY NHẤT phải xác nhận lại trên mỗi bản release.

### 9.2. enforce flag — ĐÃ BẬT (cập nhật Mục 8.6 #2)

`lib.rs` spawn sidecar (release) đã set cứng `("PRYNX_ENFORCE_LICENSE_TOKEN","true")`.
→ Mục 8.6 #2 ("việc còn lại: bật enforce") **đã hoàn thành**. Sidecar release từ chối
(403) mọi request thiếu token Ed25519 hợp lệ.

### 9.3. Hardening áp dụng trong đợt này

| # | Hạng mục | Thay đổi | File | Verify |
|---|---|---|---|---|
| H1 | **Watermark phủ TOÀN BỘ output** | Trước chỉ nup/vdp/sticker/plan_executor. Thêm `_safe_watermark` cho merge/split (cả ZIP)/resize/shuffle/ocr/optimize **và** toàn bộ luồng edit (delete/transform/text/add) tại chokepoint `_build_output_response`. | `api/routes/pdf_tools.py`, `api/routes/edit.py` | py_compile ✓ |
| H2 | **Token Ed25519 persist (offline-restart)** | Lưu token qua DPAPI (`prynx_token.dat`), nạp lại lúc khởi động + kiểm `exp` → mở app offline vẫn có token gửi sidecar (trước: token chỉ ở RAM → mở lại offline = 403, "grace 24h" thực tế không chạy). | `security.rs` (`store/load/delete_license_token`), `lib.rs` (đăng ký lệnh), `useAuthStore.ts` | cargo ✓, tsc ✓ |
| H3 | **DEV_MODE fail-closed ở binary release** | `_is_dev_mode()` trả `False` ngay nếu chạy dưới binary đã compile (`__compiled__` của Nuitka / `sys.frozen`). Chặn kẻ trích `pdf-inspector-backend.exe` chạy trực tiếp + set `DEV_MODE=true` để tắt verify. Dev (Python thông dịch) không đổi. | `license_guard.py` (`_is_dev_mode`) | 14/14 test ✓ |
| H4 | **Public key = trust anchor** | Production LUÔN dùng key nhúng cứng; env `PRYNX_LICENSE_PUBLIC_KEY` chỉ override khi `DEV_MODE=true`. (Sửa lại lỗ "đọc public key từ env runtime" — vì nếu cho đọc env ở production, kẻ gian đặt env trỏ key của hắn → tự ký token → bypass.) | `license_guard.py` | test ✓ |
| H5 | **fs capability deny vùng nhạy cảm** | Giữ allow rộng (mở/lưu PDF mọi nơi) + thêm `deny` cho `.ssh/.aws/.gnupg/.config/.kube`, Credentials Windows, Startup folder. | `capabilities/default.json` | — |
| H6 | **Lệnh Rust đọc file chặn vùng nhạy cảm** | `read_system_file` + `get_file_size` thêm `is_sensitive_path()` (chặn `.ssh/.aws/...`/Credentials + path traversal `..`). Vá lỗ "lệnh Rust bỏ qua fs deny" (capability deny chỉ ràng plugin-fs). | `lib.rs` | cargo ✓ |
| H7 | **Log kiểm chứng bảo mật** | Log startup `enforce_license_token / dev_mode / sidecar_token / pubkey_source`; log khi token bị reject. Ghi thêm ra file `%APPDATA%\PrynX\logs\security.log` (thầm lặng, KHÔNG hiện cho user, KHÔNG ghi key/token thô) để verify trên bản cài. | `license_guard.py` (`_security_log_to_file`) | test ✓ |
| H8 | **Test mở rộng** | +7 test: `verify_sidecar_signature` (valid/sai token/hết hạn ts/sai sig/sai path/dev-bypass) + override public key. Tổng **14/14 pass**. | `tests/test_license_token.py` | ✓ |

### 9.4. Bề mặt đã trace lại — kết quả TỐT (không đổi)

- **CORS** (`main.py`): allowlist hẹp hardcode (`tauri.localhost` + vite dev), cố ý bỏ qua
  `settings.CORS_ORIGINS`; không dùng `*`. ✓
- **Host binding**: uvicorn + entry Nuitka đều `127.0.0.1` → sidecar chỉ loopback, không lộ LAN. ✓
- **WebSocket** (`ws.py`): enforce `verify_sidecar_signature` qua query param, đóng `4001` nếu sai. ✓
- **`write_debug_log`**: confine `%APPDATA%\PrynX\logs` qua `file_name()` (loại `..`/thư mục). ✓

### 9.5. Rủi ro còn lại (chấp nhận / cố hữu)

| Rủi ro | Mức | Ghi chú |
|---|---|---|
| HWID qua PowerShell (3 nguồn) | 🟡 | Lớp yếu nhất; thay bằng WinAPI native là thay đổi lớn + nguy cơ lệch HWID của license đã kích hoạt → cần migration riêng. |
| Rotate public key cần rebuild | 🟢 | ĐÚNG nguyên tắc trust-anchor (không cho thay runtime). Tùy chọn: sinh file hằng số lúc build để key không nằm trong git. |
| Sidecar Python (Nuitka) | 🟢 | Attack surface lớn hơn Rust thuần; re-architecture ngoài phạm vi. |
| Watermark tích lũy trên edit | 🟢 | Mỗi op edit nhúng 1 chuỗi invisible nhỏ + 1 vòng open/save; vô hại, hơi tốn. |
| Ring 3 | 🟢 | Kernel driver vẫn bypass được — giới hạn vật lý. |

### 9.6. Cách kiểm chứng trên bản release (BẮT BUỘC trước khi ship)

1. `.\build_production.ps1` → cài app (script tự set `PRYNX_SIDECAR_HASH` + `PRYNX_FRONTEND_HASH`).
2. Đăng nhập **license thật**, dùng 1 tính năng gọi backend (merge/imposition):
   - Chạy được → chuỗi token Ed25519 hoạt động end-to-end (edge function CÓ cấp token). ✅
   - Mọi thao tác 403 → edge function chưa trả `token` → sửa ở Supabase (repo printsolutions-main).
3. Mở `%APPDATA%\PrynX\logs\security.log`: phải có
   `STARTUP enforce_license_token=true dev_mode=False sidecar_token=set pubkey=embedded`.
4. (Tùy chọn) chạy `pdf-inspector-backend.exe` trực tiếp trong terminal → phải thấy
   `dev_mode=False` + `sidecar_token=MISSING` → request bị 403 (đúng fail-closed H3).
5. Sửa 1 byte file đã cài → app báo tamper + thoát (integrity #10/#11).

### 9.7. File map bổ sung (đợt 2026-06-17)

```
backend/app/api/routes/pdf_tools.py   ← _safe_watermark cho merge/split/resize/shuffle/ocr/optimize
backend/app/api/routes/edit.py        ← _safe_watermark tại _build_output_response (mọi op edit)
backend/app/core/license_guard.py     ← _is_dev_mode fail-closed (__compiled__), public-key dev-only,
                                         _security_log_to_file, log enforce + token reject
backend/tests/test_license_token.py   ← +7 test (HMAC sidecar sig + public-key override) = 14 total
desktop/src-tauri/src/security.rs      ← store/load/delete_license_token (DPAPI)
desktop/src-tauri/src/lib.rs           ← đăng ký lệnh token; is_sensitive_path() cho read_system_file/get_file_size
desktop/src-tauri/capabilities/default.json ← fs deny .ssh/.aws/.gnupg/.config/.kube/Credentials/Startup
desktop/src/stores/useAuthStore.ts     ← persist/load/exp-check licenseToken (DPAPI)
```


### 9.8. Phát hiện & vá bổ sung khi dựng ma trận endpoint (2026-06-17)

| # | Mức | Phát hiện (VERIFIED) | Bằng chứng | Trạng thái |
|---|---|---|---|---|
| H9 | 🟠 | **Router `cut_export` KHÔNG gate license** — `app/workers/cut_export/api.py` tạo `APIRouter(prefix="/imposition")` **không** `dependencies=[Depends(require_license)]`. 9 endpoint (cut-export, cut-export-from-file, cut-preview, cut-pages, cut-layers, quản lý profile) callable mà KHÔNG cần sidecar token/license — cùng lớp lỗ với WebSocket (mục C). Đọc `path` PDF client cấp + gửi máy bế (TCP/serial/file). | `api.py` thiếu dependency | ✅ Vá: thêm `dependencies=[Depends(require_license)]` cấp router (verify: router dựng với deps=1). |

> Lưu ý: output của cut_export là **luồng lệnh cắt gửi máy** (DXF/command stream), KHÔNG phải
> PDF phân phối → không áp watermark (không phù hợp). License gate là biện pháp đúng ở đây.

---

## 10. Ma trận bảo vệ endpoint (đã trace 2026-06-17)

Mọi router xử lý đều gate bằng `require_license` (token sidecar HMAC + — khi enforce — token Ed25519).
WebSocket gate bằng `verify_sidecar_signature` qua query param. Output PDF được nhúng watermark.

| Router / Endpoint | Gate license | Watermark output | Ghi chú |
|---|---|---|---|
| `upload` (`/api/upload`) | ✅ per-route | — (input) | |
| `compare` (`/api/jobs/compare`) | ✅ | — | so sánh, không xuất PDF mới |
| `results` (`/api/jobs/*`, `/files/{id}/serve`) | ✅ per-route | — | serve file đã có |
| `report` (`/api/jobs/{id}/report`) | ✅ | — | report PDF (cân nhắc watermark sau) |
| `qc` (`/api/qc/*`) | ✅ per-route | — | trích text/QC |
| `system` (`/api/system/*`) | ✅ per-route | — | |
| `preflight` | ✅ router-level | (qua worker) | |
| `imposition` | ✅ router-level + per-route | ✅ nup/sticker/plan_executor | |
| `vdp` (`/api/vdp/*`) | ✅ per-route | ✅ vdp_engine | |
| `pdf_tools` (merge/split/resize/shuffle/ocr/optimize) | ✅ router-level + per-route | ✅ `_safe_watermark` (H1) | |
| `edit` (delete/transform/text/add) | ✅ router-level + per-route | ✅ `_build_output_response` (H1) | |
| `cut_export` (`/imposition/cut-*`) | ✅ router-level (H9) | N/A (luồng máy cắt) | vá 2026-06-17 |
| `ws` (`/ws/jobs/{id}/progress`) | ✅ `verify_sidecar_signature` | N/A | query param token+ts+sig |

---

## 11. Vòng đời token Ed25519 (online + offline persist — H2)

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant EF as Edge Function (Supabase)
    participant RS as Rust (DPAPI)
    participant SC as Sidecar

    Note over FE,SC: === ONLINE (đăng nhập / heartbeat 30') ===
    FE->>EF: license-verify {key, hwid, product}
    EF->>EF: RPC verify_license → VALID → ký Ed25519 (private key)
    EF-->>FE: {status, token (exp ~2h)}
    FE->>RS: store_license_token(token)  (DPAPI prynx_token.dat)
    FE->>FE: licenseToken = token (RAM)

    Note over FE,SC: === MỖI REQUEST ===
    FE->>SC: fetch + X-License-Token
    SC->>SC: verify_license_token (public key nhúng) + exp + m/k
    alt enforce=true & token hỏng/thiếu
        SC-->>FE: 403 (ghi security.log TOKEN_REJECTED)
    else hợp lệ
        SC-->>FE: 200 + watermark
    end

    Note over FE,SC: === KHỞI ĐỘNG LẠI KHI OFFLINE (H2) ===
    FE->>RS: load_license_token() (DPAPI)
    RS-->>FE: token
    FE->>FE: isLicenseTokenValid(exp)? → còn hạn: dùng tiếp; hết hạn: xóa + chờ online
```

**Hệ quả thiết kế:** offline-grace cho backend = `min(grace 24h, TTL token)`. Muốn grace
24h có nghĩa thì edge function nên cấp token TTL ≥ 24h (hoặc chấp nhận grace = TTL token).

---

## 12. Tham chiếu biến môi trường & file

### Biến môi trường (sidecar)
| Biến | Nguồn | Ý nghĩa | Bảo mật |
|---|---|---|---|
| `PRYNX_TOKEN_SOURCE` | spawn `lib.rs` = `stdin` | Đọc token sidecar từ stdin (không file/env) | Spawn ép giá trị (override inherited) |
| `PRYNX_ENFORCE_LICENSE_TOKEN` | spawn = `true` | Bắt buộc token Ed25519, thiếu → 403 | Spawn ép `true` |
| `DEV_MODE` | spawn = `false`; dev: `.env` = `true` | Bỏ qua verify khi true | Binary compiled (`__compiled__`) **luôn** ép False (H3) |
| `PRYNX_LICENSE_PUBLIC_KEY` | (chỉ dev) env | Override public key để test | Production **bỏ qua** (H4) |
| `PRYNX_SIDECAR_HASH` / `PRYNX_FRONTEND_HASH` | build-time (`build_production.ps1`) | Integrity anchor | `option_env!` baked vào binary Rust |
| `LICENSE_SIGNING_KEY` | Supabase secret (server) | Private key ký token | KHÔNG bao giờ ở client |

### File quan trọng (máy người dùng)
| File | Nội dung | Mã hoá |
|---|---|---|
| `%APPDATA%\PrynX\prynx_license.dat` | License key | DPAPI (user+máy) |
| `%APPDATA%\PrynX\prynx_ts.dat` | Last-online timestamp | DPAPI |
| `%APPDATA%\PrynX\prynx_token.dat` | Token Ed25519 (H2) | DPAPI |
| `%APPDATA%\PrynX\logs\security.log` | Log kiểm chứng (H7) | Plaintext — KHÔNG chứa key/token thô |

---

## 13. Runbook: Rotate khóa ký license (Ed25519)

> Rotate là sự kiện hiếm (lộ private key, định kỳ). Public key là trust-anchor **nhúng cứng**
> → rotate BẮT BUỘC rebuild + redeploy. Đây là đúng nguyên tắc, không phải hạn chế.

1. **Sinh cặp khóa mới** (Ed25519) — giữ private key tuyệt mật.
2. **Cập nhật Supabase secret** `LICENSE_SIGNING_KEY` = private key mới; deploy lại edge
   function `license-verify` (repo `printsolutions-main`).
3. **Cập nhật public key** trong `backend/app/core/license_guard.py` →
   `_LICENSE_PUBLIC_KEY_B64 = "<base64 raw public key mới>"`.
4. **Rebuild sidecar + app** bằng `build_production.ps1` (Nuitka nhồi public key mới vào binary;
   tính lại `PRYNX_SIDECAR_HASH`/`PRYNX_FRONTEND_HASH`).
5. **Ship bản mới** cho khách. Trong giai đoạn chuyển tiếp, client cũ (public key cũ) sẽ
   KHÔNG verify được token mới → cần buộc cập nhật (token cũ còn hạn vẫn chạy tới khi `exp`).
6. (Tùy chọn) Đưa public key ra khỏi git: sinh file hằng số lúc build từ secret/CI rồi để
   `license_guard.py` import — vẫn nhúng cứng (trust-anchor), chỉ khác là không nằm trong source.

---

## 14. Ứng phó sự cố (Incident Response)

| Sự cố | Triệu chứng | Hành động |
|---|---|---|
| **Lộ private key ký** | Key signing key rò rỉ | Rotate ngay (Mục 13) + thu hồi/đánh dấu key bị ảnh hưởng trong DB. |
| **License key bị share** | 1 key chạy >2 máy | HWID device-limit chặn máy thứ 3; kiểm `license_logs`, thu hồi nếu lạm dụng. |
| **RLS lộ bảng** (như mục B) | Anon đọc được bảng | Vá RLS migration; CI chặn `USING(true)`; rotate key đã phơi nhiễm. |
| **Hàng loạt `TOKEN_REJECTED`** trong security.log | Khách báo app 403 | Kiểm edge function có cấp `token` không; kiểm TTL token vs heartbeat. |
| **App báo tamper + thoát** | Integrity hash lệch | File bị sửa hoặc build thiếu set hash; rebuild đúng pipeline. |
| **`sidecar_token=MISSING` trong log (release)** | Mọi request 403 | Tauri host không ghi token qua stdin; kiểm chuỗi spawn `lib.rs`. |

---

## 15. Checklist bảo mật trước khi RELEASE

- [ ] `cargo check --release` sạch (không lỗi `webview2_com` — mục A).
- [ ] `build_production.ps1` set cả `PRYNX_SIDECAR_HASH` **và** `PRYNX_FRONTEND_HASH`.
- [ ] Cài app → `security.log` hiện `enforce_license_token=true dev_mode=False sidecar_token=set pubkey=embedded`.
- [ ] Đăng nhập license thật → dùng 1 tính năng backend → **chạy được** (xác nhận edge function cấp token).
- [ ] License sai/không đăng nhập → backend từ chối (403).
- [ ] Chạy `pdf-inspector-backend.exe` trực tiếp → `dev_mode=False` + request bị 403 (fail-closed H3).
- [ ] Sửa 1 byte file đã cài → app báo tamper + thoát.
- [ ] Không có `.env` `DEV_MODE=true` lọt vào bundle; spawn ép `DEV_MODE=false`.
- [ ] Edge function `license-verify` trả `token` (HTTP 200) với TTL phù hợp grace mong muốn.
- [ ] Rotate các key đã phơi nhiễm (nếu có); private key chỉ ở Supabase secret.
- [ ] (Tùy chọn) Code signing Authenticode để giảm cảnh báo SmartScreen.
