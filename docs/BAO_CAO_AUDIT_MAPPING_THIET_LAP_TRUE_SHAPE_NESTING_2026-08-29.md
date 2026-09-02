# BÁO CÁO AUDIT MAPPING THIẾT LẬP TRUE-SHAPE NESTING — 2026-08-29

**Trạng thái:** CHỜ DUYỆT — chỉ audit, chưa sửa mã nguồn<br>
**Phạm vi:** thiết lập Bình tem bế/Bình Bế Rớt CNC từ UI → preview/cache → payload export → route/guard → production adapter → Rust solver → manifest → writer/report<br>
**Baseline:** nội dung hiện tại của workspace `D:\pdfcompare` đang có nhiều file dirty/untracked; kết luận dựa trên nội dung live, không quy kết theo riêng `git diff`<br>
**Giới hạn lượt này:** chỉ tạo báo cáo này; không reset/clean/commit, không sửa source, test, snapshot hoặc artifact ngoài phạm vi

## 1. Kết luận điều hành

Mapping hiện tại **chưa hoàn toàn đồng nhất**. Phần lõi hình học đã có nền tảng tốt: khổ tờ, bốn lề, semantic contour, số lượng theo trang, căn cụm, vật cản ốc bế, provenance nguồn, Front/Back/CUT và clip artwork đều có đường dữ liệu production rõ. Tuy nhiên còn các lỗi xuyên tầng đủ để preview khác export hoặc làm artifact/report sai:

1. Preview true-shape làm rơi `targetQuantity` toàn cục.
2. Preview làm rơi `cncTwoSided` và `cncFlipEdge`, trong khi export có ghép Front/Back.
3. Predicate route frontend không cùng compatibility matrix với backend; preview có thể chạy true-shape nhưng export fallback legacy hoặc fail-closed.
4. `groupingStrategy=maximize_area` mang nhãn/nghĩa “Chia đều diện tích” ở lane cũ nhưng bị biến thành free global gang ở true-shape.
5. Report dùng số con của tờ 0 cho mọi tờ; tờ cuối không đều làm sai `labelsPerSheet` và `actualQty`; nhiều metadata được cho chọn nhưng không có producer.
6. CNC duplex đang vẽ ốc/pont trên Back, khác contract lane CNC cũ; dấu canh hai mặt thật sự lại chưa được true-shape hỗ trợ.
7. `gapX/gapY` được giữ đúng tới adapter/final validator nhưng Rust search co thành `hypot(x,y)`, loại bỏ pose hợp lệ và giảm mật độ.
8. `exportUniqueSheets`, override OCG và `saveByReport` chưa có consumer cuối đúng với kỳ vọng UI.

Không phát hiện P0 trong phạm vi này. Có các P1 cần xử lý trước khi mở rollout production rộng. Backend hiện có nhiều guard fail-closed nên phần lớn setting chưa hỗ trợ **không bị âm thầm chạy sai solver**; vấn đề lớn là preview/export parity, semantics bị đổi ở field được phép đi qua, và artifact/report sau solver.

## 2. Sửa kết luận về `bleed`

### 2.1. `bleed` có liên quan gì tới nesting hiện tại?

Trong contract true-shape hiện hữu, `bleed` **không phải packing clearance, không phải khoảng hở, không phải cut contour và không được dùng để nới footprint**.

Đường production thực tế:

```text
semantic contour đã resolve
  ├─ derive_packing_footprint(...) → hình solver dùng để xếp
  ├─ cut_contour                  → đường dao trên trang CUT
  └─ artwork_clip_path            → clip artwork khi paint Form
```

Bằng chứng:

- `backend/app/core/nesting_production_pipeline.py:360-445` dựng cả ba geometry từ semantic polygon; không đọc `bleed`.
- `backend/app/workers/imposition_pdf_form.py::_clip_stream()` phát toán tử clip `W n`; `paint_manifest_page_form()` paint theo thứ tự `q → clip → cm → Do → Q`.
- `backend/tests/test_nesting_imposition_render.py::test_artwork_nam_dung_pose_va_vung_lo_van_in_muc` khóa việc mực ngoài contour không tràn sang vùng không được phép.
- Probe OCG/Form và artifact writer cho thấy writer dùng source page đã pin + clip path, không lấy bbox cộng bleed.

Vì vậy kết luận cũ kiểu “true-shape quên cộng bleed vào footprint” là **DISPROVED**. Nếu cộng `bleed` vào contour packing lúc này sẽ tạo double-clearance hoặc giảm capacity không đúng contract, trong khi writer vẫn clip theo cut contour.

### 2.2. Điểm còn cần làm rõ nhưng chưa phải bug artifact

`bleed` vẫn xuất hiện trong frontend preview body/cache key và một số comparator/quality-gate legacy, nhưng không vào `ProductionNestingJobInput` hay `job_identity_key` true-shape. Đây là **identity/performance asymmetry bị nghi ngờ**, chưa có bằng chứng stale manifest hoặc artifact sai. Không được sửa bằng cách offset polygon; nếu dọn cần chuẩn hóa rõ `bleed=0/ignored` ở biên route/cache và có test chứng minh không đổi nghiệm production.

## 3. Luồng dữ liệu đã audit

```text
ImposerDashboard / state
  → GridPreview.shouldUseTrueShapeNesting
  → preview body + perViewLayoutFetchKey
  → PreviewLayoutRequest
  → settings_from_preview_request
  → build_true_shape_nesting_job(s)
  → ProductionNestingJobInput
  → build_imposition_render_bundle_v2
  → build_production_request
  → Rust mixed_nesting normalize/search/final validator
  → immutable manifest + preview session
  → nesting_imposition_render
  → Front / [Back] / CUT + pont + report

Export:
ImposerDashboard
  → ImpositionTab
  → processHandlers backendSettings
  → nup-start / nup_engine
  → route_true_shape + _unsupported_true_shape_reason
  → cùng build_true_shape_nesting_job(s)
  → handoff manifest preview nếu identity khớp
  → writer production
```

Các seam chính:

- Route frontend: `desktop/src/components/imposition-tools/trueShapeNestingRollout.ts` và `GridPreview.tsx:1284-1315`.
- Preview body/key: `GridPreview.tsx:1643-1775,1988-2407`.
- Export payload: `desktop/src/lib/processHandlers.ts:293-420`.
- Preview mapper: `backend/app/core/nesting_preview_capacity.py:53-164,225-345`.
- Backend route/guard/job: `backend/app/workers/nup_true_shape_nesting.py:99-354,390-789`.
- Production contract: `backend/app/core/nesting_production_pipeline.py:100-459` và `nesting_production_adapter.py:1433-1480,1670-1737,2069-2290`.
- CNC canonical bundle: `backend/app/core/nesting_imposition_bundle.py:700-813`.
- Rust normalization/search: `imposition_core/src/mixed_nesting/normalize.rs:379-489` và solver/validator cùng module.
- Writer/report: `backend/app/workers/nesting_imposition_render.py:419-504,736-973`.

