# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho tính năng cải tiến công cụ "Bình Tem Bế" (sticker imposer / ghép tem bế) của hệ thống pdfcompare. Hiện tại, khi người dùng nhập số lượng mục tiêu cho mỗi loại tem, công cụ **nhân bản vật lý** tờ in đã bình bài thành N trang PDF gần giống hệt nhau để đạt đủ số lượng (ví dụ: 10 loại × 1000 tem → khoảng 210 trang trùng lặp). Cách làm này không đúng với thực tế in ấn: thợ in xuất **một** tờ in đã bình bài rồi cài đặt máy in/máy in offset chạy N bản — họ không bao giờ xuất 100 trang giống hệt nhau.

Hành vi tham chiếu chuẩn là script Adobe Illustrator tại `scripts/illustrator/1. dev -  Nô lệ bình bài.jsx`. Script này tính số tem/tờ, số tờ cần in và số lượng thực, xuất ra **một** tờ in duy nhất cho mỗi loại tem (không nhân bản), và vẽ một khối "report" (lớp `Product_Info`) chứa thông tin sản xuất song ngữ lên tờ in.

Tính năng được chia thành 3 giai đoạn (Phase):

- **Phase 1 (lõi):** Thay đổi cách xuất file để mỗi loại tem tạo ra **một** tờ in duy nhất (không nhân bản); tính và trả về `số tờ cần in` (sheetsNeeded), `SL thực` (actualQty) và `số tem/tờ` (labelsPerSheet); số lượng trở thành **chỉ dẫn số bản in cho máy** chứ không phải số trang được nhân bản.
- **Phase 2:** Vẽ một khối report có thể cấu hình lên mỗi tờ in đầu ra (khối `Product_Info`).
- **Phase 3:** Giao diện cấu hình các trường report (bật/tắt, thứ tự, vị trí, cỡ chữ), mã đơn hàng, vật liệu, cán màng, và tùy chọn đặt tên file xuất theo nội dung report.

Mỗi yêu cầu dưới đây được gắn nhãn `[Phase 1]`, `[Phase 2]`, hoặc `[Phase 3]` để thể hiện giai đoạn triển khai.

## Glossary
- **Imposer_System**: Toàn bộ công cụ bình tem bế, gồm backend render và frontend cấu hình.
- **Render_Engine**: Thành phần backend thực hiện bình bài và xuất PDF (`nup_engine.run_nup_engine`, `nup_process_chunk.py`).
- **Preview_Service**: Endpoint xem trước bố cục (`/imposition/preview-layout`) tính toán và trả về bố cục dự kiến mà không xuất PDF cuối.
- **Imposer_UI**: Giao diện frontend cấu hình công cụ (`ImposerDashboard` và các section, store `useImposerSettingsStore`).
- **tem**: Một con tem / nhãn dán (label) thành phẩm sau khi bế; đơn vị sản phẩm nhỏ nhất.
- **loại tem (sticker type / design)**: Một thiết kế tem riêng biệt (một trang nguồn trong PDF đầu vào).
- **tờ**: Một tờ in vật lý (press sheet) đã được bình bài, chứa nhiều tem được xếp theo lưới.
- **SL/tờ (labelsPerSheet / itemsPerPage)**: Số tem được xếp trên một tờ in.
- **số tờ cần in (sheetsNeeded)**: Số tờ in cần thiết để đạt đủ số lượng mục tiêu của một loại tem, tính bằng `ceil(targetQuantity / labelsPerSheet)`.
- **SL thực (actualQty)**: Số lượng tem thực tế sản xuất sau khi xếp, tính bằng `sheetsNeeded × labelsPerSheet`; có thể lớn hơn hoặc bằng số lượng yêu cầu.
- **số bản in (print run)**: Số lượng bản mà máy in được cài đặt để chạy của một tờ in duy nhất; tương đương `sheetsNeeded`.
- **report (Product_Info)**: Khối văn bản chứa thông tin sản xuất được vẽ lên tờ in trên một lớp tên `Product_Info`.
- **bế (die-cut / cut file)**: File chứa đường bế (cutline) để cắt tem theo hình dạng thành phẩm.
- **cán màng (lamination)**: Lớp màng phủ bề mặt tem (cán bóng / cán mờ / không cán), có thể áp dụng 1 mặt hoặc 2 mặt.
- **mã ĐH (order code / identifier)**: Mã đơn hàng nhận diện công việc in, có thể có tiền tố cấu hình được.
- **Chế độ S&R (Step & Repeat)**: Chế độ bình bài trong đó mỗi tờ chỉ chứa duy nhất một loại tem (single-design-per-sheet).
- **Chế độ N-Up trộn (mixed ganging / auto-fill)**: Chế độ bình bài trong đó nhiều loại tem khác nhau cùng chia sẻ một tờ in.
- **bỏ dấu tiếng Việt (removeDiacritics)**: Tùy chọn loại bỏ dấu tiếng Việt khỏi văn bản report dùng để đặt tên file.

