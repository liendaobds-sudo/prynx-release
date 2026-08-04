# NHẬT KÝ SỬA FREE / PRO PRYNX — 2026-08-04

Nguồn finding: `docs/BAO_CAO_AUDIT_FREE_PRO_TOAN_DIEN_2026-08-04.md`.

Quy ước: mỗi lô tối đa 5 file; chỉ đánh dấu hoàn tất khi test hẹp tương ứng đạt. Không build hoặc
publish release công khai trong đợt này.

## Lô WEB-1 — Contract entitlement package PrynX

Trạng thái: **đã áp dụng, verify tự động đạt**.

- `D:\printsolutions-main\src/types/database.ts`
  - Thêm `PrynxLicensePlan`, `license_plan`, `license_features` và kiểu machine pricing còn thiếu.
- `D:\printsolutions-main\src/integrations/supabase/types.ts`
  - Đồng bộ Row/Insert/Update của `pricing_packages` với schema hiện hành.
- `D:\printsolutions-main\src/lib/prynxPackageEntitlements.ts`
  - Một helper nhận diện product PrynX, chuẩn hóa feature grant và fail-closed khi thiếu plan.
- `D:\printsolutions-main\src/lib/prynxPackageEntitlements.test.ts`
  - Test nhận diện product, validation, chuẩn hóa grant và contract migration.
- `D:\printsolutions-main\src/components/admin/AdminPricingPackages.tsx`
  - Form PrynX bắt buộc chọn Free/Pro/Dev; tách quyền license khỏi danh sách tính năng marketing;
    hiển thị plan của từng package.

Verify:

- `npm.cmd exec vitest -- run src/lib/prynxPackageEntitlements.test.ts`: **7 passed**.
- `npm.cmd exec tsc -- --noEmit`: **đạt**.
- ESLint các file entitlement/admin/hook đã sửa: **0 error, 2 warning `any` baseline** tại
  `src/types/database.ts:129,250`.
- Full PrintSolutions Vitest: **277 passed, 1 skipped, 6 failed ngoài phạm vi**. Ba lỗi
  `ScrollToTop.test.tsx` thiếu Router wrapper và ba lỗi `nestingEngine.test.ts` là baseline trong
  worktree PrintSolutions bẩn; không chạm các file đó trong lô entitlement.

## Lô WEB-2 — Provisioning server fail-closed

Trạng thái: **đã áp dụng, verify tĩnh đạt; chưa deploy production**.

- `D:\printsolutions-main\src/hooks/usePricingPackages.ts`
  - Giữ nguyên refactor React Query có sẵn; bổ sung payload entitlement và machine pricing typed.
- `D:\printsolutions-main\supabase\migrations\20260804070000_prynx_package_entitlements_required.sql`
  - Backfill theo thứ tự package → snapshot order → license; snapshot không đổi khi package bị sửa/xóa.
  - Chuẩn hóa ID PrynX; chặn plan DEV công khai, wildcard, FeatureId ngoài allowlist, grant quá dài/quá nhiều.
  - Re-check tại biên snapshot; đổi product sang PrynX buộc revalidate toàn bộ package.
  - Package insert/update giữ khóa `FOR SHARE` trên product để serialize với đổi mapping, đóng race
    package thấy mapping cũ rồi commit sau.
  - Tạm gỡ/dựng lại trigger cũ để backfill package lịch sử đã inactive; fail rõ nếu nhiều order cùng trỏ
    một license hoặc order không cập nhật đúng một license PrynX; unique partial index giữ invariant
    một order PrynX/license và chống race sau migration.
- `D:\printsolutions-main\deploy_license_token.ps1`, `supabase/migrations/security-manifest.json`,
  `src/lib/prynxDeploymentContract.test.ts`
  - Chỉ cho deploy `license-verify` sau khi đúng project và ledger remote chứng minh migration
    `20260804070000` đã được áp dụng; kiểm tra này chạy trước khi đọc/thay secret.

Verify:

- Ba suite contract entitlement/deploy/security: **14 passed**.
- TypeScript: **đạt**.
- PowerShell parser cho script deploy: **đạt**.
- Chưa chạy SQL trên Supabase local/production; migration mới chưa deploy.

