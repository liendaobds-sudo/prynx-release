# Performance Audit

**Ngày audit:** 2026-07-22  
**Phạm vi mã nguồn:** Working tree hiện tại tại thời điểm audit  
**Loại audit:** Phân tích tĩnh, build và quality gates  
**Đánh giá tổng thể định tính:** 6/10

## 1. Phạm vi

Audit này đánh giá hiệu năng tổng thể của ứng dụng PDF Compare ngoài phần thumbnail và runtime xem trang PDF.

Các thành phần được loại khỏi kết luận:

- `ThumbSidebar` và toàn bộ luồng tạo/tải thumbnail.
- `AcrobatViewer` và `LivePageFrame` trong vai trò trình xem trang.
- Tile rendering, prefetch, virtualization và overscan của viewer.
- PDFium cache/render chỉ phục vụ viewer.
- Luồng tải metadata chỉ phục vụ page view.

Preview bố trí N-Up/Imposition vẫn thuộc phạm vi vì đây là luồng xử lý sản xuất, không phải trình xem trang PDF.

Chi phí tải chunk viewer chỉ được đề cập khi nó ảnh hưởng đến khởi động toàn ứng dụng; nội bộ viewer không được đánh giá.

## 2. Kết luận điều hành

Phần mềm có nền tảng khá mạnh: Tauri, backend Python riêng, multiprocessing, worker, cache, lazy tool loading và nhiều cơ chế hủy tác vụ. Tuy nhiên, chưa thể gọi là mạnh mẽ, mượt mà và tối tân nhất khi chưa có benchmark Tauri/WebView2, lifecycle tab và scheduler tài nguyên toàn cục.

| Khía cạnh | Đánh giá |
|---|---|
| Tác vụ thông thường, chạy một job | Khá tốt |
| Khởi động và cảm giác sẵn sàng | Trung bình |
| File lớn, 10.000-50.000 trang | Đã giảm rủi ro fan-out/chunk RAM; peak RSS chưa đo |
| VDP 100.000 dòng | Có cap + CSV transport; nguồn khác và RSS chưa đủ kiểm chứng |
| Nhiều job hoặc tab đồng thời | Đã bounded một số nhóm; chưa có scheduler toàn cục |
| Khả năng chống treo UI | Tốt hơn ở PDF/Compare; lifecycle tab và benchmark còn thiếu |
| Chất lượng build | Build/test xanh; lint repo vẫn còn lỗi legacy |

Điểm số và nhận định trên dựa trên kiến trúc cùng mã nguồn, không phải số đo FPS, RAM hoặc latency thực tế.

## 3. Phát hiện ưu tiên cao

### P0 - Khởi động bị chậm có chủ ý, nhưng thời gian chờ không được tận dụng

Ứng dụng giữ splash tối thiểu **3 giây** tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L145). Trong thời gian này `AppInner` chưa được mount theo điều kiện render tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L181).

Warm-up các chunk lớn hiện được khởi động từ `App()` trong lúc splash còn hiển thị, thông qua [`warmupWorkspaceChunks`](../../desktop/src/lib/pdfWarmup.ts#L25); `AppInner` và toàn bộ tab tree vẫn chưa mount trong giai đoạn này. Vì vậy điểm nghẽn “đợi xong splash mới warm-up” đã được xử lý ở đợt 1.

Phần còn lại cần đo:

- Người dùng vẫn có thể phải chờ splash tối thiểu 3 giây vì `SPLASH_MIN_MS` chưa được hiệu chỉnh theo thời điểm shell interactive.
- `scheduleWarmupPdfjs` vẫn dùng idle callback/fallback timeout; nếu trace cho thấy long task, cần chia thành các idle slice nhỏ hơn.
- Dù viewer bị loại khỏi audit, mọi preload ảnh hưởng đến entry startup vẫn cần được đo riêng thay vì suy đoán từ thời gian build.

Khuyến nghị còn lại: đo cold launch/shell interactive trong Tauri/WebView2 rồi mới quyết định giảm `SPLASH_MIN_MS`; không dùng thời gian build làm proxy cho startup người dùng.

### P0 - N-Up có thể tạo quá nhiều process và làm cạn RAM

Baseline của audit phát hiện mỗi job Imposition có thể fan-out process/worker theo CPU và giữ chunk bytes trong RAM. Đợt triển khai 1 đã giảm rủi ro chính: route có bounded executor/hàng đợi (`PRYNX_MAX_NUP_JOBS`, `PRYNX_MAX_NUP_QUEUE`, `PRYNX_NUP_WORKERS`), worker ghi chunk ra file tạm, tiến trình ghép đọc từng file và dọn cleanup khi hoàn tất/lỗi/hủy.

Rủi ro còn lại là output cuối và thư viện PDF vẫn có thể cần nhiều RAM khi ghép hàng chục nghìn trang; chưa có số đo peak RSS. Cancellation và scheduler dùng chung theo RAM/CPU cũng chưa hoàn tất.

Khuyến nghị còn lại: benchmark workload 10.000–50.000 trang, ghi peak RSS/temp-disk/process count, sau đó mới quyết định tối ưu sâu hơn cho bước ghi PDF cuối.
### P0 - VDP khuếch đại bộ nhớ và thiếu giới hạn job đồng thời

Baseline có nhiều bản sao dataset (mảng UI, chuỗi JSON, Blob, byte backend, danh sách Python và dữ liệu worker). Đợt triển khai 1 đã tách **CSV single-up (generate)** khỏi đường JSON: frontend gửi file multipart, backend parse bằng `TextIOWrapper` trong threadpool (`_parse_csv_upload` trong `vdp.py`), áp trần 256 MiB/100.000 dòng và dùng bounded semaphore/hàng đợi VDP. Lưu ý: **multi-up CSV và preview vẫn `JSON.stringify` toàn bộ rows**, chưa thoát đường JSON.

Giới hạn còn lại: `resolveFullSourceData()` vẫn đọc toàn bộ nguồn để xác thực/hiển thị; XLSX/Google Sheets/manual/multi-up chưa có contract file/path/token thống nhất; engine cuối vẫn cần danh sách bản ghi để render. Vì vậy 100.000 dòng chưa thể coi là an toàn tuyệt đối nếu chưa benchmark RSS và thời gian xử lý.

Khuyến nghị còn lại: chuyển các nguồn không phải CSV sang file/path/token hoặc stream chunk, giữ preview nhỏ trên UI, bổ sung cancellation và benchmark 10k/50k/100k dòng.
### P0 - Nhiều API async vẫn chặn toàn bộ event loop

Baseline có nhiều route `async def` gọi trực tiếp hàm đồng bộ. Đợt triển khai 1 đã chuyển các thao tác PDF đã audit trong `pdf_tools` (merge, split, resize, trim-shift, shuffle, OCR, optimize hậu xử lý, encrypt/decrypt, metadata và watermark) qua `run_in_threadpool`; Compare/Imposition cũng dùng executor giới hạn ở các luồng nặng đã rà soát.

Phần còn lại cần benchmark status/health latency khi job nặng và rà soát các route ngoài nhóm audit. Không nên kết luận event loop đã hoàn toàn không bị chặn chỉ từ việc build/test xanh.
### P0/P1 - Combine xử lý PDF nặng trên luồng giao diện

Job Combine nhỏ vẫn dùng `pdf-lib` trên frontend để giữ phản hồi nhanh và không cần upload. Với job lớn (từ 64 MiB hoặc ước tính 800 trang), `CombineTab` chuyển sang backend; manifest mới hỗ trợ chọn trang, trang trắng và xoay, còn nguồn PDF được mở một lần rồi ghép bằng pikepdf. Nhờ vậy dữ liệu lớn không còn phải parse/copy toàn bộ trong WebView.

Ngưỡng và đường backend chưa có tiến trình/cancel cho job rất dài; workflow chia nhóm tạo nhiều output vẫn chạy frontend. Cần benchmark trước/sau để điều chỉnh ngưỡng, không dùng thời gian build làm đại diện cho độ mượt.
## 4. Phát hiện P1

### Tất cả tab đều được giữ sống

Ứng dụng chủ động render tất cả tab và chỉ ẩn tab không hoạt động tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L1177).

