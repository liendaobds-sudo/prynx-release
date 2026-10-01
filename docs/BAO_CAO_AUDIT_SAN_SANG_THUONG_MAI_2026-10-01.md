# Báo cáo đánh giá PrynX cho sản phẩm thương mại — 2026-10-01

## 1. Kết luận điều hành

**Kết luận: NO-GO cho phát hành công khai ở trạng thái hiện tại.** PrynX đã có nền tảng tốt để chạy pilot có kiểm soát trong xưởng, nhưng chưa có bằng chứng đủ cho một bản cài thương mại mà khách hàng có thể dùng an toàn, ổn định và hỗ trợ được.

Các lý do chặn phát hành:

1. Worktree hiện có **124 mục thay đổi** trên commit `d1f8b62`; các thay đổi trải từ backend, desktop, Rust, test, generated bundle đến audit docs. Chưa có một source baseline sạch để tái lập installer.
2. Endpoint `/api/results/*` đang được mount tĩnh nhưng middleware chỉ bảo vệ `/results/*`; file kết quả có thể tải mà không có chữ ký `access`.
3. Renderer có quyền ghi `$APPDATA/**`, trong khi allowlist ứng dụng ngoài được lưu ở `design-apps-approved.json`; đây là đường cần khóa trước khi coi renderer là vùng không tin cậy.
4. CI kiểm `createUpdaterArtifacts=true`, nhưng `tauri.release.conf.json` đặt `false` và `build_production.ps1` cũng yêu cầu `false`. Chính sách release hiện mâu thuẫn.
5. CI chưa build/cài/smoke installer Windows; nhiều luồng quan trọng mới đạt `SOURCE`, `AUTO` hoặc `ARTIFACT-PARTIAL`, chưa đạt `RUNTIME` trên bản cài.
6. VDP đã tạo được 5.000 trang trong profile, nhưng peak khoảng **13,37 GiB** với 15 worker và profile 10.000 record bị chặn bởi `WinError 1455`. Chưa công bố được giới hạn sản xuất và SLO theo máy.

**Phân loại sản phẩm hiện tại:** `advanced internal alpha / controlled pilot`, chưa phải `public commercial release`.

## 2. Phạm vi và mức bằng chứng

- Đã đọc `AGENTS.md`, `prynx-audit-workflow`, `prynx-architecture`, `prynx-deep-audit`, `prynx-security-review`, `prynx-testing`, `prynx-build-release`, `prynx-conventions`.
- Đã đối chiếu `audit-rules.md`, `docs/PRYNX_MASTER_AUDIT_MATRIX.md` và các báo cáo audit gần nhất.
- Đã kiểm source hiện tại, cấu hình Tauri/CI/release, route/guard, job registry, feature flags, README, số liệu VDP và trạng thái Git.
- Không chạy build production, không deploy Supabase, không reset license, không thay đổi code nghiệp vụ. Vì vậy các mục ghi `RUNTIME` hoặc `EXTERNAL` vẫn là khoảng trống, không được suy diễn từ unit test.

## 3. Scorecard thương mại

| Nhóm | Trạng thái | Nhận xét ngắn |
|---|---|---|
| Giá trị sản phẩm | 🟡 | Bộ công cụ prepress rộng, có khác biệt ở dieline, imposition, VDP và PPE. |
| Correctness file xuất | 🔴/🟡 | Nhiều luồng lõi đã có golden/artifact, nhưng còn finding P1 và nhiều parity chưa có runtime. |
| Viewer/UX thực tế | 🟡 | Có viewer nhiều tầng và recovery, nhưng GPU/PPE handoff, màu và clean-install còn HOLD. |
| Kiến trúc | 🟡 | Tách desktop–sidecar–native rõ; route/worker monolith và contract thủ công làm tăng rủi ro hồi quy. |
| Bảo mật | 🔴/🟡 | License/sidecar HMAC khá mạnh; còn đường bảo vệ artifact, localfile và allowlist EXE cần đóng. |
| Hiệu năng | 🟡/🔴 | RAM gate/PDFium lock được thiết kế tốt; VDP bulk và heavy-PDF chưa có ngưỡng thương mại được chứng minh. |
| Test/CI | 🔴 | Test nhiều nhưng CI/release chưa chứng minh installer Windows; coverage định lượng chưa có. |
| Build/provenance | 🔴 | Release sạch có guard, nhưng worktree hiện tại bẩn, CI và overlay updater mâu thuẫn, Authenticode chưa có. |
| Tài liệu/hỗ trợ | 🔴/🟡 | Có README và kênh hỗ trợ trong app; thiếu ma trận hỗ trợ, EULA, privacy, giới hạn và quy trình rollback. |

