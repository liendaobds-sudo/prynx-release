# Re-audit bảo mật §SEC.19 — chống rollback clock và token offline (2026-09-03)

> **Cập nhật trạng thái:** 2026-09-04. Khe replay `§ATK.09` sau sidecar respawn và body binding
> `§SEC.21` đã có control source/test; §SEC.19 tổng thể vẫn **Partially mitigated**, chưa `Closed`,
> vì các proof gap runtime/deploy/clock bên dưới chưa được giải quyết.
>
> **Chế độ:** re-audit bảo mật có validation cục bộ. Không tạo keygen/bypass/patcher,
> không dùng credential thật và không thử trên production.
>
> **Phạm vi:** `D:\pdfcompare` (backend + Tauri/Rust + renderer) và
> `D:\printsolutions-main\supabase\functions\license-verify`/`license-release`.
>
> **Revision:** `pdfcompare` HEAD `33143499ba1a46590ed2617af2406ecc805b48cd`,
> `printsolutions-main` HEAD `d122d55224a9639e5a27686561d5d8ad084f8e27`.
> Hai worktree có WIP sẵn của user; review đọc worktree hiện tại và không reset/commit.

## 1. Kết luận điều hành

Lô sửa §SEC.19 đã được áp dụng ở cả ba tầng và **đã giảm các đường reset/replay rẻ**:

- clock state backend không còn tự coi file thiếu/hỏng là mốc mới sau khi installation đã
  được thiết lập; key/marker/record được phân biệt và ghi nguyên tử;
- native signer và mọi nhánh offline của renderer đều kiểm tra `AnchorState`; anchor thiếu,
  hỏng hoặc không đọc được buộc online revalidation;
- đăng ký native khi khôi phục anchor yêu cầu token v2 có `iat` + challenge dùng một lần;
- startup giữ credential khi gặp lỗi kỹ thuật; đổi key là giao dịch staged, không còn trả
  `ok: true` sau validate thất bại; thao tác license được serialize;
- session key của chữ ký request được derive theo từng `sidecar generation`, nên chữ ký thế hệ
  cũ không sống lại sau respawn dù bảng nonce của tiến trình mới còn rỗng;
- signature v2 bind method, raw path/query, credential snapshot, content type, body mode và body
  commitment; JSON/string/binary, FormData và streaming có policy source/test tương ứng.

**Verdict:** §SEC.19 = **Partially mitigated / Verified in code and targeted tests — chưa
Closed**. Đây không phải tuyên bố “không thể crack”. Người có quyền admin/debugger/Ring-3
vẫn có thể patch process; production deployment và clean-installer runtime chưa được chứng
minh trong lượt này.

## 2. Bằng chứng, trust boundary và phương pháp

- Đã đọc `docs/audit/PRYNX_THREAT_MODEL.md`, `SECURITY_ARCHITECTURE.md`, các báo cáo
  chống crack/fixes liên quan, rồi trace entry → verifier → signer → token server.
- **Nguồn attacker trong phạm vi:** xóa/sửa file AppData, làm hỏng DPAPI blob, lùi/tiến đồng
  hồ, chặn mạng, phát lại token/challenge, gửi response kỹ thuật và race ở renderer.
- **Ngoài phạm vi:** private key thật, Supabase production, TPM/CNG attestation, thay đổi giờ
  hệ điều hành thật, installer sạch và hệ thống của bên thứ ba.
- Validation chỉ dùng keypair/challenge/fixture giả trong thư mục tạm. Probe cũ ở báo cáo
  trước (`after_key_delete=True`) là bằng chứng **trước bản vá**, không phải trạng thái hiện tại.

## 3. Ma trận finding sau re-audit

| Finding | Mức / confidence | Lifecycle hiện tại | Trạng thái bằng chứng |
|---|---|---|---|
| §SEC.19-A — reset clock state | P1 / 95% | Applied → Verified; residual | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-B — đường vòng anchor ở renderer/native | P1 / 93% | Applied → Verified; residual | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-C — signer không cưỡng chế clock | P1 / 95% | Applied → Verified; runtime gap | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-D — token thiếu `iat`/challenge phiên | P1 / 90% | Applied → Verified; deploy gap | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-E — production env redirect state | P2 / 94% | Applied → Verified; clean-runtime gap | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-F — anchor write/timestamp authority | P2 / 92% | Applied → Partially verified | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-G — startup xóa key khi lỗi tạm thời | P2 / 96% | Applied → Verified | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-H — đổi key tự mở khóa sau validate fail | P2 / 96% | Applied → Verified | `[VERIFIED-CODE][VERIFIED-TEST]` |
| §SEC.19-I — race key/token/native registration | P2 / 86% | Applied → Partially verified | `[VERIFIED-CODE]`, thiếu stress runtime |

