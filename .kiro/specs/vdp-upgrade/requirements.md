# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho việc nâng cấp engine VDP (Variable Data Printing) của PrynX — bộ prepress all-in-one dành cho xưởng in SMB Việt Nam. Engine VDP hiện tại đã hỗ trợ nạp dữ liệu CSV (mỗi dòng = 1 record), đặt field theo toạ độ XY trên template, và sinh PDF lô theo chunk + đa tiến trình với các loại field: text (bold/italic thật, auto-fit, xoay, màu CMYK pure-K, placeholder `{Cot}`, tách cột `{Cot[2|-]}`, định dạng `{Cot|func:arg}`), image (fit cover/contain/fill, clip shape), qrcode (segno, mức sửa lỗi L/M/Q/H), và barcode 1D 7 loại (Code128, EAN13, EAN8, UPCA, Code39, ITF14, Codabar).

Bản nâng cấp tập trung vào 5 hạng mục Tier-1 đã được người dùng chốt, nhằm thu hẹp khoảng trống cạnh tranh cho phân khúc tem nhãn/truy xuất nguồn gốc và cải thiện trải nghiệm chuẩn bị dữ liệu, mà KHÔNG mở rộng sang VDP giao dịch enterprise (transactional/cross-media/cơ sở dữ liệu liên kết):

1. Nguồn dữ liệu mở rộng (Excel `.xlsx`, Google Sheets qua link/export CSV; auto-detect delimiter và encoding).
2. Logic điều kiện đơn giản (ẩn/hiện field, chọn giá trị nội tuyến `{Cot?A:B}`, bảng rule đơn giản).
3. Barcode 2D công nghiệp (DataMatrix ECC200, GS1-128, GS1 DataMatrix với parse Application Identifier).
4. Preview từng record + điều hướng trong UI, và xuất báo cáo lỗi.
5. Validate trước khi chạy cả lô (placeholder, ảnh, giá trị barcode).

Toàn bộ nâng cấp phải bảo toàn parity giữa preview ở frontend và output ở backend (neo theo hằng số `CSS_TO_PT_FACTOR = 0.75`), không phá hành vi VDP hiện có, và xử lý đúng tiếng Việt có dấu (Unicode).

## Glossary

