# Tốc độ Simplify: preview và Thực thi

> Trạng thái sau duyệt: các đề xuất lõi, memo preview→Thực thi và AUTO đã
> được tích hợp trong source. Số liệu nghiên cứu bên dưới giữ nguyên làm
> baseline; kết quả triển khai/đo lại nằm ở
> `docs/SIMPLIFY_PERF_AUTO_FIXES_2026-09-10.md`.
> Cập nhật 2026-09-11: lô cache nhiều tầng và sửa parity/memo nằm tại §8
> bên dưới. Prewarm nền có hủy job **chưa triển khai**, đang chờ chốt lô tiếp.

Ngày 2026-09-10. Người dùng báo cả preview và Thực thi quá chậm khi bật
Simplify0,100mm; ảnh hiện59→59neo. Phạm vi lượt này là **đo và tìm giải pháp**,
chưa tích hợp tối ưu vào mã sản phẩm, chưa thay quỹ đạo/dung sai.

## 1. Kết luận và thứ tự ưu tiên

Có hai nguyên nhân chính: **tính lõi đắt** và **tính lại công việc đã làm**.
Tăng worker đơn thuần không giải quyết cả hai, nhất là preview một trang.

1. Tối ưu các phép tính cùng thuật toán: lazy dữ liệu, kiểm điều kiện bất
   khả thi trước Newton, Jacobian giải tích thay sai phân hữu hạn. Đã có
   bản thử độc lập cho cả bộ gộp bảo toàn và solver neo tự do.
2. Cache **vector CUT cuối đã kiểm**, gồm cả kết quả không đổi; cùng frame
   thì preview không tính lại, Thực thi không giải lại trang đã preview.
3. Giữ session theo tài liệu và tách preview hình học khỏi dựng màu/PDF;
   bổ sung cơ chế hủy solver thật khi yêu cầu đã cũ. Client AbortController
   hiện không dừng công việc backend, không coi đó là đã có cancellation.

Không nới dung sai, bỏ topology/curvature guard, giảm DPI/mẫu vô điều kiện
hoặc bỏ Simply trên hình ít node chỉ để báo nhanh. Giữ quy tắc RAM của PrynX.

## 2. Bằng chứng baseline

- Windows, Python3.11.9, NumPy1.26.4, SciPy1.12.0,16 CPU logic,
  RAM hệ thống báo32.527,9MiB (~31,77GiB). Không có thay đổi worker/nguồn.
