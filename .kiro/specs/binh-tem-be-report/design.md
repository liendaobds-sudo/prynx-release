# Design Document

> Thiết kế kỹ thuật — Report & Xuất tờ duy nhất cho Bình Tem Bế

## Overview

Tính năng đổi cách xuất kết quả của Bình Tem Bế (`sticker_imposer`, chế độ Bình trang S&R / `layout_type='repeat'`):
- Thay vì nhân bản `sheetsNeeded` tờ giống nhau cho mỗi loại, **chỉ xuất 1 tờ duy nhất/loại**.
- Số lượng yêu cầu trở thành **dữ liệu in** (SL/tờ, số tờ cần in, số lượng thực) và được **vẽ thành khối Report** trên tờ.
- Thêm UI cấu hình report + tùy chọn đặt tên file theo report.

Điểm mấu chốt đã xác minh từ code: nhánh render thật nằm ở `nup_engine.run_nup_engine` → block `if layout_type == 'repeat':`. Hiện block này tính:
```python
items_per_sheet = len(fl['items'])
sheets_needed = math.ceil(qty / items_per_sheet)
for _ in range(sheets_needed):   # ← CHÍNH CHỖ NHÂN BẢN
    precalculated_placements[sheet_idx] = [...]
    sheet_idx += 1
```
Thiết kế sẽ thay `range(sheets_needed)` bằng `range(1)` (1 tờ/loại) khi bật chế độ mới, và đẩy `items_per_sheet/sheets_needed/actual_qty` vào dữ liệu report.

## Architecture

### Kiến trúc & luồng dữ liệu

```
Frontend (ImposerDashboard.handleExecute)
  settings += { exportUniqueSheets, reportDisplay, material, lamination, orderCode, saveByReport }
        │  POST /imposition/impose-start
        ▼
imposition._nup_process_worker → run_nup_engine
        │  (layout_type == 'repeat' + isDieCutMode)
        ▼
  Với mỗi loại p_idx:
     items_per_sheet = len(full_layouts[p_idx]['items'])
     sheets_needed   = ceil(qty / items_per_sheet)
     actual_qty      = sheets_needed * items_per_sheet
     → tạo ĐÚNG 1 sheet placements (không lặp sheets_needed)
     → report_data[p_idx] = {labelName, dims, labelsPerSheet, sheetCount, actualQty, ...}
        ▼
  nup_report.build_report_string(rd, data)  → chuỗi report
  nup_report.draw_report_on_page(...)        → vẽ overlay text lên tờ
        ▼
  run_report = bảng tổng hợp (loại, SL/tờ, qty, số tờ, tổng)
  saveByReport → đặt tên file theo report của tờ đầu
        ▼
  FileResponse + report message (đính kèm bảng tổng hợp)
```

## Components and Interfaces

### 1. Backend — module mới `app/workers/nup_report.py`

Tách riêng để test thuần (không phụ thuộc pikepdf cho phần build chuỗi).

```python
# Thuần — testable
def build_report_string(rd: dict, data: dict) -> str:
    """Port từ buildReportString (JSX). Nối các field bật theo fieldOrder bằng ' - ',
    bỏ field rỗng, chèn orderCode đầu, áp removeDiacritics, làm sạch '- -'."""

def compute_report_data(label_name, dims_mm, items_per_sheet, requested_qty,
                        material, lamination, cut_file_ref, mode_label) -> dict:
    """Tính sheetCount=ceil(qty/ips), actualQty=sheetCount*ips, format các field text."""

# Cần pikepdf/asset font
def draw_report_on_page(doc_out, page, report_str, position, offset_mm, font_size,
                        sheet_w_pt, sheet_h_pt, used_area_rect) -> None:
    """Vẽ khối text report lên 1 vùng trống của tờ (top/bottom/left/right)."""
```

**Vẽ text:** dùng font có sẵn `backend/app/assets/fonts/DejaVuSans.ttf` (hỗ trợ tiếng Việt). Phương án vẽ:
- Phương án A (ưu tiên): tạo overlay 1 trang bằng `reportlab` (đã có trong requirements) chứa text report → stamp/merge vào tờ bằng pikepdf (`Page.add_overlay` hoặc copy form XObject). Reportlab xử lý font Unicode + xuống dòng dễ.
- Phương án B: tự sinh content stream BT/Tf/Td/Tj + nhúng TrueType — phức tạp hơn, chỉ dùng nếu A vướng hiệu năng.
Quyết định: **Phương án A** (reportlab overlay), đặt text ở dải lề theo `position`.

### 2. Backend — sửa `nup_engine.run_nup_engine` (nhánh `layout_type == 'repeat'`)

- Đọc settings mới: `export_unique = settings.get('exportUniqueSheets', True)` (mặc định BẬT cho sticker), `report_display = settings.get('reportDisplay')`, `material`, `lamination`, `order_code`, `save_by_report`.
- Trong vòng lặp mỗi loại:
  - Giữ nguyên `items_per_sheet`, `sheets_needed`.
  - `repeat_count = 1 if export_unique else sheets_needed` → `for _ in range(repeat_count)`.
  - Tích lũy `report_rows.append({p_idx, labelName, items_per_sheet, requested_qty, sheets_needed, actual_qty})`.
