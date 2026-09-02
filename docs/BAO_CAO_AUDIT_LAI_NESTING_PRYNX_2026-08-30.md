# Báo cáo tái audit Nesting PrynX đối chiếu Esko/i-cut

Ngày: **2026-08-30**

Audit unit: **W2-U09 / W7-U11**, mở rộng tới hợp đồng PDF → máy cắt

Trạng thái: **CHỐT 1 · READ-ONLY · CHỜ DUYỆT · CHƯA SỬA PRODUCTION CODE**

## 1. Kết luận điều hành

PrynX đã có nền tảng true-shape nesting tốt và không còn ở mức “solver lưới giả lập”: lõi Rust có NFP cho hình lõm qua phân rã lồi + Minkowski + union, IFP chữ nhật, miền khả thi, ứng viên Bottom-Left, refine, validator độc lập, fixed obstacles, NFP cache và portfolio song song. Luồng preview → session → production → manifest → Front/Back/Cut cũng đã tồn tại và đường auto-route bình thường đã có test handoff phiên.

Tuy nhiên, **chưa nên mở true-shape nesting trong bản production**. Blocker hiện tại chủ yếu là hợp đồng xuyên tầng, không phải thiếu GA/SA/GPU:

1. **P1 — quantity:** `targetQuantity` global, kế thừa theo trang và explicit zero không được materialize đúng trước solve.
2. **P1 — CNC duplex:** UI gửi cấu hình hai mặt nhưng bridge true-shape không gán `duplex_mode`, `flip_edge`, `duplex_registration` và back page; job rơi về mặc định simplex.
3. **P1 — fulfillment lớn:** bridge chặn vô điều kiện ở 200 tờ trong khi core công khai tới 10.000 tờ.

Ba P1 này là **blocker trước khi enable**. Chúng reachable trong source/dev gated path. Trên source đã audit, `build_production.ps1` đặt hai gate về `false`; trạng thái binary/installer đang phát hành chưa được xác minh, nên không được suy rộng thành claim về packaged production hiện tại.

Tái audit còn xác nhận **8 finding P2**: bốn finding nesting/preview/metric và bốn finding ở đường xuất máy cắt. Riêng hậu quả vật lý của việc PDF route không đưa marks vào `CutModel` vẫn là **`PROOF GAP`**: lỗi dữ liệu đã xác nhận, nhưng chưa có byte oracle/vendor oracle hoặc thử máy để nâng tác động lên P1.

**Verdict:** giữ:

```text
VITE_TRUE_SHAPE_NESTING_ENABLED=false
PRYNX_TRUE_SHAPE_NESTING_ENABLED=false
```

Thứ tự đầu tư đề xuất là **quantity → CNC duplex → maxSheets → failure-path handoff → truth của preview/metric → benchmark/artifact → cutter contract**. Chưa ưu tiên GA/GPU/RL; chưa có bằng chứng chúng là nút thắt ROI hiện tại.

## 2. Baseline, provenance và giới hạn

### 2.1 Baseline Git và working tree

| Thuộc tính | Giá trị |
|---|---|
| Nhánh | `codex/pre-release-audit-2026-08-04` |
| HEAD | `8bc0a219b2ec53cc9cc06adb4b9a7cd11c341dff` |
| Trước khi tạo báo cáo | **247** entry modified/added/deleted/untracked |
| Chốt rà soát cuối | **251** entry; count chỉ là tín hiệu vì workspace có thể đổi đồng thời, không dùng làm identity |
| Tài liệu đầu vào | `docs/BAO_CAO_AUDIT_DOI_CHIEU_NESTING_ESKO_ICUT_2026-08-30.md` |
| Tài liệu rubric | `docs/nesting-algorithms-esko-icut.md` |
| Phạm vi trace | UI → preview job → session → production job → PyO3/Rust → manifest → Front/Back/Cut → PDF/CutModel/emitter |
| Ngoài phạm vi bằng chứng | Installer, packaged runtime, P50/P95/RSS current-build, byte oracle máy cắt, thử cắt vật lý |

Working tree rất bẩn và nhiều module nesting đang là file untracked. HEAD không định danh nội dung đã audit. Vì vậy báo cáo dùng thêm content digest cho audit surface và không được diễn giải kết quả thành bằng chứng cho clean HEAD.

### 2.2 Content digest của audit surface

Hash hai tài liệu đầu vào tại chốt rà soát:

| File | SHA-256 |
|---|---|
| `BAO_CAO_AUDIT_DOI_CHIEU_NESTING_ESKO_ICUT_2026-08-30.md` | `e4edd2ba10618fb6f8e0d32656692c4060fe5a5b985c2e16c2dc861be20c5998` |
| `nesting-algorithms-esko-icut.md` | `71012357d212d6cc9d3e94ce5a6cc70a97974dbae8051b43b91a5e9d91a4d185` |

Audit surface gồm **127 file**. Digest tổng hợp:

```text
857c2a3b6913ca90ccc301307523f922b37cee27ce3fd08ba75e927d6c47f91e
```

Cách canonicalize để tái tính:

```text
1. Lấy từng file: relative/path<TAB>lowercase_sha256(file bytes)
2. Sort tăng dần theo relative path, dùng dấu “/”
3. Nối các dòng bằng LF, encode UTF-8
4. SHA-256 chuỗi kết quả
```

