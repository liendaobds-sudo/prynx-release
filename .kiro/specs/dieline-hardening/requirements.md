# Requirements Document

## Introduction

Đây là spec **Giai đoạn 1 (Phase 1)** cho sáng kiến **củng cố chất lượng** của tính năng tạo khuôn bế (dieline) hộp/bao bì dạng tham số đã tồn tại tại `desktop/src/lib/dieline/`. Tính năng chạy hoàn toàn ở phía client bằng TypeScript thuần (React + Zustand + Three.js), xuất file qua jsPDF + svg2pdf.js, không có thay đổi backend.

Phạm vi Giai đoạn 1 đến trực tiếp từ một đợt audit mã nguồn và gồm 6 workstream củng cố chất lượng:

1. Kiểm tra biên dạng khép kín (closed contour) trước khi xuất — quan trọng nhất.
2. Bổ sung kiểm thử hình học (geometry tests), không chỉ kiểm thử cấu trúc.
3. Đổ cảnh báo (warnings) vào `DielineModel.warnings` một cách nhất quán.
4. Loại bỏ trùng lặp mã (chống "drift" giữa export và canvas).
5. Làm rõ tag `BLEED`.
6. Sửa mô tả sai lệch của `dieGap`.

Mục tiêu chất lượng tổng thể: tăng độ tin cậy của file bế xuất ra, ngăn xuất file lỗi âm thầm, và giảm rủi ro phân kỳ mã giữa các module — **mà không** thay đổi hình học đầu ra đúng đắn của 8 generator hiện tại và **không** làm hỏng 102 test đang pass.

### Phạm vi (In Scope)

- Module dieline phía client tại `desktop/src/lib/dieline/` và component liên quan `desktop/src/components/dieline-tool/DielineCanvas2D.tsx`.
- 8 generator: ReverseTuckEnd, SnapLockBottom, GableBox, PaperBag, CupSleeve, PizzaBox, Envelope, MatchboxTray/Sleeve.

### Ngoài phạm vi (Out of Scope — Giai đoạn 2)

Các hạng mục sau **không** thuộc spec này: xuất DXF, spot color/layer trong PDF, xuất AI/SVG, thêm template hộp mới, đặt artwork lên dieline, vật liệu 3D. Mọi thay đổi backend cũng nằm ngoài phạm vi.

## Glossary

- **Dieline_System**: Toàn bộ module tạo khuôn bế phía client tại `desktop/src/lib/dieline/`.
- **Generator**: Một trong 8 hàm sinh khuôn bế (ReverseTuckEnd, SnapLockBottom, GableBox, PaperBag, CupSleeve, PizzaBox, Envelope, MatchboxTray/Sleeve) tạo ra một `DielineModel`.
- **DielineModel**: Mô hình khuôn bế hoàn chỉnh định nghĩa trong `types.ts`, gồm `panels`, `allPaths`, `boundingBox`, `params`, và trường tùy chọn `warnings: string[]`.
- **Panel**: Một mặt phẳng (mặt hộp, nắp, tai, vạt) trong khuôn bế, gồm danh sách `PathSegment`.
- **Cut_Piece**: Một mảnh được cắt rời (thân hộp, nắp, tai, vạt) có biên ngoài là tập hợp các đoạn `CUT`/`BLEED` cần khép kín thành vòng (closed loop) trước khi xuất.
- **PathSegment**: Đoạn đường cơ bản gồm `points`, `tag` (CUT/CREASE/BLEED), `type` (line/arc/bezier).
- **PathTag**: Nhãn loại nét: `CUT` (cắt), `CREASE` (cấn), `BLEED` (tràn lề).
- **Closed_Contour**: Biên dạng khép kín, trong đó điểm đầu chuỗi và điểm cuối chuỗi trùng nhau trong dung sai cho phép.
- **Contour_Validator**: Thành phần (mới) kiểm tra tính khép kín của các biên dạng cắt trước khi xuất.
- **Chain_Builder**: Logic nối các `PathSegment` thành chuỗi liên tục theo dung sai endpoint (hiện được hiện thực dưới dạng `buildChains`/`segEndpoints`/`chainToSvgD`).
- **Trace_Perimeter**: Hàm `tracePerimeter` trong `tracePerimeter.ts` nối các đoạn cắt thành chu vi, hiện chỉ dùng cho 3D.
- **Snap_Tolerance**: Dung sai khớp endpoint khi nối chuỗi (hiện tại 0.01mm trong export, 1e-2 căn bậc hai của 1e-4 trong trace).
- **Connect_Corner**: Logic `connectCorner` trong `ReverseTuckEnd.ts` (và `SnapLockBottom.ts`) hàn tai bụi (dust flap) vào panel đóng (closure panel) bằng cách biến đổi (mutate) tọa độ điểm.
- **Export_Module**: Module xuất file tại `exportPDF.ts`.
- **Canvas_Module**: Component hiển thị 2D tại `DielineCanvas2D.tsx`.
- **Shared_Geometry_Module**: Module dùng chung (mới) chứa logic nối chuỗi và công thức ghi chú kích thước, được cả Export_Module và Canvas_Module sử dụng.
- **Validate_Params**: Hàm `validateParams` trả về `params` đã clamp và mảng `warnings`.
- **Box_Store**: Zustand store `useBoxStore.ts`; hiện lưu cảnh báo trong trường riêng `snapLockWarning`.
- **Nesting_Engine**: Module `nestingEngine.ts` xếp khuôn vào khổ in.
- **Die_Gap**: Tham số `dieGap` trong `nestingTypes.ts`.
- **Test_Suite**: Bộ kiểm thử hiện có (102 test đang pass), gồm `generators.test.ts`, `validateParams.test.ts`, `nestingEngine.test.ts`.

