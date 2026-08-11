# BÁO CÁO AUDIT PHẠM VI ẢNH HƯỞNG CỦA PPE — 2026-08-10

> Audit unit: `W7-U06`  
> Phạm vi: mã nguồn hiện tại trong `D:\pdfcompare`; không build installer, không sửa lõi Rust PPE  
> Mục tiêu: xác định PPE mới còn tác động tới tính năng nào ngoài Viewer và Preflight/Output Preview, đồng thời tìm rủi ro sửa một nơi làm hỏng nơi khác.

## 1. Kết luận điều hành

**Có, nhưng cần tách đúng nghĩa của từ “Preflight”.** Nếu “Preflight” là toàn bộ họ công cụ tiền kỳ thì chỉ có **hai consumer thật sự nằm ngoài họ đó**: Export Image CMYK và fallback nhận diện khuôn trong Bình tem/Bình bản. Nếu người dùng đang gọi riêng màn hình “Xem trước bản in” là Preflight, thì PPE còn tham gia tổng cộng năm luồng sản phẩm ngoài Viewer/Output Preview:

1. **Xuất ảnh CMYK** — TIFF/JPEG CMYK đi qua `ppe_export_cmyk`; RGB/Gray không đi PPE.
2. **Làm phẳng trong suốt** — trang có transparency được raster trong không gian mực bằng `ppe_separations` rồi ghi lại thành ảnh DeviceCMYK.
3. **Xuất PDF/X-1a** — chỉ khi file có transparency, engine gọi nhánh flatten PPE trước khi tạo PDF/X-1a.
4. **Khóa chữ / Outline Fonts** — PPE cấp đường viền glyph; sau khi ghi PDF, PPE còn được dùng để so kẽm trước/sau nhằm chặn mất hoặc thêm mực sai chỗ.
5. **Nhận diện khuôn/biên tem dự phòng trong Bình tem/Bình bản** — khi detector vector trả `CUSTOM`, tối đa một số trang được tách kẽm bằng PPE rồi phân loại lại từ mặt phẳng spot.

Không tìm thấy đường gọi nghiệp vụ trực tiếp từ PPE vào N-up/VDP, Compare/QC, khuôn bế 2D/3D, Logo Rebuild, in hệ thống, chỉnh sửa object/layer, Export RGB/Gray, PDF/X-4 hoặc Convert Colors thông thường. Tuy nhiên nhiều tính năng này nằm chung DLL `pdfcompare_native`; lỗi nạp/ABI/đóng gói DLL có thể làm chúng mất native engine dù thuật toán không dùng PPE.

Ba mục flatten, PDF/X-1a và Outline Fonts vẫn nằm trong họ công cụ Preflight/Preprocessing, nhưng là tác vụ **sửa và xuất file thật**, không phải phần hiển thị Output Preview.

Trên module native mà app dev hiện nạp, chưa xác nhận hồi quy chức năng ngoài Viewer/Output Preview:

- lõi PPE: `641 passed`, `4 ignored` benchmark thủ công;
- backend PPE và năm consumer ngoài hiển thị sau Lô A: `297 passed`;
- smoke các consumer khác dùng chung `pdfcompare_native`: `85 passed`;
- `cargo check` crate native: đạt;
- PDF khách thật: Export CMYK và fallback nhận diện khuôn đều chạy thành công;
- fixture PDF/X-1a có transparency thật: đạt đủ `7/7` kiểm tra compliance.
- Lô B2: `24/24` test policy/E2E tập trung và `268/268` backend hồi quy liên
  quan đạt; hai lượt production policy mới giữ checksum, source và cleanup đúng.

Lô A đã khóa hồi quy chéo; Lô B đã đo contention/cancel; Lô B2 đã áp ngân sách
low-tier động `256–640 MiB`. Ba cổng nghiệm thu còn mở:

- chưa có runtime vật lý trên máy `<8 GB` và `8–15 GB` để đo swap/page fault;
- file-action chạy qua `asyncio.to_thread` chưa có cooperative cancellation;
- chưa có installed/clean-user smoke vì người dùng yêu cầu chưa build.

