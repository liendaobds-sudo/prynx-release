# Thu gọn nhóm thanh kéo Bù xén — 2026-09-10

Yêu cầu: gom các thanh kéo thành một mục, bỏ giải thích bên dưới; chỉ sửa
UI, phần còn lại đề xuất để người dùng duyệt. Không đổi logic đường bế.

## Đã làm

- Gom Độ bo cong, Khử răng cưa và Simplify vào một khung **Tinh chỉnh đường
  cắt**, ngay sau các thiết lập Đường cắt / Tràn lề & Đặc ruột hiện có.
- Đồng bộ hàng tên/giá trị, khoảng cách và đường phân cách; bỏ khung riêng
  tô màu của Simplify.
- Bỏ hai đoạn hướng dẫn dưới Khử răng cưa/Simplify và chú thích hai đầu
  thanh Độ bo cong. Bỏ cả aria-describedby trỏ vào phần đã gỡ; label vẫn đủ.
- Giữ nguyên số đo kết quả, trạng thái đang cập nhật, lỗi và cảnh báo nghiệp vụ.
- Độ bo cong vẫn chỉ hiện khi chọn Góc tròn và không ở mode Alpha. Nhóm có
  hai thanh ở Alpha/Giữ nguyên/Góc nhọn, ba thanh khi Góc tròn; không hiện
  ở Xén vuông góc hoặc Không vẽ đường cắt.
- Không đổi giá trị mặc định, min/max/step, disabled, handler, scope,
  preview/payload/recipe hoặc backend.

File thay đổi: `StickerTool.tsx`, `StickerTool.ui.test.tsx`, thêm một khóa
tiêu đề tương ứng vào `vi.json`/`en.json`, và nhật ký này.

## Verify

- Baseline trước sửa: 105 Vitest đạt trên 5 file liên quan.
- Sau sửa: **108 Vitest đạt**, Windows typecheck đạt, diff-check đạt.
- So AST với bản chụp đầu lượt: mọi statement ngoài JSX trả về của
  StickerTool giữ nguyên; value/min/max/step/disabled/onChange của cả ba
  thanh kéo khớp nguyên bản.
- Chưa kiểm pixel-layout trong Tauri; không build installer hoặc commit.

## Đề xuất tiếp theo — chưa áp dụng

1. Thiết lập chính chia gọn thành **Đường cắt** (nguồn biên, co/giãn, kiểu
   góc) và **Tràn lề & nền** (độ tràn, màu, đặc ruột/bỏ nền).
2. Đưa lựa chọn ít dùng như Chỉ trang đầu, Crop trang, Nhận dạng hình vào
   **Nâng cao** có thể thu gọn; không đổi giá trị hoặc phạm vi xử lý.
3. Giảm khung lồng khung và giải thích thường trực; trợ giúp mở khi cần.
   Giữ lỗi/cảnh báo cần hành động luôn nhìn thấy.
4. Giữ nút Thực thi và trạng thái ngắn ở chân panel để không cần cuộn tìm.

Không tự triển khai các đề xuất trên trong lượt này.
