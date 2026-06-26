# Requirements Document

## Introduction

Đây là spec **Giai đoạn 2 (Phase 2)** của sáng kiến **củng cố chất lượng** module tạo khuôn bế (dieline) phía client tại `desktop/src/lib/dieline/`. Spec này xử lý **đúng hai giới hạn đã biết** được Giai đoạn 1 (`dieline-hardening`) cố ý dời sang Giai đoạn 2:

1. **Trích xuất biên ngoài (outer silhouette) cho cổng kiểm tra biên dạng khép kín khi xuất.** Giai đoạn 1 định nghĩa `Cut_Piece` là một thành phần liên thông của tất cả đoạn CUT/BLEED (crease-aware closure) và xử lý đúng 5/8 generator. Ba generator còn lại — `rte` (ReverseTuckEnd), `slb` (SnapLockBottom), `envelope` (Envelope) — CỐ Ý chứa đặc trưng cắt hở nội bộ (rãnh gài/relief slit của lưỡi đút kết thúc giữa vật liệu; vết cắt ngón thumb-cut dạng cung trên nắp bì thư). Validator hiện tại báo các đặc trưng nội bộ hợp lệ này là "biên dạng hở", khiến cổng xuất (`downloadPDF` trong `exportPDF.ts`) hỏi xác nhận trên MỌI lần xuất ba loại hộp đó — một cảnh báo giả (false alarm). Giai đoạn 2 trích xuất **biên ngoài cùng (outer silhouette)** của mỗi `Cut_Piece` và chỉ kiểm tra tính khép kín trên biên ngoài đó, bỏ qua các vết cắt relief/thumb hợp lệ bên trong.

2. **Phép offset polygon thực (true polygon offset) cho `dieGap` trong nesting engine.** Giai đoạn 1 chỉ sửa JSDoc của `dieGap` trong `nestingTypes.ts`; `nestingEngine.ts` thực thi vẫn coi `dieGap` là khoảng hở giữa các **bounding box** của hai khuôn liền kề, KHÔNG phải offset polygon thực. Giai đoạn 2 hiện thực offset polygon thực — đẩy đường biên (outline) thực của mỗi khuôn ra ngoài theo từng cạnh một lượng bằng `dieGap`, cho phép lồng khuôn sát hơn và đúng hình dạng thay vì giãn cách theo hình chữ nhật.

Mục tiêu chất lượng tổng thể: loại bỏ cảnh báo giả khi xuất ba loại hộp rte/slb/envelope (mà vẫn phát hiện đúng biên ngoài thực sự hở), và cho phép lồng khuôn sát theo hình dạng thực — **mà không** thay đổi hình học đầu ra đúng đắn của 8 generator và **không** làm hỏng 503 test đang pass.

Toàn bộ thay đổi chạy ở phía client bằng TypeScript thuần (React + Zustand + Three.js). Test dùng `vitest` + `fast-check` (đã thiết lập từ Giai đoạn 1). Không có lời gọi mạng và không thay đổi backend.

### Phạm vi (In Scope)

- **Workstream A — Outer Silhouette:** `desktop/src/lib/dieline/contourValidator.ts`, tái dùng `tracePerimeter.ts`/`sharedGeometry.ts`, và cổng xuất `downloadPDF` trong `exportPDF.ts`.
- **Workstream B — Polygon Offset:** `desktop/src/lib/dieline/nestingEngine.ts` và `nestingTypes.ts` (chú thích `dieGap`).
- 8 generator hiện có (ReverseTuckEnd, SnapLockBottom, GableBox, PaperBag, CupSleeve, PizzaBox, Envelope, MatchboxTray/Sleeve) — chỉ với tư cách nguồn dữ liệu đầu vào để kiểm tra/lồng khuôn, KHÔNG sửa hình học của chúng.

### Ngoài phạm vi (Out of Scope)

