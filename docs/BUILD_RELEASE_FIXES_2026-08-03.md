# Nhật ký sửa sẵn sàng build / release — 2026-08-03

**Nguồn:** `docs/BAO_CAO_AUDIT_SAN_SANG_BUILD_RELEASE_2026-08-03.md`
**Phê duyệt:** chủ dự án duyệt ngày 2026-08-03.
**Giới hạn bắt buộc:** chỉ kiểm thử và tạo artifact nội bộ cục bộ; **không** gọi
`release_update.ps1`, `gh release`, không upload GitHub và không publish updater.

## Trạng thái tổng

| Lô | Finding | Trạng thái | Verify |
|---|---|---|---|
| A | §REL.01, §REL.05 | Hoàn tất | 89/89 test mục tiêu + typecheck đạt |
| B | §REL.04 | Hoàn tất | 12/12 test mục tiêu; 71 test nhóm đạt |
| C | §REL.02 | Hoàn tất | Route 3.856/3.878 dòng; 61 test liên quan đạt |
| D | §REL.03 | Hoàn tất | 3.712/3.716 dòng; 191 test liên quan đạt |
| E | §REL.07, §REL.08 | Hoàn tất | Preflight toolchain + Python ABI; native 38/38 test đạt với PATH cục bộ |
| F | §REL.09, §REL.12 | Hoàn tất phần gate | 18×16 trên native wheel staging: 279 OK, 9 REFUSED, 0 GS/ERROR/TIMEOUT |
| G | §REL.10, §REL.11 | Đã triển khai, chờ artifact | Fresh-installer gate + cài/runtime verifier + AI/OCR self-test; chưa chạy trên installer mới |
| H | Full regression + installer nội bộ | Đang làm | Lượt 1 dừng do thiếu fixture trong QA staging; đã vá và khóa bằng test |

## Baseline trước sửa

- Backend full: 2.068 pass, 5 skip, 4 fail.
- Frontend full: 1.764 pass, 2 skip, 6 fail.
- `lint:budget`: `react-refresh/only-export-components` 45/32.
- Native gate đúng wrapper: `STATUS_DLL_NOT_FOUND`; thêm tạm Python `sys.base_prefix`
  vào `PATH` thì 38 test + release check đạt.
- No-GS 18×16: không hoàn tất trong 15 phút; file thứ 8 dừng tại `pdfx:x1a`.

## Lô A — correctness và frontend gate

Trạng thái: **hoàn tất**.

Mục tiêu:

1. Khôi phục hệ số workbook Fort/keo nhiệt `BF=0.3` (§REL.01).
2. Chỉ đồng bộ hai snapshot store đã được review; không cập nhật golden hình học hàng loạt.
3. Làm hai test timeout dưới tải deterministic mà không làm yếu assertion (§REL.05).

Kết quả:

- Khôi phục hệ số Fort/keo nhiệt `BF=0.3`; oracle Fort 58 đạt `0.9802 mm`.
- Đồng bộ thủ công đúng snapshot đã review; không cập nhật golden hàng loạt.
- Chỉ cấp ngân sách 15 giây cho hai ca upload và ca overlap `tray`; giữ nguyên 100 lượt property test cùng mọi assertion.
- Verify: 4 file, 89/89 test Vitest đạt; `npm run typecheck` đạt; `git diff --check` đạt.

## Lô B — seam test homogeneous backend

Trạng thái: **hoàn tất**.

- Sửa capture stub để thu đủ các chunk khi đường chạy inline được chọn rồi mới dừng engine; không thay đổi production optimizer hay `pikepdf`.
- Giữ nguyên toàn bộ assertion về routing, số lượng và placement.
- Verify: 12/12 test mục tiêu đạt; nhóm homogeneous + ratio-stack đạt 71 test; `git diff --check` đạt.

## Lô C — tách dựng preview khỏi route imposition

Trạng thái: **hoàn tất**.

- Tách dựng tọa độ tờ preview và contract response sang helper thuần trong worker; route chỉ còn điều phối ratio-stack, sequential và cut-stacks.
- Giữ nguyên quy tắc canh trái/phải/trên/dưới, đổi trục Y, `placedByPage`, duplex và nhiều tờ mẫu.
- `imposition.py` giảm từ 3.973 xuống 3.856 dòng, thấp hơn trần 3.878 mà không nâng ratchet.
- Verify: 40 test ratio-stack/guillotine preview, 18 test parity/page-sheet/preview và 3 ratchet liên quan đều đạt; `git diff --check` đạt.