- **PrynX**: Ứng dụng prepress all-in-one (Tauri + React/TS frontend, Python FastAPI backend) cho xưởng in SMB Việt Nam.
- **VDP (Variable Data Printing)**: In dữ liệu biến đổi — sinh nhiều bản in từ một template, mỗi bản thay nội dung theo một record dữ liệu.
- **VDP_Engine**: Thành phần backend (`backend/app/workers/vdp_engine.py`, hàm `process_chunk`) sinh PDF lô từ template + fields + dữ liệu.
- **Data_Source_Reader**: Thành phần backend đọc và chuẩn hoá nguồn dữ liệu (CSV, Excel, Google Sheets) thành bảng record.
- **Condition_Engine**: Thành phần mở rộng cơ chế token `_substitute` để xử lý logic điều kiện đơn giản (ẩn/hiện field, chọn giá trị nội tuyến, bảng rule).
- **Barcode_Renderer**: Thành phần render mã vạch trong VDP_Engine, bao gồm cả barcode 1D hiện có và barcode 2D công nghiệp bổ sung.
- **Validator**: Thành phần kiểm tra cấu hình field và dữ liệu trước khi sinh lô.
- **Preview_Service**: Thành phần sinh ảnh/PDF xem trước cho một record đơn lẻ phục vụ UI.
- **VDP_UI**: Giao diện frontend trong `ImpositionTab` (feature `datamerge`/`numbering`) để cấu hình field, xem preview, điều hướng record và xem báo cáo lỗi.
- **Record**: Một dòng dữ liệu (một bản ghi) trong nguồn dữ liệu, tương ứng một lượt thay nội dung vào template.
- **Field**: Một đối tượng đặt theo toạ độ XY trên template (text/image/qrcode/barcode) với nội dung biến đổi theo record.
- **Cột (Column)**: Một trường dữ liệu trong nguồn, được xác định bằng tên ở dòng tiêu đề.
- **Dòng tiêu đề (Header row)**: Dòng đầu tiên của nguồn dữ liệu chứa tên các cột.
- **Placeholder**: Token dạng `{TenCot}` trong nội dung field, được thay bằng giá trị cột của record khi merge.
- **Delimiter**: Ký tự ngăn cách cột trong file văn bản (`,`, `;`, hoặc tab).
- **Encoding**: Bảng mã ký tự của file (UTF-8, UTF-8 BOM, ANSI/Windows-1258 cho tiếng Việt).
- **Barcode 1D**: Mã vạch một chiều (Code128, EAN13, EAN8, UPCA, Code39, ITF14, Codabar) đã hỗ trợ sẵn.
- **DataMatrix**: Mã vạch 2D dạng ma trận điểm.
- **ECC200**: Phiên bản DataMatrix sử dụng mã sửa lỗi Reed-Solomon hiện đại; chuẩn được dùng trong sản xuất công nghiệp.
- **GS1-128**: Chuẩn ứng dụng của Code128 dùng Application Identifier và ký tự FNC1 để mã hoá dữ liệu chuỗi cung ứng.
- **GS1 DataMatrix**: DataMatrix ECC200 tuân thủ chuẩn GS1, dùng FNC1 ở vị trí đầu và phân tách giữa các AI.
- **AI (Application Identifier)**: Tiền tố 2–4 chữ số trong chuẩn GS1 xác định ý nghĩa và định dạng của trường dữ liệu theo sau (ví dụ `01` = GTIN, `17` = hạn dùng, `10` = số lô).
- **FNC1**: Ký tự chức năng đặc biệt trong GS1 dùng để đánh dấu khởi đầu dữ liệu GS1 và ngăn cách các AI có độ dài thay đổi.
- **GTIN**: Mã số thương phẩm toàn cầu (Global Trade Item Number).
- **Copy-fitting (auto-fit)**: Cơ chế tự bóp cỡ chữ để nội dung text vừa trong khung field, không tràn.
- **CSS_TO_PT_FACTOR**: Hằng số `0.75` (= 72/96) quy đổi toạ độ giữa pixel CSS @96dpi của frontend và point của backend, bảo đảm parity preview ↔ output.
- **CMYK pure-K**: Màu đen được người dùng chọn (`#000000`) phải thành `(0,0,0,1)` thuần kênh K, không thành rich black.
- **Chunk**: Một phần của tập record được một tiến trình xử lý song song khi sinh lô.
- **MISSING**: Nhãn lỗi gắn cho record khi một field không có giá trị cột tương ứng.
- **ERR**: Nhãn lỗi gắn cho record khi việc render một field gây ngoại lệ.
- **Báo cáo lỗi (Error report)**: Danh sách liệt kê các record có nhãn MISSING/ERR kèm lý do.

## Requirements

### Requirement 1: Nguồn dữ liệu mở rộng (Excel, Google Sheets, auto-detect)

**User Story:** Là nhân viên chế bản tại xưởng in, tôi muốn nạp dữ liệu từ file Excel `.xlsx` và Google Sheets bên cạnh CSV, với việc tự nhận diện delimiter và encoding, để tôi không phải chuyển đổi thủ công và tránh lỗi tiếng Việt bị sai mã.

#### Acceptance Criteria

