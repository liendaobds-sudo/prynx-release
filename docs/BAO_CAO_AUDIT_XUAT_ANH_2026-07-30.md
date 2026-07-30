# BÁO CÁO SỬA TÍNH NĂNG XUẤT ẢNH — 2026-07-30

> Trạng thái: **ĐÃ SỬA (lô 3 + lô 4), CHƯA COMMIT.** Báo cáo này ghi lại một đợt
> audit tính năng Xuất ảnh và toàn bộ bản vá đã áp trong working tree, theo mẫu
> `docs/PERF_FIXES_*.md`. Mọi thay đổi mã còn ở dạng uncommitted (`git status` = M
> cho `export.py`, `test_export_images.py`, `AcrobatViewer.tsx`, `ExportImageModal.tsx`,
> `api.ts`; `??` cho `schemas/export.py`).

## 1. Kết luận điều hành

Đợt audit ban đầu (mục 4) tìm ra 8 finding: 4 P1 + 4 P2, 0 P0. Tất cả đã được sửa
theo hai lô:

- **Lô 3 — ổn định + color-managed RGB/Gray:** offload event loop, stream TIFF nén,
  ghi file atomic + chống thoát thư mục, progress/cancel, ICC profile đúng cho
  RGB/Gray, schema `Literal` + `Field(ge/le)`.
- **Lô 4 — CMYK production:** đường render CMYK riêng qua PPE ink-space (không đi
  PDFium→RGB→CMYK), nhúng FOGRA39, khóa CMYK khỏi PNG.

Tính năng Xuất ảnh giờ: RGB/Gray color-managed cho màn hình/văn phòng **đạt**;
CMYK chế bản qua PPE **đạt ở mức composite 4 kênh có ICC**, với các ràng buộc còn
mở ghi ở mục 6.

Chốt số liệu:

- 0 finding P0.
- 4 P1 + 4 P2: **đã áp bản vá cho cả 8**.
- Test: `pytest backend/tests/test_export_images.py -q` → **25 passed** trong ~1,7 giây
  (đợt audit gốc chỉ có 7 test happy-path; đã bổ sung ICC, schema-reject, atomic/
  collision/rollback, cancel, offload event loop, CMYK — kể cả **3 test CMYK
  end-to-end thật** chạy qua native `ppe_export_cmyk`).

## 2. Phạm vi và luồng đã trace

Luồng sản phẩm:

`AcrobatViewer.tsx` → `ExportImageModal.tsx` → `lib/api.ts::exportImages()` →
`POST /api/export/images` → `render_pdf_to_images()` → (RGB/Gray) PDFium → Pillow
**hoặc** (CMYK) `print_engine.facade.export_cmyk()` PPE ink-space → ghi atomic ra
thư mục người dùng.

Các file trọng tâm:

- `desktop/src/components/AcrobatViewer.tsx`
- `desktop/src/components/workspace/ExportImageModal.tsx`
- `desktop/src/lib/api.ts`
- `backend/app/schemas/export.py`
- `backend/app/api/routes/export.py`
- `backend/app/core/print_engine/facade.py` (`export_cmyk`)
- `backend/tests/test_export_images.py`

Đã đối chiếu thêm `backend/app/core/pdf_processor.py`, `softproof.py`,
`app/core/icc_profiles.py`, `heavy_job_scheduler.py`, audit hiệu năng cũ và cấu
hình ICC của dự án.

## 3. Những phần vốn đã làm đúng (giữ nguyên)

- UI PNG/JPEG/TIFF, DPI 36–1200, tất cả/trang hiện tại/dải trang, JPEG quality,
  TIFF nhiều trang.
- Route gate license ở cấp router (`export.py:30`).
- File nguồn chỉ đọc; renderer không sửa PDF gốc.
- PDFium bọc `pdfium_guard()` cho open/render/close.
- Tên file nhiều trang có padding; danh sách trang khử trùng + giữ thứ tự.

## 4. Findings và bản vá đã áp

### IMG-01 — P1 — Không có CMYK/ICC thật; trang bị RGB hóa trước khi lưu → ĐÃ SỬA (lô 3 + lô 4)