## Lô E1 — hợp đồng toolchain

Trạng thái: **hoàn tất phần hợp đồng; lô E2 còn chờ**.

- Đồng bộ Node `^20.19.0 || >=22.12.0` trong package, lockfile, README và setup; setup từ chối đúng các khoảng phiên bản không được Vite hỗ trợ.
- Nâng MSRV Rust lên `1.88` theo cây dependency đã khóa và thêm kiểm tra fail rõ trong setup.
- Giữ nguyên contract Python 3.11 và các thay đổi version `1.0.0-rc.1` có sẵn.
- Verify: JSON/PowerShell parse, 13 ca biên version, Cargo metadata, npm engines và `git diff --check` đều đạt.

## Lô D — tách hậu xử lý N-Up

Trạng thái: **hoàn tất**.

- Tách render chunk, ghép PDF/OCG, cleanup, watermark, report và thông báo hoàn tất sang `nup_output_finalize.py`.
- Giữ nguyên worker planning và thay đổi ratio-stack có sẵn; PDFium được khóa đúng vùng gọi ngắn, không thêm cap tài nguyên.
- `nup_engine.py` giảm từ 4.105 xuống 3.712 dòng, đạt cả trần 3.716 và sàn ratchet 3.566 mà không sửa test ceiling.
- Verify: 191 test N-Up/guillotine/page-sheet/homogeneous/ratio/report đạt; `py_compile` và `git diff --check` đạt.

## Lô L — đóng lint budget frontend

Trạng thái: **hoàn tất**.

- Tách cache thumbnail, policy Bế tem, preset nền mockup và công thức ngân sách render khỏi các file component; xoá hai helper render cũ không còn consumer.
- Không đổi trần lint và không thêm ngoại lệ rule; `react-refresh/only-export-components` giảm đúng từ 45 xuống 32.
- Verify hẹp: 38 test đạt; typecheck đạt sau từng lô; `npm run lint:budget` đạt (`errors=1439`, `warnings=106`).

## Lô E2 — preflight build và native runtime

Trạng thái: **hoàn tất**.

- `build_production.ps1` kiểm Node/Rust/Python trước QA hoặc mutation: Node theo hợp đồng Vite, Rust theo MSRV `1.88`; public `-Release` giữ Python 3.11, build nội bộ cho phép 3.12 có cảnh báo rõ.
- Native cargo gate lấy `sys.base_prefix` từ đúng `$PYTHON`, chỉ thêm vào `PATH` quanh test PyO3 rồi khôi phục cả `PATH` và `PYO3_PYTHON` trong `finally`.
- QA được chuyển xuống sau khi native wheel production đã build vào staging; `run_release_qa.ps1` bắt buộc chứng minh `pdfcompare_native` đang import từ chính staging đó trước khi chạy backend/no-GS. Nuitka dùng lại cùng wheel.
- Verify: PowerShell parse đạt; 8 ca biên preflight đạt; native Rust 38/38 test đạt.

## Lô F — no-Ghostscript gate có timeout, provenance và cô lập dữ liệu

Trạng thái: **hoàn tất phần gate; sẽ lặp lại trong build cuối**.

- Timeout cưỡng bức từng operation, kết quả terminal `TIMEOUT`, checkpoint atomic sau từng operation và worker restart an toàn.
- Artifact schema 3/fingerprint nội dung khóa source, corpus, thứ tự operation, timeout, Python distributions, native `.pyd`, `pypdfium2`/PDFium, ICC, platform và env/config ảnh hưởng. Artifact cũ/sai runtime không được resume.
- Mỗi operation có process + workspace riêng; input được sao chép thành `input.pdf`, stdout/stderr/subprocess bị giữ trong sandbox. Parent luôn kill cây process và xóa workspace; cleanup lỗi đổi gate thành `ERROR`.
- Console/artifact chỉ lưu mã `doc-NNN-<hash>`; không lưu tên hay đường dẫn corpus. Smoke sau chạy xác nhận `WorkerResidue=0`, `ParentResidue=0`, không có tên corpus trong JSON.
- Fixture TAC chạy thật bằng PPE/no-GS, không còn skip theo Ghostscript.
- Verify hẹp: 53 test đạt; benchmark một tệp ×16 operation đạt trong 18,3 giây.
- Lượt build đầu chạy trên đúng native wheel staging đã hoàn tất 288 operation: 279 `OK`, 9 `REFUSED`, 0 `GS`, 0 `ERROR`, 0 `TIMEOUT`; fingerprint cuối hợp lệ. Build sau đó dừng ở frontend staging, không phải gate no-GS.

