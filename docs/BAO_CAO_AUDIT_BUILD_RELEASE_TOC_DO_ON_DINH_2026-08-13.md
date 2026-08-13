# BÁO CÁO AUDIT BUILD / RELEASE: TỐC ĐỘ, ĐỘ BỀN VÀ TRẢI NGHIỆM — 2026-08-13

> **Trạng thái:** Chốt 1 — khảo sát và phát hiện. Chưa sửa pipeline, chưa build/ký/upload,
> chưa thay đổi secret hoặc artifact. Chờ chủ dự án duyệt danh sách trước khi sửa theo lô.

## 1. Kết luận điều hành

Nhận xét “chạy chậm, dễ lỗi giữa chừng và bất tiện” là **có cơ sở**. Pipeline hiện tại đã có
nhiều chốt an toàn tốt và bộ test chuyên biệt đạt, nhưng cách điều phối vẫn là một chuỗi dài gần
như nguyên khối. Khi lỗi ở cuối, phần lớn công việc đã chạy không có checkpoint chính thức để tiếp
tục; UI chính chỉ mở một cửa sổ PowerShell rồi mất quyền quan sát tiến trình.

Kết luận hiện tại: **NO-GO cho việc coi nút PHÁT HÀNH là luồng “một bấm, tự phục hồi”**. Không có
bằng chứng artifact hiện hành bị sai; vấn đề là thời gian, khả năng chẩn đoán và phục hồi sau lỗi.

Các số đo quan trọng:

- Log build nội bộ có thật `tmp/internal-build-20260803-224813.*.log`: **71 phút 05 giây** từ lúc
  tạo log đến `BUILD COMPLETE`, trong khi hộp thoại UI hứa **10–20 phút**
  (`quanly_phathanh.ps1:199-201,220-222`).
- RC5: native được đóng dấu lúc `2026-08-11 23:39:16Z`; No-GS hoàn tất `00:07:17Z`; sidecar
  `00:34:24Z`; installer/chữ ký `00:45:04Z`; runtime verifier đóng manifest `01:25:44Z`.
  Tức khoảng **65 phút 48 giây tới installer** và **106 phút 28 giây tới nghiệm thu runtime**.
- No-GS 18×16 của RC5 ghi **941,1 giây thời gian thao tác** (~15 phút 41 giây). Các lượt hoàn tất
  khác trong repo dao động khoảng **866,8–1.508,1 giây** (~14,4–25,1 phút).
- Log Nuitka cũ cho thấy biên dịch **3.779 C file**, chỉ **2.240 cache hit / 1.539 miss**, rồi nén
  payload `967.933.833 → 412.664.464` byte. Đây là một ổ nóng thật, không chỉ do UI cảm giác chậm.

## 2. Phạm vi và mức bằng chứng

### Included

- Entry người dùng: `PRYNX.bat` → `quanly_phathanh.ps1`.
- Luồng nội bộ và public: `build_production.ps1`, `release_update.ps1`, `PHAT_HANH.bat`.
- QA và nghiệm thu: `scripts/run_release_qa.ps1`, `scripts/gs_dependency_audit.py`,
  `scripts/verify_installed_artifact.ps1`, `scripts/verify_artifact_clean_user.ps1`.
- Artifact/log/cached result có sẵn của RC1–RC5; lịch sử sửa release ngày 03–12/08.
- Hiệu năng, fail-fast, retry/resume, log/quan sát, cạnh tranh nhiều build, rác staging và UX.

### Excluded / proof gap

- Không chạy full build RC6: thao tác này tốn hơn một giờ, tạo/sửa artifact và cần secret/ký/UAC.
- Không upload hoặc gọi API production; không đọc giá trị secret.
- Không benchmark A/B số job Nuitka vì chưa sửa và chưa được duyệt.
- Không sửa các thay đổi bình trang/dò hình đang diễn ra ở worktree. Snapshot cuối khảo sát có 13
  file tracked bẩn thuộc phiên khác; không file nào là pipeline release.
- Có tiến trình dev/test khác đang hoạt động và một artifact No-GS dở 123/288 từ 11:05; audit không
  dừng hoặc can thiệp các tiến trình đó.

## 3. Bản đồ đường chạy hiện tại