## Requirements

### Requirement 1: Xuất một tờ in duy nhất cho mỗi loại tem (Chế độ S&R) `[Phase 1]`

**User Story:** Là một thợ in trong xưởng in, tôi muốn mỗi loại tem chỉ xuất ra một tờ in đã bình bài duy nhất kèm chỉ dẫn số bản cần chạy, để tôi cài đặt máy in chạy số bản đó thay vì phải xử lý hàng trăm trang PDF trùng lặp.

#### Acceptance Criteria

1. WHERE chế độ bình bài là Chế độ S&R, WHEN người dùng yêu cầu xuất file với số lượng mục tiêu lớn hơn 0 cho một loại tem, THE Render_Engine SHALL tạo đúng một tờ in đã bình bài cho loại tem đó.
2. WHERE chế độ bình bài là Chế độ S&R, WHEN một tờ in cho một loại tem được xuất, THE Render_Engine SHALL KHÔNG nhân bản tờ in đó thành nhiều trang để đạt số lượng mục tiêu.
3. WHERE chế độ bình bài là Chế độ S&R, WHEN file đầu ra chứa nhiều loại tem, THE Render_Engine SHALL xuất đúng một tờ in cho mỗi loại tem, với tổng số trang đầu ra bằng số loại tem có số lượng mục tiêu lớn hơn 0.
4. IF số lượng mục tiêu của một loại tem bằng 0 trong chế độ tự lấp đầy một tờ (auto-fill), THEN THE Render_Engine SHALL áp dụng hành vi auto-fill hiện có cho loại tem đó.

### Requirement 2: Tính toán số tem/tờ, số tờ cần in và SL thực `[Phase 1]`

**User Story:** Là một thợ in, tôi muốn hệ thống tính chính xác số tem trên mỗi tờ, số tờ cần in và số lượng thực, để tôi biết chính xác cần cài máy in chạy bao nhiêu bản và sẽ ra bao nhiêu thành phẩm.

#### Acceptance Criteria

1. WHEN Render_Engine xếp một loại tem lên một tờ in, THE Render_Engine SHALL tính `số tem/tờ` (labelsPerSheet) bằng số tem được xếp trên một tờ.
2. WHEN số lượng mục tiêu của một loại tem lớn hơn 0, THE Render_Engine SHALL tính `số tờ cần in` (sheetsNeeded) bằng `ceil(targetQuantity / labelsPerSheet)`.
3. WHEN `số tờ cần in` đã được tính, THE Render_Engine SHALL tính `SL thực` (actualQty) bằng `sheetsNeeded × labelsPerSheet`.
4. IF `số tem/tờ` của một loại tem bằng 0, THEN THE Render_Engine SHALL trả về lỗi mô tả rõ rằng loại tem không thể xếp lên khổ giấy đã chọn.
5. WHEN một tác vụ xuất file hoàn tất cho một loại tem, THE Render_Engine SHALL trả về các giá trị `số tem/tờ`, `số tờ cần in` và `SL thực` cho từng loại tem trong kết quả tác vụ.

### Requirement 3: Số lượng là chỉ dẫn số bản in, không phải số trang nhân bản `[Phase 1]`

**User Story:** Là một thợ in, tôi muốn số lượng mục tiêu được diễn giải thành chỉ dẫn số bản cần chạy trên máy, để dữ liệu xuất ra phản ánh đúng quy trình in thực tế.

#### Acceptance Criteria

