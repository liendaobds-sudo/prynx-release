# Log sửa — audit chống crack 2026-08-28

> Báo cáo gốc: `docs/BAO_CAO_AUDIT_CHONG_CRACK_2026-08-28.md`
> Quy trình: `prynx-audit-workflow` giai đoạn 3 (sửa theo lô ≤5 file, verify sau mỗi lô).
> Hai repo: `d:\pdfcompare` (client + sidecar), `d:\printsolutions-main` (server Supabase).
>
> **Đã sửa 12/15 finding.** Ba finding còn lại cần hạ tầng hoặc quyết định thương mại — xem §Còn lại.

---

## Bảng trạng thái finding

| ID | Mức | Trạng thái | Lô |
|---|---|---|---|
| §SEC.01 | 🔴 P0 | **Verified** — Free không còn gọi được endpoint CNC/máy bế | A |
| §SEC.02 | 🟠 P1 | **Applied** (đã verify trên Postgres tạm; chờ `db push`) | D |
| §SEC.03 | 🟠 P1 | **Còn mở** — cần dump từ production | — |
| §SEC.04 | 🟠 P2 | **Verified** — vá tại gốc, có test junction thật | B |
| §SEC.05 | 🟠 P2 | **Verified** — allowlist tiến trình | C |
| §SEC.06 | 🟠 P2 | **Applied** (chờ deploy) | E |
| §SEC.07 | 🟠 P2 | **Verified** — staging grant đòi `fs_scope` | C |
| §SEC.08 | 🟠 P2 | **Applied** (đã verify trigger; chờ `db push`) | D |
| §SEC.09 | 🟠 P2 | **Accepted risk** — giữ nguyên, đã có tài liệu | — |
| §SEC.10 | 🟠 P2 | **Applied** (chờ set secret + deploy) | E |
| §SEC.11 | 🟡 P3 | **Accepted risk** — cần code signing | — |
| §SEC.12 | 🟡 P3 | **False positive → đã đóng** + gate thường trực | F |
| §SEC.13 | 🟡 P3 | **Verified** — mọi test entitlement nay tự bật gate | A/G |
| §SEC.14 | 🟡 P3 | **Verified** — thêm test + mở rộng phạm vi CI | G |
| §SEC.15 | 🟡 P3 | **Còn mở** — thuộc spec `save-as-artifact-guard` | — |

---

## Lô A — §SEC.01: Free dùng được tính năng Pro (P0)

**File:** `backend/app/workers/cut_export/api.py`,
`backend/app/workers/cut_export/tests/test_api.py`, `backend/tests/test_free_token_e2e.py`

| Thay đổi | Lý do |
|---|---|
| `APIRouter(dependencies=[Depends(require_license), Depends(require_feature("impo.cnc"))])` | Router chỉ có `require_license` ⇒ license Free hợp lệ gọi được 10 endpoint xuất luồng cắt và đẩy TCP/serial tới máy bế. Gate ở **cấp router** để endpoint thêm sau tự động có quyền. |
| Test override `lambda: True` → dict `_PRO_LICENSE` | Override cũ là **bool**, nó vô hiệu hoá luôn `require_feature` (vì `require_feature` phụ thuộc `require_license`) ⇒ bộ test đó **không thể** phát hiện lỗ này. |
| Fixture `gating_on` (monkeypatch `FEATURE_GATING_ENABLED=True`) | Chạy từ source thì gate mặc định **TẮT** (§SEC.13). Không bật tường minh thì mọi assert 403 xanh giả. |
| 3 assert cut-export trong `test_free_token_e2e.py` | E2E dùng chuỗi license THẬT (HMAC + Ed25519 + entitlement), nằm trong `tests/` nên chắc chắn chạy ở CI. |

**Verify:** 43 passed.
**Kiểm độ nhạy:** tạm bỏ gate → **10 failed / 33 passed**; phục hồi → 43 passed. Test có răng thật.

