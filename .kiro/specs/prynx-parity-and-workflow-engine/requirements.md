# Requirements Document

## Introduction

Tính năng này có HAI mục tiêu nối tiếp nhau, phục vụ chiến lược "đè bẹp Quite Imposing rồi vượt lên":

**(A) Parity & Vượt Quite** — Nâng cấp các điểm mà Quite Imposing (đối chiếu tài liệu QI6) hiện đang mạnh hơn PrynX, đưa PrynX đạt và vượt: bình thủ công (manual imposition), đánh số trang/Bates phong phú, đơn vị đo linh hoạt (pt/mm/inch/cm) toàn cục, bộ thao tác trang trưởng thành (insert/blank/delete/reverse/padding), độ tin cậy ở ca biên (đặc biệt đường file lớn >1000 trang phải đạt parity với đường file nhẹ), và mở rộng hệ PRESET để phủ mọi chế độ bình (die-cut/sticker/CNC) chứ không chỉ `booklet`/`nup`.

**(B) Workflow Engine (kiểu Make/n8n)** — Sau khi đạt parity, nâng khái niệm "preset" hiện tại lên thành "workflow": một hệ dựng quy trình tự động hóa bằng các node nối thành chuỗi (pipeline) có thể lưu, tái dùng, chia sẻ và chạy hàng loạt (batch) trên nhiều file. Thư viện node bao gồm nguồn input (file/thư mục/hot folder), tiền xử lý (shuffle/resize/split/merge/đổi màu/đánh số), bình bài (booklet/N-up/die-cut/CNC/catalog), thêm marks/pont, sinh report và xuất (lưu file in theo mã đơn/thư mục).

### Ràng buộc kiến trúc (kế thừa, không tái sinh)
- **Layout-math chỉ ở một nơi:** Mọi phép toán bình bài phải dùng `imposition_core` (crate Rust) theo spec `imposition-engine-unification`. Tính năng này KHÔNG được tái sinh bản TypeScript/Python song song cho layout-math.
- **Workflow Engine tái dùng handler sẵn có:** Các node bình bài/tiền xử lý/xuất phải gọi lại các handler hiện hữu (`processHandlers.ts`: `runProcessEngine`, `runCatalogPlan`, `runShuffle`, `runResize`, `runSplit`, `runMerge`, `savePrintFiles`...) thay vì viết lại logic.
- **Đơn vị toàn cục:** Đã có `appSettingsStore.measurementUnit` (`'mm' | 'cm' | 'inch'`) nhưng phần lớn input đang hard-code mm; cần mở rộng thêm `'pt'` và áp dụng nhất quán.

### Phạm vi (Scope)
**Trong phạm vi (In-scope):**
- Bình thủ công đặt/kéo trang vào ô lưới.
- Đánh số trang/Bates phong phú (style, vị trí, định dạng, khoảng bắt đầu, padding, phạm vi trang).
- Đơn vị đo toàn cục pt/mm/inch/cm cho mọi ô nhập và nhãn liên quan layout.
- Thao tác trang: insert (chèn từ file khác), blank (chèn trang trắng), delete, reverse, padding (đệm trang trắng tới bội số).
- Parity đường file lớn (chainNup "nhiều cuốn/tờ", sơ đồ gấp offset) với đường file nhẹ cho booklet.
- Mở rộng Preset Manager phủ mọi `taskMode`/chế độ bình (die-cut/sticker/CNC/offset/catalog) + di trú preset cũ.
- Workflow Engine: thư viện node, pipeline tuần tự + rẽ nhánh điều kiện, tham số/biến giữa node, preview/chạy thử, lưu/tải/chia sẻ workflow JSON, batch trên nhiều file, hot-folder.

**Ngoài phạm vi (Out-of-scope):**
- So sánh PDF (compare) và preflight như tính năng độc lập — CHỈ được bọc thành node nếu cần trong workflow, không mở rộng năng lực lõi của chúng.
- Thay đổi thuật toán layout-math trong `imposition_core` (đã thuộc spec `imposition-engine-unification`).
- Thuật toán nhận diện hình (`detect-shape`).

### Giả định (Assumptions)
- `imposition_core` (Rust) là nguồn chân lý layout và đã/đang được hợp nhất theo spec `imposition-engine-unification`.
- Môi trường chạy là Tauri desktop; truy cập hệ thống tệp (đọc thư mục, theo dõi hot-folder, ghi file in) khả dụng qua plugin Tauri FS.
- Các handler trong `processHandlers.ts` là điểm tích hợp ổn định để node workflow gọi lại.

