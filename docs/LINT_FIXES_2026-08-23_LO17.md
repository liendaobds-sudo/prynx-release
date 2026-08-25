# Lô lint P2.13 — 2026-08-23

## Phạm vi

Dọn symbol dead trong 3 file độc lập:

- desktop/src/components/flipbook/SheetViewerDialog.tsx
  - bỏ import RotateCw;
  - bỏ state showBack/setShowBack không có UI consumer;
  - bỏ report và activeSide không được đọc.
- desktop/src/components/preprocess-tools/WatermarkTool.tsx
  - bỏ state progress và các setter vì không có vùng render đọc giá trị; trạng thái xử lý vẫn do isProcessing/error quản lý.
- desktop/src/components/dieline-tool/ShadowFloor.tsx
  - bỏ import DEFAULT_BACKGROUND_PRESET_ID không dùng.

Không thay đổi geometry, binding map, watermark engine hoặc lớp nền 3D. Lỗi immutability hook đã có từ trước trong ShadowFloor được giữ lại, không mở rộng phạm vi lô.

## Verify

- ESLint hẹp: các finding no-unused-vars của lô hết; còn các any/lifecycle baseline đã ghi nhận.
- Regression render wiring: 21/21 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.376 → 1.369, warnings 106 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Chỉ loại symbol không có consumer live; không thay đổi hành vi hiển thị hoặc xử lý tài liệu.
