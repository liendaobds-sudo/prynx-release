# Báo cáo audit đối chiếu nesting Bình tem bế/CNC với Esko i-cut

Ngày: **2026-08-30**

Audit unit: **W2-U09 / W7-U11**, mở rộng tới đường xuất dữ liệu máy cắt CNC

Trạng thái: **READ-ONLY · CHỜ DUYỆT · KHÔNG SỬA PRODUCTION CODE**

## 1. Kết luận điều hành

PrynX hiện có một lõi true-shape nesting đáng tin cậy về nền tảng hình học: NFP thật qua
phân rã lồi + Minkowski, IFP chữ nhật, miền khả thi `IFP \ NFP`, ứng viên Bottom-Left,
fixed-point `1e-6 mm`, validator độc lập solver và NFP cache. Cold-miss NFP chạy song song
khi có ít nhất hai cold key, worker grant và byte budget phù hợp; portfolio trial chạy song
song theo wave với quota/reduce tất định.

Tuy nhiên, **toàn luồng Bình tem bế/CNC chưa đạt bộ tiêu chí nghiệp vụ/capability rút từ tài
liệu và chưa đủ điều kiện mở release gate**. Lý do không nằm chủ yếu ở kernel NFP mà ở hợp
đồng xuyên tầng:

- CNC hai mặt bị hạ thành simplex trên đường true-shape;
- số lượng global/kế thừa theo trang bị rơi khỏi true-shape job;
- trần cứng 200 tờ từ chối đơn nằm trong miền API/core đã công khai.

Ngoài **3 lỗi P1** trên, audit xác nhận **6 lỗi P2**, gồm số liệu preview, clearance,
topology hiển thị, định nghĩa utilization và hai khoảng hở hợp đồng PDF → máy cắt. Riêng tác
động vật lý của việc route PDF bỏ registration-mark metadata vẫn là `PROOF GAP`, chưa được
nâng thành P1 khi chưa có oracle PDF → FSIZE/vendor hoặc thử cắt thật.

True-shape lane còn thiếu các capability mà tài liệu dùng làm hình mẫu công nghiệp: lồng chi
tiết vào lỗ, Minimum Distinct Layouts/overrun, mode Reverso tường minh, common-line/
least-cuts và postprocessor Kongsberg/Zünd/JDF/ACM. Các mục này được phân loại là khoảng
cách năng lực, không mặc định gọi là bug; audit không suy rộng sang lane `mixed_guillotine`.

**Verdict:** giữ `VITE_TRUE_SHAPE_NESTING_ENABLED=false` và
`PRYNX_TRUE_SHAPE_NESTING_ENABLED=false` trong build production. Chưa sửa code ở chốt audit
này.

## 2. Baseline và phạm vi bằng chứng

| Thuộc tính | Giá trị |
|---|---|
| Nhánh | `codex/pre-release-audit-2026-08-04` |
| HEAD | `8bc0a219b2ec53cc9cc06adb4b9a7cd11c341dff` |
| Snapshot | Working tree hiện tại, **244** entry theo `git status --porcelain` tại chốt báo cáo; không đại diện riêng HEAD |
| Tài liệu đối chiếu | `docs/nesting-algorithms-esko-icut.md` |
| SHA-256 tài liệu | `71012357D212D6CC9D3E94CE5A6CC70A97974DBAE8051B43B91A5E9D91A4D185` |
| Phạm vi | UI → preview job → session → production adapter → Rust solver → manifest → Front/Back/Cut → Send to Cutter |
| Ngoài phạm vi | Build installer, app click-smoke, cắt vật lý, benchmark P50/P95 mới, audit sâu nhánh guillotine |

Thang bằng chứng dùng trong báo cáo:

