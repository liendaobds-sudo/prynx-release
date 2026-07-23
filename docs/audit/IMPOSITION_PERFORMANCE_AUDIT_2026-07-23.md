# PrynX — Audit hiệu năng bốn luồng bình trang

**Ngày:** 2026-07-23  
**Phạm vi:** từ lúc người dùng bấm RUN đến khi file kết quả xuất hiện  
**Luồng:** Book/Booklet, Sticker Die-cut, CNC/Bế rớt, Guillotine N-Up  
**Không thuộc phạm vi:** đánh giá tính đúng/sai hoặc thay đổi thuật toán layout, nesting, xoay, khoảng cách và vị trí ô

## 1. Kết luận

Ba nút thắt lớn nhất sau RUN là:

1. Truy cập trang qua `doc[i]` bị tăng chi phí mạnh ở PDF nhiều trang, đồng thời tạo `Page` wrapper mới làm mất cache hình học.
2. Sticker và guillotine lặp nhiều công việc CPU/I/O; guillotine còn có bookkeeping O(số tờ²) và chính sách chunk gây nhân bản dữ liệu.
3. Ba luồng N-Up vẫn bake/upload/download toàn file qua WebView; riêng sách đã dùng đường dẫn local/output hiệu quả hơn.

Các số trong báo cáo là micro-benchmark trên Windows, 16 logical CPU. Fixture chủ yếu là PDF vector nhẹ; chúng xác nhận hotspot và xu hướng, không phải baseline file khách hàng. Không có log production đại diện nên báo cáo không đưa ra tuyên bố P95 hoặc tốc độ sản phẩm.

### Hiệu chỉnh đường chạy thực

RUN tem bế không gọi `sticker_engine.py`; nó chạy trong `nup_engine.py` / `nup_process_chunk.py`. `sticker_engine.py` thuộc công cụ tiền xử lý `/pdf-tools/sticker-dieline`, nên thời gian của nó không được cộng vào spinner RUN imposition.

## 2. Phương pháp và giới hạn đo

- N-Up được chạy qua outer `multiprocessing.Process` thật với `PRYNX_PERF=1`.
- Peak RSS là tổng process tree, không dùng `psutil`.
- Book được đo trực tiếp ở `PlanExecutor.execute`; metadata được đo riêng.
- Fixture guillotine đặt một bản mỗi source page, tạo 50 tờ từ 100 trang và 500 tờ từ 1.000 trang.
- CNC được đo ở chế độ hai mặt.
- Có một mẫu CNC thực hai trang, khoảng 4,2 MB; các fixture còn lại là vector tổng hợp nhẹ.
- Không tự động hóa UI/Tauri end-to-end, nên T0→T1, T4→T5 và T5→T6 vẫn còn các khoảng chưa đo.
- Hai dòng `JOBPERF` 0,03 giây có sẵn trước audit chỉ là probe giả, không được dùng làm bằng chứng.

## 3. Phân rã T0–T6