## Lô G — artifact fail-closed và runtime verifier

Trạng thái: **đã triển khai; chờ installer mới để nghiệm thu thật**.

- Tauri build phải tạo đúng một installer của `APP_VERSION` và phải ghi mới trong chính lượt build; thiếu/stale artifact là lỗi, không còn warning.
- Manifest khóa version, installer/sidecar/frontend hash và mặc định `RUNTIME_VERIFIED=no`. Uploader chỉ dùng artifact đã stage, kiểm hash lại ngay trước upload và bắt buộc verifier điền bằng chứng runtime. Trong đợt nội bộ này tuyệt đối không gọi uploader.
- Verifier từ chối nếu có PrynX/process/port hoặc installed metadata sẵn; chỉ dừng process do chính verifier tạo và fail nếu cleanup không sạch.
- Runtime smoke cài artifact vào Temp, kiểm app/sidecar/PDFium/no-GS, breadcrumb startup mới, `/health`, OCR ảnh mẫu thật bằng `eng+vie`, rồi chạy frozen sidecar `--artifact-self-test`: DirectML + CPU phải có và cả ISNet + hai Real-ESRGAN phải load/hash/inference hữu hạn.
- Public release không còn tự sửa version: version phải đồng bộ trong Tauri/npm/Cargo/publisher config và đã commit; `-Release` từ chối worktree bẩn, inline `-Version`, skip QA/Nuitka/Tauri hoặc commit thay đổi giữa build.
- Model đóng gói được stage dưới Temp, không tải/copy vào source tree sạch.
- Verify hẹp hiện tại: 59 test liên quan đạt; Python/PowerShell parse và `git diff --check` đạt; self-test CLI thoát sớm trước FastAPI/database và chỉ in marker đã làm sạch.

## Lô H — full regression và installer nội bộ

Trạng thái: **đã tạo installer; runtime smoke chờ profile sạch**.

- Full frontend trước build: 1.770 pass, 2 skip; typecheck và Vite production build đạt.
- Full backend trước lô artifact self-test: 2.084 pass, 4 skip; 4 warning deprecation đã biết.
- Build nội bộ lượt 1: native production wheel + model smoke + backend/no-GS đạt; frontend staging chạy 172/173 suite, 1.756 test pass, 2 skip rồi dừng vì thiếu shared fixture `imposition_core/tests/fixtures/grid_parity_simple_auto.json` trong cây Temp.
- Đã stage thêm đúng fixture sibling này (cùng fixture native có sẵn) và thêm test policy chống tái phát. Verify sau vá: 32/32 test policy/artifact đạt; PowerShell parse sạch.
- Build nội bộ lượt 2 dừng đúng tại chốt provenance trước QA: wheel đã được import từ staging nhưng đường dẫn staging dùng bí danh Windows 8.3 (`KHANHP~1`), còn `pathlib.resolve()` trả tên dài nên phép so sánh chuỗi PowerShell báo oan. Chốt hiện chuẩn hóa cả hai đường dẫn bằng cùng Python runtime rồi mới dùng `Path.is_relative_to()`; không nới điều kiện fail-closed. Verify sau vá: 44/44 test policy/artifact/no-GS đạt, PowerShell parse và `git diff --check` sạch.
- Build nội bộ lượt 3: backend 2.098 pass/4 skip và no-GS 288/288 (279 `OK`, 9 `REFUSED`) đạt; dừng ở `npm ci` staging vì sandbox chặn HTTPS tải `ffmpeg-static` (`connect EACCES`), không phải lỗi source. Cleanup staging hoàn tất.
- Build nội bộ lượt 4 với quyền mạng: native hash mới buộc no-GS đo lại đủ 288/288 cùng kết quả ổn định; `npm ci` sạch cài 479 package và typecheck đạt. Vitest tìm đủ 173 suite nhưng một ca `api.mergeManifest.test.ts` timeout 5 giây khi 173 file tranh CPU (1.769 pass, 2 skip; thân ca hoàn tất sau 7,8 giây).
- Ca manifest không kiểm auth, nhưng lần đầu vô tình chịu chi phí dynamic import auth store (Zustand/Supabase). Test hiện mock store theo đúng mẫu `api.auth.test.ts`, giữ nguyên timeout toàn cục 5 giây. Verify: 5 lượt hẹp đều 6–7 ms; full frontend 173/173 suite, 1.770 pass/2 skip; typecheck đạt.
- Build nội bộ cuối hoàn tất exit 0: backend 2.098 pass/4 skip; frontend staging sạch 173/173 suite,
  1.770 pass/2 skip; no-GS 288/288 với 279 `OK`, 9 `REFUSED`, 0 `GS`/`ERROR`/`TIMEOUT`;
  các gate Rust, Nuitka onefile, Vite, Tauri và NSIS đều đạt.
