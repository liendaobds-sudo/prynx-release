# Re-audit song song và preview nesting Tem bế/CNC

Ngày: **2026-08-30**

Audit unit: **W2-U09 / W7-U11**

Trạng thái: **BÁO CÁO CHỜ DUYỆT — chưa sửa production code**

Báo cáo được kiểm tra lại: `BAO_CAO_AUDIT_SONG_SONG_VA_PREVIEW_NESTING_2026-08-29.md`

## 1. Kết luận trực tiếp

### 1.1 Kết quả xuất có còn khác preview không?

**Chưa được đóng. Fresh-store regression đạt, nhưng current-source đã tái hiện một handoff failure
với kho manifest đã tồn tại.**

- Phiên lúc **17:37 ICT** (`10:37Z` trong log): preview công bố **45 tem**, export không lấy được phiên
  (`previewSessionHit=false`) nên solve lại và ra **44 tem**. Đây là lỗi parity thật do finishing/
  pont/session identity không trùng.
- Các phiên sau lúc **19:42, 23:29 và 23:35 ICT** (`12:42Z`, `16:29Z`, `16:35Z`): preview và export đều **44 tem**, cùng manifest và
  fingerprint; export ghi `solvedAgain=false`.
- Regression **fresh isolated store** trên đúng `test/test nesting.pdf`, lề 3 mm, 4 ốc, CUT +
  report cũng đạt:
  preview **44×0°**, export lấy đúng `preview_manifest`, cùng manifest/fingerprint và
  `solvedAgain=false`.
- Nhưng trace current-source với persisted store đã tái hiện lỗi: preview thứ hai công bố
  manifest `49ff…`, fingerprint `178431…`; handoff trả `previewSessionHit=false` kèm
  `ManifestConflictError`; export solve lại thành manifest `0578…`, fingerprint `a39397…`,
  `solvedAgain=true`.

Hai manifest thực sự lưu được (`49ff…/6855…` và `0578…/a393…`) đều có 44 canonical pose record
giống hệt từng `(instance, part, sheet, x, y, rotation)`. Tuy nhiên fingerprint `178431…` của
preview ngay trước export không được persist, nên hiện **không đủ bằng chứng để khẳng định hoặc
phủ định ảnh preview đó khác PDF xuất ở từng pose**. Điều đã xác nhận chắc chắn là hợp đồng handoff
`same manifest/fingerprint + solvedAgain=false` đã thất bại; fresh-store test chưa phủ ca
persisted-store/restart này.

Tuy vậy, phản ánh hiện tại của chủ dự án — “artifact trên app không giống hình nghiệm thu” — vẫn
được giữ **OPEN ở tầng installed/runtime**. Lý do là hai ca đang được so không cùng đầu vào:

| Ca | Lề | Histogram xoay | Native identity |
|---|---:|---:|---|
| Hình nghiệm thu cũ | 5 mm | 43×0° + 1×90° | `97b3f0e4…fec4` |
| Re-audit current-source/venv | 3 mm | 44×0° | `42266070…56b` |

Native `.pyd` của venv dùng cho re-audit có SHA-256
`C58A0FA46BDFDB120382B091E1D790E6E66A41D60A79CC0F02FFF1E3C4E3ABEB`. Vì log hiện chưa ghi
native identity, hash `.pyd` và canonical request hash, không thể dùng hai ảnh trên để kết luận
solver đã hồi quy, cũng chưa biết app runtime của người dùng dùng binary nào. Đây là khoảng trống
chẩn đoán P1, không phải lý do để sửa pose bằng phỏng đoán.

### 1.2 Cụm tem hiện có bị dồn xuống mép dưới không?

**Không trên artifact QA hiện tại.**

Trace current-source, lề 3 mm:

- free bottom/top: `2,209512 / 2,359811 mm`;
- dịch cần thiết để vào tâm theo Y: `0,075150 mm`;
- bbox magenta trên trang CUT raster `1815×2438 px`: `[17,29,1796,2408]`;
- khoảng trống trái/phải: `2,999 / 3,175 mm`;
- khoảng trống trên/dưới: `5,115 / 5,115 mm`.

