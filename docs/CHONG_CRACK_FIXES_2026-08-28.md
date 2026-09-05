# Log sửa — audit chống crack 2026-08-28

## Bổ sung 2026-09-02 — Lô A0, §SEC.16 (Mitigated, chưa Closed)

**Báo cáo:** `docs/BAO_CAO_AUDIT_CHONG_CRACK_BLACKBOX_WHITEBOX_2026-09-02.md`
**File (đúng 5):** `desktop/src-tauri/src/security.rs`,
`desktop/src/stores/useAuthStore.ts`, `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts`,
`D:\printsolutions-main\supabase\functions\license-verify\index.ts`,
`D:\printsolutions-main\src\securityAuditRound2.test.ts`.

| Thay đổi | Kết quả bảo mật |
|---|---|
| Cache DPAPI v1 phải khớp một tập phần cứng vừa đo có UUID hoặc CPU+BIOS; sau đó migrate sang JSON v2 lưu enrollment | User cùng profile Windows không còn chọn HWID chỉ bằng cách tạo một DPAPI blob chứa chuỗi tùy ý |
| Mỗi process mới đối chiếu enrollment với UUID hoặc quorum CPU+BIOS; cache tồn tại nhưng giải mã/xác thực lỗi thì không bị ghi đè | Copy cache sang máy khác và state hỏng đều fail-closed; tránh tự sinh ID mới rồi ăn thêm seat |
| Runtime Tauri chỉ nhận native HWID 16-hex; lỗi/rỗng/sai format không rơi vào localStorage hoặc offline grace | Renderer không còn thay authority bằng `prynx_hwid_cache` |
| Edge canonicalize một lần và dùng `normalizedMachineId` ở block lookup, activation RPC, RK ledger, token và security log | Casing/whitespace không tạo hai danh tính logic hoặc lệch block/token/log |

**Verify:** `cargo test --lib` = 175 pass, 5 ignored; targeted frontend = 21 pass;
`desktop npm run typecheck` = pass; server ratchet = 10 pass; `rustfmt --check` và
`git diff --check` = pass. `printsolutions-main npm run typecheck` còn đỏ 21 lỗi TS7030 có sẵn
ở các component không thuộc lô; không có lỗi trong hai file sửa.

**Giới hạn kết luận:** chỉ ghi **Mitigated**. WMI vẫn là nguồn local có thể bị giả bởi attacker
đủ khả năng patch/hook. Muốn **Closed** phải có nonce một lần, TPM key attestation được server
xác minh, binding activation nguyên tử, token protocol v2 và hard sunset legacy; CNG software
key hoặc proof không attestation chưa đủ chứng minh một máy vật lý.

## Bổ sung 2026-09-03 — Lô D1, §SEC.17 (Contained, chưa Closed)

**File (đúng 4):** `build_production.ps1`, `PHAT_HANH.bat`,
`scripts/release_signing_key_guard.ps1`, `scripts/test_release_signing_key_guard.ps1`.

| Thay đổi | Kết quả bảo mật |
|---|---|
| Release từ chối private key inline/environment, key trong repo và key/path qua reparse point | Giảm nguy cơ secret đi qua môi trường build rộng hoặc bị thay bằng link tới file khác |
| File key và thư mục cha phải tắt inheritance, ACL canonical, owner/principal chỉ thuộc current user, SYSTEM hoặc Administrators | Release fail-closed khi worker/group ngoài trust boundary có quyền trên key hoặc nơi chứa key |
| Bắt buộc password input; xóa fallback `--password=`; launcher đọc bằng `Read-Host -AsSecureString` | Không còn đường phát hành chuẩn chấp nhận password rỗng hoặc lộ password trên argv |
| Kiểm authority ở preflight và ngay trước signer; chỉ signer nhận password rồi biến bị xóa trong `finally` | Thu hẹp cửa sổ TOCTOU và thời gian secret hiện diện trong process environment |

**Verify:** test guard = pass; parse `build_production.ps1`, guard và test = pass; parse đoạn
PowerShell nhúng trong `PHAT_HANH.bat` = pass; `git diff --check` = pass. Probe metadata trên đường
khóa khi đó — được ghi theo cách hiển thị lịch sử `%USERPROFILE%\.tauri\prynx.key` — trả
**BLOCKED** vì ACL còn inheritance; authority hiện hành đã chuyển sang Windows UserProfile Known
Folder, không tin biến môi trường `USERPROFILE`. Probe không đọc nội dung key,
không gọi signer và không tạo release.

**Giới hạn kết luận:** chỉ ghi **Contained at release gate**. Việc cung cấp một password không tự
chứng minh file key cũ đã được mã hóa, và source guard không thể thu hồi khả năng key từng bị đọc.
Trước release tiếp theo, owner vẫn phải rà access/release history, xác nhận key đang active hay
không, rotate/revoke theo kế hoạch tương thích client, tạo key mới thật sự có passphrase và siết ACL
file + thư mục cha cho tới khi guard pass. Không tự sửa ACL hoặc rotate key trong lô source này.

## Bổ sung 2026-09-03 — Lô C, §SEC.18 (Mitigated in source / runtime artifact validation pending)

**File (đúng 5):** `build_production.ps1`, `scripts/verify_installed_artifact.ps1`,
`desktop/src-tauri/src/lib.rs`, `backend/app/main.py`,
`backend/tests/test_artifact_runtime_self_test.py`.