Phạm vi chọn file được liệt kê **đầy đủ theo relative path và SHA-256** tại `docs/audit/NESTING_REAUDIT_SOURCE_MANIFEST_2026-08-30.tsv`. File có đúng 127 dòng, không header/không newline cuối và SHA-256 chính là digest tổng hợp `857c2a3b...47f91e`; đây là nguồn thẩm quyền để tái dựng audit surface, không dùng basename hay glob suy đoán.

**Giới hạn:** digest được tính ở chốt rà soát sau các lượt test; raw stdout/stderr của các lệnh test trước đó không được lưu thành artifact/hash. Digest định danh source cuối đã review nhưng không chứng minh mật mã rằng source không đổi giữa thời điểm chạy test và thời điểm hash. Do đó đây vẫn chưa phải release provenance; gate clean/content-addressed build ở §12 còn mở.

### 2.3 Môi trường công cụ tại chốt rà soát

```text
Python 3.11.9
cargo 1.94.0 (85eff7c80 2026-01-15)
rustc 1.94.0 (4a4ef493e 2026-03-02)
Node v24.13.0
npm 11.6.2
OS: Windows / PowerShell
```

### 2.4 Thang bằng chứng

- **`SOURCE`**: đọc và trace source hiện tại tới consumer cuối.
- **`AUTO`**: test tự động đã chạy trên snapshot hiện tại; raw log chưa content-addressed nếu không ghi riêng.
- **`PROBE`**: one-off runtime probe tái hiện hợp đồng; không ghi file production.
- **`ARTIFACT`**: đã mở/đo artifact thật trong đúng lượt audit.
- **`RUNTIME`**: đã chạy app/sidecar đóng gói tương ứng source.
- **`EXPECTED`**: khoảng cách năng lực, chưa phải lỗi so với hợp đồng hiện hành.
- **`PROOF GAP`**: chưa có fixture/oracle đủ để kết luận tác động cuối.

Lượt tái audit này đạt `SOURCE + AUTO + PROBE`, **không đạt `ARTIFACT/RUNTIME` mới**. Agent chỉ ghi ba tài liệu/evidence file: báo cáo này, manifest audit surface và note/hàng `3g` trong `PRYNX_MASTER_AUDIT_MATRIX.md`; không dùng write tool trên production source. Vì workspace đã bẩn từ trước, Git status một mình không thể chứng minh nguồn gốc mọi thay đổi đang có.

## 3. Cách dùng tài liệu Esko/i-cut

`nesting-algorithms-esko-icut.md` tự giới hạn rằng thuật toán nội bộ Esko không được công bố đầy đủ; GA/SA/Tabu, column generation và một số chi tiết là suy luận từ nguồn công khai và thuật toán kinh điển. Do đó tài liệu được dùng như **rubric capability/correctness**, không phải oracle layout hay byte-exact:

1. kiểm tra contour, clearance, quantity, duplex, objective, registration và đầu ra máy cắt;
2. không gọi heuristic PrynX là bug chỉ vì không dùng GA/SA/Tabu;
3. không buộc hai solver phải tạo cùng pose nếu đều thỏa hợp đồng;
4. tách True Shape và Guillotine; audit này không suy rộng finding sang `mixed_guillotine` nếu chưa trace riêng.

## 4. Sự thật kiến trúc đã tái kiểm

### 4.1 Luồng đang tồn tại

```text
GridPreview.tsx
  → preview true_shape_nesting
  → nesting_preview_capacity.py
  → nesting_preview_jobs/session.py
  → ProductionNestingJobInput
  → nesting_production_orchestrator.py
  → native/src/mixed_nesting_py.rs
  → imposition_core::mixed_nesting
  → manifest/session
  → nesting_imposition_render.py
  → Front[/Back]/Cut PDF

processHandlers.ts
  → /nup-start
  → nup_engine.py::route_true_shape
  → nup_true_shape_nesting.py
  → tái dùng session hoặc solve production

PDF → máy cắt
  → cut_export/pdf_source.py
  → CutModel
  → registration.py
  → command_stream/DXF/SVG/PDF emitter
  → file/TCP/serial transport
```

### 4.2 Lõi hình học/search

- `imposition_core/src/mixed_nesting/nfp.rs`: phân rã lồi hai polygon, Minkowski từng cặp và union thành NFP; IFP hiện là rectangular inner-fit.
- `solver.rs`: sinh pose từ miền khả thi, ưu tiên Bottom-Left và refine.
- `validator.rs`: kiểm độc lập pose, biên tờ, overlap, quantity, fixed obstacle và clearance theo trục; dùng spatial grid broad phase.
- `native/src/mixed_nesting_py.rs`: nhả GIL, nhận hardware worker grant, chạy portfolio/cold NFP phù hợp và revalidate/provenance.
- `baseline.rs::run_autofill_baseline`: B9 cache feasible-region theo `(part_index, angle)` và trừ delta blocker; tối ưu này **chỉ live ở autofill baseline**, không phải toàn solver hay quantity smart trial.

### 4.3 Đính chính độ chính xác số

Không được mô tả “toàn solver fixed-point `1e-6 mm`”. Đúng hơn:

- Boolean kernel/Clipper dùng scale `1e6` cho các phép Boolean liên quan;
- convex Minkowski, candidate/refine và nhiều bước hình học cuối vẫn dùng `f64`;
- final correctness dựa trên validator và tolerance contract, không chỉ dựa vào một nhãn fixed-point chung.

### 4.4 Song song và tính tất định