**Vấn đề gốc.** UI, TS contract, schema, renderer chỉ nhận `rgb | gray`; PDFium
raster hóa về RGB rồi Pillow đổi mode. Output không gắn ICC. Thêm `.convert("CMYK")`
đơn thuần sẽ tạo CMYK giả (không ICC, sai black-gen/TAC, mất spot/overprint).

**Bản vá.**

- RGB/Gray nay nhúng ICC đúng: `_get_srgb_icc_bytes()` (sRGB IEC61966-2.1 qua
  LittleCMS) và `_get_gray_icc_bytes()` (Gray Gamma 2.2, ICC v2 dựng thủ công) —
  `export.py:55-126`. Chọn profile theo `color_mode` tại `export.py:375`, truyền
  `icc_profile=` vào mọi `img.save()`.
- CMYK đi đường riêng `_render_cmyk_pages()` (`export.py:207-313`) gọi
  `print_engine.facade.export_cmyk()` — render trong không gian mực của PPE, gộp
  spot, trả CMYK 4 kênh, **không** đi PDFium→RGB→CMYK. Nhúng FOGRA39 qua
  `_get_cmyk_icc_bytes()` (`export.py:193-204`).
- PNG bị chặn CMYK: `render_pdf_to_images` raise `ValueError` khi
  `color_mode=="cmyk" and fmt=="png"` (`export.py:354`); UI disable radio PNG khi
  chọn CMYK (`ExportImageModal.tsx:234-237,280`).

**Verify.** `test_png/jpeg/tiff_has_srgb_icc_profile`, `test_grayscale_has_gray_icc_profile`,
`test_multipage_tiff_has_icc_profile`, `test_schema_accepts_cmyk_color_mode`,
`test_cmyk_png_raises`. **CMYK e2e thật:** `test_cmyk_tiff_is_four_channel_with_icc`,
`test_cmyk_jpeg_is_four_channel`, `test_cmyk_multipage_tiff_four_channel` — chạy qua
native `ppe_export_cmyk`, khẳng định output `im.mode == "CMYK"` (4 kênh) + nhúng ICC.

**Còn mở (xem mục 6):** spot/DeviceN, overprint, transparency và cờ
`ink_unsound`/`degraded` từ PPE chưa được surface lên UI thành fail-loud.

### IMG-02 — P1 — Endpoint async chạy render đồng bộ trên event loop → ĐÃ SỬA (lô 3)

**Vấn đề gốc.** `export_images()` gọi trực tiếp `render_pdf_to_images()`, chặn
event loop; các request khác (preview, upscale…) treo theo.

**Bản vá.** Route offload qua heavy-job scheduler dùng chung:
`await run_scheduled_in_threadpool("export-images", render_pdf_to_images, ...)`
(`export.py:526-539`). Vẫn gate RAM theo scheduler; không render PDFium song song
trong nhiều thread.

**Verify.** `test_async_route_offloads_render_from_event_loop` khẳng định render
chạy trên thread khác event loop.

### IMG-03 — P1 — Multipage TIFF giữ mọi trang trong RAM + TIFF không nén → ĐÃ SỬA (lô 3)

**Vấn đề gốc.** Ảnh append vào `frames[]`, chỉ `save_all` sau khi render hết →
A4 300 DPI ~26 MB/trang, 100 trang ~2,6 GB; TIFF ghi raw (compression tag 1).

**Bản vá.** Dùng `AppendingTiffWriter` ghi từng trang theo stream, `img.close()`
ngay sau mỗi trang (giữ ~1 trang trong RAM); `compression="tiff_deflate"`
(`export.py:411-476`). Ghi qua file tạm rồi `os.replace()`.

**Verify.** `test_export_multipage_tiff` khẳng định `tag_v2[259] == 8` (Deflate)
và `n_frames == 3`.

### IMG-04 — P1 — Xuất file nguồn, không đúng trạng thái viewer → ĐÃ SỬA (lô 4)

