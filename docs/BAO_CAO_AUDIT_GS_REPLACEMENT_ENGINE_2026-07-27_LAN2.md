# BÁO CÁO AUDIT LẦN 2 — PPE / SUNSET GHOSTSCRIPT SAU BẢN SỬA v5.0

**Ngày audit:** 2026-07-27 (chiều)
**Cây làm việc:** `HEAD = 1839cd5` + **23 file sửa chưa commit** + file mới chưa track
**Tài liệu đối chiếu:** `docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md` (v5.0), `docs/GS_SUNSET_FIXES_2026-07-27.md`, `docs/BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27.md` (lần 1, sáng cùng ngày)
**Phạm vi:** kiểm chứng lại từng tuyên bố của v5.0 trên code thật, cộng đo lại đường Overprint Preview mới, memory budget, CI/test gate, pipeline đóng gói.
**Không thuộc phạm vi sửa:** báo cáo này chỉ khảo sát và đo; chưa thay đổi engine hay hành vi sản phẩm.

---

## 1. Kết luận điều hành

Bốn blocker của audit lần 1 **đã được đóng thật**, không phải đóng trên giấy. Số lõi tái hiện đúng trên máy này:

- Rust `print_engine`: **546 pass, 0 fail** (tăng 1 test so với lần 1 — chính là test toggle overprint).
- Backend `pytest -q` từ `backend/`: **1399 pass, 0 fail** — khớp con số §20.2 tuyên bố.
- Golden một-biến 100 DPI, color-managed: **51 file → 50 PASS, 0 FAIL, 1 khác GS có chủ ý**. Thay đổi overprint **không** gây hồi quy golden.
- Overprint Preview: route live không còn một lệnh Ghostscript nào; fail-loud khi PPE không đủ tin.
- Memory budget: đã gate theo tier RAM, `>=16 GB` không còn trần 512 MiB — đúng bất biến phần cứng của dự án, có test ba tier.
- CI Windows: cài wheel native vừa build rồi chạy survival/routing/action/PDF-X/outline.

Nhưng bản sửa Overprint Preview **sinh ra một false-negative mới, đo được**, ở đúng lớp lỗi mà nó được tạo ra để đóng — chỉ đổi từ mực process sang **mực pha**. Vì vậy:

> **NO-GO cho việc coi Overprint Preview là đã đóng.** Với file overprint trên Pantone, nút này trả “không có vùng thay đổi”, trong khi Ghostscript trả 43.681 pixel khác nhau trên cùng file.
>
> **GO giữ nguyên phần còn lại** của bản sửa v5.0: memory budget, survival/CI, OUT FONT fail-closed, pipeline build.

Ngoài ra, gate release của cây hiện tại **đang đỏ trở lại** do việc dieline đang làm dở (`HangingWindowBox.ts` chưa hoàn thiện), không liên quan PPE nhưng chặn `run_release_qa`.

---

## 2. Phát hiện

### §A.1 — [ĐÃ ĐO] P1 (P0 với xưởng dùng Pantone): Overprint Preview không thấy overprint trên mực pha — effort M

> **ĐÃ ĐÓNG 2026-07-27 theo hướng (a)** — mực pha giữ kênh riêng khi trộn, gộp về CMYK ở bước xuất ảnh. Đo lại: 0 → 43.678 pixel khác biệt (GS 43.681). Rust 548, backend 1400, golden 72/100 DPI không đổi. Nhật ký: `GS_SUNSET_FIXES_2026-07-27.md` §9. Còn lại: fixture spot-overprint cho bộ golden.

**Đường chạy:** `OutputPreviewTab` → `POST /api/preflight/overprint-preview` → `_render_ppe_overprint_pair()` → `facade.softproof(simulate_overprint=False|True)` → `ppe_softproof` → `render_page_managed` với `RenderOptions::softproof()`.

**Cơ chế:**

