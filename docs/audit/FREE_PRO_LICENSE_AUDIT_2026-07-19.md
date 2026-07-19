# Báo cáo audit Free/Pro — PrynX

**Ngày audit:** 2026-07-19
**Phạm vi:** Desktop PrynX (`D:\pdfcompare`) + Website/license server PrintSolutions (`D:\printsolutions-main`)
**Phương pháp:** Audit chỉ đọc — đối chiếu code/config thực tế. Không sửa code, không deploy, không đụng production data.
**Vai trò:** Senior software architect + security auditor

---

## A. Kết luận điều hành

### **Chưa sẵn sàng phát hành Free/Pro**

Lớp **xác thực license (Ed25519 token + sidecar HMAC + HWID)** đã khá vững cho production.
Lớp **phân quyền Free/Pro** vẫn **chưa đóng kín** vì:

1. **Feature gating mặc định tắt** (dev/test); production phụ thuộc build script + `option_env!` Rust — có đường phát hành mở toàn bộ tool.
2. **Backend chỉ gate một phần** Pro features; nhiều tool Pro chỉ có UI gate hoặc `require_license` (có token Free là chạy được).
3. **Fail-open entitlements** khi thiếu/lỗi plan: server & sidecar fallback **Pro** (cố ý cho rollout key cũ) — nguy hiểm nếu bật Free thương mại.
4. **Offline grace = TTL token 7 ngày** → key bị revoke vẫn dùng offline tối đa ~7 ngày.
5. **Chưa có suite regression** cho 20 kịch bản bắt buộc; test unit còn **kỳ vọng gate = off**.

---

## B. Bảng phát hiện

