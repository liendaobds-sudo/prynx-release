# Tiến độ triển khai: Nắn thẻ – Làm trắng scan

## Lô A — Engine ảnh thuần

Trạng thái: Hoàn tất.

- `backend/app/workers/document_cleanup_engine.py`
  - Dò tứ giác bằng contour/cạnh ảnh, nhận mask AI tùy chọn và trả confidence.
  - Nắn phối cảnh theo bốn góc, hỗ trợ tỷ lệ ID-1 85,60 × 53,98 mm.
  - Làm trắng scan ba chế độ: giữ màu, xám sạch, đen trắng; tùy chọn bỏ bóng và deskew.
- `backend/tests/test_document_cleanup_engine.py`
  - Khóa hình học ảnh điện thoại tổng hợp, thứ tự góc, tỷ lệ đầu ra.
  - Khóa nền gradient/sọc, dấu đỏ, chữ xám nhạt và output nhị phân.

Verify: `backend\venv\Scripts\python.exe -m pytest backend\tests\test_document_cleanup_engine.py -q` → 5 passed.

## Lô B — API và quyền Free

Trạng thái: Hoàn tất cho đầu vào ảnh.

- Route `/api/document-cleanup/detect-card` trả bốn góc chuẩn hóa, confidence và cờ cần kiểm tra.
- Route `/api/document-cleanup/process` nắn thẻ/làm trắng scan, giữ metadata DPI phù hợp.
- Dò OpenCV trước; khi confidence thấp mới dùng mask ISNet của engine Tách nền rồi fit lại cạnh hình học.
- Thêm `util.document_cleanup` ở hai catalog entitlement với `minPlan: free`.
- Đăng ký router trong FastAPI.

Verify: engine + API + entitlement → 17 passed.

## Lô C — Store, client và workspace

Trạng thái: Hoàn tất.

- Store độc lập theo tab, lưu bốn góc theo từng ảnh và dọn object URL khi đóng.
- Sidebar chung có hai chế độ Nắn thẻ/Làm trắng scan, preset ID-1, tùy chỉnh kích thước, ba kiểu làm sạch và mức cường độ.
- Preview ảnh gốc/kết quả, overlay tứ giác với bốn điểm kéo được.
- Batch tự detect trước khi xử lý và chỉ gửi một request process cho mỗi ảnh.

Verify: 3 test component passed; TypeScript typecheck passed.

## Lô D — Routing và Home

Trạng thái: Hoàn tất.

- Đăng ký công cụ ở Home với feature Free và focusFeature `document_cleanup`.
- Nối ActiveToolType, WORKSPACE_TOOL_PANEL, PreprocessingRouter và workspace preview.
- Thêm tuyến native drop theo tab đang active; tab nền không nhận file.
- Shell gọi disposer khi đóng tab.

Verify: 40 test routing/component passed; TypeScript typecheck passed.

## Lô E — PDF nhiều trang, i18n và verify cuối

Trạng thái: Hoàn tất baseline.

- PDF scan được render từng trang trong `pdfium_guard()`, nhả khóa trước OpenCV và
  dựng lại đúng số trang/MediaBox bằng ReportLab.
- Picker và batch nhận ảnh/PDF; khi có PDF tự chuyển sang Làm trắng scan; file kết
  quả được lưu đúng `.png` hoặc `.pdf`.
- Header tải file hỗ trợ tên tiếng Việt theo RFC 5987, tránh lỗi response khi tên
  nguồn có dấu.
- Thêm chuỗi Việt–Anh và từ khóa tìm kiếm cho CCCD/CMND/thẻ bảo hiểm/scan.
- Route và hai catalog quyền đều chốt `util.document_cleanup` là Free.

Verify cuối:

- Backend engine + API + entitlement: 20 passed.
- Frontend routing + component + store + i18n: 49 passed.
- `tsc --noEmit`: passed.
- `git diff --check`: passed.
- Lint toàn repo còn thất bại ở baseline cũ (1.599 finding trên nhiều module không
  thuộc công cụ); lint riêng file mới không có lỗi ngoài các finding có sẵn trong
  router/helper dùng chung.

Giới hạn chất lượng: bộ test hiện dùng ảnh tổng hợp. Trước khi chốt preset mặc định
cho mọi máy scan/điện thoại, vẫn cần corpus ảnh thật đã che thông tin cá nhân để tinh
chỉnh confidence, độ mạnh làm trắng và các ca lóa/che góc.

## Bổ sung DOC.PDF.01 — Viewer PDF thật

- Nguyên nhân: overlay `DocumentCleanupPreview` phủ lên `AcrobatViewer` và chỉ vẽ
  placeholder cho PDF, nên tài liệu đang mở biến mất khỏi khung xem.
- PDF nay dùng trực tiếp `AcrobatViewer` hiện có trong lúc xử lý; ảnh vẫn dùng overlay
  chỉnh bốn góc riêng.
- Khi làm trắng PDF thành công, artifact kết quả được commit lại vào working file để
  viewer nạp ngay bản đã xử lý; callback bị chặn thì item chuyển sang lỗi, không báo
  thành công giả.
- PDF dùng nút Hoàn tác của viewer/history sau khi commit; nút hoàn tác cục bộ chỉ
  còn hiện cho ảnh để không tạo hai cơ chế hoàn tác lệch trạng thái.
- Chặn PDF kết quả tự bị thêm lần nữa vào batch sau khi viewer đổi working file.

Verify DOC.PDF.01: TypeScript typecheck passed; 25 test component/i18n/router passed.