1. `RenderOptions::softproof()` đặt `flatten_spots: true` — `print_engine/src/content/interp.rs:126-132`.
2. `flatten_spots` → `InkSpace::process_only()` — `print_engine/src/page.rs:108-110`.
3. Trong `process_only`, colorant `Separation`/`DeviceN` được quy qua alternate space rồi trả về **`ChannelMask::PROCESS`** (cả bốn kênh) — `print_engine/src/color/space.rs:296-320`.
4. Mực pha vì thế mất danh tính kênh riêng. Participation set bằng cả bốn kênh process ⇒ **overprint và knockout cho kết quả giống nhau từng pixel**, nên `diff_pixel_count = 0` và `has_differences = false`.

**Số đo** (150 DPI, GS 10.04.0 tham chiếu với API mới `-sOverprint=disable|simulate`; script: `tmp/audit_op_probe2.py`, fixture sinh ra tại `tmp/op_*.pdf`):

| ca đo | PPE diff_px | PPE max Δ | GS diff_px | GS max Δ |
|---|---|---|---|---|
| process M+Y, `OPM=0` | 0 | 0 | 0 | 0 |
| process M+Y, `OPM=1` | 0 | 0 | 0 | 0 |
| K-only đen, `OPM=1` | 43.681 | 98 | 43.681 | 32 |
| **SPOT `Separation`, `OPM=0`** | **0** | **0** | **43.681** | **13** |
| **SPOT `Separation`, `OPM=1`** | **0** | **0** | **43.681** | **13** |
| golden `overprint_black_on_cyan.pdf` | 173.889 | 84 | 173.889 | 35 |

Hai ca process cho 0 ở **cả hai** engine — đó là đúng, không phải lỗi: `DeviceCMYK` khai đủ bốn kênh nên overprint không đổi gì. Ca K-only và golden chứng minh toggle **có** hoạt động trong không gian mực. Chỉ ca mực pha lệch.

**Engine hiểu đúng, chỉ đường preview mất:** đo lại cùng file bằng `facade.separations()` (ink space thật, spot giữ kẽm riêng — script `tmp/audit_op_probe3.py`) cho thấy kẽm nền dưới ô mực pha **vẫn giữ nguyên 255**, tức PPE tôn trọng overprint của spot khi không flatten:

```text
op_spot0.pdf: plates=['Cyan','Magenta','Yellow','Black','PANTONE_877']
  Yellow        spot=False  trong_ô=255.00  ngoài_ô=253.06
  PANTONE_877   spot=True   trong_ô=255.00  ngoài_ô=  0.00
```

**Vì sao lưới test không bắt được** — cả ba tầng đều tránh đúng chỗ hỏng:

- `print_engine/tests/render_page.rs:163-187` (test mới) dùng `RenderOptions::ink_accurate()`, tức **không** đi qua `flatten_spots` — đúng cấu hình engine, sai cấu hình sản phẩm.
- `backend/tests/test_overprint_preview_ppe.py` mock `ppe_softproof` ở cả hai test, nên không render gì thật.
- `backend/tests/test_no_ghostscript_survival.py::test_overprint_preview_without_gs` chỉ assert `success` và `engine == "ppe"`, không assert có diff trên file overprint thật.

Đề nghị §4.1 của audit lần 1 — “thêm regression route trên `10_overprint.pdf`” — **chưa được thực hiện**; nó bị thay bằng test mock.

**Ảnh hưởng nghiệp vụ:** hộp/tem dùng Pantone + overprint là ca chính của tính năng này ở xưởng Việt Nam, không phải ca hiếm. Trả “không có vùng thay đổi” là câu trả lời sai trên một tính năng preflight.

**Hướng sửa (cần bạn chọn):**

- (a) **Đúng kiến trúc, đắt hơn:** dựng cặp ảnh preview trong ink space đầy đủ (`flatten_spots = false`), chỉ quy spot → CMYK ở bước cuối khi đổi sang sRGB. Overprint được tính trước khi mất danh tính kênh.
- (b) **Tối thiểu, cần đo lại:** trong `process_only`, đặt mask của spot bằng đúng các kênh có thành phần alternate khác 0 thay vì `PROCESS`. Rẻ nhưng đụng cả đường knockout, phải chạy lại toàn bộ golden trước khi tin.
- Kèm theo, bất kể chọn gì: một regression **không mock** trên fixture spot-overprint, và một fixture spot-overprint đưa vào `print_engine/golden/fixtures/` (bộ hiện có `spot_solid`/`spot_half_tint` đều không có overprint).

