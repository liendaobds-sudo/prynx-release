# Implementation Plan: VDP Upgrade (PrynX)

## Overview

Kế hoạch triển khai 5 hạng mục Tier-1 nâng cấp engine VDP theo `design.md`. Ngôn ngữ triển khai: **Python** (backend, dùng Hypothesis cho property-based test) và **TypeScript/React** (frontend VDP_UI). Mỗi bước xây trên bước trước, kết thúc bằng việc nối các thành phần vào API và UI. Các thành phần lõi là hàm thuần (parser, condition engine, GS1, validator, quy đổi toạ độ) được hiện thực trước, kiểm bằng property test, rồi mới refactor đường render dùng chung và wiring multiprocess/route/UI.

Tham chiếu file chính: `backend/app/workers/vdp_datasource.py` (mới), `vdp_conditions.py` (mới), `vdp_gs1.py` (mới), `vdp_preview.py` (mới), `vdp_validate.py` (mới), `vdp_engine.py` (mở rộng), `backend/app/schemas/vdp.py` (mở rộng), `backend/app/api/routes/vdp.py` (mở rộng), và frontend `desktop/src/components/preprocess-tools/DataMergeTool.tsx` + `LivePageFrame.tsx`.

## Tasks

- [x] 1. Mở rộng schema dữ liệu field cho tính năng mới
  - [x] 1.1 Thêm các model điều kiện/rule và mở rộng VdpField
    - Trong `backend/app/schemas/vdp.py`: thêm `VdpFieldCondition` (column, operator, value, action), `VdpRule` (column, operator, value, result)
    - Mở rộng `VdpField` với `conditions`, `rules` (Optional, mặc định None), `barcodeType` nhận thêm `'datamatrix'|'gs1-128'|'gs1-datamatrix'`, và `gs1HumanReadable` (mặc định False) — bảo toàn hành vi cũ khi các trường mới không được set
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 3.10, 7.2_

- [x] 2. Hiện thực Data_Source_Reader (đọc & chuẩn hoá nguồn dữ liệu)
  - [x] 2.1 Tạo lõi thuần: RecordTable, DataSourceError, các hàm nhận diện
    - Tạo `backend/app/workers/vdp_datasource.py` (không import ReportLab)
    - Định nghĩa `RecordTable` (columns, rows), `DataSourceError` (code, message tiếng Việt)
    - Hiện thực `detect_encoding` ({utf-8, utf-8-sig, windows-1258}), `detect_delimiter` ({',',';','\t'}), `normalize_columns` (khử trùng tên + ô rỗng)
    - _Requirements: 1.5, 1.6, 1.8, 1.11_

  - [x]* 2.2 Viết property test cho detect_delimiter
    - **Property 5: Nhận diện delimiter đúng**
    - **Validates: Requirements 1.5**

  - [x]* 2.3 Viết property test cho detect_encoding (round-trip tiếng Việt)
    - **Property 6: Nhận diện encoding round-trip**
    - **Validates: Requirements 1.6, 1.7**

  - [x]* 2.4 Viết property test cho normalize_columns
    - **Property 7: Khử trùng tên cột không mất cột**
    - **Validates: Requirements 1.11**

  - [x] 2.5 Hiện thực parse_delimited + read_source (đường CSV) và quy tắc dòng tiêu đề
    - `parse_delimited(text, delimiter, has_header)` → RecordTable; dòng tiêu đề = dòng KHÔNG rỗng đầu tiên, bỏ qua dòng hoàn toàn rỗng
    - `read_source(kind, payload, ...)` điều phối theo định dạng; lỗi EMPTY/NO_HEADER khi thiếu dữ liệu/tiêu đề (không tạo bảng)
    - _Requirements: 1.1, 1.9, 1.10_

  - [x]* 2.6 Viết property test round-trip CSV (gồm tiếng Việt)
    - **Property 1: CSV round-trip bảo toàn dữ liệu (kể cả tiếng Việt)**
    - **Validates: Requirements 1.1, 1.7**

  - [x]* 2.7 Viết property test cấu trúc RecordTable đồng nhất + quy tắc dòng tiêu đề
    - **Property 8: Cấu trúc RecordTable đồng nhất và quy tắc dòng tiêu đề**
    - **Validates: Requirements 1.10**

  - [x] 2.8 Hiện thực read_xlsx + list_xlsx_sheets (openpyxl)
    - Thêm `openpyxl` vào `backend/requirements.txt`
    - `read_xlsx(data, sheet)` ở chế độ read_only; merged cell gán giá trị ô trên-trái, các ô còn lại rỗng; `list_xlsx_sheets(data)` trả tên sheet
    - _Requirements: 1.2, 1.3, 1.12_

  - [x]* 2.9 Viết property test round-trip XLSX
    - **Property 2: XLSX round-trip bảo toàn dữ liệu**
    - **Validates: Requirements 1.2**

  - [x]* 2.10 Viết property test liệt kê và chọn sheet XLSX
    - **Property 3: Liệt kê và chọn sheet trong XLSX**
    - **Validates: Requirements 1.3**

  - [x]* 2.11 Viết property test merged cell gán ô trên-trái
    - **Property 4: Merged cell gán về ô trên-trái**
    - **Validates: Requirements 1.12**

  - [x] 2.12 Hiện thực fetch_gsheet_csv (httpx)
    - Chuyển link Google Sheets thành URL export CSV; HTTP 4xx/redirect login → `GSHEET_FORBIDDEN`; nối vào `read_source`
    - _Requirements: 1.4, 1.13_

  - [x]* 2.13 Viết integration test fetch Google Sheets (mock httpx)
    - Kiểm đường export CSV thành công và ca thiếu quyền trả lỗi GSHEET_FORBIDDEN
    - _Requirements: 1.4, 1.13_