## 4. Ma trận mapping đầy đủ

Quy ước:

- **ĐỦ:** field có reachability, canonicalization và consumer cuối phù hợp.
- **CHẶN AN TOÀN:** semantics chưa có, backend chặn/fallback thay vì silent-drop.
- **LEGACY-ONLY:** field thuộc lane lưới/cắt xén khác, không nên map cơ học sang true-shape.
- **BUG:** intent có thể bị mất, đổi nghĩa, lệch preview/export hoặc artifact sai.
- **DISPROVED:** giả thuyết lỗi đã bị bằng chứng bác bỏ.
- **OPEN:** chưa đủ artifact/probe để kết luận.

### 4.1. Hình học, số lượng và identity

| Field/nhóm | UI → preview/cache | Export → adapter/Rust | Writer/report | Kết luận |
|---|---|---|---|---|
| `sheetWidth`, `sheetHeight` | Có trong body và cache key | Validate dương; đi vào sheet/usable area | MediaBox theo sheet canonical | **ĐỦ** |
| `marginLeft/Right/Top/Bottom` | Có trong body/key, đổi pt↔mm tại biên | Đi vào usable rectangle; không cộng lại thành edge gap | Placement được trả về hệ tờ đầy đủ | **ĐỦ** |
| `align` | Có trong body/key | Đi vào job identity, production contract và rigid alignment trước final validate | Writer dùng pose authoritative | **ĐỦ** |
| `gapX`, `gapY` | Cả hai có trong body/key | Adapter giữ `clearance.partToPart.xMm/yMm`; Rust search lại dùng scalar `hypot` | Writer không thể khôi phục pose đã bị search loại | **BUG — MAP-NEST-07** |
| `bleed` | Có trong body/key | Không vào job/solver; quality-gate legacy có thể đọc | Artwork clip theo contour | **DISPROVED là geometry bug**; còn asymmetry cache mức thấp |
| `targetQuantity` | Frontend gửi và key có `tq` | Preview mapper làm rơi; export `_page_quantities()` đọc đúng | Export/report có thể khác preview | **BUG — MAP-NEST-01** |
| `targetQuantitiesByPage` | Có trong body/key | Mapper giữ; override hiện diện thắng global, kể cả 0 | Demand theo part tới solver/writer | **ĐỦ** |
| `detectedShapesByPage`, `detectedShapeParamsByPage` | Có trong body/key và quyết định CUSTOM/named | Sticker resolve semantic contour; CNC production detect server-owned một lần, không tin shape object client | Bundle ghim contour/source revision | **ĐỦ** |
| Crop/xóa/sắp/xoay trang viewer | `previewSourceKey` đổi; preview materialize working PDF khi cần | Export dùng working/materialized source tương ứng | Writer đọc snapshot đã pin | **ĐỦ qua source materialization**, không phải scalar Rust |
| `columns`, `rows` | Có cho lưới/manual | Không vào true-shape production input | Không có consumer | **LEGACY-ONLY** |
| `alternateRotation` | Có trong key/body nhưng predicate route không xét compatibility đầy đủ | Backend guard chặn active value | Không tới writer true-shape | **CHẶN AN TOÀN**, nhưng route parity thuộc MAP-NEST-03 |
| Miền xoay cardinal | Không có toggle true-shape độc lập; policy production là server-owned | Adapter canonicalize orientation policy; reflection cấm | Writer áp pose đã ký | **ĐỦ theo contract hiện tại**; không đồng nhất với `alternateRotation` |
| `maxSheets` | Không phải setting UI trực tiếp | Quantity path hard-cap `MAX_SHEETS_CEILING=200` | Có thể còn `unplaced` | **OPEN-01:** chưa artifact-test demand cần >200 tờ |

### 4.2. Cách dàn, grouping và các field lane cũ

| Field/nhóm | Hành vi true-shape hiện tại | Kết luận |
|---|---|---|
| `gridStrategy=optimal_auto` + CUSTOM | Frontend auto-route khi rollout mở; backend route lại theo predicate riêng | **ĐỦ ở baseline**, nhưng compatibility predicates chưa parity |
| Token `true_shape_nesting` | Dùng cho preview/manual; backend `_guard_scope()` fail-closed nếu intent không hỗ trợ | **ĐỦ** |
| `taskMode=nup` / sequential | Một job gang nhiều part | **ĐỦ** |
| `taskMode=step_repeat/sr` | Mỗi mẫu một job `step_repeat_single_sheet`, một tờ đại diện | Geometry **ĐỦ**; quantity/report metadata **BUG — MAP-NEST-05/06** |
| `layoutType=ratio_stack`, `cut_stacks`, `strict_ratio` | Không có field tương đương trong mixed-nesting; backend chặn/fallback | **CHẶN AN TOÀN / LEGACY-ONLY** |
| `groupingStrategy=maximize_area` | Backend cho qua nhưng production request không có grouping; solver free-gang toàn tờ | **BUG đổi semantics — MAP-NEST-04** |
| `groupingStrategy=none` ở N-up | Backend chặn dù đây có thể là tên tự nhiên cho free gang | **CẦN QUYẾT ĐỊNH SẢN PHẨM**, chưa được tự nới guard |
| `groupingStrategy=none` ở S&R | Được phép; mỗi job chỉ có một mẫu nên không tạo drift grouping | **ĐỦ** |
| `cluster_tile`, `clusterMode`, `clusterCount`, `clusterGap`, `clusterDistribution`, `clusterTileW/H`, `clusterCols/Rows`, `clusterSizingMode`, `clusterCombineMode`, `clusterNesting`, `tileGapX/Y` | Không có contract Rust tương đương; backend chặn intent active | **CHẶN AN TOÀN / LEGACY-ONLY**, route parity thuộc MAP-NEST-03 |
| `splitGap` | Khoảng giữa main/fill block của lưới, không phải part clearance | **LEGACY-ONLY**; không map sang `gapX/gapY` |
| `cutType=one_dao` | Cắt chữ nhật/1 dao; route và guard loại khỏi true-shape | **LEGACY-ONLY / CHẶN AN TOÀN** |
| `fillBlockGap`, `dieSizeMode`, `dieOffsetMm` | Chỉ có nghĩa cùng `one_dao` | **LEGACY-ONLY** |
| `page_sheet_mode` | Nguyên tấm decal, không phải true-shape | **LEGACY-ONLY / CHẶN AN TOÀN** |
| `layoutType=mixed_guillotine` | Dàn cắt xén chữ nhật | **LEGACY-ONLY / CHẶN AN TOÀN** |
| `cutBorder` / `cutBorderEnabled` | Backend guard active value; không có writer true-shape | **LEGACY-ONLY / CHẶN AN TOÀN**, route parity thuộc MAP-NEST-03 |
| `markType`, kích thước/style dấu xén, `marginMode`, `gripperMargin` | Capability Tem/CNC không dùng crop marks; trim canonical là `none` | **LEGACY-ONLY đúng nghiệp vụ**, không bịa mapping |

