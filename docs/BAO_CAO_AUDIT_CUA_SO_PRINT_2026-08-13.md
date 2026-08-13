# Báo cáo audit — Cửa sổ In hay “out” và các lỗi kèm (2026-08-13)

Phạm vi: Ctrl+P / File → In… → hộp thoại In của PrynX → worker GDI → Windows Print Spooler.
Không thuộc phạm vi: xuất máy bế, mở CorelDRAW/Illustrator, engine chế bản PDF, phát hành installer.

Phương pháp: `prynx-deep-audit` + `prynx-audit-workflow`. Đợt này **chỉ khảo sát và báo cáo**. Không sửa mã trước chốt duyệt.

Audit unit: người dùng mở PDF/kết quả bình bài → mở hộp In → hộp thoại còn sống, in được hoặc báo lỗi có nguyên nhân — không biến mất, không đóng băng cửa sổ PrynX.

Bối cảnh đã có: audit In native 2026-08-05 (`§PRINT.01–08`, đã sửa) và phạm vi trang 2026-08-11 (`§PRINTRANGE.1–4`, đã sửa). Các mục đó **không mở lại** trừ khi cây mã hiện tại hồi quy.

## 1. Kết luận điều hành

“Cửa sổ print out” trên cây mã hiện tại **không còn** là job Microsoft Print to PDF tự hủy vì thiếu `lpszOutput` (đã vá 2026-08-05). Hành vi hay gặp khớp một tổ hợp mới:

1. Hộp In HTML tự đóng khi bấm nền, kể cả lúc UI driver đang chạy **khuất** trong worker không có cửa sổ.
2. Preview hộp In nhồi **cả file PDF** vào WebView qua pdf.js — log máy audit đã mở file **133 MB**.
3. Hộp thoại Windows (`PrintDlgW`) chạy trong process worker, lấy HWND của app làm owner, **không** `CoInitialize`/`OleInitialize`. Worker chết thì cửa sổ PrynX có thể bị disable như đã crash.

Log `%APPDATA%\PrynX\logs\print_debug.log` (18/07–12/08) mở hộp In nhiều lần, liệt kê máy in thành công, **không có một dòng `print_pdf_direct: enter` hay `print_pdf: enter`**. Trên máy này job GDI gần như chưa chạy tới. Đó là bằng chứng runtime cho “mở cửa sổ In rồi mất/không in được”, không phải bằng chứng spooler.

Mức bằng chứng đợt này: **`TRACED`** cho toàn luồng; **`RUNTIME-PARTIAL`** cho việc mở hộp In trên máy dev; **chưa `RUNTIME`** cho một job in vật lý. Test tự động hiện có phủ lifecycle/error/range, **không** phủ overlay, Properties, COM, HWND xuyên process, pdf.js OOM.

## 2. Trace dọc luồng đang chạy

| Mắt xích | Bằng chứng |
|---|---|
| Phím/menu | `desktop/src/App.tsx:964-977` chặn `window.print()`, phát `app-trigger-print` |
| Tab nhận lệnh | `ImpositionTab.tsx:2475-2548`, `CombineTab`, `CompareTab`, `DielineTool` — đều `usePrintDialog` |
| Chuẩn bị path + list máy in | `usePrintDialog.tsx:53-86` → `nativePrint.ts:96-125` |
| UI hộp In | `PrintDialog.tsx` portal `z-[99999]` |
| IPC in thẳng | `nativePrint.ts:164-194` → `print_pdf_direct` |
| Worker process | `main.rs:11-28` rẽ `--prynx-print-job` trước Tauri; `print_worker.rs:360-486` |
| GDI | `print.rs:722-1111` `StartDocW → FPDF_RenderPage → EndDoc` |
| Fallback Windows | nút “Thử hộp thoại Windows” → `print_pdf` → `PrintDlgW` trong worker |
| Log chẩn đoán | `%APPDATA%\PrynX\logs\print_debug.log` |

Đường runtime **không** dùng `window.print()` WebView2. `print_engine` (PPE) **không** nằm trên đường Ctrl+P — PPE là xem trước/tách màu.

`tauri-plugin-single-instance` **không** giết worker: `main.rs` thoát print-worker trước `app_lib::run()`. `[DISPROVED]` với giả thuyết “spawn PrynX.exe bị single-instance nuốt”.

## 3. Findings đã xác nhận

Chỉ `[CONFIRMED]` được xếp P0–P3. Finding P0 không có: chưa chứng minh in sai nội dung trang trên artifact. Các P1 dưới đây đủ để cửa sổ In biến mất, đóng băng app, hoặc không bấm In được.

