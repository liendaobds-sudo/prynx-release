# BÁO CÁO AUDIT LẦN 3 — MỨC SẴN SÀNG LOẠI BỎ GHOSTSCRIPT

**Ngày audit:** 2026-07-27
**Phạm vi:** mã nguồn, đường gọi thật từ UI/API, PPE/OUT FONT, gate Release QA, script build và artifact `1.0.0-beta.14` hiện có.
**Baseline mã:** `HEAD 8a7a62e`, cộng các thay đổi chưa commit đang có trong worktree.
**Phương pháp:** đối chiếu entry point → consumer → sink; chạy test/golden trên đúng worktree; mô phỏng artifact no-GS bằng `PRYNX_NO_GS_BUILD=1`; tái hiện ca đối nghịch OUT FONT bằng PDF thật.

---

## 1. Kết luận điều hành

### Quyết định hiện tại: **NO-GO — chưa tháo GS khỏi quy trình phát hành PrynX**

| Câu hỏi | Kết luận |
|---|---|
| Có thể tạo một installer không chứa binary Ghostscript không? | **CÓ, đã chứng minh trên artifact cũ**: payload staging hiện chỉ có `NO_GHOSTSCRIPT.txt`; installer beta.14 cũ đã được kiểm tra không chứa `gswin*.exe`/`gsdll*.dll`. |
| PPE lõi có đủ khỏe để tiếp tục hướng no-GS không? | **CÓ**: 560 test Rust, golden 100/72 DPI và các suite release đều xanh. |
| Đường phát hành mặc định đã là no-GS chưa? | **CHƯA**: `build_production.ps1` vẫn mặc định `$BUNDLE_GS = $true`; các entry phát hành không truyền `-NoGhostscript`. |
| OUT FONT đã đủ an toàn để thay GS chưa? | **CHƯA**: bộ hậu kiểm bỏ lọt chữ nhỏ bị dịch chỗ; đã tái hiện `verify=True` với glyph bị dịch 30 pt. |
| Artifact hiện có đại diện cho bổ sung mới không? | **KHÔNG**: artifact mang commit `1839cd5`, trước bốn commit PPE mới và trước thay đổi OUT FONT chưa commit. |
| Có thể phát hành công khai no-GS ngay không? | **KHÔNG**: còn blocker kỹ thuật bên dưới, validator PDF/X độc lập chưa có, worktree/manifest chưa sạch và artifact chưa ký. |

Nói ngắn gọn: **“ống thở” GS đã có thể rút ở một artifact thử nghiệm có chủ đích, nhưng chưa được rút khỏi quy trình release và chưa đủ an toàn để tuyên bố đã tháo khỏi sản phẩm.**

---

## 2. Những phần đã đạt, có bằng chứng

1. **PPE lõi và mực pha/overprint đã tiến bộ rõ ràng.**
   - `print_engine`: **560/560 pass**.
   - Golden 100 DPI: **52 PASS, 0 FAIL, 1 khác GS có chủ ý** trên 53 PDF.
   - Golden 72 DPI: **52 PASS, 0 FAIL, 1 khác GS có chủ ý** trên 53 PDF.
   - Preflight golden: **17 PASS, 1 fixture JPEG stub hỏng được từ chối rõ**, 0 FAIL.
   - Ba fixture spot hợp lệ (`spot_solid`, `spot_half_tint`, `overprint_spot_on_yellow`) đều đổi spot→CMYK bằng engine nội bộ.

2. **Hành vi no-GS đã có nền tảng fail-loud.**
   - Marker no-GS chặn dò GS hệ thống tại `backend/app/core/gs_availability.py:58-72` và `backend/app/config.py:24-51`.
   - Bản no-GS mặc định tắt fallback tại `backend/app/config.py:54-63,93-96`.
   - Full backend hiện tại: **1427/1427 pass**.

