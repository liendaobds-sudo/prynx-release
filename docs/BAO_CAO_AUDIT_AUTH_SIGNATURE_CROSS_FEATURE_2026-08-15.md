# BÁO CÁO AUDIT HMAC AUTH XUYÊN TÍNH NĂNG

**Ngày audit:** 2026-08-15  
**Repo:** `D:\pdfcompare`  
**Revision nền hiện tại:** `605c74f574c069f9719a695806da85bee9ffa414`  
**Trạng thái mã sửa:** `api.ts` đã nằm trong revision nền; patch Rust, test và tài liệu đang ở working tree, chưa stage/commit  
**Branch:** `codex/pre-release-audit-2026-08-04`  
**Chế độ:** audit dọc + security review + sửa theo phê duyệt của user; không build release, không stage/commit  
**Phạm vi:** lỗi `403 Invalid request signature` xuất hiện sau khi token license được làm mới; xác định blast radius sang các tính năng khác và phần còn hở sau bản vá.

## 1. Kết luận điều hành

Lỗi trong ảnh **không phải lỗi riêng của Upscale**. Trước bản vá, nó có thể xảy ra với mọi HTTP API đi qua cùng lớp ký HMAC của sidecar. Upscale chỉ là nơi có bằng chứng khách hàng báo cáo.

Root cause đã được xác nhận ở mức mã nguồn và reproducer: frontend công bố token mới trước khi cache binding trong Rust được cập nhật. Rust vẫn ký theo hash token cũ, còn backend hash token mới trong header, nên trả đúng `403 Invalid request signature`.

Bản vá hiện tại đã chặn request sai trước khi gửi mạng:

- frontend chụp cùng một `licenseKey + licenseToken`, truyền token vào cả hai lần `sign_api_request` và tự đăng ký lại khi native cache lệch (`desktop/src/lib/api.ts:62-125`);
- Rust đối chiếu hash token request với binding đã native-verify trước khi giải mã secret/ký (`desktop/src-tauri/src/security.rs:253-267, 978-1004`);
- test hồi quy mô phỏng chuỗi `sign → register → sign → một HTTP request` đã đạt.

Vì cơ chế nằm ở lớp dùng chung, bản vá bao phủ Upload, Compare/QC, Export, PDF Tools, Preflight/Edit/Viewer, Imposition/N-up, VDP, Sticker/Dieline validation, Logo Rebuild, Background Removal và Upscale.

**Giới hạn còn mở:** source hiện đã có supervisor respawn sidecar với cùng secret/storage/env và startup proof (`desktop/src-tauri/src/lib.rs:595-763, 5400-5469`), nhưng chưa fault-inject trên installer thật. Vì vậy chưa nâng finding lifecycle lên mức `RUNTIME`.

## 2. Phạm vi và bằng chứng

### Đã rà

- Frontend auth entry: `desktop/src/lib/api.ts`, `desktop/src/main.tsx`, `desktop/src/stores/useAuthStore.ts`.
- Native signer/cache và Tauri command registry: `desktop/src-tauri/src/security.rs`, `desktop/src-tauri/src/lib.rs`.
- Backend verifier/dependency: `backend/app/core/license_guard.py`, các route dùng `require_license`/`require_feature`, và `backend/app/api/routes/ws.py`.
- Consumer production của `authenticatedFetch` và các `fetch` trực tiếp tới origin `127.0.0.1:8321`/`localhost:8321`.
- Báo cáo trước liên quan Upscale/sidecar và threat model.

### Ngoài phạm vi

- Tính đúng đắn nghiệp vụ của từng công cụ PDF không liên quan đến auth.
- Supabase/Edge Function production, secret thật của khách hàng, installer đã cài và mạng máy khách.
- WebSocket runtime thực tế; source có verifier WebSocket nhưng không tìm thấy consumer `new WebSocket` trong `desktop/src` production.

Worktree đang có nhiều thay đổi WIP của các lượt khác. Audit chỉ quy kết các file/đường chạy nêu trên; không dùng diff không liên quan làm bằng chứng.

## 3. Trace dọc

