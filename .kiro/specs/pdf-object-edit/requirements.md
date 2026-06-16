# Requirements Document

> Tài liệu Yêu cầu — Edit PDF Object (chọn / xóa / di chuyển / resize / xoay / thêm đối tượng + sửa nội dung text), an toàn màu in.

## Introduction

Tính năng **Edit PDF Object** (tên nội bộ `pdf-object-edit`) cho PrynX cho phép người dùng thao tác trực tiếp trên khung xem trang (canvas) để **chọn, xóa, di chuyển, resize, xoay và thêm** các đối tượng PDF (text, image, vector/path), cũng như **sửa nội dung text ở mức "xóa + chèn lại"** (KHÔNG reflow đoạn như Adobe Acrobat). Mục tiêu là trải nghiệm chỉnh sửa mượt mà kiểu Acrobat nhưng **tuyệt đối an toàn cho dữ liệu in ấn**.

Kiến trúc đã được chốt qua spike chạy thật và là ràng buộc bắt buộc:

- **pikepdf = engine GHI (color-safe).** Mọi thao tác sửa được LƯU phải dùng pikepdf (`parse_content_stream` + `Matrix` + `unparse_content_stream`). Spike chứng minh pikepdf giữ nguyên operator màu CMYK `k` và spot `scn`.
- **PDFium (pypdfium2.raw) = engine ĐỌC hình học (read-only).** Dùng `FPDFPage_CountObjects` / `FPDFPage_GetObject` / `FPDFPageObj_GetType` / `FPDFPageObj_GetBounds` để liệt kê object, lấy bbox chính xác, phân loại, hit-test chọn object và render preview.
- **CẤM tuyệt đối** dùng PDFium `FPDFPage_GenerateContent` để ghi lên file in: spike chứng minh nó HỦY màu (CMYK `k` và spot `scn` biến mất, content bị viết lại thành RGB đen `0 0 0 rg`). Đây là lỗi correctness nghiêm trọng cho in ấn.
- **PyMuPDF / MuPDF (AGPL):** chỉ tham khảo nguyên lý, KHÔNG ship trong sản phẩm.

Mấu chốt kỹ thuật xuyên suốt: **cầu nối hai mô hình** — PDFium cung cấp object RỜI RẠC + bbox chính xác; pikepdf làm việc trên chuỗi operator PHẲNG. Hệ thống phải map "object i (bbox/type từ PDFium)" ↔ "đoạn operator tương ứng trong content stream" để sửa bằng pikepdf (giữ màu) mà không đụng các object khác, theo dõi graphics-state/CTM khi tokenize (đã có tiền lệ ở `remove_text_from_stream`).

Tính năng tái dùng nền tảng PrynX đã có và đã audit: Selection Mode (`isSelectionMode`, `selectedObjectIds`, `hiddenObjectIds`), overlay bbox trên canvas, phím Delete/Esc/Ctrl+A; backend `GET /preflight/objects/{fid}/{page}`, `POST /preflight/delete-object`, `POST /preflight/preview-hide`; engine `pdf_object_ops.py`; UX kéo/resize/sửa-text inline của VDP (`vdpInteraction`, `editingTextId`, `editTextContent`); undo thô qua `commitWorkingFile`; OCG layers.

### Phân pha (scope)
- **Pha 1 — Liệt kê chính xác + sửa lỗi xóa hiện có:** liệt kê text/image/vector với bbox đúng qua PDFium; sửa lỗi xóa nhầm toàn bộ ảnh; hỗ trợ xóa vector.
- **Pha 2 — Transform object có sẵn:** di chuyển / resize / xoay qua pikepdf stream surgery + UX kéo handle (tái dùng VDP).
- **Pha 3 — Sửa nội dung text:** xóa + chèn lại cùng font/size/vị trí; xử lý font tiếng Việt khi chèn.
- **Thêm object mới** (text/image) tái dùng hệ overlay VDP.
- **Bảo toàn màu in** là correctness property hàng đầu xuyên suốt mọi pha.