- Thay đổi hình học đầu ra của bất kỳ generator nào (Giai đoạn 1 Requirement 7.3 / golden-master phải tiếp tục pass).
- Hạng mục Giai đoạn 2 KHÔNG thuộc hai workstream này: xuất DXF, spot color/layer PDF, xuất AI/SVG, template hộp mới, đặt artwork lên dieline, vật liệu 3D.
- Mọi thay đổi backend.

### Ranh giới giữa hai Workstream

Hai workstream **độc lập** về mã và dữ liệu: Workstream A chỉ động đến đường kiểm tra biên dạng/cổng xuất; Workstream B chỉ động đến thuật toán lồng khuôn. Chúng chia sẻ duy nhất khái niệm "đường biên ngoài của một khuôn" (outline polygon). Một thay đổi ở workstream này KHÔNG được làm thay đổi hành vi quan sát được của workstream kia.

## Glossary

Các thuật ngữ kế thừa từ Giai đoạn 1 giữ nguyên nghĩa. Thuật ngữ mới của Giai đoạn 2 được đánh dấu (mới).

- **Dieline_System**: Toàn bộ module tạo khuôn bế phía client tại `desktop/src/lib/dieline/`.
- **Generator**: Một trong 8 hàm sinh khuôn bế tạo ra một `DielineModel`.
- **DielineModel**: Mô hình khuôn bế gồm `panels`, `allPaths`, `boundingBox`, `params`, `warnings`.
- **Panel**: Một mặt phẳng trong khuôn bế, gồm danh sách `PathSegment`, có trường tùy chọn `outline: Point2D[]` (đường viền ngoài khép kín).
- **PathSegment**: Đoạn đường gồm `points`, `tag` (CUT/CREASE/BLEED), `type` (line/arc/bezier).
- **PathTag**: Nhãn loại nét: `CUT`, `CREASE`, `BLEED`.
- **Cut_Piece**: Một mảnh được cắt rời, định nghĩa (Giai đoạn 1) là một THÀNH PHẦN LIÊN THÔNG của hợp tất cả đoạn `CUT`/`BLEED` trên toàn model theo endpoint trùng trong `Snap_Tolerance`.
- **Closed_Contour**: Biên dạng khép kín, trong đó điểm đầu chuỗi và điểm cuối chuỗi trùng nhau trong dung sai cho phép.
- **Contour_Validator**: Thành phần `validateClosedContours` trong `contourValidator.ts` kiểm tra tính khép kín trước khi xuất.
- **Trace_Perimeter**: Hàm `tracePerimeter` trong `tracePerimeter.ts`, nối các đoạn (đã lọc CREASE) thành chuỗi đỉnh chu vi và lọc điểm thẳng hàng.
- **Outer_Silhouette** (mới): Biên ngoài cùng (đường bao ngoài) của một `Cut_Piece` — vòng kín bao quanh toàn bộ phần vật liệu của mảnh, KHÔNG bao gồm các đặc trưng cắt hở nội bộ (relief slit, thumb-cut) nằm bên trong vòng bao đó.
- **Interior_Cut_Feature** (mới): Một đặc trưng cắt hở CỐ Ý nằm bên trong `Outer_Silhouette` của một `Cut_Piece` — gồm rãnh gài/relief slit của lưỡi đút (rte/slb) và vết cắt ngón thumb-cut dạng cung trên nắp bì thư (envelope) — kết thúc giữa vật liệu và KHÔNG thuộc biên ngoài.
- **Open_Outer_Boundary** (mới): Trạng thái khi `Outer_Silhouette` của một `Cut_Piece` thực sự không khép kín (khoảng hở đầu-cuối của vòng bao ngoài > `Snap_Tolerance`) — đây là lỗi thật cần cảnh báo khi xuất.
- **Snap_Tolerance**: Dung sai khớp endpoint khi nối chuỗi và phân loại khép kín = `SNAP_TOLERANCE` = 0,01 mm (định nghĩa trong `sharedGeometry.ts`).
- **Export_Module**: Module xuất file tại `exportPDF.ts`; cổng kiểm tra là hàm `downloadPDF`.
- **Nesting_Engine**: Module `nestingEngine.ts` xếp khuôn vào khổ in (`calculateNesting`).
- **Die_Outline** (mới): Đường biên ngoài thực (polygon) của một khuôn dùng làm đầu vào lồng khuôn — tức `Outer_Silhouette` của khuôn được biểu diễn dưới dạng dãy đỉnh khép kín; nếu không sẵn có thì suy ra từ `boundingBox` (đa giác chữ nhật).
- **Die_Gap**: Tham số `dieGap` trong `nestingTypes.ts` — khoảng hở dao bế giữa hai khuôn liền kề (mm).
- **Polygon_Offset** (mới): Phép đẩy mọi cạnh của một `Die_Outline` ra ngoài theo pháp tuyến một lượng `offset = dieGap`, tạo ra một đa giác bao lớn hơn dùng để kiểm tra va chạm khi lồng khuôn (Minkowski-style outward offset).
- **Bounding_Box_Gap** (mới): Hành vi `dieGap` của Giai đoạn 1 — khoảng hở giữa các hình chữ nhật bao (bounding box) của hai khuôn liền kề.
- **Test_Suite**: Bộ kiểm thử hiện có (503 test đang pass), dùng `vitest` + `fast-check`.