Nhận định cũ “native chỉ dùng một lõi” là **`[DISPROVED]`**. Current source có hardware grant tới native, cold-miss NFP song song và portfolio theo wave. Cần diễn giải đúng giới hạn:

- fixed-work được kiểm với 1/2/4/8/15 worker và giữ canonical result;
- deadline run có thể khác giữa máy/số worker vì số wave/barrier hoàn tất phụ thuộc tốc độ;
- không được hứa deadline result byte-identical xuyên mọi phần cứng.

Policy worker hiện tuân thủ máy yếu/máy mạnh:

- `<8 GB`: 1 worker;
- `8–<16 GB`: tối đa 2 worker và có available-RAM guard;
- `>=16 GB`: giữ `cpu_count - 1`, không hạ vô điều kiện;
- env override thắng khi người vận hành chủ động đặt.

### 4.5 Gate phát hành

`build_production.ps1:407-408` trên source đã audit đặt cả frontend và backend gate về `false`, sau đó kiểm lại trước bundle/manifest. Đây là cấu hình release script cần giữ tới khi đóng các gate ở §12; installer/binary đang phát hành chưa được kiểm trong lượt này.

## 5. Ma trận đính chính nhận định cũ

| Nhận định | Kết luận tái audit |
|---|---|
| “Native chỉ dùng một lõi” | **Sai trên current source**; portfolio/NFP đã có song song có điều kiện. |
| “Toàn solver fixed-point 1e-6 mm” | **Quá rộng**; scale `1e6` thuộc Boolean kernel, các phần khác vẫn có `f64`. |
| “B9 incremental feasible cache áp toàn solver” | **Sai phạm vi**; hiện chỉ ở `run_autofill_baseline`. |
| “Auto-route bình thường không handoff preview” | **Đã đóng ở happy path mức source/test**; normal path có session reference và `solvedAgain=false` regression. |
| “Mọi failure-path handoff đã đóng” | **Chưa đúng**; attach/reference absent/miss/conflict và `ValueError` fallback cần policy + chaos test. |
| “Persisted publication nonce conflict còn mở” | **Đã đóng ở happy path mức source/test**; chưa có packaged runtime smoke. |
| “Fixed-work và deadline đều tất định như nhau” | **Sai**; fixed-work có invariant mạnh, deadline phụ thuộc số barrier hoàn tất. |
| “Khác GA/SA/Tabu là bug” | **Sai phương pháp audit**; chỉ là capability gap nếu hợp đồng hiện tại vẫn đúng. |
| “Báo cáo utilization hiện tại tương đương net CUT waste” | **Sai semantic**; hiện chủ yếu là packing footprint/outer area trên full sheet. |

## 6. Findings ưu tiên

### 6.1 Bảng tổng hợp

| ID | Mức | Finding | Bằng chứng | Reachability |
|---|---:|---|---|---|
| `RE-NEST-01` | P1 | Quantity global/kế thừa/explicit zero bị rơi | `SOURCE + PROBE` | Dev/gated true-shape; blocker trước enable |
| `RE-NEST-02` | P1 | CNC duplex rơi về simplex | `SOURCE` | Dev/gated CNC; blocker trước enable |
| `RE-NEST-03` | P1 | Hard-cap 200 tờ trái contract core 10.000 | `SOURCE + AUTO` | Gated quantity fulfillment lớn |
| `RE-NEST-04` | P2 | `Tem/tờ` lấy global `placedCount` dù preview chỉ tờ 0 | `SOURCE + AUTO` | Multi-sheet preview |
| `RE-NEST-05` | P2 | Candidate/NFP nén gap X/Y thành `hypot` | `SOURCE + AUTO` | Mật độ layout, không phá an toàn |
| `RE-NEST-06` | P2 | SVG preview làm phẳng nhiều ring/hole thành một polygon | `SOURCE` | Hiển thị preview |
| `RE-NEST-07` | P2 | `materialUtilization` không phải net CUT material | `SOURCE + AUTO` | Báo cáo/so sánh hiệu suất |
| `RE-CUT-01` | P2 + proof gap | PDF route hard-code `marks=[]` | `SOURCE`; vật lý=`PROOF GAP` | API live; desktop entry hiện ẩn |
| `RE-CUT-02` | P2 | `overcut_plu > 0` không đổi command stream | `SOURCE` | Custom profile; built-in hiện bằng 0 |
| `RE-CUT-03` | P2 | Effective `reg_mode` của request không tới emitter | `SOURCE` | API/custom client; desktop entry hiện ẩn |
| `RE-CUT-04` | P2 | Schema nhận `emitter="gcode"` nhưng factory mặc định xuất DXF | `SOURCE` | Custom profile/API |

### 6.2 `RE-NEST-01` — Quantity global/kế thừa/zero bị rơi

Frontend export gửi cả `targetQuantity` và `targetQuantitiesByPage` tại `desktop/src/lib/processHandlers.ts:328-329`; preview cũng gửi `target_quantity`. Nhưng:

- `settings_from_preview_request()` tại `backend/app/core/nesting_preview_capacity.py:74` chỉ tạo `targetQuantitiesByPage`, không tạo `targetQuantity`;
- `_page_quantities()` tại `backend/app/workers/nup_true_shape_nesting.py:302` chỉ đọc map per-page và chỉ giữ quantity `>0`;
- `build_true_shape_nesting_job()` coi map rỗng là `autofill_single_sheet`.

Probe current source:

```text
global-only    → hasTargetQuantity=False, mapped={}, effective={}
partial-inherit→ hasTargetQuantity=False, mapped={'0': 2}, effective={0: 2}
explicit-zero  → mapped={'0': 0, '1': 4}, effective={1: 4}
```

Hợp đồng cần canonicalize trước solve:

```text
effectiveQty(page) = override[page] nếu key tồn tại, kể cả 0
                   = globalQty nếu key không tồn tại
```

Chỉ vào autofill khi sau materialization không có quantity dương nào. Nếu không sửa, global-only biến thành lấp đầy một tờ và partial override làm rơi trang đáng lẽ kế thừa.

**Gate đóng:** cùng một helper canonical quantity phải được preview và export dùng; test global-only, partial override, explicit zero, trang đã xóa, nhiều part và duplex pair.

### 6.3 `RE-NEST-02` — CNC duplex rơi về simplex

Frontend export gửi `cncTwoSided`, `cncFlipEdge`, `cncDuplexMarks` tại `processHandlers.ts:386-388`. Preview có hai field đầu nhưng thiếu contract registration đầy đủ. Trong `_assemble_nesting_job()` tại `nup_true_shape_nesting.py:471`, constructor `ProductionNestingJobInput` không gán các field duplex. Dataclass tại `nesting_production_pipeline.py:109` vì vậy dùng mặc định:

```text
duplex_mode='simplex'
flip_edge='none'
duplex_registration=False
```

Các tầng thấp hơn đã hỗ trợ render bundle Front/Back/Cut; lỗi nằm ở bridge, không phải cần viết lại renderer.

**Gate đóng:** artifact CNC hai mặt phải có đúng Front/Back/Cut, `back_page_index`, mirror long/short edge, registration marks và cùng placement identity; bridge test phải bắt đầu từ payload gần UI, không chỉ `replace(job, duplex_mode="duplex")` ở test tầng thấp.

### 6.4 `RE-NEST-03` — Hard-cap 200 tờ

`MAX_SHEETS_CEILING = 200`; `_assemble_nesting_job()` tính:

```python
max_sheets = max(1, min(MAX_SHEETS_CEILING, total_quantity))
```

Trong khi `imposition_core/src/mixed_nesting/model.rs` công khai `MAX_SHEETS_LIMIT = 10_000`. Writer fail-closed nếu còn unplaced nên không giao thiếu âm thầm, nhưng job hợp lệ cần 201–10.000 tờ bị từ chối muộn.

Đây không phải worker/RAM cap: số tờ là contract fulfillment; scheduling tài nguyên phải là policy khác và chỉ hạ máy `<16 GB` nếu cần.

**Gate đóng:** hoặc hỗ trợ miền đã công khai, hoặc preflight sớm với giới hạn nghiệp vụ nhất quán ở UI/API/core. Test phải chứng minh đơn >200 đủ quantity hoặc bị từ chối trước solve với lý do rõ.

### 6.5 Các finding P2 nesting/preview

- **`RE-NEST-04`:** `session_capacity()` tại `nesting_preview_session.py:204-208` trả manifest global `placedCount`; cells preview chỉ lấy sheet 0. Cần tách `itemsOnPreviewSheet`, `placedTotal`, `sheetsNeeded`.
- **`RE-NEST-05`:** `normalize.rs` dùng `hypot(x,y)` làm scalar gap cho candidate/NFP, còn final validator dùng clearance theo axis. Hành vi an toàn nhưng bảo thủ, có thể loại pose hợp lệ và giảm mật độ. Cần Minkowski rectangle/axis-aware candidate với corpus dị hướng.
- **`RE-NEST-06`:** `GridPreview.tsx:3494-3500` gọi `diePolylinesPx.flat()` rồi tạo một `<polygon>`, nối giả outer/hole/ring rời. PDF CUT vẫn giữ ring riêng. Cần SVG `<path>` nhiều subpath hoặc nhiều polygon đúng fill rule.
- **`RE-NEST-07`:** packing footprint được buffer/simplify và bỏ holes; Rust tiếp tục coi outer là đặc cho area. Cần tách tên metric `packingFootprintUtilization` và `cutContourMaterialUtilization`, không dùng số hiện tại để tuyên bố parity “Minimum Waste” với Esko.

### 6.6 Các finding P2 đường máy cắt

- **`RE-CUT-01`:** `pdf_source.py` truyền `marks=[]` ở cả hai builder; `frame=None` khiến onboard-frame có thể dùng full MediaBox/FSIZE. Lỗi mất metadata đã xác nhận, nhưng tác động vật lý giữ `PROOF GAP` tới khi có fixture PDF nesting → marks → frame → byte oracle/vendor/machine.
- **`RE-CUT-02`:** `_emit_path()` chỉ đóng lại điểm đầu, không đọc `overcut_plu`. Built-in profile hiện đặt 0, nên reachability chính là custom profile. Hoặc thực thi và test, hoặc từ chối nonzero ở schema.
- **`RE-CUT-03`:** `service.export_cut()` tính `mode = reg_mode or profile.reg_mode` để gọi registration, nhưng `CommandStreamEmitter.emit()` lại quyết frame-origin bằng `profile.reg_mode`. Override API vì vậy không authoritative ở emitter.
- **`RE-CUT-04`:** `profile.py` chấp nhận `gcode`, nhưng `make_emitter()` chỉ tự chọn command stream khi token đúng `command_stream`, còn mọi token khác mặc định DXF. Không được im lặng xuất sai định dạng; phải implement hoặc reject fail-closed.

