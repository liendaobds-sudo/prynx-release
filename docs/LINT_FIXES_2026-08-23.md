# Lô lint P1 — 2026-08-23

## Phạm vi

- File: desktop/src/lib/dieline/sidecarEntry.ts
- Finding: eslint/unused-disable — directive no-var không còn tác dụng.
- Thay đổi: xóa đúng directive thừa; không đổi logic khai báo global hoặc sidecar.

## Verify

- ESLint riêng file: đạt.
- npx vitest run src/lib/dieline: 29 file, 582 test đạt, 2 skipped.
- npm run typecheck: đạt.
- npm run build:dieline-sidecar: đạt.
- npm run check:dieline-webview: đạt.
- npm run lint:budget: còn fail đúng rule React Refresh; tổng warning giảm từ 109 xuống 108.
- git diff --check: đạt.

## Số đo

| Chỉ số | Trước lô | Sau lô |
|---|---:|---:|
| Errors | 1.469 | 1.469 |
| Warnings | 109 | 108 |
| unused-disable | 10 | 9 |
| react-refresh/only-export-components | 60 | 60 |

## Kết luận

Lô chỉ xử lý một suppression cơ học và không tạo finding mới. Chưa commit/build
release/push. Lô kế tiếp phải xử lý React Refresh theo nhóm file sạch, tối đa 5
file, sau khi các thay đổi tính năng hiện tại được cô lập.