Vì vậy PDF QA current-source nằm giữa theo Y. Artifact:
`backend/.audit-tmp/reaudit-2026-08-30/current-3mm/nesting-current-3mm.pdf`, SHA-256
`335356FC49FA8F52286638E151E8B6719801EDC29D1AF4CF9377892AB7978B2A`.

PDF này chỉ chứng minh **hình học căn giữa**. Run tạo nó gặp `ManifestConflictError`, export
`solvedAgain=true`; regression fresh-store §2.2 chứng minh happy path, còn parity của
persisted-store vẫn OPEN theo §2.3.

### 1.3 Preview có còn chậm không?

**Có. Cold preview vẫn chậm ở mức khoảng 15,5–16,6 giây trên ca khách hiện tại.**

- Regression cô lập: `15,771 s` tổng preview, trong đó native báo `13,304 s`.
- Hai cold run trong trace dựng artifact: `15,519 s` và `16,640 s` tổng preview.
- Các số này thấp hơn quan sát `23,778 s` trước đó, nhưng khác lề/request và native build nên
  **không được công bố là speedup A/B**.
- Tăng riêng time budget từ 3 s lên 30 s làm wall time tăng từ `11,793 s` lên `39,142 s`
  (**3,3×**) mà nghiệm vẫn **44 tem, baseline, 43×0° + 1×90°** trên request lề 5 mm.

Kết luận: **không dùng tăng timeout làm bản vá cho request đã đo**. Cần đo từng phase, bỏ công
việc thừa và mới sau đó phân phối phần việc chứng minh là nóng.

### 1.4 Solver hiện chạy một hay nhiều luồng?

**Mỗi lượt solve hiện chỉ dùng một compute thread. Không có portfolio chạy N phương án song song
rồi lấy best.**

- `imposition_core/Cargo.toml` không có Rayon.
- `imposition_core/src/mixed_nesting/multi_start.rs:409-426` chạy `for plan ... run_trial(...)`
  tuần tự.
- `backend/app/core/mixed_nesting_jobs.py:161-166` chỉ tạo một job worker.
- `plan_hardware().workers` có thể tính ra **15 workers**, nhưng chỉ dùng trong ước lượng/log ở
  `mixed_nesting_jobs.py:353-355`; lời gọi native ở `:370` không nhận giá trị này.
- `native/src/mixed_nesting_py.rs:81-84,110-114` chỉ giữ cancel/progress, không có worker count.

Nhiều request preview khác identity có thể chạy chồng nhau trong các thread AnyIO. Đó là tải
không được điều phối, **không phải** nhiều solver phối hợp cho một bài toán.

## 2. Nguồn bằng chứng và khả năng tái hiện

### 2.1 Input, log và binary

| Bằng chứng | Giá trị |
|---|---|
| File khách | `test/test nesting.pdf` |
| SHA-256 file khách | `EFCDE4F0A16ACA0A5A54EE2D952945AFE2EB70DD2073BC9FF59EE87292B257AB` |
| Log ứng dụng | `%APPDATA%/PrynX/logs/nesting_trace.jsonl` |
| SHA-256 log ứng dụng đã audit | `1643609EB372A3E1D205EF0B106D272846003718CBBDDA2E1F1E3E88F4242268` |
| Số dòng log ứng dụng | 58 |
| Trace regression cô lập | `backend/.audit-tmp/reaudit-2026-08-30/pytest-nesting-trace.jsonl` |
| SHA-256 trace regression | `7758FBE906952447CA66155B805DEDBFB7D6C0A55BCDBB8316547308EE9EF80F` |
| Native `.pyd` hiện tại | SHA-256 `C58A0FA4…E3ABEB` |
| Native build identity hiện tại | `4226607094fe01eaf8cc1c4c01568fed82d96e4530988dafc1fc03334afa256b` |

### 2.2 Regression parity fresh-store current-source