## 2. Bản đồ API công khai của PPE

| API PPE | Hợp đồng chính | Consumer production |
|---|---|---|
| `PpeRenderSession` | Mở tài liệu/profile một lần, render latest-only, cache resource | Viewer accurate và Output Preview |
| `ppe_softproof` | Render mực rồi quy sang sRGB qua ICC | Viewer accurate, Output Preview, kiểm overprint |
| `ppe_separations` | Trả các mặt phẳng process/spot và cảnh báo độ tin cậy | Output Preview/TAC; flatten; hậu kiểm outline; fallback nhận diện khuôn |
| `ppe_compose_separation_subset` | Ghép tập kẽm đang bật qua ICC, không raster lại PDF | Output Preview subset/solo |
| `ppe_export_cmyk` | Trả composite CMYK 4 kênh, không vòng qua RGB | Export Image CMYK |
| `ppe_text_outlines` | Trả path glyph và chỉ số khối chữ | Outline Fonts |
| `ppe_capabilities` | Nguồn thật của capability matrix | Facade, test và chốt tương thích native |

Mọi API trên dùng chung lõi `print_engine`: parser nội dung, màu/ICC, ảnh/filter/sampler, shading, transparency/blend, text, optional content, page box và buffer mực. Vì vậy sửa một primitive trong lõi có thể đổi kết quả của nhiều consumer dù entrypoint khác nhau.

## 3. Trace dọc từng luồng ngoài Viewer/Output Preview

### 3.1. Xuất ảnh CMYK

```text
ExportImageModal
  → lib/api.ts: exportImages / exportImagesBatch
  → POST /api/export/images hoặc /images/batch
  → render_pdf_to_images
  → color_mode == "cmyk"
  → _render_cmyk_pages
  → facade.export_cmyk
  → pdfcompare_native.ppe_export_cmyk
  → TIFF/JPEG CMYK + ICC
```

- Chỉ TIFF/JPEG CMYK đi PPE; PNG/WebP CMYK bị từ chối đúng hợp đồng.
- RGB/Gray vẫn dùng PDFium và không bị các thay đổi PPE đổi pixel đầu ra.
- Consumer dừng an toàn nếu PPE trả `ink_unsound` hoặc `degraded`; không giao file thiếu nội dung.
- `include_bleed=true` dùng MediaBox, ngược lại dùng TrimBox.

### 3.2. Làm phẳng trong suốt

```text
Action FLATTEN_TRANSPARENCY
  → ActionEngine._action_flatten_transparency
  → pdf_actions_native.flatten_transparency
  → detect_transparent_pages
  → facade.separations từng trang có transparency
  → ghi ảnh DeviceCMYK vào PDF
```

- Trang không có transparency được giữ cấu trúc, không raster vô ích.
- Trang có transparency mất vector/chữ sống/spot riêng/layer theo chủ đích và phải trả cảnh báo.
- Đây là tác vụ sửa file thật, nên thay đổi ở blend, soft mask, shading, image sampler, optional content hoặc ICC của PPE có thể đổi artifact giao khách.

### 3.3. PDF/X-1a

```text
SavePdfxTool
  → POST /preflight/export-pdfx
  → PdfxExportEngine._export_x1a_native
  → nếu có transparency: flatten_transparency bằng PPE
  → convert/object-level PDF/X
  → PDF 1.3 + OutputIntent
```

- PDF/X-1a **chỉ** phụ thuộc PPE khi có transparency.
- PDF/X-4 đi object-level bằng pikepdf/LittleCMS, không gọi PPE trực tiếp.
- Artifact probe 300 DPI của audit: transparency trước có `alpha hằng < 1`, sau rỗng; PDF `1.3`; compliance `7/7`; cảnh báo mất vector có mặt.

### 3.4. Khóa chữ / Outline Fonts