## Các lô PrynX desktop/backend/build

Trạng thái: **đã áp dụng và verify tự động; chưa tạo installer/release**.

## Lô Tauri-1 — Gỡ command nghiệp vụ không có entitlement (§BE.03)

Trạng thái: **đã áp dụng, verify tĩnh/tự động đạt**.

- `desktop/src-tauri/src/lib.rs`: gỡ `solve_layout` và `strip_diecut_lines` khỏi
  `generate_handler!`; giữ nguyên toàn bộ bản sửa cold-start đang có.
- `desktop/src-tauri/src/pdf_engine/diecut.rs`: xóa module dead không còn consumer.
- `desktop/src-tauri/src/pdf_engine/mod.rs`: gỡ khai báo module dead.
- `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/Cargo.lock`: gỡ dependency
  `imposition_core` không còn được Tauri dùng; không động tới crate/backend engine.

Verify:

- `cargo check --locked --offline --manifest-path desktop/src-tauri/Cargo.toml`: **đạt**.
- `cargo test ... --lib sidecar_startup_tests`: **2 passed**.
- Policy `generate_handler!` không còn hai command: **đạt**.

## Lô BUILD-1 — Provenance, gate và môi trường build (§BLD.01–05)

Trạng thái: **đã áp dụng, verify policy/hành vi đạt; không build release**.

- `build_production.ps1`:
  - chốt commit đầu build và kiểm lại source sau Tauri, trước copy/manifest;
  - manifest dùng commit đã chốt và ghi `BUILD_MODE`, `BUILD_PROVENANCE`,
    `SIDECAR_PROVENANCE`, `PYTHON_ABI`, gate frontend/backend;
  - từ chối `-SkipNuitka` cho mọi installer;
  - fail nếu hai flag gate trôi trước Vite/manifest;
  - snapshot/restore biến môi trường qua top-level `try/finally`.
- `release_update.ps1`: chỉ nhận manifest public release sạch, Python 3.11, sidecar mới,
  hai gate bật; đối chiếu HEAD/worktree với manifest ngay trước upload/create.
- `quanly_phathanh.ps1`: bỏ checkbox/argument build nhanh dùng sidecar cũ.
- `run_dev.bat`: thêm `--gated` (hoặc `PRYNX_DEV_GATED=true`) để set đồng thời
  `VITE_FEATURE_GATING_ENABLED=true` và `PRYNX_FEATURE_GATING_ENABLED=true`.
- `backend/tests/test_artifact_runtime_self_test.py`: test thứ tự chốt Git/manifest/uploader,
  contract field, GUI không còn stale-sidecar và restore env bằng PowerShell thật.

## Lô BUILD-2 — Artifact tự chứng minh Free/Pro (§BLD.02, §TEST.02)

Trạng thái: **đã áp dụng, unit/policy đạt; chờ installer smoke nội bộ**.

- `backend/app/core/artifact_runtime_self_test.py`: frozen self-test fail nếu gate tắt, Free
  không dùng được `pdf.merge`, hoặc Free không bị từ chối `prepress.preflight`.
- `scripts/verify_installed_artifact.ps1`: kiểm attestation trước cài, kiểm marker
  gate từ chính frozen sidecar và ghi `RUNTIME_FREE_PRO_GATE` vào manifest.
- `release_update.ps1`: không upload nếu thiếu bằng chứng runtime này.

Verify chung cụm build (không tạo artifact):

- Pytest policy/runtime build, clean-user, no-Ghostscript, secret store: **51 passed**.
- Parser Windows PowerShell cho `build_production.ps1`, `release_update.ps1`,
  `quanly_phathanh.ps1`, hai verifier: **đạt**.
- Probe PowerShell thật trên nhánh fail sớm `-SkipNuitka`: **restore env đạt**.
- Chưa chạy Nuitka/Tauri release, cài installer hay upload GitHub theo đúng phạm vi user.

## Lô CAT-1 — Catalog Free/Pro là một hợp đồng typed (§UI.02, §BE.04)

Trạng thái: **đã áp dụng, parity đạt**.

