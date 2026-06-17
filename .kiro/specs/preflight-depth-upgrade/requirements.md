# Requirements Document

## Introduction

Tính năng **Preflight Depth Upgrade** hoàn thiện ba năng lực preflight của PrynX nhằm rút ngắn khoảng cách với Enfocus PitStop Pro. Mục tiêu không phải "lắp ghép tạm" mà là **hoàn thiện**: mỗi năng lực phải đúng số học, xử lý đủ ca biên, hiển thị/điều hướng trên UI, không phá vỡ đường chạy file lớn (multiprocessing), và auto-fix nơi an toàn.

Phạm vi gồm ba hạng mục:

1. **DPI hiệu dụng thật** — thay phép ước lượng "ảnh phủ kín trang" hiện tại trong `_check_image_resolution` bằng phép tính DPI dựa trên kích thước đặt ảnh thật (CTM × placement), áp dụng cho cả `IMAGE_LOW_RES` và `IMAGE_HIGH_DPI`, đúng cả khi một ảnh xuất hiện nhiều lần.
2. **Rule TAC / Ink-Limit** — thêm một rule preflight backend thật để cảnh báo trang/vùng có tổng mực (Total Area Coverage) vượt ngưỡng cấu hình được (mặc định 300%), tận dụng `SeparationEngine` đã tách kênh CMYK.
3. **UI Set Page Boxes thủ công** — hoàn thiện frontend cho `GET /preflight/page-boxes` và `POST /preflight/set-page-boxes` đã có sẵn ở backend, cho phép xem/sửa 5 box theo đơn vị toàn cục, áp cho 1 trang/dải trang/tất cả, preview và lưu file mới.

Tính năng kế thừa kiến trúc hiện có (không tái sinh): đường ghi PDF color-safe đi qua **pikepdf** (giữ CMYK/spot), tái dùng các engine/endpoint sẵn có (`geometry_reader`, `pdf_content_parser`, `SeparationEngine`, `PageBoxesEngine`, các mixin của `PreflightEngine`), và giữ tương thích đường file lớn `ProcessPoolExecutor`.

## Glossary

- **PrynX**: Bộ công cụ prepress PDF gồm FastAPI Python backend, React/Electron desktop, và thành phần Rust.
- **Preflight_Engine**: Lớp `PreflightEngine` (`backend/app/core/preflight_engine.py`) gồm các mixin rule, có hàm `run(pdf_path, rules)` và worker `_content_stream_worker` cho multiprocessing.
- **Image_Rules_Mixin**: Mixin `ImageRulesMixin` (`backend/app/core/preflight_rules/images.py`) chứa `_check_image_resolution`, `_get_page_images`.
- **Geometry_Reader**: Module `backend/app/core/geometry_reader.py`, hàm `list_objects(pdf_path, page_index)` trả `ObjMeta` gồm `bbox` (hệ PDF bottom-left, đơn vị point) và `matrix` (CTM) chính xác qua PDFium — CHỈ ĐỌC.
- **Content_Parser**: Module `backend/app/workers/pdf_content_parser.py`, có CTM stack đầy đủ (`q`/`Q`/`cm`) khi duyệt content stream.
- **Separation_Engine**: Lớp `SeparationEngine` (`backend/app/core/separations.py`) tách trang thành các bản kẽm CMYK + spot, trả mảng `ink_density` (0..255) theo từng kênh.
- **Page_Boxes_Engine**: Lớp `PageBoxesEngine` (`backend/app/core/page_boxes.py`) với `get_boxes`, `set_boxes`, `auto_trim`, `add_bleed_from_trim`.
- **Preflight_Issue**: Dataclass `PreflightIssue` (`backend/app/core/preflight_models.py`) gồm `rule_id`, `severity`, `page`, `object_ref`, `description`, `auto_fixable`, `bbox`, `bboxes`.
- **Effective_DPI**: Độ phân giải hiệu dụng của một ảnh khi đặt trên trang = pixel ảnh chia cho kích thước hiển thị tính bằng inch; với mỗi placement: `DPI = pixel / (placed_size_pt / 72)`.
- **Placement**: Một lần đặt (vẽ) ảnh trên trang qua toán tử `Do` với một CTM cụ thể; một XObject ảnh có thể có nhiều placement.
- **TAC**: Total Area Coverage — tổng phần trăm mực của các kênh tại một điểm, ví dụ C+M+Y+K (+spot). Đơn vị %, dải lý thuyết 0–400% (chỉ CMYK) hoặc cao hơn khi có spot.
- **TAC_Threshold**: Ngưỡng TAC tối đa cho phép (mặc định 300%), cấu hình được qua tham số rule.
- **Page_Box**: Một trong năm hộp trang PDF: MediaBox, CropBox, TrimBox, BleedBox, ArtBox.
- **Global_Unit**: Đơn vị đo toàn cục đang chọn ở UI, thuộc {pt, mm, inch, cm}.
- **Set_Page_Boxes_UI**: Thành phần frontend hoàn thiện việc xem/sửa Page_Box, mở rộng từ `PageBoxesTool.tsx`.
- **Large_File_Path**: Đường xử lý file lớn dùng `ProcessPoolExecutor` khi số trang vượt `CHUNK_SIZE` (10) trong Preflight_Engine.

