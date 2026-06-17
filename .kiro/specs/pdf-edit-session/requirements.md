# Requirements Document

> Tài liệu Yêu cầu — **Phiên chỉnh sửa PDF trong bộ nhớ** (`pdf-edit-session`): giữ một phiên chỉnh sửa sống trong RAM ở backend để áp thao tác in-memory, render tăng tiến theo vùng clip, và chỉ ghi ra đĩa khi cần — nhằm tối ưu hiệu năng cho tính năng `pdf-object-edit` hiện có.

## Introduction

Tính năng **Phiên chỉnh sửa PDF trong bộ nhớ** (tên nội bộ `pdf-edit-session`) là một tối ưu hiệu năng lớn cho tính năng `pdf-object-edit` đã có trong PrynX (ứng dụng Tauri desktop: React frontend + FastAPI backend Python ở cổng 8321 + trình render tile bằng Rust/PDFium).

**Vấn đề đo thực tế:** hiện nay mỗi thao tác chỉnh sửa nhỏ (di chuyển / xoay / resize / sửa text của một đối tượng) đều thực hiện một chu trình nặng:
1. Backend mở file theo `fid`, áp thao tác, và LƯU một Working_File MỚI ra đĩa.
2. Frontend đổi `pdfUrl` → trình render Rust MỞ LẠI file mới từ đĩa và render lại CẢ TRANG.
3. Frontend refetch `/edit/objects` cho trang.

Hệ quả: thao tác chậm (~5 giây với file 315MB toàn ảnh; file nhẹ cũng lag rõ), phần lớn do chi phí lưu-file + render-lại-cả-trang + round-trip mạng, KHÔNG mượt như Acrobat.

**Giải pháp đã chốt (phương án "C"):** Backend giữ một `pikepdf.Pdf` SỐNG theo phiên (Edit_Session), áp các thao tác (delete / move / resize / rotate / editText / add) IN-MEMORY trên document sống đó, render TĂNG TIẾN (ưu tiên render theo VÙNG CLIP quanh đối tượng bị ảnh hưởng) và trả PNG để frontend hiển thị TỨC THÌ — KHÔNG tạo Working_File mới mỗi thao tác, KHÔNG để Rust mở lại file mỗi thao tác, KHÔNG refetch `/edit/objects` mỗi thao tác. Việc ghi ra đĩa (Commit) chỉ xảy ra khi cần: tạo mốc undo/redo bền, lúc người dùng lưu, hoặc dồn lại (debounce) khi rảnh tay.

### Ràng buộc kiến trúc bắt buộc (kế thừa từ `pdf-object-edit`, đã chốt qua spike)

- **pikepdf = đường GHI DUY NHẤT (color-safe).** Mọi thay đổi nội dung (kể cả khi áp in-memory trong phiên) phải đi qua pikepdf. Màu in CMYK (`k`) / spot (`scn`) / overprint / ICC phải được bảo toàn tuyệt đối.
- **PDFium = engine ĐỌC / RENDER (read-only).** PDFium chỉ dùng để liệt kê hình học và render ảnh preview/tile; TUYỆT ĐỐI KHÔNG dùng `FPDFPage_GenerateContent` để ghi (hủy màu in).
- **KHÔNG ghi đè file gốc** người dùng tải lên.
- Đã có sẵn đường render-từ-bộ-nhớ: endpoint `/edit/preview` áp thao tác lên pikepdf in-memory rồi render bằng PDFium trả PNG — tính năng này mở rộng nguyên lý đó thành một phiên sống có trạng thái.

### Giới hạn đã biết (đưa vào yêu cầu để minh bạch)

- File CỰC LỚN (vd. 315MB toàn ảnh) vẫn bị giới hạn bởi chi phí render bản thân trang (~vài giây); phiên trong bộ nhớ KHÔNG xóa được giới hạn này — render theo vùng clip là cách GIẢM THIỂU, không phải loại bỏ.
- Phải đồng bộ đúng giữa "PNG preview hiển thị trong phiên" và "tile thật của Rust" sau khi Commit, để tránh nhảy hình.
- Quy đổi tọa độ (canvas top-left px@96 ↔ PDF point bottom-left, có CropBox lệch gốc) phải chính xác — đây là vùng từng gây regression.

