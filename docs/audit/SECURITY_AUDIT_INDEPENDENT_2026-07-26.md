# PrynX / PrintSolutions — Audit độc lập cơ chế chống crack/tấn công

> **Ngày:** 2026-07-26
> **Người kiểm:** Audit độc lập (Claude), verify-to-ground-truth trên code thật của cả hai repo.
> **Threat model:** Kẻ tấn công **có sẵn binary `.exe` đã đóng gói**, dùng phân tích tĩnh / patch / debugger, sniff HTTPS + loopback, và gọi thẳng backend/edge bằng input giả. Đây là góc nhìn của một cracker/keygen-er thực thụ.
> **Phạm vi:** toàn chuỗi — desktop client (Tauri Rust + WebView TS) → sidecar Python (Nuitka) → Supabase edge functions + RPC + RLS + webhook thanh toán. Cả `d:\pdfcompare` (nhánh `security/audit-2026-07-25`) và `d:\printsolutions-main` (nhánh `security/license-ttl-72h`).
> **Quan hệ với bản tự-audit `SECURITY_AUDIT_2026-07-26.md`:** file này là audit **độc lập** để đối chiếu. Nhiều điểm trong bản tự-audit đã được **xác nhận đúng bằng cách đọc lại code**; phần giá trị mới nằm ở §2 (phát hiện còn sống) và §5 (việc vận hành).

---

## 0. Kết luận nhanh (TL;DR)

Cơ chế đã ở **tầm sản phẩm thương mại nghiêm túc** và **không có đường crack rẻ tiền**:

- **Không giả được token** (Ed25519, private key chỉ ở Supabase secret), **không leo Free→Pro bằng input client**, **không giả được thanh toán**, **không có route Pro nào hở guard**, **không mint token ẩn danh**. Đây là những thứ *đáng lẽ* là lỗ Critical — và chúng đã được bịt đúng.
- **Biên giới bảo mật thật = token Ed25519 verify ở sidecar** — đúng như tài liệu tự nhận. Lớp này chắc.
- **Layer-2 dieline crypto-lock là điểm sáng thật:** thuật toán bế được **mã hoá AES-256-GCM**, khoá chỉ đến từ claim `rk` trong token đã ký, và bản rõ **chạy trong VM `boa` ngay trong tiến trình Rust — không ghi đĩa, không log, không đẩy sang WebView** (đã verify `native/src/dieline_engine.rs`). Patch bỏ verify → không có khoá → engine vẫn là rác mã hoá.

**Trần cố hữu (không thể vượt) vẫn đúng:** app xử lý cục bộ ⇒ kẻ có binary + chịu khó *luôn* mở được Pro **trên chính máy hắn** bằng cách patch binary/dump RAM. Điều này là bản chất của phần mềm cài máy khách, tài liệu đã thừa nhận trung thực (~8/10).

**Điểm cần xử lý (xếp theo giá trị):**