## Requirements

### Requirement 1: Kiểm tra biên dạng khép kín trước khi xuất (Validate Closed Contour)

**User Story:** Là một kỹ thuật viên chế bản, tôi muốn hệ thống phát hiện biên dạng cắt không khép kín trước khi xuất file bế, để tôi không vô tình gửi một file dao bế hỏng cho xưởng.

#### Acceptance Criteria

1. WHEN một thao tác xuất file được yêu cầu cho một DielineModel, THE Contour_Validator SHALL kiểm tra từng Cut_Piece để xác định mỗi biên dạng cắt có tạo thành Closed_Contour với khoảng hở giữa điểm đầu và điểm cuối chuỗi ≤ 0,01mm (Snap_Tolerance) hay không.
2. IF một Cut_Piece chứa biên dạng cắt hở (khoảng hở đầu-cuối > 0,01mm), THEN THE Contour_Validator SHALL tạo một cảnh báo xác định Panel và Cut_Piece chứa biên dạng hở, kèm khoảng hở đo được tính bằng mm.
3. WHEN một biên dạng cắt hở được phát hiện trong lúc xuất, THE Export_Module SHALL hiển thị cảnh báo cho người dùng trước khi tạo file.
4. IF tồn tại ít nhất một biên dạng hở, THEN THE Export_Module SHALL không tạo file xuất cho đến khi người dùng xác nhận tường minh muốn tiếp tục.
5. THE Contour_Validator SHALL phân loại mỗi Cut_Piece là khép kín hoặc hở dựa trên cùng một giá trị Snap_Tolerance (0,01mm) mà Chain_Builder sử dụng.
6. WHERE hàm Trace_Perimeter đã cung cấp khả năng nối các đoạn cắt thành chu vi, THE Contour_Validator SHALL tái sử dụng Trace_Perimeter thay vì hiện thực một thuật toán nối chuỗi thứ hai.
7. WHEN Connect_Corner hàn tai bụi vào panel đóng bằng cách biến đổi tọa độ điểm, THE Contour_Validator SHALL kiểm tra các biên dạng kết quả của các góc bị tác động vẫn khép kín trong giới hạn 0,01mm.
8. WHEN tất cả Cut_Piece của một DielineModel khép kín (0 cảnh báo biên dạng hở), THE Export_Module SHALL tiến hành tạo file mà không yêu cầu xác nhận thêm.

### Requirement 2: Bổ sung kiểm thử hình học cho 8 generator (Geometry Tests)

**User Story:** Là một lập trình viên bảo trì module dieline, tôi muốn có kiểm thử xác minh tính đúng đắn hình học chứ không chỉ cấu trúc, để các thay đổi tương lai không âm thầm phá vỡ hình dạng khuôn bế.

#### Acceptance Criteria