### Mục tiêu hiệu năng

- Thao tác di chuyển / xoay / resize trên file thường (≤ ~20MB) phản hồi trong < ~300ms.
- KHÔNG reload cả trang / giao diện ở mỗi thao tác.

### Ngoài phạm vi (Out of scope)

- Thay đổi logic phẫu thuật content-stream của `Stream_Editor` (delete/move/resize/rotate/editText/add) — tái dùng nguyên trạng từ `pdf-object-edit`.
- Đa người dùng / phiên đồng thời nhiều file của cùng người dùng (Tauri 1 người dùng, thường 1 phiên); hỗ trợ tối thiểu nhiều phiên nhưng không tối ưu cho tải cao.
- Reflow đoạn text, chỉnh form fields/annotation (như `pdf-object-edit`).
- Ghi file qua PDFium `GenerateContent` (bị cấm vì hủy màu).

## Glossary

- **Edit_Session**: một phiên chỉnh sửa sống trong bộ nhớ backend, gồm một `pikepdf.Pdf` đang mở, op-log/snapshot cho undo/redo, và metadata vòng đời (session id, fid gốc, thời điểm truy cập gần nhất). Định danh bởi **Session_Id**.
- **Session_Id**: định danh duy nhất của một Edit_Session, do backend cấp khi mở phiên.
- **Live_Document**: đối tượng `pikepdf.Pdf` sống trong Edit_Session mà mọi thao tác in-memory áp lên; nằm hoàn toàn trong RAM, KHÔNG tự động vật chất hóa ra đĩa.
- **Edit_Op**: một thao tác chỉnh sửa thuộc tập {`delete`, `move`, `resize`, `rotate`, `editText`, `add`} kèm trang mục tiêu, tập object mục tiêu, và tham số (tái dùng schema `EditOp` của `pdf-object-edit`).
- **Apply_In_Memory**: hành động áp một Edit_Op lên Live_Document qua `Stream_Editor` (pikepdf) mà KHÔNG ghi file ra đĩa.
- **Incremental_Render**: hành động render ảnh preview chỉ cho phần trang bị ảnh hưởng (ưu tiên vùng clip quanh đối tượng bị tác động) thay vì render lại toàn trang khi có thể.
- **Clip_Region**: vùng chữ nhật [x0, y0, x1, y1] trên trang (theo point) bao đối tượng bị ảnh hưởng cùng lề an toàn, dùng cho Incremental_Render.
- **Preview_Image**: ảnh PNG do PDFium render (read-only) từ bytes mà pikepdf ghi in-memory, hiển thị trên Canvas_UI trong phiên.
- **Commit**: hành động ghi trạng thái hiện tại của Live_Document ra một Working_File MỚI trên đĩa (đường pikepdf color-safe), KHÔNG ghi đè file gốc.
- **Defer_Commit**: cơ chế hoãn và dồn (debounce) việc Commit cho tới khi cần (mốc undo bền, lúc lưu, hoặc khi rảnh tay) thay vì Commit ở mỗi Edit_Op.
- **Working_File**: file PDF kết quả ghi ra đĩa sau Commit (tái dùng quy ước `edit_output` của `pdf-object-edit`).
- **Op_Log**: danh sách có thứ tự các Edit_Op đã áp trong phiên, làm nền tảng cho Undo/Redo theo phiên.
- **Session_TTL**: thời gian sống tối đa của một Edit_Session kể từ lần truy cập gần nhất; quá hạn thì phiên bị dọn để chống rò RAM.
- **Tile_Renderer**: trình render tile bằng Rust/PDFium ở frontend, mở Working_File từ đĩa để render tile thật.
- **Canvas_UI**: khung xem trang ở frontend (LivePageFrame) hiển thị Preview_Image, overlay bbox và handle thao tác.
- **Stream_Editor**: thành phần backend dùng pikepdf để áp Edit_Op color-safe (tái dùng từ `pdf-object-edit`).
- **Geometry_Reader**: thành phần backend dùng PDFium (read-only) để liệt kê object/bbox (tái dùng từ `pdf-object-edit`).
- **Color_Operators**: tập operator màu (`k`/`K`, `scn`/`SCN`, `cs`/`CS`, `rg`/`RG`, `g`/`G`, overprint `OP`/`op`/`OPM`) (tái dùng định nghĩa từ `pdf-object-edit`).
- **Untouched_Object**: object KHÔNG nằm trong tập mục tiêu của Edit_Op hiện tại.
- **Legacy_Commit_Flow**: luồng cũ của `pdf-object-edit` — mỗi Edit_Op ghi một Working_File mới rồi frontend đổi `pdfUrl`; dùng làm đường dự phòng (fallback).
- **Page_Box**: hộp CropBox (fallback MediaBox) của trang theo PDF user-space, dùng để quy đổi tọa độ chính xác khi CropBox lệch gốc.