## 4. Findings ưu tiên

### §COMM.REL.01 — P1 — Baseline release không sạch

**[CONFIRMED — source state]** `git status --porcelain` hiện có 124 mục (`92` modified, `32` untracked) trên nhánh `codex/pre-release-audit-2026-08-04`. Danh sách gồm mã nguồn, test, snapshot, generated bundle và report. Trong khi đó `build_production.ps1:538-547` và `release_update.ps1:105-114` yêu cầu worktree sạch cho release.

**Tác động:** không biết installer nào chứa lô sửa nào; rollback, support và đối chiếu hash không đáng tin. Guard đang chặn đúng, nhưng sản phẩm chưa có một release candidate hợp lệ.

**Việc cần làm:** tách/duyệt các lô, commit đúng file, build từ clean checkout, đối chiếu manifest–native–sidecar–frontend và chạy installed smoke.

### §COMM.SEC.01 — P1 — `/api/results` bypass chữ ký artifact

**[CONFIRMED static; runtime HTTP test còn thiếu]** `backend/app/main.py:360-367` chỉ gọi `verify_result_access` khi path bắt đầu bằng `/results/`. Ngay sau đó `main.py:370-373` mount cả `/results` và `/api/results` tới cùng thư mục. Frontend tải qua `/api/results/{name}` tại `desktop/src/lib/api.ts:1979,2011`. Hàm ký trong `backend/app/core/license_guard.py:577-602` cũng chỉ chấp nhận `/results/`.

**Tác động:** một tiến trình hoặc renderer đã chiếm quyền trên cùng máy có thể đọc PDF/ảnh kết quả nếu đoán hoặc biết tên file, không cần `access=`. Đây là rò rỉ dữ liệu khách hàng và phá hợp đồng ownership của artifact.

**Việc cần làm:** bỏ alias `/api/results`, hoặc bảo vệ cả hai prefix bằng cùng một verifier; thêm test GET không ký và test path traversal/filename không đoán được.

### §COMM.SEC.02 — P1 — Allowlist EXE có thể bị renderer ghi đè

**[SUSPECTED — static, confidence cao; cần Tauri repro an toàn]** `desktop/src-tauri/capabilities/default.json:139-145` cấp `fs:allow-write-file` cho toàn `$APPDATA/**`. `desktop/src-tauri/src/external_app.rs:165-175` lưu allowlist ở `design-apps-approved.json`; `:219-249,263-275` coi path đã có trong file là `AlreadyApproved`, rồi `:279-359` gọi `Command::new(&app_path).spawn()`.

**Tác động:** nếu renderer bị XSS hoặc bị chèn script, nó có thể ghi path EXE của payload vào allowlist rồi yêu cầu native khởi chạy payload với quyền người dùng. Hiện chưa có proof chạy trên Tauri thật nên giữ trạng thái `SUSPECTED`, nhưng đây là ranh giới tin cậy quan trọng.

**Việc cần làm:** chuyển registry sang native-only/DPAPI hoặc file có MAC; bỏ quyền renderer ghi file này; dùng opaque app ID từ picker native và kiểm signer/hash trước khi spawn.

### §COMM.SEC.03 — P2/P1 theo threat model — `localfile://` thiếu grant theo file

**[SUSPECTED — static]** `desktop/src-tauri/src/lib.rs:9171-9273` nhận path từ URL renderer, cho đọc nhiều loại file (`pdf`, ảnh, font, Office, `json`, `txt`) và chỉ chạy denylist `is_sensitive_path`; không có selection token hoặc kiểm `app.fs_scope().is_allowed`. CSP tại `desktop/src-tauri/tauri.conf.json:48` mở `localfile.localhost` và `localfile:`.

**Tác động:** renderer bị chiếm quyền có thể đọc các file người dùng không thuộc tài liệu đã chọn rồi gửi ra ngoài qua mạng. Denylist bảo vệ secret phổ biến nhưng không thay thế quyền theo file.

