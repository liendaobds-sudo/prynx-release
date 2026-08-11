# BÁO CÁO AUDIT ỔN ĐỊNH UPSCALE VÀ SIDECAR

**Ngày:** 2026-08-11  
**Repo:** `D:\pdfcompare`  
**Revision khảo sát:** `5e22f8e` trên `codex/pre-release-audit-2026-08-04`  
**Chế độ:** audit độc lập theo code + test/probe cục bộ; chưa sửa mã production  
**Triệu chứng đầu vào:** bản cài trên máy khác chạy Upscale được 1–2 lần rồi báo `Failed to fetch (http://localhost:8321)`  
**Kết luận:** **NO-GO cho việc đưa bản Upscale hiện tại ra khách ngoài trước khi hoàn thành tối thiểu Lô A–C và QA đa phần cứng.**

> Audit theo code hoàn toàn làm được. Log máy khách không phải điều kiện để phát hiện
> các lỗ hổng kiến trúc bên dưới; log chỉ còn cần để chọn chính xác tác nhân đã giết
> tiến trình trên máy đó (DirectML access violation, GPU OOM/device removed, antivirus
> hay nguyên nhân hệ thống khác).

## 1. Tóm tắt điều hành

Ảnh lỗi không mô tả một exception Python thông thường của route. Nếu route còn sống và
bắt được lỗi, frontend sẽ nhận HTTP `422/500`; ảnh thực tế cho thấy kết nối tới cổng
`8321` không còn, tức transport/backend đã mất tại thời điểm request.

Audit code xác nhận bốn vấn đề chính:

1. Real-ESRGAN/ONNX/DirectML chạy trong **thread của chính tiến trình FastAPI sidecar**.
   Exception Python có fallback, nhưng native access violation/device crash có thể kết
   thúc toàn bộ backend trước khi `except` chạy.
2. Tauri quan sát được sidecar chết nhưng chỉ ghi log. Không có supervisor/respawn;
   `SIDECAR_PID` là `OnceLock`, không thể thay PID cho thế hệ mới. Sau một lỗi native,
   mọi tính năng backend tiếp tục `Failed to fetch` cho tới khi mở lại PrynX.
3. Nhánh `general/balanced` dựng session CPU **trước khi giải phóng chắc chắn session
   DirectML vừa lỗi**. Đây là đúng pattern từng được tái hiện `GPU OOM -> bad allocation`
   và đã sửa ở BiRefNet, nhưng còn sót ở Real-ESRGAN.
4. Chốt RAM Upscale cấp gần như toàn bộ ngân sách khả dụng cho **mỗi job**, trong khi
   scheduler cho 3 job trên máy 32 GB và 4 job trên máy từ 64 GB. Nhiều tab có thể cùng
   vượt ngân sách dù từng request riêng lẻ đều qua guard.

Các test hiện tại đều xanh nhưng chưa phủ các failure mode trên. Frozen release self-test
yêu cầu DirectML tồn tại nhưng cố ý chạy inference bằng CPU; build chỉ warm DirectML một
lượt trên máy build. Vì vậy release có thể đạt gate rồi chết trên một adapter/driver khác.

Không có đủ bằng chứng để nói chính xác máy khách đã chết bởi OOM hay access violation.
Tuy nhiên, việc **một native fault kéo chết toàn backend và app không phục hồi** đã được
chứng minh trực tiếp từ đường chạy production, không phụ thuộc log máy khách.

## 2. Đường chạy live đã trace

```text
UpscaleTool.processUpscaleBatch
  desktop/src/components/preprocess-tools/UpscaleTool.tsx:240-312
    -> POST /api/pdf-tools/upscale
  backend/app/main.py:274-280
    -> upscale_endpoint
  backend/app/api/routes/pdf_tools.py:1892-2157
    -> run_scheduled_in_threadpool("upscale", _process_upscale)
  backend/app/core/heavy_job_scheduler.py:238-247
    -> Starlette/AnyIO threadpool, vẫn trong cùng OS process
  backend/app/workers/realesrgan_engine.py:497-545
    -> _upscale_rgb -> _run_session
  backend/app/workers/realesrgan_engine.py:335-372
    -> onnxruntime.InferenceSession.run (DirectML/CPU native)
```

