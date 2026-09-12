# Audit loading / dựng hình Viewer (2026-09-13)

Phạm vi: trạng thái UI `Đang dựng hình…` trong `LivePageFrame`, đặc biệt khi mở/xem PDF kết quả Bình tem bế. Audit read-only; chưa sửa mã.

## Kết luận ngắn

Spinner trong ảnh là trạng thái chờ **bitmap trang đầu tiên render + decode**, không phải chỉ chờ React mount. Trên đường native, request đi qua Tauri IPC → quota render → worker/PDFium hoặc PPE → PNG bytes → WebView `Image.decode`. Vì vậy muốn giảm thời gian phải đo đúng từng pha; giảm debounce hay xóa spinner không làm render nhanh hơn.

Bằng chứng audit trước trên artifact bù xén thật (Windows, 16 CPU, RAM 32 GB) cho thấy PPE raster nóng trang kết quả có median khoảng **4,813 ms (trang 2)** và **7,905 ms (trang 3)**; khoảng 99% wall time nằm ở raster, không phải encode màu. Đây là bằng chứng cho nhánh PPE/bù xén, chưa phải số đo mọi PDF.

## Đường chạy đã trace

1. `desktop/src/hooks/viewer/usePdfLoader.ts:640-695`: native PDF gọi `get_pdf_viewer_bootstrap`, có thể gọi tiếp `get_pdf_metadata`, sau đó mới `markReady()` tại `:767-778`.
2. `desktop/src/components/workspace/LivePageFrame.tsx:4560-4599`: mount `LiveTile` cho lớp nền; `showLoadStatus` bật với frame active.
3. `desktop/src/components/workspace/LivePageFrame.tsx:1083-1107`: overlay hiển thị khi `showLoadStatus && !hasVisibleTile && phase !== ready`; chỉ tắt sau bitmap hiện hữu.
4. `desktop/src/components/workspace/LivePageFrame.tsx:705-842`: `LiveTile` gọi `getTileUrl`, chờ bytes, tạo `Image`, decode rồi set `hasVisibleTile=true`/`onTileReady`.
5. `desktop/src/hooks/viewer/useTileRenderer.ts:393-565`: PDF native dùng `nativeRenderCoordinator.renderPng()` → IPC `render_pdf_page`; PPE chính xác dùng `render_ppe_page` ở `:564-581`.
6. `desktop/src-tauri/src/lib.rs:4296-4435`: `render_pdf_page` chờ permit, chạy worker/PDFium, trả PNG bytes; `render_ppe_page` có đường quota/worker riêng.

## Phát hiện

### [CONFIRMED] §VIEWLOAD.1 — P1/P2, UI không có pixel trung gian nếu first render chưa xong

`LiveTile` chỉ đặt `hasVisibleTile` sau `preImg.onload` (`LivePageFrame.tsx:824-842`). Trước đó lớp trắng + spinner phủ toàn trang (`:1083-1107`). Với PDF lớn hoặc PPE, người dùng thấy trang trắng dù metadata đã sẵn sàng. Đây là hành vi đúng về soundness (không hiển thị ảnh sai màu/ảnh cũ), nhưng làm latency cảm nhận bằng toàn bộ thời gian raster đầu tiên.

### [CONFIRMED] §VIEWLOAD.2 — P1, nhánh PPE của PDF bù xén có raster đắt theo artifact

Audit `BAO_CAO_AUDIT_TOC_DO_VIEWER_SAU_BU_XEN_2026-09-11.md` đã render artifact kết quả thật: PPE nóng median trang 2 `4,813 s`, trang 3 `7,905 s`; raster chiếm xấp xỉ 99,3% wall time. Artifact bù xén có 9 `Do`/trang (artwork + tám dải/góc); việc giữ màu/vector là có chủ đích. Không được kết luận rằng xóa dải, flatten RGB hoặc giảm DPI là fix an toàn.

### [CONFIRMED] §VIEWLOAD.3 — P2, một lượt render active có thể gồm cả surface nền và viewport theo chính sách