### 4.3. CNC, CUT, pont/ốc và duplex

| Field/nhóm | Preview | Export/contract | Artifact | Kết luận |
|---|---|---|---|---|
| `imposerMode=cnc` | Mapper giữ | `_tool_from_settings()` ưu tiên CNC trước `isDieCutMode` | Renderer CNC | **ĐỦ** |
| `cncTwoSided` | Frontend gửi/key có, mapper làm rơi | Export ghép Front `2n` → Back `2n+1`, chặn file lẻ | Front/Back/CUT | **BUG preview — MAP-NEST-02** |
| `cncFlipEdge=long/short` | Frontend gửi/key có, mapper làm rơi | Export dựng sheet frame phản xạ theo x/y | Back dùng frame canonical | **BUG preview — MAP-NEST-02** |
| `cncDuplexMarks` | Predicate preview không xét | Backend chặn khi active; job luôn `duplex_registration=False` | Writer chưa vẽ dấu canh hai mặt | **CHẶN AN TOÀN**, route parity và capability gap — MAP-NEST-03/08 |
| CNC `separateCutPage` | UI/export đang gửi `false` | `build_cut_spec` giữ false, nhưng bundle CNC cố ý thay bằng `ImpositionCutSpec()` mặc định `true`; adapter bắt CUT riêng | Simplex `[front,cut]`, duplex `[front,back,cut]` | **DISPROVED là artifact bug**; mismatch trung gian cần test xuyên lớp |
| CNC `pontsOnCutFile` | UI không serialize toggle CNC | Bundle canonical cố định `true` | CUT luôn có pont như contract | **ĐỦ theo contract cố định** |
| Sticker `separateCutPage` | Có body/key/payload | Đi qua render bundle | Quyết định Front-only hay Front+CUT | **ĐỦ** |
| Sticker `pontsOnCutFile` | Có body/key/payload | Đi qua render bundle | Quyết định pont trên CUT | **ĐỦ** |
| `pontType`, `pontConfig` | Có body/key | `build_pont_spec()` và `build_pont_obstacles()` tạo marks + fixed obstacles | Writer vẽ pont, solver né vùng ốc | **ĐỦ về dữ liệu** |
| Pont side CNC duplex | Không có toggle riêng | `_pont_sides()` chọn mọi `ARTWORK_SIDES`, thêm CUT nếu true | Pont xuất hiện cả Back | **BUG contract — MAP-NEST-08** |
| `cutStyle` | UI chưa có control riêng | `build_cut_style_spec()` dùng mặc định CMYK Magenta 0,25 mm | Writer stroke CUT theo spec | **MẶC ĐỊNH CÓ CHỦ ĐÍCH**, không phải setting bị rơi |

### 4.4. Report, artifact và OCG

| Field/nhóm | Mapping hiện tại | Kết luận |
|---|---|---|
| `reportDisplay.enabled`, `fieldOrder`, các `showX` | `build_artifact_options()` lọc đúng field bật/tắt | **ĐỦ** |
| `customText`, `removeDiacritics` | Đi vào bundle và `nup_report.build_report_string()` | **ĐỦ** |
| `position`, `offsetX`, `offsetY`, `fontSize`, `centered` | Đi vào placement spec và stamp | **ĐỦ** |
| `reportMaterial`, `reportLamination`, `reportLaminationSides`, `reportOrderCode` | Có preview/export payload, bundle và report consumer | **ĐỦ** |
| `labelsPerSheet`, `actualQty`, `sheetCount` | `_report_text()` luôn lấy placement `sheetIndex=0`, rồi dùng cùng text cho mọi trang in | **BUG — MAP-NEST-05** |
| S&R quantity trong report | Quantity chỉ chọn mẫu trước khi tách single-sheet job; job/report không giữ demand gốc | **BUG — MAP-NEST-05/06** |
| `identifier`, `dimensions`, `modeLabel` | UI có thể chọn nhưng `_report_text()` không truyền nguồn tương ứng | **BUG metadata — MAP-NEST-06** |
| `labelName` | True-shape thường rỗng, không có fallback `Trang N` như nhiều nhánh legacy | **BUG/UX — MAP-NEST-06** |
| `cutFileRef` | Không thấy producer ở cả true-shape lẫn lane lưới | **PLACEHOLDER CROSS-PRODUCT**, không quy riêng regression true-shape |
| `gangCount` | True-shape dùng `len(parts)`; một part hiện `1 mẫu` | **OPEN-02:** cần chốt semantics sản phẩm trước khi sửa |
| `exportUniqueSheets` | Có trong payload, bundle và render identity | Writer vẫn lặp toàn bộ `sheet_count`, không đọc option | **BUG — MAP-NEST-09** |
| `hiddenOcgLayerIds` | UI dùng cho raster preview; export true-shape guard non-empty | Không có materialization override ở writer/legacy fallback | **BUG capability — MAP-NEST-10**; source default ON/OFF vẫn được giữ đúng |
| `saveByReport` | Backend guard true-shape nhưng không có consumer legacy tương ứng | Lưu file thật nằm ở `autoSavePrint/savePrintConfig` frontend | **DISPROVED giả định legacy hỗ trợ; dead/stale contract — MAP-NEST-11** |
| Report stamp failure | True-shape xóa artifact và fail-closed; legacy có nhánh chỉ log | **ASYMMETRY có chủ đích an toàn**, không hạ thành bug mapping trong audit này |

### 4.5. Cache/session identity