| Mã | Mức | Thành phần | Mô tả | Bằng chứng | Khai thác / tái hiện | Ảnh hưởng Free/Pro | Sửa đề xuất | Test regression |
|----|-----|------------|-------|------------|----------------------|-------------------|-------------|-----------------|
| **LIC-001** | **Critical** | Desktop + Backend | **Feature gating mặc định `false`**. `canUse` / `can_use_feature` luôn cho phép khi flag off. | `desktop/src/lib/license/features.ts` L47, L69–70; `backend/app/core/feature_entitlements.py` L7–8, L37–38; tests kỳ vọng `False` | Build không qua `build_production.ps1`, hoặc flag không vào binary → Free = full Pro | Free = Pro | Fail-closed production: binary Nuitka luôn `FEATURE_GATING=true`; test production build assert flag on | Build smoke: assert gating true trong release artifact |
| **LIC-002** | **Critical** | Backend API | **Nhiều Pro endpoint không có `require_feature`**. Free token hợp lệ vẫn gọi được. | `pdf_tools.py` `/trim-shift` L225–230 (chỉ `require_license`); `imposition.py` `/execute-plan-json` L166–168 (router chỉ `require_license` L18); `impo.cnc` / `impo.booklet` / batch resize-office **không** có `require_feature` trong tree | Free user: DevTools/`authenticatedFetch` → `POST /api/pdf-tools/trim-shift` hoặc nup/booklet path không enforce feature đúng | Free vượt UI, chạy Pro | Map `require_feature` / `enforce_feature` cho **mọi** Pro FeatureId trên endpoint thực thi | Free token → 403 từng Pro endpoint |
| **LIC-003** | **Critical** | Backend + Edge + Desktop | **Plan thiếu/lạ → Pro (fail-open entitlements)** | `license_guard.py` `_read_verified_entitlements` L380–382, L448; edge `license-verify/index.ts` L227–245 (lookup fail → `plan='pro'`); `useAuthStore.ts` L181–182, L438, L631 default `'pro'` | Token cũ không có `plan`, hoặc lỗi đọc `licenses.plan` → coi là Pro | Free có thể thành Pro sau lỗi/rollout | Production: missing plan → **free** (hoặc refuse); legacy chỉ whitelist key Pro đã migrate | Token thiếu plan, plan invalid, DB error |
| **LIC-004** | **High** | Client offline | **Revoke offline tối đa ~7 ngày** (TTL token) | Edge `TOKEN_TTL_SECONDS = 7*24*3600` (`license-verify` L12); desktop token-driven offline (`useAuthStore` L516–528) | Admin khóa key; client offline giữ token → dùng đến `exp` | Pro/Free đã revoke vẫn chạy offline | Rút TTL (vd 24–48h) hoặc short-lived + refresh; document trade-off | Scenario 8: revoke + offline network |
| **LIC-005** | **High** | Backend feature map | **Gate không đồng bộ FeatureId** | VDP cả router = `vdp.datamerge` (`vdp.py` L33) → numbering/cover “đi nhờ” datamerge; preflight router = `prepress.preflight` L36 → convert_colors/hairlines/pdfx đi nhờ; thiếu gate riêng `impo.booklet`, `impo.cnc`, `pdf.resize_batch`, `pdf.office_batch`, `packaging.dieline` | Free gọi VDP numbering nếu datamerge bị chặn nhưng… thực tế cả router Pro; **ngược lại** booklet/cnc/trim_shift có thể không bị chặn đúng id | Ma trận quyền lệch catalog | `enforce_feature` theo `task_mode` / tool cụ thể; packaging: gate export path | Matrix test per FeatureId |
| **LIC-006** | **High** | Desktop client-only tools | **`packaging.dieline` chỉ UI gate** — engine ở frontend (`useBoxStore` / dieline TS), không sidecar feature check | Catalog Pro: `features.ts` L35; không có `require_feature("packaging.dieline")` backend | Free bypass `handleOpenApp` / deep-link / patch JS → vẽ khuôn offline | Free dùng Pro packaging | Server-side export gate hoặc signed capability; hoặc chấp nhận risk + watermark | Free open dieline API path |
| **LIC-007** | **High** | Build/Rust | **`PRYNX_FEATURE_GATING_ENABLED` qua `option_env!`**, `build.rs` **không** `rerun-if-env-changed` cho flag này | `lib.rs` L1535–1536; `build.rs` chỉ SIDECAR/FRONTEND hash L5–6 | Cargo cache + SkipNuitka / rebuild không invalidate → spawn sidecar `"false"` dù script set `true` | Production ship full Pro backend | `cargo:rerun-if-env-changed=PRYNX_FEATURE_GATING_ENABLED`; assert post-build | CI parse binary strings / startup log diag |
| **LIC-008** | **High** | Build | **SkipNuitka chỉ check sidecar tồn tại**, không check freshness/hash code | `release_update.ps1` L117–123 | Ship frontend gating on + sidecar cũ không có `require_feature` | Free bypass backend | Sidecar content hash / min version gate; cấm SkipNuitka khi đổi license code | Mismatch frontend/sidecar test |
| **LIC-009** | **Medium** | Rust security | **`register_validated_key` verify token chỉ advisory** — lỗi vẫn cache key | `security.rs` L273–280 | Token hỏng vẫn ký sidecar request; backend token enforce là backstop (OK nếu backend on) | Defense-in-depth yếu | Fail-closed khi enforce=true và token invalid | Enforce mode + bad token → không sign |
| **LIC-010** | **Medium** | Backend offline | Sidecar Supabase offline grace **5 phút** cache valid, nhưng **production thường không có service key** → rely 100% token | `license_guard.py` L496–501, L532–542 | Revoke không “đẩy” được khi offline; đúng thiết kế token | Revoke trễ | Accept + shorten TTL; telemetry | Offline grace unit |
| **LIC-011** | **Medium** | Schema default | Migration **`plan DEFAULT 'pro'`** + backfill Pro | `printsolutions-main/supabase/migrations/20260718_prynx_free_pro_entitlements.sql` L3–9 | Key mới quên set plan → Pro | Admin nhầm → tặng Pro | Default `free` cho product prynx; admin form default free cho trial | Create license no plan |
| **LIC-012** | **Medium** | Dual catalog | Feature list **duplicate** FE/BE, không single source | `features.ts` vs `feature_entitlements.py` | Lệch catalog sau khi thêm tool | Free/Pro lệch UI vs BE | Generate từ 1 JSON/schema | Catalog parity test |
| **LIC-013** | **Medium** | Desktop UX | `canUse(..., plan = 'pro')` default argument Pro | `features.ts` L69 | Caller quên plan → Pro | UI unlock nhầm | Default `'free'` | Static check callers |
| **LIC-014** | **Medium** | Localhost sidecar | Sidecar `127.0.0.1:8321`; CORS không chặn non-browser; bảo vệ = sidecar token + license token | `main.py` L210–211, L136–146 | Process local lấy token (debug/memory) → gọi API | Cần crack local | Accept residual risk; reduce token lifetime | External process without token → 403 |
| **LIC-015** | **Low** | Admin web | Admin CRUD plan qua RLS `is_admin()`; user own SELECT by email — **UPDATE plan cần admin** | RLS `20260212_fix_licenses_rls_critical.sql`; `useLicenses.ts` insert/update | User REST không UPDATE plan (nếu RLS live đúng) | User không self-upgrade (nếu migration đã apply) | Verify live policies; deny features self-edit | Anon/auth try UPDATE plan |
| **LIC-016** | **Low** | Rate limit | `verify_license` có RATE_LIMITED; desktop grace qua rate limit | `useAuthStore` L592–598 | Brute force key chậm; rate limit không lock user | Brute force bị hạn chế | Giữ; monitor `security_logs` | Rapid wrong keys |
| **LIC-017** | **Low** | Updater | Không thấy **minVersion / chặn downgrade** rõ trong config | updater plugin có; không audit được policy chặn bản bypass | Cài bản cũ gate-off | `dangerous: allowDowngrade=false` + min version server | Attempt install older |
| **LIC-018** | **Info** | Docs vs code | Docs nói token thiếu plan = Pro; quy trình bật đúng thứ tự server→desktop | `docs/PRYNX_FREE_PRO.md` L21–37 | Rollout sai thứ tự → quyền sai | Operational | Checklist bắt buộc | — |

