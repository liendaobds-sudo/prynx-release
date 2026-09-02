# KẾ HOẠCH CHÍNH THỨC — NESTING TỰ DO CHO BÌNH TEM BẾ / CNC

**Ngày:** 2026-08-27
**Trạng thái:** Chờ duyệt; chỉ được thực hiện Lô 0 trước chốt duyệt tiếp theo
**Tên UI đề xuất:** “Nesting tối ưu theo đường bế”
**Strategy đề xuất:** true_shape_nesting

Tài liệu này là nguồn kế hoạch ưu tiên cao nhất và thay thế mọi bản nháp/đề xuất trước về cardinal-only, gang-only hoặc không áp dụng cho S&R.

## 1. Hợp đồng sản phẩm

Thêm đúng một lựa chọn vào **Cách xếp** của workflow hiện hữu. Không tạo tool/tab/wizard/luồng xuất mới.

| Công cụ | Bình trang / một mẫu / S&R | Dàn nhiều mẫu / gang |
|---|---:|---:|
| Bình Tem bế | Có | Có |
| Bình CNC | Có | Có |

Mapping code bắt buộc:

- taskMode="step_repeat" = Bình trang/S&R; submit thành layoutType="repeat".
- taskMode="nup" = Dàn nhiều mẫu/gang.

Khi chọn strategy mới:

- solver tự chọn vị trí và góc liên tục [0°,360°);
- không đọc/hiện lựa chọn xoay thủ công;
- mọi thiết lập còn lại, preview, submit và nơi xuất giữ workflow cũ;
- preview cuối và file xuất dùng cùng manifest; exporter không solve;
- strategy cũ giữ nguyên, làm baseline/fallback có ghi provenance.

UI chỉ thêm option cho sticker_imposer và cnc_imposer ở cả hai task mode, đồng thời ẩn/vô hiệu control hàng/cột/góc không còn ý nghĩa. Không đổi default optimal_auto và không hiện option ở N-Up thường, Booklet hoặc page_sheet.

## 2. Kết luận audit và seam tích hợp

Mixed Nesting hiện tại là tool/job/exporter độc lập. Không đưa nguyên luồng đó vào production.

Tái sử dụng:

- Rust geometry kernel, normalize polygon, NFP/IFP;
- candidate pose/free-angle transform;
- validator overlap/clearance;
- seed, score, manifest và refine hiện có.

Không dùng:

- tool/tab/capability Mixed Nesting làm entry của người dùng;
- nested /mixed-nesting/jobs trong job Imposition/CNC;
- standalone parser làm nguồn contour mặc định;
- exporter chỉ stroke CUT làm artifact sản xuất.

Standalone lab phải nằm sau internal/dev flag, không là workflow thứ hai cho người dùng production. Strategy mới dùng entitlement Tem bế/CNC hiện hữu, không phụ thuộc capability Mixed Nesting.

Kiến trúc đích:

~~~text
UI Imposition hiện hữu
→ true_shape_nesting
→ job Imposition/CNC hiện hữu
→ canonical geometry adapter
→ Rust mixed-nesting kernel
→ validator + baseline guard
→ immutable PlacementManifestV1
├─→ preview
└─→ renderer/exporter Tem bế hoặc CNC hiện hữu
~~~

Route mỏng. Job cha sở hữu heavy_job_scheduler grant. Không nested admission. Native CPU-bound nhả GIL. PDFium trong thread phải dùng pdfium_guard() đúng đoạn gọi; solver không giữ PDFium lock.

## 3. Hợp đồng canonical geometry

Quy ước normative, không còn là đề xuất:

- unit mm;
- origin trái-dưới;
- X sang phải, Y lên;
- góc dương CCW, normalize [0°,360°);
- solver không reflection/mirror;
- pt/px/top-down chỉ đổi tại adapter/render boundary đúng một lần.

Pose authoritative:

~~~text
p_sheet = R(theta) × (p_local - referencePoint) + (tx,ty)
G_i = T(tx,ty) · R(theta) · T(-referencePoint)
~~~

Manifest lấy referencePointMm, txMm, tyMm, rotationDeg làm SSOT. affineMm chỉ là derived data từ helper chung. Validator reject pose/affine mismatch vượt tolerance. Lô 0 chốt rounding, serialization precision và tolerance; không làm tròn góc về cardinal.

Mỗi PartDefinition tách:

| Trường | Ý nghĩa |
|---|---|
| cutContour | đường bế/CUT thật |
| artworkClipPath | miền artwork/bleed được phép vẽ |
| packingFootprint | vùng collision đã bao artwork và safety |

Invariant:

- painted/artworkClipPath phải nằm trong packingFootprint;
- cut, clip và footprint cùng canonical frame/reference point;
- footprint được tạo đúng một lần từ raw geometry + chính sách; không cộng bleed/kerf/safety lần nữa ở request hoặc solver;
- thiếu contour semantic thì chặn preflight, không bbox giả.

Clearance tách rõ:

- part–part clearance;
- part–sheet-edge clearance;
- part–obstacle clearance.

gapX/gapY theo trục tờ. Với góc tự do, anisotropic expansion phải diễn ra trong sheet-space sau khi áp pose, không pre-expand theo local axes rồi xoay. Có test gapX khác gapY ở góc bất kỳ.

Fixed obstacles gồm vùng ngoài usable sheet, boong/gripper, sheet-fixed marks và safety, CNC exclude_zones và keep-out khác.

Phân loại marks:

- sheet-fixed/dynamic sheet marks được materialize trước solve và đi vào obstacles;
- part-local marks đi theo G_i và phần painted/safety của chúng phải nằm trong packingFootprint;
- không tạo vòng phụ thuộc solve → marks → solve không có revision mới.

Hole/multipolygon dùng even-odd/winding thống nhất. V1 không cho đặt part vào hole của part khác nếu chưa có quyết định/test riêng.

partId/instanceId dựa trên source hash + page/design/candidate identity, không chỉ basename.

## 4. Reuse clip hiện hữu

Không viết pipeline clip song song. Nâng SSOT production:

- backend/app/workers/nup_clip_shape.py::build_die_clip_rings;
- out_clip_path, die_polylines_for_placement và transform_die_point trong nup_artwork.py;
- test_nup_clip_shape.py và test_nup_clip_shape_render.py.

Các helper/cache hiện dựa cardinal flags. Nâng lên rotationDeg/G_i và không fallback rectangle khi interlock.

## 5. Request, intent và immutable render bundle

NestingRequestV1 tối thiểu:

- schemaVersion, requestRevision, inputHash, layoutFingerprint;
- sheet, usable region, ba loại clearance, fixed obstacles;
- source hash, page/design identity, reference point và ba geometry;
- orientation=continuous_auto, reflection=false;
- deterministic search budget, emergency time limit, seed, restart plan;
- scheduler worker/RAM grant;
- sticker/cnc, single/gang, duplex metadata;
- layoutIntent.

Hai layoutIntent:

1. autofill_single_sheet: không có target quantity; đúng một tờ, tối đa placedCount.
2. quantity_fulfillment: có target; phủ đủ quantity rồi giảm sheetCount.

Không tạo quantity giả cho autofill.

Persist cùng manifest một content-addressed immutable PartDefinition/source bundle hoặc reference bất biến gồm:

- source content hash và revision;
- Front/Back/Cut page mapping;
- MediaBox/CropBox/TrimBox, page Rotate và source-to-canonical transform từng side;
- cut, clip, footprint và reference point;
- render/spot-color metadata cần thiết.

Exporter reject nếu source/bundle hash không khớp. Manifest không được chỉ lưu ID trỏ tới state mutable.

Canonical hash serialization phải định nghĩa thứ tự field/polygon/ring, numeric precision và normalization. layoutFingerprint phải khóa inputHash + strategy + solverConfigHash + engine/validator version + geometry constraints. Reuse cần exact manifestId và exact fingerprint, không chỉ revision.