**Việc cần làm:** cấp grant một lần theo file đã picker, kiểm canonical scope ở native, giới hạn loại nội dung và kích thước; thêm negative test trên WebView.

### §COMM.SEC.05 — P2 — Kiểm toàn vẹn frontend bị bỏ qua trong bản cài bình thường

**[CONFIRMED static residual]** `desktop/src-tauri/src/lib.rs:7469-7475` yêu cầu hash frontend, nhưng `:7484-7514` trả `Ok(())` khi bản cài dùng asset frontend nhúng và không có thư mục `dist/` trên đĩa. Comment tại đây ghi rõ kiểm hash thư mục không áp dụng; nhánh startup `:8732-8739` vẫn báo `OK (or skipped — embedded)`. Cơ chế Authenticode được nhắc tới ở `:7507-7510` chưa bật.

**Tác động:** người có quyền ghi trên máy có thể sửa UI/JavaScript hoặc binary để né các chốt phía client. Sidecar/license vẫn giới hạn nhiều chức năng server-backed, nên đây chủ yếu là rủi ro crack và tamper cục bộ, nhưng cần được định danh trong threat model thương mại.

**Việc cần làm:** ký và kiểm Authenticode cho binary/installer, hoặc kiểm digest asset nhúng bằng manifest được ký; nếu chấp nhận rủi ro này thì ghi rõ phạm vi anti-tamper trong EULA và tài liệu hỗ trợ.

### §COMM.REL.02 — P1 — CI và release overlay mâu thuẫn về updater

**[CONFIRMED static]** `.github/workflows/ci.yml:224-230` fail nếu `tauri.release.conf.json` không có `createUpdaterArtifacts=true`. File `desktop/src-tauri/tauri.release.conf.json:5-8` đặt `false`, còn `build_production.ps1:2282-2284` cũng throw nếu overlay là `true`.

**Tác động:** CI không thể là tín hiệu release đáng tin; một bên sẽ luôn đỏ hoặc policy updater bị hiểu sai. Đây là lỗi quy trình phát hành, không phải cảnh báo lý thuyết.

**Việc cần làm:** chọn một policy duy nhất (release public có updater ký hay chỉ installer nội bộ), sửa CI và build overlay cùng một hợp đồng, rồi thêm test parse cấu hình.

### §COMM.REL.03 — P1 — CI chưa chứng minh installer Windows

**[CONFIRMED — pipeline inspection]** `.github/workflows/ci.yml:9-364` chạy backend/frontend/cargo/security chủ yếu trên Ubuntu; job Windows chỉ build native wheel và chạy một nhóm PPE test ở `:151-196`. Job tag `release-integrity-gate` ở `:366-390` chỉ kiểm secret hash, không build NSIS, cài installer, chạy `verify_installed_artifact.ps1` hoặc smoke profile sạch.

**Tác động:** CI xanh vẫn có thể ship lỗi sidecar/Nuitka/resource/CSP/WebView2/NSIS/updater mà dev không thấy.

**Việc cần làm:** thêm Windows release-candidate job, có build từ clean checkout, cài profile sạch, smoke mở PDF/sidecar/PDFium/OCR, verify manifest và lưu log/hash.

### §COMM.REL.07 — P1 — Release integrity gate không chạy theo tag

**[CONFIRMED static]** `.github/workflows/ci.yml:3-7` chỉ khai báo trigger `push` cho nhánh `main` và `pull_request`, không có `push.tags` hoặc `workflow_dispatch`. Trong khi đó job `release-integrity-gate` tại `:366-390` chỉ chạy khi `startsWith(github.ref, 'refs/tags/')`. Vì vậy đường phát hành bằng tag không tự nhận được gate hash/provenance này.

**Tác động:** một tag có thể tạo release mà không chạy kiểm tra integrity được thiết kế cho release; đây là lỗ hổng quy trình, dù build script cục bộ có guard.

**Việc cần làm:** thêm trigger tag và đường chạy thủ công có quyền hạn tối thiểu, hoặc tách release workflow; kiểm bằng workflow-event test rằng tag thật sự chặn khi manifest/hash sai.

### §COMM.REL.04 — P1/P2 — Release QA bỏ sót test `cut_export`