1. THE Test_Suite SHALL bao gồm một kiểm thử xác minh mỗi Cut_Piece của khuôn bế tạo thành Closed_Contour, trong đó Closed_Contour được định nghĩa là chuỗi cạnh liên tục có điểm đầu của cạnh đầu tiên trùng với điểm cuối của cạnh cuối cùng trong dung sai 0.001 mm, và mọi điểm cuối của mỗi cạnh trùng với điểm đầu của cạnh kế tiếp trong dung sai 0.001 mm; kiểm thử áp dụng cho cả 8 Generator.
2. THE Test_Suite SHALL bao gồm một kiểm thử xác minh với mọi cặp Panel khác nhau của một DielineModel, diện tích phần giao của hai đa giác Panel không vượt quá 0.01 mm² (cho phép tiếp xúc chung biên nhưng không chồng lấn), áp dụng cho cả 8 Generator.
3. THE Test_Suite SHALL bao gồm một kiểm thử xác minh tổng diện tích phẳng của khuôn bế khớp với giá trị tính từ công thức kỳ vọng theo `params` với sai lệch tương đối không quá 0.1%, áp dụng cho cả 8 Generator.
4. THE Test_Suite SHALL bao gồm một kiểm thử xác minh tính nhất quán của động học gập (fold kinematics): với mỗi Panel có `pivotEdge`, hai điểm đầu mút của `pivotEdge` phải nằm trên biên chung giữa Panel đó và Panel cha của nó, với khoảng cách từ mỗi điểm tới đoạn biên chung không quá 0.001 mm.
5. WHEN bộ kiểm thử hình học chạy, THE Test_Suite SHALL giữ nguyên toàn bộ 102 test cấu trúc hiện có ở trạng thái pass, không có test nào chuyển sang fail hoặc bị bỏ qua (skip).
6. WHERE một thuộc tính hình học thay đổi theo `params` đầu vào, THE Test_Suite SHALL kiểm tra thuộc tính đó bằng kiểm thử dựa trên thuộc tính (property-based test) với tối thiểu 50 bộ tham số sinh ngẫu nhiên hợp lệ cho mỗi Generator.
7. IF một kiểm thử hình học phát hiện biên dạng hở vượt dung sai 0.001 mm, diện tích chồng lấn panel vượt 0.01 mm², hoặc sai lệch diện tích phẳng vượt 0.1%, THEN THE Test_Suite SHALL báo fail và xác định trong thông báo lỗi tên Generator cùng bộ `params` gây lỗi.

### Requirement 3: Đổ cảnh báo vào DielineModel.warnings một cách nhất quán

**User Story:** Là một người dùng giao diện tạo khuôn bế, tôi muốn các cảnh báo về khả năng sản xuất luôn gắn liền với mô hình khuôn bế, để giao diện hiển thị chúng một cách đáng tin cậy bất kể nguồn cảnh báo.

#### Acceptance Criteria

1. WHEN một Generator tạo ra một DielineModel từ các `params` đã được Validate_Params kiểm tra, THE Dieline_System SHALL gán toàn bộ cảnh báo về kiểm tra/khả năng sản xuất phát sinh trong quá trình kiểm tra và sinh mô hình vào trường `DielineModel.warnings` dưới dạng một mảng các chuỗi cảnh báo.
2. WHEN Validate_Params trả về một hay nhiều cảnh báo cho một bộ `params`, THE Dieline_System SHALL đưa tất cả các cảnh báo đó vào trường `DielineModel.warnings` của mô hình sinh ra từ bộ `params` đó, không bỏ sót và không trùng lặp cảnh báo có cùng nội dung.
3. WHEN một cảnh báo khóa/chốt (snap-lock) được phát sinh trong quá trình sinh mô hình, THE Dieline_System SHALL đưa cảnh báo đó vào cùng trường `DielineModel.warnings` thay vì lưu ở một trường cảnh báo riêng biệt.
4. WHEN trường `DielineModel.warnings` đã được điền, THE Canvas_Module SHALL đọc cảnh báo để hiển thị chỉ từ `DielineModel.warnings` và không dùng nguồn cảnh báo riêng nào khác.
5. IF một bộ `params` không phát sinh cảnh báo nào, THEN THE Dieline_System SHALL đặt `DielineModel.warnings` thành một mảng rỗng (độ dài bằng 0), không phải giá trị null hoặc không xác định.
6. WHEN cùng một bộ `params` được dùng để sinh mô hình, THE Dieline_System SHALL bảo đảm tập cảnh báo trong `DielineModel.warnings` chứa đúng và đủ tập cảnh báo do Validate_Params và quá trình sinh mô hình tạo ra cho bộ `params` đó, với nội dung từng cảnh báo giống hệt nhau.
7. IF Validate_Params phát sinh lỗi trong khi kiểm tra một bộ `params`, THEN THE Dieline_System SHALL không tạo DielineModel với trường `warnings` thiếu hoặc sai và SHALL báo hiệu lỗi kiểm tra cho phía gọi.