**Ghi chú không gây hồi quy UI:** tab "Máy bế" trong `SettingsModal.tsx:61-64` đã bị comment ẩn từ trước, nên gate cả router không làm vỡ lối vào nào của người dùng Free.

---

## Lô B — §SEC.04: `is_sensitive_path` bị đi vòng

**File:** `desktop/src-tauri/src/lib.rs`

Hàm cũ so khớp **chuỗi thô** do renderer gửi, nên mọi biến thể cùng trỏ một file đều lọt.
Vá tại **gốc** (giữ nguyên signature ⇒ cả 20+ call-site được bảo vệ), thay vì vá lẻ 4 call-site nóng như trước:

1. `strip_path_prefix_aliases()` — bóc `\\?\`, `\??\`, `\\?\UNC\` → `\\`; lặp 4 lượt vì Win32 nhận tiền tố lồng nhau.
2. `is_admin_or_device_share()` — chặn `\\.\` và UNC có share kết thúc bằng `$` (`\\localhost\C$`). **Share NAS hợp lệ của xưởng in dùng tên share nên không bị chặn** — luồng mở PDF trên mạng vẫn chạy.
3. Canonicalize khi path tồn tại rồi so **lại** — bước này mới thật sự bịt tên 8.3, junction và symlink.
4. `is_sensitive_write_path` tách tương tự; fallback resolve thư mục **cha** vì đích ghi thường chưa tồn tại. Bổ sung chặn Startup per-user (trước đây lệch với `fs:allow-write-file` deny).

**Test mới:** `sensitive_path_khong_bi_di_vong_bang_bien_the_path` (có assert chốt rằng cách so **cũ** để lọt — nếu ai gỡ normalization thì test đỏ kèm lý do), `sensitive_path_resolve_junction_ve_thu_muc_nhay_cam` (tạo junction thật, `#[cfg(windows)]`).

**Verify:** `cargo test --lib` = 162 passed.

---

## Lô C — §SEC.05 + §SEC.07

**File:** `desktop/src-tauri/src/external_app.rs`, `desktop/src-tauri/src/lib.rs`,
`desktop/src/components/imposition-tools/OpenInDesignModal.tsx`

### §SEC.05 — `launch_external_app` chạy `.exe` tuỳ ý

Guard cũ chỉ là "đuôi `.exe` + tồn tại + không nhạy cảm" ⇒ renderer bị patch/XSS chạy được `.exe` bất kỳ trong Downloads hoặc `\\attacker\share\evil.exe`. Đây là primitive mạnh nhất renderer có trong toàn bộ bề mặt IPC.

Nay phải qua allowlist, **ba nguồn đều không do renderer quyết**:
1. kết quả `detect_design_apps` (Rust đọc registry rồi `is_file()`) — nay được ghi nhận tự động;
2. path người dùng vừa chọn qua hộp thoại native (thể hiện bằng `fs_scope`);
3. path đã duyệt ở phiên trước (`design-apps-approved.json` trong `app_data_dir`, trần 16 mục).

Thêm chặn `is_network_or_device_path` + symlink. Phần quyết định tách thành `decide_app_authorization()` thuần để unit-test được.

**UX:** máy đã nhớ đường dẫn tuỳ chọn trong `localStorage` **từ trước bản vá** sẽ bị từ chối đúng một lần. `doOpen` nay tự mở lại hộp thoại khi gặp lỗi "chưa được cấp quyền", nên người dùng không phải tự mò lại nút "Chọn .exe".

### §SEC.07 — staging grant hợp pháp hoá path vượt `fs_scope`

`copy_file_atomic` không kiểm `fs_scope`, mà đích có tên staging của New Window lại được cấp quyền một lần để mở cửa sổ tài liệu **không cần** `fs_scope`. Nay **chỉ** đường đặc quyền đó đòi canonical source nằm trong `fs_scope`, kiểm **trước** khi copy (không để lại file rác ở `%TEMP%`). Save As bình thường không đổi.