## Requirements

### Requirement 1: Tính DPI hiệu dụng từ kích thước đặt ảnh thật

**User Story:** As a nhân viên prepress, I want preflight tính DPI ảnh theo kích thước đặt thật trên trang, so that ảnh nhỏ/tiled/đặt lệch không bị báo sai DPI.

#### Acceptance Criteria

1. WHEN Image_Rules_Mixin xử lý một ảnh đặt trên trang, THE Preflight_Engine SHALL tính Effective_DPI từ số pixel ảnh chia cho kích thước hiển thị thật của ảnh tính bằng inch, theo công thức `DPI = pixel / (placed_size_pt / 72)`.
2. WHEN Effective_DPI được tính, THE Preflight_Engine SHALL lấy kích thước hiển thị thật (placed width/height tính bằng point) từ CTM của placement, sử dụng Geometry_Reader hoặc Content_Parser thay cho giả định ảnh phủ kín MediaBox.
3. THE Preflight_Engine SHALL tính Effective_DPI riêng cho chiều ngang (`dpi_x`) và chiều dọc (`dpi_y`) và SHALL dùng giá trị nhỏ hơn làm Effective_DPI đại diện của placement.
4. WHEN một placement có Effective_DPI nhỏ hơn ngưỡng `MIN_IMAGE_DPI` VÀ rule `IMAGE_LOW_RES` đang bật, THE Preflight_Engine SHALL phát một Preflight_Issue `IMAGE_LOW_RES` cho placement đó.
5. WHEN một placement có Effective_DPI lớn hơn ngưỡng `MAX_IMAGE_DPI` VÀ rule `IMAGE_HIGH_DPI` đang bật, THE Preflight_Engine SHALL phát một Preflight_Issue `IMAGE_HIGH_DPI` cho placement đó.
6. THE Preflight_Engine SHALL ghi vào mỗi Preflight_Issue ảnh giá trị pixel thật (`width`×`height`) và Effective_DPI đã tính (làm tròn đến số nguyên) trong trường `description`.

### Requirement 2: Hỗ trợ một ảnh xuất hiện nhiều lần (đa placement)

**User Story:** As a nhân viên prepress, I want mỗi lần đặt của cùng một ảnh được đánh giá DPI riêng, so that tôi thấy đúng nơi ảnh bị phóng to quá mức.

#### Acceptance Criteria

1. WHEN một XObject ảnh được vẽ bằng nhiều toán tử `Do` với các CTM khác nhau trên cùng một trang, THE Preflight_Engine SHALL tính Effective_DPI độc lập cho từng placement.
2. IF nhiều placement của cùng một ảnh có Effective_DPI khác nhau qua các ngưỡng, THEN THE Preflight_Engine SHALL phát Preflight_Issue tương ứng cho từng placement vi phạm.
3. THE Preflight_Engine SHALL gắn cho mỗi Preflight_Issue ảnh trường `bbox` là vùng đặt thật của placement đó (hệ tọa độ PDF, đơn vị point) khi vùng đặt xác định được.
4. WHERE một ảnh xuất hiện qua Form XObject lồng nhau, THE Preflight_Engine SHALL nhân CTM của Form với CTM của placement để tính kích thước đặt thật trước khi tính Effective_DPI.
5. THE Preflight_Engine SHALL bảo đảm bộ đếm thống kê `_image_total` đếm theo số placement đã đánh giá, nhất quán giữa đường tuần tự và đường multiprocessing.

### Requirement 3: DPI hiệu dụng đúng trên đường file lớn (multiprocessing)

**User Story:** As a nhân viên prepress, I want DPI hiệu dụng chính xác cả với file nhiều trang, so that kết quả preflight không phụ thuộc kích thước file.

