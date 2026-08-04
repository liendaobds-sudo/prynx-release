# BÁO CÁO AUDIT TOÀN DIỆN FREE / PRO PRYNX — 2026-08-04

> **CHỐT 1 — KHẢO SÁT, CHƯA SỬA.** Báo cáo này được lập theo `prynx-audit-workflow`.
> Chưa sửa logic Free/Pro, chưa build installer, chưa ký, chưa publish và chưa upload GitHub.
> Sau báo cáo phải dừng chờ chủ dự án duyệt danh sách và thứ tự sửa.

> **CẬP NHẬT SAU KHI ĐƯỢC DUYỆT:** các finding code trong báo cáo đã được xử lý theo lô và verify tự động.
> Báo cáo này giữ nguyên như ảnh chụp trạng thái trước sửa; kết quả hiện tại, test và proof gap còn lại nằm tại
> `docs/FREE_PRO_FIXES_2026-08-04.md`. Chưa build/publish release và chưa deploy Supabase.

## 1. Kết luận điều hành

**NO-GO cho phát hành công khai với lời khẳng định Free/Pro đã đóng kín.**

Ảnh người dùng gửi là lỗi thật, nhưng không chỉ là lỗi CSS mất chữ **Pro**. PrynX hiện có nhiều
cửa mở cùng một công cụ. Home và menu ứng dụng đi qua cổng quyền tập trung; menu trong workspace
và mini-toolbar lại ghi thẳng công cụ đang hoạt động. Vì vậy badge, hành vi khóa và test không đồng
nhất giữa các bề mặt.

Audit tĩnh tại commit `1fb8519d88400a0bb5ad670367b2a0f25e6ca5df` xác nhận:

- Catalog frontend và backend hiện **khớp 36/36 FeatureId**: 13 Free, 23 Pro.
- Token thiếu/sai `plan` hiện rơi về **Free**; sidecar đóng gói ép gate bật; public release đã cấm
  `SkipNuitka`, bỏ QA, worktree bẩn và version chưa commit. Đây là các lớp đã được sửa đúng.
- Tuy nhiên còn **21 finding**: **0 P0, 9 P1, 10 P2, 2 P3**.
- Các lỗi P1 tập trung ở: nhiều cửa vào UI bỏ qua gate; tool mới không được phân loại; tab Pro không
  bị khóa lại khi quyền đổi; `features[]` không được enforce đúng từng capability; hai Tauri command
  nghiệp vụ không có entitlement; Paper Library chỉ được bảo vệ bằng UI; gói giá PrynX mới trên web
  có thể không mang `license_plan`; và provenance của artifact còn race sau chốt Git cuối.
- Bộ test hẹp vẫn xanh (**22 frontend + 23 backend**) dù các lỗi trên tồn tại. Đây là bằng chứng rằng
  vấn đề chính là **coverage và kiến trúc nhiều nguồn chân lý**, không phải thiếu unit test đơn lẻ.

### Quy ước mức độ

- **P0:** sai/hỏng nghiệp vụ đang xảy ra chắc chắn hoặc mọi người dùng bị cấp sai quyền.
- **P1:** có thể mở/giữ nhầm quyền Pro, cấp sai gói, hoặc tạo/phát hành artifact không đáng tin.
- **P2:** quyền/UX lệch, custom grant sai, proof gap hoặc nợ kiến trúc có khả năng tái phát.
- **P3:** tài liệu, chẩn đoán và vệ sinh môi trường.

Không xếp P0 vì audit này chưa chứng minh toàn bộ khách Free đang dùng được toàn bộ Pro hoặc dữ liệu
production đã bị cấp sai. Finding website §WEB.01 vẫn là P1 nghiêm trọng vì đường code cho phép khách
mua Pro nhận license mặc định Free nếu gói mới không có plan.

## 2. Phạm vi và bằng chứng

### Repo PrynX

- Đường dẫn: `D:\pdfcompare`.
- HEAD: `1fb8519d88400a0bb5ad670367b2a0f25e6ca5df`.
- Năm file sửa dở từ đợt xử lý startup được giữ nguyên, không trộn vào audit:
  - `backend/tests/test_clean_user_verifier_policy.py`;
  - `desktop/src-tauri/src/lib.rs`;
  - `desktop/src-tauri/tauri.conf.json`;
  - `scripts/verify_artifact_clean_user.ps1`;
  - `scripts/verify_installed_artifact.ps1`.