**Vấn đề gốc.** Nút xuất lấy thẳng `(file).path`; modal chỉ nhận
`fileId/filePath/numPages/currentPage/baseName`, không có page-order/rotation/
delete/edit-session → sau khi đảo/nhân bản/xóa/xoay trang trong viewer có thể
xuất nhầm trang gốc.

**Bản vá.** `AcrobatViewer.tsx` dùng `useWorkingPdf()` để bake page-order/rotation/
delete thành PDF làm việc trước khi mở modal xuất (`AcrobatViewer.tsx`, import +
`getWorkingFile`). Vị trí trang trong viewer (`viewerPagePosition`) truyền xuống
frame để dải trang khớp thứ tự người dùng thấy.

**Còn mở (xem mục 6):** cần integration test FE→BE cho reorder/duplicate/delete/
rotate/edit-chưa-commit; hiện chỉ có bản vá đường bake, chưa có test tự động phủ.

### IMG-05 — P2 — Ghi đè không atomic, base_name có thể thoát thư mục → ĐÃ SỬA (lô 3)

**Vấn đề gốc.** `img.save(out_path)` thẳng, không kiểm tồn tại, không temp-then-
replace; `base_name` không sanitize.

**Bản vá.**

- `_sanitize_base_name()` lọc ký tự cấm + tên Windows reserved, `os.path.basename`
  chống `../` (`export.py:129-137`).
- `_reserve_output_path()` giữ tên chưa tồn tại (tự tăng hậu tố `_2`, `_3`…),
  kiểm `commonpath` để mọi output nằm trong thư mục đích (`export.py:140-155`).
- `_save_image_atomic()` ghi file tạm `.prynx-export-*.tmp` rồi `os.replace()`
  (`export.py:169-180`).
- Rollback cả lượt khi lỗi giữa chừng (`except BaseException` xóa file đã ghi,
  `export.py:305-311,484-492`).

**Verify.** `test_existing_file_is_not_overwritten`, `test_base_name_cannot_escape_output_dir`,
`test_failed_page_rolls_back_new_outputs`.

### IMG-06 — P2 — Không có tiến độ và hủy job → ĐÃ SỬA (lô 3)

**Vấn đề gốc.** UI chỉ có boolean `busy`; API không truyền `AbortSignal`; backend
không hủy được.

**Bản vá.** Backend nhận `cancel_event: threading.Event`, kiểm giữa các trang và
raise `ExportCancelled` (`export.py:184-185,420-421`), map ra HTTP 499. FE dùng
`AbortController` (`ExportImageModal.tsx:79,165-166`), hiện progress "trang X/N",
chặn đóng modal khi busy, abort khi modal đóng. `exportImages` truyền `signal`
(`api.ts:353,370`).

**Verify.** `test_cancel_event_stops_render_and_rolls_back` khẳng định dừng sớm +
rollback sạch.

### IMG-07 — P2 — Tùy chọn định dạng chưa đủ → ĐÃ SỬA MỘT PHẦN (lô 3)

**Đã có.** TIFF Deflate + ICC + CMYK; JPEG quality + ICC; PNG ICC. Ước lượng
dung lượng/kích thước pixel hiển thị trong modal (`ExportImageModal.tsx:112-125`).

**Còn mở (xem mục 6):** 8/16-bit, alpha/background flatten cho PNG, chọn page box
(Crop/Media/Bleed), JPEG subsampling/progressive.

### IMG-08 — P2 — Validation và test chỉ phủ happy path → ĐÃ SỬA (lô 3)

**Vấn đề gốc.** Schema `str/int/list` không ràng buộc; backend clamp âm thầm; chỉ
7 test.

**Bản vá.** Schema dùng `Literal["png","jpeg","tiff"]`, `Literal["rgb","gray","cmyk"]`,
`Field(ge=36, le=1200)`, `Field(ge=1, le=100)` — reject thay vì clamp
(`schemas/export.py:28-38`). Bổ sung test lên **25** (ICC, schema-reject,
atomic/collision/rollback, cancel, offload, CMYK e2e).

**Verify.** `test_schema_rejects_invalid_format`, `test_schema_rejects_dpi_out_of_range`,
`test_schema_rejects_quality_out_of_range`.

