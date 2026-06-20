# Requirements Document

> Tài liệu Yêu cầu — Recipe (Ghi & Phát lại quy trình xử lý PDF)

## Introduction

Người dùng PrynX thường lặp đi lặp lại **cùng một chuỗi thao tác** cho cùng một loại sản phẩm (ví dụ: mở PDF 16 trang → tách nền → chuyển hệ màu → nhúng font → bình booklet). Hiện mỗi lần phải bấm lại toàn bộ các bước thủ công.

Tính năng **Recipe** (theo mô hình "Action / Macro / Playback" của Acrobat Action Wizard, PitStop Action Lists, Quite Memory/Playback) cho phép:
- **Ghi lại** chuỗi thao tác param-based mà người dùng áp lên file đang mở.
- **Lưu** thành một Recipe có tên, quản lý được (CRUD, export/import).
- **Phát lại** Recipe đó lên một file mới bằng 1 click → ra thành phẩm.

Đây là tính năng **tuyến tính** (không phải workflow dạng node/DAG). Mỗi Recipe là một danh sách bước có thứ tự; phát lại chạy tuần tự, output bước trước là input bước sau — giống hệt cách workspace đang chain qua `commitWorkingFile`.

## Phạm vi (MVP v1)
- **Trong phạm vi**: các thao tác **param-based** (chạy trên file bất kỳ từ tham số tường minh): Chuyển màu, Hairlines, Trapping, PDF/X (nhúng font), OCR, Optimize, Spot→CMYK, Watermark, Header/Footer, Booklet, N-Up, Bế tem, CNC, Shuffle, Resize, Split, Tách nền AI, Upscale.
- **Ngoài phạm vi v1** (đánh dấu "không ghi được" + cảnh báo): sửa object theo toạ độ, Crop/Set Page Boxes, xóa/chọn trang theo index thủ công, đặt VDP field tại XY.
- **Cần input ngoài khi phát lại** (hỏi lại lúc chạy): Data Merge (CSV), Merge/Insert (file thứ hai).

## Glossary
- **Recipe**: một quy trình đã lưu = danh sách có thứ tự các **Step**.
- **Step**: một thao tác đã ghi = `{ opId, params, label, recordable }`.
- **opId**: định danh thao tác (khớp `handleStart*` / tool key trong `processHandlers`/PreprocessingRouter).
- **Record hook**: điểm chặn bắt `{opId, params}` khi một thao tác hoàn tất (chủ yếu quanh `commitWorkingFile`).
- **Playback runner**: bộ chạy lại các Step tuần tự, tái dùng `processHandlers.run*`.
- **Working file**: file PDF hiện hành trong workspace; mỗi thao tác cập nhật nó qua `commitWorkingFile`.

---

## Requirements

### Yêu cầu 1 — Ghi quy trình (Record)

**User Story:** Là thợ chế bản, tôi muốn bật "Ghi" rồi thao tác bình thường, để hệ thống tự lưu lại đúng chuỗi bước + thiết lập, không phải khai báo thủ công.

#### Acceptance Criteria
1. WHEN người dùng bật chế độ Ghi THEN hệ thống SHALL hiển thị trạng thái đang ghi rõ ràng (badge/indicator) trên thanh công cụ workspace.
2. WHILE đang ghi, WHEN một thao tác param-based hoàn tất (đi qua `commitWorkingFile`) THEN hệ thống SHALL thêm một Step `{opId, params}` vào recipe đang ghi, theo đúng thứ tự thực hiện.
3. THE params của mỗi Step SHALL được chụp từ store/cấu hình tại thời điểm thao tác chạy (không phải tại thời điểm dừng ghi), đủ để phát lại độc lập file.
4. WHEN một thao tác **không ghi được** (file/position-dependent) chạy trong lúc ghi THEN hệ thống SHALL ghi nhận một Step được đánh dấu `recordable=false` (hoặc bỏ qua) và cảnh báo cho người dùng biết bước đó sẽ không phát lại được.
5. WHEN người dùng dừng Ghi THEN hệ thống SHALL cho phép đặt tên + mô tả và lưu recipe, hoặc hủy bỏ.
6. WHERE thao tác có chỉnh sửa trang (xóa/xoay/sắp xếp ở viewer) THE Step tương ứng SHALL chụp kèm `viewerPageOrder`/`viewerPageRotations` tại thời điểm đó (vì `commitWorkingFile` reset chúng).

### Yêu cầu 2 — Lưu & quản lý Recipe

**User Story:** Là người dùng, tôi muốn lưu nhiều recipe có tên, xem lại, sửa, xóa, và chia sẻ, để tái dùng cho các đơn hàng khác nhau.

