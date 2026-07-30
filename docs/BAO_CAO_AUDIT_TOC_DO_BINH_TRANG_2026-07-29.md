# BÁO CÁO AUDIT TỐC ĐỘ BÌNH TRANG — CA 13 LOẠI TEM

**Ngày:** 29/07/2026  
**Trạng thái:** CHỜ DUYỆT — chưa sửa mã nguồn  
**Mốc code khảo sát:** `6ab5916` (worktree đang có nhiều thay đổi chưa commit của người dùng, audit không đụng vào các thay đổi đó)  
**Phạm vi:** nhận diện khuôn, tính “Tem/tờ”, preview, lập kế hoạch N-Up/Step & Repeat, render nhiều tiến trình, ghép PDF, hậu xử lý và thời gian mở kết quả phía desktop.

> Quy ước: **P0** = chặn trực tiếp ca thực tế; **P1** = ảnh hưởng lớn; **P2** = tối ưu tiếp theo. **S/M/L** = công sửa nhỏ/vừa/lớn. Số “nhanh hơn” trong báo cáo chỉ áp dụng cho phép đo ghi rõ; không được hiểu là cam kết cho toàn bộ thời gian từ lúc bấm RUN đến lúc trang đầu tiên hiển thị.

---

## 1. Kết luận điều hành

Ca người dùng vừa chạy đã được tìm thấy trong nhật ký và file kết quả vẫn còn nguyên:

- File: `%TEMP%\PrynX-dev\results\sticker_f6a779ea.pdf`
- 13 trang, 933.552 byte
- Máy đo: 16 logical CPU, khoảng 32 GB RAM
- Nhận diện 13 khuôn: **0,919 giây**
- Batch tính “Tem/tờ”: backend **11,638 giây**, frontend quan sát **11,662 giây**
- 13 trang tạo 13 nhóm hình học riêng, không tái sử dụng, backend dùng hard-cap 4 worker
- Trong lúc batch chạy, frontend còn phát hai preview chồng lên nhau: **1,535 giây** và **4,978 giây**

Nút thắt lớn nhất đã được xác minh bằng thử nghiệm runtime trên đúng file: với khuôn `CUSTOM`, engine vẫn tính hai phương án NFP đầu–đuôi rất nặng, nhưng orchestrator không dùng các kết quả đó. Khi chỉ bỏ phép tính bị vứt đi trong runtime benchmark, không sửa source:

| Phép đo trên đúng file 13 loại | Hiện tại | Bỏ NFP thừa | Kết quả |
|---|---:|---:|---:|
| Batch 13 loại, 1 worker | 10,111 s | 0,472 s | nhanh hơn khoảng **21,4×** |
| Gọi layout trực tiếp cho 13 loại | 5,452 s | 0,253 s | nhanh hơn khoảng **21,5×** |

Capacity của cả 13 trang không đổi; toàn bộ placement không đổi; SHA-256 của dữ liệu placement ở hai nhánh cùng là:

`fe8ea673a7dd32758ea1e6a65355ba292c66eee383c0fc9150f2df3c7f6b453b`

Vì vậy, **lô sửa đầu tiên nên bỏ công việc không được sử dụng**, không phải tăng worker. Benchmark hiện tại cho thấy tăng luồng mù không hiệu quả:

| Worker | Thời gian batch hiện tại |
|---:|---:|
| 1 | 10,111 s |
| 2 | 6,166 s |
| 4 | 7,076 s |
| 8 | 7,334 s |

Sau quick win trên, cần xử lý ba nguồn lãng phí còn lại: mở lại toàn bộ PDF theo từng loại tem, request/preview cũ vẫn chạy sau khi người dùng đổi chế độ, và export mixed MaxRects tính full NFP cho từng loại rồi bỏ kết quả.

---

## 2. Baseline và giới hạn phép đo

### 2.1 Timeline đúng phiên người dùng

Nguồn: `logs/preview_perf.log:13330-13360`.

