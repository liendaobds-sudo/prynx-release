# BÁO CÁO AUDIT TỔNG HỢP: PPE, VIEWER GPU VÀ XỬ LÝ FILE NẶNG

**Ngày:** 25/09/2026  
**Trạng thái:** ĐÃ DUYỆT VÀ ĐANG TRIỂN KHAI — các lô sửa được ghi trong `docs/PPE_HEAVY_PERF_FIXES_2026-09-25.md`  
**Phạm vi:** Desktop Tauri/WebView2, Viewer WGPU/PPE, Rust render worker, FastAPI/Python, các tác vụ PDF nặng.  
**Tài liệu đối chiếu:**

- docs/BAO_CAO_AUDIT_XU_LY_FILE_NANG_2026-09-25.md
- .tmp/render-diagnostics/PrynX_RenderPerf.log
- docs/BAO_CAO_AUDIT_TUONG_THICH_VIEWER_GPU_2026-09-25.md
- docs/BAO_CAO_AUDIT_ZOOM_THUC_TE_2026-09-25.md
- docs/PPE_VIEWER_PERF_FIXES_2026-09-11.md
- AGENTS.md, prynx-performance, prynx-audit-workflow

## 1. Kết luận điều hành

PrynX hiện **tương thích với máy Windows x64 16 logical cores, 32 GB RAM và có GPU WGPU**, đồng thời đã sử dụng được cả CPU, PPE worker và GPU scene. Tuy nhiên hệ thống **chưa đạt trạng thái tối ưu ổn định khi xử lý file nặng**.

Nguyên nhân chính không phải thiếu sức mạnh phần cứng mà là thiếu một lớp điều phối tài nguyên xuyên tầng:

1. Worker được mở theo RAM tổng/CPU, nhưng chưa giảm đủ nhanh theo RAM khả dụng thực tế.
2. Tile cache trên máy mạnh có thể ở chế độ không giới hạn.
3. PPE accurate, thumbnail/background render và GPU scene có thể tranh chấp cùng lúc.
4. GPU path chưa ghi đủ adapter/VRAM/driver/occupancy để chứng minh thiết bị cụ thể đang được tận dụng tối đa.
5. Một số đường xử lý file nặng vẫn fan-out theo CPU mà chưa tính working set thật của file, kích thước trang và số object.

### Kết luận ngắn

- **Tương thích phần cứng:** đạt.
- **Tận dụng CPU/GPU:** có, nhưng chưa điều phối tối ưu.
- **Ổn định dưới tải nặng:** chưa đạt.
- **Mức sẵn sàng để sửa hàng loạt:** chưa; cần duyệt kế hoạch và sửa theo lô tối đa 5 file.

## 2. Mức độ bằng chứng

Mỗi phát hiện trong báo cáo này được phân loại:

- **Đã xác nhận:** có code và/hoặc số đo runtime trực tiếp.
- **Rủi ro đã chứng minh bằng cấu trúc:** code tạo được điều kiện lỗi, nhưng chưa có benchmark peak tương ứng.
- **Giả thuyết cần đo:** có thể đúng, nhưng chưa được phép kết luận là nguyên nhân.

Không dùng số liệu ước lượng như số đo thực tế. Mọi mốc hiệu năng sau khi sửa phải có p50/p95/p99 và peak RAM/VRAM.

## 3. Hồ sơ phần cứng và runtime đã quan sát

Log PrynX_RenderPerf.log ghi nhận:

- logical_cores=16.
- installedBytes=34359738368 tức 32 GiB RAM.
- RAM khả dụng bình thường trong các phiên đầu khoảng 15–21 GiB.
- Có các lane background:0 đến background:7, tương ứng 8 lane render nền.
- Nhiều worker ghi PPE_WORKER_QOS policy=high applied=1.
- WGPU tạo GPU scene, refine và present thành công.
- Có TILE_CACHE_POLICY budget=unbounded.

Trong phiên xử lý file khoảng 1.5 GB, cùng trace Vmuh3w53q-c3vdyb:

- RAM khả dụng tụt còn 603914240 bytes, khoảng 576 MiB.
- RENDER_WORKER_PREEMPT mode=Killed rồi worker bị retire và spawn lại.
- PPE page 8 có total_ms=10031 và total_ms=12397.
- PPE page 9 có total_ms=11251, trong đó render_ms=359 nhưng IPC round-trip khoảng 12.4 giây.
- GPU scene page 8 có GPU_SCENE_READY prepare_ms=56896.
- Thumbnail có queue_ms=82489, tổng khoảng 93.7 giây.

