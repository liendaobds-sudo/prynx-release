# Lô lint P2.64 — 2026-08-23

## Phạm vi

Loại 12 lỗi `no-explicit-any` tại boundary xử lý PDF/preflight trong đúng 5
file công cụ preprocess:

- `HairlinesTool.tsx`: khai báo contract response/log, parse JSON theo contract,
  và xử lý lỗi `unknown` với fallback i18n.
- `SavePdfxTool.tsx`: khai báo contract kiểm tra compliance/xuất PDF/X, giữ
  nguyên endpoint/payload và xử lý lỗi an toàn.
- `EncryptTool.tsx`, `MetadataTool.tsx`: đổi catch sang `unknown`, chỉ lấy
  message khi là `Error`, giữ nguyên fallback hiện có.
- `InkManagerTool.tsx`: helper lấy thông điệp lỗi cho cả `Error` và object có
  thuộc tính `message`.

Không đổi endpoint, tên field JSON, recipe ticket, callback `onFileFixed`,
trạng thái loading/progress, hook dependency hay nội dung UI. Các response
assertion chỉ làm rõ contract hiện hữu; không thay đổi đường chạy nghiệp vụ.

## Verify

- ESLint hẹp 5 file: đạt, 0 lỗi.
- `npm run typecheck`: đạt.
- Regression preprocess/output preview: 3 file, 28/28 test đạt.
- Regression persistence Hairlines/PDF-X: 19/19 test đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: **808 → 796 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Response 2xx vẫn được tin theo schema backend hiện hữu; lô này không thêm
  runtime validator để tránh thay đổi semantics legacy.
- Chưa chạy Tauri GUI/sidecar thật; cần kiểm tay các thao tác hairlines, PDF/X,
  mã hóa, metadata và quản lý mực nếu phát hành.

## Kết luận

Lô type-safety hoàn tất ở mức kiểm thử tự động, chưa commit, push hoặc build
release.