| Luồng | T0→T1: chuẩn bị/upload/queue | T1→T2: spawn/engine start | T2→T4: engine, fan-out, merge/save | T4→T5: UI biết hoàn tất | T5→T6: file/tab xuất hiện |
|---|---|---|---|---|---|
| Sách/booklet | Tauri dùng path, không upload; có metadata + planner JS. Metadata synthetic: 100 trang **0,032s**, 1.000 **0,393s**, 10.000 **13,775s**. Planner/JSON chưa đo. | Không có process con; request chạy thẳng trong event loop. | Executor: 100 trang **0,083s**, 1.000 **0,606s**, 10.000 **38,650s**. Fixture 128 output pages: render/setup khoảng **86%**, save **14%**. | Không polling; response của request là tín hiệu hoàn tất. Chưa đo transport/JSON scheduling. | Desktop nhận `output_path`, dùng File path-backed; không tải output qua WebView. Chưa đo tới first-page paint. |
| Tem bế | `getWorkingBytes` → bake pdf-lib → multipart upload → executor/heavy wait. **Chưa đo** và queue wait không nằm trong `JOBPERF`. | PID xuất hiện sau khoảng **31ms** ở probe 100 trang; engine-entry chưa có mark. Cold interpreter/import proxy median **154ms**. | Tổng process: 20 trang **3,09s**, 100 trang **34,91s**, RSS khoảng **72–74MB**. Không tách được T2→T3 và T3→T4. | Poll 500ms: trễ xác định **0–500ms + RTT/signing**; trung bình 250ms chỉ là mô hình phân bố đều, không phải số đo. | Download toàn output thành Blob. Replace-current còn upload Blob trở lại backend. Chưa đo. |
| CNC hai mặt | Giống tem bế: bake/upload/queue chưa đo. | PID xuất hiện khoảng **45ms**; engine-entry chưa đo. | Synthetic: 20 trang **1,06s**, 100 trang **1,12s**, RSS khoảng **67MB**. Mẫu thực 2 trang/4,2MB: **3,40s**. CNC chạy serial, không có inner ProcessPool. | Giống tem bế. | Blob download; auto-save có thể parse/tách file tiếp trong WebView. Chưa đo. |
| Guillotine N-Up | Bake/upload/queue chưa đo. | PID xuất hiện khoảng **22ms**; engine-entry chưa đo. | 100 trang→50 tờ: **1,31s**, peak **438MB**. 1.000 trang→500 tờ: **5,45s**, peak **667MB**. T2→T3/T3→T4 chưa có stage marks. | Giống tem bế. | Full Blob download; replace-current có thể re-upload. Chưa đo. |

Đường code frontend thực:

- Ba luồng N-Up: `desktop/src/lib/processHandlers.ts:61-201`.
- Sách/booklet: `desktop/src/lib/processHandlers.ts:202-247`.

## 4. Số đã đo

### 4.1 Book/booklet theo quy mô

Fixture vector nhẹ, bốn source page trên mỗi logical sheet.

| Source pages | Source | Metadata | PlanExecutor | Output save | Peak RSS | Output |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0,037 MB | 0,032s | 0,083s | 0,007s | 55 MB | 0,050 MB |
| 1.000 | 0,373 MB | 0,393s | 0,606s | 0,080s | 73 MB | 0,501 MB |
| 10.000 | 3,787 MB | 13,775s | 38,650s | 1,741s | 244 MB | 5,087 MB |

Mức tăng từ 1.000 lên 10.000 trang lớn hơn tuyến tính rõ rệt, dù fixture và output vẫn nhẹ.

### 4.2 Book stage breakdown

Fixture 64 tờ, 128 trang output, 512 placements:

| Mốc | Số đo |
|---|---:|
| Tổng `PlanExecutor.execute` | 0,166–0,168s |
| Tổng `show_pdf_page` | 0,075–0,078s |
| `output_doc.save` | 0,022–0,023s |
| Open/new-page/box/loop còn lại | khoảng 0,067–0,069s |
| Output | 0,192 MB |

Với fixture này:

- T2→T3, gồm render và setup: khoảng 86%.
- T3→T4, base save: khoảng 14%.
- `show_pdf_page` riêng chiếm khoảng 46% tổng.

### 4.3 Guillotine N-Up

Mặc định dùng tối đa 15 inner workers trên máy đo.

| Source pages | Output sheets | Process duration | Peak RSS | Peak temp | Output |
|---:|---:|---:|---:|---:|---:|
| 100 | 50 | 1,31s | 438 MB | dưới sampling resolution | 0,048 MB |
| 1.000 | 500 | 5,45s | 667 MB | 0,5 MB | 0,486 MB |

### 4.4 Worker-count trade-off