Đây là bằng chứng trực tiếp rằng hệ thống có thể đi vào memory pressure và contention dù máy thuộc tier mạnh.

## 4. Bản đồ kiến trúc liên quan

### 4.1 Viewer và GPU

- desktop/src-tauri/src/viewport/commands.rs: khởi tạo GPU context, tạo child HWND, load scene, resize và visibility.
- desktop/src-tauri/src/viewport/scene_cache.rs: cache document/page/renderer resources, kiểm tra áp lực RAM và DXGI local memory.
- viewer_gpu/src/device.rs: WGPU Backends::PRIMARY, PowerPreference::HighPerformance, không ép fallback adapter, yêu cầu limits theo adapter thật.
- viewer_gpu/src/capability.rs: phân loại GPU pipeline hoặc CPU fallback theo format/texture/primitive.

### 4.2 PPE và render worker

- desktop/src-tauri/src/pdf_engine/render_worker.rs: interactive lane, background lanes, affinity, preemption, accurate worker budgets.
- backend/app/core/system_memory.py: plan_worker_count, gate theo CPU/RAM tổng và escape hatch qua env.
- backend/app/core/heavy_job_scheduler.py: slot việc nặng và reservation bộ nhớ theo loại job.

### 4.3 Tác vụ PDF nặng

- N-Up: backend/app/workers/nup_engine.py, nup_output_finalize.py.
- Sticker/cutline: backend/app/workers/sticker_engine.py, backend/app/api/routes/pdf_tools.py.
- VDP: backend/app/workers/vdp_engine.py.
- Optimize PDF: backend/app/core/pdf_actions_native.py, backend/app/api/routes/pdf_tools.py.
- Separations: backend/app/core/separations.py, backend/app/api/routes/preflight.py.
- Preflight: backend/app/core/preflight_engine.py.
- Merge: backend/app/workers/pdf_tools_engine.py.

## 5. Các phát hiện chính

### PERF.PPE.01 — Runtime governor chưa kiểm soát được áp lực RAM

**Mức:** P0 — đã xác nhận bằng log  
**Bằng chứng:**

- desktop/src-tauri/src/lib.rs:2652: tile cache không giới hạn cho RAM >=16 GB.
- desktop/src-tauri/src/viewport/scene_cache.rs:17: ngưỡng pressure của máy 32 GB là RAM khả dụng dưới khoảng 3.2 GB.
- desktop/src-tauri/src/pdf_engine/render_worker.rs:203: accurate worker budget trên máy mạnh vẫn có sàn 512 MiB render và 256 MiB cache.
- Log ghi RAM khả dụng 576 MiB, worker bị kill/respawn, PPE mất 10–12 giây và scene prepare mất 56.9 giây.

**Đánh giá:**

Cơ chế pressure có tồn tại nhưng phản ứng chưa đủ nhanh và chưa xuyên suốt. Scene cache có thể thu cache khi load scene mới, nhưng tile cache, PPE session, background lanes và process working set không dùng chung một governor.

**Rủi ro:**

- OOM/swap làm UI lag.
- Worker bị kill khiến request phải retry và mất locality.
- Background thumbnail có thể giữ tài nguyên trong lúc người dùng zoom/pan.

### HEAVY.01 — N-Up có thể fan-out quá rộng trên file lớn

**Mức:** P1 — rủi ro đã chứng minh bằng cấu trúc  
**Bằng chứng:**

- backend/app/workers/nup_engine.py:3914 gọi plan_worker_count với per_worker_mb=1024.0.
- backend/app/core/system_memory.py:72 giữ cpu_count - 1 cho máy >=16 GB.
- backend/app/workers/nup_output_finalize.py:97 dùng ProcessPoolExecutor với planned_worker_count.

Với máy 16 lõi/32 GB, kế hoạch có thể lên 15 worker nếu số chunk đủ lớn. Mỗi worker mở PDF và các XObject riêng. Báo cáo cũ ước lượng 20–30 GB cho file 1.4 GB, nhưng con số này chưa được đo trực tiếp.

**Đánh giá:**