---

## Requirements

> **Workstream A — Trích xuất biên ngoài (Outer Silhouette)** — Requirement 1 đến 4.

### Requirement 1: Trích xuất biên ngoài của mỗi Cut_Piece

**User Story:** Là một kỹ thuật viên chế bản, tôi muốn hệ thống xác định đường bao ngoài cùng của mỗi mảnh cắt, để việc kiểm tra khép kín dựa trên biên ngoài thực thay vì các vết cắt nội bộ hợp lệ.

#### Acceptance Criteria

1. WHEN Contour_Validator xử lý một Cut_Piece, THE Contour_Validator SHALL trích xuất một Outer_Silhouette được định nghĩa là vòng kín có DIỆN TÍCH BAO LỚN NHẤT chứa trọn mọi đỉnh `CUT`/`BLEED` còn lại của Cut_Piece đó trong dung sai Snap_Tolerance (0,01 mm).
2. WHERE hàm Trace_Perimeter đã cung cấp khả năng nối các đoạn cắt thành chu vi ngoài, THE Contour_Validator SHALL tái sử dụng Trace_Perimeter để trích xuất Outer_Silhouette và SHALL không hiện thực một thuật toán nối chuỗi (chaining) thứ hai.
3. WHEN một Cut_Piece chứa một hoặc nhiều Interior_Cut_Feature, THE Contour_Validator SHALL loại các Interior_Cut_Feature đó khỏi Outer_Silhouette sao cho chúng không bị tính là đầu cắt hở của biên ngoài, trong đó một Interior_Cut_Feature được nhận diện theo quy tắc khách quan: có đầu mút KHÔNG nằm trên Outer_Silhouette trong dung sai Snap_Tolerance (0,01 mm) VÀ nằm bên trong vùng diện tích mà Outer_Silhouette bao quanh.
4. THE Contour_Validator SHALL phân loại một đầu mút của Cut_Piece là thuộc Outer_Silhouette chỉ khi đầu mút đó nằm trên vòng bao ngoài cùng được Trace_Perimeter trả về, trong dung sai Snap_Tolerance (0,01 mm).
5. IF một Cut_Piece chỉ gồm các đoạn `CREASE` (không có đoạn `CUT`/`BLEED` nào), THEN THE Contour_Validator SHALL coi Cut_Piece đó không có Outer_Silhouette cần kiểm tra và SHALL không tạo cảnh báo biên hở cho nó.
6. IF Trace_Perimeter không thể khép kín vòng ngoài của một Cut_Piece (chuỗi đỉnh hở), THEN THE Contour_Validator SHALL trích xuất Outer_Silhouette một cách xác định dưới dạng chuỗi đỉnh hở và SHALL giữ lại khoảng hở đầu-cuối đo được tính bằng mm để dùng cho phép kiểm tra khép kín ở Requirement 2.

