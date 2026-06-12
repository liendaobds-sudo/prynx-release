# Requirements Document

## Introduction

Hai tính năng bình bài cốt lõi — **Bế Tem (die-cut)** và **Cắt Xén (guillotine/N-up)** — hiện đang chạy trên **5 bản triển khai layout-math song song** (TS render, TS preview, Rust PyO3 trong `native/`, Python fallback, và Rust copy chết trong `src-tauri/pdf_engine/imposition.rs`). Hệ quả: kết quả lệch nhau tùy kích thước file và môi trường, preview không khớp output, nhiều thiết lập UI bị bỏ qua âm thầm, state bị rò rỉ chéo giữa các công cụ, và fallback Rust→Python diễn ra lặng lẽ tạo kết quả không tất định.

Spec này định nghĩa hành vi đích của một hệ bình bài **có một nguồn chân lý duy nhất**: toàn bộ phép toán layout nằm trong **một crate Rust dùng chung** (`imposition_core`), được hai binding mỏng (PyO3 cho backend, Tauri cho client) bọc lại, và hai assembler "ngu" (pikepdf cho job lớn/bế tem, pdf-lib cho job nhỏ) chỉ tiêu thụ kết quả tính sẵn. Mục tiêu: hoàn thiện, tối ưu, sạch — không tái sinh bản chép thứ N, preview luôn khớp output, thiết lập UI hoặc có hiệu lực hoặc không tồn tại.

Phạm vi: tính toán layout, dựng payload, preview, quản lý state công cụ, độ bền job backend. Ngoài phạm vi: thuật toán nhận diện hình (`detect-shape`), tính năng booklet/offset (chỉ đụng tới khi cần đảm bảo không hồi quy).

### Quyết định kiến trúc đã chốt
- **Assembler:** Phương án B — giữ assembler client (pdf-lib) cho job nhỏ, nhưng nó tiêu thụ placements từ Rust thay vì tự tính.
- **Điểm vào spec:** Requirements-first.

## Glossary

- **imposition_core**: Crate Rust thuần toán chứa nguồn chân lý duy nhất của layout-math.
- **Binding**: Lớp bọc mỏng (PyO3 cho Python, Tauri cho client) quanh `imposition_core`.
- **Assembler**: Thành phần nhúng trang nguồn vào PDF output theo placements đã tính (pikepdf hoặc pdf-lib).
- **Placement**: Vị trí tuyệt đối (x, y, xoay, kích thước, trang nguồn) của một ô trên tờ in.
- **Profile**: Bộ thiết lập thuật toán riêng của một công cụ (N-up / Bế Tem / Booklet).
- **Bế Tem (die-cut)**: Bình bài tem theo hình bế.
- **Cắt Xén (guillotine/N-up)**: Bình bài cắt thẳng theo lưới.
- **Parity**: Sự khớp nhau giữa các đường tính/triển khai cho cùng input.

## Requirements

### Requirement 1: Một nguồn chân lý cho layout-math

**User Story:** Là kỹ sư bảo trì, tôi muốn toàn bộ phép toán bình bài chỉ tồn tại ở một nơi, để mọi thay đổi áp dụng nhất quán và không thể lệch giữa các đường chạy.

#### Acceptance Criteria
1. THE hệ thống SHALL chứa đúng MỘT bản triển khai layout-math (grid solver, shape/sticker solver, NFP nesting, orchestrator, compute_placements, compute_alignment, compute_mark_coords) trong một crate Rust dùng chung (`imposition_core`).
2. WHEN crate `native/` (PyO3) cần layout-math THEN nó SHALL phụ thuộc và gọi vào `imposition_core` thay vì có bản riêng.
3. WHEN crate `src-tauri/` (Tauri) cần layout-math THEN nó SHALL phụ thuộc và gọi vào `imposition_core` thay vì `pdf_engine/imposition.rs`.
4. THE hệ thống SHALL NOT chứa bản triển khai layout-math nào bằng TypeScript dùng để tạo output (ví dụ `NupGridSolver`, phần tính lưới/căn lề trong `NupRenderer`).
5. THE hệ thống SHALL NOT chứa bản triển khai layout-math nào bằng Python dùng cho đường chạy chính (Python chỉ được phép giữ vai trò fallback theo Requirement 7).
6. WHEN một bản copy layout-math mới bị thêm vào ngoài `imposition_core` THEN cơ chế kiểm tra (lint/CI/test) SHALL phát hiện và báo lỗi.

---

### Requirement 2: Tách bạch tính toán và lắp ráp