Rủi ro là thật, nhưng giải pháp không được là hard-cap 2–4 worker cho mọi file mạnh. Cần tính working set theo file size, page area, object count và RAM khả dụng; file nhỏ trên máy mạnh vẫn phải chạy full.

### HEAVY.02 — Sticker 300 DPI và nhiều worker

**Mức:** P1 — rủi ro có thật, số liệu báo cáo cũ cần hiệu chỉnh  
**Bằng chứng:**

- backend/app/api/routes/pdf_tools.py:1856: StickerEngine(dpi=300).
- backend/app/workers/sticker_engine.py:8330: cạnh dài được giới hạn 6000 px.
- backend/app/workers/sticker_engine.py:8331: giới hạn 28 MP.
- backend/app/workers/sticker_engine.py:8514: ước lượng khoảng 10 byte/px cộng overhead.
- backend/app/workers/sticker_engine.py:11964: pool dùng ProcessPoolExecutor.

**Đính chính:** trường hợp 288 MP và 6–9 GB là tính toán trước khi áp cap 6000 px/28 MP, không phải peak chắc chắn của pipeline hiện tại. Tuy nhiên tier >=16 GB vẫn có thể mở nhiều worker; peak tổng vẫn cần đo bằng trang lớn thực tế.

### HEAVY.03 — VDP finalization giữ toàn bộ tài liệu pikepdf

**Mức:** P1 — rủi ro đã chứng minh bằng code  
**Bằng chứng:** backend/app/workers/vdp_engine.py:2137 mở output bằng pikepdf, duyệt font trên mọi trang và sau đó pdf.save.

**Đánh giá:**

Pass cuối có thể trở thành nút thắt CPU/RAM với 5.000–10.000 trang. Con số 3–5 GB và thời gian vài phút phải được benchmark, không đưa vào acceptance nếu chưa đo.

**Rủi ro khi sửa:**

Chuẩn hóa font theo chunk có thể làm lệch object reference hoặc font dùng chung. Phải có kiểm tra text extraction, font identity, output rendering và byte-level structural validation.

### HEAVY.04 — Separations trả JSON Base64 lớn

**Mức:** P1 — rủi ro đã chứng minh bằng code, peak cần đo  
**Bằng chứng:** backend/app/core/separations.py:374 tạo các kênh NumPy, nén zlib, Base64 và đưa vào object response.

**Đánh giá:**

Đường này phù hợp preview nhỏ nhưng không phù hợp plate lớn hoặc nhiều spot. Cần chuyển sang binary stream/tile, không parse một JSON khổng lồ trong V8.

### HEAVY.05 — Tước PieceInfo đang nằm sau optimize

**Mức:** P1 — thứ tự pipeline đã xác nhận  
**Bằng chứng:**

- backend/app/api/routes/pdf_tools.py:468: _strip_pdf_metadata tước PieceInfo và page metadata.
- backend/app/api/routes/pdf_tools.py:1230: gọi sau pdf_actions_native.optimize_pdf.
- backend/app/core/pdf_actions_native.py:3561: optimize mở và xử lý file trước.

**Đánh giá:**

Đưa bước strip lên trước có thể giảm dữ liệu cần xử lý nếu PieceInfo thực sự chiếm phần lớn file. Nhưng nếu vẫn phải mở/save toàn bộ PDF bằng pikepdf ở một pass riêng thì lợi ích RAM không tự động xuất hiện. Mốc “94% giảm file, nhanh hơn 5 lần” phải có artifact và benchmark độc lập.

### HEAVY.06 — Preflight không còn tuần tự như báo cáo cũ mô tả

**Mức:** P2 — cần sửa kết luận báo cáo  
**Bằng chứng:** backend/app/core/preflight_engine.py:212 dùng multiprocessing khi tài liệu có hơn 10 trang; :227 giới hạn tối đa 8 worker.

**Đánh giá:**

Rủi ro thực tế là mỗi worker vẫn mở pikepdf và quét chunk, nhưng phát hiện “duyệt tuần tự toàn bộ” đã lỗi thời. Không được sửa theo kết luận cũ trước khi cập nhật benchmark.

### HEAVY.07 — WebView2/WGPU và lỗi 0x8007139F

**Mức:** P1 tiềm năng — chưa đủ bằng chứng để kết luận nguyên nhân  
**Bằng chứng hiện có:**