| Mốc | Thời gian | Ghi chú |
|---|---:|---|
| Nhận diện 13 khuôn | 0,919 s | Cả 13 được nhận là `CUSTOM`, nguồn separation |
| Batch “Tem/tờ” bắt đầu | 19:11:17.963 | `task_mode=nup`, 13 geometry group, 4 worker |
| Preview “Dàn nhiều mẫu” | 1,535 s | Chạy chồng batch từ 19:11:18.022 |
| Preview “Bình trang” | 4,978 s | Người dùng đã đổi mode, bắt đầu 19:11:22.174 |
| Batch cũ hoàn tất | 11,638 s | Kết thúc 19:11:29.600 dù mode đã đổi |

Timeline:

```text
19:11:17.963  Batch N-Up cũ ├──────────────────────────────┤ 11,638 s
19:11:18.022  Preview N-Up    ├────┤                         1,535 s
19:11:22.174  Preview Repeat             ├────────────┤       4,978 s
```

Ba phép tính tranh CPU cùng lúc, nên con số người dùng cảm nhận không phải chi phí của một tác vụ đơn lẻ.

### 2.2 Chưa có số đo RUN → trang đầu tiên hiển thị

Telemetry hiện có đo được detect, preview và batch capacity, nhưng chưa nối đầy đủ các mốc:

`bấm RUN → nhận job → chờ hàng đợi → plan → render → merge → hậu xử lý → frontend thấy completed → tab mount → metadata sẵn sàng → tile đầu tiên hiển thị`

Do đó audit có thể khẳng định batch “Tem/tờ” mất khoảng 11,6 giây và chỉ ra các hotspot export, nhưng chưa được phép khẳng định toàn bộ 10 giây người dùng báo nằm ở một stage duy nhất. Lô triển khai phải thêm telemetry có gate trước hoặc cùng lúc với sửa đầu tiên.

### 2.3 Baseline export trên fixture 13 trang

Một lượt đo cô lập pipeline export cho fixture 13 trang cho kết quả:

| Stage | Thời gian |
|---|---:|
| Lập kế hoạch | 0,891 s |
| Render chunk | 4,125 s |
| Merge | 2,062 s |
| Hậu xử lý | 1,828 s |
| **Tổng** | **9,016 s** |

Đây là baseline audit, không thay thế phép đo end-to-end trên thao tác RUN thật. Một thử nghiệm 7 chunk đạt 6,674 giây và raster hash 14 trang giống nhau, nhưng mới có một lượt đo nên chỉ là giả thuyết cho lô sau, chưa phải cấu hình đề xuất.

---

## 3. Phát hiện có bằng chứng

### PERF-IMPO-01 — P0 / S — `CUSTOM` tính NFP p5/p6 rồi vứt bỏ

**Vị trí:**

- `backend/app/workers/sticker_imposer_pkg/layout_compute.py:334-374`
- `backend/app/workers/sticker_imposer_pkg/orchestrator.py:187-264`
- Hot function: `backend/app/workers/nup_diecut.py:392-818`

`layout_compute` luôn gọi `get_optimal_head_to_tail_overlap()` để tạo p5/p6 và các biến thể. Với `shape_type == 'CUSTOM'`, orchestrator dùng nhánh polygon riêng và không đọc p5/p6.

`cProfile` trên workload audit:

- `nup_diecut.py:392 calc_params`: 26 lần, **12,334 / 13,527 giây**
- 76.299 phép Shapely `translate`
- 88.349 phép `intersects`

**Xác minh an toàn:** runtime bypass trên đúng file giữ nguyên capacity và hash placement, trong khi thời gian layout 13 loại giảm 5,452 → 0,253 giây.

**Đề xuất:** tách “lấy polygon” khỏi “giải overlap/NFP”; chỉ tính p5/p6 cho các shape/strategy thật sự đọc chúng. Giữ nguyên polygon phục vụ collision và xuất đường bế.

### PERF-IMPO-02 — P1 / M — Batch mở toàn bộ PDF 14 lần

**Vị trí:**

- Document chính: `backend/app/api/routes/imposition.py:4044`
- Mỗi geometry group mở/đóng lại document: `backend/app/api/routes/imposition.py:4092-4098`
- Wrapper materialize page list khi mở: `backend/app/workers/sticker_imposer_pkg/pdf_wrapper.py:151-156`
- Cache layout chỉ được kiểm sau khi đã mở PDF: `backend/app/api/routes/imposition.py:3905-3933`

