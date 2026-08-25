# Lô lint P2.11 — 2026-08-23

## Phạm vi

Sửa lỗi lifecycle React trong PageResizer bằng state gắn với identity file:

- desktop/src/components/preprocess-tools/PageResizerTool.tsx
  - không gọi setState đồng bộ ở đầu effect;
  - chỉ hiển thị danh sách trang trong suốt khi inspection thuộc đúng PDF hiện tại;
  - giữ reset ngầm qua giá trị dẫn xuất khi đổi file hoặc không có file;
  - thêm guard null rõ ràng để tránh đọc state rỗng.
- desktop/src/components/preprocess-tools/PageResizerTool.test.ts
  - regression đổi từ PDF trong suốt sang PDF opaque;
  - kết quả request cũ không được làm lộ lại nút Resize theo nội dung.

## Verify

- ESLint hẹp: sạch, lỗi react-hooks/set-state-in-effect đã hết.
- Regression: PageResizerTool.test.ts 20/20 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.383 → 1.382, warnings 106 → 106; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Đã loại bỏ render dây chuyền và khóa rò state transparency giữa các tài liệu mà không thay đổi contract backend.
