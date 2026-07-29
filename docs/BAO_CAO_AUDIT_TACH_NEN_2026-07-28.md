# Báo cáo audit tính năng Tách nền AI — 2026-07-28

> **Cập nhật sau duyệt:** các phát hiện trong báo cáo đã được xử lý; kết quả và bằng chứng
> verify nằm tại docs/TACH_NEN_FIXES_2026-07-28.md. Phán quyết NO-GO bên dưới là baseline
> tại thời điểm audit, trước khi sửa.

## 1. Phạm vi và phán quyết

Luồng được rà soát: chọn ảnh → preview/store theo tab → warmup → API
`/pdf-tools/remove-background` → ISNet/BiRefNet qua ONNX Runtime DirectML/CPU → hậu xử lý
alpha → lưu PNG → đóng gói Nuitka/Windows.

**Phán quyết hiện tại: NO-GO cho phát hành tính năng Tách nền.** Lỗi 500 mà người dùng vừa
gặp đã được tái hiện và có nguyên nhân xác định: PrynX gọi đồng thời cùng một DirectML
`InferenceSession`, trong khi DirectML không hỗ trợ multi-threaded `Run` trên cùng session.
Ngoài chặn này còn có bốn lỗi correctness/release mức P1: model phụ thuộc tải runtime không
an toàn, TIFF/BMP được UI nhận nhưng API từ chối, mất thông tin màu/hướng/DPI của ảnh in, và
kết quả cũ không bị vô hiệu khi đổi thiết lập.

Lỗi `403` và cảnh báo React trong console không phải nguyên nhân trực tiếp của response 500:
request tách nền đã vượt qua license guard và vào tới engine rồi mới trả 500.

## 2. Bằng chứng tái hiện

Môi trường audit: Windows, `onnxruntime-directml 1.24.4`, providers
`DmlExecutionProvider` + `CPUExecutionProvider`, ảnh JPG thực tế 700×437 px đang có trong
`backend/uploads`.

| Ca thử | Kết quả |
|---|---|
| BiRefNet-lite, ép CPU | PASS, PNG RGBA 700×437, 12,26 giây (cold start) |
| BiRefNet-lite, DirectML | PASS khi chạy đơn, 7,56 giây (cold start) |
| ISNet, DirectML | PASS khi chạy đơn, 2,19 giây (cold start) |
| Hai luồng cùng gọi BiRefNet-lite DirectML | Tái hiện lỗi `DmlFusedNode_1_6`, HRESULT `80004005 Unspecified error`; engine phải dựng lại session CPU |

Tài liệu chính thức của ONNX Runtime nêu rõ DirectML không hỗ trợ gọi `Run` đa luồng trên
cùng inference session; mỗi session chỉ được một thread gọi tại một thời điểm:
<https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html#configuration-options>.

## 3. Phát hiện

### §BG.01 — P0: warmup và xử lý thật tranh chấp cùng DirectML session

**Bằng chứng mã:**

- `desktop/src/components/preprocess-tools/BgRemoverTool.tsx:113-125` tự gọi warmup kiểu
  fire-and-forget khi mở công cụ; nút chạy không chờ hoặc khoá theo trạng thái warmup.
- `backend/app/core/heavy_job_scheduler.py:17-21,76-88` cho phép mặc định hai heavy job chạy
  đồng thời.
- `backend/app/workers/birefnet_engine.py:41-42,73-84,120-127` chỉ khoá lúc tạo session,
  không khoá `session.run()`.
- `backend/app/workers/isnet_engine.py:30-31,60-70,98-105` có cùng cấu trúc.
- Audit đã tái hiện đúng `RUNTIME_EXCEPTION` từ `DmlFusedNode` khi hai thread dùng chung
  BiRefNet-lite session.

**Cơ chế gây 500:** warmup chiếm một heavy slot, xử lý thật chiếm slot còn lại và cả hai gọi
`Run` trên cùng session. Khi một luồng lỗi rồi đặt `_force_cpu=True`, luồng DirectML còn lại
có thể vào `except` sau đó, thấy cờ đã true và ném thẳng `RuntimeException` thay vì retry CPU
(`birefnet_engine.py:122-129`; ISNet tương tự). Đây là race condition, vì vậy có lần chạy được,
có lần 500 — đúng biểu hiện người dùng báo.