Đường chết của sidecar:

```text
CommandEvent::Terminated/Error
  desktop/src-tauri/src/lib.rs:5062-5090
    -> chỉ set AtomicBool + log
    -> không respawn, không startup proof mới, không thay PID/token/generation
  frontend POST tiếp theo
    -> fetch ném TypeError
  desktop/src/lib/errorMessages.ts:99-118
    -> hiện "không kết nối được với bộ xử lý" + raw Failed to fetch
```

Sidecar release được spawn một lần tại `desktop/src-tauri/src/lib.rs:5011-5119`.
`SIDECAR_PID` khai báo `OnceLock<u32>` tại `:265-281`, chỉ phục vụ kill cây tiến trình
khi app thoát; toàn repo không có caller respawn/restart sidecar sau runtime termination.

## 3. Mức bằng chứng

| Audit unit | Mức đạt | Ghi chú |
|---|---|---|
| UI -> route -> scheduler -> DirectML | `TRACED + AUTO` | Route và test hiện hữu đạt; native inference nằm cùng process đã trace tới sink. |
| Sidecar chết -> app phục hồi | `TRACED + RUNTIME-PARTIAL` | Code chứng minh không có recovery; ảnh khách chứng minh transport 8321 đã mất. Chưa có exit code/log máy khách. |
| Fallback GPU -> CPU | `TRACED + CROSS-RUNTIME` | Pattern code trùng lỗi BiRefNet đã tái hiện thật ngày 2026-08-05; chưa ép Real-ESRGAN OOM trên máy khách. |
| Ngân sách RAM nhiều job | `TRACED + PROBE` | Tính trực tiếp từ guard/scheduler và RAM máy audit; chưa cố tình OOM máy thật. |
| DirectML hiện tại trên máy audit | `RUNTIME hẹp` | General 6/6 và Quality 3/3 warm inference nhỏ đạt; không đại diện máy khách. |
| Frozen installed DirectML stress | `UNKNOWN` | Self-test frozen chỉ chạy CPU; chưa có corpus nhiều adapter/driver. |

## 4. Bảng finding chính

| ID | Mức | Trạng thái | Effort | Phát hiện |
|---|---|---|---|---|
| `§US.01` | P1 | `[CONFIRMED]` | L | Native DirectML không được cô lập; một crash có thể giết toàn bộ backend. |
| `§US.02` | P1 | `[CONFIRMED]` | M–L | Tauri không restart sidecar sau runtime termination; app hỏng dai dẳng tới khi mở lại. |
| `§US.03` | P1 | `[CONFIRMED]` | S–M | Fallback `general/balanced` tạo CPU session khi session GPU lỗi còn sống. |
| `§US.04` | P1 | `[CONFIRMED]` | M | Guard RAM theo từng request không chia/đặt chỗ theo số job đồng thời. |
| `§US.05` | P2 | `[CONFIRMED]` | M | Release gate không chạy DirectML lặp trên artifact đã cài và không fault-inject worker/sidecar. |
| `§US.06` | P2 | `[CONFIRMED]` | S–M | Log chưa đủ dữ kiện AI crash; không có crash marker/safe mode theo thế hệ tiến trình. |

## 5. Chi tiết finding

### §US.01 — Native inference nằm trong tiến trình backend chính

**Mức:** P1  
**Bằng chứng:** `pdf_tools.py:2103-2110`, `heavy_job_scheduler.py:238-247`,
`realesrgan_engine.py:335-372`.

`run_scheduled_in_threadpool()` chỉ tránh khóa event loop; nó không tạo process. Lời gọi
`session.run()` đi vào `onnxruntime.dll`/DirectML ngay trong sidecar FastAPI. Các nhánh
`except Exception` xử lý được lỗi ORT trả về Python, nhưng không thể bảo vệ tiến trình
khỏi access violation, fail-fast hoặc lỗi native kết thúc process.

