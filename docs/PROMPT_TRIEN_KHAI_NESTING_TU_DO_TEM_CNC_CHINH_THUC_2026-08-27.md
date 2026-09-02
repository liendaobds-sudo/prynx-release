# PROMPT CHÍNH THỨC GIAO ĐỘI NGŨ

Sao chép nguyên phần trong khung dưới đây.

~~~text
Bạn đang làm việc trên repository PrynX.

MỤC TIÊU

Tích hợp true-shape/free-angle nesting thành đúng một lựa chọn mới trong “Cách xếp” của Bình Tem bế và Bình CNC:

- Tên UI: “Nesting tối ưu theo đường bế”.
- Strategy đề xuất: true_shape_nesting.
- Có ở Bình trang/S&R và Dàn nhiều mẫu/gang.
- Solver tự tìm vị trí và góc liên tục [0°,360°); không nhận góc từ người dùng.
- Không tạo tool/tab/wizard/workflow production mới.
- Preview cuối và file xuất dùng cùng manifest; exporter không solve lại.
- Strategy cũ giữ nguyên làm baseline/fallback có provenance.

CHỈ ĐƯỢC THỰC HIỆN LÔ 0 TRƯỚC. Không sửa code production cho đến khi chủ sản phẩm duyệt baseline, compactness metric, tolerance, search/time budget, p50/p95/RAM và cancel SLA.

ĐỌC BẮT BUỘC

1. AGENTS.md.
2. .agents/skills/prynx-architecture/SKILL.md.
3. .agents/skills/prynx-audit-workflow/SKILL.md.
4. .agents/skills/prynx-imposition/SKILL.md.
5. .agents/skills/prynx-performance/SKILL.md.
6. .agents/skills/prynx-testing/SKILL.md.
7. .agents/skills/prynx-conventions/SKILL.md.
8. docs/BAO_CAO_AUDIT_TICH_HOP_NESTING_TEM_CNC_2026-08-27.md.
9. docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md.

Tài liệu CHINH_THUC thay thế mọi bản nháp hoặc đề xuất cardinal-only, gang-only và không áp dụng S&R.

HỢP ĐỒNG KHÔNG ĐƯỢC TỰ Ý ĐỔI

1. Đủ bốn flow:
   - Sticker S&R;
   - Sticker gang;
   - CNC S&R;
   - CNC gang.
2. Mapping code:
   - taskMode="step_repeat" là Bình trang/S&R và submit thành layoutType="repeat";
   - taskMode="nup" là Dàn nhiều mẫu/gang.
3. Hai layout intent:
   - autofill_single_sheet: không target quantity, đúng một tờ, tối đa placedCount;
   - quantity_fulfillment: đủ quantity, sau đó tối thiểu sheetCount.
   Không tạo quantity giả cho autofill.
4. Single/gang dùng cùng canonical PartDefinition/PartInstance, solver và manifest.
5. Sticker giữ artwork/CUT/marks/report.
6. CNC giữ Front/[Back]/Cut và parity lật tờ hiện hữu.
7. Không thêm control góc/quality/restart/time/worker.
8. Không đổi default optimal_auto, profile/project cũ hoặc workflow xuất.
9. Không tuyên bố global optimum; chỉ nói “kết quả tốt nhất tìm được trong ngân sách tìm kiếm đã ghi nhận”.

KIẾN TRÚC

UI Imposition hiện hữu
→ true_shape_nesting
→ job/scheduler Imposition hiện hữu
→ canonical geometry adapter
→ Rust mixed-nesting kernel
→ validator + baseline guard
→ immutable PlacementManifestV1
→ preview và renderer/exporter hiện hữu.

Không gọi /mixed-nesting/jobs lồng trong N-Up/CNC. Không dùng standalone parser/exporter làm production path. Standalone lab chỉ sau internal/dev flag và không là entry người dùng; strategy dùng entitlement Tem/CNC hiện hữu.

Route mỏng. Job cha nhận heavy_job_scheduler grant. Native CPU-bound nhả GIL. PDFium trong thread phải bọc đoạn gọi bằng pdfium_guard(); không khóa solver/encode/ghi file.

CANONICAL GEOMETRY

Quy ước bắt buộc:

- mm; origin trái-dưới; X phải; Y lên;
- góc CCW, normalize [0°,360°);
- solver không mirror;
- pt/px/top-down chỉ đổi ở boundary đúng một lần.

Pose authoritative:

p_sheet = R(theta) × (p_local - referencePoint) + (tx,ty)
G_i = T(tx,ty) · R(theta) · T(-referencePoint).

Persist referencePointMm, txMm, tyMm, rotationDeg làm SSOT. affineMm chỉ derived; validator reject mismatch vượt tolerance. Không snap góc cardinal.

