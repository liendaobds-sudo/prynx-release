# BÁO CÁO AUDIT SẴN SÀNG BUILD / RELEASE PRYNX — 2026-08-03

> **CẬP NHẬT SAU DUYỆT/SỬA — 2026-08-03:** Pipeline build nội bộ đã hoàn tất end-to-end và tạo
> `PrynX_1.0.0-rc.1_x64-setup.exe`. Trạng thái hiện tại là **GO cho test nội bộ tĩnh/build artifact**,
> nhưng vẫn **NO-GO cho phát hành công khai**: worktree dirty, dieline plaintext theo cờ dev,
> `RUNTIME_VERIFIED=no`, và máy hiện tại có bản PrynX cũ nên verifier từ chối ghi đè. Không có
> upload, push, commit hoặc thao tác GitHub nào. Chi tiết nghiệm thu mới nằm ở §9 và
> `docs/BUILD_RELEASE_FIXES_2026-08-03.md`.

**Kết luận tại chốt 1 (trước sửa):** **NO-GO — chưa được phát hành `1.0.0-rc.1`.**

Pipeline mà chủ dự án vừa chạy không hỏng ở Nuitka hoặc Tauri. Nó dừng đúng thiết kế tại
cổng Release QA `[0/5]`. Tuy nhiên, khi chạy độc lập các cổng phía sau, audit còn phát hiện
thêm lỗi frontend, lỗi tái lập môi trường native, cổng no-Ghostscript không hoàn tất và các
khoảng trống fail-fast của quy trình tạo/upload artifact.

Tài liệu này là **chốt 1 — khảo sát và phát hiện** theo `prynx-audit-workflow`. Chưa sửa code,
chưa cập nhật snapshot, chưa build/ký/upload installer và chưa thay đổi secret.

## 1. Ngữ cảnh và phạm vi

- Mode: production-readiness audit + static release/security review.
- Repo: `D:\pdfcompare`.
- Nhánh: `security/audit-2026-07-25`.
- HEAD lúc audit: `0f1a9ba5521b2e96b688dd4eb3761e9ed042a03a`.
- Version đã đồng bộ trong Tauri/npm/Cargo/publisher: `1.0.0-rc.1`.
- Snapshot worktree trước khi tạo báo cáo: 96 entry bẩn, gồm 85 entry tracked và 11 entry
  untracked; `git diff` có 83 file, 6.374 dòng thêm và 421 dòng xoá.
- Môi trường audit: Windows, Node `24.13.0`, npm `11.6.2`, Rust `1.94.0`, Python venv
  `3.12.13`.

### Included

- `build_production.ps1`, `scripts/run_release_qa.ps1`, `release_update.ps1`, cấu hình Tauri,
  lockfile và resource bắt buộc.
- Transcript build do chủ dự án cung cấp.
- Backend/frontend/Rust gates có thể chạy độc lập mà không phát hành artifact.
- Secret/config hygiene hiện tại, dependency advisory scan và CI wiring liên quan release.
- Các thay đổi đang có trong dirty tree ở mức cần thiết để truy nguyên test/build blocker.

### Excluded / proof gap

- Không tạo installer thật, không gọi Supabase để tạo resource key và không dùng signing key.
- Không cài/chạy artifact release thật; chưa kiểm sidecar health/HMAC, PDFium, OCR, DirectML,
  model ONNX và updater signature trên bản đã cài.
- Không upload GitHub Release, không kiểm trạng thái Edge Function/migration/secret production.
- Không audit lại toàn bộ correctness của 83 file đang đổi; báo cáo này chỉ chốt readiness của
  pipeline và các lỗi lộ ra từ gate.
- Không chạy history-wide secret scanner như gitleaks; chỉ quét file tracked hiện tại và pattern
  bí mật phổ biến mà không in giá trị.

## 2. Đường chạy release đã trace