### Rủi ro (Risks)
- **R1 — Parity file lớn:** Đường backend cho booklet file lớn (`imposePdfViaBackend`) hiện không hỗ trợ `chain_nup` và sơ đồ gấp offset; đạt parity có thể đòi mở rộng backend đáng kể.
- **R2 — Di trú preset:** Mở rộng schema preset có thể phá vỡ preset cũ (`taskMode: 'booklet'|'nup'`); cần di trú không mất dữ liệu.
- **R3 — Độ phức tạp Workflow Engine:** Rẽ nhánh điều kiện + biến giữa node là không gian trạng thái lớn; cần kiểm soát phạm vi để tránh tạo "engine tự động hóa đa năng" vượt nhu cầu in ấn.
- **R4 — Hiệu năng batch/hot-folder:** Chạy hàng loạt file lớn có thể nghẽn tài nguyên; cần hàng đợi và báo tiến độ.

## Glossary

- **PrynX**: Phần mềm bình bài/in ấn đang phát triển (sản phẩm này).
- **Quite**: Quite Imposing (QI6), phần mềm tham chiếu để so sánh năng lực.
- **imposition_core**: Crate Rust chứa nguồn chân lý duy nhất của layout-math (theo spec `imposition-engine-unification`).
- **Manual_Imposer**: Thành phần cho phép người dùng đặt/kéo từng trang nguồn vào ô lưới đích một cách thủ công.
- **Numbering_Engine**: Thành phần đánh số trang/Bates (số seri, vé).
- **Unit_Manager**: Thành phần quản lý đơn vị đo toàn cục và quy đổi giữa pt/mm/inch/cm.
- **Page_Ops**: Bộ thao tác trang (insert/blank/delete/reverse/padding) bổ sung cho shuffle/split/merge/resize sẵn có.
- **Large_File_Pipeline**: Đường xử lý dành cho file nặng (>1000 trang hoặc >300MB), hiện route sang backend.
- **Preset_Manager**: Thành phần lưu/tải/xóa/import/export preset thiết lập bình bài (`presetManager.ts`).
- **Workflow**: Một quy trình tự động hóa gồm nhiều node nối thành pipeline, lưu được thành file JSON, tái dùng/chia sẻ được.
- **Node**: Một bước trong workflow (nguồn input, tiền xử lý, bình bài, marks/pont, report, xuất).
- **Workflow_Engine**: Thành phần dựng/sửa workflow (thư viện node, nối node, cấu hình tham số).
- **Workflow_Runner**: Thành phần thực thi một workflow trên một hoặc nhiều file.
- **Workflow_Variable**: Giá trị truyền giữa các node trong một lần chạy workflow (ví dụ mã đơn, số lượng, đường dẫn output).
- **Hot_Folder_Watcher**: Thành phần theo dõi một thư mục và tự động chạy workflow khi có file mới.
- **taskMode**: Chế độ tác vụ bình bài hiện hành (`booklet`/`nup`/`step_repeat`/`offset`/`sticker_imposer`/`cnc_imposer`).

---

## Requirements

> **Nhóm A — Parity & Vượt Quite** (Requirement 1–6)

### Requirement 1: Bình Thủ Công (Manual Imposition)

**User Story:** Là người vận hành in ấn, tôi muốn đặt và kéo từng trang nguồn vào từng ô của lưới đích theo ý mình, để xử lý các bố cục đặc thù mà chế độ tự động không bao quát được, đạt và vượt năng lực bình tay của Quite.

