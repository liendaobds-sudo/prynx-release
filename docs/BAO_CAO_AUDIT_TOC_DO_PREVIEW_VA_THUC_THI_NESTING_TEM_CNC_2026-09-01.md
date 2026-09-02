# BÁO CÁO AUDIT TỐC ĐỘ PREVIEW VÀ THỰC THI NESTING TEM BẾ / CNC

**Ngày audit:** 2026-09-01
**Cập nhật triển khai cuối:** 2026-09-02
**Phạm vi:** preview `true_shape_nesting`, Bình trang (S&R), handoff preview → Bình,
writer Front/Back/CUT và modal Gửi máy bế CNC.
**Trạng thái:** **LÔ A–F ĐÃ TRIỂN KHAI VÀ VERIFY Ở MỨC SOURCE/AUTO/PROBE; HOLD.**

## 1. Kết luận điều hành

Phản ánh “preview và thực thi chậm” là có cơ sở. Nút thắt không nằm ở React/SVG:
trên corpus 13 mẫu hiện tại, bước chuyển manifest thành cell chỉ mất **369 ms**.
Chi phí lớn nằm ở solver, công bố/đọc lại manifest và source verification lặp.

Kết quả sau khi user duyệt Lô A rồi yêu cầu triển khai toàn bộ các lô còn lại:

1. **PERF-NEST-01 đã sửa.** Preview S&R nay solve/công bố theo wave và tổng worker
   grant dùng chung. Đúng harness/native của lượt Lô A, wall time giảm từ **62,840 giây xuống
   25,925 giây**: nhanh hơn **2,42×**, giảm **58,7%**. A/B sau refactor giữ nguyên
   cả 13 `placedCount` và `poseDigest`; projection 661 placement mất **375 ms**.
2. **PERF-NEST-02 đã giảm mạnh nhưng mới đóng một phần.** Proof preflight được tái
   dùng an toàn trong transaction persist; marker authoritative deterministic resolve
   locator O(1); execution nạp reference bằng `load_many()`. Sau khi chỉ tải lại sáu
   manifest đã spill và giữ nguyên bảy session nóng, benchmark cùng harness N=3 cho
   cold **10,614–15,258 giây**, warm **1,738–2,810 giây** (trung vị **2,123 giây**),
   `load_many` **1,115–1,673 giây**. Warm nhanh hơn khoảng **2,09×** so với warm
   trước subset-load (**4,439 giây**); cả ba cặp giữ `solve=0`, 13/13 manifest
   byte-equal và 44/44 cell. Chưa dùng shared snapshot xuyên 13 job, nên cross-job
   hash/copy vẫn là phần mở. Benchmark current source/native N=20 sau hai warm-up
   xác nhận preview cold P50/P95 **9,313/10,758 giây**, warm P50/P95
   **2,265/3,458 giây**; warm có `solve=0/20`, một layout digest và parity.
   Execution từ reference đạt tổng P50/P95 **6,416/7,066 giây**, không solve lại và
   giữ raster artifact parity trên PDF 26 trang.
3. **PERF-NEST-03 đã sửa.** Route nhận/admit job rồi trả `job_id`; handoff chờ
   publication chạy ở prep executor riêng, có `preparing_manifest`, cancel-aware wait
   và chỉ submit process render sau khi publication hợp lệ. Pool prep chỉ giảm ở máy
   `<8 GB`/`<16 GB`; máy `≥16 GB` không bị hard-cap.
4. **PERF-NEST-04 đã sửa.** Deadline giữ nguyên mốc từ lúc tạo `RunControl`, bao cả
   baseline/probe/search và không re-arm sau baseline. Cancel luôn ưu tiên hơn deadline;
   publication/final validator vẫn hoàn tất để không giao layout chưa kiểm.
5. **PERF-NEST-05 đã sửa.** Preview công bố quality-gate proof server-owned bind
   snapshot/policy/input/layout. Export dùng proof còn hợp lệ mà không probe PDF lại;
   proof thiếu/méo/stale chỉ probe đúng một lần trên snapshot resolved. `grid_capacity=0`
   là “không có ý kiến”; S&R kiểm proof riêng theo `design_index`.
6. **PERF-NEST-06 đã instrument.** Writer nay đo embed, form paint, page build,
   base save, report, duplex, merge và publication. N=20 current source cho execution
   có render P50/P95 **2,621/2,674 giây**, merge **0,213/0,266 giây**. Raw CNC writer
   authoritative N=20 cho fixture synthetic `quantity=2`/hai pose đạt simplex
   **12,980/13,714 ms** và duplex report/registration **22,498/28,976 ms**; cả hai
   giữ raster/sides/artifact parity. Fixture này không chạy detector/solver và quá nhẹ
   để thay cho CNC duplex nặng thực tế, nên chưa gộp save hoặc tuyên bố GO.
7. **PERF-NEST-07 đã sửa đường export proof.** API `cut-inspect` hash/quét mọi trang/
   candidate/preview trong một lần mở descriptor và một lần parse PikePDF, cấp proof
   riêng cho từng trang CUT. Export dùng `CutModel` server-owned và chỉ băm lại source
   hiện tại; proof sai/stale/replay fail-closed, không parse fallback. Frontend có
   abort + latest-only + atomic snapshot; Gửi tất cả dừng ở lỗi đầu tiên, giữ ledger
   các tờ đã gửi, retry chỉ tờ còn thiếu và khóa tiếp khi proof đổi revision. Lô E5
   khóa Docker về một API process để state proof process-local không bị rơi giữa hai
   worker; các pool việc nặng bên trong vẫn giữ hardware grant theo RAM/CPU.
8. **PERF-NEST-12 đã sửa.** Trước bản vá, hai preview S&R 13 mẫu đồng thời mỗi batch
   tự nhận trọn grant 15, làm tổng grant đạt **30** trên machine plan 15. Coordinator
   process-wide nay cho batch đơn dùng đủ máy nhưng chia capacity khi nhiều batch;
   chỉ singleflight owner thật giữ token. Probe N=3 sau sửa giữ grant tối đa **15**,
   đủ 26 solve/scenario và giảm deficit layout concurrent so với `6×659` placement
   từ **50 xuống 16**. Concurrent pair median gần như phẳng
   (**16.538,152→16.456,226 ms**), nên không dùng throughput ratio để nhận công tăng
   tốc tuyệt đối. Latency chia CPU và một outlier layout vẫn còn; §5.9 ghi rõ giới hạn.
9. **PERF-NEST-13 đã sửa.** Bình trang chỉ invalidate preview theo input hình học và
   tập trang có số lượng dương. Đổi số lượng dương, mã đơn, tên sản phẩm, vật liệu hoặc
   cán màng không gọi lại preview; N-Up/CNC vẫn giữ số lượng trong identity khi nó ảnh
   hưởng layout. Writer nhận report Execute mới qua override typed, giữ nguyên manifest,
   `layoutFingerprint` và `renderBundleHash`, đồng thời sinh `reportHash` và fingerprint
   artifact riêng. UI Bình trang giữ Sức chứa và tính “Cần in” cục bộ từ SL mới; chỉ bỏ
   Kiểu xếp. Hai thống kê này đổi ngay mà không gọi lại preview.
10. **PERF-NEST-14 đã sửa.** Khi batch S&R durable đã được nhận diện, toàn bộ identity và
   `reportHash` của Execute được dựng nguyên tử mà không đòi session nóng. LRU không còn
   làm marker thiếu hash từ mẫu 2; child chỉ được load manifest hoặc fail-closed.

Không nên thêm worker/cap vô điều kiện. Current native đã nhận hardware grant, nhả
GIL, chạy portfolio/NFP cold-miss song song; trace có `prewarmPeakWorkers=13`.
N=20 hiện là baseline current source trên máy `≥16 GB`; contention mới được đo N=3
cho đúng hai preview S&R 13 mẫu. Chưa phủ hai tier RAM thấp, 3+ preview, packaged
runtime hoặc CNC duplex nặng. Vì vậy đã có P50/P95 cho máy audit hiện tại nhưng chưa
đủ để tuyên bố SLO đa tier hay production GO.

