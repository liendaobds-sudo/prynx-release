# Lô lint P2.34 — 2026-08-23

## Phạm vi

Dọn 5 symbol `no-unused-vars` trong một file viewer đang có test hồi quy:

- `desktop/src/components/workspace/LivePageFrame.tsx`
- Bỏ import `useViewerHotkeys`, helper `snapRotation`, hằng `TILE_SIZE`, binding prop `onObjectDelete` và tham số drag-leave không được đọc.

Không đổi interface props, listener drag/drop, tile scheduler hoặc edit-object runtime.

## Verify

- Rule `no-unused-vars` trong file: sạch; các finding React Refresh/Hook lịch sử giữ nguyên.
- Test render policy + live tile: 2 file, 45/45 đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: số tổng sau LO37–38 là 1.267 errors / 103 warnings; riêng LO38 giảm 5 lỗi.

## Kết luận

Chỉ bỏ symbol không có consumer; không thay đổi hành vi viewer.