### Requirement 4: Loại bỏ trùng lặp mã giữa Export và Canvas (Drift Prevention)

**User Story:** Là một lập trình viên, tôi muốn logic nối chuỗi và công thức ghi chú kích thước nằm ở một nơi duy nhất, để một thay đổi không âm thầm phân kỳ giữa file xuất và bản hiển thị trên canvas.

#### Acceptance Criteria

1. THE Shared_Geometry_Module SHALL cung cấp logic nối chuỗi dùng chung (tương đương `buildChains`, `segEndpoints`, `chainToSvgD`) để cả Export_Module và Canvas_Module dùng lại.
2. THE Shared_Geometry_Module SHALL cung cấp công thức ghi chú kích thước dùng chung (ví dụ phép tính `FH`/`SF` của Envelope) để cả Export_Module và Canvas_Module dùng lại.
3. WHEN Export_Module dựng đường dẫn SVG hoặc ghi chú kích thước, THE Export_Module SHALL gọi Shared_Geometry_Module và SHALL không chứa bản sao cục bộ của logic nối chuỗi hay công thức kích thước.
4. WHEN Canvas_Module dựng đường dẫn SVG hoặc ghi chú kích thước, THE Canvas_Module SHALL gọi Shared_Geometry_Module và SHALL không chứa bản sao cục bộ của logic nối chuỗi hay công thức kích thước.
5. WHEN Export_Module và Canvas_Module xử lý cùng một DielineModel hợp lệ, THE Dieline_System SHALL tạo ra chuỗi đường dẫn SVG giống nhau ký-tự-theo-ký-tự và các giá trị ghi chú kích thước bằng nhau trong sai số tối đa 0,001 mm.
6. WHEN tái cấu trúc hoàn tất, THE Dieline_System SHALL tạo ra chuỗi đường dẫn SVG giống nhau ký-tự-theo-ký-tự và giá trị ghi chú kích thước bằng nhau trong sai số tối đa 0,001 mm so với kết quả trước khi tái cấu trúc, đối với mọi DielineModel hợp lệ trong bộ kiểm thử.
7. IF Shared_Geometry_Module nhận một DielineModel không hợp lệ (thiếu segment hoặc chuỗi không khép kín), THEN THE Shared_Geometry_Module SHALL trả về lỗi cho bên gọi cho biết model không hợp lệ và SHALL không tạo ra đường dẫn SVG hoặc giá trị kích thước một phần.

### Requirement 5: Làm rõ tag BLEED

**User Story:** Là một người dùng, tôi muốn chú giải (legend) chỉ hiển thị các loại nét thực sự tồn tại trong file, để tôi không bị nhầm tưởng có đường tràn lề trong khi thực tế không có.

#### Acceptance Criteria

1. THE Dieline_System SHALL không hiển thị trong chú giải bất kỳ PathTag nào không xuất hiện trên ít nhất một PathSegment của file đã sinh (loại bỏ trạng thái BLEED nằm trong chú giải mà không có đoạn BLEED nào).
2. THE Dieline_System SHALL áp dụng một quyết định duy nhất cho tag BLEED: hoặc (A) sinh ra biên dạng BLEED thực, hoặc (B) gỡ BLEED khỏi chú giải của canvas và file xuất.
3. WHERE quyết định là (A) sinh biên dạng BLEED thực, THE Generator liên quan SHALL phát ra các PathSegment mang tag BLEED, VÀ THE Canvas_Module cùng Export_Module SHALL hiển thị BLEED trong chú giải.
4. WHERE quyết định là (B) gỡ BLEED, THE Canvas_Module và Export_Module SHALL không hiển thị BLEED trong chú giải.
5. WHEN một file được sinh, THE Dieline_System SHALL bảo đảm tập các PathTag hiển thị trong chú giải bằng đúng (set equality hai chiều) tập các PathTag thực sự xuất hiện trên các PathSegment trong file đó.
6. IF một PathTag xuất hiện trong chú giải nhưng không có trên bất kỳ PathSegment nào trong file (hoặc ngược lại), THEN THE Dieline_System SHALL coi đó là trạng thái không hợp lệ và điều chỉnh chú giải để khớp với tập PathTag thực sự có trong file.

> Lưu ý cần quyết định trong giai đoạn requirements: lựa chọn (A) sinh bleed thực hay (B) gỡ bleed khỏi chú giải. Xem câu hỏi mở ở cuối tài liệu.

