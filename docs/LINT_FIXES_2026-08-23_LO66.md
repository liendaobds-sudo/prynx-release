# Lô lint P2.62 — 2026-08-23

## Phạm vi

Loại 8 lỗi `no-explicit-any` khỏi 3 file thuần engine bình bản:

- `SpreadPlacer.ts`: dùng `PDFPage`, `PDFEmbeddedPage | null` và `Color` thật
  của pdf-lib cho helper dấu xén/dấu gấp và danh sách spread nhúng.
- `ProductAdvisor.ts`: dùng `NupCell`/`NupBlock` thật khi đọc kết quả solver để
  lấy trạng thái xoay, số cột và số hàng.
- `SettingsTypes.ts`: mô tả shape params theo từng trang là record mở, tương
  thích các loại khuôn có key khác nhau.

Không đổi công thức xếp/fold, tọa độ, màu nét, đơn vị, thứ tự render hay payload.
Diff dọn mã chết có sẵn trong `SpreadPlacer.ts` từ lô trước được giữ nguyên và
không tính vào thay đổi hành vi của LO66.

## Verify

- ESLint hẹp 3 file: 0 lỗi, 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression ProductAdvisor/apply recommendation/N-up parity/serializer: 4 file,
  46/46 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo chuẩn hóa LF/CRLF ở file cũ.
- `npm run lint:budget`: 834 → 826 errors; warnings giữ 103; gate đạt.

## Rủi ro còn lại

- Chưa chạy GUI/runtime PDF trực quan; thay đổi là type-only tại boundary và đã
  phủ các consumer solver/serializer bằng test tự động.
- `detectedShapeParamsByPage` vẫn là object mở theo hợp đồng legacy; không thêm
  validation runtime để tránh đổi cách nhận shape params cũ.

## Kết luận

Lô type/contract hoàn tất ở mức kiểm thử tự động. Chưa commit, push hoặc build
release.