| Workload guillotine | 1 worker | 4 workers | Mặc định 15 workers |
|---|---:|---:|---:|
| 100 trang: thời gian | 1,25s | **1,09s** | 1,31s |
| 100 trang: peak RSS | 103 MB | 204 MB | **438 MB** |
| 1.000 trang: thời gian | 29,95s | 7,73s | **5,45s** |
| 1.000 trang: peak RSS | 119 MB | 239 MB | **667 MB** |

Job nhỏ không hưởng lợi từ 15 worker nhưng tốn thêm hơn 300 MB. Job lớn nhanh hơn, đổi lại peak RAM gần gấp ba so với bốn worker.

### 4.5 Tem bế

Fixture vector nhẹ, source pages có cùng dạng khuôn:

| Source pages | Process duration | Peak RSS |
|---:|---:|---:|
| 20 | 3,09s | 71,7 MB |
| 100 | 34,91s | 73,5 MB |

Tăng source pages 5 lần làm thời gian tăng khoảng 11,3 lần, dù output chỉ rất nhỏ. Vì chưa có stage marks, số này chưa tách được geometry/detection, solver, chunk render và merge.

### 4.6 CNC

| Fixture | Process/engine duration | Peak RSS | Ghi chú |
|---|---:|---:|---|
| Synthetic 20 trang, hai mặt | 1,06s | 67,6 MB | vector nhẹ |
| Synthetic 100 trang, hai mặt | 1,12s | 67,3 MB | vector nhẹ |
| Mẫu thực 2 trang, 4,2 MB | 3,40s | chưa đo process tree | report tắt |

Nội dung/resource graph chi phối CNC nhiều hơn số source pages đơn thuần.

## 5. Các micro-probe xác định hotspot

### 5.1 Truy cập trang và cache wrapper

Trên PDF vector 10.000 trang:

| Cách quét | Thời gian |
|---|---:|
| Lặp `doc[i]` hiện tại | **7,572s** |
| Materialize raw page list một lần | **0,009s** |
| Quét danh sách đã materialize | **0,223s** |

Tổng đường cached nhanh hơn khoảng **32,6 lần** cho riêng thao tác scan.

Nguyên nhân nằm ở `backend/app/workers/pdf_wrapper.py:145-163`: `Document.__getitem__` luôn truy cập `self._pdf.pages[i]` và tạo wrapper mới.

Trên một trang vector thực:

- Parse lần đầu trên một wrapper: **0,312s**.
- Gọi lại cùng wrapper: **0,001s**.
- Lấy `doc[0]` mới và parse lại: **0,331s**.

`Page._vp_cache` hiện chỉ sống trên wrapper; wrapper mới làm mất cache.

### 5.2 Cache thử nghiệm trên Book 10.000 trang

Monkeypatch cache tạm thời, không đổi layout:

| Mốc | Hiện tại | Có cache thử nghiệm | Chênh lệch |
|---|---:|---:|---:|
| Metadata | 13,775s | 1,232s | **11,2× nhanh hơn** |
| PlanExecutor | 38,650s | 12,416s | **3,1× nhanh hơn** |
| Output save | 1,741s | 0,767s | có cải thiện nhưng cần benchmark lặp |
| Peak RSS | 244 MB | 290 MB | +46 MB |

Đây là trade-off rõ ràng: tốc độ cao hơn nhưng cache wrapper toàn bộ 10.000 trang tăng RAM. Giải pháp production nên materialize raw references nhẹ và cache geometry/wrapper có kiểm soát.

### 5.3 Guillotine repeat O(S²)

Hai biểu thức trong vòng mỗi sheet:

- Dựng lại toàn bộ `sheet_mapping` dict.
- Quét tất cả sheet trước để tính ordinal.

Micro-probe đúng hai biểu thức ở 5.000 tờ:

| Công việc | Hiện tại | Build-once/tuyến tính |
|---|---:|---:|
| Dựng mapping lặp | 0,936s | dưới 1ms |
| Quét ordinal lặp | 0,771s | dưới 1ms |

