# Nhật ký hoàn thiện — Đường viền cắt cho Dàn nhiều mẫu và Bình trang

## Phạm vi đã chốt

- Áp dụng cho công cụ **Bình bài cắt xén N-Up** ở cả hai chế độ: **Dàn nhiều mẫu** (`nup`) và **Bình trang** (`step_repeat`/`repeat`).
- Độc lập với dấu xén; mặc định tắt.
- Mặc định theo thành phẩm (Trim), đen K100, dày `0,3 mm`.
- Cho chọn Trim/Bleed, màu và độ dày `0,1–2,0 mm`.
- Không áp dụng cho Booklet, tem bế, CNC hoặc Bình nguyên tấm decal (page-sheet).

## Các lô thay đổi

### §CB.1 — Hợp đồng cấu hình và trạng thái giao diện

- Thêm cấu hình `cutBorder` vào state N-Up, persist và profile riêng của công cụ.
- Preset mới lưu đủ cấu hình; preset cũ thiếu trường sẽ nạp về trạng thái tắt.
- Payload public dùng bốn trường phẳng: `cutBorderEnabled`, `cutBorderPosition`, `cutBorderColor`, `cutBorderThickness`.
- Không gửi bốn trường này cho tem bế, CNC hoặc Bình nguyên tấm decal.

### §CB.2 — Điều khiển và preview

- Thêm ô chọn **Đường viền cắt** trong Thiết lập nâng cao của cả Dàn nhiều mẫu và Bình trang.
- Khi bật, hiện màu, độ dày và vị trí Trim/Bleed.
- Cảnh báo khi khe giữa bài nhỏ hơn `2 × bleed + độ dày`, vì các nét Bleed có thể chồng nhau.
- Preview vẽ từ cell tuyệt đối do backend trả về, đúng cho bài xoay và layout nhiều kích thước.
- Đổi màu, độ dày hoặc Trim/Bleed chỉ render lại overlay; không gọi lại solver/API bố cục.
- Bổ sung nội dung tiếng Việt và tiếng Anh.

### §CB.3 — Renderer PDF

- Chuẩn hóa HEX sang process CMYK; `#000000` luôn thành K100 thuần `(0, 0, 0, 1)`.
- Vẽ hình chữ nhật vector sau toàn bộ artwork và trước dấu xén để bleed của bài sau không che nét bài trước.
- Trim dùng đúng `trim_rect` cuối của placement; Bleed nở đều bốn cạnh theo bleed thực tế.
- Chỉ nối cấu hình mới vào tuple worker khi viền thật sự bật, giữ nguyên hợp đồng đuôi tuple của các job cũ.
- Gate phòng thủ tại renderer để không rò sang tem bế, CNC hoặc Bình nguyên tấm decal.
- API trả `422` trước khi xếp job khi màu, vị trí, độ dày hoặc kiểu dữ liệu không hợp lệ.

### §CB.6 — Mở Bình trang xuyên suốt

- Dùng policy frontend chung `canUseCutBorder()` để thiết lập, preview và payload không còn tự quyết định khác nhau.
- Cho phép `activeTool=nup` với `taskMode=nup|step_repeat`; vẫn chặn các workflow ngoài phạm vi và page-sheet.
- Backend chấp nhận `taskMode=step_repeat` cùng `layoutType=repeat`, dùng nguyên hình học Trim/Bleed và renderer của N-Up.
- Thêm test dương riêng cho Bình trang và test xuyên engine → worker để khóa cấu hình màu, độ dày, vị trí và bleed.

## Bằng chứng kiểm thử

- Python `py_compile`: đạt.
- TypeScript typecheck: đạt.
- Frontend trọng tâm: `27` test đạt.
- Toàn bộ frontend: `182` file test đạt, `1.826` test đạt, `2` test bỏ qua.
- Test riêng đường viền backend: `28` test đạt.
- Hồi quy backend liên quan N-Up: `71` test đạt.
- Snapshot store được cập nhật có chủ đích; diff chỉ thêm object mặc định `cutBorder` và khóa persist `cutBorder`.
- `git diff --check`: sạch.
- Lint toàn repo chưa phải gate xanh: cấu hình hiện báo hơn `1.400` lỗi và hơn `100` cảnh báo trên nhiều file có sẵn; đợt này không mở rộng phạm vi để xử lý khoản nợ lint đó.

## Kiểm tra runtime thực tế

- Đã chạy với một PDF kiểm thử nội bộ ở chế độ `step_repeat`/`repeat`.
- Cấu hình: viền Trim, đen, dày `0,7 mm`; kết quả có `16` placement.
- PDF xuất thành công, một trang và đủ `16` artwork; các nét viền được ghi sau artwork.
- Ảnh raster kiểm tra cho thấy đủ viền quanh cả `16` voucher, không co hoặc méo hình.

## Chưa thực hiện trong đợt này

- Không build release hoặc đưa bản phát hành lên GitHub.
- Không commit hoặc push.
- Chưa chạy lại bản desktop đã đóng gói; cần chạy dev hoặc build nội bộ để giao diện bản cài nhận thay đổi mới.