- desktop/src-tauri/src/viewport/commands.rs:273 gọi set_bounds/Win32 surface resize.
- desktop/src-tauri/src/viewport/commands.rs:306 đổi visibility child HWND.
- desktop/src-tauri/src/viewport/scene_cache.rs:22 có probe DXGI local memory trên 80% budget.

**Khoảng trống:** chưa có log HRESULT cụ thể, tên adapter, VRAM budget/current usage, device lost, overlay module hoặc ETW trace. Vì vậy chưa được viết “đây chính là nguyên nhân”.

### HEAVY.08 — PDF.js fallback cho file không có local path

**Mức:** P2 — rủi ro hợp lý  
**Bằng chứng:** desktop/src/hooks/viewer/usePdfLoader.ts:865 dùng pdfjs.getDocument(pdfUrl) khi không có native local path hoặc file in-memory.

**Đánh giá:**

Cần benchmark heap V8, thời gian parse và UI long task với file 200 MB, 500 MB và 1 GB. Không được giả định mọi file in-memory đều sẽ crash.

### HEAVY.09 — RGB → CMYK fallback tạo nhiều mảng float32

**Mức:** P2 — đã xác nhận bằng code  
**Bằng chứng:** backend/app/core/separations.py:374 tạo r/g/b/k/c/m/y dạng float32 trước khi chuyển plate sang uint8.

**Đánh giá:**

Đường này chỉ là approximate fallback. Có thể giảm peak bằng tái sử dụng buffer, xử lý theo tile và giải phóng sớm; không được thay đổi nhãn độ chính xác.

### HEAVY.10 — Merge pikepdf giữ output document trong RAM

**Mức:** P2 — rủi ro đã chứng minh bằng code  
**Bằng chứng:** backend/app/workers/pdf_tools_engine.py:67 tạo out_doc, mở từng nguồn và append page vào output.

**Đánh giá:**

Cần đo theo tổng trang, số object và kích thước stream. Có thể cần manifest/chunked assembly cho job lớn; không nên sửa bằng cách chỉ tăng swap hoặc worker.

### OBS.01 — Thiếu telemetry để chứng minh tận dụng GPU

**Mức:** P1 — đã xác nhận  
**Bằng chứng:** viewer_gpu/src/device.rs:56 lấy adapter_info, nhưng perf log hiện không ghi đầy đủ adapter name, backend, driver, local memory budget/usage, queue submit time và device lost.

**Đánh giá:**

PowerPreference HighPerformance chỉ là yêu cầu chọn adapter hiệu năng cao, không phải bằng chứng GPU đang chạy đúng card hoặc đạt occupancy cao.

## 6. Nguyên nhân gốc xuyên tầng

1. **Chính sách theo RAM tổng thay vì working set động.** Máy mạnh được mở rộng worker/cache, nhưng khi file thật lớn thì RAM khả dụng không còn đủ.
2. **Ngân sách không hợp nhất.** Tile cache, PPE session, scene cache, document cache và worker process có các policy riêng.
3. **Ưu tiên interactive chưa tuyệt đối.** Background thumbnail/prefetch vẫn có thể chiếm lane và process khi người dùng đổi trang hoặc zoom.
4. **Fan-out thiếu admission theo kích thước dữ liệu.** N-Up, Sticker, Preflight và một số tác vụ pikepdf chưa dùng một reservation chung theo working set.
5. **Thiếu telemetry theo pha.** Chưa tách đầy đủ parse, compile, transport, IPC, session open, PDFium render, encode, GPU submit, present và memory pressure.
6. **Hybrid GPU/CPU là chủ đích về độ chính xác, nhưng chưa hiển thị chi phí fallback.** PDF có knockout, Type3, DeviceN, soft mask hoặc format không phù hợp có thể quay về PPE/CPU.

## 7. Kế hoạch nâng cấp đề xuất

### Giai đoạn 0 — Chốt số đo, không đổi hành vi

**Mục tiêu:** nhìn thấy đúng bottleneck trước khi đặt cap.

**Lô 0A — telemetry GPU/scene, tối đa 5 file:**

- viewer_gpu/src/device.rs
- desktop/src-tauri/src/viewport/commands.rs
- desktop/src-tauri/src/viewport/scene_cache.rs
- desktop/src-tauri/src/pdf_engine/render_worker.rs
- desktop/src-tauri/src/lib.rs

**Ghi thêm:** adapter name/vendor/device/backend, driver nếu lấy được, max texture, DXGI local budget/current usage, device lost, process working set, available RAM, cache bytes/entries, lane, request id và trace id.