### Ngoài phạm vi (Out of scope)
- Reflow đoạn text kiểu Acrobat (điều chỉnh ngắt dòng/giãn đoạn tự động).
- Chỉnh sửa form fields (AcroForm) và annotation nâng cao.
- Ghi file qua PDFium `GenerateContent` (bị cấm vì hủy màu).

## Glossary

- **Edit_System**: toàn bộ tính năng Edit PDF Object (frontend canvas + backend engine).
- **Geometry_Reader**: thành phần backend dùng PDFium (pypdfium2.raw, read-only) để liệt kê object, lấy bbox, phân loại type, hit-test.
- **Stream_Editor**: thành phần backend dùng pikepdf để sửa content stream (xóa/transform/chèn) một cách color-safe.
- **Object_Mapper**: thành phần ánh xạ một object PDFium (index/type/bbox) sang đoạn operator tương ứng trong content stream, có theo dõi CTM/graphics-state.
- **Canvas_UI**: khung xem trang ở frontend (LivePageFrame) hiển thị overlay bbox, handle kéo/resize/xoay, và editor text inline.
- **PDF_Object**: một đối tượng trang thuộc loại `text`, `image`, hoặc `vector` (path).
- **BBox**: hộp bao [x0, y0, x1, y1] theo hệ tọa độ trang (point), lấy từ PDFium `FPDFPageObj_GetBounds`.
- **Color_Operators**: tập operator màu trong content stream gồm `k`/`K` (CMYK), `scn`/`SCN` (spot/separation/ICC), `cs`/`CS`, `rg`/`RG`, `g`/`G`, cùng overprint (`OP`/`op`/`OPM`).
- **Untouched_Object**: object KHÔNG nằm trong tập mục tiêu của thao tác sửa hiện tại.
- **Round_Trip**: chu trình mở file → sửa → lưu → mở lại.
- **Working_File**: file PDF đang chỉnh sửa trong phiên làm việc; lịch sử quản lý qua `commitWorkingFile`.
- **Selection_Mode**: chế độ chọn object đã có (`isSelectionMode`).

---

## Requirements

### Yêu cầu 1 — Liệt kê object chính xác (text / image / vector) với bbox đúng

**User Story:** Là một người chế bản, tôi muốn thấy chính xác mọi đối tượng (text, ảnh, vector) trên trang cùng hộp bao đúng vị trí, để tôi chọn đúng thứ cần sửa thay vì cả trang.

#### Acceptance Criteria
1. WHEN người dùng bật Selection_Mode trên một trang THE Geometry_Reader SHALL liệt kê tất cả PDF_Object của trang đó kèm `type` ∈ {`text`, `image`, `vector`} và BBox lấy từ PDFium `FPDFPageObj_GetBounds`.
2. WHEN một object là ảnh THE Geometry_Reader SHALL trả về BBox bao đúng vùng hiển thị của ảnh đó (KHÔNG dùng kích thước cả trang làm BBox).
3. WHEN một object là vector/path THE Geometry_Reader SHALL liệt kê object đó với `type = vector` và BBox tương ứng (PDFium `GetType = PATH`).
4. THE Geometry_Reader SHALL gán cho mỗi PDF_Object một định danh ổn định trong phạm vi một lần liệt kê của một trang, đủ để Object_Mapper ánh xạ lại object đó về đoạn operator trong content stream.
5. IF một trang không có object nào thuộc một loại THEN THE Geometry_Reader SHALL trả về danh sách rỗng cho loại đó mà không phát sinh lỗi.
6. THE Geometry_Reader SHALL thực hiện liệt kê ở chế độ chỉ-đọc và SHALL NOT ghi thay đổi nào vào file qua PDFium.
7. WHEN sai số làm tròn tọa độ xảy ra giữa PDFium và content stream THE Edit_System SHALL giữ sai lệch BBox mỗi cạnh trong khoảng tolerance ≤ 1.0 point.

### Yêu cầu 2 — Hit-test chọn object trên canvas

**User Story:** Là một người dùng, tôi muốn bấm vào một đối tượng trên canvas và chọn đúng nó, để thao tác chính xác kể cả khi các object chồng lên nhau.

