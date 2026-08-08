# SỬA BÓNG VÀ QUỸ ĐẠO ĐƯỜNG BẾ — ẢNH AI NHIỀU TEM — 2026-08-08

## Ca tái hiện

- Nguồn user xác nhận: `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpeg`
  (file hiện có trên Desktop cùng stem, đuôi `.jpg`, 1313 × 1198 px).
- Artifact lỗi: `tem_tach_cutcontour3.pdf`.
- Bộ kiểm tra đường bế dùng 9 crop Alpha trích từ đúng artifact của khách ở kích
  thước vật lý 72 DPI: `tmp/research/ai_9pages/ai_9pages_72dpi_source.pdf`.

## Kết luận sai đã bị hủy

Lượt sửa trước chỉ kiểm tra rằng PDF có lệnh cubic, tiếp tuyến G1, không có lệnh
ngắn và không có khớp lớn hơn 1°. Ảnh render phóng lớn do user cung cấp chứng minh
các điều kiện đó chưa đủ: Catmull có tay nắm quá ngắn tạo thân đường gần như đoạn
thẳng, chỉ bo vi mô tại node. Kết quả là một polyline được “bọc” bằng Bézier và vẫn
nhìn gãy rõ.

Từ lượt này, artifact chỉ được nhận khi qua cả hai chốt:

1. đọc lại content stream PDF sau writer và đo độ nhảy độ cong;
2. render 600 DPI, soi trực tiếp đủ 9 trang.

## Lô AI-A — bóc bóng dính component

### File

- `backend/app/workers/sticker_sheet_engine.py`;
- `backend/tests/test_sticker_sheet_engine.py`.

### Thay đổi

1. Mỗi instance được dò riêng dải xám trung tính nối với biên ngoài của mask, thay
   vì chỉ nhị phân hóa `raw_alpha >= 128`.
2. Chỉ nhận lượt bóc khi mép sau xử lý trắng và sạch hơn rõ rệt, diện tích còn lại
   hợp lệ, component không vỡ và tổng số instance không đổi.
3. Regression bảo vệ viền trắng, antialias, đỉnh sao, hõm lõm, thứ tự 9 tem và
   artwork xám không có vỏ trắng.

### Giới hạn bằng chứng

BiRefNet-lite chưa được chạy lại end-to-end trên toàn JPEG trong phiên này vì
DirectML hết bộ nhớ và CPU fallback `bad allocation`. Phần bóc bóng được xác nhận
bằng fixture deterministic và dữ liệu RGB/Alpha trích từ artifact; không tuyên bố
đã tái hiện thành công inference đầy đủ trên máy hiện tại.

## Lô AI-B — spline C2 thật cho Alpha DPI thấp

### File

- `backend/app/workers/sticker_engine.py`;
- `backend/tests/test_sticker_engine_e2e.py`.

### Thay đổi

1. Ảnh Alpha thô khoảng 72–100 DPI có thêm họ ứng viên B-spline cubic tuần hoàn.
   Từng khoảng knot được đổi chính xác sang cubic Bézier PDF; quỹ đạo liên tục C2,
   không còn cubic tay nắm ngắn giả mượt.
2. Profile sigma, độ lùi và RMS đo theo pixel ảnh nguồn. Không có hard-cap node.
3. Mọi ứng viên vẫn phải giữ topology, nằm trong safe-envelope Alpha và qua hành
   lang sai lệch vật lý. Ngân sách spline tối đa là `min(1,20 mm, 3,4 pixel nguồn)`;
   ảnh từ 150 DPI trở lên không đi qua nhánh này nên hợp đồng lùi 0,15 mm cũ giữ nguyên.
4. Nếu phép lùi 0,03 mm tách ra một râu nối cổ gần-zero, chỉ được bỏ râu khi tổng
   satellite và toàn sai khác đều không quá `1e-4` diện tích. Đây là ca trang 9;
   topology cuối vẫn là một tem và đường cuối vẫn phải nằm trong Alpha an toàn.
5. Bộ xếp hạng chuẩn hóa nhiễu độ cong C2 cỡ `1e-13` về 0, sau đó dùng dao động
   cong thật và số segment để chọn ứng viên.
6. Regression 72 DPI có thêm râu cổ một pixel và khóa P95/max độ nhảy độ cong trên
   chính lệnh PDF sau lượng tử hóa; kiểm “toàn cubic/G1” đơn thuần không còn đủ.

## Artifact đúng 9 tem sau sửa

Artifact: `tmp/research/ai_9pages/ai_9pages_72dpi_cut_v3.pdf`.

| Trang | Cubic | Lệnh <0,25 mm | Khớp >1° | Ngắn nhất (mm) | P95 nhảy độ cong (/mm) | Max nhảy độ cong (/mm) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 96 | 0 | 0 | 1,050 | 0,000049 | 0,000251 |
| 2 | 88 | 0 | 0 | 0,406 | 0,000204 | 0,000956 |
| 3 | 247 | 0 | 0 | 0,328 | 0,000533 | 0,003714 |
| 4 | 147 | 0 | 0 | 0,360 | 0,000217 | 0,003417 |
| 5 | 148 | 0 | 0 | 0,526 | 0,000259 | 0,001034 |
| 6 | 116 | 0 | 0 | 0,682 | 0,000227 | 0,000655 |
| 7 | 97 | 0 | 0 | 0,799 | 0,000085 | 0,000518 |
| 8 | 153 | 0 | 0 | 0,627 | 0,000186 | 0,001104 |
| 9 | 135 | 0 | 0 | 0,443 | 0,000301 | 0,000886 |

Cả 9 trang đã được render 600 DPI và soi trực tiếp. Các mặt thẳng nối kiểu đa giác
trong artifact trước không còn xuất hiện. Trang 9 không còn rơi về 447 cubic G1;
đường C2 còn 135 đoạn và không có lệnh ngắn.

## Verify

- `py_compile backend/app/workers/sticker_engine.py`: đạt;
- machine path + engine E2E + sheet engine: **153 passed**, 1 warning Pydantic có sẵn;
- API ảnh AI nhiều tem: **13 passed**, 2 warning dependency/config có sẵn;
- ma trận gồm Alpha 72/150/300 DPI, PDF sau writer, shadow synthetic, topology,
  tim, hoa, gear, hourglass và các kích thước đã khóa trước đó.

## Phạm vi kết luận

- Trạng thái đường bế: **AUTO + ARTIFACT + VISUAL 600 DPI**.
- Chưa chạy controller/máy bế vật lý, nên không tuyên bố runtime máy thật.
- Artifact 9 trang chứng minh riêng nhánh tạo đường C2 trên đúng 9 Alpha crop của
  khách; nó không thay thế bằng chứng inference BiRefNet end-to-end còn thiếu do RAM.
