# GHOSTSCRIPT SUNSET — NHẬT KÝ KHẮC PHỤC VÀ CHỐT ARTIFACT

**Ngày:** 2026-07-27  
**Báo cáo audit gốc:** `docs/BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27.md`  
**Kế hoạch:** `docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md`  
**Phạm vi:** đóng các finding còn chặn bản build không bundle Ghostscript, xác minh OUT FONT, chạy Release QA và tạo installer no-GS.

## 1. Kết luận

Đã đạt **sunset Ghostscript ở mức kỹ thuật và đóng gói**:

- Mọi đường sản xuất được khóa bằng survival suite không-GS; Overprint Preview đã chuyển sang PPE.
- OUT FONT chạy fail-closed và hậu kiểm từng trang.
- Ngân sách PPE không còn hard-cap 512 MiB trên máy mạnh.
- Release QA đầy đủ đã xanh.
- Installer `1.0.0-beta.14` đã build thành công mà không bundle Ghostscript.
- Payload NSIS dưới `binaries\gs` chỉ có `NO_GHOSTSCRIPT.txt`; NOTICE không còn Ghostscript/Artifex/AGPL.

Đây **chưa phải GO phát hành công khai**. Installer/payload và sidecar đã qua smoke-test sau cài; trước khi phát hành cho khách vẫn còn ba chốt vận hành: kiểm PDF/X bằng Acrobat Preflight/validator độc lập, kiểm tay đầy đủ UI trên máy sạch và tạo artifact no-GS mới bằng quy trình updater hiện có. Bản hiện tại ghi `GIT_DIRTY=YES`; `CODE_SIGNED=no` chỉ mô tả Authenticode và không phải gate loại bỏ GS.

Telemetry “95% job/30 ngày” được chủ dự án loại khỏi tiêu chí chặn vì thiết bị hiện tại không tính được mẫu số. Không triển khai telemetry giả để làm đẹp gate.

## 2. Đóng finding của audit

| Finding | Xử lý | Trạng thái |
|---|---|---|
| P0 Overprint Preview dùng cờ GS đã chết | Thêm chế độ mô phỏng overprint vào PPE Rust, binding PyO3, facade và route; route live không còn gọi GS | Đã đóng |
| Telemetry không tính được 95%/30 ngày | Loại khỏi gate theo quyết định sản phẩm; không dùng làm bằng chứng sunset | Không còn là blocker |
| Survival test có thể xanh bằng `pdfium_approx` | Siết engine/accuracy; CI Windows chạy survival/action/PDF-X/outline với native wheel vừa build | Đã đóng |
| PPE hard-cap 512 MiB mọi máy | Chọn budget theo RAM khả dụng: máy `<8 GB` giảm mạnh, `8–<16 GB` giảm nhẹ, `>=16 GB` không áp trần nhân tạo; env override vẫn thắng | Đã đóng |
| Release QA đỏ / installer còn GS | Sửa blocker AutoBottom, chạy Release QA sạch, build `-NoGhostscript`, tái sinh NOTICE và kiểm payload NSIS | Đã đóng ở mức artifact |
| Kế hoạch/changelog không phản ánh current state | Cập nhật gate Phase 3 và thêm mục chốt sunset trong tài liệu kế hoạch | Đã đóng cho đợt này |

## 3. OUT FONT

Audit bổ sung và toàn bộ sửa chữa nằm tại:

- `docs/BAO_CAO_BO_SUNG_AUDIT_OUT_FONT_2026-07-27.md`
- `docs/OUT_FONT_FIXES_2026-07-27.md`

Điểm chốt: action chỉ giao output khi không còn text sống và hậu kiểm từng trang đạt. Thiếu font gốc, stream bất thường, glyph không ánh xạ được hoặc hình in thay đổi đều dừng an toàn. UI không còn hứa “an toàn 100%”.

## 4. Blocker ngoài PPE được xử lý trước Release QA

Ba lỗi frontend còn lại đều thuộc `auto_bottom`, không thuộc OUT FONT/PPE nhưng vẫn chặn release gate. Đã:

- soi SVG/raster của hình học hiện hành;
- xác nhận hai snapshot thay đổi có chủ đích rồi cập nhật golden;
- sửa test 3D để phân biệt mặt kết cấu phải hướng ra ngoài với `bottom_tab_*` là tai dán gập vào 180°;
- thêm bất biến riêng cho pháp tuyến tai dán ở trạng thái gập đủ.

