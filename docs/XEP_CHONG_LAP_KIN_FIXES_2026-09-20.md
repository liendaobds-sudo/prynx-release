# Xếp chồng lấp kín nguyên tấm decal - kết quả triển khai

## Yêu cầu và phạm vi

Người dùng đã đồng ý cho phép in dư để lấp cả tờ cuối. Đã áp dụng riêng
page_sheet_mode + cut_stacks. Không thêm Mục đích hoặc một bước lựa chọn mới.
Không đổi số lượng của xếp lần lượt, ratio_stack hoặc cut_stacks cắt xén/sách.

## Lô backend (§CS.FILL)

- nup_layout_solver.build_cut_stack_sheets là nguồn thứ tự chung cho preview/export.
- Giữ nguyên j * depth + sheet cho bộ gốc; bản in bù nối tuần hoàn từ đầu nguồn
  vào cuối bộ đã gom cọc. Không thay kích thước, xoay tem hoặc tăng số tờ.
- Route hỗ trợ cả nguồn một trang trong cùng đường cut-stack để preview/export
  dùng cùng chỉ số trang. Một tờ vẫn dùng response cells gốc theo hợp đồng cũ.
- Log xuất ghi extra_copies.
- Baseline 70 trang: test fail 18 != 20; cắt xén thường vẫn đạt.
- Test mới phủ 1/19/20/21/70/72/80 trang; mọi ô đầy, thứ tự gốc + bản dư đúng,
  tọa độ preview/export sai khác dưới 0,002 pt, đếm artwork từ PDF xuất thật.
- Lần viết test đầu đã giả định sai response luôn có sheets[] và PDF chỉ có trang
  IN. Đã đối chiếu hợp đồng cũ: một tờ dùng cells ở root; decal luôn ghép IN/CUT.
  Chỉ sửa giả định trong test, không thay hai hành vi này.

## Lô giao diện

- GridSettingsSection hiển thị hướng dẫn có bản in bù riêng cho nguyên tấm decal.
- Hiển thị tổng bản và số bản dư từ số trang/sức chứa preview; vi/en đồng bộ.
- 70 trang: Tổng 80 bản, gồm 10 bản in bù. 72 trang: 80 bản, gồm 8 bản in bù.
- Giữ hướng dẫn mỗi trang đúng một lần cho cắt xén thông thường.

## Kiểm chứng cuối

- 142 test backend đạt: cut_stack_fill, sequential_multi_page, ratio_stack,
  nup_engine_sheet_plan_parity, page_sheet_imposition, sticker_simple_grid_order,
  guillotine_orientation_policy, guillotine_compact_quantity và golden_layout.
- 150 test UI đạt (5 file); npm run typecheck đạt.
- File thực: Temp/PrynX-dev/results/sticker_0ab357d0.pdf, 72 trang, 36.756.120 byte.
- Nguyên tấm decal, cut_stacks, simple_auto, 320 x 430 mm, vùng dùng 304 x 414,
  tem 70 x 70, hở/bleed 0: 20 + 20 + 20 + 20, tổng 80 artwork, 8 bản in bù.
- Tờ 3: 3,7,11,15,19,23,27,31,35,39,43,47,51,55,59,63,67,71,3,7.
- Sau gom cọc: 1..72 rồi 1..8. Probe cấm lời gọi nesting vẫn xuất thành công.
- PDF gồm 4 trang IN + 4 CUT; render Poppler 60 dpi và xem đủ 8 PNG,
  mỗi tờ đủ 20 artwork/contour, kể cả hai ô cuối. Không gửi lệnh tới máy in.
- Artifact: D:/printsolutions-main/product/xep quan ao/output/pdf/sticker-cut-stack-filled-72.pdf.

Chưa thao tác trực tiếp trên cửa sổ desktop đang mở. Không đổi Rust/DLL, không
commit, không phát hành và không đóng/restart ứng dụng của người dùng.
