# Báo cáo audit luồng In native — 2026-08-05

## 1. Phạm vi và kết luận điều hành

Audit unit: người dùng mở PDF/kết quả bình bài → bấm **In** → chọn máy in → gửi một job → job hoàn tất hoặc báo lỗi/hủy có nguyên nhân.

Không thuộc phạm vi: xuất dữ liệu máy bế, mở CorelDRAW/Illustrator, engine chế bản PDF và phát hành bản cài.

Kết luận:

- Luồng đã được truy vết đủ từ UI tới Windows GDI/spooler, mức bằng chứng hiện tại là **`TRACED`**. Chưa nâng `RUNTIME` vì chưa chạy lại một job in có kiểm soát trên bản app thật.
- Có **4 finding P1** và **4 finding P2** đã xác nhận bằng code/thiết bị hiện tại.
- Dấu hiệu “job 1 xuất hiện rồi tự hủy” xảy ra khi job đã qua `StartDocW` nhưng đường sau đó lỗi và PrynX gọi `AbortDoc`, hoặc spooler/driver hủy sau khi PrynX đã trả thành công. PrynX hiện không lưu đủ stage/job-id để chỉ ra lỗi nào trong lần người dùng vừa gặp.
- Nguyên nhân khớp mạnh nhất trên máy audit: máy in mặc định là **Microsoft Print to PDF**, driver `Microsoft Print To PDF`, cổng `PORTPROMPT:`; nhưng PrynX đưa máy in này vào đường in thẳng và để `DOCINFOW.lpszOutput = NULL`. Hợp đồng hiện tại không có nơi cho người dùng chọn file đầu ra trước khi gửi job.

## 2. Baseline máy audit

### 2.1 Thiết bị Windows đang có

| Máy in | Mặc định | Driver | Cổng |
|---|---:|---|---|
| Microsoft Print to PDF | Có | Microsoft Print To PDF | `PORTPROMPT:` |
| Adobe PDF | Không | Adobe PDF Converter | `Documents\\*.pdf` |
| OneNote (Desktop) | Không | Send to Microsoft OneNote 16 Driver | `nul:` |

Không có máy in vật lý trong danh sách hiện tại, vì vậy audit chưa được phép kết luận đường in vật lý đã hỏng hay đã đúng.

### 2.2 Tài liệu Windows dùng làm oracle

- Microsoft xác định `StartDocW` bắt đầu job và trả về job-id; job-id này có thể dùng với `GetJob`/`SetJob`.
- `DOCINFOW.lpszOutput` là tên file đầu ra; nếu `NULL`, dữ liệu được gửi tới thiết bị/cổng của HDC.

Nguồn: [StartDocW](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-startdocw), [DOCINFOW](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-docinfow).

### 2.3 Test baseline đã chạy

- Rust: `cargo test pdf_engine::print --lib` → **23/23 đạt**.
- Frontend: `printPreviewLayout.test.ts` → **4/4 đạt**.
- Các test hiện tại chỉ kiểm toán học scale, thứ tự trang, booklet/grid và rotation. Không test `StartDoc/StartPage/EndPage/EndDoc`, worker process, spooler, máy in ảo, progress, cancel hoặc fallback UI.

## 3. Trace dọc luồng đang chạy

| Mắt xích | Bằng chứng |
|---|---|
| Entry từ tab bình bài | `desktop/src/components/ImpositionTab.tsx:2270-2301` gọi `openPrintDialog()` |
| Chuẩn bị file/list máy in | `desktop/src/components/shared/usePrintDialog.tsx:40-69` |
| UI cài đặt in | `desktop/src/components/shared/PrintDialog.tsx:93-897` |
| IPC in thẳng | `desktop/src/lib/nativePrint.ts:153-182` → `print_pdf_direct` |
| Tauri command | `desktop/src-tauri/src/pdf_engine/print.rs:1005-1071` |
| Worker riêng process | `desktop/src-tauri/src/pdf_engine/print_worker.rs:279-361` |
| GDI writer | `desktop/src-tauri/src/pdf_engine/print.rs:690-995` (`StartDocW → StartPage → FPDF_RenderPage → EndPage → EndDoc`) |
| Fallback Windows | `usePrintDialog.tsx:125-132` → `print_pdf` → `PrintDlgW` |
| Consumer trạng thái | event `print-progress` tại `PrintDialog.tsx:526-545`; lỗi trả về caller từng tab |

