# BÁO CÁO AUDIT RESIZE + XÓA VIỀN TRẮNG

**Ngày:** 2026-07-31  
**Phạm vi:** `PageResizerTool` → `runResize` → `preflight/auto-trim` / `preflight/mirror-bleed` / `sticker-dieline` → resize frontend hoặc `/pdf-tools/resize`.  
**Trạng thái:** Giai đoạn 2 — chờ duyệt danh sách phát hiện trước khi sửa.

## 1. Tóm tắt điều hành

Lỗi người dùng báo đã được tái hiện và có nguyên nhân xác định, không phải lỗi hiển thị ngẫu nhiên.

Luồng mới xóa viền trắng theo từng trang, nhưng phần mở nền có ba bất nhất chính:

1. Trang có `/Rotate != 0` đi vào nhánh mirror chỉ được nới `MediaBox/CropBox`, **không được vẽ nội dung mirror**. Kết quả là vùng mới nới ra màu trắng.
2. Sau khi auto-trim làm mỗi trang có khổ/tỉ lệ riêng, frontend vẫn chỉ đọc kích thước **trang đầu tiên** để tính một lượng bleed chung cho cả tài liệu.
3. Đường frontend và backend không có cùng hợp đồng nền. File nhỏ có thể đi frontend, file lớn/downsample đi backend; backend không nhận `bgFillMode/bgFillColor`, nên cùng một lựa chọn UI có thể cho kết quả khác nhau theo kích thước file, DPI và nội dung.

Nhánh màu trơn không cần lấy pixel mép hoặc mirror nên che được triệu chứng trên đường frontend. Tuy nhiên mã hiện tại còn lệch tên mode `solid` ↔ `color`, khiến typecheck thất bại và màu đã chọn không được bảo đảm trên mọi đường xử lý.

## 2. Bằng chứng tái hiện

### 2.1 Ca tối thiểu

- Tạo PDF hai trang có cùng kích thước nội dung và cùng nền đỏ.
- Trang 1: `/Rotate=0`.
- Trang 2: `/Rotate=90`.
- Chạy `PageBoxesEngine.add_mirror_bleed(..., 20mm)` rồi `resize_pages(..., "fill", "all")` về A4.
- Render kết quả bằng PDFium và đo dải 8 px quanh bốn cạnh.

Kết quả:

| Trang | Tỷ lệ pixel trắng ở viền | Tỷ lệ pixel đỏ ở viền |
|---|---:|---:|
| 1 — `/Rotate=0` | 0,0% | 100,0% |
| 2 — `/Rotate=90` | **83,7%** | 16,3% |

Đây là cùng hiện tượng “trang phủ kín, trang dư trắng trên/dưới hoặc trái/phải” mà người dùng báo.

### 2.2 Baseline tự động

- `npm run typecheck`: **FAIL** với 2 lỗi tại `PageResizerTool.tsx:156,170` do mode UI không khớp union type.
- `pytest tests/test_page_boxes_autotrim.py tests/test_mirror_bleed_origin.py tests/test_resize_smart.py -q`: **29 passed, 1 skipped**.
- Kết luận: test cũ đều xanh nhưng chưa phủ chuỗi tích hợp có trang xoay/nhiều tỉ lệ.

## 3. Bảng phát hiện

| Mã | Mức | Effort | Phát hiện |
|---|---|---:|---|
| §A.1 | **P1** | M | Mirror-bleed không vẽ nền cho trang có `/Rotate != 0`; đã tái hiện 83,7% viền trắng |
| §A.2 | **P1** | M | Tính bleed từ trang đầu rồi áp chung cho mọi trang sau auto-trim |
| §A.3 | **P1** | M | `center_no_scale` bị đổi ngầm thành `fill`, làm sai cam kết giữ nguyên kích thước |
| §A.4 | **P1** | M | `applyTo` chỉ áp ở bước resize cuối; auto-trim/mở nền vẫn sửa mọi trang |
| §B.1 | **P1** | M | Hợp đồng frontend/backend thiếu parity cho mode nền; kết quả phụ thuộc đường fallback |
| §B.2 | **P1** | S | Tên mode `solid/inpaint/image` không khớp type/engine `white/color/mirror`; build không sạch |
| §B.3 | P2 | S | Mở nền thất bại bị nuốt thành warning console rồi tiếp tục xuất file viền trắng |
| §C.1 | P2 | M | Auto-trim lấy file gốc thay vì working bytes, có thể bỏ qua sửa trang đang chờ bake |
| §C.2 | P2 | S | Hai route auto-trim/mirror chạy CPU/PDF đồng bộ trong `async def`, có thể chặn API |
| §D.1 | **P1** | M | Thiếu regression tích hợp cho rotated/mixed-size/backend-fallback/applyTo |

