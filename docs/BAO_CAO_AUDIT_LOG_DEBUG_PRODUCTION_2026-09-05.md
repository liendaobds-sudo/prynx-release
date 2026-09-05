# BÁO CÁO AUDIT LOG/DEBUG TRÊN BẢN PRODUCTION — 2026-09-05

> Phạm vi: PrynX desktop, Tauri host, FastAPI sidecar và luồng Bình tem bế/CNC.
> Mục tiêu: không để bản cài khách hàng tự bật hoặc xuất log kỹ thuật có thể làm lộ
> đường dẫn tài liệu, cấu trúc engine, tọa độ bình, mask/ảnh trung gian hay posture bảo mật.
>
> Trạng thái chốt 1: **đã có bằng chứng source**. Người dùng đã duyệt trước việc khóa
> log còn sót trong yêu cầu ngày 2026-09-05; triển khai theo các lô tối đa 5 file và
> verify riêng từng lô trước khi commit.

## 1. Threat model và nguyên tắc phân loại

- Đối thủ có toàn quyền trên máy khách và có thể đặt biến môi trường trước khi chạy app.
- Ẩn nút UI không phải authority: Tauri command/backend route phải tự từ chối ở release.
- Log lỗi vận hành tối thiểu, không chứa dữ liệu khách hàng hoặc chi tiết engine, được giữ.
- Trace hiệu năng/hình học, stack kỹ thuật, ảnh/mask trung gian và full path chỉ được phép
  trong runtime phát triển chưa đóng gói; cờ môi trường không được mở lại trên binary release.
- Đây là hardening chống trinh sát/crack rẻ. Nó không biến Ring-3 thành “không thể crack”.

## 2. Finding có bằng chứng

| ID | Mức | Trạng thái | Bằng chứng | Rủi ro |
|---|---:|---|---|---|
| LOG.01 | Cao | Confirmed | `desktop/src-tauri/src/lib.rs`: `preview_perf_enabled()` tin trực tiếp `PRYNX_PERF`; command `preview_perf_logging_enabled`/`append_render_perf` và đường ghi `PrynX_RenderPerf.log` trên Desktop vẫn tồn tại ở release; cờ còn được truyền sang sidecar. | Người dùng máy khách có thể bật trace Viewer/Bình tem và thu thập timeline, capacity, kích thước, ID/hash nội bộ. |
| LOG.02 | Cao | Confirmed | `backend/app/api/routes/imposition.py`: `/imposition/perf-beacon` ghi `[DIM-DIE-TRACE]` bằng `logger.warning` kể cả khi perf flag tắt; cùng file có `[PARITY-DBG PREVIEW]` warning chứa file/path và danh sách `abs_y`. | Renderer hoặc caller cục bộ có thể làm dữ liệu chẩn đoán lọt vào `app.log`/`PrynX.log`; path tài liệu và hình học khách hàng bị lộ. |
| LOG.03 | Cao | Confirmed | `backend/app/workers/rot_audit_log.py`, `nesting_debug_trace.py`, `edit_debug_log.py` và `sticker_engine.py` nhận các cờ runtime như `PRYNX_ROT_AUDIT`, `PRYNX_NESTING_TRACE_ENABLED`, `PRYNX_EDIT_*`, `STICKER_DEBUG` mà chưa chặn compiled runtime. `STICKER_DEBUG` còn ghi ảnh mask/bleed vào `debug_output`. | Chỉ cần đặt env để bật log/ảnh chi tiết trên bản cài; có thể lộ nội dung hoặc đặc trưng tài liệu và thuật toán. |
| LOG.04 | Cao | Confirmed | `desktop/src-tauri/src/lib.rs` chuyển nguyên stdout/stderr sidecar thành log Tauri. Python logging mặc định ra stderr; backend INFO vì vậy bị mirror thành WARN trong file release. | Traceback, path và log engine từ sidecar được sao chép nguyên văn sang log desktop dù backend không chủ ý xuất cho người dùng. |
| LOG.05 | Trung bình | Confirmed | `desktop/src/lib/uiErrorDiagnostics.ts` tạo báo cáo clipboard gồm raw error message, `navigator.userAgent` và raw stack. `desktop/src/ErrorBoundary.tsx` và `StickerToolErrorBoundary.tsx` luôn cho sao chép ở production. | Người dùng/đối tượng hỗ trợ nhận tên hàm, chunk, component/engine, URL/path hoặc dữ liệu bị nhúng trong exception. |
| LOG.06 | Trung bình | Confirmed | Nhiều marker chẩn đoán dùng INFO/WARNING thay vì DEBUG: `[DIM-DIE-TRACE]`, `[IMPOSITION-DIAG]`, `[DIAG-EXPORT]`, `[SOLVER DEBUG]`, `ZONE-DEBUG`, `>>> DEBUG`. | Chúng đi qua handler INFO/WARN ở release, vừa tăng I/O vừa tạo bản đồ hành vi engine. |
| LOG.07 | Thấp | Confirmed | `console.log`/`console.debug` còn ở một số source frontend production (`usePdfLoader.ts`, `processHandlers.ts`, `api.ts`, updater). | DevTools/console có thêm tín hiệu trinh sát; một số dòng có timing/kích thước hoặc lỗi ký request. |

