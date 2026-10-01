# Báo cáo audit hiệu năng nesting và preview — 2026-10-01

## Trạng thái

**Đã được duyệt và đã triển khai Lô A + Lô B + Lô C + Lô E (native prewarm và collision hot path).** Báo cáo này tách đúng thời gian chờ
của ca Bình tem bế 13 mẫu khỏi chi phí vẽ preview, đồng thời ghi lại các chốt parity
đã kiểm sau khi sửa. Các thay đổi parity/pager trước đó được giữ nguyên.

## Kết luận điều hành

Luồng hiện tại **chưa đạt trần kiến trúc**. Native đã có portfolio trial và NFP cold-miss
chạy song song, backend đã chia tổng worker theo RAM/CPU, session có singleflight và
preview đã dùng Canvas khi số ô lớn. Vì vậy tăng worker vô điều kiện hoặc thay Canvas
ngay chưa có cơ sở.

Với corpus 13 mẫu hiện tại, thời gian chờ vẫn bị chi phối bởi backend:

- Dựng 13 job: **1.701 s**.
- Wave solve production: **16.361 s wall**, 13 job; tổng wall cộng theo từng lane
  **90.887 s** vì các lane chạy đồng thời.
- Mỗi lane có **47–72 placement**, wall **0.746–11.386 s**, native
  **0.713–10.946 s**.
- Tổng phase native đo được: baseline khoảng **63.985 s**, validation khoảng **6.2 s**,
  publication native khoảng **13.3 s**; đây chưa phải toàn bộ durable manifest commit
  của preview job. `searchMs=0` ở toàn bộ job S&R hiện tại.
- `nfpCacheMisses=8/job`; thời gian dựng NFP từng lane dao động khoảng **1.5 ms–3.14 s**.
- Máy đo có 16 logical CPU và RAM ≥16 GB. Planner cấp tổng grant **15 worker**;
  13 lane nhận grant `(2, 2, 1×11)`. Đây là giới hạn điều phối có chủ đích để không
  oversubscribe RAM/NFP cache.

## Kết quả chạy lại sau bản sửa

Lượt chạy dev mới nhất trong `PrynX\logs\app.log` là job `10203a46`, cùng file
`test nesting.pdf` 13 mẫu: **8.484,4 ms**, `items=62`. Các lượt trước của cùng file
ghi **8.664,2 ms**, **8.811,3 ms**, **15.231,3 ms** và **21.828,3 ms**. Đây là cải
thiện rõ nhất so với lượt chậm, nhưng chưa đủ để kết luận native solver đã nhanh hơn
ổn định vì thời gian solver biến thiên theo cache và lịch worker.

Quality gate giữ nguyên toàn bộ capacity/strategy: trang 1 và 13 chọn `l_shape`,
11 trang còn lại giữ `true_shape_nesting`, với các cặp số lưới/nesting giống lượt
trước. Số dòng `[SHAPE_CLASSIFIER]` trong phạm vi job giảm từ **27–28 xuống 13**;
đây là bằng chứng trực tiếp cho việc bỏ lượt phân loại lặp. Phần thời gian còn lại nằm
ở native solve/publication và cần một lô profile riêng nếu muốn giảm tiếp.

Các số đo trên là **PROBE current source/native**, chạy trực tiếp trong venv bằng
`test/test nesting.pdf`, S&R 320×430 mm, gap 2 mm, lề 3 mm, ốc 5 mm, không qua
Tauri/HTTP/installer. Native identity của lượt đo là
`34e29f638d8086a87decaaf6bbb49081506d9730a5bc23b0bee4346f0f6db24c`, baselineVersion
14; SHA-256 file `.pyd` là
`3584bbc30fb2b726481506917fe1dae2749f2a1a42a8523481afdc5c4ebacdd5`.

### A/B native sau Lô C

Để tách biến động lịch worker khỏi bản sửa, đã dựng lại đúng 13 request production từ
`test/test nesting.pdf` (S&R, 320×430 mm, gap 2 mm, lề 3 mm, ốc 5 mm, clearance
2/2 mm) và chạy xen kẽ native trước/sau với grant 2 worker. Corpus có SHA-256
`6a48faa84d088bb6f2db7ab0bf7c8f1f074bf89e7e4ba1b20b63a130ba1f3799`.

- Tổng 13 lane: **38.132 s → 33.553 s**, giảm **12,0%** trong một lượt cold;
  12/13 lane nhanh hơn. Lane chậm nhất tăng do dao động riêng lẻ, nên số này chưa
  phải P50/P95 production.
- Mọi lane giữ nguyên `placedCount` và pose digest; mỗi lane sau sửa ghi
  `prewarmTasks=4`, `prewarmPeakWorkers=2`, còn bản trước là 0.
