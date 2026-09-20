# Bình tem bế nhiều tờ theo số lượng — kế hoạch triển khai
Ngày: 2026-09-19
Trạng thái: ĐÃ DUYỆT VÀ TRIỂN KHAI; xem BINH_TEM_BE_NHIEU_TO_FIXES_2026-09-19.md để biết kết quả kiểm chứng và giới hạn runtime.

## 1. Mục tiêu đã được người dùng đồng ý

Bình tem bế / Dàn nhiều mẫu phải xếp đủ các loại và đủ số lượng, mở thêm tờ khi tờ hiện tại đầy. Không giới hạn tất cả mẫu vào một tờ khi chưa có lựa chọn rõ ràng của người dùng.

Ca minh họa:
- 72 loại, mỗi loại 1 bản; khổ thử chứa đúng 9 loại/tờ -> 8 bố cục, in 8 tờ.
- Cùng bài, mỗi loại 100 bản; dùng bố cục 9 loại x 1 bản -> 8 bố cục, mỗi bố cục in 100 lần, tổng 800 tờ, 7.200 tem.
- Số 9 chỉ là sức chứa của fixture, KHÔNG được gán cứng vào thuật toán.
- Với file thực 72 mẫu không đều, số tờ phải do hình học, hở, boong và giới hạn xoay quyết định; chưa cam kết chính file này có 8 tờ.

Không tự phát hành, commit thay đổi của phiên khác, thay đổi PDF nguồn, bỏ boong, thu nhỏ tem, bỏ mẫu hoặc thay đổi quy tắc cắt xén đã sửa.

## 2. Bằng chứng và các điểm phải sửa

| Mã | Mức / effort | Bằng chứng hiện tại | Hậu quả |
|---|---|---|---|
| M72.1 | P1 / M | nup_true_shape_nesting.py:788-803 chọn quantity_fulfillment khi có SL, còn trống chọn autofill_single_sheet; :958-960 giới hạn 1 tờ | SL trống không thể thực hiện yêu cầu nhiều tờ |
| M72.2 | P1 / M | nupSlice.ts:133,177 mặc định maximize_area và targetQuantity=0; nup_true_shape_nesting.py:458-515 chia toàn bộ mẫu thành dải ngang | 72 loại trên vùng 310 x 420 mm nhận dải cao 5,833 mm, không vừa mẫu |
| M72.3 | P1 / L | imposition_core/src/mixed_nesting/baseline.rs:686-690 dừng quantity baseline khi deadline; :867-879 khai các instance còn lại SearchBudgetExhausted | Baseline có thể còn thiếu đơn hàng trước khi bắt đầu tối ưu |
| M72.4 | P1 / M | nesting_preview_capacity.py:440-463 chỉ chiếu tờ 0, trả số tờ nhưng không trả toàn bộ sheets[] cho gang | Đổi maxSheets thôi chưa đủ để xem hết các tờ |
| M72.5 | P1 / M | nup_true_shape_nesting.py:1111-1142 báo số tờ theo stats và chỉ thêm cảnh báo unplaced; chưa phân biệt rõ số bố cục / số lần in theo từng bố cục | Kết quả chưa đủ hàng có thể bị hiểu nhầm là hoàn thành; cần kiểm cả cổng export |
| M72.6 | P1 / L | Solver quantity mở rộng instance theo số lượng tại baseline.rs:667-676; render/report hiện chưa có kế hoạch lặp đơn hàng dùng chung end-to-end cho gang | Không thể chỉ đổi nhãn để có 8 bố cục x 100 lần; cần kế hoạch sản xuất có đối soát SL |

### Phép đo đã có từ lượt chẩn đoán trước

Nguồn thực: Temp/PrynX-dev/results/sticker_d74c1d5a.pdf, 72 trang.
Cấu hình: A3 lỡ 320 x 430 mm, lề 5 mm, hở 2 mm, boong tròn 5 mm, cách mép 7 mm.
- Footprint 72 mẫu: khoảng 204.713,64 mm².
- Vùng in trước khi trừ vật cản: 130.200 mm².
- Chiều rộng nhỏ nhất của mẫu khi xét cạnh bao lồi: khoảng 21,01 mm, lớn hơn dải 5,833 mm.
- Request Chia đều diện tích tái hiện MIXED_NESTING_ENGINE_ERROR / BaselineInvalid.
- Request Xếp tự do, SL=1 tái hiện deadline: 6 con đã đặt, 66 con chưa đặt, 1 tờ, khoảng 9.890 ms.
- validation.valid=true của kết quả quantity có ledger unplaced KHÔNG đồng nghĩa đủ đơn hàng.