### §SEC.19-A — P1/High — xóa/hỏng installation state làm reset neo

- **Bằng chứng hiện tại:** `backend/app/core/license_guard.py:457-494,519-559` phân biệt key
  `missing/corrupt/tampered/unavailable`, `:691-751` phân biệt record
  `missing/legacy/tampered`, và `:977-1049` chỉ bootstrap khi toàn bộ installation state
  chưa từng tồn tại. Sau bootstrap,
  thiếu marker/key/anchor hoặc chữ ký sai đều trả lỗi; không tự sinh lại key/neo.
  Native áp policy tương tự tại `desktop/src-tauri/src/security.rs:2131-2214,2347-2420`,
  chỉ khôi phục anchor thiếu/hỏng sau proof online v2 + challenge.
- **Source → sink:** attacker kiểm soát file AppData → state machine clock guard/anchor
  → quyền dùng token offline và signer.
- **Test/PoC an toàn:** `backend/tests/test_license_token.py` có ca first-install,
  missing key/anchor/marker, tamper, restart và V1 migration; Rust có các test
  `license_anchor_policy_tests`.
- **Tác động còn lại:** nếu attacker xóa **đồng thời toàn bộ** key + marker + record trước
  lần request đầu, backend không có bằng chứng ngoài để biết state từng tồn tại và có thể
  bootstrap lại. Native anchor + challenge là lớp chính giảm đường này; đây là residual.

### §SEC.19-B — P1/High — native/renderer có đường đi vòng anchor

- **Bằng chứng hiện tại:** `desktop/src/stores/useAuthStore.ts:193-255,1035-1195,1360-1450`
  chụp một `AnchorState` cho cả lượt validate; mọi nhánh network error, `RATE_LIMITED`,
  catch và offline đều gọi cùng `ensureOfflineAnchor()`. `desktop/src-tauri/src/security.rs:586-804`
  không cho đăng ký token v1 khi anchor thiếu/hỏng hoặc sau khi native cache bị
  clear mà chưa có challenge mới.
- **Control:** missing/corrupt/unavailable không còn bị diễn giải thành `0` hoặc offline
  grace; lỗi native/persistence khóa quyền nhưng giữ credential để recovery.
- **Test:** `useAuthStore.dielineKeyStatus.test.ts` kiểm anchor thiếu/hỏng/unavailable,
  `RATE_LIMITED`, catch path, response rỗng và lỗi native registration.
- **Residual/proof gap:** WebView bị patch hoặc process bị debug vẫn có thể bỏ qua renderer;
  native installed runtime current-source chưa chạy vì manifest chỉ được sinh trong clean release
  pipeline, không phải vì source implementation bị thiếu.

### §SEC.19-C — P1/High — signer native không cưỡng chế clock state

- **Bằng chứng hiện tại:** `desktop/src-tauri/src/security.rs:1732-1828` gọi
  `verify_clock_anchor_for_sign()` trước khi đọc cache/ký; hàm `:2347-2365` từ chối
  rollback, missing, corrupt và unavailable. Cache cũng từ chối `now < validated_at` và
  tuổi từ 8 giờ trở lên.
- **Source → sink:** timestamp hệ thống bị lùi → signer HMAC/native → sidecar API.
- **Test:** `request_signing_binding_tests` và `license_anchor_policy_tests` kiểm binding,
  rollback và issued-at trong dung sai. Snapshot Rust hiện hành 2026-09-04 được ghi ở §4.1;
  số 191 trước đây là snapshot lịch sử, không còn là tổng hiện hành.
- **Proof gap:** `binaries/payload-manifest.json` là artifact do release pipeline sinh nên chủ ý
  không có trong worktree. Rust overlay đã chứng minh source compile/test; config phát hành chỉ
  được chứng minh khi clean pipeline sinh manifest rồi build/cài artifact. Đây là artifact gap,
  không phải bằng chứng thiếu implementation hay làm mất kết quả 191 test.

### §SEC.19-D — P1/High — token protocol chưa có issued-at/challenge phiên