#### Acceptance Criteria
1. WHEN người dùng chọn chế độ Bình Thủ Công, THE Manual_Imposer SHALL hiển thị một lưới đích có số cột và số dòng do người dùng cấu hình trên khổ giấy đã chọn.
2. WHEN người dùng kéo một trang nguồn vào một ô lưới trống, THE Manual_Imposer SHALL gán trang nguồn đó vào ô đích đó.
3. WHEN người dùng kéo một trang đã đặt từ ô này sang ô khác, THE Manual_Imposer SHALL di chuyển trang sang ô đích và giữ ô nguồn ở trạng thái trống.
4. WHERE một ô lưới đã được gán trang, THE Manual_Imposer SHALL cho phép người dùng đặt góc xoay của ô đó theo một trong các giá trị 0, 90, 180, 270 độ.
5. WHEN người dùng yêu cầu xóa nội dung một ô đã gán, THE Manual_Imposer SHALL đưa ô đó về trạng thái trống.
6. THE Manual_Imposer SHALL tính toạ độ đặt trang (vị trí, xoay, kích thước) bằng `imposition_core`, KHÔNG tự tính layout-math phía TypeScript.
7. WHEN người dùng yêu cầu xuất bố cục thủ công, THE Manual_Imposer SHALL sinh PDF output mà vị trí và góc xoay từng ô khớp với bố cục hiển thị trong sai số 0.5pt.
8. IF người dùng xuất khi lưới còn ô trống, THEN THE Manual_Imposer SHALL xuất ô trống đó thành vùng trắng và ghi cảnh báo số ô trống trong report.

---

### Requirement 2: Đánh Số Trang / Bates Phong Phú

**User Story:** Là người vận hành, tôi muốn đánh số trang và số seri với nhiều kiểu định dạng, vị trí và quy tắc, để đáp ứng nhu cầu in vé/biểu mẫu/tài liệu ngang bằng hoặc hơn Quite.

#### Acceptance Criteria
1. WHEN người dùng cấu hình đánh số, THE Numbering_Engine SHALL cho phép đặt giá trị bắt đầu là một số nguyên do người dùng nhập.
2. WHEN người dùng cấu hình đánh số, THE Numbering_Engine SHALL cho phép đặt bước tăng (increment) là một số nguyên do người dùng nhập.
3. WHEN người dùng cấu hình độ dài số (padding), THE Numbering_Engine SHALL chèn số 0 ở đầu để số hiển thị đạt đúng số chữ số đã chỉ định.
4. WHERE người dùng chọn tiền tố hoặc hậu tố, THE Numbering_Engine SHALL ghép tiền tố/hậu tố vào số theo thứ tự tiền tố + số + hậu tố.
5. WHEN người dùng chọn vị trí đặt số, THE Numbering_Engine SHALL đặt số tại một trong các vị trí: bốn góc, giữa-trên, giữa-dưới, và cho phép tinh chỉnh offset X/Y theo đơn vị đo toàn cục đang chọn.
6. WHEN người dùng chỉ định phạm vi trang áp dụng (ví dụ "tất cả", "chẵn", "lẻ", hoặc danh sách khoảng), THE Numbering_Engine SHALL chỉ đánh số trên các trang thuộc phạm vi đó.
7. WHERE người dùng chọn kiểu định dạng số (thập phân, hoặc các kiểu mở rộng được khai báo), THE Numbering_Engine SHALL kết xuất số theo đúng kiểu đã chọn.
8. WHEN người dùng yêu cầu xem trước, THE Numbering_Engine SHALL hiển thị preview số trên trang khớp với kết quả sẽ xuất ra.
9. WHEN người dùng yêu cầu áp dụng đánh số, THE Numbering_Engine SHALL ghi số vào PDF output đúng với giá trị, vị trí, định dạng và phạm vi đã cấu hình.

---

### Requirement 3: Đơn Vị Đo Linh Hoạt Toàn Cục

**User Story:** Là người dùng quốc tế, tôi muốn chọn đơn vị đo (pt/mm/inch/cm) áp dụng cho toàn bộ ứng dụng, để làm việc theo thói quen đo lường của mình thay vì bị ép dùng mm.

#### Acceptance Criteria
1. THE Unit_Manager SHALL hỗ trợ bốn đơn vị đo: điểm (pt), milimét (mm), inch, và centimét (cm).
2. WHEN người dùng đổi đơn vị đo toàn cục, THE Unit_Manager SHALL hiển thị mọi ô nhập kích thước/lề/khoảng cách/offset liên quan layout theo đơn vị mới và cập nhật nhãn đơn vị tương ứng.
3. WHEN người dùng nhập một giá trị theo đơn vị đang chọn, THE Unit_Manager SHALL quy đổi sang đơn vị nội bộ chuẩn trước khi gửi tới engine, để kết quả bình bài không phụ thuộc đơn vị hiển thị.
4. WHEN đơn vị hiển thị thay đổi mà giá trị vật lý không đổi, THE Unit_Manager SHALL giữ nguyên kết quả bình bài (giá trị quy đổi tương đương trong sai số 0.01mm).
5. WHEN người dùng đặt lại đơn vị đo, THE Unit_Manager SHALL lưu lựa chọn đó và áp dụng lại ở lần mở ứng dụng kế tiếp.

