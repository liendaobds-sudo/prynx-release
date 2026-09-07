# Sửa đồng bộ nguồn Tách nhiều tem - 2026-09-07

Người dùng đã yêu cầu xử lý lỗi “Tài liệu đã thay đổi. Hãy nhận diện lại.” trong Tách nhiều tem.
Đây là vá riêng trên nền79f05a3 (quay lui64129a6), giữ nguyên hai chế độ và bốnfile UI đang sửa dở.
Không khôi phục toàn bộ bản hợp nhất; không thay nhận diện bóng, hình học, màu, recipe hoặc backend.

## Bằng chứng đã đối chiếu

- `stickerSheetStore.ts:514/749`: chốt nguồn so file/revision và hủy kết quả khi lease không còn current.
- `useWorkspaceStore.ts:631`: so metadata OCG thụ động như thay đổi nội dung dù PDF giữ source-default.
- `ImpositionTab.tsx:2540`: mở sourceFile từ store vào Viewer kể cả khi nó chỉ là Working PDF đã bake.
- `StickerCutlineTool.tsx:128`: đồng bộ prop nguồn chưa phân biệt lease hiện hành và source chưa chuẩn bị.
- Bản sửa tương ứng còn trong checkpoint6ffc1f4; chỉ lấy logic cần thiết sau khi đối chiếu code hiện tại.

## Các lô đã được yêu cầu thực hiện

1. Revision OCG +test WorkingPdf: metadata mặc định không đổi bytes; explicit layer/file/order/rotate vẫn stale.
2. Parent/selector +test tích hợp: chỉ nguồn explicit mở vào Viewer; overlay của Working PDF dùng revision.
3. Shell +test thật: nhận diện đang chạy/đã xong giữ đúng lease; đổi file thật bỏ nguồn cũ; retry được.

Mỗi lô tối đa5file, verify hẹp rồi ghép kiểm thử cuối. Không commit nếu chưa được yêu cầu.
Unit/integration không thay nghiệm thu native Tauri; ghi kết quả cuối ở dưới khi chạy xong.

## Đã thực hiện và kiểm chứng

- Lô1:2test đỏ trước sửa xác nhận metadata default/explicit baseline đến sau làm revision sai.
  So OCG có hiệu lực đã giữ source bytes/default hidden đúng;18test WorkingPdf đạt, giữ kiểm tra file/edit/layer thật.
- Lô2:6ca đỏ trước sửa gồm materialized File bị mở ngược và overlay stale; parent/selector nay
  chỉ sync nguồn explicit, nguồn workspace dùng revision. Tích hợp dùng PDF-lib bake3trang thật,
  reorder/duplicate/rotation cùng store thật và response detect trì hoãn9tem.
- Lô3:2test đỏ trước sửa xác nhận rời tab/trở lại bỏ nguồn xử lý cả khi detect đang chờ hoặc đã xong.
  Shell giữ lease khi còn current; đổi File thật vẫn bỏ kết quả cũ, không dùng chốt non-null vô điều kiện.
- Giữ nguyên2chế độ, không thêm lại unified-v2/selector custom/menu nhận diện nâng cao hoặc thuật toán mới.
- Verify tổng01:01 ngày07/09: **526test/50suite frontend đạt**, typecheck đạt; ESLint0error,
  1warning dependency `store` có sẵn trong ImpositionTab. Diff-check đạt; không sửa backend hoặc golden.
- Bộ kiểm chung bao gồm4file UI đã sửa trước lượt này; không reset hoặc ghi đè các thay đổi đó.
- Chưa thực hiện thao tác native Tauri của chính ảnh người dùng; bằng chứng hiện tại là AUTO.
  Người dùng thử lại “Nhận diện trang hiện tại” trên bản dev đã nạp code mới.

Log: `DONG_BO_TACH_NHIEU_TEM_FIXES_2026-09-07.md`.