---

## Requirements

### Yêu cầu 1 — Mở và định danh phiên chỉnh sửa

**User Story:** Là một người dùng, tôi muốn vào chế độ chỉnh sửa và hệ thống mở sẵn một phiên làm việc trong bộ nhớ, để các thao tác sau đó phản hồi tức thì mà không phải mở lại file mỗi lần.

#### Acceptance Criteria

1. WHEN người dùng vào edit mode cho một file đã upload (`fid`) THE Edit_System SHALL mở một Edit_Session, nạp Live_Document từ file đó, và trả về một Session_Id duy nhất.
2. WHEN một Edit_Session được mở THE Edit_System SHALL nạp Live_Document qua pikepdf ở chế độ chỉ-đọc-từ-gốc và SHALL giữ Live_Document trong bộ nhớ backend gắn với Session_Id.
3. IF `fid` yêu cầu mở phiên không tồn tại hoặc file đã bị xóa khỏi đĩa THEN THE Edit_System SHALL trả về lỗi không tìm thấy file và SHALL NOT tạo Edit_Session.
4. WHEN một Edit_Session vừa mở THE Edit_System SHALL khởi tạo Op_Log rỗng và con trỏ Undo/Redo ở trạng thái không có thao tác nào.
5. WHERE đã tồn tại một Edit_Session đang mở cho cùng một `fid` THE Edit_System SHALL tái dùng phiên đó hoặc đóng phiên cũ trước khi mở phiên mới, sao cho mỗi `fid` tại một thời điểm gắn với tối đa một Edit_Session sống.

### Yêu cầu 2 — Áp thao tác chỉnh sửa in-memory (không ghi file mỗi op)

**User Story:** Là một người chế bản, tôi muốn mỗi thao tác sửa được áp ngay vào tài liệu sống trong bộ nhớ, để không phải chờ lưu file ra đĩa sau từng thao tác.

#### Acceptance Criteria

1. WHEN người dùng thực hiện một Edit_Op (`delete` / `move` / `resize` / `rotate` / `editText` / `add`) trong một Edit_Session THE Edit_System SHALL Apply_In_Memory thao tác đó lên Live_Document qua Stream_Editor (pikepdf) mà SHALL NOT ghi một Working_File mới ra đĩa cho thao tác đó.
2. WHEN một Edit_Op được Apply_In_Memory thành công THE Edit_System SHALL thêm thao tác đó vào Op_Log của phiên theo đúng thứ tự áp dụng.
3. WHEN một Edit_Op được Apply_In_Memory THE Edit_System SHALL cập nhật thời điểm truy cập gần nhất của Edit_Session.
4. IF Session_Id của một yêu cầu Apply_In_Memory không ứng với một Edit_Session đang sống THEN THE Edit_System SHALL trả về lỗi phiên-không-tồn-tại và SHALL NOT áp thao tác.
5. WHILE một Edit_Op đang được Apply_In_Memory cho một phiên THE Edit_System SHALL không cho một Edit_Op khác cùng phiên ghi đè trạng thái Live_Document đồng thời (tuần tự hóa thao tác trong cùng phiên).
6. FOR ALL Untouched_Object, WHEN một Edit_Op được Apply_In_Memory hoàn tất THE Stream_Editor SHALL giữ nguyên nội dung và Color_Operators của các Untouched_Object đó.

### Yêu cầu 3 — Render tăng tiến theo vùng clip

**User Story:** Là một người dùng, tôi muốn thấy kết quả thao tác hiện ra gần như tức thì quanh đối tượng vừa sửa, để cảm giác mượt như Acrobat thay vì chờ render lại cả trang.