**Verify:** `cargo check` EXIT=0; `cargo test --lib` = 164 passed; `tsc --noEmit` EXIT=0; vitest `OpenInDesignModal` 9/9.

---

## Lô D — §SEC.02 + §SEC.08 (repo `printsolutions-main`)

**File:** `supabase/migrations/20260828100000_prynx_activation_hardening.sql` (mới),
`supabase/migrations/security-manifest.json`, `supabase/tests/*.sql` (3 file mới)

### Rà consumer TRƯỚC khi sửa — điều này quyết định thiết kế bản vá

`verify_license_guarded` được GRANT cho `anon` với `p_product_id DEFAULT 'prynx'`. Phản xạ đầu tiên là REVOKE khỏi `anon` — **nhưng làm vậy sẽ khoá chết toàn bộ tool đang bán**:

| Tool | product_id | Đường gọi |
|---|---|---|
| `1. Nô lệ bế xén*.jsx` | `bexen` | RPC trực tiếp, anon key |
| `2. dev Nô lệ mẹc số.jsx` | `mecso` | RPC trực tiếp |
| `3. Nô lệ mẹc bìa.jsx` | `mecbia` | RPC trực tiếp |
| `4. dev Nô lệ dữ liệu.jsx` | `dulieu` | RPC trực tiếp |
| `multi_tem_placer.jsx` | `multi_tem_placer` | `verify_license_guarded` |
| `LicenseBridge.ps1` | tham số `-ProductId` | RPC trực tiếp |
| `PrintMonitorApp` | `print_monitor_app` | qua Edge |

**Không tool nào gửi `prynx`.** Nên bản vá siết đúng mặt bị lạm dụng: chặn `product_id='prynx'` trên đường công khai, giữ nguyên quyền `anon` cho mọi sản phẩm khác.

### Sáu mục của migration

1. `prynx_caller_is_service_role()` — đọc **chỉ** `request.jwt.claims->>'role'`. Fail-closed.
2. `prynx_trusted_request_ip()` — `cf-connecting-ip` → `x-real-ip` → **hop cuối** của XFF; đọc `request.headers` (JSON, PostgREST v10+) trước rồi mới tới GUC lẻ.
3. `verify_license` dựng lại — chặn `prynx`; `pg_advisory_xact_lock` quanh ĐẾM→CHÈN; dùng IP tin cậy. **Giữ nguyên hình dạng response** vì các `.jsx` đang parse `status`/`expires_at`/`remaining_days`.
4. `verify_license_guarded` dựng lại — chặn `prynx` ngay ở cửa (không tiêu rate-limit cho request đã bị từ chối).
5. Thu hồi quyền: overload ≠3 tham số khỏi `PUBLIC, anon, authenticated`; `PUBLIC` trên 3-param rồi GRANT lại tường minh.
6. Trigger `prynx_release_resource_key_immutable` — chặn `UPDATE resource_key` khi `revoked_at IS NULL` (§SEC.08). Đường thu hồi hợp pháp vẫn mở.

### Verify — harness Postgres 16 trong Docker đã bắt 4 lỗi THẬT trong chính bản vá này

Đây là phần đáng ghi lại nhất của cả đợt: đọc SQL không đủ.

| # | Lỗi trong bản vá đầu | Hậu quả nếu ship |
|---|---|---|
| 1 | Nhánh dự phòng `session_user in ('postgres',...)` | `SET ROLE` **không** đổi `session_user` ⇒ request anon vẫn qua ⇒ **fail-open, lớp chặn vô hiệu** |
| 2 | `return v_claims_role = 'service_role'` | Claims thiếu/rỗng ⇒ NULL; `IF NOT NULL` **không** vào nhánh chặn ⇒ **fail-open** |
| 3 | Chỉ đọc GUC `request.header.*` | Tên GUC hai dấu chấm không set được; PostgREST v10+ dùng `request.headers` JSON ⇒ rate-limit luôn bucket `unknown` |
| 4 | Chỉ revoke `anon`/`authenticated` | `PUBLIC` có EXECUTE **mặc định** ⇒ `has_function_privilege('anon', ...)` vẫn TRUE ⇒ thu hồi vô nghĩa |

