# Nhật ký triển khai AI nhiều trang — 2026-08-09

Nguồn kế hoạch: `BAO_CAO_AUDIT_AI_NHIEU_TRANG_2026-08-09.md`.

## Lô 1 — Page state backend

- `sticker_sheet_session.py`: bổ sung state, khóa thao tác và thư mục artifact riêng theo `source_page`; trang 1 giữ gương tương thích cho route/export một trang hiện tại.
- `sticker_source_pipeline.py`: kiểm stage của trang được yêu cầu thay vì stage toàn tài liệu.
- `test_sticker_source_pipeline.py`: khóa ca hai trang khác nhau được đặt chỗ đồng thời, retry/abort một trang không đổi sibling và thư mục trang không trùng nhau.

### Verify

- `py_compile` session/pipeline: đạt.
- `test_sticker_source_pipeline.py`: 17/17 đạt.
- `test_sticker_sheet_api.py`: 42/42 đạt; ca trang 2 giữ CutContour tiếp tục xanh.

## Lô 2 — API theo trang

- Detect/refine/confirm và asset đều mang `page_number`; URL asset khóa đồng thời trang và revision.
- Route trả manifest trực tiếp từ page state, không còn dựa vào manifest phản chiếu tạm của session.
- Client desktop truyền trang rõ ràng và có test hợp đồng request/asset.

### Verify

- `py_compile` schema/route: đạt.
- `test_sticker_sheet_api.py`: 43/43 đạt.
- `stickerSheetApi.test.ts`: 2/2 đạt.
- TypeScript typecheck toàn desktop: đạt.

## Lô 3 — Export nhiều trang atomic

- Request export mang revision, edit, DPI từng trang và `page_order` có thể đổi/lặp theo thumbnail.
- Backend chặn trước trang chưa xác nhận hoặc revision stale; không tạo kết quả thiếu trang.
- Trang raster tương thích được gom vào một lần chạy `StickerEngine`; trang CutContour thật được ghép bằng pikepdf mà không raster hóa.
- PDF/ZIP chỉ được công bố sau khi toàn bộ staging hoàn tất; tên PNG có tiền tố trang logic.

### Verify

- `py_compile` worker/schema/route: đạt.
- `test_sticker_sheet_api.py`: 45/45 đạt, gồm thứ tự 2→1, stale/incomplete và một engine call cho hai trang raster.
- `stickerSheetApi.test.ts`: 3/3 đạt.
- TypeScript typecheck toàn desktop: đạt.

## Lô 4 — Store frontend theo trang

- Store giữ `pages[source_page]` cho manifest, asset, tinh chỉnh, edit/redo, revision và lỗi riêng từng trang; các field một trang cũ chỉ còn là gương của trang đang thao tác.
- Request detect/refine khóa bằng `tabId + source_page`; detect hai trang cùng tab không hủy nhau và lỗi một trang không đóng session của trang khác.
- Có thao tác nhận diện trang hiện tại, nhận diện các trang còn chờ và export mang state/revision theo từng trang.

### Verify

- `stickerSheetStore.test.ts` + `stickerSheetApi.test.ts`: 22/22 đạt tại chốt Lô 4.
- TypeScript typecheck toàn desktop: đạt.

## Lô 5 — Chọn nhiều ảnh thành một tài liệu

- `imageFilesToPdfFile()` đọc tuần tự JPG/PNG/WebP/BMP/TIFF, kể cả File path-stub qua `getFileArrayBuffer`, rồi ghép thành một PDF nhiều trang theo đúng thứ tự picker.
- Kích thước mỗi trang tiếp tục dùng DPI ảnh; ảnh thiếu metadata giữ fallback 72 DPI như luồng mở ảnh cũ.
- Picker AI cho phép chọn nhiều file, chỉ dựng PDF/Viewer/thumbnail và không tự gọi inspect/detect.
- Panel hiển thị `n ảnh · tài liệu n trang`, tiến độ trang sẵn sàng và hai thao tác `Nhận diện trang hiện tại` / `Nhận diện tất cả trang`.

### Verify

- Test ghép ảnh khóa thứ tự JPG/PNG, DPI riêng từng trang và fallback 72 DPI.
- Test panel khóa multi-select không tự inspect/detect.

## Lô 6 — Trang đang xem và overlay

- Trang nguồn đang thao tác được tính từ `viewerPageOrder[viewerActivePage - 1] ?? viewerActivePage` rồi truyền xuyên dashboard → router → công cụ AI.
- Store đổi gương active page khi người dùng đổi thumbnail; workspace đọc trực tiếp page state tương ứng nên tuning/edit/undo/redo không trộn trang.
- Viewer Acrobat tiếp tục sở hữu zoom, Hand, Space và cuộn; overlay chỉ gắn lên khung của đúng trang nguồn.
- PDF/ZIP nhận chính `viewerPageOrder`; điều kiện mở export chỉ xét các thumbnail hiện còn trong danh sách, không bắt trang đã xóa.

### Verify

- `StickerSheetWorkspace.test.ts`: 10/10 đạt tại chốt Lô 6.
- Test panel khóa trang đã xóa không chặn export và trang còn hiện chưa sẵn sàng vẫn chặn.

## Lô 7 — Trạng thái thumbnail và thứ tự xuất

- Thumbnail có năm trạng thái nhỏ: chưa nhận diện, đang nhận diện, cần xác nhận, sẵn sàng và lỗi; trạng thái khóa theo số trang nguồn nên vẫn đúng sau reorder/duplicate.
- Overlay dùng `activeSourcePage`, không còn lấy `manifest.source_page` cũ của lần detect gần nhất.
- Selector tab AI dùng object rỗng ổn định khi tab chưa khởi tạo, tránh snapshot Zustand đổi tham chiếu và vòng render lặp.
- Test khóa page order `2 → 1` được chuyển vào lệnh xuất.

### Verify

- Bộ test frontend phạm vi AI/viewer: 146/146 đạt.
- Backend session/pipeline/API/export: 62/62 đạt; còn 2 cảnh báo deprecation của dependency, không thuộc thay đổi này.
- TypeScript typecheck toàn desktop: đạt.

## Lô 8 — Hồi quy tổng

- `npm run test`: 219/219 test file đạt, 2111 test đạt, 2 test skip theo cấu hình.
- `npm run build`: frontend production build đạt; chỉ còn cảnh báo chunk/dynamic import đã có của dự án.
- `git diff --check` phạm vi tính năng: đạt.
- Smoke qua `http://localhost:5173`: app tải được tới Home nhưng công cụ là tính năng Pro và phiên browser không có đăng nhập/Tauri IPC, vì vậy chưa thể nghiệm thu chuỗi chọn 1/3/~20 ảnh trên runtime thật. Không giả lập hoặc vượt lớp bản quyền.

### Còn cần nghiệm thu trên Tauri đã đăng nhập

1. Chọn 1, 3 và khoảng 20 ảnh; kiểm tra một tài liệu và đúng số thumbnail.
2. Nhận diện trang hiện tại/tất cả, đổi thumbnail trong lúc chạy và retry một trang lỗi.
3. Kiểm tra zoom/Hand trước và sau nhận diện, badge, overlay, tuning/edit riêng từng trang.
4. Xuất PDF/ZIP sau reorder; đối chiếu thứ tự, tổng tem và tên PNG.
5. Chạy ảnh khách hàng `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg` trong batch để nghiệm thu trực quan phần khử bóng/C2.