**Consumer live:** Upscale và mọi API khác cùng nằm trong sidecar. Một fault Upscale vì
vậy làm Viewer phụ thuộc backend, Preflight, bình bản, tách nền… mất kết nối cùng lúc.

**Bất biến bị vi phạm:** một engine GPU không ổn định theo adapter/driver không được phép
kéo chết toàn bộ dịch vụ nghiệp vụ.

**Hướng đúng:** worker process AI sống lâu, nhận path/manifest nhỏ và ghi output ra path;
session vẫn warm trong worker để giữ tốc độ. Parent sidecar quan sát exit, dọn artifact,
khởi động worker mới và chuyển safe mode CPU khi GPU worker chết lặp.

### §US.02 — Sidecar chỉ được spawn một lần, termination không có recovery

**Mức:** P1  
**Bằng chứng:** `desktop/src-tauri/src/lib.rs:265-281, 5011-5119`.

`CommandEvent::Terminated` và `CommandEvent::Error` chỉ set `sidecar_exited` rồi log tại
`:5079-5085`. Atomic này chỉ được dùng trong startup proof ban đầu. Khi main window đã
hiện, không còn consumer nào phục hồi backend.

`SIDECAR_PID: OnceLock<u32>` không biểu diễn được lifecycle nhiều thế hệ. Child handle,
generation, trạng thái stopping/restarting và token handshake cũng không nằm trong một
supervisor state có thể tái sử dụng.

Frontend cố ý không retry POST Upscale (`desktop/src/lib/api.ts:171-200`) để tránh tạo
job/file hai lần; điều đó đúng, nhưng hiện không có sự kiện `sidecar-recovered` để đưa
item về pending và cho người dùng retry an toàn.

**Hậu quả đã quan sát:** ảnh user đúng với nhánh `errorMessages.ts:99-118`; chờ thêm không
thể tự khỏi vì code không spawn lại tiến trình.

### §US.03 — Fallback giữ đồng thời session DirectML lỗi và session CPU mới

**Mức:** P1  
**Bằng chứng:** `realesrgan_engine.py:309-316, 354-371`.

Ở `general/balanced`, `_run_session()` còn giữ biến local `session` trỏ vào session GPU.
Khi `session.run()` lỗi, `_switch_to_cpu()` ghi đè `_sessions[variant]` bằng một
`InferenceSession` CPU mới nhưng không pop/close/cắt `_sess`/GC session cũ trước đó.
Đỉnh bộ nhớ vì vậy gồm cả tài nguyên DirectML lỗi và thời điểm dựng CPU session.

Đây không phải giả thuyết mới: cùng pattern đã tái hiện thật ở BiRefNet thành
`8007000E Not enough memory resources -> bad allocation` trong
`docs/BAO_CAO_AUDIT_TACH_TEM_ANH_AI_LAN2_2026-08-05.md:145-156`. BiRefNet hiện đã sửa
đúng thứ tự tại `birefnet_engine.py:101-139`; Real-ESRGAN chưa nhận bản vá tương ứng.

Nhánh `quality` pop cache rồi báo lỗi, nhưng cũng không teardown native handle một cách
xác định trước khi lượt sau dựng lại DML session.

**Sửa tối thiểu:** helper đóng session dùng chung, pop cache -> bỏ local/native handle ->
`gc.collect()` -> mới tạo CPU session; thêm test thứ tự lifecycle như BiRefNet. Bản sửa
này giảm crash nhưng không thay thế isolation ở §US.01.

### §US.04 — Nhiều job cùng được hứa toàn bộ RAM khả dụng

**Mức:** P1  
**Bằng chứng:** `pdf_tools.py:63-93`, `heavy_job_scheduler.py:18-56, 87-101`,
`realesrgan_engine.py:416-453`.

Guard tính:

```text
usable_mb = (available_mb - 1024) * 0,70
pass nếu estimated_peak_mb của MỘT job <= usable_mb
```

Nó không gọi `max_active_heavy_jobs()` và không đặt chỗ byte atomically. Trong khi đó
scheduler cho 3 slot ở 16–64 GB và 4 slot từ 64 GB. Nhiều tab có controller riêng tại
`UpscaleTool.tsx:245-250`, nên các request thật có thể đồng thời.

Probe trên máy audit:

```text
RAM total         32.527,9 MB
RAM available     18.144,8 MB
heavy slots       3
guard mỗi job     11.984,5 MB
share 3 job        3.994,8 MB/job
```

Theo đúng công thức production, một ảnh vuông khoảng `6266 px` vẫn qua guard cho từng
job; ba job chỉ an toàn quanh `3618 px/job` nếu cùng giữ peak. `_upscale_rgb()` cấp mảng
output full-size trước khi vào khóa `session.run`, nên cùng model bị serialize ở GPU vẫn
có thể giữ nhiều output buffer lớn đồng thời.

**Sửa đúng quy tắc máy mạnh:** không hard-cap kích thước/worker. Dùng reservation manager
atomically theo byte: job lớn được dùng nhiều RAM khi chạy một mình; job tiếp theo chờ
khi tổng reservation vượt ngân sách. Máy mạnh còn đủ RAM vẫn chạy song song đầy đủ.

### §US.05 — Gate phát hành chứng minh package, chưa chứng minh ổn định DirectML máy đích

**Mức:** P2  
**Bằng chứng:** `artifact_runtime_self_test.py:175-230`,
`build_production.ps1:923-929`, `verify_installed_artifact.ps1:599-608`.

Frozen self-test bắt buộc có `DmlExecutionProvider`, nhưng `_run_cpu_inference()` tạo
session với `providers=["CPUExecutionProvider"]`. Nó chứng minh model/hash/ABI CPU, không
gọi DirectML trên máy đã cài. Build warmup gọi general/quality một lượt, nhưng chạy trên
máy build, không đại diện Intel iGPU, AMD, NVIDIA, hybrid laptop hoặc driver cũ của khách.

54 test liên quan hiện tại đạt; `test_realesrgan_concurrency.py` và phần lớn
`test_upscale.py` dùng fake session. Không có test process worker chết, access violation,
GPU OOM rồi fallback, sidecar termination rồi respawn, hoặc 10–20 inference lặp trên
artifact installed.

**Hướng sửa:** tách `CPU artifact smoke` và `GPU compatibility/stability smoke`; bản QA
installed chạy lặp có giới hạn, ghi adapter/provider/driver/ORT, peak RSS và exit code.
Không chạy stress nặng mỗi lần mở app của khách.

### §US.06 — Chẩn đoán production chưa đủ để phân loại native crash

**Mức:** P2  
**Bằng chứng:** `backend/app/main.py:47-76`, `desktop/src-tauri/src/lib.rs:4735-4760,
5062-5089`.

Hai log hiện có là nền tảng tốt:

- `%APPDATA%\PrynX\logs\app.log` ghi log Python;
- `%LOCALAPPDATA%\com.prynx.app\logs\PrynX.log` ghi termination của sidecar.

Nhưng mỗi job Upscale chưa ghi correlation tối thiểu gồm mode/factor/kích thước, provider,
adapter, phase (`session-create/probe/run/encode`) và thế hệ worker. Không có crash marker
atomic để lần khởi động sau biết GPU worker vừa chết, cũng không có safe mode theo phiên.
Native crash có thể cắt `app.log` trước exception nên chỉ còn một dòng termination không
đủ phân biệt OOM, access violation, device removed hay antivirus.

**Hướng sửa:** log cấu trúc ở ranh giới job, faulthandler/crash breadcrumb riêng, exit
code + generation ở supervisor; không log từng tile và mặc định không bật profiling nặng.

## 6. Các giả thuyết đã kiểm và không gắn finding sai