```text
PRYNX.bat
  → quanly_phathanh.ps1 (WinForms)
      ├─ Build NỘI BỘ → Start-Process powershell → build_production.ps1 -Version ...
      └─ PHÁT HÀNH   → Start-Process powershell → release_update.ps1
            → kiểm version/worktree + gh auth
            → build_production.ps1 -Release
                → toolchain + key dieline
                → maturin/LTO + wheel staging
                → full backend + No-GS 18×16 + npm ci/typecheck/Vitest
                   + 4 nhóm Cargo test/check
                → Nuitka onefile
                → frontend production
                → Tauri/NSIS + updater signature + manifest
            → cài vào profile sạch + app/sidecar/PDFium/OCR/3 model AI smoke
            → lúc này mới kiểm commit GitHub/tag → upload
```

## 4. Phát hiện

Quy ước: P0 = hỏng/sai artifact; P1 = thường xuyên làm mất hơn một giờ hoặc chặn phát hành;
P2 = độ bền/UX/nợ kỹ thuật; P3 = đánh bóng. Effort S/M/L.

### §BR.01 — [VERIFIED] P1 / M — Không có checkpoint cấp pipeline; lỗi muộn buộc build lại

**Bằng chứng**

- `release_update.ps1:321-341` luôn gọi trọn `build_production.ps1 -Release`; không nhận run ID,
  checkpoint, `-Resume` hoặc đường vào “chỉ nghiệm thu/upload artifact đã khóa”.
- `release_update.ps1:394-446` chỉ bắt đầu installed smoke sau khi installer đã tạo.
- `release_update.ps1:474-511` chỉ bắt đầu kiểm remote commit/tag và upload sau installed smoke.
- Repo phải có cứu hộ ad-hoc `tmp/continue_rc5_release.ps1`, tự kiểm manifest/hash rồi tiếp tục
  runtime/upload “without rebuilding”. Sự tồn tại của script một lần này chứng minh nhu cầu resume
  là thật nhưng chưa thành tính năng được test/hỗ trợ.

**Tác động:** lỗi UAC, mạng GitHub, tag, clean-user hoặc upload ở phút 70–100 làm người dùng quay về
điểm đầu. Đây là nguồn bất tiện lớn nhất.

**Hướng sửa:** phát hành theo run manifest bất biến và state machine (`preflight → qa → package →
verify → publish`); cho phép tiếp tục từ artifact đã ký nếu commit/version/hash/provenance vẫn khớp.
Không cho skip chốt; chỉ tái dùng kết quả đã được attestation.

### §BR.02 — [VERIFIED] P1 / S — Các lỗi GitHub biết sớm lại được kiểm sau hơn một giờ

**Bằng chứng**

- `release_update.ps1:302-308` đầu luồng chỉ kiểm file khóa, có `gh` và đã đăng nhập.
- `Assert-GitHubCommitAvailable`/tag target đã tồn tại tại `:152-232` nhưng chỉ được gọi ở
  `:480-509`, sau build + cài + runtime smoke.
- `publisher.config.json` đã chứa `SourceRepo` và `ReleaseTargetCommit`, đủ để preflight remote
  trước khi biên dịch.

**Tác động:** source commit chưa push, commit neo release bị sai/mất hoặc tag xung đột chỉ lộ sau
khi đã trả chi phí build và nghiệm thu.

**Hướng sửa:** chạy preflight read-only GitHub ở đầu; kiểm source HEAD tồn tại trên SourceRepo,
release-target commit tồn tại và trạng thái tag/version không mơ hồ. Vẫn kiểm lại ngay trước upload
để chống TOCTOU.

### §BR.03 — [VERIFIED] P1 / M — UI không điều phối hay quan sát build; chỉ “bắn và quên”

**Bằng chứng**

- `quanly_phathanh.ps1:212-214,232-238` dùng `Start-Process powershell`; không `-PassThru`, không
  giữ PID, exit code, stdout/stderr hay callback hoàn tất.
- Log trong cửa sổ chính vì thế chỉ ghi “đã khởi chạy”; progress thực nằm ở console khác.
- Hai nút không bị khóa khi job chạy; không có mutex/single-instance trong bốn script điều phối
  (grep không thấy mutex/lockfile/semaphore). Người dùng có thể bấm nhiều lần và các lượt cùng ghi
  `binaries/`, `target/release`, `Ban_Phat_Hanh/release-manifest.txt`.
- Lịch sử đã ghi một build foreground bị terminal giám sát cắt ở 60 phút và Nuitka gặp
  `OSError [Errno 22]` khi console đóng (`docs/BUILD_RELEASE_FIXES_2026-08-03.md:215-218`).

