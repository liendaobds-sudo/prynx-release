# Lô lint P2.22 — 2026-08-23

## Phạm vi

Ổn định lifecycle đọc PageBox trong Output Preview:

- desktop/src/components/OutputPreviewTab.tsx
  - bỏ generation ref chỉ dùng để kiểm tra request;
  - dùng cờ active trong effect kết hợp AbortController;
  - callback cũ tự vô hiệu khi cleanup, request mới không bị xóa nhầm preview;
  - cleanup vẫn xóa PageBox hiện tại như contract cũ.
- Không đổi endpoint, parse contract hoặc mapping viewer/source page.

## Verify

- ESLint hẹp: sạch.
- Regression Output Preview: 4 test files, 14/14 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.335 → 1.335, warnings 104 → 103; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Đã loại warning ref cleanup mà vẫn bảo toàn guard chống response cũ vẽ đè trang hiện tại.
