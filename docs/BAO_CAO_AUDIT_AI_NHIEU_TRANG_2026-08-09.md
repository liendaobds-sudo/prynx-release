# Báo cáo audit xử lý ảnh AI nhiều trang — 2026-08-09

**Trạng thái:** Đã duyệt và đã triển khai Lô 1–8; còn nghiệm thu runtime Tauri đã đăng nhập
**Phạm vi:** Chọn nhiều ảnh → một tài liệu nhiều trang → nhận diện theo thumbnail → review mask theo trang → xuất gộp đúng thứ tự

## Kết luận điều hành

Có thể và nên xử lý giống tài liệu PDF/ảnh đã có biên: **danh sách thumbnail hiện tại phải là danh sách ảnh/trang duy nhất**, không tạo thêm một danh sách batch riêng và không thay Viewer khi chuyển sang `Ảnh AI nhiều tem`.

Vấn đề hiện tại không nằm ở khả năng đọc nhiều trang. Inspector đã trả đủ `page_count`, metadata từng trang và pipeline đã nhận `page_number`. Điểm nghẽn là toàn bộ session, store, mask artifact và export vẫn chỉ giữ **một trang đang được nhận diện**. Nhận diện trang đầu chuyển cả session sang `mask-review`, nên trang thứ hai bị từ chối; overlay và export cũng chỉ đọc manifest/artifact của trang đó.

Hướng sửa được chốt:

1. Nhiều ảnh được ghép thành **một PDF nhiều trang** theo đúng thứ tự người dùng chọn.
2. Acrobat Viewer và dải thumbnail hiện tại tiếp tục là vùng xem duy nhất.
3. Session AI là một tài liệu, bên trong có trạng thái/artifact riêng cho từng `source_page`.
4. Người dùng có hai thao tác: `Nhận diện trang hiện tại` và `Nhận diện tất cả trang`.
5. Offset, tràn lề và thiết lập xuất dùng chung; mask, tinh chỉnh, edit, revision, lỗi và xác nhận lưu riêng từng trang.
6. Export chỉ chạy khi mọi trang có trong thứ tự xuất đã sẵn sàng; không âm thầm bỏ trang lỗi/chưa nhận diện.
7. Kết quả được ghép theo đúng thứ tự thumbnail hiện tại; trong mỗi trang nguồn, tem giữ thứ tự ID ổn định.

## Hợp đồng UX đã chốt

### Chọn nguồn

- Picker `Ảnh AI nhiều tem` cho phép chọn nhiều JPG/PNG/WebP/BMP/TIFF.
- Một ảnh vẫn hoạt động như hiện tại.
- Từ hai ảnh trở lên, frontend dựng một PDF nhiều trang bằng đường chuẩn hóa ảnh đang có; mỗi ảnh là một trang và giữ thứ tự chọn.
- Chọn ảnh chỉ nạp tài liệu vào Viewer và sinh thumbnail. **Không inspect/detect/AI tự động.**
- Tên hiển thị dùng dạng `5 ảnh · tài liệu 5 trang`, không dựng danh sách file thứ hai trong panel.

### Nhận diện và review

- `Nhận diện trang hiện tại`: chỉ xử lý trang nguồn đang được thumbnail/Viewer chọn.
- `Nhận diện tất cả trang`: gửi từng trang còn ở trạng thái chờ vào cùng bộ điều phối việc nặng; trang đã sẵn sàng không chạy lại.
- Thumbnail có dấu trạng thái nhỏ, không che nội dung:
  - xám: `Chưa nhận diện`;
  - tím quay: `Đang nhận diện`;
  - vàng: `Cần xác nhận`;
  - xanh: `Sẵn sàng`;
  - đỏ: `Lỗi`.
- Chuyển thumbnail đổi ngay overlay, tinh chỉnh khử bóng, Bám biên AI, edit/undo/redo và lỗi của đúng trang đó.
- `Xác nhận vùng tem` trong lô đầu chỉ xác nhận trang đang xem; không tự xác nhận hàng loạt và không chạy lại AI.
- Một trang lỗi không xóa session hoặc kết quả của các trang khác. Người dùng có thể chọn thumbnail đỏ và thử lại riêng trang đó.

