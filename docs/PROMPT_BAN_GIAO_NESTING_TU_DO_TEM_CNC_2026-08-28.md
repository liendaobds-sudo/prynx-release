# PROMPT BÀN GIAO ĐỘI NGŨ — NESTING TỰ DO TEM BẾ / CNC

> Bản này supersede prompt ngày 2026-08-27. Hãy đọc toàn bộ trước khi sửa mã nguồn.

## Vai trò và mục tiêu

Bạn là đội triển khai trên repository PrynX tại \`D:\\pdfcompare\`.

Mục tiêu sản phẩm cuối cùng:

- Thêm đúng **một lựa chọn** trong mục **Cách xếp** hiện hữu, tên đề xuất: **Nesting tối ưu theo đường bế**.
- Strategy nội bộ: \`true_shape_nesting\`.
- Áp dụng cho Bình Tem bế và Bình CNC.
- Áp dụng cho cả Bình trang/S&R (\`taskMode=step_repeat\`, submit \`layoutType=repeat\`) và Dàn nhiều mẫu/gang (\`taskMode=nup\`).
- Solver tự tìm vị trí và góc liên tục \`[0°, 360°)\`; không thêm ô cho người dùng nhập/chọn góc.
- Giữ nguyên UI shell, workflow, resolver nguồn, report, artwork, CUT, marks và Front/[Back]/Cut hiện hữu.
- Preview và export phải dùng cùng một manifest; exporter không được solve lại.
- Strategy cũ vẫn là baseline/fallback có provenance.
- Không tuyên bố global optimum; chỉ ghi “kết quả tốt nhất tìm được trong ngân sách tìm kiếm đã ghi nhận”.

Đây là đích cuối. Không được hiểu kế hoạch theo chặng bên dưới là thay đổi yêu cầu sản phẩm; đó là cổng an toàn trước khi bật đích cuối.

## Snapshot bắt buộc phải coi là sự thật

- Nhánh: \`codex/pre-release-audit-2026-08-04\`.
- HEAD hiện tại: \`c863931 feat: add mixed nesting and harden artifact workflows\`.
- Remote: \`https://github.com/liendaobds-sudo/PrynX.git\`; HEAD đang đồng bộ remote.
- Worktree có WIP lớn: 50 tracked modified, 2 intent-to-add, 41 untracked; chưa có commit mới cho WIP.
- \`backend/app/workers/nesting_imposition_render.py\` hiện chỉ là docstring, chưa phải PDF writer production.
- \`rg true_shape_nesting\` chưa cho thấy consumer production trong route/UI Tem/CNC.
- Các file \`_patch_*\`, \`_probe_*\`, \`_tmp_*\`, \`.rej\` là scratch/triage; không stage hoặc xoá nếu chưa xác định chủ sở hữu.
- Lõi/contract đã có test, nhưng chưa có PDF artifact production thật và chưa chạy Tauri end-to-end.

Bằng chứng verify gần nhất:

- Backend contract bundle/lifecycle/source/affine/PDF form/clip/die contour: 255 passed, 1 warning.
- Toàn crate \`imposition_core\`: 292 passed, 0 failed.
- Frontend Mixed Nesting: 234 passed.
- \`npm.cmd run typecheck\`: pass.
- Đây mới là mức AUTO/tĩnh; artifact/runtime vẫn UNKNOWN.

## Đọc bắt buộc

1. \`AGENTS.md\`.
2. \`.agents/skills/prynx-architecture/SKILL.md\`.
3. \`.agents/skills/prynx-audit-workflow/SKILL.md\`.
4. \`.agents/skills/prynx-deep-audit/SKILL.md\`.
5. \`.agents/skills/prynx-imposition/SKILL.md\`.
6. \`.agents/skills/prynx-dieline/SKILL.md\` nếu chạm contour/khuôn bế/clip.
7. \`.agents/skills/prynx-performance/SKILL.md\` nếu chạm budget/worker/RAM.
8. \`.agents/skills/prynx-testing/SKILL.md\`.
9. \`docs/BAO_CAO_AUDIT_TICH_HOP_NESTING_TEM_CNC_2026-08-27.md\`.
10. \`docs/BAO_CAO_LO_0_NESTING_TU_DO_TEM_CNC_2026-08-27.md\`.
11. \`docs/TIEN_DO_NESTING_TU_DO_TEM_CNC_2026-08-28.md\`.
12. \`docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md\`.

## Số liệu Lô 0 phải tôn trọng

- Corpus có 23 ca; so sánh chính cho thấy 8/9 ca cardinal bằng hoặc tốt hơn free-angle.
- \`ST_GANG_QUANTITY_5LOAI\`: cardinal 24 con/tờ, free 22 con/tờ (suy ra khoảng 242 so với 264 tờ).
- Chỉ \`GEO_INTERLOCK_CHU_L\` cho thấy free-angle hơn cardinal rõ ở balanced (+12,5%); fast chưa đạt.
- CNC S&R tam giác: baseline hiện hữu 152 con/tờ, kernel mới 77–84 con/tờ.
- Kết luận hiện tại: **NO-GO production**. Không bật UI hoặc claim “tối ưu” trước khi đóng các gate.

## Nguyên tắc bất di bất dịch

1. Không tạo AppTool/tab/job/exporter production riêng cho nesting.
2. Không gọi \`/mixed-nesting/jobs\` lồng bên trong job N-Up/CNC; job cha nhận heavy-job grant rồi gọi service/kernel nội bộ trực tiếp.
3. Canonical geometry: mm, origin trái-dưới, X phải, Y lên; góc CCW; solver không mirror.
4. Pose authoritative: \`referencePointMm, txMm, tyMm, rotationDeg\`; \`affineMm\` chỉ derived và phải được kiểm parity.
5. Tách rõ \`cutContour\`, \`artworkClipPath\`, \`packingFootprint\`; không bbox fallback khi thiếu contour có nghĩa.
6. \`autofill_single_sheet\`: không tạo quantity giả, đúng một tờ, tối đa placedCount.
7. \`quantity_fulfillment\`: đủ quantity rồi tối thiểu sheetCount; map theo một template nhân theo tờ, không nạp hàng nghìn instance trực tiếp vào kernel.
8. Legacy candidate phải vào cùng validator/baseline guard. Smart kém baseline thì chọn baseline với provenance; export không tự đổi winner.
9. Manifest immutable có input hash/revision/fingerprint/source pin/engine version/seed/budget/validation/score. Input đổi phải làm manifest stale.
10. Preview và export cùng exact \`manifestId\`/fingerprint; preview→export chỉ solve một lần; exporter chỉ hash-check/validate/render.
11. Sticker giữ artwork/CUT/marks/report. CNC giữ Front/[Back]/Cut và parity lật tờ.
12. PDFium trong thread phải bọc \`pdfium_guard()\`; không khóa solver/encode/ghi file.
13. RAM-gating: <8 GB giảm mạnh, 8–<16 GB giảm nhẹ, ≥16 GB không hard-cap vô điều kiện. Không thêm \`[profile.release]\` vào Cargo.toml.
14. Không update golden \`-u\` nếu chưa đổi hình học có chủ đích và chưa soi diff.
15. Mỗi lô tối đa 5 file. Nếu cần file thứ 6, tách lô.

## Trình tự triển khai

### Chặng 0 — Re-baseline, không đổi behavior

- Chạy \`git status --short --untracked-files=all\`, \`git diff --stat\`, xác định file thuộc WIP/scratch.
- Không dùng \`git reset --hard\`, \`git checkout\`, \`git clean\` hoặc ACL bypass.
- Ghi quyết định về CNC marks/obstacles, holes/fill rule, gap semantics, metric compactness, budget/profile và cancel SLA.
- Giữ feature flag production OFF.

**Cổng:** báo cáo baseline và các quyết định được owner duyệt.

### Chặng A — Canary đường production cho gang, tạm khoá cardinal

Đây là canary nội bộ để chứng minh adapter/manifest/writer; chưa công bố free-angle.

**Lô A1 — RenderBundle contract (đề xuất 5 file)**

- \`backend/app/core/nesting_production_adapter.py\`
- \`backend/app/core/nesting_imposition_bundle.py\`
- \`backend/app/workers/nup_artwork.py\`
- \`backend/tests/test_nesting_imposition_bundle.py\`
- \`backend/tests/test_nesting_production_lifecycle.py\`

Hoàn thiện strict \`RenderCutSourceFilterV2\`, \`RenderCutStrokeV2\`, \`RenderCutStyleV2\`; canonical số 6 chữ số; reject boolean/NaN/Inf/path arity sai; hash/reconstruction sau restart; simplex và CNC duplex độc lập; xử lý path item numeric array.

**Lô A2 — Adapter/manifest/intent**

Kết nối service/kernel trực tiếp trong N-Up/CNC; thêm fixed obstacles, baseline candidate/provenance, stale source, commit fence và hai intent. Không nested route/job.

**Lô A3 — Writer/artifact**

Hoàn thiện \`nesting_imposition_render.py\` trên primitive Form hiện có. Writer phải render source pin + placement manifest, không solve. Parse/raster PDF thật, kiểm page boxes, vector artwork, CUT/marks/report, Front/Back/Cut và source hash.

**Lô A4a/A4b — UI/route canary (mỗi lô ≤5 file)**

- A4a: types/generated enum/store/GridSettingsSection + test visibility.
- A4b: processHandlers/GridPreview/ImposerDashboard/route + API test.

Chỉ dùng internal flag và chỉ cho \`taskMode=nup\` Tem/CNC; không thêm control góc, không đổi default/workflow/profile cũ.

**Cổng A:** bốn ô gang (Tem/CNC × autofill/quantity) không overlap/clearance/obstacle/boundary violation; đủ quantity; preview/export cùng manifest; solver call count = 1; legacy không hồi quy.

### Chặng B — Solver quality, không mở rộng UI

Tập trung Rust/native:

- baseline luôn có kết quả hợp lệ trước emergency timeout;
- objective đúng cho hai intent;
- ordering/reinsert/relocate/compact/last-sheet;
- cancel checkpoint ≤1 giây;
- profile chất lượng đơn điệu;
- free không được kém cardinal;
- truyền worker/RAM grant thật xuống native.

**Cổng B bắt buộc:**

- kernel ≥ baseline trên 10 ca benchmark;
- interlock mặc định ≥ baseline +10%;
- \`tight ≥ balanced ≥ fast\`;
- \`free ≥ cardinal\`;
- zero overlap/clearance/obstacle/boundary violation;
- không mất baseline khi timeout/cancel.

Nếu một điều kiện fail: giữ HOLD, không mở S&R và không quảng bá free-angle.

### Chặng C — Free-angle affine/artifact đầy đủ

Chỉ bắt đầu sau Cổng B:

- hỗ trợ góc 17°, 123.456°, 359.999°;
- affine source → physical FRONT; không negate góc/mirror polygon trong solver;
- clip artwork đúng fill rule đã duyệt, không double-count bleed/kerf;
- CUT và artwork cùng placement;
- CNC Back parity F-R-B-L, flip edge, non-zero page origins;
- MediaBox/CropBox/TrimBox và \`/Rotate\`;
- hình convex/concave/hole/multipolygon;
- mở rộng sang S&R chỉ sau khi S&R cũng qua baseline gate.

### Chặng D — Shadow và rollout

- Shadow A/B trên PDF sản xuất đã ẩn danh; đo placedCount/sheetCount/compactness/p50/p95/RAM.
- Feature flag + kill switch, mặc định OFF tới acceptance.
- Tauri dev, installed và release smoke.
- Cập nhật \`PRYNX_MASTER_AUDIT_MATRIX.md\`, acceptance report và log fixes.
- Chỉ commit/push sau khi owner duyệt từng lô; stage path tường minh, không stage scratch.

## Verify bắt buộc sau mỗi lô

Chạy đúng phạm vi liên quan; tối thiểu:

\`\`\`powershell
Set-Location D:\\pdfcompare
backend\\venv\\Scripts\\python.exe -m pytest backend/tests/test_nesting_imposition_bundle.py backend/tests/test_nesting_production_lifecycle.py backend/tests/test_nesting_source_geometry.py backend/tests/test_imposition_affine_parity.py backend/tests/test_imposition_pdf_form.py backend/tests/test_nup_clip_shape_render.py backend/tests/test_die_detection_page_contour.py -q
cargo test --manifest-path imposition_core/Cargo.toml -q
Set-Location D:\\pdfcompare\\desktop
npm.cmd run typecheck
npx.cmd vitest run src/components/mixed-nesting src/lib/mixed-nesting src/stores/useMixedNestingStore.test.ts
\`\`\`

Khi có writer/geometry: parse và raster PDF thật; đối chiếu preview với artifact theo \`manifestId\`, fingerprint, instance mapping, page boxes, CUT, artwork và CNC Front/Back/Cut. Không gọi unit test là runtime proof.

## Báo cáo bắt buộc gửi sau mỗi lô

1. Mã lô và mục tiêu.
2. Danh sách chính xác ≤5 file đã đổi.
3. Contract/invariant đã đóng.
4. Lệnh test + output đầy đủ.
5. So sánh baseline (placedCount, sheetCount, compactness, runtime, RAM).
6. Artifact/runtime evidence hoặc ghi UNKNOWN.
7. Finding còn mở và mức P0–P3.
8. PASS / ROLLBACK / CHỜ DUYỆT.
9. Lô tiếp theo; không tự mở rộng phạm vi.

## Dừng ngay và báo owner nếu

- smart kém baseline;
- free < cardinal;
- thiếu contour hoặc source pin stale;
- preview/export khác manifest;
- exporter phải solve lại;
- semantics duplex/hole/fill rule mâu thuẫn;
- cần sửa hơn 5 file trong một lô;
- test chỉ chạy được nhờ bỏ qua Windows/runtime gate;
- sandbox cản ghi file: báo blocker, không sửa ACL hoặc tìm đường vòng.
