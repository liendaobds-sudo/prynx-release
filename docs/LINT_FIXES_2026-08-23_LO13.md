# Lô lint P2.9 — 2026-08-23

## Phạm vi

Thay any bằng contract/narrowing có kiểm tra runtime trong 3 file:

- desktop/src/components/OutputPreviewTab.tsx
  - dùng unknown cho ba nhánh bắt lỗi;
  - thêm helper lấy thông báo lỗi có fallback i18n;
  - bổ sung dependency t cho callback chuyển Spot → CMYK.
- desktop/src/components/ReportModal.tsx
  - đọc summary: Record<string, unknown> bằng helper số và lọc cảnh báo chuỗi;
  - không ép kiểu Record<string, any>.
- desktop/src/components/preprocess-tools/PageResizerTool.tsx
  - chuẩn hóa lựa chọn DPI và chế độ raster về union hữu hạn trước khi ghi settings.

Không đổi API backend hoặc thuật toán xử lý. Cảnh báo react-hooks/set-state-in-effect của PageResizer và cảnh báo cleanup ref của Output Preview được giữ lại để xử lý riêng vì liên quan lifecycle.

## Verify

- ESLint hẹp: các no-explicit-any của lô hết; còn 1 lỗi lifecycle và 1 warning hook đã ghi nhận từ trước.
- Regression: cùng nhóm Output/Preprocess đạt trong lượt verify chung.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.392 → 1.386, warnings 107 → 106; budget gate đạt.
- git diff --check: đạt sau chuẩn hóa line ending.
- Không build release, không commit, không push.

## Kết luận

Lô tăng an toàn kiểu dữ liệu và xử lý lỗi thực tế; không dùng cast any để che dữ liệu không hợp lệ.
