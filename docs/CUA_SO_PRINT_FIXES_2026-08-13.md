# NHẬT KÝ SỬA — CỬA SỔ IN "OUT"

**Ngày:** 2026-08-13  
**Audit:** `docs/BAO_CAO_AUDIT_CUA_SO_PRINT_2026-08-13.md` (§PRINTWIN.01–11)  
**Phạm vi:** hộp thoại In PrynX (UI/JS) + print worker out-of-process + vòng GDI.  
**Tag truy vết:** `PRINTWIN (audit 2026-08-13 §PRINTWIN.x)`

## Lô 1 — Cửa sổ In không tự biến mất (UI/JS)

Áp trên cây trước phiên này; phiên này xác minh lại từng mục trên code + test.

### Thay đổi

1. `desktop/src/components/shared/PrintDialog.tsx`
   - §PRINTWIN.01: `dialogBusy = printing || propertiesBusy` chặn cả overlay click
     lẫn Escape khi driver Properties đang chạy khuất hoặc đang in.
   - §PRINTWIN.11: thêm nút X ở header (disable khi `dialogBusy`).
   - §PRINTWIN.06: nút "Hủy in" chỉ gửi tín hiệu (`onCancelPrint`), không
     `onCancel()` — dialog và file tạm sống tới khi job trả terminal.
   - §PRINTWIN.08: event `print-progress done` không hạ `printing` nữa;
     `printing` chỉ hạ trong `finally` của `runPrintAction` (sau khi invoke trả).
   - §PRINTWIN.05: nút "Thử hộp thoại Windows" hiện cả khi `printers.length === 0`,
     không chỉ khi đã có `printError`.
2. `desktop/src/lib/nativePrint.ts` — `listPrinters()` không nuốt lỗi thành `[]`;
   lỗi được ném lên hook.
3. `desktop/src/components/shared/usePrintDialog.tsx` — hook catch lỗi list, ghi
   `print_debug.log` (`listPrinters failed …`) rồi vẫn mở dialog với list rỗng.
4. `desktop/src-tauri/src/pdf_engine/print.rs` — `list_printers` trả `Err` thay vì
   `Ok(vec![])` khi worker fail (frontend hiển thị + fallback PrintDlgW).
5. `desktop/src/i18n/locales/{en,vi}.json` — key `print:close`,
   `print:preview_skipped_large`.

## Lô 2 — Worker không làm chết/đóng băng app

### Thay đổi

1. `desktop/src-tauri/src/pdf_engine/print_worker.rs`
   - §PRINTWIN.04: `OleGuard` — `OleInitialize` ở đầu `run_print_worker`,
     `OleUninitialize` khi thoát. PrintDlgW + UI driver (Adobe PDF, XPS, driver
     hãng) cần COM/OLE trên thread gọi; thiếu thì lỗi tùy driver.
   - §PRINTWIN.03: sau khi spawn worker, parent gọi
     `AllowSetForegroundWindow(child_pid)` để dialog trong worker được phép lên
     foreground (process nền không tự lấy foreground).
   - §PRINTWIN.07: tên file job/result đổi từ `pid + millis` sang
     `pid + nanos + bộ đếm nguyên tử` (`unique_worker_file_id()`) — hai worker
     spawn cùng 1 ms không còn ghi đè JSON của nhau.
   - Cập nhật comment protocol `OpenProperties`/`PrintDlg.owner_hwnd` khớp hành vi mới.
2. `desktop/src-tauri/src/pdf_engine/print.rs`
   - §PRINTWIN.03 + §PRINTWIN.01: thêm `DialogOwnerWindow` — cửa sổ owner 1×1
     ngoài màn hình, tạo TRONG process worker khi `owner_hwnd == 0`, dùng làm owner
     cho `PrintDlgW` và `DocumentPropertiesW`/`AdvancedDocumentPropertiesW`, hủy khi
     dialog đóng. Taskbar hiện mục "PrynX — Hộp thoại máy in" để hộp driver không
     "mất tích". App **không** truyền HWND xuyên process nữa (`print_pdf` gửi
     `owner_hwnd: 0`) → worker chết không disable cửa sổ PrynX. Fallback in-process
     (spawn fail) vẫn dùng HWND app — hợp lệ vì cùng process.

### Ghi chú kỹ thuật

- `FPDF_RenderPage` phía pdfium-render là hàm **void** (khớp C API PDFium) — tiền đề
  "bỏ qua mã trả về" của §PRINTWIN.09 không khả thi theo nghĩa đen; xem Lô 4.