**Tác động:** khó biết đang ở đâu, lỗi thật nằm ở cửa sổ khác, đóng console làm hỏng build, dễ chạy
trùng và tranh chấp artifact.

**Hướng sửa:** một release controller chạy process nền có log file bền, PID/run ID, trạng thái
terminal, progress theo stage, nút Mở log/Hủy/Tiếp tục; mutex toàn repo và nút UI khóa trong lúc job.

### §BR.04 — [VERIFIED] P1 / S — Nuitka bị hard-cap 4 job trên máy mạnh

**Bằng chứng**

- `build_production.ps1:30-31`: `[ValidateRange(1, 8)] [int]$NuitkaJobs = 4`.
- `:391-392,1010-1013`: giá trị này đi thẳng vào `--jobs`.
- Máy audit là **32 GB / 16 logical CPU** theo số đo runtime đã ghi tại
  `docs/PRYNX_RENDER_ENGINE_FIXES_2026-08-08.md:711`; log build cũng xác nhận `--jobs=4`.
- Log RC1: 3.779 C file với 1.539 cache miss. Cap 4 làm bỏ phí CPU trên đúng máy ≥16 GB.

**Tác động:** phần C compile lớn bị chậm có chủ đích, trái bất biến “máy mạnh chạy hết công suất”.

**Hướng sửa:** auto policy theo RAM: `<8 GB` giảm mạnh, `8–<16 GB` giảm nhẹ, `≥16 GB` dùng CPU-1
hoặc giá trị Nuitka auto; env/CLI override thắng. Không tăng mù: theo dõi lỗi heap C1002 và retry
với pool giảm nếu thật sự gặp áp lực bộ nhớ.

### §BR.05 — [VERIFIED] P1 / M — QA nguyên khối lặp nhiều việc và không tái dùng theo phạm vi

**Bằng chứng**

- `scripts/run_release_qa.ps1:361-534` luôn chạy full backend, No-GS, npm staging + typecheck +
  full Vitest, rồi `cargo test` + `cargo check --release` cho imposition_core, print_engine, native,
  Tauri.
- Sau đó `build_production.ps1:1010-1086` mới chạy Nuitka; `:1226-1238` chạy lại production
  typecheck/Vite; `:1312` chạy Tauri release với LTO. Cargo/Vite vì vậy có compile/build trùng
  mục đích dù cache giúp một phần.
- Frontend QA tạo thư mục mới và `npm ci` mỗi lượt (`run_release_qa.ps1:420-469`); log RC1 cho thấy
  riêng cài 479 package mất 19 giây, rồi typecheck và Vitest; production build sau đó typecheck lại.
- `-ReusePassedNoGs` chỉ được cho public release (`build_production.ps1:110-111`), checkbox UI mặc
  định tắt (`quanly_phathanh.ps1:127-133`). Các gate còn lại chưa có cache nội dung/attestation.

**Tác động:** một thay đổi nhỏ ở UI vẫn trả toàn bộ chi phí backend/Rust/No-GS; lỗi sau QA buộc chạy
lại QA dù source/toolchain không đổi.

**Hướng sửa:** cache gate theo fingerprint phạm vi và lưu attestation; full clean QA vẫn bắt buộc
trước public release, nhưng retry cùng commit/toolchain có thể tái dùng gate đã pass. Tách “verify
source” khỏi “package artifact”; không bỏ coverage.

### §BR.06 — [VERIFIED] P1 / S — Retry No-GS hiện không retry kết quả ERROR/TIMEOUT

**Bằng chứng**

- `scripts/run_release_qa.ps1:392-407` hứa thử tối đa hai lần với `--resume` khi exit 1.
- `scripts/gs_dependency_audit.py:75` xem `ERROR` và `TIMEOUT` là trạng thái terminal.
- `_is_terminal_result()` tại `:1076-1077`, rồi `:1109-1110`, bỏ qua mọi record terminal khi
  resume. Probe trực tiếp trả `True` cho cả `OK`, `REFUSED`, `GS`, `ERROR`, `TIMEOUT`.

**Tác động:** lượt thứ hai chỉ đọc lại lỗi thoáng qua rồi thất bại lại; thông báo “thử lại một lần”
gây kỳ vọng sai. Checkpoint vẫn hữu ích sau crash giữa chừng, nhưng retry tự động hiện không chữa
được operation lỗi.