- A/B 4 case contour thật, hai lượt mỗi bên: median giảm **7,8–25,1%** tùy case;
  pose digest giữ nguyên. Đây là bằng chứng native solver có cải thiện, chưa phải
  cam kết tốc độ installer.

Sau khi gộp lượt biến đổi publication, chạy lại toàn bộ corpus với grant 1 (đúng tier
của 11 lane production): tổng native **36.769 s → 29.724 s**, giảm **19,2%**;
12/13 lane nhanh hơn. Theo phase, baseline **28.884 s → 23.929 s**, validation
**2.592 s → 1.908 s**, publication **5.270 s → 3.864 s**. Đây vẫn là một lượt
cold A/B, cần N≥20 để chốt P50/P95.

Artifact trước có SHA-256 `a626bcd85b2aa9f9d79b05523577789ab76be62eea45953c338f1aa023e67ee4`;
artifact sau có SHA-256 `ea4d862e651b40223138c54ea2daa32bc5d3c9073801de98cff213633b89052d`,
native build identity `5f5ec7f159202e146d87912f1d744ae12c24ffb87e2c6449f00f845ed3dc9530`.
Sau khi gộp lượt biến đổi ở publication và bổ sung dependency vào provenance, artifact
dev hiện tại có SHA-256 `a3d188d0f1a1eee8c1a3ad73a2c82839ec680837e19c4afdb75fda8e78d01b8c`,
native build identity `0fe31103ca0eead4b77965a0bdfa2ed5f211db53a5f63916ab140556d8101f6f`.

## Luồng đã truy vết

```text
GridPreview
  → debounce 750 ms
  → POST /imposition/preview-layout/jobs
  → NestingPreviewJobRegistry.run_in_threadpool
  → build_true_shape_nesting_jobs (mỗi mẫu S&R = một job)
  → run_step_repeat_batch_wave
  → NestingPreviewSessionStore.get_or_solve
  → production orchestrator → native MixedNestingRun
  → manifest/session publication
  → _project_sheet_cells → frontend convert/render
```

Các điểm vào và consumer chính:

- Frontend request/job/poll: `desktop/src/components/imposition-tools/sections/GridPreview.tsx` và `desktop/src/lib/mixed-nesting/api.ts`.
- Job registry: `backend/app/core/nesting_preview_jobs.py`.
- Batch S&R: `backend/app/core/nesting_preview_capacity.py` và `backend/app/workers/nup_true_shape_nesting.py`.
- Hardware grant: `backend/app/core/mixed_nesting_service.py` và `backend/app/core/system_memory.py`.
- Solver native: `native/src/mixed_nesting_py.rs` và `imposition_core/src/mixed_nesting/multi_start.rs`.

## Finding đã có bằng chứng

### NEST-PERF-01 — P1/M: baseline lặp theo từng mẫu là nút nóng hiện tại

`build_true_shape_nesting_jobs()` tạo một `ProductionNestingJobInput` cho mỗi trang S&R
(`nup_true_shape_nesting.py:916-976`). Wave chạy được nhiều lane, nhưng mỗi lane vẫn
phải dựng baseline, validate và publication riêng. Trên ca 13 mẫu, baseline chiếm
phần lớn thời gian cộng dồn; `searchMs=0` do S&R đang khóa baseline motif để giữ đúng
hợp đồng xếp lặp.

Đây không phải bằng chứng cho phép bỏ baseline, giảm validator, thay đường bế thật bằng
bbox, hoặc gộp 13 mẫu thành một job: các cách đó có thể làm đổi placement/quality.
Hướng có cơ sở là dùng chung snapshot nguồn, contour đã chuẩn hóa và NFP cache theo
identity đầy đủ giữa các lane, sau đó đo lại placement/pose digest.

### NEST-PERF-02 — P1/M: publication/proof còn chi phí lặp xuyên 13 job

Session singleflight và batch reference đã có, nhưng tài liệu hiện hành vẫn ghi
`PERF-NEST-02 = FIXED-PARTIAL`: shared snapshot/cross-job hash còn mở. Phase publication
trong probe mới khoảng 13.3 s cộng dồn. Bất biến hash, source revision, lease, native
revalidation và fail-closed phải giữ nguyên; không được bỏ kiểm chỉ để giảm latency.

### NEST-PERF-03 — P2/S: progress polling làm redraw Canvas lặp lại

`GridPreview.tsx:2746-2755` gọi `setNestingProgress()` ở mỗi status. Hai callback
`cellLabel`/`colorIndexFor` được tạo mới trong mỗi render tại khoảng
`GridPreview.tsx:3353-3370`; `GridPreviewCanvas.tsx:98-373` đưa chúng vào dependency
của effect vẽ. Khi `visibleCells.length > 48` (`GridPreview.tsx:3620-3622`), mỗi lần
poll có thể vẽ lại toàn bộ Canvas; CNC duplex có thể vẽ cả hai mặt.