## 6. PlacementManifestV1 và lifecycle

Manifest tối thiểu:

- manifestId, schemaVersion, requestRevision, inputHash, layoutFingerprint;
- engine/build/validator provenance;
- layoutIntent, seed, search budget, emergency timeout, stop reason;
- scheduler grant, restart/work units đã hoàn thành;
- baseline score, selected score, selectedCandidate;
- sheetCount, placedCount, unplacedCount khi có target;
- validation/tolerance summary;
- immutable source/PartDefinition bundle hashes;
- per-placement instanceId, partId, sheetIndex, authoritative pose và derived affine.

Validator:

- kiểm pose/affine consistency;
- tính lại score;
- kiểm quantity/one-sheet intent;
- kiểm overlap, painted containment, clearance, boundary và obstacles;
- kiểm source/page/geometry hashes.

Lifecycle:

~~~text
normalized request
→ baseline + smart search
→ validate candidates
→ deterministic select
→ persist final manifest + render bundle
→ preview from manifest
→ export exact manifestId
~~~

- Input đổi tăng revision/fingerprint; response cũ không ghi đè.
- Preview có final manifest đúng fingerprint thì submit reuse.
- Submit chưa có manifest thì job solve một lần, persist rồi render.
- Export chỉ load, hash-check và validate nhanh; không solve/fallback.
- Manifest stale trả lỗi rõ, đề xuất 409 LAYOUT_MANIFEST_STALE.
- Cancel không tạo final manifest.
- Instrument solver call count: preview rồi export cùng revision = 1.

## 7. Objective và baseline guard

Không tuyên bố global optimum; chỉ nói “kết quả tốt nhất tìm được trong ngân sách tìm kiếm đã ghi nhận”.

Autofill lexicographic:

1. đúng một tờ;
2. placedCount lớn nhất;
3. compactness tốt nhất;
4. deterministic tie-break.

Quantity-driven:

1. unplacedCount nhỏ nhất, production yêu cầu 0;
2. sheetCount nhỏ nhất;
3. compactness tốt nhất;
4. deterministic tie-break.

Baseline production hiện hữu phải được chuyển sang cùng manifest và validator:

- autofill: smart placedCount không thấp hơn baseline;
- quantity-driven: smart đủ quantity và sheetCount không lớn hơn baseline;
- objective chính bằng nhau mới so compactness;
- fallback baseline chỉ xảy ra trước preview và phải ghi rõ; export không đổi winner.

Compactness không dùng đơn thuần phần trăm diện tích khi quantity/sheet count đã bằng. Lô 0 chốt last-sheet envelope, continuous free region/fragmentation metric.

## 8. Deterministic search và solver quality

Fixed work/search budget là nguồn quyết định, không dùng thứ tự hoàn thành theo wall-clock:

- restart set và seed được xác định trước;
- merge tại stable barriers, sort theo score + restart index + manifest tie-break;
- thread completion order không đổi winner;
- emergency wall-clock timeout chỉ chọn kết quả ở barrier deterministic cuối hoặc baseline; không chọn partial state tùy lịch thread;
- manifest ghi completed work units và timeout status.

Yêu cầu nâng solver:

- NFP/IFP, sheet/obstacle contacts;
- critical angles + coarse-to-fine refinement;
- nhiều ordering/seeded permutations;
- multi-start/population thật;
- relocate/reinsert, rotate/slide/compact, swap;
- destroy-and-repair, move-chain;
- last-sheet elimination;
- cooperative cancel/progress.

Determinism bit-for-bit được kiểm khi cùng input/config/search budget; emergency timeout path phải cho cùng deterministic completed barrier/baseline theo contract.

## 9. Bốn flow và renderer

