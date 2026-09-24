# Nâng cấp chọn trường QR/mã vạch — 2026-09-23

## Phạm vi đã được duyệt

Người dùng yêu cầu thực hiện toàn bộ kế hoạch trong hội thoại: chọn QR/barcode có sẵn trong PDF từ Corel/Illustrator, dạng ảnh hoặc vector; chọn nhiều path; nhận diện làm gợi ý; xử lý rõ trường hợp ảnh nền phẳng. Tất cả thao tác chạy trong PrynX. Không yêu cầu marker/layer riêng. Không commit thêm.

Baseline đầu lượt: `73562b1`, working tree sạch. Checkpoint là trạng thái mã nguồn, không phải chứng nhận tất cả test của dự án đã đạt.

## Bằng chứng / hợp đồng cần giữ

| Mục | Bằng chứng trong mã | Thay đổi |
| --- | --- | --- |
| VDP-PICK.1 | `LivePageFrame.tsx` lọc `type === 'text'`; `/pick-text-field` gọi worker luôn tạo text | Thêm picker ảnh/vector độc lập; giữ đường text |
| VDP-PICK.2 | `geometry_reader.list_objects` trả `drawIndex`, `bbox`, `matrix`; `stream_editor.delete_objects` hỗ trợ image/vector và hủy khi mapping mơ hồ | Gửi tập object cụ thể, xóa bằng pikepdf trên bản sao |
| VDP-PICK.3 | `vdp-template-cleaned` là sự kiện toàn cục; chưa có chủ sở hữu tab/tài liệu | Gắn chủ sở hữu, từ chối kết quả cũ; tránh thêm field trước khi phôi được đổi thành công |
| VDP-PICK.4 | `pageDim` là px@96, bbox object là PDF pt; field VDP hiện dùng CSS-mm | Quy đổi ở biên API, kiểm CropBox và tọa độ bằng test |
| VDP-PICK.5 | Barcode có thể tách từng path; ảnh nền có thể chứa toàn bộ thiết kế | Chọn nhiều/kéo khung chỉ lấy object nằm trọn trong vùng, không tự gom theo layer hay xóa cả nền |

## Các phần triển khai / kiểm chứng

### Trạng thái triển khai lượt này

- Đã có `VdpCodePicker` trong desktop: click/Shift-click/kéo vùng cho object ảnh và vector; không tự gom layer.
- Đã có API `pick-object-field` và worker fail-closed: chỉ ghi phôi tạm sau khi map/xóa được toàn bộ object đã chọn.
- Đã có API `detect-object`: QR nhận diện trên vùng raster; nhóm vector thanh dọc chỉ được gợi ý barcode Code128. Nhận diện thất bại không chặn chọn thủ công.
- Ảnh phủ toàn trang bị chặn khi click/kéo vùng để tránh xóa toàn bộ artwork; cần tách QR/barcode thành object riêng trong PDF nguồn.
- Đã thêm test PDF ảnh/vector và test hình học picker; không tạo commit mới.

1. Backend: worker + API + test PDF ảnh/vector/nhóm; lỗi phải không tạo phôi dở dang. Không thêm pool/cap/cache. Threadpool cho công việc blocking, guard cho PDFium.
2. Desktop: component chọn ảnh/vector, Shift chọn nhiều, khung kéo, bảng chọn QR/barcode/DataMatrix, loại mã vạch và tên trường. Highlight cụ thể trước khi chuyển; test hành vi + typecheck Windows.
3. Tích hợp: ghép phôi và field trong cùng thao tác, chặn double-submit/stale revision/tab nền; kiểm tương thích text/auto-tag và data binding.
4. Nhận diện: render vùng chọn + OpenCV, chỉ gợi ý loại; không đọc được vẫn chọn thủ công. Không bắt decoder thành điều kiện chuyển field.
5. Nghiệm thu: pytest VDP/picker, Vitest liên quan, tsc/lint; kiểm artifact PDF sau chuyển và sau xuất. Ghi riêng các bước runtime Tauri chưa thực hiện được.

Ảnh toàn trang: không phục hồi được artwork nằm dưới mã từ pixel đã flatten. Bản nâng cấp phải hướng dẫn tách QR/barcode riêng ở file nguồn khi vùng chọn chỉ là một phần của ảnh nền, thay vì tự che trắng hoặc xóa ảnh cả trang.