- [x] 3. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Hiện thực Condition_Engine (ẩn/hiện, token nội tuyến, bảng rule)
  - [x] 4.1 Hiện thực compare, is_visible, apply_rules
    - Tạo `backend/app/workers/vdp_conditions.py`
    - `compare(cell, operator, value)` cho {eq, ne, contains, empty, not_empty}: so sánh chuỗi, strip 2 đầu, không phân biệt hoa/thường
    - `is_visible(conds, row)` (show_if/hide_if); `apply_rules(rules, row)` theo first-match
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.9_

  - [x]* 4.2 Viết property test is_visible
    - **Property 9: Điều kiện ẩn/hiện đúng ngữ nghĩa**
    - **Validates: Requirements 2.1, 2.2**

  - [x]* 4.3 Viết property test apply_rules first-match
    - **Property 11: Bảng rule áp dụng theo first-match**
    - **Validates: Requirements 2.5, 2.6**

  - [x]* 4.4 Viết property test ngữ nghĩa toán tử so sánh
    - **Property 12: Ngữ nghĩa toán tử so sánh**
    - **Validates: Requirements 2.9**

  - [x] 4.5 Hiện thực resolve_inline (escape) + resolve_field_content (thứ tự cố định)
    - `resolve_inline(text, row)` cho `{Cot?A:B}`: chọn nhánh literal (không đệ quy), parser quét ký tự xử lý escape `\:`, `\}`, `\\`
    - `resolve_field_content(field, row)` theo thứ tự Req 2.11: ẩn/hiện → rule → token nội tuyến → placeholder cũ (`_substitute`); cột không tồn tại → `ConditionError`
    - _Requirements: 2.3, 2.4, 2.7, 2.8, 2.10, 2.11_

  - [x]* 4.6 Viết property test token {Cot?A:B} chọn nhánh literal
    - **Property 10: Token `{Cot?A:B}` chọn nhánh literal, không đệ quy**
    - **Validates: Requirements 2.3, 2.4**

  - [x]* 4.7 Viết property test escape trong nhánh token
    - **Property 13: Escape trong nhánh token điều kiện**
    - **Validates: Requirements 2.10**

  - [x]* 4.8 Viết property test tương thích ngược với cơ chế placeholder cũ
    - **Property 14: Tương thích ngược với cơ chế thay placeholder cũ**
    - **Validates: Requirements 2.8, 7.3**