- `TRACED`: đã truy vết đủ entry/consumer/engine/writer trên source hiện tại;
- `AUTO`: test tự động đã chạy trên source hiện tại;
- `PROBE`: one-off runtime probe tái hiện đúng hợp đồng bị rơi;
- `ARTIFACT`: đã mở/đo artifact PDF thật trong đợt audit;
- `EXPECTED`: khoảng cách năng lực có chủ đích hoặc chưa được sản phẩm hứa;
- `PROOF GAP`: chưa có fixture/oracle đủ để gán severity.

## 3. Giới hạn thẩm quyền của tài liệu Esko

Tài liệu đối chiếu tự ghi rõ ở dòng 45 rằng Esko không công bố thuật toán nội bộ; GA/SA/
Tabu, column generation và một số chi tiết là suy luận từ tài liệu công khai + thuật toán
kinh điển. Vì vậy:

1. dùng các bất biến correctness, capability và luồng nghiệp vụ làm rubric;
2. không dùng pseudo-code hay giả thuyết “Esko chắc chắn dùng GA” làm oracle byte-exact;
3. không gọi một heuristic khác GA/SA là bug nếu vẫn đáp ứng hợp đồng sản phẩm;
4. tách True Shape và Guillotine thành hai bài toán riêng, đúng §1 và §8 của tài liệu.

## 4. Luồng production đã trace

```text
GridPreview.tsx
  ├─ CUSTOM + optimal_auto + gate bật
  └─ POST preview true_shape_nesting
       → nesting_preview_capacity.py
       → nesting_preview_jobs/session.py
       → nesting_production_pipeline.py
       → nesting_production_adapter.py
       → native/PyO3
       → imposition_core::mixed_nesting
       → manifest + cells tờ 0

processHandlers.ts
  └─ /nup-start, gridStrategy vẫn optimal_auto
       → imposition.py::_launch_impose_job
       → nup_engine.py::route_true_shape
       → nup_true_shape_nesting.py
       → render manifest khi reference hợp lệ
       → không có field reference thì solve một lần; reference có mặt nhưng miss thì fail-closed
       → nesting_imposition_render.py
       → Front[/Back]/Cut PDF

Send to Cutter
  └─ cut_export/api.py
       → pdf_source.py
       → CutModel
       → registration.py
       → command_stream / DXF / SVG / PDF emitter
       → file / TCP / serial transport
```

Release build hiện nung cứng hai cờ true-shape về `false` tại
`build_production.ps1:404-409` và kiểm lại tại `1434-1438`, `1655-1659`. Các finding
true-shape là blocker trước mở gate; dev interpreted vẫn có thể đi vào đường này.

## 5. Ma trận đối chiếu với `nesting-algorithms-esko-icut.md`