---

### Requirement 4: Bộ Thao Tác Trang Trưởng Thành

**User Story:** Là người vận hành, tôi muốn bộ thao tác trang đầy đủ (chèn trang từ file khác, chèn trang trắng, xóa, đảo ngược, đệm tới bội số), để chuẩn bị tài liệu trước khi bình ngang bằng Quite mà không cần công cụ ngoài.

#### Acceptance Criteria
1. WHEN người dùng chèn các trang từ một file PDF khác vào một vị trí chỉ định, THE Page_Ops SHALL chèn các trang đó vào đúng vị trí và giữ nguyên thứ tự các trang còn lại.
2. WHEN người dùng chèn N trang trắng tại một vị trí chỉ định, THE Page_Ops SHALL chèn đúng N trang trắng có cùng kích thước với trang lân cận hoặc kích thước do người dùng chỉ định.
3. WHEN người dùng yêu cầu xóa một tập trang được chỉ định, THE Page_Ops SHALL xóa đúng các trang đó và giữ nguyên các trang còn lại theo thứ tự.
4. WHEN người dùng yêu cầu đảo ngược thứ tự trang, THE Page_Ops SHALL tạo tài liệu có thứ tự trang ngược lại so với bản gốc.
5. WHEN người dùng yêu cầu đệm trang (padding) tới bội số K, THE Page_Ops SHALL chèn các trang trắng vào cuối tài liệu cho tới khi tổng số trang chia hết cho K.
6. WHERE tổng số trang đã là bội số của K, THE Page_Ops SHALL giữ nguyên tài liệu khi thực hiện padding tới bội số K.
7. IF người dùng nhập vị trí chèn hoặc tập trang xóa nằm ngoài phạm vi tài liệu, THEN THE Page_Ops SHALL từ chối thao tác và hiển thị thông báo lỗi nêu rõ phạm vi hợp lệ.
8. THE Page_Ops SHALL áp dụng đúng thao tác trên cả đường file nhẹ và đường file lớn (>1000 trang hoặc >300MB).

---

### Requirement 5: Parity Đường File Lớn

**User Story:** Là người vận hành, tôi muốn file nặng cho kết quả bình bài tương đương file nhẹ, để không phải lo lắng tính năng "biến mất" khi tài liệu lớn lên.

#### Acceptance Criteria
1. WHEN một booklet file lớn (>1000 trang hoặc >300MB) được bình ở chế độ "nhiều cuốn/tờ" (`scaleMode = chain_nup`), THE Large_File_Pipeline SHALL tạo bố cục nhiều cuốn trên một tờ tương đương với đường file nhẹ.
2. WHEN một booklet file lớn được bình với sơ đồ gấp offset (fold pattern), THE Large_File_Pipeline SHALL áp dụng đúng sơ đồ gấp đó thay vì xuất bố cục một cuốn/tờ trơn.
3. WHEN cùng một bộ input booklet được chạy qua đường file nhẹ và đường file lớn, THE hệ thống SHALL tạo bố cục hình học tương đương trong sai số 0.5pt cho mỗi ô.
4. IF một chế độ bình chưa được đường file lớn hỗ trợ, THEN THE Large_File_Pipeline SHALL hiển thị thông báo rõ ràng thay vì âm thầm xuất một bố cục khác.
5. THE Large_File_Pipeline SHALL dùng `imposition_core` cho layout-math giống đường file nhẹ, KHÔNG dùng bản tính song song.

---

### Requirement 6: Mở Rộng Preset Cho Mọi Chế Độ Bình

**User Story:** Là người dùng, tôi muốn lưu và tái dùng preset cho mọi chế độ bình (kể cả die-cut/sticker/CNC/offset/catalog), để không phải cấu hình lại từ đầu mỗi lần, ngang bằng tiện ích preset của Quite.