### Repo PrintSolutions / Supabase

- Đường dẫn: `D:\printsolutions-main`.
- HEAD: `0150b77`.
- Worktree rất bẩn; audit chỉ đọc đúng các file liên quan license/package.
- Migration entitlement package `20260726110000_prynx_security_audit_fixes.sql` hiện là file **untracked**
  trong checkout được audit. Không suy diễn rằng migration hoặc Edge Function đã deploy production.

### Included

- Catalog Free/Pro và mapping registry.
- Mọi cửa mở tool đã tìm thấy: Home, Home compact, menu app, workspace ToolMenuList, mini-toolbar,
  tab/window/Ctrl+Tab, recovery, startup/drop và chuyển tool nội bộ.
- Frontend gate, FastAPI route gate, Tauri/native commands và client-only tools.
- `features[]`, plan/token, package → order → license trên PrintSolutions.
- Build flags, manifest, installed verifier, build nội bộ/public release và test coverage.
- Re-audit trạng thái finding Free/Pro ngày 2026-07-19.

### Excluded / proof gap

- Không build release hoặc installer nội bộ mới; không cài artifact mới.
- Không ký updater, không upload GitHub Release.
- Không đọc/sửa dữ liệu production Supabase; chưa xác nhận migration/function/trigger live.
- Không chạy UI runtime với một key Free và Pro thật; các finding UI được xác minh bằng trace code và
  test tĩnh/tập trung.
- Không cố chống mọi dạng crack local. Mục tiêu là quyền chính thống phải nhất quán và fail-closed theo
  threat model hiện có.

## 3. Ma trận hiện trạng

### 3.1 Catalog

| Nhóm | Số FeatureId | Trạng thái |
|---|---:|---|
| Free | 13 | FE/BE khớp |
| Pro | 23 | FE/BE khớp tên và plan |
| Tổng | 36 | Không có key lệch giữa hai catalog |

Trong 23 Pro feature:

| Kiểu enforcement thực tế | FeatureId |
|---|---|
| Gate riêng hoặc chọn theo mode | `pdf.resize_batch`, `pdf.office_batch`, `pdf.trim_shift`, `prepress.cutline`, `impo.booklet`, `impo.nup`, `impo.diecut`, `impo.cnc`, `packaging.dieline`, `util.bgremover`, `util.upscale`, `util.logo_rebuild`, `qc.compare_pdf` |
| Đi nhờ gate cha Preflight | `prepress.preflight`, `prepress.convert_colors`, `prepress.hairlines`, `prepress.trapping`, `prepress.pdfx` |
| Đi nhờ gate cha VDP | `vdp.datamerge`, `vdp.numbering`, `vdp.cover_numbering` |
| Chỉ chạy client | `prepress.paper_library` |
| Không có consumer quyền | `pdf.optimize_advanced` |

### 3.2 Cửa vào UI

| Cửa vào | Badge | Guard | Kết luận |
|---|---:|---:|---|
| Home đầy đủ | Có | `handleOpenApp` | Đúng, trừ tool không có mapping |
| Home compact | Có `PRO`, không phân biệt khóa | `handleOpenApp` | Chặn đúng, UX lệch |
| Menu “Công cụ” | Chỉ hiện `🔒 PRO` khi bị khóa | `handleOpenApp` | Chặn đúng; Pro/dev không thấy phân loại |
| `ToolMenuList` trong workspace | Không | Không | **Bypass frontend** |
| Mini-toolbar workspace | Không | Không | **Bypass frontend** |
| Tab bar / menu Cửa sổ / Ctrl+Tab | Không áp dụng | Không re-check | Tab Pro đã mở vẫn dùng sau downgrade |
| Recovery snapshot | Không áp dụng | Qua `handleOpenApp` | Đúng với key đã map |
| Startup/drop/context menu Explorer | Không áp dụng | Có khi tạo tab | Không thấy bypass độc lập |