```text
build_production.ps1 -Release -Version ...
  → đồng bộ version vào source/lockfile                         (:91-135)
  → scripts/run_release_qa.ps1                                 (:186-195)
      → pip check + Preflight golden + Free-token E2E           (:36-39)
      → full backend pytest                                     (:41-45)
      → no-GS corpus 18 PDF × 16 thao tác                       (:47-55)
      → npm ci staging + typecheck + Vitest                     (:57-112)
      → imposition_core / print_engine / native / Tauri Rust    (:114-139)
  → bundle engine dieline + khoá resource theo version          (:215-350)
  → maturin wheel staging                                       (:351-435)
  → model/import checks + Nuitka onefile                        (:436-690)
  → sidecar/resources/NOTICE/hash                               (:698-851)
  → Vite production build + frontend hash                       (:853-892)
  → Tauri/NSIS + manifest                                       (:894-983)
  → chỉ IN lệnh verify_installed_artifact.ps1                   (:981-983)
release_update.ps1
  → tạo latest.json → upload installer/.sig/latest.json         (:165-200)
```

Transcript dừng ở `scripts/run_release_qa.ps1:42`; traceback tại dòng 28 chỉ là wrapper ném
lại mã thoát pytest. Vì vậy transcript ban đầu **không cung cấp bằng chứng** cho no-GS,
frontend, Rust, Nuitka hoặc Tauri.

## 3. Tóm tắt gate

| Gate | Kết quả | Bằng chứng chính |
|---|---:|---|
| Python dependency consistency | PASS | `pip check`: không có dependency hỏng |
| Preflight golden | PASS có gap | 44 pass, 1 skip; TAC fixture vẫn bị skip sai thời |
| Free-token entitlement | PASS | 1/1 |
| Backend full pytest | **FAIL** | 2.068 pass, 5 skip, 4 fail |
| Frontend typecheck | PASS | `tsc --noEmit` |
| Frontend full Vitest | **FAIL** | 1.764 pass, 2 skip, 6 fail |
| Frontend production build | PASS | 3.518 module transform, Vite build hoàn tất |
| Dieline sidecar + WebView leak check | PASS | hash bundle không đổi; protected entry không lọt WebView |
| ESLint toàn repo | FAIL baseline | 1.452 error, 106 warning |
| Lint budget ratchet | **FAIL** | `react-refresh/only-export-components` 45 > 32 |
| `imposition_core` | PASS | 37 test + release check |
| `print_engine` | PASS | 565 test + release check |
| Native PyO3 | **FAIL theo script**, PASS khi sửa PATH tạm | `0xc0000135`; sau khi thêm `sys.base_prefix`: 38 test + release check |
| Tauri shell | PASS | 47 test + release check |
| No-GS corpus | **INCOMPLETE / TIMEOUT** | 15 phút, dừng ở file 8/18 tại `pdfx:x1a` |
| npm audit | PASS | 0 advisory ở runtime và dev |
| pip-audit | PASS | 0 advisory ở requirements chính và DirectML |
| cargo-audit | PASS có warning | không có vulnerability chặn; có advisory warning/không-maintained |
| Nuitka + NSIS + installed smoke | CHƯA CHẠY | bị chặn trước đó và thuộc chốt sau khi sửa |

## 4. Phát hiện

Quy ước: P0 = sai kết quả/hỏng nghiệp vụ; P1 = chặn release hoặc có thể tạo artifact không
đáng tin; P2 = độ tin cậy/nợ kỹ thuật/proof gap; effort S/M/L.

### §REL.01 — [VERIFIED] P0 / S — Công thức gáy Fort keo nhiệt trả sai số workbook

- Dirty diff đổi hệ số `uncoated.hotmelt` từ `0.3` thành `0.25` tại
  `desktop/src/lib/paperLibrary/spine.ts:83`.
- Ngay comment nguồn tại `spine.ts:59-60` vẫn ghi hệ số workbook `BF=0.3`.
- Oracle chạy cô lập: Fort 58, 26 trang, keo nhiệt phải là `0.9802 mm`, code hiện trả
  `0.9425 mm` — lệch `0.0377 mm`.
- Consumer live: `PaperLibraryTool.tsx:78-82` gọi `calcSpineThickness`; dòng 177 hiển thị
  `result.spineMm` trực tiếp cho người dùng.

**Kết luận:** đây là lỗi correctness production, không phải test drift. Không được đổi test theo
kết quả `0.9425` trừ khi chủ dự án cung cấp workbook mới và duyệt thay đổi nghiệp vụ.

