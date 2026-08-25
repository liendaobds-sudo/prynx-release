# Lô lint P2.19 — 2026-08-23

## Phạm vi

Loại lỗi react-hooks/set-state-in-effect trong SheetViewer mà vẫn giữ reset đúng vòng đời:

- desktop/src/components/flipbook/SheetViewerDialog.tsx
  - tách nội dung thành component nội bộ;
  - wrapper giữ export cũ và remount theo trạng thái mở/đóng, bindingMode, foliosize;
  - trạng thái sheet index và blueprint khởi tạo lại khi mở phiên mới hoặc đổi cấu hình.
- Không đổi API props, binding map hoặc tile renderer.

## Verify

- ESLint hẹp: SheetViewer sạch.
- Regression: 4 test files flipbook, 7/7 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.343 → 1.342, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Reset trạng thái được thực hiện bằng vòng đời React/key, không còn effect setState đồng bộ và không giữ nhầm trang từ phiên xem trước trước.