**[CONFIRMED static]** `scripts/run_release_qa.ps1:191-193` chạy `python -m pytest -q` trong `backend`; `backend/pytest.ini:5-7` đặt `testpaths = tests`. Trong khi CI phải liệt kê thêm `app/workers/cut_export/tests/` tại `.github/workflows/ci.yml:29-34`.

**Tác động:** release gate có thể xanh dù hợp đồng máy bế/CNC ngoài `tests/` bị hỏng.

**Việc cần làm:** làm release QA dùng đúng danh sách test của CI hoặc cấu hình testpaths chung; ghi manifest phạm vi test vào artifact.

### §COMM.REL.05 — P1/P2 — Preflight QA tự ghi đè fixture vàng

**[CONFIRMED static]** `backend/scripts/run_preflight_qa.sh:11-12` luôn gọi generator. `backend/tests/preflight_fixtures/generate_fixtures.py:443-454` ghi lại các PDF fixture và `expected_rules.json` đã theo dõi trong Git.

**Tác động:** QA có thể tự làm thay đổi oracle trước khi so sánh; drift của golden bị che và build không còn read-only đối với source/test.

**Việc cần làm:** tách lệnh “regenerate fixture” khỏi CI; CI chỉ kiểm hash/existence và `git diff --exit-code`.

### §COMM.REL.06 — P1 — Installer chưa có Authenticode

**[CONFIRMED by manifest contract]** `build_production.ps1:2724` ghi rõ `CODE_SIGNED = no (Windows Authenticode not configured; updater .sig is separate)`. `release_executable_guard.ps1` chỉ cung cấp helper kiểm chữ ký; không có bước ký installer trong build/release.

**Tác động:** SmartScreen và IT của khách hàng sẽ coi installer là unsigned; provenance của PE yếu hơn updater signature và tăng chi phí triển khai doanh nghiệp.

**Việc cần làm:** ký installer và sidecar bằng chứng thư tổ chức, kiểm chain/timestamp trước upload, ghi signer fingerprint vào manifest. Updater `.sig` vẫn là lớp riêng.

### §COMM.JOB.01 — P1 — Trạng thái job dài hạn chỉ nằm trong RAM

**[CONFIRMED source; restart scenario chưa chạy]** `backend/app/api/routes/vdp.py:78-81` ghi rõ `vdp_jobs = {}` và comment production nhiều worker cần Redis. `backend/app/api/routes/imposition.py:582-584` dùng `nup_jobs = {}` tương tự.

**Tác động:** sidecar restart hoặc worker fail làm mất status/cancel/future của job dù file kết quả có thể còn trên đĩa; UI có thể bắt người dùng chạy lại, tạo bản in trùng hoặc không biết artifact nào hợp lệ.

**Việc cần làm:** lưu metadata job và lease bền vững, reconcile khi khởi động, phân biệt `running/recovered/failed/completed`, và test crash/restart/cancel/retry.

### §COMM.VDP.01 — P1 — Chưa có giới hạn VDP thương mại đã chứng minh

**[CONFIRMED profile; ARTIFACT-PARTIAL]** Báo cáo VDP 2026-10-01 và master matrix ghi profile 5.000 record tạo đúng 5.000 trang nhưng peak khoảng 13,37 GiB với 15 worker; 10.000 record bị chặn ở `WinError 1455`.

**Tác động:** chưa thể hứa “xử lý file lớn” với khách hàng mà không biết ngưỡng record, font, ảnh, RAM và thời gian p95. Đây là rủi ro vận hành và bán hàng, không nhất thiết là lỗi thuật toán.

**Việc cần làm:** công bố support matrix theo RAM tier, giới hạn record/ảnh/font, p95 và hành vi fail/cancel; đo trên bản Tauri cài thật và file RIP/Illustrator mở lại.

### §COMM.ARCH.01 — P1 — Monolith và contract API thủ công

**[CONFIRMED source inspection]** `scripts/report_architecture_debt.py` báo `imposition.py` 5.258 dòng, `sticker_engine.py` 13.996 dòng, `nup_engine.py` 4.250 dòng; các mốc tăng lần lượt khoảng +1.203, +4.239 và +518 dòng. Có 202 route decorator nhưng chỉ 117 `response_model` và khoảng 190 lớp Pydantic-like. Frontend có 33 component gọi trực tiếp `getApiUrl/authenticatedFetch`.