## 4. Chi tiết phát hiện

### §A.1 — Trang xoay chỉ được nới box, không có mực nền

**Bằng chứng:**

- `backend/app/core/page_boxes.py:1112-1114` ghi rõ mirror không xử lý trang `/Rotate != 0`.
- `backend/app/core/page_boxes.py:1139-1151` ở nhánh trang xoay chỉ set `MediaBox`, `CropBox`, `BleedBox`, `TrimBox` rồi `continue`; không sinh các phép vẽ mirror tại `:1200-1213`.
- Phép tái hiện §2.1 đo được trang xoay có 83,7% pixel viền trắng.

**Tác động:** PDF có trang xoay hỗn hợp cho kết quả đúng/sai theo từng trang. Hướng viền trắng thay đổi theo `/Rotate`, khớp mô tả trên/dưới hoặc trái/phải.

**Khuyến nghị:** chuẩn hóa không gian trang (`/Rotate=0`, gốc `(0,0)`) trước bước auto-trim/mirror bằng một helper dùng chung, hoặc bổ sung ma trận mirror đúng cho bốn góc xoay. Không tiếp tục nhánh “set box nhưng không vẽ”.

### §A.2 — Hình học trang đầu bị dùng cho toàn tài liệu

**Bằng chứng:**

- Auto-trim xử lý và set `MediaBox/CropBox` riêng từng trang tại `backend/app/core/page_boxes.py:946-1013`.
- `desktop/src/lib/processHandlers.ts:572-581` chỉ mở `srcDoc.getPage(0)`, tính `fitScale`, gap và `bleedMm` từ trang đầu.
- Một `bleed_mm` chung được gửi cho toàn tài liệu tại `processHandlers.ts:590-624`.

**Tác động:** sau auto-trim, trang có tỉ lệ khác trang đầu có thể thiếu vùng nền cần thiết. Vì bước cuối đổi sang `fill`, thiếu bleed còn có thể cắt vào nội dung gốc chứ không chỉ gây viền.

**Khuyến nghị:** tính nhu cầu theo từng trang trong backend và xử lý từng trang theo geometry của chính nó. Không lấy trang 1 làm đại diện cho PDF nhiều trang.

### §A.3 — `center_no_scale` mất ngữ nghĩa

**Bằng chứng:**

- `processHandlers.ts:567` đưa cả `fit` và `center_no_scale` qua pipeline mở nền.
- Khi mở nền thành công, `processHandlers.ts:627-630` gán `effectiveScaleMode = 'fill'`.
- Hành vi chuẩn của `center_no_scale` là scale `1.0`, chỉ canh giữa: frontend `PageResizer.ts:130-133`, backend `pdf_tools_engine.py:241-245`.

**Tác động:** người dùng chọn “Giữ nguyên ở giữa” nhưng tài liệu vẫn bị phóng/thu và crop theo `fill`.

**Khuyến nghị:** nền phải được tạo độc lập với phép biến đổi nội dung; tuyệt đối không đổi scale mode để lấp nền.

### §A.4 — Phạm vi trang không được tôn trọng ở tiền xử lý

**Bằng chứng:**

- Request auto-trim tại `processHandlers.ts:537-543` không gửi `pages`.
- Request mirror tại `:592-596` không gửi `pages`; nhánh sticker đặt `cut_first_page_only=false` tại `:617`.
- Chỉ bước resize cuối mới nhận `settings.applyToStr` tại `:693-716`.