| Thay đổi | Kết quả bảo mật |
|---|---|
| Nuitka one-file dùng temporary extraction `{TEMP}\PrynX\sidecar-{PID}-{TIME_US}-{RANDOM}` thay cache persistent theo version | Loại đường sửa payload user-writable rồi được tái sử dụng nhờ cache hit CRC32 |
| Cả initial spawn và supervisor spawn xóa môi trường kế thừa rồi lọc case-insensitive năm biến `NUITKA_ONEFILE_*` | Process cha/worker không thể ép sidecar kế thừa state extraction cũ qua đường spawn chuẩn |
| Endpoint shutdown ẩn dùng HMAC-SHA256 + timestamp ±30 giây + nonce chống replay; Uvicorn đi qua lifespan | Rust có thể cho Python và bootstrap Nuitka thoát êm để tự xóa payload temporary trước khi fallback cưỡng bức |
| Sidecar generation giữ pinned Windows process handle + creation FILETIME; lifecycle mutex khóa spawn/shutdown | PID reuse hoặc event thế hệ cũ không thể làm host clear/`taskkill` nhầm process generation mới; thiếu identity thì dựa Job Object |
| Verifier chạy hai lượt, bind extraction PID vào đúng executable + app lineage, chặn reparse, yêu cầu path khác nhau và cleanup không force-kill | `RUNTIME_VERIFIED=yes` chỉ được ghi sau khi kiểm đúng topology Nuitka outer/inner và không còn residue |

Review độc lập đã bắt hai lỗi trong bản vá trước chốt: selector theo EXE path luôn fail vì outer và
inner có thể cùng path; đường shutdown từng mở handle quá muộn nên còn race PID reuse. Cả hai đã có
ratchet test và được hậu kiểm lại.

**Verify:** backend targeted = **33 passed**, 1 warning Pydantic có sẵn; `cargo test --lib` =
**179 passed, 5 ignored**; `cargo check --release` = pass; PowerShell parse hai script = pass;
`git diff --check` đúng 5 file = pass. `cargo fmt --check` toàn crate vẫn báo formatting drift trong
WIP có sẵn ở `lib.rs` và các file ngoài lô; không bulk-format để tránh sửa lan. Không build, ký hoặc
publish production artifact.

**Giới hạn kết luận:** chưa **Closed**. Cần build artifact mới và chạy verifier trên clean Windows
VM để chứng minh hai extraction path riêng, shutdown êm, cleanup không residue/force-kill và đo
cold-start. `{RANDOM}` của Nuitka Windows hiện dùng xorshift32 và bootstrap chấp nhận directory đã
tồn tại, nên cần negative test pre-create; scan reparse vẫn có Ring-3 TOCTOU và crash/End Task có thể
  để residue. Startup current-source đã loại `taskkill /IM` theo tên trong lô §SEC.22; packaged
  lifecycle vẫn pending. User có debugger/admin vẫn có thể patch process; mục tiêu của lô này là
  loại crack rẻ qua persistent extraction cache, không tuyên bố chống crack tuyệt đối.

## Bổ sung 2026-09-03 — §SEC.19 (Partially mitigated / source-test Verified)

**Báo cáo chi tiết:** `docs/BAO_CAO_AUDIT_SEC19_REAUDIT_2026-09-03.md`.

| Thay đổi | Kết quả bảo mật |
|---|---|
| Backend phân biệt installation key/marker/record missing, corrupt, tampered và unavailable; ghi state nguyên tử | Mất/hỏng một phần state không còn âm thầm reset thành cài đặt mới để kéo dài token offline |
| Native signer và mọi nhánh offline cùng kiểm `AnchorState`; recovery cần token v2 `iat` + challenge dùng một lần | Chặn các đường vòng clock anchor rẻ giữa renderer/native/backend |
| Đổi key staged + serialize; lỗi kỹ thuật giữ credential nhưng khóa quyền | Không tự mở khóa sau validate fail và giảm race key/token/native binding |

**Verify:** backend clock/token **89 pass**; frontend auth/license **64 pass** + typecheck;
Edge ratchet **34 pass**; Rust overlay **191 pass, 5 ignored**.

**Giới hạn kết luận:** chưa Closed vì còn reset đồng thời toàn state trước bootstrap,
concurrency/fault test, clean-installer clock smoke và deploy Edge/production. Khe replay qua
sidecar restart được supersede bởi control generation ngày 2026-09-04 bên dưới.

## Bổ sung 2026-09-03 — §SEC.21–§SEC.23 (request, lifecycle và payload)

| Finding | Source đã áp dụng | Còn mở |
|---|---|---|
| §SEC.21 | Signature v2 bind method, raw path/query, credential snapshot, content type, body mode và body commitment; JSON/string/binary bind raw bytes; FormData giữ order/duplicate/file metadata; streaming kiểm tại EOF | Packaged-runtime proof; ratchet 191/191 là route coverage, không phải test count |
| §SEC.22 | Bỏ startup kill theo image name; chỉ shutdown/force-kill PID generation có HANDLE + creation time; listener lạ làm startup fail-closed | Packaged close/crash/update/second-instance/reboot smoke |
| §SEC.23 | Fresh staging/exact-set cùng Tesseract lock version/path/size/SHA-256; root/path/ADS/reparse, hardlink/link-count và identity lease; installed exact-set chạy trước payload | Clean build/install/uninstall, artifact provenance xuyên pipeline và runtime VM sạch |

