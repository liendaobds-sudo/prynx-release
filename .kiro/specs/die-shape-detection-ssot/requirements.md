# Requirements Document

## Introduction

Tài liệu này đặc tả yêu cầu cho việc tái cấu trúc cơ chế **nhận diện hình học đường khuôn bế (die-cut shape detection)** dùng chung cho hai tính năng imposition: **Bình Tem Bế** (Sticker Die-cut) và **Bình Bế Rớt CNC** (CNC routed die-cut — hỗ trợ 2 mặt + trang Khuôn).

### Bối cảnh và vấn đề (đã audit, có dẫn chứng file)

Hiện tại việc nhận diện hình bị **không ổn định**: cùng một kiểu file PDF (đều có đường khuôn bằng spot color) nhưng lúc nhận đúng hình, lúc trả về "Đặc biệt" (CUSTOM); preview đôi khi khác kết quả in thật; CNC khi ghép nhiều mẫu (gang) xếp tem như hình chữ nhật gây tốn giấy. Nguyên nhân gốc đã được trace:

- **RC-1 — Không có nguồn sự thật duy nhất:** Shape bị phân loại tới 3 lần ở 3 nơi độc lập: route `/detect-shape` (`imposition.py`), `compute_sticker_layout_for_page` (`layout_compute.py` gọi `classify_shape` lại), và `get_optimal_head_to_tail_overlap` (`nup_diecut.py` lại classify lần nữa).
- **RC-2 — Heuristic chọn đường khuôn giòn:** Logic "ưu tiên path stroke-only + lấy path diện tích lớn nhất" hỏng khi đường khuôn là vùng tô (fill) thay vì nét (stroke), nằm trong Form XObject, bị chia thành nhiều subpath, hoặc spot color đặt tên lạ / là kênh CMYK thay vì Separation thật. Fallback spot color loại plate theo TÊN cứng ("Cyan/Magenta/Yellow/Black") và phụ thuộc Ghostscript.
- **RC-3 — Lỗi 1 trang làm hỏng cả file:** Route bắt mọi exception top-level và trả `{shapes:["CUSTOM"], success:False}`; frontend khi `success=false` không cập nhật gì → toàn bộ file thành "Đặc biệt". `max_pages=30` khiến file >30 trang các trang sau không có shape.
- **RC-4 — Preview lệch output:** `layout_compute.py` cố tình BỎ `shape_props_override` và tự tái trích props từ path do backend tự chọn (comment thừa nhận "divergent between preview and nup_engine").
- **RC-5 — CNC gang mất shape:** `build_cnc_front_layout` (`cnc_layout.py`) chỉ nhận `(page_idx, trim_w, trim_h, qty)` — bỏ hoàn toàn `shape_type`, bin-pack chữ nhật. CNC S&R 1 mẫu thì lại gọi `compute_sticker_layout_for_page` (có shape) → CNC gang khác Tem Bế.
- **RC-6 — Trùng lặp enum và chưa Rust hoá classifier:** Có 2 enum `ShapeType` trùng (`shape_classifier.py` vs `shape_analyzer.py`) với tập giá trị khác nhau. Phần solver hình học đã được Rust tăng tốc nhưng phần CLASSIFICATION vẫn 100% Python.

### Giải pháp đích: "Detect once, flow everywhere"

Nguyên lý: `shape_type` + `shape_props` + `polygon` được tính **đúng một lần** ở lớp Detection, đóng gói thành một contract chuẩn hoá (`DetectedShape`), và **chảy bất biến** xuống mọi nhánh layout. Không nơi nào dưới lớp Detection được phân loại lại. CNC chỉ thêm hành vi ở lớp Render (2 mặt + trang Khuôn), không đụng tới `shape_type`.

Kiến trúc 3 lớp:
- **Lớp 1 — Detection (SSOT):** một hàm `detect_die_shapes()` gom mọi heuristic chọn-path về một chỗ.
- **Lớp 2 — Solve/Nesting (dùng chung):** `compute_layout(DetectedShape, ...)` cho Tem Bế, N-up die-cut, và CNC gang; không re-classify.
- **Lớp 3 — Render (riêng CNC):** 2 mặt, trang Khuôn, boong/duplex marks.

### Hiệu quả mong đợi

- Nhận diện ổn định: cùng loại file → cùng kết quả, hết cảnh "lúc đúng lúc Đặc biệt".
- Một trang lỗi không làm hỏng cả file.
- Preview giống hệt kết quả in (parity).
- CNC gang xếp đúng hình thật → khít hơn, tiết kiệm giấy.
- Một nguồn sự thật → sửa một chỗ, ít tái phát; Tem Bế và CNC nhất quán nhưng CNC vẫn giữ 2 mặt + Khuôn.

### Phạm vi (Scope)