| # | Mức | Phát hiện | Vị trí |
|---|---|---|---|
| F1 | 🔴 High | Edge `bin-packing` (solver nesting — đúng "IP" muốn giấu server) **cho gọi ẩn danh** khi thiếu header Auth | `printsolutions-main/supabase/functions/bin-packing/index.ts:301,325` |
| F2 | 🔴 High (vận hành) | Migration `20260726110000_prynx_security_audit_fixes.sql` (vá đua-hoạt-hoá, rate-limit, khoá tài nguyên bất biến) **bị drift / chưa chắc đã deploy** | tự-audit mục "Still pending" |
| F3 | 🟠 Medium | `_MAX_TOKEN_LIFETIME_SECONDS` đọc từ env **không gated dev** + để dư 8 ngày > TTL 72h ⇒ replay token hết hạn bằng quay-ngược-giờ | `backend/app/core/license_guard.py:338-345,437-443` |
| F4 | 🟠 Medium | `rk` over-harvest: một license Pro **lặp `app_version`** để rút khoá dieline của **mọi bản phát hành** | `printsolutions-main/.../license-verify/index.ts:317-323` + `lookupResourceKey` |
| F5 | 🟠 Medium | Lưu DPAPI bằng cách nội suy secret vào **dòng lệnh PowerShell** ⇒ license key + token lộ cho tiến trình cùng-user / EDR / Sysmon | `desktop/src-tauri/src/security.rs` (`store_license`, `store_license_token`) |
| F6 | 🟠 Medium | `order-lookup` tin `x-forwarded-for[0]` ⇒ spoof header, bypass rate-limit, enumerate đơn hàng (PII) | `printsolutions-main/supabase/functions/order-lookup/index.ts:33-35` |
| F7 | 🟡 Low | Thu hồi online + "DNS-MITM detection" **là code chết ở production** (sidecar không có Supabase creds) ⇒ độ trễ thu hồi = TTL token | `backend/app/core/license_guard.py:647-674` |
| F8 | 🟡 Low | `is_sensitive_path` chỉ so khớp **chuỗi** ⇒ bypass bằng symlink/junction, UNC, `\\?\`, tên 8.3 | `desktop/src-tauri/src/lib.rs` (`is_sensitive_path`) |
| F9 | 🟡 Low | Kiểm tra integrity frontend **là no-op trên bản NSIS** (dist nhúng trong binary; chưa có Authenticode) | `desktop/src-tauri/src/lib.rs` (`verify_frontend_integrity`) |
| F10 | 🟡 Low | Nhánh `fetch` thường: header do caller đặt sẵn **không bị native ghi đè**; đặt sẵn `X-PrynX-Signature` làm bỏ ký (fail-closed ở backend nên chưa khai thác được) | `desktop/src/lib/api.ts:184-190` |
| F11 | 🟡 Low | `build.rs` dùng **nonce AES-GCM tất định** (an toàn chỉ khi không tái dùng khoá cho cùng version+độ dài) | `native/build.rs:86-91` |
| F12 | 🟡 Low | `license-release` được cấp **private key** chỉ để suy ra public key ⇒ mở rộng bán kính rò | `printsolutions-main/.../license-release/index.ts:43-49` |

Cộng thêm **việc vận hành bắt buộc** (§5): rotate 45 key từng phơi nhiễm, **revoke token truy cập Supabase `sbp_…`** mà bản tự-audit nói đã tạo, bật Authenticode.

---

## 1. Những gì đã CHẮC (verify tận gốc — đừng lo lại)

Đây không phải khen xã giao; mỗi mục đã đọc code xác nhận, để bạn biết **không cần đụng lại**.

**1.1 — Token Ed25519 (biên giới thật) — chắc.**
- Private key **chỉ** ở `Deno.env.get("LICENSE_SIGNING_KEY")`, không hardcode/commit (`license-verify/index.ts:206`).
- Payload **server dựng bằng object rồi `JSON.stringify`** (không nối chuỗi) ⇒ không inject field; `plan/features/rk/exp` **do server quyết**, client không gửi được (`license-verify/index.ts:212-224`).
- Ký trên đúng chuỗi `payloadB64` đã truyền; verifier Rust (`security.rs`) và Python (`license_guard.py:409-469`) verify chữ ký **rồi mới** parse ⇒ không có khe canonicalization/alg-confusion.
- `exp` bắt buộc + bắt buộc field `m` (hwid), `k` (hash key), `p=="prynx"` (audience) — token của sản phẩm khác không mở được PrynX (`license_guard.py:445-467`).
- **Fail-closed entitlement:** lỗi tra `licenses` → 500 (không cấp token); thiếu row/plan lạ → `free` (`license-verify/index.ts:291-311`).

**1.2 — Cổng mint `verify_license_edge` — chắc** (`migrations/20260726110000_...sql`, xem F2 về deploy):
- Rate-limit **per-IP 120/phút** và **per-(IP,key) 30/phút**, bucket băm MD5, có `pg_advisory_xact_lock(ip_bucket)` chống đua.
- **Đếm hoạt-hoá được serialize per-license** bằng `pg_advisory_xact_lock(license_id)` rồi mới đếm→chèn ⇒ **hết đua TOCTOU**.
- `max_activations` NULL → mặc định **2**, kẹp `[1,100]` ⇒ không còn "vô hạn máy".
- `verify_license_edge` **chỉ `service_role`** gọi được (`REVOKE ... FROM PUBLIC, anon, authenticated`).
- RPC legacy `verify_license` **từ chối PrynX** nếu người gọi không phải service_role ⇒ key bị trộm không đốt được slot qua đường công khai.

**1.3 — Webhook thanh toán SePay — chắc (không giả được payment).**
- Xác thực **API key dùng chung, fail-closed nếu chưa cấu hình** (401), so sánh **timing-safe**, chạy **trước mọi mutation** (`sepay-webhook/index.ts:112-134`).
- Khớp số tiền có dung sai; chống trùng bằng `sepay_id`.

**1.4 — Sidecar Python — chắc.**
- **DEV_MODE fail-closed dưới binary compiled:** `if "__compiled__" in globals() or sys.frozen: return False` ⇒ trích exe chạy trực tiếp rồi set `DEV_MODE=true` **vô hiệu** (`license_guard.py:83-101`). Cùng cờ tắt `/docs`,`/redoc`,`/openapi.json`.
- **Enforce mặc-định-BẬT trong chính sidecar:** không dev thì `_enforce_license_token()` luôn `True`, env chỉ đọc ở dev (`license_guard.py:316-324`).
- **Public key là trust anchor khoá cứng;** override qua env **chỉ ở dev** (`license_guard.py:306-313`).
- **HMAC request** buộc `ts:nonce:METHOD:path:key:hwid:sha256(token)`; **nonce dùng-một-lần**, tiêu *sau* khi HMAC hợp lệ ⇒ không bơm rác, không replay trong cửa sổ 30s (`license_guard.py:186-267`).
- **Mọi route Pro đều có guard** (xác minh bằng quét AST + đối chiếu router-level, xem 1.5).

**1.5 — Độ phủ guard route: ĐỦ (đã quét chính xác).**
Kết quả nghi ngờ ban đầu ("54/126 endpoint hở") là **dương tính giả**: guard gắn ở **cấp router**, không phải từng decorator:
- `edit.py`, `export.py`, `imposition.py`: `APIRouter(dependencies=[Depends(require_license)])`.
- `preflight.py`: `APIRouter(dependencies=[Depends(require_feature("prepress.preflight"))])` — cả router đòi feature Pro.
- `vdp.py`: `APIRouter(dependencies=[Depends(require_feature("vdp.datamerge"))])`.
- `qc/system/upload/results/report/compare/dieline/pdf_tools`: guard theo từng endpoint (đã quét, không hở).
- `ws.py` tự xác thực trong handler (`verify_sidecar_signature`).
⇒ **0 endpoint Pro thực sự hở.** *Nhưng* độ phủ này dựa vào **quy ước** (thêm router mới mà quên dep sẽ hở âm thầm) — xem khuyến nghị §3.

**1.6 — Layer-2 dieline crypto-lock — điểm sáng thật.**
- Khoá AES-256-GCM **chỉ** đến từ claim `rk` của token, đọc **sau khi** verify đủ chữ ký + exp + m + k + p + plan/features (`dieline_license.rs:37-100`).
- Ciphertext nhúng trong binary; **khoá không nằm trong binary** (`build.rs` chỉ nhận `PRYNX_DIELINE_KEY_B64` để *mã hoá*, không ghi khoá ra output).
- **Bản rõ chạy trong `boa` (VM JS thuần Rust) trong tiến trình** — không `fs::write`, không `log`, không `emit`/IPC sang WebView (`dieline_engine.rs:3,36,84-104,145`). Kẻ patch không lấy được thuật toán; chỉ một dump RAM của **người dùng đã trả tiền** mới lộ (đúng trần cố hữu).

**1.7 — Rust host — chắc:** enforce flag hardcode `("PRYNX_ENFORCE_LICENSE_TOKEN","true")` release-only; health challenge `HMAC(token,"startup:{challenge}")` fail-closed; integrity sidecar fail-closed (unset hash → chặn khởi động); khả năng bị TOCTOU cổng 8321 chỉ gây DoS (fail-closed), **không** bypass license vì proof cần secret truyền qua stdin.

---

## 2. Phát hiện còn SỐNG (chi tiết + PoC + fix)

### F1 — 🔴 High — Edge `bin-packing` cho gọi ẩn danh (IP solver phơi ra + DoS)
**Vị trí:** `printsolutions-main/supabase/functions/bin-packing/index.ts:299-326, 342-352`
**Vấn đề:** kiểm tra subscription **chỉ chạy khi có header `Authorization`**:
```ts
if (authHeader) { ... check_tool_subscription ... if (subData && !subData.has_access) return 403; }
// If no auth header, allow anonymous access for now (tool gate handles client-side)
```
Bỏ hẳn header ⇒ hàm xử lý bình thường và trả layout. Đây đúng là loại solver mà `HYBRID_ANTICRACK_REPORT.md` khuyên **đưa lên server để giấu IP** — nhưng ở đây server **không xác thực**, nên thuật toán nesting thành **công khai**. Thêm nữa `item.quantity`/`items.length` **không chặn trần** ⇒ DoS.
**PoC:**
```bash
curl -X POST https://<proj>.supabase.co/functions/v1/bin-packing \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"x","width":1,"height":1,"quantity":1000000000}],"settings":{"autoRotate":true,...}}'
# → 200 + layout (không cần token), hoặc treo CPU/OOM
```
**Fix:** fail-closed — thiếu `authHeader` hoặc `subData` null → 403; chặn trần `quantity`, `items.length`, tổng job (vài nghìn).

### F2 — 🔴 High (vận hành) — Migration vá bảo mật bị drift / chưa chắc deploy
**Vị trí:** `printsolutions-main/supabase/migrations/20260726110000_prynx_security_audit_fixes.sql`; đối chiếu mục "Still pending" của `SECURITY_AUDIT_2026-07-26.md`.
**Vấn đề:** Toàn bộ phần "chắc" ở **1.2** (serialize hoạt-hoá, rate-limit băm, khoá tài nguyên bất biến, chặn PrynX ở RPC legacy) **nằm trong migration này** — mà bản tự-audit ghi rõ nó là *drifted migration, "not touched", chưa `db push`*. Edge v11 gọi `verify_license_edge` chạy được (smoke test 200) ⇒ hàm **có tồn tại** ở production, nhưng **không có gì bảo đảm toàn bộ nội dung** migration (trigger bất biến khoá, delegation `verify_license`→edge, REVOKE) đã áp đúng. Auditor **không thể xác nhận production khớp repo**.
**Rủi ro:** nếu chỉ hàm được áp thủ công mà thiếu các trigger/GRANT, có thể còn khe (vd khoá tài nguyên bị sửa, hoặc verify_license legacy vẫn nhận prynx).
**Fix:** đối chiếu schema production ⇄ repo có kiểm soát (`supabase migration repair` / `db pull`), xác nhận **từng object** trong migration đã áp; đừng để trạng thái "đã tạo tay một phần".

### F3 — 🟠 Medium — Cận tuổi-thọ token env-overridable + dư 8 ngày ⇒ replay token hết hạn bằng quay giờ
**Vị trí:** `backend/app/core/license_guard.py:338-345` và dùng ở `:437-443`.
```py
_MAX_TOKEN_LIFETIME_SECONDS = int(os.environ.get("PRYNX_MAX_TOKEN_LIFETIME_SECONDS", str(8*24*60*60)))
```
**Vấn đề:** Khác với pubkey/enforce/dev (đều gated sau `_is_dev_mode()`), dòng này đọc env **vô điều kiện**, cả trên binary production. Kẻ chạy sidecar đã trích (hoặc đặt biến môi trường máy mà tiến trình sidecar kế thừa) đặt `PRYNX_MAX_TOKEN_LIFETIME_SECONDS=99999999999`, rồi **quay ngược đồng hồ** về `< exp` ⇒ check "lifetime implausible" (dòng 440) vô hiệu ⇒ **token hết hạn/đã thu hồi vẫn verify**. Kể cả không đụng env, dư **8 ngày > TTL 72h** nghĩa là một token 72h vẫn replay được tới ~8 ngày bằng quay giờ. Cộng với F7 (không thu hồi online) và `_clock_guard` file-based bị reset mỗi lần khởi động (baseline ký bằng `_SIDECAR_TOKEN` **đổi mỗi launch**, `:363-368` ⇒ session sau không đọc được baseline session trước), anti-rollback thực tế lỏng.
**Fix:** gate `PRYNX_MAX_TOKEN_LIFETIME_SECONDS` sau `_is_dev_mode()` như các knob khác; đặt cận = `TTL + skew nhỏ` (kế hoạch 4 ngày trong comment — thực thi sau khi token 7 ngày hết hạn). Ký baseline `.clkguard` bằng khoá machine-bound ổn định (DPAPI) thay vì token ephemeral.

### F4 — 🟠 Medium — `rk` over-harvest: một Pro rút khoá dieline của mọi bản phát hành
**Vị trí:** `printsolutions-main/supabase/functions/license-verify/index.ts:317-323` + `lookupResourceKey:171-195`.
**Vấn đề:** `app_version` **do client chọn** (chỉ validate charset), và `lookupResourceKey` trả khoá theo `(product_id, app_version)` **không kiểm license có quyền dùng đúng bản đó**. Một license Pro hợp lệ lặp `app_version` = 1.0.0, 1.0.1, 2.0.0… để **thu thập toàn bộ khoá `dieline_engine` mỗi bản** ⇒ phá mục tiêu "rotate mỗi bản để một khoá rò chỉ mở đúng bản đó" (comment `:156-160`).
**PoC:** với một token Pro thật, gọi `license-verify` nhiều lần đổi `app_version` → gom nhiều `rk`.
**Fix:** ràng khoá theo bản mà license thực sự được phép chạy (hoặc theo version hiện hành đã xác thực); rate-limit/log số version khác nhau mỗi license.

### F5 — 🟠 Medium — Secret lộ qua dòng lệnh PowerShell khi lưu DPAPI
**Vị trí:** `desktop/src-tauri/src/security.rs` — `store_license` (~L979-996), `store_license_token` (~L1196-1217), HWID/timestamp tương tự.
**Vấn đề:** DPAPI được gọi bằng cách nội suy bí mật vào chuỗi `powershell -Command "...GetBytes('<SECRET>')..."`. Dù đã escape `'` (chống injection), **license key + token Ed25519 vẫn hiện trên command line** của tiến trình con ⇒ bất kỳ tiến trình cùng-user, WMI `Win32_Process.CommandLine`, Sysmon EID 1, hay EDR nào cũng bắt được cleartext lúc lưu. Độc lập với trần crack — đây là rò key dài hạn cho observer cục bộ.
**Fix:** truyền secret qua **stdin** cho PowerShell (không qua `-Command`), hoặc gọi thẳng `CryptProtectData` qua crate `windows` (bỏ hẳn PowerShell).