Mỗi part tách:

- cutContour;
- artworkClipPath;
- packingFootprint.

Invariant:

- painted/artworkClipPath nằm trong packingFootprint;
- ba geometry cùng frame/reference point;
- bleed/kerf/safety tạo footprint đúng một lần, không double-count;
- thiếu semantic contour thì preflight fail, không bbox giả.

Tách part–part, edge và obstacle clearance. gapX/gapY theo sheet axes và anisotropic expansion diễn ra trong sheet-space sau pose, không local-space trước rotation.

Phân loại marks:

- sheet-fixed/dynamic sheet marks materialize trước solve và thành obstacles;
- part-local marks đi theo G_i, phần painted/safety nằm trong footprint.

Hole/multipolygon dùng fill rule thống nhất. V1 không nesting vào hole nếu chưa có quyết định/test. Identity dựa source hash + page/design/candidate, không chỉ basename.

REUSE CLIP

Không dựng pipeline clip song song. Nâng chính nup_clip_shape.py::build_die_clip_rings, out_clip_path và die_polylines_for_placement/transform_die_point trong nup_artwork.py từ cardinal flags lên rotationDeg/G_i; cập nhật cache key và giữ các test clip hiện hữu. Không rectangle fallback trong interlock.

REQUEST, HASH, MANIFEST VÀ RENDER BUNDLE

NestingRequestV1 có version và khóa:

- revision, inputHash, layoutFingerprint;
- sheet/usable region/clearance/obstacles;
- source hash, PartDefinition, ba geometry, reference point;
- continuous orientation/reflection=false;
- fixed search budget, emergency timeout, seed/restarts;
- scheduler CPU/RAM grant;
- tool, task mode, layout intent, duplex metadata.

Canonical hash serialization phải chốt field/ring order, numeric precision và normalization. layoutFingerprint = input identity + strategy + solverConfigHash + engine/validator version + geometry constraints.

Persist immutable PartDefinition/source bundle cùng manifest hoặc content-addressed reference:

- source hash/revision;
- Front/Back/Cut page mapping;
- MediaBox/CropBox/TrimBox, /Rotate;
- SourcePageToCanonical từng side;
- cut/clip/footprint/reference point;
- render/spot-color metadata.

Exporter reject source/bundle mismatch; không render từ mutable state.

PlacementManifestV1 gồm manifestId, revision/hash/fingerprint, engine/validator provenance, intent, seed/budget/grant/stop reason, baseline/selected score, winner, counts, validation, bundle hashes và per-placement authoritative pose + derived affine.

Lifecycle:

normalized request
→ baseline + smart search
→ validate
→ deterministic select
→ persist final manifest/bundle
→ preview
→ export exact manifestId.

- Input đổi làm stale; response cũ không ghi đè.
- Reuse cần exact manifestId và exact fingerprint.
- Preview có final manifest thì submit reuse.
- Chưa có manifest thì production solve đúng một lần.
- Export chỉ hash-check/validate nhanh, không solve/fallback.
- Cancel không tạo final manifest.
- Instrument solver call count preview→export = 1.

OBJECTIVE VÀ BASELINE

Autofill: một tờ → max placedCount → compactness → deterministic tie-break.

Quantity: min unplacedCount và production=0 → min sheetCount → compactness → deterministic tie-break.

Legacy placement phải vào cùng validator/candidate pool:

- autofill smart placedCount không thấp hơn baseline;
- quantity smart đủ số và sheetCount không cao hơn baseline;
- objective chính bằng nhau mới so compactness;
- baseline fallback chỉ trước preview, có provenance; export không đổi winner.

SOLVER VÀ DETERMINISM

Fixed work/search budget quyết định kết quả:

- restart set/seed xác định trước;
- stable barriers và merge theo score + restart index + manifest tie-break;
- completion order không đổi winner;
- emergency timeout chỉ chọn completed deterministic barrier hoặc baseline, không partial state theo lịch thread;
- manifest ghi completed work units/timeout.

Nâng solver bằng NFP/IFP contacts, critical angles + coarse-to-fine refinement, nhiều ordering, multi-start/population thật, relocate/reinsert, rotate/slide/compact, swap, destroy-repair, move-chain, last-sheet elimination và cooperative cancel/progress.

Không cần tên thuật toán hào nhoáng; cần corpus chứng minh không kém baseline và interlock fixture strict improvement.

ARTWORK VÀ CNC PARITY

Artwork phải:

save
→ apply CTM_side
→ even-odd clip artworkClipPath
→ draw source XObject
→ restore.

Không chỉ xoay page rectangle và không raster hóa.

G_i là canonical part → physical FRONT sheet, det(G_i)=+1, không mirror.

