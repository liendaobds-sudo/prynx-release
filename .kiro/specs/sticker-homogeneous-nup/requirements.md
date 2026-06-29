# Requirements Document

> Tài liệu Yêu cầu — Dàn nhiều mẫu CÙNG KHUÔN (1 khuôn – nhiều nội dung) cho Bình Tem Bế / Bế Rớt

## Introduction

Công cụ **Bình Tem Bế / Bế Rớt** hiện có chế độ **Dàn nhiều mẫu (N-Up trộn loại)** đi qua bin-pack theo **bounding-box** (`solve_auto_fill_mixed`) → kết quả là **lưới**. Cách này đúng cho các mẫu **khác khuôn / khác kích thước**, nhưng **sai** với trường hợp rất phổ biến: **nhiều con tem CÙNG hình dạng, CÙNG khuôn bế, chỉ khác nội dung** (ví dụ số dán áo hình tròn 1–100). Khi đó người dùng cần kiểu xếp **so le / tổ ong** đặc trưng của hình tròn (và shape-aware nesting của các hình khác) để tiết kiệm giấy, chứ không phải lưới.

Đặc thù quy trình của người dùng:
- **Khuôn bế chỉ được đặt trên tem ĐẦU TIÊN (số 1), ở trang đầu** — giống hiện tại — nhằm xác định đúng **hình dạng, kích thước, và TÂM khuôn**, cũng như quan hệ giữa khuôn ↔ nội dung tem.
- **Từ trang 2 trở đi KHÔNG đặt khuôn** lên tem. Vị trí tem trên mỗi trang **có thể lệch nhau** (tem số 2 nằm hơi khác chỗ so với số 1...).
- Nhiệm vụ của tool: **tự dò vị trí thật của tem trên từng trang** rồi **căn (register) về đúng tâm khuôn** khi xếp, để dù các tem lệch vị trí trên trang gốc, khi ráp lên tờ in **đều khít khuôn**.

Tính năng này bổ sung một **chế độ đồng nhất tự động**: khi phát hiện "1 trang có khuôn + các trang còn lại không có khuôn", hệ thống dùng hình học khuôn của trang 1 làm **bản mẫu (master)**, xếp **shape-aware** như tem 1 mẫu, và **rải nội dung các trang vào các ô** theo đúng logic phân bổ của Dàn nhiều mẫu hiện tại.

Tính năng PHẢI giữ **parity preview ↔ output** (dùng chung khâu dựng placement `imposition_finalize` đã thống nhất) và KHÔNG phá vỡ luồng Dàn nhiều mẫu khác-khuôn hiện có.

## Glossary
- **Khuôn master**: đường bế (die/CutContour) đặt trên tem đầu tiên ở trang 1; nguồn sự thật về hình dạng + kích thước trim + footprint (đa giác) + **tâm khuôn**.
- **Tâm khuôn (die center)**: tâm hình học của footprint khuôn master (điểm gốc để căn các tem nội dung).
- **Trang nội dung**: trang 2→N, chỉ chứa artwork tem (không có đường bế).
- **bbox artwork**: hình chữ nhật bao quanh vùng có nội dung/mực thật của tem trên một trang (KHÔNG phải MediaBox/khổ trang).
- **Mốc căn (registration anchor)**: **tâm của bbox artwork** của tem trên một trang nội dung; dùng để dịch tem về trùng tâm khuôn của ô.
- **Chế độ đồng nhất**: chế độ kích hoạt khi đúng 1 trang có khuôn (trang master) và các trang còn lại không có khuôn.
- **Ô (cell)**: một vị trí đặt khuôn trên tờ in, theo layout shape-aware (so le/head-to-tail...).
- **SL/tờ**: số ô vừa trên một tờ in theo layout shape-aware.

---

## Requirements

### Yêu cầu 1 — Tự động phát hiện chế độ đồng nhất

**User Story:** Là người dùng, tôi muốn chỉ đặt khuôn lên tem đầu tiên, các tem sau khỏi đặt khuôn, và tool tự hiểu đây là "1 khuôn – nhiều nội dung" để xếp đúng kiểu so le.

#### Acceptance Criteria
1. WHEN người dùng dùng Bình Tem Bế / Bế Rớt ở chế độ **Dàn nhiều mẫu** với nhiều trang nguồn THEN hệ thống SHALL kiểm tra nhận diện khuôn theo từng trang.
2. IF **đúng một trang** (trang đầu) có khuôn (shape ≠ CUSTOM, có đường bế) **VÀ tất cả trang còn lại không có khuôn** (CUSTOM/không đường bế) THEN hệ thống SHALL kích hoạt **chế độ đồng nhất** (homogeneous).
3. IF có **từ hai trang trở lên** mang khuôn (nhiều khuôn khác nhau) THEN hệ thống SHALL **không** kích hoạt chế độ đồng nhất và SHALL giữ nguyên hành vi bin-pack trộn loại hiện tại.
4. IF **không trang nào** có khuôn THEN hệ thống SHALL giữ nguyên hành vi hiện tại (không kích hoạt chế độ đồng nhất).
5. WHERE chế độ đồng nhất được kích hoạt THE hệ thống SHALL áp dụng đồng nhất ở **cả preview lẫn output** (không lệch).
6. WHERE người dùng cần ghi đè THE hệ thống MAY cung cấp một công tắc bật/tắt thủ công chế độ đồng nhất (mặc định: tự động).