| Trục đối chiếu | PrynX working tree hiện tại | Verdict |
|---|---|---|
| Contour semantic | Đọc contour thật, giữ outer + holes cho CUT; từ chối Polygon rỗng, self-intersection và MultiPolygon nhập nhằng | **PARTIAL** — fail-closed tốt nhưng chưa sanitize/repair như §16.8 |
| NFP hình lõm | `nfp.rs:62,143-174`: phân rã lồi hai hình, Minkowski từng cặp, union; cap 4.096 cặp và lỗi tường minh/fail-closed | **IMPLEMENTED foundation** — không có oracle parity Esko |
| IFP / miền khả thi | `inner_fit_rect` + `feasible_region`, trừ NFP của blocker | **IMPLEMENTED foundation** — chưa có oracle parity Esko |
| BLF và pocket filling | Lấy đỉnh mọi component miền khả thi, sort Bottom-Left rồi truncate `beam_width*4` tại `candidates.rs:268-287`; midpoint helper chưa có call site production | **PARTIAL** — chưa chứng minh phủ pocket tương đương |
| Correctness | Final validator kiểm pose, biên tờ, fixed obstacle, overlap, gap và quantity; dùng spatial grid | **IMPLEMENTED + AUTO** |
| Độ chính xác số | Clipper fixed-point `1 mm = 1e6` | **IMPLEMENTED** |
| Search bên ngoài BLF | Portfolio nhiều thứ tự + candidate angle + refine; chạy song song theo wave, reduce theo `trial_id` | **PARTIAL** — không có beam nhiều layout state/GA/SA/Tabu |
| Cache và song song | Pair-NFP cache có budget byte; cold miss chạy song song khi có ≥2 unique cold key, worker >1 và đủ entry/byte budget; portfolio chạy scoped wave; hardware grant đi tới native | **IMPLEMENTED + AUTO** |
| Spatial/incremental | Spatial broad-phase ở validator/baseline; feasible-region cache theo delta đã có | **PARTIAL**, không phải spatial index đầy đủ cho mọi phase |
| Rotation | Core hỗ trợ fixed/discrete/ranges/free; lane production khóa cardinal 0/90/180/270 | **PARTIAL / EXPECTED rollout** |
| Gutter/clearance | Final validator giữ đúng `gapX/gapY`; candidate/NFP dùng `hypot` bảo thủ | **PARTIAL**, an toàn nhưng giảm mật độ |
| Holes/interlocking | Hole giữ để vẽ CUT nhưng packing footprint bỏ hole, collision coi outer là đặc | **MISSING capability** |
| Minimum Waste/Sheets | Score ưu tiên unplaced → sheet count → envelope/waste; có quantity/autofill | **PARTIAL** |
| Minimum Distinct Layouts + overrun | True-shape lane không có objective/column generation tương ứng; `mixed_guillotine` ngoài phạm vi audit sâu | **MISSING trong true-shape** |
| Double-sided | Core render bundle có Front/Back/Cut + flip edge; bridge true-shape không nối | **DEFECT P1** |
| Reverso 0°/180° | True-shape generic có cardinal 180° nhưng chưa có policy/pairing Reverso tường minh; các lane named-shape legacy đã có alternating/interlock 0°/180° | **PARTIAL / EXPECTED** |
| Guillotine | Là lane `mixed_guillotine`/engine riêng, không dùng NFP | **ĐÚNG phân nhánh**, chưa audit parity thuật toán cây cắt |
| Common-line / least-cuts | Emitter chỉ sort path rồi phát trọn từng contour | **MISSING capability** |
| Máy cắt công nghiệp | Có Yuty/Skycut/generic HPGL, DXF/SVG/PDF; chưa có Kongsberg/Zünd/JDF/ACM native | **MISSING capability** |

## 6. Findings đã xác nhận

### ESKO-NEST-01 — P1 — CNC hai mặt bị hạ thành simplex

**Bằng chứng:** `TRACED + PROBE`

UI công khai Bình 2 mặt, cạnh lật và dấu canh. Payload preview có
`cncTwoSided/cncFlipEdge` nhưng schema preview chưa có `cncDuplexMarks`; payload export có
cả ba field. Tuy nhiên:

- `PreviewLayoutRequest` có `cnc_two_sided/cnc_flip_edge` tại
  `backend/app/api/routes/imposition.py:1306-1309`;
- `settings_from_preview_request()` không map hai field tại
  `backend/app/core/nesting_preview_capacity.py:67-134`;
- `build_true_shape_nesting_job()` không gán `back_page_index`, `duplex_mode`,
  `flip_edge`, `duplex_registration` tại
  `backend/app/workers/nup_true_shape_nesting.py:384-519`;
- dataclass vì vậy dùng mặc định `simplex/none/false` tại
  `backend/app/core/nesting_production_pipeline.py:95-137`.

Probe trên job CNC có `cncTwoSided=true`, `cncFlipEdge=short`, `cncDuplexMarks=true`:

```text
duplex_mode='simplex'
flip_edge='none'
duplex_registration=False
parts=[(0, None)]
```

**Tác động:** true-shape CNC có thể xuất Front+Cut thay vì Front+Back+Cut, bỏ mặt sau,
cạnh lật và dấu canh dù UI đã bật. Đây là vi phạm trực tiếp §10.2 Double-Sided của tài liệu.