3. **Release QA trên đúng worktree đã xanh.**
   - Preflight QA: 46 pass.
   - Free-token E2E: 1 pass.
   - Backend: 1427 pass.
   - Frontend cài sạch theo lockfile: 1126 pass, 2 skip.
   - Imposition: 36 pass + release compile pass.
   - Native: 13 pass + release compile pass.
   - Tauri: 40 pass + release compile pass.
   - TypeScript `tsc --noEmit`: pass.

4. **Payload staging hiện không còn executable GS.**
   - `desktop/src-tauri/binaries/gs/` chỉ có `NO_GHOSTSCRIPT.txt`.
   - Không tìm thấy `gswin*.exe` hoặc `gsdll*.dll` dưới `desktop/src-tauri/binaries`.
   - `THIRD_PARTY_NOTICES.md` hiện không nhắc Ghostscript/Artifex/AGPL.

Các kết quả này chứng minh hướng PPE/no-GS là khả thi. Chúng **không** đóng các blocker ở §3 vì gate hiện tại chưa kiểm đúng đường release và OUT FONT còn một false-negative an toàn in.

---

## 3. Phát hiện theo mức ưu tiên

### [P0][VERIFIED] 3.1. Entry phát hành vẫn bundle Ghostscript theo mặc định

**Bằng chứng mã:**

- `build_production.ps1:665-667` đặt `$BUNDLE_GS = $true`; chỉ tắt khi có `-NoGhostscript` hoặc `PRYNX_BUNDLE_GS=0`.
- `release_update.ps1:132-145` dựng `$buildArgs = @{ Release = $true }` nhưng không thêm `NoGhostscript`.
- `PHAT_HANH.bat:16-17` gọi `build_production.ps1 -Release` nhưng không truyền `-NoGhostscript`.
- `quanly_phathanh.ps1:152-159` gọi build nội bộ nhưng cũng không chọn no-GS.
- `scripts/set_release_env.ps1` không đặt `PRYNX_BUNDLE_GS=0`.

**Đường tác động thật:** người dùng bấm/phát hành → wrapper release → `build_production.ps1` → nhánh `$BUNDLE_GS = $true` → copy payload GS nếu máy build có cài GS (`build_production.ps1:699-712`).

**Tác động:** thao tác phát hành chuẩn vẫn có thể sinh installer chứa AGPL. Đây là blocker trực tiếp cho tuyên bố “đã loại bỏ GS”. Artifact no-GS cũ chỉ chứng minh cờ thủ công hoạt động, không chứng minh release mặc định an toàn.

**Điều kiện đóng:** no-GS phải là mặc định ở mọi entry phát hành; nhánh legacy có GS phải là opt-in có tên rõ, cảnh báo bản quyền và không thể bị bật do môi trường ngẫu nhiên.

---

### [P0][VERIFIED] 3.2. OUT FONT bỏ lọt chữ nhỏ bị đặt sai vị trí

**Bằng chứng mã:**

- Thay đổi chưa commit đặt `PRYNX_OUTLINE_TRUST_PPE` mặc định bật tại `backend/app/core/outline_text.py:678-689`.
- Khi cờ bật, path PPE được chấp nhận ngay tại `backend/app/core/outline_text.py:713-715`; kiểm vị trí bút ở `:716-723` không chạy.
- Hậu kiểm tile bỏ qua mọi tile có `max(n_old, n_new) < 64` tại `backend/app/core/outline_text.py:1007-1014`.
- Hai lưới toàn trang cho phép mean delta tới `5/255` và coverage delta tới `1.5 điểm %` tại `backend/app/core/outline_text.py:1042-1071`; nền trắng lớn pha loãng sai lệch của glyph nhỏ.
- Test hiện tại chỉ dịch cả chuỗi `PRYNX` 12 pt (`backend/tests/test_outline_text_native.py:254-279`), chưa có ca glyph nhỏ dưới ngưỡng 64 pixel mực.
- SSOT vẫn nói “mỗi path bị kiểm nằm đúng vị trí bút” tại `docs/PPE_CURRENT_STATE.md:56`, trái với hành vi mặc định hiện tại.