Trace cô lập ghi tuần tự:

1. `preview.result`: capacity `44`, rotation `{0:44}`, selected candidate `baseline`,
   `elapsedTotalMs=15770.539`.
2. `export.handoff`: `previewSessionHit=true`, cùng manifest
   `49ff3fb4aa0b064d7440d998ef180052` và cùng layout fingerprint.
3. `export.reference`: `referencePresent=true`, `storedManifestHit=true`.
4. `export.rendered`: `source=preview_manifest`, `solvedAgain=false`, render `6599.503 ms`.

Điều này chứng minh happy path trên **fresh isolated store + current-source + current-native +
canonical request đã đo**; nó không tự động chứng minh binary đang chạy trong mọi phiên desktop
của người dùng là binary đó, và không phủ conflict khi manifest ID đã tồn tại.

### 2.3 Persisted-store handoff failure current-source

Trace `current-3mm/trace.jsonl` ghi:

1. Preview thứ hai: capacity `44`, rotation `{0:44}`, manifest `49ff…`, fingerprint `178431…`.
2. Handoff: `previewSessionHit=false`, `handoffErrorType=ManifestConflictError`.
3. Reference lookup: `referencePresent=false`, `storedManifestHit=false`.
4. Export: solve lại, manifest `0578…`, fingerprint `a39397…`, `solvedAgain=true`.

So sánh JSON đã persist:

| | Manifest preview lưu trước đó | Manifest export |
|---|---|---|
| Manifest ID | `49ff3fb4…180052` | `0578f564…503059` |
| Fingerprint | `6855b252…9c5cb` | `a3939716…e062` |
| Placement | 44 | 44 |
| Canonical pose records | giống export từng record | giống preview từng record |
| Input hash/content SHA | khác | khác |

Fingerprint `178431…` của preview thứ hai không có manifest JSON để so pose. Vì vậy finding hiện
là **protocol/session parity failure đã xác nhận**, còn visible pose mismatch của đúng run này là
**chưa kết luận**.

Source giải thích trực tiếp chuỗi conflict:

- `nesting_production_pipeline.py:151-156`: mỗi lượt pin PDF sinh locator mới; locator nằm trong
  RenderBundle nên pipeline chạy lại tạo `renderBundleHash/layoutFingerprint` khác.
- `nesting_manifest_store.py:1310-1313,1349-1354`: cùng manifest ID nhưng canonical bytes khác
  bị từ chối bằng `ManifestConflictError`, đúng nguyên tắc không ghi đè artifact đã công bố.
- `nup_true_shape_nesting.py:712,745-761`: export thử commit session mới, nuốt conflict theo
  fail-soft rồi để process con solve lại.

Do đó đây không phải test fluke: sau khi session RAM mất nhưng manifest persistent còn, preview
mới của cùng canonical job có thể đụng locator mới, không publish được dưới manifest ID cũ và
handoff thất bại. D0 vẫn cần canonical hash breakdown để khóa regression và chọn thiết kế sửa,
nhưng nguyên nhân trực tiếp của conflict đã được source + runtime trace xác nhận.

### 2.4 Test đã chạy

| Phạm vi | Kết quả |
|---|---:|
| Backend preview/session/handoff, đã gồm exact-file regression | **99 passed** |
| Rerun riêng regression file khách + 3 mm + 4 ốc + CUT/report | **1 passed** |
| Rust `mixed_nesting_solver` | **33/33 passed** |
| Rust `mixed_nesting_deadline_in_region` | **8/8 passed** |
| Reduce order | **1/1 passed** |

Regression file khách mất `147,16 s` do có cả preview, export, render và các bước dựng hình; số
được dùng để đánh giá trải nghiệm preview là trace phase `15,771 s`, không phải toàn thời gian
pytest. Lượt `1 passed` là rerun của một ca đã nằm trong 99, không phải test unique thứ 100.

## 3. Re-verdict báo cáo ngày 2026-08-29