**Gate đóng:** artifact CNC duplex thật phải có đúng thứ tự Front/Back/Cut, cùng placement
hai mặt, mirror đúng long/short edge, registration marks đúng và test bridge UI → job.

### ESKO-NEST-03 — P1 — Số lượng global và cơ chế kế thừa theo trang bị rơi

**Bằng chứng:** `TRACED + PROBE`

UI cho phép một `targetQuantity` global và mỗi trang chỉ override khi cần. Export gửi cả
`targetQuantity` và `targetQuantitiesByPage`, nhưng true-shape translator chỉ đọc map
per-page tại `nup_true_shape_nesting.py:298-324`; preview bridge cũng không map
`target_quantity` tại `nesting_preview_capacity.py:67-134`.

Hợp đồng cần giữ là `effectiveQty(i) = override[i]` nếu key trang `i` tồn tại, kể cả giá trị
explicit `0`; nếu key không tồn tại thì dùng quantity global. Chỉ đi chế độ autofill một tờ
khi sau bước kế thừa không có quantity dương nào.

Probe cùng hai mẫu CUSTOM, global quantity 25:

```text
global-only → autofill_single_sheet [(trang 0, None), (trang 1, None)]
override trang 0 = 7 → quantity_fulfillment [(trang 0, 7)]
```

**Tác động:** global-only bị biến thành “lấp đầy một tờ”; partial override làm rơi các trang
đáng lẽ kế thừa global. Đây là lỗi fulfillment, không phải chỉ sai preview.

**Gate đóng:** test global-only, override một phần, explicit zero và nhiều cặp CNC duplex;
job phải materialize đúng quantity hiệu dụng cho mọi part trước khi solve.

### ESKO-NEST-04 — P1 — Trần cứng 200 tờ từ chối đơn hợp lệ lớn

**Bằng chứng:** `TRACED + AUTO`

`MAX_SHEETS_CEILING = 200` tại `nup_true_shape_nesting.py:47`, áp vô điều kiện tại
`:424-445` (phép chặn tại `:431`). API nhận quantity đến 1.000.000, còn contract
Rust/schema cho phép tối đa 10.000 tờ. Test `test_max_sheets_co_tran` đang khóa hành vi 200.

Writer hiện đã fail-closed khi manifest còn `unplaced` tại
`nesting_imposition_render.py:134-142`, nên lỗi **không còn giao file thiếu âm thầm**. Tuy
nhiên, một đơn hợp lệ cần 201–10.000 tờ vẫn bị từ chối ở cuối pipeline.

**Tác động:** UI/API và lõi nhận miền lớn hơn nhưng adapter true-shape từ chối job cần hơn
200 tờ; chưa thấy policy nghiệp vụ công bố giải thích miền hẹp hơn này.

**Gate đóng:** đồng bộ contract: hoặc preflight sớm và công bố giới hạn nghiệp vụ, hoặc hỗ trợ
tới miền đã hứa; fulfillment phải đủ hoặc fail trước solve/render. Scheduling tài nguyên là
một policy riêng, không được trộn với giới hạn số tờ.

### ESKO-CUT-01 — P2 — PDF route bỏ registration-mark metadata

**Bằng chứng:** `TRACED + PROBE`; tác động máy cắt là `PROOF GAP`

Đường live `cut_export/api.py:203` gọi `build_cut_model_from_pdf()`. Hàm này luôn truyền
`marks=[]` tại `cut_export/pdf_source.py:83-97`, dù profile Yuty mặc định dùng
`registration.mode=onboard_frame`. Fixture có layer `Marks_Model_1` tại
`test_cut_layer_extractor.py:48-53`, nhưng extractor chỉ lấy cutline; emitter khi không có
frame dùng nguyên MediaBox làm FSIZE.

Probe fixture thật `corel_cut_sample.pdf`:

```text
paths=75, marks=0, frame=None
sheetMm=(325.0, 400.001)
header='IN FSIZE13000,16000 ... TB26,13000,16000'
```