## 4. Findings

### §UI.01 — [VERIFIED] P1 / M — Hai menu workspace bỏ qua gate và badge

- `desktop/src/components/imposition-tools/ToolMenuList.tsx:36-42` lấy routing key rồi gọi thẳng
  `setActiveTool`.
- `desktop/src/components/ImpositionTab.tsx:2864-2948` làm tương tự cho favorite/category mini-toolbar.
- Cổng đúng nằm ở `desktop/src/App.tsx:535-542`, nhưng hai đường trên không đi qua nó.
- Setter gốc nhận chuỗi rộng tại
  `desktop/src/components/imposition-tools/store/slices/workspaceSlice.ts:69`.

**Ảnh hưởng:** Free có thể mở panel Pro; backend có thể chặn lúc thực thi, nhưng UX báo sai và mọi
tool client-only hoặc native thiếu secondary gate trở thành đường vượt quyền thực tế.

**Gốc rễ:** routing được thiết kế trước Free/Pro; entitlement được ghép vào một số entry point thay vì
đặt tại một lệnh kích hoạt duy nhất.

### §UI.02 — [VERIFIED] P1 / S — 2/34 tool key đang bật không có phân loại entitlement

- `font_tools` được đăng ký tại `desktop/src/lib/toolRegistry.ts:220` nhưng không có trong
  `featureIdForFocus()` (`desktop/src/lib/license/features.ts:76-90`).
- `App.handleOpenApp` chỉ guard khi map trả về FeatureId; `null` là fail-open (`App.tsx:537`).
- `FontToolsTool` gọi API `/preflight`, trong khi cả router bị gate `prepress.preflight` tại
  `backend/app/api/routes/preflight.py:93`. Kết quả là Home không hiện Pro, Free mở được panel rồi nhận
  403 khi chạy.
- `crop` cũng không có mapping. Phân loại Free/Pro chưa được chốt; UI mở ngầm, còn API crop nằm dưới
  router Preflight Pro. OCR đang tắt có cùng nợ tiềm ẩn nếu bật lại.

### §UI.03 — [VERIFIED-STATIC] P1 / M — Đổi/hạ quyền không re-check tab và tool đang mở

- Store cập nhật plan/features tại `desktop/src/stores/useAuthStore.ts:631-636`.
- Kích hoạt tab, menu Cửa sổ và Ctrl+Tab chỉ đổi `activeTabId`; các tab tiếp tục mounted tại
  `desktop/src/App.tsx:941`, `:1093`, `:1343`, `:1383-1387`.
- Dieline xuất PDF từ model đang giữ ở client tại
  `desktop/src/components/dieline-tool/DielineTool.tsx:344-375`.
- Paper Library chạy hoàn toàn local, không đọc entitlement tại
  `desktop/src/components/paper-library/PaperLibraryTool.tsx:233`.

**Kịch bản:** mở tool bằng Pro → server/admin hạ quyền hoặc đổi sang key Free → tab vẫn dùng/chuyển lại
được; model Dieline đã sinh vẫn xuất được và Paper Library tiếp tục hoạt động.

### §UI.04 — [VERIFIED] P2 / S — Badge Pro không có semantics thống nhất

- Home đầy đủ luôn hiện `PRO`, thêm khóa nếu bị từ chối (`HomeTab.tsx:103`).
- Home compact chỉ hiện `PRO` (`HomeTab.tsx:61-83`).
- Menu app chỉ nối `🔒 PRO` khi `locked=true` (`App.tsx:1113`).
- Hai menu workspace không có badge.

Đây là nguyên nhân trực tiếp khiến cùng một bản cài có chỗ thấy Pro, chỗ không thấy.

### §UI.05 — [VERIFIED] P2 / S — Tool standalone bị đưa vào router workspace và click không mở đúng

- `ToolMenuList` chỉ loại category `qc` và `combine_pdf`
  (`ToolMenuList.tsx:50-51,98-103`).
- Dieline và Paper Library vẫn xuất hiện dù không thuộc `ActiveToolType`; dashboard ép key lạ về
  `none` tại `desktop/src/components/imposition-tools/ImposerDashboard.tsx:206`.