## 2. Provenance và giới hạn số đo

- Máy audit: 16 logical CPU, RAM tổng khoảng 32.528 MB; available biến thiên khoảng
  17.031–18.610 MB giữa các lượt đo, thuộc tier `≥16 GB`.
- Input chính: `test/test nesting.pdf`, 13 trang, 1.002.883 byte,
  SHA-256 `EFCDE4F0A16ACA0A5A54EE2D952945AFE2EB70DD2073BC9FF59EE87292B257AB`.
- Native của các probe Lô A/B:
  `nativeBuildIdentity=3298c2f41e0a87573604e4ed62cd9f0b9abb07f73b527d89b79ae2511b70e954`,
  `baselineVersion=12`, `solverVersion=4`.
- Harness subset-load N=3 cuối dùng
  `nativeBuildIdentity=04f400876b084d2b7d63c8789f682808edc933d95b827f5fee9e156088b4d0a0`,
  `baselineVersion=12`, `solverVersion=4`; không gộp số của hai native identity.
- Harness N=20 current source dùng cùng identity
  `04f400876b084d2b7d63c8789f682808edc933d95b827f5fee9e156088b4d0a0`, extension
  SHA-256 `B48FC5C4E0884D3ADFA00AF0762B93F239FC05915E73A0D42A3024399A3204AE`,
  input SHA-256 `EFCDE4F0…57AB`; `identityMatches=true`. Raw preview/execution nằm ở
  `f2-current-n20/{preview-n20,execution-n20}.json`; percentile dùng nearest-rank và
  preview có hai warm-up trước 20 mẫu đo.
- Raw CNC writer authoritative là
  `backend/.audit-tmp/f2_benchmark_2026-09-02/cnc-n20.json`, SHA-256
  `CD5459DF64340E6F8597E102ACD8D825665D7C0B8E1E3A9D0315A5EC6CE11FF9`.
  Driver tự sinh nguồn synthetic 1/2 trang, đặt `quantity=2` và đúng hai pose; vì vậy
  số đo chỉ đại diện writer, không đại diện detector/solver hay đơn nhiều tờ.
- Lượt breadth Lô 0 chạy đủ 23/23 ca bằng `scripts/lo0_nesting_baseline.py`, Fast,
  free rotation, `time-budget-ms=2000` và `lap=1`. Corpus
  `backend/tests/fixtures/nesting_tu_do/corpus_lo0.json` có SHA-256
  `F302E1C98DBE586034A362D5ECFE30637EB60D982051E61B176162900CFFDCDA`; raw report
  `%TEMP%/prynx_lo0_current_full23_20260902.json` có SHA-256
  `0D1D76464DDE39D7C2E25CABE8F5C9719CF12717098C8D2795B9AA41177B5838`.
  Đây là N=1/case trên PDF synthetic do script sinh, không phải percentile hay
  artifact preview↔export.
- Contention trước/sau dùng cùng input/native/build identity/algorithm/driver
  definition. Artifact `queue-contention-sr13-20260902/queue-contention-before-n3.json`
  có SHA-256 `B474E810740F29A444AB02EF4231735C3E3563DA58FCA4B641F521D2D1034081`;
  bản after có SHA-256
  `743DCCA6E24FF708C5F62EFFB4F05BBDC59B5032B590828386FB0DB6E6619955`.
  Mỗi bên chỉ N=3 + một warm-up, `sourceDirty=true`; JSON không niêm phong hash Python
  source/driver tại từng thời điểm nên không dùng chênh lệch wall nhỏ làm speed claim.
- Các probe Lô A/B với identity `3298c2f4…e954` là N=1 trên máy đang có process
  nền; **không gọi là P50/P95**. Harness N=3 với identity `04f40087…b4d0a0` cũng
  chỉ là probe parity/subset-load, không phải percentile. Số từ `%APPDATA%/PrynX/logs`
  được ghi rõ là lịch sử khi native identity khác.
- Worktree đã rất bẩn trước audit. Audit không hoàn tác hay ghi đè thay đổi sẵn có.
  Lô A chỉ thay đổi 3 module backend + 2 file test. Lô B được tách thành B1 proof
  transaction, B2a marker authoritative, B2b batch-load worker và B2c cô lập artifact
  pytest; mỗi sub-lô chạm không quá 5 file. Hai harness nằm dưới
  `backend/.audit-tmp/`; artifact harness subset-load cuối nằm dưới `f2-profile/`.
  Lô F contention chạm đúng 4 module production + 1 file test. Không hoàn tác file
  ngoài lô.
- Side effect audit đã dọn sau khi user duyệt: xác minh đủ đúng **26** snapshot
   `nesting_source_<audit-id>.pdf` nằm dưới `backend/uploads`, cùng kích thước
   1.002.883 byte/file, tổng **26.074.958 byte**, rồi xóa bằng danh sách đường dẫn
   tường minh. Chữ ký hậu kiểm gồm `CreationTime` từ `2026-09-01 21:09:48` đến trước
   `21:10:45`. Kết quả: **26/26 đã xóa, remaining=0, bytes=0**; thao tác không thể
   khôi phục.
- Hai lượt regression trước khi có fixture cô lập đã tạm sinh thêm **92 snapshot +
  88 marker** nhưng không sinh manifest. Hai cụm này đã được thu hồi; inventory cuối
  trở về **1.490 snapshot / 1.264 marker**, không còn marker deterministic của lượt
  test. `tests/conftest.py` nay ép `UPLOAD_DIR`, `RESULTS_DIR` và mixed-nesting root
  vào thư mục tạm riêng theo process; smoke test sau sửa giữ nguyên inventory thật.
- Một probe production preview độc lập cùng native Lô A/B trả **59.014,507 ms /
  13 tờ / 653 placement**. Sai khác với probe instrumented 62.839,733 ms / 661
  placement đến từ cấu hình request/finishing và tải máy; cả hai là N=1, không gộp
  thành percentile. Bảng phase bên dưới dùng duy nhất lượt instrumented nhất quán.

## 3. Luồng live hiện tại

```text
GridPreview debounce 750 ms
  → POST preview job
  → backend threadpool + registry/progress/cancel
  → build job + detect khuôn
  → plan_batch_hardware chia wave + worker grant toàn máy
  → pin source + preflight proof (SHA-256/inspect trên bản sao ổn định)
  → mỗi lane đi qua preview session singleflight bằng subscriber con riêng
  → Rust solve; persist tái dùng proof, rehash nhưng không inspect lại
  → marker locator deterministic publish no-replace; không scan kho lease
  → session được bảo vệ khỏi LRU trong lúc persist reference
  → collect reference/project cell theo đúng thứ tự mẫu nguồn

Bấm Bình
  → route validate/admit, tạo job và trả job_id
  → prep executor đặt preparing_manifest
  → build/detect + cancel-aware publication wait + commit reference ngoài event loop
  → submit process con
  → process con `load_many()` toàn batch, resolve marker O(1), full revalidate
  → quality gate dùng proof server-owned còn hợp lệ; proof stale mới probe snapshot 1 lần
  → render Front/Back/CUT
  → telemetry embed/paint/page-build/base-save/report/duplex
  → telemetry merge / publish output
  → frontend poll 500 ms

Mở modal Gửi máy bế
  → POST cut-inspect có AbortSignal/latest-only
  → hash trước + một pikepdf.open trên cùng descriptor
  → quét mọi trang, chọn CUT page, layer/spot và dựng SVG
  → hash hậu kiểm + stat fence rồi commit một snapshot UI
```

Triển khai Docker dùng một API process vì inspect proof giữ secret và `CutModel` trong
RAM process-local; đây là bất biến ownership, không phải hard-cap worker của solver.

Các claim cũ “preview chặn event loop”, “không progress/cancel”, “request abort
không hủy native”, “không RAM admission”, “preview trùng solve”, “native chỉ dùng
một core” **không còn đúng với source hiện tại**. Preview job thật đã chạy trong
threadpool; progress/cancel/singleflight/RAM admission/hardware grant đều hiện hữu.