### F6 — 🟠 Medium — `order-lookup` tin XFF ⇒ bypass rate-limit + enumerate đơn (PII)
**Vị trí:** `printsolutions-main/supabase/functions/order-lookup/index.ts:33-35`.
**Vấn đề:** lấy `x-forwarded-for.split(',')[0]` (hop do client điều khiển) làm bucket rate-limit truyền vào `get_order_by_code(p_ip)`. Đổi header mỗi request ⇒ bucket mới ⇒ bypass giới hạn, dò `order_code` để lộ tên/email/số tiền/sản phẩm. (`license-verify` làm **đúng**: ưu tiên `cf-connecting-ip`; `order-lookup` thì không.)
**PoC:** `for i in $(seq...); curl .../order-lookup -H "X-Forwarded-For: 1.2.3.$i" -d '{"order_code":"DH-00'$i'"}'`
**Fix:** lấy IP từ hop tin cậy (`cf-connecting-ip`), không dùng `xff[0]`. Thêm: `order-lookup:72` đang phản chiếu `error.message` thô → trả thông điệp generic.

### F7 — 🟡 Low — Thu hồi online + DNS-MITM là code chết ở production
**Vị trí:** `backend/app/core/license_guard.py:647-674` (và `lib.rs` spawn sidecar không kèm `SUPABASE_URL/SERVICE_KEY`).
**Vấn đề:** production sidecar không có Supabase creds ⇒ `_verify_with_supabase` luôn vào nhánh `:652-657` trả `True`; nhánh DNS-check `:659-674` **không bao giờ chạy**. Hệ quả: **không thu hồi online** — license bị thu hồi nhưng token chưa hết hạn vẫn dùng được tới `exp` (72h, hoặc tới ~8 ngày do F3). Đây là **đánh đổi thiết kế có chủ ý** (token là biên giới), nhưng "DNS manipulation detected" đang được liệt kê như lớp phòng thủ #4/#5 mà thực tế **trơ**.
**Fix:** hoặc gỡ/ghi chú trung thực lớp DNS; hoặc siết TTL token để giảm độ trễ thu hồi; thu hồi thật nên làm ở **edge lúc mint** (không cấp token mới cho key đã thu hồi) — vốn đã đúng.