Với 13 nhóm khác nhau, batch mở file 1 lần ở ngoài và 13 lần trong worker. Benchmark fixture:

- Cold cache: **3,98 giây**, 14 lần mở
- Warm cache: **0,297 giây**, vẫn 14 lần mở

**Đề xuất:** kiểm cache trước khi mở; phân nhóm công việc theo worker; mỗi worker mở một document rồi xử lý nhiều geometry group. Sau thay đổi mới benchmark lại số worker.

### PERF-IMPO-03 — P1 / M — Request cũ và preview chạy chồng

**Vị trí:**

- Batch effect chỉ phụ thuộc `fetchEpoch`: `desktop/src/components/imposition-tools/ImposerDashboard.tsx:767-955`
- Reset key thiếu `taskMode`/`layoutType`: cùng file `:750-758`
- Cleanup không abort `batchCapAbortRef`: cùng file `:953`
- Preview debounce không biết trạng thái RUN: `desktop/src/components/imposition-tools/sections/GridPreview.tsx:1174-1226`

Trong log thật, batch mode `nup` vẫn chạy đến hết sau khi người dùng đổi sang `step_repeat`. `AbortController` hiện chỉ ngắt phía client; route sync phía backend vẫn có thể tiếp tục ăn CPU.

**Đề xuất:** generation guard cho kết quả stale; hủy timer/request preview khi RUN; không phát preview nặng mới trong khi job đang xử lý; thêm cooperative cancellation giữa các geometry group ở backend. Không dùng hủy cứng giữa một lời gọi PDFium.

### PERF-IMPO-04 — P1 / M — Export mixed MaxRects tính full layout rồi bỏ

**Vị trí:**

- Tính `full_layouts` cho các trang: `backend/app/workers/nup_engine.py:900-1032`
- Nhánh auto-fill mixed chỉ dùng kích thước và MaxRects: `:1942-1978`
- Nhánh mixed có số lượng cũng không dùng full NFP: `:2040-2059`

Microbenchmark 13 contour vector tổng hợp:

- Chỉ dựng polygon: **0,085 giây**
- Polygon + full NFP: **5,707 giây**
- Chênh lệch khoảng **67×** ở stage này

**Đề xuất:** phát hiện homogeneous trước. Chỉ tính full layout cho `repeat`, single-template, homogeneous master, hoặc cluster strategy thật sự cần shape-aware layout. Mixed MaxRects thường không được tính NFP cho mọi loại.

### PERF-IMPO-05 — P1 / M — Cache thiếu single-flight và bỏ geometry đã nhận diện

**Vị trí:**

- `_NEST_A_CACHE`: `backend/app/api/routes/imposition.py:3571-3572,3929-3984`
- Detection đã có `DetectedShape.poly`: `backend/app/workers/sticker_imposer_pkg/die_detection.py:114-121`
- Response legacy bỏ polygon: `die_detection.py:248-263`

Cache kiểm miss dưới lock rồi thả lock trước khi compute. Batch và preview có thể cùng miss rồi tính một trang song song; log thật cho thấy preview bắt đầu chỉ 59 ms sau batch. Đồng thời detection đã tìm được polygon nhưng batch/preview lại mở PDF và trích contour từ đầu.

**Đề xuất:** single-flight theo cache key; cache geometry nội bộ theo `(path, size, mtime, page, detection settings)` hoặc trả token ngắn thay vì đẩy polygon lớn qua frontend.

### PERF-IMPO-06 — P1 / M — Hard-cap 4 worker trái chính sách, nhưng tăng worker chưa phải cách sửa

**Vị trí:** `backend/app/api/routes/imposition.py:4083`

Máy hiện tại có 32 GB RAM/16 logical CPU nhưng batch bị khóa `min(4, ...)`. Đây là cap vô điều kiện, trái nguyên tắc máy ≥16 GB chạy đầy đủ. Tuy nhiên benchmark 1/2/4/8 worker cho thấy 4 và 8 còn chậm hơn 2 vì GIL, mở PDF lặp và contention.

