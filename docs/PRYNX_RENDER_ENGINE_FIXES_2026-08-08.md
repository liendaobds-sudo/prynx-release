# NHẬT KÝ NÂNG CẤP PRYNX RENDER ENGINE

**Ngày bắt đầu:** 2026-08-08  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_PRYNX_RENDER_ENGINE_2026-08-08.md`  
**Quy tắc:** mỗi lô tối đa 5 file, có baseline/test đỏ/test xanh trước khi sang lô kế.

> **Trạng thái mới nhất — 2026-08-10:** `W7-U04` chỉ đạt `RUNTIME-PARTIAL`
> trên Tauri dev: cold/warm có pixel compositor thật, còn lăn/zoom/pan/xoay chờ
> chạy lại bằng harness mới. `W7-U05` giữ `AUTO + ARTIFACT`; smoke `42/42` cũ
> không còn là acceptance. Build/installer chưa chạy và `§RENDER.11` vẫn mở.

## Lô 1 — Khóa correctness accurate (`§RENDER.4`)

**Trạng thái:** hoàn tất kiểm thử tự động; chưa xác nhận bằng thao tác Tauri cài đặt.

### File thay đổi

1. `backend/app/core/softproof.py`
   - Giữ `degraded` và `ink_unsound` qua biên PPE → SoftProofEngine.
   - PPE không đủ tin không còn được gắn `rip_softproof`; giữ ảnh display và hạ về
     bản xem gần đúng có cảnh báo theo đúng chính sách PPE-only.
2. `backend/app/api/routes/preflight.py`
   - Endpoint Viewer từ chối đầu ra có cờ chất lượng xấu dù nhãn accuracy bị gắn sai.
3. `backend/app/core/viewer_accurate_cache.py`
   - Đổi namespace cache từ v1 sang `v2-soundness`, không tái dùng PNG sai đã ghi trước đây.
4. `backend/tests/test_icc_and_color_preview.py`
   - Thêm regression cho hạ nhãn PPE không đủ tin và cổng endpoint.
5. `backend/tests/test_viewer_accurate_cache.py`
   - Khóa phiên bản cache mới.

### Bằng chứng

- Baseline trước sửa: `17 passed, 1 skipped`.
- Test đỏ trước vá: 4 lỗi đúng finding (`rip_softproof`, không gọi GS, endpoint không từ chối 2 cờ).
- Sau sửa PPE-only: `21 passed, 1 skipped`; `softproof.py` không còn import,
  command hoặc chuỗi Ghostscript.
- `py_compile`: đạt cho 3 file production Python.
- `git diff --check`: đạt.

## Lô 2 — First-page fast path (`§RENDER.1`)

**Trạng thái:** hoàn tất code + kiểm thử tự động + benchmark native; chưa xác nhận thao tác
trên installer clean-user.

### File thay đổi

1. `desktop/src-tauri/src/lib.rs`
   - Thêm command `get_pdf_viewer_bootstrap`: warm document, kiểm `/UserUnit`, trả số trang,
     khổ trang 1, identity và danh tính PDFium; không quét màu/kích thước toàn tài liệu.
   - Detector màu chuyển thành lazy cache riêng, không giữ cache lock/PDFium lock trong lúc quét.
   - Metadata pha B nhận token `size:mtime_ns:ctime_ns`; từ chối file cùng path đã đổi giữa hai pha.
   - Giữ command `get_pdf_metadata` đầy đủ cho Flipbook/Imposer và giữ test trang 2.001.
2. `desktop/src/hooks/viewer/usePdfLoader.ts`
   - Commit pha A ngay để mount Viewer; pha B chỉ hydrate `allPageDims`, `colorRisk`,
     `renderEngine`, không reset page/order/zoom/scroll.
   - Generation cũ và identity cũ không được ghi state; lỗi pha B giữ Viewer pha A hoạt động.
   - HTTP fallback chỉ dùng khi chưa có identity bootstrap, tránh mượn metadata của file mới.
3. `desktop/src/hooks/viewer/usePdfLoader.test.tsx`
   - Khóa thứ tự pha A trước pha B, mixed-size không reset page/zoom, generation cũ,
     identity đổi và đường lỗi pha B.
4. `desktop/src/components/workspace/LivePageFrame.tsx`
   - Chỉ mở cổng pha B sau khi bitmap trang active đã render/decode xong hoặc request kết thúc lỗi;
     cache-hit mở cổng ngay vì first pixel đã sẵn.
5. `desktop/src/components/AcrobatViewer.tsx`
   - Giữ neo trang active qua commit hình học mixed-size để không nhảy scroll ngang/dọc.

### Bằng chứng

- Test đỏ trước vá: 2 lỗi đúng finding — hook còn `loading` khi full metadata chưa trả.
- Hook sau vá: `12 passed`.
- Viewer scheduler/renderer mục tiêu: `26 passed`; typecheck: đạt.
- Rust library: `87 passed, 1 ignored` trước khi thêm benchmark thủ công; command mới qua
  `cargo check --lib`. Benchmark thủ công riêng: `1 passed`.
- PDF khách `CMNM2026 - Giay moi_BLUE - in.pdf`, 4 trang, 5 vòng native warm-runtime:
  median gate cũ `44,38 ms`; bootstrap mới `39,22 ms` — giảm `5,16 ms` (`11,6%`) riêng
  phần metadata. Pha B median `43,43 ms` nhưng chỉ chạy sau ảnh đầu, nên không cộng vào
  `open → first visible`.
- Kết quả trên PDF này là mức tăng vừa phải vì chỉ có 4 trang; không suy diễn thành mức tăng
  toàn Viewer. Nút thắt zoom/render tiếp tục xử lý ở các lô sau.
- `git diff --check`: đạt cho 5 file production/test của lô.

## Lô 3a — Viewport rotation + rAF (`§RENDER.6/7`)

**Trạng thái:** hoàn tất code + test thuần + artifact PDF thật; chưa xác nhận pan/rotate bằng
thao tác trên installer.

### File thay đổi

1. `desktop/src/components/workspace/viewportTilePolicy.ts`
   - Inverse-map bounding box màn hình về hệ trang chưa xoay cho `0/90/180/270°`.
   - Gom pad/snap/TILE_MAX thành policy thuần; key chỉ đổi khi clip thật sự đổi.
   - Cung cấp rAF coalescer dùng chung cho scroll/resize.
2. `desktop/src/components/workspace/viewportTilePolicy.test.ts`
   - Bảng tọa độ đủ bốn góc, `-90°`, full bounding box, mép trang, TILE_MAX và rAF.
3. `desktop/src/components/workspace/LivePageFrame.tsx`
   - Scroll/resize không còn đo layout + setState trên từng event; tối đa một lần/frame.
   - Pan trong cùng snap giữ nguyên state; bật tile sắc cho trang xoay sau inverse-map.
   - Bitmap vẫn render `rot=0`; CSS cha tiếp tục sở hữu rotation để overlay không đổi contract.
4. `desktop/src-tauri/src/lib.rs`
   - Thêm artifact test thủ công so tile bốn góc với crop full-page trên PDF khách.

### Bằng chứng

- Test đỏ: module policy chưa tồn tại, suite fail đúng tại import.
- Policy mới: `11 passed`; cùng hook/scheduler/renderer: `45 passed`; typecheck: đạt.
- Artifact `CMNM2026 - Giay moi_BLUE - in.pdf`, page 1, zoom native `0,5`, tile `256²`:
  MAE RGB bốn góc lần lượt `0,2886 / 3,8287 / 1,7668 / 4,4131`, đều đạt gate `≤5`.
- Byte-identical bị bác bỏ có chủ đích: PDFium LCD text lệch subpixel theo bitmap origin;
  artifact khóa theo MAE + tỷ lệ pixel lệch, đủ bắt crop sai/hue seam mà không báo giả.

## Lô 3b — Giữ tile cũ + cache ownership (`§RENDER.7/8`)

**Trạng thái:** tách thành 3b1/3b2 để mỗi lô không vượt 5 file.

### Lô 3b1 — Double-buffer viewport tile

**Trạng thái:** hoàn tất code + test tự động.

- `viewportTilePolicy.ts`: reducer giữ tối đa tile visible + target; callback stale không thể
  ghi đè; đổi zoom/khổ/xoay/file xóa buffer cũ.
- `LivePageFrame.tsx`: tile A tiếp tục hiển thị khi B/C render và chỉ gỡ sau khi target mới
  decode; B→C nhanh giữ A, bỏ B; cache-hit cũng chờ `<img onLoad>` trước khi thay.
- `viewportTilePolicy.test.ts`: khóa chuỗi A→B→C, callback B stale và generation zoom khác.
- Bằng chứng: policy + scheduler `27 passed`; typecheck đạt; `git diff --check` đạt.

### Lô 3b2 — Cache ownership theo tab/document

**Trạng thái:** hoàn tất code + test tự động.

- `tileUrlCache.ts`: entry mang namespace tài liệu; owner ref-count theo tab; mở file chỉ dọn
  namespace mồ côi; release owner cuối mới revoke; budget RAM vẫn có quyền evict.
- `usePdfLoader.ts`: mỗi hook/tab giữ owner ổn định qua suspend; đổi file release namespace cũ,
  claim namespace mới trước khi chạy cleanup.
- `LivePageFrame.tsx`: display/accurate cùng namespace gốc; marker `|color:*` không còn làm
  `clearPrefix` trượt; cache entry nhận đúng file key.
- Test khóa hai tab cùng file, tab A/B khác file, owner cuối, display/accurate, lifecycle
  đổi file + unmount và cache-hit qua đường double-buffer.
- Bằng chứng: 5 suite mục tiêu `56 passed`; typecheck đạt; `git diff --check` đạt.

## Lô 4 — Cache native an toàn + RAM tier (`§RENDER.9/10`)

**Trạng thái:** hoàn tất code + test tự động.

### File thay đổi

1. `desktop/src-tauri/src/lib.rs`
   - Page LRU: `<8 GB = 6`, `8–15 GB = 12`, `≥16 GB/không rõ = 24`.
   - Cap được chốt theo document và dùng nhất quán cả handle đầu/lazy handle; máy mạnh giữ
     nguyên mức 24, không hạ công suất.
   - Đường đọc/ghi tile chuyển sang helper đã validation/atomic.
2. `desktop/src-tauri/src/tile_disk_cache.rs`
   - Chỉ nhận PNG có signature và IEND hoàn chỉnh; cache cắt dở/non-PNG tự xóa.
   - Ghi file tạm unique cùng thư mục, `write_all + flush`, rồi rename thay target nguyên tử;
     lỗi luôn dọn temp, pruner không nhận file `.tmp`.
   - Test thay target đang tồn tại, file truncated và dữ liệu invalid.

### Bằng chứng

- Test đỏ: 13 lỗi compile đúng vì policy/helper chưa tồn tại.
- Disk cache hẹp: `11 passed`; page tier: đạt.
- Toàn Rust library: `90 passed, 3 ignored`; 3 ignored gồm print runtime và hai benchmark
  artifact thủ công đã chạy riêng ở Lô 2/3a.

## Lô 5 — Render Coordinator contract (`§RENDER.2`)

**Trạng thái:** hoàn tất contract + adapter in-process + lifecycle decode; chưa đổi backend
PDFium và chưa bật worker process.

### File thay đổi

1. `desktop/src/hooks/viewer/renderCoordinator.ts`
   - Thêm contract version 1 gồm `request_id`, owner/slot/generation/purpose/priority,
     identity `size:mtime_ns:ctime_ns`, page/rotation/raster/clip/color pipeline.
   - `resultKey` chỉ phụ thuộc pixel kết quả; owner/generation/purpose/priority không làm vỡ
     cache. Khóa scheduler thêm owner + slot để hai tab không triệt nhau.
   - Adapter hiện tại giữ nguyên IPC `render_pdf_page`; PPE đi lane riêng, không chiếm hàng
     đợi PDFium display.
   - Generation cũ bị loại trước khi tạo Blob/decode/composite. Timing mới gồm
     `queue/wait/decode/stale_ms`; `render_ms/encode_ms/cache_tier` để `null/unknown` vì raw
     IPC chưa trả envelope — không suy diễn sai từ tổng round-trip.
2. `desktop/src/hooks/viewer/renderCoordinator.test.ts`
   - Khóa identity nanosecond không mất precision, result key, clip góc trái `x=0/y=0`,
     color pipeline, coalesce request vật lý, stale trước Blob và stale trong decode.
3. `desktop/src/hooks/viewer/usePdfLoader.ts`
   - Đăng ký identity bootstrap trước `markReady`, ngăn file bị ghi đè cùng path nhận bitmap
     của phiên cũ.
4. `desktop/src/hooks/viewer/useTileRenderer.ts`
   - Dựng request qua coordinator; owner là ID tab/instance không chứa path; đổi file tạo
     owner epoch mới. Tham số IPC, PNG lossless và lane PPE giữ parity.
5. `desktop/src/components/workspace/LivePageFrame.tsx`
   - Báo mốc bắt đầu/kết thúc decode và kích thước bitmap; stale source không được ghi DOM/cache.
   - Request stale/cancelled không còn mở sớm metadata pha B; lỗi thật của request hiện hành
     vẫn mở cổng để Viewer không treo.

### Bằng chứng

- Sáu suite Viewer/coordinator/scheduler/loader/viewport/cache: `61 passed`.
- TypeScript `tsc --noEmit`: đạt; `git diff --check` toàn worktree: đạt.
- Artifact bốn góc trên `CMNM2026 - Giay moi_BLUE - in.pdf`: test ignored thủ công đạt;
  MAE `0,2886 / 3,8287 / 1,7668 / 4,4131`, đều dưới gate `5`.
- Baseline từ `PrynX_RenderPerf.log` trước worker:
  - toàn lịch sử cache miss page: `n=4669`, P50 `86 ms`, P95 `1610 ms`;
  - cache miss viewport tile: `n=928`, P50 `71 ms`, P95 `365 ms`;
  - cache hit RAM: `n=9997`, P50 `0 ms`, P95 `2 ms`;
  - cache hit disk: `n=3576`, P50 `0 ms`, P95 `9 ms`;
  - nhóm PDF khách bitmap `2666×2666`, zoom 1: `n=5`, render P50/P95
    `104/417 ms`, encode `81/88 ms`, tổng `196/507 ms`.

Các số toàn lịch sử gồm nhiều PDF và phiên bản trước nên chỉ là mốc so tương đối. Lô 6 phải
đo lại cold/warm P50/P95 trên cùng PDF khách và thêm `supersede → tile mới visible`; không
được tuyên bố nhanh hơn chỉ từ benchmark tổng hợp này.

## Lô 6a1 — Protocol + self-spawn display worker (`§RENDER.2`)

**Trạng thái:** prototype worker dài hạn đã chạy thật; mode Viewer vẫn mặc định đường cũ,
chưa route IPC nên không đổi hành vi người dùng.

### File thay đổi

1. `desktop/src-tauri/src/pdf_engine/render_worker.rs`
   - Frame nhị phân 28 byte little-endian: magic/version/kind/request ID/header length/payload
     length; JSON header tối đa 64 KiB, payload tối đa 512 MiB, không base64.
   - Contract `Hello/Render/Ping/Shutdown`; response echo request/generation/pipeline,
     bitmap size, soundness và timing.
   - Worker kiểm path tuyệt đối + canonical, sensitive path/device namespace/ADS, identity
     nanosecond, page/rotation/clip, scale hữu hạn và display pipeline. File PDF tạm không có
     đuôi chuẩn và đường UNC không bị chặn vô điều kiện.
   - Request frame bắt buộc payload rỗng. Core raw chưa trả cache tier/render/encode timing
     nên giữ `none/null`, không gắn nhãn sai.
   - Handshake pin protocol/app/tile-cache/pipeline, nonce và SHA-256 PDFium; stdout chỉ chứa
     frame, stderr dành cho lỗi fatal.
2. `desktop/src-tauri/src/pdf_engine/mod.rs`
   - Đăng ký module worker.
3. `desktop/src-tauri/src/main.rs`
   - Rẽ nhánh `--prynx-render-worker` trước khi khởi tạo Tauri.
4. `desktop/src-tauri/src/lib.rs`
   - Export entry worker cho executable tự-spawn.

### Bằng chứng

- Toàn Rust library: `103 passed, 3 ignored`; riêng protocol/validation `13 passed`.
- `cargo check --bins`: đạt; `git diff --check` phạm vi lô: đạt.
- Runtime self-spawn thật: handshake protocol 1, app `1.0.0-rc.4`, tile cache
  `v7_userunit_lossless_png`, PDFium hash hợp lệ; shutdown response `ok`, exit code `0`,
  stderr rỗng.
- Runtime trên `CMNM2026 - Giay moi_BLUE - in.pdf`: worker trả PNG signature hợp lệ,
  bitmap `498×374`, `195.097` byte, worker total `311 ms`, round-trip `314 ms`, exit `0`.
- Runtime đầu tiên đã bắt được stack overflow do buffer hash 1 MiB nằm trên stack Windows;
  chuyển buffer sang heap và chạy lại thành công. Đây là bằng chứng vì sao không chỉ dựa
  vào unit test protocol.

### Cổng trước khi bật

- Lô 6a2 phải thêm parent manager dài hạn và route đồng bộ render/bootstrap/metadata/close,
  `tile://` và startup warm-up; mode `required` phải chứng minh UI process không bind PDFium.
