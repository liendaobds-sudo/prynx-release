# Lô lint P2.29 — 2026-08-23

## Phạm vi

Dọn 6 finding `no-unused-vars` trong 4 file engine bình bản:

- `desktop/src/lib/imposerEngine/GeometricSolver.ts` — bỏ phép tính `marginX` không có consumer.
- `desktop/src/lib/imposerEngine/InstructionSerializer.ts` — thu hẹp helper `rotY` về đúng tham số toán học được dùng.
- `desktop/src/lib/imposerEngine/SheetOptimizer.ts` — bỏ helper xoay tờ nội bộ không có call site.
- `desktop/src/lib/imposerEngine/MarksRenderer.ts` — bỏ kích thước ô/trim không được đọc.

Không đổi phép đặt trang, phép xoay đang chạy, dấu cắt hoặc đơn vị pt/mm.

## Verify

- ESLint rule mục tiêu trên 4 file: sạch.
- Test engine bình bản: 6 file đạt, 94 test đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.306 → 1.294 errors; warnings giữ 103. Delta này
  gồm LO32 chạy đồng thời; riêng LO33 giảm 6 lỗi.

## Kết luận

Chỉ dọn mã không có consumer; không thay đổi kết quả bình bản.