### Requirement 2: Kiểm tra khép kín chỉ trên biên ngoài

**User Story:** Là một kỹ thuật viên chế bản, tôi muốn cổng kiểm tra chỉ đánh giá tính khép kín của biên ngoài, để các rãnh gài và vết cắt ngón hợp lệ không bị báo nhầm là lỗi.

#### Acceptance Criteria

1. WHEN một thao tác xuất file được yêu cầu cho một DielineModel, THE Contour_Validator SHALL xác định mỗi Cut_Piece là khép kín hay hở dựa TRÊN Outer_Silhouette của nó, trong đó "khoảng hở đầu-cuối" được định nghĩa là khoảng cách Euclid tính bằng mm giữa đỉnh đầu tiên và đỉnh cuối cùng của Outer_Silhouette do Trace_Perimeter trả về; khoảng hở đầu-cuối ≤ Snap_Tolerance (0,01 mm) là khép kín, > Snap_Tolerance (0,01 mm) là hở, và giá trị đúng bằng Snap_Tolerance được coi là khép kín.
2. WHILE một Cut_Piece có Outer_Silhouette khép kín (khoảng hở đầu-cuối ≤ Snap_Tolerance) nhưng vẫn chứa Interior_Cut_Feature hở, THE Contour_Validator SHALL phân loại Cut_Piece đó là khép kín và SHALL không tạo cảnh báo biên hở.
3. IF Outer_Silhouette của một Cut_Piece có khoảng hở đầu-cuối > Snap_Tolerance (Open_Outer_Boundary), THEN THE Contour_Validator SHALL tạo một cảnh báo xác định Panel đại diện và Cut_Piece chứa biên ngoài hở, kèm khoảng hở đo được `gapMm` tính bằng mm; Panel đại diện được xác định một cách xác định là Panel chứa nhiều đoạn `CUT`/`BLEED` của Outer_Silhouette đó nhất, và khi đồng hạng thì chọn Panel có chỉ số (index) thấp nhất.
4. THE Contour_Validator SHALL dùng cùng giá trị Snap_Tolerance (0,01 mm) khi phân loại khép kín như giá trị mà logic nối chuỗi dùng chung (`sharedGeometry`) sử dụng.
5. WHEN cùng một DielineModel được đánh giá lặp lại nhiều lần, THE Contour_Validator SHALL cho ra phân loại và cảnh báo giống hệt nhau (cùng Cut_Piece, cùng Panel đại diện, và cùng `gapMm` trong dung sai 0,001 mm) — tính xác định (deterministic).

### Requirement 3: Loại bỏ cảnh báo giả cho rte/slb/envelope, giữ phát hiện lỗi thật

**User Story:** Là một người dùng tạo khuôn bế các loại hộp rte/slb/envelope, tôi muốn xuất file không bị hỏi xác nhận giả, nhưng vẫn được cảnh báo khi biên ngoài thực sự hở.

#### Acceptance Criteria