- `DefWindowProcW` của windows-rs 0.61 mang ABI Rust nên phải bọc
  `dialog_owner_wndproc` (extern "system") mới gán được vào `WNDCLASSW`.

## Lô 3 — Preview không OOM WebView

### Thay đổi

1. `desktop/src/components/shared/PrintDialog.tsx`
   - §PRINTWIN.02: file > `MAX_PRINT_PREVIEW_BYTES` (24 MB) không vào pdf.js.
     Preview đi engine native theo PATH: `get_pdf_metadata` đọc số trang + khổ từng
     trang, `render_pdf_page` raster đúng 1 trang đang xem (~600 px cạnh dài, trần
     zoom 1.5 — cùng thông số với đường pdf.js). Native lỗi → bỏ preview
     (`preview_skipped_large`) nhưng nút In vẫn hoạt động.
   - File ≤ 24 MB giữ pdf.js như cũ (bounded, không còn ca 133 MB vào WebView).
2. `desktop/src/lib/nativePrint.ts` — thêm `getPrintPreviewInfo()` (bọc
   `get_pdf_metadata`) và `renderPrintPreviewPage()` (bọc `render_pdf_page`,
   px = pt × 96/72 × zoom); mọi lỗi trả `null`, không chặn in.
3. `desktop/src/components/shared/usePrintDialog.tsx` — truyền `filePath` đã
   resolve xuống `PrintDialog`.

## Lô 4 — GDI trung thực

### Thay đổi

1. `desktop/src-tauri/src/pdf_engine/print.rs`
   - §PRINTWIN.09 (tái phân loại): `FPDF_RenderPage` là void — không có mã trả về
     để kiểm. Ca "tờ trắng im lặng" kiểm được là **kích thước vẽ suy biến**
     (`draw_w/draw_h` làm tròn về 0 do scale/khổ giấy/lưới poster): chặn ở
     `render_page_in_rect` và nhánh poster, trả lỗi rõ thay vì `EndPage` tờ trắng.
     Các điểm lỗi còn lại đã kiểm sẵn: `FPDF_GetPageSizeByIndex`, `FPDF_LoadPage`,
     `StartPage/EndPage/EndDoc`, spooler status.
   - §PRINTWIN.10: booklet Auto/không chọn hướng → ép `DMORIENT_LANDSCAPE` qua
     `effective_print_orientation()` (áp trước phiên này; đã có unit test
     `booklet_auto_orientation_forces_landscape`).
   - §PRINTWIN.08 phía Rust: không cần đổi — frontend đã bỏ qua `done` (Lô 1).

## Bằng chứng verify

- `cargo test --lib pdf_engine::print` (target dir riêng `target-agent`, không đụng
  app dev đang chạy — đã thêm vào `.gitignore`): **32 passed, 1 ignored** (smoke
  Microsoft Print to PDF chạy tay), gồm test mới
  `worker_job_file_ids_khong_va_cham_khi_spawn_lien_tiep`.
- Full `cargo test --lib`: **133 passed, 0 failed, 5 ignored** (ignored = smoke/
  benchmark thủ công có sẵn).
- `npx vitest run src/components/shared src/lib/print*.test.ts src/lib/nativePrint.test.ts`:
  **27 passed**, gồm 2 test mới/đổi cho preview native file lớn
  (`không nhồi PDF lớn vào pdf.js`, `file lớn preview qua engine native theo path`).
- `npm run typecheck`: đạt.

## Mức bằng chứng & việc còn lại

- Mức đạt được: **tĩnh + test tự động** (Mức 1–2). Chưa có runtime Mức 3 cho:
  1. In vật lý qua driver xưởng (COM init §PRINTWIN.04 chỉ chứng minh được trên
     driver thật — smoke `microsoft_print_to_pdf_runtime_smoke` chạy tay).
  2. PrintDlgW/Properties với owner window mới — cần mở app thật, bấm Thuộc tính /
     Thử hộp thoại Windows, xác nhận dialog lên trước và cửa sổ PrynX không bị
     disable khi kill worker.
  3. Preview native với file > 24 MB thật (ví dụ file bình tờ 133 MB trong log).
- Đề xuất kiểm tay sau khi build lại: Ctrl+P → Thuộc tính (dialog driver phải nổi
  lên / có mục taskbar) → bấm nền xám (hộp In KHÔNG được đóng) → in thử 1 trang
  Microsoft Print to PDF → mở file lớn >24 MB xem preview native.