#### Acceptance Criteria

1. WHEN một Edit_Op được Apply_In_Memory THE Edit_System SHALL render một Preview_Image bằng PDFium (read-only) từ bytes pikepdf ghi in-memory của Live_Document và trả về cho Canvas_UI.
2. WHERE một Edit_Op tác động một vùng giới hạn của trang THE Edit_System SHALL tính một Clip_Region bao các đối tượng bị ảnh hưởng kèm lề an toàn và SHALL ưu tiên Incremental_Render theo Clip_Region đó thay vì render lại toàn trang.
3. WHEN trả về Preview_Image của một Incremental_Render THE Edit_System SHALL kèm tọa độ Clip_Region (theo point của trang) để Canvas_UI dán đúng vùng cập nhật lên ảnh trang hiện có.
4. THE Edit_System SHALL render Preview_Image bằng PDFium ở chế độ chỉ-đọc và SHALL NOT dùng PDFium để ghi nội dung file.
5. WHEN Incremental_Render được áp dụng THE Preview_Image của vùng Clip_Region SHALL khớp về hình học với cùng vùng đó khi render toàn trang, với sai số ≤ 1.0 point mỗi cạnh.
6. IF một Edit_Op tác động vùng không xác định được giới hạn (vd. ảnh hưởng toàn trang) THEN THE Edit_System SHALL render lại toàn trang thay cho Incremental_Render.

### Yêu cầu 4 — Quy đổi tọa độ chính xác

**User Story:** Là một người chế bản, tôi muốn đối tượng hiển thị và cập nhật đúng vị trí kể cả khi trang có CropBox lệch gốc, để không tái diễn lỗi lệch tọa độ từng gặp.

#### Acceptance Criteria

1. WHEN tính Clip_Region từ vùng đối tượng trên Canvas_UI THE Edit_System SHALL quy đổi giữa hệ canvas (top-left, px@96) và hệ PDF (bottom-left, point) có trừ gốc Page_Box, với sai số ≤ 1.0 point mỗi cạnh.
2. WHERE trang có CropBox lệch gốc MediaBox THE Edit_System SHALL dùng Page_Box (CropBox, fallback MediaBox) làm gốc quy đổi tọa độ cho cả Clip_Region lẫn vị trí dán Preview_Image.
3. WHEN Preview_Image của một Clip_Region được dán lên ảnh trang hiện có trên Canvas_UI THE vị trí dán SHALL khớp với vị trí hình học của Clip_Region trong tolerance ≤ 1.0 point mỗi cạnh.

### Yêu cầu 5 — Hoãn và dồn việc ghi ra đĩa (Defer_Commit)

**User Story:** Là một người dùng, tôi muốn hệ thống chỉ ghi file ra đĩa khi thật sự cần, để chuỗi thao tác liên tiếp không bị chậm vì lưu file lặp lại.

#### Acceptance Criteria

1. WHEN nhiều Edit_Op liên tiếp được Apply_In_Memory trong một phiên THE Edit_System SHALL Defer_Commit và SHALL NOT ghi một Working_File mới cho từng Edit_Op.
2. WHEN người dùng yêu cầu lưu file THE Edit_System SHALL Commit Live_Document ra một Working_File mới và trả về tham chiếu Working_File đó.
3. WHILE phiên ở trạng thái rảnh thao tác quá ngưỡng debounce cấu hình THE Edit_System SHALL Commit Live_Document ra một Working_File mới để làm điểm bền cho trạng thái hiện tại.
4. WHEN một mốc Undo/Redo bền cần được tạo (theo Yêu cầu 7) THE Edit_System SHALL Commit Live_Document tại mốc đó.
5. WHEN Commit hoàn tất THE Edit_System SHALL ghi ra một Working_File MỚI và SHALL NOT ghi đè file gốc do người dùng tải lên.
6. WHERE nhiều yêu cầu Commit dồn lại trong khoảng debounce THE Edit_System SHALL gộp thành một lần ghi đĩa phản ánh trạng thái mới nhất của Live_Document.

### Yêu cầu 6 — Bảo toàn màu in trong suốt vòng đời phiên (CORRECTNESS PROPERTY HÀNG ĐẦU)

