# BÁO CÁO RE-AUDIT TÍNH NĂNG XUẤT ẢNH — 2026-07-31

## 1. Kết luận điều hành

Bản nâng cấp đã tiến bộ rõ rệt và giải quyết phần lớn audit ngày 30/7:

- RGB/Grayscale đã nhúng ICC hợp lệ.
- CMYK có đường render PPE ink-space thật, xuất TIFF CMYK 4 kênh, nhúng FOGRA39.
- WebP, multi-scale, prefix, thư mục con và ước lượng output đã được thêm.
- Route không chặn event loop; TIFF multipage streaming + Deflate; ghi atomic và chống ghi đè.
- Page reorder/duplicate/delete/rotation được bake qua `useWorkingPdf()`.
- TypeScript, backend và Rust đều đang xanh trên snapshot cuối của ngày 31/7.

Tuy nhiên tính năng **chưa hoàn thiện production**. Re-audit còn **4 P1** và **4 P2**. Ba điểm dễ gây hiểu nhầm nhất là:

1. Checkbox “Include Bleed” không thực sự chọn MediaBox ở cả đường RGB lẫn CMYK.
2. Nút Hủy chỉ abort HTTP phía frontend; `cancel_event` backend không bao giờ được set khi client disconnect.
3. PPE trả `ink_unsound/degraded`, nhưng export bỏ qua và vẫn giao file CMYK như kết quả tin cậy.

## 2. Verify đã chạy trên bản mới nhất

| Phép kiểm | Kết quả |
|---|---|
| `desktop/npm run typecheck` | Đạt |
| `pytest backend/tests/test_export_images.py -q` | **25 passed**, 2 warning |
| `cargo check` tại `native/` | Đạt |
| `cargo test --lib` tại `print_engine/` | **347 passed** |
| `vitest src/i18n/i18nCatalog.test.ts` | **3 passed** |
| Probe CMYK native thật | TIFF mode `CMYK`, 100×100, ICC 654.352 byte, Deflate tag 8 |
| Mở ICC bằng LittleCMS | sRGB, Gray Gamma 2.2 và Coated FOGRA39 đều hợp lệ |

Lưu ý: test backend CMYK hiện chỉ kiểm schema và ca CMYK+PNG bị từ chối; probe CMYK dương tính ở trên được chạy riêng bằng native extension thật.

## 3. Đối chiếu audit cũ

| Finding cũ | Trạng thái re-audit |
|---|---|
| IMG-01 CMYK/ICC | Đã có pipeline thật, nhưng còn proof gap và bỏ qua cờ độ tin cậy |
| IMG-02 chặn event loop | Đã sửa |
| IMG-03 TIFF giữ toàn bộ RAM | Đã sửa |
| IMG-04 sai trạng thái viewer | Đã sửa page-level; object edit chưa commit vẫn thiếu |
| IMG-05 ghi đè/không atomic | Đã sửa trong từng request |
| IMG-06 progress/cancel | Chưa sửa thật ở backend; progress trang là text tĩnh |
| IMG-07 tùy chọn output | Đã mở rộng đáng kể; Include Bleed và estimate còn sai |
| IMG-08 validation/test | Đã cải thiện; batch/frontend/golden CMYK còn thiếu |

## 4. Findings còn lại

### RA-01 — P1 — “Include Bleed” không chọn đúng page box

**Bằng chứng**

- Schema tuyên bố `include_bleed=True` là MediaBox, `False` là TrimBox (`backend/app/schemas/export.py:39`).
- RGB/Gray render ảnh trước bằng `page.render()` mặc định; chỉ khi `include_bleed=False` mới crop tiếp theo TrimBox (`backend/app/api/routes/export.py:425-444`). Không có nhánh nào ép renderer dùng MediaBox khi `True`.
- CMYK return sang `_render_cmyk_pages()` trước khi dùng `include_bleed` (`backend/app/api/routes/export.py:366-371`).
- PPE facade hardcode `page_box="crop"` (`backend/app/core/print_engine/facade.py:560`).

**Tác động**

PDF có CropBox nhỏ hơn MediaBox/BleedBox có thể mất vùng tràn lề dù người dùng đã bật “Include Bleed”. CMYK và RGB có thể cho kích thước trang khác với lời hứa UI.