### §PRINTWIN.01 — P1, effort S — Overlay đóng hộp In lúc Properties/Advanced đang chạy khuất

**Trạng thái:** `[CONFIRMED]`

**Bằng chứng:**

- Nền portal đóng dialog trừ khi `printing`: `PrintDialog.tsx:667-670` `onClick={printing ? undefined : onCancel}`.
- `propertiesBusy` chỉ disable hai nút, **không** chặn overlay hay Escape (`:185-196`, `:508-516`, `:704-710`).
- UI driver chạy worker `CREATE_NO_WINDOW` với `hwnd=0`: `print_worker.rs:189` `open_printer_properties_blocking(0, …)`; cờ `0x08000000` tại `:396-400`.
- `onCancel` gọi `finish(false)` → unmount ngay (`usePrintDialog.tsx:102-106`, `:224`).

**Tác động:** Máy in mặc định trên máy audit là Microsoft Print to PDF. Người dùng bấm Thuộc tính/Nâng cao → UI driver không có owner, process không cửa sổ → hộp driver khuất hoặc không lên taskbar. Bấm nền (thói quen đóng modal) → hộp In PrynX biến mất trong lúc worker còn sống. Đây khớp mạnh với “cửa sổ print out”.

**Hướng sửa:** Khi `propertiesBusy` (và khi `printing`) không đóng overlay/Escape; giữ dialog tới khi invoke Properties trả về. Worker Properties nên có owner/message pump thật, không `hwnd=0` + `CREATE_NO_WINDOW`.

### §PRINTWIN.02 — P1, effort M — Preview pdf.js đọc cả file PDF vào WebView

**Trạng thái:** `[CONFIRMED]` về hợp đồng bộ nhớ; `[SUSPECTED]` là nguyên nhân crash WebView trên file lớn (không bắt được exception JS).

**Bằng chứng:**

- `PrintDialog.tsx:456-457`: `getFileArrayBuffer(source)` rồi `pdfjs.getDocument({ data: new Uint8Array(buf) })` — bản sao thứ hai trong heap JS.
- `getFileArrayBuffer` / `fetchLocalFileBuffer` không cap kích thước (`utils.ts:13-20`, `localFileTransport.ts:20-33`).
- Log 2026-07-18: `openPrintDialog: start pages=17 size=133116551` (133 MB) rồi `show dialog`. Không có breadcrumb in sau đó.
- Native print chỉ cần path đĩa (`nativePrint.ts:96-102`); preview không cần decode cả tài liệu.

**Tác động:** File bình tờ/VDP lớn làm WebView OOM hoặc worker pdf.js chết → cả cửa sổ PrynX “out”. `§PRINT.06` (preview lỗi vẫn in được) chỉ bắt `catch` JS, không bắt crash process.

**Hướng sửa:** Preview chỉ raster 1 trang đang xem bằng engine native/tile đã có, hoặc pdf.js với path/range; cấm `getDocument({ data: entireFile })`. File ≥ N MB bỏ preview, vẫn cho in.

### §PRINTWIN.03 — P1, effort M — PrintDlgW xuyên process lấy HWND app làm owner

**Trạng thái:** `[CONFIRMED]` về hợp đồng HWND; runtime “disable cửa sổ cha khi worker chết” chưa tái hiện có kiểm soát trên máy này (log không có `print_pdf: enter`).

**Bằng chứng:**

- `print.rs:487-507` lấy `window.hwnd()`, gửi `owner_hwnd` vào worker. Comment dòng 496 viết “hwnd owner = 0 trong worker” — **lệch code**.
- `print_worker.rs:275-303` gọi `print_pdf_blocking(…, owner_hwnd)`.
- `print.rs:541-597` `PrintDlgW` với `pd.hwndOwner = HWND(owner_hwnd)`.
- Sửa 2026-08-05 `§PRINT.04` cố ý giữ HWND để dialog không khuất (`docs/IN_NATIVE_FIXES_2026-08-05.md` Lô 1).

**Tác động:** Windows disable cửa sổ owner khi dialog modal mở. Dialog nằm process khác: worker AV/bị `taskkill` (cancel 2 giây, `print_worker.rs:593-608`) thì cửa sổ PrynX có thể **ở lại Disabled** — trông như app đã chết. `CREATE_NO_WINDOW` làm PrintDlgW dễ flash rồi tắt (`CommDlgExtendedError`).

**Hướng sửa:** PrintDlgW/DocumentPropertiesW phải chạy process **có message pump và cửa sổ owner cùng process** (cửa sổ ẩn 1×1 của worker, hoặc in-process + `catch_unwind` như fallback spawn-fail). Không dùng HWND process khác làm owner. Cập nhật comment cho khớp code.

