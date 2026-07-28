# BÁO CÁO AUDIT LẦN 4 — MỨC SẴN SÀNG LOẠI BỎ GHOSTSCRIPT

**Ngày audit:** 2026-07-27
**Phạm vi:** các bổ sung sau audit lần 3; build/release no-GS; verifier artifact; OUT FONT; ma trận chức năng no-GS; UI/tài liệu; artifact phát hành hiện có.
**Baseline:** `HEAD 8a7a62e`, cộng toàn bộ thay đổi chưa commit trong worktree (168 mục modified/deleted/untracked tại thời điểm chốt).
**Quyết định sản phẩm giữ nguyên:** telemetry “95% job/30 ngày” không phải gate.

---

## 1. Kết luận điều hành

### Quyết định hiện tại: **NO-GO — chưa đủ điều kiện phát hành PrynX đã loại bỏ GS**

Các bổ sung mới **đã đóng đúng hai lỗi release quan trọng** và **đã sửa được một nửa lỗi OUT FONT**:

| Hạng mục | Kết luận lần 4 |
|---|---|
| Build release mặc định no-GS | **ĐẠT ở mức mã nguồn** — mặc định không bundle; `-Release` từ chối nhánh có GS. |
| Verifier tên exe + NOTICE | **ĐẠT ở mức mã nguồn/test** — tìm `pdf-inspector.exe` từ Cargo và NOTICE dùng regex. Chưa có artifact mới để chạy end-to-end. |
| OUT FONT bắt glyph nhỏ bị mất/dịch | **ĐẠT** — dấu chấm 12 pt, `i` 12 pt và `A` 8 pt dịch 30 pt đều bị chặn. |
| OUT FONT bắt glyph nhỏ bị **thêm** | **CHƯA ĐẠT** — thêm một dấu chấm 9 px vẫn được hậu kiểm cho qua. |
| Các action công khai hoạt động không GS | **CHƯA ĐẠT hoặc chưa chốt contract** — Downscale, Embed, OUT FONT và PDF/X font-missing vẫn đi tới nhánh GS. |
| Release gate tự động bảo vệ no-GS | **CHƯA** — bộ đo không nằm trong Release QA, luôn trả mã 0 khi còn GS và lỗi ngay trên console Windows CP1252. |
| Artifact mới, sạch, có ký, đã cài và verify | **CHƯA** — vẫn chỉ có beta.14 cũ, dirty, unsigned. |
| Validator PDF/X độc lập + smoke máy sạch | **CHƯA**. |

Nói ngắn gọn: **đã tháo GS khỏi mặc định của script đóng gói, nhưng chưa tháo xong khỏi hợp đồng chức năng và chưa có artifact phát hành chứng minh việc đó.**

---

## 2. Những phần bổ sung đã đạt

### 2.1. [VERIFIED] Release không còn vô tình bundle GS

- `build_production.ps1:679-680` khởi tạo `$BUNDLE_GS = $false`; chỉ bật qua `-WithGhostscript` hoặc `PRYNX_BUNDLE_GS=1`.
- `build_production.ps1:686-688` từ chối mọi `-Release` khi bundle GS đang bật.
- `build_production.ps1:698-722` xoá payload GS cũ và tạo `NO_GHOSTSCRIPT.txt` cho bản mặc định.
- Ba entry phát hành hiện không bật lại `-WithGhostscript`/`PRYNX_BUNDLE_GS=1`; test policy đã khóa điều này.

**Đánh giá:** blocker 3.1 của audit lần 3 đã đóng ở mức code. Chưa thể gọi là đóng ở mức artifact vì chưa build/cài bản mới từ chính worktree này.

### 2.2. [VERIFIED] Hai lỗi logic của verifier đã được sửa