---

### §A.2 — [ĐÃ XÁC MINH] P2: neo đối chiếu toàn vẹn `EXE_SHA256` bị thay bằng placeholder, không có bước nào điền — effort S

> **ĐÃ ĐÓNG 2026-07-27** — `scripts/verify_installed_artifact.ps1` cài silent vào Temp, đo hash app exe đã cài, kiểm payload rồi điền `EXE_SHA256` + `INSTALL_VERIFIED_AT_UTC`; `build_production.ps1` in lệnh cần chạy tiếp. Script chưa được chạy trong phiên audit vì nó cài phần mềm lên máy. Nhật ký: `GS_SUNSET_FIXES_2026-07-27.md` §10.1.

**Bằng chứng:**

- `build_production.ps1:901` ghi cứng `"EXE_SHA256     = NOT_VERIFIED_INSTALL_PAYLOAD"`; hash thật của binary build được ghi riêng ở `BUILD_EXE_SHA256` (`:902`).
- Comment `:885` nói `EXE_SHA256` “chỉ được điền sau install-smoke”, nhưng **không có script install-smoke nào trong repo**: chuỗi `smoke` chỉ xuất hiện đúng trong comment đó (`Select-String scripts\*.ps1,*.py,*.ps1 -Pattern smoke` → chỉ `build_production.ps1`).
- Manifest đã phát hành `Ban_Phat_Hanh/release-manifest.txt` lại có giá trị thật `EXE_SHA256 = af351f4f…` ⇒ giá trị đó được điền **bằng tay**, không tái lập được bằng lệnh.

**Ảnh hưởng:** mục đích ban đầu của manifest (neo để so với dòng `[INTEGRITY][SELF] … sha256=` trong log máy khách khi nghi binary bị vá) mất hiệu lực ở mọi build sau này. Tuyên bố §6 của `GS_SUNSET_FIXES` (“script build tương lai … điền bằng chứng runtime”) hiện chưa có phần cài đặt.

**Đề xuất:** viết `scripts/verify_installed_artifact.ps1` (cài silent vào thư mục tạm → hash exe đã cài → cập nhật manifest + phụ lục) và gọi nó từ nhánh release, hoặc bỏ trường `EXE_SHA256` khỏi manifest build và chỉ sinh nó trong script smoke để manifest không chứa ô trống mang nghĩa “đã kiểm”.

---

### §A.3 — [ĐÃ XÁC MINH] P1 cho gate release, ngoài phạm vi PPE: cây hiện tại không qua typecheck và có 1 test dieline đỏ — effort S (thuộc việc đang làm dở)

**Bằng chứng:**

- `npm run typecheck` → `src/lib/dieline/HangingWindowBox.ts(441,1): error TS1005: '}' expected.` File **chưa track** (`?? desktop/src/lib/dieline/HangingWindowBox.ts`), dài 440 dòng và **kết thúc giữa thân hàm** — việc thêm loại hộp mới đang làm dở.
- `npm run test` → `Test Files 3 failed | 123 passed (126)`, `Tests 4 failed | 1088 passed | 2 skipped`.
  - Thật: `src/lib/dieline/nativeFixtureParity.test.ts` — `native/tests/fixtures/dieline_default_request.json` thiếu `WNW`, `WNH`, `HTH` vừa được thêm vào `DEFAULT_PARAMS`.
  - **Không** thật: `api.upload.test.ts` (2) và `api.mergeManifest.test.ts` (1) chỉ là *timeout 5000ms* do tôi chạy vitest song song với golden compare; chạy lại riêng hai file → **2 file / 3 test pass, 1,38 giây**. Rất có thể ba fail “API” trong báo cáo lần 1 cũng cùng nguyên nhân này, không phải bug.

**Ý nghĩa:** con số Release QA của §20.2 đúng ở thời điểm chạy, nhưng **không còn đúng với cây hiện tại**. Bài học §4.5 của lần 1 tái diễn: không suy ra “release QA xanh” từ trạng thái test lõi PPE. Muốn chốt lại gate thì phải hoàn thiện hoặc gỡ tạm `HangingWindowBox.ts` và đồng bộ fixture native trước khi chạy `run_release_qa.ps1`.