```text
FontToolsTool
  → POST /preflight/fix, action OUTLINE_FONTS
  → outline_text.outline_fonts
  → PpeGlyphSource.for_page
  → pdfcompare_native.ppe_text_outlines
  → ghi path bằng pikepdf
  → verify_outline
  → _plate_stats trước/sau
  → facade.separations → ppe_separations
```

PPE ảnh hưởng ở hai chốt khác nhau:

1. hình học glyph được dùng để thay chữ;
2. mặt phẳng mực được dùng để quyết định có giao file hay phải từ chối.

Nếu nguồn glyph PPE không khả dụng, code có lane fontTools tương thích; nếu không chứng minh được parity mực, tác vụ phải fail-closed. Đây là consumer ngoài hiển thị nhạy nhất với thay đổi text, matrix, Form XObject, clipping và màu.

### 3.5. Nhận diện khuôn/biên tem dự phòng

```text
ImposerDashboard hoặc Recipe Bình tem
  → POST /imposition/detect-shape
  → detector vector
  → trang còn CUSTOM
  → _raster_fallback_shape
  → SeparationEngine.extract_separations(render_mode="accurate")
  → facade.separations → ppe_separations
  → chỉ lấy mặt phẳng spot
  → OpenCV contour → build_shape_from_raster
```

- Mặc định chỉ thử tối đa `3` trang custom; nếu đã có master vector thì chỉ probe `1` trang.
- PPE không xếp khuôn và không ghi PDF bình; nó chỉ có thể đổi **kết quả nhận diện shape/kích thước đầu vào** của solver.
- Probe trên `CMNM2026 - Giay moi_BLUE - in.pdf` trả source `raster_fallback`, shape `DUMBBELL`, hoàn tất khoảng `1.105 ms`.
- Lô A đã thêm regression thật: PDF có spot `CutContour` hình chữ nhật đi qua
  `_raster_fallback_shape`, PPE, giải nén mặt phẳng mực và OpenCV; kết quả khóa
  `RECTANGLE`, source `raster_fallback`, trim `119,5×59,5 pt` ở 144 DPI.

## 4. Các điều khiển Output Preview mới có rò sang consumer khác không?

### Kết luận: `[DISPROVED]`

Không có bằng chứng chúng làm đổi mặc định của Export CMYK, flatten, outline hoặc detect-shape.

| Điều khiển mới | Mặc định nguồn | Bằng chứng cách ly |
|---|---|---|
| Show | `OutputPreviewFilter::All` | `RenderOptions::default()` dùng `All`; API non-softproof không nhận tham số Show |
| Paper Color | `false` | `SoftProofSettings::default()`; chỉ dùng ở bước CMYK → sRGB |
| Black Ink | `false` | Như trên; không sửa lượng mực đã raster |
| Background Color | `None` | Chỉ hòa nền khi proof ra màn hình |

Facade còn giữ lane tương thích: nếu Show=`all`, Paper/Black=`false`, Background=`None`, nó không gửi keyword mới xuống native. Trên chính PDF khách, softproof mặc định và lời gọi khai tường minh bốn giá trị cũ cho kết quả byte-identical:

- cùng kích thước;
- cùng SHA-256 `baa16ae4daa4180f2d7e39e8c7bf5a84887fd933b764201b5e4459a045457836`;
- `degraded=false`, `ink_unsound=false` ở cả hai lời gọi.

`ppe_export_cmyk`, `ppe_separations` và `ppe_text_outlines` không có các tham số Output Preview, nên không có đường truyền nhầm trạng thái UI vào ba API đó.

## 5. Những tính năng không gọi PPE trực tiếp