**Yêu cầu sửa:** mỗi model/variant phải có run lock riêng bao trọn inference và quá trình
chuyển provider; session DirectML phải dùng `ORT_SEQUENTIAL`, tắt memory pattern theo hợp đồng
DirectML. Warmup phải có trạng thái dùng chung hoặc được xử lý như một lần chuẩn bị có thể chờ,
không tạo cuộc đua với nút chạy. Không hạ hard-cap toàn hệ thống xuống một job; máy mạnh vẫn
phải chạy hết công suất ở các engine/session độc lập.

### §BG.02 — P1: model tải runtime không atomic, không checksum và không chạy offline lần đầu

**Bằng chứng mã:**

- `birefnet_engine.py:30-38,60-70` và `isnet_engine.py:25-28,48-57` tải 178–927 MB từ GitHub
  thẳng vào tên file cuối cùng; chỉ kiểm tra `exists`, không kiểm SHA-256/size, không tải vào
  file tạm rồi rename.
- `build_production.ps1:482-503` chỉ bundle model Upscale; chú thích xác nhận ISNet/BiRefNet
  tải runtime.
- Cache hiện tại có ISNet 178.648.008 byte và BiRefNet-lite 224.005.088 byte; model `full`
  927 MB chưa có. Chọn chế độ tóc/lông sẽ cần tải lần đầu.
- Warmup frontend bỏ qua cả HTTP lỗi lẫn `{ok:false}` tại `BgRemoverTool.tsx:118-123`, nên UI
  vẫn cho bấm và chỉ báo lỗi generic sau khi chờ.

**Hậu quả:** mạng mất giữa chừng để lại model cụt nhưng lần sau vẫn được coi là đã có; URL
GitHub bị chặn/offline làm tính năng hỏng; chế độ 927 MB không có tiến độ; build release không
smoke-test bất kỳ model tách nền nào.

**Yêu cầu sửa:** chốt chiến lược phát hành model (khuyến nghị bundle ISNet để có chế độ chạy
offline, tải BiRefNet theo nhu cầu); mọi tải thêm phải `.part` → kiểm hash/ONNX load → atomic
rename, có khoá liên tiến trình và tiến độ/trạng thái rõ. Build phải kiểm hash + smoke inference
ít nhất model được bundle.

### §BG.03 — P1: UI hứa hỗ trợ TIFF/BMP nhưng đường upload luôn bị API từ chối

**Bằng chứng mã:**

- Picker và normalize nhận TIFF/BMP tại
  `desktop/src/components/preprocess-tools/imageBatch/helpers.ts:12-19,32-59,85-101`.
- Trong Tauri, helper đọc bytes và luôn tạo `fileObj` có dữ liệu (`helpers.ts:43-50`); frontend
  ưu tiên gửi multipart file ở `BgRemoverTool.tsx:36-40`.
- Shared upload backend chỉ cho `.pdf/.png/.jpg/.jpeg/.webp` tại
  `backend/app/utils/file_handler.py:17,26-29`; vì vậy TIFF/BMP nhận 415 trước engine.
- Dòng hướng dẫn của preview vẫn tuyên bố hỗ trợ TIFF/BMP tại `BgRemoverTool.tsx:237`.

**Yêu cầu sửa:** hoặc normalize TIFF/BMP thành PNG trước khi gửi và đặt đúng tên/MIME, hoặc
mở rộng upload contract + test decode. Không được chỉ xoá nhãn hỗ trợ nếu mục tiêu sản phẩm vẫn
là nhận ảnh in TIFF/BMP.

### §BG.04 — P1: output không bảo toàn hướng ảnh, quản lý màu và DPI

**Bằng chứng mã:**

- Endpoint gọi `img.load()` rồi đưa thẳng ảnh vào engine tại
  `backend/app/api/routes/pdf_tools.py:1593-1618`; không `ImageOps.exif_transpose`, không chuyển
  ICC có quản lý màu.
- Cả hai preprocess dùng `image.convert("RGB")`
  (`birefnet_engine.py:99-108`, `isnet_engine.py:82-88`).
- Output chỉ `result_img.save(..., format="PNG")` tại `pdf_tools.py:1630`, không giữ/gắn ICC
  hoặc DPI.

**Hậu quả:** JPEG có EXIF orientation có thể xuất xoay sai; CMYK/profiled RGB có thể đổi màu;
PNG mất DPI/profile — không phù hợp kỳ vọng của công cụ chế bản in.

