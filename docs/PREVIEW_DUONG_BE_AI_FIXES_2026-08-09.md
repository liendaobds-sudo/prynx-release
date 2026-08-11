# Preview đường bế AI — nhật ký sửa 2026-08-09

## Kết quả

- UI không còn dùng `alphaThreshold` dưới tên gây hiểu nhầm `Bám biên AI`.
- Người dùng có bốn slider thật: `Độ mượt`, `Sức căng`, `Bám sát hình gốc`, `Lọc chi tiết rời`.
- Kéo slider làm backend dựng lại CutContour; workspace vẽ cubic bằng SVG theo đúng zoom/pan hiện tại.
- Mask pixel cũ bị ẩn khi đã có SVG CutContour, nhưng canvas vẫn nhận thao tác cọ và hit-test.
- Preview và export dùng chung `build_alpha_cutline_geometry()`; export truyền `path_groups` vào `StickerEngine` và ghi đúng các cubic đó vào spot color `CutContour`.
- Manual edits, DPI, Offset, chế độ cắt, giữ lỗ và tuning đều nằm trong request preview; response cũ không thể ghi đè lựa chọn mới.
- Tuning được lưu riêng theo từng trang/thumbnail và gửi riêng khi export nhiều trang.

## Chốt hình học

- Fitter live thử periodic spline C2 trước, Catmull G1 machine-safe sau.
- Mọi candidate giữ topology và nằm trong envelope Hausdorff theo DPI + mức bám sát.
- Mọi ring phải liên tục, góc nối không quá 1° và không có lệnh dao ngắn dưới 0,25 mm.
- Mức bám sát cực đoan không được ép engine quay về polyline dày node; dùng candidate machine-safe gần nhất đang được hiển thị.
- Không giới hạn node bằng hard-cap; số đoạn được quyết định bởi kích thước pixel nguồn, độ mượt, guard hình học và kiểm tra chuyển động dao.

## Đo trên ảnh khách hàng

File: `C:\Users\Khanh Pham\Desktop\1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg`

- 1313 × 1198 px, 9 tem.
- Preview mặc định: khoảng 0,61–0,65 giây, 915 cubic.
- Mỗi tem: 58–176 cubic.
- Đoạn ngắn nhất: 0,656 mm.
- Đoạn dưới 0,25 mm: 0.
- Node hở: 0.
- Góc nối lớn nhất: 0°.
- PDF thật: 9 trang, khoảng 8,03 giây khi verify tuần tự; 915/915 cubic khớp preview.

## Verify

- Hồi quy backend geometry/preview/export/API/engine tem: 181 test đạt.
- Frontend `preprocess-tools` + API tem: 17 file, 136 test đạt.
- TypeScript typecheck, ESLint phạm vi thay đổi và JSON i18n Việt/Anh đạt.