Trong phạm vi: lớp Detection SSOT, contract `DetectedShape`, propagate bất biến xuống layout, per-page error isolation, bỏ giới hạn 30 trang, parity preview==output, CNC gang dùng shape thật, gộp 2 enum `ShapeType`, hướng Rust classifier với fallback Python, parity tests.

Ngoài phạm vi: thay đổi thuật toán nesting/NFP đã có, thay đổi UI ngoài việc tiêu thụ contract mới, thay đổi cơ chế cấp phép (license), in offset hoặc các tính năng imposition khác không phải die-cut.

## Glossary

- **Hệ_Thống (System):** Toàn bộ pipeline imposition die-cut của PDFCompare, gồm backend (FastAPI + worker) và desktop frontend.
- **Bộ_Nhận_Diện (Detection_Layer):** Lớp 1 — thành phần thực hiện hàm `detect_die_shapes()`, nguồn sự thật duy nhất cho hình học đường khuôn.
- **DetectedShape:** Contract chuẩn hoá đại diện cho hình một trang, gồm các trường: `page` (số thứ tự trang, 0-based), `type` (giá trị enum `ShapeType` thống nhất), `props` (tham số hình học đã chuẩn hoá về đơn vị TRIM), `trim` (`{w, h}` kích thước thành phẩm theo points), `poly` (đa giác đường khuôn dạng toạ độ chuẩn hoá về trim), `source` (nguồn nhận diện: `vector` | `xobject` | `separation` | `raster_fallback` | `custom`), `confidence` (độ tin cậy 0.0–1.0).
- **Lớp_Layout (Layout_Layer):** Lớp 2 — thành phần tính bố cục nesting dùng chung cho Tem Bế, N-up die-cut và CNC gang, tiêu thụ `DetectedShape`.
- **Lớp_Render_CNC (CNC_Render_Layer):** Lớp 3 — thành phần render riêng cho CNC (2 mặt, trang Khuôn, dấu canh).
- **ShapeType:** Enum thống nhất phân loại hình: `CIRCLE_ELLIPSE`, `TRIANGLE`, `RECTANGLE`, `PENTAGON`, `HEXAGON`, `DUMBBELL`, `HAMMER`, `TRAPEZOID`, `PARALLELOGRAM`, `ARROW`, `CUSTOM`.
- **Đường_Khuôn (Die_Line / Cutline):** Đường nét hoặc vùng tô đại diện cho đường cắt/bế của tem, thường vẽ bằng spot color (Separation/DeviceN) với tên như CutContour, Dieline, Thru-cut, Kiss, Crease.
- **Spot_Color:** Màu pha xác định qua color space `Separation` hoặc `DeviceN` trong PDF.
- **Form_XObject:** Đối tượng PDF chứa nội dung vector lồng (nested), có thể chứa đường khuôn không nằm trực tiếp ở content stream của trang.
- **Subpath:** Một đoạn liên tục trong path PDF; một đường khuôn có thể bị chia thành nhiều subpath rời.
- **TRIM:** Đơn vị/khung kích thước thành phẩm (không gồm bleed); mọi `props` hình học trong contract phải chuẩn hoá về đơn vị này.
- **Parity:** Tính chất preview và output in ra cho kết quả layout đồng nhất (cùng đầu vào → cùng đầu ra).
- **Bộ_Giải_Rust (Rust_Solver):** Module `pdfcompare_native` (imposition_core, Rust) tăng tốc toán hình học.
- **Fallback_Python:** Đường dẫn thực thi bằng Python khi Rust không khả dụng, được kiểm soát bởi `IMPOSITION_ALLOW_PY_FALLBACK`.
- **CNC_Gang:** Chế độ CNC ghép nhiều mẫu khác nhau lên cùng một tờ.
- **S&R (Step_and_Repeat):** Chế độ lặp một mẫu lấp đầy tờ.

## Requirements

### Requirement 1: Hợp đồng dữ liệu DetectedShape (nguồn sự thật duy nhất)

**User Story:** Là kỹ sư bảo trì hệ thống, tôi muốn mọi thông tin hình học của một trang được đóng gói trong một contract chuẩn hoá duy nhất, để mọi lớp phía dưới dùng chung mà không tự suy diễn lại.

#### Acceptance Criteria

