# Fixes mở file, load trang và load view — 2026-10-01

## Lô S0 — trace queue và first pixel

**Mục tiêu:** nối request tile ở frontend với độ sâu hàng đợi và thời gian chờ thực tế, không đổi concurrency hay kết quả render.

### Thay đổi

- `desktop/src/hooks/viewer/tileRenderScheduler.ts`
  - Gắn `request_id` vào task scheduler.
  - Ghi các sự kiện `enqueue`, `start`, `finish`, `cancel-queued`, `cancel-running`.
  - Ghi `queue_depth`, `active_count`, lane, `queue_wait_ms`, `run_ms` và giới hạn lane.
  - Nếu logger lỗi, scheduler vẫn chạy bình thường.
- `desktop/src/hooks/viewer/renderCoordinator.ts`
  - Truyền `request_id` đã có vào scheduler để nối với `tile-first-pixel` và log Rust.
- `desktop/src/hooks/viewer/tileRenderScheduler.test.ts`
  - Kiểm tra queue depth, request id và queue wait được ghi đúng.

## Lô S1 — page-1-first cho PDF.js

**Mục tiêu:** không chờ đọc kích thước toàn bộ tài liệu in-memory trước khi báo Viewer sẵn sàng.

### Thay đổi

- `desktop/src/hooks/viewer/usePdfLoader.ts`
  - Nhánh PDF.js luôn đọc page 1 trước.
  - Các trang còn lại hydrate tuần tự theo cụm sau `notifyFirstPageRenderReady()`.
  - Giữ nguyên kiểm tra mixed-size, generation và hủy khi đổi file.
- `desktop/src/hooks/viewer/usePdfLoader.test.tsx`
  - Thêm test chứng minh page 1 sẵn sàng khi page 2 còn pending, sau đó page 2 được hydrate đúng.

### Verify

- `npx vitest run src/hooks/viewer/tileRenderScheduler.test.ts src/hooks/viewer/renderCoordinator.test.ts`
  - 2 test files, 27 tests passed.
- `npx tsc --noEmit`
  - Passed.
- `npx vitest run src/hooks/viewer`
  - 10 test files, 178 tests passed.
  - Có một thông báo jsdom đã biết về `HTMLCanvasElement.getContext`; test vẫn pass.

### Chưa xác minh

- Chưa chạy GUI/Tauri production artifact trên Windows với file PDF nặng.
- Chưa thay đổi số worker, scheduler slot, page LRU hay đường đọc PDF native.
- Chưa chạy lại GUI/Tauri theo ma trận đầy đủ trong `docs/BAO_CAO_AUDIT_MO_FILE_LOAD_VIEW_2026-10-01.md`.

## Lô S2 — active-first qua occlusion/focus

**Mục tiêu:** không để trang đang xem đứng ở trạng thái “Đang dựng hình…” chỉ vì WebView2
đánh dấu cửa sổ bị che hoặc mất focus tạm thời; prefetch nền vẫn phải chờ foreground.

### Bằng chứng

- Trace `Vmupblqjd-uigjax` ghi request interactive `c2adbfa7-…` chờ scheduler
  `120182.7 ms`, trong khi phần chạy thật chỉ `11.3 ms`.
- Cùng thời điểm, hàng đợi có `active_count=0`; đây là cổng visibility/lifecycle,
  không phải PDFium hoặc encode chậm.

### Thay đổi

- `desktop/src/hooks/viewer/tileRenderScheduler.ts`
  - Singleton cho phép priority `<100` chạy khi app bị occlusion/mất focus tạm thời.
  - Khi nền, scheduler chỉ chọn lane interactive; task priority `>=100` vẫn chờ
    foreground và không tăng slot PDFium.
  - Giữ nguyên `activeCount` đến khi lời gọi native kết thúc thật sự.
- `desktop/src/hooks/viewer/tileRenderScheduler.test.ts`
  - Thêm regression test cho lane interactive chạy qua occlusion và prefetch vẫn bị giữ.

### Verify

- `npx vitest run src/hooks/viewer/tileRenderScheduler.test.ts`: **19 tests passed**.
- `npx vitest run src/hooks/viewer`: **10 files, 179 tests passed**.
- `npx tsc --noEmit`: **passed**.
- `git diff --check` trên hai file scheduler: **passed** (chỉ cảnh báo chuẩn CRLF của Git trên Windows).