### Điểm tốt (không phải finding xấu)

- Production binary: `DEV_MODE` fail-closed (`__compiled__`), `PRYNX_ENFORCE_LICENSE_TOKEN` luôn true ngoài dev.
- Token Ed25519: private key secret server; public key nhúng; verify exp + HWID + key hash + anti clock-rollback lifetime.
- `build_production.ps1` L155–156 set cả `VITE_` và `PRYNX_` gating true.
- Spawn sidecar: `DEV_MODE=false`, enforce token true (`lib.rs` L1528–1534).
- RLS licenses đã có hotfix gỡ “Anyone can SELECT”.
- Admin audit trigger trên `licenses` (migration phase2 security).
- Free vẫn **bắt buộc license key** (LoginScreen + verify RPC).

---

## C. Ma trận quyền

`UI` = `canUse` / HomeTab / App open.
`BE` = `require_feature` / `enforce_feature` **đúng FeatureId** (không tính “đi nhờ” router khác).

| FeatureId | Tên công cụ | Free | Pro | UI gate | Backend gate | Trạng thái |
|-----------|-------------|------|-----|---------|--------------|------------|
| pdf.shuffle | Xáo trộn trang | ✓ | ✓ | ✓ map | license only (OK Free) | OK |
| pdf.resize | Co giãn trang | ✓ | ✓ | ✓ | license only | OK |
| pdf.split | Tách PDF | ✓ | ✓ | ✓ | license only | OK |
| pdf.pages | Quản lý trang | ✓ | ✓ | ✓ | license only | OK |
| pdf.merge | Ghép PDF | ✓ | ✓ | ✓ | license only | OK |
| pdf.encrypt | Khóa PDF | ✓ | ✓ | ✓ | license only | OK |
| pdf.decrypt | Mở khóa PDF | ✓ | ✓ | ✓ | license only | OK |
| pdf.metadata | Metadata PDF | ✓ | ✓ | ✓ | license only | OK |
| pdf.optimize | Tối ưu cơ bản | ✓ | ✓ | ✓ | license only | OK |
| pdf.watermark | Watermark | ✓ | ✓ | ✓ | license only | OK |
| pdf.header_footer | Header & Footer | ✓ | ✓ | ✓ | license only | OK |
| pdf.office_convert | Office → PDF 1 file | ✓ | ✓ | ✓ | license only | OK |
| qc.compare_text | So sánh văn bản | ✓ | ✓ | ✓ | license only | OK |
| pdf.trim_shift | Trim & Shift | ✗ | ✓ | ✓ | **THIẾU** | **LỖ HỔNG** |
| pdf.resize_batch | Resize hàng loạt | ✗ | ✓ | partial UI | **THIẾU** | **LỖ HỔNG** |
| pdf.office_batch | Office batch | ✗ | ✓ | partial UI | **THIẾU** | **LỖ HỔNG** |
| pdf.optimize_advanced | Optimize nâng cao | ✗ | ✓ | ? | **THIẾU** | **RỦI RO** |
| prepress.preflight | Preflight chuẩn in | ✗ | ✓ | ✓ | ✓ router | OK khi gating on |
| prepress.convert_colors | Chuyển hệ màu | ✗ | ✓ | ✓ | **đi nhờ preflight** | OK-ish / map lệch |
| prepress.hairlines | Sửa nét mảnh | ✗ | ✓ | ✓ | đi nhờ preflight | OK-ish |
| prepress.trapping | Trapping | ✗ | ✓ | ✓ | đi nhờ preflight | OK-ish |
| prepress.pdfx | Xuất PDF/X | ✗ | ✓ | ✓ | đi nhờ preflight | OK-ish |
| prepress.cutline | Bù xén / đường cắt | ✗ | ✓ | ✓ | ✓ sticker-dieline | OK |
| vdp.datamerge | Trộn dữ liệu VDP | ✗ | ✓ | ✓ | ✓ router | OK |
| vdp.numbering | Nhảy số tự động | ✗ | ✓ | ✓ | **đi nhờ datamerge** | OK-ish / id lệch |
| vdp.cover_numbering | Chạy số bìa | ✗ | ✓ | ✓ | đi nhờ datamerge | OK-ish |
| impo.nup | Bình N-Up | ✗ | ✓ | ✓ | ✓ nup/impose-start | OK |
| impo.diecut | Bình tem bế | ✗ | ✓ | ✓ | ✓ | OK |
| impo.booklet | Bình sách / booklet | ✗ | ✓ | ✓ | **THIẾU id riêng** | **LỖ HỔNG** |
| impo.cnc | Bình CNC | ✗ | ✓ | ✓ | **THIẾU** | **LỖ HỔNG** |
| packaging.dieline | Khuôn bế bao bì | ✗ | ✓ | ✓ | **Không BE** | **UI-only** |
| util.bgremover | Tách nền | ✗ | ✓ | ✓ | ✓ | OK |
| util.upscale | AI Upscale | ✗ | ✓ | ✓ | ✓ | OK |
| qc.compare_pdf | So sánh PDF in ấn | ✗ | ✓ | ✓ | ✓ | OK |