## 4. Bảng trạng thái finding/điều tra

| Mã | Mức | Trạng thái | Finding | Bằng chứng chính |
|---|---:|---|---|---|
| PERF-NEST-01 | P1 | FIXED + AUTO/PROBE | Preview S&R dùng wave/grant chung; mọi batch nhiều mẫu có durable reference/latch, LRU fence và input order | `nesting_preview_capacity.py`, `nesting_preview_session.py`, `nup_true_shape_nesting.py`; `62,840→25,925 giây` |
| PERF-NEST-02 | P1 | FIXED-PARTIAL + AUTO/PROBE | Proof transaction + marker locator O(1) + subset batch-load; shared snapshot/cross-job hash còn mở | `nesting_source_pin.py`, `artifact_lease.py`, `nesting_manifest_store.py`; N=20 preview cold P50/P95 `9,313/10,758 giây`, warm `2,265/3,458 giây` |
| PERF-NEST-03 | P1 | FIXED + AUTO | Route trả `job_id` trước; handoff chạy prep executor, có `preparing_manifest` và cancel-aware publication wait | `imposition.py`; `nesting_preview_session.py`; lifecycle/handoff 95 pass |
| PERF-NEST-04 | P1 | FIXED + AUTO | Deadline chung bao baseline/probe/search, không re-arm; cancel ưu tiên; publication/final validation giữ nguyên | `control.rs`, `baseline.rs`, `multi_start.rs`; Rust 92 pass/2 ignored |
| PERF-NEST-05 | P2 | FIXED + AUTO | Quality-gate proof bind snapshot/policy/layout; export chỉ probe một lần khi proof thiếu/stale | `nesting_quality_gate.py`, `nesting_preview_capacity.py`, `nesting_preview_session.py`, `nup_true_shape_nesting.py`; 246 pass |
| PERF-NEST-06 | P2 | INSTRUMENTED + AUTO/PROBE | Có phase timing/counter cho embed, paint, page build, base save, report, duplex, merge và publish; chưa gộp save vì CNC N=20 hiện chỉ là fixture writer nhẹ | `imposition_pdf_form.py`, `nesting_imposition_render.py`, `nup_true_shape_nesting.py`, `imposition.py`; execution render P50/P95 `2,621/2,674 giây`; CNC raw authoritative `CD5459DF…11FF9` |
| PERF-NEST-07 | P2 | FIXED + AUTO | Cold inspect hợp nhất descriptor/parse; proof server-owned one-shot, SHA-256 pre/post, latest-only UI, Send All ledger/retry fail-closed | `cut_export/{api,inspect_proof,pdf_source,cut_layer_extractor}.py`, `cut-export/{api,CutExportModal}.tsx`; backend 177 + frontend 17 pass (modal 15 + API 2) |
| PERF-NEST-08 | — | `[SUSPECTED]` | FE cache một entry, warning log và resolve geometry lặp có thể cộng thêm latency | Cần A/B riêng; chưa xếp là bottleneck hoặc severity |
| PERF-NEST-09 | — | `[DISPROVED]` | “Native chỉ dùng một lõi / cần tăng worker” | planner + PyO3 GIL release + Rust wave; `prewarmPeakWorkers=13` |
| PERF-NEST-10 | P1 | FIXED + AUTO/PROBE | Warm rehydrate chỉ tải manifest spill, giữ hot identity; production request canonical 6 số nhưng manifest giữ pose native f64 | `nesting_preview_session.py`; N=20 warm `solve=0/20`, `layoutDigestCount=1`, parity đạt |
| PERF-NEST-11 | P1 | FIXED + AUTO | Docker multi-worker làm proof CNC process-local không ổn định; khóa API một process, không giảm pool solver | `backend/Dockerfile`, `cut_export/tests/test_deployment_contract.py`; 177 pass |
| PERF-NEST-12 | P1 | FIXED + AUTO/PROBE | Hai preview đồng thời tự nhận 30 grant trên machine plan 15, tăng latency và làm deadline rơi placement; coordinator process-wide giữ batch đơn full capacity, chia nhiều batch và chỉ owner thật giữ token | `mixed_nesting_service.py`, `nup_true_shape_nesting.py`, `nesting_preview_capacity.py`, `nesting_production_pipeline.py`; max grant `30→15`, deficit layout `50→16`; 47 focused + 253 production pass |
| PERF-NEST-13 | P1 | FIXED + AUTO | Identity preview Bình trang bỏ trị số SL dương và metadata không ảnh hưởng layout; report Execute tách khỏi bundle/layout nhưng có provenance riêng; UI giữ Sức chứa + “Cần in” tính cục bộ, bỏ Kiểu xếp | `GridPreview.tsx`, `ImposerDashboard.tsx`, `nesting_preview_session.py`, `nesting_imposition_render.py`, `nup_true_shape_nesting.py`; frontend 90 + backend regression dọc đạt |
| PERF-NEST-14 | P1 | FIXED + AUTO | Batch spill đã authoritative không phụ thuộc session nóng; dựng nguyên tử đủ `reportHash`, chặn lỗi mẫu 2 sau LRU và vẫn fail-closed | `nup_true_shape_nesting.py`; regression durable batch/LRU/hash đạt |

## 5. Phân tích chi tiết

### 5.1 PERF-NEST-01 — Preview S&R wave + publication batch — ĐÃ SỬA

Lô A trích `run_step_repeat_batch_wave()` làm scheduler dùng chung cho preview và
execution. Preview không bypass store: từng lane vẫn gọi `get_or_solve()` nên giữ
singleflight/cache/handoff, nhận đúng `runtime_worker_grant_limit`, subscriber con
riêng và cancel cha. Mọi S&R nhiều mẫu mở publication latch trước wave; từng
`session_callback` commit manifest ngoài global lock trong lúc key được bảo vệ khỏi
LRU, rồi `finish_reference_batch()` công bố ordered references. Handoff tra cache+latch
nguyên tử; waiter đã bắt latch giữ detached references dù metadata bị LRU đẩy. State
giữ identity bất biến từ lúc begin và còn sống tới publisher cuối. Projection và
publication batch cuối vẫn ráp theo thứ tự input, không theo completion.

Baseline production preview trước Lô A, native identity `3298c2f4…e954`:

| Pha | Wall time | Tỷ lệ |
|---|---:|---:|
| Solve tuần tự 13 mẫu | 33.348,618 ms | 53,1% |
| Commit/verify 13 manifest | 28.840,424 ms | 45,9% |
| Project 661 placements thành cell | 369,094 ms | 0,6% |
| Khác | 281,597 ms | 0,4% |
| **Tổng** | **62.839,733 ms** | **100%** |

Probe A/B riêng solver cùng native identity `3298c2f4…e954`:

| Cách solve | Wall | Worker grant |
|---|---:|---|
| Baseline tuần tự trước Lô A | 34.130,583 ms | mỗi job tự nhận 15 |
| Wave theo planner đã có | 13.194,645 ms | chia `[2,2,1,1,…]`, không vượt ngân sách |

Speedup probe ban đầu quan sát **2,59×**; 13 placed count và mọi pose digest giống
nhau. Đây là bằng chứng dùng để duyệt Lô A; bảng tiếp theo là verify sau triển khai.

Kết quả verify sau sửa, cùng input và native identity `3298c2f4…e954`:

| Chỉ số | Trước Lô A | Sau Lô A |
|---|---:|---:|
| Preview wall 13 mẫu | 62.839,733 ms | 25.925,184 ms |
| Chênh lệch | — | -36.914,549 ms (-58,7%) |
| Speedup | 1,00× | 2,424× |
| Projection | 369,094 ms | 374,911 ms |
| Số tờ / placement | 13 / 661 | 13 / 661 |

Lượt post-fix trước khi chốt latch là 27.350,548 ms; lượt 25.925,184 ms ở bảng trên
là rerun cuối sau khi khóa race handoff/concurrent publisher. Cả hai là N=1 nên chỉ
dùng làm verify regression, không gọi là percentile.