**User Story:** Là kỹ sư, tôi muốn việc "tính toạ độ" tách hẳn khỏi việc "đặt trang vào PDF", để hai assembler khác nhau không thể cho ra layout khác nhau.

#### Acceptance Criteria
1. THE `imposition_core` SHALL trả về placements tuyệt đối (x, y, góc xoay, kích thước, chỉ số trang nguồn) đã tính sẵn cho mỗi ô trên mỗi tờ.
2. WHEN backend assembler (pikepdf) dựng PDF THEN nó SHALL chỉ nhúng trang theo placements nhận được, KHÔNG tự tính lại vị trí, căn lề, hay xoay.
3. WHEN client assembler (pdf-lib) dựng PDF THEN nó SHALL chỉ nhúng trang theo placements nhận được, KHÔNG tự tính lại vị trí, căn lề, hay xoay.
4. WHEN cùng một bộ input (file, settings) được đưa qua backend assembler và client assembler THEN layout hình học của output (vị trí/xoay từng ô) SHALL trùng nhau trong sai số ≤ 0.5pt.

---

### Requirement 3: Preview khớp output

**User Story:** Là người vận hành in ấn, tôi muốn khung xem trước phản ánh đúng file sẽ xuất ra, để tin tưởng preview trước khi chạy hàng loạt.

#### Acceptance Criteria
1. WHEN preview được tính THEN nó SHALL dùng cùng `imposition_core` với đường tạo output.
2. THE preview SHALL NOT chứa bản tính căn lề/lật trục độc lập với `imposition_core`.
3. WHEN chế độ in 2 mặt (duplexFlow = double) được bật THEN preview SHALL hiển thị cả mặt trước và mặt sau.
4. WHEN cùng input được preview và xuất output THEN số ô/tờ (sức chứa) và vị trí từng ô SHALL khớp nhau trong sai số ≤ 0.5pt.

---

### Requirement 4: Hợp đồng dữ liệu có kiểu, không field câm

**User Story:** Là kỹ sư, tôi muốn mọi thiết lập trên UI hoặc thực sự có tác dụng, hoặc gây lỗi biên dịch, để không còn ô điều khiển "câm".

#### Acceptance Criteria
1. THE kiểu dữ liệu settings dùng giữa client và engine SHALL được sinh từ một định nghĩa nguồn duy nhất (struct Rust trong `imposition_core`).
2. WHEN một field settings được gửi từ client mà engine không tiêu thụ THEN điều đó SHALL bị phát hiện ở thời điểm biên dịch hoặc kiểm tra hợp đồng (không im lặng).
3. WHEN người dùng chọn "Tùy chỉnh" và nhập số cột/dòng (gridStrategy = manual) THEN engine SHALL áp dụng đúng số cột/dòng đó ở mọi đường chạy (bế tem, cắt xén nhỏ, cắt xén lớn).
4. THE các file lõi của luồng bình bài SHALL NOT dùng `@ts-nocheck`.
5. WHEN một thiết lập không áp dụng cho công cụ đang chọn THEN UI SHALL ẩn nó, thay vì hiển thị một ô không có hiệu lực.

---

### Requirement 5: State theo profile, không rò rỉ giữa công cụ

**User Story:** Là người dùng, tôi muốn mỗi công cụ (N-up, Bế Tem, Booklet) nhớ thiết lập riêng, để chuyển qua lại không làm sai cấu hình.

#### Acceptance Criteria
1. THE state SHALL tách thành nhóm "vật lý" dùng chung (khổ giấy, lề, bù xén, nhíp) và nhóm "thuật toán" riêng theo từng công cụ (profile).
2. WHEN người dùng đổi công cụ THEN hệ thống SHALL hiển thị thiết lập thuật toán của đúng công cụ đó mà không ghi đè thiết lập của công cụ khác.
3. THE hệ thống SHALL xác định công cụ đang chọn từ MỘT nguồn duy nhất (không đồng bộ thủ công nhiều biến trùng vai trò).
4. WHEN người dùng cấu hình N-up, chuyển sang Bế Tem rồi quay lại N-up THEN thiết lập N-up SHALL giữ nguyên như trước khi rời đi.
5. WHEN state được nạp lại từ phiên trước (persist) THEN dữ liệu phẳng cũ SHALL được di trú sang cấu trúc profile mà không mất preset người dùng đã lưu.

---

### Requirement 6: Pont và Mark độc lập theo nhu cầu

