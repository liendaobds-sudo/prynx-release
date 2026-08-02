# BÁO CÁO AUDIT TĂNG TỐC COMBINE ẢNH → PDF

**Ngày:** 2026-08-02

**Phạm vi:** nút Ghép file trong `CombineTab`, trọng tâm ca nhiều PNG/JPG giữ nguyên kích thước; từ lúc bấm Ghép đến khi file kết quả sẵn sàng để mở trong viewer.

**Mốc an toàn trước audit:** commit `7ebcd34` — `checkpoint: lưu các đợt sửa trước tối ưu Combine`.

**Trạng thái:** Giai đoạn khảo sát và lập phương án. Chưa sửa mã tăng tốc trong báo cáo này; chờ chủ dự án duyệt trước khi triển khai theo lô.

## 1. Kết luận điều hành

Có thể tăng tốc thêm đáng kể. Đường hiện tại đã nhanh hơn backend cũ nhưng vẫn dành phần lớn thời gian cho việc giải mã PNG rồi nén Flate lại bằng JavaScript trong WebView, chạy chủ yếu tuần tự.

Phương án đáng làm nhất là thêm **fast path native Rust cho manifest chỉ gồm ảnh**, xử lý các nguồn ảnh duy nhất song song bằng Rayon, dựng PDF theo đúng thứ tự manifest và ghi thẳng ra file. Đường cũ vẫn được giữ làm fallback cho PDF trộn ảnh, chế độ chưa đủ parity hoặc khi extension native chưa sẵn sàng.

Mục tiêu kỹ thuật cho bộ 8 PNG 3000×3000 trên máy hiện tại là đưa riêng bước ghép xuống khoảng **5 giây hoặc thấp hơn**. Đây là mục tiêu A/B, không phải cam kết trước benchmark. Bản vá chỉ được bật mặc định nếu nhanh hơn baseline tối thiểu 30%, không tăng peak RAM ngoài ngân sách và vượt đủ kiểm thử parity hình ảnh/PDF.

Không chọn Web Worker làm giải pháp chính: Worker giúp giao diện bớt đứng nhưng vẫn chạy đúng chuỗi giải mã/nén JavaScript và không loại bỏ bản sao `ArrayBuffer`/`Blob` lớn.

## 2. Baseline đã xác nhận

### 2.1 Bộ dữ liệu người dùng

- 8 PNG, mỗi ảnh 3000×3000 px.
- Tổng 72.000.000 pixel.
- Tổng dung lượng mã hóa 38.683.168 byte, khoảng 36,891 MiB.
- Đây không phải ca “8 ảnh vượt 64 MB”; quyết định cũ đi backend là do ngưỡng pixel, không phải dung lượng file.

### 2.2 Số đo hiện có

| Đường xử lý | Thời gian | Ghi chú |
|---|---:|---|
| Backend cũ: ReportLab → PDF tạm từng ảnh → pikepdf ghép | 26,842 giây | Job thật `76e200ad2143434f8847a81082c5ca52` |
| Frontend cũ: PDF ảnh trung gian rồi `copyPages()` | 13,974 giây | A/B cùng process, cùng bytes |
| Frontend hiện tại: nhúng ảnh thẳng vào `finalDoc` | 12,055 giây | Nhanh hơn 13,7% so với frontend cũ |
| Smoke Tauri đến khi viewer đổi trạng thái | khoảng 8,65 giây | Đo trên luồng app thật |
| Smoke Tauri đến first tile | khoảng 9,7 giây | 8 PNG mở đủ 8 trang |

Các số đo thuộc hai harness khác nhau nên không cộng trực tiếp 12,055 giây với 9,7 giây. Khi triển khai phải tái đo trong cùng một harness và cùng build.

### 2.3 Phần cứng hiện tại

- 16 logical processor.
- Tổng RAM 34.107.990.016 byte, khoảng 31,8 GiB.
- RAM khả dụng lúc audit 13.235.032.064 byte, khoảng 12,3 GiB.

Máy thuộc tier ≥16 GB: không được hard-cap worker hoặc hạ chất lượng vô điều kiện. Fast path phải dùng hết năng lực CPU; chỉ máy <8 GB và <16 GB mới giảm độ song song theo `backend/app/core/system_memory.py`.

## 3. Luồng hiện tại

```text
CombineTab
  ├─ job ảnh vừa trên máy ≥16 GB
  │    └─ pdf-lib trong WebView
  │         ├─ đọc toàn bộ bytes từng ảnh
  │         ├─ PNG: UPNG giải mã RGBA
  │         ├─ tách RGB + alpha
  │         ├─ pako nén Flate lại RGB + SMask
  │         └─ finalDoc.save() → Uint8Array → Blob/File trong RAM
  │
  └─ job được delegate
       └─ sidecar localhost
            ├─ Pillow kiểm tra ảnh
            ├─ ReportLab tạo một PDF tạm cho từng ảnh, tuần tự
            ├─ pikepdf mở các PDF tạm và append trang
            ├─ pikepdf save file kết quả
            └─ bản có license: mở + watermark + save lại toàn file
```