1. WHEN một trang được xử lý xong, THE Bộ_Nhận_Diện SHALL tạo đúng một đối tượng DetectedShape chứa đầy đủ bảy trường `page`, `type`, `props`, `trim`, `poly`, `source`, và `confidence`, không trường nào để trống (null).
2. THE Bộ_Nhận_Diện SHALL chuẩn hoá mọi giá trị trong `props` về đơn vị TRIM (points, gốc toạ độ tại góc vùng thành phẩm) và làm tròn tới 3 chữ số thập phân trước khi đưa vào DetectedShape.
3. THE Bộ_Nhận_Diện SHALL gán `type` bằng đúng một giá trị thuộc enum ShapeType thống nhất.
4. IF một trang không thể phân loại thành hình xác định, THEN THE Bộ_Nhận_Diện SHALL gán `type` bằng `CUSTOM`, gán `source` bằng `custom`, và vẫn tạo đầy đủ đối tượng DetectedShape.
5. THE Bộ_Nhận_Diện SHALL gán `confidence` là số thực trong khoảng đóng [0.0, 1.0].
6. WHEN một DetectedShape được tạo, THE Bộ_Nhận_Diện SHALL gán `trim` với `w` và `h` là số thực lớn hơn 0.0 và không vượt quá 14400.0 points.
7. IF việc chuẩn hoá `props` hoặc tính `trim` của một trang thất bại, THEN THE Bộ_Nhận_Diện SHALL từ chối tạo DetectedShape cho trang đó, trả về chỉ báo lỗi nêu rõ trường gây lỗi, và SHALL không tạo đối tượng DetectedShape một phần.

### Requirement 2: Nhận diện một lần duy nhất ở lớp Detection

**User Story:** Là kỹ sư bảo trì, tôi muốn việc phân loại hình chỉ xảy ra một lần ở lớp Detection, để loại bỏ ba điểm phân loại trùng lặp gây kết quả mâu thuẫn.

#### Acceptance Criteria

1. THE Bộ_Nhận_Diện SHALL là thành phần duy nhất được phép phân loại hình và tính `props` đường khuôn trong toàn pipeline.
2. WHEN Lớp_Layout nhận một DetectedShape, THE Lớp_Layout SHALL sử dụng `type` và `props` từ DetectedShape mà không gọi bất kỳ hàm phân loại hình nào.
3. WHEN Lớp_Render_CNC dựng bố cục, THE Lớp_Render_CNC SHALL sử dụng `type` và `props` từ DetectedShape mà không gọi bất kỳ hàm phân loại hình nào.
4. WHILE một DetectedShape hợp lệ đang được xử lý dưới lớp Detection, THE Hệ_Thống SHALL giữ số lần gọi `classify_shape` và `detect_shape` ngoài Bộ_Nhận_Diện bằng 0.
5. WHEN tính tham số lồng ghép NFP, THE Lớp_Layout SHALL chỉ lấy đa giác cơ sở (`base_poly`) từ DetectedShape.
6. WHEN bước tính NFP hoàn tất, THE Lớp_Layout SHALL giữ `type` không đổi so với `type` trước khi tính NFP (so sánh bằng theo giá trị).
7. IF một DetectedShape đến lớp dưới Detection mà thiếu hoặc rỗng `type` hoặc `props`, THEN THE Hệ_Thống SHALL từ chối xử lý trang đó, trả về lỗi nêu rõ trường thiếu, không thực hiện phân loại thay thế, và giữ nguyên đầu vào.

### Requirement 3: Nhận diện đường khuôn bền vững (robust path selection)

**User Story:** Là người vận hành in ấn, tôi muốn hệ thống nhận đúng đường khuôn trên nhiều cách dựng file khác nhau, để cùng một kiểu file luôn ra cùng kết quả thay vì lúc đúng lúc "Đặc biệt".

#### Acceptance Criteria

1. THE Bộ_Nhận_Diện SHALL gom toàn bộ heuristic chọn đường khuôn vào một hàm `detect_die_shapes()` duy nhất, sao cho không còn nhánh nhận diện đường khuôn nào nằm ngoài hàm này.
2. WHERE đường khuôn được dựng bằng vùng tô (fill) thay vì nét (stroke), THE Bộ_Nhận_Diện SHALL nhận diện đường khuôn từ biên (contour) của vùng tô đó với cùng kết quả phân loại như khi đường khuôn được dựng bằng nét.
3. WHERE đường khuôn nằm trong Form_XObject, THE Bộ_Nhận_Diện SHALL đệ quy vào Form_XObject để trích xuất đường khuôn, với độ sâu lồng nhau tối đa lấy từ cấu hình (mặc định 10 cấp).
4. IF độ sâu lồng Form_XObject vượt quá giới hạn cấu hình, THEN THE Bộ_Nhận_Diện SHALL dừng đệ quy tại cấp giới hạn, giữ nguyên các đường khuôn đã trích xuất, và ghi nhận một cảnh báo cho biết đã đạt giới hạn độ sâu.
5. WHERE một đường khuôn bị chia thành nhiều Subpath có tên kênh Spot_Color trùng nhau (so khớp không phân biệt hoa thường, khớp toàn bộ tên kênh), THE Bộ_Nhận_Diện SHALL hợp nhất (union) các Subpath đó thành một đa giác trước khi phân loại.
6. WHERE đường khuôn được vẽ bằng Spot_Color qua color space Separation hoặc DeviceN, THE Bộ_Nhận_Diện SHALL nhận diện đường khuôn theo tên kênh màu.
7. THE Bộ_Nhận_Diện SHALL đọc danh sách tên kênh màu khuôn từ cấu hình, với tập mặc định gồm CutContour, Dieline, Thru-cut, Kiss, và Crease, và SHALL so khớp tên kênh không phân biệt hoa thường, khớp toàn bộ tên kênh (không khớp một phần chuỗi con).
8. IF không tìm được đường khuôn theo Spot_Color hay vector, THEN THE Bộ_Nhận_Diện SHALL áp dụng đường dẫn fallback dựa trên mask raster và gán `source` bằng `raster_fallback`.
9. THE Bộ_Nhận_Diện SHALL nhận diện kênh màu khuôn không phụ thuộc vào việc tên kênh trùng với "Cyan", "Magenta", "Yellow", hay "Black".
10. WHEN cùng một file đầu vào được xử lý nhiều lần với cùng một cấu hình, THE Bộ_Nhận_Diện SHALL trả về tập đường khuôn và giá trị `source` giống hệt nhau ở mọi lần chạy.

