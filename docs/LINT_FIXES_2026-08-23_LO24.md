# Lô lint P2.20 — 2026-08-23

## Phạm vi

Siết type WatermarkTool ở hai biên quan trọng:

- desktop/src/components/preprocess-tools/WatermarkTool.tsx
  - embedded watermark tách rõ PDFEmbeddedPage và PDFImage;
  - các RichSelect narrowing về union literal (target, scale, vị trí);
  - bắt lỗi unknown;
  - tạo Blob từ ArrayBuffer copy có kiểu hợp lệ.
- Giữ nguyên thuật toán watermark, kích thước, vị trí, lớp z-index và callback commit.

Cảnh báo dependency setWatermarkPreview được giữ lại để xử lý cùng lifecycle preview.

## Verify

- ESLint hẹp: 0 error; còn 1 warning dependency hook baseline.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.342 → 1.335, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Watermark không còn any ở các nhánh UI/embedded object vừa chạm; protocol output giữ nguyên.