Sau khi sửa: 8 nhóm ca (CA1–CA8) toàn bộ đạt mong đợi — `prynx` qua anon = FORBIDDEN kể cả biến thể hoa/thường và claims rác; `bexen`/`mecso`/`mecbia`/`dulieu`/`multi_tem_placer` không bị ảnh hưởng; `service_role` vẫn kích hoạt được; trigger chặn đúng và vẫn cho đổi sau khi thu hồi.

**Đua đếm thiết bị (pgbench, 16 client song song, license trần 2 máy):**

| | Số máy kích hoạt được |
|---|---|
| Code cũ (không advisory lock) | **16** |
| Code mới | **2** |

Harness lưu tại `supabase/tests/` để tái chạy (hướng dẫn Docker trong header file).

---

## Lô E — §SEC.06 + §SEC.10 (repo `printsolutions-main`)

**File:** `supabase/functions/bin-packing/index.ts`, `supabase/functions/license-release/index.ts`,
`src/securityAuditAntiCrack2026_08_28.test.ts` (mới)

### §SEC.06 — `bin-packing` fail-open + không trần input

Hai fail-open độc lập:
- toàn bộ kiểm subscription nằm trong `if (authHeader)` không có `else`, kèm comment *"allow anonymous access for now (tool gate handles client-side)"*. Nhưng solver guillotine chính là loại IP mà `HYBRID_ANTICRACK_REPORT.md` khuyên đưa lên server **để giấu** — để nó gọi ẩn danh là biến thuật toán thành API công khai. "Tool gate ở client" không phải biên cưỡng chế.
- `if (subData && !subData.has_access)` — `subData` null thì vượt qua.

Nay: thiếu `Authorization` → 401; `!subData || subData.has_access !== true` → 403. Thêm `validateLayoutInput()` với trần `MAX_ITEM_KINDS=2000`, `MAX_QUANTITY_PER_ITEM=10000`, `MAX_TOTAL_PIECES=50000`, `MAX_DIMENSION_CM=10000`, `MAX_CANVAS_CM=10000`, kiểm **trước** khi bung `flatJobList` → 422. Error handler trả `error.name` thay vì `error.message` (chuẩn anti-recon, theo bản vá BG2 ở `SECURITY_ARCHITECTURE` §22.2).

**Không đụng người dùng thật:** `src/hooks/useBinPacking.ts:65` dùng `supabase.functions.invoke` (luôn kèm Authorization), và `check_tool_subscription` luôn trả JSONB có `has_access`. Bản vá chỉ đóng đường `curl` không header.

### §SEC.10 — `license-release` được cấp private key

Function **chỉ verify** nhưng đọc `LICENSE_SIGNING_KEY` rồi `ed.getPublicKey()` để suy public key ⇒ mở rộng bán kính rò khoá ký license của toàn hệ thống một cách vô ích. Nay đọc `LICENSE_PUBLIC_KEY` (kiểm đúng 32 byte), fail-closed nếu chưa set. **Cố ý không fallback** về private key — fallback sẽ khiến bước set secret bị bỏ quên mãi.

**Verify:** `esbuild` parse cả hai file EXIT=0. Ratchet chạy lần đầu **đỏ 3 ca** vì chính comment giải thích của tôi chứa lại chuỗi cũ (`LICENSE_SIGNING_KEY`, `"allow anonymous access"`, `if (subData && !subData.has_access)`) → thêm `stripTsComments()` (scanner theo ký tự, không cắt `//` trong chuỗi để không phá import URL) + một test kiểm chính helper đó. Sau sửa: 53/53 passed.

