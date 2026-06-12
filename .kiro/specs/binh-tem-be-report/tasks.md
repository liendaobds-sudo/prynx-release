# Implementation Plan

> Kế hoạch triển khai — Report & Xuất tờ duy nhất cho Bình Tem Bế.
> Thứ tự: backend lõi (thuần, test được) → render → frontend → kiểm chứng.

## Overview
Triển khai theo lớp: (1) module thuần `nup_report` + test, (2) vẽ report, (3) sửa engine render bỏ nhân bản, (4) frontend store/UI, (5) kiểm chứng. Mỗi task khép kín, build/test được ngay.

## Tasks

- [x] 1. Tạo module `app/workers/nup_report.py` (logic thuần, không deps nặng)
  - `sanitize_filename(name)`: thay/loại `\ / : * ? " < > |`.
  - `compute_report_data(...)`: tính `sheet_count = ceil(qty/ips)`, `actual_qty = sheet_count*ips`; format text từng field (dimensions "W x H mm", "SL/tờ: N", "Số tờ: N", "SL thực: N", "Cán mờ 1 mặt"...).
  - `build_report_string(rd, data)`: nối field bật theo `fieldOrder` bằng " - ", chèn `orderCode` đầu, bỏ field rỗng, dọn "- -", áp `removeDiacritics`.
  - `remove_diacritics(s)`: port bảng dấu tiếng Việt từ JSX.
  - _Requirements: 1.2, 2.2, 2.3, 2.5, 4.2_

- [x] 2. Viết unit test cho `nup_report` (thuần) tại `backend/tests/test_nup_report.py`
  - build_report_string: thứ tự, bỏ rỗng, orderCode đầu, không "- -", removeDiacritics.
  - compute_report_data: `sheet_count`/`actual_qty`, biên `qty=0`, `ips=0`.
  - sanitize_filename: không còn ký tự cấm.
  - Property-based (Hypothesis nếu có, hoặc tham số hóa): Property 1 & 4 trong design.
  - _Requirements: 1.2, 2.3, 4.2_

- [x] 3. Thêm hàm vẽ report `draw_report_on_page` trong `nup_report.py`
  - Dùng reportlab tạo overlay 1 trang (font `app/assets/fonts/DejaVuSans.ttf`) chứa chuỗi report.
  - Đặt theo `position` (top/bottom/left/right) + `offsetX/Y` (mm) ở dải lề trống của tờ.
  - Stamp overlay vào trang output bằng pikepdf; lỗi → log cảnh báo, không sập job.
  - _Requirements: 2.1, 2.4, 2.6_

- [x] 4. Sửa `nup_engine.run_nup_engine` — nhánh `layout_type == 'repeat'` (chế độ Bình Tem Bế)
  - Đọc settings: `exportUniqueSheets` (mặc định True), `reportDisplay`, `reportMaterial`, `reportLamination`, `reportLaminationSides`, `reportOrderCode`, `saveByReport`.
  - Thay `for _ in range(sheets_needed)` → `range(1 if export_unique else sheets_needed)`.
  - Với mỗi loại: tính `items_per_sheet`, `sheets_needed`, `actual_qty`; gom `report_rows`.
  - Nếu `reportDisplay.enabled` & có field bật: build chuỗi + vẽ report lên đúng tờ của loại đó.
  - Bỏ qua an toàn khi `items_per_sheet == 0` (ghi cảnh báo, không sập).
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1_

- [x] 5. Bảng tổng hợp lệnh in trong `run_nup_engine`
  - Tạo `report_message` gồm từng loại (tên, SL/tờ, qty yêu cầu, số tờ) + tổng số tờ toàn đơn; trả về cuối job.
  - _Requirements: 5.1, 5.2_

- [ ] 6. `saveByReport` — đặt tên file output  *(GỘP vào nhóm "Lưu file in" — Task 14–17; bỏ cách rename cũ)*
  - Trong `imposition.py` (`_nup_process_worker`/`_launch_impose_job`): nếu bật, đổi tên file theo `sanitize_filename(report_chuỗi_tờ_đầu)`; rỗng → fallback mặc định.
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 7. Frontend types — `imposition-tools/types.ts`
  - Thêm `interface ReportDisplayConfig`, `DEFAULT_REPORT_CONFIG`, `DEFAULT_MATERIALS`.
  - _Requirements: 2.2, 3.1, 7.1_

- [x] 8. Store — `useImposerSettingsStore.ts`
  - Thêm state: `exportUniqueSheets`, `reportDisplay`, `customMaterials`, `reportMaterial`, `reportLamination`, `reportLaminationSides`, `reportOrderCode`, `saveByReport` + setters.
  - Đưa vào `partialize` (persist); thêm vào `migrate` (version bump nếu cần).
  - _Requirements: 3.3, 7.2_

- [x] 9. UI cấu hình Report trong `sections/AdvancedSettingsSection.tsx` (chỉ `sticker_imposer`)
  - Toggle "Xuất tờ duy nhất + lệnh in"; checkbox bật/tắt từng field + sắp xếp lên/xuống; vị trí; cỡ chữ; mã ĐH; ô nhập tên nhãn; toggle bỏ dấu; toggle "Lưu file theo report".
  - Quản lý chất liệu: select (DEFAULT_MATERIALS + customMaterials) + nút Thêm/Xóa; select cán màng + số mặt.
  - _Requirements: 3.1, 3.2, 3.4, 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 10. Truyền settings — `ImposerDashboard.handleExecute` (nhánh non-booklet)
  - Thêm các field report/material/exportUniqueSheets/saveByReport vào object gọi `onStartNup`.
  - _Requirements: 1.1, 2.1, 4.1_

