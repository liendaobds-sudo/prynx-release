# Requirements Document

> Tài liệu Yêu cầu — Report & Xuất tờ duy nhất cho Bình Tem Bế

## Introduction

Hiện tại, công cụ **Bình Tem Bế** (`sticker_imposer`) khi nhập số lượng (ví dụ 10 loại × 1000 tem) sẽ **nhân bản vật lý** mỗi loại thành nhiều trang giống hệt nhau trong file PDF kết quả (ví dụ ~210 trang). Điều này sai với quy trình in thực tế: thợ in chỉ cần **một tờ bình duy nhất** rồi đặt máy in "in N bản", chứ không cần file chứa hàng trăm trang trùng lặp.

Tính năng này thay đổi cách xuất kết quả theo đúng mô hình của script Illustrator tham chiếu (`scripts/illustrator/1. dev - Nô lệ bình bài.jsx`):
- **Xuất tờ bình DUY NHẤT** cho mỗi loại tem (ở chế độ Bình trang S&R — mỗi tờ chỉ chứa 1 loại).
- Con số "số lượng" trở thành **thông tin in** (số tờ cần in, số lượng thực) thay vì sinh ra trang.
- Vẽ một **khối Report** ("Product_Info") ngay trên tờ in, hiển thị các trường cấu hình được: mã đơn hàng, tên tem, kích thước, SL/tờ, số tờ cần in, số lượng thực, vật liệu, cán màng, file bế, chế độ.
- Tùy chọn **đặt tên file PDF theo nội dung report**.

Phạm vi quyết định nghiệp vụ đã chốt trước đó:
- Chế độ **Bình trang (S&R / `layout_type=repeat`)**: mỗi loại 1 tờ duy nhất → áp dụng mô hình "1 tờ + số tờ cần in".
- Chế độ **Dàn nhiều mẫu (N-Up trộn loại)**: nhiều loại nằm chung 1 tờ với số lượng khác nhau → KHÔNG quy về "in N bản" được, giữ nguyên hành vi hiện tại (ngoài phạm vi tính năng này, trừ phần report tổng quan nếu khả thi).

## Glossary
- **SL/tờ (labelsPerSheet / itemsPerPage)**: số tem của một loại vừa trên 1 tờ in.
- **Số tờ cần in (sheetsNeeded)**: `ceil(số_lượng_yêu_cầu / SL/tờ)`.
- **Số lượng thực (actualQty)**: `sheetsNeeded × SL/tờ` (luôn ≥ số lượng yêu cầu).
- **Report block / Product_Info**: cụm text mô tả sản phẩm vẽ trên tờ in.

---

## Requirements

### Yêu cầu 1 — Xuất tờ duy nhất thay vì nhân bản

**User Story:** Là một thợ chế bản, tôi muốn file kết quả chỉ chứa các tờ bình duy nhất (mỗi loại 1 tờ), để file nhẹ và đúng quy trình in (đặt máy in N bản), không phải xử lý file hàng trăm trang trùng lặp.

#### Acceptance Criteria
1. WHEN người dùng chạy Bình Tem Bế ở chế độ **Bình trang (S&R)** với N loại tem và mỗi loại có số lượng > 0 THEN hệ thống SHALL xuất file PDF gồm đúng **N trang** (mỗi loại 1 tờ bình duy nhất), KHÔNG nhân bản trang theo số lượng.
2. WHEN một loại tem có số lượng yêu cầu THEN hệ thống SHALL tính `sheetsNeeded = ceil(số_lượng / SL_trên_tờ)` và `actualQty = sheetsNeeded × SL_trên_tờ` cho loại đó.
3. WHERE người dùng để trống số lượng (chế độ tự lấp đầy 1 tờ) THE hệ thống SHALL vẫn xuất 1 tờ duy nhất cho loại đó và đặt số tờ cần in = 1.
4. IF `SL_trên_tờ` của một loại bằng 0 (tem lớn hơn vùng in) THEN hệ thống SHALL báo lỗi rõ ràng cho loại đó và không làm sập toàn bộ job.
5. WHEN tính năng "xuất tờ duy nhất" được bật THEN hành vi này SHALL áp dụng đồng nhất ở cả nhánh xem trước (preview) lẫn nhánh xuất file (render) để không lệch.

### Yêu cầu 2 — Vẽ khối Report lên tờ in

**User Story:** Là một thợ in, tôi muốn mỗi tờ bình có sẵn thông tin sản phẩm và lệnh in (số tờ cần in, số lượng thực), để biết chính xác cần chạy bao nhiêu bản mà không phải tra cứu ở chỗ khác.