Các số trên là số đo chẩn đoán, không phải kết quả sau sửa.

## 3. Hợp đồng hành vi

### 3.1 Đầu vào

- Dàn nhiều mẫu mặc định Bình đủ số lượng, SL=1 được hiển thị rõ cho file mới.
- Số lượng riêng từng loại có ưu tiên; giữ SL đã nhập, không âm thầm ghi đè profile/preset.
- Xếp tự do là mặc định của workflow mới.
- Gom theo loại / Chia đều diện tích là ràng buộc người dùng chọn, không phải hành vi ẩn.
- Cập nhật yêu cầu: không có trường Mục đích. Dàn nhiều mẫu để trống SL mặc định một bản mỗi loại, tự chuyển tờ; Bình trang/S&R giữ hành vi riêng.
- Migration cấu hình cũ phải phân biệt intent legacy; không đổi S&R/CNC/cắt xén ngoài phạm vi.

### 3.2 Kế hoạch sản xuất

Mỗi bố cục có định danh, vị trí các mẫu, số con mỗi loại và số lần in.
Tổng sản xuất của loại i = tổng (số con loại i trên bố cục j x số lần in bố cục j).
- Tách số bố cục khác nhau, tổng số tờ vật lý và số trang PDF in/CUT.
- Gom bố cục lặp khi đúng hình học, nguồn, boong, hướng và yêu cầu gia công.
- Không gom chỉ vì hình giống; nhầm trang nguồn sẽ in sai hàng.
- Ca số lượng đều có thể tính bố cục cơ sở rồi áp hệ số lặp; kiểm số lượng cuối độc lập.
- SL khác nhau / có phần dư: tạo tờ bù theo phần còn thiếu, không bắt mọi bố cục in cùng số lần.
- In dư mặc định bằng 0 cho workflow đủ SL; chỉ cho phép nếu người dùng chọn rõ.
- Kế hoạch lặp phải được đưa vào identity/hash/handover nếu ảnh hưởng artifact/report. Không sửa ngầm manifest đã công bố hoặc làm mất provenance.

### 3.3 Bộ xếp

- Dựng phương án an toàn, đủ SL qua nhiều tờ trước, rồi mới chạy tối ưu hình thật.
- Seed nhanh có thể dùng khung bao bảo thủ để tạo bố cục hợp lệ; không thay đường bế thật trong file xuất, không thu hẹp miền xoay hợp lệ của solver.
- Seed không xếp được một hình không đồng nghĩa hình đó chắc chắn không thể xếp; phải phân biệt giới hạn heuristic với lỗi hình học/khổ giấy đã chứng minh.
- Giữ kiểm tra boong, lề, hở, không chồng lấn và đủ số lượng.
- Hết ngân sách tối ưu: trả phương án đầy đủ đã kiểm chứng, không công bố 6/72 là hoàn thành.
- Giữ hủy và progress hoạt động; không giải quyết bằng bỏ deadline vô điều kiện hay cap phần cứng.

### 3.4 Preview và xuất file

- Xem được tất cả bố cục; hiển thị Tờ mẫu j/N và số lần in của tờ đó.
- Tổng riêng: N bố cục, M tờ in, yêu cầu/đã xếp/còn thiếu theo loại.
- Kết quả thiếu có thể hiển thị để chẩn đoán nhưng phải ghi rõ Chưa đủ đơn hàng; không xuất dưới trạng thái sẵn sàng sản xuất.
- Preview và export dùng cùng kế hoạch đã pin, không solve độc lập.
- Xuất tờ mẫu: PDF chứa bố cục duy nhất và hướng dẫn số lần in từng bố cục.
- Xuất toàn bộ: mở rộng đúng số tờ; file CUT tương ứng phải có mapping rõ, không làm lẫn số trang CUT với số tờ vật lý.

## 4. Các lô dự kiến — mỗi lô tối đa 5 file

Không có quick-win một dòng xử lý đầy đủ ca này. Chỉ đổi targetQuantity hoặc maxSheets sẽ để lại lỗi thiếu mẫu/preview/report.

