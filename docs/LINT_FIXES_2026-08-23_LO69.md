# Lô lint P2.65 — 2026-08-23

## Phạm vi

Loại 14 lỗi ESLint trong đúng 2 file preprocess:

- `PreflightTool.tsx`: thay kiểu `any` bằng contract cho report/issue và log
  pipeline; xử lý response lỗi qua `unknown`; đổi hai nhánh toggle ternary
  thành `if` tương đương để loại `no-unused-expressions`.
- `StickTextNumberTool.tsx`: đặt kiểu union cho phạm vi trang, định kiểu cờ
  Tauri và Blob PDF, xử lý `catch` bằng `unknown`.

Giữ nguyên endpoint, payload, thứ tự pipeline, callback commit, công thức đóng
  dấu, bytes PDF và hành vi chọn trang. Không chạm VDP hoặc backend.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression `PreflightTool.outputPreview.test.tsx`: 1/1 test đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: **796 → 782 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- `PreflightTool` vẫn tin response 2xx theo schema backend hiện hữu; lô này
  không thêm runtime validator để giữ semantics legacy.
- `StickTextNumberTool` chưa có test component riêng; thay đổi là type-only và
  đường chạy runtime giữ nguyên, nhưng cần kiểm tay đóng dấu trong Tauri khi
  phát hành.

## Kết luận

Lô type-safety hoàn tất ở mức kiểm thử tự động, chưa commit, push hoặc build
release.
