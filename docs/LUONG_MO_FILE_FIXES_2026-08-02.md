# NHẬT KÝ SỬA LUỒNG MỞ FILE — 2026-08-02

Tài liệu tiến độ cho `BAO_CAO_AUDIT_LUONG_MO_FILE_2026-08-02.md`. Mỗi lô tối đa năm file và phải verify trước khi chuyển lô.

**Trạng thái closeout:** Lô 1–7 đã triển khai theo sub-lô tối đa năm file. Manifest, `merge_files` và `interleave` đã migrate sang cùng lifecycle job ở backend/API/UI; runtime HTTP/backend mới đã đạt. Chưa nghiệm thu thao tác UI Tauri, ma trận Google/USB/UNC/NAS/folder/đủ 19 đuôi hoặc clean-checkout/release gate.

## Lô 1 — Loading first tile

Trạng thái: đã triển khai, test tự động đạt và người dùng xác nhận file gốc mở thành công trên app Tauri.

- Scheduler không nhả slot native sớm khi task nền thật chưa kết thúc.
- HMR dùng quarantine thay vì đặt lại bộ đếm rồi mở render song song.
- First tile có terminal state, cảnh báo chậm, Thử lại/Hủy và không nuốt lỗi decode.
- Màn chờ chuyển ảnh sang PDF đã được thu gọn; không đổi contract xử lý ảnh.

## Lô 2 — DOC_CACHE/PDFium

Trạng thái: đã triển khai, kiểm thử tự động và runtime app Tauri đạt; đủ điều kiện chuyển Lô 3.

### File trong lô

1. `desktop/src-tauri/src/lib.rs`
2. `desktop/src-tauri/Cargo.toml`
3. `desktop/src/hooks/viewer/usePdfLoader.ts`
4. `desktop/src/hooks/viewer/usePdfLoader.test.tsx`
5. `docs/LUONG_MO_FILE_FIXES_2026-08-02.md`

### Đã sửa

- Thay `HashMap` cache tài liệu bằng LRU có lifecycle rõ.
- Cache chỉ giảm còn hai entry khi RAM dưới 8 GB và bốn entry khi RAM từ 8 đến dưới 16 GB; máy từ 16 GB không hard-cap. `PRYNX_DOC_CACHE_LIMIT` là escape hatch, giá trị `0` nghĩa là không cap.
- Đọc file và parse PDF diễn ra ngoài mutex cache; insert dùng double-check để request cạnh tranh không giữ khóa qua I/O.
- Metadata dùng `pages().page_size(i)`, không `pages().get(i)`, nên không load từng trang chỉ để lấy kích thước.
- Thêm command `close_pdf_document`; remove entry dưới mutex nhưng drop handle sau khi nhả mutex. Arc của render đang chạy giữ document sống tới terminal callback.
- Page được đóng trước document; thao tác drop PDFium giữ khóa LOAD → RENDER.
- Loader frontend đóng cache khi đổi nguồn native hoặc unmount tab.

### Verify

| Kiểm tra | Kết quả |
|---|---:|
| `cargo check --lib` | Pass |
| Rust `doc_cache_tests` | 3/3 pass |
| Vitest `usePdfLoader.test.tsx` | 6/6 pass |
| Viewer matrix scheduler/loader/zoom | 3 file, 23/23 pass |
| TypeScript `npm run typecheck` | Pass |
| `git diff --check` cho bốn file code | Pass |
| Runtime Tauri: open/render/rotation/close | Pass |

`cargo fmt --check` toàn crate vẫn thất bại do format/trailing-space có sẵn ở nhiều file ngoài phạm vi; không chạy auto-format để tránh diff hàng nghìn dòng. Các dòng mới đã được format hẹp.

Test PDFium `pdfium_page_size_already_includes_intrinsic_rotation` có sẵn không trả kết quả trong khoảng 90 giây và đã được dừng riêng. Ca tương đương đã được xác nhận trên app thật bằng fixture 400×200 có intrinsic rotation 90°.

### Runtime đạt