**User Story:** Là một người chế bản in ấn, tôi muốn mọi thao tác in-memory và mọi lần Commit đều giữ nguyên màu CMYK / spot / overprint / ICC, để bản in không bao giờ sai màu vì tối ưu hiệu năng.

#### Acceptance Criteria

1. WHEN một Edit_Op được Apply_In_Memory THE Edit_System SHALL áp thay đổi qua pikepdf (`parse_content_stream` + `unparse_content_stream`) và SHALL NOT dùng PDFium `FPDFPage_GenerateContent` để thay đổi nội dung.
2. WHEN Live_Document được Commit ra Working_File THE Edit_System SHALL ghi qua đường pikepdf color-safe và SHALL giữ nguyên các Color_Operators của mọi object so với trạng thái in-memory tương ứng.
3. WHEN một object dùng màu CMYK (`k`) hoặc spot (`scn`) tồn tại trong Live_Document đi qua chu trình Apply_In_Memory rồi Commit THE Edit_System SHALL giữ nguyên operator màu cùng giá trị thành phần và định nghĩa colorspace của object đó.
4. WHERE một object tham chiếu ICC profile (`/ICCBased`) hoặc có thiết lập overprint (`OP`/`op`/`OPM`) THE Edit_System SHALL giữ nguyên tham chiếu ICC và thiết lập overprint đó sau Apply_In_Memory và sau Commit.
5. IF một Edit_Op không thể Apply_In_Memory mà không làm thay đổi Color_Operators của Untouched_Object THEN THE Edit_System SHALL hủy thao tác đó, giữ nguyên Live_Document, và báo lỗi rõ ràng thay vì áp kết quả sai màu.

### Yêu cầu 7 — Undo / Redo theo phiên (op-log / snapshot)

**User Story:** Là một người dùng, tôi muốn hoàn tác và làm lại các thao tác trong phiên một cách nhanh chóng, để khôi phục khi thao tác nhầm mà không phụ thuộc vào việc ghi file mỗi op.

#### Acceptance Criteria

1. WHEN người dùng thực hiện một Edit_Op trong phiên THE Edit_System SHALL ghi nhận thao tác đó vào Op_Log của phiên để phục vụ Undo/Redo, thay cho cơ chế snapshot-file mỗi op của Legacy_Commit_Flow.
2. WHEN người dùng yêu cầu Undo THE Edit_System SHALL khôi phục Live_Document về trạng thái ngay trước Edit_Op gần nhất chưa bị hoàn tác.
3. WHEN người dùng yêu cầu Redo sau một Undo THE Edit_System SHALL áp lại đúng Edit_Op vừa bị hoàn tác và đưa Live_Document về trạng thái tương ứng.
4. WHEN người dùng thực hiện một Edit_Op mới sau khi đã Undo một số thao tác THE Edit_System SHALL loại bỏ các thao tác đã bị hoàn tác khỏi nhánh Redo và nối Edit_Op mới vào Op_Log.
5. WHEN người dùng thực hiện Undo rồi Redo trên cùng một Edit_Op THE trạng thái Live_Document kết quả SHALL tương đương trạng thái sau Edit_Op ban đầu, với Color_Operators và BBox của object liên quan được giữ trong tolerance ≤ 1.0 point mỗi cạnh.
6. IF người dùng yêu cầu Undo khi Op_Log không còn thao tác nào để hoàn tác THEN THE Edit_System SHALL giữ nguyên Live_Document và báo trạng thái không-có-gì-để-hoàn-tác.

### Yêu cầu 8 — Đồng bộ Preview_Image với tile thật sau Commit

**User Story:** Là một người dùng, tôi muốn sau khi lưu, ảnh trên màn hình không bị nhảy hình, để những gì tôi thấy trong phiên khớp với tile thật mà trình render Rust dựng từ file đã lưu.

#### Acceptance Criteria

1. WHEN một Commit hoàn tất và Tile_Renderer mở Working_File mới để render tile THE tile thật SHALL khớp về hình học với Preview_Image đã hiển thị trong phiên cho cùng trang, với sai số ≤ 1.0 point mỗi cạnh.
2. WHEN Canvas_UI chuyển từ Preview_Image của phiên sang tile thật sau Commit THE Edit_System SHALL chuyển đổi sao cho không có sai khác vị trí/kích thước/hướng nhìn thấy được của đối tượng đã sửa giữa hai nguồn ảnh.
3. THE Edit_System SHALL bảo đảm Preview_Image trong phiên và tile thật sau Commit đều bắt nguồn từ cùng một trạng thái Live_Document (cùng tập Edit_Op đã áp).