#### Acceptance Criteria
1. WHEN người dùng bấm vào một điểm trên Canvas_UI trong Selection_Mode THE Edit_System SHALL chọn PDF_Object có BBox chứa điểm đó.
2. WHILE nhiều PDF_Object cùng chứa điểm bấm THE Edit_System SHALL ưu tiên chọn object có BBox diện tích nhỏ nhất (object nằm trên/cụ thể hơn).
3. WHEN người dùng nhấn Ctrl+A trong Selection_Mode THE Edit_System SHALL chọn tất cả PDF_Object của trang hiện tại.
4. WHEN người dùng nhấn Esc THE Edit_System SHALL bỏ chọn toàn bộ PDF_Object.
5. WHEN một hoặc nhiều PDF_Object đang được chọn THE Canvas_UI SHALL vẽ overlay BBox quanh từng object được chọn.

### Yêu cầu 3 — Xóa đúng object mục tiêu (sửa lỗi xóa hiện có)

**User Story:** Là một người chế bản, tôi muốn xóa đúng một ảnh (hoặc vector, hoặc text) mà tôi chọn, để các đối tượng khác trên trang không bị mất theo.

#### Acceptance Criteria
1. WHEN người dùng xóa một image PDF_Object được chọn THE Stream_Editor SHALL chỉ loại bỏ đúng ảnh đó và SHALL giữ nguyên các ảnh còn lại trên trang.
2. WHEN người dùng xóa một vector PDF_Object được chọn THE Stream_Editor SHALL loại bỏ đúng đoạn operator path tương ứng của vector đó.
3. WHEN người dùng xóa một text PDF_Object được chọn THE Stream_Editor SHALL loại bỏ đúng cụm text tương ứng theo kỹ thuật phẫu thuật content-stream theo CTM/Tm.
4. FOR ALL Untouched_Object trên trang, WHEN một thao tác xóa hoàn tất THE Stream_Editor SHALL giữ nguyên nội dung và operator của các Untouched_Object đó (chỉ-loại-đúng-mục-tiêu).
5. IF tập object cần xóa rỗng THEN THE Stream_Editor SHALL không thay đổi Working_File và SHALL trả về trạng thái không có thay đổi.
6. WHEN nhiều PDF_Object thuộc nhiều loại được chọn cùng lúc để xóa THE Stream_Editor SHALL xóa đúng tập object đó trong một thao tác.

### Yêu cầu 4 — Bảo toàn màu in (CORRECTNESS PROPERTY HÀNG ĐẦU)

**User Story:** Là một người chế bản in ấn, tôi muốn mọi thao tác sửa giữ nguyên màu CMYK / spot / overprint / ICC của các đối tượng, để bản in không bị sai màu hay mất kênh mực.

#### Acceptance Criteria
1. WHEN bất kỳ thao tác sửa nào (xóa / di chuyển / resize / xoay / thêm) được LƯU THE Stream_Editor SHALL ghi qua pikepdf (`parse_content_stream` + `unparse_content_stream`) và SHALL NOT dùng PDFium `FPDFPage_GenerateContent`.
2. FOR ALL Untouched_Object, WHEN một thao tác sửa một object hoàn tất THE Stream_Editor SHALL giữ nguyên các Color_Operators (`k`/`K`, `scn`/`SCN`, `cs`/`CS`, `rg`/`RG`, `g`/`G`) của các Untouched_Object đó, không đổi giá trị và không thay loại operator.
3. WHEN một object dùng màu CMYK (`k`) đi qua Round_Trip THE Stream_Editor SHALL giữ nguyên operator `k` cùng các giá trị thành phần của object đó.
4. WHEN một object dùng màu spot/separation (`scn` với colorspace `/Separation` hoặc `/DeviceN`) đi qua Round_Trip THE Stream_Editor SHALL giữ nguyên operator `scn` và định nghĩa colorspace tương ứng.
5. WHEN một object có thiết lập overprint (`OP`/`op`/`OPM`) đi qua Round_Trip THE Stream_Editor SHALL giữ nguyên các thiết lập overprint đó.
6. WHERE một object tham chiếu ICC profile qua colorspace (`/ICCBased`) THE Stream_Editor SHALL giữ nguyên tham chiếu ICC profile đó sau khi lưu.
7. IF một thao tác sửa không thể hoàn tất mà không làm thay đổi Color_Operators của Untouched_Object THEN THE Stream_Editor SHALL hủy thao tác và SHALL báo lỗi rõ ràng thay vì lưu kết quả sai màu.