- [x] 11. Hiện lại cột "T/Tờ" & "Số tờ" cho sticker — `sections/GridSettingsSection.tsx`
  - Bỏ điều kiện ẩn 2 cột khi `taskMode==='sticker_imposer'` trong bảng "Số lượng riêng từng trang" (vá UX + phục vụ Yêu cầu 5).
  - _Requirements: 5.1, 5.2_

- [x] 12. Kiểm chứng tổng thể
  - Backend: `pytest tests/` (giữ ≥ pass cũ + test mới); integration `run_nup_engine` xác nhận số trang = số loại khi `exportUniqueSheets=True`, và = nhân bản khi False.
  - Frontend: `npm run typecheck`.
  - Regression: N-Up/Booklet không đổi.
  - _Requirements: 6.1, 6.2, 6.3_

### Nhóm "Lưu file in" (Yêu cầu 8) — thay thế Task 6 cũ

- [x] 13. Backend — xuất cặp file in / file bế cho die-cut
  - [VERIFIED] Engine đã hỗ trợ `separate_cut_page` → mỗi tờ 2 trang `[in, bế]`. KHÔNG cần sửa backend; modal lưu tách trang chẵn=in / lẻ=bế.
  - _Requirements: 8.3_

- [x] 14. Store — cấu hình `savePrint` + persist
  - `savePrint: { nameMode, separateCut, folderMode, includeOrderCode, includeDate, lastFolder }` + setters; đưa vào partialize.
  - _Requirements: 8.2, 8.4, 8.5_

- [x] 15. FE util `sanitizeFilename` + builder tên file/cây thư mục
  - Port `sanitize_filename`; hàm dựng danh sách {path, filename} từ cấu hình + report rows.
  - _Requirements: 8.2, 8.5, 8.8_

- [x] 16. Component `SavePrintFilesModal.tsx`
  - Chọn thư mục (Tauri dialog); radio chế độ tên; checkbox tách in/bế + cấu trúc thư mục; **preview cây thư mục/tên file** (WYSIWYG). Đã gồm cả logic ghi đĩa (Task 17 core).
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6_

- [x] 17. Ghi đĩa + giữ tab + chống trùng tên
  - [x] Tách trang (pdf-lib) + `mkdir`/`writeFile` (Tauri fs) + chống trùng tên — trong modal.
  - [x] Gắn nút "🖨️ Lưu file in (tách lẻ)" vào `SaveModal`; mount `SavePrintFilesModal` trong `ImpositionTab`; KHÔNG đóng tab kết quả.
  - [x] Bổ sung quyền Tauri `fs:allow-mkdir` + write `$HOME` (capabilities/default.json).
  - Ghi chú: thư mục lưu phải nằm dưới `$HOME/$DOCUMENT/$DOWNLOAD/$DESKTOP/$APPDATA` (giới hạn fs scope); cần **rebuild app** để quyền mới có hiệu lực.
  - _Requirements: 8.1, 8.7, 8.8_

## Task Dependency Graph
```json
{
  "waves": [
    { "wave": 1, "tasks": [1, 7], "description": "Nền backend (module thuần) + types frontend — chạy song song" },
    { "wave": 2, "tasks": [2, 3, 8], "description": "Test module thuần, vẽ report, store frontend" },
    { "wave": 3, "tasks": [4, 6, 9], "description": "Sửa engine repeat, saveByReport, UI cấu hình report" },
    { "wave": 4, "tasks": [5, 10, 11], "description": "Bảng tổng hợp, truyền settings, hiện cột T/Tờ & Số tờ" },
    { "wave": 5, "tasks": [12], "description": "Kiểm chứng tổng thể (test + typecheck + regression)" },
    { "wave": 6, "tasks": [13, 14, 15], "description": "Lưu file in: backend tách in/bế, store config, util tên file" },
    { "wave": 7, "tasks": [16], "description": "SavePrintFilesModal + preview cây thư mục" },
    { "wave": 8, "tasks": [17], "description": "Ghi đĩa qua Tauri fs + giữ tab + chống trùng tên + kiểm chứng" }
  ]
}
```
```
1 ─┬─ 2            (test module thuần)
   └─ 3 ─ 4 ─┬─ 5
             └─ 6
7 ─ 8 ─ 9 ─ 10
        9 ─ 11
4,5,6,10,11 ─ 12  (kiểm chứng cuối)
```
- Task 1 là nền (mọi thứ backend phụ thuộc).
- Task 4 cần 1 (+3 để vẽ); 6 cần 1; 5 cần 4.
- Frontend 7→8→9→10; 11 cần 9.
- Task 12 chạy sau khi backend (4,5,6) + frontend (10,11) xong.

## Notes
- Mặc định `exportUniqueSheets = True` cho Bình Tem Bế; giữ đường tắt để tương thích ngược.
- Dùng chung `full_layouts[p_idx]` để `items_per_sheet` khớp tuyệt đối với preview/Rust.
- Vẽ report bằng reportlab overlay + font DejaVuSans (Unicode tiếng Việt).
- Cảnh báo property-based test: nếu dùng Hypothesis, đánh dấu rõ khi chạy.