| Nhóm tính năng | Kết luận |
|---|---|
| N-up/Step & Repeat/Booklet/CNC/VDP | Solver/writer không gọi PPE; riêng bước detect-shape của Bình tem có fallback PPE như §3.5 |
| Compare/QC | Dùng engine compare riêng; không gọi `print_engine` |
| Khuôn bế 2D/3D/nesting | Dùng TypeScript sidecar, `imposition_core` và WebGL; không gọi PPE |
| Logo Rebuild/vectorizer | Dùng logo engine/VTracer riêng; không gọi PPE |
| In ra máy in | Dùng print worker/PDFium/spooler; không gọi PPE |
| Export RGB/Gray | Dùng PDFium; không gọi PPE |
| PDF/X-4 và Convert Colors thường | Dùng pikepdf + LittleCMS; không gọi PPE trực tiếp |
| Edit object/layer, redact, combine/split | Dùng các engine riêng; không gọi PPE trực tiếp |

Các PDF do các tính năng trên tạo ra vẫn có thể được PPE đọc khi mở lại trong Viewer hoặc Output Preview. Đó là ảnh hưởng ở lớp **consumer hiển thị**, không phải thay đổi file xuất của chính tính năng.

## 6. Rủi ro dùng chung DLL và tài nguyên

### 6.1. DLL/ABI dùng chung — `[EXPECTED]`

`native/src/lib.rs` đăng ký PPE, imposition solver, compare, object/layer, logo và dieline trong cùng module PyO3 `pdfcompare_native`. Hệ quả:

- lỗi import/khởi tạo/thiếu DLL phụ thuộc có thể làm toàn bộ nhóm native mất khả dụng;
- lỗi thuật toán bên trong PPE không tự chạy vào solver khác;
- module hiện tại import thành công; `cargo check` native đạt; 85 smoke test của imposition/compare/dieline/logo/manifest đạt.

### 6.2. Cạnh tranh CPU/RAM — `[SUSPECTED]`, chưa đo runtime đồng thời

- PPE dùng Rayon cho các kernel full-frame và LittleCMS.
- Export Images đi shared heavy scheduler.
- Vector detection và raster classifier có scheduler, nhưng lời gọi PPE nằm giữa hai đoạn này chưa chiếm cùng một heavy slot.
- Flatten, Outline Fonts và PDF/X-1a chạy trong generic thread qua `asyncio.to_thread`, chưa thấy admission chung bao trọn tác vụ PPE.
- Viewer native/Tauri và backend là các process khác nhau nên vẫn có thể cạnh tranh CPU/RAM ở cấp hệ điều hành.

Đây là coupling hiệu năng có thật ở kiến trúc, nhưng audit chưa có số P95/RSS/cancel đồng thời để gọi nó là hồi quy người dùng. Không được thêm hard-cap vô điều kiện; nếu xử lý phải benchmark theo ba tier `<8 GB`, `8–15 GB`, `≥16 GB`.

## 7. Artifact native hiện tại và một bẫy chẩn đoán

Module dev mà backend thực tế nạp:

- đường dẫn: `backend/venv/Lib/site-packages/pdfcompare_native/...pyd`;
- thời gian: `2026-08-10 15:37:57`;
- SHA-256: `A5FCF1BCC4412FA99EDD1EB5EB3A829B1B9520BA21615FC5DDB9C1B68744DA88`;
- có `separation_subset_composite`, 9 `output_preview_filters`, Paper/Black/Background và `/View` optional content.

`native/target/release/pdfcompare_native.pyd` là artifact cũ ngày `2026-08-09`, SHA-256 `3C297F74492C6473557E34D75DB585735729E3575612EC2AF5981BB513C859A5`, thiếu các capability mới. Khi cố tình đưa thư mục này lên đầu `PYTHONPATH`, ba test facade thất bại đúng vì native cũ.

Đây **không phải** module app dev đang dùng và cũng không phải nguồn của production build:

- `run_dev.bat` dùng `maturin develop --release` cài vào venv;
- `build_production.ps1` build wheel mới vào staging riêng rồi chạy full backend QA trên đúng staging đó.

Vì chưa build theo chỉ đạo, audit này không chứng minh installer sắp tới chứa đúng hash/capability. Không dùng raw `native/target/release` để kết luận runtime app.

