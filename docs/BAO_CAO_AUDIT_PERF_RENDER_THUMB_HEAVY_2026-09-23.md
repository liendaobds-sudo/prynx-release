# BÁO CÁO AUDIT HIỆU NĂNG RENDER TRANG, THUMBNAIL VÀ FILE NẶNG — 2026-09-23

Trạng thái: **khảo sát + đề xuất kiến trúc, chưa sửa production; chờ duyệt lô**.

Phạm vi: mở PDF native, first-pixel/first-sharp, zoom/pan, thumbnail, file PDF lớn/bình bế, PPE accurate viewer, và các đường backend xử lý PDF nặng. Audit theo `prynx-architecture`, `prynx-performance`, `prynx-audit-workflow`, `prynx-deep-audit`, `prynx-imposition`, `prynx-testing`.

## 1. Kết luận điều hành

Nguyên nhân chính của cảm giác “đang tải trang” là **chi phí mở/chuẩn bị tài liệu và raster**, không phải spinner, React mount hay `Image.decode`:

```text
file → document/session open → page/resource replay → raster PPE/PDFium
     → PNG/IPC → Blob/ImageBitmap → compositor
```

Bằng chứng runtime trong `%USERPROFILE%\Desktop\PrynX_RenderPerf.log`:

- PPE accurate: `total_ms=7113` ở 152 DPI, `7077` ở 92 DPI và `5432` ở 80 DPI; các lượt này có `sem_wait_ms=0`, `worker_queue_ms=0` — thời gian nằm trong core/session, không nằm ở queue hay DOM.
- Display/thumbnail lịch sử: nhiều lượt có `open_ms=6.7–14.7s` nhưng `pdfium_ms=59–118ms`; cùng log ghi bước chuẩn bị stream lặp lại trước mỗi thumbnail/page. Báo cáo 2026-09-20 đã ghi cụ thể một file 301,916,518 bytes bị nở cấu trúc lên 1,446,479,475 bytes trong 5.5–11.7s.
- Ở một lượt page 4, UI phát `tile-slow` trước khi render hoàn tất; sau đó `RENDER_WORKER_RESULT` cho thấy `queue_ms=16232`, `total_ms=26019`. Đây là chờ/rerender trong worker pipeline, không phải decode ảnh.

Source hiện tại đã có nhiều mitigation đúng: `RenderCoordinator` latest-wins/generation, worker tách process, cache tile RAM/đĩa, page LRU, active-first, cancel/preempt và RAM-gating. Tuy nhiên các mitigation này chưa giải quyết ba nút thắt kiến trúc: **worker không affinity theo tài liệu**, **PPE phải mở/compile lại scene/resource ở nhiều lượt**, và **thumbnail vẫn là đường render riêng**.

Lưu ý provenance: log runtime trải qua nhiều binary/phiên; working tree hiện dirty và `HEAD` là `703ffc2`. Vì vậy số đo log được dùng làm **bằng chứng artifact/runtime lịch sử**, không tuyên bố là P95 của binary hiện tại. Cần một lượt đo sạch trên binary build từ HEAD sau khi user duyệt lô đo.

## 2. Luồng đã trace

### 2.1 Viewer native

`usePdfLoader.ts:683-711` → `get_pdf_viewer_bootstrap` → `desktop/src-tauri/src/lib.rs:3724-3815` → `render_worker::bootstrap_with_policy` hoặc `viewer_bootstrap_in_process` → `build_cached_document` → `LivePageFrame` → `useTileRenderer.getTileUrl` → `RenderCoordinator` → `render_pdf_page`/`render_ppe_page` → worker/PDFium/PPE → PNG → Blob/ImageBitmap → `LiveTile` commit.

### 2.2 Thumbnail

`ThumbSidebar.tsx:172-323` tạo một request `render_pdf_page` cho từng trang native; gate 700ms và `IntersectionObserver` chỉ trì hoãn tải ảnh, không chia sẻ document scene/resource với trang chính.

### 2.3 Backend file nặng