- Installer `PrynX_1.0.0-rc.1_x64-setup.exe`: 487.684.138 byte, SHA-256
  `e3f8a2eb033d402b487e98566c5cf26edaa4d50da32c37932b1c68cf5b209408`; bản bundle và bản
  staging trong `Ban_Phat_Hanh` trùng tuyệt đối. Sidecar SHA-256
  `a44201151fb0db8913ae6dac7df4fe4cafbb9a99ac52956dc4346287ef9e60aa` khớp manifest.
- NSIS rc.1 chỉ đóng `binaries\gs\NO_GHOSTSCRIPT.txt`. Ghostscript nhìn thấy trong
  `target\release\binaries\gs` là residue beta cũ ngoài danh sách `File` của installer, không nằm
  trong artifact rc.1.
- Verifier đạt chốt version/hash nhưng từ chối cài vì HKCU đang có metadata PrynX
  `1.0.0-beta.13` và cây cài cũ; Windows Sandbox không có. Không gỡ/di chuyển/sửa registry bản cũ
  khi chưa có quyền riêng. Manifest giữ `RUNTIME_VERIFIED=no` và `EXE_SHA256=NOT_VERIFIED_INSTALL_PAYLOAD`.
- Không có commit, stage, push, release, upload hay thao tác GitHub.

## Lô I — kho bí mật và launcher phát hành (2026-08-03)

- Xóa `service_role` plaintext khỏi `scripts/set_release_env.ps1`; file legacy giờ chỉ gọi loader.
- Thêm kho CLIXML mã hóa bằng Windows DPAPI CurrentUser, ACL riêng cho đúng tài khoản, cùng trình
  nhập ẩn `scripts/setup_release_secrets.ps1`. Chỉ chấp nhận khóa Supabase mới dạng `sb_secret_`.
- Build public từ chối biến legacy `PRYNX_SUPABASE_SERVICE_KEY`, gửi `sb_secret_` qua riêng header
  `apikey`. Nếu CI/CLI cũ truyền env, build lấy và xóa ngay đầu process trước git/node/rust/python;
  đường chuẩn chỉ giải mã DPAPI just-in-time tại bước REST rồi hủy khỏi bộ nhớ tham chiếu.
- GUI/`PHAT_HANH.bat` không nạp secret và không truyền secret qua env/process launcher. Không có thao
  tác GitHub hoặc Supabase trong lô này.
- Verify hẹp: PowerShell parse pass; DPAPI round-trip 2/2 test pass; plaintext không xuất hiện trong
  file CLIXML thử nghiệm.

## Lô J — Python 3.11 release ABI

- Giữ nguyên venv 3.12.13 cũ tại `backend/venv-py312-backup-20260803`; tạo mới `backend/venv` bằng
  Python 3.11.9 x64 do Python Install Manager chính thức cung cấp và cài đủ requirements đã khóa.
- `pip check` đạt; import FastAPI/PDFium/pikepdf/OpenCV/SciPy/scikit-image/fontTools/pywin32/ONNX
  đạt; native PyO3 build/install đúng wheel `cp311-win_amd64`.