## 5. Vì sao không chỉ "thêm nút CMYK"

Giữ nguyên lập luận của đợt audit: ảnh 4 kênh ≠ CMYK đúng để in. Bản vá lô 4 đáp
ứng: (1) profile đích thật FOGRA39 nhúng vào output; (3) render trong ink-space
PPE không qua bitmap RGB; và chặn CMYK khỏi PNG ở cả UI lẫn backend. Các điểm
(2) intent/black-point/K-only, (4) contract spot/DeviceN/overprint/transparency,
(5) fail-loud, (6) golden test đối chiếu renderer tham chiếu — xem mục 6.

## 6. Việc còn mở (chờ quyết định/lô sau)

1. **[ĐÃ VÁ] `api.ts:348` type `colorMode` thiếu `'cmyk'`.** Đã sửa thành
   `'rgb' | 'gray' | 'cmyk'`, khớp `ExportImageModal.tsx:69` + call site. Đã verify:
   `npm run typecheck` sạch, `npm run build` (tsc + vite) `✓ built` trên Windows thật.
2. **CMYK fail-loud.** Surface `ink_unsound`/`degraded` từ `export_cmyk` lên UI;
   không gắn nhãn "CMYK chuẩn in" cho kết quả xấp xỉ. Quy định rõ policy spot
   (flatten process vs plate riêng), overprint, transparency.
3. **Integration test IMG-04.** Chưa có test tự động FE→BE cho reorder/duplicate/
   delete/rotate/edit-chưa-commit.
4. **Golden/reference test CMYK nâng cao** (K-only, spot, overprint, transparency,
   TAC) đối chiếu renderer tham chiếu — hiện đã có 3 test e2e xác nhận 4 kênh + ICC,
   nhưng chưa có fixture DeviceCMYK/spot/transparency để kiểm giá trị mực/TAC.
5. **IMG-07 phần còn lại:** 8/16-bit, PNG alpha/background, chọn page box, JPEG
   subsampling/progressive.
6. **[ĐÃ VERIFY] `ppe_export_cmyk` native.** Đã xác nhận `pdfcompare_native` có
   symbol `ppe_export_cmyk` trên máy dev (`scripts/check_cmyk_native.py` → `True`);
   3 test CMYK e2e chạy thật, không skip. Còn cần xác nhận lại trên **binary release
   đóng gói** (Nuitka + maturin) trước khi phát hành.

## 7. Verify đã thực hiện

| Phép kiểm | Kết quả |
|---|---|
| Trace UI → API → schema → route → PDFium/Pillow + PPE CMYK | Đạt |
| `pytest backend/tests/test_export_images.py -q` | **25 passed**, 2 warning (~1,7s) |
| Đọc code xác nhận ICC nhúng RGB/Gray/CMYK | Đạt (`export.py`, có test ICC) |
| CMYK end-to-end qua native `ppe_export_cmyk` | Đạt (native có symbol; 3 test 4-kênh+ICC xanh) |
| Đọc code xác nhận offload event loop | Đạt (`run_scheduled_in_threadpool`) |
| Đọc code xác nhận TIFF stream + Deflate | Đạt (test tag 259==8) |
| Đọc code xác nhận atomic + sanitize + rollback | Đạt (3 test) |
| `npm run typecheck` + `npm run build` (Windows thật) | **Đạt** (tsc sạch, vite `✓ built`) |

## 8. Chốt duyệt

Bản vá lô 3 + lô 4 đã ở trong working tree; **25 test backend xanh**, build-gate FE
(`npm run typecheck` + `npm run build`) đã chạy sạch trên Windows thật, CMYK e2e đã
verify qua native. Gap type `api.ts` đã vá. **Đủ điều kiện commit** phần RGB/Gray +
CMYK production cơ bản.

Các việc còn lại (fail-loud `ink_unsound`/`degraded` lên UI, integration test
viewer-state cho IMG-04, golden test CMYK spot/overprint/TAC, IMG-07 phần còn lại,
xác nhận native trên binary release) nên mở thành lô kế theo quy trình 2 chốt —
không chặn việc commit đợt này.