**File control chính:** `desktop/src/lib/api.ts`, `backend/app/core/license_guard.py`,
`desktop/src-tauri/src/lib.rs`, `backend/app/main.py`, `build_production.ps1`,
`desktop/src-tauri/tauri.conf.json`, `scripts/verify_installed_artifact.ps1` cùng các test liên quan;
các thay đổi được chia thành lô không quá 5 file.

**Verify cuối:** frontend auth/license **64/64** + typecheck; backend security mục tiêu **128/128**;
artifact harness **32/32** (gồm chặn dữ liệu lạ trước cleanup và thứ tự exact-set trước execution);
DPAPI/ACL riêng **2/2**; PowerShell parse và `git diff --check` đạt.
Không build, ký, publish hay gọi production.

## Bổ sung 2026-09-04 — chốt source/test §SEC.15/.19/.21/.23/.24-R1–R7

| Phạm vi | Trạng thái hiện hành | Control đã verify ở source/test | Còn mở |
|---|---|---|---|
| §SEC.15 — Save As artifact | **Applied → Verified (source/test)** | Grant one-shot bind cửa sổ, canonical target và TTL; lease khóa source + ancestor không share `DELETE`; timer thu hồi sau 2 phút | `[EXTERNAL]` UI bản cài, NAS và filesystem không phải NTFS |
| §SEC.19 / §ATK.09 — respawn replay | **Applied → Verified (source/test)** cho khe replay theo thế hệ; §SEC.19 tổng thể vẫn Partially mitigated | Session key derive theo từng `sidecar generation`; chữ ký thế hệ cũ không sống lại sau respawn dù nonce table mới rỗng | Clock fault-injection, clean-installer runtime và deploy/secret state |
| §SEC.21 — request binding | **Applied → Verified (source/test)** | Signature v2 bind method, raw path/query, credential snapshot, content type, body mode/commitment; raw bytes cho JSON/string/binary; FormData giữ order/duplicate/file metadata; streaming kiểm EOF trước parse/submit; route ratchet **191/191** là coverage | `[EXTERNAL]` packaged-runtime proof |
| §SEC.23 — payload provenance | **Applied → Verified (source/test mục tiêu)** | Tesseract lock pin version/path/size/SHA-256; hardlink/link-count, ADS, reparse và identity lease | `[EXTERNAL]` clean build/install/uninstall, artifact provenance và runtime VM sạch |
| §SEC.24-R1–R7 — tool/source/publisher authority | **Applied → Verified (source/test mục tiêu)** | R1–R3 pin/lease executable + exact npm/Tauri entrypoint; R4 Rust toolchain content-addressed/exact-set/provenance; R5 canonical GitHub updater endpoint/destination; R6 Git/GitHub metadata/config/credential + exact grammar, SemVer ASCII-only, exact raw/escaped tag route, Known Folder signing key/Notepad; R7 BAT `%__APPDIR__%` bootstrap | Trusted checkout là prerequisite cục bộ; OAuth/Credential Manager/GitHub read-only đã đạt với `gh` 2.93.0; `[EXTERNAL]` còn quyền push/release, `gh` tương lai, Authenticode artifact và packaged double-click/hostile-`PATH`; không tự gán severity mới |

Chi tiết delta §SEC.24 hiện hành:

- **R4:** Cargo/Rustc/Rustdoc/`rust-std` đến từ lock versioned, content-addressed; exact-set và
  identity được kiểm quanh consumer, provenance được bind vào manifest.
- **R5:** chỉ đúng một updater endpoint HTTPS canonical trên `github.com` được phép xác định
  destination; host/repo không lấy từ ambient routing.
- **R6:** Git bị bind vào `ROOT\.git`, config/index/info cùng ancestor được lease, grammar read-only
  exact có `--absolute-git-dir`; common/split worktree, config có điểm thực thi, hidden index flag và
  gitlink đều fail-closed. GitHub CLI dùng Known Folder config, pin `github.com`, exact config/command/
  API route; SemVer chỉ dùng chữ số ASCII, route tag raw/escaped chỉ nhận đúng dạng publisher tạo và
  percent-escape tổng quát bị từ chối. Updater signing key lấy từ UserProfile Known Folder và chặn
  UNC/reparse; log mở bằng Notepad System32 đã kiểm Authenticode/lease. Device login pin HTTPS,
  `--web --skip-ssh-key`, `GH_PROMPT_DISABLED=1`, không clipboard/browser/Git/SSH-key side effect.
  Git for Windows 2.53 cho thấy pseudo-file `NUL` không hợp lệ với `core.excludesFile`; guard nay
  trỏ cả attributes/excludes vào hai sentinel 0 byte đang được lease và positive clean-status test
  ngăn availability regression.
- **R7:** `PRYNX.bat`/`PHAT_HANH.bat` dùng `%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe`,
  bỏ ambient `%SystemRoot%`/`PATH` khỏi bootstrap trước guard.