#### Acceptance Criteria
1. THE hệ thống SHALL lưu recipe bền vững (Tauri AppData JSON, fallback localStorage) theo đúng mẫu của `presetManager.ts`.
2. THE hệ thống SHALL hỗ trợ CRUD recipe: tạo, đọc danh sách, đổi tên/mô tả, xóa.
3. THE hệ thống SHALL cho phép **export** một recipe ra file và **import** từ file.
4. THE mỗi recipe SHALL lưu: `id, name, description, createdAt, updatedAt, steps[]` và (tùy chọn) metadata gợi ý áp dụng (vd số trang nguồn dự kiến).
5. THE người dùng SHALL xem được danh sách các Step trong một recipe (tên thao tác + tóm tắt tham số) trước khi phát lại.

### Yêu cầu 3 — Phát lại (Playback)

**User Story:** Là thợ in, tôi mở một file 16 trang mới và chỉ cần 1 click chọn recipe để ra thành phẩm như đã cấu hình trước đó.

#### Acceptance Criteria
1. WHEN người dùng chọn một recipe và bấm Phát lại trên file đang mở THEN hệ thống SHALL chạy tuần tự các Step, output của Step N là input của Step N+1 (chain qua working file).
2. THE playback runner SHALL ép `spawnNewTab=false` cho mọi Step trung gian để giữ chuỗi tuyến tính (không mở tab mới giữa chừng).
3. WHEN một Step là job bất đồng bộ (bình bài/VDP) THEN runner SHALL **đợi job hoàn tất** (tải kết quả) rồi mới sang Step kế.
4. WHEN tất cả Step hoàn tất THEN hệ thống SHALL áp kết quả cuối vào working file (hoặc tùy chọn mở tab mới cho kết quả cuối cùng).
5. IF một Step thất bại THEN hệ thống SHALL dừng và báo rõ Step nào lỗi + lý do, KHÔNG làm hỏng file gốc.
6. THE hệ thống SHALL hiển thị tiến trình từng bước khi phát lại (Step i/N + tên thao tác).

### Yêu cầu 4 — Phân loại & cảnh báo bước không phát lại được

**User Story:** Là người dùng, tôi muốn biết bước nào an toàn để phát lại trên file khác và bước nào phụ thuộc file cụ thể, để không nhận kết quả sai âm thầm.

#### Acceptance Criteria
1. THE hệ thống SHALL phân loại mỗi thao tác là `recordable` (param-based) hoặc `file-dependent` theo bảng đã audit.
2. WHEN phát lại gặp Step `file-dependent` THEN hệ thống SHALL bỏ qua Step đó và cảnh báo (không tự ý áp toạ độ của file cũ lên file mới).
3. THE UI ghi/danh sách SHALL hiển thị trực quan Step nào "phát lại được" vs "phụ thuộc file".

### Yêu cầu 5 — Thao tác cần input ngoài

**User Story:** Là người dùng, khi phát lại recipe có bước ghép file/trộn dữ liệu, tôi muốn hệ thống hỏi lại file/CSV mới thay vì dùng dữ liệu cũ.

#### Acceptance Criteria
1. THE recipe SHALL KHÔNG lưu blob của file ngoài (CSV, file ghép) — chỉ lưu tham chiếu/metadata.
2. WHEN phát lại gặp Step cần input ngoài (Data Merge CSV, Merge/Insert file) THEN hệ thống SHALL hỏi người dùng cung cấp input đó trước khi chạy Step.
3. IF người dùng không cung cấp input ngoài THEN hệ thống SHALL bỏ qua Step đó (có cảnh báo) hoặc cho hủy phát lại.

### Yêu cầu 6 — Giao diện Record/Playback

**User Story:** Là người dùng, tôi muốn truy cập Ghi/Phát lại nhanh ngay trong workspace.

#### Acceptance Criteria
1. THE workspace toolbar SHALL có nút Ghi/Dừng quy trình với trạng thái rõ ràng.
2. THE hệ thống SHALL có panel "Quy trình đã lưu" liệt kê recipe, mỗi recipe có nút Phát lại (▶), Sửa, Xóa, Export.
3. WHERE file đang mở có số trang khớp metadata gợi ý của recipe THE hệ thống MAY gợi ý recipe phù hợp.

### Yêu cầu 7 — An toàn (color-safety & file gốc)

**User Story:** Là kỹ thuật viên prepress, tôi cần đảm bảo phát lại không làm hỏng màu/đường ghi gốc.

#### Acceptance Criteria
1. THE playback runner SHALL tái dùng đúng đường xử lý hiện có (`processHandlers.run*`, endpoint backend) — KHÔNG tạo đường ghi PDF mới, giữ nguyên invariant an toàn màu (pikepdf là đường ghi duy nhất; không ghi đè file gốc của người dùng).
2. THE playback SHALL chạy trên một bản làm việc (working file), KHÔNG sửa file nguồn trên đĩa của người dùng.
3. THE kết quả phát lại trên cùng một input + cùng recipe SHALL nhất quán (deterministic) ở mức tham số; với thao tác dùng solver tự động, recipe MAY lưu kết quả đã giải (vd cols/rows) để giảm sai lệch.
