# Lô lint P2.17 — 2026-08-23

## Phạm vi

Siết kiểu dữ liệu worker đọc metadata kẽm:

- desktop/src/workers/plateInfoWorker.ts
  - thêm readPdfInfo với contract tối thiểu decodeText/value;
  - giữ nguyên thứ tự fallback và kết quả chuỗi;
  - đổi catch ngoài sang unknown và lấy message an toàn.

Không đổi payload postMessage hoặc cách duyệt trang PDF.

## Verify

- ESLint hẹp: file sạch.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.353 → 1.348, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Worker không còn any ở biên PDF metadata, nhưng vẫn tương thích với các object PDFium/pdf-lib hiện tại.