### Requirement 4: Cô lập lỗi theo từng trang (per-page error isolation)

**User Story:** Là người vận hành, tôi muốn một trang lỗi không làm hỏng nhận diện của cả file, để không phải làm lại toàn bộ vì một trang hỏng.

#### Acceptance Criteria

1. WHEN nhận diện hình cho một file nhiều trang, THE Bộ_Nhận_Diện SHALL xử lý mỗi trang trong một phạm vi cô lập lỗi riêng sao cho lỗi phát sinh khi xử lý một trang không làm dừng việc xử lý các trang còn lại và không làm thay đổi kết quả của bất kỳ trang nào khác.
2. IF việc nhận diện một trang phát sinh lỗi, THEN THE Bộ_Nhận_Diện SHALL gán trang đó là `CUSTOM` với `source` bằng `custom` và SHALL tiếp tục xử lý các trang còn lại.
3. IF việc nhận diện một trang phát sinh lỗi, THEN THE Bộ_Nhận_Diện SHALL giữ nguyên (không thay đổi và không loại bỏ) kết quả của các trang đã được xử lý thành công trước đó.
4. WHEN hoàn tất xử lý một file có một hoặc nhiều trang lỗi, THE Bộ_Nhận_Diện SHALL trả về kết quả nhận diện thành công cho tất cả các trang không lỗi và trạng thái `CUSTOM` với `source` bằng `custom` cho mỗi trang lỗi.
5. IF một trang gặp lỗi, THEN THE Bộ_Nhận_Diện SHALL ghi một mục log lỗi kèm số thứ tự trang (giá trị nguyên từ 1 đến tổng số trang của file) và thông tin chỉ báo nguyên nhân lỗi.
6. WHEN trả kết quả nhận diện về frontend, THE Hệ_Thống SHALL bao gồm trạng thái nhận diện của từng trang (gồm giá trị nhận diện và `source`) để frontend cập nhật hiển thị được cả khi một số trang ở trạng thái `CUSTOM`.
7. IF tất cả các trang của file đều gặp lỗi nhận diện, THEN THE Bộ_Nhận_Diện SHALL gán tất cả các trang là `CUSTOM` với `source` bằng `custom` và SHALL trả về kết quả hoàn tất mà không phát sinh lỗi ở cấp file.

### Requirement 5: Xử lý mọi trang không giới hạn 30 trang

**User Story:** Là người vận hành xử lý file lớn, tôi muốn mọi trang đều được nhận diện, để file nhiều hơn 30 trang không bị mất shape ở các trang sau.

#### Acceptance Criteria

1. WHEN nhận diện hình cho một file có N trang (với N từ 1 đến tối đa 10.000 trang), THE Bộ_Nhận_Diện SHALL xử lý lần lượt mọi trang từ trang 1 đến trang N, sao cho số trang đã xử lý bằng đúng tổng số trang N của file.
2. THE Bộ_Nhận_Diện SHALL không áp đặt bất kỳ giới hạn cố định nào (bao gồm giới hạn 30 trang) làm dừng việc nhận diện trước khi đạt tới trang cuối cùng (trang N) của file.
3. WHERE tổng số trang vượt ngưỡng xử lý theo lô cấu hình được (mặc định 50 trang, cho phép cấu hình trong khoảng 10 đến 500 trang), THE Bộ_Nhận_Diện SHALL chia file thành các lô liên tiếp, mỗi lô tối đa bằng ngưỡng đã cấu hình, sao cho hợp của tất cả các lô bao phủ đầy đủ mọi trang từ 1 đến N mà không bỏ sót hoặc lặp trang.
4. IF việc nhận diện một trang bất kỳ thất bại, THEN THE Bộ_Nhận_Diện SHALL tiếp tục xử lý các trang còn lại, ghi nhận trang lỗi kèm chỉ báo nêu rõ trang nào không nhận diện được, và giữ nguyên kết quả của các trang đã xử lý thành công.
5. WHEN hoàn tất nhận diện toàn bộ file, THE Bộ_Nhận_Diện SHALL trả về kết quả nêu rõ tổng số trang đã xử lý, số trang nhận diện thành công và danh sách số thứ tự các trang bị lỗi (nếu có).

