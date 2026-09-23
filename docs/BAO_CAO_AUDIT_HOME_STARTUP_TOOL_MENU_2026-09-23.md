# Audit lag Home lúc khởi động và khi cuộn menu Công cụ — 2026-09-23

Trạng thái: **DIAGNOSIS-ONLY / CHƯA SỬA CODE**.

## 1. Kết luận nhanh

Có hai nguồn gây lag startup đã được xác nhận bằng code/build artifact:

1. `App.tsx` gọi `scheduleWarmupPdfjs()` ngay sau mount. Sau `requestIdleCallback` timeout chỉ 300 ms, máy >=16 GB sẽ nạp song song các chunk lớn `ImpositionTab`, `LivePageFrame`, `AcrobatViewer` trong khi người dùng vừa rời splash/Home. Các chunk build hiện có lần lượt khoảng **1,414,027 bytes**, **1,189,998 bytes**, **226,960 bytes**.
2. Home render catalog Công cụ đồng thời với Recent Files. Catalog có **38 tool definitions**; Recent Files cho phép tối đa **50 file**, mỗi thumbnail Tauri chạy probe native rồi tạo tile request khi Home active.

Vì vậy triệu chứng “khởi động lag” nhiều khả năng là main-thread/module-evaluation + IPC/tile contention; triệu chứng “cuộn menu lag” nhiều khả năng là paint nhiều card có shadow/transition cùng lúc, cộng thêm việc catalog không virtualize.

## 2. Đường chạy đã trace

### Startup

`App.tsx:293-298` → `scheduleWarmupPdfjs()` → `pdfWarmup.ts:162-205` → `warmupWorkspaceChunks()` → dynamic import:

- `../components/ImpositionTab`
- `../components/AcrobatViewer`
- `../components/workspace/LivePageFrame`

`App.tsx:260-330` đồng thời giữ splash tối thiểu 3 giây; `HomeTab.tsx:320-324` chỉ đánh dấu `home-interactive` sau khi Home mount. Warm-up không bị ràng buộc với `home-interactive` hay thao tác idle ổn định.

### Menu Công cụ

`HomeTab.tsx:558-576` map toàn bộ `TOOL_CATEGORIES`; mỗi section gọi `getToolsByCategory()` rồi tạo `ToolItem`/`DisabledItem`.

Mỗi `ToolItem` tại `HomeTab.tsx:50-160` có:

- nút/card với `transition-all`, `hover:shadow`, icon `scale` + `drop-shadow`;
- `ProFeatureBadge`, mỗi badge subscribe riêng vào `useAuthStore`;
- `createFallbackToolHelp()` và `useTranslation()` cho từng item.

Không có virtualization/windowing cho danh sách menu.

### Recent Files

`useRecentFiles.ts:40-43` cho phép tối đa 50 file. `RecentFilesGrid.tsx:175-300` render toàn bộ danh sách theo grid/list/details. `ThumbnailView.tsx:20-100` khi Home active sẽ probe từng file và với PDF tạo URL `tile.localhost` cho từng thumbnail; không có IntersectionObserver/viewport gate.

## 3. Findings

### HOME23.01 — P2/P1 hiệu năng — Warm-up chunk nặng chạy quá sớm

**[CONFIRMED / SOURCE + BUILD ARTIFACT]**

- `pdfWarmup.ts:92-105` nạp các chunk viewer nặng.
- `pdfWarmup.ts:189-192` dùng `requestIdleCallback(..., { timeout: 300 })`; trên startup bận, callback vẫn bị ép chạy sau 300 ms.
- `App.tsx:293-298` gọi warm-up cho mọi startup, kể cả khi người dùng chỉ đang ở Home.
- Build artifact ngày 2026-09-21: `ImpositionTab` 1.41 MB, `LivePageFrame` 1.19 MB, `AcrobatViewer` 0.23 MB raw. Đây là chi phí parse/evaluate JS trên main thread, không phải chỉ tải mạng.
- Báo cáo hiệu năng 2026-08-05 đã ghi nhận cùng trade-off: warm chunk giúp mở file lần đầu nhưng làm cold launch nặng hơn (`docs/BAO_CAO_AUDIT_HIEU_NANG_VA_THAN_THIEN_PHAN_CUNG_2026-08-05.md`, mục 3.2).

Đây là ứng viên mạnh nhất cho lag ngay sau khi splash biến mất. Chưa gọi là runtime-confirmed vì lượt này chưa mở app bằng Performance panel.

### HOME23.02 — P2 — Recent thumbnail fan-out lúc Home mount

**[CONFIRMED / SOURCE]**