**Lô 0B — benchmark harness:**

- Chuẩn hóa log CSV/JSONL.
- Đo p50/p95/p99 first pixel, first accurate pixel, zoom settle, page switch, pan, queue, IPC, render và present.
- Không thay đổi chất lượng hoặc số worker trong lô này.

**Tiêu chí qua:** mọi request interactive phải truy được từ input đến first pixel và accurate pixel; không còn khoảng thời gian lớn không phân loại.

### Giai đoạn 1 — Runtime governor theo áp lực thật

**Mục tiêu:** máy mạnh vẫn chạy full khi bình thường; chỉ thu hẹp khi RAM/VRAM thật sự chịu áp lực.

**Lô 1A — bộ điều phối RAM/cache, tối đa 5 file:**

- desktop/src-tauri/src/lib.rs
- desktop/src-tauri/src/viewport/scene_cache.rs
- desktop/src-tauri/src/pdf_engine/render_worker.rs
- backend/app/core/system_memory.py
- backend/app/core/heavy_job_scheduler.py

**Thiết kế:**

- Giữ full worker/cache trên máy >=16 GB khi RAM khả dụng bình thường.
- Khi vào pressure mode, tạm dừng prefetch/thumbnail trước, giữ lane interactive.
- Thu tile/PPE/session/document cache theo working set và last-use.
- Không kill interactive worker đang phục vụ người dùng; chỉ preempt background có thể hủy.
- Ngân sách PPE phải tính theo RAM khả dụng hiện tại, không giữ sàn lớn khi máy chỉ còn vài trăm MiB.
- Ghi lý do chuyển tier và thời điểm phục hồi.

**Tiêu chí qua:** không còn availableBytes tụt vào vùng nguy hiểm mà vẫn giữ nguyên 8 background lanes; zoom/page change vẫn có lane riêng; không regression trên máy 32 GB khi RAM còn dồi dào.

### Giai đoạn 2 — Admission theo working set cho tác vụ file nặng

**Lô 2A — N-Up và Sticker, tối đa 5 file:**

- backend/app/workers/nup_engine.py
- backend/app/workers/nup_output_finalize.py
- backend/app/core/system_memory.py
- backend/app/workers/sticker_engine.py
- backend/app/core/heavy_job_scheduler.py

**Thiết kế:**

- N-Up ước lượng theo file size, page area, số tờ/chunk và XObject; reserve trước khi spawn.
- Máy mạnh chỉ bị giảm worker khi working set thực tế không còn vừa RAM khả dụng.
- Sticker giữ cap chất lượng hiện có 6000 px/28 MP; chỉ bổ sung admission theo peak RAM và số trang.
- Ghi estimated_per_worker_mb, reserved_mb, actual_peak_mb, workers_planned, workers_started.
- Pool crash phải chuyển tuần tự có lý do và không để sticky mode che mất nguyên nhân.

**Tiêu chí qua:** file lớn không tạo fan-out vượt reservation; tổng RAM đỉnh nằm trong ngân sách; file nhỏ trên máy mạnh không chậm hơn baseline.

### Giai đoạn 3 — Giảm pass toàn tài liệu và payload lớn

**Lô 3A — Optimize/VDP, tối đa 5 file:**

- backend/app/api/routes/pdf_tools.py
- backend/app/core/pdf_actions_native.py
- backend/app/workers/vdp_engine.py
- module test/benchmark tương ứng

**Thiết kế:**

- Xác định cách tước PieceInfo trong pass ít nhất có thể, giữ atomic output và metadata contract.
- VDP chuẩn hóa font theo chunk hoặc xây pass cuối có giới hạn bộ nhớ; phải kiểm tra shared font/object reference.
- Không tuyên bố “nhanh hơn x lần” nếu chưa đo cùng file, cùng preset và cùng output contract.

**Lô 3B — Separations, tối đa 5 file:**

- backend/app/core/separations.py
- backend/app/api/routes/preflight.py
- API client/frontend nhận binary hoặc tile
- test màu/ICC/spot

**Thiết kế:**

- Plate lớn trả binary stream hoặc tile theo viewport.
- Fallback RGB xử lý theo tile, tái sử dụng buffer và vẫn gắn accuracy=approximate.
- Kiểm tra ICC, spot, alpha và thứ tự plate bằng golden fixture.