- Sau khi dựng placements cho tờ, nếu `report_display` bật ≥ 1 field: build chuỗi + vẽ report lên đúng tờ đó (mỗi loại 1 tờ → 1 report).
- Trả về `report_message` có kèm bảng tổng hợp (Yêu cầu 5) + tổng số tờ.

**Tên tem (labelName):** lấy theo tên file nguồn / nhãn trang; nếu PDF nhiều trang dùng `Trang {idx+1}` hoặc tên do người dùng nhập (mở rộng sau). Kích thước lấy từ `trim_w/trim_h` (pt → mm).

### 3. Backend — `saveByReport` (đặt tên file)

- Trong `imposition._launch_impose_job` / `_nup_process_worker`: nếu `save_by_report` bật, sau khi engine trả report của tờ đầu, đổi tên file output theo `sanitize_filename(report_str_tờ_đầu)`.
- `sanitize_filename`: thay `\ / : * ? " < > |` → `-`/`_` (port từ JSX `sanitizeFilename`).

### 4. Frontend — Store (`useImposerSettingsStore.ts`)

Thêm state + persist:
```ts
exportUniqueSheets: boolean;          // mặc định true
reportDisplay: ReportDisplayConfig;   // {fieldOrder[], show*: bool, position, offsetX/Y, fontSize, removeDiacritics, ...}
reportMaterial: string;
reportLamination: number;             // 0=không,1=bóng,2=mờ
reportLaminationSides: number;
reportOrderCode: string;
saveByReport: boolean;
```
`ReportDisplayConfig` đặt trong `types.ts`. Có DEFAULT_REPORT_CONFIG. Đưa các field này vào `partialize` để persist.

### 5. Frontend — UI cấu hình Report

- Đặt trong `AdvancedSettingsSection.tsx`, chỉ hiện khi `activeTool === 'sticker_imposer'`.
- Gồm: toggle "Xuất tờ duy nhất + lệnh in", danh sách checkbox bật/tắt field (+ sắp xếp thứ tự lên/xuống), ô vị trí (select), cỡ chữ, mã ĐH, ô nhập tên nhãn (labelName), toggle bỏ dấu, toggle "Lưu file theo report".
- **Quản lý chất liệu:** select chất liệu (gộp DEFAULT_MATERIALS + customMaterials) + nút "＋ Thêm" (nhập tên → lưu vào customMaterials) và "🗑 Xóa" (chỉ xóa được chất liệu tùy chỉnh); select cán màng (Không/Bóng/Mờ) + số mặt (1/2).
- Tận dụng component `Checkbox`, `RichSelect` có sẵn.

### 6. Frontend — Truyền settings & Bảng tổng hợp

- `ImposerDashboard.handleExecute` (nhánh non-booklet) thêm các field report vào object gọi `onStartNup`.
- Bảng tổng hợp: tái dùng bảng "Số lượng riêng từng trang" trong `GridSettingsSection` — bỏ điều kiện ẩn cột `T/Tờ` & `Số tờ` cho sticker (hiện đang ẩn ở `taskMode==='sticker_imposer'`). Đây cũng vá luôn điểm UX đã nêu trước đó.

### 7. Lưu file in (Save Print Files) — component mới

- **Component:** `SavePrintFilesModal.tsx` (mở từ tab kết quả / nút "Lưu file in"). Tab kết quả **không đóng** — chỉ ghi file ra đĩa.
- **Chọn thư mục:** `@tauri-apps/plugin-dialog` `open({ directory: true })`.
- **Ghi đĩa:** `@tauri-apps/plugin-fs` `writeFile` / `mkdir`. Mỗi tờ = 1 PDF (tách từ file kết quả nhiều trang bằng pdf-lib hoặc backend `/pdf-tools/split`).
- **State (store):** `savePrint: { folder, nameMode: 'report'|'number'|'original', separateCut, folderMode: 'per_order'|'flat', includeOrderCode, includeDate }`.
- **Đặt tên:** dùng `report string` (đã có từ backend job) + tiền tố số; `sanitize_filename` phía FE (port từ `nup_report`). File bế = tên file in + " (cut)".
- **Preview cây thư mục:** render WYSIWYG từ cấu hình + danh sách loại/report trước khi ghi (Yêu cầu 8.6).
- **File bế riêng (Yêu cầu 8.3):** [VERIFIED] engine ĐÃ hỗ trợ — khi `separateCutPage=True`, mỗi tờ xuất 2 trang `[in, bế]` (trang bế = `out_page_cut`, chỉ đường cắt; trang in đã strip path bế). Với `exportUniqueSheets`, output = `[in_A, bế_A, in_B, bế_B, ...]`. **Toggle "tách in/bế" phải bật ở settings bình bài (trước khi chạy)**, không phải lúc lưu. Modal lưu chỉ tách các trang đã có: trang chẵn (0,2,4…) = file in, trang lẻ (1,3,5…) = file bế. → KHÔNG cần sửa backend.

