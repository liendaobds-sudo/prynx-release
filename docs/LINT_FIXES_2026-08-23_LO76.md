# Lô lint P2.72 — 2026-08-23

## Phạm vi

Loại 5 lỗi `no-explicit-any` trong Flipbook:

- `FlipBook.tsx`: dùng component dependency trực tiếp, khai báo imperative
  `pageFlip()` handle và event `{ data: number }` theo code thật của
  `react-pageflip`/`page-flip`.
- `types.ts`: `BookPage` mô tả `_originalIndex` optional cho trang đệm nội bộ,
  loại hai cast và cast khi thêm trang chẵn.

Không đổi thứ tự/padding trang, page index, nút lật, kích thước responsive,
transition hoặc callback `onPageChange`.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression Flipbook dialog: 1/1 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending cũ.
- `npm run lint:budget`: **747 → 742 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Test dialog hiện mock `FlipBook`, nên chưa chạy animation/imperative ref thật
  của `react-pageflip` trong jsdom.
- Chưa lật trang bằng chuột/cảm ứng trên GUI Tauri thật.

## Kết luận

Lô type-safety Flipbook hoàn tất ở mức kiểm thử tự động, chưa commit, push hoặc
build release.