Durable publication nay áp dụng cho cả batch 2–6 mẫu dù vẫn vừa session capacity để
khóa handoff chính xác. Chi phí cold/warm riêng của nhóm nhỏ này chưa có A/B; giữ là
proof gap riêng; Lô B giữ nguyên latch và tối ưu transaction persist phía dưới.

Một A/B solver độc lập sau refactor trên lượt tải máy hiện tại cho
`35.642,127→18.147,901 ms` (1,964×). Mọi `placedCount` và 13 pose digest khớp tuyệt
đối; worker grant wave là `[2,2,1,1,…]`. Các tổng thời gian từng lane solve/commit
không cộng thành wall time vì nay chúng chồng lấp; chỉ dùng wall end-to-end để kết luận.

### 5.2 PERF-NEST-02 — source verification lặp — ĐÃ GIẢM, CÒN MỘT PHẦN

Lô B không thay SHA-256 bằng `size/mtime` và không serialize/trust proof qua process.
`verify_source_pin()` băm vào `TemporaryFile`, parser đọc đúng bản sao byte đó, rồi
băm hậu kiểm path để bắt cả tamper giữ nguyên size/mtime. Proof chỉ sống trong RAM
của đúng transaction server-side và bind locator/hash/size/page metadata/token.

Chi phí mỗi source trong đường mới:

| Chặng | SHA-256 | Inspect PDF | Tra marker |
|---|---:|---:|---|
| Preflight trước solve/persist | 2 | 1 | locator trực tiếp, không scan |
| Persist cùng transaction | 2 | 0 | receipt exact-token O(1) |
| Load độc lập/process khác | 2 | 1 | một batch resolver; locator mới O(1) |

Batch S&R vẫn canonical/hash/native-validate từng manifest và băm từng snapshot;
chỉ chia sẻ metadata inspect theo content digest trong phạm vi request. Marker v1
lịch sử mới fallback quét thư mục tối đa một lần cho cả batch; marker mới có tên
`.artifact_lease_nesting_source_<locatorhex>.json`, token nằm trong payload server-only
và được công bố bằng hard-link no-replace. Promote/refresh/renew/discard bind exact
token + locator + path; renew chỉ chạy sau verify và không hồi sinh lease đã hết hạn.
Trong ngữ cảnh này, “không hồi sinh” là contract của receipt đã quan sát expiry dưới
lock cùng process; race mutate xuyên process vẫn được ghi riêng là proof gap bên dưới.

Regression khóa same-size/same-mtime tamper ở hash→inspect và publish→readback,
duplicate locator khác phase, race create hai process, ABA token cũ, duplicate legacy,
expiry giữa hash→renew, batch thiếu mẫu và input order. Shared snapshot duy nhất cho
13 job không được dùng trong lô này vì chưa có ownership/refcount/cancel contract.

Kết quả lịch sử cùng input/native identity `3298c2f4…e954` dưới đây là các lượt
độc lập N=1, không phải P50/P95:

| Chỉ số | Trước Lô B | Sau Lô B |
|---|---:|---:|
| Preview wall 13 mẫu | 25.925,184 ms | 6.618–9.225 ms (4 lượt) |
| Load/revalidate 13 reference | 8.672,239 ms | 2.940–3.073 ms (2 lượt) |
| Render 13 Front/CUT | 2.727,013 ms | 2.562–2.690 ms |
| Merge 13 PDF tạm | 199,617 ms | 191–206 ms |
| **Tổng execution** | **11.793,183 ms** | **5.890–6.200 ms** |

Preview lịch sử tăng tốc thêm **2,81–3,92×** so với hậu Lô A; execution tăng
**1,90–2,00×**, riêng load/verify **2,82–2,95×**. Các lượt vẫn 13 tờ/661 placement,
`unexpectedSolveCount=0`; artifact execution mới nhất 4.066.533 byte. Harness seed
1.264 marker; cold scan legacy 6.256 ms được đo riêng trước prepare và không tính vào
execution. Ba gap P3 không chặn Lô B: coexistence legacy+deterministic khi authority
hết hạn; race mutate check-then-replace xuyên process chưa có proof runtime; và generic
`release_artifact_lease()` trả idempotent `true` nếu bị gọi nhầm bằng source token
server-only nhưng không retire marker deterministic. Production hiện không expose token
đó và không có đường tạo coexistence hợp lệ vì locator luôn là UUID mới.

#### Verify subset-load và parity cold/warm (N=3, 2026-09-02)

Harness cô lập `f2-profile` chạy ba cặp liên tiếp trên cùng input và native identity
`04f400876b084d…b4d0a0`.
Mỗi cặp bắt đầu từ session store rỗng trong RAM; sau cold, bảy session nóng được
giữ lại và sáu manifest spill được rehydrate bằng `load_many()` ở lượt warm.

| Lượt | Cold (giây) | Warm (giây) | `load_many` (giây) | Solve warm | Manifest/cell parity |
|---:|---:|---:|---:|---:|---|
| 1 | 10,614 | 1,738 | 1,115 | 0 | 13/13 · 44/44 |
| 2 | 15,258 | 2,810 | 1,673 | 0 | 13/13 · 44/44 |
| 3 | 12,133 | 2,123 | 1,294 | 0 | 13/13 · 44/44 |
| **Trung vị** | **12,133** | **2,123** | **1,294** | **0** | **13/13 · 44/44** |

Mỗi cặp có `manifestId`, `layoutFingerprint`, production-request bytes và manifest
canonical bytes giống tuyệt đối; không có re-solve ở warm. Cold giữa các lượt có thể
khác pose/layout digest do deadline solver và tải máy, nên không gộp thành một SLO.
So với warm trước subset-load (**4,439 giây**), trung vị warm mới nhanh hơn khoảng
**2,09×** (giảm **52,2%**). Đây là bằng chứng `AUTO/PROBE` cho nhánh rehydrate,
và được giữ làm mốc lịch sử nhỏ bên cạnh baseline N=20 dưới đây.

#### Baseline current source/native (N=20, 2026-09-02)

Harness `f2-current-n20` dùng input và native identity ghi ở §2, chạy hai warm-up rồi
20 mẫu đo cho từng mode. `operationWallMs` là runtime nghiệp vụ; wall khoảng 15–16 giây
quan sát khi chạy execution còn bao gồm oracle raster/hash hậu kiểm và không được dùng
làm runtime của thao tác.

| Preview 13 mẫu | P50 | P95 nearest-rank | Peak RSS P95 |
|---|---:|---:|---:|
| Cold | 9,313 giây | 10,758 giây | 138,2 MB |
| Warm | 2,265 giây | 3,458 giây | 136,7 MB |

Warm có `solveCallCount=0` ở 20/20 lượt, `layoutDigestCount=1`,
`sessionStoreCapacity=7` và layout parity đạt. Đây là baseline current-source trên máy
`≥16 GB`; riêng bảng N=20 này không phải workload contention và chưa phủ tier RAM khác.

| Execution từ reference, PDF 26 trang | P50 | P95 nearest-rank |
|---|---:|---:|
| Tổng nghiệp vụ | 6,416 giây | 7,066 giây |
| Load reference | 3,368 giây | 4,000 giây |
| Render | 2,621 giây | 2,674 giây |
| Merge | 0,213 giây | 0,266 giây |
| Peak RSS | 132,7 MB | 135,5 MB |

`unexpectedSolveTotal=0`, `pageCounts=[26]`, `rasterHashCount=1` và
`artifactParity=true`. Byte/semantic hash không ổn định giữa các lượt; bằng chứng hiện
tại chỉ khóa raster parity + page count, không tuyên bố artifact byte-identical.

| CNC **writer** synthetic (`quantity=2`, hai pose) | P50 | P95 nearest-rank | Peak RSS P95 |
|---|---:|---:|---:|
| Simplex + report | 12,980 ms | 13,714 ms | 97,309 MB |
| Duplex + report/registration | 22,498 ms | 28,976 ms | 98,824 MB |