**Ảnh hưởng:** item nhìn như dùng được nhưng click no-op/sai màn hình, đồng thời không có toast quyền.

### §UI.06 — [VERIFIED] P2 / S — UI gộp hai quyền batch khác nhau

- `OfficeConvertTool` chỉ tính `canBatch` từ `pdf.office_batch`
  (`desktop/src/components/preprocess-tools/OfficeConvertTool.tsx:113-115`).
- Cùng vùng batch lại hiện resize hàng loạt (`:1112`), trong khi backend enforce riêng
  `pdf.resize_batch` tại `backend/app/api/routes/office_convert.py:435-452`.

Với Free key được cấp ngoại lệ một feature, UI có thể hiện thao tác backend từ chối hoặc giấu thao tác
đã được cấp.

### §BE.01 — [VERIFIED] P1 / M — `features[]` không được enforce đúng từng capability

- Cả router VDP yêu cầu `vdp.datamerge` (`backend/app/api/routes/vdp.py:45`).
- Cả router Preflight yêu cầu `prepress.preflight` (`backend/app/api/routes/preflight.py:93`).
- Do đó grant riêng `vdp.numbering` hoặc `prepress.convert_colors` vẫn bị từ chối; grant feature cha
  lại mở thêm numbering/cover hoặc hairlines/trapping/PDF-X.
- Sticker gọi cả endpoint `prepress.cutline` (`pdf_tools.py:1257`) và
  `/preflight/mirror-bleed` (`StickerTool.tsx:346,420`), nên grant `prepress.cutline` đơn lẻ không đủ chạy
  trọn workflow.
- Tài liệu lại khẳng định `features[]` cấp ngoại lệ từng tính năng
  (`docs/PRYNX_FREE_PRO.md:27`).

Đây là finding cũ LIC-005 **chưa đóng**, không chỉ là UX.

### §BE.02 — [VERIFIED] P1 / M — Paper Library Pro chỉ được bảo vệ ở WebView

- `prepress.paper_library` được xếp Pro trong cả hai catalog.
- Dữ liệu, lookup và công thức nằm toàn bộ ở `desktop/src/lib/paperLibrary/`.
- Component không gọi backend/Tauri và không tự re-check quyền.

Theo threat model, UI không phải biên cưỡng chế. Cần chốt một trong hai hướng: chuyển capability có giá
trị sang native/sidecar có gate; hoặc ghi nhận đây là accepted commercial risk và vẫn thêm component
guard/re-check để hành vi chính thống đúng.

### §BE.03 — [VERIFIED] P1 / S — Hai Tauri command nghiệp vụ không có entitlement và không có consumer

- `solve_layout` gọi trực tiếp `imposition_core` tại `desktop/src-tauri/src/lib.rs:1776-1790`.
- `strip_diecut_lines` sửa PDF tại `desktop/src-tauri/src/pdf_engine/diecut.rs:6-87`.
- Cả hai được expose trong `generate_handler!` tại `desktop/src-tauri/src/lib.rs:2245`.
- Không tìm thấy consumer frontend/backend tương ứng.

Một WebView bị sửa có thể invoke command đã expose mà không đi qua `sign_api_request` hay
`require_feature`. Nếu thật sự là dead command, hướng an toàn nhất là gỡ khỏi handler; nếu còn dùng thì
phải gắn native entitlement phù hợp.

### §BE.04 — [VERIFIED] P2 / S — Catalog có capability mồ côi và mapping không phản ánh sản phẩm thật

- `pdf.optimize_advanced` vẫn là Pro trong FE/BE catalog.
- UI chỉ map `optimize → pdf.optimize` Free; backend và test ghi rõ toàn bộ preset/custom/grayscale
  Optimize hiện là Free (`backend/tests/test_free_token_e2e.py:131-133`).
- Tài liệu lại nói Free chỉ có “nén cơ bản”.
- `pdf.decrypt` không có routing riêng vì dùng chung tool Encrypt/Decrypt; `pdf.resize_batch` chỉ được
  kiểm bên trong Office tool chứ không có entry mapping độc lập.