Kết quả frontend sau sửa: **126 file test đạt; 1.083 test đạt, 2 bỏ qua; typecheck đạt**.

## 5. Release QA

`scripts/run_release_qa.ps1` được sửa để cài frontend sạch trong thư mục staging riêng. Cách này tránh ghi đè DLL native đang bị vòng dev của người dùng giữ khóa, nhưng vẫn kiểm đúng lockfile và đúng source hiện tại.

Kết quả lần chạy đầy đủ:

- `pip check`: đạt.
- Golden preflight: **46 đạt**.
- E2E free-token: **1 đạt**.
- Backend: **1.399 đạt**, không lỗi.
- Frontend từ `npm ci` sạch: **126 file; 1.083 đạt, 2 bỏ qua**.
- `imposition_core`: **36 đạt** và release compile đạt.
- `native`: **10 đạt** và release compile đạt.
- Tauri Rust: **40 đạt** và release compile đạt.
- Kết thúc: `[QA] All release regression suites passed.`

Bản production sau đó dùng `-SkipPreflightQA` chỉ để không chạy lại đúng bộ QA vừa xanh; không có gate chưa kiểm nào bị bỏ qua.

## 6. Build production no-GS

Lệnh build:

```powershell
.\build_production.ps1 -NoGhostscript -NoOpenExplorer -SkipPreflightQA
```

Pipeline được harden thêm:

- frontend dependency bị khóa được phục hồi qua staging, không tắt tiến trình dev của người dùng;
- native wheel được build/cài vào staging và đưa lên đầu `PYTHONPATH` cho Nuitka, không ghi đè extension đang được Python live giữ khóa;
- build no-GS xóa payload GS cũ, giữ marker bắt buộc cho glob resource của Tauri;
- Supabase empty array không còn bị Windows PowerShell hiểu nhầm thành một bản ghi rỗng;
- manifest tìm đúng `pdf-inspector.exe` và fail-loud nếu binary không tồn tại.

Artifact:

| Trường | Giá trị |
|---|---|
| Installer | `Ban_Phat_Hanh/PrynX_1.0.0-beta.14_x64-setup.exe` |
| Kích thước | `255005482` byte |
| SHA-256 installer | `7dac9effeec032eceb467194d9d4a509db02fbf1e18e070707eacde787e3a6f0` |
| SHA-256 app exe đã cài | `af351f4f94cf23529e0ef087baaab8e87bb3d63aa155945b2b473a7a7756b6e1` |
| SHA-256 app exe tại build target | `7e4ddf8ee12ff6566536b30d7a2ab19b650f285d428b052913d84a1e6d780a04` |
| SHA-256 sidecar | `cf355ec316847cd2440dab826cc5b2e689e8067ed3e7c89d86f382afba43c5bc` |
| Dieline resource | `DIELINE_LOCKED=yes` |
| Reproducibility | `GIT_DIRTY=YES` |
| Authenticode | `CODE_SIGNED=no` |

## 7. Bằng chứng payload không có Ghostscript

1. `desktop/src-tauri/binaries/gs/` chỉ có `NO_GHOSTSCRIPT.txt`.
2. `THIRD_PARTY_NOTICES.md` và bản được bundle không có chuỗi `Ghostscript`, `Artifex` hoặc `AGPL`.
3. Script NSIS sinh ra tại `desktop/src-tauri/target/release/nsis/x64/installer.nsi` chỉ có một lệnh `File` dưới `binaries\gs`:

```text
File /a "/oname=binaries\gs\NO_GHOSTSCRIPT.txt" "...\binaries\gs\NO_GHOSTSCRIPT.txt"
```

4. Không có `gswin*.exe`, GS DLL hay resource Ghostscript nào trong danh sách payload NSIS.
5. SHA-256 installer tính lại độc lập khớp manifest.

### 7.1 Smoke-test sau cài

Installer được cài silent vào `C:\tmp\PrynXSmoke_beta14` và trả mã `0`. Cây đã
cài chỉ có `binaries\gs\NO_GHOSTSCRIPT.txt`; NOTICE tiếp tục không có GS. Sidecar
đã khởi động trên cổng test riêng, trả `status=ok`, `app=PrynX Core` và HMAC
startup proof hợp lệ khi nhận token qua stdin đúng như Tauri production.