**Tác động:** chọn trang chẵn/lẻ/dải tùy chỉnh vẫn làm đổi box hoặc thêm bleed cho các trang ngoài lựa chọn.

**Khuyến nghị:** parse phạm vi một lần và truyền cùng danh sách trang xuyên suốt pipeline.

### §B.1 — Fallback backend làm mất cấu hình nền

**Bằng chứng:**

- Frontend truyền `bgFillMode/bgFillColor` vào `resizePages` tại `processHandlers.ts:716`.
- `desktop/src/lib/api.ts:668-683` và route `backend/app/api/routes/pdf_tools.py:482-489` không có hai tham số này.
- `processHandlers.ts:699-702` bắt buộc dùng backend khi downsample, file lớn, nhiều trang hoặc pdf-lib không parse được.
- Raster backend luôn dựng canvas trắng tại `backend/app/workers/pdf_tools_engine.py:490`.

**Tác động:** cùng cài đặt nhưng file nhỏ có thể có nền, còn file lớn/downsample lại trắng. Đây là nguồn “lúc được lúc không” thứ hai ngoài `/Rotate`.

**Khuyến nghị:** đưa toàn bộ auto-trim + tạo nền + resize vào một hợp đồng backend thống nhất; frontend chỉ gửi tham số và hiển thị tiến độ. Đường frontend nếu còn giữ phải có test parity byte/render với backend.

### §B.2 — Mode UI, type và engine không cùng từ vựng

**Bằng chứng:**

- UI khai `mirror/inpaint/image/solid` tại `PageResizerTool.tsx:10-15`.
- `PageResizerSettings.bgFillMode` và `ResizeOptions.bgFillMode` chỉ cho `white/color/mirror` tại `PageResizerTool.tsx:44`, `PageResizer.ts:20`.
- Engine chỉ đọc màu khi mode bằng `color` tại `PageResizer.ts:139-147`; `solid` rơi vào mặc định trắng.
- Typecheck báo TS2322 và TS2367 tại `PageResizerTool.tsx:156,170`.

**Tác động:** bản hiện tại không đạt chốt build; màu trơn do UI phát ra không được engine diễn giải nhất quán.

**Khuyến nghị:** tạo một type dùng chung và một mapping duy nhất; ưu tiên giữ tên theo nghiệp vụ UI (`mirror | inpaint | image | solid`) rồi validate tại ranh giới API.

### §B.3 — Thất bại bị hạ thành file kết quả sai

**Bằng chứng:** `processHandlers.ts:597-625` chỉ lấy blob khi response OK; nếu không có blob, `:631-633` chỉ `console.warn` rồi tiếp tục resize.

**Tác động:** người dùng nhận file thành công nhưng có viền trắng, không biết bước mở nền đã thất bại.

**Khuyến nghị:** fail-closed với thông báo tiếng Việt cho mode được chọn, hoặc hỏi người dùng có muốn tiếp tục bằng màu trơn; không xuất âm thầm kết quả khác yêu cầu.

### §C.1 — Auto-trim có thể dùng bản PDF cũ

**Bằng chứng:** `processHandlers.ts:534` gọi `uploadPDF(file)` trước khi lấy `getWorkingBytes()` tại `:647-660`.

**Tác động:** thay đổi trang/rotation/edit đang nằm trong working state có thể không đi vào auto-trim, trong khi resize sau đó lại dùng file trung gian từ bản gốc.

**Khuyến nghị:** chốt một nguồn đầu vào duy nhất đã bake; toàn pipeline phải dùng cùng nguồn đó.

### §C.2 — Route tiền xử lý chặn event loop

**Bằng chứng:** `preflight.py:1011-1018` và `:1072-1080` là `async def` nhưng gọi trực tiếp `engine.auto_trim` / `engine.add_mirror_bleed`. Auto-trim render PDFium 200 DPI và chạy OpenCV cho từng trang tại `page_boxes.py:943-1007`.

**Tác động:** PDF dài có thể làm health/progress/API khác đứng trong thời gian xử lý.

**Khuyến nghị:** bọc engine đồng bộ bằng `run_in_threadpool`; giữ `pdfium_guard()` ngắn như hiện tại, không đưa OpenCV vào vùng khóa.