## 4. Findings đã xác nhận

### §PRINT.01 — P1, effort M — Máy in tạo file bị đưa vào đường in thẳng nhưng thiếu output path

**Trạng thái:** `[CONFIRMED]` về lệch hợp đồng; `[SUSPECTED]` là nguyên nhân trực tiếp của đúng lần người dùng vừa gặp vì chưa có runtime log của lần đó.

**Bằng chứng:**

- `PrinterInfo` chỉ mang `name` và `is_default` (`print.rs:1194-1197`); không mang driver, port hoặc cờ `requires_output_path`.
- `PrintDialog` mặc định chọn máy in Windows mặc định.
- Máy audit mặc định là Microsoft Print to PDF trên `PORTPROMPT:`.
- `run_print_job()` chỉ gán `di.lpszDocName` (`print.rs:726-731`), không gán `di.lpszOutput`.
- UI/IPC không có field output path trong `PrintSettings`, `PrintDirectParams` hoặc `PrintWorkerJob::PrintDirect`.

**Tác động:** job máy in ảo có thể vào spooler nhưng không có đích lưu đáng tin cậy; prompt của driver có thể không hiện đúng phía trước hoặc job bị driver/spooler loại. Nếu `EndDoc` trả thành công nhưng job hỏng sau đó, PrynX vẫn trả `true`.

**Hướng sửa:** phân loại printer từ driver/port; máy in file/prompt phải yêu cầu đường dẫn đầu ra trước khi chạy và truyền `lpszOutput`, hoặc đi một system-dialog có owner thật. Không coi mọi printer là máy in vật lý.

### §PRINT.02 — P1, effort M — Hộp thoại bị unmount ngay khi bấm In, nên progress và Hủy không tồn tại trong lúc job chạy

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- `handlePrint()` gọi `takeState()` trước khi bắt đầu IPC (`usePrintDialog.tsx:94-103`).
- `takeState()` đặt `stateRef = null` và `setState(null)` (`:76-81`).
- `PrintDialog` chỉ render khi `state` còn tồn tại (`:155-164`).
- Listener progress và nút Hủy nằm bên trong chính `PrintDialog` (`PrintDialog.tsx:526-545`, `:577-582`, `:886-892`).

**Tác động:** vừa bấm In là dialog biến mất; người dùng không thấy tiến độ, không thể hủy đúng job, không biết job thành công/hỏng. Tài liệu `docs/PRINT.md` đang ghi “Tiến độ tờ in + Hủy job ✅” nhưng đường runtime không thể thực hiện điều đó.

**Hướng sửa:** giữ dialog/job state tới terminal `completed | failed | cancelled`; chỉ dọn temp và resolve promise sau terminal. Listener progress phải ở tầng sống lâu hơn worker job.

### §PRINT.03 — P1, effort L — Cancel không hợp tác xuyên process và PID dùng chung cho mọi loại worker

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- `PRINT_CANCEL_FLAG` là static trong từng process (`print.rs:20`). Parent set cờ tại `cancel_print_job()` (`:1077-1079`), nhưng worker có bản sao riêng và reset nó về `false` khi vào `run_print_job()` (`:703`).
- Worker in luôn nhận `progress_app=None` (`print_worker.rs:226`).
- `PRINT_WORKER_PID` là một biến toàn cục duy nhất (`print_worker.rs:18`) và bị ghi bởi mọi job: list printer, geometry, properties, print direct và PrintDlg (`:279-326`).
- Hủy dùng `taskkill /T /F` cho PID cuối cùng (`:364-381`), không đảm bảo đó là job in mà người dùng muốn hủy.

**Tác động:** cooperative cancel trong `run_print_job()` thực tế không nhận được tín hiệu parent; force-kill có thể không gọi `AbortDoc`, để lại job lỗi/stuck. Hai tab hoặc một geometry/properties worker chạy xen kẽ có thể làm hủy nhầm process hoặc không hủy được job in.