**Tái hiện độc lập bằng PDF thật:** trên trang 612×792 pt, render 150 DPI, dịch nội dung 30 pt:

| Glyph | Cỡ | Pixel mực trước | `_local_ink_mismatch` | `verify_outline` |
|---|---:|---:|---|---|
| `.` | 12 pt | 9 | `None` | `(True, '')` |
| `i` | 12 pt | 34 | `None` | `(True, '')` |
| `A` | 8 pt | 49 | `None` | `(True, '')` |
| `A` | 10 pt | 75 | phát hiện mất mực | `False` |

**Đường tác động thật:** UI “Khóa Font” → `/preflight/fix` → `ActionEngine._action_outline_fonts` → `outline_text.outline_fonts` → PPE path được tin mặc định → hậu kiểm trả nhầm `True` → output được giao cho người dùng.

**Tác động:** PDF vẫn mở, không còn text sống, nhưng chữ nhỏ có thể sai chỗ mà action báo thành công. Đây là lỗi an toàn in và là blocker bắt buộc trước khi dùng OUT FONT làm đường thay GS.

**Điều kiện đóng:** khôi phục một invariant bắt được lệch từng glyph hoặc thay hậu kiểm bằng phép so không bỏ qua vùng mực nhỏ; thêm adversarial test cho dấu chấm, chữ nhỏ và glyph đơn bị dịch/đổi chỉ số. Không chỉ nới/hạ ngưỡng theo một file corpus.

---

### [P0][VERIFIED] 3.3. Script xác minh artifact mới không thể hoàn tất và có false-negative NOTICE

**Bằng chứng mã/artifact:**

- `scripts/verify_installed_artifact.ps1:103-106` chỉ tìm `PrynX.exe`.
- Binary thực tế là `pdf-inspector.exe`: `desktop/src-tauri/Cargo.toml:2`; NSIS sinh `MAINBINARYNAME "pdf-inspector"` tại `desktop/src-tauri/target/release/nsis/x64/installer.nsi:42-43,618`.
- Vì vậy script sẽ cài xong rồi ném “Không thấy PrynX.exe”, không thể điền `EXE_SHA256` cho artifact mới.
- `scripts/verify_installed_artifact.ps1:117-118` dùng `-SimpleMatch` với pattern `Ghostscript|Artifex|AGPL`. Khi dùng `-SimpleMatch`, dấu `|` là ký tự thường; thử với ba dòng `Ghostscript`, `Artifex`, `AGPL-3.0` cho **0 match**, trong khi regex cho 3 match.

**Tác động:** gate hậu kiểm được thêm ở commit `6400903` chưa hoạt động trên sản phẩm thật; nó vừa fail sai ở tên exe, vừa có thể bỏ lọt NOTICE còn AGPL. Do đó chưa thể dùng script này làm bằng chứng release.

**Điều kiện đóng:** lấy tên main binary từ cấu hình/artifact thay vì hardcode; sửa NOTICE matcher; thêm test script trên cây cài mô phỏng chứa `pdf-inspector.exe`, marker no-GS, GS giả và NOTICE giả.

---

### [P1][VERIFIED] 3.4. Gate “Convert/Downscale/Embed non-GS = ĐẠT” đang bị tuyên bố quá mức

SSOT đánh dấu gate này **ĐẠT** tại `docs/PPE_CURRENT_STATE.md:46`, nhưng phép đo no-GS trên 18 fixture/16 thao tác cho kết quả:

| Thao tác | OK | REFUSED | Rơi đến nhánh GS |
|---|---:|---:|---:|
| `DOWNSCALE_IMAGES` | 15 | 0 | **3** |
| `EMBED_FONTS` | 17 | 0 | **1** |
| `OUTLINE_FONTS` | 11 | 1 | **6** |
| PDF/X-4 | 17 | 0 | **1** |
| PDF/X-1a | 12 | 5 | **1** |

