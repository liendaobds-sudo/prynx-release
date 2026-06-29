# Requirements Document

## Introduction

Tính năng **Gỡ kênh màu CMYK có bù màu** (Channel Remover with color re-separation) cho phép người dùng in một file CMYK bằng ít mực hơn (ví dụ 4→3 hoặc 4→2 mực) bằng cách bỏ một hoặc nhiều kênh process (C/M/Y/K). Thay vì chỉ xóa thẳng kênh về 0 (gây đổi màu mạnh ở vùng dùng mực đó), tính năng cung cấp chế độ **tái tách màu (re-separation)**: với mỗi màu CMYK gốc, chuyển sang Lab qua hồ sơ ICC FOGRA39, rồi tìm tổ hợp CMYK chỉ dùng các kênh còn giữ sao cho khác biệt màu (ΔE) nhỏ nhất. Mục tiêu là tiết kiệm bản kẽm/mực hoặc làm sạch kênh "bẩn" mà vẫn giữ màu gần nhất có thể.

Tính năng lấy cảm hứng từ GMG ColorPlugin "ChannelRemover" nhưng được điều chỉnh cho môi trường thực tế của dự án: backend Python, littleCMS qua PIL ImageCms, ICC bundle sẵn có (sRGB.icc + FOGRA39.icc tại `app/assets/icc`), KHÔNG có máy đo phổ. Vì không có dữ liệu phổ, phần spectral/OpenColor của GMG nằm ngoài phạm vi.

Bằng chứng đo trong phiên (đã xác minh bằng littleCMS) định hướng yêu cầu cốt lõi:
- Bù màu rất hiệu quả với các màu tái tạo được bằng mực còn lại (nâu, xám, đen, tông ấm): ΔE giảm từ 16–31 xuống còn ~1–2 (mắt không phân biệt).
- Bù màu KHÔNG cứu được các màu vốn cần đúng mực vừa bỏ (ví dụ lục/lam/cyan khi bỏ Cyan): vẫn lệch 60–120 ΔE vì nằm ngoài gamut, vật lý không tái tạo được. Vì vậy tính năng PHẢI cảnh báo và preview vùng "ngoài gamut" để người dùng tự quyết, và KHÔNG được hứa "in ít mực mà giống hệt bản gốc".

### Phạm vi NGOÀI (Out of Scope)
- Quy trình spectral/OpenColor của GMG (cần máy đo phổ) — không hỗ trợ.
- Ảnh CMYK nén JPEG (DCTDecode) ở MVP — chỉ xử lý FlateDecode; JPEG-CMYK để phase sau.
- Tái tạo "giống hệt" các màu rực nằm ngoài gamut của tập mực còn lại — vật lý không khả thi; chỉ cảnh báo, không cam kết.

## Glossary

- **Channel_Remover**: Hệ thống con thực hiện gỡ kênh màu process khỏi file PDF, hỗ trợ hai chế độ xóa thẳng và bù màu.
- **Process_Channel**: Một trong bốn kênh mực process: Cyan (C), Magenta (M), Yellow (Y), Black (K).
- **Kept_Channel**: Process_Channel mà người dùng chọn GIỮ lại trong kết quả.
- **Removed_Channel**: Process_Channel mà người dùng chọn BỎ khỏi kết quả.
- **Direct_Removal_Mode**: Chế độ xóa thẳng — đặt giá trị mọi Removed_Channel về 0, giữ nguyên giá trị Kept_Channel.
- **Re_Separation_Mode**: Chế độ bù màu — với mỗi màu CMYK gốc, tìm tổ hợp CMYK chỉ dùng Kept_Channel có ΔE nhỏ nhất so với màu gốc, dựa trên chuyển đổi qua Lab bằng FOGRA39.
- **Delta_E** (ΔE): Khoảng cách màu trong không gian Lab giữa màu gốc và màu tái tạo (CIE76 trừ khi nêu rõ khác).
- **Out_Of_Gamut_Region**: Vùng/đối tượng mà màu gốc không thể tái tạo bằng Kept_Channel với ΔE ≤ ngưỡng chấp nhận; bù màu không cứu được.
- **Gamut_Threshold**: Ngưỡng ΔE phân loại một màu là Out_Of_Gamut (mặc định ΔE = 5).
- **TAC** (Total Area Coverage): Tổng phần trăm phủ mực C+M+Y+K của một màu.
- **TAC_Limit**: Ngưỡng tối đa cho TAC sau khi tái tách (ví dụ 360% hoặc 400%); kết quả phải được clamp không vượt ngưỡng.
- **Content_Stream_Scanner**: Bộ quét content stream ở mức byte (tái dùng kỹ thuật của `overprint_black.py` / `preserve_black.py`) bỏ qua string literal, inline image (BI/ID/EI) và comment; KHÔNG dùng regex thô.
- **Vector_Color_Operator**: Toán tử màu trong content stream cần xử lý: `k`/`K` (DeviceCMYK fill/stroke) và `scn`/`SCN` (màu có color space đặt sẵn).
- **CMYK_Image_XObject**: Ảnh trong XObject có color space DeviceCMYK hoặc ICCBased 4 kênh.
- **Spot_Color**: Màu pha định nghĩa qua color space Separation/DeviceN.
- **ICC_Profile**: Hồ sơ màu ICC; trong phạm vi này là FOGRA39.icc dùng cho chuyển đổi CMYK↔Lab.
- **Preflight_Output_Dir**: Thư mục `RESULTS_DIR/preflight_output` nơi ghi file kết quả, đồng bộ với các tool preflight khác.
- **Download_Endpoint**: Endpoint `GET /preflight/download/{filename}` để tải file kết quả.
- **Action_Engine**: `app/core/action_engine.py`, nơi đăng ký các action prepress.
- **Viewer_Preview**: Bản xem trước render trên viewer của ứng dụng.
- **Parity**: Yêu cầu Viewer_Preview phải khớp với file output thực tế (bài học §6 audit-rules).