**Tác động:** schema/route/engine khó review, thay đổi một field dễ tạo lỗi runtime im lặng; thời gian hỗ trợ và kiểm hồi quy tăng theo mỗi tính năng.

**Việc cần làm:** chuẩn hóa typed client/OpenAPI contract, response model cho endpoint public, tách orchestration khỏi route/worker theo lô ≤5 file; giữ architecture debt là tín hiệu chứ không đặt hard ceiling số dòng.

### §COMM.SCOPE.01 — P1 — Catalog và marketing chưa khớp trạng thái feature

**[CONFIRMED source/docs]** `docs/CAU_HINH_ENV.md:33-35` giữ `PRYNX_LOGO_REBUILD_ENABLED`, `PRYNX_MIXED_NESTING_ENABLED`, `PRYNX_TRUE_SHAPE_NESTING_ENABLED` ở `false/HOLD`; tool registry vẫn có các mục tương ứng. `README.md:12-15` vẫn quảng bá AI/OCR/phân loại tự động, trong khi `docs/DEFERRED_FEATURES.md:9-43` ghi OCR Searchable và AI QC đã ẩn vì lỗi Unicode/rủi ro dữ liệu/chi phí.

**Tác động:** demo, tài liệu và bản cài có thể nói khác nhau; khách hàng khó biết tính năng nào được support và support team không có capability matrix theo version.

**Việc cần làm:** xuất capability matrix theo version/plan, gắn nhãn experimental/HOLD ngay trong UI và README, chỉ quảng bá tính năng có artifact/runtime evidence.

### §COMM.VIEW.01 — P1 — Viewer/GPU/PPE chưa đạt bằng chứng packaged runtime

**[CONFIRMED source/artifact in prior audit; current runtime gate pending]** Báo cáo Viewer GPU 2026-09-25 ghi 7 finding (4 P1, 3 P2) về fallback capability, ý định màu, camera/pan handoff, stale error và input trace. Master matrix vẫn giữ Viewer/PPE ở `SOURCE + AUTO + ARTIFACT` hoặc `RUNTIME-PARTIAL`, chưa có clean-user installer/scan-out/60fps.

**Tác động:** PDF có thể xem đúng ở unit test nhưng đổi engine, zoom, pan hoặc màu trên WebView/GPU khách hàng lại khác. Không được dùng “test xanh” để hứa tương thích Acrobat.

**Việc cần làm:** corpus PDF cố định, smoke Tauri packaged trên tier GPU/RAM hỗ trợ, đo first-sharp/p95/frame drop, kiểm fallback và mở lại PDF bằng công cụ RIP/Acrobat.

### §COMM.DOCS.01 — P2 — Thiếu hồ sơ go-to-market và vận hành

**[CONFIRMED repository inspection]** README chủ yếu mô tả setup dev và ghi output là `.msi` ở `README.md:148-155`, trong khi Tauri hiện cấu hình target `nsis` tại `desktop/src-tauri/tauri.conf.json`. Repo không có EULA, privacy policy, ma trận OS/WebView2/RAM/GPU/dung lượng, giới hạn PDF/VDP, rollback/upgrade runbook hoặc SLA hỗ trợ. App có kênh hỗ trợ trong `desktop/src/lib/supportContact.ts`, nhưng đó chưa thay thế hồ sơ vận hành.

**Tác động:** khách hàng không biết điều kiện tương thích, dữ liệu nào rời máy, khi license/offline lỗi phải làm gì, và bản cài nào được support.

**Việc cần làm:** phát hành bộ tài liệu thương mại: EULA, privacy/data map, supported matrix, release notes, upgrade/rollback, incident/support runbook và capability matrix.

### §COMM.OBS.01 — P2 — Version observability không đồng nhất

**[CONFIRMED static]** desktop package và Tauri đều ở `2.1.2` (`desktop/package.json:4`, `desktop/src-tauri/tauri.conf.json:3-5`), nhưng FastAPI `backend/app/main.py:316` hard-code `version="1.0.0"`.

**Tác động:** log/OpenAPI/health có thể báo version khác installer, gây nhầm khi chẩn đoán và đối chiếu provenance.