### §REL.02 — [VERIFIED] P1 / M — `imposition.py` vượt ratchet do logic preview mới nằm trong route

- `backend/app/api/routes/imposition.py`: `3.973` dòng, trần `3.878` tại
  `backend/tests/test_god_file_ratchet.py:37-43,60-71`.
- HEAD đúng bằng trần; worktree hiện tại thêm ròng 95 dòng (`+106/-11`).
- Khối mới ở `imposition.py:2749-2908`, đặc biệt nested helper `_build_ratio_sheet_mp`
  tại khoảng dòng 2785, đang thực hiện dựng layout thay vì chỉ điều phối route.

**Hướng đúng:** rút logic ratio-stack preview về solver/worker có test parity. Không nâng ceiling
chỉ để test xanh.

### §REL.03 — [VERIFIED] P1 / L — Ratchet `nup_engine.py` đã stale từ lúc được tạo và tiếp tục trôi

- `backend/app/workers/nup_engine.py`: `4.105` dòng, trần `3.716`.
- Commit tạo ratchet `70ef2a6` đã có file khoảng 4.024 dòng; HEAD hiện có 4.033 dòng. Nghĩa là
  ratchet này đã đỏ từ baseline trước, không phải toàn bộ 389 dòng vượt trần đều do worktree mới.
- Worktree hiện tại vẫn thêm ròng 72 dòng vào engine đã quá lớn.

**Quyết định cần duyệt:** khuyến nghị tách một khối chức năng độc lập (ratio-stack/template hoặc
final assembly/report) rồi hạ ceiling về số thật sau refactor. Chỉ reset ceiling là nhanh nhưng
trái mục tiêu kiến trúc đã ghi trong chính test.

### §REL.04 — [VERIFIED] P1 / S — Hai lỗi homogeneous là test-harness cũ, không phải lỗi pikepdf

- `_CaptureAllPool.map()` tại `test_sticker_homogeneous_integration.py:36-51` mới là nơi ném
  `_StopEngine`.
- Hai test lại monkeypatch `os.cpu_count()` về 2 và `process_chunk()` trả `b''`
  (`:293-303`, `:371-377`).
- Chính sách chunking hiện chọn một worker và chạy nội tuyến tại `nup_engine.py:3694-3703`, nên
  fake pool không bao giờ được gọi. `b''` rơi tới merge tại `nup_engine.py:3747`, sinh
  `FileNotFoundError` dây chuyền.

**Kết luận:** sửa seam dừng test sau khi capture placements; không hoàn tác tối ưu inline và không
vá pikepdf. Sau sửa vẫn phải chạy các assertion quantity/placement có sẵn.

### §REL.05 — [VERIFIED] P1 / M — Full Vitest chưa tất định và còn golden drift chưa duyệt

Full suite: 6 fail / 1.764 pass / 2 skip.

- Hai snapshot store fail ổn định vì các field `mixedExcessPercent` và
  `resizeSettings.autoTrimBefore/bgFillColor/bgFillMode/resizeByContent` đã có trong state nhưng
  snapshot chưa nhận. Đây là baseline đã ghi tại
  `docs/BAO_CAO_AUDIT_LUONG_MO_FILE_2026-08-02.md:654` và
  `docs/RESIZE_TRANSPARENCY_FIXES_2026-08-03.md:49`.
- `api.upload.test.ts` có 2 timeout/failure khi chạy full nhưng 2/2 pass khi chạy cô lập.
- Property `structural panels do not overlap (tray)` timeout ở full suite nhưng pass cô lập trong
  0,7 giây; không có counterexample hình học được tạo ra.
- §REL.01 là failure correctness riêng, vẫn fail khi chạy cô lập.

**Kết luận:** snapshot chỉ cập nhật đúng hai diff đã review; không `-u` cả bộ. Hai test theo tải cần
làm deterministic (seam/time budget/parallelism), không gọi chúng là lỗi geometry/API production
khi bằng chứng hiện tại chỉ là timeout dưới tải.

### §REL.06 — [VERIFIED] P1 / M — Release đang được phép build từ cây không tái lập

- Worktree có 96 status entry; thay đổi chưa commit chứa cả code, test, golden, generated bundle và
  file untracked.