---

### §A.4 — [ĐÃ XÁC MINH] P2: bản “no-GS” vẫn tự dùng Ghostscript của hệ thống nếu máy khách có sẵn — effort S

> **ĐÃ ĐÓNG 2026-07-27** — `app/core/gs_availability.py` là nguồn sự thật: bản no-GS (marker payload hoặc `PRYNX_NO_GS_BUILD`) không dò GS hệ thống, `PRYNX_ALLOW_GS_FALLBACK` mặc định `False`, bỏ đường dẫn GS gõ cứng, và `run_hidden` trả thông điệp mức sản phẩm. 12 test mới. Nhật ký: §10.2.

**Bằng chứng:**

- `backend/app/config.py:10-30,78` — `GHOSTSCRIPT_PATH = _find_ghostscript()` tự dò `shutil.which()` và các thư mục cài phổ biến; không phụ thuộc payload bundle.
- `PRYNX_ALLOW_GS_FALLBACK: bool = True` (`config.py:81`) vẫn là mặc định trong artifact no-GS.
- `/preflight/convert-colors` vẫn có nhánh gọi GS thẳng khi object-level không xử lý được — `backend/app/api/routes/preflight.py:1370-1436`.

**Ảnh hưởng:** artifact không bundle GS (đúng về license), nhưng hành vi sản phẩm **khác nhau giữa hai máy khách** tuỳ có GS cài sẵn hay không, mà telemetry đo tỉ lệ đã bị loại khỏi gate. Đây chính là loại phương sai khiến sự cố ngoài hiện trường khó tái lập. Khi GS vắng, người dùng nhận thông điệp kỹ thuật `Ghostscript failed: …` thay vì lời giải thích ở mức sản phẩm.

**Đề xuất:** với build no-GS, đặt `PRYNX_ALLOW_GS_FALLBACK=False` (hoặc một cờ build ghi vào cấu hình đóng gói) để sản phẩm có **một** đường engine xác định; và đổi thông điệp lỗi của các nhánh fallback thành câu nói rõ việc gì không làm được và cần làm gì.

---

### §A.5 — [ĐÃ XÁC MINH] P3: ngân sách RAM tính theo từng lần render, không chia theo số việc chạy song song — effort S

> **ĐÃ ĐÓNG 2026-07-27** — ngân sách chia theo `max_active_heavy_jobs()`, giữ sàn từng tier; `ppe_capabilities` khai thêm `memory_budget_policy` để `memory_budget_default_mb: 512` không bị đọc thành chính sách sản phẩm. Nhật ký: §10.3.

**Bằng chứng:** `_memory_budget_mb()` được gọi trong **mỗi** lần `separations()`/`softproof()` (`backend/app/core/print_engine/facade.py:337,461`) và trả `available_ram_mb × 0,75` cho máy `>=16 GB` (`:145-151`). Không có trạng thái dùng chung giữa các job.

**Ảnh hưởng:** với N việc nặng chạy song song qua `heavy_job_scheduler`, mỗi việc tự cho mình 75% RAM còn trống ⇒ tổng cam kết vượt RAM thật. Trần này chỉ chặn cấp phát chứ không cấp trước nên không phải bug hôm nay, nhưng nó làm mất tác dụng bảo vệ đúng lúc cần nhất. Cũng lưu ý `ppe_capabilities()` vẫn khai `memory_budget_default_mb: 512` (`native/src/print_engine_py.rs:330`), nay không còn phản ánh chính sách thật.

**Đề xuất:** chia ngân sách cho số slot của scheduler, hoặc cấp ngân sách theo slot khi nhận việc thay vì tính lại trong facade.

---

### §A.6 — [ĐÃ XÁC MINH] P2: tài liệu vẫn là changelog chồng lớp; hai tuyên bố hiện không khớp code — effort S