Đây là bookkeeping, không phải thuật toán layout.

### 5.4 Chunk và temp I/O

Fixture nguồn 4,064 MB, cùng năm tờ:

| Cách chia | Build | Tổng chunk/temp | Merge | Output |
|---|---:|---:|---:|---:|
| Một chunk 5 tờ | 0,210s | 4,068 MB | chỉ copy | 4,068 MB |
| Năm chunk × 1 tờ | 0,858s | 20,323 MB | 0,099s | 20,322 MB |

Mỗi chunk tạo output document riêng, nên cache XObject không dùng chung. PDFium merge không deduplicate các object đã bị nhân bản.

### 5.5 Canonical rotation

| Pages | `/Rotate` | Thời gian |
|---:|---:|---:|
| 100 | 0 | 0,024s |
| 100 | 90 | 0,042s |
| 1.000 | 0 | 0,116s |
| 1.000 | 90 | 0,312s |

Đây là lower bound trên vector nhẹ. File ảnh/vector nặng sẽ phụ thuộc số byte phải rewrite.

Hai probe rotated thực tế để lại `nup_canon_*.pdf` sau khi job kết thúc, xác nhận temp hiện bị leak. Các file probe đã được dọn sau audit.

### 5.6 Full-file post-pass

Watermark trên fixture 4 MB:

- Không watermark: median **0,216s**.
- Có watermark: median **0,465s**.
- Full rewrite watermark thêm khoảng **0,249s**.

Book report trên fixture 128 output pages:

| Chế độ | Tổng | Output |
|---|---:|---:|
| Không report | 0,177s | 0,088 MB |
| Có report | 0,724s | 2,725 MB |

Report làm thời gian tăng khoảng **4,1 lần** và output tăng khoảng **31 lần** trên fixture nhẹ.

## 6. Bottleneck theo ưu tiên

Ký hiệu bằng chứng:

- **M:** đã có số đo/micro-probe.
- **S:** suy luận tĩnh từ đường code.

### P0-1 — Page access và cache wrapper

**Bằng chứng:** M  
**File:** `backend/app/workers/pdf_wrapper.py:38-42,145-163`

`Document.__getitem__` vừa có page-index cost lớn vừa làm mất `_vp_cache`. Cache thử nghiệm giúp metadata 11,2 lần và executor 3,1 lần ở 10.000 trang.

**Tối ưu:**

- Materialize raw page references một lần cho source immutable.
- Cache wrapper/geometry theo page index.
- Tách cache source page khỏi output document mutable.
- Invalidate khi document thật sự bị thêm/xóa/thay trang.

**Rủi ro:** Trung bình.  
**Công sức:** Trung bình.

### P0-2 — Full input/output qua WebView cho ba luồng N-Up

**Bằng chứng:** S  
**File:** `desktop/src/lib/processHandlers.ts:67-70,154-165`; `desktop/src/lib/api.ts:184-225,531-551`; `desktop/src/components/ImpositionTab.tsx:647-689,1155-1164,1605-1636`

Frontend luôn gọi `getWorkingBytes`, tạo File, multipart upload. Khi output hoàn tất, `res.blob()` materialize toàn PDF. Replace-current còn upload Blob trở lại backend.

Book đã có mẫu path-based tại `desktop/src/lib/pdfImposer.ts:757-788`.

**Tối ưu:**

- Nếu edit revision là identity, đăng ký local path như implementation có sẵn tại `desktop/src/lib/api.ts:228-259`.
- Chỉ bake khi thực sự có page edit.
- Cache baked artifact theo edit revision.
- Status/completion trả output path cho desktop; File/tab/commit dùng path-backed.

**Rủi ro:** Trung bình do ownership/lifetime/path validation.  
**Công sức:** Trung bình.

### P0-3 — Geometry parse/cache miss của tem bế và CNC

**Bằng chứng:** M + S  
**File:** `backend/app/workers/nup_engine.py:489-576,703-805`; `backend/app/workers/cnc_render.py:96-99,330-363,448-504`