1. WHERE chế độ bình bài là Chế độ S&R, WHEN Render_Engine xuất một tờ in cho một loại tem, THE Render_Engine SHALL gắn kèm giá trị `số bản in` bằng `số tờ cần in` cho loại tem đó trong kết quả tác vụ.
2. WHEN kết quả xuất file được trả về cho Imposer_UI, THE Imposer_System SHALL hiển thị `số bản in` (số tờ cần in) cho mỗi loại tem.

### Requirement 4: Đồng bộ giữa Xem trước và Kết quả xuất `[Phase 1]`

**User Story:** Là một thợ in, tôi muốn bản xem trước bố cục khớp với file xuất ra, để tôi tin tưởng rằng những gì tôi thấy chính là những gì sẽ được in.

#### Acceptance Criteria

1. WHEN Preview_Service tính bố cục cho một loại tem, THE Preview_Service SHALL tính `số tem/tờ`, `số tờ cần in` và `SL thực` bằng cùng công thức mà Render_Engine sử dụng.
2. WHEN người dùng yêu cầu xem trước, THE Preview_Service SHALL trả về bố cục của một tờ in duy nhất cho mỗi loại tem trong Chế độ S&R, nhất quán với số tờ mà Render_Engine xuất ra.
3. IF tham số đầu vào (khổ giấy, kích thước tem, lưới, lề, số lượng) là như nhau, THEN giá trị `số tem/tờ`, `số tờ cần in` và `SL thực` do Preview_Service trả về SHALL bằng với giá trị do Render_Engine trả về.

### Requirement 5: Xử lý Chế độ N-Up trộn (nhiều loại tem trên một tờ) `[Phase 1]`

**User Story:** Là một thợ in, tôi muốn biết rõ hệ thống xử lý thế nào khi nhiều loại tem có số lượng khác nhau cùng nằm trên một tờ, để tôi không bị nhầm lẫn giữa hai mô hình bình bài.

#### Acceptance Criteria

1. WHERE chế độ bình bài là Chế độ N-Up trộn, THE Imposer_System SHALL giữ nguyên hành vi bình bài hiện có (mô hình "một tờ + N bản" không áp dụng đồng nhất khi các loại tem có số bản chạy khác nhau).
2. WHERE chế độ bình bài là Chế độ N-Up trộn, WHEN người dùng cấu hình xuất file, THE Imposer_UI SHALL thông báo rõ cho người dùng rằng mô hình "một tờ + N bản" chỉ áp dụng cho Chế độ S&R.
3. WHERE chế độ bình bài là Chế độ N-Up trộn, THE Imposer_System SHALL hiển thị `số tem/tờ` và `số tờ cần in` ở cấp độ tờ ghép (theo bố cục trộn hiện có) thay vì theo từng loại tem.

### Requirement 6: Vẽ khối report Product_Info lên tờ in `[Phase 2]`

**User Story:** Là một thợ in, tôi muốn mỗi tờ in có một khối thông tin sản xuất, để tôi và các bộ phận sau (bế, cán màng) đọc được thông số ngay trên tờ in mà không cần tra cứu file riêng.

#### Acceptance Criteria

1. WHERE tùy chọn hiển thị report được bật, WHEN Render_Engine xuất một tờ in, THE Render_Engine SHALL vẽ một khối văn bản report lên một lớp tên `Product_Info` của tờ in đó.
2. WHERE tùy chọn hiển thị report được bật, THE Render_Engine SHALL nối các trường report đang bật thành một chuỗi, ngăn cách nhau bằng chuỗi " - " (khoảng trắng, gạch ngang, khoảng trắng).
3. WHERE tùy chọn hiển thị report được bật, THE Render_Engine SHALL hỗ trợ các trường report sau: mã ĐH (identifier), tên tem (labelName), kích thước (dimensions), khổ giấy (paperSize), số tem/tờ (labelsPerSheet), số tờ cần in (sheetCount), SL thực (actualQty), vật liệu (material), cán màng (lamination), file bế (cutFileRef), và nhãn chế độ (modeLabel).
4. WHERE tùy chọn hiển thị report được bật, THE Render_Engine SHALL điền giá trị `số tem/tờ`, `số tờ cần in` và `SL thực` trong report bằng các giá trị đã tính ở Requirement 2.
5. WHILE bản xem trước đang hiển thị và tùy chọn report được bật, THE Preview_Service SHALL hiển thị khối report nhất quán với khối report mà Render_Engine sẽ vẽ.
6. IF không có trường report nào được bật và không có văn bản tùy chỉnh, THEN THE Render_Engine SHALL bỏ qua việc tạo lớp `Product_Info`.

