# Lô lint P2.66 — 2026-08-23

## Phạm vi

Loại 10 lỗi `no-explicit-any` trong đúng 2 UI kiểm tra cập nhật:

- `AboutModal.tsx`: dùng contract chính thức `Update`/`DownloadEvent`, định kiểu
  cờ runtime Tauri và xử lý lỗi `unknown` mà vẫn giữ message của `Error`/object.
- `UpdateChecker.tsx`: state update dùng `Update | null`, callback tiến độ dùng
  `DownloadEvent` và cờ Tauri có type rõ ràng.

Giữ nguyên `check`, `downloadAndInstall`, công thức phần trăm, trạng thái UI,
relaunch và cơ chế mở link. Diff tách `SUPPORT` có sẵn từ lô trước được giữ
nguyên.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- `supportContact.test.ts`: 1/1 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending cũ.
- `npm run lint:budget`: **782 → 772 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Chưa mô phỏng server updater hoặc cài artifact thật; phần runtime chỉ được bảo
  chứng bởi contract type của plugin và typecheck.
- Không build/cài lại ứng dụng trong lô lint này.

## Kết luận

Lô type-safety updater hoàn tất ở mức kiểm thử tự động, chưa commit, push hoặc
build release.