**Yêu cầu sửa:** dùng enum page box rõ ràng (`media/bleed/trim/crop`) xuyên schema → API → PDFium/PPE; golden test với bốn box khác nhau.

**Effort:** M.

### RA-02 — P1 — CMYK bỏ qua `ink_unsound/degraded`, không fail-loud

**Bằng chứng**

- Native trả cả `degraded` và `ink_unsound` (`native/src/print_engine_py.rs:401-426`).
- Facade công khai hai cờ trong contract (`backend/app/core/print_engine/facade.py:519-569`).
- `_render_cmyk_pages()` chỉ đọc `width`, `height`, `cmyk`, rồi lưu file (`backend/app/api/routes/export.py:258-269,283-303`); không đọc hai cờ.

**Tác động**

Trang có object/transparency/colorspace PPE chưa dựng đủ vẫn được xuất như CMYK production. Đây là sai chiều an toàn đối với dữ liệu in.

**Yêu cầu sửa:** nếu `ink_unsound=True` phải dừng và rollback; `degraded=True` phải có policy được duyệt (dừng hoặc trả warning có trang cụ thể). Response/UI phải hiển thị warning, không chỉ toast “thành công”.

**Effort:** S–M.

### RA-03 — P1 — Nút Hủy không dừng worker backend

**Bằng chứng**

- UI abort `AbortController` (`ExportImageModal.tsx:155-164,244-250`).
- Route tạo `threading.Event()` và truyền xuống renderer (`backend/app/api/routes/export.py:519-538`).
- Toàn bộ luồng không có `request.is_disconnected()`, không có watcher và không có `cancel_event.set()`.
- Import `StarletteRequest` ở route không được dùng (`backend/app/api/routes/export.py:505`).
- Test cancel tự set event bằng monkeypatch (`backend/tests/test_export_images.py:167-190`), nên không chứng minh HTTP abort đã nối tới worker.

**Tác động**

UI báo đã hủy và cho chạy lượt mới, nhưng job cũ vẫn render/ghi đĩa đến hết. Với CMYK/multi-scale, hai job có thể cùng chiếm RAM/CPU và tạo output ngoài ý muốn.

**Yêu cầu sửa:** route nhận `Request`, chạy watcher disconnect song song với threadpool và set event; hoặc đổi sang job API có endpoint cancel. Thêm integration test ngắt HTTP thật và xác nhận rollback.

**Effort:** M.

### RA-04 — P1 — Object edit chưa commit không đi vào snapshot export

**Bằng chứng**

- `useWorkingPdf()` chỉ đọc `file`, `viewerPageOrder`, `viewerPageRotations` (`desktop/src/hooks/useWorkingPdf.ts:25-35`).
- Hook bake page order, duplicate, blank, delete và rotation (`useWorkingPdf.ts:50-109`), nhưng không đọc `editSession`/live bytes.
- `ExportImageModal` gọi trực tiếp `getWorkingFile()`; không commit dirty edit session trước (`ExportImageModal.tsx:197-208`).
- Nhật ký cũ cũng thừa nhận giới hạn này (`docs/XUAT_ANH_FIXES_2026-07-30.md:42`).

**Tác động**

Nếu người dùng đang sửa object rồi bấm Xuất ảnh trước khi session được commit, ảnh có thể thiếu thay đổi vừa nhìn thấy trên màn hình.

**Yêu cầu sửa:** trước snapshot phải serialize/commit edit session đúng vòng đời, hoặc cho `useWorkingPdf` nhận live session bytes; test ca edit chưa commit → export.

**Effort:** M.

### RA-05 — P2 — Progress “trang 1/N” là tĩnh, không phải tiến độ thật

**Bằng chứng**

- Single job luôn set `x: 1` (`ExportImageModal.tsx:238-242`).
- Backend không có progress callback, SSE/WS hoặc job status cho export.
- Multi-scale chỉ cập nhật theo job/format, không theo trang (`ExportImageModal.tsx:230-253`).

**Tác động:** PDF dài vẫn trông đứng ở trang 1/N; người dùng không biết job đang tiến triển hay treo.

