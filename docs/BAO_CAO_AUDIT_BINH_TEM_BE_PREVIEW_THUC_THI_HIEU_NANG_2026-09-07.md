# Audit bình tem bế: tốc độ preview và thực thi — 2026-09-07

## 1. Kết luận điều hành

**Audit-only — CHỜ DUYỆT, chưa sửa mã ứng dụng.** Phạm vi: Bình tem bế thường và nhánh True-shape nesting dùng chung với CNC, từ preview/bảng sức chứa đến engine và PDF xuất. Không gộp “tạo đường cắt/tách tem” vào engine Bình tem bế.

Có dư địa tăng tốc mà không giảm độ chính xác/mật độ:

- Preview: gộp công việc cùng khóa đang tính; ngăn bảng sức chứa chạy ở tab nền; tái dùng polygon đã chuẩn hóa.
- Thực thi nesting: nạp/xác minh manifest là chặng lớn, dù **không solve lại**; tiếp theo là dựng trang/nhúng artwork. Không quy toàn bộ chậm cho solver hay SHA-256.
- Thực thi thường: còn log WARNING trong vòng vẽ CUT. Với đơn nesting nhiều tờ, writer còn quét toàn placement cho từng tờ.
- Chốt an toàn trước tối ưu cache: đã tái hiện batch làm đổi hướng đường bế của preview với PDF xoay 90°. Không tăng mức chia sẻ cache khi hai đường chưa cùng hệ tọa độ.

Có **5 P2 hiệu năng và 1 P1 hợp đồng preview/cache**; không phải tất cả đều mới phát sinh. Singleflight và một số chi phí manifest là tồn đọng được kiểm lại. Chưa có bản vá/A-B toàn ứng dụng, nên **không cam kết phần trăm tăng tốc toàn tính năng**.

Độ phủ: **TRACED + PROBE**, test hiện hữu và artifact mẫu; chưa Tauri/installer RUNTIME, chưa SLO/P95. Script, số đo và fingerprint ở [gói evidence](D:/pdfcompare/docs/audit/BINH_TEM_BE_HIEU_NANG_EVIDENCE_2026-09-07.json).

## 2. Baseline và provenance

### Môi trường

- Windows thật, venv dự án; 16 logical CPU, RAM đọc được 32.527,9 MiB, tier ≥16 GB.
- HEAD đầu/cuối: 79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc.
- Working tree có thay đổi của người dùng/phiên khác; giữa lượt có thêm thay đổi ImpositionTab và nhóm tách tem. Không reset/commit/tắt dev server hoặc sửa các thay đổi đó. Backend hot-path khảo sát không có diff so với HEAD khi chốt.
- Native SHA-256: cac22b947e503b3e42d70ed9567e37e40b76707a27b869e83f6ddcca606fcbe9.
- Native build identity: 6fc91ac521d4c6866892a6f29bf7d43accd90f88cc0840d6bd134c0d08c0ce89; release, source revision 669b92db…, dirty. Đây là binary thực đo, **không chứng minh tương ứng mọi byte của toàn source Rust hiện tại**. Không rebuild trong audit.
- Đo trong process/kho riêng, nhưng **không cô lập toàn máy** khỏi công việc đang chạy. Đây là baseline khảo sát, không acceptance benchmark.

### 2.1 Bình tem bế thường — PDF 17 mẫu

Nguồn: test/cac loai hinh - Copy.pdf, SHA-256 018d6cd297deacb983c1472c01335f5a5c3df5adb1e3e9f1666aa093cff80730.

Detector và run_nup_engine thật. S&R, tờ 320×430 mm, lề 3 mm, gap 2 mm, không ốc/bleed, tách CUT, xuất tờ đại diện. **Ép forceLegacyGrid để đo riêng nhánh thường**, không giả làm quyết định Auto của UI. Một warm-up, ba lượt đo:

| Chặng | Trung vị | Khoảng N=3 |
|---|---:|---:|
| Engine hoàn tất PDF | **2.312 ms** | 2.295–2.313 ms |
| Lập kế hoạch | 1.032 ms | 1.015–1.078 ms |
| Render chunk, gồm pool nội bộ | 1.031 ms | 1.015–1.063 ms |
| Ghép/lưu | 172 ms | 157–187 ms |
| Hậu xử lý | 62 ms | 47–62 ms |