- Full backend trên chính venv 3.11 mới: **2.101 pass, 4 skip**, 3 warning deprecation đã biết.
- Residual risk: Python 3.11.15 ngày 2026-03-03 là security release mới nhất nhưng python.org chỉ
  phát hành source; Python 3.11.9 là binary Windows cuối của nhánh. Pipeline hiện khóa ABI 3.11 chứ
  chưa có quy trình tự build CPython 3.11.15 từ source. Không gọi 3.11.9 là patch mới nhất.

## Lô K — installed smoke trong Windows profile sạch

- Thêm runner tạo standard local user ngẫu nhiên, sinh password trực tiếp trong `SecureString`, chạy
  verifier bằng profile riêng rồi xóa đúng profile/user theo SID. Không sửa profile/bản beta hiện tại.
- Lượt đầu chứng minh toàn bộ runtime đạt nhưng phát hiện race cleanup NSIS: file biến mất giữa lúc
  PowerShell enumerate/xóa. Verifier vẫn fail-closed và đặt `RUNTIME_VERIFIED=no-cleanup-failed`.
- Cleanup cây Temp được retry tối đa 5 lần, mỗi lần 250 ms, vẫn giữ canonical-path gate. Lượt chạy lại
  đạt exit 0; không còn user/profile/process/port 8321 tồn dư.
- Manifest artifact nội bộ rc.1 hiện có `RUNTIME_VERIFIED=yes`, PDFium/sidecar/app/OCR/ONNX payload và
  inference 3 model đều `ok`. Artifact này vẫn **không phải public release** vì `DIELINE_LOCKED=no` và
  được build từ worktree dirty bằng Python 3.12.

## Proof gap rotation Supabase

- Local build đã bỏ plaintext legacy và sẵn sàng dùng key `sb_secret_` riêng. Chưa tạo/lưu key thật.
- Không thể vô hiệu hóa `service_role`/legacy JWT ngay: 7 Edge Function admin, lời gọi edge-to-edge,
  PrynX/website/PrintMonitor/LicenseBridge và nhiều JSX vẫn phụ thuộc legacy service/anon JWT.
- Trình tự an toàn phải là tạo key riêng → migrate/deploy Edge → chuyển public clients sang
  publishable key → smoke license/payment/email → kiểm last-used → mới disable legacy và rotate/revoke
  JWT signing key. Đây là thay đổi production repo `printsolutions-main`, cần chốt riêng; không làm mù
  trong đợt build local này.

### Cập nhật key build

- Đã tạo secret key riêng `prynx_release_build` trên Supabase và chuyển thẳng qua kênh loopback
  chỉ trong RAM vào kho DPAPI CurrentUser; clipboard/buffer được xóa, không ghi plaintext ra file/log.
- GET đầu tiên bị Supabase từ chối đúng chính sách vì Windows PowerShell mặc định tự nhận là
  `Mozilla/...WindowsPowerShell` (browser-like). Build nay đặt User-Agent backend cố định
  `PrynX-Release-Builder/1.0`; cùng key/header `apikey` sau đó GET Data API đạt.
- Chưa xóa/vô hiệu hóa key `default`, legacy `service_role`, legacy `anon` hay JWT signing key.

## Lô L — build nội bộ khóa Python 3.11 và gate PyO3 (2026-08-04)

- Gate native ban đầu dừng với `STATUS_DLL_NOT_FOUND (0xc0000135)`. `dumpbin /DEPENDENTS` chứng minh
  test binary bị Cargo tái sử dụng từ Python 3.12 và còn liên kết `python312.dll`; thêm thư mục PDFium vào
  `PATH` không thay đổi lỗi. `run_release_qa.ps1` nay đặt `PYO3_ENVIRONMENT_SIGNATURE` theo đúng đường dẫn
  interpreter + phiên bản Python trước gate native và khôi phục biến trong `finally`, nên PyO3 dựng lại đúng
  ABI. Sau sửa, dependency đổi thành `python311.dll`; native test **38/38** và `cargo check --release --locked`
  đều đạt. Regression contract nằm tại `backend/tests/test_release_qa_native_runtime.py`.