Lô A đã đổi chốt sớm của `build_production.ps1`: wheel staging phải có đủ 7 symbol
PPE, 12 capability bắt buộc, 9 Show filter và cả cấu hình optional content `print/view`.
Payload lấy trực tiếp từ script chấp nhận native hiện hành và từ chối đúng artifact cũ
ngày 09/08, thay vì chỉ kiểm một cờ `overprint_preview_toggle` như trước.

## 8. Findings và khoảng trống

| ID | Trạng thái | Kết luận |
|---|---|---|
| `§PPE.SCOPE.1` | `[EXPECTED]` | PPE có năm consumer ngoài Viewer/Output Preview; trong đó hai consumer nằm hẳn ngoài họ Preflight. Đây là wiring có chủ đích, không phải rò gọi ngoài ý muốn. |
| `§PPE.SCOPE.2` | `[DISPROVED · AUTO]` | Show/Paper/Black/Background không đổi mặc định các consumer khác; probe PDF khách byte-identical và facade test khóa không hỏi capability/gửi keyword mới ở lời gọi mặc định. |
| `§PPE.SCOPE.3` | `[CONFIRMED → CLOSED · AUTO]` | Đã có regression E2E `detect-shape → PPE → raster classifier`, PDF/X-1a transparency thật và capability gate dương/âm cho native mới/cũ. |
| `§PPE.SCOPE.4` | `[PARTIALLY DISPROVED · BENCH]` | Trên máy 32 GB/16 luồng, Lô B làm P95 tăng tối đa `11,6%` ở tải tương tác và `13,1%` ở tải production; Lô B2 low-policy lặp lại ghi nhận tối đa bảo thủ `17,1%`. Peak RSS toàn đợt tối đa `851,961 MiB`. Không có bằng chứng để serialize/hard-cap PPE trên máy `≥16 GB`; low/medium mới là mô phỏng policy, chưa phải runtime vật lý. |
| `§PPE.SCOPE.5` | `[DISPROVED]` | Không thấy call path nghiệp vụ từ N-up/VDP/Compare/Dieline/Logo/Print vào PPE core. |
| `§PPE.SCOPE.6` | `[EXPECTED]` | Các engine dùng chung `pdfcompare_native`; rủi ro nằm ở ABI/import/package, không phải chia sẻ thuật toán. |
| `§PPE.SCOPE.7` | `[OPEN]` | Chưa có installed/clean-user smoke vì người dùng yêu cầu chưa build. |
| `§PPE.SCOPE.8` | `[FIXED · AUTO + BENCH (32 GB); RUNTIME LOW-TIER OPEN]` | Policy `<8 GB` nay lấy `25%` RAM khả dụng mỗi heavy slot, sàn `256`, trần `640 MiB`; không biết RAM khả dụng thì giữ `384 MiB`. Ca 6/3 GiB cấp 640 và chạy TIFF CMYK 300 DPI; 6/2 → 512, 6/1,5 → 384, 6/0,5 → 256. Hai tier cao không đổi. Test và benchmark policy mô phỏng đạt; vẫn cần máy `<8 GB` vật lý để chốt swap/page fault. |
| `§PPE.SCOPE.9` | `[CONFIRMED · P2/M · BENCH]` | PPE session cancel dừng native thật: P95 drain tối đa `57,644 ms`. Ngược lại, hủy coroutine bọc flatten bằng `asyncio.to_thread` trả caller trong tối đa `0,073 ms` nhưng worker vẫn chạy thêm tới `1.840,251 ms` và tạo xong file hợp lệ. UI Preflight/Outline hiện không có nút cancel nên đây chưa phải hồi quy thao tác người dùng, nhưng contract file-action chưa cooperative và có rủi ro orphan khi task server bị hủy. |

Không có finding correctness/pixel P0/P1 mới. Lô B xác nhận hai finding P2 về
khả dụng low-tier và contract hủy tài nguyên; chưa sửa policy/scheduler trong lô audit.

## 9. Bằng chứng kiểm thử

### Rust/PyO3