Policy `hosts.yml` là kiểm lexical fail-closed cho credential key và YAML block-style canonical đã
đối chiếu với GitHub CLI 2.93.0, **không phải YAML-general scanner**. Không thêm `--secure-storage`:
secure credential store là hành vi mặc định của `gh`, còn publisher chủ động dừng trước network nếu
phát hiện fallback plaintext/cú pháp ngoài policy.

**Snapshot verify 2026-09-04:** backend token/body/route/probe **144/144**; frontend
auth/license **89/89** + typecheck; Edge **36/36**; Rust Tauri **227 passed, 5 ignored**,
`cargo check --release --lib` và `cargo fmt -- --check` đạt; Save As registry **23/23**. Delta release:
`test_release_secret_store.py` từng **19 pass + 3 `[BLOCKED-ENV]` trong sandbox**, và sau bản vá
availability R6 đã đạt **22/22 ngoài sandbox**;
`test_artifact_runtime_self_test.py` **55 pass + 1 `[BLOCKED-ENV]`**; cả bốn ca môi trường đạt
**4/4 ngoài sandbox**; no-Ghostscript **49/49**; native release QA **1/1**; grammar/wrapper/AST
**3/3**. Parser Windows PowerShell 5.1 + pwsh 7 đạt cho bốn script, `py_compile` đạt hai test file;
independent YAML/line-ending/BAT verifier sạch. **191/191** ở trên là route coverage, không phải số test.

Checkout hiện tại bị guard chặn đúng thiết kế: `.git/config` có
`extensions.worktreeConfig=true`, `.git/info/exclude` dài 335 byte/non-empty và
`.git/info/attributes` thiếu. Không normalize trực tiếp vì checkout còn 53 tracked change, 5.679
untracked entry, hai linked worktree và 81.753 file quarantine đang bị local exclude che. Chốt đúng
source, commit/push rồi tạo standalone clone và chuẩn hóa metadata 0 byte tại clone đó. Đây là
prerequisite cục bộ, không phải `[EXTERNAL]`.

**Release tiếp tục `HOLD`.** Các chốt còn `[EXTERNAL]`: DB/Edge production; rotate/revoke/audit
secret/key thật; Authenticode certificate/artifact; TPM/CNG và policy no-TPM; clean build/install/
uninstall cùng fault-injection VM; Save As UI/NAS/non-NTFS; quyền GitHub push/release, `gh` tương lai
và packaged double-click/hostile-`PATH`. Ba PE hiện có đều `NotSigned`, không có cert code-signing;
TPM/CNG chỉ xác nhận được device-not-ready trong context hiện tại. Updater key fail guard do ACL kế
thừa; `supabase/.temp/tok.json`/`resp.json` phải coi là credential-bearing, revoke trước khi xóa.
BAT không thể tự chứng minh
interpreter đầu tiên; file association/explicit wrapper giả cùng admin/debugger/memory patch ở
Ring-3 là residual accepted risk, không thể bị loại bỏ tuyệt đối bằng client-only DRM.

> Báo cáo gốc: `docs/BAO_CAO_AUDIT_CHONG_CRACK_2026-08-28.md`
> Quy trình: `prynx-audit-workflow` giai đoạn 3 (sửa theo lô ≤5 file, verify sau mỗi lô).
> Hai repo: `d:\pdfcompare` (client + sidecar), `d:\printsolutions-main` (server Supabase).
>
> **14/15 finding lịch sử đã có xử lý source/test hoặc lifecycle được chấp nhận.** §SEC.03 vẫn
> cần bằng chứng production; §SEC.11 là accepted risk cần quyết định Authenticode. §SEC.15 đã
> được supersede bởi addendum 2026-09-04; không dùng con số này để suy release đã sẵn sàng.

---

## Bảng trạng thái finding

| ID | Mức | Trạng thái | Lô |
|---|---|---|---|
| §SEC.01 | 🔴 P0 | **Verified** — Free không còn gọi được endpoint CNC/máy bế | A |
| §SEC.02 | 🟠 P1 | **Applied** (đã verify trên Postgres tạm; chờ `db push`) | D |
| §SEC.03 | 🟠 P1 | **Còn mở** — cần dump từ production | — |
| §SEC.04 | 🟠 P2 | **Verified** — vá tại gốc, có test junction thật | B |
| §SEC.05 | 🟠 P2 | **Verified** — allowlist tiến trình | C |
| §SEC.06 | 🟠 P2 | **Applied** (chờ deploy) | E |
| §SEC.07 | 🟠 P2 | **Verified** — staging grant đòi `fs_scope` | C |
| §SEC.08 | 🟠 P2 | **Applied** (đã verify trigger; chờ `db push`) | D |
| §SEC.09 | 🟠 P2 | **Accepted risk** — giữ nguyên, đã có tài liệu | — |
| §SEC.10 | 🟠 P2 | **Applied** (chờ set secret + deploy) | E |
| §SEC.11 | 🟡 P3 | **Accepted risk** — cần code signing | — |
| §SEC.12 | 🟡 P3 | **False positive → đã đóng** + gate thường trực | F |
| §SEC.13 | 🟡 P3 | **Verified** — mọi test entitlement nay tự bật gate | A/G |
| §SEC.14 | 🟡 P3 | **Verified** — thêm test + mở rộng phạm vi CI | G |
| §SEC.15 | 🟡 P3 | **Applied → Verified (source/test)** — runtime UI/NAS/non-NTFS `[EXTERNAL]` | addendum 2026-09-04 |

---