- Test kho DPAPI nay tự xóa thư mục đã khóa ACL ngay trong chính PowerShell process tạo ACL; không còn để
  pytest gặp `WinError 5` khi xoay thư mục Temp. Verify hẹp: **4 pass**, chỉ còn Pydantic deprecation đã biết.
- Lượt build foreground đầu tiên bị terminal giám sát cắt ở giới hạn 60 phút. Crash report ghi
  `OSError [Errno 22] Invalid argument` khi Nuitka in ra console đã đóng, không có compiler/source error;
  sidecar mới chưa được công bố và installer cũ không đổi. Build được chạy lại bằng process nền + log riêng
  để không phụ thuộc tuổi thọ terminal.
- Full internal build Python 3.11 sau đó hoàn tất: backend **2.105 pass, 4 skip**; frontend staging sạch
  **173/173 suite, 1.770 pass, 2 skip**; no-GS **288/288** với 279 `OK`, 9 `REFUSED`, 0
  `GS`/`ERROR`/`TIMEOUT`; toàn bộ gate Rust, Nuitka onefile, Vite, dieline WebView, Tauri và NSIS đạt.
- Artifact mới `PrynX_1.0.0-rc.1_x64-setup.exe`: **483.015.189 byte**, SHA-256
  `f9ea6c5b63565d960379ef9294df99efca70ea07f450863c7610a69a0405b7c2`; bundle và bản trong
  `Ban_Phat_Hanh` trùng tuyệt đối. Sidecar SHA-256
  `1e66190bd845e771498377364de3115530b9d413c7f921141538431e8f287bf9`; frontend SHA-256
  `94cda1fc3831cb2fd15f9fcdf1453e0537836d959bc77398385d0d0867369812`. Manifest ghi
  `DIELINE_LOCKED=yes`, nhưng vẫn đúng fail-closed: `GIT_DIRTY=YES`, `CODE_SIGNED=no`,
  `RUNTIME_VERIFIED=no`, `EXE_SHA256=NOT_VERIFIED_INSTALL_PAYLOAD`.
- Frozen sidecar mới tự kiểm thử trong profile Temp biệt lập và đạt: có `CPUExecutionProvider` +
  `DmlExecutionProvider`; đúng hash, load và inference hữu hạn cho `isnet`, `realesrgan-general`,
  `realesrgan-quality`; thư mục self-test được xóa sạch.
- Clean-user installer smoke chưa chạy được vì Windows UAC bị hủy hai lần trước khi elevated process bắt đầu;
  không có user/profile/install/process/port mới để dọn. Không hạ gate hoặc tự điền manifest: artifact này
  vẫn **chỉ là bản nội bộ**, chưa đủ điều kiện public cho tới khi clean-user smoke exit 0 và worktree được
  chia nhóm/commit sạch theo duyệt của chủ dự án.
- Không stage, commit, push, upload, tạo GitHub release hay gọi publisher trong lô này.

## Lô M — khóa biên secret trước khi push (2026-08-04)

- Re-audit dạng diff review trên `build_production.ps1`, `release_update.ps1` và
  `PHAT_HANH.bat`; phạm vi chỉ gồm biên Supabase/updater signing của pipeline local,
  không chạy publisher và không dùng secret thật.
- `§SEC.REL.URL` `[VERIFIED]`: public release từ chối URL Supabase khác project đã khóa
  trong hợp đồng DPAPI và chỉ gửi header `apikey` tới URL HTTPS chuẩn. Build nội bộ vẫn
  giữ khả năng dùng URL staging riêng.
- `§SEC.REL.SIGNING` `[VERIFIED]`: publisher/launcher chỉ truyền đường dẫn file khóa;
  nội dung private key được đọc ngay trước tiến trình Tauri, rồi key/password bị xóa
  trong `finally` trước verifier hoặc mọi lệnh `gh`.
- Đường một-click nay tìm `~/.tauri/prynx.key`, fail-closed nếu thiếu và luôn dọn cả
  đường dẫn/key/password trong cửa sổ PowerShell `-NoExit`, kể cả khi lỗi sớm.
- Regression tĩnh + PowerShell parse đạt. Proof gap còn lại: chưa ký/build/upload public
  trong lượt re-audit này; xác minh chữ ký thật vẫn thuộc lần phát hành do chủ dự án chủ động chạy.