Các trường hợp cần phân loại đúng:

1. **Downscale là khoảng trống thật.** Fixture ảnh 2400×2400 đặt ở 1 inch (2400 DPI) dùng filter chain `/ASCII85Decode,/FlateDecode`; native từ chối tại `backend/app/core/pdf_actions_native.py:320-324`, action rơi GS tại `backend/app/core/action_engine.py:981-1002`. Đây là filter chain phổ biến do ReportLab sinh và UI đang công khai action “Giảm DPI ảnh”.
2. **Embed font thiếu thật vẫn là chức năng GS.** `backend/app/core/action_engine.py:622-678` cố ý chỉ copy khi font đã đủ; có font thiếu thì dùng GS. UI vẫn đưa “Nhúng Font” như action khả dụng (`desktop/src/components/PreflightTab.tsx:34-40`, `desktop/src/components/preprocess-tools/PreflightTool.tsx:47-53`).
3. **PDF/X với font thiếu rơi GS.** `_export_x4_native` trả `False` khi font thiếu tại `backend/app/core/pdfx_export.py:501-510`; UI lại hứa tự nhúng font khi xuất tại `desktop/src/components/preprocess-tools/SavePdfxTool.tsx:39-43`.
4. **OUT FONT dừng an toàn trên file chưa hỗ trợ** là quyết định sản phẩm có thể chấp nhận, nhưng không được gọi là “không còn phụ thuộc” nếu UI vẫn giữ fallback GS và bộ đo phân loại là GS-required. Sau khi sửa §3.2 cần chốt lại contract: hỗ trợ hoặc từ chối rõ, không thử GS trên artifact no-GS.
5. **Ca spot→CMYK trong corpus là false-positive của fixture, không phải blocker.** `12_spot_color.pdf` chỉ khai một tint stream không hợp lệ/không vẽ nội dung; native báo `tint transform hoặc alternate không đọc được`. Ba fixture spot hợp lệ đều xử lý non-GS thành công.

**Tác động:** bỏ binary GS không làm app crash, nhưng một số nút đang công khai sẽ dừng trên PDF phổ biến. Có hai cách hợp lệ: bổ sung engine nội bộ, hoặc đổi contract/UI thành “không hỗ trợ và dừng an toàn”. Không hợp lệ: tiếp tục đánh dấu gate hoàn tất trong khi action vẫn dựa vào fallback GS.

---

### [P1][VERIFIED] 3.5. Không có artifact mới đại diện cho mã vừa bổ sung

**Bằng chứng:** `Ban_Phat_Hanh/release-manifest.txt:2-12` cho biết:

- `GIT_COMMIT = 1839cd5...`, trong khi HEAD audit là `8a7a62e`.
- `GIT_DIRTY = YES`.
- `CODE_SIGNED = no`.
- Artifact được build lúc 05:26 UTC, trước các commit PPE/no-GS lúc 17:47–17:50 giờ địa phương và trước thay đổi OUT FONT chưa commit.

Worktree audit hiện vẫn có nhiều file modified/untracked; riêng `backend/app/core/outline_text.py` và hai test OUT FONT chưa commit. Vì vậy installer beta.14 sạch GS hiện có **không chứa** các bổ sung đang được đánh giá.

**Tác động:** chưa có bằng chứng end-to-end “source mới → sidecar mới → installer mới → cài sạch → chạy UI thật”. Không được phát hành installer cũ dưới kết luận audit mới.

**Điều kiện đóng:** sau khi sửa blocker, gom/duyệt commit sạch; build no-GS mới; ký Authenticode/updater; chạy script verify đã sửa; smoke test trên máy sạch và lưu manifest/report cùng artifact.

---

### [P1][VERIFIED] 3.6. Bộ đo no-GS mới chưa phải release gate

**Bằng chứng:**