**Hướng sửa:** phân biệt `reusable terminal` (`OK/REFUSED`, và `GS` nếu muốn fail ổn định) với
`retryable` (`ERROR/TIMEOUT`); lượt retry xóa/chạy lại đúng record lỗi, vẫn giữ fingerprint và giới
hạn số lần.

### §BR.07 — [VERIFIED] P2 / M — Build dùng và thay đổi trực tiếp dev venv

**Bằng chứng**

- `build_production.ps1:126` dùng cố định `backend/venv`.
- `:792-805` có thể uninstall `onnxruntime` CPU và pip install DirectML ngay trong venv đó.
- Full QA và Nuitka cùng đọc venv mutable; `pip check` chỉ chứng minh dependency không vỡ, không
  chứng minh toàn bộ version cài đặt khớp lock/requirements.
- Finding này đã có từ audit 03/08 (§REL.11) nhưng hướng staging venv sạch chưa được triển khai;
  runtime artifact đã được smoke nên rủi ro “sót import” cũ đã giảm, còn rủi ro tái lập vẫn mở.

**Tác động:** trạng thái dev trước đó ảnh hưởng release; build có thể đổi môi trường đang dùng và
phát sinh lỗi khác nhau giữa máy/lượt.

**Hướng sửa:** venv release riêng theo Python ABI + requirements fingerprint; tạo/refresh có kiểm
soát, không mutate dev venv. Có thể cache venv release, không cần `pip install` sạch mỗi lượt.

### §BR.08 — [VERIFIED] P2 / S — Không preflight dung lượng dù artifact và staging rất lớn

**Bằng chứng**

- Grep năm script pipeline không thấy `DriveInfo`, free-space/reserve hay disk preflight.
- Sidecar RC5 ~414 MB; installer ~486 MB; Nuitka log nén payload nguồn ~968 MB; build còn đồng thời
  giữ target Cargo, onefile staging, frontend QA và clean-user install.
- Tại lúc audit ổ C còn ~54,8 GB, D còn ~79,7 GB nên máy hiện tại chưa thiếu; đây là khoảng trống
  phòng ngừa, không phải lỗi đang xảy ra.

**Tác động:** ổ gần đầy có thể làm lỗi rất muộn ở onefile/NSIS/copy/install và để lại output dở.

**Hướng sửa:** preflight theo peak ước lượng cho cả volume repo và `%TEMP%`, có reserve; fail sớm
bằng thông báo tiếng Việt. Không tự xóa dữ liệu người dùng.

### §BR.09 — [VERIFIED] P2 / S — Staging lỗi bị bỏ lại, không có janitor an toàn

**Bằng chứng**

- Hai thư mục `%TEMP%/prynx-native-stage-*` ngày 13/08 còn lại, mỗi thư mục **258,3 MB**; thêm hai
  thư mục rỗng cũ. Đây là hơn **516 MB** rác có thể tái diễn sau abort.
- Cleanup staging native chỉ nằm ở các nhánh cụ thể (`build_production.ps1:778-784,993-999,
  1091-1095`), không có một `finally` sở hữu toàn vòng đời native stage.

**Tác động:** nhiều lần lỗi làm đầy ổ C và làm tăng xác suất lỗi tiếp theo.

**Hướng sửa:** scope staging bằng `try/finally`; startup janitor chỉ xóa thư mục đúng prefix, quá
tuổi, không có owner PID/lock sống và canonicalized dưới Temp. Không xóa hai thư mục hiện tại trong
giai đoạn audit vì có phiên khác đang hoạt động.

### §BR.10 — [VERIFIED] P2 / M — `exit` trong script thư viện làm wrapper mất quyền xử lý lỗi

**Bằng chứng**

- `build_production.ps1` có **30** lệnh `exit` (ví dụ `:262,331,399,784,1109,1231,1328`).
- `release_update.ps1:333` gọi script bằng call operator trong **cùng PowerShell process**.
- Probe PowerShell: `exit 7` trong script con chạy các `finally` nhưng kết thúc luôn host; câu lệnh
  sau call operator không chạy. Vì vậy `$buildExit = $LASTEXITCODE`/`if ($buildExit...)` tại
  `release_update.ps1:334-341` không đáng tin cho các nhánh `exit`.