Đây là chi phí UI đã truy vết, nhưng chưa có React Profiler/long-task A/B nên chưa quy
cho nó thời gian chờ 16.361 s.

### NEST-PERF-04 — P2/S: provisional preview tạo thêm request trong 13 mẫu S&R

S&R progressive gọi preview lưới tạm ở mốc khoảng 250 ms rồi mới tạo job nesting sau
debounce 750 ms (`GridPreview.tsx:2678-2720`). Cách này cải thiện cảm giác phản hồi,
nhưng có thể làm backend legacy và job nesting tranh thread/I/O. Cần A/B giữ nguyên
quality gate để biết phần lợi UX có đáng chi phí hay không.

### NEST-PERF-05 — P2/M: publication chờ đủ cả 13 lane trước khi trả cell nesting

`_build_step_repeat_preview()` gọi `run_step_repeat_batch_wave()` rồi mới collect
lookup và `_project_sheet_cells()` (`nesting_preview_capacity.py:1119-1165`). Vì vậy
progress có thể tăng giữa chừng nhưng cell nesting đầu tiên chưa được trả cho frontend;
người dùng vẫn chờ lane chậm nhất và publication batch. Preview lưới tạm ở mốc 250 ms
chỉ là layout legacy, không phải kết quả nesting authoritative.

Có thể cải thiện **perceived latency** bằng protocol progressive: công bố tờ đầu đã
validate trước, tiếp tục các lane còn lại và giữ publication identity/cancel fence.
Đây là thay đổi hợp đồng nhiều tầng, cần lô riêng và kiểm parity; không được trả
manifest chưa validate hoặc để preview tạm bị hiểu là kết quả cuối.

### NEST-PERF-06 — P1/M: quality gate phân loại lại từng trang sau khi solve

`app.log` của job `ea475788` (13 trang, 2026-10-01) ghi một đợt 13 lần
`[SHAPE_CLASSIFIER] CUSTOM (reason: unresolved)` trước admission native, sau đó lại có
nhiều lần classifier trong lúc dựng preview legacy/quality gate. Cùng job mất
**21.828 s**; các lần trước mất **8.664 s**, **8.811 s** và **15.231 s** với cùng file,
cho thấy biến thiên lớn.

Quality gate cuối cùng chọn `l_shape`/`grid` cho một số trang và `true_shape_nesting`
cho các trang còn lại. Đây là policy hiện tại, không được tự xóa để lấy tốc độ; nhưng
shape/trim/contour đã server-owned có thể được truyền lại theo identity đã kiểm để
tránh phân loại và mở preview legacy lặp. Cần A/B chứng minh `placedCount`, strategy
được chọn và geometry không đổi.

## Điều đã chứng minh và điều chưa chứng minh

Đã chứng minh ở source/probe: batch wave không phải tuần tự hoàn toàn; native hiện có
parallel portfolio/NFP capability; Canvas hybrid đã tồn tại; cache/singleflight và
polling adaptive đã tồn tại; projection không phải chặng lớn trong các benchmark cũ.

Chưa chứng minh ở runtime đầy đủ: click-to-first-paint qua Tauri, packaged/installer,
3+ preview đồng thời, hai tier RAM thấp, RSS process tree, và A/B shared snapshot.
Các số trong báo cáo 2026-09-01 (P50 cold 9.313 s, warm 2.265 s trên native khác)
không được trộn với probe ngày 2026-10-01; native identity và source đã đổi.

## Lô sửa và trạng thái

### Lô A — giảm chi phí frontend, tối đa 2 file — ĐÃ TRIỂN KHAI

`GridPreview.tsx`:

- ổn định callback bằng `useCallback`/ref;
- không phát state progress khi phase và giá trị hiển thị không đổi;
- giữ nguyên cell geometry, pager, cancel và parity.

Đây là lô rủi ro thấp, không tác động solver. Typecheck, ESLint mục tiêu và test
`GridPreview.mixedDuplex` đã xanh.

### Lô B — tái dùng DetectedShape server-owned, tối đa 5 file — ĐÃ TRIỂN KHAI

Quality gate và legacy preview nhận lại `DetectedShape` đã được dựng trong job nesting
qua `nesting_preview_capacity.py`, `nesting_preview_jobs.py` và route preview. Probe
tạm không sửa fingerprint/proof; callback một tham số cũ vẫn tương thích. Test backend
nesting/jobs đạt 59 test; capacity trước/sau giữ nguyên trên fixture kiểm tra.

Việc tái dùng chỉ áp dụng cho shape server-owned của chính job; CUSTOM rỗng dùng marker
nội bộ để bỏ classifier dư rồi vẫn ép props về rỗng. Lease, fingerprint, cancel và
fail-closed không bị bỏ qua.