#### Acceptance Criteria
1. WHEN xuất một tờ bình ở chế độ Bình Tem Bế THEN hệ thống SHALL vẽ một khối Report (text) trên tờ in, nằm ngoài vùng tem (không đè lên thành phẩm).
2. THE khối Report SHALL hỗ trợ các trường sau, mỗi trường bật/tắt độc lập:
   - **identifier** (Mẫu/Cặp/Trang): số thứ tự mẫu/trang.
   - **labelName** (Tên nhãn): chuỗi do người dùng nhập (VD: "Tem sầu riêng").
   - **dimensions** (Kích thước thành phẩm WxH mm).
   - **paperSize** (Khổ giấy đang dùng).
   - **labelsPerSheet** (SL/tờ).
   - **sheetCount** (Số tờ cần in).
   - **actualQty** (Số lượng thực).
   - **material** (Chất liệu).
   - **lamination** (Cán màng: Không cán / Cán bóng / Cán mờ, kèm số mặt).
   - **cutFileRef** (Tham chiếu file dao cắt — nếu tách file bế riêng).
   - **modeLabel** (Nhãn chế độ, VD "Bế tem").
   - **orderCode** (Mã đơn hàng — luôn chèn đầu nếu có).
3. THE các trường được bật SHALL nối với nhau bằng dấu " - " theo một thứ tự cấu hình được, bỏ qua trường rỗng.
4. WHERE người dùng chọn vị trí report (trên / dưới / trái / phải) THE hệ thống SHALL đặt khối report ở cạnh tương ứng của tờ in với khoảng lề (offset) cấu hình được.
5. WHERE người dùng bật tùy chọn "bỏ dấu tiếng Việt" THE nội dung report SHALL được loại bỏ dấu.
6. IF tất cả các trường report đều tắt (hoặc rỗng) THEN hệ thống SHALL không vẽ khối report và vẫn xuất tờ bình bình thường.

### Yêu cầu 3 — Cấu hình hiển thị Report trên UI

**User Story:** Là người dùng, tôi muốn bật/tắt và sắp xếp các trường report, nhập vật liệu/cán màng/mã đơn hàng, để report khớp với phiếu sản xuất của xưởng.

#### Acceptance Criteria
1. WHEN người dùng ở tab Bình Tem Bế THEN hệ thống SHALL hiển thị một khu vực cấu hình Report (có thể nằm trong "Thiết lập mở rộng").
2. THE UI cấu hình SHALL cho phép: bật/tắt từng trường, chọn vị trí, chỉnh cỡ chữ, nhập mã đơn hàng, chọn loại vật liệu, chọn kiểu cán màng (Không cán / Cán bóng / Cán mờ) và số mặt cán, bật/tắt bỏ dấu.
3. THE cấu hình report SHALL được lưu lại (persist) để lần dùng sau giữ nguyên thiết lập.
4. WHEN người dùng thay đổi cấu hình report THEN bản xem trước (nếu có hiển thị report) SHALL phản ánh thay đổi.

### Yêu cầu 4 — Đặt tên file theo Report

**User Story:** Là người dùng, tôi muốn tùy chọn đặt tên file PDF theo nội dung report, để file lưu ra đã có sẵn tên đúng đơn hàng, không phải đổi tên thủ công.

#### Acceptance Criteria
1. WHERE người dùng bật tùy chọn "Lưu file theo nội dung report" THE tên file kết quả SHALL được tạo từ nội dung report (đã làm sạch ký tự không hợp lệ cho tên file).
2. WHEN tên file sinh ra chứa ký tự không hợp lệ (`\ / : * ? " < > |`) THEN hệ thống SHALL thay thế/loại bỏ chúng an toàn.
3. IF tùy chọn tắt THEN hệ thống SHALL dùng quy tắc đặt tên mặc định hiện có.

### Yêu cầu 5 — Bảng tổng hợp lệnh in (tùy chọn)

**User Story:** Là người quản lý sản xuất, tôi muốn xem nhanh tổng số tờ cần in cho toàn bộ đơn (tất cả các loại), để chuẩn bị giấy và lên kế hoạch máy.

#### Acceptance Criteria
1. WHEN job có nhiều loại tem THEN hệ thống SHALL cung cấp một bản tổng hợp: từng loại (tên, SL/tờ, số lượng yêu cầu, số tờ cần in) và tổng số tờ của cả đơn.
2. THE bản tổng hợp SHALL hiển thị được trên UI sau khi tính toán (và/hoặc kèm trong thông báo hoàn tất job).

### Yêu cầu 6 — Tương thích & không phá vỡ hành vi hiện có