- `build_production.ps1:94-135` sửa version ngay trước QA, nên một lần build fail vẫn để source và
  lockfile thay đổi.
- Manifest chỉ ghi `GIT_DIRTY` tại `build_production.ps1:967-968`; `-Release` không fail-fast.

Theo `audit-rules.md` §14.7, artifact giao khách phải sinh từ cây đã commit và sạch. Trạng thái hiện
tại không chứng minh checkout sạch nào chứa đủ 83 file thay đổi này.

### §REL.07 — [VERIFIED] P1 / M — Hợp đồng toolchain khai báo không khớp dependency đã khóa

1. **Node:** README ghi `18+` (`README.md:68`), setup chấp nhận mọi Node và fallback cài `20.18.0`
   (`setup_dev_env.ps1:89-103`), nhưng Vite `8.0.16` yêu cầu
   `^20.19.0 || >=22.12.0` (`desktop/package-lock.json:6623-6641`). `package.json` không khai
   `engines`.
2. **Rust:** `desktop/src-tauri/Cargo.toml:8` khai `rust-version = "1.77.2"`, trong khi lock hiện có
   `darling 0.23.0`, `image 0.25.10`, `time 0.3.47` cùng yêu cầu Rust `1.88.0` (đã xác minh bằng
   `cargo metadata --locked`).
3. **Python:** tài liệu/setup quy định 3.11, nhưng venv và transcript dùng 3.12.13. `run_dev.bat:16`
   dùng Python bất kỳ trên PATH; `build_production.ps1:170-175` chỉ kiểm interpreter có chạy.

Máy audit hiện đủ mới nên frontend/Rust build được. Finding này là lỗi tái lập trên máy khác và sự
không rõ ràng về ABI Python của artifact ship.

### §REL.08 — [VERIFIED] P1 / S — Release QA native thiếu đường dẫn DLL của Python base

- `scripts/run_release_qa.ps1:118-130` chỉ đặt `PYO3_PYTHON`, không đưa
  `sys.base_prefix` vào `PATH`.
- Chạy đúng lệnh của script làm binary test native thoát `0xc0000135 STATUS_DLL_NOT_FOUND`.
- Chỉ thêm thư mục chứa `python312.dll` lấy từ `sys.base_prefix` vào `PATH` thì cùng binary đạt
  38/38 test; `cargo check --release --locked` cũng đạt.

Phải set/restore PATH cục bộ quanh native gate; không hardcode đường Codex hoặc Python 3.12.

### §REL.09 — [VERIFIED] P1 / M — No-GS gate không có timeout từng thao tác và không hoàn tất

- Vòng chạy tại `scripts/gs_dependency_audit.py:409-423` gọi từng operation trực tiếp, không có
  timeout/cancel boundary.
- Lượt audit giới hạn 15 phút hoàn tất 7 file đầu: 112 `OK`, 0 `GS`, 0 `ERROR`. File thứ 8 hoàn tất
  thêm 10 `OK` và 1 `REFUSED`, rồi không trả về ở operation kế tiếp `pdfx:x1a` trước khi toàn
  command bị timeout.
- File thứ 8 chỉ khoảng 4,04 MB / 31 trang; không thể xem 15 phút không có terminal result là gate
  phát hành đáng tin.

Không có bằng chứng Ghostscript bị gọi trong phần đã hoàn tất, nhưng cũng **không có bằng chứng gate
18×16 đạt**. Cần timeout per-operation, kết quả terminal rõ, resume an toàn và artifact ghi cả lỗi
timeout trước khi nối lại vào release.

### §REL.10 — [VERIFIED] P1 / M — Pipeline có thể báo thành công/upload khi artifact chưa được nghiệm thu

- Không tìm thấy installer sau Tauri build chỉ in warning tại `build_production.ps1:928,989-991`,
  không `throw` hay `exit 1`.
- Manifest ban đầu ghi `EXE_SHA256 = NOT_VERIFIED_INSTALL_PAYLOAD`
  (`build_production.ps1:971`) rồi chỉ in lệnh hậu kiểm (`:981-983`).