### Yêu cầu 9 — Vòng đời, đóng phiên và dọn RAM theo TTL

**User Story:** Là một người dùng máy desktop, tôi muốn bộ nhớ được giải phóng khi tôi thoát chỉnh sửa hoặc để phiên quá lâu, để ứng dụng không bị phình RAM khi làm việc với file lớn.

#### Acceptance Criteria

1. WHEN người dùng thoát edit mode THE Edit_System SHALL đóng Edit_Session tương ứng và giải phóng Live_Document cùng tài nguyên phiên khỏi bộ nhớ.
2. WHILE một Edit_Session không có thao tác nào quá thời gian Session_TTL kể từ lần truy cập gần nhất THE Edit_System SHALL dọn phiên đó và giải phóng bộ nhớ liên quan.
3. WHEN một Edit_Session bị đóng hoặc dọn THE Edit_System SHALL giải phóng Live_Document khỏi bộ nhớ và SHALL giữ nguyên file gốc cùng mọi Working_File đã Commit.
4. THE Edit_System SHALL chạy cơ chế dọn phiên định kỳ để các Edit_Session quá hạn được giải phóng mà không cần người dùng thao tác thủ công.
5. IF một yêu cầu thao tác trỏ tới một Session_Id đã bị đóng hoặc dọn THEN THE Edit_System SHALL trả về lỗi phiên-không-tồn-tại để frontend khởi tạo lại phiên hoặc chuyển sang Legacy_Commit_Flow.

### Yêu cầu 10 — Xử lý lỗi và timeout an toàn

**User Story:** Là một người dùng làm việc với file rất lớn, tôi muốn thao tác quá nặng được báo lỗi rõ ràng thay vì treo, để không mất dữ liệu hay phải tắt ứng dụng.

#### Acceptance Criteria

1. IF một Apply_In_Memory hoặc một lần render Preview_Image vượt thời gian xử lý an toàn cấu hình THEN THE Edit_System SHALL hủy thao tác đó, giữ nguyên trạng thái Live_Document trước thao tác, và trả về lỗi timeout rõ ràng.
2. IF một Edit_Op áp vào phiên thất bại (vd. không map được object duy nhất, thiếu glyph, tham số sai) THEN THE Edit_System SHALL giữ nguyên Live_Document ở trạng thái trước thao tác và trả về lỗi mô tả nguyên nhân.
3. WHEN một thao tác trong phiên thất bại hoặc timeout THE Edit_System SHALL giữ Op_Log nhất quán với trạng thái thực tế của Live_Document (không ghi nhận thao tác đã bị hủy như đã áp).
4. WHILE xử lý file CỰC LỚN (vd. ~315MB toàn ảnh) THE Edit_System SHALL chấp nhận rằng chi phí render bản thân trang vẫn ở mức vài giây và SHALL dùng Incremental_Render theo Clip_Region để giảm thiểu thời gian phản hồi mỗi thao tác.
5. IF một Commit ra đĩa thất bại THEN THE Edit_System SHALL giữ nguyên Live_Document trong bộ nhớ và báo lỗi, để người dùng thử lưu lại mà không mất trạng thái phiên.

### Yêu cầu 11 — Tương thích ngược và fallback về luồng commit-file cũ

**User Story:** Là một người dùng, tôi muốn vẫn chỉnh sửa được kể cả khi phiên trong bộ nhớ gặp sự cố, để tính năng mới không làm hỏng khả năng đang dùng tốt.

#### Acceptance Criteria