| Flow | taskMode | Part/intent |
|---|---|---|
| Sticker S&R | step_repeat | một part; autofill hoặc quantity |
| Sticker gang | nup | nhiều part + quantity |
| CNC S&R | step_repeat | một part; autofill hoặc quantity |
| CNC gang | nup | nhiều part + quantity |

Sticker giữ artwork/CUT/marks/report. CNC giữ Front/[Back]/Cut. Single/gang dùng cùng request/solver/manifest.

Artwork true-shape phải clip:

~~~text
save
apply CTM_side
apply even-odd artworkClipPath
draw source XObject
restore
~~~

Không xoay rectangle page rồi để nền đè nhau. Không raster hóa để né free-angle.

G_i luôn canonical part → physical FRONT sheet, det(G_i)=+1 và không chứa mirror.

~~~text
CTM_side = SheetFrame_side ∘ G_i ∘ SourcePageToCanonical_side
~~~

- SourcePageToCanonical_side xử lý page boxes, /Rotate, origin và registration source từng side.
- SheetFrame_side xử lý physical FRONT sheet sang output Front/Cut/Back, gồm Y-axis, output page origin, registration và phép lật vật lý nếu có.
- Back không mặc định M_sheet × G_i; phép lật chỉ là một thành phần của SheetFrame_back.
- Nâng imposition_parity.py từ flags lên affine; không negate angle/đổi x theo bbox/mirror polygon trong solver.

Artifact acceptance dùng landmark F-R-B-L, shape bất đối xứng, non-zero page origin và /Rotate; kiểm determinant kỳ vọng, reading direction, artwork/clip/CUT, Front/Back/Cut instance mapping, font/vector/transparency/spot color.

## 10. Scheduler, worker và phần cứng

heavy_job_scheduler phải cấp worker count + RAM budget theo từng job; kernel chỉ dùng grant đó.

- RAM <8 GB: giảm mạnh.
- RAM 8–<16 GB: giảm nhẹ.
- RAM ≥16 GB: không hard-cap vô điều kiện, nhưng vẫn tôn trọng grant khi nhiều heavy job đồng thời.
- Benchmark bắt buộc 1 job và 2 heavy job đồng thời để chứng minh không oversubscribe/OOM.
- Test GIL release và actual parallelism; không chỉ kiểm log plan.workers.

Không thêm [profile.release] vào Cargo.toml; LTO/codegen-units chỉ qua build_production.ps1.

## 11. Rollout và lỗi

- Missing contour, invalid/stale manifest, renderer unsupported: chặn xuất; không bbox/snap/raster fallback.
- Solver timeout/lỗi: chỉ winner deterministic đã validate hoặc baseline có provenance.
- Standalone lab chỉ internal/dev flag.
- Strategy mới dùng feature flag/kill switch và entitlement Tem/CNC hiện hữu.
- Shadow A/B trước khi bật production.

## 12. Lô triển khai, tối đa 5 file/lô

Mỗi lô phải rg trace, ghi baseline, liệt kê đúng file, verify hẹp và review diff. Cần file thứ 6 thì tách lô.

### Lô 0 — Corpus và quyết định

Chưa đổi behavior. Thu đủ 4 flow, 2 intent, fixture + PDF thật ẩn dữ liệu. Chốt metric, search/time budget, hash precision, tolerance, cancel SLA, p50/p95/RAM.

**Gate:** chủ sản phẩm duyệt; chưa được làm Lô 1 trước gate này.

### Lô 1 — Core contract/validator

Tối đa 5 file từ model.rs, transform.rs, collision.rs, validator.rs và test contract.

### Lô 2 — Solver quality

solver.rs, candidates.rs, refine.rs, multi_start.rs và test fixture.

### Lô 3A — Deterministic parallel kernel

multi_start.rs, control.rs, native binding và tối đa 2 test.

### Lô 3B — Scheduler grant/concurrency

worker planner, service, scheduler integration, concurrent-job test và benchmark.

### Lô 4 — Manifest/render bundle/adapter

Tối đa 5 file giữa manifest store/validator, shared adapter, imposition route và lifecycle tests.