#### Acceptance Criteria

1. WHILE Preflight_Engine chạy theo Large_File_Path qua `ProcessPoolExecutor`, THE Preflight_Engine SHALL áp dụng cùng thuật toán tính Effective_DPI như đường tuần tự.
2. WHEN các chunk trang được xử lý song song, THE Preflight_Engine SHALL tổng hợp `_image_total`, `_image_low_res`, và `_image_min_dpi` từ tất cả chunk vào báo cáo cuối cùng.
3. THE Preflight_Engine SHALL cho ra cùng tập Preflight_Issue (bất kể thứ tự) khi chạy cùng một file qua đường tuần tự và qua Large_File_Path.
4. WHERE một chunk gặp lỗi phân tích nội dung, THE Preflight_Engine SHALL phát một Preflight_Issue `INTERNAL_ERROR` cho chunk đó và SHALL tiếp tục xử lý các chunk còn lại.

### Requirement 4: Xử lý ca biên khi tính DPI

**User Story:** As a nhân viên prepress, I want preflight không sập và không báo số vô lý với ảnh bất thường, so that báo cáo luôn tin cậy.

#### Acceptance Criteria

1. IF số pixel ảnh nhỏ hơn 1 hoặc kích thước đặt thật nhỏ hơn một ngưỡng tối thiểu (ví dụ < 1 point mỗi chiều), THEN THE Preflight_Engine SHALL bỏ qua placement đó mà không phát Preflight_Issue DPI.
2. IF không lấy được CTM hoặc vùng đặt của một placement, THEN THE Preflight_Engine SHALL bỏ qua việc tính DPI cho placement đó và SHALL ghi log ở mức debug mà không làm dừng quá trình.
3. WHEN một trang không có MediaBox hợp lệ, THE Preflight_Engine SHALL bỏ qua trang đó cho phần tính DPI, và bản thân thao tác bỏ qua đó SHALL không phát sinh lỗi.
4. WHEN một placement được đặt với CTM có thành phần xoay (rotation) hoặc nghiêng (skew), THE Preflight_Engine SHALL tính kích thước đặt thật từ độ dài hai vector cạnh sau biến đổi CTM.
5. WHILE không có placement nào được đánh giá trên toàn tài liệu, THE Preflight_Engine SHALL báo cáo `image_summary.min_dpi` bằng 0 thay vì giá trị canh giữ (sentinel).

### Requirement 5: Tương thích ngược và các rule ảnh hiện có

**User Story:** As a maintainer, I want việc nâng cấp DPI không phá các rule ảnh khác, so that hệ thống vẫn ổn định.

#### Acceptance Criteria

1. THE Preflight_Engine SHALL giữ nguyên hành vi của các rule `IMAGE_NOT_EMBEDDED`, `COLOR_RGB_DETECTED`, `COLOR_SPOT_DETECTED`, `GIF_IN_PDF`, và `PROGRESSIVE_JPEG`.
2. THE Image_Rules_Mixin SHALL tiếp tục dùng pikepdf để đọc thuộc tính ảnh (`/Width`, `/Height`, `/ColorSpace`) và SHALL chỉ thay phần ước lượng kích thước đặt bằng dữ liệu CTM/placement thật.
3. THE Preflight_Engine SHALL giữ nguyên cấu trúc Preflight_Issue và schema phản hồi API (`PreflightIssueResponse`) không đổi.
4. WHILE rule `IMAGE_HIGH_DPI` đang bật, THE Preflight_Engine SHALL luôn kích hoạt guard hiện có để không phát cảnh báo nhầm khi dữ liệu placement không khả dụng.

### Requirement 6: Rule TAC / Ink-Limit phát hiện vùng vượt ngưỡng mực

**User Story:** As a nhân viên prepress, I want một rule preflight cảnh báo trang/vùng có tổng mực vượt ngưỡng, so that tránh lỗi in lem, bong, khô chậm.

#### Acceptance Criteria