### Viewer

- Không mount Viewer AI riêng.
- Hand, Space, chuột giữa, zoom, cuộn và thumbnail tiếp tục do Acrobat Viewer sở hữu.
- Pointer chỉ tương tác với mask của trang hiện tại.
- Trạng thái được khóa theo **số trang nguồn**, không theo vị trí thumbnail. Khi người dùng đổi thứ tự trang, overlay vẫn bám đúng nội dung; export nhận thứ tự thumbnail mới.

### Xuất kết quả

- Panel luôn hiển thị tiến độ `x/y trang sẵn sàng`.
- Nút PDF/PNG ZIP bị khóa nếu trong danh sách xuất còn trang chờ, đang chạy, cần xác nhận hoặc lỗi; UI nêu rõ số trang cần xử lý.
- Payload export mang `source_page`, `mask_revision` và edits của từng trang, cộng với thứ tự trang hiện tại.
- Backend xác minh lại toàn bộ revision/stage trước khi ghi; có một trang stale thì từ chối cả lần xuất, không tạo file nửa chừng.
- PDF: các trang tem của trang nguồn 1 đứng trước trang nguồn 2… theo thứ tự thumbnail.
- ZIP: tên file có cả trang nguồn và thứ tự tem, ví dụ `trang_002_tem_003.png`, tránh trùng tên.
- Với CutContour thật được giữ nguyên, trang PDF nguồn vẫn được sao chép theo hợp đồng hiện có. Trường hợp trộn trang giữ nguyên và trang dựng lại phải ghép atomically, không raster hóa trang vector.

## Bằng chứng hiện trạng

| Mã | Mức / effort | Bằng chứng | Hệ quả |
|---|---|---|---|
| §MP.1 | P1 / M | `StickerSheetPanel.tsx:77-85` chỉ đọc `files[0]`, không có `multiple`; `stickerSheetStore.ts:68-88` chỉ có một `sourceFile`, `manifest` và bộ edit | Không có hợp đồng nhiều ảnh/nhiều trang ở frontend AI |
| §MP.2 | P0 / L | `sticker_sheet_session.py:328-340` chuyển **cả session** `inspected → detecting`; route từ chối request tiếp theo tại `sticker_sheet.py:212-217` | Nhận diện trang đầu xong thì không thể nhận diện trang thứ hai trong cùng session |
| §MP.3 | P0 / L | `sticker_sheet_session.py:384-405` và `465-524` ghi artifact/manifest vào một thư mục gốc; không có thư mục/trạng thái theo trang | Detect/refine trang mới sẽ ghi đè mask, Alpha, labels và revision trang cũ |
| §MP.4 | P1 / M | `stickerSheetApi.ts:198-230` đã gửi được `page_number`, nhưng `stickerSheetStore.ts:460-465` không truyền số trang và request lifecycle chỉ khóa theo `tabId` tại `217-235` | Hai trang chạy đồng thời sẽ hủy/ghi đè nhau dù backend được mở khóa |
| §MP.5 | P0 / L | `sticker_sheet_export.py:363-369` chỉ đọc một `labels.npy` và một manifest; route chỉ kiểm một `session.stage` tại `sticker_sheet.py:508-535` | Export chỉ có kết quả của trang cuối được promote |
| §MP.6 | P1 / M | `ImpositionTab.tsx:227-240` lấy một `manifest.source_page`; `2710-2718` chỉ truyền một overlay; `AcrobatViewer.tsx:1647` gắn overlay vào một trang nguồn | Chuyển thumbnail không thể hiện mask tương ứng |
| §MP.7 | P1 / M | `ThumbSidebar.tsx:9-49` không có hợp đồng trạng thái nghiệp vụ; vòng render tại `551-594` chỉ có trạng thái chọn/kéo/active | Người dùng không biết trang nào đang chờ, đã xong hay lỗi |
| §MP.8 | P1 / M | `ImpositionTab.tsx:1374-1377` mở các file sau thành tab riêng; trong khi `imageNormalizer.ts:134-144` đã có helper thêm ảnh thành trang PDF | Luồng mở file hiện tại chưa tạo một tài liệu nhiều thumbnail như yêu cầu |
| §MP.9 | P1 / M | Asset/refine/confirm hiện chỉ định danh bằng `session_id` và revision tại `sticker_sheet.py:284-352`, `454-488`; `confirm` không nhận trang | Revision bằng nhau giữa hai trang có thể trỏ nhầm artifact nếu chỉ mở store mà không đổi URL/API |
| §MP.10 | P1 / S | `stickerSheetApi.ts:231-233` và `stickerSheetStore.ts:510-525` đóng/reset toàn session khi một detect tải asset lỗi | Một trang lỗi làm mất mọi trang đã xử lý |
| §MP.11 | P1 / M | Viewer tách `viewerPagePosition` và `originalPageNum` tại `AcrobatViewer.tsx:1592-1594`; export request hiện không mang `page_order` | Sau đổi thứ tự thumbnail, file xuất không thể đảm bảo cùng thứ tự đang thấy |