**Tác động:** wrapper không thể thống nhất ghi trạng thái thất bại, phân loại stage hay đề xuất
resume; console chỉ còn lỗi thô. Cleanup `finally` vẫn chạy nên đây không phải mất secret.

**Hướng sửa:** phần lõi dùng `throw`/return result; chỉ entry CLI ngoài cùng quyết định exit code,
hoặc gọi build như process con và thu exit/status/log rõ ràng.

### §BR.11 — [VERIFIED] P2 / S — UI/version contract gây thất bại ngay khi bấm Phát hành

**Bằng chứng**

- UI ghi “Phiên bản mới”, cho phép sửa và `Save-Config` trước khi launch
  (`quanly_phathanh.ps1:77-78,217-232`).
- Public publisher lại yêu cầu version đã đồng bộ trong Tauri/npm/Cargo/lock/publisher **và
  worktree sạch** (`release_update.ps1:56-98`). GUI chỉ đổi `publisher.config.json`, nên nếu người
  dùng thực sự nhập version mới tại đây thì chính thao tác đó làm worktree bẩn và các file version
  khác chưa đồng bộ.
- Ảnh người dùng cho thấy ô version đang được dùng như dữ liệu nhập chính.

**Tác động:** nút PHÁT HÀNH trông như nơi đặt version, nhưng quy tắc đúng lại là “version đã chuẩn
bị và commit trước”; lỗi UX lặp lại ở đầu mỗi release.

**Hướng sửa:** public mode hiển thị version committed read-only và checklist đồng bộ; quy trình
“Chuẩn bị phiên bản” là action riêng tạo diff rồi yêu cầu review/commit. Build nội bộ có thể giữ
version tạm nhưng phải rollback file version sau build hoặc dùng config overlay để không làm bẩn
source.

### §BR.12 — [VERIFIED] P2 / S — Không có telemetry stage nên không biết tối ưu có hiệu quả

**Bằng chứng**

- Không có `Stopwatch`, stage duration, run summary hoặc status JSON trong controller/build/QA.
- Log nền tốt duy nhất là file ad-hoc ngày 03/08; launcher hiện không tự ghi transcript bền.
- UI ước lượng 10–20 phút nhưng bằng chứng thật là 65–106 phút.

**Tác động:** không xác định được build sau sửa nhanh bao nhiêu, cache hit/miss ra sao, hoặc lỗi hay
tập trung ở stage nào.

**Hướng sửa:** log JSON + text theo run ID: start/end/duration/exit/fingerprint/cache-hit cho từng
stage; không ghi secret/path corpus nhạy cảm. UI đọc status này để hiển thị progress và ETA dựa trên
lịch sử thật.

## 5. Những điểm đang tốt — không được làm yếu đi

- Release yêu cầu clean committed worktree, version đồng bộ, Python 3.11, fresh sidecar và
  installer mới; manifest khóa hash/provenance.
- Updater key và Supabase key có scope/cleanup; installed smoke kiểm app, sidecar, PDFium, OCR,
  DirectML/CPU và ba model.
- No-GS có per-operation timeout, sandbox, checkpoint atomic và fingerprint đầu/cuối.
- LTO/CGU/strip chỉ bật bằng env lúc đóng gói, không nằm trong Cargo.toml — giữ nguyên.
- `-ReusePassedNoGs` kiểm fingerprint rất rộng và fail-closed; không thay bằng cache “tin tên file”.
- Bộ test release chuyên biệt hiện đạt **71/71**; PowerShell parse **7/7** file đạt.

Mục tiêu sửa là **giữ nguyên hoặc tăng độ tin cậy**, đồng thời bỏ chạy lại vô ích và đưa lỗi biết
sớm lên đầu.

## 6. Quick wins và lộ trình sửa đề xuất

### Lô A — Fail-fast + contract UI (≤5 file, ưu tiên cao nhất)

- Chuyển remote GitHub/source/tag preflight lên trước build, vẫn recheck trước upload (§BR.02).
- Public UI đọc version committed, giải thích rõ “đã chuẩn bị + commit”; không ghi version mâu thuẫn
  khi bấm PHÁT HÀNH (§BR.11).
- Thêm test thứ tự preflight và UI contract.

**Kỳ vọng:** loại các lần mất hơn một giờ vì lỗi remote/version vốn biết trong vài giây.

### Lô B — Controller bền + mutex + log (≤5 file)