1. THE Preflight_Engine SHALL cung cấp một rule mới có `rule_id` là `TAC_EXCEEDED` trong danh sách `ALL_RULES`.
2. WHEN rule `TAC_EXCEEDED` chạy trên một trang, THE Preflight_Engine SHALL tính TAC tại mỗi điểm ảnh bằng tổng giá trị mực các kênh CMYK (và spot nếu có) lấy từ Separation_Engine.
3. WHEN TAC cực đại của một trang vượt TAC_Threshold, THE Preflight_Engine SHALL phát một Preflight_Issue `TAC_EXCEEDED` cho trang đó với `severity` mức `warning`.
4. THE Preflight_Engine SHALL ghi vào `description` của Preflight_Issue `TAC_EXCEEDED` giá trị TAC cao nhất của trang theo phần trăm (làm tròn đến số nguyên) và TAC_Threshold đang áp dụng.
5. WHERE phần trăm diện tích trang vượt ngưỡng tính được, THE Preflight_Engine SHALL bổ sung phần trăm diện tích vi phạm vào `description`.

### Requirement 7: Ngưỡng TAC cấu hình được

**User Story:** As a nhân viên prepress, I want đặt ngưỡng TAC theo điều kiện in (giấy, mực), so that rule phù hợp từng đơn hàng.

#### Acceptance Criteria

1. THE Preflight_Engine SHALL nhận TAC_Threshold dưới dạng tham số cấu hình của rule với giá trị mặc định 300 (phần trăm).
2. WHEN người dùng cung cấp một TAC_Threshold hợp lệ trong khoảng 100 đến 400, THE Preflight_Engine SHALL dùng giá trị đó thay cho mặc định.
3. IF TAC_Threshold cung cấp nằm ngoài khoảng 100 đến 400 hoặc không phải số, THEN THE Preflight_Engine SHALL từ chối giá trị đó và SHALL dùng giá trị mặc định 300.
4. THE preflight API SHALL cho phép truyền TAC_Threshold qua tham số yêu cầu khi gọi `inspect`.

### Requirement 8: Báo cáo vùng vi phạm TAC

**User Story:** As a nhân viên prepress, I want biết vùng nào trên trang vượt mực, so that tôi khoanh vùng sửa nhanh.

#### Acceptance Criteria

1. WHERE các vùng pixel vượt TAC_Threshold gom được thành cụm chữ nhật, THE Preflight_Engine SHALL gắn các vùng đó vào trường `bboxes` của Preflight_Issue `TAC_EXCEEDED` theo hệ tọa độ PDF (point).
2. THE Preflight_Engine SHALL giới hạn số bbox vi phạm báo cáo cho mỗi trang ở một trần hợp lý (ví dụ tối đa 50) để tránh báo cáo quá lớn.
3. IF không thể xác định vùng bbox vi phạm một cách tin cậy, THEN THE Preflight_Engine SHALL vẫn phát Preflight_Issue `TAC_EXCEEDED` ở mức trang với `bboxes` rỗng.
4. THE Preflight_Engine SHALL bảo đảm tọa độ bbox vi phạm được quy đổi đúng từ không gian pixel của Separation_Engine sang point theo tỷ lệ DPI render đã dùng.

### Requirement 9: TAC chạy đúng và hiệu quả trên file lớn

**User Story:** As a nhân viên prepress, I want rule TAC không làm treo khi quét nhiều trang, so that quy trình vẫn nhanh.

#### Acceptance Criteria

1. WHILE rule `TAC_EXCEEDED` chạy trên file vượt `CHUNK_SIZE` trang, THE Preflight_Engine SHALL xử lý theo Large_File_Path qua `ProcessPoolExecutor`.
2. THE Preflight_Engine SHALL render mỗi trang cho phân tích TAC ở độ phân giải đủ thấp để giữ thời gian xử lý mỗi trang trong giới hạn hợp lý, đồng thời đủ để phát hiện vùng vượt ngưỡng.
3. IF Separation_Engine không tách được kênh cho một trang, THEN THE Preflight_Engine SHALL phát một Preflight_Issue `INTERNAL_ERROR` cho trang đó và SHALL tiếp tục các trang còn lại.
4. WHERE trang chứa spot ink, THE Preflight_Engine SHALL cộng mật độ các kênh spot vào TAC cùng với các kênh process.

### Requirement 10: Auto-fix TAC (tùy chọn, đánh dấu rủi ro)

**User Story:** As a nhân viên prepress, I want biết liệu lỗi TAC có tự sửa được không, so that tôi quyết định sửa tay hay tự động.

#### Acceptance Criteria