### Yêu cầu 5 — Di chuyển object (move)

**User Story:** Là một người dùng, tôi muốn kéo một đối tượng tới vị trí mới, để bố cục trang đúng ý mà không phải dựng lại file.

#### Acceptance Criteria
1. WHEN người dùng kéo một PDF_Object được chọn một đoạn `(dx, dy)` trên Canvas_UI và lưu THE Stream_Editor SHALL áp dụng phép tịnh tiến tương ứng vào CTM của object đó qua pikepdf `Matrix`.
2. WHEN một object được di chuyển `(dx, dy)` THE BBox mới của object đó SHALL bằng BBox cũ cộng `(dx, dy)` trên mỗi tọa độ với sai số ≤ 1.0 point mỗi cạnh.
3. WHILE người dùng đang kéo một object THE Canvas_UI SHALL hiển thị vị trí dự kiến của object theo thời gian thực.
4. FOR ALL Untouched_Object, WHEN một thao tác di chuyển hoàn tất THE Stream_Editor SHALL giữ nguyên vị trí và Color_Operators của các Untouched_Object đó.
5. WHEN nhiều PDF_Object được chọn cùng lúc và di chuyển THE Stream_Editor SHALL áp dụng cùng độ dịch `(dx, dy)` cho tất cả object trong tập chọn.

### Yêu cầu 6 — Resize object

**User Story:** Là một người dùng, tôi muốn thay đổi kích thước một đối tượng bằng cách kéo handle góc, để vừa khít bố cục.

#### Acceptance Criteria
1. WHEN người dùng kéo một handle resize (nw/ne/sw/se) của một PDF_Object được chọn và lưu THE Stream_Editor SHALL áp dụng phép biến đổi tỉ lệ tương ứng vào CTM của object đó qua pikepdf `Matrix`.
2. WHEN một object được resize THE BBox mới của object đó SHALL khớp kích thước mục tiêu do người dùng đặt với sai số ≤ 1.0 point mỗi cạnh.
3. WHILE người dùng đang kéo handle resize THE Canvas_UI SHALL hiển thị handle nw/ne/sw/se và kích thước dự kiến theo thời gian thực.
4. FOR ALL Untouched_Object, WHEN một thao tác resize hoàn tất THE Stream_Editor SHALL giữ nguyên kích thước, vị trí và Color_Operators của các Untouched_Object đó.
5. IF kích thước resize mục tiêu làm chiều rộng hoặc chiều cao của object ≤ 0 THEN THE Edit_System SHALL từ chối thao tác và giữ nguyên object.

### Yêu cầu 7 — Xoay object (rotate)

**User Story:** Là một người dùng, tôi muốn xoay một đối tượng quanh tâm của nó, để chỉnh hướng hiển thị.

#### Acceptance Criteria
1. WHEN người dùng xoay một PDF_Object được chọn một góc `θ` và lưu THE Stream_Editor SHALL áp dụng phép xoay tương ứng vào CTM của object đó qua pikepdf `Matrix`, lấy tâm xoay là tâm BBox của object.
2. WHEN một object được xoay góc `θ` rồi xoay tiếp `-θ` (quanh cùng tâm) THE BBox kết quả SHALL trùng với BBox ban đầu với sai số ≤ 1.0 point mỗi cạnh.
3. WHILE người dùng đang xoay một object THE Canvas_UI SHALL hiển thị góc xoay dự kiến theo thời gian thực.
4. FOR ALL Untouched_Object, WHEN một thao tác xoay hoàn tất THE Stream_Editor SHALL giữ nguyên hướng, vị trí và Color_Operators của các Untouched_Object đó.

### Yêu cầu 8 — Sửa nội dung text (xóa + chèn lại, không reflow)