**Yêu cầu sửa:** dùng job status/WS hoặc callback có `processed/total`; nếu chưa có thì đổi text thành “Đang xuất N trang…” để không trình bày số giả.

**Effort:** M cho progress thật; S cho sửa wording trung thực.

### RA-06 — P2 — Multi-scale cho phép tổ hợp chắc chắn bị backend từ chối

**Bằng chứng**

- Mỗi scale row cho chọn cả PNG/JPEG/WebP/TIFF không phụ thuộc `colorMode` (`ExportImageModal.tsx:397-402`). Với CMYK, PNG/WebP bị backend từ chối (`backend/app/api/routes/export.py:354-356`).
- `effectiveDpi = dpi * row.scale` không clamp/validate (`ExportImageModal.tsx:216-223`). DPI 600 × 4 = 2400, trong khi schema chỉ nhận tối đa 1200 (`backend/app/schemas/export.py:33`).
- Mỗi row là một HTTP request riêng (`ExportImageModal.tsx:230-253`); row sau lỗi không rollback output của row trước.

**Tác động:** batch có thể xuất một phần rồi báo lỗi, để lại bộ output không đầy đủ; tổ hợp UI cho chọn nhưng chắc chắn không chạy.

**Yêu cầu sửa:** validate toàn bộ export plan trước request đầu; disable PNG/WebP trong row CMYK; giới hạn `dpi*scale <= 1200` hoặc thay scale bằng kích thước pixel có contract riêng; trả manifest và policy rollback batch.

**Effort:** M.

### RA-07 — P2 — Ước lượng kích thước sai đơn vị và sai số kênh CMYK

**Bằng chứng**

- Modal coi `pageWidthPt/pageHeightPt` là point và nhân `dpi/72` (`ExportImageModal.tsx:135-153`).
- `AcrobatViewer` truyền `pageDim.w/h` (`AcrobatViewer.tsx:1818-1819`). Loader lưu `pageDim` ở CSS pixel bằng `pt * 96/72` (`desktop/src/hooks/viewer/usePdfLoader.ts:237-250,419-423`). Vì vậy kích thước pixel estimate lớn hơn thực tế 4/3.
- CMYK vẫn được tính 3 channel thay vì 4 (`ExportImageModal.tsx:140`).

**Tác động:** kích thước pixel và dung lượng dự kiến sai; người dùng có thể đánh giá sai RAM/dung lượng đĩa.

**Yêu cầu sửa:** truyền `activePagePhysical.widthPt/heightPt` hoặc đổi rõ prop sang CSS px; CMYK dùng 4 channel; estimate multi-scale phải cộng từng row thay vì chỉ format/DPI chính.

**Effort:** S.

### RA-08 — P2 — Coverage chưa chứng minh CMYK production và luồng frontend

**Bằng chứng**

- 25 backend tests xanh, nhưng CMYK test trong `test_export_images.py` chỉ kiểm schema và CMYK+PNG bị reject; không có positive test gọi native PPE và kiểm mode/ICC/channel.
- Không có test cho `ExportImageModal` hoặc `parsePageRange`; chỉ có i18n catalog test.
- Không có golden/reference test export cho spot folding, overprint, K-only, transparency, `ink_unsound`, page boxes hay viewer snapshot.
- Re-audit phải chạy probe native thủ công mới xác nhận TIFF CMYK thực sự mở được.

**Tác động:** build/test xanh vẫn không chặn được các finding RA-01, RA-02, RA-03, RA-04 và RA-06.

**Yêu cầu sửa:** thêm backend positive CMYK integration fixture; golden PPE/reference cho kênh/TAC; frontend test plan validation + cancel; integration snapshot viewer → export.

**Effort:** L.

## 5. Những phần được xác nhận tốt

- CMYK không đi qua PDFium RGB; native `ppe_export_cmyk` trả buffer 4 kênh thật.
- FOGRA39 nhúng vào TIFF mở được bằng LittleCMS.
- RGB/Gray ICC hợp lệ; TIFF Deflate và atomic write hoạt động.
- PDFium được khóa theo từng trang và handle trang/bitmap được đóng.
- Heavy scheduler giữ event loop phản hồi.
- Schema đã dùng `Literal` và range cho format/DPI/quality.
- WebP đã được nối đồng bộ UI → TypeScript API → schema → backend.
- Prefix được sanitize; file trùng tên tự tăng hậu tố.
- Page-order/duplicate/delete/rotation/blank page đã được bake ở page level.