- `cargo test --manifest-path print_engine/Cargo.toml`: `645` test được phát hiện; `641 passed`, `4 ignored` benchmark thủ công.
- `cargo check --manifest-path native/Cargo.toml --locked` với Python 3.11 của venv: đạt.

### Backend

- Verify hẹp bốn file hồi quy/release: `105 passed`.
- PPE + Export CMYK + flatten + PDF/X + outline + routing + detect + artifact gate: `297 passed`.
- Consumer dùng chung module native: imposition layout, bin packing, compare, dieline gate, logo gate, manifest: `85 passed`.

### Artifact/probe

- PDF khách `CMNM2026 - Giay moi_BLUE - in.pdf`:
  - phát hiện `5` dấu hiệu transparency;
  - Export CMYK trang 1 @72 DPI: `748×561`, `1.678.512` byte CMYK, `degraded=false`, `ink_unsound=false`;
  - fallback nhận diện khuôn: source `raster_fallback`, shape `DUMBBELL`;
  - mặc định softproof byte-identical với `all/false/false/None` khai tường minh.
- Fixture PDF/X-1a có alpha 0,5 @300 DPI:
  - trước có transparency, sau không còn;
  - PDF 1.3, OutputIntent có mặt;
  - compliance `7/7`;
  - cảnh báo mất vector có mặt.
- Outline Fonts fixture có font nhúng:
  - dùng geometry PPE;
  - xóa text/font sống;
  - hậu kiểm kẽm đạt;
  - nguồn PPE cố tình lệch bị chặn fail-closed.

## 10. Kế hoạch và trạng thái

### Lô A — khóa hồi quy chéo: **đã hoàn thành**

1. Fixture spot `CutContour` chạy trọn detect-shape raster fallback bằng PPE thật.
2. PDF/X-1a gắn ExtGState được dùng thật, bắt buộc raster PPE, sạch transparency và đạt `7/7`.
3. Release gate khóa symbol/capability/filter/optional-content của toàn bộ consumer PPE.
4. Default isolation `all/false/false/None` không hỏi capability và không gửi keyword mới xuống native cũ.

Lô code/test giữ đúng 5 file; lô cập nhật hồ sơ là 2 file riêng. Không thay thuật
toán PPE, không maturin, không build Tauri/installer.

### Lô B — audit hiệu năng đồng thời trước khi sửa scheduler: **đã hoàn thành ở mức BENCH**

Đo riêng và đo chồng các cặp:

- Viewer zoom-stop + Export CMYK;
- Output Preview + flatten;
- Outline Fonts + detect-shape;
- cancel giữa chừng và cleanup session/file.

Thu P50/P95, peak RSS, CPU, thời gian cancel và kết quả artifact trên ba tier RAM. Chỉ sau số đo mới quyết định admission; máy `≥16 GB` không bị hard-cap vô điều kiện.

Quyết định sau benchmark: **không thêm admission/hard-cap mới**. Máy 32 GB giữ chạy
song song; candidate budget 640 MiB cho tier thấp và cooperative cancel của file-action
được tách thành finding riêng.

### Lô B2 — policy low-tier động: **đã áp ở mức AUTO + BENCH (32 GB)**

1. Máy `<8 GB` lấy `25%` RAM khả dụng cho mỗi heavy slot, co trong `256–640 MiB`.
2. Không biết RAM khả dụng thì fail-conservative về `384 MiB`.
3. Máy `8–15 GB` và `≥16 GB` giữ nguyên; không hard-cap máy mạnh.
4. E2E TIFF CMYK 300 DPI khóa cả budget `640 MiB`, kích thước, bốn kênh và ICC.
5. Runtime máy `<8 GB` thật vẫn mở; không dùng benchmark policy trên máy 32 GB để
   tuyên bố đã nghiệm thu áp lực swap.

### Lô C — khi được duyệt build

Build wheel/installer từ đúng source, kiểm capability/hash trong artifact, rồi smoke clean-user cho năm consumer ngoài Viewer/Output Preview.