### F8 — 🟡 Low — `is_sensitive_path` chỉ khớp chuỗi (symlink/UNC/8.3/`\\?\` bypass)
**Vị trí:** `desktop/src-tauri/src/lib.rs` (`is_sensitive_path`), dùng bởi `read_system_file`/`get_file_size`/`render_tile_jpeg`/…
**Vấn đề:** guard chuẩn hoá **lexical** rồi mới `std::fs::read`/`metadata` (follow link). Renderer bị patch/nhiễm có thể:
- Symlink đuôi whitelist trỏ file nhạy cảm: `…\Documents\art.pdf` → `C:\Users\bob\.ssh\id_rsa` (cần quyền tạo symlink).
- Prefix né block thư mục: `\\?\C:\Users\bob\.aws\…`, UNC `\\127.0.0.1\c$\…`, tên 8.3 `RUNNER~1` không khớp `home_l` long-form.
Là defense-in-depth (kẻ patch renderer đã mạnh sẵn), nhưng guard nên đúng.
**Fix:** `canonicalize`/`GetFinalPathNameByHandle` **trước** khi kiểm; từ chối reparse point, UNC, `\\?\`; so với home-root đã canonical.

### F9 — 🟡 Low — Integrity frontend là no-op trên bản NSIS (thiếu Authenticode)
**Vị trí:** `desktop/src-tauri/src/lib.rs` (`verify_frontend_integrity`, nhánh fallback khi không có `dist/` trên đĩa).
**Vấn đề:** Tauri v2 nhúng `dist/` vào binary ⇒ không có `dist/`/`index.html` trên đĩa ⇒ hàm rơi vào nhánh chỉ `log_self_exe_hash()` (log, không chặn). `PRYNX_FRONTEND_HASH` không bao giờ được so ở production. Neo đúng duy nhất cho frontend nhúng là **Authenticode + WinVerifyTrust**, hiện chưa bật. (Bản tự-audit cũng thừa nhận.)
**Fix:** bật Authenticode; self-check module đang chạy bằng `WinVerifyTrust` lúc khởi động; đừng quảng bá đây là lớp đang thực thi khi chưa có.

### F10 — 🟡 Low — Nhánh `fetch` thường không ghi đè header auth do caller đặt
**Vị trí:** `desktop/src/lib/api.ts:184-190`.
**Vấn đề:** nhánh này chỉ set header khi **vắng** (`if (!merged.has(k))`), khác `authenticatedFetch`/nhánh `Request` (ghi đè vô điều kiện). Caller/inject có thể đặt sẵn `X-License-Key/Token/Hardware-Id` để không bị native thay; đặt sẵn `X-PrynX-Signature` làm **bỏ ký** rồi request đi thẳng. **Fail-closed ở backend** (HMAC tính lại từ header ⇒ lệch → 403), nên chưa khai thác được — nhưng phá bất biến "WebView không tráo được header entitlement".
**Fix:** ghi đè header native **vô điều kiện** (như `authenticatedFetch`); strip `X-License-*`/`X-PrynX-*` do caller đưa vào cho request tới backend.

### F11 — 🟡 Low — `build.rs` nonce AES-GCM tất định
**Vị trí:** `native/build.rs:86-91` — nonce = hàm băm của (key, version, len). An toàn **chỉ khi** mỗi khoá dùng đúng một message. Nếu lỡ tái dùng `PRYNX_DIELINE_KEY_B64` cho bản build lại cùng `version` + cùng độ dài ⇒ lặp nonce dưới cùng khoá ⇒ vỡ GCM (lộ XOR bản rõ + giả tag). Footgun, chặn bởi kỷ luật quy trình.
**Fix:** random 12-byte nonce lúc build, prepend vào payload (định dạng đã mang nonce, không đổi runtime).

### F12 — 🟡 Low — `license-release` giữ private key chỉ để suy public key
**Vị trí:** `printsolutions-main/supabase/functions/license-release/index.ts:43-49` — nhận `LICENSE_SIGNING_KEY` rồi `getPublicKey`. Hàm release chỉ cần public key nhưng đang giữ **cả secret ký** ⇒ mở rộng bán kính khi hàm này bị lộ.
**Fix:** cấp riêng `LICENSE_PUBLIC_KEY` cho các hàm verify-only.

---

## 3. Khuyến nghị củng cố (không phải lỗ, nhưng nên làm)

- **Default-deny cho route:** thay vì trông chờ mỗi router nhớ gắn dep (1.5), thêm middleware ASGI enforce `require_license` cho toàn `/api/*` trừ allowlist (`/health`). Ngăn "router mới quên dep → hở âm thầm".
- **CI chặn regression:** (a) test chặn edge function xử lý khi thiếu auth (F1); (b) grep chặn `USING(true)` trên bảng nhạy cảm (đã nêu ở tài liệu cũ); (c) test khẳng định mọi router include trong `main.py` đều có dep license.
- **Siết `_MAX_TOKEN_LIFETIME` + TTL** theo lộ trình đã ghi (4 ngày) ngay khi token 7 ngày hết hạn.
- **Thống nhất verify:** dùng `verify_strict` cho ed25519 ở Rust (`security.rs`) cho đồng bộ với `dieline_license.rs`.

## 4. Giới hạn cố hữu (chấp nhận — không "sửa" được, chỉ nâng chi phí)

- **App máy khách ⇒ patch binary/dump RAM luôn mở được Pro trên máy đó.** Không lớp Ring-3 nào chặn tuyệt đối. Dieline crypto-lock (1.6) là cách đúng để **nâng chi phí** cho phần IP đáng giá; cân nhắc mở rộng mô hình "solver chạy server" (đã phân tích ở `HYBRID_ANTICRACK_REPORT.md`) cho các solver IP cao — **nhưng phải kèm auth** (xem F1, đó chính là bài học sống).
- **Anti-debug chỉ log; process mitigations mặc định TẮT** (chủ ý, tránh crash driver máy in) ⇒ x64dbg/Frida attach tự do đọc token/`rk`/engine đã giải mã. Đây là đánh đổi ổn định↔bảo mật, chấp nhận được nếu biết rõ.
- **Token là bearer:** người đã trả tiền có thể chia sẻ token (72h) hoặc key (giới hạn 2 máy). Không tránh được hoàn toàn với license offline; TTL ngắn + giới hạn thiết bị là biện pháp đúng.

## 5. Việc VẬN HÀNH bắt buộc (ngoài code)

1. **Revoke ngay token truy cập Supabase `sbp_…`** mà bản tự-audit ghi "đã tạo cho lần deploy này… nên revoke". Đây là secret quản trị sống.
2. **Rotate 45 key** từng phơi nhiễm trong thời gian lỗ RLS mở (đã nêu từ audit 2026-06).
3. **Xác nhận deploy** đầy đủ migration `20260726110000_...` (F2) và giữ private key `LICENSE_SIGNING_KEY` chỉ trong Supabase secret.
4. **Bật Authenticode** (~$10/tháng) — bịt F9 và hết cảnh báo SmartScreen; đây là neo tin cậy còn thiếu của toàn mô hình client.
5. **Chốt trần input** cho các edge solver công khai (F1) + IP tin cậy cho rate-limit (F6).

---

## Phụ lục — phương pháp & bằng chứng

- Đọc trực tiếp (staged, có số dòng): `license-verify/index.ts`, `sepay-webhook/index.ts`, `bin-packing/index.ts`, `license_guard.py` (toàn bộ), `verify_license_edge` trong `20260726110000_...sql`.
- Quét độ phủ guard: script AST + regex-paren-balance trên toàn `backend/app/api/routes/*.py`, đối chiếu `APIRouter(dependencies=...)` — kết luận 0 endpoint Pro hở.
- Xác minh 4 lớp song song (server / sidecar / Rust-Tauri / frontend) bằng đọc `security.rs`, `lib.rs`, `dieline_license.rs`, `dieline_engine.rs`, `capabilities/default.json`, `api.ts`, `useAuthStore.ts`, `features.ts`, `licenseToken.ts`.
- Không chạy build, không đụng production DB, không thực thi khai thác — chỉ đọc code + suy luận đối kháng.
- Mức độ tin cậy: F1, F2, F3, F4, F7 và toàn bộ §1 **đã verify trực tiếp**; F5, F8, F9, F10, F11 dựa trên đọc file staged (số dòng theo bản staged, nên đối chiếu lại khi sửa).