- `scripts/gs_dependency_audit.py` hiện **untracked**.
- Không có consumer nào gọi script này; `scripts/run_release_qa.ps1:30-116` không chạy nó.
- Script tự in “CÒN PHỤ THUỘC GHOSTSCRIPT” tại `scripts/gs_dependency_audit.py:422-431` nhưng luôn `return 0` tại `:446-448`.
- Release QA cũng không gọi trực tiếp 560 test của `print_engine` và không chạy `tsc --noEmit`; audit lần này phải chạy hai phần đó riêng.

**Tác động:** Release QA có thể xanh dù corpus còn thao tác rơi đến GS. Kết quả xanh hôm nay là có thật, nhưng gate tự động chưa bảo vệ kết luận no-GS cho các lần build sau.

**Điều kiện đóng:** commit bộ đo; tách chế độ “report” và “gate”; gate trả mã lỗi khi operation bắt buộc còn GS/ERROR; nối vào Release QA với corpus hợp lệ và policy rõ cho `REFUSED`; thêm `print_engine` test và typecheck vào gate chính.

---

### [P2][VERIFIED] 3.7. UI và tài liệu vẫn mô tả Ghostscript như hành vi sản phẩm hiện hành

**Bằng chứng:**

- `desktop/src/components/OutputPreviewTab.tsx:81-82,189-193,556-595` vẫn dùng state/query `useGhostscript`, tooltip “PPE trước, có thể chuyển sang Ghostscript”, và cảnh báo “PPE và Ghostscript đều không trả kết quả”.
- `backend/app/api/routes/preflight.py:898-910,918-938` vẫn mô tả mặc định là Ghostscript dù engine hiện thử PPE trước và artifact no-GS tắt fallback.
- `desktop/src/components/preprocess-tools/SavePdfxTool.tsx:35-36,72` nói Ghostscript tự xử lý PDF version; text này hardcode ngoài i18n.
- `desktop/src/components/workspace/SelectionLayersPanel.tsx:267-274` tiếp tục đưa sự có/không có GS vào lời xác nhận flatten.

**Tác động:** người dùng không thể hiểu PrynX đã dùng engine nào và ca nào chỉ là xấp xỉ/fail-closed. Đây không phải blocker binary, nhưng là blocker cho tuyên bố sản phẩm “đã bỏ GS” một cách trung thực.

---

### [P2][VERIFIED] 3.8. SSOT đã lệch trạng thái thực tế

- Backend hiện là **1427**, không phải 1422 (`docs/PPE_CURRENT_STATE.md:30`).
- Golden 72 DPI hiện là **52 PASS + 1 khác có chủ ý**, không phải số đo cũ ở `:32`.
- SSOT `:56` nói mỗi path OUT FONT kiểm vị trí bút, nhưng mặc định mã hiện tại bỏ qua chốt đó.
- SSOT `:47` còn dùng “22/33 file corpus” dù chính `:69` thừa nhận đó là số trước khi nối PPE và chưa đo lại.
- SSOT `:48` nói gate build/release QA đạt ở artifact, nhưng entry release vẫn mặc định bundle GS và verifier mới bị hỏng.

SSOT chỉ nên cập nhật sau khi các blocker được đóng và số đo được chạy lại từ commit sạch.

---

## 4. Các gate còn thiếu nhưng không phải phát hiện mới

1. **Validator PDF/X độc lập:** chưa có Acrobat Pro Preflight/veraPDF phù hợp hoặc validator thương mại lưu report cho output đại diện. Internal checker không thay thế được chứng nhận độc lập.
2. **UI trên máy sạch:** chưa chạy đầy đủ separations, soft-proof, TAC, overprint gồm spot, OUT FONT, flatten, PDF/X trên máy không có GS và không có môi trường dev.
3. **Artifact ký và tái lập:** manifest hiện `GIT_DIRTY=YES`, `CODE_SIGNED=no`.
4. **Corpus OUT FONT khách:** corpus 33 PDF không nằm trong repo; số 22/33 cũ không được dùng để kết luận sau thay đổi PPE mới.