- Binary Tauri build sạch sau khi loại artifact incremental stale; app phản hồi bình thường.
- Open With fixture đi tới first tile terminal `ready`; native render 8 ms.
- Fixture MediaBox 400×200 + intrinsic rotation 90° hiển thị đúng thành trang dọc 200×400.
- Đóng tab ghi `DOC_CACHE_CLOSE removed=1`; Arc không bị cắt giữa render.
- Sau close, tab PDF còn lại tiếp tục cache-hit/render và tiến trình không crash.
- `cargo fmt --check` vẫn là nợ baseline; ESLint hook có finding cũ nhưng không có finding tại vùng lifecycle mới.

## Lô 3A–3B — NAS, Recent, picker và kéo-thả

Trạng thái: code/typecheck/test tự động đạt; binary Tauri mới đã build sạch và Open With trên ổ D đi tới first tile. Ma trận thao tác tay Home picker/DOM drop/Recent trên USB/UNC thật sẽ được lặp lại ở Lô 7.

### Chia lô

Lô 3A — hợp đồng native và Open With, bốn file code:

1. desktop/src-tauri/src/lib.rs
2. desktop/src/lib/nativeFileAccess.ts
3. desktop/src/components/SystemIntegrations.tsx
4. desktop/src/components/SystemIntegrations.test.tsx

Lô 3B — Home/Recent, ba file code/test:

1. desktop/src/components/HomeTab.tsx
2. desktop/src/lib/useRecentFiles.ts
3. desktop/src/components/SystemIntegrations.test.tsx

### Đã sửa

- Thêm stat_system_file bất đồng bộ; std::fs::metadata() chạy trong blocking pool, không giữ luồng IPC/UI.
- Contract trả mã ổn định available | missing | inaccessible; frontend thêm timeout. Không parse câu lỗi hệ điều hành.
- Chỉ kết luận missing khi file trả NotFound và thư mục cha vẫn truy cập được. USB chưa gắn, share NAS offline, permission hoặc I/O khác đều là inaccessible.
- Deadline 1,5 giây chỉ áp cho metadata tùy chọn; hết hạn vẫn tạo path-backed File với size=0, không hủy hay giảm công suất đọc/render file thật.
- Open With/startup/native drop khởi động probe nhiều path cùng lúc. Poll chỉ lên lịch lượt sau khi processPaths của lượt hiện tại đã dispatch xong.
- Home native picker, input web và DOM drop cùng phát system-files-received; không đi tắt onOpenApp, nên giữ đúng router nhiều PDF, Office batch, ảnh/Combine và tool ảnh đang active.
- Home ở tab nền không còn giữ listener/highlight native drag.
- Recent bỏ plugin-fs stat; available xóa cờ missing, missing xác nhận mới trả null, còn timeout/inaccessible trả { size: 0 } để caller vẫn thử mở và không xóa nhầm mục starred.

### Verify

| Kiểm tra | Kết quả |
|---|---:|
| Vitest SystemIntegrations.test.tsx | 11/11 pass |
| TypeScript npm run typecheck | Pass |
| ESLint System/helper/test/Recent | Pass |
| ESLint toàn HomeTab.tsx | Còn 5 any baseline ngoài vùng sửa; vùng Tauri vừa chạm đã bỏ 2 any |
| cargo check --lib | Pass |
| Rust system_file_stat_tests | 2/2 pass |
| git diff --check file tracked Lô 3 | Pass |
| Runtime Tauri clean rebuild | Pass sau cargo clean -p pdf-inspector loại 2,6 GiB artifact stale |
| Open With D:\...\test_rotate_90.pdf | Single-instance pass; first tile disk-cache hit, IPC 1 ms |