### Lô C — native periodic baseline/NFP — ĐÃ TRIỂN KHAI MỘT ĐIỂM HOT

`imposition_core/src/mixed_nesting/baseline/periodic.rs` trước đây dựng các NFP của
cùng một motif theo vòng lặp tuần tự, dù `NfpCache` đã nhận grant worker. Lô C gom
toàn bộ cặp `(fixed, moving)` vào `grown_nfps_pairs_batch_with_clearance()`, dùng
chung core với batch cũ, mượn contour moving thay vì clone và replay theo thứ tự
`fixed → moving` trước `union_many`. Grant một worker, motif một member và batch đã
warm vẫn đi đường tuần tự tương ứng; không đổi geometry/tie-break.

Lô C đồng thời bỏ lần gọi `rings_overlap` lặp trong `judge_pair_sheet_axis` sau khi
cặp đã được xác nhận không chồng. Phép đo khoảng cách và phán quyết clearance giữ
nguyên bit kết quả. Chưa tăng worker vô điều kiện, chưa bỏ S&R baseline lock và chưa
đổi luật hình học.

Parity đã chạy: 57 unit Rust, baseline 43/43, NFP/validator 39/39, rotation 13/13,
fixture S&R 12/12; test collision có 220 đối chiếu bit khoảng cách với đường cũ và
test batch mới bao phủ moving khác nhau, pivot, hủy, ngân sách byte, lỗi theo thứ tự.

### Lô D — progressive first-sheet, chỉ sau khi chốt hợp đồng

Đoạn này cần thiết kế protocol/session publication và test cancel, stale generation,
ordering, pager, export handoff; chưa nên gộp vào Lô A/B vì có thể làm thay đổi trạng
thái mà frontend nhìn thấy.

### Lô E — chuẩn bị narrow phase collision — ĐÃ TRIỂN KHAI MỘT ĐIỂM HOT

`imposition_core/src/mixed_nesting/collision.rs` trước đây tính lại endpoint,
AABB và căn bậc hai của từng cạnh trong mỗi cặp kiểm tra giao nhau. Lô E chuẩn bị
cạnh một lần cho mỗi vòng, loại sớm cặp AABB chắc chắn tách quá dung sai rồi mới
chạy đúng công thức dấu/cross cũ. API công khai và thứ tự phán quyết không đổi;
test đối chiếu công thức cạnh và các ca lồng, lõm, suy biến, sát ranh giới dung sai.

A/B native tích lũy sau Lô C/E, cùng artifact HEAD, grant 1, workers 1: fixture 4 case giảm
**11.981 s → 9.619 s (-19,7%)**, corpus 13 trang thực tế giảm
**35.430 s → 30.277 s (-14,5%)**. Cả 13/13 pose digest, placed count và validation
đều trùng; riêng baseline phase giảm 27.832 ms → 24.181 ms. Đây là tối ưu hot path
giữ nguyên kết quả, chưa phải thay đổi kiến trúc batch/progressive.

## Acceptance bắt buộc

- N≥20 cold và warm, cùng source/native hash; báo P50/P95 và từng phase.
- So sánh wave/batch với serial, actual worker grant và RSS process tree.
- `placedCount`, pose digest, manifest identity và Front/CUT raster phải giữ nguyên
  hoặc đạt sàn đã chốt trước khi gọi là tăng tốc.
- Kiểm riêng preview first paint và packaged build; không dùng kết quả test unit để
  tuyên bố installer đã nhanh.
- RAM `<8 GB`, `8–<16 GB`, `≥16 GB` phải có policy riêng; máy `≥16 GB` không bị
  hard-cap vô điều kiện.

## Verify lượt triển khai

Frontend `npm run typecheck` và test mục tiêu 53/53 đạt; ESLint file `GridPreview.tsx`
không còn lỗi. Backend `tests/test_nesting_preview_capacity.py` và
`tests/test_nesting_preview_jobs.py` đạt 59/59; `compileall` đạt. Một test process trong
`test_nesting_session_handover.py` bị `WinError 5` khi Windows tạo named pipe cho
`multiprocessing.Queue` trong môi trường này, nên chưa dùng kết quả đó để đánh giá code.
Native Lô C/E đã có A/B trên đúng corpus 13 request, nhưng chưa có N≥20 cold/warm,
RSS process tree, raster Front/CUT hoặc runtime packaged/installer. Vì vậy chưa tuyên
bố tốc độ installer; bước còn lại là chạy profile production đủ mẫu và restart
sidecar/dev app để nạp `.pyd` vừa build. Smoke final trên 4 fixture S&R giữ nguyên
placed count, pose digest và `prewarmTasks=4` với grant 2.