## 4. Phát hiện có bằng chứng

| Mã | Trạng thái | Mức | Phát hiện |
|---|---|---:|---|
| §TC.1 | VERIFIED | P1 | PNG frontend bị giải mã và nén lại bằng JavaScript, chủ yếu tuần tự |
| §TC.2 | VERIFIED | P1 | Backend tạo PDF tạm từng ảnh tuần tự rồi mới ghép và save lần nữa |
| §TC.3 | VERIFIED | P2 | Policy hiện tại tối ưu an toàn RAM, chưa chọn engine nhanh nhất theo workload |
| §TC.4 | VERIFIED | P2 | Bản có license có thể ghi lại toàn bộ PDF thêm một lần để nhúng watermark |
| §TC.5 | VERIFIED | P2 | Chưa có benchmark tái lập và telemetry tách riêng decode/embed/save/open-viewer |

### §TC.1 — `pdf-lib` giải mã và Flate lại PNG trên luồng JavaScript

**Bằng chứng:**

- `desktop/src/components/CombineTab.tsx:803-849` lặp tuần tự từng node ảnh, gọi `appendImagePageToPdfDoc`, rồi `finalDoc.save()`.
- `desktop/src/lib/imageNormalizer.ts:40-57` gọi `doc.embedPng()` cho PNG.
- Dự án đang dùng `pdf-lib 1.17.1`.
- `desktop/node_modules/pdf-lib/src/utils/png.ts:52` gọi `UPNG.toRGBA8()`.
- `desktop/node_modules/pdf-lib/src/core/embedders/PngEmbedder.ts:34-55` nén lại RGB và alpha bằng `flateStream()`.
- `desktop/node_modules/pdf-lib/src/core/PDFContext.ts:230-236` dùng `pako.deflate()`.

**Tác động:** 72 MP tương đương ít nhất hàng trăm MB dữ liệu RGBA/RGB/alpha phải đi qua JavaScript. Tám ảnh được xử lý nối tiếp nên máy 16 luồng không được tận dụng hết.

### §TC.2 — Backend có hai tầng trung gian và xử lý ảnh tuần tự

**Bằng chứng:**

- `backend/app/workers/pdf_manifest_engine.py:221-250` dùng ReportLab `ImageReader` và `canvas` để tạo một PDF tạm cho mỗi ảnh.
- `backend/app/workers/pdf_manifest_engine.py:670-677` chỉ tạo PDF ảnh khi gặp nguồn trong vòng lặp manifest; vòng lặp này tuần tự.
- `backend/app/workers/pdf_manifest_engine.py:696-728` append trang vào pikepdf rồi save tài liệu đích.
- Baseline backend 26,842 giây chậm hơn đường frontend hiện tại 12,055 giây khoảng 2,23 lần.

**Tác động:** backend tránh OOM WebView nhưng chưa phải đường nhanh. Song song hóa ReportLab đơn thuần vẫn giữ PDF tạm và lượt save cuối, nên chỉ là phương án trung gian.

### §TC.3 — Routing hiện bảo vệ RAM nhưng chưa tối ưu throughput

**Bằng chứng:**

- `desktop/src/lib/combineDelegation.ts:217-236` chỉ delegate ảnh trên máy ≥16 GB khi ước lượng làm việc đạt 25% RAM khả dụng; không còn hard-cap pixel cho máy mạnh.
- `desktop/src/components/CombineTab.tsx:1029-1082` chọn frontend/backend từ kết quả policy này.
- Với máy 32 GB hiện tại, ca 72 MP được giữ ở frontend và hoàn thành đúng, nhưng vẫn mất khoảng 12,055 giây trong benchmark lõi.

**Kết luận:** policy hiện tại đúng về an toàn RAM. Khi có native engine nhanh hơn, routing phải bổ sung tiêu chí **engine crossover đã đo**, không khôi phục một hard-cap trá hình.

### §TC.4 — Watermark có thể tạo thêm một full rewrite

**Bằng chứng:**

- `backend/app/api/routes/combine_jobs.py:338-347` gọi `_safe_watermark()` sau khi `merge_manifest()` đã save.
- `backend/app/api/routes/pdf_tools.py:195-217` mở lại PDF, nhúng XMP/nội dung ẩn, save sang temp rồi `os.replace()`.