- **Bằng chứng hiện tại:** Edge `license-verify/index.ts:261-305,322-356` nhận protocol v2,
  ký `v/iat/challenge`; Python verifier `backend/app/core/license_guard.py:1057-1165` và
  Rust `security.rs:847-1045` kiểm version, lifetime, issued-at và challenge. Native giữ
  challenge trong RAM (`security.rs:490-639`), ràng với key + HWID và tiêu thụ một lần.
  `license-release/index.ts:1-120` chỉ dùng public key và kiểm shape/lifetime token.
- **Source → sink:** token bị bắt/challenge cũ → registration/anchor → quyền offline.
  Token v1 chỉ còn được dùng khi anchor hiện tại hợp lệ; khôi phục anchor bắt buộc v2.
- **Test:** backend v2 valid/malformed/mismatch + v1 compatibility; Rust v2 claims,
  challenge expiry/mismatch/replay; Edge ratchet `securityAuditAntiCrack2026_08_28` và
  `securityAuditRound2` đều pass.
- **Residual/proof gap:** challenge do native client sinh, chưa có TPM/attestation; Edge
  production chưa deploy/xác minh; token v1 vẫn là compatibility path khi anchor còn nguyên.

### §SEC.19-E — P2/Medium — production cho phép redirect đường dẫn state qua environment

- **Bằng chứng hiện tại:** `backend/app/core/license_guard.py:414-448,679-688` chỉ tôn trọng
  `PRYNX_CLK_KEY_FILE`/`PRYNX_CLOCK_GUARD_FILE` ở dev. `desktop/src-tauri/src/lib.rs:516-557`
  lọc các biến state, enforcement, token và dev trước khi spawn sidecar (`:803-827`).
- **Source → sink:** môi trường do parent/launcher kiểm soát → path/authority clock state.
- **Test:** backend kiểm path override production/dev; Rust test
  `moi_truong_sidecar_loai_state_nuitka_khong_phan_biet_hoa_thuong` kiểm lọc không phân
  biệt hoa thường.
- **Residual:** chưa chạy clean installer với môi trường độc lập; sidecar chạy ngoài Tauri
  vẫn phụ thuộc hardening `_is_dev_mode`/compiled flag và quyền OS.

### §SEC.19-F — P2/Medium — ghi anchor không nguyên tử và timestamp từ renderer

- **Bằng chứng hiện tại:** anchor authority dùng `epoch_millis()` native và
  `atomic_store_clock_anchor()` tại `security.rs:2495-2527`, flush rồi replace nguyên tử;
  `register_validated_key` không nhận timestamp từ renderer. Frontend chỉ gửi timestamp cho
  `store_last_online`, vốn đã được hạ xuống telemetry/heuristic phụ và không quyết định
  quyền native.
- **Control/test:** policy test kiểm target anchor chỉ tiến và reject thiếu proof; backend
  `_atomic_write_text` dùng temp + fsync + replace.
- **Residual:** `store_last_online(timestamp_ms)` vẫn nhận giá trị từ renderer và ghi theo
  đường cũ; nếu bị sửa chỉ gây sai telemetry/availability, không tạo được anchor hợp lệ.
  Chưa có fault-injection crash/race trên Windows thật.

### §SEC.19-G — P2/Medium — startup xóa key hợp lệ khi lỗi state tạm thời

- **Bằng chứng hiện tại:** `useAuthStore.ts:944-1018` chỉ gọi `setLicenseKey(null)` với
  outcome `server_rejected`/`device_limit`; anchor/DPAPI/network/native/persistence giữ key,
  khóa quyền và cho recovery.
- **Test:** `useAuthStore.dielineKeyStatus.test.ts` kiểm startup anchor unavailable và
  response `ERROR`; cả hai giữ key và không gọi `delete_license`.
- **Residual:** nếu server thật trả sai mã terminal thì vẫn cần monitoring phân loại;
  chưa có production telemetry replay.

### §SEC.19-H — P2/Medium — đường đổi key tự mở khóa sau validate thất bại

- **Bằng chứng hiện tại:** `useAuthStore.ts:1446-1719` staged key change: lấy challenge,
  yêu cầu token v2, native verify trước, ghi key/token bền vững rồi mới commit UI; mọi lỗi
  rollback binding cũ và trả `ok:false`. `serializeLicenseOperation` (`:654-662`) ngăn
  heartbeat/đổi key chạy chồng.
- **Test:** nhóm `SEC.19 — giao dịch đổi license key` kiểm server reject, VALID thiếu token
  và lỗi lưu token khôi phục binding cũ.