- `release_update.ps1:180-200` upload installer/.sig/latest.json mà không bắt buộc chạy
  `verify_installed_artifact.ps1` trước.
- Verifier hiện cài silent, hash và kiểm payload no-GS (`verify_installed_artifact.ps1:92-169`),
  nhưng chưa launch app, chưa kiểm sidecar health/HMAC, PDFium, OCR hoặc model runtime.

Đây là khoảng trống giữa “Tauri build trả 0” và “bản khách cài dùng được”.

### §REL.11 — [VERIFIED] P2 / M — Packaging phụ thuộc mutable dev venv

- Build dùng thẳng `backend/venv` (`build_production.ps1:61,163-175`) và QA chỉ `pip check`
  (`run_release_qa.ps1:36`), không chứng minh toàn bộ phiên bản installed khớp requirements.
- Bước build tự uninstall CPU ONNX Runtime rồi cài DirectML vào venv dev (`build_production.ps1:441-449`).
- Venv hiện tại may mắn đúng: chỉ có `onnxruntime-directml 1.24.4`, provider là
  `DmlExecutionProvider, CPUExecutionProvider`.

Khuyến nghị dùng venv staging sạch từ requirements đã pin, kiểm Python ABI và assert DirectML
provider trước Nuitka. Import động của fontTools/pywin32 trong onefile vẫn là `[SUSPECTED]` cho tới
khi có packaged smoke thật.

### §REL.12 — [VERIFIED] P2 / M — Các ratchet chất lượng/golden còn đỏ hoặc bỏ sót coverage

- `npm run lint:budget`: rule `react-refresh/only-export-components` là 45, budget 32. CI có gọi
  gate này tại `.github/workflows/ci.yml:73-80`; không được nâng budget để hợp thức hoá.
- Full ESLint 1.452 error/106 warning là nợ baseline đã có báo cáo riêng; không phải 1.452 bug release
  mới, nhưng lint hiện không làm được cổng “không tăng nợ”.
- TAC fixture `17_tac_heavy_cmyk.pdf` bị skip khi không có Ghostscript tại
  `backend/tests/preflight_golden/test_preflight_golden.py:64-67`, trong khi sản phẩm no-GS đã dùng
  PPE. Chạy trực tiếp fixture bằng PPE vẫn phát hiện `TAC_EXCEEDED` 400%, nên skip là stale coverage.
- Lệch patch Cargo lock hiện chỉ là warning được chấp nhận: `serde 1.0.228/1.0.229` và
  `serde_json 1.0.150/1.0.151`; không có lệch minor/major.

## 5. Security / dependency / config readiness

| Nhóm | Trạng thái | Bằng chứng / giới hạn |
|---|---|---|
| Secret tracked hiện tại | PASS có proof gap | Không thấy `.env`, private key marker hoặc token thật bị tracked; `.env`, `backend/.env`, `scripts/set_release_env.ps1` đều ignored. Chưa quét toàn lịch sử bằng gitleaks. |
| Release prerequisites | WARN | File env riêng và updater key có tồn tại, nhưng biến không được nạp trong process audit; không đọc/in secret và không gọi production. |
| npm supply chain | PASS | `npm audit` runtime + dev: 0 vulnerability. |
| Python supply chain | PASS | `pip-audit` requirements chính + DirectML: không có advisory đã biết. DirectML cần `PYTHONUTF8=1` để auditor đọc file comment tiếng Việt trên Windows. |
| Rust supply chain | PASS có warning | Không có vulnerability chặn. Cảnh báo unmaintained; `event-listener`/`glib` unsound không nằm trong graph `x86_64-pc-windows-msvc`. |
| Lockfile | PASS có warning | npm + 4 Cargo.lock + Python requirements đều tracked; chỉ lệch patch Rust nêu ở §REL.12. |
| PowerShell parse | PASS | `build_production`, `run_release_qa`, `release_update`, `quanly_phathanh` parse được. |
| Bundle prerequisite tại máy | PASS tĩnh | PDFium, icon, NSIS hook, Tesseract `eng/vie`, native fixture, corpus và Node toolchain có mặt. |

Không phát hiện lỗ hổng bảo mật mới đủ confidence trong phạm vi static release review này. Điều đó
không thay thế runtime validation của artifact đã cài.