- Tối đa 50 file recent được persist.
- Mỗi `ThumbnailView` active chạy `probeRecentFile()`; PDF sau đó tạo `tile.localhost` request. Với 50 file, startup có thể đồng thời tạo 50 native stat/tile jobs và 50 `<img>` decode/paint.
- Code đã tránh đọc toàn bộ PDF, đây là cải thiện quan trọng; nhưng vẫn chưa có viewport/lazy gate nên chi phí được trả ngay khi Home hiện.

Đây có thể là nguyên nhân startup rõ hơn khi người dùng có nhiều file recent; cần đo riêng ca recent rỗng, 10 file và 50 file.

### HOME23.03 — P2 — Catalog menu không virtualize và paint card nặng

**[CONFIRMED / SOURCE; runtime severity cần đo]**

- 38 tool definitions được lọc/render mỗi lần Home render; menu không dùng windowing.
- Card dùng `transition-all`, box-shadow, gradient favorite, icon transform/drop-shadow; khi cuộn, trình duyệt phải repaint nhiều lớp có hiệu ứng.
- `HomeTab` không memo hóa danh sách đã lọc; `getToolsByCategory()` lọc registry lặp cho từng category và favorite category.

Đây là nguyên nhân hợp lý cho “cuộn menu Công cụ” nhưng cần Performance recording để phân biệt paint cost với React commit cost.

### HOME23.04 — P2 — Rerender catalog rộng khi state Home thay đổi

**[CONFIRMED / SOURCE]**

`HomeTab` subscribe đồng thời `toolMenuWidth`, `homeToolMenuWidth`, mode, collapsed sections, hidden/favorite tools và recent-file state. Mỗi thay đổi làm Home rerender; trong render lại chạy filter/query và tạo JSX cho toàn bộ catalog. Đây không phải event scroll trực tiếp, nhưng làm lag rõ khi resize menu, tìm kiếm, đổi favorite/collapse.

## 4. Điều đã loại trừ

- `toolRegistry.ts:116-123` dùng `React.lazy`; các component tool không được mount chỉ vì Home render registry. Registry import bản thân không phải bằng chứng mọi tool component đã load.
- `App.tsx:1319-1345` đã memo hóa menu bar “Công cụ”; menu bar shell không phải cùng danh sách catalog Home và không giải thích riêng lag cuộn pane Home.
- `ThumbnailView` không còn `readFile` toàn bộ PDF; đây là cải thiện đã có, không nên revert về cách cũ.

## 5. Verify còn thiếu

Chưa chạy Tauri runtime/Performance panel trong lượt này. Cần ghi ba profile trên cùng máy:

1. Startup Home với Recent rỗng.
2. Startup Home với 10/50 Recent PDF.
3. Home đã ổn định, cuộn menu từ đầu đến cuối 5 lần.

Trong DevTools dev có thể đọc `window.__prynxPerf()` để lấy các mốc `startup-to-home-interactive`, `startup-to-app-inner` và `startup-to-splash-complete`; Performance recording cần kiểm `Long Task`, `Evaluate Script`, `Paint`, `Image Decode`, `tile.localhost` và React commits.

## 6. Đề xuất sửa, chưa áp dụng

1. **Startup:** không preload `ImpositionTab/LivePageFrame/AcrobatViewer` trước `home-interactive`; chuyển warm-up sang sau một khoảng ổn định hoặc sau hành động mở file đầu tiên, có gate theo runtime/máy.
2. **Recent:** lazy/viewport-load thumbnail, giới hạn số tile đồng thời và giữ placeholder cho file ngoài viewport.
3. **Menu:** memo hóa catalog đã phân loại/lọc; bỏ `transition-all`/shadow nặng trên card khi đang cuộn; nếu catalog tiếp tục tăng thì dùng virtualization.
4. Đo lại trên máy mạnh và máy yếu trước khi chọn cap; không áp hard-cap chung.

Chưa sửa code vì user mới yêu cầu kiểm tra nguyên nhân.

## Cập nhật sau khi triển khai

- HOME23.02 đã xử lý trong `aadb231`: Recent thumbnail dùng `IntersectionObserver` với `rootMargin=480px`, chỉ probe native/tạo tile khi card gần viewport; `ThumbnailView.test.tsx` 6/6, typecheck và lint xanh.
- HOME23.01 và phần paint của HOME23.03 đã xử lý trong `169c931`: chunk workspace hoãn 8 giây, pdf.js hoãn 10 giây sau idle; catalog đổi `transition-all` thành `transition-colors` và bật `content-visibility:auto`. Vitest warmup/Home/system integrations 29/29, typecheck/lint xanh.
- Đây vẫn là source-level fix; chưa có Performance panel runtime để chốt P95 startup/cuộn menu. Các finding còn lại về catalog rerender/filter và nghiệm thu installed release vẫn mở.