Smoke-test này còn lộ một lỗi bằng chứng: Tauri vá metadata theo loại bundle nên
app exe đã cài có hash khác `target\release\pdf-inspector.exe`. Manifest hiện tại
đã ghi đúng cả `EXE_SHA256` của payload đã cài và `BUILD_EXE_SHA256`. Script build
không còn gán nhầm hai hash: nó ghi `EXE_SHA256=NOT_VERIFIED_INSTALL_PAYLOAD` cho
đến khi bước install-smoke điền bằng chứng runtime.

> **Cập nhật (audit lần 2, §A.2):** ở thời điểm viết mục này, giá trị `EXE_SHA256`
> của artifact `beta.14` được điền **bằng tay** — không có script nào làm việc đó,
> nên mọi build sau sẽ mất neo đối chiếu. Đã đóng bằng
> `scripts/verify_installed_artifact.ps1`; xem §10.

## 8. Các chốt còn lại trước phát hành công khai

1. Chạy Acrobat Pro Preflight hoặc validator độc lập trên bộ output PDF/X-4 và PDF/X-1a đại diện; lưu report cùng artifact.
2. Trên máy test sạch không chạy vòng dev, kiểm tay đầy đủ UI cho separations, soft-proof, TAC, Overprint Preview, OUT FONT, flatten và PDF/X. Installer/payload và sidecar health đã đạt; phần còn lại là checklist tương tác người dùng.
3. Gom/duyệt thay đổi rồi build bản no-GS mới bằng `release_update.ps1`; Tauri tự sinh `.sig` theo từng phiên bản từ khóa updater hiện có. Chạy hậu kiểm artifact đã cài để neo `EXE_SHA256` và xác nhận payload không có GS.

Ba chốt này không phủ định việc Ghostscript đã được rút khỏi artifact kỹ thuật; chúng quyết định artifact nào đủ điều kiện đưa cho khách.

---

## 9. Lô A của audit lần 2 — false-negative overprint trên mực pha

**Báo cáo:** `docs/BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27_LAN2.md` §A.1
**Hướng đã chọn:** (a) dựng cặp ảnh preview trong ink space đầy đủ, chỉ gộp mực pha về CMYK ở bước xuất ảnh.

### 9.1 Lỗi

Bản sửa Overprint Preview ở §20 dựng cặp ảnh bằng `ppe_softproof`, mà `RenderOptions::softproof()` bật `flatten_spots` → `InkSpace::process_only()`. Trong không gian đó, colorant `Separation`/`DeviceN` được quy qua tint transform **ngay lúc dựng mực** và nhận `ChannelMask::PROCESS`. Paint mất danh tính kênh, nên participation set thành cả bốn kênh process và **overprint trở nên giống knockout từng pixel**.

Hệ quả: file overprint bằng Pantone — ca chính của bao bì — bị endpoint trả `has_differences=false`. Đúng lớp false-negative mà tính năng này sinh ra để chặn, chỉ đổi từ mực process sang mực pha.

Ba tầng test đều tránh đúng chỗ hỏng: test Rust mới dùng `ink_accurate` (không qua flatten), hai test Python mock hẳn `ppe_softproof`, survival test chỉ assert `success` + `engine`.

### 9.2 Sửa

| File | Thay đổi |
|---|---|
| `print_engine/src/ink.rs` | Thêm `SpotAlternate` (bảng tra tint → CMYK, 33 mẫu + nội suy tuyến tính) và `InkSpace::preview()` với cờ `fold_spots_at_output`. `to_srgb` gộp từng kênh spot vào CMYK **sau** khi trộn xong. `adopt_channels_from` truyền bảng tra từ group con lên cha. |
| `print_engine/src/color/space.rs` | `sample_spot_alternate()` lấy mẫu tint transform qua alternate space bằng **cảnh báo nháp** — không để phép quy đổi nội bộ của đường xem hạ độ tin cậy của đường đo. Nhánh `Separation` và `DeviceN` lấy mẫu khi ink space yêu cầu. |
| `print_engine/src/page.rs` | `flatten_spots` chọn `InkSpace::preview()` thay vì `process_only()`. |
| `print_engine/src/content/interp.rs` | Tài liệu lại `flatten_spots`: việc gộp xảy ra ở bước xuất ảnh, không phải lúc dựng mực. |
| `print_engine/tests/render_page.rs` | `preview_space_keeps_spot_channel_so_overprint_is_visible` (kẽm spot còn riêng khi trộn, Yellow nền giữ 255 khi overprint và về 0 khi knockout, bảng tra lấy mẫu đúng ở tint 100% và 50%); `measurement_space_does_not_sample_spot_alternates`. |
| `backend/tests/test_overprint_preview_ppe.py` | `test_spot_overprint_is_detected_by_real_ppe_render` — **không mock**, dựng file spot-overprint bằng pikepdf, gọi endpoint thật, chặn cả `has_differences` lẫn diện tích vùng khác biệt. |