### Yêu cầu 2 — Lấy hình học master từ trang khuôn

**User Story:** Là người dùng, tôi muốn khuôn ở tem số 1 quyết định hình dạng, kích thước và tâm cho toàn bộ tem còn lại.

#### Acceptance Criteria
1. WHEN chế độ đồng nhất kích hoạt THEN hệ thống SHALL lấy từ trang khuôn (master): **loại hình (shapeType)**, **kích thước trim**, **footprint (đa giác poly)**, và **tâm khuôn**.
2. THE hệ thống SHALL dùng hình học master này cho TẤT CẢ các ô khi xếp (mọi tem dùng chung 1 khuôn).
3. THE layout shape-aware (so le/tổ ong/head-to-tail/collision) SHALL được tính từ hình học master, KHÔNG từ bounding-box.
4. IF trang master không dò được khuôn hợp lệ (lỗi nhận diện) THEN hệ thống SHALL fallback về bin-pack trộn loại và thông báo lý do, không làm sập job.

### Yêu cầu 3 — Dò vị trí & căn tem nội dung về tâm khuôn (Registration)

**User Story:** Là người dùng, dù các tem số nằm lệch vị trí trên trang, tôi muốn khi xếp chúng đều khít vào khuôn.

#### Acceptance Criteria
1. WHEN xử lý một trang nội dung (2→N) THEN hệ thống SHALL xác định **bbox artwork** (vùng có mực/nội dung thật) của tem trên trang đó.
2. THE **mốc căn** của trang nội dung SHALL là **tâm bbox artwork** của tem đó.
3. WHEN đặt một tem nội dung vào một ô THEN hệ thống SHALL dịch nội dung sao cho **mốc căn trùng với tâm khuôn của ô**.
4. THE nội dung sau khi căn SHALL được cắt/áp theo đúng **footprint khuôn master** của ô (cùng đường bế).
5. WHERE trang nội dung trống / không có mực THE hệ thống SHALL coi tem đó là rỗng-an-toàn (bỏ qua hoặc để trống ô) và không làm sập job.
6. THE việc dò vị trí và căn SHALL độc lập với vị trí tuyệt đối của tem trên trang gốc (chịu được lệch vị trí giữa các trang).

### Yêu cầu 4 — Co cho khít khi kích thước lệch

**User Story:** Là người dùng, nếu một tem nội dung lỡ to/nhỏ hơn khuôn một chút, tôi muốn nó được co cho khít khuôn thay vì tràn hoặc hụt.

#### Acceptance Criteria
1. WHEN kích thước artwork của một tem nội dung **khác** kích thước khuôn master THEN hệ thống SHALL **co/giãn (scale) nội dung cho khít** footprint khuôn (theo tâm khuôn).
2. THE phép co SHALL giữ **đúng tỉ lệ** (uniform scale) để không méo hình; căn tâm sau khi co.
3. WHERE độ lệch kích thước vượt một ngưỡng bất thường (vd > 20%) THE hệ thống MAY ghi cảnh báo để người dùng kiểm tra, nhưng vẫn co cho khít.

### Yêu cầu 5 — Xếp shape-aware thay vì lưới

**User Story:** Là người dùng, tôi muốn tem tròn (và các hình khác) khi dàn nhiều mẫu cùng khuôn được xếp **so le** như khi bình 1 mẫu, để tiết kiệm giấy.

#### Acceptance Criteria
1. WHEN chế độ đồng nhất kích hoạt THEN hệ thống SHALL tính layout bằng đường shape-aware (như bình 1 mẫu: `compute_sticker_layout_for_page` của trang master), KHÔNG dùng `solve_auto_fill_mixed`.
2. THE layout SHALL giữ đúng đặc trưng theo hình: **so le/tổ ong** cho tròn/elip, **head-to-tail** cho búa/tạ, và các kiểu tương ứng cho hình khác — đồng nhất với bình 1 mẫu cùng hình.
3. THE số ô mỗi tờ (SL/tờ) SHALL bằng số ô của layout shape-aware đó.
4. THE chiến lược xếp (tự động/đầu-đuôi/so le/lưới...) người dùng đang chọn SHALL được tôn trọng như ở bình 1 mẫu.