`Send to Cutter` modal vẫn mount nhưng entry desktop hiện bị ẩn; backend API vẫn live. Vì vậy các finding cutter không phải dead code, nhưng reachability desktop hiện thấp hơn API/custom client.

## 7. Phân loại lỗi Vitest còn đỏ

### 7.1 Quan sát B10-6 đỏ trước đó — race của test harness, rerun cuối đã xanh

Ở snapshot dirty trước chốt digest, test `GridPreview.mixedDuplex.test.tsx:920` từng đỏ theo trình tự:

1. advance fake timer tới 750 ms;
2. chỉ assert `nestingJobMocks.create` đã **được gọi**;
3. click “Hủy preview” ngay;
4. assert đồng bộ progress tồn tại.

Trong source, `activeNestingJobRef.current` chỉ được gán **sau**:

```ts
const accepted = await createNestingPreviewJob(body);
activeNestingJobRef.current = { ... };
```

Mock call được ghi nhận trước continuation sau `await`. Test vì vậy có thể click khi `activeNestingJobRef` vẫn `null`; handler hợp lệ không vào trạng thái “đang hủy active job”. Production logic khi đã có active job đặt `isCancellingNesting=true`, giữ progress trong lúc retry và nhả ở `finally`. Khi người dùng hủy trước lúc POST trả `job_id`, generation fence làm response đến muộn bị hủy riêng.

Trên audit surface đã content-digest ở §2.2, rerun cuối đạt **121/121** cho ba file và **34/34** khi chạy riêng `GridPreview.mixedDuplex`. Vì vậy không còn frontend failure hiện hành để nâng finding. Quan sát đỏ cũ vẫn chỉ ra test chưa khóa chắc tiền điều kiện “active job đã được gán”; nếu sửa test sau duyệt, nên dùng deferred `create` resolve trong `act` hoặc đợi tín hiệu sau continuation thay vì chỉ đợi call count.

### 7.2 Hai failure đổi trang từng quan sát

Hai failure đổi trang xuất hiện ở lượt chạy chung trước đó nhưng không tái hiện trong rerun cuối **121/121**. Không có repeat/seed/generation log gắn với source digest cũ, nên chỉ lưu như lịch sử **không tái hiện**; không gọi flaky, contention hay production regression.

## 8. Capability gaps `[EXPECTED]` — chưa gọi là bug

1. Hole/jigsaw nesting: giữ hole cho CUT nhưng collision footprint coi outer là đặc.
2. Minimum Distinct Layouts + overrun/setup cost trong true-shape lane.
3. Reverso policy/pairing 0°/180° tường minh.
4. Common-line/least-cuts và tối ưu hành trình cắt.
5. Beam nhiều layout state, GA/SA/Tabu: có thể là hướng nghiên cứu, không phải yêu cầu thuật toán bắt buộc.
6. Kongsberg/Zünd/JDF/ACM postprocessor native.
7. Sanitize/repair self-intersection/MultiPolygon; hiện fail-closed là policy an toàn.
8. Continuous/free rotation ở production; core hỗ trợ rộng hơn nhưng rollout Tem/CNC đang khóa cardinal.
9. Guillotine cut-tree/DP parity; cần audit lane riêng, không trộn với NFP.

## 9. Đề xuất nâng cấp theo tầng

### Tầng 0 — Correctness contract trước mở gate

1. Canonical quantity materialization dùng chung preview/export.
2. Bridge đầy đủ CNC duplex/flip/registration/back-page.
3. Đồng bộ `maxSheets` và preflight fulfillment.
4. Chốt policy failure-path handoff; không fallback legacy sau khi preview identity đã được cam kết.

Đây là các hạng mục bắt buộc; chưa đóng thì mọi tối ưu search đều có nguy cơ “xếp rất nhanh một bài toán sai”.

### Tầng 1 — Truth của UI và chất lượng layout

1. Tách count sheet hiện tại/tổng job/số tờ.
2. Render topology multi-ring đúng.
3. Tách metric footprint và contour CUT.
4. Axis-aware clearance trong candidate/NFP/baseline/refine.

### Tầng 2 — Evidence và release engineering

1. Benchmark current native build có identity/provenance.
2. P50/P95 và peak RSS **toàn process tree**, không chỉ PID Python hiện tại.
3. Artifact CNC duplex Front/Back/Cut và cutter bytes.
4. Tauri dev + packaged runtime smoke.
5. Corpus quality gate so với baseline hiện tại, không bless golden tự động.

### Tầng 3 — Nâng năng lực search có bằng chứng

Chỉ mở epic sau khi Tầng 0–2 đạt:

- objective Minimum Layouts/overrun;
- Reverso/symmetry policy;
- hole nesting;
- common-line/least-cuts;
- beam/GA/SA/Tabu nếu corpus cho thấy portfolio hiện tại bị kẹt local optimum có giá trị kinh doanh.

### Vì sao chưa ưu tiên GA/GPU/RL

- Các blocker hiện tại là mapping/provenance contract, không phải compute kernel.
- NFP/IFP/validator/cache/parallel portfolio đã tồn tại.
- B9 lịch sử cho 457-piece baseline giảm khoảng `35,8 s → 5,06 s`; NF-BUDGET lịch sử giảm median cold khoảng `8,0 s → 5,0 s`, nhưng đây không phải current P95.
- Chưa có current-build benchmark chứng minh search là bottleneck lớn nhất sau các thay đổi mới.
- GPU/RL tăng chi phí determinism, packaging và debug; ROI chưa có corpus/oracle hỗ trợ.