**Yêu cầu sửa:** transpose EXIF trước inference; chuyển màu có quản lý về sRGB khi cần và cảnh
báo rõ; giữ DPI, gắn profile đầu ra đúng không gian màu. Thêm test ảnh EXIF xoay, CMYK+ICC,
RGB+ICC, DPI và alpha nguồn.

### §BG.05 — P1: giới hạn 6000 px làm giảm file trên mọi máy và kiểm RAM quá muộn

**Bằng chứng mã:** `pdf_tools.py:1593-1605` gọi `img.load()` trước rồi hard-resize mọi ảnh có
cạnh >6000 px. Như vậy ảnh đã giải nén đầy đủ trước “chặn OOM”, còn máy 32/64 GB vẫn bị hạ
độ phân giải vô điều kiện.

**Hậu quả:** ảnh in khổ lớn bị mất pixel mà UI không báo; ảnh nén kích thước pixel cực lớn vẫn
có thể làm cạn RAM trước khi guard chạy. Quy tắc hiệu năng dự án yêu cầu chỉ giảm theo hồ sơ RAM
máy, không hard-cap máy mạnh.

**Yêu cầu sửa:** đọc kích thước header và ước lượng RAM trước `load`; gate theo RAM khả dụng.
Nếu buộc giảm, trả warning/kích thước thật cho UI thay vì âm thầm đổi output.

### §BG.06 — P1: đổi thiết lập không làm mất hiệu lực kết quả cũ

**Bằng chứng mã:** `BgRemoverOptions.tsx:20-21` đổi option trực tiếp; `BgRemoverTool.tsx:180`
ghi store nhưng không đưa các item thành `pending`. Khi tất cả item đã success, nút chạy bị
disable theo `hasPending` (`BgRemoverTool.tsx:89,183-188`) và nút lưu vẫn lưu blob cũ.
Các option cũng không bị khoá khi đang xử lý.

**Hậu quả:** người dùng có thể xử lý “Chất lượng cao”, đổi sang “Tóc/lông” hoặc đổi Edge Shift,
nhưng lưu ra kết quả của cấu hình cũ trong khi UI đang hiển thị cấu hình mới. Nếu đổi giữa batch,
`processBatch` vẫn dùng snapshot option cũ (`BgRemoverTool.tsx:20-22`).

**Yêu cầu sửa:** đổi bất kỳ option ảnh hưởng output phải revoke kết quả cũ và đưa item về
`pending`; khoá option khi batch đang chạy; warm đúng model khi engine đổi.

### §BG.07 — P2: lỗi giao diện hiển thị raw JSON, không có retry/cancel và rò object URL

**Bằng chứng mã:** frontend nhét nguyên body lỗi vào message tại `BgRemoverTool.tsx:53-63`, tạo
toast/overlay kiểu `Lỗi Server (500): {"detail":...}`. Batch không có AbortController/finally
(`BgRemoverTool.tsx:19-69`). `imageBatch/store.ts:104-127` remove/undo/reset không revoke
`originalUrl/resultUrl`; batch ảnh lớn sẽ giữ blob trong RAM đến khi đóng WebView.

**Yêu cầu sửa:** parse `detail` thành thông báo Việt ngữ có hành động thử lại/chuyển CPU; cho
hủy batch; dọn object URL khi thay/xoá/reset/unmount. Không lộ JSON kỹ thuật trên canvas.

### §BG.08 — P2: cảnh báo `getSnapshot` là lỗi thật nhưng không phát sinh từ Tách nền

`BgRemoverTool.tsx:83` dùng `defaultTabState` ổn định. Nguồn không ổn định tìm thấy ở
`desktop/src/components/preprocess-tools/UpscaleTool.tsx:122`: selector fallback gọi
`getTab(tabId)`, mà `imageBatch/store.ts:49-56,66-68` tạo object mới mỗi lần snapshot khi tab
chưa init. React 19 vì vậy cảnh báo snapshot phải được cache. Console giữ log cũ qua lần chuyển
công cụ nên cảnh báo xuất hiện cạnh lỗi Tách nền.

Vẫn nên sửa trong lô shared image tools để loại nguy cơ render loop, nhưng không dùng nó để giải
thích response 500.

### §BG.09 — P1: không có test tính năng hoặc bộ ảnh chuẩn đánh giá chất lượng mask