Điều này bảo toàn trạng thái tốt nhưng cũng giữ:

- Component tree.
- PDF/document object.
- Timer và polling.
- Cache.
- Texture/WebGL.
- Job subscription.

Khuyến nghị: dùng lifecycle ba trạng thái `active`, `paused`, `serialized`. Tab ẩn vẫn giữ cài đặt nhưng phải dừng timer, subscription và giải phóng tài nguyên nặng.

### Polling Compare có thể tồn tại sau khi đóng tab

Compare dùng `setInterval(async ...)` tại [`desktop/src/components/CompareTab.tsx`](../../desktop/src/components/CompareTab.tsx#L183). Request có thể chồng lên nhau nếu một lần poll lâu hơn chu kỳ, và lifecycle hiện tại khiến timer có thể tiếp tục chạy khi tab bị ẩn.

Backend Compare tạo một thread cho mỗi job rồi để thread chờ semaphore tại [`backend/app/api/routes/compare.py`](../../backend/app/api/routes/compare.py#L148). Nhiều job chờ vẫn tạo nhiều OS thread. Lưu ý: nhánh thread-per-job này **chỉ chạy ở `DEV_MODE` hoặc `IS_DESKTOP_APP`**; bản production dùng Celery (cùng file, ~L157). Vì đây là ứng dụng desktop nên nhánh thread là đường chạy thực tế của người dùng cuối — nhận định vẫn đứng vững, nhưng phần server-hosted không bị ảnh hưởng.

Khuyến nghị: dùng hàng đợi với số worker cố định; polling bằng recursive timeout chỉ chạy lần kế tiếp sau khi request hiện tại hoàn thành; hủy polling qua `AbortController` khi job hoặc tab kết thúc.

### Persist Imposition ghi đồng bộ quá thường xuyên

Mỗi tab tạo một store persist riêng tại [`desktop/src/components/imposition-tools/useImposerSettingsStore.ts`](../../desktop/src/components/imposition-tools/useImposerSettingsStore.ts#L43), nhưng tất cả dùng chung khóa `ps_imposer_settings` tại [`desktop/src/components/imposition-tools/store/persist.ts`](../../desktop/src/components/imposition-tools/store/persist.ts#L113).

`localStorage` là đồng bộ. Thay đổi nhanh có thể liên tục serialize và ghi trên main thread. Nhiều tab còn cạnh tranh cùng một khóa, khiến tab ghi cuối thắng.

Khuyến nghị: debounce ghi; bỏ trường transient khỏi persist; dùng một store preference cấp ứng dụng hoặc khóa riêng theo workspace.

### Cache key tạo bằng `JSON.stringify` mảng lớn trên mỗi render

Imposition tạo cache key từ page order, rotation, instance ID và dimensions tại [`desktop/src/components/imposition-tools/ImposerDashboard.tsx`](../../desktop/src/components/imposition-tools/ImposerDashboard.tsx#L1505).

Khi số lượng phần tử lớn, mỗi render phải duyệt dữ liệu, cấp phát chuỗi mới và tăng garbage collection.

Khuyến nghị: thay bằng revision counter hoặc hash được memo hóa khi dữ liệu nguồn thực sự thay đổi.

### Preview layout chưa có hard cap

Baseline phát hiện `PreviewLayoutRequest` thiếu giới hạn rõ ràng. Đợt triển khai 1 đã thêm `Field` constraints và chặn tổng cell/page map trước khi compute; request vượt ngưỡng bị từ chối sớm.

Ngưỡng hiện là guard an toàn ban đầu, chưa được hiệu chỉnh bằng workload sản xuất. Cần benchmark để cân bằng độ linh hoạt và thời gian xử lý.
### Upload và ZIP dùng quá nhiều RAM

Baseline `save_upload` đọc toàn bộ file và split ZIP dựng `BytesIO`. Đợt triển khai 1 đã chuyển upload sang helper streaming có giới hạn dung lượng; split ghi ZIP ra file tạm, trả `FileResponse` và cleanup sau response. CSV VDP cũng đi qua file multipart.

Cần rà soát các route upload ngoài `pdf_tools` và các nguồn XLSX/Google Sheets còn có thể đọc nguyên file; đây là hạng mục transport còn lại, không phải lỗi của đường split ZIP đã sửa.
## 5. Bundle và frontend

Production build hiện đạt bundle budget mới đặt cho entry chunk: `index` khoảng **1.148 MB raw**, dưới ngưỡng **1,5 MB**. Các nhóm vendor lớn đã tách riêng (`vendor-react` khoảng 190 kB, `vendor-pdf` khoảng 927 kB, `vendor-three` khoảng 1.020 MB); Vite vẫn cảnh báo chunk >500 kB và một số dynamic import kém hiệu quả.

Dieline 3D vẫn dùng `frameloop=demand` và giới hạn DPR. `preserveDrawingBuffer` đã tắt; export dùng `WebGLRenderTarget`/readback riêng nên không giữ chi phí GPU thường trực cho canvas hiển thị.

Phần còn lại: loại bỏ các dynamic import vừa tĩnh vừa động khi có lợi ích thật, đo startup theo tool, và đưa bundle budget vào CI thay vì chỉ kiểm tra thủ công trong build local.
## 6. Những điểm đang làm tốt

- Tool registry có lazy import, giảm chi phí tải ban đầu.
- Imposition store dùng selector và `useShallow`, hạn chế render thừa.
- Grid preview có debounce, `AbortController`, generation guard và layout cache.
- Compare có giới hạn 50 trang và giới hạn tổng pixel render.
- Sticker engine có giới hạn worker theo RAM/CPU và giới hạn kích thước render.
- Cleanup chạy nền và đẩy filesystem work ra khỏi event loop.
- Dieline dùng render theo nhu cầu và có dispose texture.
- TypeScript build và Rust compile đều thành công.

Đây là nền móng tốt. Điểm yếu chính nằm ở orchestration, giới hạn tài nguyên và đường đi dữ liệu lớn.

## 7. Kết quả kiểm tra

### Build frontend

`npm run build`: **Đạt**.

- TypeScript, Vite build và entry bundle budget đều thành công.
- Entry chunk khoảng 1.148 MB raw; Vite vẫn cảnh báo một số chunk lớn hơn 500 kB và dynamic import kém hiệu quả.
- Không dùng thời gian toàn command làm benchmark sản phẩm vì còn bao gồm typecheck và điều kiện máy audit.

### Native

`cargo check`: **Đạt**, còn 12 warning có sẵn.

### Test frontend

- **110/110 test files đạt**.
- **955 tests đạt, 2 skipped**.
- Render wiring, Combine delegation/manifest path, persist/migration và các snapshot liên quan đều đã được chạy lại.

### Backend gates

- `py_compile` cho các file đã sửa: đạt.
- Test CSV transport: **3/3 đạt**.
- Test PDF manifest: **2/2 đạt**.
- Bộ test backend mục tiêu đã chạy ở đợt trước: **121/121 đạt**; nhóm VDP integration vẫn cần PostgreSQL localhost:5432.
### Lint

`npm run lint`: **Không đạt**.

- 1.549 errors.
- 112 warnings.
- Tổng cộng 1.661 vấn đề.
- Đợt xử lý hiện tại đã áp dụng safe autofix, dọn unused vars ở các module ưu tiên, chuẩn hóa API boundary và sửa một nhóm React Hook dependencies ngoài viewer/thumbnail.

### Giới hạn kiểm chứng

- Backend Python tests mục tiêu đã chạy; chỉ nhóm VDP integration còn phụ thuộc PostgreSQL localhost:5432.
- Chưa chạy benchmark Tauri/WebView2 end-to-end.
- Chưa đo P50/P95 launch, FPS, long task, RSS, peak commit hoặc latency API thực tế.
- Chưa xác định bằng thực nghiệm ngưỡng file cụ thể gây OOM.

## 8. Thứ tự xử lý đề xuất

### Giai đoạn P0

1. Sửa lifecycle splash và warm-up.
2. Xây một job manager toàn cục cho N-Up, VDP và tác vụ PDF nặng.
3. Chuyển N-Up chunk từ RAM sang file tạm và merge tăng dần.
4. Loại xử lý đồng bộ khỏi FastAPI event loop.
5. Chuyển Combine file lớn ra khỏi WebView.
6. Streaming upload, download và ZIP; đặt giới hạn payload.
7. Worker hoặc streaming cho CSV/VDP; không gửi toàn bộ dữ liệu qua JSON.

### Giai đoạn P1

8. Lifecycle pause/dispose cho tab ẩn.
9. Debounce persist và sửa xung đột khóa store.
10. Bỏ `JSON.stringify` lớn trong render.
11. Đặt hard cap cho preview layout.
12. Thay thread chờ của Compare bằng bounded worker queue.
13. Bỏ `preserveDrawingBuffer` thường trực trong Dieline.

### Giai đoạn P2

14. Tối ưu bundle và bổ sung performance budget trong CI.
15. Sửa test, snapshot và lint về trạng thái xanh.
16. Bổ sung benchmark regression cho các workload lớn.

## 9. Ma trận benchmark cần thực hiện

| Kịch bản | Quy mô tối thiểu |
|---|---|
| Cold launch | Từ mở ứng dụng đến Home có thể tương tác |
| Tab lifecycle | 1, 5 và 10 tab |
| Combine | Nhiều PDF lớn và tổng hàng nghìn trang |
| N-Up | 100, 1.000, 10.000 và 50.000 trang output |
| VDP | 1.000, 10.000 và 100.000 dòng |
| Compare | Tối đa 50 trang ở cấu hình DPI cao nhất được hỗ trợ |
| Dieline 3D | Thiết kế phức tạp và export ảnh độ phân giải cao |
| Đồng thời | 1, 2 và nhiều job nặng chạy song song |

Các chỉ số cần ghi nhận:

- Thời gian cold launch đến lúc có thể thao tác.
- Main-thread long tasks của WebView.
- P50/P95 latency của status API khi job nặng đang chạy.
- RSS từng process và tổng peak RAM.
- Số process/threads theo số job.
- Dung lượng và tốc độ tăng của thư mục tạm.
- Thời gian hủy job.
- Mức RAM còn lại sau khi đóng tab hoặc hoàn thành job.

## 10. Kết luận cuối

Ứng dụng có kiến trúc và nhiều thành phần đủ tốt để xử lý workload thông thường. Tuy nhiên, các đường đi dữ liệu lớn hiện vẫn phụ thuộc nhiều vào việc giữ toàn bộ dữ liệu trong RAM, tạo worker/process theo từng job và thực hiện một số công việc CPU trên luồng giao diện hoặc FastAPI event loop.

Vì vậy, ngoài viewer và thumbnail, phần mềm hiện được đánh giá là **khá mạnh ở tải thông thường nhưng chưa an toàn và chưa đạt mức tối tân khi chạy tải lớn hoặc nhiều job đồng thời**.

Ưu tiên cao nhất không phải là micro-optimization giao diện, mà là giới hạn concurrency, streaming dữ liệu, bounded queues, lifecycle tài nguyên và phép đo hiệu năng có thể lặp lại.

## 11. Kế hoạch xử lý chi tiết

Phụ lục này mở rộng mục 8 (thứ tự xử lý). Mỗi hạng mục có: mục tiêu, điểm chạm code, cách làm, tiêu chí hoàn thành (DoD), rủi ro. Ước lượng công sức theo thang S (dưới nửa ngày), M (một đến hai ngày), L (trên hai ngày).

Nguyên tắc chung trước khi bắt tay:
- Mỗi hạng mục làm trên nhánh riêng, có test kèm theo, chạy `npm run build` + `cargo check` + backend pytest trước khi gộp.
- Ưu tiên thay đổi có thể đảo ngược và đo được. Với mỗi hạng mục P0, ghi lại số đo trước/sau (RAM, thời gian, số process) để chứng minh hiệu quả — audit này là phân tích tĩnh, nên phần thực thi phải bổ sung số thật.
- Không gộp nhiều hạng mục vào một commit lớn; lịch sử tách bạch theo từng phát hiện.

### Giai đoạn P0
#### P0-0. Baseline và instrumentation — công sức S

- **Mục tiêu:** có số đo trước/sau để xác minh các thay đổi, thay vì chỉ dựa trên cảm giác "mượt" hoặc phân tích tĩnh.
- **Điểm chạm:** startup trong [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L145) và [`desktop/src/lib/pdfWarmup.ts`](../../desktop/src/lib/pdfWarmup.ts#L25); lifecycle/job status ở các route backend; logging hiện có của preview.
- **Cách làm:** thêm `performance.mark/measure` cho cold launch, shell interactive, Home interactive và first tool open; ghi số process, peak RSS, temp-disk usage, cancel latency và P95 status latency cho job nặng; bật/tắt bằng cờ debug để không tạo overhead production.
- **DoD:** có một báo cáo baseline lặp lại được cho các workload mục 9; mọi hạng mục P0 có số đo trước/sau; không dùng thời gian command build làm proxy cho startup người dùng.
- **Rủi ro:** instrumentation có thể làm nhiễu benchmark nếu ghi đồng bộ; dùng buffer/in-memory và flush theo batch.

#### P0-1. Sửa lifecycle splash và warm-up — công sức S

- **Mục tiêu:** bỏ thời gian chờ cứng không tận dụng; mount shell sớm và warm-up chunk trong lúc splash hiển thị, không phải sau đó.
- **Điểm chạm:** `SPLASH_MIN_MS` tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L145); điều kiện render `AppInner` tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L181); `scheduleWarmupPdfjs` / `warmupWorkspaceChunks` tại [`desktop/src/lib/pdfWarmup.ts`](../../desktop/src/lib/pdfWarmup.ts#L25).
- **Cách làm:** mount một shell/provider tối thiểu dưới splash thay vì mount toàn bộ `AppInner` và toàn bộ tab tree; preload bằng `import()` nhưng không render component; chạy warm-up theo idle slice với giới hạn; giảm `SPLASH_MIN_MS` hoặc đổi thành "ẩn splash khi shell interactive" thay vì đếm giờ cố định.
- **DoD:** đo thời điểm shell có thể tương tác (không chỉ lúc splash biến mất); không còn khựng khi Home xuất hiện; warm-up hoàn tất trước hoặc ngay khi splash tắt.
- **Rủi ro:** mount sớm có thể gây layout thrash nếu shell phụ thuộc dữ liệu chưa sẵn; cần giữ splash che cho tới khi first paint ổn định.

#### P0-2. Job manager toàn cục cho N-Up, VDP và tác vụ PDF nặng — công sức L

- **Mục tiêu:** một điểm điều phối duy nhất giới hạn số job nặng chạy đồng thời theo RAM/CPU, có hàng đợi và cancellation.
- **Điểm chạm:** tạo process N-Up tại [`backend/app/api/routes/imposition.py`](../../backend/app/api/routes/imposition.py#L1135); `BackgroundTasks` VDP tại [`backend/app/api/routes/vdp.py`](../../backend/app/api/routes/vdp.py#L188); thread-per-job Compare (DEV/Desktop) tại [`backend/app/api/routes/compare.py`](../../backend/app/api/routes/compare.py#L148).
- **Cách làm:** xây một scheduler cấp ứng dụng với hàng đợi bounded, nhưng tách pool cho background jobs dài (N-Up/VDP/OCR lớn), request-bound operations và process workers; áp dụng budget theo RAM/CPU thay vì một semaphore duy nhất; expose trạng thái queued/running qua API status; hỗ trợ hủy job đang chờ lẫn đang chạy; tránh lồng threadpool → process pool không có giới hạn.
- **DoD:** chạy đồng thời nhiều job N-Up/VDP không vượt trần process/RAM đặt trước; job thứ N+1 xếp hàng thay vì tạo process ngay; hủy job hoạt động ở cả trạng thái chờ.
- **Rủi ro:** thay đổi luồng job có thể phá cơ chế polling/status hiện tại; cần giữ tương thích API status mà frontend đang dùng. Là nền cho P0-3 và P1-12 nên làm trước.

#### P0-3. N-Up chunk từ RAM sang file tạm, merge tăng dần — công sức M

- **Mục tiêu:** không giữ toàn bộ chunk bytes + tài liệu ghép + output trong RAM cùng lúc.
- **Điểm chạm:** worker trả `buf.getvalue()` (bytes) tại [`backend/app/workers/nup_process_chunk.py`](../../backend/app/workers/nup_process_chunk.py#L1318); cha gom `list(pool.map(...))` tại [`backend/app/workers/nup_engine.py`](../../backend/app/workers/nup_engine.py#L3047).
- **Cách làm:** worker ghi chunk ra file tạm và trả đường dẫn (giống VDP đang làm); cha merge tăng dần từng file rồi xóa ngay sau khi ghép; dùng chung khu vực temp có cleanup.
- **DoD:** đo peak RAM khi xuất output hàng chục nghìn trang giảm rõ so với trước; thư mục temp được dọn sau khi job xong hoặc bị hủy.
- **Rủi ro:** I/O đĩa tăng có thể làm chậm job nhỏ — cân nhắc giữ đường RAM cho job dưới một ngưỡng trang. Phụ thuộc P0-2 để có cleanup/cancellation nhất quán.

#### P0-4. Loại xử lý đồng bộ khỏi FastAPI event loop — công sức M

- **Mục tiêu:** route CPU/I-O nặng không chặn event loop (polling, cancel, health check vẫn phản hồi).
- **Điểm chạm:** các `async def` gọi thẳng hàm đồng bộ trong [`backend/app/api/routes/pdf_tools.py`](../../backend/app/api/routes/pdf_tools.py#L209) — merge (209), split (250), trim_shift (354), shuffle (408), ocr (452), encrypt (672), decrypt (717), metadata (769). (Các route optimize/office_convert/remove_background/upscale đã dùng threadpool — dùng làm mẫu.)
- **Cách làm:** đổi các route đồng bộ thành `def` (FastAPI tự đưa vào threadpool) hoặc bọc `run_in_threadpool`/`asyncio.to_thread`; áp semaphore chung cho tác vụ nặng (dùng job manager P0-2).
- **DoD:** trong lúc một job nặng chạy, endpoint status/health vẫn trả nhanh; không còn route nặng nào là `async def` gọi hàm blocking trực tiếp.
- **Rủi ro:** đổi `async def`→`def` thay đổi ngữ cảnh thực thi; kiểm mọi phụ thuộc request-scope (db session, dependency) vẫn hoạt động trong threadpool.

#### P0-5. Chuyển Combine file lớn ra khỏi WebView — công sức M

- **Mục tiêu:** file/job lớn không làm đóng băng WebView do pdf-lib chạy CPU trên main thread.
- **Điểm chạm:** `PDFDocument.load/copyPages/save` tại [`desktop/src/components/CombineTab.tsx`](../../desktop/src/components/CombineTab.tsx#L472) và luồng combine tùy chỉnh (584).
- **Cách làm:** đặt ngưỡng theo tổng size/số trang; dưới ngưỡng giữ xử lý frontend, trên ngưỡng bắt buộc gọi sidecar/backend merge; hiển thị tiến trình cho job lớn.
- **DoD:** combine nhiều PDF lớn không đóng băng UI; job lớn chạy qua backend, job nhỏ vẫn nhanh trên frontend.
- **Rủi ro:** trùng lặp logic merge frontend/backend — cân nhắc để backend là đường chính, frontend chỉ giữ cho job nhỏ.

#### P0-6. Streaming upload, download, ZIP và giới hạn payload — công sức M

- **Mục tiêu:** không nạp toàn bộ upload/ZIP vào RAM; chặn payload quá lớn trước khi xử lý.
- **Điểm chạm:** `save_upload` dùng `await file.read()` tại [`backend/app/api/routes/pdf_tools.py`](../../backend/app/api/routes/pdf_tools.py#L179); ZIP dựng trong `BytesIO` rồi `getvalue()` tại [`backend/app/api/routes/pdf_tools.py`](../../backend/app/api/routes/pdf_tools.py#L269).
- **Cách làm:** upload theo chunk (dùng helper streaming đã có trong project); tạo ZIP trong file tạm rồi trả bằng `FileResponse`/streaming; đặt giới hạn dung lượng theo byte; dọn file tạm bằng background cleanup.
- **DoD:** upload/split file lớn không tăng RAM theo kích thước file; request vượt giới hạn payload bị từ chối sớm với mã lỗi rõ ràng.
- **Rủi ro:** đổi sang FileResponse cần đảm bảo file tạm tồn tại tới khi client tải xong rồi mới xóa.

#### P0-7. Worker/streaming cho CSV/VDP; không gửi toàn bộ dữ liệu qua JSON — công sức L

- **Mục tiêu:** giảm số bản sao của bộ dữ liệu VDP; parse ngoài luồng UI; giới hạn payload và job đồng thời.
- **Điểm chạm:** parse CSV trên UI tại [`desktop/src/components/preprocess-tools/DataMergeTool.tsx`](../../desktop/src/components/preprocess-tools/DataMergeTool.tsx#L861); `JSON.stringify` toàn bộ tại [`desktop/src/lib/api.ts`](../../desktop/src/lib/api.ts#L401); giới hạn `MAX_VDP_ROWS` không kèm giới hạn byte tại [`backend/app/api/routes/vdp.py`](../../backend/app/api/routes/vdp.py#L188); fan-out tại [`backend/app/workers/vdp_engine.py`](../../backend/app/workers/vdp_engine.py#L1065). Lưu ý: worker VDP đã ghi chunk ra file (`chunk_paths`), không giữ bytes trong RAM — điểm cần sửa nằm ở phía frontend→transport và giới hạn job.
- **Cách làm:** parse CSV bằng web worker hoặc stream nhưng không giữ toàn bộ rows trong callback; frontend chỉ giữ dữ liệu preview, gửi file nguồn/path/token để backend đọc trực tiếp theo chunk thay vì JSON hóa toàn bộ; đặt giới hạn payload theo byte; dùng job manager (P0-2) giới hạn số job VDP đồng thời.
- **DoD:** parse CSV lớn không đóng băng UI; payload gửi backend không phải là một chuỗi JSON chứa toàn bộ dòng; nhiều job VDP bị giới hạn đồng thời.
- **Rủi ro:** đổi định dạng transport ảnh hưởng hợp đồng API VDP hiện tại; cần cập nhật cả hai phía đồng bộ.

### Giai đoạn P1

#### P1-8. Lifecycle pause/dispose cho tab ẩn — công sức L

- **Mục tiêu:** tab ẩn giữ trạng thái nhưng dừng timer/subscription và giải phóng tài nguyên nặng.
- **Điểm chạm:** render mọi tab, ẩn bằng opacity/pointer-events tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L1177).
- **Cách làm:** vòng đời ba trạng thái `active`/`paused`/`serialized`; tab ẩn dừng polling/timer, hủy subscription, giải phóng document/texture nặng; giữ lại settings để khôi phục khi active lại.
- **DoD:** mở nhiều tab rồi để ẩn → RAM và số timer/subscription giảm; chuyển lại tab khôi phục đúng trạng thái.
- **Rủi ro:** dispose quá tay làm mất trạng thái đang soạn — phải phân biệt rõ "giải phóng được" và "phải giữ".

#### P1-9. Debounce persist và sửa xung đột khóa store — công sức S

- **Mục tiêu:** không serialize/ghi localStorage đồng bộ liên tục trên main thread; tránh các tab ghi đè nhau.
- **Điểm chạm:** store factory per-tab tại [`desktop/src/components/imposition-tools/useImposerSettingsStore.ts`](../../desktop/src/components/imposition-tools/useImposerSettingsStore.ts#L43); khóa chung `ps_imposer_settings` tại [`desktop/src/components/imposition-tools/store/persist.ts`](../../desktop/src/components/imposition-tools/store/persist.ts#L113).
- **Cách làm:** debounce ghi persist; loại field transient khỏi persist; dùng khóa riêng theo workspace/tab hoặc một store preference cấp ứng dụng.
- **DoD:** thay đổi settings nhanh không gây ghi localStorage mỗi lần; nhiều tab không ghi đè settings của nhau.
- **Rủi ro:** đổi khóa persist cần migration để không mất settings người dùng đang lưu ở khóa cũ.

#### P1-10. Bỏ `JSON.stringify` mảng lớn trong render — công sức S

- **Mục tiêu:** không cấp phát chuỗi lớn mỗi lần render khi dữ liệu không đổi.
- **Điểm chạm:** `previewSourceKey={JSON.stringify({...})}` trong thân JSX tại [`desktop/src/components/imposition-tools/ImposerDashboard.tsx`](../../desktop/src/components/imposition-tools/ImposerDashboard.tsx#L1505).
- **Cách làm:** thay bằng revision counter tăng khi dữ liệu nguồn thực sự đổi, hoặc hash được memo hóa (`useMemo` theo dependency thật).
- **DoD:** render lặp không còn stringify mảng lớn; cache key vẫn đổi đúng khi dữ liệu nguồn đổi.
- **Rủi ro:** nếu revision không bao trọn mọi thay đổi nguồn sẽ gây cache stale — cần bám sát đúng các trường ảnh hưởng preview.

#### P1-11. Hard cap cho preview layout — công sức S

- **Mục tiêu:** từ chối request có thể sinh số cell/polygon cực lớn trước khi tính toán.
- **Điểm chạm:** `PreviewLayoutRequest` chỉ có `extra='forbid'`, field kiểu trần không ràng buộc tại [`backend/app/api/routes/imposition.py`](../../backend/app/api/routes/imposition.py#L1228).
- **Cách làm:** thêm ràng buộc `Field(gt=..., le=...)` cho item size, rows, columns, quantity; giới hạn tổng số cell và số polygon/point; trả `422` khi vượt.
- **DoD:** request với rows/columns/quantity quá lớn hoặc item quá nhỏ bị từ chối bằng 422 trước khi tính; request hợp lệ không đổi hành vi.
- **Rủi ro:** đặt cap quá chặt có thể chặn use case thật — chọn ngưỡng dựa trên giới hạn sản xuất thực tế.

#### P1-12. Thay thread chờ của Compare bằng bounded worker queue — công sức M

- **Mục tiêu:** nhiều job Compare không sinh nhiều OS thread đứng chờ semaphore; polling không chồng request và tự hủy khi tab đóng.
- **Điểm chạm:** thread-per-job (DEV_MODE/IS_DESKTOP_APP) chờ semaphore tại [`backend/app/api/routes/compare.py`](../../backend/app/api/routes/compare.py#L148) — production dùng Celery nên phạm vi sửa là đường DEV/Desktop; polling `setInterval(async ...)` không có AbortController tại [`desktop/src/components/CompareTab.tsx`](../../desktop/src/components/CompareTab.tsx#L183).
- **Cách làm:** thay thread-per-job bằng hàng đợi có số worker cố định (hoặc tái dùng job manager P0-2); frontend đổi polling sang recursive timeout (chỉ chạy lần kế sau khi request trước xong) và hủy bằng `AbortController` khi job/tab kết thúc.
- **DoD:** nhiều job Compare chờ không làm tăng số thread tuyến tính; polling không chồng request; đóng tab dừng polling ngay.
- **Rủi ro:** chỉ áp cho đường DEV/Desktop — không đụng đường Celery production.

#### P1-13. Bỏ `preserveDrawingBuffer` thường trực trong Dieline — công sức S

- **Mục tiêu:** không gánh chi phí GPU liên tục chỉ để phục vụ export ảnh thỉnh thoảng.
- **Điểm chạm:** `preserveDrawingBuffer: true` đặt cố định tại [`desktop/src/components/dieline-tool/MockupCanvas.tsx`](../../desktop/src/components/dieline-tool/MockupCanvas.tsx#L105).
- **Cách làm:** dùng `WebGLRenderTarget` và readback pixel riêng khi export; không dựa vào việc bật/tắt `preserveDrawingBuffer` sau khi WebGL context đã được tạo vì context attribute này không chuyển đổi runtime đáng tin cậy.
- **DoD:** export ảnh vẫn hoạt động; canvas 3D thường ngày không còn cờ này.
- **Rủi ro:** một số cách export cần buffer còn nội dung ngay sau frame — kiểm kỹ export vẫn ra ảnh đúng.

### Giai đoạn P2

- **P2-14.** Tối ưu bundle: thêm `manualChunks`/bundle budget vào [`desktop/vite.config.ts`](../../desktop/vite.config.ts); xử lý các module vừa import tĩnh vừa động; chỉ preload chunk theo tool sắp mở. Công sức M.
- **P2-15.** Đưa test/snapshot/lint về xanh: cập nhật snapshot Imposer store (`bookReportDisplay`), sửa persist version test (mong đợi 9 vs mã 10), profile ba property test timeout (dieline contourValidator/geometry, mockup3d determinism) trước khi quyết định sửa thuật toán hay chỉ điều chỉnh giới hạn, đã có lint budget ratchet và đang xử lý theo từng nhóm rủi ro; mốc hiện tại là 1.549 errors và 112 warnings, chưa bao gồm viewer/thumbnail Công sức L.
- **P2-16.** Bổ sung benchmark regression theo ma trận mục 9 để có số thật trước/sau cho các workload lớn. Công sức L.

### Phụ thuộc và thứ tự đề xuất

- **P0-0 (baseline) nên chạy trước** các thay đổi lớn để có số đo trước/sau.
- **P0-2 (job manager) là nền** cho P0-3, P0-4, P0-7, P1-12 — nên làm sớm nhất trong nhóm điều phối tài nguyên, nhưng phải tách background queue khỏi request-bound threadpool.
- **P0-1, P1-9, P1-10, P1-11, P1-13** độc lập, có thể làm xen kẽ để có thắng nhanh; P1-13 chỉ dùng render target/readback, không toggle WebGL context attribute.
- **P2-15** nên chạy lại gate ngay đầu để có số hiện tại, tách khỏi các claim tĩnh trong mục 7.
## 12. Trạng thái triển khai

Cập nhật sau các đợt triển khai ngày 2026-07-22. Mục 11 vẫn là roadmap chính thức; trạng thái dưới đây phân biệt rõ phần đã vào mã và phần còn chờ benchmark/thiết kế sâu hơn.

### Đã triển khai hoặc hoàn tất một phần

| Hạng mục | Trạng thái | Nội dung đã làm | Phần còn lại |
|---|---|---|---|
| P0-0 Baseline | Một phần | Thêm `performance.mark/measure` cho app mounted, splash complete và AppInner mounted. | Benchmark Tauri thực, RSS/process/temp-disk và P95 API. |
| P0-1 Splash/warm-up | Một phần | Chuyển scheduler warm-up lên `App()` để chạy trong lúc splash mà không mount toàn bộ tab tree. | Đo cold launch rồi quyết định giảm `SPLASH_MIN_MS`; chia warm-up thành idle slices nếu trace cho thấy long task. |
| P0-2 Job manager | Giai đoạn 1 | N-Up dùng bounded executor, VDP dùng semaphore; mặc định mỗi loại chạy một job, hàng đợi tối đa 8 job và trả 429 khi đầy. Cả hai có trạng thái `queued`. Có thể chỉnh qua `PRYNX_MAX_NUP_JOBS`, `PRYNX_MAX_NUP_QUEUE`, `PRYNX_NUP_WORKERS`, `PRYNX_MAX_VDP_JOBS` và `PRYNX_MAX_VDP_QUEUE`. | Scheduler chung theo RAM/CPU, cancellation, persisted queue và budget tách biệt theo loại tài nguyên. |
| P0-3 N-Up chunk RAM | Một phần | Worker ghi từng chunk ra file tạm và trả đường dẫn; bộ ghép mở trực tiếp từng file, xóa sau ghép và outer process dọn file sót khi lỗi/hủy. | Đo peak RSS với output hàng chục nghìn trang; final document của thư viện PDF vẫn cần benchmark để quyết định chiến lược merge sâu hơn. |
| P0-4 FastAPI event loop | Hoàn tất cho `pdf_tools` đã audit | Merge, split, resize, trim-shift, shuffle, OCR, optimize hậu xử lý, encrypt/decrypt và metadata chạy qua threadpool. | Benchmark status/health latency trong lúc chạy job nặng. |
| P0-5 Combine file lớn | Giai đoạn 1 hoàn tất | `CombineTab` chuyển job lớn sang backend; endpoint manifest nhận danh sách file + thao tác theo trang, hỗ trợ trang trắng, chọn trang và xoay, mở mỗi nguồn một lần rồi ghi output qua pikepdf. | Tiến trình/cancel cho job rất dài và workflow group tạo nhiều output vẫn cần job manager riêng. |
| P0-6 Upload/ZIP | Một phần | `pdf_tools.save_upload` dùng helper streaming có giới hạn dung lượng; split ZIP ghi ra file và trả `FileResponse`, cleanup sau response. CSV VDP đã dùng file multipart. | Rà soát các upload còn đọc nguyên file ngoài `pdf_tools` và XLSX/Google Sheets transport. |
| P0-7 CSV/VDP transport | Giai đoạn 1 | **Chỉ đường CSV single-up (generate)** đi theo `multipart/form-data`, backend parse theo stream text (`_parse_csv_upload` trong `vdp.py`, không phải module riêng) và không dựng lại JSON toàn dataset; vẫn giữ trần 256 MiB/100.000 dòng, hàng đợi bounded và giới hạn job VDP đồng thời. | **Multi-up CSV vẫn `JSON.stringify(csvData)` thành blob ([`api.ts`](../../desktop/src/lib/api.ts#L409)) và preview vẫn gửi toàn bộ rows dạng JSON** — chưa thoát đường JSON. XLSX/Google Sheets/manual cũng cần contract file/path/token hoặc streaming; nhánh JSON backend (`data_format != csv`) vẫn `read()` nguyên khối. Cần test tải lớn thực tế. |
| P1-9 Persist | Hoàn tất đợt 1 | Debounce ghi localStorage, flush khi `pagehide`, scope key theo tab và seed một lần từ khóa legacy để không mất settings. | Đo long task khi kéo/chỉnh setting liên tục. |
| P1-10 Cache key | Một phần | Hai `JSON.stringify` lớn trong `ImposerDashboard` (`pageSizedShapeStateKey`, `previewSourceKey`) được memo hóa theo dependency thật. | Còn 1 `JSON.stringify(params)` per-page (shapeParams, ~L1479) chạy mỗi render trong thân JSX — nhỏ nhưng chưa memo; benchmark với job có số trang lớn. |
| P1-11 Preview cap | Hoàn tất đợt 1 | Pydantic `Field` giới hạn dimension/rows/cols/quantity; chặn số cell và page map trước khi compute. | Hiệu chỉnh ngưỡng bằng workload sản xuất thực tế. |
| P1-12 Compare queue/polling | Giai đoạn 1 hoàn tất | Frontend dùng recursive timeout không chồng request và cleanup khi reset/unmount. Backend DEV/Desktop và luồng recover dùng fixed `ThreadPoolExecutor`, hàng đợi bounded (`PRYNX_MAX_COMPARE_QUEUE`) và trả 429 khi đầy, nên job chờ không tạo thêm OS thread. | Bổ sung cancel cho job đang chờ/đang chạy và hợp nhất vào scheduler tài nguyên chung. |
| P1-13 Dieline export | Hoàn tất đợt 1 | Bỏ `preserveDrawingBuffer`; export dùng `WebGLRenderTarget` + pixel readback vào canvas tạm, không resize canvas 3D đang hiển thị. | Benchmark GPU/readback trên máy yếu và kiểm tra thêm các chế độ màu/alpha hiếm. |
| P2-14 Bundle | Hoàn tất đợt 1 | Thêm `manualChunks` theo nhóm React/PDF/Three và budget 1,5 MB cho entry chunk; production build đã vượt gate. | Rà lại dynamic import vừa tĩnh vừa động và tinh chỉnh chunk dựa trên trace khởi động thực tế. |
| P2-15 Test frontend | Hoàn tất phần test | Snapshot/version được cập nhật; thêm test persist scope/migration và điều kiện rẽ Combine lớn. Toàn bộ 110 test files đã xanh. | Lint toàn repo vẫn là hạng mục riêng. |

### Chưa triển khai

- P0-5 phần còn lại: tiến trình/cancel cho job rất dài và workflow group tạo nhiều output.
- P0-7 phần còn lại: mở rộng transport file/path/token hoặc streaming cho XLSX/Google Sheets/manual/multi-up và đo workload lớn.
- P1-8: lifecycle `active`/`paused`/`serialized` cho tab.


- P2-16: benchmark regression đầy đủ theo mục 9.

### Kết quả xác minh sau các đợt cập nhật

- Frontend production build: **đạt**.
- Frontend test: **110/110 files đạt; 955 tests đạt, 2 skipped**.
- Test store tập trung: **12/12 đạt**.
- Backend syntax (`py_compile`) cho các file đã sửa: **đạt**.
- Backend CSV transport: **3/3 đạt**; PDF manifest: **2/2 đạt** (chọn trang/trang trắng/xoay và kiểm tra chỉ số lỗi).
- Backend test mục tiêu không cần database: **121/121 đạt**, gồm xuất PDF thật cho N-Up cắt xén/die-cut/layer và 30 test Compare queue/engine/pipeline.
- Backend VDP integration: 14 test không chạy được vì PostgreSQL localhost:5432 không hoạt động; đây là lỗi môi trường test, không phải assertion failure.
- `cargo check`: **đạt**, còn 12 warning có sẵn.
- Lint budget gate: **đạt** với 1.549 errors và 112 warnings; chưa tuyên bố lint xanh vì phần legacy còn lại vẫn được theo dõi theo budget.