Quyết định thiết kế đáng ghi:

- **Bảng tra chứ không một giá trị ở tint 100%.** Tint transform không tuyến tính (`FunctionType 2` với `N != 1`, hoặc sampled), nhân giá trị ở 100% với 0,5 cho ra màu khác màu thật của Pantone 50%.
- **Cảnh báo nháp khi lấy mẫu.** Đi qua alternate space sẽ ghi note colorspace và có thể bật cờ hạ tin cậy; những cờ đó nói về nội dung trang, không phải về một bảng tra nội bộ. Ghi thật sẽ làm đường ĐO bị hạ tin cậy oan.
- **Kênh spot không có bảng tra** hiện ra như mực đen theo đúng lượng phủ. Sai sắc nhưng thấy được; bỏ hẳn kênh sẽ làm một vùng có mực hiện ra giấy trắng.
- **Lấy mẫu chỉ bật ở đường xem** (`wants_spot_alternates`), nên đường tách kẽm/TAC không trả thêm chi phí nào.

### 9.3 Bằng chứng

Cùng một script đo, trước và sau bản sửa (150 DPI, GS 10.04.0 tham chiếu với `-sOverprint=disable|simulate`):

| ca đo | PPE trước | PPE sau | GS |
|---|---|---|---|
| process M+Y, `OPM=0` | 0 | 0 | 0 |
| process M+Y, `OPM=1` | 0 | 0 | 0 |
| K-only đen, `OPM=1` | 43.681 | 43.681 | 43.681 |
| **SPOT `Separation`, `OPM=0`** | **0** | **43.678** | 43.681 |
| **SPOT `Separation`, `OPM=1`** | **0** | **43.678** | 43.681 |
| golden `overprint_black_on_cyan` | 173.889 | 173.889 | 173.889 |

Lệch 3 pixel so với GS là viền ô do khác scan-convert; biên độ `max Δ` khác GS (27 so với 13) vì PPE gộp mực pha theo lượng ở bước xuất ảnh còn GS composite lúc vẽ. Điều quyết định — có hay không có vùng thay đổi, và vùng đó ở đâu — nay khớp.

Verify:

```text
cargo test --quiet --manifest-path print_engine/Cargo.toml   → 548 pass, 0 fail (+2 test mới)
cd backend && venv\Scripts\python.exe -m pytest -q           → 1400 pass, 0 fail (+1 test mới)
ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed → 50 PASS, 0 FAIL, 1 khác GS có chủ ý
ppe_golden_compare.py print_engine/golden/fixtures --dpi 72  --color-managed → 50 PASS, 0 FAIL, 1 khác GS có chủ ý
```

Đường đo không đổi một pixel nào ở cả hai DPI — đúng như thiết kế, vì `InkSpace::new()` không bật cờ nào của bản sửa này.

### 9.4 Còn lại của lô này

Thêm một fixture spot-overprint vào `print_engine/golden/fixtures/` (bộ hiện có `spot_solid`/`spot_half_tint` đều không có overprint) để phép so với GS phủ luôn ca này ở mức golden, không chỉ ở mức test.

---

## 10. Lô B, C, D của audit lần 2

### 10.1 Lô B — neo đối chiếu toàn vẹn (§A.2)