Tem bế tăng từ 3,09s/20 trang lên 34,91s/100 trang trên fixture nhẹ. Parse cùng wrapper giảm từ 0,312s xuống 0,001s, nhưng wrapper mới lại mất 0,331s.

**Tối ưu:**

- Cache die path/poly/trim theo source fingerprint và page index.
- Truyền geometry đã tính vào collision/render thay vì extract lại.
- Reuse kết quả solver theo exact die-geometry signature + exact settings, không thay đổi kết quả layout.
- Chỉ dựng `_trim_cache` CNC khi report thật sự bật.

**Rủi ro:** Thấp–Trung bình.  
**Công sức:** Trung bình.

### P0-4 — Guillotine repeat bookkeeping O(S²)

**Bằng chứng:** M  
**File:** `backend/app/workers/nup_process_chunk.py:260,482-487,599-605`; `backend/app/workers/nup_engine.py:2368-2402`

Mỗi sheet dựng lại mapping toàn job và quét toàn bộ sheet trước. Tổng CPU tăng bậc hai theo số tờ.

**Tối ưu:**

- Dựng mapping/ordinal một lần trước vòng sheet.
- Hoặc truyền mapping chunk-local cùng starting ordinal.
- Tốt nhất truyền thẳng source-page index và ordinal đã tính cho từng sheet.

**Rủi ro:** Thấp–Trung bình.  
**Công sức:** Nhỏ–Trung bình.

### P0-5 — Over-chunking, worker budget và object duplication

**Bằng chứng:** M  
**File:** `backend/app/workers/nup_engine.py:2946-2962,3037-3055`; `backend/app/workers/nup_process_chunk.py:145-169,1309-1315`; `backend/app/workers/pdf_ops.py:286-320`

Job nhỏ dùng nhiều worker không nhanh hơn nhưng peak RAM tăng mạnh. Chunk nhỏ nhân bản source resource graph và temp/output bytes.

**Tối ưu:**

- Chọn worker/chunk theo số tờ, placement count, source MB và RAM budget.
- Job nhỏ chạy inline.
- Số chunk xấp xỉ số worker thay vì luôn cap năm tờ.
- Với source resource-heavy, tăng chunk size có kiểm soát.
- Một chunk có thể ghi thẳng output/atomic rename, bỏ temp→copy.

**Rủi ro:** Trung bình; phải benchmark peak RSS và PDF regression.  
**Công sức:** Trung bình.

### P1-1 — Book chặn FastAPI event loop và đứng ngoài heavy scheduler

**Bằng chứng:** S  
**File:** `backend/app/api/routes/imposition.py:189,232`; `backend/app/core/plan_executor.py:35-242`; `backend/app/core/heavy_job_scheduler.py:30-57`

`PlanExecutor.execute` là `async` nhưng không có await thực; open/render/save đều synchronous. Một book job chặn các request khác và có thể tranh tài nguyên ngoài ngân sách heavy scheduler.

**Tối ưu:**

- Chạy PlanExecutor qua dedicated executor/threadpool.
- Bao bằng `heavy_job_slot("booklet")`.
- Thêm bounded admission riêng nếu cần.

**Rủi ro:** Thấp–Trung bình.  
**Công sức:** Nhỏ–Trung bình.

### P1-2 — Full-file finalization passes

**Bằng chứng:** M + S  
**File:** `backend/app/workers/nup_engine.py:3075-3168,3189-3228,3289-3314`; `backend/app/core/plan_executor.py:169-230`; `backend/app/workers/cnc_render.py:505-570`

Base save, move-cut, watermark và report có thể rewrite output nhiều lần. CNC save `BytesIO`, gọi `getvalue()` rồi ghi file, giữ nhiều bản output trong RAM.

**Tối ưu:**