Theo quy trình audit hai chốt, Lô A, benchmark Lô B và policy Lô B2 đã khép ở mức
tự động/benchmark. Chưa build/installed smoke của Lô C; cooperative cancellation và
runtime low-tier vật lý vẫn là hai cổng riêng.

## 11. Phụ lục nghiệm thu Lô B — benchmark đồng thời

### 11.1. Phương pháp và giới hạn

- Harness tái lập: `backend/benchmarks/benchmark_ppe_concurrency.py`; soundness:
  `backend/tests/test_ppe_concurrency_benchmark.py`.
- Nguồn: trang 1 của `CMNM2026 - Giay moi_BLUE - in.pdf`, SHA-256
  `95F38CF429FE7DD7C6500043CE308FD2E87E80A2290217D428FE0C68C6098184`.
- Native dev thực nạp: SHA-256
  `A5FCF1BCC4412FA99EDD1EB5EB3A829B1B9520BA21615FC5DDB9C1B68744DA88`.
- Mỗi consumer chạy trong process mới; một warm-up + năm mẫu đo. Parent đồng bộ
  barrier, lấy working set cộng theo cùng thời điểm, CPU process và checksum artifact.
- Máy thật: Windows, 32.527,914 MiB RAM, 16 logical CPU. Tier `low`/`medium` dùng
  đúng policy render/session `384/96 MiB` và `1.024/256 MiB`, nhưng vẫn chạy trên
  phần cứng 32 GB; vì vậy chỉ là **policy simulation**, không phải runtime máy 6/12 GB.
- Tier `high` dùng policy `5.120/640 MiB` và là benchmark vật lý trên máy audit.

Raw report:

- `.tmp/ppe-concurrency-benchmark-2026-08-10.json` — tải tương tác, ba tier;
- `.tmp/ppe-concurrency-production-medium-high-2026-08-10.json` — production DPI,
  medium/high;
- `.tmp/ppe-concurrency-production-low-auto-failure-2026-08-10.json` — low policy
  hiện hành fail-loud ở Export 300 DPI;
- `.tmp/ppe-concurrency-production-low-auto-flatten-dpi-2026-08-10.json` — low policy
  tự hạ flatten 300 → 200 DPI;
- `.tmp/ppe-concurrency-production-low640-2026-08-10.json` — A/B candidate 640 MiB,
  chưa phải cấu hình sản phẩm tại thời điểm đo;
- `.tmp/ppe-concurrency-production-low-policy640-after-2026-08-10.json` — toàn bộ
  ba cặp production sau khi policy sản phẩm tự cấp 640 MiB;
- `.tmp/ppe-concurrency-production-low-policy640-viewer-export-recheck-2026-08-10.json`
  — lặp độc lập Viewer + Export để kiểm tra dao động P95.

### 11.2. Tải tương tác — policy hiện hành

| Tier policy | P95 slowdown lớn nhất | Peak RSS P95 lớn nhất | CPU P95 lớn nhất | Kết luận |
|---|---:|---:|---:|---|
| `<8 GB` mô phỏng | `1,100×` | `417,898 MiB` | `1,826 core` | Artifact đúng; chưa suy thành máy thấp vật lý |
| `8–15 GB` mô phỏng | `1,116×` | `417,988 MiB` | `1,944 core` | Artifact đúng; chưa suy thành máy thấp vật lý |
| `≥16 GB` vật lý | `1,047×` | `418,348 MiB` | `2,334 core` | Không cần serialize/hard-cap |

Mọi checksum Viewer/Output Preview/Export và hình học Outline/Detect giống giữa
chạy riêng/chạy chồng; source không đổi và không còn file tạm.

### 11.3. Tải production — Export/Flatten 300 DPI, Output Preview 150 DPI