### §PRINTWIN.04 — P1, effort S — Worker in không khởi tạo COM

**Trạng thái:** `[CONFIRMED]`

**Bằng chứng:** Grep `CoInitialize` / `OleInitialize` trong `print.rs` và `print_worker.rs` = 0 hit. `run_print_worker` vào `execute_job` ngay. `PrintDlgW` và nhiều UI driver (Adobe PDF, XPS, WSD, HP/Epson) yêu cầu COM trên thread.

**Tác động:** Lỗi theo máy in — “thường xuyên” trên driver xưởng, êm trên Microsoft Print to PDF (đúng với smoke 2026-08-05). Worker chết → thông báo “Tiến trình in bị dừng đột ngột” (`print_worker.rs:462-470`) hoặc cửa sổ cha bị disable (`§PRINTWIN.03`).

**Hướng sửa:** `OleInitialize`/`CoInitializeEx` ở đầu `run_print_worker`, `CoUninitialize` trước khi thoát. Verify PrintDlgW + Properties với Adobe PDF và một driver vật lý.

### §PRINTWIN.05 — P1, effort S — List máy in lỗi → hộp In kẹt, không có đường Windows

**Trạng thái:** `[CONFIRMED]`

**Bằng chứng:**

- Worker list lỗi → `Ok(vec![])` nuốt nguyên nhân: `print.rs:1406-1410`.
- `nativePrint.ts:116-125` catch → `[]`.
- UI: `printers.length === 0` chỉ hiện cảnh báo, Print `disabled={!printerName}` (`PrintDialog.tsx:693-695`, `:1013`). Nút “Thử hộp thoại Windows” **chỉ** hiện khi đã có `printError` (`:1003-1007`).

**Tác động:** AV/spawn worker fail → hộp In mở nhưng không in được, không mở PrintDlgW. Người dùng đóng overlay → “cửa sổ print out”.

**Hướng sửa:** Không nuốt lỗi list thành mảng rỗng. Hiện lỗi + luôn cho mở PrintDlgW khi list rỗng/fail.

### §PRINTWIN.06 — P1, effort S — Hủy job đóng dialog và xóa temp khi worker còn in

**Trạng thái:** `[CONFIRMED]` về thứ tự; mức hại cao nhất với blob `deleteAfter=true` (bake xoay/thứ tự, file sinh).

**Bằng chứng:**

- `PrintDialog.tsx:655-664`: `onCancelPrint()` rồi **luôn** `onCancel()`.
- `onCancel` → `finish(false)` → `deletePrintTemp` nếu `deleteAfter` (`usePrintDialog.tsx:98-106`).
- Worker vẫn `FPDF_LoadPage` file đó cho tới khi thấy cancel file hoặc bị `taskkill`.

**Tác động:** Hủy giữa chừng: hộp In biến mất ngay; file tạm bị xóa dưới chân PDFium; lần in blob dễ fail/AV. Đường file đĩa (`deleteAfter=false`, đa số log) nhẹ hơn.

**Hướng sửa:** Hủy chỉ gửi tín hiệu; giữ dialog tới terminal `cancelled`/`failed`; xóa temp sau khi worker thoát.

## 4. Findings P2 và mục đã bác

### §PRINTWIN.07 — P2, effort S — Tên file job worker = `pid + millis`

`print_worker.rs:374-384`. Hai `get_printer_geometry` / Properties / Print trong cùng 1 ms ghi đè JSON. `[CONFIRMED]` thiết kế; chưa bắt được va chạm trong log (các spawn cách ≥200 ms).

### §PRINTWIN.08 — P2, effort S — `print-progress done` hạ `printing` trước `completePrint`

`print.rs:1229-1237` emit `done: true` rồi mới trả invoke. `PrintDialog.tsx:584-587` đặt `printing=false`. Có thể bấm In lần hai cùng `jobId`/path đang dọn. `[CONFIRMED]` race; chưa có log double-submit.

### §PRINTWIN.09 — P2 — `FPDF_RenderPage` bỏ qua mã trả về

`print.rs:843-852`. Trang lỗi vẫn `EndPage` → tờ trắng, job báo thành công. `[CONFIRMED]`.

### §PRINTWIN.10 — P2 — Booklet không ép giấy ngang

`print_worker.rs:230-234` chỉ đổi scale sang Fit, không `DMORIENT_LANDSCAPE`. `[CONFIRMED]` lệch Acrobat; không làm cửa sổ out.

### §PRINTWIN.11 — P2 — Không nút X header; đóng bằng bấm nền

