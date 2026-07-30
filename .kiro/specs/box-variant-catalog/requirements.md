# Requirements Document

> Tài liệu Yêu cầu — Thư viện biến thể khuôn bế (Box Variant Catalog)

## Introduction

Công cụ **Khuôn bế bao bì** hiện có 11 loại hộp (`boxType`), mỗi loại một card trong `DielineGallery` và một form `ParamPanel` chứa toàn bộ công tắc tuỳ chọn của loại đó. Hệ quả: người dùng phải **biết trước** mình cần tích công tắc nào mới ra được cái hộp đang cần. Ví dụ hộp đáy gài có hai kiểu thật sự khác nhau trong sản xuất (có lưỡi khoá nắp / không), nhưng trên giao diện chúng là cùng một card cộng một ô tích nằm trong mục "nâng cao".

Tính năng này thêm một **lớp dữ liệu biến thể (variant)** nằm TRÊN engine khuôn bế: mỗi card trong thư viện là một bộ thuộc tính đã chốt sẵn của một `boxType` có thật. Người dùng chọn hình giống cái hộp mình cần, nhập số đo, xong — không phải suy nghĩ về công tắc.

**Bất biến nền tảng của tính năng:** KHÔNG thêm/sửa generator, KHÔNG đổi hình học, KHÔNG đổi `boxType` allow-list ở ba tầng validate (TS `runtimeValidation.ts`, Python `dieline_validation.py`, Rust `dieline_request.rs`). Toàn bộ tính năng là dữ liệu + UI. Golden master snapshot phải giữ nguyên char-identical sau khi làm xong.

Mô hình tham chiếu: thư viện khuôn của Pacdora — sidebar nhóm có đếm số, card gồm khuôn 2D + ảnh hộp 3D, mỗi card một mã, kích thước do người dùng nhập.

## Glossary

- **Biến thể (variant)**: một mục trong thư viện = `boxType` + bộ thuộc tính đã chốt. Không phải một generator mới.
- **Thuộc tính chốt (`lockedParams`)**: các tham số mà biến thể quyết định thay người dùng. Vừa được áp khi chọn biến thể, vừa bị ẩn khỏi form.
- **Số đo gợi ý (`preset`)**: giá trị khởi đầu của L/W/D/T… — người dùng vẫn sửa được tự do.
- **Nhóm (`BoxGroup`)**: thẻ phân loại để gom card trong sidebar. Một biến thể mang NHIỀU nhóm.
- **Mã khuôn**: chuỗi ổn định dạng `PRYNX-<họ hộp>-<số>`, ví dụ `PRYNX-SLB-02`.
- **Chế độ chuyên gia**: trạng thái mở khoá toàn bộ tham số, giữ lại đường lùi cho người dùng cũ.

---

## Requirements

### Yêu cầu 1 — Catalog biến thể là nguồn dữ liệu duy nhất

**User Story:** Là người phát triển PrynX, tôi muốn danh sách biến thể nằm ở một chỗ duy nhất dưới dạng dữ liệu thuần, để thêm biến thể mới không phải sửa engine và không sợ làm trôi hình học.

#### Acceptance Criteria

1. THE hệ thống SHALL có một catalog biến thể khai báo dưới dạng dữ liệu thuần (không chứa logic hình học), mỗi mục gồm: `id`, `code`, `boxType`, `groups[]`, `nameVi`, `descVi`, `aliases[]`, `image`, `lockedParams`, `preset`.
2. THE mọi `id` và `code` trong catalog SHALL là duy nhất.
3. THE mỗi `boxType` đang tồn tại trong `BoxParams['boxType']` SHALL được phủ bởi ít nhất một biến thể — không loại hộp nào bị mất khỏi thư viện.
4. THE `boxType` của mỗi biến thể SHALL là một giá trị hợp lệ hiện có; catalog SHALL KHÔNG giới thiệu `boxType` mới.
5. WHEN hai biến thể có cùng `boxType` THEN `lockedParams` của chúng SHALL sinh ra hình khuôn khác nhau thật sự (khác số nét CUT, hoặc khác bounding box, hoặc khác số panel) — biến thể không đổi hình là biến thể vô nghĩa.
6. THE `lockedParams` SHALL là nguồn duy nhất quyết định tham số nào bị ẩn khỏi form; hệ thống SHALL KHÔNG có danh sách "tham số ẩn" thứ hai song song.