- Sau đó mới đo cold/warm P50/P95, crash/restart và cân nhắc mặc định `auto`.

## Lô 6a2 — Parent manager + route toàn Viewer PDFium (`§RENDER.2`)

**Trạng thái:** đường worker `required` đã chạy end-to-end; mặc định vẫn `off` để chưa gây
hồi quy ưu tiên tương tác trước khi có lane riêng ở Lô 6b.

### Thay đổi

- `render_worker.rs`:
  - Parent manager giữ worker dài hạn, pipe stdin/stdout và drain stderr riêng; handshake pin
    nonce/PID/protocol/app/cache/pipeline/PDFium hash.
  - Mode `PRYNX_RENDER_WORKER_MODE=off|auto|required`; giá trị sai/default đều `off`.
  - `auto` chỉ fallback in-process khi spawn/handshake thất bại **trước** request. Lỗi sau
    khi request đã gửi hoặc lỗi PDF từ worker không chạy lại cùng PDF trong UI process.
  - Thêm operation bootstrap/metadata/close; JSON metadata đi payload thay vì header 64 KiB,
    nên tài liệu hàng nghìn trang không vỡ frame.
  - Worker crash làm client bị hủy; request kế tiếp có thể spawn worker mới. Shutdown gửi frame
    rồi chờ process thoát.