`PrintDialog.tsx:681-685` vs `:667-670`. Dễ đóng nhầm khi chưa in. `[CONFIRMED]` UX.

### Đã bác / chủ đích

| Mã | Kết luận |
|---|---|
| Single-instance nuốt worker | `[DISPROVED]` — `main.rs:11-28` thoát trước `run()` |
| Sentinel 11 byte vào PDFium | `[EXPECTED]` — `resolvePrintableFilePath` path-first (audit 2026-08-06) |
| `§PRINT.01` thiếu `lpszOutput` | Vẫn đóng — classify + Save dialog còn trên cây |
| `§PRINT.02` unmount lúc bấm In | Vẫn đóng — dialog sống khi job pending (test `usePrintDialog.test.tsx:128-153`) |
| `§PRINT.04` fallback mù | Vẫn đóng — lỗi hiện trên dialog, fallback chủ động |
| `§PRINTRANGE.*` | Vẫn đóng trên code/test; chưa runtime artifact |

## 5. Log runtime máy audit

File: `C:\Users\Khanh Pham\AppData\Roaming\PrynX\logs\print_debug.log` (96 dòng, 18/07–12/08/2026).

| Quan sát | Ý nghĩa |
|---|---|
| Mọi lần mở đều `printers=3`, geometry Microsoft Print to PDF | List/geometry worker sống trên máy này |
| `size=133116551` (17 trang) | Preview pdf.js từng nhận file 133 MB |
| 0 lần `print_pdf_direct` / `print_pdf` / `StartDoc` | Không có job GDI nào được ghi |
| Nhiều `cancel: job=print-target pid=0` | Harness test, không phải in tay |

Không kết luận máy in vật lý. Oracle Windows: `PrintDlgW` cần COM; không dùng HWND process khác làm owner modal.

## 6. Test / khoảng trống

Đã đọc, không chạy lại gate rộng trong đợt khảo sát:

- Frontend: `usePrintDialog.test.tsx`, `nativePrint.test.ts`, `printPageSelection.test.ts`, `printPreviewLayout.test.ts`.
- Rust: `print.rs` / `print_layout.rs` / `print_worker.rs` unit tests; smoke Microsoft Print to PDF `#[ignore]`.

Thiếu test cho: overlay+`propertiesBusy`, list rỗng → PrintDlgW, COM init, HWND cùng process, hủy-vs-temp, collision tên job, pdf.js không load full file.

## 7. Đề xuất lô sửa (chờ duyệt)

Thứ tự an toàn: UI/JS trước → worker COM/HWND → GDI nhỏ.

**Lô 1 — cửa sổ không tự mất (≤5 file, P1 UX)**  
`PrintDialog.tsx`, `usePrintDialog.tsx`, `usePrintDialog.test.tsx` (+ i18n nếu thêm nút PrintDlgW khi list rỗng).  
Chặn overlay/Escape khi `propertiesBusy`/`printing`; hủy job không `finish` ngay; list rỗng vẫn mở hệ thống; (tuỳ chọn) nút X header.

**Lô 2 — worker không làm chết/đóng băng app (≤5 file)**  
`print_worker.rs`, `print.rs`, `main.rs` nếu cần.  
`OleInitialize` trong worker; Properties/PrintDlg dùng cửa sổ owner **cùng process**; bỏ HWND app xuyên process; tên job `pid + nanos + random`; không nuốt lỗi list thành `[]`.

**Lô 3 — preview không OOM WebView**  
`PrintDialog.tsx`, `nativePrint.ts` (nếu thêm `render_print_preview_page`).  
Không `getDocument` cả file; preview 1 trang qua native/tile hoặc skip.

**Lô 4 — GDI trung thực**  
Kiểm `FPDF_RenderPage`; booklet landscape; không hạ `printing` trước terminal.

Tag khi sửa: `PRINTWIN (audit 2026-08-13 §PRINTWIN.x)`.

## 8. Việc người dùng có thể làm ngay (chưa sửa code)

1. Đừng bấm nền xám khi đang Thuộc tính máy in — dùng Hủy.
2. File PDF rất lớn: đóng preview nếu WebView giật; in bản nhỏ hơn để xác nhận.
3. Gửi thêm `%APPDATA%\PrynX\logs\print_debug.log` sau một lần In thất bại (cần dòng `print_pdf_direct` / `isolated: worker died`).
4. Không coi Microsoft Print to PDF trên máy dev là đủ cho máy in xưởng.

**Dừng tại chốt duyệt.** Chưa sửa mã, chưa commit, chưa chạy `run_dev.bat`.