| File | Thay đổi |
|---|---|
| `scripts/verify_installed_artifact.ps1` | **Mới.** Cài silent artifact vào một thư mục trong Temp, đo hash app exe **đã cài**, kiểm payload (không `gswin*.exe`/`gsdll*.dll`, NOTICE không nhắc Ghostscript/Artifex/AGPL, có marker no-GS), rồi điền `EXE_SHA256` + `INSTALL_VERIFIED_AT_UTC` vào manifest. Gỡ cài và dọn thư mục tạm ở mọi đường ra. |
| `build_production.ps1` | In lệnh cần chạy tiếp ngay sau khi ghi manifest, tự thêm `-ExpectNoGhostscript` khi build no-GS. Sửa comment: neo do script điền, không phải “bước install-smoke” không tồn tại. |
| `GS_SUNSET_FIXES` §6 | Ghi rõ giá trị `EXE_SHA256` của `beta.14` từng được điền **bằng tay**. |

Hai quyết định đáng ghi:

- **Manifest không được cập nhật khi payload trượt kiểm.** Một manifest mang giá trị “đã xác minh” nhưng nội dung sai còn tệ hơn một manifest để trống, vì nó làm người đọc tin sai.
- **Đối chiếu `INSTALLER_SHA256` trước khi cài.** Nếu hash installer không khớp manifest thì manifest không thuộc artifact đang kiểm — dừng ngay, tránh dán bằng chứng của bản này lên bản khác.

Script **chưa được chạy trong phiên này**: nó cài phần mềm lên máy, nên phải do chủ dự án chạy khi thực sự phát hành.

### 10.2 Lô C — hành vi no-GS xác định (§A.4)

| File | Thay đổi |
|---|---|
| `backend/app/core/gs_availability.py` | **Mới.** Một nguồn sự thật: `is_no_gs_build()` (marker payload hoặc `PRYNX_NO_GS_BUILD`), `bundled_ghostscript()`, `GhostscriptUnavailable`, `unavailable_message()`. Cố ý không import gì từ `app` để `app.config` gọi được lúc dựng `Settings` mà không tạo vòng import. |
| `backend/app/config.py` | `_find_ghostscript()`: bản no-GS **dừng dò**, không mượn Ghostscript của máy khách; **bỏ đường dẫn gõ cứng** ở cuối. `PRYNX_ALLOW_GS_FALLBACK` mặc định `False` trên bản no-GS. |
| `backend/app/utils/subprocess_utils.py` | `_guard_ghostscript()` chặn tại hook duy nhất mọi lệnh GS đi qua, trả thông điệp ở mức sản phẩm. Bộ đếm telemetry chỉ ghi **sau** guard. |
| `.env.example` | Tài liệu hoá `PRYNX_NO_GS_BUILD`, `GHOSTSCRIPT_PATH`, `PRYNX_PRINT_ENGINE`, `PRYNX_PPE_MEMORY_BUDGET_MB`. |
| `backend/tests/test_gs_availability.py` | **Mới**, 12 test: marker, env override, không dò GS hệ thống, override của người vận hành vẫn thắng, không còn đường dẫn gõ cứng, thông điệp khác nhau giữa bản no-GS và máy thiếu GS, công cụ ngoài khác không bị gán nhãn Ghostscript. |

Ba cái bẫy đã đóng trong lúc làm:

1. **Đường dẫn gõ cứng.** `_find_ghostscript()` cũ kết thúc bằng `C:\Program Files\gs\gs10.04.0\bin\gswin64c.exe`, nên `GHOSTSCRIPT_PATH` **không bao giờ rỗng** và mọi chỗ kiểm `if gs_path:` luôn đúng. Lỗi chỉ lộ ở tận `FileNotFoundError`, và người dùng nhận `Ghostscript failed: ...`.
2. **Nhận diện lệnh GS theo tên là không đủ.** `is_ghostscript_command()` xét stem tiến trình, nên đường dẫn rỗng (bản no-GS) hoặc trỏ sai tên (đúng cách `test_no_ghostscript_survival` mô phỏng) đều **không** được nhận là GS. Guard vì thế xét thêm “có đúng bằng `GHOSTSCRIPT_PATH` đang cấu hình hay không”.
3. **Tên trần phân giải qua PATH.** `os.path.isfile("gswin64c.exe")` trả `False` dù GS có trên PATH. Bản guard đầu tiên vì vậy chặn oan — hai test telemetry đỏ đã bắt được ngay. Nay guard tra `shutil.which()` cho tên không chứa dấu phân cách, và có test riêng khoá hành vi này.