## Requirements

### Requirement 1: Chọn kênh giữ/bỏ

**User Story:** As a thợ chế bản, I want chọn các kênh process muốn giữ lại, so that tôi quyết định in file bằng ít mực hơn theo nhu cầu.

#### Acceptance Criteria

1. THE Channel_Remover SHALL cung cấp lựa chọn giữ/bỏ độc lập cho từng Process_Channel trong tập {Cyan, Magenta, Yellow, Black}.
2. WHEN người dùng chọn tập Kept_Channel có từ 1 đến 3 phần tử, THE Channel_Remover SHALL chấp nhận và xử lý file theo tập đó.
3. IF người dùng chọn giữ cả 4 Process_Channel, THEN THE Channel_Remover SHALL từ chối thao tác và trả về thông báo rằng không có kênh nào bị gỡ.
4. IF người dùng chọn bỏ cả 4 Process_Channel (Kept_Channel rỗng), THEN THE Channel_Remover SHALL từ chối thao tác và trả về thông báo yêu cầu giữ ít nhất một kênh.

### Requirement 2: Chế độ xóa thẳng (Direct Removal)

**User Story:** As a người dùng, I want chọn chế độ xóa thẳng kênh, so that tôi loại bỏ nhanh kênh không cần thiết hoặc kênh "bẩn" mà không cần bù màu.

#### Acceptance Criteria

1. WHERE Direct_Removal_Mode được chọn, WHEN một màu CMYK gốc được xử lý, THE Channel_Remover SHALL đặt giá trị mỗi Removed_Channel về 0 và giữ nguyên giá trị mỗi Kept_Channel.
2. WHERE Direct_Removal_Mode được chọn, THE Channel_Remover SHALL không thay đổi giá trị của bất kỳ Kept_Channel nào.

### Requirement 3: Chế độ bù màu (Re-Separation)

**User Story:** As a thợ chế bản, I want chế độ bù màu giữ màu gần nhất bằng mực còn lại, so that file in ít mực vẫn giống bản gốc nhất có thể.

#### Acceptance Criteria

1. WHERE Re_Separation_Mode được chọn, WHEN một màu CMYK gốc được xử lý, THE Channel_Remover SHALL chuyển màu gốc sang Lab bằng ICC_Profile FOGRA39 và tìm tổ hợp CMYK chỉ dùng Kept_Channel có Delta_E nhỏ nhất so với màu Lab gốc.
2. WHERE Re_Separation_Mode được chọn, THE Channel_Remover SHALL đặt giá trị mọi Removed_Channel của màu kết quả về 0.
3. WHERE Re_Separation_Mode được chọn, WHEN một màu gốc tái tạo được trong gamut của Kept_Channel, THE Channel_Remover SHALL tạo màu kết quả có Delta_E ≤ Gamut_Threshold so với màu gốc.
4. WHERE Re_Separation_Mode được chọn, IF một màu gốc không tái tạo được trong gamut của Kept_Channel, THEN THE Channel_Remover SHALL chọn màu Kept_Channel có Delta_E nhỏ nhất và đánh dấu màu đó thuộc Out_Of_Gamut_Region.

### Requirement 4: Cảnh báo và preview vùng ngoài gamut