- Compare dùng executor cố định và PDFium guard (`backend/app/api/routes/compare.py:41-45,309`); whole-machine kinds dùng một gate (`backend/app/core/heavy_job_scheduler.py:75-116`). Đây là chính sách an toàn, nhưng không tạo thêm throughput cho PDFium.
- Export ảnh render/ghi từng trang tuần tự (`backend/app/api/routes/export.py:512,677`) và chỉ tách khỏi event loop qua scheduler.
- Viewer accurate HTTP dùng session/cache PPE (`backend/app/api/routes/preflight.py:1683-1885`), nhưng đường native FOGRA39 vẫn là đường ưu tiên; không được tối ưu bằng cách hạ DPI vô điều kiện.

## 3. Findings chính

### §R23.01 — `[CONFIRMED]` P1 / L — Raster/session là nút thắt first-pixel trên file nặng

Bằng chứng runtime: PPE 92 DPI vẫn có lượt 7.077s; 80 DPI 5.432s; `sem_wait=0`, `worker_queue=0`. `useTileRenderer.ts:619-660` gọi `render_ppe_page`; worker gọi session PPE mutable, sau đó encode PNG. `LivePageFrame.tsx:850-1030` chỉ commit sau khi bytes/decode sẵn.

Kết luận: giảm spinner, debounce hoặc đổi cách setState không chữa được ca này. Cần giảm chi phí mở/compile/resource replay và giữ frame cũ trong lúc frame mới đang dựng.

### §R23.02 — `[CONFIRMED]` P1 / L — Worker process không có document affinity; cache tài liệu bị nhân bản

`render_worker.rs:2569-2591,2660-2916` có interactive worker và nhiều background worker; mỗi process có `DOC_CACHE` riêng (`render_worker.rs:3084`). `lib.rs:2008,3005-3043` giữ document/page LRU trong process hiện tại, không chia sẻ giữa worker.

Hệ quả: page chính, thumbnail và prefetch của cùng một PDF có thể đi vào các process khác nhau; mỗi process lại đọc/parse/load document và làm nóng page/resource cache riêng. Log lịch sử cho thấy `open_ms` 6.7–14.7s trong khi `pdfium_ms` chỉ vài chục–trăm ms — đúng dấu hiệu cache/session warm chưa được tái sử dụng.

### §R23.03 — `[CONFIRMED, điều kiện]` P1 / S — First-pixel có thể bị chặn bởi full metadata

`usePdfLoader.ts:683-711`: nếu bootstrap không có `colorRisk`, loader gọi `loadFullMetadata(expectedIdentity)` trước khi mount page (`:711`), còn `markReady()` chỉ sau bootstrap/metadata (`:803`). Runtime mới có `has_color_risk=true` nên ca đó không bị chặn; nhưng binary cũ, fallback bootstrap hoặc file khiến risk scan không trả được sẽ quay lại đường chậm.

Đây là contract fail-closed màu có chủ đích, không được xoá thẳng. Cần tách PageShell/geometry tối thiểu khỏi metadata nền và mang `soundness` trên frame.

### §R23.04 — `[CONFIRMED]` P1/P2 / M — Thumbnail là pipeline PDFium riêng và có thể tranh lane

`ThumbSidebar.tsx:227-323` gọi `render_pdf_page` trực tiếp, tạo Blob URL riêng, priority background. Gate 700ms (`:482-500`) chỉ trì hoãn; không dùng chung `ViewerDocumentSession`, scene hoặc image/resource cache. Runtime lịch sử có các request `thumb-*` đi qua cùng open/prepare path và chậm nhiều giây khi cache lạnh.

### §R23.05 — `[CONFIRMED]` P2 / M — Sidebar thumbnail chưa virtualize DOM

`ThumbSidebar.tsx:755` dùng `pageOrder.map(...)` để mount mọi item; `IntersectionObserver` chỉ quyết định `isLoadable`, không giảm số node, layout và handler. Với tài liệu hàng trăm/hàng nghìn trang, chi phí DOM/React tăng dù chỉ 12 thumbnail đầu được tải ảnh. Đây là bottleneck UI độc lập với PDFium.