| Claim/đề xuất cũ | Verdict re-audit | Kết luận đã sửa |
|---|---|---|
| Mỗi solve dùng một lõi | **CONFIRMED** | Đúng; hardware worker plan chưa tới native. |
| `CPU/Wall=0,783` chứng minh dư địa ~20× | **DISPROVED một phần** | Chỉ chứng minh under-utilization trong run đó; không chứng minh speedup khả dụng 20×. |
| `trialsRun=0` nghĩa là không trial nào có kết quả hữu ích | **DISPROVED** | Chỉ nghĩa không trial nào kết thúc không-interrupt; một completed sweep trước deadline vẫn có thể trở thành candidate. |
| Chạy 4 trial song song chắc chắn output y nguyên, lợi ích 0 | **UNSUPPORTED** | Chưa có benchmark hoặc counterexample. Portfolio có thể tăng chất lượng; chỉ chưa đủ hợp đồng RAM/budget/determinism để bật an toàn. |
| `elapsed/orientationEvaluations ≈ 324 ms/orientation` | **INVALID METRIC** | Elapsed gộp baseline, probe, trial, validation và alignment; orientation có tải không đồng nhất. |
| Một autofill sweep phải đi qua ≥44 placement | **DISPROVED** | Một sweep thử tối đa một instance của mỗi part; file này có 13 part. |
| Có sàn 14 s/sweep và cần nhanh 50–60× | **RÚT KẾT LUẬN** | Suy ra từ hai phép chia không hợp lệ ở trên. |
| NFP miss là nút thắt chính | **SUSPECTED** | Hợp lý nhưng trace chưa có hit/miss và phase time, chưa được phép coi là sự thật. |
| Cache NFP là LRU 192 MB | **DISPROVED** | Rust dùng `HashMap`, hard cap 8.192 entry, đầy thì ngừng insert; 192 MB chỉ là estimator Python. |
| Có khoảng `13×14/2=91` NFP key | **DISPROVED** | `NfpKey` là cặp có hướng và phụ thuộc moving pivot/rotation/gap. |
| Prewarm toàn ma trận NFP không đổi kết quả | **SUSPECTED/RISKY** | Có thể lấp 8.192 slot bằng key không cần; chỉ nên batch các miss thực sự cần và nạp ổn định. |
| Parallel difference chắc chắn giữ exact layout | **UNSUPPORTED** | Đại số tập hợp đúng, nhưng Clipper có thể đổi topology/vertex/candidate order. `layoutFingerprint` là identity đầu vào, không phải hash pose; cần so candidate topology và canonical placements trên corpus. |
| `par_iter().any(judge_pair)` chắc chắn nhanh hơn | **SUSPECTED** | Bbox reject + short-circuit tuần tự đang rẻ; overhead có thể lớn hơn lợi ích. |
| Máy ≥16 GB nên hard-cap 2 preview | **REJECTED** | Trái nguyên tắc máy mạnh chạy hết công suất. Admission phải dùng RAM reservation và hardware grant thật. |

## 4. Findings đã xác nhận

### RA-NEST-00 — P1 — Persisted manifest conflict buộc export solve lại

Current-source đã tái hiện `ManifestConflictError` ở handoff, sau đó reference miss và export
`solvedAgain=true` với manifest/fingerprint khác preview. Fresh isolated store đạt nhưng chưa phủ
vòng đời manifest qua persisted store/restart.

Hai manifest lưu được tình cờ có cùng 44 pose record, nên bằng chứng hiện tại chưa chứng minh ảnh
khác. Finding vẫn P1 vì contract authoritative yêu cầu export dùng chính nghiệm preview; re-solve
theo deadline có thể cho nghiệm khác ở lần khác.

**Nguyên nhân đã trace:** locator mới đi vào RenderBundle/layout fingerprint, trong khi manifest ID
vẫn trỏ tới ID đã persist; store đúng đắn từ chối ghi đè canonical bytes khác, còn worker nuốt
conflict và chuyển sang solve lại.

