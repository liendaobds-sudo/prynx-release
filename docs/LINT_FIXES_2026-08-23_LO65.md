# Lô lint P2.61 — 2026-08-23

## Phạm vi

Loại 74 lỗi ESLint khỏi 5 file thuộc engine bình bản:

- `InstructionSerializer.ts`: dùng contract thật của surface/slot và các field
  settings theo nhánh union; giữ nguyên JSON key, placement, mark và đơn vị.
- `Renderer.ts`: dùng type thật `PDFPage`, `PDFEmbeddedPage`, `Color`, trim box
  và slot booklet.
- `NupRenderer.ts`: dùng `NupCell`/`NupBlock`, source-page detail và contract
  cục bộ cho các field N-up legacy.
- `MarksRenderer.ts`: dùng `Color` của pdf-lib và contract cục bộ cho thiết lập
  dấu cắt/booklet; vẫn giữ guard optional cũ cho caller JavaScript ngoài hợp đồng.
- `NupGridSolver.ts`: khai báo shape params của JSON và giữ chữ ký legacy bằng
  `void _waistRatio` mà không đổi thứ tự đối số/công thức.

Không đổi thứ tự vẽ PDF, màu/opacity/font, tọa độ, công thức xếp, đơn vị, số ô,
thứ tự chiến lược hay định dạng instruction JSON. Các diff LO29/LO33/LO48 đã
được giữ nguyên.

## Verify

- ESLint hẹp 5 file: 0 lỗi, 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression chung serializer/grid/virtual map: 4 file, 61/61 test đạt.
- N-up parity với Rust: 14/14 đạt.
- Regression mở rộng process handlers/guillotine/serializer: 71/71 đạt.
- Smoke `MarksRenderer` bằng pdf-lib: tạo PDF hợp lệ 856 bytes.
- Renderer.ts và NupRenderer.ts có JavaScript emit token trước/sau giống nhau.
- `git diff --check`: đạt.
- `npm run lint:budget`: 908 → 834 errors; warnings giữ 103; gate đạt.

## Rủi ro còn lại

- Chưa chạy GUI và chưa so sánh trực quan/vectơ PDF trước/sau.
- Các contract cục bộ tại boundary legacy không thêm validation runtime; mục
  tiêu của lô là siết type nhưng giữ nguyên cách dữ liệu cũ được đọc. Guard
  `drawMarksNup` với settings thiếu đã được kiểm smoke và vẫn dùng mặc định như
  trước.

## Kết luận

Lô type/contract hoàn tất ở mức kiểm thử tự động. Chưa commit, push hoặc build
release.