### §R23.06 — `[CONFIRMED]` P2 / M — Một active page có thể có nhiều surface hợp lệ và bị churn

`LivePageFrame.tsx:3913-3999,5551-5712` có display base, accurate base/underlay và `TileLayer`; mỗi surface có `fileKey/groupKey` riêng. Runtime đã ghi `tile-effect-cleanup`, request attempt 1→2, `viewport-layer-empty/mount/unmount` và render-coordinator stale/cancel khi đổi trang/khổ viewport. Đây là trade-off correctness hiện tại, nhưng làm người dùng thấy loading lại khi geometry/active page đổi nhanh.

### §R23.07 — `[PARTIAL / RE-AUDIT]` P1 / M — PPE đã có resource cache nhưng chưa phải retained scene graph đầy đủ

Source hiện tại đã có `RenderSession::ResourceCache` LRU cho Image/Form (`print_engine/src/session.rs:269-473`) và `render_page_descriptor` truyền cache qua renderer (`print_engine/src/session.rs:1015-1024`). Test session/Form/SMask đã đạt; runtime mới cũng ghi image cache hit. Phần còn mở là PageProgram/Pattern/Font/Shading và decode ảnh theo viewport chưa được giữ thành một scene graph/mipmap bất biến xuyên mọi renderer. Vì vậy không được gọi đây là “chưa có cache”; finding còn lại chỉ là chi phí replay/resource chưa được đo đầy đủ trên corpus khách.

### §R23.08 — `[CONFIRMED]` P2 / M — Backend file nặng đúng tính responsive nhưng throughput còn tuần tự

Compare có chủ ý max một job vì PDFium guard; export ảnh lặp tuần tự từng trang. Đây không phải lỗi correctness, nhưng với file dài/ảnh lớn sẽ kéo dài wall time. Muốn tăng tốc phải song song ở process/document level, có reservation RAM theo byte và không tăng thread trong cùng một PDFium document.

### §R23.09 — `[OPEN]` P1 / M — Chưa có baseline sạch của binary hiện tại

Chưa có một corpus đo trên Windows thật sau `HEAD=703ffc2`, build Tauri sạch và file khách đại diện; log hiện tại trộn dev/release/binary cũ. Chưa thể chốt tỷ lệ cải thiện, cache hit ratio theo worker, peak RSS toàn cây, hay phân biệt chính xác `open_ms` giữa bootstrap/PPE/session/OS cache.

## 4. Những gì không được phá

- Giữ `RenderCoordinator` generation/latest-wins; response stale không được tạo Blob/commit/cache.
- Giữ `LiveTile` decode trước swap, giữ frame cũ khi frame mới chưa hợp lệ, và terminal `slow/error/cancelled`.
- Giữ worker preemption/priority và `RENDER_LOCK`/PDFium safety; không tăng worker vô điều kiện.
- Không hạ DPI/chất lượng trên máy `≥16GB`; mọi cap/cache/worker phải gate RAM theo quy ước PrynX.
- Không thay PDFium toàn dự án ngay; Print/Compare/Edit/Preflight/N-up/Sticker vẫn giữ consumer hiện tại.

## 5. Kiến trúc đích đề xuất — “trần công nghệ” nhưng triển khai tăng dần

```text
React PageShell + Thumbnail Virtualizer
        ↓ request_id/document_id/generation/priority/purpose
PrynX Render Coordinator
        ├── Document-affine Worker Lease (một PDF không bị mở lại ở worker khác)
        ├── DocumentSession / ObjectStore / PageIndex (lazy, mmap/range)
        ├── SceneCompiler + ResourceStore (Form/Pattern/Font/Image/Mipmap)
        ├── Interactive lane (page/viewport)  ──┐
        ├── Background lane (thumbnail/prefetch) ├─ latest-wins + cancel
        └── Accurate PPE lane (ICC/CMYK/spot)  ──┘
        ↓
+-- SurfacePool / double buffer / shared-surface spike --+
        ↓
WebView compositor (PNG compatibility fallback trong giai đoạn chuyển tiếp)
```

Quyết định quan trọng:

1. **Document affinity trước:** worker manager chọn lease theo `document_identity`; page chính và thumbnail của cùng PDF đi cùng session. Khi session cold, chỉ một request được mở/parse; request còn lại coalesce/chờ cùng future.
2. **First-pixel hai pha:** nhận identity + page geometry + page 1 tối thiểu để mount PageShell; color-risk toàn tài liệu, page dimensions còn lại và thumbnail chạy nền. Frame phải mang `display-preview`/`color-verified`.
3. **Thumbnail dùng chung session:** sidebar virtualized (chỉ khoảng viewport + overscan tồn tại trong DOM), thumbnail là low-DPI tile/sprite từ cùng scene/resource cache, không gọi một pipeline PDFium độc lập cho từng item.
4. **PPE Native Viewer dài hạn:** ObjectStore/xref lazy → SceneCompiler IR bất biến → ResourceStore có Form/Pattern/Font/Image/Mipmap → raster viewport. Đây là hướng đã có thiết kế trong `KE_HOACH_KIEN_TRUC_VIEWER_KHONG_PDFIUM_2026-08-13.md`; không thay đổi consumer print/compare hiện tại.
5. **Transport:** giữ PNG để rollback/canary; chỉ promote shared RGBA surface khi benchmark Windows chứng minh giảm copy/decode/RSS và lifetime an toàn.

## 6. Lộ trình đề xuất sau khi duyệt

Mỗi lô tối đa 5 file, verify xong mới sang lô kế.

### Lô 0 — Baseline + tripwire (không đổi thuật toán)

Thêm harness Windows cho cold/warm open, first visible, first sharp, thumbnail first 12, page switch, zoom-stop, pan; log `bootstrap_ms`, `metadata_ms`, `worker_open_ms`, `queue_ms`, `raster_ms`, `encode_ms`, `decode_ms`, `stale_ms`, worker PID/document identity, peak RSS từng process + toàn cây.

Gate: N≥30 cold/warm trên corpus RGB/vector, scan/photo, CMYK/spot, PDF 165–302MB, 1.000+ trang, mixed-size/rotation/UserUnit; không dùng kết quả runtime cũ làm baseline mới.

### Lô 1 — Document-affine worker/session

Đưa `document_identity → worker lease/session` vào `render_worker` và protocol; coalesce bootstrap/page/thumbnail; mở/parse một lần mỗi worker lease; close theo owner/ref-count. Không tăng số worker mặc định.

Kỳ vọng: loại bỏ open/parse lặp ở thumbnail và page switch; gate so sánh `open_ms`/cache hit và RSS trên máy 8/16/32GB.

### Lô 2 — First-pixel fast path

Tách `PageShell + page1 geometry` khỏi full color-risk/page metadata; giữ risk/metadata nền và soundness contract. Không cho binary cũ/fallback phá màu: nếu chưa chứng minh màu, frame mang nhãn bảo thủ và không badge accurate.

### Lô 3 — Thumbnail virtualizer + shared session

Thay `pageOrder.map` bằng virtualizer; thumbnail request đi qua coordinator cùng `document_id`, priority nền và tile cache; giới hạn overscan theo pixel/RAM, không cap chất lượng máy mạnh.

### Lô 4 — PPE retained scene/resource cache

ObjectStore/PageIndex lazy, SceneCompiler IR, ResourceStore Form/Pattern/Font/Image/Mipmap; pixel parity với full-page/viewport và ICC/SMask/spot là gate bắt buộc.

### Lô 5 — Surface transport spike

Double-buffer RGBA/shared-surface thử nghiệm; PNG fallback giữ nguyên. Chỉ bật sau khi chứng minh lifetime, crash recovery, copy/decode/RSS tốt hơn trên Windows WebView2.

### Lô 6 — Backend heavy-file lanes

Giữ route mỏng + scheduler hiện có; thêm process/document affinity, streaming artifact và reuse metadata/session cho compare/export/PPE. Chỉ song song giữa process/document độc lập khi RAM reservation đủ; không song song page trên cùng PDFium handle.