**Tác động đã xác nhận:** route PDF hiện không thể đưa dấu canh vào `CutModel`, nên profile
onboard-frame rơi về FSIZE theo full sheet. Chưa có fixture end-to-end PDF nesting có marks,
byte/vendor oracle hoặc thử cắt thật để kết luận FSIZE này làm lệch registration vật lý; tác
động đó chưa được gán severity P1.

**Gate đóng:** trích/nhận diện tâm dấu canh từ artifact hoặc manifest authoritative; preview
và command stream phải dùng cùng frame; có fixture PDF → marks → FSIZE, byte oracle Yuty và
ít nhất một đối chiếu vendor hoặc thử máy.

### ESKO-NEST-05 — P2 — `Tem/tờ` dùng tổng placement toàn job

**Bằng chứng:** `TRACED + AUTO`

`session_capacity()` tự mô tả là số “Tem/tờ” nhưng trả global
`manifest.stats.placedCount` tại `nesting_preview_session.py:204-208`. Preview chỉ dựng
cells của `sheetIndex=0` tại `nesting_preview_capacity.py:377-419`, rồi lại trả global count
ở `totalItems` tại `:421-433`. UI dùng `totalItems` cho nhãn Tem/tờ và tính/report capacity.

**Tác động:** job nhiều tờ có thể hiển thị tổng số con toàn đơn như sức chứa một tờ. Nhãn
`Tem/tờ`, `previewCapacity` và `itemsPerSheet` chắc chắn sai semantic; `sheetsNeeded` có thể
vẫn đúng vì UI ưu tiên field riêng. Artifact placements không bị đổi.

**Gate đóng:** `totalItems` phải đếm placement của tờ preview; global placed count và
`sheetsNeeded` là field riêng, tên rõ nghĩa.

### ESKO-NEST-06 — P2 — Clearance hai trục bị nén thành `hypot`

**Bằng chứng:** `TRACED + AUTO`

Production contract và final validator giữ đúng clearance theo trục tờ. Nhưng candidate/NFP
dùng khoảng vô hướng bảo thủ `hypot(x,y)` tại `normalize.rs:352-365,461-467`.

**Tác động:** không sinh pose nguy hiểm, nhưng loại oan pose hợp lệ khi cả hai thành phần gap
có giá trị — kể cả `gapX == gapY > 0`, và đặc biệt khi dị hướng — nên giảm mật độ so với phép
Minkowski rectangle đúng hợp đồng. Đây là quality defect, không phải collision correctness
defect.

**Gate đóng:** candidate/NFP dùng clearance rectangle theo sheet axis; corpus dị hướng phải
không xấu hơn current score và vẫn qua final validator.

### ESKO-NEST-07 — P2 — Preview nối sai topology nhiều ring/hole

**Bằng chứng:** `TRACED`

Backend giữ mỗi ring riêng trong `diePolylines`; frontend gọi `.flat()` rồi vẽ một
`<polygon>` tại `GridPreview.tsx:3050-3058`, tạo đoạn nối giả giữa outer và hole/ring rời.

**Tác động:** preview contour có lỗ có thể vẽ đường chéo giả; artifact CUT vẫn đúng.

**Gate đóng:** dùng SVG `<path>` nhiều subpath hoặc nhiều polygon, giữ fill-rule/topology;
thêm screenshot/pixel test outer + hole.

### ESKO-NEST-08 — P2 — `materialUtilization` không phải hao vật liệu contour CUT

**Bằng chứng:** `TRACED + AUTO`

Packing footprint được buffer/simplify ra ngoài tối thiểu 0,2 mm và bỏ holes tại
`nesting_source_geometry.py:331-404`; request solver/stats dùng footprint này. Rust
`effective_area_mm2()` tiếp tục coi outer là vật liệu đặc tại `normalize.rs:289-293`.