| Tình huống | Hiện trạng | Rủi ro |
|---|---|---|
| `targetQuantity` đổi | Frontend cache key đổi, nhưng preview mapper bỏ field | Hai key khác có thể chạy cùng effective preview job; export identity khác và không handoff được manifest |
| CNC simplex ↔ duplex/flip | Frontend key đổi, mapper bỏ duplex/flip | Preview solve simplex; export solve duplex, có thể coi Back là part độc lập ở preview |
| Report/CUT/pont options | Đã được đưa vào render bundle/session identity | **Đúng**; đổi finishing không tái dùng manifest sai spec |
| `exportUniqueSheets` | Làm đổi identity nhưng writer hiện cho cùng kiểu lặp sheet | Identity phân biệt hai artifact option chưa có hiệu lực |
| `bleed` | Có frontend key nhưng không vào production identity | Lãng phí recompute hoặc asymmetry; chưa có stale artifact |
| hidden OCG/save/CNC marks/cutBorder | Predicate/key/payload preview không cùng backend guard | Preview true-shape có thể không đại diện export |
| CNC CUT `false → true` | Bundle canonicalize trước adapter/identity | Artifact đúng; caller trực tiếp vẫn cần test khóa normalization |

## 5. Findings đã xác nhận

### MAP-NEST-01 — P1 — Preview làm rơi `targetQuantity` toàn cục

**Reachability:** `GridPreview` gửi `target_quantity`; UI có input số lượng chung và key `tq`.<br>
**Consumer đúng ở export:** `nup_true_shape_nesting._page_quantities()` đọc `targetQuantity`, merge với override theo trang.<br>
**Lỗ:** `settings_from_preview_request()` không tạo `targetQuantity` camelCase, chỉ giữ `targetQuantitiesByPage`.

Probe runtime trong bộ nhớ:

```json
{
  "input": {"target_quantity": 37, "target_quantities_by_page": {"0": 11}},
  "output": {"targetQuantity": "<ABSENT>", "targetQuantitiesByPage": {"0": 11}}
}
```

**Tác động:** preview có thể chuyển từ quantity fulfillment sang autofill hoặc tính demand khác export; session preview không khớp export nên export solve lại. Override theo trang không bị lỗi này.

### MAP-NEST-02 — P1 — Preview làm rơi CNC duplex và cạnh lật

**Reachability:** `GridPreview` gửi `cnc_two_sided`, `cnc_flip_edge`; cache key có `c2/cfe`.<br>
**Export:** `processHandlers` gửi `cncTwoSided/cncFlipEdge`; backend ghép Front/Back server-owned và dựng frame long/short.<br>
**Lỗ:** preview mapper không tạo hai field camelCase.

Probe runtime:

```json
{
  "input": {"cnc_two_sided": true, "cnc_flip_edge": "short"},
  "output": {"cncTwoSided": "<ABSENT>", "cncFlipEdge": "<ABSENT>"}
}
```

**Tác động:** preview có thể xếp toàn bộ trang, kể cả trang Back, như các mẫu simplex độc lập; export lại ghép cặp và mirror. Đây là mismatch hình học/artifact trực tiếp, không chỉ UX.

### MAP-NEST-03 — P1 — Compatibility matrix frontend/backend không song ánh

`shouldUseTrueShapeNesting()` chỉ nhận nhóm tool/mode/layout cơ bản và CUSTOM. Backend `_unsupported_true_shape_reason()` còn kiểm ratio/cọc, grouping, cluster, alternate rotation, cut border, hidden OCG, save-by-report và CNC duplex marks. Preview request/schema/mapper cũng không giữ đầy đủ các field này.

Đã probe backend:

- baseline → không có lý do chặn;
- `ratio_stack`, `strict_ratio`, N-up `groupingStrategy=none`, `cncDuplexMarks=true`, non-empty `hiddenOcgLayerIds`, `saveByReport=true` → bị chặn/fallback.

**Tác động:** preview có thể công bố true-shape nhưng export auto-route về legacy; token thủ công có thể báo lỗi muộn. Backend đang an toàn hơn frontend, nhưng người dùng không nhận đúng “what you see is what you print”.

### MAP-NEST-04 — P1 — `maximize_area` đổi nghĩa thành free global gang

- UI label là “Chia đều diện tích”.
- Lane legacy `nup_engine.py` chia chiều cao/diện tích tờ thành vùng cho từng loại.
- Backend cho `groupingStrategy=maximize_area` đi true-shape.
- `ProductionNestingJobInput`, request adapter và Rust model không có grouping field; mọi part được gang tự do trên cùng usable sheet.

Đây không phải field legacy bị chặn mà là **intent được phép đi qua rồi bị đổi nghĩa**. Không nên vá bằng tên hiện tại. Cần quyết định sản phẩm: thêm intent `free_gang` rõ ràng, hoặc triển khai constraints giữ đúng “chia đều diện tích”.

### MAP-NEST-05 — P1 — Report sai trên sheet không đồng đều và mất demand S&R

`_report_text()` đếm placement ở tờ 0 làm `items_per_sheet`, truyền `requested_qty=len(all placements)` rồi `compute_report_data()` suy `actualQty` theo layout đại diện. `_stamp_report()` dùng cùng chuỗi cho mọi trang in.

Probe manifest hai tờ có số placement `[3,1]`:

```text
SL/tờ: 3 - SL thực: 6 - Số tờ: 2
```

Tổng placement thật là `4`, không phải `6`; tờ thứ hai cũng không có 3 con. S&R còn tách mỗi mẫu thành job autofill và bỏ demand khỏi job, nên report không thể khôi phục số lượng yêu cầu ban đầu.

**Yêu cầu sửa:** dựng report theo từng physical sheet; tách `requestedQty`, `placedQty`, `itemsOnThisSheet`, `runCount`; giữ demand metadata qua S&R bundle/session thay vì suy từ placements.

### MAP-NEST-06 — P2 — Metadata report chưa có producer đầy đủ

`identifier`, `dimensions`, `modeLabel` được cho chọn nhưng `_report_text()` không truyền giá trị; `labelName` thiếu fallback `Trang N`; `cutFileRef` không có producer ở cả hai lane; `gangCount=len(parts)` chưa chắc cùng nghĩa nghiệp vụ với UI.

Phân loại:

- **Confirmed true-shape gap:** `identifier`, `dimensions`, `modeLabel`, fallback `labelName`.
- **Cross-product placeholder:** `cutFileRef`.
- **Cần quyết định:** `gangCount` cho one-part/S&R.

Không được tự bịa metadata từ filename nếu chưa chốt provenance và text hiển thị.

### MAP-NEST-07 — P1 — `gapX/gapY` dị hướng bị co thành scalar bảo thủ

Adapter giữ đúng hai trục trong `productionContract.clearance.partToPart`. `normalize.rs` lại dùng `gap.x_mm.hypot(gap.y_mm)` cho candidate/NFP. Final validator vẫn kiểm clearance sheet-axis đúng nên **không tạo overlap nguy hiểm**, nhưng search loại pose hợp lệ.

Probe native:

- Tờ `31×11`, part `10×10`, clearance `(x=0,y=10)` → solver chỉ đặt `2`.
- Clearance `(0,0)` → đặt `3`.
- Manifest ba pose nằm ngang được native `_validate_manifest_with_native()` chấp nhận với `(0,10)`.

Đây là bằng chứng động rằng density bị giảm vì scalarization, không còn là nghi ngờ.

### MAP-NEST-08 — P1 — Pont-side CNC duplex khác contract lane cũ

Probe `_pont_sides()`:

```text
pontsOnCutFile=False → ['back', 'front']
pontsOnCutFile=True  → ['back', 'cut', 'front']
```

Lane CNC cũ vẽ pont/ốc trên Front + CUT; dấu canh hai mặt là feature riêng vẽ trên Front + Back. True-shape hiện trộn hai khái niệm: pont mặc định lan sang Back, trong khi `cncDuplexMarks` thật sự bị guard và `duplex_registration=False`.

Cần artifact test cho simplex/duplex, long/short flip và từng side trước khi sửa. Không được chỉ bỏ Back mà không khóa registration contract.

### MAP-NEST-09 — P2 — `exportUniqueSheets` vào identity nhưng writer không dùng

Option được serialize, canonicalize và băm trong render bundle. Writer vẫn `for sheet_index in range(sheet_count)` và không đọc `artifactOptions.exportUniqueSheets` khi quyết định số trang.

- CNC/autofill hiện có guard bắt buộc true nên option gần như invariant.
- Sticker quantity fulfillment cho phép variation; tại đây toggle có thể làm đổi identity nhưng không đổi artifact multiplicity.

Cần chốt semantics “unique layout template” so với “physical run sheets” trước khi code dedup; không được đơn giản lấy sheet 0 vì last sheet có thể khác.

### MAP-NEST-10 — P2 — Override OCG của người dùng chưa được materialize

Writer Form và lane `pdf_ops` giữ đúng trạng thái OCG mặc định từ source. Probe source có layer mặc định OFF:

```text
ON=[]
OFF=['Artwork Layer']
```

Lỗi chỉ nằm ở **override UI** `hiddenOcgLayerIds`: danh sách này chủ yếu tác động raster preview, true-shape guard non-empty, còn fallback legacy cũng không materialize lựa chọn vào source xuất. Store chỉ có array, không có `touched/provenance`; `[]` không phân biệt “chưa chạm, giữ default” với “người dùng yêu cầu hiện tất cả”.

Không được sửa bằng cách bỏ guard. Cần materialize upstream và thêm trạng thái touched/provenance để bảo toàn default-OFF.

### MAP-NEST-11 — P2 — `saveByReport` là contract stale, không phải capability legacy

Không có backend consumer ngoài true-shape guard. Chức năng lưu file thật chạy ở frontend qua `autoSavePrint/savePrintConfig`, `savePrintFiles.ts` và `printFileNaming.ts`. Vì vậy fallback legacy do `saveByReport=true` cũng không thực thi ý định boolean này.

Hướng đúng là deprecate field hoặc định nghĩa lại quanh `savePrintConfig`; không mô phỏng một capability backend legacy không tồn tại.

### MAP-NEST-12 — P2 — Auto-route có thể che lỗi adapter bằng fallback legacy

`ProductionAdapterError` kế thừa `ValueError`; auto-route bắt `ValueError` quanh true-shape rồi log/fallback. Manual token fail-closed, nhưng auto-route có thể biến một regression contract tương lai thành “vẫn ra file nhưng bằng engine khác”. Mismatch CNC `separateCutPage` hiện **không kích hoạt lỗi** vì bundle canonicalize đúng trước adapter, nhưng kiểu catch này làm giảm observability và có thể che finding mới.

Nên chỉ fallback cho lỗi compatibility/quality đã phân loại; lỗi production adapter/manifest contract phải có mã riêng và không bị nuốt.

## 6. Các giả thuyết đã bác bỏ hoặc capability legacy-only đúng

1. **“Bleed phải nới footprint” — bác bỏ.** Contract hiện dùng semantic contour và clip artwork; nới theo bleed sẽ giảm capacity sai.
2. **“CNC `separateCutPage=false` làm mất CUT” — bác bỏ.** Bundle CNC server-owned canonicalize thành `separatePage=true`, output `[front,cut]` hoặc `[front,back,cut]`; adapter pass ở cả simplex/duplex.
3. **“OCG default OFF bị writer bật lại” — bác bỏ.** Form writer giữ `/ON` và `/OFF`; chỉ override UI chưa được materialize.
4. **“`saveByReport` đã hoạt động ở legacy” — bác bỏ.** Không có backend consumer tương ứng.
5. `splitGap` không phải clearance true-shape.
6. `fillBlockGap`, `dieSizeMode`, `dieOffsetMm` thuộc `one_dao`.
7. `markType`, crop marks, `marginMode`, `gripperMargin`, `cutBorder` thuộc cắt xén/lane khác; Tem/CNC không nên nhận cơ học.
8. `columns/rows` thuộc manual/grid; true-shape auto route không dùng.
9. Ratio/cut-stack/cluster/alternate rotation chưa có semantics mixed-nesting; giữ fail-closed là đúng cho tới khi có contract và test.
10. `cutFileRef` chưa có producer toàn sản phẩm, không phải regression riêng true-shape.

## 7. Bằng chứng test và probe

### 7.1. Test đã chạy, đều read-only

| Lệnh/phạm vi | Kết quả |
|---|---|
| `pytest tests/test_nesting_auto_route_custom.py tests/test_nesting_imposition_render.py -q` | **78 passed**, 1 warning |
| `npm run test -- --run src/components/imposition-tools/trueShapeNestingRollout.test.tsx` | **34 passed** |
| `cargo test --test mixed_nesting_nfp_validator clearance_di_huong_duoc_do_trong_sheet_space_sau_pose` | **1 passed** |
| `cargo test --test mixed_nesting_nfp_validator normalize_production_giu_identity_obstacle_va_inset_edge_clearance` | **1 passed** |
| Ba test Form/OCG, đổi point→mm và khóa preview settings/export | **3 passed** |

Hai test Rust được chạy riêng vì Cargo chỉ nhận một filter mỗi lần. Không claim full backend green: full suite trước đó từng timeout ở khoảng 84%; lượt audit này chỉ dựa trên targeted suites nêu trên.

### 7.2. Probe động