1. WHEN một DielineModel của generator `rte`, `slb` hoặc `envelope` có mọi Cut_Piece khép kín (khoảng hở đầu-cuối của Outer_Silhouette ≤ Snap_Tolerance 0,01 mm) được yêu cầu xuất, THE Export_Module SHALL tiến hành tạo file mà không yêu cầu xác nhận biên hở.
2. WHEN tất cả Cut_Piece của một DielineModel có Outer_Silhouette khép kín, THE Export_Module SHALL tạo file và trả về một kết quả "file created" quan sát được mà không hiển thị cảnh báo biên hở (bảo toàn hành vi cổng xuất Giai đoạn 1 cho trường hợp không có lỗi).
3. IF ít nhất một Cut_Piece có Open_Outer_Boundary, THEN THE Export_Module SHALL hiển thị cảnh báo liệt kê Panel và khoảng hở, VÀ SHALL không tạo file cho đến khi người dùng xác nhận tường minh qua callback `confirmOpenContours` trả về `true` (bảo toàn hành vi cổng xuất Giai đoạn 1 cho trường hợp lỗi thật).
4. WHEN một Cut_Piece có Open_Outer_Boundary được tạo bằng cách dịch chuyển một đầu mút của Outer_Silhouette một lượng `d > Snap_Tolerance`, THE Contour_Validator SHALL báo Cut_Piece đó là hở với `gapMm` thỏa `|gapMm − d| ≤ 0,01 mm`.
5. WHERE giao diện xuất truyền callback xác nhận `confirmOpenContours`, THE Export_Module SHALL chỉ ghi file khi callback trả về `true`; WHERE không có callback, THE Export_Module SHALL không ghi file khi tồn tại Open_Outer_Boundary.
6. IF người dùng từ chối/hủy xác nhận khi tồn tại Open_Outer_Boundary (callback `confirmOpenContours` trả về `false`, hoặc không có callback), THEN THE Export_Module SHALL không tạo bất kỳ đầu ra nào (không ghi file một phần), SHALL giữ nguyên trạng thái model (`panels`, `allPaths`, `params`) không đổi, và SHALL trả về một chỉ báo kết quả "đã hủy" (cancelled).

### Requirement 4: Không thay đổi hình học generator (Workstream A)

**User Story:** Là một lập trình viên bảo trì module dieline, tôi muốn việc trích xuất biên ngoài không làm thay đổi hình học của bất kỳ generator nào, để các test golden-master Giai đoạn 1 tiếp tục pass.

#### Acceptance Criteria

1. THE Dieline_System SHALL giữ nguyên đầu ra `panels` và `allPaths` của cả 8 Generator so với ảnh chụp golden-master đã ghi nhận (baseline) trong phạm vi tham số generator mặc định, sao cho mỗi PathSegment giữ bất biến `tag`, `type` và số lượng điểm, và mỗi tọa độ lệch ≤ 0,001 mm so với baseline.
2. WHEN logic trích xuất Outer_Silhouette chạy, THE Contour_Validator SHALL chỉ đọc dữ liệu hình học của model và SHALL không biến đổi (mutate) `panels`, `allPaths`, `params`, `boundingBox` hay `warnings`, và SHALL không ghi vào `Panel.outline` (Outer_Silhouette được tính như một cấu trúc riêng biệt).
3. THE Dieline_System SHALL giữ chữ ký công khai (public signature) của `validateClosedContours` và `downloadPDF` tương thích ngược một cách đo được: giữ nguyên số lượng và kiểu của tham số bắt buộc cùng kiểu trả về, chỉ cho phép thêm tham số tùy chọn (optional) mới, phát sinh 0 lỗi TypeScript mới, và không cần sửa mã gọi hiện có.
4. THE Dieline_System SHALL ràng buộc tính bất biến hình học vào việc vượt qua (pass) toàn bộ test golden-master cho cả 8 Generator.

---

> **Workstream B — Phép offset polygon thực cho dieGap** — Requirement 5 đến 8.

### Requirement 5: Hiện thực phép offset polygon thực

**User Story:** Là một người dùng bình bản, tôi muốn `dieGap` đẩy đường biên thực của khuôn ra ngoài theo từng cạnh, để khuôn được lồng sát theo hình dạng thay vì giãn cách theo hình chữ nhật.

#### Acceptance Criteria