**Tác động:** metric utilization/waste có thể cao hơn diện tích contour cắt thật và không
thể so trực tiếp với số Minimum Waste của Esko. Chính comment benchmark trong code đã ghi
nhận trường hợp utilization tăng ảo khi footprint phình.

**Gate đóng:** công bố tách `packingFootprintUtilization` và `cutContourMaterialUtilization`,
hoặc dùng contour CUT làm metric báo cáo nhưng vẫn dùng footprint bảo thủ cho collision.

### ESKO-CUT-02 — P2 — `overcut_plu > 0` không được thực thi

**Bằng chứng:** `TRACED`; test tự động chỉ khóa fallback dual-head hiện hữu, không khóa
`overcut_plu > 0`

Profile công khai field `overcut_plu`, nhưng `_emit_path()` chỉ đóng đúng điểm đầu tại
`command_stream.py:140-161`; không có đoạn chạy quá mối nối. Cả ba profile dựng sẵn hiện đặt
`overcut_plu=0`, nên lỗi chỉ reachable với custom/profile nonzero.

Đường PDF cũng không có `tool_tags`/`block_ids`, nên dual-head emitter dùng fallback centroid-X
đã được tài liệu hóa và test tại `command_stream.py:90-117`. Audit chưa thấy assignment
authoritative tồn tại trong PDF/CutContour rồi bị làm mất; manifest-aware dual-head vì vậy là
capability/`PROOF GAP`, không được gộp thành defect metadata-loss.

**Tác động đã xác nhận:** cấu hình custom `overcut_plu > 0` không thay đổi command stream.
Không ảnh hưởng ba profile dựng sẵn hiện tại vì chúng đều đặt `0`.

**Gate đóng:** test command stream phải chứng minh overcut theo PLU trên contour kín hoặc
schema phải từ chối giá trị nonzero. Manifest-aware dual-head cần spec riêng trước khi thay
fallback centroid-X hiện hữu.

## 7. Capability gaps `[EXPECTED]` — không gọi là bug

1. **Lồng vào lỗ/jigsaw:** holes được giữ cho CUT nhưng packing coi outer là đặc. Chưa có
   inner-NFP cho hole như §4.5/§16.5.
2. **Continuous rotation production:** core hỗ trợ nhưng lane Tem/CNC khóa cardinal theo cổng
   rollout server-owned. Reflection là capability riêng và vẫn forbidden.
3. **Minimum Distinct Layouts/overrun:** true-shape chỉ có `quantity_fulfillment` và
   `autofill_single_sheet`, chưa có column generation/setup-cost objective. Lane
   `mixed_guillotine` có tolerance overrun riêng nhưng nằm ngoài audit sâu này.
4. **Reverso:** true-shape generic có cardinal 180° nhưng chưa có policy/pairing ưu tiên xen
   kẽ 0°/180° hoặc benchmark tương ứng. Các lane named-shape legacy đã có
   alternating/interlock 0°/180°, nên đây không phải capability thiếu trên toàn PrynX.
5. **Common-line/least-cuts:** emitter phát trọn từng contour, chưa gộp cạnh chung hoặc tối ưu
   hành trình kiểu Chinese Postman.
6. **Meta-heuristic:** portfolio deterministic hiện hữu nhưng không có GA/SA/Tabu hoặc beam
   nhiều layout state. Tài liệu Esko không đủ thẩm quyền để bắt buộc một thuật toán cụ thể.
7. **Postprocessor công nghiệp:** chưa có JDF/ACM/Kongsberg/Zünd native; hiện có
   Yuty/Skycut/generic HPGL + DXF/SVG/PDF.
8. **Sanitize input:** self-intersection/MultiPolygon được fail-closed thay vì Boolean cleanup.
   Đây là policy an toàn hiện tại; muốn repair phải có artifact/oracle riêng.
9. **Guillotine parity:** PrynX có lane riêng, đúng cách phân bài toán; audit này chưa chứng
   minh lane đó có recursive cut tree/DP tương đương Esko.

