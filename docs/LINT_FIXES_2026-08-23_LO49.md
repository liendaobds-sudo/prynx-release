# Lô lint P2.45 — 2026-08-23

## Phạm vi

Dọn hai binding chết không có consumer trong frontend:

- Bỏ `_pageIdxDep` ở `GridPreview`; request thực tế đã dùng `_pageIdxForRequest`.
- Bỏ `leftBottomHandle` ở preview đường cắt; biến này trùng giá trị với
  `bottomMinusHandle` và không tham gia dựng SVG.

Không đổi công thức xếp trang, page index gửi backend hoặc hình học đường cắt.

## Verify

- ESLint hẹp: `no-unused-vars` còn 0 trong hai file.
- GridPreview + classic cutline preview: 3 file test, 26/26 đạt.
- `npm run typecheck`: đạt.
- Tổng lint: 1.194 → 1.192 errors; warnings giữ 103.

## Kết luận

Lô chỉ xóa hai khai báo không được đọc; hành vi runtime và dữ liệu request giữ nguyên.