1. THE Nesting_Engine SHALL tính một Die_Outline cho mỗi khuôn, dùng Outer_Silhouette của khuôn khi Outer_Silhouette "sẵn có" — định nghĩa là có ≥ 3 đỉnh, diện tích bao > 0, và khoảng hở đầu-cuối ≤ Snap_Tolerance (0,01 mm) — hoặc dùng đa giác chữ nhật suy ra từ `boundingBox` làm phương án dự phòng khi Outer_Silhouette không sẵn có.
2. WHEN calculateNesting tính kết quả lồng khuôn, THE Nesting_Engine SHALL áp dụng Polygon_Offset đẩy mỗi cạnh của Die_Outline ra ngoài theo pháp tuyến hướng ra xa phần bên trong (hướng làm tăng diện tích) một lượng bằng `dieGap`.
3. THE Nesting_Engine SHALL xác định hai khuôn liền kề là không va chạm khi và chỉ khi các Die_Outline đã offset của chúng không chồng lấn (diện tích giao ≤ 0,01 mm²).
4. WHEN khoảng cách nhỏ nhất giữa hai Die_Outline gốc (chưa offset) của hai khuôn liền kề được đo, THE Nesting_Engine SHALL bảo đảm khoảng cách đó ≥ `dieGap` trừ dung sai 0,01 mm cho mọi cặp khuôn được đặt.
5. WHERE `dieGap = 0`, THE Nesting_Engine SHALL cho phép các Die_Outline tiếp xúc biên chung mà không chồng lấn (diện tích giao ≤ 0,01 mm²).
6. IF một Die_Outline lõm (non-convex) khiến phép offset tạo tự cắt (self-intersection) cục bộ, THEN THE Nesting_Engine SHALL tạo ra một đa giác offset không tự cắt bao trọn Die_Outline gốc đã giãn `dieGap` sao cho mọi đỉnh của Die_Outline gốc nằm bên trong hoặc trên biên đa giác offset (không để lọt vùng va chạm).
7. IF `dieGap < 0`, THEN THE Nesting_Engine SHALL kẹp (clamp) giá trị offset về 0 và SHALL không thu nhỏ Die_Outline gốc.

### Requirement 6: Tính đúng đắn và dung sai của phép offset

**User Story:** Là một lập trình viên, tôi muốn phép offset có hành vi toán học xác định và dung sai rõ ràng, để kết quả lồng khuôn ổn định và kiểm thử được.

#### Acceptance Criteria

1. WHEN Polygon_Offset áp dụng lên một Die_Outline hợp lệ với `offset = dieGap` và `dieGap ≥ 0`, THE Nesting_Engine SHALL tạo ra một đa giác offset sao cho mọi điểm của Die_Outline gốc nằm bên trong đa giác offset hoặc trên biên của nó, với sai lệch về phía ngoài biên không vượt quá Snap_Tolerance (0,01 mm).
2. WHEN `dieGap ≥ 0` và Die_Outline có diện tích > 0, THE Nesting_Engine SHALL bảo đảm diện tích đa giác offset ≥ diện tích Die_Outline gốc; WHERE `dieGap = 0`, diện tích đa giác offset SHALL bằng diện tích Die_Outline gốc trong dung sai 0,001 mm².
3. WHEN cùng một Die_Outline (cùng dãy đỉnh, cùng thứ tự) và cùng giá trị `dieGap` được offset hai lần, THE Nesting_Engine SHALL tạo ra đa giác offset có cùng số đỉnh, cùng thứ tự đỉnh, và mỗi tọa độ tương ứng trùng khít (lệch 0 mm, bit-identical).
4. WHERE Die_Outline là một hình chữ nhật và `dieGap ≥ 0`, THE Nesting_Engine SHALL tạo ra đa giác offset là hình chữ nhật có mỗi cạnh dịch ra ngoài đúng `dieGap` (mỗi chiều tăng `2 × dieGap`) trong dung sai 0,001 mm.
5. THE Nesting_Engine SHALL biểu diễn mọi tọa độ của đa giác offset bằng cùng đơn vị mm như tọa độ Die_Outline đầu vào.
6. THE Nesting_Engine SHALL snap mọi tọa độ của đa giác offset theo cùng quy ước snap của Nesting_Engine với bước Snap_Tolerance (0,01 mm), sao cho kết quả tuân thủ tính xác định nêu ở tiêu chí 3.
7. IF một Die_Outline không hợp lệ để offset (ít hơn 3 đỉnh phân biệt hoặc diện tích ≤ 0,001 mm²), THEN THE Nesting_Engine SHALL không tạo đa giác offset từ Die_Outline đó và SHALL dùng đa giác chữ nhật suy ra từ `boundingBox` làm đầu vào offset thay thế.
8. IF `dieGap < 0`, THEN THE Nesting_Engine SHALL coi giá trị offset bằng 0 và SHALL không thu nhỏ Die_Outline gốc (không tạo offset âm).