## Hợp đồng state và artifact đề xuất

### Backend

`StickerSheetSession` tiếp tục sở hữu file nguồn, TTL và metadata tài liệu. Bổ sung map trang:

- khóa: `source_page` một-based;
- stage riêng: `inspected | detecting | mask-review | refining | mask-ready | error`;
- manifest/revision/DPI/nguồn biên riêng;
- `operation_lock` riêng để hai request cùng trang loại trừ nhau nhưng hai trang khác nhau không khóa oan;
- artifact nằm dưới `pages/0001/`, `pages/0002/`…;
- đóng session/TTL vẫn dọn nguyên thư mục tài liệu.

API cũ giữ mặc định trang 1 để không phá tương thích, nhưng mọi thao tác mới phải page-qualified:

- detect: `page_number` trong body (đã có);
- refine: thêm `page_number`;
- confirm: thêm `page_number`;
- asset: thêm `page_number` vào URL cùng `v=mask_revision`;
- export: nhận mảng trang có `source_page`, `expected_revision`, edits và `page_order`.

`detect_sticker_source()` chỉ làm engine thuần cho một trang. Quyền chuyển stage thuộc session page state; không còn kiểm `session.stage` toàn tài liệu.

### Frontend

Tab AI giữ hai tầng state:

- tài liệu: mode, file PDF tổng hợp, inspection, model, thiết lập đường cắt/bù xén dùng chung, lifecycle generation;
- `pages[sourcePage]`: status, manifest, blob URL, tuning, edit/redo, instance đang chọn, DPI và lỗi.

Request/refine queue dùng khóa `${tabId}:${sourcePage}`. Đổi nguồn hoặc đóng tab tăng document generation và thu hồi mọi blob/session; retry một trang chỉ thay generation của trang đó.

Trang đang thao tác được tính bằng:

`activeSourcePage = viewerPageOrder[viewerActivePage - 1] ?? viewerActivePage`

Nhờ vậy thumbnail có thể đổi thứ tự mà mask vẫn bám trang nguồn đúng.

## Điều phối hiệu năng

- Không thêm hard-cap số trang hoặc worker ở frontend.
- `Nhận diện tất cả trang` tạo tác vụ theo trang; admission đi qua `heavy_job_scheduler`, vốn đang gate theo RAM: máy yếu giảm slot, máy từ 16 GB được mở rộng và máy 64 GB có thêm slot.
- PDFium vẫn nằm trong `pdfium_guard()` ở đoạn render trang; không giữ khóa trong inference/hậu xử lý/ghi artifact.
- BiRefNet/ISNet đã tự khóa cùng DirectML session nhưng cho CPU/CUDA hoặc biến thể khác chạy song song; không thêm mutex toàn bộ batch.
- Export gộp ưu tiên một lần dựng CutContour cho toàn bộ trang raster đã duyệt để tái dùng ProcessPool/hồ sơ phần cứng của `StickerEngine`, thay vì gọi engine lặp cho từng ảnh.

## Rủi ro cần khóa bằng test