## 10. Kế hoạch triển khai sau duyệt — mỗi lô tối đa 5 file

Danh sách file dưới đây là phạm vi dự kiến. Nếu lúc triển khai cần file thứ sáu, phải tách lô trước khi sửa.

### Lô A1 — Canonical quantity

**Tối đa 5 file:**

1. `backend/app/core/nesting_quantities.py` — helper mới, pure/canonical.
2. `backend/app/core/nesting_preview_capacity.py`.
3. `backend/app/workers/nup_true_shape_nesting.py`.
4. `backend/tests/test_nesting_preview_capacity.py`.
5. `backend/tests/test_nup_true_shape_nesting_entry.py`.

**Nghiệm thu:** global-only, partial override, explicit zero, page deletion, all-zero autofill và multi-part fulfillment; preview/export tạo cùng effective quantities và identity.

### Lô A2a — Bridge backend CNC duplex

**Tối đa 5 file:**

1. `backend/app/api/routes/imposition.py`.
2. `backend/app/core/nesting_preview_capacity.py`.
3. `backend/app/workers/nup_true_shape_nesting.py`.
4. `backend/tests/test_nesting_preview_capacity.py`.
5. `backend/tests/test_nup_true_shape_nesting_entry.py`.

**Nghiệm thu:** request/job cùng `twoSided/flipEdge/registration/backPage`; simplex không bị đổi; long/short edge có contract test.

### Lô A2b — UI payload duplex

**Tối đa 5 file:**

1. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`.
2. `desktop/src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx`.
3. `desktop/src/lib/processHandlers.ts` nếu cần đồng bộ tên field.
4. `desktop/src/lib/processHandlers.test.ts`.
5. `desktop/src/components/imposition-tools/trueShapeNestingRollout.test.tsx` nếu gate contract đổi.

**Nghiệm thu:** preview/export gửi cùng canonical duplex contract; test bắt đầu từ component/payload, không chỉ dựng job tầng thấp.

### Lô A2c — Artifact duplex

**Tối đa 5 file:**

1. `backend/tests/test_nesting_imposition_bundle.py`.
2. `backend/tests/test_nesting_imposition_render.py`.
3. `backend/tests/test_nesting_production_pipeline.py`.
4. tối đa một fixture artifact.
5. tối đa một module renderer nếu artifact lộ lỗi thật.

**Nghiệm thu:** mở lại PDF thật, đúng thứ tự Front/Back/Cut, cùng placement identity, mirror đúng cạnh, marks/report đúng.

### Lô A3 — maxSheets/fulfillment

**Tối đa 5 file:**

1. `backend/app/workers/nup_true_shape_nesting.py`.
2. `backend/app/core/nesting_production_pipeline.py`.
3. `backend/app/api/routes/imposition.py` nếu cần preflight/schema.
4. `backend/tests/test_nup_true_shape_nesting_entry.py`.
5. `backend/tests/test_nesting_production_pipeline.py`.

**Nghiệm thu:** contract duy nhất; ca >200 tờ đủ quantity hoặc fail sớm rõ lý do; không dùng RAM worker cap để âm thầm đổi số tờ.

### Lô A4 — Failure-path handoff/provenance

**Tối đa 5 file:**

1. `backend/app/workers/nup_true_shape_nesting.py`.
2. `backend/app/workers/nup_engine.py`.
3. `backend/app/core/nesting_preview_session.py`.
4. `backend/tests/test_nesting_session_handover.py`.
5. `backend/tests/test_nesting_auto_route_custom.py`.

**Nghiệm thu:** chaos test reference absent/miss/conflict và `ValueError`; trước khi có committed preview identity chỉ được solve một lần theo policy có telemetry; sau khi identity đã cam kết phải fail-closed, không fallback legacy/solve âm thầm. Runtime ghi rõ `solvedAgain` và lý do.

### Lô B1 — Preview count/topology/metric

**Tối đa 5 file:**

1. `backend/app/core/nesting_preview_session.py`.
2. `backend/app/core/nesting_preview_capacity.py`.
3. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`.
4. `backend/tests/test_nesting_preview_session.py`.
5. `desktop/src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx`.

**Nghiệm thu:** `itemsOnPreviewSheet`, `placedTotal`, `sheetsNeeded` không nhập nhằng; multi-ring không có đoạn nối giả; metric mới có tên/đơn vị rõ.

### Lô B2a — Primitive clearance dị hướng

**Tối đa 5 file:**

1. `imposition_core/src/mixed_nesting/normalize.rs`.
2. `imposition_core/src/mixed_nesting/nfp.rs`.
3. `imposition_core/src/mixed_nesting/collision.rs`.
4. `imposition_core/tests/mixed_nesting_nfp_validator.rs`.
5. `imposition_core/tests/mixed_nesting_candidates.rs`.

**Nghiệm thu:** primitive axis-aware có oracle cho `(x≠y)` và gap đều; final validator vẫn 0 lỗi; chưa tuyên bố đóng finding khi consumer live chưa migrate.

### Lô B2b — Migrate mọi consumer scalar gap

**Tối đa 5 file:**