### A. Hợp đồng đơn hàng và số lần in
- Module kế hoạch đơn hàng riêng (mới, tên chốt trước khi sửa).
- nup_true_shape_nesting.py: chuẩn hóa nhu cầu, đối soát đủ SL trước khi xuất.
- Seam lưu/đọc kế hoạch production/handover liên quan.
- Test thuần số lượng và identity.
- Tối đa 5 file; nếu contract hiện tại cần thêm tầng, tách lô con trước khi sửa.

### B. Phương án nền nhiều tờ đủ đơn hàng
- imposition_core/src/mixed_nesting/baseline.rs.
- Helper seed số lượng riêng nếu cần.
- Điểm nối multi_start.rs/mod.rs cần thiết.
- Test Rust 72 loại/9 chỗ, thiếu diện tích, boong, deadline/cancel.
- Chạy cargo test/check. Sau khi thay Rust phải rebuild native dev để backend nhận mã mới; không chạy pipeline phát hành.

### C. Đầu vào giao diện và migration profile
- State/profile của Bình tem bế, không đổi default global của mọi công cụ.
- Lựa chọn Bình đủ số lượng / Lấp đầy một tờ và SL hiển thị rõ.
- Payload preview/export đồng bộ intent.
- Test profile cũ/mới, chuyển công cụ/tab.
- Tách thành lô con nếu vượt 5 file; i18n và test đi cùng component.

### D. Preview đủ các tờ và trạng thái đủ hàng
- nesting_preview_capacity.py.
- Bộ đọc kết quả/hiển thị GridPreview.tsx.
- Test backend multi-sheet và test UI đổi tờ/thiếu SL.
- Dùng lại cơ chế sheets[] có sẵn khi phù hợp; không dựng renderer thứ hai.

### E. Xuất, report và số lần in
- nesting_imposition_render.py và nup_true_shape_nesting.py (điểm cần thiết).
- Kế hoạch production/report đã chốt từ lô A.
- Test artifact print/CUT, unique/expanded, SL đều/không đều.
- Kiểm 8 bố cục x 100 lần = 800 tờ bằng số lượng thực, không chỉ kiểm chuỗi nhãn.

Mỗi lô phải báo danh sách file cụ thể, diff, test và mức bằng chứng; kiểm runtime trước khi sang lô tiếp theo theo skill dự án.

## 5. Ma trận nghiệm thu

1. Fixture 72 hình vuông 70 x 70 mm, tờ 224 x 224 mm, lề 5 mm, hở 2 mm, không boong: vùng 214 x 214 chứa lưới 3 x 3 và không đủ diện tích cho hình thứ 10. SL=1 -> đúng 8 bố cục, 72 con, không thiếu/trùng.
2. Cùng fixture SL=100 -> 8 bố cục mẫu x 100 lần, 800 tờ vật lý, 7.200 con; đối chiếu từng loại.
3. 73 loại SL=1 -> thêm tờ cuối, không mất loại thứ 73.
4. SL riêng khác nhau -> đúng tổng mỗi loại, không lấy một số lần in chung gây dư/thiếu.
5. Mẫu không vừa tờ, đường bế lỗi, boong chặn -> thông báo cụ thể; không công bố thiếu là hoàn thành.
6. Hủy / deadline -> không để file sản xuất thiếu và không làm hỏng phiên trước.
7. Preview đổi đủ tờ; preview/export cùng identity, mapping nguồn và tọa độ.
8. S&R, CNC, chế độ lấp đầy chủ động và Bình cắt xén trước đó không đổi ngoài phạm vi đã duyệt.
9. File thực 72 mẫu: dựng đủ tất cả mẫu trên nhiều tờ, đo thời gian và chất lượng; số tờ thực không gán trước là 8.
10. Test phần cứng: không làm máy >=16 GB bị cap; giữ quy tắc khóa PDFium và điều phối hiện hữu.

## 6. Điều kiện triển khai

- Người dùng đã duyệt các lô và sau đó yêu cầu làm hết liên tục; xem nhật ký kết quả, không còn chờ duyệt danh sách.
- Repo có nhiều sửa đổi không thuộc việc này; giữ nguyên và không commit gộp.
- Workspace phiên hiện ở D:/printsolutions-main/product/xep quan ao; ghi D:/pdfcompare cần quyền ngoài workspace.
- Không tuyên bố xong runtime khi chỉ có test tự động; không tự restart/kill tiến trình người dùng để thay DLL.