> **Lưu ý:** Khi `FEATURE_GATING_ENABLED=false` (mặc định dev + rủi ro build), **toàn bộ hàng Pro = mở** (UI + BE).

---

## D. Sơ đồ luồng license

```
[Nhập key / auto_discover]
        │
        ▼
[Supabase RPC verify_license] ──INVALID/EXPIRED/DEVICE_LIMIT──► UI lock (+ revoke grace 5p online)
        │ VALID
        ▼
[Edge license-verify] ── ký Ed25519 token {k,m,p,plan,features,exp=now+7d}
        │  fail-open plan: missing lookup → plan=pro  ⚠
        ▼
[Desktop] DPAPI: key + token; register_validated_key (Rust cache; token verify ADVISORY ⚠)
        │
        ▼
[Tauri spawn sidecar]
  DEV_MODE=false
  PRYNX_ENFORCE_LICENSE_TOKEN=true          ← fail-closed (production binary)
  PRYNX_FEATURE_GATING_ENABLED=option_env!  ← có thể false ⚠
        │
        ▼
[Mỗi API call]
  HMAC sidecar token + ts ── fail ──► 403
  Ed25519 license token ── fail ──► 403 (production)
  plan/features từ token ── default pro nếu thiếu ⚠
  require_feature(id)? ── chỉ một số route ⚠
        │
        ▼
[Xử lý PDF]

Offline: còn token valid → dùng tới exp (≤7 ngày) dù server revoke.
Clock rollback: clkguard + max lifetime token → 403.
```