### 10.3 Lô D — ngân sách theo slot và SSOT tài liệu (§A.5, §A.6)

| File | Thay đổi |
|---|---|
| `backend/app/core/heavy_job_scheduler.py` | Công khai `max_active_heavy_jobs()`. |
| `backend/app/core/print_engine/facade.py` | `_auto_memory_budget_mb(..., concurrency)` chia ngân sách theo số slot, **giữ sàn của từng tier** để máy nhiều slot không tụt xuống mức không render nổi trang nào. |
| `native/src/print_engine_py.rs` | Thêm `memory_budget_policy` vào `ppe_capabilities` — `memory_budget_default_mb: 512` là mặc định của *binding*, không phải chính sách sản phẩm; đọc nhầm hai thứ này là cách sinh ra khẳng định sai trong tài liệu. |
| `backend/tests/test_ppe_memory_budget.py` | Thêm 4 test: chia theo slot, giữ sàn tier, `concurrency=1` khớp chính sách trước đó. |
| `backend/tests/test_ppe_native.py` | Assert khoá chính sách mới. |
| `docs/PPE_CURRENT_STATE.md` | **Mới** — SSOT: kết luận phát hành, số đo hiện hành kèm lệnh tái lập, sáu gate, hành vi engine đã chốt, ba chốt còn lại, việc đã biết chưa làm. |
| `docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md` | Cảnh báo ở đầu file: đây là kế hoạch + changelog, hiện trạng đọc ở `PPE_CURRENT_STATE.md`. Bảng số §16.4 đánh dấu `[SUPERSEDED]`. |
| `.github/workflows/ci.yml` | Job Windows chạy thêm `test_gs_availability.py` và `test_gs_usage_telemetry.py`. |

### 10.4 Verify sau cả bốn lô

```text
cargo test --quiet --manifest-path print_engine/Cargo.toml   → 548 pass, 0 fail
cd backend && venv\Scripts\python.exe -m pytest -q           → 1414 pass, 0 fail
ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed
    → 53 file: 52 PASS, 0 FAIL, 1 khác GS có chủ ý
    → overprint_spot_on_yellow.pdf  TAC 200,0 vs GS 200,0, MAE 0,00, 5/5 kẽm
    → knockout_spot_on_yellow.pdf   TAC 100,0 vs GS 100,0, MAE 0,00, 5/5 kẽm
```

Cặp fixture spot-overprint nay khớp Ghostscript **tuyệt đối** (lệch 0,0 điểm TAC, MAE 0,00) ở mức golden — không chỉ ở mức test đơn vị.

---

## 11. §19.7 — `OUTLINE_FONTS` lấy hình học chữ từ PPE

Món nợ cuối của kế hoạch: bản Python viết lại bằng fontTools đúng những thứ PPE đã
có và đã đo (đọc glyph mọi loại font nhúng, encoding/CID, ma trận chữ), và vấp đúng
ở đó — 6 file corpus tra glyph thất bại, 2 file font ngoài phạm vi, Type3 chưa đụng.

### 11.1 Đã làm

| Lớp | File | Thay đổi |
|---|---|---|
| Rust | `print_engine/src/text/outlines.rs` (mới) | `StreamKey`, `GlyphOutline`, `TextOutlineReport`, `encode_path()` — bậc hai nâng lên bậc ba đúng công thức vì PDF không có operator bậc hai. |
| Rust | `print_engine/src/content/interp.rs` | `RenderOptions::collect_text_outlines` + `collecting_text_outlines()`; `collect_glyph_outline()`; ngăn xếp `(stream, số khối BT)`; đánh dấu stream khi vào/ra Form XObject. |
| Rust | `print_engine/src/page.rs` | `PageRender.text_outlines`. |
| Binding | `native/src/print_engine_py.rs`, `lib.rs` | `ppe_text_outlines(pdf_path, page, fallback_font)`; capability `text_outlines`. |
| Python | `backend/app/core/ppe_outlines.py` (mới) | `PpeGlyphSource` — tra theo ba mốc đồng bộ, đổi `(verbs, coords)` thành instruction pikepdf. |
| Python | `backend/app/core/outline_text.py` | `outline_content_stream(..., glyph_source, stream_key)`; đếm khối `BT` và mã ký tự; chốt kiểm vị trí bút; nạp nguồn theo từng trang. |
| Test | `print_engine/tests/text_outlines.rs` (9), `backend/tests/test_outline_text_ppe_source.py` (8) | xem §11.3. |