## 6. Chấm Production Readiness theo `audit-rules.md` §12

| Nhóm | Chấm | Lý do |
|---|---:|---|
| 12.1 Secrets & Config | WARN | Hygiene hiện tại đạt; secret/runtime production chưa được sử dụng hoặc xác minh. |
| 12.2 Dependencies & Supply Chain | PASS/WARN | Advisory scan sạch; còn unmaintained warnings và lock patch skew nhẹ. |
| 12.3 Build / Release / Anticrack | **FAIL** | Dirty tree, QA đỏ, no-GS timeout, native PATH lỗi, artifact verification không bắt buộc. |
| 12.4 Error Handling & Observability | **FAIL** | Thiếu installer vẫn có thể exit 0; no-GS operation không timeout/terminal result. |
| 12.5 Tests & CI | **FAIL** | Backend, Vitest và lint budget đều đỏ trên source hiện tại. |
| 12.6 Data Safety | WARN / proof gap | Không có thao tác phá dữ liệu trong audit; chưa nghiệm thu tất cả đường ghi/xoá trên artifact release. |

**Kết luận bắt buộc:** NO-GO.

## 7. Quick wins và thứ tự sửa đề xuất

### Chốt con người trước khi sửa

1. Xác nhận 83 file dirty hiện tại là thay đổi chủ đích nào cần giữ; tách/commit chúng thành các
   checkpoint có thể tái lập. Không để agent tự commit cả dirty tree.
2. Duyệt hướng ratchet `nup_engine.py`: khuyến nghị refactor thật, không reset trần.
3. Xác nhận nguồn workbook vẫn dùng `BF=0.3`; bằng chứng hiện tại nói rõ là có.

### Các lô dự kiến (mỗi lô tối đa 5 file)

1. **Lô A — correctness + frontend gate (≤5 file):** sửa `spine.ts`; review đúng hai snapshot
   store; làm hai test timeout deterministic. Verify target → typecheck → full Vitest.
2. **Lô B — homogeneous test seam (1 file):** sửa
   `backend/tests/test_sticker_homogeneous_integration.py`, giữ nguyên production optimizer. Verify
   toàn nhóm homogeneous/ratio-stack.
3. **Lô C — tách ratio preview khỏi route (≤5 file):** `imposition.py`, solver/helper liên quan và
   test parity; đưa route về dưới ceiling mà không nâng trần.
4. **Lô D — tách `nup_engine` (≤5 file):** rút một khối chức năng độc lập, cập nhật test ratchet và
   regression liên quan; không đổi placement/output semantics.
5. **Lô E — toolchain + Release QA (≤5 file):** khóa Node/Rust/Python contract, sửa PATH native,
   thêm preflight fail-fast tương ứng.
6. **Lô F — no-GS gate (≤4 file):** timeout/resume/terminal record cho từng operation, mở TAC PPE
   golden, thêm regression policy.
7. **Lô G — artifact fail-closed (≤5 file):** thiếu installer phải fail; installed verifier là gate
   trước upload; bổ sung smoke app/sidecar tối thiểu.
8. **Lô H — packaging smoke:** staging venv sạch, kiểm DirectML/fontTools/pywin32 trong sidecar
   Nuitka; sau đó mới chạy full `build_production.ps1 -Release`.

Mỗi lô phải có file log `docs/BUILD_RELEASE_FIXES_2026-08-03.md`, test hẹp và verify cuối theo
`prynx-testing`. Không cập nhật golden master hình học nếu không có thay đổi hình học chủ đích đã soi
diff.

## 8. Điều kiện chuyển sang GO

- Worktree phát hành sạch và HEAD chứa đủ thay đổi đã duyệt.
- Full backend: 0 fail; full frontend: 0 fail; `lint:budget`: pass.
- `run_release_qa.ps1` hoàn tất end-to-end, gồm no-GS 18×16 có terminal result.
- Cả bốn crate Rust pass bằng chính wrapper release, không cần sửa PATH thủ công.
- Nuitka, Vite, Tauri và NSIS tạo đúng installer version hiện tại.
- Installer được cài vào Temp, launch được; sidecar health/HMAC, PDFium, OCR và model smoke đạt.
- Manifest không còn `NOT_VERIFIED_INSTALL_PAYLOAD`, `GIT_DIRTY=no`, hash/signature/updater artifact
  đầy đủ; chỉ khi đó `release_update.ps1` mới được phép upload.