Rust NFP hiện cũng chưa nhả GIL:

- `native/src/nfp_solver.rs`
- Microbenchmark: tuần tự **0,169 giây**, 4 thread **0,173 giây**

**Đề xuất:** không đổi `4 → 13` trực tiếp. Sửa PERF-IMPO-01/02 trước, nhả GIL cho phần Rust an toàn, rồi benchmark lại worker theo hardware profile và RSS. Máy `<8 GB`/`<16 GB` mới giảm; máy `≥16 GB` không hard-cap vô điều kiện.

### PERF-IMPO-07 — P2 / M–L — Cache batch không sang process export

Batch capacity và preview cache trong process FastAPI chính. Export lại tạo outer process mới tại `backend/app/api/routes/imposition.py:1111-1121`, nên mode `repeat` có thể tính lại 13 layout vừa xác minh.

**Đề xuất:** tạo job-scoped layout plan/token có version và chữ ký đầy đủ; worker export chỉ tái sử dụng khi geometry/settings/hash trùng tuyệt đối. Không chia sẻ object PDFium giữa process.

### PERF-IMPO-08 — P2 / M — Chunk/merge/hậu xử lý còn nhiều lượt ghi file

**Vị trí:**

- Chia chunk: `backend/app/workers/nup_engine.py:3217-3242`
- Merge: `:3364-3465`
- Dời trang khuôn bằng cách mở/save lại toàn output: `:3474-3497`
- Watermark/report: `:3503-3517,3604-3632`

Trên fixture, merge + hậu xử lý chiếm **3,89 / 9,02 giây**. Khi số tờ ≤ số core, engine có thể tạo một process/chunk cho mỗi tờ, trả phí spawn và merge cao.

**Đề xuất:** benchmark nhiều lần 1/2/4/7/13 chunk cùng RSS; dời trang khuôn ngay trong lần merge; hợp nhất watermark/report vào final pikepdf pass nếu giữ nguyên OCG, box và metadata.

### PERF-IMPO-09 — P1 / S — Thiếu telemetry end-to-end nên dễ tối ưu nhầm

Hiện `plan_s` gộp detection, contour, NFP và packing; frontend thiếu mốc click-to-first-paint.

**Đề xuất thêm các mốc có gate `PRYNX_PERF=1`:**

- Frontend: `run_click`, `job_accepted`, `completed_observed`, `tab_mounted`, `metadata_ready`, `first_tile_loaded`
- Backend: `queue_wait_s`, `canonicalize_s`, `die_scan_s`, `full_layout_s`, `mixed_pack_s`, `render_chunks_s`, `merge_s`, `postprocess_s`
- Context: loại mode, số type/page/placement/chunk/worker, cache hit/miss, CPU/RAM tier

Log audit hiện đang bật mặc định và ghi ở cả frontend/backend/Rust. Sau khi đủ telemetry phải gate theo dev/perf flag và có rotation; không để I/O log ảnh hưởng bản release.

### PERF-IMPO-10 — P2 / S–M — Đuôi chờ và fast-path dev

- Polling sau lần đầu vẫn cố định 500 ms: `desktop/src/lib/processHandlers.ts:175-177,250-256`, tạo trễ trung bình khoảng 250 ms và tối đa gần 500 ms.
- Backend chỉ trả `output_path` khi `IS_DESKTOP_APP=true`: `backend/app/api/routes/imposition.py:1352-1355`. `run_dev.bat` chạy uvicorn riêng nên dev có thể tải toàn output qua WebView rồi upload lại khi commit; release đã có fast-path path-backed.

**Đề xuất:** telemetry trước; sau đó cho Tauri dev dùng path local an toàn, giảm nhịp poll gần thời điểm hoàn tất hoặc dùng event, và giữ auto-save ngoài đường first-paint.

---

## 4. Thứ tự triển khai đề xuất

Mỗi lô tối đa 5 file và phải verify xong trước khi sang lô kế.

### Lô 0 — Telemetry có gate, không đổi thuật toán