## 6. Thứ tự sửa đề xuất

### Lô A — Correctness chặn phát hành (≤5 file)

1. RA-01 page-box/Include Bleed xuyên RGB + CMYK.

---

## 8. Kết quả xử lý sau khi được duyệt — 2026-07-31

Phần 1–7 ở trên là snapshot phát hiện **trước khi sửa**. Sau các lô vá và verify, trạng thái hiện tại:

| Finding | Trạng thái | Bằng chứng chính |
|---|---|---|
| RA-01 | Đã đóng | RGB/Gray ép CropBox RAM theo MediaBox/TrimBox; CMYK truyền `page_box=media/trim`; test kích thước box đạt. |
| RA-02 | Đã đóng | CMYK dừng và rollback khi PPE trả `ink_unsound` hoặc `degraded`; test fail-loud đạt. |
| RA-03 | Đã đóng | Watcher `request.is_disconnected()` bật `cancel_event`; renderer cooperative-cancel và rollback; test watcher/cancel đạt. |
| RA-04 | Đã đóng | Trước snapshot, object edit dirty được commit; snapshot nhận trực tiếp Working File vừa commit, không phụ thuộc closure React cũ; commit lỗi thì dừng xuất. |
| RA-05 | Đã đóng | Bỏ số trang giả `1/N`; UI chỉ hiển thị trạng thái “Đang xuất”. |
| RA-06 | Đã đóng | Plan được validate trước upload; CMYK khóa PNG/WebP; chặn `dpi × scale > 1200`; một endpoint batch rollback toàn bộ file khi một job lỗi. |
| RA-07 | Đã đóng | Dùng kích thước point thật, CMYK 4 kênh; estimate cộng từng job multi-scale và hiển thị từng kích thước pixel. |
| RA-08 | Đã đóng trong phạm vi finding | Có positive CMYK native TIFF/JPEG/multipage, ICC, page-box, fail-loud, disconnect/cancel, rollback batch và 5 test frontend parser/plan. |

### Tương thích ngược

- `POST /api/export/images` được giữ nguyên cho các bản desktop cũ.
- Batch mới dùng endpoint riêng `POST /api/export/images/batch`; không thay schema request cũ.
- Không thay license guard, không khóa bản khách cũ.

### Verify cuối

| Phép kiểm | Kết quả |
|---|---|
| `py_compile` schema/route/test | Đạt |
| `pytest backend/tests/test_export_images.py -q` | **33 passed**, 2 warning deprecation |
| `npm run typecheck --prefix desktop` | Đạt, 0 lỗi |
| `vitest ExportImageModal.test.ts` | **5 passed** |

Kiểm thử runtime thủ công trong bản đóng gói vẫn nên thực hiện với PDF xưởng thật (transparency, spot, overprint và nhiều page box); đây là kiểm tra nghiệm thu phát hành, không còn là finding code mở trong báo cáo này.
2. RA-02 fail-loud theo `ink_unsound/degraded`.
3. RA-07 sửa estimate point/channel.
4. Test backend cho page box + CMYK confidence.

### Lô B — Cancel/progress thật (≤5 file)

1. RA-03 nối disconnect/cancel tới worker.
2. RA-05 progress thật hoặc wording trung thực.
3. Integration test abort HTTP.

### Lô C — Snapshot và batch (≤5 file)

1. RA-04 commit/live edit session trước export.
2. RA-06 validate export plan trước khi chạy.
3. Frontend/integration tests tương ứng.

### Lô D — Color proof và tùy chọn xưởng

Golden/reference tests CMYK; sau đó mới cân nhắc UI chọn profile, rendering intent, page box, spot policy và 8/16-bit.

## 7. Chốt duyệt

Re-audit này chỉ đọc/verify và thêm báo cáo; chưa sửa mã sản phẩm. Đề nghị duyệt **Lô A** trước vì RA-01 và RA-02 có thể tạo output in sai dù UI báo thành công.