- `lib.rs`:
  - Tách core blocking dùng chung cho render/bootstrap/metadata/close.
  - Route `render_pdf_page`, bootstrap pha A, metadata pha B, close document và `tile://`
    qua policy worker.
  - Startup release warm worker khi mode bật; `required` lỗi thì không bind PDFium trong UI.
    Khi app thoát, worker được shutdown cùng sidecar.

### Bằng chứng

- Toàn Rust library: `104 passed, 4 ignored`; `cargo check --bins`: đạt.
- Runtime manager `required` trên PDF khách: cùng một worker chạy
  `bootstrap → metadata → render → close`; PNG hợp lệ và test xác nhận
  `PDFIUM_STATIC` của process cha vẫn rỗng.
- Runtime trực tiếp: bootstrap `38 ms`, metadata `43 ms`, 4 trang, identity pha A/B khớp,
  close trả `true`, worker exit `0`, stderr rỗng.

Chưa bật `auto`: manager hiện chỉ có một lane tuần tự; nếu thumbnail/prefetch vào trước, nó có
thể chặn tile tương tác. Lô 6b phải tách lane và hủy vật lý request stale trước khi đổi mặc định.

## Lô 6b1 — Request lease + cancellation vật lý (`§RENDER.2`)

**Trạng thái:** hoàn tất và đã chạy runtime trên PDF khách.

- Frontend truyền đủ `requestId/ownerId/groupKey/generation/purpose/priority/pipelineIdentity`
  xuống `render_pdf_page`.
- `RenderCoordinator` gọi `cancel_pdf_render` khi generation mới cần pixel khác; request cũ
  bị loại trước Blob/decode/composite như Lô 5.
- Parent giữ process lease đúng request. Hủy request đang ở PDFium sẽ kill đúng worker đó;
  request kế tiếp spawn lại worker, không mở thêm PDFium trong process UI.
- Runtime `required`: render zoom lớn bị hủy thật, request kế tiếp restart và trả PNG hợp lệ;
  `PDFIUM_STATIC` của process cha vẫn rỗng.

## Lô 6b2 — Interactive lane + pool nền theo phần cứng (`§RENDER.2`)

**Trạng thái:** hoàn tất code, unit/integration/runtime; mặc định đã chuyển `off → auto` sau khi
hai policy máy mạnh và máy ít RAM cùng đạt.

### File thay đổi

1. `desktop/src-tauri/src/pdf_engine/render_worker.rs`
   - Thay singleton bằng manager gồm một interactive worker và background pool lazy.
   - Policy: `<8 GiB = 0` lane nền riêng; `8–15 GiB = 1`; `≥16 GiB =
     min(CPU−1, RAM/4 GiB)`; không rõ RAM dùng `CPU−1`. Pool tăng theo máy và không có hard-cap
     cố định, đồng thời không cho máy 16 GiB spawn quá nhiều PDFium. Biến
     `PRYNX_RENDER_BACKGROUND_WORKERS` là escape hatch QA.
   - Bootstrap/Ping/interactive render đi lane tương tác; metadata/background render đi pool
     nền; close broadcast tới mọi lane đã spawn; shutdown hủy request kẹt rồi dọn mọi process.
   - Tier `<8 GiB` cho background mượn interactive worker khi idle. Khi tương tác tới, manager
     preempt đúng background lease, dành lane cho tương tác rồi retry background sau đó.
   - Pending registry được tạo trước lúc chờ lane, nên user cancel/close trong khe
     `preempt → retry` không làm request stale sống lại. Cancel thật không bị hiểu nhầm là preempt.
   - Mặc định không có env là `auto`; env `off|auto|required` vẫn giữ để fallback/chẩn đoán.
2. `desktop/src/hooks/viewer/tileRenderScheduler.ts`
   - Native scheduler dùng hai slot nhưng tối đa một background, luôn bảo lưu cửa vào cho
     interactive request. Instance tuần tự `maxConcurrent=1` vẫn giữ hành vi cũ.