## 8. Findings cũ không còn đúng trên working tree hiện tại

### “Native chỉ dùng một lõi” — `[DISPROVED]`

Current tree đã nối hardware grant từ backend tới native, cold-miss NFP song song tại
`nfp_cache.rs:273-438`, và portfolio wave song song tại `multi_start.rs:180-281,667-763`.
Cold-miss chỉ tách việc khi có ít nhất hai unique cold key, worker >1 và đủ entry/byte budget;
không được diễn giải thành mọi lời gọi NFP đều song song.

Test current source:

- 5/5 parallel cold-miss NFP đạt;
- 3/3 portfolio deadline/cancel/determinism đạt;
- fixed-work giữ cùng kết quả với 1/2/4/8/15 worker.

Không được tái dùng kết luận “solver luôn tuần tự” từ báo cáo trước để mở finding mới.

### ESKO-NEST-02 (rút finding) — “Auto-route không handoff phiên preview” — `[DISPROVED ở mức AUTO]`

Current tree đã có `wants_true_shape_nesting = manual || route_true_shape` tại
`nup_true_shape_nesting.py:206-219`; `attach_preview_session_reference()` dùng đúng predicate
này tại `:807-830`. Regression `test_auto_route_optimal_tai_dung_phien` và
`test_preview_contract_thuc_te_den_route_va_process_con_khong_solve_lai` chứng minh
`optimal_auto + CUSTOM` gắn manifest/fingerprint và process con render mà không solve lại.

Residual cần khép ở acceptance, không phải finding handoff hiện hữu: lỗi attach trước khi
nhận dạng được preview identity vẫn fail-soft để process con solve, và `ValueError` trên
auto-route vẫn có thể fallback engine cũ tại `nup_engine.py:289-305`. Cần quyết định policy,
telemetry và chaos test cho hai nhánh này; không được nói normal path chắc chắn solve kép.

### Persisted manifest conflict cũ — `[CLOSED ở mức AUTO trên source]`

`_manifest_id()` nay dùng publication nonce server-owned, và regression
`test_manifest_cu_sau_restart_khong_ep_preview_moi_solve_lai_khi_export` đạt. Installed
artifact/runtime vẫn chưa được smoke, nên không tự nâng lên `RUNTIME`.

## 9. Kết quả verify

| Phạm vi | Kết quả |
|---|---:|
| Toàn bộ `imposition_core` | **347 passed, 2 ignored, 0 failed** |
| Backend entry/pipeline/CNC/preview/session/golden/finishing/pont/geometry | **192 passed, 1 warning, 0 failed** |
| Frontend routing true-shape/payload export/preview duplex | **104 passed, 0 failed** |
| Cut-export command stream/dual-head/registration/PDF source | **22 passed, 0 failed** |
| Probe CNC duplex | **Tái hiện simplex/none/false, không back page** |
| Probe quantity | **Tái hiện global→autofill và partial override làm rơi trang kế thừa** |
| Probe PDF→cutter | **75 path, 0 mark, frame=None, FSIZE theo full sheet** |

Không update golden. Không chạy full frontend suite/typecheck vì không sửa code; targeted Vitest
đã phủ ba file routing/payload/preview liên quan. Không build installer, không chạy Tauri runtime
và không cắt vật lý.

## 10. Roadmap đề xuất sau khi được duyệt

Mỗi lô tối đa năm file và phải verify xong trước khi sang lô sau.

### Lô A1 — Khép hợp đồng quantity

1. Map `targetQuantity`/per-page inheritance thành quantity hiệu dụng trước solve.
2. Giữ explicit zero và chỉ autofill khi không còn quantity dương sau kế thừa.
3. Đồng bộ preview/export translator dùng cùng hàm materialize quantity.
4. Thêm bridge tests global-only, partial override, zero và nhiều part.
5. Verify fulfillment manifest/artifact; không update golden hình học ngoài chủ đích.

### Lô A2 — Khép hợp đồng CNC duplex