Hai ca CNC đều có `rasterHashCount=1`, `sidesParity=true` và `artifactParity=true`.
Đây là fixture writer synthetic nhẹ: driver sinh nguồn 1/2 trang, `quantity=2`, hai
placement; không chạy detector/solver, không đại diện CNC duplex nhiều tờ/registration
nặng. Raw JSON + hash ở §2 supersede các số `11,772/13,536` và
`21,392/22,279 ms` không khớp artifact authoritative hiện có.

#### Khoảng trống fixture/harness CNC duplex nặng thật

Corpus khai báo alias `PROD_CNC_DUPLEX` và biến `PRYNX_LO0_CORPUS_DIR`, nhưng repo
chưa có consumer Python/PowerShell cho alias/env này. `lo0_nesting_baseline.py` luôn
sinh PDF từ mô tả corpus và chỉ đo layout/kernel; không render artifact production.
Hai candidate private đã kiểm cũng không phù hợp: một file thực chất là tờ 8-up đã
dàn/mirror sẵn và detector chỉ thấy contour chữ nhật ngoài 347×448 mm; file mang tên
duplex khác chỉ có một trang. Không candidate nào được tự gán alias để tránh biến ca
tự dựng thành “production thật”.

Đây là **PROOF GAP, không phải finding mới**. Để đóng cần PDF số trang chẵn, từng cặp
Front/Back là nguồn sản phẩm thô có đường bế cả hai mặt và đủ nhiều part/tờ; harness
phải chạy detector → build job → solve → render Front/Back/CUT, hai warm-up + N≥20,
ghi input/native hash, P50/P95, RSS process tree, sides/page-count và
raster/registration parity.

### 5.3 PERF-NEST-03 — handoff không khóa event loop — ĐÃ SỬA

Route vẫn validate source, entitlement, setting và admission trước khi nhận job, nhưng
không còn chờ publication trên MainThread. Sau khi tạo record, route submit
`_prepare_and_queue_nup_process()` vào `_NUP_PREP_EXECUTOR` rồi trả `job_id`.
Prep worker chuyển progress sang `preparing_manifest`, gọi handoff với `cancel_check`,
và chỉ submit `_NUP_EXECUTOR` sau khi reference/publication đã chốt. Cancel trong lúc
wait không spawn process render và nhả submission slot.

Pool prep không dùng một hard-cap chung: `<8 GB` tối đa 2, `8–<16 GB` tối đa 4,
`≥16 GB` dùng đủ min(CPU, admitted jobs). Env `PRYNX_NUP_PREP_WORKERS` vẫn là escape
hatch tường minh. Như vậy máy mạnh không bị hồi quy vì chính tối ưu này.

Verify lifecycle/handoff đạt **95 passed**; một ma trận hẹp khác đạt **55 passed,
1 deselected**. Test khóa route trả trước khi publication hoàn tất, trạng thái
`preparing_manifest`, cancel trong wait, prep failure và chỉ spawn child sau handoff.
Chưa có click-smoke Tauri đóng gói, nên không nâng `RUNTIME`.

### 5.4 PERF-NEST-04 — deadline bao toàn solve — ĐÃ SỬA

Trước sửa, Rust chạy baseline rồi nạp lại cửa sổ deadline cho search. Vì vậy profile
fast/budget 3.000 ms không phải upper bound của preview. Log lịch sử có:

| Ca | Baseline | Validation | Search | Tổng preview |
|---|---:|---:|---:|---:|
| `sr-3678…-p3` | 2.728 ms | — | 3.213 ms | 7.427 ms |
| `sr-3678…-p8` | 31.257 ms | — | 3.229 ms | 41.826 ms |
| `sr-808c…` | 35.390 ms | 4.976 ms | 3.422 ms | 59.379 ms |

Với tờ lịch sử 1.000×1.000 mm / 357 tem, native mất khoảng 29,078 giây; baseline
24,431 giây, Boolean difference 21,020 giây trên 76.828 blockers. Search chỉ 2 ms,
projection 260 ms. Đây là bằng chứng lịch sử identity cũ nhưng xác nhận đúng pattern:
chi phí lõi baseline/Boolean tăng theo số placement, không phải UI.

Sau sửa, `RunControl` giữ deadline tuyệt đối từ lúc được tạo. Baseline quantity trả
ledger/best-so-far hợp lệ khi deadline đến; autofill chỉ công bố tại barrier của sweep
đầy đủ. Search không nhận thêm một cửa sổ mới sau baseline. Checkpoint ưu tiên
`Cancelled` trước `DeadlineReached` rồi mới work budget. Publication alignment và
final validator vẫn chạy sau khi có candidate để không biến timeout thành artifact
chưa kiểm.

Rust deadline/baseline/solver đạt **92 passed, 2 ignored**; hai ignored là benchmark
thủ công. Bộ test có deadline=0 trước/sau baseline, cancel đồng thời deadline, không
dispatch trial mới, quantity ledger, autofill publication barrier và rescue window.
Benchmark percentile solver N=20 trên corpus mixed hiện có vẫn chỉ phủ bốn case trong
`backend/tests/fixtures/mixed_nesting/corpus.json`. Riêng S20 (20 con/5 loại), Fast
đạt P50/P95 **1,958/2,018 giây**, Balanced **5,717/6,096 giây**; layout tất định
20/20 và đặt đủ 20 con trên một tờ.

Một lượt breadth riêng đã chạy đủ **23/23** ca `nesting_tu_do/corpus_lo0.json` với
Fast, free rotation, 2.000 ms và `lap=1`. Trong 22 ca so được, smart không kém
baseline 14 và kém 8; `FAIL_KHONG_CO_DUONG_BE` fail-closed
`RING_TOO_FEW_VERTICES` đúng chủ đích. Điểm đại diện raw kernel: CNC S&R tam giác
**152→85 (-44,1%)**, CNC gang duplex **81→92 (+13,6%)**, stress L300
**174→191 (+9,8%)**. Đây là N=1 synthetic/deadline, không nâng thành P50/P95.

Kết quả `152→85` không phải output auto-route người dùng: tuyến production có quality
gate so với lưới legacy theo từng design và tự nhường lưới khi lưới tốt hơn; preview
và export dùng cùng proof/gate. Manual true-shape vẫn giữ raw nesting theo chủ đích.
Lượt breadth này không tạo/đo artifact preview↔export; benchmark percentile đủ 23 ca
vẫn mở.

### 5.5 PERF-NEST-05 — quality gate preview → export — ĐÃ SỬA

Publication nay có proof nội bộ bind schema/policy fingerprint, normalized input,
source locator/hash, input hash, layout fingerprint, page, intent, capacity và decision.
Chỉ proof do server tạo từ snapshot pin mới có thẩm quyền. Marker/proof do client gửi
bị xóa vô điều kiện trước handoff.

Export dùng proof hợp lệ mà không probe PDF. Proof thiếu, méo hoặc stale chỉ đo lại
đúng một lần trên snapshot đã resolve; không fallback sang path sống. S&R lấy proof
theo từng `design_index` và gate trước commit/projection. `grid_capacity=0` nghĩa là
probe không có ý kiến, không được tạo/tin proof và không được ép rơi khỏi nesting.
Manual `true_shape_nesting` không chạy gate legacy.

Ma trận E3 hợp nhất đạt **246 passed, 1 warning**; subset export/handoff cuối đạt
**75 passed, 1 warning**. Chưa truyền proof xuyên biên không tin cậy và không bỏ các
chốt hash/full-validation của manifest.

### 5.6 PERF-NEST-06 — telemetry writer — ĐÃ INSTRUMENT

Khi `PRYNX_PERF` bật, counter/timing cộng dồn ở cấp job cho:

- embed Form và hit/miss cache;
- paint Form, tổng dựng trang và số Front/Back/CUT;
- base save, report overlay/save, duplex registration/save;
- merge S&R và publication artifact ở parent process.

Telemetry không đọc clock/quét bổ sung khi tắt và mọi lỗi telemetry fail-soft, không
che lỗi/cleanup của job chính. Test writer/render/telemetry đạt **79 passed**.
Lô này cố ý chưa gộp report + registration thành một save: chưa có phase benchmark
cho thấy đó là bottleneck, và đổi thứ tự ghi có thể làm drift layer/report/artifact.