1. WHEN người dùng nạp một file `.csv`, THE Data_Source_Reader SHALL phân tích file thành một bảng record với tên cột lấy từ dòng tiêu đề.
2. WHEN người dùng nạp một file `.xlsx`, THE Data_Source_Reader SHALL dùng openpyxl đọc file thành một bảng record với tên cột lấy từ dòng tiêu đề.
3. WHERE file `.xlsx` chứa nhiều sheet, THE Data_Source_Reader SHALL trình bày danh sách tên sheet để người dùng chọn và SHALL đọc dữ liệu từ sheet được chọn.
4. WHEN người dùng cung cấp một link Google Sheets, THE Data_Source_Reader SHALL lấy dữ liệu qua đường export CSV của Google Sheets và phân tích thành một bảng record.
5. WHEN một file văn bản dạng phân tách được nạp, THE Data_Source_Reader SHALL tự nhận diện delimiter trong tập `{dấu phẩy, dấu chấm phẩy, tab}` dựa trên dòng tiêu đề.
6. WHEN một file văn bản được nạp, THE Data_Source_Reader SHALL tự nhận diện encoding trong tập `{UTF-8, UTF-8 BOM, Windows-1258}` và giải mã nội dung theo encoding nhận diện được.
7. WHEN dữ liệu chứa ký tự tiếng Việt có dấu, THE Data_Source_Reader SHALL bảo toàn nguyên vẹn các ký tự đó ở dạng Unicode sau khi phân tích.
8. IF không nhận diện được delimiter hoặc encoding với độ tin cậy đủ, THEN THE Data_Source_Reader SHALL trả về một thông báo lỗi mô tả nguyên nhân và SHALL không tạo bảng record.
9. IF file nạp vào rỗng hoặc không có dòng tiêu đề, THEN THE Data_Source_Reader SHALL trả về một thông báo lỗi nêu rõ file thiếu dữ liệu và SHALL không tạo bảng record.
10. THE Data_Source_Reader SHALL tạo ra cùng một cấu trúc bảng record (danh sách cột và danh sách dòng) cho mọi định dạng nguồn được hỗ trợ, để các bước phía sau xử lý đồng nhất; dòng tiêu đề là dòng KHÔNG rỗng đầu tiên và các dòng hoàn toàn rỗng SHALL bị bỏ qua.
11. IF nguồn dữ liệu chứa cột trùng tên hoặc ô tiêu đề rỗng, THEN THE Data_Source_Reader SHALL định danh mỗi cột bằng một tên duy nhất (thêm hậu tố phân biệt) để không mất cột.
12. WHERE file `.xlsx` chứa ô gộp (merged cell), THE Data_Source_Reader SHALL gán giá trị về ô trên-trái của vùng gộp và để các ô còn lại trong vùng ở dạng trống.
13. IF link Google Sheets không có quyền truy cập công khai (export CSV thất bại), THEN THE Data_Source_Reader SHALL trả về một thông báo lỗi nêu rõ thiếu quyền và SHALL không tạo bảng record.

### Requirement 2: Logic điều kiện đơn giản

**User Story:** Là người vận hành, tôi muốn đặt quy tắc điều kiện đơn giản dựa trên giá trị cột để ẩn/hiện field, chọn giá trị nội tuyến và đổi nội dung/ảnh, để một template phục vụ được nhiều trường hợp dữ liệu mà không cần lập trình.

#### Acceptance Criteria

