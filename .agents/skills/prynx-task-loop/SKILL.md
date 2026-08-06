---
name: prynx-task-loop
description: "Vòng lặp xử lý bug và tính năng nhỏ–vừa của PrynX dựa trên bằng chứng: hiểu yêu cầu → tái hiện/baseline → giả thuyết → thay đổi nhỏ → verify hẹp → lặp → verify cuối. Dùng khi user yêu cầu sửa bug, điều tra rồi sửa, triển khai tính năng, debug lặp, tiếp tục đến khi test xanh, fix until done, implement and verify. Nếu phạm vi thành audit lớn hoặc dự kiến chạm hơn 5 file thì chuyển sang prynx-audit-workflow."
---

# Vòng lặp tác vụ PrynX

Đây là vòng điều phối chung cho công việc hằng ngày, không thay thế skill chuyên sâu. Trước khi bắt đầu, đọc `prynx-architecture` và skill đúng miền; khi viết code đọc `prynx-conventions`; trước khi báo xong dùng `prynx-testing`.

## Chốt đầu vào

1. Viết lại mục tiêu thành tiêu chí kiểm chứng được: hành vi nào phải đúng, đầu vào nào quan trọng, điều gì không được thay đổi.
2. Kiểm tra trạng thái working tree và giữ nguyên thay đổi của user. Không tiện tay sửa vấn đề ngoài phạm vi.
3. Tạo baseline:
   - Bug: tái hiện bằng test/lệnh/thao tác ngắn nhất và giữ lại lỗi gốc.
   - Tính năng: xác định hợp đồng hiện tại, test gần nhất và kết quả mong đợi.
   - Không tái hiện được: thu thập bằng chứng quan sát được, ghi rõ giả định; không tuyên bố đã sửa lỗi chưa thấy.

Nếu user chỉ yêu cầu chẩn đoán/review, dừng sau khi xác định nguyên nhân và bằng chứng; không tự triển khai bản sửa.

## Một vòng lặp

1. **Đọc bằng chứng hiện tại**: lỗi, test đỏ, log, dữ liệu mẫu và code đủ rộng quanh luồng liên quan.
2. **Nêu một giả thuyết có thể bác bỏ**: nguyên nhân cụ thể là gì và kết quả nào sẽ xác nhận hoặc bác bỏ nó.
3. **Chọn thay đổi nhỏ nhất** để kiểm tra giả thuyết; sửa đủ hai đầu hợp đồng nếu thay đổi xuyên tầng.
4. **Verify phạm vi hẹp nhất có ý nghĩa**: test đơn, typecheck file/module, py_compile, cargo check crate hoặc thao tác tái hiện tương ứng.
5. **Đọc kết quả thay vì chỉ nhìn xanh/đỏ**:
   - Đúng như dự đoán: giữ thay đổi và mở rộng verify.
   - Bác bỏ giả thuyết: bỏ hướng suy luận đó, khôi phục riêng thay đổi thử nghiệm nếu không còn giá trị, rồi lập giả thuyết mới.
   - Có lỗi mới: phân biệt hồi quy do bản sửa với lỗi có sẵn bằng baseline.
6. Chỉ lặp khi có **bằng chứng mới hoặc giả thuyết mới**. Không chạy lại nguyên xi một cách sửa đã thất bại.

Sau ba vòng không tiến triển, quay lại bước khám phá: đọc lại kiến trúc/tài liệu gốc, kiểm tra giả định đầu vào và thu hẹp ca tái hiện. Không tiếp tục vá dò. Nếu cần thêm quyền, dữ liệu mẫu hoặc quyết định nghiệp vụ thì dừng và hỏi user đúng điểm thiếu.

## Cấm phát biểu từ suy diễn

Ba loại phát biểu dưới đây **phải có lệnh xác nhận vừa chạy** mới được nói ra. Không có lệnh thì nói "chưa kiểm", không nói bằng giọng khẳng định. Cả ba đã từng sai thật trong dự án này (đợt bù xén tạo đường cắt 2026-08-06/07), cùng một kiểu: kết luận từ suy luận thay vì từ đo.

1. **Trạng thái repo** — "file X đã mất", "thay đổi Y chưa commit", "cây làm việc bẩn". Ảnh chụp `git status` ở đầu phiên **lỗi thời ngay khi phiên khác commit**; đọc lại `git status` hiện tại và `git log --oneline -- <file>` trước khi kết luận. Từng báo động "mất code chưa commit của phiên khác" trong khi phiên đó đã commit xong từ trước.
2. **Hành vi code** — "hàm này đã xử lý ca đó", "nhánh kia không chạy". Đọc code hoặc chạy nó, không tin lời văn trong file kế hoạch / báo cáo audit / commit message cũ. **Tài liệu trong repo là giả thuyết, không phải bằng chứng** — từng mô tả sai một hạng mục nguyên một lô vì tin mô tả trong file kế hoạch của chính mình.
3. **Hậu quả bản vá** — "sửa xong sẽ mượt hơn", "không ảnh hưởng đường cũ". Đo bằng số trước và sau, trên chính đại lượng user nhìn thấy. Xem `feedback_measure_consequence_not_just_geometry` trong bộ nhớ dự án.