### Requirement 7: Cấu hình bật/tắt, thứ tự và nội dung trường report `[Phase 3]`

**User Story:** Là một thợ in, tôi muốn tự chọn những trường nào hiển thị trên report và theo thứ tự nào, để khối thông tin đúng với quy ước của xưởng tôi.

#### Acceptance Criteria

1. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng bật hoặc tắt từng trường report một cách độc lập.
2. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng sắp xếp thứ tự các trường report.
3. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng nhập một đoạn văn bản tùy chỉnh (customText) để thêm vào report.
4. WHEN người dùng thay đổi cấu hình trường report, THE Render_Engine SHALL vẽ report theo đúng tập trường đang bật và thứ tự đã chọn.
5. THE Imposer_UI SHALL hiển thị nhãn trường report song ngữ (tiếng Việt là ngôn ngữ chính) nhất quán với script tham chiếu.

### Requirement 8: Cấu hình vị trí, cỡ chữ và bỏ dấu tiếng Việt của report `[Phase 3]`

**User Story:** Là một thợ in, tôi muốn điều chỉnh vị trí và cỡ chữ của report cũng như bỏ dấu tiếng Việt, để khối report nằm gọn ở chỗ không ảnh hưởng đến vùng tem và phù hợp với hệ thống sau in.

#### Acceptance Criteria

1. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng chọn vị trí khối report là một trong các giá trị: trên (top), dưới (bottom), trái (left), phải (right).
2. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng đặt cỡ chữ của report bằng một giá trị số dương.
3. WHERE tùy chọn bỏ dấu tiếng Việt được bật, WHEN Render_Engine vẽ report hoặc đặt tên file theo report, THE Render_Engine SHALL loại bỏ dấu tiếng Việt khỏi văn bản tương ứng.
4. WHEN người dùng thay đổi vị trí hoặc cỡ chữ report, THE Preview_Service SHALL phản ánh vị trí và cỡ chữ mới trong bản xem trước.

### Requirement 9: Cấu hình mã đơn hàng, vật liệu và cán màng `[Phase 3]`

**User Story:** Là một thợ in, tôi muốn nhập mã đơn hàng, chọn vật liệu và kiểu cán màng cho công việc, để các thông số này xuất hiện chính xác trong report.

#### Acceptance Criteria

1. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng nhập mã đơn hàng và một tiền tố mã đơn hàng cấu hình được.
2. WHEN trường mã ĐH được bật và mã đơn hàng có tiền tố, THE Render_Engine SHALL ghép tiền tố với mã đơn hàng trong report.
3. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng chọn vật liệu cho công việc in.
4. WHERE Imposer_UI hiển thị cấu hình report, THE Imposer_UI SHALL cho phép người dùng chọn kiểu cán màng (không cán / cán bóng / cán mờ) và số mặt cán (1 mặt hoặc 2 mặt).
5. WHEN trường cán màng được bật, THE Render_Engine SHALL hiển thị kiểu cán màng kèm số mặt cán trong report.

### Requirement 10: Đặt tên file xuất theo nội dung report `[Phase 3]`

**User Story:** Là một thợ in, tôi muốn tùy chọn đặt tên file PDF xuất ra theo nội dung report, để tôi dễ nhận diện file mà không cần mở chúng.

#### Acceptance Criteria

1. WHERE tùy chọn đặt tên file theo report (saveByReport) được bật, WHEN Render_Engine lưu file PDF của một tờ in, THE Render_Engine SHALL đặt tên file theo nội dung report của tờ in đó.
2. WHEN Render_Engine đặt tên file theo nội dung report, THE Render_Engine SHALL làm sạch tên file bằng cách thay thế hoặc loại bỏ các ký tự không hợp lệ trên hệ thống tệp.
3. WHERE tùy chọn đặt tên file bế theo file in (cutFileNameByPrint) được bật, WHEN Render_Engine lưu file bế kèm theo, THE Render_Engine SHALL đặt tên file bế dựa trên tên file in tương ứng.
4. IF nội dung report rỗng và tùy chọn đặt tên theo report được bật, THEN THE Render_Engine SHALL dùng quy ước đặt tên file mặc định.