Detector đo riêng N=1: 124 ms, ngoài timer engine. Mỗi artifact: 34 trang, 8.726.494 byte; source hash giữ nguyên. Đã parse page count/MediaBox, **chưa raster-parity toàn lane legacy**. Không gồm HTTP admission, outer process startup, download/first paint viewer.

### 2.2 True-shape S&R — PDF 13 mẫu

Nguồn: test/test nesting.pdf, SHA-256 efcde4f0a16aca0a5a54ee2d952945afe2eb70dd2073bc9ff59ee87292b257ab.

Tờ 320×430 mm, lề 3 mm, gap 2 mm, ốc 5 mm, report và Front/CUT; **explicit true_shape_nesting, không Auto quality gate**. Hai warm-up, ba lượt đo:

| Chặng | Trung vị | Khoảng N=3 | Solve |
|---|---:|---:|---:|
| Cold preview — reset session, không cold OS/process | **15.171 ms** | 14.014–20.505 ms | 13/lượt |
| Warm preview | **3.000 ms** | 2.634–3.144 ms | 0 |
| Handoff reference | 415 ms | 371–444 ms | 0 |
| Xuất PDF từ manifest | **10.191 ms** | 10.012–10.507 ms | 0 |

Mỗi lượt có 26 trang. Cold/warm cùng layout trong từng lượt; preview/export cùng tập manifest/fingerprint/pose digest; source không đổi. Đã raster toàn PDF để lưu digest và dùng Poppler soi Front/CUT đầu tiên. Không thay thế nghiệm thu pixel frontend hoặc CNC duplex.

Ba cold solve xếp **583 / 589 / 582** placement, layout khác nhau giữa các lượt. Không dùng lượt nhanh hơn để chứng minh chất lượng giữ nguyên.

### 2.3 Đồng hồ nhẹ tách pha — không trộn thành A/B

Một lượt riêng cùng source/settings/binary, chỉ bọc đồng hồ quanh hàm thật:

| Chặng xuất nesting | ms | Tỷ lệ tổng 6.234 ms |
|---|---:|---:|
| Dựng jobs/nhận diện lại | 194 | 3,1% |
| Nạp/xác minh 13 manifest, source/lease | **3.314** | **53,2%** |
| Render 13 mẫu tuần tự | **2.522** | **40,5%** |
| Ghép PDF | 184 | 2,9% |
| Còn lại | 21 | 0,3% |

Lượt này cold/warm 8.461/1.756 ms, xuất 6.234 ms, 659 placement, solve lại 0. **Không có bản vá giữa các lượt.** Source/settings/native hash/grant giống nhau; số thao tác của một mẫu cố định cũng giống, nhưng elapsed native khác nhiều. Chưa có telemetry tải/frequency toàn máy từ đầu để quy nguyên nhân chính xác. Giữ cả hai bộ số, không chọn số đẹp, không gọi là speedup; SLO vẫn HOLD.

### 2.4 Profiler: phân loại đúng chi phí

Một lượt cProfile riêng có overhead, chỉ dùng định vị/counter:

- 19 lần native validate_manifest: 2,839 s cộng dồn — **re-validation, không solve**.
- load_many hai lần, warm + export: 5,565 s inclusive.
- freeze_manifest_polygon: 5.337 call; _manifest_ring: 4.151 lần. Polygon lặp parse theo placement.
- _verify_snapshot: 0,179 s; 38 lần _hash_file: 0,111 s trong main thread. Băm source khoảng 1 MB **không phải hotspot chính được thấy ở đây**.
- Profiler không theo dõi đầy đủ các thread/lane native; không suy số hash này cho toàn cold solve hay PDF 500 MB.
- Raster QA ngoài timer operation tốn khoảng 15 s dưới profiler; không cộng vào latency xuất. Không cộng các cumulative time lồng nhau.

## 3. Đường chạy đã trace