Khi báo cáo, tách bạch cái **đã đo** và cái **đang suy đoán**. Một câu suy đoán trình bày như sự thật làm user mất nhiều thời gian hơn là im lặng.

## Đổi thứ nằm ở thượng nguồn thì phải rà hạ nguồn

Khi thay đổi một thứ **nhiều nơi cùng dùng** (bộ dò/mask, hàm dựng hình học, cấu trúc dữ liệu chung, hằng số chia sẻ), liệt kê **mọi consumer** trước khi báo xong, và kiểm ít nhất consumer nào nhạy nhất với đặc tính vừa đổi.

Ca thật: lô dò nền thay mask đầu vào bằng mask **nhị phân thuần**, đúng ở mọi test của chính nó. Nhưng hạ nguồn `measure.find_contours` là marching-squares — nó cần **dải chuyển tiếp** để nội suy dưới mức điểm ảnh. Mất dải đó thì đường cắt thành bậc thang, tem càng lớn càng lộ. Không test nào bắt được vì test chỉ kiểm "mask có tách đúng nền không", còn user thì nhìn **đường cắt**.

Rút ra: hỏi "thứ tôi vừa đổi mang đặc tính gì mà hạ nguồn đang âm thầm dựa vào?" — không chỉ "giá trị trả về có đúng không". Đặc tính ngầm hay bị bỏ sót: dải chuyển tiếp/độ mượt, thứ tự phần tử, đơn vị, hệ toạ độ, tính liên tục, có/không alpha.

## Định tuyến khi phạm vi đổi

- Phát hiện thành chiến dịch rà soát hoặc dự kiến chạm hơn 5 file → chuyển `prynx-audit-workflow`, lập báo cáo và chờ duyệt trước khi sửa.
- Chạm `dieline`/`mockup3d` → tuân thủ `prynx-dieline`; thêm loại hộp → `prynx-add-boxtype`.
- Thêm cap/worker/cache hoặc tối ưu → `prynx-performance`; backend PDF nặng → `prynx-imposition`.
- Lỗi build/đóng gói → `prynx-build-release`.

## Điều kiện thoát

Chỉ báo hoàn thành khi:

- Tiêu chí đầu vào đã đạt và ca tái hiện ban đầu không còn lỗi.
- Nguyên nhân gốc và lý do bản sửa giải quyết được nó có thể giải thích ngắn gọn.
- Verify hẹp đã xanh, sau đó ma trận verify cuối theo `prynx-testing` đã chạy ở các tầng bị ảnh hưởng.
- Không có lỗi mới chưa giải thích; snapshot/golden chỉ cập nhật khi thay đổi là chủ đích và đã soi diff.
- Báo trung thực test đã chạy, test chưa chạy được, kiểm tra tay còn cần user thực hiện và rủi ro còn lại.

## Cổng trung thực của ca tái hiện

- Ghi nguyên văn đường vào và chuỗi thao tác của user trước khi sửa: mở từ đâu, tab nào đang active, file đi qua picker/DOM drop/Tauri native drop hay API nào, và trạng thái trước lỗi.
- Một luồng “gần giống” không thay thế ca gốc. Ví dụ `Home → Upscale` không chứng minh cho `tab PDF → menu công cụ → Upscale`; phải chạy riêng cả hai nếu đều tồn tại.
- Với lỗi UI xuyên biên (shell ↔ tab ↔ store ↔ backend), truy vết tới điểm vào thật của runtime; không dùng unit test của component để suy ra sự kiện native đã đúng.
- Nếu user báo “vẫn lỗi”, vô hiệu hóa kết luận hoàn thành trước đó. Tái hiện lại đúng chuỗi mới, so với giả định cũ, rồi mới sửa vòng tiếp theo.
- Mỗi bản sửa routing/state phải có cả ca dương (đúng tab nhận) và ca âm (tab nền, tool cũ, tab đã đóng không nhận).

## Quy tắc tuyên bố hoàn thành

- Phân biệt rõ: **code/typecheck đạt**, **test tích hợp đạt**, và **ca runtime thực tế đạt**.
- Không nói “đã OK/đã sửa hoàn toàn” cho lỗi runtime khi mới đạt unit test hoặc typecheck; nói đúng mức bằng chứng và nêu bước kiểm tay chưa chạy.
- Với lỗi do user cung cấp thao tác cụ thể, điều kiện thoát bắt buộc là chạy lại chính ca đó hoặc nói rõ chưa thể chạy, không được thay bằng suy luận từ test khác.