3. `desktop/src/hooks/viewer/tileRenderScheduler.test.ts`
   - Khóa hai bất biến mới: background đang chạy không chặn interactive và hai background
     không được chiếm hết hai slot.
4. `desktop/src/components/acrobat/ThumbSidebar.tsx`
   - Thumbnail truyền context `purpose=background, priority=500`; cleanup gửi cancel vật lý
     ngoài việc hủy caller scheduler.
5. `desktop/src-tauri/src/lib.rs`
   - IPC `render_pdf_page` và protocol `tile://` dùng chung một semaphore. Mode worker lấy số
     slot theo pool RAM/CPU; tier `<8 GiB` vẫn giữ hai cửa vào để preempt; mode `off` giữ trần 4 cũ.

### Bằng chứng

- Rust library: `108 passed, 4 ignored`; test render-worker hẹp `18 passed, 1 ignored`.
- `cargo check --bins`: đạt.
- Năm suite Viewer/coordinator/scheduler/loader/viewport/cache: `56 passed`.
- `npm run typecheck`: đạt.
- Runtime `required` trên `CMNM2026 - Giay moi_BLUE - in.pdf`, policy máy mạnh:
  bootstrap interactive → metadata background worker riêng → render → cancel/restart → close mọi
  lane đạt; process cha không bind PDFium.
- Runtime `required` với `PRYNX_RENDER_BACKGROUND_WORKERS=0`: background zoom lớn đang chạy bị
  preempt, interactive hoàn tất trước, background retry thành công; sau đó cancel/restart/close đạt.
- Runtime không đặt `PRYNX_RENDER_WORKER_MODE` chứng minh mặc định `auto` đi worker end-to-end và
  process cha vẫn không bind PDFium.

## Lô 6b3 — Ưu tiên xuyên suốt `tile://`, preload và lifecycle nhiều tab (`§RENDER.2`)

**Trạng thái:** hoàn tất code + test tự động + runtime worker trên PDF khách; còn smoke UI Tauri.

### Thay đổi

- `tile://` tách query trước khi parse clip và nhận `purpose=interactive|background`; URL cũ
  không query vẫn là interactive. Query không còn dính vào `clip_h` làm tile `(0,0,w,h)` rơi
  nhầm sang full-page.
- Semaphore native có quota nền riêng bằng `total−1`: request nền lấy quota nền trước rồi mới
  lấy quota tổng, nên không thể xếp hàng trong semaphore tổng và chiếm mất cửa dành cho thao tác.
  Tổng slot vẫn theo RAM/CPU của Lô 6b2; máy mạnh không bị hard-cap mới.
- Recent files, thumbnail khuôn, blueprint và lưới Digital Press đi lane background. Flipbook
  đánh dấu hai trang của spread hiện tại là interactive, phần nạp trước là background; khi lật
  tới trang đã preload, URL/context được promote ngay thay vì chờ 750 ms.
- Scheduler khi coalesce một task background còn chờ với request interactive cùng pixel sẽ thay
  cả priority lẫn closure native. Trước đây chỉ số priority đổi nhưng closure cũ vẫn gửi
  `purpose=background`.
- Mỗi instance Viewer có document lease riêng. Đóng một tab không còn hủy request hoặc đóng cache
  của tab khác đang mở cùng PDF; chỉ owner cuối cùng mới broadcast `CloseDocument` tới các worker.
- Native request ID thêm sequence atomic, tránh hai metadata/bootstrap đồng thời trùng ID do độ
  phân giải clock Windows.

### Bằng chứng

- Rust library: `114 passed, 4 ignored`; render-worker hẹp `19 passed, 1 ignored`;
  parser/quota tile `4 passed`; document lease `1 passed`.
- Chín suite Viewer/loader/scheduler/coordinator/cache/flipbook/modal: `66 passed`.
- `npm run typecheck`, `cargo fmt --check`, `cargo check --bins`: đạt.
- Clean link với `CARGO_INCREMENTAL=0`: đạt cho cả lib test executable và binary
  `pdf-inspector.exe`.
- Runtime `required` trên `CMNM2026 - Giay moi_BLUE - in.pdf`: policy máy mạnh đạt toàn chuỗi
  bootstrap → metadata nền → render → cancel/restart → close; policy
  `PRYNX_RENDER_BACKGROUND_WORKERS=0` đạt preempt vật lý + background retry.
- Benchmark metadata cùng PDF, 5 vòng: median bootstrap `41,15 ms`, legacy full metadata
  `47,95 ms`; pha đầu giảm khoảng `14,2%`. Đây là số đo riêng đường mở metadata của file 4 trang,
  không dùng thay cho P50/P95 zoom trong app thật.

### Việc còn lại sau Lô 6b3

- Lô 7: PPE viewport tile + priority/cancellation accurate; không trộn vào display worker.
- Đo lại P50/P95 `zoom-stop → sharp` và peak RSS trong app thật trên máy vật lý 8/16/32 GiB.
- Build artifact sạch và installed smoke vẫn thuộc Lô 8; không dùng binary dev làm bản phát hành.

## Lô 7a1 — PPE viewport: ổn định neo raster + bỏ decode ảnh ngoài viewport (`§RENDER.3`)

**Ngày:** 2026-08-09  
**Trạng thái:** hoàn tất code và test Rust; chưa xác nhận bằng thao tác Tauri trên installer.

### File thay đổi

1. `print_engine/src/page.rs`
   - Dùng chung phép tính scale `f64` cho kích thước raster và ma trận thiết bị; chỉ
     chuyển sang `f32` ở biên API `Matrix` để kích thước clip và neo đáy không lệch một
     pixel tại các cạnh nửa pixel.
   - Bổ sung regression cho `155,9 pt @360 DPI → 779 px` và `297 pt @100 DPI → 413 px`,
     kiểm tra cả bốn góc xoay.
2. `print_engine/src/content/interp.rs`
   - Tính bbox của unit-square XObject sau CTM và bỏ qua ảnh hoàn toàn ngoài buffer trước
     khi gọi `decode_image`; ảnh giao viewport vẫn đi qua decode, SMask, colorspace và
     cảnh báo lỗi như đường full-page.
3. `print_engine/tests/render_image.rs`
   - Khóa hai ca ảnh hỏng `1.000.000 × 1.000.000`: ngoài viewport phải không decode/không
     hạ soundness; giao viewport phải fail-loud.
4. `print_engine/tests/render_page.rs`
   - Khóa parity tile/full-page ở bốn góc xoay và gate overlap cho stroke AA.
   - Byte-exact không dùng làm gate vì CTM cuối vẫn lưu `f32`; overlap gate dùng số đo
     `max ≤ 12`, `mean ≤ 0,012`, tối đa `24` mẫu khác.

### Bằng chứng

- `cargo test` trong `print_engine`: **575 passed, 0 failed, 0 ignored** (350 unit +
  toàn bộ integration/doc tests).
- `git diff --check` phạm vi bốn file engine/test: đạt.
- `cargo fmt --check` toàn crate chưa đạt do format drift có sẵn ngoài các hunk mới
  (`raster/mask.rs`, `text/outlines.rs` và các đoạn cũ trong `interp.rs`/test); không
  auto-format để tránh kéo thay đổi ngoài lô vào diff.
- Các ca tile/full-page giữ sai số full-page hiện hữu `max ≤ 16`, `mean ≤ 0,25`; ca
  overlap mới đạt gate chặt hơn nêu trên.

### Giới hạn còn lại