### 5.7 PERF-NEST-07 — modal Gửi máy bế — ĐÃ SỬA ĐƯỜNG EXPORT PROOF

Backend có `POST /imposition/cut-inspect`, giữ Pro gate ở cấp router. Một request dùng
đúng một file descriptor và một `pikepdf.open(source)` để hash, quét mọi trang, chọn
trang CUT, lấy layer/spot và dựng SVG. Hậu kiểm băm lại SHA-256 trên cùng descriptor,
đồng thời so size/mtime/device/inode với path để fail-closed nếu file bị thay giữa hash
và parse — kể cả ghi đè cùng size rồi khôi phục mtime.

Frontend dùng `AbortController`, generation/latest-only và commit nguyên tử
`cutPages + selectedPage + preview`. Fallback legacy chỉ chạy khi sidecar cũ trả
404/405; lỗi nghiệp vụ HTTP 200 không nhân thêm hai request. `selected_page_idx=null`
giữ đúng trạng thái no-CUT, ẩn Gửi tất cả và khóa Gửi. Đổi trang/lớp/nguồn không để
response cũ ghi đè, và không tự request lại sau khi backend chọn trang khác.

Mỗi trang CUT nhận một proof server-owned; `cut-export-from-file` lấy proof nguyên
tử một lần, băm lại source hiện tại và dùng `CutModel` đã inspect, không parse/extract
PDF lần hai. Proof malformed, sai chữ ký, stale, binding mismatch hoặc replay đều
fail-closed. Gửi tất cả dừng ở lỗi đầu tiên, ghi ledger các tờ đã tới máy, retry chỉ
phần còn thiếu; nếu proof/revision đổi sau một tờ thành công thì khóa tiếp tục để
không trộn hai revision.

Backend cut-export full sau bổ sung contract deployment đạt **177 passed, 2 warnings**;
frontend API/modal đạt **17 passed** (modal 15 + API 2), typecheck đạt. Modal hiện bị ẩn trong UI
production hiện tại, vì vậy E4/E5 là hardening đường latent; vẫn cần click-smoke
Tauri đóng gói để nâng bằng chứng runtime.

### 5.8 PERF-NEST-11 — process affinity của proof CNC — ĐÃ SỬA

`inspect_proof.py` giữ generation secret, kho proof và `CutModel` trong RAM của một
process. Docker trước đây khởi động `uvicorn --workers 2`, nên inspect có thể vào
worker A còn export vào worker B và trả `bad-signature`/`unknown-proof` dù người dùng
không đổi file. `backend/Dockerfile` nay chạy `--workers 1`; regression
`test_deployment_contract.py` khóa đúng cấu hình này. Đây chỉ giới hạn số API process
để giữ ownership proof; worker pool solver/prep bên trong vẫn theo hardware grant và
nguyên tắc RAM, không bị cap trên máy mạnh.

### 5.9 PERF-NEST-12 — contention grant giữa nhiều preview — ĐÃ SỬA

Baseline xác nhận hai preview S&R cùng lúc đi qua hai batch độc lập và mỗi batch tự
nhận `totalWorkerGrant=15`, nên tổng grant đạt 30 trên máy chỉ có plan 15. Không phải
áp lực RAM: peak chỉ khoảng 130–145 MB. Oversubscription làm cả hai job chậm và làm
deadline solver công bố layout kém hơn serial.

Lô F thêm coordinator grant process-wide. Một batch đơn vẫn dùng toàn `cpu-1`/capacity
do planner RAM hiện hữu cấp; nhiều batch chia cùng capacity mà không bẻ grant nguyên
tử 2/1 của lane. Chỉ singleflight owner thật claim quota; cache hit/follower không giữ
token. Bounded bypass ngăn chuỗi grant 1 làm grant 2 đói; cancel, exception, lỗi dựng
executor và close khi còn active đều thu hồi đúng waiter/grant. Coordinator là
process-local, phù hợp desktop và Docker một API process hiện tại.

| Chỉ số contention N=3 | Trước | Sau | Chênh lệch |
|---|---:|---:|---:|
| Grant concurrent tối đa | 30 | 15 | -50,0% |
| Active solve tối đa | 26 | 15 | -42,3% |
| Concurrent pair median | 16.538,152 ms | 16.456,226 ms | -0,50% |
| Serial pair median | 19.563,012 ms | 21.009,386 ms | +7,39% |
| Peak RSS concurrent median | 139,496 MB | 140,051 MB | +0,40% |

Toàn bộ 156 measured solve có runtime grant khớp grant được cấp và mỗi scenario vẫn
đủ 26 solve. Oversubscription vì vậy **đã được loại trong ma trận đo**. Tuy nhiên
concurrent wall gần như phẳng và serial baseline sau chậm hơn 7,39%; throughput ratio
`1,1829→1,2767` không phải bằng chứng patch tăng tốc tuyệt đối. Sau sửa, từng job vẫn
chậm hơn serial **56,75%** (A) và **41,32%** (B), cả hai 3/3 lượt — đây là chia sẻ CPU
có thật, không phải oversubscription còn sót.

Chất lượng dưới contention cải thiện: A-center `643/643/643→644/659/659`, B-top-left
`658/659/658→658/659/659`; deficit tổng so với `6×659` giảm **50→16 (-68%)** và cặp
đạt reference tăng `0/3→2/3`. Strict parity vẫn fail vì lượt after đầu còn A=644,
B=658; time budget phụ thuộc scheduling vẫn là proof gap, không che thành pass.

Regression focused đạt **47 passed**; ma trận production liên quan đạt **253 passed**.
Review chéo riêng Lô F không còn finding actionable; stress coordinator 20/20 đạt. Giới hạn
probe: N=3 + một warm-up, một máy i5-13400/16 logical CPU/32 GiB, chỉ hai preview
SR13; chưa phủ 3+ preview, máy `<16 GB`, N-up/CNC/export. Hai lượt cách nhau khoảng
44 phút và source dirty không được content-address ở cấp Python source, nên chỉ dùng
chốt grant/layout lớn, không dùng các delta wall nhỏ làm SLO.

### 5.10 PERF-NEST-13 — invalidation semantic + report overlay — ĐÃ SỬA

Input preview được tách theo ý nghĩa thay vì lấy toàn bộ form làm cache key. Với Bình
trang, trị số SL dương chỉ đổi số tờ cần sản xuất; layout một tờ đại diện không đổi.
Khóa frontend/backend vì vậy chỉ giữ tập trang thực sự tham gia (`SL > 0`) cùng mọi
tham số hình học. Đổi trang từ dương sang 0 hoặc ngược lại vẫn invalidate; N-Up/CNC
không áp ngoại lệ này vì demand có thể đổi bố cục nhiều tờ.

Report không còn nằm trong `job_identity_key`. Execute dựng report typed mới nhất,
băm `reportHash`, xác minh hash ở process con trước khi load manifest và truyền
`report_override` cho writer. Writer không mutate bundle/manifest; provenance artifact
tách thành `artifact_render_fingerprint`. Regression dọc khóa ca preview report/SL A →
Execute report/SL B: `solve=0`, pose/manifest/layout giữ nguyên, PDF nhận mã đơn, tên
sản phẩm, vật liệu và số tờ B. UI bỏ “Kiểu xếp” nhưng vẫn hiển thị “Sức chứa” cùng
“Cần in”. Với S&R, “Cần in” được tính cục bộ theo từng trang bằng
`ceil(SL trang / sức chứa trang)`, nên đổi SL dương cập nhật số tờ ngay mà không gọi
lại preview. Regression khóa cả true-shape (`6→120`, `1→3 tờ`) và grid
(`6→12`, `2→3 tờ`) trong khi số request preview/nesting không tăng.

### 5.11 PERF-NEST-14 — marker durable batch fail-closed — ĐÃ SỬA

