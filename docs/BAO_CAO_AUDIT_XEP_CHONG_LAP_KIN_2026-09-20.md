# Xếp chồng nguyên tấm decal: lấp kín bằng bản sao

## Phạm vi đã được duyệt

Người dùng trả lời “ok” cho câu hỏi có cho phép in dư để lấp kín cả tờ cuối.
Áp dụng cho page_sheet_mode + cut_stacks; không đổi N-Up lần lượt, ratio_stack,
VDP/sách hoặc cut_stacks cắt xén thông thường. Không thêm trường Mục đích.
Chỉ thay đổi code, không gửi lệnh tới máy in.

## Bằng chứng và hợp đồng (§CS.FILL)

- Preview imposition.py và export nup_engine.py đều dùng trang = ô * số_tờ + tờ,
  rồi bỏ ô khi chỉ số vượt số trang. 72 trang / 20 ô -> 4 tờ, mỗi tờ 18 ô.
- Hướng dẫn GridSettingsSection hiện nói mỗi trang đúng một lần, cần đổi riêng
  cho nguyên tấm decal để người dùng biết có bản dư.
- Quy tắc mới: giữ nguyên thứ tự cọc, nối bản sao tuần hoàn từ đầu nguồn sau
  toàn bộ trang gốc. Tất cả ô được dùng, không đổi hình học hoặc tăng số tờ.
- 70/20 -> 4 x 20, gom cọc ra 1..70 rồi 1..10; 72/20 -> 1..72 rồi 1..8.
- Dùng chung helper giữa preview/export; không gọi nesting cho lưới đơn giản.

## Lô triển khai và nghiệm thu

1. Backend: helper thuần, preview, export, regression test (tối đa 4 file).
2. UI: hướng dẫn theo chế độ, vi/en và regression test (4 file).
3. Chạy test hẹp rồi regression rộng; kiểm file thật nếu còn khả dụng.

Tiếp tục theo yêu cầu trước đó “làm hết luôn đi”, không dừng duyệt lại giữa lô.
Không commit, phát hành hoặc đóng ứng dụng đang mở.