| Probe | Kết quả |
|---|---|
| Preview mapper | Làm rơi `targetQuantity`, `cncTwoSided`, `cncFlipEdge`; giữ quantity theo trang |
| Report non-uniform | `[3,1]` placement → report `SL/tờ 3`, `SL thực 6`, tổng thật 4 |
| Pont side CNC | Back luôn được chọn cùng Front; CUT phụ thuộc flag |
| Gap dị hướng | Solver mất pose thứ ba nhưng final validator chấp nhận layout ba pose |
| OCG source default OFF | `/ON=[]`, `/OFF=['Artwork Layer']` |
| CNC CUT canonicalization | UI/build cut false → bundle true; simplex/duplex đều pass adapter với output sides đúng |

## 8. Mức ưu tiên

| Ưu tiên | Finding | Lý do |
|---|---|---|
| P1-A | MAP-NEST-01, 02 | Preview trực tiếp sai intent số lượng/duplex và không thể handoff đúng manifest |
| P1-B | MAP-NEST-03 | Route parity là hàng rào chung; nếu chưa sửa, mọi capability sau vẫn có thể preview/export lệch |
| P1-C | MAP-NEST-04 | Field được phép chạy nhưng đổi nghĩa, nguy hiểm hơn field bị chặn rõ |
| P1-D | MAP-NEST-05 | Report sản xuất sai số lượng trên tờ không đều/S&R |
| P1-E | MAP-NEST-08 | Sai side của dấu trên artifact CNC duplex |
| P1-F | MAP-NEST-07 | Mất mật độ đã có repro native; không phải chỉ tối ưu vi mô |
| P2 | MAP-NEST-06, 09, 10, 11, 12 | Metadata/capability/observability; cần sửa nhưng không gộp liều vào lô geometry |

## 9. Kế hoạch sửa đề xuất — mỗi lô không quá 5 file

Đây mới là kế hoạch xin duyệt, **chưa phải lệnh triển khai**. Mỗi lô phải đọc lại current contents, thêm/điều chỉnh test đúng behavior, verify xong mới sang lô sau.

### Lô A1 — Preview giữ đủ quantity và CNC duplex intent

Tối đa 4 file:

1. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
2. `backend/app/core/nesting_preview_capacity.py`
3. `backend/tests/test_nesting_preview_capacity.py`
4. test GridPreview CNC/quantity hiện hữu phù hợp trong `desktop/src/components/imposition-tools/sections/`

Acceptance: preview mapper giữ global/per-page quantity, duplex và flip; preview/export tạo cùng effective job identity; simplex không bị biến thành duplex.

### Lô A2 — Một compatibility matrix cho route preview/export

Tối đa 5 file:

1. `desktop/src/components/imposition-tools/trueShapeNestingRollout.ts`
2. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
3. `backend/app/workers/nup_true_shape_nesting.py`
4. `desktop/src/components/imposition-tools/trueShapeNestingRollout.test.tsx`
5. `backend/tests/test_nesting_auto_route_custom.py` hoặc `test_nup_true_shape_nesting_entry.py`

Acceptance: cùng bảng ca active/inactive cho ratio, grouping, cluster, alternate rotation, cut border, OCG, save, CNC marks; preview không chạy true-shape khi export chắc chắn fallback. Adapter contract error không bị coi là compatibility fallback.

### Lô B — Report theo từng physical sheet và metadata có provenance

Tối đa 5 file:

1. `backend/app/workers/nesting_imposition_render.py`
2. `backend/app/workers/nup_nesting_finishing.py`
3. `backend/app/workers/nup_true_shape_nesting.py`
4. `backend/tests/test_nesting_imposition_render.py`
5. `backend/tests/test_nesting_finishing_parity.py` hoặc test session handover liên quan

Acceptance: sheet `[3,1]` in đúng text riêng; requested/placed/actual không suy sai; S&R giữ demand; metadata không có nguồn phải ẩn hoặc fail rõ, không in chuỗi rỗng giả.

### Lô C1 — Contract side pont/CUT CNC

Tối đa 4 file:

1. `backend/app/workers/nesting_imposition_render.py`
2. `backend/app/core/nesting_imposition_bundle.py` nếu cần khai side policy server-owned
3. `backend/tests/test_nesting_imposition_render.py`
4. `backend/tests/test_nesting_production_lifecycle.py`

Acceptance artifact: simplex Front/CUT, duplex Front/Back/CUT; pont đúng side; CUT luôn riêng; không report/CUT lẫn side.

### Lô C2 — Dấu canh CNC duplex long/short

Tối đa 5 file, tách khỏi C1 vì invariant khác:

1. `backend/app/workers/nup_true_shape_nesting.py`
2. `backend/app/core/nesting_imposition_bundle.py`
3. `backend/app/core/nesting_production_adapter.py`
4. `backend/app/workers/nesting_imposition_render.py`
5. một file artifact test CNC duplex

Acceptance: `cncDuplexMarks` có contract thật hoặc tiếp tục bị ẩn/chặn đồng nhất; test đo vị trí Front/Back cho long và short flip.

### Lô D — OCG touched/provenance và materialization

Tối đa 5 file sau khi chốt UX:

1. `desktop/src/stores/useWorkspaceStore.ts`
2. component điều khiển OCG hiện hữu
3. seam materialize working PDF dùng chung preview/export
4. backend/source resolver hoặc writer chỉ nếu materialization frontend không đủ
5. test OCG default-OFF + explicit show/hide

Acceptance: phân biệt untouched với explicit show-all; source default OFF vẫn OFF; preview/export dùng cùng bytes đã materialize.

### Lô E — Gap hai trục xuyên candidate/NFP

Tối đa 4 file trong `imposition_core`:

1. `imposition_core/src/mixed_nesting/normalize.rs`
2. module candidate/NFP thật sự tiêu thụ scalar clearance
3. validator/contract chỉ khi cần giữ một SSOT
4. `imposition_core/tests/mixed_nesting_nfp_validator.rs`

Acceptance: repro `(0,10)` đặt được ba part nằm ngang; `(10,0)` đối xứng theo trục; final validator vẫn chặn overlap thật; isotropic cases không hồi quy. Không hard-cap chất lượng hay worker vô điều kiện.

### Lô F — `exportUniqueSheets`

Tối đa 3 file:

1. `backend/app/workers/nesting_imposition_render.py`
2. bundle/adapter contract nếu cần biểu diễn run count/unique layout
3. `backend/tests/test_nesting_imposition_render.py`

Phải chốt trước: dedup theo layout fingerprint hay xuất một representative + report run count. Không dùng so sánh hình học gần đúng sau render.

### Lô G — Deprecate/redefine `saveByReport`

Tối đa 4 file frontend/backend state/payload/test liên quan. Ưu tiên bỏ boolean stale và dùng một cấu hình `savePrintConfig` authoritative; không thêm consumer backend giả.

### Lô H — Grouping semantics sau quyết định sản phẩm

Chưa triển khai cho tới khi chọn một trong hai:

1. **Free gang:** thêm tên/intent UI rõ, không tái dùng `maximize_area`.
2. **Chia đều diện tích:** bổ sung zone/constraint production và solver test tương ứng.

Nếu chọn cả hai, phải chia thành ít nhất hai lô contract + solver; không nhét vào lô route parity.

## 10. Quyết định cần người dùng duyệt

1. Có duyệt thứ tự **A1 → A2 → B → C1**, rồi mới sang E/D/F/G không?
2. Với grouping, sản phẩm muốn:
   - free global gang;
   - chia đều diện tích đúng như label hiện tại;
   - hay cho người dùng chọn cả hai bằng hai intent riêng?
3. Report trên tờ cuối không đều cần in:
   - số con thực trên chính tờ đó;
   - số lượng yêu cầu toàn job;
   - số lượng đã đặt toàn job;
   - và run count riêng hay không?
4. `exportUniqueSheets=true` được hiểu là dedup layout giống hệt hay chỉ xuất một tờ đại diện cho mỗi recipe?
5. `saveByReport` có thể deprecate để hợp nhất vào `savePrintConfig` không?

## 11. Chốt quy trình

Báo cáo này là **chốt 1** của quy trình audit hai chốt. Không source nào được sửa trong pha này. Sau khi người dùng duyệt finding, thứ tự lô và các quyết định semantics ở mục 10, mới bắt đầu lô đầu tiên; mỗi lô tối đa 5 file và phải verify độc lập trước khi sang lô kế tiếp.


## 12. Nhật ký triển khai (cập nhật 2026-09-01)

Các lô A–F đã verify trước đó (xem lịch sử phiên). Mục này ghi ba chặng cuối: Lô G và các open item P2 còn lại. Trạng thái phân loại bằng ĐỌC CODE hiện tại, không suy từ mô tả cũ.

### Lô G — MAP-NEST-11: deprecate `saveByReport`, hợp nhất `savePrintConfig`

- **File**: `desktop/src/components/imposition-tools/types.ts`, `ImposerDashboard.tsx`, `ImpositionTab.tsx`, `desktop/src/lib/processHandlers.ts` (+ test `processHandlers.test.ts`).
- **Thay đổi**: export `SavePrintConfig` canonical có `autoSave`; job mới chỉ phát `savePrintConfig` (bỏ `saveByReport` khỏi preview/batch/execution, bỏ alias `autoSavePrint` khỏi job). `runProcessEngine` chuẩn hóa quyền ghi một lần: `autoSave = config.autoSave === undefined ? legacyAutoSavePrint === true : config.autoSave === true`, trim folder, canonical `false` thắng alias `true`, không serialize field lưu cục bộ sang backend. `saveByReport` thành no-op deprecated; backend guard giữ nguyên để cách ly client cũ; store persisted giữ một release.
- **Lý do**: `saveByReport` là contract stale không có writer thật (bác bỏ giả định legacy hỗ trợ); một nguồn quyền lưu authoritative tránh bật/tắt side effect trái ý người dùng.
- **Kiểm tra**: `processHandlers` 58/58, `trueShapeNestingRollout` 46/46, `recipeImpositionParams` 2/2, `useImposerSettingsStore.characterization` 21/21, `npm run typecheck` xanh, backend guard 50/50; semantic review APPROVED (`semantic-review/2026-09-01-102107-pr-11.md`).

### MAP-NEST-05/09/10 — RESOLVED ở các lô trước (xác nhận lại)

- **05** (report theo từng physical sheet + demand S&R): fix ở `nesting_imposition_bundle.py`, `nesting_production_adapter.py`, `nup_nesting_finishing.py`, `nesting_imposition_render.py`, `nup_true_shape_nesting.py` + test.
- **09** (`exportUniqueSheets`): `_render_sheet_plan`/`_sheet_recipe_key` đọc option, giữ representative đầu mỗi recipe; test render `sheet_count==3`.
- **10** (OCG provenance/materialization): `useWorkspaceStore.ts` provenance `untouched|explicit`, fence theo File+editGeneration+fileId (`useWorkingPdf.ts`, `ImpositionTab.tsx`, `LayerPanel.tsx`); semantic re-review 0 issue (`semantic-review/2026-09-01-060337-pr-0.md`), 37 test.

### MAP-NEST-12 — auto-route chỉ fallback lỗi đã phân loại

- **File**: `backend/app/workers/nup_true_shape_nesting.py`, `backend/app/workers/nup_engine.py` (+ test `test_nesting_dispatch_route.py`).
- **Thay đổi**: thêm taxonomy `TrueShapeAutoFallback` → `TrueShapeCompatibilityFallback` / `TrueShapeQualityFallback` (kế thừa `ValueError` để giữ map 422). Điểm compatibility (guard scope, tool ngoài phạm vi, thiếu contour CNC) và cổng chất lượng export phát signal này. Dispatch đổi `except ValueError` + denylist thành `except TrueShapeAutoFallback`: token thủ công luôn fail-closed; auto-route chỉ lùi legacy cho hai signal, còn mọi lỗi adapter/manifest/writer/pipeline và `ValueError` chưa phân loại mặc định thoát ra.
- **Lý do**: denylist bỏ sót `ManifestRenderContractError` và raw `ValueError` → giao artifact legacy khác preview và che regression. Allowlist đảo mặc định về fail-closed.
- **Kiểm tra**: `test_nesting_dispatch_route` baseline 2 fail/12 pass → 15/15 (thêm ca `unclassified`, `render`, và tách ca fallback theo signal); broader dispatch + handover + writer + auto_route 142→145 pass.

### MAP-NEST-06 — metadata report per-sheet cho true-shape

- **File**: `backend/app/workers/nesting_imposition_render.py` (+ test `test_nesting_imposition_render.py`).
- **Thay đổi**: writer điền `modeLabel` từ `renderBundle.flow.tool` (`_MODE_LABEL_BY_TOOL`: sticker→"Bế tem", cnc→"Bình bế rớt CNC"); `dimensions`/`identifier`/`labelName` fallback suy từ `part.pages.front.pageBoxesMm.trimBox` + `pageIndex` cho tờ MỘT mẫu (`str(page+1)`, `Trang N`, `"W x H mm"` qua `nup_report._format_report_mm`). Tờ gang nhiều mẫu để trống kích thước + identifier (khớp lane cũ `0.0`; số mẫu do `gangCount`). Không đổi report contract ở bundle/adapter nên không churn `renderBundleHash`/golden.
- **Lý do**: các field UI cho chọn nhưng writer trước đó hardcode `""`, khớp đúng provenance literal của lane lưới cũ thay vì bịa nguồn.
- **Kiểm tra**: 3 regression mới (tờ một mẫu, labelName tường minh không bị fallback đè, tờ gang trống dims/identifier); 16/16 report test; 145 test nesting (render + dispatch + auto_route + handover) pass; `py_compile` + `git diff --check` sạch.