**Mục tiêu:** đo đúng RUN → first paint và tách stage export.

**File dự kiến (≤5):**

1. `backend/app/workers/nup_engine.py`
2. `backend/app/api/routes/imposition.py`
3. `desktop/src/lib/processHandlers.ts`
4. `desktop/src/hooks/viewer/usePdfLoader.ts`
5. `desktop/src/lib/previewPerfLog.ts`

**Chốt:** log chỉ bật khi dev/`PRYNX_PERF=1`; không ghi đồng bộ hai lần; một run có correlation id xuyên frontend/backend.

### Lô 1 — Bỏ NFP thừa cho `CUSTOM`

**Mục tiêu:** đưa batch 13 loại từ khoảng 10–11,6 giây về vùng dưới 1,5 giây warm trên máy audit, không đổi placement.

**File dự kiến (≤3):**

1. `backend/app/workers/sticker_imposer_pkg/layout_compute.py`
2. `backend/app/workers/sticker_imposer_pkg/orchestrator.py` nếu cần làm rõ contract
3. Test mới hoặc test parity gần nhất trong `backend/tests/`

**Chốt:** capacity 13/13 giống; placement hash giống; thêm case contour lõm, có lỗ, MultiPolygon và các strategy đang dùng p5/p6.

### Lô 2 — Cache-before-open và một PDF/worker

**Mục tiêu:** bỏ 14 lần mở file, tránh compute trùng giữa batch/preview.

**File dự kiến (≤4):**

1. `backend/app/api/routes/imposition.py`
2. `backend/app/workers/sticker_imposer_pkg/pdf_wrapper.py`
3. `backend/app/workers/sticker_imposer_pkg/die_detection.py` nếu dùng geometry token
4. Test concurrency/cache trong `backend/tests/`

**Chốt:** cache key gồm path/size/mtime/page/toàn bộ setting; single-flight không deadlock; PDFium không dùng chung qua thread thiếu `pdfium_guard()` và không dùng chung qua process.

### Lô 3 — Chặn request stale và preview tranh CPU

**Mục tiêu:** khi đổi mode hoặc bấm RUN, công việc cũ không tiếp tục tranh CPU và kết quả cũ không ghi đè state mới.

**File dự kiến (≤4):**

1. `desktop/src/components/imposition-tools/ImposerDashboard.tsx`
2. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
3. `backend/app/api/routes/imposition.py`
4. Test frontend/backend liên quan

**Chốt:** generation guard; cleanup abort; cooperative cancel giữa group; không hủy trong vùng PDFium đang khóa; đổi `nup ↔ step_repeat` liên tục không còn batch cũ chạy đến hết.

### Lô 4 — Bỏ `full_layouts` thừa trong mixed MaxRects

**Mục tiêu:** giảm mạnh `plan_s` của Dàn nhiều mẫu 13 loại.

**File dự kiến (≤3):**

1. `backend/app/workers/nup_engine.py`
2. `backend/tests/test_sticker_homogeneous_layout.py` hoặc test parity phù hợp
3. Golden/parity test mới cho mixed auto/fixed quantity

**Chốt:** không đổi repeat/single-template/homogeneous/cluster; page count, sheet count, placement, OCG và cut path giống baseline.

### Lô 5 — Worker/chunk theo phần cứng và giảm lượt ghi PDF

**Mục tiêu:** tận dụng máy mạnh sau khi bỏ bottleneck tuần tự; giảm merge/postprocess.

**File dự kiến (≤5):**

1. `backend/app/workers/nup_engine.py`
2. `backend/app/api/routes/imposition.py`
3. `backend/app/core/system_memory.py` hoặc hardware profile SSOT hiện có
4. `native/src/nfp_solver.rs` nếu NFP Rust vẫn là hotspot sau profile
5. Test benchmark/worker gating

**Chốt:** không hard-cap máy ≥16 GB; máy <8/<16 GB mới giảm; theo dõi peak RSS; 1/2/4/7/13 chunk phải chạy lặp tối thiểu 5 lần trước khi chọn.

### Lô 6 — Tái sử dụng layout plan và tối ưu first paint