### Bảng fail-closed / fail-open

| Điểm | Fail-closed / Fail-open |
|------|-------------------------|
| Missing sidecar token (prod) | Closed |
| Missing/invalid license token (prod binary) | Closed |
| DEV_MODE compiled binary | Closed (forced false) |
| FEATURE_GATING unset | **Open (full features)** |
| plan missing/invalid | **Open → Pro** |
| Entitlement DB lookup fail (edge) | **Open → Pro** |
| Pro route without require_feature | **Open for Free token** |
| UI-only tool (dieline) | **Open if UI bypass** |
| Offline after revoke | **Open until token exp** |

### Trade-off offline vs thu hồi

| Ưu tiên | Hệ quả hiện tại |
|---------|-----------------|
| UX nghỉ lễ / mất mạng | Token **7 ngày** — tốt |
| Thu hồi nhanh | Chỉ chắc khi **online** (heartbeat 30p + revoke grace 5p); offline **≤7 ngày** |
| Khuyến nghị ship Free thương mại | TTL **24–48h** + refresh khi online; hoặc “hard features” chỉ online |

---

## E. Checklist release

| Hạng mục | Pass/Fail | Ghi chú |
|----------|-----------|---------|
| Database/migration Free/Pro | **Conditional** | File `20260718_prynx_free_pro_entitlements.sql` có; **chưa xác nhận đã apply live** trong audit này |
| Edge Function license-verify plan/features | **Pass code / Conditional deploy** | Code đúng hướng; fallback Pro khi lỗi lookup |
| Token signing (Ed25519) | **Pass** | Secret env; public embed; `.gitignore` SECRET |
| Offline grace | **Pass design / Fail policy revoke** | 7 ngày UX tốt; revoke chậm |
| Desktop gating | **Conditional** | Code có; **chỉ bật khi `VITE_FEATURE_GATING_ENABLED=true`** |
| Backend enforcement | **Fail incomplete** | Token OK; feature map thiếu nhiều Pro |
| Build flags | **Pass script / Risk cache** | `build_production.ps1` set true; Rust `option_env` + thiếu `rerun-if-env-changed` |
| Sidecar freshness | **Fail SkipNuitka** | Không fingerprint license code |
| Full tests (20 scenarios) | **Fail** | Chỉ unit entitlements (gate off) + token crypto |
| Updater/downgrade protection | **Unknown / Fail likely** | Không thấy minVersion chặn bản gate-off |
| Admin/RLS | **Pass code** | Admin plan CRUD; user SELECT own; cần verify live |
| Telemetry / audit log | **Pass partial** | `security_logs` + license audit triggers; mask key |

---

## F. Kết quả 20 kịch bản bắt buộc

Đánh giá theo code — **chưa chạy E2E production**.