| Policy | Viewer P95 khi chồng Export | Output Preview P95 khi chồng Flatten | Peak RSS P95 | Kết quả |
|---|---:|---:|---:|---|
| `<8 GB`, policy trước B2 `384 MiB` | Không đo được: Export fail-loud | `1,089×` ở probe; flatten tự dùng `200 DPI` | `617,613 MiB` ở probe | `§PPE.SCOPE.8` xác nhận |
| `<8 GB`, candidate `640 MiB` | `1,125×` | `1,038×` | `850,938 MiB` | 5/5 artifact đúng; chỉ A/B trên máy 32 GB |
| `<8 GB`, policy B2 tự cấp `640 MiB` | `1,027×` | `1,071×` | `849,691 MiB` | 5/5 artifact đúng; source/cleanup sạch |
| `8–15 GB`, `1.024 MiB` | `1,131×` | `1,087×` | `847,602 MiB` | 5/5 đúng; policy simulation |
| `≥16 GB`, `5.120 MiB` | `1,104×` | `1,060×` | `851,961 MiB` | 5/5 đúng; giữ full concurrency |

Export CMYK 300 DPI trên low policy trước B2 dừng an toàn, không phát file sai. `384 MiB`
vấp chốt cần khoảng `453 MiB`; `512 MiB` đi xa hơn nhưng vấp chốt `632 MiB`;
`640 MiB` là mức đầu tiên probe chạy qua. Không nâng ceiling chỉ dựa trên máy 32 GB:
cần đo tổng RSS app + sidecar, swap/page fault và cancel trên máy `<8 GB` thật.

Sau khi áp policy B2, lượt toàn bộ ba cặp có slowdown lớn nhất `1,170×` ở Export;
lượt lặp Viewer + Export có slowdown lớn nhất `1,171×` ở Viewer, peak RSS
`756,129 MiB`. Sự chậm phân bố đổi phía giữa hai lượt, nhưng checksum artifact chỉ
có một giá trị, native/source giống nhau, source không đổi và cleanup đều đạt. Báo
cáo vì vậy giữ số bảo thủ `17,1%`, không chỉ lấy lượt A/B đầu có số đẹp hơn.

### 11.4. Cancel và cleanup

| Đường hủy | Ack P95 lớn nhất | Worker drain P95 lớn nhất | Kết quả |
|---|---:|---:|---|
| `PpeRenderSession.cancel` | `0,043 ms` | `57,644 ms` | 15/15 render bị chặn bằng `PpeRequestSuperseded`; session đóng sạch |
| Hủy coroutine `to_thread(flatten)` | `0,073 ms` | `1.840,251 ms` | 15/15 worker tiếp tục và tạo file hợp lệ; harness xóa sạch sau drain |

### 11.5. Quyết định kiến trúc

1. Không bọc mọi PPE consumer vào một semaphore chung: số đo high-tier không chứng
   minh oversubscription nghiêm trọng, còn serialize sẽ làm mất overlap có ích.
2. Không hard-cap máy `≥16 GB`; giữ full concurrency và session policy hiện hành.
3. Lô B chưa nhập candidate `640 MiB`; sau khi người dùng duyệt Lô B2, production
   chỉ đạt 640 khi máy `<8 GB` còn đủ RAM khả dụng và tự co về 512/384/256 khi áp lực
   tăng. Runtime máy `<8 GB` thật vẫn là cổng nghiệm thu còn mở.
4. File-action cần cancellation token xuyên `ActionEngine → flatten/outline → PPE`,
   đồng thời rollback output trong worker. Chỉ hủy `asyncio.Task` không phải hủy việc.

### 11.6. Bằng chứng Lô B2

- Baseline test mới trước implementation: `4 failed, 20 passed`, đúng tại policy
  production còn trả 384 thay vì 640 MiB.
- Sau sửa: test tập trung `24 passed`; backend hồi quy liên quan `268 passed`;
  `py_compile` và `git diff --check` đạt.
- TIFF tổng hợp khổ `748×561 pt` ở 300 DPI xuất `3117×2338`, mode CMYK và có ICC.
- Không build, không maturin và không tạo installer theo chỉ đạo.