## 7. Ma trận nghiệm thu

| Chỉ số | Gate đề xuất |
|---|---:|
| PageShell sau nhận file | P95 ≤ 100 ms |
| First visible (file thường) | P50/P95 ≤ 250/500 ms |
| First visible (file nặng) | báo riêng theo corpus, không che bằng timeout |
| Warm page/thumbnail cache hit | P95 ≤ 150 ms |
| Zoom-stop → sharp | P50/P95 ≤ 120/300 ms |
| Blank gap sau frame đã commit | 0 hoặc tối đa 1 frame animation |
| Stale render commit | 0 |
| Máy ≥16GB | không giảm DPI/chất lượng; không chậm hơn baseline >10% trên corpus chuẩn |
| Accuracy | tile/full parity; ICC/SMask/spot không đổi |
| Runtime | Windows Tauri dev + release/installer; clean build, multi-tab, cancel, worker crash/restart |

## 8. Chốt duyệt

Audit dừng ở đây theo quy trình PrynX. Đề nghị duyệt theo thứ tự **Lô 0 → Lô 1 → Lô 2 → Lô 3**, sau đó mới quyết định đầu tư PPE SceneCompiler/SurfacePool. Không sửa trực tiếp trước khi có chốt duyệt và baseline sạch.

## 9. Re-audit current source sau các lô đầu

- `print_engine::RenderSession` hiện đã có `ResourceCache` sống theo session, LRU chung cho Image/Form và kiểm save-over; các test session cache **8/8**, Form parity **1/1**, SMask cache **1/1** đạt.
- Runtime probe cho thấy accurate request thường có `source_ms` thấp và `decode_ms=0`; vì vậy chưa có bằng chứng để ưu tiên shared-surface/GPU transport trước khi đo cache/resource hit ratio.
- Telemetry `PPE_SESSION_CACHE` đã được thêm ở commit `f9a76b9`, nhưng binary chạy gần nhất chưa chứa telemetry này; cần chạy binary mới để đóng baseline cache.
- Kết luận cập nhật: hướng PPE retained resource cache đã tồn tại một phần trong engine hiện tại; lô tiếp theo là đo và tối ưu cache/session có mục tiêu, không viết lại mù toàn bộ PPE.

## 10. Ma trận trạng thái sau các lô đã duyệt

| Phần kế hoạch | Trạng thái bằng chứng | Ghi chú |
|---|---|---|
| Baseline/telemetry | `ARTIFACT + RUNTIME` | Có script phân tích log, first-pixel/PPE/affinity/cache; corpus còn trộn nhiều phiên |
| Document-affinity worker | `SOURCE + AUTO + RUNTIME` | Runtime có affinity hit; cần A/B cold sạch để chốt lợi ích RSS/open_ms |
| First-pixel/target settle | `SOURCE + AUTO + RUNTIME` | Có settle 250ms, first-pixel warm khoảng 190–220ms; cần cold corpus chuẩn |
| Thumbnail DOM/pipeline | `SOURCE + AUTO + RUNTIME-PARTIAL` | Dev WebView smoke 1.000 trang đã chứng minh 5 item DOM ở đầu/cuối; release/RSS toàn cây process và shared session vẫn pending |
| PPE ResourceCache | `SOURCE + AUTO + RUNTIME` | Session/Form/SMask tests và `PPE_SESSION_CACHE` hit/miss đã có |
| Shared surface/GPU | `DEFERRED` | Runtime chưa chứng minh PNG/IPC là nút thắt; không triển khai mù |
| Backend Compare | `AUTO + ARTIFACT` | 20 trang @150 DPI: 1.51×, parity đúng; cần corpus khách dài hơn |
| Backend Export | `BASELINE` | RGB/CMYK 15 trang @150/300 DPI; chưa có file khách nặng/peak RSS |

Không đánh dấu hoàn tất toàn chiến dịch cho tới khi các hàng `RUNTIME-PARTIAL`, `BASELINE` có corpus/installed smoke tương ứng. Các file unrelated đang dirty vẫn nằm ngoài phạm vi và không bị stage.