### §D.1 — Test xanh nhưng không bảo vệ pipeline mới

**Bằng chứng:**

- `test_page_boxes_autotrim.py` chỉ test hàm ánh xạ bbox theo rotation.
- `test_mirror_bleed_origin.py` chỉ dựng trang `/Rotate=0`; ca zero-bleed không kiểm nội dung nền.
- `preprocessEngine.test.ts:159-190` chỉ kiểm kích thước/số trang, không render đo viền hoặc màu.
- Không có test tích hợp `auto-trim → background fill → resize`.

**Khuyến nghị bắt buộc:** thêm ma trận test render-pixel cho 0/90/180/270°, nhiều tỉ lệ trang, mode nền, frontend/backend fallback, trang trắng và `applyTo`.

## 5. Điểm đã kiểm chéo, không coi là bug

- Backend resize chủ ý dùng `MediaBox` để giữ bleed và mang `TrimBox/BleedBox/ArtBox` sang trang mới (`pdf_tools_engine.py:172-275`). Không đề xuất quay về CropBox chung.
- Downsample sau resize là hành vi chủ ý, đã có tài liệu và regression; vấn đề là hợp đồng nền không đi cùng đường backend, không phải bản thân downsample.
- `pdfium_guard()` trong auto-trim đang giữ phạm vi theo từng trang và để OpenCV ngoài khóa (`page_boxes.py:933-985`); đây là thiết kế đúng, không mở rộng vùng khóa.

## 6. Thứ tự sửa đề xuất

### Lô 1 — Chặn sai kết quả cốt lõi, tối đa 5 file

1. Chuẩn hóa page space trước mirror hoặc hỗ trợ mirror đúng cho `/Rotate`.
2. Chuyển tính geometry nền sang theo từng trang.
3. Giữ nguyên scale mode; nền và nội dung là hai lớp độc lập.
4. Thêm regression backend cho rotated + mixed-ratio + pixel border.

File dự kiến: `backend/app/core/page_boxes.py`, `backend/app/workers/pdf_tools_engine.py`, `backend/app/api/routes/pdf_tools.py`, một file test mới hoặc `test_resize_smart.py`.

### Lô 2 — Hợp nhất hợp đồng frontend/backend, tối đa 5 file

1. Một type/mapping mode nền duy nhất.
2. Gửi auto-trim, mode nền, màu và danh sách trang qua API resize.
3. Dùng working bytes đã bake làm nguồn duy nhất.
4. Không nuốt lỗi mở nền.

File dự kiến: `PageResizerTool.tsx`, `PageResizer.ts`, `processHandlers.ts`, `api.ts`, `preprocSlice.ts`.

### Lô 3 — Verify và phản hồi tác vụ

1. Test TS cho màu trơn, trang trắng, `applyTo` và parity fallback.
2. Route preflight chạy trong threadpool.
3. Typecheck + vitest phạm vi + pytest mới + thao tác thật trên file khách.

## 7. Tiêu chí nghiệm thu

- 4 góc `/Rotate` cho cùng kết quả không viền trắng.
- PDF nhiều trang khác khổ/tỉ lệ: mỗi trang giữ trọn nội dung với `fit`, không dùng geometry trang đầu.
- `center_no_scale` giữ đúng kích thước vật lý nội dung.
- `applyTo` không thay đổi trang ngoài lựa chọn ở bất kỳ bước nào.
- `solid` dùng đúng màu đã chọn ở cả frontend/backend; `mirror/inpaint/image` không rơi về trắng âm thầm.
- File nhỏ/lớn, DPI off/auto/custom và mode vector/raster cho cùng quy tắc nền.
- `npm run typecheck` xanh; test render-pixel mới xanh; chạy thật trên PDF người dùng xác nhận.

## 8. Chốt duyệt

Theo quy trình audit PrynX, báo cáo dừng tại đây. Chưa sửa mã nguồn. Sau khi chủ dự án duyệt, triển khai từng lô tối đa 5 file và verify xong từng lô trước khi sang lô tiếp theo.
