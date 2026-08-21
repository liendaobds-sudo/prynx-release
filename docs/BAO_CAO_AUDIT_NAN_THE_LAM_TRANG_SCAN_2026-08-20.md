# Báo cáo thiết kế: Nắn thẻ – Làm trắng scan

Ngày: 2026-08-20
Trạng thái: Đã duyệt và đã triển khai baseline ngày 2026-08-20

## 1. Mục tiêu đã chốt

Tạo một công cụ duy nhất mang tên **Nắn thẻ – Làm trắng scan**, thuộc **gói Free**, gồm hai chế độ:

1. **Nắn thẻ**: nhận ảnh điện thoại chụp CCCD, CMND, thẻ bảo hiểm và thẻ hình chữ nhật; tự tìm thẻ, tách vùng thẻ, nắn phối cảnh về góc nhìn trực diện và đúng tỷ lệ. Khi tự động không chắc chắn, người dùng kéo lại bốn góc.
2. **Làm trắng scan**: loại nền xám, sọc máy scan, bóng và ánh sáng không đều; có chế độ giữ màu, xám và đen trắng; không làm mất chữ, dấu hoặc chi tiết nhạt ngoài mức người dùng đã chọn.

Công cụ phải nhận ảnh đơn, nhiều ảnh và tài liệu scan PDF; cho xem trước trước/sau; xuất ảnh hoặc PDF mà không đổi sai kích thước vật lý.

## 2. Kết luận khả thi

Không cần thay nền tảng hoặc thêm framework xử lý ảnh mới. Backend hiện đã đóng gói OpenCV, NumPy, scikit-image, Pillow và ONNX Runtime (`backend/requirements.txt:31-79`). Hạ tầng upload ảnh, xử lý theo tab, xem trước, lưu batch và worker quản lý RAM cũng đã tồn tại.

Các khối lõi có thể tái sử dụng:

- Tách nền ISNet/BiRefNet: `backend/app/api/routes/pdf_tools.py:1830-1978` và các worker model hiện có.
- Nắn phối cảnh OpenCV: `backend/app/workers/logo_rebuild.py:432-461`.
- Cân bằng ánh sáng nền: `backend/app/workers/logo_rebuild.py:464-486`.
- Khử nhiễu, adaptive threshold và deskew: `backend/app/core/ocr_engine.py:36-76`.
- Giao diện kéo bốn góc: `desktop/src/components/preprocess-tools/LogoCompareViewport.tsx:376-396`.
- Store, picker, native path, TIFF preview và lưu batch: `desktop/src/components/preprocess-tools/imageBatch/`.

## 3. Các phát hiện và quyết định

### §DOC.01 — Quyền Free phải có mã tính năng riêng

- Mức: P0; effort: S.
- Bằng chứng: danh mục frontend và backend được kiểm tra parity tuyệt đối tại `backend/tests/test_feature_entitlements.py:72-91`.
- Quyết định: thêm `util.document_cleanup` với `minPlan: free` vào cả hai catalog. Route mới dùng `require_feature("util.document_cleanup")`.
- Không dùng quyền `util.bgremover`, vì quyền đó hiện là Pro (`desktop/src/lib/license/features.ts:37`; `backend/app/core/feature_entitlements.py:28-30`). Công cụ Free được phép tái sử dụng engine/mô hình bên trong, nhưng không gọi vòng qua endpoint Pro.

### §DOC.02 — Tách nền là bước hỗ trợ, không phải hình học cuối

- Mức: P1; effort: M.
- Bằng chứng: model tách nền trả mask mềm của vật thể; phép nắn hiện tại cần đúng bốn điểm có thứ tự và đã có kiểm tra vùng suy biến/lồi tại `backend/app/schemas/logo_rebuild.py:120-150`.
- Quyết định: pipeline nắn thẻ dùng mask AI để khoanh vùng, sau đó dùng contour/cạnh thẳng trên ảnh gốc để suy ra bốn giao điểm. Mask không được dùng trực tiếp làm bốn góc.
- Fallback: contour hình chữ nhật bằng OpenCV trước; AI mask khi nền phức tạp; cuối cùng là bốn điểm chỉnh tay.