### Yêu cầu 6 — Phân bổ nội dung & nhiều tờ

**User Story:** Là người dùng, tôi muốn nội dung (số 1→100) được rải vào các ô và tự sang tờ mới khi hết ô, với cách tính số lượng giống Dàn nhiều mẫu hiện tại.

#### Acceptance Criteria
1. THE việc phân bổ số lượng/nội dung giữa các trang SHALL theo **cùng logic của Dàn nhiều mẫu hiện tại** (theo số lượng nhập mỗi trang, hoặc tự lấp đầy khi không nhập).
2. WHEN số nội dung nhiều hơn số ô trên một tờ THEN hệ thống SHALL **cuốn chiếu sang tờ tiếp theo** (tờ 1 chứa nội dung 1→C, tờ 2 chứa C+1→…, với C = SL/tờ).
3. THE thứ tự rải nội dung vào các ô SHALL theo **thứ tự trang nguồn** (1→N), ánh xạ ổn định, tất định (cùng input → cùng kết quả).
4. THE mỗi ô SHALL hiển thị/đặt đúng nội dung của trang được gán cho ô đó (đúng số trên đúng vị trí).

### Yêu cầu 7 — Parity Preview ↔ Output

**User Story:** Là người dùng, tôi muốn bản xem trước (preview) khớp 100% với file xuất ra ở chế độ này.

#### Acceptance Criteria
1. THE preview và output SHALL dùng **chung một khâu dựng placement** (`imposition_finalize`) cho chế độ đồng nhất.
2. THE vị trí, kích thước, hướng xoay, kết quả căn khuôn, và việc gán nội dung của từng ô trong preview SHALL khớp output trong dung sai (≤ 0.1 mm vị trí/kích thước, ≤ 0.01° góc).
3. WHEN có boong/pont (vùng cấm) THE việc xử lý va chạm & dịch chuyển SHALL giống nhau giữa preview và output.

### Yêu cầu 8 — Không phá vỡ luồng hiện có & cô lập lỗi

**User Story:** Là người dùng, tôi muốn tính năng mới không làm hỏng các chế độ đang chạy đúng (bình 1 mẫu, dàn nhiều mẫu khác khuôn, CNC...).

#### Acceptance Criteria
1. THE chế độ đồng nhất SHALL chỉ kích hoạt khi đúng điều kiện ở Yêu cầu 1; mọi trường hợp khác SHALL giữ nguyên hành vi cũ.
2. IF bất kỳ bước nào của chế độ đồng nhất lỗi (dò khuôn/căn/co) THEN hệ thống SHALL fallback an toàn về bin-pack trộn loại và báo lý do, KHÔNG làm sập toàn bộ job.
3. THE bình 1 mẫu, dàn nhiều mẫu khác-khuôn, CNC bế rớt, và bình bài xén SHALL không đổi hành vi sau khi thêm tính năng này.

### Yêu cầu 9 — Hiệu năng (phi chức năng)

**User Story:** Là người dùng, tôi muốn chế độ này không chậm hơn đáng kể so với bình trang, dù phải dò vị trí từng tem.

#### Acceptance Criteria
1. THE layout shape-aware SHALL được tính **một lần** từ khuôn master và dùng chung cho mọi ô/tờ (không tính lại theo từng trang).
2. THE việc dò bbox artwork SHALL **ưu tiên đường VECTOR/native** (content-stream / TrimBox), CHỈ raster ở **DPI thấp** khi artwork không phải vector.
3. THE bước dò bbox + căn SHALL **tận dụng đa tiến trình theo chunk** sẵn có của engine và **không mở lại trang nguồn dư thừa** (gắn vào vòng lặp đặt artwork hiện hữu).
4. WHILE xem trước (preview) THE hệ thống SHALL chỉ dò bbox cho các trang **hiển thị trên tờ đang xem**, không phải toàn bộ N trang.
5. THE chế độ đồng nhất SHALL có **benchmark** đối chiếu thời gian với Bình trang và Dàn nhiều mẫu trên cùng bộ tem để xác nhận không có regression bất thường.

---

## Phạm vi (Scope) & Ghi chú
- **Trong phạm vi:** chế độ đồng nhất cho Bình Tem Bế / Bế Rớt (die-cut), mọi shape mà bình-1-mẫu hỗ trợ (tròn/elip/chữ nhật/búa/tạ/thang/bình hành/đa giác/đặc biệt).
- **Ngoài phạm vi:** trộn nhiều khuôn khác nhau (giữ bin-pack cũ); thay đổi thuật toán nesting của bình-1-mẫu (tái dùng nguyên trạng).
- **Phụ thuộc:** tái dùng `compute_sticker_layout_for_page` (nesting), `imposition_finalize` (placement SSOT, parity), và đường nhận diện khuôn (`die_detection`).