**Gate đóng:** regression persisted-store/restart phải giữ cùng canonical request, native identity,
manifest, placement records và không solve lại; conflict phải fail-closed hoặc tự khôi phục mà
không thay nghiệm đã preview.

### RA-NEST-01 — P1 — Installed artifact chưa có provenance đủ để đối chiếu

Trace nesting chưa ghi `nativeBuildIdentity`, SHA-256 `.pyd` và canonical request hash ở từng
preview/export. Vì vậy khi user thấy một artifact khác hình QA, chưa thể chứng minh app dùng đúng
native/request đã nghiệm thu.

**Hậu quả:** dễ sửa nhầm solver trong khi lỗi thực là stale binary, request khác lề/finishing hoặc
artifact khác session.

**Gate đóng:** một `traceId` phải nối preview → handoff/reference → render; mỗi event ghi cùng
native identity, canonical request digest, manifest ID, layout fingerprint và render bundle hash.

### RA-NEST-02 — P1 — Preview không có admission theo hardware/RAM

Đường preview không đi qua `heavy_job_slot`, `plan_hardware` hoặc `assert_fits_memory`. Singleflight
chỉ gộp request cùng identity; các identity khác nhau vẫn có thể solve chồng nhau. Cache capacity
phiên không phải concurrency cap; AnyIO default trên máy audit là 40 token.

**Hậu quả:** đổi tham số liên tiếp có thể tạo nhiều cold solve cùng lúc và làm UI càng chậm.

### RA-NEST-03 — P1 — Abort HTTP không hủy native solver

Frontend có `AbortController`, nhưng preview không truyền `cancel_event` xuống
`solve_production_nesting`. Request cũ tiếp tục chạy sau khi browser bỏ kết quả.

**Hậu quả:** CPU/RAM bị tiêu cho phương án không còn người nhận.

### RA-NEST-04 — P1 — Preview là POST chặn, không progress/cancel thật

Lane tem/CNC chưa dùng hạ tầng job + polling đã tồn tại ở tool mixed nesting độc lập. Người dùng
chỉ thấy spinner trong toàn bộ cold solve.

### RA-NEST-05 — P1 — `_launch_impose_job` có thể chặn event loop

Route async gọi launcher sync; `peek_or_wait()` có nhánh chờ không timeout. Đây là rủi ro làm chậm
các request không liên quan khi export đụng singleflight/handoff.

### RA-NEST-06 — P1 — Hardware plan và runtime solver bị đứt hợp đồng

Planner tính `workers`, nhưng native không nhận và không tạo local pool. Giá trị log “15 workers”
không mô tả năng lực thực thi hiện tại.

### RA-NEST-07 — P1 — RAM estimator sai mô hình nếu mở portfolio

- Mỗi trial hiện tạo một NFP cache riêng.
- Estimator Python coi NFP cache là shared và chỉ cộng một lần.
- Estimator dùng cặp vô hướng, trong khi runtime key là cặp có hướng gồm obstacle shape và moving
  local ring đã mang pivot/rotation, cộng gap; obstacle translation được chuẩn hoá khỏi key.
- Cache Rust không byte-accounted và không có eviction.

Nếu chỉ đổi vòng trial sang `par_iter`, RAM có thể tăng gần theo số trial **đang chạy đồng thời**
(`min(trial_count, pool_size)`) trong khi admission vẫn báo an toàn.

### RA-NEST-08 — P1 — Shared work budget sẽ phá determinism nếu song song ngây thơ

Runtime hiện tại chạy trial tuần tự nên đây chưa phải lỗi determinism đang xảy ra. Nhưng nếu chỉ
đổi vòng trial sang song song, các trial sẽ tranh `RunControl.evaluations: AtomicU64` theo lịch OS.
Seed và reduce order ổn định không đủ bảo đảm fixed-work determinism. Deadline wall-clock vốn cũng
không bit-identical.

**Gate đóng:** chia quota cố định theo `trialId`, collect theo trial ID, sort ổn định rồi reduce.

### RA-NEST-09 — P2 — `multiStartRestarts` là feature/budget no-op