Cần quyết định sản phẩm rồi xóa FeatureId chết hoặc tách capability thật; không để catalog quảng bá
một quyền không có consumer.

### §WEB.01 — [VERIFIED-CODE / LIVE UNKNOWN] P1 / M — Gói PrynX mới có thể cấp license Free dù bán Pro

- Migration thêm `pricing_packages.license_plan` và `license_features` tại
  `D:\printsolutions-main\supabase\migrations\20260726110000_prynx_security_audit_fixes.sql:238-246`.
- Trigger chỉ cập nhật license khi `package_plan IS NOT NULL` (`:308-335`).
- Backfill đặt các package PrynX **đã tồn tại** thành Pro (`:248-253`), nhưng package tạo mới sau đó có
  thể vẫn `NULL`.
- `AdminPricingPackages.tsx`, `PricingPackage` và Supabase generated types không có hai trường này;
  create/update package không gửi entitlement.
- License PrynX mới mặc định Free. Vì vậy một package Pro mới được tạo từ UI admin có thể để plan null;
  khi order tạo license, trigger bỏ qua và khách trả tiền nhận Free.

Đây là lỗi vận hành nghiêm trọng nhất của chuỗi bán hàng. Admin license riêng lẻ vẫn sửa plan thủ công,
nhưng đó không phải cơ chế provisioning đáng tin.

### §WEB.02 — [VERIFIED] P2 / M — Không có contract/type/test package → license

- `src/types/database.ts:189-207` và generated `src/integrations/supabase/types.ts:369-428` thiếu
  `license_plan`/`license_features`.
- `src/hooks/usePricingPackages.ts:39-59` không nhận hai trường entitlement.
- Không tìm thấy test cho: tạo package Free/Pro → tạo order → gắn license → token trả đúng
  plan/features; cũng không có test package null phải fail-closed.

### §BLD.01 — [VERIFIED] P1 / S — Artifact có thể bị gắn sai provenance sau chốt Git cuối

- `build_production.ps1` kiểm source ở đầu và trước Tauri build (`:208`, `:1179`).
- Sau khi Tauri hoàn tất không kiểm lại; manifest đọc `HEAD` và dirty state tại thời điểm ghi
  (`:1315-1316`).
- `release_update.ps1` không đối chiếu `GIT_COMMIT`/`GIT_DIRTY` của manifest trước upload.

Nếu IDE/agent khác sửa hoặc commit trong lúc Tauri build, artifact có thể được gắn nhầm commit hoặc
được upload dù manifest ghi dirty. Test hiện chỉ đếm số lần chuỗi `Assert-ReleaseSourceState`, nên
không chứng minh chốt sau build.

### §BLD.02 — [VERIFIED] P2 / S — Manifest/verifier không chứng minh frontend gate đã bật

- Frontend mặc định fail-open khi thiếu `VITE_FEATURE_GATING_ENABLED=true`
  (`desktop/src/lib/license/features.ts:49,71-72`).
- Luồng chính thức set đúng hai flag (`build_production.ps1:310-315`).
- Nhưng `npm run build` / Tauri `beforeBuildCommand` vẫn có thể được gọi trực tiếp với mặc định gate-off.
- Manifest chỉ ghi frontend hash (`build_production.ps1:1323`), không ghi trạng thái gate; installed
  verifier không chạy một kịch bản Free bị từ chối.

Đây là phần còn lại của LIC-001: đường chính đúng, artifact chưa tự chứng minh điều đó.

### §BLD.03 — [VERIFIED] P2 / S — Dev backend không nhận gate từ `.env` như tài liệu ngụ ý

- `.env.example` khai `PRYNX_FEATURE_GATING_ENABLED=false`.
- `feature_entitlements.py:8-13` đọc trực tiếp `os.getenv()` lúc import.
- `run_dev.bat` chép `.env` nhưng không export biến vào process; Pydantic đọc `.env` không tự ghi lại
  `os.environ`.

Kết quả là vòng dev thường gate-off và không tái hiện behavior release, nên bypass UI dễ lọt đến cuối.
Nên có một chế độ dev-gated chính thức đặt cả frontend/backend flag qua process environment.