**User Story:** As a người dùng, I want thấy rõ vùng không thể bù màu, so that tôi tự quyết định có in hay không thay vì bị bất ngờ vì màu lệch.

#### Acceptance Criteria

1. WHEN quá trình tái tách hoàn tất, THE Channel_Remover SHALL báo cáo Delta_E lớn nhất và Delta_E trung bình của toàn bộ màu đã xử lý.
2. IF tồn tại ít nhất một màu thuộc Out_Of_Gamut_Region, THEN THE Channel_Remover SHALL trả về cảnh báo nêu rõ có vùng không thể tái tạo bằng tập Kept_Channel.
3. THE Channel_Remover SHALL tạo preview tô đỏ (highlight) các Out_Of_Gamut_Region để người dùng nhận biết bằng mắt.
4. THE Channel_Remover SHALL không tuyên bố kết quả giống hệt bản gốc khi tồn tại Out_Of_Gamut_Region.

### Requirement 5: Xử lý màu vector trong content stream

**User Story:** As a kỹ thuật viên, I want các màu vector trong file được gỡ kênh đúng và an toàn, so that nội dung text/nét/đối tượng vector phản ánh đúng tập mực còn lại.

#### Acceptance Criteria

1. THE Channel_Remover SHALL dùng Content_Stream_Scanner để định vị các Vector_Color_Operator, tái dùng kỹ thuật quét byte an toàn của `overprint_black.py` và `preserve_black.py`.
2. THE Content_Stream_Scanner SHALL bỏ qua nội dung bên trong string literal, inline image (giữa toán tử BI/ID và EI), và comment khi định vị toán tử màu.
3. WHEN gặp toán tử `k` hoặc `K` với 4 toán hạng, THE Channel_Remover SHALL áp dụng phép biến đổi màu (theo Direct_Removal_Mode hoặc Re_Separation_Mode) cho giá trị CMYK đó.
4. WHEN gặp toán tử `scn` hoặc `SCN` đang ở color space DeviceCMYK với 4 toán hạng, THE Channel_Remover SHALL áp dụng phép biến đổi màu cho giá trị CMYK đó.
5. THE Channel_Remover SHALL không sửa đổi byte nằm ngoài các toán hạng màu được biến đổi (giữ nguyên cấu trúc content stream còn lại).

### Requirement 6: Xử lý ảnh CMYK trong XObject (MVP)

**User Story:** As a người dùng, I want ảnh CMYK trong file cũng được gỡ kênh, so that kết quả nhất quán giữa vector và ảnh.

#### Acceptance Criteria

1. WHERE một CMYK_Image_XObject dùng bộ lọc FlateDecode với color space DeviceCMYK hoặc ICCBased 4 kênh, THE Channel_Remover SHALL áp dụng phép biến đổi màu cho từng pixel theo chế độ đã chọn.
2. WHEN ghi lại ảnh đã biến đổi, THE Channel_Remover SHALL giữ nguyên kích thước pixel, số kênh và bộ lọc FlateDecode của ảnh.
3. WHERE một CMYK_Image_XObject dùng bộ lọc DCTDecode (JPEG-CMYK), THE Channel_Remover SHALL bỏ qua ảnh đó và ghi nhận cảnh báo rằng ảnh JPEG-CMYK chưa được xử lý ở phiên bản hiện tại.

### Requirement 7: Xử lý màu pha Spot/Separation

**User Story:** As a thợ chế bản, I want quy tắc rõ ràng cho màu pha, so that kết quả không bị sai màu spot ngoài ý muốn.

#### Acceptance Criteria

1. THE Channel_Remover SHALL cung cấp tùy chọn xử lý Spot_Color gồm hai lựa chọn: bỏ qua (giữ nguyên) hoặc chuyển Spot_Color sang CMYK trước rồi mới gỡ kênh.
2. WHERE tùy chọn "bỏ qua màu pha" được chọn, THE Channel_Remover SHALL giữ nguyên mọi toán tử và color space Separation/DeviceN.
3. WHERE tùy chọn "chuyển màu pha sang CMYK trước" được chọn, THE Channel_Remover SHALL chuyển Spot_Color sang CMYK trước khi áp dụng phép gỡ kênh cho các giá trị CMYK đó.

### Requirement 8: Giới hạn TAC

**User Story:** As a thợ in, I want giới hạn tổng lượng mực, so that file không vượt khả năng phủ mực của hệ in.

#### Acceptance Criteria