| Lane | Entry → engine → consumer |
|---|---|
| Preview thường | [GridPreview:2723](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:2723) → [route:2048](D:/pdfcompare/backend/app/api/routes/imposition.py:2048) → compute :3862 → nup_sticker.py:18 re-export sticker_imposer_pkg/layout_compute.py:22 → cells/diePolylines → [SVG:3166](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:3166). |
| Bảng sức chứa | [Dashboard:1239](D:/pdfcompare/desktop/src/components/imposition-tools/ImposerDashboard.tsx:1239) → POST :1433 → [batch route:4322](D:/pdfcompare/backend/app/api/routes/imposition.py:4322) → cùng compute :4553 → capacities → Dashboard :1461. |
| Preview nesting | GridPreview → lib/mixed-nesting/api.ts → preview-job route → nesting_preview_jobs → [S&R capacity:724](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:724) → build jobs/session/wave → production pipeline/orchestrator/service/PyO3 → manifest → [projection:658](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:658) → SVG. |
| Bấm Bình | [processHandlers:427](D:/pdfcompare/desktop/src/lib/processHandlers.ts:427) → api.ts:946, /api/imposition/nup-start → [route alias:1279](D:/pdfcompare/backend/app/api/routes/imposition.py:1279) → _launch_impose_job:1104/prep/handoff → scheduled N-up/process con → run_nup_engine:238. Router đăng ký ở backend/app/main.py:372. |
| Thực thi thường | nup_engine → [finalizer:595](D:/pdfcompare/backend/app/workers/nup_output_finalize.py:595) → nup_process_chunk:138 → artwork/CUT → merge/report/PDF. CNC thường đi cnc_render riêng. |
| Thực thi nesting | [S&R export:2054](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:2054) → load references :2124 → render từng mẫu :2162/:2240 → nesting_production_pipeline:723 → [writer:1255](D:/pdfcompare/backend/app/workers/nesting_imposition_render.py:1255) → imposition_pdf_form → PDF/lease/status → [output consumer:443](D:/pdfcompare/desktop/src/lib/processHandlers.ts:443). |

Legacy preview trả geometry JSON, không encode PNG/base64 trong route này. StickerEngine thuộc tạo đường cắt/bù xén, không phải engine RUN đang audit.

## 4. Findings CONFIRMED

### §TEMPERF.1 — P2 / M — Preview đơn/batch cùng tính một cache miss

imposition.py:3854–3889 và :4511–4574 cùng dùng _NEST_A_CACHE nhưng miss → compute → publish không có singleflight. UI có hai caller cùng reachable ở lane legacy; true-shape đã tránh batch legacy, không gán lỗi cho mọi request CUSTOM.

Root gọi lại route/helper thật trên DUMBBELL, page index 13 của PDF 17 trang:

| Tình huống | Compute thật | Cache entry | Sức chứa |
|---|---:|---:|---|
| Single rồi batch tuần tự | 1 | 1 | 30/30 |
| Hai single, miss đồng thời có barrier | 2 | 1 | 30/30 |
| Single + batch, có barrier | 2 | 1 | 30/30 |
| Single + batch tự nhiên, không barrier | 2 | 1 | 30/30 |

Arguments compute giống nhau. Tuần tự 342 ms, tự nhiên đồng thời 851 ms là probe N=1, không A/B sau sửa.

Đây là tồn đọng PERF-IMPO-05/đề xuất 09-05 được xác nhận lại. Đề xuất per-key owner/follower; không giữ global lock trong compute; giữ exception/cancel/source revision/copy ownership. **Giải quyết §TEMPERF.C1 trước hoặc cùng lô.**

### §TEMPERF.2 — P2 / S — Bảng sức chứa vẫn phát request ở tab nền

App.tsx:1618 giữ tab mounted; ImpositionTab truyền isActive cho Dashboard. [Effect:1239](D:/pdfcompare/desktop/src/components/imposition-tools/ImposerDashboard.tsx:1239) không đọc nó; dependencies :1470 chỉ fetchEpoch/OCG/preview-enabled. Cleanup :1468 chỉ đặt cancelled và clear timer.

Root lấy đúng callback từ AST, mock timer/network:

- isActive=false vẫn POST một lần.
- Cleanup khi fetch đang chạy: signal.aborted=false.
- Kết quả muộn được bỏ đúng: commits sau cleanup = 0.