## Lô A — §SEC.01: Free dùng được tính năng Pro (P0)

**File:** `backend/app/workers/cut_export/api.py`,
`backend/app/workers/cut_export/tests/test_api.py`, `backend/tests/test_free_token_e2e.py`

| Thay đổi | Lý do |
|---|---|
| `APIRouter(dependencies=[Depends(require_license), Depends(require_feature("impo.cnc"))])` | Router chỉ có `require_license` ⇒ license Free hợp lệ gọi được 10 endpoint xuất luồng cắt và đẩy TCP/serial tới máy bế. Gate ở **cấp router** để endpoint thêm sau tự động có quyền. |
| Test override `lambda: True` → dict `_PRO_LICENSE` | Override cũ là **bool**, nó vô hiệu hoá luôn `require_feature` (vì `require_feature` phụ thuộc `require_license`) ⇒ bộ test đó **không thể** phát hiện lỗ này. |
| Fixture `gating_on` (monkeypatch `FEATURE_GATING_ENABLED=True`) | Chạy từ source thì gate mặc định **TẮT** (§SEC.13). Không bật tường minh thì mọi assert 403 xanh giả. |
| 3 assert cut-export trong `test_free_token_e2e.py` | E2E dùng chuỗi license THẬT (HMAC + Ed25519 + entitlement), nằm trong `tests/` nên chắc chắn chạy ở CI. |

**Verify:** 43 passed.
**Kiểm độ nhạy:** tạm bỏ gate → **10 failed / 33 passed**; phục hồi → 43 passed. Test có răng thật.

**Ghi chú không gây hồi quy UI:** tab "Máy bế" trong `SettingsModal.tsx:61-64` đã bị comment ẩn từ trước, nên gate cả router không làm vỡ lối vào nào của người dùng Free.

---

## Lô B — §SEC.04: `is_sensitive_path` bị đi vòng

**File:** `desktop/src-tauri/src/lib.rs`

Hàm cũ so khớp **chuỗi thô** do renderer gửi, nên mọi biến thể cùng trỏ một file đều lọt.
Vá tại **gốc** (giữ nguyên signature ⇒ cả 20+ call-site được bảo vệ), thay vì vá lẻ 4 call-site nóng như trước:

1. `strip_path_prefix_aliases()` — bóc `\\?\`, `\??\`, `\\?\UNC\` → `\\`; lặp 4 lượt vì Win32 nhận tiền tố lồng nhau.
2. `is_admin_or_device_share()` — chặn `\\.\` và UNC có share kết thúc bằng `$` (`\\localhost\C$`). **Share NAS hợp lệ của xưởng in dùng tên share nên không bị chặn** — luồng mở PDF trên mạng vẫn chạy.
3. Canonicalize khi path tồn tại rồi so **lại** — bước này mới thật sự bịt tên 8.3, junction và symlink.
4. `is_sensitive_write_path` tách tương tự; fallback resolve thư mục **cha** vì đích ghi thường chưa tồn tại. Bổ sung chặn Startup per-user (trước đây lệch với `fs:allow-write-file` deny).

**Test mới:** `sensitive_path_khong_bi_di_vong_bang_bien_the_path` (có assert chốt rằng cách so **cũ** để lọt — nếu ai gỡ normalization thì test đỏ kèm lý do), `sensitive_path_resolve_junction_ve_thu_muc_nhay_cam` (tạo junction thật, `#[cfg(windows)]`).

**Verify:** `cargo test --lib` = 162 passed.

---

## Lô C — §SEC.05 + §SEC.07

**File:** `desktop/src-tauri/src/external_app.rs`, `desktop/src-tauri/src/lib.rs`,
`desktop/src/components/imposition-tools/OpenInDesignModal.tsx`

### §SEC.05 — `launch_external_app` chạy `.exe` tuỳ ý

Guard cũ chỉ là "đuôi `.exe` + tồn tại + không nhạy cảm" ⇒ renderer bị patch/XSS chạy được `.exe` bất kỳ trong Downloads hoặc `\\attacker\share\evil.exe`. Đây là primitive mạnh nhất renderer có trong toàn bộ bề mặt IPC.

Nay phải qua allowlist, **ba nguồn đều không do renderer quyết**:
1. kết quả `detect_design_apps` (Rust đọc registry rồi `is_file()`) — nay được ghi nhận tự động;
2. path người dùng vừa chọn qua hộp thoại native (thể hiện bằng `fs_scope`);
3. path đã duyệt ở phiên trước (`design-apps-approved.json` trong `app_data_dir`, trần 16 mục).

Thêm chặn `is_network_or_device_path` + symlink. Phần quyết định tách thành `decide_app_authorization()` thuần để unit-test được.

**UX:** máy đã nhớ đường dẫn tuỳ chọn trong `localStorage` **từ trước bản vá** sẽ bị từ chối đúng một lần. `doOpen` nay tự mở lại hộp thoại khi gặp lỗi "chưa được cấp quyền", nên người dùng không phải tự mò lại nút "Chọn .exe".

### §SEC.07 — staging grant hợp pháp hoá path vượt `fs_scope`

`copy_file_atomic` không kiểm `fs_scope`, mà đích có tên staging của New Window lại được cấp quyền một lần để mở cửa sổ tài liệu **không cần** `fs_scope`. Nay **chỉ** đường đặc quyền đó đòi canonical source nằm trong `fs_scope`, kiểm **trước** khi copy (không để lại file rác ở `%TEMP%`). Save As bình thường không đổi.