1. Ghép cặp Front/Back, set `back_page_index`.
2. Map `duplex_mode`, `flip_edge`, `duplex_registration` ở preview và export.
3. Bổ sung `cncDuplexMarks` vào preview schema/payload.
4. Thêm bridge tests simplex/duplex, long/short edge và registration.
5. Tạo artifact Front/Back/Cut thật; không update golden ngoài chủ đích.

### Lô B — Khép proof gap handoff/fail-soft

1. Giữ nguyên predicate `manual || route_true_shape` và regression auto-route đang xanh.
2. Chốt policy khi attach lỗi trước lúc nhận dạng preview identity: fail-closed hay solve một
   lần có cảnh báo/provenance rõ.
3. Chaos test reference absent/miss/conflict và `ValueError`; không cho fallback legacy sau
   khi identity preview đã được cam kết.
4. Runtime auto-route phải ghi `solvedAgain=false` và pose record khớp preview.
5. Trace riêng predicate batch-capacity cũ ở `ImposerDashboard` trước khi nâng thành finding.

### Lô C — Fulfillment và số liệu UI

1. Chọn một nguồn sự thật cho `maxSheets` giữa API, schema, adapter và core.
2. Bỏ trần 200 hoặc preflight sớm với policy nghiệp vụ được công bố.
3. Tách `itemsOnPreviewSheet`, `placedTotal`, `sheetsNeeded`.
4. Tách metric footprint utilization khỏi cut-contour utilization.
5. Regression đơn >200 tờ và multi-sheet preview.

### Lô D — Hợp đồng Send to Cutter

1. Dựng fixture/oracle PDF → marks → frame → FSIZE trước khi kết luận tác động vật lý.
2. Viết spec riêng nếu sản phẩm muốn manifest-aware dual-head thay fallback centroid-X.
3. Hiện thực hoặc từ chối rõ `overcut_plu > 0`; profile dựng sẵn `0` giữ nguyên.
4. Thêm fixture PDF nesting + marks + dual-head.
5. Byte oracle Yuty/Skycut, đối chiếu vendor và smoke file/TCP mô phỏng.

### Lô E — Chất lượng sau P1

Ưu tiên clearance dị hướng đúng NFP/candidate, SVG nhiều ring và benchmark exact-layout.
Hole nesting, Minimum Layouts/overrun và Reverso policy cho true-shape, common-line cùng
postprocessor mới là feature lớn; phải có spec/acceptance riêng, không gộp vào lô sửa
correctness.

## 11. Acceptance gate trước khi mở release

| Gate | Điều kiện bắt buộc |
|---|---|
| Preview = export | Cùng canonical request/native identity/manifest/pose records; `solvedAgain=false` |
| Quantity | Global, partial override, zero và nhiều part đều fulfillment đúng |
| CNC duplex | Front/Back/Cut, mirror long/short, registration marks và report đúng |
| Fulfillment lớn | Đơn hợp lệ >200 tờ đủ số lượng hoặc bị preflight từ chối với lý do nghiệp vụ rõ |
| Correctness | 0 overlap, trong tờ, clearance X/Y, obstacle và quantity qua final validator |
| Cutter | Frame lấy từ marks thật; command stream khớp byte oracle/profile |
| Determinism | Fixed-work 1/2/4/8/15 worker giữ cùng canonical result |
| Hiệu năng | Đo cold P50/P95 + peak RSS trên tier `<8`, `8–15`, `>=16 GB`; máy mạnh dùng full grant |
| Runtime | Tauri dev + packaged installer smoke trên PDF CNC hai mặt thật; mở lại artifact và gửi file cắt thử |

## 12. Chốt duyệt

Báo cáo này hoàn tất **chốt 1** của workflow audit. Chưa có production source nào được sửa.
Nếu được duyệt, thứ tự khuyến nghị là **Lô A1 → A2 → C → B → D**, mỗi lô tối đa năm file
và có verify/artifact riêng trước khi tiếp tục.