### §BLD.04 — [VERIFIED] P2 / M — Build nhanh nội bộ có thể đóng gói sidecar cũ

- Public `-Release` đã từ chối `SkipNuitka` — phần phát hành công khai an toàn.
- Nhánh nội bộ `-SkipNuitka` chạy QA trên runtime dev đang active rồi chỉ yêu cầu sidecar cũ tồn tại
  (`build_production.ps1:321-330`).
- Không có provenance source hash/commit/version chứng minh sidecar được đóng từ cùng code với frontend.

Installer nội bộ vì vậy có thể trộn UI mới với backend entitlement cũ và tạo cảm giác QA đã kiểm đúng
payload. Đây là residual của LIC-008.

### §BLD.05 — [VERIFIED] P3 / S — Biến môi trường build không được restore đầy đủ

`VITE_FEATURE_GATING_ENABLED`, `PRYNX_FEATURE_GATING_ENABLED`, hai integrity hash, `DEV_MODE`,
`PYTHONIOENCODING` và `NUITKA_CACHE_DIR` không được bọc trong một top-level `try/finally`. GUI giữ cửa
sổ bằng `-NoExit` (`quanly_phathanh.ps1:187`), nên lệnh dev/cargo tiếp theo có thể thừa hưởng trạng thái
release và cho kết quả chẩn đoán sai.

### §TEST.01 — [VERIFIED] P1 / M — Test entry point tạo an toàn giả

- Test mang tên “map đủ toàn bộ tool đang hiển thị” dùng danh sách hard-code 32 key và bỏ đúng
  `crop`, `font_tools` (`desktop/src/lib/license/features.test.ts:56-68`).
- Không có component/integration test cho `ToolMenuList`, mini-toolbar, menu app hoặc hành vi downgrade.
- TypeScript không bắt được drift vì `defaultPayload` là `any`, routing key là string và mapping nằm ở
  file khác.

Test catalog xanh không đồng nghĩa mọi cửa mở tool đã được khóa.

### §TEST.02 — [VERIFIED] P2 / M — Signed Free-token E2E và artifact smoke chưa phủ đủ

- `test_free_token_e2e.py:110-171` kiểm 7/23 Pro FeatureId: trim-shift, hai batch và bốn mode imposition.
- Dieline/logo có test route riêng nhưng không thay thế ma trận signed-token production cho toàn bộ
  preflight, VDP, cutline, AI và QC.
- `--artifact-self-test`/installed smoke chưa khẳng định frontend gate on hoặc Free nhận 403 từ sidecar
  đóng băng.

### §TEST.03 — [VERIFIED] P2 / S — Hai catalog cùng tự nhận là nguồn chân lý nhưng không có parity test

- `desktop/src/lib/license/features.ts:1` và
  `backend/app/core/feature_entitlements.py:1` đều là danh mục duy nhất nhưng được bảo trì thủ công.
- Hôm nay 36/36 đang khớp; không có test cross-language khiến thêm tool mới lệch một phía phải fail QA.

Đây là LIC-012 chưa đóng về kiến trúc, dù dữ liệu hiện tại đang đúng.

### §DOC.01 — [VERIFIED] P3 / S — Tài liệu/comment nói ngược hành vi fail-closed hiện tại

- `docs/PRYNX_FREE_PRO.md:24-27` nói token thiếu plan được hiểu là Pro; code hiện fallback Free.
- `desktop/src/stores/useAuthStore.ts:183` comment “mặc định Pro”; state thực tế fallback Free.
- `docs/CAU_HINH_ENV.md:32` ghi gate backend mặc định bật, trong khi source dev/example mặc định tắt.
- `desktop/src-tauri/src/lib.rs:2505` còn comment rollout mặc định false trong khi release fallback true.

Tài liệu stale làm người phát triển chọn sai giả định và dễ tái tạo lỗi.

## 5. Trạng thái re-audit finding 2026-07-19