Đã chứng minh công việc vẫn được phát, chưa đo lag/CPU mất bao nhiêu trên app thật. GridPreview riêng đã gate/cancel tab nền.

Đề xuất gate trước debounce, sau resolve nguồn và trong cleanup; giữ theo tab/revision. HTTP abort không tự dừng compute của sync route đã nhận; cooperative cancellation backend là lô riêng nếu cần.

### §TEMPERF.3 — P2 / M — Polygon bất biến bị parse/đóng băng theo từng placement

- [Preview:183](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:183) resolve artwork seam rồi transform CUT từng cell.
- [Seam:1584](D:/pdfcompare/backend/app/workers/nup_artwork.py:1584) freeze lại artworkClipPath.
- [Writer:1353](D:/pdfcompare/backend/app/workers/nesting_imposition_render.py:1353) làm tương tự theo placement/side.
- [freeze:368](D:/pdfcompare/backend/app/workers/nup_clip_shape.py:368) đã có fast path FrozenManifestPolygon, nhưng caller thường đưa mapping. _manifest_ring:347 parse mọi đỉnh và kiểm tập điểm lại.

Microprobe dùng 13 polygon thật và 582 placement của artifact vừa đo, cùng helper hiện hữu, không sửa production:

| 1 warm-up + 3 lần đo | Mapping mỗi placement | Freeze một lần |
|---|---:|---:|
| Median transform helper | 168,450 ms | 80,200 ms |
| Tọa độ đầu ra | cùng SHA-256 | cùng SHA-256 |
| Polygon chuẩn hóa | lặp theo cell | 13 |

Helper giảm khoảng 52%, nhưng chỉ tiết kiệm khoảng 88 ms trong phép thử đó, **không phải toàn preview nhanh gấp đôi**. Không suy 4,144 s dưới profiler thành thời gian tiết kiệm thực.

Đề xuất immutable render context theo part/side trong một request/job: validate raw input đầy đủ, tách alias, giữ per-placement identity/pose. Không cache theo id() xuyên request hoặc tin object “đã validate” do client tự gửi.

### §TEMPERF.4 — P2 / S–M — Writer nhiều tờ quét toàn placement lặp lại

[Writer:1164](D:/pdfcompare/backend/app/workers/nesting_imposition_render.py:1164) lọc toàn manifest cho mỗi tờ; _render_sheet_plan:1230 gọi trên mọi physical sheet trước dedup. Render/report còn quét lại.

Root tái hiện public writer, manifest synthetic đúng contract, 2 placement/tờ, xuất unique:

| Tờ vật lý | Placement | Lượt quét | Placement visits | PDF |
|---:|---:|---:|---:|---:|
| 10 | 20 | 13 | 260 | 2 trang |
| 20 | 40 | 23 | 920 | 2 trang |
| 40 | 80 | 43 | 3.440 | 2 trang |

Chi phí P × (S+3) dù file chỉ còn một Front/CUT đại diện. Nguồn không đổi; Front vẫn một Form. Phạm vi quantity fulfillment nhiều tờ, không phải S&R một tờ/mẫu. Chưa đo latency đơn hàng lớn.

Đề xuất index theo sheetIndex một lần; giữ sort UTF-8 instanceId, exact recipe key, report run count và thứ tự tờ.

### §TEMPERF.5 — P2 / S — WARNING chẩn đoán trong vòng vẽ CUT

[ShapeBuilder.finish:238](D:/pdfcompare/backend/app/workers/pdf_ops.py:238) gọi WARNING “[CUT-PATH-AUDIT] …” khi có OCG/path, không dev/opt-in guard.

Benchmark legacy thật phát hàng nghìn dòng từ process render; không chỉ là regex. Logger parent được tắt giảm nhiễu nhưng child spawn vẫn phát. Chưa đo A/B logging, không quy cả 2,31 s cho log.

Đề xuất debug/dev opt-in hoặc tổng hợp một counter/job, giữ nguyên path operations. Khác với ROT-AUDIT đã có gate và không phải finding mở.

### §TEMPERF.C1 — P1 / M — Batch/cache và preview chưa cùng hệ tọa độ