### Yêu cầu 2 — Chọn biến thể áp đúng thuộc tính

**User Story:** Là thợ chế bản, tôi muốn bấm vào một card là ra ngay cái hộp đúng kiểu, để không phải mò công tắc.

#### Acceptance Criteria

1. WHEN người dùng chọn một biến thể thuộc `boxType` KHÁC loại đang dùng THEN hệ thống SHALL áp tham số theo đúng thứ tự: (a) mặc định theo `boxType` mới, (b) `preset` của biến thể, (c) `lockedParams` của biến thể — bước sau ghi đè bước trước.
2. WHEN người dùng chuyển giữa hai biến thể có CÙNG `boxType` THEN hệ thống SHALL vẫn sinh lại khuôn và làm mới giá trị hiển thị trên các ô nhập (không dựa vào việc `boxType` có đổi hay không).
3. WHEN người dùng chuyển sang biến thể khác CÙNG `boxType` THEN hệ thống SHALL chỉ áp `lockedParams` của biến thể mới và giữ nguyên toàn bộ số đo người dùng đang dùng — KHÔNG áp lại bước (a) và (b). Lý do: `applyBoxTypeDefaults` nhúng sẵn preset số đo của một số loại và áp vô điều kiện, gọi lại nó khi `boxType` không đổi sẽ xoá số đo người dùng vừa nhập.
4. THE trạng thái biến thể đang chọn SHALL được lưu trong store cùng `params`, để mọi thành phần UI đọc được.
5. IF `id` biến thể được yêu cầu không tồn tại trong catalog THEN hệ thống SHALL rơi về biến thể mặc định của `boxType` tương ứng và KHÔNG làm sập công cụ.

### Yêu cầu 3 — Thư viện phân nhóm chồng lấn, có đếm số và tìm kiếm

**User Story:** Là người dùng, tôi muốn tìm hộp theo nhóm ngành hàng hoặc gõ tên để tìm, để không phải rà hết mọi card.

#### Acceptance Criteria

1. THE thư viện SHALL hiển thị sidebar danh sách nhóm, mỗi nhóm kèm SỐ LƯỢNG biến thể thuộc nhóm đó, cộng một mục "Tất cả".
2. THE số lượng của mỗi nhóm SHALL được tính tự động từ catalog, KHÔNG nhập tay.
3. THE mỗi biến thể SHALL mang ĐÚNG MỘT nhóm HỌ HỘP (các nhóm loại trừ nhau), cộng thêm nhóm CẮT NGANG nếu phù hợp. WHERE một biến thể mang nhóm cắt ngang THE biến thể đó SHALL xuất hiện ở cả nhóm họ hộp lẫn nhóm cắt ngang. Nhóm cắt ngang SHALL KHÔNG đứng một mình.
   _Sửa 2026-07-29: bản đầu cho chồng lấn tự do, kết quả là "Hộp nắp cài" phình lên 7 mục lẫn cả đáy gài / đáy dán / hộp treo (thân chúng giống Reverse Tuck End) ⇒ nhóm mất nghĩa, thư viện trông lung tung._
4. WHEN người dùng chọn một nhóm THEN lưới card SHALL chỉ hiện các biến thể thuộc nhóm đó.
5. THE thư viện SHALL có ô tìm kiếm khớp trên: `nameVi`, `descVi`, `code`, `aliases` và tên nhóm; tìm kiếm SHALL không phân biệt hoa/thường và không phân biệt dấu tiếng Việt.
6. WHEN tìm kiếm không có kết quả THEN hệ thống SHALL hiện thông báo rỗng rõ ràng kèm lối quay về "Tất cả".
7. THE mỗi card SHALL hiện ĐÚNG MỘT ảnh, cộng `nameVi`, `descVi`, `code`.
   _Sửa 2026-07-29: bản đầu yêu cầu "ảnh hộp 3D và khuôn 2D" nên tôi ghép hai tầng ảnh; nhưng bộ ảnh `/images/dieline/<boxType>.png` đã gồm CẢ hai cạnh nhau ⇒ nét khuôn hiện hai lần trên một card._

