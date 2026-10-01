# Báo cáo audit mở file, load trang và load view

**Ngày:** 2026-10-01  
**Phạm vi:** `desktop/` (React/Tauri), `desktop/src-tauri/` (Rust/PDFium/worker), các đường backend có thể chặn viewer.  
**Mục tiêu:** tìm trần hiệu năng khi mở PDF từ nặng đến nhẹ, hiển thị trang đầu, chuyển trang, zoom và tải view; xác định chỗ có thể nâng trần mà vẫn giữ quy tắc RAM-gating và bất biến PDFium.

## 1. Kết luận điều hành

Viewer chưa chạm trần phần cứng ở mọi tầng. Nút thắt lớn nhất hiện nay là **hàng đợi và tranh chấp**, sau đó mới đến chi phí raster/encode:

1. Có log chẩn đoán cho thấy worker chỉ mất khoảng 90 ms nhưng request chờ khoảng 82 giây trước khi pixel được giao cho UI. Đây là dấu hiệu starvation hoặc lifecycle của hàng đợi, không phải PDFium raster chậm tương ứng.
2. Scheduler tile phía frontend là singleton với 2 slot, trong đó chỉ còn 1 slot cho lane nền. Khi người dùng đổi trang/zoom hoặc chuyển tab, tác vụ cũ có thể đã bị hủy ở phía gọi nhưng vẫn giữ slot vật lý đến khi native trả về.
3. Native PDFium vẫn có `RENDER_LOCK` tuần tự trong mỗi process. Tăng số request mà không tách lane tương tác sẽ làm hàng đợi dài hơn.
4. Máy từ 16 GB trở lên vẫn bị giới hạn worker nền bởi `RAM / 4 GiB`; ví dụ 16 GB/16 CPU chỉ có 4 lane nền thay vì CPU-1. Đây là trần cần đo và điều chỉnh theo áp lực bộ nhớ, không nên tăng mù.
5. Nhánh PDF.js/in-memory có tài liệu không quá 100 trang vẫn gọi `getPage()` cho mọi trang rồi mới `markReady()`. Với PDF nặng, page 1 có thể chờ việc đọc metadata của toàn bộ tài liệu.
6. Cache trang decoded chỉ giữ tối đa 24 trang ngay cả trên máy 16/64 GB. Đây là trần cố định có thể gây raster lại khi người dùng lướt xa rồi quay lại.

Hiện chưa sửa mã nguồn. Báo cáo này là chốt bằng chứng để duyệt lô sửa đầu tiên.

## 2. Bằng chứng chính

### 2.1. Mở file và page đầu

| Mã | Mức | Vị trí | Bằng chứng | Ảnh hưởng |
|---|---|---|---|---|
| OPEN-01 | P1 | `desktop/src/hooks/viewer/usePdfLoader.ts:693-731` | Native gọi `get_pdf_viewer_bootstrap`; nếu response thiếu `colorRisk` thì gọi `loadFullMetadata()` trước khi mount page. | Release/legacy artifact thiếu risk summary sẽ chặn first pixel bằng metadata đầy đủ. Cần đo tỷ lệ nhánh này và giữ fail-closed màu. |
| OPEN-02 | P1 | `usePdfLoader.ts:653-665,753-763` | Bootstrap backend chủ yếu có khổ trang 1, nhưng frontend dựng `allPageDims` cho toàn bộ `numPages` ngay lần đầu. | File hàng nghìn trang tạo nhiều entry và commit React trước khi view ổn định. Nên materialize trang đang xem/lân cận rồi hydrate theo batch. |
| OPEN-03 | P1 | `usePdfLoader.ts:926-955` | Nhánh PDF.js với `doc.numPages <= 100` gọi `getPage()` mọi trang và `await Promise.all()` trước `markReady()`. | 100 trang scan/vector nặng có burst parse trước page 1. Áp dụng page-1-first như tài liệu dài. |
| OPEN-04 | P1 | `desktop/src-tauri/src/lib.rs:3043-3130,3157-3248` | Cache miss đọc toàn PDF vào `Vec`, quét `/UserUnit`, có thể parse `lopdf`, rồi mở PDFium từ buffer; bytes và handle được giữ trong cache. | File lớn có peak I/O/copy/RAM trước first pixel. Cần đo working set và cân nhắc đọc/lazy object store ở lô riêng. |
| OPEN-05 | P2 | `desktop/src/hooks/useIncomingFileDispatcher.ts:54-58`, `usePdfLoader.ts:693-700` | Prime first frame và loader đều có thể gọi bootstrap; backend có singleflight nhưng chưa có metric adoption/cache-hit. | Có thể phát sinh IPC/identity check trùng; không kết luận là trùng raster khi chưa đo. |