### Requirement 6: Sửa mô tả sai lệch của dieGap

**User Story:** Là một lập trình viên đọc cấu hình nesting, tôi muốn mô tả của `dieGap` phản ánh đúng hành vi thực tế, để tôi không hiểu sai cách xếp khuôn hoạt động.

#### Acceptance Criteria

1. THE Dieline_System SHALL cập nhật chú thích mô tả của thuộc tính `dieGap` trong tệp `nestingTypes.ts` sao cho chú thích không còn chứa cụm mô tả "offset polygon ra ngoài mỗi bên".
2. WHERE Nesting_Engine trong tệp `nestingEngine.ts` hiện thực `dieGap` như khoảng hở (gap) giữa các hộp bao (bounding box) của các khuôn liền kề chứ không phải phép offset polygon thực, THE Dieline_System SHALL nêu trong chú thích của `dieGap` rằng giá trị `dieGap` là khoảng hở tính bằng đơn vị độ dài giữa các bounding box của hai khuôn liền kề.
3. IF phép offset polygon thực (offset đường biên polygon theo từng cạnh) chưa được Nesting_Engine hiện thực, THEN THE Dieline_System SHALL ghi trong chú thích của `dieGap` rằng offset polygon thực là một giới hạn đã biết (known limitation) dự kiến xử lý ở Giai đoạn 2.
4. THE Dieline_System SHALL giữ nguyên toàn bộ logic và kết quả tính toán hiện tại của Nesting_Engine, chỉ thay đổi nội dung chú thích/tài liệu mà không thay đổi bất kỳ câu lệnh thực thi nào.

### Requirement 7: Ràng buộc không hồi quy (Non-Regression Constraints)

**User Story:** Là chủ sở hữu sản phẩm, tôi muốn việc củng cố chất lượng không phá vỡ hành vi đúng đắn đang có, để người dùng hiện tại không gặp lỗi mới.

#### Acceptance Criteria

1. THE Dieline_System SHALL giữ toàn bộ logic ở phía client bằng TypeScript thuần, với 0 lời gọi mạng tới backend và 0 thay đổi mã backend trong phạm vi spec này.
2. WHEN bộ kiểm thử chạy sau các thay đổi của spec này, THE Test_Suite SHALL giữ tất cả 102 test hiện có ở trạng thái pass (102 pass, 0 fail, 0 skip mới phát sinh).
3. WHEN một Generator chạy với cùng một bộ `params` trước và sau các thay đổi của spec này, THE Generator SHALL tạo ra hình học đầu ra (panels và allPaths) có cùng số lượng phần tử và cùng thứ tự, trong đó mỗi tọa độ điểm tương ứng lệch không quá 0.001 mm so với đầu ra đúng đắn trước đó.
4. IF một tọa độ điểm bất kỳ giữa đầu ra trước và sau lệch quá 0.001 mm, hoặc số lượng/thứ tự phần tử của panels hoặc allPaths khác nhau, THEN THE Test_Suite SHALL đánh dấu kiểm thử hồi quy hình học là fail và chỉ ra Generator cùng phần tử sai lệch.
5. THE Dieline_System SHALL tiếp tục dùng đúng tập phụ thuộc hiện có (React, Zustand, Three.js, vitest, jsPDF, svg2pdf.js) và SHALL không thêm bất kỳ phụ thuộc mới nào cho mục đích nằm ngoài 6 workstream của Giai đoạn 1.
6. THE Dieline_System SHALL không hiện thực bất kỳ tính năng nào thuộc Giai đoạn 2 (xuất DXF, spot color/layer PDF, xuất AI/SVG, template hộp mới, artwork trên dieline, vật liệu 3D).

## Câu hỏi mở cần quyết định (Open Decisions)

1. **BLEED (Requirement 5):** Chọn phương án (A) sinh biên dạng bleed thực cho các generator, hay (B) gỡ BLEED khỏi chú giải canvas/export? Phương án (B) đơn giản và phù hợp tinh thần "củng cố chất lượng" của Giai đoạn 1; phương án (A) nhiều việc hơn và gần với phạm vi tính năng mới.
2. **dieGap (Requirement 6):** Chỉ sửa tài liệu/chú thích (giữ hành vi), hay coi phép offset polygon thực là hạng mục Giai đoạn 2? Mặc định đề xuất: chỉ sửa tài liệu và ghi chú giới hạn đã biết.