1. WHERE một field được gán điều kiện ẩn/hiện dựa trên một toán tử so sánh trong tập toán tử hỗ trợ áp lên giá trị một cột, WHEN giá trị cột của record thoả điều kiện ẩn, THE Condition_Engine SHALL bỏ qua việc vẽ field đó cho record hiện tại.
2. WHERE một field được gán điều kiện ẩn/hiện dựa trên một toán tử so sánh trong tập toán tử hỗ trợ áp lên giá trị một cột, WHEN giá trị cột của record thoả điều kiện hiện, THE Condition_Engine SHALL vẽ field đó như bình thường.
3. WHEN nội dung field chứa token nội tuyến dạng `{Cot?A:B}` và giá trị cột `Cot` của record sau khi cắt khoảng trắng đầu/cuối khác chuỗi rỗng, THE Condition_Engine SHALL thay token bằng nhánh `A` được diễn giải như văn bản literal và SHALL không phân giải đệ quy token điều kiện lồng bên trong nhánh.
4. WHEN nội dung field chứa token nội tuyến dạng `{Cot?A:B}` và giá trị cột `Cot` của record sau khi cắt khoảng trắng đầu/cuối là chuỗi rỗng, THE Condition_Engine SHALL thay token bằng nhánh `B` được diễn giải như văn bản literal và SHALL không phân giải đệ quy token điều kiện lồng bên trong nhánh.
5. WHERE người dùng định nghĩa một bảng rule dạng "nếu cột X thoả một toán tử so sánh với giá trị V thì đặt nội dung/ảnh thành R", WHEN giá trị cột X của record thoả toán tử so sánh với V theo ngữ nghĩa so sánh chuẩn của Condition_Engine, THE Condition_Engine SHALL đặt nội dung hoặc ảnh của field đích thành R cho record hiện tại.
6. IF nhiều rule trong bảng cùng khớp một record, THEN THE Condition_Engine SHALL áp dụng rule khớp đầu tiên theo thứ tự khai báo và SHALL bỏ qua các rule khớp còn lại cho field đích đó.
7. IF một điều kiện hoặc rule tham chiếu đến một cột không tồn tại trong nguồn dữ liệu, THEN THE Condition_Engine SHALL gắn nhãn lỗi cho record và SHALL ghi lý do vào báo cáo lỗi.
8. WHEN nội dung field không chứa token điều kiện và không khớp rule nào, THE Condition_Engine SHALL giữ nguyên cơ chế thay placeholder hiện có (`{Cot}`, `{Cot[2|-]}`, `{Cot|func:arg}`) mà không thay đổi kết quả.
9. THE Condition_Engine SHALL hỗ trợ tập toán tử so sánh gồm {bằng, khác, chứa, rỗng, khác rỗng} cho cả điều kiện ẩn/hiện và bảng rule, và SHALL thực hiện so sánh giá trị dưới dạng chuỗi sau khi cắt khoảng trắng đầu/cuối, không phân biệt chữ hoa và chữ thường, trong đó "rỗng" nghĩa là chuỗi rỗng sau khi cắt khoảng trắng.
10. WHEN nhánh `A` hoặc `B` của token `{Cot?A:B}` cần chứa ký tự `:`, `}` hoặc `\` theo nghĩa đen, THE Condition_Engine SHALL nhận diện các chuỗi thoát `\:`, `\}`, `\\` và thay chúng bằng ký tự tương ứng mà không coi chúng là ranh giới/kết thúc token.
11. THE Condition_Engine SHALL xử lý mỗi field theo thứ tự cố định: trước tiên đánh giá điều kiện ẩn/hiện; nếu field được vẽ thì áp dụng bảng rule để xác định nội dung hoặc ảnh nguồn; sau đó phân giải token điều kiện nội tuyến `{Cot?A:B}`; cuối cùng thay các placeholder thường hiện có.

### Requirement 3: Barcode 2D công nghiệp (DataMatrix, GS1-128, GS1 DataMatrix)

**User Story:** Là người làm tem nhãn và truy xuất nguồn gốc, tôi muốn tạo DataMatrix ECC200, GS1-128 và GS1 DataMatrix với phân tích Application Identifier, để in được mã đạt chuẩn ngành mà không cần phần mềm ngoài.

#### Acceptance Criteria

1. WHEN một field barcode được cấu hình loại DataMatrix với một giá trị, THE Barcode_Renderer SHALL sinh mã DataMatrix theo chuẩn ECC200 biểu diễn giá trị đó.
2. WHEN một field barcode được cấu hình loại GS1-128 với một chuỗi chứa các AI, THE Barcode_Renderer SHALL phân tích các AI, chèn ký tự FNC1 ở vị trí khởi đầu và giữa các AI có độ dài thay đổi, và sinh mã Code128 tuân thủ GS1.
3. WHEN một field barcode được cấu hình loại GS1 DataMatrix với một chuỗi chứa các AI, THE Barcode_Renderer SHALL phân tích các AI, chèn FNC1 theo chuẩn GS1 và sinh mã DataMatrix ECC200 tuân thủ GS1.
4. WHEN một AI được nhận diện, THE Barcode_Renderer SHALL kiểm tra dữ liệu theo sau khớp định dạng và độ dài quy định cho AI đó, hỗ trợ tối thiểu các AI: `01` GTIN (14 chữ số), `17` hạn dùng (6 chữ số YYMMDD), `10` số lô (1–20 ký tự chữ-số), `21` serial (1–20 ký tự chữ-số).
5. IF một AI không hợp lệ hoặc dữ liệu theo sau không khớp định dạng AI, THEN THE Barcode_Renderer SHALL gắn nhãn ERR cho record và SHALL ghi lý do vào báo cáo lỗi thay vì sinh mã sai chuẩn.
6. WHERE giá trị barcode yêu cầu chữ số kiểm tra (check digit), THE Barcode_Renderer SHALL tính và đưa chữ số kiểm tra vào mã được sinh.
7. WHEN render một barcode 2D, THE Barcode_Renderer SHALL áp dụng màu vạch CMYK và vùng lề trắng (quiet zone) theo cùng cơ chế quy đổi `CSS_TO_PT_FACTOR` đang dùng cho QR và barcode 1D.
8. THE Barcode_Renderer SHALL tiếp tục hỗ trợ 7 loại barcode 1D hiện có (Code128, EAN13, EAN8, UPCA, Code39, ITF14, Codabar) và QR code với hành vi không đổi.
9. IF loại barcode được yêu cầu chưa được hỗ trợ, THEN THE Barcode_Renderer SHALL gắn nhãn ERR cho record với thông báo nêu rõ loại chưa hỗ trợ thay vì in sai symbology.
10. WHERE field là GS1-128 hoặc GS1 DataMatrix và bật hiển thị chữ người-đọc, THE Barcode_Renderer SHALL in chuỗi human-readable dạng `(AI)dữ_liệu` cho mỗi AID (ví dụ `(01)08412345678905(17)261231(10)LOT42`).
11. WHEN render barcode 2D (DataMatrix/GS1 DataMatrix), THE Barcode_Renderer SHALL bảo đảm kích thước module (X-dimension) ≥ 0.254 mm và quiet zone ≥ 1 module để máy quét đọc được; nếu khung quá nhỏ để đạt ngưỡng này THEN gắn nhãn ERR và ghi báo cáo lỗi thay vì sinh mã không quét được.

### Requirement 4: Preview từng record + điều hướng và xuất báo cáo lỗi

**User Story:** Là người vận hành, tôi muốn xem trước record thứ N và di chuyển giữa các record trước khi chạy cả lô, đồng thời xuất được báo cáo các dòng lỗi, để phát hiện sai sót sớm và biết chính xác dòng nào cần sửa.

#### Acceptance Criteria

1. WHEN người dùng yêu cầu xem trước record thứ N, THE Preview_Service SHALL sinh bản xem trước của template đã merge dữ liệu của record N theo đúng cấu hình field hiện tại.
2. WHEN người dùng chuyển tới record kế tiếp hoặc trước đó trong VDP_UI, THE Preview_Service SHALL cập nhật bản xem trước sang record tương ứng.
3. WHILE bản xem trước đang được sinh, THE VDP_UI SHALL giữ giao diện phản hồi được và SHALL không khoá thao tác người dùng; nếu thời gian sinh preview một record vượt 2 giây, THE VDP_UI SHALL hiển thị chỉ báo đang xử lý.
4. THE Preview_Service SHALL render bản xem trước dùng cùng toạ độ, hệ quy đổi `CSS_TO_PT_FACTOR` và quy tắc màu CMYK pure-K như khi sinh lô, để bản xem trước khớp với output cuối.
5. IF chỉ số record yêu cầu nhỏ hơn 1, THEN THE Preview_Service SHALL giới hạn về record 1; IF chỉ số lớn hơn số record của nguồn, THEN giới hạn về record cuối; và trong cả hai trường hợp SHALL thông báo đã giới hạn cho người dùng.
6. WHEN một record chứa field bị MISSING hoặc ERR, THE Preview_Service SHALL hiển thị dấu hiệu lỗi tương ứng tại đúng vị trí field bị lỗi trên bản xem trước.
7. WHEN người dùng yêu cầu xuất báo cáo lỗi, THE VDP_UI SHALL tạo một tệp báo cáo định dạng CSV, mỗi dòng gồm chỉ số dòng record, tên field liên quan và lý do, cho từng record có nhãn MISSING hoặc ERR.
8. WHERE không có record nào có lỗi, WHEN người dùng yêu cầu xuất báo cáo lỗi, THE VDP_UI SHALL tạo một báo cáo CSV cho biết không phát hiện lỗi.
9. WHEN cấu hình field thay đổi trong khi đang xem trước một record, THE Preview_Service SHALL sinh lại bản xem trước theo cấu hình field mới nhất.
10. IF nguồn dữ liệu có 0 record, THEN THE Preview_Service SHALL không sinh bản xem trước và SHALL thông báo nguồn rỗng cho người dùng.

### Requirement 5: Validate trước khi chạy cả lô

**User Story:** Là người vận hành, tôi muốn hệ thống kiểm tra cấu hình và dữ liệu trước khi sinh cả lô, để biết trước placeholder chưa map, ảnh thiếu hay giá trị barcode sai, thay vì chạy hết mới phát hiện lỗi.

#### Acceptance Criteria

1. WHEN người dùng khởi động kiểm tra trước khi chạy, THE Validator SHALL xác minh mọi placeholder và field đều tham chiếu đến cột tồn tại trong nguồn dữ liệu.
2. IF một placeholder hoặc field tham chiếu đến cột không tồn tại, THEN THE Validator SHALL báo lỗi nêu tên cột thiếu và field liên quan.
3. WHEN người dùng khởi động kiểm tra trước khi chạy, THE Validator SHALL xác minh các field ảnh biến đổi có file ảnh tồn tại cho TOÀN BỘ record (không lấy mẫu).
4. IF một field ảnh tham chiếu đến file không tồn tại, THEN THE Validator SHALL báo cảnh báo nêu chỉ số record và đường dẫn ảnh thiếu.
5. WHEN người dùng khởi động kiểm tra trước khi chạy, THE Validator SHALL xác minh giá trị của mỗi field barcode hợp lệ với symbology của field đó, bao gồm EAN13 đủ 13 chữ số, EAN8 đủ 8 chữ số, và GS1 AI đúng định dạng quy định.
6. IF một giá trị barcode không hợp lệ với symbology, THEN THE Validator SHALL báo lỗi nêu chỉ số record, field và lý do không hợp lệ.
7. THE Validator SHALL hoàn tất kiểm tra và trả về tập hợp lỗi và cảnh báo TRƯỚC khi VDP_Engine bắt đầu sinh bất kỳ trang nào của lô.
8. WHERE kết quả kiểm tra chứa LỖI mức chặn (cột thiếu cho placeholder/field, giá trị barcode không hợp lệ, hoặc nguồn chưa nạp/0 record), THE Validator SHALL trình bày danh sách lỗi và SHALL chặn sinh lô cho tới khi lỗi được khắc phục.
9. WHERE kết quả kiểm tra CHỈ chứa cảnh báo (vd ảnh biến đổi thiếu file), THE Validator SHALL trình bày danh sách cảnh báo và SHALL yêu cầu người dùng xác nhận trước khi cho phép sinh lô.
10. WHEN kiểm tra hoàn tất không có lỗi và không có cảnh báo, THE Validator SHALL cho phép tiến hành sinh lô mà không cần xác nhận.
11. IF nguồn dữ liệu chưa được nạp hoặc có 0 record, THEN THE Validator SHALL coi đây là LỖI mức chặn và SHALL không cho phép sinh lô.

### Requirement 6: Bảo toàn parity preview ↔ output và màu CMYK

**User Story:** Là người vận hành, tôi muốn bản xem trước ở frontend khớp chính xác với file PDF backend sinh ra, để cái tôi thấy đúng là cái được in.

#### Acceptance Criteria

1. THE VDP_Engine SHALL quy đổi toạ độ và kích thước field từ đơn vị frontend sang point backend bằng hằng số `CSS_TO_PT_FACTOR` bằng `0.75` cho mọi loại field.
2. WHEN người dùng chọn màu đen `#000000` cho một field, THE VDP_Engine SHALL render màu đó thành CMYK `(0, 0, 0, 1)` thuần kênh K.
3. THE Preview_Service SHALL dùng cùng công thức quy đổi toạ độ và chuyển màu CMYK như VDP_Engine, sao cho vị trí và màu của mọi field trong bản xem trước khớp với output sinh lô.
4. WHERE một field được cấu hình xoay 90, 180 hoặc 270 độ, THE Preview_Service và THE VDP_Engine SHALL render field với cùng kết quả xoay và vị trí.