### 2.2. Hàng đợi và render tile

| Mã | Mức | Vị trí | Bằng chứng | Ảnh hưởng |
|---|---|---|---|---|
| QUEUE-01 | P0/P1 | `.tmp/render-diagnostics/PrynX_RenderPerf.log`; coordinator trace | Một request có `queue_ms` khoảng 82.191 s, `native_to_decode_ms` khoảng 82.317 s, trong khi worker core khoảng 90 ms và decode khoảng 1 ms. | Người dùng thấy mở trang/zoom bị treo dù native đã render xong. Đây là lỗi cần ưu tiên xác minh bằng trace hiện hành. |
| QUEUE-02 | P1 | `desktop/src/hooks/viewer/tileRenderScheduler.ts:74-98,218-287,323-324` | Singleton `TileRenderScheduler(2)`; lane nền mặc định còn 1. `cancelOwner()` kết thúc promise nhưng tác vụ vật lý giữ `activeCount` đến `finally`. | Tác vụ stale sau zoom/đổi trang có thể chiếm slot. Tăng số slot đơn thuần có thể làm peak RAM và cạnh tranh PDFium tăng. |
| QUEUE-03 | P1 | `desktop/src-tauri/src/lib.rs:2688-2695,4236-4520` | `RENDER_LOCK` tuần tự hóa mọi raster PDFium trong process; tile miss còn encode và ghi PNG đồng bộ sau raster. | Nhiều tile cùng lúc có thể xếp hàng dù CPU còn rảnh; tile trùng key có nguy cơ raster lặp vì chưa có core in-flight singleflight. |
| QUEUE-04 | P1 | `desktop/src-tauri/src/pdf_engine/render_worker.rs:419-434,477-482` | Worker nền trên >=16 GB dùng `min(CPU-1, total_ram/4 GiB)`. Test hiện xác nhận 16 GB/16 CPU = 4 lane, 64 GB/8 CPU = 7 lane. | Máy mạnh chưa được khai thác hết; đây là trần hợp lệ để nâng sau khi có số đo RSS/worker và pressure backoff. |
| QUEUE-05 | P1 | `useTileRenderer.ts:749+`, `renderCoordinator.ts:311-384` | PPE/accurate bypass scheduler JS nhưng vẫn chờ semaphore native; log PPE có `sem_wait_ms` khoảng 1.3–1.9 s ở các lượt nhiều request. | Tăng worker mà không dành capacity cho active page sẽ làm accurate view chậm hơn dưới tải. |
| QUEUE-06 | P1 | `desktop/src/hooks/viewer/useTileRenderer.ts:671-700`; `ThumbSidebar.tsx:385-389`; `viewerFirstFrame.ts:249-256` | Native tile/thumbnail/prime còn có dynamic import API trong đường nóng. Audit cũ từng thấy import chờ đến khoảng 415 ms; cần đo lại trên artifact hiện tại. | Cold first tile có thể bị trễ bởi IPC bootstrap/chunk, nhưng chưa được coi là số đo hiện hành. |