Không mở rộng capability filesystem thành $HOME/** hoặc toàn ổ đĩa. Promise metadata native có thể tiếp tục chạy nền sau deadline vì Windows không có cơ chế hủy std::fs::metadata; việc đó không còn giữ UI hoặc chặn dispatch.
## Lô 4A–4B — Combine/Interleave và menu Explorer

Trạng thái tại thời điểm Lô 4: code/typecheck/test tự động và runtime app Tauri đạt; `§COMB.1` đã đóng, còn phần progress/cancel/admission/zero-copy của `§COMB.2` được chuyển sang và đã xử lý ở Lô 6E–6F.

### Chia lô

Lô 4A — transport và vòng đời preview, năm file:

1. `desktop/src/lib/api.ts`
2. `desktop/src/lib/processHandlers.ts`
3. `desktop/src/components/CombineTab.tsx`
4. `desktop/src/lib/api.mergeManifest.test.ts`
5. `desktop/src/lib/combineTransport.integration.test.tsx`

Lô 4B — intent Combine từ Explorer, năm file:

1. `desktop/src-tauri/installer-hooks.nsh`
2. `desktop/src/lib/tabNavigation.ts`
3. `desktop/src/lib/tabNavigation.test.ts`
4. `desktop/src/App.tsx`
5. `desktop/src/components/SystemIntegrations.test.tsx`

### Đã sửa

- `backendMergePdfs` dùng cùng bước materialize file native như các API upload an toàn; path-stub 0 byte không còn đi thẳng vào multipart.
- Interleave xác định danh sách nguồn trước khi đọc/ước lượng; dùng đúng odd/even, không phụ thuộc working file và không gửi PNG/JPEG vào endpoint PDF-only.
- Bỏ `previewUrl` thừa khỏi node Combine. `ImageThumbnail` sở hữu và thu hồi URL của chính nó khi đổi file/unmount.
- Retry xem trước PDF có timer cleanup và kết thúc ở cảnh báo terminal có nút “Thử lại”.
- Installer gắn cờ `--prynx-action=combine`; planner điều hướng gom file vào đúng một tab Combine trước khi áp dụng hành vi Open With nhiều PDF.

### Verify

| Kiểm tra | Kết quả |
|---|---:|
| API transport + Combine/Interleave hẹp | 7/7 pass |
| Ma trận Combine/API/processHandlers | 45/45 pass |
| Routing/installer Lô 4B | 25/25 pass |
| TypeScript `npm run typecheck` | Pass |
| Runtime hai process Explorer → một tab Combine, hai thumbnail | Pass |
| Runtime “Ghép file” → tài liệu hai trang → first tile | Pass |
| Log native trang 1 / trang 2 | IPC 9 ms / 10 ms |

Ảnh bằng chứng runtime được giữ tại `C:\tmp\prynx_lot4_after_merge.png`; log đối chiếu tại `C:\Users\Khanh Pham\Desktop\PrynX_RenderPerf.log` có hai render terminal liên tiếp, không có lỗi hoặc vòng chờ vô hạn.

### Nợ Lô 4 đã chuyển và xử lý ở Lô 6

Tại thời điểm Lô 4, backend Combine chưa có progress/cancel, admission sau manifest expansion và zero-copy cho đường legacy. Lô 6E–6F đã xử lý các điểm này cho cả `manifest`, `merge_files` và `interleave`. Runtime lifecycle job mới vẫn là gate riêng, không được suy ra từ runtime Combine hai file của Lô 4.
## Lô 5A–5B — Office/Google process lifecycle và capability

Trạng thái: code/typecheck/test tự động và runtime app Tauri đạt. `§OFFICE.1`, `§OFFICE.2`, `§FORMAT.1` đã đóng. Streaming/bounded-memory của Office/Google chuyển sang Lô 6D.

### Chia sub-lô

Backend engine/runner và capability, tối đa năm file mỗi sub-lô:

1. `backend/app/workers/office_convert_engine.py`
2. `backend/app/core/office_job_runner.py`
3. `backend/app/schemas/pdf_tools.py`
4. `backend/tests/test_office_convert_engine.py`
5. `backend/tests/test_office_job_runner.py`

Router/lifecycle và contract, tiếp tục chia nhóm tối đa năm file:

1. `backend/app/api/routes/office_convert.py`
2. `backend/app/api/routes/pdf_tools.py`
3. `backend/app/main.py`
4. `backend/tests/test_office_convert_routes.py`
5. `backend/tests/test_api_contract.py`

Frontend capability/cancel/progress, năm file:

1. `desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`
2. `desktop/src/components/preprocess-tools/OfficeConvertTool.test.tsx`
3. `desktop/src/lib/officeFileTypes.ts`
4. `desktop/src/i18n/locales/vi.json`
5. `desktop/src/i18n/locales/en.json`

### Đã sửa

- Mỗi conversion chạy trong process top-level, output `.partial.pdf` được validate trước `os.replace`; crash/cancel/timeout xóa output dở.
- Job có `queued/running/converting/downloading/resizing/watermarking/completed/failed/cancelled/timed_out`, endpoint status/cancel/extend và lease có thể gia hạn.
- Office giữ serial gate; Google tách scheduler kind. Word/Excel/PowerPoint lấy PID instance riêng, LibreOffice dùng profile/PID riêng; không bao giờ `taskkill /IM`.
- PowerPoint hỗ trợ HWND dạng callable của pywin32. Cleanup chờ tối đa 3 giây khi cancel quá sớm để PID COM kịp công bố, dừng worker rồi quét PID lần hai; đây là wait chỉ ở terminal cleanup, không phải hard-cap throughput máy mạnh.
- UI lấy capability theo từng extension, chặn định dạng không có engine trước request, nhận Drive `open?id=...` và báo rõ Drive folder chưa hỗ trợ.
- Single, Google, batch và resize đều có AbortSignal/job ID; Dừng hủy file hiện tại, unmount hủy job và callback attempt cũ không được mở file.
- Resize kiểm cancel giữa từng trang và trước save. LibreOffice fallback không được bỏ qua im lặng `excel_layout`.

### Verify

| Kiểm tra | Kết quả |
|---|---:|
| Backend engine/runner/routes/resize/API contract | 113/113 pass |
| UI Office lifecycle | 7/7 pass |
| TypeScript typecheck | Pass |
| `py_compile` + route uniqueness + `git diff --check` | Pass; chỉ warning LF/CRLF |
| Runtime DOCX/XLSX/PPTX → PDF | 200; 116393 / 85217 / 100229 byte |
| Kết quả DOCX/XLSX/PPTX → first tile | IPC 23 / 20 / 22 ms |
| Runtime cancel PPTX 500 slide | `converting` → HTTP 409 → `cancelled`, terminal true |
| Cleanup PID Office sau cancel | 3277 ms; không còn PID Office mới |

Fixture: `C:\tmp\prynx_office_runtime_20260802_125752`. Log: `C:\Users\Khanh Pham\Desktop\PrynX_RenderPerf.log`. Excel PID 52308 là tiến trình có trước baseline và không bị can thiệp.

### Nợ Lô 5 đã xử lý ở Lô 6D/Lô 7

- Multipart Office và Google đã chuyển sang streaming theo chunk; Tauri Office đã nhận/giữ native output path và resize consume intermediate.
- Parity 11 Office, 7 ảnh và các dạng Google file hỗ trợ đã có test tự động.
- Runtime Google thật, đủ 11 Office và toàn chuỗi ma trận môi trường vẫn chưa nghiệm thu; không ghi quá mức từ capability/test mock.

## Lô 6A — Upload fail-fast và responsiveness

Trạng thái: code và test phạm vi đã có; runtime mở file hỏng qua app thật chưa nghiệm thu.

### File trong lô

1. `backend/app/api/routes/upload.py`
2. `backend/app/utils/file_handler.py`
3. `backend/tests/test_upload_fail_fast.py`

### Đã sửa

- Chỉ nhận `.pdf` không phân biệt hoa/thường ở route upload PDF.
- Kiểm 0 byte, `%PDF-`, strict parse không recovery, password/encryption, zero-page và metadata nhất quán trước HTTP 200.
- Lỗi parse/metadata/DB rollback và xóa bản backend sở hữu; local source không bị xóa.
- Metadata chạy trong threadpool; health vẫn phản hồi khi inspection bị giữ giả lập.
- Bỏ hard-cap upload chung vô điều kiện; đường nặng dùng streaming/admission theo từng tác vụ thay vì làm chậm máy mạnh.

### Verify đã biết

`test_upload_fail_fast.py` hiện có 12 ca sau parametrization. Không dùng cache `lastfailed` cũ làm kết quả; bảng pass cuối phải lấy từ lệnh closeout hiện tại.

## Lô 6B — Document routes và unlock path-based

Trạng thái: code/test phạm vi đạt; health sidecar thật đã nghiệm thu khi Interleave 5.000 trang chạy, runtime unlock UI chưa nghiệm thu.

### File trong lô

1. `backend/app/api/routes/document_tools.py`
2. `backend/app/api/routes/pdf_tools.py`
3. `backend/app/main.py`
4. `backend/tests/test_document_tools_routes.py`
5. `backend/tests/test_api_contract.py`

### Đã sửa

- Tách quick color, layers, layer preview, text, meta và unlock khỏi `pdf_tools.py`/`imposition.py`; router được đăng ký trong `main.py`.
- Sync work chạy trong threadpool thay vì uvicorn event loop.
- Unlock copy multipart theo chunk, xử lý path → path, giữ `pdfium_guard()` chỉ quanh PDFium và trả `FileResponse` có cleanup.
- Test hiện có 10 ca sau parametrization, gồm năm route off-loop và các terminal cleanup của unlock.

## Lô 6C — Detect-shape off-loop và coalescing

Trạng thái: code/test phạm vi đạt; chưa smoke concurrency trên sidecar thật.

### File trong lô

1. `backend/app/api/routes/imposition.py`
2. `backend/app/core/detect_shape_service.py`
3. `backend/tests/test_detect_shape_coalescing.py`
4. `backend/tests/test_god_file_ratchet.py`

### Đã sửa

- Validate/path/cache-key/canonicalization và CPU phases không chạy trực tiếp trên event loop.
- Request cùng detection key dùng chung inflight task; cancel một client không hủy task dùng chung.
- Test event-loop responsiveness, cache key và coalescing; `imposition.py` về đúng ratchet hiện tại.
- `nup_engine.py` vẫn vượt ratchet baseline và không được nâng budget trong audit này.

## Lô 6D1 — Office/Google streaming

Trạng thái: code/test phạm vi đạt; Google public thật chưa nghiệm thu.

### File trong lô

1. `backend/app/api/routes/office_convert.py`
2. `backend/app/workers/office_convert_engine.py`
3. `backend/tests/test_office_convert_routes.py`
4. `backend/tests/test_office_convert_engine.py`

### Đã sửa

- Multipart Office copy theo chunk trong worker thread, không `await file.read()` toàn file.
- Google dùng `httpx.stream()`/`iter_bytes(1 MiB)`, kiểm PDF signature và phát hiện HTML private/login trước publish.
- Kiểm dung lượng đĩa khi Google trả `Content-Length`; output lỗi bị xóa.

## Lô 6D2 — Office Tauri path → path

Trạng thái: code/typecheck/test và runtime path chain đã đạt; không suy ra Google/đủ 11 Office runtime.

### File trong lô

1. `desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`
2. `desktop/src/components/preprocess-tools/OfficeConvertTool.test.tsx`
3. `desktop/src/lib/api.ts`
4. `desktop/src-tauri/src/lib.rs`

### Đã sửa

- Tauri gửi `file_path`, yêu cầu `return_path` và không đổi result PDF thành Blob/ArrayBuffer rồi ghi lại.
- Resize dùng `consume_source=true`; batch dùng `copy_batch_pdf`.
- Native result path được gắn vào `File` kết quả và giữ tới viewer.

### Verify

| Kiểm tra | Kết quả |
|---|---:|
| UI Office | 9/9 pass |
| Backend Office phạm vi path/resize | 97/97 pass |
| Typecheck, `py_compile`, diff-check | Pass |
| DOCX path convert | 6.158 ms; `%PDF-`; 116.393 byte |
| Resize path → path | 42 ms; intermediate được xóa |
| Native first-page render | 614 ms; JPEG 31.571 byte |

Fixture: `C:\tmp\prynx_office_runtime_20260802_125752`.

## Lô 6E — Admission sau manifest expansion

Trạng thái: code/test phạm vi đạt; chưa runtime file cực lớn/máy nhiều tier.

### File trong lô

1. `backend/app/workers/pdf_manifest_engine.py`
2. `backend/tests/test_pdf_manifest_engine.py`

### Đã sửa

- Inspect toàn manifest trước append: mở rộng whole-file, đếm page occurrence, image pixel, source/output/RAM/disk estimate.
- `<8 GB` và `<16 GB` có page cap riêng; `≥16 GB` không có cap trang mặc định.
- Mọi tier admission theo RAM/đĩa khả dụng chia theo slot; override env là lựa chọn vận hành.
- Progress/cancel được kiểm trong inspect/merge/watermark, không mở thêm PDFium worker.

## Lô 6F1 — Backend Combine job cho manifest + legacy modes

Trạng thái: backend/API/UI đã migrate; runtime HTTP/backend đạt, UI Tauri chưa nghiệm thu.

### File trong lô

1. `backend/app/api/routes/pdf_tools.py`
2. `backend/app/api/routes/combine_jobs.py`
3. `backend/app/core/combine_jobs.py`
4. `backend/app/workers/pdf_manifest_engine.py`
5. `backend/tests/test_pdf_manifest_jobs.py`

### Đã sửa

- Endpoint start/status/cancel/result dùng registry, queue gate, progress, cooperative cancel, cleanup/TTL.
- Output ghi `.partial.pdf`, validate/watermark rồi atomic publish; cancel/fail không công bố file dở.
- `source_paths` mixed path/`null` giữ thứ tự; file native không copy qua WebView, chỉ mục `null` upload.
- Ba mode `manifest`, `merge_files`, `interleave` dùng cùng job. Mode legacy tự sinh whole-file manifest; Interleave giữ đúng thứ tự xen kẽ và từ chối ảnh vì engine legacy là PDF-only.
- Test file hiện có 15 hàm, trong đó mode legacy parametrized cho `merge_files/interleave`; số pass cuối không cộng với lượt 13/13 trước migration.

## Lô 6F2 — API Combine job

Trạng thái: helper cho manifest và legacy modes đã migrate; runtime HTTP đạt, Tauri UI chưa nghiệm thu.

### File trong lô

1. `desktop/src/lib/api.ts`
2. `desktop/src/lib/api.mergeManifest.test.ts`

### Đã sửa

- Start → poll progress → result path/Blob; Abort gửi đúng một `/cancel` và reject `AbortError`.
- Mixed `[nativePath, null]` chỉ upload file in-memory.
- `backendMergePdfsJob()` đưa `merge_files/interleave` qua lifecycle job chung.
- Test file hiện có 7 ca, gồm legacy Interleave zero-copy; helper sync `backendMergePdfs()` được giữ làm compatibility nhưng không còn là consumer delegated đã audit.

## Lô 6F3 — CombineTab job lifecycle

Trạng thái: code/test UI phạm vi đã migrate; backend job runtime đạt, thao tác UI Tauri chưa nghiệm thu.

### File trong lô

1. `desktop/src/components/CombineTab.tsx`
2. `desktop/src/lib/combineTransport.integration.test.tsx`
3. `desktop/src/i18n/locales/vi.json`
4. `desktop/src/i18n/locales/en.json`

### Đã sửa

- Manifest merge và delegated Interleave đều có AbortController, progress và nút Dừng.
- Unmount abort job; generation fence chặn progress/result cũ và không `onSpawnTab` sau cancel.
- Tauri result giữ native path; web result dùng Blob.
- Integration test file có 12 ca; cùng 7 ca API tạo lượt focused 19/19. Runtime hai-file 9/10 ms của Lô 4 là đường trước migration, không dùng làm bằng chứng cho job mới.

## Lô 6F4 — Process handler legacy merge/interleave

Trạng thái: consumer delegated cuối đã migrate; endpoint backend runtime đạt, thao tác consumer trên Tauri chưa nghiệm thu.

### File trong lô

1. `desktop/src/lib/processHandlers.ts`
2. `desktop/src/lib/processHandlers.test.ts`

### Đã sửa

- Large `merge_files/interleave` dùng `backendMergePdfsJob`, truyền progress và nối cancel handler.
- Native result path được giữ khi spawn tab hoặc commit working file; không bắt buộc materialize result Blob.
- Sau sub-lô này, `§COMB.2` được đóng về code/test cho toàn bộ consumer backend đã audit. Nút/API sync cũ có thể còn tồn tại để compatibility nhưng không còn là đường delegated của `CombineTab`/process handler.

## Runtime closeout — Combine job sau migration

Lượt đầu dùng sidecar tạm cổng 8322 để không làm gián đoạn app. Sau full regression, tiến trình 8321 cũ được thay bằng sidecar khởi động từ working tree hiện tại; health đạt và OpenAPI có đủ bốn route job. Đây là runtime HTTP/backend thật, chưa phải thao tác UI Tauri.

| Kiểm tra | Kết quả |
|---|---:|
| Backend engine/job + ma trận giao nhau | 204/204 pass |
| Frontend consumer + API | 19/19 pass |
| TypeScript typecheck | Pass |
| Full Vitest | 1.689 pass, 2 skip, 2 snapshot baseline fail |
| Full pytest | 2.028 pass, 5 skip, 3 baseline fail |
| Rust full đã biết | 44/44 pass, loại ca PDFium rotation treo baseline |
| Merge native path | Completed, native result path, đúng 2 trang |
| Interleave 2 × 2.500 trang | Completed 5.000 trang trong 7.015 ms |
| Active sidecar 8321 | Restart code hiện tại; health + 4 route job đạt |
| Health khi Interleave 5.000 trang | 187 probe; median 5,82 ms, max 15,99 ms |
| Progress quan sát | 104 thay đổi; inspecting → merging 0–100% → saving → watermarking → completed |
| Thứ tự Interleave | Sáu trang đầu có width 200/400 xen kẽ đúng |
| PDFium first page | Pass, 3 ms |
| Cancel giữa merging | Hủy tại 2% (100/5.000), terminal cancelled |
| Cleanup sau cancel | Không còn output hoặc `.partial.pdf` |
| Mixed native/upload | Completed, native result path, 2/2 trang |

`§COMB.2` vì vậy đóng ở implementation/backend runtime. Gate còn lại là UI Tauri thực sự nhận progress, bấm Dừng và mở native result path tới first tile.

## Lô 7A — Dispatcher chung và cold-start Combine/Convert

Trạng thái: test tự động đạt; ma trận thao tác tay chưa đủ.

### File trong lô

1. `desktop/src/App.tsx`
2. `desktop/src/hooks/useIncomingFileDispatcher.ts`
3. `desktop/src/hooks/useIncomingFileDispatcher.test.tsx`
4. `desktop/src/components/SystemIntegrations.tsx`
5. `desktop/src/components/SystemIntegrations.test.tsx`

### Đã sửa

- Mọi event file hội tụ tại dispatcher testable.
- Explicit Combine/Convert giữ batch qua poll đầu và có fallback hữu hạn.
- PDF tách tab, Office gom batch, ảnh/hỗn hợp vào đúng viewer/Combine/tool active.
- Oracle đủ PDF + 7 ảnh + 11 Office, đuôi viết hoa.

## Lô 7B — Ảnh → PDF và terminal UI

Trạng thái: code/test tự động đạt; WebP/BMP/TIFF thật và terminal UI thủ công chưa nghiệm thu.

### File trong lô

1. `desktop/src/lib/imageNormalizer.ts`
2. `desktop/src/lib/imageNormalizer.test.ts`
3. `desktop/src/components/ImpositionTab.tsx`
4. `desktop/src/i18n/locales/vi.json`
5. `desktop/src/i18n/locales/en.json`

### Đã sửa

- Bảy ảnh được chuẩn hóa thành PDF một trang; path-stub đọc bytes qua native transport.
- Generation fence ngăn callback retry/cancel cũ ghi đè.
- Sau 8 giây chỉ báo chậm; lỗi chuyển ảnh là terminal có Thử lại/Hủy.
- Lượt test liên quan đã báo 35/35. Chưa có component test trực tiếp cho mọi trạng thái của màn mở ảnh.

## Lô 7C1 — Parity định dạng và cửa vào

Trạng thái: oracle tự động đạt; runtime 19 đuôi chưa đủ.

### File trong lô

1. `desktop/src/lib/imageFileTypes.ts`
2. `desktop/src/lib/imageNormalizer.ts`
3. `desktop/src/lib/officeFileTypes.ts`
4. `desktop/src/lib/nativeFileAccess.ts`
5. `desktop/src/components/CombineTab.tsx`

### Đã sửa và verify

- Nguồn chân lý: PDF + 7 ảnh + 11 Office.
- Ảnh/Combine/dispatcher: 46/46.
- Home/System/dispatcher/Office: 29/29.
- Google Docs/Sheets/Slides, Drive `/file/d/`, `open?id=` được nhận; folder bị từ chối.
- Unicode/UNC trong test là path mô phỏng, không phải share thật.

## Lô 7C2 — Recent Office

Trạng thái: test tự động đạt; Recent USB/UNC thật chưa nghiệm thu.

### File trong lô

1. `desktop/src/App.tsx`
2. `desktop/src/lib/useRecentFiles.ts`
3. `desktop/src/components/RecentFiles/RecentFilesGrid.tsx`
4. `desktop/src/components/RecentFiles/ThumbnailView.tsx`
5. `desktop/src/lib/useRecentFiles.office.test.ts`

### Đã sửa và verify

- Ghi đủ Office single/batch, khử path trùng và bỏ generated/no-path.
- Placeholder nhận đủ Office theo tên, không thử decode như ảnh.
- Recent Office 2/2; Office UI 9/9.

## Lô 7D — N-Up terminal, uppercase và folder oracle

Trạng thái: test tự động đạt; chưa runtime lỗi child/folder share thật.

### File trong lô

1. `backend/app/api/routes/imposition.py`
2. `backend/tests/test_nup_job_lifecycle.py`
3. `backend/tests/test_imposition_file_case.py`
4. `desktop/src-tauri/src/lib.rs`

### Đã sửa và verify

- Child exit 0 thiếu state → `failed` terminal, không kẹt `running`.
- `/execute-plan` nhận `FILE.PDF`.
- Rust folder scan nhận PDF + 11 Office không phân biệt hoa/thường, bỏ `~$`.
- Backend Office/N-Up/uppercase 27/27; Rust folder 3/3.

## Closeout — chưa được ghi “hoàn tất toàn bộ”

Các finding còn mở theo nghĩa nghiệm thu:

- `§REL.1`: code/test/docs chưa nằm trong HEAD và chưa clean checkout/clean clone/release build.
- `§TEST.1`: chưa đủ runtime operation → result → first tile/error trên toàn ma trận.

`§COMB.2` đã đóng về implementation/backend runtime sau migration manifest + `merge_files` + `interleave`. Các gate còn lại:

1. Backend cổng 8321 đã nạp code hiện tại; health và bốn route job đạt. Chưa dùng thao tác UI app làm bằng chứng.
2. Smoke Tauri progress/cancel/result path → viewer → first tile cho manifest merge và Interleave/merge_files modes.
3. Smoke local/D:/Unicode, picker/drop/Recent/folder, WebP/BMP/TIFF, Office/Google và UNC/NAS/USB khi có môi trường thật.
4. Chạy full regression và ghi riêng baseline failure; không cộng các lượt test giao nhau.
5. Commit atomically rồi verify clean checkout. Rebuild bằng `cargo clean` trên working tree dirty không phải clean-checkout gate.

Nợ baseline không thuộc audit: `lint:budget`, lint cũ trong `ImpositionTab.tsx`, god-file `nup_engine.py`. Không tự nâng budget, cập nhật golden hoặc sửa ké.