**User Story:** Là một người chế bản, tôi muốn sửa nội dung một cụm text tại chỗ với cùng font, cỡ chữ và vị trí, để chỉnh sửa chữ mà không phải tái dựng trang.

#### Acceptance Criteria
1. WHEN người dùng sửa nội dung một text PDF_Object và lưu THE Stream_Editor SHALL xóa cụm text cũ và chèn lại cụm text mới tại cùng vị trí gốc, dùng cùng font và cỡ chữ của cụm text cũ.
2. THE Stream_Editor SHALL thực hiện sửa text ở mức "xóa + chèn lại" và SHALL NOT thực hiện reflow đoạn (không tự ngắt dòng/giãn đoạn các cụm text khác).
3. WHERE nội dung text mới chứa ký tự tiếng Việt có dấu THE Stream_Editor SHALL nhúng hoặc tham chiếu font có đủ glyph cho các ký tự đó để hiển thị đúng.
4. IF font gốc của cụm text không hỗ trợ ký tự trong nội dung mới VÀ không có font thay thế đủ glyph THEN THE Edit_System SHALL báo lỗi rõ ràng và SHALL NOT lưu kết quả thiếu glyph (không hiển thị ô vuông/.notdef).
5. WHILE người dùng đang sửa text THE Canvas_UI SHALL hiển thị editor text inline tại vị trí cụm text (tái dùng `editingTextId` / `editTextContent`).
6. FOR ALL Untouched_Object, WHEN một thao tác sửa text hoàn tất THE Stream_Editor SHALL giữ nguyên nội dung, vị trí và Color_Operators của các Untouched_Object đó.

### Yêu cầu 9 — Thêm object mới (text / image)

**User Story:** Là một người dùng, tôi muốn thêm một cụm text hoặc một ảnh mới lên trang, để bổ sung nội dung mà không cần công cụ ngoài.

#### Acceptance Criteria
1. WHEN người dùng thêm một cụm text mới tại một vị trí trên Canvas_UI và lưu THE Stream_Editor SHALL chèn cụm text đó vào content stream tại vị trí tương ứng với font và cỡ chữ do người dùng chọn.
2. WHEN người dùng thêm một ảnh mới tại một vị trí trên Canvas_UI và lưu THE Stream_Editor SHALL chèn ảnh đó dưới dạng XObject và operator vẽ tại BBox tương ứng.
3. WHERE nội dung text mới thêm chứa ký tự tiếng Việt có dấu THE Stream_Editor SHALL nhúng hoặc tham chiếu font có đủ glyph cho các ký tự đó.
4. FOR ALL Untouched_Object, WHEN một thao tác thêm object hoàn tất THE Stream_Editor SHALL giữ nguyên nội dung và Color_Operators của các Untouched_Object đó (chỉ bổ sung, không sửa object cũ).
5. WHILE người dùng đang đặt object mới THE Canvas_UI SHALL hiển thị overlay vị trí dự kiến (tái dùng hệ overlay VDP).

### Yêu cầu 10 — Round-trip lưu file không đổi nội dung ngoài thao tác

**User Story:** Là một người chế bản, tôi muốn lưu file sau khi sửa mà phần còn lại của tài liệu y nguyên, để không phát sinh khác biệt ngoài ý muốn.

#### Acceptance Criteria
1. WHEN một thao tác sửa được lưu THE Stream_Editor SHALL chỉ thay đổi đúng các object mục tiêu của thao tác đó và SHALL giữ nguyên mọi PDF_Object khác qua Round_Trip.
2. WHEN một trang KHÔNG có thao tác sửa nào được áp dụng đi qua Round_Trip THE Stream_Editor SHALL giữ nội dung content stream của trang đó tương đương về mặt hiển thị và Color_Operators.
3. WHEN file được lưu THE Stream_Editor SHALL giữ nguyên các tài nguyên trang không liên quan (XObject, font, colorspace, OCG layers) ngoài những thay đổi do thao tác sửa yêu cầu.
4. THE Stream_Editor SHALL lưu kết quả ra Working_File mới và SHALL NOT ghi đè file gốc do người dùng tải lên.

### Yêu cầu 11 — Undo / Redo

