# Tách chiều rộng bảng thiết lập và công cụ - 2026-09-07

Người dùng đã duyệt xử lý hiện tượng kéo bảng thiết lập làm menu công cụ rộng/tự bung theo.
Phạm vi chỉ layout/state/persistence hai panel; giữ các sửa Bù xén đang có và code backend của task khác.

## Nguyên nhân đã truy vết

- `ImpositionTab.tsx:4299`: tay kéo mép trái gửi target outer, chỉnh tổng chiều rộng cả cụm.
- `rightToolMenuLayout.ts:313/395`: chia tổng theo hai nửa hoặc lấy phần dư, có ngưỡng tự full/icons.
- `ImpositionTab.tsx:521/2343`: dùng chung rightToolMenuFullWidth và xóa split riêng khi thả chuột.
- Menu dùng catalogWidth, thiết lập dùng configWidth nhưng cả hai cùng được suy từ một preference.

## Hợp đồng sửa

1. Lưu riêng configWidth và catalogWidth; dữ liệu cũ được di trú một lần, không làm mất chiều rộng đang dùng.
2. Có bảng thiết lập: mép trái chỉ chỉnh thiết lập, divider chỉ chỉnh catalog; không tự đổi full/icons khi kéo.
3. Chốt cặp kích thước đang hiển thị sau kéo để panel kia không nhảy khi trước đó bị giới hạn bởi cửa sổ.
   Resize cửa sổ thuần vẫn chỉ thay layout hiệu dụng, không ghi đè preference.
4. Mở/thu menu giữ chiều rộng thiết lập; đóng bảng thiết lập không làm mất chiều rộng catalog đã chọn.
5. Tôn trọng khoảng trống Viewer; nếu thiếu chỗ thì giới hạn kéo, không lấy bớt chiều rộng của panel kia.
6. Home không có panel thiết lập tiếp tục dùng resize catalog hiện hữu.

Lô A: helper layout +test; lô B: workspace/app settings +test (4file); lô C: nối ImpositionTab và test pointer.
Mỗi lô tối đa5file, verify hẹp rồi phối hợp. Người dùng đã yêu cầu sửa, không dừng chờ duyệt lại.
Chưa có kiểm native Tauri; sẽ ghi đúng mức bằng chứng khi verify xong.

## Đã triển khai và verify

- Workspace thêm rightToolConfigWidth/setter; AppSettings thêm toolConfigWidth/setter.
  Constructor nhận giá trị thứ3; migrate thiếu field dùng width cũ theo mode, explicit field giữ riêng.
- ImpositionTab truyền đủ hai preference; mép ngoài khi có thiết lập đi resizeToolMenuPanel(config),
  divider đi resizeToolMenuPanel(catalog). Gesture không ghi mode; bỏ split tạm dùng chung cũ.
- Chốt đúng số đo đang hiển thị; layout thiếu chỗ không đẩy bảng còn lại ra rộng hơn.
- Store/persistence:20test đỏ trước sửa→34đạt; siblingstate67đạt. Helper36test đạt.
- 8test tích hợp actual ImpositionTab +Workspace/AppSettings thật, Pointer/rAF và DOMstyle:
  icons390→590 giữ rail48/menu preference310; full390→490 giữ catalog310;
  divider310→370 giữ config390; pointerup không snap; thu/mở menu, đóng/mở tool và viewport kẹp đều đạt.
- Verify tổng: **430test/38suite frontend đạt**, typecheck đạt; ESLint0error,
  1warning dependency store có sẵn tại ImpositionTab. Diff-check đạt. Không sửa backend/golden hoặc commit.
- Đây là kiểm DOM/state và persistence, chưa đo thao tác native Tauri. Test helper legacy còn giữ để
  bảo vệ Home/caller cũ; đường resize hai bảng đang chạy dùng nhánh preference độc lập mới.

Log: `TACH_CHIEU_RONG_PANEL_FIXES_2026-09-07.md`.