Tìm trong `backend/tests` và frontend test không có test cho route remove-background, engine
ISNet/BiRefNet, postprocess, fallback GPU→CPU, warmup race, định dạng TIFF/BMP hoặc persistence
theo tab. Test hiện có chỉ xác nhận tool registry/routing/license mapping.

Không có golden mask/dataset cục bộ để đo IoU, boundary F-score hay sai số tóc/lông/sản phẩm.
Vì vậy tuy engine đơn lẻ chạy được, chưa có bằng chứng định lượng để gọi chất lượng “tối đa” hoặc
so với tool thương mại.

**Yêu cầu sửa:** thêm unit/route tests không cần GPU; test concurrency bằng fake session; smoke
DirectML trên Windows; bộ ảnh chuẩn nhỏ có mask tham chiếu và metric biên. Không dùng telemetry
người dùng làm tiêu chí thay thế cho correctness test.

## 4. Diễn giải ba dòng console người dùng gửi

1. `403 Forbidden`: chưa có URL nên chưa thể quy nguồn chính xác. Nó không phải response của
   request remove-background đang xét, vì request đó trả 500 sau khi engine chạy. Cần log URL
   đầy đủ nếu 403 còn tái hiện sau khi sửa.
2. `getSnapshot should be cached`: nguồn cụ thể đã tìm thấy ở fallback store của Upscale
   (§BG.08), là nợ shared UI và không làm ONNX trả 500.
3. `RuntimeException`: là chặn thực tế của Tách nền, khớp race DirectML §BG.01.

## 5. Kế hoạch sửa đề xuất (mỗi lô không quá 5 file)

### Lô A — Chặn 500 và tạo regression test

1. `backend/app/workers/birefnet_engine.py`: session options DirectML + per-variant run lock +
   fallback atomic.
2. `backend/app/workers/isnet_engine.py`: cùng hợp đồng.
3. `backend/app/api/routes/pdf_tools.py`: phối hợp warmup/job và mã lỗi domain.
4. Test engine concurrency/fallback mới.
5. Test route warmup + process đồng thời mới.

Điều kiện qua: 20 vòng warmup/process chồng nhau không có 500; CPU fallback một lần và các lần
sau ổn định; hai variant/session độc lập vẫn tận dụng được máy mạnh.

### Lô B — Model và release offline

1. Helper tải model atomic + hash.
2. Hai engine dùng manifest model thống nhất.
3. `build_production.ps1` bundle/smoke-test model tối thiểu.
4. `scripts/bundled_components.json` và notice/license tương ứng.
5. Test model thiếu, model cụt, hash sai, offline.

### Lô C — Hợp đồng ảnh in và định dạng

1. `pdf_tools.py`: validate trước decode, EXIF/ICC/DPI, RAM gate, warning headers.
2. `file_handler.py` hoặc normalize helper: thống nhất TIFF/BMP.
3. Frontend hiển thị warning/kích thước đầu ra.
4. Test backend format/color/orientation.
5. Test frontend upload TIFF/BMP.

### Lô D — Trạng thái UI/shared image tools

1. `BgRemoverTool.tsx`: option invalidation, cancel/finally, lỗi domain, theo dõi warmup.
2. `BgRemoverOptions.tsx`: khoá lúc chạy; bỏ import/contract chết hoặc mở UI màu nền đúng chủ đích.
3. `imageBatch/store.ts`: lifecycle blob URL.
4. `UpscaleTool.tsx`: snapshot fallback ổn định.
5. Frontend tests cho state theo tab, đổi option và cleanup.

### Lô E — Chất lượng đối chiếu

Tạo bộ ảnh chuẩn đại diện: chân dung tóc, lông thú, sản phẩm cạnh cứng, kính/bán trong suốt,
nền gần màu chủ thể, ảnh CMYK/print. Ghi metric mask/biên, thời gian và RAM theo từng chế độ
trên CPU, GPU yếu và RTX 3060. Chỉ sau lô này mới chốt lại nhãn “Nhanh / Chất lượng cao /
Tóc-lông-kính” dựa trên dữ liệu.

## 6. Chốt audit

- **Nguyên nhân lỗi hiện tại: đã xác định và tái hiện.**
- **Tách nền hiện chưa sẵn sàng phát hành.**
- **Chưa sửa code trong lượt audit này**, đúng quy trình hai chốt của dự án. Chờ duyệt để bắt
  đầu Lô A, verify xong từng lô rồi mới sang lô kế tiếp.