> **ĐÃ ĐÓNG 2026-07-27** — tách `docs/PPE_CURRENT_STATE.md` làm SSOT; kế hoạch có cảnh báo ở đầu file và bảng số §16.4 đánh dấu `[SUPERSEDED]`; hai tuyên bố lệch đã sửa tại chỗ. Nhật ký: §10.3.

Finding §4.6 của lần 1 **chưa được đóng**, và nay thêm hai chỗ lệch cụ thể:

1. `GS_SUNSET_FIXES_2026-07-27.md` §6 nói script build “không còn gán nhầm hai hash: nó ghi `NOT_VERIFIED…` cho đến khi bước install-smoke điền bằng chứng runtime” — bước đó không tồn tại (§A.2).
2. `PLAN` §20.1 ghi “Overprint Preview có chế độ mô phỏng trong PPE Rust, đi xuyên binding/facade/route live; endpoint không còn phụ thuộc GS”. Câu này đúng về **đường đi** nhưng đọc như một chốt correctness, trong khi ca mực pha còn sai (§A.1).

Ngoài ra `section 15. Lịch sử` vẫn nằm sau `section 20`, các số golden/backend cũ ở §16.4 chưa đánh dấu superseded. Đề xuất giữ nguyên như lần 1: tách `CURRENT_STATE` (một bảng SSOT) khỏi `ROADMAP` và `CHANGELOG`, số test sinh từ artifact thay vì gõ tay.

---

## 3. Điểm đã kiểm và xác nhận tốt

1. **Overprint Preview rời GS thật.** Route dựng cặp ảnh bằng PPE, kiểm `ink_unsound`, kiểm chiều dài buffer `w*h*3` và kiểm hai ảnh cùng kích thước, sai thì trả `success=False` chứ không trả overlay rỗng (`preflight.py:1513-1600`). Không còn `-dSimulateOverprint` ở bất kỳ đâu trên đường live.
2. **Knockout không sửa file nguồn.** Cờ `simulate_overprint=false` chỉ vô hiệu hoá `/OP`,`/op`,`/OPM` tại `set_ext_gstate` (`interp.rs:1296-1317`) — đúng chỗ duy nhất PDF khai overprint, và áp cho cả content stream lồng vì nó nằm trên `self.opts`.
3. **Memory budget đúng bất biến dự án.** `<8 GB` → 256–384 MiB; `8–<16 GB` → 512–1024 MiB; `>=16 GB` → 75% RAM khả dụng, không trần nhân tạo; override env/config luôn thắng và `<=0` bị từ chối (`facade.py:126-169`). Test phủ ba tier, ca RAM cạn (32 GB nhưng còn 600 MiB → 512), ca không đọc được phần cứng và ca override (`test_ppe_memory_budget.py`).
4. **Đường flatten không còn bị cap ép hạ DPI.** Thang DPI chỉ xuống khi vượt ngân sách và bắt đầu từ DPI yêu cầu (`pdf_actions_native.py:1877-1881`).
5. **Survival test đã khoá engine.** `engine == "ppe"` + `accuracy` bắt đầu bằng `rip_separations` cho separations; `ppe+lcms` / `rip_softproof` cho soft-proof — lỗ `pdfium_approx` của §4.3 đã bịt.
6. **CI Windows chạy đúng bộ.** Job `ppe-native` cài wheel vừa build rồi chạy 10 file test gồm survival/routing/action/PDF-X/outline (`.github/workflows/ci.yml:153-180`); mọi file được liệt kê đều tồn tại. `numpy` không có trong `requirements.txt` nhưng vào theo phụ thuộc gián tiếp của opencv/scikit-image/scipy nên bước cài không gãy.
7. **OUT FONT fail-closed thật.** Không đọc được trạng thái nhúng font → dừng; thiếu font gốc → dừng; còn text sống hoặc annotation mang text → dừng; so kẽm sau embed **và** sau outline; output bị từ chối được **xoá** thay vì để lại trong thư mục kết quả (`action_engine.py:766-916`). `detect_unembedded_fonts` nay đi qua `iter_fonts` nên thấy font trong Form XObject/appearance stream và không còn fail-open (`outline_fonts.py:155-190`).
8. **Pipeline build hết ba bẫy Windows.** Không `maturin develop` vào venv live (build wheel → cài vào staging → đưa lên đầu `PYTHONPATH` cho Nuitka, có assert `overprint_preview_toggle`); `npm ci` chạy trong Temp rồi robocopy chỉ file thiếu; manifest tìm đúng `pdf-inspector.exe` (khớp `name = "pdf-inspector"` trong `src-tauri/Cargo.toml:2`) và fail-loud nếu thiếu — bản HEAD trước đó tìm `PrynX.exe` và chính file script bị cắt giữa dòng.
9. **Payload sạch GS.** `desktop/src-tauri/binaries/gs/` chỉ còn `NO_GHOSTSCRIPT.txt`.
10. **Golden không hồi quy.** 50 PASS + 1 khác GS có chủ ý trên 51 fixture ở 100 DPI sau toàn bộ thay đổi.