Ca runtime 13 mẫu cho thấy batch reference bền vẫn đủ nhưng cache RAM không giữ nóng
toàn bộ session. Nhánh handoff cũ còn đọc session/proof tuần tự; khi một lane đã bị LRU
loại, marker có thể được công bố mới chỉ đủ `reportHash` cho phần đầu và process con dừng
ở lỗi “Metadata ... mẫu 2 không khớp lượt Bình”. Nay ngay khi
`peek_reference_batch*` trả publication durable, list comprehension dựng trọn bộ
`{manifestId, layoutFingerprint, reportHash}` từ reference + job Execute trước khi gắn
marker. Nhánh này không gọi `peek_or_wait()` và không phụ thuộc session nóng. Proof có
thì được chuyển tiếp; nếu thiếu, child xác minh manifest và tự probe đúng snapshot.
Việc dựng list là all-or-nothing nên không thể công bố marker thiếu một phần.

## 6. Những finding cũ đã được đóng/supersede

Ba P1 trong báo cáo 2026-08-30 không được lặp lại:

- Quantity global/partial/zero đã nối lại; probe trả global `{0:7,1:7}`, partial
  `{0:2,1:7}`, explicit zero `{1:4}`.
- CNC duplex đã nối Front/Back/CUT và registration vào job; regression long/short
  đều xanh.
- Trần 200 tờ đã thành contract tối đa 10.000.

Ngoài ra progress/cancel/singleflight/RAM admission/hardware grant/portfolio song
song đều đã có trên source hiện tại. Báo cáo lịch sử và raw JSON 2026-08-30 còn drift:
tài liệu nói cold khoảng 8,065 s/search 3,199 s, raw artifact ghi cold median
5.027,255 ms/search 208 ms và native identity `b2cd6b46…`, không phải hai identity
dùng cho các probe Lô A/B và subset-load cuối.

## 7. Verify Lô A–F

- Benchmark contract: **22 passed**, 1 warning; file test này không chạy engine thật.
- Regression quantity/CNC duplex/maxSheets: **4 passed**, 1 warning.
- Session/job/preview/capacity sau sửa: **117 passed**, 1 warning. Bộ production
  nesting liên quan đạt **253 passed**, 1 warning. Có regression cho grant
  từng wave, completion đảo nhưng output/reference giữ thứ tự, unique subscriber,
  cancel cha không chạy wave kế, commit fail-closed, callback ngoài lock, LRU fence,
  handoff giữa wave, eviction sau wake, concurrent publisher và source đổi revision.
- Bộ rộng liên quan nesting: **235 passed, 2 failed**, 1 warning. Hai lỗi đã có trước
  Lô A và không đi qua code vừa sửa: test `one_dao` kỳ vọng true-shape trong khi
  contract hiện fail-closed; fixture Pont chỉ có header/EOF nên pikepdf từ chối.
- Rerun dưới artifact root pytest đã cô lập: hai file lõi lifecycle + entry
  **254 passed**, 1 warning; artifact lease chung **12 passed**, 1 warning. Nhóm
  marker/ABA/multiprocess/legacy/
  proof nằm trong lifecycle cũng xanh; không cộng trùng vào tổng.
- `py_compile` sáu module production Lô B: đạt.
- Smoke trực tiếp ca render dưới fixture mới: **1 passed**, 1 warning. Cả smoke và hai
  rerun trên đều giữ inventory runtime trước/sau ở 1.490 snapshot / 1.264 marker.
- Benchmark preview/execution: đạt tốc độ và parity như §5.1–5.2; subset-load
  N=3 hậu tối ưu đạt cold `10,614–15,258 giây`, warm `1,738–2,810 giây`, trung vị
  warm `2,123 giây`, `solve=0`, 13/13 manifest và 44/44 cell.
- Benchmark current source/native N=20 sau hai warm-up: preview cold P50/P95
  `9,313/10,758 giây`, warm `2,265/3,458 giây`, peak RSS P95 `138,2/136,7 MB`;
  execution tổng `6,416/7,066 giây`, load `3,368/4,000 giây`, render
  `2,621/2,674 giây`, merge `0,213/0,266 giây`, peak RSS P95 `135,5 MB`;
  warm solve `0/20`, execution `unexpectedSolveTotal=0`, raster artifact parity đạt.
- CNC writer synthetic N=20 (hai warm-up, `quantity=2`, hai pose): simplex P50/P95
  `12,980/13,714 ms`, duplex report/registration `22,498/28,976 ms`, peak RSS P95
  `97,309/98,824 MB`; raster/sides/artifact parity đạt. Không thay thế ca full-pipeline
  CNC duplex nặng.
- Lô C handoff/job lifecycle: **95 passed**; lượt hẹp bổ sung **55 passed,
  1 deselected**.
- Lô D Rust deadline/baseline/solver: **92 passed, 2 ignored** benchmark thủ công.
  Benchmark percentile N=20 vẫn chỉ phủ 4 case; S20 Fast P50/P95
  `1,958/2,018 giây`, Balanced `5,717/6,096 giây`, tất định 20/20. Lượt breadth
  riêng `lap=1` đã phủ 23/23 ca synthetic: 14/22 không kém, 8/22 kém và một ca
  fail-closed đúng chủ đích. Vì chưa có phân phối N≥20 hoặc artifact preview↔export,
  không nâng `BENCH/RUNTIME`.
- Lô E3 quality gate: **246 passed, 1 warning**; subset export/handoff **75 passed**.
- Lô E telemetry writer/render: **79 passed**.
- Lô E4/E5 cut-export backend full sau review TOCTOU + deployment contract:
  **177 passed, 2 warnings**; frontend API/modal **17 passed** (modal 15 + API 2);
  typecheck đạt.
- Đối chiếu test cut-export ngày 2026-09-02: chạy đúng scope
  `backend/app/workers/cut_export/tests` thu được **177 passed, 2 warnings**
  (178 nếu cộng thêm `backend/tests/test_cut_export_svg_security.py`). Không có
  artifact/log nào trong worktree tái hiện con số 176; coi 176 là số stale và không
  dùng làm baseline.
- ESLint hẹp cho cut-export không có lỗi; `lint:budget` ngoài sandbox đạt
  (`errors=1, warnings=3`, đều nằm trong ngân sách hiện hành). Lỗi ESLint còn lại
  ở `LayerPanel.tsx` là thay đổi ngoài phạm vi audit này.
- Bộ rộng nesting cuối: **253 passed, 1 warning** trên bộ production liên quan.
  Hai lỗi fixture/contract cũ của lượt suite rộng trước đó nằm ngoài đường sửa
  và đã tồn tại trước E3: `test_mot_dao_luon_ep_tach_trang` kỳ vọng true-shape trong
  khi contract 1 Dao hiện fail-closed; fixture `test_job_mang_vat_can_oc` chỉ có
  `%PDF...%%EOF`, thiếu trailer nên PikePDF từ chối.
- Lô F contention: `test_nesting_preview_capacity.py` **47 passed**, 1 warning;
  ma trận production 11 file chạy lại ngoài sandbox đạt sạch **253 passed**, 1 warning
  trong 21,64 giây (sandbox từng chặn đúng ca multiprocessing bằng `WinError 5`).
  Review chéo độc lập cũng đạt 253 pass, stress coordinator 20/20 và không còn finding
  actionable. `py_compile` bốn module production Lô F đạt.
- Benchmark contention before/after giữ đúng hashes ở §2; grant `30→15`, solve đủ,
  layout cải thiện nhưng absolute concurrent wall gần như phẳng và strict parity còn
  một outlier như §5.9.
- `git diff --check` toàn tracked worktree đạt; chỉ có cảnh báo chuyển LF→CRLF của
  Git trên Windows. `py_compile` các module production đã chạm đạt.
- Follow-up semantic/report ngày 2026-09-02: backend suite pipeline/CNC/handoff mở rộng
  sau bản vá cuối **258 passed**; suite bundle/render/lifecycle/session/capacity/
  quality-gate hiện hành đạt **505 passed** trong sandbox và **2/2** test multiprocessing
  chạy lại ngoài sandbox đạt. Sau fix marker chạy lại hai file entry + handoff
  **111 passed**. Frontend ba file preview/rollout/
  diagnostic **90 passed**, sau fix UI chạy lại GridPreview **40 passed**; typecheck và
  ESLint hẹp đạt. Regression single-job khóa `reportHash` lệch dừng trước I/O/solve;
  batch spill khóa đủ hash cả loạt dù session nóng đã bị LRU loại. Chưa click-smoke app.