- Controller process riêng có run ID, mutex, log/status bền và exit code.
- UI giữ PID, khóa nút, hiển thị stage/progress/terminal result; console đóng không giết job.
- Chuẩn hóa `exit`/`throw` ở biên controller (§BR.03, §BR.10, §BR.12).

### Lô C — Resume có attestation (≤5 file)

- Run manifest/state machine; resume từ package/verify/publish nếu version, commit, source-clean,
  installer/signature/hash/provenance còn khớp (§BR.01).
- Hợp nhất và test hóa logic cứu hộ RC5; không dùng script ad-hoc trong `tmp`.

### Lô D — Hiệu năng máy mạnh + retry No-GS (≤5 file)

- Auto `NuitkaJobs` theo RAM/CPU, override rõ; retry giảm pool khi C1002 (§BR.04).
- Retry đúng ERROR/TIMEOUT trong No-GS (§BR.06).
- Thêm stage timing để benchmark trước/sau; test tier `<8`, `8–<16`, `≥16 GB`.

### Lô E — Cache QA theo fingerprint (≤5 file mỗi sub-lô)

- Attestation riêng backend/frontend/Rust/No-GS; retry cùng commit/toolchain tái dùng pass.
- Loại typecheck/build trùng nơi có thể mà không giảm gate public (§BR.05).
- Đo cold/warm trên chính máy 32 GB/16 luồng trước khi mở mặc định.

### Lô F — Môi trường và dung lượng (≤5 file)

- Venv release cached riêng, không mutate dev venv (§BR.07).
- Disk preflight repo + Temp; cleanup staging sở hữu bằng finally và janitor an toàn (§BR.08–09).

## 7. Điều kiện nghiệm thu sau sửa

1. Lỗi version/GitHub/tag/khóa/dung lượng được báo trước mọi compile nặng.
2. Bấm hai lần không tạo hai build; đóng UI/console không giết job; mở lại UI xem đúng run đang chạy.
3. Mọi stage có duration, exit và đường “Tiếp tục” chỉ bật khi attestation còn hợp lệ.
4. Ép lỗi lần lượt sau QA, Nuitka, NSIS, runtime smoke và upload: rerun không lặp stage đã pass nếu
   input không đổi; input đổi thì cache/resume bị từ chối.
5. No-GS ERROR/TIMEOUT được retry đúng record; GS/OK/REFUSED không bị chạy lại ngoài policy.
6. Máy 32 GB/16 CPU không bị cap 4; máy 8–15 GB và <8 GB giảm pool theo policy; không xuất hiện
   C1002/OOM hoặc artifact khác hash ngoài nguyên nhân hợp lệ.
7. Full gate release, 71 test chuyên biệt, PowerShell parse, full backend/frontend/Rust và installed
   clean-user smoke đều xanh; không bỏ/chuyển lỏng bất kỳ chốt bảo mật nào.
8. Benchmark công bố rõ cold/warm. Mục tiêu đầu tiên thực tế: retry lỗi muộn đi từ ~70–100 phút về
   vài phút; full cold build giảm đáng kể so với baseline 71 phút nhưng không đặt con số giả trước
   khi có stage telemetry.

## 8. Bằng chứng xác minh đã chạy trong audit

- PowerShell parse: `build_production`, `release_update`, GUI, QA, hai verifier và secret store:
  **7 file đạt, 0 lỗi parse**.
- Pytest release chuyên biệt: **71 passed, 1 warning** trong 5,97 giây.
- Đọc artifact No-GS RC5: **288 record; 279 OK, 9 REFUSED; 941,1 giây thao tác**.
- Đọc log build RC1: **71:05 wall time**, backend **2.105 pass/4 skip**, frontend
  **1.770 pass/2 skip**, Tauri/Rust đạt và Nuitka 3.779 C file.
- Probe semantics PowerShell: `exit 7` trong script con kết thúc host với code 7; `finally` chạy,
  câu lệnh wrapper sau call operator không chạy.
- Không chạy full build, không gọi Supabase/GitHub production, không ký/upload, không xóa staging.

---

**Chốt duyệt đề nghị:** duyệt Lô A → B → C trước. Ba lô này đem lại lợi ích lớn nhất cho “lỗi giữa
chừng/bất tiện” mà chưa đụng tới tối ưu compiler rủi ro cao. Sau khi có telemetry và resume bền mới
triển khai Lô D/E để giảm full build dựa trên số đo.
