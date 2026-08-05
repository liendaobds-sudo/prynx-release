# Sửa lỗi luồng In native — 2026-08-05

Tài liệu này chốt các lô sửa sau `BAO_CAO_AUDIT_IN_NATIVE_2026-08-05.md`.

Phạm vi: hộp thoại In của PrynX → worker riêng process → Windows GDI/Print Spooler.
Không thay đổi luồng CorelDRAW/Illustrator, xuất dữ liệu máy bế hay pipeline release.

## Lô 1 — vòng đời hộp thoại và lỗi hiển thị

- `§PRINT.02`: không còn gỡ hộp thoại ngay khi bấm **In**. File tạm và promise chỉ được kết thúc khi job thành công, người dùng hủy, hoặc dialog đóng.
- `§PRINT.04`: bỏ fallback mù. Lỗi direct-print được giữ nguyên và hiển thị; **Thử hộp thoại Windows** chỉ chạy khi người dùng chủ động chọn.
- `§PRINT.06`: PDF.js preview lỗi chỉ hiện cảnh báo, không khóa engine in native.
- PrintDlg chạy trong worker vẫn giữ HWND của cửa sổ PrynX nên không còn mở khuất phía sau app.

## Lô 2 — job-id, progress và cancel xuyên process

- `§PRINT.03`: mỗi dialog có `print_job_id` riêng.
- Registry active worker chỉ chứa `PrintDirect`; list printer, geometry và properties không thể ghi đè PID job in.
- Worker nhận cancel qua file token và gọi `AbortDoc` ở ranh giới tờ. Nếu driver treo không hợp tác, chỉ PID của đúng job đó bị kết thúc sau 2 giây.
- Progress được worker ghi theo job, parent chuyển tiếp qua event và UI bỏ qua event của tab/job khác.
- `§PRINT.05`: log có job-id PrynX, job-id spooler và stage `start_doc`, `rendering`, `abort_doc`, `end_doc`, `spooler_status`.
- Sau `EndDoc`, PrynX đọc `GetJobW` một lần để ghi lại trạng thái spooler; `JOB_STATUS_ERROR` được trả về như lỗi thật thay vì báo thành công.

## Lô 3 — Microsoft Print to PDF và tài liệu nhiều khổ

- `§PRINT.01`: `PrinterInfo` có driver, port, `requires_output_path` và phần mở rộng đầu ra.
- `PORTPROMPT:`, `FILE:` và các driver PDF/XPS phổ biến được phân loại trước khi in.
- PrynX yêu cầu người dùng chọn file đích trước khi tạo job máy in file. Hủy Save dialog không tạo job và không đóng Print dialog.
- Output path đi đủ qua TypeScript → Tauri command → worker JSON → `print_direct_blocking()` → `DOCINFOW.lpszOutput`.
- `§PRINT.07`: preview cache kích thước theo từng page number; chế độ Size tính Fit/Shrink/Actual bằng MediaBox của đúng trang, không lấy kích thước trang 1 áp cho PDF mixed-size.

## Kiểm thử hồi quy

### Tự động

- Frontend liên quan: **10/10 đạt**
  - dialog còn sống khi direct job pending;
  - lỗi direct không tự gọi fallback;
  - fallback chỉ chạy sau click;
  - preview lỗi vẫn in được;
  - chọn/hủy output path;
  - cancel mang đúng job-id;
  - mixed-size dùng kích thước/tỷ lệ riêng.
- `desktop` typecheck: đạt.
- ESLint mục tiêu cho các file in: đạt, không còn warning mới.
- Rust module print: **28 đạt, 1 smoke runtime được đánh dấu chạy thủ công**.
- Rust toàn thư viện: **63 đạt, 0 lỗi, 1 smoke runtime ignored** trong gate mặc định.

### Runtime có kiểm soát

Đã chạy smoke thật với:

- Printer: `Microsoft Print to PDF`
- Input: `print_engine/golden/fixtures/gray_black.pdf`
- Output: `tmp/print_smoke_20260805_165340.pdf`
- Kết quả: job hoàn tất; file **896 byte** được tạo; PDFium mở lại thành công; đúng **1 trang** và MediaBox có kích thước hợp lệ.

Smoke này chứng minh đường `lpszOutput` mới hoạt động trên đúng driver/cổng gây nghi ngờ mạnh nhất trong audit.

## Trạng thái bằng chứng còn lại

- Microsoft Print to PDF: `RUNTIME`.
- Lifecycle/error/cancel/protocol: `TESTED`; cancel driver thật chưa được kích hoạt để tránh tạo job hỏng có chủ đích.
- Adobe PDF: `TRACED`, chưa chạy runtime.
- Máy in vật lý: chưa có thiết bị trên máy audit nên chưa thể smoke; không được suy diễn từ máy in ảo.
- Chưa build installer/release, chưa commit và chưa push trong đợt sửa này.
- Không sửa `docs/PRYNX_MASTER_AUDIT_MATRIX.md` vì file đang có thay đổi chưa commit của luồng audit khác.