### Ngoài phạm vi (không sửa trong đợt này)

- `cutFileRef`: placeholder cross-product, không có producer ở cả hai lane.
- `gangCount` semantics (OPEN-02) và `maxSheets>200` (OPEN-01): cần quyết định sản phẩm.
- MAP-NEST-04 (`maximize_area`) và MAP-NEST-07/08 (gap hai trục, dấu canh CNC) thuộc các lô hình học đã/đang xử lý riêng, không gộp.


### Re-audit 2026-09-01 §DIM-DIE — SSOT `DetectedShape.trim` (report ≠ viewer)

- **Triệu chứng đã đo trên runtime**: viewer hiển thị `45,3 × 52,3 mm`, trong khi report sau bản vá bbox contour vẫn in `45,4 × 52,9 mm`. Chênh `0,1/0,6 mm` bác bỏ giả định “bbox `cutContour` luôn bằng `DetectedShape.trim`”; đây không phải sai số làm tròn 0,1mm.
- **Trace nguồn số**:
  - Viewer (`LivePageFrame.tsx:6110/6124`) lấy `/imposition/detect-shape` → `die_detection.py` trả `DetectedShape.trim`, rồi đổi point sang mm.
  - `trim` được detector tính từ `visual_w/visual_h` của path đã chọn (`_sample_bezier_contour`, hoặc bbox nhóm path đã chọn).
  - `cutContour` production đi từ `DetectedShape.page_contour` → `resolve_cnc_source_geometry` → `ResolvedSourceGeometry.polygon`; `page_contour` được dựng qua `_same_color_group_poly`/`_path_items_to_polygon`, có phép hợp path và mật độ lấy mẫu Bezier khác. Hai đại lượng phục vụ hai mục đích và **không có bất biến bằng nhau**.
  - Seam làm mất SSOT nằm ở production pipeline: writer trước đây chỉ nhận polygon qua `ImpositionRenderPartSpec`, nên phải đo lại bbox từ artifact downstream thay vì dùng `trim` của detector.
- **Quyết định**: kích thước người dùng thấy ở viewer (`DetectedShape.trim`) là SSOT cho metadata report của cả Bình Tem Bế (`sticker_imposer`) và CNC (`cnc_imposer`). Không dùng `pageBoxesMm.trimBox` (khổ trang), không dùng bbox `cutContour` (hình production khác thuật toán), và không nhận mù kích thước do client gửi.
- **Sửa liên tầng**:
  - `nup_true_shape_nesting.py`: backend tự chạy `_detect_shapes_for_nesting` trên PDF nguồn cho cả Tem bế/CNC; `build_true_shape_nesting_job(s)` chuyển map detector tới `_assemble_nesting_job`, rồi gắn `DetectedShape` đúng trang vào `JobPartInput`.
  - `nesting_production_pipeline.py`: `_die_dimensions_mm` ưu tiên `DetectedShape.trim` server-side và đổi point→mm cho cả hai tool; chỉ caller cũ thật sự không có shape mới fallback bbox contour canonical.
  - `nesting_imposition_bundle.py` + `nesting_production_adapter.py`: thêm `part.dieDimensionsMm = {width,height}`, bắt buộc hữu hạn/dương ở builder và canonical adapter; field đi vào `renderBundleHash` vì nó làm thay đổi artifact report.
  - `nup_artwork.py`: cho phép field metadata đã biết nhưng không đưa nó vào phép biến đổi artwork. Bundle V2 cũ thiếu field vẫn đọc/render được.
  - `nesting_imposition_render.py`: report ưu tiên `dieDimensionsMm`; chỉ fallback bbox contour cho bundle V2 cũ không thể phục hồi `trim`. `identifier`/`Trang N` vẫn theo `pageIndex`; tờ gang nhiều mẫu vẫn để trống dimensions.
- **Regression đỏ→xanh bằng số thật ở tầng writer/bundle**: part có `dieDimensionsMm=45.3×52.3`, bbox `cutContour=45.4×52.9`, `trimBox=120×80`; code cũ trả `45.4 x 52.9 mm`, code mới bắt buộc trả `45.3 x 52.3 mm`. Regression liên tầng CNC giữ contour fixture `40×40mm` nhưng thay `DetectedShape.trim=45.3×52.3mm`; bundle giữ đúng `dieDimensionsMm`, contour không đổi và artifact vẫn render.

#### Re-audit 2026-09-01 §DIM-DIE-RUNTIME — đúng entrypoint Bình Tem Bế

- **Sai sót của lần vá đầu**: producer chỉ gọi detector khi tool là `cnc_imposer`; lane runtime thật của UI Bình Tem Bế gửi `isDieCutMode=true` nhưng không gửi `imposerMode=cnc`, nên `_tool_from_settings` chọn `sticker_imposer`. Vì `JobPartInput.detected_shape=None`, pipeline vẫn fallback bbox contour và report tiếp tục in `45.4 × 52.9 mm`. Kết luận “đã sửa runtime” trước đó là sai.
- **Regression xuyên entrypoint/artifact**: `test_report_tem_be_dung_trim_detector_khong_do_lai_bbox_contour` tạo PDF có contour `45.4×52.9mm`, mock detector trả trim `45.3×52.3mm`, chạy qua `run_true_shape_nesting` của `sticker_imposer` và bắt dữ liệu thật chuyển tới `stamp_reports_on_pdf`.
  - Trước bản sửa producer, regression đỏ đúng triệu chứng: `assert {0: '45.4 x 52.9 mm'} == {0: '45.3 x 52.3 mm'}`.
  - Sau bản sửa, report nhận `{0: '45.3 x 52.3 mm'}`; contour dùng cho solver/CUT vẫn giữ nguyên `45.4×52.9mm`.
- **Tương thích**: fallback bbox contour chỉ còn dành cho caller/bundle V2 cũ không có detector shape; entrypoint production Tem bế/CNC luôn tự detect từ PDF nguồn. Artifact/report đã tạo trước bản sửa không bị viết lại; phải tạo lượt bình/export mới để kiểm số mới.
- **Kiểm tra sau vá**: riêng `test_nup_true_shape_nesting_entry.py` đạt `66/66`; ma trận report/artifact + bundle/adapter + production/lifecycle + dispatch/auto-route + preview/session đạt `590/590`. Cảnh báo duy nhất là deprecation Pydantic đã có sẵn, không liên quan bản vá.