**User Story:** Là một người dùng, tôi muốn hoàn tác và làm lại các thao tác sửa, để khôi phục khi thao tác nhầm.

#### Acceptance Criteria
1. WHEN người dùng thực hiện một thao tác sửa (xóa / di chuyển / resize / xoay / sửa text / thêm) THE Edit_System SHALL ghi một mục lịch sử vào history stack qua `commitWorkingFile`.
2. WHEN người dùng yêu cầu Undo THE Edit_System SHALL khôi phục Working_File về trạng thái ngay trước thao tác gần nhất.
3. WHEN người dùng yêu cầu Redo sau khi Undo THE Edit_System SHALL áp dụng lại thao tác vừa bị hoàn tác.
4. WHEN người dùng thực hiện Undo rồi Redo trên cùng một thao tác THE trạng thái Working_File kết quả SHALL tương đương trạng thái sau thao tác ban đầu (Color_Operators và BBox được giữ).

### Yêu cầu 12 — Preview khớp kết quả lưu

**User Story:** Là một người dùng, tôi muốn ảnh preview phản ánh đúng kết quả sau khi lưu, để tin tưởng vào những gì mình thấy trên canvas.

#### Acceptance Criteria
1. WHEN người dùng đang xem preview của một thao tác sửa (qua PDFium render) THE Canvas_UI SHALL hiển thị kết quả khớp về mặt hình học với object đã sửa (vị trí/kích thước/hướng trong tolerance ≤ 1.0 point mỗi cạnh).
2. WHERE preview được tạo bằng PDFium render THE Edit_System SHALL chỉ dùng PDFium để render hình ảnh xem trước và SHALL NOT dùng PDFium để ghi file kết quả.
3. WHEN một thao tác sửa được lưu THE kết quả lưu (qua pikepdf) SHALL nhất quán về hình học với preview đã hiển thị.

### Yêu cầu 13 — Hiệu năng với file lớn

**User Story:** Là một người dùng làm việc với file in nhiều object, tôi muốn thao tác sửa vẫn phản hồi được, để không bị treo khi xử lý trang phức tạp.

#### Acceptance Criteria
1. WHILE một trang chứa tới 5000 PDF_Object THE Geometry_Reader SHALL hoàn tất liệt kê object của trang đó và trả về cho Canvas_UI mà không gây treo (không vượt giới hạn timeout phản hồi của hệ thống).
2. WHEN người dùng kéo, resize hoặc xoay một object THE Canvas_UI SHALL cập nhật overlay xem trước theo thời gian thực mà không gọi lưu file ở mỗi khung hình.
3. WHEN số lượng vector path vượt ngưỡng xử lý an toàn THE Geometry_Reader SHALL áp dụng giới hạn/gộp đã có (merge_rects) để tránh độ phức tạp O(N²) gây timeout.
4. IF một thao tác sửa vượt thời gian xử lý cho phép THEN THE Edit_System SHALL báo lỗi rõ ràng và giữ nguyên Working_File thay vì để treo vô hạn.

---

## Correctness Properties cho Property-Based Testing (PBT)

Các thuộc tính sau là mục tiêu PBT trọng yếu (kiểm trên tập PDF sinh ngẫu nhiên có CMYK/spot/overprint/ICC):

1. **Bảo toàn màu của Untouched_Object (Invariant).** Với mọi thao tác sửa một tập object mục tiêu, tập Color_Operators của các Untouched_Object trước và sau khi lưu là bằng nhau. (Yêu cầu 4.2, 3.4)
2. **Move = dịch bbox (Metamorphic).** Sau khi di chuyển object một đoạn `(dx, dy)`, BBox mới = BBox cũ + `(dx, dy)` với sai số ≤ 1.0 point mỗi cạnh. (Yêu cầu 5.2)
3. **Xóa chỉ loại đúng object mục tiêu (Invariant).** Sau khi xóa tập mục tiêu, số lượng và nội dung của các Untouched_Object không đổi; đúng các object mục tiêu biến mất. (Yêu cầu 3.1, 3.4)
4. **Round-trip lưu không đổi nội dung ngoài thao tác (Round-trip).** Mở → (không sửa) → lưu → mở lại cho content tương đương hiển thị + giữ Color_Operators; và mở → sửa-một-object → lưu → mở lại chỉ khác đúng ở object đó. (Yêu cầu 10.1, 10.2)
5. **Round-trip màu CMYK/spot (Round-trip).** Object dùng `k` / `scn` sau Round_Trip giữ nguyên operator và giá trị màu. (Yêu cầu 4.3, 4.4)
6. **Rotate khả nghịch (Round-trip).** Xoay `θ` rồi `-θ` quanh cùng tâm trả về BBox ban đầu trong tolerance. (Yêu cầu 7.2)
7. **Undo/Redo idempotent theo cặp (Round-trip).** Undo rồi Redo một thao tác cho trạng thái tương đương sau thao tác ban đầu. (Yêu cầu 11.4)