Profile công bố `1/3/8` restarts nhưng execution code không tiêu thụ field này. Manifest/API budget
và provenance vì vậy phát tín hiệu sức tìm kiếm không có thật; repo không có UI consumer cho field.

### RA-NEST-10 — P2 — Client chỉ cache một preview layout

`layoutKeyRef` + `layoutCacheRef` chỉ giữ một entry. Bật/tắt qua lại hai cấu hình có thể miss client;
server LRU đôi khi vẫn hit, nên claim “luôn cold solve” của báo cáo cũ là phóng đại.

### RA-NEST-11 — P2 — SVG preview nối sai các ring

`.flat()` nối nhiều ring thành một chuỗi polyline có thể vẽ đường giả giữa các contour. Lỗi hiển
thị là thật; các con số 15k/30k pair trong báo cáo cũ không thuộc lane dữ liệu hiện tại.

### RA-NEST-12 — P2 — Render metadata có thể làm đổi canonical identity

Report/material/order fields chỉ gây đổi identity khi field tương ứng thực sự được bật và đi vào
canonical render spec. Không phải mọi lần gõ đều chắc chắn cold solve, nhưng coupling layout identity
với render identity vẫn làm mất cơ hội revalidate/tái ký layout khi chỉ metadata thay đổi.

## 5. Điều chưa được chứng minh

Không được dùng các giả thuyết sau làm cơ sở sửa production trước khi có instrument:

- NFP miss chiếm bao nhiêu phần trăm cold preview.
- Difference hay collision là phase nóng nhất.
- `par_iter().any()` nhanh hơn quét tuần tự.
- Parallel difference giữ exact candidate topology và canonical placements trên contour khách.
- 2/4/8 portfolio workers tăng số tem hoặc rút ngắn time-to-best.
- Artifact user hiện tại được tạo bởi native/request nào.

## 6. Roadmap đề nghị theo chốt và lô nhỏ

### Lô D0 — Đo/provenance trước, tối đa 5 file

1. Ghi native build identity + `.pyd` hash + canonical request hash ở preview/export/render.
2. Thêm timing/counter aggregate cho baseline, Direct-15 probe, trial, validation, alignment.
3. Thêm NFP hit/miss/build time/entry/estimated bytes; difference; bbox reject; narrow collision.
4. Thêm red regression persisted-store/restart cho `ManifestConflictError`; khóa trace không lộ
   contour/PDF nhạy cảm và có cùng identity xuyên ba phase.
5. Chạy N≥20 cold run trên file khách/máy chuẩn để báo median/P95 và phase share; N=5 chỉ dùng
   làm probe median/min/max sơ bộ.

Đây là lô nên làm trước. Nó trực tiếp giải quyết yêu cầu “không đoán mò”.

### Lô PAR-0 — Khép persisted-manifest handoff

Sau khi D0 cho canonical hash breakdown, chọn thiết kế giữ layout identity ổn định trước locator
render tạm hoặc phục hồi đúng committed reference qua restart. Không được tiếp tục nuốt conflict
rồi solve lại im lặng. Gate: fresh store, persisted store và backend restart đều dùng chính
canonical placement records đã preview; render bundle vẫn trỏ đúng source pin và store không ghi
đè manifest đã công bố.

### Lô PV-A — Job preview, admission, cancel và progress

1. Chuyển preview sang job model hoặc offload có bounded wait.
2. Admission theo RAM reservation/hardware grant; máy ≥16 GB không hard-cap vô điều kiện.
3. Propagate cancel thật tới native; request cũ phải dừng có checkpoint đo được.
4. Trả progress theo phase và cho phép Hủy.
5. Đưa `_launch_impose_job` khỏi event loop; mọi wait có timeout/cancel.

### Lô NF-1 — Sửa hợp đồng cache/RAM trước parallel

1. Byte-accounted cache hoặc estimator phản ánh đúng entry/region/key.
2. Tính RAM NFP theo **mỗi worker/trial**, gồm fixed obstacle và directed pose key.
3. Truyền hardware grant Python → native.
4. **Chỉ nếu D0 chứng minh NFP miss chiếm phase share đủ lớn:** lazy batch các miss thực sự cần,
   dùng local pool giới hạn theo grant.