### Requirement 6: Lan truyền hình bất biến xuống lớp layout

**User Story:** Là kỹ sư bảo trì, tôi muốn DetectedShape chảy bất biến từ Detection xuống Layout, để không lớp nào âm thầm sửa đổi hay loại bỏ thông tin hình.

#### Acceptance Criteria

1. WHEN Lớp_Layout bắt đầu tính bố cục cho một trang, THE Lớp_Layout SHALL nhận đủ ba trường `type`, `props`, và `poly` từ DetectedShape của trang đó làm đầu vào.
2. THE Lớp_Layout SHALL sử dụng giá trị `props` nhận từ DetectedShape mà không sửa đổi, không loại bỏ, và không tự tái trích `props` từ path.
3. WHEN Lớp_Layout xuất kết quả bố cục cho một trang, THE Lớp_Layout SHALL bảo đảm `type`, `props`, và `poly` trong đầu ra bằng đúng (so sánh bằng theo giá trị) các trường tương ứng đã nhận ở đầu vào.
4. WHEN frontend gửi yêu cầu layout cho file die-cut hoặc CNC chứa N trang, THE Hệ_Thống SHALL truyền xuống worker đúng N đối tượng DetectedShape, mỗi đối tượng tương ứng một trang theo đúng thứ tự trang của file đầu vào.
5. IF DetectedShape của một trang có `type` bằng `CUSTOM` và `poly` chứa từ 3 đỉnh trở lên, THEN THE Lớp_Layout SHALL áp dụng chiến lược bố cục dành cho hình bất kỳ dựa trên `poly` thay vì giả định hình chữ nhật.
6. IF DetectedShape của một trang có `type` bằng `CUSTOM` nhưng `poly` rỗng, thiếu, hoặc có ít hơn 3 đỉnh, THEN THE Lớp_Layout SHALL từ chối xử lý trang đó, trả về thông báo lỗi chỉ rõ `poly` không hợp lệ, và giữ nguyên DetectedShape đầu vào không thay đổi.

### Requirement 7: Parity giữa preview và output

**User Story:** Là người vận hành, tôi muốn preview phản ánh đúng kết quả in, để không bị bất ngờ giữa bản xem trước và bản in thật.

#### Acceptance Criteria

1. WHEN preview và output được tính cho cùng một file với cùng bộ tham số (khổ trang, số hàng/cột, gutter, lề, góc xoay, thứ tự bình), THE Lớp_Layout SHALL tạo ra bố cục có cùng số phần tử và cùng thứ tự phần tử cho cả hai.
2. THE Lớp_Layout SHALL sử dụng cùng một đối tượng DetectedShape (cùng định danh và cùng giá trị các trường) cho cả đường dẫn preview và đường dẫn output.
3. WHEN so sánh preview và output của cùng đầu vào, THE Hệ_Thống SHALL coi là ĐẠT khi sai lệch vị trí và kích thước (x, y, width, height) của mỗi phần tử không vượt quá 0.1 mm và sai lệch góc xoay không vượt quá 0.01 độ.
4. IF sai lệch parity giữa preview và output vượt quá dung sai cấu hình được, THEN THE Hệ_Thống SHALL coi là KHÔNG ĐẠT và trả về chỉ báo lỗi nêu rõ phần tử và loại sai lệch.
5. WHERE cấu hình dung sai parity bị thiếu hoặc nằm ngoài khoảng hợp lệ, THE Hệ_Thống SHALL áp dụng giá trị dung sai mặc định và ghi log cảnh báo.

### Requirement 8: CNC gang dùng hình thật

**User Story:** Là người vận hành CNC, tôi muốn chế độ ghép nhiều mẫu (gang) xếp theo hình thật của tem, để tiết kiệm giấy thay vì xếp như hình chữ nhật.

#### Acceptance Criteria

1. WHEN dựng bố cục CNC gang, THE Lớp_Render_CNC SHALL truyền DetectedShape của từng mẫu vào Lớp_Layout dùng chung mà không sửa đổi `type`, `props`, hay `poly`.
2. WHEN tính bố cục cho Tem Bế, N-up die-cut, và CNC gang với cùng đầu vào, THE Lớp_Layout SHALL dùng cùng một hàm `compute_layout` và tạo bố cục đồng nhất trong giới hạn dung sai cấu hình được.
3. WHERE `type` của một mẫu khác RECTANGLE, THE Lớp_Render_CNC SHALL sử dụng `type` và `poly` từ DetectedShape thay vì bin-pack theo hình chữ nhật bao của `trim`.
4. WHEN xếp CNC gang và CNC S&R một mẫu, THE Lớp_Render_CNC SHALL cho số mẫu trên tờ và vị trí lồng ghép trùng với kết quả của Tem Bế cho cùng đầu vào trong giới hạn dung sai cấu hình được.
5. WHEN xếp một mẫu khác hình chữ nhật theo `poly`, THE Lớp_Render_CNC SHALL đạt số mẫu trên mỗi tờ không nhỏ hơn số mẫu khi bin-pack theo hình chữ nhật bao của `trim`.
6. WHERE `type` của một mẫu bằng `CUSTOM`, THE Lớp_Render_CNC SHALL xếp mẫu đó theo `poly` thay vì hình chữ nhật bao.

