# COMBINE PNG LOADING — NHẬT KÝ SỬA

**Ngày:** 2026-08-01  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_COMBINE_PNG_LOADING_2026-08-01.md`

## Lô 1 — Chấm dứt loading vô hạn và bổ sung chẩn đoán

**Trạng thái:** Đã triển khai, verify tự động mức 2; còn cần chạy lại đúng bộ PNG gốc trên app Tauri.

### Thay đổi

- `desktop/src/hooks/viewer/usePdfLoader.ts`
  - UIUX (audit 2026-08-01 §A.1+A.2): thêm state `idle/loading/slow/ready/error/cancelled`.
  - Reset lỗi khi bắt đầu file mới; PDF.js reject, native/fallback lỗi và tài liệu 0 trang đều kết thúc ở `error`.
  - Giữ loading task để Thử lại/Hủy đúng lượt tải; dùng generation guard để kết quả muộn không ghi đè state mới.
  - Hủy HTTP fallback bằng `AbortController`; native invoke không hủy vật lý nhưng kết quả muộn bị bỏ qua.
  - Sau 10 giây chỉ chuyển sang cảnh báo `slow`, không timeout hoặc hard-cap tác vụ.
  - Log `[PDF-LOAD]` theo stage `start/slow/ready/error/retry/cancel`, gồm loại nguồn, dung lượng, số trang và thời gian; không ghi full path.
- `desktop/src/components/AcrobatViewer.tsx`
  - Nút lỗi tải lại đúng PDF hiện tại thay vì reload toàn bộ ứng dụng.
  - Trạng thái tải lâu có Thử lại/Hủy; trạng thái đã hủy có thể Thử lại.
  - Không hiển thị trực tiếp lỗi kỹ thuật; chi tiết nằm trong log chẩn đoán.
- `desktop/src/hooks/viewer/usePdfLoader.test.tsx`
  - Regression cho PDF.js reject, zero-page, reset lỗi khi đổi file, retry thành công, cảnh báo chậm không tự hủy và rejection do hủy không biến thành error.

### Verify

- Baseline trước sửa: `usePdfLoader.test.tsx` — **4 failed/4** do API state chưa tồn tại và lỗi vẫn bị nuốt.
- Sau sửa: loader + Combine/file transport — **22 passed/22**, 5 file test.
- `npm run typecheck`: Lô 1 không phát sinh lỗi tại loader/viewer; lệnh toàn dự án hiện dừng bởi 2 lỗi ngoài phạm vi trong `desktop/src/components/preprocess-tools/StickerTool.test.ts` (`CUT_MODES_RICH` và implicit `any`). Không sửa file người dùng này.
- `git diff --check` trên ba file Lô 1: không có lỗi whitespace.

### Chưa xác minh

- Chưa có bộ PNG gốc đã gây lỗi, nên chưa chạy lại được chính ca runtime của người dùng.
- §B.2 được xử lý ở Lô 2 bên dưới; §B.1 vẫn thuộc Lô 3 backend/scalability.
## Lô 2 — Sửa DPI PNG và hợp đồng bytes kết quả

**Trạng thái:** Đã triển khai, verify tự động mức 2; còn cần kiểm tay đúng bộ PNG gốc.

### Thay đổi

- `desktop/src/lib/imageNormalizer.ts`
  - PDF (audit 2026-08-01 §B.2): đọc `pHYs.unit` tại `data + 8` đúng cấu trúc 9 byte, thay vì nhầm sang CRC tại `data + 12`.
  - Đọc số 32-bit unsigned, kiểm `len === 9` và biên data+CRC trước khi dùng metadata.
- `desktop/src/lib/imageNormalizer.test.ts`
  - Test qua API thật `imageBytesToPdfDoc`: PNG 30 DPI đổi pixel→point đúng và PNG không DPI vẫn fallback 72 DPI.
- `desktop/src/lib/combineAssembly.ts` + test
  - Kiểm `%PDF-` ở đầu và `%%EOF` trong 1.024 byte cuối mà không parse lại tài liệu.
  - `toExactArrayBuffer` dùng fast-path không copy cho output toàn buffer; chỉ copy khi đầu vào là subarray/SharedArrayBuffer để loại prefix/suffix ngoài byte-window.
  - Test Blob có sentinel, fast-path, PDF thiếu EOF và PDF thật từ `pdf-lib`.
- `desktop/src/components/CombineTab.tsx`
  - Bốn đường Interleave/In/Combine/Combine theo nhóm đều dùng đúng byte-window.
  - Chặn tài liệu 0 trang trước `save()` và chặn output thiếu header/trailer trước khi mở tab.

### Bằng chứng và verify

- Baseline trước sửa: **3 failed/6** — trang PNG 30 DPI trả `2 pt` thay vì `4,8004 pt`; hai helper byte chưa tồn tại.
- Test hẹp sau sửa: **8 passed/8**.
- Ma trận Combine/ảnh/loader: **33 passed/33**, 7 file test.
- `npm run typecheck`: **pass**.
- Lint `imageNormalizer.test.ts`, `combineAssembly.ts`, `combineAssembly.test.ts`: **pass**.
- Toàn bộ Vitest desktop: **1.603 passed, 2 skipped, 5 failed ngoài phạm vi** — 2 snapshot store lệch bởi field khác, 2 test `api.upload` và 1 property test khuôn `tray` timeout. Không cập nhật snapshot hoặc sửa ké.
- `git diff --check` phạm vi Lô 2: không có lỗi whitespace.

### Giới hạn kết luận

- Runtime hiện tại của `pdf-lib.save()` thường trả view phủ toàn backing buffer, nên lỗi `.buffer` là hardening hợp đồng, chưa được coi là nguyên nhân trực tiếp của spinner.
- Lô 2 chưa thay đổi cách phân luồng nhiều PNG lớn; §B.1 vẫn thuộc Lô 3 backend/scalability.
## Lô 3A — Backend nhận PNG/JPG với bộ nhớ hữu hạn

**Trạng thái:** Đã triển khai và verify tự động mức 2; còn cần chạy lại bộ PNG gốc trên app Tauri.

### Thay đổi

- backend/app/workers/pdf_manifest_engine.py
  - PERF (audit 2026-08-01 §B.1): ảnh chỉ được chuyển khi manifest thực sự tham chiếu; từng ảnh được bọc thành PDF tạm trên đĩa rồi giải phóng bitmap trước ảnh kế tiếp.
  - PDF tạm nằm cạnh output trong results/, nên cơ chế cleanup đệ quy hiện có thu hồi được nếu sidecar dừng giữa job.
  - DPI PNG dùng đúng pHYs; JPEG dùng đúng APP0/JFIF giống frontend; không tự áp EXIF orientation.
  - PNG alpha giữ /SMask; JPEG giữ /DCTDecode.
  - Từ chối ảnh đổi đuôi, ảnh nhiều frame và cả DecompressionBombWarning, không chỉ DecompressionBombError.
- backend/app/api/routes/pdf_tools.py
  - Manifest chỉ nhận .pdf, .png, .jpg, .jpeg.
  - Cả upload và native path đều đối chiếu đuôi với magic thật; không tin Content-Type.
  - Native path ảnh được đọc trực tiếp, không xóa nguồn của người dùng.
- backend/tests/test_pdf_manifest_engine.py, backend/tests/test_pdf_manifest_route.py
  - Regression cho mixed PDF/PNG, JPEG JFIF, DPI, rotation, alpha, DCT, ảnh giả/hỏng, decompression bomb, nguồn không được tham chiếu, upload/native path và cleanup.

### Verify

- Baseline mở rộng: **4 failed/11** ở worker (spoof, warning, decode ảnh không dùng; một kỳ vọng DCT được hiệu chỉnh theo chuỗi lọc thật) và **2 failed/9** ở route (native PNG + WebP ngoài whitelist).
- Sau sửa: worker + route — **20 passed/20**.
- py_compile route + worker: **pass**.
- Không có cảnh báo decompression-bomb còn lọt qua test.

## Lô 3B — Tự động chuyển job ảnh lớn sang backend

**Trạng thái:** Đã triển khai và verify tự động mức 2; còn cần kiểm tay runtime.

### Thay đổi

- desktop/src/lib/combineDelegation.ts
  - Đọc kích thước PNG từ IHDR và JPEG từ SOF bằng header tối đa 512 KiB; file native dùng HTTP Range, không materialize/decode toàn ảnh.
  - Cache phép đo theo File; ảnh luôn được ước lượng là đúng 1 trang, không dùng heuristic byte/trang của PDF.
  - Job nhỏ giữ đường frontend nhanh. Job đạt 64 MiB, 800 trang PDF hoặc 64 triệu pixel ảnh tự dùng backend manifest.
  - Một ảnh cực lớn cũng được delegate; Interleave PDF-only không vô tình nhận ảnh.
- desktop/src/lib/combineAssembly.ts
  - Backend manifest dùng chung whitelist PDF/PNG/JPG, giữ nguyên rotation, blank và dedupe file.
- desktop/src/components/CombineTab.tsx
  - Nút Ghép tự đo header trước quyết định và truyền tổng pixel vào delegation.
  - Log [COMBINE] ghi stage, số node/nguồn/ảnh, tổng byte, tổng pixel và frontend hoặc backend_manifest; không ghi tên file hay full path.
- Test delegation/assembly bổ sung parser PNG/JPEG baseline/progressive, Range transport, ngưỡng pixel/byte/page, single-image, whitelist và hợp đồng manifest ảnh.

### Verify

- Frontend Combine/ảnh/API — **25 passed/25**, 4 file test.
- npm run typecheck — **pass**.
- ESLint bốn file lib Lô 3B — **pass**.
- ESLint toàn CombineTab.tsx còn 15 lỗi no-explicit-any + 4 cảnh báo hook đã có sẵn ngoài đoạn Lô 3; không sửa lan phạm vi.

### Giới hạn còn lại

- Chưa có bộ PNG gốc gây lỗi nên chưa đạt bằng chứng runtime mức 3.
- Đường tự động mới bảo vệ nút **Ghép file** không chia nhóm. Trộn đan xen, In và Ghép theo nhóm kích thước vẫn dùng frontend; cần lô riêng nếu muốn cùng cơ chế.
- Endpoint đồng bộ chưa có progress/cancel hợp tác; hủy HTTP không dừng worker thread đã chạy.
- Hợp đồng backend hiện còn giới hạn 256 nguồn. Job lớn hơn cần batching/worker bounded-open riêng, không nên chỉ nâng số cứng.
- Job trộn file có native path với Blob phải upload lại các nguồn path-backed; đây là tối ưu transport tiếp theo.

## Lô 3C — Điều chỉnh lại routing theo RAM thật và tối ưu đúng bộ 8 PNG

**Ngày:** 2026-08-02  
**Trạng thái:** Hoàn tất code, test tự động, benchmark và smoke đúng ca tám ảnh trong app Tauri.

### Baseline đúng ca người dùng

- 8 PNG, mỗi ảnh `3000×3000` px; tổng `72.000.000` pixel.
- Tổng dung lượng mã hóa `38.683.168` byte (`36,891 MiB`), không vượt ngưỡng 64 MiB.
- Routing cũ vẫn chuyển backend vì điều kiện pixel `72 MP >= 64 MP`.
- Job backend thật `76e200ad2143434f8847a81082c5ca52` mất `26,842 giây`; trạng thái 62% là 5/8 ảnh đã chuyển xong, không phải 62% dung lượng.

### Các sub-lô đã triển khai

1. **3C1 — Tauri RAM (1 file):** `desktop/src-tauri/src/lib.rs`
   - Command `get_system_memory_status` trả `totalBytes` và `availableBytes` từ `GlobalMemoryStatusEx`.
   - Giữ nguyên nguồn RAM của DOC_CACHE; không thêm hard-cap cho máy mạnh.
2. **3C2 — Policy (2 file):** `combineDelegation.ts` và test.
   - Byte 64 MiB chỉ tính nguồn PDF duy nhất; ảnh dùng `8 byte/pixel + encoded bytes`.
   - `<8 GB`: ngưỡng 32 MP; `8–<16 GB`: 64 MP; `>=16 GB`: không hard-cap pixel, chỉ chuyển backend nếu ước lượng cần ít nhất 25% RAM đang khả dụng.
   - Không đọc được header ảnh thì fail-safe sang backend; không đọc được RAM thì giữ fallback 64 MP.
3. **3C3 — UI/transport (4 file):** `CombineTab.tsx`, test tích hợp và hai locale.
   - Combine đọc RAM thật trước quyết định và log tổng/khả dụng, không dùng `navigator.deviceMemory` bị Chromium cap.
   - Đổi “Đang ghép trên máy chủ” thành “Đang xử lý trên máy này” vì sidecar chạy tại localhost của chính máy người dùng.
4. **3C4 — Bỏ PDF ảnh trung gian (3 file):** `imageNormalizer.ts`, test và `CombineTab.tsx`.
   - PNG/JPG được nhúng thẳng vào `finalDoc`; giữ DPI, rotation và nén gốc, không tạo PDF một trang rồi `copyPages()` sang tài liệu đích.

### Kết quả

- Ca regression đúng 8 ảnh + các tier RAM: `combineDelegation` **30/30 pass**.
- Ma trận frontend ảnh/policy/assembly/API/transport: **75/75 pass**.
- `npm run typecheck`: **pass**; ESLint hẹp: **pass**.
- Rust: `cargo check --lib` **pass**; `doc_cache_tests` **5/5 pass**, gồm schema camelCase và RAM Windows thật.
- `git diff --check`, JSON locale và UTF-8 không BOM: **pass**.
- A/B cùng process, cùng bytes 8 ảnh: đường nhúng trực tiếp `12,055 giây`; đường PDF trung gian cũ `13,974 giây` — giảm `13,7%` trong riêng frontend.
- So với job backend thật `26,842 giây`, benchmark đường mới là `12,055 giây` — tham chiếu giảm `55,1%` (`2,23×` nhanh hơn).
- Smoke Tauri đúng tám đường dẫn: `Combined.pdf` mở đủ `1 / 8` trang; viewer chuyển trạng thái sau `8,65 giây`, render first tile hoàn tất khoảng `9,7 giây`. Log trang 1 ghi IPC `88 ms`, trang 2 `61 ms`; ảnh trang 1 hiển thị đúng.
- Không có `merged_manifest_*.pdf` mới trong `results/` ở thời điểm smoke, xác nhận ca này không còn đi backend job. So với runtime cũ `26,842 giây`, thời gian tới first tile mới giảm khoảng `63,9%` (`2,77×` nhanh hơn).

### Chốt runtime

- Đã chạy bằng intent Combine thật của single-instance → tab đúng tám ảnh → bấm Ghép → mở `Combined.pdf` → first tile. Đây là bằng chứng runtime mức 3 cho đúng ca người dùng báo.
## Lô 3D — Thu gọn navbar và đóng tab nguồn sau khi ghép

**Ngày:** 2026-08-02  
**Trạng thái:** Hoàn tất code, regression và smoke Tauri.

- Bỏ khối tiêu đề/mô tả “Ghép & Trộn PDF” bị lặp với nhãn tab; thanh công cụ bắt đầu ngay từ các thao tác.
- Sau Combine hoặc Interleave thành công, mở mọi tab kết quả trước rồi đóng tab Combine nguồn. Close logic giữ nguyên tab kết quả đang active, không nhảy về Home/tab cũ.
- Chia nhóm theo kích thước cũng mở kết quả vào viewer thay vì giữ các màn Combine chỉ chứa file đã ghép.
- Hủy, lỗi hoặc kết quả về muộn không phát tín hiệu đóng tab nguồn.
- Regression `combineTransport.integration.test.tsx`: **14/14 pass**; ma trận frontend Combine cuối: **77/77 pass**; `npm run typecheck` và ESLint hẹp: **pass**.
- Smoke Tauri với hai PNG thật: header phụ không còn; sau bấm Ghép, tab Combine nguồn biến mất và `Combined.pdf` vẫn active, ảnh trang đầu hiển thị đúng.

## Lô 3E — Fast path native Rust cho Combine ảnh

**Ngày:** 2026-08-02

**Báo cáo duyệt:** `docs/BAO_CAO_AUDIT_TANG_TOC_COMBINE_2026-08-02.md`

**Trạng thái:** Hoàn tất code, kiểm thử tự động và benchmark A/B; còn smoke lại đúng ca tám ảnh trên app Tauri sau khi nạp build mới.

### Các lô đã triển khai

1. **Native writer + benchmark** — commit `5f9a2cd`
   - `combine_image_manifest_native` giữ nguyên IDAT của PNG RGB/gray 8-bit khi an toàn; PNG alpha/palette/interlace được decode native, tách RGB + `/SMask` và Flate.
   - JPEG giữ DCT; CMYK có `/Decode` đúng. Manifest giữ blank, duplicate, rotation và kích thước vật lý.
   - Rayon xử lý nguồn song song, có cancel/progress và ghi atomic. Module không gọi PDFium.
2. **Backend + progress nguồn thật** — commit `d246932`
   - Manifest chỉ gồm PNG/JPEG tự chọn native; định dạng/môi trường chưa hỗ trợ vẫn fallback ReportLab/pikepdf.
   - Worker theo RAM: `<8 GB = 1`, `8–<16 GB = 2`, `>=16 GB` dùng đầy đủ ngân sách CPU.
   - Job/API trả `completed_source_indices` tích lũy; PDF tuần tự chỉ báo xong nguồn sau lần dùng cuối, Interleave cho phép file ít trang tick trước.
   - Watermark backend hiện có vẫn chạy sau khi writer save; không tắt hoặc làm yếu cơ chế license.
3. **Policy chọn engine** — commit `4642962`
   - Job thuần PNG/JPEG/blank từ `64.000.000` pixel đi native kể cả máy mạnh còn nhiều RAM vì benchmark chứng minh native nhanh hơn; đây là điểm crossover engine, không phải hard-cap tài nguyên.
   - Job ảnh nhỏ vẫn ở frontend; manifest trộn PDF + ảnh giữ policy RAM cũ.
4. **Tick xanh đúng nguồn** — commit `7c5f0c8`
   - `CombineTab` dùng `completed_source_indices` thay vì suy card hoàn tất từ số trang.
   - Nguồn hoàn tất lệch thứ tự tick đúng card; một nguồn được dùng ở nhiều card thì mọi card của đúng nguồn đó cùng tick, nguồn khác không bị đánh dấu sớm.
5. **Benchmark đo đúng fallback** — commit `f3ef237`
   - Script tự cấu hình import backend/UTF-8 khi chạy trực tiếp và ép tắt native riêng trong nhánh baseline ReportLab, tránh đo nhầm cùng native engine hai lần.

### Benchmark

Bộ tổng hợp gồm 8 PNG RGBA `3000×3000` (72 MP), tổng encoded `96.988.172` byte — nặng hơn bộ người dùng `38.683.168` byte.

| Đường xử lý | Kết quả | Output |
|---|---:|---:|
| Native warm, 3 lượt | median `4,6698 s`, p95 `4,6731 s` | `84.300.584` byte |
| Frontend hiện tại | `12,055 s` | — |
| Native cold, A/B một lượt | `6,9748 s` | `84.300.584` byte |
| ReportLab fallback, A/B một lượt | `82,3071 s` | `187.507.610` byte |

- Native warm nhanh hơn frontend khoảng `61,3%`, vượt cổng tối thiểu 30% và đạt mục tiêu combine core khoảng 5 giây.
- Trong A/B lạnh cùng script, native nhanh hơn ReportLab khoảng `91,5%`; output nhỏ hơn khoảng `55,0%`.
- Lượt A/B ReportLab đầy đủ 1 warm-up + 3 repeat vượt 240 giây nên bị dừng; số ReportLab công bố là một lượt hợp lệ, không gọi là median nhiều lượt.

### Verify

- Rust: `cargo check --locked --lib` pass; `cargo test --locked combine_image_pdf --lib` **5/5 pass**.
- Backend engine/job/API contract: **97/97 pass**, gồm cả lần nạp extension native thật.
- Desktop policy/API: **38/38 pass**; UI transport/tick nguồn: **19/19 pass**.
- `npm run typecheck`: pass sau cả hai lô desktop.
- ESLint test tích hợp mới: pass. `CombineTab.tsx` còn 9 lỗi `no-explicit-any` và 4 cảnh báo hook cũ ngoài các dòng sửa; không sửa lan phạm vi.
- `git diff --check` theo từng lô: pass.

### Chốt còn lại

- Cần chạy lại intent Combine thật trên app Tauri với đúng 8 PNG sau khi sidecar/extension mới được nạp: xác nhận đường `backend_manifest`, tick xanh theo nguồn, mở `Combined.pdf` và first tile.
- WebP/BMP/TIFF và manifest trộn PDF + ảnh chưa đi native vì chưa có parity riêng; tiếp tục dùng fallback hiện tại.
- Lô watermark single-pass chỉ được mở khi telemetry bản có license chứng minh `_safe_watermark()` còn là nút thắt đáng kể và phải có test forensic parity; chưa có bằng chứng đó trong đợt này.

### Chốt bảo toàn chất lượng — 2026-08-03

Sau khi rà lại yêu cầu chế bản “Combine không được làm thay đổi chất lượng nguồn”, phát hiện nhánh decode PNG có thể chuyển PNG 16-bit xuống RGBA 8-bit. Hành vi này không được chấp nhận dù chỉ xảy ra với định dạng ít gặp.

Hợp đồng mới là **lossless hoặc dừng trước khi tạo output**:

- PNG/JPEG 8-bit thông thường tiếp tục dùng fast path: JPEG giữ nguyên DCT; PNG RGB/gray giữ IDAT khi an toàn; PNG cần decode vẫn dùng Flate lossless và giữ alpha bằng `/SMask`.
- PNG khác 8-bit, APNG nhiều frame, PNG có `iCCP/sRGB/gAMA/cHRM/cICP` hoặc JPEG có ICC bị chặn trước khi native/fallback tạo PDF.
- Backend không còn âm thầm rơi về ReportLab cho các nguồn chưa chứng minh được bảo toàn bit-depth/profile. Job trả thông báo rõ và không để lại output.
- Bộ 8 PNG 72 MP dùng benchmark vẫn qua quality preflight đủ 8/8 nguồn, nên tốc độ fast path của ca người dùng không bị thay đổi.

Verify sau chốt:

- Rust Combine: **8/8 pass**, gồm PNG 16-bit, PNG color metadata và JPEG ICC fail-closed.
- Backend engine/job/API: **100/100 pass**; ba ca 16-bit/ICC xác nhận không sinh output.
- `cargo check --locked --lib`, `rustfmt --check` riêng module và `git diff --check`: pass.

PNG 16-bit/ICC/APNG hiện chưa được gọi là “đã hỗ trợ Combine”; chúng được từ chối an toàn cho tới khi writer có đường nhúng lossless và kiểm thử màu tương ứng. Không có trường hợp nào được phép tự hạ chất lượng để hoàn thành job.
