# Nhật ký sửa Xuất ảnh — 2026-07-30

## Lô 1 — Độ ổn định và ghi file

| Mã | File | Thay đổi | Verify |
|---|---|---|---|
| §IMG-02 | `backend/app/api/routes/export.py` | Đưa render ảnh ra `run_scheduled_in_threadpool("export-images", ...)`; route không còn chạy job nặng trên event loop. | `test_async_route_offloads_render_from_event_loop` đạt |
| §IMG-03 | `backend/app/api/routes/export.py` | Thay `frames[]` bằng `Pillow.TiffImagePlugin.AppendingTiffWriter`; ghi từng frame TIFF với Deflate và đóng bitmap/page ngay sau render. | `test_export_multipage_tiff` đạt, compression tag = 8 |
| §IMG-05 | `backend/app/api/routes/export.py` | Sanitize basename, đặt output tuyệt đối trong thư mục đích, tự thêm hậu tố khi trùng, ghi file tạm rồi `os.replace()`, rollback file mới của lượt khi lỗi. | 3 regression tests chống ghi đè/thoát thư mục/rollback đạt |
| §IMG-02/03/05 | `backend/tests/test_export_images.py` | Bổ sung 4 regression tests và mở rộng test multipage TIFF. | 11 passed |

## Giới hạn của lô này

- Chưa thêm CMYK/ICC; đây là lô màu riêng vì cần PPE/RIP và fixture tham chiếu.
- ~~Chưa xử lý snapshot page-order/rotation/edit-session, progress/cancel hoặc UI ước lượng dung lượng.~~ → Lô 2 đã sửa.
- Chưa chạy `run_dev.bat` và thao tác runtime trên ứng dụng đóng gói; cần kiểm tra thủ công sau khi sidecar được build.

## Verify

- `backend\\venv\\Scripts\\python.exe -m py_compile backend/app/api/routes/export.py backend/tests/test_export_images.py` — đạt.
- `backend\\venv\\Scripts\\python.exe -m pytest backend/tests/test_export_images.py -q` — **11 passed**, 2 warning deprecation.

---

## Lô 2 — Đúng trạng thái viewer + Progress/Cancel

| Mã | File | Thay đổi | Verify |
|---|---|---|---|
| §IMG-04 | `desktop/src/components/AcrobatViewer.tsx` | Import `useWorkingPdf`, gọi hook, truyền `getWorkingFile` xuống ExportImageModal. Truyền `pageOrder.length \|\| numPages` thay vì `numPages` gốc để dải trang phản ánh đúng số trang viewer. | tsc --noEmit đạt |
| §IMG-04 | `desktop/src/components/workspace/ExportImageModal.tsx` | Nhận prop `getWorkingFile`. `doExport()` gọi `getWorkingFile()` → bake page-order/rotation/delete → upload bản bake lên backend → render đúng trạng thái viewer. | tsc --noEmit đạt |
| §IMG-06 | `desktop/src/components/workspace/ExportImageModal.tsx` | Thêm `AbortController` ref. Khi busy: Escape/click nền bị chặn, hiện progress text, nút Hủy abort signal. Cleanup controller khi modal đóng. Disable mọi input khi busy. | tsc --noEmit đạt |
| §IMG-06 | `desktop/src/lib/api.ts` | `exportImages()` nhận optional `signal?: AbortSignal`, truyền vào `authenticatedFetch`. | tsc --noEmit đạt |
| §IMG-06 | `backend/app/api/routes/export.py` | Thêm `cancel_event: Optional[threading.Event]` vào `render_pdf_to_images()`. Mỗi vòng lặp trang kiểm tra `cancel_event.is_set()` → raise `ExportCancelled` → rollback. Route tạo cancel_event, bắt `ExportCancelled` trả 499. | py_compile + pytest đạt |
| §IMG-06 | `backend/tests/test_export_images.py` | Test `cancel_event` dừng render sau 2 trang → rollback toàn bộ output. | 12 passed |
| §IMG-08 | `desktop/src/components/workspace/ExportImageModal.tsx` | `parsePageRange`: clamp endpoint trước vòng lặp (`a = max(1, a); b = min(max, b)`) — tránh `1-999999999` khóa WebView. | tsc --noEmit đạt |
| i18n | `desktop/src/i18n/locales/{vi,en}.json` | Thêm 6 key: `dang_chuan_bi`, `dang_chuan_bi_trang`, `dang_tai_len_ban_da_chinh`, `dang_xuat_trang_x_y`, `da_huy_xuat_anh`, `huy_xuat`. | — |