`LivePageFrame.tsx:4575-4691` có các nhánh display base, accurate base/underlay và viewport `TileLayer`; `LiveTile` có guard in-flight/cache nhưng mỗi surface khác `fileKey/groupKey` là một render hợp lệ. Với trang rủi ro màu/zoom cao, đây là trade-off chính xác màu + không raster full-page quá lớn, không thể gộp thành “request trùng” nếu chưa có trace `group/resultKey` chứng minh.

### [SUSPECTED] §VIEWLOAD.4 — P2, mở PDF native có thể chờ hai lượt metadata trước first-pixel

`usePdfLoader.ts:655-663` gọi `loadFullMetadata(expectedIdentity)` khi bootstrap không có `colorRisk`, rồi `markReady()` mới xảy ra sau đó. Đây là chủ đích fail-closed màu và giữ `/UserUnit`/page boxes đúng, nhưng chưa có click→first-pixel đo riêng cho file người dùng. Nếu `get_pdf_metadata` quét toàn bộ trang, nó cộng trực tiếp vào thời gian trước khi `LiveTile` được mount.

### [SUSPECTED] §VIEWLOAD.5 — P2, queue/permit native có thể làm active tile chờ công việc nền

`render_pdf_page` (`lib.rs:4319-4338`) chờ `acquire_render_request_permits`; `TileRenderScheduler` có lane interactive/background, nhưng PPE accurate dùng `renderPng(... bypassScheduler: true)` (`useTileRenderer.ts:520-565`) và vẫn chờ quota/native mutex. Audit PPE cũ đã có chính sách priority nhưng chưa có timeline click→first-pixel của phiên này; không tự tăng worker hoặc bỏ quota.

## Bằng chứng đã có và khoảng trống

- Có test scheduler, coordinator, LiveTile và policy; typecheck/test unit không chứng minh latency GUI.
- Có benchmark PPE artifact thật như trên, nhưng không bao gồm click→paint WebView/Tauri, HTTP admission, decode DOM hoặc file tem bế hiện tại.
- Chưa có `PrynX_RenderPerf.log`/viewer trace của lần người dùng chụp ảnh; không thể xếp §VIEWLOAD.4/.5 thành nguyên nhân đã xác nhận.

## Đề xuất lô điều tra/sửa (chờ duyệt)

1. Bật trace perf opt-in và đo một thao tác cụ thể: mở file → first pixel, tách `bootstrap`, `metadata`, `queue/permit`, `core raster`, `PNG/IPC`, `Image.decode`.
2. Với artifact bù xén, ưu tiên profile PPE/Form/SMask theo audit 2026-09-11; giữ nguyên màu, clip, OCG và DPI.
3. Chỉ sau khi có trace mới cân nhắc prewarm/cache hoặc thay chính sách surface; mọi cache phải khóa source identity, revision, clip, zoom, profile và hủy request cũ.
4. Acceptance: median/P95 click→first-pixel trên file thật, pixel/hash parity, máy ≥16 GB không bị cap, và kiểm riêng tier RAM thấp.

## Trạng thái

## Telemetry đã được duyệt và triển khai (2026-09-13)

Đã thêm log opt-in, không đổi thuật toán render:

- `usePdfLoader.ts`: `pdf-load-start`, `pdf-bootstrap-ready`, `pdf-metadata-start/done`, `pdf-load-ready/error/cleanup`; có `loader_id` băm và thời gian tương đối.
- `LivePageFrame.tsx`: `tile-first-pixel` (native → decode) và `tile-dom-image-ready` (decode → DOM), nối với các event tile hiện hữu.
- `desktop/src-tauri/src/lib.rs`: thêm `request_id` vào `RENDER_WORKER_RESULT`, `IPC_RENDER`, `PPE_NATIVE_RESULT`, `IPC_PPE`.

Các log chỉ ghi khi binary dev bật `PRYNX_PERF=1` qua `preview_perf_logging_enabled`; mặc định không tạo thêm I/O/IPC. Không ghi đường dẫn hay nội dung PDF.