### §DOC.03 — Tỷ lệ thẻ phải tách khỏi phép tìm góc

- Mức: P1; effort: S.
- Quyết định: có lựa chọn `Tự động`, `Thẻ ID-1 (85,60 × 53,98 mm)` và `Tùy chỉnh`. CCCD, CMND dạng thẻ và phần lớn thẻ bảo hiểm dùng preset ID-1. Không đoán loại giấy tờ từ nội dung cá nhân.
- Phép warp dùng kích thước đích từ preset; metadata DPI được ghi để kích thước in đúng.

### §DOC.04 — Bảo vệ dữ liệu giấy tờ cá nhân

- Mức: P0; effort: S.
- Quyết định: toàn bộ xử lý chạy cục bộ trong sidecar; không gửi ảnh ra Internet; không OCR hoặc lưu số giấy tờ; file tạm theo vòng đời artifact hiện có và được dọn sau response/tab.

### §DOC.05 — Làm trắng scan cần ba chế độ, không dùng một threshold cố định

- Mức: P1; effort: M.
- Bằng chứng: OCR hiện có adaptive threshold tốt cho chữ nhưng đầu ra nhị phân (`backend/app/core/ocr_engine.py:47-64`); illumination correction hiện giữ màu trong LAB (`backend/app/workers/logo_rebuild.py:464-486`).
- Quyết định:
  - `Giữ màu`: ước lượng nền theo vùng lớn, cân bằng kênh sáng trong LAB, giữ dấu/chữ ký/ảnh.
  - `Xám sạch`: chuẩn hóa nền và tương phản cục bộ trên grayscale.
  - `Đen trắng`: adaptive threshold có lọc nhiễu, dành cho photocopy.
- Có thanh `Mức làm sạch` và preview trước/sau. Mặc định không dùng cấu hình mạnh nhất.

### §DOC.06 — PDF scan phải giữ kích thước trang

- Mức: P1; effort: L.
- Quyết định: ảnh input xuất PNG/PDF theo lựa chọn; PDF input xử lý từng trang rồi ráp lại đúng MediaBox/kích thước vật lý. Không biến một tài liệu A4 thành ảnh có kích thước suy đoán từ pixel.
- Xử lý PDF qua scheduler hiện có; vùng gọi PDFium phải tuân thủ `pdfium_guard()` và nhả khóa trước phần OpenCV.

### §DOC.07 — Không sửa trực tiếp công cụ Tách nền hoặc Vector hóa Logo

- Mức: P1; effort: S.
- Quyết định: tái sử dụng worker/hàm thuần hoặc tách helper dùng chung có test. Không đổi response/mask của endpoint Tách nền Pro, vì thay mask thượng nguồn có thể làm hồi quy tóc/biên mềm. Không nhét chức năng mới vào workspace Vector hóa Logo.

## 4. Hợp đồng giao diện đề xuất

Một thẻ công cụ ở nhóm Ảnh:

- Tên: **Nắn thẻ – Làm trắng scan**
- Mô tả: **Nắn ảnh giấy tờ chụp xiên, làm sạch nền xám của bản scan**
- Quyền: **Free**, không hiển thị huy hiệu Pro.
- Chạy độc lập khi chưa mở PDF và cũng nhận file đang mở trong workspace.

Trong công cụ có hai tab:

### Nắn thẻ

- Tự nhận diện bốn góc.
- Overlay bốn điểm có thể kéo.
- Tỷ lệ: Tự động / ID-1 / Tùy chỉnh.
- Nút xoay 90°, đổi ngang/dọc, đặt lại góc.
- Cảnh báo rõ khi độ tin cậy thấp; không âm thầm xuất kết quả sai.

### Làm trắng scan

- Chế độ: Giữ màu / Xám sạch / Đen trắng.
- Mức làm sạch.
- Tùy chọn nắn xoay nhẹ và loại bóng nền.
- So sánh trước/sau ở zoom 1:1.

## 5. Kiến trúc triển khai

Luồng dự kiến:

`Tool UI → API document-cleanup → worker document_cleanup_engine → OpenCV/AI mask → artifact ảnh/PDF → workspace hoặc lưu batch`