## Data Models

### ReportDisplayConfig (FE) / report_display (BE) — cùng schema
```ts
interface ReportDisplayConfig {
  enabled: boolean;
  fieldOrder: string[];      // mặc định: ['orderCode','identifier','labelName','material','lamination','labelsPerSheet','actualQty','sheetCount','dimensions','paperSize','cutFileRef','modeLabel']
  showIdentifier: boolean; showLabelName: boolean; showDimensions: boolean; showPaperSize: boolean;
  showLabelsPerSheet: boolean; showSheetCount: boolean; showActualQty: boolean;
  showMaterial: boolean; showLamination: boolean; showCutFileRef: boolean; showModeLabel: boolean;
  labelNameText: string;     // tên nhãn người dùng nhập
  position: 'top'|'bottom'|'left'|'right';
  offsetX: number; offsetY: number;   // mm
  fontSize: number;                    // pt
  removeDiacritics: boolean;
}
```

### Material management (store)
```ts
DEFAULT_MATERIALS = ['Decal PP','Decal Đế vàng','Decal Nhựa mờ','Decal Nhựa trong','Decal Bể (Tem vỡ)'];
customMaterials: string[];     // persist — người dùng tự thêm/xóa
reportMaterial: string;        // chất liệu đang chọn
reportLamination: number;      // 0=không,1=bóng,2=mờ
reportLaminationSides: number; // 1 | 2
reportOrderCode: string;
saveByReport: boolean;
exportUniqueSheets: boolean;   // mặc định true
```

### report_data (mỗi loại, BE → text)
```python
{ 'labelName': str, 'dimensions': '50 x 50 mm', 'labelsPerSheet': 'SL/tờ: 48',
  'sheetCount': 'Số tờ: 21', 'actualQty': 'SL thực: 1008',
  'material': 'Decal sữa', 'lamination': 'Cán mờ 1 mặt',
  'cutFileRef': '', 'modeLabel': 'Bế tem', 'orderCode': 'DH123' }
```

## Error Handling
- `items_per_sheet == 0` (Yêu cầu 1.4): bỏ qua loại đó, ghi cảnh báo vào report_message, tiếp tục các loại khác.
- reportlab/overlay lỗi: log cảnh báo, vẫn xuất tờ (không vẽ report) — không làm sập job.
- `save_by_report` mà report rỗng: fallback tên mặc định.
- Font thiếu: fallback Helvetica (mất tiếng Việt có dấu → khuyến nghị bật bỏ dấu).

## Testing Strategy
- **Unit (thuần, không deps nặng):**
  - `build_report_string`: thứ tự field, bỏ field rỗng, orderCode đầu, removeDiacritics, dọn '- -'.
  - `compute_report_data`: `sheetCount=ceil(qty/ips)`, `actualQty=ips*sheetCount`; biên qty=0, ips=0.
- **Integration engine:** chạy `run_nup_engine` với 1 file nhiều trang, `layout_type='repeat'`, `exportUniqueSheets=True`, qty>0 → khẳng định số trang output = số loại (không nhân bản); report rows đúng.
- **Regression:** `exportUniqueSheets=False` → giữ hành vi cũ (nhân bản); N-Up/Booklet không đổi; chạy lại `tests/` (giữ 85 pass).
- **Frontend:** `tsc --noEmit` pass; (nếu có) vitest cho hàm build report phía FE nếu nhân đôi logic.

## Correctness Properties

### Property 1: Bảo toàn số lượng
Với mọi `qty>0, ips>0`: `sheetCount*ips >= qty` và `(sheetCount-1)*ips < qty` (số tờ tối thiểu đủ để in đạt số lượng).
**Validates: Requirements 1.2**

### Property 2: Không nhân trang
Ở chế độ `exportUniqueSheets=True`, số trang output == số loại có layout hợp lệ (không lặp theo số lượng).
**Validates: Requirements 1.1**

### Property 3: Report nối chuỗi đúng
Số đoạn trong chuỗi report == số field được bật & không rỗng (cộng orderCode nếu có); chuỗi không chứa cụm "- -".
**Validates: Requirements 2.3**

### Property 4: Tên file an toàn
Output của `sanitize_filename` không chứa bất kỳ ký tự nào trong `\ / : * ? " < > |`.
**Validates: Requirements 4.2**

## Quyết định thiết kế then chốt
- **Mặc định BẬT** `exportUniqueSheets` cho Bình Tem Bế (đúng nhu cầu thực); vẫn cho tắt để tương thích ngược.
- **Dùng chung kết quả layout** (`full_layouts[p_idx]`) để lấy `items_per_sheet` → số liệu report khớp tuyệt đối với bản preview/Rust (Yêu cầu 6.3).
- **Reportlab overlay** cho phần vẽ text (đã có dependency + font Unicode), tránh tự nhúng font phức tạp.