#### Acceptance Criteria
1. THE Preset_Manager SHALL hỗ trợ lưu preset cho mọi `taskMode`: `booklet`, `nup`, `step_repeat`, `offset`, `sticker_imposer`, `cnc_imposer` và phương án catalog.
2. WHEN người dùng lưu một preset cho một chế độ bình, THE Preset_Manager SHALL lưu đầy đủ các thiết lập thuật toán riêng của chế độ đó (ví dụ pont/cut cho die-cut, hai-mặt cho CNC, sơ đồ chia kẽm cho catalog) cùng các thiết lập vật lý dùng chung.
3. WHEN người dùng tải một preset, THE Preset_Manager SHALL khôi phục đúng chế độ bình và toàn bộ thiết lập đã lưu của preset đó.
4. WHEN người dùng export một preset, THE Preset_Manager SHALL ghi preset ra file JSON; và WHEN người dùng import lại file JSON đó, THE Preset_Manager SHALL khôi phục preset tương đương preset đã export.
5. WHEN ứng dụng nạp một preset được tạo bởi phiên bản cũ (chỉ có `booklet`/`nup`), THE Preset_Manager SHALL di trú preset đó sang schema mới mà không mất dữ liệu người dùng đã lưu.
6. FOR ALL preset hợp lệ, lưu rồi tải lại SHALL cho ra bộ thiết lập tương đương preset ban đầu (thuộc tính round-trip).

---

> **Nhóm B — Workflow Engine (kiểu Make/n8n)** (Requirement 7–12)

### Requirement 7: Thư Viện Node

**User Story:** Là người dùng nâng cao, tôi muốn một thư viện các node thao tác in ấn để lắp ghép quy trình, để tự động hóa các bước tôi đang làm tay.

#### Acceptance Criteria
1. THE Workflow_Engine SHALL cung cấp các node nguồn input gồm: chọn file, chọn thư mục, và hot-folder.
2. THE Workflow_Engine SHALL cung cấp các node tiền xử lý gồm: shuffle, resize, split, merge, đánh số, và thao tác trang (Page_Ops).
3. THE Workflow_Engine SHALL cung cấp các node bình bài gồm: booklet, N-up/step&repeat, die-cut/sticker, CNC, và catalog.
4. THE Workflow_Engine SHALL cung cấp các node bổ trợ gồm: thêm marks/pont, sinh report, và xuất/lưu file in.
5. WHEN một node bình bài hoặc tiền xử lý thực thi, THE Workflow_Runner SHALL gọi lại các handler hiện hữu trong `processHandlers.ts` thay vì triển khai lại logic bình bài.
6. WHERE một node bình bài cần layout-math, THE Workflow_Runner SHALL dùng `imposition_core`, KHÔNG tạo bản tính layout song song.

---

### Requirement 8: Dựng Pipeline (Nối Node Tuần Tự và Rẽ Nhánh)

**User Story:** Là người dùng, tôi muốn nối các node thành chuỗi xử lý, có thể rẽ nhánh theo điều kiện, để diễn đạt quy trình thực tế của mình.

#### Acceptance Criteria
1. WHEN người dùng nối đầu ra của một node vào đầu vào của node kế tiếp, THE Workflow_Engine SHALL tạo một liên kết tuần tự giữa hai node đó.
2. WHEN người dùng chạy một workflow tuần tự, THE Workflow_Runner SHALL thực thi các node theo đúng thứ tự liên kết, truyền đầu ra của node trước làm đầu vào node sau.
3. WHERE người dùng thêm một node điều kiện, THE Workflow_Engine SHALL cho phép định nghĩa biểu thức điều kiện trên Workflow_Variable để chọn nhánh thực thi.
4. WHEN một node điều kiện được thực thi, THE Workflow_Runner SHALL chỉ thực thi nhánh có điều kiện được thỏa.
5. IF người dùng tạo một liên kết tạo thành chu trình (vòng lặp khép kín), THEN THE Workflow_Engine SHALL từ chối liên kết đó và hiển thị thông báo lỗi.
6. IF một workflow được chạy khi còn node bắt buộc chưa được cấu hình đủ tham số, THEN THE Workflow_Runner SHALL dừng trước khi chạy và báo node nào thiếu tham số.

---

### Requirement 9: Tham Số Node và Biến Giữa Các Bước

**User Story:** Là người dùng, tôi muốn mỗi node có tham số riêng và truyền được giá trị giữa các node, để quy trình linh hoạt theo từng đơn hàng.