- CNC save thẳng atomic temp file cạnh output rồi `os.replace`.
- Gộp move-cut, watermark và report vào một final pikepdf pass khi an toàn.
- Cache report overlay theo text/page-size/style hoặc import một Form XObject và reference lại.

**Rủi ro:** Thấp cho CNC direct-save; Trung bình cho hợp nhất final pass.  
**Công sức:** Nhỏ→Trung bình.

### P1-3 — CNC render serial

**Bằng chứng:** M + S  
**File:** `backend/app/workers/cnc_render.py:448-493,183-248`

100 trang synthetic nhẹ vẫn gần hằng số do số placement thực nhỏ, nhưng mẫu thực 4,2 MB mất 3,4s chỉ với hai trang. Nội dung/resource graph có thể chi phối từng unit.

**Tối ưu:**

- Sau ngưỡng cost, song song theo unit bằng process.
- Mỗi unit trả chunk path; parent merge đúng thứ tự.
- Small job giữ serial.

**Rủi ro:** Trung bình do resource/OCG/report ordering.  
**Công sức:** Trung bình–Lớn.

### P1-4 — Canonical rotated temp leak và thiếu trong telemetry

**Bằng chứng:** M + S  
**File:** `backend/app/workers/nup_engine.py:73-123,165`; `backend/app/api/routes/imposition.py:1072-1091,1152-1155`

`_rot_is_temp` được nhận nhưng không dùng để cleanup. `peak_temp_mb` không include `nup_canon_*.pdf`.

**Tối ưu:**

- Xóa canonical temp trong `finally` sau khi mọi child/chunk đã đóng.
- Đặt tên job-scoped và thêm pattern vào sampler/cleanup safety net.
- Có thể cache canonical result theo source fingerprint cho job lặp.

**Rủi ro:** Thấp cho cleanup; cache cross-job cần invalidation.  
**Công sức:** Nhỏ.

### P2-1 — Fixed polling và progress file

**Bằng chứng:** S  
**File:** `desktop/src/lib/processHandlers.ts:149-153`; `backend/app/workers/nup_process_chunk.py:1295-1307`; `backend/app/api/routes/imposition.py:1324-1349`

Frontend ngủ 500ms trước mỗi status GET. Worker ghi progress mỗi năm sheet, nhiều process có thể cùng truncate/write một file trong khi UI chỉ poll khoảng 2Hz.

**Tối ưu:**

- GET ngay sau start.
- Dùng long-poll/SSE/event completion; adaptive polling chỉ làm fallback.
- Progress backend giới hạn theo thời gian, tối đa 2–4 lần/giây/job.

**Rủi ro:** Thấp–Trung bình.  
**Công sức:** Nhỏ–Trung bình.

### P2-2 — Auto-save giữ spinner và xử lý output trong WebView

**Bằng chứng:** S  
**File:** `desktop/src/lib/processHandlers.ts:168-189`; `desktop/src/lib/savePrintFiles.ts:29-80`

Sticker/CNC auto-save parse full output bằng pdf-lib và ghi từng file tuần tự sau khi job đã hoàn tất.

**Tối ưu:**

- Tách/save trực tiếp từ output path ở native/backend.
- Hoặc batch toàn bộ công việc trong một native invocation.

**Rủi ro:** Trung bình.  
**Công sức:** Trung bình.

## 7. Findings mới chỉ là suy luận tĩnh

Các điểm sau chưa có số runtime end-to-end:

- T0→T1 của ba luồng N-Up có thể giữ đồng thời source bytes, pdf-lib graph, baked bytes và multipart body.
- Queue executor và heavy scheduler wait không được tính vào `JOBPERF`; sampler chỉ bắt đầu bên trong `_spawn_nup_process`.
- `commitWorkingFile` ở nhánh N-Up không được `await`, nên T6 hiện chưa được định nghĩa chính xác.
- Heavy scheduler đếm job, không cấp CPU/RAM token. Hai heavy job vẫn có thể mỗi job sinh tới 15 worker; book còn đứng ngoài scheduler.
- Thời gian tạo tab, metadata viewer và first-page paint chưa được đo.
- Poll status có HMAC/signing IPC mỗi request; chưa có tổng số poll/RTT.
- T5→T6 của replace-current có thêm một vòng upload output, nhưng chưa có bytes/time telemetry.
- Auto-save và số tab đang mở có thể kéo dài spinner/first paint; chưa có trace.