- `scripts/verify_installed_artifact.ps1:103-127` đọc tên crate từ `desktop/src-tauri/Cargo.toml` và tìm `pdf-inspector.exe` thay vì chỉ hardcode `PrynX.exe`.
- `scripts/verify_installed_artifact.ps1:136-143` dùng regex `Ghostscript|Artifex|AGPL`, không còn `-SimpleMatch` sai ngữ nghĩa.
- `scripts/verify_installed_artifact.ps1:145-163` vẫn kiểm đủ binary GS, NOTICE và marker no-GS.
- Bộ test policy kiểm cả cú pháp PowerShell 5; targeted suite liên quan đạt **36/36**.

**Đánh giá:** blocker 3.3 đã đóng ở mức code/test. Trạng thái end-to-end còn mở vì installer mới chưa tồn tại.

### 2.3. [VERIFIED] OUT FONT đã bắt được mất/dịch glyph nhỏ

- `backend/app/core/outline_text.py:1064-1086` hạ ngưỡng chiều mất mực xuống 6 px và nở mực sau 1 px để hấp thụ sai số raster.
- `backend/app/core/outline_text.py:1126-1166` tách recall/precision theo hai chiều mất và thêm mực.
- `backend/tests/test_outline_verify_small_glyph.py:75-116` khóa các ca dấu chấm 12 pt, `i` 12 pt, `A` 8/10 pt dịch 30 pt và ca lệch raster 1 px hợp lệ.
- Hợp đồng đếm mã từng khối `BT…ET` đã được thêm ở Python/Rust; `print_engine/tests/text_outlines.rs:329-429` kiểm dấu cách, `Tr 3`, nhiều block và Form được gọi lặp.

Kết quả test:

- Targeted OUT FONT + release policy: **36 pass**.
- `print_engine`: **565/565 pass**.
- Corpus khách 33 PDF: **23 OK, 10 đi tới nhánh GS, 0 error**; 15.612 glyph dùng PPE, 0 glyph lùi fontTools (`tmp/gs_outline_lan4.json`).

Đây là cải thiện thật so với audit lần 3, nhưng chưa đủ đóng toàn bộ blocker OUT FONT vì phát hiện mới ở §3.1.

---

## 3. Phát hiện còn mở

### [P0][VERIFIED] 3.1. Hậu kiểm OUT FONT vẫn bỏ lọt mực nhỏ được thêm vào

**Bằng chứng mã:**

- Chiều mất mực xét từ 6 px tại `backend/app/core/outline_text.py:1156-1160`.
- Chiều thêm mực chỉ xét khi ô có ít nhất 64 px mực sau tại `backend/app/core/outline_text.py:1161-1165`, theo `_VERIFY_PRECISION_MIN_INK_PIXELS = 64` ở `:1083-1086`.
- `verify_outline()` là chốt cuối mà `_outline_document()` gọi trước khi trả kết quả tại `backend/app/core/outline_text.py:1503-1507`.

**Tái hiện đối nghịch trên PDF thật, trang 612×792 pt @150 DPI:**

| Bản trước | Bản sau | Mực Black | Kết quả |
|---|---|---:|---|
| Một dấu `.` 12 pt | Giữ dấu cũ và thêm một dấu `.` 12 pt | 9 px → 18 px | `verify_outline = (True, '')` |

Mực gốc không mất nên recall đạt; tổng mực sau dưới 64 px nên precision bị bỏ qua; mean/coverage toàn trang bị nền trắng pha loãng. Cổng đếm số mã `BT…ET` cũng không bảo vệ được trường hợp hình học một glyph có thêm contour/mực ngoài ý muốn.

**Tác động:** một dấu chấm, chấm trên chữ, chi tiết barcode nhỏ hoặc contour thừa có thể xuất hiện trong output mà action vẫn báo thành công. Đây vẫn là lỗi an toàn in, nên blocker OUT FONT chưa đóng hoàn toàn.

**Điều kiện đóng:** không chỉ hạ ngưỡng precision. Cần đo “cụm mực mới không được giải thích bởi vùng mực gốc đã nở 1 px” hoặc connected-component/distance tương đương, để:

1. dấu chấm mới tách khỏi mực gốc bị chặn;
2. vành raster dày thêm quanh chính glyph cũ vẫn được chấp nhận;
3. thêm adversarial test `.` → `..` và giữ các test 9 px → 25 px dày nét hợp lệ hiện có.

### [P1][VERIFIED] 3.2. Ma trận chức năng no-GS vẫn còn các đường rơi đến GS

Chạy lại 18 fixture × 16 thao tác với `GHOSTSCRIPT_PATH=''` và fallback bị chặn cho đúng kết quả trước đó (`tmp/gs_dependency_audit_lan4.json`):

| Thao tác | OK | REFUSED | GS | ERROR |
|---|---:|---:|---:|---:|
| Separations ink | 17 | 1 | 0 | 0 |
| Soft-proof | 18 | 0 | 0 | 0 |
| Overprint Preview | 17 | 1 | 0 | 0 |
| Convert CMYK | 18 | 0 | 0 | 0 |
| Downscale Images | 15 | 0 | **3** | 0 |
| Embed Fonts | 17 | 0 | **1** | 0 |
| Flatten Transparency | 18 | 0 | 0 | 0 |
| OUT FONT | 11 | 1 | **6** | 0 |
| PDF/X-4 | 17 | 0 | **1** | 0 |
| PDF/X-1a | 12 | 5 | **1** | 0 |
| Spot → CMYK | 17 | 0 | **1*** | 0 |

`*` Fixture spot duy nhất vẫn là fixture khai tint không hợp lệ đã được phân loại ở audit lần 3; ba fixture spot hợp lệ chạy nội bộ thành công.

Đường gọi thật vẫn tồn tại:

- Embed font thiếu chuyển GS tại `backend/app/core/action_engine.py:622-678`.
- OUT FONT không hỗ trợ chuyển GS tại `backend/app/core/action_engine.py:706-730`.
- Downscale không xử lý được ảnh chuyển GS tại `backend/app/core/action_engine.py:942-1002`.
- PDF/X có font thiếu trả `False` tại `backend/app/core/pdfx_export.py:501-510`, sau đó chuyển GS tại `:417-436`.

**Đánh giá sản phẩm:** có thể phát hành no-GS nếu các ca này được định nghĩa rõ là **không hỗ trợ và fail-closed**, nhưng UI/API phải nói đúng và gate phải phân loại chúng là `REFUSED`, không phải tiếp tục gọi nhánh GS rồi mới phát hiện không có binary. Nếu cam kết giữ nguyên các nút hiện hành, phải bổ sung engine nội bộ.

Riêng OUT FONT trên corpus khách đạt **23/33**, còn **10/33** đi tới nhánh GS. Vì vậy SSOT không được dùng số 22/33 cũ hoặc tuyên bố phần còn lại đều đã được chốt hợp đồng.

### [P1][VERIFIED] 3.3. Bộ đo no-GS chưa thể làm release gate

- `scripts/gs_dependency_audit.py` vẫn là file untracked và không được gọi trong `scripts/run_release_qa.ps1:30-116`.
- Khi còn thao tác `GS`, script chỉ in danh sách tại `scripts/gs_dependency_audit.py:422-433` rồi luôn `return 0` tại `:446-448`.
- Chạy trực tiếp trên PowerShell Windows hiện tại dừng ngay tại `scripts/gs_dependency_audit.py:372-373` với `UnicodeEncodeError` do stdout CP1252 không in được tiếng Việt. Lượt audit chỉ chạy được sau khi đặt `PYTHONIOENCODING=utf-8`.
- Release QA vẫn không chạy trực tiếp full `print_engine` hoặc `tsc --noEmit`.

**Tác động:** CI/release có thể xanh khi chức năng bắt buộc còn rơi GS; thậm chí nếu nối script nguyên trạng vào Windows gate thì gate sẽ lỗi vì encoding trước khi đo.