1. IF không mở được Edit_Session hoặc một thao tác trong phiên trả lỗi phiên-không-tồn-tại THEN THE Edit_System SHALL cho phép frontend chuyển sang Legacy_Commit_Flow (mỗi Edit_Op ghi một Working_File mới rồi đổi `pdfUrl`) để hoàn tất thao tác.
2. WHEN Edit_System ở chế độ Legacy_Commit_Flow THE kết quả của một Edit_Op SHALL tương đương về nội dung và Color_Operators với kết quả của cùng Edit_Op khi áp qua Edit_Session, trong tolerance ≤ 1.0 point mỗi cạnh cho hình học.
3. THE Edit_System SHALL giữ các endpoint hiện có của `pdf-object-edit` (`/edit/objects`, `/edit/delete`, `/edit/transform`, `/edit/text`, `/edit/add`, `/edit/preview`) hoạt động như cũ để Legacy_Commit_Flow tiếp tục dùng được.
4. WHEN một file đã được chỉnh sửa qua Edit_Session và Commit ra Working_File THE Working_File đó SHALL dùng được với các tính năng khác của PrynX y như Working_File do Legacy_Commit_Flow tạo (cùng quy ước thư mục `edit_output` và đăng ký `fid`).

### Yêu cầu 12 — Hiệu năng phản hồi thao tác

**User Story:** Là một người dùng, tôi muốn thao tác di chuyển/xoay/resize trên file kích thước thường phản hồi gần như tức thì, để trải nghiệm chỉnh sửa mượt mà.

#### Acceptance Criteria

1. WHEN người dùng thực hiện một Edit_Op `move` / `resize` / `rotate` trên một file kích thước ≤ ~20MB THE Edit_System SHALL trả Preview_Image phản hồi trong < ~300ms ở điều kiện vận hành thông thường.
2. WHEN một Edit_Op được Apply_In_Memory THE Canvas_UI SHALL cập nhật hiển thị mà không reload toàn bộ trang hay toàn bộ giao diện, và SHALL NOT refetch `/edit/objects` cho mỗi thao tác.
3. WHILE người dùng đang kéo move/resize/rotate THE Canvas_UI SHALL hiển thị transform tạm theo thời gian thực bằng overlay mà SHALL NOT gọi Apply_In_Memory ở mỗi khung hình.
4. WHEN một chuỗi Edit_Op liên tiếp được thực hiện THE Edit_System SHALL không yêu cầu Tile_Renderer mở lại Working_File từ đĩa ở mỗi thao tác.

---

## Correctness Properties cho Property-Based Testing (PBT)

Các thuộc tính sau là mục tiêu PBT trọng yếu, kiểm trên **logic phiên của ta** (quản lý Edit_Session, Apply_In_Memory, Op_Log/Undo/Redo, Commit) với PDF in-memory sinh ngẫu nhiên có CMYK/spot/overprint/ICC — chi phí thấp, hợp PBT 100+ iteration:

1. **Tương đương in-memory ↔ commit (Round-trip / Model-based).** Với mọi chuỗi Edit_Op áp in-memory rồi Commit, Working_File kết quả tương đương về nội dung và Color_Operators với việc áp cùng chuỗi Edit_Op qua Legacy_Commit_Flow tuần tự. (Yêu cầu 2.1, 6.2, 11.2)
2. **Bảo toàn màu Untouched_Object qua phiên (Invariant).** Với mọi Edit_Op Apply_In_Memory, tập Color_Operators của các Untouched_Object trước và sau (cả in-memory lẫn sau Commit) là bằng nhau. (Yêu cầu 6.2, 2.6)
3. **Round-trip màu CMYK/spot qua Apply+Commit (Round-trip).** Object dùng `k`/`scn` sau chu trình Apply_In_Memory → Commit giữ nguyên operator, giá trị màu và định nghĩa colorspace. (Yêu cầu 6.3)
4. **Undo/Redo idempotent theo cặp (Round-trip).** Với mọi Edit_Op, Undo rồi Redo cho trạng thái Live_Document tương đương trạng thái sau Edit_Op ban đầu (Color_Operators + BBox giữ nguyên trong tolerance). (Yêu cầu 7.5)
5. **Op_Log nhất quán khi lỗi/timeout (Invariant).** Với mọi Edit_Op bị hủy do lỗi hoặc timeout, Op_Log và trạng thái Live_Document khớp nhau (thao tác bị hủy không xuất hiện như đã áp), và một thao tác hợp lệ kế tiếp vẫn cho kết quả đúng. (Yêu cầu 10.1, 10.2, 10.3)
6. **Tương đương vùng Incremental_Render với toàn trang (Metamorphic).** Với mọi Edit_Op tác động vùng giới hạn, Preview_Image của Clip_Region khớp về hình học với cùng vùng trong ảnh render toàn trang trong tolerance ≤ 1.0 point. (Yêu cầu 3.5)