## 8. Độ phủ đo còn thiếu

### Frontend marks

Nên dùng helper hiện có `desktop/src/lib/perfMarks.ts` và thêm:

1. `run-click`
2. `handler-enter` / spinner-visible
3. working-source/bake start/end
4. upload start/end, bytes
5. start request / job-id received
6. first queued/running observed
7. aggregate poll count, signing time và RTT
8. server completed timestamp observed
9. download headers/body done, bytes
10. File constructed / commit done
11. tab mounted / metadata ready / first page painted
12. auto-save start/end

### Backend marks

Nên mở rộng `PRYNX_PERF` với:

1. accepted timestamp
2. executor start
3. heavy-slot admitted
4. outer process started
5. engine entered
6. canonicalization done
7. pool started
8. per-worker/chunk `render_s`, `save_s`, bytes, sheet count
9. all chunks done
10. merge/import done
11. base output saved
12. move-cut/watermark/report done
13. final output bytes/pages

`JOBPERF` cũng cần ghi:

- mode: booklet/diecut/cnc/guillotine
- source pages/MB
- output pages/MB
- total sheets/placements
- chunk count/size
- worker count
- queue wait/heavy wait
- canonical temp peak

### Status API và định nghĩa T6

- Status cần `created_at`, `started_at`, `completed_at` để tách queue wait và T4→T5.
- T6 cần hai mốc riêng:
  - tab state đã enqueue/working file đã commit;
  - trang đầu tiên thực sự được paint.

## 9. Ma trận baseline đề xuất

Chạy tối thiểu ba lần mỗi tổ hợp:

- mode: booklet / die-cut / CNC / guillotine
- pages: 100 / 1.000 / 10.000
- content: vector-light / raster-heavy / resource-heavy
- source edits: identity / reordered / rotated / inserted blank
- tab behavior: spawn-new-tab / replace-current
- auto-save: off / on
- queue: uncontended / một heavy job đang chạy
- worker budget: 1 / 4 / auto

Ghi median, P95, peak process-tree RSS, peak job-scoped temp, input/output bytes, queue wait, poll count và T0→T6.

## 10. Trình tự remediation đề xuất

1. Cache/raw-page access ở `pdf_wrapper`, kèm benchmark 1k/10k và memory cap.
2. Loại O(S²) ở guillotine repeat.
3. Thêm input/output local-path fast path cho ba luồng N-Up.
4. Adaptive N-Up worker/chunk budget.
5. Cache geometry die-cut/CNC theo source/page/signature.
6. Đưa Book vào executor + heavy scheduler.
7. Direct atomic save và hợp nhất finalization passes.
8. Cleanup canonical temp và mở rộng telemetry.
9. Thay fixed polling bằng completion signal/long-poll.
10. Chạy lại baseline matrix trước khi công bố cải thiện performance.

## 11. Kết luận cuối

Audit đã tìm được các hotspot hiệu năng có thể tối ưu mà không thay đổi thuật toán layout:

- page access/cache plumbing;
- loại bookkeeping bậc hai;
- giảm copy/upload/download;
- cân bằng worker/chunk theo workload và RAM;
- tránh full-file rewrite;
- offload event-loop work;
- đo đầy đủ queue, poll và first paint.

Các correctness gate hiện tại không chứng minh tốc độ. Chỉ sau khi có stage marks và baseline trên fixture khách hàng/target hardware mới có thể đưa ra tuyên bố trước/sau hoặc P95 đáng tin cậy.