Finding correctness trong lúc kiểm an toàn cho §TEMPERF.1, chưa sửa.

- Single [imposition.py:2277](D:/pdfcompare/backend/app/api/routes/imposition.py:2277) mở nguồn canonical, giữ original path trong cache key để tránh temp-path miss.
- Batch :4651/:4690 mở nguồn gốc; compute vào cùng raw-layout cache.
- diePolylines sang [SVG:3166](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:3166) sau đổi đơn vị, không tự sửa hướng theo bbox.

Probe cuối dùng PDF **hai trang độc lập, kích thước khác nhau**, phù hợp gate multi-page; trang 0 Rotate=90, trang phụ không chung content stream. So cache rỗng → single với cache rỗng → batch → single:

- Rotate 0: response bằng nhau, 0 mismatch.
- Rotate 90: cùng sức chứa 12, cell 80×180 pt; sau batch polyline thành **180×80 pt**, isRotated false→true, **12/12 cell mismatch**.
- Đây là sai khác response/hình học tới consumer, không phải bằng chứng PDF xuất sai hay máy bế lỗi; chưa Tauri/raster frontend.

Đề xuất batch cùng canonical source/geometry contract; giữ khóa nguồn ổn định. Regression Rotate 0/90/180/270, UserUnit/page boxes, multi-page, single→batch/batch→single trước singleflight. Không chỉ đổi key để che hai route tính khác nhau.

## 5. Nút thắt manifest và các hướng chưa chứng minh

### Chi phí có thật, validation vẫn bắt buộc

NestingManifestStore.load_many:1739–1768 decode/validate record tuần tự rồi resolve source/lease. Lượt đồng hồ nhẹ đo 3,314/6,234 s; profiler chỉ ra native re-validation và marker/fsync, không chỉ SHA-256.

Đây là hướng nghiên cứu tối ưu lớn, **không gọi toàn bộ validation là thừa**:

- Giữ hash, schema/native final validator, source revision, lease expiry và fail-closed.
- Xem decode/re-validation độc lập theo batch có admission/hardware grant; giữ order/atomic failure. Source PyO3 [validate_manifest:250](D:/pdfcompare/native/src/mixed_nesting_py.rs:250) đã dùng py.detach, không đề xuất “nhả GIL” như việc chưa có.
- Đo validate/resolve/renew trên cùng manifest cố định trước khi chọn song song. Không thêm pool/cap mù hoặc chiếm hết CPU của preview.
- Shared snapshot/cross-job hash vẫn là backlog PERF-NEST-02, nhưng chưa đáng đặt trước native validation/render trên file khoảng 1 MB này.
- Render S&R tuần tự/save report lần hai đã có telemetry; chỉ gộp/parallel sau khi bảo vệ source/strip CUT/OCG/report/cancel.

### SUSPECTED — chưa xếp severity

- Batch imposition.py:4680 còn min(4, len(valid_groups)) không RAM gate; tồn đọng cũ. Chưa chứng minh tăng thread lợi hơn GIL/I/O.
- Ghép nét nhiều mảnh ở GridPreview:1209 có all-pairs, chạy theo cell; chưa React Profiler/long-task thật.
- Working PDF đã edit có thể materialize/upload lại khi đổi tham số bình; flow này đang được phiên khác sửa, cần snapshot ổn định để recheck.
- Đa trang dùng chung Image/Form có thể mất sharing do mở QPDF mới từng source-page. Không dùng probe subagent chưa được root tái hiện làm finding chính.
- Polling 400/500 ms và debounce 250/750 ms là hiện hữu; chưa click→paint nên chưa đề xuất giảm.
- Biến thiên yield dưới deadline phải kiểm cùng KPI tốc độ; không thay NFP bằng bbox, giảm góc hoặc timeout để tạo số đẹp.

## 6. Verify và khoảng trống