**Việc cần làm:** dùng một nguồn version duy nhất và test mọi artifact/health/OpenAPI trả cùng version.

### §COMM.LIC.01 — P1 — Activation có thể giữ seat mồ côi

**[CONFIRMED source; runtime production parity còn HOLD]** Báo cáo `docs/BAO_CAO_AUDIT_LICENSE_RECOVERY_RUNTIME_2026-09-12.md` đã trace thứ tự finalize activation ở server trước native commit/token tại `useAuthStore.ts:1922`; khi native commit lỗi không có compensating release. Cùng báo cáo ghi profile artifact có `GIT_DIRTY` và `RUNTIME_VERIFIED=no`, còn parity secret production chưa được đối chiếu.

**Tác động:** khách hàng có thể bị chiếm seat dù máy chưa kích hoạt thành công; support phải reset thủ công và không có bằng chứng rằng installer đang chạy đúng provenance.

**Việc cần làm:** dùng trạng thái pending/receipt hoặc release bù có challenge/device binding; chỉ ghi `RUNTIME_VERIFIED=yes` sau clean install và đối chiếu hash; xác minh fingerprint public key với Edge bundle live.

### §COMM.SEC.04 — P1 — Office macro guard fail-open

**[CONFIRMED static; cần kiểm thêm Office versions]** `backend/app/workers/office_convert_engine.py:50-68` bắt lỗi khi đặt `AutomationSecurity=ForceDisable`, chỉ ghi warning rồi tiếp tục convert. Các đường Word/Excel/PowerPoint gọi helper trước khi mở file tại các vùng `:299-315`, `:355-369`, `:418-428`.

**Tác động:** một file `.docm/.xlsm/.pptm` độc có thể chạy `AutoOpen/Workbook_Open` trong tiến trình Office dưới quyền người dùng nếu setter thất bại hoặc Office không hỗ trợ thuộc tính như giả định.

**Việc cần làm:** fail-closed khi không xác nhận được `ForceDisable`; mặc định từ chối macro-enabled format hoặc chuyển sang worker/sandbox riêng với chế độ trusted rõ ràng.

### §COMM.SCOPE.02 — P2 — Endpoint GPU mô phỏng tạo capability giả

**[CONFIRMED source]** `backend/app/api/routes/system.py:25-62` gắn nhãn `[MOCK/SIMULATION]`, nhưng vẫn đổi singleton thành `nvidia_cuda`, ghi `data/gpu_config.json` và trả `status=success`; API và frontend vẫn có hợp đồng gọi endpoint này.

**Tác động:** người dùng hoặc support có thể tưởng GPU đã được cài trong khi xử lý vẫn chạy CPU; số đo hiệu năng và chẩn đoán capability bị sai.

**Việc cần làm:** ẩn endpoint khỏi production hoặc trả lỗi `501/unsupported`; nếu giữ demo thì tách route dev và hiển thị rõ `simulation` ở mọi UI/telemetry.

### §COMM.OBS.02 — P2 — Release không có kênh crash hỗ trợ mặc định

**[CONFIRMED source]** `desktop/src/main.tsx:60-68` khởi tạo Sentry với `enabled: import.meta.env.DEV`, nên production luôn tắt crash telemetry dù có DSN. Backend release cũng hạ log xuống warning và không có proof về support bundle tự phục vụ.

**Tác động:** khi khách hàng gặp lỗi WebView/PDFium/license, support thiếu error ID, phase và artifact context; thời gian xử lý sự cố tăng và khó phân biệt lỗi môi trường với lỗi bản build.

**Việc cần làm:** thiết kế kênh chẩn đoán production có opt-in/consent, redaction và retention rõ; hoặc cung cấp nút xuất support bundle chứa version/hash/phase/log đã lọc PII.

### §COMM.DATA.01 — P1 — Desktop upgrade chưa có migration thật

**[CONFIRMED source]** Sidecar desktop gọi `Base.metadata.create_all(bind=engine)` tại `backend/app/main.py:95`. Docker mới chạy `alembic upgrade head` tại `backend/Dockerfile:25`, nhưng migration duy nhất `backend/alembic/versions/51cf7bb2c679_initial_migration.py` có `upgrade()` và `downgrade()` là `pass`.