**Điều kiện đóng:** commit công cụ; tự cấu hình UTF-8/ASCII-safe; có chế độ `--gate-policy`; trả mã khác 0 khi còn `GS`/`ERROR` ngoài allowlist đã duyệt; nối corpus, `print_engine` và typecheck vào Release QA.

### [P0][VERIFIED] 3.4. Chưa có artifact mới đại diện cho mã vừa audit

`Ban_Phat_Hanh/release-manifest.txt` và installer mới nhất vẫn là beta.14 được tạo lúc 12:26–12:42 ngày 2026-07-27:

- `GIT_COMMIT = 1839cd5...`, khác HEAD `8a7a62e`.
- `GIT_DIRTY = YES`.
- `CODE_SIGNED = no`.
- Không chứa các thay đổi build/verifier/OUT FONT đang audit.

Worktree hiện có **168** mục thay đổi; các test then chốt `test_outline_verify_small_glyph.py`, `test_release_no_gs_policy.py` và `gs_dependency_audit.py` còn untracked. `build_production.ps1:929-934` cũng vẫn sinh manifest `EXE_SHA256 = NOT_VERIFIED_INSTALL_PAYLOAD` và `CODE_SIGNED = no` trước bước hậu kiểm.

**Tác động:** chưa có chuỗi bằng chứng `source đã duyệt → sidecar mới → installer mới → cài sạch → verify payload → smoke UI`. Verifier đã sửa chưa từng được chạy trên artifact mới thật.

### [P2][VERIFIED] 3.5. UI và SSOT tiếp tục nói GS là hành vi hiện hành hoặc tuyên bố gate quá mức

- `desktop/src/components/OutputPreviewTab.tsx:81-82,557-594` vẫn dùng `useGhostscript`, mô tả PPE fallback sang GS và cảnh báo “PPE và Ghostscript đều...” trên bản ship dự kiến không có GS.
- `desktop/src/components/preprocess-tools/SavePdfxTool.tsx:35,72,246` và `desktop/src/i18n/locales/vi.json:3943` vẫn hứa Ghostscript tự sửa PDF/X.
- `desktop/src/components/workspace/SelectionLayersPanel.tsx:271` vẫn mô tả nhánh dự phòng theo việc máy có GS.
- `backend/app/api/routes/preflight.py:900,922` vẫn mô tả mặc định GS dù luồng hiện tại là PPE-first/no-GS ở artifact.
- `docs/PPE_CURRENT_STATE.md:29-32` giữ số test cũ; `:46-48` đánh dấu Convert/Downscale/Embed và build gate đạt quá mức; `:56` nói mỗi path vẫn được kiểm vị trí bút dù mặc định đã chuyển sang tin PPE sau cổng đếm.

**Tác động:** người dùng và người phát hành không biết ca nào chạy PPE, ca nào xấp xỉ, ca nào bị từ chối; tài liệu có thể làm một artifact chưa đạt bị phát hành nhầm.

---

## 4. Kết quả kiểm thử trên worktree hiện tại

| Suite | Kết quả |
|---|---:|
| Targeted OUT FONT + release policy | **36 pass** |
| Rust `print_engine` | **565 pass** |
| Backend full | **1439 pass, 16 skip** |
| Frontend vitest | **1140 pass, 2 skip** |
| TypeScript | **pass** |
| Native | **13 pass** |
| Native release compile | **pass** |
| no-GS 18 × 16 | hoàn tất, 0 `ERROR`, còn các mục `GS` ở §3.2 |
| OUT FONT corpus khách 33 PDF | **23 OK, 10 GS, 0 ERROR** |

Các suite xanh chứng minh thay đổi mới ổn định ở mức mã. Chúng không thay thế artifact clean/signed, validator PDF/X độc lập hoặc smoke test máy sạch.

---

## 5. Trạng thái các blocker của audit lần 3

