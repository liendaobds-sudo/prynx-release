# Lô lint P2.37 — 2026-08-23

## Phạm vi

Dọn 16 finding `no-unused-vars` trong `desktop/src/components/AcrobatViewer.tsx`:

- Bỏ import/helper/state không có consumer.
- Bỏ các field không được đọc khỏi selector để tránh subscription thừa.
- Thu hẹp destructuring kết quả zoom.
- Giữ nguyên interface `onViewerDirtyChange` và mọi call site legacy; Viewer tiếp tục ghi dirty trực tiếp vào cùng workspace store.

Không đổi page identity, overlay, zoom, hotkey, tile hoặc edit-session runtime.

## Verify

- Rule `no-unused-vars` trong file: sạch; finding React Refresh/Hook lịch sử giữ nguyên.
- Test page overlay + render policy + live tile: 3 file, 56/56 đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.267 → 1.234 errors; warnings giữ 103. Delta gồm LO39–40 chạy đồng thời; riêng LO41 giảm 16 lỗi.

## Kết luận

Chỉ bỏ binding/subscription không có consumer; public prop và hành vi viewer được giữ nguyên.
