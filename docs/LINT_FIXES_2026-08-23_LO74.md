# Lô lint P2.70 — 2026-08-23

## Phạm vi

Loại 4 lỗi `no-explicit-any` trong module crash recovery và thêm một regression
test:

- `recovery.ts`: snapshot VDP dùng object record; module động plugin-fs/path dùng
  `typeof import(...)`; cờ Tauri được định kiểu.
- Các thao tác đọc/xóa lấy local reference sau guard null, giữ fail-safe/no-op
  khi runtime hoặc module Tauri không khả dụng.
- `recovery.test.ts`: khóa hành vi no-op trong môi trường web.

Không đổi version/JSON key của snapshot, tên file, thư mục `%APPDATA%`, lệnh
`write_file_atomic`, thứ tự restore hoặc chính sách best-effort.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression recovery web/no-Tauri: 1/1 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending cũ.
- `npm run lint:budget`: **759 → 755 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Chưa giả lập plugin-fs/path và chưa chạy restore thật trong Tauri; test hiện
  khóa đường fail-safe ngoài desktop.
- `listSnapshots` vẫn tin nội dung JSON cũ sau kiểm tra tối thiểu `tabId` và
  `originalPath`, đúng hành vi trước lô này.

## Kết luận

Lô type-safety crash recovery hoàn tất ở mức kiểm thử tự động, chưa commit,
push hoặc build release.