**Verify:** `cargo check` EXIT=0; `cargo test --lib` = 164 passed; `tsc --noEmit` EXIT=0; vitest `OpenInDesignModal` 9/9.

---

## Lô D — §SEC.02 + §SEC.08 (repo `printsolutions-main`)

**File:** `supabase/migrations/20260828100000_prynx_activation_hardening.sql` (mới),
`supabase/migrations/security-manifest.json`, `supabase/tests/*.sql` (3 file mới)

### Rà consumer TRƯỚC khi sửa — điều này quyết định thiết kế bản vá

`verify_license_guarded` được GRANT cho `anon` với `p_product_id DEFAULT 'prynx'`. Phản xạ đầu tiên là REVOKE khỏi `anon` — **nhưng làm vậy sẽ khoá chết toàn bộ tool đang bán**:

| Tool | product_id | Đường gọi |
|---|---|---|
| `1. Nô lệ bế xén*.jsx` | `bexen` | RPC trực tiếp, anon key |
| `2. dev Nô lệ mẹc số.jsx` | `mecso` | RPC trực tiếp |
| `3. Nô lệ mẹc bìa.jsx` | `mecbia` | RPC trực tiếp |
| `4. dev Nô lệ dữ liệu.jsx` | `dulieu` | RPC trực tiếp |
| `multi_tem_placer.jsx` | `multi_tem_placer` | `verify_license_guarded` |
| `LicenseBridge.ps1` | tham số `-ProductId` | RPC trực tiếp |
| `PrintMonitorApp` | `print_monitor_app` | qua Edge |

**Không tool nào gửi `prynx`.** Nên bản vá siết đúng mặt bị lạm dụng: chặn `product_id='prynx'` trên đường công khai, giữ nguyên quyền `anon` cho mọi sản phẩm khác.

### Sáu mục của migration

1. `prynx_caller_is_service_role()` — đọc **chỉ** `request.jwt.claims->>'role'`. Fail-closed.
2. `prynx_trusted_request_ip()` — `cf-connecting-ip` → `x-real-ip` → **hop cuối** của XFF; đọc `request.headers` (JSON, PostgREST v10+) trước rồi mới tới GUC lẻ.
3. `verify_license` dựng lại — chặn `prynx`; `pg_advisory_xact_lock` quanh ĐẾM→CHÈN; dùng IP tin cậy. **Giữ nguyên hình dạng response** vì các `.jsx` đang parse `status`/`expires_at`/`remaining_days`.
4. `verify_license_guarded` dựng lại — chặn `prynx` ngay ở cửa (không tiêu rate-limit cho request đã bị từ chối).
5. Thu hồi quyền: overload ≠3 tham số khỏi `PUBLIC, anon, authenticated`; `PUBLIC` trên 3-param rồi GRANT lại tường minh.
6. Trigger `prynx_release_resource_key_immutable` — chặn `UPDATE resource_key` khi `revoked_at IS NULL` (§SEC.08). Đường thu hồi hợp pháp vẫn mở.

### Verify — harness Postgres 16 trong Docker đã bắt 4 lỗi THẬT trong chính bản vá này

Đây là phần đáng ghi lại nhất của cả đợt: đọc SQL không đủ.

| # | Lỗi trong bản vá đầu | Hậu quả nếu ship |
|---|---|---|
| 1 | Nhánh dự phòng `session_user in ('postgres',...)` | `SET ROLE` **không** đổi `session_user` ⇒ request anon vẫn qua ⇒ **fail-open, lớp chặn vô hiệu** |
| 2 | `return v_claims_role = 'service_role'` | Claims thiếu/rỗng ⇒ NULL; `IF NOT NULL` **không** vào nhánh chặn ⇒ **fail-open** |
| 3 | Chỉ đọc GUC `request.header.*` | Tên GUC hai dấu chấm không set được; PostgREST v10+ dùng `request.headers` JSON ⇒ rate-limit luôn bucket `unknown` |
| 4 | Chỉ revoke `anon`/`authenticated` | `PUBLIC` có EXECUTE **mặc định** ⇒ `has_function_privilege('anon', ...)` vẫn TRUE ⇒ thu hồi vô nghĩa |

Sau khi sửa: 8 nhóm ca (CA1–CA8) toàn bộ đạt mong đợi — `prynx` qua anon = FORBIDDEN kể cả biến thể hoa/thường và claims rác; `bexen`/`mecso`/`mecbia`/`dulieu`/`multi_tem_placer` không bị ảnh hưởng; `service_role` vẫn kích hoạt được; trigger chặn đúng và vẫn cho đổi sau khi thu hồi.

**Đua đếm thiết bị (pgbench, 16 client song song, license trần 2 máy):**

| | Số máy kích hoạt được |
|---|---|
| Code cũ (không advisory lock) | **16** |
| Code mới | **2** |

Harness lưu tại `supabase/tests/` để tái chạy (hướng dẫn Docker trong header file).

---

## Lô E — §SEC.06 + §SEC.10 (repo `printsolutions-main`)

**File:** `supabase/functions/bin-packing/index.ts`, `supabase/functions/license-release/index.ts`,
`src/securityAuditAntiCrack2026_08_28.test.ts` (mới)