1. Detect hai trang đồng thời nhưng cùng revision `1` không được trộn asset.
2. Hủy/timeout một trang không đổi stage trang khác.
3. Refine trang A không xóa edit hoặc blob URL trang B.
4. Đổi thứ tự/nhân bản/xóa thumbnail phải có hợp đồng rõ: export dùng thứ tự hiện tại, mask vẫn keyed theo trang nguồn; không âm thầm áp mask lên trang khác.
5. Nhiều ảnh có DPI khác nhau phải giữ quy ước kích thước của luồng mở ảnh hiện tại; ảnh không có metadata tiếp tục fallback 72 DPI, không tự bịa khổ.
6. Một batch có CutContour thật, Alpha và AI không được raster hóa trang vector khi chọn giữ nguyên.
7. File xuất phải atomic; lỗi trang giữa không để lại PDF/ZIP một phần.
8. Worktree hiện có nhiều thay đổi từ các phiên khác; mỗi lô chỉ sửa/stage đúng file đã liệt kê, không checkout/reset hoặc gom commit ngoài phạm vi.

## Ma trận kiểm thử bắt buộc

### Backend tự động

- Session 3 trang khởi tạo đủ ba page state.
- Hai detect cùng trang: một request được nhận, request còn lại 409; detect hai trang khác nhau đều hoàn tất.
- Cancel/fail/promote rollback/refine stale/asset stale được cô lập theo trang.
- Confirm idempotent theo trang; export báo chính xác danh sách trang chưa sẵn sàng.
- Export 3 trang có số tem khác nhau giữ thứ tự trang và tổng sticker count.
- Edit trang 2 không làm thay labels trang 1/3.
- ZIP không trùng tên; PDF không có trang thiếu hoặc đảo thứ tự.
- CutContour nhiều trang được giữ page box, `/Rotate`, `/UserUnit`, content stream và spot color theo hợp đồng cũ.
- TTL/close dọn đủ artifact mọi trang.

### Frontend tự động

- Chọn 3 ảnh tạo một PDF 3 trang theo thứ tự chọn nhưng không gọi inspect/detect.
- `Nhận diện trang hiện tại` gửi đúng `activeSourcePage`; `Nhận diện tất cả trang` bỏ qua trang đã sẵn sàng.
- Hai page request cùng tab không abort nhau; đổi nguồn/đóng tab vẫn hủy toàn bộ kết quả stale.
- Thumbnail badge phản ánh đủ 5 trạng thái và chuyển trang không làm mất zoom/Hand.
- Overlay/tuning/edit/undo/redo đổi đúng theo thumbnail.
- Reorder thumbnail tạo đúng `page_order` khi export.
- Export bị khóa nếu còn trang chờ/review/lỗi; payload mang đúng revision và edits từng trang.
- Tab nền, tab đã đóng và tab khác không nhận nhầm event/result.

### Nghiệm thu runtime Windows

1. Chọn lần lượt 1, 3 và khoảng 20 ảnh; xác nhận chỉ có một tab tài liệu và đúng số thumbnail.
2. Zoom/Hand/Space/chuột giữa trước, trong và sau nhận diện.
3. Chạy trang hiện tại, sau đó chạy tất cả; chuyển thumbnail khi các trang khác còn xử lý.
4. Tạo một lỗi có kiểm soát ở một trang, retry trang đỏ và xác nhận trang xanh không mất.
5. Tinh chỉnh khử bóng/Bám biên ở hai trang khác nhau, chuyển qua lại và kiểm tra state không trộn.
6. Xuất PDF/ZIP, đối chiếu thứ tự thumbnail, số tem và tên file.
7. Chạy lại ảnh khách hàng 9 tem `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg` trong cùng batch với ảnh khác để khóa hồi quy khử bóng/C2.

Không tuyên bố đạt máy bế vật lý nếu mới có typecheck/unit/integration test và smoke trên Viewer.

## Kế hoạch sửa theo lô (mỗi lô tối đa 5 file)

### Lô 1 — Page state backend, chưa đổi API công khai

1. `backend/app/core/sticker_sheet_session.py`
2. `backend/app/workers/sticker_source_pipeline.py`
3. `backend/tests/test_sticker_source_pipeline.py`
4. `docs/AI_NHIEU_TRANG_FIXES_2026-08-09.md`

Mục tiêu: artifact/lock/stage theo trang, giữ tương thích trang 1. Verify pytest pipeline/session và py_compile.

### Lô 2 — API detect/refine/confirm/asset theo trang

