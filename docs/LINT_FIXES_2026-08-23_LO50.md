# Lô lint P2.46 — 2026-08-23

## Phạm vi

Xóa riêng wrapper `handleReset` không có consumer trong
`desktop/src/components/ImpositionTab.tsx`.

Trace lịch sử xác nhận wrapper này chỉ tồn tại dưới dạng khai báo từ commit đầu;
luồng đóng tab thật hiện do `App.tsx` quản lý. Giữ nguyên `forceReset`, modal và state
legacy để không mở rộng lô lint thành thay đổi hành vi.

Không nối wrapper vào UI vì cleanup cũ chưa phủ đủ state hiện tại của viewer,
edit-session và sticker-sheet.

## Verify

- ESLint hẹp: `ImpositionTab` còn 0 `no-unused-vars`.
- App shell + mở file Imposition: 4 file test, 6/6 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: 1.192 → 1.191 errors; warnings giữ 103.

## Kết luận

Lô chỉ xóa binding chết; luồng đóng tab, cảnh báo chưa lưu và cleanup khi unmount
không thay đổi.