### Requirement 9: Bảo toàn đặc thù CNC (2 mặt + trang Khuôn)

**User Story:** Là người vận hành CNC, tôi muốn việc dùng chung lớp layout không làm mất các đặc thù CNC, để vẫn xuất được 2 mặt và trang Khuôn như trước.

#### Acceptance Criteria

1. THE Lớp_Render_CNC SHALL thêm hành vi 2 mặt, trang Khuôn, và dấu canh chỉ ở lớp Render mà không thay đổi `type`, `props`, hay `poly` của DetectedShape.
2. WHERE chế độ 2 mặt được bật, THE Lớp_Render_CNC SHALL xuất cho mỗi đơn vị bình các trang theo đúng thứ tự Mặt trước → Mặt sau → trang Khuôn.
3. WHERE chế độ một mặt được bật, THE Lớp_Render_CNC SHALL xuất cho mỗi đơn vị bình các trang theo đúng thứ tự Mặt trước → trang Khuôn.
4. THE Lớp_Render_CNC SHALL lật gương Mặt sau theo trục xác định bởi `cncFlipEdge`, với `cncFlipEdge` nhận đúng một trong hai giá trị `long` hoặc `short` (mặc định `long`).
5. IF chế độ 2 mặt được bật và file có số trang lẻ, THEN THE Lớp_Render_CNC SHALL dừng và trả về lỗi yêu cầu số trang chẵn, và SHALL không tạo ra trang đầu ra nào.
6. THE Lớp_Render_CNC SHALL gộp đường bế của tất cả các mẫu trên tờ vào trang Khuôn, và trang Khuôn SHALL chỉ chứa đường cắt/bế, không chứa artwork hay nền toàn trang.
7. IF một ô trên tờ không có đường bế hợp lệ, THEN THE Lớp_Render_CNC SHALL bỏ qua ô đó, ghi log, và tiếp tục xuất các ô còn lại.

### Requirement 10: Thống nhất enum ShapeType

**User Story:** Là kỹ sư bảo trì, tôi muốn chỉ còn một định nghĩa enum ShapeType, để loại bỏ mâu thuẫn giữa hai enum có tập giá trị khác nhau.

#### Acceptance Criteria

1. THE Hệ_Thống SHALL định nghĩa enum ShapeType tại đúng một (01) vị trí duy nhất trong mã nguồn, và SHALL không còn tồn tại bất kỳ định nghĩa enum ShapeType trùng lặp nào khác.
2. THE Hệ_Thống SHALL tham chiếu cùng một định nghĩa enum ShapeType đã thống nhất tại tất cả các vị trí mã nguồn cần phân loại hình, và SHALL không còn tham chiếu đến bất kỳ định nghĩa enum ShapeType cũ nào.
3. WHERE mã nguồn trước đây dùng enum ShapeType ở `shape_classifier.py` hoặc `shape_analyzer.py`, THE Hệ_Thống SHALL thay thế hoàn toàn bằng tham chiếu đến enum thống nhất.
4. THE enum ShapeType thống nhất SHALL bao gồm đúng 11 giá trị: CIRCLE_ELLIPSE, TRIANGLE, RECTANGLE, PENTAGON, HEXAGON, DUMBBELL, HAMMER, TRAPEZOID, PARALLELOGRAM, ARROW, và CUSTOM, và SHALL không chứa bất kỳ giá trị nào khác ngoài 11 giá trị này.
5. WHEN một giá trị thuộc tập enum ShapeType cũ tương ứng về mặt ngữ nghĩa với một giá trị trong enum thống nhất, THE Hệ_Thống SHALL ánh xạ giá trị cũ đó tới đúng một giá trị thống nhất tương ứng.
6. IF mã nguồn tham chiếu một giá trị ShapeType không tồn tại trong tập 11 giá trị của enum thống nhất, THEN THE Hệ_Thống SHALL báo lỗi tại thời điểm biên dịch hoặc khởi tạo với thông báo lỗi chỉ rõ tên giá trị không hợp lệ, và SHALL không tiếp tục khởi chạy.

### Requirement 11: Hướng Rust hoá classifier với fallback Python