**Hướng sửa:** cấp `print_job_id` riêng, registry PID theo loại/job và kênh cancel xuyên process (named event/pipe/file token); worker nhận cancel rồi gọi `AbortDoc` và trả terminal có cấu trúc.

### §PRINT.04 — P1, effort M — Fallback nuốt lỗi gốc, có thể mở sau app và làm mất cài đặt nâng cao

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- Mọi lỗi `printPdfDirect()` bị `catch {}` không giữ error và tự gọi `printPdfPath()` (`usePrintDialog.tsx:103-132`).
- `printPdfPath()` chỉ mang range, scale và auto-rotate; mất layout Multiple/Booklet/Poster, subset, reverse, grayscale, annotation và DEVMODE (`nativePrint.ts:190-207`).
- `print_pdf()` lấy HWND thật ở parent, nhưng nhánh worker `PrintDlg` gọi `print_pdf_blocking(... owner_hwnd=0 ...)` (`print_worker.rs:240-247`). System dialog vì vậy không có owner PrynX.
- Caller nhận `false` khi người dùng hủy fallback nhưng các tab hiện không dùng boolean này để giải thích kết quả.

**Tác động:** direct job có thể đã xuất hiện rồi bị `AbortDoc`; lỗi gốc biến mất; system dialog fallback có thể nằm sau cửa sổ; nếu người dùng hủy thì PrynX im lặng. Nếu fallback in được, output có thể khác hoàn toàn preview/cài đặt PrynX.

**Hướng sửa:** không fallback mù. Hiển thị lỗi gốc và cho người dùng chọn “Thử bằng hộp thoại Windows”; đánh dấu rõ các setting không giữ được hoặc chuyển đầy đủ contract.

### §PRINT.05 — P2, effort M — Không theo dõi job-id/spooler và log không đủ để biết job bị hủy ở stage nào

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- `StartDocW` trả job-id nhưng code chỉ kiểm `<=0`, sau đó bỏ giá trị (`print.rs:731-734`).
- Không gọi `GetJob`, không log `StartPage/EndPage/EndDoc`, trạng thái driver hay job-id.
- Worker lỗi chỉ log `worker: done code=1` (`print_worker.rs:118-125`); parent trả error nhưng frontend direct catch bỏ error.
- `print_debug.log` hiện chỉ có list/geometry tới 2026-07-28; không có bản ghi đủ của lần lỗi mới. Windows PrintService Operational đang tắt, Admin log không có record.

**Tác động:** không phân biệt được PrynX abort, driver lỗi, port prompt bị hủy, spooler hủy hay người dùng hủy. `EndDoc` thành công cũng chưa chứng minh giấy/file đã ra.

**Hướng sửa:** log có cấu trúc theo job-id/stage, printer/driver/port đã rút gọn, error code Win32 và terminal; poll `GetJob` trong thời gian hợp lý hoặc ít nhất phân biệt “đã giao spooler” với “đã in”.

### §PRINT.06 — P2, effort S — Preview PDF.js lỗi sẽ khóa luôn đường in native

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:** `documentReady` chỉ thành `true` sau khi PDF.js load thành công (`PrintDialog.tsx:398-424`); cả `handlePrint` và nút In đều chặn khi false (`:549`, `:890`). Native PDFium có thể in được một file mà preview WebView lỗi, nhưng UI không cho thử.

**Tác động:** file lớn, file PDF.js không đọc được hoặc preview lỗi làm mất luôn tính năng in dù engine native vẫn có khả năng xử lý.

**Hướng sửa:** preview có state độc lập; lỗi preview không vô hiệu hóa in nếu file path/PDF metadata hợp lệ. Hiển thị cảnh báo thay vì hard gate.

### §PRINT.07 — P2, effort M — Preview dùng một kích thước trang cho tài liệu mixed-size

**Trạng thái:** `[CONFIRMED]` về contract preview; chưa có artifact hình ảnh trong đợt này.

**Bằng chứng:** `pageDimPt` là một state toàn dialog (`PrintDialog.tsx:135`), được ghi từ trang 1 hoặc khi còn giá trị A4 mặc định (`:209-228`), rồi dùng để tính kích thước vẽ mọi cell (`:277-278`, `:503-504`). Backend lại gọi `FPDF_GetPageSizeByIndex` cho từng trang (`print.rs:756-789`).