- `desktop/src/lib/license/features.ts`, `features.test.ts`, `desktop/src/lib/toolRegistry.ts`:
  mọi tool bật đều có `featureId` bắt buộc; Crop là Free (`pdf.crop`), Font Tools dùng
  `prepress.preflight`, bỏ capability mồ côi `pdf.optimize_advanced`.
- `backend/app/core/feature_entitlements.py`, `backend/tests/test_feature_entitlements.py`:
  backend dùng cùng catalog và test so khớp chính xác hai phía.
- Catalog cuối: **36 capability = 14 Free + 22 Pro**.

## Lô BE-1 — Enforce đúng từng capability (§BE.01)

Trạng thái: **đã áp dụng, signed-token/custom-grant đạt**.

- `backend/app/api/routes/vdp.py`: Data Merge, Numbering và Cover Numbering yêu cầu lần lượt
  `vdp.datamerge`, `vdp.numbering`, `vdp.cover_numbering`.
- `backend/app/api/routes/preflight.py`: gate theo từng route/action; năm route Crop dùng `pdf.crop`;
  mirror/add bleed dùng `prepress.cutline`.
- `desktop/src/components/preprocess-tools/DataMergeTool.tsx`, `NumberingTool.tsx`,
  `CoverNumberingTool.tsx`, `desktop/src/lib/api.ts`, `api.vdpEntitlement.test.ts`:
  caller gửi đúng capability và test khóa mapping từng luồng.
- Pytest toàn bộ backend sau cùng: **2.133 passed, 21 skipped, 3 deprecation warning**.
- Riêng sáu suite entitlement/build bị ảnh hưởng: **70 passed**.

## Lô UI-1 — Một cổng kích hoạt và badge thống nhất (§UI.01, §UI.04, §UI.05)

Trạng thái: **đã áp dụng, test entry-point đạt**.

- `desktop/src/hooks/useToolActivationGuard.ts` + test: guard đọc quyền hiện tại ngay lúc kích hoạt,
  không dùng snapshot quyền cũ.
- `desktop/src/components/imposition-tools/ToolMenuList.tsx` + entitlement test,
  `desktop/src/components/ImpositionTab.tsx`, `desktop/src/components/HomeTab.tsx`:
  Home, menu app, workspace, favorite và mini-toolbar dùng cùng catalog/guard/badge; tool standalone
  không còn rơi vào router workspace.
- Free không đổi active tool khi bấm Pro; Pro/custom grant chỉ mở đúng capability.

## Lô UI-2 — Recipe và preset không vượt quyền (§TEST.01)

Trạng thái: **đã áp dụng, fail-closed**.

- `desktop/src/lib/recipe/recipeEntitlements.ts` + test: map đủ mọi `RecipeOpId`; operation lạ bị từ chối.
- `desktop/src/lib/recipe/PlaybackRunner.ts` + test, `recipeOps.ts`: preflight cả recipe trước khi chạy và
  re-check từng bước để dừng nếu quyền đổi giữa chừng.
- Preset workspace được guard trước mutation; custom grant N-Up không nạp ké preset Booklet.

## Lô UI-3 — Downgrade giữ dữ liệu nhưng khóa thao tác (§UI.03, §BE.02)

Trạng thái: **đã áp dụng, regression đạt**.

- `desktop/src/components/license/FeatureAccessOverlay.tsx` + test: overlay portal cao nhất, focus trap,
  nút về Trang chủ và Escape; không ép unmount dữ liệu đang làm.
- `desktop/src/components/dieline-tool/DielineTool.tsx` + test: re-check trước export.
- `desktop/src/components/paper-library/PaperLibraryTool.tsx` + test: re-check client-only, giữ tham số,
  có đường về Trang chủ. Paper Library vẫn là accepted commercial risk Ring-3 như threat model.
- `desktop/src/App.tsx`, `desktop/src/lib/recovery.ts`, `App.recoveryEntitlement.test.ts`:
  recovery bị từ chối không xóa snapshot; snapshot cũ chỉ xóa sau khi bản thay thế ghi atomic thành công.

Verify hẹp:

- Recovery: **1 passed**; overlay: **3 passed**; Paper Library: **36 passed**.

## Lô UI-4 — Tab nền và portal không còn tương tác

Trạng thái: **đã áp dụng, contract test đạt**.