Engine mới chỉ điều phối các phép thuần:

1. Decode + EXIF orientation + kiểm kích thước/RAM.
2. `detect_card_quad`: contour nhanh → AI mask fallback → fit bốn cạnh → confidence.
3. `rectify_card`: validate/sort bốn điểm → warpPerspective → gắn DPI/tỷ lệ.
4. `clean_scan`: ước lượng nền → cân bằng → bảo vệ nét/chữ/dấu → mode output.
5. PDF adapter: render từng trang có khóa PDFium ngắn, xử lý OpenCV ngoài khóa, ráp đúng kích thước.

## 6. Lô triển khai và cổng kiểm thử

Mỗi lô không quá năm file.

### Lô A — Engine ảnh thuần

- Worker nắn thẻ/làm trắng scan.
- Test ảnh tổng hợp: phối cảnh, góc bo, nền xám gradient, sọc dọc/ngang, dấu màu và chữ xám nhạt.
- Chưa nối UI.

### Lô B — API, PDF adapter và quyền Free

- Route nhận ảnh/PDF, schema validate, scheduler/cancel và cleanup artifact.
- Thêm `util.document_cleanup: free` ở frontend/backend catalog.
- Test parity entitlement và xác nhận Free gọi được, feature lạ vẫn fail-closed.

### Lô C — Store/API client và workspace công cụ

- Store theo tab, hủy request khi đóng/chuyển tab.
- Hai chế độ UI, preview trước/sau và editor bốn góc.
- Tận dụng imageBatch cho picker/TIFF/native path, không sao chép logic đọc file.

### Lô D — Routing và Home

- Đăng ký tool, ActiveToolType, PreprocessingRouter, overlay workspace và tab navigation.
- Test mở từ Home, chuyển từ tab PDF, tab nền không nhận file, đóng tab không commit muộn.

### Lô E — i18n, golden corpus và runtime

- Chuỗi Việt/Anh.
- Chạy typecheck, Vitest liên quan, pytest engine/API/entitlement.
- Kiểm tay app thật với ảnh điện thoại và PDF scan nhiều trang.

## 7. Tiêu chí nghiệm thu

1. Gói Free mở và chạy được cả hai chế độ ở frontend lẫn backend production gate.
2. Ảnh thẻ có bốn góc nhìn thấy được tự nắn; trường hợp confidence thấp buộc người dùng xác nhận/chỉnh góc.
3. Preset ID-1 xuất đúng tỷ lệ 85,60:53,98, không kéo méo theo bounding box nguồn.
4. Làm trắng nền xám nhưng bộ test bảo vệ chữ xám nhạt và dấu màu không bị xóa ở mức mặc định.
5. PDF nhiều trang giữ số trang và kích thước vật lý từng trang.
6. Mọi xử lý cục bộ, request hủy được, file tạm được dọn.
7. Không làm thay đổi kết quả hiện tại của Tách nền, Upscale và Vector hóa Logo.

## 8. Dữ liệu còn cần để tinh chỉnh chất lượng

Engine và test tổng hợp có thể triển khai ngay. Trước khi gọi là ổn định cho khách hàng, cần bộ mẫu ẩn danh gồm:

- Ảnh thẻ nền đơn giản và nền phức tạp.
- Chụp xiên mạnh, bóng đổ, lóa, tay cầm, góc thẻ bị che.
- Scan nền xám, sọc dọc/ngang, giấy ngả vàng.
- Tài liệu có dấu đỏ/xanh, chữ ký và chữ in mờ.

Không cần ảnh còn số giấy tờ thật; có thể che thông tin cá nhân nhưng phải giữ nguyên biên thẻ, ánh sáng và lỗi scan.

## 9. Kết quả triển khai

Đã hoàn tất các lô A → E. Công cụ đã được nối vào Home/workspace, có quyền Free,
nhận ảnh và PDF scan nhiều trang, xử lý cục bộ, lưu đúng định dạng và có bản dịch
Việt–Anh. Chi tiết thay đổi và bằng chứng kiểm thử nằm trong
`docs/NAN_THE_LAM_TRANG_SCAN_FIXES_2026-08-20.md`.