Chỉ làm sau khi số liệu cho thấy còn đáng kể: truyền layout token sang process export, path-backed output trong dev, mở tab trước rồi auto-save sau, polling/event, memo tab và metadata fast-path. Đây là lô rủi ro cao hơn vì chạm vòng đời job/file; phải tách thành các batch nhỏ độc lập khi triển khai.

---

## 5. Ma trận benchmark và điều kiện nghiệm thu

### 5.1 Bộ ca bắt buộc

| Ca | Mục đích |
|---|---|
| File thật 13 loại `CUSTOM` | Bắt đúng hồi quy người dùng vừa gặp |
| 13 trang cùng một khuôn | Kiểm cache theo chữ ký geometry/homogeneous |
| 1 loại tem | Không làm job nhỏ chậm hơn vì orchestration |
| Mixed auto-fill và fixed quantity | Xác minh bỏ `full_layouts` thừa |
| Step & Repeat / repeat | Bảo đảm vẫn dùng full layout khi cần |
| Tròn, chữ nhật, lục giác, mũi tên, polygon lõm | Kiểm contract p5/p6 theo shape |
| Contour có lỗ và MultiPolygon | Không làm sai va chạm/đường bế |
| Máy tier <8 GB, <16 GB, ≥16 GB | Kiểm RAM gating và số worker |

### 5.2 Số đo phải thu

- Median, p95 và min/max của tối thiểu 5 lượt warm; thêm 1 lượt cold riêng
- CPU tổng, peak RSS, số process/thread, số lần mở PDF
- Cache hit/miss/single-flight wait
- Thời gian từng stage và tổng click-to-first-tile
- Số trang/tờ/placement/chunk/worker

### 5.3 Parity bắt buộc

- Capacity và placements giống baseline
- Số trang, MediaBox/CropBox/TrimBox/BleedBox giống
- OCG/layer, đường bế, overprint và spot color còn nguyên
- Raster diff/golden ở DPI quy định của test suite
- Không cập nhật golden chỉ để làm test xanh; chỉ `-u` khi thay đổi hình học là chủ đích và đã soi diff
- Không chia sẻ PDFium giữa thread nếu thiếu `pdfium_guard()`; vùng khóa chỉ bao lời gọi PDFium

### 5.4 Mục tiêu hiệu năng

Các mục tiêu dưới đây là tiêu chí cho máy audit 32 GB, không phải con số cam kết cho mọi file:

- Batch “Tem/tờ” 13 `CUSTOM`: **≤1,5 giây warm** sau Lô 1–2
- Không còn batch/preview mode cũ chạy chồng sau khi đổi mode/RUN
- Mixed export: giảm tối thiểu **30% `plan_s`** sau Lô 4; target cuối sẽ chốt bằng telemetry Lô 0
- Không tăng peak RSS quá 20% để đổi lấy tốc độ nếu không có bằng chứng tổng thể tốt hơn
- Máy ≥16 GB không bị hard-cap vô điều kiện; máy yếu vẫn được RAM-gating

---

## 6. Những tối ưu cũ đã có — không làm lại

Audit đã đối chiếu và xác nhận các mục sau đang tồn tại trong code:

- Cache raw page/wrapper trong `pdf_wrapper.py`
- Repeat bookkeeping từ O(S²) về O(S)
- Cleanup canonical temp
- Local-path fast path đầu vào và output path trong release
- Embed Form XObject một lần/mẫu
- ShapeBuilder không còn nối bytes O(N²)
- Job timestamps và polling lần đầu gọi ngay

Không nên mở lại các hạng mục này nếu benchmark mới không chứng minh hồi quy.

---

## 7. Chốt duyệt

Audit đã đủ bằng chứng để bắt đầu **Lô 0 + Lô 1**. Chưa có mã nguồn nào được sửa trong vòng audit này; chỉ báo cáo và các fixture/benchmark tạm được tạo. File thật của người dùng không bị thay đổi.

Sau khi người dùng duyệt, thực hiện từng lô ≤5 file, verify hẹp rồi verify cuối; nếu parity không đạt thì dừng và quay lại baseline, không chuyển sang lô tiếp theo.