### Requirement 7: Lồng khuôn sát theo hình dạng (shape-accurate nesting)

**User Story:** Là một người dùng bình bản, tôi muốn khuôn không-chữ-nhật được lồng sát hơn nhờ offset theo hình dạng, để tận dụng diện tích tờ in tốt hơn.

#### Acceptance Criteria

1. WHEN một khuôn có Die_Outline không-chữ-nhật được lồng bằng Polygon_Offset, THE Nesting_Engine SHALL đặt được số khuôn trên một tờ ≥ số khuôn đặt được bằng Bounding_Box_Gap, khi giữ nguyên cùng cấu hình (cùng khổ in, cùng lề, cùng cắn nhíp, cùng giá trị `dieGap`, và cùng tập góc xoay cho phép).
2. WHEN tính kết quả lồng, THE Nesting_Engine SHALL bảo đảm không có hai khuôn nào đặt sao cho Die_Outline đã offset của chúng chồng lấn (diện tích giao ≤ 0,01 mm²).
3. THE Nesting_Engine SHALL bảo đảm mọi khuôn được đặt nằm hoàn toàn trong vùng in khả dụng (vùng còn lại của khổ in sau khi trừ lề và cắn nhíp), sao cho không có điểm nào của Die_Outline vượt ra ngoài biên vùng in khả dụng quá 0,01 mm.
4. WHERE chế độ lồng khuôn cho phép xoay khuôn, THE Nesting_Engine SHALL áp dụng Polygon_Offset SAU khi xoay Die_Outline tới mỗi góc trong tập {0°, 90°, 180°, 270°}, dùng cùng một giá trị `offset = dieGap` cho mọi góc.
5. IF một góc xoay yêu cầu nằm ngoài tập {0°, 90°, 180°, 270°}, THEN THE Nesting_Engine SHALL không đặt khuôn ở góc đó và SHALL chỉ xét các góc thuộc tập được hỗ trợ.

### Requirement 8: Tương thích ngược và không hồi quy nesting

**User Story:** Là chủ sở hữu sản phẩm, tôi muốn việc thêm offset polygon không phá vỡ các kết quả lồng khuôn và test hiện có một cách ngoài ý muốn, để thay đổi an toàn và có kiểm soát.

#### Acceptance Criteria