### Requirement 7: Tương thích ngược với hành vi VDP hiện có

**User Story:** Là người dùng hiện tại, tôi muốn các job VDP cũ vẫn chạy y nguyên sau khi nâng cấp, để không phải làm lại template hay dữ liệu đã có.

#### Acceptance Criteria

1. WHEN người dùng nạp một file CSV với cấu hình field hiện có, THE VDP_Engine SHALL sinh output giống với hành vi trước khi nâng cấp.
2. THE VDP_Engine SHALL tiếp tục hỗ trợ mọi loại field hiện có (text, image, qrcode, barcode 1D) với toàn bộ tuỳ chọn hiện có (bold/italic thật, auto-fit, xoay, tách cột, định dạng placeholder, fit/shape ảnh, mức sửa lỗi QR).
3. WHERE một field không sử dụng tính năng điều kiện hoặc barcode 2D mới, THE Condition_Engine và THE Barcode_Renderer SHALL không làm thay đổi kết quả render của field đó.
4. THE VDP_Engine SHALL gán index template cho record theo công thức `record_idx % số trang template` như hành vi hiện có.

### Requirement 8: Hiệu năng và xử lý ca biên

**User Story:** Là người vận hành xử lý lô lớn, tôi muốn hệ thống xử lý mượt với hàng chục nghìn record và xử lý gọn các ca biên, để công việc không bị treo hay thất bại giữa chừng.

#### Acceptance Criteria

1. WHEN sinh một lô, THE VDP_Engine SHALL chia dữ liệu thành các chunk và xử lý bằng đa tiến trình như cơ chế hiện có.
2. WHILE đang sinh một lô gồm hàng chục nghìn record, THE VDP_Engine SHALL tiếp tục sinh đầy đủ trang cho mọi record mà không bỏ sót record.
3. IF một record gây ngoại lệ khi render một field, THEN THE VDP_Engine SHALL gắn nhãn ERR cho field của record đó và SHALL tiếp tục xử lý các record còn lại.
4. IF một field không có giá trị cột tương ứng cho một record, THEN THE VDP_Engine SHALL gắn nhãn MISSING cho field đó và SHALL tiếp tục xử lý các record còn lại.
5. WHILE người dùng xem trước một record, THE VDP_UI SHALL giữ giao diện phản hồi được và SHALL không treo trong khi chờ kết quả xem trước.
6. WHEN nguồn dữ liệu có cột thiếu, ảnh thiếu, hoặc giá trị barcode sai, THE VDP_Engine SHALL hoàn tất sinh lô cho các record hợp lệ và SHALL ghi nhận các record lỗi vào báo cáo lỗi.
