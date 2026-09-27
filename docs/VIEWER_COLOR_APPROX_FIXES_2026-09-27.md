# Ghi chú khắc phục lỗi kẹt cứng Viewport khi zoom (2026-09-27)

## 1. Triệu chứng
- Mở tài liệu PDF có không gian màu xấp xỉ (như `CMNM2026 - Giay moi_BLUE - in.pdf` chứa DeviceRGB/Lab không kèm profile ICC nhúng, hoặc blend mode ngoài DeviceRGB):
- Vừa zoom 1 cái là Viewport kẹt cứng, không làm nét được, không di chuyển/pan được vùng view.
- Trong khi một số file PDF khác chuẩn CMYK hoàn toàn thì hoạt động bình thường.

## 2. Nguyên nhân gốc rễ (Root Cause Analysis từ Log)
1. **`render_worker.rs`**: Khi PPE phân tích warnings của trang, hàm `classify_unsupported_warnings` coi `!warnings.approximated_colorspaces.is_empty()` là `RenderUnsupportedReason::ColorApproximation` làm lỗi không hỗ trợ (`Unsupported`). Thay vì trả về buffer điểm ảnh RGB đã render được, worker vứt bỏ ảnh PNG và trả về lỗi:
   `"PPE chưa bảo đảm kết quả: Trang cần phép màu xấp xỉ nên không được gắn color-verified."`
2. **`NativeGpuViewportContainer.tsx` / `AcrobatViewer.tsx`**: Nhận lỗi trên từ event `ppe-native-status`, frontend coi Native GPU Viewport bị lỗi và lập tức unmount HWND native, giáng cấp về CPU/DOM Viewer.
3. **`useTileRenderer.ts`**: Khi rơi về CPU/DOM Viewer với chế độ màu CMYK bật, nó gọi IPC `render_ppe_page` để lấy tile nét. `render_ppe_page` lại gặp đúng lỗi `ColorApproximation`. Frontend có cờ fail-closed từ chối fallback PDFium để tránh sai màu, dẫn tới ném `Error` vĩnh viễn $\rightarrow$ mọi tile đều dính `live-tile-load-error` và `ppe-ipc-reject`.
4. **`controller.rs`**: Giới hạn `limits` trong `scroll_page` chặn cứng ở `(viewport - page - 16., 16.)`, làm thao tác cuộn chuột khi zoom lớn lập tức kéo pan về hộp giới hạn hẹp, gây cảm giác kẹt cứng.

## 3. Các thay đổi đã thực hiện
- `desktop/src-tauri/src/pdf_engine/render_worker.rs`:
  - Gỡ bỏ việc đánh dấu `approximated_colorspaces` thành `RenderUnsupportedReason::ColorApproximation` trong `classify_unsupported_warnings`. Tương tự như font dự phòng (substituted fonts), màu xấp xỉ không phải lỗi giải mã hay thiếu đối tượng; PPE vẫn hoàn thành việc chuyển màu tốt nhất và xuất đủ pixel để hiển thị nét.
- `desktop/src/components/AcrobatViewer.tsx`:
  - Bổ sung bộ lọc trong `onError` bỏ qua các chuỗi cảnh báo xấp xỉ màu và tín hiệu hủy request hợp lệ, tránh unmount oan GPU viewport.
- `desktop/src/hooks/viewer/useTileRenderer.ts`:
  - Nhận diện đúng chuỗi hủy từ Rust (`PPE request đã bị hủy...`) thành `CancelledTileRenderError`, tránh gán nhầm thành lỗi vĩnh viễn `setAccurateColorFailure`.
- `desktop/src-tauri/src/viewport/controller.rs`:
  - Cập nhật `limits` trong `scroll_page` khớp với `clamp_to_page` (dùng `visible = 16.0_f32.min(page).min(viewport)`).

## 4. Nâng cấp hiệu năng & duy trì độ nét liên tục khi zoom (Zoom Sharpness Retention)