1. `imposition_core/src/mixed_nesting/solver.rs`.
2. `imposition_core/src/mixed_nesting/baseline.rs`.
3. `imposition_core/src/mixed_nesting/refine.rs`.
4. `imposition_core/tests/mixed_nesting_baseline.rs`.
5. `imposition_core/tests/mixed_nesting_solver.rs`.

**Nghiệm thu:** solver, quantity baseline, autofill baseline và refine không còn nén contract axis thành scalar bảo thủ; corpus gap `(x≠y)` không kém current score; fixed-work determinism giữ nguyên. Chỉ update golden khi thay đổi hình học là chủ đích và đã soi diff.

### Lô C1 — Harness/provenance

**Tối đa 5 file:**

1. `scripts/benchmark_mixed_nesting.py`.
2. `backend/tests/test_mixed_nesting_benchmark_contract.py`.
3. tối đa một helper process-tree RSS mới.
4. một schema/raw-result fixture.
5. một tài liệu định nghĩa SLO đã được duyệt.

**Nghiệm thu:** record source/native identity, command/env/hardware, process-tree RSS, raw JSON/CSV và artifact hash; chạy dry-run tái lập được. Không sửa solver.

### Lô C2 — Chạy evidence

Không sửa production source. Tối đa 5 output/artifact có content hash: raw result ba tier, summary, artifact duplex và provenance manifest. Nếu cần nhiều output hơn phải chia theo tier.

**Nghiệm thu:** ma trận §11 chạy trên clean/content-addressed source; numeric SLO đã được duyệt trước khi nhìn kết quả; không dùng số lịch sử làm current evidence.

### Lô D1 — Marks/frame/effective registration

**Tối đa 5 file:**

1. `backend/app/workers/cut_export/pdf_source.py`.
2. `backend/app/workers/cut_export/service.py`.
3. `backend/app/workers/cut_export/emitters/command_stream.py`.
4. `backend/app/workers/cut_export/tests/test_pdf_source.py`.
5. `backend/app/workers/cut_export/tests/test_service.py` hoặc test emitter tương ứng.

**Nghiệm thu:** request effective mode authoritative từ register tới emitter; fixture marks tạo frame/FSIZE đúng; override `none/onboard_frame/manual_affine` có byte-level assertion.

### Lô D2 — overcut và gcode

**Tối đa 5 file:**

1. `backend/app/workers/cut_export/profile.py`.
2. `backend/app/workers/cut_export/service.py`.
3. `backend/app/workers/cut_export/emitters/command_stream.py`.
4. `backend/app/workers/cut_export/tests/test_profile.py`.
5. `backend/app/workers/cut_export/tests/test_emitter_command_stream.py`.

**Nghiệm thu:** nonzero overcut được thực thi đúng hoặc bị reject; `gcode` được implement đúng hoặc reject fail-closed, tuyệt đối không fallback DXF. Nếu không làm trong release này, schema/API phải disable hai contract trước mở gate.

### Feature epic riêng sau release gate

Reverso, Minimum Layouts/overrun, hole nesting, common-line và postprocessor công nghiệp phải có spec/corpus/acceptance riêng. Không gộp chúng vào lô sửa correctness.

## 11. Ma trận benchmark bắt buộc

| Tier máy | Worker policy | Ca tối thiểu | Chỉ số |
|---|---|---|---|
| `<8 GB` | 1 worker | small + representative | P50/P95, peak RSS tree, không OOM |
| `8–<16 GB` | tối đa 2 | small + representative + quantity | P50/P95, RSS, quality |
| `>=16 GB` | `cpu-1`, không hard-cap | toàn corpus + 457-piece | P50/P95, CPU/wall, scaling, RSS |

Mỗi tier cần:

- ít nhất 2 warm-up và **20 measured run** cho mỗi ca trước khi báo P95;
- source revision, audit-surface/native identity, CPU/RAM/OS, worker grant và env trong raw record;
- `placedCount`, `sheetCount`, `unplaced`, score, termination reason và validator result;
- peak RSS của sidecar + worker/native process tree;
- fixed-work so 1/2/4/8/15 worker; deadline report riêng, không áp byte-identical promise sai;
- packaged runtime run riêng với interpreted/dev run;
- quality floor: không xấu hơn approved fixed-work baseline theo thứ tự unplaced → sheet count → objective; mọi delta chủ đích phải có reviewed diff/golden và duyệt riêng.

**Numeric SLO hiện chưa được duyệt đầy đủ**, nên performance gate đang `OPEN` dù có số đo. Lô C1 phải chốt ngưỡng trước C2. Mốc lịch sử cold P95 `≤5 s` chỉ được dùng nếu owner tái xác nhận cho representative corpus/current hardware; không tự biến median lịch sử thành SLO. Với RSS, bắt buộc không OOM/worker kill; ceiling từng tier phải được duyệt sau khi harness process-tree đúng. Máy `>=16 GB` không được đạt SLO bằng cách hard-cap worker trái policy.

Historical NF-BUDGET/B9 chỉ dùng để chọn corpus và phát hiện hồi quy; không được ghi là current P95.

## 12. Acceptance gate trước mở release