| Kiểm tra | Kết quả |
|---|---|
| Windows Vitest: Dashboard grouping parity, GridPreview mixedDuplex, mixed-nesting API | **106 passed / 3 file**, subagent chạy; file chính đọc/đối chiếu lại |
| Backend: custom fast path, lazy NFP, canonical parity, nesting writer, clip/clip render, PDF Form, handoff | **144 passed + 1 môi trường fail**, named pipe WinError 5 trong sandbox |
| Chạy lại riêng test_process_con_that_render_khong_solve ngoài sandbox | **1 passed**; không gọi invocation sandbox ban đầu xanh |
| Root probe duplicate, background exact-effect, frozen helper, writer scan, canonical cache | Tái hiện như §4, script/output trong evidence |
| Benchmark legacy/nesting | Engine/detector/writer thật; không thay solver/chất lượng |
| PDF QA nesting | Parse 26 trang/boxes; source/hash/manifest/pose same-run; raster digest toàn PDF, soi Front/CUT đầu bằng Poppler |

Không chạy full suite, typecheck/build/Rust rebuild/installer; không cập nhật golden. Chưa frontend first paint, HTTP throughput, outer startup, auto-save download, CNC duplex nặng, contention 3+ job, hai tier RAM thấp. cProfile là lượt riêng, không nằm trong ba mẫu latency.

N=3/N=1 không đủ P95. Trường p95NearestRank của harness giữ trong raw nhưng **không dùng như SLO**. Biến thiên chưa quy hết nguyên nhân: cần N≥20, ít nhất hai warm-up, fingerprint và tải máy/process-tree telemetry trước nghiệm thu tăng tốc.

Ba harness tạm mới đã được dọn sau khi lưu nguyên văn trong mục driverSnapshots của evidence; có thể khôi phục từ đó. Kho benchmark/raw PDF/profiler riêng được giữ làm bằng chứng đối soát, không ghi vào kho session đang dùng của ứng dụng. Các script/fixture có sẵn trước audit được giữ nguyên.

## 7. Lộ trình đề xuất — chốt duyệt

Mỗi lô ≤5 file code/test; verify và kiểm thao tác thật trước lô tiếp. Đây là đề xuất, không giấy phép tự triển khai.

| Lô | Nội dung | Scope dự kiến | Cổng ra |
|---|---|---|---|
| A1 — an toàn cache | §TEMPERF.C1: canonical batch như single | route + parity tests, 2–3 file | Cùng geometry bất kể thứ tự request/Rotate/UserUnit/page box; key ổn định |
| A2 — preview nhanh | §TEMPERF.1: singleflight | route/helper + concurrency tests, ≤3 file | Cùng key 1 compute; khác key song song; lỗi/hủy/revision không trả stale |
| B — quick win thực thi | §TEMPERF.5: log CUT | pdf_ops + test, 2 file | Diagnostics off không WARNING từng tem; PDF/path không đổi |
| C — bỏ request tab nền | §TEMPERF.2 | Dashboard + test, 2 file | Không request mới ở tab nền; cleanup/source-resolve race đúng |
| D — dùng lại hình học | §TEMPERF.3 | clip/artwork + preview hoặc writer + tests, chia lô nếu >5 | Tọa độ/pixel/holes/rotation/invalid-input/alias guards giữ nguyên |
| E — đơn nhiều tờ | §TEMPERF.4 | writer + tests, 2–3 file | O(P) grouping; sort/recipe/report/duplex/artifact giữ nguyên |
| F — dư địa lớn ở manifest | Đo/A-B decode/native validation/lease rồi chọn tối ưu | manifest/service/planner + tests, ≤5/lô | Giữ validator/hash/lease, fail-closed/order/cancel; RAM/grant đúng |

**Khuyến nghị A1→A2 trước**, kèm B nếu muốn quick win không đổi hình học; sau đó C/D. Muốn giảm nhiều thời gian thực thi nesting thì F quan trọng nhất theo số đo, nhưng cần thiết kế/benchmark riêng, không bỏ validation.

Acceptance: cùng input/settings và quality floor; không mất tem/tăng tờ; preview–manifest–PDF cùng hợp đồng; ≥16 GB giữ toàn công suất, chỉ tier <8/<16 GB điều chỉnh; không đổi Cargo release profile hoặc bỏ PDFium lock.

**Dừng ở chốt duyệt theo prynx-audit-workflow. Không có production patch hoặc commit trong lượt audit này.**