| Finding cũ | Trạng thái 2026-08-04 | Ghi chú |
|---|---|---|
| LIC-001 gate mặc định off | **Đóng phần production / còn residual** | Sidecar compiled và build chính thức bật; artifact chưa attest frontend |
| LIC-002 thiếu gate endpoint Pro | **Đã đóng cho route đã nêu** | Trim, batch, imposition, dieline, AI/QC đã có gate |
| LIC-003 missing/invalid plan → Pro | **Đã đóng** | Edge/desktop/backend fallback Free |
| LIC-004 TTL revoke 7 ngày | **Giảm rủi ro / policy accepted** | Edge code hiện 72h; live deploy chưa xác minh |
| LIC-005 gate sai FeatureId | **Còn mở** | Preflight/VDP vẫn gate theo router cha |
| LIC-006 Dieline UI-only | **Đóng phần generate / residual** | Generate qua backend/native gate; export model đã mở và downgrade chưa re-check |
| LIC-007 Cargo không invalidate flag | **Đã đóng** | `build.rs` có `rerun-if-env-changed` |
| LIC-008 SkipNuitka stale | **Đóng public / còn nội bộ** | Release cấm; internal fast build chưa có provenance |
| LIC-009 Rust cache token advisory | **Đã đóng** | Release `register_validated_key` fail-closed |
| LIC-010 offline revoke | **Accepted design** | Token là authority trong grace; TTL đã giảm |
| LIC-011 license mặc định Pro | **Đã đóng** | License mới mặc định Free; phát sinh lỗi package mới §WEB.01 |
| LIC-012 dual catalog | **Còn mở** | Hôm nay khớp nhưng chưa single-source/parity test |
| LIC-013 `canUse` mặc định Pro | **Đã đóng** | Mặc định Free |
| LIC-014 localhost residual | **Accepted risk** | Sidecar token + signed license vẫn là backstop |
| LIC-015/016 RLS/rate limit | **Code ổn / live unknown** | Không kiểm production trong audit này |
| LIC-017 downgrade installer | **Ngoài trọng tâm / chưa chứng minh** | Cần audit updater riêng nếu muốn đóng |
| LIC-018 docs | **Còn mở** | §DOC.01 |

## 6. Kiểm thử đã chạy

Không chạy build release.

| Gate | Kết quả | Ghi chú |
|---|---:|---|
| Frontend: catalog, registry routing, token claims, license key | **22 passed / 4 files** | Chạy bằng Vitest trên Windows |
| Backend: feature catalog, signed Free-token, dieline, logo, imposition | **23 passed** | 2 warning deprecation, không có fail |
| FE/BE catalog parity audit | **36/36 khớp** | Kiểm tĩnh; chưa thành regression test |
| Registry coverage audit | **34 enabled key; thiếu 2** | `crop`, `font_tools` |
| Release/public build | **Không chạy** | Theo yêu cầu không build/publish |
| Supabase production | **Không kiểm** | Không đọc/sửa dữ liệu live |

Việc test xanh nhưng finding vẫn tồn tại là một kết quả audit quan trọng: suite hiện kiểm hàm catalog
và một phần endpoint, chưa kiểm hành trình người dùng qua mọi entry point hoặc provisioning thực tế.

## 7. Quick wins ưu tiên

1. Bắt buộc `ToolDefinition.featureId: FeatureId`; tool enabled thiếu phân loại phải làm typecheck/test fail.
2. Tạo một `requestToolActivation()` duy nhất cho Home, menu app, ToolMenuList, mini-toolbar, favorite,
   preset và chuyển nội bộ.
3. Dùng một component badge/lock chung; quy ước rõ `PRO` là phân loại, `🔒` là trạng thái không có quyền.
4. Chốt `crop` là Free hay Pro; map `font_tools` rõ ràng; xóa hoặc hiện thực `pdf.optimize_advanced`.
5. Enforce capability cụ thể trong VDP/Preflight thay vì router cha; sửa workflow Sticker và Office batch.
6. Gỡ hai Tauri command chết hoặc gắn native entitlement.
7. Bắt `license_plan` không null cho package PrynX; bổ sung field admin/type và test package→license→token.
8. Thêm trạng thái gate frontend/backend vào manifest và artifact self-test; Free-token smoke phải chạy trên
   sidecar đóng băng/installer.
9. Chốt Git lại sau Tauri build và uploader đối chiếu commit/dirty từ manifest.

