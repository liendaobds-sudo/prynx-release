# BÁO CÁO AUDIT TÁCH CÔNG CỤ CHỮ & FONT

**Ngày:** 2026-07-28
**Phạm vi:** UI Preflight trong workspace; không đổi engine/backend xử lý PDF.
**Quyết định đã duyệt:** giữ Preflight làm bảng chẩn đoán tổng hợp, tách xử lý chữ/font thành công cụ riêng.

## Tóm tắt điều hành

Preflight hiện trộn 16 quy tắc chẩn đoán với 6 action sửa PDF. Hai quy tắc font (`FONT_NOT_EMBEDDED`, `TEXT_DETECTED`) cần ở lại vì Preflight phải trả lời “file có sẵn sàng in không”; hai action font không nên nằm trong pipeline sửa chung vì OUTLINE là thao tác phá huỷ khả năng sửa chữ, còn EMBED không thể tự thay font thiếu một cách an toàn trên bản no-GS.

## Phát hiện

| Mã | Mức | Bằng chứng | Kết luận |
|---|---|---|---|
| §F.1 | P2 / S | `PreflightTab.tsx` không có import sản phẩm, chỉ có test riêng; registry mở `ImpositionTab → PreprocessingRouter → PreflightTool`. | Xoá bản standalone cũ, giữ `PreflightTool` làm nguồn duy nhất. |
| §F.2 | P1 / M | `PreflightTool.tsx` chứa đồng thời 16 rules và 6 actions; `OUTLINE_FONTS`/`EMBED_FONTS` nằm cạnh sửa màu, ảnh và metadata. | Tách “Chữ & Font”; Preflight chỉ giữ rule và nút điều hướng. |
| §F.3 | P1 / S | `EMBED_FONTS` bản no-GS chỉ sao chép khi file vốn đã đủ font; font thiếu thật bị từ chối an toàn để không thay sai mặt chữ. | Không tiếp tục quảng bá “Nhúng Font” như một sửa lỗi tự động. Hiển thị trạng thái và yêu cầu file có font gốc. |
| §F.4 | P2 / M | Convert CMYK, giảm DPI và metadata đã có công cụ riêng nhưng vẫn lặp trong action grid Preflight. | Ghi nhận cho lô sau; không mở rộng phạm vi đợt tách chữ/font. |

## Thiết kế đã chốt

1. Preflight giữ toàn bộ rule, gồm hai rule font.
2. Công cụ “Chữ & Font” dùng lại `/preflight/inspect` và action `OUTLINE_FONTS`; không tạo engine thứ hai.
3. Chỉ cho Khóa chữ sau khi đã quét và không có font chưa nhúng.
4. Preflight bỏ `OUTLINE_FONTS`/`EMBED_FONTS` khỏi pipeline chung, thay bằng nút mở công cụ chuyên dụng.
5. Routing và test dùng `font_tools` làm ID duy nhất.

## Thứ tự triển khai

- Lô 1: hợp nhất nguồn Preflight và dọn code chết.
- Lô 2: khai báo routing `font_tools` và khoá bằng test.
- Lô 3: UI Chữ & Font + nội dung song ngữ.
- Lô 4: nối router/registry, chạy typecheck và toàn bộ frontend test.