### Giai đoạn 4 — Viewer GPU/WebView2 có khả năng quan sát và phục hồi

**Lô 4A, tối đa 5 file:**

- viewer_gpu/src/device.rs
- viewer_gpu/src/capability.rs
- desktop/src-tauri/src/viewport/commands.rs
- desktop/src-tauri/src/viewport/win32_host.rs
- desktop/src-tauri/src/viewport/visibility.rs

**Thiết kế:**

- Ghi HRESULT/error code cho SetWindowPos, resize surface, visibility và device lost.
- Ghi adapter/backend/VRAM budget trước khi quy kết lỗi do GPU.
- Xử lý present mode warning theo backend thực tế.
- Khi surface/device lost, dừng frame cũ, giải phóng resource pool và tạo lại surface có kiểm soát.
- Không tự động đổ lỗi cho Bandicam/OBS/overlay nếu chưa có bằng chứng module hoặc ETW.

**Tiêu chí qua:** lỗi surface không làm treo UI; có log phân biệt thiếu VRAM, device lost, HWND state và lỗi render scene.

### Giai đoạn 5 — Các đường còn lại

- Preflight: giữ multiprocessing hiện tại, đo từng rule và working set mỗi chunk; cập nhật lại báo cáo cũ.
- PDF.js fallback: benchmark heap V8 và chuyển file lớn sang local-path/native khi có thể.
- Merge: thiết kế manifest/chunked assembly cho hàng nghìn trang.
- Không thay đổi format hoặc độ chính xác đầu ra nếu chưa có test parity.

## 8. Ma trận benchmark bắt buộc

| Nhóm | Nhỏ | Trung bình | Nặng | Chỉ số bắt buộc |
|---|---|---|---|---|
| Viewer/PPE | 10–50 MB | 200–500 MB | 1–1.5 GB | first pixel, accurate pixel, zoom settle, pan, page switch, p95 RAM |
| N-Up | 1–5 trang | 20–100 trang | file 1.4 GB | workers, reservation, peak RAM, throughput, output parity |
| Sticker | A4 | A2/A1 | trang 28 MP | peak RAM/worker, pool crash, elapsed, contour parity |
| VDP | 100 trang | 1.000 trang | 5.000–10.000 trang | final pass RAM, CPU time, output validation |
| Separations | 1 plate nhỏ | 4 process plates | nhiều spot/plate lớn | payload bytes, V8 heap, tile latency, color parity |
| Optimize | file sạch | file có metadata | file 1.4 GB PieceInfo | peak RAM, temp disk, elapsed, output size |

Mỗi scenario chạy tối thiểu 3 lần, ghi p50/p95/p99. Cần test hai trạng thái:

1. Máy mạnh, RAM khả dụng dồi dào: không được chậm hơn baseline.
2. Máy mạnh nhưng RAM khả dụng thấp do workload khác: phải chuyển pressure mode, bảo vệ interactive.

## 9. Tiêu chí nghiệm thu toàn đợt

- Không còn worker fan-out vượt reservation đã log.
- Không còn tile cache không giới hạn trong pressure mode.
- Interactive zoom/page change không xếp sau thumbnail/background queue.
- Không có blank frame hoặc surface trắng sau resize, visibility, device lost.
- GPU adapter/backend/VRAM và CPU/RAM working set được ghi rõ trong log.
- PDF output giữ nguyên parity hình học, màu, font, spot và transparency theo golden fixture.
- PPE accurate không bị hạ thành approximate mà không có cảnh báo rõ.
- vitest, tsc, pytest liên quan và cargo check/test Rust trên Windows đều đạt.
- Mỗi lô tối đa 5 file, có log fix riêng và rollback được bằng tag audit.

## 10. Quyết định cần duyệt

Thứ tự đã được người dùng duyệt và đang thực hiện:

1. Lô 0 — telemetry và benchmark, không đổi hành vi.
2. Lô 1 — runtime governor/cache/interactive QoS.
3. Lô 2 — N-Up và Sticker admission.
4. Lô 3 — VDP, Optimize và Separations.
5. Lô 4 — GPU/WebView2 recovery.
6. Lô 5 — Preflight, PDF.js fallback và Merge.

Sau khi được duyệt, mỗi lô sẽ được sửa và verify độc lập. Không sửa toàn bộ cùng lúc vì sẽ không còn khả năng xác định lô nào gây hồi quy.