> Lưu ý phạm vi PBT: các thuộc tính trên kiểm logic engine phiên trên PDF in-memory (chi phí thấp). Việc "PDFium render đúng pixel" và "Tile_Renderer Rust mở file đúng" thuộc nhóm hành vi thư viện/tiến trình ngoài → kiểm bằng integration test với 1–3 ví dụ đại diện, KHÔNG PBT. Mục tiêu hiệu năng (< ~300ms) kiểm bằng benchmark/đo thực tế, KHÔNG PBT.

---

## Assumptions

- pikepdf cho phép giữ một `Pdf` mở lâu trong bộ nhớ và `save(BytesIO)` nhiều lần mà không hỏng trạng thái document; `compress_streams=False` (đã dùng ở `edit_io`/`/edit/preview`) áp dụng được cho cả đường phiên để giữ tốc độ trên file ảnh nặng.
- PDFium (pypdfium2) render được từ bytes in-memory và hỗ trợ render theo vùng/clip đủ để Incremental_Render (hoặc có thể crop ảnh toàn trang theo Clip_Region nếu render-theo-vùng không khả dụng).
- Backend FastAPI (cổng 8321) chạy một tiến trình cho ứng dụng Tauri một người dùng; lưu trữ Edit_Session trong bộ nhớ tiến trình là chấp nhận được (thường 1 phiên tại một thời điểm).
- Stream_Editor / Geometry_Reader / schema `EditOp` của `pdf-object-edit` tái dùng được nguyên trạng để Apply_In_Memory.
- Quy đổi tọa độ canvas↔PDF và Page_Box (CropBox/MediaBox) dùng lại đúng cơ chế đã có (`/edit/objects` trả `pageBox`).
- Cơ chế đăng ký Working_File và thư mục `edit_output` của `pdf-object-edit` tái dùng được cho Commit của phiên.
- Frontend có thể phát hiện lỗi phiên-không-tồn-tại để chuyển sang Legacy_Commit_Flow mà không mất thao tác hiện tại.

## Risks

- **Rò RAM do phiên không được dọn:** Live_Document của file lớn (vài trăm MB) tồn lâu trong RAM. Giảm thiểu: Session_TTL + dọn định kỳ + đóng phiên khi thoát edit mode (Yêu cầu 9); giới hạn tối đa một phiên sống mỗi `fid` (Yêu cầu 1.5).
- **Lệch giữa Preview_Image và tile thật sau Commit:** nguồn ảnh khác nhau (PDFium in-memory vs Tile_Renderer Rust từ đĩa) có thể gây nhảy hình. Giảm thiểu: cùng bắt nguồn từ một trạng thái Live_Document + tolerance hình học (Yêu cầu 8).
- **Sai vùng Incremental_Render / lệch tọa độ CropBox:** Clip_Region tính sai làm cập nhật lệch hoặc sót vùng. Giảm thiểu: quy đổi qua Page_Box + tolerance ≤ 1.0pt + fallback render toàn trang khi vùng không xác định (Yêu cầu 3.6, 4); PBT thuộc tính 6.
- **Mất màu nếu lỡ ghi qua PDFium:** mọi đường thay đổi nội dung phải qua pikepdf. Giảm thiểu: rào kiến trúc "pikepdf-only write" + PBT thuộc tính 2,3 + Yêu cầu 6.
- **Op_Log lệch trạng thái khi lỗi/timeout:** thao tác bị hủy nhưng vẫn ghi vào log gây Undo/Redo sai. Giảm thiểu: chỉ ghi Op_Log khi Apply_In_Memory thành công (Yêu cầu 2.2, 10.3); PBT thuộc tính 5.
- **File cực lớn vẫn chậm:** phiên trong bộ nhớ không xóa được chi phí render bản thân trang. Giảm thiểu: minh bạch giới hạn (Yêu cầu 10.4) + Incremental_Render theo Clip_Region.
- **Tải đồng thời nhiều thao tác trong một phiên:** race trên Live_Document. Giảm thiểu: tuần tự hóa thao tác trong cùng phiên (Yêu cầu 2.5).