**Tác động:** tài liệu bình nhiều khổ/mixed orientation có preview scale khác output thật; quyết định Fit/Shrink nhìn trên UI có thể gây hiểu nhầm.

**Hướng sửa:** cache kích thước theo page number và dùng đúng trang/cell, thêm artifact mixed A4/A3/ngang-dọc.

### §PRINT.08 — P2, effort M — Test hiện tại không chạm hợp đồng in thật

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:** 23 Rust test và 4 frontend test đều xanh nhưng chỉ phủ helper thuần. Không có test cho `usePrintDialog`, `PrintDialog` lifecycle, `run_isolated`, output-file printer, owner HWND, cancel race, fallback hay spooler terminal.

**Tác động:** release gate có thể xanh dù nút In không tạo được giấy/file, progress/hủy không hoạt động và fallback sai setting.

**Hướng sửa:** thêm fake worker/protocol test và Windows integration smoke với Microsoft Print to PDF trước khi coi tính năng sẵn sàng release.

## 5. Phát hiện đã bác bỏ hoặc ghi nhận chủ đích

- `[EXPECTED]` In dùng PDFium → GDI thay vì `window.print()`; đây là kiến trúc đúng cho PDF native, không phải nguyên nhân tự hủy.
- `[EXPECTED]` Worker riêng process để driver crash không kéo sập app là mục tiêu hợp lý. Bug nằm ở protocol progress/cancel/job ownership, không phải ở việc dùng worker.
- `[DISPROVED]` Không có bằng chứng code tự gọi `cancel_print_job()` ngay sau tờ 1. Nút cancel hiện thậm chí bị unmount; việc job hủy là từ error/AbortDoc/driver/spooler, không phải timer tự hủy trong frontend.

## 6. Thứ tự sửa đề xuất — chờ duyệt

### Lô 1 — Khóa lỗi người dùng nhìn thấy, tối đa 5 file

1. Giữ dialog sống tới terminal; hiển thị lỗi gốc, trạng thái “đang gửi / đã giao spooler / thất bại / đã hủy”.
2. Bỏ fallback mù; fallback chỉ chạy khi người dùng chọn.
3. Preview lỗi không khóa nút In.
4. Thêm component/hook test cho lifecycle, error và boolean cancel.

### Lô 2 — Sửa protocol worker/spooler

1. `print_job_id` riêng và registry PID chỉ cho job in.
2. Progress/cancel xuyên process; cancel kết thúc bằng `AbortDoc`, không force-kill nhầm worker.
3. Giữ/log `StartDoc` job-id và stage Win32; terminal có cấu trúc.
4. Test race hai tab + geometry/properties xen kẽ.

### Lô 3 — Máy in PDF/virtual và artifact runtime

1. Trả driver/port/capability trong `PrinterInfo`.
2. Với `PORTPROMPT:`/file printer: yêu cầu output path và truyền `lpszOutput`, hoặc system dialog có owner thật.
3. Smoke Microsoft Print to PDF: file tồn tại, mở lại được, đúng page count/page size.
4. Smoke Adobe PDF và ít nhất một máy in vật lý tại nơi người dùng có thiết bị.
5. Artifact mixed-size để khóa preview/output parity.

## 7. Chốt bằng chứng còn thiếu

- Chưa chạy lại thao tác in trên app thật vì việc tạo job/file in là thay đổi trạng thái bên ngoài và cần một ca được người dùng cho phép.
- Chưa có máy in vật lý trên máy audit.
- PrintService Operational chưa bật nên không có lịch sử job hủy ở tầng spooler.
- `docs/PRYNX_MASTER_AUDIT_MATRIX.md` đang có thay đổi chưa commit của audit khác; báo cáo này chưa sửa file đó để tránh ghi đè. Khi bắt đầu lô sửa, đăng ký audit unit `W7-U03 — Native print lifecycle`.

Theo quy trình audit PrynX, dừng tại đây để chờ duyệt trước khi sửa code.