1. THE Preflight_Engine SHALL đặt trường `auto_fixable` của Preflight_Issue `TAC_EXCEEDED` theo đánh giá rủi ro của hành vi giảm tổng mực.
2. WHERE auto-fix giảm tổng mực được cung cấp, THE đường ghi PDF SHALL đi qua pikepdf để giữ không gian màu CMYK/spot và SHALL KHÔNG dùng pdfium để ghi.
3. IF auto-fix TAC bị đánh giá rủi ro cao cho một tài liệu, THEN THE Preflight_Engine SHALL đánh dấu `auto_fixable` là false và SHALL nêu trong `description` rằng cần can thiệp thủ công.

### Requirement 11: Hiển thị và điều hướng lỗi TAC và DPI trên UI

**User Story:** As a nhân viên prepress, I want thấy và nhảy tới lỗi DPI/TAC trên giao diện preflight, so that tôi kiểm tra trực quan từng vùng.

#### Acceptance Criteria

1. WHEN báo cáo preflight chứa Preflight_Issue `IMAGE_LOW_RES`, `IMAGE_HIGH_DPI`, hoặc `TAC_EXCEEDED`, THE PrynX UI SHALL hiển thị các lỗi đó kèm số trang, mô tả, và mức độ.
2. WHEN người dùng chọn một Preflight_Issue có `bbox` hoặc `bboxes`, THE PrynX UI SHALL điều hướng tới trang tương ứng và SHALL làm nổi bật vùng vi phạm.
3. WHERE một Preflight_Issue không có dữ liệu vùng, THE PrynX UI SHALL điều hướng tới trang chứa lỗi mà không làm nổi bật vùng.
4. THE PrynX UI SHALL luôn hiển thị TAC_Threshold đang áp dụng, bất kể có hay không có lỗi `TAC_EXCEEDED`.

### Requirement 12: UI Set Page Boxes — xem 5 box hiện tại

**User Story:** As a nhân viên prepress, I want xem giá trị hiện tại của cả 5 box theo đơn vị đang chọn, so that tôi nắm được khổ trang trước khi sửa.

#### Acceptance Criteria

1. WHEN người dùng mở Set_Page_Boxes_UI cho một trang, THE Set_Page_Boxes_UI SHALL gọi `GET /preflight/page-boxes` và SHALL hiển thị MediaBox, CropBox, TrimBox, BleedBox, ArtBox.
2. THE Set_Page_Boxes_UI SHALL hiển thị giá trị mỗi box theo Global_Unit đang chọn, quy đổi từ giá trị mm mà backend trả về.
3. THE Set_Page_Boxes_UI SHALL chỉ rõ box nào được đặt tường minh và box nào kế thừa (dựa trên các cờ `has_trimbox`, `has_bleedbox`, `has_artbox`, `has_cropbox` từ backend).
4. WHEN người dùng đổi Global_Unit, THE Set_Page_Boxes_UI SHALL quy đổi và hiển thị lại tất cả giá trị box theo đơn vị mới mà không mất dữ liệu đang nhập.

### Requirement 13: UI Set Page Boxes — nhập/sửa từng box

**User Story:** As a nhân viên prepress, I want nhập/sửa từng box theo đơn vị đang chọn, so that tôi điều chỉnh khổ chính xác.

#### Acceptance Criteria

1. WHEN người dùng nhập giá trị mới cho một box theo Global_Unit, THE Set_Page_Boxes_UI SHALL quy đổi giá trị sang mm trước khi gửi `POST /preflight/set-page-boxes`.
2. THE Set_Page_Boxes_UI SHALL gửi `box_type` hợp lệ thuộc {mediabox, cropbox, trimbox, bleedbox, artbox} và `rect_mm` gồm `x0`, `y0`, `x1`, `y1`.
3. IF người dùng nhập một rectangle có `x1` không lớn hơn `x0` hoặc `y1` không lớn hơn `y0`, THEN THE Set_Page_Boxes_UI SHALL chặn gửi và SHALL hiển thị thông báo lỗi xác thực.
4. IF giá trị nhập không phải số hợp lệ, THEN THE Set_Page_Boxes_UI SHALL chặn gửi và SHALL hiển thị thông báo lỗi xác thực.
5. THE Set_Page_Boxes_UI SHALL bảo toàn độ chính xác làm tròn nhất quán với backend (2 chữ số thập phân ở mm) khi hiển thị giá trị sau khi lưu.

### Requirement 14: UI Set Page Boxes — phạm vi áp dụng trang

**User Story:** As a nhân viên prepress, I want chọn áp box cho 1 trang, một dải trang, hoặc tất cả, so that tôi xử lý đúng phạm vi.

#### Acceptance Criteria