**User Story:** Là người vận hành, tôi muốn bật/tắt mark cắt và pont định vị theo nhu cầu thực tế của từng công cụ, không bị khóa cứng.

#### Acceptance Criteria
1. THE việc một công cụ có hỗ trợ mark cắt hay pont SHALL được khai báo tường minh trong profile của công cụ đó.
2. WHEN một công cụ khai báo hỗ trợ pont THEN payload của nó SHALL mang theo pontType/pontConfig tới engine.
3. WHEN một công cụ khai báo hỗ trợ mark THEN payload của nó SHALL mang theo markType và các tham số mark tới engine.
4. THE việc dựng payload SHALL NOT khóa cứng "diecut thì không có mark" hay "guillotine thì không có pont" bằng điều kiện rải rác ngoài profile.

---

### Requirement 7: Rust là dependency cứng, fallback không im lặng

**User Story:** Là người vận hành, tôi muốn kết quả tất định: hoặc đúng, hoặc báo lỗi rõ — không bao giờ âm thầm cho ra kết quả khác tùy máy.

#### Acceptance Criteria
1. THE hệ thống SHALL coi `imposition_core` (qua Rust) là thành phần bắt buộc cho việc tạo output.
2. WHEN module Rust không nạp được THEN hệ thống SHALL báo lỗi rõ ràng cho người dùng và KHÔNG âm thầm tạo output bằng đường khác.
3. IF tồn tại fallback Python THEN nó SHALL ghi cảnh báo rõ ràng mỗi khi được dùng VÀ nằm trong bộ kiểm tra parity tự động.
4. WHEN một lời gọi Rust thất bại giữa chừng THEN hệ thống SHALL báo lỗi thay vì lặng lẽ chuyển sang nhánh tính khác cho ra kết quả khác.

---

### Requirement 8: Lưới an toàn parity trước khi tái cấu trúc

**User Story:** Là kỹ sư, tôi muốn khóa hành vi hiện tại bằng test trước khi gộp engine, để phát hiện ngay nếu output đổi.

#### Acceptance Criteria
1. THE dự án SHALL có một bộ golden test cho cả Bế Tem và Cắt Xén với các file mẫu và bộ settings cố định, sinh ra output mốc.
2. WHEN layout-math thay đổi THEN bộ test SHALL so output mới với mốc và báo khác biệt vượt ngưỡng cho phép.
3. THE các test parity rời rạc sẵn có (`test_verify_rust_parity.py`, `test_hex.py`, `test_layout.py`) SHALL được gom vào một suite chạy được trong CI.
4. WHEN bộ test parity chạy THEN nó SHALL kiểm tra cả tình huống Rust khả dụng và tình huống fallback Python (ép tắt Rust) cho ra cùng kết quả trong ngưỡng cho phép.

---

### Requirement 9: Độ bền job backend & dọn dẹp

**User Story:** Là người vận hành, tôi muốn job bình bài không bị mất khi server khởi động lại và không để lại rác.

#### Acceptance Criteria
1. THE trạng thái job N-up/sticker SHALL được lưu ở một nguồn trạng thái duy nhất, nhất quán giữa tiến trình API và tiến trình xử lý.
2. WHEN job hoàn tất hoặc thất bại THEN các file tạm liên quan (nup_state_*, nup_prog_*) SHALL được dọn dẹp.
3. THE hai endpoint trùng lặp `/nup-start` và `/sticker-start` SHALL được gộp thành một, phân biệt bằng tham số chứ không phải hai đường mã gần như giống hệt.
4. WHEN dọn dead code THEN `getSerializableState`, `applyParsedState` (không nơi gọi) và `src-tauri/pdf_engine/imposition.rs` (bản copy) SHALL bị loại bỏ sau khi đường thay thế hoạt động.

---

### Requirement 10: Không hồi quy hành vi bình bài hiện có

**User Story:** Là người dùng hiện tại, tôi muốn sau khi tái cấu trúc, mọi kết quả bình bài đúng như trước (hoặc tốt hơn), không có hồi quy.

#### Acceptance Criteria
1. WHEN tái cấu trúc hoàn tất THEN mọi golden test ở Requirement 8 SHALL pass.
2. WHEN người dùng chạy một bộ settings hợp lệ bất kỳ đã hoạt động trước đây THEN output mới SHALL tương đương output cũ trong ngưỡng sai số đã định, HOẶC khác biệt SHALL được giải thích là sửa lỗi có chủ đích.
3. THE các tính năng không thuộc phạm vi (booklet/offset, detect-shape) SHALL giữ nguyên hành vi.
