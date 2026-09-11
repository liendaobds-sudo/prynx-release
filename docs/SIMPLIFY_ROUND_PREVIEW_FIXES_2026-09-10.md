# Sửa Simply bỏ qua Góc tròn và preview mất ở trang nhiều mảng

Người dùng xác nhận node dày ngay sau Bù xén tạo đường cắt, chưa qua Bình.
Phạm vi duyệt: sửa lỗi Simply và preview khi cuộn trang; không sửa Bình.

## Nguyên nhân đã tái hiện

1. `sticker_engine.py`: khi `cut_fitted_paths=None`, nhánh Simplify chỉ tạo
   baseline cho preserve/miter. Góc tròn/alpha_smooth dựng Catmull cubic ở
   writer phía sau, nên không chạy Simplify dù nhận tolerance dương.
2. `StickerTool.tsx`: scope Simplify chứa trang/instance đang xem trong khi
   Thực thi xử lý tài liệu. Cuộn trang làm mức vừa chọn trở thành 0.
3. `useClassicCutlinePreview.ts`: nhiều mảng Alpha đóng session và trả
   `preview=null`, hiển thị cảnh báo áp khi Thực thi. Đây không phải lỗi
   Bình hay chỉ một giới hạn số thứ tự trang; đó là nhánh chưa hỗ trợ.

## Sửa và các chốt giữ nguyên

- Dựng chính cubic mà writer Góc tròn sẽ ghi làm baseline cho Simplify.
  Không thay mask, không đổi kiểu góc, không ép fit lại nguồn mới.
- Nguồn Catmull đã G1 thử bộ rút bảo toàn trước; ca thực 364→56 đạt band.
  Ba seed neo tự do từng bị loại topology trên ca này; không bỏ guard để
  ép nhận. Nhánh bảo toàn rút tốt trong band nên tránh ba lượt tối ưu đó.
- Bump version Simplify dương thành `free-g1-v2-round`; zero giữ legacy.
- Mức Simplify theo document identity, không theo trang cuộn. File/revision
  mới vẫn tắt. Handler, mặc định và trần 0,10 mm giữ nguyên.
- Preview nhiều mảng Alpha PDF có mode opt-in `classic_whole_page`, dùng
  đúng StickerEngine/writer trên trang yêu cầu; PDFium chạy process riêng.
  Cùng bước chuẩn hóa Rotate/UserUnit với route Thực thi. SVG bỏ translation
  mở rộng trang xuất, trả về hệ local-crop của trang đang xem.
- Tách tem và các nguồn khác giữ đường preview cũ. Không gộp nhãn Alpha,
  không bỏ kiểm snapshot một-tem. Whole-page preview không gửi reference
  vào snapshot một-tem; Thực thi dựng lại bằng cùng engine/tham số.
- UI chờ frame đúng page/revision/mức Simplify; loại phản hồi trang cũ.
  Backend cũ không trả `classic_whole_page=true` bị từ chối, không dùng
  preview các mảng tách để giả đường toàn trang.

## Đầu ra thật

Binder2 trang 12, Theo mép tràn lề (`bleed`), offset0, bleed2 mm, Góc tròn,
curve_tension100, denoise30, Simplify0/0,10, bỏ nền trắng, auto_safe/adaptive:

| Đo từ PDF đã xuất | Trước | Sau |
|---|---:|---:|
| Cubic/neo | 364 | 56 |
| Tổng bước nhảy độ cong /mm | 260,457 | 109,282 |
| Tổng biến thiên độ cong /mm | 1307,411 | 994,933 |

Lệch hai chiều đo 0,09874048 mm; cận độc lập với chord 0,001 mm là
0,09925049 mm (làm tròn lên). Cận writer báo0,09983598mm (làm tròn lên).
Cận coarse dùng chord0,01mm bị từ chối vì độ lỏng, đã tinh chỉnh bước kiểm,
không nới tolerance. P95 nhảy độ cong tăng3,667→5,430/mm do số join giảm;
không nói mọi metric đều tốt hơn hay chứng nhận dao chạy mượt.

Đã xuất cả kiểu bù màu image và nền trắng solid. CUT giữa hai kiểu trùng.
Render image-bleed có vệt kéo màu của luồng màu hiện có; không sửa màu trong
lô này. PDF nền trắng đúng cấu hình màu trong ảnh người dùng đã được render
và soi: artwork đọc rõ. Preview SVG từ writer khớp đúng lệnh CUT PDF này.

- [PDF nền trắng 56 neo](D:/pdfcompare/output/pdf/Binder2-round-simplify-solid-fixed-2026-09-10/Binder2_page12_round_simplify_0.10.pdf).
- [Bằng chứng](D:/pdfcompare/output/pdf/Binder2-round-simplify-solid-fixed-2026-09-10/evidence.json).
- Script: `tmp/pdfs/round-simplify-20260910/verify.py` (thư mục mới, không ghi đè).
- SHA256 Binder2 nguồn giữ nguyên `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.

## Verify và giới hạn

- Bộ backend preview/contract/cubic/global:110passed; sau thêm test dispatch
  whole-page và wrapper canonical, nhóm hẹp6passed (bỏ test round đắt đã chạy).
- Frontend112passed/5file; Windows typecheck đạt.
- Test process spawn trang12 thật đạt; trang2 và12 SVG khớp PDF. Test delayed
  trang2→12 không nhận nhầm frame. Test UI cuộn giữ0,10 và chặn xuất khi
  frame mới chưa sẵn sàng đạt. Test serialization opt-in/default tách tem đạt.
- Source + API + artifact đã kiểm, chưa thao tác cuộn trong Tauri thật,
  chưa build/cài installer, chưa thử dao. Backend whole-page cần thời gian
  dựng như xuất một trang (ca round khoảng24–31giây trên lượt đo), không
  hứa thanh kéo realtime tức thì.
- Chưa có PDF chính người dùng mở trong Illustrator, nên không đồng nhất
  file đó với artifact 56neo hoặc nói đã xác minh phiên app của người dùng.

Giữ nguyên các thay đổi UI/nhánh nesting đang có trong worktree; không reset,
commit, restart tiến trình người dùng hoặc thay file mẫu.