### 11.2 Hai quyết định khác thiết kế gốc

**Nguồn PPE cộng thêm, không thay thế.** Thiết kế §19.7 định thay hẳn đường fontTools.
Làm vậy thì phải đo lại toàn corpus trước khi dám bật, và mọi ca PPE chưa phủ sẽ
thành hồi quy. Cách đã làm: glyph nào PPE có thì dùng PPE, không có thì đi đường cũ,
không có thì mới từ chối. Bật nguồn này **không thể** làm mất chữ so với bản trước.

**Chốt kiểm vị trí bút — rủi ro thật không phải "path sai".** Hai bên đi qua cùng
content stream bằng hai bộ code khác nhau, nên kiểu hỏng duy nhất nguồn PPE có thể
tạo ra là **lệch chỉ số**: path của glyph này bị gán cho glyph khác. File vẫn mở
được, vẫn có chữ, chỉ sai chỗ — chỉ phát hiện khi đã in. Vì vậy:

1. Hợp đồng đồng bộ ba mốc: `stream` → `text_object_index` → `glyph_index`, và
   `glyph_index` đếm **mọi mã ký tự** kể cả dấu cách và `Tr 3`. Chỉ đếm glyph vẽ được
   sẽ làm hai bên lệch ngay ở dấu cách đầu tiên.
2. Mỗi path được so với vị trí bút `(trm.e, trm.f)`; lệch quá 2× cỡ chữ theo x hoặc
   3× theo y thì từ chối và lùi về fontTools.
3. Chốt so-kẽm từng trang giữ nguyên như trước, vẫn là lưới chặn cuối.

Những thứ PPE **không** chuyển được đều được khai ra thay vì bỏ im lặng: `has_type3`
(glyph Type3 là content stream, không phải đường viền), `has_unsupported_context`
(chữ trong soft mask / tiling pattern / form không địa chỉ hoá được, và **chữ trong
lớp optional content đang tắt** — Python không theo dõi OC nên chỉ số sẽ lệch),
`missing_glyphs`.

### 11.3 Bằng chứng

Chín test Rust khoá đúng những chỗ dễ sai:

- `path_is_in_stream_user_space_not_device_space` — trang phóng 3× bằng `cm` cho hộp
  bao **giống hệt** trang không `cm`. Đây là bug §3.8 (nhân CTM hai lần), và nó chỉ
  lộ trên trang **có** `cm`.
- `text_inside_form_xobject_is_tagged_with_that_form`, `form_counter_does_not_leak_into_the_page_counter`.
- `invisible_text_mode_is_not_counted_as_lost_text` — `Tr 3` là chữ vô hình có chủ
  đích (lớp OCR); gộp nó với "chữ bị mất" sẽ chặn oan mọi PDF đã OCR.
- `missing_embedded_font_is_reported_so_caller_can_refuse`.

Tám test Python, gồm end-to-end và chốt chống lệch:

- `test_outline_uses_ppe_geometry_and_passes_ink_verify` — outline bằng hình học PPE
  rồi so kẽm với bản gốc: đạt.
- `test_misaligned_source_is_rejected_instead_of_placing_wrong_glyph` — ép nguồn dịch
  path 500pt; bộ ghi từ chối và bản in vẫn khớp bản gốc.
- `test_failure_of_ppe_source_never_breaks_the_action` — nguồn gãy thì tác vụ vẫn chạy.

Đo trên trang **có** `cm` (`1.5 0 0 1.5 10 10 cm`), chữ 24pt, chuỗi `"Hop giay ABC"`:

```text
outline: 10 glyph dùng hình học PPE, 0 lùi về fontTools (stream page)
supported=True  glyphs=12  warnings=[]  verify=True
```

12 = 10 glyph thật + 2 dấu cách. Không glyph nào phải lùi về fontTools, và chốt
so-kẽm đạt.

```text
cargo test --manifest-path print_engine/Cargo.toml   → 560 pass, 0 fail (+12)
cd backend && venv\Scripts\python.exe -m pytest -q   → 1422 pass, 0 fail (+8)
```