Telemetry “95% job/30 ngày” **không được tính là blocker**, đúng quyết định sản phẩm đã ghi: thiết bị đo không có mẫu số đáng tin và gate đó đã bị loại bỏ.

---

## 5. Ghi chú về lần chạy test

- Một lượt targeted gồm 89 test ban đầu có 2 lỗi: PDF/X gặp `WinError 5` khi replace output và Hypothesis báo sinh dữ liệu chậm. Cả hai pass khi chạy cô lập; full backend sau đó pass 1427/1427 hai lần (một lần riêng, một lần trong Release QA). Đánh dấu **SUSPECTED flakiness**, chưa đủ bằng chứng là lỗi sản phẩm.
- Release QA lần đầu dừng ở `npm ci` vì sandbox chặn tải `ffmpeg-static` (`connect EACCES`). Chạy lại ngoài sandbox với quyền mạng thì toàn bộ gate pass. Đây là lỗi môi trường lần đầu, không phải lỗi repo.
- `git diff --check` không phát hiện whitespace error; chỉ có cảnh báo LF→CRLF ở các file người dùng đang sửa.

---

## 6. Thứ tự sửa đề nghị sau khi được duyệt

Mỗi lô tối đa 5 file, verify xong mới sang lô tiếp theo.

### Lô A — Chặn release có GS và sửa verifier

1. Đảo mặc định build sang no-GS; legacy GS thành opt-in.
2. Truyền policy thống nhất qua `release_update.ps1`, `PHAT_HANH.bat`, GUI release.
3. Sửa tên executable + NOTICE matcher trong verifier.
4. Thêm test cho script verifier và build policy.

### Lô B — Khóa an toàn OUT FONT

1. Thêm adversarial tests cho glyph đơn nhỏ/dấu chấm/lệch ordinal.
2. Sửa invariant vị trí hoặc bộ so kẽm để không bỏ qua vùng mực nhỏ.
3. Chạy lại toàn bộ OUT FONT, backend và corpus khách; chỉ giữ thay đổi nếu không tạo false-positive mới.

### Lô C — Chốt contract các action còn rơi GS

1. Hỗ trợ filter chain phổ biến cho downscale hoặc từ chối đúng trước khi thử GS.
2. Quyết định rõ Embed Fonts/PDF/X với font thiếu: engine nội bộ hay fail-loud; sửa UI theo quyết định.
3. Dọn tên/query/help Ghostscript khỏi UI no-GS; badge phải phản ánh PPE/xấp xỉ thật.

### Lô D — Biến bằng chứng thành gate

1. Commit và harden `gs_dependency_audit.py`.
2. Nối no-GS corpus, `print_engine` tests và typecheck vào Release QA.
3. Cập nhật SSOT bằng số đo mới, không giữ số 22/33 cũ.

### Chốt cuối — chỉ làm sau A→D xanh

1. Commit sạch.
2. Validator PDF/X độc lập.
3. Build production no-GS có ký.
4. Verify installed artifact + smoke UI trên máy sạch không GS.
5. Chỉ khi cả năm mục đạt mới đổi kết luận sang **GO — đã tháo GS khỏi PrynX**.

---

## 7. Kết luận cuối

PPE hiện đủ mạnh để tiếp tục và artifact no-GS là khả thi. Tuy nhiên, tại thời điểm audit:

- release mặc định vẫn có thể bundle GS;
- verifier artifact mới không chạy đúng;
- OUT FONT còn false-negative có thể giao chữ sai;
- một số action công khai còn rơi đến GS;
- chưa có artifact sạch/ký chứa chính các bổ sung mới.

Vì vậy câu trả lời chính xác là: **chưa thể tuyên bố đã tháo ống thở GS khỏi PrynX; hiện mới tháo được ở một artifact thử nghiệm cũ, chưa tháo được ở hệ thống phát hành và hợp đồng chức năng của bản mới.**