### Yêu cầu 4 — Form chỉ hiện thứ người dùng cần quyết định

**User Story:** Là người dùng, tôi muốn form chỉ còn số đo và những tuỳ chọn còn ý nghĩa với kiểu hộp mình đã chọn, để không bị rối và không tự phá kiểu hộp.

#### Acceptance Criteria

1. WHEN một biến thể đang được chọn THEN `ParamPanel` SHALL ẩn mọi control tương ứng với khoá có trong `lockedParams` của biến thể đó.
2. THE các tham số KHÔNG nằm trong `lockedParams` SHALL vẫn hiện và sửa được như hiện tại.
3. THE `ParamPanel` SHALL có công tắc "Tuỳ chỉnh nâng cao"; WHEN bật THEN mọi control bị ẩn SHALL hiện lại và sửa được — không tính năng nào bị mất so với bản hiện tại.
4. WHEN người dùng ở chế độ nâng cao và sửa một tham số đang bị chốt THEN hệ thống SHALL báo rõ rằng hộp đã lệch khỏi biến thể chuẩn (nhãn "đã tuỳ chỉnh"), và SHALL vẫn sinh khuôn bình thường.
5. THE ô chọn loại hộp (`select` boxType) hiện có SHALL được thay bằng ô chọn biến thể, giữ đường quay lại thư viện.
6. THE nhãn và mô tả của biến thể trên UI SHALL đi qua i18n như mọi text khác.

### Yêu cầu 5 — Ảnh minh hoạ sinh tự động

**User Story:** Là người bảo trì, tôi muốn ảnh card sinh ra từ chính engine, để ảnh luôn khớp khuôn thật và thêm biến thể không phải chờ ai vẽ ảnh.

#### Acceptance Criteria

1. THE hệ thống SHALL có script sinh ảnh minh hoạ cho từng biến thể bằng cách chạy engine với `preset` + `lockedParams` của biến thể đó.
2. THE ảnh sinh ra SHALL gồm khuôn 2D (đúng màu nét CUT/CREASE theo chú giải hiện hành) và hình hộp đã gấp.
3. THE script SHALL chạy được lặp lại cho ra kết quả ổn định (cùng đầu vào → cùng ảnh), để diff ảnh trong git có nghĩa.
4. IF một biến thể chưa có ảnh THEN card SHALL hiện khung giữ chỗ thay vì ảnh lỗi, và thư viện SHALL vẫn dùng được.

### Yêu cầu 6 — Không hồi quy hình học và không hồi quy tầng validate

**User Story:** Là người bảo trì engine khuôn bế, tôi muốn chắc chắn lớp biến thể không chạm được vào hình học, để không phải soi lại toàn bộ golden master.

#### Acceptance Criteria

1. WHEN tính năng hoàn tất THEN toàn bộ snapshot `goldenMaster.test.ts` SHALL giữ nguyên, KHÔNG được chạy `-u`.
2. THE tính năng SHALL KHÔNG sửa file generator nào trong `desktop/src/lib/dieline/` (`*Box.ts`, `Envelope.ts`, `PaperBag.ts`, `CupSleeve.ts`, `Matchbox*.ts`, `DoubleTray.ts`, `ReverseTuckEnd.ts`, `SnapLockBottom.ts`, `PizzaBox.ts`).
3. THE tính năng SHALL KHÔNG sửa `engine.ts`, `nestingEngine.ts`, `nestingProfile.ts`, `nestingCollision.ts`, `validateParams.ts`.
4. THE tính năng SHALL KHÔNG thêm giá trị vào allow-list `boxType` ở bất kỳ tầng nào (TS/Python/Rust).
5. WHEN mọi biến thể trong catalog được đưa qua engine THEN mỗi biến thể SHALL sinh ra `DielineModel` hợp lệ (không throw, không NaN, `boundingBox` bao đúng `allPaths`).
6. THE mọi tham số trong `lockedParams` và `preset` SHALL sống sót qua `validateParams` mà không bị kẹp về giá trị khác (nếu bị kẹp thì đó là preset sai, test phải bắt được).

### Yêu cầu 7 — Danh mục biến thể đợt đầu