- Codec không hỗ trợ ROI vẫn phải giải mã toàn bộ ảnh nếu ảnh giao viewport; lô này chỉ
  loại được XObject nằm ngoài viewport.
- Chưa có benchmark P50/P95 `zoom-stop → sharp` trên app Tauri cài đặt; không suy diễn
  các số test Rust thành tốc độ runtime của khách hàng.
- Accurate tile scheduler/cache/compositor và rollout artifact vẫn thuộc các lô 7b–8.

## Lô 7a2 — Accurate viewport end-to-end + latest-only (`§RENDER.3/5`)

**Ngày:** 2026-08-09  
**Trạng thái:** hoàn tất code, test tự động và artifact backend trên PDF khách; chưa smoke thao tác
zoom/pan trong cửa sổ Tauri hoặc installer mới.

### Thay đổi

- Frontend quy viewport CSS sang raster PPE bằng `DPI / (96 × zoom)`, truyền đủ clip
  `x/y/width/height` và dùng cùng group owner cho full-page nền với viewport tương tác.
- Lớp display PDFium tiếp tục hiện tức thì; tile accurate chỉ nhận PPE, nên tile đến muộn
  không thể phủ màu PDFium trở lại lên nền đã đúng FOGRA39.
- Schema/route backend bắt buộc clip đủ bốn trường, khóa kích thước đầu ra đúng clip và đưa
  clip vào cache key; cache cũ được tách sang namespace `v3-viewport`.
- Admission backend là latest-only theo owner/generation. Interactive mới loại waiter cũ trước
  khi vào PPE; request đã vào native giữ gate tới khi kết thúc nhưng không ghi cache nếu không
  còn người chờ.
- Route theo dõi `Request.is_disconnected()`: `AbortController` đóng HTTP nay hủy waiter thật,
  không để request đã bỏ tiếp tục xếp hàng trong sidecar.

### Bằng chứng

