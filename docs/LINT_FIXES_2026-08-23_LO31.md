# Lô lint P2.27 — 2026-08-23

## Phạm vi

- `desktop/src/lib/imposerEngine/SpreadPlacer.ts`
- Xóa hằng `PT` và comment debug không còn consumer.

Không đổi kích thước tờ, phép xoay, vị trí spread, dấu cắt hoặc công thức điểm/mm.

## Verify

- ESLint rule mục tiêu `no-unused-vars`: sạch; 4 lỗi `no-explicit-any` lịch sử
  vẫn được giữ nguyên để xử lý theo lô contract riêng.
- Test engine bình bản: 6 file đạt, 94 test đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.319 → 1.306 errors; warnings giữ 103. Delta gồm
  lô dieline LO30 chạy đồng thời; riêng file này giảm 1 lỗi.

## Kết luận

Chỉ dọn mã debug chết, không thay đổi kết quả bình bản.