1. WHEN Die_Outline của mọi khuôn là hình chữ nhật, THE Nesting_Engine SHALL tạo ra kết quả lồng khuôn tương đương với hành vi Bounding_Box_Gap của Giai đoạn 1, trong đó "tương đương" nghĩa là cùng tập khuôn trên cùng khổ in, mỗi khuôn ở cùng vị trí trong dung sai 0,001 mm, và cùng góc xoay thuộc {0°, 90°, 180°, 270°}.
2. IF một test lồng khuôn hiện có thay đổi kết quả do offset polygon thực, THEN THE Test_Suite SHALL cập nhật test đó một cách tường minh (intentional update) kèm giá trị kỳ vọng mới, và SHALL không che giấu thay đổi bằng cách nới lỏng các dung sai đã ghim (0,001 mm cho vị trí và 0,01 mm² cho chồng lấn).
3. WHEN Die_Outline của mọi khuôn là hình chữ nhật, THE Dieline_System SHALL cập nhật chú thích `dieGap` trong `nestingTypes.ts` để phản ánh rằng `dieGap` nay là Polygon_Offset thực theo từng cạnh, và SHALL gỡ bỏ ghi chú "known limitation Giai đoạn 2" liên quan đến offset polygon khỏi `nestingTypes.ts`.
4. THE Nesting_Engine SHALL giữ chữ ký công khai của `calculateNesting` và các kiểu trong `nestingTypes.ts` tương thích ngược một cách quan sát được: không gỡ bỏ hoặc đổi tên tham số/trường công khai hiện có, không thêm tham số/trường bắt buộc mới, và mã gọi hiện có biên dịch và chạy không đổi.
5. WHEN cùng một đầu vào lồng khuôn được tính lặp lại, THE Nesting_Engine SHALL tạo ra kết quả lồng khuôn đầy đủ giống hệt nhau (deterministic) để so sánh hồi quy có thể tái lập.

---

> **Ràng buộc chung (Cross-Cutting Constraints)** — Requirement 9.

### Requirement 9: Không hồi quy toàn cục và ràng buộc kỹ thuật

**User Story:** Là chủ sở hữu sản phẩm, tôi muốn cả hai workstream giữ nguyên nền tảng kỹ thuật và bộ test hiện có, để chất lượng Giai đoạn 1 không bị thoái lui.

#### Acceptance Criteria

1. WHEN bộ kiểm thử chạy một lần đầy đủ ở chế độ không-watch (single non-watch full run) sau các thay đổi của spec này, THE Test_Suite SHALL giữ đúng 503 test hiện có ở trạng thái pass, ngoại trừ các test lồng khuôn được cập nhật tường minh theo Requirement 8.2 (0 fail, 0 skip mới phát sinh), và các lần chạy lặp lại SHALL cho ra kết quả pass/fail giống hệt nhau (deterministic, tái lập được).
2. THE Dieline_System SHALL giữ toàn bộ logic ở phía client bằng TypeScript thuần, với 0 lời gọi mạng và 0 thay đổi mã backend.
3. THE Dieline_System SHALL tiếp tục dùng đúng tập phụ thuộc hiện có (React, Zustand, Three.js, vitest, fast-check, jsPDF, svg2pdf.js) và SHALL không thêm phụ thuộc mới cho mục đích nằm ngoài hai workstream của Giai đoạn 2.
4. WHERE một thuộc tính hình học của hai workstream thay đổi theo đầu vào — gồm phân loại khép kín của Outer_Silhouette, tính bao trọn outline gốc của Polygon_Offset, và tính không chồng lấn của các Die_Outline đã offset — THE Test_Suite SHALL kiểm tra thuộc tính đó bằng property-based test (`fast-check`) với tối thiểu 100 mẫu sinh ngẫu nhiên hợp lệ cho mỗi thuộc tính và với một seed fast-check cố định/được ghi nhận.
5. IF một property-based test phát hiện vi phạm (biên ngoài bị phân loại sai, offset không bao trọn outline gốc, hoặc khuôn chồng lấn với diện tích giao > 0,01 mm²), THEN THE Test_Suite SHALL báo fail và xác định trong thông báo lỗi generator/khuôn cùng phản ví dụ tối giản đã được thu nhỏ (shrunk counterexample) và seed tái lập.
6. THE Dieline_System SHALL không hiện thực bất kỳ tính năng Giai đoạn 2 nào nằm ngoài hai workstream (xuất DXF, spot color/layer PDF, xuất AI/SVG, template hộp mới, artwork trên dieline, vật liệu 3D).