### §SEC.06 — `bin-packing` fail-open + không trần input

Hai fail-open độc lập:
- toàn bộ kiểm subscription nằm trong `if (authHeader)` không có `else`, kèm comment *"allow anonymous access for now (tool gate handles client-side)"*. Nhưng solver guillotine chính là loại IP mà `HYBRID_ANTICRACK_REPORT.md` khuyên đưa lên server **để giấu** — để nó gọi ẩn danh là biến thuật toán thành API công khai. "Tool gate ở client" không phải biên cưỡng chế.
- `if (subData && !subData.has_access)` — `subData` null thì vượt qua.

Nay: thiếu `Authorization` → 401; `!subData || subData.has_access !== true` → 403. Thêm `validateLayoutInput()` với trần `MAX_ITEM_KINDS=2000`, `MAX_QUANTITY_PER_ITEM=10000`, `MAX_TOTAL_PIECES=50000`, `MAX_DIMENSION_CM=10000`, `MAX_CANVAS_CM=10000`, kiểm **trước** khi bung `flatJobList` → 422. Error handler trả `error.name` thay vì `error.message` (chuẩn anti-recon, theo bản vá BG2 ở `SECURITY_ARCHITECTURE` §22.2).

**Không đụng người dùng thật:** `src/hooks/useBinPacking.ts:65` dùng `supabase.functions.invoke` (luôn kèm Authorization), và `check_tool_subscription` luôn trả JSONB có `has_access`. Bản vá chỉ đóng đường `curl` không header.

### §SEC.10 — `license-release` được cấp private key

Function **chỉ verify** nhưng đọc `LICENSE_SIGNING_KEY` rồi `ed.getPublicKey()` để suy public key ⇒ mở rộng bán kính rò khoá ký license của toàn hệ thống một cách vô ích. Nay đọc `LICENSE_PUBLIC_KEY` (kiểm đúng 32 byte), fail-closed nếu chưa set. **Cố ý không fallback** về private key — fallback sẽ khiến bước set secret bị bỏ quên mãi.

**Verify:** `esbuild` parse cả hai file EXIT=0. Ratchet chạy lần đầu **đỏ 3 ca** vì chính comment giải thích của tôi chứa lại chuỗi cũ (`LICENSE_SIGNING_KEY`, `"allow anonymous access"`, `if (subData && !subData.has_access)`) → thêm `stripTsComments()` (scanner theo ký tự, không cắt `//` trong chuỗi để không phá import URL) + một test kiểm chính helper đó. Sau sửa: 53/53 passed.

---

## Lô F — §SEC.12: JWT literal trong repo → **không phải lỗ**

Đo bằng scanner tự viết (dùng `git ls-files`; `rglob` phải liệt kê cả `node_modules` nên chậm tới mức không dùng được):

| Chỉ số | Kết quả |
|---|---|
| JWT literal trong `printsolutions-main` | 32 |
| JWT literal trong `pdfcompare` | 0 |
| Số khoá **khác nhau** | **1** |
| `role` | **`anon`** cho cả 32 vị trí |
| project ref | `ryvyuxjgdcvoxujqmggm` |

**Không có `service_role` key nào bị commit.** Anon key công khai là đúng thiết kế.

Rủi ro thật là **tương lai**: một lần dán nhầm `service_role` là compromise toàn hệ thống (bypass mọi RLS ⇒ đọc `release_resource_keys` ⇒ lấy khoá engine dieline). Nên lần kiểm thủ công này đã thành **gate thường trực**: 3 test trong `src/securityAuditAntiCrack2026_08_28.test.ts`, gồm một test độ nhạy dùng token **tự dựng** `role=service_role` (chứng minh scanner đọc được role thật) và một test chống phạm vi quét rỗng. Test **không bao giờ in token** — chỉ `file:dòng` + `role`, vì log CI là nơi công khai.

---

## Lô G — §SEC.14 + ratchet chống tái phát cả *class* lỗi

**File:** `.github/workflows/ci.yml`, `backend/tests/test_pro_feature_enforcement_coverage.py` (mới),
`backend/tests/test_sticker_sheet_feature_gate.py` (mới)

### Phát hiện khi làm lô này: CI không chạy test của cut_export

`backend-lint` chạy `pytest tests/`, còn bộ test cut_export nằm ở `app/workers/cut_export/tests/` ⇒ **CI chưa bao giờ chạy nó** — đúng module vừa bị phát hiện thiếu gate. Đã đổi thành `pytest tests/ app/workers/cut_export/tests/`.

### Ratchet: mọi quyền Pro phải được cưỡng chế ở backend

Đây là phần quan trọng nhất về dài hạn: nó đóng **class** lỗi §SEC.01, không phải một instance. Thêm quyền vào `PRO_FEATURES` mà không enforce ở đâu ⇒ CI đỏ ngay.

Ratchet lập tức bắt được `prepress.paper_library`. Đã xác minh đây **không phải sót** mà là accepted risk đã ghi (threat model §6: Paper Library chạy hoàn toàn trong WebView, gate ở `PaperLibraryTool.tsx:247`, **0** bề mặt backend). Xử lý: đưa vào `_CLIENT_ONLY_ACCEPTED_RISK` kèm **kiểm hai chiều** — nếu một ngày backend enforce nó thì test đỏ và buộc xoá khỏi danh sách miễn trừ + cập nhật threat model. Không có chiều ngược này thì danh sách miễn trừ chỉ phình ra và âm thầm che mất lỗ thật.