CTM_side = SheetFrame_side ∘ G_i ∘ SourcePageToCanonical_side.

- SourcePageToCanonical_side xử lý page boxes, /Rotate, origin và registration source.
- SheetFrame_side xử lý FRONT sheet sang output Front/Cut/Back, gồm Y-axis, output origin, registration và flip vật lý nếu có.
- Back không mặc định M_sheet × G_i.
- Không negate angle, đổi x theo bbox hoặc mirror polygon trong solver.
- Nâng imposition_parity.py từ flags lên affine.
- Test F-R-B-L, determinant, reading direction, non-zero page origins, /Rotate, artwork/clip/CUT và instance mapping.
- Giữ vector, font, transparency và spot color.

SCHEDULER VÀ PHẦN CỨNG

heavy_job_scheduler cấp worker + RAM grant theo từng job; kernel chỉ dùng grant:

- RAM <8 GB giảm mạnh;
- 8–<16 GB giảm nhẹ;
- ≥16 GB không hard-cap vô điều kiện nhưng tôn trọng grant khi có nhiều heavy job.

Benchmark 1 job và 2 heavy jobs đồng thời; test GIL release và actual parallelism, không chỉ log plan.workers.

Không thêm [profile.release] vào Cargo.toml. LTO/codegen-units chỉ qua build_production.ps1.

QUY TRÌNH VÀ CÁC LÔ

Tuân thủ hai chốt. Mỗi lô tối đa 5 file, rg trace trước, baseline trước, verify hẹp và review diff sau. Cần file thứ 6 thì tách.

0. Corpus/metric/tolerance/budget; chưa đổi behavior; CHỜ DUYỆT.
1. Core contract/validator.
2. Solver quality.
3A. Deterministic parallel kernel.
3B. Scheduler grant + concurrent-job benchmark.
4. Manifest/render bundle/adapter/lifecycle.
5. Sticker single/gang + hai intent.
6. Shared affine/parity compatibility.
7. Sticker clip/artwork/CUT.
8. CNC Front/Back/Cut.
9A. Frontend types/policy/store.
9B. Option/i18n/UI tests.
10A. Preview async/arbitrary-angle.
10B. Submit/manifest parity.
11. Shadow A/B/hardening/feature flag.

Không tự commit, push, build release hoặc update golden nếu chưa được yêu cầu/duyệt.

TEST VÀ RELEASE GATES

Rust:

- góc 17°, 123.456°, 359.999°, reference point khác 0;
- pose/affine mismatch;
- convex/concave/hole/multipolygon;
- sheet-space gapX khác gapY, edge/obstacle clearance;
- stable determinism, cancel, last-sheet, actual parallelism.

Backend:

- canonical hash stability/change matrix;
- immutable bundle mismatch;
- bốn flow + hai intent;
- manifest persist/invalidate/stale;
- cancel không final manifest;
- preview/export solver count=1;
- GIL release + hai concurrent heavy jobs;
- non-zero MediaBox/CropBox/TrimBox và /Rotate;
- clip containment, vector/font/transparency/spot color;
- Front/Back/Cut F-R-B-L determinant/reading parity.

Frontend:

- option đúng tool/mode, không manual angle;
- async cancel/generation guard;
- rotationDeg/revision/fingerprint/manifestId;
- profile/project cũ;
- preview arbitrary affine/clip.

Release chỉ khi:

- đúng một option, không workflow production thứ hai;
- đủ bốn flow + hai intent;
- free-angle xuyên solver→manifest→preview→clip/artwork→CUT→CNC Back;
- quantity đủ 100%, sheetCount không kém baseline;
- autofill đúng một tờ, placedCount không kém baseline;
- objective chính bằng nhau thì compactness không kém;
- strict improvement trên interlock fixture;
- zero overlap/clearance/obstacle/boundary violation;
- preview/artifact cùng exact manifest/fingerprint;
- exporter không solve;
- scheduler grant đúng với 1 và 2 heavy jobs;
- legacy/profile/project không hồi quy.

BÁO CÁO SAU MỖI LÔ

1. Lô/mục tiêu.
2. Tối đa 5 file đổi.
3. Contract đã đáp ứng.
4. Test/output.
5. Diff/golden kiểm tay.
6. So sánh baseline.
7. Proof gap/rủi ro.
8. PASS, ROLLBACK hoặc CHỜ DUYỆT.
9. Đề xuất lô tiếp theo; không tự mở rộng.

DỪNG VÀ HỎI nếu metric/budget chưa duyệt, semantics geometry/duplex mâu thuẫn, cần đổi UI/workflow/schema không tương thích, fallback dễ gây hiểu nhầm, smart kém baseline hoặc cần update golden chưa được duyệt.
~~~