### `[DISPROVED]` Real-ESRGAN đang chạy DirectML với memory pattern bật

Source không truyền `SessionOptions`, trong khi tài liệu chính thức yêu cầu DirectML dùng
`ORT_SEQUENTIAL` và tắt memory pattern. Tuy nhiên probe trên đúng ORT `1.24.4` hiện tại cho:

```text
providers          DmlExecutionProvider, CPUExecutionProvider
execution_mode     ORT_SEQUENTIAL
enable_mem_pattern False
```

Runtime Python đã áp cấu hình hiệu dụng đúng, nên không dùng code smell này làm nguyên
nhân crash. Nên thêm assertion regression để một bản ORT khác không làm trôi contract.

Tài liệu: <https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html>

### `[EXPECTED]` Hai model khác nhau có thể Run song song

Engine khóa từng session tại `realesrgan_engine.py:62-67, 319-332`; test xác nhận cùng
session không Run đồng thời. Tài liệu DirectML cho phép nhiều thread Run đồng thời nếu
chúng dùng các session khác nhau. Vì vậy không đề xuất một global lock vô điều kiện chỉ
để “chữa” cảm tính; vấn đề thật là memory reservation và fault containment.

### `[NOT PROVEN]` Tác nhân chính xác trên máy khách

Chưa có hai file log của máy lỗi nên chưa thể phân biệt:

- native access violation/driver reset;
- DirectML OOM rồi fallback bad allocation;
- antivirus/EDR kết thúc sidecar;
- nguyên nhân mạng/cổng khác.

Khoảng trống này không phủ định §US.01–§US.06. Các lô sửa được thiết kế để app vẫn sống
và tự chẩn đoán được dù tác nhân cụ thể là nhánh nào.

## 7. Test và probe đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `pytest test_upscale + concurrency + artifact self-test + scheduler` | `54 passed`, 2 warning thư viện |
| ORT/package trên máy audit | `onnxruntime 1.24.4`; DML + CPU có mặt |
| Session options hiệu dụng | sequential; memory pattern tắt |
| Warm inference nhỏ `general` | 6/6 đạt; cold `0,635 s`, warm khoảng `0,002–0,003 s` |
| Warm inference nhỏ `quality` | 3/3 đạt; cold `1,891 s`, warm khoảng `0,019 s` |
| RAM/scheduler probe | 32 GB, 3 slot; guard per-job lớn gấp 3 share đồng thời |
| Stress trên đúng máy khách lỗi | Chưa chạy; không có quyền truy cập máy đó |
| Fault injection native worker/sidecar | Chưa có harness production để chạy an toàn |

Kết quả xanh trên máy audit chỉ chứng minh model/package cục bộ hoạt động; không nâng
thành parity/ổn định đa phần cứng.

## 8. Kế hoạch sửa sau chốt duyệt

Mỗi lô tối đa 5 file, verify xong mới sang lô tiếp theo.

### Lô A — Chặn OOM/fallback lặp ngay trong engine

Mục tiêu: đóng `§US.03` và phần backend của `§US.04` trước khi đổi kiến trúc.

1. Tách helper tạo/teardown session DirectML/CPU đúng thứ tự; dùng cả Real-ESRGAN,
   giữ provider/options explicit và có test lifecycle.
2. Thêm reservation RAM atomically theo estimated bytes, không hard-cap máy mạnh.
3. Queue job khi tổng reservation thiếu; cancel khi đang chờ phải giải phóng sạch.
4. Test hai/ba job đồng thời, GPU fail -> CPU create, cancel và RAM tier.

**Gate:** không còn thời điểm GPU-failed + CPU-new cùng sống; tổng reservation không vượt
budget; một job lớn trên máy mạnh vẫn dùng được toàn phần RAM còn trống khi chạy một mình.

### Lô B — Cô lập Real-ESRGAN khỏi FastAPI sidecar

Mục tiêu: đóng `§US.01`.