- `desktop/src/components/imposition-tools/types.ts`, `ImposerDashboard.tsx`,
  `desktop/src/components/ImpositionTab.tsx`: truyền `isActive` tới dashboard.
- `ImposerDashboard.backgroundDialogs.test.ts`: khóa Paper Settings, Marks, Pont, Preset, Flipbook và
  Sheet Viewer khi tab ở nền; state dialog vẫn được giữ để quay lại.
- Verify: **1 passed** + typecheck đạt.

## Lô UI-5 — Office batch dừng ngay khi quyền đổi (§UI.06)

Trạng thái: **đã áp dụng, regression đạt**.

- `desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`:
  tách `pdf.office_batch`/`pdf.resize_batch`; đọc `useAuthStore.getState()` trước từng item và ngay trước
  `copy_batch_pdf`; downgrade abort request, dừng vòng lặp và giữ lỗi dù panel Pro biến mất.
- `OfficeConvertTool.test.tsx`: Pro → Free lúc request pending phải abort và không copy PDF cục bộ.
- Verify: **12 passed** + typecheck đạt.

## Lô BUILD-3 — Tag GitHub phải trỏ đúng commit artifact

Trạng thái: **đã áp dụng, chỉ verify tĩnh; không gọi GitHub**.

- `release_update.ps1`: commit trong manifest phải tồn tại trên repo đích; tag có sẵn được dereference
  (kể cả annotated tag) và so SHA trước `--clobber`; release mới dùng `--target $manifestCommit`.
- `backend/tests/test_artifact_runtime_self_test.py`: khóa thứ tự kiểm tra remote/tag trước upload/create.
- Verify: file policy **14 passed**; PowerShell parser đạt.

## Lô DOC-1 — Tài liệu và threat model

Trạng thái: **đã cập nhật**.

- `docs/PRYNX_FREE_PRO.md`, `docs/CAU_HINH_ENV.md`, `docs/PRYNX_FEATURE_UPGRADE_PLAN.md`,
  `docs/PDF_UTILITIES_GUIDE.md`, `docs/audit/PRYNX_THREAT_MODEL.md` khớp catalog, gate, accepted risk và
  provenance mới; comment stale trong `useAuthStore.ts`/Tauri đã sửa.

## Verify cuối — 2026-08-04

- Frontend full Vitest: **181 files passed; 1.805 passed, 2 skipped**.
- Frontend typecheck: **đạt**.
- Frontend `lint:budget`: **đạt** với baseline hiện hữu `1.438 errors / 105 warnings`;
  `npm run lint` toàn repo vẫn fail đúng baseline này, không mở rộng thành refactor ngoài audit Free/Pro.
- Backend full pytest: **2.133 passed, 21 skipped**.
- Tauri: `cargo check --locked --offline` **đạt**; startup tests **2 passed**.
- PrintSolutions: contract **14 passed**, TypeScript **đạt**, ESLint phạm vi **0 error / 2 warning baseline**,
  PowerShell parser **đạt**. Full suite baseline trước đó: **277 passed, 1 skipped, 6 failed ngoài phạm vi**
  (`ScrollToTop` 3, `nestingEngine` 3).
- PowerShell build/release/verifier: parser đạt; build policy/runtime suites đạt.
- `git diff --check` repo PrynX: **đạt**. Repo PrintSolutions: các file entitlement/new migration **đạt**;
  full worktree vẫn báo trailing whitespace ở các file JSX/PrintMonitorApp bẩn có sẵn, ngoài phạm vi đợt này.

## Proof gap còn lại trước GO công khai

Các finding code đã đóng bằng kiểm tra tĩnh/tự động. Ba bằng chứng runtime sau chưa được tạo vì user yêu cầu
test nội bộ trước và cấm publish/deploy trong đợt này:

1. Build installer nội bộ đầy đủ (Nuitka + Tauri), cài trên clean-user và chạy GUI smoke.
2. Chạy migration trên Supabase local/staging, kiểm ledger/trigger/Edge thật; production chưa được chạm tới.
3. Chạy app đã cài với key Free/Pro thật và xác nhận UI + sidecar qua luồng người dùng.

Không build, ký, upload GitHub Release, deploy migration/Edge, commit hoặc push trong đợt sửa này.