### 2.3. View, virtualization và cache

| Mã | Mức | Vị trí | Bằng chứng | Ảnh hưởng |
|---|---|---|---|---|
| VIEW-01 | P1 | `desktop/src/components/AcrobatViewer.tsx:2570-2573,3280-3286`; `LivePageFrame.tsx:6566-6630` | Virtuoso overscan tối thiểu 1000 px, thường giữ khoảng 9 page; comment ghi nhận 9x sharp tile requests. Trang inactive trên 200% bị hạ `renderZoom`. | Giữ nhiều page để cuộn mượt nhưng làm queue và PDFium tranh chấp; hạ zoom inactive tạo cảm giác chưa giống Acrobat ở zoom cao. |
| VIEW-02 | P1 | `desktop/src/App.tsx:1628-1731`; `AcrobatViewer.tsx:1462-1475`; `useTileRenderer.ts:566-576` | Tất cả tab vẫn mount; tab nền chỉ suspend LivePageFrame sau khoảng 20 s, còn metadata/text/effect khác vẫn tồn tại. | Mở 3–6 PDF nặng làm tăng RSS và queue age; cần benchmark multi-tab trước khi đổi chính sách suspend. |
| VIEW-03 | P2 | `LivePageFrame.tsx:3427-3450` | Frame có `nativeFilePath` và thiếu `textBlocks` có thể POST `/imposition/pdf-text`; overscan khiến nhiều frame/hide tab chạm đường này. | CPU backend bị dùng cho text không cần thiết trong lúc người dùng đang xem page. |
| VIEW-04 | P2 | `desktop/src-tauri/src/lib.rs:1906-1923,8028-8033` | Page LRU: 6 (<8 GB), 12 (8–16 GB), 24 (>=16 GB). Test giữ 24 cho 16 và 64 GB. | Lướt xa rồi quay lại có thể mở/raster lại page dù máy còn RAM. Cần chuyển sang byte/pressure budget, vẫn giữ tier thấp. |
| VIEW-05 | P2 | `useTileRenderer.ts:689`, `lib.rs:4310-4385` | PXRG raw bypass disk PNG cache; sau restart/reopen tile PXRG phải raster lại. | Warm reopen chưa đạt trải nghiệm Acrobat; cần đo trade-off dung lượng/giải mã trước khi lưu PXRG. |
| VIEW-06 | P2 | `AcrobatViewer.tsx:1615-1619` | Thumbnail warmup tuần tự tối đa 30 thumb, mỗi thumb chờ 10 ms. | Sidebar nhiều trang có thể mở chậm, nhưng không phải nút thắt page chính. |

### 2.4. Backend có khả năng chặn UI

| Mã | Mức | Vị trí | Bằng chứng | Ảnh hưởng |
|---|---|---|---|---|
| BACK-01 | P1 | `backend/app/api/routes/preflight.py:487-556,730+`; `edit.py:932-1008` | Một số `async def` trực tiếp mở pypdfium2/pikepdf, render, encode hoặc đọc hình học thay vì offload executor. | FastAPI event loop có thể bị chặn khi viewer/preflight chạy cùng lúc. Phải đo ping/health p95 dưới tải trước khi sửa. |
| BACK-02 | P2 | `backend/app/core/pdf_processor.py:30-125,130-220,270-315` | `convert_to_images` render toàn bộ trang vào list; metadata mở/đọc toàn tài liệu; text extraction mở pdfplumber lặp lại. | PDF lớn tạo peak RAM và chi phí mở lặp; không nên xử lý bằng thread thêm vì PDFium vẫn cần guard/process. |

## 3. Phạm vi đo bắt buộc trước khi sửa trần

Các số trong log cũ là bằng chứng chẩn đoán, không phải SLA hiện hành. Cần chạy artifact hiện tại trên Windows thật với trace mới.

### Ma trận file

