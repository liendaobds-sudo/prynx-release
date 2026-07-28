# NHẬT KÝ TÁCH CÔNG CỤ CHỮ & FONT

**Ngày:** 2026-07-28
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_TACH_CONG_CU_CHU_FONT_2026-07-28.md`

## Kết quả

- Chỉ còn một luồng Preflight đang được sản phẩm sử dụng: `PreflightTool`.
- Đã xoá `PreflightTab` cũ và test chỉ phục vụ bản cũ.
- Đã tạo công cụ riêng **Chữ & Font**, nhưng dùng lại backend Preflight hiện có.
- Preflight vẫn kiểm tra lỗi font; thao tác khóa chữ được chuyển sang công cụ chuyên dụng.
- Không còn đưa “Nhúng Font” vào danh sách sửa tự động vì bản no-GS không thể tự thay font thiếu một cách an toàn.

## Các lô đã thực hiện

### Lô 1 — Hợp nhất Preflight

1. Xoá `desktop/src/components/PreflightTab.tsx`.
2. Xoá `desktop/src/components/__tests__/PreflightTab.provider.test.tsx`.
3. Dọn chú thích cũ trong `desktop/src/lib/dieline/saveJsPdfDoc.ts`.

### Lô 2 — Khai báo tuyến công cụ

1. Thêm ID `font_tools` vào kiểu và ánh xạ panel.
2. Cho phép workspace mở công cụ mới.
3. Bổ sung test khóa tuyến điều hướng.

### Lô 3 — Giao diện và nội dung

1. Thêm `FontToolsTool.tsx`.
2. Bổ sung nội dung tiếng Việt và tiếng Anh.
3. Gỡ hai action font khỏi pipeline sửa chung của Preflight.
4. Thêm thẻ điều hướng từ Preflight sang **Chữ & Font**.

### Lô 4 — Tích hợp và chống hồi quy

1. Nối công cụ mới vào router và dashboard.
2. Thêm shortcut trong danh mục công cụ.
3. Thêm test cho tuyến registry và hai trạng thái font quan trọng.

## Hành vi an toàn

- Công cụ phải quét file trước khi cho phép **Khóa chữ**.
- Nếu còn font chưa nhúng, nút **Khóa chữ** bị vô hiệu hóa và UI yêu cầu quay lại file nguồn có font gốc.
- Nếu font đã đủ, thao tác dùng action `OUTLINE_FONTS` hiện có; không tạo engine xử lý PDF thứ hai.

## Xác minh

- TypeScript typecheck: đạt.
- Test tuyến công cụ và công cụ font: 18/18 đạt.
- Toàn bộ frontend: 130 tệp test đạt; 1.145 test đạt, 2 test bỏ qua.
- Lint riêng các tệp mới và test/tuyến liên quan: đạt.
- `git diff --check`: đạt.
- Lint toàn kho vẫn báo nợ nền cũ (1.643 vấn đề); riêng `types.ts` có `@ts-nocheck` và `any` đã tồn tại, không do thay đổi `font_tools`.