**User Story:** Là kỹ sư hiệu năng, tôi muốn phần toán phân loại hình có thể chạy bằng Rust cạnh solver, để tăng tốc trong khi vẫn an toàn nhờ fallback Python.

#### Acceptance Criteria

1. WHERE module Rust `pdfcompare_native` khả dụng, THE Bộ_Nhận_Diện SHALL sử dụng các hàm Rust để phân loại hình và chọn đường khuôn, đồng thời gán cho mỗi đối tượng hình học một giá trị `type` thuộc tập hợp các loại được định nghĩa trong cấu hình.
2. THE Bộ_Nhận_Diện SHALL thực hiện phần đọc PDF và phần trích xuất Spot_Color/Separation bằng đường dẫn Python trong mọi trường hợp, không phụ thuộc vào việc module Rust có khả dụng hay không.
3. IF module Rust `pdfcompare_native` không khả dụng và Fallback_Python được bật, THEN THE Bộ_Nhận_Diện SHALL phân loại hình bằng đường dẫn Python và gán giá trị `type` từ cùng tập hợp loại như đường dẫn Rust.
4. IF module Rust `pdfcompare_native` không khả dụng và Fallback_Python bị tắt, THEN THE Bộ_Nhận_Diện SHALL dừng tác vụ phân loại, không tạo ra kết quả `type` nào, và trả về thông báo lỗi cho biết không có đường dẫn phân loại khả dụng.
5. WHEN cùng một đầu vào hình học được phân loại bằng đường dẫn Rust và bằng đường dẫn Python, THE Hệ_Thống SHALL cho cùng một giá trị `type`, và đối với các thuộc tính số kèm theo (ví dụ toạ độ, kích thước) THE Hệ_Thống SHALL cho các giá trị sai khác không vượt quá ngưỡng dung sai cấu hình được với giá trị mặc định 0,01 mm.
6. IF kết quả phân loại giữa đường dẫn Rust và đường dẫn Python khác giá trị `type` hoặc vượt ngưỡng dung sai cấu hình được, THEN THE Hệ_Thống SHALL ghi nhận sai khác đó là một mục không khớp và trả về thông báo cho biết hai đường dẫn cho kết quả khác nhau.

### Requirement 12: Giữ chính sách fail-fast của Rust cho tính layout

**User Story:** Là kỹ sư bảo trì, tôi muốn chính sách fail-fast của Rust cho phần tính layout được giữ nguyên, để không âm thầm cho kết quả khác parity.

#### Acceptance Criteria

1. WHEN một entry tính layout được gọi, THE Hệ_Thống SHALL thực thi kiểm tra `require_rust` trước khi thực hiện bất kỳ phép tính layout nào, và không nhánh thực thi nào được bỏ qua bước kiểm tra này.
2. IF module Rust không khả dụng VÀ Fallback_Python bị tắt, THEN THE Hệ_Thống SHALL dừng việc tính layout ngay lập tức (fail-fast), trả về lỗi cho bên gọi với thông báo chỉ rõ rằng module Rust không khả dụng, không thực hiện tính bằng Python, và không tạo ra bất kỳ kết quả layout một phần hay đầu ra nào.
3. WHEN module Rust khả dụng và kiểm tra `require_rust` thành công, THE Hệ_Thống SHALL tính layout bằng module Rust.
4. WHERE Fallback_Python được bật qua biến môi trường `IMPOSITION_ALLOW_PY_FALLBACK` (nhận giá trị bật/tắt theo quy ước boolean), WHILE module Rust không khả dụng, WHEN một entry tính layout được gọi, THE Hệ_Thống SHALL ghi đúng một bản ghi log ở mức cảnh báo nêu rõ rằng parity không được đảm bảo trước khi tiến hành tính layout bằng Python.

### Requirement 13: Không hồi quy các solver Rust hiện có

**User Story:** Là kỹ sư bảo trì, tôi muốn việc tái cấu trúc không làm hồi quy các solver hình học Rust đang chạy, để hiệu năng và độ chính xác hiện tại được bảo toàn.

#### Acceptance Criteria