1. `backend/app/schemas/sticker_sheet.py`
2. `backend/app/api/routes/sticker_sheet.py`
3. `backend/tests/test_sticker_sheet_api.py`
4. `desktop/src/lib/stickerSheetApi.ts`
5. `desktop/src/lib/stickerSheetApi.test.ts`

Mục tiêu: hai đầu schema đổi cùng lô, URL asset không đụng revision giữa trang. Verify pytest API + Vitest API.

### Lô 3 — Export nhiều trang atomic

1. `backend/app/workers/sticker_sheet_export.py`
2. `backend/app/schemas/sticker_sheet.py`
3. `backend/app/api/routes/sticker_sheet.py`
4. `backend/tests/test_sticker_sheet_api.py`
5. `docs/AI_NHIEU_TRANG_FIXES_2026-08-09.md`

Mục tiêu: validate mọi trang/revision, ghép PDF/ZIP đúng thứ tự, giữ vector thật. Verify backend export/golden liên quan.

### Lô 4 — Store frontend theo trang và race guard

1. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`
2. `desktop/src/components/preprocess-tools/stickerSheetStore.test.ts`
3. `desktop/src/lib/stickerSheetApi.ts`
4. `docs/AI_NHIEU_TRANG_FIXES_2026-08-09.md`

Mục tiêu: state và request key theo trang; lỗi/retry/cleanup không lan sang sibling. Verify store Vitest + typecheck.

### Lô 5 — Chọn nhiều ảnh thành một tài liệu

1. `desktop/src/lib/imageNormalizer.ts`
2. `desktop/src/lib/imageNormalizer.test.ts`
3. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`
4. `desktop/src/components/preprocess-tools/StickerSheetPanel.test.tsx`
5. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`

Mục tiêu: multi-select → PDF nhiều trang → Viewer/thumbnail; tuyệt đối chưa tự nhận diện. Verify PNG/JPEG/DPI/no-DPI và panel.

### Lô 6 — Panel và overlay bám trang đang xem

1. `desktop/src/components/imposition-tools/ImposerDashboard.tsx`
2. `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx`
3. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx`
4. `desktop/src/components/preprocess-tools/StickerSheetWorkspace.tsx`
5. `desktop/src/components/preprocess-tools/StickerSheetWorkspace.test.tsx`

Mục tiêu: active source page đi xuyên panel/overlay; tuning/edit riêng trang, Viewer không đổi giao diện.

### Lô 7 — Trạng thái trên thumbnail và thứ tự export

1. `desktop/src/components/ImpositionTab.tsx`
2. `desktop/src/components/AcrobatViewer.tsx`
3. `desktop/src/components/acrobat/ThumbSidebar.tsx`
4. `desktop/src/components/acrobat/ThumbSidebar.aiStatus.test.tsx`
5. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`

Mục tiêu: badge theo trang nguồn, overlay theo active page và `page_order` theo thumbnail. Verify routing/tab nền/reorder.

### Lô 8 — Hồi quy tổng và nghiệm thu

Không mở rộng tính năng. Chỉ bổ sung test còn thiếu trong tối đa 5 file, chạy:

- backend pytest phạm vi sticker session/pipeline/API/export;
- frontend typecheck;
- Vitest preprocess/viewer liên quan;
- full Vitest;
- production frontend build;
- `git diff --check`;
- smoke thật trên Tauri theo ma trận phía trên.

## Điều kiện chấp nhận cuối

- Một lần chọn N ảnh tạo đúng một tài liệu N thumbnail.
- Không AI trước thao tác chủ động.
- Nhận diện được trang hiện tại hoặc tất cả trang; trạng thái từng trang độc lập.
- Viewer không bị khóa/đổi giao diện; zoom/Hand/thumbnail luôn dùng cơ chế chuẩn.
- Overlay, tuning và edit không trộn trang.
- Một trang lỗi không phá sibling; retry riêng được.
- Không export thiếu trang âm thầm; kết quả đúng thứ tự thumbnail.
- Không hồi quy khử bóng, topology, C2, Offset và các chốt `<0,25 mm` / khớp gãy `>1°` đã có.
- Máy mạnh không bị hard-cap mới; máy yếu tiếp tục được bảo vệ theo RAM.