### 4.1. Vấn đề "không giữ độ nét khi zoom, không khác gì CPU"
- Khi người dùng cuộn chuột zoom liên tục (phóng to hoặc thu nhỏ), cả hai pipeline (Native GPU và React Tile Viewer) trước đây đều có cơ chế bảo thủ làm **mất hoàn toàn các tile/frame độ nét cao hiện có**, biến màn hình thành ảnh mờ tịt (thumbnail 72–150 DPI bị kéo dãn) cho tới khi dừng hẳn thao tác cuộn và chờ render mới:
  1. **Native GPU Viewport (`viewer_gpu/src/resident_present.rs`)**:
     - `MIN_DETAIL_DISPLAY_DENSITY` bị hardcode là `0.55`.
     - Khi người dùng phóng to vượt quá 1.8× (ví dụ từ 100% lên 200%, density = 0.5 < 0.55), hàm `ordered_detail_layers` lọc bỏ toàn bộ các frame detail trong cache.
     - Compositor GPU rơi thẳng về chỉ vẽ `overview` 72 DPI, khiến hình ảnh mờ câm trong suốt quá trình zoom.
  2. **React / Web Viewport (`desktop/src/components/workspace/viewportTilePolicy.ts` & `livePageFramePolicy.ts`)**:
     - Trong `viewportTilePresentationItems`: Điều kiện `if (hasStableUnderlay && !visibleCoversCurrentViewport && (zoomSettling || !targetIsCurrent)) return [];` lập tức ẩn sạch các tile nét (`opacity: 0`) mỗi khi đang lăn chuột (`zoomSettling = true`) nếu tile cũ không phủ kín 100% viewport mới.
     - Khi thu nhỏ (zoom-out), viewport luôn phình to hơn tile cũ $\rightarrow$ tile cũ bị ẩn 100%.
     - Khi phóng to (zoom-in), chỉ cần mép viewport lệch khỏi tile cũ 1px $\rightarrow$ tile cũ bị ẩn 100%.
     - Trong `shouldPresentViewerPanGrid`: Điều kiện `!(zoomSettling && hasStableUnderlay)` lập tức ẩn toàn bộ pan grid atlas khi đang lăn chuột.
     - Người dùng chỉ còn nhìn thấy lớp underlay toàn trang bị kẹp ở mức thấp (96–144 DPI) bị CSS kéo giãn to tướng $\rightarrow$ cảm giác mờ mịt chậm chạp như CPU viewer.

### 4.2. Giải pháp khắc phục
1. **`viewer_gpu/src/resident_present.rs`**:
   - Đổi `MIN_DETAIL_DISPLAY_DENSITY = 0.02` (hỗ trợ tới mức phóng to 50× mà không vứt bỏ frame detail độ nét cao).
   - Linear sampler của GPU phóng to texture độ nét cao cũ mượt mà và sắc nét gấp nhiều lần so với overview 72 DPI.
   - Refinement nền vẫn kích hoạt và kiểm tra đúng lưới pixel thực qua `raster_grid_matches` để trả về điểm ảnh 1:1 chuẩn xác khi dừng.
2. **`desktop/src/components/workspace/viewportTilePolicy.ts`**:
   - Loại bỏ việc ẩn tile nét khi đang zoom. `viewportTilePresentationItems` luôn giữ `state.visible` của cùng tài liệu/trang hiển thị trên màn hình.
   - Component cha (`TileLayer`) tự động scale `scaleX` và `scaleY` (`displayWidth / sourceDisplayWidth`) theo thời gian thực (16ms) theo đà lăn chuột. Vector/ảnh bitmap cũ được co giãn mượt mà bằng bộ lọc của trình duyệt, duy trì độ nét liên tục tương tự Adobe Acrobat và Figma.
   - Khi tile mới tải xong, nó chuyển đổi mượt mà thay thế tile cũ mà không bao giờ để lộ khoảng trắng hay rơi về thumbnail mờ.
3. **`desktop/src/components/workspace/livePageFramePolicy.ts`**:
   - `shouldPresentViewerPanGrid` không ẩn pan grid đã phủ kín khi `zoomSettling` $\rightarrow$ giữ nguyên độ nét của các ô lưới đang xem.

### 4.3. Kiểm thử & Xác minh
- `viewer_gpu`: 21/21 cargo tests pass.
- `desktop` vitest: 77/77 tests pass (`viewportTilePolicy.test.ts` và `LivePageFrame.renderPolicy.test.ts`).
- `desktop` typecheck: `tsc --noEmit` hoàn tất không lỗi.