| Gate | Điều kiện bắt buộc |
|---|---|
| Source/provenance | Clean hoặc content-addressed source manifest; native identity khớp source; command/env/raw log/artifact hash được lưu |
| Tests | Targeted/full relevant suites 0 failure chưa phân loại; `typecheck`, lint liên quan và build affected packages đạt |
| Quantity | Global, partial override, explicit zero, page deletion và multi-part đều materialize đúng |
| CNC duplex | Front/Back/Cut, back-page pairing, long/short mirror, registration và report đúng |
| Fulfillment lớn | >200 tờ đủ số lượng hoặc preflight fail sớm theo policy công bố |
| Preview = export | Happy path cùng canonical request/session/native identity/pose và `solvedAgain=false`; absent/miss/conflict/ValueError theo policy, không fallback sau committed identity |
| Correctness | Final validator: 0 overlap/out-of-sheet/clearance/obstacle/quantity issue |
| UI truth | Sheet count, placed total, items/sheet và utilization có semantic riêng |
| Determinism | Fixed-work 1/2/4/8/15 worker cùng canonical result |
| Hiệu năng | Numeric SLO được duyệt trước run; current-build cold/warm P50/P95 và peak RSS ba tier đạt SLO |
| Quality | Corpus không kém approved baseline; intentional delta có reviewed golden/diff |
| Artifact | PDF CNC duplex reopen được; Front/Back/Cut và marks được kiểm |
| Cutter | PDF→marks→frame→FSIZE có byte oracle; effective reg mode authoritative; overcut/gcode được implement hoặc reject/disable rõ |
| Runtime | Tauri dev và packaged sidecar/installer smoke trên file CNC hai mặt thật |
| Release config | Hai gate frontend/backend đồng bộ và chỉ bật sau khi mọi gate trên đạt |

## 13. Kết quả verify của lượt tái audit

### 13.1 Kết quả

| Phạm vi | Kết quả |
|---|---:|
| `imposition_core` toàn bộ | **347 passed, 2 ignored, 0 failed** |
| Backend nesting targeted | **384 passed, 1 skipped, 1 warning, 0 failed** |
| Cut-export targeted | **41 passed, 2 warnings, 0 failed** |
| Frontend 3 file — lượt quan sát trước digest | **116 passed, 3 failed** |
| `GridPreview.mixedDuplex` — lượt cô lập trước digest | **31 passed, 1 failed** |
| Frontend 3 file — rerun cuối trên audit surface digest | **121 passed, 0 failed** |
| `GridPreview.mixedDuplex` — rerun cuối cô lập | **34 passed, 0 failed** |
| Probe quantity | **Tái hiện global/partial/zero contract loss** |

Không che lịch sử đỏ: lượt trước từng có một B10-6 và hai ca đổi trang thất bại. Tuy nhiên source dirty trước đó không được content-address, số test collect cũng khác `119 → 121`; không thể khẳng định hai lượt dùng byte-identical test surface. Bằng chứng cuối gắn với audit surface §2.2 là **121/121** và **34/34**. Phân tích race B10-6 cùng giới hạn được giữ tại §7; hai ca đổi trang không tái hiện và không được nâng thành finding.

### 13.2 Lệnh đã chạy

CWD `D:\pdfcompare\imposition_core`:

```powershell
cargo test
```

CWD `D:\pdfcompare\backend`:

```powershell
.\venv\Scripts\python.exe -m pytest -q tests/test_nup_true_shape_nesting_entry.py tests/test_nesting_preview_capacity.py tests/test_nesting_session_handover.py tests/test_nesting_production_pipeline.py tests/test_nesting_imposition_bundle.py tests/test_nesting_imposition_render.py tests/test_nesting_layout_golden.py tests/test_nesting_packing_footprint.py tests/test_nesting_auto_route_custom.py tests/test_mixed_nesting_admission.py

.\venv\Scripts\python.exe -m pytest -q app/workers/cut_export/tests/test_pdf_source.py app/workers/cut_export/tests/test_emitter_command_stream.py app/workers/cut_export/tests/test_dual_head.py app/workers/cut_export/tests/test_registration.py app/workers/cut_export/tests/test_api.py
```

CWD `D:\pdfcompare\desktop`:

```powershell
npx vitest run src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx src/lib/processHandlers.test.ts src/components/imposition-tools/trueShapeNestingRollout.test.tsx

npx vitest run src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx
```

Probe quantity chạy bằng `backend\venv\Scripts\python.exe -c ...`, gọi trực tiếp `settings_from_preview_request()` rồi `_page_quantities()` cho ba case global-only/partial/explicit-zero; output được chép ở §6.2. Raw logs của các lệnh trên không được lưu riêng, là giới hạn provenance đã ghi ở §2.2.

Không update golden. Không chạy current native benchmark, typecheck/full frontend suite, build installer, packaged runtime hoặc thử máy cắt trong lượt này.

## 14. Quyết định đề xuất và chốt duyệt

1. **Giữ HOLD** cho true-shape release.
2. Duyệt triển khai theo thứ tự **A1 → A2a → A2b → A2c → A3 → A4 → B1 → B2a → B2b → C1 → C2 → D1 → D2**.
3. Mỗi lô tối đa 5 file, verify xong và báo bằng chứng trước lô kế.
4. Không sửa tiện tay capability epic trong các lô correctness.
5. Không mở GA/GPU/RL trước khi benchmark current-build chứng minh nhu cầu.
6. Chưa mở release nếu full relevant frontend/typecheck chưa xanh, provenance chưa content-addressed hoàn chỉnh hoặc numeric SLO chưa được duyệt.

Báo cáo này hoàn tất **chốt 1** của workflow audit hai chốt. Chưa có production source nào được sửa trong lượt audit. Chỉ bắt đầu Lô A1 sau khi người dùng duyệt báo cáo/kế hoạch.