### Test 403 cho `sticker_sheet`

`test_sticker_sheet_api.py` dài 2133 dòng nhưng **0 assert 403**, trong khi router có 10 endpoint gate `prepress.cutline`. Đã thêm test cho cả 10 endpoint + grant lẻ mở được + grant tool khác không mở được.

**Verify:** `pytest tests/ app/workers/cut_export/tests/` = **4330 passed, 2 skipped, 0 failed**.

---

## Còn lại — cần bạn thực hiện

### A. Bắt buộc trước khi bản vá server có hiệu lực

1. **`supabase db push`** migration `20260828100000_prynx_activation_hardening.sql`, rồi chạy mục **KIỂM SAU DEPLOY** ở cuối file (5 bước, 4 bước đầu chỉ-đọc).

   ⚠️ **Bước 3 là bước nguy hiểm nhất:** phải xác nhận PrynX vẫn kích hoạt được bằng license thật trên app đã cài. Nếu `verify_license_edge` gọi `verify_license` mà JWT claims **không** mang `role=service_role` thì lớp chặn mới sẽ **chặn oan chính PrynX**. Không xác minh được từ repo vì `verify_license_edge` **không có định nghĩa trong repo** (§SEC.03). Nếu gặp FORBIDDEN: xử §SEC.03 trước, đừng nới lớp chặn.

2. **`supabase secrets set LICENSE_PUBLIC_KEY=<base64 raw public key>`** rồi mới deploy `license-release`. Giá trị = `_LICENSE_PUBLIC_KEY_B64` trong `backend/app/core/license_guard.py`. Thiếu bước này thì function fail-closed 403.

3. Deploy `bin-packing`.

### B. §SEC.03 — đóng khoảng trống provenance

`supabase db pull` (hoặc dump định nghĩa `verify_license_edge`) rồi commit thành migration có số thứ tự, cập nhật `security-manifest.json`. Hiện tại một clean checkout **không dựng lại được** production: ba migration `20260726*` đã mất, và bốn control mà audit trước ghi là "đã chắc" (advisory lock activation, rate-limit theo IP tin cậy, khoá tài nguyên bất biến, REVOKE khỏi anon) không có bằng chứng nào trong repo. Cần credential production nên tôi không làm được.

### C. §SEC.11 — quyết định thương mại `[HISTORICAL · residual vẫn hiện hành]`

Tại snapshot 2026-08-28, integrity của exe/frontend **không được cưỡng chế** trên bản NSIS
(Tauri nhúng `dist/` vào binary nên nhánh kiểm bị skip). Authenticode + `WinVerifyTrust` là
control artifact/publisher còn thiếu và sẽ làm đường patch rẻ khó hơn; một hash nhúng trong chính
exe không thể tự làm trust anchor. Control này vẫn không ngăn tuyệt đối admin patch cả binary lẫn
self-check ở Ring-3. Đây là quyết định chi phí và residual thương mại, không phải lời hứa client
“không thể crack”.

### D. §SEC.15 — trạng thái lịch sử đã được supersede

Tại snapshot 2026-08-28, `save_as_only` chỉ là hint gửi renderer và spec
`save-as-artifact-guard` còn mở. Source hiện tại đã có grant/lease native bind cửa sổ–target–TTL,
khóa source và ancestor không share `DELETE`, cùng timer tự thu hồi sau 2 phút; trạng thái là
**Applied → Verified (source/test)**. UI bản cài, NAS và filesystem không phải NTFS vẫn
`[EXTERNAL]`.

### E. §SEC.09 — giữ nguyên có chủ ý

Cổng `rk` cho phép 3 bản/giờ, không có trần tổng. Đây là đánh đổi **đã có tài liệu** (nhịp phát hành thật ~10 bản/30 ngày nên trần tổng bắn vào chính khách hàng). Nếu mô hình đe doạ của bạn là "đối thủ mua một license Pro rồi kiên nhẫn thu khoá mọi bản" thì cần thêm trần mềm để **báo động**, không chặn.

---

## Điều KHÔNG được suy diễn từ log này

1. **Chưa QA trên bản đã cài.** Toàn bộ verify là test tự động + harness cục bộ. Các lô B/C sửa Rust nên phải chạy `build_production.ps1` rồi kiểm thật: mở PDF trên NAS (`\\nas\...`), mở file bằng Illustrator/Corel (cả đường dò được và đường tự chọn `.exe`), New Window, Save As, đường IN.
2. **Chưa có bản cài nào chứa các bản vá này.** Mọi mục release-only vẫn phải QA sau khi build (§15.1 của `SECURITY_ARCHITECTURE`).
3. **Bản vá server chưa chạy trên production** — chỉ chạy trên Postgres 16 tạm với schema stub.
4. **`printsolutions-main` có 6 test đỏ có sẵn** (`ScrollToTop` 3, `nestingEngine` 3), không do đợt này. Hai file đó chỉ import `@/engine/dieline/*` và component UI.
5. **Working tree `pdfcompare` không sạch** từ trước đợt này (WIP mixed_nesting). Build phát hành phải từ cây đã commit.