**Tác động:** dev mode bỏ qua watermark nên baseline 26,842 giây chưa đại diện đầy đủ cho bản có license. Không được tắt watermark để lấy tốc độ. Chỉ tối ưu lượt save này sau khi telemetry chứng minh nó đáng kể và có test forensic parity.

### §TC.5 — Chưa tách đủ thời gian từng stage

Hiện có log quyết định delegation và progress tổng, nhưng chưa có cùng một record cho các stage:

- đọc/kiểm tra header;
- decode PNG;
- tách RGB/SMask;
- Flate/DCT;
- dựng object graph;
- ghi PDF;
- watermark;
- mở metadata viewer;
- first tile.

Không có harness benchmark được commit để tái chạy đúng bộ 8 ảnh. Nếu sửa trực tiếp rồi chỉ “cảm thấy nhanh hơn”, rất dễ đổi tốc độ lấy file lớn, mất alpha hoặc hồi quy máy yếu.

## 5. Phương án được chọn

### 5.1 Fast path native Rust cho manifest chỉ gồm ảnh

Tạo module mới trong `native/`, không đặt vào `print_engine/` vì PPE hiện có bất biến chỉ đọc/raster, không sinh PDF.

Đặc tính bắt buộc:

1. Nhận danh sách nguồn duy nhất và manifest trang; giữ đúng duplicate, blank, rotation và thứ tự.
2. JPEG giữ nguyên DCT khi hợp lệ; PNG dùng IDAT trực tiếp khi cấu trúc cho phép.
3. PNG cần alpha/interlace/palette đặc biệt được giải mã native, tách RGB và `/SMask`, rồi Flate lại; không làm phẳng nền trong file đầu ra.
4. Xử lý nguồn duy nhất bằng Rayon global pool; dựng cây trang theo thứ tự sau khi asset sẵn sàng.
5. PyO3 nhả GIL trong vùng nặng. Module không gọi PDFium nên không cần `pdfium_guard()`.
6. Ghi thẳng ra `*.partial.pdf`, không đi qua `ArrayBuffer`/`Blob` của WebView.
7. Báo `completed_source_indices` tích lũy để card hoàn tất đúng nguồn dù xử lý song song xong không theo thứ tự.
8. Hủy hợp tác giữa các nguồn và trước save; xóa partial khi hủy/lỗi.
9. Native unavailable/định dạng chưa hỗ trợ thì dùng đường cũ. Dữ liệu hỏng/OOM không được âm thầm chạy lại đường chậm vì có thể nhân đôi tải.

### 5.2 RAM-gating

- Máy <8 GB: 1 nguồn nặng cùng lúc.
- Máy 8–<16 GB: tối đa 2 nguồn nặng cùng lúc.
- Máy ≥16 GB: dùng pool theo CPU, không áp hard-cap RAM/worker vô điều kiện.
- Số task thực tế không vượt số nguồn duy nhất.
- Dùng helper hiện có trong `backend/app/core/system_memory.py`; không tạo policy RAM thứ hai.

### 5.3 Bật routing theo benchmark

Fast path được tích hợp trước nhưng chưa đổi routing mặc định. Sau A/B:

- nếu native thắng frontend tối thiểu 30% ở workload ảnh lớn, routing dùng native theo điểm crossover đo được;
- ngưỡng crossover là lựa chọn engine, không phải giới hạn số pixel;
- job nhỏ tiếp tục ở frontend để tránh overhead job/polling;
- mixed PDF+ảnh và “Chia nhóm theo kích thước” giữ đường hiện tại cho tới khi có parity riêng.

## 6. Các phương án không chọn làm đường chính

### Web Worker cho `pdf-lib`

Ưu điểm: giao diện bớt đứng. Nhược điểm: vẫn UPNG → RGBA → pako, vẫn save PDF trong JS và có chi phí chuyển bytes. Có thể làm sau để tăng độ mượt cho job nhỏ, nhưng không giải quyết nút thắt chính.

### Chạy nhiều ReportLab worker

Ít thay đổi hơn native và có thể nhanh hơn backend hiện tại. Tuy nhiên vẫn sinh PDF tạm từng ảnh, tốn thêm I/O và pikepdf phải ghép/save lại. Chỉ dùng làm fallback nếu native chưa build được.

### Viết native cho mọi manifest PDF+ảnh ngay lập tức

Có trần tốc độ cao nhất nhưng phạm vi quá lớn: phải copy an toàn toàn bộ object graph PDF, encrypted PDF, box, annotation, form, layer và metadata. Không phù hợp lô đầu của lỗi nhiều PNG.

### Đổi PNG sang JPEG

Không chấp nhận vì làm mất alpha và gây nén mất dữ liệu, sai yêu cầu chế bản.

## 7. Kế hoạch triển khai theo lô