## Giới hạn của Lô 2

- Chưa thêm CMYK/ICC — Lô 3 (Color-managed RGB/Gray) và Lô 4 (CMYK production).
- Progress chỉ ở mức ước lượng "trang X/N" phía client (biết tổng trang). SSE/WebSocket cho progress thật là overkill cho MVP.
- Edit-session (object editing chưa commit) chưa phản ánh vào export; chỉ page-order/rotation/delete được bake. Cần quy trình commit session trước khi xuất — để Lô 3+ nếu cần.
- Chưa chạy `run_dev.bat` runtime thật; cần user kiểm tra thủ công: đảo/xóa/xoay trang → Xuất ảnh → xem ảnh ra đúng; nhấn Hủy khi đang xuất → xem job dừng.

## Verify Lô 2

- `py_compile export.py test_export_images.py` — đạt.
- `pytest backend/tests/test_export_images.py -q` — **12 passed**, 2 warning deprecation.
- `cd desktop && npx tsc --noEmit` — **đạt**, 0 lỗi.

---

## Lô 3 — Color-managed RGB/Gray + Schema validation + Output estimate

| Mã | File | Thay đổi | Verify |
|---|---|---|---|
| §IMG-01 | `backend/app/api/routes/export.py` | Thêm `_get_srgb_icc_bytes()` (LittleCMS `tobytes()`, pattern sticker_engine) và `_get_gray_icc_bytes()` (ICC v2 thủ công: desc+wtpt+kTRC gamma 2.2). Gắn `icc_profile=` vào mọi `img.save()` cho PNG, JPEG, TIFF single + multipage. | 5 ICC tests đạt |
| §IMG-08 | `backend/app/schemas/export.py` | `format: Literal["png","jpeg","tiff"]`, `color_mode: Literal["rgb","gray"]`, `dpi: Field(ge=36, le=1200)`, `jpeg_quality: Field(ge=1, le=100)` — Pydantic reject tham số ngoài range. | 3 schema rejection tests đạt |
| §IMG-08 | `backend/app/api/routes/export.py` | Bỏ clamp âm thầm `dpi=max(MIN,min(MAX,dpi))` — Pydantic xử lý. Giữ cast int cho an toàn khi gọi trực tiếp. | py_compile đạt |
| §IMG-07 | `desktop/src/components/workspace/ExportImageModal.tsx` | Thêm props `pageWidthPt`/`pageHeightPt`, tính `outputEstimate` (pixel W×H + dung lượng ước lượng), hiển thị footer "2480×3508 px · ~12.3 MB". | tsc --noEmit đạt |
| §IMG-07 | `desktop/src/components/AcrobatViewer.tsx` | Truyền `pageDim?.w`/`pageDim?.h` (pt) xuống ExportImageModal. | tsc --noEmit đạt |
| test | `backend/tests/test_export_images.py` | +5 ICC tests (PNG/JPEG/TIFF sRGB + Grayscale Gray + multipage TIFF), +3 schema rejection tests (format/dpi/quality), sửa test_dpi_clamped → test_dpi_boundary_max_accepted. | 20 passed |

## Giới hạn của Lô 3