5. Nạp kết quả theo thứ tự ổn định và khóa exact-layout regression.

### Lô NF-2 — Chỉ song song phase được profile chứng minh là nóng

- Parallel difference chỉ khi phase share đủ lớn và corpus giữ exact candidate topology/
  canonical placements.
- Collision chỉ khi narrow phase đủ nóng; ưu tiên cached bounds/spatial broad phase và bỏ phép
  `rings_overlap` lặp trước khi thêm Rayon overhead.

### Lô NF-3 — Portfolio solver 1/2/4/8 workers

1. Sửa hoặc bỏ `multiStartRestarts` no-op.
2. Chia quota cố định theo trial ID, không dùng một AtomicU64 tranh chấp.
3. Mỗi trial có memory reservation rõ ràng.
4. Collect/sort/reduce tất định.
5. Bump `MULTI_START_VERSION`, invalidation/provenance/cache identity tương ứng vì quota mới đổi
   search semantics.
6. Benchmark 1/2/4/8 worker trên cùng native + request; báo time-to-first, time-to-best, số tem,
   utilization và peak RSS. Chỉ bật tier có lợi đo được.

### Lô FE — Cache nhỏ và SVG đúng topology

- Client LRU 8–16 entry, nhưng server identity vẫn là chốt authoritative.
- SVG path nhiều subpath thay vì `.flat()` nối các ring.

## 7. Acceptance gate trước khi công bố “mạnh và nhanh hơn”

| Gate | Điều kiện |
|---|---|
| Preview = export | Cùng canonical request/native identity; cùng manifest/input fingerprint; `solvedAgain=false`; so chính xác canonical placement records, unplaced, selected candidate/source/trial ID và full internal `LayoutScore`/tie-break. Không dùng riêng `layoutFingerprint` làm hash pose. |
| Căn giữa | Residual tâm theo X/Y ≤0,1 mm trên contour envelope và raster Front/CUT. |
| Va chạm ốc | Native final validator `valid`; 0 overlap và clearance X/Y đúng contract `partToObstacle` (ca này 2 mm) với cả 4 fixed obstacle; không dùng bbox để kết luận. |
| Tốc độ | N≥20 cold run trên máy chuẩn để báo median/P95; P95 preview ≤5 s; không tính warm-cache thành cold. N=5 chỉ được báo median/min/max sơ bộ. |
| Sức tìm kiếm | Layout hợp lệ; full `LayoutScore` mới không xấu hơn baseline trên mọi corpus và có ít nhất một strict improvement; không chỉ so số tem/tờ. |
| Determinism | Fixed-work 1/2/4/8 worker cho cùng canonical placements/unplaced/candidate và full score/tie-break; deadline mode công bố best-effort nếu không bit-identical. |
| RAM | Peak process-tree RSS theo concurrency 1/2/4/8 nằm trong reservation ở tier <8 GB, <16 GB và ≥16 GB; máy mạnh dùng full grant an toàn. |
| Cancel | Request superseded dừng native thật và giải phóng reservation; có test timing. |

## 8. Chốt audit

- **Không sửa solver theo hình cũ** vì hình đó dùng lề và native khác.
- **Không dùng tăng timeout làm bản vá cho request lề 5 mm đã đo** vì A/B 3 s → 30 s chậm
  3,3× mà không tăng chất lượng. Một A/B này không chứng minh mọi corpus đều không hưởng lợi.
- **Không bật `par_iter` cho trial ngay** vì RAM estimator và work budget chưa đúng.
- **Lô tiếp theo nên là D0**, sau đó mới quyết định phase nào đáng song song.

Release/tier của `W2-U09/W7-U11` giữ nguyên:
**`AUTO + ARTIFACT-PARTIAL · HOLD`**. Chờ chủ dự án duyệt lô D0 trước khi sửa production.