- Nguồn `test/Binder2.pdf`, SHA256
  `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
- Ca bảo toàn: trang12, Theo mép tràn lề, bleed2mm, offset0, Góc tròn,
  tension100, denoise30, Simplify0,10mm. Capture **364 cubic thực trước
  simplify** bằng callback nghiên cứu trong process, không thay production.
- Ca fair: vector B3 trang12/offset2 gồm122 cubic, gọi `fair_refit_ring(.1)`;
  kết quả hiện tại65cubic. Không so nhầm hai baseline khác chế độ.
- Ca no-op:60cubic thực ở trang13 của artifact Binder2 lần trước. Đây là
  đối chứng hành vi tương tự ảnh59→59, **không phải chính trang/file trong ảnh**.
- Số đo profiler chỉ dùng phân bổ hotspot, không dùng so speedup với wall-time.
  Các lần A/B nêu rõ N, tầng đo và output. Không suy ra speedup toàn ứng dụng.

## 3. Findings có bằng chứng

### §SIMPERF.1 — P2/M: bộ gộp thử nhiều span và tạo dữ liệu quá sớm

`cutline_global_simplify.py:71–89`: mỗi candidate tính norm(diff), cumsum và
chuyển local NumPy points thành tuple trước khi biết có qua các điều kiện
cần hay không. Trên ca364cubic:

-63.086 lần `_candidate`.
-14.967 lần tạo list tuple, nhưng chỉ298 lần cần `certify_polyline_curve`.
- Trong cProfile34,33s: global_refit_ring28,20s (~82%); riêng certificate
  khoảng0,50s. **Không phải chứng nhận liên tục là thủ phạm chính của ca này**.

Thử nghiệm chỉ dịch các phép tính xuống lúc cần và kiểm tangent/chord trước
khi cấp mảng local. Kết quả tuple/certificate giống từng bit trong506 ca
đối chiếu (227 nhận,279 loại), và ca364→56 thực.

### §SIMPERF.2 — P2/M: đạo hàm số gọi residual gần1.500 lần

`cutline_fair_simplify.py:143–182`: SciPy least_squares dùng jac_sparsity và
sai phân hữu hạn. Ca122→65 có73nfev,71Jacobian nhưng **1493 residual calls**,
trong đó1420 lần phục vụ đạo hàm số. LSMR cũng là hotspot cần đo tiếp.

Ứng viên nghiên cứu tính đạo hàm giải tích của đúng residual hiện tại, giữ
nguyên trọng số, các vòng solver, ngưỡng hội tụ và bộ kiểm cuối. Residual
giảm1493→73. Central difference kiểm ba fixture4/5/11neo có khóa góc cho
sai số tương đối lớn nhất2,75e-10. Chưa thay cho corpus gần singularity.

### §SIMPERF.3 — P2/L: preview toàn trang không có tái dùng kết quả cuối

`sticker_classic_page_preview.py:75/83/124`: mỗi request tạo process mới,
chạy engine xuất PDF thật, rồi đọc CUT thành SVG. Không lookup/lưu final
curve. Main chạy spy đúng builder hai lần cùng page12/revision/geometry:
**2pool,2submit, fingerprint trùng, cache=None**. Spy không đo tốc độ giả.

`StickerTool.tsx:702` bỏ canonicalReference cho wholePage nên route Thực
thi không có vector để tái dùng; giải lại trang đó. Ca single-region khác:
snapshot hiện có đã tái dùng Alpha+curve nên không được đánh đồng mọi preview.

Tài liệu nghiệm thu trước đã ghi24–31giây/trang cho whole-page round. Thiết
kế preview gọi full writer gây chi phí thật; đây không phải chỉ cảm giác UI.

### §SIMPERF.4 — P2/M: đổi trang/lượt fit cũ tạo thời gian chờ thêm

`useClassicCutlinePreview.ts:397–526`: mỗi thay đổi page/pageInstanceId đóng
session và nhận diện lại. Pump chỉ giữ yêu cầu cuối nhưng chờ job đang chạy
hoàn tất. Route `run_in_threadpool` chưa truyền disconnect/cancel vào solver
hoặc worker process. Vì vậy cuộn/kéo nhanh có thể vẫn phải đợi job đã cũ.

Preview một-vùng có cache prepared geometry tại
`sticker_cutline_preview.py:1015`, nhưng vẫn fit+Simplify lại tại1150/1164.
Kết quả cuối chỉ được ghi cache xuất, chưa dùng để trả lại cùng preview.

### §SIMPERF.5 — P3/S: lượt conservative bị lặp khi tất cả đều không đổi

`cutline_cubic_simplify.py:556–573`, với `prefer_conservative=True`:
conservative-global → fair → **conservative-global y hệt** → local-only.
Cần giữ kết quả lần đầu trong một call, không bỏ local fallback cuối.

Tuy nhiên đây **không phải nút thắt chính** trong ca60→60:

| Bước | Thời gian trong probe có tải đồng thời |
|---|---:|
| Conservative đầu |0,145s|
| Fair, cuối cùng giữ nguyên |22,410s|
| Conservative lặp |0,150s|
| Local fallback |0,077s|

Tổng22,78s, giữ nguyên source. Kết quả node không đổi vẫn có thể rất đắt vì
phải thử và loại các nghiệm; ảnh59→59 không chứng minh solver chưa chạy.
Cache phải lưu cả `changed:false`, không chỉ lưu các lần giảm thành công.

## 4. Hai bản tối ưu đã thử, chưa tích hợp

### A. Bộ gộp bảo toàn

| Đối chứng | Hiện tại | Bản thử | Kết quả |
|---|---:|---:|---|
| Lazy/thứ tự kiểm, trung vị3cặp |11,4169s|8,6536s|nhanh1,319×; bit-identical|
| Thêm lọc hull,1lượt agent |—|6,7156s|bit-identical; không dùngN1 làm trung vị|
| Main kiểm chéo1cặp baseline/hull |26,1486s|15,6284s|nhanh1,673×; bit-identical|

Không trộn baselineN3 với thời gianN1 để suy speedup. Thời gian tuyệt đối
dao động giữa các đợt trên máy chia sẻ; cặp main cùng process vẫn cho giảm
~40%. Tất cả giữ364→56 và cận0,09983597132103336mm.

Lọc hull dựa trên điều kiện **đã có** trong `_fit`: hai độ dài handle
`0<alpha,beta<=chord`. Mọi control point có thể nhận nằm trong convex hull
`{P0,P3,P0+L*left,P3-L*right}`. Điểm nguồn ngoài hai dải pháp tuyến của hull
mở theo dung sai không thể có nghiệm hợp lệ; loại trước Newton, có slack
số học. Không giảm tập nghiệm hợp lệ bằng cap tùy ý.506ca đối chiếu nhận/
loại và tọa độ/certificate đều trùng.

### B. Solver neo tự do

| Đối chứng | Hiện tại | Jacobian giải tích |
|---|---:|---:|
| N3 tuần tự, trung vị |8,6206s|5,0845s|
| Main kiểm chéoN1 |14,5296s|12,4216s|
| Số cubic |65|65|
| Cận so nguồn,mm |0,089279366062|0,089278207843|

N3 đo được1,695×; mainN1 chỉ1,170×. **Không cam kết1,7× ở mọi máy/mọi lần**;
cần benchmark end-to-end và kiểm tải/BLAS/RAM khi triển khai.

Nghiệm không giống từng bit vì đổi roundoff của quá trình hội tụ. Main đã
đọc công thức và kiểm chéo kết quả: chênh control point tối đa0,00004455mm;
sau .4f pt0,00007056mm, đủ nhỏ so0,10mm nhưng vẫn phải giữ verifier/corpus.
Hai nghiệm đều qua bộ kiểm gốc, không sửa threshold để nhận. Không gắn nhãn
“quỹ đạo nguyên bit” cho phương án này.

### Những hướng chưa đáng ưu tiên

- CacheKDTree của nguồn: `_closest` toàn bộ chỉ~0,156s trong ca8,93s,
  lợi ích nhỏ hơn đạo hàm số.
- Sinh seed lazy theo đúng thứ tự có tiềm năng tránh dựng đủ3seed khi
  seed1đã nhận (~1,35s phần build tất cả), nhưng chưa đo A/B.
- Rust/native cho kernel nóng là hướng sau; không cần đổi stack trước khi
  cắt công việc trùng và tối ưu hai hotspot đã đo.

## 5. Cache/reuse phải làm đúng hợp đồng

Không tái dùng cả PDF preview vì nó chưa có đầy đủ thiết lập màu/nền/crop
của Thực thi. Không gửi mù `alpha_path_overrides`: engine chỉ áp ở nhánh
Alpha/approved, nhưng có guard khác bỏ Simplify khi thấy path_groups; có
thể vừa không áp curve vừa bỏ solver. Không ép alpha_source_mode hay giả
manifest một instance để qua snapshot cũ.

Tạo artifact **final-CUT** riêng gồm lệnhL/C local-crop theo point, cấu trúc
ring/lỗ, frame writer và chất lượng/certificate. Khóa identity phải có
source digest/revision, trang, mask/edits, boxes/Rotate/UserUnit đã chuẩn,
mọi tham số hình học và phiên bản engine/Simplify/writer. Giữ shape nguồn
bất biến; snapshot ownership rõ trước nhả lock; dữ liệu forward process
picklable; dùng lifetime/session và vùng cache trang hiện có.

Phân biệt ba tình huống:

- Cold preview vẫn phải tính một lần; tối ưu lõi tác động ở đây.
- Cùng trang/cùng tham số đã tính: reuse cả kết quả thành công/no-op.
- Thực thi nhiều trang: chỉ trang đã có artifact hợp lệ được bỏ solve,
  **không thể gọi toàn bộ file13trang là tức thì** khi mới preview1trang.

## 6. Lô đề xuất sau duyệt

1. **Lõi bảo toàn (2–3file):** lazy/đổi thứ tự kiểm + hullnecessary + test
   bit-equivalence, certificate/corners/topology. Bỏ callconservative trùng
   nếu thêm cùng lô vẫn≤5file. Đo A/B PDF thật, không chỉ pickle.
2. **Solver (2–3file):** Jacobian giải tích + differential tests trên góc/
   lỗ/nearC2/clamp; cùng objective và guard. Đo lại cả máy mạnh và RAM thấp.
3. **Final-CUT artifact backend (≤5file):** capture/lookup/consume tại writer,
   source/fingerprint validation, không đổi màu/crop/Alpha pipeline.
4. **Nối preview→execute (≤5file):** snapshot dispatchtheoartifactkind, route,
   UIreference, testspositive/negative stale/revision. Single-region unchanged.
5. **Preview chuyên biệt:** sessiontheotàiliệu, geometry-only pipeline, reuse
   baseline khi chỉ kéoSimplify; cancel/coalescing backend thật. Có thẻ nghiệm
   thu riêng vì thay ownership/process không phải chỉnh debounce đơn giản.

Theo `prynx-audit-workflow`, dừng ở báo cáo giải pháp này để chốt lô sửa.
Không tự giảm chất lượng, bật cache chưa có hợp đồng hoặc chạy build/release.

## 7. Bằng chứng tái lập và khoảng trống

- `tmp/simplify-perf-20260910/core/profile_core.py`, `.pstats`, `round_paired.json`,
  `round_lazy_hull_summary.json`, `candidate_hull_equivalence.json`, `noop_trace.json`.
- `tmp/simplify-perf-20260910/solver/analytic_candidate.py`, `profile_solver.py`,
  `paired_quiet_results.json`; dữ liệu có profiler/contended được lưu riêng.
- Main: `tmp/simplify-perf-20260910/root_probe.py`, `root-core.json`,
  `root-solver.json`, `pipeline_probe.py` và `pipeline-probe.json`.
- Main kiểm7hashfileproduction liên quan đầu/cuối: trùng. PDF nguồn không đổi.
  Chỉ tạo scripts/evidence nghiên cứu và báo cáo, không tích hợp code sản phẩm.
- Chưa biết trang/file/nhánh chính xác của ảnh59→59. Chưa có đo thao tác trên
  phiên Tauri đang dùng; không gắn những số thời gian lõi này cho screenshot.
- Chưa có benchmark tối ưu sau tích hợp trên full13trang, workerfanout,
  RAM8/16GiB, cachewarm/cold, stale/cancel, đóng gói. Đây là tiêu chí nghiệm thu
  cho lô sửa, không phải testđãpass trong lượt nghiên cứu.

## 8. Lô cache theo thông số — triển khai 2026-09-11

### Phạm vi đã duyệt và bằng chứng bổ sung

Người dùng hỏi việc đổi thông số bù xén/đường cắt có buộc tính lại không,
sau đó yêu cầu “vậy làm luôn đi”, “tiếp”. Lô này hoàn thiện cache trước;
không đổi dung sai, solver, verifier, mask, worker count hay cấu trúc file xuất.
Chạm bốn file code/test và báo cáo này, giữ giới hạn lô nhỏ của dự án.

| Mã | Bằng chứng trước sửa | Sửa trong lô này |
|---|---|---|
| §CACHE.1 — P2/M | Từng mức `0 → 0,05 → 0,10` gọi fitter 3 lần dù cùng contour. Test đếm lời gọi đỏ: `3 != 1`. | `sticker_cutline_preview.py`: lưu Bézier **trước Simplify** riêng. Mỗi dung sai mới lấy bản sao cùng baseline, không fit lại và không cộng dồn sai số. |
| §CACHE.2 — P2/M | Đổi offset A → B → A gọi Simplify 3 lần, không giữ frame cũ. | Giữ frame cuối theo đầy đủ thông số của cùng nguồn/revision. Lịch sử chỉ có vector/metadata, không giữ Alpha/PDF theo từng tick. |
| §CACHE.3 — P1/M | UI có thể lấy A từ cache nhưng `snapshot_classic_cutline_preview` chỉ đọc B mới nhất; test Execute bằng fingerprint A bị 409. | `sticker_sheet_export.py`: tìm đúng frame A trong lịch sử rồi kiểm nguồn/revision/thông số/fingerprint trước snapshot. Áp dụng cả một vùng và PDF toàn trang. |
| §CACHE.4 — P1/S | Bản copy nông làm sửa `page.cutline_export_cache` hỏng cả vector lịch sử; test path rỗng sau cache hit. | Copy sâu path/quality, tách Alpha active khỏi working-set. Alpha không tích lũy trong lịch sử. |
| §CACHE.5 — P1/M | `sticker_classic_page_preview.py` Simplify riêng trên tọa độ Y-up đã làm tròn đọc từ PDF, trong khi Execute giải trên nguồn Y-down trước writer; memo khác khóa. Cache worker nóng còn trả memo rỗng. | Mỗi tổ hợp chưa có cache dùng **chính engine Execute**, thu lệnh CUT L/C và memo của engine. Cache nóng trả lại cả memo; chỉ scale lệnh để hiển thị. Không biến lỗ thành exterior hoặc fit lại từ SVG/PDF đã làm tròn. |
| §CACHE.6 — P2/S | Cache frame thiếu kích thước preview; đổi kích thước có thể trả SVG sai tỉ lệ. | Kích thước hiển thị nằm trong khóa frame; baseline không phụ thuộc zoom. PDF toàn trang giữ lệnh CUT theo pt rồi scale ở bước cuối. |

Các test mới đã tái hiện bốn lỗi đầu trước sửa rồi đạt sau sửa. Kiểm thêm
file đổi byte dù giữ nguyên size/mtime, None so với 0, nguồn/revision/phiên bản
thuật toán, và nhiều mức A/B/C quay lại A.

### RAM và vòng đời

- Baseline tùy chọn: dưới 8 GB giữ 2 mức gần đây, 8–16 GB giữ 8 mức;
  từ 16 GB hoặc không đọc được RAM thì không giảm. Không đổi dung sai/DPI/worker.
- Frame cuối là **artifact còn được UI tham chiếu**, phải sống theo revision/
  session kể cả trên máy yếu. Không loại A âm thầm khi UI còn giữ fingerprint A.
  Frame không chứa raster; chỉ frame active có Alpha riêng.
- Cache một vùng ràng SHA-256 byte file nguồn, `labels.npy`, `rgba.png` và revision.
  PDF toàn trang ràng digest file, trang, thông số và salt pipeline canonical.
- Hash toàn file/mask vẫn tốn I/O; không cam kết vài mili-giây cho PDF/mask rất lớn.

### Đo lại trên Binder2 trang 12

File `test/Binder2.pdf` giữ SHA-256
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
Python worker chạy tuần tự trong test, Simplify 0,10 mm, denoise 30.
Hai cấu hình cache 4 GB/32 GB được giả lập bằng giá trị đọc RAM cho chính
policy cache; không giả vờ đây là hai máy vật lý hoặc benchmark ProcessPool.

| Cấu hình | Profile cache | Preview lạnh | Preview lặp | Execute nhận memo | Số đoạn | Cận sau writer |
|---|---|---:|---:|---:|---:|---:|
| Theo hình gốc, offset 2 mm, giữ góc | 4 GB | 3,3066 s | 0,0051 s | 0,5198 s | 122 → 64 | 0,08950000 mm |
| Theo hình gốc, offset 2 mm, giữ góc | 32 GB | 3,1547 s | 0,0050 s | 0,6362 s | 122 → 64 | 0,08950000 mm |
| Theo mép tràn lề 2 mm, góc tròn 100 | 4 GB | 8,1240 s | 0,0056 s | 1,5127 s | 364 → 56 | 0,09983597 mm |
| Theo mép tràn lề 2 mm, góc tròn 100 | 32 GB | 8,1306 s | 0,0053 s | 1,4042 s | 364 → 56 | 0,09983597 mm |

Đây là số đo từng lượt, không phải trung vị nhiều lần hoặc thời gian Tauri.
Test so **toàn bộ chuỗi lệnh SVG từ CUT của PDF Execute** với preview, cả
kích thước 600 và 1200; không chỉ so số node. Test thay lõi Simplify bằng
hàm báo lỗi sau preview lạnh: cache nóng và Execute dùng memo vẫn đạt,
chứng minh không giải lại bước đó. Các cận là thống kê verifier đã có,
không phải phép đo dao bế vật lý.

### Kiểm thử và giới hạn

- **438 test đạt** trong 153,11 giây: preview/export/cache/contract/tuning/
  source pipeline, lõi cubic/global/fair/polyline và classic tuần tự.
  Một test tạo ProcessPool thật được loại khỏi lượt tổng hợp do giới hạn
  quyền đã nêu bên dưới; không tính test đó là đạt.
- Typecheck Windows và `py_compile` đạt; không sửa TypeScript hoặc engine Rust.
- Test Windows ProcessPool thực và GUI Tauri chưa được xác nhận: sandbox
  chặn named pipe, yêu cầu chạy ngoài sandbox lượt trước không được duyệt.
  Các phép đo mới ở đây không tạo process con và không chứng minh tốc độ fan-out.
- Tổ hợp mới hoàn toàn vẫn phải tính lần đầu. Riêng classic toàn trang,
  dung sai mới chạy pipeline engine canonical; chỉ các tổ hợp đã có kết quả
  được lấy lại tức thì. Không dùng lại baseline đọc ngược sau writer để đổi lấy tốc độ.

### Chốt riêng trước lô prewarm có hủy job

**Chưa bật prewarm.** Nhận diện xong chưa đủ để biết toàn bộ thông số đang
chọn; `Simplify=0` còn có thể là người dùng chủ động tắt. Tự chạy 0,10 mm vô
điều kiện vừa tốn CPU vừa có thể xếp công việc cũ trước yêu cầu mới. Lô tiếp
phải bổ sung hợp đồng job giữa schema/API/hook và worker, nên vượt phạm vi
bốn file code hiện tại và cần chốt theo `prynx-audit-workflow`.

Đề nghị duyệt thiết kế:

1. Request phân biệt preview nháp nhanh và dung sai cuối mà người dùng thực sự
   yêu cầu. Giá trị 0 tường minh không sinh việc Simplify nền. Giữ preset/UI đơn giản.
2. Bộ điều phối giữ yêu cầu mới nhất theo session/trang, hủy hoặc bỏ việc cũ
   khi đổi thông số/đóng tab. Tác vụ người dùng đang đợi ưu tiên trước tính trước
   trang lân cận; pool theo RAM, không hạ chất lượng hoặc số worker vô điều kiện.
3. Chỉ công bố frame canonical sau verifier. Execute nhận đúng kết quả đã hoàn
   tất hoặc đợi job mới nhất, không xuất đường nháp. Test stale-result, cancel,
   tab nền, explicit-off, cache miss và parity CUT bắt buộc trước khi bật.

Thứ tự: chốt contract và backend job trong lô nhỏ → verify → nối hook/UI và
Execute ở lô sau. Không báo prewarm hoàn tất chỉ vì cache lặp đã nhanh.