| Mắt xích | Bằng chứng | Kết luận |
|---|---|---|
| Auth state → request | `useAuthStore.ts:627-640`; token mới được `set` trước `ensureKeyRegisteredInRust` | Có cửa sổ lệch token/header và Rust cache |
| Frontend signer | `api.ts:62-125` | Mọi request dùng helper đều đi qua cùng recovery; interceptor global cài tại `main.tsx:59-61` phủ cả fetch trực tiếp tới sidecar |
| Native cache | `security.rs:247-272, 281-302` | Binding lưu hash token + HWID + thời điểm, theo license key |
| Native signing | `security.rs:978-1040` | Hiện từ chối token không khớp trước khi tạo nonce/HMAC |
| Backend HMAC | `license_guard.py:204-267` | Hash token trong header và payload HMAC; mismatch trả literal `Invalid request signature` ở dòng 260 |
| HTTP route gate | `license_guard.py:517-548` | `require_feature` gọi lại `require_license`; các route feature bị cùng guard |
| WebSocket | `ws.py:17-66` | Dùng cùng verifier nhưng không có frontend consumer hiện hành |
| Sidecar lifecycle | `lib.rs:595-763, 5400-5469` | Runtime termination/error được probe; mỗi thế hệ có cờ thoát riêng; chỉ respawn khi port rảnh và thế hệ mới vượt startup proof |

## 4. Findings

| ID | Mức | Trạng thái | Finding | Blast radius | Effort |
|---|---|---|---|---|---|
| §SIG.01 | P1 | `[CONFIRMED → PATCH APPLIED, AUTO]` | Token mới được publish trước cache Rust, tạo HMAC với token cũ và header token mới | Mọi HTTP API có license guard; Upscale là consumer được báo cáo | S |
| §SIG.02 | P1 | `[PATCH APPLIED, AUTO; RUNTIME GAP]` | Sidecar chết/thay thế sau startup nay có supervisor/respawn có giới hạn; `Terminated/Error` được probe lại bằng startup proof | Mọi API sidecar; runtime kill thật và installed smoke còn mở | M/L |
| §SIG.03 | P2 | `[MITIGATED BY EXISTING GATES; ARTIFACT GAP]` | Build release đã bắt clean commit, giữ source revision, hash sidecar/frontend và manifest; test IPC mới khóa args signer | Chưa có installer mới chứng minh bundle hai đầu cùng revision | S/M |

Không đưa WebSocket thành finding: guard có thật nhưng chưa có consumer production, nên đây là **coverage note**, không phải lỗi đang reachable từ UI hiện tại.

### §SIG.01 — Chi tiết và trạng thái sau bản vá

**Bằng chứng trước bản vá:**

1. `useAuthStore.ts:632-640` đặt `licenseToken=freshToken`, chờ DPAPI, rồi mới gọi `ensureKeyRegisteredInRust`.
2. `api.ts` cũ gọi Rust signer không truyền token hiện tại; Rust vẫn lấy `license_token_hash` trong binding cũ.
3. `license_guard.py:247-260` hash token header mới và so HMAC, trả đúng literal trong ảnh.

**Bằng chứng mitigation hiện tại:**

- `api.ts:68-73` chụp một snapshot key/token.
- `api.ts:102-106` và `:119-123` truyền `licenseToken` vào cả lần ký đầu và retry.
- `security.rs:998-1001` từ chối mismatch trước `decrypt_sidecar_token()` và trước khi sinh chữ ký.
- `desktop/src/lib/api.auth.test.ts` kiểm tra cache stale → re-register → ký lại → đúng một request.

Trạng thái chỉ là `AUTO`, chưa nâng `RUNTIME`: chưa chạy release installer với license thật của khách hàng.

### §SIG.02 — Sidecar runtime tự phục hồi có kiểm soát (đã áp dụng bản vá)

Startup hiện đã có biện pháp đúng hướng: kill process cùng tên, chờ port 8321 rảnh, fail-closed nếu port vẫn bận, truyền secret qua stdin và chạy startup proof. Bản vá lô A bổ sung:

- PID atomic thay cho `OnceLock`, cập nhật theo từng thế hệ;
- cờ thoát tách riêng theo thế hệ để event reader cũ đóng muộn không đánh dấu nhầm sidecar mới đã chết;
- supervisor probe listener bằng startup HMAC proof trước khi spawn;
- spawn lại với cùng storage/env/secret, ghi token stdin và yêu cầu proof lần nữa;
- không kill listener lạ; dừng sau ba lần thất bại để tránh vòng spawn vô hạn.

Đây là finding đã được báo trước trong `BAO_CAO_AUDIT_UPSCALE_ON_DINH_SIDECAR_2026-08-11.md` (§US.02). Test policy và `cargo test --release` đã đạt; vẫn còn proof gap runtime kill sidecar trên bản cài.

### §SIG.03 — Bundle phải phát hành nguyên cặp (đã có gate, chưa có artifact mới)

`sign_api_request` hiện nhận thêm `license_token` ở Rust và frontend. Tauri registry vẫn expose cùng command tại `lib.rs:4965`. `invoke()` không có schema TypeScript, nhưng test `api.auth.test.ts` đã khóa cả hai lần gọi và build release hiện bắt clean commit, source revision, frontend hash, sidecar hash và manifest. Chưa chạy build/QA installer theo yêu cầu release, nên không dùng artifact RC5 để kết luận source hiện tại.

## 5. Phân loại blast radius

### Có cùng rủi ro HMAC (trước bản vá; hiện đã được mitigation chung)

- Upload/Export/Compare/QC.
- PDF Tools: merge, split, resize, trim, OCR, optimize, office conversion.
- Preflight, Edit, Viewer/layer và download result.
- Imposition/N-up, VDP, sticker sheet/dieline validation.
- Logo Rebuild, Background Removal, Upscale.

Các consumer gọi `authenticatedFetch` trực tiếp hoặc gọi `fetch` tới sidecar; interceptor được cài trước khi render tại `main.tsx:61`.

### Không thuộc lỗi HMAC này

- Dieline/3D chạy client-only.
- Đọc file cục bộ, blob/object URL và xử lý native không gọi sidecar.
- Health/network probe và Supabase/license RPC, vì dùng endpoint/credential khác.
- Upscale file-grant HMAC riêng; grant sai thường trả lỗi grant/path, không phải literal `Invalid request signature` của license guard.

## 6. Kiểm thử đã có

Các kiểm thử liên quan đã chạy lại trên Windows trong cùng worktree hiện tại:

- Frontend auth/upload/Upscale: `17 passed`.
- Backend license + Upscale: `91 passed`.
- Rust token-binding regression release: `2 passed`; sidecar supervisor policy/race: `7 passed` ở debug và `7 passed` ở release.
- TypeScript typecheck, targeted ESLint, `cargo check --release`: đạt.
- Audit contract scanner self-test: `17/17` ca đạt.

`cargo fmt --check` toàn workspace còn báo các khác biệt format có sẵn ở `print.rs`/`print_worker.rs`, ngoài phạm vi finding này; `rustfmt --check` riêng `security.rs` đạt.

## 7. Proof gap và đề xuất lô tiếp theo

Chưa có bằng chứng cho:

1. Runtime release/installed với token và sidecar thật của khách hàng.
2. Fault injection kill sidecar sau startup rồi xác nhận app tự phục hồi trên bản cài.
3. Provenance một installer mới chứng minh frontend, Tauri host và sidecar cùng revision.
4. Log khách hàng để phân biệt token-hash mismatch với secret/zombie-sidecar mismatch.

User đã duyệt sửa trong cuộc trao đổi hiện tại:

- **Lô A đã áp dụng:** token-binding tự phục hồi và supervisor/restart sidecar có startup proof, backoff và giới hạn số lần thử.
- **Lô B chưa chạy:** build/provenance/installed smoke là một audit unit phát hành riêng; chỉ thực hiện khi user duyệt build installer.
- Không retry mù các POST nghiệp vụ; nếu cần recovery HTTP phải chỉ áp dụng sau auth guard và có chứng minh không tạo duplicate job/file.

**Kết luận audit:** `§SIG.01` và phần code của `§SIG.02` đã đạt bằng chứng tự động; `§SIG.03` có gate source/build nhưng chưa có artifact mới; runtime sidecar kill trên bản cài và installed smoke vẫn là proof gap trước khi đóng audit hoàn toàn.
