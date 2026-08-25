# Lô lint P2.18 — 2026-08-23

## Phạm vi

Thay 5 explicit any của pdfFile trong SheetViewer bằng kiểu File nullable:

- desktop/src/components/flipbook/SheetViewerDialog.tsx
  - áp dụng nhất quán cho props dialog và ba component preview con;
  - giữ nguyên việc truyền File từ workspace tới tile renderer.

Không xử lý effect reset sheet và các any khác của FlipbookDialog; chúng là contract/lifecycle riêng.

## Verify

- ESLint hẹp: toàn bộ no-explicit-any của SheetViewer hết; còn 1 lỗi lifecycle effect đã ghi nhận.
- Regression: 4 test files flipbook, 7/7 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.348 → 1.343, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Props preview đã có kiểu rõ ràng, không thay đổi luồng render tile hoặc binding map.