- [x] 5. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Hiện thực Barcode 2D công nghiệp (GS1 + DataMatrix)
  - [x] 6.1 Hiện thực lõi GS1 thuần (parse/validate/build/human-readable/check-digit)
    - Tạo `backend/app/workers/vdp_gs1.py`: `AIElement`, `parse_gs1`, `validate_ai`, `build_gs1_payload` (FNC1 đầu + giữa AI biến độ dài), `human_readable`, `gtin_check_digit` (mod-10)
    - Hỗ trợ tối thiểu AI: `01` GTIN 14 số, `17` YYMMDD 6 số, `10` lô 1–20 chữ-số, `21` serial 1–20 chữ-số
    - _Requirements: 3.2, 3.3, 3.4, 3.6, 3.10_

  - [x]* 6.2 Viết property test GS1 payload chèn FNC1 + parse lại
    - **Property 15: GS1 payload chèn FNC1 đúng vị trí và parse lại được**
    - **Validates: Requirements 3.2, 3.3**

  - [x]* 6.3 Viết property test validate_ai (định dạng/độ dài)
    - **Property 16: Kiểm tra định dạng/độ dài AI**
    - **Validates: Requirements 3.4**

  - [x]* 6.4 Viết property test gtin_check_digit
    - **Property 17: Tính chữ số kiểm tra GTIN**
    - **Validates: Requirements 3.6**

  - [x]* 6.5 Viết property test human_readable
    - **Property 19: Chuỗi human-readable GS1**
    - **Validates: Requirements 3.10**

  - [x] 6.6 Hiện thực render_2d và nối nhánh barcode trong vdp_engine
    - Trong `vdp_engine.py`: `render_2d` dùng `ECC200DataMatrix`; GS1-128 trên nền `Code128` + FNC1; quiet zone & màu CMYK theo `CSS_TO_PT_FACTOR`
    - Kiểm fit: X-dimension ≥ 0.254 mm và quiet zone ≥ 1 module; AI sai/loại chưa hỗ trợ/khung quá nhỏ → nhãn ERR + báo cáo, không sinh mã sai chuẩn; giữ nguyên nhánh 1D + QR
    - _Requirements: 3.1, 3.5, 3.7, 3.8, 3.9, 3.11_

  - [x]* 6.7 Viết property test quiet zone barcode 2D dùng cùng hệ quy đổi 1D
    - **Property 18: Quiet zone barcode 2D dùng cùng hệ quy đổi với 1D**
    - **Validates: Requirements 3.7**

  - [x]* 6.8 Viết property test ngưỡng kích thước module/quiet zone
    - **Property 20: Ngưỡng kích thước module/quiet zone barcode 2D**
    - **Validates: Requirements 3.11**

  - [x]* 6.9 Viết regression/golden test 7 loại barcode 1D + QR không đổi
    - Kiểm output 1D/QR giữ nguyên hành vi sau khi thêm nhánh 2D
    - _Requirements: 3.8, 7.2_