#### Acceptance Criteria
1. WHERE một node có tham số cấu hình, THE Workflow_Engine SHALL cho phép người dùng đặt giá trị cho từng tham số của node đó.
2. WHEN người dùng định nghĩa một Workflow_Variable, THE Workflow_Engine SHALL cho phép tham chiếu biến đó trong tham số của các node phía sau.
3. WHEN Workflow_Runner thực thi một node tham chiếu một Workflow_Variable, THE Workflow_Runner SHALL thay giá trị biến hiện hành vào tham số trước khi thực thi node.
4. WHEN một node sinh ra giá trị đầu ra (ví dụ mã đơn, số tờ, đường dẫn output), THE Workflow_Runner SHALL đưa giá trị đó vào Workflow_Variable cho các node sau dùng.
5. IF một tham số tham chiếu một Workflow_Variable chưa được định nghĩa tại thời điểm thực thi, THEN THE Workflow_Runner SHALL dừng node đó và báo lỗi nêu rõ tên biến thiếu.

---

### Requirement 10: Preview / Chạy Thử Workflow

**User Story:** Là người dùng, tôi muốn chạy thử workflow trên một file mẫu và xem trước kết quả từng bước, để kiểm tra quy trình trước khi chạy hàng loạt.

#### Acceptance Criteria
1. WHEN người dùng yêu cầu chạy thử một workflow trên một file mẫu, THE Workflow_Runner SHALL thực thi workflow ở chế độ thử và hiển thị kết quả của từng node theo thứ tự thực thi.
2. WHEN một node hoàn tất ở chế độ thử, THE Workflow_Runner SHALL hiển thị trạng thái (thành công/lỗi) và bản tóm tắt đầu ra của node đó.
3. IF một node lỗi trong chế độ thử, THEN THE Workflow_Runner SHALL dừng tại node đó và hiển thị thông báo lỗi cùng node gây lỗi.
4. WHEN chạy thử kết thúc, THE Workflow_Runner SHALL cho phép xem trước file output cuối cùng mà không bắt buộc ghi ra thư mục đích.

---

### Requirement 11: Lưu, Tải và Chia Sẻ Workflow

**User Story:** Là người dùng, tôi muốn lưu workflow thành file để tái dùng và chia sẻ cho đồng nghiệp, nâng cấp khái niệm preset hiện tại lên thành workflow.

#### Acceptance Criteria
1. WHEN người dùng lưu một workflow, THE Workflow_Engine SHALL ghi workflow ra file JSON gồm các node, liên kết, tham số node và định nghĩa biến.
2. WHEN người dùng tải một file workflow JSON, THE Workflow_Engine SHALL khôi phục đúng các node, liên kết, tham số và biến của workflow đó.
3. FOR ALL workflow hợp lệ, lưu ra JSON rồi tải lại SHALL cho ra một workflow tương đương workflow ban đầu (thuộc tính round-trip).
4. IF một file workflow JSON không hợp lệ hoặc thiếu trường bắt buộc, THEN THE Workflow_Engine SHALL từ chối tải và hiển thị thông báo lỗi mô tả vấn đề.
5. WHERE một preset bình bài cũ tồn tại, THE Workflow_Engine SHALL cho phép chuyển preset đó thành một workflow một-node tương đương (bình bài với thiết lập của preset).

---

### Requirement 12: Chạy Hàng Loạt (Batch) và Hot-Folder

**User Story:** Là người vận hành, tôi muốn chạy một workflow trên nhiều file cùng lúc và tự động xử lý file mới rơi vào một thư mục, để xử lý khối lượng lớn không cần thao tác tay từng file.

#### Acceptance Criteria
1. WHEN người dùng chọn nhiều file đầu vào và chạy một workflow ở chế độ batch, THE Workflow_Runner SHALL áp dụng cùng workflow đó cho từng file đầu vào.
2. WHEN một file trong batch xử lý xong, THE Workflow_Runner SHALL cập nhật tiến độ tổng thể (số file đã xong trên tổng số).
3. IF một file trong batch lỗi, THEN THE Workflow_Runner SHALL ghi nhận lỗi cho file đó và tiếp tục xử lý các file còn lại.
4. WHEN batch kết thúc, THE Workflow_Runner SHALL hiển thị tổng kết gồm số file thành công và số file lỗi cùng lý do lỗi.
5. WHERE một workflow được gắn với một Hot_Folder_Watcher, THE Hot_Folder_Watcher SHALL theo dõi thư mục đã chỉ định và tự động chạy workflow trên mỗi file mới xuất hiện.
6. WHEN Hot_Folder_Watcher xử lý xong một file, THE Workflow_Runner SHALL ghi output theo cấu hình node xuất (theo mã đơn/thư mục) mà không cần người dùng thao tác thêm.