---

**Trạng thái workflow:** dừng tại chốt duyệt sau báo cáo. Chưa áp dụng fix.

## 9. Cập nhật sau duyệt — build nội bộ và proof gap còn lại

- Full Release QA trên chính native wheel staging đạt: backend **2.098 pass, 4 skip**; frontend
  staging sạch **173/173 suite, 1.770 pass, 2 skip**; typecheck/Vite/lint budget đạt; các gate Rust
  trong wrapper đạt.
- No-Ghostscript schema 3 chạy đủ **288/288** operation trên 18 tài liệu: **279 `OK`, 9 `REFUSED`,
  0 `GS`, 0 `ERROR`, 0 `TIMEOUT`**; provenance/fingerprint hậu kiểm hợp lệ.
- Nuitka tạo sidecar onefile 417.511.424 byte; Tauri/NSIS tạo installer 487.684.138 byte. Hai bản
  installer trong bundle và `Ban_Phat_Hanh` có cùng SHA-256
  `e3f8a2eb033d402b487e98566c5cf26edaa4d50da32c37932b1c68cf5b209408`.
- Manifest khớp installer/app/sidecar/frontend hash và cố ý ghi `GIT_DIRTY=YES`,
  `DIELINE_LOCKED=no`, `RUNTIME_VERIFIED=no`; do đó artifact nội bộ không thể bị uploader coi là
  bản phát hành hợp lệ.
- Script NSIS thực tế chỉ đưa `binaries\gs\NO_GHOSTSCRIPT.txt` vào installer. Cây
  `target\release\binaries\gs` còn residue từ beta cũ nhưng không có directive `File` tương ứng
  trong installer rc.1.
- Verifier đã xác minh version + hash installer rồi dừng trước bước cài vì profile có PrynX
  `1.0.0-beta.13`/metadata HKCU. Windows Sandbox không có trên máy. Chưa được phép gỡ/di chuyển
  bản cũ hoặc tạo user sạch, nên proof gap còn lại là installed runtime smoke: app/sidecar health,
  PDFium, OCR và frozen ONNX trên payload cài thật.

## 10. Cập nhật profile sạch, Python 3.11 và secret rotation

- Runtime smoke của installer rc.1 đã đạt trong local user tạm sạch: app ready, sidecar
  integrity/startup/health, PDFium, OCR `eng+vie`, no-Ghostscript, ONNX DirectML+CPU và inference đủ
  ISNet + hai Real-ESRGAN. Cleanup user/profile/process/port đạt; manifest ghi `RUNTIME_VERIFIED=yes`.
- Venv release đã chuyển sang Python 3.11.9 và full backend đạt **2.101 pass, 4 skip**; native wheel
  đúng ABI `cp311`. Venv 3.12.13 được giữ làm backup.
- Python 3.11.15 mới hơn chỉ có source release trên python.org; 3.11.9 là binary Windows cuối. Nếu yêu
  cầu CPython có toàn bộ security patch 3.11 mới nhất, cần thêm quy trình build interpreter từ source
  hoặc duyệt nâng ABI — chưa được chứng minh trong pipeline hiện tại.
- Khóa legacy `service_role` đã lộ không thể thu hồi độc lập mà không migrate diện rộng
  `printsolutions-main`: 7 Edge Function admin, edge-to-edge auth và nhiều public client còn dùng
  legacy anon/JWT. Local pipeline đã chuyển sang DPAPI + `sb_secret_`/header `apikey`, nhưng chưa tạo
  key thật và chưa thay đổi production.

**Trạng thái hiện tại:** installer nội bộ đã được nghiệm thu runtime nhưng vẫn không phải artifact
public (`GIT_DIRTY=YES`, `DIELINE_LOCKED=no`, build Python 3.12). Public release còn chờ key build mới,
worktree/commit sạch, build lại bằng Python 3.11 và quyết định migration/thu hồi legacy Supabase.