- [x] 7. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Refactor lõi render-một-record + bảo toàn parity (toạ độ, màu, template index)
  - [x] 8.1 Tách render_one_record dùng chung và neo hằng số parity
    - Trong `vdp_engine.py`: refactor `process_chunk` để gọi `render_one_record(c, fields, row, ...)`; áp dụng `CSS_TO_PT_FACTOR = 0.75`, `hex_to_cmyk` (#000000 → (0,0,0,1)), xoay 0/90/180/270, gán trang `record_idx % template_page_count`
    - _Requirements: 6.1, 6.2, 6.4, 7.4_

  - [x]* 8.2 Viết property test quy đổi toạ độ theo CSS_TO_PT_FACTOR
    - **Property 25: Quy đổi toạ độ theo CSS_TO_PT_FACTOR**
    - **Validates: Requirements 6.1**

  - [x]* 8.3 Viết property test màu đen pure-K
    - **Property 26: Màu đen pure-K**
    - **Validates: Requirements 6.2**

  - [x]* 8.4 Viết property test công thức gán template cho record
    - **Property 31: Công thức gán template cho record**
    - **Validates: Requirements 7.4**

  - [x]* 8.5 Viết regression/golden test tương thích ngược output CSV cũ
    - So output job CSV với cấu hình field hiện có khớp hành vi trước nâng cấp
    - _Requirements: 7.1_

- [x] 9. Hiện thực Preview_Service (xem trước record + điều hướng)
  - [x] 9.1 Hiện thực clamp_index + render_record_preview (dùng render_one_record)
    - Tạo `backend/app/workers/vdp_preview.py`: `clamp_index` (kẹp [1,total] + cờ clamped); `render_record_preview` dùng chung `render_one_record`, trả PNG + `field_errors` kèm `rect`; total==0 → báo nguồn rỗng
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.9, 4.10, 6.3_

  - [x]* 9.2 Viết property test giới hạn chỉ số record
    - **Property 21: Giới hạn chỉ số record xem trước**
    - **Validates: Requirements 4.5**

  - [x]* 9.3 Viết property test dấu hiệu lỗi field đặt đúng vị trí
    - **Property 22: Dấu hiệu lỗi field trong preview đặt đúng vị trí**
    - **Validates: Requirements 4.6**

  - [x]* 9.4 Viết property test parity preview ↔ engine (toạ độ, màu, xoay)
    - **Property 24: Parity preview ↔ engine (toạ độ, màu, xoay)**
    - **Validates: Requirements 4.4, 6.3, 6.4**

- [x] 10. Hiện thực Validator + xuất báo cáo lỗi
  - [x] 10.1 Hiện thực Issue, validate_batch, gating_state
    - Tạo `backend/app/workers/vdp_validate.py`: `Issue` (severity, record_idx, field, reason); `validate_batch(fields, table)` kiểm cột tham chiếu, ảnh biến đổi TOÀN BỘ record (warning), giá trị barcode theo symbology (EAN13/EAN8/GS1 AI), nguồn 0 record (error chặn)
    - `gating_state(issues)` → block/needs_confirmation/allow; chỉ trả issue, không sinh trang nào
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11_

  - [x]* 10.2 Viết property test validate cột tham chiếu tồn tại
    - **Property 27: Validate cột tham chiếu tồn tại**
    - **Validates: Requirements 5.1, 5.2**

  - [x]* 10.3 Viết property test kiểm ảnh biến đổi trên TOÀN BỘ record
    - **Property 28: Kiểm tra ảnh biến đổi trên TOÀN BỘ record**
    - **Validates: Requirements 5.3, 5.4**

  - [x]* 10.4 Viết property test validate giá trị barcode theo symbology
    - **Property 29: Validate giá trị barcode theo symbology**
    - **Validates: Requirements 5.5, 5.6**

  - [x]* 10.5 Viết property test quyết định cổng (gating)
    - **Property 30: Quyết định cổng (gating) trước khi sinh lô**
    - **Validates: Requirements 5.8, 5.9, 5.10**

  - [x] 10.6 Hiện thực sinh báo cáo lỗi CSV
    - Hàm sinh CSV: mỗi dòng gồm chỉ số dòng record, tên field, lý do cho mỗi record MISSING/ERR; trường hợp không lỗi → CSV cho biết không phát hiện lỗi
    - _Requirements: 4.7, 4.8_

  - [x]* 10.7 Viết property test báo cáo lỗi CSV round-trip
    - **Property 23: Báo cáo lỗi CSV round-trip**
    - **Validates: Requirements 4.7**

- [x] 11. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Wiring sinh lô: chunking, đa tiến trình, chịu lỗi MISSING/ERR
  - [x] 12.1 Nối Condition_Engine + Barcode_Renderer vào process_chunk và bảo toàn chia chunk
    - Trong `vdp_engine.py`: gọi `resolve_field_content` trong `render_one_record`; chia chunk + multiprocess như cơ chế hiện có; gắn MISSING khi thiếu cột, ERR khi render lỗi, tiếp tục record còn lại; ghi record lỗi vào báo cáo
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6_

  - [x]* 12.2 Viết property test chia chunk bảo toàn dữ liệu
    - **Property 32: Chia chunk bảo toàn dữ liệu**
    - **Validates: Requirements 8.1**

  - [x]* 12.3 Viết property test bảo toàn và chịu lỗi khi sinh lô
    - **Property 33: Bảo toàn và chịu lỗi khi sinh lô**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.6**

- [x] 13. Bổ sung API routes và nối backend
  - [x] 13.1 Thêm route /vdp/datasource, /datasource/sheets, /validate, /preview, /error-report
    - Trong `backend/app/api/routes/vdp.py`: nối `read_source`, `list_xlsx_sheets`, `validate_batch`+`gating_state`, `render_record_preview`, sinh báo cáo lỗi; `DataSourceError` → HTTP 400 với detail tiếng Việt; giữ `Depends(require_license)`
    - _Requirements: 1.1, 1.3, 4.1, 4.7, 5.7, 5.8_

  - [x]* 13.2 Viết integration test cho các route mới
    - Kiểm datasource (csv/xlsx/sheets), validate gating, preview, error-report end-to-end qua TestClient; xác nhận /validate không sinh artifact PDF
    - _Requirements: 5.7_

- [x] 14. Frontend VDP_UI: nguồn dữ liệu, điều kiện/rule, preview, báo cáo lỗi
  - [x] 14.1 UI chọn nguồn dữ liệu (xlsx sheet, Google Sheets link)
    - Trong `DataMergeTool.tsx`: thêm nạp `.xlsx` (chọn sheet), nhập link Google Sheets; gọi `/vdp/datasource` và hiển thị cột + số record hoặc thông báo lỗi
    - _Requirements: 1.2, 1.3, 1.4, 1.8, 1.13_

  - [x] 14.2 UI cấu hình điều kiện ẩn/hiện + bảng rule cho field
    - Thêm panel cấu hình `conditions` và `rules` (operator {eq,ne,contains,empty,not_empty}) gắn vào VdpField
    - _Requirements: 2.1, 2.2, 2.5, 2.6_

  - [x] 14.3 UI preview record + điều hướng + chỉ báo xử lý + dấu hiệu lỗi
    - Gọi `/vdp/preview` bất đồng bộ, điều hướng prev/next, kẹp biên + thông báo; giữ UI phản hồi, hiện chỉ báo khi > 2 giây; vẽ dấu hiệu lỗi tại `rect` field
    - _Requirements: 4.2, 4.3, 4.5, 4.6, 4.9, 8.5_

  - [x] 14.4 UI gating validate + xuất báo cáo lỗi CSV
    - Gọi `/vdp/validate` trước khi cho sinh lô: chặn khi có error, yêu cầu xác nhận khi chỉ có warning, cho chạy khi sạch; nút xuất báo cáo lỗi tải CSV từ `/vdp/error-report`
    - _Requirements: 4.7, 4.8, 5.8, 5.9, 5.10_

- [x] 15. Final checkpoint - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks đánh dấu `*` là tùy chọn (test) và có thể bỏ qua để chạy MVP nhanh; task lõi không bao giờ đánh dấu tùy chọn.
- Mỗi property test gắn comment tham chiếu `# Feature: vdp-upgrade, Property {number}: {property_text}` và chạy ≥ 100 ví dụ (`@settings(max_examples=100)`), đặt tại `backend/tests/vdp/test_*_properties.py`.
- Mỗi correctness property được hiện thực bằng đúng MỘT property-based test (Hypothesis — đã có sẵn trong dự án).
- Mỗi task tham chiếu requirements cụ thể để truy vết; checkpoint đảm bảo kiểm tra tăng dần.
- Các phần render PDF/ảnh thực tế và fetch Google Sheets được kiểm bằng golden/integration test thay vì property test.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "6.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "4.2", "4.3", "4.4", "6.2", "6.3", "6.4", "6.5"] },
    { "id": 2, "tasks": ["2.5", "4.5", "6.6"] },
    { "id": 3, "tasks": ["2.6", "2.7", "4.6", "4.7", "4.8", "6.7", "6.8", "6.9", "8.1"] },
    { "id": 4, "tasks": ["2.8", "8.2", "8.3", "8.4", "8.5"] },
    { "id": 5, "tasks": ["2.9", "2.10", "2.11", "9.1", "10.1"] },
    { "id": 6, "tasks": ["2.12", "9.2", "9.3", "9.4", "10.2", "10.3", "10.4", "10.5", "10.6"] },
    { "id": 7, "tasks": ["2.13", "10.7", "12.1"] },
    { "id": 8, "tasks": ["12.2", "12.3", "13.1"] },
    { "id": 9, "tasks": ["13.2", "14.1"] },
    { "id": 10, "tasks": ["14.2"] },
    { "id": 11, "tasks": ["14.3"] },
    { "id": 12, "tasks": ["14.4"] }
  ]
}
```