| # | Kịch bản | Kỳ vọng | Theo code hiện tại |
|---|----------|---------|-------------------|
| 1 | Free tool Free | OK | OK nếu có license token |
| 2 | Free mở Pro UI | Block | **OK chỉ khi gating on**; off → mở |
| 3 | Free gọi endpoint Pro | 403 | **Fail** trim_shift/booklet/cnc/execute-plan…; OK một số (vdp, preflight, bg, upscale, nup) |
| 4 | Pro tool Pro | OK | OK |
| 5 | Sửa plan Free→Pro trong token | Reject sig | **Pass** (Ed25519) |
| 6 | Token hết hạn | 403 | **Pass** |
| 7 | Sai device ID | 403 | **Pass** |
| 8 | Revoke + offline | Lock ngay | **Fail** đến hết TTL ≤7d |
| 9 | Mất mạng trong grace | Dùng được | **Pass** (token-driven) |
| 10 | 7 ngày không mở app | Mở lại nếu token còn / online refresh | **Pass** nếu còn token hoặc online |
| 11 | Lùi giờ hệ thống | Block | **Pass** (clkguard + lifetime) |
| 12 | Xóa cache license | Phải nhập lại / invalid | **Pass** (clear DPAPI + validated keys) |
| 13 | Thiếu flag gating production | Build fail | **Fail** — script set, nhưng không hard-fail binary nếu `option_env` false |
| 14 | Sidecar cũ + FE mới | Fail closed | **Fail** SkipNuitka cho phép |
| 15 | plan/features null/invalid | Free an toàn | **Fail** → Pro |
| 16 | Hạ Pro→Free | Cập nhật sau re-verify | **Pass** khi online lấy token mới; offline giữ plan cũ đến exp |
| 17 | Nâng Free→Pro không cài lại | OK | **Pass** heartbeat/token refresh |
| 18 | 2 máy vượt device | DEVICE_LIMIT | **Pass** RPC |
| 19 | Gọi localhost không desktop | 403 | **Pass** thiếu sidecar token (trừ leak token) |
| 20 | Downgrade bản cũ | Chặn | **Fail / Unknown** |

---

## G. Việc phải làm trước khi gọi Free/Pro “sẵn sàng”

1. **Bật gating fail-closed** trên mọi production artifact; test assert flag on.
2. **Gắn `require_feature` đủ** catalog Pro (đặc biệt `trim_shift`, `booklet`, `cnc`, `execute-plan*`, batch, optimize advanced).
3. **Đổi default plan missing → free** (edge + sidecar + auth store) sau khi migrate key cũ = pro xong.
4. **`build.rs` `rerun-if-env-changed=PRYNX_FEATURE_GATING_ENABLED`** + cấm SkipNuitka khi đổi license modules.
5. **Suite E2E** tối thiểu kịch bản 2, 3, 5, 6, 7, 8, 15, 16, 19.
6. Xác nhận **migration + edge function đã deploy live**.
7. Quyết định chính sách **TTL token vs revoke**.

---

## H. Tham chiếu file chính

### Desktop / Backend (pdfcompare)

| Vai trò | Đường dẫn |
|---------|-----------|
| Catalog FE | `desktop/src/lib/license/features.ts` |
| Auth / offline / token | `desktop/src/stores/useAuthStore.ts` |
| Token claims | `desktop/src/stores/licenseToken.ts` |
| API headers | `desktop/src/lib/api.ts` |
| Rust token / cache | `desktop/src-tauri/src/security.rs` |
| Spawn sidecar env | `desktop/src-tauri/src/lib.rs` |
| Build rerun env | `desktop/src-tauri/build.rs` |
| License guard | `backend/app/core/license_guard.py` |
| Feature entitlements BE | `backend/app/core/feature_entitlements.py` |
| Production build flags | `build_production.ps1` |
| Release / SkipNuitka | `release_update.ps1` |
| Docs ma trận Free/Pro | `docs/PRYNX_FREE_PRO.md` |

### PrintSolutions (license server)

| Vai trò | Đường dẫn |
|---------|-----------|
| Edge verify + sign | `supabase/functions/license-verify/index.ts` |
| Migration plan/features | `supabase/migrations/20260718_prynx_free_pro_entitlements.sql` |
| RLS licenses | `supabase/migrations/20260212_fix_licenses_rls_critical.sql` |
| Admin licenses UI | `src/components/admin/AdminLicenses.tsx` |
| License hooks | `src/hooks/useLicenses.ts` |
| Types | `src/types/license.ts` |
| Deploy signing secret | `deploy_license_token.ps1` |

---

*Hết báo cáo.*
