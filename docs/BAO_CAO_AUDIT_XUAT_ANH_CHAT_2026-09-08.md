# BÁO CÁO AUDIT XUẤT ẢNH — CHẤT LƯỢNG CHỮ VÀ TÍNH ĐÚNG ARTIFACT — 2026-09-08

> Trạng thái: **Đã triển khai các bản vá xác nhận trong Lô A–E; còn proof gap RGB font và nghiệm thu runtime trên PDF thật.**
> Báo cáo này mở rộng các audit Xuất ảnh ngày 2026-07-30/31, tập trung vào
> ảnh trước/sau do người dùng cung cấp và các lỗi có thể làm sai file ảnh.

## 1. Phạm vi và bằng chứng đầu vào

Luồng được trace:

`AcrobatViewer.tsx` → `ExportImageModal.tsx` → `api.ts::exportImagesBatch()` →
`POST /api/export/images/batch` → `render_pdf_to_images()` →
`_render_cmyk_pages()` hoặc PDFium RGB/Gray → Pillow → TIFF/JPEG/PNG/WebP.

Đối chiếu ảnh người dùng:

- Ảnh #2 là trạng thái trước xuất, chữ “Lạc Long Quân” có biên mượt.
- Ảnh #1 là trạng thái sau xuất, biên chữ bị lượng tử/răng cưa rõ rệt.
- Ảnh #3 cho thấy cấu hình **300 DPI + CMYK + JPEG**, đúng nhánh PPE CMYK.

Giả định trên dùng để khoanh vùng; chưa có PDF gốc và file ảnh đầu ra nên chưa
thể làm diff pixel cùng kích thước với hai ảnh chụp màn hình.

## 2. Kết luận điều hành

Finding chính đã được xác nhận bằng code và probe native, sau đó đã sửa: nhánh CMYK xuất ảnh
đang dùng cấu hình đo mực `RenderOptions::ink_accurate()` với anti-alias chữ bị
tắt. Đây là nguyên nhân trực tiếp phù hợp với ảnh #1; nó áp dụng cho cả TIFF và
JPEG, không chỉ riêng chất lượng JPEG.

Hai rủi ro correctness đáng ưu tiên tiếp theo:

1. Đường RGB/Gray không nhân `/UserUnit`, nên PDF dùng UserUnit khác 1 có thể
   xuất sai kích thước vật lý, DPI và vị trí chữ.
2. DPI tối đa 1200 được nhận nhưng không có chốt diện tích/cạnh pixel trước khi
   gọi PDFium; trang lớn có thể cấp phát rất lớn trong sidecar.

Các mục còn lại là lỗi parity/proof gap có bằng chứng tĩnh: font Type0 CMap
không phải Identity bị xấp xỉ, RGB không có cổng kiểm fidelity font, hủy rồi
   chạy lại có thể chồng job, estimate không phản ánh lựa chọn TrimBox, và
   transparency bị flatten nền trắng không có lựa chọn.

## 3. Bảng phát hiện

