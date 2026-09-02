# TIẾN ĐỘ TÍCH HỢP NESTING TỰ DO CHO BÌNH TEM BẾ / CNC

**Ngày chụp trạng thái:** 2026-08-28

**Trạng thái tổng:** **NO-GO production** — đã có lõi và contract WIP, chưa nối vào UI/route/writer sản xuất.

**Phạm vi sản phẩm đã chốt:** cuối cùng vẫn là một lựa chọn trong mục **Cách xếp**, tự tìm góc/vị trí, dùng cho Tem bế và CNC, cả Bình trang/S&R lẫn Dàn nhiều mẫu/gang; không tạo workflow riêng.

## 1. Snapshot Git

- Repository: \`D:\\pdfcompare\`
- Nhánh: \`codex/pre-release-audit-2026-08-04\`
- HEAD: \`c863931 feat: add mixed nesting and harden artifact workflows\`
- Remote: \`https://github.com/liendaobds-sudo/PrynX.git\`
- HEAD và remote đang đồng bộ: \`0 ahead / 0 behind\`.
- Chưa có commit/push mới trong đợt WIP hiện tại.
- Worktree hiện có **93 mục**:
  - 50 file tracked đang sửa;
  - 2 file intent-to-add (\`.A\`), chưa có nội dung trong index;
  - 41 file untracked.
- Diff tracked/added khoảng **7.585 dòng thêm, 447 dòng xoá** trên 52 path.
- Không được stage các file scratch như \`_patch_*\`, \`_probe_*\`, \`_tmp_*\`, \`.rej\` nếu chưa xác định rõ nguồn và mục đích.

Commit \`c863931\` là baseline đã commit của công cụ Mixed Nesting độc lập và phần hardening ban đầu. Các module production-adapter/lifecycle bên dưới là WIP sau commit đó, chưa được xem là release.

## 2. Đã có

### 2.1. Lõi và cầu nối

- Rust \`imposition_core/src/mixed_nesting/\`: model/canonicalization, polygon kernel, NFP/IFP, collision, validator, score, baseline guard, multi-start và deterministic control.
- PyO3 bridge: \`native/src/mixed_nesting_py.rs\`.
- Service/job standalone hiện hữu: \`backend/app/core/mixed_nesting_service.py\`, \`mixed_nesting_jobs.py\`.
- WIP contract production:
  - \`backend/app/core/nesting_production_adapter.py\`
  - \`backend/app/core/nesting_imposition_bundle.py\`
  - \`backend/app/core/nesting_manifest_store.py\`
  - \`backend/app/core/nesting_production_orchestrator.py\`
  - \`backend/app/core/nesting_source_geometry.py\`
  - \`backend/app/core/nesting_source_pin.py\`
  - \`backend/app/workers/imposition_affine.py\`
- WIP PDF/Form primitive: \`backend/app/workers/imposition_pdf_form.py\`.

### 2.2. Test và contract đã có

- Manifest/source pin/geometry/affine/clip/PDF form đã có bộ test đáng kể.
- Corpus Lô 0: \`backend/tests/fixtures/nesting_tu_do/corpus_lo0.json\` có 23 ca, gồm các ca 4 flow × 2 intent, hình học, obstacle, parity và cancel.
- Có harness baseline: \`scripts/lo0_nesting_baseline.py\`.

## 3. Bằng chứng verify gần nhất

| Phạm vi | Kết quả | Mức bằng chứng |
|---|---:|---|
| Backend contract/manifest/source/affine/PDF form/clip/die contour | **255 passed, 1 warning** | AUTO |
| Toàn bộ nhóm \`imposition_core\` | **292 passed, 0 failed** | AUTO |
| Frontend Mixed Nesting | **234 passed** | AUTO |
| \`npm.cmd run typecheck\` | **pass** | AUTO |
| \`py_compile\`, \`git diff --check\` | **pass** ở lượt verify trước | Tĩnh |
| PDF artifact production thật | **chưa có** | UNKNOWN |
| Preview ↔ export trên cùng file PDF thật | **chưa chứng minh** | UNKNOWN |
| Tauri dev/installed/release end-to-end | **chưa chạy** | UNKNOWN |

Warning hiện tại là cảnh báo deprecation Pydantic, không phải test failure.

## 4. Những gì chưa được nối

### 4.1. Chưa có consumer production

\`rg true_shape_nesting\` hiện chỉ tìm thấy constant/fixture/test/docs; chưa có route hoặc UI production tiêu thụ strategy này.

- \`desktop/src/components/imposition-tools/types.ts\` vẫn chưa có giá trị \`true_shape_nesting\` trong \`GridStrategy\`.
- Dropdown tại \`GridSettingsSection.tsx\` chưa có lựa chọn mới.
- \`processHandlers\`/route Imposition vẫn truyền contract cũ.
- \`backend/app/workers/nesting_imposition_render.py\` hiện chỉ là docstring 87 bytes, **chưa có PDF writer production**.

### 4.2. Contract còn hở

- RenderBundle có contour/clip/footprint nhưng chưa có \`cutStyle\`/source-filter/stroke contract hoàn chỉnh.
- Adapter hiện đang mặc định \`orientationPolicy = free\` và \`gapMm = 0.0\`; chưa phù hợp với rollout có kiểm soát và semantics \`gapX/gapY\` đã nêu trong kế hoạch.
- \`nup_artwork\`/clip vẫn còn nhánh xử lý cờ cardinal; chưa chứng minh affine liên tục end-to-end.
- Chưa chứng minh writer dùng source pin bất biến, cùng manifest và không solve lại.

### 4.3. Chất lượng solver chưa đạt release gate

- 8/9 ca so sánh cho thấy cardinal bằng hoặc tốt hơn free-angle.
- \`ST_GANG_QUANTITY_5LOAI\`: cardinal 24 con/tờ, free 22 con/tờ; suy ra khoảng 242 so với 264 tờ cho cùng đơn hàng.
- Chỉ \`GEO_INTERLOCK_CHU_L\` cho thấy free-angle hơn cardinal rõ ở profile balanced (+12,5%); profile fast chưa có lợi ích.
- CNC S&R hình tam giác: baseline hiện hữu 152 con/tờ, kernel mới chỉ 77–84 con/tờ tùy profile.
- Profile chất lượng chưa đơn điệu; tăng profile có ca cho kết quả thấp hơn vì ngân sách trial chưa cân bằng.

### 4.4. Blocker sản xuất khác

- Mapping quantity phải là “một template rồi nhân theo tờ”, không nạp hàng nghìn instance trực tiếp vào kernel.
- Timeout trước khi có smart result phải vẫn giữ baseline đã validate; cancel không được tạo final manifest.
- Worker/RAM grant chưa truyền thật xuống native; không được báo worker ảo.
- CNC phải đưa boong/keep-out/dấu canh vào fixed obstacles và kiểm tra lại sau bước recenter.
- Phải chốt semantics hole/fill rule và parity Front/Back/Cut bằng artifact thật.

## 5. Kết luận hiện tại

Mục tiêu sản phẩm **không bị đổi**: đích cuối là free-angle tự động cho đủ bốn flow. Tuy nhiên bằng chứng Lô 0 chưa cho phép bật mục này cho người dùng. Nếu bỏ qua baseline guard, một số job sẽ nhận kết quả kém hơn đường hiện hữu (đặc biệt S&R tam giác) và exporter hiện chưa thể tạo file sản xuất đầy đủ artwork/CUT/duplex.

Vì vậy trạng thái đúng là:

> **Lõi: AUTO. Contract/lifecycle: WIP, cần hoàn thiện. Tích hợp production: chưa bắt đầu. Artifact/runtime: UNKNOWN. Release: NO-GO.**

Các báo cáo cũ vẫn ghi \`CHỜ DUYỆT\`; báo cáo audit ban đầu còn ghi baseline HEAD \`47afe41\`, đã stale so với \`c863931\` và WIP hiện tại. Cần re-baseline trước khi merge.

## 6. Kế hoạch tiếp theo

Mỗi lô tối đa 5 file; sau mỗi lô phải verify và ghi báo cáo, không mở rộng phạm vi khi chưa có chốt.

### Chặng 0 — Re-baseline và quyết định (không sửa behavior)

1. Đọc AGENTS và các skill bắt buộc.
2. Chụp lại \`git status\`, \`git diff --stat\`, test baseline; phân loại WIP và scratch.
3. Ghi quyết định cho: obstacle CNC/dấu canh, hole/fill rule, profile/budget/cancel SLA, metric compactness và chính sách fallback.
4. Giữ feature production OFF; không stage/commit toàn bộ worktree.

**Cổng:** chủ sản phẩm duyệt metric/tolerance/budget và xác nhận kế hoạch ba chặng.

### Chặng A — Canary tích hợp gang, cardinal (internal flag, chưa mở free-angle)

Mục đích là chứng minh đường production mà không đẩy rủi ro affine vào writer hiện hữu.

**Lô A1 — Contract RenderBundle (5 file đề xuất)**

- \`backend/app/core/nesting_production_adapter.py\`
- \`backend/app/core/nesting_imposition_bundle.py\`
- \`backend/app/workers/nup_artwork.py\`
- \`backend/tests/test_nesting_imposition_bundle.py\`
- \`backend/tests/test_nesting_production_lifecycle.py\`

Thêm strict \`RenderCutSourceFilterV2\`/\`RenderCutStrokeV2\`/\`RenderCutStyleV2\`, canonical hash 6 chữ số, reject boolean/NaN/Inf/path sai arity, hash/reconstruction sau restart, simplex và CNC duplex độc lập; sửa \`_path_item_key\` cho numeric array. Không nối UI trong lô này.

**Lô A2 — Adapter/manifest và intent (tối đa 5 file)**

Kết nối trực tiếp kernel trong job N-Up/CNC sau khi job cha nhận scheduler grant; thêm \`autofill_single_sheet\` và \`quantity_fulfillment\`, fixed obstacles, baseline candidate/provenance, stale source và commit fence. Tuyệt đối không gọi \`/mixed-nesting/jobs\` lồng bên trong N-Up.

**Lô A3 — Writer/artifact (tối đa 5 file)**

Hoàn thiện \`nesting_imposition_render.py\` trên primitive Form hiện có; preview/export đọc cùng manifest; renderer không solve. Kiểm artwork/CUT/marks/report, Front/[Back]/Cut, page boxes và source hash bằng parse/raster PDF thật.

**Lô A4 — UI/route canary (tách 2 lô, mỗi lô ≤5 file)**

- A4a: types/generated enum/store/\`GridSettingsSection\` và test visibility.
- A4b: \`processHandlers\`, \`GridPreview\`, \`ImposerDashboard\`, route Imposition và test API.

Chỉ hiện strategy trong \`taskMode=nup\` của Tem/CNC ở internal flag, không thêm ô nhập góc và không đổi default/workflow cũ.

**Cổng Chặng A:** cả bốn ô gang (Tem/CNC × autofill/quantity) không overlap/không chạm obstacle/đủ quantity, preview và export có cùng \`manifestId\`/fingerprint, solve đúng một lần; legacy không hồi quy. Đây là cổng đường chạy, chưa phải cổng free-angle.

### Chặng B — Đóng khoảng cách chất lượng solver (không mở rộng UI)

Tập trung trong Rust/native:

- baseline luôn có kết quả hợp lệ khi timeout;
- objective đúng cho hai intent;
- ordering/reinsert/relocate/compact và last-sheet elimination;
- checkpoint cancel ≤1 giây;
- profile cao không được kém profile thấp do thiếu ngân sách;
- truyền scheduler worker/RAM grant thật, tuân thủ RAM-gating.

**Cổng Chặng B bắt buộc:** trên corpus 10 ca benchmark, kernel không kém baseline; \`GEO_INTERLOCK_CHU_L\` tối thiểu +10% ở profile mặc định; \`tight ≥ balanced ≥ fast\`; \`free ≥ cardinal\`; zero violation. Nếu một điều kiện fail, giữ production HOLD.

### Chặng C — Free-angle và affine end-to-end

Chỉ mở sau Cổng B:

- pose authoritative \`referencePointMm + txMm + tyMm + rotationDeg\`;
- affine source → physical FRONT, không mirror trong solver;
- clip even-odd/nonzero theo quyết định sản phẩm, artwork vector, CUT và bleed không double-count;
- CNC Back parity với landmark F-R-B-L, duplex flip edge và non-zero page origins;
- test góc 17°, 123.456°, 359.999°, hình lõm/hole/multipolygon, \`/Rotate\`, MediaBox/CropBox/TrimBox;
- mở rộng từ gang sang S&R chỉ khi baseline gate cũng đạt cho S&R.

### Chặng D — Shadow, runtime và rollout

- Shadow A/B trên PDF sản xuất đã ẩn danh; đo sheetCount/placedCount/compactness/p50/p95/RAM.
- Feature flag + kill switch, default OFF cho tới acceptance.
- Tauri dev → installed/release smoke; cập nhật master audit matrix và acceptance report.
- Chỉ sau khi owner duyệt mới commit theo lô, push và bật entitlement hiện hữu.

## 7. Lệnh verify chuẩn

\`\`\`powershell
Set-Location D:\\pdfcompare
backend\\venv\\Scripts\\python.exe -m pytest backend/tests/test_nesting_imposition_bundle.py backend/tests/test_nesting_production_lifecycle.py backend/tests/test_nesting_source_geometry.py backend/tests/test_imposition_affine_parity.py backend/tests/test_imposition_pdf_form.py backend/tests/test_nup_clip_shape_render.py backend/tests/test_die_detection_page_contour.py -q
cargo test --manifest-path imposition_core/Cargo.toml -q
Set-Location D:\\pdfcompare\\desktop
npm.cmd run typecheck
npx.cmd vitest run src/components/mixed-nesting src/lib/mixed-nesting src/stores/useMixedNestingStore.test.ts
\`\`\`

Không chạy \`-u\` golden nếu chưa đổi hình học có chủ đích và chưa soi diff. Không báo \`RUNTIME\` khi mới có unit test.

## 8. Tài liệu liên quan

- \`docs/BAO_CAO_AUDIT_TICH_HOP_NESTING_TEM_CNC_2026-08-27.md\`
- \`docs/BAO_CAO_LO_0_NESTING_TU_DO_TEM_CNC_2026-08-27.md\`
- \`docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md\`
- \`docs/PROMPT_BAN_GIAO_NESTING_TU_DO_TEM_CNC_2026-08-28.md\`