**User Story:** Là người dùng các công cụ khác (N-Up, Booklet), tôi muốn thay đổi này không ảnh hưởng tới các chế độ ngoài Bình Tem Bế.

#### Acceptance Criteria
1. WHEN người dùng dùng chế độ N-Up trộn nhiều loại hoặc Booklet THEN hệ thống SHALL giữ nguyên hành vi xuất hiện tại, không áp mô hình "tờ duy nhất + số tờ".
2. THE thay đổi SHALL không làm hỏng các test backend hiện có (`tests/` đang xanh 85/85).
3. WHERE Rust (`pdfcompare_native`) là bắt buộc cho tính layout THE việc tính SL/tờ phục vụ report SHALL dùng cùng kết quả layout với engine hiện tại (không tính lại bằng đường khác gây lệch số liệu).

### Yêu cầu 7 — Quản lý Chất liệu (Material) & Cán màng

**User Story:** Là người dùng, tôi muốn chọn chất liệu từ danh sách có sẵn và tự lưu thêm chất liệu của xưởng, để điền nhanh vào report mà không gõ lại mỗi lần.

#### Acceptance Criteria
1. THE hệ thống SHALL có sẵn danh sách chất liệu mặc định: Decal PP, Decal Đế vàng, Decal Nhựa mờ, Decal Nhựa trong, Decal Bể (Tem vỡ).
2. WHEN người dùng nhập tên một chất liệu mới và lưu THEN hệ thống SHALL thêm vào danh sách chất liệu tùy chỉnh và persist để dùng lại lần sau.
3. WHEN người dùng xóa một chất liệu tùy chỉnh THEN hệ thống SHALL loại nó khỏi danh sách (không xóa được chất liệu mặc định).
4. THE cán màng SHALL có 3 lựa chọn (Không cán / Cán bóng / Cán mờ) kèm số mặt (1 hoặc 2); chuỗi report ghép dạng "Cán mờ 1 mặt".
5. WHERE người dùng chọn chất liệu / cán màng THE giá trị SHALL được đưa vào field `material` / `lamination` của report.

### Yêu cầu 8 — Lưu file in (Save Print Files)

**User Story:** Là thợ chế bản, tôi muốn lưu thẳng các tờ bình ra thư mục ổ cứng với tên file rõ ràng và tách file in/file bế, đồng thời vẫn giữ tab kết quả để review — để giao xưởng ngay mà không phải đổi tên hay sắp xếp thủ công.

#### Acceptance Criteria
1. WHEN người dùng bấm "Lưu file in" THEN hệ thống SHALL cho chọn thư mục đích (Tauri folder picker) và ghi file **thẳng vào ổ cứng**, ĐỒNG THỜI giữ nguyên tab kết quả đang mở để review.
2. THE đặt tên file SHALL có 3 chế độ chọn 1: **theo report** / **đánh số thứ tự** / **giữ tên gốc**; chế độ "theo report" dùng nội dung report đã làm sạch + tiền tố số thứ tự.
3. WHERE người dùng bật "Tách file in / file bế" THE hệ thống SHALL xuất **file in** (tờ bình) và **file bế** (chỉ đường cắt/khuôn) thành các file riêng; tên file bế bám theo tên file in (hậu tố "(cut)").
4. THE cấu trúc thư mục SHALL cho người dùng chọn: (a) **1 thư mục con cho mỗi đơn** (gồm mọi loại, có thể chia subfolder In/Bế) hoặc (b) **phẳng** (mọi file trong 1 thư mục, đánh số nối tiếp).
5. WHERE người dùng cấu hình tên file THE format SHALL hỗ trợ chèn các thành phần như mã đơn hàng và/hoặc ngày (tùy chọn), nhất quán với cách script ghép tên.
6. WHEN sắp lưu THEN hệ thống SHALL hiển thị **xem trước cây thư mục + tên file thật** (WYSIWYG) để người dùng xác nhận trước khi ghi.
7. IF thư mục đích đã có file trùng tên THEN hệ thống SHALL đánh số nối tiếp an toàn (không ghi đè) hoặc cảnh báo.
8. THE tên file/thư mục SHALL được làm sạch ký tự không hợp lệ (`\ / : * ? " < > |`).

---

## Out of Scope

- Thay đổi thuật toán xếp tem (layout solver) — giữ nguyên Rust hiện tại.
- Mô hình "in N bản" cho N-Up trộn nhiều loại trên cùng 1 tờ.
- In/registration marks, pont, đường bế — đã có sẵn, không thuộc tính năng này (chỉ tham chiếu khi report cần ghi "file bế").