**User Story:** Là chủ sản phẩm, tôi muốn đợt đầu phủ đúng các kiểu hộp mà xưởng in Việt Nam hay đặt, để tính năng dùng được ngay.

#### Acceptance Criteria

1. THE catalog đợt đầu SHALL gồm các biến thể sau (21 mục, phủ đủ 11 `boxType`):

   | Mã | Tên | boxType | lockedParams |
   |---|---|---|---|
   | PRYNX-RTE-01 | Hộp nắp cài so le | `rte` | — |
   | PRYNX-SLB-01 | Hộp đáy gài | `slb` | `lockTab: false` |
   | PRYNX-SLB-02 | Hộp đáy gài có lưỡi khoá nắp | `slb` | `lockTab: true` |
   | PRYNX-AB-01 | Hộp đáy dán tự động | `auto_bottom` | `lockTab: false` |
   | PRYNX-AB-02 | Hộp đáy dán có lưỡi khoá nắp | `auto_bottom` | `lockTab: true` |
   | PRYNX-GB-01 | Hộp quai xách mái dốc | `gable` | `gableStyle: 'pitched'` |
   | PRYNX-GB-02 | Hộp quai xách mái bằng | `gable` | `gableStyle: 'flat'` |
   | PRYNX-PB-01 | Túi giấy có lỗ xỏ quai | `paper_bag` | `handleHoles: true` |
   | PRYNX-PB-02 | Túi giấy trơn không quai | `paper_bag` | `handleHoles: false` |
   | PRYNX-CS-01 | Bọc ly dán vòng | `cup_sleeve` | `cupFlapPosition: 'right'` |
   | PRYNX-CS-02 | Bọc ly rời không mí dán | `cup_sleeve` | `cupFlapPosition: 'none'` |
   | PRYNX-PZ-01 | Hộp pizza tiêu chuẩn | `pizza` | vent + frontLock + cornerLock bật |
   | PRYNX-PZ-02 | Hộp pizza trơn | `pizza` | vent + frontLock + cornerLock tắt |
   | PRYNX-EV-01 | Bì thư ngang nắp nhọn | `envelope` | `envStyle:'wallet'`, `envFlapShape:'pointed'`, `envWindow:false` |
   | PRYNX-EV-02 | Bì thư ngang nắp thẳng | `envelope` | `envStyle:'wallet'`, `envFlapShape:'straight'`, `envWindow:false` |
   | PRYNX-EV-03 | Bì thư dọc (bì lì xì) | `envelope` | `envStyle:'pocket'`, `envFlapShape:'pointed'`, `envWindow:false` |
   | PRYNX-EV-04 | Bì thư có cửa sổ | `envelope` | `envStyle:'wallet'`, `envWindow:true` |
   | PRYNX-TR-01 | Hộp khay 4 góc dán | `tray` | — |
   | PRYNX-DT-01 | Hộp âm dương (khay + nắp chụp) | `double_tray` | — |
   | PRYNX-HW-01 | Hộp treo có cửa sổ | `hanging_window` | `hgbWindow: true` |
   | PRYNX-HW-02 | Hộp treo kín không cửa sổ | `hanging_window` | `hgbWindow: false` |

2. THE nhóm đợt đầu SHALL gồm: Hộp nắp cài (Tuck End) · Hộp đáy gài & đáy dán (Auto/Snap Bottom) · Khay & hộp hai mảnh (Tray & Lid) · Hộp có cửa sổ (Window) · Hộp treo kệ (Hanging/Display) · Hộp thực phẩm (Food) · Túi & bọc (Bag & Sleeve) · Bì thư (Envelope).
3. THE các trục tuỳ chọn KHÔNG tách thành card SHALL ở lại trong form: `glueSide`, `panelOrder`, `handleShape`, `handleY`, `cupHeightType`, `cupCoverage`, `envFlapShape` (với biến thể cửa sổ), `SLP`, `ABD`, `DFH`, và mọi số đo mm.
4. THE quy tắc quyết định tách card SHALL được ghi thành tài liệu trong catalog: tách khi thuộc tính **đổi hình khuôn thấy được trên ảnh minh hoạ** và là quyết định *chọn kiểu hộp*; giữ trong form khi là *số đo hoặc trang trí* trên cùng một kiểu hộp.