- **Residual:** nếu cả binding mới lẫn rollback cũ đều hỏng, UI bị khóa để recovery online;
  chưa có test fault-injection mất điện giữa hai lần replace.

### §SEC.19-I — P2/Medium — race giữa token/key state và đăng ký native

- **Bằng chứng hiện tại:** `validateLicense`, `changeLicenseKey` và retry đều đi qua cùng
  `serializeLicenseOperation`; `ensureKeyRegisteredInRust` nhận cặp key/token tường minh
  tại call-site. `desktop/src/lib/api.ts:62-184` cũng chụp key/token cùng lượt; re-register
  không truyền challenge là có chủ đích cho offline khi anchor còn hợp lệ.
- **Test/proof:** nhóm unit staged-change và API snapshot/pending guard trong
  `api.auth.test.ts` đã pass, typecheck frontend pass; chưa có stress test nhiều heartbeat
  + đổi key đồng thời hoặc runtime scheduler trên installer.
- **Lifecycle:** Applied → Partially verified; giữ P2 cho đến khi có concurrency/fault test.

## 4. Kiểm thử đã chạy

### 4.0. Snapshot lịch sử 2026-09-03

| Tầng | Lệnh / phạm vi | Kết quả |
|---|---|---|
| Backend | `backend\\venv\\Scripts\\python.exe -B -m pytest -q -p no:cacheprovider tests/test_license_token.py tests/test_free_token_e2e.py` | **89 passed**, 2 warning đã có sẵn |
| Frontend PrynX | `npx vitest run src/stores/licenseToken.test.ts src/stores/useAuthStore.dielineKeyStatus.test.ts src/lib/api.auth.test.ts` | **64 passed** |
| TypeScript PrynX | `npm run typecheck` trong `desktop` | **pass** |
| Edge/static ratchet | `npx vitest run src/securityAuditAntiCrack2026_08_28.test.ts src/securityAuditRound2.test.ts` trong `printsolutions-main` | **34 passed** |
| TypeScript `printsolutions-main` | `npm run typecheck` | **blocked bởi 22 lỗi TS7030 ở component/hook cũ**, không nằm trong hai Edge function sửa lượt này |
| Rust (overlay test an toàn) | PowerShell: `$env:TAURI_CONFIG='{"bundle":{"resources":[]}}'; cargo check --lib` và `cargo test --lib` | **check pass; 191 passed, 5 ignored**; overlay chỉ bỏ release-generated resource khỏi source test, không sửa config release |
| Rust với config phát hành | `cargo test --lib` theo `tauri.conf.json` hiện hành | Không chạy độc lập: `binaries/payload-manifest.json` là release-generated artifact; không tạo file giả. Kết quả này không hạ source overlay 191 pass |

Mức bằng chứng đạt: **Mức 1–2** (static + automated targeted tests). Chưa đạt Mức 3 cho
native installed runtime/clean user.

### 4.1. Snapshot current-source 2026-09-04

| Tầng/phạm vi | Kết quả hiện hành |
|---|---|
| Backend token/body/route/probe | **144/144** |
| Frontend auth/license | **89/89**; `npm run typecheck` đạt |
| Edge ratchet | **36/36** |
| Rust Tauri | **227 passed, 5 ignored**; `cargo check --release --lib` và `cargo fmt -- --check` đạt với overlay resource rỗng |
| Save As registry | **23/23** trong nhóm test Rust mục tiêu |
| Release scripts | **112/112 = 110 passed trong sandbox + 2 ca ACL/file-lock passed ngoài sandbox Windows**; AST/bare-executable scan 7 script đạt |
| Route policy ratchet | **191/191 route đã đăng ký**; đây là coverage inventory, không phải test count |

Snapshot này chứng minh control source/test, không nâng artifact/runtime/deploy lên `Verified`.

## 5. Coverage, proof gap và residual risk

- Chưa đọc/xác minh Supabase production state, secret `LICENSE_SIGNING_KEY`, deployment
  version của hai Edge function, TPM/CNG attestation, ACL thực tế trên máy khách hoặc
  installer sạch có `payload-manifest.json`.
- Compiled sidecar nếu bị tách khỏi Tauri vẫn có thể được khởi chạy với
  `PRYNX_TOKEN_SOURCE=stdin` hoặc `PRYNX_TOKEN_FILE`; chưa có parent-attestation/OS-bound
  channel chứng minh tiến trình cha là PrynX. Vì vậy người có quyền chạy binary và lấy được
  credential/token hợp lệ vẫn có thể dựng listener riêng — đây là proof gap/accepted Ring-3
  residual, không được gọi là đã chặn tuyệt đối.