## 8. Kế hoạch sửa theo lô (mỗi lô ≤5 file)

### Lô 1 — Nguồn chân lý catalog và registry

- Thêm `featureId` typed vào `ToolDefinition`; phân loại mọi tool enabled.
- Chốt Crop/Font/Optimize; thêm parity/registry test sinh trực tiếp từ registry.
- Không đổi behavior backend ở lô này ngoài catalog đã được duyệt.
- Verify: typecheck + Vitest catalog/registry.

### Lô 2 — Một cửa kích hoạt UI và badge thống nhất

- Tạo helper/hook kích hoạt có entitlement.
- Chuyển `App`, `ToolMenuList`, mini-toolbar và Home/badge sang cùng helper/component.
- Loại standalone tool khỏi router workspace hoặc route đúng về tab độc lập.
- Verify: component matrix Free/Pro/custom grant cho từng entry point.

### Lô 3 — Re-check khi quyền đổi và client-only tools

- Re-evaluate tab/active tool khi plan/features đổi.
- Giữ dữ liệu chưa lưu bằng overlay nâng cấp thay vì đóng cưỡng bức.
- Guard trước Dieline export và Paper Library; ghi rõ accepted risk nếu Paper Library vẫn client-only.
- Verify: Pro→Free, Free→Pro, token refresh/offline và tab có dữ liệu.

### Lô 4 — Backend capability chính xác

- Tách guard VDP numbering/cover/datamerge.
- Tách guard các action Preflight; sửa Sticker và Office batch theo capability thực.
- Verify signed-token matrix cho Free, Pro và từng custom grant.

### Lô 5 — Native/Tauri authority

- Gỡ `solve_layout`/`strip_diecut_lines` nếu dead; nếu dùng thì thêm gate native có token đã verify.
- Verify cargo test/check + thử invoke Free/Pro.
- Lô này cần build lại Tauri; chưa cần Nuitka nếu không đổi sidecar.

### Lô 6 — PrintSolutions package provisioning

- Bổ sung schema/type/form cho `license_plan`/`license_features`.
- Constraint/trigger fail-closed với package PrynX thiếu plan.
- Test package Free/Pro/custom grant → order → license → Edge token.
- Chỉ deploy migration/function sau khi review SQL và backup.

### Lô 7 — Build provenance và artifact attestation

- Chốt Git sau Tauri build, capture commit từ đầu, uploader đối chiếu manifest.
- Ghi gate mode/ABI/build mode vào manifest; artifact self-test và installed smoke kiểm Free 403.
- Loại hoặc fingerprint `SkipNuitka` nội bộ; restore env bằng `try/finally`.
- Verify PowerShell policy tests; không publish.

### Lô 8 — Tài liệu và full regression

- Sửa `PRYNX_FREE_PRO.md`, `CAU_HINH_ENV.md` và comment stale.
- Chạy typecheck, full Vitest, backend entitlement suite, cargo check/test liên quan.
- Cuối cùng mới build nội bộ đầy đủ để cài thử; public release chỉ sau clean-user smoke và duyệt riêng.

## 9. Tiêu chí GO sau khi sửa

Chỉ gọi Free/Pro sẵn sàng khi đồng thời đạt:

- 100% tool enabled có FeatureId typed và cùng badge/guard ở mọi entry point.
- Free không đổi active tool khi click Pro; Pro mở được; custom grant chỉ mở đúng capability.
- Pro→Free khóa lại tab/tool local mà không mất dữ liệu chưa lưu.
- 23/23 Pro FeatureId có authority rõ: backend/native hoặc accepted risk được ghi nhận.
- Package Free/Pro/custom grant cấp đúng license/token; package PrynX thiếu plan bị từ chối.
- Artifact manifest chứng minh hai gate bật; sidecar đóng băng nhận signed Free token và trả 403 cho Pro.
- Artifact gắn đúng commit sạch trước/sau build; không dùng sidecar cũ không có provenance.
- Installed smoke sạch đạt; **không upload GitHub** cho tới khi chủ dự án duyệt test nội bộ.

---

**Trạng thái tại chốt 1:** báo cáo hoàn tất; chờ duyệt trước khi sửa.