- API runtime trên `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1 @36 DPI, clip
  `0,0,100,100`: HTTP `200`, PNG `100×100`, `3.455` byte, engine `ppe+lcms`, accuracy
  `rip_softproof`, cache miss.
- Artifact trực tiếp @36 DPI full-page: `374×281`, `ppe_degraded=false`,
  `ppe_ink_unsound=false`, không cảnh báo.
- Backend Viewer/cache/màu/PPE/API: `91 passed`, không fail/skip.

## Lô 7a3 — Khóa ownership, cache và hợp đồng profile sau rà chéo

**Trạng thái:** hoàn tất code và regression tự động.

### Frontend

- Namespace Blob cache bỏ cả marker `|revision:*` và `|color:*`, nhưng bitmap key vẫn giữ
  revision; đổi file cùng path không thể lấy ảnh của revision trước.
- Render group mang `pageInstanceId`; hai bản sao của cùng source page không còn hủy lẫn nhau.
- Cache hit chỉ mở metadata pha B sau khi `<img>` đã load/decode đúng generation hiện tại.
- Identity render lấy token do chính `usePdfLoader` của tab sở hữu và truyền qua
  `AcrobatViewer → useTileRenderer`; đường runtime không đọc singleton theo path.

### Backend/PPE

- Owner single-flight đọc lại persistent cache sau khi giành ownership, đóng khe hai request
  cùng key cùng dựng PPE lần hai.
- Lỗi ghi cache do ổ đĩa/antivirus là best-effort; PNG PPE hợp lệ vẫn được trả cho Viewer.
- Validator cache kiểm IHDR/IDAT/thứ tự chunk/CRC/IEND cuối file, không nhận file cắt dở chỉ
  vì có chữ ký PNG.
- SoftProof truyền registry ID (`swop`, `fogra39`...) vào PPE, không suy ID từ stem tên file
  như `USWebCoatedSWOP.icc → uswebcoatedswop`.

### Bằng chứng cuối

- Frontend: typecheck đạt; `11/11` suite, `94/94` test Viewer/cache/coordinator/scheduler/
  loader/viewport/Flipbook đạt.
- Backend: `91/91` test Viewer accurate, ICC/color, PPE facade/routing/overprint và API đạt.
- `print_engine`: `575/575` unit/integration/doc test đạt.
- `native`: `cargo check --lib` đạt; `maturin develop --release` đã cài đúng extension mới.
- `git diff --check` toàn bộ tracked worktree đạt.

## Benchmark sau khi dựng lại native

Cùng harness trước/sau, trang 1 @192 DPI; mỗi lượt chạy một process Python mới nên số đo gồm
startup/import, nhưng hai phía vẫn so được trên cùng điều kiện.

| Chế độ | Trước | Sau rebuild | Thay đổi |
|---|---:|---:|---:|
| Viewport `1024×768`, trung vị 3 lượt | `2.208 ms` | `1.638,6 ms` | nhanh hơn `25,8%` |
| Full-page, 1 lượt | `4.194 ms` | `4.267,5 ms` | chậm hơn `1,8%`; chưa đủ mẫu để kết luận |

Ba lượt viewport mới là `1.705,4 / 1.638,5 / 1.638,6 ms`. Trên lần đo hiện tại, viewport
dùng ít thời gian hơn full-page `61,6%`. Đây là cải thiện đúng đường zoom đang nhìn, không phải
bằng chứng rằng mọi trang/full-page đều nhanh hơn.

## Giới hạn còn lại sau Lô 7a

- Stroke AA giữa hai tile chồng lấn chưa byte-identical vì CTM cuối vẫn là `f32`; regression
  khóa ở `max 12/255`, `mean ≤ 0,012`, tối đa `24` mẫu khác. Fill đặc vẫn khớp chính xác.
- Chỉ XObject hoàn toàn ngoài viewport được bỏ decode. Ảnh giao viewport vẫn phải giải mã toàn
  codec; mỗi tile PPE hiện vẫn mở lại PDF, chưa có document worker PPE dài hạn.
- Chưa đo P50/P95 `zoom-stop → sharp`, peak RSS và cancel trên máy vật lý `<8 / 8–15 / ≥16 GB`.
- Chưa điều khiển được zoom/pan trực tiếp trong cửa sổ Tauri và chưa build/smoke installer từ
  source hiện tại. Vì PrynX đang mở và khóa `pdfium.dll`, lần chạy lại cuối của Tauri Rust suite
  bị chặn ở build script; mốc gần nhất của chính lô worker vẫn là `114 passed, 4 ignored`.
- `§RENDER.1–10` đã có bản sửa và bằng chứng tự động/artifact tương ứng; `§RENDER.11` vẫn mở
  cho tới khi build sạch và smoke bản cài đặt. Chưa được gọi là ngang Acrobat ở runtime trước
  khi qua hai cổng này.

## Hotfix F1 — không phát khung hình sai màu lúc vừa mở file (`§RENDER.F1`)

**Ngày:** 2026-08-09  
**Nguồn:** feedback trực tiếp trên `CMNM2026 - Giay moi_BLUE - in.pdf`: khung hình đầu có dải
gradient gãy và màu khác, vài giây sau mới đổi sang ảnh PPE đúng.

### Nguyên nhân gốc

- Bootstrap cũ mount Viewer trước khi có `colorRisk`; PDFium display vì vậy được phép xuất hiện.
- Detector màu chỉ chạy sau khi bitmap đầu tiên đã decode. Khi kết quả về, component còn chủ động
  chạy chuỗi `display → accurate` và giữ ảnh display cũ trong DOM trong lúc PPE đang chờ.
- Ở zoom cao, full-page PPE và viewport PPE có thể cùng khởi động rồi hủy/tranh nhau, làm thời gian
  tới ảnh đúng kéo dài thêm.

### Bản sửa

- Bootstrap worker/Tauri trả `colorRisk` trước khi frontend mount trang. Nếu binary cũ hoặc response
  thiếu trường này, loader fail-closed bằng metadata đầy đủ thay vì phát PDFium tạm.
- Trang được đánh dấu rủi ro chỉ yêu cầu stage `accurate`; không còn stage PDFium display ở cold-open.
- Key của full-page tile mang pipeline màu để ảnh display cũ bị unmount khi policy đổi.
- Ở zoom cao, viewport PPE là đường hiển thị duy nhất của trang active; không khởi động thêm full-page
  PPE để rồi hủy. Lỗi PPE cũng không được rơi về PDFium sai màu.
- Thêm regression component khóa cả cold-open đang chờ PPE và cache-hit PPE.

### Bằng chứng sau sửa

- Frontend typecheck: đạt.
- Viewer/cache/coordinator/scheduler/loader/viewport/Flipbook: **12/12 suite, 98/98 test đạt**.
- Tauri Rust `cargo check --lib`: đạt trong target tách biệt; target mặc định bị app đang mở giữ
  `pdfium.dll`, không đóng cưỡng bức phiên của người dùng.
- Probe protocol trực tiếp trên display worker hiện hành với đúng PDF khách: bootstrap **45 ms**,
  `colorRisk` có mặt trước render, `4/4` trang là `highRisk` và `accurateColorRecommended=true`;
  các lý do gồm `device_cmyk`, `device_n`, `separation`, `transparency` và thiếu output intent.

### Hành vi chủ đích và giới hạn xác minh

- Cold-open của trang rủi ro có thể hiện trạng thái “Đang dựng hình” trong lúc PPE chuẩn bị; không còn
  đánh đổi bằng cách cho người dùng thấy một thiết kế sai rồi đổi màu sau đó.
- Chưa điều khiển lại chính thao tác mở file trong cửa sổ Tauri từ phiên agent này, nên chưa tuyên bố
  smoke UI hay ngang Acrobat. Cần mở lại file mẫu trên app đã rebuild để đóng cổng runtime cuối.

## Hotfix F2 — giữ chữ nét khi giảm zoom (`§ZOOM.F2`)

**Ngày:** 2026-08-09  
**Nguồn:** feedback runtime: zoom lớn đã nét, giảm rất ít lại rơi về ảnh mờ và chờ PPE dựng lại.

### Bằng chứng và nguyên nhân gốc

- Trên đúng PDF khách, trang 1 có khổ `748,346 × 561,26 pt` (`997,795 × 748,347 px@100%`).
- Ở zoom `6,33`, viewport tile là `612 DPI`, clip `[2304,1536,1792,1536]`. Giảm chỉ còn
  `6,32`, policy cũ unmount tile đang nét rồi yêu cầu full-page `588 DPI` khoảng
  `6111 × 4584` — gần **28 triệu pixel**.
- Với `8,0 → 7,9`, cả hai cùng `768 DPI`, cùng raster `7982 × 5987` và cùng clip
  `[3072,2304,1792,1536]`; backend key thực tế giống nhau nhưng frontend vẫn tạo generation/cache
  key mới từ raw zoom và ẩn tile trong 90 ms settle.
- Reducer double-buffer cũ còn chủ động xóa `visible` khi buffer group zoom đổi. Đây là lỗi
  compositor/cache frontend; engine PPE đã có bitmap đủ nét nhưng UI bỏ nó quá sớm.

### Bản sửa theo hai lô frontend

1. **Identity và double-buffer**
   - Request accurate được chuẩn hóa bằng `DPI bucket / 96`; cùng DPI + clip dùng chung
     generation/cache identity.
   - Tách `reuseGroup` ổn định theo file revision, trang, pipeline màu và rotation.
   - Tile đã decode tiếp tục hiển thị trong live zoom và khi target mới chờ; rect được scale theo
     khổ trang sống. Đổi file/pipeline/rotation vẫn fail-closed, không tái dùng chéo.
2. **Bỏ chuyển pipeline nặng ở ngưỡng zoom**
   - Trang accurate active giữ viewport pipeline xuyên mọi mức zoom, không còn nhảy
     `viewport 612 DPI → full-page 588 DPI/28 MP` tại `6,33 → 6,32`.
   - Lần đo viewport đầu tiên chạy đồng bộ, không phụ thuộc rAF của WebView2 khi bị occluded.
   - Full-page accurate còn dùng cho frame nền; request của nó cũng được neo theo DPI bucket.

### Bằng chứng sau sửa

- Baseline regression trước sửa: **2 test đỏ** — visible tile bị xóa và presentation trả rỗng.
- Sau sửa: frontend typecheck đạt; **12/12 suite, 106/106 test Viewer đạt**.
- Regression khóa các ca: cùng DPI bucket không đổi identity; zoom-out giữ tile A khi D đang tải;
  đổi rotation không tái dùng; settle không ẩn tile; `6,33 → 6,32` accurate không đổi sang full-page;
  cold-open màu rủi ro vẫn không phát PDFium display.

### Giới hạn xác minh

- Chưa thao tác lại bằng chuột trong chính cửa sổ Tauri từ phiên agent; mức bằng chứng hiện tại là
  code + regression tự động + số đo policy trên PDF khách. Phải smoke lại chuỗi zoom thật trước khi
  đóng cổng runtime.
- Khi giảm qua một DPI bucket lớn hơn, tile cũ vẫn được giữ nên không mờ; target mới chỉ dựng nếu
  clip/raster thực sự đổi. Tối ưu bỏ hẳn target khi tile cũ bao trọn viewport có thể làm tiếp sau khi
  có log P50/P95 runtime, không cần cho hotfix chống rơi về ảnh mờ này.

## Nghiệm thu runtime Tauri dev — 2026-08-10 (đã hiệu chỉnh Lô 6)

Đợt này chạy trực tiếp chuỗi người dùng trên đúng PDF khách, không suy từ test DOM.
Báo cáo máy đọc được nằm tại:

- `.tmp/runtime-smoke/tauri-runtime-smoke-report.json`;
- `.tmp/runtime-smoke/cold-warm-open-report.json`.

### Hiệu chỉnh bằng chứng

Claim cũ `1.909/1.944 ms` bị thu hồi: raw JSON dùng **ms** (`1909/1944`), nhưng
hai ảnh được gọi là “sharp” chưa chứng minh compositor có pixel nội dung. Harness
mới chụp vùng trang thật, đo range/variance/màu, yêu cầu hai frame pixel cùng chữ
ký liên tiếp và ghi rõ `timingUnit = ms`. Timeout bắt buộc làm smoke thất bại; không
còn nhánh nuốt timeout rồi vẫn ghi `identityChanged=false`.

### Viewer — lượt đo lại hợp lệ 2026-08-10

| Thao tác | Kết quả runtime |
|---|---:|
| Cold open: pixel nội dung đầu tiên | `4.175 ms` (`4,175 giây`) |
| Cold open: sắc + 2 frame compositor ổn định | `4.670 ms` (`4,670 giây`) |
| Warm reopen: pixel nội dung đầu tiên | `3.971 ms` (`3,971 giây`) |
| Warm reopen: sắc + 2 frame compositor ổn định | `4.402 ms` (`4,402 giây`) |
| Chữ ký pixel cold/warm | cùng `5aee9a8d` |
| HTTP/console error | `0 / 0` |

Lượt đo chạy trong phiên dev đã tích lũy `10` process `pdf-inspector`, `13` process
Node và `3` process Python, nên chỉ là bằng chứng pixel hợp lệ của **phiên hiện tại**,
không phải P50/P95 sạch. Các số lăn/zoom/pan/xoay cũ mới dựa trên DOM/tile signature;
chúng được hạ xuống `STALE` cho tới khi chạy lại bằng pixel gate hai frame mới.

### Output Preview dùng chung Viewer

- Claim cũ `1.926/3.947 ms` thực chất là `1926/3947 ms`; không còn được dùng như
  số dưới một frame.
- Smoke `42/42` cũ bị hạ khỏi acceptance: Background lấy signature **sau** thao tác
  rồi chờ một thay đổi thứ hai, timeout 40 giây lại bị nuốt; Show filter khi đó cũng
  chưa lọc sampling/TAC/subset.
- Harness mới lấy signature trước action, bắt pixel đổi và chờ hai compositor frame.
  Source Lô 4–5 đã có regression cho filtered plate/document identity. Full runtime
  mới chưa chạy vì binding native cần rebuild dev, trong khi lượt này được chốt
  **không maturin/build**.

### Regression cuối sau runtime

- TypeScript typecheck: đạt.
- Frontend Viewer/Output Preview tập trung: `15 file / 148 passed`.
- Backend ICC/PPE/session/cache/API/cleanup tập trung: `9 file / 182 passed`.
- PPE Rust cho Show/Paper/Black/Background: `9/9` test tập trung đạt.

### Trạng thái cổng

- `W7-U04` hiện là `RUNTIME-PARTIAL`: cold/warm có pixel thật; lăn/zoom/pan/xoay
  chờ chạy lại bằng harness mới.
- `W7-U05` giữ `AUTO + ARTIFACT`; runtime `42/42` cũ không còn đóng cổng.
- Các mốc trên là một lượt đo trên máy audit, chưa phải P50/P95 nhiều vòng hoặc
  benchmark vật lý đủ ba tier RAM `<8 / 8–15 / ≥16 GB`.
- Theo chỉ đạo “chưa cần build”, không tạo installer và không smoke clean-user.
  Do đó `§RENDER.11` vẫn mở và chưa được phép suy thành
  `RUNTIME (installed/release)` hay chứng nhận ngang Acrobat trên mọi môi trường.

## Turbo A/B — ưu tiên viewport và atlas thích nghi phần cứng (`§PAN.TURBO`)

**Ngày:** 2026-08-11
**Nguồn:** feedback runtime: pan đã liền mạch hơn nhưng thời gian tới cell nét vẫn còn dài.

### Baseline và nguyên nhân

- Log thật trên `CMNM2026 - Giay moi_BLUE - in.pdf` cho thấy atlas `816 DPI` phát hàng loạt
  cell trước/cùng lúc nền accurate `144 DPI`; `sem_wait` của cell sau tăng tới **1.623 ms**,
  trong khi `worker_queue_ms` gần 0. Nút thắt là tranh quota raster, không phải React/IPC.
- JSX cũ mount atlas trước target viewport. Accurate worker đi thẳng coordinator native nên
  background có thể chiếm lane trước khi request priority 0 được phát.
- Toàn bộ runway được mount một pha; mở file cũng cho atlas DPI cao tranh tài nguyên với frame
  PPE đầu tiên. Mỗi lần pan vẫn luôn tạo bitmap viewport nguyên khung dù atlas đã có đủ cell nét.

### Turbo A

1. Target viewport được mount/phát trước atlas; atlas DPI cao chờ base PPE đầu tiên commit.
   Nếu vào thẳng zoom cao và không có base PPE, target priority 0 tự làm frame accurate đầu tiên,
   không chờ một cổng sẽ không bao giờ mở.
2. Atlas chia hai pha: cell giao viewport trước, vòng ngoài chỉ mở sau khi target viewport decode.
3. Ready key chỉ sống trong đúng raster bucket và chỉ giữ cho grid đang mounted.
4. Hợp hình chữ nhật của cell ready được kiểm theo từng lát X. Chỉ khi phủ kín viewport mới bỏ
   target nguyên khung; thiếu một cell hoặc có khe thì vẫn render tương tác, không báo phủ giả.
5. Atlas nằm trên target theo thứ tự compositor, nên cell nét đã có được tái dùng trực tiếp khi pan.

### Turbo B — benchmark cell PPE thật @600 DPI

PDF: `CMNM2026 - Giay moi_BLUE - in.pdf`, trang `6.236 × 4.677 px`, viewport mô phỏng
`1.920 × 1.080 px`. Pool máy audit: `32 GB / 16 logical CPU / 7 background worker`.

| Cell | Cold phủ kín | Warm first-ready median | Warm phủ kín median / P95 | Pixel raster median |
|---:|---:|---:|---:|---:|
| 512 | **1.177 ms** | **264 ms** | **749 / 840 ms** | **3,932 MP** |
| 640 | 1.222 ms | 389 ms | 846 / 984 ms | 4,915 MP |
| 768 | 1.387 ms | 460 ms | 791 / 1.047 ms | 4,719 MP |

Mô phỏng máy hạn chế bằng đúng một background worker:

| Cell | Cold phủ kín | Warm first-ready median | Warm phủ kín median / P95 |
|---:|---:|---:|---:|
| 512 | 3.070 ms | **176 ms** | 2.853 / 3.530 ms |
| 640 | 3.478 ms | 274 ms | 3.367 / 3.751 ms |
| 768 | **2.895 ms** | 207 ms | **1.806 / 2.580 ms** |

Quyết định theo số đo:

- `≥16 GB`/tier full dùng cell **512 px** để tận dụng nhiều lane: first-ready nhanh hơn khoảng
  **43%** so với 768 px và P95 phủ kín giảm khoảng **20%**.
- `<16 GB` dùng **768 px** để giảm số lượt tuần tự; máy yếu không bị cấu hình nhiều-cell của máy mạnh.
- 640 px không thắng ở tier nào nên không đưa vào policy sản phẩm.

### Bằng chứng tự động và giới hạn

- Test đỏ mới: thiếu hàm tách pha/coverage, policy cell, phase target, cleanup unmount và
  direct high-zoom làm đúng `7` ca thất bại.
- Sau sửa: `viewportTilePolicy + LiveTile + useTileRenderer` đạt **73/73 test**;
  ma trận Viewer rộng đạt **127/127**; toàn frontend với 4 test worker đạt
  **2.222 pass, 2 skip**.
- Lượt full mặc định từng timeout ngẫu nhiên ở Logo/Output Preview/Office dưới tải song song;
  chạy riêng các file đó đạt `29/29` và `13/13`, không có diff ở các module này từ Turbo.
- TypeScript toàn frontend: đạt.
- Benchmark gọi trực tiếp PPE worker hiện hành, không build lại app và không dùng renderer khác.
- Chưa chạy lại thao tác pan bằng chuột với pixel gate hai frame sau Turbo A; vì vậy kết luận hiện
  là `AUTO + BENCH`, chưa nâng thành `RUNTIME UI` hay `installed/release`.

### Hotfix đường nối atlas (`§PAN.SEAM`)

**Nguồn:** ảnh runtime ngày 2026-08-11 cho thấy một vệt sáng dọc và một vệt sáng ngang xuất hiện
tạm thời đúng tại ranh giới cell atlas trên vùng nền xanh, rồi mất khi bitmap viewport nguyên khung
hoàn tất.

Nguyên nhân trong frontend gồm hai phần cùng khuếch đại nhau:

1. `LiveTile.applyExactFit()` cho phép bitmap co về `naturalWidth / devicePixelRatio` khi chênh
   tối đa hai pixel. Quy tắc này vốn dùng cho tile toàn trang trắng; với cell nằm giữa mảng màu,
   phần khung còn thiếu làm lộ `background: white` thành đường sáng.
2. WebView2 có thể làm tròn hai bitmap kề nhau thành hai quad compositor khác nhau ở scale phân số,
   nên ngay cả hai rect khớp toán học vẫn có khả năng lộ khe dưới một pixel.

Bản sửa chỉ áp dụng cho atlas:

- cell luôn fill 100% khung và dùng nền trong suốt, không đi qua nhánh co ảnh 1:1 của tile toàn trang;
- rect trình bày nới cạnh phải/dưới đúng một device pixel ở cạnh nội bộ, chặn tuyệt đối tại mép trang;
- clip raster, DPI, kích thước bitmap, key cache và coverage logic giữ nguyên, nên không phát thêm
  request PPE và không tăng số pixel raster.

Bằng chứng tự động:

- Trước sửa: đúng `5` ca đỏ — bốn góc xoay chưa có rect seam-safe và LiveTile atlas co `512 px`
  thành `256 px` trong khung `256,25 px`.
- Sau sửa: policy + LiveTile đạt **49/49**; ma trận `workspace + hooks/viewer` đạt **249/249**;
  toàn frontend đạt **2.229 pass, 2 skip**; TypeScript toàn frontend đạt.
- Runtime đúng chuỗi thao tác của user vẫn cần nghiệm thu trong Tauri; chưa suy từ test DOM thành
  kết luận đường nối đã biến mất trên mọi mức zoom/DPI màn hình.

### Hotfix độ nét toàn trang (`§VIEW.SHARP`)

**Nguồn:** hai ảnh so sánh PrynX/Acrobat ngày 2026-08-11 trên `Binder162.pdf` và ca tái hiện
Tauri dev bằng chính file đó.

Baseline đã đo:

- Trang nhìn thấy rộng `417,037 pt`, là ảnh JPEG CMYK `3.508 × 2.480 px`; detector đánh dấu
  `highRisk=true` do `DeviceCMYK` và thiếu Output Intent.
- PPE trực tiếp ở `192 DPI` tạo bitmap `1.112 × 388 px`. Bitmap nguồn có phương sai Laplacian
  `3.023`, gần ảnh Acrobat `2.544` sau chuẩn hóa; vì vậy engine đã tạo đủ chi tiết.
- Tauri trước sửa hiển thị đúng bitmap `1.112 × 388` trong rect `1.112 × 388`, nhưng gốc rect là
  `(223,453; 395,477)`. WebView2 nội suy bitmap 1:1 vì cả hai trục gần nửa pixel; ảnh compositor
  chỉ còn phương sai Laplacian `824`, khớp ảnh user `757` và thấp hơn Acrobat khoảng ba lần.

Kết luận ở vòng này chỉ đúng cho một phần compositor: bố cục flex căn giữa làm gốc mặt trang
rơi giữa device pixel. Feedback runtime tiếp theo xác nhận vẫn còn một nguồn mờ độc lập trong
vòng đời surface PPE; vì vậy không còn coi lệch nửa pixel là nguyên nhân duy nhất.

Bản sửa:

- Tính offset ổn định từ tọa độ layout thật và `devicePixelRatio`, rồi dịch mặt trang active tối đa
  nửa device pixel để gốc bitmap nằm đúng lưới pixel vật lý.
- Đo chính inner page đã xoay thay vì khung ngoài, nên bitmap và mọi overlay cùng dịch một lượng;
  hit-test tiếp tục đọc `getBoundingClientRect()` sau dịch chuyển.
- Resize/đổi zoom cập nhật theo `requestAnimationFrame`; khi cuộn chỉ snap sau `48 ms` dừng tay,
  tránh nhún trong lúc trang đang chuyển động như Acrobat.
- Không đổi DPI, clip, cache key, số request, số worker hay số pixel raster.

Bằng chứng hiện có:

- Trước sửa: đúng `3` ca policy đỏ vì chưa có hàm device-pixel snap; sau sửa policy + LiveTile
  đạt **52/52**, ma trận `workspace + hooks/viewer` đạt **252/252**, toàn frontend đạt
  **2.232 pass, 2 skip**, TypeScript đạt.
- Tauri sau sửa đưa target từ `(223,453; 395,477)` về `(223; 394,992)`; sai số còn `0,008 px`
  là lượng tử layout `1/64 px` của Chromium, không còn offset gần nửa pixel.
- Cửa sổ dev do agent khởi chạy ở trạng thái occluded sau HMR nên screenshot compositor sau sửa
  chỉ thu nền; không dùng ảnh đó làm acceptance. Cần nghiệm thu mắt thật trên cửa sổ Tauri của user
  trước khi nâng trạng thái từ `AUTO + RUNTIME-GEOMETRY` lên `RUNTIME UI`.

### Hotfix surface nét ổn định (`§VIEW.SURFACE`)

**Nguồn:** feedback runtime tiếp theo ngày 2026-08-11: Acrobat giữ một bề mặt nét ổn định,
trong khi PrynX tiếp tục đổi qua lại `mờ → nét` dù lỗi lệch nửa pixel đã được xử lý.

Baseline mới đã đo từ `PrynX_RenderPerf.log` trên ca toàn trang `Binder162.pdf`:

- cùng một frame phát một full-page PPE `144 DPI`, sau đó phát bốn tile `204 DPI`;
- trang đích chỉ khoảng `1.112 × 388 px`, nên việc chia hai cấp chất lượng không tiết kiệm
  raster có ý nghĩa nhưng buộc người dùng nhìn thấy nền thấp DPI trước khi tile phủ xong;
- khi scale giảm, `LiveTile` đổi generation và đặt lại quality rank về 0, vì vậy surface nét hơn
  vẫn có thể bị thay bằng request DPI thấp mới;
- viewport cũ bị unmount ngay khi qua ngưỡng tiling và PPE dùng crossfade tối đa `160 ms`, làm
  lộ nền mềm hoặc một pha hòa trộn mềm giữa hai surface đã decode.

Bản sửa:

1. Khi footprint toàn trang nằm trọn trong viewport và renderer full-page theo kịp mật độ màn
   hình, dựng thẳng một surface PPE ở scale đích; không dựng nền 144 DPI rồi phủ atlas lên.
2. `LiveTile` giữ bitmap cùng identity có scale/color-rank cao hơn khi scale yêu cầu giảm; chỉ co
   surface đã decode bằng compositor và không phát request PPE hạ DPI.
3. Khi chuyển từ tile về full-page, giữ viewport nét cũ tới khi surface toàn trang mới báo ready.
4. Surface PPE mới chỉ thay thế sau decode và swap nguyên tử (`0 ms`); crossfade vẫn giữ nguyên
   cho compatibility lane không-accurate.
5. Không thêm hard-cap, worker, cache budget hay giảm chất lượng theo máy. Ca toàn trang chỉ dựng
   xấp xỉ số pixel của viewport; zoom lớn/footprint tràn khung vẫn dùng viewport tile hiện hành.

Bằng chứng tự động:

- Trước sửa: đúng `4` ca đỏ — direct full-page chưa tồn tại, viewport bị rút sớm, PPE còn
  crossfade và zoom-down phát lại request DPI thấp.
- Sau sửa: policy + LiveTile đạt **31/31**; ma trận `workspace + hooks/viewer` đạt **256/256**;
  toàn frontend đạt **2.236 pass, 2 skip**; TypeScript toàn frontend đạt.
- Runtime sau HMR vẫn chờ thao tác mở lại đúng file của user để xác nhận log không còn cặp
  `144 DPI + 204 DPI`; trạng thái hiện tại là `AUTO`, chưa nâng thành `RUNTIME UI`.