1. WHEN một solver Rust hình học hiện có (`shape_*`, `sticker_*`, `NfpSolver`) được gọi sau khi tái cấu trúc, THE Hệ_Thống SHALL trả về cùng tập trường đầu ra (cùng tên trường và cùng kiểu dữ liệu) như trước khi tái cấu trúc.
2. WHEN một solver Rust hiện có được gọi với cùng một đầu vào không đổi, THE Hệ_Thống SHALL trả về các giá trị số đầu ra (tọa độ, kích thước, diện tích) khác với kết quả trước khi tái cấu trúc không quá 1e-6 đơn vị cho mỗi giá trị.
3. WHEN một solver Rust hiện có được gọi với cùng một đầu vào không đổi qua tối thiểu 100 lần chạy liên tiếp, THE Hệ_Thống SHALL trả về kết quả giống hệt nhau giữa các lần chạy (tính ổn định/idempotence).
4. WHERE classifier được bổ sung vào lớp Rust, THE Hệ_Thống SHALL giữ nguyên chữ ký hàm (tên hàm, danh sách tham số, kiểu trả về) của các hàm solver Rust hiện có không đổi.
5. WHEN một solver Rust hiện có được gọi với cùng một đầu vào không đổi, THE Hệ_Thống SHALL hoàn tất xử lý trong thời gian không vượt quá 110% thời gian xử lý đo được trước khi tái cấu trúc trên cùng một môi trường đo.
6. IF một solver Rust hiện có nhận đầu vào không hợp lệ sau khi tái cấu trúc, THEN THE Hệ_Thống SHALL trả về cùng hành vi lỗi (cùng loại lỗi và cùng tín hiệu báo lỗi cho người gọi) như trước khi tái cấu trúc, mà không làm thay đổi trạng thái dữ liệu đầu vào.

### Requirement 14: Tương thích ngược luồng hiện có

**User Story:** Là người vận hành đang dùng hệ thống, tôi muốn các luồng và endpoint hiện có vẫn hoạt động, để việc nâng cấp không phá vỡ quy trình đang chạy.

#### Acceptance Criteria

1. WHEN endpoint `/detect-shape` trả về kết quả thành công cho một yêu cầu, THE Hệ_Thống SHALL bao gồm các trường `shapes`, `dimensions`, và `shapeParams` với cùng tên trường và cùng kiểu dữ liệu mà frontend hiện tiêu thụ.
2. WHERE frontend gửi `detectedShapesByPage`, `detectedShapeParamsByPage`, hoặc `detectedShapeDimensions`, THE Hệ_Thống SHALL chấp nhận và ánh xạ chúng sang DetectedShape mà không loại bỏ trang nào trong dữ liệu nhận được.
3. IF dữ liệu `detectedShapesByPage`, `detectedShapeParamsByPage`, hoặc `detectedShapeDimensions` không hợp lệ hoặc không ánh xạ được sang DetectedShape, THEN THE Hệ_Thống SHALL từ chối yêu cầu với phản hồi lỗi nêu rõ trường gây lỗi và SHALL giữ nguyên trạng thái job không thay đổi.
4. WHEN một người gọi gửi yêu cầu tới các endpoint khởi tạo job hiện có (`/impose-start`, `/nup-start`, `/sticker-start`) với tập tham số đã hợp lệ trước nâng cấp, THE Hệ_Thống SHALL chấp nhận yêu cầu đó mà không yêu cầu thêm tham số mới và SHALL trả về cùng tập trường phản hồi như trước nâng cấp.
5. WHEN một file không có đường khuôn (die-cut) được xử lý, THE Hệ_Thống SHALL gán cho mỗi trang không die-cut một DetectedShape với `type` bằng `CUSTOM` và SHALL tạo bố cục giống kết quả của luồng trước nâng cấp trong giới hạn dung sai parity cấu hình được ở Requirement 7.

### Requirement 15: Khả năng kiểm thử (parity và phân loại)

**User Story:** Là kỹ sư QA, tôi muốn có các test kiểm chứng tính ổn định và parity, để bắt sớm hồi quy của việc nhận diện và bố cục.

#### Acceptance Criteria

1. THE Hệ_Thống SHALL cung cấp test xác minh rằng khi nhận diện được chạy lặp lại ít nhất 3 lần trên cùng một file đầu vào, chuỗi `type` trả về ở mỗi lần chạy giống hệt nhau về thứ tự và giá trị (số phần tử sai khác = 0).
2. THE Hệ_Thống SHALL cung cấp test parity xác minh rằng với cùng một đầu vào, bố cục của preview và output có cùng số phần tử và cùng thứ tự phần tử, với sai lệch tọa độ và kích thước của mỗi phần tử không vượt quá 0.1 pt.
3. THE Hệ_Thống SHALL cung cấp test xác minh rằng với cùng một tập đầu vào hình học, classifier Rust và classifier Python trả về cùng giá trị `type` cho từng phần tử (tỷ lệ khớp = 100%).
4. IF một trang đơn lẻ gây lỗi trong quá trình nhận diện, THEN THE Hệ_Thống SHALL cung cấp test xác minh rằng tất cả các trang còn lại vẫn được nhận diện thành công, lỗi của trang đó được ghi nhận và đánh dấu riêng, và kết quả của các trang khác không bị hủy.
5. WHERE đường khuôn được dựng bằng fill, nằm trong Form_XObject, hoặc chia thành nhiều Subpath, THE Hệ_Thống SHALL cung cấp test xác minh rằng đường khuôn trong từng trường hợp được nhận diện đúng, khớp với đường khuôn tham chiếu kỳ vọng (sai lệch hình học = 0 so với tham chiếu).