### Lô 5 — Sticker mapping

Tối đa 5 file giữa:

- backend/app/workers/sticker_imposer_pkg/layout_compute.py;
- backend/app/workers/sticker_imposer_pkg/orchestrator.py;
- backend/app/workers/nup_engine.py;
- autofill test;
- gang/quantity test.

### Lô 6 — Affine/parity compatibility

Shared affine helper, imposition_finalize.py, imposition_parity.py và 2 test.

### Lô 7 — Sticker clip/artwork/CUT

nup_clip_shape.py, nup_artwork.py và tối đa 3 render/artifact test.

### Lô 8 — CNC Front/Back/Cut

cnc_layout.py, cnc_render.py, imposition_parity.py và 2 CNC tests.

### Lô 9 — Frontend policy/UI

Tách 9A types/policy/store và 9B GridSettingsSection/AdvancedSettings/i18n/tests; mỗi lô ≤5 file.

Đường dẫn store đúng: desktop/src/components/imposition-tools/store/slices/nupSlice.ts.

### Lô 10 — Preview/submit parity

Tách preview API + desktop/src/components/imposition-tools/sections/GridPreview.tsx khỏi ImposerDashboard/processHandlers nếu tổng >5 file.

### Lô 11 — Shadow A/B/hardening/feature flag

Tách tiếp nếu cần. Chỉ bật sau acceptance report.

## 13. Test và acceptance

Rust:

- exact angles 17°, 123.456°, 359.999°;
- reference point khác 0, pose/affine mismatch;
- convex/concave/hole/multipolygon;
- sheet-space gapX≠gapY, edge/obstacle clearance;
- deterministic barriers, cancel, last-sheet;
- actual parallelism.

Backend:

- hash stability/change matrix;
- immutable source bundle mismatch;
- 4 flow + 2 intent;
- manifest persist/invalidate/stale;
- cancel không tạo final manifest;
- preview/export solver call count=1;
- GIL release, 2 concurrent heavy jobs;
- PDF read-back với non-zero MediaBox/CropBox/TrimBox, /Rotate;
- clip containment và Front/Back/Cut parity.

Frontend:

- visibility đúng tool/mode;
- no manual angle;
- async cancel/generation guard;
- rotationDeg/revision/fingerprint/manifestId;
- profile/project cũ;
- preview clip/affine.

Visual/artifact:

- rectangle, triangle, L/concave interlock có nền toàn page;
- nhiều design/quantity;
- bleed, gapX khác gapY, obstacles/boong/marks;
- CNC Back landmark F-R-B-L;
- vector/font/transparency/spot-color preservation;
- file trùng basename.

Vitest/tsc chỉ chạy Windows thật. Không update golden -u nếu chưa render và duyệt diff hình học.

Release gate:

- đúng một option, không workflow production mới;
- đủ 4 flow + 2 intent;
- free-angle xuyên solver → manifest → preview → clip/artwork → CUT → CNC Back;
- quantity: đủ 100%, sheetCount không kém baseline;
- autofill: đúng một tờ, placedCount không kém baseline;
- objective chính bằng nhau thì compactness không kém;
- strict improvement trên fixture interlock;
- zero overlap/clearance/obstacle/boundary violation;
- same manifestId/fingerprint giữa preview và artifact;
- exporter không solve;
- worker grant hoạt động ở 1 và 2 heavy jobs;
- legacy/profile/project không hồi quy.

## 14. Definition of Done

Chỉ hoàn thành khi:

1. 4 flow và 2 intent qua corpus thật.
2. Free-angle đúng cả clip và CNC duplex.
3. Manifest + immutable render bundle là nguồn sự thật; no-resolve parity được chứng minh.
4. Deterministic work budget, baseline guard, fallback/provenance đúng.
5. Scheduler/PDFium/hardware gates đúng.
6. Mỗi lô ≤5 file có evidence.
7. Chủ sản phẩm duyệt acceptance report và bật feature.