Verify: `npm run typecheck` đạt; Vitest `LivePageFrame.liveTile` + `usePdfLoader` **39 passed**; `cargo check` trong `desktop/src-tauri` đạt (17 cảnh báo dead-code có sẵn).

Trạng thái: `TRACED + AUTO (telemetry) · chờ chạy đúng ca Tauri để đạt ARTIFACT/RUNTIME`.

## Phân tích log runtime 2026-09-13

Đã đọc `C:\Users\Khanh Pham\Desktop\PrynX_RenderPerf.log` sau một lượt mở PDF và vào Bình tem bế.

### [CONFIRMED] §VIEWLOAD.6 — P1: native raster là nút thắt chính của lượt chậm

Ở request active `page=1`, `zoom=0.958`, log ghi:

- `IPC_RENDER ... sem_wait_ms=0 worker_queue_ms=0 core_ms=9046 command_ms=9046 bytes=2321703`.
- Frontend: `tile-request-start` → `tile-first-pixel` khoảng **9.086 s**.
- `tile-first-pixel` → `tile-dom-image-ready` chỉ khoảng **12 ms** (`display_decode_ms=9087` so với `native_to_decode_ms=9086`, chênh vài ms do timestamp).
- Metadata sau first pixel chỉ `metadata_ms=23 ms`.

Vậy lượt này không bị kẹt ở quota, queue, metadata hay DOM decode; khoảng 9 giây nằm trong `render_pdf_page`/worker/PDFium replay. Đây phù hợp với artifact Bình tem bế có nhiều Form/dải bù xén; không được chữa bằng cách chỉ ẩn spinner.

### [CONFIRMED] §VIEWLOAD.7 — P2: cùng một nguồn bị prime/bootstrap lặp trong lúc mở

Cùng `trace_id` + `path` có **3** `first-frame-prime-start` trong ~20 ms, tiếp theo là **3** `pdf-load-start`/bootstrap cho các generation loader tương ứng. Các prime đều kết thúc `first-frame-prime-skipped (page-1-uses-display-pipeline)`, nên không phải ba lượt PPE hoàn chỉnh; nhưng đây là công việc bootstrap/identity trùng và tạo nhiều lifecycle/frame cạnh tranh trong cold-open.

### [DISPROVED] metadata/DOM là thủ phạm của lượt này

Bootstrap native 15–68 ms, full metadata 23–28 ms; `tile-dom-image-ready` đến ngay sau `tile-first-pixel`. Không có bằng chứng queue chờ (`sem_wait=0`, `worker_queue=0`) hay browser decode lớn. Các giả thuyết §VIEWLOAD.4 và phần DOM của §VIEWLOAD.5 không giải thích được 9 giây ở log này.

### Khoảng trống còn lại

Log hiện chưa có counter bên trong PDFium cho số Form/SMask/object của chính file này; cần ghép `request_id=b1078931-63be-450b-a8b2-6e7c12bbf35e` với worker/native trace nếu muốn tách tiếp parse Form, replay, mask và encode. Không nên tăng worker hoặc giảm DPI trước khi có counter đó.

## Lô sửa sau khi có log (2026-09-13)

- `viewerFirstFrame.ts`: dedupe prime theo identity đường dẫn + kích thước + mtime, thay vì theo object `File`; loại bỏ prime/bootstrap trùng giữa các object đại diện cùng PDF.
- `run_dev.bat`: bật `PRYNX_PERF=1` mặc định trong dev để một lượt chạy tiêu chuẩn luôn tạo log; release không bị ảnh hưởng.
- Các mốc telemetry loader/tile/native đã giữ nguyên; không thay đổi DPI, quota, Form/SMask hay chất lượng màu.

Verify: `npm run typecheck` đạt; Vitest môi trường hiện tại gặp `spawn EPERM` khi Vite khởi động (không phải test assertion); `cargo check` trước lô này đã đạt, cần chạy lại sau khi build Tauri mới.