## 3. Control đã có và không phải finding

- `security.log` mặc định tắt và đã có opt-in riêng; nội dung hiện được giới hạn, nhưng
  vẫn phải xem đây là diagnostic vận hành chứ không phải bằng chứng chống crack tuyệt đối.
- `nesting_debug_trace.py` đã whitelist field, băm identity và không ghi raw contour/path.
  Finding nằm ở authority bật trace trên release, không phải ở serializer hiện tại.
- `logger.debug` thông thường không đi vào handler INFO mặc định; không cần xóa các dòng
  fail-soft hữu ích nếu payload không nhạy cảm.
- Log trong test, benchmark và script phát triển không được bundle không phải bề mặt runtime,
  nhưng artifact của chúng không được stage/commit vào source phát hành.

## 4. Kế hoạch vá theo lô

### Lô A — authority release ở Tauri (tối đa 2 file)

1. `desktop/src-tauri/src/lib.rs`: khóa perf logging bằng `cfg!(debug_assertions)`, không
   truyền cờ diagnostic từ ambient env vào sidecar release, command append thành no-op ở release,
   và không mirror raw stdout/stderr sidecar vào log release.
2. Test Rust trong cùng module chốt policy release/dev và danh sách env bị loại.

### Lô B — authority backend cho diagnostic (tối đa 5 file)

1. Thêm helper runtime nhẹ, fail-closed khi Nuitka/PyInstaller.
2. Áp helper cho nesting trace, rotation audit, edit debug log và sticker debug image.
3. Test: compiled runtime không thể bật bằng env; dev vẫn cần opt-in đúng quy tắc.

### Lô C — luồng Bình tem bế (tối đa 5 file)

1. Route perf beacon chỉ ghi khi diagnostic dev được backend cho phép.
2. Hạ/xóa marker preview/export/DIM-DIE/solver còn dùng WARNING/INFO.
3. Không ghi full path, raw placement arrays, contour/mask hoặc payload report.
4. Test route/helper xác nhận release không phát sinh log dù caller gửi marker giả.

### Lô D — báo cáo lỗi UI (tối đa 4 file)

1. Production report chỉ cho phép version, error ID và area; không stack, user-agent,
   URL/path, token hoặc message thô.
2. Dev report vẫn có chi tiết đã redact để hỗ trợ tái hiện.
3. Sentry production chỉ nhận exception đã làm sạch/nhóm lỗi, không gửi raw exception.
4. Test sentinel cho path, URL, tên engine và token.

### Lô E — console và regression guard

1. Gỡ hoặc gate các `console.log/debug/trace` production còn lại.
2. Thêm guard quét marker/cờ diagnostic nguy hiểm trên đường runtime release.
3. Không áp vào test/benchmark/script phát triển không bundle.

## 5. Chốt hoàn thành

Chỉ đóng audit khi:

- unit test backend cho diagnostic policy xanh;
- test frontend báo cáo chẩn đoán và các test auth/imposition liên quan xanh;
- Rust test + `cargo fmt -- --check` + release lib check xanh;
- typecheck/frontend build xanh;
- quét lại không còn marker production-reachable đã liệt kê;
- secret scan không in giá trị và Git staging chỉ gồm source/test/docs hợp lệ;
- push đúng upstream hiện tại sau `git fetch` và kiểm tra ahead/behind.

Các bước clean installer/VM vẫn là kiểm chứng ngoài workspace và không được suy diễn từ test source.

## 6. Kết quả re-audit và bằng chứng chốt — 2026-09-05

Sau khi áp dụng các lô A–E, các finding trong bảng trên được phân loại lại như sau:

| Finding | Kết quả | Bằng chứng sau vá |
|---|---|---|
| LOG.01–LOG.04 | **Closed — [VERIFIED]** | Tauri chỉ bật diagnostic ở debug build; release không nhận cờ môi trường, không ghi/mirror stdout-stderr sidecar và backend helper fail-closed khi đã đóng gói. Rust `cargo test --lib`: 235 passed, 5 ignored; `cargo fmt -- --check`: đạt. Bộ test backend diagnostic và route liên quan đạt. |
| LOG.05–LOG.06 | **Closed — [VERIFIED]** | Báo cáo lỗi production chỉ còn mã lỗi/khu vực đã làm sạch; marker trace không còn đường ghi INFO/WARNING trên runtime release. Vitest desktop và test sentinel báo cáo lỗi đạt. |
| LOG.07 | **Closed cho mã PrynX — [VERIFIED]** | Bundle desktop production không còn marker/cờ diagnostic của PrynX. Các log còn trong test/benchmark/dev không được bundle. |
| LOG.WEB.01 | **Closed — [VERIFIED]** | `supabase/functions/send-license-email/index.ts` không trả raw payload Resend hoặc raw exception; mọi nhánh lỗi trả thông báo ổn định. |
| LOG.WEB.02 | **Closed — [VERIFIED]** | `src/engine/barcode/barcodeWorker.ts` và `qrWorker.ts` không còn ghi nội dung tem/QR hoặc stack ra console; test bảo vệ đã bổ sung. |

### Verify website sau vá

- `npx vitest run`: **503 passed, 1 skipped** (56 test files).
- `npx vitest run src/securityAuditRound2.test.ts`: **13/13 passed**.
- `npm run build`: **đạt**.
- Quét `dist/assets`: không còn marker của mã ứng dụng PrynX (`Barcode Worker Render Error`,
  `QR Worker Render Error`, `PrynX_RenderPerf`, trace marker hoặc raw lỗi đã nêu). Bốn chunk
  thư viện bên thứ ba (`html2canvas`, `vendor-pdf`, `vendor-supabase`, `vendor-three`) vẫn
  chứa tham chiếu logger/debugger nội bộ; đây là **[EXTERNAL]/residual**, không nhận dữ liệu
  license, đơn hàng hay hình học của PrynX và không được sửa trực tiếp trong `node_modules`.

### Verify desktop/backend

- Desktop Vitest: **3332 passed, 2 skipped**; typecheck và production build: **đạt**.
- Backend: toàn bộ **5062** test đã được chạy theo các đoạn liên tiếp; các đoạn cuối **388
  passed**, không còn failure chức năng. Chỉ còn cảnh báo deprecation Pydantic/Starlette.
- Rust/Tauri: **235 passed, 5 ignored, 0 failed**; `cargo fmt -- --check`: **đạt**.
- `git diff --check` cho hai repo: **đạt** (cảnh báo LF→CRLF của Git không phải whitespace
  error).

### Proof gap còn mở

Các mục sau vẫn là **[EXTERNAL]**, không thể kết luận từ workspace: clean install/VM thật,
Authenticode và updater signature, OAuth/Credential Manager/GitHub thật, production secrets và
Edge/RPC deployment, TPM/CNG runtime trên phần cứng thật, NAS/non-NTFS và admin/debugger/Ring-3.
Đây là residual risk đã chấp nhận trong threat model; việc khóa log chỉ giảm trinh sát/crack rẻ,
không phải cam kết client “không thể crack”.