---

## Lô F — §SEC.12: JWT literal trong repo → **không phải lỗ**

Đo bằng scanner tự viết (dùng `git ls-files`; `rglob` phải liệt kê cả `node_modules` nên chậm tới mức không dùng được):

| Chỉ số | Kết quả |
|---|---|
| JWT literal trong `printsolutions-main` | 32 |
| JWT literal trong `pdfcompare` | 0 |
| Số khoá **khác nhau** | **1** |
| `role` | **`anon`** cho cả 32 vị trí |
| project ref | `ryvyuxjgdcvoxujqmggm` |

**Không có `service_role` key nào bị commit.** Anon key công khai là đúng thiết kế.

Rủi ro thật là **tương lai**: một lần dán nhầm `service_role` là compromise toàn hệ thống (bypass mọi RLS ⇒ đọc `release_resource_keys` ⇒ lấy khoá engine dieline). Nên lần kiểm thủ công này đã thành **gate thường trực**: 3 test trong `src/securityAuditAntiCrack2026_08_28.test.ts`, gồm một test độ nhạy dùng token **tự dựng** `role=service_role` (chứng minh scanner đọc được role thật) và một test chống phạm vi quét rỗng. Test **không bao giờ in token** — chỉ `file:dòng` + `role`, vì log CI là nơi công khai.

---

## Lô G — §SEC.14 + ratchet chống tái phát cả *class* lỗi

**File:** `.github/workflows/ci.yml`, `backend/tests/test_pro_feature_enforcement_coverage.py` (mới),
`backend/tests/test_sticker_sheet_feature_gate.py` (mới)

### Phát hiện khi làm lô này: CI không chạy test của cut_export

`backend-lint` chạy `pytest tests/`, còn bộ test cut_export nằm ở `app/workers/cut_export/tests/` ⇒ **CI chưa bao giờ chạy nó** — đúng module vừa bị phát hiện thiếu gate. Đã đổi thành `pytest tests/ app/workers/cut_export/tests/`.

### Ratchet: mọi quyền Pro phải được cưỡng chế ở backend

Đây là phần quan trọng nhất về dài hạn: nó đóng **class** lỗi §SEC.01, không phải một instance. Thêm quyền vào `PRO_FEATURES` mà không enforce ở đâu ⇒ CI đỏ ngay.

Ratchet lập tức bắt được `prepress.paper_library`. Đã xác minh đây **không phải sót** mà là accepted risk đã ghi (threat model §6: Paper Library chạy hoàn toàn trong WebView, gate ở `PaperLibraryTool.tsx:247`, **0** bề mặt backend). Xử lý: đưa vào `_CLIENT_ONLY_ACCEPTED_RISK` kèm **kiểm hai chiều** — nếu một ngày backend enforce nó thì test đỏ và buộc xoá khỏi danh sách miễn trừ + cập nhật threat model. Không có chiều ngược này thì danh sách miễn trừ chỉ phình ra và âm thầm che mất lỗ thật.

### Test 403 cho `sticker_sheet`

`test_sticker_sheet_api.py` dài 2133 dòng nhưng **0 assert 403**, trong khi router có 10 endpoint gate `prepress.cutline`. Đã thêm test cho cả 10 endpoint + grant lẻ mở được + grant tool khác không mở được.

**Verify:** `pytest tests/ app/workers/cut_export/tests/` = **4330 passed, 2 skipped, 0 failed**.

---

## Còn lại — cần bạn thực hiện

### A. Bắt buộc trước khi bản vá server có hiệu lực