1. THE Set_Page_Boxes_UI SHALL cho phép chọn phạm vi áp dụng là: một trang đơn, một dải trang, hoặc tất cả các trang.
2. WHEN người dùng chọn tất cả các trang, THE Set_Page_Boxes_UI SHALL gửi `pages` là null tới `POST /preflight/set-page-boxes`.
3. WHEN người dùng chọn một trang hoặc một dải trang, THE Set_Page_Boxes_UI SHALL gửi danh sách số trang 1-indexed tương ứng trong trường `pages`.
4. IF một trang đơn hoặc một dải trang nhập vào vượt ngoài tổng số trang của tài liệu, THEN THE Set_Page_Boxes_UI SHALL chặn gửi và SHALL hiển thị cùng một thông báo lỗi xác thực nêu khoảng trang hợp lệ.
5. IF dải trang có trang bắt đầu lớn hơn trang kết thúc, THEN THE Set_Page_Boxes_UI SHALL chặn gửi và SHALL hiển thị thông báo lỗi xác thực.

### Requirement 15: UI Set Page Boxes — preview và lưu file mới

**User Story:** As a nhân viên prepress, I want preview kết quả và lưu thành file mới, so that tôi kiểm tra trước khi dùng.

#### Acceptance Criteria

1. WHEN người dùng yêu cầu xem trước thay đổi box, THE Set_Page_Boxes_UI SHALL hiển thị ranh giới các box chồng lên trang đang xem.
2. WHEN `POST /preflight/set-page-boxes` trả về thành công, THE Set_Page_Boxes_UI SHALL nhận `output_filename` và SHALL cung cấp file kết quả cho người dùng qua luồng `onFileFixed` hiện có.
3. THE Page_Boxes_Engine SHALL ghi file kết quả qua pikepdf, giữ nguyên nội dung và không gian màu CMYK/spot.
4. IF lời gọi `set-page-boxes` thất bại, THEN THE Set_Page_Boxes_UI SHALL hiển thị thông báo lỗi và SHALL giữ nguyên các giá trị người dùng đang nhập.
5. THE Set_Page_Boxes_UI SHALL giữ nguyên các chức năng auto-trim và add-bleed hiện có như các thao tác bổ sung.

### Requirement 16: Tôn trọng đơn vị đo toàn cục

**User Story:** As a nhân viên prepress, I want mọi số đo hiển thị theo đơn vị toàn cục, so that tôi không phải quy đổi thủ công.

#### Acceptance Criteria

1. THE Set_Page_Boxes_UI SHALL hiển thị mọi số đo box theo Global_Unit thuộc {pt, mm, inch, cm}.
2. WHEN Global_Unit thay đổi ở bất kỳ đâu trong PrynX UI, THE Set_Page_Boxes_UI SHALL cập nhật đơn vị hiển thị ngay lập tức trong khi người dùng gõ hoặc đổi thiết lập.
3. THE Set_Page_Boxes_UI SHALL dùng hệ số quy đổi chuẩn (1 inch = 25.4 mm, 1 pt = 1/72 inch) cho mọi chuyển đổi giữa Global_Unit và mm.
4. WHERE hiển thị ngưỡng hoặc kích thước trong báo cáo DPI và TAC, THE PrynX UI SHALL nêu rõ đơn vị của giá trị (DPI cho độ phân giải, % cho TAC).

### Requirement 17: Bảo toàn kiến trúc và không tái sinh linh kiện

**User Story:** As a maintainer, I want tính năng tái dùng linh kiện sẵn có và giữ ràng buộc kiến trúc, so that codebase không bị trùng lặp hay phá vỡ.

#### Acceptance Criteria

1. THE Preflight_Engine SHALL tái dùng Geometry_Reader và Content_Parser để lấy dữ liệu placement/CTM thay vì viết lại bộ phân tích content stream mới.
2. THE rule TAC SHALL tái dùng Separation_Engine để lấy mật độ kênh thay vì viết lại bộ tách kênh mới.
3. THE Set_Page_Boxes_UI SHALL tái dùng các endpoint `GET /preflight/page-boxes` và `POST /preflight/set-page-boxes` của Page_Boxes_Engine sẵn có.
4. THE mọi đường ghi PDF của tính năng SHALL đi qua pikepdf và SHALL KHÔNG dùng pdfium để ghi.
5. THE Preflight_Engine SHALL giữ ngưỡng `CHUNK_SIZE` và cơ chế `ProcessPoolExecutor` hiện có cho đường file lớn.