---

## 4. Lệnh verify đã chạy trong đợt này

```text
cargo test --quiet --manifest-path print_engine/Cargo.toml
→ 546 passed, 0 failed

cd backend && venv\Scripts\python.exe -m pytest -q
→ 1399 passed, 6 warnings, 194 s

python scripts/ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed
→ 51 file: 50 PASS, 0 FAIL, 1 khác GS có chủ ý

cd desktop && npm run typecheck
→ FAIL: HangingWindowBox.ts(441,1) TS1005  (file chưa track, đang làm dở)

cd desktop && npm run test
→ 123/126 file pass; 4 test fail (1 thật: nativeFixtureParity; 3 timeout do tôi chạy song song)

cd desktop && npx vitest run src/lib/api.upload.test.ts src/lib/api.mergeManifest.test.ts
→ 2 file / 3 test pass (xác nhận 3 fail trên là artifact tải máy)

backend/venv/Scripts/python.exe tmp/audit_op_probe2.py      # PPE vs GS, 6 ca overprint
backend/venv/Scripts/python.exe tmp/audit_op_probe3.py      # kẽm spot trong ink space thật
```

Không chạy lại full production build/installer và không chạy corpus khách 33 PDF (artifact không nằm trong repo), nên không kết luận gì về hai phần đó.

---

## 5. Thứ tự sửa đề xuất

Theo quy trình audit của dự án: **dừng ở đây chờ bạn duyệt**, chưa sửa gì.

### Lô A — đóng false-negative mực pha (≤4 file, cần rebuild native)

1. Chọn hướng (a) hoặc (b) ở §A.1; sửa `print_engine` tương ứng.
2. Thêm fixture spot-overprint vào `print_engine/golden/fixtures/` + baseline.
3. Regression **không mock** cho endpoint: assert `has_differences=true` trên fixture spot-overprint và trên `10_overprint.pdf`.
4. Chạy lại toàn bộ golden 72/100 DPI để chứng minh không hồi quy.

### Lô B — bằng chứng phát hành (2–3 file)

1. `scripts/verify_installed_artifact.ps1` điền `EXE_SHA256` sau install-smoke, hoặc bỏ trường đó khỏi manifest build.
2. Sửa hai câu tuyên bố lệch trong `GS_SUNSET_FIXES` §6 và `PLAN` §20.1.

### Lô C — hành vi no-GS xác định (2–3 file)

1. Build no-GS đặt `PRYNX_ALLOW_GS_FALLBACK=False`.
2. Viết lại thông điệp lỗi các nhánh fallback theo ngôn ngữ sản phẩm.

### Lô D — ngân sách theo slot + tài liệu SSOT (≤5 file)

1. Chia ngân sách RAM theo slot của `heavy_job_scheduler`; cập nhật `memory_budget_default_mb` trong `ppe_capabilities`.
2. Tách `CURRENT_STATE` / `ROADMAP` / `CHANGELOG` của `PLAN`.

### Ngoài phạm vi PPE, nhưng chặn gate

Hoàn thiện hoặc tạm gỡ `HangingWindowBox.ts` và bổ sung `WNW`/`WNH`/`HTH` vào `native/tests/fixtures/dieline_default_request.json` trước khi chạy lại `run_release_qa.ps1`.