| Mã | Mức | Trạng thái | Bằng chứng | Tác động | Effort |
|---|---:|---|---|---|---:|
| **EXIMG-01** | **P1** | **CONFIRMED** | `native/src/print_engine_py.rs:1362-1368` gọi `RenderOptions::ink_accurate()`; `print_engine/src/content/interp.rs:243-260` định nghĩa `anti_alias=false` cho ink mode và `true` cho soft-proof. Route ghi trực tiếp CMYK tại `backend/app/api/routes/export.py:294-299,319-333`. | Chữ/vector biên nhị phân, mất pixel trung gian, răng cưa hoặc mất nét nhỏ. Probe 300 DPI với “Lạc Long Quân”: CMYK có `partial=0` ở cả 4 kênh; soft-proof có 63.938 pixel trung gian/kênh. | S |
| **EXIMG-02** | **P1** | **CONFIRMED** | `backend/app/api/routes/export.py:395-397,474` luôn dùng `scale=dpi/72`; pypdfium2 không áp `/UserUnit`. Viewer Tauri đã phải nhân UserUnit tại `desktop/src-tauri/src/lib.rs:3956-3959`; `backend/app/core/page_boxes.py:1322-1324` cũng ghi rõ PDFium bỏ qua UserUnit. | PDF có `/UserUnit=2` @72 DPI được probe ra `100×50` thay vì `200×100`; sai kích thước vật lý, DPI và hình học chữ. | M |
| **EXIMG-03** | **P1** | **CONFIRMED RISK** | Chỉ có giới hạn `dpi 36..1200` tại `backend/app/api/routes/export.py:36-38,393-397`; không có `max_side/max_pixels` trước `page.render` (`:459-476`). Scheduler được gọi không truyền `memory_required_mb` (`:578-591`), nên chỉ giới hạn slot, không biết kích thước trang. | A0/A1 hoặc PDF khai MediaBox rất lớn @600–1200 DPI có thể cấp phát hàng trăm MP, làm swap/OOM/sidecar chết. Test hiện hành chỉ dùng trang `200×300 pt` @1200 (`backend/tests/test_export_images.py:80-87`). | M |
| **EXIMG-04** | **P1** | **SUSPECTED** | `print_engine/src/text/font.rs:620-633` cho mọi Type0 `/Encoding` không bắt đầu `Identity` rơi về `CMap::identity_two_byte()` và ghi rõ “xấp xỉ; sai CID”. CMYK export gọi renderer này tại `native/src/print_engine_py.rs:1387-1395`. Không có fixture Type0/CJK/CMap trong `print_engine/tests`. | Chữ CJK hoặc Type0 có CMap custom có thể ra sai glyph nhưng vẫn trông như “có chữ”; dấu/diacritics và bề rộng dòng có thể sai. | M |
| **EXIMG-05** | **P1** | **SUSPECTED / PROOF GAP** | RGB/Gray chỉ `page.render(...).to_pil().convert(...)` tại `backend/app/api/routes/export.py:459-476`; không trả glyph report/fallback diagnostics. Test export dùng rectangle tại `backend/tests/test_export_images.py:17-33`, không có text/font. | Font không nhúng/hỏng có thể bị host PDFium thay hoặc bỏ glyph, trong khi HTTP vẫn trả thành công; viewer và file xuất không đồng nhất. | M |
| **EXIMG-06** | **P2** | **CONFIRMED** | `ExportImageModal.tsx:173-179` abort rồi lập tức `setBusy(false)` và xóa `abortRef`; request backend/worker có thể còn đang dừng cooperative. `doExport` cho phép lượt mới khi `abortRef.current` đã null (`:204-220`). | Người dùng bấm Hủy rồi Xuất lại có thể chạy hai worker, tạo file ngoài ý muốn hoặc tranh RAM/CPU. Chưa có test restart-after-cancel. | S |
| **EXIMG-07** | **P2** | **CONFIRMED** | Estimate tại `ExportImageModal.tsx:141-169` không phụ thuộc `includeBleed`; request thật truyền lựa chọn này tại `:241-247`. | Khi chọn TrimBox (`includeBleed=false`) hoặc tài liệu có box khác nhau, px/MB hiển thị có thể không đúng artifact thực tế. | S |
| **EXIMG-08** | **P2** | **CONFIRMED BEHAVIOR / POLICY GAP** | PDFium mặc định fill trắng và route luôn đổi sang `RGB`/`L` tại `backend/app/api/routes/export.py:406,474-476`; không có alpha/background option. | PDF có transparency bị flatten nền trắng âm thầm; không thể xuất PNG trong suốt hoặc xác nhận nền mong muốn. | M |
| **EXIMG-09** | **P2** | **PARITY GAP** | Viewer Tauri bật LCD subpixel AA ở `desktop/src-tauri/src/lib.rs:3964-4000`; backend export không truyền `optimize_mode='lcd'` hay policy AA tương đương tại `backend/app/api/routes/export.py:459-476`. | Cùng PDF có thể nhìn mượt trong viewer nhưng khác biên khi xuất RGB; với CMYK, EXIMG-01 còn làm chênh lệch lớn hơn. | M |
| **EXIMG-10** | **P2** | **PROOF GAP** | `backend/tests/test_export_images.py` hiện không có fixture chữ, UserUnit, transparency, form, Type0 hoặc golden/reference pixel; frontend chỉ kiểm plan/range tại `desktop/src/components/workspace/ExportImageModal.test.ts:1-110`. | 34 test backend xanh chưa chứng minh chất lượng glyph hay parity preview→artifact; lỗi giống ảnh người dùng có thể lọt. | M |

## 4. Probe và phép kiểm đã chạy

### 4.1. Probe anti-alias CMYK

Tạo PDF tạm có font DejaVuSans nhúng và chữ “Lạc Long Quân”, render @300 DPI
qua native `ppe_export_cmyk`, `ppe_softproof` và PDFium RGB:

| Đường | Kích thước | Pixel trung gian (0<v<255) | Nhận xét |
|---|---:|---:|---|
| `ppe_export_cmyk` trước Lô A | `1250×833` | `0` ở C/M/Y/K | Anti-alias bị tắt |
| `ppe_export_cmyk` sau Lô A | `1250×833` | `C=0, M=4281, Y=4281, K=0` | Anti-alias đã bật |
| `ppe_softproof` | `1250×833` | `63.938` mỗi kênh RGB | Anti-alias bật |
| PDFium RGB | `1250×834` | `64.647` mỗi kênh | Biên mượt; chênh 1 hàng do quy ước extent khác |

### 4.2. Probe `/UserUnit`

PDF tạm `100×50 pt`, đặt `/UserUnit=2`, xuất RGB @72 DPI. Trước Lô B kết quả là
`100×50 px`; sau Lô B đã là `200×100 px`, đúng kích thước vật lý.

### 4.3. Test baseline

- Baseline trước lô: `backend\venv\Scripts\python.exe -m pytest -q backend/tests/test_export_images.py` → **34 passed, 1 warning**.
- `cargo test --manifest-path print_engine/Cargo.toml anti_alias_mode_softens_edges_while_ink_mode_does_not -- --exact` → **1 passed**; full crate test sau lô đạt.
- Toàn bộ frontend Vitest: **310 files, 3448 passed, 2 skipped**.
- `npm run lint`: còn 2 lỗi baseline ngoài phạm vi audit (`LayerPanel.tsx`,
  `api.mergeManifest.test.ts`); không có lỗi ở file Lô D/E.
- `desktop/npm run typecheck` → **đạt** (tsc không lỗi).
- `backend\venv\Scripts\python.exe -m pytest -q backend/tests/test_pdfium_bundle_version_parity.py` → **3 passed, 1 warning**.

Các regression mới đã bổ sung kiểm chữ Việt, UserUnit, RAM estimate, lifecycle
Hủy và transparency; vẫn cần nghiệm thu runtime trên PDF gốc của bạn.

Probe route cuối: JPEG CMYK chữ Việt nhúng → `1250×833`, mode `CMYK`, ICC có
mặt; PDF `/UserUnit=2` RGB @72 DPI → `200×100`.

## 5. Trạng thái triển khai và verify theo lô

### Lô A — Chất lượng chữ CMYK — ĐÃ ÁP

Đã tách cấu hình `export_cmyk` khỏi `ink_accurate`: giữ CMYK/flatten spot/overprint
cho sản xuất nhưng bật AA khi tạo bitmap ảnh; bổ sung fixture chữ Việt và golden
kiểm pixel trung gian ở TIFF/JPEG. Không thay đổi `ink_accurate` dùng cho TAC/
separations.

### Lô B — Kích thước vật lý và an toàn cấp phát — ĐÃ ÁP

Đã nhân UserUnit vào scale/DPI hiệu dụng trước render; thêm kiểm tra diện
tích/cạnh theo RAM tier. Máy `≥16 GB` không bị cap vô điều kiện; máy yếu mới
giảm/khước từ theo nguyên tắc `prynx-performance`. Thêm test UserUnit và trang
lớn, không chạy probe có nguy cơ OOM.

### Lô C — Fidelity font và CMap — ĐÃ ÁP

Đã chặn CMap Type0 không hỗ trợ/malformed theo hướng fail-closed và thêm fixture
Identity-H/UniJIS, chữ Việt nhúng. Cảnh báo fallback chỉ phát khi glyph thực sự
được dùng. **EXIMG-05 (fidelity font của đường RGB PDFium) vẫn là proof gap**:
chưa có PDF gốc để chứng minh trường hợp thay/bỏ glyph, nên không thêm cổng chặn
font thiếu theo suy đoán có thể từ chối nhầm PDF Base14 hợp lệ.

### Lô D — Frontend lifecycle/estimate — ĐÃ ÁP

Đã giữ trạng thái “đang hủy” đến khi request kết thúc; 
ngăn restart chồng worker. Estimate nhận đúng page box và có test component.

### Lô E — Policy output và parity — ĐÃ ÁP

Đã công khai policy alpha/background và annotation/widget trong UI; RGB/Gray tắt
annotation/widget để thống nhất với CMYK PPE. LCD giữ là display-only, export dùng
anti-alias tiêu chuẩn. Regression khóa transparency/annotation; nhóm
export/scheduler/PPE cuối đạt **154 test** và toàn frontend đạt **3448 test**.

## 6. Chốt verify còn lại

Audit đã xác nhận và sửa nguyên nhân trực tiếp của lỗi chữ trong cấu hình CMYK ở
ảnh #3. Unit/backend/Rust/frontend verify đã đạt; còn cần người dùng chạy lại
đúng PDF thật trong `run_dev.bat` hoặc bản đóng gói để nâng bằng chứng lên runtime.