**Tác động:** database SQLite của khách hàng từ version cũ có thể thiếu column/index khi nâng app; startup hoặc chức năng cũ có thể crash. Chưa có backup/rollback/old-DB smoke nên rủi ro nâng cấp là P1.

**Việc cần làm:** dùng migration versioning thật cho desktop, backup + atomic upgrade, kiểm schema trước startup và test upgrade từ ít nhất hai version cũ.

## 5. Điểm mạnh nên giữ

- Ranh giới desktop React → FastAPI sidecar → Rust/native rõ; nhiều engine nặng đã có process/thread policy riêng.
- Sidecar compiled có token/HMAC, timestamp, nonce và body binding; license path đã có fail-closed guard.
- PDFium lock, RAM tiers, artifact lease, cancel/admission và nhiều golden/property test cho các luồng quan trọng.
- Build script đã có guard worktree sạch, hash/provenance, payload manifest và verifier cài đặt mạnh hơn các báo cáo cũ.
- CI đã có pip/npm/cargo audit và security regression guards; vấn đề là release/Windows coverage và hợp đồng cấu hình chưa khớp.

## 6. Thứ tự đưa sản phẩm về trạng thái có thể bán

### Chốt A — bắt buộc trước mọi beta có thu tiền

1. Chốt lô source hiện tại: phân loại 124 thay đổi, commit baseline sạch, không trộn report/test tạm.
2. Đóng §COMM.SEC.01 và §COMM.SEC.02; thêm negative tests cho artifact access và external-app registry.
3. Đồng bộ policy updater/CI/build; sửa release QA để bao phủ `cut_export`; tách fixture regeneration khỏi CI.
4. Có Windows CI build–install–smoke và ký Authenticode hoặc ghi rõ bản chỉ dùng nội bộ.

### Chốt B — trước khi bán cho xưởng có dữ liệu thật

1. Durable job registry/restart recovery cho VDP/N-up; test cancel/retry/crash.
2. VDP support matrix theo RAM/font/ảnh, p95 và artifact reopen; không quảng bá 10.000 record khi chưa có profile đạt.
3. Viewer/PPE/GPU packaged smoke và color/geometry parity trên corpus khách hàng đã ẩn danh.
4. Rà lại các finding correctness đang `HOLD` trong master matrix, ưu tiên P0/P1 của imposition, cutline, color, dieline và license recovery.

### Chốt C — hồ sơ thương mại

1. EULA, privacy/data-flow, supported platform matrix, release notes, rollback và support runbook.
2. Capability matrix theo version/plan; cập nhật README để không quảng bá feature đang `HOLD`/deferred.
3. Version source duy nhất, telemetry/crash policy có opt-in/retention rõ, và quy trình xử lý incident/customer artifact.

## 7. Lệnh và kiểm tra đã thực hiện

- `git status --porcelain --branch`: 124 mục thay đổi; worktree dirty.
- `git diff --check`: không có lỗi whitespace nghiêm trọng; có cảnh báo LF/CRLF và vài blank line cuối file.
- `powershell -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1 -SelfTest`: **17 ca đạt**. Scanner chỉ tạo ứng viên, không dùng làm release gate.
- `backend/venv/Scripts/python.exe --version`: Python 3.11.9; đã xác nhận venv dự án tồn tại.
- `scripts/report_architecture_debt.py`: chạy được và ghi nhận các monolith nêu trên.
- Đã kiểm tĩnh các file Tauri, FastAPI, CI, release script, feature flags, README và job registry. **Chưa chạy build/install/runtime** trong lượt này.

## 8. Verdict

| Quyết định | Trạng thái |
|---|---|
| Phát hành public/commercial ngay | **NO-GO** |
| Pilot nội bộ với dữ liệu không nhạy cảm, có người giám sát | **Có thể, sau khi chốt baseline và giới hạn scope** |
| Beta trả phí cho xưởng dùng file khách hàng | **Chưa nên** |
| Điều kiện tối thiểu để xem xét lại | Chốt A đạt, clean installer smoke, artifact access đóng, và P0/P1 correctness/runtime quan trọng được nâng bằng chứng |

Báo cáo này là chốt duyệt của giai đoạn audit. Chưa có thay đổi code nào được áp dụng theo các finding trên.
