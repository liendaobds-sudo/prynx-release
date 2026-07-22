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

Phần mềm có nền tảng khá mạnh: Tauri, backend Python riêng, multiprocessing, worker, cache, lazy tool loading và nhiều cơ chế hủy tác vụ. Tuy nhiên, trạng thái hiện tại chưa thể gọi là mạnh mẽ, mượt mà và tối tân nhất.

| Khía cạnh | Đánh giá |
|---|---|
| Tác vụ thông thường, chạy một job | Khá tốt |
| Khởi động và cảm giác sẵn sàng | Trung bình |
| File lớn, 10.000-50.000 trang | Rủi ro RAM cao |
| VDP 100.000 dòng | Chưa đủ an toàn |
| Nhiều job hoặc tab đồng thời | Yếu, thiếu giới hạn toàn cục |
| Khả năng chống treo UI | Chưa đồng đều |
| Chất lượng build | Build được, nhưng test và lint chưa sạch |

Điểm số và nhận định trên dựa trên kiến trúc cùng mã nguồn, không phải số đo FPS, RAM hoặc latency thực tế.

## 3. Phát hiện ưu tiên cao

### P0 - Khởi động bị chậm có chủ ý, nhưng thời gian chờ không được tận dụng

Ứng dụng giữ splash tối thiểu **3 giây** tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L145). Trong thời gian này `AppInner` chưa được mount theo điều kiện render tại [`desktop/src/App.tsx`](../../desktop/src/App.tsx#L181).

Việc warm-up các chunk lớn chỉ bắt đầu sau khi splash kết thúc, thông qua [`warmupWorkspaceChunks`](../../desktop/src/lib/pdfWarmup.ts#L25), rồi tiếp tục trì hoãn khoảng 200-300 ms.

Hệ quả:

- Người dùng chắc chắn phải chờ ít nhất 3 giây.
- Khoảng chờ này không được dùng để tải trước phần quan trọng.
- Ngay sau khi Home xuất hiện, ứng dụng mới đánh giá các chunk nặng, có thể gây khựng đúng lúc người dùng bắt đầu thao tác.
- Dù viewer bị loại khỏi audit, hành vi ứng dụng chủ động preload chunk viewer vẫn là chi phí khởi động toàn ứng dụng.

Khuyến nghị: mount shell và bắt đầu warm-up phía sau splash; giảm hoặc bỏ thời gian splash cưỡng bức; đo riêng thời điểm shell có thể tương tác thay vì chỉ đo lúc splash biến mất.

### P0 - N-Up có thể tạo quá nhiều process và làm cạn RAM

Mỗi job Imposition tạo một process mới tại [`backend/app/api/routes/imposition.py`](../../backend/app/api/routes/imposition.py#L1135), nhưng chưa có hàng đợi hoặc giới hạn số job toàn ứng dụng.

Bên trong mỗi job lại tạo `ProcessPoolExecutor` gần bằng số lõi CPU tại [`backend/app/workers/nup_engine.py`](../../backend/app/workers/nup_engine.py#L3047). Nếu người dùng chạy nhiều job hoặc tab, số process có thể tăng theo kiểu lồng nhau.

Mỗi worker xuất cả chunk PDF thành `bytes` tại [`backend/app/workers/nup_process_chunk.py`](../../backend/app/workers/nup_process_chunk.py#L1318), sau đó tiến trình cha thu toàn bộ chunk vào một danh sách trước khi ghép.

Với output hàng chục nghìn trang, bộ nhớ có thể đồng thời chứa:

- PDF nguồn.
- Dữ liệu từng chunk.
- Danh sách toàn bộ chunk.
- Tài liệu đang ghép.
- PDF output cuối.

Đây là rủi ro OOM theo kiến trúc, dù chưa có benchmark xác định ngưỡng dung lượng cụ thể.

Khuyến nghị: để worker ghi chunk vào file tạm và trả về đường dẫn; tiến trình cha ghép tăng dần rồi xóa chunk; áp dụng backpressure, cancellation và hàng đợi job toàn cục giới hạn theo RAM/CPU.

### P0 - VDP khuếch đại bộ nhớ và thiếu giới hạn job đồng thời

Frontend parse CSV trực tiếp trên luồng UI tại [`desktop/src/components/preprocess-tools/DataMergeTool.tsx`](../../desktop/src/components/preprocess-tools/DataMergeTool.tsx#L861), giữ toàn bộ dòng trong mảng rồi tiếp tục `JSON.stringify` tại [`desktop/src/lib/api.ts`](../../desktop/src/lib/api.ts#L401).

Backend đọc và parse toàn bộ JSON, sau đó chia dữ liệu và gửi tới nhiều process tại [`backend/app/workers/vdp_engine.py`](../../backend/app/workers/vdp_engine.py#L1065).

Một bộ dữ liệu có thể tồn tại đồng thời dưới nhiều bản sao:

1. Mảng JavaScript.
2. Chuỗi JSON.
3. Blob hoặc upload buffer.
4. Byte buffer phía backend.
5. Danh sách Python.
6. Các chunk được pickle sang worker.

Backend cho phép đến 100.000 dòng nhưng chưa có giới hạn kích thước payload và chưa có semaphore hoặc hàng đợi job toàn cục. Nhiều job VDP có thể chạy song song qua [`BackgroundTasks`](../../backend/app/api/routes/vdp.py#L188).

Khuyến nghị: parse bằng worker hoặc stream; chỉ giữ dữ liệu preview trên frontend; để backend đọc trực tiếp file nguồn theo chunk; đặt giới hạn payload theo byte và số job đồng thời.

### P0 - Nhiều API `async` vẫn chặn toàn bộ event loop

Các route PDF khai báo `async def` nhưng gọi trực tiếp hàm xử lý đồng bộ. Ví dụ merge gọi `merge_pdfs` trực tiếp tại [`backend/app/api/routes/pdf_tools.py`](../../backend/app/api/routes/pdf_tools.py#L209). Split, resize, trim, shuffle, OCR, encrypt, decrypt và metadata có cùng mô hình.

Khi một tác vụ CPU hoặc ổ đĩa nặng chạy, event loop FastAPI có thể không xử lý kịp:

- Polling trạng thái.
- Lệnh hủy.
- Request từ tab khác.
- Health check.
- Cập nhật UI.

Khuyến nghị: chuyển route CPU/I/O đồng bộ thành route `def` để FastAPI đưa vào threadpool, hoặc bọc bằng `run_in_threadpool`/`asyncio.to_thread`; dùng semaphore chung cho các tác vụ nặng.

### P0/P1 - Combine xử lý PDF nặng trên luồng giao diện

Combine dùng `pdf-lib` để load, copy và save toàn bộ PDF tại [`desktop/src/components/CombineTab.tsx`](../../desktop/src/components/CombineTab.tsx#L472) và trong luồng combine tùy chỉnh tại [`desktop/src/components/CombineTab.tsx`](../../desktop/src/components/CombineTab.tsx#L584).

`await` không chuyển công việc CPU của `pdf-lib` sang background thread. Với nhiều file lớn, WebView vẫn có thể bị đóng băng và RAM phải giữ PDF nguồn, cấu trúc đã parse, trang đã copy và output.

Khuyến nghị: đặt ngưỡng kích thước hoặc số trang; job nhỏ có thể tiếp tục xử lý frontend, còn job lớn bắt buộc chuyển sang sidecar/backend.

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

Backend Compare tạo một thread cho mỗi job rồi để thread chờ semaphore tại [`backend/app/api/routes/compare.py`](../../backend/app/api/routes/compare.py#L148). Nhiều job chờ vẫn tạo nhiều OS thread.

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

Model request preview chứa các trường số và danh sách nhưng thiếu giới hạn rõ ràng tại [`PreviewLayoutRequest`](../../backend/app/api/routes/imposition.py#L1228).

Kích thước item quá nhỏ hoặc rows, columns, quantity quá lớn có thể tạo số cell cực cao, tiêu thụ CPU và RAM.

Khuyến nghị: giới hạn tổng số cell, số polygon/point, rows, columns, page map và quantity; từ chối request bằng mã `422` trước khi tính toán.

### Upload và ZIP dùng quá nhiều RAM

Helper trong `pdf_tools.py` đọc toàn bộ upload bằng `await file.read()` tại [`save_upload`](../../backend/app/api/routes/pdf_tools.py#L179), trong khi project đã có helper khác hỗ trợ streaming và giới hạn dung lượng.

Split PDF tạo toàn bộ ZIP trong `BytesIO` tại [`backend/app/api/routes/pdf_tools.py`](../../backend/app/api/routes/pdf_tools.py#L269), rồi gọi `getvalue()`, có thể phát sinh thêm một bản sao đầy đủ.

Khuyến nghị: dùng upload theo chunk; tạo ZIP trong file tạm; trả bằng `FileResponse` hoặc streaming và dọn file bằng background cleanup.

## 5. Bundle và frontend

Build hiện tại thành công, nhưng Vite cảnh báo nhiều chunk lớn hơn 500 kB.

Một số chunk đáng chú ý tại thời điểm audit:

| Chunk | Raw | Gzip |
|---|---:|---:|
| Main bundle | Khoảng 1.325 kB | Khoảng 419 kB |
| Imposition | Khoảng 949 kB | Khoảng 217 kB |
| Dieline | Khoảng 720 kB | Khoảng 215 kB |
| `exportSizing` | Khoảng 990 kB | Khoảng 270 kB |
| `fontkit` | Khoảng 757 kB | Khoảng 344 kB |
| CSS | Khoảng 220 kB | Khoảng 31 kB |

Nhiều module vừa được import tĩnh vừa import động nên dynamic import không còn giúp chia bundle hiệu quả. Cấu hình hiện chưa có bundle budget hoặc chiến lược `manualChunks` tại [`desktop/vite.config.ts`](../../desktop/vite.config.ts).

Dieline 3D đã dùng `frameloop="demand"` và giới hạn DPR. Tuy nhiên, `preserveDrawingBuffer: true` tại [`desktop/src/components/dieline-tool/MockupCanvas.tsx`](../../desktop/src/components/dieline-tool/MockupCanvas.tsx#L105) làm tăng chi phí GPU liên tục chỉ để hỗ trợ export ảnh.

Khuyến nghị: dùng render target riêng khi export; thêm bundle budget vào CI; xử lý các module vừa import tĩnh vừa import động; chỉ preload chunk theo tool người dùng sắp mở.

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

- TypeScript và Vite build thành công.
- Vite cảnh báo nhiều chunk lớn hơn 500 kB.
- Thời gian riêng của Vite build trong lần kiểm tra khoảng 11,78 giây.
- Không dùng thời gian toàn command làm benchmark sản phẩm vì còn bao gồm typecheck và điều kiện máy audit.

### Native

`cargo check`: **Đạt**, còn 12 warning.

### Test frontend

- 109 test files: 105 đạt, 4 lỗi.
- 947 tests: 940 đạt, 5 lỗi, 2 bỏ qua.
- Một snapshot lỗi và một snapshot obsolete.

Các lỗi gồm:

1. Snapshot mặc định của Imposer store chưa cập nhật cho `bookReportDisplay`.
2. Persist version trong test mong đợi 9 nhưng mã hiện tại là 10.
3. Property test `dieline/contourValidator` bị timeout 30 giây.
4. Test `dieline/geometry` cho tray bị timeout 5 giây.
5. Test `mockup3d/generatorDeterminism` cho pizza bị timeout 5 giây.

Các timeout là cảnh báo về performance budget hoặc độ ổn định của test, chưa đủ bằng chứng để kết luận runtime Dieline chắc chắn chậm trên máy người dùng.

### Lint

`npm run lint`: **Không đạt**.

- 1.770 errors.
- 138 warnings.
- Tổng cộng 1.908 vấn đề.
- 81 errors và 9 warnings có thể autofix.

### Giới hạn kiểm chứng

- Môi trường audit không có Python executable nên chưa chạy được backend Python tests.
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
