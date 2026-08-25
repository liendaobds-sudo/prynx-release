# Tiến độ sửa tốc độ nhận diện tách tem — 2026-08-22

## Lô A — hoàn tất

Phạm vi: giảm độ trễ chuẩn bị/độ trễ cảm nhận ở frontend, không đổi backend suy luận, mask hay hình học đường bế.

- desktop/src/lib/stickerSheetApi.ts
  - Thêm tùy chọn inspect preview: 'defer'.
  - Tách helper tải preview nguồn để caller có thể tải nền.
- desktop/src/components/preprocess-tools/stickerSheetStore.ts
  - Ảnh raster dùng preview cục bộ ngay.
  - PDF nhận manifest trước, tải preview nguồn nền; request nhận diện không chờ lượt tải này.
  - Giữ cancellation/session guard và URL lifecycle.
- desktop/src/components/preprocess-tools/StickerSheetWorkspace.tsx
  - Không dựng thẻ img từ URL PDF khi preview PNG chưa sẵn sàng.
- desktop/src/components/preprocess-tools/StickerSheetPanel.tsx
  - Hiển thị stage và thời gian đã chờ; khi AI đang chạy vẫn nói rõ preview nguồn tải nền.
- desktop/src/components/preprocess-tools/stickerSheetStore.test.ts
  - Regression: detect PDF được gọi trước khi promise preview hoàn tất.

## Verify

- npm run typecheck: đạt.
- vitest 4 suite liên quan: 4 file passed, 58 test passed.
- ESLint riêng 5 file Lô A: đạt.
- npm run lint toàn desktop: còn backlog ngoài phạm vi (1.469 errors, 109 warnings), không phải lỗi do Lô A.

## Giới hạn còn lại

Lô A không làm giảm thời gian cold-start của BiRefNet. Đo audit trước đó vẫn giữ nguyên: AI CPU lạnh khoảng 10–11 giây, cache nóng khoảng 34 ms. Nếu cần giảm phần này, Lô B phải có quality gate riêng trước khi warm session/model hoặc dùng preview model/resolution khác.