> Lưu ý phạm vi PBT: các thuộc tính trên kiểm **logic engine của ta** (Stream_Editor / Object_Mapper) trên PDF in-memory/đĩa, chi phí thấp — phù hợp PBT 100+ iteration. Việc "render PDFium hiển thị đúng pixel" thuộc nhóm hành vi thư viện ngoài → kiểm bằng integration test với 1–3 ví dụ đại diện, KHÔNG PBT.

---

## Assumptions

- pypdfium2 (PDFium) khả dụng trong môi trường backend và cung cấp các API `FPDFPage_CountObjects`, `FPDFPage_GetObject`, `FPDFPageObj_GetType`, `FPDFPageObj_GetBounds`.
- pikepdf hỗ trợ `parse_content_stream` / `unparse_content_stream` / `Matrix` trên các file mục tiêu.
- Thứ tự object PDFium liệt kê tương ứng (theo thứ tự vẽ) với thứ tự operator trong content stream, đủ để Object_Mapper ánh xạ; trường hợp nhiều content stream được gộp như trong `remove_text_from_stream`.
- File có thể tham chiếu font CID/embedded; với chèn/sửa text tiếng Việt, có sẵn font dự phòng đủ glyph (ví dụ DejaVuSans trong `app/assets/fonts`).
- Tọa độ trang dùng hệ point; chuyển đổi gốc tọa độ (top-left canvas ↔ bottom-left PDF) xử lý qua MediaBox như tiền lệ hiện có.
- Selection_Mode, overlay bbox, và history (`commitWorkingFile`) của PrynX hoạt động đúng và được tái dùng.

## Risks

- **Map object ↔ operator-range cho path phức tạp:** vector lồng nhau, clip path, q/Q lồng, hoặc inline image (`BI...EI`) có thể làm ánh xạ object↔operator khó chính xác; rủi ro xóa/transform lệch object. Giảm thiểu: theo dõi graphics-state đầy đủ và kiểm bằng PBT thuộc tính 1 & 3.
- **Bảo toàn màu khi unparse:** mọi đường ghi phải qua pikepdf; bất kỳ nhánh nào lỡ dùng PDFium GenerateContent sẽ hủy màu. Giảm thiểu: rào kiến trúc + PBT thuộc tính 5, và Yêu cầu 4.7 (hủy thao tác nếu không giữ được màu).
- **Font khi chèn/sửa text tiếng Việt:** thiếu glyph, subset font, hoặc encoding CID gây hiển thị sai/ô vuông. Giảm thiểu: Yêu cầu 8.3/8.4/9.3 và font dự phòng đủ glyph.
- **Hiệu năng trang nhiều object/vector:** liệt kê + ánh xạ O(N²) có thể timeout. Giảm thiểu: giới hạn/gộp (merge_rects), Yêu cầu 13.
- **Lệch tọa độ làm tròn:** sai số giữa PDFium bbox và content stream coordinates. Giảm thiểu: tolerance ≤ 1.0 point và `expand_bbox` đã có.
- **Đa content stream / thứ tự vẽ:** giả định thứ tự PDFium ↔ operator có thể không đúng với một số file; rủi ro ánh xạ sai. Giảm thiểu: kiểm chứng trên tập file thật + fallback an toàn (Yêu cầu 4.7).