Không cập nhật golden snapshot. Không chạy `-u`.

## 8. Trạng thái các lô

Mỗi lô không quá 5 file và verify trước khi sang lô kế:

### Lô A — Preview S&R wave + publication batch

**Hoàn tất 2026-09-01.** Đã trích wave dùng chung, dùng planner theo tier RAM, giữ
ordering/deterministic pose/cancel/singleflight; mọi S&R nhiều mẫu công bố durable
batch reference qua latch và ngăn LRU thu hồi pin/reference trong cửa sổ handoff.

Tiêu chí: current 13 mẫu giảm đáng kể so với 62,84 s; placed count/pose digest,
golden, preview=artifact và cancel giữ nguyên.

### Lô B — Source proof dedupe an toàn

**Hoàn tất phần an toàn có thể triển khai 2026-09-01; PERF-NEST-02 = FIXED-PARTIAL.**

- **B1 — proof transaction (4 file):** proof RAM từ preflight đi vào persist; readback
  vẫn SHA-256 nhưng không inspect lại; proof không qua process.
- **B2a — receipt/marker authoritative (3 file):** tên deterministic theo locator,
  publish no-replace, exact-token binding, legacy fallback tối đa một batch scan.
- **B2b — batch load worker (5 file):** `load_many()` giữ input order, full validation
  và metadata cache request-local; execution không solve lại.
- **B2c — test isolation (1 file):** mọi pytest backend dùng artifact root tạm theo
  process, ngăn test nesting ghi vào kho runtime thật.

Tiêu chí tốc độ đạt theo §5.2; tamper/lease expiry/conflict/TOCTOU vẫn fail-closed.
Phần shared snapshot/cross-job hash hoãn vì thiếu ownership/refcount/cancel contract.
Benchmark N=3 hậu tối ưu subset-load/parity đã ghi ở §5.2; đây vẫn là probe nhỏ,
được giữ làm mốc lịch sử và không thay thế baseline N=20 current source/native.

### Lô C — Handoff không khóa event loop

**Hoàn tất 2026-09-02; PERF-NEST-03 = FIXED + AUTO.**

1. Route trả job ID sau validation/admission nhưng trước publication wait.
2. Handoff/commit chạy trong prep executor với `preparing_manifest` và cancel check.
3. Process con chỉ spawn sau publication hợp lệ; cancel/fail nhả admission slot.
4. Worker prep gate theo RAM; máy `≥16 GB` giữ full.

Heartbeat/event-loop được khóa bằng test tự động; runtime Tauri vẫn chưa chạy.

### Lô D — Deadline toàn solve

**Hoàn tất code/contract 2026-09-02; PERF-NEST-04 = FIXED + AUTO.**

1. Baseline/probe/search dùng cùng deadline tuyệt đối; không re-arm.
2. Cancel ưu tiên; quantity giữ ledger, autofill chỉ công bố sweep hoàn chỉnh.
3. Publication/final validator vẫn chạy để giữ artifact hợp lệ.

Breadth synthetic đã phủ 23/23 ở N=1; benchmark percentile N=20 vẫn chỉ có 4/23 ca,
vì vậy không nâng `BENCH/RUNTIME`.

### Lô E — Writer và Gửi máy bế

**Hoàn tất E1–E5 ở mức source/auto ngày 2026-09-02.**

1. **PERF-NEST-05:** quality-gate proof server-owned được pin vào publication; export
   tái dùng proof hợp lệ, stale mới probe snapshot một lần.
2. **PERF-NEST-06:** thêm timing/counter embed, paint, page build, base save, report,
   duplex, merge và publish. Việc gộp save chờ số đo CNC duplex nặng thực tế.
3. **PERF-NEST-07 backend:** `cut-inspect` một descriptor/parse, fingerprint và SHA-256
   hậu kiểm chống TOCTOU; endpoint cũ giữ tương thích.
4. **PERF-NEST-07 frontend:** abort/latest-only/atomic snapshot, fallback 404/405,
   no-CUT fail-closed, không request kép khi đổi/chọn trang, Send All ledger/retry
   và khóa khi revision đổi.
5. **PERF-NEST-11 deployment:** Docker chạy một API process để proof server-owned
   process-local không bị tách giữa hai uvicorn worker; pool solver/prep không bị
   giảm trên máy mạnh.

Đường bind proof vào export đã hoàn tất và có test one-shot/tamper/stale/replay;
phần còn mở là click-smoke Tauri đóng gói và đo CNC duplex thật.

### Lô F — Coordinator contention process-wide

**Hoàn tất 2026-09-02; PERF-NEST-12 = FIXED + AUTO/PROBE.**

1. Batch đơn giữ toàn grant planner; nhiều batch cùng process chia một capacity thật.
2. Grant lane 2/1 giữ nguyên tử; bounded bypass ngăn starvation.
3. Chỉ singleflight owner claim; cache hit/follower không giữ token.
4. Cancel/exception/constructor failure/active-close đều thu hồi quota và waiter.
5. Wiring preview → pipeline → native giữ đúng runtime grant; không thêm hard-cap máy mạnh.

Probe chốt max grant `30→15`, đủ solve và cải thiện layout như §5.9. Absolute wall
không cải thiện có ý nghĩa trong N=3, nên lô này đóng oversubscription chứ không hứa
mọi preview đồng thời nhanh hơn serial.

## 9. SLO/benchmark còn thiếu

Baseline current source/native N=20 trên máy `≥16 GB` đã được ghi ở §5.2. Baseline
chính thức vẫn cần N≥20 sau ít nhất 2 warm-up, báo P50/P95 và peak RSS của toàn
process tree cho các cấu hình còn thiếu:

- Tem bế S&R 1/13/23 mẫu;
- tờ lớn hàng trăm placement;
- CNC simplex và duplex có report/registration;
- preview cold/warm, click Bình → nhận job ID, render-only và first paint;
- contention 3+ preview, N-up/CNC/export và strict layout parity theo deadline;
- RAM `<8 GB`, `8–<16 GB`, `≥16 GB`;
- dev native identity và packaged Nuitka/Tauri identity khớp source manifest.

Corpus `backend/tests/fixtures/nesting_tu_do/corpus_lo0.json` đã chạy breadth 23/23
một lượt; baseline SLO vẫn cần N≥20/case và artifact production. CNC duplex nặng cần
fixture alias `PROD_CNC_DUPLEX` đúng contract và harness full
detector→solve→Front/Back/CUT; script hiện chưa consume `PRYNX_LO0_CORPUS_DIR`.

Packaged Nuitka/Tauri smoke chưa thể chốt trong lượt này: tại thời điểm hậu kiểm còn
10 process `pdf-inspector.exe` debug cùng dev backend/node đang mở. Audit không tự
kill process của user hoặc ghi đè artifact đang bị giữ.

---

**Chốt 2 — cập nhật 2026-09-02:** Lô A–F và follow-up semantic/report đã triển khai,
verify ở mức `SOURCE + AUTO + PROBE`. PERF-NEST-01/03/04/05/07/10/11/12/13/14 đã đóng; PERF-NEST-02
là `FIXED-PARTIAL`; PERF-NEST-06 đã có telemetry nhưng chưa gộp save trước benchmark.
Trạng thái tổng vẫn **`SOURCE + AUTO + PROBE · HOLD`**: N=20 hiện mới phủ
current-source preview/execution và solver 4 case ở tier `≥16 GB`; breadth 23/23 mới
là N=1 synthetic. Chưa có packaged Nuitka/Tauri runtime, N≥20 ở hai tier RAM thấp/
đủ 23 ca, contention 3+ preview hoặc fixture/harness CNC duplex nặng thật. Không được
diễn giải source/test hiện tại thành production GO.
