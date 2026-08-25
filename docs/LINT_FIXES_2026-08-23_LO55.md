# Lô lint P2.51 — 2026-08-23

## Phạm vi

Generic hóa phần thuần `sortFieldsGeometrically` trong `vdpUtils.ts`:

- Thêm `VdpGeometricField` và kiểu positioned nội bộ.
- Giữ kiểu trả về generic của consumer.
- Thay 9 `any` ở mảng/callback sort bằng kiểu có `position` và `id` tùy chọn.

Không chạm `buildMultiUpJobInput`; 13 `any` còn lại ở đó là boundary VDP động,
cần schema/contract test riêng.

## Verify

- `vdpUtils.test.ts` + `coverNumberingPlanner.test.ts`: 2 file, 20/20 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: 1.175 → 1.166 errors; warnings giữ 103.
- ESLint focused xác nhận phần sort sạch; 13 finding còn lại được khoanh đúng
  trong `buildMultiUpJobInput`.

## Kết luận

Lô chỉ siết type helper hình học thuần, giữ nguyên thứ tự sort và payload VDP.
