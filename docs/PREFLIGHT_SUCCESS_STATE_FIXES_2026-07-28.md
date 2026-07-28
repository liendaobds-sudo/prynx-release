# Sửa trạng thái thành công công cụ tiền xử lý — 2026-07-28

## Phạm vi

Sửa lỗi thông báo thành công biến mất ngay sau khi PDF kết quả được cập nhật lên viewer.

Mã truy vết: `§PF.1` — mức P2, effort S.

## Thay đổi

- `HairlinesTool.tsx`: giữ kết quả của file nét mảnh vừa tạo.
- `ConvertColorsTool.tsx`: giữ kết quả chuyển đổi màu vừa tạo.
- `TrapPresetsTool.tsx`: giữ thông báo áp dụng overprint vừa hoàn tất.
- `SavePdfxTool.tsx`: giữ thông báo xuất PDF/X vừa hoàn tất.
- `MetadataTool.tsx`: đọc lại metadata của file đầu ra nhưng không xóa thông báo lưu thành công.
- Khi người dùng mở một file khác không phải đầu ra vừa tạo, trạng thái vẫn được xóa như trước.

## Kiểm tra

- TypeScript typecheck: đạt.
- Vitest phạm vi: 2 file test, 7/7 test đạt (gồm Chữ & Font và 5 công cụ nêu trên).
- `git diff --check`: đạt.
- ESLint phạm vi còn báo các khoản nợ có sẵn: `any` và quy tắc setState trong effect đã tồn tại từ trước; file test mới không phát sinh lỗi lint.