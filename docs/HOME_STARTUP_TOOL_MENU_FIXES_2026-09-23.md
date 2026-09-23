# Sửa lag Home startup/menu Công cụ — 2026-09-23

## Thay đổi

1. `desktop/src/lib/pdfWarmup.ts`
   - Trì hoãn preload workspace chunk nặng 8 giây.
   - Trì hoãn pdfjs warm-up 10 giây.
   - Vẫn giữ policy RAM hiện tại và hủy timer khi app unmount.
2. `desktop/src/components/RecentFiles/ThumbnailView.tsx`
   - Thumbnail chỉ probe native/tạo tile khi nằm trong viewport hoặc vùng đệm 480px.
   - Giữ fallback tải ngay trong môi trường không có `IntersectionObserver`.
3. `desktop/src/components/HomeTab.tsx`
   - Bật `content-visibility: auto` cho các nhóm menu dài.
   - Đổi card menu từ `transition-all` sang `transition-colors` để giảm repaint shadow/transform khi cuộn.

## Verify

- `ThumbnailView` + Home catalog + pdfWarmup: **19 passed**.
- TypeScript typecheck: **PASS**.
- Chưa đo runtime Tauri/FPS trong lượt này; cần kiểm lại bằng Performance panel trên máy người dùng.