1. Worker process AI persistent, spawn-safe dưới Nuitka; IPC chỉ truyền path/options/token
   nhỏ, không copy ảnh hàng chục MB qua Pipe.
2. Session warm/cache ở worker; output ghi path tạm rồi atomic promote.
3. Parent phát hiện worker exit/timeout, dọn artifact/reservation và trả lỗi có mã.
4. GPU worker chết lặp thì restart ở safe mode CPU cho General/Balanced; Quality báo rõ
   không khả dụng, không âm thầm chạy CPU hàng chục phút.
5. Fault-injection test `worker os._exit` chứng minh `/health` và các API khác vẫn sống.

**Gate hiệu năng:** steady-state không chậm đáng kể so với hiện tại; warm session được giữ;
không serialize/copy full raster qua IPC.

### Lô C — Sidecar supervisor ở Tauri

Mục tiêu: đóng `§US.02` như lớp bảo vệ cuối cho mọi engine backend.

1. Thay `OnceLock<PID>` bằng state nhiều thế hệ có child/PID/generation/stopping.
2. Tách `spawn + token stdin + startup proof` thành hàm dùng lại.
3. Runtime termination ngoài lúc app thoát -> backoff có trần -> respawn -> proof lại.
4. Emit trạng thái `backend-down/restarting/ready`; không tự replay POST Upscale.
5. Test kill sidecar thật: main app vẫn phản hồi, backend lên lại, item Upscale về pending.

### Lô D — Release QA và telemetry đa phần cứng

Mục tiêu: đóng `§US.05–06`.

1. GPU stability smoke riêng cho artifact installed, lặp có giới hạn cả General/Quality.
2. Fault-inject worker và sidecar; verifier bắt buộc marker recovery.
3. Ghi adapter/driver/provider/ORT/phase/exit code theo job correlation, không log mỗi tile.
4. Ma trận tối thiểu: Intel iGPU, AMD, NVIDIA, laptop hybrid; 8/16/32 GB; driver mới/cũ.
5. Xác nhận CPU safe mode và restart không đổi ICC/DPI/alpha/kích thước vật lý.

### Lô E — Nghiệm thu sản phẩm

1. 20–50 lần liên tiếp trên mỗi máy đích, cả ×2/×4 và ba mode.
2. Hai tab chạy cùng lúc, cancel, đóng tab, chuyển công cụ, sleep/resume GPU.
3. Đo P50/P95, peak RSS/VRAM, thời gian recovery và artifact orphan.
4. Chỉ đổi verdict sau clean build + installed verification; không suy từ dev.

## 9. Hiệu quả kỳ vọng sau sửa

- Native GPU lỗi chỉ làm hỏng job Upscale hiện tại, không giết Preflight/bình bản/toàn app.
- Backend sidecar chết ngoài dự kiến có thể lên lại trong vài giây thay vì bắt user mở lại.
- General/Balanced chuyển safe mode có kiểm soát; Quality không treo CPU âm thầm.
- Nhiều tab chỉ chạy song song khi RAM thật sự đủ; máy mạnh không bị cap cố định.
- Worker persistent giữ model warm, nên steady-state có thể giữ tốc độ hiện tại trong khi
  độ ổn định tăng rõ rệt.
- QA bắt được lỗi theo GPU/driver trước khi installer tới khách.

## 10. Kết luận và chốt duyệt

**Có thể audit theo code, và audit đã tìm được lỗi kiến trúc đủ nghiêm trọng mà không cần
truy cập máy khách.** `Failed to fetch` không phải lỗi riêng UI Upscale: nó là hậu quả của
backend không còn phục vụ và không có recovery.

Không nên vá bằng retry fetch hoặc tự động lặp POST. Hướng đúng là ba lớp:

1. lifecycle + reservation đúng;
2. cô lập DirectML vào worker process;
3. supervisor sidecar + QA installed đa GPU.

Theo quy trình hai chốt, audit dừng tại đây và **chưa sửa code**. Chờ duyệt danh sách
finding/lô trước khi triển khai.