- Chưa hỗ trợ CMYK output — cần profile CMYK đích (FOGRA39/SWOP) và conversion engine.
- Gray ICC profile dựng thủ công (ICC v2 minimal) — đủ cho Photoshop/GIMP nhận diện, nhưng không phải profile chính quy ICC.org.
- Output estimate là ước lượng dựa trên compression ratio trung bình — dung lượng thật có thể khác ±30%.
- Chưa có chọn page box (CropBox/BleedBox/MediaBox), background/alpha cho PNG.

## Verify Lô 3

- `py_compile export.py schemas/export.py test_export_images.py` — đạt.
- `pytest backend/tests/test_export_images.py -q` — **20 passed**, 2 warning deprecation.
- `cd desktop && npx tsc --noEmit` — **đạt**, 0 lỗi.

---

## Lô 4 — CMYK production qua PPE ink-space

| Mã | File | Thay đổi | Verify |
|---|---|---|---|
| §IMG-04 | `print_engine/src/ink.rs` | Thêm `to_process_cmyk()`: gộp spot vào 4 kênh process CMYK, trả interleaved u8 (4 byte/pixel). Cùng logic spot-folding với `to_srgb` nhưng KHÔNG quy sang RGB. | cargo check đạt |
| §IMG-04 | `native/src/print_engine_py.rs` | Thêm `ppe_export_cmyk` PyO3: render trang qua PPE ink-space + `to_process_cmyk()`, trả `{width, height, cmyk, degraded, ink_unsound}`. | cargo check đạt |
| §IMG-04 | `native/src/lib.rs` | Đăng ký `ppe_export_cmyk` trong module. | cargo check đạt |
| §IMG-04 | `backend/app/core/print_engine/facade.py` | Thêm `export_cmyk()` wrapper: gọi `ppe_export_cmyk`, tự phân giải FOGRA39 profile, hỗ trợ qpdf recovery. | py_compile đạt |
| §IMG-04 | `backend/app/schemas/export.py` | `color_mode: Literal["rgb","gray","cmyk"]` | py_compile đạt |
| §IMG-04 | `backend/app/api/routes/export.py` | Thêm `_get_cmyk_icc_bytes()` (đọc FOGRA39 bundle), `_render_cmyk_pages()` (PPE ink-space → CMYK TIFF/JPEG + nhúng ICC). Guard PNG+CMYK → ValueError. | 22 tests đạt |
| §IMG-04 | `desktop/src/components/workspace/ExportImageModal.tsx` | Thêm radio CMYK + auto-switch format (PNG→TIFF khi CMYK), disable PNG khi CMYK, note PPE ink-space. | tsc --noEmit đạt |
| test | `backend/tests/test_export_images.py` | +2 tests: `test_schema_accepts_cmyk_color_mode`, `test_cmyk_png_raises`. | 22 passed |

## Giới hạn của Lô 4

- CMYK production phụ thuộc PPE native có sẵn — nếu native chưa rebuild (thiếu `ppe_export_cmyk`), sẽ raise `PpeUnavailable` thay vì fallback.
- Profile mặc định FOGRA39 — chưa cho user chọn profile đích khác trong UI.
- Rendering intent mặc định Relative Colorimetric — chưa có UI chọn intent.
- Chưa xử lý riêng spot color → giữ nguyên gộp vào process CMYK (cùng behavior softproof).
- JPEG CMYK hỗ trợ nhưng downstream compatibility chưa test rộng (một số viewer không đọc JPEG CMYK).

## Verify Lô 4

- `cargo check` (native crate) — **đạt**, 0 error.
- `maturin develop --release` — **đạt**, `pdfcompare_native-0.1.0` installed.
- `py_compile export.py schemas/export.py facade.py` — đạt.
- `pytest backend/tests/test_export_images.py -q` — **22 passed**, 2 warning deprecation.
- `cd desktop && npx tsc --noEmit` — **đạt**, 0 lỗi.
- `python -c "import pdfcompare_native; print(hasattr(pdfcompare_native, 'ppe_export_cmyk'))"` → **True**.