1. THE Channel_Remover SHALL cho phép cấu hình TAC_Limit với giá trị mặc định 360%.
2. WHEN một màu kết quả có TAC vượt TAC_Limit, THE Channel_Remover SHALL clamp các giá trị kênh sao cho TAC của màu kết quả ≤ TAC_Limit.
3. THE Channel_Remover SHALL bảo đảm mọi giá trị Process_Channel trong màu kết quả nằm trong khoảng 0% đến 100%.

### Requirement 9: Ghi và tải file kết quả

**User Story:** As a người dùng, I want tải file kết quả đã gỡ kênh, so that tôi dùng được file cho bước in tiếp theo.

#### Acceptance Criteria

1. WHEN xử lý hoàn tất thành công, THE Channel_Remover SHALL ghi file PDF kết quả vào Preflight_Output_Dir.
2. WHEN file kết quả đã được ghi, THE Channel_Remover SHALL trả về tên file để tải qua Download_Endpoint.
3. THE Channel_Remover SHALL được đăng ký như một action trong Action_Engine theo cùng quy ước với các action prepress hiện có.

### Requirement 10: Parity giữa preview và output

**User Story:** As a người dùng, I want preview khớp với file tải về, so that tôi tin tưởng vào những gì mình thấy.

#### Acceptance Criteria

1. WHERE Viewer_Preview được hiển thị cho kết quả gỡ kênh, THE Channel_Remover SHALL bảo đảm màu render trong preview khớp với màu trong file output (Parity).
2. WHEN preview và output được so trên artifact raster thực tế, THE Channel_Remover SHALL tạo kết quả có Delta_E giữa preview và output ≤ Gamut_Threshold cho cùng một vùng.

### Requirement 11: Xử lý ca biên đầu vào

**User Story:** As a người dùng, I want hệ thống báo lỗi rõ ràng với file bất thường, so that tôi biết cách khắc phục thay vì gặp lỗi mơ hồ.

#### Acceptance Criteria

1. IF file đầu vào có kích thước 0 byte, THEN THE Channel_Remover SHALL từ chối xử lý và trả về thông báo lỗi mô tả file rỗng.
2. IF file đầu vào không phải PDF hợp lệ, THEN THE Channel_Remover SHALL từ chối xử lý và trả về thông báo lỗi mô tả file không hợp lệ.
3. WHEN file đầu vào có nhiều trang, THE Channel_Remover SHALL áp dụng phép gỡ kênh cho mọi trang trong file.
4. WHERE một trang không chứa Process_Channel nào cần biến đổi, THE Channel_Remover SHALL giữ nguyên trang đó và đưa vào file kết quả.
5. IF file đầu vào không chứa nội dung CMYK nào (vector lẫn ảnh), THEN THE Channel_Remover SHALL ghi nhận cảnh báo rằng không có kênh nào bị thay đổi và vẫn trả về bản sao hợp lệ của file.

### Requirement 12: Tùy chọn xử lý layer ẩn/khóa

**User Story:** As a người dùng quen GMG dialog, I want tùy chọn xử lý layer ẩn/khóa, so that hành vi gỡ kênh rõ ràng với nội dung trong Optional Content Group.

#### Acceptance Criteria

1. THE Channel_Remover SHALL cung cấp tùy chọn "xử lý layer ẩn" (Optional Content Group ở trạng thái ẩn) bật/tắt.
2. WHERE tùy chọn "xử lý layer ẩn" tắt, THE Channel_Remover SHALL giữ nguyên màu của nội dung thuộc layer ẩn.
3. WHERE tùy chọn "xử lý layer ẩn" bật, THE Channel_Remover SHALL áp dụng phép gỡ kênh cho nội dung thuộc layer ẩn giống nội dung hiển thị.

### Requirement 13: Xác minh và kiểm thử hồi quy

**User Story:** As a maintainer, I want kết quả được xác minh bằng công cụ đo, so that độ chính xác bù màu được bảo đảm và không hồi quy.

#### Acceptance Criteria

1. THE Channel_Remover SHALL được kèm test đo Delta_E bằng littleCMS giữa màu gốc và màu kết quả cho tập màu tái tạo được, xác nhận Delta_E ≤ Gamut_Threshold.
2. THE Channel_Remover SHALL được kèm test raster bằng pypdfium2 xác nhận file kết quả render được và phản ánh tập Kept_Channel.
3. FOR ALL màu CMYK trong gamut của Kept_Channel, áp dụng Re_Separation_Mode hai lần liên tiếp SHALL tạo ra cùng một màu kết quả (tính idempotent của tái tách trên màu đã chỉ-dùng-Kept_Channel).
4. THE Channel_Remover SHALL được xác minh bằng môi trường venv của dự án (`backend\venv\Scripts\python.exe`).