Mỗi lô tối đa 5 file và phải verify xong trước khi sang lô kế.

### Lô 1 — Primitive native + benchmark, tối đa 5 file

- `native/Cargo.toml`: thêm dependency PDF/Flate trực tiếp; không thêm `[profile.release]`.
- `native/src/lib.rs`: đăng ký API PyO3.
- `native/src/combine_image_pdf.rs`: writer ảnh → PDF, Rayon, cancel/progress, cleanup.
- `native/tests/combine_image_pdf.rs`: parity DPI, alpha, rotation, duplicate, blank, lỗi ảnh.
- `backend/benchmarks/benchmark_combine_images.py`: harness A/B tái lập.

Verify: `cargo fmt --check`, `cargo check`, Rust tests, pikepdf mở được output, PDFium/PDF.js render đủ trang; so pixel alpha và kích thước trang.

### Lô 2 — Tích hợp backend + progress chính xác, tối đa 5 file

- `backend/app/workers/pdf_manifest_engine.py`.
- `backend/app/core/combine_jobs.py`.
- `backend/app/api/routes/combine_jobs.py`.
- `backend/tests/test_pdf_manifest_engine.py`.
- `backend/tests/test_pdf_manifest_jobs.py`.

Verify: native/fallback, progress tăng đơn điệu, source index đúng dù hoàn tất lệch thứ tự, cancel không để partial, admission tài nguyên giữ nguyên.

### Lô 3A — API desktop + policy routing, tối đa 4 file

- `desktop/src/lib/api.ts`.
- `desktop/src/lib/api.mergeManifest.test.ts`.
- `desktop/src/lib/combineDelegation.ts`.
- `desktop/src/lib/combineDelegation.test.ts`.

Verify: contract mới backward-compatible; job nhỏ vẫn frontend; ca 8 PNG chỉ chuyển native sau khi A/B đạt gate; tier RAM giữ đúng quy tắc dự án.

### Lô 3B — UI tick theo nguồn thật, tối đa 2 file

- `desktop/src/components/CombineTab.tsx`.
- `desktop/src/lib/combineTransport.integration.test.tsx`.

Verify: file nào native hoàn tất thì đúng card đó tick xanh; hủy/job mới/unmount reset sạch; spinner vẫn chỉ vòng xoay + `%`.

### Lô 4 — Watermark single-pass, chỉ làm nếu telemetry chứng minh cần thiết

Tách payload watermark thuần và truyền vào writer native để nhúng XMP + invisible text trước lượt save đầu. Giữ `_safe_watermark()` làm fallback. Lô này phải có test forensic so với `verify_watermark()` và không được làm raw license key xuất hiện trong PDF/log.

## 8. Cổng nghiệm thu

### Hiệu năng

- Cùng 8 PNG, cùng build release/dev-optimized, chạy warm-up 1 lần rồi lấy median 5 lần.
- Native phải nhanh hơn frontend hiện tại tối thiểu 30% mới được bật mặc định.
- Mục tiêu trên máy 16 logical CPU/32 GB: combine core khoảng ≤5 giây; nếu không đạt, giữ feature flag và tiếp tục profile.
- First tile không được chậm hơn baseline Tauri khoảng 9,7 giây.
- Dung lượng output không tăng quá 10% nếu chất lượng/alpha không đổi, trừ khi có bằng chứng bộ nén cũ tạo output bất thường.

### Đúng dữ liệu

- Đủ số trang, đúng thứ tự, duplicate, blank và rotation.
- DPI PNG/JFIF giữ đúng kích thước vật lý.
- PNG trong suốt giữ `/SMask`; pixel render parity ở vùng alpha.
- JPEG không bị decode/re-encode mất dữ liệu khi có thể giữ DCT.
- PDF mở được bằng pikepdf, PDF.js, PDFium và Acrobat smoke test.
- Watermark bản license vẫn xác minh được; dev mode vẫn bỏ qua như hiện tại.

### Tài nguyên và vòng đời

- Máy <8 GB và <16 GB được giảm song song; máy ≥16 GB không bị hard-cap.
- Không giữ toàn bộ output trong WebView.
- Cancel/lỗi không để temp/partial mồ côi.
- Không log full path, tên nhạy cảm, license key hoặc HWID thô.

### Regression

- Backend focused pytest xanh.
- Native `cargo check` và tests xanh.
- Desktop focused Vitest, typecheck và lint hẹp xanh trên Windows thật.
- Smoke Tauri với PNG alpha, PNG opaque, JPEG và mixed PDF+ảnh.

## 9. Chốt duyệt

Đề nghị duyệt triển khai Lô 1 → Lô 3B. Lô 4 chỉ được mở sau khi số đo production có license cho thấy watermark rewrite chiếm tỷ lệ đáng kể.
