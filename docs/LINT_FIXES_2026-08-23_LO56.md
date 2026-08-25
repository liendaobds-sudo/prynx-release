# Lô lint P2.52 — 2026-08-23

## Phạm vi

Định kiểu toàn bộ `buildMultiUpJobInput` trong `vdpUtils.ts`:

- Thêm schema tối thiểu cho field VDP, condition, rule và slot.
- Giữ input `conditions`/`rules` tùy chọn; output luôn là mảng (rỗng khi không
  có cấu hình), giúp consumer không phải suy đoán shape.
- Thay 13 `any` còn lại trong helper bằng các type trên.

Thuật toán namespace cột, remap placeholder và phân bổ record không đổi.

## Verify

- ESLint riêng `vdpUtils.ts`: 0 `no-explicit-any`.
- `vdpUtils.test.ts` + `coverNumberingPlanner.test.ts`: 2 file, 20/20 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.166 → 1.153 errors; warnings giữ 103.

## Kết luận

Lô hoàn tất schema hóa boundary multi-up; test hồi quy xác nhận namespace và
mapping record giữ nguyên.