1. **`supabase db push`** migration `20260828100000_prynx_activation_hardening.sql`, rồi chạy mục **KIỂM SAU DEPLOY** ở cuối file (5 bước, 4 bước đầu chỉ-đọc).

   ⚠️ **Bước 3 là bước nguy hiểm nhất:** phải xác nhận PrynX vẫn kích hoạt được bằng license thật trên app đã cài. Nếu `verify_license_edge` gọi `verify_license` mà JWT claims **không** mang `role=service_role` thì lớp chặn mới sẽ **chặn oan chính PrynX**. Không xác minh được từ repo vì `verify_license_edge` **không có định nghĩa trong repo** (§SEC.03). Nếu gặp FORBIDDEN: xử §SEC.03 trước, đừng nới lớp chặn.

2. **`supabase secrets set LICENSE_PUBLIC_KEY=<base64 raw public key>`** rồi mới deploy `license-release`. Giá trị = `_LICENSE_PUBLIC_KEY_B64` trong `backend/app/core/license_guard.py`. Thiếu bước này thì function fail-closed 403.

3. Deploy `bin-packing`.

### B. §SEC.03 — đóng khoảng trống provenance

`supabase db pull` (hoặc dump định nghĩa `verify_license_edge`) rồi commit thành migration có số thứ tự, cập nhật `security-manifest.json`. Hiện tại một clean checkout **không dựng lại được** production: ba migration `20260726*` đã mất, và bốn control mà audit trước ghi là "đã chắc" (advisory lock activation, rate-limit theo IP tin cậy, khoá tài nguyên bất biến, REVOKE khỏi anon) không có bằng chứng nào trong repo. Cần credential production nên tôi không làm được.

### C. §SEC.11 — quyết định thương mại

Integrity của exe/frontend vẫn **không được cưỡng chế** trên bản NSIS (Tauri nhúng `dist/` vào binary nên nhánh kiểm luôn bị skip). Đường crack hiện thực nhất còn nguyên: patch `PrynX.exe` → patch public key trong sidecar Nuitka → tự ký token `plan=pro`. **Không có gì trong code sửa được** (chicken-egg: không nhúng hash của exe vào chính exe đó). Cách duy nhất là Authenticode + `WinVerifyTrust` lúc khởi động. Đây là quyết định chi phí, không phải kỹ thuật.

### D. §SEC.15 — thuộc spec khác

`save_as_only` chỉ là hint gửi renderer, không có cưỡng chế native. Thuộc spec `save-as-artifact-guard` đang mở; sửa liều ở đây sẽ đụng thiết kế đang dở.

### E. §SEC.09 — giữ nguyên có chủ ý

Cổng `rk` cho phép 3 bản/giờ, không có trần tổng. Đây là đánh đổi **đã có tài liệu** (nhịp phát hành thật ~10 bản/30 ngày nên trần tổng bắn vào chính khách hàng). Nếu mô hình đe doạ của bạn là "đối thủ mua một license Pro rồi kiên nhẫn thu khoá mọi bản" thì cần thêm trần mềm để **báo động**, không chặn.

---

## Điều KHÔNG được suy diễn từ log này

1. **Chưa QA trên bản đã cài.** Toàn bộ verify là test tự động + harness cục bộ. Các lô B/C sửa Rust nên phải chạy `build_production.ps1` rồi kiểm thật: mở PDF trên NAS (`\\nas\...`), mở file bằng Illustrator/Corel (cả đường dò được và đường tự chọn `.exe`), New Window, Save As, đường IN.
2. **Chưa có bản cài nào chứa các bản vá này.** Mọi mục release-only vẫn phải QA sau khi build (§15.1 của `SECURITY_ARCHITECTURE`).
3. **Bản vá server chưa chạy trên production** — chỉ chạy trên Postgres 16 tạm với schema stub.
4. **`printsolutions-main` có 6 test đỏ có sẵn** (`ScrollToTop` 3, `nestingEngine` 3), không do đợt này. Hai file đó chỉ import `@/engine/dieline/*` và component UI.
5. **Working tree `pdfcompare` không sạch** từ trước đợt này (WIP mixed_nesting). Build phát hành phải từ cây đã commit.