- 1–10 MB, 100 MB ảnh, 500 MB vector/ảnh, và một file 1–2 GB hoặc 5.000 trang nếu có dữ liệu an toàn.
- PDF scan RGB/CMYK, vector nhiều path, `/UserUnit`, mixed-size và file có/không có color risk.
- Native path và PDF.js/in-memory path.

### Ma trận thao tác

- Cold process, warm reopen, đóng/mở lại tab.
- Page 1 first pixel, page switch xa/gần, zoom 100/200/400%, rotation, accurate/PPE adopt.
- Thumbnail bật/tắt; 1, 3 và 6 tab nặng.

### Metric bắt buộc

- `bootstrap_ready`, `page1_first_pixel`, `first_tile_enqueue→invoke`, `invoke→native_ready`, `native_ready→decode`, `decode→paint`, `accurate_adopt`, `all_metadata_ready`.
- `queue_ms`, `sem_wait_ms`, worker queue, PDFium lock wait, số tile/page và số request bị cancel.
- JS heap/WebView RSS, native RSS/commit, số worker/PDFium process, cache bytes/eviction reason.
- Ping/health p95 của backend trong lúc chạy preflight/edit nặng.

## 4. Kế hoạch nâng trần đề xuất (chờ duyệt)

### Lô S0 — đo và chứng minh đường chờ (tối đa 5 file)

Thêm trace phase riêng cho bootstrap → first tile → native → decode → paint, gắn `owner/tab/page/request`, và metric lý do cancel/scheduler age. Không đổi concurrency trong lô này.

**Gate:** có 30 cold + 30 warm lượt cho mỗi tier file; xác định được mọi request có queue >1 s và phân biệt queue JS, semaphore, PDFium lock, decode.

### Lô S1 — mở file page-1-first (tối đa 5 file)

Áp dụng page-1-first cho PDF.js <=100 trang; giảm materialization `allPageDims` lần đầu; chia metadata nền thành batch có hủy theo generation. Giữ màu fail-closed và không thay đổi kết quả hình học.

**Gate:** page1 first-pixel P50/P95 giảm; `all_metadata_ready` có thể đến sau nhưng không làm sai khổ trang; test mixed-size và file hỏng từng trang.

### Lô S2 — hàng đợi active-first (tối đa 5 file)

Tách lane tương tác khỏi prefetch/background, xử lý stale request để không giữ slot lâu hơn cần thiết, và thêm singleflight theo tile key. Không tăng slot toàn cục nếu chưa có RSS/lock evidence.

**Gate:** không còn queue starvation; active page P95 giữ dưới mục tiêu; background bị chậm trước active page; peak RSS không vượt ngân sách tier.

### Lô S3 — nâng trần phần cứng và page cache (tối đa 5 file)

Đổi worker >=16 GB sang pressure-aware CPU budget thay vì `RAM/4 GiB` cố định, mở rộng page LRU theo byte budget/available RAM, và ghi eviction reason. Tier <8 GB và 8–16 GB vẫn giảm theo quy tắc dự án.

**Gate:** benchmark 16/32/64 GB thật, không swap/OOM, throughput tăng ở máy mạnh, máy yếu không regression; cập nhật test Rust theo chính sách mới.

### Lô S4 — giảm copy và warm reopen (sau S0–S3)

Đánh giá disk cache cho PXRG hoặc surface/resource store; tách encode/ghi PNG khỏi vùng PDFium; cân nhắc mmap/lazy read và persistent document/session. Đây là lô lớn, chỉ làm sau khi có số đo memory/IO.

## 5. Quyết định cần duyệt

Đề nghị duyệt **Lô S0 trước**. Sau khi S0 có trace hiện hành, sẽ chốt thứ tự S1/S2/S3 bằng số đo thay vì tăng worker hoặc bỏ cap một cách mù quáng. Các thay đổi nguồn chưa được thực hiện trong lượt audit này.