### 11.4 Còn lại

Chưa đo lại corpus 33 PDF khách vì corpus không nằm trong repo — con số "22/33 file"
của bản fontTools vì thế **chưa** được cập nhật. Việc cần làm khi có corpus: chạy lại
và đếm lại số file xong bằng pikepdf, cùng số glyph dùng PPE so với số lùi về
fontTools (log đã in sẵn hai con số này cho từng stream).

---

## 12. Đóng audit sẵn sàng lần 4 — 2026-07-28

### 12.1 Lô A — chặn false-negative OUT FONT

`outline_text.py` bổ sung kiểm thành phần mực thừa rời khỏi vùng mực gốc đã nở 1 px.
Thành phần liên thông từ 6 px bị từ chối; thay đổi độ dày hợp lệ và dịch 1 px vẫn
được phép. Test PDF một chấm thành hai chấm chứng minh lỗi chữ nhỏ không còn lọt.

Verify: **24 pass, 16 skip** cho các suite outline liên quan.

### 12.2 Lô B/C — hành vi no-GS và nội dung sản phẩm

- `InternalEngineUnsupported` là contract fail-closed dùng chung cho action và
  PDF/X. Khi fallback bị tắt, hệ thống dừng trước subprocess, xoá output dở và
  không ghi một lần gọi GS giả.
- API PDF/X trả 422 có hướng xử lý; Embed Font không còn hứa tự sửa font thiếu;
  Output Preview và Flatten không còn yêu cầu người dùng cài Ghostscript.
- Tham số `use_gs` chỉ giữ nội bộ để tương thích API cũ; UI gọi đây là chế độ PPE.

Verify: **39 backend pass**, TypeScript typecheck đạt, **1140 frontend pass,
2 skip**.

### 12.3 Lô D — release gate thật

`scripts/gs_dependency_audit.py` nay:

- tự cấu hình stdout/stderr UTF-8 trên Windows;
- phân loại engine nội bộ từ chối là `REFUSED`;
- `--gate` trả mã 1 nếu còn `GS` hoặc `ERROR`;
- ghi artifact sau mỗi PDF để có thể tiếp tục khi đợt đo dài bị ngắt.

`scripts/run_release_qa.ps1` chạy gate 18 PDF × 16 thao tác, typecheck trong
frontend staging sạch, và cả test/release-check của `print_engine`.

Kết quả đo ngày 2026-07-28: **276 OK, 12 REFUSED, 0 GS, 0 ERROR**.
`OUTLINE_FONTS`: **13.985 glyph PPE, 0 fontTools fallback**.

Verify tổng: `print_engine` **565 pass** + release check đạt; backend **1467 pass,
1 skip**; policy release **24 pass**.

### 12.4 Lô F — giữ đúng quy trình phát hành hiện có

- `build_production.ps1 -Release` tiếp tục dùng `tauri.release.conf.json` với
  `createUpdaterArtifacts=true`; Tauri sinh file `.sig` cho từng phiên bản từ
  `TAURI_SIGNING_PRIVATE_KEY` hiện có.
- `release_update.ps1` tiếp tục tự đồng bộ version trong cấu hình npm/Tauri/Cargo
  trước khi build, đúng với quy trình phát hành của dự án.
- Authenticode là cơ chế ký `.exe` riêng của Windows, chưa thuộc thiết kế phát
  hành hiện tại và không phải tiêu chí loại bỏ GS. Chốt chứng thư Authenticode
  được thêm trong lúc audit đã được gỡ bỏ.
- Các gate liên quan trực tiếp đến GS vẫn giữ nguyên: Release không được bundle
  GS, bộ đo 18×16 phải có `0 GS / 0 ERROR`, và artifact đã cài phải qua
  `verify_installed_artifact.ps1 -ExpectNoGhostscript`.

PowerShell parse đạt; policy test khóa lại đúng sự phân tách giữa `.sig` updater
và Authenticode. Wrapper `scripts/run_release_qa.ps1` đã chạy end-to-end và
**ĐẠT** ngày 2026-07-28: preflight golden, entitlement, backend 1467 pass/1 skip,
no-GS 18×16, frontend staging sạch, `imposition_core`, `print_engine`, native và
Tauri.