| Blocker lần 3 | Trạng thái lần 4 |
|---|---|
| 3.1 Release mặc định bundle GS | **ĐÓNG ở code; chờ artifact** |
| 3.2 OUT FONT bỏ lọt glyph nhỏ dịch chỗ | **ĐÓNG ca mất/dịch; vẫn MỞ ca thêm mực nhỏ** |
| 3.3 Verifier sai exe + NOTICE | **ĐÓNG ở code/test; chờ artifact end-to-end** |
| 3.4 Action non-GS bị tuyên bố quá mức | **MỞ, số đo không đổi** |
| 3.5 Không có artifact mới | **MỞ** |
| 3.6 Bộ đo no-GS chưa là gate | **MỞ; phát hiện thêm lỗi encoding Windows** |
| 3.7 UI còn mô tả GS hiện hành | **MỞ** |
| 3.8 SSOT lệch thực tế | **MỞ** |
| Validator PDF/X độc lập | **MỞ** |
| Smoke UI máy sạch | **MỞ** |

---

## 6. Thứ tự cần làm trước khi GO

Theo quy trình audit, mỗi lô không quá 5 file và verify xong mới sang lô tiếp theo.

### Lô A — đóng nốt an toàn OUT FONT

1. Thêm test bản gốc `.` → output `..` phải fail.
2. Phát hiện cụm mực mới nhỏ nằm ngoài vùng mực gốc đã nở, không chỉ dùng ngưỡng tổng pixel.
3. Giữ test outline dày thêm hợp lệ và toàn bộ targeted/full backend/print-engine xanh.
4. Chạy lại 33 PDF OUT FONT.

### Lô B — chốt hợp đồng các action không GS

1. Quyết định cho Downscale filter-chain lạ, Embed font thiếu, OUT FONT unsupported và PDF/X font-missing: hỗ trợ nội bộ hay từ chối rõ.
2. Trong artifact no-GS, không gọi nhánh GS rồi mới báo thiếu; chuyển thẳng sang `REFUSED` có lý do nếu đó là policy.
3. Sửa UI/help/API theo contract đã chọn.
4. Chạy lại ma trận 18 × 16; không còn `GS` ngoài allowlist được duyệt.

### Lô C — biến phép đo thành gate

1. Sửa encoding Windows và exit code của `gs_dependency_audit.py`.
2. Commit corpus policy/test liên quan.
3. Nối no-GS audit, full `print_engine` và typecheck vào Release QA.
4. Cập nhật SSOT bằng số đo lần 4.

### Chốt phát hành

1. Gom và review 168 thay đổi; commit sạch.
2. Chạy validator PDF/X độc lập và lưu report.
3. Build production no-GS mới; ký updater và Authenticode theo policy dự án.
4. Chạy `verify_installed_artifact.ps1 -ExpectNoGhostscript` trên installer mới; manifest phải `GIT_DIRTY=no`, có hash payload cài thật và trạng thái ký đúng.
5. Smoke UI trên máy sạch không có GS/dev environment.

---

## 7. Kết luận cuối

Đợt bổ sung này có giá trị và đã giải quyết đúng các lỗi lớn của build mặc định, verifier và chiều mất/dịch chữ nhỏ. Tuy nhiên:

- OUT FONT vẫn cho lọt một dấu nhỏ được thêm;
- 10/33 file khách của OUT FONT và một số action khác vẫn đi tới nhánh GS;
- bộ đo no-GS chưa phải gate và chưa chạy nguyên trạng trên console Windows;
- UI/tài liệu chưa phản ánh sản phẩm no-GS;
- chưa có artifact sạch, ký, cài và verify chứa chính mã mới;
- validator PDF/X độc lập và smoke máy sạch vẫn thiếu.

Vì vậy kết luận chính xác vẫn là: **chưa thể tuyên bố đã tháo hoàn toàn “ống thở” Ghostscript khỏi PrynX và chưa nên phát hành công khai bản no-GS ở trạng thái hiện tại.**