- Native/backend clock state vẫn là client-local. Admin/debugger/Ring-3 có thể sửa memory,
  hook PowerShell/DPAPI, thay binary hoặc giả response; mục tiêu của lô này là loại reset/
  replay rẻ và buộc proof nhiều lớp, không phải DRM tuyệt đối.
- Cache installation key hiện dùng fingerprint kích thước/mtime/inode; thay đổi ACL/I/O sau
  khi key đã cache trong cùng process có thể bị che khuất (chủ yếu là availability). Cần
  fault-injection/ACL test trên Windows thật trước khi nâng verdict.
- Nonce vẫn là state theo process, nhưng session key nay được derive theo từng `sidecar generation`.
  Chữ ký của thế hệ cũ không xác thực ở tiến trình mới dù `_seen_nonces` mới đang rỗng; khe replay
  hẹp `§ATK.09` đã **Applied → Verified ở source/test**. Packaged respawn/fault-injection vẫn
  `[EXTERNAL]`, nên kết luận này không phải Runtime Verified.
- Signature v2 nay bind method, raw path/query, credential snapshot, content type, body mode và
  body commitment. Raw bytes được bind cho JSON/string/binary; FormData giữ order/duplicate/file
  metadata; streaming kiểm commitment tại EOF trước parse/submit. Ratchet phủ **191/191 route đã
  đăng ký** (coverage, không phải 191 test). §SEC.21 còn packaged-runtime proof, không còn là code
  gap về body digest/canonicalization.
- Xóa đồng thời toàn bộ backend clock state trước bootstrap vẫn là residual đã nêu ở A;
  native anchor + one-time challenge là lớp bù chính. `store_last_online` không được xem là
  authority.
- Token TTL 72 giờ là cửa sổ thu hồi xấu nhất khi máy offline. Cận verifier vẫn giữ 8 ngày
  trong giai đoạn chuyển tiếp để không làm hết hạn oan token cũ; cần kế hoạch hạ cận sau khi
  toàn bộ token 7 ngày cũ đã hết hạn.
- Pipeline đã có code sinh `binaries/payload-manifest.json`, live-rescan/hash trước Tauri,
  allowlist bảo vệ recursive cleanup và exact-set sau cài trước khi chạy Tesseract. Root cùng mọi
  path component cũng bị kiểm reparse. File không nằm sẵn trong worktree là đúng thiết kế; chưa
  clean-build/cài nên vẫn chưa kết luận provenance hoặc runtime signer trên artifact phát hành.

## 6. Việc còn lại để đóng §SEC.19

1. Chạy clean release pipeline để sinh manifest thật (không tạo tay), rồi chạy installed clean-user
   smoke với fault injection (xóa/hỏng từng file, rollback/forward clock, restart).
2. Deploy và xác minh `license-verify` v2 + `LICENSE_PUBLIC_KEY` của `license-release` trên
   Supabase staging/production; kiểm compatibility cutoff v1 theo kế hoạch rollout.
3. Bổ sung concurrency/fault tests cho đổi key và kiểm anchor sau crash/power loss; thêm
   parent-attestation hoặc IPC channel gắn OS nếu muốn loại residual sidecar chạy trực tiếp.
4. Chạy packaged-runtime negative smoke cho generation respawn và signature v2: chữ ký cũ/body
   đổi phải bị từ chối; phủ JSON/string/binary, FormData order/duplicate/file metadata, streaming
   EOF và retry. Không dùng coverage 191/191 để thay cho proof artifact này.
5. Nếu yêu cầu chống attacker có admin/debugger, thiết kế riêng TPM/CNG attestation và server
   checkpoint; không tuyên bố client-only “không thể crack”.

**Kết luận cuối:** các finding A–H đã có bản vá và bằng chứng code/test mục tiêu; I còn thiếu
stress runtime. Khe replay theo sidecar generation (`§ATK.09`) và request-body binding (`§SEC.21`)
không còn là mục source chưa triển khai, nhưng vẫn thiếu packaged-runtime proof. §SEC.19 được ghi
nhận **Partially mitigated / Verified in code and targeted tests**, chưa chuyển `Closed` cho tới
khi clock fault-injection, clean installer, deploy/secret state và các proof gap trên được giải quyết.
